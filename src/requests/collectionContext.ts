/**
 * Shared handler prelude: fetch a Collection Metadata object or 404 (paralleling
 * spaceContext.ts / keystoreContext.ts). Nearly every Collection- and
 * Resource-level handler repeats the same shape after authorization -- load
 * the Collection Metadata object for context, throw `CollectionNotFoundError`
 * when absent, then resolve the Collection's data-plane backend -- so it lives
 * here, along with the Resource-Metadata and chunk-metadata reads the
 * Resource- and chunk-level handlers share.
 */
import type { FastifyRequest } from 'fastify'
import { createdByOf } from '../auth-header-hooks.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import { DEFAULT_BACKEND_ID } from '../lib/serverBackends.js'
import { parseKeyEpochHeader } from '../lib/keyEpoch.js'
import { stripMetadataValidator } from '../lib/metadataValidator.js'
import { parseWriterIdHeader } from '../lib/writerAttribution.js'
import { getCachedGovernedDescriptors } from '../lib/governedDescriptorsCache.js'
import { collectionPath, linksetPath } from '../lib/paths.js'
import { isImmutableCollection } from '../lib/revisions.js'
import {
  CollectionNotFoundError,
  ResourceNotFoundError,
  UnauthorizedError
} from '../errors.js'
import { ownsResource } from '../lib/ownResourcesOnly.js'
import { policyGrantsRequest } from '../authorize.js'
import { withStorageErrors } from '../lib/storageErrors.js'
import type { VerifiedInvocation } from '../zcap.js'
import type {
  ChunkMetadata,
  CollectionMetadata,
  IDID,
  ImmutableUnder,
  ResourceMetadata,
  StorageBackend,
  StoredCollectionMetadata
} from '../types.js'

/**
 * Projects a stored Collection Metadata object into the one served: the
 * stored body without its out-of-band `ETag` validator, `type` sorted
 * lexically (spec SHOULD), the selected backend default-filled for a
 * Collection stored without one (spec: an unset backend is `default`), and
 * the Collection's self `url` (the canonical trailing-slash container form)
 * and `linkset` (policy discovery), both relative. Read Collection Metadata
 * and the create echoes (Create Collection, and the create-by-`PUT` of the
 * Metadata object) all go through it, so a create response and a Read right
 * after it agree.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.collectionMetadata {CollectionMetadata}   the stored object
 *   (a validator-bearing read result is accepted; the validator is stripped)
 * @returns {CollectionMetadata}
 */
export function projectCollectionMetadata({
  spaceId,
  collectionId,
  collectionMetadata
}: {
  spaceId: string
  collectionId: string
  collectionMetadata: CollectionMetadata
}): CollectionMetadata {
  const body = stripMetadataValidator(collectionMetadata)
  return {
    ...body,
    type: [...body.type].sort(),
    backend: body.backend ?? { id: DEFAULT_BACKEND_ID },
    url: collectionPath({ spaceId, collectionId }),
    linkset: linksetPath({ spaceId, collectionId })
  }
}

/**
 * Fetches a Collection Metadata object as served, or throws
 * CollectionNotFoundError (404) when absent. The out-of-band validator parts
 * (`metaGeneration` / `metaLocal`) ride along. For a Collection governed by
 * a history log (the `governed-history-logs` feature) the `encryption` and
 * `revisions` members are derived here from the log head, so every handler
 * that reads the object through this prelude -- Read Collection Metadata, the
 * envelope enforcement and the write-once rule on writes, the listing's name
 * suppression -- sees the governed descriptors. The stored object carries no
 * `encryption` for such a Collection; a direct write of the member is
 * refused. A stored `revisions` member is replaced by the derived one, and
 * dropped when the head carries none. The derivation is memoized per backend
 * by the log's validator (`lib/governedDescriptorsCache.ts`), which is read
 * with the object, so the log's body is read only on a cache miss. Update
 * Collection reads the stored object directly instead, since it must not
 * persist the derived members, and its recheck under the backend's lock calls
 * `getCachedGovernedDescriptors` with the lock-consistent log.
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 *   and `serverUrl`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<StoredCollectionMetadata>}
 */
