/**
 * Local resolution of a `did:webvh` Space controller whose history log this
 * server stores.
 *
 * A controller of the form
 * `did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>` publishes its
 * history log as `did.jsonl` in that Collection of that Space. When `<host>`
 * is *this* server, the log is that Resource here. When `<host>` is a
 * replication peer, the log is the copy in the local replica of that peer
 * Space, which a replica registration names (`lib/webvhLogLocation.ts`).
 * Either way the log is read straight out of storage -- never fetched over
 * the network -- so there is no liveness, SSRF, or bootstrap surface, and a
 * replicated account keeps resolving after its origin host is lost. The read
 * is the server reading its own storage, so it happens regardless of the
 * Collection's read policy: a capability-gated (non-public) Collection's DID
 * still resolves for authorization while staying unreadable to anyone
 * without a capability.
 *
 * The log's Space need not be the Space an invocation targets. The DID string
 * carries the log's own `spaceId`, and every read below is keyed off the
 * located log's local Space and Collection, so a Space controlled by a DID
 * whose log lives elsewhere resolves with no special casing. A replicated log
 * goes through the same verify, cache, head-record and fast-forward rules as a
 * self-hosted one, keyed by its local location, so the apply path's write of
 * the copy invalidates it like any other `did.jsonl` write.
 *
 * The log is **verified, not trusted**: writes to that Collection are
 * authorized by the Space controller, which after promotion is the very
 * document being resolved, so a compromised delegated write must not be able to
 * forge a controller document. The SCID pinned in the DID string plus full log
 * verification (hash chain, prerotation, update-key signatures) is what rules
 * that out, and both are done by `@interop/did-method-webvh` -- no resolver
 * logic grows here. Hosting a resolvable log under some Space's path confers no
 * authority on its own; a DID gains authority only by being referenced, as a
 * Space's stored controller or as a delegation's controller.
 *
 * Verified documents are cached per storage backend (the same backend-scoped
 * shape as the Space Metadata cache), keyed by the log's location, and
 * invalidated by writes that could change a log at that location. Past the
 * cache's TTL, a cached entry is cheaply revalidated rather than
 * unconditionally re-verified: the log Resource's content `ETag` is compared
 * against the one the entry was verified from, and the (expensive) log read
 * and verification are only repeated when that validator has moved, the
 * Resource is gone or has no validator, or the entry has reached the hard
 * re-verify age. See {@link resolveWebvhController}.
 *
 * The resolver also keeps, per DID, the head of the last log it verified (the
 * entry count and the head's `versionId`), and refuses a log that does not
 * extend it. Every prefix of a valid log is itself a valid log with the same
 * SCID, so verification alone would accept a truncated log and restore a key
 * a later entry retired. The HTTP write path already refuses such a write (a
 * `did.jsonl` PUT must fast-forward the stored bytes, and a `did.jsonl` DELETE
 * is refused outright); the record is what catches a rollback that reaches
 * storage by any other route. It survives a cache invalidation, and is
 * forgotten only when the log's Collection or Space is deleted
 * ({@link forgetDeletedWebvhLocation}), since a location re-created afterwards starts
 * a history of its own -- a restore re-creates the Space and imports an older
 * log by design. A replicated DID's record is kept by the DID alone and is
 * not forgotten on a delete, since its history is the origin's (see
 * {@link headKey}). The record is in memory, so a restart forgets it too.
 *
 * A foreign `did:webvh` with no stored log is resolved here too, through
 * `lib/peerWebvh.ts`, fetched from its host. It is reachable only through a
 * verification context that carries a peer grant for exactly that DID, which
 * the capability verifier issues after it has verified the delegation chain
 * naming the DID as invoker. Every other caller passes no grant, so for it a
 * foreign DID stays refused. A DID with a stored log never takes that path.
 *
 * The log is read from the backend that serves its Collection's data plane,
 * found through the resolver context's `serverBackends`; the control plane
 * `storage` alone locates it and keys the caches.
 */
import { buffer } from 'node:stream/consumers'
import { LRUCache } from 'lru-cache'
import {
  defaultWebvhLogVerifier,
  readLogFromString,
  resolveDID
} from '@interop/did-method-webvh'
import type { DIDDoc, DIDLog } from '@interop/did-method-webvh'
import {
  WEBVH_DOCUMENT_CACHE_MAX,
  WEBVH_DOCUMENT_CACHE_TTL,
  WEBVH_DOCUMENT_REVERIFY_AGE
} from '../config.default.js'
import { ProblemError, StorageError } from '../errors.js'
import { backendScoped, deleteByPrefix } from './backendCache.js'
import { WEBVH_LOG_RESOURCE_ID } from './validateDid.js'
import {
  locateWebvhLog,
  readWebvhLogResource,
  selfHostedLogLocation
} from './webvhLogLocation.js'
import type { StorageBackend } from '../types.js'
import type { ServerBackends } from './serverBackends.js'
import { etagOf } from './etag.js'
import type { PeerWebvhResolver } from './peerWebvh.js'

