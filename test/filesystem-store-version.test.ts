/**
 * Tests for the filesystem backend's storage layout version (`store.json`) and
 * the startup migration runner.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import pino from 'pino'
import { chunkDirName } from '@interop/space-archive'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  STORE_FILE_NAME,
  STORE_MIGRATIONS,
  applyStoreMigrations,
  fileExists,
  type StoreMigration
} from '../src/backends/filesystemStore.js'
import { TEMP_FILE_ORPHAN_AGE_MS } from '../src/lib/atomicFile.js'
import { ORIGIN_ID_PATTERN } from '../src/lib/originId.js'
import {
  StoreLockTimeoutError,
  StoreOriginIdError,
  StoreVersionError
} from '../src/errors.js'

const logger = pino({ level: 'silent' })

/**
 * A migration that does nothing.
 */
const noop: StoreMigration = { kind: 'convert', run: async () => {} }

/**
 * A migration that counts how often it runs.
 */
function countingMigration(): {
  migration: StoreMigration
  runs: () => number
} {
  let ran = 0
  return {
    migration: {
      kind: 'convert',
      run: async () => {
        ran++
      }
    },
    runs: () => ran
  }
}

/**
 * Writes a lock file held by a process on another host, with a fresh mtime.
 */
async function writeOtherHostLock(dataDir: string): Promise<string> {
  const lockPath = path.join(dataDir, 'store.lock.other-host')
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, hostname: 'another-machine' })
  )
  return lockPath
}

/**
 * The whole record `store.json` in `dataDir` holds.
 */
async function storedRecord(
  dataDir: string
): Promise<{ version: number; originId?: string; clockHighWater?: number }> {
  const text = await readFile(path.join(dataDir, STORE_FILE_NAME), 'utf8')
  return JSON.parse(text)
}

/**
 * The version `store.json` in `dataDir` records.
 */
async function storedVersion(dataDir: string): Promise<number> {
  return (await storedRecord(dataDir)).version
}

/**
 * Writes a `store.json` recording `version`, and `originId` when given, into
 * `dataDir`.
 */
async function stamp(
  dataDir: string,
  version: number,
  originId?: string
): Promise<void> {
  await writeFile(
    path.join(dataDir, STORE_FILE_NAME),
    JSON.stringify({ version, originId })
  )
}