export async function getCollectionOrThrow({
  request,
  spaceId,
  collectionId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  requestName: string
}): Promise<StoredCollectionMetadata> {
  const { storage, serverUrl } = request.server
  const stored = await storage.getCollectionMetadataAndLogValidator({
    spaceId,
    collectionId
  })
  if (!stored) {
    throw new CollectionNotFoundError({ requestName })
  }
  const { collectionMetadata, logValidator } = stored
  const governed = await getCachedGovernedDescriptors({
    storage,
    serverUrl,
    spaceId,
    collectionId,
    logValidator,
    readLog: () => storage.getCollectionLog({ spaceId, collectionId })
  })
  if (governed === undefined) {
    return collectionMetadata
  }
  const { revisions: _storedRevisions, ...rest } = collectionMetadata
  return {
    ...rest,
    encryption: governed.encryption,
    ...(governed.revisions !== undefined && { revisions: governed.revisions })
  }
}

/**
 * What a Resource or chunk write handler hands the backend for the write-once
 * rule (`revisions.immutable`). A Collection the handler already read as
 * write-once passes `true`, since the flag is never taken back. Any other
 * Collection passes a recheck callback, which the backend calls inside
 * the write's critical section with the governing history log it reads
 * there. The handler's own read ran before that lock, and a log's guarded
 * create can declare `immutable` on an existing Collection in between. No
 * other write can set the flag afterward, so the log is the only thing the
 * backend re-reads.
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 *   and `serverUrl`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.collectionMetadata {CollectionMetadata}   the Collection
 *   Metadata object as served, read before the lock
 * @returns {{ immutable: true | ImmutableUnder }}
 */
export function writeOnceOptions({
  request,
  spaceId,
  collectionId,
  collectionMetadata
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  collectionMetadata: Pick<CollectionMetadata, 'revisions'>
}): { immutable: true | ImmutableUnder } {
  if (isImmutableCollection(collectionMetadata)) {
    return { immutable: true }
  }
  const { storage, serverUrl } = request.server
  return {
    immutable: async ({ log }) => {
      const governed = await getCachedGovernedDescriptors({
        storage,
        serverUrl,
        spaceId,
        collectionId,
        logValidator: log?.validator,
        readLog: async () => log
      })
      return isImmutableCollection(governed ?? {})
    }
  }
}

/**
 * The write options a Resource content write (Create Resource, Put Resource)
 * derives from the request and its Collection, beside the id, the input and
 * any precondition:
 *
 * - `epoch`: a content write into an encrypted Collection MAY declare the
 *   key epoch it encrypted under via the `Key-Epoch` header (the
 *   `key-epochs` feature); the server stores it opaquely and clears it when
 *   absent (the new ciphertext's epoch is unknown -- a stale stamp is worse
 *   than none). Advisory, non-signature-covered metadata.
 * - `writerId`: the writer-attribution label (spec "Writer attribution") MAY
 *   be declared the same way, via the `Writer-Id` header; the server stores
 *   it opaquely and clears it when absent (declare-or-clear).
 * - `immutable`: a write-once Collection (`revisions.immutable`): the backend
 *   refuses a write that would change a live Resource's bytes and answers a
 *   repeat of them with the current `ETag`, atomically with the write (see
 *   {@link writeOnceOptions}).
 * - `createdBy`: the DIDs of the delegation chain the request verified
 *   under, the invoker last (`createdByOf`).
 *
 * The Collection's `unique: true` plaintext index declarations are not an
 * option: the backend reads them under its own lock, so a declaration landing
 * between this read and the write still binds it.
 *
 * A malformed `Key-Epoch` or `Writer-Id` header is a 400, thrown here.
 * @param options {object}
 * @param options.request {FastifyRequest}   the write request
 * @param options.invocation {VerifiedInvocation}   the facts of the
 *   invocation the request verified, as its authorization returned them
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.collectionMetadata {CollectionMetadata}   the Collection
 *   Metadata object as served, read before the lock
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {object}   the options, to spread into `writeResource`
 */
export function resourceWriteOptions({
  request,
  invocation,
  spaceId,
  collectionId,
  collectionMetadata,
  requestName
}: {
  request: FastifyRequest
  invocation: VerifiedInvocation
  spaceId: string
  collectionId: string
  collectionMetadata: Pick<CollectionMetadata, 'revisions'>
  requestName: string
}): Pick<
  Parameters<StorageBackend['writeResource']>[0],
  'createdBy' | 'epoch' | 'writerId' | 'immutable'
> {
  const { epoch } = parseKeyEpochHeader({
    headers: request.headers,
    requestName
  })
  const { writerId } = parseWriterIdHeader({
    headers: request.headers,
    requestName
  })
  return {
    createdBy: createdByOf({ request, invocation }),
    epoch,
    writerId,
    ...writeOnceOptions({
      request,
      spaceId,
      collectionId,
      collectionMetadata
    })
  }
}