/**
 * What the resolver needs from the request layer: the control plane, which
 * locates a log and keys the caches, the set it belongs to, which serves the
 * log's bytes from the Collection's data plane, and this server's base URL
 * (which tells a self-hosted DID's host from a peer's). Threaded through the
 * verification path rather than held in module state, so two backends in one
 * process never resolve against each other.
 */
export interface WebvhResolverContext {
  storage: StorageBackend
  /**
   * The server backends `storage` is the control plane of. A log is read
   * from the backend that serves its Collection's data plane.
   */
  serverBackends: ServerBackends
  serverUrl: string
  /**
   * A foreign `did:webvh` this one verification may resolve without a
   * stored log. The capability verifier sets the network `resolver`, after
   * it verified the delegation chain that names `did` as its invoker, and it
   * serves only when this server stores no log for the DID. The replica
   * registration check sets the `document` it verified from a log read
   * through the pull capability. That one comes ahead of any stored log,
   * since the log is the source's own and a stored copy may be absent or
   * behind it. Absent, every foreign `did:webvh` with no stored log is
   * refused.
   */
  peer?: { did: string } & (
    { resolver: PeerWebvhResolver } | { document: DIDDoc }
  )
}

/**
 * A cached, verified controller document plus the bookkeeping revalidation
 * needs: `etag` is the log Resource's content `ETag` as of the read that
 * produced `doc` (`undefined` for a log with no validator, in which case the
 * entry is never cheaply revalidated -- see {@link reviseEntry}); `verifiedAt` is the `performance.now()` at which the
 * log was last fully verified. It is a monotonic-clock reading rather than a
 * wall-clock timestamp so a backward clock step cannot make a stale entry
 * read as fresh, and it is *not* refreshed by a cheap revalidation, which is
 * what lets {@link WEBVH_DOCUMENT_REVERIFY_AGE} bound how long a validator
 * match alone can keep an entry alive.
 */
interface WebvhCacheEntry {
  doc: DIDDoc
  etag: string | undefined
  verifiedAt: number
}

/**
 * Everything a fill or revalidation of one cache entry needs. `backend` is
 * the server backend that serves the log's Collection, resolved once per
 * fill by the cache's `fetchMethod` from the `serverBackends` its `context`
 * carries.
 */
interface WebvhFetchContext {
  storage: StorageBackend
  backend: StorageBackend
  did: string
  spaceId: string
  collectionId: string
  // False for a replicated copy of a peer-hosted log.
  selfHosted: boolean
}

/**
 * One LRU cache of verified controller documents per storage backend (see
 * `backendCache.ts` for the scoping rationale). It is an `lru-cache`
 * `LRUCache` used through `fetch()`, whose `fetchMethod` does both the cold
 * fill and the revalidation: concurrent callers for one key dedup onto the
 * single in-flight promise, a rejected fill or revalidation drops the slot,
 * and a revalidation receives the entry it is replacing as `staleValue`. The
 * cache carries no `lru-cache` `ttl`: freshness is decided by
 * {@link resolveWebvhController} from each entry's monotonic `verifiedAt`
 * (a `ttl` would use the same clock but could not serve the stale entry to
 * the revalidation), and a stale entry is refreshed by a `forceRefresh` fetch.
 *
 * An invalidation can land while a fill or revalidation for the same slot is
 * in flight (a `did.jsonl` PUT racing a resolve). The fetch may have read the
 * log from before that write, so its result must not stay cached, yet the
 * resolve waiting on it should still get the document it verified (the same
 * one it would have got a moment earlier). `lru-cache` gives exactly that
 * when the slot is deleted mid-fetch and `ignoreFetchAbort` is set: the
 * waiting `fetch()` resolves with the fetched value, and the value is only
 * written back if the slot still belongs to that fetch, which a deletion
 * makes false. But `keys()` hides a slot whose fetch is in flight, so an
 * invalidation walking only `keys()` would never delete it, and the
 * pre-write document would be cached until it aged out. The `inFlight` map
 * (key to the number of fetches running for it) is what lets
 * {@link invalidateResolvedWebvhDid} reach those slots too.
 */
