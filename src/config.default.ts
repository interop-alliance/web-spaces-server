/**
 * Default configuration: spec and FEP documentation URLs referenced by the
 * home page, error responses, and space-export manifests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodeSecretKeySeed } from '@interop/bnid'
import { SERVER_BACKEND_IDS, isServerBackendId } from './lib/serverBackends.js'
import { parseKekMultibase } from './lib/kmsRecordCipher.js'
import { ORIGIN_ID_PATTERN, isValidOriginId } from './lib/originId.js'
import { isValidController } from './lib/validateDid.js'
import { compileWebvhBlocklist } from './lib/webvhBlocklist.js'
import type { IDID, KmsRecordKekRegistry, RecordKek } from './types.js'

// package.json sits a level above both src/ (dev, via tsx) and dist/ (prod),
// so '../package.json' from import.meta.dirname resolves in either layout.
const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json')

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
  name: string
  version: string
  repository: { url: string }
  homepage: string
}

/**
 * The version package.json declares, read from disk at startup. This is the
 * repo's version, not necessarily the running build's -- see BUILD_INFO.
 */
const PACKAGE_VERSION = packageJson.version

/**
 * The software identity the service description's `instance` member
 * discloses: the package name, its source repository, and its project page,
 * all read from package.json.
 */
export const PACKAGE_INSTANCE = {
  name: packageJson.name,
  source: packageJson.repository.url,
  homepage: packageJson.homepage
}

// The build-provenance stamp sits beside the compiled modules in dist/
// (written by scripts/write-build-info.ts as the last step of `pnpm build`),
// so it resolves only when running the built output -- absent under tsx/dev.
const buildInfoPath = path.join(import.meta.dirname, 'build-info.json')

/**
 * Provenance of the build actually running, from `dist/build-info.json`:
 * the version and git commit dist/ was built from, and when. Undefined when
 * running from src/ (dev, via tsx), where the sources cannot be stale.
 */
export const BUILD_INFO:
  { version: string; commit: string | null; builtAt: string } | undefined =
  fs.existsSync(buildInfoPath)
    ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    : undefined

/**
 * Server version reported by `/health` and the welcome page: the version the
 * running build was built from when the build stamp is present, else the
 * package.json version (dev).
 */
export const SERVER_VERSION = BUILD_INFO?.version ?? PACKAGE_VERSION

/**
 * Fail-fast guard against serving a stale build: when running from dist/ (the
 * build stamp is present), the version stamped at build time must match the
 * package.json on disk -- a mismatch means the sources were updated (e.g. a
 * `git pull`) without a rebuild, and the process would silently run old code
 * while reporting the new version. Called from the start.ts entry point only,
 * so library and test compositions of createApp() are unaffected.
 *
 * @param options {object}
 * @param [options.buildVersion] {string}   the stamped build version
 *   (defaults to BUILD_INFO's; undefined = no stamp = dev, always fresh)
 * @param [options.packageVersion] {string}   the on-disk package.json version
 * @returns {void}
 */
export function assertFreshBuild({
  buildVersion = BUILD_INFO?.version,
  packageVersion = PACKAGE_VERSION
}: { buildVersion?: string; packageVersion?: string } = {}): void {
  if (buildVersion === undefined || buildVersion === packageVersion) {
    return
  }
  throw new Error(
    `dist/ was built from version ${buildVersion} but package.json is ` +
      `${packageVersion} -- run 'pnpm build' before starting.`
  )
}

/**
 * Space Metadata cache (see src/requests/spaceContext.ts). The Space Metadata
 * object is read on every authorized handler, so it is memoized per storage
 * backend.
 * Writes invalidate the entry explicitly; the short TTL is a backstop that also
 * bounds staleness when several server processes share one storage backend (so
 * one process's cache cannot serve another process's write indefinitely).
 */
export const SPACE_METADATA_CACHE_TTL = 10_000 // milliseconds
/** Max number of Space Metadata objects held per backend cache (LRU-bounded). */
export const SPACE_METADATA_CACHE_MAX = 1_000

/**
 * How many times Update Space, which authorizes against an unlocked read,
 * re-reads and retries when the Space Metadata object changes before the
 * write takes its lock, before giving up with a 503.
 */
export const SPACE_METADATA_WRITE_ATTEMPTS = 3

/**
 * Resolved `did:webvh` controller-document cache (see
 * src/lib/webvhController.ts). Verifying a history log is the most expensive
 * step on a promoted Space's hot path, so the verified document is memoized per
 * storage backend. Writes that could change a log at the cached location
 * invalidate the entry explicitly (the cache is keyed by that location). The
 * TTL is the freshness window: within it a cached document is served without
 * any read; past it the entry is revalidated by comparing the log Resource's
 * content `ETag` against the one it was verified from, so a write from a
 * sibling process sharing the backend is picked up within one TTL.
 */
export const WEBVH_DOCUMENT_CACHE_TTL = 5_000 // milliseconds
/**
 * How long a cached `did:webvh` document may be kept alive by validator
 * matches alone before the log is fully re-verified regardless. The validator
 * compare is the multi-process backstop for ordinary writes; this age bounds
 * how long a change that bypasses it (bytes rewritten out of band) can go
 * unnoticed.
 */
export const WEBVH_DOCUMENT_REVERIFY_AGE = 60_000 // milliseconds
/** Max number of resolved did:webvh documents held per backend cache. */
export const WEBVH_DOCUMENT_CACHE_MAX = 1_000

/**
 * The index of every stored replica registration, which maps a replicated
 * `did:webvh` to the local copy of its log (see src/lib/webvhLogLocation.ts).
 * Storing or removing a registration, and Delete Space, drop it explicitly;
 * the TTL bounds how long another server process sharing the store serves a
 * stale one.
 */
export const REPLICA_INDEX_CACHE_TTL = 10_000 // milliseconds

/**
 * Peer server `did:webvh` resolution (see src/lib/peerWebvh.ts). A peer
 * server's history log is fetched over the network from its own host, but only
 * for the invoker of a delegated capability whose chain already verified to the
 * Space controller. These bound what such a fetch can cost. The fetch timeout
 * covers the connection and the whole body.
 */
export const PEER_WEBVH_FETCH_TIMEOUT_MS = 5_000 // milliseconds
/**
 * Max size of a fetched peer history log. The body is read as a stream and the
 * fetch is aborted at the byte that crosses this size.
 */
export const PEER_WEBVH_LOG_MAX_BYTES = 1024 * 1024 // 1 MiB
/**
 * How long a verified peer document is served from the cache. Past it the log
 * is fetched and verified again, so a key the peer's admin retires stops
 * verifying here within one TTL.
 */
export const PEER_WEBVH_CACHE_TTL = 300_000 // milliseconds
/**
 * Max number of verified peer documents held at once (LRU-bounded). The
 * per-DID log heads, the failure records and the per-host fetch records are
 * bounded by the same number.
 */
export const PEER_WEBVH_CACHE_MAX = 256
/**
 * The least time between two fetches of one peer log forced by a signature
 * that names a key the cached document lacks.
 */
export const PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL = 60_000 // milliseconds
/**
 * How long a failed peer log fetch or verification is remembered. Within it
 * the DID is refused without another fetch, so a failing host is not asked
 * again on every request.
 */
export const PEER_WEBVH_FAILURE_TTL = 30_000 // milliseconds
/**
 * Max number of first-contact peer log fetches to one host within
 * {@link PEER_WEBVH_HOST_FETCH_WINDOW}: fetches for a DID with no verified
 * head here. A fetch past it is refused. A DID already verified is refreshed
 * outside this window, so DIDs nobody verified cannot use it up.
 */
