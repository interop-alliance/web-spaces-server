/**
 * Filesystem persistence backend: stores Spaces, Collections, and Resources as
 * directories and files under `data/spaces/`, and WebKMS keystores under the
 * sibling `data/keystores/` tree. The default (and currently only) adapter
 * implementing the StorageBackend contract documented in types.ts.
 */
import path from 'node:path'
import { mkdir, readFile, rm, stat as fsStat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable, Transform, Writable } from 'node:stream'
import fs from 'node:fs'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { LruCache } from '@interop/lru-memoize'
import { FILESYSTEM_BACKEND_ID } from '../lib/serverBackends.js'
import {
  ResourceImmutableError,
  StorageError,
  ResourceNotFoundError,
  SpaceNotFoundError,
  CollectionNotFoundError,
  QuotaExceededError,
  CountQuotaExceededError,
  PayloadTooLargeError,
  KeystoreStateConflictError,
  KeyIdConflictError,
  DuplicateRevocationError
} from '../errors.js'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_SPACES_PER_CONTROLLER,
  DEFAULT_MAX_COLLECTIONS_PER_SPACE,
  QUOTA_USAGE_CACHE_TTL,
  QUOTA_USAGE_CACHE_MAX,
  normalizeCountLimit,
  normalizeCapacityBytes
} from '../config.default.js'
import {
  assertImportBodiesFit,
  metaSidecarFileId,
  restampImportedLog,
  restoredSpaceMetadata
} from '../lib/importTar.js'
import type { ImportPlan } from '../lib/importTar.js'
import { isJsonContentType, isWriteStamp } from '@interop/storage-core'
import { collectionPath } from '../lib/paths.js'
import {
  encodeFilenameSegment,
  fileNameFor,
  parseResourceFileName,
  chunkDirName,
  CHUNK_DIR_PREFIX,
  parseChunkDirName,
  parseChunkIndexSegment,
  isRepresentationFileName,
  spaceMetadataFileName,
  collectionMetadataFileName,
  COLLECTION_POLICY_FILE_NAME,
  resourcePolicyFileName,
  parseResourcePolicyFileName,
  SPACE_POLICY_FILE_NAME,
  metaSidecarFileName,
  collectionLogFileName,
  ARCHIVE_REVOCATIONS_DIR
} from '@interop/space-archive'
import type { ArchiveEntry } from '@interop/space-archive'
import {
  ARCHIVE_STRIPPED_SIDECAR_MEMBERS,
  newerSidecar,
  parseSidecarBytes,
  restampImportedSidecar,
  serializeSidecarWithout,
  tombstoneSidecarFileId,
  tombstoneSidecarFileName,
  withoutSidecarMembers
} from '../lib/metaSidecar.js'
import type { MetaSidecar } from '../lib/metaSidecar.js'
import {
  contentDigestOf,
  digestTap,
  storedJsonBytes,
  streamDigestOf
} from '../lib/contentDigest.js'
import {
  sanitizeBackendRecord,
  serverBackendDescriptor
} from '../lib/backends.js'
import { archivedSpaceMetadata } from '../lib/spaceProjection.js'
import { packExportArchive } from '../lib/exportArchive.js'
import type { ExportAttestor } from '../lib/exportProvenance.js'
import { backendUsageFieldsFor } from '../lib/backendUsage.js'
import { sameMediaType } from '../lib/mediaType.js'
import { resolveWriteOnce } from '../lib/revisions.js'
import {
  collectionListingItem,
  collectionResourcesList,
  collectionsList,
  suppressesItemNames
} from '../lib/collectionListing.js'
import { revocationFileName } from '../lib/revocations.js'
import {
  collectionTombstoneFile,
  collectionTombstoneSummary,
  isCollectionTombstone
} from '../lib/collectionTombstone.js'
import {
  applyStoreMigrations,
  feedCounterFileName,
  fileExists,
  isCollectionDirName,
  isPolicyFileName,
  readDirEntries,
  writeClockHighWater
} from './filesystemStore.js'
import {
  HybridLogicalClock,
  compareStamps,
  pickStamp,
  stampOf
} from '../lib/hlc.js'
import {
  type ApplyResult,
  type HeldCollection,
  assertReceivableStamps,
  chunkSetQuotaRefusal,
  chunkSetRefusal,
  decideCollectionApply,
  decideCollectionTombstoneApply,
  decideLogApply,
  decideResourceApply,
  guardApply,
  heldCollection,
  isReceivableStamp,
  logForkResult,
  mergeAppliedCollectionMetadata,
  stampWins
} from '../lib/replicaApply.js'
import { WEBVH_LOG_RESOURCE_ID } from '../lib/validateDid.js'
import { isReplicaId } from '../lib/validateId.js'
import { policyGrants } from '../policy.js'
import { KeyedMutex, KeyedReadWriteLock } from '../lib/keyedMutex.js'
import {
  hasCustomMembers,
  normalizeMetadataWrite,
  resolveCollectionMetadataInput,
  restampImportedMetadata,
  stampCollectionMetadata,
  stampSpaceWrite
} from '../lib/metadataWrite.js'
import {
  type EtagValidator,
  type HeldValidators,
  etagOf,
  newGeneration,
  mintValidator,
  resolveGeneration,
  resourceMetaEtagOf,
  validatorOf,
  containerFeedDocument,
  validatorPartsOf
} from '../lib/etag.js'
import {
  type EmbeddedMetadataValidator,
  metadataEtagOf,
  embedMetadataValidator,
  storedMetadataFromFile,
  stripMetadataValidator,
  withoutLocalSegment
} from '../lib/metadataValidator.js'
import {
  atomicWriteFile,
  atomicCreateFile,
  tempPathFor,
  commitTempFile,
  fsyncDirectory,
  sweepTempFiles,
  isEnoent,
  readFileIfPresent,
  unlinkIfPresent
} from '../lib/atomicFile.js'
import {
  clampPageSize,
  compareCodeUnits,
  resolvePageSize,
  seekPage,
  seekStartIndex
} from '../lib/pagination.js'
import {
  runBlindedIndexQuery,
  assertNoUniqueBlindedConflict,
  jsonCandidatesFrom,
  uniqueClaimsOf
} from '../lib/blindedIndex.js'
import type {
  BlindedIndexQuery,
  BlindedIndexQueryPage
} from '../lib/blindedIndex.js'
import {
  runEqualityQuery,
  assertNoUniqueEqualityConflict,
  declaredUniqueIndexesOf,
  findEqualityUniqueViolation
} from '../lib/equalityIndex.js'
import type {
  EqualityQuery,
  EqualityQueryPage,
  EqualityCandidate,
  EqualityValue,
  NormalizedIndexDeclaration
} from '../lib/equalityIndex.js'
import {
  assertWritePrecondition,
  assertMetaWritePrecondition,
  assertCollectionWritePrecondition
} from '../lib/preconditions.js'
import {
  decideReplicaWrite,
  replicaWriteRequestName
} from '../lib/replicaRecord.js'
import {
  type ImportedPolicy,
  archivedPolicyFile,
  livePolicyUnderPrecondition,
  normalizePolicyWrite,
  policyFeedDocument,
  policyFile,
  policyFileFeedPosition,
  policyTombstoneBody,
  priorPolicyParts,
  stampedPolicy,
  storedPolicyFromFile
} from '../lib/policyRecord.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import { parseJsonOrUndefined } from '../lib/jsonBytes.js'
import { mapInBatches } from '../lib/mapInBatches.js'
import {
  collectionLogResultOf,
  mintCollectionLogWrite
} from '../lib/governedLog.js'
import type {
  SpaceMetadata,
  CollectionMetadata,
  CollectionSummary,
  CollectionsList,
  CollectionDeleteOutcome,
  CollectionResourcesList,
  ResourceResult,
  ChunkMetadata,
  ChunkListing,
  ResourceMetadata,
  ResourceMetadataCustom,
  ResourceInput,
  ImportStats,
  PolicyDocument,
  PolicyTombstone,
  PolicyWriteResult,
  StoredPolicy,
  BackendDescriptor,
  BackendUsage,
  CollectionUsage,
  StorageBackend,
  StoredBackendRecord,
  StoredCollectionMetadata,
  StoredCollectionTombstone,
  StoredSpaceMetadata,
  MetadataWriteResult,
  ResourceWriteMembers,
  ResourceMetadataWriteResult,
  ResourceWriteResult,
  CollectionLogResult,
  CollectionMetadataAndLogValidator,
  ImmutableUnder,
  ListedSpaceMetadata,
  MetadataValidatorParts,
  StoredCollectionLog,
  CollectionMetadataInput,
  FeedDocument,
  KeystoreConfig,
  KmsKeyRecord,
  RevocationRecord,
  RevocationScope,
  CapabilitySummary,
  IDID,
  ServiceDescription,
  WriteStamp,
  ResourceMetaStamp,
  ReplicaRegistration,
  ReplicaLoopState,
  StoredReplica,
  ChunkStagingRun,
  StagedChunk
} from '../types.js'

/**
 * What opening one sidecar name found: the parsed body, a body that does
 * not parse, or neither when the file is absent (`#readSidecarName`).
 */
type SidecarNameRead = { sidecar?: MetaSidecar; damage?: SyntaxError }

const execFileAsync = promisify(execFile)

/**
 * The stored form of a container Metadata object (a Space's or a
 * Collection's) whose served form changed through a derived member, with no
 * write of the object: the body and generation are kept, and the local
 * validator segment advances by one.
 * @param prior {T & MetadataValidatorParts}   the object as read under its
 *   Metadata lock
 * @returns {{ body: T, generation: string, local: number }}
 */
function withLocalAdvanced<T extends object>(
  prior: T & MetadataValidatorParts
): { body: T; generation: string; local: number } {
  return {
    body: stripMetadataValidator(prior),
    generation: resolveGeneration(prior.metaGeneration),
    local: (prior.metaLocal ?? 0) + 1
  }
}

/**
 * Reads a file and parses it as JSON, or `undefined` when the read or the
 * parse fails: the content of a stored JSON Resource, where an unreadable or
 * unparsable body counts as no content.
 * @param filePath {string}
 * @returns {Promise<unknown>}
 */
async function readJsonOrUndefined(filePath: string): Promise<unknown> {
  try {
    return parseJsonOrUndefined(await readFile(filePath))
  } catch {
    return undefined
  }
}

/**
 * The names of a directory's subdirectories, in code-unit ascending order
 * (`compareCodeUnits`, the ordering a keyset seek's `>` operator uses;
 * `localeCompare` could disagree with it and break paging). An absent
 * directory holds none.
 * @param dir {string}
 * @returns {Promise<string[]>}
 */
async function subdirectoryNames(dir: string): Promise<string[]> {
  return (await readDirEntries(dir))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort(compareCodeUnits)
}

/**
 * Silent logger used when no logger is passed to `open()`, so the backend
 * stays quiet by default (e.g. in tests).
 */
const silentLogger: FastifyBaseLogger = pino({ level: 'silent' })

/**
 * The records whose latest feed position the counter file holds: those with
 * no file of their own that could carry it. A Resource keeps its position on
 * its sidecar, and a policy in its policy file.
 */
const COUNTER_RECORD_KINDS = ['collection-metadata', 'log'] as const
type CounterRecordKind = (typeof COUNTER_RECORD_KINDS)[number]

/**
 * A Collection's changes-feed counter as read from its counter file: the
 * generation and the last position handed out, plus `records`, the latest
 * position each counter record took. A key is absent until its record took
 * a position.
 */
type FeedCounter = {
  generation?: string
  position: number
  records: Partial<Record<CounterRecordKind, number>>
}

/**
 * The record a feed position is taken for: a Resource, the Collection
 * Metadata object, the governing history log, or a policy (the Collection's
 * own when `resourceId` is absent, else that Resource's).
 */
type FeedRecord =
  | { kind: 'resource' }
  | { kind: CounterRecordKind }
  | { kind: 'policy'; resourceId?: string }

/**
 * The counter file after a write took `feedPosition` for `record`. Only a
 * counter record's position is kept in `records`.
 * @param options {object}
 * @param options.counter {FeedCounter}   the counter before the write
 * @param options.feedPosition {number}   the position taken
 * @param options.record {FeedRecord}
 * @returns {FeedCounter}
 */
function advancedFeedCounter({
  counter,
  feedPosition,
  record
}: {
  counter: FeedCounter
  feedPosition: number
  record: FeedRecord
}): FeedCounter {
  return {
    generation: counter.generation ?? newGeneration(),
    position: feedPosition,
    records:
      record.kind === 'resource' || record.kind === 'policy'
        ? counter.records
        : { ...counter.records, [record.kind]: feedPosition }
  }
}

/**
 * Opens a read stream for a file, resolving once the stream has opened (and
 * rejecting if it errors first). The rejection carries the underlying error as
 * its `cause` and repeats its syscall `code`, so a caller can tell a read that
 * raced a delete (`ENOENT`, a 404) from a genuine storage fault (a 500) without
 * unwrapping.
 * @param filePath {string}
 * @param logger {FastifyBaseLogger}
 * @returns {Promise<import('node:fs').ReadStream>}
 */
async function openFileStream(
  filePath: string,
  logger: FastifyBaseLogger
): Promise<fs.ReadStream> {
  const resourceStream = fs.createReadStream(filePath)
  return new Promise((resolve, reject) => {
    resourceStream
      .on('error', err => {
        const failure: NodeJS.ErrnoException = new Error(
          `Error creating a read stream: ${err}`,
          { cause: err }
        )
        failure.code = (err as NodeJS.ErrnoException).code
        reject(failure)
      })
      .on('open', () => {
        logger.info(`GET -- Reading ${filePath}`)
        resolve(resourceStream)
      })
  })
}

/**
 * The epoch as an `updatedAt` value: the time of a stand-in stamp that sorts
 * below every stamp a clock mints.
 */
const EPOCH_ISO_STRING = new Date(0).toISOString()

/**
 * The options `FileSystemBackend.open()` takes (documented there).
 */
export interface FileSystemBackendOptions {
  dataDir: string
  logger?: FastifyBaseLogger
  originId?: string
  physicalClock?: () => number
  clockBoundMs?: number
  capacityBytes?: number
  maxUploadBytes?: number
  maxSpacesPerController?: number
  maxCollectionsPerSpace?: number
}

/**
 * A representation file of a directory listing, parsed: its
 * `r.<id>.<type>.<ext>` name, and the id and content type the name carries.
 */
type RepresentationEntry = {
  fileName: string
  resourceId: string
  contentType: string
}

/**
 * A live representation: a listed file whose id's sidecar is live and names
 * it as its `fileName`, with that sidecar.
 */
type LiveRepresentation = RepresentationEntry & { sidecar: MetaSidecar }

/**
 * A Resource or chunk as its sidecar records it: the sidecar as read
 * (`prior`), and when it is live, the file it names (`live`).
 */
type LocatedResource = {
  prior?: MetaSidecar
  live?: { sidecar: MetaSidecar; filePath: string }
}

/**
 * The two sidecar members a write records about the file it stored: the
 * file's basename, which a read opens, and the content type its name carries.
 * @param filePath {string}
 * @returns {{ contentType: string, fileName: string }}
 */
function sidecarFileMembers(filePath: string): {
  contentType: string
  fileName: string
} {
  const fileName = path.basename(filePath)
  return { contentType: parseResourceFileName(fileName).contentType, fileName }
}

/**
 * The stored record the write-once rule compares a write with, else
 * `undefined`. Every live Resource or chunk is held: one with no `digest` (a
 * damaged sidecar) is compared through a digest of its stored file, so the
 * rule never lapses over a live record. A Resource tombstone is held when it
 * carries a content digest and a validator. One with no digest (a tombstone an
 * import or a replica apply wrote with no bytes to digest) holds nothing to
 * compare, and one with no validator would leave a repeat over it nothing to
 * answer, so a write over either creates the Resource.
 * @param sidecar {MetaSidecar | undefined}
 * @returns {MetaSidecar | undefined}
 */
function heldForWriteOnce(
  sidecar: MetaSidecar | undefined
): MetaSidecar | undefined {
  if (
    sidecar === undefined ||
    (sidecar.deleted === true &&
      (sidecar.digest === undefined ||
        validatorOf({ ...sidecar }) === undefined))
  ) {
    return undefined
  }
  return sidecar
}

/**
 * Prefix of a Resource's chunk staging directory
 * (`.staging.chunks.<encodedResourceId>/`), beside its chunk directory in the
 * Collection dir: the chunk directory's name (`chunkDirName`) behind
 * `.staging`, so the same id encoding finds both. It holds what a pull loop
 * staged for the Resource's chunk set (see `stageChunk`). A dot-directory
 * that does not start with `CHUNK_DIR_PREFIX`, so the listings, the changes
 * feed and export, which read files and `.chunks.` directories only, never
 * see it, while the `du` of the byte quota counts it.
 */
const STAGING_DIR_LEAD = '.staging'
const STAGING_DIR_PREFIX = `${STAGING_DIR_LEAD}${CHUNK_DIR_PREFIX}`

/**
 * The run manifest's name in a staging run directory.
 */
const STAGING_MANIFEST_FILE_NAME = '.manifest.json'

/**
 * The subdirectories of a staging run directory the swap uses: `next/`
 * holds the chunk directory being built, `prior/` the live chunk directory
 * once it is renamed aside, and `parent/` the parent's representation file
 * until it is moved into the Collection dir. None of them is a chunk file
 * name, so a run directory's listing tells them from the staged chunks.
 */
const STAGING_NEXT_DIR_NAME = 'next'
const STAGING_PRIOR_DIR_NAME = 'prior'
const STAGING_PARENT_DIR_NAME = 'parent'

/**
 * The name of a staging run directory under its registration's directory:
 * the parent's feed `ETag` (the quoted string as served), as the base64url
 * encoding (RFC 4648 section 5, no padding) of its UTF-8 bytes. The quotes
 * and whatever else a source server puts in an `ETag` never meet the
 * filesystem, and the name decodes back to the `ETag`.
 * @param parentEtag {string}
 * @returns {string}
 */
function stagingRunDirName(parentEtag: string): string {
  return Buffer.from(parentEtag, 'utf8').toString('base64url')
}

/**
 * What a staged chunk's sidecar (`.meta.<index>.json` in its run directory)
 * records: the type its file name carries, its size, the source server's
 * `ETag` it was read under (opaque), the staged file's basename, and the
 * content digest of the staged bytes, which the swap records on the live
 * chunk's sidecar. It carries no stamp or generation: the swap mints both.
 */
type StagedChunkSidecar = {
  contentType: string
  size: number
  peerEtag: string
  fileName: string
  digest: string
}

/**
 * A staged chunk sidecar as read, or `undefined` when it is not one (a
 * hand edit or damage, since it is written atomically).
 * @param value {unknown}
 * @returns {StagedChunkSidecar | undefined}
 */
function stagedChunkSidecarOf(value: unknown): StagedChunkSidecar | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const { contentType, size, peerEtag, fileName, digest } = value
  if (
    typeof contentType !== 'string' ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    typeof peerEtag !== 'string' ||
    typeof fileName !== 'string' ||
    path.basename(fileName) !== fileName ||
    !isRepresentationFileName(fileName) ||
    typeof digest !== 'string'
  ) {
    return undefined
  }
  return { contentType, size: size as number, peerEtag, fileName, digest }
}

/**
 * A staging run's manifest (`.manifest.json`), written under the parent's
 * lock once the swap is decided and before anything live changes: the
 * parent revision the run stages for (`parentEtag`), the staged indexes the
 * swap moves in (`staged`), and the parent's sidecar as the swap writes it,
 * less its feed position, naming the representation file staged under
 * `parent/`. Its presence is the swap flag: with it a run cut between the
 * directory swap and the parent's sidecar is finished from the run
 * directory alone, and a run with no manifest changed nothing live and is
 * discarded.
 */
type StagingManifest = {
  parentEtag: string
  staged: number[]
  parent: MetaSidecar
}

/**
 * A staging manifest as read, or `undefined` when it is not one.
 * @param value {unknown}
 * @returns {StagingManifest | undefined}
 */
function stagingManifestOf(value: unknown): StagingManifest | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const { parentEtag, staged, parent } = value
  const isIndexList = (list: unknown): list is number[] =>
    Array.isArray(list) &&
    list.every(
      index =>
        typeof index === 'number' &&
        parseChunkIndexSegment(String(index)) === index
    )
  if (
    typeof parentEtag !== 'string' ||
    !isIndexList(staged) ||
    !isPlainObject(parent) ||
    typeof parent.fileName !== 'string' ||
    path.basename(parent.fileName) !== parent.fileName ||
    !isRepresentationFileName(parent.fileName) ||
    typeof parent.generation !== 'string' ||
    parent.deleted === true
  ) {
    return undefined
  }
  return {
    parentEtag,
    staged,
    parent: parent as unknown as MetaSidecar
  }
}

/**
 * The representation an apply writes: the received input, or, for a history
 * log whose bytes were read for the decision, those bytes from the buffer.
 * @param options {object}
 * @param options.input {ResourceInput}
 * @param [options.log] {{ incoming: Buffer }}
 * @returns {ResourceInput}
 */
function appliedInput({
  input,
  log
}: {
  input: ResourceInput
  log: { incoming: Buffer } | undefined
}): ResourceInput {
  if (log === undefined) {
    return input
  }
  return {
    kind: 'binary',
    contentType: input.contentType,
    stream: Readable.from([log.incoming]),
    declaredBytes: log.incoming.length
  }
}

/**
 * The sidecar members an applied live record carries: the `/meta` record and
 * `custom` as held, which a tombstone has neither of, and the received
 * `epoch` and `writerId`.
 * @param options {object}
 * @param [options.prior] {MetaSidecar}   the held sidecar
 * @param [options.epoch] {string}
 * @param [options.writerId] {string}
 * @returns {Partial<Pick<MetaSidecar, 'meta' | 'custom' | 'epoch' | 'writerId'>>}
 */
function carriedSidecarMembers({
  prior,
  epoch,
  writerId
}: {
  prior: MetaSidecar | undefined
  epoch: string | undefined
  writerId: string | undefined
}): Partial<Pick<MetaSidecar, 'meta' | 'custom' | 'epoch' | 'writerId'>> {
  const heldLive = prior?.deleted === true ? undefined : prior
  return {
    ...(heldLive?.meta !== undefined && { meta: heldLive.meta }),
    ...(heldLive?.custom && { custom: heldLive.custom }),
    ...(epoch !== undefined && { epoch }),
    ...(writerId !== undefined && { writerId })
  }
}

/**
 * The sidecar of a live Resource content record an apply stored, as the
 * origin's write set it: its `createdAt` (the stamp's `updatedAt` when the
 * record carried none), stamp, `createdBy` and generation, the members
 * carried from the held live record (`carriedSidecarMembers`), the file
 * just written with the type its name carries (`sidecarFileMembers`), and
 * the content digest of the bytes written. The plain apply and the chunk
 * swap's manifest both record it.
 * @param options {object}
 * @param options.stamp {WriteStamp}
 * @param options.generation {string}
 * @param [options.createdAt] {string}
 * @param [options.createdBy] {IDID}
 * @param [options.writerId] {string}
 * @param [options.epoch] {string}
 * @param [options.prior] {MetaSidecar}   the held sidecar
 * @param options.filePath {string}   the representation file written
 * @param options.digest {string}   the content digest of the bytes written
 * @returns {MetaSidecar}
 */
function appliedLiveSidecar({
  stamp,
  generation,
  createdAt,
  createdBy,
  writerId,
  epoch,
  prior,
  filePath,
  digest
}: {
  stamp: WriteStamp
  generation: string
  createdAt?: string
  createdBy?: IDID
  writerId?: string
  epoch?: string
  prior?: MetaSidecar
  filePath: string
  digest: string
}): MetaSidecar {
  return {
    createdAt: createdAt ?? stamp.updatedAt,
    ...pickStamp(stamp),
    ...(createdBy !== undefined && { createdBy }),
    generation,
    ...carriedSidecarMembers({ prior, epoch, writerId }),
    digest,
    ...sidecarFileMembers(filePath)
  }
}

/**
 * Whether the parent's held sidecar is the one a staging manifest writes:
 * live, under the manifest's generation and stamp. Then the swap's commit
 * point was reached.
 * @param options {object}
 * @param [options.held] {MetaSidecar}
 * @param options.manifest {StagingManifest}
 * @returns {boolean}
 */
function holdsManifestParent({
  held,
  manifest
}: {
  held?: MetaSidecar
  manifest: StagingManifest
}): boolean {
  return (
    held !== undefined &&
    held.deleted !== true &&
    held.generation === manifest.parent.generation &&
    isReceivableStamp(held) &&
    compareStamps(pickStamp(held), pickStamp(manifest.parent)) === 0
  )
}

/**
 * Removes a directory when it is empty. A directory that holds entries, or
 * is gone, is left as it is.
 * @param dir {string}
 * @returns {Promise<void>}
 */
async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await fs.promises.rmdir(dir)
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
      throw err
    }
  }
}

export class FileSystemBackend implements StorageBackend {
  /**
   * The data root: `spaces/` and `keystores/` sit under it, beside the
   * `store.json` layout version stamp.
   */
  dataDir: string
  spacesDir: string
  /**
   * Root of the WebKMS keystore tree (`data/keystores/<localId>/`), a sibling
   * of `spacesDir` -- the `/kms` facet is deliberately separable from Spaces
   * (own route family, own storage tree).
   */
  keystoresDir: string
  logger: FastifyBaseLogger
  /**
   * Per-Space storage capacity, in bytes (spec "Quotas"). `undefined` means no
   * configured limit -- the backend reports an unlimited quota (state always
   * `ok`) and skips write-path enforcement. A finite value drives the
   * `near-limit` / `over-quota` state thresholds (see `reportUsage`) and is
   * enforced on the write path: `writeResource` and `importSpace` reject writes
   * that would push a Space over capacity with `QuotaExceededError` (507). The
   * constructor normalizes a non-finite ctor option (`Infinity`) to `undefined`.
   */
  capacityBytes?: number
  /**
   * Largest single upload the backend accepts, in bytes (spec "Quotas", the
   * `maxUploadBytes` constraint). `undefined` means no per-upload cap. Distinct
   * from `capacityBytes` (the cumulative per-Space quota): a write larger than
   * this cap is rejected with `PayloadTooLargeError` (413) even when the Space
   * has ample headroom, while smaller writes still succeed. Advertised in quota
   * reports under `constraints.maxUploadBytes` and enforced on `writeResource`.
   * The constructor normalizes an unset ctor option to
   * {@link DEFAULT_MAX_UPLOAD_BYTES} (a default-on cap) and a non-finite option
   * (`Infinity`) to `undefined` (explicitly no cap).
   */
  maxUploadBytes?: number
  /**
   * Max Spaces a single controller may create (spec "Quotas", a default-on
   * count quota). `undefined` means no cap. Enforced on the Space create path
   * (`writeSpace`): a new Space whose `controller` already owns this many
   * Spaces is rejected with `CountQuotaExceededError` (507); overwriting an
   * existing Space never trips it. The constructor normalizes an unset ctor
   * option to {@link DEFAULT_MAX_SPACES_PER_CONTROLLER} and a non-finite option
   * (`Infinity`) to `undefined` (explicitly no cap). Soft under concurrency,
   * like the byte quota.
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (spec "Quotas", a default-on count
   * quota). `undefined` means no cap. Enforced on the Collection create path
   * (`writeCollection`); overwriting an existing Collection's metadata never
   * trips it. Normalized like {@link maxSpacesPerController}.
   */
  maxCollectionsPerSpace?: number

  /**
   * Per-Resource write serialization (the `conditional-writes` feature). A
   * content write or delete that carries a precondition reads the current
   * stamp, evaluates `If-Match` / `If-None-Match`, and writes -- all under
   * this lock, keyed per Resource -- so two concurrent writers cannot both
   * observe the same prior stamp and both succeed. Single-instance only.
   *
   * The same mutex holds other key domains, each namespaced by a prefix:
   * `unique:` (a Collection's unique-claim scan), `feed:` (a Collection's
   * changes-feed counter, see `#takeFeedPosition`), `spacemeta:` and `cmeta:`
   * (the container Metadata objects), `clog:` (a Collection's governing
   * history log), and `policy:` (one access-control policy). Within a
   * Collection a Resource write nests `unique:` key, then the Resource key,
   * then the `feed:` key; a Collection Metadata write nests `cmeta:` then
   * `feed:`; a log write nests `cmeta:`, then `clog:`, then `feed:`; a policy
   * write nests `policy:` then `feed:`. A Resource-level policy write and a
   * Resource delete nest the Resource key, then `policy:`, then `feed:`. No
   * path holds a `cmeta:` or `clog:` key together with a Resource or
   * `unique:` key, and no path takes a Resource key while holding a
   * `policy:` key. The `feed:` key is innermost: nothing is acquired while it
   * is held.
   */
  #writeMutex = new KeyedMutex()

  /**
   * Per-Space gate between the writes that create paths inside a Space and the
   * removals that take a whole container away (`deleteCollection`,
   * `deleteSpace`). Every path-creating write runs on the shared side
   * (`#underSpaceWrite`), concurrently with the others; a removal runs on the
   * exclusive side (`#underSpaceRemoval`), alone. Without it a removal can land
   * between a write's `mkdir` and its file write, leaving the directory
   * recreated behind the delete: a Collection dir holding Resources but no
   * metadata file (listed, unreadable, still counted against the Collection cap
   * and the quota), or a Space dir holding data no route can reach.
   *
   * Lock order, the one this backend uses everywhere: the Space gate is taken
   * FIRST, then any `#writeMutex` key. Nothing acquires the gate while holding
   * a `#writeMutex` key, so the two cannot deadlock against each other.
   * Single-instance only, like `#writeMutex`.
   */
  #spaceGate = new KeyedReadWriteLock()

  /**
   * Runs a write that creates a path inside a Space on the shared side of the
   * Space gate (see `#spaceGate`), so a concurrent container removal cannot
   * land in the middle of it. Shared, so writes to a Space still run
   * concurrently with one another. With `exclusive` the write runs on the
   * exclusive side instead, as a removal does: it is admitted once no write
   * to the Space is in flight, and while it runs none is admitted. A
   * Collection Metadata write takes it, so a composition that scans the
   * Collection's Resources sees every Resource write that landed and none in
   * flight. The gate admits readers ahead of a waiting writer, so like a
   * removal the write is delayed while writes to the Space keep overlapping;
   * each shared section is a single file write, so the queue drains.
   *
   * The gate alone orders a write against a removal. It does not stop a write
   * whose shared acquisition comes after the removal released the exclusive
   * side: the request layer's existence check ran before either, so the write
   * would recreate the removed directory. Passing `container` closes that
   * window. Once the gate is held, the Space must have a Metadata object
   * (`SpaceNotFoundError`, 404), and so must the Collection when
   * `container.collectionId` is given (`CollectionNotFoundError`, 404). No
   * removal can land between that check and the write. Only Update Space,
   * which creates the Space, omits it. The Collection Metadata object the
   * check read is handed to the write, so a Resource write takes the
   * Collection's `unique` index declarations from the record the gate covers
   * rather than from a read made before it.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.container] {object}   the containers that must exist
   * @param [options.container.collectionId] {string}
   * @param [options.container.requestName] {string}   names the refused
   *   operation in the 404
   * @param [options.exclusive] {boolean}   run on the exclusive side
   * @param options.write {(collection?: StoredCollectionMetadata) => Promise<T>}
   *   the write to run under the gate, handed the live Collection Metadata
   *   object when `container.collectionId` is given
   * @returns {Promise<T>}
   */
  async #underSpaceWrite<T>({
    spaceId,
    container,
    exclusive = false,
    write
  }: {
    spaceId: string
    container?: { collectionId?: string; requestName?: string }
    exclusive?: boolean
    write: (collection?: StoredCollectionMetadata) => Promise<T>
  }): Promise<T> {
    const guarded = async (): Promise<T> => {
      if (container) {
        return write(
          await this.#assertContainersExist({ spaceId, ...container })
        )
      }
      return write()
    }
    return exclusive
      ? this.#spaceGate.write(spaceId, guarded)
      : this.#spaceGate.read(spaceId, guarded)
  }

  /**
   * Refuses a write into a container that has no Metadata object: the Space's
   * `.space.meta.<id>.json`, and the Collection's
   * `.collection.meta.<id>.json` when a `collectionId` is given. A tombstoned
   * Collection has no Metadata object.
   * Called under the Space gate (see `#underSpaceWrite`), so the answer holds
   * until the write finishes. Resolves the live Collection Metadata object
   * when a `collectionId` is given.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.requestName] {string}
   * @returns {Promise<StoredCollectionMetadata | undefined>}
   */
  async #assertContainersExist({
    spaceId,
    collectionId,
    requestName
  }: {
    spaceId: string
    collectionId?: string
    requestName?: string
  }): Promise<StoredCollectionMetadata | undefined> {
    if (!(await fileExists(this.#spaceMetadataPath(spaceId)))) {
      throw new SpaceNotFoundError({ requestName })
    }
    if (collectionId === undefined) {
      return undefined
    }
    const collection = await this.#readLiveCollection({ spaceId, collectionId })
    if (!collection) {
      throw new CollectionNotFoundError({ requestName })
    }
    return collection
  }

  /**
   * Runs a container removal (a Collection or Space delete) on the exclusive
   * side of the Space gate (see `#spaceGate`), so every write to that Space in
   * flight has finished and none starts until the removal is done.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.remove {() => Promise<T>}   the removal to run under the gate
   * @returns {Promise<T>}
   */
  async #underSpaceRemoval<T>({
    spaceId,
    remove
  }: {
    spaceId: string
    remove: () => Promise<T>
  }): Promise<T> {
    return this.#spaceGate.write(spaceId, remove)
  }

  /**
   * Per-Space usage totals for the write-path quota pre-flight, so
   * `#assertSpaceHeadroom` does not spawn `du` (a whole-Space tree walk) on
   * every resource write. One `LruCache` entry per Space, keyed by `spaceId`:
   * `memoize` shares one running measurement among callers that find the
   * entry absent or expired at the same time, and evicts a rejected
   * measurement rather than caching it. Each accepted write adds its incoming
   * bytes to the cached total; deletes invalidate the Space's entry
   * (`#dropUsageCache`). Quota reports (`reportUsage`) always re-measure.
   * Single-instance only, like `#writeMutex`: the write stamps and the policy
   * / Space Metadata caches rest on the same assumption.
   *
   * The TTL counts from when a measurement starts, and the cache holds at
   * most `QUOTA_USAGE_CACHE_MAX` Spaces. Both are accepted for this backend,
   * whose purpose is a storage layout a developer can read, not throughput.
   * A Space whose `du` takes close to the TTL gets few or no cache hits, and a
   * measurement still running when its entry expires can be joined by a
   * second one. The quota is a soft limit either way.
   */
  #usageCache = new LruCache({
    max: QUOTA_USAGE_CACHE_MAX,
    ttl: QUOTA_USAGE_CACHE_TTL
  })

  /**
   * The sidecars `readMetaSidecar` resolved from both names, a live sidecar
   * and a tombstone of one id. A write that read one of them under the
   * Resource lock hands it back as `prior`, and `#writeFeedSidecar` then
   * removes the name it does not write. Held weakly, so nothing outlives the
   * read that made it.
   */
  #bothNamesRead = new WeakSet<MetaSidecar>()

  /**
   * The quota credit of each open chunk staging run, by run directory: the
   * sizes of the parent's live chunks as `beginChunkStaging` read them, and
   * the indexes the run has staged since (`#stagingCredit`). In memory
   * only, as staging is: every run is reclaimed at the next open.
   */
  #stagingCredits = new Map<
    string,
    { liveSizes: Map<number, number>; credited: Set<number> }
  >()

  /**
   * Forgets the quota credit of every staging run under a directory, after
   * a delete removed the directory: a Resource's staging directory, a
   * Collection dir or a Space dir. A credit kept past its run would stand
   * in for live chunks the delete removed, and the map would grow by one
   * entry per deleted run for the life of the process.
   * @param options {object}
   * @param options.under {string}   the removed directory
   * @returns {void}
   */
  #forgetStagingCredits({ under }: { under: string }): void {
    const prefix = under + path.sep
    for (const runDir of this.#stagingCredits.keys()) {
      if (runDir.startsWith(prefix)) {
        this.#stagingCredits.delete(runDir)
      }
    }
  }

  /**
   * Drops a Space's cached usage total (`#usageCache`) after bytes were
   * freed, so the next write re-measures. A measurement already running is
   * forgotten too: it may have read the tree before the change, so it no
   * longer fills the cache, and the next write starts a fresh one.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {void}
   */
  #dropUsageCache({ spaceId }: { spaceId: string }): void {
    this.#usageCache.delete(spaceId)
  }

  /**
   * The store's origin id, settled by `open()` (see `filesystemStore.ts`).
   * Assigned before the factory returns, so no caller can read it unset.
   */
  #originId!: string

  /**
   * The store's hybrid logical clock, which mints the write stamp of every
   * versioned record inside the write's critical section (see `lib/hlc.ts`).
   * Built by `open()` once the origin id is settled, and seeded from the
   * high-water mark `store.json` carries.
   */
  #clock!: HybridLogicalClock

  /**
   * The store's hybrid logical clock (see `#clock`).
   * @returns {HybridLogicalClock}
   */
  get clock(): HybridLogicalClock {
    return this.#clock
  }

  /**
   * The store's origin id (see `StorageBackend.originId`).
   * @returns {string}
   */
  get originId(): string {
    return this.#originId
  }

  /**
   * Opens a filesystem backend over `dataDir`: brings the data dir to the
   * current storage layout version and settles the store's origin id (see
   * `filesystemStore.ts`), then removes the staging temp files a killed
   * process left behind at the data root and under the Space and keystore
   * trees. Only temp files untouched for an hour are removed, since
   * another process sharing the data directory may still be writing a fresher
   * one. A failure to read or remove an entry is logged and does not stop the
   * open. The constructor is protected, so this is the only way to obtain a
   * backend, and the backend it resolves already carries its origin id.
   * @param options {object}
   * @param options.dataDir {string}   the data root
   * @param [options.logger] {FastifyBaseLogger}
   * @param [options.originId] {string}   the configured origin id
   *   (`WAS_ORIGIN_ID`); refused when it differs from the stored id, and
   *   written when the store carries none
   * @param [options.physicalClock] {() => number}   the physical clock the
   *   store's hybrid logical clock reads, epoch milliseconds; defaults to
   *   `Date.now` (a test freezes or steps it)
   * @param [options.clockBoundMs] {number}   the clock bound for a received
   *   stamp (`WAS_REPLICATION_CLOCK_BOUND_MS`); defaults to
   *   `REPLICATION_CLOCK_BOUND_MS`
   * @param [options.capacityBytes] {number}
   * @param [options.maxUploadBytes] {number}
   * @param [options.maxSpacesPerController] {number}
   * @param [options.maxCollectionsPerSpace] {number}
   * @returns {Promise<FileSystemBackend>}   an instance of the class `open()`
   *   was called on, so a subclass gets its own type back
   */
  static async open<T extends FileSystemBackend>(
    this: { prototype: T },
    options: FileSystemBackendOptions
  ): Promise<T> {
    // `this` is the class the call was made on. Its constructor is protected,
    // so the `this` parameter cannot be typed as a constructor.
    const backend = new (this as unknown as typeof FileSystemBackend)(options)
    await backend.#open({
      configuredOriginId: options.originId,
      physicalClock: options.physicalClock,
      clockBoundMs: options.clockBoundMs
    })
    return backend as T
  }

  protected constructor({
    dataDir,
    logger,
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace
  }: FileSystemBackendOptions) {
    this.dataDir = dataDir
    this.spacesDir = path.join(dataDir, 'spaces')
    this.keystoresDir = path.join(dataDir, 'keystores')
    this.logger = logger ?? silentLogger
    this.capacityBytes = normalizeCapacityBytes(capacityBytes)
    // Normalize the per-upload cap so every downstream guard keeps its plain
    // `!== undefined` test: an unset option applies the default-on cap; a
    // non-finite option (`Infinity`) means explicitly no cap (the streaming
    // write path this backend uses makes an unbounded upload safe).
    this.maxUploadBytes = normalizeCountLimit(
      maxUploadBytes,
      DEFAULT_MAX_UPLOAD_BYTES
    )
    // Count quotas normalize like `maxUploadBytes`: an unset option applies the
    // default-on limit, a non-finite option (`Infinity`) means explicitly no
    // cap, so every guard keeps its plain `!== undefined` test.
    this.maxSpacesPerController = normalizeCountLimit(
      maxSpacesPerController,
      DEFAULT_MAX_SPACES_PER_CONTROLLER
    )
    this.maxCollectionsPerSpace = normalizeCountLimit(
      maxCollectionsPerSpace,
      DEFAULT_MAX_COLLECTIONS_PER_SPACE
    )
  }

  /**
   * The work `open()` runs on a freshly constructed backend: the store
   * migrations, the origin id, the clock, the temp-file sweep, the finish of
   * interrupted Collection deletes, and the reclaim of chunk staging
   * (`#reclaimStagingAtBoot`).
   * @param options {object}
   * @param [options.configuredOriginId] {string}   the configured origin id
   *   (`WAS_ORIGIN_ID`); `undefined` reads the store's own id, or mints one
   * @param [options.physicalClock] {() => number}
   * @param [options.clockBoundMs] {number}
   * @returns {Promise<void>}
   */
  async #open({
    configuredOriginId,
    physicalClock,
    clockBoundMs
  }: {
    configuredOriginId?: string
    physicalClock?: () => number
    clockBoundMs?: number
  }): Promise<void> {
    const {
      version: storeVersion,
      originId,
      clockHighWater
    } = await applyStoreMigrations({
      dataDir: this.dataDir,
      logger: this.logger,
      originId: configuredOriginId
    })
    this.#originId = originId
    // Seeded from the persisted mark, which can trail the last stamp minted
    // before a crash by up to a second; it persists a new mark as it advances.
    this.#clock = new HybridLogicalClock({
      originId,
      physicalClock,
      bound: clockBoundMs,
      highWater: clockHighWater,
      persistHighWater: ms =>
        writeClockHighWater({ dataDir: this.dataDir, clockHighWater: ms }),
      getLogger: () => this.logger
    })
    this.logger.info({ storeVersion, originId }, 'Filesystem store ready')
    // The data root's own temp files (a `store.json` rewrite or a lock file's
    // staging), without descending into `lost+found` and the trees below.
    // That sweep and the three trees' sweeps touch disjoint files, so they
    // run in parallel.
    const removedPerRoot = await Promise.all([
      sweepTempFiles({
        root: this.dataDir,
        logger: this.logger,
        recursive: false
      }),
      ...[this.spacesDir, this.keystoresDir].map(root =>
        sweepTempFiles({ root, logger: this.logger })
      )
    ])
    const removed = removedPerRoot.reduce((sum, count) => sum + count, 0)
    if (removed > 0) {
      this.logger.warn(
        { removed },
        'Removed temp files left by writes interrupted by a previous shutdown'
      )
    }
    const finished = await this.#finishInterruptedCascades()
    if (finished > 0) {
      this.logger.warn(
        { finished },
        'Finished Collection deletes interrupted by a previous shutdown'
      )
    }
    // After the cascades, which remove a deleted Collection's staging with
    // its other members.
    const staging = await this.#reclaimStagingAtBoot()
    if (staging.finished + staging.removed + staging.stranded > 0) {
      this.logger.warn(
        staging,
        'Reclaimed chunk staging and chunk directories left by a previous shutdown'
      )
    }
  }

  /**
   * Finishes, at boot, every Collection delete a previous process left
   * unfinished: a Collection dir whose Metadata file is a tombstone but which
   * still holds other entries. No request is in flight yet, so no gate is
   * taken. A failure on one Collection is logged and does not stop the open;
   * the next touch of that Collection finishes it.
   * @returns {Promise<number>}   how many Collections were finished
   */
  async #finishInterruptedCascades(): Promise<number> {
    let finished = 0
    for (const spaceEntry of await readDirEntries(this.spacesDir)) {
      if (!spaceEntry.isDirectory()) {
        continue
      }
      const spaceId = spaceEntry.name
      const collectionIds = await this.#collectionIds({ spaceId })
      // Each Collection is independent, so they are checked in batches.
      const outcomes = await mapInBatches({
        items: collectionIds,
        map: async collectionId => {
          try {
            if (await this.#hasInterruptedDelete({ spaceId, collectionId })) {
              await this.#removeCollectionMembers({ spaceId, collectionId })
              return true
            }
          } catch (err) {
            this.logger.warn(
              { err, spaceId, collectionId },
              'Could not finish an interrupted Collection delete at boot'
            )
          }
          return false
        }
      })
      finished += outcomes.filter(Boolean).length
    }
    return finished
  }

  /**
   * Persists the clock's high-water mark at shutdown, so the clock seeded
   * from it at the next boot starts above every stamp this process minted.
   * Wired to the Fastify `onClose` hook by the plugin composition. A failed
   * write is logged at `warn` by the clock and not thrown.
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await this.#clock?.persistCurrentMark()
  }

  /**
   * Self-description advertised at `GET /space/:spaceId/backends`. The
   * filesystem backend is the single server-configured default: it stores both
   * JSON documents and binary blobs on disk, so its data survives restarts.
   *
   * The descriptor advertises no affordances. Every guarantee a Collection
   * needs holds here unconditionally, because the server mediates every write:
   * it serializes writes under its own per-record lock and mints its own opaque
   * validator over a filesystem that offers no precondition primitive of its
   * own (a content hash would serve as well as the write stamp used here).
   * @returns {Required<Omit<BackendDescriptor, 'provider' | 'connection'>>}
   */
  describe(): Required<Omit<BackendDescriptor, 'provider' | 'connection'>> {
    return serverBackendDescriptor({
      id: FILESYSTEM_BACKEND_ID,
      name: 'Server Filesystem'
    })
  }

  /**
   * Measures disk usage under the Space dir with `du`, returning the grand total
   * and a per-Collection breakdown in one pass. `du -d 1 -B 1` (GNU coreutils)
   * reports each immediate subdirectory (one per Collection) plus the Space dir
   * itself (the total, which also covers top-level Space files such as the
   * `.space.meta.` / policy documents and the Space's revocation records under
   * `ARCHIVE_REVOCATIONS_DIR`, which is no Collection), all in bytes. An
   * absent Space dir (ENOENT before the dir is provisioned) reports zero usage
   * rather than throwing.
   * @param spaceDir {string}
   * @returns {Promise<{ total: number, byCollection: CollectionUsage[] }>}
   */
  async #diskUsage(
    spaceDir: string
  ): Promise<{ total: number; byCollection: CollectionUsage[] }> {
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('du', [
        '-d',
        '1',
        '-B',
        '1',
        spaceDir
      ]))
    } catch (err) {
      // `du` exits non-zero (with an ENOENT-style stderr) when the dir is
      // absent; treat that as zero usage. Anything else is a real failure.
      if (
        isEnoent(err) ||
        /No such file or directory/.test((err as Error).message)
      ) {
        return { total: 0, byCollection: [] }
      }
      throw new StorageError({ cause: err as Error })
    }

    const rootResolved = path.resolve(spaceDir)
    let total = 0
    const byCollection: CollectionUsage[] = []
    for (const line of stdout.split('\n')) {
      if (!line) {
        continue
      }
      const tab = line.indexOf('\t')
      const usageBytes = Number(line.slice(0, tab))
      const entryPath = line.slice(tab + 1)
      if (path.resolve(entryPath) === rootResolved) {
        // The summary line for the Space dir itself is the grand total.
        total = usageBytes
      } else if (path.basename(entryPath) !== ARCHIVE_REVOCATIONS_DIR) {
        // Every other immediate subdirectory is a Collection (see
        // `listCollections`).
        byCollection.push({ id: path.basename(entryPath), usageBytes })
      }
    }
    byCollection.sort((a, b) => a.id.localeCompare(b.id))
    return { total, byCollection }
  }

  /**
   * Measures the bytes this Space consumes on disk for the Space Quota report
   * (spec "Quotas"). `usageBytes` is the `du` total under the Space dir
   * (Collection dirs, top-level Space files and the revocation records);
   * `usageByCollection` breaks the per-Collection totals out (they sum to
   * slightly less than `usageBytes`, since the Space-level files and the
   * revocation records belong to no Collection).
   *
   * The per-Collection `usageByCollection` breakdown is included only when
   * `includeCollections` is set -- the spec's `?include=collections` opt-in (see
   * the `quotas` handler, which now tolerates the query string via the
   * `allowTargetQuery` ZCap path). On the filesystem the breakdown is free (the
   * one `du -d 1` pass yields it alongside the total), but it is still omitted by
   * default to keep the hot-path payload lean and match the wire contract.
   *
   * `state` / `restrictedActions` derive from usage vs `capacityBytes`: an
   * unlimited backend is always `ok`; a finite capacity yields `near-limit` at
   * `QUOTA_NEAR_LIMIT_FRACTION` of capacity and `over-quota` (with reads/deletes
   * still allowed, but `POST`/`PUT` restricted) at or above full.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.includeCollections] {boolean}   include the per-Collection
   *   breakdown (spec `?include=collections`)
   * @returns {Promise<BackendUsage>}
   */
  async reportUsage({
    spaceId,
    includeCollections = false
  }: {
    spaceId: string
    includeCollections?: boolean
  }): Promise<BackendUsage> {
    const spaceDir = this.#spaceDir(spaceId)
    const measuredAt = new Date().toISOString()

    const { total: usageBytes, byCollection } = await this.#diskUsage(spaceDir)
    // A tombstoned Collection reads as absent, so the breakdown leaves it
    // out. Its few bytes still count toward the Space total.
    let usageByCollection: CollectionUsage[] | undefined
    if (includeCollections) {
      const liveIds = new Set(await this.#liveCollectionIds({ spaceId }))
      usageByCollection = byCollection.filter(entry => liveIds.has(entry.id))
    }

    return {
      ...backendUsageFieldsFor({
        backend: this,
        usageBytes,
        spaceTotalBytes: usageBytes
      }),
      measuredAt,
      ...(usageByCollection !== undefined && { usageByCollection })
    }
  }

  /**
   * Measures the bytes a single Collection consumes on disk for the
   * per-Collection Quota report (spec "Quotas", `GET /space/{id}/{cid}/quota`).
   * `usageBytes` is scoped to the Collection (its slice of the one-pass
   * `#diskUsage` breakdown; zero if the Collection dir is empty or absent),
   * while `state` / `limit` / `restrictedActions` describe the backend's overall
   * condition (derived from the Space total -- the quota is a per-backend limit,
   * not per-Collection). The per-Collection `usageByCollection` breakdown is
   * omitted (a single Collection is the whole report).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<BackendUsage>}
   */
  async reportCollectionUsage({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<BackendUsage> {
    const spaceDir = this.#spaceDir(spaceId)
    const measuredAt = new Date().toISOString()

    const { total: spaceTotalBytes, byCollection } =
      await this.#diskUsage(spaceDir)
    const usageBytes =
      byCollection.find(entry => entry.id === collectionId)?.usageBytes ?? 0

    return {
      ...backendUsageFieldsFor({ backend: this, usageBytes, spaceTotalBytes }),
      measuredAt
    }
  }

  /**
   * Quota pre-flight for the write path (spec "Quotas"): measures the Space's
   * current on-disk usage and returns the remaining headroom in bytes against
   * `capacityBytes`. Throws `QuotaExceededError` (507) when the Space is already
   * at or over capacity, or when a known `incomingBytes` would not fit. Callers
   * pass the configured `capacityBytes` explicitly (an unlimited backend skips
   * enforcement entirely and never calls this).
   *
   * This is a soft limit under concurrency: two simultaneous writes can each pass
   * against the same usage snapshot and jointly overshoot. The per-write
   * streaming guard (`#byteLimitGuard`) still bounds each individual write.
   *
   * The `du` measurement (a whole-Space tree walk) is cached per Space for
   * `QUOTA_USAGE_CACHE_TTL` ms (see `#usageCache`): between re-measurements
   * each accepted write's `incomingBytes` is added to the cached total, so a
   * burst of writes costs one tree walk, not one per write.
   *
   * A write that fails after passing this check calls the returned `release`
   * to give its reservation back; otherwise the phantom bytes would keep
   * refusing valid writes until the snapshot expires. A write whose size is not
   * known up front (a streamed body with no `Content-Length`) reserves nothing
   * and calls `reconcile` with the bytes it actually wrote, so the snapshot
   * reflects it -- without that, every streamed write inside one TTL would be
   * admitted against the same total and the Space would sail past capacity.
   *
   * One measurement runs per Space at a time: `LruCache.memoize` shares one
   * running measurement among callers that find the entry absent or expired
   * at the same time, so a burst of writes after the entry expires costs one
   * tree walk. Every caller then reserves against the same entry. The entry's
   * TTL runs from the moment the measurement starts, so a `du` that outlives
   * `QUOTA_USAGE_CACHE_TTL` is not shared with the writes that arrive after
   * it expires; each of those starts its own. The TTL is long enough that
   * this is an accepted difference, not a thundering herd.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.capacityBytes {number}   the configured per-Space limit
   * @param [options.incomingBytes] {number}   known size of the pending write
   * @param [options.creditBytes] {number}   bytes a later step of the write
   *   frees (a staged chunk's live counterpart, which the swap replaces),
   *   added to the headroom
   * @returns {Promise<{ headroom: number, release: () => void,
   *   reconcile: (actualBytes: number) => void }>}   remaining headroom in
   *   bytes, the callback that undoes this write's reservation, and the
   *   callback that corrects it to the bytes actually written
   */
  /**
   * A Space's usage total from `#usageCache`, measured (`#diskUsage`) when
   * the cache holds none. The entry is the snapshot a reservation adjusts.
   * @param spaceId {string}
   * @returns {Promise<{ used: number }>}
   */
  async #cachedUsage(spaceId: string): Promise<{ used: number }> {
    return this.#usageCache.memoize<{ used: number }>({
      key: spaceId,
      fn: () =>
        this.#diskUsage(this.#spaceDir(spaceId)).then(({ total }) => ({
          used: total
        }))
    })
  }

  async #assertSpaceHeadroom({
    spaceId,
    capacityBytes,
    incomingBytes = 0,
    creditBytes = 0
  }: {
    spaceId: string
    capacityBytes: number
    incomingBytes?: number
    creditBytes?: number
  }): Promise<{
    headroom: number
    release: () => void
    reconcile: (actualBytes: number) => void
  }> {
    const cached = await this.#cachedUsage(spaceId)
    const headroom = capacityBytes - cached.used + creditBytes
    if (headroom <= 0 || incomingBytes > headroom) {
      throw new QuotaExceededError({ spaceId, capacityBytes })
    }
    cached.used += incomingBytes
    // What this reservation currently holds in the snapshot. `reconcile` moves
    // it to the amount actually consumed, so `release` always gives back what
    // is really held rather than the original estimate.
    let held = incomingBytes
    // Adjusting a snapshot the cache has since replaced, dropped, expired or
    // evicted is harmless: nothing reads it again, and the next measurement
    // reads the write's real outcome from disk.
    const adjust = (actualBytes: number): void => {
      cached.used += actualBytes - held
      held = actualBytes
    }
    return {
      headroom,
      release: () => adjust(0),
      reconcile: adjust
    }
  }

  /**
   * Pre-flight per-upload size cap (413 `PayloadTooLargeError`): rejects a body
   * whose known size exceeds the configured `maxUploadBytes`. A no-op when the
   * backend sets no cap, or when the size is not known up front (a streamed body
   * without `Content-Length` -- `#byteLimitGuard` catches that one mid-stream).
   * Shared by every write path that admits bytes: the JSON and blob Resource
   * writes and the import pre-flight.
   * @param options {object}
   * @param [options.maxUploadBytes] {number}   the per-upload cap in bytes
   * @param [options.uploadBytes] {number}   the known size of the pending body
   * @returns {void}
   */
  #assertUploadSize({
    maxUploadBytes,
    uploadBytes
  }: {
    maxUploadBytes?: number
    uploadBytes?: number
  }): void {
    if (
      maxUploadBytes !== undefined &&
      uploadBytes !== undefined &&
      uploadBytes > maxUploadBytes
    ) {
      throw new PayloadTooLargeError({
        maxUploadBytes,
        backendId: this.describe().id,
        uploadBytes
      })
    }
  }

  /**
   * A pass-through `Transform` that counts the bytes flowing through it and
   * aborts the pipeline with `error` once the cumulative total would exceed
   * `limitBytes`. Hard-caps a streamed write whose size is not known up front
   * (so the pre-flight check alone cannot catch it), e.g. a multipart upload or
   * a body without `Content-Length`. The caller supplies the error the overflow
   * surfaces, so the same counter serves both limits: `PayloadTooLargeError`
   * (413) for the per-upload cap and `QuotaExceededError` (507) for the
   * remaining Space headroom.
   * @param options {object}
   * @param options.limitBytes {number}   max bytes this write may add
   * @param options.error {Error}   aborts the pipeline once the limit is passed
   * @returns {Transform}
   */
  #byteLimitGuard({
    limitBytes,
    error
  }: {
    limitBytes: number
    error: Error
  }): Transform {
    let written = 0
    return new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length
        if (written > limitBytes) {
          callback(error)
          return
        }
        callback(null, chunk)
      }
    })
  }

  /**
   * Defense in depth: asserts that a built path stays within the given storage
   * root (`spacesDir` by default; `keystoresDir` for the keystore tree), so a
   * malformed id that somehow slips past request-layer validation can never
   * escape it (path traversal). The request and tar-import layers reject such
   * ids first; this is the last line of defense.
   * @param targetPath {string}
   * @param [rootDir] {string}   the containing root; defaults to `spacesDir`
   * @returns {void}
   */
  #assertContained(targetPath: string, rootDir: string = this.spacesDir): void {
    const root = path.resolve(rootDir)
    const resolved = path.resolve(targetPath)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new StorageError({
        cause: new Error(
          `Resolved path "${resolved}" escapes the storage root.`
        )
      })
    }
  }

  /**
   * Joins path segments and asserts the result stays within `spacesDir`
   * (`#assertContained`): the shape of every path builder under the Spaces
   * tree.
   * @param segments {string[]}
   * @returns {string}
   */
  #containedJoin(...segments: string[]): string {
    const joined = path.join(...segments)
    this.#assertContained(joined)
    return joined
  }

  #spaceDir(spaceId: string): string {
    return this.#containedJoin(this.spacesDir, spaceId)
  }

  /**
   * The directory holding one Space's zcap revocation records, the
   * `ARCHIVE_REVOCATIONS_DIR` subdirectory of its Space dir
   * (`spaces/<spaceId>/.revocations/<file>.json`), the name the export
   * archive gives the same directory. It sits inside the Space dir so the one
   * `rm` of Delete Space removes the Space and its revocations together. The
   * name is a reserved Collection id (`RESERVED_COLLECTION_IDS`), so no
   * Collection dir can take it, and the Collection listing and the cascade
   * sweeps skip it by name; its bytes count toward the Space's usage.
   * @param spaceId {string}
   * @returns {string}
   */
  #spaceRevocationDir(spaceId: string): string {
    return path.join(this.#spaceDir(spaceId), ARCHIVE_REVOCATIONS_DIR)
  }

  /**
   * The ids of the Collection dirs under a Space dir, in code-unit order
   * (`subdirectoryNames`): every subdirectory `isCollectionDirName` admits.
   * An absent Space dir holds none.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string[]>}
   */
  async #collectionIds({ spaceId }: { spaceId: string }): Promise<string[]> {
    return (await subdirectoryNames(this.#spaceDir(spaceId))).filter(
      isCollectionDirName
    )
  }

  #collectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return this.#containedJoin(this.#spaceDir(spaceId), collectionId)
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string>} Created space storage directory path.
   */
  async #ensureSpaceDir({ spaceId }: { spaceId: string }): Promise<string> {
    const spaceDir = this.#spaceDir(spaceId)
    // Ensure the parent spaces/ directory exists (the dataDir may be brand new,
    // e.g. a per-suite temp dir); the space dir itself is created non-recursively
    // below so its EEXIST case can be detected.
    await mkdir(this.spacesDir, { recursive: true })
    try {
      await mkdir(spaceDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.info(`Space "${spaceId}" already exists, overwriting.`)
      } else {
        throw new StorageError({ cause: err as Error })
      }
    }
    return spaceDir
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<string>} Created collection storage directory path.
   */
  async #ensureCollectionDir({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<string> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    try {
      await mkdir(collectionDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.info(
          `Collection "${collectionId}" already exists, overwriting.`
        )
      } else {
        this.logger.error({ err }, 'Error creating directory')
        throw err // http 500
      }
    }
    return collectionDir
  }

  /**
   * The Resource representations in a directory listing, parsed: keeps only the
   * files named `r.<id>.<type>.<ext>` -- which drops the `.meta.` /
   * `.collection.meta.` / policy dot-files and every subdirectory -- and
   * resolves each one's `resourceId` / `contentType` alongside the `fileName`
   * it was read from.
   * @param entries {fs.Dirent[]}
   * @returns {RepresentationEntry[]}
   */
  #representationEntries(entries: fs.Dirent[]): RepresentationEntry[] {
    return entries
      .filter(entry => entry.isFile() && isRepresentationFileName(entry.name))
      .map(entry => ({
        fileName: entry.name,
        ...parseResourceFileName(entry.name)
      }))
  }

  /**
   * The live representations in a directory listing: the `r.<id>...` files
   * (`#representationEntries`) whose id's sidecar is live and names that exact
   * file as its `fileName`, each with the sidecar it was judged by
   * (`#judgeRepresentations`). Reads every sidecar of an id with a file, so a
   * caller that needs only a page or a count does not use it.
   * @param options {object}
   * @param options.dir {string}   a Collection dir, or a chunk dir
   * @param options.entries {fs.Dirent[]}   that dir's listing
   * @returns {Promise<LiveRepresentation[]>}
   */
  async #liveRepresentationEntries({
    dir,
    entries
  }: {
    dir: string
    entries: fs.Dirent[]
  }): Promise<LiveRepresentation[]> {
    const { live } = await this.#judgeRepresentations({
      dir,
      representations: this.#representationEntries(entries),
      names: this.#sidecarNames(entries)
    })
    return live
  }

  /**
   * What an export keeps of a directory listing, a Collection dir's or a
   * chunk dir's: every file but a representation file no live sidecar names
   * (`#judgeRepresentations`), and for each sidecar file a reader that
   * strips the members an archive leaves out
   * (`ARCHIVE_STRIPPED_SIDECAR_MEMBERS`). A sidecar read to judge a file
   * travels as the object it was read as, so it is read once. Any other
   * sidecar (a tombstone's) is read at pack time.
   *
   * A Resource tombstone (`.tombstone.<id>.json`) travels under the live
   * sidecar's name (`archiveName`), as the archive has always carried it, so
   * the archive keeps one sidecar entry per id. An id with both names on
   * disk (a crash between the two steps of a delete or a re-create) travels
   * once, as the body the two resolve to (`readMetaSidecar`), and the
   * tombstone file is left out.
   * @param options {object}
   * @param options.dir {string}
   * @param options.entries {fs.Dirent[]}   that dir's listing
   * @returns {Promise<{ keeps: (child: fs.Dirent) => boolean,
   *   archiveName: (fileName: string) => string,
   *   sidecarReader: (fileName: string) => (() => Promise<Buffer>) | undefined }>}
   */
  async #exportableFiles({
    dir,
    entries
  }: {
    dir: string
    entries: fs.Dirent[]
  }): Promise<{
    keeps: (child: fs.Dirent) => boolean
    archiveName: (fileName: string) => string
    sidecarReader: (fileName: string) => (() => Promise<Buffer>) | undefined
  }> {
    const names = this.#sidecarNames(entries)
    const { live, sidecars } = await this.#judgeRepresentations({
      dir,
      representations: this.#representationEntries(entries),
      names
    })
    const liveFileNames = new Set(live.map(({ fileName }) => fileName))
    // An id with both names and no file beside them was not judged; resolve
    // it here, so every both-names id travels as its resolved body.
    const unjudged = [...names.tombstones].filter(
      resourceId => names.live.has(resourceId) && !sidecars.has(resourceId)
    )
    for (const [resourceId, sidecar] of await mapInBatches({
      items: unjudged,
      map: async resourceId =>
        [
          resourceId,
          await this.#readListedSidecar({ dir, resourceId })
        ] as const
    })) {
      sidecars.set(resourceId, sidecar)
    }
    return {
      keeps: child => {
        if (!child.isFile()) {
          return false
        }
        if (isRepresentationFileName(child.name)) {
          return liveFileNames.has(child.name)
        }
        const tombstoneId = tombstoneSidecarFileId(child.name)
        return tombstoneId === undefined || !names.live.has(tombstoneId)
      },
      archiveName: fileName => {
        const tombstoneId = tombstoneSidecarFileId(fileName)
        return tombstoneId === undefined
          ? fileName
          : metaSidecarFileName(tombstoneId)
      },
      sidecarReader: fileName => {
        const sidecarId =
          metaSidecarFileId(fileName) ?? tombstoneSidecarFileId(fileName)
        if (sidecarId === undefined) {
          return undefined
        }
        const sidecar = sidecars.get(sidecarId)
        if (sidecar !== undefined) {
          return async () =>
            serializeSidecarWithout({
              sidecar,
              members: ARCHIVE_STRIPPED_SIDECAR_MEMBERS
            })
        }
        return async () =>
          withoutSidecarMembers({
            bytes: await fs.promises.readFile(path.join(dir, fileName)),
            members: ARCHIVE_STRIPPED_SIDECAR_MEMBERS
          })
      }
    }
  }

  /**
   * Judges representation files by their sidecars. A file is live when its
   * id's sidecar is live and names that exact file as its `fileName`. A file
   * no live sidecar names -- a write that never committed, or the prior file
   * a crash left behind a write's sidecar or a delete's tombstone -- is left
   * out, so every path that lists a directory agrees with the reads
   * (`#readLiveFile`). An id with no live sidecar name in the listing
   * (`names`) is left out with no read, and an id with one is read once,
   * even for an id with two files, opening its tombstone name only when the
   * listing holds it. `live` keeps the order of `representations`.
   * `sidecars` holds every sidecar read, by id, so a caller that also wants
   * the tombstones among them does not read them again; an id with no live
   * sidecar name is not in it. An id whose sidecar does not parse maps to
   * `undefined`.
   *
   * A sidecar that does not parse leaves its file out, with a `warn` line
   * (`#readListedSidecar`), on every path that judges files this way.
   * @param options {object}
   * @param options.dir {string}   a Collection dir, or a chunk dir
   * @param options.representations {RepresentationEntry[]}
   * @param options.names {{ live: Set<string>, tombstones: Set<string> }}
   *   the sidecar names in the listing (`#sidecarNames`)
   * @returns {Promise<{ live: Array<{ fileName: string, resourceId: string, contentType: string, sidecar: MetaSidecar }>, sidecars: Map<string, MetaSidecar | undefined> }>}
   */
  async #judgeRepresentations({
    dir,
    representations,
    names
  }: {
    dir: string
    representations: RepresentationEntry[]
    names: { live: Set<string>; tombstones: Set<string> }
  }): Promise<{
    live: LiveRepresentation[]
    sidecars: Map<string, MetaSidecar | undefined>
  }> {
    // One read per id with a live sidecar name, a bounded number at a time,
    // so a large dir does not open every sidecar at once.
    const resourceIds = [
      ...new Set(representations.map(({ resourceId }) => resourceId))
    ].filter(resourceId => names.live.has(resourceId))
    const sidecars = new Map(
      await mapInBatches({
        items: resourceIds,
        map: async resourceId =>
          [
            resourceId,
            await this.#readListedSidecar({
              dir,
              resourceId,
              names: { live: true, tombstone: names.tombstones.has(resourceId) }
            })
          ] as const
      })
    )
    const live = representations.flatMap(entry => {
      const sidecar = sidecars.get(entry.resourceId)
      return sidecar !== undefined &&
        sidecar.deleted !== true &&
        sidecar.fileName === entry.fileName
        ? [{ ...entry, sidecar }]
        : []
    })
    return { live, sidecars }
  }

  /**
   * The ids in a directory listing that have a live sidecar
   * (`.meta.<id>.json`), and the ids that have a Resource tombstone
   * (`.tombstone.<id>.json`), from the names alone. An id is in both sets
   * only when a crash between the two steps of a delete or a re-create left
   * both names. A chunk dir holds no tombstone.
   * @param entries {fs.Dirent[]}   a Collection or chunk dir's listing
   * @returns {{ live: Set<string>, tombstones: Set<string> }}
   */
  #sidecarNames(entries: fs.Dirent[]): {
    live: Set<string>
    tombstones: Set<string>
  } {
    const live = new Set<string>()
    const tombstones = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }
      const liveId = metaSidecarFileId(entry.name)
      if (liveId !== undefined) {
        live.add(liveId)
        continue
      }
      const tombstoneId = tombstoneSidecarFileId(entry.name)
      if (tombstoneId !== undefined) {
        tombstones.add(tombstoneId)
      }
    }
    return { live, tombstones }
  }

  /**
   * Counts the live Resources or chunks among a directory listing's ids,
   * from the names alone. An id is counted when the listing holds both its
   * live sidecar name (`.meta.<id>.json`) and a representation file of it,
   * so a tombstone, a file beside a tombstone, and a file with no sidecar do
   * not count, and no sidecar is opened. Whether the file is the one the
   * sidecar names is not checked, so a live sidecar naming a file that is
   * gone, with another file of the id beside it, counts here and is not
   * served: that is damage no committed write leaves, counted as a sidecar
   * that does not parse is. An id that also has a tombstone name is judged
   * as a listing is (`#judgeRepresentations`): its two sidecars are read,
   * and it counts when they resolve to a live one naming a file of it. The
   * ids in `except`, which the caller judged already, are left out.
   * @param options {object}
   * @param options.dir {string}   a Collection dir, or a chunk dir
   * @param options.entries {fs.Dirent[]}   that dir's listing
   * @param options.representations {RepresentationEntry[]}
   *   the listing's representation files, parsed (`#representationEntries`)
   * @param options.except {Set<string>}   ids to leave out of the count
   * @returns {Promise<number>}
   */
  async #countLiveListed({
    dir,
    entries,
    representations,
    except
  }: {
    dir: string
    entries: fs.Dirent[]
    representations: RepresentationEntry[]
    except: Set<string>
  }): Promise<number> {
    const names = this.#sidecarNames(entries)
    const counted = representations.filter(
      ({ resourceId }) => !except.has(resourceId) && names.live.has(resourceId)
    )
    const singleName = new Set<string>()
    const bothNames: RepresentationEntry[] = []
    for (const entry of counted) {
      if (names.tombstones.has(entry.resourceId)) {
        bothNames.push(entry)
      } else {
        singleName.add(entry.resourceId)
      }
    }
    const { live } = await this.#judgeRepresentations({
      dir,
      representations: bothNames,
      names
    })
    // A live sidecar names one file, so each id yields at most one entry.
    return singleName.size + live.length
  }

  /**
   * Reads a sidecar a directory listing found. A sidecar that does not parse
   * is logged at `warn` and resolves `undefined`, so the path that listed it
   * leaves its Resource out instead of failing. That holds for every such
   * path: the listings, the chunk listing, export, the changes feed, both
   * queries, and the unique-claim and unique-declaration scans. Sidecar
   * writes are atomic (`atomicWriteFile`), so a sidecar that does not parse
   * is disk damage or a hand edit, not a torn write. The damaged Resource's
   * own reads and writes already fail on it, and one damaged file must not
   * take down every unique write and the whole feed of its Collection. The
   * cost is that a unique value the damaged Resource holds is not defended
   * while the sidecar stands damaged: a write of another Resource may take
   * it, and the damaged Resource then has to be rewritten under another
   * value. A rewrite is the repair either way, since it runs the unique
   * claims again and takes a fresh feed position, while a sidecar restored
   * by hand takes none. Any other read error is thrown as it is.
   * @param options {object}
   * @param options.dir {string}   a Collection dir, or a chunk dir
   * @param options.resourceId {string}
   * @param [options.names] {{ live: boolean, tombstone: boolean }}   which
   *   names the listing holds for the id (`readMetaSidecar`)
   * @returns {Promise<MetaSidecar | undefined>}
   */
  async #readListedSidecar({
    dir,
    resourceId,
    names
  }: {
    dir: string
    resourceId: string
    names?: { live: boolean; tombstone: boolean }
  }): Promise<MetaSidecar | undefined> {
    try {
      return await this.readMetaSidecar({
        collectionDir: dir,
        resourceId,
        names
      })
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        throw err
      }
      this.logger.warn(
        { err },
        `The sidecar of "${resourceId}" in ${dir} does not parse; it is left out.`
      )
      return undefined
    }
  }

  /**
   * Reads a representation's sidecar and finds the live file it names. One
   * read serves both: `prior` is the sidecar as read, and `live` is set when
   * a live Resource or chunk stands, with the sidecar and the file's full
   * path. No sidecar, or a tombstone, leaves `live` unset. Every write that
   * leaves a live Resource or chunk records the basename of the file it
   * wrote as the sidecar's `fileName`, so the file is found with no directory
   * listing. A representation file no sidecar names is a write that never
   * committed, and is not a live Resource. See `#namedFilePath` for a live
   * sidecar that names no usable file.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   *   (a Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @param [options.requestName] {string}   used in the error title
   * @returns {Promise<LocatedResource>}
   */
  async #readLiveFile({
    collectionDir,
    resourceId,
    requestName
  }: {
    collectionDir: string
    resourceId: string
    requestName?: string
  }): Promise<LocatedResource> {
    const prior = await this.readMetaSidecar({ collectionDir, resourceId })
    if (prior === undefined || prior.deleted === true) {
      return { prior }
    }
    const filePath = this.#namedFilePath({
      collectionDir,
      resourceId,
      sidecar: prior,
      requestName
    })
    return { prior, live: { sidecar: prior, filePath } }
  }

  /**
   * The full path of the representation file a live sidecar names by its
   * `fileName`. A `fileName` that is missing, or is not a representation file
   * name of this id in this dir, is damage no committed write leaves, so it
   * throws `StorageError` (500).
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.sidecar {MetaSidecar}   a live sidecar
   * @param [options.requestName] {string}   used in the error title
   * @returns {string}
   */
  #namedFilePath({
    collectionDir,
    resourceId,
    sidecar,
    requestName
  }: {
    collectionDir: string
    resourceId: string
    sidecar: MetaSidecar
    requestName?: string
  }): string {
    const { fileName } = sidecar
    if (
      typeof fileName !== 'string' ||
      path.basename(fileName) !== fileName ||
      !isRepresentationFileName(fileName) ||
      !fileName.startsWith(`r.${encodeFilenameSegment(resourceId)}.`)
    ) {
      throw new StorageError({
        cause: new Error(
          `The sidecar of "${resourceId}" in ${collectionDir} names no representation file.`
        ),
        requestName
      })
    }
    return this.#containedJoin(collectionDir, fileName)
  }

  /**
   * Removes the representation a write replaced: the file the prior sidecar
   * named, when its name differs from the one just written (a write under a
   * different content-type). Called once the new sidecar names the new file
   * (write-new-then-prune), so the item is never momentarily absent. No
   * directory is listed: a file no sidecar named was never part of a
   * committed write. Shared by the Resource write path, the chunk write path
   * and the apply path.
   * @param options {object}
   * @param [options.priorPath] {string}   the live file the prior sidecar
   *   named, absent when the write created the item
   * @param options.keepPath {string}   the file just written
   * @returns {Promise<void>}
   */
  async #removeReplacedFile({
    priorPath,
    keepPath
  }: {
    priorPath?: string
    keepPath: string
  }): Promise<void> {
    if (
      priorPath !== undefined &&
      path.resolve(priorPath) !== path.resolve(keepPath)
    ) {
      await rm(priorPath, { force: true })
    }
  }

  /**
   * Removes every representation file of one id in a directory but `keep`,
   * which reclaims any file a crash left under another content type. It
   * lists the directory, so it runs on two paths only, each under the
   * per-Resource lock, so no write of the id lands between the listing and
   * the removals. Delete Resource and Delete Chunk call it with no `keep`,
   * once the tombstone is committed or no live sidecar names any of the
   * files, so a file a crash left beside the live one does not outlive the
   * delete. A Resource write or apply that creates the Resource over a
   * tombstone calls it with the file it just committed, which reclaims the
   * file a delete cut short left beside the tombstone
   * (`#reclaimBesideTombstone`).
   * @param options {object}
   * @param options.dir {string}   a Collection dir, or a chunk dir
   * @param options.resourceId {string}   a resourceId, or a chunk index
   * @param [options.keep] {string}   the basename of a file to leave in place
   * @returns {Promise<number>}   how many entries of the listing are left in
   *   the directory once the removals are done (Delete Chunk removes an
   *   emptied chunk dir)
   */
  async #removeRepresentationFilesOf({
    dir,
    resourceId,
    keep
  }: {
    dir: string
    resourceId: string
    keep?: string
  }): Promise<number> {
    const entries = await readDirEntries(dir)
    const files = this.#representationEntries(entries).filter(
      entry => entry.resourceId === resourceId && entry.fileName !== keep
    )
    for (const { fileName } of files) {
      const filePath = this.#containedJoin(dir, fileName)
      await rm(filePath, { force: true })
    }
    return entries.length - files.length
  }

  /**
   * Reclaims the representation files a crash left beside a Resource
   * tombstone, once a write has re-created the Resource over it: every file
   * of the id but the one the new sidecar names. A file beside a tombstone is
   * a Delete Resource cut short after its tombstone. Readers already leave
   * such a file out, by name. A no-op unless the write's prior sidecar was a
   * tombstone, so a content write of a live Resource, and a create of an id
   * with no sidecar, list nothing. Called under the per-Resource lock, after
   * the new sidecar is committed.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param [options.prior] {MetaSidecar}   the sidecar the write read
   * @param [options.keepPath] {string}   the file the new sidecar names;
   *   absent for a write-once repeat over the tombstone, which commits no
   *   file and leaves the tombstone standing
   * @returns {Promise<void>}
   */
  async #reclaimBesideTombstone({
    collectionDir,
    resourceId,
    prior,
    keepPath
  }: {
    collectionDir: string
    resourceId: string
    prior?: MetaSidecar
    keepPath?: string
  }): Promise<void> {
    if (prior?.deleted !== true) {
      return
    }
    await this.#removeRepresentationFilesOf({
      dir: collectionDir,
      resourceId,
      ...(keepPath !== undefined && { keep: path.basename(keepPath) })
    })
  }

  /**
   * Removes a chunk directory a crash left beside a Resource tombstone. A
   * delete writes the tombstone, its commit point, before it removes the
   * chunk directory, so a delete cut short between the two leaves the
   * directory behind, and a replay of a replicated tombstone is an
   * equal-stamp skip that does not remove it again. No chunk can be written
   * under a tombstone, so a chunk directory beside one is never live. A
   * no-op unless `prior` is a tombstone. Called under the per-Resource lock,
   * before a write over the tombstone commits, so the new Resource never
   * shows the deleted one's chunks.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param [options.prior] {MetaSidecar}   the sidecar the write read
   * @returns {Promise<void>}
   */
  async #clearChunksBesideTombstone({
    collectionDir,
    resourceId,
    prior
  }: {
    collectionDir: string
    resourceId: string
    prior?: MetaSidecar
  }): Promise<void> {
    if (prior?.deleted !== true) {
      return
    }
    await rm(this.#chunkDir({ collectionDir, resourceId }), {
      recursive: true,
      force: true
    })
  }

  // Spaces

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceMetadata {SpaceMetadata}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Space's `createdBy` on first write only
   * @param [options.ifMatch] {string}   an `If-Match` compare-and-swap on the
   *   current `ETag`; a stale validator throws `PreconditionFailedError` (412)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *`, the guarded
   *   create; an existing Space throws `PreconditionFailedError` (412)
   * @returns {Promise<MetadataWriteResult<SpaceMetadata>>}   the Space
   *   Metadata object's new validator (its `generation` and the stamp this
   *   write mints, local segment 0), whether the write created the Space,
   *   and the stored object
   */
  async writeSpace({
    spaceId,
    spaceMetadata,
    createdBy,
    ifMatch,
    ifNoneMatch,
    assertTransition
  }: {
    spaceId: string
    spaceMetadata: SpaceMetadata
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    assertTransition?: (prior?: StoredSpaceMetadata) => void | Promise<void>
  }): Promise<MetadataWriteResult<SpaceMetadata>> {
    // Serialize the read-check-write under a per-Space-metadata lock so the
    // precondition check and the stamp are atomic with the write (two
    // clients racing a guarded create cannot both succeed). Its own
    // lock namespace: a Space Metadata write touches no Collection file.
    // The Space gate goes on the outside, as on every path-creating write:
    // this one creates the Space dir.
    return this.#underSpaceWrite({
      spaceId,
      write: () =>
        this.#writeMutex.run(this.#spaceMetaLockKey({ spaceId }), async () =>
          this.#writeSpaceLocked({
            spaceId,
            spaceMetadata,
            createdBy,
            ifMatch,
            ifNoneMatch,
            assertTransition,
            // Prior Space Metadata object, read once under the lock.
            prior: await this.getSpaceMetadata({ spaceId })
          })
        )
    })
  }

  /**
   * `writeSpace`'s body, for a caller that already holds the Space gate and
   * the per-Space-metadata lock and has read the prior object under it (an
   * import restoring the archived object composes its write from that read).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.spaceMetadata {SpaceMetadata}
   * @param [options.createdBy] {string}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @param [options.assertTransition] {Function}
   * @param [options.prior] {StoredSpaceMetadata}   the current object, read
   *   under the lock; reused for the precondition, the create-path quota
   *   check (a brand-new Space has none yet), and to resolve `createdBy`
   * @returns {Promise<MetadataWriteResult<SpaceMetadata>>}
   */
  async #writeSpaceLocked({
    spaceId,
    spaceMetadata,
    createdBy,
    ifMatch,
    ifNoneMatch,
    assertTransition,
    prior
  }: {
    spaceId: string
    spaceMetadata: SpaceMetadata
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    assertTransition?: (prior?: StoredSpaceMetadata) => void | Promise<void>
    prior?: StoredSpaceMetadata
  }): Promise<MetadataWriteResult<SpaceMetadata>> {
    // The shared write rules (lib/metadataWrite.ts) run the precondition,
    // the transition check, the count quota, and the stamp. Space creation
    // is rare, so the O(all Spaces) count is acceptable; soft under
    // concurrency across controllers, like the byte quota.
    const { validator, stamped } = await stampSpaceWrite({
      spaceId,
      spaceMetadata,
      prior,
      createdBy,
      ifMatch,
      ifNoneMatch,
      assertTransition,
      maxSpacesPerController: this.maxSpacesPerController,
      countOwnedSpaces: async () =>
        (await this.listSpaces()).filter(
          space => space.controller === spaceMetadata.controller
        ).length,
      clock: this.#clock
    })
    const { generation } = validator

    if (prior === undefined) {
      // A create. A Space dir standing with no Metadata file is what a Delete
      // Space killed mid-`rm` left: the old life's revocation records or
      // Collection dirs, which the new life must not inherit. It is removed
      // whole before the new dir is made. Under the Space gate and the lock,
      // so nothing of the new life can land in between; and no write of the
      // old life is in flight, since each re-checks the Metadata file under
      // the gate.
      await this.#removeSpaceDir({ spaceId })
    }
    await this.#ensureSpaceDir({ spaceId })
    await this.#persistSpace({ spaceId, body: stamped, generation, local: 0 })
    return { validator, created: prior === undefined, metadata: stamped }
  }

  /**
   * Builds the on-disk path for a Space's Metadata file
   * (`.space.meta.<spaceId>.json`) in its own Space dir.
   * @param spaceId {string}
   * @returns {string}
   */
  #spaceMetadataPath(spaceId: string): string {
    return this.#containedJoin(
      this.#spaceDir(spaceId),
      spaceMetadataFileName(spaceId)
    )
  }

  /**
   * Writes a Space Metadata file (full replacement). The caller holds the
   * per-Space-metadata lock, and the Space dir exists.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.body {SpaceMetadata}   the wire body to store, stamp
   *   members included
   * @param options.generation {string}
   * @param options.local {number}   the local validator segment
   * @returns {Promise<void>}
   */
  async #persistSpace({
    spaceId,
    body,
    generation,
    local
  }: {
    spaceId: string
    body: SpaceMetadata
    generation: string
    local: number
  }): Promise<void> {
    // Durable full replacement: `#readJsonFile` parses plain JSON, so an
    // atomically-written JSON string round-trips through the same read
    // path. The generation and local segment are stored under the reserved
    // `_generation` / `_local` members that `getSpaceMetadata` strips and
    // re-surfaces out of band, the same layout as a Collection Metadata
    // file; the stamp members are wire members, stored bare.
    await atomicWriteFile({
      filePath: this.#spaceMetadataPath(spaceId),
      data: JSON.stringify(embedMetadataValidator({ body, generation, local }))
    })
  }

  /**
   * Reads a Collection Metadata file for an export: its bytes as the archive
   * carries them (without the local segment), and whether they are a
   * tombstone. Resolves `undefined` when the file is absent.
   * @param file {string}   absolute path of the Metadata file
   * @returns {Promise<{ bytes: Buffer, tombstone: boolean } | undefined>}
   */
  async #readArchivedCollectionMetadata(
    file: string
  ): Promise<{ bytes: Buffer; tombstone: boolean } | undefined> {
    const raw = await readFileIfPresent(file)
    if (raw === undefined) {
      return undefined
    }
    // Unparseable bytes travel as stored, as a live Collection's would.
    const parsed = parseJsonOrUndefined(raw)
    const tombstone =
      typeof parsed === 'object' &&
      parsed !== null &&
      isCollectionTombstone(parsed)
    return { bytes: withoutLocalSegment(raw), tombstone }
  }

  /**
   * Reads one JSON metadata file (a Space or Collection Metadata object, a
   * sidecar, policy, log, backend record, or keystore config), `undefined`
   * when absent. A concurrent delete (Delete Space removing the directory,
   * Delete Collection removing its members) can remove the file just before
   * the read; the `ENOENT` it then throws means "absent", so it resolves
   * `undefined` rather than surfacing as a 500 out of a read that happened to
   * touch the vanishing record. Every JSON metadata read goes through here so
   * the case is handled at each site alike. A body that does not parse
   * rejects with the `SyntaxError`, which `#readSidecarName` and the policy
   * reader rely on; a `null` body reads as absent.
   * @param file {string}   absolute path of the JSON file
   * @returns {Promise<T | undefined>}
   */
  async #readJsonFile<T>(file: string): Promise<T | undefined> {
    const bytes = await readFileIfPresent(file)
    if (bytes === undefined) {
      return undefined
    }
    return (JSON.parse(bytes.toString('utf8')) as T | null) ?? undefined
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<StoredSpaceMetadata|undefined>}
   *   Resolves falsy when the Space does not exist (must not throw).
   *   `metaGeneration` / `metaLocal` are the out-of-band `ETag` validator
   *   parts; the stamp members ride in the body.
   */
  async getSpaceMetadata({
    spaceId
  }: {
    spaceId: string
  }): Promise<StoredSpaceMetadata | undefined> {
    const raw = await this.#readJsonFile<
      ListedSpaceMetadata & EmbeddedMetadataValidator
    >(this.#spaceMetadataPath(spaceId))
    return raw && storedMetadataFromFile(raw)
  }

  /**
   * Removes a Space and everything scoped to it, its zcap revocations
   * included, since they live under the Space dir
   * (`ARCHIVE_REVOCATIONS_DIR`): one `rm` of the Space dir is the whole
   * delete. A process killed mid-`rm` leaves a Space dir with or without its
   * Metadata file. With it, the Space stands whole and the next delete
   * finishes the removal. Without it, the dir reads as absent everywhere, a
   * repeat delete removes it, and a create under the id removes it before
   * making the new Space (`#writeSpaceLocked`), so the new life inherits
   * nothing of the old.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({ spaceId }: { spaceId: string }): Promise<void> {
    // Under the Space Metadata lock, so the delete cannot land between a
    // concurrent `writeSpace`'s prior read and its file write: that write
    // would recreate the directory and carry the deleted life's generation
    // into the new one, where a re-create must mint a fresh generation. Under
    // the Space gate's exclusive side as well, which holds off every OTHER
    // write into the Space for the duration: a Resource write recreates the
    // Collection dir on its way past (`mkdir ... recursive`), so one landing
    // mid-`rm` would leave a metadata-less directory behind the delete.
    return this.#underSpaceRemoval({
      spaceId,
      remove: () =>
        this.#writeMutex.run(this.#spaceMetaLockKey({ spaceId }), () =>
          this.#removeSpaceDir({ spaceId })
        )
    })
  }

  /**
   * Removes a Space dir, absent or not, with the in-memory state kept about
   * it: the cached usage total (freed bytes, so the next write re-measures)
   * and the staging credits of its Collections. `force: true` keeps the
   * removal idempotent (the `StorageBackend` contract): removing an absent
   * Space resolves rather than rejecting with `ENOENT`. The caller holds the
   * Space gate and the Space Metadata lock.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #removeSpaceDir({ spaceId }: { spaceId: string }): Promise<void> {
    this.#dropUsageCache({ spaceId })
    await rm(this.#spaceDir(spaceId), { recursive: true, force: true })
    this.#forgetStagingCredits({ under: this.#spaceDir(spaceId) })
  }

  /**
   * Enumerates every Space stored on this backend (each immediate subdirectory
   * of the spaces root), sorted by Space id. An absent spaces root (nothing
   * stored yet) resolves an empty list, not an error; a directory without a
   * readable metadata file (e.g. a partially deleted Space) is skipped.
   * @returns {Promise<ListedSpaceMetadata[]>}
   */
  async listSpaces(): Promise<ListedSpaceMetadata[]> {
    let rootEntries: fs.Dirent[]
    try {
      rootEntries = await readDirEntries(this.spacesDir)
    } catch (err) {
      throw new StorageError({ cause: err as Error })
    }
    const spaceEntries = rootEntries
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    // Each metadata file is an independent read, so read them in parallel;
    // `Promise.all` preserves the sorted order.
    const spaces = await Promise.all(
      spaceEntries.map(entry => this.getSpaceMetadata({ spaceId: entry.name }))
    )
    // The listing is the plain wire shape: drop each object's out-of-band
    // validator (a listing carries no per-item `ETag`).
    return spaces
      .filter((spaceMetadata): spaceMetadata is StoredSpaceMetadata =>
        Boolean(spaceMetadata)
      )
      .map(spaceMetadata => stripMetadataValidator(spaceMetadata))
  }

  /**
   * Every Collection dir in the Space, in code-unit ascending order of id --
   * the keyset order the paginated `listCollections` seeks within -- each
   * with its tombstone when the Collection is one. The unpaginated
   * full-enumeration path: `listCollections` builds one page from it, while
   * the internal full-Space callers (import count-quota seeding, the create
   * count-quota) read it through `#liveCollectionIds`.
   * A live Collection carries its Metadata object, so the listing page need
   * not read it again. A dir without a Metadata file counts as live, as it
   * always has, and carries neither. A Metadata file that does not parse
   * counts as live too and carries the parse error as `unreadable`. The
   * Space-wide callers (the count quota, the usage report, import) then keep
   * working, and only a listing page that holds the Collection fails. A
   * filesystem fault still rejects. An absent Space dir holds none.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<Array<{ id: string, tombstone?: StoredCollectionTombstone, metadata?: StoredCollectionMetadata, unreadable?: Error }>>}
   */
  async #collectionEntries({ spaceId }: { spaceId: string }): Promise<
    Array<{
      id: string
      tombstone?: StoredCollectionTombstone
      metadata?: StoredCollectionMetadata
      unreadable?: Error
    }>
  > {
    // Code-unit order is the SAME ordering the cursor seek
    // (`collectionId > after`) uses, so the keyset stays consistent.
    const ids = await this.#collectionIds({ spaceId })
    // Each Metadata file is an independent read, so they are read in
    // batches; the order is kept.
    return mapInBatches({
      items: ids,
      map: async id => {
        let record:
          StoredCollectionMetadata | StoredCollectionTombstone | undefined
        try {
          record = await this.#readCollectionRecord({
            spaceId,
            collectionId: id
          })
        } catch (err) {
          // A filesystem fault carries a `code`; a parse error does not.
          if ((err as NodeJS.ErrnoException).code !== undefined) {
            throw err
          }
          return { id, unreadable: err as Error }
        }
        return isCollectionTombstone(record)
          ? { id, tombstone: record }
          : { id, metadata: record }
      }
    })
  }

  /**
   * Every live Collection id in the Space, in code-unit ascending order: the
   * Collections the count quota counts. A tombstone is left out.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<string[]>}
   */
  async #liveCollectionIds({
    spaceId
  }: {
    spaceId: string
  }): Promise<string[]> {
    return (await this.#collectionEntries({ spaceId }))
      .filter(entry => entry.tombstone === undefined)
      .map(entry => entry.id)
  }

  /**
   * Lists a Space's Collections, OPTIONALLY cursor-paginated (spec
   * "Pagination"), mirroring `listCollectionItems`: a stable total order
   * (ascending by Collection id, code-unit), a `cursor` that resumes at the
   * first id strictly greater than its anchor, a `limit` resolved within
   * `[1, MAX_PAGE_SIZE]` (default `DEFAULT_PAGE_SIZE`), and a `next` present
   * only when a further page may follow. `totalItems` is the full Collection
   * count of the Space -- free here, since the whole directory is enumerated.
   * Each summary's `public` flag is the Collection's `PublicCanRead` policy
   * state, probed inline for the page's Collections only (O(page size)).
   * A tombstoned Collection is listed, and counted, only under
   * `includeDeleted`, as its id, URL, `deleted: true` and the stamp of the
   * delete.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page's `next`
   * @param [options.includeDeleted] {boolean}   list tombstoned Collections too
   * @returns {Promise<CollectionsList>}
   */
  async listCollections({
    spaceId,
    limit,
    cursor,
    includeDeleted = false
  }: {
    spaceId: string
    limit?: number
    cursor?: string
    includeDeleted?: boolean
  }): Promise<CollectionsList> {
    const entries = (await this.#collectionEntries({ spaceId })).filter(
      entry => includeDeleted || entry.tombstone === undefined
    )

    // The full count is free (we enumerated the whole Space), so keep returning
    // `totalItems` -- the count of every listed Collection, not the page.
    const totalItems = entries.length

    // Resolve `limit` within `[1, MAX_PAGE_SIZE]`, defaulting when absent,
    // then cut the page out at the cursor's seek point (the Collection id is
    // the keyset).
    const pageSize = resolvePageSize(limit)
    const { page, hasMore } = seekPage({
      items: entries,
      cursor,
      pageSize,
      keyOf: entry => entry.id
    })

    // Each Collection's reads are independent, so the page is assembled in
    // parallel; `Promise.all` preserves the keyset order of the page.
    const items = await Promise.all(
      page.map(
        async ({ id: collectionId, tombstone, metadata, unreadable }) => {
          // A Metadata file that does not parse fails the page that lists it,
          // and no other page.
          if (unreadable !== undefined) {
            throw unreadable
          }
          if (tombstone !== undefined) {
            return collectionTombstoneSummary({
              spaceId,
              collectionId,
              stamp: tombstone
            })
          }
          // Probe the collection-level policy inline so a client need not issue one
          // policy request per listed Collection (an N+1). Only page items are read,
          // so this stays O(page size). `public` is true iff a `PublicCanRead`
          // policy is attached (via the shared `policyGrants` recognizer, which
          // fail-closes any other/unrecognized policy type to false).
          const policy = await this.getPolicy({ spaceId, collectionId })
          return {
            id: collectionId,
            // The canonical container form, with the trailing slash.
            url: collectionPath({ spaceId, collectionId }),
            // `name` is optional on the wire type; a stored Collection normally has
            // one (create defaults it to the id). Fall back to the dir name for a
            // metadata-less directory too (e.g. one left by a policy write to a
            // never-created Collection) -- reading `.name` off `undefined` here would
            // 500 the entire Space listing.
            name: metadata?.name ?? collectionId,
            public: policyGrants({
              policy,
              action: 'read',
              logger: this.logger
            })
          } satisfies CollectionSummary
        }
      )
    )

    // The listing is the Space container itself, `/space/:spaceId/`. `next` is
    // present iff a further page may follow; its absence marks the last page
    // (the authoritative end-of-list signal).
    return collectionsList({
      spaceId,
      totalItems,
      items,
      hasMore,
      pageSize,
      includeDeleted
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.service] {ServiceDescription}   this server's Service
   *   Description, written into the archive as its `service.json` entry
   * @param [options.attestor] {ExportAttestor}   the server's signing
   *   identity; with one, the archive carries `provenance.jsonl` and the
   *   `did.jsonl` log snapshot
   * @returns {Promise<Readable>} tar-stream pack
   */
  async exportSpace({
    spaceId,
    service,
    attestor
  }: {
    spaceId: string
    service?: ServiceDescription
    attestor?: ExportAttestor
  }): Promise<Readable> {
    const entries = await this.exportSpaceEntries({ spaceId })
    return packExportArchive({ spaceId, entries, service, attestor })
  }

  /**
   * The Space's archive entry tree, read from the Space directory: every
   * file entry carries a lazy `read()` so the bytes are fetched one file at
   * a time while packing (an export never buffers the whole Space).
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.serverBackends] {BackendDescriptor[]}   the
   *   server-managed entries of the archived Space Metadata object's
   *   backends listing; defaults to this backend's descriptor
   * @returns {Promise<ArchiveEntry[]>}
   */
  async exportSpaceEntries({
    spaceId,
    serverBackends
  }: {
    spaceId: string
    serverBackends?: BackendDescriptor[]
  }): Promise<ArchiveEntry[]> {
    const spaceMetadata = await this.getSpaceMetadata({ spaceId })
    if (!spaceMetadata) {
      throw new SpaceNotFoundError({ requestName: 'Export Space' })
    }

    const sourceSpaceDir = this.#spaceDir(spaceId)
    const spaceEntries = (
      await fs.promises.readdir(sourceSpaceDir, { withFileTypes: true })
    ).filter(
      // Backend registration records (.backend.<id>.json) hold plaintext
      // connection material and do NOT travel in a Space export; after import
      // the user re-registers (re-runs consent + POST /backends). importSpace
      // ignores unrecognized space-level files, so this is symmetric.
      // Replica registrations and their loop state (.replica.<id>.json,
      // .replica.<id>.state.json) are this server's own and do not travel
      // either.
      entry =>
        !(
          entry.isFile() &&
          (entry.name.startsWith('.backend.') ||
            entry.name.startsWith('.replica.'))
        )
    )
    spaceEntries.sort((a, b) => a.name.localeCompare(b.name))

    // The archive's top-level entries, in pack order: a Space-level file, or a
    // Collection directory holding its files and, per chunked Resource, a
    // `.chunks.<encId>/` subdirectory. Every file entry carries a lazy `read()`
    // so the bytes are still fetched one file at a time while packing (an
    // export never buffers the whole Space).
    const archiveEntries: ArchiveEntry[] = []
    for (const entry of spaceEntries) {
      const entryPath = path.join(sourceSpaceDir, entry.name)

      if (entry.isDirectory() && entry.name === ARCHIVE_REVOCATIONS_DIR) {
        // The Space's zcap revocation records travel as the archive's
        // `.revocations/` directory, one flat file per record. A directory
        // holding none (every record pruned) is left out, as the Postgres
        // backend leaves it out when it has no row.
        let records: fs.Dirent[]
        try {
          records = await readDirEntries(entryPath)
        } catch (err) {
          throw new StorageError({ cause: err as Error })
        }
        const files = records
          .filter(child => child.isFile() && child.name.endsWith('.json'))
          .map(child => child.name)
          .sort((a, b) => a.localeCompare(b))
          .map(name => ({
            name,
            read: () => fs.promises.readFile(path.join(entryPath, name))
          }))
        if (files.length > 0) {
          archiveEntries.push({ name: entry.name, files })
        }
        continue
      }

      if (entry.isDirectory()) {
        // The Metadata file is read here, once, and the same bytes decide
        // whether the Collection is live or a tombstone and are what the
        // archive carries. A delete, or a create over a tombstone, landing
        // before the pack then cannot leave a body that disagrees with its
        // place in the archive.
        const metadataFile = collectionMetadataFileName(entry.name)
        const metadataBytes = await this.#readArchivedCollectionMetadata(
          path.join(entryPath, metadataFile)
        )
        // A tombstone travels as its Metadata file directly in the Space
        // directory, with no Collection directory. Members an interrupted
        // delete left on disk do not travel.
        if (metadataBytes?.tombstone) {
          archiveEntries.push({
            name: metadataFile,
            read: async () => metadataBytes.bytes
          })
          continue
        }
        const collectionEntries = await fs.promises.readdir(entryPath, {
          withFileTypes: true
        })
        // A policy file is read here, once: a tombstone does not travel, and
        // the same bytes that decided so are what the archive carries, less
        // the policy's `_feedPosition`.
        const policyFiles = new Map<string, Buffer | undefined>()
        await Promise.all(
          collectionEntries
            .filter(child => child.isFile() && isPolicyFileName(child.name))
            .map(async child => {
              policyFiles.set(
                child.name,
                await this.#readArchivedPolicy(path.join(entryPath, child.name))
              )
            })
        )
        // The changes-feed counter (the Collection Metadata object's and the
        // log's positions included), each sidecar's `feedPosition` and
        // `fileName`, each policy's `_feedPosition` and the Collection
        // Metadata object's local validator segment are this server's own
        // facts, so none travels: the counter file is left out, `feedPosition`
        // and `fileName` are stripped from every Resource sidecar and
        // `_feedPosition` from every policy file (an importer assigns its own
        // positions and records the files it writes), and `_local` from the
        // Metadata file.
        //
        // A representation file travels only when a live sidecar names it
        // (`#exportableFiles`): a file a crash left behind would otherwise be
        // imported as a Resource.
        const exportable = await this.#exportableFiles({
          dir: entryPath,
          entries: collectionEntries
        })
        const files: ArchiveEntry[] = collectionEntries
          .filter(
            child =>
              exportable.keeps(child) &&
              child.name !== feedCounterFileName(entry.name) &&
              !(
                policyFiles.has(child.name) &&
                policyFiles.get(child.name) === undefined
              )
          )
          .map(child => {
            const childPath = path.join(entryPath, child.name)
            const readBytes = () => fs.promises.readFile(childPath)
            let read: () => Promise<Buffer> = readBytes
            const policyBytes = policyFiles.get(child.name)
            const readSidecar = exportable.sidecarReader(child.name)
            if (policyBytes !== undefined) {
              read = async () => policyBytes
            } else if (readSidecar !== undefined) {
              read = readSidecar
            } else if (child.name === metadataFile) {
              read = async () =>
                metadataBytes?.bytes ?? withoutLocalSegment(await readBytes())
            }
            // A Resource tombstone travels under the live sidecar's name.
            return { name: exportable.archiveName(child.name), read }
          })
          .sort((a, b) => a.name.localeCompare(b.name))
        // Per-Resource chunk directories (`.chunks.<encId>/`; the
        // `chunked-streams` feature) are subdirectories of a Collection dir, so
        // the file filter above skips them. Append each one's files here so a
        // chunked Resource's chunks travel in the export.
        for (const sub of collectionEntries
          .filter(
            child =>
              child.isDirectory() && child.name.startsWith(CHUNK_DIR_PREFIX)
          )
          .sort((a, b) => a.name.localeCompare(b.name))) {
          const chunkDir = path.join(entryPath, sub.name)
          const chunkEntries = await fs.promises.readdir(chunkDir, {
            withFileTypes: true
          })
          // A chunk sidecar's `fileName` is server-local, as a Resource's
          // is, its `digest` stays here as a Resource's does, and a chunk
          // file travels under the same rule.
          const exportable = await this.#exportableFiles({
            dir: chunkDir,
            entries: chunkEntries
          })
          const chunkFiles = chunkEntries
            .filter(child => exportable.keeps(child))
            .map(child => child.name)
            .sort((a, b) => a.localeCompare(b))
            .map(name => ({
              name,
              read:
                exportable.sidecarReader(name) ??
                (() => fs.promises.readFile(path.join(chunkDir, name)))
            }))
          files.push({ name: sub.name, files: chunkFiles })
        }
        archiveEntries.push({ name: entry.name, files })
        continue
      }

      if (entry.isFile() && entry.name === SPACE_POLICY_FILE_NAME) {
        // A Space policy tombstone does not travel (see the Collection
        // policies above).
        const policyBytes = await this.#readArchivedPolicy(entryPath)
        if (policyBytes !== undefined) {
          archiveEntries.push({
            name: entry.name,
            read: async () => policyBytes
          })
        }
        continue
      }

      if (entry.isFile()) {
        // The Space Metadata entry is built from the record read above, with
        // the server-derived `backends` listing stamped on (the shared
        // `archivedSpaceMetadata`), rather than re-read off the disk.
        if (entry.name === spaceMetadataFileName(spaceId)) {
          archiveEntries.push({
            name: entry.name,
            read: () =>
              archivedSpaceMetadata({
                storage: this,
                spaceId,
                spaceMetadata,
                serverBackends
              })
          })
          continue
        }
        archiveEntries.push({
          name: entry.name,
          read: () => fs.promises.readFile(entryPath)
        })
      }
    }

    // A tombstone's file, and the revocations directory, sort among the
    // Space-level files by their own names, the order the Postgres backend
    // packs in.
    archiveEntries.sort((left, right) => left.name.localeCompare(right.name))
    return archiveEntries
  }

  /**
   * Merges a PWS space-export tarball into an existing Space (collections and
   * resources that already exist are skipped, not overwritten).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.plan {ImportPlan}   the archive's merge plan, its
   *   provenance already judged (`prepareImportPlan`)
   * @param options.provenance {ImportStats['provenance']}   the verdict counts,
   *   returned unchanged
   * @param [options.restoreSpaceMetadata] {boolean}   whether to apply the
   *   archived Space Metadata object's user-writable members over the
   *   destination's
   * @returns {Promise<ImportStats>}
   */
  async importSpace({
    spaceId,
    plan: {
      spaceMetadata: archivedSpaceMetadata,
      spacePolicy,
      collections,
      collectionTombstones
    },
    provenance,
    restoreSpaceMetadata = false
  }: {
    spaceId: string
    plan: ImportPlan
    provenance: ImportStats['provenance']
    restoreSpaceMetadata?: boolean
  }): Promise<ImportStats> {
    // Shared pre-flight over every staged body (`assertImportBodiesFit`): the
    // per-upload 413 cap and the fail-closed encryption check, run before
    // anything is written so a rejected import leaves the Space untouched. It
    // returns the summed incoming bytes for the third invariant, the cumulative
    // quota (507), which stays here because the headroom check is this
    // backend's own (a `du` snapshot).
    const { capacityBytes, maxUploadBytes, maxCollectionsPerSpace } = this
    const incomingBytes = await assertImportBodiesFit({
      collections,
      existingCollection: collectionId =>
        this.getCollectionMetadata({ spaceId, collectionId }),
      existingCollectionLog: async collectionId =>
        (await this.getCollectionLog({ spaceId, collectionId }))?.body,
      assertUploadSize: uploadBytes =>
        this.#assertUploadSize({ maxUploadBytes, uploadBytes }),
      chunkBodiesFor: collection => collection.chunkFiles
    })
    // Keep the reservation handle: the apply loop below skips every body the
    // destination already holds, and can throw part-way (a count quota), so the
    // import must give back what it did not write. Otherwise a re-import of an
    // unchanged archive -- which writes nothing -- would hold the whole archive
    // size in the snapshot and refuse unrelated writes with 507 until it
    // expires. `bytesWritten` tracks what actually landed; the `finally` below
    // reconciles the reservation down to it.
    let reconcileByteReservation: ((actualBytes: number) => void) | undefined
    let bytesWritten = 0
    if (capacityBytes !== undefined) {
      ;({ reconcile: reconcileByteReservation } =
        await this.#assertSpaceHeadroom({
          spaceId,
          capacityBytes,
          incomingBytes
        }))
    }

    // The whole apply loop runs on the Space gate's shared side, so a container
    // removal cannot land between the import's `mkdir` and its file writes. The
    // helpers it calls (`writePolicy`) take the shared side again; the gate
    // admits readers re-entrantly, so that nests safely. The destination Space
    // must still exist once the gate is held.
    return this.#underSpaceWrite({
      spaceId,
      container: { requestName: 'Import Space' },
      write: async () => {
        try {
          // An archived Space Metadata entry is 'skipped' until it is
          // restored below; an archive carrying none is 'absent'.
          const stats: ImportStats = {
            collectionsCreated: 0,
            collectionsSkipped: 0,
            resourcesCreated: 0,
            resourcesSkipped: 0,
            policiesCreated: 0,
            policiesSkipped: 0,
            spaceMetadata: archivedSpaceMetadata ? 'skipped' : 'absent',
            provenance
          }
          // Counts one archived policy as written or kept.
          const tallyPolicy = (written: boolean) => {
            if (written) {
              stats.policiesCreated++
            } else {
              stats.policiesSkipped++
            }
          }

          // The archived Space Metadata object's user-writable members,
          // applied over the destination's stored object by the same write
          // Update Space Metadata makes (`name` restored, `type` checked
          // against the destination's), so the object takes a new stamp as
          // an ordinary metadata write does. Only when the caller
          // asked for it (the handler decides that on the invocation's
          // authority). Everything else -- `controller`, `createdBy`, and
          // the members the server derives per read -- stays the
          // destination's. A Space with no stored object yet (a backend
          // driven outside a request) has nothing to apply them over.
          // Read, composed and written under the per-Space-metadata lock, so
          // a concurrent Metadata write lands wholly before or after it.
          if (archivedSpaceMetadata && restoreSpaceMetadata) {
            await this.#writeMutex.run(
              this.#spaceMetaLockKey({ spaceId }),
              async () => {
                const prior = await this.getSpaceMetadata({ spaceId })
                if (!prior) {
                  return
                }
                await this.#writeSpaceLocked({
                  spaceId,
                  spaceMetadata: restoredSpaceMetadata({
                    prior: stripMetadataValidator(prior),
                    archived: archivedSpaceMetadata
                  }),
                  prior
                })
                stats.spaceMetadata = 'restored'
              }
            )
          }

          // Space-level policy: restore it when the destination has none (the import
          // target Space pre-exists, so this fills in a missing policy without
          // clobbering one the destination already carries). A deleted policy's
          // tombstone counts as one, so an import does not undo the delete.
          if (spacePolicy) {
            tallyPolicy(
              await this.#importPolicy({ spaceId, imported: spacePolicy })
            )
          }

          // Count quota: measure the Space's existing live Collections ONCE
          // here, then track a running total as the apply loop creates
          // Collections, so an import cannot push the Space past
          // `maxCollectionsPerSpace`. Only a brand-new Collection counts -- a
          // re-imported existing id does not -- mirroring the per-create
          // write-path guard without re-enumerating the Space per item.
          const collectionIds = new Set(
            await this.#liveCollectionIds({ spaceId })
          )

          for (const {
            collectionId,
            collectionMetadata,
            collectionPolicy,
            collectionLog,
            resources,
            resourcePolicies,
            detachedResourcePolicies,
            resourceMetadata,
            chunkFiles
          } of collections) {
            // Check whether the Collection already exists, and create it when
            // it does not, under the Collection Metadata lock, so a
            // concurrent create of the same id lands wholly before or after.
            // A tombstoned Collection counts as absent: the import creates it
            // anew, once any members a delete left are gone, with a stamp
            // above the tombstone's.
            const collectionExisted = await this.#writeMutex.run(
              this.#collectionMetaLockKey({ spaceId, collectionId }),
              async () => {
                const record = await this.#readCollectionRecord({
                  spaceId,
                  collectionId
                })
                if (record !== undefined && !isCollectionTombstone(record)) {
                  return true
                }
                // A brand-new Collection (one whose id the Space did not
                // already hold live, even as a metadata-less directory)
                // counts against the cap; filling in the metadata of an
                // existing directory does not.
                if (
                  maxCollectionsPerSpace !== undefined &&
                  !collectionIds.has(collectionId) &&
                  collectionIds.size >= maxCollectionsPerSpace
                ) {
                  throw new CountQuotaExceededError({
                    scope: 'Collections per Space',
                    limit: maxCollectionsPerSpace
                  })
                }
                if (record !== undefined) {
                  await this.#removeCollectionMembers({ spaceId, collectionId })
                }
                collectionIds.add(collectionId)
                // Re-stamped by this store's clock: the archived stamp is read
                // for provenance only. The archived generation is kept.
                const { body, generation } = restampImportedMetadata({
                  metadata: collectionMetadata,
                  stamp: await this.#clock.mint({ held: stampOf(record) })
                })
                // A Collection created by an import takes this Collection's
                // first feed position, as a create does.
                await this.#persistCollection({
                  spaceId,
                  collectionId,
                  body,
                  generation,
                  local: 0,
                  feedPosition: 'first'
                })
                return false
              }
            )
            if (collectionExisted) {
              stats.collectionsSkipped++
            } else {
              stats.collectionsCreated++
            }

            // Its governing history log travels with a newly-created Collection
            // (an existing, skipped one keeps its own, as it keeps its policy and
            // metadata), re-stamped like the Collection. It takes this
            // Collection's next feed position, as a log write does. No other
            // log write can land here meanwhile: a guarded create needs the
            // Space gate's exclusive side, which this import's shared hold
            // excludes, and an append needs a log to exist already.
            if (collectionLog && !collectionExisted) {
              const log = restampImportedLog({
                bytes: collectionLog,
                stamp: await this.#clock.mint()
              })
              await this.#takeFeedPosition({
                spaceId,
                collectionId,
                collectionDir: this.#collectionDir({ spaceId, collectionId }),
                record: { kind: 'log' },
                write: () =>
                  atomicWriteFile({
                    filePath: this.#collectionLogPath({
                      spaceId,
                      collectionId
                    }),
                    data: JSON.stringify(log)
                  })
              })
              bytesWritten += collectionLog.length
            }

            // A collection-level policy travels with a newly-created collection; for
            // an existing (skipped) collection, leave its access policy untouched.
            if (collectionPolicy) {
              tallyPolicy(
                !collectionExisted &&
                  (await this.#importPolicy({
                    spaceId,
                    collectionId,
                    imported: collectionPolicy
                  }))
              )
            }

            const collectionDir = this.#collectionDir({ spaceId, collectionId })

            for (const { fileName, resourceId, body } of resources) {
              // Under the Resource's own write lock, as every other write path is:
              // the existence probe, the body write, and the sidecar write are one
              // atomic step. Without it a concurrent `PUT` of the same id can stamp
              // the sidecar (returning that `ETag` to its client) while the archive's
              // bytes land underneath, leaving a stored validator that describes
              // content nobody wrote.
              const imported = await this.#writeMutex.run(
                this.#resourceLockKey({ spaceId, collectionId, resourceId }),
                async () => {
                  // Skip anything the destination already has for this id: a
                  // sidecar, live or a `deleted:true` tombstone. Every committed
                  // write leaves one, so a representation file no sidecar names
                  // is a write that never committed, and the import writes over
                  // it. Skipping a tombstone keeps an import from writing content
                  // back over a soft-deleted Resource.
                  const resourceExists =
                    (await this.readMetaSidecar({
                      collectionDir,
                      resourceId
                    })) !== undefined
                  if (resourceExists) {
                    stats.resourcesSkipped++
                    // A resource-level policy travels with a newly-created resource only.
                    if (resourcePolicies.has(resourceId)) {
                      stats.policiesSkipped++
                    }
                    return false
                  }

                  await atomicWriteFile({
                    filePath: path.join(collectionDir, fileName),
                    data: body
                  })
                  bytesWritten += body.length
                  stats.resourcesCreated++

                  // A metadata sidecar travels with a newly-created resource
                  // (preserving its `createdAt`, `createdBy`, generations, and
                  // user-writable `custom`), re-stamped by this store's clock:
                  // its archived stamps are read for provenance only. A feed
                  // position is this server's own fact: any the archive
                  // carries is dropped, and the sidecar takes this
                  // Collection's next one. An entry with no sidecar, or with
                  // bytes that are not a JSON object, gets a fresh one built
                  // as a first write builds it (`createdAt` now, a new
                  // generation and stamp, no `createdBy`), so every imported
                  // Resource is served with a validator and appears in the
                  // changes feed. Its `contentType`, `fileName` and `digest`
                  // are taken from the file just written, whatever the
                  // archived sidecar carries, so the sidecar names and digests
                  // the file on this server.
                  const metadataBytes = resourceMetadata.get(resourceId)
                  await this.#importFileSidecar({
                    collectionDir,
                    resourceId,
                    archived: metadataBytes && parseSidecarBytes(metadataBytes),
                    contentType: parseResourceFileName(fileName).contentType,
                    fileName,
                    body,
                    feed: { spaceId, collectionId }
                  })
                  return true
                }
              )

              // The Resource's policy is written outside its lock: it lives in the
              // policy tree, not under the Resource's key, and `#importPolicy`
              // takes no Resource lock of its own. A policy record the
              // destination already holds there, a tombstone included, is kept.
              const resourcePolicy = resourcePolicies.get(resourceId)
              if (imported && resourcePolicy) {
                tallyPolicy(
                  await this.#importPolicy({
                    spaceId,
                    collectionId,
                    resourceId,
                    imported: resourcePolicy
                  })
                )
              }
            }

            // The policies of Resources another server backend imports are
            // written as the Collection's own policy is.
            for (const [
              resourceId,
              resourcePolicy
            ] of detachedResourcePolicies) {
              tallyPolicy(
                await this.#importPolicy({
                  spaceId,
                  collectionId,
                  resourceId,
                  imported: resourcePolicy
                })
              )
            }

            // Carry tombstones: a soft-deleted Resource (see `deleteResource`) exports
            // as a `.meta.` sidecar with no paired `r.` content file, so it never
            // appears in `resources` above. Restore each such ORPHAN sidecar that is a
            // tombstone (`deleted: true`) -- writing only the sidecar, which lands
            // under the tombstone name (`.tombstone.<id>.json`), re-creates the
            // tombstone. A non-tombstone orphan sidecar is anomalous (a Resource with
            // no representation) and is skipped. Merge semantics match resources:
            // anything the destination already has for that id (a live Resource or an
            // existing tombstone) is left untouched.
            const importedResourceIds = new Set(
              resources.map(r => r.resourceId)
            )
            for (const [resourceId, metadataBytes] of resourceMetadata) {
              if (importedResourceIds.has(resourceId)) {
                continue
              }
              const sidecar = parseSidecarBytes(metadataBytes)
              if (sidecar?.deleted !== true) {
                continue
              }
              // Under the Resource's write lock, as the content restore above is.
              await this.#writeMutex.run(
                this.#resourceLockKey({ spaceId, collectionId, resourceId }),
                async () => {
                  const exists =
                    (await this.readMetaSidecar({
                      collectionDir,
                      resourceId
                    })) !== undefined
                  if (exists) {
                    stats.resourcesSkipped++
                    return
                  }
                  // The tombstone takes this Collection's next feed position,
                  // and a fresh stamp, as the content restore above does.
                  await this.#writeFeedSidecar({
                    spaceId,
                    collectionId,
                    collectionDir,
                    resourceId,
                    sidecar: await restampImportedSidecar({
                      sidecar,
                      mint: () => this.#clock.mint()
                    })
                  })
                  bytesWritten += metadataBytes.length
                  stats.resourcesCreated++
                }
              )
            }

            // Restore chunks of chunked Resources (the `chunked-streams`
            // feature) into their per-Resource chunk directories.
            // Skip-not-overwrite, per chunk: an existing chunk representation
            // is left untouched, with its sidecar, so a re-import never
            // clobbers stored chunk bytes. Each restored chunk gets a sidecar
            // re-stamped by this store's clock, as a Resource's is. A chunk
            // whose archived sidecar is missing, or is not a JSON object, gets
            // a fresh one built as a first chunk write builds it (`createdAt`
            // now, a new generation and stamp), so every imported chunk is
            // served with a validator. A sidecar with no representation beside
            // it is dropped, since a chunk keeps no tombstone. An ORPHAN chunk
            // -- one whose parent Resource is absent or a tombstone (no live
            // representation on the destination after the Resource apply loop
            // above) -- is skipped rather than resurrected, matching the live
            // write path's parent-exists rule. The Postgres import applies the
            // same rules.
            const archivedChunkSidecars = new Map<string, Buffer>()
            for (const chunkFile of chunkFiles) {
              if (chunkFile.contentType === undefined) {
                archivedChunkSidecars.set(
                  `${chunkFile.resourceId}/${chunkFile.chunkIndex}`,
                  chunkFile.body
                )
              }
            }
            const parentIsLive = new Map<string, boolean>()
            for (const {
              resourceId,
              fileName,
              body,
              chunkIndex,
              contentType
            } of chunkFiles) {
              if (contentType === undefined) {
                continue
              }
              let live = parentIsLive.get(resourceId)
              if (live === undefined) {
                live =
                  (
                    await this.#readLiveFile({
                      collectionDir,
                      resourceId,
                      requestName: 'Import Space'
                    })
                  ).live !== undefined
                parentIsLive.set(resourceId, live)
              }
              if (!live) {
                continue
              }
              const chunkDir = this.#chunkDir({ collectionDir, resourceId })
              const target = this.#containedJoin(chunkDir, fileName)
              // The parent Resource's lock, which is what `writeChunk` /
              // `deleteChunk` serialize on, so a restore cannot interleave with a
              // live chunk write or resurrect a chunk a delete is removing.
              await this.#writeMutex.run(
                this.#resourceLockKey({ spaceId, collectionId, resourceId }),
                async () => {
                  // A stored chunk always has a sidecar, which names its file.
                  const present =
                    (await this.readMetaSidecar({
                      collectionDir: chunkDir,
                      resourceId: String(chunkIndex)
                    })) !== undefined
                  if (present) {
                    return
                  }
                  await mkdir(chunkDir, { recursive: true })
                  await atomicWriteFile({ filePath: target, data: body })
                  bytesWritten += body.length

                  const chunkId = String(chunkIndex)
                  const sidecarBytes = archivedChunkSidecars.get(
                    `${resourceId}/${chunkIndex}`
                  )
                  const archivedSidecar =
                    sidecarBytes && parseSidecarBytes(sidecarBytes)
                  // The chunk's `contentType`, `fileName` and `digest` come
                  // from the file just written, as a Resource's do.
                  await this.#importFileSidecar({
                    collectionDir: chunkDir,
                    resourceId: chunkId,
                    archived: archivedSidecar,
                    contentType,
                    fileName,
                    body
                  })
                  if (archivedSidecar) {
                    bytesWritten += sidecarBytes!.length
                  }
                }
              )
            }
          }

          // The archive's Collection tombstones, each written only when this
          // Space holds no record under its id, live or tombstoned, and no
          // directory content either: a tombstone never deletes or alters a
          // Collection the destination holds. It keeps the archived
          // generation and is re-stamped by this store's clock.
          for (const { collectionId, generation } of collectionTombstones) {
            await this.#writeMutex.run(
              this.#collectionMetaLockKey({ spaceId, collectionId }),
              async () => {
                if (
                  (await this.#readCollectionRecord({
                    spaceId,
                    collectionId
                  })) !== undefined ||
                  (await this.#hasCollectionMembers({ spaceId, collectionId }))
                ) {
                  return
                }
                await this.#ensureCollectionDir({ spaceId, collectionId })
                await this.#persistCollectionTombstone({
                  spaceId,
                  collectionId,
                  stamp: await this.#clock.mint(),
                  generation
                })
              }
            )
          }

          // The archive's Space-scoped zcap revocations are not part of the
          // plan. The handler verifies and installs them through
          // `insertRevocation` once this write has landed, since a chain may
          // carry a link signed by a `did:webvh` whose log the archive
          // restores (`lib/importRevocations.ts`).
          return stats
        } finally {
          // Book exactly what landed: the apply loop skips bodies the destination
          // already holds, and a count quota can abort it part-way, so the
          // reservation taken for the whole archive is corrected down to the bytes
          // actually written (zero on a fully-skipped re-import).
          reconcileByteReservation?.(bytesWritten)
        }
      }
    })
  }

  // Collections

  /**
   * Writes a Collection Metadata object (full replacement of the merged
   * object: the configuration members beside the annotation members `custom`
   * and `epoch`), under the Collection's one metadata lock, minting its write
   * stamp and resetting its local validator segment. Server-managed members
   * are set here: `createdBy` and `createdAt` by the creating write only, the
   * stamp members by every write.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionMetadata {CollectionMetadataInput}   the object
   *   to persist, or the request layer's composition callback, run atomically
   *   with the write against the prior object and the Collection's history
   *   log as of the lock
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Collection's `createdBy` on first write only
   * @param [options.ifMatch] {string}   an `If-Match` compare-and-swap on the
   *   current `ETag`; a stale validator throws `PreconditionFailedError` (412)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *`, the guarded
   *   create; an existing Collection throws `PreconditionFailedError` (412)
   * @returns {Promise<MetadataWriteResult<CollectionMetadata>>}   the
   *   Collection Metadata object's new validator (its `generation` and the
   *   stamp this write mints, local segment 0), whether the write created the
   *   Collection (a create over a tombstone included), and the stored object
   */
  async writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: input,
    createdBy,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    collectionMetadata: CollectionMetadataInput
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<MetadataWriteResult<CollectionMetadata>> {
    // Serialize the read-check-write under the per-Collection metadata lock so
    // the `If-Match` compare-and-swap and the stamp are atomic with the write
    // (two concurrent edits cannot clobber one another). A distinct lock
    // namespace from the per-Resource / unique-scan locks: a metadata write
    // and a Resource write touch different files. The Space gate wraps it, as
    // on every path-creating write: this one creates the Collection dir, so
    // the Space must still exist once the gate is held.
    //
    // The write runs on the gate's exclusive side, as a container removal
    // does: every Resource write of the Space in flight has landed before it
    // runs, and none starts before it is done. A composition that scans the
    // Collection's Resources (a `unique` declaration checks them for a
    // duplicate) therefore sees every stored Resource, and a Resource write
    // that starts after reads the declaration this write stores. Postgres
    // gives the same guarantee through its Space row lock.
    return this.#underSpaceWrite({
      spaceId,
      container: {},
      exclusive: true,
      write: () =>
        this.#writeMutex.run(
          this.#collectionMetaLockKey({ spaceId, collectionId }),
          async () => {
            // Prior object, read once and reused below: for the precondition,
            // the create-path quota check, the server-managed members, and the
            // CAS validator. A tombstone is no prior object: a write over it
            // is a create. Its members go first if a delete left any, so the
            // new life starts empty; every other write into a tombstoned
            // Collection is refused, so none can land meanwhile.
            const record = await this.#readCollectionRecord({
              spaceId,
              collectionId
            })
            const tombstoned = isCollectionTombstone(record)
            if (tombstoned) {
              await this.#removeCollectionMembers({ spaceId, collectionId })
            }
            const prior = tombstoned ? undefined : record

            // Guarded create (`If-None-Match: *`) or compare-and-swap on the
            // current `ETag` (`If-Match`), both opt-in: an existing Collection
            // or a stale validator throws 412. An unconditional write skips
            // this.
            assertCollectionWritePrecondition({
              collectionId,
              exists: prior !== undefined,
              currentEtag: metadataEtagOf(prior),
              ifMatch,
              ifNoneMatch
            })

            // The request layer's composition and its state-transition
            // checks (e.g. epoch append-only), run here against the object
            // just read under the lock, together with the governing history
            // log as of the same lock: a log write takes this lock first, so
            // the log cannot move between this read and the write below.
            const collectionMetadata = await resolveCollectionMetadataInput({
              input,
              prior,
              readLog: () => this.getCollectionLog({ spaceId, collectionId })
            })

            // Count quota (create path only): a new Collection must not push its
            // Space past `maxCollectionsPerSpace`; overwriting an existing
            // Collection's metadata never trips it.
            if (this.maxCollectionsPerSpace !== undefined && !prior) {
              const collectionIds = await this.#liveCollectionIds({ spaceId })
              if (collectionIds.length >= this.maxCollectionsPerSpace) {
                throw new CountQuotaExceededError({
                  scope: 'Collections per Space',
                  limit: this.maxCollectionsPerSpace
                })
              }
            }

            // The server-managed members are the backend's, never the body's;
            // both backends resolve them through the same shared rule
            // (lib/metadataWrite.ts), which discards the ones the wire input
            // may carry, validator-bearing and stamp members included. The
            // stamp is minted over the prior one.
            // The object keeps its generation for the Collection's whole life;
            // a Collection deleted and re-created under the same id mints a new
            // one, so the two lives' validators can never coincide. A create
            // over a tombstone still raises the clock to the tombstone's
            // stamp, so the new life's stamp sorts above the delete.
            const validator = await mintValidator({
              clock: this.#clock,
              prior: prior
                ? { generation: prior.metaGeneration, ...stampOf(prior) }
                : stampOf(record),
              local: 0
            })
            const { generation, stamp } = validator
            const stamped = stampCollectionMetadata({
              collectionMetadata,
              prior,
              createdBy,
              stamp
            })

            // The write takes the Collection's next feed position, so the
            // object surfaces in the changes feed.
            await this.#persistCollection({
              spaceId,
              collectionId,
              body: stamped,
              generation,
              local: 0,
              feedPosition: prior ? 'next' : 'first'
            })
            return {
              validator,
              created: prior === undefined,
              metadata: stamped
            }
          }
        )
    })
  }

  /**
   * Lock key serializing a Space's Metadata writes and its delete, so a
   * precondition check and the stamp are atomic against each other.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {string}
   */
  #spaceMetaLockKey({ spaceId }: { spaceId: string }): string {
    return `spacemeta:${spaceId}`
  }

  /**
   * Builds the per-Collection metadata serialization key for `#writeMutex`
   * (`cmeta:<spaceId>/<collectionId>`), so a Collection Metadata
   * compare-and-swap serializes with itself (and with the history-log write
   * that advances the same validator) while staying disjoint from the
   * per-Resource and unique-scan lock namespaces.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionMetaLockKey({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return `cmeta:${spaceId}/${collectionId}`
  }

  /**
   * Writes a Collection's metadata file (creating the Collection dir if
   * needed), with NO count-quota check and no server-managed-member
   * resolution: the caller hands over the body to store, its stamp members
   * already set. The count guard and the member rules live in the public
   * `writeCollection`; `importSpace` tracks the Space's Collection count
   * itself (measured once up front) and calls this directly with the
   * re-stamped archived object, so it does not re-enumerate the Space per
   * created Collection.
   *
   * A stamped write (a create, an update, an import) passes `feedPosition`,
   * so the file is written inside the critical section that takes a feed
   * position (`#takeFeedPosition`). The caller holds
   * the `cmeta:` key, which nests outside the `feed:` key. A log write's
   * local-segment advance passes none: it is not a write of the object, and
   * the log write runs it inside its own feed section. A create passes
   * `'first'`, so a counter left by a create cut short is not continued.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {CollectionMetadata}   the wire body to store, stamp
   *   members included
   * @param options.generation {string}
   * @param options.local {number}   the local validator segment
   * @param [options.feedPosition] {'next' | 'first'}   the feed position the
   *   write takes: the Collection's next one, or the feed's first when the
   *   write creates the Collection. Omitted, it takes none.
   * @returns {Promise<void>}
   */
  async #persistCollection({
    spaceId,
    collectionId,
    body,
    generation,
    local,
    feedPosition
  }: {
    spaceId: string
    collectionId: string
    body: CollectionMetadata
    generation: string
    local: number
    feedPosition?: 'next' | 'first'
  }): Promise<void> {
    const collectionDir = await this.#ensureCollectionDir({
      spaceId,
      collectionId
    })
    // The generation and local segment are kept OUT of the wire body, under
    // the reserved `_generation` / `_local` members that
    // `getCollectionMetadata` strips and re-surfaces as `metaGeneration` /
    // `metaLocal`.
    const writeFile = () =>
      atomicWriteFile({
        filePath: this.#collectionMetadataPath({ spaceId, collectionId }),
        data: JSON.stringify(
          embedMetadataValidator({ body, generation, local })
        )
      })
    if (feedPosition === undefined) {
      await writeFile()
      return
    }
    await this.#takeFeedPosition({
      spaceId,
      collectionId,
      collectionDir,
      record: { kind: 'collection-metadata' },
      startsFeed: feedPosition === 'first',
      write: writeFile
    })
  }

  /**
   * Writes a Collection tombstone over the Collection's Metadata file. The
   * caller holds the `cmeta:` lock and has made sure the Collection dir
   * exists. The file carries the generation and no local segment.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.stamp {WriteStamp}   the delete's write stamp
   * @param options.generation {string}   the Collection's generation
   * @returns {Promise<void>}
   */
  async #persistCollectionTombstone({
    spaceId,
    collectionId,
    stamp,
    generation
  }: {
    spaceId: string
    collectionId: string
    stamp: WriteStamp
    generation: string
  }): Promise<void> {
    await atomicWriteFile({
      filePath: this.#collectionMetadataPath({ spaceId, collectionId }),
      data: collectionTombstoneFile({ stamp, generation })
    })
  }

  /**
   * Builds the on-disk path for a Collection's Metadata file
   * (`.collection.meta.<collectionId>.json`) in its own Collection dir.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionMetadataPath({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return this.#containedJoin(
      this.#collectionDir({ spaceId, collectionId }),
      collectionMetadataFileName(collectionId)
    )
  }

  /**
   * Reads a Collection Metadata object: the one file holds the configuration
   * members beside `createdAt`, the stamp members, `custom`, and `epoch`, with
   * the generation and local segment re-surfaced out of band as
   * `metaGeneration` / `metaLocal`. A tombstoned Collection reads as absent.
   * Reading one is a touch of the Collection, so a delete left unfinished
   * under it is finished first (`#finishCascadeOnTouch`). Never call this
   * while holding the Space gate: use `#readLiveCollection` there.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionMetadata|undefined>}
   *   Resolves falsy when the Collection does not exist (must not throw).
   */
  async getCollectionMetadata({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionMetadata | undefined> {
    const record = await this.#readCollectionRecord({ spaceId, collectionId })
    if (!isCollectionTombstone(record)) {
      return record
    }
    await this.#finishCascadeOnTouch({ spaceId, collectionId })
    return undefined
  }

  /**
   * Reads a Collection's Metadata file in its stored form: the live
   * Collection Metadata object, its tombstone, or `undefined` when the
   * Collection has no Metadata file. The one low-level reader; every other
   * reader of the file goes through it.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionMetadata | StoredCollectionTombstone | undefined>}
   */
  async #readCollectionRecord({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<
    StoredCollectionMetadata | StoredCollectionTombstone | undefined
  > {
    const raw = await this.#readJsonFile<
      (CollectionMetadata | StoredCollectionTombstone) &
        EmbeddedMetadataValidator
    >(this.#collectionMetadataPath({ spaceId, collectionId }))
    return raw && storedMetadataFromFile(raw)
  }

  /**
   * Reads a live Collection Metadata object, `undefined` for an absent or
   * tombstoned Collection. Finishes nothing, so it is safe under the Space
   * gate and the per-Collection locks.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionMetadata | undefined>}
   */
  async #readLiveCollection({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionMetadata | undefined> {
    const record = await this.#readCollectionRecord({ spaceId, collectionId })
    return isCollectionTombstone(record) ? undefined : record
  }

  /**
   * Whether a Collection dir holds anything besides its Metadata file. Under
   * a tombstone, that is a delete left unfinished.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<boolean>}
   */
  async #hasCollectionMembers({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<boolean> {
    return (
      (await this.#listCollectionMembers({ spaceId, collectionId })).length > 0
    )
  }

  /**
   * Every entry of a Collection dir except its Metadata file. An absent dir
   * holds none.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<fs.Dirent[]>}
   */
  async #listCollectionMembers({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<fs.Dirent[]> {
    const metadataFile = collectionMetadataFileName(collectionId)
    return (
      await readDirEntries(this.#collectionDir({ spaceId, collectionId }))
    ).filter(entry => entry.name !== metadataFile)
  }

  /**
   * Whether a Collection holds a delete left unfinished: its Metadata file is
   * a tombstone and its dir still holds other entries. The tombstone check
   * comes first, so a live Collection costs one small file read and only a
   * tombstone's dir is listed. Takes no lock; each caller holds what its
   * context needs.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<boolean>}
   */
  async #hasInterruptedDelete({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<boolean> {
    return (
      isCollectionTombstone(
        await this.#readCollectionRecord({ spaceId, collectionId })
      ) && (await this.#hasCollectionMembers({ spaceId, collectionId }))
    )
  }

  /**
   * Removes everything in a Collection dir except its Metadata file: the
   * Resources and their sidecars, chunk dirs, policies, the governing history
   * log, the changes-feed counter, and any staging temp file. This is the
   * cascade of Delete Collection, run once the tombstone is durable. It is
   * idempotent, so a cascade cut short is finished by running it again. The
   * caller holds the exclusive side of the Space gate, or is the create that
   * replaces the tombstone under the shared side and the `cmeta:` lock;
   * either way no other write can land in the dir meanwhile, since every
   * other write into a tombstoned Collection is refused.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async #removeCollectionMembers({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<void> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const members = await this.#listCollectionMembers({
      spaceId,
      collectionId
    })
    try {
      await Promise.all(
        members.map(entry =>
          rm(path.join(collectionDir, entry.name), {
            recursive: true,
            force: true
          })
        )
      )
      this.#forgetStagingCredits({ under: collectionDir })
    } finally {
      // Freed bytes: drop the cached usage total so the next write
      // re-measures. After the removal, as `deleteResource` does. This
      // can run on the shared side of the Space gate, where dropping first
      // would let a concurrent write cache the pre-removal total for a full
      // TTL. A removal that failed part way has still freed bytes.
      this.#dropUsageCache({ spaceId })
    }
  }

  /**
   * Finishes a delete left unfinished under a tombstone, when a read finds
   * one: takes the exclusive side of the Space gate, re-reads the record, and
   * removes the members if it is still a tombstone with members. Holding the
   * gate keeps a concurrent create over the tombstone from losing members it
   * has just written. A read that raced a delete still running finds the
   * members gone once it has the gate, and does nothing.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async #finishCascadeOnTouch({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<void> {
    if (!(await this.#hasCollectionMembers({ spaceId, collectionId }))) {
      return
    }
    await this.#underSpaceRemoval({
      spaceId,
      remove: async () => {
        // The members seen before the gate may have belonged to a delete
        // still running, which held the gate and has removed them by now.
        if (await this.#hasInterruptedDelete({ spaceId, collectionId })) {
          this.logger.warn(
            { spaceId, collectionId },
            'Finishing an interrupted Collection delete'
          )
          await this.#removeCollectionMembers({ spaceId, collectionId })
        }
      }
    })
  }

  /**
   * Deletes a Collection, leaving a tombstone. The Metadata file is replaced
   * first, durably, by the tombstone: `deleted: true`, the Collection's
   * generation, and a stamp minted over the live record's. Then every other
   * entry in the Collection dir is removed. A process killed in between
   * leaves a tombstone beside members, which boot, the next read of the
   * Collection, or a create over it finishes. Over a tombstone nothing is
   * written: it finishes any members left and resolves `already-deleted`.
   * With no Metadata file it removes the directory, if one was left without
   * one, and resolves `absent`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<CollectionDeleteOutcome>}
   */
  async deleteCollection({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionDeleteOutcome> {
    // Under the Collection Metadata lock, for the same reason as
    // `deleteSpace`: a concurrent `writeCollection` must not overwrite the
    // tombstone with the deleted life's generation. And under the Space gate's
    // exclusive side, which excludes the Resource writes that would otherwise
    // land in this directory mid-cascade.
    return this.#underSpaceRemoval({
      spaceId,
      remove: () =>
        this.#writeMutex.run(
          this.#collectionMetaLockKey({ spaceId, collectionId }),
          async () => {
            const record = await this.#readCollectionRecord({
              spaceId,
              collectionId
            })
            if (record === undefined) {
              // A directory with no Metadata file (a create cut short between
              // its `mkdir` and its file write) is no Collection. It goes
              // whole, and no tombstone is left.
              this.#dropUsageCache({ spaceId })
              await rm(this.#collectionDir({ spaceId, collectionId }), {
                recursive: true,
                force: true
              })
              this.#forgetStagingCredits({
                under: this.#collectionDir({ spaceId, collectionId })
              })
              return 'absent'
            }
            if (isCollectionTombstone(record)) {
              await this.#removeCollectionMembers({ spaceId, collectionId })
              return 'already-deleted'
            }
            // The tombstone keeps the generation and takes a stamp above the
            // live record's.
            const { generation, stamp } = await mintValidator({
              clock: this.#clock,
              prior: { generation: record.metaGeneration, ...stampOf(record) }
            })
            await this.#persistCollectionTombstone({
              spaceId,
              collectionId,
              stamp,
              generation
            })
            await this.#removeCollectionMembers({ spaceId, collectionId })
            return 'deleted'
          }
        )
    })
  }

  /**
   * Builds the per-Collection history-log serialization key for
   * `#writeMutex`. A log write also takes the `cmeta:` lock first (a log write
   * advances the Collection Metadata validator, and the request layer's checks on
   * either side read the other record), so the two never interleave.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionLogLockKey({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return `clog:${spaceId}/${collectionId}`
  }

  /**
   * Builds the on-disk path for a Collection's governing history log
   * (`.collectionlog.<collectionId>.json`) in its own Collection dir.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionLogPath({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return this.#containedJoin(
      this.#collectionDir({ spaceId, collectionId }),
      collectionLogFileName(collectionId)
    )
  }

  /**
   * Reads a Collection's governing history log (the `governed-history-logs`
   * feature): the JSON Lines body verbatim with its own validator. Resolves
   * `undefined` when the Collection has no log.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<CollectionLogResult | undefined>}
   */
  async getCollectionLog({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionLogResult | undefined> {
    const stored = await this.#readCollectionLog({ spaceId, collectionId })
    return stored && collectionLogResultOf(stored)
  }

  /**
   * Reads a Collection Metadata object with the validator of its governing
   * history log, in two reads: the Metadata object first, then the log. A log
   * append advances the object's local segment, so its `ETag`. Read in the
   * other order, a read racing an append could pair the new `ETag` with the
   * validator of the old log, and every later conditional read would answer
   * 304 over the stale descriptors. In this order the worst case is the old
   * `ETag` over the new log, which the next revalidation replaces. The
   * Metadata read is `getCollectionMetadata`, so it finishes a torn delete as
   * that read does.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<CollectionMetadataAndLogValidator | undefined>}
   */
  async getCollectionMetadataAndLogValidator({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionMetadataAndLogValidator | undefined> {
    const collectionMetadata = await this.getCollectionMetadata({
      spaceId,
      collectionId
    })
    if (!collectionMetadata) {
      return undefined
    }
    const log = await this.getCollectionLog({ spaceId, collectionId })
    return {
      collectionMetadata,
      ...(log !== undefined && { logValidator: log.validator })
    }
  }

  /**
   * Reads a Collection's governing history log file in its stored layout, or
   * `undefined` when the Collection has no log.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionLog | undefined>}
   */
  async #readCollectionLog({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionLog | undefined> {
    return this.#readJsonFile<StoredCollectionLog>(
      this.#collectionLogPath({ spaceId, collectionId })
    )
  }

  /**
   * Replaces a Collection's governing history log (guarded create or
   * compare-and-swap append), under the Collection Metadata lock and then the
   * log lock: the precondition is evaluated on the log's current `ETag`, the
   * request layer's `assertTransition` runs against the log and Collection
   * Metadata object just read, the log's own stamp is minted, and that
   * object's local validator segment is advanced in the same critical
   * section, since its served `encryption` member is derived from this log's
   * head. The object's stamp is left alone: the change is derived, not a
   * write of the object. The log takes the Collection's next feed position
   * (the `feed:` key nests inside the `clog:` key), and the object takes
   * none. A byte-identical write writes nothing and takes no position.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {string}   the new JSON Lines body
   * @param [options.ifMatch] {string}   the log `ETag` the write is pinned to
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *` -- create only
   * @param [options.assertTransition] {Function}   the request layer's
   *   checks, run atomically with the write
   * @returns {Promise<EtagValidator | undefined>}   the log's new validator,
   *   or `undefined` when the Collection does not exist
   */
  async writeCollectionLog({
    spaceId,
    collectionId,
    body,
    ifMatch,
    ifNoneMatch,
    assertTransition
  }: {
    spaceId: string
    collectionId: string
    body: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    assertTransition?: (context: {
      prior?: CollectionLogResult
      collectionMetadata: StoredCollectionMetadata
    }) => void | Promise<void>
  }): Promise<EtagValidator | undefined> {
    // A guarded create can declare the Collection write-once, and a Resource
    // or chunk write decides that rule from the log it reads on the gate's
    // shared side (`#isWriteOnce`). So a write that may create the log takes
    // the exclusive side: every write to the Space in flight has finished, and
    // each later one reads the new log. An append cannot change the flag and
    // stays on the shared side. A log goes away only with its Collection,
    // which also takes the exclusive side, so a log seen here is still there
    // under the gate. One created after this check only makes the write below
    // an append that holds the gate exclusively.
    const logExists = await fileExists(
      this.#collectionLogPath({ spaceId, collectionId })
    )
    const underGate = <T>(write: () => Promise<T>): Promise<T> =>
      logExists
        ? this.#underSpaceWrite({ spaceId, write })
        : this.#underSpaceRemoval({ spaceId, remove: write })
    return underGate(() =>
      this.#writeMutex.run(
        this.#collectionMetaLockKey({ spaceId, collectionId }),
        () =>
          this.#writeMutex.run(
            this.#collectionLogLockKey({ spaceId, collectionId }),
            async () => {
              const collectionMetadata = await this.#readLiveCollection({
                spaceId,
                collectionId
              })
              if (!collectionMetadata) {
                return undefined
              }
              const prior = await this.#readCollectionLog({
                spaceId,
                collectionId
              })
              const { validator, changed } = await mintCollectionLogWrite({
                collectionId,
                collectionMetadata,
                prior,
                body,
                ifMatch,
                ifNoneMatch,
                assertTransition,
                clock: this.#clock
              })
              if (!changed) {
                return validator
              }
              const { generation, stamp } = validator
              await this.#persistCollectionLog({
                spaceId,
                collectionId,
                collectionMetadata,
                log: { generation, ...stamp, body }
              })
              return validator
            }
          )
      )
    )
  }

  /**
   * Stores a Collection's governing history log and advances the Collection
   * Metadata object's local validator segment, in one feed critical section.
   * The log takes the Collection's next feed position, and both files are
   * written inside that section, so a feed read sees either neither change or
   * both. The caller holds the `cmeta:` and `clog:` keys.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionMetadata {StoredCollectionMetadata}   the object
   *   as read under the `cmeta:` key
   * @param options.log {StoredCollectionLog}   the log to store, with its
   *   generation and stamp
   * @returns {Promise<void>}
   */
  async #persistCollectionLog({
    spaceId,
    collectionId,
    collectionMetadata,
    log
  }: {
    spaceId: string
    collectionId: string
    collectionMetadata: StoredCollectionMetadata
    log: StoredCollectionLog
  }): Promise<void> {
    await this.#takeFeedPosition({
      spaceId,
      collectionId,
      collectionDir: this.#collectionDir({ spaceId, collectionId }),
      record: { kind: 'log' },
      write: async () => {
        await atomicWriteFile({
          filePath: this.#collectionLogPath({ spaceId, collectionId }),
          data: JSON.stringify(log)
        })
        // The served Collection Metadata object changed with its derived
        // member, so its local validator segment advances (generation and
        // stamp kept); the stored body is carried verbatim. It is not a
        // write of the object, so it takes no feed position of its own.
        await this.#persistCollection({
          spaceId,
          collectionId,
          ...withLocalAdvanced(collectionMetadata)
        })
      }
    })
  }

  /**
   * Lists a Collection's Resources, OPTIONALLY cursor-paginated (spec
   * "Pagination"). Items are returned in a stable total order -- ascending by
   * `resourceId`, read straight from the `r.<resourceId>.<type>.<ext>` filename
   * (the keyset). A `cursor` resumes the scan at the first id strictly greater
   * than the cursor's anchor, so paging stays correct even if the anchor id was
   * deleted between pages; `limit` bounds the page (resolved within
   * `[1, MAX_PAGE_SIZE]`, default `DEFAULT_PAGE_SIZE`). `next` is built (and
   * present) only when a further page may follow.
   *
   * A Resource is listed only when its sidecar is live and names its file.
   * The page reads only the sidecars needed to fill it, and `totalItems`
   * counts every other id from the names in the directory listing: a live
   * sidecar name beside a representation file (`#countLiveListed`). A
   * tombstone (`.tombstone.<id>.json`) beside a file a crash left behind
   * does not count, and no sidecar outside the page is opened unless an id
   * holds both names. A sidecar on the page that does not parse leaves its
   * Resource out, with a `warn` line.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page's `next`
   * @returns {Promise<CollectionResourcesList>}
   */
  async listCollectionItems({
    spaceId,
    collectionId,
    limit,
    cursor,
    collectionMetadata: providedMetadata
  }: {
    spaceId: string
    collectionId: string
    limit?: number
    cursor?: string
    collectionMetadata?: CollectionMetadata
  }): Promise<CollectionResourcesList> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    // Prefer the caller's control-plane Collection Metadata object. When this
    // backend serves a Collection's data plane (an external backend), it does
    // NOT hold that object locally, so its own `getCollectionMetadata` would
    // resolve `undefined` and reading `.name`/`.type` off it would 500.
    const collectionMetadata =
      providedMetadata ??
      (await this.getCollectionMetadata({ spaceId, collectionId }))

    // Enumerate the Collection dir directly rather than globbing: glob v13 does
    // not sort, so its order is nondeterministic -- pagination needs a stable
    // keyset. The candidates are the representation files, which drops the
    // `.meta.` / `.collection.meta.` / policy dot-files.
    // An absent directory lists nothing (a Collection whose metadata file exists
    // but which holds no Resource yet). Any other failure -- `EACCES`, `EIO`,
    // `EMFILE` -- is a real fault and must surface: swallowing it would serve a
    // 200 with an empty listing for a Collection that provably exists, which a
    // replicating client reads as "every Resource was removed".
    const entries = await readDirEntries(collectionDir)
    // Parsed once, for the page and for the count.
    const representations = this.#representationEntries(entries)
    const names = this.#sidecarNames(entries)
    const filesById = new Map<string, RepresentationEntry[]>()
    for (const representation of representations) {
      const files = filesById.get(representation.resourceId) ?? []
      files.push(representation)
      filesById.set(representation.resourceId, files)
    }
    // Sort by `resourceId` ascending in code-unit order -- the SAME ordering
    // the cursor seek (`resourceId > after`) uses, so the keyset is consistent
    // (localeCompare could disagree with the `>` operator and break paging).
    const candidateIds = [...filesById.keys()].sort(compareCodeUnits)

    // Resolve `limit` within `[1, MAX_PAGE_SIZE]`, defaulting when absent,
    // then judge candidates by their sidecars from the cursor's seek point
    // (`resourceId` is the keyset) until `pageSize + 1` are live, the extra
    // one telling whether a further page follows. A candidate judged out
    // (`#judgeRepresentations`: a file no live sidecar names) does not
    // shrink the page, and only the sidecars needed to fill it are read.
    const pageSize = resolvePageSize(limit)
    const live: LiveRepresentation[] = []
    const judgedIds = new Set<string>()
    let next = seekStartIndex({
      items: candidateIds,
      cursor,
      keyOf: resourceId => resourceId
    })
    while (live.length <= pageSize && next < candidateIds.length) {
      // Each id yields at most one live entry, so this batch cannot overfill.
      const batch = candidateIds.slice(next, next + pageSize + 1 - live.length)
      next += batch.length
      for (const resourceId of batch) {
        judgedIds.add(resourceId)
      }
      const judged = await this.#judgeRepresentations({
        dir: collectionDir,
        representations: batch.flatMap(
          resourceId => filesById.get(resourceId) ?? []
        ),
        names
      })
      live.push(...judged.live)
    }
    const hasMore = live.length > pageSize
    const pageEntries = hasMore ? live.slice(0, pageSize) : live

    // `totalItems` counts the whole Collection, not the page: the judged ids
    // that are live, plus the live ids outside the judged span, counted from
    // the names in the listing (`#countLiveListed`), which opens no sidecar
    // outside the page unless an id there holds both a live sidecar and a
    // tombstone.
    const totalItems =
      live.length +
      (await this.#countLiveListed({
        dir: collectionDir,
        entries,
        representations,
        except: judgedIds
      }))

    // The shared item builder projects each page entry, with the sidecar it
    // was judged live by, onto the wire shape.
    const encrypted = suppressesItemNames({ collectionMetadata })
    const items = pageEntries.map(({ resourceId, contentType, sidecar }) =>
      collectionListingItem({
        spaceId,
        collectionId,
        resourceId,
        contentType,
        custom: sidecar.custom as ResourceMetadataCustom | undefined,
        epoch: sidecar.epoch,
        writerId: sidecar.writerId,
        encrypted
      })
    )

    return collectionResourcesList({
      spaceId,
      collectionId,
      collectionMetadata,
      totalItems,
      items,
      hasMore,
      pageSize
    })
  }

  // Resources

  /**
   * Writes a resource representation (JSON value or byte stream) to disk, under
   * the per-Resource write lock (the `conditional-writes` feature), and mints
   * the content record's write stamp over the one it replaces. The new
   * validator (that stamp under the Resource's `generation`) is returned so
   * the request layer can surface it as the response `ETag`.
   *
   * When a conditional-write precondition is supplied it is evaluated against
   * the Resource's current state atomically with the write (under the lock),
   * throwing `PreconditionFailedError` (412) on a mismatch:
   * - `ifNoneMatch` (a create-if-absent `If-None-Match: *`) fails if the
   *   Resource already exists.
   * - `ifMatch` (an update-if-unchanged `If-Match: "<etag>"`) fails if the
   *   Resource is absent or its current `ETag` does not equal `ifMatch`.
   * When both are supplied, `ifMatch` is evaluated first and then
   * `ifNoneMatch` (RFC 9110 section 13.2.2). The write proceeds only if both
   * hold, so neither header overrides the other.
   *
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.input {ResourceInput}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Resource's `createdBy` on first write only
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *` (create-if-absent)
   * @returns {Promise<EtagValidator>}   the Resource's new ETag validator
   */
  async writeResource({
    spaceId,
    collectionId,
    resourceId,
    input,
    createdBy,
    epoch,
    writerId,
    immutable,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
    createdBy?: IDID
    epoch?: string
    writerId?: string
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<ResourceWriteResult> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const lockKey = this.#resourceLockKey({
      spaceId,
      collectionId,
      resourceId
    })
    // Every branch below runs inside the Space gate's shared side (see
    // `#spaceGate`), and only once the gate has seen the Space and the
    // Collection still exist, so a container removal can neither land in the
    // middle of the write nor precede it unnoticed.
    const container = { collectionId, requestName: 'Write Resource' }
    const writeLocked = (
      assertUnique?: (prior?: MetaSidecar) => Promise<void>
    ) =>
      this.#writeMutex.run(lockKey, () =>
        this.#writeResourceLocked({
          spaceId,
          collectionId,
          collectionDir,
          resourceId,
          input,
          createdBy,
          epoch,
          writerId,
          immutable,
          assertUnique,
          ifMatch,
          ifNoneMatch
        })
      )

    // Two unique-attribute invariants can force a write to serialize on the
    // Collection lock before it takes its per-Resource lock: the EDV blinded
    // one (`unique: true` blinded attributes; the `blinded-index-query`
    // feature) and the plaintext equality one (a Collection's `unique`-declared
    // `plaintext.indexes`; the `equality-query` feature). Only a JSON content
    // write can create either claim, so only such writes pay for it: they
    // serialize per
    // Collection (the outer lock, so two racing claimants cannot both pass the
    // scan), evaluate the conflict against the Collection's other live
    // documents, then take the ordinary per-Resource lock nested inside.
    // Distinct-key nesting cannot deadlock: plain writes never hold a Resource
    // key while waiting on a Collection key. The two conditions are unified so a
    // write carrying both claims acquires the Collection lock exactly once.
    // The scan itself runs inside the per-Resource lock (`assertUnique`), where
    // the write-once rule is decided first: a write that rule answers stores
    // nothing, so it claims nothing and skips the scan.
    // The declarations come from the Collection Metadata object the Space
    // gate hands over, read under the gate: a declaring Metadata write runs
    // on the gate's exclusive side, so it either landed before this read, and
    // binds this write, or waits until this write is done and scans it.
    return this.#underSpaceWrite({
      spaceId,
      container,
      write: collection => {
        const uniqueIndexes = declaredUniqueIndexesOf({
          collectionMetadata: collection
        })
        const { blindedUnique, equalityUnique } = uniqueClaimsOf({
          input,
          uniqueIndexes
        })
        if (!blindedUnique && !equalityUnique) {
          return writeLocked()
        }
        return this.#writeMutex.run(
          this.#collectionLockKey({ spaceId, collectionId }),
          () =>
            writeLocked(async prior => {
              // One Collection scan serves both claims. The equality candidate set
              // is the richer of the two (it also carries blobs and each sidecar's
              // `custom`), so when the equality claim needs it the blinded
              // candidates -- the live, parsable JSON documents -- are derived from
              // it rather than re-read. A blinded-only claim reads JSON documents
              // only, and the sidecars that judge them live.
              const candidates = await this.#readEqualityCandidates({
                spaceId,
                collectionId,
                excludeResourceId: resourceId,
                jsonOnly: !equalityUnique
              })
              if (blindedUnique) {
                assertNoUniqueBlindedConflict({
                  document: input.kind === 'json' ? input.data : undefined,
                  candidates: jsonCandidatesFrom(candidates)
                })
              }
              if (equalityUnique) {
                // A content write does not change the Resource's `custom`, so the
                // custom side of the claim comes from the CURRENT stored sidecar,
                // which the write read under its lock (`prior`).
                assertNoUniqueEqualityConflict({
                  indexes: uniqueIndexes,
                  content: input.kind === 'json' ? input.data : undefined,
                  custom: prior?.custom,
                  candidates
                })
              }
            })
        )
      }
    })
  }

  /**
   * The critical section of `writeResource`, run under the per-Resource lock:
   * decides whether the write-once rule applies, runs the unique-claim scan
   * when it does not (`assertUnique`, passed by a write that holds the
   * Collection lock), evaluates any precondition, applies the write-once
   * rule, writes the representation, prunes a stale
   * representation under a different content-type, and persists the new
   * stamp in the sidecar. See `writeResource` for the parameters.
   * @returns {Promise<ResourceWriteResult>}
   */
  async #writeResourceLocked({
    spaceId,
    collectionId,
    collectionDir,
    resourceId,
    input,
    createdBy,
    epoch,
    writerId,
    immutable,
    assertUnique,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
    input: ResourceInput
    createdBy?: IDID
    epoch?: string
    writerId?: string
    immutable?: true | ImmutableUnder
    assertUnique?: (prior?: MetaSidecar) => Promise<void>
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<ResourceWriteResult> {
    const filename = fileNameFor({ resourceId, contentType: input.contentType })
    const filePath = this.#containedJoin(collectionDir, filename)

    // A chunk swap a fault left torn is finished first, so the sidecar read
    // below is the Resource's settled state and a chunk set the swap moved
    // in is never taken for one left beside a tombstone.
    await this.#settleStaging({
      spaceId,
      collectionId,
      collectionDir,
      resourceId,
      discardUnswapped: false
    })
    // One sidecar read serves every step below, with no directory listing.
    // Nothing else mutates this Resource while the lock is held, so the
    // precondition check, the create-path liveness probe, the prune, and the
    // stamp all work from this single pre-write snapshot. A live sidecar
    // names the live representation by `fileName`. No sidecar, or a
    // tombstone, means no live Resource stands: a representation file beside
    // it is a write torn between its bytes and its sidecar, which never
    // committed, so this write is a create.
    const located = await this.#readLiveFile({
      collectionDir,
      resourceId,
      requestName: 'Write Resource'
    })
    const { prior, live } = located
    // The write creates the Resource unless a live one stands, and the
    // sidecar of that live Resource is the only prior provenance it keeps.
    const livePrior = live?.sidecar

    // The write-once rule binds a write over a live Resource, and a write
    // over a tombstone that kept the deleted content's digest. A tombstone
    // with no digest (one an import or a replica apply wrote with no bytes to
    // digest) holds nothing to compare, so a write over it is an ordinary
    // create.
    const held = heldForWriteOnce(prior)
    const writeOnce =
      held !== undefined &&
      (await this.#isWriteOnce({
        spaceId,
        collectionId,
        immutable
      }))
    if (!writeOnce) {
      await assertUnique?.(prior)
    }
    // A write over a tombstone creates the Resource, which holds no chunks.
    await this.#clearChunksBesideTombstone({
      collectionDir,
      resourceId,
      prior
    })

    // Evaluate any conditional-write precondition against the current state
    // before writing (still inside the lock, so the check and write are atomic).
    if (ifMatch !== undefined || ifNoneMatch !== undefined) {
      await this.#assertWritePrecondition({
        collectionDir,
        resourceId,
        ifMatch,
        ifNoneMatch,
        state: located
      })
    }

    // A write-once Collection: over a live Resource or a tombstone, only a
    // repeat of the stored digest passes, and it writes nothing. Over a
    // tombstone the repeat answers the tombstone's validator and the Resource
    // stays deleted; it is also the only write the id takes again, so it
    // reclaims a file a delete cut short left beside the tombstone, which a
    // create would otherwise reclaim. A live sidecar that carries no stamp is
    // damaged, and the repeat repairs it: the bytes stay, and the sidecar is
    // stamped below.
    let digest: string
    if (writeOnce) {
      const repeat = await this.#answerImmutableRepeat({
        sidecar: held,
        filePath: live?.filePath,
        input,
        requestName: 'Write Resource'
      })
      digest = repeat.digest
      if (repeat.validator !== undefined) {
        await this.#reclaimBesideTombstone({
          collectionDir,
          resourceId,
          prior
        })
        return {
          validator: repeat.validator,
          created: false,
          members: await this.#writtenMembers({
            filePath: live?.filePath,
            sidecar: held
          })
        }
      }
    } else {
      digest = await this.#writeRepresentationBytes({
        spaceId,
        filePath,
        input
      })
    }
    // A write-once repeat wrote no bytes, so the stored file is the live one,
    // whose name may carry other media type parameters. A tombstone with a
    // validator never reaches here: its repeat was answered above.
    const storedPath = writeOnce ? live!.filePath : filePath

    // The sidecar is the write's commit point: it is written after the new
    // representation is in place and before any prior one is pruned, and it
    // names the file it commits by `fileName`, so at every step the name it
    // records is a file on disk. A crash before it leaves the prior sidecar
    // naming the prior file, still present; a crash after it leaves a stale
    // prior file the sidecar no longer names.
    //
    // Maintain the server-managed timestamps and the ETag validator: a content
    // write sets `createdAt` on first write, mints a new content stamp over
    // the prior one and keeps the Resource's `generation` (minting one only
    // on the first write), preserving any user-writable `custom` and the
    // independent `/meta` record (`meta`) already stored in the sidecar (a
    // content write does not touch the metadata sub-resource).
    //
    // `createdBy` pairs with `createdAt`: both are taken from this write when
    // it creates the Resource, so they name the creator rather than the last
    // writer, and are preserved verbatim by every update -- including
    // preserved-as-absent, so a Resource created with no invoker never has a
    // later writer backfilled into it. A write over a tombstone is a create
    // and records fresh provenance: the tombstone's creator and creation time
    // belong to the deleted Resource.
    //
    // The sidecar write takes the Collection's next feed position, which
    // moves the Resource to the end of the changes feed.
    const { validator, sidecar } = await this.#stampSidecar({
      collectionDir,
      resourceId,
      prior,
      feed: { spaceId, collectionId },
      build: ({ prior, generation, stamp }) => {
        const creator = livePrior ? livePrior.createdBy : createdBy
        return {
          createdAt: livePrior?.createdAt ?? stamp.updatedAt,
          ...stamp,
          ...(creator !== undefined && { createdBy: creator }),
          generation,
          ...(prior?.meta !== undefined && { meta: prior.meta }),
          ...(prior?.custom && { custom: prior.custom }),
          // The stored file's name, which a read opens, and the type it
          // carries. A write-once repeat wrote no bytes, so both are read off
          // the live file (`storedPath`), and its digest is the stored one.
          ...sidecarFileMembers(storedPath),
          digest,
          // The key-epoch stamp is set from this write's declaration and CLEARED
          // when absent (the new ciphertext's epoch is unknown -- a stale stamp
          // is worse than none), so it is NOT preserved from `prior` like
          // `custom`.
          ...(epoch !== undefined && { epoch }),
          // The writer-attribution label is likewise set from this write's
          // declaration and CLEARED when absent (declare-or-clear), so it is
          // NOT preserved from `prior`.
          ...(writerId !== undefined && { writerId })
        }
      }
    })

    if (!writeOnce) {
      // A Resource has a single current representation: remove the prior one
      // when it was stored under a different content-type
      // (write-new-then-prune), now that the sidecar names the new one.
      await this.#removeReplacedFile({
        priorPath: live?.filePath,
        keepPath: filePath
      })
      // A create over a tombstone reclaims any file a crash left beside it.
      await this.#reclaimBesideTombstone({
        collectionDir,
        resourceId,
        prior,
        keepPath: filePath
      })
    }
    return {
      validator,
      created: live === undefined,
      members: await this.#writtenMembers({ filePath: storedPath, sidecar })
    }
  }

  /**
   * The server-managed members of a Resource Metadata object as a write
   * left them, read under the write's lock: the media type the stored file
   * name carries, the stored file's size, and the sidecar's provenance and
   * stamps. A write-once repeat over a tombstone names no file: it answers
   * the tombstone's media type and a size of 0.
   * @param options {object}
   * @param [options.filePath] {string}   the live representation file
   * @param options.sidecar {MetaSidecar}   its sidecar as the write left it
   * @returns {Promise<ResourceWriteMembers>}
   */
  async #writtenMembers({
    filePath,
    sidecar
  }: {
    filePath?: string
    sidecar: MetaSidecar
  }): Promise<ResourceWriteMembers> {
    const { contentType, size } =
      filePath === undefined
        ? { contentType: sidecar.contentType, size: 0 }
        : {
            contentType: parseResourceFileName(path.basename(filePath))
              .contentType,
            size: (await fsStat(filePath)).size
          }
    return {
      contentType,
      size,
      ...(sidecar.createdAt !== undefined && { createdAt: sidecar.createdAt }),
      ...stampOf(sidecar),
      ...(sidecar.createdBy !== undefined && { createdBy: sidecar.createdBy }),
      ...(sidecar.meta !== undefined && { meta: sidecar.meta })
    }
  }

  /**
   * Whether the write-once rule binds a write into the Collection. The
   * request layer's `immutable: true` was read before this write's lock. A
   * recheck callback instead decides from the governing history log read
   * here, inside the Space gate's shared side. A log's guarded create runs on
   * the gate's exclusive side (see `writeCollectionLog`), so none can land
   * between this read and the end of the write.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.immutable] {true | ImmutableUnder}
   * @returns {Promise<boolean>}
   */
  async #isWriteOnce({
    spaceId,
    collectionId,
    immutable
  }: {
    spaceId: string
    collectionId: string
    immutable?: true | ImmutableUnder
  }): Promise<boolean> {
    return resolveWriteOnce({
      immutable,
      readLog: async () => {
        const stored = await this.#readCollectionLog({ spaceId, collectionId })
        return stored && collectionLogResultOf(stored)
      }
    })
  }

  /**
   * The write-once rule over a stored record (a live Resource, a chunk inside
   * its chunk dir, or a Resource tombstone that kept its digest), run under
   * the item's lock: a write whose media type and content digest equal the
   * record's answers the record's validator and writes nothing, and any other
   * write is refused with `ResourceImmutableError` (409). The incoming body
   * is digested as a write would store it, through the upload cap. Over a
   * live record the stored file's size is compared first, so a body of
   * another length is refused before it is read. No stored bytes are read
   * unless the live sidecar carries no `digest` (a damaged sidecar), which is
   * compared through a digest of the stored file instead. The resolved
   * `validator` is `undefined` for a repeat over a live record whose sidecar
   * carries no validator, which the caller answers by stamping one, with the
   * resolved `digest`.
   * @param options {object}
   * @param options.sidecar {MetaSidecar}   the record's sidecar
   * @param [options.filePath] {string}   the live record's stored file,
   *   absent over a tombstone
   * @param options.input {ResourceInput}
   * @param options.requestName {string}   names the refused operation
   * @returns {Promise<{ validator: EtagValidator | undefined, digest: string }>}
   */
  async #answerImmutableRepeat({
    sidecar,
    filePath,
    input,
    requestName
  }: {
    sidecar: MetaSidecar
    filePath?: string
    input: ResourceInput
    requestName: string
  }): Promise<{ validator: EtagValidator | undefined; digest: string }> {
    if (!sameMediaType(sidecar.contentType, input.contentType)) {
      throw new ResourceImmutableError({ requestName })
    }
    const storedBytes =
      filePath === undefined ? undefined : (await fsStat(filePath)).size
    const incoming = await this.#inputDigest({ input, storedBytes })
    // `heldForWriteOnce` holds a tombstone only with its digest, so a record
    // with none is live and `filePath` names its file.
    const digest =
      sidecar.digest ??
      (await streamDigestOf({ stream: fs.createReadStream(filePath!) }))
    if (incoming !== digest) {
      throw new ResourceImmutableError({ requestName })
    }
    return { validator: validatorOf({ ...sidecar }), digest }
  }

  /**
   * The content digest a write of `input` would record: a JSON body as the
   * serialization a write stores, a binary body as read through the upload
   * cap, so an over-cap body is a 413 here as it would be on a write. Given
   * the stored size, a body of another length (a JSON body's serialized
   * length, a binary body's declared size) is answered `undefined` without
   * being read.
   * @param options {object}
   * @param options.input {ResourceInput}
   * @param [options.storedBytes] {number}   the stored file's size
   * @returns {Promise<string | undefined>}
   */
  async #inputDigest({
    input,
    storedBytes
  }: {
    input: ResourceInput
    storedBytes?: number
  }): Promise<string | undefined> {
    const { maxUploadBytes } = this
    if (input.kind === 'json') {
      const serialized = storedJsonBytes(input.data)
      this.#assertUploadSize({ maxUploadBytes, uploadBytes: serialized.length })
      if (storedBytes !== undefined && serialized.length !== storedBytes) {
        return undefined
      }
      return contentDigestOf(serialized)
    }
    this.#assertUploadSize({ maxUploadBytes, uploadBytes: input.declaredBytes })
    if (
      storedBytes !== undefined &&
      input.declaredBytes !== undefined &&
      input.declaredBytes !== storedBytes
    ) {
      return undefined
    }
    return streamDigestOf({
      stream: input.stream,
      guards: this.#uploadCapGuards()
    })
  }

  /**
   * The streaming guard for the per-upload cap: one transform that fails the
   * stream with `PayloadTooLargeError` (413) at the byte that crosses
   * `maxUploadBytes`, or none when no cap is configured. It bounds a body
   * whose size is omitted or understated.
   * @returns {Transform[]}
   */
  #uploadCapGuards(): Transform[] {
    const { maxUploadBytes } = this
    if (maxUploadBytes === undefined) {
      return []
    }
    return [
      this.#byteLimitGuard({
        limitBytes: maxUploadBytes,
        error: new PayloadTooLargeError({
          maxUploadBytes,
          backendId: this.describe().id
        })
      })
    ]
  }

  /**
   * Writes a representation body (JSON value or byte stream) to `filePath`,
   * applying the same size guards every write path shares: the per-upload cap
   * (413 `PayloadTooLargeError`) and, when a byte quota is configured, the
   * Space headroom (507). A JSON body is fully in memory, so its size is checked
   * up front and written atomically; a binary body is streamed through the cap /
   * quota guards into a temp file and durably committed (fsync + rename + dir
   * fsync), removing the partial file on any failure. Shared by the Resource
   * write path (`#writeResourceLocked`) and the chunk write path
   * (`#writeChunkLocked`); the caller has already resolved `filePath` and ensured
   * its parent directory exists for the streamed case. Resolves the content
   * digest of the bytes written, which the caller records on the sidecar: a
   * JSON body's over its serialization, a binary body's taken as the bytes
   * flow into the file.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.filePath {string}   absolute path of the representation file
   * @param options.input {ResourceInput}
   * @param [options.creditBytes] {number}   bytes the write frees later, which
   *   the Space headroom check counts as free (a staged chunk credits the
   *   live chunk its swap replaces)
   * @returns {Promise<string>}   the content digest of the stored bytes
   */
  async #writeRepresentationBytes({
    spaceId,
    filePath,
    input,
    creditBytes
  }: {
    spaceId: string
    filePath: string
    input: ResourceInput
    creditBytes?: number
  }): Promise<string> {
    const { capacityBytes, maxUploadBytes } = this

    if (input.kind === 'json') {
      // JSON bodies are fully in memory, so their serialized size is known up
      // front and the pre-flight checks alone suffice (no streaming guard). The
      // per-upload cap (413) is checked before the cumulative quota (507).
      // Serialize once and reuse for the size pre-flight, the digest and the
      // write.
      const serialized = storedJsonBytes(input.data)
      const incomingBytes = serialized.length
      this.#assertUploadSize({ maxUploadBytes, uploadBytes: incomingBytes })
      let releaseByteReservation: (() => void) | undefined
      if (capacityBytes !== undefined) {
        ;({ release: releaseByteReservation } = await this.#assertSpaceHeadroom(
          {
            spaceId,
            capacityBytes,
            incomingBytes,
            creditBytes
          }
        ))
      }
      // Write the serialized JSON bytes as they are. The read path
      // (`getResource`) streams them back verbatim, so any top-level JSON
      // value -- object, array, or bare primitive (`null`, `false`, `0`, `""`)
      // -- round-trips.
      // The Collection dir exists: `writeResource` checked its Metadata object
      // under the Space gate, and no removal can land before this write ends.
      this.logger.info('Creating JSON resource')
      try {
        // Durable, atomic replacement (write-temp + fsync + rename + dir fsync):
        // the final path never observes a torn write, even across a crash.
        await atomicWriteFile({ filePath, data: serialized })
      } catch (err) {
        // The bytes never landed: give the quota reservation back.
        releaseByteReservation?.()
        throw err
      }
      return contentDigestOf(serialized)
    } else {
      this.logger.info('Writing blob')
      // Pre-flight the declared size (when present) against the per-upload cap,
      // then stream through guards that hard-cap a body whose size is omitted or
      // understated: the upload cap (413) and, when a quota is configured, the
      // Space headroom (507). On overflow either guard removes the partial file
      // before surfacing the error.
      this.#assertUploadSize({
        maxUploadBytes,
        uploadBytes: input.declaredBytes
      })
      const guards = this.#uploadCapGuards()
      let releaseByteReservation: (() => void) | undefined
      let reconcileByteReservation: ((actualBytes: number) => void) | undefined
      if (capacityBytes !== undefined) {
        const { headroom, release, reconcile } =
          await this.#assertSpaceHeadroom({
            spaceId,
            capacityBytes,
            // A body with no declared size reserves nothing up front; the
            // streaming guard below bounds it to the remaining headroom, and
            // `reconcile` books the bytes it actually wrote once it lands.
            incomingBytes: input.declaredBytes ?? 0,
            creditBytes
          })
        releaseByteReservation = release
        reconcileByteReservation = reconcile
        guards.push(
          this.#byteLimitGuard({
            limitBytes: headroom,
            error: new QuotaExceededError({ spaceId, capacityBytes })
          })
        )
      }
      // Stream into a temp file in the same directory, then durably commit it
      // (fsync + rename + dir fsync) once the whole body has been written and
      // verified. Streaming to the final path directly would expose a truncated
      // representation under the resource's name if the process crashed
      // mid-stream; staging + rename makes the resource appear only whole.
      const tempPath = tempPathFor(filePath)
      // The digest is taken as the bytes flow into the file, after the
      // guards, so it covers exactly what the file received.
      const { tap, digest } = digestTap()
      try {
        await pipeline([
          input.stream,
          ...guards,
          tap,
          fs.createWriteStream(tempPath)
        ])
        // Correct the reservation to the size actually written BEFORE the
        // commit: `declaredBytes` was absent (nothing reserved) or understated,
        // and the snapshot must carry these bytes or the next write inside the
        // same TTL is admitted against a total that never moved.
        if (reconcileByteReservation !== undefined) {
          reconcileByteReservation((await fsStat(tempPath)).size)
        }
        await commitTempFile({ tempPath, filePath })
        return await digest
      } catch (err) {
        // Remove the partial file on ANY failure: a guard rejection (413/507),
        // an aborted upload, or a streamed `Digest` mismatch (the request layer
        // verifies the body's digest as it flows). A failed write must not leave
        // a truncated or unverified representation behind. Only the temp path is
        // ever staged into, so a failed write never touches the final path.
        await rm(tempPath, { force: true })
        // The bytes never landed: give the quota reservation back.
        releaseByteReservation?.()
        throw err
      }
    }
  }

  /**
   * The stamped sidecar tail shared by `#writeResourceLocked`,
   * `#writeChunkLocked` and an import's fresh sidecar: resolves the item's
   * ETag validator -- the `generation` it already carries (minted here on a
   * first write) with a new stamp from the store's clock, minted over the
   * prior stamp so it sorts above it -- builds the new sidecar via `build`,
   * writes it, and returns the validator. The write paths fill in different
   * fields -- a chunk carries no user Metadata / `createdBy` / epoch stamp --
   * so `build` supplies the sidecar body from the shared
   * `{ prior, generation, stamp }` inputs and MUST write the `generation` and
   * `stamp` it is handed into the sidecar. The caller passes the item's
   * current sidecar in, since it has already read it under the same lock. A
   * Resource write passes `feed`, so the sidecar takes the Collection's next
   * feed position (`#writeFeedSidecar`); a chunk write passes none. Resolves
   * the validator beside the sidecar as written.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the sidecar lives in (a
   *   Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the sidecar id (a resourceId, or the
   *   stringified chunk index)
   * @param [options.prior] {MetaSidecar}   the item's current sidecar, absent
   *   when it has none yet
   * @param options.build {(context: { prior?: MetaSidecar, generation: string,
   *   stamp: WriteStamp }) => MetaSidecar}   builds the sidecar to persist
   *   from the prior sidecar, the resolved `generation`, and the new stamp
   * @param [options.feed] {object}   the Resource's Collection, whose next
   *   feed position the sidecar takes; absent for a chunk
   * @param options.feed.spaceId {string}
   * @param options.feed.collectionId {string}
   * @returns {Promise<{ validator: EtagValidator, sidecar: MetaSidecar }>}
   */
  async #stampSidecar({
    collectionDir,
    resourceId,
    prior,
    feed,
    build
  }: {
    collectionDir: string
    resourceId: string
    prior?: MetaSidecar
    feed?: { spaceId: string; collectionId: string }
    build: (context: {
      prior?: MetaSidecar
      generation: string
      stamp: WriteStamp
    }) => MetaSidecar
  }): Promise<{ validator: EtagValidator; sidecar: MetaSidecar }> {
    // The generation is minted once, at the item's first write, and kept for
    // its whole life -- through a Resource tombstone and its re-create, since
    // the record continues there. A sidecar removed outright (a chunk delete)
    // takes it along, so the next item under that id starts fresh.
    const validator = await mintValidator({ clock: this.#clock, prior })
    const { generation, stamp } = validator
    const sidecar = build({ prior, generation, stamp })
    if (feed) {
      await this.#writeFeedSidecar({
        ...feed,
        collectionDir,
        resourceId,
        sidecar,
        prior
      })
    } else {
      await this.#writeMetaSidecar({ collectionDir, resourceId, sidecar })
    }
    return { validator, sidecar }
  }

  /**
   * Writes the sidecar of a Resource or chunk file an import just stored. An
   * archived sidecar is re-stamped by this store's clock (its archived stamps
   * are read for provenance only). With none, a fresh one is built as a first
   * write builds it (`createdAt` now, a new generation and stamp, no
   * `createdBy`). Either way its `contentType`, `fileName` and `digest` are
   * the file's, so the sidecar names and digests the file on this server,
   * whatever the archived sidecar carries.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the file lives in (a
   *   Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   a resourceId, or a chunk index
   * @param [options.archived] {MetaSidecar}   the archived sidecar, when the
   *   archive carries one that is a JSON object
   * @param options.contentType {string}   the type the stored file name carries
   * @param options.fileName {string}   the stored file's basename
   * @param options.body {Buffer}   the file's bytes, which the sidecar digests
   * @param [options.feed] {object}   the Resource's Collection, whose next
   *   feed position the sidecar takes; absent for a chunk
   * @param options.feed.spaceId {string}
   * @param options.feed.collectionId {string}
   * @returns {Promise<void>}
   */
  async #importFileSidecar({
    collectionDir,
    resourceId,
    archived,
    contentType,
    fileName,
    body,
    feed
  }: {
    collectionDir: string
    resourceId: string
    archived?: MetaSidecar
    contentType: string
    fileName: string
    body: Buffer
    feed?: { spaceId: string; collectionId: string }
  }): Promise<void> {
    // The digest of the bytes written, whatever the archive carries
    // (`restampImportedSidecar` drops an archived one).
    const digest = await contentDigestOf(body)
    if (!archived) {
      await this.#stampSidecar({
        collectionDir,
        resourceId,
        feed,
        build: ({ generation, stamp }) => ({
          createdAt: stamp.updatedAt,
          ...stamp,
          generation,
          contentType,
          fileName,
          digest
        })
      })
      return
    }
    const sidecar = {
      ...(await restampImportedSidecar({
        sidecar: { ...archived, contentType },
        mint: () => this.#clock.mint()
      })),
      fileName,
      digest
    }
    if (feed) {
      await this.#writeFeedSidecar({
        ...feed,
        collectionDir,
        resourceId,
        sidecar
      })
    } else {
      await this.#writeMetaSidecar({ collectionDir, resourceId, sidecar })
    }
  }

  /**
   * Builds the per-Resource serialization key for `#writeMutex`
   * (`<spaceId>/<collectionId>/<resourceId>`), so conditional writes to distinct
   * Resources run concurrently while writes to the same Resource are ordered.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #resourceLockKey({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): string {
    return `${spaceId}/${collectionId}/${resourceId}`
  }

  /**
   * The Collection-level mutex key, held by unique-blinded-attribute writes to
   * serialize their conflict scans. Namespaced (`unique:` prefix) so it can
   * never collide with a per-Resource key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #collectionLockKey({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return `unique:${spaceId}/${collectionId}`
  }

  /**
   * The Collection's changes-feed mutex key (`feed:` prefix, distinct from
   * the per-Resource and `unique:` key domains). Held only for the short
   * critical section that takes the next feed position and writes the record
   * that takes it (`#takeFeedPosition`), and by `changesSince` to read the
   * counter with the Collection dir listing, the Collection Metadata object,
   * the governing log and the policy files. It is
   * the innermost lock: taken inside a Resource key or the `cmeta:` and
   * `clog:` keys, and nothing is acquired while it is held, so it cannot
   * deadlock.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #feedLockKey({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): string {
    return `feed:${spaceId}/${collectionId}`
  }

  /**
   * The path of a Collection's changes-feed counter
   * (`.feed.<collectionId>.json`, holding a `FeedCounter`) in its Collection
   * dir. A dot-file, so the Resource listings and scans,
   * which read `r.` files and `.meta.` sidecars only, never see it; export
   * leaves it out. It is removed with the Collection dir, so a Collection
   * re-created under the same id, by hand or by an import, starts its feed at
   * 1 again under a fresh generation. The request layer puts the generation
   * in the wire checkpoint, so a checkpoint held from before the re-create is
   * refused rather than read as a position in the new feed, which would skip
   * everything written at or below it.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.collectionId {string}
   * @returns {string}
   */
  #feedCounterPath({
    collectionDir,
    collectionId
  }: {
    collectionDir: string
    collectionId: string
  }): string {
    return this.#containedJoin(collectionDir, feedCounterFileName(collectionId))
  }

  /**
   * Reads a Collection's feed counter: the last feed position handed out, 0
   * when none has been, and the counter's generation, absent until the first
   * position. Its `records` hold the latest position the Collection Metadata
   * object and the governing history log took, each absent until that record
   * took one. Callers hold the Collection's `feed:` key.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.collectionId {string}
   * @returns {Promise<FeedCounter>}
   */
  async #readFeedCounter({
    collectionDir,
    collectionId
  }: {
    collectionDir: string
    collectionId: string
  }): Promise<FeedCounter> {
    const counter = await this.#readJsonFile<{
      generation?: unknown
      position?: unknown
      records?: unknown
    }>(this.#feedCounterPath({ collectionDir, collectionId }))
    const { generation, position, records } = counter ?? {}
    const stored = isPlainObject(records) ? records : {}
    return {
      ...(typeof generation === 'string' && { generation }),
      position: Number.isSafeInteger(position) ? (position as number) : 0,
      records: Object.fromEntries(
        COUNTER_RECORD_KINDS.filter(kind =>
          Number.isSafeInteger(stored[kind])
        ).map(kind => [kind, stored[kind] as number])
      )
    }
  }

  /**
   * Takes the Collection's next feed position and runs the write that makes
   * a record visible at it, in one critical section on the Collection's
   * `feed:` key. So no write can land at or before a position `changesSince`
   * already handed to a reader, and every position at or below the counter's
   * value is on disk when `changesSince` reads the counter under the same
   * key. The counter is written first: a crash between the two writes leaves
   * a gap in the sequence, never a reused position, and at worst surfaces a
   * record's prior state at the new position. The first position minted in a
   * Collection mints the counter's generation with it; every later one keeps
   * it. A write that creates the Collection passes `startsFeed` and takes
   * position 1 under a fresh generation, whatever counter file the dir holds.
   * Such a file is left by a create that crashed before its Metadata file was
   * written, and no reader was handed a position from it.
   *
   * `write` stores a Resource's position on its sidecar (`feedPosition`)
   * and a policy's in its policy file (`_feedPosition`), so it builds the
   * stored form from the position it is handed. The Collection Metadata
   * object's and the governing log's positions are kept in the counter
   * file's `records`, so neither record's stored form carries a server-local
   * member.
   *
   * The `feed:` key is the innermost lock: the caller holds whatever else
   * the write needs (the Space gate, then `cmeta:` and `clog:` for a
   * Collection-level record, the `policy:` key for a policy, or the
   * `unique:` and Resource keys for a Resource), and `write` acquires
   * nothing.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDir {string}   must already exist
   * @param options.record {FeedRecord}   the record taking the position
   * @param [options.startsFeed] {boolean}   whether the write creates the
   *   Collection, so a stored counter is not continued
   * @param options.write {(feedPosition: number) => Promise<void>}   the
   *   write that makes the record visible
   * @returns {Promise<void>}
   */
  async #takeFeedPosition({
    spaceId,
    collectionId,
    collectionDir,
    record,
    startsFeed = false,
    write
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    record: FeedRecord
    startsFeed?: boolean
    write: (feedPosition: number) => Promise<void>
  }): Promise<void> {
    await this.#writeMutex.run(
      this.#feedLockKey({ spaceId, collectionId }),
      async () => {
        const counter: FeedCounter = startsFeed
          ? { position: 0, records: {} }
          : await this.#readFeedCounter({ collectionDir, collectionId })
        const feedPosition = counter.position + 1
        await atomicWriteFile({
          filePath: this.#feedCounterPath({ collectionDir, collectionId }),
          data: JSON.stringify(
            advancedFeedCounter({ counter, feedPosition, record })
          )
        })
        await write(feedPosition)
      }
    )
  }

  /**
   * Writes a Resource's sidecar stamped with the Collection's next feed
   * position (`#takeFeedPosition`), which is the point the write becomes
   * visible to the changes feed (which orders on `feedPosition`). The caller
   * holds the Resource's own key; this nests inside it.
   *
   * The sidecar lands under the name its kind takes (`#writeMetaSidecar`),
   * and the other name is removed after it: a delete writes the tombstone,
   * then removes the live sidecar, and a create over a tombstone writes the
   * live sidecar, then removes the tombstone. A crash between the two steps
   * leaves both names, which a read resolves to the newer body, the one at
   * the higher position (`readMetaSidecar`). The removal also clears a pair
   * such a crash left, whichever kind this write is. Whether there is an
   * other name to remove is told by `prior`, the sidecar the caller read
   * under the same lock: one of the other kind, or one resolved from both
   * names. A content write of a live Resource removes nothing.
   *
   * A chunk sidecar never goes through here: a chunk write does not move its
   * parent Resource in the feed.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.sidecar {MetaSidecar}   the sidecar to write; any
   *   `feedPosition` it carries is replaced
   * @param [options.prior] {MetaSidecar}   the sidecar the caller read under
   *   the Resource lock (`readMetaSidecar`), absent when there was none
   * @returns {Promise<void>}
   */
  async #writeFeedSidecar({
    spaceId,
    collectionId,
    collectionDir,
    resourceId,
    sidecar,
    prior
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
    sidecar: MetaSidecar
    prior?: MetaSidecar
  }): Promise<void> {
    await this.#takeFeedPosition({
      spaceId,
      collectionId,
      collectionDir,
      record: { kind: 'resource' },
      write: async feedPosition => {
        // Written last, so `withoutFeedPosition` restores the bytes a sidecar
        // without it would have.
        const { feedPosition: _prior, ...rest } = sidecar
        await this.#writeMetaSidecar({
          collectionDir,
          resourceId,
          sidecar: { ...rest, feedPosition }
        })
      }
    })
    const writesTombstone = sidecar.deleted === true
    if (
      prior !== undefined &&
      ((prior.deleted === true) !== writesTombstone ||
        this.#bothNamesRead.has(prior))
    ) {
      await rm(
        writesTombstone
          ? this.#metaSidecarPath({ collectionDir, resourceId })
          : this.#tombstonePath({ collectionDir, resourceId }),
        { force: true }
      )
    }
  }

  /**
   * Evaluates a conditional-write precondition against a Resource's current
   * on-disk state. MUST be called inside the per-Resource write lock so the
   * check is atomic with the write that follows. Throws
   * `PreconditionFailedError` (412) when the precondition is not met.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param [options.ifMatch] {string}   a quoted ETag (`If-Match`)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *` (create-if-absent)
   * @param [options.state] {LocatedResource}   the Resource as its sidecar
   *   records it, when the caller has already read it under the same lock;
   *   read here otherwise
   * @returns {Promise<void>}
   */
  async #assertWritePrecondition({
    collectionDir,
    resourceId,
    ifMatch,
    ifNoneMatch,
    state
  }: {
    collectionDir: string
    resourceId: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    state?: LocatedResource
  }): Promise<void> {
    const { prior, live } =
      state ?? (await this.#readLiveFile({ collectionDir, resourceId }))
    const exists = live !== undefined
    assertWritePrecondition({
      resourceId,
      exists,
      // A tombstone's sidecar survives its content, so the validator it carries
      // counts only when the Resource is live -- as it did when the sidecar was
      // read only in that case.
      currentEtag: exists ? etagOf(prior ?? {}) : undefined,
      ifMatch,
      ifNoneMatch
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}
   * @returns {Promise<ResourceResult>}   includes the Resource's current
   *   `generation` and stamp (the ETag validator parts) when its sidecar
   *   records them.
   */
  async getResource({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    /**
     * `contentType` is advisory and ignored for lookup: a Resource has a
     * single current representation, resolved by `resourceId` alone.
     */
    contentType?: string
  }): Promise<ResourceResult> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    return this.#readRepresentation({
      collectionDir,
      resourceId,
      requestName: 'Get Resource',
      stillStands: () => this.#collectionStands({ spaceId, collectionId })
    })
  }

  /**
   * Locates a live representation from its sidecar alone, with no directory
   * listing: the sidecar's name is built from the id, and its `fileName` is
   * the exact basename the write created, which `open` then opens. Nothing is
   * re-derived from `contentType`. Resolves `undefined` when there is no
   * sidecar or it is a tombstone: no live Resource stands.
   *
   * Reads take no lock, so a write that changes the content-type, or a delete,
   * can commit between the sidecar read and the open and remove the file the
   * read was about to open. On `ENOENT` the sidecar is read again: a changed
   * sidecar is followed (up to three attempts). An unchanged one names a file
   * that is gone. When the container no longer stands (`stillStands`), a
   * Delete Collection or a parent Resource's delete is removing its members,
   * which it does in no fixed order, so the Resource is absent. Otherwise no
   * committed write leaves that state behind, so it is a `StorageError`
   * (500), as is a live sidecar with no usable `fileName` (`#namedFilePath`).
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   *   (a Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @param [options.requestName] {string}   used in the error title
   * @param options.open {(filePath: string) => Promise<T>}   opens the located
   *   file; an `ENOENT` it rejects with is handled here
   * @param options.stillStands {() => Promise<boolean>}   whether the
   *   container (the Collection, and for a chunk its parent Resource) still
   *   stands, asked only once a file is found missing
   * @returns {Promise<{ sidecar: MetaSidecar, opened: T } | undefined>}
   */
  async #locateRepresentation<T>({
    collectionDir,
    resourceId,
    requestName,
    open,
    stillStands
  }: {
    collectionDir: string
    resourceId: string
    requestName?: string
    open: (filePath: string) => Promise<T>
    stillStands: () => Promise<boolean>
  }): Promise<{ sidecar: MetaSidecar; opened: T } | undefined> {
    const maxAttempts = 3
    let sidecar = await this.readMetaSidecar({ collectionDir, resourceId })
    for (let attempt = 1; ; attempt++) {
      if (sidecar === undefined || sidecar.deleted === true) {
        return undefined
      }
      const filePath = this.#namedFilePath({
        collectionDir,
        resourceId,
        sidecar,
        requestName
      })
      try {
        return { sidecar, opened: await open(filePath) }
      } catch (err) {
        if (!isEnoent(err)) {
          throw new StorageError({ cause: err as Error, requestName })
        }
        const reread = await this.readMetaSidecar({ collectionDir, resourceId })
        if (
          attempt >= maxAttempts ||
          JSON.stringify(reread) === JSON.stringify(sidecar)
        ) {
          // A container delete removes its members in no fixed order, so the
          // file can go before its sidecar. When the container no longer
          // stands, the Resource is gone, not damaged.
          if (!(await stillStands())) {
            return undefined
          }
          throw new StorageError({
            cause: new Error(
              `The sidecar of "${resourceId}" names ${filePath}, which is missing.`,
              { cause: err }
            ),
            requestName
          })
        }
        sidecar = reread
      }
    }
  }

  /**
   * Whether a Collection still stands: its Metadata file is present and not a
   * tombstone. Delete Collection writes its tombstone before it removes the
   * members, so a read that finds a member's file gone while the Collection is
   * being deleted sees the tombstone here. Reads the record only, so it
   * finishes no cut-short delete.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<boolean>}
   */
  async #collectionStands({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<boolean> {
    return (
      (await this.#readLiveCollection({ spaceId, collectionId })) !== undefined
    )
  }

  /**
   * Whether a chunk's container still stands: its Collection, and its parent
   * Resource's live sidecar. Delete Resource writes the parent's tombstone
   * before it removes the chunk directory.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}   the parent Resource
   * @returns {Promise<boolean>}
   */
  async #chunkParentStands({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<boolean> {
    if (!(await this.#collectionStands({ spaceId, collectionId }))) {
      return false
    }
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const parent = await this.readMetaSidecar({ collectionDir, resourceId })
    return parent !== undefined && parent.deleted !== true
  }

  /**
   * Resolves a stored representation's read stream, content-type, and ETag
   * validator (a `ResourceResult`), shared by `getResource` and `getChunk` -- a
   * chunk is a Resource keyed by its index inside its chunk dir. The
   * representation is located from its sidecar (`#locateRepresentation`), which
   * also supplies the content-type and the `generation` and stamp (the ETag
   * validator parts). Throws `ResourceNotFoundError` (404) when no live
   * Resource stands. Unlike the metadata getters it does NOT `stat` the file:
   * the read stream's own `open` surfaces a concurrent removal.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   *   (a Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @param options.requestName {string}   used in the 404 error title
   * @param options.stillStands {() => Promise<boolean>}   whether the
   *   container still stands (see `#locateRepresentation`)
   * @returns {Promise<ResourceResult>}
   */
  async #readRepresentation({
    collectionDir,
    resourceId,
    requestName,
    stillStands
  }: {
    collectionDir: string
    resourceId: string
    requestName: string
    stillStands: () => Promise<boolean>
  }): Promise<ResourceResult> {
    const located = await this.#locateRepresentation({
      collectionDir,
      resourceId,
      requestName,
      open: filePath => openFileStream(filePath, this.logger),
      stillStands
    })
    if (!located) {
      throw new ResourceNotFoundError({ requestName })
    }
    return {
      resourceStream: located.opened,
      storedResourceType: located.sidecar.contentType,
      ...validatorPartsOf(located.sidecar)
    }
  }

  /**
   * Resolves a stored representation's `stat` and sidecar together -- the shared core of the two metadata getters
   * (`getResourceMetadata` and `getChunkMetadata`). The representation is
   * located from its sidecar (`#locateRepresentation`). Resolves `undefined`
   * when no live Resource stands. Unlike `#readRepresentation`, the `stat`
   * result is USED (the reported `size`), so it is not dropped.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the representation lives in
   * @param options.resourceId {string}   the representation id (a resourceId, or
   *   the stringified chunk index)
   * @param options.stillStands {() => Promise<boolean>}   whether the
   *   container still stands (see `#locateRepresentation`)
   * @returns {Promise<{ stats: import('node:fs').Stats, sidecar: MetaSidecar } | undefined>}
   */
  async #statRepresentation({
    collectionDir,
    resourceId,
    stillStands
  }: {
    collectionDir: string
    resourceId: string
    stillStands: () => Promise<boolean>
  }): Promise<{ stats: fs.Stats; sidecar: MetaSidecar } | undefined> {
    const located = await this.#locateRepresentation({
      collectionDir,
      resourceId,
      open: filePath => fsStat(filePath),
      stillStands
    })
    if (!located) {
      return undefined
    }
    return { stats: located.opened, sidecar: located.sidecar }
  }

  /**
   * Builds the on-disk path for a Resource's metadata sidecar
   * (`.meta.<resourceId>.json`) in its Collection dir.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #metaSidecarPath({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    return this.#containedJoin(collectionDir, metaSidecarFileName(resourceId))
  }

  /**
   * Builds the on-disk path for a Resource's tombstone
   * (`.tombstone.<resourceId>.json`) in its Collection dir, where the live
   * sidecar would be.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #tombstonePath({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    return this.#containedJoin(
      collectionDir,
      tombstoneSidecarFileName(resourceId)
    )
  }

  /**
   * Reads a Resource's metadata sidecar, live or a tombstone. Resolves
   * `undefined` when neither has been written. Every read of one id's sidecar
   * goes through here, the directory scans' reads included, so a test can
   * count them.
   *
   * A live sidecar is `.meta.<id>.json` and a tombstone `.tombstone.<id>.json`.
   * Both names are opened, at once, unless the caller says which names its
   * directory listing holds (`names`), in which case only those are opened.
   * A chunk dir holds no tombstone, so there the second name is not opened.
   * When both exist (a crash between the two steps of a delete or a
   * re-create), the one with the higher `feedPosition` is the Resource's
   * state (`newerSidecar`), and the next write or delete of the id removes
   * the other (`#writeFeedSidecar`, told by `#bothNamesRead`). Reads take no
   * lock, so a read that lands between the two steps of a delete or a
   * re-create can find neither name and resolve `undefined`, which every
   * caller treats as it treats a tombstone: no live Resource stands.
   *
   * A name whose body does not parse (disk damage or a hand edit, since
   * sidecar writes are atomic) is read as absent when the other name parses,
   * with a `warn` line, so one damaged file does not fail the Resource it
   * sits beside; the next write or delete of the id removes it as it would
   * a stale pair. When it is the only name, or both are damaged, the
   * `SyntaxError` is thrown, as a damaged lone sidecar always was.
   * @param options {object}
   * @param options.collectionDir {string}   the dir the sidecar lives in (a
   *   Collection dir, or a chunk dir for a chunk)
   * @param options.resourceId {string}
   * @param [options.names] {{ live: boolean, tombstone: boolean }}   which
   *   of the two names the caller's directory listing holds; absent, both
   *   are opened (one in a chunk dir)
   * @returns {Promise<MetaSidecar|undefined>}
   */
  async readMetaSidecar({
    collectionDir,
    resourceId,
    names = {
      live: true,
      tombstone: !path.basename(collectionDir).startsWith(CHUNK_DIR_PREFIX)
    }
  }: {
    collectionDir: string
    resourceId: string
    names?: { live: boolean; tombstone: boolean }
  }): Promise<MetaSidecar | undefined> {
    const unopened: SidecarNameRead = {}
    const [live, tombstone] = await Promise.all([
      names.live
        ? this.#readSidecarName(
            this.#metaSidecarPath({ collectionDir, resourceId })
          )
        : unopened,
      names.tombstone
        ? this.#readSidecarName(
            this.#tombstonePath({ collectionDir, resourceId })
          )
        : unopened
    ])
    const damage = live.damage ?? tombstone.damage
    if (damage !== undefined) {
      if (live.sidecar === undefined && tombstone.sidecar === undefined) {
        throw damage
      }
      this.logger.warn(
        { err: damage },
        `A sidecar of "${resourceId}" in ${collectionDir} does not parse; ` +
          'the other name is read alone.'
      )
    }
    const resolved = newerSidecar({
      live: live.sidecar,
      tombstone: tombstone.sidecar
    })
    const bothNamesStand =
      (live.sidecar ?? live.damage) !== undefined &&
      (tombstone.sidecar ?? tombstone.damage) !== undefined
    if (resolved !== undefined && bothNamesStand) {
      this.#bothNamesRead.add(resolved)
    }
    return resolved
  }

  /**
   * Opens one sidecar name. An absent file resolves to neither member, a
   * body that does not parse to `damage`, and any other read error is thrown.
   * @param filePath {string}
   * @returns {Promise<{ sidecar?: MetaSidecar, damage?: SyntaxError }>}
   */
  async #readSidecarName(filePath: string): Promise<SidecarNameRead> {
    try {
      const sidecar = await this.#readJsonFile<MetaSidecar>(filePath)
      return sidecar === undefined ? {} : { sidecar }
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { damage: err }
      }
      throw err
    }
  }

  /**
   * Writes a Resource's metadata sidecar (full replacement), under the name
   * its kind takes: a tombstone (`deleted: true`) as `.tombstone.<id>.json`,
   * any other sidecar as `.meta.<id>.json`. The other name is left for the
   * caller to remove (`#writeFeedSidecar`). A chunk sidecar is never a
   * tombstone.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.sidecar {MetaSidecar}
   * @returns {Promise<void>}
   */
  async #writeMetaSidecar({
    collectionDir,
    resourceId,
    sidecar
  }: {
    collectionDir: string
    resourceId: string
    sidecar: MetaSidecar
  }): Promise<void> {
    await atomicWriteFile({
      filePath:
        sidecar.deleted === true
          ? this.#tombstonePath({ collectionDir, resourceId })
          : this.#metaSidecarPath({ collectionDir, resourceId }),
      data: JSON.stringify(sidecar)
    })
  }

  /**
   * Reads the metadata of a Resource's current representation: the REQUIRED
   * server-managed fields (`contentType`, recorded in the sidecar, and `size`,
   * from the stored file), plus the OPTIONAL `createdAt` / `updatedAt`
   * timestamps and the user-writable `custom` object read from the sidecar. A
   * member the sidecar does not carry is omitted. Resolves `undefined` when no
   * live sidecar names the Resource (none, or a tombstone), so a file with no
   * sidecar is absent, and when a delete of its Collection races the `stat`.
   *
   * Also surfaces the two records' stamps, so the request layer can set the
   * `ETag` header: HEAD / the resource itself pair the content `generation`
   * (out of band, not part of the wire body) with the top-level stamp, while
   * `GET /meta` composes that validator with the nested `meta` record's
   * stamp and generation.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<(ResourceMetadata & { generation?: string }) | undefined>}
   */
  async getResourceMetadata({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<(ResourceMetadata & { generation?: string }) | undefined> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const stated = await this.#statRepresentation({
      collectionDir,
      resourceId,
      stillStands: () => this.#collectionStands({ spaceId, collectionId })
    })
    if (!stated) {
      return undefined
    }
    const { stats, sidecar } = stated

    return {
      contentType: sidecar.contentType,
      size: stats.size,
      // Each is absent when the sidecar does not carry it. No member falls back
      // to the file's stat times.
      ...(sidecar.createdAt !== undefined && {
        createdAt: sidecar.createdAt
      }),
      ...validatorPartsOf(sidecar),
      ...(sidecar.meta !== undefined && { meta: sidecar.meta }),
      ...(sidecar.createdBy !== undefined && { createdBy: sidecar.createdBy }),
      // `custom` is returned verbatim -- `{ name, tags }` on a plaintext
      // Collection, the opaque encryption envelope on an encrypted one.
      ...(hasCustomMembers(sidecar.custom) && {
        custom: sidecar.custom as ResourceMetadataCustom
      }),
      // The client-declared key epoch (the `key-epochs` feature), when stamped.
      ...(sidecar.epoch !== undefined && { epoch: sidecar.epoch }),
      // The client-declared writer-attribution label (spec "Writer
      // attribution"), when stamped.
      ...(sidecar.writerId !== undefined && { writerId: sidecar.writerId })
    }
  }

  /**
   * Reads the write stamp of a Resource's content record from its sidecar,
   * live or a tombstone. Takes no lock.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<{ stamp: Partial<WriteStamp>, deleted: boolean } | undefined>}
   *   `undefined` when no sidecar names the Resource
   */
  async getResourceContentStamp({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<{ stamp: Partial<WriteStamp>; deleted: boolean } | undefined> {
    const held = await this.readMetaSidecar({
      collectionDir: this.#collectionDir({ spaceId, collectionId }),
      resourceId
    })
    if (held === undefined) {
      return undefined
    }
    return { stamp: stampOf(held), deleted: held.deleted === true }
  }

  /**
   * Replaces the user-writable `custom` object of a Resource's metadata sidecar
   * (full replacement; `{}` clears it), minting a new stamp on the `/meta`
   * record (`meta`, the `/meta` ETag) over its prior one. Does not create a
   * Resource: resolves `undefined` when the Resource is absent so the handler
   * can 404. The content record's stamp, `generation`, `writerId`, and the two
   * REQUIRED server-managed fields are untouched (a metadata write does not
   * change the stored representation, preserving the content ETag contract).
   * On an encrypted Collection `custom` is the opaque encryption envelope,
   * stored verbatim.
   *
   * Runs under the per-Resource write lock -- the same lock content writes take
   * -- so an `If-Match` / `If-None-Match` precondition (evaluated on the
   * `/meta` `ETag`, the composite of the content and `/meta` validators) is
   * atomic with the write and serializes with concurrent
   * content/metadata writes to the same Resource. A precondition mismatch throws
   * `PreconditionFailedError` (412).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.custom {ResourceMetadataCustom | Record<string, unknown>}
   * @param [options.ifMatch] {string}   `If-Match` on the current `/meta`
   *   `ETag`
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *` -- write only if
   *   no metadata has been written yet (no `meta` record)
   * @returns {Promise<ResourceMetadataWriteResult | undefined>}
   *   the metadata object's new validator (its own generation with the stamp
   *   this write mints) and the content record's validator, beside the
   *   server-managed members as the write left them, or `undefined` when the
   *   Resource does not exist
   */
  async writeResourceMetadata({
    spaceId,
    collectionId,
    resourceId,
    custom,
    epoch,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceMetadataCustom | Record<string, unknown>
    epoch?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<ResourceMetadataWriteResult | undefined> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const writeMeta = async (): Promise<
      ResourceMetadataWriteResult | undefined
    > => {
      // The sidecar names the live representation, so one read under the
      // Resource lock finds both.
      const { prior, live } = await this.#readLiveFile({
        collectionDir,
        resourceId
      })
      if (!live) {
        return undefined
      }
      const { filePath } = live
      // Evaluate the `/meta` precondition against the current `/meta` `ETag`
      // atomically under the lock, before writing. That `ETag` is the
      // composite of the content record's validator and the `/meta` record's,
      // as a `GET` of `/meta` serves it. `If-None-Match: *` means "only if no
      // metadata has been written yet"; `If-Match` pins the composite.
      const contentValidator = validatorOf(prior ?? {})
      assertMetaWritePrecondition({
        resourceId,
        currentEtag: resourceMetaEtagOf(prior ?? {}),
        metaWritten: prior?.meta !== undefined,
        ifMatch,
        ifNoneMatch
      })

      // The metadata object's own generation: minted by the first metadata
      // write (a tombstone dropped any earlier `meta` record, so a re-created
      // Resource starts afresh here) and kept by every later one. Its stamp
      // is minted over the prior `meta` stamp; the content record's stamp
      // and generation are preserved untouched.
      const metaValidator = await mintValidator({
        clock: this.#clock,
        prior: prior?.meta
      })
      const { generation: metaGeneration, stamp: metaStamp } = metaValidator
      // A Resource whose sidecar carries no `createdAt` takes this write's
      // time.
      const createdAt = prior?.createdAt ?? metaStamp.updatedAt
      const hasCustom = hasCustomMembers(custom)
      // The sidecar's content-record members, carried over as stored; this
      // write replaces `custom`, `epoch` and `meta`.
      const {
        custom: _priorCustom,
        epoch: _priorEpoch,
        meta: _priorMeta,
        ...contentRecord
      } = prior ?? {}
      // The key-epoch stamp describes the CONTENT write, not this metadata
      // write, so a supplied `epoch` replaces it but an omitted one PRESERVES
      // the stored value (unlike `custom`, which is full-replace).
      const resolvedEpoch = epoch ?? prior?.epoch
      // A metadata write re-surfaces the Resource in the changes feed, so the
      // sidecar takes the Collection's next feed position.
      const sidecar: MetaSidecar = {
        // Preserve the content record whole: its stamp and generation (a
        // metadata write does not change the stored representation), the
        // server-managed creator (`createdBy` is not user-writable), and
        // its `writerId`, which names the writer of the content.
        ...(contentRecord as MetaSidecar),
        createdAt,
        meta: { ...metaStamp, generation: metaGeneration },
        ...(hasCustom && { custom }),
        ...(resolvedEpoch !== undefined && { epoch: resolvedEpoch })
      }
      await this.#writeFeedSidecar({
        spaceId,
        collectionId,
        collectionDir,
        resourceId,
        sidecar,
        prior
      })
      return {
        validator: metaValidator,
        ...(contentValidator !== undefined && { contentValidator }),
        members: await this.#writtenMembers({ filePath, sidecar })
      }
    }
    // A metadata write can create a plaintext equality unique claim for a
    // `custom`-sourced attribute (the `equality-query` feature). When the
    // Collection declares any unique index, serialize on the Collection lock and
    // scan for a conflict -- content is the Resource's stored JSON content
    // (unchanged by a metadata write), custom is the incoming value this write
    // sets -- before taking the per-Resource lock nested inside. Distinct-key
    // nesting cannot deadlock (plain writes never hold a Resource key while
    // waiting on a Collection key). The declarations come from the Collection
    // Metadata object the Space gate hands over, as on a content write.
    return this.#underSpaceWrite({
      spaceId,
      container: { collectionId },
      write: collection => {
        const uniqueIndexes = declaredUniqueIndexesOf({
          collectionMetadata: collection
        })
        if (uniqueIndexes.length === 0) {
          return this.#writeMutex.run(
            this.#resourceLockKey({ spaceId, collectionId, resourceId }),
            writeMeta
          )
        }
        return this.#writeMutex.run(
          this.#collectionLockKey({ spaceId, collectionId }),
          async () => {
            // An absent Resource is the handler's 404, answered before any
            // uniqueness claim is judged (as on the Postgres backend).
            const { live } = await this.#readLiveFile({
              collectionDir,
              resourceId
            })
            if (!live) {
              return undefined
            }
            assertNoUniqueEqualityConflict({
              indexes: uniqueIndexes,
              content: await this.#readJsonContentAt(live),
              custom,
              candidates: await this.#readEqualityCandidates({
                spaceId,
                collectionId,
                excludeResourceId: resourceId
              })
            })
            return this.#writeMutex.run(
              this.#resourceLockKey({ spaceId, collectionId, resourceId }),
              writeMeta
            )
          }
        )
      }
    })
  }

  /**
   * Soft-deletes a Resource: drops its content representation but leaves a
   * **tombstone** (`deleted: true`, a new content stamp, the last-known
   * `contentType` retained) so the change feed (replication) still surfaces
   * it until clients catch up (GC of tombstones is future work). The
   * tombstone is `.tombstone.<id>.json`, written first; the live sidecar
   * (`.meta.<id>.json`) goes next, then the one file it named, then the chunk
   * directory. No directory is listed. The tombstone names no file
   * (`fileName` is dropped), so it is invisible to every normal read path
   * (`getResource` / `getResourceMetadata` locate the file from a live
   * sidecar, and `listCollectionItems` keeps only the files a live sidecar
   * names), making soft delete transparent to the existing API.
   *
   * When `ifMatch` is supplied (the `conditional-writes` feature), the delete
   * proceeds only if the Resource exists and its current `ETag` matches, else
   * `PreconditionFailedError` (412). The whole read-modify-write runs under the
   * per-Resource write lock so it serializes with concurrent writes. The delete
   * is idempotent: an already-absent Resource (never created, or an existing
   * tombstone) is a no-op, leaving any tombstone's change-feed entry stable.
   * A delete that writes the Resource tombstone also tombstones the Resource's
   * live access-control policy, if any, in the same critical section.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @returns {Promise<void>}
   */
  async deleteResource({
    spaceId,
    collectionId,
    resourceId,
    ifMatch,
    writerId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    ifMatch?: string
    writerId?: string
  }): Promise<void> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const softDelete = async (): Promise<void> => {
      // A chunk swap a fault left torn is finished first, so a tombstone
      // read below is a settled one, and the chunk set a swap moved in is
      // not cleared as one a delete left behind.
      await this.#settleStaging({
        spaceId,
        collectionId,
        collectionDir,
        resourceId,
        discardUnswapped: false
      })
      // The sidecar names the live representation, so one read finds both,
      // with no directory listing.
      const located = await this.#readLiveFile({
        collectionDir,
        resourceId,
        requestName: 'Delete Resource'
      })
      const { prior, live } = located
      if (ifMatch !== undefined) {
        await this.#assertWritePrecondition({
          collectionDir,
          resourceId,
          ifMatch,
          state: located
        })
      }
      if (live === undefined) {
        // Already absent (never existed, or already a tombstone): idempotent
        // no-op. Leaving an existing tombstone untouched keeps its change-feed
        // entry (its stamp) stable. A chunk directory an earlier delete cut
        // short left beside the tombstone goes now.
        await this.#clearChunksBesideTombstone({
          collectionDir,
          resourceId,
          prior
        })
        return
      }
      // The representation's content-type is carried over to the tombstone:
      // once the content file is gone the tombstone sidecar is the only record
      // of it, and the change feed reports it.
      const { contentType, digest } = live.sidecar
      // The tombstone (`.tombstone.<id>.json`) is the delete's commit point:
      // it is written BEFORE the live sidecar and the representation are
      // removed, so a crash between the steps leaves a tombstone beside a
      // stale live sidecar (the tombstone, at the higher feed position, is
      // read as the Resource's state) or beside a stale file, rather than a
      // live sidecar naming a file that is gone.
      //
      // Mint a new content stamp over the prior one: the deletion is a
      // revision of the content record (a later re-create reads this sidecar
      // and mints above it). The `generation` is kept for the same reason:
      // the record survives, so the validator it forms stays continuous
      // across the soft delete. The `/meta` record is dropped whole --
      // `custom` with its `meta` stamp and generation -- since the user
      // Metadata goes with the deleted Resource; a re-create's first metadata
      // write then mints a new generation, so a `/meta` ETag held from before
      // the delete cannot pass `If-Match` against it. `createdAt` /
      // `createdBy` are kept as the record of the deleted Resource's origin.
      // A re-create over the tombstone records its own.
      //
      // The tombstone takes the Collection's next feed position, so the
      // delete replicates. It names no file: `fileName` is not carried over.
      await this.#stampSidecar({
        collectionDir,
        resourceId,
        prior,
        feed: { spaceId, collectionId },
        build: ({ prior, generation, stamp }) => ({
          createdAt: prior?.createdAt ?? stamp.updatedAt,
          ...stamp,
          ...(prior?.createdBy !== undefined && {
            createdBy: prior.createdBy
          }),
          generation,
          deleted: true,
          contentType,
          // The deleted content's digest, which a write over the tombstone
          // on a write-once Collection is compared with.
          ...(digest !== undefined && { digest }),
          // A deletion is a revision like any other: the tombstone carries the
          // writer-attribution label THIS delete declared, not the Resource's
          // prior one (declare-or-clear, same as a content write).
          ...(writerId !== undefined && { writerId })
        })
      })
      // The tombstone write removed the live sidecar after it
      // (`#writeFeedSidecar`). Drop the file that sidecar named and any file
      // of the id a crash left beside it, so no byte of the id outlives the
      // delete in the byte quota's walk. The listing this takes is the one
      // directory listing on the delete path.
      await this.#removeRepresentationFilesOf({
        dir: collectionDir,
        resourceId
      })
      // Freed bytes: drop the cached usage total so the next write
      // re-measures. AFTER the removal and inside the lock, as `deleteChunk`
      // does -- invalidating first would let a concurrent write re-measure the
      // pre-delete tree and cache that total for a full TTL, refusing the
      // client's follow-up write (507) over space this delete just freed.
      this.#dropUsageCache({ spaceId })
      // Cascade-delete the Resource's chunks (the `chunked-streams` feature): a
      // chunk must never outlive its parent Resource, so its whole chunk
      // directory goes with the content. Runs under the same per-Resource lock a
      // `writeChunk` takes, so a chunk write racing this delete cannot re-create
      // an orphan directory. `force` makes an absent chunk directory a no-op.
      // A pull loop's chunk staging for the Resource goes with it, under the
      // same lock `stageChunk` checks the Collection under; a transfer still
      // running finds its run directory gone and stages nothing.
      await rm(this.#chunkDir({ collectionDir, resourceId }), {
        recursive: true,
        force: true
      })
      await rm(this.#stagingDir({ collectionDir, resourceId }), {
        recursive: true,
        force: true
      })
      this.#forgetStagingCredits({
        under: this.#stagingDir({ collectionDir, resourceId })
      })
      // The Resource's access-control policy dies with it: a live policy is
      // tombstoned here, under the policy's own key nested inside the
      // Resource key, so a re-create under the same id starts with no policy.
      // The tombstone takes the feed position after the Resource tombstone's.
      await this.#writeMutex.run(
        this.#policyLockKey({ spaceId, collectionId, resourceId }),
        () => this.#tombstoneLivePolicy({ spaceId, collectionId, resourceId })
      )
    }
    // The soft delete is a read-modify-write on the sidecar, so it always
    // serializes with concurrent writes under the per-Resource lock (not only
    // for a conditional delete, as the old unconditional removal did).
    return this.#underSpaceWrite({
      spaceId,
      write: () =>
        this.#writeMutex.run(
          this.#resourceLockKey({ spaceId, collectionId, resourceId }),
          softDelete
        )
    })
  }

  // Chunks (the `chunked-streams` feature)

  /**
   * Builds the on-disk path for a Resource's chunk directory
   * (`.chunks.<encodedResourceId>/`) inside its Collection dir. A hidden
   * subdirectory (leading `.`, so it is invisible to the `r.`-prefixed Collection
   * listing) that holds the Resource's chunk
   * representations; inside it a chunk is stored exactly like a Resource keyed by
   * its index (`r.<index>.<encodedContentType>.<ext>` plus a `.meta.<index>.json`
   * stamp sidecar), so the Resource file / sidecar helpers are reused verbatim
   * with the chunk directory as the `collectionDir`.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #chunkDir({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    return this.#containedJoin(collectionDir, chunkDirName(resourceId))
  }

  /**
   * Builds the on-disk path of a Resource's chunk staging directory
   * (`.staging.chunks.<encodedResourceId>/`, see `STAGING_DIR_PREFIX`) in its
   * Collection dir, beside its chunk directory. Under it each registration
   * that stages chunks for the Resource has a directory named by its replica
   * id, and under that one run directory per parent revision
   * (`stagingRunDirName`).
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {string}
   */
  #stagingDir({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId: string
  }): string {
    return this.#containedJoin(
      collectionDir,
      `${STAGING_DIR_LEAD}${chunkDirName(resourceId)}`
    )
  }

  /**
   * Builds the on-disk path of one staging run directory:
   * `<stagingDir>/<replicaId>/<encodedParentEtag>/`. The replica id must pass
   * the replica id rule (`#assertReplicaId`), and the `ETag` must not be
   * empty. A run directory mirrors a chunk directory: each staged chunk is
   * `r.<index>.<encodedContentType>.<ext>` beside a `.meta.<index>.json`
   * staged sidecar (`StagedChunkSidecar`), plus the run's
   * `.manifest.json` once its swap is decided.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.run {ChunkStagingRun}
   * @returns {string}
   */
  #stagingRunDir({
    collectionDir,
    resourceId,
    run
  }: {
    collectionDir: string
    resourceId: string
    run: ChunkStagingRun
  }): string {
    this.#assertReplicaId(run.replicaId)
    if (run.parentEtag === '') {
      throw new StorageError({
        cause: new Error('A chunk staging run names no parent ETag.')
      })
    }
    return this.#containedJoin(
      this.#stagingDir({ collectionDir, resourceId }),
      run.replicaId,
      stagingRunDirName(run.parentEtag)
    )
  }

  /**
   * Writes one chunk of a chunked Resource, keyed by
   * `(spaceId, collectionId, resourceId, chunkIndex)`. The parent Resource MUST
   * already exist (else `ResourceNotFoundError`, 404), checked under the same
   * per-Resource lock a `deleteResource` cascade takes so a chunk can never be
   * orphaned by a racing delete. The body is stored opaquely (bytes +
   * content-type) through the shared upload-cap / quota guards, and the chunk's
   * own stamp is minted (with its `generation`, the chunk's ETag validator,
   * independent of the parent's); any `If-Match` / `If-None-Match`
   * precondition is evaluated on that validator atomically with the write
   * (`PreconditionFailedError`, 412).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}   non-negative integer chunk position
   * @param options.input {ResourceInput}
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *` (create-if-absent)
   * @returns {Promise<EtagValidator>}   the chunk's new ETag validator
   */
  async writeChunk({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex,
    input,
    immutable,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    input: ResourceInput
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    // Serialize on the parent Resource's lock key -- the same key
    // `deleteResource` takes -- so the parent-exists check, the write, and the
    // cascade delete cannot interleave (no orphan chunk). Under the Space gate,
    // as every path-creating write is: this one creates the chunk dir, so the
    // Space and Collection must still exist once the gate is held.
    return this.#underSpaceWrite({
      spaceId,
      container: { collectionId, requestName: 'Write Chunk' },
      write: () =>
        this.#writeMutex.run(
          this.#resourceLockKey({ spaceId, collectionId, resourceId }),
          () =>
            this.#writeChunkLocked({
              spaceId,
              collectionDir,
              resourceId,
              collectionId,
              chunkIndex,
              input,
              immutable,
              ifMatch,
              ifNoneMatch
            })
        )
    })
  }

  /**
   * The critical section of `writeChunk`, run under the per-Resource lock. See
   * `writeChunk` for the parameters.
   * @returns {Promise<EtagValidator>}
   */
  async #writeChunkLocked({
    spaceId,
    collectionId,
    collectionDir,
    resourceId,
    chunkIndex,
    input,
    immutable,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
    chunkIndex: number
    input: ResourceInput
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator> {
    // A chunk swap a fault left torn is finished first, so this write lands
    // on the settled parent and its settled set.
    await this.#settleStaging({
      spaceId,
      collectionId,
      collectionDir,
      resourceId,
      discardUnswapped: false
    })
    // The parent Resource must exist: writing a chunk of an absent Resource
    // rejects, so orphan chunks cannot accumulate. Its sidecar says whether
    // it is live.
    const parent = await this.#readLiveFile({
      collectionDir,
      resourceId,
      requestName: 'Write Chunk'
    })
    if (parent.live === undefined) {
      throw new ResourceNotFoundError({ requestName: 'Write Chunk' })
    }

    // Inside the chunk directory a chunk is a Resource keyed by its index, so the
    // Resource file / sidecar helpers apply with `chunkDir` as the collectionDir
    // and the stringified index as the resourceId.
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    const chunkId = String(chunkIndex)
    const filename = fileNameFor({
      resourceId: chunkId,
      contentType: input.contentType
    })
    const filePath = this.#containedJoin(chunkDir, filename)

    // The chunk's sidecar names its stored file, so one read under the lock
    // finds both. A chunk file no sidecar names is a write that never
    // committed, so this write is a create.
    const storedChunk = await this.#readLiveFile({
      collectionDir: chunkDir,
      resourceId: chunkId,
      requestName: 'Write Chunk'
    })
    const priorChunkSidecar = storedChunk.prior
    const storedPath = storedChunk.live?.filePath

    // Evaluate any precondition against the chunk's current ETag before
    // writing (still inside the lock, so check and write are atomic).
    if (ifMatch !== undefined || ifNoneMatch !== undefined) {
      await this.#assertWritePrecondition({
        collectionDir: chunkDir,
        resourceId: chunkId,
        ifMatch,
        ifNoneMatch,
        state: storedChunk
      })
    }

    // A write-once Collection: a stored chunk takes only a repeat of its
    // digest, which writes nothing. A stored chunk whose sidecar carries no
    // stamp is damaged, and the repeat repairs it: the bytes stay, and the
    // sidecar is stamped below. A chunk keeps no tombstone, so the rule
    // binds a live chunk only.
    const heldChunk = storedChunk.live?.sidecar
    const writeOnce =
      heldChunk !== undefined &&
      (await this.#isWriteOnce({
        spaceId,
        collectionId,
        immutable
      }))
    let digest: string
    if (writeOnce) {
      const repeat = await this.#answerImmutableRepeat({
        sidecar: heldChunk,
        filePath: storedPath,
        input,
        requestName: 'Write Chunk'
      })
      if (repeat.validator !== undefined) {
        return repeat.validator
      }
      digest = repeat.digest
    } else {
      // The chunk directory is created lazily on first write (a binary body is
      // streamed into a temp file in it, so it must exist first).
      await mkdir(chunkDir, { recursive: true })
      digest = await this.#writeRepresentationBytes({
        spaceId,
        filePath,
        input
      })
    }

    // Mint the chunk's stamp under its `generation` (its ETag validator),
    // preserving its `createdAt`. A chunk keeps no tombstone, so a delete
    // takes the sidecar with it and the next write at this index mints a
    // fresh generation. A chunk carries no user Metadata / `createdBy` /
    // epoch. The sidecar is the commit point, as on a Resource: written
    // after the new representation and before any prior one is pruned.
    const { validator } = await this.#stampSidecar({
      collectionDir: chunkDir,
      resourceId: chunkId,
      prior: priorChunkSidecar,
      build: ({ prior, generation, stamp }) => ({
        createdAt: prior?.createdAt ?? stamp.updatedAt,
        ...stamp,
        generation,
        // The stored chunk file's name and the type it carries, as on a
        // Resource. A write-once repeat wrote no bytes, so both are read off
        // the stored file, and its digest is the stored one.
        ...sidecarFileMembers(writeOnce ? storedPath! : filePath),
        digest
      })
    })

    if (!writeOnce) {
      // A chunk has a single current representation: remove the prior one
      // when it was stored under a different content-type
      // (write-new-then-prune).
      await this.#removeReplacedFile({
        priorPath: storedPath,
        keepPath: filePath
      })
    }
    return validator
  }

  /**
   * Reads a chunk's bytes, resolving a `ResourceResult` (stream + resolved
   * content-type + the chunk's ETag validator). Throws `ResourceNotFoundError`
   * (404) when the chunk is absent.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<ResourceResult>}
   */
  async getChunk({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ResourceResult> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    // A chunk is a Resource keyed by its index inside its chunk dir, so the
    // shared representation reader applies with `chunkDir` as the collectionDir.
    return this.#readRepresentation({
      collectionDir: chunkDir,
      resourceId: String(chunkIndex),
      requestName: 'Get Chunk',
      stillStands: () =>
        this.#chunkParentStands({ spaceId, collectionId, resourceId })
    })
  }

  /**
   * Reads a chunk's stored content-type / size / ETag validator (the HEAD
   * payload headers). Resolves `undefined` when the chunk is absent.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<ChunkMetadata|undefined>}
   */
  async getChunkMetadata({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ChunkMetadata | undefined> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    // A chunk is a Resource keyed by its index inside its chunk dir, so the
    // shared stat/sidecar reader applies with `chunkDir` as the collectionDir.
    const stated = await this.#statRepresentation({
      collectionDir: chunkDir,
      resourceId: String(chunkIndex),
      stillStands: () =>
        this.#chunkParentStands({ spaceId, collectionId, resourceId })
    })
    if (!stated) {
      return undefined
    }
    const { stats, sidecar } = stated
    return {
      contentType: sidecar.contentType,
      size: stats.size,
      ...validatorPartsOf(sidecar)
    }
  }

  /**
   * Deletes one chunk (a hard delete: its bytes and validator sidecar both go,
   * and
   * -- unlike a Resource -- it leaves no tombstone, since chunks are not part of
   * the change feed). The sidecar's `generation` goes with it, so a later write
   * at the same index starts a fresh one and a client's pre-delete `ETag` can
   * never match the new chunk. The chunk is the file its live sidecar names
   * (`#readLiveFile`); the sidecar goes first, then that file and any file of
   * the index a crash left beside it (`#removeRepresentationFilesOf`).
   * Resolves `true` when a chunk was removed and `false` when no live sidecar
   * stands at that
   * index, which includes a chunk file with no sidecar (left in place) and a
   * delete cut short after its sidecar was removed. When `ifMatch` is
   * supplied it is evaluated on the chunk's current ETag atomically with the
   * removal (under the same per-Resource lock), throwing
   * `PreconditionFailedError` (412) on a mismatch.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @param [options.ifMatch] {string}   `If-Match` precondition (a quoted ETag)
   * @returns {Promise<boolean>}
   */
  async deleteChunk({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex,
    ifMatch
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    ifMatch?: string
  }): Promise<boolean> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    const chunkId = String(chunkIndex)
    return this.#underSpaceWrite({
      spaceId,
      write: () =>
        this.#writeMutex.run(
          this.#resourceLockKey({ spaceId, collectionId, resourceId }),
          async () => {
            // A chunk swap a fault left torn is finished first, so the
            // delete lands on the settled set.
            await this.#settleStaging({
              spaceId,
              collectionId,
              collectionDir,
              resourceId,
              discardUnswapped: false
            })
            // The chunk is found from its sidecar, as a read finds it. A
            // chunk file no live sidecar names is no chunk, and is left in
            // place.
            const chunk = await this.#readLiveFile({
              collectionDir: chunkDir,
              resourceId: chunkId,
              requestName: 'Delete Chunk'
            })
            if (chunk.live === undefined) {
              // Absent: the handler 404s on `false` (chunk deletes are not silently
              // idempotent, mirroring the EDV chunk contract).
              return false
            }
            if (ifMatch !== undefined) {
              await this.#assertWritePrecondition({
                collectionDir: chunkDir,
                resourceId: chunkId,
                ifMatch,
                state: chunk
              })
            }
            // The sidecar goes first: it is the record that the chunk stands,
            // so a read that already took it and then misses the file finds it
            // gone on its second look and answers 404. A chunk keeps no
            // tombstone, so its generation does not survive the delete.
            await rm(
              this.#metaSidecarPath({
                collectionDir: chunkDir,
                resourceId: chunkId
              }),
              { force: true }
            )
            // The named file goes, with any file of the index a crash left
            // beside it, so the directory below is empty once the last chunk
            // is gone.
            const remaining = await this.#removeRepresentationFilesOf({
              dir: chunkDir,
              resourceId: chunkId
            })
            // When that was the last chunk, remove the now-empty chunk directory
            // itself: a lingering empty `.chunks.<encId>/` would otherwise appear
            // in the export walk (diverging from a Postgres export of the same
            // logical state) and count its allocated block toward the du-based
            // quota measurement. Safe under the per-Resource lock (`writeChunk`
            // serializes on the same key, so nothing lands in the directory
            // between the listing and the rmdir).
            if (remaining === 0) {
              await fs.promises.rmdir(chunkDir)
            }
            // Freed bytes: drop the cached quota usage so the next write re-measures.
            this.#dropUsageCache({ spaceId })
            return true
          }
        )
    })
  }

  /**
   * Lists a Resource's stored chunks in ascending `index` order -- the
   * discovery/reassembly listing (the server never reassembles). Resolves an
   * empty listing when the Resource has no chunk directory (including when the
   * Resource itself is absent -- existence is the parent routes' concern).
   * Each entry's `etag` is formatted from the sidecar the listing read to
   * judge the chunk live, by the same `etagOf` `getChunkMetadata` reports it
   * through, so the listing costs no read beyond the `stat` per chunk. The
   * listing takes no lock, and a chunk's `size` comes from a `stat` after
   * its sidecar was read, so an entry read across a concurrent overwrite of
   * the index can pair the old validator with the new file's size, as a
   * `getChunkMetadata` across the same race does.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<ChunkListing>}
   */
  async listChunks({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<ChunkListing> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    // An absent chunk directory lists no chunks (`readDirEntries` resolves it
    // as empty).
    const entries = await readDirEntries(chunkDir)

    // Keep only the chunk representations (`r.<index>.<type>.<ext>`) a live
    // `.meta.<index>.json` sidecar names, dropping the sidecars themselves and
    // any file a crash left behind. A sidecar that does not parse leaves its
    // chunk out.
    const chunkEntries = await this.#liveRepresentationEntries({
      dir: chunkDir,
      entries
    })
    // `listChunks` takes no lock, so a concurrent `deleteChunk` can remove a
    // file this listing already named. Such a chunk is simply omitted (its
    // `stat` resolves `undefined` below), as `#statRepresentation` does on the
    // same race -- an `ENOENT` escaping here would be a 500 for a valid read.
    const chunks = (
      await Promise.all(
        chunkEntries.map(
          async ({ resourceId: indexStr, contentType, fileName, sidecar }) => {
            const filePath = path.join(chunkDir, fileName)
            let stats
            try {
              stats = await fsStat(filePath)
            } catch (err) {
              if (isEnoent(err)) {
                return undefined
              }
              throw err
            }
            return {
              index: Number(indexStr),
              size: stats.size,
              contentType,
              // A chunk sidecar always carries its validator.
              etag: etagOf(sidecar)!
            }
          }
        )
      )
    ).filter(chunk => chunk !== undefined)
    chunks.sort((left, right) => left.index - right.index)
    return { count: chunks.length, chunks }
  }

  /**
   * The changes-feed documents of the Collection's policies whose position
   * lies past `after` and at or below `highWater`: the Collection's own
   * policy and each Resource policy, live or a tombstone, with its stamp and
   * the validator its own GET serves. Each policy file carries its own
   * position (`_feedPosition`), so every policy file in the listing is read.
   * Takes no lock: a policy file is replaced whole, so each one read matches
   * the position it carries, and one rewritten since the counter was read
   * carries a position past `highWater` and is left out. A policy file that
   * does not parse is logged and left out, so it cannot fail the feed for a
   * reader already past it.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.entries {fs.Dirent[]}   the Collection dir's listing
   * @param options.after {number}   the reader's position
   * @param options.highWater {number}   the counter's position
   * @returns {Promise<FeedDocument[]>}
   */
  async #policyFeedDocuments({
    collectionDir,
    entries,
    after,
    highWater
  }: {
    collectionDir: string
    entries: fs.Dirent[]
    after: number
    highWater: number
  }): Promise<FeedDocument[]> {
    // Each policy file is an independent read, so they are read in batches.
    const documents = await mapInBatches({
      items: entries.filter(
        entry => entry.isFile() && isPolicyFileName(entry.name)
      ),
      map: async entry => {
        let raw: unknown
        try {
          raw = await this.#readJsonFile<unknown>(
            path.join(collectionDir, entry.name)
          )
        } catch (err) {
          if (!(err instanceof SyntaxError)) {
            throw err
          }
          this.logger.warn(
            { err, fileName: entry.name },
            'Unparsable policy file left out of the changes feed'
          )
          return undefined
        }
        const feedPosition = policyFileFeedPosition(raw)
        const record = storedPolicyFromFile(raw)
        if (
          record === undefined ||
          feedPosition === undefined ||
          feedPosition <= after ||
          feedPosition > highWater
        ) {
          return undefined
        }
        return policyFeedDocument({
          record,
          resourceId: parseResourcePolicyFileName(entry.name),
          feedPosition
        })
      }
    })
    return documents.filter(document => document !== undefined)
  }

  /**
   * Replication change feed (the `changes` query profile; see the
   * `StorageBackend.changesSince` contract).
   * Reads the Collection's feed counter under the Collection's `feed:` key,
   * and with it the Collection Metadata object and the governing history log
   * when the counter puts either past `afterPosition`, enumerates
   * the Collection once, builds a lightweight descriptor for every Resource
   * (live) and Resource tombstone of any content type, adds the Collection
   * Metadata object and the log at the positions the counter records for
   * them and each policy at the position its file carries, orders everything
   * by feed position, seeks strictly past
   * `afterPosition`, takes a page of `limit`, and reads JSON bodies ONLY for
   * the live JSON Resources on that page. O(n) over the Collection per call
   * (it must read every sidecar to order by position) -- acceptable for this
   * teaching backend; an indexed backend would answer it from a position
   * index.
   *
   * The counter read is the snapshot: a position is taken and the record
   * carrying it written in one `feed:` critical section
   * (`#takeFeedPosition`), so every position up to the counter's value is on
   * disk when it is read. A caught-up reader is answered off the counter
   * alone, with no other file read. Otherwise the Collection Metadata object
   * and the log whose positions are past the reader's are read in the same
   * section, so each matches the position the counter records for it. The
   * dir listing, the policy scan and the Resource scan run outside the lock,
   * so a feed-visible write waits behind two file reads at most. Each policy
   * file and each sidecar carries its own position, and the scans admit only
   * positions at or below the counter's value. A Resource or policy
   * rewritten during the scan moves past it, is left out of this page, and
   * is served by the next pull, so no position a reader is handed can later
   * gain a write behind it. A sidecar with no `feedPosition`, a policy file
   * with no `_feedPosition` or one that does not parse, and a Collection
   * Metadata object or log with no recorded position, is left out until its
   * next write. So is a Resource whose sidecar does not parse, with a `warn`
   * line (`#readListedSidecar`): the page goes on past it, and a rewrite of
   * it takes a fresh position a puller reads then.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.afterPosition] {number}   resume strictly after this
   *   feed position
   * @param options.limit {number}   page cap (reduced to the backend maximum)
   * @returns {Promise<{ documents: FeedDocument[], checkpoint: number | null, feedGeneration?: string }>}
   */
  async changesSince({
    spaceId,
    collectionId,
    afterPosition,
    limit
  }: {
    spaceId: string
    collectionId: string
    afterPosition?: number
    limit: number
  }): Promise<{
    documents: FeedDocument[]
    checkpoint: number | null
    feedGeneration?: string
  }> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })

    // The highest position whose record is already on disk (see above), the
    // generation the counter hands positions out under, and the
    // Collection-level records as of the same snapshot.
    const after = afterPosition ?? 0
    const { counter, collectionMetadata, log } = await this.#writeMutex.run(
      this.#feedLockKey({ spaceId, collectionId }),
      async () => {
        const counter = await this.#readFeedCounter({
          collectionDir,
          collectionId
        })
        // No record's position is past the counter's, so a caught-up reader
        // reads the counter alone here.
        const {
          'collection-metadata': collectionMetadataPosition = 0,
          log: logPosition = 0
        } = counter.records
        const [collectionMetadata, log] = await Promise.all([
          collectionMetadataPosition > after
            ? this.#readLiveCollection({ spaceId, collectionId })
            : undefined,
          logPosition > after
            ? this.#readCollectionLog({ spaceId, collectionId })
            : undefined
        ])
        return { counter, collectionMetadata, log }
      }
    )
    const {
      generation: feedGeneration,
      position: highWater,
      records: {
        'collection-metadata': collectionMetadataPosition,
        log: logPosition
      }
    } = counter
    // A caught-up reader (the steady-state poll of a replica) skips the scan
    // below.
    if (after >= highWater) {
      return {
        documents: [],
        checkpoint: null,
        ...(feedGeneration !== undefined && { feedGeneration })
      }
    }
    // Outside the lock: every position up to `highWater` is on disk, and each
    // file below carries its own position.
    const entries = await readDirEntries(collectionDir)
    const policyDocuments = await this.#policyFeedDocuments({
      collectionDir,
      entries,
      after,
      highWater
    })
    const inFeed = (feedPosition: unknown): feedPosition is number =>
      Number.isSafeInteger(feedPosition) &&
      (feedPosition as number) > after &&
      (feedPosition as number) <= highWater

    // The Collection-level documents: the Collection Metadata object and the
    // governing log, each at the position of its latest write, with its
    // stamp and the validator its own GET serves.
    const collectionDocuments: FeedDocument[] = []
    const metadataStamp = stampOf(collectionMetadata)
    if (
      collectionMetadata !== undefined &&
      inFeed(collectionMetadataPosition) &&
      isWriteStamp(metadataStamp)
    ) {
      collectionDocuments.push(
        containerFeedDocument({
          kind: 'collection-metadata',
          feedPosition: collectionMetadataPosition,
          stamp: metadataStamp,
          generation: collectionMetadata.metaGeneration,
          local: collectionMetadata.metaLocal ?? 0
        })
      )
    }
    const logStamp = stampOf(log)
    if (log !== undefined && inFeed(logPosition) && isWriteStamp(logStamp)) {
      collectionDocuments.push(
        containerFeedDocument({
          kind: 'log',
          feedPosition: logPosition,
          stamp: logStamp,
          generation: log.generation
        })
      )
    }

    // Index the dir: the live Resources, each with the one file its sidecar
    // names (`#judgeRepresentations`), and the set of ids that have a
    // `.tombstone.` file (each one with no live file is a tombstone
    // candidate). A tombstone beside a file its delete did not get to remove
    // is therefore a tombstone here, not a live Resource. Its sidecar was
    // read to judge the file, so the tombstone pass below takes it from
    // `judgedSidecars` rather than reading it again. An id with both names
    // is read as the newer of the two (`readMetaSidecar`). A sidecar that
    // does not parse leaves its Resource out, here and as a tombstone
    // candidate, with one `warn` line.
    const names = this.#sidecarNames(entries)
    const { live: liveEntries, sidecars: judgedSidecars } =
      await this.#judgeRepresentations({
        dir: collectionDir,
        representations: this.#representationEntries(entries),
        names
      })
    const liveIds = new Set(liveEntries.map(({ resourceId }) => resourceId))
    const { tombstones: tombstoneIds } = names

    // Build descriptors (no body reads yet): one per live Resource or
    // Resource tombstone, whatever its content type. A live sidecar with no
    // file it names is anomalous, and is excluded unread. Each
    // sidecar read is an independent file read, so the whole pass runs in
    // parallel. A live JSON descriptor carries the `bodyFile` to read its
    // `data` from; any other descriptor already IS its feed document.
    type Descriptor = {
      document: FeedDocument
      bodyFile?: string
    }
    const liveDescriptors = liveEntries.map(
      async ({
        resourceId,
        sidecar,
        ...live
      }): Promise<Descriptor | undefined> => {
        // The feed position and the content stamp come from the sidecar. A
        // Resource with no feed position in range, or no whole stamp, is
        // left out.
        const feedPosition = sidecar.feedPosition
        const stamp = stampOf(sidecar)
        if (!inFeed(feedPosition) || !isWriteStamp(stamp)) {
          return undefined
        }
        // The content and `/meta` validators ride beside the stamps, so the
        // request layer can format the wire `etag` / `metaEtag` without a
        // fetch per Resource.
        const validator = validatorOf({
          generation: sidecar.generation,
          ...stamp
        })
        const metaValidator = sidecar.meta && validatorOf(sidecar.meta)
        return {
          document: {
            kind: 'resource',
            resourceId,
            contentType: live.contentType,
            feedPosition,
            ...stamp,
            ...(validator !== undefined && { validator }),
            ...(sidecar.meta !== undefined && { meta: sidecar.meta }),
            ...(metaValidator !== undefined && { metaValidator }),
            // The creator's DID rides the feed so provenance replicates with
            // the document, rather than needing a `/meta` fetch per Resource.
            ...(sidecar.createdBy !== undefined && {
              createdBy: sidecar.createdBy
            }),
            deleted: false,
            // The user-writable `custom` (the opaque encryption envelope on
            // an encrypted Collection) rides the feed so metadata replicates
            // alongside content; read from the sidecar already loaded here.
            ...(sidecar.custom !== undefined && { custom: sidecar.custom }),
            // The client-declared key epoch (the `key-epochs` feature) rides
            // the feed so a replicating reader picks the right epoch key.
            ...(sidecar.epoch !== undefined && { epoch: sidecar.epoch }),
            // The writer-attribution label (spec "Writer attribution") rides
            // the feed so a replica recognizes its own writes echoed back.
            ...(sidecar.writerId !== undefined && {
              writerId: sidecar.writerId
            })
          },
          // Only a live JSON Resource carries `data`; a binary or
          // `text/jsonl` one is fetched by its own GET.
          ...(isJsonContentType(live.contentType) && {
            bodyFile: live.fileName
          })
        }
      }
    )
    // A tombstone file with no live file beside it is a tombstone candidate;
    // keep only the ones that read as tombstones (`deleted: true`), which
    // leaves out a pair whose live sidecar is the newer. One read already to
    // judge a file beside it is not repeated.
    const tombstoneDescriptors = [...tombstoneIds]
      .filter(resourceId => !liveIds.has(resourceId))
      .map(async (resourceId): Promise<Descriptor | undefined> => {
        const sidecar = judgedSidecars.has(resourceId)
          ? judgedSidecars.get(resourceId)
          : await this.#readListedSidecar({
              dir: collectionDir,
              resourceId,
              names: { live: false, tombstone: true }
            })
        const stamp = stampOf(sidecar)
        if (
          sidecar?.deleted !== true ||
          typeof sidecar.contentType !== 'string' ||
          !inFeed(sidecar.feedPosition) ||
          !isWriteStamp(stamp)
        ) {
          return undefined
        }
        const validator = validatorOf({
          generation: sidecar.generation,
          ...stamp
        })
        return {
          document: {
            kind: 'resource',
            resourceId,
            // The last-known media type, kept on the tombstone by the delete.
            contentType: sidecar.contentType,
            feedPosition: sidecar.feedPosition,
            ...stamp,
            // A soft delete dropped the `/meta` record, so a tombstone
            // carries no `meta`.
            ...(validator !== undefined && { validator }),
            // A tombstone keeps its creator, as it keeps its `createdAt`.
            ...(sidecar.createdBy !== undefined && {
              createdBy: sidecar.createdBy
            }),
            deleted: true,
            // A tombstone carries the label its DELETE declared, if any (spec
            // "Writer attribution").
            ...(sidecar.writerId !== undefined && {
              writerId: sidecar.writerId
            })
          }
        }
      })
    const descriptors = [
      ...collectionDocuments.map((document): Descriptor => ({ document })),
      ...policyDocuments.map((document): Descriptor => ({ document })),
      ...(
        await Promise.all([...liveDescriptors, ...tombstoneDescriptors])
      ).filter((desc): desc is Descriptor => desc !== undefined)
    ]

    // Order by feed position ascending. Positions are unique within the
    // Collection, across kinds, so this is a total order, and the seek past
    // `afterPosition` already happened in `inFeed`.
    descriptors.sort(
      (left, right) => left.document.feedPosition - right.document.feedPosition
    )

    const pageSize = clampPageSize(limit)
    const pageDescriptors = descriptors.slice(0, pageSize)

    // Read JSON bodies only for this page. A tombstone carries no `data` (the
    // delete replicates on `deleted: true` alone), and neither does a binary
    // or `text/jsonl` Resource or a Collection-level record.
    const documents = await Promise.all(
      pageDescriptors.map(async ({ document, bodyFile }) => {
        if (bodyFile === undefined) {
          return document
        }
        const data = await readJsonOrUndefined(
          path.join(collectionDir, bodyFile)
        )
        return { ...document, data }
      })
    )

    const last = documents[documents.length - 1]
    return {
      documents,
      checkpoint: last ? last.feedPosition : null,
      ...(feedGeneration !== undefined && { feedGeneration })
    }
  }

  /**
   * Blinded-index query (the `blinded-index` query profile; see the
   * `StorageBackend.queryByBlindedIndex` contract). Enumerates the Collection
   * dir, reads and parses every live JSON Resource, and hands the candidates
   * to the shared evaluator (`lib/blindedIndex.ts`) for matching, ordering,
   * and cursor pagination. O(n) over the Collection per call, with every JSON
   * body read -- acceptable for this teaching backend; an indexed backend
   * would answer from flattened attribute tokens. Tombstones are excluded
   * naturally (no live content file); binary Resources and unparsable JSON
   * are skipped.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.query {BlindedIndexQuery}
   * @param [options.count] {boolean}   return only the match count
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page
   * @returns {Promise<{ count: number } | BlindedIndexQueryPage>}
   */
  async queryByBlindedIndex({
    spaceId,
    collectionId,
    query,
    count,
    limit,
    cursor
  }: {
    spaceId: string
    collectionId: string
    query: BlindedIndexQuery
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | BlindedIndexQueryPage> {
    const candidates = jsonCandidatesFrom(
      await this.#readEqualityCandidates({
        spaceId,
        collectionId,
        jsonOnly: true
      })
    )
    return runBlindedIndexQuery({ candidates, query, count, limit, cursor })
  }

  /**
   * Plaintext equality query (the `equality` query profile; see the
   * `StorageBackend.queryByEquality` contract). Reads every live Resource of
   * the Collection -- JSON Resources carrying parsed `content`, blobs carrying
   * only their sidecar `custom` -- and hands the candidates to the shared
   * evaluator (`lib/equalityIndex.ts`) for extraction, matching, ordering, and
   * cursor pagination. O(n) over the Collection per call, with every JSON body
   * read -- deliberate for this teaching backend; a materialized backend would
   * answer from an attribute index. Tombstones are excluded naturally (no live
   * content file).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.query {EqualityQuery}
   * @param options.indexes {NormalizedIndexDeclaration[]}   the normalized
   *   declared indexes (the request layer resolves them from the Collection
   *   Metadata object)
   * @param [options.count] {boolean}   return only the match count
   * @param [options.limit] {number}   requested page size
   * @param [options.cursor] {string}   opaque cursor from a prior page
   * @returns {Promise<{ count: number } | EqualityQueryPage>}
   */
  async queryByEquality({
    spaceId,
    collectionId,
    query,
    indexes,
    count,
    limit,
    cursor
  }: {
    spaceId: string
    collectionId: string
    query: EqualityQuery
    indexes: NormalizedIndexDeclaration[]
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | EqualityQueryPage> {
    const candidates = await this.#readEqualityCandidates({
      spaceId,
      collectionId
    })
    return runEqualityQuery({
      candidates,
      query,
      indexes,
      count,
      limit,
      cursor
    })
  }

  /**
   * Declare-time uniqueness scan for the `equality` profile (see the
   * `StorageBackend.findEqualityUniqueViolation` contract): reads the
   * Collection's live Resources and delegates to the shared scan, which reports
   * the first `(name, value)` claimed by two different Resources under the given
   * `unique` declarations (or `undefined` when none is).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.indexes {NormalizedIndexDeclaration[]}
   * @returns {Promise<{ name: string, value: EqualityValue } | undefined>}
   */
  async findEqualityUniqueViolation({
    spaceId,
    collectionId,
    indexes
  }: {
    spaceId: string
    collectionId: string
    indexes: NormalizedIndexDeclaration[]
  }): Promise<{ name: string; value: EqualityValue } | undefined> {
    const candidates = await this.#readEqualityCandidates({
      spaceId,
      collectionId
    })
    return findEqualityUniqueViolation({ indexes, candidates })
  }

  /**
   * Reads every live Resource of a Collection as an equality candidate -- the
   * candidate set for the equality query and the plaintext unique-attribute
   * conflict scans. It INCLUDES blob Resources (a blob is queryable through
   * its `custom`-sourced attributes): each entry resolves
   * `{ resourceId, content?, custom? }`, where `content` is the parsed JSON of
   * a JSON-typed representation (the blob content read is skipped, and
   * unparsable JSON is dropped; `jsonCandidatesFrom` narrows the set to the
   * blinded-index candidates) and `custom` is the
   * `.meta.` sidecar's `custom` when present. Only a file a live sidecar
   * names is a candidate (`#judgeRepresentations`), so a tombstone and a
   * file a crash left behind are excluded; an optional excluded Resource is
   * skipped. A sidecar that does not parse leaves its Resource out with a
   * `warn` line (`#readListedSidecar`), for the queries and the unique scans
   * alike. An absent Collection dir resolves empty.
   *
   * With `jsonOnly` the scan is the slimmer blinded-index one: blob Resources
   * are skipped before any read, and each candidate is
   * `{ resourceId, content? }`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.excludeResourceId] {string}   omit this Resource (a conflict
   *   scan excludes the Resource being written)
   * @param [options.jsonOnly] {boolean}   JSON representations only, with
   *   no `custom`
   * @returns {Promise<EqualityCandidate[]>}
   */
  async #readEqualityCandidates({
    spaceId,
    collectionId,
    excludeResourceId,
    jsonOnly = false
  }: {
    spaceId: string
    collectionId: string
    excludeResourceId?: string
    jsonOnly?: boolean
  }): Promise<EqualityCandidate[]> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })

    // A `jsonOnly` scan drops the blob files by name, and every scan drops
    // the excluded Resource's files, before their sidecars are read.
    const entries = await readDirEntries(collectionDir)
    const representations = this.#representationEntries(entries).filter(
      ({ resourceId, contentType }) =>
        resourceId !== excludeResourceId &&
        (!jsonOnly || isJsonContentType(contentType))
    )

    const { live } = await this.#judgeRepresentations({
      dir: collectionDir,
      representations,
      names: this.#sidecarNames(entries)
    })
    // Each content file is an independent read, so they are read in
    // batches; the order is kept.
    return mapInBatches({
      items: live,
      map: async ({ resourceId, fileName, contentType, sidecar }) => {
        // Parse the content only for a JSON representation; a blob contributes
        // no content-sourced attributes (its `custom` still makes it
        // queryable). Unparsable JSON is treated as no content.
        const content = isJsonContentType(contentType)
          ? await readJsonOrUndefined(path.join(collectionDir, fileName))
          : undefined
        return {
          resourceId,
          ...(content !== undefined && { content }),
          ...(!jsonOnly &&
            sidecar.custom !== undefined && { custom: sidecar.custom })
        }
      }
    })
  }

  /**
   * Reads and parses the stored JSON content of a live Resource already
   * located from its sidecar (`#readLiveFile`), or resolves `undefined` when
   * it is a blob or unparsable JSON -- the content side of a custom-sourced
   * unique-attribute claim on a metadata write.
   * @param options {object}
   * @param options.sidecar {MetaSidecar}   the live sidecar
   * @param options.filePath {string}   the file it names
   * @returns {Promise<unknown>}
   */
  async #readJsonContentAt({
    sidecar,
    filePath
  }: {
    sidecar: MetaSidecar
    filePath: string
  }): Promise<unknown> {
    if (!isJsonContentType(sidecar.contentType)) {
      return undefined
    }
    return readJsonOrUndefined(filePath)
  }

  // Policies

  /**
   * Builds the on-disk path for a policy document. Stored as a dot-file
   * alongside the matching `.space.meta.` / `.collection.meta.` metadata file:
   * the Space's own policy is `.space.policy.json` in the Space dir, the
   * Collection's own policy is `.collection.policy.json` in the Collection dir,
   * and a Resource's policy is `.r.<resourceId>.policy.json` in that same
   * Collection dir. The per-level names are what keep a Resource named like
   * its Collection from sharing the Collection's policy file.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {string}
   */
  #policyFile({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): string {
    const dir =
      collectionId !== undefined
        ? this.#collectionDir({ spaceId, collectionId })
        : this.#spaceDir(spaceId)
    let filename = SPACE_POLICY_FILE_NAME
    if (resourceId !== undefined) {
      filename = resourcePolicyFileName(resourceId)
    } else if (collectionId !== undefined) {
      filename = COLLECTION_POLICY_FILE_NAME
    }
    return this.#containedJoin(dir, filename)
  }

  /**
   * Reads a stored policy file for an export archive: its bytes (body, stamp
   * members and `_generation`) without the server-local `_feedPosition`, or
   * `undefined` for a tombstone, which does not travel, and for a file gone
   * since the directory was read. The position is written last, so dropping
   * it restores the bytes a file without it would have.
   * @param filePath {string}
   * @returns {Promise<Buffer | undefined>}
   */
  async #readArchivedPolicy(filePath: string): Promise<Buffer | undefined> {
    const bytes = await readFileIfPresent(filePath)
    return bytes && archivedPolicyFile(bytes)
  }

  /**
   * The per-policy mutex key (`policy:` prefix, its own key domain), held by
   * a policy write or delete for its read, precondition check and write. A
   * Collection- or Resource-level write nests the Collection's `feed:` key
   * inside it, and nothing else. A Resource-level write, and the policy
   * tombstone a Resource delete writes, take it inside the Resource key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {string}
   */
  #policyLockKey({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): string {
    return `policy:${spaceId}/${collectionId ?? ''}/${resourceId ?? ''}`
  }

  /**
   * The stored policy record at a level, live or a tombstone, beside its
   * validator. Every policy read goes through here; `getPolicy` drops a
   * tombstone.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<StoredPolicy | undefined>}   `undefined` when no record
   *   is stored at that level (must not throw)
   */
  async getPolicyRecord({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<StoredPolicy | undefined> {
    return storedPolicyFromFile(
      await this.#readJsonFile<unknown>(
        this.#policyFile({ spaceId, collectionId, resourceId })
      )
    )
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<PolicyDocument|undefined>}
   *   Resolves falsy when no live policy is set at that level, a tombstone
   *   included (must not throw).
   */
  async getPolicy({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<PolicyDocument | undefined> {
    const record = await this.getPolicyRecord({
      spaceId,
      collectionId,
      resourceId
    })
    return record?.deleted === false ? record.policy : undefined
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.policy {PolicyDocument}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @param [options.requireLiveResource] {boolean}   `false` when the
   *   Collection's Resources live on another backend; default `true`
   * @returns {Promise<PolicyWriteResult>}
   */
  async writePolicy({
    spaceId,
    collectionId,
    resourceId,
    policy,
    ifMatch,
    ifNoneMatch,
    requireLiveResource = true
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    policy: PolicyDocument
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    requireLiveResource?: boolean
  }): Promise<PolicyWriteResult> {
    const write = {
      spaceId,
      collectionId,
      resourceId,
      policy,
      ifMatch,
      ifNoneMatch
    }
    // Under the Space gate, and only into a Space (and Collection) that still
    // has its Metadata object, so a policy never materializes a container
    // directory the listings would then report.
    return this.#underSpaceWrite({
      spaceId,
      container: { collectionId },
      write: () =>
        collectionId !== undefined &&
        resourceId !== undefined &&
        requireLiveResource
          ? // A Resource-level policy is written only over a live Resource,
            // checked under the Resource key so it serializes with
            // `deleteResource`, which tombstones the policy under the same key.
            this.#writeMutex.run(
              this.#resourceLockKey({ spaceId, collectionId, resourceId }),
              async () => {
                await this.#assertResourceLive({
                  spaceId,
                  collectionId,
                  resourceId
                })
                return this.#writePolicyLocked(write)
              }
            )
          : this.#writePolicyLocked(write)
    })
  }

  /**
   * The policy write proper, under the policy's own key: read, precondition
   * check, stamp and persist. The caller holds the Space gate's shared side.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.policy {PolicyDocument}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<PolicyWriteResult>}
   */
  async #writePolicyLocked({
    spaceId,
    collectionId,
    resourceId,
    policy,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    policy: PolicyDocument
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<PolicyWriteResult> {
    return this.#writeMutex.run(
      this.#policyLockKey({ spaceId, collectionId, resourceId }),
      async () => {
        const prior = await this.getPolicyRecord({
          spaceId,
          collectionId,
          resourceId
        })
        const live = livePolicyUnderPrecondition({
          prior,
          spaceId,
          collectionId,
          resourceId,
          ifMatch,
          ifNoneMatch
        })
        // A write over a tombstone is a create: a new generation, and a
        // stamp above the tombstone's.
        const validator = await mintValidator({
          clock: this.#clock,
          prior: priorPolicyParts(prior)
        })
        const body = stampedPolicy({
          body: normalizePolicyWrite(policy),
          stamp: validator.stamp
        })
        await this.#persistPolicy({
          spaceId,
          collectionId,
          resourceId,
          body,
          generation: validator.generation
        })
        return { validator, created: live === undefined, policy: body }
      }
    )
  }

  /**
   * Refuses a Resource-level policy write when the Resource is absent or a
   * tombstone (`ResourceNotFoundError`, 404). The caller holds the Resource
   * key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<void>}
   */
  async #assertResourceLive({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<void> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    // A tombstone keeps its sidecar but names no file, so a live sidecar is
    // what marks the Resource live.
    const { live } = await this.#readLiveFile({
      collectionDir,
      resourceId,
      requestName: 'Update Policy'
    })
    if (live === undefined) {
      throw new ResourceNotFoundError({ requestName: 'Update Policy' })
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator | undefined>}   the tombstone's validator,
   *   or `undefined` when no live policy was stored (nothing written)
   */
  async deletePolicy({
    spaceId,
    collectionId,
    resourceId,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined> {
    // On the Space gate's shared side, so a container removal cannot land
    // between the read and the tombstone write. No container check: a delete
    // writes only over a live policy, whose directory is there.
    return this.#underSpaceWrite({
      spaceId,
      write: () =>
        this.#writeMutex.run(
          this.#policyLockKey({ spaceId, collectionId, resourceId }),
          () =>
            this.#tombstoneLivePolicy({
              spaceId,
              collectionId,
              resourceId,
              ifMatch,
              ifNoneMatch
            })
        )
    })
  }

  /**
   * Tombstones the live policy at a level, after evaluating the preconditions
   * against it. The tombstone keeps the generation and takes a stamp above
   * the live policy's. Writes nothing when no live policy is stored. Shared by
   * `deletePolicy` and the cascade in `deleteResource`. The caller holds the
   * Space gate's shared side and the policy's own key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator | undefined>}   the tombstone's validator,
   *   or `undefined` when nothing was written
   */
  async #tombstoneLivePolicy({
    spaceId,
    collectionId,
    resourceId,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined> {
    const prior = await this.getPolicyRecord({
      spaceId,
      collectionId,
      resourceId
    })
    const live = livePolicyUnderPrecondition({
      prior,
      spaceId,
      collectionId,
      resourceId,
      ifMatch,
      ifNoneMatch
    })
    if (live === undefined) {
      return undefined
    }
    const validator = await mintValidator({
      clock: this.#clock,
      prior: priorPolicyParts(live)
    })
    await this.#persistPolicy({
      spaceId,
      collectionId,
      resourceId,
      body: policyTombstoneBody(validator.stamp),
      generation: validator.generation
    })
    return validator
  }

  /**
   * Writes an archived policy at a level, under the archived generation and a
   * fresh stamp, when the destination stores no policy record there. A
   * tombstone counts as a record, so an import does not undo a delete.
   * Called from `importSpace`, which holds the Space gate's shared side.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.imported {ImportedPolicy}
   * @returns {Promise<boolean>}   whether the policy was written
   */
  async #importPolicy({
    spaceId,
    collectionId,
    resourceId,
    imported
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    imported: ImportedPolicy
  }): Promise<boolean> {
    return this.#underSpaceWrite({
      spaceId,
      container: { collectionId, requestName: 'Import Space' },
      write: () =>
        this.#writeMutex.run(
          this.#policyLockKey({ spaceId, collectionId, resourceId }),
          async () => {
            if (
              await this.getPolicyRecord({ spaceId, collectionId, resourceId })
            ) {
              return false
            }
            const body = stampedPolicy({
              body: imported.policy,
              stamp: await this.#clock.mint()
            })
            await this.#persistPolicy({
              spaceId,
              collectionId,
              resourceId,
              body,
              generation: imported.generation
            })
            return true
          }
        )
    })
  }

  /**
   * Writes a policy file. A Space policy takes no feed position and is
   * written directly. A Collection- or Resource-level one is written inside
   * `#takeFeedPosition`, which takes the Collection's next feed position
   * under the `feed:` key. The file is built from that position and carries
   * it as `_feedPosition`, so the counter file holds no per-policy state.
   * The caller holds the policy's own key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.body {PolicyDocument | PolicyTombstone}   the served body
   * @param options.generation {string}
   * @returns {Promise<void>}
   */
  async #persistPolicy({
    spaceId,
    collectionId,
    resourceId,
    body,
    generation
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    body: PolicyDocument | PolicyTombstone
    generation: string
  }): Promise<void> {
    const filePath = this.#policyFile({ spaceId, collectionId, resourceId })
    if (collectionId === undefined) {
      await atomicWriteFile({
        filePath,
        data: policyFile({ body, generation })
      })
      return
    }
    await this.#takeFeedPosition({
      spaceId,
      collectionId,
      collectionDir: this.#collectionDir({ spaceId, collectionId }),
      record: { kind: 'policy', resourceId },
      write: async feedPosition => {
        await atomicWriteFile({
          filePath,
          data: policyFile({ body, generation, feedPosition })
        })
      }
    })
  }

  // Registered external backends (spec "Backends")

  /**
   * Builds the on-disk path for a registered backend record: a
   * `.backend.<backendId>.json` dot-file in the Space dir (the same per-file
   * convention as `.space.meta.` and the policy dot-files). One file per
   * backend id.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {string}
   */
  #backendFile({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): string {
    return this.#containedJoin(
      this.#spaceDir(spaceId),
      `.backend.${backendId}.json`
    )
  }

  /**
   * Persists a full (secret-bearing) backend-registration record. Upsert.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @param options.record {StoredBackendRecord}
   * @returns {Promise<void>}
   */
  async writeBackend({
    spaceId,
    backendId,
    record
  }: {
    spaceId: string
    backendId: string
    record: StoredBackendRecord
  }): Promise<void> {
    // Under the Space gate, and only into a Space that still has its Metadata
    // object, so a registration never recreates a removed Space dir.
    return this.#underSpaceWrite({
      spaceId,
      container: {},
      write: async () => {
        await atomicWriteFile({
          filePath: this.#backendFile({ spaceId, backendId }),
          data: JSON.stringify(record)
        })
        // The served Space Metadata object lists this record under
        // `backends`, so its validator advances with the registration.
        await this.#advanceSpaceMetaLocal({ spaceId })
      }
    })
  }

  /**
   * Advances the Space Metadata object's local validator segment without
   * changing its stored body or minting a stamp, for a write that changes the
   * served object through a derived member -- `backends`, read off the
   * registration records -- rather than through the body itself. A stamp
   * would replicate as a write of the object; the local segment is this
   * server's own. The generation and stamp are kept, so a client's cached
   * `ETag` for the object stops matching through the local segment alone, as
   * it must for a strong validator. Serialized with the Metadata writes
   * through the same per-Space lock, so the advance cannot be lost under a
   * concurrent `writeSpace`. A Space with no Metadata object yet has no
   * validator to advance.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #advanceSpaceMetaLocal({
    spaceId
  }: {
    spaceId: string
  }): Promise<void> {
    await this.#writeMutex.run(
      this.#spaceMetaLockKey({ spaceId }),
      async () => {
        const prior = await this.getSpaceMetadata({ spaceId })
        if (!prior) {
          return
        }
        await this.#persistSpace({ spaceId, ...withLocalAdvanced(prior) })
      }
    )
  }

  /**
   * Reads the full (secret-bearing) record for one backend, for internal use
   * (existence checks, the future provider adapter). Resolves `undefined` when
   * absent. The only method that exposes secret connection material.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {Promise<StoredBackendRecord|undefined>}
   */
  async getBackend({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): Promise<StoredBackendRecord | undefined> {
    return this.#readJsonFile<StoredBackendRecord>(
      this.#backendFile({ spaceId, backendId })
    )
  }

  /**
   * Enumerates the Space's registered backends and returns them **sanitized**
   * (each mapped through `sanitizeBackendRecord`, so the secret connection
   * material never reaches the listing), sorted by id. An absent Space dir
   * reports no registered backends rather than throwing.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<BackendDescriptor[]>}
   */
  async listBackends({
    spaceId
  }: {
    spaceId: string
  }): Promise<BackendDescriptor[]> {
    const spaceDir = this.#spaceDir(spaceId)
    const entries = await readDirEntries(spaceDir)
    const backendFile = /^\.backend\..+\.json$/
    const reads = entries
      .filter(entry => entry.isFile() && backendFile.test(entry.name))
      .map(entry =>
        this.#readJsonFile<StoredBackendRecord>(path.join(spaceDir, entry.name))
      )
    const records = (await Promise.all(reads)).filter(
      (record): record is StoredBackendRecord => Boolean(record)
    )
    records.sort((a, b) => a.id.localeCompare(b.id))
    return records.map(sanitizeBackendRecord)
  }

  /**
   * Removes a registered backend record. Idempotent (no error if absent). A
   * removal that found the record advances the Space Metadata object's local
   * validator segment, since its `backends` listing changed; one that found
   * nothing leaves the object as it was.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {Promise<void>}
   */
  async deleteBackend({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): Promise<void> {
    // Under the Space gate: the local-segment advance rewrites the Space
    // Metadata file, which a concurrent Delete Space must not remove from
    // under it.
    return this.#underSpaceWrite({
      spaceId,
      write: async () => {
        if (await unlinkIfPresent(this.#backendFile({ spaceId, backendId }))) {
          await this.#advanceSpaceMetaLocal({ spaceId })
        }
      }
    })
  }

  // Replica registrations (the replication specification)

  /**
   * Defense in depth: asserts that a replica id passes the replica id rule
   * (`isReplicaId`), so a registration's files stay in its own Space dir and
   * name no other registration's files. The request layer refuses any other
   * id first.
   * @param replicaId {string}
   * @returns {void}
   */
  #assertReplicaId(replicaId: string): void {
    if (!isReplicaId(replicaId)) {
      throw new StorageError({
        cause: new Error(
          `Replica id "${replicaId}" is not a single, URL-safe path segment ` +
            'that does not end in ".state".'
        )
      })
    }
  }

  /**
   * Builds the on-disk path for a replica registration: a
   * `.replica.<replicaId>.json` dot-file in the Space dir, beside the
   * `.backend.` records. It holds the registration's members with the
   * record's generation and the Space generation it was made under embedded
   * as `_generation` and `_spaceGeneration`.
   *
   * The loop state file is named `.replica.<replicaId>.state.json`, so a
   * replica id ending in `.state` would name another registration's state
   * file. Such an id is refused here (`#assertReplicaId`), and so is one that
   * is not a single URL-safe path segment, which could name a file outside
   * the Space dir.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param [options.state] {boolean}   true for the registration's loop
   *   state file (`.replica.<replicaId>.state.json`), beside its record
   * @returns {string}
   */
  #replicaFile({
    spaceId,
    replicaId,
    state = false
  }: {
    spaceId: string
    replicaId: string
    state?: boolean
  }): string {
    this.#assertReplicaId(replicaId)
    const suffix = state ? '.state.json' : '.json'
    return this.#containedJoin(
      this.#spaceDir(spaceId),
      `.replica.${replicaId}${suffix}`
    )
  }

  /**
   * Runs a registration write or delete under the two keys it takes, in the
   * one order both take them: the Space-wide `replicas:` key (its own key
   * domain), which serializes every registration write and delete of one
   * Space so a write that reads the Space's registrations inside its critical
   * section (the bound on a delegated create, `decideReplicaWrite`) sees a set
   * no concurrent delete can thin, then the registration's own key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.run {() => Promise<T>}
   * @returns {Promise<T>}
   */
  #underReplicaLocks<T>({
    spaceId,
    replicaId,
    run
  }: {
    spaceId: string
    replicaId: string
    run: () => Promise<T>
  }): Promise<T> {
    return this.#writeMutex.run(`replicas:${spaceId}`, () =>
      this.#writeMutex.run(this.#replicaLockKey({ spaceId, replicaId }), run)
    )
  }

  /**
   * The mutex key (`replica:` prefix, its own key domain) that serializes a
   * registration's create, its delete and its loop state writes, so a state
   * write cannot land after the delete that removes the state file. Nothing
   * is acquired while it is held except the `spacemeta:` key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {string}
   */
  #replicaLockKey({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): string {
    return `replica:${spaceId}/${replicaId}`
  }

  /**
   * Stores a registration, create-only: `writeReplica` with no precondition,
   * refusing a registration already stored under the id.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.record {ReplicaRegistration}
   * @param options.pullsChunks {boolean}
   * @returns {Promise<StoredReplica>}
   */
  async createReplica({
    spaceId,
    record,
    pullsChunks,
    requireRegisteredSource
  }: {
    spaceId: string
    record: ReplicaRegistration
    pullsChunks: boolean
    requireRegisteredSource?: boolean
  }): Promise<StoredReplica> {
    const { stored } = await this.writeReplica({
      spaceId,
      record,
      pullsChunks,
      requireRegisteredSource,
      createOnly: true
    })
    return stored
  }

  /**
   * Creates or replaces a registration under its preconditions: under the
   * Space gate, into a Space that still has its Metadata object, under the
   * Space's registrations key, so no other registration write or delete of
   * the Space interleaves, and under the registration's own key, so a loop
   * state write cannot. The stored record is read first and the write decided
   * against it (`decideReplicaWrite`), the Space's registrations read under
   * the same keys when the decision needs them. A create removes a state file
   * an earlier registration under the id left, and advances the Space
   * Metadata object's local segment; a replacement keeps both.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.record {ReplicaRegistration}   the client's shape
   * @param options.pullsChunks {boolean}
   * @param [options.requireRegisteredSource] {boolean}
   * @param [options.createOnly] {boolean}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<{ stored: StoredReplica, prior?: StoredReplica }>}
   */
  async writeReplica({
    spaceId,
    record,
    pullsChunks,
    requireRegisteredSource = false,
    createOnly = false,
    ifMatch,
    ifNoneMatch
  }: {
    spaceId: string
    record: ReplicaRegistration
    pullsChunks: boolean
    requireRegisteredSource?: boolean
    createOnly?: boolean
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<{ stored: StoredReplica; prior?: StoredReplica }> {
    const replicaId = record.id
    const filePath = this.#replicaFile({ spaceId, replicaId })
    return this.#underSpaceWrite({
      spaceId,
      container: { requestName: replicaWriteRequestName({ createOnly }) },
      write: () =>
        this.#underReplicaLocks({
          spaceId,
          replicaId,
          run: async () => {
            const { stored, prior } = await decideReplicaWrite({
              prior: await this.#readReplicaFile(filePath),
              record,
              pullsChunks,
              clock: this.#clock,
              currentSpaceGeneration: async () =>
                resolveGeneration(
                  (await this.getSpaceMetadata({ spaceId }))?.metaGeneration
                ),
              listReplicas: () => this.listReplicas({ spaceId }),
              requireRegisteredSource,
              createOnly,
              ifMatch,
              ifNoneMatch
            })
            await atomicWriteFile({
              filePath,
              data: JSON.stringify({
                ...stored.record,
                _generation: stored.generation,
                _spaceGeneration: stored.spaceGeneration,
                _pullsChunks: stored.pullsChunks
              })
            })
            if (prior !== undefined) {
              return { stored, prior }
            }
            // A state file left by an earlier registration under this id
            // belongs to that registration.
            await rm(this.#replicaFile({ spaceId, replicaId, state: true }), {
              force: true
            })
            // The served Space Metadata object lists this record under
            // `replicas`, so its validator advances with the registration.
            await this.#advanceSpaceMetaLocal({ spaceId })
            return { stored }
          }
        })
    })
  }

  /**
   * Reads a registration file into its stored form, `undefined` when the
   * file is absent. A file that is present but carries no generation, no
   * Space generation or no write stamp is a store fault (`StorageError`),
   * not an absence: the layout migration refuses such a store at boot, so
   * one found later was damaged, and a create over it would overwrite it
   * and drop its loop state. A file written before the registration
   * recorded `pullsChunks` reads as `false`: such a registration pulls no
   * chunk sets until it is made again.
   * @param filePath {string}
   * @returns {Promise<StoredReplica | undefined>}
   * @throws {StorageError}
   */
  async #readReplicaFile(filePath: string): Promise<StoredReplica | undefined> {
    const raw = await this.#readJsonFile<
      ReplicaRegistration & {
        _generation?: string
        _spaceGeneration?: string
        _pullsChunks?: boolean
      }
    >(filePath)
    if (raw === undefined) {
      return undefined
    }
    if (
      typeof raw._generation !== 'string' ||
      typeof raw._spaceGeneration !== 'string' ||
      !isWriteStamp(raw)
    ) {
      throw new StorageError({
        cause: new Error(
          `The replica registration file ${filePath} carries no generation or write stamp.`
        )
      })
    }
    const {
      _generation: generation,
      _spaceGeneration: spaceGeneration,
      _pullsChunks: pullsChunks,
      ...record
    } = raw
    return {
      record,
      generation,
      spaceGeneration,
      pullsChunks: pullsChunks === true
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<StoredReplica | undefined>}
   */
  async getReplica({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<StoredReplica | undefined> {
    return this.#readReplicaFile(this.#replicaFile({ spaceId, replicaId }))
  }

  /**
   * Enumerates the Space's registrations, sorted by id. An absent Space dir
   * holds none. A registration file that does not read (`#readReplicaFile`
   * refuses it, or its JSON does not parse) is logged and left out, so one
   * damaged file does not take down Read Space, which lists the
   * registrations, or the start of every pull loop on the server. The
   * damaged registration's own read and write still fail on it.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<StoredReplica[]>}
   */
  async listReplicas({
    spaceId
  }: {
    spaceId: string
  }): Promise<StoredReplica[]> {
    const spaceDir = this.#spaceDir(spaceId)
    const entries = await readDirEntries(spaceDir)
    const reads = entries
      .filter(
        entry =>
          entry.isFile() &&
          /^\.replica\..+\.json$/.test(entry.name) &&
          !entry.name.endsWith('.state.json')
      )
      .map(async entry => {
        const filePath = path.join(spaceDir, entry.name)
        try {
          return await this.#readReplicaFile(filePath)
        } catch (err) {
          if (!(err instanceof StorageError || err instanceof SyntaxError)) {
            throw err
          }
          this.logger.error(
            { err, spaceId, filePath },
            'Skipping a replica registration file that does not read'
          )
          return undefined
        }
      })
    const replicas = (await Promise.all(reads)).filter(
      (replica): replica is StoredReplica => replica !== undefined
    )
    replicas.sort((left, right) =>
      compareCodeUnits(left.record.id, right.record.id)
    )
    return replicas
  }

  /**
   * Enumerates every registration in the store, Space by Space. An absent
   * spaces root holds none.
   * @returns {Promise<Array<StoredReplica & { spaceId: string }>>}
   */
  async listAllReplicas(): Promise<Array<StoredReplica & { spaceId: string }>> {
    let spaceIds: string[]
    try {
      spaceIds = await subdirectoryNames(this.spacesDir)
    } catch (err) {
      throw new StorageError({ cause: err as Error })
    }
    const perSpace = await mapInBatches({
      items: spaceIds,
      map: async spaceId =>
        (await this.listReplicas({ spaceId })).map(replica => ({
          ...replica,
          spaceId
        }))
    })
    return perSpace.flat()
  }

  /**
   * Removes a registration and its loop state. A removal that found the
   * record advances the Space Metadata object's local validator segment,
   * since its `replicas` listing changed.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<boolean>}   whether a registration was removed
   */
  async deleteReplica({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<boolean> {
    const filePath = this.#replicaFile({ spaceId, replicaId })
    return this.#underSpaceWrite({
      spaceId,
      write: () =>
        this.#underReplicaLocks({
          spaceId,
          replicaId,
          run: async () => {
            if (!(await unlinkIfPresent(filePath))) {
              return false
            }
            await rm(this.#replicaFile({ spaceId, replicaId, state: true }), {
              force: true
            })
            await this.#advanceSpaceMetaLocal({ spaceId })
            return true
          }
        })
    })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<ReplicaLoopState | undefined>}
   */
  async getReplicaState({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<ReplicaLoopState | undefined> {
    if (!(await fileExists(this.#replicaFile({ spaceId, replicaId })))) {
      return undefined
    }
    return this.#readJsonFile<ReplicaLoopState>(
      this.#replicaFile({ spaceId, replicaId, state: true })
    )
  }

  /**
   * Replaces a registration's loop state, under the key its delete takes, so
   * no state file is left behind a removed registration.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.state {ReplicaLoopState}
   * @returns {Promise<boolean>}   `false` when the registration is gone
   */
  async writeReplicaState({
    spaceId,
    replicaId,
    state
  }: {
    spaceId: string
    replicaId: string
    state: ReplicaLoopState
  }): Promise<boolean> {
    const recordPath = this.#replicaFile({ spaceId, replicaId })
    return this.#underSpaceWrite({
      spaceId,
      write: () =>
        this.#writeMutex.run(
          this.#replicaLockKey({ spaceId, replicaId }),
          async () => {
            if (!(await fileExists(recordPath))) {
              return false
            }
            await atomicWriteFile({
              filePath: this.#replicaFile({ spaceId, replicaId, state: true }),
              data: JSON.stringify(state)
            })
            return true
          }
        )
    })
  }

  // The apply path (records a pull loop read from a peer)

  /**
   * Runs an apply's critical section: on the Space gate's shared side, or its
   * exclusive side when `exclusive` is set, then under each `#writeMutex` key
   * in `lockKeys`, outermost first. Inside, it makes the two checks every
   * apply makes first (`guardApply`). The registration must be stored, and
   * made under the Space Metadata object's current generation. Then the
   * store's clock takes in each received stamp. Holding the Space gate keeps
   * the Space from being removed between the checks and the write. The
   * caller asserts the stamps receivable (`assertReceivableStamps`) first.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for an apply into a server
   *   backend other than the control plane, which runs under no
   *   registration
   * @param options.stamps {WriteStamp[]}   every stamp the record carries
   * @param options.lockKeys {string[]}   the keys the matching request-layer
   *   write takes
   * @param [options.exclusive] {boolean}   whether the apply runs on the Space
   *   gate's exclusive side
   * @param options.run {Function}   the rest of the apply, handed the Space
   *   Metadata object the checks read
   * @returns {Promise<ApplyResult>}
   */
  async #runApply({
    spaceId,
    replicaId,
    stamps,
    lockKeys,
    exclusive = false,
    run
  }: {
    spaceId: string
    replicaId?: string
    stamps: WriteStamp[]
    lockKeys: string[]
    exclusive?: boolean
    run: (context: {
      spaceMetadata: StoredSpaceMetadata
    }) => Promise<ApplyResult>
  }): Promise<ApplyResult> {
    const checkedApply = async (): Promise<ApplyResult> => {
      const spaceMetadata = await this.getSpaceMetadata({ spaceId })
      // A copy of a control-plane record (no `replicaId`) runs under no
      // registration; the Space must still hold a Metadata object.
      const registeredUnder =
        replicaId === undefined
          ? spaceMetadata?.metaGeneration
          : (await this.getReplica({ spaceId, replicaId }))?.spaceGeneration
      const stopped = guardApply({
        registeredUnder,
        spaceGeneration: spaceMetadata?.metaGeneration,
        clock: this.#clock,
        stamps
      })
      if (stopped) {
        return stopped
      }
      // `guardApply` refuses a Space with no Metadata object.
      return run({ spaceMetadata: spaceMetadata! })
    }
    const locked = lockKeys.reduceRight<() => Promise<ApplyResult>>(
      (inner, lockKey) => () => this.#writeMutex.run(lockKey, inner),
      checkedApply
    )
    return exclusive
      ? this.#underSpaceRemoval({ spaceId, remove: locked })
      : this.#underSpaceWrite({ spaceId, write: locked })
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param [options.name] {string}
   * @param options.stamp {WriteStamp}
   * @returns {Promise<ApplyResult>}
   */
  async applySpaceName({
    spaceId,
    replicaId,
    name,
    stamp
  }: {
    spaceId: string
    replicaId: string
    name?: string
    stamp: WriteStamp
  }): Promise<ApplyResult> {
    assertReceivableStamps([stamp])
    return this.#runApply({
      spaceId,
      replicaId,
      stamps: [stamp],
      lockKeys: [this.#spaceMetaLockKey({ spaceId })],
      // The checks read the Space Metadata object under this write's lock.
      run: async ({ spaceMetadata: prior }) => {
        if (!stampWins({ incoming: stamp, held: stampOf(prior) })) {
          return { outcome: 'skipped' }
        }
        const { name: _heldName, ...kept } = stripMetadataValidator(prior)
        await this.#persistSpace({
          spaceId,
          body: {
            ...kept,
            ...(name !== undefined && { name }),
            ...pickStamp(stamp)
          },
          generation: resolveGeneration(prior.metaGeneration),
          local: 0
        })
        return { outcome: 'applied' }
      }
    })
  }

  /**
   * Applies a Collection Metadata object or a Collection tombstone. It runs
   * on the exclusive side of the Space gate, since a `replace` and a `delete`
   * remove the Collection's members, as Delete Collection does.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.collectionId {string}
   * @param options.collection {object}   the received object, or tombstone
   * @returns {Promise<ApplyResult>}
   */
  async applyCollection({
    spaceId,
    replicaId,
    collectionId,
    collection
  }: {
    spaceId: string
    replicaId: string
    collectionId: string
    collection:
      | { deleted: false; generation: string; metadata: CollectionMetadata }
      | { deleted: true; stamp: WriteStamp }
  }): Promise<ApplyResult> {
    const stamps = collection.deleted
      ? [collection.stamp]
      : [stampOf(collection.metadata), collection.metadata.created]
    assertReceivableStamps(stamps)
    return this.#runApply({
      spaceId,
      replicaId,
      stamps,
      lockKeys: [this.#collectionMetaLockKey({ spaceId, collectionId })],
      exclusive: true,
      run: async () => {
        const record = await this.#readCollectionRecord({
          spaceId,
          collectionId
        })
        const held =
          record &&
          heldCollection({
            deleted: isCollectionTombstone(record),
            generation: resolveGeneration(record.metaGeneration),
            stamp: stampOf(record),
            created: 'created' in record ? record.created : undefined
          })
        if (held?.kind === 'tombstone') {
          // A delete cut short is finished whatever the received record
          // does next.
          await this.#removeCollectionMembers({ spaceId, collectionId })
        }
        if (collection.deleted) {
          return this.#applyCollectionTombstone({
            spaceId,
            collectionId,
            record,
            held,
            stamp: collection.stamp
          })
        }
        return this.#applyLiveCollection({
          spaceId,
          collectionId,
          record,
          held,
          generation: collection.generation,
          metadata: collection.metadata
        })
      }
    })
  }

  /**
   * `applyCollection` for a received tombstone. The caller holds the Space
   * gate's exclusive side and the `cmeta:` key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.record] {StoredCollectionMetadata | StoredCollectionTombstone}
   *   the held record
   * @param [options.held] {HeldCollection}   the held record, as the rule
   *   reads it
   * @param options.stamp {WriteStamp}   the received tombstone's stamp
   * @returns {Promise<ApplyResult>}
   */
  async #applyCollectionTombstone({
    spaceId,
    collectionId,
    record,
    held,
    stamp
  }: {
    spaceId: string
    collectionId: string
    record?: StoredCollectionMetadata | StoredCollectionTombstone
    held?: HeldCollection
    stamp: WriteStamp
  }): Promise<ApplyResult> {
    const decision = decideCollectionTombstoneApply({ held, stamp })
    if (decision === 'skip') {
      return { outcome: 'skipped' }
    }
    if (decision === 'write') {
      // A directory left without a Metadata file is no Collection. It goes
      // first, so the tombstone stands alone.
      await rm(this.#collectionDir({ spaceId, collectionId }), {
        recursive: true,
        force: true
      })
      await this.#ensureCollectionDir({ spaceId, collectionId })
    }
    // The tombstone is durable before the members go, as in Delete
    // Collection, so a cascade cut short is finished from the disk alone.
    await this.#persistCollectionTombstone({
      spaceId,
      collectionId,
      stamp,
      generation: resolveGeneration(record?.metaGeneration)
    })
    if (decision === 'delete') {
      await this.#removeCollectionMembers({ spaceId, collectionId })
    }
    return { outcome: 'applied' }
  }

  /**
   * `applyCollection` for a received live object. The caller holds the Space
   * gate's exclusive side and the `cmeta:` key.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.record] {StoredCollectionMetadata | StoredCollectionTombstone}
   *   the held record
   * @param [options.held] {HeldCollection}   the held record, as the rule
   *   reads it
   * @param options.generation {string}   the received life's generation
   * @param options.metadata {CollectionMetadata}   the received object
   * @returns {Promise<ApplyResult>}
   */
  async #applyLiveCollection({
    spaceId,
    collectionId,
    record,
    held,
    generation,
    metadata
  }: {
    spaceId: string
    collectionId: string
    record?: StoredCollectionMetadata | StoredCollectionTombstone
    held?: HeldCollection
    generation: string
    metadata: CollectionMetadata
  }): Promise<ApplyResult> {
    const stamp = stampOf(metadata) as WriteStamp
    const decision = decideCollectionApply({
      held,
      incoming: { generation, stamp, created: metadata.created as WriteStamp }
    })
    if (decision === 'skip') {
      return { outcome: 'skipped' }
    }
    // The body as received, without any validator member, under the
    // received stamp.
    const received: CollectionMetadata = {
      ...normalizeMetadataWrite({ metadata }).body,
      ...stamp
    }
    if (decision === 'update') {
      const merged = mergeAppliedCollectionMetadata({
        held: stripMetadataValidator(record as StoredCollectionMetadata),
        incoming: received
      })
      if ('fork' in merged) {
        return { outcome: 'refused', reason: 'fork', detail: merged.fork }
      }
      await this.#persistCollection({
        spaceId,
        collectionId,
        body: merged.metadata,
        generation,
        local: 0,
        feedPosition: 'next'
      })
      return { outcome: 'applied' }
    }
    if (decision === 'replace') {
      // The held life ends as a delete does: its tombstone first, then its
      // members. The tombstone takes the held life's creating stamp, which
      // the received life's is above, so a replace cut short here is
      // finished as a create by the next apply.
      const live = held as Extract<HeldCollection, { kind: 'live' }>
      // A life stored before creating stamps existed has none. The epoch
      // sorts below every received creating stamp.
      const createdAtEpoch: WriteStamp = {
        updatedAt: EPOCH_ISO_STRING,
        updatedAtCounter: 0,
        originId: this.originId
      }
      await this.#persistCollectionTombstone({
        spaceId,
        collectionId,
        stamp: live.created ?? createdAtEpoch,
        generation: live.generation
      })
      await this.#removeCollectionMembers({ spaceId, collectionId })
    }
    // A create counts against the Collection quota. A replace does not
    // change the count.
    if (
      decision === 'create' &&
      this.maxCollectionsPerSpace !== undefined &&
      (await this.#liveCollectionIds({ spaceId })).length >=
        this.maxCollectionsPerSpace
    ) {
      throw new CountQuotaExceededError({
        scope: 'Collections per Space',
        limit: this.maxCollectionsPerSpace
      })
    }
    await this.#persistCollection({
      spaceId,
      collectionId,
      body: received,
      generation,
      local: 0,
      feedPosition: 'first'
    })
    return { outcome: 'applied' }
  }

  /**
   * Applies a Resource's content record, live or a tombstone, under the
   * per-Resource lock a content write takes.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for an apply into a server
   *   backend other than the control plane, which runs under no
   *   registration
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}
   * @param [options.createdAt] {string}
   * @param [options.createdBy] {string}
   * @param [options.writerId] {string}
   * @param options.resource {object}   the received representation, or the
   *   tombstone's last-known content type
   * @returns {Promise<ApplyResult>}
   */
  async applyResource({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    generation,
    stamp,
    createdAt,
    createdBy,
    writerId,
    resource,
    chunks
  }: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    generation: string
    stamp: WriteStamp
    createdAt?: string
    createdBy?: IDID
    writerId?: string
    resource:
      | { deleted: false; input: ResourceInput; epoch?: string }
      | { deleted: true; contentType: string }
    chunks?: { run: ChunkStagingRun; staged: number[] }
  }): Promise<ApplyResult> {
    assertReceivableStamps([stamp])
    if (chunks !== undefined) {
      if (resource.deleted) {
        throw new StorageError({
          cause: new Error('A Resource tombstone applies with no chunk set.')
        })
      }
      return this.#applyResourceWithChunks({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        generation,
        stamp,
        createdAt,
        createdBy,
        writerId,
        resource,
        chunks
      })
    }
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    return this.#runApply({
      spaceId,
      replicaId,
      stamps: [stamp],
      lockKeys: [this.#resourceLockKey({ spaceId, collectionId, resourceId })],
      run: async () => {
        const skipped = await this.#settleReceivedParent({
          spaceId,
          collectionId,
          collectionDir,
          resourceId
        })
        if (skipped !== undefined) {
          return skipped
        }
        const { prior, livePath, log, stopped } =
          await this.#decideReceivedResource({
            collectionDir,
            resourceId,
            stamp,
            incoming: resource.deleted ? undefined : resource.input
          })
        // A chunk directory beside a held tombstone is what a delete cut
        // short left, whatever this apply decides: a replay of the tombstone
        // is an equal-stamp skip, and a live record over it holds no chunks.
        await this.#clearChunksBesideTombstone({
          collectionDir,
          resourceId,
          prior
        })
        if (stopped) {
          return stopped
        }

        if (resource.deleted) {
          // The tombstone is written before the live sidecar and the file it
          // named are removed, as on Delete Resource, with no directory
          // listing. The `/meta` record and `custom` go with the Resource,
          // and the tombstone names no file.
          await this.#writeFeedSidecar({
            spaceId,
            collectionId,
            collectionDir,
            resourceId,
            prior,
            sidecar: {
              createdAt: createdAt ?? stamp.updatedAt,
              ...pickStamp(stamp),
              ...(createdBy !== undefined && { createdBy }),
              generation,
              deleted: true,
              contentType: resource.contentType,
              // The held record's digest, live or tombstone, as a local
              // delete carries it. A tombstone over nothing has none.
              ...(prior?.digest !== undefined && { digest: prior.digest }),
              ...(writerId !== undefined && { writerId })
            }
          })
          if (livePath !== undefined) {
            await rm(livePath, { force: true })
          }
          // The chunks and any chunk staging go after the tombstone, as on
          // Delete Resource. A crash before they are gone leaves a chunk
          // directory beside the tombstone, which the next write or apply of
          // the id, or the next boot, removes (`#clearChunksBesideTombstone`,
          // `#reclaimStagingAtBoot`).
          await rm(this.#chunkDir({ collectionDir, resourceId }), {
            recursive: true,
            force: true
          })
          await rm(this.#stagingDir({ collectionDir, resourceId }), {
            recursive: true,
            force: true
          })
          this.#forgetStagingCredits({
            under: this.#stagingDir({ collectionDir, resourceId })
          })
          this.#dropUsageCache({ spaceId })
          return { outcome: 'applied' }
        }

        const input = appliedInput({ input: resource.input, log })

        const filePath = this.#containedJoin(
          collectionDir,
          fileNameFor({ resourceId, contentType: input.contentType })
        )
        const digest = await this.#writeRepresentationBytes({
          spaceId,
          filePath,
          input
        })
        // The sidecar is written before any prior representation is pruned,
        // as on a content write.
        await this.#writeFeedSidecar({
          spaceId,
          collectionId,
          collectionDir,
          resourceId,
          prior,
          sidecar: appliedLiveSidecar({
            stamp,
            generation,
            createdAt,
            createdBy,
            writerId,
            epoch: resource.epoch,
            prior,
            filePath,
            digest
          })
        })
        await this.#removeReplacedFile({
          priorPath: livePath,
          keepPath: filePath
        })
        await this.#reclaimBesideTombstone({
          collectionDir,
          resourceId,
          prior,
          keepPath: filePath
        })
        return { outcome: 'applied' }
      }
    })
  }

  /**
   * The last-writer-wins decision of a received Resource content record
   * against the held one, under the Resource's lock: reads the held
   * sidecar and the live file it names, buffers both a history log's held
   * and incoming bytes (which decide it), and decides (`decideResourceApply`).
   * The plain apply and the chunk swap decide alike.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.stamp {WriteStamp}   the received record's stamp
   * @param [options.incoming] {ResourceInput}   the received content; a
   *   tombstone has none
   * @returns {Promise<{ prior?: MetaSidecar, livePath?: string,
   *   log?: { held?: Buffer, incoming: Buffer }, stopped?: ApplyResult }>}
   *   the held sidecar, the live file's path, the buffered log, and the
   *   outcome when the apply stores nothing
   */
  async #decideReceivedResource({
    collectionDir,
    resourceId,
    stamp,
    incoming
  }: {
    collectionDir: string
    resourceId: string
    stamp: WriteStamp
    incoming?: ResourceInput
  }): Promise<{
    prior?: MetaSidecar
    livePath?: string
    log?: { held?: Buffer; incoming: Buffer }
    stopped?: ApplyResult
  }> {
    // The held sidecar names the live representation, if one stands.
    const { prior, live } = await this.#readLiveFile({
      collectionDir,
      resourceId
    })
    const livePath = live?.filePath
    // A live history log is decided by its bytes, so both are read before
    // the decision.
    let log: { held?: Buffer; incoming: Buffer } | undefined
    if (resourceId === WEBVH_LOG_RESOURCE_ID && incoming !== undefined) {
      log = {
        held: livePath === undefined ? undefined : await readFile(livePath),
        incoming: await this.#bufferInput(incoming)
      }
    }
    const stopped = decideResourceApply({
      resourceId,
      deleted: incoming === undefined,
      stamp,
      held: stampOf(prior),
      log
    })
    return { prior, livePath, log, stopped }
  }

  /**
   * Reads a received representation into memory, for a history log, whose
   * bytes are compared with the stored ones before anything is written. The
   * upload cap bounds the read.
   * @param input {ResourceInput}
   * @returns {Promise<Buffer>}
   */
  async #bufferInput(input: ResourceInput): Promise<Buffer> {
    if (input.kind === 'json') {
      return storedJsonBytes(input.data)
    }
    this.#assertUploadSize({
      maxUploadBytes: this.maxUploadBytes,
      uploadBytes: input.declaredBytes
    })
    const chunks: Buffer[] = []
    await pipeline([
      input.stream,
      ...this.#uploadCapGuards(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk))
          callback()
        }
      })
    ])
    return Buffer.concat(chunks)
  }

  /**
   * Applies a Resource's `/meta` record, under the per-Resource lock a
   * metadata write takes. The content record is carried over as stored.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for an apply into a server
   *   backend other than the control plane, which runs under no
   *   registration
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.meta {ResourceMetaStamp}   the record's stamp and
   *   generation
   * @param [options.custom] {object}
   * @returns {Promise<ApplyResult>}
   */
  async applyResourceMetadata({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    meta,
    custom
  }: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    meta: ResourceMetaStamp
    custom?: ResourceMetadataCustom | Record<string, unknown>
  }): Promise<ApplyResult> {
    assertReceivableStamps([meta])
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    return this.#runApply({
      spaceId,
      replicaId,
      stamps: [meta],
      lockKeys: [this.#resourceLockKey({ spaceId, collectionId, resourceId })],
      run: async () => {
        if (!(await this.#readLiveCollection({ spaceId, collectionId }))) {
          return { outcome: 'skipped' }
        }
        // A live sidecar names the Resource's file. No sidecar, or a
        // tombstone, means no live Resource stands.
        const { prior, live } = await this.#readLiveFile({
          collectionDir,
          resourceId
        })
        if (!live || !stampWins({ incoming: meta, held: prior?.meta })) {
          return { outcome: 'skipped' }
        }
        const {
          custom: _heldCustom,
          meta: _heldMeta,
          ...contentRecord
        } = prior ?? {}
        const hasCustom = hasCustomMembers(custom)
        await this.#writeFeedSidecar({
          spaceId,
          collectionId,
          collectionDir,
          resourceId,
          prior,
          sidecar: {
            ...(contentRecord as MetaSidecar),
            createdAt: prior?.createdAt ?? meta.updatedAt,
            meta: { ...pickStamp(meta), generation: meta.generation },
            ...(hasCustom && { custom })
          }
        })
        return { outcome: 'applied' }
      }
    })
  }

  /**
   * Applies an access-control policy, live or a tombstone, under the key a
   * policy write takes.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for a copy of a
   *   control-plane record, which runs under no registration
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}
   * @param [options.policy] {PolicyDocument}   absent for a tombstone
   * @returns {Promise<ApplyResult>}
   */
  async applyPolicy({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    generation,
    stamp,
    policy
  }: {
    spaceId: string
    replicaId?: string
    collectionId?: string
    resourceId?: string
    generation: string
    stamp: WriteStamp
    policy?: PolicyDocument
  }): Promise<ApplyResult> {
    assertReceivableStamps([stamp])
    return this.#runApply({
      spaceId,
      replicaId,
      stamps: [stamp],
      lockKeys: [this.#policyLockKey({ spaceId, collectionId, resourceId })],
      run: async () => {
        if (
          collectionId !== undefined &&
          !(await this.#readLiveCollection({ spaceId, collectionId }))
        ) {
          return { outcome: 'skipped' }
        }
        const prior = await this.getPolicyRecord({
          spaceId,
          collectionId,
          resourceId
        })
        if (!stampWins({ incoming: stamp, held: priorPolicyParts(prior) })) {
          return { outcome: 'skipped' }
        }
        await this.#persistPolicy({
          spaceId,
          collectionId,
          resourceId,
          body:
            policy === undefined
              ? policyTombstoneBody(stamp)
              : stampedPolicy({
                  body: normalizePolicyWrite(policy),
                  stamp
                }),
          generation
        })
        return { outcome: 'applied' }
      }
    })
  }

  /**
   * Applies a Collection's governing history log, under the keys a log write
   * takes. A log that does not exist yet is created on the exclusive side of
   * the Space gate, as a guarded create is (see `writeCollectionLog`).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.collectionId {string}
   * @param options.body {string}   the received JSON Lines body
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}
   * @returns {Promise<ApplyResult>}
   */
  async applyCollectionLog({
    spaceId,
    replicaId,
    collectionId,
    body,
    generation,
    stamp
  }: {
    spaceId: string
    replicaId: string
    collectionId: string
    body: string
    generation: string
    stamp: WriteStamp
  }): Promise<ApplyResult> {
    assertReceivableStamps([stamp])
    const logExists = await fileExists(
      this.#collectionLogPath({ spaceId, collectionId })
    )
    return this.#runApply({
      spaceId,
      replicaId,
      stamps: [stamp],
      lockKeys: [
        this.#collectionMetaLockKey({ spaceId, collectionId }),
        this.#collectionLogLockKey({ spaceId, collectionId })
      ],
      exclusive: !logExists,
      run: async () => {
        const collectionMetadata = await this.#readLiveCollection({
          spaceId,
          collectionId
        })
        if (!collectionMetadata) {
          return { outcome: 'skipped' }
        }
        const prior = await this.#readCollectionLog({
          spaceId,
          collectionId
        })
        const decision = decideLogApply({
          held: prior?.body,
          incoming: body
        })
        if (decision === 'fork') {
          return logForkResult('governing history log')
        }
        if (decision === 'skip') {
          return { outcome: 'skipped' }
        }
        await this.#persistCollectionLog({
          spaceId,
          collectionId,
          collectionMetadata,
          log: { generation, ...pickStamp(stamp), body }
        })
        return { outcome: 'applied' }
      }
    })
  }

  // The chunk pull (chunk staging and the swap)

  /**
   * Defense in depth: refuses a chunk index outside the addressable range
   * (`parseChunkIndexSegment`), so a staged file always carries a name a
   * chunk route can address. The pull loop validates the source server's
   * listing first.
   * @param chunkIndex {number}
   * @returns {void}
   */
  #assertChunkIndex(chunkIndex: number): void {
    if (parseChunkIndexSegment(String(chunkIndex)) !== chunkIndex) {
      throw new StorageError({
        cause: new Error(
          `Chunk index ${chunkIndex} is not an integer in the addressable range.`
        )
      })
    }
  }

  /**
   * Opens the staging of `run` for one chunk pull, under the parent's lock,
   * after the checks every apply makes (`#runApply`, with no stamp to
   * observe) and the Collection check: finishes any swap of the Resource a
   * fault left torn (`#settleStaging`), drops the registration's runs for
   * other revisions of the parent (`#dropOtherRuns`), reads the chunk set
   * the swap will free and what the run already holds, makes the quota
   * pre-check of the set (`chunkSetQuotaRefusal`, net of the live chunks
   * the swap frees, as each `stageChunk` of the run is, so a same-size
   * rewrite passes it under a quota the live set fills), keeps the chunk
   * sizes for the credit each `stageChunk` takes (`#stagingCredit`),
   * and creates the run directory. Nothing of `run` is staged here, but a
   * torn swap of an earlier run that is finished first does change the
   * live set, and takes a feed position, before the pre-check answers.
   *
   * The usage is measured before the lock is taken, so a cold `du` of the
   * Space holds no Resource lock. The registration's other runs, dropped
   * under the lock, still count in that measurement; a set they alone push
   * over the quota is refused this cycle and fits the next.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   the registration to check; absent
   *   for a server backend other than the control plane
   * @param options.collectionId {string}
   * @param options.resourceId {string}   the parent Resource
   * @param options.run {ChunkStagingRun}   the staging key
   * @param options.listed {Array<{ index: number, size: number }>}   the
   *   source server's listing, checked
   * @returns {Promise<{ staged: Array<{ index: number, size: number,
   *   peerEtag: string }> } | ApplyResult>}   what the run holds, or the
   *   outcome that ends the chunk pull
   */
  async beginChunkStaging({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    run,
    listed
  }: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
    listed: Array<{ index: number; size: number }>
  }): Promise<
    { staged: StagedChunk[] } | Exclude<ApplyResult, { outcome: 'applied' }>
  > {
    for (const { index } of listed) {
      this.#assertChunkIndex(index)
    }
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const runDir = this.#stagingRunDir({ collectionDir, resourceId, run })
    let opened: { staged: StagedChunk[] } | undefined
    // The pre-check reads the cached usage total the in-write check reads
    // (`#assertSpaceHeadroom`), and nothing at all under no quota.
    const { capacityBytes } = this
    const usageBytes =
      capacityBytes === undefined ? 0 : (await this.#cachedUsage(spaceId)).used
    const result = await this.#runApply({
      spaceId,
      replicaId,
      stamps: [],
      lockKeys: [this.#resourceLockKey({ spaceId, collectionId, resourceId })],
      run: async () => {
        const skipped = await this.#settleReceivedParent({
          spaceId,
          collectionId,
          collectionDir,
          resourceId
        })
        if (skipped !== undefined) {
          return skipped
        }
        // The registration's staging for any other revision of the parent
        // is stale: the loop has moved past that revision. Its bytes still
        // count toward usage until it is gone, so it goes before the check.
        await this.#dropOtherRuns({ spaceId, runDir })
        const staged = await this.#listStagedChunksIn(runDir)
        // The swap frees the chunk directory whether or not the parent is
        // live: a set beside a tombstone goes with the swap too
        // (`#clearChunksBesideTombstone`), as the Postgres swap removes
        // every chunk row the set does not keep.
        const { chunks: live } = await this.listChunks({
          spaceId,
          collectionId,
          resourceId
        })
        const refused = chunkSetQuotaRefusal({
          listed,
          staged,
          liveBytes: live.reduce((total, { size }) => total + size, 0),
          usageBytes,
          ...(capacityBytes !== undefined && { capacityBytes }),
          maxUploadBytes: this.maxUploadBytes
        })
        if (refused !== undefined) {
          return refused
        }
        this.#stagingCredits.set(runDir, {
          liveSizes: new Map(live.map(({ index, size }) => [index, size])),
          credited: new Set()
        })
        // Created under the lock and the Space gate, after the Collection
        // check, so no transfer creates a directory a delete removed.
        await mkdir(runDir, { recursive: true })
        opened = { staged }
        return { outcome: 'applied' }
      }
    })
    if (result.outcome !== 'applied') {
      return result
    }
    return opened!
  }

  /**
   * Stages one chunk a pull loop read from the source server, in the run
   * directory of `run` (`#stagingRunDir`), which `beginChunkStaging` opened.
   * Two short critical sections under the parent's lock bracket the
   * transfer, which runs outside it, so several chunks of one run may be
   * staged at once. The first checks the registration (`#runApply`, with no
   * stamp to observe) and that the Collection is live, removes a chunk
   * staged at this index by an earlier read, reads the quota credit
   * (`#stagingCredit`), and creates the run directory when the run was not
   * opened. The transfer writes the bytes under the upload cap and the
   * Space headroom, with that credit. The second checks again and writes
   * the staged sidecar, which records the chunk as staged. A staging
   * directory removed during the transfer stages nothing: the answer is
   * `skipped` when the Collection is gone, and `retry` when it stands (a
   * local Delete Resource or a reclaim removed the run, and its bytes with
   * it).
   *
   * The parent Resource need not be held: a chunk pull stages the set of a
   * Resource this server does not hold yet, or holds as a tombstone, before
   * the swap creates it.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   the registration to check; absent
   *   for a server backend other than the control plane
   * @param options.collectionId {string}
   * @param options.resourceId {string}   the parent Resource
   * @param options.run {ChunkStagingRun}   the staging key
   * @param options.chunkIndex {number}
   * @param options.input {ResourceInput}
   * @param options.peerEtag {string}   the source server's `ETag`, opaque
   * @returns {Promise<ApplyResult | { outcome: 'retry' }>}
   */
  async stageChunk({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    run,
    chunkIndex,
    input,
    peerEtag
  }: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
    chunkIndex: number
    input: ResourceInput
    peerEtag: string
  }): Promise<ApplyResult | { outcome: 'retry' }> {
    this.#assertChunkIndex(chunkIndex)
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const runDir = this.#stagingRunDir({ collectionDir, resourceId, run })
    const chunkId = String(chunkIndex)
    const filePath = this.#containedJoin(
      runDir,
      fileNameFor({ resourceId: chunkId, contentType: input.contentType })
    )
    const underLock = (step: () => Promise<ApplyResult>) =>
      this.#runApply({
        spaceId,
        replicaId,
        stamps: [],
        lockKeys: [
          this.#resourceLockKey({ spaceId, collectionId, resourceId })
        ],
        run: async () =>
          (await this.#readLiveCollection({ spaceId, collectionId }))
            ? step()
            : { outcome: 'skipped' }
      })

    let creditBytes = 0
    const opened = await underLock(async () => {
      // A chunk an earlier read staged at this index goes first, sidecar
      // before file, so a crash during the transfer leaves no sidecar
      // describing bytes it did not record.
      await this.#removeStagedChunk({ runDir, chunkId })
      creditBytes = await this.#stagingCredit({
        spaceId,
        collectionId,
        resourceId,
        runDir,
        chunkIndex
      })
      // Created under the lock and the Space gate, after the Collection
      // check, so the transfer below never creates a directory a delete
      // removed.
      await mkdir(runDir, { recursive: true })
      return { outcome: 'applied' }
    })
    if (opened.outcome !== 'applied') {
      return opened
    }

    // The run directory was removed during the transfer, and the bytes with
    // it. A delete of the Collection or the Space leaves nothing to stage
    // into. A local Delete Resource or a reclaim leaves the Collection
    // standing, and the chunk is read again next cycle.
    const removedDuringTransfer = async (): Promise<
      ApplyResult | { outcome: 'retry' }
    > =>
      (await this.#collectionStands({ spaceId, collectionId }))
        ? { outcome: 'retry' }
        : { outcome: 'skipped' }

    let digest: string
    try {
      digest = await this.#writeRepresentationBytes({
        spaceId,
        filePath,
        input,
        creditBytes
      })
    } catch (err) {
      if (isEnoent(err)) {
        return removedDuringTransfer()
      }
      throw err
    }

    try {
      return await underLock(async () => {
        const { size } = await fsStat(filePath)
        const sidecar: StagedChunkSidecar = {
          ...sidecarFileMembers(filePath),
          size,
          peerEtag,
          digest
        }
        await atomicWriteFile({
          filePath: this.#containedJoin(runDir, metaSidecarFileName(chunkId)),
          data: JSON.stringify(sidecar)
        })
        return { outcome: 'applied' }
      })
    } catch (err) {
      if (isEnoent(err)) {
        return removedDuringTransfer()
      }
      throw err
    }
  }

  /**
   * The chunks staged under `run`: each staged sidecar whose file stands,
   * by ascending index. Takes no lock.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.run {ChunkStagingRun}
   * @returns {Promise<StagedChunk[]>}
   */
  async listStagedChunks({
    spaceId,
    collectionId,
    resourceId,
    run
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
  }): Promise<StagedChunk[]> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    return this.#listStagedChunksIn(
      this.#stagingRunDir({ collectionDir, resourceId, run })
    )
  }

  /**
   * The chunks staged in a run directory: each staged sidecar whose file
   * stands, by ascending index.
   * @param runDir {string}
   * @returns {Promise<StagedChunk[]>}
   */
  async #listStagedChunksIn(runDir: string): Promise<StagedChunk[]> {
    const staged = await mapInBatches({
      items: await this.#stagedChunkIndexes(runDir),
      map: async index => {
        const sidecar = await this.#readStagedChunk({
          runDir,
          chunkId: String(index)
        })
        return (
          sidecar && { index, size: sidecar.size, peerEtag: sidecar.peerEtag }
        )
      }
    })
    return staged
      .filter(entry => entry !== undefined)
      .sort((left, right) => left.index - right.index)
  }

  /**
   * The `chunks` form of `applyResource`: a live Resource content record
   * with its chunk set, under the per-Resource lock a content write takes,
   * in one critical section. After the checks every apply makes
   * (`#runApply`), the Collection check, and finishing any swap of the
   * Resource a fault left torn, the comparison is `applyResource`'s. On a
   * win the registration's runs for other revisions of the parent are
   * dropped (`#dropOtherRuns`). A loss or an equal stamp releases the run's
   * staging and answers `skipped`. A `staged` index the run does not hold,
   * or one named twice, is refused as `container-refused`, with nothing
   * live changed and the run's staging released, so its bytes do not count
   * toward usage while the Collection stalls.
   *
   * On a win, in this order:
   *
   * 1. A chunk directory beside a held tombstone is removed: a delete cut
   *    short left it, and it is no live set.
   * 2. The parent's representation is written into the run directory
   *    (`parent/`), under the upload cap and the quota.
   * 3. An empty `next/` directory is created, and the run's manifest is
   *    written, with the parent's sidecar as it will be written. From here
   *    the swap is finished rather than discarded.
   * 4. `#completeSwap` builds the new chunk directory in `next/`, swaps it in
   *    for the live one with two renames, moves the parent's file into the
   *    Collection dir, and writes the parent's sidecar, which takes the
   *    Collection's next feed position. That sidecar is the commit point and
   *    the first moment a reader or the feed sees the parent and its set.
   *    Then the run directory, the old chunk directory with it, is removed.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for a server backend other
   *   than the control plane
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}
   * @param [options.createdAt] {string}
   * @param [options.createdBy] {string}
   * @param [options.writerId] {string}
   * @param options.resource {object}   the received representation
   * @param options.chunks {object}   the run, and the indexes it moves in
   * @returns {Promise<ApplyResult>}
   */
  async #applyResourceWithChunks({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    generation,
    stamp,
    createdAt,
    createdBy,
    writerId,
    resource,
    chunks
  }: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    generation: string
    stamp: WriteStamp
    createdAt?: string
    createdBy?: IDID
    writerId?: string
    resource: { input: ResourceInput; epoch?: string }
    chunks: { run: ChunkStagingRun; staged: number[] }
  }): Promise<ApplyResult> {
    for (const index of chunks.staged) {
      this.#assertChunkIndex(index)
    }
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    const runDir = this.#stagingRunDir({
      collectionDir,
      resourceId,
      run: chunks.run
    })
    return this.#runApply({
      spaceId,
      replicaId,
      stamps: [stamp],
      lockKeys: [this.#resourceLockKey({ spaceId, collectionId, resourceId })],
      run: async () => {
        if (!(await this.#readLiveCollection({ spaceId, collectionId }))) {
          await this.#releaseStagingRun({ spaceId, runDir })
          return { outcome: 'skipped' }
        }
        await this.#settleStaging({
          spaceId,
          collectionId,
          collectionDir,
          resourceId,
          discardUnswapped: false
        })
        const { prior, log, stopped } = await this.#decideReceivedResource({
          collectionDir,
          resourceId,
          stamp,
          incoming: resource.input
        })
        if (stopped) {
          await this.#releaseStagingRun({ spaceId, runDir })
          return stopped
        }
        await this.#dropOtherRuns({ spaceId, runDir })
        const refused = await this.#refusedChunkSet({
          resourceId,
          runDir,
          staged: chunks.staged
        })
        if (refused) {
          await this.#releaseStagingRun({ spaceId, runDir })
          return refused
        }

        await this.#clearChunksBesideTombstone({
          collectionDir,
          resourceId,
          prior
        })
        const input = appliedInput({ input: resource.input, log })
        const parentFileName = fileNameFor({
          resourceId,
          contentType: input.contentType
        })
        const parentDir = this.#containedJoin(runDir, STAGING_PARENT_DIR_NAME)
        await mkdir(parentDir, { recursive: true })
        const parentDigest = await this.#writeRepresentationBytes({
          spaceId,
          filePath: path.join(parentDir, parentFileName),
          input
        })
        // The parent's sidecar as `applyResource` writes it.
        const manifest: StagingManifest = {
          parentEtag: chunks.run.parentEtag,
          staged: [...chunks.staged],
          parent: appliedLiveSidecar({
            stamp,
            generation,
            createdAt,
            createdBy,
            writerId,
            epoch: resource.epoch,
            prior,
            filePath: parentFileName,
            digest: parentDigest
          })
        }
        // `next/` stands from here until the directory swap, which is how a
        // finish tells a swap still to do from one done. One an earlier
        // attempt left before writing its manifest holds nothing of value.
        const nextDir = this.#containedJoin(runDir, STAGING_NEXT_DIR_NAME)
        await rm(nextDir, { recursive: true, force: true })
        await mkdir(nextDir)
        await atomicWriteFile({
          filePath: this.#containedJoin(runDir, STAGING_MANIFEST_FILE_NAME),
          data: JSON.stringify(manifest)
        })
        await this.#completeSwap({
          spaceId,
          collectionId,
          collectionDir,
          resourceId,
          runDir,
          manifest,
          held: prior
        })
        return { outcome: 'applied' }
      }
    })
  }

  /**
   * Removes the chunk staging in the scope the ids select, finishing every
   * run whose manifest stands (`#finishSwappedRun`) and discarding every
   * other. Each Resource's staging is reclaimed under its lock. A scope
   * that holds no staging creates no directory.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.replicaId] {string}
   * @returns {Promise<number>}   how many runs were finished or removed
   */
  async reclaimStaging({
    spaceId,
    collectionId,
    resourceId,
    replicaId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    replicaId?: string
  }): Promise<number> {
    if (replicaId !== undefined) {
      this.#assertReplicaId(replicaId)
    }
    const { finished, removed } = await this.#reclaimStagingIn({
      spaceId,
      collectionId,
      resourceId,
      replicaId
    })
    return finished + removed
  }

  /**
   * The walk `reclaimStaging` and the boot reclaim share: every staging
   * directory in the scope, each settled under its Resource's lock with
   * unswapped runs discarded.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.replicaId] {string}
   * @returns {Promise<{ finished: number, removed: number }>}
   */
  async #reclaimStagingIn({
    spaceId,
    collectionId,
    resourceId,
    replicaId
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    replicaId?: string
  }): Promise<{ finished: number; removed: number }> {
    const totals = { finished: 0, removed: 0 }
    const collectionIds =
      collectionId !== undefined
        ? [collectionId]
        : await this.#collectionIds({ spaceId })
    for (const stagedCollectionId of collectionIds) {
      const collectionDir = this.#collectionDir({
        spaceId,
        collectionId: stagedCollectionId
      })
      const resourceIds = await this.#stagedResourceIds({
        collectionDir,
        resourceId
      })
      for (const stagedResourceId of resourceIds) {
        const counts = await this.#underSpaceWrite({
          spaceId,
          write: () =>
            this.#writeMutex.run(
              this.#resourceLockKey({
                spaceId,
                collectionId: stagedCollectionId,
                resourceId: stagedResourceId
              }),
              () =>
                this.#settleStaging({
                  spaceId,
                  collectionId: stagedCollectionId,
                  collectionDir,
                  resourceId: stagedResourceId,
                  replicaId,
                  discardUnswapped: true
                })
            )
        })
        totals.finished += counts.finished
        totals.removed += counts.removed
      }
    }
    return totals
  }

  /**
   * The ids of the Resources under `collectionDir` that hold a staging
   * directory, or `resourceId` alone when it holds one, so a reclaim of a
   * Resource with no staging takes no lock.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<string[]>}
   */
  async #stagedResourceIds({
    collectionDir,
    resourceId
  }: {
    collectionDir: string
    resourceId?: string
  }): Promise<string[]> {
    if (resourceId !== undefined) {
      const stands = await fileExists(
        this.#stagingDir({ collectionDir, resourceId })
      )
      return stands ? [resourceId] : []
    }
    return (await readDirEntries(collectionDir))
      .filter(
        entry =>
          entry.isDirectory() && entry.name.startsWith(STAGING_DIR_PREFIX)
      )
      .map(entry =>
        parseChunkDirName(entry.name.slice(STAGING_DIR_LEAD.length))
      )
      .filter(stagedId => stagedId !== undefined)
  }

  /**
   * The prologue of a replicated write under a Resource's lock: skips when
   * the Collection is not live, else finishes a chunk swap a fault left
   * torn (`#settleStaging`), so the write decides against the settled
   * record and a tombstone sweep never removes the set that swap moved in.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @returns {Promise<{ outcome: 'skipped' } | undefined>} the skip result,
   *   or undefined once the Collection is live and the staging settled
   */
  async #settleReceivedParent({
    spaceId,
    collectionId,
    collectionDir,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
  }): Promise<{ outcome: 'skipped' } | undefined> {
    if (!(await this.#readLiveCollection({ spaceId, collectionId }))) {
      return { outcome: 'skipped' }
    }
    await this.#settleStaging({
      spaceId,
      collectionId,
      collectionDir,
      resourceId,
      discardUnswapped: false
    })
    return undefined
  }

  /**
   * Settles one Resource's chunk staging: finishes each run whose manifest
   * stands (a decided swap), and with `discardUnswapped` removes every
   * other run, then removes the registration and staging directories left
   * empty. With `replicaId`, only that registration's runs. The caller
   * holds the Resource's lock, or is the boot reclaim, before any request.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param [options.replicaId] {string}
   * @param options.discardUnswapped {boolean}
   * @returns {Promise<{ finished: number, removed: number }>}
   */
  async #settleStaging({
    spaceId,
    collectionId,
    collectionDir,
    resourceId,
    replicaId,
    discardUnswapped
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
    replicaId?: string
    discardUnswapped: boolean
  }): Promise<{ finished: number; removed: number }> {
    const totals = { finished: 0, removed: 0 }
    const stagingDir = this.#stagingDir({ collectionDir, resourceId })
    const replicaIds =
      replicaId !== undefined
        ? [replicaId]
        : await subdirectoryNames(stagingDir)
    for (const stagedReplicaId of replicaIds) {
      const replicaDir = this.#containedJoin(stagingDir, stagedReplicaId)
      for (const runName of await subdirectoryNames(replicaDir)) {
        const runDir = this.#containedJoin(replicaDir, runName)
        const manifest = await this.#readStagingManifest(runDir)
        if (manifest !== undefined) {
          const finished = await this.#finishSwappedRun({
            spaceId,
            collectionId,
            collectionDir,
            resourceId,
            runDir,
            manifest
          })
          totals[finished ? 'finished' : 'removed']++
        } else if (discardUnswapped) {
          await this.#releaseStagingRun({ spaceId, runDir })
          totals.removed++
        }
      }
    }
    if (discardUnswapped) {
      for (const stagedReplicaId of replicaIds) {
        await removeDirIfEmpty(this.#containedJoin(stagingDir, stagedReplicaId))
      }
      await removeDirIfEmpty(stagingDir)
    }
    return totals
  }

  /**
   * Finishes a run whose manifest stands: a swap a crash or a fault cut
   * short between the manifest and the run's removal. When the parent
   * holds the manifest's revision, or one it wins over, the swap is
   * completed (`#completeSwap`). When the Collection is gone, the run is
   * removed.
   *
   * Every write of the parent or of its chunks under the parent's lock
   * finishes a torn swap before it reads anything, and boot finishes them
   * before the tombstone sweep, so a later write is not expected to stand
   * over one. Should one stand, the run is removed and the chunk set that
   * write was made over is kept: a live set the swap renamed aside
   * (`prior/`) goes back in place when no chunk directory stands, and is
   * discarded when one does. When the live set was renamed aside but
   * `next/` was not yet moved in, and a chunk directory has since been
   * created, that write stands over the swap in the same way: the run,
   * `prior/` with it, is removed.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.runDir {string}
   * @param options.manifest {StagingManifest}
   * @returns {Promise<boolean>}   whether the run was finished
   */
  async #finishSwappedRun({
    spaceId,
    collectionId,
    collectionDir,
    resourceId,
    runDir,
    manifest
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
    runDir: string
    manifest: StagingManifest
  }): Promise<boolean> {
    if (!(await this.#collectionStands({ spaceId, collectionId }))) {
      await this.#releaseStagingRun({ spaceId, runDir })
      return false
    }
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    const priorDir = this.#containedJoin(runDir, STAGING_PRIOR_DIR_NAME)
    const chunkDirStands = await fileExists(chunkDir)
    const setAside =
      (await fileExists(priorDir)) &&
      (await fileExists(this.#containedJoin(runDir, STAGING_NEXT_DIR_NAME)))
    const held = await this.readMetaSidecar({ collectionDir, resourceId })
    const laterWrite =
      !holdsManifestParent({ held, manifest }) &&
      !stampWins({ incoming: pickStamp(manifest.parent), held: stampOf(held) })
    if (laterWrite || (setAside && chunkDirStands)) {
      this.logger.warn(
        { spaceId, collectionId, resourceId, parentEtag: manifest.parentEtag },
        'A later local write stands over a torn chunk swap; ' +
          'the swap is not finished'
      )
      if (!chunkDirStands && (await fileExists(priorDir))) {
        await fs.promises.rename(priorDir, chunkDir)
        await fsyncDirectory(collectionDir)
      }
      await this.#releaseStagingRun({ spaceId, runDir })
      return false
    }
    await this.#completeSwap({
      spaceId,
      collectionId,
      collectionDir,
      resourceId,
      runDir,
      manifest,
      held
    })
    return true
  }

  /**
   * Completes a decided swap from its run directory and manifest. Every step
   * can be run again over what an earlier, cut-short run of it left, so the
   * same code serves the apply and the finish of a torn swap.
   *
   * While `next/` stands the directory swap is still to do. Each staged
   * chunk's file is moved into it, and its sidecar written there with a
   * stamp minted from this store's clock (raised to the live chunk's stamp
   * at that index) and a fresh generation, as a client's chunk write mints
   * them; the live set stays whole for readers until the rename.
   * Whether `next/` holds anything is read before any rename, so no fault
   * between the two renames turns on that read. Then the live chunk
   * directory is renamed aside to `prior/`, unless an earlier run of this
   * step did so already, and `next/` into its place, or removed when it
   * holds nothing, so an emptied set leaves no directory, as Delete Chunk
   * leaves none.
   *
   * The parent's file is then moved into the Collection dir and its sidecar
   * written, unless the parent already holds the manifest's revision. The
   * sidecar takes the Collection's next feed position and is the commit
   * point. The parent's prior file under another type, and any file of the
   * id a delete left beside a tombstone, are removed after it. Last, the run
   * directory goes, and with it `prior/`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param options.runDir {string}
   * @param options.manifest {StagingManifest}
   * @param [options.held] {MetaSidecar}   the parent's sidecar as read under
   *   the lock
   * @returns {Promise<void>}
   */
  async #completeSwap({
    spaceId,
    collectionId,
    collectionDir,
    resourceId,
    runDir,
    manifest,
    held
  }: {
    spaceId: string
    collectionId: string
    collectionDir: string
    resourceId: string
    runDir: string
    manifest: StagingManifest
    held?: MetaSidecar
  }): Promise<void> {
    const chunkDir = this.#chunkDir({ collectionDir, resourceId })
    const nextDir = this.#containedJoin(runDir, STAGING_NEXT_DIR_NAME)
    const priorDir = this.#containedJoin(runDir, STAGING_PRIOR_DIR_NAME)
    if (await fileExists(nextDir)) {
      // Absent when the set was empty, or when an earlier run of this step
      // renamed it aside already.
      const liveSetStands =
        !(await fileExists(priorDir)) && (await fileExists(chunkDir))
      // What an earlier run of this step moved into `next/` already.
      const moved = new Set(
        (await readDirEntries(nextDir)).map(entry => entry.name)
      )
      await mapInBatches({
        items: manifest.staged.filter(
          index => !moved.has(metaSidecarFileName(String(index)))
        ),
        map: async index => {
          const chunkId = String(index)
          const staged = await this.#readStagedSidecar({ runDir, chunkId })
          if (staged === undefined) {
            throw new StorageError({
              cause: new Error(
                `The staged chunk ${index} of "${resourceId}" has no staged sidecar.`
              )
            })
          }
          const stagedPath = this.#containedJoin(runDir, staged.fileName)
          const movedPath = path.join(nextDir, staged.fileName)
          if (await fileExists(stagedPath)) {
            await fs.promises.rename(stagedPath, movedPath)
          }
          const heldChunk = liveSetStands
            ? await this.#readJsonFile<MetaSidecar>(
                this.#metaSidecarPath({
                  collectionDir: chunkDir,
                  resourceId: chunkId
                })
              ).catch(() => undefined)
            : undefined
          const chunkStamp = await this.#clock.mint({
            held: stampOf(heldChunk)
          })
          await this.#writeMetaSidecar({
            collectionDir: nextDir,
            resourceId: chunkId,
            sidecar: {
              createdAt: chunkStamp.updatedAt,
              ...chunkStamp,
              generation: newGeneration(),
              ...sidecarFileMembers(movedPath),
              // The staged bytes' digest, taken when they were staged.
              digest: staged.digest
            }
          })
        }
      })
      await fsyncDirectory(nextDir)
      const nextHolds = (await readDirEntries(nextDir)).length > 0
      if (liveSetStands) {
        await fs.promises.rename(chunkDir, priorDir)
      }
      if (nextHolds) {
        await fs.promises.rename(nextDir, chunkDir)
      } else {
        await fs.promises.rmdir(nextDir)
      }
      await fsyncDirectory(collectionDir)
      await fsyncDirectory(runDir)
    }

    const parentFileName = manifest.parent.fileName as string
    const parentPath = this.#containedJoin(collectionDir, parentFileName)
    if (holdsManifestParent({ held, manifest })) {
      // A finish after the commit: a file the prior revision left under
      // another type may still stand.
      await this.#removeRepresentationFilesOf({
        dir: collectionDir,
        resourceId,
        keep: parentFileName
      })
    } else {
      const stagedParent = this.#containedJoin(
        runDir,
        STAGING_PARENT_DIR_NAME,
        parentFileName
      )
      if (await fileExists(stagedParent)) {
        await fs.promises.rename(stagedParent, parentPath)
      }
      const heldPath = this.#heldFilePath({ collectionDir, resourceId, held })
      await this.#writeFeedSidecar({
        spaceId,
        collectionId,
        collectionDir,
        resourceId,
        sidecar: manifest.parent,
        prior: held
      })
      await this.#removeReplacedFile({
        priorPath: heldPath,
        keepPath: parentPath
      })
      await this.#reclaimBesideTombstone({
        collectionDir,
        resourceId,
        prior: held,
        keepPath: parentPath
      })
    }
    await this.#releaseStagingRun({ spaceId, runDir })
  }

  /**
   * The bytes a chunk staged now may count as free: the sizes of the live
   * chunks at every index the run stages, the one being staged included,
   * since the swap replaces each of them. Taken over the whole run rather
   * than per chunk, because the staged bytes of the run's earlier chunks
   * already count toward usage, and a per-chunk credit would refuse the
   * second chunk of a same-size rewrite under a quota the set fits. A chunk
   * directory beside a tombstone is credited too, since the swap removes it.
   * Read under the parent's lock. A run `beginChunkStaging` opened has its
   * live sizes in memory (`#stagingCredits`) and the indexes credited so
   * far, so the credit costs no directory read per chunk; a run staged
   * without an open reads the live set and the run directory.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.runDir {string}
   * @param options.chunkIndex {number}   the index being staged
   * @returns {Promise<number>}
   */
  async #stagingCredit({
    spaceId,
    collectionId,
    resourceId,
    runDir,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    runDir: string
    chunkIndex: number
  }): Promise<number> {
    const opened = this.#stagingCredits.get(runDir)
    if (opened !== undefined) {
      opened.credited.add(chunkIndex)
      let credit = 0
      for (const index of opened.credited) {
        credit += opened.liveSizes.get(index) ?? 0
      }
      return credit
    }
    const stagedIndexes = new Set(await this.#stagedChunkIndexes(runDir))
    stagedIndexes.add(chunkIndex)
    const { chunks } = await this.listChunks({
      spaceId,
      collectionId,
      resourceId
    })
    return chunks
      .filter(({ index }) => stagedIndexes.has(index))
      .reduce((sum, { size }) => sum + size, 0)
  }

  /**
   * Removes the registration's other runs for the Resource: every run
   * directory beside `runDir`, each staged for another revision of the
   * parent, which the loop has moved past. A run whose swap was decided is
   * finished before this is called (`#settleStaging`), so none is left
   * beside it.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.runDir {string}
   * @returns {Promise<void>}
   */
  async #dropOtherRuns({
    spaceId,
    runDir
  }: {
    spaceId: string
    runDir: string
  }): Promise<void> {
    const replicaDir = path.dirname(runDir)
    const others = (await subdirectoryNames(replicaDir)).filter(
      name => name !== path.basename(runDir)
    )
    for (const name of others) {
      const otherRunDir = this.#containedJoin(replicaDir, name)
      await rm(otherRunDir, { recursive: true, force: true })
      this.#stagingCredits.delete(otherRunDir)
    }
    if (others.length > 0) {
      this.#dropUsageCache({ spaceId })
    }
  }

  /**
   * The file a held live sidecar names, or `undefined` when the sidecar is
   * absent, a tombstone, or names no usable file.
   * @param options {object}
   * @param options.collectionDir {string}
   * @param options.resourceId {string}
   * @param [options.held] {MetaSidecar}
   * @returns {string | undefined}
   */
  #heldFilePath({
    collectionDir,
    resourceId,
    held
  }: {
    collectionDir: string
    resourceId: string
    held?: MetaSidecar
  }): string | undefined {
    if (held === undefined || held.deleted === true) {
      return undefined
    }
    try {
      return this.#namedFilePath({ collectionDir, resourceId, sidecar: held })
    } catch (err) {
      if (err instanceof StorageError) {
        return undefined
      }
      throw err
    }
  }

  /**
   * Refuses a swap whose chunk set does not match the staging
   * (`chunkSetRefusal`), from the run's staged sidecars.
   * @param options {object}
   * @param options.resourceId {string}
   * @param options.runDir {string}
   * @param options.staged {number[]}
   * @returns {Promise<ApplyResult | undefined>}   the refusal, or `undefined`
   */
  async #refusedChunkSet({
    resourceId,
    runDir,
    staged
  }: {
    resourceId: string
    runDir: string
    staged: number[]
  }): Promise<ApplyResult | undefined> {
    const stagedHeld = new Set(
      (
        await mapInBatches({
          items: staged,
          map: async index =>
            (await this.#readStagedChunk({
              runDir,
              chunkId: String(index)
            })) && index
        })
      ).filter(index => index !== undefined)
    )
    return chunkSetRefusal({ resourceId, staged, stagedHeld })
  }

  /**
   * Reads a staged chunk's sidecar in a run directory, whether or not its
   * file still stands there. `undefined` when it is absent or not a staged
   * sidecar.
   * @param options {object}
   * @param options.runDir {string}
   * @param options.chunkId {string}
   * @returns {Promise<StagedChunkSidecar | undefined>}
   */
  async #readStagedSidecar({
    runDir,
    chunkId
  }: {
    runDir: string
    chunkId: string
  }): Promise<StagedChunkSidecar | undefined> {
    const bytes = await readFileIfPresent(
      this.#containedJoin(runDir, metaSidecarFileName(chunkId))
    )
    return bytes === undefined
      ? undefined
      : stagedChunkSidecarOf(parseJsonOrUndefined(bytes))
  }

  /**
   * The indexes of the chunks staged in a run directory, from the sidecars
   * standing there.
   * @param runDir {string}
   * @returns {Promise<number[]>}
   */
  async #stagedChunkIndexes(runDir: string): Promise<number[]> {
    return (await readDirEntries(runDir))
      .filter(entry => entry.isFile())
      .map(entry => metaSidecarFileId(entry.name))
      .map(chunkId =>
        chunkId === undefined ? undefined : parseChunkIndexSegment(chunkId)
      )
      .filter(index => index !== undefined)
  }

  /**
   * A chunk staged in a run directory: its staged sidecar, when the file it
   * names stands beside it.
   * @param options {object}
   * @param options.runDir {string}
   * @param options.chunkId {string}
   * @returns {Promise<StagedChunkSidecar | undefined>}
   */
  async #readStagedChunk({
    runDir,
    chunkId
  }: {
    runDir: string
    chunkId: string
  }): Promise<StagedChunkSidecar | undefined> {
    const sidecar = await this.#readStagedSidecar({ runDir, chunkId })
    if (
      sidecar === undefined ||
      !(await fileExists(this.#containedJoin(runDir, sidecar.fileName)))
    ) {
      return undefined
    }
    return sidecar
  }

  /**
   * Removes a chunk staged at one index of a run, its sidecar before the
   * file it names.
   * @param options {object}
   * @param options.runDir {string}
   * @param options.chunkId {string}
   * @returns {Promise<void>}
   */
  async #removeStagedChunk({
    runDir,
    chunkId
  }: {
    runDir: string
    chunkId: string
  }): Promise<void> {
    const sidecar = await this.#readStagedSidecar({ runDir, chunkId })
    await rm(this.#containedJoin(runDir, metaSidecarFileName(chunkId)), {
      force: true
    })
    if (sidecar !== undefined) {
      await rm(this.#containedJoin(runDir, sidecar.fileName), { force: true })
    }
  }

  /**
   * Reads a run directory's manifest, `undefined` when it has none or it
   * does not parse as one (a run cut before its manifest was written whole
   * has none, since it is written atomically).
   * @param runDir {string}
   * @returns {Promise<StagingManifest | undefined>}
   */
  async #readStagingManifest(
    runDir: string
  ): Promise<StagingManifest | undefined> {
    const bytes = await readFileIfPresent(
      this.#containedJoin(runDir, STAGING_MANIFEST_FILE_NAME)
    )
    return bytes === undefined
      ? undefined
      : stagingManifestOf(parseJsonOrUndefined(bytes))
  }

  /**
   * Releases a staging run: removes its run directory, then its
   * registration's directory and the Resource's staging directory when
   * either is left empty, and drops the cached usage total, since staged
   * bytes count toward it.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.runDir {string}
   * @returns {Promise<void>}
   */
  async #releaseStagingRun({
    spaceId,
    runDir
  }: {
    spaceId: string
    runDir: string
  }): Promise<void> {
    await rm(runDir, { recursive: true, force: true })
    this.#stagingCredits.delete(runDir)
    const replicaDir = path.dirname(runDir)
    await removeDirIfEmpty(replicaDir)
    await removeDirIfEmpty(path.dirname(replicaDir))
    this.#dropUsageCache({ spaceId })
  }

  /**
   * The boot reclaim of chunk staging: no pull loop owns any staging before
   * the first request, so every run is settled, a swapped one finished and
   * every other removed (`#reclaimStagingIn`). Then a chunk directory a
   * delete cut short left beside a Resource tombstone is removed. A failure
   * on one Collection is logged and does not stop the open.
   * @returns {Promise<{ finished: number, removed: number, stranded: number }>}
   */
  async #reclaimStagingAtBoot(): Promise<{
    finished: number
    removed: number
    stranded: number
  }> {
    const totals = { finished: 0, removed: 0, stranded: 0 }
    for (const spaceId of await subdirectoryNames(this.spacesDir)) {
      for (const collectionId of await this.#collectionIds({ spaceId })) {
        try {
          const { finished, removed } = await this.#reclaimStagingIn({
            spaceId,
            collectionId
          })
          totals.finished += finished
          totals.removed += removed
          totals.stranded += await this.#clearStrandedChunkDirs({
            spaceId,
            collectionId
          })
        } catch (err) {
          this.logger.warn(
            { err, spaceId, collectionId },
            'Could not reclaim chunk staging at boot'
          )
        }
      }
    }
    return totals
  }

  /**
   * Removes every chunk directory in a Collection dir whose parent's
   * sidecar is a tombstone (`#clearChunksBesideTombstone`). Run at boot,
   * after the staging is settled, since a torn swap over a tombstone holds a
   * new set beside the tombstone until it is finished.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<number>}   how many directories were removed
   */
  async #clearStrandedChunkDirs({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<number> {
    const collectionDir = this.#collectionDir({ spaceId, collectionId })
    let cleared = 0
    const entries = await readDirEntries(collectionDir)
    // Only a chunk directory beside a tombstone's name is read further, so
    // a Collection with no tombstone opens no sidecar.
    const tombstoned = new Set(
      entries
        .filter(entry => entry.isFile())
        .map(entry => tombstoneSidecarFileId(entry.name))
        .filter(resourceId => resourceId !== undefined)
    )
    for (const entry of entries) {
      const resourceId = entry.isDirectory()
        ? parseChunkDirName(entry.name)
        : undefined
      if (resourceId === undefined || !tombstoned.has(resourceId)) {
        continue
      }
      const prior = await this.#readListedSidecar({
        dir: collectionDir,
        resourceId,
        names: { live: false, tombstone: true }
      })
      if (prior?.deleted === true) {
        await this.#clearChunksBesideTombstone({
          collectionDir,
          resourceId,
          prior
        })
        cleared++
      }
    }
    return cleared
  }

  /**
   * WebKMS keystores (the `/kms` facet). A sibling tree to Spaces:
   * `keystores/<localId>/` holds a keystore's `config.json` now, and its key
   * records / revocations in later tracks -- hence a directory per keystore
   * rather than a flat file.
   *
   * The directory holding one keystore's records, contained in `keystoresDir`.
   * @param keystoreId {string}   the keystore's server-generated local id
   * @returns {string}
   */
  #keystoreDir(keystoreId: string): string {
    const keystoreDir = path.join(this.keystoresDir, keystoreId)
    this.#assertContained(keystoreDir, this.keystoresDir)
    return keystoreDir
  }

  #keystoreConfigFile(keystoreId: string): string {
    return path.join(this.#keystoreDir(keystoreId), 'config.json')
  }

  /**
   * Persists a keystore config unconditionally (the create path -- local ids
   * are server-generated random values, so create never collides). The
   * sequence-gated update path is `updateKeystore`.
   * @param options {object}
   * @param options.keystoreId {string}   the keystore's local id
   * @param options.config {KeystoreConfig}
   * @returns {Promise<void>}
   */
  async writeKeystore({
    keystoreId,
    config
  }: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void> {
    await mkdir(this.#keystoreDir(keystoreId), { recursive: true })
    await atomicWriteFile({
      filePath: this.#keystoreConfigFile(keystoreId),
      data: JSON.stringify(config)
    })
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}   the keystore's local id
   * @returns {Promise<KeystoreConfig|undefined>}
   *   Resolves falsy when the keystore does not exist (must not throw).
   */
  async getKeystore({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<KeystoreConfig | undefined> {
    return this.#readJsonFile<KeystoreConfig>(
      this.#keystoreConfigFile(keystoreId)
    )
  }

  /**
   * Replaces a keystore config, gated atomically (under the per-keystore write
   * mutex) on: the keystore existing, `config.sequence` being exactly the
   * stored sequence + 1, and `config.kmsModule` matching the stored one (the
   * module is immutable). Any other state rejects with the protocol's single
   * merged 409 conflict.
   * @param options {object}
   * @param options.keystoreId {string}   the keystore's local id
   * @param options.config {KeystoreConfig}
   * @returns {Promise<void>}
   */
  async updateKeystore({
    keystoreId,
    config
  }: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void> {
    await this.#writeMutex.run(`keystore:${keystoreId}`, async () => {
      const existing = await this.getKeystore({ keystoreId })
      if (
        !existing ||
        config.sequence !== existing.sequence + 1 ||
        config.kmsModule !== existing.kmsModule
      ) {
        throw new KeystoreStateConflictError()
      }
      await atomicWriteFile({
        filePath: this.#keystoreConfigFile(keystoreId),
        data: JSON.stringify(config)
      })
    })
  }

  /**
   * Every stored keystore config whose `controller` matches, sorted by local
   * id (the request layer caps the wire result). An absent keystores root
   * (nothing stored yet) resolves an empty list; a directory without a
   * readable config file is skipped.
   * @param options {object}
   * @param options.controller {IDID}
   * @returns {Promise<KeystoreConfig[]>}
   */
  async listKeystoresByController({
    controller
  }: {
    controller: IDID
  }): Promise<KeystoreConfig[]> {
    let rootEntries: fs.Dirent[]
    try {
      rootEntries = await readDirEntries(this.keystoresDir)
    } catch (err) {
      throw new StorageError({ cause: err as Error })
    }
    const keystoreEntries = rootEntries
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    // Each config is an independent file read, so read them in parallel;
    // `Promise.all` preserves the sorted order.
    const configs = await Promise.all(
      keystoreEntries.map(entry => this.getKeystore({ keystoreId: entry.name }))
    )
    return configs
      .filter((config): config is KeystoreConfig => Boolean(config))
      .filter(config => config.controller === controller)
  }

  /**
   * The file holding one key record, contained in its keystore's `keys/`
   * subdirectory. The record is a plain JSON file (not a metadata store):
   * records are immutable once inserted, so there is no read-modify-write to
   * protect.
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @param options.localId {string}   the key's local id
   * @returns {string}
   */
  #keyFile({
    keystoreId,
    localId
  }: {
    keystoreId: string
    localId: string
  }): string {
    const keysDir = path.join(this.#keystoreDir(keystoreId), 'keys')
    const keyFile = path.join(keysDir, `${localId}.json`)
    this.#assertContained(keyFile, keysDir)
    return keyFile
  }

  /**
   * Inserts a key record, create-only: the exclusive-create write (`wx`)
   * enforces the `(keystoreId, localId)` uniqueness atomically, rejecting a
   * duplicate with the protocol's 409 (`KeyIdConflictError`).
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @param options.localId {string}   the key's local id
   * @param options.record {KmsKeyRecord}   the full (secret-bearing) record
   * @returns {Promise<void>}
   */
  async insertKey({
    keystoreId,
    localId,
    record
  }: {
    keystoreId: string
    localId: string
    record: KmsKeyRecord
  }): Promise<void> {
    const keyFile = this.#keyFile({ keystoreId, localId })
    await mkdir(path.dirname(keyFile), { recursive: true })
    try {
      // Durable, atomic create-only write: `atomicCreateFile` preserves the
      // `wx` uniqueness (an existing key file rejects with EEXIST) while also
      // fsyncing the record and its directory.
      await atomicCreateFile({
        filePath: keyFile,
        data: JSON.stringify(record, null, 2)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new KeyIdConflictError()
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @param options.localId {string}   the key's local id
   * @returns {Promise<KmsKeyRecord|undefined>}
   *   Resolves falsy when the key does not exist (must not throw).
   */
  async getKey({
    keystoreId,
    localId
  }: {
    keystoreId: string
    localId: string
  }): Promise<KmsKeyRecord | undefined> {
    try {
      const raw = await readFileIfPresent(
        this.#keyFile({ keystoreId, localId })
      )
      return raw && (JSON.parse(raw.toString('utf8')) as KmsKeyRecord)
    } catch (err) {
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * Every stored key record under the keystore (`keys/*.json`), sorted by local
   * id (the file name's stem). An absent keystore or `keys/` directory (no keys
   * yet) resolves an empty list; a non-`.json` entry is skipped. The record is
   * returned verbatim -- the at-rest cipher applies above the backend.
   * @param options {object}
   * @param options.keystoreId {string}   the owning keystore's local id
   * @returns {Promise<Array<{ localId: string, record: KmsKeyRecord }>>}
   */
  async listKeys({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<Array<{ localId: string; record: KmsKeyRecord }>> {
    const keysDir = path.join(this.#keystoreDir(keystoreId), 'keys')
    let entries: fs.Dirent[]
    try {
      entries = await readDirEntries(keysDir)
    } catch (err) {
      throw new StorageError({ cause: err as Error })
    }
    // Sort in code-unit order -- the SAME ordering the cursor seek
    // (`localId > after`) uses, so the keyset stays consistent
    // (localeCompare could disagree with the `>` operator and break paging).
    const localIds = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length))
      .sort(compareCodeUnits)
    // Each record is an independent file read, so read them in parallel;
    // `Promise.all` preserves the sorted order.
    const keys = await Promise.all(
      localIds.map(async localId => {
        const record = await this.getKey({ keystoreId, localId })
        // A record readable at readdir time but gone by getKey (a concurrent
        // prune) is simply skipped; the listing is a snapshot, not a lock.
        return record ? { localId, record } : undefined
      })
    )
    return keys.filter(key => key !== undefined)
  }

  /**
   * The file holding one zcap revocation record. For a keystore scope it lives
   * in that keystore's `revocations/` subdirectory; for a Space scope in the
   * Space dir's `ARCHIVE_REVOCATIONS_DIR` subdirectory. The file name folds the
   * `(delegator, capabilityId)` unique key into a SHA-256 digest (the shared
   * `revocationFileName` codec).
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.delegator {string}   the revoked capability's delegator
   * @param options.capabilityId {string}   the revoked capability's id
   * @returns {string}
   */
  #revocationFile({
    scope,
    delegator,
    capabilityId
  }: {
    scope: RevocationScope
    delegator: string
    capabilityId: string
  }): string {
    const fileName = revocationFileName({ delegator, capabilityId })
    if ('keystoreId' in scope) {
      return path.join(
        this.#keystoreDir(scope.keystoreId),
        'revocations',
        fileName
      )
    }
    return path.join(this.#spaceRevocationDir(scope.spaceId), fileName)
  }

  /**
   * Inserts a revocation record, create-only: the exclusive-create write
   * (`wx`) enforces the `(delegator, capability.id)` uniqueness atomically,
   * rejecting a duplicate with the protocol's 409
   * (`DuplicateRevocationError`).
   *
   * A Space-scoped insert runs on the Space gate's shared side and re-checks
   * the Space Metadata object there (`SpaceNotFoundError`, 404). A Delete
   * Space therefore lands wholly before the insert, which is then refused, or
   * wholly after it, and removes the record. Without the gate the insert's
   * `mkdir` of the record's directory could land mid-`rm` and recreate the
   * Space dir behind the delete, leaving a Space dir with no Metadata file
   * and one record in it.
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.record {RevocationRecord}   the revocation to store
   * @returns {Promise<void>}
   */
  async insertRevocation({
    scope,
    record
  }: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void> {
    if ('keystoreId' in scope) {
      // The keystore must already exist -- the postgres backend enforces this
      // via its foreign keys, so an absent-parent insert rejects identically
      // on both backends instead of mkdir-ing an orphan record dir here. (The
      // HTTP route 404-masks unknown scopes before reaching the store; this
      // guards direct backend use.)
      if (!(await this.getKeystore({ keystoreId: scope.keystoreId }))) {
        throw new StorageError({
          cause: new Error(
            'Cannot insert a revocation under an absent keystore.'
          )
        })
      }
      return this.#writeRevocationFile({ scope, record })
    }
    // The gate admits readers re-entrantly, so an import, which already holds
    // the shared side, nests safely.
    return this.#underSpaceWrite({
      spaceId: scope.spaceId,
      container: { requestName: 'Revoke Capability' },
      write: () => this.#writeRevocationFile({ scope, record })
    })
  }

  /**
   * `insertRevocation`'s write, for a caller that has already checked the
   * scope exists (and, for a Space, holds the Space gate). A Space-scoped
   * record's bytes count toward the Space's usage, so the write drops the
   * Space's cached usage total and the next Resource write re-measures. The
   * insert is not refused at capacity: a revocation withdraws a grant, and a
   * Space over its quota that could not revoke one would leave a leaked
   * capability valid. A record is a few hundred bytes, and the quota is a
   * soft limit.
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.record {RevocationRecord}   the revocation to store
   * @returns {Promise<void>}
   */
  async #writeRevocationFile({
    scope,
    record
  }: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void> {
    const revocationFile = this.#revocationFile({
      scope,
      delegator: record.meta.delegator,
      capabilityId: record.capability.id
    })
    await mkdir(path.dirname(revocationFile), { recursive: true })
    try {
      // Durable, atomic create-only write: `atomicCreateFile` preserves the
      // `wx` uniqueness (an existing revocation rejects with EEXIST) while also
      // fsyncing the record and its directory.
      await atomicCreateFile({
        filePath: revocationFile,
        data: JSON.stringify(record, null, 2)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DuplicateRevocationError()
      }
      throw new StorageError({ cause: err as Error })
    }
    if ('spaceId' in scope) {
      this.#dropUsageCache({ spaceId: scope.spaceId })
    }
  }

  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the scope (keystore or Space). A record past its
   * `meta.expires` GC horizon is pruned on the way through and counts as not
   * revoked -- the capability itself has expired, so verification already
   * rejects it on expiry (this is the filesystem analogue of a TTL index).
   * @param options {object}
   * @param options.scope {RevocationScope}   the owning keystore or Space
   * @param options.capabilities {CapabilitySummary[]}   the
   *   `(capabilityId, delegator)` pairs to check
   * @returns {Promise<boolean>}
   */
  async isRevoked({
    scope,
    capabilities
  }: {
    scope: RevocationScope
    capabilities: CapabilitySummary[]
  }): Promise<boolean> {
    const now = Date.now()
    // Each capability's record is an independent file read, so the chain is
    // checked in parallel: any one revoked record revokes it.
    const verdicts = await Promise.all(
      capabilities.map(async ({ capabilityId, delegator }) => {
        const revocationFile = this.#revocationFile({
          scope,
          delegator,
          capabilityId
        })
        let raw: Buffer | undefined
        try {
          raw = await readFileIfPresent(revocationFile)
        } catch (err) {
          throw new StorageError({ cause: err as Error })
        }
        if (raw === undefined) {
          return false
        }
        const record = JSON.parse(raw.toString('utf8')) as RevocationRecord
        if (record.meta.expires && Date.parse(record.meta.expires) <= now) {
          await rm(revocationFile, { force: true })
          if ('spaceId' in scope) {
            // Freed bytes: the next write re-measures the Space's usage.
            this.#dropUsageCache({ spaceId: scope.spaceId })
          }
          return false
        }
        return true
      })
    )
    return verdicts.some(Boolean)
  }
}