const documentCaches = backendScoped(() => {
  const inFlight = new Map<string, number>()
  const cache = new LRUCache<
    string,
    WebvhCacheEntry,
    Omit<WebvhFetchContext, 'backend'> & { serverBackends: ServerBackends }
  >({
    max: WEBVH_DOCUMENT_CACHE_MAX,
    ignoreFetchAbort: true,
    fetchMethod: async (key, staleEntry, { context }) => {
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
      try {
        const { serverBackends, spaceId, collectionId } = context
        const fill = {
          ...context,
          backend: await serverBackends.dataBackendOf({ spaceId, collectionId })
        }
        return staleEntry
          ? await reviseEntry({ ...fill, entry: staleEntry })
          : await resolveVerifiedEntry(fill)
      } finally {
        const remaining = (inFlight.get(key) ?? 1) - 1
        if (remaining > 0) {
          inFlight.set(key, remaining)
        } else {
          inFlight.delete(key)
        }
      }
    }
  })
  return { cache, inFlight }
})

/**
 * A recorded log head: the number of entries in the log and the head entry's
 * `versionId`.
 */
export type LogHead = { count: number; versionId: string }

/**
 * The head of a non-empty log, as a {@link LogHead}.
 * @param log {DIDLog}   a log with at least one entry
 * @returns {LogHead}
 */
export function headOf(log: DIDLog): LogHead {
  return { count: log.length, versionId: log.at(-1)!.versionId }
}

/**
 * The DID a log's head entry names (its `state.id`), or `undefined` when the
 * log is empty or the head names none.
 * @param log {DIDLog}
 * @returns {string | undefined}
 */
export function logDid(log: DIDLog): string | undefined {
  const did: unknown = log.at(-1)?.state?.id
  return typeof did === 'string' ? did : undefined
}

/**
 * The head of the last log verified for each DID, per storage backend, keyed
 * by {@link headKey}: like the document cache for a self-hosted DID, and by
 * the DID alone for a replicated one. `count` is the number of
 * log entries and `versionId` the head entry's `versionId`, which commits to
 * every entry before it through the hash chain. Unbounded, but it only ever
 * holds DIDs that were resolved for authorization.
 *
 * `forgets` counts the calls to {@link forgetDeletedWebvhLocation}. A resolve reads
 * it before reading the log and records a head only if it has not moved
 * since, so a resolve still verifying when a Collection or Space is deleted
 * cannot record a head for the deleted location after it was forgotten. The
 * count is per backend rather than per location, so a delete anywhere also
 * skips the record of a resolve elsewhere; the next resolve records it.
 */
const logHeads = backendScoped(() => ({
  heads: new Map<string, LogHead>(),
  forgets: 0
}))

/**
 * Cache key: the log's local location (Space plus Collection) followed by the
 * DID. For a replicated log the location is the local replica's, not the one
 * the DID names. The location prefix is what makes invalidation by log
 * location possible; the
 * DID is part of the key because the same log resolves differently for a
 * different requested DID (a mismatched SCID must not be served a document
 * resolved for another one).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.did {string}
 * @returns {string}
 */
function cacheKey({
  spaceId,
  collectionId,
  did
}: {
  spaceId: string
  collectionId: string
  did: string
}): string {
  return `${locationPrefix({ spaceId, collectionId })}${did}`
}

/**
 * The key prefix every {@link cacheKey} anchored at a location starts with:
 * the Space's alone, or the Space's and one Collection's. Invalidation by log
 * location deletes by this prefix.
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @returns {string}
 */
function locationPrefix({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId?: string
}): string {
  return collectionId !== undefined
    ? `${spaceId}|${collectionId}|`
    : `${spaceId}|`
}

/**
 * The head-record key of a DID's log. A self-hosted DID's is its cache key,
 * so a delete of the log's Collection or Space forgets it, and a log
 * re-created there starts a history of its own. A replicated DID's is the DID
 * alone, outside every location prefix. Its history is the origin's, which
 * only grows, so the record holds across a change of the local Space that
 * keeps the copy: a second registration's older copy, or a copy left behind
 * when a registration goes, cannot pass for the head this server verified.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.did {string}
 * @param options.selfHosted {boolean}
 * @returns {string}
 */
function headKey({
  spaceId,
  collectionId,
  did,
  selfHosted
}: {
  spaceId: string
  collectionId: string
  did: string
  selfHosted: boolean
}): string {
  return selfHosted
    ? cacheKey({ spaceId, collectionId, did })
    : replicatedHeadKey(did)
}

/**
 * The head-record key of a replicated DID's log (see {@link headKey}).
 * @param did {string}
 * @returns {string}
 */
function replicatedHeadKey(did: string): string {
  return `|${did}`
}

