/**
 * PostgreSQL persistence backend: stores Spaces, Collections, and Resources as
 * rows (schema in postgresSchema.ts), and WebKMS keystores in a sibling table
 * tree, implementing the same StorageBackend contract as the filesystem
 * backend (types.ts). Selected by configuration (`DATABASE_URL`) and injected
 * the same way (`createApp({ backend })`).
 *
 * Design departures from the filesystem backend (deliberate):
 * - Quota accounting is transactional (`spaces.usage_bytes`, maintained in the
 *   same transaction as every write/delete), making the per-Space capacity a
 *   HARD limit under concurrency. "Usage" is exactly the stored content bytes,
 *   the chunk pull's staged chunk bytes included; Space and Collection
 *   Metadata objects, policies, and Resource metadata are not counted (a
 *   divergence from the filesystem's `du`, which counts every file).
 * - Conditional writes use row locks (`SELECT ... FOR UPDATE`) and
 *   transactions instead of the single-process `KeyedMutex`. The write stamps
 *   come from one in-memory hybrid logical clock per backend (see
 *   `lib/hlc.ts`), so a store is still served by one server process: two
 *   processes over one schema share its origin id and could mint the same
 *   stamp twice.
 * - Blobs are buffered single-`bytea` writes bounded by `maxUploadBytes`; an
 *   unset cap defaults to `DEFAULT_MAX_UPLOAD_BYTES` rather than "unbounded"
 *   (unbounded buffering into a `bytea` is a footgun). Chunked-row streaming
 *   is a planned follow-up increment.
 * - `exportSpace` / `importSpace` speak the same tar dialect as the
 *   filesystem backend (same file-name codecs, same manifest), so archives
 *   migrate between the two backends in either direction; the Postgres import
 *   apply loop additionally runs in a single transaction (atomic rollback).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable } from 'node:stream'
import pg from 'pg'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import { POSTGRES_BACKEND_ID } from '../lib/serverBackends.js'
import {
  StorageError,
  ResourceImmutableError,
  ResourceNotFoundError,
  SpaceNotFoundError,
  CollectionNotFoundError,
  QuotaExceededError,
  CountQuotaExceededError,
  PayloadTooLargeError,
  PreconditionFailedError,
  InvalidSchemaNameError,
  KeystoreStateConflictError,
  KeyIdConflictError,
  DuplicateRevocationError
} from '../errors.js'
import { isJsonContentType } from '@interop/storage-core'
import { applyMigrations, writeClockHighWater } from './postgresSchema.js'
import {
  assertImportBodiesFit,
  restampImportedLog,
  restoredSpaceMetadata
} from '../lib/importTar.js'
import type { ImportPlan, ImportPlanCollection } from '../lib/importTar.js'
import { collectionPath } from '../lib/paths.js'
import {
  fileNameFor,
  parseResourceFileName,
  chunkDirName,
  spaceMetadataFileName,
  collectionMetadataFileName,
  COLLECTION_POLICY_FILE_NAME,
  resourcePolicyFileName,
  SPACE_POLICY_FILE_NAME,
  metaSidecarFileName,
  collectionLogFileName,
  ARCHIVE_REVOCATIONS_DIR
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'
import type { MetaSidecar } from '../lib/metaSidecar.js'
import { contentDigestOf, storedJsonBytes } from '../lib/contentDigest.js'
import {
  parseSidecarBytes,
  restampImportedSidecar
} from '../lib/metaSidecar.js'
import { HybridLogicalClock, stampOf, withoutStampMembers } from '../lib/hlc.js'
import { parseJsonOrUndefined } from '../lib/jsonBytes.js'
import {
  type ApplyResult,
  assertReceivableStamps,
  chunkSetQuotaRefusal,
  chunkSetRefusal,
  decideCollectionApply,
  decideCollectionTombstoneApply,
  decideLogApply,
  decideResourceApply,
  guardApply,
  heldCollection,
  logForkResult,
  mergeAppliedCollectionMetadata,
  stampWins
} from '../lib/replicaApply.js'
import { WEBVH_LOG_RESOURCE_ID } from '../lib/validateDid.js'
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
import { decodeCursor } from '../lib/cursor.js'
import { policyGrants } from '../policy.js'
import { revocationFileName } from '../lib/revocations.js'
import {
  collectionTombstoneBody,
  collectionTombstoneSummary
} from '../lib/collectionTombstone.js'
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
  mintValidator,
  newGeneration,
  resolveGeneration,
  resourceMetaEtagOf,
  stampedValidator,
  validatorOf,
  containerFeedDocument
} from '../lib/etag.js'
import {
  embedMetadataValidator,
  metadataEtagOf,
  stripMetadataValidator
} from '../lib/metadataValidator.js'
import { clampPageSize, resolvePageSize } from '../lib/pagination.js'
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
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_SPACES_PER_CONTROLLER,
  DEFAULT_MAX_COLLECTIONS_PER_SPACE,
  normalizeCountLimit,
  normalizeCapacityBytes
} from '../config.default.js'
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
  livePolicyUnderPrecondition,
  normalizePolicyWrite,
  policyFeedDocument,
  policyFile,
  priorPolicyParts,
  stampedPolicy,
  storedPolicy
} from '../lib/policyRecord.js'
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
  PolicyWriteResult,
  StoredPolicy,
  BackendDescriptor,
  BackendUsage,
  CollectionUsage,
  StorageBackend,
  StoredBackendRecord,
  ListedSpaceMetadata,
  MetadataValidatorParts,
  StoredSpaceMetadata,
  MetadataWriteResult,
  ResourceWriteMembers,
  ResourceMetadataWriteResult,
  ResourceWriteResult,
  StoredCollectionMetadata,
  CollectionLogResult,
  ImmutableUnder,
  StoredCollectionLog,
  CollectionMetadataInput,
  KeystoreConfig,
  KmsKeyRecord,
  RevocationRecord,
  RevocationScope,
  CapabilitySummary,
  IDID,
  ServiceDescription,
  ResourceMetaStamp,
  WriteStamp,
  FeedDocument,
  ReplicaRegistration,
  ReplicaLoopState,
  StoredReplica,
  ChunkStagingRun,
  StagedChunk
} from '../types.js'

/** Pool sizing and per-connection statement timeout (operational defaults). */
const POOL_MAX = 10
const STATEMENT_TIMEOUT_MS = 30_000
const CONNECTION_TIMEOUT_MS = 30_000

/**
 * Silent logger used when no logger is injected into the backend (`createApp`
 * wires `fastify.log` in; tests may leave it silent).
 */
const silentLogger: FastifyBaseLogger = pino({ level: 'silent' })

/**
 * Anything a query can run against: the pool (auto-checkout) or a checked-out
 * transaction client. Shared write helpers take this so the normal methods
 * and the import transaction reuse one statement.
 */
type Queryable = pg.Pool | pg.PoolClient

/**
 * The options of a Space Metadata write (`StorageBackend.writeSpace`), shared
 * with the in-transaction `#writeSpaceRow` so the two entry points cannot
 * drift.
 */
type SpaceMetadataWrite = {
  spaceId: string
  spaceMetadata: SpaceMetadata
  createdBy?: IDID
  ifMatch?: string
  ifNoneMatch?: HeldValidators
  assertTransition?: (prior?: StoredSpaceMetadata) => void | Promise<void>
}

/**
 * The SQLSTATE codes this backend maps to a `ProblemError`.
 */
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'

/**
 * The SQLSTATE code of an error pg raised, if it carries one.
 * @param err {unknown}
 * @returns {string | undefined}
 */
function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | undefined)?.code
}

/**
 * The refusal of a Collection create past `maxCollectionsPerSpace`.
 * @param limit {number}
 * @returns {CountQuotaExceededError}
 */
function collectionQuotaExceeded(limit: number): CountQuotaExceededError {
  return new CountQuotaExceededError({ scope: 'Collections per Space', limit })
}

/**
 * A record's write stamp as its three columns (see `lib/hlc.ts`).
 */
interface StampColumns {
  updated_at: string
  updated_at_counter: number
  origin_id: string
}

/**
 * One `resources` row, as read back from pg. `size_bytes` arrives as a string
 * (node-postgres returns `bigint` columns as strings). `updated_at`,
 * `updated_at_counter` and `origin_id` are the content record's write stamp;
 * the four `meta_*` columns are the `/meta` record's stamp and generation,
 * all NULL until the first metadata write.
 */
interface ResourceRow extends StampColumns {
  content_type: string
  content: Buffer | null
  is_json: boolean
  size_bytes: string
  generation: string
  meta_generation: string | null
  meta_updated_at: string | null
  meta_updated_at_counter: number | null
  meta_origin_id: string | null
  custom: ResourceMetadataCustom | Record<string, unknown> | null
  deleted: boolean
  created_at: string
  created_by: IDID | null
  epoch: string | null
  writer_id: string | null
  // The content digest of the stored representation (`lib/contentDigest.ts`);
  // a tombstone keeps the deleted content's. NULL on a tombstone written with
  // no bytes to digest (an import's, or a replica apply's over no prior row).
  digest: string | null
  // Postgres returns a `bigint` as a string.
  feed_position: string | null
}

/**
 * A Space or Collection row's Metadata columns: the stored body (stamp
 * members kept out of it), its generation and local validator segment, and
 * its write stamp. `metadata` is NULL only on a row no Metadata write made.
 */
interface MetadataRow<T> extends StampColumns {
  metadata: T | null
  meta_generation: string | null
  meta_local: number
}

/**
 * The column list `MetadataRow` is selected by.
 */
const METADATA_COLUMNS = `metadata, meta_generation, meta_local, updated_at,
       updated_at_counter, origin_id`

/**
 * A Collection row's governing history log columns, all NULL until the
 * guarded create.
 */
interface LogRow {
  log_body: string | null
  log_generation: string | null
  log_updated_at: string | null
  log_updated_at_counter: number | null
  log_origin_id: string | null
}

/**
 * The column list `LogRow` is selected by.
 */
const LOG_COLUMNS = `log_body, log_generation, log_updated_at,
       log_updated_at_counter, log_origin_id`

/**
 * The write stamp a row's three stamp columns hold.
 * @param row {StampColumns}
 * @returns {WriteStamp}
 */
function stampOfRow(row: StampColumns): WriteStamp {
  return {
    updatedAt: row.updated_at,
    updatedAtCounter: row.updated_at_counter,
    originId: row.origin_id
  }
}

/**
 * The columns a `policies` read selects: the body, the tombstone mark, and
 * the generation and stamp columns.
 */
const POLICY_COLUMNS =
  'policy, deleted, generation, updated_at, updated_at_counter, origin_id'

/**
 * A `policies` row as `POLICY_COLUMNS` selects it. `policy` is `NULL` on a
 * tombstone.
 */
type PolicyRow = StampColumns & {
  policy: PolicyDocument | null
  deleted: boolean
  generation: string
}

/**
 * The stored policy record of a `policies` row: a live policy served with
 * its stamp members, or a tombstone. `undefined` for no row.
 * @param row {PolicyRow | undefined}
 * @returns {StoredPolicy | undefined}
 */
function storedPolicyFromRow(
  row: PolicyRow | undefined
): StoredPolicy | undefined {
  if (row === undefined) {
    return undefined
  }
  const stamp = stampOfRow(row)
  return storedPolicy({
    generation: row.generation,
    stamp,
    ...(!row.deleted && {
      policy: stampedPolicy({ body: row.policy!, stamp })
    })
  })
}

/**
 * The `ETag` of a row carrying a `generation` column beside its three stamp
 * columns, or `undefined` when it has no validator.
 * @param row {StampColumns & { generation: string }}
 * @returns {string | undefined}
 */
function etagOfRow(
  row: StampColumns & { generation: string }
): string | undefined {
  return etagOf({ generation: row.generation, ...stampOfRow(row) })
}

/**
 * The stamp parameters of a write: the three column values in column order.
 * @param stamp {WriteStamp}
 * @returns {[string, number, string]}
 */
function stampValues(stamp: WriteStamp): [string, number, string] {
  return [stamp.updatedAt, stamp.updatedAtCounter, stamp.originId]
}

/**
 * The `/meta` record a `resources` row carries, or `undefined` before the
 * first metadata write (and after a soft delete dropped it).
 * @param row {object}
 * @param row.meta_generation {string | null}
 * @param row.meta_updated_at {string | null}
 * @param row.meta_updated_at_counter {number | null}
 * @param row.meta_origin_id {string | null}
 * @returns {ResourceMetaStamp | undefined}
 */
function metaStampOfRow(
  row: Pick<
    ResourceRow,
    | 'meta_generation'
    | 'meta_updated_at'
    | 'meta_updated_at_counter'
    | 'meta_origin_id'
  >
): ResourceMetaStamp | undefined {
  if (
    row.meta_generation === null ||
    row.meta_updated_at === null ||
    row.meta_updated_at_counter === null ||
    row.meta_origin_id === null
  ) {
    return undefined
  }
  return {
    updatedAt: row.meta_updated_at,
    updatedAtCounter: row.meta_updated_at_counter,
    originId: row.meta_origin_id,
    generation: row.meta_generation
  }
}

/**
 * The `resources` columns a Resource write answers from: the server-managed
 * members of the Resource Metadata object, as the writing statement returns
 * them or the write reads them under its row lock.
 */
const WRITTEN_MEMBER_COLUMNS = `content_type, size_bytes, created_at,
  created_by, updated_at, updated_at_counter, origin_id, meta_generation,
  meta_updated_at, meta_updated_at_counter, meta_origin_id`

/**
 * A `resources` row narrowed to `WRITTEN_MEMBER_COLUMNS`.
 */
type WrittenMemberRow = StampColumns &
  Pick<
    ResourceRow,
    | 'content_type'
    | 'size_bytes'
    | 'created_at'
    | 'created_by'
    | 'meta_generation'
    | 'meta_updated_at'
    | 'meta_updated_at_counter'
    | 'meta_origin_id'
  >

/**
 * The server-managed members of a Resource Metadata object from a row a
 * write returned or read under its lock.
 * @param row {WrittenMemberRow}
 * @returns {ResourceWriteMembers}
 */
function writtenMembersOfRow(row: WrittenMemberRow): ResourceWriteMembers {
  const meta = metaStampOfRow(row)
  return {
    contentType: row.content_type,
    size: Number(row.size_bytes),
    createdAt: row.created_at,
    ...stampOfRow(row),
    ...(meta !== undefined && { meta }),
    // Absent when the creating write had no invoker.
    ...(row.created_by !== null && { createdBy: row.created_by })
  }
}

/**
 * Buffers a byte stream fully into memory, aborting with
 * `PayloadTooLargeError` (413) the moment the cumulative size exceeds
 * `maxUploadBytes` -- the buffered-`bytea` analogue of the filesystem
 * backend's streaming `#byteLimitGuard`.
 * @param options {object}
 * @param options.stream {Readable}
 * @param options.maxUploadBytes {number}
 * @param options.backendId {string}   for the 413 problem detail
 * @returns {Promise<Buffer>}
 */