export const PEER_WEBVH_HOST_FETCH_LIMIT = 10
/** The window {@link PEER_WEBVH_HOST_FETCH_LIMIT} counts fetches over. */
export const PEER_WEBVH_HOST_FETCH_WINDOW = 60_000 // milliseconds
/**
 * Max number of peer log fetches running at once, across every host. First
 * contact fetches and refreshes of already verified DIDs each have this
 * budget, counted apart. A fetch past it is refused, not queued.
 */
export const PEER_WEBVH_MAX_CONCURRENT_FETCHES = 8

/**
 * Access-control policy cache (see src/lib/policyCache.ts). `resolveEffectivePolicy`
 * reads up to three levels (Space, Collection, Resource) on every anonymous
 * read, so each level is memoized per storage backend. Writes invalidate the
 * entry explicitly; the short TTL is a backstop that also bounds staleness when
 * several server processes share one storage backend (so one process's cache
 * cannot serve another process's write indefinitely).
 */
export const POLICY_CACHE_TTL = 10_000 // milliseconds
/** Max number of policy documents held per backend cache (LRU-bounded). */
export const POLICY_CACHE_MAX = 1_000

/**
 * Derived governed-descriptors cache (see src/lib/governedDescriptorsCache.ts
 * for the keying and invalidation rationale). An entry is keyed by the log's
 * own validator, so the TTL only bounds how long a superseded entry lingers.
 */
export const GOVERNED_DESCRIPTORS_CACHE_TTL = 600_000 // milliseconds
/** Max number of derived descriptors held per backend cache (LRU-bounded). */
export const GOVERNED_DESCRIPTORS_CACHE_MAX = 1_000

/**
 * The clock bound for a write stamp received from a peer (env
 * `WAS_REPLICATION_CLOCK_BOUND_MS`): how far ahead of this server's physical
 * clock, in milliseconds, a received stamp may be dated before the hybrid
 * logical clock refuses it (see src/lib/hlc.ts). A stamp dated further ahead
 * would carry every later local write ahead of real time with it.
 */
export const REPLICATION_CLOCK_BOUND_MS = 60_000

/**
 * How long a registration's pull loop waits between two cycles that both
 * reached the peer (see src/sync/replication.ts).
 */
export const REPLICATION_PULL_INTERVAL_MS = 5_000
/**
 * The delay before the first retry of a cycle that failed to reach the peer.
 * It doubles with each further failure, up to
 * {@link REPLICATION_BACKOFF_MAX_MS}.
 */
export const REPLICATION_BACKOFF_BASE_MS = 5_000
/** The longest a failing pull loop waits between two cycles. */
export const REPLICATION_BACKOFF_MAX_MS = 600_000
/**
 * How many change documents one feed request asks a peer for. A page too
 * large to buffer is asked for again at half the size.
 */
export const REPLICATION_FEED_PAGE_SIZE = 100
/**
 * The timeout of one request a pull loop makes to a peer. For a Resource
 * representation it bounds the wait for the response and for each chunk of
 * the body, not the whole transfer.
 */
export const REPLICATION_REQUEST_TIMEOUT_MS = 30_000
/**
 * The most bytes a pull loop reads of a peer response that is not a Resource
 * representation: a Metadata object, a listing, a feed page, a policy, the
 * service description. A Resource representation is bounded by the backend's
 * upload cap instead, as an upload is. So is a feed page of one document,
 * which may inline a JSON body of that size.
 */
export const REPLICATION_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024
/**
 * How many consecutive cycles a pull loop may end in `retry` on one feed
 * document of a chunked Resource before the Collection stalls, as
 * `chunk-listing-obsolete` when the closing check keeps failing (the source
 * server rewrites the Resource faster than its chunk set is pulled), or as
 * `source-unavailable` when a request inside the chunk pull keeps failing. A
 * cycle count, kept in memory with the loop, so a restart starts it over. A
 * stalled Collection is still retried each cycle, so the stall clears on the
 * first chunk pull that completes.
 */
export const REPLICA_CHUNK_PULL_RETRY_LIMIT = 5
/**
 * How many chunks of one chunk set a pull loop reads from the source server
 * at once. Each read is one stream staged under the upload cap, so the
 * memory a chunk pull holds is bounded by this many times `maxUploadBytes`
 * on a backend that buffers a staged chunk.
 */
export const REPLICA_CHUNK_PULL_CONCURRENCY = 4
/**
 * When a pull loop persists its state inside one Collection's pull, beside
 * the end of the Collection: once the chunk pulls since the last persist
 * moved this many bytes, or ran for this many Resources. A chunk pull may
 * move many bytes, so a long one cut by a restart loses at most this much
 * of its checkpoint, while a run of small chunked Resources does not
 * rewrite the state after each.
 */
export const REPLICA_STATE_PERSIST_BYTES = 64 * 1024 * 1024
export const REPLICA_STATE_PERSIST_DOCUMENTS = 16

/**
 * `Access-Control-Max-Age` (seconds) on CORS preflight responses. Without it
 * browsers re-preflight the same URL every few seconds (Chrome's default is
 * 5 s), and a signed-request client preflights nearly every call, so about
 * half of a wallet's requests were preflights. Browsers cap the value on
 * their side (Chrome at 7200 s, Firefox at 86400 s); the preflight answer
 * never varies per request, so the longest useful value is safe.
 */
export const CORS_PREFLIGHT_MAX_AGE = 86_400 // seconds

/**
 * CORS proxy response cache (see src/corsProxy.ts). A successful (2xx) GET
 * relayed through `/api/cors` is cached by target URL plus the forwarded
 * `Accept` header, so a repeat request for the same resource within its TTL
 * is served without a fresh upstream fetch.
 */
export const CORS_PROXY_RESPONSE_CACHE_TTL = 60_000 // milliseconds
/**
 * Upper bound applied to an upstream `Cache-Control` `max-age`, so a very
 * large (or malicious) value cannot pin a cache entry for an unreasonable
 * length of time.
 */
export const CORS_PROXY_RESPONSE_CACHE_MAX_TTL = 3_600_000 // milliseconds
/**
 * Max number of cached proxy responses held at once (LRU-bounded). Also
 * bounds the single-flight memo of upstream fetches in progress.
 */
export const CORS_PROXY_RESPONSE_CACHE_MAX = 500
/**
 * Max body size, in bytes, of a single proxied response eligible for
 * caching; a larger response is still relayed but is never cached.
 */
export const CORS_PROXY_RESPONSE_CACHE_MAX_ENTRY_BYTES = 1024 * 1024 // 1 MiB
/**
 * Max combined body size, in bytes, held by the proxy response cache at once
 * (lru-cache `maxSize`, measured via `sizeCalculation` over each entry's
 * body length).
 */
export const CORS_PROXY_RESPONSE_CACHE_MAX_BYTES = 50 * 1024 * 1024 // 50 MiB

/**
 * CORS proxy host-validation cache (see src/corsProxy.ts). A hostname
 * `checkProxyTarget` has already resolved and validated (public, not
 * SSRF-blocked) is reused for this long before a fresh DNS lookup is made.
 */
export const CORS_PROXY_HOST_CHECK_CACHE_TTL = 30_000 // milliseconds
/**
 * Max number of validated hostnames held at once (LRU-bounded).
 */
