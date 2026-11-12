/**
 * Shared domain types for the PWS server.
 *
 * Re-exports the relevant `@interop/data-integrity-core` types (DIDs, zCaps,
 * document-loader, verifier / key material) and the shared PWS wire model from
 * `@interop/storage-core` so the rest of the codebase imports them from a
 * single place, and defines the server-local domain shapes (the parsed-zcap
 * request shape, the transport-neutral resource input, the get-resource result)
 * plus the `StorageBackend` contract.
 *
 * Also augments Fastify's types: `FastifyInstance.serverUrl` (set by
 * `fastify.decorate` in plugin.ts, read in handlers via `request.server`) and
 * `FastifyRequest.zcap` (set by the `parseAuthHeaders` hook).
 */
// Pull in @fastify/multipart's `FastifyRequest.file()` augmentation program-wide
// (the request layer calls `request.file()` without importing the plugin
// directly).
import type { Readable } from 'node:stream'
import type { ArchiveEntry } from '@interop/space-archive'
import type {} from '@fastify/multipart'
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import type { ServerBackends } from './lib/serverBackends.js'
import type {
  IDID,
  IVerificationMethod,
  IMultikeyMethod,
  IZcap,
  IRootZcap,
  IDelegatedZcap,
  IVerifier,
  IPublicMultikey,
  IMultikeyDocument,
  IVerificationKeyPair2020
} from '@interop/data-integrity-core'
// Loader types are not re-exported from the package root (its index omits
// ./Loader); reach them via the ./loader subpath export.
import type {
  IRemoteDocument,
  IDocumentLoader
} from '@interop/data-integrity-core/loader'

import type { EtagValidator, HeldValidators } from './lib/etag.js'
import type { ServerSigningKey } from './lib/serverIdentity.js'
import type { PeerWebvhResolver } from './lib/peerWebvh.js'
import type { ReplicationManager } from './sync/replication.js'
import type { ExportAttestor } from './lib/exportProvenance.js'
import type { ImportPlan } from './lib/importTar.js'
import type { ApplyResult } from './lib/replicaApply.js'
import type {
  BlindedIndexQuery,
  BlindedIndexQueryPage
} from './lib/blindedIndex.js'
import type {
  EqualityQuery,
  EqualityQueryPage,
  EqualityCandidate,
  EqualityValue,
  NormalizedIndexDeclaration
} from './lib/equalityIndex.js'

// The shared PWS wire model now lives in `@interop/storage-core`. Import the
// shapes referenced by the `StorageBackend` contract below, and re-export the
// whole data-model surface so the rest of the server keeps importing it from
// this one module.
import type {
  SpaceMetadata,
  CollectionsList,
  CollectionResourcesList,
  ResourceMetadata,
  ResourceMetadataCustom,
  CollectionMetadata,
  BackendDescriptor,
  BackendConnectionInput,
  BackendUsage,
  ImportStats,
  PolicyDocument,
  PolicyTombstone,
  ServiceDescription,
  ServiceDescriptionVersionEntry,
  WriteStamp,
  ResourceMetaStamp,
  ReplicaRegistration,
  ReplicaCollectionStatus
} from '@interop/storage-core'

// Surface the blinded-index query shapes referenced by the `StorageBackend`
// contract (`queryByBlindedIndex`) from this one module.
export type { BlindedIndexQuery, BlindedIndexQueryPage }

// Surface the equality-index query shapes referenced by the `StorageBackend`
// contract (`queryByEquality` / `findEqualityUniqueViolation`) from this one
// module, alongside the blinded-index ones.
export type {
  EqualityQuery,
  EqualityQueryPage,
  EqualityCandidate,
  EqualityValue,
  NormalizedIndexDeclaration
}

// Surface the reused @interop/data-integrity-core types from this one module.
export type {
  IDID,
  IVerificationMethod,
  IMultikeyMethod,
  IZcap,
  IRootZcap,
  IDelegatedZcap,
  IVerifier,
  IPublicMultikey,
  IMultikeyDocument,
  IVerificationKeyPair2020,
  IRemoteDocument,
  IDocumentLoader
}

// Re-export the shared PWS wire model from `@interop/storage-core`.
export type {
  SpaceMetadata,
  BackendReference,
  SpaceSummary,
  SpaceListing,
  CollectionSummary,
  CollectionTombstoneSummary,
  CollectionsList,
  ResourceSummary,
  CollectionResourcesList,
  CollectionIndexDeclaration,
  CollectionEncryption,
  CollectionEncryptionEpoch,
  CollectionEncryptionRecipient,
  CollectionRevisions,
  ResourceMetadata,
  ResourceMetadataCustom,
  CollectionMetadata,
  BackendDescriptor,
  BackendConnectionPublic,
  BackendConnectionInput,
  BackendRegistration,
  BackendState,
  StorageLimit,
  CollectionUsage,
  BackendUsage,
  SpaceQuotaReport,
  PolicyDocument,
  PolicyTombstone,
  ImportStats,
  Action,
  ActionInput,
  LinkSet,
  LinkSetEntry,
  ServiceDescription,
  ServiceDescriptionVersionEntry,
  PwsVersionEntry,
  AuthzProfileVersionEntry,
  WriteStamp,
  ResourceMetaStamp,
  ReplicaRegistration,
  ReplicaSummary,
  ReplicaRole,
  ReplicaStatus,
  ReplicaCollectionStatus,
  ReplicaStallReason,
  ReplicaListing
} from '@interop/storage-core'

/**
 * The Encrypted Collections profile's version entry in a `ServiceDescription`
 * (profile "The version entry"). Its sibling entries, `PwsVersionEntry` and
 * `AuthzProfileVersionEntry`, are owned by `@interop/storage-core`; this one
 * lives here until that package carries it too.
 *
 * - `features` -- the profile's optional affordances this server serves, as
 *   listed by `ENCRYPTED_COLLECTIONS_FEATURES` in `serviceDescription.ts`.
 */
export interface EncryptedCollectionsVersionEntry extends ServiceDescriptionVersionEntry {
  features?: string[]
}

/**
 * The stored parts of a record's `ETag` validator a read result carries: the
 * record's `generation` and the write stamp of its last write (see
 * `lib/etag.ts`). The request layer derives the `ETag` from them
 * (`etagOf`).
 */
export type RecordValidatorParts = { generation?: string } & Partial<WriteStamp>

/**
 * Return shape of `getResource()`: the byte stream and its content-type,
 * beside the content record's validator parts.
 */
export interface ResourceResult extends RecordValidatorParts {
  resourceStream: Readable
  /** resolved content-type of the stored bytes */
  storedResourceType: string
}

/**
 * Return shape of `getChunkMetadata()` (the `chunked-streams` feature): a
 * chunk's stored content-type / size, beside its own validator parts -- the
 * HEAD payload headers.
 */
export interface ChunkMetadata extends RecordValidatorParts {
  contentType: string
  size: number
}

/**
 * Return shape of `listChunks()` (the `chunked-streams` feature): a Resource's
 * stored chunks in ascending `index` order (the discovery/reassembly listing),
 * with their `count`. `count` is the number of chunks listed, not their total
 * byte size. Each entry's `etag` is the quoted strong validator the chunk's
 * own `GET` and `HEAD` answer with, and the one its `GET` answers 304 against
 * under `If-None-Match`, so a client can pin a `DELETE` of a listed chunk with
 * `If-Match`, or read it conditionally, without a `HEAD` per chunk.
 */
export interface ChunkListing {
  count: number
  chunks: Array<{
    index: number
    size: number
    contentType: string
    etag: string
  }>
}

/**
 * Transport-neutral input to `writeResource`. The request layer resolves a
 * Fastify request into one of these shapes (see `resolveResourceInput` in
 * requests/resourceInput.ts) so that storage backends never depend on Fastify:
 * - `kind: 'json'` carries the parsed JSON value in `data`.
 * - `kind: 'binary'` carries a readable byte stream — a raw blob body, or the
 *   file extracted from a multipart upload. `declaredBytes` is the up-front size
 *   when known, used for an early quota pre-flight. A raw stream body takes it
 *   from `Content-Length` and leaves it absent when that header is missing or
 *   malformed (the backend's streaming guard then enforces the limit). A
 *   buffered body carries its exact length. That covers a `text/plain` string
 *   and a multipart file part, which the request layer drains into memory
 *   before handing it over.
 *
 * In both cases `contentType` is the content-type the bytes are stored under.
 */
export type ResourceInput =
  | { kind: 'json'; contentType: string; data: unknown }
  | {
      kind: 'binary'
      contentType: string
      stream: Readable
      declaredBytes?: number
    }

/**
 * The parsed auth headers attached to `request.zcap` by the `parseAuthHeaders`
 * hook. `headers` is the signed-headers list string (not the request headers
 * object); `created` / `expires` are stringified unix timestamps.
 */
export interface ParsedZcap {
  keyId: string
  headers: string
  signature: string
  created: string
  expires: string
  /** the raw `Capability-Invocation` header value */
  invocation: string
  /** the raw `Digest` header value (absent on bodyless requests) */
  digest?: string
}

/**
 * The full persisted record for a registered `external` backend (spec
 * "Backends"). Secret-bearing -- its `connection` carries the write-side grant
 * material -- so it is **never** serialized to a client: only the sanitized
 * `BackendDescriptor` projection (`sanitizeBackendRecord` in `lib/backends.ts`)
 * is. Held in usable (plaintext, this increment) form because the server is the
 * token custodian; the read/write split is enforced by `getBackend` being the
 * one storage method that returns this shape.
 */
export type StoredBackendRecord = BackendDescriptor & {
  managedBy: 'external'
  provider: string
  connection: BackendConnectionInput
}

/**
 * A WebKMS keystore configuration (the `/kms` facet).
 * The wire shape is protocol-fixed by `@interop/webkms-client`, minus the
 * deliberately-dropped `meterId` / `ipAllowList` fields. Stored verbatim,
 * full-URL `id` included, so the sequence-gated update can round-trip the
 * config unchanged; the storage key is the id's last URL segment (the
 * server-generated local id).
 */
export interface KeystoreConfig {
  /** full keystore URL (`<serverUrl>/kms/keystores/<localId>`), server-assigned on create */
  id: string
  /** the DID that controls the keystore (authorizes every invocation on it) */
  controller: IDID
  /** config revision: must be 0 on create, exactly previous+1 on update */
  sequence: number
  /** opaque KMS module alias, echoed back; this server hard-wires 'local-v1' */
  kmsModule: string
}

/**
 * The full serialized form of a WebKMS-held key, INCLUDING its secret material
 * (`privateKeyMultibase` for the asymmetric pairs, `secret` for the symmetric
 * keys) -- the `key` unit of a {@link KmsKeyRecord}. Field names are
 * protocol-fixed by the webkms per-type key generators. The
 * `controller` is deliberately NOT part of it: it is always read from the live
 * keystore config at description time, so a controller change takes effect
 * immediately.
 */
export interface KmsStoredKey {
  '@context': string
  /** full key URL (`<keystoreId>/keys/<localId>`), server-assigned on generate */
  id: string
  /** the webkms key type (e.g. `Ed25519VerificationKey2020`) */
  type: string
  publicKeyMultibase?: string
  privateKeyMultibase?: string
  /** symmetric key material (HMAC / AES-KW), base64url */
  secret?: string
  /** per-key invocation chain bound, enforced at operation time */
  maxCapabilityChainLength?: number
  /** verbatim description `id` override (e.g. a did:key or did:web URL) */
  publicAlias?: string
  /** description `id` template, expanded against the key description */
  publicAliasTemplate?: string
  /**
   * At-rest ONLY: present in place of the secret fields (`privateKeyMultibase`
   * / `secret`) when the record was written under a configured record KEK
   * (`KMS_RECORD_KEK`; see `lib/kmsRecordCipher.ts`). The in-memory
   * `KmsStoredKey` the KMS module operates on is always the DECRYPTED form --
   * the decrypt seam (`decryptKeyRecord`) strips this envelope and restores the
   * secret fields before any operation reads the key. A plaintext record (the
   * default / unconfigured deployment) never carries it.
   */
  encrypted?: KmsEncryptedEnvelope
}