/**
 * Drops cached controller documents whose history log a write could have
 * changed (or removed), so the next verification resolves the current log
 * rather than a stale document -- the `invalidateSpaceMetadata` pattern.
 *
 * Invalidation is keyed by the log's location. A Resource-scoped write path
 * passes both the `collectionId` and the `resourceId` it wrote: any Resource
 * other than `did.jsonl` returns early, and otherwise only that Collection's
 * entries are dropped. A Collection-scoped path (delete Collection) passes the
 * `collectionId` alone. A Space-scoped path (delete Space, import) passes
 * neither and drops every entry anchored in the Space.
 *
 * Cost bound: entries exist only for DIDs that were actually resolved for
 * authorization, i.e. DIDs some Space's stored controller or some delegation's
 * controller names. Scoping invalidation to the written Collection therefore
 * means a `did.jsonl` PUT into a Collection hosting no referenced DID deletes
 * nothing and forces no re-verification. Widening the gate from one magic
 * Collection to `did.jsonl`-in-any-Collection is not, as a result, an
 * amplification lever an ordinary Collection grant can pull.
 *
 * A capability-gated (non-public) Collection is treated no differently: its DID
 * resolves for authorization because the server reads its own storage
 * regardless of read policy, so its cached documents need the same
 * invalidation.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   the Collection that was written;
 *   when given, only that Collection's entries are invalidated
 * @param [options.resourceId] {string}   the Resource that was written; when
 *   given and not the history-log Resource, nothing is invalidated
 * @returns {void}
 */
export function invalidateResolvedWebvhDid({
  storage,
  spaceId,
  collectionId,
  resourceId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
  resourceId?: string
}): void {
  if (resourceId !== undefined && resourceId !== WEBVH_LOG_RESOURCE_ID) {
    return
  }
  // Only touch a cache that already exists for this backend.
  const caches = documentCaches.peek(storage)
  if (!caches) {
    return
  }
  const { cache, inFlight } = caches
  const prefix = locationPrefix({ spaceId, collectionId })
  // Settled slots and in-flight ones alike (see `documentCaches` for why the
  // latter are listed separately); deleting an in-flight slot lets its fetch
  // finish for whoever is waiting on it without writing the result back.
  deleteByPrefix(
    {
      keys: () => [...cache.keys(), ...inFlight.keys()],
      delete: key => cache.delete(key)
    },
    prefix
  )
}

/**
 * Forgets a location whose Collection or Space was deleted: drops its cached
 * documents ({@link invalidateResolvedWebvhDid}) and its recorded log heads,
 * so a log re-created there (a restore that re-creates the Space and imports
 * it) is not refused for failing to extend a history that no longer exists.
 * Called only on a container delete: a Resource write or an import keeps the
 * heads, which is what makes them a rollback check.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   the deleted Collection; when
 *   absent, every head recorded in the Space is forgotten
 * @returns {void}
 */
export function forgetDeletedWebvhLocation({
  storage,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
}): void {
  invalidateResolvedWebvhDid({ storage, spaceId, collectionId })
  const record = logHeads.peek(storage)
  if (!record) {
    return
  }
  record.forgets++
  deleteByPrefix(record.heads, locationPrefix({ spaceId, collectionId }))
}

/**
 * Reads a `<spaceId>/<collectionId>/did.jsonl` history log from storage, along
 * with the Resource's content `ETag` as of that same read (absent when it has
 * no validator). One read yields both, so the validator recorded on a cache
 * entry is exactly the validator of the log bytes that were verified -- there is no second read for a concurrent rewrite to
 * slip between.
 *
 * Only an absent log is a resolution failure. A backend fault (I/O, a
 * dropped database) that is not a problem already becomes a `StorageError`
 * (500), so it surfaces as a 5xx and is not masked as an unresolvable
 * controller.
 * @param options {object}
 * @param options.backend {StorageBackend}   the backend that serves the
 *   log's Collection
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<{ bytes: Buffer, etag: string | undefined } | undefined>}
 *   the raw JSON Lines log and its content `ETag`, or `undefined` when no log
 *   is stored there
 */
export async function readStoredLog({
  backend,
  spaceId,
  collectionId
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
}): Promise<{ bytes: Buffer; etag: string | undefined } | undefined> {
  try {
    const result = await readWebvhLogResource({
      backend,
      spaceId,
      collectionId
    })
    if (result === undefined) {
      return undefined
    }
    return { bytes: await buffer(result.resourceStream), etag: etagOf(result) }
  } catch (err) {
    if (!(err instanceof ProblemError)) {
      throw new StorageError({ cause: err as Error })
    }
    throw err
  }
}