export const CORS_PROXY_HOST_CHECK_CACHE_MAX = 1_000

/**
 * CORS proxy upstream connection cache (see src/corsProxy.ts). Rather than a
 * fresh undici `Agent` (and TLS handshake) per proxied request, an Agent is
 * reused across requests and redirect hops that dial the same host with the
 * same validated addresses -- keyed by hostname plus those addresses, so a
 * re-resolved host always gets a fresh Agent. An Agent is destroyed when it
 * is evicted or its TTL expires, deferred until any fetch still using it has
 * finished.
 */
export const CORS_PROXY_AGENT_CACHE_MAX = 100
/**
 * Time since its last use after which a cached upstream Agent is destroyed
 * and evicted. Every use restarts the clock.
 */
export const CORS_PROXY_AGENT_CACHE_TTL = 300_000 // milliseconds

/**
 * Max number of resolved external-backend adapters held per provider-registry
 * cache (see src/lib/backendRegistry.ts), LRU-bounded. One adapter instance is
 * memoized per selected `{spaceId}/{backendId}` and reused across requests;
 * record changes bust the entry explicitly (no TTL backstop is needed because
 * the provider registry itself is fixed for an instance's lifetime).
 */
export const RESOLVED_BACKEND_CACHE_MAX = 1_000

/**
 * The PWS specification's persistent identifier, the key of its entry in the
 * service description's `specs` object. Provisional until the specification's
 * rename registers it.
 */
export const SPEC_IDENTIFIER = 'https://w3id.org/pws'

/**
 * The PWS specification version this server's route table implements, as the
 * service description advertises it (`major.minor`, no patch level).
 */
export const SPEC_VERSION = '0.5'

/**
 * The zCap authorization profile's persistent identifier, the key of its entry
 * in the service description's `specs` object. Listing the profile is how a
 * client learns this server authorizes requests with capability invocations,
 * and the entry -- not the PWS entry -- carries the signature algorithms and
 * delegation cryptosuites the server accepts.
 */
export const AUTHZ_PROFILE_IDENTIFIER = 'https://w3id.org/pws/authz-profile'

/**
 * The version of the zCap authorization profile this server implements, as the
 * service description advertises it (`major.minor`, no patch level).
 */
export const AUTHZ_PROFILE_VERSION = '0.1'

/**
 * The rendered location of the zCap authorization profile at the version above,
 * the `url` of its service description entry.
 */
export const AUTHZ_PROFILE_URL =
  'https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/'

/**
 * The Encrypted Collections profile's persistent identifier, the key of its
 * entry in the service description's `specs` object. Listing the profile claims
 * this server serves its required surface -- the chunk endpoints -- and the
 * entry's `features` array names which of its two optional affordances it
 * serves.
 */
export const ENCRYPTED_COLLECTIONS_IDENTIFIER =
  'https://w3id.org/pws/encrypted-collections'

/**
 * The version of the Encrypted Collections profile this server implements, as
 * the service description advertises it (`major.minor`, no patch level).
 */
export const ENCRYPTED_COLLECTIONS_VERSION = '0.1'

/**
 * The rendered location of the Encrypted Collections profile at the version
 * above, the `url` of its service description entry.
 */
export const ENCRYPTED_COLLECTIONS_URL =
  'https://interop-alliance.github.io/encrypted-collections-spec/'

/**
 * The client annex profile's persistent identifier, the key of its entry in the
 * service description's `specs` object. Listing the profile claims this server
 * enforces the client-annex delegation clause (`lib/clientAnnexClause.ts`) on
 * every verification, which is the positive signal a wallet checks before it
 * signs up an account on this server: the clause fails open on a server that
 * does not implement it. Provisional until the `pws`
 * namespace is registered.
 */
export const CLIENT_ANNEX_IDENTIFIER = 'https://w3id.org/pws/client-annex'

/**
 * The version of the client annex profile this server implements, as the
 * service description advertises it (`major.minor`, no patch level). `0.1`
 * claims the clause as this server enforces it, with its seven admission
 * predicates; a change to what the clause admits is a new version. The entry
 * carries no `url` until the profile text is published.
 */
export const CLIENT_ANNEX_VERSION = '0.1'

/**
 * The replication specification's persistent identifier, the key of its entry
 * in the service description's `specs` object. Listing it claims this server
 * serves the `replicas` registration sub-resource, the pull loop and the
 * apply path. A registration reads the peer's entry and refuses a peer that
 * lists none at a version this server speaks. Provisional until the `pws`
 * namespace is registered.
 */
export const REPLICATION_IDENTIFIER = 'https://w3id.org/pws/replication'

/**
 * The version of the replication specification this server implements
 * (`major.minor`, no patch level). A change to what the pull loop accepts is
 * a new version. The `PUT` at a registration URL, which pauses and resumes
 * the loop and replaces the pull capability in place, is part of `0.1`: it
 * changes what a controller may do to its own registration, not what the
 * loop accepts from a peer.
 */
export const REPLICATION_VERSION = '0.1'

/**
 * Where the replication specification text at `REPLICATION_VERSION` is
 * published, the `url` member of its service-description entry.
 */
export const REPLICATION_URL =
  'https://w3c-ccg.github.io/portable-web-spaces-spec/replication/'

/**
 * The Portable Wallet Profile's persistent identifier, the key of its entry in
 * the service description's `specs` object. Listing it claims this server
 * meets the profile's "Server requirements", a set of core and Encrypted
 * Collections `features` tokens that `serviceDescription.ts` checks. The entry
 * is a shorthand for those tokens and adds no route.
 */
export const WALLET_PROFILE_IDENTIFIER = 'https://w3id.org/pws/wallet-profile'

/**
 * The version of the Portable Wallet Profile this server satisfies, as the
 * service description advertises it (`major.minor`, no patch level). `0.1`
 * pins PWS `0.5` and Encrypted Collections `0.1`; a profile version that pins
 * other versions or another token set is a new entry.
 */
export const WALLET_PROFILE_VERSION = '0.1'

/**
 * The `url` of the Portable Wallet Profile's service description entry. The
 * profile asks for a version-frozen URL; until the profile publishes one,
 * this is the current rendering of the profile, which a later profile
 * version will replace in place.
 */
export const WALLET_PROFILE_URL =
  'https://interop-alliance.github.io/portable-wallet-profile-spec/'

/**
 * `Cache-Control` `max-age` (seconds) on the service description. The document
 * changes only when the server is redeployed with a different configuration,
 * and its `ETag` lets a client revalidate cheaply once the age runs out.
 */
export const SERVICE_DESCRIPTION_MAX_AGE = 3_600 // seconds

/**
 * The link relation naming the service description, both in the `Link` header
 * every response carries and in the Space and Collection linksets (RFC 5023's
 * registered `service` relation).
 */
export const SERVICE_LINK_RELATION = 'service'

/**
 * Linkset relation URI for the access-control `policy` auxiliary resource
 * (RFC9264 linkset discovery; see src/policy.ts and the linkset handlers).
 */
export const POLICY_LINK_RELATION = `${SPEC_IDENTIFIER}#policy`

/**
 * Linkset relation URI for a Collection's selected `backend` auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/{cid}/backend`).
 */
export const BACKEND_LINK_RELATION = `${SPEC_IDENTIFIER}#backend`

/**
 * Linkset relation URI for a Collection's `quota` report auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/{cid}/quota`).
 */
export const QUOTA_LINK_RELATION = `${SPEC_IDENTIFIER}#quota`