describe('Filesystem store version', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-store-version-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('stamps an empty data dir with the current version on backend open', async () => {
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
    // The lock is released.
    assert.deepEqual(await readdir(dataDir), [STORE_FILE_NAME])
  })

  it('stamps a data dir that does not exist yet', async () => {
    const nested = path.join(dataDir, 'not-yet')
    const { version } = await applyStoreMigrations({ dataDir: nested, logger })
    assert.equal(version, STORE_MIGRATIONS.length)
    assert.equal(await storedVersion(nested), STORE_MIGRATIONS.length)
  })

  it('treats a volume root holding only lost+found as empty', async () => {
    await mkdir(path.join(dataDir, 'lost+found'))
    const counting = countingMigration()
    const { version } = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, counting.migration]
    })
    assert.equal(version, 2)
    assert.equal(counting.runs(), 0, 'a fresh dir needs no migration')
    assert.equal(await storedVersion(dataDir), 2)
  })

  it('applies a pending step once and stamps after it', async () => {
    await stamp(dataDir, 1)
    await mkdir(path.join(dataDir, 'spaces'))
    const counting = countingMigration()
    const migrations = [noop, counting.migration]
    assert.equal(
      (await applyStoreMigrations({ dataDir, logger, migrations })).version,
      2
    )
    assert.equal(await storedVersion(dataDir), 2)
    assert.equal(
      (await applyStoreMigrations({ dataDir, logger, migrations })).version,
      2
    )
    assert.equal(counting.runs(), 1)
  })

  it('runs every pending refusing step before any converting step writes', async () => {
    // A store the previous release wrote, at the newest layout it knows.
    await stamp(dataDir, 1)
    await mkdir(path.join(dataDir, 'spaces'))
    const previous: StoreMigration[] = [noop]
    const marker = path.join(dataDir, 'converted')
    const convert: StoreMigration = {
      kind: 'convert',
      run: async () => {
        await writeFile(marker, '')
      }
    }
    const refuse: StoreMigration = {
      kind: 'refuse',
      run: async () => {
        throw new StoreVersionError({ detail: 'no conversion for this store' })
      }
    }
    await assert.rejects(
      applyStoreMigrations({
        dataDir,
        logger,
        migrations: [...previous, convert, refuse]
      }),
      StoreVersionError
    )
    assert.equal(await storedVersion(dataDir), 1, 'nothing was stamped')
    assert.equal(
      await fileExists(marker),
      false,
      'the converting step before the refusal did not run'
    )
    // The previous release boots on the store as it left it.
    const { version } = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: previous
    })
    assert.equal(version, 1)
  })

  it('runs a passing refusing step once, ahead of the converting steps', async () => {
    await stamp(dataDir, 1)
    await mkdir(path.join(dataDir, 'spaces'))
    const order: string[] = []
    const migrations: StoreMigration[] = [
      noop,
      {
        kind: 'convert',
        run: async () => {
          order.push('convert-2')
        }
      },
      {
        kind: 'refuse',
        run: async () => {
          order.push('refuse-3')
        }
      }
    ]
    const { version } = await applyStoreMigrations({
      dataDir,
      logger,
      migrations
    })
    assert.equal(version, 3)
    assert.deepEqual(order, ['refuse-3', 'convert-2'])
    assert.equal(await storedVersion(dataDir), 3)
  })

  it('re-runs a step interrupted before its stamp write', async () => {
    await stamp(dataDir, 1)
    const marker = path.join(dataDir, 'marker')
    let fail = true
    // Idempotent: writes the same marker however often it runs.
    const interruptible: StoreMigration = {
      kind: 'convert',
      run: async ({ dataDir: root }) => {
        await writeFile(path.join(root, 'marker'), 'migrated')
        if (fail) {
          throw new Error('interrupted')
        }
      }
    }
    const migrations = [noop, interruptible]
    await assert.rejects(
      applyStoreMigrations({ dataDir, logger, migrations }),
      /interrupted/
    )
    assert.equal(await storedVersion(dataDir), 1)
    fail = false
    assert.equal(
      (await applyStoreMigrations({ dataDir, logger, migrations })).version,
      2
    )
    assert.equal(await readFile(marker, 'utf8'), 'migrated')
    assert.equal(await storedVersion(dataDir), 2)
  })

  it('lets only one of two concurrent runners migrate', async () => {
    await stamp(dataDir, 1)
    let ran = 0
    const slow: StoreMigration = {
      kind: 'convert',
      run: async () => {
        ran++
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    const migrations = [noop, slow]
    const results = await Promise.all([
      applyStoreMigrations({ dataDir, logger, migrations }),
      applyStoreMigrations({ dataDir, logger, migrations })
    ])
    assert.deepEqual(
      results.map(result => result.version),
      [2, 2]
    )
    assert.equal(results[0]!.originId, results[1]!.originId)
    assert.equal(ran, 1)
  })

  it('takes over a lock left by a process that is gone', async () => {
    await stamp(dataDir, 1)
    // This process's id, but not a lock this process holds: what a restart
    // that reused the id finds.
    await writeFile(
      path.join(dataDir, 'store.lock.left-behind'),
      JSON.stringify({ pid: process.pid, hostname: os.hostname() })
    )
    const { version } = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, noop],
      lockTimeoutMs: 1000
    })
    assert.equal(version, 2)
    assert.deepEqual(await readdir(dataDir), [STORE_FILE_NAME])
  })

  it('takes over a lock from another host whose heartbeat stopped', async () => {
    await stamp(dataDir, 1)
    const lockPath = await writeOtherHostLock(dataDir)
    const stale = new Date(Date.now() - 5 * 60 * 1000)
    await utimes(lockPath, stale, stale)
    const { version } = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, noop],
      lockTimeoutMs: 1000
    })
    assert.equal(version, 2)
  })

  it('waits on a live lock from another host until it is released', async () => {
    await stamp(dataDir, 1)
    const lockPath = await writeOtherHostLock(dataDir)
    const counting = countingMigration()
    const running = applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop, counting.migration],
      lockTimeoutMs: 5000
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(
      counting.runs(),
      0,
      'no step runs while the other host holds the lock'
    )
    await unlink(lockPath)
    assert.equal((await running).version, 2)
    assert.equal(counting.runs(), 1)
  })

  it('times out on a live lock from another host', async () => {
    await stamp(dataDir, 1)
    await writeOtherHostLock(dataDir)
    await assert.rejects(
      applyStoreMigrations({
        dataDir,
        logger,
        migrations: [noop, noop],
        lockTimeoutMs: 300
      }),
      StoreLockTimeoutError
    )
    assert.equal(await storedVersion(dataDir), 1)
  })

  it('removes stale temp files at the data root on backend open', async () => {
    await stamp(dataDir, STORE_MIGRATIONS.length)
    const tempPath = path.join(dataDir, '.tmp-left-behind')
    await writeFile(tempPath, '{"version":')
    const stale = new Date(Date.now() - TEMP_FILE_ORPHAN_AGE_MS - 60_000)
    await utimes(tempPath, stale, stale)
    await FileSystemBackend.open({ dataDir })
    assert.deepEqual(await readdir(dataDir), [STORE_FILE_NAME])
  })

  it('refuses a version newer than the code knows, naming both', async () => {
    await stamp(dataDir, STORE_MIGRATIONS.length + 1)
    await assert.rejects(
      FileSystemBackend.open({ dataDir }),
      (err: Error) =>
        err instanceof StoreVersionError &&
        err.message.includes(`version ${STORE_MIGRATIONS.length + 1}`) &&
        err.message.includes(`version ${STORE_MIGRATIONS.length}`)
    )
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length + 1)
  })

  it('migrates an unstamped data dir that holds data from version 0', async () => {
    await mkdir(path.join(dataDir, 'spaces'))
    const counting = countingMigration()
    const migrations = [noop, counting.migration]
    assert.equal(
      (await applyStoreMigrations({ dataDir, logger, migrations })).version,
      2
    )
    assert.equal(counting.runs(), 1, 'every step runs over pre-stamp data')
    assert.equal(await storedVersion(dataDir), 2)
    assert.deepEqual((await readdir(dataDir)).sort(), [
      'spaces',
      STORE_FILE_NAME
    ])
  })

  it('stamps an unstamped data dir that holds data on backend open', async () => {
    await mkdir(path.join(dataDir, 'spaces'))
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('stamps an empty store at the current version, ten, and boots', async () => {
    assert.equal(STORE_MIGRATIONS.length, 10)
    const backend = await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), 10)
    assert.match(backend.originId, ORIGIN_ID_PATTERN)
  })

  /**
   * Stamps the store at layout 8 and stages one Space with a live Collection
   * and a Collection tombstone, each Metadata file named with the given
   * segment between the kind prefix and the id (`meta.` is the layout-9 name,
   * an empty segment the earlier one). The policy files share the old
   * prefixes and are not Metadata files, so both layouts hold them.
   */
  async function stageLayout8Metadata(segment: '' | 'meta.'): Promise<void> {
    await stamp(dataDir, 8)
    const spaceDir = path.join(dataDir, 'spaces', 'some-space')
    const collectionDir = path.join(spaceDir, 'notes')
    await mkdir(collectionDir, { recursive: true })
    await writeFile(
      path.join(spaceDir, `.space.${segment}some-space.json`),
      JSON.stringify({ id: 'some-space' })
    )
    await writeFile(
      path.join(spaceDir, `.collection.${segment}gone.json`),
      '{}'
    )
    await writeFile(
      path.join(collectionDir, `.collection.${segment}notes.json`),
      '{}'
    )
    await writeFile(path.join(spaceDir, '.space.policy.json'), '{}')
    await writeFile(path.join(collectionDir, '.collection.policy.json'), '{}')
  }

  it('refuses a layout-8 store that holds a Metadata file under its old name, on every boot', async () => {
    await stageLayout8Metadata('')
    for (let boot = 0; boot < 2; boot++) {
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        (err: Error) =>
          err instanceof StoreVersionError &&
          err.message.includes('1 Space Metadata file(s)') &&
          err.message.includes('2 Collection Metadata file(s)')
      )
      assert.equal(await storedVersion(dataDir), 8)
    }
  })

  it('stamps a layout-8 store holding Metadata files under the new names at the current layout', async () => {
    await stageLayout8Metadata('meta.')
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  /**
   * Stages a layout-7 store: a Space with one revocation record under the
   * `space-revocations/` root, and the revocation tree of a Space that is
   * gone, as an interrupted Delete Space of that layout left it.
   */
  async function stageLayout7Revocations(): Promise<{
    spaceDir: string
    oldRoot: string
  }> {
    await stamp(dataDir, 7)
    const spaceDir = path.join(dataDir, 'spaces', 'some-space')
    await mkdir(spaceDir, { recursive: true })
    await writeFile(
      path.join(spaceDir, '.space.meta.some-space.json'),
      JSON.stringify({ id: 'some-space', type: ['Space'] })
    )
    const oldRoot = path.join(dataDir, 'space-revocations')
    await mkdir(path.join(oldRoot, 'some-space'), { recursive: true })
    await writeFile(path.join(oldRoot, 'some-space', 'one.json'), '{}')
    await mkdir(path.join(oldRoot, 'gone-space'), { recursive: true })
    await writeFile(path.join(oldRoot, 'gone-space', 'two.json'), '{}')
    // A staging temp file a killed write left goes with the root.
    await writeFile(path.join(oldRoot, '.tmp-abandoned'), 'x')
    return { spaceDir, oldRoot }
  }

  it("moves a layout-7 store's revocation trees into the Space dirs and drops the root", async () => {
    const { spaceDir, oldRoot } = await stageLayout7Revocations()
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
    assert.deepEqual(await readdir(path.join(spaceDir, '.revocations')), [
      'one.json'
    ])
    await assert.rejects(readdir(oldRoot), { code: 'ENOENT' })
    assert.deepEqual(await readdir(path.join(dataDir, 'spaces')), [
      'some-space'
    ])
  })

  it('repeats the layout-8 step after a run cut short before its stamp', async () => {
    const { spaceDir } = await stageLayout7Revocations()
    await applyStoreMigrations({ dataDir, logger })
    await stamp(dataDir, 7)
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
    assert.deepEqual(await readdir(path.join(spaceDir, '.revocations')), [
      'one.json'
    ])
  })

  it('refuses a layout-7 store whose revocation root holds a stray file, before moving anything', async () => {
    const { spaceDir, oldRoot } = await stageLayout7Revocations()
    await writeFile(path.join(oldRoot, 'note'), 'x')
    await assert.rejects(
      FileSystemBackend.open({ dataDir }),
      (err: Error) =>
        err instanceof StoreVersionError && err.message.includes('note')
    )
    assert.equal(await storedVersion(dataDir), 7)
    assert.deepEqual(await readdir(path.join(oldRoot, 'some-space')), [
      'one.json'
    ])
    await assert.rejects(readdir(path.join(spaceDir, '.revocations')), {
      code: 'ENOENT'
    })
  })

  it('refuses a layout-7 store whose Space holds revocations in both layouts', async () => {
    const { spaceDir } = await stageLayout7Revocations()
    await mkdir(path.join(spaceDir, '.revocations'))
    await assert.rejects(
      FileSystemBackend.open({ dataDir }),
      (err: Error) =>
        err instanceof StoreVersionError && err.message.includes('both layouts')
    )
    assert.equal(await storedVersion(dataDir), 7)
  })

  it('stamps a layout-7 store with no revocation root at the current layout', async () => {
    await stamp(dataDir, 7)
    await mkdir(path.join(dataDir, 'spaces', 'some-space'), { recursive: true })
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('refuses a layout-6 store that holds an unstamped registration file, on every boot', async () => {
    await stamp(dataDir, 6)
    const spaceDir = path.join(dataDir, 'spaces', 'some-space')
    await mkdir(spaceDir, { recursive: true })
    await writeFile(
      path.join(spaceDir, '.replica.peer.json'),
      JSON.stringify({
        id: 'peer',
        fromSpace: 'https://peer.example/space/s/',
        toSpace: 'https://pws.example/space/some-space/',
        capability: {},
        role: 'source',
        _generation: 'z1',
        _spaceGeneration: 'z2'
      })
    )
    // The loop state beside it carries no stamp and is not a registration.
    await writeFile(
      path.join(spaceDir, '.replica.peer.state.json'),
      '{"collections":{}}'
    )
    for (let boot = 0; boot < 2; boot++) {
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        (err: Error) =>
          err instanceof StoreVersionError &&
          err.message.includes('1 replica registration file(s)')
      )
      assert.equal(await storedVersion(dataDir), 6)
    }
  })

  it('stamps a layout-6 store holding a stamped registration file at the current layout', async () => {
    await stamp(dataDir, 6)
    const spaceDir = path.join(dataDir, 'spaces', 'some-space')
    await mkdir(spaceDir, { recursive: true })
    await writeFile(
      path.join(spaceDir, '.replica.peer.json'),
      JSON.stringify({
        id: 'peer',
        fromSpace: 'https://peer.example/space/s/',
        toSpace: 'https://pws.example/space/some-space/',
        capability: {},
        role: 'source',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedAtCounter: 0,
        originId: 'o',
        _generation: 'z1',
        _spaceGeneration: 'z2'
      })
    )
    // A file that does not parse is not a registration.
    await writeFile(path.join(spaceDir, '.replica.bad.json'), '{not json')
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('refuses a layout-1 store that holds a Space, on every boot', async () => {
    await stamp(dataDir, 1)
    await mkdir(path.join(dataDir, 'spaces', 'some-space'), { recursive: true })
    for (let boot = 0; boot < 2; boot++) {
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        StoreVersionError
      )
      assert.equal(await storedVersion(dataDir), 1)
    }
  })

  it('refuses a layout-2 store that holds a policy file, on every boot', async () => {
    await stamp(dataDir, 2)
    const collectionDir = path.join(dataDir, 'spaces', 'some-space', 'col')
    await mkdir(collectionDir, { recursive: true })
    await writeFile(
      path.join(collectionDir, '.r.doc.policy.json'),
      '{"type":"PublicCanRead"}'
    )
    for (let boot = 0; boot < 2; boot++) {
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        (err: Error) =>
          err instanceof StoreVersionError &&
          err.message.includes('1 access-control policy file(s)')
      )
      assert.equal(await storedVersion(dataDir), 2)
    }
  })

  it('stamps a layout-2 store holding Spaces but no policy at the current layout', async () => {
    await stamp(dataDir, 2)
    await mkdir(path.join(dataDir, 'spaces', 'some-space', 'col'), {
      recursive: true
    })
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('refuses a layout-3 store that holds a feed counter file, on every boot', async () => {
    await stamp(dataDir, 3)
    const collectionDir = path.join(dataDir, 'spaces', 'some-space', 'col')
    await mkdir(collectionDir, { recursive: true })
    await writeFile(
      path.join(collectionDir, '.feed.col.json'),
      '{"generation":"z1","position":1,"collectionMetadataPosition":1}'
    )
    for (let boot = 0; boot < 2; boot++) {
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        (err: Error) =>
          err instanceof StoreVersionError &&
          err.message.includes('1 changes-feed counter file(s)')
      )
      assert.equal(await storedVersion(dataDir), 3)
    }
  })

  it.each(['.collection.policy.json', '.r.doc.policy.json'])(
    'refuses a layout-3 store that holds a policy file in a Collection (%s)',
    async fileName => {
      await stamp(dataDir, 3)
      const collectionDir = path.join(dataDir, 'spaces', 'some-space', 'col')
      await mkdir(collectionDir, { recursive: true })
      await writeFile(
        path.join(collectionDir, fileName),
        '{"type":"PublicCanRead","_generation":"z1"}'
      )
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        (err: Error) =>
          err instanceof StoreVersionError &&
          err.message.includes('1 Collection or Resource policy file(s)')
      )
      assert.equal(await storedVersion(dataDir), 3)
    }
  )

  it('stamps a layout-3 store holding Collections and a Space policy at the current layout', async () => {
    await stamp(dataDir, 3)
    const spaceDir = path.join(dataDir, 'spaces', 'some-space')
    await mkdir(path.join(spaceDir, 'col'), { recursive: true })
    // A Space policy takes no feed position, so it passes.
    await writeFile(
      path.join(spaceDir, '.space.policy.json'),
      '{"type":"PublicCanRead","_generation":"z1"}'
    )
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('stamps an empty layout-3 store at the current layout', async () => {
    await stamp(dataDir, 3)
    await mkdir(path.join(dataDir, 'spaces'))
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  it('refuses a layout-4 store that holds a tombstone under the live sidecar name, on every boot', async () => {
    await stamp(dataDir, 4)
    const collectionDir = path.join(dataDir, 'spaces', 'some-space', 'col')
    await mkdir(collectionDir, { recursive: true })
    await writeFile(
      path.join(collectionDir, '.meta.gone.json'),
      JSON.stringify({
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedAtCounter: 0,
        originId: 'o',
        generation: 'z1',
        contentType: 'application/json',
        feedPosition: 2,
        deleted: true
      })
    )
    for (let boot = 0; boot < 2; boot++) {
      await assert.rejects(
        FileSystemBackend.open({ dataDir }),
        (err: Error) =>
          err instanceof StoreVersionError &&
          err.message.includes('1 Resource tombstone(s)') &&
          err.message.includes('Wipe the data directory')
      )
      assert.equal(await storedVersion(dataDir), 4)
    }
  })

  it('stamps a layout-4 store holding live sidecars and a damaged one at the current layout', async () => {
    await stamp(dataDir, 4)
    const collectionDir = path.join(dataDir, 'spaces', 'some-space', 'col')
    await mkdir(collectionDir, { recursive: true })
    await writeFile(
      path.join(collectionDir, '.meta.doc.json'),
      '{"contentType":"application/json","feedPosition":1,"digest":"mh=uEiA"}'
    )
    // A sidecar that does not parse is not a tombstone.
    await writeFile(path.join(collectionDir, '.meta.bad.json'), '{not json')
    // A tombstone under its own name is the current layout.
    await writeFile(
      path.join(collectionDir, '.tombstone.gone.json'),
      '{"deleted":true,"feedPosition":2}'
    )
    // A staging dir a killed process left at the Collection level is not a
    // Collection, so a tombstone under the live name inside it is not read.
    const tempDir = path.join(dataDir, 'spaces', 'some-space', '.tmp-left')
    await mkdir(tempDir, { recursive: true })
    await writeFile(
      path.join(tempDir, '.meta.gone.json'),
      '{"deleted":true,"feedPosition":2}'
    )
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), STORE_MIGRATIONS.length)
  })

  /**
   * Stamps the store at layout 9 and stages one Collection holding a live
   * Resource sidecar, a chunk sidecar under the Resource's chunk dir, and a
   * Resource tombstone, each with or without a `digest` member.
   * @param options {object}
   * @param options.resourceDigest {boolean}
   * @param options.chunkDigest {boolean}
   * @returns {Promise<void>}
   */
  async function stageLayout9Sidecars({
    resourceDigest,
    chunkDigest
  }: {
    resourceDigest: boolean
    chunkDigest: boolean
  }): Promise<void> {
    await stamp(dataDir, 9)
    const collectionDir = path.join(dataDir, 'spaces', 'some-space', 'col')
    const chunkDir = path.join(collectionDir, chunkDirName('doc'))
    await mkdir(chunkDir, { recursive: true })
    const digest = { digest: 'mh=uEiA' }
    await writeFile(
      path.join(collectionDir, '.meta.doc.json'),
      JSON.stringify({
        contentType: 'application/json',
        feedPosition: 1,
        ...(resourceDigest && digest)
      })
    )
    await writeFile(
      path.join(chunkDir, '.meta.0.json'),
      JSON.stringify({
        contentType: 'application/octet-stream',
        ...(chunkDigest && digest)
      })
    )
    // A tombstone is not held to the member: one an import wrote has none.
    await writeFile(
      path.join(collectionDir, '.tombstone.gone.json'),
      '{"deleted":true,"contentType":"application/json","feedPosition":2}'
    )
    // A sidecar that does not parse is not a record.
    await writeFile(path.join(collectionDir, '.meta.bad.json'), '{not json')
  }

  it.each([
    ['a live Resource sidecar', { resourceDigest: false, chunkDigest: true }],
    ['a chunk sidecar', { resourceDigest: true, chunkDigest: false }]
  ])(
    'refuses a layout-9 store holding %s with no digest, on every boot',
    async (_label, staged) => {
      await stageLayout9Sidecars(staged)
      for (let boot = 0; boot < 2; boot++) {
        await assert.rejects(
          FileSystemBackend.open({ dataDir }),
          (err: Error) =>
            err instanceof StoreVersionError &&
            err.message.includes('1 live Resource or chunk sidecar(s)') &&
            err.message.includes('Wipe the data directory')
        )
        assert.equal(await storedVersion(dataDir), 9)
      }
    }
  )

  it('stamps a layout-9 store whose live sidecars carry a digest at layout 10, a digestless tombstone included', async () => {
    await stageLayout9Sidecars({ resourceDigest: true, chunkDigest: true })
    await FileSystemBackend.open({ dataDir })
    assert.equal(await storedVersion(dataDir), 10)
  })

  it('refuses a store.json with no integer version', async () => {
    await writeFile(path.join(dataDir, STORE_FILE_NAME), '{"version":"1"}')
    await assert.rejects(
      applyStoreMigrations({ dataDir, logger }),
      StoreVersionError
    )
  })
})

describe('Filesystem store origin id', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-store-origin-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('mints an id on a fresh dir and reads it back on the next boot', async () => {
    const first = await applyStoreMigrations({ dataDir, logger })
    assert.match(first.originId, ORIGIN_ID_PATTERN)
    assert.deepEqual(await storedRecord(dataDir), {
      version: STORE_MIGRATIONS.length,
      originId: first.originId
    })
    const second = await applyStoreMigrations({ dataDir, logger })
    assert.equal(second.originId, first.originId)
  })

  it('uses a configured id verbatim and reads it back on the next boot', async () => {
    const first = await applyStoreMigrations({
      dataDir,
      logger,
      originId: 'east-1'
    })
    assert.equal(first.originId, 'east-1')
    assert.equal((await storedRecord(dataDir)).originId, 'east-1')
    const second = await applyStoreMigrations({ dataDir, logger })
    assert.equal(second.originId, 'east-1')
  })

  it('refuses a configured id that differs from the stored one', async () => {
    await stamp(dataDir, STORE_MIGRATIONS.length, 'stored-id')
    const before = await readFile(path.join(dataDir, STORE_FILE_NAME), 'utf8')
    await assert.rejects(
      applyStoreMigrations({ dataDir, logger, originId: 'other-id' }),
      (err: Error) =>
        err instanceof StoreOriginIdError &&
        err.message.includes('"stored-id"') &&
        err.message.includes('"other-id"')
    )
    assert.equal(
      await readFile(path.join(dataDir, STORE_FILE_NAME), 'utf8'),
      before
    )
  })

  it('boots with a configured id equal to the stored one', async () => {
    await stamp(dataDir, STORE_MIGRATIONS.length, 'same-id')
    const result = await applyStoreMigrations({
      dataDir,
      logger,
      originId: 'same-id'
    })
    assert.equal(result.originId, 'same-id')
  })

  it.each(['has space', 'a'.repeat(65)])(
    'refuses a malformed stored originId (%s)',
    async malformed => {
      await stamp(dataDir, STORE_MIGRATIONS.length, malformed)
      await assert.rejects(
        applyStoreMigrations({ dataDir, logger }),
        StoreOriginIdError
      )
    }
  )

  it('refuses a malformed configured originId before anything is written', async () => {
    await assert.rejects(
      FileSystemBackend.open({ dataDir, originId: 'bad id!' }),
      StoreOriginIdError
    )
    await assert.rejects(
      readFile(path.join(dataDir, STORE_FILE_NAME)),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT'
    )
  })

  it('gives a stamped dir with no originId one, keeping its version', async () => {
    await stamp(dataDir, 1)
    await mkdir(path.join(dataDir, 'spaces'))
    const result = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [noop]
    })
    assert.match(result.originId, ORIGIN_ID_PATTERN)
    assert.deepEqual(await storedRecord(dataDir), {
      version: 1,
      originId: result.originId
    })
  })

  it('keeps the id written before a migration step that was interrupted', async () => {
    await mkdir(path.join(dataDir, 'spaces'))
    await writeFile(path.join(dataDir, 'spaces', 'entry'), 'data')
    let fail = true
    const interruptible: StoreMigration = {
      kind: 'convert',
      run: async () => {
        if (fail) {
          throw new Error('interrupted')
        }
      }
    }
    const migrations = [interruptible]
    await assert.rejects(
      applyStoreMigrations({ dataDir, logger, migrations }),
      /interrupted/
    )
    const written = await storedRecord(dataDir)
    assert.equal(written.version, 0)
    assert.match(written.originId!, ORIGIN_ID_PATTERN)
    fail = false
    const result = await applyStoreMigrations({ dataDir, logger, migrations })
    assert.equal(result.version, 1)
    assert.equal(result.originId, written.originId)
    assert.deepEqual(await storedRecord(dataDir), {
      version: 1,
      originId: written.originId
    })
  })

  it('keeps the id across each version stamp a migration run writes', async () => {
    await stamp(dataDir, 0, 'kept-id')
    await mkdir(path.join(dataDir, 'spaces'))
    const seen: Array<{ version: number; originId?: string }> = []
    const observe: StoreMigration = {
      kind: 'convert',
      run: async ({ dataDir: root }) => {
        seen.push(await storedRecord(root))
      }
    }
    const result = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [observe, observe]
    })
    assert.deepEqual(seen, [
      { version: 0, originId: 'kept-id' },
      { version: 1, originId: 'kept-id' }
    ])
    assert.equal(result.originId, 'kept-id')
    assert.deepEqual(await storedRecord(dataDir), {
      version: 2,
      originId: 'kept-id'
    })
  })

  it('keeps clockHighWater across each rewrite, as it keeps the id', async () => {
    await writeFile(
      path.join(dataDir, STORE_FILE_NAME),
      JSON.stringify({ version: 0, originId: 'kept-id', clockHighWater: 12345 })
    )
    await mkdir(path.join(dataDir, 'spaces'))
    const seen: Array<{ version: number; clockHighWater?: number }> = []
    const observe: StoreMigration = {
      kind: 'convert',
      run: async ({ dataDir: root }) => {
        const { version, clockHighWater } = await storedRecord(root)
        seen.push({ version, clockHighWater })
      }
    }
    const result = await applyStoreMigrations({
      dataDir,
      logger,
      migrations: [observe, observe]
    })
    assert.deepEqual(seen, [
      { version: 0, clockHighWater: 12345 },
      { version: 1, clockHighWater: 12345 }
    ])
    assert.equal(result.clockHighWater, 12345)
    assert.deepEqual(await storedRecord(dataDir), {
      version: 2,
      originId: 'kept-id',
      clockHighWater: 12345
    })
  })

  it('carries the id as soon as open() resolves', async () => {
    const backend = await FileSystemBackend.open({
      dataDir,
      originId: 'node-a'
    })
    assert.equal(backend.originId, 'node-a')
    assert.equal((await storedRecord(dataDir)).originId, 'node-a')
    const reopened = await FileSystemBackend.open({ dataDir })
    assert.equal(reopened.originId, 'node-a')
  })
})