/**
 * The at-rest envelope that replaces the secret-bearing fields of a stored
 * key's `key` when record encryption is enabled (`KMS_RECORD_KEK`; see
 * `lib/kmsRecordCipher.ts`). A fresh per-record content-encryption key (CEK,
 * `A256GCM`) encrypts the serialized secret subset; the CEK is wrapped
 * (`A256KW`) under the config-supplied KEK named by `kekId` -- the rotation
 * seam: a record keeps the `kekId` it was written under, so a rotated-in KEK
 * never forces a rewrite. Secrets never crossed the wire and still don't: this
 * shape lives only on disk, never in a client projection.
 */
export interface KmsEncryptedEnvelope {
  /** id of the KEK the CEK was wrapped under (`RecordKek.id`) */
  kekId: string
  /**
   * General JWE (JSON serialization): `A256GCM` content encryption with the
   * CEK wrapped `A256KW` under the KEK. The `protected` header is the JWE AAD.
   */
  jwe: {
    protected: string
    recipients: Array<{
      header?: Record<string, unknown>
      encrypted_key: string
    }>
    iv: string
    ciphertext: string
    tag: string
  }
  /** the secret-subset serialization inside the JWE (only `json` this increment) */
  encoding: 'json'
}

/**
 * A record-encryption key-encryption key (KEK): a raw AES-256 key plus its
 * derived, non-secret id (`RecordKek.id`, a one-way hash of the key material,
 * safe to store per record). Held only in process memory (config env), never in
 * the data tree.
 */
export interface RecordKek {
  id: string
  key: Buffer
}

/**
 * The at-rest key-record KEK registry (config `KMS_RECORD_KEK` /
 * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`): every KEK available to UNWRAP a
 * record (keyed by `RecordKek.id`) plus `currentKekId`,
 * the KEK that WRAPS new records. `currentKekId: null` disables encryption --
 * new records are written plaintext -- while previously registered KEKs stay
 * available for decrypt. Rotation is a config change (register a new KEK, repoint
 * `currentKekId`), never a schema migration.
 */
export interface KmsRecordKekRegistry {
  keks: Map<string, RecordKek>
  currentKekId: string | null
}

/**
 * A stored WebKMS key record (the `/kms` facet), a
 * `{keystoreId, localId, meta, key}` shape unique on `(keystoreId, localId)`.
 * Secret-bearing -- `key` carries the full serialized key material -- so a
 * record is **never** serialized to a client: only the sanitized key-description
 * projection built by the KMS module is. The storage layer treats the record as
 * an opaque unit. At rest, `key`'s secret fields are stored plaintext by default
 * or, when `KMS_RECORD_KEK` is configured, replaced by a `key.encrypted`
 * envelope (see `lib/kmsRecordCipher.ts`); either way the in-memory record the
 * KMS module operates on is the decrypted form.
 */
export interface KmsKeyRecord {
  /** the owning keystore's local id */
  keystoreId: string
  /** the key's server-generated local id (the last segment of `key.id`) */
  localId: string
  /** server-managed timestamps (ISO 8601) */
  meta: { created: string; updated: string }
  key: KmsStoredKey
}

/**
 * The public key-description projection of a KMS-held key, as returned by
 * `GenerateKeyOperation` and `GET <keyId>` (never any secret field). Its `id`
 * is the key URL, or the `publicAlias` / expanded `publicAliasTemplate` when
 * one was set at generate time; `controller` is the live keystore controller.
 */
export interface KmsKeyDescription {
  '@context': string
  id: string
  type: string
  publicKeyMultibase?: string
  controller: IDID
}

/**
 * The object a revocation aggregates under, and the unit a revocation lookup
 * is scoped to: a keystore (the `/kms` route family) or a Space (the PWS route
 * families). A revocation stored under one scope has no effect on the other --
 * a chain rooted in a Space is only ever inspected against that Space's store.
 */
export type RevocationScope = { keystoreId: string } | { spaceId: string }

/**
 * A stored zcap revocation, a `{capability, meta}` record. Unique on
 * `(delegator, capability.id)` within
 * its scope (the keystore or Space it is stored under); `meta.expires` is the
 * record's own garbage-collection horizon -- one day past the capability's
 * `expires`, after which the capability is rejected on expiry alone and the
 * record is prunable (the one-day margin covers clock-skew grace periods).
 */
export interface RevocationRecord {
  /** the full revoked capability, stored verbatim */
  capability: { id: string; expires?: string; [key: string]: unknown }
  meta: {
    /** the party that delegated the revoked capability (its proof creator) */
    delegator: string
    /**
     * the root object the revocation aggregates under (the keystore URL, or
     * the Space URL for a WAS-route revocation)
     */
    rootTarget: string
    /** server-managed creation timestamp (ISO 8601) */
    created: string
    /** GC horizon (ISO 8601); absent when the capability never expires */
    expires?: string
  }
}

/**
 * The `(capabilityId, delegator)` pair identifying one delegated capability in
 * a chain for a revocation-store lookup.
 */
export interface CapabilitySummary {
  capabilityId: string
  delegator: string
}

/**
 * A backend-adapter factory: given a registered (secret-bearing)
 * `StoredBackendRecord`, a logger, and the hosting server's origin id, returns
 * the live `StorageBackend` that speaks to that provider. The adapter exposes
 * that `originId` as its own and mints no stamps of its own. The teaching
 * server's adapter strategy is Layer 3 (not spec), so this type is
 * server-local. Keyed by `record.provider` in the `BackendProviderRegistry`.
 */
export type BackendProvider = (
  record: StoredBackendRecord,
  options: { logger: FastifyBaseLogger; originId: string }
) => StorageBackend

/** The injected provider-adapter registry, keyed by `record.provider`. */
export type BackendProviderRegistry = Map<string, BackendProvider>

/**
 * The persistence contract a storage backend implements (currently
 * `FileSystemBackend`; the port is designed to admit additional adapters). The
 * active backend is injected into the Fastify instance via
 * `createApp({ backend })` and read in handlers as `request.server.storage`.
 *
 * Invariants:
 * - The getters resolve to a falsy value (not throw) when the target is absent;
 *   callers test `if (!description)` and translate that into a 404.
 * - Write methods are upserts (create if absent, overwrite if present). The
 *   Resource and Metadata writes resolve what the write left, read inside its
 *   critical section, and the request layer answers from it.
 * - Delete methods are idempotent and resolve once the target is gone.
 * - Resources are identified by `resourceId` alone within a Collection; a
 *   Resource has exactly one current representation. `writeResource` replaces
 *   any existing representation, including one previously stored under a
 *   different content-type. `getResource`'s `contentType` is an advisory hint:
 *   single-representation backends return the one representation regardless, and
 *   the stored content-type comes back in `ResourceResult.storedResourceType`.
 *   Where the content-type lives is an adapter detail (filename segment /
 *   map-value field / future SQL column).
 *
 * Note: `exportSpace` resolves a Node `Readable`. The archive codec
 * (`@interop/space-archive`) is isomorphic and resolves a streamx-based
 * tar-stream `Pack`; each backend wraps it with `Readable.from` before
 * returning it.
 */
/**
 * The out-of-band `ETag` validator parts a stored Space or Collection Metadata
 * object carries beside its wire body: the generation minted by the record's
 * first write and kept for its life, and the local segment (`metaLocal`), a
 * counter this server advances when the served object changes through a
 * derived member and resets to 0 on every stamped write. The rest of the
 * validator is the write stamp, which the body carries as wire members
 * (`updatedAt`, `updatedAtCounter`, `originId`). One validator covers the
 * whole object -- configuration and annotation writes alike. The handler
 * strips these two from the wire body and sets the `ETag` header from them
 * and the stamp.
 */
export interface MetadataValidatorParts {
  metaGeneration?: string
  metaLocal?: number
}

/**
 * A stored Collection Metadata object as the backends surface it: the merged
 * wire body (configuration members beside `createdAt`, `updatedAt`, `custom`,
 * `epoch`) plus the out-of-band validator parts.
 */
export type StoredCollectionMetadata = CollectionMetadata &
  MetadataValidatorParts

/**
 * A Collection tombstone as a backend reads it back. Delete Collection
 * leaves the Collection Metadata record in place marked `deleted`, keeping
 * the generation (`metaGeneration`) and taking the delete's write stamp.
 * Nothing else of the old body is kept.
 */
export type StoredCollectionTombstone = {
  deleted: true
  metaGeneration?: string
} & WriteStamp

/**
 * What `deleteCollection` found: `deleted`, a live Collection it tombstoned
 * now; `already-deleted`, a tombstone it left as it was (finishing any
 * members a cut short delete left); `absent`, no record under the id at all.
 */
export type CollectionDeleteOutcome = 'deleted' | 'already-deleted' | 'absent'

/**
 * A Space Metadata object's stored body: the wire shape with a definite `id`.
 * The wire type leaves `id` optional for a single fixed Space, which has no
 * Space id, and this multi-tenant server stores every Space under one. It is
 * what `listSpaces` enumerates, since a listing carries no per-item `ETag`.
 */
export type ListedSpaceMetadata = SpaceMetadata & { id: string }

/**
 * A stored Space Metadata object as the backends surface it: the stored body
 * plus the out-of-band validator parts.
 */
export type StoredSpaceMetadata = ListedSpaceMetadata & MetadataValidatorParts

/**
 * What a Space or Collection Metadata write left, read inside the write's
 * critical section: the object's new validator, whether this write created
 * the container (a create over a Collection tombstone included), and the
 * stored wire body with its server-managed members as this write set them.
 */
export interface MetadataWriteResult<T> {
  validator: EtagValidator
  created: boolean
  metadata: T
}

/**
 * The server-managed members of a Resource Metadata object as a Resource
 * write left them. The stamp members are the content record's, and `meta`
 * is the `/meta` record's stamp and generation once metadata was written.
 */
export type ResourceWriteMembers = Pick<
  ResourceMetadata,
  | 'contentType'
  | 'size'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedAtCounter'
  | 'originId'
  | 'meta'
>

/**
 * What a Resource `/meta` write left, read inside the write's critical
 * section: the `/meta` record's validator, the content record's validator
 * the write left as it was (absent when it has none), and the server-managed
 * members as this write left them. The `/meta` `ETag` is the composite of
 * the two (`resourceMetaEtag`).
 */
export interface ResourceMetadataWriteResult {
  validator: EtagValidator
  contentValidator?: EtagValidator
  members: ResourceWriteMembers
}

/**
 * What a Resource content write left, read inside the write's critical
 * section: the content record's validator, whether this write created the
 * Resource (a re-create over a tombstone included), and the server-managed
 * members as this write left them.
 */
export interface ResourceWriteResult {
  validator: EtagValidator
  members: ResourceWriteMembers
  created: boolean
}

/**
 * A stored access-control policy as a backend reads it back: a live policy,
 * served with its stamp members (`updatedAt`, `updatedAtCounter`,
 * `originId`), or a tombstone, the `deleted` marker plus the delete's stamp.
 * The validator (generation and stamp) rides beside it, out of band, and is
 * absent when a part of it is missing. Only `getPolicyRecord` hands a
 * tombstone over; every other reader sees it as no policy.
 */
export type StoredPolicy = { validator?: EtagValidator } & (
  | { deleted: false; policy: PolicyDocument }
  | { deleted: true; tombstone: PolicyTombstone }
)

/**
 * What a policy write left, read inside the write's critical section: the
 * policy's new validator, whether this write created it (a write over a
 * tombstone included), and the served body as this write stored it.
 */
export interface PolicyWriteResult {
  validator: EtagValidator
  created: boolean
  policy: PolicyDocument
}

/**
 * A Collection's governing history log as stored (the
 * `governed-history-logs` feature): the JSON Lines body verbatim, plus its
 * own `ETag` validator parts, the generation minted by the guarded create and
 * the write stamp each write mints, independent of the Collection Metadata
 * object's validator. The filesystem backend's log file and the export
 * archive's log entry hold this layout.
 */
export type StoredCollectionLog = {
  body: string
  generation: string
} & WriteStamp