/**
 * Resolves and fully verifies a `did:webvh` controller against its locally
 * stored history log, returning the verified DID document. The log is located
 * by `locateWebvhLog` on every call, before the cache is consulted, so a
 * removed replica registration stops a replicated DID resolving at once.
 *
 * Rejects with a plain `Error` (the caller decides the HTTP shape: a 400 at
 * promotion time, a failed verification during capability checking) when the
 * DID has no stored log here, the log is absent or unparseable, verification
 * fails, the resolved document names a different DID, or the DID is
 * deactivated.
 *
 * Caching has three tiers, all measured on the monotonic clock from the
 * entry's last full verification. Within {@link WEBVH_DOCUMENT_CACHE_TTL} a
 * cached entry is returned as-is -- nothing is read at all. Past it, the entry
 * is cheaply revalidated: the log Resource's content `ETag` (a metadata read,
 * not a log read) is compared against the one the entry was verified from.
 * An unchanged validator returns the same document without re-reading or
 * re-verifying the log; a changed one, an absent Resource, or an entry with
 * no validator (`etag` `undefined`) falls back to a full re-verify. Past
 * {@link WEBVH_DOCUMENT_REVERIFY_AGE} the log is fully re-verified regardless
 * of its validator: the validator is a change token for this process's own
 * writes and for writes from a sibling process sharing the backend, and the
 * hard age bounds how long a change that bypasses it (bytes rewritten out of
 * band) can pass unnoticed. Concurrent callers that observe the same stale entry dedup onto
 * one revalidation (or one full re-verify), the same way a concurrent cache
 * miss dedups onto one verification; the dedup, the stale-entry hand-off, and
 * the drop-on-rejection are `lru-cache`'s own `fetch()` behavior.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.serverBackends {ServerBackends}   the set it belongs to
 * @param options.serverUrl {string}   this server's base URL
 * @param options.did {string}   the controller DID to resolve
 * @param [options.keyId] {string}   the verification method a signature
 *   names. A peer DID's resolver may fetch its log once more for it; a local
 *   resolution ignores it
 * @param [options.peer] {object}   a peer grant for `did` alone: its
 *   `document` serves ahead of any stored log, its `resolver` when this
 *   server stores no log for the DID
 * @returns {Promise<DIDDoc>}   the verified controller document
 */
export async function resolveWebvhController({
  storage,
  serverBackends,
  serverUrl,
  did,
  keyId,
  peer
}: WebvhResolverContext & { did: string; keyId?: string }): Promise<DIDDoc> {
  const grant = peer?.did === did ? peer : undefined
  if (grant !== undefined && 'document' in grant) {
    return grant.document
  }
  // A self-hosted DID is located without an await, so its cache fetch starts
  // in this tick (see `documentCaches` on an invalidation racing a fetch).
  const location =
    selfHostedLogLocation({ serverUrl, did }) ??
    (await locateWebvhLog({ storage, serverUrl, did }))
  if (location === undefined) {
    if (grant !== undefined) {
      return keyId === undefined
        ? await grant.resolver.resolve({ did, serverUrl })
        : await grant.resolver.resolveKey({ did, keyId, serverUrl })
    }
    throw new Error(
      `"${did}" is not a did:webvh DID whose history log this server ` +
        'stores; only self-hosted and replicated did:webvh controllers are ' +
        'resolvable here.'
    )
  }
  const { spaceId, collectionId, selfHosted } = location
  const { cache } = documentCaches.for(storage)
  const key = cacheKey({ spaceId, collectionId, did })
  // `peek` sees through an in-flight refresh to the entry it is replacing, so
  // a caller arriving mid-revalidation still classifies the slot as stale and
  // joins that in-flight fetch (`forceRefresh` never starts a second one).
  const current = cache.peek(key)
  const stale =
    current !== undefined &&
    performance.now() - current.verifiedAt >= WEBVH_DOCUMENT_CACHE_TTL
  const entry = await cache.fetch(key, {
    forceRefresh: stale,
    context: { storage, serverBackends, did, spaceId, collectionId, selfHosted }
  })
  if (!entry) {
    // `fetchMethod` always resolves an entry or rejects; this is a type guard.
    throw new Error(`The history log for "${did}" could not be resolved.`)
  }
  return entry.doc
}

/**
 * Cheaply revalidates a stale cache entry, as the cache's `fetchMethod` for a
 * slot that already holds one. An entry with no tracked `etag`, or one whose
 * last full verification is {@link WEBVH_DOCUMENT_REVERIFY_AGE} or older, is
 * always fully re-verified. Otherwise the log Resource's current content
 * `ETag` is read; a match returns the entry unchanged (same document, same
 * `verifiedAt`, so the hard age keeps counting from the last real
 * verification), while a mismatch (or an absent Resource) falls back to a
 * full re-verify.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.backend {StorageBackend}
 * @param options.did {string}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.entry {WebvhCacheEntry}   the stale entry being revalidated
 * @returns {Promise<WebvhCacheEntry>}
 */
