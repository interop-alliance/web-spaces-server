/**
 * Per-Collection backend resolver (spec "Backends"; stage 3 of the BYOS plan).
 * Maps a Collection's selected `backend.id` to the live `StorageBackend` that
 * serves its **data plane** (resource bytes, metadata, listings, change feed),
 * while the control plane (`request.server.storage`) keeps the Space and
 * Collection descriptions, the policies and the backend registry records.
 * For a Collection on the control plane the two planes are the same
 * instance.
 *
 * `resolveBackend` short-circuits to a server backend for the `default`,
 * absent, or fixed-id selection (`request.server.serverBackends`, one lookup,
 * no I/O). A server backend other than the control plane holds a copy of
 * the Space and Collection Metadata objects of the Collections it serves
 * (lib/backendMirror.ts), so its own write rules hold there. For a Collection
 * that selects a registered `external` backend it loads the (secret-bearing)
 * backend record from the control plane and builds -- memoized -- the
 * provider adapter
 * from the injected `backendProviders` registry; with no factory for the record's
 * `provider` it fails closed with `unsupported-backend` (409), as it does for an
 * adapter that does not enforce a capability caveat type the server
 * advertises. Memoization
 * mirrors spaceContext.ts: one `LruCache` per registry (a `WeakMap`), so adapter
 * instances are reused across requests and a registry's adapters are GC'd with
 * it.
 */
import type { FastifyRequest } from 'fastify'
import { LruCache } from '@interop/lru-memoize'
import { UnsupportedBackendError } from '../errors.js'
import { RESOLVED_BACKEND_CACHE_MAX } from '../config.default.js'
import { unenforcedCaveatTypes } from './ownResourcesOnly.js'
import type {
  BackendProviderRegistry,
  CollectionMetadata,
  StorageBackend
} from '../types.js'

/**
 * One adapter cache per provider registry, keyed by `${spaceId}/${backendId}`.
 * Scoped to the registry instance via a `WeakMap` (rather than module-global) so
 * parallel test suites never share adapters, and a cache is discarded with its
 * registry. `memoize` evicts a rejected promise automatically, so a failed
 * resolution (missing record / no factory) is retried on the next request rather
 * than cached.
 */
const adapterCaches = new WeakMap<BackendProviderRegistry, LruCache>()

/**
 * Returns the (lazily created) adapter cache for a provider registry.
 * @param providers {BackendProviderRegistry}
 * @returns {LruCache}
 */
function adapterCacheFor(providers: BackendProviderRegistry): LruCache {
  let cache = adapterCaches.get(providers)
  if (!cache) {
    cache = new LruCache({ max: RESOLVED_BACKEND_CACHE_MAX })
    adapterCaches.set(providers, cache)
  }
  return cache
}

/**
 * Resolves the data-plane `StorageBackend` for a Collection. Returns the
 * server backend the Collection selects (`default`, nothing, or a fixed id);
 * otherwise builds (memoized) the provider adapter for its registered backend.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server` (the
 *   control-plane `storage`, the `backendProviders` registry, and the
 *   non-request instance `log` passed to the memoized adapter factory)
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.collectionMetadata] {CollectionMetadata}   the
 *   already-fetched Collection Metadata object (most handlers fetch it for
 *   auth); read from the control plane when omitted
 * @returns {Promise<StorageBackend>}
 */
export async function resolveBackend({
  request,
  spaceId,
  collectionId,
  collectionMetadata
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  collectionMetadata?: CollectionMetadata
}): Promise<StorageBackend> {
  const { storage, serverBackends, backendProviders } = request.server
  const metadata =
    collectionMetadata ??
    (await storage.getCollectionMetadata({ spaceId, collectionId }))
  const backendId = metadata?.backend?.id
  // Fast path: a server backend. An absent id selects the default.
  if (backendId === undefined) {
    return serverBackends.default
  }
  const serverBackend = serverBackends.resolve(backendId)
  if (serverBackend !== undefined) {
    return serverBackend
  }
  // The adapter path: `backendId` is a registered external backend's id.
  return adapterCacheFor(backendProviders).memoize<StorageBackend>({
    key: `${spaceId}/${backendId}`,
    fn: async () => {
      // Control-plane read: the secret-bearing record lives there.
      const record = await storage.getBackend({ spaceId, backendId })
      if (!record) {
        throw new UnsupportedBackendError({ backendId })
      }
      // Status gating is deferred (stage 4): the resolver keys on whether a
      // provider factory is registered, not on `connection.status` (which only
      // becomes `connected` once the OAuth exchange exists).
      const factory = backendProviders.get(record.provider)
      if (!factory) {
        throw new UnsupportedBackendError({
          backendId,
          detail: `Backend '${backendId}' is registered but not connected/operable yet.`
        })
      }
      // Wire the non-request instance logger (as `createApp` does for the
      // primary backend), NOT `request.log`: the adapter is memoized and reused
      // across requests, so capturing the first request's per-request child
      // logger would mis-tag every later log line with that first request's id.
      const adapter = factory(record, {
        logger: request.server.log,
        originId: storage.originId
      })
      // The startup rule for a server backend, applied to an adapter: one
      // that does not enforce an advertised caveat type is not served.
      const missing = unenforcedCaveatTypes(adapter)
      if (missing.length > 0) {
        throw new UnsupportedBackendError({
          backendId,
          detail:
            `Backend '${backendId}' does not enforce the capability caveat ` +
            `${missing.join(', ')}.`
        })
      }
      return adapter
    }
  })
}

/**
 * Drops the memoized adapter for a backend record. Call after a record changes
 * (register-replace / deregister) so the next resolve rebuilds the adapter from
 * the new connection material.
 * @param options {object}
 * @param options.providers {BackendProviderRegistry}
 * @param options.spaceId {string}
 * @param options.backendId {string}
 * @returns {void}
 */
export function invalidateResolvedBackend({
  providers,
  spaceId,
  backendId
}: {
  providers: BackendProviderRegistry
  spaceId: string
  backendId: string
}): void {
  // Only touch a cache that already exists for this registry.
  adapterCaches.get(providers)?.delete(`${spaceId}/${backendId}`)
}