/**
 * A Collection's governing history log as a backend hands it over: the JSON
 * Lines body verbatim beside the log's own validator, so a reader formats the
 * `ETag` without assembling it from the stored layout.
 */
export interface CollectionLogResult {
  body: string
  validator: EtagValidator
}

/**
 * A Collection Metadata object with the validator of its governing history
 * log, as `StorageBackend.getCollectionMetadataAndLogValidator` reads them
 * together. `logValidator` is absent when the Collection is not governed.
 */
export interface CollectionMetadataAndLogValidator {
  collectionMetadata: StoredCollectionMetadata
  logValidator?: EtagValidator
}

/**
 * The write-once recheck a Resource or chunk write runs inside its critical
 * section. The backend hands it the Collection's governing history log as
 * read under the write's lock (`undefined` when it has none), and it answers
 * whether that log declares the Collection write-once.
 */
export type ImmutableUnder = (context: {
  log?: CollectionLogResult
}) => Promise<boolean>

/**
 * The persistence contract every backend implements. No write creates a
 * container implicitly. `writeSpace` is the only write that creates a Space,
 * and `writeCollection` (or an import) the only one that creates a Collection.
 * Every other write into a Space refuses with a 404 when the Space, and where
 * the write names one the Collection, has no Metadata object at the moment of
 * the write. The check is atomic with the write against a concurrent Delete
 * Space or Delete Collection.
 */
/**
 * What a Collection Metadata write's composition callback is handed, read
 * under the backend's per-Collection lock: the current object (`prior`,
 * `undefined` on a create) and the Collection's governing history log
 * (`log`, `undefined` when it has none).
 *
 * The write runs with no Resource write of the Space in flight: every one
 * that started has finished, and none starts until the write is done (the
 * filesystem backend's Space gate, exclusive side; the Postgres Space row
 * lock). A composition that scans the Collection's Resources (a
 * `unique: true` declaration checks the stored Resources for a duplicate)
 * therefore sees every stored Resource, and a Resource write that starts after
 * reads the declaration the write stores.
 */
export interface CollectionTransitionContext {
  prior?: StoredCollectionMetadata
  log?: CollectionLogResult
}

/**
 * The object a Collection Metadata write persists: either the object itself,
 * or a callback the backend runs under its lock, handed the current record
 * (`CollectionTransitionContext`), that returns it. The request layer passes
 * the callback, so the members a full-replacement write carries forward from
 * the stored object (`plaintext`, `backend`, `generator`, a governed
 * `revisions`) are composed from the record the write replaces, not from an
 * earlier read, and the state-transition checks run against that same record.
 * Throwing aborts the write.
 */
export type CollectionMetadataInput =
  | CollectionMetadata
  | ((
      context: CollectionTransitionContext
    ) => CollectionMetadata | Promise<CollectionMetadata>)

/**
 * One document of a Collection's changes feed (`StorageBackend.changesSince`),
 * discriminated on `kind`: a Resource or its tombstone, the Collection
 * Metadata object, or the Collection's governing history log. Each carries the
 * record's write stamp, its feed position, and its validator.
 */
export type FeedDocument = WriteStamp & {
  // The document's position in the Collection's changes feed.
  feedPosition: number
  // The record's validator, which the request layer formats as the wire
  // `etag`. Absent when the record has none.
  validator?: EtagValidator
} & (
    | {
        kind: 'resource'
        resourceId: string
        // The stored media type. A tombstone carries the last-known type.
        contentType: string
        deleted: boolean
        // The `/meta` record's stamp and generation, present once metadata has
        // been written.
        meta?: ResourceMetaStamp
        // The `/meta` record's validator, which the request layer composes
        // with `validator` into the wire `metaEtag`. Absent when no metadata
        // has been written.
        metaValidator?: EtagValidator
        createdBy?: IDID
        // Present only on a live JSON Resource.
        data?: unknown
        // Omitted when unset, never `null`: the handler projects this straight
        // onto the wire `ChangeDocument.custom`, which admits no null.
        custom?: ResourceMetadataCustom | Record<string, unknown>
        /**
         * The client-declared key epoch the Resource was encrypted under (the
         * `key-epochs` feature), when one was stamped. Rides the feed so a
         * replicating reader picks the right epoch key without a `/meta` fetch.
         */
        epoch?: string
        /**
         * The Resource's writer-attribution label (spec "Writer attribution"),
         * when one was stamped. Rides the feed so a replica recognizes its own
         * writes echoed back. A tombstone carries the label the deleting write
         * declared, if any.
         */
        writerId?: string
      }
    // The Collection Metadata object. `validator` is the one GET .../meta
    // serves, local segment included.
    | { kind: 'collection-metadata' }
    // The Collection's governing history log. `validator` is the log's own.
    | { kind: 'log' }
    // An access-control policy in the Collection: the Collection's own
    // (`resourceId` absent) or a Resource's, live or a tombstone.
    | { kind: 'policy'; resourceId?: string; deleted: boolean }
  )

/**
 * A replica registration as a backend stores it: the record as the last
 * write left it, the write's stamp members and `pausedAt` included, the
 * generation its `ETag` is made of, and the generation of the Space Metadata
 * object at the time it was made. An apply runs only while the Space still
 * carries that generation, so a registration that outlived a Delete Space
 * and a re-create under the same id applies nothing.
 */
export interface StoredReplica {
  record: ReplicaRegistration
  generation: string
  spaceGeneration: string
  /**
   * Whether the pull loop reads the chunk set of each chunked Resource it
   * applies: set at registration when the source server's `/service` lists
   * the Encrypted Collections entry. A source server without the profile has
   * no chunk endpoints, so the parent applies as a plain Resource.
   */
  pullsChunks: boolean
}

/**
 * The key of one chunk pull's staging: the registration it runs under and
 * the `ETag` of the parent revision the feed document named. Two
 * registrations on one Space never share staging, and a re-run of the same
 * revision finds what the earlier run staged.
 */
export interface ChunkStagingRun {
  replicaId: string
  parentEtag: string
}

/**
 * One chunk staged under a run: its index, its size in bytes, and the
 * source server's `ETag` it was read under (empty when none was served).
 */
export interface StagedChunk {
  index: number
  size: number
  peerEtag: string
}

/**
 * A registration's pull-loop state for one Collection, as stored: what the
 * `status` sub-resource serves for it, beside the peer's opaque changes
 * checkpoint and the peer Collection generation that checkpoint was read
 * under. The key in {@link ReplicaLoopState.collections} is the Collection
 * id.
 */
export type ReplicaCollectionState = Omit<ReplicaCollectionStatus, 'id'> & {
  checkpoint?: string
  generation?: string
}

/**
 * A registration's pull-loop state as stored beside the record, apart from
 * it, so a checkpoint advance never rewrites the record that holds the
 * capability. It is this server's own, like the registration: it is not
 * replicated and not exported, and Delete Space and Delete Replica remove it.
 */
export interface ReplicaLoopState {
  lastPullAt?: string
  lastSuccessAt?: string
  nextPullAt?: string
  // Consecutive failed cycles, which the back-off delay grows with.
  failures?: number
  // The peer's `ETag`s of the Space Metadata object and the Space policy as
  // last read, for the next cycle's conditional reads.
  spaceMetaEtag?: string
  spacePolicyEtag?: string
  collections: Record<string, ReplicaCollectionState>
}

export interface StorageBackend {
  /**
   * Optional logger the backend writes diagnostics through (Fastify's pino
   * logger, `FastifyBaseLogger`). `createApp` wires `fastify.log` here; backends
   * default to a silent pino logger until it is set.
   */
  logger?: FastifyBaseLogger

  /**
   * The store's origin id: the origin half of a write's replicated identity,
   * `[A-Za-z0-9_-]{1,64}`, stable for the store's life and unique among every
   * server a Space may replicate to. A primary backend is obtained from an
   * async factory (`FileSystemBackend.open()`, `PostgresBackend.open()`) that
   * reads or mints the id before it resolves (`WAS_ORIGIN_ID` when set, else
   * a minted id, refusing a mismatch with the stored one), so a backend in
   * hand always carries it. A data-plane adapter carries the hosting server's
   * id. Advertised on `/service` as `originId` on the core
   * `https://w3id.org/pws` entry.
   */
  readonly originId: string

  /**
   * OPTIONAL shutdown hook (e.g. draining a connection pool). Wired to the
   * Fastify `onClose` hook by the plugin composition. Backends without
   * teardown work omit it.
   */
  close?(): Promise<void>

  /**
   * The per-upload size cap in bytes (spec "Quotas", `maxUploadBytes`), or
   * `undefined` for no cap. Enforced by `writeResource`; also read by the
   * request layer to bound the in-memory buffer of a multipart file part (so an
   * oversize multipart upload is rejected before it is fully buffered).
   */
  maxUploadBytes?: number

  /**
   * The backend's self-description, as advertised at
   * `GET /space/:spaceId/backends`. Synchronous: a backend knows its own
   * characteristics without any I/O.
   */
  describe(): BackendDescriptor

  /**
   * Measures the storage the given Space consumes on this backend, for the
   * Space Quota report (spec "Quotas"). Resolves a `BackendUsage` entry: the
   * backend's identity plus measured `usageBytes`, derived `state`, and the
   * configured `limit`. The per-Collection `usageByCollection` breakdown is
   * included only when `includeCollections` is set (the spec's opt-in
   * `?include=collections`), so a backend for which the breakdown is expensive
   * computes it only on request. The Space is guaranteed to exist by the request
   * layer before this is called; an absent Space dir reports zero usage.
   */
  reportUsage(options: {
    spaceId: string
    includeCollections?: boolean
  }): Promise<BackendUsage>

  /**
   * Measures the storage a single Collection consumes on this backend, for the
   * per-Collection Quota report (spec "Quotas",
   * `GET /space/{id}/{cid}/quota`). Resolves a `BackendUsage` entry whose
   * `usageBytes` is scoped to the Collection, while `state` / `limit` /
   * `restrictedActions` describe the backend's overall condition (the quota is a
   * per-backend limit); the per-Collection breakdown (`usageByCollection`) is
   * omitted. OPTIONAL: a backend that cannot account per-Collection omits this
   * method, and the request layer returns `unsupported-operation` (501). The
   * Space and Collection are guaranteed to exist by the request layer.
   */
  reportCollectionUsage?(options: {
    spaceId: string
    collectionId: string
  }): Promise<BackendUsage>

