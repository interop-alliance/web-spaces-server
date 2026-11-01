/**
 * Storage layout versioning for the `FileSystemBackend`: an ordered list of
 * migration functions plus the runner that applies them on backend `open()`,
 * mirroring `MIGRATIONS` in `postgresSchema.ts`. The data root's `store.json`
 * records the layout version the directory is at, the store's origin id (see
 * `lib/originId.ts`), and the high-water mark of the store's hybrid logical
 * clock (`clockHighWater`, epoch milliseconds; see `lib/hlc.ts`). It sits
 * beside `spaces/` and `keystores/`, so no Space or Collection id can collide
 * with it.
 *
 * The runner runs inside the server process at startup. It must not run from a
 * Fly `release_command`, since Fly runs that command in a temporary machine
 * that does not mount the app's volume.
 */
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes
} from 'node:fs/promises'
import fs from 'node:fs'
import type { Dirent } from 'node:fs'
import type { FastifyBaseLogger } from 'fastify'
import { isWriteStamp } from '@interop/storage-core'
import {
  ARCHIVE_REVOCATIONS_DIR,
  COLLECTION_FILE_PREFIX,
  COLLECTION_POLICY_FILE_NAME,
  JSON_FILE_SUFFIX,
  SPACE_FILE_PREFIX,
  SPACE_POLICY_FILE_NAME,
  parseChunkDirName,
  parseMetaSidecarFileName,
  parseResourcePolicyFileName,
  spaceMetadataFileName
} from '@interop/space-archive'
import {
  TEMP_FILE_PREFIX,
  atomicCreateFile,
  atomicWriteFile,
  isEnoent,
  readFileIfPresent
} from '../lib/atomicFile.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import { mapInBatches } from '../lib/mapInBatches.js'
import { KeyedMutex } from '../lib/keyedMutex.js'
import { parseSidecarBytes } from '../lib/metaSidecar.js'
import { isValidOriginId, settleOriginId } from '../lib/originId.js'
import {
  StoreLockTimeoutError,
  StoreOriginIdError,
  StoreVersionError
} from '../errors.js'

/**
 * One layout step. A `refuse` step only inspects the store and throws
 * `StoreVersionError` when it holds what the layout has no conversion for; a
 * `convert` step rewrites the store. `run` must be idempotent: a run
 * interrupted before its version stamp is written is repeated in full on the
 * next boot.
 *
 * The runner runs every pending refuse step before any pending convert step
 * writes, so a refusal leaves the store as the earlier release wrote it, and
 * that release boots on it again. A refuse step therefore inspects the store
 * as that release left it, and must tolerate the layout of each convert step
 * pending before it.
 */
export type StoreMigration = {
  kind: 'refuse' | 'convert'
  run: (options: {
    dataDir: string
    logger: FastifyBaseLogger
  }) => Promise<void>
}

/**
 * Ordered layout migrations. Version `n` is `STORE_MIGRATIONS[n - 1]`. New
 * entries are appended. An applied entry is not edited.
 */