/**
 * Linkset relation URI for a Space's `backends-available` auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/backends`).
 */
export const BACKENDS_AVAILABLE_LINK_RELATION = `${SPEC_IDENTIFIER}#backends-available`

/**
 * Linkset relation URI for a Space's `replicas` registration listing
 * (RFC9264 linkset discovery; advertised at `/space/{id}/replicas`).
 */
export const REPLICAS_LINK_RELATION = `${SPEC_IDENTIFIER}#replicas`

/**
 * Linkset relation URI for a Space's `quotas` report auxiliary resource
 * (RFC9264 linkset discovery; advertised at `/space/{id}/quotas`).
 */
export const QUOTAS_LINK_RELATION = `${SPEC_IDENTIFIER}#quotas`

/**
 * Fraction of a backend's configured capacity at or above which its quota
 * report `state` becomes `near-limit` (spec "Quotas"). Below this it is `ok`;
 * at or above full capacity it is `over-quota`. Only applies when a finite
 * capacity is configured (an unlimited backend is always `ok`).
 */
export const QUOTA_NEAR_LIMIT_FRACTION = 0.9

/**
 * Write-path quota usage cache TTL (see
 * `FileSystemBackend.#assertSpaceHeadroom`). The quota pre-flight measures a
 * Space's on-disk usage with `du`, which walks the whole Space tree -- too
 * costly to repeat on every resource write. The measured total is cached per
 * Space for this long, with each accepted write's incoming bytes added to the
 * cached figure; deletes invalidate the entry. The TTL bounds the drift of
 * that optimistic accounting (overwrites that replaced rather than added
 * bytes, streamed bodies of undeclared size) -- the quota is a documented
 * soft limit, and the TTL bounds the re-measurement window.
 */
export const QUOTA_USAGE_CACHE_TTL = 20_000 // milliseconds
/**
 * Max number of Space usage snapshots held in the cache (LRU-bounded).
 */
export const QUOTA_USAGE_CACHE_MAX = 1_000

/**
 * The single in-process KMS module this server hard-wires.
 * A keystore created without one gets this alias, and it is immutable thereafter.
 */
export const DEFAULT_KMS_MODULE = 'local-v1'

/**
 * Max keystore configs returned by `GET /kms/keystores?controller=...` (the
 * webkms protocol's list cap).
 */
export const KEYSTORE_LIST_LIMIT = 100

/**
 * Max key descriptions returned per page by
 * `GET /kms/keystores/:keystoreId/keys` (the List Keys fork extension). A
 * further page is signalled by the response's `next` cursor URL; realistic
 * keystores hold a handful of keys, so one page is the steady state.
 */
export const KEY_LIST_LIMIT = 100

/**
 * Max capability delegation chain length accepted on `/kms` invocations, the
 * root capability included (webkms-switch's `maxChainLength` default). A
 * per-key `maxCapabilityChainLength` (1-10, set at generate time) may narrow
 * this further for key operations; it can never widen it.
 */
export const KMS_MAX_CHAIN_LENGTH = 10

/**
 * Max time-to-live of a delegated capability accepted on `/kms` invocations,
 * measured `expires` minus the delegation proof's `created`, in milliseconds
 * (90 days -- webkms-switch's `maxDelegationTtl` default). One unified bound
 * for every `/kms` route family:
 * revocation plus the mandatory `expires` is the real control.
 */
export const KMS_MAX_DELEGATION_TTL = 90 * 24 * 60 * 60 * 1000

/** TCP port the server listens on when `PORT` is unset. */
export const DEFAULT_PORT = 3002

/**
 * The host the server listens on when `HOST` is unset: every IPv4 interface,
 * which a container deployment needs. Set `HOST=localhost` to bind loopback
 * only.
 */
export const DEFAULT_HOST = '0.0.0.0'

/**
 * The default per-upload byte cap applied by BOTH backends when
 * `MAX_UPLOAD_BYTES` is unset (a default-on limit, 64 MiB). Every blob write
 * buffers through process memory on at least one path (the Postgres single
 * `bytea`, multipart's in-memory `toBuffer()`), so "no cap" would be a footgun.
 * Opt out explicitly with `MAX_UPLOAD_BYTES=unlimited`, which the backends
 * accept only where an unbounded upload is actually safe (the filesystem
 * streaming path; the Postgres backend rejects it at construction).
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Default cap on the number of Spaces a single controller may create, applied
 * by BOTH backends when `MAX_SPACES_PER_CONTROLLER` is unset (a default-on
 * count quota). Chosen far above any teaching or conformance workload while
 * still bounding runaway creation by one controller. Opt out with
 * `MAX_SPACES_PER_CONTROLLER=unlimited`.
 */
export const DEFAULT_MAX_SPACES_PER_CONTROLLER = 100

/**
 * Default cap on the number of Collections a single Space may hold, applied by
 * BOTH backends when `MAX_COLLECTIONS_PER_SPACE` is unset (a default-on count
 * quota). Opt out with `MAX_COLLECTIONS_PER_SPACE=unlimited`.
 */
export const DEFAULT_MAX_COLLECTIONS_PER_SPACE = 100

/**
 * The validated env-derived server configuration returned by
 * {@link loadConfigFromEnv} and consumed by `start.ts`.
 */
export interface EnvConfig {
  /** The server base URL (`SERVER_URL`); required, validated. */
  serverUrl: string
  /** TCP port to listen on (`PORT`); defaults to {@link DEFAULT_PORT}. */
  port: number
  /** Host to listen on (`HOST`); defaults to {@link DEFAULT_HOST}. */
  host: string
  /**
   * Postgres connection string (`DATABASE_URL`); set, the Postgres backend
   * is configured. Unset, it is not.
   */
  databaseUrl?: string
  /**
   * Filesystem root for the filesystem backend (`WAS_DATA_DIR`); set, that
   * backend is configured. Unset, it is not, and with no `DATABASE_URL`
   * either the server refuses to start.
   */
  dataDir?: string
  /**
   * The fixed id of the server backend the `default` id aliases
   * (`WAS_DEFAULT_BACKEND`, `fs` or `postgres`); unset means `fs` when it is
   * configured, else the only configured backend.
   */
  defaultBackend?: string
  /**
   * The fixed id of the server backend that is the control plane
   * (`WAS_CONTROL_PLANE_BACKEND`, `fs` or `postgres`); unset means
   * `postgres` when it is configured, else `fs`.
   */
  controlPlaneBackend?: string
  /**
   * Per-Space storage quota in bytes (`STORAGE_LIMIT_PER_SPACE`). `undefined`
   * means unset -- unlimited, but `start.ts` warns to prompt an explicit
   * choice; `Infinity` means `unlimited` was set explicitly (no warning).
   */
  storageLimitPerSpace?: number
  /**
   * Per-upload size cap in bytes (`MAX_UPLOAD_BYTES`). `undefined` means unset
   * -- the backends apply the {@link DEFAULT_MAX_UPLOAD_BYTES} default;
   * `Infinity` means `unlimited` was set explicitly (no per-upload cap).
   */
  maxUploadBytes?: number
  /**
   * Max Spaces a single controller may create (`MAX_SPACES_PER_CONTROLLER`).
   * `undefined` means unset -- the backends apply the
   * {@link DEFAULT_MAX_SPACES_PER_CONTROLLER} default; `Infinity` means
   * `unlimited` was set explicitly (no cap).
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (`MAX_COLLECTIONS_PER_SPACE`).
   * `undefined` means unset -- the backends apply the
   * {@link DEFAULT_MAX_COLLECTIONS_PER_SPACE} default; `Infinity` means
   * `unlimited` was set explicitly (no cap).
   */
  maxCollectionsPerSpace?: number
  /** Backend registration allowlist (`WAS_ENABLED_BACKENDS`); unset = permissive. */
  enabledBackendProviders?: string[]
  /**
   * At-rest KMS key-record encryption registry (`KMS_RECORD_KEK` /
   * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`); unset = plaintext.
   */
  kmsRecordKek?: KmsRecordKekRegistry
  /**
   * Shared-secret provisioning gate (`WAS_ONBOARDING_TOKEN`); unset = open
   * provisioning, set but empty = startup error.
   */
  onboardingToken?: string
  /**
   * Whether the server version is published (`WAS_DISCLOSE_VERSION`) by
   * `/health`, the welcome page, and the service description; unset = `true`.
   */
  discloseVersion: boolean
  /**
   * The 32-byte Ed25519 seed the server's export-signing key is derived from
   * (`WAS_SERVER_KEY_SEED`); unset = no signing key, unsigned exports.
   */
  serverKeySeed?: Uint8Array
  /**
   * The `did:key` that controls the `server` Space hosting the server's own
   * identity (`WAS_ADMIN_DID`); unset = the Space is not provisioned.
   */
  adminDid?: IDID
  /**
   * The store's origin id (`WAS_ORIGIN_ID`), used verbatim; unset = the store's
   * own id is read, or minted on first boot.
   */
  originId?: string
  /**
   * The clock bound for a received write stamp, in milliseconds
   * (`WAS_REPLICATION_CLOCK_BOUND_MS`); unset = {@link REPLICATION_CLOCK_BOUND_MS}.
   */
  replicationClockBoundMs?: number
  /**
   * The foreign `did:webvh` hosts and DIDs whose log is never fetched
   * (`WAS_WEBVH_BLOCKLIST`); unset = none.
   */
  webvhBlocklist?: string[]
}