  /**
   * Writes a Space Metadata object (full replacement), minting its write
   * stamp from the backend's clock inside the per-Space lock, resetting its
   * local validator segment to 0, and returning the new validator (the `ETag`
   * behind conditional Space writes), whether the write created the Space,
   * and the stored object as written. The stamp members (`updatedAt`,
   * `updatedAtCounter`, `originId`) are stored as wire members of the body;
   * any the supplied document carries are discarded. The server-managed
   * `createdBy` is authoritative, never taken from `spaceMetadata`: the backend
   * drops any value carried in that (client-supplied) document and records
   * `createdBy` from the first write's invoker, preserving it verbatim on every
   * later write. Omitting `createdBy` on a first write leaves it unrecorded
   * rather than letting the body supply one. `ifMatch` / `ifNoneMatch` are
   * evaluated atomically with the write on the same terms as
   * `writeCollection`'s: `ifNoneMatch` is the guarded create (412
   * `precondition-failed` when the Space exists), `ifMatch` the
   * compare-and-swap on the current `ETag`. The generation and local segment
   * travel only in the `ETag` header -- they are kept OUT of the wire body,
   * and a backend strips any validator-bearing member the supplied document
   * carries through `normalizeMetadataWrite` before storing it.
   */
  writeSpace(options: {
    spaceId: string
    spaceMetadata: SpaceMetadata
    /** DID of the invoker; recorded as `createdBy` on first write only */
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    /**
     * Invoked atomically with the write (inside the backend's per-Space lock
     * or advisory-locked transaction) against the freshly re-read current
     * object (`undefined` on a create); throwing aborts the write. Lets a
     * write authorized against an unlocked read pin itself to that read.
     */
    assertTransition?: (prior?: StoredSpaceMetadata) => void | Promise<void>
  }): Promise<MetadataWriteResult<SpaceMetadata>>
  /**
   * Reads a Space Metadata object. Resolves falsy when the Space does not
   * exist. `metaGeneration` / `metaLocal` are the out-of-band `ETag`
   * validator parts; the stamp members ride in the body.
   */
  getSpaceMetadata(options: {
    spaceId: string
  }): Promise<StoredSpaceMetadata | undefined>
  deleteSpace(options: { spaceId: string }): Promise<void>
  /**
   * Enumerates every Space stored on this backend (the candidate set for the
   * List Spaces operation; the request layer filters it down to the Spaces the
   * caller is authorized to see). Resolves an empty array when nothing is
   * stored yet (must not throw on an absent storage root).
   */
  listSpaces(): Promise<ListedSpaceMetadata[]>
  /**
   * Lists a Space's Collections, OPTIONALLY cursor-paginated (spec
   * "Pagination"), on the same keyset machinery as `listCollectionItems`:
   * `limit` bounds the page (a backend MAY clamp an oversized value to its own
   * maximum, and applies its default when absent); `cursor` is the opaque token
   * from a prior page's `next`, naming the keyset position (a Collection id) to
   * resume strictly after. The result carries `next` -- a ready-to-follow URL
   * with the cursor and limit baked in -- if and only if a further page may
   * follow; its absence marks the last page. `totalItems` is the FULL count of
   * the Space's Collections (free to compute for this listing, so always
   * present). Each summary carries `public` -- true iff a `PublicCanRead`
   * access-control policy is attached to that Collection -- so a client need
   * not issue one policy probe per listed Collection; only the page's
   * Collections are probed. A malformed/un-honorable `cursor` rejects with
   * `InvalidCursorError` (400 `invalid-cursor`).
   *
   * A tombstoned Collection is left out of the items and of `totalItems`
   * unless `includeDeleted` is set. With it, each tombstone is listed in the
   * same id order as `{ id, url, deleted: true }` plus the stamp of the
   * delete, and counted in `totalItems`; `next` then carries
   * `include=deleted` forward.
   */
  listCollections(options: {
    spaceId: string
    limit?: number
    cursor?: string
    includeDeleted?: boolean
  }): Promise<CollectionsList>
  /**
   * Packs the Space as a tar archive: its Collections, Resources (including
   * tombstones), policies, metadata sidecars, and the Space's zcap revocation
   * records (so a revoked capability stays revoked across an export/import
   * round-trip). Backend registration records (secret material) do NOT
   * travel. `service` is this server's Service Description, written into the
   * archive verbatim as its `service.json` entry so an importer can read which
   * specification versions and feature set the contents were written under; an
   * export run with none (a backend called directly, outside a request) writes
   * no such entry. With an `attestor` (a server with an identity), the
   * archive also carries `provenance.jsonl`, one signed statement per
   * exported object built by `attestArchiveEntries` over the entry tree
   * packed, and `did.jsonl`, the attestor's DID log snapshot; without one it
   * carries neither.
   */
  exportSpace(options: {
    spaceId: string
    service?: ServiceDescription
    attestor?: ExportAttestor
  }): Promise<Readable>
  /**
   * The archive entry tree of a Space as this backend holds it, before it
   * is packed: the top-level entries in pack order (a Space-level file, a
   * Collection directory with its files and chunk directories, or the
   * `.revocations` directory holding the Space's zcap revocation records).
   * `exportSpace` packs it through
   * `packExportArchive` (lib/exportArchive.ts), and Export Space composes
   * the trees of the server backends a Space's Collections span. Throws
   * `SpaceNotFoundError` for a Space this backend has no Metadata object
   * for. `serverBackends` is the server-managed part of the backends
   * listing the archived Space Metadata object carries; it defaults to this
   * backend's own descriptor.
   */
  exportSpaceEntries(options: {
    spaceId: string
    serverBackends?: BackendDescriptor[]
  }): Promise<ArchiveEntry[]>
  /**
   * Merges a Space-export archive into an existing Space, skip-not-overwrite
   * per item. The archive's revocation records are not in the plan: the
   * Import Space handler verifies and installs them through
   * `insertRevocation` once this write has landed.
   *
   * The backend persists what it is handed. `plan` is the archive's merge
   * plan with its provenance already judged, and `provenance` the verdict
   * counts, both built by `prepareImportPlan`; the counts are returned as the
   * stats' `provenance` member unchanged.
   *
   * The archived Space Metadata object's user-writable members are applied
   * only when `restoreSpaceMetadata` asks for it -- the Import Space handler
   * asks under an invocation of the Space's root capability and not under a
   * delegated chain; the backend holds no authorization decision of its own
   * -- and only over a Space that already has a stored Metadata object:
   * `name` is restored, and `type`, immutable once a Space exists, is checked
   * against the destination's (a different set of types refuses the import
   * with `InvalidImportError` before anything is written). Server-derived
   * members and `controller` are never restored. The outcome is the
   * `spaceMetadata` member of the stats: `'restored'`, `'skipped'` when the
   * archive carried an entry that was not applied (the option unset, or a
   * Space with no stored object yet), or `'absent'` when it carried none that
   * parses as a JSON object.
   */
  importSpace(options: {
    spaceId: string
    plan: ImportPlan
    provenance: ImportStats['provenance']
    restoreSpaceMetadata?: boolean
  }): Promise<ImportStats>