export const STORE_MIGRATIONS: StoreMigration[] = [
  // v1: the baseline layout, the one every data dir written before `store.json`
  // existed is already in. An unstamped dir that holds data starts at version
  // 0, so this step is what stamps it; it has nothing to convert.
  { kind: 'convert', run: async () => {} },
  // v2: every versioned record carries a write stamp in place of a version
  // counter. A record written at an earlier layout carries none, and there is
  // no stamping step: a store holding any Space is refused, every boot, until
  // it is wiped or restored from an archive (whose records an import
  // re-stamps). An empty store passes and is stamped at this version.
  { kind: 'refuse', run: refuseUnstampedSpaces },
  // v3: an access-control policy is a versioned record, with a write stamp
  // and a generation, and its delete leaves a tombstone. A policy file
  // written at an earlier layout carries neither, and there is no stamping
  // step: a store holding any policy file is refused, every boot, until it
  // is wiped or restored from an archive (whose policies an import
  // re-stamps). A store with no policy passes and is stamped at this version.
  { kind: 'refuse', run: refuseUnstampedPolicies },
  // v4: a Collection's changes-feed counter holds the positions of its
  // Collection-level records in one `records` map, and a Collection or
  // Resource policy carries its own position in its policy file, so the
  // counter's size does not depend on how many policies the Collection
  // holds. A counter file or a policy file written at an earlier layout
  // places those positions elsewhere, and there is no conversion step: a
  // store holding either is refused, every boot, until it is wiped or
  // restored from an archive (an import assigns fresh positions). A store
  // with neither passes and is stamped at this version.
  { kind: 'refuse', run: refuseFeedCountersWithPolicyPositions },
  // v5: a Resource tombstone is stored under its own name,
  // `.tombstone.<resourceId>.json`, so a directory listing tells it from a
  // live sidecar (`.meta.<resourceId>.json`) by name, and the live Resource
  // count opens no sidecar. A tombstone written at an earlier layout sits
  // under the live sidecar's name, and there is no conversion step: a store
  // holding one is refused, every boot, until it is wiped or restored from
  // an archive (an import writes each tombstone under its own name). A store
  // with none passes and is stamped at this version.
  { kind: 'refuse', run: refuseTombstonesUnderLiveName },
  // v6: a Collection dir may hold a chunk staging directory,
  // `.staging.chunks.<encodedResourceId>/`, beside a Resource's chunk
  // directory: what a pull loop staged for the Resource's chunk set, and the
  // manifest that lets a swap cut short be finished at boot. A store at an
  // earlier layout holds none, so there is nothing to convert. The step
  // exists so that a server built before this layout, which neither
  // reclaims staging nor finishes a torn swap, refuses the store.
  { kind: 'convert', run: async () => {} },
  // v7: a replica registration is a versioned record, with a write stamp on
  // its record file, and `PUT` at its URL replaces it in place. A
  // registration file written at an earlier layout carries no stamp, and
  // there is no stamping step: a store holding one is refused, every boot,
  // until it is wiped or the registration is made again. A store with none
  // passes and is stamped at this version.
  { kind: 'refuse', run: refuseUnstampedReplicas },
  // v8: a Space's zcap revocation records live in the `.revocations/`
  // subdirectory of its Space dir, a reserved Collection id, so the one `rm`
  // of Delete Space removes them with the Space. The step moves each
  // `space-revocations/<spaceId>/` tree of the earlier layout into its Space
  // dir, drops the tree of a Space that is gone (what a Delete Space the
  // earlier layout cut short left), and removes the `space-revocations/`
  // root. It refuses a root holding an entry it does not recognize.
  { kind: 'convert', run: moveSpaceRevocationsIntoSpaceDirs },
  // v9: the Space Metadata file is `.space.meta.<spaceId>.json` and the
  // Collection Metadata file (live in its Collection dir, or a tombstone in
  // the Space dir) is `.collection.meta.<collectionId>.json`, the names of
  // the export archive's dialect, apart from the policy files for every id.
  // A Metadata file written at an earlier layout sits under the old name
  // (`.space.<spaceId>.json`, `.collection.<collectionId>.json`), and there
  // is no conversion step: a store holding one is refused, every boot, until
  // it is wiped or restored from an archive (an import writes the new
  // names). A store with none passes and is stamped at this version.
  { kind: 'refuse', run: refuseMetadataUnderOldNames },
  // v10: every live Resource and chunk sidecar carries `digest`, the content
  // digest of its stored representation, and a Resource tombstone carries the
  // digest of the content it replaced. A live sidecar written at an earlier
  // layout carries none, and there is no digesting step: a store holding one
  // is refused, every boot, until it is wiped or restored from an archive (an
  // import digests each file it writes). A tombstone with no digest is not
  // refused: one holds nothing the write-once rule can compare, so a write
  // over it is an ordinary create. A store with no such sidecar passes and is
  // stamped at this version.
  { kind: 'refuse', run: refuseUndigestedSidecars }
]

/**
 * The file at the data root that records the layout version and the origin id.
 */
export const STORE_FILE_NAME = 'store.json'

/**
 * The parsed contents of `store.json`. `originId` is absent from a file
 * written before the store carried one, and `clockHighWater` from a store
 * whose clock has minted nothing yet. Members this code does not know are
 * kept on every rewrite.
 */
type StoreRecord = {
  version: number
  originId?: string
  clockHighWater?: number
  [member: string]: unknown
}

/**
 * The layout step that refuses a store written before records carried write
 * stamps: any entry under `spaces/` is a Space whose records carry none.
 * Staging temp files left there by a killed process are not Spaces.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseUnstampedSpaces({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  const spaces = (await readDirEntries(spacesDir)).filter(
    entry => !entry.name.startsWith(TEMP_FILE_PREFIX)
  )
  if (spaces.length > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${spaces.length} Space(s) written before records ` +
        'carried write stamps, and there is no stamping migration. Wipe the ' +
        'data directory, or restore each Space from an export archive into ' +
        'an empty store.'
    })
  }
}

/**
 * The layout step that refuses a store holding a live Resource or chunk
 * sidecar with no content digest: a `.meta.<id>.json` file in any Collection
 * dir, or in any chunk dir beneath one, whose body is a JSON object that is
 * not a tombstone and carries no string `digest`. A sidecar that does not
 * parse is not a record, and a tombstone is not read.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseUndigestedSidecars({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  const sidecarPaths: string[] = []
  const collectSidecars = (dir: string, entries: Dirent[]): void => {
    for (const entry of entries) {
      if (
        entry.isFile() &&
        parseMetaSidecarFileName(entry.name) !== undefined
      ) {
        sidecarPaths.push(path.join(dir, entry.name))
      }
    }
  }
  for await (const { collectionDir, children } of collectionDirs(spacesDir)) {
    collectSidecars(collectionDir, children)
    for (const child of children) {
      if (child.isDirectory() && parseChunkDirName(child.name) !== undefined) {
        const chunkDir = path.join(collectionDir, child.name)
        collectSidecars(chunkDir, await readDirEntries(chunkDir))
      }
    }
  }
  const verdicts = await mapInBatches({
    items: sidecarPaths,
    map: lacksDigest
  })
  const undigested = verdicts.filter(Boolean).length
  if (undigested > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${undigested} live Resource or chunk sidecar(s) ` +
        'written before records carried a content digest, and there is no ' +
        'digesting migration. Wipe the data directory, or restore each Space ' +
        'from an export archive into an empty store.'
    })
  }
}

/**
 * Whether a sidecar file's body is a JSON object that is not a tombstone and
 * carries no string `digest`. A file gone since the listing, or one that
 * does not parse, is not one.
 * @param filePath {string}
 * @returns {Promise<boolean>}
 */