async function reviseEntry({
  entry,
  ...context
}: WebvhFetchContext & { entry: WebvhCacheEntry }): Promise<WebvhCacheEntry> {
  const { backend, spaceId, collectionId } = context
  const dueForReverify =
    performance.now() - entry.verifiedAt >= WEBVH_DOCUMENT_REVERIFY_AGE
  if (entry.etag !== undefined && !dueForReverify) {
    const metadata = await backend.getResourceMetadata({
      spaceId,
      collectionId,
      resourceId: WEBVH_LOG_RESOURCE_ID
    })
    if (metadata !== undefined && etagOf(metadata) === entry.etag) {
      return entry
    }
  }
  return await resolveVerifiedEntry(context)
}

/**
 * Fully verifies a `did:webvh` controller and pairs the resolved document with
 * the log Resource's content `ETag` as of the very read that was verified, for
 * {@link reviseEntry} to compare against later.
 *
 * @param options {WebvhFetchContext}
 * @returns {Promise<WebvhCacheEntry>}
 */
async function resolveVerifiedEntry(
  context: WebvhFetchContext
): Promise<WebvhCacheEntry> {
  const { doc, etag } = await resolveVerifiedDocument(context)
  return { doc, etag, verifiedAt: performance.now() }
}

/**
 * The uncached half of {@link resolveWebvhController}: read the log, verify it,
 * and check the resolved document against what was asked for. Returns the
 * verified document together with the log Resource's content `ETag` as of the
 * read that was verified.
 *
 * The verification itself is {@link verifyWebvhLog}; a deactivated DID is
 * refused here, since it can no longer authorize anything. A log that
 * declares witnesses is refused, self-hosted or replicated.
 *
 * @param options {WebvhFetchContext}
 * @returns {Promise<{ doc: DIDDoc, etag: string | undefined }>}
 */
async function resolveVerifiedDocument({
  storage,
  backend,
  did,
  spaceId,
  collectionId,
  selfHosted
}: WebvhFetchContext): Promise<{ doc: DIDDoc; etag: string | undefined }> {
  // Taken before the read, so a forget that lands while this resolve is
  // reading or verifying keeps it from recording a head below.
  const forgets = logHeadForgets({ storage })
  const stored = await readStoredLog({ backend, spaceId, collectionId })
  if (stored === undefined) {
    throw new Error(
      `No did:webvh history log is published at ` +
        `"${spaceId}/${collectionId}/${WEBVH_LOG_RESOURCE_ID}".`
    )
  }
  const { etag } = stored
  const logText = new TextDecoder().decode(stored.bytes)
  const { doc } = await verifyStoredLog({
    storage,
    did,
    spaceId,
    collectionId,
    selfHosted,
    logText,
    forgets
  })
  return { doc, etag }
}

/**
 * The count of location forgets on the head record of `storage`. A caller
 * takes it before it reads a log and hands it to {@link verifyStoredLog}, so a
 * Collection or Space delete that lands while the log is read or verified
 * keeps that call from recording a head.
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @returns {number}
 */
export function logHeadForgets({
  storage
}: {
  storage: StorageBackend
}): number {
  return logHeads.for(storage).forgets
}

/**
 * Verifies the text of a history log read from storage as the current log of
 * `did`, under the rules the resolver applies to its own read: it must extend
 * the head recorded for its location and verify
 * ({@link verifyCurrentLog}). Then records the log's head. The resolver
 * calls it after its read, and so does the server identity check
 * (`lib/serverIdentity.ts`), which reads its own log once and judges every
 * output of that read from the same bytes. Rejects with a plain `Error` when
 * the log does not verify.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.did {string}   the DID the log must resolve to
 * @param options.spaceId {string}   the log's local Space
 * @param options.collectionId {string}   the log's local Collection
 * @param options.selfHosted {boolean}   false for a replicated copy of a
 *   peer-hosted log
 * @param options.logText {string}   the log, as JSON Lines
 * @param options.forgets {number}   {@link logHeadForgets}, taken before the
 *   log was read
 * @returns {Promise<{ log: DIDLog, doc: DIDDoc }>}
 */
export async function verifyStoredLog({
  storage,
  did,
  spaceId,
  collectionId,
  selfHosted,
  logText,
  forgets
}: {
  storage: StorageBackend
  did: string
  spaceId: string
  collectionId: string
  selfHosted: boolean
  logText: string
  forgets: number
}): Promise<{ log: DIDLog; doc: DIDDoc }> {
  const record = logHeads.for(storage)
  const { heads } = record
  const key = headKey({ spaceId, collectionId, did, selfHosted })
  const { log, doc } = await verifyCurrentLog({
    did,
    logText,
    head: heads.get(key)
  })
  // A concurrent resolve may have recorded a longer head meanwhile; only move
  // the record forward.
  if (
    record.forgets === forgets &&
    log.length >= (heads.get(key)?.count ?? 0)
  ) {
    heads.set(key, headOf(log))
  }
  return { log, doc }
}