  /**
   * Writes a Collection Metadata object (full replacement of the merged
   * object: the configuration members beside the annotation members `custom`
   * and `epoch`), minting its write stamp inside the per-Collection lock,
   * resetting its local validator segment to 0, and returning the new
   * validator (the `ETag` behind conditional Collection writes), whether the
   * write created the Collection, and the stored object as written.
   * Server-managed members are the backend's: `createdBy` on the same terms as
   * `writeSpace`'s, `createdAt` set by the creating write and preserved, the
   * stamp members (`updatedAt`, `updatedAtCounter`, `originId`) by every
   * write. `custom` is
   * stored verbatim (`{ name, tags }` on a plaintext Collection, the opaque
   * encryption envelope on an encrypted one) and an absent or empty `custom`
   * clears it; an absent `epoch` clears the stored stamp, since it describes
   * the envelope this write replaces. When `ifMatch` is supplied it is
   * evaluated atomically with the write: the current `ETag` must equal it (an
   * update-if-unchanged compare-and-swap), else `precondition-failed` (412).
   * `ifNoneMatch` (`If-None-Match: *`) is the guarded create: the write
   * proceeds only if the Collection does not exist yet, else
   * `precondition-failed` (412), evaluated under the same lock. A tombstoned
   * Collection counts as absent: a write over it is a create, mints a new
   * generation and a stamp above the tombstone's, and inherits none of the
   * old life's members, `createdAt` and `createdBy` included. The
   * generation and local segment travel only in the `ETag` header -- they are
   * kept OUT of the wire body.
   */
  writeCollection(options: {
    spaceId: string
    collectionId: string
    /**
     * The object to persist, or a callback that composes it. The callback
     * runs atomically with the write (inside the backend's per-Collection
     * lock / row-locking transaction), after the precondition, against the
     * freshly re-read current object (`undefined` on a create) and the
     * Collection's governing history log as of the same lock (`undefined`
     * when it has none). It carries the request layer's composition and its
     * state-transition checks -- the carry-forward of an omitted `plaintext`
     * or `backend`, the epoch append-only rule, the refusal of a direct
     * `encryption` write on a log-governed Collection -- which composed
     * against a pre-lock read would lose or miss a concurrent write. The log
     * is handed over rather than re-read by the callback, so it costs no
     * second read and sees the log the lock covers. Since the precondition
     * is evaluated first, a stale `If-Match` answers 412 ahead of any
     * refusal the composition raises from the body.
     */
    collectionMetadata: CollectionMetadataInput
    /** DID of the invoker; recorded as `createdBy` on first write only */
    createdBy?: IDID
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<MetadataWriteResult<CollectionMetadata>>
  /**
   * Reads a Collection Metadata object. Resolves falsy when the Collection
   * does not exist, a tombstoned Collection included. `metaGeneration` /
   * `metaLocal` are the out-of-band `ETag` validator parts (the handler
   * strips them from the wire body and sets the `ETag` header from them and
   * the body's stamp members).
   */
  getCollectionMetadata(options: {
    spaceId: string
    collectionId: string
  }): Promise<StoredCollectionMetadata | undefined>
  /**
   * Deletes a Collection, leaving a tombstone: the Collection Metadata record
   * marked `deleted`, keeping its generation and taking a fresh write stamp
   * minted inside the delete's critical section. Its Resources, chunks,
   * policies, governing history log and changes-feed counter are removed.
   * A tombstone reads as absent to every other method, so a later create
   * under the id mints a new generation with a stamp above the tombstone's.
   * Resolves what it found (`CollectionDeleteOutcome`). Over a tombstone it
   * writes nothing, and the request layer answers 404. With no record at all
   * it removes any members left without one and resolves `absent`, which the
   * request layer answers 204.
   */
  deleteCollection(options: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionDeleteOutcome>
  /**
   * Lists a Collection's Resources, OPTIONALLY paginated (spec "Pagination").
   * `limit` bounds the page (a backend MAY clamp an oversized value to its own
   * maximum); `cursor` is the opaque token from a prior page's `next`, naming
   * the keyset position to resume from. With neither, the first (or only) page
   * is returned. The result carries `next` -- a ready-to-follow URL with the
   * cursor and limit baked in -- if and only if a further page may follow; its
   * absence marks the last page. A malformed/un-honorable `cursor` rejects with
   * `InvalidCursorError` (400 `invalid-cursor`).
   *
   * `collectionMetadata` (the caller's already-fetched control-plane
   * object) supplies the listing's `name` / `type` and encryption flag; a
   * data-plane backend selected by a Collection never holds the Collection
   * Metadata itself (it lives on the control plane), so it MUST be passed in
   * for such a backend.
   */
  listCollectionItems(options: {
    spaceId: string
    collectionId: string
    limit?: number
    cursor?: string
    collectionMetadata?: CollectionMetadata
  }): Promise<CollectionResourcesList>

  /**
   * Writes a Resource representation, minting the content record's write
   * stamp inside the per-Resource lock (over the stamp it replaces, so the new
   * one sorts above it). Resolves the new validator (the stamp under the
   * Resource's `generation`), whether the write created the Resource, and
   * the server-managed members as the write left them, read inside the same
   * critical section. A write to an absent id or over a tombstone creates
   * the Resource and records fresh provenance: this write's `createdBy` and
   * its stamp's time as `createdAt`. When a conditional-write precondition is
   * supplied (`conditional-writes` feature) it is evaluated
   * atomically with the write: `ifMatch` is an update-if-unchanged (the current
   * ETag must equal it), `ifNoneMatch` is a create-if-absent (`If-None-Match:
   * *`); a mismatch rejects with `precondition-failed` (412).
   *
   * A backend carrying the `blinded-index-query` feature also enforces the EDV
   * unique-attribute invariant on JSON writes: an `indexed` blinded attribute
   * marked `unique: true` whose (HMAC key id, name, value) triple is already
   * claimed by another live document in the same Collection rejects with
   * `UniqueAttributeConflictError` (409), evaluated atomically with the write
   * (see `lib/blindedIndex.ts`). Conflicts require `unique: true` on both
   * sides, and a document keeping its own unique attribute across an update
   * never self-conflicts.
   *
   * A backend carrying the `equality-query` feature enforces the analogous
   * plaintext unique-attribute invariant from the Collection's `unique: true`
   * declarations (`plaintext.indexes`), which the backend reads under the
   * same lock that excludes a concurrent declaration: a write whose extracted
   * value for a `unique` content-sourced attribute is already claimed by a
   * different live Resource in the same Collection rejects with
   * `UniqueAttributeConflictError` (409), evaluated atomically with the write
   * (see `lib/equalityIndex.ts`). Unlike the blinded invariant this is
   * Collection-level, so a conflict does not require the other side to opt in.
   */
  writeResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    input: ResourceInput
    /**
     * DID of the party whose capability invocation authorized this write (the
     * signing key's DID, fragment stripped). Recorded as the Resource's
     * server-managed `createdBy` by the write that creates the Resource (a
     * re-create over a tombstone included) and preserved verbatim by every
     * update, exactly as `createdAt` is -- so it names the creator, not the
     * last writer. Omitted by callers with no resolved invoker (a direct
     * backend call), in which case no `createdBy` is recorded.
     */
    createdBy?: IDID
    /**
     * The client-declared key epoch this content was encrypted under (the
     * `key-epochs` feature). Stored opaquely on the Resource's metadata and
     * returned by reads; a content write with no epoch CLEARS any stored stamp
     * (the new ciphertext's epoch is unknown). The server never computes or
     * verifies it.
     */
    epoch?: string
    /**
     * The client-declared writer-attribution label naming the writing agent
     * that produced this revision (spec "Writer attribution"). Stored
     * opaquely and returned by reads; a content write with no `writerId`
     * CLEARS any stored label, on the same declare-or-clear terms as `epoch`.
     * The server never verifies it, computes it, or uses it in any
     * authorization decision.
     */
    writerId?: string
    /**
     * `true` when the target Collection is write-once (its `revisions`
     * descriptor sets `immutable`). Evaluated inside the write's critical
     * section, after the preconditions: over a live Resource, a write whose
     * media type and content digest equal the stored record's is a no-op that
     * resolves the stored validator and members (no new stamp, no feed
     * position, `created` false), and any other write is refused with
     * `ResourceImmutableError` (409). A tombstone keeps the deleted content's
     * digest, so a write over one is held to the same rule: a repeat answers
     * the tombstone's validator and leaves the Resource deleted, and a
     * different body is refused. A tombstone with no digest (written with no
     * bytes to digest) holds nothing to compare, so a write over it, like a
     * write to an absent id, is an ordinary create. The media type is
     * compared without its parameters, and the digest is of the bytes the
     * write would store, so no stored bytes are read.
     *
     * A recheck callback when the request layer read the Collection as not
     * write-once. That read ran before the write's lock, and a governing
     * history log's guarded create can declare `immutable` in between. Over
     * a live Resource the backend calls it with the log it reads under the
     * write's lock, and applies the rule when it answers `true`. A log's
     * guarded create cannot land between that read and the write.
     */
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<ResourceWriteResult>
  /**
   * Reads a Resource's current representation. Throws `ResourceNotFoundError`
   * (404) when no Resource is stored under the id, or only its tombstone.
   */
  getResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    /** advisory hint only; single-representation backends ignore it for lookup */
    contentType?: string
  }): Promise<ResourceResult>
  /**
   * Deletes a Resource. When `ifMatch` is supplied (`conditional-writes`), the
   * delete proceeds only if the Resource's current ETag matches, evaluated
   * atomically with the removal; a mismatch rejects with `precondition-failed`
   * (412). Without it, the delete is unconditional and idempotent. Deleting a
   * Resource cascade-deletes any chunks stored under it (the `chunked-streams`
   * feature), so chunks never outlive their parent. A delete that tombstones
   * a live Resource also tombstones its live access-control policy, if any,
   * atomically with it: the policy tombstone keeps its generation, takes a
   * stamp above the live policy's, and takes the Collection's feed position
   * after the Resource tombstone's. A no-op delete writes no policy
   * tombstone. A data-plane backend that keeps no policies has nothing to
   * tombstone.
   */
  deleteResource(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    ifMatch?: string
    /**
     * The client-declared writer-attribution label naming the deleting agent
     * (spec "Writer attribution"). A deletion is a revision like any other:
     * where the backend keeps a tombstone, this is the label it carries,
     * declared fresh by THIS delete rather than inherited from the Resource's
     * prior `writerId`. Absent clears it, the same as an absent value does on
     * a content write.
     */
    writerId?: string
  }): Promise<void>
  /**
   * Reads a Resource's Metadata object. The content record's stamp members
   * are top-level wire members and the `/meta` record's stamp and generation
   * the nested `meta` object; `generation` is the content record's
   * generation, out of band (the handler strips it from the wire body and
   * derives the content `ETag` from it and the top-level stamp). The
   * Metadata's own `createdBy` rides along in it.
   */
  getResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<(ResourceMetadata & { generation?: string }) | undefined>
  /**
   * Reads the write stamp of a Resource's content record as held, live or a
   * tombstone, for the last-writer-wins decision a pull loop makes before a
   * chunk pull. `getResourceMetadata` reads a tombstone as absent, and a
   * held tombstone that wins over a received revision must still stop the
   * pull. Resolves `undefined` when no content record is held.
   */
  getResourceContentStamp(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<{ stamp: Partial<WriteStamp>; deleted: boolean } | undefined>
  /**
   * Replaces the user-writable `custom` object of a Resource's Metadata (full
   * replacement; pass `{}` to clear). Resolves `undefined` when the Resource
   * does not exist (this operation does not create one) so the handler can 404,
   * else the `/meta` object's new ETag validator (its own generation, minted
   * by the first metadata write, with the stamp this write mints) and the
   * content record's validator, beside the server-managed members as the
   * write left them, read inside the same critical section. The write moves
   * the nested `meta` record only; the content record's stamp, `ETag`, and
   * `writerId` are left as they are.
   *
   * On an encrypted Collection `custom` is the opaque encryption envelope (an
   * arbitrary JSON object) rather than a `{ name, tags }` object; the backend
   * stores it verbatim. When `ifMatch` / `ifNoneMatch` is supplied
   * (`conditional-writes`), the write is gated on the current `/meta` `ETag`
   * atomically, the composite `resourceMetaEtag` builds (`If-None-Match: *`
   * passes only while no `/meta` record exists), rejecting
   * a mismatch with `precondition-failed` (412).
   */
  writeResourceMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    custom: ResourceMetadataCustom | Record<string, unknown>
    /**
     * The client-declared key epoch (the `key-epochs` feature), a sibling of
     * `custom`. Unlike `custom` (full replacement), an OMITTED `epoch`
     * PRESERVES the stored value -- the stamp describes the content write, not
     * the metadata write -- while a supplied value replaces it. Stored opaquely.
     */
    epoch?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<ResourceMetadataWriteResult | undefined>

  /**
   * Reads a Collection's governing history log (the `governed-history-logs`
   * feature): the JSON Lines body as last written, with its validator.
   * Resolves `undefined` when the Collection has no log (it is not governed)
   * or does not exist.
   */
  getCollectionLog(options: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionLogResult | undefined>
  /**
   * Reads a Collection Metadata object with the validator of its governing
   * history log, and not the log's body. Resolves falsy when the Collection
   * does not exist, a tombstoned Collection included, and omits
   * `logValidator` when the Collection has no log. The request layer's
   * Collection prelude (`getCollectionOrThrow`) reads every Collection
   * through it.
   *
   * A log append advances the object's local segment, so the pair must not
   * hold the advanced segment beside the validator of the log before the
   * append. A backend reads both at one point in time, or else the Metadata
   * object first and the log second.
   */
  getCollectionMetadataAndLogValidator(options: {
    spaceId: string
    collectionId: string
  }): Promise<CollectionMetadataAndLogValidator | undefined>
  /**
   * Replaces a Collection's governing history log with `body` (the `/log`
   * transport's guarded create under `ifNoneMatch`, or its compare-and-swap
   * append under `ifMatch`, which carries the prior bytes forward). The
   * precondition is evaluated on the log's current `ETag` atomically with the
   * write (`precondition-failed`, 412, on a mismatch). Resolves `undefined`
   * when the Collection does not exist (this operation never creates one). A
   * `body` equal to the stored log, byte for byte, is refused once the
   * precondition passes (`invalid-request-body`, 400): `assertTransition` is
   * not invoked, and nothing is written.
   *
   * The write mints the log's own stamp, and also advances the Collection
   * Metadata object's local validator segment without minting a stamp for it:
   * the served object's `encryption` member is derived from the log head, so
   * its `ETag` must change with it. The write is serialized with Collection
   * Metadata writes, so `assertTransition` and a concurrent
   * `writeCollection`'s own callback each see the other's outcome.
   */
  writeCollectionLog(options: {
    spaceId: string
    collectionId: string
    body: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    /**
     * Invoked atomically with the write against the freshly re-read current
     * log (`undefined` on a create) and Collection Metadata object; throwing
     * aborts the write. Carries the request layer's line contract and
     * descriptor-transition checks.
     */
    assertTransition?: (context: {
      prior?: CollectionLogResult
      collectionMetadata: StoredCollectionMetadata
    }) => void | Promise<void>
  }): Promise<EtagValidator | undefined>

  /**
   * Writes one chunk of a chunked Resource (the `chunked-streams` feature),
   * keyed by `(spaceId, collectionId, resourceId, chunkIndex)`. Same upload-cap
   * / quota guards, stamp minting under the chunk's `generation` (the ETag
   * validator), and atomic
   * `ifMatch` / `ifNoneMatch` precondition semantics as `writeResource`;
   * differences:
   * - the body is opaque bytes + content-type (the server never parses it), so
   *   no encryption-conformance or unique-index enforcement applies;
   * - the stamp minted is the chunk's OWN, independent of the parent's;
   * - the parent Resource MUST already exist, else `ResourceNotFoundError`
   *   (404), so orphan chunks cannot accumulate;
   * - a chunk carries no server-managed `createdBy` / epoch / user Metadata.
   */
  writeChunk(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    input: ResourceInput
    /**
     * `writeResource`'s `immutable` option (the flag, or the recheck
     * callback), applied against a stored chunk at the index.
     */
    immutable?: true | ImmutableUnder
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator>
  /**
   * Reads a chunk's bytes, resolving the same `ResourceResult` shape as
   * `getResource`; rejects with `ResourceNotFoundError` when absent.
   */
  getChunk(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ResourceResult>
  /**
   * Reads a chunk's stored content-type / size / validator parts (the HEAD
   * payload headers). Resolves `undefined` when the chunk is absent.
   */
  getChunkMetadata(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
  }): Promise<ChunkMetadata | undefined>
  /**
   * Deletes one chunk. Resolves `true` when a chunk was removed and `false`
   * when none was stored at that index (the handler 404s on `false` -- unlike
   * `deleteResource`, chunk deletes are not silently idempotent, mirroring the
   * EDV chunk contract). An `ifMatch` precondition is evaluated atomically
   * with the removal (`precondition-failed` 412 on mismatch).
   */
  deleteChunk(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    chunkIndex: number
    ifMatch?: string
  }): Promise<boolean>
  /**
   * Lists a Resource's stored chunks in ascending `index` order -- the
   * discovery/reassembly listing (the server never reassembles; a reader
   * learns the chunk set here). Resolves an empty listing when the Resource
   * has no chunks (including when the Resource itself is absent -- existence
   * is the parent routes' concern).
   */
  listChunks(options: {
    spaceId: string
    collectionId: string
    resourceId: string
  }): Promise<ChunkListing>

  /**
   * OPTIONAL replication change feed (the `changes` query profile). Returns
   * the Collection's records whose feed position is strictly after
   * `afterPosition`, in ascending feed position order, capped at `limit` (a
   * backend MAY reduce an oversized value to its own maximum). With no
   * `afterPosition`, the feed starts from the beginning.
   *
   * The feed carries every record kind in the Collection, each document
   * discriminated on `kind` (see `FeedDocument`). A `resource` document is a
   * Resource or its tombstone, whatever its content type: JSON, binary, and
   * `text/jsonl` (a `did.jsonl` history log) alike, each with its stored
   * `contentType`. Only a live JSON Resource carries `data`. A
   * `collection-metadata` document is the Collection Metadata object, and a
   * `log` document is the Collection's governing history log. Each appears
   * once, at the position of its latest write, and reports the record's
   * current state.
   *
   * The feed position is a per-Collection sequence, a positive integer
   * starting at 1. Every Resource-level write in the Collection takes the
   * next one: a content write, a metadata write, a soft delete, and a
   * Resource written by an import. So does a Collection Metadata write (a
   * create, by import too, and an update), a governed-log write (the
   * guarded create and each append; a byte-identical log write writes
   * nothing and takes none), and a write or delete of the Collection's own
   * policy or a Resource policy (a Space policy is in no Collection's feed).
   * A log write advances the Collection Metadata object's local validator
   * segment without taking a position for it, so the `collection-metadata`
   * document can carry a newer local segment than the one at its position. A chunk write takes none, so it never moves its
   * parent Resource. The backend assigns the position inside the
   * per-Collection critical section that makes the write visible to this
   * method, so no write can land at or before a position already returned.
   * Positions are unique within a Collection, across kinds, but need not be
   * contiguous. A position is one server's fact about its own feed: it is
   * never exported or replicated, and an import assigns fresh ones. A record
   * stored before feed positions existed has none and is absent from the
   * feed until it is rewritten. The request layer wraps the position in the
   * opaque wire checkpoint; a backend never sees that string.
   *
   * The counter has a generation, minted with the first position it hands
   * out and kept for the Collection's life. It is removed with the
   * Collection, so a Collection re-created under the same id, by hand or by
   * an import, restarts at 1 under a fresh one. The result's `feedGeneration`
   * is that generation, absent while the Collection has handed out no
   * position. The request layer puts it in the checkpoint and refuses a
   * checkpoint that carries another, so a reader holding one from before a
   * re-create restarts rather than skipping the new feed's first positions.
   *
   * Each document carries the record's write stamp (`updatedAt`,
   * `updatedAtCounter`, `originId`) and, out of band, the record's
   * `validator`, which the request layer formats as the wire `etag`. A
   * `resource` document's stamp and validator are its content record's. It
   * also carries the `/meta` record's stamp and generation as `meta` (when a
   * metadata write has occurred) with its `metaValidator` (composed with
   * `validator` into the wire `metaEtag`), the server-managed `createdBy` (the creator's DID, when one
   * was recorded -- so provenance replicates and does not have to be fetched
   * per Resource from `/meta`), and -- so metadata replicates alongside
   * content -- the user-writable `custom` object (the opaque encryption
   * envelope on an encrypted Collection). The validators are the quoted
   * strong validators a replica can send back as `If-Match` without a GET
   * per record. A tombstone keeps its `createdBy`, as it keeps its
   * `createdAt`. A metadata-only edit re-surfaces the Resource at a new feed
   * position, with a new `meta` stamp but its content stamp and `data`
   * unchanged. The stamps have no ordering role in the feed, which is
   * ordered by feed position. A tombstone (soft-deleted Resource) is
   * surfaced with `deleted: true`, its last-known `contentType`, and no
   * `data`, so the delete replicates until clients catch up. Each document
   * carries its `feedPosition`. The result's `checkpoint` is the last
   * returned document's feed position (what a follow-up call passes as
   * `afterPosition`), or `null` when nothing changed since `afterPosition`.
   *
   * OPTIONAL: a backend that omits this method does not serve the change feed,
   * and the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  changesSince?(options: {
    spaceId: string
    collectionId: string
    afterPosition?: number
    limit: number
  }): Promise<{
    documents: FeedDocument[]
    checkpoint: number | null
    // The feed counter's generation; absent until the first position.
    feedGeneration?: string
  }>

  /**
   * OPTIONAL blinded-index query (the `blinded-index` query profile; the
   * `blinded-index-query` feature token). Evaluates an EDV query -- `equals`
   * (OR across elements of an AND within each element's blinded `{name:
   * value}` pairs) or `has` (every named blinded attribute present) -- against
   * the HMAC-blinded `indexed` entries of the Collection's live JSON
   * documents, scoped to the `query.index` HMAC key id. Matching is opaque
   * string comparison; the backend performs no cryptography. With `count`,
   * resolves only the match total; otherwise a page of the matching stored
   * documents verbatim, in ascending `resourceId` order, paginated with the
   * standard opaque cursor (`cursor` present iff `hasMore`; a malformed one
   * rejects with `invalid-cursor` 400). Both first-party backends answer
   * through `lib/blindedIndex.ts` so semantics cannot drift.
   *
   * OPTIONAL: a backend that omits this method does not serve the profile,
   * and the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  queryByBlindedIndex?(options: {
    spaceId: string
    collectionId: string
    query: BlindedIndexQuery
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | BlindedIndexQueryPage>

  /**
   * OPTIONAL plaintext equality query (the `equality` query profile; the
   * `equality-query` feature token). Evaluates an equality query -- `equals`
   * (OR across elements of an AND within each element's `{name: value}` pairs)
   * or `has` (every named attribute present with an indexable value) -- over
   * the attributes the server extracts from the Collection's live Resources per
   * the `plaintext.indexes` declaration. `indexes` is the NORMALIZED
   * declaration array: the request layer resolves it from the control-plane
   * description (a data-plane backend does not hold the description) and
   * passes it in. Matching
   * is strict JSON equality (no coercion); a content-sourced attribute reads a
   * JSON Resource's stored content, a custom-sourced one reads the `custom`
   * metadata object (so blobs are queryable too). With `count`, resolves only
   * the match total; otherwise a page of matching documents (`{ id, data?,
   * custom? }`) in ascending `resourceId` order, paginated with the standard
   * opaque cursor (`cursor` present iff `hasMore`; a malformed one rejects with
   * `invalid-cursor` 400). Both first-party backends answer through
   * `lib/equalityIndex.ts` so semantics cannot drift.
   *
   * OPTIONAL: a backend that omits this method does not serve the profile, and
   * the request layer returns `unsupported-operation` (501). The Space and
   * Collection are guaranteed to exist by the request layer.
   */
  queryByEquality?(options: {
    spaceId: string
    collectionId: string
    query: EqualityQuery
    indexes: NormalizedIndexDeclaration[]
    count?: boolean
    limit?: number
    cursor?: string
  }): Promise<{ count: number } | EqualityQueryPage>

  /**
   * OPTIONAL declare-time uniqueness scan for the `equality` profile: given the
   * Collection's normalized `unique: true` declarations, scans its already-
   * stored live Resources for two DIFFERENT Resources that claim the same
   * `(name, value)`, resolving the first such `{ name, value }` or `undefined`
   * when none exists. The request layer runs it when a Collection update ADDS a
   * unique claim, rejecting a found violation with `id-conflict` (409) so a
   * unique claim is never acknowledged over already-conflicting data. It runs
   * inside the update's composition callback, under the `writeCollection`
   * lock, which excludes this backend's Resource writes, so none is in flight
   * while it scans.
   *
   * OPTIONAL: paired with `queryByEquality` on backends carrying the
   * `equality-query` feature. The Space and Collection are guaranteed to exist
   * by the request layer.
   */
  findEqualityUniqueViolation?(options: {
    spaceId: string
    collectionId: string
    indexes: NormalizedIndexDeclaration[]
  }): Promise<{ name: string; value: EqualityValue } | undefined>

  /**
   * Access-control policy documents. The level is selected by which ids are
   * present: Space (`spaceId`), Collection (`+ collectionId`), or Resource
   * (`+ collectionId + resourceId`). A policy is a versioned record: each
   * write mints its write stamp inside the write's critical section, and its
   * generation is minted by its first write and kept for its life.
   *
   * `getPolicy` resolves the live policy at that level, served with its stamp
   * members, and falsy when there is none. A tombstone resolves falsy too, so
   * no authorization path can grant from one.
   */
  getPolicy(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<PolicyDocument | undefined>
  /**
   * The stored policy record at a level, live or a tombstone, beside its
   * validator; `undefined` when no record is stored. Only Get Policy reads
   * a tombstone, under `?include=deleted`.
   */
  getPolicyRecord(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): Promise<StoredPolicy | undefined>
  /**
   * Creates or replaces the policy at a level. The body's stamp members,
   * `deleted`, `_generation` and `_feedPosition` are not stored from it. A tombstone counts
   * as absent: a write over it is a create, under a new generation and a
   * stamp above the tombstone's. `ifMatch` / `ifNoneMatch` are evaluated
   * atomically with the write, against the live policy (412 otherwise). A
   * Collection- or Resource-level write takes the Collection's next feed
   * position. Refused with a 404 when the Space, or the named Collection,
   * has no Metadata object. A Resource-level write is refused with
   * `ResourceNotFoundError` (404) when the Resource is absent or a
   * tombstone, checked atomically with the write so it serializes with
   * `deleteResource`. The caller passes `requireLiveResource: false` when
   * the Collection's Resources live on another backend, which this store
   * cannot check; the caller decides that, since the data-plane routing is
   * the request layer's.
   */
  writePolicy(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    policy: PolicyDocument
    ifMatch?: string
    ifNoneMatch?: HeldValidators
    requireLiveResource?: boolean
  }): Promise<PolicyWriteResult>
  /**
   * Deletes the live policy at a level, leaving a tombstone that keeps its
   * generation and takes a stamp above the live policy's. Resolves the
   * tombstone's validator. Over no record, or over a tombstone, it writes
   * nothing and resolves `undefined`. `ifMatch` / `ifNoneMatch` are
   * evaluated atomically, against the live policy. A Collection- or
   * Resource-level tombstone takes the Collection's next feed position.
   */
  deletePolicy(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<EtagValidator | undefined>

  /**
   * Registered `external` backend records (spec "Backends"). The read/write
   * asymmetry is the secret boundary: `getBackend` is the only method that
   * returns the secret-bearing `StoredBackendRecord`; `listBackends` returns
   * sanitized `BackendDescriptor`s. A registered backend is listed but not yet
   * selectable as a Collection's `backend` this increment (the live adapter is
   * future work).
   */
  writeBackend(options: {
    spaceId: string
    backendId: string
    record: StoredBackendRecord
  }): Promise<void>
  /** The full (secret-bearing) record, or `undefined` when absent. Internal use. */
  getBackend(options: {
    spaceId: string
    backendId: string
  }): Promise<StoredBackendRecord | undefined>
  /** The Space's registered external backends, **sanitized** (no secrets). */
  listBackends(options: { spaceId: string }): Promise<BackendDescriptor[]>
  /** Idempotent: no error when the record is absent. */
  deleteBackend(options: { spaceId: string; backendId: string }): Promise<void>

  /**
   * Replica registrations (the replication specification): one source peer
   * of a Space per record, stored inside the Space, so Delete Space removes
   * them with it. They are this server's own. Export does not carry them and
   * import never creates one.
   *
   * A registration is a versioned record: each write mints its stamp with
   * the store's clock inside the write's critical section, and its generation
   * at the first write, so its `ETag` is the standard four-segment shape.
   * The `record` a write takes is the client's shape, without the stamp
   * members; the write composes the stored record (`lib/replicaRecord.ts`).
   * `pausedAt` on it is the request to pause: a registration that was not
   * paused takes the write's own time, one that was keeps its stored time,
   * and a record without the member resumes.
   *
   * `writeReplica` creates or replaces a registration, the `PUT` at its
   * URL, and under `createOnly` the `POST`. `ifMatch` / `ifNoneMatch` are
   * evaluated against the stored registration atomically with the write
   * (`PreconditionFailedError`, 412). A replacement must keep every member
   * but `capability` and `pausedAt` (`InvalidRequestBodyError`, 400), and
   * keeps the generation and the loop state; one that keeps the stored
   * capability keeps its `pullsChunks` too, else `pullsChunks` is stored. A
   * create rejects with `SpaceNotFoundError` (404) when the Space has no
   * Metadata object, under the lock Delete Space takes, records the Space
   * Metadata object's current generation as `spaceGeneration`, and advances
   * that object's local validator segment, since its served `replicas`
   * member changed; a replacement advances nothing on it. The write returns
   * the registration it replaced, if any. `createOnly` refuses a stored
   * registration with `IdConflictError` (409), atomically with the write.
   * Under `requireRegisteredSource`, the write of a delegated invocation, a
   * create must name a `fromSpace` another registration on the Space names
   * (`ReplicaRefusedError`, 409), decided from the registrations read inside
   * the critical section, which the Space's other registration writes and
   * removals cannot enter meanwhile.
   */
  writeReplica(options: {
    spaceId: string
    record: ReplicaRegistration
    pullsChunks: boolean
    requireRegisteredSource?: boolean
    createOnly?: boolean
    ifMatch?: string
    ifNoneMatch?: HeldValidators
  }): Promise<{ stored: StoredReplica; prior?: StoredReplica }>
  /**
   * `writeReplica` with `createOnly` and no precondition.
   */
  createReplica(options: {
    spaceId: string
    record: ReplicaRegistration
    pullsChunks: boolean
    requireRegisteredSource?: boolean
  }): Promise<StoredReplica>
  /**
   * The stored registration, capability included, or `undefined`.
   */
  getReplica(options: {
    spaceId: string
    replicaId: string
  }): Promise<StoredReplica | undefined>
  /**
   * The Space's registrations in ascending id order. Resolves an empty array
   * for a Space with none, an absent Space included.
   */
  listReplicas(options: { spaceId: string }): Promise<StoredReplica[]>
  /**
   * Every registration in the store, for the boot that starts one pull loop
   * each. Resolves an empty array when nothing is stored yet.
   */
  listAllReplicas(): Promise<Array<StoredReplica & { spaceId: string }>>
  /**
   * Removes a registration and its loop state. Resolves `false` when none
   * was stored. A removal advances the Space Metadata object's local
   * validator segment.
   */
  deleteReplica(options: {
    spaceId: string
    replicaId: string
  }): Promise<boolean>
  /**
   * The registration's stored loop state, or `undefined` when it has none
   * yet or the registration is gone.
   */
  getReplicaState(options: {
    spaceId: string
    replicaId: string
  }): Promise<ReplicaLoopState | undefined>
  /**
   * Replaces the registration's loop state. Writes nothing and resolves
   * `false` when the registration is gone, so a loop that outlived its
   * registration leaves no state behind.
   */
  writeReplicaState(options: {
    spaceId: string
    replicaId: string
    state: ReplicaLoopState
  }): Promise<boolean>

  /**
   * The apply path: how a record a pull loop read from a peer is stored. No
   * request route reaches these methods. Each stores the received record
   * under the stamp the peer served, verbatim, after the one comparison
   * `lib/replicaApply.ts` defines, and resolves an `ApplyResult` saying what
   * it did. One other caller is the policy copy a server backend other than
   * the control plane keeps (`lib/backendMirror.ts`), which hands
   * `applyPolicy` the stamp and
   * generation the control plane's own write minted, with no `replicaId`.
   *
   * Every apply method runs inside the critical section the matching
   * request-layer write takes, and makes these checks there, in this order:
   *
   * - The registration `replicaId` is stored on the Space and its
   *   `spaceGeneration` is the Space Metadata object's current generation.
   *   Otherwise the result is `unregistered`.
   * - The received stamps are taken in by the backend's clock
   *   (`HybridLogicalClock.observe`). A stamp dated more than the clock
   *   bound ahead of local time is not applied, and the result is `refused`
   *   with reason `clock-bound`.
   * - The record's Collection, where it names one, is live. Under an absent
   *   or tombstoned Collection the result is `skipped`. `applyCollection`
   *   is the only method that creates, replaces or deletes a Collection.
   * - The comparison. A record that loses is `skipped`.
   *
   * An applied record takes the next local feed position where the matching
   * request-layer write takes one, and the same derived state is maintained
   * (index entries, the Collection Metadata object's local segment on a log
   * write, the cascade of a delete). The received generation is stored with
   * the stamp, so the record's `ETag` here equals the peer's. Preconditions,
   * the encrypted-Collection envelope rule, the write-once rule and the
   * unique-attribute claims are not evaluated: the origin server admitted
   * the write. Quotas and the upload cap are, and reject as they do on a
   * request-layer write (`QuotaExceededError`, `PayloadTooLargeError`).
   *
   * The caller drops the request-layer caches an applied record affects.
   *
   * `applySpaceName` applies the one replicated member of the Space Metadata
   * object. `name` replaces the stored one, or removes it when absent, and
   * the object takes `stamp`, with its local validator segment reset to 0.
   * Every other member is kept, the generation included.
   */
  applySpaceName(options: {
    spaceId: string
    replicaId: string
    name?: string
    stamp: WriteStamp
  }): Promise<ApplyResult>
  /**
   * Applies a Collection Metadata object or a Collection tombstone, by
   * `decideCollectionApply` / `decideCollectionTombstoneApply`.
   *
   * A live `collection` is the stored projection of the peer's object:
   * `metadata` carries its write stamp and its creating stamp (`created`)
   * beside the stored members, `createdAt` and `createdBy` included, and no
   * derived or validator member. A `create` stores it under `generation`.
   * An `update` stores it merged over the held object by
   * `mergeAppliedCollectionMetadata`, and a fork there is `refused` with
   * reason `fork`. A `replace` deletes the held life with its members, as
   * Delete Collection does, then creates the received one. A create counts
   * against the Collection quota.
   *
   * A tombstone carries its stamp alone. A `delete` removes the held
   * Collection's members as Delete Collection does and leaves the tombstone
   * under the held generation and the received stamp. A `write` stores a
   * tombstone under a new generation. A cascade a delete cut short is
   * finished even when the received stamp is skipped.
   */
  applyCollection(options: {
    spaceId: string
    replicaId: string
    collectionId: string
    collection:
      | { deleted: false; generation: string; metadata: CollectionMetadata }
      | { deleted: true; stamp: WriteStamp }
  }): Promise<ApplyResult>
  /**
   * Applies a Resource's content record, live or a tombstone, when `stamp`
   * wins over the held content record's (a held tombstone's included).
   *
   * A live `resource` stores `input` under `generation` and `stamp`, with
   * the members the origin's content write set: `createdAt`, `createdBy`,
   * `epoch` and `writerId`, each cleared when absent. The `/meta` record and
   * `custom` are kept as held, unless the held record is a tombstone, which
   * has none. A tombstone removes the representation, the `/meta` record,
   * `custom` and the chunks, as Delete Resource does, and keeps `contentType`
   * as the last-known type.
   *
   * A `did.jsonl` Resource follows `decideLogApply` in place of the stamp
   * comparison: the held bytes must be a prefix of the received ones. A fork
   * is `refused` with reason `fork`. A received tombstone of one is always
   * `skipped`, since a history log is never deleted by a peer.
   *
   * A received `createdAt` or `createdBy` that is absent leaves the held one
   * in place where the store requires the member.
   *
   * An absent `replicaId`, here and on `applyResourceMetadata`, is an apply
   * into a server backend other than the control plane, which holds no
   * registrations: the pull loop checked the registration on the control
   * plane, the registration check is skipped, and the Space and the
   * Collection must still be held (their copies) as on any apply.
   *
   * With `chunks`, a live `resource` is applied together with its chunk
   * set, in the same critical section under the parent's lock: the
   * registration check, the clock, and the last-writer-wins decision as
   * above. On a win, every live chunk whose index is not in `staged` is
   * removed as a chunk delete removes it, each staged chunk of `run` is
   * moved into place under a stamp and generation minted here, the parent
   * is stored as above and takes its feed position, and the staging of
   * `run` is released. On a loss or an equal stamp the staging of `run` is
   * released and the result is `skipped`. A staged index the run holds no
   * staged chunk for is a fault of the caller and is refused as
   * `container-refused`. The parent's feed position is the first moment the
   * parent and its set are visible, to a reader and to this server's own
   * `changes` feed alike. `chunks` with a tombstone is a fault of the
   * caller.
   */
  applyResource(options: {
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
  }): Promise<ApplyResult>
  /**
   * Applies a Resource's `/meta` record when `meta` (its stamp and
   * generation) wins over the held `/meta` record's stamp. `custom` replaces
   * the stored one, and an absent or empty one clears it. The content record
   * is not touched. `skipped` when the Resource is absent or a tombstone.
   */
  applyResourceMetadata(options: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    meta: ResourceMetaStamp
    custom?: ResourceMetadataCustom | Record<string, unknown>
  }): Promise<ApplyResult>
  /**
   * The chunk pull of the replication facet (the `chunked-streams` feature
   * under replication). A pull loop that meets a live `resource` document
   * reads the source server's chunk listing, opens a staging run for it,
   * stages each chunk it does not hold, and then applies the parent and
   * its chunk set in one critical section (`applyResource` with `chunks`),
   * so nothing live changes until the whole set is here. A chunk is a
   * local record that follows its parent: it carries no source server
   * stamp, and the backend mints its stamp and generation at the swap, as
   * for a chunk a client writes. The source server's chunk `ETag` is kept
   * as an opaque string, for the conditional read of a re-run only.
   *
   * `beginChunkStaging` opens the staging of `run` for the set the source
   * server lists, once per chunk pull, under the parent's lock: it checks
   * that the registration stands (`replicaId`, as on `applyResource`) and
   * that the Collection is live, drops the same registration's staging of
   * the Resource under any other `parentEtag` (the loop moved past that
   * revision, and those bytes still count toward usage), and makes the
   * quota pre-check of the set: each listed `size` against the upload cap,
   * and the set's net
   * growth (each listed size, less what the run already staged, less the
   * live chunks the swap will free, plus whatever headroom the backend's
   * own in-write check needs) against the Space's remaining capacity. A set
   * that does not fit is `refused` as `quota-exceeded` with nothing staged.
   * The check is advisory: a 507 or 413 from `stageChunk` stays
   * authoritative. It resolves what the run already holds, by ascending
   * index with the source server's `ETag` each was read under, so the loop
   * reads each one conditionally. A backend whose swap is not one atomic
   * step finishes a swap of the Resource a fault left torn here first,
   * which changes the live set before the pre-check answers; a backend
   * whose swap is one transaction has no torn swap to finish.
   *
   * `stageChunk` writes one chunk's bytes to the staging of `run`, under
   * the upload cap and the quota as a chunk write is, with the live chunk
   * sizes the swap will free credited against the quota check (the live
   * chunks at the indexes the run has staged so far, this one included). It
   * checks, under the parent's lock, that the registration stands and that
   * the Collection is live, and answers `unregistered` or `skipped` without
   * writing when either fails; the transfer itself runs outside the lock,
   * so several chunks of one run may be staged at once. The parent need
   * not be held: a first-time replication stages under no parent record,
   * and last-writer-wins at the swap decides. A staged chunk takes no feed
   * position and is served by nothing. A 507 or 413 here changes nothing
   * live. `retry` means the staging was removed during the transfer (a
   * local Delete Resource, say) while the Collection stands: nothing was
   * staged, and the loop reads the document again next cycle without
   * counting it toward the bounded retry.
   */
  beginChunkStaging(options: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
    /** the source server's listing, checked */
    listed: Array<{ index: number; size: number }>
  }): Promise<
    { staged: StagedChunk[] } | Exclude<ApplyResult, { outcome: 'applied' }>
  >
  stageChunk(options: {
    spaceId: string
    replicaId?: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
    chunkIndex: number
    input: ResourceInput
    /** the source server's `ETag` of the chunk, opaque */
    peerEtag: string
  }): Promise<ApplyResult | { outcome: 'retry' }>
  /**
   * The chunks staged under `run`, by ascending index, with the source
   * server's `ETag` each was read under, so a re-run of the chunk pull can
   * keep each one the source server still lists under that `ETag`. Empty
   * when nothing is staged.
   */
  listStagedChunks(options: {
    spaceId: string
    collectionId: string
    resourceId: string
    run: ChunkStagingRun
  }): Promise<StagedChunk[]>
  /**
   * Removes the chunk staging the pull loop no longer owns, in the scope
   * the ids select: a registration's on Delete Replica (`replicaId`), a
   * Resource's, a Collection's or a Space's inside the matching delete, and
   * every registration's at boot. A run whose swap was done but whose
   * parent record was never written is finished rather than removed, so a
   * crash between the two leaves no torn set. Resolves how many runs were
   * removed or finished.
   */
  reclaimStaging(options: {
    spaceId: string
    collectionId?: string
    resourceId?: string
    replicaId?: string
  }): Promise<number>
  /**
   * Applies an access-control policy, live or a tombstone, at the level the
   * ids select, when `stamp` wins over the held policy record's (a held
   * tombstone's included). The record is stored under `generation` and
   * `stamp`. An absent `policy` is a tombstone. An absent `replicaId` is
   * the copy of a control-plane record this server writes to one of its own
   * backends: the registration check is skipped, and the Space must still
   * hold a Metadata object.
   */
  applyPolicy(options: {
    spaceId: string
    replicaId?: string
    collectionId?: string
    resourceId?: string
    generation: string
    stamp: WriteStamp
    policy?: PolicyDocument
  }): Promise<ApplyResult>
  /**
   * Applies a Collection's governing history log by `decideLogApply`: the
   * held log must be a prefix of `body`. An applied log is stored under
   * `generation` and `stamp` and advances the Collection Metadata object's
   * local validator segment, as a log write does. A fork is `refused` with
   * reason `fork`.
   */
  applyCollectionLog(options: {
    spaceId: string
    replicaId: string
    collectionId: string
    body: string
    generation: string
    stamp: WriteStamp
  }): Promise<ApplyResult>

  /**
   * WebKMS keystore configs (the `/kms` facet).
   * Keystores are a sibling tree to Spaces (`data/keystores/<localId>/`),
   * keyed by `keystoreId` -- the server-generated *local* id, i.e. the last
   * segment of the config's full-URL `id`. The protocol defines no keystore
   * delete.
   *
   * Writes a keystore config unconditionally (the create path; local ids are
   * server-generated 128-bit random values, so create never collides). The
   * sequence-gated update path is `updateKeystore`.
   */
  writeKeystore(options: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void>
  getKeystore(options: {
    keystoreId: string
  }): Promise<KeystoreConfig | undefined>
  /**
   * Replaces a keystore config if and only if, atomically with the write:
   * the keystore exists, `config.sequence` is exactly the stored sequence + 1,
   * and `config.kmsModule` matches the stored one (the module is immutable).
   * Otherwise rejects with the protocol's 409 state conflict
   * (`KeystoreStateConflictError`) -- one merged conflict kind.
   */
  updateKeystore(options: {
    keystoreId: string
    config: KeystoreConfig
  }): Promise<void>
  /**
   * Every stored keystore config whose `controller` matches, sorted by local
   * id (the request layer caps the wire result). Resolves an empty array when
   * nothing is stored yet (must not throw on an absent storage root).
   */
  listKeystoresByController(options: {
    controller: IDID
  }): Promise<KeystoreConfig[]>

  /**
   * WebKMS key records, stored under their keystore
   * (`data/keystores/<keystoreId>/keys/<localId>.json`), unique on
   * `(keystoreId, localId)`. The record is opaque to the storage layer -- the
   * at-rest record cipher (`KMS_RECORD_KEK`, `lib/kmsRecordCipher.ts`) applies
   * above the backend, at the KMS orchestration seam, so no schema change is
   * needed here. The protocol defines no key delete or update -- a record is
   * immutable once inserted.
   *
   * Inserts a key record, create-only: rejects with the protocol's 409
   * duplicate conflict (`KeyIdConflictError`) when a record already exists at
   * `(keystoreId, localId)`, atomically with the write.
   */
  insertKey(options: {
    keystoreId: string
    localId: string
    record: KmsKeyRecord
  }): Promise<void>
  getKey(options: {
    keystoreId: string
    localId: string
  }): Promise<KmsKeyRecord | undefined>
  /**
   * Every stored key record under the keystore, sorted by local id (the
   * request layer caps and paginates the wire result). The record is opaque to
   * storage -- the at-rest cipher applies above the backend (as for `getKey`),
   * so records come back exactly as stored. Resolves an empty array when the
   * keystore has no keys yet (must not throw on an absent keys directory /
   * table).
   */
  listKeys(options: {
    keystoreId: string
  }): Promise<Array<{ localId: string; record: KmsKeyRecord }>>

  /**
   * ZCap revocations, stored under their scope -- a keystore
   * (`data/keystores/<keystoreId>/revocations/`) or a Space
   * (`data/spaces/<spaceId>/.revocations/`, a reserved Collection id so the
   * directory can never be mistaken for, or collide with, a Collection).
   * Unique on `(delegator, capability.id)` within the scope.
   * Neither protocol defines a revocation read or delete: records exist only
   * to be consulted by the chain-inspection hook, and lapse via
   * `meta.expires` (the capability is rejected on its own expiry from then
   * on). Deleting a Space deletes its revocations with it.
   *
   * Inserts a revocation record, create-only: rejects with the protocol's 409
   * duplicate (`DuplicateRevocationError`) when a record already exists at
   * `(meta.delegator, capability.id)`, atomically with the write. The scope
   * must exist. A Space scope is re-checked under the lock that Delete Space
   * takes, so an insert under a Space with no Metadata object rejects with
   * `SpaceNotFoundError` (404), and one racing a Delete Space is either
   * refused or removed by it. An insert under an absent keystore rejects with
   * `StorageError` (the request layer 404-masks unknown scopes long before
   * this).
   */
  insertRevocation(options: {
    scope: RevocationScope
    record: RevocationRecord
  }): Promise<void>
  /**
   * True when any of the given capabilities has a stored, unexpired
   * revocation under the scope. Records past their `meta.expires` GC
   * horizon count as not revoked (the capability itself has expired) and may
   * be pruned on the way through.
   */
  isRevoked(options: {
    scope: RevocationScope
    capabilities: CapabilitySummary[]
  }): Promise<boolean>
}

/**
 * Decision returned by an {@link AuthorizeProvisioning} callback for a
 * provisioning request (`POST /spaces/`, Create Space by Id at
 * `PUT /space/:spaceId/meta`, or `POST /kms/keystores`). Any other value is
 * refused as `deny`:
 * - `verify` -- proceed with normal zcap capability-invocation verification;
 * - `grant` -- the callback itself authorized the request (e.g. a valid
 *   onboarding token); skip zcap verification for this request;
 * - `deny` -- refuse provisioning (403).
 */
export type ProvisioningDecision = 'verify' | 'grant' | 'deny'

/**
 * Provisioning gate callback: decides whether a request to one of the open
 * provisioning endpoints (`POST /spaces/`, Create Space by Id at
 * `PUT /space/:spaceId/meta`, `POST /kms/keystores`) may proceed. A `PUT` to
 * the Metadata object of a Space that already exists is an update, and does
 * not reach the callback.
 * May instead throw a `ProblemError` subclass to return a custom status/body.
 * @param options {object}
 * @param options.request {import('fastify').FastifyRequest}   the provisioning request
 * @returns {ProvisioningDecision | Promise<ProvisioningDecision>}
 */
export type AuthorizeProvisioning = (options: {
  request: FastifyRequest
}) => ProvisioningDecision | Promise<ProvisioningDecision>

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Marks a POST route as a read (safe in the RFC 9110 sense), so the
     * `no-store` hook in `routes.ts` leaves its response cacheable.
     */
    safe?: boolean
    /**
     * Marks a route that answers the same whatever the caller's identity: a
     * 405 method refusal or a 308 slash redirect. The group's auth-header,
     * `parseAuthHeaders`, `captureRawBody` and `verifyBodyDigest` hooks in
     * `routes.ts` skip it, so an anonymous request gets the refusal or the
     * redirect rather than a 401.
     */
    noAuth?: boolean
  }
  interface FastifyInstance {
    serverUrl: string
    /**
     * The control plane: the server backend that holds every Space and
     * Collection Metadata object, the policies, the registrations, the
     * keystores and the revocations, and the Resources of every Collection
     * selecting its fixed id. `serverBackends.controlPlane`.
     */
    storage: StorageBackend
    /**
     * The server's own backends under their fixed ids, with the `default`
     * alias and the control plane (lib/serverBackends.ts). The resolver
     * routes a Collection's data plane through it. Set by `fastify.decorate`
     * in plugin.ts.
     */
    serverBackends: ServerBackends
    /**
     * The provider-adapter registry: maps a registered backend's `provider` to
     * the factory that builds its live `StorageBackend` adapter. Read by the
     * resolver (lib/backendRegistry.ts). Empty in production this stage (no
     * real adapter yet); injected in tests. Set by `fastify.decorate` in
     * plugin.ts.
     */
    backendProviders: BackendProviderRegistry
    /**
     * The optional server-wide registration allowlist: the backend `provider`
     * names a client may register (config `WAS_ENABLED_BACKENDS`). `undefined`
     * means no allowlist -- any provider may be registered (permissive
     * default).
     */
    enabledBackendProviders?: string[]
    /**
     * The at-rest key-record encryption registry (config `KMS_RECORD_KEK` /
     * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`): the KEK(s) available to
     * unwrap stored WebKMS key records plus the
     * `currentKekId` selecting the one that wraps NEW records. `undefined` (or
     * `currentKekId: null`) means encryption is disabled -- records are written
     * plaintext (the teaching default). Read at the KMS orchestration seam
     * (`KeyRequest`), never inside a backend (records stay opaque to storage).
     * Set by `fastify.decorate` in plugin.ts.
     */
    kmsRecordKek?: KmsRecordKekRegistry
    /**
     * The server's export-signing key, derived from the seed (config
     * `WAS_SERVER_KEY_SEED`) and advertised on `/service`; `undefined` means
     * the server has no signing key. Set by `fastify.decorate` in plugin.ts.
     */
    serverSigningKey?: ServerSigningKey
    /**
     * The resolver for a peer server's `did:webvh`, the one foreign DID the
     * capability verifier may fetch over the network (see
     * `lib/peerWebvh.ts`). Passed to `handleZcapVerify` by the PWS route
     * families. Set by `fastify.decorate` in plugin.ts.
     */
    peerWebvh: PeerWebvhResolver
    /**
     * The pull loops of the Space replica registrations
     * (`sync/replication.ts`). The registration handlers start and stop a
     * loop through it and read a loop's status from it. Set by
     * `fastify.decorate` in plugin.ts.
     */
    replication: ReplicationManager
    /**
     * The optional provisioning gate for the open provisioning endpoints
     * (`POST /spaces/`, Create Space by Id, `POST /kms/keystores`).
     * `undefined` means allow (the teaching default -- anyone may provision by
     * proving control of the body's controller DID). Set by
     * `fastify.decorate` in plugin.ts, either from the `authorizeProvisioning`
     * option or the built-in onboarding-token check.
     */
    authorizeProvisioning?: AuthorizeProvisioning
    /**
     * Whether the service description's `instance` member carries the server
     * version (plugin option `discloseVersion`, config
     * `WAS_DISCLOSE_VERSION`). Read wherever a handler builds the description
     * outside the `/service` route -- today the Export Space handler, which
     * puts it in the archive. Set by `fastify.decorate` in plugin.ts.
     */
    discloseVersion: boolean
  }
  interface FastifyRequest {
    /**
     * Set by the provisioning gate when a request to a provisioning endpoint
     * was authorized by the configured provisioning policy (e.g. a valid
     * onboarding token) instead of a capability invocation. The group hook
     * chain wraps its auth and digest hooks in `unlessProvisioningAuthorized`,
     * which skips them when this is set, and the handler skips its
     * controller-consent check (the request carries a Bearer token, not an
     * HTTP Signature).
     */
    provisioningAuthorized?: boolean
    /**
     * Set by `consultProvisioningPolicy` once it has put this request to the
     * configured provisioning policy, so the policy is consulted at most once
     * per request.
     */
    provisioningPolicyConsulted?: boolean
    /**
     * Set by the `parseAuthHeaders` hook when an `Authorization` header is
     * present. Absent for an anonymous request, which a fallback policy may
     * grant when it is a read.
     */
    zcap?: ParsedZcap
    /**
     * The exact request body bytes, captured by the `captureRawBody`
     * preParsing hook for JSON/text bodies so `verifyBodyDigest` can recompute
     * the `Digest` header against what the client signed (re-serializing the
     * parsed body is not guaranteed byte-identical). Absent for streamed
     * (multipart / tar) bodies, which are left unbuffered.
     */
    rawBody?: Buffer
    /**
     * For a signed multipart body: the `Digest` verdict over the whole body,
     * settled at end-of-stream (rejects with `InvalidDigestError` on a
     * mismatch). Set by `captureRawBody`, awaited by the multipart write path
     * after the parts are consumed and before anything is stored.
     */
    multipartDigest?: Promise<void>
  }
}