async function lacksDigest(filePath: string): Promise<boolean> {
  const bytes = await readFileIfPresent(filePath)
  if (bytes === undefined) {
    return false
  }
  const sidecar = parseSidecarBytes(bytes)
  return (
    sidecar !== undefined &&
    sidecar.deleted !== true &&
    typeof sidecar.digest !== 'string'
  )
}

/**
 * Builds the file name of a Collection's changes-feed counter,
 * `.feed.<collectionId>.json`, a dot-file in the Collection dir holding the
 * counter's generation, the last feed position handed out, and the latest
 * positions of the Collection Metadata object and the governing history log
 * (see `FeedCounter`). A policy keeps its position in its own file, so the
 * counter's size does not depend on how many policies the Collection holds.
 * Local to this backend: it is not an archive entry, and export leaves it
 * out.
 * @param collectionId {string}
 * @returns {string}
 */
export function feedCounterFileName(collectionId: string): string {
  return `.feed.${collectionId}${JSON_FILE_SUFFIX}`
}

/**
 * Whether a Collection dir entry is a policy file: the Collection's own
 * (`.collection.policy.json`) or a Resource's (`.r.<resourceId>.policy.json`).
 * @param fileName {string}
 * @returns {boolean}
 */
export function isPolicyFileName(fileName: string): boolean {
  return (
    fileName === COLLECTION_POLICY_FILE_NAME ||
    parseResourcePolicyFileName(fileName) !== undefined
  )
}

/**
 * Each Space dir under `spacesDir` with its entries, for the layout steps
 * that look for a file kind across every Space. Staging temp files left by a
 * killed process are not Spaces.
 * @param spacesDir {string}
 * @returns {AsyncGenerator<{ spaceDir: string, entries: Dirent[] }>}
 */
async function* spaceDirs(
  spacesDir: string
): AsyncGenerator<{ spaceDir: string; entries: Dirent[] }> {
  for (const space of await readDirEntries(spacesDir)) {
    if (!space.isDirectory() || space.name.startsWith(TEMP_FILE_PREFIX)) {
      continue
    }
    const spaceDir = path.join(spacesDir, space.name)
    yield { spaceDir, entries: await readDirEntries(spaceDir) }
  }
}

/**
 * The layout step that refuses a store holding a policy file written before
 * policies carried write stamps: a Space's `.space.policy.json`, or a
 * Collection's `.collection.policy.json` or `.r.<resourceId>.policy.json`.
 * Staging temp files left by a killed process are not Spaces.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseUnstampedPolicies({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  let count = 0
  for await (const { spaceDir, entries } of spaceDirs(spacesDir)) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name === SPACE_POLICY_FILE_NAME) {
        count++
      } else if (entry.isDirectory()) {
        const collectionEntries = await readDirEntries(
          path.join(spaceDir, entry.name)
        )
        count += collectionEntries.filter(
          child => child.isFile() && isPolicyFileName(child.name)
        ).length
      }
    }
  }
  if (count > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${count} access-control policy file(s) written ` +
        'before policies carried write stamps, and there is no stamping ' +
        'migration. Wipe the data directory, or restore each Space from an ' +
        'export archive into an empty store.'
    })
  }
}

/**
 * The layout step that refuses a store holding a replica registration file
 * (`.replica.<replicaId>.json`, not the `.state.json` beside it) with no write
 * stamp in any Space dir. A file whose JSON does not parse is not a
 * registration here, as it is not one to the listings, which log and skip
 * it; its own read and write still fail on it.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseUnstampedReplicas({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  let count = 0
  for await (const { spaceDir, entries } of spaceDirs(spacesDir)) {
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^\.replica\..+\.json$/.test(entry.name) ||
        entry.name.endsWith('.state.json')
      ) {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(
          await readFile(path.join(spaceDir, entry.name), 'utf8')
        )
      } catch {
        continue
      }
      if (!isWriteStamp(parsed)) {
        count++
      }
    }
  }
  if (count > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${count} replica registration file(s) written ` +
        'before registrations carried write stamps, and there is no stamping ' +
        'migration. Wipe the data directory, or remove the files and make ' +
        'each registration again.'
    })
  }
}

/**
 * The layout step that moves each Space's revocation records from the
 * `space-revocations/<spaceId>/` tree of the earlier layout into the
 * `.revocations/` subdirectory of its Space dir, and removes the
 * `space-revocations/` root. A tree whose Space has no Metadata file is an
 * orphan of a Delete Space the earlier layout cut short, and is dropped. The
 * root holds Space trees and the staging temp files (`TEMP_FILE_PREFIX`) a
 * killed write left, which go with the root; any other entry is refused
 * before anything is moved, since the new layout stores nothing there and
 * the step would otherwise remove it unseen. The step is idempotent: a tree
 * is moved by one `rename`, and a run repeated after a kill finds the moved
 * trees gone from the root. A Space that holds records in both layouts is
 * refused too. A Space dir that cannot be read (a permission fault) fails the
 * step rather than reading as gone, so no live Space loses its records.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<void>}
 */