/**
 * Verifies the text of a history log as the current log of `did`: it parses,
 * extends `head`, verifies ({@link verifyWebvhLog}), and the DID it resolves
 * is not deactivated. Rejects with a plain `Error` otherwise.
 *
 * @param options {object}
 * @param options.did {string}   the DID the log must resolve to
 * @param options.logText {string}   the log, as JSON Lines
 * @param [options.head] {LogHead}   the head this server last verified
 * @returns {Promise<{ log: DIDLog, doc: DIDDoc }>}
 */
async function verifyCurrentLog({
  did,
  logText,
  head
}: {
  did: string
  logText: string
  head?: LogHead
}): Promise<{ log: DIDLog; doc: DIDDoc }> {
  let log: DIDLog
  try {
    log = readLogFromString(logText)
  } catch (err) {
    throw new Error(`The history log for "${did}" is not valid JSON Lines.`, {
      cause: err
    })
  }
  if (!extendsHead({ log, head })) {
    throw new Error(
      `The history log for "${did}" does not extend the last version ` +
        'this server verified.'
    )
  }
  const { doc, deactivated } = await verifyWebvhLog({ did, log })
  if (deactivated) {
    throw new Error(`The DID "${did}" has been deactivated.`)
  }
  return { log, doc }
}

/**
 * The current document of a peer-hosted `did:webvh`, from the text of its log
 * as a source server served it. The rules are those a stored copy resolves
 * under, the recorded head included, so a source cannot serve a prefix of a
 * log this server has verified further. Nothing is recorded: this log is not
 * the one stored here.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.did {string}   the DID the log must resolve to
 * @param options.logText {string}   the log, as JSON Lines
 * @returns {Promise<DIDDoc>}   the verified document
 */
export async function verifyPeerServedLog({
  storage,
  did,
  logText
}: {
  storage: StorageBackend
  did: string
  logText: string
}): Promise<DIDDoc> {
  const head = logHeads.for(storage).heads.get(replicatedHeadKey(did))
  const { doc } = await verifyCurrentLog({ did, logText, head })
  return doc
}

/**
 * Verifies a parsed history log as the log of `did`, without reading storage:
 * the library's SCID and requested-DID pinning, hash chain, prerotation, and
 * update-key signatures. Shared by resolution and by the `did.jsonl` write
 * rule, which verifies an append before it is stored.
 *
 * The log is handed to `resolveDID` through its `resolveControlledDid` hook,
 * and the witness proofs are an empty list, so nothing is fetched over the
 * network on any path. Left out, the library would fetch the DID's
 * `did-witness.json` from the host the log names for a log that declares
 * witnesses, with the global `fetch`, no address check, no timeout and no
 * size bound. That host is chosen by whoever wrote the log, so a log that
 * declares witnesses is refused instead. `resolveDID` reports failures in
 * the result envelope rather than throwing; they are rethrown here so callers
 * see one error channel. A deactivated DID still verifies; the caller decides
 * what that means.
 *
 * @param options {object}
 * @param options.did {string}   the DID the log must resolve to
 * @param options.log {DIDLog}
 * @returns {Promise<{ doc: DIDDoc, deactivated: boolean }>}
 */
export async function verifyWebvhLog({
  did,
  log
}: {
  did: string
  log: DIDLog
}): Promise<{ doc: DIDDoc; deactivated: boolean }> {
  const resolved = await resolveDID(did, {
    verifier: defaultWebvhLogVerifier,
    resolveControlledDid: async () => log,
    witnessProofs: []
  })
  const { error, message } = resolved.didResolutionMetadata
  if (error) {
    throw new Error(
      `Could not verify the history log for "${did}": ${error}` +
        (message ? ` (${message})` : '')
    )
  }
  // This package's DIDDoc is structurally looser than the resolution
  // envelope's IDIDDocument; the library casts at the same boundary.
  const doc = resolved.didDocument as DIDDoc | null
  if (!doc) {
    throw new Error(`The history log for "${did}" resolved to no document.`)
  }
  if (doc.id !== did) {
    throw new Error(
      `The history log resolved to "${doc.id}", not the requested "${did}".`
    )
  }
  return {
    doc,
    deactivated: resolved.didDocumentMetadata.deactivated === true
  }
}

