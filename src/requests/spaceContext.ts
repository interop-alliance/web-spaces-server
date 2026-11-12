/**
 * Shared handler prelude: fetch a Space (for its controller) and authorize the
 * request against a target. Nearly every handler repeats the same shape -- load
 * the Space Metadata object to get the controller key, build the capability's
 * `invocationTarget` URL, then check authorization -- so it lives here.
 *
 * Two entry points, one per authorization model, so the call site names which it
 * uses (rather than passing a flag):
 *
 * - `fetchSpaceAndAuthorize` -- **capability-or-policy**: capability invocation
 *   first, then the target's effective access-control policy as a fallback. For
 *   read/list endpoints that may be public-readable.
 * - `fetchSpaceAndVerify` -- **capability-only**: capability invocation, no
 *   policy fallback. For write/privileged endpoints and the controller-managed
 *   policy resource.
 */
import type { FastifyRequest } from 'fastify'
import { verifiedInvocation, verifyRequestZcap } from '../zcap.js'
import type { VerifiedInvocation } from '../zcap.js'
import type { ContainerRule } from '../lib/containerRule.js'
import { authorize } from '../authorize.js'
import { absoluteSpaceUrl, absoluteUrl } from '../lib/paths.js'
import { isUrlSafeSegment } from '../lib/validateId.js'
import {
  getCachedSpaceMetadata,
  invalidateSpaceMetadata
} from '../lib/spaceMetadataCache.js'
import { invalidateSpacePolicies } from '../lib/policyCache.js'
import { invalidateSpaceGovernedDescriptors } from '../lib/governedDescriptorsCache.js'
import { SpaceNotFoundError } from '../errors.js'
import type { StorageBackend, StoredSpaceMetadata } from '../types.js'

/**
 * Fetches a Space Metadata object or throws SpaceNotFoundError (404) when absent.
 * Memoized per storage backend (short TTL) because this is read on every
 * authorized handler; writes invalidate via `invalidateSpaceMetadata`
 * (`lib/spaceMetadataCache.ts`).
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<StoredSpaceMetadata>}
 */
async function getSpaceMetadataOrThrow({
  storage,
  spaceId,
  requestName
}: {
  storage: StorageBackend
  spaceId: string
  requestName: string
}): Promise<StoredSpaceMetadata> {
  const spaceMetadata = await getCachedSpaceMetadata({
    storage,
    spaceId
  })
  if (!spaceMetadata) {
    throw new SpaceNotFoundError({ requestName })
  }
  return spaceMetadata
}

/**
 * Loads a Space Metadata object by its URL param, masking an unknown (or
 * non-URL-safe) id as the 404 `SpaceNotFoundError` -- the PWS
 * existence-masking convention. The verification-free half of
 * `fetchSpaceAndVerify`, for handlers that need the controller before they can
 * build their expected values (the revocation route, whose invocation verifies
 * under the dual-root rule rather than the usual single root). The Space
 * analogue of `fetchKeystore` (keystoreContext.ts).
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server.storage`
 * @param options.spaceId {string}
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @returns {Promise<StoredSpaceMetadata>}
 */
export async function fetchSpace({
  request,
  spaceId,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  requestName: string
}): Promise<StoredSpaceMetadata> {
  // A non-URL-safe id cannot name a stored Space and must not reach the
  // filesystem layer: same 404 masking.
  if (!isUrlSafeSegment(spaceId)) {
    throw new SpaceNotFoundError({ requestName })
  }
  return await getSpaceMetadataOrThrow({
    storage: request.server.storage,
    spaceId,
    requestName
  })
}

/** The verified context every handler builds before touching storage. */
interface VerifiedSpaceContext {
  /** the fetched Space Metadata object (its controller authorized the request) */
  spaceMetadata: StoredSpaceMetadata
  /** the resolved invocationTarget URL the request was authorized against */
  allowedTarget: string
  /**
   * the Space's own URL, in its canonical trailing-slash (container) form --
   * the root capability target every space-family route also accepts for a
   * delegated chain that attenuates down to the request URL (a Space- or
   * Collection-scoped capability delegated by the controller). A capability
   * on the container covers its `meta` sub-resource, its members, and
   * everything beneath them (spec "Performing Authorized API Calls").
   */
  spaceRootTarget: string
}

/**
 * Loads the Space and builds the capability's invocationTarget URL -- the part
 * shared by both authorization models below. Does not check authorization.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server` for
 *   serverUrl + storage
 * @param options.spaceId {string}
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}/`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.spaceMetadata] {StoredSpaceMetadata}   an object
 *   the caller already read from storage, so it is not read again here
 * @returns {Promise<VerifiedSpaceContext>}
 */
async function fetchSpaceContext({
  request,
  spaceId,
  targetPath,
  requestName,
  spaceMetadata
}: {
  request: FastifyRequest
  spaceId: string
  targetPath: string
  requestName: string
  spaceMetadata?: StoredSpaceMetadata
}): Promise<VerifiedSpaceContext> {
  const { serverUrl, storage } = request.server
  spaceMetadata ??= await getSpaceMetadataOrThrow({
    storage,
    spaceId,
    requestName
  })
  const allowedTarget = absoluteUrl({ path: targetPath, serverUrl })
  const spaceRootTarget = absoluteSpaceUrl({ spaceId, serverUrl })
  return { spaceMetadata, allowedTarget, spaceRootTarget }
}