async function moveSpaceRevocationsIntoSpaceDirs({
  dataDir,
  logger
}: {
  dataDir: string
  logger: FastifyBaseLogger
}): Promise<void> {
  const root = path.join(dataDir, 'space-revocations')
  const spacesDir = path.join(dataDir, 'spaces')
  const entries = await readDirEntries(root)
  const stray = entries.find(
    entry =>
      !entry.isDirectory() &&
      !(entry.isFile() && entry.name.startsWith(TEMP_FILE_PREFIX))
  )
  if (stray !== undefined) {
    throw new StoreVersionError({
      detail:
        `${path.join(root, stray.name)} is neither a Space's revocation ` +
        'directory nor a staging temp file. Move it out of the data dir by ' +
        'hand; the directory is removed by this layout step.'
    })
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const spaceId = entry.name
    const source = path.join(root, spaceId)
    const spaceDir = path.join(spacesDir, spaceId)
    if (
      !(await fileExists(path.join(spaceDir, spaceMetadataFileName(spaceId))))
    ) {
      logger.warn(
        { spaceId },
        'Dropping the revocations of a Space that is gone, left by an interrupted delete'
      )
      await rm(source, { recursive: true, force: true })
      continue
    }
    const target = path.join(spaceDir, ARCHIVE_REVOCATIONS_DIR)
    if (await fileExists(target)) {
      throw new StoreVersionError({
        detail:
          `${target} exists beside ${source}; the revocation records of ` +
          `Space '${spaceId}' are in both layouts. Merge the two directories ` +
          'by hand and remove the old one.'
      })
    }
    await rename(source, target)
  }
  await rm(root, { recursive: true, force: true })
}

/**
 * The prefix a Space Metadata file carried before layout 9 (`.space.`), and
 * the one a Collection Metadata file carried (`.collection.`), each followed
 * by the id and `.json`. Frozen history: the current names insert a `meta.`
 * segment after each.
 */
const OLD_SPACE_FILE_PREFIX = '.space.'
const OLD_COLLECTION_FILE_PREFIX = '.collection.'

/**
 * Whether a file name is a Metadata file under its pre-layout-9 name: the
 * given old prefix, an id, and `.json`. The two policy files, which share the
 * old prefixes, and a file under either current prefix are not.
 * @param fileName {string}
 * @param oldPrefix {string}
 * @returns {boolean}
 */
function isMetadataUnderOldName(fileName: string, oldPrefix: string): boolean {
  return (
    fileName.startsWith(oldPrefix) &&
    fileName.endsWith(JSON_FILE_SUFFIX) &&
    fileName !== SPACE_POLICY_FILE_NAME &&
    fileName !== COLLECTION_POLICY_FILE_NAME &&
    !fileName.startsWith(SPACE_FILE_PREFIX) &&
    !fileName.startsWith(COLLECTION_FILE_PREFIX)
  )
}

/**
 * The layout step that refuses a store holding a Space or Collection Metadata
 * file under its pre-layout-9 name: `.space.<spaceId>.json` in a Space dir,
 * or `.collection.<collectionId>.json` in a Space dir (a tombstone) or a
 * Collection dir (a live Collection). The policy files, which share the old
 * prefixes, are not Metadata files.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseMetadataUnderOldNames({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  let spaceFiles = 0
  let collectionFiles = 0
  for await (const { spaceDir, entries } of spaceDirs(spacesDir)) {
    for (const entry of entries) {
      if (entry.isFile()) {
        if (isMetadataUnderOldName(entry.name, OLD_SPACE_FILE_PREFIX)) {
          spaceFiles++
        } else if (
          isMetadataUnderOldName(entry.name, OLD_COLLECTION_FILE_PREFIX)
        ) {
          collectionFiles++
        }
      } else if (entry.isDirectory() && isCollectionDirName(entry.name)) {
        const children = await readDirEntries(path.join(spaceDir, entry.name))
        collectionFiles += children.filter(
          child =>
            child.isFile() &&
            isMetadataUnderOldName(child.name, OLD_COLLECTION_FILE_PREFIX)
        ).length
      }
    }
  }
  if (spaceFiles > 0 || collectionFiles > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${spaceFiles} Space Metadata file(s) and ` +
        `${collectionFiles} Collection Metadata file(s) under the names ` +
        'written before the `.meta.` segment was added, and there is no ' +
        'conversion migration. Wipe the data directory, or restore each ' +
        'Space from an export archive into an empty store.'
    })
  }
}

/**
 * The layout step that refuses a store holding a changes-feed counter file
 * (`.feed.<collectionId>.json`) or a Collection- or Resource-level policy
 * file (`.collection.policy.json`, `.r.<resourceId>.policy.json`) in any
 * Collection dir. A Space policy takes no feed position, so it passes.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseFeedCountersWithPolicyPositions({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  let counters = 0
  let policies = 0
  for await (const { collectionId, children } of collectionDirs(spacesDir)) {
    const counterFileName = feedCounterFileName(collectionId)
    for (const child of children) {
      if (!child.isFile()) {
        continue
      }
      if (child.name === counterFileName) {
        counters++
      } else if (isPolicyFileName(child.name)) {
        policies++
      }
    }
  }
  if (counters > 0 || policies > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${counters} changes-feed counter file(s) and ` +
        `${policies} Collection or Resource policy file(s) written before ` +
        'policies carried their own feed position, and there is no ' +
        'conversion migration. Wipe the data directory, or restore each ' +
        'Space from an export archive into an empty store.'
    })
  }
}

/**
 * The layout step that refuses a store holding a Resource tombstone under the
 * live sidecar's name: a `.meta.<resourceId>.json` file in any Collection dir
 * whose body carries `deleted: true`. A sidecar that does not parse is not a
 * tombstone, and a chunk dir holds no tombstone, so neither is read as one.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<void>}
 */