/**
 * Reads and validates the server's whole env config surface in one place
 * (fail-fast startup): a missing `SERVER_URL` or any malformed value throws
 * with the offending variable named, before the server starts listening --
 * instead of silently breaking ZCap matching at request time.
 * @param [env] {NodeJS.ProcessEnv}   defaults to `process.env`
 * @returns {EnvConfig}
 */
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EnvConfig {
  return {
    serverUrl: parseServerUrl(env.SERVER_URL),
    port: parsePort(env.PORT),
    host: parseHost(env.HOST),
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL),
    dataDir: parseDataDir(env.WAS_DATA_DIR),
    defaultBackend: parseServerBackendId({
      raw: env.WAS_DEFAULT_BACKEND,
      name: 'WAS_DEFAULT_BACKEND'
    }),
    controlPlaneBackend: parseServerBackendId({
      raw: env.WAS_CONTROL_PLANE_BACKEND,
      name: 'WAS_CONTROL_PLANE_BACKEND'
    }),
    storageLimitPerSpace: parseStorageLimit(env.STORAGE_LIMIT_PER_SPACE),
    maxUploadBytes: parseMaxUploadBytes(env.MAX_UPLOAD_BYTES),
    maxSpacesPerController: parseCountLimit(
      env.MAX_SPACES_PER_CONTROLLER,
      'MAX_SPACES_PER_CONTROLLER'
    ),
    maxCollectionsPerSpace: parseCountLimit(
      env.MAX_COLLECTIONS_PER_SPACE,
      'MAX_COLLECTIONS_PER_SPACE'
    ),
    enabledBackendProviders: parseEnabledBackends(env.WAS_ENABLED_BACKENDS),
    kmsRecordKek: parseKmsRecordKekRegistry({
      kek: env.KMS_RECORD_KEK,
      keks: env.KMS_RECORD_KEKS,
      currentKek: env.KMS_RECORD_CURRENT_KEK
    }),
    onboardingToken: parseOnboardingToken(env.WAS_ONBOARDING_TOKEN),
    discloseVersion: parseDiscloseVersion(env.WAS_DISCLOSE_VERSION),
    serverKeySeed: parseServerKeySeed(env.WAS_SERVER_KEY_SEED),
    adminDid: parseAdminDid(env.WAS_ADMIN_DID),
    originId: parseOriginId(env.WAS_ORIGIN_ID),
    replicationClockBoundMs: parseReplicationClockBound(
      env.WAS_REPLICATION_CLOCK_BOUND_MS
    ),
    webvhBlocklist: parseWebvhBlocklist(env.WAS_WEBVH_BLOCKLIST)
  }
}

/**
 * Validates a server base URL (the `serverUrl` option / `SERVER_URL` env
 * value): it must be present, and an absolute `http:`/`https:` URL with no
 * userinfo, path, query, or fragment. ZCap `invocationTarget` URLs and
 * `Location` headers are built by resolving absolute paths against this base
 * (`new URL(path, serverUrl)`), which silently drops any base path -- so a
 * sub-path deployment would break every delegated invocation. Rejected at
 * startup instead (fail-fast).
 * @param serverUrl {unknown}   the candidate base URL
 * @returns {asserts serverUrl is string}   throws on an invalid value
 */
export function assertValidServerUrl(
  serverUrl: unknown
): asserts serverUrl is string {
  // A composition passing an unset env var through unguarded lands here.
  if (typeof serverUrl !== 'string') {
    throw new Error(
      'serverUrl (env SERVER_URL) is required: the server base URL used to ' +
        "build and match ZCap invocationTarget URLs (e.g. 'http://localhost:3002')."
    )
  }
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    throw new Error(
      `serverUrl (env SERVER_URL) must be an absolute URL; got "${serverUrl}".`
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `serverUrl (env SERVER_URL) must use http: or https:; got "${serverUrl}".`
    )
  }
  // A `user:pass@` component would be copied into every invocationTarget and
  // URL the server builds, putting a credential on the wire.
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `serverUrl (env SERVER_URL) must not include userinfo (user:pass@); ` +
        `got "${url.protocol}//${url.host}".`
    )
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `serverUrl (env SERVER_URL) must not include a path, query, or ` +
        `fragment -- deploying under a sub-path is not supported; ` +
        `got "${serverUrl}".`
    )
  }
}

/**
 * Parses the `SERVER_URL` env value: the server's base URL, used to build and
 * match ZCap `invocationTarget` URLs (host and port must match the client's
 * exactly). Required -- unset would silently break all ZCap matching, so
 * startup fails instead. The value is trimmed but otherwise preserved
 * byte-for-byte (never normalized), since capability targets compare as exact
 * strings. Validated by {@link assertValidServerUrl}.
 * @param raw {string|undefined}   the raw env value
 * @returns {string}   the trimmed, validated base URL
 */
export function parseServerUrl(raw: string | undefined): string {
  const serverUrl = trimmedOrUndefined(raw)
  if (serverUrl === undefined) {
    throw new Error(
      `SERVER_URL is required: the server base URL used to build and match ` +
        `ZCap invocationTarget URLs (e.g. SERVER_URL='http://localhost:3002').`
    )
  }
  assertValidServerUrl(serverUrl)
  return serverUrl
}

/**
 * An env value with its surrounding whitespace removed, or `undefined` when
 * it is unset, empty, or whitespace-only.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}
 */