/**
 * Whether a log extends a recorded head: it holds at least `head.count`
 * entries, and the entry at that position carries the recorded `versionId`.
 * A log with no recorded head extends nothing and passes.
 *
 * @param options {object}
 * @param options.log {DIDLog}
 * @param [options.head] {LogHead}
 * @returns {boolean}
 */
export function extendsHead({
  log,
  head
}: {
  log: DIDLog
  head?: LogHead
}): boolean {
  if (!head) {
    return true
  }
  return log[head.count - 1]?.versionId === head.versionId
}

/**
 * The verification method a resolved document lists under exactly the id
 * `id`, or `undefined` when it lists none.
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved DID document
 * @param options.id {string}   the fully-qualified method id (`did#fragment`)
 * @returns {NonNullable<DIDDoc['verificationMethod']>[number] | undefined}
 */
export function findVerificationMethod({
  doc,
  id
}: {
  doc: DIDDoc
  id: string
}): NonNullable<DIDDoc['verificationMethod']>[number] | undefined {
  return (doc.verificationMethod ?? []).find(method => method.id === id)
}

/**
 * The absolute method ids one verification relationship names. The document
 * comes verbatim from a verified log, and DID Core lets a relationship entry
 * be an id-reference string (absolute or `#fragment`-relative) or an embedded
 * verification-method object, so entries are normalized to absolute ids
 * before any comparison -- an unnormalized match would misclassify a method
 * listed in a non-string form.
 * @param options {object}
 * @param options.entries {unknown}   the relationship value from the document
 * @param options.docId {string}   the document id, the base for relative refs
 * @returns {string[]}
 */
export function relationshipMethodIds({
  entries,
  docId
}: {
  entries: unknown
  docId: string
}): string[] {
  const ids: string[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id =
      typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id
    if (typeof id !== 'string') {
      continue
    }
    ids.push(id.startsWith('#') ? `${docId}${id}` : id)
  }
  return ids
}

/** JSON-LD context for `Multikey` verification methods. */
const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1'

/**
 * Dereferences a `did#fragment` to its verification-method (or service) node
 * within a resolved DID document, attaching an appropriate JSON-LD `@context`.
 * Mirrors the library driver's own fragment dereferencing -- which cannot be
 * reused directly because that driver's `get()` fetches the log over the
 * network, the one thing this server never does.
 *
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved DID document
 * @param options.id {string}   the fully-qualified node id (`did#fragment`)
 * @returns {Record<string, unknown>}   the matched node, with an `@context`
 */
export function dereferenceFragment({
  doc,
  id
}: {
  doc: DIDDoc
  id: string
}): Record<string, unknown> {
  const entries = [
    ...(doc.verificationMethod ?? []),
    ...(doc.service ?? [])
  ] as Array<Record<string, unknown>>
  const match = entries.find(entry => entry?.id === id)
  if (!match) {
    throw new Error(`DID document entity with id "${id}" not found.`)
  }
  const context = match.type === 'Multikey' ? MULTIKEY_CONTEXT : doc['@context']
  return { '@context': context, ...structuredClone(match) }
}

/**
 * Builds a did-io-shaped `{ method, get }` driver over the local resolver, for
 * registration on the document loader's DID resolver
 * (`securityLoader({ didResolver })`). A bare DID resolves to its verified
 * document; a `did#fragment` URL dereferences straight to that node -- which is
 * what lets the jsigs purpose check confirm a verification method is listed
 * under the controller document's `capabilityInvocation` /
 * `capabilityDelegation`.
 *
 * @param options {WebvhResolverContext}
 * @returns {{ method: string, get: (options: { did?: string, url?: string })
 *   => Promise<Record<string, unknown>> }}
 */
export function webvhDidResolverDriver({
  storage,
  serverBackends,
  serverUrl,
  peer
}: WebvhResolverContext) {
  return {
    method: 'webvh',
    async get({
      did,
      url
    }: {
      did?: string
      url?: string
    }): Promise<Record<string, unknown>> {
      const didOrUrl = did ?? url
      if (!didOrUrl) {
        throw new TypeError('A DID or a URL is required to resolve.')
      }
      // Separate the bare DID from any `?query` or `#fragment`.
      const [didAuthority = ''] = didOrUrl.split(/[#?]/)
      const fragment = didOrUrl.includes('#')
        ? didOrUrl.slice(didOrUrl.indexOf('#') + 1)
        : undefined
      const doc = await resolveWebvhController({
        storage,
        serverBackends,
        serverUrl,
        did: didAuthority,
        peer
      })
      if (fragment) {
        return dereferenceFragment({ doc, id: `${doc.id}#${fragment}` })
      }
      return doc as Record<string, unknown>
    }
  }
}