async function refuseTombstonesUnderLiveName({
  dataDir
}: {
  dataDir: string
}): Promise<void> {
  const spacesDir = path.join(dataDir, 'spaces')
  const sidecarPaths: string[] = []
  for await (const { collectionDir, children } of collectionDirs(spacesDir)) {
    for (const child of children) {
      if (
        child.isFile() &&
        parseMetaSidecarFileName(child.name) !== undefined
      ) {
        sidecarPaths.push(path.join(collectionDir, child.name))
      }
    }
  }
  // A bounded number of sidecars open at once, across every Collection, so
  // a large store boots without opening every sidecar together or reading
  // them one by one.
  const verdicts = await mapInBatches({
    items: sidecarPaths,
    map: holdsTombstone
  })
  const tombstones = verdicts.filter(Boolean).length
  if (tombstones > 0) {
    throw new StoreVersionError({
      detail:
        `${spacesDir} holds ${tombstones} Resource tombstone(s) written ` +
        'under the live sidecar name before tombstones had their own file ' +
        'name, and there is no conversion migration. Wipe the data ' +
        'directory, or restore each Space from an export archive into an ' +
        'empty store.'
    })
  }
}

/**
 * Whether a sidecar file's body is a JSON object carrying `deleted: true`. A
 * file gone since the listing, or one that does not parse, is not one.
 * @param filePath {string}
 * @returns {Promise<boolean>}
 */
async function holdsTombstone(filePath: string): Promise<boolean> {
  const bytes = await readFileIfPresent(filePath)
  return bytes !== undefined && parseSidecarBytes(bytes)?.deleted === true
}

/**
 * Walks every Collection dir under a store's `spaces` dir, for the layout
 * steps that inspect each one: its id, its path, and its listing. Staging
 * temp files left by a killed process (`TEMP_FILE_PREFIX`) are not Spaces or
 * Collections, a Space's revocation dir is not one either, and neither is any
 * other non-directory entry.
 * @param spacesDir {string}
 * @returns {AsyncGenerator<{ collectionId: string, collectionDir: string,
 *   children: Dirent[] }>}
 */
async function* collectionDirs(spacesDir: string): AsyncGenerator<{
  collectionId: string
  collectionDir: string
  children: Dirent[]
}> {
  for (const space of await readDirEntries(spacesDir)) {
    if (!space.isDirectory() || space.name.startsWith(TEMP_FILE_PREFIX)) {
      continue
    }
    const spaceDir = path.join(spacesDir, space.name)
    for (const collection of await readDirEntries(spaceDir)) {
      if (!collection.isDirectory() || !isCollectionDirName(collection.name)) {
        continue
      }
      const collectionDir = path.join(spaceDir, collection.name)
      yield {
        collectionId: collection.name,
        collectionDir,
        children: await readDirEntries(collectionDir)
      }
    }
  }
}

/**
 * Reads a directory's entries (as `Dirent`s), treating an absent directory as
 * an empty one: `ENOENT` resolves `[]` rather than rejecting, since a
 * directory that was never created simply holds nothing. Any other error is
 * rethrown. Shared by the layout steps here and by the `FileSystemBackend`
 * enumeration paths whose target may legitimately not exist yet (a Collection
 * dir, a chunk dir). It calls `fs.promises.readdir`, looked up at call
 * time, so a test that wraps that method sees every listing made here.
 * @param dir {string}
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
export async function readDirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (isEnoent(err)) {
      return []
    }
    throw err
  }
}

/**
 * Whether a subdirectory of a Space dir is a Collection dir, by its name:
 * every subdirectory but the Space's revocation dir
 * (`ARCHIVE_REVOCATIONS_DIR`) and a staging temp name (`TEMP_FILE_PREFIX`).
 * The one predicate every walk of a Space dir's Collections applies.
 * @param name {string}
 * @returns {boolean}
 */
export function isCollectionDirName(name: string): boolean {
  return !name.startsWith(TEMP_FILE_PREFIX) && name !== ARCHIVE_REVOCATIONS_DIR
}