function trimmedOrUndefined(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The non-empty entries of a comma-separated env value, each trimmed.
 * @param raw {string}   the raw env value
 * @returns {string[]}
 */
function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/**
 * Parses a decimal integer env value: ASCII digits only, surrounding
 * whitespace allowed. `Number()` alone would also accept hex (`0x10`), binary,
 * octal and exponent forms (`1e3`), which no operator means when setting a
 * port or a byte count.
 * @param raw {string}   the raw env value
 * @returns {number|undefined}   the integer, or `undefined` if `raw` is not a
 *   run of decimal digits or exceeds `Number.MAX_SAFE_INTEGER`
 */
function parseDecimalInteger(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined
  }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Parses the `PORT` env value into the TCP port to listen on. An unset or
 * empty value returns {@link DEFAULT_PORT}.
 * @param raw {string|undefined}   the raw env value
 * @returns {number}   the port
 */
export function parsePort(raw: string | undefined): number {
  const trimmed = trimmedOrUndefined(raw)
  if (trimmed === undefined) {
    return DEFAULT_PORT
  }
  const value = parseDecimalInteger(trimmed)
  if (value === undefined || value < 1 || value > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535; got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `HOST` env value: the address the server listens on, handed to
 * Fastify's `listen()` as is. An unset or empty value returns
 * {@link DEFAULT_HOST}.
 * @param raw {string|undefined}   the raw env value
 * @returns {string}   the trimmed host
 */
export function parseHost(raw: string | undefined): string {
  return trimmedOrUndefined(raw) ?? DEFAULT_HOST
}

/**
 * Checks a loopback `SERVER_URL` against the port the server listens on. ZCap
 * `invocationTarget` URLs embed the host and port of `SERVER_URL`, so a client
 * that reaches a loopback server on its listening port signs for a URL that
 * matches no capability when the two ports differ. A non-loopback `SERVER_URL`
 * is not checked, since a reverse proxy in front of the server legitimately
 * serves a different port.
 * @param options {object}
 * @param options.serverUrl {string}   the validated `SERVER_URL`
 * @param options.port {number}   the port the server listens on
 * @returns {number|undefined}   the `SERVER_URL`'s effective port when it is a
 *   loopback URL whose port differs from `port`, else `undefined`
 */
export function loopbackPortMismatch({
  serverUrl,
  port
}: {
  serverUrl: string
  port: number
}): number | undefined {
  const url = new URL(serverUrl)
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(url.hostname)
  if (!loopback) {
    return undefined
  }
  const defaultPort = url.protocol === 'https:' ? 443 : 80
  const effectivePort = url.port === '' ? defaultPort : Number(url.port)
  return effectivePort === port ? undefined : effectivePort
}

/**
 * Parses the `DATABASE_URL` env value: a Postgres connection string that,
 * when set, configures the PostgreSQL storage backend. The string's shape is
 * left to the `pg` driver, which accepts several connection-string forms; an
 * unset or empty value returns `undefined`.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}   the trimmed connection string, or `undefined`
 */
function parseDatabaseUrl(raw: string | undefined): string | undefined {
  return trimmedOrUndefined(raw)
}

/**
 * Parses the `WAS_DATA_DIR` env value: the filesystem root the filesystem
 * backend stores Spaces, keystores, and revocations under, which configures
 * that backend when set. A relative value resolves against the process
 * working directory, so the running server never depends on where its own
 * modules sit on disk. An unset or empty value returns `undefined`: no
 * filesystem backend.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}   the resolved absolute path, or `undefined`
 */
export function parseDataDir(raw: string | undefined): string | undefined {
  const dataDir = trimmedOrUndefined(raw)
  return dataDir === undefined ? undefined : path.resolve(dataDir)
}

/**
 * Parses an env value naming a server backend by its fixed id, `fs` or
 * `postgres`: `WAS_DEFAULT_BACKEND` (the backend the conventional `default`
 * id aliases) or `WAS_CONTROL_PLANE_BACKEND` (the control plane). Whether
 * the named backend is configured is checked once the backends are opened
 * (`ServerBackends`), which also fills in an unset value. Any other value
 * throws.
 * @param options {object}
 * @param [options.raw] {string}   the raw env value
 * @param options.name {string}   the env variable, for the error
 * @returns {string|undefined}   the id, or `undefined` when unset
 */
function parseServerBackendId({
  raw,
  name
}: {
  raw: string | undefined
  name: string
}): string | undefined {
  const id = trimmedOrUndefined(raw)
  if (id === undefined) {
    return undefined
  }
  if (!isServerBackendId(id)) {
    throw new Error(
      `${name} must be one of ${SERVER_BACKEND_IDS.join(', ')}; got "${id}".`
    )
  }
  return id
}

/**
 * Parses the at-rest key-record encryption env surface into a
 * {@link KmsRecordKekRegistry} (the optional hardening increment). Each KEK is a
 * single AES-256 key-encryption key in base58btc Multikey form
 * (`secretKeyMultibase`, header `0xa2 0x01`), whose id is derived from its
 * material (`deriveKekId`) and stored per record -- so registering a second KEK
 * for rotation is a config change, not a schema migration. Three env variables
 * feed it:
 *
 * - `KMS_RECORD_KEK` -- a single KEK (the teaching default alias);
 * - `KMS_RECORD_KEKS` -- a comma-separated list of KEKs, each registered by its
 *   derived id; the FIRST entry is the current KEK by default, so a rotation is
 *   "prepend the new KEK, keep the old one behind it". Surrounding whitespace is
 *   trimmed and empty entries ignored; a duplicate entry (same derived id twice)
 *   throws;
 * - `KMS_RECORD_CURRENT_KEK` -- optionally overrides which registered KEK wraps
 *   NEW records: a `urn:kek:sha256:<hex>` id, a multibase KEK value (its id
 *   derived), or the literal `none` (case-insensitive) which sets
 *   `currentKekId: null` -- the decrypt-only posture (old records still read, new
 *   records are written plaintext). It must name a registered KEK.
 *
 * All three unset/empty returns `undefined`, meaning encryption is disabled --
 * key records are written plaintext (the default, honest about the teaching
 * server's threat model). Setting both `KMS_RECORD_KEK` and `KMS_RECORD_KEKS` is
 * ambiguous and throws; setting `KMS_RECORD_CURRENT_KEK` with no KEK configured
 * throws. A malformed value throws (fails startup), naming the offending
 * variable (and, for a list entry, its 1-based position) but never echoing the
 * secret.
 * @param options {object}
 * @param [options.kek] {string}   the `KMS_RECORD_KEK` value
 * @param [options.keks] {string}   the `KMS_RECORD_KEKS` value
 * @param [options.currentKek] {string}   the `KMS_RECORD_CURRENT_KEK` value
 * @returns {KmsRecordKekRegistry|undefined}   the registry, or `undefined` when
 *   no KEK is configured
 */
export function parseKmsRecordKekRegistry({
  kek,
  keks,
  currentKek
}: {
  kek?: string
  keks?: string
  currentKek?: string
}): KmsRecordKekRegistry | undefined {
  const kekValue = trimmedOrUndefined(kek)
  const keksValue = trimmedOrUndefined(keks)
  const currentValue = trimmedOrUndefined(currentKek)

  if (kekValue !== undefined && keksValue !== undefined) {
    throw new Error(
      'Set only one of KMS_RECORD_KEK or KMS_RECORD_KEKS, not both (ambiguous).'
    )
  }

  // Build the ordered registry: each KEK keyed by its derived id, in config
  // order (the first entry is the default current KEK).
  const registry = new Map<string, RecordKek>()

  if (kekValue !== undefined) {
    const parsed = parseKekMultibase(kekValue)
    registry.set(parsed.id, parsed)
  } else if (keksValue !== undefined) {
    // Empty entries are ignored (like WAS_ENABLED_BACKENDS) and not counted.
    for (const [index, entry] of splitCsv(keksValue).entries()) {
      const position = index + 1
      const parsed = parseKekMultibase(
        entry,
        `KMS_RECORD_KEKS entry ${position}`
      )
      if (registry.has(parsed.id)) {
        throw new Error(
          `KMS_RECORD_KEKS entry ${position} duplicates an earlier KEK ` +
            `(same derived kekId); register each KEK only once.`
        )
      }
      registry.set(parsed.id, parsed)
    }
  }

  // No KEK material at all (all unset, or a list of only empty entries): a
  // dangling KMS_RECORD_CURRENT_KEK is an error; otherwise encryption is off.
  if (registry.size === 0) {
    if (currentValue !== undefined) {
      throw new Error(
        'KMS_RECORD_CURRENT_KEK is set but no KEK is configured; ' +
          'set KMS_RECORD_KEK or KMS_RECORD_KEKS.'
      )
    }
    return undefined
  }

  const currentKekId =
    currentValue !== undefined
      ? resolveCurrentKekId(currentValue, registry)
      : registry.keys().next().value!
  return { keks: registry, currentKekId }
}

/**
 * Resolves a `KMS_RECORD_CURRENT_KEK` value to a registered `kekId` (or `null`
 * for the literal `none`, the decrypt-only posture). The value is either a
 * `urn:kek:sha256:<hex>` id or a multibase KEK whose id is derived; either way
 * it must match a KEK already in `registry`. Throws on an unregistered target,
 * naming the variable but never echoing the secret.
 * @param value {string}   the trimmed `KMS_RECORD_CURRENT_KEK` value
 * @param registry {Map<string, RecordKek>}   the registered KEKs, by id
 * @returns {string|null}   the resolved current `kekId`, or `null` for `none`
 */
function resolveCurrentKekId(
  value: string,
  registry: Map<string, RecordKek>
): string | null {
  if (value.toLowerCase() === 'none') {
    return null // decrypt-only: keep KEKs for unwrap, write new records plaintext
  }
  const kekId = value.startsWith('urn:kek:sha256:')
    ? value
    : parseKekMultibase(value, 'KMS_RECORD_CURRENT_KEK').id
  if (!registry.has(kekId)) {
    throw new Error(
      'KMS_RECORD_CURRENT_KEK names a KEK that is not registered ' +
        '(no matching KMS_RECORD_KEK / KMS_RECORD_KEKS entry).'
    )
  }
  return kekId
}

/**
 * The shared body of the three limit parsers below: an unset or empty value
 * returns `undefined`, the literal `unlimited` (case-insensitive, trimmed)
 * returns `Infinity`, and anything else must be a non-negative integer. A
 * malformed value throws, naming the variable, the quantity it expects, and the
 * `unlimited` escape hatch. Private: each env variable keeps its own exported
 * parser (and its own error wording) below.
 * @param raw {string|undefined}   the raw env value
 * @param name {string}   the env variable name, for the error message
 * @param quantity {string}   the expected quantity as it reads in the error
 *   message (e.g. `a non-negative integer number of bytes`)
 * @returns {number|undefined}   the parsed value, `Infinity` for `unlimited`,
 *   or `undefined` when unset
 */
function parseLimit(
  raw: string | undefined,
  name: string,
  quantity: string
): number | undefined {
  const trimmed = trimmedOrUndefined(raw)
  if (trimmed === undefined) {
    return undefined
  }
  if (trimmed.toLowerCase() === 'unlimited') {
    return Infinity
  }
  const value = parseDecimalInteger(trimmed)
  if (value === undefined) {
    throw new Error(
      `${name} must be ${quantity}, or "unlimited"; got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `STORAGE_LIMIT_PER_SPACE` env value into a per-Space capacity in
 * bytes (spec "Quotas"). Accepts a plain non-negative integer number of bytes,
 * or the literal `unlimited` (case-insensitive, trimmed) which returns
 * `Infinity` -- an explicitly acknowledged unlimited quota (no startup
 * warning). An unset or empty value returns `undefined`, meaning no limit is
 * configured (still unlimited, but `start.ts` warns to prompt an explicit
 * choice). A malformed value throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}   capacity in bytes, `Infinity` for `unlimited`,
 *   or `undefined` when unset
 */
export function parseStorageLimit(raw: string | undefined): number | undefined {
  return parseLimit(
    raw,
    'STORAGE_LIMIT_PER_SPACE',
    'a non-negative integer number of bytes'
  )
}

/**
 * Parses the `MAX_UPLOAD_BYTES` env value into a per-upload size cap in bytes
 * (spec "Quotas", the backend's `maxUploadBytes` constraint). Accepts a plain
 * non-negative integer number of bytes, or the literal `unlimited`
 * (case-insensitive, trimmed) which returns `Infinity` -- explicitly no cap.
 * An unset or empty value returns `undefined`, meaning not configured: the
 * backends apply the {@link DEFAULT_MAX_UPLOAD_BYTES} default (a default-on
 * limit). A single upload exceeding the cap is rejected with
 * `payload-too-large` (413), while smaller uploads still succeed. A malformed
 * value throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}   the per-upload cap in bytes, `Infinity` for
 *   `unlimited`, or `undefined` when unset
 */
export function parseMaxUploadBytes(
  raw: string | undefined
): number | undefined {
  return parseLimit(
    raw,
    'MAX_UPLOAD_BYTES',
    'a non-negative integer number of bytes'
  )
}

/**
 * Parses one of the count-quota env values (`MAX_SPACES_PER_CONTROLLER`,
 * `MAX_COLLECTIONS_PER_SPACE`) into a maximum count.
 * Accepts a plain non-negative integer, or the literal `unlimited`
 * (case-insensitive, trimmed) which returns `Infinity` -- explicitly no cap. An
 * unset or empty value returns `undefined`, meaning not configured: the backends
 * apply the matching default-on limit ({@link DEFAULT_MAX_SPACES_PER_CONTROLLER}
 * and friends). A malformed value throws, naming the variable and the
 * `unlimited` escape hatch.
 * @param raw {string|undefined}   the raw env value
 * @param name {string}   the env variable name, for the error message
 * @returns {number|undefined}   the max count, `Infinity` for `unlimited`, or
 *   `undefined` when unset
 */
export function parseCountLimit(
  raw: string | undefined,
  name: string
): number | undefined {
  return parseLimit(raw, name, 'a non-negative integer')
}

/**
 * Normalizes a count-quota constructor option to the internal instance field
 * both backends store: an unset option (`undefined`) applies the default-on
 * `fallback` limit; a non-finite option (`Infinity`, from an explicit
 * `unlimited`) becomes `undefined` (no cap); a finite value passes through.
 * Shared so the two backends cannot drift on the mapping (the same posture as
 * the `maxUploadBytes` normalization each backend already applies), letting each
 * count guard keep its plain `!== undefined` test.
 * @param value {number|undefined}   the constructor option
 * @param fallback {number}   the default-on limit applied when unset
 * @returns {number|undefined}   the internal limit, or `undefined` for no cap
 */
export function normalizeCountLimit(
  value: number | undefined,
  fallback: number
): number | undefined {
  if (value === undefined) {
    return fallback
  }
  return Number.isFinite(value) ? value : undefined
}

/**
 * Normalizes a backend's `capacityBytes` constructor option: a non-finite value
 * (`Infinity` from an explicit `unlimited`) behaves exactly like unset inside
 * the backend, no configured limit. Shared so the two backends cannot drift on
 * the mapping.
 * @param value {number|undefined}   the constructor option
 * @returns {number|undefined}   the internal limit, or `undefined` for no cap
 */
export function normalizeCapacityBytes(
  value: number | undefined
): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/**
 * Parses the `WAS_ENABLED_BACKENDS` env value into the server-wide registration
 * allowlist: the backend `provider` names a client may register (spec
 * "Backends"). A comma-separated list (e.g. `gdrive,s3`); surrounding whitespace
 * and empty entries are ignored. An unset or empty value returns `undefined`,
 * meaning no allowlist is configured -- any provider may be registered (the
 * permissive default, preserving prior behavior). When set, a registration whose
 * `provider` is not listed is rejected with `unsupported-backend` (409).
 * @param raw {string|undefined}   the raw env value
 * @returns {string[]|undefined}   the allowed provider names, or `undefined`
 */
function parseEnabledBackends(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  const providers = splitCsv(raw)
  return providers.length > 0 ? providers : undefined
}

/**
 * Parses the `WAS_ONBOARDING_TOKEN` env value into the shared-secret onboarding
 * token gating the open provisioning endpoints (`POST /spaces/`, Create Space
 * by Id at `PUT /space/:spaceId/meta`, `POST /kms/keystores`). An unset value
 * returns `undefined`, meaning the feature is off -- provisioning is
 * authorized by proving control of the body's controller DID (the teaching
 * default). When set, those endpoints instead require an
 * `Authorization: Bearer <token>` header matching this value, which then
 * substitutes for zcap verification. A set but empty or whitespace-only value
 * throws: it most likely names a token that failed to reach the environment,
 * and reading it as unset would silently open provisioning.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}   the trimmed token, or `undefined` when unset
 */
function parseOnboardingToken(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (raw.trim() === '') {
    throw new Error(
      'WAS_ONBOARDING_TOKEN is set but empty; unset it to leave provisioning open.'
    )
  }
  return raw.trim()
}

/**
 * Parses the `WAS_DISCLOSE_VERSION` env value: whether the exact server version
 * is published by `/health`, the welcome page, and the service description's
 * `instance` member. Accepts `true` or `false` (case-insensitive, trimmed). An
 * unset or empty value returns `true`, since `/health` publishes the build for
 * deploy verification; a hardened deployment sets `false` so version-matching
 * scanners find nothing to match. A malformed value throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {boolean}
 */
function parseDiscloseVersion(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new Error(
    `WAS_DISCLOSE_VERSION must be "true" or "false"; got "${raw}".`
  )
}

/**
 * Parses the `WAS_SERVER_KEY_SEED` env value: the 32-byte Ed25519 seed the
 * server's export-signing key is derived from, in bnid's secret-key-seed
 * encoding (multibase base58btc over a multihash-wrapped seed, `z1A...`, the
 * form `generateSecretKeySeed()` mints). An unset or empty value returns
 * `undefined`, meaning the server has no signing key and exports unsigned. A
 * malformed value or one of the wrong length throws, naming the variable but
 * never echoing the secret.
 * @param raw {string|undefined}   the raw env value
 * @returns {Uint8Array|undefined}   the 32-byte seed, or `undefined` when unset
 */
export function parseServerKeySeed(
  raw: string | undefined
): Uint8Array | undefined {
  const value = trimmedOrUndefined(raw)
  if (value === undefined) {
    return undefined
  }
  try {
    return decodeSecretKeySeed({ secretKeySeed: value })
  } catch (err) {
    throw new Error(
      'WAS_SERVER_KEY_SEED is not a valid encoded secret key seed ' +
        '(multibase base58btc, multihash, 32 bytes).',
      { cause: err }
    )
  }
}

/**
 * Parses the `WAS_ADMIN_DID` env value: the Ed25519 `did:key` that controls
 * the `server` Space hosting the server's own identity. An unset or empty
 * value returns `undefined`, meaning that Space is not provisioned. Anything
 * but a syntactically valid Ed25519 `did:key` throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {IDID|undefined}
 */
export function parseAdminDid(raw: string | undefined): IDID | undefined {
  const value = trimmedOrUndefined(raw)
  if (value === undefined) {
    return undefined
  }
  if (!isValidController(value)) {
    throw new Error(
      `WAS_ADMIN_DID must be an Ed25519 did:key (did:key:z6Mk...); got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `WAS_ORIGIN_ID` env value: the store's origin id, used verbatim.
 * An unset or empty value returns `undefined`, meaning the store's own id is
 * read, or minted on first boot. A value outside `[A-Za-z0-9_-]{1,64}` throws.
 * @param raw {string|undefined}   the raw env value
 * @returns {string|undefined}
 */
export function parseOriginId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') {
    return undefined
  }
  // Not trimmed: the id is stored and advertised as set, so surrounding
  // whitespace is refused rather than silently dropped.
  if (!isValidOriginId(raw)) {
    throw new Error(
      `WAS_ORIGIN_ID must match ${ORIGIN_ID_PATTERN.source} (1 to 64 ` +
        `ASCII letters, digits, '_' or '-'); got "${raw}".`
    )
  }
  return raw
}

/**
 * Parses the `WAS_REPLICATION_CLOCK_BOUND_MS` env value: the clock bound for a
 * received write stamp, a positive number of milliseconds. An unset or empty
 * value returns `undefined`, meaning {@link REPLICATION_CLOCK_BOUND_MS}.
 * @param raw {string|undefined}   the raw env value
 * @returns {number|undefined}
 */
function parseReplicationClockBound(
  raw: string | undefined
): number | undefined {
  const trimmed = trimmedOrUndefined(raw)
  if (trimmed === undefined) {
    return undefined
  }
  const value = parseDecimalInteger(trimmed)
  if (value === undefined || value < 1) {
    throw new Error(
      `WAS_REPLICATION_CLOCK_BOUND_MS must be a positive integer number of ` +
        `milliseconds; got "${raw}".`
    )
  }
  return value
}

/**
 * Parses the `WAS_WEBVH_BLOCKLIST` env value: a comma-separated list of the
 * foreign `did:webvh` DIDs whose history log is never fetched, so they cannot
 * invoke a delegated capability here. Each entry is a host name, which blocks
 * every DID on that host, or a full `did:webvh` DID. Surrounding whitespace
 * and empty entries are ignored. An unset or empty value returns `undefined`,
 * meaning none is blocked. A malformed entry throws, naming it.
 * @param raw {string|undefined}   the raw env value
 * @returns {string[]|undefined}   the trimmed entries, or `undefined`
 */
export function parseWebvhBlocklist(
  raw: string | undefined
): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  const entries = splitCsv(raw)
  if (entries.length === 0) {
    return undefined
  }
  compileWebvhBlocklist({ entries, source: 'WAS_WEBVH_BLOCKLIST' })
  return entries
}

/**
 * Max number of Space-scoped zcap revocation records Import Space accepts in
 * one archive. Each record costs the import a full capability-chain
 * verification before it is installed, so an archive past this count is
 * refused as `invalid-import` (400) before anything is written.
 */
export const IMPORT_MAX_REVOCATIONS = 1_000

export const SPEC_URL = 'https://w3c-ccg.github.io/portable-web-spaces-spec/'