/**
 * Fetches the Space and AUTHORIZES the request **capability-or-policy**:
 * capability invocation first, then the target's effective access-control policy
 * as a fallback (see authorize.ts). Use for read/list endpoints that may be
 * public-readable. The action checked is the request's HTTP method, a `HEAD`
 * checked as `GET` (see `capabilityActionOf`). Returns the
 * fetched Space Metadata object so callers that also serve it (Read Space)
 * need not fetch it twice, and what granted the request (`grantedBy`), so a
 * handler can serve some parts of a read only under a capability.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   policy-resolution level
 * @param [options.resourceId] {string}   policy-resolution level
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}/`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.spaceMetadata] {StoredSpaceMetadata}   an object
 *   the caller already read from storage directly (Read Space, which serves it
 *   and decides its 304 on the stored state rather than the per-process
 *   cache), so the prelude does not read it again
 * @returns {Promise<VerifiedSpaceContext & { grantedBy: 'capability' | 'policy' }>}
 */
export async function fetchSpaceAndAuthorize({
  request,
  spaceId,
  collectionId,
  resourceId,
  targetPath,
  requestName,
  spaceMetadata,
  allowTargetQuery = false
}: {
  request: FastifyRequest
  spaceId: string
  collectionId?: string
  resourceId?: string
  targetPath: string
  requestName: string
  spaceMetadata?: StoredSpaceMetadata
  /**
   * When set, the capability-invocation path tolerates query parameters on
   * the request URL that extend `targetPath` (e.g. List Collection's
   * `?limit`/`cursor`), treating them as a RESTful attenuation of the same
   * target rather than a different one. See `verifyZcap`.
   */
  allowTargetQuery?: boolean
}): Promise<VerifiedSpaceContext & { grantedBy: 'capability' | 'policy' }> {
  const context = await fetchSpaceContext({
    request,
    spaceId,
    targetPath,
    requestName,
    spaceMetadata
  })
  const grantedBy = await authorize({
    request,
    allowedTarget: context.allowedTarget,
    spaceId,
    collectionId,
    resourceId,
    spaceController: context.spaceMetadata.controller,
    requestName,
    allowTargetQuery,
    attenuatedRootTarget: context.spaceRootTarget
  })
  return { ...context, grantedBy }
}

/**
 * Fetches the Space and VERIFIES the request **capability-only**: a valid
 * capability invocation is required, with no access-control-policy fallback (see
 * zcap.ts). Use for write/privileged endpoints and the controller-managed policy
 * resource. The action checked is the request's HTTP method, a `HEAD` checked
 * as `GET` (see `capabilityActionOf`). The Space's
 * revocation store is consulted on every delegated chain, so a revoked
 * capability fails here as it does on the `/kms` routes.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.spaceId {string}
 * @param options.targetPath {string}   the relative path of the capability's
 *   invocationTarget, resolved against serverUrl (e.g. `/space/${spaceId}/`)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.containerRule] {ContainerRule}   the container rule to
 *   apply, when the operation is an unsafe method at a container URL
 *   (`lib/containerRule.ts`). It is keyed on the Space's canonical
 *   trailing-slash URL, which this prelude already passes as
 *   `attenuatedRootTarget`.
 * @param [options.allowTargetQuery] {boolean}   tolerate query parameters on
 *   the request URL that extend `targetPath` (e.g. Get Policy's
 *   `?include=deleted`), so a controller's root invocation of the
 *   query-bearing URL verifies (see `verifyZcap`)
 * @returns {Promise<VerifiedSpaceContext & VerifiedInvocation>}   the context,
 *   plus the verified invocation's facts: whether it was of the Space's root
 *   capability itself rather than a delegated chain (`rootInvocation`), who
 *   signed it, and the delegated capability it invoked (`verifiedInvocation`)
 */
export async function fetchSpaceAndVerify({
  request,
  spaceId,
  targetPath,
  requestName,
  containerRule,
  allowTargetQuery = false
}: {
  request: FastifyRequest
  spaceId: string
  targetPath: string
  requestName: string
  containerRule?: ContainerRule
  allowTargetQuery?: boolean
}): Promise<VerifiedSpaceContext & VerifiedInvocation> {
  const context = await fetchSpaceContext({
    request,
    spaceId,
    targetPath,
    requestName
  })
  const result = await verifyRequestZcap({
    request,
    peerWebvh: true,
    allowedTarget: context.allowedTarget,
    spaceController: context.spaceMetadata.controller,
    requestName,
    attenuatedRootTarget: context.spaceRootTarget,
    allowTargetQuery,
    revocation: { storage: request.server.storage, scope: { spaceId } },
    containerRule
  })
  return { ...context, ...verifiedInvocation({ result }) }
}

/**
 * Drops every per-process cache entry a Space-wide write can leave stale: the
 * cached Space Metadata object, every policy cached at the Space level or
 * under any of its Collections/Resources, and every descriptor derived from a
 * governing log in the Space. For the writes that touch the whole Space
 * (Delete Space, Import Space). The `did:webvh` and replica caches differ
 * between them, so each caller drops those itself.
 * @param options {object}
 * @param options.storage {StorageBackend}   the backend the caches belong to
 * @param options.spaceId {string}
 * @returns {void}
 */
export function invalidateSpaceCaches({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): void {
  invalidateSpaceMetadata({ storage, spaceId })
  invalidateSpacePolicies({ storage, spaceId })
  invalidateSpaceGovernedDescriptors({ storage, spaceId })
}