/**
 * Whether a file or directory exists. `ENOENT` (and `ENOTDIR`, a missing
 * parent) resolve `false`; any other error is rethrown, so an unreadable
 * entry is never taken for an absent one.
 * @param filePath {string}
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw err
  }
}

/**
 * The name prefix of the lock files a runner creates while it reads and
 * advances the version. Each runner creates its own `store.lock.<nonce>`.
 */
const LOCK_FILE_PREFIX = 'store.lock.'

/**
 * Entries that do not make a data dir non-empty, beside the lock and staging
 * temp files `isEmptyDataDir` matches by prefix: `store.json` itself, and the
 * `lost+found` directory an ext4 volume carries at its root (a fresh Fly
 * volume has one).
 */
const IGNORED_ROOT_ENTRIES = new Set([STORE_FILE_NAME, 'lost+found'])

/**
 * How often a runner waiting on the lock checks it again.
 */
const LOCK_POLL_MS = 100

/**
 * How long a runner waits on a lock another live process holds.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How often a holder refreshes its lock file's mtime.
 */
const LOCK_HEARTBEAT_MS = 5 * 1000

/**
 * How long a lock file may go without a heartbeat before it counts as left by
 * a process that is gone, whatever host or process id it names.
 */
const LOCK_STALE_MS = 60 * 1000

/**
 * Serializes the runners in this process per data dir. A lock file naming this
 * process is then never a live one, since no other runner here holds one.
 */
const runnerMutex = new KeyedMutex()

/**
 * Brings the data dir at `dataDir` to the newest layout version: stamps an
 * empty dir at that version, applies each pending migration in order, and
 * rewrites `store.json` after each step. A dir that holds data but no
 * `store.json` predates the stamp and is at the baseline layout, so it starts
 * at version 0 and every step runs over it. Refuses to start
 * (`StoreVersionError`) when `store.json` names a version newer than
 * `migrations` knows. Holds a lock file for the whole run, so two processes
 * sharing the data dir cannot both migrate it.
 *
 * Also settles the store's origin id on every boot, under the same lock. A
 * stored id is kept, and a configured one that differs is refused, as is a
 * malformed stored id (`StoreOriginIdError`). A store with no id takes the
 * configured one, or a minted one, and writes it before any migration step
 * runs, so a run killed after that write keeps the id for the next boot.
 * @param options {object}
 * @param options.dataDir {string}   the backend's data root
 * @param options.logger {FastifyBaseLogger}
 * @param [options.originId] {string}   the configured origin id
 *   (`WAS_ORIGIN_ID`)
 * @param [options.migrations] {StoreMigration[]}   defaults to STORE_MIGRATIONS
 * @param [options.lockTimeoutMs] {number}   how long to wait on a held lock
 * @returns {Promise<{ version: number, originId: string, clockHighWater?: number }>}
 *   the version the data dir is at afterwards, its origin id, and the clock's
 *   persisted high-water mark, when the store has one
 */
export async function applyStoreMigrations({
  dataDir,
  logger,
  originId,
  migrations = STORE_MIGRATIONS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS
}: {
  dataDir: string
  logger: FastifyBaseLogger
  originId?: string
  migrations?: StoreMigration[]
  lockTimeoutMs?: number
}): Promise<{ version: number; originId: string; clockHighWater?: number }> {
  await mkdir(dataDir, { recursive: true })
  return runnerMutex.run(await realpath(dataDir), () =>
    migrateUnderLock({
      dataDir,
      logger,
      configuredOriginId: originId,
      migrations,
      lockTimeoutMs
    })
  )
}

/**
 * The body of `applyStoreMigrations`, run once the in-process mutex is held.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logger {FastifyBaseLogger}
 * @param [options.configuredOriginId] {string}
 * @param options.migrations {StoreMigration[]}
 * @param options.lockTimeoutMs {number}
 * @returns {Promise<{ version: number, originId: string, clockHighWater?: number }>}
 */
