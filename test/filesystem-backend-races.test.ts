/**
 * Regression tests for the `FileSystemBackend`'s concurrency and I/O-failure
 * handling, at the backend level (no server): a container removal racing a
 * write, an enumeration whose directory is removed underneath it, a read racing
 * a delete, and the quota-cache invalidation order around a delete. Each case
 * is a race the backend must absorb rather than surface as a 500 -- or, for the
 * removals, must not leave behind as a structurally broken Space.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import {
  rm,
  readdir,
  chmod,
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { chunkDirName } from '@interop/space-archive'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { etagOf, formatEtag } from '../src/lib/etag.js'
import {
  ResourceImmutableError,
  ResourceNotFoundError,
  StorageError
} from '../src/errors.js'
import { importArchive, openTempBackend } from './helpers.js'

const controller = 'did:key:z6MkRacesTestController'

describe('FileSystemBackend races', () => {
  let backend: TempFileSystemBackend
  const spaceId = 'races-space'
  const collectionId = 'credentials'

  beforeEach(async () => {
    backend = await openTempBackend()
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: {
        id: collectionId,
        type: ['Collection'],
        name: 'Credentials'
      }
    })
  })

  afterEach(async () => {
    await backend.close()
  })

  /**
   * The Collection directory as it exists on disk.
   */
  const collectionDirEntries = async (): Promise<string[]> => {
    try {
      return await readdir(
        path.join(backend.dataDir, 'spaces', spaceId, collectionId)
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  it('a Collection delete racing a Resource write leaves no phantom directory', async () => {
    // Regression: the delete serialized only on the metadata key while the
    // write recreated the Collection dir under its own per-Resource key, so the
    // dir came back holding Resources but no metadata file -- listed by
    // `listCollections`, 404 on read, and still counted against the quota.
    const writes = Array.from({ length: 40 }, (_unused, index) =>
      backend
        .writeResource({
          spaceId,
          collectionId,
          resourceId: `doc-${index}`,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { index }
          }
        })
        .catch(() => undefined)
    )
    await backend.deleteCollection({ spaceId, collectionId })
    await Promise.all(writes)

    const metadata = await backend.getCollectionMetadata({
      spaceId,
      collectionId
    })
    // Either the Collection is deleted, leaving only its tombstone file, or
    // it exists WITH its metadata file. What must never happen is content
    // under a deleted Collection.
    if (metadata === undefined) {
      assert.deepEqual(
        await collectionDirEntries(),
        [`.collection.meta.${collectionId}.json`],
        'Collection was deleted but its directory holds more than its tombstone'
      )
    }
  })

  it('a Space delete racing a Resource write leaves no unreachable Space directory', async () => {
    const writes = Array.from({ length: 40 }, (_unused, index) =>
      backend
        .writeResource({
          spaceId,
          collectionId,
          resourceId: `doc-${index}`,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { index }
          }
        })
        .catch(() => undefined)
    )
    await backend.deleteSpace({ spaceId })
    await Promise.all(writes)

    const metadata = await backend.getSpaceMetadata({ spaceId })
    if (metadata === undefined) {
      const spaceDir = path.join(backend.dataDir, 'spaces', spaceId)
      let entries: string[] = []
      try {
        entries = await readdir(spaceDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }
      assert.deepEqual(
        entries,
        [],
        'Space was deleted but its directory holds data no route can reach'
      )
    }
  })

  /**
   * The Space directory's entries, `[]` when it is absent.
   */
  const spaceDirEntries = async (): Promise<string[]> => {
    try {
      return await readdir(path.join(backend.dataDir, 'spaces', spaceId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  it('a write whose prelude passed before a Space delete recreates no directory', async () => {
    // Regression: the Space gate orders a write against a removal, but a write
    // whose shared acquisition came after the removal released the exclusive
    // side went ahead on the request layer's earlier existence check. Its
    // `mkdir -p` recreated `spaces/<S>/<C>/` with live Resources and no
    // `.space.meta.<S>.json`, which the next Space created under the same id
    // adopted.
    //
    // The prelude: the request layer finds the Space and the Collection.
    assert.ok(await backend.getSpaceMetadata({ spaceId }))
    assert.ok(await backend.getCollectionMetadata({ spaceId, collectionId }))
    // Then Delete Space claims the gate, and the write queues behind it.
    const deletion = backend.deleteSpace({ spaceId })
    const writes = [
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'late-json',
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: { late: true }
        }
      }),
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'late-blob',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: Readable.from(Buffer.from('late'))
        }
      }),
      backend.writePolicy({
        spaceId,
        collectionId,
        policy: { type: 'PublicCanRead' }
      }),
      backend.writeCollection({
        spaceId,
        collectionId: 'other',
        collectionMetadata: { id: 'other', type: ['Collection'] }
      })
    ]
    await deletion
    const outcomes = await Promise.allSettled(writes)
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected')
      assert.equal(
        (outcome as PromiseRejectedResult).reason.statusCode,
        404,
        String((outcome as PromiseRejectedResult).reason)
      )
    }
    assert.deepEqual(await spaceDirEntries(), [])
  })

  it('a policy on a Collection with no Metadata object makes no phantom directory', async () => {
    await assert.rejects(
      backend.writePolicy({
        spaceId,
        collectionId: 'phantom',
        policy: { type: 'PublicCanRead' }
      }),
      (err: { statusCode?: number }) => err.statusCode === 404
    )
    assert.equal(
      (await spaceDirEntries()).includes('phantom'),
      false,
      'the refused policy write created the Collection directory'
    )
    const listing = await backend.listCollections({ spaceId })
    assert.deepEqual(
      listing.items.map(collection => collection.id),
      [collectionId]
    )
  })

  it('an import takes each Resource lock, so it cannot interleave with a write', async () => {
    // Regression: `importSpace` did check-then-write per Resource with no
    // per-Resource lock, while every other write path holds one across its
    // existence probe, body write and sidecar bump. A concurrent PUT could
    // therefore bump the sidecar -- returning that `ETag` to its client --
    // while the archive's bytes landed underneath it, leaving a stored
    // validator that describes content that client never saw.
    //
    // Tested as the invariant rather than the interleaving: with a write to
    // `doc` in flight (holding its lock), an import that also carries `doc`
    // must not be able to write it.
    const sourceBackend = await openTempBackend({ prefix: 'was-test-src-' })
    try {
      await sourceBackend.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller }
      })
      await sourceBackend.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata: {
          id: collectionId,
          type: ['Collection'],
          name: 'Credentials'
        }
      })
      await sourceBackend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'doc',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          declaredBytes: 8,
          stream: bufferStream(Buffer.alloc(8, 0x61))
        }
      })
      const archive = await sourceBackend.exportSpace({ spaceId })

      // A blob write whose body has not finished arriving: it holds `doc`'s
      // lock until the test lets the stream end.
      const slowBody = new Readable({ read() {} })
      const inFlight = backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'doc',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: slowBody
        }
      })
      slowBody.push(Buffer.alloc(8, 0x62))
      await new Promise(resolve => setTimeout(resolve, 20))

      let importFinished = false
      const importRun = importArchive({
        backend: backend,
        spaceId,
        tarStream: archive
      }).then(() => {
        importFinished = true
      })
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(
        importFinished,
        false,
        'the import wrote a Resource while another write held its lock'
      )

      slowBody.push(null)
      await inFlight
      await importRun
    } finally {
      await sourceBackend.close()
    }
  })

  it("a governing log's guarded create waits for a write that already read the write-once flag", async () => {
    // A guarded create can declare the Collection write-once. A Resource
    // write decides that rule from the log it reads under its lock, so the
    // create must not land between that read and the write's bytes.
    const binary = (stream: Readable) => ({
      kind: 'binary' as const,
      contentType: 'application/octet-stream',
      stream
    })
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'doc',
      input: binary(bufferStream(Buffer.from('first')))
    })

    let recheckedWithLog: boolean | undefined
    let signalRechecked!: () => void
    const rechecked = new Promise<void>(resolve => {
      signalRechecked = resolve
    })
    let releaseBody!: () => void
    const bodyReleased = new Promise<void>(resolve => {
      releaseBody = resolve
    })
    // A body that stalls after its first bytes, holding the write open.
    let started = false
    const stalled = new Readable({
      read() {
        if (started) {
          return
        }
        started = true
        this.push(Buffer.from('sec'))
        void bodyReleased.then(() => {
          this.push(Buffer.from('ond'))
          this.push(null)
        })
      }
    })
    const overwrite = backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'doc',
      input: binary(stalled),
      immutable: async ({ log }) => {
        recheckedWithLog = log !== undefined
        signalRechecked()
        return log !== undefined
      }
    })
    await rechecked
    assert.equal(recheckedWithLog, false)

    let logSettled = false
    const logWrite = backend
      .writeCollectionLog({
        spaceId,
        collectionId,
        body: '{"state":{"revisions":{"immutable":true}}}\n',
        ifNoneMatch: '*'
      })
      .finally(() => {
        logSettled = true
      })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(logSettled, false, 'the create landed inside the write')

    releaseBody()
    await overwrite
    assert.ok(await logWrite)

    // A write that starts after the create reads the log and is refused.
    await assert.rejects(
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'doc',
        input: binary(bufferStream(Buffer.from('third'))),
        immutable: async ({ log }) => log !== undefined
      }),
      (err: unknown) => err instanceof ResourceImmutableError
    )
  })

  it('a write right after a delete is not refused by a stale quota snapshot', async () => {
    // Regression: `deleteResource` dropped the cached usage BEFORE the removal,
    // so a concurrent write could re-measure the pre-delete tree and cache that
    // total for a full TTL -- refusing the client's follow-up write over space
    // the delete had just freed.
    const capped = await FileSystemBackend.open({
      dataDir: backend.dataDir,
      capacityBytes: 200_000
    })
    const { validator } = await capped.writeResource({
      spaceId,
      collectionId,
      resourceId: 'bulky',
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        declaredBytes: 100_000,
        stream: bufferStream(Buffer.alloc(100_000, 0x61))
      }
    })

    // Land a concurrent write inside the delete, BEFORE it has removed
    // anything: that write re-measures the tree and caches the pre-delete
    // total. The invalidation must therefore come after the removal, or that
    // stale snapshot outlives the delete and refuses the follow-up write.
    const sidecarRead = capped.readMetaSidecar.bind(capped)
    let raced = false
    vi.spyOn(capped, 'readMetaSidecar').mockImplementation(async options => {
      const sidecar = await sidecarRead(options)
      if (!raced) {
        raced = true
        await capped.writeResource({
          spaceId,
          collectionId,
          resourceId: 'tiny',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { a: 1 }
          }
        })
      }
      return sidecar
    })
    // A conditional delete, so its precondition read runs before the removal
    // and gives the racing write that window.
    await capped.deleteResource({
      spaceId,
      collectionId,
      resourceId: 'bulky',
      ifMatch: formatEtag(validator)
    })
    vi.restoreAllMocks()

    // The freed bytes must be visible immediately, not after the cache TTL.
    await capped.writeResource({
      spaceId,
      collectionId,
      resourceId: 'replacement',
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        declaredBytes: 100_000,
        stream: bufferStream(Buffer.alloc(100_000, 0x61))
      }
    })
  })

  it('listCollectionItems surfaces an I/O failure rather than reporting an empty Collection', async () => {
    // Regression: every `readdir` error was swallowed and logged, so an
    // unreadable Collection answered 200 with `totalItems: 0` -- which a
    // replicating client reads as "every Resource was removed".
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'doc',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    // Pass the metadata in, as the request layer does once it has fetched it
    // (`CollectionRequest`): the Collection provably exists, so the only thing
    // that can fail below is the directory enumeration itself.
    const collectionMetadata = await backend.getCollectionMetadata({
      spaceId,
      collectionId
    })
    assert.ok(collectionMetadata)
    const collectionDir = path.join(
      backend.dataDir,
      'spaces',
      spaceId,
      collectionId
    )
    await chmod(collectionDir, 0o000)
    try {
      await assert.rejects(
        backend.listCollectionItems({
          spaceId,
          collectionId,
          collectionMetadata
        }),
        (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES'
      )
    } finally {
      await chmod(collectionDir, 0o755)
    }
  })

  it('a read that races a delete resolves 404, not a storage fault', async () => {
    // Regression: `openFileStream` rejected with a bare `Error` carrying no
    // code, so `handleError` rendered a 500 -- contradicting the comment that
    // justifies skipping the existence recheck on this path.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'vanishing',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    const collectionDir = path.join(
      backend.dataDir,
      'spaces',
      spaceId,
      collectionId
    )
    const files = await readdir(collectionDir)
    const representation = files.find(name => name.startsWith('r.vanishing'))
    assert.ok(representation)
    // Land a real delete in the exact window the read path leaves open: the
    // read takes the live sidecar, then opens the file it names. The delete
    // commits its tombstone and removes the file in between, so the open is
    // what discovers the removal, and the read's second look at the sidecar
    // finds the tombstone.
    const sidecarRead = backend.readMetaSidecar.bind(backend)
    let deleted = false
    vi.spyOn(backend, 'readMetaSidecar').mockImplementation(async options => {
      const sidecar = await sidecarRead(options)
      if (!deleted) {
        deleted = true
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'vanishing'
        })
      }
      return sidecar
    })
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'vanishing' }),
      (err: unknown) => err instanceof ResourceNotFoundError
    )
    vi.restoreAllMocks()
  })

  /**
   * Runs `race` once, right after the read takes the target's sidecar, so the
   * read holds a live sidecar whose file is about to go.
   * @param options {object}
   * @param options.dir {string}   the dir the target's sidecar lives in
   * @param options.id {string}   the target's id in that dir
   * @param options.race {() => Promise<void>}
   * @returns {void}
   */
  function raceAfterSidecarRead({
    dir,
    id,
    race
  }: {
    dir: string
    id: string
    race: () => Promise<void>
  }): void {
    const sidecarRead = backend.readMetaSidecar.bind(backend)
    let raced = false
    vi.spyOn(backend, 'readMetaSidecar').mockImplementation(async options => {
      const sidecar = await sidecarRead(options)
      if (
        !raced &&
        options.collectionDir === dir &&
        options.resourceId === id
      ) {
        raced = true
        await race()
      }
      return sidecar
    })
  }

  it('a read that races a delete and a create of the id serves the new record whole', async () => {
    // The file name carries nothing of the write that made it, so the open
    // succeeds on the file the create wrote. The read's second look at the
    // sidecar finds another write's stamp and follows it, so the bytes and
    // the `createdBy` served are one record's.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'swapped',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } },
      createdBy: ['did:key:z6MkFirst']
    })
    const collectionDir = path.join(
      backend.dataDir,
      'spaces',
      spaceId,
      collectionId
    )
    raceAfterSidecarRead({
      dir: collectionDir,
      id: 'swapped',
      race: async () => {
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'swapped'
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'swapped',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { b: 2 }
          },
          createdBy: ['did:key:z6MkSecond']
        })
      }
    })
    const result = await backend.getResource({
      spaceId,
      collectionId,
      resourceId: 'swapped'
    })
    vi.restoreAllMocks()
    const chunks: Buffer[] = []
    for await (const chunk of result.resourceStream) {
      chunks.push(chunk as Buffer)
    }
    assert.deepStrictEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      b: 2
    })
    assert.deepStrictEqual(result.createdBy, ['did:key:z6MkSecond'])
    const stored = await backend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId: 'swapped'
    })
    assert.ok(stored)
    assert.equal(etagOf(result), etagOf(stored))
  })

  it('a read that races Delete Collection resolves 404 while a member sidecar is left', async () => {
    // Delete Collection writes its tombstone, then removes the members in no
    // fixed order, so a read can hold a member's live sidecar while its file
    // is already gone. The Collection no longer stands, so the member is
    // absent, not damaged.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'member',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    const collectionDir = path.join(
      backend.dataDir,
      'spaces',
      spaceId,
      collectionId
    )
    const sidecarPath = path.join(collectionDir, '.meta.member.json')
    raceAfterSidecarRead({
      dir: collectionDir,
      id: 'member',
      race: async () => {
        const sidecar = await readFile(sidecarPath)
        await backend.deleteCollection({ spaceId, collectionId })
        // The tombstone is committed and the member's file gone, but its
        // sidecar is still in place: the moment the removal can leave.
        await writeFile(sidecarPath, sidecar)
      }
    })
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'member' }),
      (err: unknown) => err instanceof ResourceNotFoundError
    )
    assert.equal(
      await backend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId: 'member'
      }),
      undefined
    )
    vi.restoreAllMocks()
  })

  it("a chunk read that races its parent Resource's delete resolves 404", async () => {
    // Delete Resource writes the parent's tombstone, then removes the chunk
    // directory, so a chunk read can hold the chunk's live sidecar while its
    // file is already gone. The parent no longer stands, so the chunk is
    // absent, not damaged.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'parent',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    await backend.writeChunk({
      spaceId,
      collectionId,
      resourceId: 'parent',
      chunkIndex: 0,
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        stream: bufferStream(Buffer.from('chunk'))
      }
    })
    const chunkDir = path.join(
      backend.dataDir,
      'spaces',
      spaceId,
      collectionId,
      chunkDirName('parent')
    )
    const chunkSidecarPath = path.join(chunkDir, '.meta.0.json')
    raceAfterSidecarRead({
      dir: chunkDir,
      id: '0',
      race: async () => {
        const chunkSidecar = await readFile(chunkSidecarPath)
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'parent'
        })
        // The parent's tombstone is committed and the chunk's file gone, but
        // the chunk's sidecar is still in place.
        await mkdir(chunkDir, { recursive: true })
        await writeFile(chunkSidecarPath, chunkSidecar)
      }
    })
    await assert.rejects(
      backend.getChunk({
        spaceId,
        collectionId,
        resourceId: 'parent',
        chunkIndex: 0
      }),
      (err: unknown) => err instanceof ResourceNotFoundError
    )
    assert.equal(
      await backend.getChunkMetadata({
        spaceId,
        collectionId,
        resourceId: 'parent',
        chunkIndex: 0
      }),
      undefined
    )
    vi.restoreAllMocks()
  })

  it('a live sidecar naming a missing file is a storage fault, not a 404', async () => {
    // No committed write leaves this state: the sidecar is written after the
    // representation and before any prior one is removed. A file gone from
    // under an unchanged live sidecar is damage, so it surfaces as a 500
    // rather than reading as an absent Resource.
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'damaged',
      input: { kind: 'json', contentType: 'application/json', data: { a: 1 } }
    })
    const collectionDir = path.join(
      backend.dataDir,
      'spaces',
      spaceId,
      collectionId
    )
    const representation = (await readdir(collectionDir)).find(name =>
      name.startsWith('r.damaged')
    )
    assert.ok(representation)
    await rm(path.join(collectionDir, representation))
    await assert.rejects(
      backend.getResource({ spaceId, collectionId, resourceId: 'damaged' }),
      (err: unknown) => err instanceof StorageError
    )
    await assert.rejects(
      backend.getResourceMetadata({
        spaceId,
        collectionId,
        resourceId: 'damaged'
      }),
      (err: unknown) => err instanceof StorageError
    )
  })
})

/**
 * A `Readable` over a whole buffer, for the binary write paths.
 * @param buffer {Buffer}
 * @returns {Readable}
 */
function bufferStream(buffer: Buffer): Readable {
  return new Readable({
    read() {
      this.push(buffer)
      this.push(null)
    }
  })
}