/**
 * Whether a Collection's data-plane backend is the control-plane store
 * (`request.server.storage`), the one store that keeps access-control
 * policies. A Collection on a registered external backend keeps its
 * Resources there and no policies. The rules that tie a Resource-level policy
 * to its Resource read this. Put Policy requires a live Resource only when it
 * holds, and Delete Resource tombstones the policy in a second write only
 * when it does not.
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.dataBackend {StorageBackend}   the Collection's resolved
 *   data-plane backend
 * @returns {boolean}
 */
export function isControlPlaneBackend({
  request,
  dataBackend
}: {
  request: FastifyRequest
  dataBackend: StorageBackend
}): boolean {
  return dataBackend === request.server.storage
}

/**
 * The pair every Collection-scoped handler needs before it can touch Resource
 * bytes: the Collection Metadata object (404 when absent) plus the Collection's
 * selected (data-plane) backend, resolved from it. Only for handlers that run
 * the two back to back -- a handler with a validation step BETWEEN them (whose
 * error must precede a backend-resolution error) keeps the calls separate.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<{ collectionMetadata: StoredCollectionMetadata,
 *   dataBackend: StorageBackend }>}
 */
export async function fetchCollectionAndBackend({
  request,
  spaceId,
  collectionId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  requestName: string
}): Promise<{
  collectionMetadata: StoredCollectionMetadata
  dataBackend: StorageBackend
}> {
  const collectionMetadata = await getCollectionOrThrow({
    request,
    spaceId,
    collectionId,
    requestName
  })
  const dataBackend = await resolveBackend({
    request,
    spaceId,
    collectionId,
    collectionMetadata
  })
  return { collectionMetadata, dataBackend }
}

/**
 * Reads a Resource's Metadata object from a data-plane backend, throwing
 * `ResourceNotFoundError` (404) when the Resource does not exist (or is a
 * tombstone). A typed `ProblemError` the backend raises is rethrown unchanged;
 * anything unexpected is wrapped as a 500.
 *
 * Serves both the Metadata-returning handlers (Head Resource, Get Resource
 * Metadata) and the chunk handlers' parent-Resource existence gate -- an orphan
 * chunk of an absent parent 404s exactly like the Resource route does.
 *
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data-plane
 *   backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<ResourceMetadata & { generation?: string }>}
 */
export async function getResourceMetadataOrThrow({
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  requestName: string
}): Promise<ResourceMetadata & { generation?: string }> {
  const metadata = await withStorageErrors({ requestName }, () =>
    dataBackend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId
    })
  )
  if (!metadata) {
    throw new ResourceNotFoundError({ requestName })
  }
  return metadata
}

/**
 * Reads a chunk's stored metadata (content-type, size, validator parts)
 * through the parent-Resource existence gate, or throws
 * `ResourceNotFoundError` (404) when the parent or the chunk is absent. Shared by Head Chunk (its payload
 * headers) and by Get Chunk's conditional-read check, which needs the chunk's
 * validator before deciding whether to open the byte stream.
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data-plane
 *   backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}   the parent Resource
 * @param options.chunkIndex {number}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<ChunkMetadata>}
 */
export async function readChunkMetadataOrThrow({
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  chunkIndex,
  requestName
}: {
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: number
  requestName: string
}): Promise<ChunkMetadata> {
  const metadata = await withStorageErrors({ requestName }, () =>
    readGatedOnParentResource({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      companion: dataBackend.getChunkMetadata({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex
      }),
      requestName
    })
  )
  if (!metadata) {
    throw new ResourceNotFoundError({ requestName })
  }
  return metadata
}

/**
 * The chunk handlers' parent-Resource existence gate, run alongside an
 * independent companion read of the same backend (a chunk's bytes, its
 * metadata, or the chunk listing). The two reads are issued together and
 * settled, then the serial precedence applies: a rejected parent read wins
 * first, then the parent-absent 404 (`ResourceNotFoundError`), then a rejected
 * companion read; otherwise the companion's value is returned. Settling
 * (rather than `Promise.all`) keeps a companion rejection from masking the 404
 * and leaves no unhandled rejection when the gate short-circuits.
 *
 * A companion value that resolved while the gate fails is discarded, and the
 * gate hands it to `discard` first so the caller can release whatever it
 * holds: a chunk byte stream has already opened its file descriptor by the
 * time the filesystem backend resolves it, and left alone it would leak one
 * per probe of an orphan chunk.
 *
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data-plane
 *   backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}   the parent Resource
 * @param options.companion {Promise<T>}   the independent read, already
 *   started
 * @param [options.discard] {(value: T) => void}   releases a companion value
 *   the gate discards
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<T>}
 */