async function migrateUnderLock({
  dataDir,
  logger,
  configuredOriginId,
  migrations,
  lockTimeoutMs
}: {
  dataDir: string
  logger: FastifyBaseLogger
  configuredOriginId?: string
  migrations: StoreMigration[]
  lockTimeoutMs: number
}): Promise<{ version: number; originId: string; clockHighWater?: number }> {
  const currentVersion = migrations.length
  const lock = await acquireLock({ dataDir, lockTimeoutMs, logger })
  try {
    let record = await readStoreRecord({ dataDir })
    if (record === undefined) {
      // An empty data dir starts at the current version; one that holds data
      // predates the stamp and is at the baseline layout.
      const empty = await isEmptyDataDir({ dataDir })
      if (!empty) {
        logger.info(
          { dataDir },
          `Data directory holds data but no ${STORE_FILE_NAME}; migrating from the baseline layout`
        )
      }
      record = { version: empty ? currentVersion : 0 }
    }
    if (record.version > currentVersion) {
      throw new StoreVersionError({
        detail:
          `${path.join(dataDir, STORE_FILE_NAME)} names version ${record.version}; ` +
          `this server knows up to version ${currentVersion}.`
      })
    }
    // A malformed configured id is refused here, before anything is written:
    // in `store.json` it would refuse every later boot.
    const originId = settleOriginId({
      stored: record.originId,
      configured: configuredOriginId
    })
    const originIdUnstamped = record.originId === undefined
    record = { ...record, originId }
    // Every pending refuse step first, over the store as the earlier release
    // left it, so a refusal writes nothing and that release boots on the
    // store again. Then the origin id, written before any convert step so a
    // run killed mid-migration keeps it, and the convert steps, each
    // followed by its stamp.
    const pending = []
    for (
      let version = record.version + 1;
      version <= currentVersion;
      version++
    ) {
      pending.push({ version, step: migrations[version - 1]! })
    }
    for (const { version, step } of pending) {
      if (step.kind === 'refuse') {
        logger.info({ version }, 'Checking the filesystem store layout')
        await step.run({ dataDir, logger })
      }
    }
    if (originIdUnstamped) {
      await writeStoreRecord({ dataDir, record })
    }
    for (const { version, step } of pending) {
      if (step.kind === 'convert') {
        logger.info(
          { from: version - 1, to: version },
          'Migrating filesystem store'
        )
        await step.run({ dataDir, logger })
      }
      record = { ...record, version }
      await writeStoreRecord({ dataDir, record })
    }
    const { clockHighWater } = record
    return {
      version: currentVersion,
      originId,
      ...(clockHighWater !== undefined && { clockHighWater })
    }
  } finally {
    await lock.release()
  }
}

/**
 * Reads `store.json` as a whole record, or `undefined` when there is none. A
 * `store.json` that is not a JSON object with a non-negative integer
 * `version` is refused rather than treated as absent, and so is one whose
 * `originId` is present but not a well-formed origin id, or whose
 * `clockHighWater` is present but not a non-negative integer.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<StoreRecord | undefined>}
 */
async function readStoreRecord({
  dataDir
}: {
  dataDir: string
}): Promise<StoreRecord | undefined> {
  const storePath = path.join(dataDir, STORE_FILE_NAME)
  const bytes = await readFileIfPresent(storePath)
  if (bytes === undefined) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    // Reported below with the other malformed shapes.
  }
  const record = isPlainObject(parsed) ? parsed : {}
  const { version, originId, clockHighWater } = record
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new StoreVersionError({
      detail: `${storePath} does not name an integer version.`
    })
  }
  if (
    clockHighWater !== undefined &&
    (!Number.isSafeInteger(clockHighWater) || (clockHighWater as number) < 0)
  ) {
    throw new StoreVersionError({
      detail: `${storePath} names a clockHighWater that is not a non-negative integer.`
    })
  }
  if (originId !== undefined && !isValidOriginId(originId)) {
    throw StoreOriginIdError.malformed({
      id: String(originId),
      where: storePath
    })
  }
  return record as StoreRecord
}

/**
 * Persists a new high-water mark of the store's hybrid logical clock as
 * `store.json`'s `clockHighWater` member, keeping every other member. Run by
 * the backend's clock at runtime, on a cadence (see `lib/hlc.ts`), so it is
 * serialized with the boot runner and with itself through the in-process
 * runner mutex. A mark is only ever raised: a lower `clockHighWater` than the
 * stored one leaves the file as it is.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.clockHighWater {number}   epoch milliseconds
 * @returns {Promise<void>}
 */
export async function writeClockHighWater({
  dataDir,
  clockHighWater
}: {
  dataDir: string
  clockHighWater: number
}): Promise<void> {
  await runnerMutex.run(await realpath(dataDir), async () => {
    const record = await readStoreRecord({ dataDir })
    if (record === undefined) {
      throw new StoreVersionError({
        detail: `${path.join(dataDir, STORE_FILE_NAME)} is missing.`
      })
    }
    if ((record.clockHighWater ?? -1) >= clockHighWater) {
      return
    }
    await writeStoreRecord({ dataDir, record: { ...record, clockHighWater } })
  })
}

/**
 * Rewrites `store.json` with the whole `record` (temp file plus rename). The
 * caller passes the record it read with its own members changed, so the
 * members it does not own, the origin id and the clock's high-water mark
 * among them, are kept.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.record {StoreRecord}
 * @returns {Promise<void>}
 */
async function writeStoreRecord({
  dataDir,
  record
}: {
  dataDir: string
  record: StoreRecord
}): Promise<void> {
  await atomicWriteFile({
    filePath: path.join(dataDir, STORE_FILE_NAME),
    data: JSON.stringify(record) + '\n'
  })
}

/**
 * Whether the data dir holds nothing but entries that carry no data.
 * @param options {object}
 * @param options.dataDir {string}
 * @returns {Promise<boolean>}
 */
async function isEmptyDataDir({
  dataDir
}: {
  dataDir: string
}): Promise<boolean> {
  const entries = await readdir(dataDir)
  return entries.every(
    name =>
      IGNORED_ROOT_ENTRIES.has(name) ||
      name.startsWith(LOCK_FILE_PREFIX) ||
      name.startsWith(TEMP_FILE_PREFIX)
  )
}

