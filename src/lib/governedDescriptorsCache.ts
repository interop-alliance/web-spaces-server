/**
 * The memoized derivation of a log-governed Collection's `encryption` and
 * `revisions` members (the `governed-history-logs` feature), shared by every
 * handler that reads a Collection Metadata object through
 * `getCollectionOrThrow` and by Update Collection's checks. Deriving the
 * members means parsing the whole
 * history log, which is append-only and grows without bound, so the result
 * is memoized per storage backend. An entry is keyed by the Collection and
 * by the log's own validator (its generation and write stamp): a log write
 * leaves the stored validator behind, so the next derivation is a miss on a
 * new key rather than a stale hit, and the recheck a Metadata write runs
 * under the backend's lock sees whatever head the lock-time log carries. No
 * write therefore needs to invalidate the cache for correctness. Delete
 * Collection, Delete Space, and Import Space still drop a Collection's
 * entries, so a removed or replaced log leaves none behind.
 */
import { LruCache } from '@interop/lru-memoize'
import {
  GOVERNED_DESCRIPTORS_CACHE_MAX,
  GOVERNED_DESCRIPTORS_CACHE_TTL
} from '../config.default.js'
import type { CollectionLogResult, StorageBackend } from '../types.js'
import { backendScoped, deleteByPrefix } from './backendCache.js'
import { type EtagValidator, formatEtag } from './etag.js'
import {
  type GovernedDescriptors,
  deriveGovernedDescriptors
} from './governedLog.js'
import { absoluteUrl, collectionLogPath } from './paths.js'

/**
 * One memoization cache per storage backend, keyed by Collection and log
 * validator (see `backendCache.ts` for the scoping rationale).
 */
const descriptorCaches = backendScoped(
  () =>
    new LruCache({
      max: GOVERNED_DESCRIPTORS_CACHE_MAX,
      ttl: GOVERNED_DESCRIPTORS_CACHE_TTL
    })
)

/**
 * The key prefix every entry under one Space shares. `spaceId` and
 * `collectionId` are restricted to the RFC 3986 unreserved charset (see
 * `validateId.ts`), which never contains `/`, so `/` separates the parts and
 * doubles as the prefix boundary for the bulk invalidators below.
 * @param spaceId {string}
 * @returns {string}
 */
function spaceKeyPrefix(spaceId: string): string {
  return `${spaceId}/`
}

/**
 * The key prefix every entry of one Collection shares.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
function collectionKeyPrefix({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${spaceKeyPrefix(spaceId)}${collectionId}/`
}

/**
 * Drops every derived descriptor pair cached for a Collection. Call after Delete
 * Collection, since the log goes with it.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {void}
 */
export function invalidateCollectionGovernedDescriptors({
  storage,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId: string
}): void {
  // Only touch a cache that already exists for this backend.
  const cache = descriptorCaches.peek(storage)
  if (cache) {
    deleteByPrefix(cache.cache, collectionKeyPrefix({ spaceId, collectionId }))
  }
}

/**
 * Drops every derived descriptor cached under a Space. Call after Delete
 * Space and after an import, either of which can remove or install the log
 * of any Collection in the Space.
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @returns {void}
 */
export function invalidateSpaceGovernedDescriptors({
  storage,
  spaceId
}: {
  storage: StorageBackend
  spaceId: string
}): void {
  const cache = descriptorCaches.peek(storage)
  if (cache) {
    deleteByPrefix(cache.cache, spaceKeyPrefix(spaceId))
  }
}

/**
 * The descriptors a stored history log derives, read through the per-backend
 * memoization cache: the `encryption` member (the log head's `state` without
 * its `revisions` slot, with `history: { method, resource }` stamped on) and
 * the `revisions` member (that slot, when present). `undefined` for no
 * validator (an ungoverned Collection). A stored log the parser rejects is a
 * server-side fault (`StorageError`, 500), and a rejected derivation is not
 * retained.
 *
 * The caller holds the log's validator. The body is read through `readLog`
 * only when the cache holds no entry under the validator, so a cached
 * Collection costs no log read. A caller that already holds the log passes
 * `readLog: async () => log`, and saves the parse.
 *
 * The log `readLog` resolves may be newer than the validator, when an append
 * landed in between. The entry is then the new head's descriptors under the
 * old validator, which no later read presents, since each reads the
 * validator again. A log that is gone by then (the Collection was deleted)
 * derives nothing.
 * @param options {object}
 * @param options.storage {StorageBackend}   the backend the validator was
 *   read from
 * @param options.serverUrl {string}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.logValidator] {EtagValidator}   the stored log's validator,
 *   as read, if any
 * @param options.readLog {Function}   reads the stored log on a cache miss
 * @returns {Promise<GovernedDescriptors | undefined>}
 */
export async function getCachedGovernedDescriptors({
  storage,
  serverUrl,
  spaceId,
  collectionId,
  logValidator,
  readLog
}: {
  storage: StorageBackend
  serverUrl: string
  spaceId: string
  collectionId: string
  logValidator?: EtagValidator
  readLog: () => Promise<CollectionLogResult | undefined>
}): Promise<GovernedDescriptors | undefined> {
  if (!logValidator) {
    return undefined
  }
  return await descriptorCaches
    .for(storage)
    .memoize<GovernedDescriptors | undefined>({
      key:
        collectionKeyPrefix({ spaceId, collectionId }) +
        formatEtag(logValidator),
      fn: async () => {
        const log = await readLog()
        if (!log) {
          return undefined
        }
        return deriveGovernedDescriptors({
          body: log.body,
          logUrl: absoluteUrl({
            path: collectionLogPath({ spaceId, collectionId }),
            serverUrl
          })
        })
      }
    })
}