export async function readGatedOnParentResource<T>({
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  companion,
  discard,
  requestName
}: {
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  companion: Promise<T>
  discard?: (value: T) => void
  requestName: string
}): Promise<T> {
  const [parentResult, companionResult] = await Promise.allSettled([
    dataBackend.getResourceMetadata({ spaceId, collectionId, resourceId }),
    companion
  ])
  if (parentResult.status === 'rejected' || !parentResult.value) {
    if (companionResult.status === 'fulfilled') {
      discard?.(companionResult.value)
    }
    if (parentResult.status === 'rejected') {
      throw parentResult.reason
    }
    throw new ResourceNotFoundError({ requestName })
  }
  if (companionResult.status === 'rejected') {
    throw companionResult.reason
  }
  return companionResult.value
}

/**
 * Decides a read at a Resource URL, at its `meta` URL or at a chunk URL
 * beneath it, for a request authorized under `OwnResourcesOnly` caveats. The
 * Resource must list every principal in its `createdBy`. One that does not is
 * still served when the Resource's access-control policy grants the read to
 * everyone, since the caveat narrows the capability and a policy is a
 * separate grant. Otherwise the request is refused as the masked `not-found`.
 * An absent Resource is the 404 it is for any reader.
 *
 * With no principals the request carries no caveat to check, and nothing is
 * read.
 *
 * A read the Resource's `createdBy` decided resolves an {@link OwnRead}. The
 * handler checks the record it then serves against it
 * ({@link assertOwnReadServed}), since the id may be deleted and created
 * again by another party between the two reads. A read with no caveat, or
 * one a policy granted, resolves `undefined`.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies the control plane and
 *   the logger
 * @param options.dataBackend {StorageBackend}   the Collection's data plane
 * @param [options.ownResourcesOnly] {IDID[]}   the principals of the chain's
 *   caveats, one per caveat
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<OwnRead | undefined>}
 */
async function assertOwnResourceRead({
  request,
  dataBackend,
  ownResourcesOnly,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  request: FastifyRequest
  dataBackend: StorageBackend
  ownResourcesOnly?: IDID[]
  spaceId: string
  collectionId: string
  resourceId: string
  requestName: string
}): Promise<OwnRead | undefined> {
  if (ownResourcesOnly === undefined) {
    return undefined
  }
  const { createdBy, createdAt } = await getResourceMetadataOrThrow({
    dataBackend,
    spaceId,
    collectionId,
    resourceId,
    requestName
  })
  if (ownsResource({ ownedBy: ownResourcesOnly, createdBy })) {
    return { ownedBy: ownResourcesOnly, createdAt }
  }
  await assertPolicyGrantsRead({
    request,
    spaceId,
    collectionId,
    resourceId,
    requestName
  })
  return undefined
}

/**
 * What a read under `OwnResourcesOnly` caveats was decided from: the
 * principals, and the `createdAt` of the Resource whose `createdBy` listed
 * every one of them.
 */
export interface OwnRead {
  ownedBy: IDID[]
  createdAt?: string
}

/**
 * Requires that the record a handler serves is the principals' own, for a
 * read under `OwnResourcesOnly` caveats decided from an earlier read of the
 * Resource. A Resource deleted and created again by another party keeps its
 * id and generation and records a new `createdBy`, so the check reads the
 * `createdBy` of the served record itself. A record that fails it is refused
 * as the masked `not-found`. With no `ownRead` the read was not decided from
 * a record, and it passes.
 *
 * @param options {object}
 * @param [options.ownRead] {OwnRead}   what the read was decided from
 * @param [options.createdBy] {unknown}   the served record's `createdBy`
 * @param options.requestName {string}   request name used in error titles
 * @returns {void}
 * @throws {UnauthorizedError}
 */
export function assertOwnReadServed({
  ownRead,
  createdBy,
  requestName
}: {
  ownRead?: OwnRead
  createdBy?: unknown
  requestName: string
}): void {
  if (
    ownRead !== undefined &&
    !ownsResource({ ownedBy: ownRead.ownedBy, createdBy })
  ) {
    throw new UnauthorizedError({ requestName })
  }
}