/**
 * The contents of a lock file: the process that created it.
 */
type LockHolder = { pid: number; hostname: string }

/**
 * Takes the store lock for `dataDir`. The runner creates its own uniquely
 * named lock file, then lists the others. If another live lock file exists, it
 * removes its own and waits, so of two runners racing, the one that lists last
 * always sees the other's file. Both may back off at once, so the wait is
 * jittered. A stale lock file is ignored and removed. Its name is never reused,
 * so removing it cannot touch a live hold.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.lockTimeoutMs {number}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
async function acquireLock({
  dataDir,
  lockTimeoutMs,
  logger
}: {
  dataDir: string
  lockTimeoutMs: number
  logger: FastifyBaseLogger
}): Promise<{ release: () => Promise<void> }> {
  const lockPath = path.join(dataDir, LOCK_FILE_PREFIX + randomUUID())
  const holder: LockHolder = { pid: process.pid, hostname: os.hostname() }
  const deadline = Date.now() + lockTimeoutMs
  let waitLogged = false
  for (;;) {
    let rivals = await liveLockFiles({ dataDir, logger })
    if (rivals.length === 0) {
      // Staged and linked into place, so a reader never sees a partial lock.
      await atomicCreateFile({
        filePath: lockPath,
        data: JSON.stringify(holder)
      })
      rivals = (await liveLockFiles({ dataDir, logger })).filter(
        rival => rival !== lockPath
      )
      if (rivals.length === 0) {
        return holdLock({ lockPath })
      }
      await unlink(lockPath).catch(() => {})
    }
    if (Date.now() > deadline) {
      throw new StoreLockTimeoutError({ lockPath: rivals[0]! })
    }
    if (!waitLogged) {
      logger.info({ lockPath: rivals[0] }, 'Waiting for the store lock')
      waitLogged = true
    }
    await new Promise(resolve =>
      setTimeout(resolve, LOCK_POLL_MS + Math.random() * LOCK_POLL_MS)
    )
  }
}

/**
 * Starts the heartbeat on a lock file just taken, and returns its release.
 * @param options {object}
 * @param options.lockPath {string}
 * @returns {{ release: () => Promise<void> }}
 */
function holdLock({ lockPath }: { lockPath: string }): {
  release: () => Promise<void>
} {
  const heartbeat = setInterval(() => {
    const now = new Date()
    utimes(lockPath, now, now).catch(() => {})
  }, LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  return {
    async release() {
      clearInterval(heartbeat)
      await unlink(lockPath).catch(() => {})
    }
  }
}

/**
 * Lists the paths of the live lock files in `dataDir`, removing the stale
 * ones it finds (best-effort).
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<string[]>}
 */
async function liveLockFiles({
  dataDir,
  logger
}: {
  dataDir: string
  logger: FastifyBaseLogger
}): Promise<string[]> {
  const live: string[] = []
  for (const name of await readdir(dataDir)) {
    if (!name.startsWith(LOCK_FILE_PREFIX)) {
      continue
    }
    const lockPath = path.join(dataDir, name)
    const judgment = await judgeLockFile({ lockPath })
    if (judgment === 'live') {
      live.push(lockPath)
    } else if (judgment !== 'gone') {
      logger.warn(
        { lockPath, holder: judgment.staleHolder },
        'Removing a stale store lock'
      )
      await unlink(lockPath).catch(() => {})
    }
  }
  return live
}

/**
 * Reads one lock file and judges it. A lock file is stale when its heartbeat
 * stopped, or when it names this host and a process id that is not running or
 * is this process (whose runners the in-process mutex serializes, so none of
 * them holds a lock here). A lock file that does not parse is stale too.
 * @param options {object}
 * @param options.lockPath {string}
 * @returns {Promise<'live' | 'gone' | { staleHolder: LockHolder | string }>}
 *   `'gone'` when the file no longer exists; a stale file carries its holder,
 *   or its text when it does not parse
 */
async function judgeLockFile({
  lockPath
}: {
  lockPath: string
}): Promise<'live' | 'gone' | { staleHolder: LockHolder | string }> {
  let text: string
  let mtimeMs: number
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs
    text = await readFile(lockPath, 'utf8')
  } catch (err) {
    if (isEnoent(err)) {
      return 'gone'
    }
    throw err
  }
  let holder: LockHolder
  try {
    holder = JSON.parse(text)
  } catch {
    return { staleHolder: text }
  }
  if (!Number.isInteger(holder?.pid) || typeof holder.hostname !== 'string') {
    return { staleHolder: text }
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS || isGoneOnThisHost(holder)) {
    return { staleHolder: holder }
  }
  return 'live'
}

/**
 * Whether a lock's holder names this host and a process that is known to be
 * gone: no running process has its id, or its id is this process's.
 * @param holder {LockHolder}
 * @returns {boolean}
 */
function isGoneOnThisHost(holder: LockHolder): boolean {
  if (holder.hostname !== os.hostname()) {
    return false
  }
  if (holder.pid === process.pid || holder.pid <= 0) {
    return true
  }
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