async function bufferStreamCapped({
  stream,
  maxUploadBytes,
  backendId
}: {
  stream: Readable
  maxUploadBytes: number
  backendId: string
}): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxUploadBytes) {
      throw new PayloadTooLargeError({ maxUploadBytes, backendId })
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * The stored form of a Space or Collection Metadata row: the jsonb body with
 * the row's stamp columns merged back in as the wire members `updatedAt`,
 * `updatedAtCounter` and `originId`, and its generation and local segment
 * re-surfaced as the out-of-band `metaGeneration` / `metaLocal` parts (the
 * same read shape the filesystem backend's Metadata file yields). Resolves
 * `undefined` for a missing row and for a row with no Metadata object, both
 * "no record written yet".
 * @param row {MetadataRow<T> | undefined}   the row, if any
 * @returns {(T & MetadataValidatorParts) | undefined}
 */
function storedMetadataFromRow<T extends object>(
  row: MetadataRow<T> | undefined
): (T & MetadataValidatorParts) | undefined {
  if (row?.metadata == null) {
    return undefined
  }
  return {
    ...row.metadata,
    ...stampOfRow(row),
    ...(row.meta_generation !== null && {
      metaGeneration: row.meta_generation
    }),
    metaLocal: row.meta_local
  }
}

/**
 * Reads a Collection row's governing history log out of its log columns, or
 * `undefined` when the row holds none (any log column is NULL) or does not
 * exist. A NULL generation reads as no log rather than minting one on read,
 * since every log write sets the generation with the body. Shared by every
 * statement that selects the columns, so the shape is decided once.
 * @param row {LogRow | undefined}
 * @returns {StoredCollectionLog | undefined}
 */
function storedLogFromRow(
  row: LogRow | undefined
): StoredCollectionLog | undefined {
  if (
    !row ||
    row.log_body === null ||
    row.log_generation === null ||
    row.log_updated_at === null ||
    row.log_updated_at_counter === null ||
    row.log_origin_id === null
  ) {
    return undefined
  }
  return {
    body: row.log_body,
    generation: row.log_generation,
    updatedAt: row.log_updated_at,
    updatedAtCounter: row.log_updated_at_counter,
    originId: row.log_origin_id
  }
}

/**
 * A Collection row's governing history log as the backend hands it over (the
 * body beside its validator), or `undefined` when the row holds none.
 * @param row {LogRow | undefined}
 * @returns {CollectionLogResult | undefined}
 */
function logResultFromRow(
  row: LogRow | undefined
): CollectionLogResult | undefined {
  const stored = storedLogFromRow(row)
  return stored && collectionLogResultOf(stored)
}

/**
 * A `replicas` row as `REPLICA_COLUMNS` selects it.
 */
type ReplicaRow = StampColumns & {
  record: ReplicaRegistration
  generation: string
  space_generation: string
  pulls_chunks: boolean
}

/**
 * The column list `ReplicaRow` is selected by. The loop state is read on its
 * own.
 */
const REPLICA_COLUMNS =
  'record, generation, space_generation, pulls_chunks, updated_at, ' +
  'updated_at_counter, origin_id'

/**
 * The stored registration a `replicas` row holds: the `record` jsonb, which
 * carries `pausedAt` but no stamp, under the stamp of the row's own columns.
 * @param row {ReplicaRow}
 * @returns {StoredReplica}
 */
function storedReplicaFromRow(row: ReplicaRow): StoredReplica {
  return {
    record: { ...row.record, ...stampOfRow(row) },
    generation: row.generation,
    spaceGeneration: row.space_generation,
    pullsChunks: row.pulls_chunks
  }
}

/**
 * The `resources` columns a content apply locks and decides on: the held
 * content stamp, the tombstone mark, the creating members a received record
 * may leave unset, and the bytes of a held history log, which is compared by
 * them (`content` is NULL for every other Resource).
 */
type AppliedResourcePrior = StampColumns &
  Pick<ResourceRow, 'deleted' | 'created_at' | 'created_by' | 'content'>

/**
 * A feed position as node-postgres hands a `bigint` column over (a string),
 * or `undefined` for NULL.
 * @param value {string | null | undefined}
 * @returns {number | undefined}
 */
function positionOf(value: string | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}

/**
 * The changes-feed document of one `resources` row with a feed position: a
 * live Resource or a tombstone, whatever its content type. The body is
 * parsed only for a live JSON Resource, the one kind whose `data` rides the
 * feed. A tombstone carries its last-known content type.
 * @param row {ResourceRow & { resource_id: string }}
 * @returns {FeedDocument}
 */
function resourceFeedDocument(
  row: ResourceRow & { resource_id: string }
): FeedDocument {
  // Selected only when non-null (see `changesSince`).
  const feedPosition = Number(row.feed_position)
  // The content validator rides beside the stamp, so the request layer can
  // format the wire `etag` without a fetch per Resource.
  const validator = validatorOf({
    generation: row.generation,
    ...stampOfRow(row)
  })
  const common = {
    kind: 'resource' as const,
    resourceId: row.resource_id,
    feedPosition,
    contentType: row.content_type,
    ...stampOfRow(row),
    ...(validator !== undefined && { validator }),
    // A tombstone keeps its creator, as it keeps its `created_at`. The
    // creator's DID rides the feed so provenance replicates with the
    // document, rather than needing a `/meta` fetch per Resource.
    ...(row.created_by !== null && { createdBy: row.created_by }),
    // The writer-attribution label (spec "Writer attribution") rides the feed
    // so a replica recognizes its own writes echoed back. A tombstone carries
    // the label its DELETE declared, if any.
    ...(row.writer_id !== null && { writerId: row.writer_id })
  }
  if (row.deleted) {
    // A soft delete dropped the `/meta` record, so a tombstone carries no
    // `meta`.
    return { ...common, deleted: true }
  }
  const data =
    row.is_json && row.content ? parseJsonOrUndefined(row.content) : undefined
  const meta = metaStampOfRow(row)
  // The `/meta` validator rides beside `meta`, so the request layer can
  // format the wire `metaEtag` without a fetch per Resource.
  const metaValidator = meta && validatorOf(meta)
  return {
    ...common,
    ...(meta !== undefined && { meta }),
    ...(metaValidator !== undefined && { metaValidator }),
    deleted: false,
    ...(data !== undefined && { data }),
    ...(row.custom !== null && { custom: row.custom }),
    // The client-declared key epoch (the `key-epochs` feature) rides the feed
    // so a replicating reader picks the right epoch key.
    ...(row.epoch !== null && { epoch: row.epoch })
  }
}

/**
 * Validates a Postgres schema name against the identifier charset this
 * backend accepts for `PostgresBackendOptions.schema`, throwing
 * `InvalidSchemaNameError` if it doesn't match. Exported so a caller that must act on the schema before
 * `PostgresBackend.open()` runs -- e.g. dropping it first -- validates
 * against the same rule rather than its own copy.
 * @param schema {string}
 * @returns {void}
 */
export function assertValidSchemaName(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new InvalidSchemaNameError({ schema })
  }
}

/**
 * The options `PostgresBackend.open()` takes (documented there).
 */
export interface PostgresBackendOptions {
  connectionString: string
  schema?: string
  logger?: FastifyBaseLogger
  capacityBytes?: number
  maxUploadBytes?: number
  maxSpacesPerController?: number
  maxCollectionsPerSpace?: number
  originId?: string
  physicalClock?: () => number
  clockBoundMs?: number
}

/**
 * The `WHERE` conditions that select the chunk staging rows in the scope the
 * ids give: the Space, and the Collection, Resource and registration when
 * named.
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @param [options.replicaId] {string}
 * @returns {{ values: unknown[], conditions: string[] }}
 */
function stagingScope({
  spaceId,
  collectionId,
  resourceId,
  replicaId
}: {
  spaceId: string
  collectionId?: string
  resourceId?: string
  replicaId?: string
}): { values: unknown[]; conditions: string[] } {
  const values: unknown[] = [spaceId]
  const conditions = ['space_id = $1']
  const scope: Array<[string, string | undefined]> = [
    ['collection_id', collectionId],
    ['resource_id', resourceId],
    ['replica_id', replicaId]
  ]
  for (const [column, value] of scope) {
    if (value !== undefined) {
      values.push(value)
      conditions.push(`${column} = $${values.length}`)
    }
  }
  return { values, conditions }
}

export class PostgresBackend implements StorageBackend {
  logger: FastifyBaseLogger
  /**
   * Per-Space storage capacity, in bytes (spec "Quotas"). `undefined` means no
   * configured limit. Unlike the filesystem backend's `du`-sampled soft limit,
   * this is enforced transactionally on every content write -- a HARD limit
   * under concurrency.
   */
  capacityBytes?: number
  /**
   * Largest single upload accepted, in bytes (spec "Quotas",
   * `maxUploadBytes`). Always set on this backend: an unconfigured cap
   * defaults to `DEFAULT_MAX_UPLOAD_BYTES`, because every blob write buffers
   * through memory on the single-`bytea` path.
   */
  maxUploadBytes: number
  /**
   * Max Spaces a single controller may create (spec "Quotas", a default-on
   * count quota). `undefined` means no cap. Enforced transactionally on the
   * Space create path (`writeSpace`), serialized per controller by an advisory
   * lock -- a HARD limit under concurrency, like the byte quota. The
   * constructor normalizes an unset option to
   * {@link DEFAULT_MAX_SPACES_PER_CONTROLLER} and a non-finite option
   * (`Infinity`) to `undefined`.
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (spec "Quotas", a default-on count
   * quota). `undefined` means no cap. Enforced on the Collection create path,
   * serialized per Space by the space row lock. Normalized like
   * {@link maxSpacesPerController}.
   */
  maxCollectionsPerSpace?: number

  #pool: pg.Pool
  /**
   * A one-connection pool of its own for the clock's high-water writes. The
   * clock persists a mark from inside a write's transaction, which already
   * holds a connection of `#pool` and the Space's row lock; drawing a second
   * connection from `#pool` there could wait forever on transactions queued
   * behind that very lock.
   */
  #clockPool: pg.Pool
  #schema?: string
  /**
   * The store's origin id, settled by `open()` from the store row. Assigned
   * before the factory returns, so no caller can read it unset.
   */
  #originId!: string
  /**
   * The store's hybrid logical clock, which mints the write stamp of every
   * versioned record inside the write's transaction, after the row lock (see
   * `lib/hlc.ts`). Built by `open()` once the origin id is settled, and
   * seeded from the high-water mark the store row carries. In memory: one
   * server process serves one store.
   */
  #clock!: HybridLogicalClock
  /**
   * The `PoolClient` of the transaction running on the current async context,
   * when one is. `#withTransaction` installs it for the span of its callback
   * and `#reader()` hands it to any read that runs inside -- so a read invoked
   * re-entrantly from within a transaction (a `StorageBackend` method called
   * back from an `assertTransition` callback, say) joins that transaction
   * instead of checking out a SECOND pooled connection. Without this a
   * transaction that awaits a nested read holds one connection while waiting
   * for another, and `POOL_MAX` such transactions exhaust the pool and wait on
   * each other forever. Joining the transaction is also the semantics such a
   * read wants: it sees the state the transaction has written so far.
   */
  #transactionClient = new AsyncLocalStorage<pg.PoolClient>()

  /**
   * Opens a Postgres backend: builds the connection pool, connects, and
   * applies the schema migrations (idempotent, advisory-locked; see
   * `postgresSchema.ts`), which also settle the store's origin id. The
   * constructor is protected, so this is the only way to obtain a backend,
   * and the backend it resolves already carries its origin id.
   * @param options {object}
   * @param options.connectionString {string}   a `postgres://` URL
   * @param [options.schema] {string}   Postgres schema to operate in (set as
   *   the connection `search_path`; created by `open()` if absent). Used for
   *   test isolation; production uses the default `public`.
   * @param [options.logger] {FastifyBaseLogger}
   * @param [options.capacityBytes] {number}   per-Space quota in bytes; a
   *   finite value is enforced, `undefined` or a non-finite value means no
   *   configured limit
   * @param [options.maxUploadBytes] {number}   per-upload cap in bytes;
   *   `undefined` applies the `DEFAULT_MAX_UPLOAD_BYTES` default. A non-finite
   *   value (`Infinity`, from `MAX_UPLOAD_BYTES=unlimited`) throws: this backend
   *   buffers each upload in memory as a single `bytea`, so an unbounded cap is
   *   not supported.
   * @param [options.maxSpacesPerController] {number}   max Spaces per
   *   controller (spec "Quotas"); `undefined` applies the default-on limit,
   *   `Infinity` means no cap
   * @param [options.maxCollectionsPerSpace] {number}   max Collections per
   *   Space; `undefined` applies the default-on limit, `Infinity` means no cap
   * @param [options.originId] {string}   the configured origin id
   *   (`WAS_ORIGIN_ID`); refused when it differs from the stored id, and
   *   written when the store carries none
   * @param [options.physicalClock] {() => number}   the physical clock the
   *   store's hybrid logical clock reads, epoch milliseconds; defaults to
   *   `Date.now` (a test freezes or steps it)
   * @param [options.clockBoundMs] {number}   the clock bound for a received
   *   stamp (`WAS_REPLICATION_CLOCK_BOUND_MS`); defaults to
   *   `REPLICATION_CLOCK_BOUND_MS`
   * @returns {Promise<PostgresBackend>}   an instance of the class `open()`
   *   was called on, so a subclass gets its own type back
   */
  static async open<T extends PostgresBackend>(
    this: { prototype: T },
    options: PostgresBackendOptions
  ): Promise<T> {
    // `this` is the class the call was made on. Its constructor is protected,
    // so the `this` parameter cannot be typed as a constructor.
    const backend = new (this as unknown as typeof PostgresBackend)(options)
    try {
      await backend.#open({
        configuredOriginId: options.originId,
        physicalClock: options.physicalClock,
        clockBoundMs: options.clockBoundMs
      })
    } catch (err) {
      // The open's own failure is the one to report. A pool that never
      // connected may also fail to end, and that error would replace it.
      await backend.close().catch(() => {})
      throw err
    }
    return backend as T
  }

  protected constructor({
    connectionString,
    schema,
    logger,
    capacityBytes,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace
  }: PostgresBackendOptions) {
    if (schema !== undefined) {
      assertValidSchemaName(schema)
    }
    this.#schema = schema
    this.logger = logger ?? silentLogger
    this.capacityBytes = normalizeCapacityBytes(capacityBytes)
    // This backend buffers each upload in memory as a single `bytea`, so an
    // unbounded per-upload cap is not supported -- fail fast at construction
    // rather than risk an OOM at write time.
    if (maxUploadBytes !== undefined && !Number.isFinite(maxUploadBytes)) {
      throw new Error(
        `PostgresBackend does not support an unlimited per-upload cap ` +
          `(MAX_UPLOAD_BYTES=unlimited): each upload is buffered in memory as ` +
          `a single bytea. Set MAX_UPLOAD_BYTES to a finite byte count.`
      )
    }
    this.maxUploadBytes = maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    // Count quotas normalize like `maxUploadBytes` (unset applies the
    // default-on limit, a non-finite `Infinity` means no cap), so every guard
    // keeps its plain `!== undefined` test.
    this.maxSpacesPerController = normalizeCountLimit(
      maxSpacesPerController,
      DEFAULT_MAX_SPACES_PER_CONTROLLER
    )
    this.maxCollectionsPerSpace = normalizeCountLimit(
      maxCollectionsPerSpace,
      DEFAULT_MAX_COLLECTIONS_PER_SPACE
    )
    const poolOptions = {
      connectionString,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      // Defence in depth behind `#transactionClient`: if a future read ever
      // does check out a second connection from inside a transaction, the
      // pool starves loudly (an error the request layer turns into a 500)
      // rather than hanging every request forever.
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      // `search_path` is a connection-startup parameter, so every pooled
      // connection lands in the right schema with no per-checkout SET race.
      // Quoted, so a mixed-case name resolves to the schema `open()` creates
      // (an unquoted identifier is folded to lowercase).
      ...(schema !== undefined && { options: `-csearch_path="${schema}"` })
    }
    this.#pool = new pg.Pool({ ...poolOptions, max: POOL_MAX })
    this.#clockPool = new pg.Pool({ ...poolOptions, max: 1 })
    for (const pool of [this.#pool, this.#clockPool]) {
      pool.on('error', err => {
        this.logger.error({ err }, 'Postgres pool background error')
      })
    }
  }

  /**
   * The work `open()` runs on a freshly constructed backend: connect, create
   * the schema when one is named, apply the migrations, reclaim every chunk
   * staging row (`#reclaimAllStaging`), and build the clock.
   * @param options {object}
   * @param [options.configuredOriginId] {string}   the configured origin id
   *   (`WAS_ORIGIN_ID`)
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
    const client = await this.#pool.connect()
    try {
      if (this.#schema !== undefined) {
        // Identifier-quoted; the constructor validated the name's charset.
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.#schema}"`)
      }
      // Lift the pool's statement timeout for this session: a waiting
      // instance blocks on the migration advisory lock for as long as the
      // holder's migration takes, and a future slow migration must not be
      // capped at the request-path timeout either.
      await client.query('SET statement_timeout = 0')
      const { originId, clockHighWater } = await applyMigrations({
        client,
        logger: this.logger,
        originId: configuredOriginId
      })
      this.#originId = originId
      await this.#reclaimAllStaging(client)
      // Seeded from the persisted mark, which can trail the last stamp minted
      // before a crash by up to a second; it persists a new mark as it advances.
      this.#clock = new HybridLogicalClock({
        originId,
        physicalClock,
        bound: clockBoundMs,
        highWater: clockHighWater,
        persistHighWater: ms =>
          writeClockHighWater({
            queryable: this.#clockPool,
            clockHighWater: ms
          }),
        getLogger: () => this.logger
      })
    } finally {
      // Destroy rather than pool-return the client, so the lifted timeout
      // never leaks into a request-path connection.
      client.release(true)
    }
  }

  /**
   * Removes every chunk staging row in the store, returning its bytes to
   * each Space's usage counter, in one statement. Run at `open()`, before
   * the backend serves anything: no pull loop owns staging at boot, and the
   * loop stages again what it still needs. A Postgres swap is one
   * transaction, so there is no torn run to finish. Logs a `warn` when
   * anything was removed.
   * @param client {pg.PoolClient}   the open's dedicated client
   * @returns {Promise<void>}
   */
  async #reclaimAllStaging(client: pg.PoolClient): Promise<void> {
    // A data-modifying CTE runs to completion whether or not the main query
    // reads it, so the usage update runs with the delete.
    const { rows } = await client.query<{ runs: number; bytes: string }>(
      `WITH removed AS (
         DELETE FROM chunk_staging
         RETURNING space_id, collection_id, resource_id, replica_id,
                   parent_etag, size
       ),
       freed AS (
         SELECT space_id, SUM(size) AS bytes FROM removed GROUP BY space_id
       ),
       returned AS (
         UPDATE spaces
            SET usage_bytes = GREATEST(spaces.usage_bytes - freed.bytes, 0)
           FROM freed
          WHERE spaces.space_id = freed.space_id
       )
       SELECT
         (SELECT COUNT(*)::int FROM (
            SELECT DISTINCT space_id, collection_id, resource_id, replica_id,
                            parent_etag
              FROM removed
          ) runs) AS runs,
         (SELECT COALESCE(SUM(size), 0) FROM removed) AS bytes`
    )
    const runs = rows[0]!.runs
    if (runs > 0) {
      this.logger.warn(
        { runs, bytes: Number(rows[0]!.bytes) },
        'Removed the chunk staging an earlier process left'
      )
    }
  }

  /**
   * The store's origin id (see `StorageBackend.originId`).
   * @returns {string}
   */
  get originId(): string {
    return this.#originId
  }

  /**
   * The store's hybrid logical clock (see `#clock`).
   * @returns {HybridLogicalClock}
   */
  get clock(): HybridLogicalClock {
    return this.#clock
  }

  /**
   * Persists the clock's high-water mark, so the clock seeded from it at the
   * next boot starts above every stamp this process minted, then drains the
   * connection pools. Wired to the Fastify `onClose` hook by the plugin
   * composition. A failed high-water write is logged at `warn` by the clock
   * and not thrown. A backend whose `open()` failed before its clock was
   * built has none to persist.
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await this.#clock?.persistCurrentMark()
    await Promise.all([this.#pool.end(), this.#clockPool.end()])
  }

  /**
   * The `Queryable` a read should run on: the current transaction's client
   * when this call is running inside `#withTransaction`, else the pool. Every
   * read in this backend goes through it -- see `#transactionClient` for why.
   * @returns {Queryable}
   */
  #reader(): Queryable {
    return this.#transactionClient.getStore() ?? this.#pool
  }

  /**
   * Runs `fn` inside one transaction on a dedicated client, committing on
   * success and rolling back on any throw.
   * @param fn {(client: pg.PoolClient) => Promise<T>}
   * @returns {Promise<T>}
   */
  async #withTransaction<T>(
    fn: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      // Run the body with this transaction's client installed as the ambient
      // reader (see `#transactionClient`), so a nested read joins the
      // transaction rather than checking out a second connection.
      const result = await this.#transactionClient.run(client, () => fn(client))
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        this.logger.error({ err: rollbackErr }, 'Postgres rollback failed')
      }
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Self-description advertised at `GET /space/:spaceId/backends`. Like the
   * filesystem backend it advertises no affordances: every guarantee a
   * Collection needs holds unconditionally, realized here by row-locked
   * preconditions with ETag validators and opaque per-chunk raw-bytes storage
   * in the `chunks` table.
   * @returns {Required<Omit<BackendDescriptor, 'provider' | 'connection'>>}
   */
  describe(): Required<Omit<BackendDescriptor, 'provider' | 'connection'>> {
    return serverBackendDescriptor({
      id: POSTGRES_BACKEND_ID,
      name: 'Server PostgreSQL'
    })
  }

  /**
   * Takes the Space's row lock (the first lock of the backend-wide order, see
   * `#lockSpaceRow`) and refuses the write unless the Space has a Metadata
   * object (`SpaceNotFoundError`, 404), and so does the Collection when a
   * `collectionId` is given (`CollectionNotFoundError`, 404). It never creates
   * a row. The request layer's own existence check ran before this
   * transaction, so a Delete Space or Delete Collection may have committed in
   * between. Creating a placeholder row here would then leave data under a
   * Space no route can reach, which the next Space created under the same id
   * would adopt. Holding the Space row until commit keeps either delete from
   * landing after the check.
   *
   * Resolves the Collection's `unique: true` plaintext index declarations,
   * read from the same row the liveness check reads, under the Space row
   * lock every Collection Metadata write takes too: a declaring write either
   * committed before this read, and binds the caller's write, or waits for
   * this transaction and scans its row. Empty when no `collectionId` is
   * given.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.requestName] {string}   names the refused operation in
   *   the 404
   * @returns {Promise<NormalizedIndexDeclaration[]>}
   */
  async #lockLiveContainers({
    client,
    spaceId,
    collectionId,
    requestName
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId?: string
    requestName?: string
  }): Promise<NormalizedIndexDeclaration[]> {
    const { rows: spaceRows } = await client.query<{ live: boolean }>(
      `SELECT metadata IS NOT NULL AS live FROM spaces
        WHERE space_id = $1 FOR UPDATE`,
      [spaceId]
    )
    if (!spaceRows[0]?.live) {
      throw new SpaceNotFoundError({ requestName })
    }
    if (collectionId === undefined) {
      return []
    }
    const uniqueIndexes = await this.#declaredUniqueIndexes({
      client,
      spaceId,
      collectionId
    })
    if (uniqueIndexes === undefined) {
      throw new CollectionNotFoundError({ requestName })
    }
    return uniqueIndexes
  }

  /**
   * Whether the write-once rule binds a write into the Collection. The
   * request layer's `immutable` was read before this transaction. When it is
   * `true`, a recheck callback decides from the governing history log read
   * here under the `collections` row lock, the lock a log write takes. A
   * log's guarded create then either committed before this read or waits for
   * this transaction to end. The row lock follows the Space row in the
   * backend-wide order (`#lockSpaceRow`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.immutable] {true | ImmutableUnder}
   * @returns {Promise<boolean>}
   */
  async #isWriteOnce({
    client,
    spaceId,
    collectionId,
    immutable
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    immutable?: true | ImmutableUnder
  }): Promise<boolean> {
    return resolveWriteOnce({
      immutable,
      readLog: async () => {
        const { rows } = await client.query<LogRow>(
          `SELECT ${LOG_COLUMNS}
             FROM collections
            WHERE space_id = $1 AND collection_id = $2
            FOR UPDATE`,
          [spaceId, collectionId]
        )
        return logResultFromRow(rows[0])
      }
    })
  }

  /**
   * Takes the per-Space advisory lock that Space Metadata writes, Delete Space
   * and the writes that advance the Space Metadata object's local segment
   * (backend and replica registrations) serialize on. A Space Metadata
   * precondition check and stamp, or a delete, are then atomic against each
   * other. It is disjoint from the `spaces` row lock the Collection and
   * Resource writes hold as the usage counter, and is taken ahead of that row
   * lock, as the lock order requires (`#lockSpaceRow`). Reentrant: a caller
   * that took it already holds it once more.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #lockSpaceMetadata({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('space-meta:' || $1))`,
      [spaceId]
    )
  }

  /**
   * Takes the Space's `spaces` row lock -- the ONE lock every mutating
   * transaction in this backend acquires first.
   *
   * Lock order, obeyed by every transaction that mutates stored bytes:
   * `spaces` row, then the `collections` row, then the `resources` / `chunks`
   * row. Every such transaction ends up holding the `spaces` row anyway,
   * because `#applyUsageDelta`'s `UPDATE spaces` locks it until commit; taking
   * it up front only widens that window by the transaction's own pre-read.
   * What it buys is the absence of an inversion: before this, a Collection
   * write locked `spaces` then `collections` while a Collection delete locked
   * `collections` then `spaces`, so a concurrent `PUT` and `DELETE` of one
   * non-empty Collection deadlocked, and Postgres aborted one with SQLSTATE
   * `40P01` -- not a `ProblemError`, so the request layer rendered a 500. The
   * same inversion stood between `importSpace` (which holds this row for its
   * whole apply loop) and the Resource and chunk write paths.
   *
   * The per-Space advisory locks are ordered against this the same way
   * throughout: `#lockSpaceMetadata` is taken BEFORE this row lock (the
   * Space Metadata paths take no other), and `#lockSameKeyCreate` /
   * `#lockCollectionUniqueness` are taken AFTER it.
   *
   * A Resource-level write takes its feed position (`#takeFeedPosition`,
   * which locks the `collections` row) after `#lockCollectionUniqueness` and
   * before it locks the `resources` row, the `collections` before `resources`
   * step of the order above. Every Resource-level write, `writeResourceMetadata`
   * included, takes this Space row first. A Collection Metadata write and a
   * governing history log write take their position on the `collections` row
   * they already hold locked, so they add no lock: the Metadata write holds
   * the Space row first, as above, and a log write locks only the
   * `collections` row, which keeps it ahead of the `resources` rows too.
   *
   * A write into an existing Space takes this same lock through
   * `#lockLiveContainers`, which also refuses a Space or Collection with no
   * Metadata object. This variant checks nothing, so a delete path that finds
   * the row gone locks nothing and its own statements report the absence.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #lockSpaceRow({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    await client.query('SELECT 1 FROM spaces WHERE space_id = $1 FOR UPDATE', [
      spaceId
    ])
  }

  /**
   * Refuses a Collection create that would push the Space past
   * `maxCollectionsPerSpace` (spec "Quotas"). A tombstone does not count.
   * Does nothing when no limit is configured.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   * @throws {CountQuotaExceededError}
   */
  async #assertCollectionQuota({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    if (this.maxCollectionsPerSpace === undefined) {
      return
    }
    const { rows } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM collections
        WHERE space_id = $1 AND NOT deleted`,
      [spaceId]
    )
    if (rows[0]!.count >= this.maxCollectionsPerSpace) {
      throw collectionQuotaExceeded(this.maxCollectionsPerSpace)
    }
  }

  /**
   * Applies a usage delta to the Space's transactional quota counter,
   * enforcing the configured capacity in the same statement (the hard-limit
   * departure from the filesystem's `du`-sampled soft check). Zero rows
   * updated with the row present means the write would not fit:
   * `QuotaExceededError` (507), rolling back the enclosing transaction.
   * MUST run inside the same transaction as the content mutation. A zero
   * delta writes nothing. `credit` lowers the usage the capacity is checked
   * against, not the usage written: a staged chunk counts in full, and the
   * check credits the live bytes the chunk pull's swap will free.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.delta {number}   signed byte delta (new minus old size)
   * @param [options.credit] {number}   bytes a later step of the same
   *   operation frees, subtracted for the capacity check only
   * @returns {Promise<void>}
   */
  async #applyUsageDelta({
    client,
    spaceId,
    delta,
    credit = 0
  }: {
    client: pg.PoolClient
    spaceId: string
    delta: number
    credit?: number
  }): Promise<void> {
    if (delta === 0) {
      return
    }
    // Only a growing write can exhaust the quota; shrinking writes and deletes
    // always apply (and clamp at zero so drift can never go negative).
    const cap = delta > 0 ? (this.capacityBytes ?? null) : null
    const result = await client.query(
      `UPDATE spaces
          SET usage_bytes = GREATEST(usage_bytes + $2, 0)
        WHERE space_id = $1
          AND ($3::bigint IS NULL OR usage_bytes + $2 - $4 <= $3::bigint)`,
      [spaceId, delta, cap, credit]
    )
    if (result.rowCount === 0) {
      throw new QuotaExceededError({
        spaceId,
        capacityBytes: this.capacityBytes!
      })
    }
  }

  /**
   * Serializes concurrent CREATORS of one not-yet-existing row (a Resource or
   * a chunk) on a transaction-scoped advisory lock keyed by the row's
   * identity. Under READ COMMITTED a `SELECT ... FOR UPDATE` on an absent row
   * locks nothing (no gap locks), so two concurrent creators would both read
   * "no prior row" and each evaluate its `If-None-Match: *` / `If-Match`
   * precondition against that phantom absence. The caller takes this lock when
   * its lock-nothing SELECT found no row, then RE-reads the row: the second
   * creator blocks here until the first commits, and its re-read sees the
   * committed row, so its precondition and its reported validator are computed
   * from accurate state. The usage delta does NOT depend on this lock -- it is
   * derived from the writing statement's own snapshot
   * (`#insertOrUpsertVersioned`), which is what keeps the counter exact
   * against a creator that never takes this lock at all. Held to commit
   * (advisory xact lock). The `create:`
   * prefix keeps this key domain distinct from the unique-blinded-term
   * advisory lock, which hashes the bare `(spaceId, collectionId)`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.rowKey {string}   the row's identity within the Space
   * @returns {Promise<void>}
   */
  async #lockSameKeyCreate({
    client,
    spaceId,
    rowKey
  }: {
    client: pg.PoolClient
    spaceId: string
    rowKey: string
  }): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [spaceId, `create:${rowKey}`]
    )
  }

  /**
   * Locks a create-or-update target row and returns its prior state (or
   * `undefined` when absent), running `lockingSelect` -- a `SELECT ... FOR
   * UPDATE` on the row -- once, and, when it finds no row, taking the same-key
   * create lock (`#lockSameKeyCreate`, whose doc comment states why the re-read
   * is required) and re-running it. Shared by the Resource (`writeResource`) and
   * chunk (`writeChunk`) write paths, which pass their own table-specific select
   * and row-identity key.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.rowKey {string}   the row's identity within the Space (the
   *   `#lockSameKeyCreate` key domain)
   * @param options.lockingSelect {() => Promise<T | undefined>}   runs the
   *   `SELECT ... FOR UPDATE` and resolves the prior row (or `undefined`)
   * @returns {Promise<T | undefined>}   the prior row, re-read under the create
   *   lock when the first select found none
   */
  async #lockRowForWrite<T>({
    client,
    spaceId,
    rowKey,
    lockingSelect
  }: {
    client: pg.PoolClient
    spaceId: string
    rowKey: string
    lockingSelect: () => Promise<T | undefined>
  }): Promise<T | undefined> {
    let prior = await lockingSelect()
    if (prior === undefined) {
      // The lock-nothing case -- see `#lockSameKeyCreate`.
      await this.#lockSameKeyCreate({ client, spaceId, rowKey })
      prior = await lockingSelect()
    }
    return prior
  }

  /**
   * The Collection's `unique: true` plaintext index declarations, read from
   * its live row inside the caller's transaction. Called after the Space row
   * lock, which every Collection Metadata write takes too, so the declaration
   * read here is the one in force for the rest of the transaction.
   * `#lockLiveContainers` reads through it for the writes that refuse an
   * absent Collection; a write that answers the absent case itself calls it
   * directly. A tombstoned Collection has no Metadata object.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<NormalizedIndexDeclaration[] | undefined>}   `undefined`
   *   when the Collection has no live Metadata object
   */
  async #declaredUniqueIndexes({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<NormalizedIndexDeclaration[] | undefined> {
    const { rows } = await client.query<{
      plaintext: CollectionMetadata['plaintext'] | null
    }>(
      `SELECT metadata->'plaintext' AS plaintext FROM collections
        WHERE space_id = $1 AND collection_id = $2
          AND metadata IS NOT NULL AND NOT deleted`,
      [spaceId, collectionId]
    )
    const [row] = rows
    if (row === undefined) {
      return undefined
    }
    return declaredUniqueIndexesOf({
      collectionMetadata: { plaintext: row.plaintext ?? undefined }
    })
  }

  /**
   * Serializes concurrent claimants of a per-Collection uniqueness invariant --
   * the EDV unique-blinded attributes and the plaintext `unique`-declared
   * equality indexes -- on a transaction-scoped advisory lock keyed by the
   * `(spaceId, collectionId)` pair. Held to commit, so a loser's conflict scan
   * sees the winner's committed row, and taken without entering the row-lock
   * ordering of plain writes. The bare `(spaceId, collectionId)` key domain is
   * deliberately distinct from the `create:`-prefixed same-key create lock
   * (`#lockSameKeyCreate`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async #lockCollectionUniqueness({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [spaceId, collectionId]
    )
  }

  /**
   * Takes the Collection's next changes-feed position: increments the
   * `collections.feed_position` counter and returns the new value. The
   * `UPDATE` locks the Collection row until commit, so a second writer's
   * increment waits for this transaction to commit or roll back. Positions
   * are therefore handed out in commit order, and a reader that sees a
   * position also sees every lower one (a plain sequence, whose `nextval` is
   * not commit-ordered, would let a write land behind a checkpoint already
   * served). A rolled-back write returns its position with it. Every
   * Resource-level write takes one here; a chunk write does not. A Collection
   * Metadata write (`#upsertCollection`) and a governing history log write
   * take theirs in their own `collections` statement, which increments the
   * same counter under the same row lock. The first
   * position taken in a Collection mints `collections.feed_generation` with
   * it, and every later one keeps it; the column goes with the row, so a
   * Collection re-created under the same id starts under a fresh generation
   * (see `changesSince`). See `#lockSpaceRow` for where this sits in the
   * lock order.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<number | undefined>}   the position, or `undefined`
   *   when the Collection row is gone or tombstoned
   */
  async #takeFeedPosition({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<number | undefined> {
    const { rows } = await client.query<{ feed_position: string }>(
      `UPDATE collections
          SET feed_position = feed_position + 1,
              feed_generation = COALESCE(feed_generation, $3)
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted
        RETURNING feed_position`,
      [spaceId, collectionId, newGeneration()]
    )
    return rows[0] ? Number(rows[0].feed_position) : undefined
  }

  /**
   * Buffers a write's body fully into memory as one `Buffer`, applying the
   * per-upload cap (413 `PayloadTooLargeError`): a JSON body is serialized and
   * size-checked; a binary body pre-flights its declared size, then buffers
   * through the counting guard that hard-caps a body whose size is omitted or
   * understated. Buffering happens BEFORE the write transaction so a slow upload
   * holds no row lock, and the content digest the row records (over the bytes
   * as stored, a JSON body re-serialized) is taken here with it, so no write
   * path stores bytes without their digest. Shared by every Resource and chunk
   * write and apply.
   * @param input {ResourceInput}
   * @returns {Promise<{ bytes: Buffer, digest: string }>}
   */
  async #bufferInputCapped(
    input: ResourceInput
  ): Promise<{ bytes: Buffer; digest: string }> {
    let bytes: Buffer
    if (input.kind === 'json') {
      bytes = storedJsonBytes(input.data)
      this.#assertUploadSize(bytes.length)
    } else {
      if (input.declaredBytes !== undefined) {
        this.#assertUploadSize(input.declaredBytes)
      }
      bytes = await bufferStreamCapped({
        stream: input.stream,
        maxUploadBytes: this.maxUploadBytes,
        backendId: this.describe().id
      })
    }
    return { bytes, digest: await contentDigestOf(bytes) }
  }

  /**
   * Refuses a body over the per-upload cap (413 `PayloadTooLargeError`).
   * @param uploadBytes {number}   the body's size
   * @returns {void}
   */
  #assertUploadSize(uploadBytes: number): void {
    if (uploadBytes > this.maxUploadBytes) {
      throw new PayloadTooLargeError({
        maxUploadBytes: this.maxUploadBytes,
        backendId: this.describe().id,
        uploadBytes
      })
    }
  }

  // Quotas

  /**
   * Reports the Space's usage from the transactional counter (no measurement
   * pass, no cache). The per-Collection breakdown is computed on demand with
   * one aggregate query.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.includeCollections] {boolean}
   * @returns {Promise<BackendUsage>}
   */
  async reportUsage({
    spaceId,
    includeCollections = false
  }: {
    spaceId: string
    includeCollections?: boolean
  }): Promise<BackendUsage> {
    const measuredAt = new Date().toISOString()
    const totalQuery = this.#reader().query<{ usage_bytes: string }>(
      'SELECT usage_bytes FROM spaces WHERE space_id = $1',
      [spaceId]
    )
    // The Space total and the per-Collection breakdown are independent reads:
    // issue both on the pool at once rather than paying the two round trips
    // serially. Per-Collection usage sums Resource content bytes, chunk bytes
    // (the `chunked-streams` feature) and the chunk pull's staged bytes, so
    // the breakdown agrees with the Space total in the transactional counter.
    const [{ rows }, collectionRows] = await Promise.all([
      totalQuery,
      includeCollections
        ? this.#reader()
            .query<{ collection_id: string; usage: string }>(
              `SELECT collection_id, COALESCE(SUM(bytes), 0) AS usage FROM (
                 SELECT collection_id, size_bytes AS bytes FROM resources
                   WHERE space_id = $1
                 UNION ALL
                 SELECT collection_id, size AS bytes FROM chunks
                   WHERE space_id = $1
                 UNION ALL
                 SELECT collection_id, size AS bytes FROM chunk_staging
                   WHERE space_id = $1
               ) usage_rows
                GROUP BY collection_id
                ORDER BY collection_id`,
              [spaceId]
            )
            .then(result => result.rows)
        : undefined
    ])
    const usageBytes = rows[0] ? Number(rows[0].usage_bytes) : 0
    const usageByCollection: CollectionUsage[] | undefined =
      collectionRows?.map(row => ({
        id: row.collection_id,
        usageBytes: Number(row.usage)
      }))

    return {
      ...backendUsageFieldsFor({
        backend: this,
        usageBytes,
        spaceTotalBytes: usageBytes
      }),
      measuredAt,
      ...(includeCollections && { usageByCollection })
    }
  }

  /**
   * Reports a single Collection's usage (its `SUM(size_bytes)` slice, chunk
   * and staged chunk bytes included), with
   * `state` / `limit` derived from the Space total (the quota is a per-Space
   * limit).
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
    const measuredAt = new Date().toISOString()
    const { rows } = await this.#reader().query<{
      space_total: string
      collection_total: string
    }>(
      `SELECT
         (SELECT COALESCE(usage_bytes, 0) FROM spaces WHERE space_id = $1)
           AS space_total,
         (SELECT COALESCE(SUM(size_bytes), 0) FROM resources
           WHERE space_id = $1 AND collection_id = $2)
         + (SELECT COALESCE(SUM(size), 0) FROM chunks
           WHERE space_id = $1 AND collection_id = $2)
         + (SELECT COALESCE(SUM(size), 0) FROM chunk_staging
           WHERE space_id = $1 AND collection_id = $2) AS collection_total`,
      [spaceId, collectionId]
    )
    const spaceTotalBytes = Number(rows[0]?.space_total ?? 0)
    const usageBytes = Number(rows[0]?.collection_total ?? 0)
    return {
      ...backendUsageFieldsFor({ backend: this, usageBytes, spaceTotalBytes }),
      measuredAt
    }
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
   * @returns {Promise<MetadataWriteResult<SpaceMetadata>>}   the Space's
   *   new validator (its `generation` and the stamp this write mints, local
   *   segment 0), whether the write created the Space, and the stored object
   */
  async writeSpace(
    options: SpaceMetadataWrite
  ): Promise<MetadataWriteResult<SpaceMetadata>> {
    return this.#withTransaction(client =>
      this.#writeSpaceRow({ client, ...options })
    )
  }

  /**
   * The Space Metadata write inside a caller's transaction: `writeSpace`'s
   * whole body, so a transaction that already holds the Space (an import
   * restoring the archived object) makes the same write -- the same
   * precondition check, `createdBy` resolution, shared normalization and
   * stamp -- rather than an inline copy that could drift from it.
   * @param options {object}
   * @param options.client {pg.PoolClient}   the caller's transaction
   * @param options.spaceId {string}
   * @param options.spaceMetadata {SpaceMetadata}
   * @param [options.createdBy] {string}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @param [options.assertTransition] {Function}   run against the current
   *   row before the write; throwing aborts it
   * @param [options.prior] {StoredSpaceMetadata}   the current row as the
   *   caller already read it under `#lockSpaceMetadata`, so the write does
   *   not read it again; read here otherwise
   * @returns {Promise<MetadataWriteResult<SpaceMetadata>>}
   */
  async #writeSpaceRow({
    client,
    spaceId,
    spaceMetadata,
    createdBy,
    ifMatch,
    ifNoneMatch,
    assertTransition,
    prior: priorRead
  }: SpaceMetadataWrite & {
    client: pg.PoolClient
    prior?: StoredSpaceMetadata
  }): Promise<MetadataWriteResult<SpaceMetadata>> {
    const { controller } = spaceMetadata
    // Serialize concurrent Metadata writes (and Delete Space) for the same
    // Space id on an advisory lock: a `FOR UPDATE` on the row locks nothing
    // while the row does not exist yet, and two racing guarded creates must
    // not both observe "absent". The advisory lock is the whole
    // serialization; the row itself is read plainly below, so a Metadata
    // write does not block, and is not blocked by, the Collection and
    // Resource writes that lock the same row as the Space's usage counter.
    // Holding the lock across the quota COUNT below also serializes creates
    // for the same controller. Reentrant: a caller that took it already
    // (an import, ahead of its row lock) holds it once more.
    await this.#lockSpaceMetadata({ client, spaceId })
    if (this.maxSpacesPerController !== undefined) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('controller-count:' || $1))`,
        [controller]
      )
    }
    // Read the current row (if any) and its validator, so the precondition,
    // the create detection, `createdBy` resolution, and the stamp are all
    // atomic with the write. A missing row is "no Space yet": no generation
    // and no stamp, so the first write mints both.
    const prior =
      priorRead ?? (await this.#readSpaceRow({ queryable: client, spaceId }))

    // The shared write rules (lib/metadataWrite.ts) run the precondition,
    // the transition check, the count quota, and the stamp, the same the
    // filesystem backend applies. The count quota is enforced as a HARD
    // limit under the controller-scoped advisory lock taken above: COUNT
    // this controller's Spaces and reject at the limit.
    const { validator, stamped } = await stampSpaceWrite({
      spaceId,
      spaceMetadata,
      prior,
      createdBy,
      ifMatch,
      ifNoneMatch,
      assertTransition,
      maxSpacesPerController: this.maxSpacesPerController,
      countOwnedSpaces: async () => {
        const { rows: countRows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM spaces WHERE controller = $1',
          [controller]
        )
        return countRows[0]!.count
      },
      clock: this.#clock
    })
    const { generation, stamp } = validator
    // The upsert maintains the denormalized `controller` column on both
    // insert and update -- the controller can change on update, and the
    // Spaces count quota reads this column (spec "Quotas"). The generation,
    // the local segment, and the stamp live in their own columns and stay
    // out of the jsonb body.
    await client.query(
      `INSERT INTO spaces (space_id, metadata, controller, meta_generation,
                           meta_local, updated_at, updated_at_counter,
                           origin_id)
       VALUES ($1, $2::jsonb, $3, $4, 0, $5, $6, $7)
       ON CONFLICT (space_id) DO UPDATE SET
         metadata = EXCLUDED.metadata,
         controller = EXCLUDED.controller,
         meta_generation = EXCLUDED.meta_generation,
         meta_local = 0,
         updated_at = EXCLUDED.updated_at,
         updated_at_counter = EXCLUDED.updated_at_counter,
         origin_id = EXCLUDED.origin_id`,
      [
        spaceId,
        JSON.stringify(withoutStampMembers(stamped)),
        controller,
        generation,
        ...stampValues(stamp)
      ]
    )
    return { validator, created: prior === undefined, metadata: stamped }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<StoredSpaceMetadata|undefined>}   falsy when the Space
   *   does not exist; `metaGeneration` / `metaLocal` are the out-of-band
   *   `ETag` validator parts, and the stamp members ride in the body
   */
  async getSpaceMetadata({
    spaceId
  }: {
    spaceId: string
  }): Promise<StoredSpaceMetadata | undefined> {
    return this.#readSpaceRow({ queryable: this.#reader(), spaceId })
  }

  /**
   * The Space's stored Metadata object with its validator, or `undefined` for
   * no Space yet (a missing row or a NULL-metadata placeholder row alike).
   * The one read behind `getSpaceMetadata`, the Metadata write, and the
   * import's restore, so the three agree on what "no Space yet" is.
   * @param options {object}
   * @param options.queryable {Queryable}   the pool, or the caller's
   *   transaction client
   * @param options.spaceId {string}
   * @returns {Promise<StoredSpaceMetadata | undefined>}
   */
  async #readSpaceRow({
    queryable,
    spaceId
  }: {
    queryable: Queryable
    spaceId: string
  }): Promise<StoredSpaceMetadata | undefined> {
    const { rows } = await queryable.query<MetadataRow<ListedSpaceMetadata>>(
      `SELECT ${METADATA_COLUMNS} FROM spaces WHERE space_id = $1`,
      [spaceId]
    )
    return storedMetadataFromRow(rows[0])
  }

  /**
   * Deletes the Space row; collections, resources, policies, and backend
   * records go with it via `ON DELETE CASCADE` (keystores are a sibling tree
   * and are deliberately untouched). Idempotent.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async deleteSpace({ spaceId }: { spaceId: string }): Promise<void> {
    await this.#withTransaction(async client => {
      // The same advisory lock `writeSpace` serializes on, so the delete
      // cannot land between that write's prior read and its upsert: the
      // upsert would recreate the row carrying the deleted life's generation,
      // where a re-create must mint a fresh one.
      await this.#lockSpaceMetadata({ client, spaceId })
      await client.query('DELETE FROM spaces WHERE space_id = $1', [spaceId])
    })
  }

  /**
   * Every Space with a Metadata object, sorted by id (byte order via
   * `COLLATE "C"`), each in the plain wire shape: the body with its stamp
   * members, and no out-of-band validator parts (a listing carries no
   * per-item `ETag`).
   * @returns {Promise<ListedSpaceMetadata[]>}
   */
  async listSpaces(): Promise<ListedSpaceMetadata[]> {
    const { rows } = await this.#reader().query<
      MetadataRow<ListedSpaceMetadata>
    >(
      `SELECT ${METADATA_COLUMNS} FROM spaces
        WHERE metadata IS NOT NULL
        ORDER BY space_id`
    )
    return rows.map(row => stripMetadataValidator(storedMetadataFromRow(row)!))
  }

  // Collections

  /**
   * Writes a Collection Metadata object (full replacement of the merged
   * object) in one row-locking transaction: the prior object is read under
   * the lock, the precondition and the request layer's transition checks run
   * against it, the create-path count quota is enforced, the server-managed
   * members are resolved, the write stamp is minted over the prior one, and
   * the local validator segment is reset.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.collectionMetadata {CollectionMetadataInput}   the object
   *   to persist, or the request layer's composition callback, run against
   *   the row just read under its lock, the history log columns included
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Collection's `createdBy` on first write only
   * @param [options.ifMatch] {string}   an `If-Match` compare-and-swap on the
   *   current `ETag`; a stale validator throws `PreconditionFailedError` (412)
   * @param [options.ifNoneMatch] {HeldValidators}   `If-None-Match: *`, the guarded
   *   create; an existing Collection throws `PreconditionFailedError` (412)
   * @returns {Promise<MetadataWriteResult<CollectionMetadata>>}   the
   *   Collection's new validator (its `generation` and the stamp this write
   *   mints, local segment 0), whether the write created the Collection (a
   *   create over a tombstone included), and the stored object
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
    return this.#withTransaction(async client => {
      // Serialize all Collection writes within the Space on its space row: the
      // collection-row `FOR UPDATE` below locks nothing when the row does not
      // exist yet, so without this two concurrent creates of *different* new
      // ids could each pass the create-path quota COUNT (overshooting
      // `maxCollectionsPerSpace`), and two creates of the *same* id could
      // both pass a guarded create. It is also the first lock of the
      // backend-wide order (`#lockSpaceRow`), and refuses a Space that has no
      // Metadata object. Every Resource write of the Space takes the same row
      // lock, so a composition that scans the Resources sees every write that
      // committed and none that is in flight, as on the filesystem backend's
      // Space gate.
      await this.#lockLiveContainers({ client, spaceId })
      // Lock the Collection row (if any) and read its current Metadata object
      // and validator, so the `If-Match` compare-and-swap, the transition
      // checks, the create detection, the server-managed member resolution,
      // and the stamp are all atomic with the write (two concurrent recipient
      // edits cannot clobber one another). The history log columns ride
      // along for the transition checks, so they cost no second round trip
      // while the row lock is held.
      const { rows } = await client.query<
        MetadataRow<CollectionMetadata> & LogRow & { deleted: boolean }
      >(
        `SELECT ${METADATA_COLUMNS}, ${LOG_COLUMNS}, deleted
           FROM collections
          WHERE space_id = $1 AND collection_id = $2 FOR UPDATE`,
        [spaceId, collectionId]
      )
      // A missing row is "no Collection yet": no generation and no stamp, so
      // the first write mints both. A tombstoned row is no Collection either
      // (its `metadata` is NULL), but its stamp is held: the create's stamp
      // must sort above the delete's.
      const prior = storedMetadataFromRow(rows[0])
      const tombstoneStamp = rows[0]?.deleted ? stampOfRow(rows[0]) : undefined
      // Guarded create (`If-None-Match: *`) or compare-and-swap (`If-Match`),
      // both opt-in: an existing Collection or a stale validator throws 412.
      // An unconditional write skips this.
      assertCollectionWritePrecondition({
        collectionId,
        exists: prior !== undefined,
        currentEtag: metadataEtagOf(prior),
        ifMatch,
        ifNoneMatch
      })
      // The request layer's composition and its state-transition checks
      // (e.g. epoch append-only), run here against the row just read under
      // the lock, its history log included.
      const collectionMetadata = await resolveCollectionMetadataInput({
        input,
        prior,
        readLog: async () => logResultFromRow(rows[0])
      })
      // Count quota (create path only): a create is no row or a tombstoned
      // row; writing one must not push the Space past
      // `maxCollectionsPerSpace` (spec "Quotas"). A tombstone does not count.
      if (prior === undefined) {
        await this.#assertCollectionQuota({ client, spaceId })
      }
      // The server-managed members are the backend's, never the body's;
      // both backends resolve them through the same shared rule
      // (lib/metadataWrite.ts), which discards the ones the wire input may
      // carry, validator-bearing and stamp members included. The stamp is
      // minted over the prior one. The object keeps its generation for the
      // Collection's whole life; a Collection deleted and re-created under
      // the same id mints a new one, so the two lives' validators can never
      // coincide.
      const validator = await mintValidator({
        clock: this.#clock,
        prior: prior
          ? { generation: prior.metaGeneration, ...stampOf(prior) }
          : tombstoneStamp,
        local: 0
      })
      const { generation, stamp } = validator
      const stamped = stampCollectionMetadata({
        collectionMetadata,
        prior,
        createdBy,
        stamp
      })
      await this.#upsertCollection({
        queryable: client,
        spaceId,
        collectionId,
        body: stamped,
        generation,
        stamp
      })
      return { validator, created: prior === undefined, metadata: stamped }
    })
  }

  /**
   * The one Collection Metadata upsert statement, shared by `writeCollection`
   * (which hands it the resolved object) and the import apply loop (which
   * hands it the archived object, re-stamped by this store's clock). The
   * caller has already resolved every server-managed member. The stamp goes
   * to its own columns, and the members of the body that carry it are left
   * out of the stored jsonb. The local validator segment is reset to 0, as
   * every stamped write resets it. Over a tombstoned row it is a create, and
   * clears the `deleted` mark.
   *
   * The write takes the Collection's next changes-feed position in the same
   * statement and records it as the Metadata object's own position. It cannot
   * go through `#takeFeedPosition`, since a create has no row to increment
   * yet. A create starts the counter at 1 under a fresh feed generation, a
   * create over a tombstone included. The statement locks the row to commit,
   * as `#takeFeedPosition`'s `UPDATE` does, so positions stay commit-ordered.
   * @param options {object}
   * @param options.queryable {Queryable}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {CollectionMetadata}   the wire body to store
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}   the write's stamp
   * @returns {Promise<void>}
   */
  async #upsertCollection({
    queryable,
    spaceId,
    collectionId,
    body,
    generation,
    stamp
  }: {
    queryable: Queryable
    spaceId: string
    collectionId: string
    body: CollectionMetadata
    generation: string
    stamp: WriteStamp
  }): Promise<void> {
    await queryable.query(
      `INSERT INTO collections (space_id, collection_id, metadata,
                                meta_generation, meta_local, updated_at,
                                updated_at_counter, origin_id, feed_position,
                                metadata_feed_position, feed_generation)
       VALUES ($1, $2, $3::jsonb, $4, 0, $5, $6, $7, 1, 1, $8)
       ON CONFLICT (space_id, collection_id) DO UPDATE SET
         -- Over a tombstone this is a create: the old life's feed counter
         -- and log columns do not carry into the new one, even if a write
         -- that raced the delete left them set. The write takes the next
         -- feed position, 1 on a create, and records it as the Metadata
         -- object's.
         feed_position          = CASE WHEN collections.deleted THEN 1
                                       ELSE collections.feed_position + 1 END,
         metadata_feed_position = CASE WHEN collections.deleted THEN 1
                                       ELSE collections.feed_position + 1 END,
         feed_generation        = CASE WHEN collections.deleted
                                       THEN EXCLUDED.feed_generation
                                       ELSE COALESCE(collections.feed_generation,
                                                     EXCLUDED.feed_generation)
                                  END,
         log_feed_position      = CASE WHEN collections.deleted THEN NULL
                                       ELSE collections.log_feed_position END,
         log_body               = CASE WHEN collections.deleted THEN NULL
                                       ELSE collections.log_body END,
         log_generation         = CASE WHEN collections.deleted THEN NULL
                                       ELSE collections.log_generation END,
         log_updated_at         = CASE WHEN collections.deleted THEN NULL
                                       ELSE collections.log_updated_at END,
         log_updated_at_counter = CASE WHEN collections.deleted THEN NULL
                                       ELSE collections.log_updated_at_counter END,
         log_origin_id          = CASE WHEN collections.deleted THEN NULL
                                       ELSE collections.log_origin_id END,
         metadata           = EXCLUDED.metadata,
         deleted            = false,
         meta_generation    = EXCLUDED.meta_generation,
         meta_local         = 0,
         updated_at         = EXCLUDED.updated_at,
         updated_at_counter = EXCLUDED.updated_at_counter,
         origin_id          = EXCLUDED.origin_id`,
      [
        spaceId,
        collectionId,
        JSON.stringify(withoutStampMembers(body)),
        generation,
        ...stampValues(stamp),
        newGeneration()
      ]
    )
  }

  /**
   * Reads a Collection Metadata object. Resolves `undefined` when the
   * Collection does not exist, a tombstoned one included.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<StoredCollectionMetadata | undefined>}
   *   `metaGeneration` / `metaLocal` are the out-of-band `ETag` validator
   *   parts; the stamp members ride in the body.
   */
  async getCollectionMetadata({
    spaceId,
    collectionId
  }: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionMetadata | undefined> {
    const { rows } = await this.#reader().query<
      MetadataRow<CollectionMetadata>
    >(
      `SELECT ${METADATA_COLUMNS}
         FROM collections
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted`,
      [spaceId, collectionId]
    )
    // Surface the generation and local segment out of band as
    // `metaGeneration` / `metaLocal` (the handler sets the `ETag` header from
    // them and the stamp); both are stored in their own columns and stay out
    // of the wire body.
    return storedMetadataFromRow(rows[0])
  }

  /**
   * Reads a Collection's governing history log (the `governed-history-logs`
   * feature): the JSON Lines body verbatim with its own validator. Resolves
   * `undefined` when the Collection has no log or does not exist.
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
    const { rows } = await this.#reader().query<LogRow>(
      `SELECT ${LOG_COLUMNS}
         FROM collections
        WHERE space_id = $1 AND collection_id = $2`,
      [spaceId, collectionId]
    )
    return logResultFromRow(rows[0])
  }

  /**
   * Replaces a Collection's governing history log (guarded create or
   * compare-and-swap append) in one row-locked transaction: the precondition
   * is evaluated on the log's current `ETag`, the request layer's
   * `assertTransition` runs against the row just read, the log's own stamp is
   * minted, and the Collection Metadata object's local validator segment is
   * advanced in the same statement, since the served object's `encryption`
   * member is derived from this log's head. The object's stamp is left
   * alone: the change is derived, not a write of the object. Resolves
   * `undefined` (no create) for an absent Collection.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {string}   the new JSON Lines body
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @param [options.assertTransition] {Function}
   * @returns {Promise<EtagValidator | undefined>}   the log's new validator
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
    return this.#withTransaction(async client => {
      const { rows } = await client.query<
        MetadataRow<CollectionMetadata> & LogRow
      >(
        `SELECT ${METADATA_COLUMNS}, ${LOG_COLUMNS}
           FROM collections
          WHERE space_id = $1 AND collection_id = $2
          FOR UPDATE`,
        [spaceId, collectionId]
      )
      const row = rows[0]
      const collectionMetadata = storedMetadataFromRow(row)
      if (row === undefined || collectionMetadata === undefined) {
        return undefined
      }
      const prior = storedLogFromRow(row)
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
      // The served Collection Metadata object changed with its derived
      // member, so its local validator segment advances; its generation and
      // stamp are kept. The log write takes the Collection's next feed
      // position, recorded as the log's own; the Metadata object keeps its
      // position, since its local segment is not a write of the object. The
      // row is already locked above, so this takes no new lock.
      await this.#storeLog({
        client,
        spaceId,
        collectionId,
        body,
        generation,
        stamp,
        advanceLocal: true
      })
      return validator
    })
  }

  /**
   * Stores a Collection's governing history log in its `log_*` columns. The
   * write takes the Collection's next changes-feed position and records it as
   * the log's own, minting the feed generation when the Collection has none
   * yet. The right-hand sides read the row as it was before the statement, so
   * both positions are the same new value. With `advanceLocal`, the Collection
   * Metadata object's local validator segment advances in the same statement.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {string}   the JSON Lines body
   * @param options.generation {string}   the log's generation
   * @param options.stamp {WriteStamp}   the log's write stamp
   * @param options.advanceLocal {boolean}   whether `meta_local` advances
   * @returns {Promise<void>}
   */
  async #storeLog({
    client,
    spaceId,
    collectionId,
    body,
    generation,
    stamp,
    advanceLocal
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    body: string
    generation: string
    stamp: WriteStamp
    advanceLocal: boolean
  }): Promise<void> {
    await client.query(
      `UPDATE collections SET
         log_body               = $3,
         log_generation         = $4,
         log_updated_at         = $5,
         log_updated_at_counter = $6,
         log_origin_id          = $7,
         ${advanceLocal ? 'meta_local             = meta_local + 1,' : ''}
         feed_position          = feed_position + 1,
         log_feed_position      = feed_position + 1,
         feed_generation        = COALESCE(feed_generation, $8)
       WHERE space_id = $1 AND collection_id = $2`,
      [
        spaceId,
        collectionId,
        body,
        generation,
        ...stampValues(stamp),
        newGeneration()
      ]
    )
  }

  /**
   * Deletes a Collection, leaving a tombstone, in one transaction: the
   * Collection's chunks and Resources are removed (each by a `DELETE ...
   * RETURNING` that totals the bytes it frees), then its policies, and the
   * `collections` row is kept and marked `deleted`. The tombstoned row keeps
   * its generation, takes a stamp minted over the live one, and drops the
   * Metadata object, the governing history log, and the changes-feed counter.
   * The freed bytes are subtracted from the Space usage counter. Over a
   * tombstone nothing is written. A row with no Metadata object is removed
   * with its member rows and reported `absent`, like no row at all.
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
    return this.#withTransaction(async client => {
      // Lock order (see `#applyUsageDelta`): the Space's counter row first,
      // then the Collection's rows.
      await this.#lockSpaceRow({ client, spaceId })
      const { rows: collectionRows } = await client.query<
        MetadataRow<CollectionMetadata> & { deleted: boolean }
      >(
        `SELECT ${METADATA_COLUMNS}, deleted
           FROM collections
          WHERE space_id = $1 AND collection_id = $2
          FOR UPDATE`,
        [spaceId, collectionId]
      )
      const row = collectionRows[0]
      if (row === undefined) {
        return 'absent'
      }
      if (row.deleted) {
        return 'already-deleted'
      }
      const prior = storedMetadataFromRow(row)
      await this.#removeCollectionMembers({ client, spaceId, collectionId })
      if (prior === undefined) {
        // A row with no Metadata object is no Collection: it goes with its
        // member rows, and no tombstone is left.
        await client.query(
          `DELETE FROM collections WHERE space_id = $1 AND collection_id = $2`,
          [spaceId, collectionId]
        )
        return 'absent'
      }
      // The tombstone keeps the generation and takes a stamp above the live
      // record's. Nothing else of the old life stays on the row.
      const { generation, stamp } = await mintValidator({
        clock: this.#clock,
        prior: { generation: prior.metaGeneration, ...stampOf(prior) }
      })
      await this.#tombstoneCollectionRow({
        client,
        spaceId,
        collectionId,
        generation,
        stamp
      })
      return 'deleted'
    })
  }

  /**
   * Removes the chunk rows (the `chunked-streams` feature) of one Resource, or
   * of a whole Collection when no `resourceId` is given, inside the caller's
   * transaction. `DELETE ... RETURNING size` removes and totals in one query
   * (the freed bytes summed in JS), so the total is exactly the rows removed.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<number>}   the freed chunk bytes
   */
  async #deleteChunks({
    client,
    spaceId,
    collectionId,
    resourceId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId?: string
  }): Promise<number> {
    const { rows } = await client.query<{ size: string }>(
      resourceId === undefined
        ? `DELETE FROM chunks WHERE space_id = $1 AND collection_id = $2
            RETURNING size`
        : `DELETE FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            RETURNING size`,
      resourceId === undefined
        ? [spaceId, collectionId]
        : [spaceId, collectionId, resourceId]
    )
    return rows.reduce((total, row) => total + Number(row.size), 0)
  }

  /**
   * Removes a Collection's member rows inside the caller's transaction: its
   * chunk staging, chunks and Resources, then its policies. The freed bytes
   * are subtracted
   * from the Space usage counter. The `collections` row is left to the
   * caller. Shared by Delete Collection and by the apply path, which deletes
   * a Collection on a received tombstone and before it replaces one life of
   * a Collection id with another.
   * @param options {object}
   * @param options.client {pg.PoolClient}   the caller's transaction, which
   *   holds the Space row and the Collection row
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @returns {Promise<void>}
   */
  async #removeCollectionMembers({
    client,
    spaceId,
    collectionId
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
  }): Promise<void> {
    // The Collection's freed bytes are its Resource content plus its chunk
    // bytes (the `chunked-streams` feature). Both are removed HERE, by
    // `DELETE ... RETURNING` statements that total exactly the rows they
    // remove, rather than letting the Collection row's cascade remove them
    // behind a prior `SUM`: a `SUM` taken before the delete misses anything
    // committed in between, which the cascade would then remove without
    // ever returning its bytes to the counter -- inflating `usage_bytes`
    // permanently, with no recompute path. `chunks` cascades from
    // `resources`, so the chunks go first or their rows would be gone
    // (and unmeasured) by the time we asked.
    const freedChunkBytes = await this.#deleteChunks({
      client,
      spaceId,
      collectionId
    })
    // Chunk staging hangs off the `collections` row, which a Delete
    // Collection keeps as a tombstone, so it is removed here too.
    const staging = await this.#deleteStaging({
      client,
      spaceId,
      collectionId
    })
    const { rows: deletedResourceRows } = await client.query<{
      size_bytes: string
    }>(
      `DELETE FROM resources WHERE space_id = $1 AND collection_id = $2
        RETURNING size_bytes`,
      [spaceId, collectionId]
    )
    const freedBytes =
      freedChunkBytes +
      staging.freedBytes +
      deletedResourceRows.reduce(
        (total, row) => total + Number(row.size_bytes),
        0
      )
    // Collection- and Resource-level policies live under the Collection (the
    // filesystem removes them with the dir; here they key off collection_id).
    await client.query(
      `DELETE FROM policies WHERE space_id = $1 AND collection_id = $2`,
      [spaceId, collectionId]
    )
    await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
  }

  /**
   * Leaves a Collection tombstone on the `collections` row: the `deleted`
   * mark, `generation` and `stamp`, with the Metadata object, the governing
   * history log and the changes-feed counter dropped. Inserts the row when
   * the Collection id has none, which only the apply path needs, for a
   * tombstone received before the Collection ever existed here. The caller
   * removes the member rows first (`#removeCollectionMembers`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.generation {string}   the generation the tombstone keeps
   * @param options.stamp {WriteStamp}   the delete's stamp
   * @returns {Promise<void>}
   */
  async #tombstoneCollectionRow({
    client,
    spaceId,
    collectionId,
    generation,
    stamp
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    generation: string
    stamp: WriteStamp
  }): Promise<void> {
    await client.query(
      `INSERT INTO collections (space_id, collection_id, metadata, deleted,
                                meta_generation, meta_local, updated_at,
                                updated_at_counter, origin_id)
       VALUES ($1, $2, NULL, true, $3, 0, $4, $5, $6)
       ON CONFLICT (space_id, collection_id) DO UPDATE SET
         deleted                = true,
         metadata               = NULL,
         meta_generation        = EXCLUDED.meta_generation,
         meta_local             = 0,
         updated_at             = EXCLUDED.updated_at,
         updated_at_counter     = EXCLUDED.updated_at_counter,
         origin_id              = EXCLUDED.origin_id,
         log_body               = NULL,
         log_generation         = NULL,
         log_updated_at         = NULL,
         log_updated_at_counter = NULL,
         log_origin_id          = NULL,
         feed_position          = 0,
         feed_generation        = NULL,
         metadata_feed_position = NULL,
         log_feed_position      = NULL`,
      [spaceId, collectionId, generation, ...stampValues(stamp)]
    )
  }

  /**
   * Lists a Space's Collections, OPTIONALLY cursor-paginated (spec
   * "Pagination"), with the same keyset (ascending `collection_id`, byte order
   * via the column's `COLLATE "C"`), cursor codec, clamps, and `next`
   * construction as `listCollectionItems`. `totalItems` is the full Collection
   * count (a `COUNT`). A row without a Metadata object falls back to the id
   * for its `name`, like a directory without a Metadata file on the
   * filesystem; no write path creates one any more. Each summary's `url`
   * is the canonical container form, with the trailing slash, as is the
   * listing's own. Each summary's `public` flag is the
   * Collection's `PublicCanRead` policy state, resolved for the page in a
   * single batch query over the page's ids (not a per-row lookup). A
   * tombstoned row is listed, and counted, only under `includeDeleted`, as
   * its id, URL, `deleted: true` and the stamp of the delete.
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
    const after = cursor !== undefined ? decodeCursor(cursor).after : undefined
    const pageSize = resolvePageSize(limit)

    // The total count and the page itself are independent reads: issue both on
    // the pool at once rather than paying the two round trips serially.
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.#reader().query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM collections
          WHERE space_id = $1 AND ($2 OR NOT deleted)`,
        [spaceId, includeDeleted]
      ),
      // Take `pageSize + 1` from the seek point to detect a further page without
      // a second query; `hasMore` is whether the extra row arrived. The
      // `collection_id > $2` seek relies on the column's byte collation, the same
      // ordering the cursor codec's code-unit comparison assumes.
      this.#reader().query<
        StampColumns & {
          collection_id: string
          metadata: CollectionMetadata | null
          deleted: boolean
        }
      >(
        `SELECT collection_id, metadata, deleted, updated_at,
                updated_at_counter, origin_id
           FROM collections
          WHERE space_id = $1
            AND ($2::text IS NULL OR collection_id > $2)
            AND ($4 OR NOT deleted)
          ORDER BY collection_id
          LIMIT $3`,
        [spaceId, after ?? null, pageSize + 1, includeDeleted]
      )
    ])
    const totalItems = Number(countRows[0]?.total ?? 0)
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows

    // Probe the page's collection-level policies inline so a client need not
    // issue one policy request per listed Collection (an N+1). A single batch
    // query over the page's ids keeps this off the per-row path. A
    // collection-level policy is keyed by `resource_id = ''` (the sentinel
    // convention in `#policyKey`); `public` is true iff a `PublicCanRead` policy
    // is attached (via the shared `policyGrants` recognizer, which fail-closes
    // any other/unrecognized policy type to false).
    const pageIds = pageRows
      .filter(row => !row.deleted)
      .map(row => row.collection_id)
    const publicCollectionIds = new Set<string>()
    if (pageIds.length > 0) {
      const { rows: policyRows } = await this.#reader().query<{
        collection_id: string
        policy: PolicyDocument
      }>(
        `SELECT collection_id, policy FROM policies
          WHERE space_id = $1 AND collection_id = ANY($2) AND resource_id = ''
            AND NOT deleted`,
        [spaceId, pageIds]
      )
      for (const policyRow of policyRows) {
        if (
          policyGrants({
            policy: policyRow.policy,
            action: 'read',
            logger: this.logger
          })
        ) {
          publicCollectionIds.add(policyRow.collection_id)
        }
      }
    }

    const items = pageRows.map(row => {
      if (row.deleted) {
        return collectionTombstoneSummary({
          spaceId,
          collectionId: row.collection_id,
          stamp: stampOfRow(row)
        })
      }
      return {
        id: row.collection_id,
        url: collectionPath({ spaceId, collectionId: row.collection_id }),
        name: row.metadata?.name ?? row.collection_id,
        public: publicCollectionIds.has(row.collection_id)
      } satisfies CollectionSummary
    })

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
   * Lists a Collection's Resources, cursor-paginated with the same keyset
   * (ascending `resourceId`, byte order), cursor codec, clamps, and `next`
   * construction as the filesystem backend. Tombstones are invisible.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.limit] {number}
   * @param [options.cursor] {string}
   * @param [options.collectionMetadata] {CollectionMetadata}
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
    const collectionMetadata =
      providedMetadata ??
      (await this.getCollectionMetadata({ spaceId, collectionId }))

    const after = cursor !== undefined ? decodeCursor(cursor).after : undefined
    const pageSize = resolvePageSize(limit)

    // The total count and the page itself are independent reads: issue both on
    // the pool at once rather than paying the two round trips serially.
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.#reader().query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted`,
        [spaceId, collectionId]
      ),
      // Take `pageSize + 1` from the seek point to detect a further page without
      // a second query; `hasMore` is whether the extra row arrived.
      this.#reader().query<{
        resource_id: string
        content_type: string
        custom: ResourceMetadataCustom | null
        epoch: string | null
        writer_id: string | null
      }>(
        `SELECT resource_id, content_type, custom, epoch, writer_id FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted
          AND ($3::text IS NULL OR resource_id > $3)
        ORDER BY resource_id
        LIMIT $4`,
        [spaceId, collectionId, after ?? null, pageSize + 1]
      )
    ])
    const totalItems = Number(countRows[0]?.total ?? 0)
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows

    // The shared item builder projects each row onto the wire shape (including
    // the encrypted-Collection name suppression).
    const encrypted = suppressesItemNames({ collectionMetadata })
    const items = pageRows.map(row =>
      collectionListingItem({
        spaceId,
        collectionId,
        resourceId: row.resource_id,
        contentType: row.content_type,
        custom: row.custom ?? undefined,
        epoch: row.epoch ?? undefined,
        writerId: row.writer_id ?? undefined,
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
   * Writes a Resource representation as one transaction: row lock, shared
   * precondition evaluation (exact filesystem semantics -- a tombstone counts
   * as "not exists"; `ifMatch` is checked first, then `ifNoneMatch`, and both
   * must hold, per RFC 9110 section 13.2.2), a content stamp minted over the
   * row's prior one (a tombstone's included) under the row's preserved
   * `generation`, and the transactional quota delta. JSON is stored
   * as its serialized UTF-8 bytes; blobs buffer through the capped
   * accumulator.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.input {ResourceInput}
   * @param [options.createdBy] {string}   DID of the invoker, recorded as the
   *   Resource's `createdBy` by the write that creates it (over a tombstone
   *   included)
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<ResourceWriteResult>}   the Resource's new content
   *   validator, whether the write created it, and the members the writing
   *   statement returned
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
    // Buffered and digested before the transaction opens.
    const { bytes: content, digest } = await this.#bufferInputCapped(input)

    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`), before the
      // advisory and row locks below. Refuses a Space or Collection that has
      // no Metadata object.
      // The Collection's `unique` declarations ride along, read under the
      // Space row lock a declaring Metadata write also takes.
      const uniqueIndexes = await this.#lockLiveContainers({
        client,
        spaceId,
        collectionId,
        requestName: 'Write Resource'
      })

      // A write-once Collection: over a live Resource or a tombstone, only a
      // repeat of the stored media type and content digest passes, and it
      // writes nothing. It is decided first, before the unique-claim scans
      // and before the feed position is taken: a write this rule answers
      // stores nothing, so it claims nothing and takes no position. The Space
      // row lock held above serializes every write to the Space's rows, so
      // the row read here is the one the write would replace. A tombstone
      // keeps the deleted content's digest, so a write over it is held to
      // the same rule and a repeat leaves the Resource deleted; a tombstone
      // with no digest (written with no bytes to digest) holds nothing to
      // compare, so a write over it is an ordinary create.
      if (immutable !== undefined) {
        const { rows: storedRows } = await client.query<
          WrittenMemberRow & {
            generation: string
            deleted: boolean
            digest: string | null
          }
        >(
          `SELECT generation, deleted, digest, ${WRITTEN_MEMBER_COLUMNS}
             FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
          [spaceId, collectionId, resourceId]
        )
        const stored = storedRows[0]
        if (
          stored !== undefined &&
          stored.digest !== null &&
          (await this.#isWriteOnce({
            client,
            spaceId,
            collectionId,
            immutable
          }))
        ) {
          assertWritePrecondition({
            resourceId,
            exists: !stored.deleted,
            currentEtag: etagOfRow(stored),
            ifMatch,
            ifNoneMatch
          })
          if (
            !sameMediaType(stored.content_type, input.contentType) ||
            stored.digest !== digest
          ) {
            throw new ResourceImmutableError({ requestName: 'Write Resource' })
          }
          // A repeat writes nothing, so it answers the stored row as read
          // under the Space row lock.
          return {
            validator: stampedValidator({
              generation: stored.generation,
              stamp: stampOfRow(stored)
            }),
            created: false,
            members: writtenMembersOfRow(stored)
          }
        }
      }

      // Two unique-attribute invariants can force a JSON content write to
      // serialize before it upserts its row: the EDV blinded one (`unique: true`
      // blinded attributes; the `blinded-index-query` feature) and the plaintext
      // equality one (a Collection's `unique`-declared `plaintext.indexes`; the
      // `equality-query` feature). Only a unique-carrying JSON write can create
      // either claim. A per-Collection transaction-scoped advisory lock
      // serializes the claimants (held to commit, so the loser's scan sees the
      // winner's committed row) without entering the row-lock ordering of plain
      // writes; it is taken once and shared by both checks.
      const { blindedUnique, equalityUnique } = uniqueClaimsOf({
        input,
        uniqueIndexes
      })
      const jsonDocument = input.kind === 'json' ? input.data : undefined
      if (blindedUnique || equalityUnique) {
        await this.#lockCollectionUniqueness({ client, spaceId, collectionId })
      }
      if (blindedUnique) {
        assertNoUniqueBlindedConflict({
          document: jsonDocument,
          candidates: jsonCandidatesFrom(
            await this.#readEqualityCandidates(client, {
              spaceId,
              collectionId,
              excludeResourceId: resourceId
            })
          )
        })
      }
      if (equalityUnique) {
        // A content write does not change the Resource's `custom`, so the custom
        // side of the claim comes from the CURRENT stored row.
        const { rows: selfRows } = await client.query<{
          custom: ResourceMetadataCustom | Record<string, unknown> | null
        }>(
          `SELECT custom FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND NOT deleted`,
          [spaceId, collectionId, resourceId]
        )
        assertNoUniqueEqualityConflict({
          indexes: uniqueIndexes,
          content: jsonDocument,
          custom: selfRows[0]?.custom ?? undefined,
          candidates: await this.#readEqualityCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
        })
      }

      // The write's changes-feed position, taken before the row lock (see
      // `#lockSpaceRow`). `#lockLiveContainers` saw the Collection, and the
      // Space row it holds keeps a Collection delete out.
      const feedPosition = (await this.#takeFeedPosition({
        client,
        spaceId,
        collectionId
      }))!

      // Lock the row (re-reading under the create lock when it does not exist
      // yet, so `exists` below reflects a concurrent creator's committed
      // row). Narrow projection: the lock needs the row, not its (possibly
      // multi-MB) `content` bytea, which this path never reads.
      type PriorRow = StampColumns & Pick<ResourceRow, 'generation' | 'deleted'>
      const selectPrior = async (): Promise<PriorRow | undefined> => {
        const { rows } = await client.query<PriorRow>(
          `SELECT generation, updated_at, updated_at_counter, origin_id,
                  deleted
             FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            FOR UPDATE`,
          [spaceId, collectionId, resourceId]
        )
        return rows[0]
      }
      const prior = await this.#lockRowForWrite({
        client,
        spaceId,
        rowKey: `${collectionId}/${resourceId}`,
        lockingSelect: selectPrior
      })
      const exists = prior !== undefined && !prior.deleted
      assertWritePrecondition({
        resourceId,
        exists,
        // A tombstone has no live representation to validate, so it offers
        // no `ETag` for `If-Match` to match.
        currentEtag: exists ? etagOfRow(prior!) : undefined,
        ifMatch,
        ifNoneMatch
      })

      // The row keeps its generation for its whole life -- a soft delete keeps
      // it and this write continues it across a re-create. Only a row that
      // does not exist at all mints one, so a hard-deleted Resource's
      // successor can never present a validator the previous one already
      // handed out. The stamp is minted over the row's prior one (a
      // tombstone's included), under the row lock, so it sorts above it.
      const { generation, stamp } = await mintValidator({
        clock: this.#clock,
        prior: prior && { generation: prior.generation, ...stampOfRow(prior) }
      })
      // A content write preserves the independent `/meta` record (its
      // generation and stamp) and the user-writable `custom` of a LIVE
      // Resource; a tombstoned row already dropped them (the metadata went
      // with the deleted Resource).
      //
      // Create-if-absent atomicity: when `If-None-Match: *` found NO prior row
      // (a tombstone is a real row and stays lock-serialized), concurrent
      // creators through this method are already serialized by
      // `#lockSameKeyCreate` above -- but a writer that does not take that
      // lock (`importSpace`'s plain INSERTs) can still race. A plain INSERT
      // (no ON CONFLICT) keeps the primary key as the arbiter: the loser's
      // unique violation maps to the 412 the precondition would have thrown.
      // `createdBy` and `created_at` name the Resource's creator and creation
      // time, not its last writer: the INSERT takes them from this write, and
      // the conflict arm keeps a live row's own -- preserved-as-absent
      // included -- whoever invokes the update. A write over a tombstone is
      // a create, and the conflict arm takes this write's provenance there:
      // the tombstone's belongs to the deleted Resource.
      const values = [
        spaceId,
        collectionId,
        resourceId,
        input.contentType,
        content,
        isJsonContentType(input.contentType),
        content.length,
        generation,
        // This write's provenance, which the conflict arm keeps only over a
        // tombstone. The stamp is ALWAYS this write's, on both the insert
        // and the conflict arm.
        stamp.updatedAt,
        ...stampValues(stamp),
        createdBy ?? null,
        // The client-declared key epoch (the `key-epochs` feature): a content
        // write stores it and CLEARS it when absent (the new ciphertext's epoch
        // is unknown), so both the INSERT and the conflict update set it from
        // this write -- it is NOT preserved from the prior row like `created_by`.
        epoch ?? null,
        // The client-declared writer-attribution label (spec "Writer
        // attribution"): a content write stores it and CLEARS it when absent,
        // the same declare-or-clear terms as `epoch`.
        writerId ?? null,
        feedPosition,
        digest
      ]
      const insertSql = `
        INSERT INTO resources (
          space_id, collection_id, resource_id, content_type, content,
          is_json, size_bytes, generation, custom, deleted, created_at,
          updated_at, updated_at_counter, origin_id, created_by, epoch,
          writer_id, feed_position, digest
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, false, $9, $10, $11, $12, $13, $14, $15, $16, $17)`
      /**
       * The four `meta_*` columns and `custom` are deliberately NOT in the
       * conflict update: an overwrite keeps the `/meta` record as it stands
       * on the row (a tombstone already dropped it). `created_at` and
       * `created_by` come from `EXCLUDED` only over a tombstone, and are the
       * row's own over a live Resource, read on the statement itself. So a
       * concurrent creator's INSERT that landed between our lock-nothing
       * SELECT and this statement keeps its provenance, absent or not.
       * `generation` is preserved from the row for the same reason: the
       * conflict path always means a prior row (live or tombstoned) already
       * had one, and a generation is minted only where none exists. The
       * statement returns the members the write answers with, so they
       * describe the row this write left.
       */
      const written = await this.#insertOrUpsertVersioned<WrittenMemberRow>({
        client,
        insertSql,
        // The size this write replaces, read on the writing statement's own
        // snapshot. A tombstone already stores 0, so it contributes nothing.
        priorSizeSql: `SELECT size_bytes AS prior_size, deleted AS prior_deleted
             FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        conflictSql: `
           ON CONFLICT (space_id, collection_id, resource_id) DO UPDATE SET
             content_type = EXCLUDED.content_type,
             content = EXCLUDED.content,
             is_json = EXCLUDED.is_json,
             size_bytes = EXCLUDED.size_bytes,
             generation = resources.generation,
             deleted = false,
             updated_at = EXCLUDED.updated_at,
             updated_at_counter = EXCLUDED.updated_at_counter,
             origin_id = EXCLUDED.origin_id,
             created_at = CASE WHEN resources.deleted
                               THEN EXCLUDED.created_at
                               ELSE resources.created_at END,
             created_by = CASE WHEN resources.deleted
                               THEN EXCLUDED.created_by
                               ELSE resources.created_by END,
             epoch = EXCLUDED.epoch,
             writer_id = EXCLUDED.writer_id,
             feed_position = EXCLUDED.feed_position,
             digest = EXCLUDED.digest`,
        values,
        createOnly: ifNoneMatch === '*' && prior === undefined,
        generation,
        conflictDetail: `Resource '${resourceId}' already exists (If-None-Match: *).`,
        returning: WRITTEN_MEMBER_COLUMNS
      })
      // Usage delta AFTER the write, from the size the write actually
      // replaced: a `QuotaExceededError` here still rolls the whole
      // transaction back, so the row never outlives the refusal.
      const delta = content.length - written.priorSizeBytes
      await this.#applyUsageDelta({ client, spaceId, delta })
      return {
        validator: stampedValidator({ generation: written.generation, stamp }),
        created: written.created,
        members: writtenMembersOfRow(written.row)
      }
    })
  }

  /**
   * Lands a versioned row write on `client`, the shared tail of `writeResource`
   * and `writeChunk`. Under `createOnly` (an `If-None-Match: *` write whose
   * pre-read found NO prior row) it runs the bare INSERT, so the primary key
   * stays the arbiter against a creator that does not take the same-key lock
   * (`importSpace`'s plain INSERTs): the loser's unique violation (SQLSTATE
   * 23505) maps to the 412 the precondition would have thrown. Otherwise it
   * appends `conflictSql` and RETURNING to the INSERT as an upsert.
   *
   * The conflict update keeps the row's own `generation` rather than the
   * pre-read's: if a concurrent creator slipped in after our lock-nothing
   * SELECT, the write continues under that creator's generation. RETURNING
   * reports the generation that actually landed.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.insertSql {string}   the INSERT (no ON CONFLICT clause)
   * @param options.conflictSql {string}   the `ON CONFLICT ... DO UPDATE SET`
   *   clause appended on the upsert path; must preserve the row's
   *   `generation`
   * @param options.values {unknown[]}   the INSERT's bind values
   * @param options.createOnly {boolean}   run the bare INSERT (see above)
   * @param options.generation {string}   the pre-read-derived generation,
   *   reported when the bare INSERT lands
   * @param options.priorSizeSql {string}   a `SELECT <size column> AS
   *   prior_size, <deleted mark> AS prior_deleted FROM <table> WHERE
   *   <primary key>` over the row about to be written, using the same bind
   *   values; run as a CTE of the writing statement so `priorSizeBytes` is
   *   the size this statement REPLACES and `priorDeleted` whether that row
   *   was a tombstone
   * @param options.conflictDetail {string}   `detail` of the 412 a unique
   *   violation on the bare INSERT maps to
   * @param [options.returning] {string}   further columns the writing
   *   statement returns, handed back as `row`
   * @returns {Promise<{ generation: string, priorSizeBytes: number,
   *   created: boolean, row: Row }>}   the generation that landed, the
   *   stored size the write replaced (0 when there was no row) for the
   *   caller's usage delta, whether the write created the record (it
   *   inserted the row, or the row it replaced was a tombstone), and the
   *   `returning` columns
   */
  async #insertOrUpsertVersioned<Row extends object = object>({
    client,
    insertSql,
    conflictSql,
    values,
    createOnly,
    generation,
    priorSizeSql,
    conflictDetail,
    returning
  }: {
    client: pg.PoolClient
    insertSql: string
    conflictSql: string
    values: unknown[]
    createOnly: boolean
    generation: string
    priorSizeSql: string
    conflictDetail: string
    returning?: string
  }): Promise<{
    generation: string
    priorSizeBytes: number
    created: boolean
    row: Row
  }> {
    if (createOnly) {
      let rows: Row[]
      try {
        ;({ rows } = await client.query<Row>(
          returning === undefined
            ? insertSql
            : `${insertSql} RETURNING ${returning}`,
          values
        ))
      } catch (err) {
        if (pgErrorCode(err) === UNIQUE_VIOLATION) {
          throw new PreconditionFailedError({ detail: conflictDetail })
        }
        throw err
      }
      // The bare INSERT landed, so no row existed: nothing was replaced.
      return {
        generation,
        priorSizeBytes: 0,
        created: true,
        row: rows[0] ?? ({} as Row)
      }
    }
    // `prior` is a plain SELECT CTE of this same statement, so it is evaluated
    // on the statement's snapshot -- the state BEFORE the upsert, including
    // any row a concurrent writer committed after this transaction's own
    // pre-read. Deriving the usage delta from it (rather than from that
    // pre-read) is what keeps `usage_bytes` exact when a writer that does not
    // take the same-key create lock -- `importSpace`'s plain INSERTs -- landed
    // a row in between: the upsert replaces that row, and its bytes leave the
    // counter with it.
    // `xmax = 0` holds on a row this statement inserted, and not on one its
    // conflict arm updated. The write also created the record when the row it
    // replaced was a tombstone.
    const { rows: written } = await client.query<
      Row & { generation: string; prior_size: string; created: boolean }
    >(
      `WITH prior AS (${priorSizeSql})
       ${insertSql}${conflictSql}
           RETURNING generation,
             COALESCE((SELECT prior_size FROM prior), 0) AS prior_size,
             (xmax = 0 OR COALESCE((SELECT prior_deleted FROM prior), false))
               AS created${returning === undefined ? '' : `, ${returning}`}`,
      values
    )
    const row = written[0]!
    return {
      generation: row.generation,
      priorSizeBytes: Number(row.prior_size),
      created: row.created,
      row
    }
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.contentType] {string}   advisory; ignored for lookup
   * @returns {Promise<ResourceResult>}
   */
  async getResource({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    contentType?: string
  }): Promise<ResourceResult> {
    const { rows } = await this.#reader().query<ResourceRow>(
      `SELECT content_type, content, generation, updated_at,
              updated_at_counter, origin_id, deleted
         FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    const row = rows[0]
    if (!row || row.deleted || row.content === null) {
      throw new ResourceNotFoundError({ requestName: 'Get Resource' })
    }
    return {
      resourceStream: Readable.from(row.content),
      storedResourceType: row.content_type,
      generation: row.generation,
      ...stampOfRow(row)
    }
  }

  /**
   * Soft-deletes a Resource into a tombstone row: content dropped, `deleted`
   * set, a new content stamp minted over the prior one (so the change feed
   * surfaces it) under the row's unchanged `generation`, last-known
   * `content_type` retained, the `/meta` record dropped whole (`custom` with
   * its generation and stamp, so a re-create's first metadata write mints a
   * new generation and a pre-delete `/meta` ETag cannot pass `If-Match`
   * against it), and the freed bytes subtracted from the quota counter -- one
   * transaction. The Resource's live access-control policy, if any, is
   * tombstoned in the same transaction (`#tombstoneLivePolicy`), after the
   * Resource, so it takes the next feed position after the Resource
   * tombstone's. Idempotent on an absent Resource or an existing tombstone,
   * which writes nothing, the policy included.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param [options.ifMatch] {string}
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
    await this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`).
      await this.#lockSpaceRow({ client, spaceId })
      // The tombstone's changes-feed position, taken before the row lock (see
      // `#lockSpaceRow`). A no-op delete commits it unused, which leaves a
      // harmless gap in the sequence. No Collection row means no Resource
      // row either, so the delete is a no-op.
      const feedPosition = await this.#takeFeedPosition({
        client,
        spaceId,
        collectionId
      })
      if (feedPosition === undefined) {
        return
      }
      // Narrow projection: the lock needs the row, not the `content` bytea
      // that is about to be dropped anyway.
      const { rows } = await client.query<
        StampColumns &
          Pick<ResourceRow, 'generation' | 'size_bytes' | 'deleted'>
      >(
        `SELECT generation, updated_at, updated_at_counter, origin_id,
                size_bytes, deleted
           FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        [spaceId, collectionId, resourceId]
      )
      const prior = rows[0]
      const exists = prior !== undefined && !prior.deleted
      assertWritePrecondition({
        resourceId,
        exists,
        currentEtag: exists ? etagOfRow(prior!) : undefined,
        ifMatch
      })
      if (!exists) {
        // Already absent (never existed, or already a tombstone): idempotent
        // no-op, keeping an existing tombstone's change-feed entry stable.
        return
      }
      // A soft delete is an UPDATE, not a row removal, so the chunk foreign
      // key's ON DELETE CASCADE does not fire -- remove the Resource's chunks
      // (the `chunked-streams` feature) explicitly in this same transaction so
      // they never outlive their parent, and return their bytes to the quota
      // counter alongside the Resource's content bytes. Every registration's
      // chunk staging of the Resource goes with them.
      const freedChunkBytes = await this.#deleteChunks({
        client,
        spaceId,
        collectionId,
        resourceId
      })
      const staging = await this.#deleteStaging({
        client,
        spaceId,
        collectionId,
        resourceId
      })
      const freedBytes =
        Number(prior.size_bytes) + freedChunkBytes + staging.freedBytes
      await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
      // The deletion is a revision of the content record, so it mints a new
      // stamp over the prior one (a later re-create reads this row and mints
      // above it). `generation` is deliberately NOT touched: a tombstone
      // keeps the row's marker, so a later re-create continues the content
      // validator under it. The four `meta_*` columns go together: the
      // `/meta` record dies with the metadata object.
      // `writer_id` is set from THIS delete's own declaration, not preserved
      // from the row -- a deletion is a revision like any other, and the
      // tombstone carries the label the deleting write declared, if any
      // (spec "Writer attribution"). `digest` is left as it stands: the
      // tombstone keeps the deleted content's digest, which the write-once
      // rule compares a write over it with.
      const stamp = await this.#clock.mint({ held: stampOfRow(prior) })
      await client.query(
        `UPDATE resources SET
           content = NULL,
           size_bytes = 0,
           meta_generation = NULL,
           meta_updated_at = NULL,
           meta_updated_at_counter = NULL,
           meta_origin_id = NULL,
           custom = NULL,
           epoch = NULL,
           writer_id = $4,
           deleted = true,
           updated_at = $5,
           updated_at_counter = $6,
           origin_id = $7,
           feed_position = $8
         WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        [
          spaceId,
          collectionId,
          resourceId,
          writerId ?? null,
          ...stampValues(stamp),
          feedPosition
        ]
      )
      // The Resource's policy dies with it. The cascade carries no
      // preconditions: the delete's own `If-Match` named the Resource.
      await this.#tombstoneLivePolicy({
        client,
        spaceId,
        collectionId,
        resourceId
      })
    })
  }

  /**
   * Reads the metadata of a Resource's current representation. Tombstones and
   * absent Resources resolve `undefined`. `custom` is included only when
   * non-empty, verbatim (`{ name, tags }` or the opaque envelope). The
   * content record's stamp is top-level and the `/meta` record's stamp and
   * generation the nested `meta`; `generation` is the content record's, out
   * of band.
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
    const { rows } = await this.#reader().query<ResourceRow>(
      `SELECT content_type, size_bytes, generation, updated_at,
              updated_at_counter, origin_id, meta_generation, meta_updated_at,
              meta_updated_at_counter, meta_origin_id, custom, epoch,
              writer_id, deleted, created_at, created_by
         FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    const row = rows[0]
    if (!row || row.deleted) {
      return undefined
    }
    const hasCustom = row.custom !== null && Object.keys(row.custom).length > 0
    return {
      // The content record's stamp, then the `/meta` record's own stamp and
      // generation, once written.
      ...writtenMembersOfRow(row),
      // The content record's generation (out of band).
      generation: row.generation,
      ...(hasCustom && { custom: row.custom as ResourceMetadataCustom }),
      // The client-declared key epoch (the `key-epochs` feature), when stamped.
      ...(row.epoch !== null && { epoch: row.epoch }),
      // The client-declared writer-attribution label (spec "Writer
      // attribution"), when stamped.
      ...(row.writer_id !== null && { writerId: row.writer_id })
    }
  }

  /**
   * Reads the write stamp of a Resource's content record, live or a
   * tombstone.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<{ stamp: Partial<WriteStamp>, deleted: boolean } | undefined>}
   *   `undefined` when no row names the Resource
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
    const { rows } = await this.#reader().query<
      StampColumns & { deleted: boolean }
    >(
      `SELECT deleted, updated_at, updated_at_counter, origin_id
         FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    const row = rows[0]
    if (row === undefined) {
      return undefined
    }
    return { stamp: stampOfRow(row), deleted: row.deleted }
  }

  /**
   * Replaces the user-writable `custom` object (full replacement; `{}`
   * clears), minting a new stamp on the `/meta` record over its prior one --
   * one row-locked transaction, preconditions evaluated on the current
   * `/meta` `ETag` (the composite of the content and `/meta` validators) via
   * the shared helper. The `/meta` record keeps its own
   * `meta_generation`, minted by the first metadata write (afresh after a
   * tombstone dropped it). The content record's stamp, `generation` and
   * `writer_id` are untouched. The write still takes a feed position, so the
   * edit replicates. Resolves `undefined` (no create) for an absent or
   * tombstoned Resource.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.custom {ResourceMetadataCustom | Record<string, unknown>}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<ResourceMetadataWriteResult | undefined>}
   *   the `/meta` object's new validator (its `meta_generation` with the
   *   stamp this write mints) and the content record's validator, beside the
   *   members the writing statement returned
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
    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`). Without it
      // the `collections` row taken below and the `resources` row taken after
      // it would be acquired in the opposite order to Delete Collection's,
      // and a metadata write racing a delete could deadlock.
      await this.#lockSpaceRow({ client, spaceId })
      // A metadata write can create a plaintext equality unique claim for a
      // `custom`-sourced attribute (the `equality-query` feature). When the
      // Collection declares any unique index, take the per-Collection advisory
      // lock (held to commit, serializing concurrent claimants) so the
      // conflict scan below is atomic with the write. The declarations are
      // read under the Space row lock, as on a content write.
      // An absent Collection declares none; its Resource is absent too, which
      // is the handler's 404, answered below.
      const uniqueIndexes =
        (await this.#declaredUniqueIndexes({
          client,
          spaceId,
          collectionId
        })) ?? []
      const equalityUnique = uniqueIndexes.length > 0
      if (equalityUnique) {
        await this.#lockCollectionUniqueness({ client, spaceId, collectionId })
      }
      // The write's changes-feed position, taken before the Resource row lock
      // (see `#lockSpaceRow`). A write that finds no Resource commits it
      // unused, a harmless gap. No Collection row means no Resource row either.
      const feedPosition = await this.#takeFeedPosition({
        client,
        spaceId,
        collectionId
      })
      if (feedPosition === undefined) {
        return undefined
      }
      // Content is the Resource's stored JSON content (unchanged by a
      // metadata write), read for the uniqueness scan below. The (possibly
      // multi-MB) content is fetched only on that uniqueness path (`$4`).
      const { rows } = await client.query<
        Pick<
          ResourceRow,
          | 'generation'
          | 'updated_at'
          | 'updated_at_counter'
          | 'origin_id'
          | 'meta_generation'
          | 'meta_updated_at'
          | 'meta_updated_at_counter'
          | 'meta_origin_id'
          | 'deleted'
        > & { content: Buffer | null }
      >(
        `SELECT generation, updated_at, updated_at_counter, origin_id,
                meta_generation, meta_updated_at, meta_updated_at_counter,
                meta_origin_id, deleted,
                CASE WHEN $4::boolean AND is_json THEN content END AS content
           FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        [spaceId, collectionId, resourceId, equalityUnique]
      )
      const prior = rows[0]
      if (!prior || prior.deleted) {
        return undefined
      }
      const priorMeta = metaStampOfRow(prior)
      // The `/meta` `ETag` a `GET` serves is the composite of the content
      // record's validator and the `/meta` record's, so the precondition is
      // evaluated against that composite.
      const priorRecord = {
        generation: prior.generation,
        ...stampOfRow(prior),
        ...(priorMeta !== undefined && { meta: priorMeta })
      }
      const contentValidator = validatorOf(priorRecord)
      assertMetaWritePrecondition({
        resourceId,
        currentEtag: resourceMetaEtagOf(priorRecord),
        metaWritten: priorMeta !== undefined,
        ifMatch,
        ifNoneMatch
      })
      if (equalityUnique) {
        // Custom is the incoming value this write sets.
        assertNoUniqueEqualityConflict({
          indexes: uniqueIndexes,
          content: prior.content
            ? parseJsonOrUndefined(prior.content)
            : undefined,
          custom,
          candidates: await this.#readEqualityCandidates(client, {
            spaceId,
            collectionId,
            excludeResourceId: resourceId
          })
        })
      }
      // The `/meta` record's own generation: minted by the first metadata
      // write (a tombstone dropped any earlier one, so a re-created Resource
      // starts afresh here) and kept by every later one. Its stamp is minted
      // over the prior `/meta` stamp, under the row lock.
      const metaValidator = await mintValidator({
        clock: this.#clock,
        prior: priorMeta
      })
      const { generation: metaGeneration, stamp: metaStamp } = metaValidator
      const hasCustom = hasCustomMembers(custom)
      // The key-epoch stamp describes the CONTENT write, so a supplied `epoch`
      // replaces it but an OMITTED one PRESERVES the stored value (unlike
      // `custom`, full-replace): `COALESCE($6, epoch)` keeps the current value
      // when the parameter is NULL. The content record's stamp and
      // `writer_id`, which names the writer of the content, are not touched.
      // The statement returns the members the write answers with.
      const { rows: written } = await client.query<WrittenMemberRow>(
        `UPDATE resources SET
           meta_generation = $4,
           custom = $5::jsonb,
           epoch = COALESCE($6, epoch),
           feed_position = $7,
           meta_updated_at = $8,
           meta_updated_at_counter = $9,
           meta_origin_id = $10
         WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
         RETURNING ${WRITTEN_MEMBER_COLUMNS}`,
        [
          spaceId,
          collectionId,
          resourceId,
          metaGeneration,
          hasCustom ? JSON.stringify(custom) : null,
          epoch ?? null,
          feedPosition,
          ...stampValues(metaStamp)
        ]
      )
      return {
        validator: metaValidator,
        ...(contentValidator !== undefined && { contentValidator }),
        members: writtenMembersOfRow(written[0]!)
      }
    })
  }

  // Chunks (the `chunked-streams` feature)

  /**
   * Writes one chunk of a chunked Resource as one transaction: the parent
   * Resource must exist (checked atomically -- a `FOR SHARE` lock on it also
   * blocks a concurrent delete of the parent for the duration of the write, so
   * a chunk can never be orphaned by a racing `deleteResource`), the chunk row
   * is locked, its precondition evaluated, its stamp minted over the prior
   * one, and the transactional quota delta applied. The chunk body is stored opaquely as
   * a single `bytea`, the buffered-blob path (bounded by `maxUploadBytes`),
   * exactly like a binary Resource representation.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}   a non-negative safe integer
   * @param options.input {ResourceInput}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator>}   the chunk's new validator
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
    const { bytes, digest } = await this.#bufferInputCapped(input)

    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`), refusing a
      // Space or Collection that has no Metadata object.
      await this.#lockLiveContainers({
        client,
        spaceId,
        collectionId,
        requestName: 'Write Chunk'
      })
      // Parent Resource must exist (and not be a tombstone), so the parent
      // cannot be deleted between this check and the chunk write.
      await this.#assertResourceLive({
        client,
        spaceId,
        collectionId,
        resourceId,
        requestName: 'Write Chunk'
      })

      // Lock the chunk row (if any, re-reading under the create lock when it
      // does not exist yet) and read its current validator/size, so the
      // precondition, the stamp, and the usage delta are all atomic with the
      // write.
      const chunkLabel = `${resourceId}/chunks/${chunkIndex}`
      type PriorChunk = StampColumns & { generation: string; size: string }
      const selectPrior = async (): Promise<PriorChunk | undefined> => {
        const { rows } = await client.query<PriorChunk>(
          `SELECT generation, updated_at, updated_at_counter, origin_id, size
             FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4
            FOR UPDATE`,
          [spaceId, collectionId, resourceId, chunkIndex]
        )
        return rows[0]
      }
      const prior = await this.#lockRowForWrite({
        client,
        spaceId,
        rowKey: `${collectionId}/${chunkLabel}`,
        lockingSelect: selectPrior
      })
      const exists = prior !== undefined
      assertWritePrecondition({
        resourceId: chunkLabel,
        exists,
        currentEtag: exists ? etagOfRow(prior!) : undefined,
        ifMatch,
        ifNoneMatch
      })

      // A write-once Collection: a stored chunk takes only a repeat of its
      // media type and content digest, which writes nothing.
      if (
        prior !== undefined &&
        (await this.#isWriteOnce({
          client,
          spaceId,
          collectionId,
          immutable
        }))
      ) {
        const { rows: storedRows } = await client.query<{
          content_type: string
          digest: string
        }>(
          `SELECT content_type, digest
             FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4`,
          [spaceId, collectionId, resourceId, chunkIndex]
        )
        const stored = storedRows[0]
        if (
          stored === undefined ||
          !sameMediaType(stored.content_type, input.contentType) ||
          stored.digest !== digest
        ) {
          throw new ResourceImmutableError({ requestName: 'Write Chunk' })
        }
        return stampedValidator({
          generation: prior.generation,
          stamp: stampOfRow(prior)
        })
      }

      // A chunk delete removes its row outright, so there is no tombstone to
      // continue: an overwrite keeps the row's generation, while a write at a
      // freed index mints a new one and cannot reuse the old validators. The
      // stamp is minted over the row's prior one.
      const { generation, stamp } = await mintValidator({
        clock: this.#clock,
        prior: prior && { generation: prior.generation, ...stampOfRow(prior) }
      })
      const values = [
        spaceId,
        collectionId,
        resourceId,
        chunkIndex,
        input.contentType,
        bytes,
        bytes.length,
        generation,
        ...stampValues(stamp),
        digest
      ]
      const insertSql = `
        INSERT INTO chunks (
          space_id, collection_id, resource_id, chunk_index,
          content_type, bytes, size, generation, updated_at,
          updated_at_counter, origin_id, digest
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`
      // Create-if-absent atomicity mirrors `writeResource`: concurrent
      // creators through this method are serialized by `#lockSameKeyCreate`
      // above; the race against a writer that does not take that lock is
      // settled inside `#insertOrUpsertVersioned`.
      const written = await this.#insertOrUpsertVersioned({
        client,
        insertSql,
        // The size this write replaces, read on the writing statement's own
        // snapshot (see `writeResource`).
        priorSizeSql: `SELECT size AS prior_size, false AS prior_deleted
             FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = $4`,
        conflictSql: `
         ON CONFLICT (space_id, collection_id, resource_id, chunk_index)
         DO UPDATE SET
           content_type = EXCLUDED.content_type,
           bytes = EXCLUDED.bytes,
           size = EXCLUDED.size,
           generation = chunks.generation,
           updated_at = EXCLUDED.updated_at,
           updated_at_counter = EXCLUDED.updated_at_counter,
           origin_id = EXCLUDED.origin_id,
           digest = EXCLUDED.digest`,
        values,
        createOnly: ifNoneMatch === '*' && prior === undefined,
        generation,
        conflictDetail: `Chunk '${chunkLabel}' already exists (If-None-Match: *).`
      })
      // Usage delta AFTER the write, from the size the write actually
      // replaced (see `writeResource`).
      const delta = bytes.length - written.priorSizeBytes
      await this.#applyUsageDelta({ client, spaceId, delta })
      return stampedValidator({ generation: written.generation, stamp })
    })
  }

  /**
   * Reads a chunk's bytes. Rejects with `ResourceNotFoundError` (404) when no
   * chunk is stored at that index.
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
    const { rows } = await this.#reader().query<
      StampColumns & {
        content_type: string
        bytes: Buffer
        generation: string
      }
    >(
      `SELECT content_type, bytes, generation, updated_at, updated_at_counter,
              origin_id
         FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND chunk_index = $4`,
      [spaceId, collectionId, resourceId, chunkIndex]
    )
    const row = rows[0]
    if (!row) {
      throw new ResourceNotFoundError({ requestName: 'Get Chunk' })
    }
    return {
      resourceStream: Readable.from(row.bytes),
      storedResourceType: row.content_type,
      generation: row.generation,
      ...stampOfRow(row)
    }
  }

  /**
   * Reads a chunk's stored content-type / size / validator (the HEAD payload
   * headers). Resolves `undefined` when the chunk is absent.
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
    const { rows } = await this.#reader().query<
      StampColumns & {
        content_type: string
        size: string
        generation: string
      }
    >(
      `SELECT content_type, size, generation, updated_at, updated_at_counter,
              origin_id
         FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND chunk_index = $4`,
      [spaceId, collectionId, resourceId, chunkIndex]
    )
    const row = rows[0]
    if (!row) {
      return undefined
    }
    return {
      contentType: row.content_type,
      size: Number(row.size),
      generation: row.generation,
      ...stampOfRow(row)
    }
  }

  /**
   * Deletes one chunk as one transaction (the chunk row is locked, its
   * `ifMatch` precondition evaluated atomically, and its bytes returned to the
   * quota counter). Resolves `true` when a chunk was removed, `false` when none
   * was stored at that index (the handler 404s on `false` -- chunk deletes are
   * not silently idempotent, unlike `deleteResource`).
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @param [options.ifMatch] {string}
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
    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`).
      await this.#lockSpaceRow({ client, spaceId })
      const { rows } = await client.query<
        StampColumns & { generation: string; size: string }
      >(
        `SELECT generation, updated_at, updated_at_counter, origin_id, size
           FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            AND chunk_index = $4
          FOR UPDATE`,
        [spaceId, collectionId, resourceId, chunkIndex]
      )
      const prior = rows[0]
      if (prior === undefined) {
        return false
      }
      assertWritePrecondition({
        resourceId: `${resourceId}/chunks/${chunkIndex}`,
        exists: true,
        currentEtag: etagOfRow(prior),
        ifMatch
      })
      await client.query(
        `DELETE FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            AND chunk_index = $4`,
        [spaceId, collectionId, resourceId, chunkIndex]
      )
      const freedBytes = Number(prior.size)
      await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
      return true
    })
  }

  /**
   * Lists a Resource's stored chunks in ascending `chunk_index` order -- the
   * discovery/reassembly listing. The opaque `bytes` column is deliberately not
   * selected. Each entry's `etag` is formatted from the validator columns the
   * one `SELECT` reads beside the size and content type (`etagOfRow`), the
   * same validator `getChunkMetadata` reports. An empty listing (Resource with no chunks, or
   * an absent Resource) resolves `{ count: 0, chunks: [] }`.
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
    const { rows } = await this.#reader().query<
      StampColumns & {
        chunk_index: number
        size: string
        content_type: string
        generation: string
      }
    >(
      `SELECT chunk_index, size, content_type, generation, updated_at,
              updated_at_counter, origin_id
         FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
        ORDER BY chunk_index`,
      [spaceId, collectionId, resourceId]
    )
    return {
      count: rows.length,
      chunks: rows.map(row => ({
        index: row.chunk_index,
        size: Number(row.size),
        contentType: row.content_type,
        // The validator columns of a chunk row are NOT NULL.
        etag: etagOfRow(row)!
      }))
    }
  }

  /**
   * Replication change feed (the `changes` query profile): every record kind
   * in the Collection, ordered by feed position and seeking strictly past
   * `afterPosition`. A Resource of any content type, tombstones included, is
   * a `resource` document, with the body parsed only for a live JSON
   * Resource. The Collection Metadata object is one `collection-metadata`
   * document at the position of its latest write, and the governing history
   * log one `log` document at the position of its latest write. Each
   * Collection- or Resource-level policy is one `policy` document at the
   * position of its latest write, a tombstone included. One statement reads
   * the Collection row, its feed generation included, beside the first
   * `limit` Resource rows and the first `limit` policy rows past
   * `afterPosition`, so all of it comes from one snapshot. Positions are commit-ordered (`#takeFeedPosition`), so
   * that snapshot never holds a position without every lower one. The at most
   * two container documents are merged in by position, and the page is cut at
   * `limit` across all kinds. Each `resource` document carries the content
   * record's stamp and, once metadata has been written, the `/meta` record's
   * stamp and generation as `meta`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.afterPosition] {number}   resume strictly after this
   *   feed position
   * @param options.limit {number}
   * @returns {Promise<{ documents: FeedDocument[], checkpoint: number | null,
   *   feedGeneration?: string }>}
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
    const pageSize = clampPageSize(limit)
    const after = afterPosition ?? 0
    // The Collection row's columns are prefixed `c_` so they cannot collide
    // with the Resource row's. A Collection with no Resource past the
    // position still yields its one row, with every Resource column NULL.
    // Only a live JSON Resource's body is read; a binary body stays in the
    // table.
    const { rows } = await this.#reader().query<
      Partial<ResourceRow & { resource_id: string }> & {
        c_feed_generation: string | null
        c_metadata_feed_position: string | null
        c_meta_generation: string | null
        c_meta_local: number
        c_updated_at: string
        c_updated_at_counter: number
        c_origin_id: string
        c_log_feed_position: string | null
        c_log_generation: string | null
        c_log_updated_at: string | null
        c_log_updated_at_counter: number | null
        c_log_origin_id: string | null
        c_policies: Array<
          PolicyRow & { resource_id: string; feed_position: number }
        >
      }
    >(
      `SELECT c.feed_generation        AS c_feed_generation,
              c.metadata_feed_position AS c_metadata_feed_position,
              c.meta_generation        AS c_meta_generation,
              c.meta_local             AS c_meta_local,
              c.updated_at             AS c_updated_at,
              c.updated_at_counter     AS c_updated_at_counter,
              c.origin_id              AS c_origin_id,
              c.log_feed_position      AS c_log_feed_position,
              c.log_generation         AS c_log_generation,
              c.log_updated_at         AS c_log_updated_at,
              c.log_updated_at_counter AS c_log_updated_at_counter,
              c.log_origin_id          AS c_log_origin_id,
              (SELECT COALESCE(json_agg(p ORDER BY p.feed_position), '[]')
                 FROM (SELECT resource_id, ${POLICY_COLUMNS}, feed_position
                         FROM policies
                        WHERE space_id = c.space_id
                          AND collection_id = c.collection_id
                          AND feed_position > $3
                        ORDER BY feed_position
                        LIMIT $4) p) AS c_policies,
              r.*
         FROM collections c
         LEFT JOIN LATERAL (
           SELECT resource_id, content_type,
                  CASE WHEN is_json AND NOT deleted THEN content END AS content,
                  is_json, generation, updated_at, updated_at_counter,
                  origin_id, meta_generation, meta_updated_at,
                  meta_updated_at_counter, meta_origin_id, custom, epoch,
                  writer_id, deleted, created_by, feed_position
             FROM resources
            WHERE space_id = c.space_id AND collection_id = c.collection_id
              AND feed_position IS NOT NULL AND feed_position > $3
            ORDER BY feed_position
            LIMIT $4
         ) r ON true
        WHERE c.space_id = $1 AND c.collection_id = $2
        ORDER BY r.feed_position`,
      [spaceId, collectionId, after, pageSize]
    )
    const collectionRow = rows[0]
    // The generation the Collection's positions were handed out under, NULL
    // until the first one.
    const feedGeneration = collectionRow?.c_feed_generation ?? undefined

    // The Collection row alone, with no Resource past the position, carries
    // no `resource_id`.
    const documents: FeedDocument[] = rows.flatMap(row =>
      row.resource_id == null
        ? []
        : [resourceFeedDocument(row as ResourceRow & { resource_id: string })]
    )
    if (collectionRow !== undefined) {
      const metadataPosition = positionOf(
        collectionRow.c_metadata_feed_position
      )
      if (metadataPosition !== undefined && metadataPosition > after) {
        // The validator `getCollectionMetadata` reports, local segment
        // included, so a log write since the object's own write shows in it.
        documents.push(
          containerFeedDocument({
            kind: 'collection-metadata',
            feedPosition: metadataPosition,
            stamp: {
              updatedAt: collectionRow.c_updated_at,
              updatedAtCounter: collectionRow.c_updated_at_counter,
              originId: collectionRow.c_origin_id
            },
            generation: collectionRow.c_meta_generation ?? undefined,
            local: collectionRow.c_meta_local
          })
        )
      }
      const logPosition = positionOf(collectionRow.c_log_feed_position)
      if (
        logPosition !== undefined &&
        logPosition > after &&
        collectionRow.c_log_updated_at !== null &&
        collectionRow.c_log_updated_at_counter !== null &&
        collectionRow.c_log_origin_id !== null
      ) {
        // The log's own validator, as `getCollectionLog` reports it.
        documents.push(
          containerFeedDocument({
            kind: 'log',
            feedPosition: logPosition,
            stamp: {
              updatedAt: collectionRow.c_log_updated_at,
              updatedAtCounter: collectionRow.c_log_updated_at_counter,
              originId: collectionRow.c_log_origin_id
            },
            generation: collectionRow.c_log_generation ?? undefined
          })
        )
      }
    }
    // The Collection's policies past the position, read by the same
    // statement: the Collection's own (`resource_id` '') and each Resource's,
    // live or a tombstone.
    for (const policyRow of collectionRow?.c_policies ?? []) {
      const document = policyFeedDocument({
        record: storedPolicyFromRow(policyRow)!,
        ...(policyRow.resource_id !== '' && {
          resourceId: policyRow.resource_id
        }),
        feedPosition: Number(policyRow.feed_position)
      })
      if (document !== undefined) {
        documents.push(document)
      }
    }
    // The Resource rows and the policy rows are each the first `pageSize`
    // past the position, so after the container documents are merged in by
    // position, the first `pageSize` documents of the merge are the page.
    documents.sort((left, right) => left.feedPosition - right.feedPosition)
    documents.length = Math.min(documents.length, pageSize)

    const last = documents[documents.length - 1]
    return {
      documents,
      checkpoint: last ? last.feedPosition : null,
      ...(feedGeneration !== undefined && { feedGeneration })
    }
  }

  /**
   * Blinded-index query (the `blinded-index` query profile; see the
   * `StorageBackend.queryByBlindedIndex` contract). Selects the Collection's
   * live JSON rows, parses each body, and hands the candidates to the shared
   * evaluator (`lib/blindedIndex.ts`) for matching, ordering, and cursor
   * pagination -- identical semantics to the filesystem backend. A full scan
   * of the Collection per call, deliberate for this teaching backend; an
   * indexed variant would flatten the blinded attributes into an indexed
   * token side-table (the bedrock-edv-storage strategy). Unparsable JSON is
   * skipped.
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
      await this.#readEqualityCandidates(this.#reader(), {
        spaceId,
        collectionId
      })
    )
    return runBlindedIndexQuery({ candidates, query, count, limit, cursor })
  }

  /**
   * Plaintext equality query (the `equality` query profile; see the
   * `StorageBackend.queryByEquality` contract). Reads the Collection's live
   * Resources -- JSON rows carrying parsed `content`, all rows carrying their
   * `custom` jsonb -- and hands the candidates to the shared evaluator
   * (`lib/equalityIndex.ts`) for extraction, matching, ordering, and cursor
   * pagination -- identical semantics to the filesystem backend. A full scan of
   * the Collection per call, deliberate for this teaching backend; a
   * materialized variant would answer from a JSONB expression index.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.query {EqualityQuery}
   * @param options.indexes {NormalizedIndexDeclaration[]}
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
    const candidates = await this.#readEqualityCandidates(this.#reader(), {
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
    const candidates = await this.#readEqualityCandidates(this.#reader(), {
      spaceId,
      collectionId
    })
    return findEqualityUniqueViolation({ indexes, candidates })
  }

  /**
   * Reads every live Resource of a Collection as an equality candidate -- the
   * candidate set for the equality query and the plaintext unique-attribute
   * conflict scans, and, narrowed by `jsonCandidatesFrom`, for the
   * blinded-index query and the unique-blinded conflict scan. Includes blob Resources (queryable through their
   * `custom`-sourced attributes): each row resolves `{ resourceId, content?,
   * custom? }`, where `content` is the parsed JSON of a JSON row (a blob and
   * unparsable JSON contribute none) and `custom` is the row's jsonb `custom`
   * when set. Tombstones are excluded (`NOT deleted`); an optional excluded
   * Resource is skipped. Runs on the given executor -- the pool for a read-only
   * query, or the write transaction's client for a uniqueness scan (so the scan
   * shares the advisory lock and sees a consistent snapshot).
   * @param executor {pg.Pool | pg.PoolClient}
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param [options.excludeResourceId] {string}
   * @returns {Promise<EqualityCandidate[]>}
   */
  async #readEqualityCandidates(
    executor: pg.Pool | pg.PoolClient,
    {
      spaceId,
      collectionId,
      excludeResourceId
    }: {
      spaceId: string
      collectionId: string
      excludeResourceId?: string
    }
  ): Promise<EqualityCandidate[]> {
    const { rows } = await executor.query<{
      resource_id: string
      content: Buffer | null
      is_json: boolean
      custom: ResourceMetadataCustom | Record<string, unknown> | null
    }>(
      `SELECT resource_id, is_json, custom,
              CASE WHEN is_json THEN content END AS content
         FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND NOT deleted
          AND ($3::text IS NULL OR resource_id <> $3)
        ORDER BY resource_id`,
      [spaceId, collectionId, excludeResourceId ?? null]
    )
    const candidates: EqualityCandidate[] = []
    for (const row of rows) {
      // An unparsable body contributes no content attributes.
      const content =
        row.is_json && row.content
          ? parseJsonOrUndefined(row.content)
          : undefined
      candidates.push({
        resourceId: row.resource_id,
        ...(content !== undefined && { content }),
        ...(row.custom !== null && { custom: row.custom })
      })
    }
    return candidates
  }

  // Policies

  /**
   * Maps the optional-id policy addressing onto the sentinel-column primary
   * key: Space policy `('', '')`, Collection policy `(cid, '')`, Resource
   * policy `(cid, rid)`.
   * @param options {object}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {{ collectionKey: string, resourceKey: string }}
   */
  #policyKey({
    collectionId,
    resourceId
  }: {
    collectionId?: string
    resourceId?: string
  }): { collectionKey: string; resourceKey: string } {
    return {
      collectionKey: collectionId ?? '',
      resourceKey: resourceId ?? ''
    }
  }

  /**
   * The stored policy record at a level, live or a tombstone, beside its
   * validator. Every policy read goes through here; `getPolicy` drops a
   * tombstone.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.queryable] {Queryable}   a transaction's client; the
   *   pool when omitted
   * @returns {Promise<StoredPolicy | undefined>}
   */
  async getPolicyRecord({
    spaceId,
    collectionId,
    resourceId,
    queryable = this.#reader()
  }: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    queryable?: Queryable
  }): Promise<StoredPolicy | undefined> {
    const { collectionKey, resourceKey } = this.#policyKey({
      collectionId,
      resourceId
    })
    const { rows } = await queryable.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM policies
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionKey, resourceKey]
    )
    return storedPolicyFromRow(rows[0])
  }

  /**
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {Promise<PolicyDocument|undefined>}   falsy when no live policy
   *   is set at that level, a tombstone included
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
   * Creates or replaces a policy. The Space row lock that
   * `#lockLiveContainers` takes serializes every policy write in the Space,
   * so the read, the precondition check and the upsert are atomic without a
   * row lock of their own. A Collection- or Resource-level write takes the
   * Collection's next feed position (`#takeFeedPosition`) once its
   * preconditions pass. A Resource-level write is refused with
   * `ResourceNotFoundError` (404) unless the Resource is live, read under a
   * `FOR SHARE` lock that serializes it with `deleteResource`, so a policy is
   * never written for a Resource that is gone. The caller passes
   * `requireLiveResource: false` when the Collection's Resources live on
   * another backend, which this store cannot check.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.policy {PolicyDocument}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
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
    return this.#withTransaction(async client => {
      // The containing Space, and the Collection when the policy is below
      // Space level, must have a Metadata object: a policy never creates one.
      await this.#lockLiveContainers({ client, spaceId, collectionId })
      if (
        collectionId !== undefined &&
        resourceId !== undefined &&
        requireLiveResource
      ) {
        await this.#assertResourceLive({
          client,
          spaceId,
          collectionId,
          resourceId,
          requestName: 'Update Policy'
        })
      }
      const prior = await this.getPolicyRecord({
        spaceId,
        collectionId,
        resourceId,
        queryable: client
      })
      const live = livePolicyUnderPrecondition({
        prior,
        spaceId,
        collectionId,
        resourceId,
        ifMatch,
        ifNoneMatch
      })
      // A write over a tombstone is a create: a new generation, and a stamp
      // above the tombstone's.
      const validator = await mintValidator({
        clock: this.#clock,
        prior: priorPolicyParts(prior)
      })
      const body = normalizePolicyWrite(policy)
      await this.#upsertPolicy({
        client,
        spaceId,
        collectionId,
        resourceId,
        body,
        validator
      })
      return {
        validator,
        created: live === undefined,
        policy: stampedPolicy({ body, stamp: validator.stamp })
      }
    })
  }

  /**
   * Deletes the live policy at a level, leaving a tombstone. Serialized with
   * every other policy write by the Space row lock, as `writePolicy` is.
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
    return this.#withTransaction(async client => {
      await this.#lockSpaceRow({ client, spaceId })
      return this.#tombstoneLivePolicy({
        client,
        spaceId,
        collectionId,
        resourceId,
        ifMatch,
        ifNoneMatch
      })
    })
  }

  /**
   * Refuses the caller's write unless the Resource is live
   * (`ResourceNotFoundError`, 404). The `FOR SHARE` lock on the Resource row
   * conflicts with the `FOR UPDATE` a concurrent `deleteResource` takes, so
   * the two serialize on the row and the delete cannot land between this
   * check and the caller's write. Shared by the chunk write's parent check
   * and the Resource-level policy write.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.requestName {string}
   * @returns {Promise<void>}
   */
  async #assertResourceLive({
    client,
    spaceId,
    collectionId,
    resourceId,
    requestName
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId: string
    requestName: string
  }): Promise<void> {
    const { rows } = await client.query<{ deleted: boolean }>(
      `SELECT deleted FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
        FOR SHARE`,
      [spaceId, collectionId, resourceId]
    )
    if (!rows[0] || rows[0].deleted) {
      throw new ResourceNotFoundError({ requestName })
    }
  }

  /**
   * Tombstones the live policy at a level, after evaluating the preconditions
   * against it, inside the caller's transaction, which holds the Space row.
   * Writes nothing when no live policy is stored. The tombstone keeps the
   * live policy's generation and takes a stamp above it, and a Collection- or
   * Resource-level tombstone takes the Collection's next feed position
   * (`#upsertPolicy`). Shared by `deletePolicy` and the `deleteResource`
   * cascade.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {HeldValidators}
   * @returns {Promise<EtagValidator | undefined>}   the tombstone's validator,
   *   or `undefined` when nothing was written
   */
  async #tombstoneLivePolicy({
    client,
    spaceId,
    collectionId,
    resourceId,
    ifMatch,
    ifNoneMatch
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId?: string
    resourceId?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined> {
    const prior = await this.getPolicyRecord({
      spaceId,
      collectionId,
      resourceId,
      queryable: client
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
    await this.#upsertPolicy({
      client,
      spaceId,
      collectionId,
      resourceId,
      body: null,
      validator
    })
    return validator
  }

  /**
   * Writes an archived policy at a level, under the archived generation and a
   * fresh stamp, when the destination stores no policy record there. A
   * tombstone counts as a record, so an import does not undo a delete. Runs in
   * the import's transaction, which holds the Space row.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.imported {ImportedPolicy}
   * @returns {Promise<boolean>}   whether the policy was written
   */
  async #importPolicy({
    client,
    spaceId,
    collectionId,
    resourceId,
    imported
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId?: string
    resourceId?: string
    imported: ImportedPolicy
  }): Promise<boolean> {
    if (
      await this.getPolicyRecord({
        spaceId,
        collectionId,
        resourceId,
        queryable: client
      })
    ) {
      return false
    }
    await this.#upsertPolicy({
      client,
      spaceId,
      collectionId,
      resourceId,
      body: imported.policy,
      validator: stampedValidator({
        generation: imported.generation,
        stamp: await this.#clock.mint()
      })
    })
    return true
  }

  /**
   * The one policy upsert statement, shared by `writePolicy`,
   * `#tombstoneLivePolicy` and the import apply loop; keys through
   * `#policyKey` so the sentinel convention lives in one place. A `null` body writes a tombstone. A
   * Collection- or Resource-level write takes the Collection's next feed
   * position first, which locks the `collections` row ahead of the
   * `policies` row; a Space policy takes none.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.body {PolicyDocument | null}   the policy body without
   *   its stamp, or `null` for a tombstone
   * @param options.validator {EtagValidator}   the write's generation and
   *   stamp
   * @returns {Promise<void>}
   */
  async #upsertPolicy({
    client,
    spaceId,
    collectionId,
    resourceId,
    body,
    validator
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId?: string
    resourceId?: string
    body: PolicyDocument | null
    validator: EtagValidator
  }): Promise<void> {
    const { collectionKey, resourceKey } = this.#policyKey({
      collectionId,
      resourceId
    })
    const feedPosition =
      collectionId === undefined
        ? null
        : await this.#takeFeedPosition({ client, spaceId, collectionId })
    await client.query(
      `INSERT INTO policies (space_id, collection_id, resource_id, policy,
                             deleted, generation, updated_at,
                             updated_at_counter, origin_id, feed_position)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (space_id, collection_id, resource_id)
       DO UPDATE SET policy             = EXCLUDED.policy,
                     deleted            = EXCLUDED.deleted,
                     generation         = EXCLUDED.generation,
                     updated_at         = EXCLUDED.updated_at,
                     updated_at_counter = EXCLUDED.updated_at_counter,
                     origin_id          = EXCLUDED.origin_id,
                     feed_position      = EXCLUDED.feed_position`,
      [
        spaceId,
        collectionKey,
        resourceKey,
        body === null ? null : JSON.stringify(body),
        body === null,
        validator.generation,
        ...stampValues(validator.stamp),
        feedPosition
      ]
    )
  }

  // Registered external backends (spec "Backends")

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
    await this.#withTransaction(async client => {
      await this.#lockSpaceMetadata({ client, spaceId })
      await this.#lockLiveContainers({ client, spaceId })
      await client.query(
        `INSERT INTO backend_records (space_id, backend_id, record)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (space_id, backend_id)
         DO UPDATE SET record = EXCLUDED.record`,
        [spaceId, backendId, JSON.stringify(record)]
      )
      await this.#advanceSpaceMetaLocal({ client, spaceId })
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
   * it must for a strong validator. The caller holds `#lockSpaceMetadata`,
   * so the advance cannot land between a concurrent `writeSpace`'s plain read
   * and its upsert and be overwritten. A Space with no Metadata object has no
   * validator to advance.
   * @param options {object}
   * @param options.client {pg.PoolClient}   the caller's transaction
   * @param options.spaceId {string}
   * @returns {Promise<void>}
   */
  async #advanceSpaceMetaLocal({
    client,
    spaceId
  }: {
    client: pg.PoolClient
    spaceId: string
  }): Promise<void> {
    await client.query(
      `UPDATE spaces SET meta_local = meta_local + 1
        WHERE space_id = $1 AND metadata IS NOT NULL`,
      [spaceId]
    )
  }

  /**
   * The full (secret-bearing) record, or `undefined`. The only method that
   * exposes secret connection material -- internal use.
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
    const { rows } = await this.#reader().query<{
      record: StoredBackendRecord
    }>(
      `SELECT record FROM backend_records
        WHERE space_id = $1 AND backend_id = $2`,
      [spaceId, backendId]
    )
    return rows[0]?.record
  }

  /**
   * The Space's registered backends, **sanitized** (mapped through
   * `sanitizeBackendRecord` -- the secret boundary is unchanged), sorted by id.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<BackendDescriptor[]>}
   */
  async listBackends({
    spaceId
  }: {
    spaceId: string
  }): Promise<BackendDescriptor[]> {
    const { rows } = await this.#reader().query<{
      record: StoredBackendRecord
    }>(
      `SELECT record FROM backend_records
        WHERE space_id = $1 ORDER BY backend_id`,
      [spaceId]
    )
    return rows.map(row => sanitizeBackendRecord(row.record))
  }

  /**
   * Removes a registered backend record. A removal that found the record
   * advances the Space Metadata object's local validator segment, since its
   * `backends` listing changed; one that found nothing leaves the object as
   * it was.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.backendId {string}
   * @returns {Promise<void>}   idempotent
   */
  async deleteBackend({
    spaceId,
    backendId
  }: {
    spaceId: string
    backendId: string
  }): Promise<void> {
    await this.#withTransaction(async client => {
      await this.#lockSpaceMetadata({ client, spaceId })
      const { rowCount } = await client.query(
        `DELETE FROM backend_records WHERE space_id = $1 AND backend_id = $2`,
        [spaceId, backendId]
      )
      if (rowCount) {
        await this.#advanceSpaceMetaLocal({ client, spaceId })
      }
    })
  }

  // Replica registrations (the replication specification)

  /**
   * Stores a registration, create-only: `writeReplica` with no precondition,
   * refusing a registration already stored under the id.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.record {ReplicaRegistration}
   * @param options.pullsChunks {boolean}   whether the pull loop reads the
   *   chunk sets of chunked Resources from the source server
   * @returns {Promise<StoredReplica>}
   * @throws {SpaceNotFoundError}   the Space has no Metadata object (404)
   * @throws {IdConflictError}   the Space holds a registration under
   *   `record.id` (409)
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
   * Creates or replaces a registration under its preconditions. The Space
   * Metadata lock is held for the transaction, so Delete Space and the
   * Space's other registration writes and deletes wait, and the stored row is
   * read `FOR UPDATE` and the write decided against it
   * (`decideReplicaWrite`), the Space's registrations read in the same
   * transaction when the decision needs them. A create records the Space
   * Metadata object's current generation and advances the object's local
   * segment. A replacement keeps the generation, the `space_generation` and
   * the loop `state`.
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
    const requestName = replicaWriteRequestName({ createOnly })
    return this.#withTransaction(async client => {
      await this.#lockSpaceMetadata({ client, spaceId })
      const { rows } = await client.query<{ meta_generation: string | null }>(
        `SELECT meta_generation FROM spaces
          WHERE space_id = $1 AND metadata IS NOT NULL FOR UPDATE`,
        [spaceId]
      )
      const currentSpaceGeneration = rows[0]?.meta_generation
      if (
        currentSpaceGeneration === undefined ||
        currentSpaceGeneration === null
      ) {
        throw new SpaceNotFoundError({ requestName })
      }
      const held = await client.query<ReplicaRow>(
        `SELECT ${REPLICA_COLUMNS} FROM replicas
          WHERE space_id = $1 AND replica_id = $2 FOR UPDATE`,
        [spaceId, replicaId]
      )
      const { stored, prior } = await decideReplicaWrite({
        prior: held.rows[0] && storedReplicaFromRow(held.rows[0]),
        record,
        pullsChunks,
        clock: this.#clock,
        currentSpaceGeneration: async () => currentSpaceGeneration,
        listReplicas: async () => {
          const { rows } = await client.query<ReplicaRow>(
            `SELECT ${REPLICA_COLUMNS} FROM replicas WHERE space_id = $1`,
            [spaceId]
          )
          return rows.map(storedReplicaFromRow)
        },
        requireRegisteredSource,
        createOnly,
        ifMatch,
        ifNoneMatch
      })
      const stamp = stampOf(stored.record) as WriteStamp
      await client.query(
        `INSERT INTO replicas (space_id, replica_id, record, generation,
                               space_generation, pulls_chunks, updated_at,
                               updated_at_counter, origin_id)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (space_id, replica_id)
         DO UPDATE SET record             = EXCLUDED.record,
                       pulls_chunks       = EXCLUDED.pulls_chunks,
                       updated_at         = EXCLUDED.updated_at,
                       updated_at_counter = EXCLUDED.updated_at_counter,
                       origin_id          = EXCLUDED.origin_id`,
        [
          spaceId,
          replicaId,
          JSON.stringify(withoutStampMembers(stored.record)),
          stored.generation,
          stored.spaceGeneration,
          stored.pullsChunks,
          ...stampValues(stamp)
        ]
      )
      if (prior === undefined) {
        await this.#advanceSpaceMetaLocal({ client, spaceId })
      }
      return { stored, prior }
    })
  }

  /**
   * The stored registration, capability included, or `undefined`.
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
    const { rows } = await this.#reader().query<ReplicaRow>(
      `SELECT ${REPLICA_COLUMNS} FROM replicas
        WHERE space_id = $1 AND replica_id = $2`,
      [spaceId, replicaId]
    )
    return rows[0] && storedReplicaFromRow(rows[0])
  }

  /**
   * The Space's registrations in ascending id order.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {Promise<StoredReplica[]>}
   */
  async listReplicas({
    spaceId
  }: {
    spaceId: string
  }): Promise<StoredReplica[]> {
    const { rows } = await this.#reader().query<ReplicaRow>(
      `SELECT ${REPLICA_COLUMNS} FROM replicas
        WHERE space_id = $1 ORDER BY replica_id`,
      [spaceId]
    )
    return rows.map(storedReplicaFromRow)
  }

  /**
   * Every registration in the store, by Space id then registration id.
   * @returns {Promise<Array<StoredReplica & { spaceId: string }>>}
   */
  async listAllReplicas(): Promise<Array<StoredReplica & { spaceId: string }>> {
    const { rows } = await this.#reader().query<
      ReplicaRow & { space_id: string }
    >(
      `SELECT space_id, ${REPLICA_COLUMNS} FROM replicas
        ORDER BY space_id, replica_id`
    )
    return rows.map(row => ({
      ...storedReplicaFromRow(row),
      spaceId: row.space_id
    }))
  }

  /**
   * Removes a registration, its loop state with it. A removal that found the
   * row advances the Space Metadata object's local validator segment.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<boolean>}   `false` when none was stored
   */
  async deleteReplica({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<boolean> {
    return this.#withTransaction(async client => {
      await this.#lockSpaceMetadata({ client, spaceId })
      const { rowCount } = await client.query(
        `DELETE FROM replicas WHERE space_id = $1 AND replica_id = $2`,
        [spaceId, replicaId]
      )
      if (!rowCount) {
        return false
      }
      await this.#advanceSpaceMetaLocal({ client, spaceId })
      return true
    })
  }

  /**
   * The registration's stored loop state, or `undefined` when it has none
   * yet or the registration is gone.
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
    const { rows } = await this.#reader().query<{
      state: ReplicaLoopState | null
    }>(`SELECT state FROM replicas WHERE space_id = $1 AND replica_id = $2`, [
      spaceId,
      replicaId
    ])
    return rows[0]?.state ?? undefined
  }

  /**
   * Replaces the registration's loop state. The `UPDATE` matches no row once
   * the registration is gone, so nothing is written then.
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
    const { rowCount } = await this.#reader().query(
      `UPDATE replicas SET state = $3::jsonb
        WHERE space_id = $1 AND replica_id = $2`,
      [spaceId, replicaId, JSON.stringify(state)]
    )
    return Boolean(rowCount)
  }

  // The apply path (replication)

  /**
   * The checks every apply method makes first, inside its transaction, in
   * the order the `StorageBackend` contract gives. It takes the Space row
   * lock, the first lock of the backend-wide order (`#lockSpaceRow`), and
   * holds it to commit, so neither a Delete Space nor a Delete Collection
   * lands under the apply. Where the record names a Collection it locks the
   * `collections` row too, ahead of any `resources` row.
   *
   * Resolves the result that ends the apply, or `undefined` when the apply
   * goes on to its comparison:
   *
   * - `unregistered` when the Space has no Metadata object, the registration
   *   is not stored, or it was made under another generation of the Space.
   * - `refused` with reason `clock-bound` when the clock does not take a
   *   received stamp in.
   * - `skipped` when `collectionId` is given and that Collection is absent
   *   or tombstoned.
   *
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for a copy of a
   *   control-plane record, which runs under no registration
   * @param [options.collectionId] {string}   a Collection that must be live
   * @param options.stamps {WriteStamp[]}   every stamp the record carries
   * @returns {Promise<ApplyResult | undefined>}
   * @throws {StorageError}   a stamp is not one a store can hold; the caller
   *   validates received stamps before it applies
   */
  async #beginApply({
    client,
    spaceId,
    replicaId,
    collectionId,
    stamps
  }: {
    client: pg.PoolClient
    spaceId: string
    replicaId?: string
    collectionId?: string
    stamps: unknown[]
  }): Promise<ApplyResult | undefined> {
    assertReceivableStamps(stamps)
    // The registration is read with the Space row: a Space with no Metadata
    // object yields no row, which `guardApply` answers `unregistered` with
    // or without a registration.
    const { rows: spaceRows } = await client.query<{
      meta_generation: string | null
      space_generation: string | null
    }>(
      `SELECT s.meta_generation, r.space_generation
         FROM spaces s
         LEFT JOIN replicas r
           ON r.space_id = s.space_id AND r.replica_id = $2
        WHERE s.space_id = $1 AND s.metadata IS NOT NULL
          FOR UPDATE OF s`,
      [spaceId, replicaId ?? null]
    )
    // A copy of a control-plane record (no `replicaId`) runs under no
    // registration; the Space must still hold a Metadata object.
    const registeredUnder =
      replicaId === undefined
        ? spaceRows[0]?.meta_generation
        : spaceRows[0]?.space_generation
    const stopped = guardApply({
      registeredUnder: registeredUnder ?? undefined,
      spaceGeneration: spaceRows[0]?.meta_generation,
      clock: this.#clock,
      stamps
    })
    if (stopped !== undefined || collectionId === undefined) {
      return stopped
    }
    // A tombstoned Collection has no Metadata object.
    const { rows: collectionRows } = await client.query<{ live: boolean }>(
      `SELECT metadata IS NOT NULL AND NOT deleted AS live FROM collections
        WHERE space_id = $1 AND collection_id = $2 FOR UPDATE`,
      [spaceId, collectionId]
    )
    return collectionRows[0]?.live ? undefined : { outcome: 'skipped' }
  }

  /**
   * Applies the Space Metadata object's `name`, the one member of it that
   * replicates, when `stamp` wins over the object's own. Every other stored
   * member is kept, the generation and `controller` included. The object
   * takes `stamp`, and its local validator segment is reset to 0, as every
   * stamped write resets it.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param [options.name] {string}   absent removes the stored name
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
    return this.#withTransaction(async client => {
      await this.#lockSpaceMetadata({ client, spaceId })
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        stamps: [stamp]
      })
      if (ended !== undefined) {
        return ended
      }
      const prior = (await this.#readSpaceRow({ queryable: client, spaceId }))!
      if (!stampWins({ incoming: stamp, held: stampOf(prior) })) {
        return { outcome: 'skipped' }
      }
      const { name: _heldName, ...body } = withoutStampMembers(
        stripMetadataValidator(prior)
      )
      await client.query(
        `UPDATE spaces SET
           metadata           = $2::jsonb,
           meta_local         = 0,
           updated_at         = $3,
           updated_at_counter = $4,
           origin_id          = $5
         WHERE space_id = $1`,
        [
          spaceId,
          JSON.stringify({ ...body, ...(name !== undefined && { name }) }),
          ...stampValues(stamp)
        ]
      )
      return { outcome: 'applied' }
    })
  }

  /**
   * Applies a Collection Metadata object or a Collection tombstone in one
   * transaction, by `decideCollectionApply` / `decideCollectionTombstoneApply`
   * over the `collections` row read under its lock.
   *
   * A `create` and an `update` go through the Metadata upsert a request-layer
   * write uses, so they take the feed position such a write takes and reset
   * the local validator segment. A `replace` and a `delete` remove the held
   * Collection's member rows as Delete Collection does. A `replace` then
   * leaves the row tombstoned for the upsert, which treats it as a create
   * over a tombstone: a fresh feed counter and no governing history log.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.collectionId {string}
   * @param options.collection {object}   the received object, or the
   *   received tombstone's stamp
   * @returns {Promise<ApplyResult>}
   * @throws {CountQuotaExceededError}   a create would exceed the Collection
   *   count quota
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
    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        stamps: collection.deleted
          ? [collection.stamp]
          : [stampOf(collection.metadata), collection.metadata.created]
      })
      if (ended !== undefined) {
        return ended
      }
      const { rows } = await client.query<
        MetadataRow<CollectionMetadata> & { deleted: boolean }
      >(
        `SELECT ${METADATA_COLUMNS}, deleted
           FROM collections
          WHERE space_id = $1 AND collection_id = $2 FOR UPDATE`,
        [spaceId, collectionId]
      )
      const row = rows[0]
      const prior = storedMetadataFromRow(row)
      const held =
        row &&
        heldCollection({
          deleted: row.deleted,
          // A row with no Metadata object holds no live Collection.
          generation:
            prior === undefined
              ? undefined
              : (row.meta_generation ?? undefined),
          stamp: stampOfRow(row),
          created: prior?.created
        })

      if (collection.deleted) {
        const { stamp } = collection
        const decision = decideCollectionTombstoneApply({ held, stamp })
        if (decision === 'skip') {
          return { outcome: 'skipped' }
        }
        if (decision !== 'restamp') {
          // A row with no Metadata object can still hold member rows.
          await this.#removeCollectionMembers({ client, spaceId, collectionId })
        }
        await this.#tombstoneCollectionRow({
          client,
          spaceId,
          collectionId,
          // The tombstone keeps the held generation. One received before the
          // Collection existed here has none to keep.
          generation: resolveGeneration(row?.meta_generation),
          stamp
        })
        return { outcome: 'applied' }
      }

      const { generation } = collection
      const incoming = normalizeMetadataWrite({
        metadata: collection.metadata
      }).body
      const stamp = stampOf(collection.metadata) as WriteStamp
      const decision = decideCollectionApply({
        held,
        incoming: { generation, stamp, created: collection.metadata.created! }
      })
      if (decision === 'skip') {
        return { outcome: 'skipped' }
      }
      let body = incoming
      if (decision === 'update') {
        const merged = mergeAppliedCollectionMetadata({
          held: stripMetadataValidator(prior!),
          incoming
        })
        if ('fork' in merged) {
          return { outcome: 'refused', reason: 'fork', detail: merged.fork }
        }
        body = merged.metadata
      } else {
        if (decision === 'replace') {
          // The held life goes as Delete Collection removes one. The row is
          // left tombstoned under its own generation and stamp, so the
          // upsert below starts the received life over a tombstone.
          await this.#removeCollectionMembers({ client, spaceId, collectionId })
          await this.#tombstoneCollectionRow({
            client,
            spaceId,
            collectionId,
            generation: resolveGeneration(row?.meta_generation),
            stamp: stampOfRow(row!)
          })
        }
        // Count quota, as on a request-layer create. A replace has just
        // freed the place it takes.
        await this.#assertCollectionQuota({ client, spaceId })
      }
      await this.#upsertCollection({
        queryable: client,
        spaceId,
        collectionId,
        body,
        generation,
        stamp
      })
      return { outcome: 'applied' }
    })
  }

  /**
   * Applies a Resource's content record, live or a tombstone, in one
   * transaction under the locks a Resource write takes. The row is stored
   * under the received generation and stamp. A live Resource keeps the
   * `/meta` record and `custom` of a live row it replaces. A tombstone drops
   * them with the chunks, as Delete Resource does. A `did.jsonl` Resource is
   * decided by `decideLogApply` in place of the stamp comparison.
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
   * @param [options.createdBy] {IDID}
   * @param [options.writerId] {string}
   * @param options.resource {object}   the received representation, or the
   *   tombstone's last-known content type
   * @returns {Promise<ApplyResult>}
   * @throws {PayloadTooLargeError}   the body exceeds the upload cap
   * @throws {QuotaExceededError}   the write would exceed the Space quota
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
    // Buffered before the transaction, so a slow body holds no row lock.
    const buffered = resource.deleted
      ? null
      : await this.#bufferInputCapped(resource.input)
    const content = buffered === null ? null : buffered.bytes
    const digest = buffered === null ? null : buffered.digest
    const contentType = resource.deleted
      ? resource.contentType
      : resource.input.contentType

    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: [stamp]
      })
      if (ended !== undefined) {
        return ended
      }
      // A history log is never deleted by a peer (`decideResourceApply`).
      // The refusal is answered here, ahead of the row lock, so it locks
      // nothing.
      if (resource.deleted && resourceId === WEBVH_LOG_RESOURCE_ID) {
        return { outcome: 'skipped' }
      }
      const { prior, stopped } = await this.#lockResourceForApply({
        client,
        spaceId,
        collectionId,
        resourceId,
        stamp,
        content
      })
      if (stopped !== undefined) {
        return stopped
      }

      // A tombstone takes the chunks with it, as Delete Resource does. A
      // soft delete is an UPDATE, so the foreign key's cascade does not fire.
      // It takes every registration's chunk staging of the Resource too,
      // which a Resource never held here can have.
      let freedBytes = 0
      if (content === null) {
        if (prior !== undefined) {
          freedBytes += await this.#deleteChunks({
            client,
            spaceId,
            collectionId,
            resourceId
          })
        }
        const staging = await this.#deleteStaging({
          client,
          spaceId,
          collectionId,
          resourceId
        })
        freedBytes += staging.freedBytes
      }

      const parentDelta = await this.#writeAppliedResourceRow({
        client,
        spaceId,
        collectionId,
        resourceId,
        generation,
        stamp,
        createdAt,
        createdBy,
        writerId,
        contentType,
        content,
        digest,
        epoch: resource.deleted ? undefined : resource.epoch,
        prior
      })
      // Usage delta after the write, from the size the write replaced, so a
      // `QuotaExceededError` rolls the whole apply back.
      await this.#applyUsageDelta({
        client,
        spaceId,
        delta: parentDelta - freedBytes
      })
      return { outcome: 'applied' }
    })
  }

  /**
   * Locks the `resources` row a content apply writes, re-reading it under
   * the same-key create lock when it is absent (`#lockRowForWrite`), and
   * decides the apply against the held content record
   * (`decideResourceApply`). Shared by both forms of `applyResource`,
   * inside their transaction, after `#beginApply`.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.stamp {WriteStamp}   the received content stamp
   * @param options.content {Buffer | null}   the received representation,
   *   `null` for a tombstone
   * @returns {Promise<{ prior?: AppliedResourcePrior,
   *   stopped?: ApplyResult }>}   the held row, if any, and the result that
   *   ends the apply when the received record is not to be stored
   */
  async #lockResourceForApply({
    client,
    spaceId,
    collectionId,
    resourceId,
    stamp,
    content
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId: string
    stamp: WriteStamp
    content: Buffer | null
  }): Promise<{ prior?: AppliedResourcePrior; stopped?: ApplyResult }> {
    const isLog = resourceId === WEBVH_LOG_RESOURCE_ID && content !== null
    // The held bytes are read only for a history log, which is compared by
    // them.
    const prior = await this.#lockRowForWrite<AppliedResourcePrior>({
      client,
      spaceId,
      rowKey: `${collectionId}/${resourceId}`,
      lockingSelect: async () => {
        const { rows } = await client.query<AppliedResourcePrior>(
          `SELECT updated_at, updated_at_counter, origin_id, deleted,
                  created_at, created_by,
                  ${isLog ? 'content' : 'NULL::bytea AS content'}
             FROM resources
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            FOR UPDATE`,
          [spaceId, collectionId, resourceId]
        )
        return rows[0]
      }
    })
    const live = prior !== undefined && !prior.deleted
    const stopped = decideResourceApply({
      resourceId,
      deleted: content === null,
      stamp,
      held: prior && stampOfRow(prior),
      log: isLog
        ? {
            held: live ? (prior.content ?? undefined) : undefined,
            incoming: content
          }
        : undefined
    })
    return { prior, stopped }
  }

  /**
   * Stores a received Resource content record, live or a tombstone, on the
   * row `#lockResourceForApply` locked, under the received generation and
   * stamp, and takes the Collection's next feed position for it. A live
   * Resource keeps the `/meta` record and `custom` of a live row it
   * replaces; a tombstone on either side has none. Shared by both forms of
   * `applyResource`; the caller applies the usage delta.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}
   * @param [options.createdAt] {string}
   * @param [options.createdBy] {IDID}
   * @param [options.writerId] {string}
   * @param options.contentType {string}
   * @param options.content {Buffer | null}   `null` for a tombstone
   * @param [options.epoch] {string}
   * @param [options.prior] {AppliedResourcePrior}   the held row
   * @returns {Promise<number>}   the stored size less the size it replaced
   */
  async #writeAppliedResourceRow({
    client,
    spaceId,
    collectionId,
    resourceId,
    generation,
    stamp,
    createdAt,
    createdBy,
    writerId,
    contentType,
    content,
    digest,
    epoch,
    prior
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId: string
    generation: string
    stamp: WriteStamp
    createdAt?: string
    createdBy?: IDID
    writerId?: string
    contentType: string
    content: Buffer | null
    digest: string | null
    epoch?: string
    prior?: AppliedResourcePrior
  }): Promise<number> {
    // The Collection row is locked already (`#beginApply`), so the
    // position is taken only by a record that is stored.
    const feedPosition = (await this.#takeFeedPosition({
      client,
      spaceId,
      collectionId
    }))!
    const size = content?.length ?? 0
    // The members the origin's content write set. A live Resource takes
    // them as received, `createdBy` cleared when absent. A tombstone keeps
    // the held creator when none is received, as a local delete keeps it.
    const storedCreatedAt = createdAt ?? prior?.created_at ?? stamp.updatedAt
    const storedCreatedBy =
      createdBy ?? (content === null ? (prior?.created_by ?? null) : null)
    // The `/meta` record and `custom` stay as they stand on a live row a
    // live Resource replaces. A tombstone on either side has none. A
    // tombstone keeps the row's digest, as a local delete does; a live
    // Resource records the digest of the bytes applied.
    const written = await this.#insertOrUpsertVersioned({
      client,
      insertSql: `
        INSERT INTO resources (
          space_id, collection_id, resource_id, content_type, content,
          is_json, size_bytes, generation, custom, deleted, created_at,
          updated_at, updated_at_counter, origin_id, created_by, epoch,
          writer_id, feed_position, digest
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12,
                  $13, $14, $15, $16, $17, $18)`,
      priorSizeSql: `SELECT size_bytes AS prior_size, deleted AS prior_deleted
           FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      conflictSql: `
         ON CONFLICT (space_id, collection_id, resource_id) DO UPDATE SET
           content_type = EXCLUDED.content_type,
           content = EXCLUDED.content,
           is_json = EXCLUDED.is_json,
           size_bytes = EXCLUDED.size_bytes,
           generation = EXCLUDED.generation,
           meta_generation = CASE
             WHEN EXCLUDED.deleted OR resources.deleted THEN NULL
             ELSE resources.meta_generation END,
           meta_updated_at = CASE
             WHEN EXCLUDED.deleted OR resources.deleted THEN NULL
             ELSE resources.meta_updated_at END,
           meta_updated_at_counter = CASE
             WHEN EXCLUDED.deleted OR resources.deleted THEN NULL
             ELSE resources.meta_updated_at_counter END,
           meta_origin_id = CASE
             WHEN EXCLUDED.deleted OR resources.deleted THEN NULL
             ELSE resources.meta_origin_id END,
           custom = CASE
             WHEN EXCLUDED.deleted OR resources.deleted THEN NULL
             ELSE resources.custom END,
           deleted = EXCLUDED.deleted,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           updated_at_counter = EXCLUDED.updated_at_counter,
           origin_id = EXCLUDED.origin_id,
           created_by = EXCLUDED.created_by,
           epoch = EXCLUDED.epoch,
           writer_id = EXCLUDED.writer_id,
           feed_position = EXCLUDED.feed_position,
           digest = CASE WHEN EXCLUDED.deleted
                         THEN resources.digest
                         ELSE EXCLUDED.digest END`,
      values: [
        spaceId,
        collectionId,
        resourceId,
        contentType,
        content,
        content !== null && isJsonContentType(contentType),
        size,
        generation,
        content === null,
        storedCreatedAt,
        ...stampValues(stamp),
        storedCreatedBy,
        content === null ? null : (epoch ?? null),
        writerId ?? null,
        feedPosition,
        digest
      ],
      createOnly: false,
      generation,
      conflictDetail: `Resource '${resourceId}' already exists.`
    })
    return size - written.priorSizeBytes
  }

  // The chunk pull (replication)

  /**
   * Opens the staging of `run` for one chunk pull, in one transaction under
   * the apply path's locks: the registration check (`replicaId`, as on
   * `applyResource`) and a live Collection (`#beginApply`). The
   * registration's staging of the same Resource under any other parent
   * revision is removed here, since the loop that owns it has moved past
   * that revision, and its bytes return to the usage counter. Then the
   * quota pre-check of the set (`chunkSetQuotaRefusal`), from
   * the rows staged under `run`, the live chunk bytes the swap frees and
   * the counter. A swap here is one transaction, so there is no torn run
   * to finish. Nothing is staged here.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for a backend other than the
   *   control plane, which holds no registrations
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.run {ChunkStagingRun}
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
    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: []
      })
      if (ended !== undefined) {
        // `#beginApply` answers only the outcomes that stop an apply.
        return ended as Exclude<ApplyResult, { outcome: 'applied' }>
      }
      const superseded = await this.#deleteStaging({
        client,
        spaceId,
        collectionId,
        resourceId,
        replicaId: run.replicaId,
        exceptParentEtag: run.parentEtag
      })
      await this.#applyUsageDelta({
        client,
        spaceId,
        delta: -superseded.freedBytes
      })
      const resourceKey = [spaceId, collectionId, resourceId]
      const staged = await this.#stagedChunks({
        db: client,
        spaceId,
        collectionId,
        resourceId,
        run
      })
      const { rows: liveRows } = await client.query<{ bytes: string }>(
        `SELECT COALESCE(SUM(size), 0) AS bytes FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        resourceKey
      )
      const { rows: usageRows } = await client.query<{ usage_bytes: string }>(
        `SELECT usage_bytes FROM spaces WHERE space_id = $1`,
        [spaceId]
      )
      const refused = chunkSetQuotaRefusal({
        listed,
        staged,
        liveBytes: Number(liveRows[0]!.bytes),
        usageBytes: Number(usageRows[0]?.usage_bytes ?? 0),
        capacityBytes: this.capacityBytes,
        maxUploadBytes: this.maxUploadBytes
      })
      return refused ?? { staged }
    })
  }

  /**
   * Stages one chunk a chunk pull read from the source server, in one
   * transaction under the apply path's locks: the registration check
   * (`replicaId`, as on `applyResource`) and a live Collection
   * (`#beginApply`), then the staging row at the key of `run` and
   * `chunkIndex`, replacing a row staged there before. The parent is not
   * required to be held: a Resource replicated for the first time has no
   * row until the swap. The bytes count toward usage. The capacity check
   * credits the live chunks at every index staged under `run`, which the
   * swap replaces, so a same-size rewrite of a stream fits under a quota
   * its live set already fills. That credit is read from the rows under the
   * lock. A staged chunk takes no feed position, and its stamp and
   * generation are minted at the swap.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for a backend other than the
   *   control plane, which holds no registrations
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.run {ChunkStagingRun}
   * @param options.chunkIndex {number}
   * @param options.input {ResourceInput}
   * @param options.peerEtag {string}   the source server's `ETag` of the
   *   chunk, opaque
   * @returns {Promise<ApplyResult>}
   * @throws {PayloadTooLargeError}   the body exceeds the upload cap
   * @throws {QuotaExceededError}   the staged bytes would exceed the quota
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
  }): Promise<ApplyResult> {
    // Buffered before the transaction, so a slow body holds no row lock.
    // The staged bytes' digest is what the swap records on the chunk row.
    const { bytes, digest } = await this.#bufferInputCapped(input)

    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: []
      })
      if (ended !== undefined) {
        return ended
      }
      const runKey = [
        spaceId,
        collectionId,
        resourceId,
        run.replicaId,
        run.parentEtag
      ]
      const { rows } = await client.query<{ prior_size: string }>(
        `WITH prior AS (
           SELECT size FROM chunk_staging
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND replica_id = $4 AND parent_etag = $5 AND chunk_index = $6
         )
         INSERT INTO chunk_staging (
           space_id, collection_id, resource_id, replica_id, parent_etag,
           chunk_index, content_type, bytes, size, peer_etag, digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (space_id, collection_id, resource_id, replica_id,
                      parent_etag, chunk_index)
         DO UPDATE SET
           content_type = EXCLUDED.content_type,
           bytes = EXCLUDED.bytes,
           size = EXCLUDED.size,
           peer_etag = EXCLUDED.peer_etag,
           digest = EXCLUDED.digest
         RETURNING COALESCE((SELECT size FROM prior), 0) AS prior_size`,
        [
          ...runKey,
          chunkIndex,
          input.contentType,
          bytes,
          bytes.length,
          peerEtag,
          digest
        ]
      )
      const { rows: creditRows } = await client.query<{ credit: string }>(
        `SELECT COALESCE(SUM(c.size), 0) AS credit
           FROM chunk_staging s
           JOIN chunks c
             ON c.space_id = s.space_id AND c.collection_id = s.collection_id
            AND c.resource_id = s.resource_id
            AND c.chunk_index = s.chunk_index
          WHERE s.space_id = $1 AND s.collection_id = $2
            AND s.resource_id = $3 AND s.replica_id = $4
            AND s.parent_etag = $5`,
        runKey
      )
      await this.#applyUsageDelta({
        client,
        spaceId,
        delta: bytes.length - Number(rows[0]!.prior_size),
        credit: Number(creditRows[0]!.credit)
      })
      return { outcome: 'applied' }
    })
  }

  /**
   * The chunks staged under `run`, by ascending index, each with its size
   * and the source server's `ETag` it was read under.
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
    return this.#stagedChunks({
      db: this.#reader(),
      spaceId,
      collectionId,
      resourceId,
      run
    })
  }

  /**
   * The chunk staging rows of one run, by ascending index.
   * @param options {object}
   * @param options.db {pg.Pool | pg.PoolClient}   the caller's transaction,
   *   or the reader
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.run {ChunkStagingRun}
   * @returns {Promise<StagedChunk[]>}
   */
  async #stagedChunks({
    db,
    spaceId,
    collectionId,
    resourceId,
    run
  }: {
    db: pg.Pool | pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
  }): Promise<StagedChunk[]> {
    const { rows } = await db.query<{
      chunk_index: number
      size: string
      peer_etag: string
    }>(
      `SELECT chunk_index, size, peer_etag FROM chunk_staging
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND replica_id = $4 AND parent_etag = $5
        ORDER BY chunk_index`,
      [spaceId, collectionId, resourceId, run.replicaId, run.parentEtag]
    )
    return rows.map(row => ({
      index: row.chunk_index,
      size: Number(row.size),
      peerEtag: row.peer_etag
    }))
  }

  /**
   * The `chunks` form of `applyResource`: a live Resource content record
   * with its chunk set, in one transaction: the registration check and the
   * clock (`#beginApply`), the parent's row lock and the last-writer-wins
   * decision as `applyResource` takes them. On a win, the live chunks not
   * in `staged` are deleted, the parent row is written as `applyResource` writes it and
   * takes its feed position (first, since a chunk row needs its parent
   * row), each staged row is moved into `chunks` under a fresh generation
   * and a stamp minted here, and the registration's staging of the Resource
   * is released. Every row moves by key in SQL, so no bytes pass through
   * this process. On a loss or an equal stamp the staging is released and
   * the result is `skipped`. The transaction's commit is the moment the
   * parent and its set become visible together. Staged bytes already count
   * toward usage, so the net delta is the parent's change less the live
   * bytes removed or replaced and the staged bytes released unused.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for a backend other than the
   *   control plane, which holds no registrations
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.generation {string}
   * @param options.stamp {WriteStamp}
   * @param [options.createdAt] {string}
   * @param [options.createdBy] {IDID}
   * @param [options.writerId] {string}
   * @param options.resource {object}   the received representation
   * @param options.chunks {object}   the staging run and the indexes staged
   *   under it
   * @returns {Promise<ApplyResult>}   `refused` with `container-refused` for
   *   a staged index with no staging row, with the staging released
   * @throws {PayloadTooLargeError}   the body exceeds the upload cap
   * @throws {QuotaExceededError}   the parent's growth exceeds the quota
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
    // Buffered before the transaction, so a slow body holds no row lock.
    const { bytes: content, digest } = await this.#bufferInputCapped(
      resource.input
    )

    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: [stamp]
      })
      if (ended !== undefined) {
        return ended
      }
      const resourceKey = [spaceId, collectionId, resourceId]
      const releaseStaging = async (): Promise<number> => {
        const { freedBytes } = await this.#deleteStaging({
          client,
          spaceId,
          collectionId,
          resourceId,
          replicaId: chunks.run.replicaId
        })
        return freedBytes
      }
      // The staging is released as on a loss, and its bytes leave the
      // usage count, when the apply stores nothing.
      const releaseWithoutApply = async (): Promise<void> => {
        const releasedBytes = await releaseStaging()
        await this.#applyUsageDelta({ client, spaceId, delta: -releasedBytes })
      }
      const { prior, stopped } = await this.#lockResourceForApply({
        client,
        spaceId,
        collectionId,
        resourceId,
        stamp,
        content
      })
      if (stopped !== undefined) {
        await releaseWithoutApply()
        return stopped
      }

      const { rows: liveRows } = await client.query<{
        chunk_index: number
        size: string
      }>(
        `SELECT chunk_index, size FROM chunks
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        resourceKey
      )
      const { rows: stagedRows } = await client.query<{ chunk_index: number }>(
        `SELECT chunk_index FROM chunk_staging
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
            AND replica_id = $4 AND parent_etag = $5
          FOR UPDATE`,
        [...resourceKey, chunks.run.replicaId, chunks.run.parentEtag]
      )
      const live = new Map(
        liveRows.map(row => [row.chunk_index, Number(row.size)])
      )
      const refusal = chunkSetRefusal({
        resourceId,
        staged: chunks.staged,
        stagedHeld: new Set(stagedRows.map(row => row.chunk_index))
      })
      if (refusal !== undefined) {
        await releaseWithoutApply()
        return refusal
      }

      const keep = new Set(chunks.staged)
      const removed = [...live.keys()].filter(index => !keep.has(index))
      const replacedBytes = chunks.staged.reduce(
        (total, index) => total + (live.get(index) ?? 0),
        0
      )
      let removedBytes = 0
      if (removed.length > 0) {
        const { rows } = await client.query<{ size: string }>(
          `DELETE FROM chunks
            WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
              AND chunk_index = ANY($4::int[])
            RETURNING size`,
          [...resourceKey, removed]
        )
        removedBytes = rows.reduce((total, row) => total + Number(row.size), 0)
      }

      // The parent row goes first: a chunk row's foreign key needs it, and a
      // Resource replicated for the first time has none yet.
      const parentDelta = await this.#writeAppliedResourceRow({
        client,
        spaceId,
        collectionId,
        resourceId,
        generation,
        stamp,
        createdAt,
        createdBy,
        writerId,
        contentType: resource.input.contentType,
        content,
        digest,
        epoch: resource.epoch,
        prior
      })

      let movedBytes = 0
      if (chunks.staged.length > 0) {
        // Each moved chunk is a local record: a fresh generation and a stamp
        // from this store's clock, as a client's write at a free index gets.
        const minted: EtagValidator[] = []
        while (minted.length < chunks.staged.length) {
          minted.push(
            await mintValidator({ clock: this.#clock, prior: undefined })
          )
        }
        const { rows } = await client.query<{ size: string }>(
          `INSERT INTO chunks (
             space_id, collection_id, resource_id, chunk_index, content_type,
             bytes, size, generation, updated_at, updated_at_counter,
             origin_id, digest
           )
           SELECT s.space_id, s.collection_id, s.resource_id, s.chunk_index,
                  s.content_type, s.bytes, s.size, v.generation,
                  v.updated_at, v.updated_at_counter, v.origin_id, s.digest
             FROM chunk_staging s
             JOIN unnest($6::int[], $7::text[], $8::text[], $9::int[],
                         $10::text[])
               AS v(chunk_index, generation, updated_at, updated_at_counter,
                    origin_id)
               ON v.chunk_index = s.chunk_index
            WHERE s.space_id = $1 AND s.collection_id = $2
              AND s.resource_id = $3 AND s.replica_id = $4
              AND s.parent_etag = $5
           ON CONFLICT (space_id, collection_id, resource_id, chunk_index)
           DO UPDATE SET
             content_type = EXCLUDED.content_type,
             bytes = EXCLUDED.bytes,
             size = EXCLUDED.size,
             generation = EXCLUDED.generation,
             updated_at = EXCLUDED.updated_at,
             updated_at_counter = EXCLUDED.updated_at_counter,
             origin_id = EXCLUDED.origin_id,
             digest = EXCLUDED.digest
           RETURNING size`,
          [
            ...resourceKey,
            chunks.run.replicaId,
            chunks.run.parentEtag,
            chunks.staged,
            minted.map(validator => validator.generation),
            minted.map(validator => validator.stamp.updatedAt),
            minted.map(validator => validator.stamp.updatedAtCounter),
            minted.map(validator => validator.stamp.originId)
          ]
        )
        movedBytes = rows.reduce((total, row) => total + Number(row.size), 0)
      }
      const releasedBytes = await releaseStaging()

      await this.#applyUsageDelta({
        client,
        spaceId,
        delta:
          parentDelta -
          removedBytes -
          replacedBytes +
          movedBytes -
          releasedBytes
      })
      return { outcome: 'applied' }
    })
  }

  /**
   * Removes the chunk staging in the scope the ids select, the bytes it
   * held returned to the Space's usage counter: a registration's on Delete
   * Replica, a Resource's, a Collection's or a Space's. A Postgres swap is
   * one transaction, so no run is ever left half swapped and every run in
   * scope is removed. A scope that holds no staging row is answered from
   * one read, with no transaction and no Space row lock, since the pull
   * loop reclaims before a chunked Resource it applies as a plain record.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.replicaId] {string}
   * @returns {Promise<number>}   how many runs were removed
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
    const { values, conditions } = stagingScope({
      spaceId,
      collectionId,
      resourceId,
      replicaId
    })
    const { rowCount } = await this.#reader().query(
      `SELECT 1 FROM chunk_staging WHERE ${conditions.join(' AND ')} LIMIT 1`,
      values
    )
    if (rowCount === 0) {
      return 0
    }
    return this.#withTransaction(async client => {
      // First lock of the backend-wide order (`#lockSpaceRow`), ahead of the
      // staging rows, as `stageChunk` takes them.
      await this.#lockSpaceRow({ client, spaceId })
      const { freedBytes, runs } = await this.#deleteStaging({
        client,
        spaceId,
        collectionId,
        resourceId,
        replicaId
      })
      await this.#applyUsageDelta({ client, spaceId, delta: -freedBytes })
      return runs
    })
  }

  /**
   * Deletes the chunk staging rows in the scope the ids select, inside the
   * caller's transaction, which holds the Space row. The caller returns the
   * freed bytes to the usage counter.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param [options.replicaId] {string}
   * @param [options.exceptParentEtag] {string}   keeps the run of this
   *   parent revision, in a scope `replicaId` already fixes
   * @returns {Promise<{ freedBytes: number, runs: number }>}   the bytes the
   *   removed rows held and how many runs they made up
   */
  async #deleteStaging({
    client,
    spaceId,
    collectionId,
    resourceId,
    replicaId,
    exceptParentEtag
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId?: string
    resourceId?: string
    replicaId?: string
    exceptParentEtag?: string
  }): Promise<{ freedBytes: number; runs: number }> {
    const { values, conditions } = stagingScope({
      spaceId,
      collectionId,
      resourceId,
      replicaId
    })
    if (exceptParentEtag !== undefined) {
      values.push(exceptParentEtag)
      conditions.push(`parent_etag <> $${values.length}`)
    }
    const { rows } = await client.query<{
      collection_id: string
      resource_id: string
      replica_id: string
      parent_etag: string
      size: string
    }>(
      `DELETE FROM chunk_staging WHERE ${conditions.join(' AND ')}
        RETURNING collection_id, resource_id, replica_id, parent_etag, size`,
      values
    )
    const runs = new Set(
      rows.map(row =>
        JSON.stringify([
          row.collection_id,
          row.resource_id,
          row.replica_id,
          row.parent_etag
        ])
      )
    )
    return {
      freedBytes: rows.reduce((total, row) => total + Number(row.size), 0),
      runs: runs.size
    }
  }

  /**
   * Applies a Resource's `/meta` record when `meta` wins over the held
   * `/meta` record's stamp: the record takes the received generation and
   * stamp, and `custom` replaces the stored one. The content record, the key
   * epoch and the writer label are not touched. The apply takes a feed
   * position, as a metadata write does.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   absent for an apply into a server
   *   backend other than the control plane, which runs under no
   *   registration
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.meta {ResourceMetaStamp}   the `/meta` record's stamp and
   *   generation
   * @param [options.custom] {ResourceMetadataCustom | Record<string, unknown>}
   *   absent or empty clears the stored one
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
    return this.#withTransaction(async client => {
      const { generation, ...stamp } = meta
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: [stamp]
      })
      if (ended !== undefined) {
        return ended
      }
      const { rows } = await client.query<
        Pick<
          ResourceRow,
          | 'meta_generation'
          | 'meta_updated_at'
          | 'meta_updated_at_counter'
          | 'meta_origin_id'
          | 'deleted'
        >
      >(
        `SELECT meta_generation, meta_updated_at, meta_updated_at_counter,
                meta_origin_id, deleted
           FROM resources
          WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          FOR UPDATE`,
        [spaceId, collectionId, resourceId]
      )
      const prior = rows[0]
      if (
        prior === undefined ||
        prior.deleted ||
        !stampWins({ incoming: stamp, held: metaStampOfRow(prior) })
      ) {
        return { outcome: 'skipped' }
      }
      const feedPosition = (await this.#takeFeedPosition({
        client,
        spaceId,
        collectionId
      }))!
      const hasCustom = hasCustomMembers(custom)
      await client.query(
        `UPDATE resources SET
           meta_generation = $4,
           custom = $5::jsonb,
           feed_position = $6,
           meta_updated_at = $7,
           meta_updated_at_counter = $8,
           meta_origin_id = $9
         WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
        [
          spaceId,
          collectionId,
          resourceId,
          generation,
          hasCustom ? JSON.stringify(custom) : null,
          feedPosition,
          ...stampValues(stamp)
        ]
      )
      return { outcome: 'applied' }
    })
  }

  /**
   * Applies an access-control policy, live or a tombstone, at the level the
   * ids select, when `stamp` wins over the held policy record's. The record
   * goes through the upsert every policy write uses, so a Collection- or
   * Resource-level one takes the Collection's next feed position.
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
    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: [stamp]
      })
      if (ended !== undefined) {
        return ended
      }
      const prior = await this.getPolicyRecord({
        spaceId,
        collectionId,
        resourceId,
        queryable: client
      })
      if (!stampWins({ incoming: stamp, held: prior?.validator?.stamp })) {
        return { outcome: 'skipped' }
      }
      await this.#upsertPolicy({
        client,
        spaceId,
        collectionId,
        resourceId,
        body: policy === undefined ? null : normalizePolicyWrite(policy),
        validator: stampedValidator({ generation, stamp })
      })
      return { outcome: 'applied' }
    })
  }

  /**
   * Applies a Collection's governing history log by `decideLogApply` over
   * the log read under the `collections` row lock. An applied log is stored
   * under the received generation and stamp, takes the Collection's next
   * feed position as the log's own, and advances the Collection Metadata
   * object's local validator segment, as a log write does.
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
    return this.#withTransaction(async client => {
      const ended = await this.#beginApply({
        client,
        spaceId,
        replicaId,
        collectionId,
        stamps: [stamp]
      })
      if (ended !== undefined) {
        return ended
      }
      const { rows } = await client.query<LogRow>(
        `SELECT ${LOG_COLUMNS}
           FROM collections
          WHERE space_id = $1 AND collection_id = $2`,
        [spaceId, collectionId]
      )
      const decision = decideLogApply({
        held: storedLogFromRow(rows[0])?.body,
        incoming: body
      })
      if (decision === 'fork') {
        return logForkResult('governing history log')
      }
      if (decision === 'skip') {
        return { outcome: 'skipped' }
      }
      await this.#storeLog({
        client,
        spaceId,
        collectionId,
        body,
        generation,
        stamp,
        advanceLocal: true
      })
      return { outcome: 'applied' }
    })
  }

  // WebKMS keystores (the `/kms` facet)

  /**
   * Persists a keystore config unconditionally (the create path; local ids
   * are server-generated random values). The queryable/gated fields
   * (`controller`, `sequence`, `kmsModule`) are denormalized alongside the
   * verbatim config.
   * @param options {object}
   * @param options.keystoreId {string}
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
    await this.#reader().query(
      `INSERT INTO keystores (keystore_id, controller, sequence, kms_module, config)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (keystore_id) DO UPDATE SET
         controller = EXCLUDED.controller,
         sequence = EXCLUDED.sequence,
         kms_module = EXCLUDED.kms_module,
         config = EXCLUDED.config`,
      [
        keystoreId,
        config.controller,
        config.sequence,
        config.kmsModule,
        JSON.stringify(config)
      ]
    )
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}
   * @returns {Promise<KeystoreConfig|undefined>}
   */
  async getKeystore({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<KeystoreConfig | undefined> {
    const { rows } = await this.#reader().query<{ config: KeystoreConfig }>(
      'SELECT config FROM keystores WHERE keystore_id = $1',
      [keystoreId]
    )
    return rows[0]?.config
  }

  /**
   * Replaces a keystore config, gated atomically in one conditional `UPDATE`:
   * the row must exist with `sequence` exactly one less than the incoming
   * config's and an unchanged `kmsModule`. Zero rows updated -- missing
   * keystore, stale sequence, or module change alike -- rejects with the
   * protocol's single merged 409 (`KeystoreStateConflictError`).
   * @param options {object}
   * @param options.keystoreId {string}
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
    const result = await this.#reader().query(
      `UPDATE keystores SET
         controller = $2,
         sequence = $3,
         config = $4::jsonb
       WHERE keystore_id = $1 AND sequence = $3 - 1 AND kms_module = $5`,
      [
        keystoreId,
        config.controller,
        config.sequence,
        JSON.stringify(config),
        config.kmsModule
      ]
    )
    if (result.rowCount === 0) {
      throw new KeystoreStateConflictError()
    }
  }

  /**
   * Every stored keystore config whose `controller` matches, sorted by local
   * id (the request layer caps the wire result).
   * @param options {object}
   * @param options.controller {IDID}
   * @returns {Promise<KeystoreConfig[]>}
   */
  async listKeystoresByController({
    controller
  }: {
    controller: IDID
  }): Promise<KeystoreConfig[]> {
    const { rows } = await this.#reader().query<{ config: KeystoreConfig }>(
      `SELECT config FROM keystores
        WHERE controller = $1 ORDER BY keystore_id`,
      [controller]
    )
    return rows.map(row => row.config)
  }

  /**
   * Inserts a key record, create-only: the primary key enforces the
   * `(keystoreId, localId)` uniqueness atomically; a duplicate rejects with
   * the protocol's 409 (`KeyIdConflictError`). The record is stored verbatim
   * (opaque to storage -- the at-rest cipher applies above the backend).
   * @param options {object}
   * @param options.keystoreId {string}
   * @param options.localId {string}
   * @param options.record {KmsKeyRecord}
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
    try {
      await this.#reader().query(
        `INSERT INTO kms_keys (keystore_id, local_id, record)
         VALUES ($1, $2, $3::jsonb)`,
        [keystoreId, localId, JSON.stringify(record)]
      )
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) {
        throw new KeyIdConflictError()
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * @param options {object}
   * @param options.keystoreId {string}
   * @param options.localId {string}
   * @returns {Promise<KmsKeyRecord|undefined>}
   */
  async getKey({
    keystoreId,
    localId
  }: {
    keystoreId: string
    localId: string
  }): Promise<KmsKeyRecord | undefined> {
    const { rows } = await this.#reader().query<{ record: KmsKeyRecord }>(
      `SELECT record FROM kms_keys
        WHERE keystore_id = $1 AND local_id = $2`,
      [keystoreId, localId]
    )
    return rows[0]?.record
  }

  /**
   * Every stored key record under the keystore, sorted by local id (the request
   * layer caps and paginates the wire result). An empty keystore resolves an
   * empty list. The record is returned verbatim -- the at-rest cipher applies
   * above the backend.
   * @param options {object}
   * @param options.keystoreId {string}
   * @returns {Promise<Array<{ localId: string, record: KmsKeyRecord }>>}
   */
  async listKeys({
    keystoreId
  }: {
    keystoreId: string
  }): Promise<Array<{ localId: string; record: KmsKeyRecord }>> {
    const { rows } = await this.#reader().query<{
      local_id: string
      record: KmsKeyRecord
    }>(
      `SELECT local_id, record FROM kms_keys
        WHERE keystore_id = $1 ORDER BY local_id`,
      [keystoreId]
    )
    return rows.map(row => ({ localId: row.local_id, record: row.record }))
  }

  /**
   * Resolves a revocation scope to the table it lives in, the scope column
   * within that table, and the scope id value. The returned `table` and
   * `column` are server-chosen constants (never user input), so callers may
   * safely interpolate them into a SQL template; `id` remains a bound value.
   * @param scope {RevocationScope}
   * @returns {{ table: string, column: string, id: string }}
   */
  #revocationTable(scope: RevocationScope): {
    table: string
    column: string
    id: string
  } {
    if ('keystoreId' in scope) {
      return {
        table: 'revocations',
        column: 'keystore_id',
        id: scope.keystoreId
      }
    }
    return { table: 'space_revocations', column: 'space_id', id: scope.spaceId }
  }

  /**
   * Inserts a revocation record, create-only on
   * `(scope id, delegator, capability.id)`; a duplicate rejects with the
   * protocol's 409 (`DuplicateRevocationError`).
   *
   * A Space-scoped insert holds the Space's row lock and re-checks its
   * Metadata object (`#lockLiveContainers`), so a Space with none, or one a
   * Delete Space removed in between, is refused with `SpaceNotFoundError`
   * (404). A foreign-key violation (SQLSTATE `23503`) on the Space row maps to
   * the same 404.
   * @param options {object}
   * @param options.scope {RevocationScope}
   * @param options.record {RevocationRecord}
   * @returns {Promise<void>}
   */
  async insertRevocation({
    scope,
    record
  }: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void> {
    // `table` / `column` are internal constants, not user input; ids are bound.
    const { table, column, id } = this.#revocationTable(scope)
    const requestName = 'Revoke Capability'
    try {
      // Prune rows past their GC horizon while on this (rare) write path, so
      // the hot read path (`isRevoked`, consulted on every delegated-chain
      // verification) stays a single read-only SELECT -- the SQL analogue of
      // a TTL index. Table-wide on purpose: expired rows are dead weight
      // whichever scope they belong to.
      await this.#reader().query(
        `DELETE FROM ${table}
          WHERE expires IS NOT NULL AND expires <= $1`,
        [new Date().toISOString()]
      )
      const insert = async (queryable: Queryable): Promise<void> => {
        await queryable.query(
          `INSERT INTO ${table}
             (${column}, delegator, capability_id, record, expires)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            id,
            record.meta.delegator,
            record.capability.id,
            JSON.stringify(record),
            record.meta.expires ?? null
          ]
        )
      }
      if ('keystoreId' in scope) {
        await insert(this.#reader())
      } else {
        await this.#withTransaction(async client => {
          await this.#lockLiveContainers({
            client,
            spaceId: scope.spaceId,
            requestName
          })
          await insert(client)
        })
      }
    } catch (err) {
      if (err instanceof SpaceNotFoundError) {
        throw err
      }
      const code = pgErrorCode(err)
      if (code === UNIQUE_VIOLATION) {
        throw new DuplicateRevocationError()
      }
      if (code === FOREIGN_KEY_VIOLATION && 'spaceId' in scope) {
        throw new SpaceNotFoundError({ requestName })
      }
      throw new StorageError({ cause: err as Error })
    }
  }

  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the scope. A single read-only SELECT: rows past their
   * `meta.expires` GC horizon are filtered out in the predicate rather than
   * pruned here -- this runs on every delegated-chain verification, so it
   * must not write; `insertRevocation` prunes on the (rare) write path
   * instead. ISO-8601 strings compare correctly under the column's byte-order
   * collation.
   * @param options {object}
   * @param options.scope {RevocationScope}
   * @param options.capabilities {CapabilitySummary[]}
   * @returns {Promise<boolean>}
   */
  async isRevoked({
    scope,
    capabilities
  }: {
    scope: RevocationScope
    capabilities: CapabilitySummary[]
  }): Promise<boolean> {
    if (capabilities.length === 0) {
      return false
    }
    // `table` / `column` are internal constants, not user input; ids are bound.
    const { table, column, id } = this.#revocationTable(scope)
    const delegators = capabilities.map(entry => entry.delegator)
    const capabilityIds = capabilities.map(entry => entry.capabilityId)
    const { rows } = await this.#reader().query(
      `SELECT 1 FROM ${table}
        WHERE ${column} = $1
          AND (delegator, capability_id) IN
              (SELECT * FROM unnest($2::text[], $3::text[]))
          AND (expires IS NULL OR expires > $4)
        LIMIT 1`,
      [id, delegators, capabilityIds, new Date().toISOString()]
    )
    return rows.length > 0
  }

  // Export / import (spec "Export Space" / "Import Space")

  /**
   * Builds the filesystem-dialect sidecar object for a resource row (the
   * `.meta.<id>.json` shape), field order matching the filesystem writer so
   * archives stay as close to byte-compatible as jsonb round-tripping allows.
   * @param row {Omit<ResourceRow, 'content'>}
   * @returns {MetaSidecar}
   */
  #sidecarFor(row: Omit<ResourceRow, 'content'>): MetaSidecar {
    // The members both shapes lead with, in the filesystem writer's order.
    const common = {
      createdAt: row.created_at,
      ...stampOfRow(row),
      ...(row.created_by !== null && { createdBy: row.created_by }),
      generation: row.generation
    }
    if (row.deleted) {
      return {
        ...common,
        deleted: true,
        contentType: row.content_type,
        // A tombstone's writer-attribution label survives the round trip too
        // (spec "Writer attribution").
        ...(row.writer_id !== null && { writerId: row.writer_id })
      }
    }
    const meta = metaStampOfRow(row)
    return {
      ...common,
      ...(meta !== undefined && { meta }),
      ...(row.custom !== null && { custom: row.custom }),
      // The client-declared key epoch (the `key-epochs` feature) rides the
      // `.meta.` sidecar so it survives an export/import round trip.
      ...(row.epoch !== null && { epoch: row.epoch }),
      // The client-declared writer-attribution label (spec "Writer
      // attribution") rides the sidecar on the same terms.
      ...(row.writer_id !== null && { writerId: row.writer_id }),
      // The representation's content-type, as the filesystem writer records
      // it on every live sidecar.
      contentType: row.content_type
    }
  }

  /**
   * Exports the Space as a tar stream in the exact filesystem on-disk layout
   * (same file-name codecs, same manifest), so the archive imports into
   * either backend. Backend registration records are excluded (secret
   * material), exactly as on the filesystem.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.service] {ServiceDescription}   this server's Service
   *   Description, written into the archive as its `service.json` entry
   * @param [options.attestor] {ExportAttestor}   the server's signing
   *   identity; with one, the archive carries `provenance.jsonl` and the
   *   `did.jsonl` log snapshot
   * @returns {Promise<Readable>}   tar-stream pack
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
   * The Space's archive entry tree, read from the rows: metadata up front,
   * content bytes fetched one entry at a time while packing.
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
    const [
      spaceMetadata,
      { rows: policyRows },
      { rows: collectionRows },
      { rows: resourceRows },
      { rows: revocationRows },
      { rows: chunkRows }
    ] = await Promise.all([
      this.getSpaceMetadata({ spaceId }),
      // Live policies only: a tombstone does not travel.
      this.#reader().query<
        PolicyRow & { collection_id: string; resource_id: string }
      >(
        `SELECT collection_id, resource_id, ${POLICY_COLUMNS} FROM policies
            WHERE space_id = $1 AND NOT deleted`,
        [spaceId]
      ),
      this.#reader().query<
        MetadataRow<CollectionMetadata> &
          LogRow & { collection_id: string; deleted: boolean }
      >(
        `SELECT collection_id, deleted, ${METADATA_COLUMNS}, ${LOG_COLUMNS}
           FROM collections WHERE space_id = $1`,
        [spaceId]
      ),
      // Metadata only -- content bytes are fetched one resource at a time
      // while packing, so an export never holds the whole Space in memory.
      this.#reader().query<
        Omit<ResourceRow, 'content'> & {
          collection_id: string
          resource_id: string
        }
      >(
        `SELECT collection_id, resource_id, content_type, is_json,
                size_bytes, generation, updated_at, updated_at_counter,
                origin_id, meta_generation, meta_updated_at,
                meta_updated_at_counter, meta_origin_id, custom, epoch,
                writer_id, deleted, created_at, created_by
           FROM resources WHERE space_id = $1`,
        [spaceId]
      ),
      this.#reader().query<{
        delegator: string
        capability_id: string
        record: RevocationRecord
      }>(
        `SELECT delegator, capability_id, record FROM space_revocations
            WHERE space_id = $1`,
        [spaceId]
      ),
      // Chunk metadata only -- bytes are fetched one chunk at a time while
      // packing, so an export never holds a chunked Resource whole in memory.
      this.#reader().query<
        StampColumns & {
          collection_id: string
          resource_id: string
          chunk_index: number
          content_type: string
          generation: string
        }
      >(
        `SELECT collection_id, resource_id, chunk_index, content_type,
                generation, updated_at, updated_at_counter, origin_id
           FROM chunks WHERE space_id = $1
          ORDER BY collection_id, resource_id, chunk_index`,
        [spaceId]
      )
    ])
    if (!spaceMetadata) {
      throw new SpaceNotFoundError({ requestName: 'Export Space' })
    }

    // Assemble the per-entry file lists in the filesystem's shapes: files are
    // named by the shared codecs and sorted with localeCompare, matching the
    // filesystem's directory-listing sort.
    // A policy file is the filesystem backend's on-disk layout: the body
    // with its stamp members, and the generation embedded as `_generation`.
    const archivedPolicy = (row: PolicyRow): Buffer =>
      Buffer.from(
        policyFile({
          body: stampedPolicy({ body: row.policy!, stamp: stampOfRow(row) }),
          generation: row.generation
        })
      )
    const spacePolicy = policyRows.find(
      row => row.collection_id === '' && row.resource_id === ''
    )

    // The shared archive entry shapes (`@interop/space-archive`): a file entry carries
    // its bytes inline (the small JSON dot-files) or a lazy `read()` resolved at
    // pack time (a resource representation, and a chunk of a chunked Resource --
    // the `chunked-streams` feature), and a chunk directory is a nested
    // directory entry whose files follow the same rule. `name` is the entry's
    // sort key within its dir; a chunk directory sorts by its `.chunks.<encId>`
    // dir name.
    // Space-level dot-files are always small JSON, carried inline.
    // The Space Metadata entry is the shared `archivedSpaceMetadata`: the
    // filesystem backend's on-disk layout (the stamp members bare, the
    // generation embedded as `_generation`), so archives stay
    // interchangeable between the two backends, with the server-derived
    // `backends` listing added.
    const spaceFiles: ArchiveFile[] = [
      {
        name: spaceMetadataFileName(spaceId),
        bytes: await archivedSpaceMetadata({
          storage: this,
          spaceId,
          spaceMetadata,
          serverBackends
        })
      }
    ]
    if (spacePolicy) {
      spaceFiles.push({
        name: SPACE_POLICY_FILE_NAME,
        bytes: archivedPolicy(spacePolicy)
      })
    }

    const collectionsById = new Map<string, ArchiveEntry[]>()
    const filesFor = (collectionId: string): ArchiveEntry[] => {
      let files = collectionsById.get(collectionId)
      if (!files) {
        files = []
        collectionsById.set(collectionId, files)
      }
      return files
    }
    for (const row of collectionRows) {
      // A tombstone travels as its Metadata file directly in the Space
      // directory, with no Collection directory: `deleted: true`, the stamp
      // of the delete, and the generation embedded as `_generation`. Its
      // member rows went with the delete, so nothing else names its id.
      if (row.deleted) {
        spaceFiles.push({
          name: collectionMetadataFileName(row.collection_id),
          bytes: Buffer.from(
            JSON.stringify(
              embedMetadataValidator({
                body: collectionTombstoneBody(stampOfRow(row)),
                generation: row.meta_generation ?? undefined
              })
            )
          )
        })
        continue
      }
      const files = filesFor(row.collection_id)
      const stored = storedMetadataFromRow(row)
      if (stored !== undefined) {
        // The one Collection Metadata file: the whole merged object (the
        // configuration members beside `createdBy`, `createdAt`, the stamp
        // members, `custom` and `epoch`) with its generation embedded as
        // `_generation` (the filesystem backend's on-disk convention), so
        // archives stay interchangeable between the two backends. The local
        // validator segment is this server's own and does not travel.
        files.push({
          name: collectionMetadataFileName(row.collection_id),
          bytes: Buffer.from(
            JSON.stringify(
              embedMetadataValidator({
                body: stripMetadataValidator(stored),
                generation: stored.metaGeneration
              })
            )
          )
        })
      }
      // The governing history log, in the filesystem backend's on-disk shape.
      const log = storedLogFromRow(row)
      if (log !== undefined) {
        const { body, generation, ...stamp } = log
        files.push({
          name: collectionLogFileName(row.collection_id),
          bytes: Buffer.from(
            JSON.stringify({
              generation,
              ...stamp,
              body
            } satisfies StoredCollectionLog)
          )
        })
      }
    }
    for (const row of policyRows) {
      if (row.collection_id === '') {
        continue
      }
      // The Collection's own policy has a fixed name; a Resource policy is
      // keyed by the resource id under its own prefix.
      filesFor(row.collection_id).push({
        name:
          row.resource_id === ''
            ? COLLECTION_POLICY_FILE_NAME
            : resourcePolicyFileName(row.resource_id),
        bytes: archivedPolicy(row)
      })
    }
    for (const row of resourceRows) {
      const files = filesFor(row.collection_id)
      files.push({
        name: metaSidecarFileName(row.resource_id),
        bytes: Buffer.from(JSON.stringify(this.#sidecarFor(row)))
      })
      if (!row.deleted) {
        const resource = {
          collectionId: row.collection_id,
          resourceId: row.resource_id
        }
        files.push({
          name: fileNameFor({
            resourceId: row.resource_id,
            contentType: row.content_type
          }),
          read: () => this.#resourceContent({ spaceId, ...resource })
        })
      }
    }
    // Chunks (the `chunked-streams` feature): each chunked Resource contributes
    // one `.chunks.<encResourceId>/` subdirectory in its Collection dir, in the
    // exact filesystem-backend layout so an archive imports into either backend.
    // A chunk is stored there as a Resource keyed by its stringified index: an
    // `r.<index>.<encContentType>.<ext>` representation file (`fileNameFor`)
    // plus a `.meta.<index>.json` sidecar. Files within a chunk dir are
    // sorted by name (the filesystem's readdir sort). Rows arrive ordered by
    // `(collection, resource, index)`.
    const chunkDirsByResource = new Map<string, ArchiveFile[]>()
    for (const row of chunkRows) {
      const dirKey = `${row.collection_id}/${row.resource_id}`
      let chunkFiles = chunkDirsByResource.get(dirKey)
      if (!chunkFiles) {
        chunkFiles = []
        chunkDirsByResource.set(dirKey, chunkFiles)
        filesFor(row.collection_id).push({
          name: chunkDirName(row.resource_id),
          files: chunkFiles
        })
      }
      const chunkId = String(row.chunk_index)
      const chunk = {
        collectionId: row.collection_id,
        resourceId: row.resource_id,
        chunkIndex: row.chunk_index
      }
      chunkFiles.push({
        name: fileNameFor({
          resourceId: chunkId,
          contentType: row.content_type
        }),
        read: () => this.#chunkContent({ spaceId, ...chunk })
      })
      // The chunk-metadata sidecar (`.chunks.<encId>/.meta.<index>.json`) the
      // filesystem backend writes per chunk: the chunk's write stamp and
      // generation. The filesystem writes `createdAt` too, but this
      // backend's `chunks` table holds no creation time, so it emits none. An
      // import reads only the generation and re-stamps the chunk.
      chunkFiles.push({
        name: metaSidecarFileName(chunkId),
        bytes: Buffer.from(
          JSON.stringify({
            ...stampOfRow(row),
            generation: row.generation
          } satisfies WriteStamp & { generation: string })
        )
      })
    }
    for (const chunkFiles of chunkDirsByResource.values()) {
      chunkFiles.sort((left, right) => left.name.localeCompare(right.name))
    }

    // Space-scoped zcap revocations travel with the export as the archive's
    // `.revocations/` directory, named by the shared file-name codec so both
    // backends produce the same archive entries. Pretty-printed to match the
    // filesystem's stored records. No directory when the Space has none.
    const revocations: ArchiveFile[] = revocationRows
      .map(row => ({
        name: revocationFileName({
          delegator: row.delegator,
          capabilityId: row.capability_id
        }),
        bytes: Buffer.from(JSON.stringify(row.record, null, 2))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    // Top-level order: space-level files, collection dirs and the
    // revocations dir interleaved, sorted by name -- the same order the
    // filesystem's readdir+sort yields.
    const topLevel: ArchiveEntry[] = [
      ...spaceFiles,
      ...(revocations.length > 0
        ? [{ name: ARCHIVE_REVOCATIONS_DIR, files: revocations }]
        : []),
      ...[...collectionsById].map(([collectionId, files]) => ({
        name: collectionId,
        files: files.sort((a, b) => a.name.localeCompare(b.name))
      }))
    ].sort((a, b) => a.name.localeCompare(b.name))
    return topLevel
  }

  /**
   * Fetches one resource's content bytes for the export pack loop. A row
   * deleted or tombstoned between the metadata pass and this read (the export
   * is not one transaction, same as the filesystem's racy directory walk)
   * yields an empty body rather than failing the whole archive.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @returns {Promise<Buffer>}
   */
  async #resourceContent({
    spaceId,
    collectionId,
    resourceId
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<Buffer> {
    const { rows } = await this.#reader().query<{ content: Buffer | null }>(
      `SELECT content FROM resources
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
      [spaceId, collectionId, resourceId]
    )
    return rows[0]?.content ?? Buffer.alloc(0)
  }

  /**
   * Fetches one chunk's bytes for the export pack loop (the `chunked-streams`
   * feature). A chunk removed between the metadata pass and this read yields an
   * empty body rather than failing the whole archive, matching
   * `#resourceContent`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.chunkIndex {number}
   * @returns {Promise<Buffer>}
   */
  async #chunkContent({
    spaceId,
    collectionId,
    resourceId,
    chunkIndex
  }: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<Buffer> {
    const { rows } = await this.#reader().query<{ bytes: Buffer | null }>(
      `SELECT bytes FROM chunks
        WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3
          AND chunk_index = $4`,
      [spaceId, collectionId, resourceId, chunkIndex]
    )
    return rows[0]?.bytes ?? Buffer.alloc(0)
  }

  /**
   * Merges a PWS space-export tarball into an existing Space with the same
   * three-invariant pre-flight (per-entry 413, fail-closed 422 encryption
   * conformance, cumulative 507) and skip-not-overwrite merge semantics as
   * the filesystem backend -- including tombstone carry-over and "a tombstone
   * blocks resurrection". One strict improvement: the entire apply loop runs
   * in a single transaction, so a mid-import failure leaves the Space
   * untouched atomically.
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
    // Chunk entries (the `chunked-streams` feature): the plan carries each
    // chunk file (representation + optional sidecar) with its decoded
    // fields; the `chunks` table stores a chunk as one row, so merge the two
    // files of each chunk into a single row here.
    const chunkEntries = this.#mergeChunkEntries(collections)
    const { capacityBytes, maxCollectionsPerSpace } = this

    return this.#withTransaction(async client => {
      // The Space Metadata advisory lock first, ahead of the row lock as the
      // lock order requires (`#lockSpaceRow`): the restore below is a Space
      // Metadata write, and a concurrent `writeSpace` holds this lock while
      // it waits on the row this import is about to take. Without it the two
      // could deadlock, or the restore could land between that write's read
      // and its upsert and be overwritten.
      await this.#lockSpaceMetadata({ client, spaceId })
      // The destination Space must still have its Metadata object.
      await this.#lockLiveContainers({
        client,
        spaceId,
        requestName: 'Import Space'
      })
      // Serialize with concurrent writers on this Space for the duration of
      // the import: the usage counter row is the natural lock, and it is the
      // first lock of the backend-wide order (`#lockSpaceRow`), so an import
      // and an ordinary write queue behind one another instead of deadlocking.
      const { rows: spaceRows } = await client.query<{ usage_bytes: string }>(
        'SELECT usage_bytes FROM spaces WHERE space_id = $1 FOR UPDATE',
        [spaceId]
      )
      const currentUsage = Number(spaceRows[0]?.usage_bytes ?? 0)

      // One pass over the Space's Collections: Metadata object presence drives
      // both the pre-flight encryption resolution and the skip-or-create
      // decision in the apply loop. A tombstoned row has no Metadata object,
      // so it counts as "does not exist"; its stamp is held so a create over
      // it sorts above the delete.
      const { rows: metadataRows } = await client.query<
        StampColumns & {
          collection_id: string
          metadata: CollectionMetadata | null
          deleted: boolean
        }
      >(
        `SELECT collection_id, metadata, deleted, updated_at,
                updated_at_counter, origin_id
           FROM collections
          WHERE space_id = $1`,
        [spaceId]
      )
      const metadataById = new Map<string, CollectionMetadata | null>()
      const tombstoneStampById = new Map<string, WriteStamp>()
      for (const row of metadataRows) {
        if (row.deleted) {
          tombstoneStampById.set(row.collection_id, stampOfRow(row))
        } else {
          metadataById.set(row.collection_id, row.metadata)
        }
      }

      // Count quota: take the Space's existing Collection rows ONCE here, then
      // track a running total as the apply loop creates Collections, so an
      // import cannot push the Space past `maxCollectionsPerSpace`. Only a
      // brand-new Collection counts -- a re-imported existing id does not --
      // mirroring the per-create write-path guard without a COUNT query per
      // row. The transaction rolls the whole import back if the cap is
      // exceeded mid-apply. A tombstoned row does not count.
      let collectionRowCount = metadataById.size

      // Shared pre-flight over every staged body (`assertImportBodiesFit`):
      // the per-body 413 cap and the fail-closed encryption check, before
      // anything is written. Skips (existing ids) are counted conservatively
      // for the quota estimate, as on the filesystem. Chunks (the
      // `chunked-streams` feature) are opaque bytes -- no encryption-conformance
      // check applies -- but they count the same per-body 413 and the
      // (conservative) capacity pre-flight as Resource bodies, tallied after
      // every Collection because this backend merges each chunk's files into
      // one row up front.
      const incomingBytes = await assertImportBodiesFit({
        collections,
        existingCollection: collectionId =>
          metadataById.get(collectionId) ?? undefined,
        // Read per Collection the archive carries Resources into, since a
        // governing log is append-only and grows.
        existingCollectionLog: async collectionId => {
          const { rows } = await client.query<{ log_body: string | null }>(
            `SELECT log_body FROM collections
              WHERE space_id = $1 AND collection_id = $2`,
            [spaceId, collectionId]
          )
          return rows[0]?.log_body ?? undefined
        },
        assertUploadSize: uploadBytes => this.#assertUploadSize(uploadBytes),
        trailingChunkBodies: chunkEntries
      })
      // The cumulative quota (507) stays here: the headroom check is this
      // backend's own, against the transactional usage counter read above.
      if (
        capacityBytes !== undefined &&
        currentUsage + incomingBytes > capacityBytes
      ) {
        throw new QuotaExceededError({ spaceId, capacityBytes })
      }

      // An archived Space Metadata entry is 'skipped' until it is restored
      // below; an archive carrying none is 'absent'.
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
      const tallyPolicy = (created: boolean): void => {
        if (created) {
          stats.policiesCreated++
        } else {
          stats.policiesSkipped++
        }
      }

      // The archived Space Metadata object's user-writable members, applied
      // over the destination's stored object by the same write Update Space
      // Metadata makes (`name` restored, `type` checked against the
      // destination's), inside this transaction -- the filesystem backend's
      // restore goes through `writeSpace` the same way. Only when the caller
      // asked for it (the handler decides that on the invocation's authority).
      // `controller`, `createdBy`, and the members the server derives per read
      // stay the destination's. A Space with no stored object yet (a backend
      // driven outside a request) has nothing to apply them over.
      if (archivedSpaceMetadata && restoreSpaceMetadata) {
        const prior = await this.#readSpaceRow({ queryable: client, spaceId })
        if (prior) {
          await this.#writeSpaceRow({
            client,
            spaceId,
            spaceMetadata: restoredSpaceMetadata({
              prior: stripMetadataValidator(prior),
              archived: archivedSpaceMetadata
            }),
            prior
          })
          stats.spaceMetadata = 'restored'
        }
      }

      // Space-level policy: restore it when the destination has none. A
      // deleted policy's tombstone counts as one, so an import does not undo
      // the delete.
      if (spacePolicy) {
        tallyPolicy(
          await this.#importPolicy({ client, spaceId, imported: spacePolicy })
        )
      }

      let createdBytes = 0
      for (const {
        collectionId,
        collectionMetadata,
        collectionPolicy,
        collectionLog,
        resources,
        resourcePolicies,
        detachedResourcePolicies,
        resourceMetadata
      } of collections) {
        const collectionExisted = Boolean(metadataById.get(collectionId))
        if (collectionExisted) {
          stats.collectionsSkipped++
        } else {
          // A brand-new Collection counts against the cap, a create over a
          // tombstone included; upserting a Metadata object onto an existing
          // live row with NULL metadata does not add one, so it never trips
          // the limit.
          const isNewRow = !metadataById.has(collectionId)
          if (
            maxCollectionsPerSpace !== undefined &&
            isNewRow &&
            collectionRowCount >= maxCollectionsPerSpace
          ) {
            throw collectionQuotaExceeded(maxCollectionsPerSpace)
          }
          // Import restores the archived Collection Metadata object,
          // server-managed members (`createdBy`, `createdAt`) and annotations
          // (`custom`, `epoch`) included, under the archived generation, and
          // re-stamped by this store's clock: the archived stamp is read for
          // provenance only. This is only ever a create here (the branch
          // above skips existing Collections), so there is no prior object to
          // preserve anything from.
          const stamp = await this.#clock.mint({
            held: tombstoneStampById.get(collectionId)
          })
          const { body, generation } = restampImportedMetadata({
            metadata: collectionMetadata,
            stamp
          })
          await this.#upsertCollection({
            queryable: client,
            spaceId,
            collectionId,
            body,
            generation,
            stamp
          })
          if (isNewRow) {
            collectionRowCount++
          }
          metadataById.set(collectionId, collectionMetadata)
          // Its governing history log travels with a newly-created
          // Collection, re-stamped like the Collection; for an existing
          // (skipped) Collection it is left untouched, exactly as the
          // Metadata object and policy are.
          if (collectionLog) {
            await this.#applyImportedCollectionLog({
              client,
              spaceId,
              collectionId,
              logBytes: collectionLog
            })
          }
          stats.collectionsCreated++
        }

        // A collection-level policy travels with a newly-created collection;
        // for an existing (skipped) collection, leave its policy untouched.
        if (collectionPolicy) {
          tallyPolicy(
            !collectionExisted &&
              (await this.#importPolicy({
                client,
                spaceId,
                collectionId,
                imported: collectionPolicy
              }))
          )
        }

        // All ids the destination already holds for this Collection -- live
        // or tombstone, either blocks the import for its id ("a tombstone
        // blocks resurrection") -- in one query instead of one per resource.
        // Created ids are added as we go, so a duplicate id later in the same
        // archive is skipped rather than tripping the primary key.
        const { rows: existingIdRows } = await client.query<{
          resource_id: string
        }>(
          `SELECT resource_id FROM resources
            WHERE space_id = $1 AND collection_id = $2`,
          [spaceId, collectionId]
        )
        const existingResourceIds = new Set(
          existingIdRows.map(row => row.resource_id)
        )

        for (const { fileName, resourceId, body } of resources) {
          if (existingResourceIds.has(resourceId)) {
            stats.resourcesSkipped++
            // A resource-level policy travels with a newly-created resource.
            if (resourcePolicies.has(resourceId)) {
              stats.policiesSkipped++
            }
            continue
          }
          const { contentType } = parseResourceFileName(fileName)
          const metadataBytes = resourceMetadata.get(resourceId)
          await this.#insertImportedResource({
            client,
            spaceId,
            collectionId,
            resourceId,
            contentType,
            body,
            sidecar: metadataBytes && parseSidecarBytes(metadataBytes)
          })
          existingResourceIds.add(resourceId)
          createdBytes += body.length
          stats.resourcesCreated++

          // A policy record the destination already holds there, a
          // tombstone included, is kept.
          const resourcePolicy = resourcePolicies.get(resourceId)
          if (resourcePolicy) {
            tallyPolicy(
              await this.#importPolicy({
                client,
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
        for (const [resourceId, resourcePolicy] of detachedResourcePolicies) {
          tallyPolicy(
            await this.#importPolicy({
              client,
              spaceId,
              collectionId,
              resourceId,
              imported: resourcePolicy
            })
          )
        }

        // Carry tombstones: an orphan `.meta.` sidecar that is a tombstone
        // (`deleted: true`) re-creates the tombstone row; a non-tombstone
        // orphan sidecar is anomalous and skipped. Merge semantics match
        // resources: anything the destination already has is left untouched.
        const importedResourceIds = new Set(
          resources.map(resource => resource.resourceId)
        )
        for (const [resourceId, metadataBytes] of resourceMetadata) {
          if (importedResourceIds.has(resourceId)) {
            continue
          }
          const sidecar = parseSidecarBytes(metadataBytes)
          if (sidecar?.deleted !== true) {
            continue
          }
          if (existingResourceIds.has(resourceId)) {
            stats.resourcesSkipped++
            continue
          }
          await this.#insertImportedResource({
            client,
            spaceId,
            collectionId,
            resourceId,
            contentType: sidecar.contentType ?? 'application/octet-stream',
            body: null,
            sidecar
          })
          existingResourceIds.add(resourceId)
          stats.resourcesCreated++
        }
      }

      // Chunks (the `chunked-streams` feature): restore each archived chunk
      // skip-not-overwrite, after the Resource apply loop so a chunk's parent
      // Resource row already exists in this transaction (the foreign key
      // requires it). An orphan chunk -- one whose parent is absent or a
      // tombstone -- is skipped rather than resurrected. Existing chunk rows are
      // left untouched.
      let createdChunkBytes = 0
      // A chunk's parent-liveness is a property of its Resource, not its index:
      // cache it per (collectionId, resourceId) so a Resource with many chunks
      // is probed once rather than once per chunk. The Resource apply loop above
      // has fully settled, so a parent's row is stable for this pass.
      const parentLive = new Map<string, boolean>()
      for (const chunk of chunkEntries) {
        const parentKey = `${chunk.collectionId}/${chunk.resourceId}`
        let live = parentLive.get(parentKey)
        if (live === undefined) {
          const { rows: parentRows } = await client.query<{ deleted: boolean }>(
            `SELECT deleted FROM resources
              WHERE space_id = $1 AND collection_id = $2 AND resource_id = $3`,
            [spaceId, chunk.collectionId, chunk.resourceId]
          )
          const parent = parentRows[0]
          live = parent !== undefined && !parent.deleted
          parentLive.set(parentKey, live)
        }
        if (!live) {
          continue
        }
        // The chunk's generation comes from its archived `.meta.<index>.json`
        // sidecar; an archive without one mints a fresh generation, the same
        // fresh-write default as a Resource restored without a sidecar. Its
        // stamp is minted by this store's clock either way: an archived stamp
        // is not kept. `ON CONFLICT DO NOTHING RETURNING size` folds the
        // skip-not-overwrite check and the insert into one query: a row comes
        // back only when this INSERT actually created the chunk, so an
        // existing chunk adds nothing to the usage delta.
        const stamp = await this.#clock.mint()
        const { rows: insertedRows } = await client.query<{ size: string }>(
          `INSERT INTO chunks (
             space_id, collection_id, resource_id, chunk_index,
             content_type, bytes, size, generation, updated_at,
             updated_at_counter, origin_id, digest
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT DO NOTHING
           RETURNING size`,
          [
            spaceId,
            chunk.collectionId,
            chunk.resourceId,
            chunk.chunkIndex,
            chunk.contentType,
            chunk.body,
            chunk.body.length,
            resolveGeneration(chunk.generation),
            ...stampValues(stamp),
            // The digest of the bytes written, whatever the archive carries.
            await contentDigestOf(chunk.body)
          ]
        )
        if (insertedRows.length > 0) {
          createdChunkBytes += Number(insertedRows[0]!.size)
        }
      }

      const createdTotalBytes = createdBytes + createdChunkBytes
      // The pre-flight was conservative (it counted skips too), so the
      // actual created total always fits; apply it unguarded.
      await this.#applyUsageDelta({
        client,
        spaceId,
        delta: createdTotalBytes
      })

      // The archive's Collection tombstones, each written only when this
      // Space holds no row under its id, live or tombstoned: a tombstone
      // never deletes or alters a Collection the destination holds. It keeps
      // the archived generation and is re-stamped by this store's clock.
      for (const { collectionId, generation } of collectionTombstones) {
        await client.query(
          `INSERT INTO collections (space_id, collection_id, metadata, deleted,
                                    meta_generation, meta_local, updated_at,
                                    updated_at_counter, origin_id)
           VALUES ($1, $2, NULL, true, $3, 0, $4, $5, $6)
           ON CONFLICT (space_id, collection_id) DO NOTHING`,
          [
            spaceId,
            collectionId,
            generation,
            ...stampValues(await this.#clock.mint())
          ]
        )
      }

      // The archive's Space-scoped zcap revocations are not part of the
      // plan. The handler verifies and installs them through
      // `insertRevocation` once this transaction has committed, since a chain
      // may carry a link signed by a `did:webvh` whose log the archive
      // restores (`lib/importRevocations.ts`).

      return stats
    })
  }

  /**
   * Restores an archived Collection history log (the filesystem backend's
   * `.collectionlog.<id>.json` shape, already checked by the plan builder)
   * into the `log_*` columns: its body and generation, under a stamp minted
   * by this store's clock in place of the archived one.
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.logBytes {Buffer}
   * @returns {Promise<void>}
   */
  async #applyImportedCollectionLog({
    client,
    spaceId,
    collectionId,
    logBytes
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    logBytes: Buffer
  }): Promise<void> {
    const { body, generation, ...stamp } = restampImportedLog({
      bytes: logBytes,
      stamp: await this.#clock.mint()
    })
    // The imported log takes this Collection's next feed position, as a log
    // write does: an archive carries no positions.
    await this.#storeLog({
      client,
      spaceId,
      collectionId,
      body,
      generation,
      stamp,
      advanceLocal: false
    })
  }

  /**
   * Inserts one archived resource (or orphan tombstone) row for the import
   * apply loop. `createdAt`, the generations, `createdBy`, `custom`, `epoch`
   * and `writerId` come from the archive's sidecar when present, and its
   * stamps (the content record's, and the `/meta` record's when it has one)
   * are minted afresh by this store's clock, as the filesystem backend
   * re-stamps an imported sidecar; the archived stamps are read for
   * provenance only. An archive resource without a sidecar is treated as a
   * fresh first write on this backend (a new generation and stamp, no
   * `createdBy`).
   * @param options {object}
   * @param options.client {pg.PoolClient}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.contentType {string}
   * @param options.body {Buffer|null}   `null` re-creates a tombstone
   * @param [options.sidecar] {MetaSidecar}
   * @returns {Promise<void>}
   */
  async #insertImportedResource({
    client,
    spaceId,
    collectionId,
    resourceId,
    contentType,
    body,
    sidecar
  }: {
    client: pg.PoolClient
    spaceId: string
    collectionId: string
    resourceId: string
    contentType: string
    body: Buffer | null
    sidecar: MetaSidecar | undefined
  }): Promise<void> {
    const deleted = body === null
    // A feed position is this server's own fact: any the archived sidecar
    // carries is ignored, and the row takes this Collection's next one. The
    // import holds the Space row, and the Collection row exists by now.
    const feedPosition = await this.#takeFeedPosition({
      client,
      spaceId,
      collectionId
    })
    const mint = () => this.#clock.mint()
    let restamped: MetaSidecar
    if (sidecar === undefined) {
      const stamp = await mint()
      restamped = {
        createdAt: stamp.updatedAt,
        ...stamp,
        generation: newGeneration(),
        contentType
      }
    } else {
      restamped = await restampImportedSidecar({ sidecar, mint })
    }
    // A tombstone carries no `/meta` record, even if its archived sidecar
    // claims one.
    const meta = deleted ? undefined : restamped.meta
    // The digest of the bytes written, whatever the archive carries
    // (`restampImportedSidecar` dropped an archived one). An imported
    // tombstone has no bytes, so it records none.
    const digest = body === null ? null : await contentDigestOf(body)
    await client.query(
      `INSERT INTO resources (
         space_id, collection_id, resource_id, content_type, content,
         is_json, size_bytes, generation, updated_at, updated_at_counter,
         origin_id, meta_generation, meta_updated_at,
         meta_updated_at_counter, meta_origin_id, custom, deleted,
         created_at, created_by, epoch, writer_id, feed_position, digest
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16::jsonb, $17, $18, $19, $20, $21, $22, $23)`,
      [
        spaceId,
        collectionId,
        resourceId,
        contentType,
        body,
        isJsonContentType(contentType),
        body?.length ?? 0,
        restamped.generation,
        ...stampValues(restamped),
        meta?.generation ?? null,
        meta?.updatedAt ?? null,
        meta?.updatedAtCounter ?? null,
        meta?.originId ?? null,
        restamped.custom !== undefined
          ? JSON.stringify(restamped.custom)
          : null,
        deleted,
        restamped.createdAt,
        restamped.createdBy ?? null,
        // Restore the client-declared key epoch (the `key-epochs` feature) from
        // the archived sidecar; a tombstone or an unstamped Resource has none.
        restamped.epoch ?? null,
        // Restore the client-declared writer-attribution label (spec "Writer
        // attribution") the same way.
        restamped.writerId ?? null,
        feedPosition ?? null,
        digest
      ]
    )
  }

  /**
   * Reduces the import plan's per-Collection chunk files (the `chunked-streams`
   * feature) into one merged chunk row per (collectionId, resourceId,
   * chunkIndex): the `chunks` table stores a chunk as a single row, whereas the
   * plan (and the filesystem backend's on-disk layout) keeps each chunk as an
   * `r.<index>...` representation paired with an optional `.meta.<index>.json`
   * sidecar. `buildImportPlan` already validated the ids and dropped any
   * non-canonical index, so this only merges the two files of each chunk; a
   * chunk that carries only a sidecar (no representation) is dropped (a chunk
   * keeps no tombstone). The filesystem backend writes the files verbatim, so
   * this reduction lives here.
   * @param collections {ImportPlanCollection[]}
   * @returns {Array<{ collectionId: string, resourceId: string, chunkIndex:
   *   number, contentType: string, body: Buffer, generation?: string }>}
   */
  #mergeChunkEntries(collections: ImportPlanCollection[]): Array<{
    collectionId: string
    resourceId: string
    chunkIndex: number
    contentType: string
    body: Buffer
    generation?: string
  }> {
    // Accumulate the representation and the sidecar of each chunk under one
    // key, then emit only the chunks that carry a representation.
    const staged = new Map<
      string,
      {
        collectionId: string
        resourceId: string
        chunkIndex: number
        contentType?: string
        body?: Buffer
        generation?: string
      }
    >()
    for (const { collectionId, chunkFiles } of collections) {
      for (const chunkFile of chunkFiles) {
        const { resourceId, chunkIndex } = chunkFile
        const key = `${collectionId}/${resourceId}/${chunkIndex}`
        const slot = staged.get(key) ?? { collectionId, resourceId, chunkIndex }
        // A representation file carries a `contentType` (and its bytes); a
        // sidecar carries only the generation.
        if (chunkFile.contentType !== undefined) {
          slot.contentType = chunkFile.contentType
          slot.body = chunkFile.body
        } else if (chunkFile.generation !== undefined) {
          slot.generation = chunkFile.generation
        }
        staged.set(key, slot)
      }
    }

    const merged: Array<{
      collectionId: string
      resourceId: string
      chunkIndex: number
      contentType: string
      body: Buffer
      generation?: string
    }> = []
    for (const slot of staged.values()) {
      if (slot.body === undefined) {
        // A sidecar with no paired representation is not a valid chunk.
        continue
      }
      merged.push({
        collectionId: slot.collectionId,
        resourceId: slot.resourceId,
        chunkIndex: slot.chunkIndex,
        contentType: slot.contentType ?? 'application/octet-stream',
        body: slot.body,
        generation: slot.generation
      })
    }
    return merged
  }
}