/**
 * The same check for a read that serves a chunk or the chunk listing, whose
 * record carries no `createdBy`. The parent Resource's Metadata is read again
 * after the served read. It must still be the principals' own, with the
 * `createdAt` the read was decided from. A chunk never outlives its parent,
 * and a create over a tombstone records a new `createdAt`, so the chunk
 * belonged to the Resource that was checked. With no `ownRead` nothing is
 * read.
 *
 * @param options {object}
 * @param [options.ownRead] {OwnRead}   what the read was decided from
 * @param options.dataBackend {StorageBackend}   the Collection's data plane
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<void>}
 * @throws {UnauthorizedError}
 */
export async function assertOwnReadOfParentServed({
  ownRead,
  dataBackend,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  ownRead?: OwnRead
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId: string
  requestName: string
}): Promise<void> {
  if (ownRead === undefined) {
    return
  }
  const parent = await withStorageErrors({ requestName }, () =>
    dataBackend.getResourceMetadata({ spaceId, collectionId, resourceId })
  )
  if (!parent || parent.createdAt !== ownRead.createdAt) {
    throw new UnauthorizedError({ requestName })
  }
  assertOwnReadServed({ ownRead, createdBy: parent.createdBy, requestName })
}

/**
 * Requires that the target's effective access-control policy grants the read
 * to everyone, for a read the request's capability does not reach under its
 * `OwnResourcesOnly` caveat. Refuses with the masked `not-found` otherwise.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies the control plane and
 *   the logger
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.resourceId] {string}   policy-resolution level
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<void>}
 */
export async function assertPolicyGrantsRead({
  request,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  resourceId?: string
  requestName: string
}): Promise<void> {
  const granted = await policyGrantsRequest({
    request,
    action: 'read',
    spaceId,
    collectionId,
    resourceId
  })
  if (!granted) {
    throw new UnauthorizedError({ requestName })
  }
}

/**
 * Refuses a write under `OwnResourcesOnly` caveats to a live Resource the
 * principals did not create, ahead of a handler step that reads the stored
 * Resource before the backend's own check. The backend still decides the
 * write inside its critical section. An absent Resource passes, since a
 * write there creates.
 *
 * @param options {object}
 * @param options.dataBackend {StorageBackend}   the Collection's data plane
 * @param [options.ownResourcesOnly] {IDID[]}   the principals of the chain's
 *   caveats, one per caveat
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<void>}
 */
export async function assertOwnResourceBeforeWrite({
  dataBackend,
  ownResourcesOnly,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  dataBackend: StorageBackend
  ownResourcesOnly?: IDID[]
  spaceId: string
  collectionId: string
  resourceId: string
  requestName: string
}): Promise<void> {
  if (ownResourcesOnly === undefined) {
    return
  }
  const metadata = await withStorageErrors({ requestName }, () =>
    dataBackend.getResourceMetadata({ spaceId, collectionId, resourceId })
  )
  if (
    metadata &&
    !ownsResource({ ownedBy: ownResourcesOnly, createdBy: metadata.createdBy })
  ) {
    throw new UnauthorizedError({ requestName })
  }
}

/**
 * Resolves the data-plane backend of a Collection for a read at a Resource
 * URL or at its `meta` URL, and decides the read for a request authorized
 * under `OwnResourcesOnly` caveats ({@link assertOwnResourceRead}). The
 * caller passes the resolved `ownRead` to {@link assertOwnReadServed} or
 * {@link assertOwnReadOfParentServed} once it holds what it serves.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies the control plane and
 *   the logger
 * @param [options.ownResourcesOnly] {IDID[]}   the principals of the chain's
 *   caveats, one per caveat
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<{ dataBackend: StorageBackend, ownRead?: OwnRead }>}
 */
export async function fetchBackendForResourceRead({
  request,
  ownResourcesOnly,
  spaceId,
  collectionId,
  resourceId,
  requestName
}: {
  request: FastifyRequest
  ownResourcesOnly?: IDID[]
  spaceId: string
  collectionId: string
  resourceId: string
  requestName: string
}): Promise<{ dataBackend: StorageBackend; ownRead?: OwnRead }> {
  const { dataBackend } = await fetchCollectionAndBackend({
    request,
    spaceId,
    collectionId,
    requestName
  })
  const ownRead = await assertOwnResourceRead({
    request,
    dataBackend,
    ownResourcesOnly,
    spaceId,
    collectionId,
    resourceId,
    requestName
  })
  return { dataBackend, ownRead }
}
