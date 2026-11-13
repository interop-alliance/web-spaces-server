/**
 * The PWS protocol surface as a registerable Fastify plugin (`fastifyWas`):
 * the storage/config decorations, CORS, multipart and content-type parsers,
 * and the route groups (the four PWS groups plus the WebKMS `/kms` facet) --
 * everything from routes.ts down, including the auth/digest hook chains and
 * the error handler those groups install.
 *
 * The community `createApp()` (server.ts) registers this plugin with defaults;
 * a hardened downstream composition registers the same plugin (with its own
 * backend and policy plugins around it) and inherits the identical wire
 * behavior. Its `ownsBackend` and `cors` options let such a composition keep
 * the backend lifecycle and the CORS policy to itself. Wrapped with
 * `fastify-plugin`, so the decorations and parsers land on the root instance
 * -- while each route group still creates its own encapsulated context for
 * its hooks.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import cors, { type FastifyCorsOptions } from '@fastify/cors'
import Multipart from '@fastify/multipart'
import { JSON_MEDIA_TYPE } from '@interop/storage-core'

import {
  initCollectionRoutes,
  initKmsRoutes,
  initResourceRoutes,
  initSpaceRoutes,
  initSpacesRepositoryRoutes
} from './routes.js'
import { initExchangeRoutes } from './exchanges.js'
import {
  addServiceLinkHook,
  initServiceDescriptionRoutes
} from './serviceDescription.js'
import {
  assertValidServerUrl,
  CORS_PREFLIGHT_MAX_AGE
} from './config.default.js'
import { defaultBackend as openFallbackBackend } from './storage.js'
import { ServerBackends } from './lib/serverBackends.js'
import { bufferedBodyLimit } from './lib/bodyLimit.js'
import { onboardingTokenAuthorizer } from './provisioning.js'
import {
  fetchPeerLog,
  PeerWebvhResolver,
  type PeerLogFetcher
} from './lib/peerWebvh.js'
import { compileWebvhBlocklist } from './lib/webvhBlocklist.js'
import { fetchFromPeer, type PeerFetch } from './sync/peerFetch.js'
import { ReplicationManager } from './sync/replication.js'
import {
  createServerSigningKey,
  provisionServerSpace,
  resolveServerDid
} from './lib/serverIdentity.js'
import type {
  StorageBackend,
  BackendProviderRegistry,
  KmsRecordKekRegistry,
  AuthorizeProvisioning,
  IDID
} from './types.js'

export interface FastifyWasOptions {
  /**
   * This server's base URL; used to build and match ZCap invocationTarget URLs
   * (host and port must match exactly). Required: it must be an absolute
   * `http:`/`https:` URL with no userinfo, path, query, or fragment (validated
   * at registration -- sub-path deployment is not supported).
   */
  serverUrl: string
  /**
   * The server's own persistence backends, each either open or a function
   * that opens one. The plugin calls each function at registration, after it
   * has validated its other options, and hands it `fastify.log`, so the
   * backend's startup work (the Postgres migrations) logs through the app's
   * logger and a refused option leaves the store untouched. Each backend is
   * keyed by the fixed id its `describe()` reports (`fs`, `postgres`); two
   * under one id, or origin ids that differ, are refused. Defaults to one
   * filesystem backend rooted at `dataDir` (the project `data/` directory when
   * that is unset). A backend the plugin opens is the plugin's to close, so
   * the function form is refused with `ownsBackend: false`.
   */
  backends?: (
    | StorageBackend
    | ((options: { logger: FastifyBaseLogger }) => Promise<StorageBackend>)
  )[]
  /**
   * The one-backend form of `backends`: `backend: b` is `backends: [b]`.
   * Passing both is refused.
   */
  backend?:
    | StorageBackend
    | ((options: { logger: FastifyBaseLogger }) => Promise<StorageBackend>)
  /**
   * The fixed id of the backend the conventional `default` id aliases (config
   * `WAS_DEFAULT_BACKEND`): the data plane of every Collection that selects
   * `default` or no backend. Unset, `fs` when that backend is configured,
   * else the only configured backend; several without a filesystem backend
   * is refused, as is an id naming no configured backend.
   */
  defaultBackend?: string
  /**
   * The fixed id of the backend that is the control plane (config
   * `WAS_CONTROL_PLANE_BACKEND`), holding every Space and Collection
   * Metadata object, the policies, the registrations, the keystores and the
   * revocations. Unset, `postgres` when that backend is configured, else
   * `fs`. An id naming no configured backend is refused.
   */
  controlPlaneBackend?: string
  /**
   * Whether the plugin manages the backends' lifecycle. When `true` (the
   * default), it routes each backend's `logger` to `fastify.log` and wires
   * its `close()` to Fastify's `onClose`. When `false`, it does neither, and
   * the composition logs and closes the backends itself. A backend is always
   * obtained from its async factory (which runs the Postgres migrations or
   * the filesystem store stamp), so neither setting opens one. `false`
   * requires injected, already open `backends`, since the composition can
   * only run the lifecycle of a backend it holds a handle to; passing it
   * with none, or with a function that opens one, is refused at
   * registration.
   */
  ownsBackend?: boolean
  /**
   * The `@fastify/cors` registration. `false` registers no CORS plugin, so a
   * composition can bring its own. An options object overrides `origin`
   * and/or `methods`. `undefined` keeps the default: `origin: '*'`, the
   * methods the PWS routes serve, the exposed headers browser clients need,
   * and a cached preflight. PWS authorization is signature-based rather than
   * cookie-based, so a wide-open origin is the protocol-appropriate default.
   */
  cors?: false | Pick<FastifyCorsOptions, 'origin' | 'methods'>
  /**
   * Filesystem root the fallback filesystem backend stores under, applied
   * only when no `backends` are given (an injected backend carries its own
   * root). `undefined` uses the project `data/` directory.
   */
  dataDir?: string
  /**
   * Per-Space storage limit in bytes (spec "Quotas"); applied only to the
   * fallback filesystem backend (an injected backend carries its own
   * `capacityBytes`).
   * `undefined` means unlimited; `Infinity` (an explicit `unlimited`) is
   * normalized by the backend to the same no-limit behavior.
   */
  storageLimitPerSpace?: number
  /**
   * Per-upload size cap in bytes (spec "Quotas", `maxUploadBytes`); applied
   * only to the fallback filesystem backend (an injected backend carries its
   * own).
   * `undefined` applies the backend's default-on cap
   * ({@link DEFAULT_MAX_UPLOAD_BYTES}); `Infinity` (an explicit `unlimited`)
   * disables the cap.
   */
  maxUploadBytes?: number
  /**
   * Max Spaces a single controller may create (spec "Quotas", a default-on
   * count quota); applied only to the fallback filesystem backend (an
   * injected backend carries its own). `undefined` applies the backend's default
   * ({@link DEFAULT_MAX_SPACES_PER_CONTROLLER}); `Infinity` (an explicit
   * `unlimited`) disables the cap.
   */
  maxSpacesPerController?: number
  /**
   * Max Collections a single Space may hold (spec "Quotas", a default-on count
   * quota); applied only to the fallback filesystem backend (an injected
   * backend carries its own). `undefined` applies the backend's default
   * ({@link DEFAULT_MAX_COLLECTIONS_PER_SPACE}); `Infinity` (an explicit
   * `unlimited`) disables the cap.
   */
  maxCollectionsPerSpace?: number
  /**
   * The provider-adapter registry the resolver uses to build a Collection's
   * selected external backend; defaults to an empty map (no external backend
   * is operable).
   */
  providers?: BackendProviderRegistry
  /**
   * The registration allowlist of backend `provider` names; `undefined` means
   * permissive.
   */
  enabledBackendProviders?: string[]
  /**
   * The at-rest WebKMS key-record encryption registry (config `KMS_RECORD_KEK` /
   * `KMS_RECORD_KEKS` / `KMS_RECORD_CURRENT_KEK`); `undefined` (or
   * `currentKekId: null`) disables encryption -- key records are written
   * plaintext (the teaching default).
   */
  kmsRecordKek?: KmsRecordKekRegistry
  /**
   * Custom provisioning gate for `POST /spaces/`, Create Space by Id
   * (`PUT /space/:spaceId/meta` on an absent Space), and `POST /kms/keystores`;
   * receives `{ request }` and returns `'verify'` (normal zcap path), `'grant'`
   * (authorized by the callback -- skip zcap verification), or `'deny'` (403).
   * `undefined` means allow (the teaching default). Mutually exclusive with
   * `onboardingToken`.
   */
  authorizeProvisioning?: AuthorizeProvisioning
  /**
   * Shared-secret gate for `POST /spaces/`, Create Space by Id, and
   * `POST /kms/keystores` (config `WAS_ONBOARDING_TOKEN`); when set, those
   * endpoints require an `Authorization: Bearer <token>` header, which then
   * substitutes for zcap verification on that request. `undefined` means
   * disabled (the teaching default); an empty string is refused at
   * registration. Mutually exclusive with `authorizeProvisioning`.
   */
  onboardingToken?: string
  /**
   * Whether the service description's `instance` member carries the server
   * version (config `WAS_DISCLOSE_VERSION`); `createApp()` applies the same
   * switch to `/health` and the welcome page. Defaults to `true`.
   */
  discloseVersion?: boolean
  /**
   * The 32-byte Ed25519 seed the server's export-signing key is derived from
   * (config `WAS_SERVER_KEY_SEED`). The key is advertised on `/service` as
   * `exportSigningMethod`. `undefined` means no signing key: exports are
   * unsigned and neither identity member is served.
   */
  serverKeySeed?: Uint8Array
  /**
   * The `did:key` that controls the `server` Space hosting the server's own
   * `did:webvh` history log (config `WAS_ADMIN_DID`). When set, that Space is
   * provisioned at registration if absent, and a stored one must carry this
   * controller. `undefined` means the Space is not provisioned.
   */
  adminDid?: IDID
  /**
   * The store's origin id (env `WAS_ORIGIN_ID`), applied only to the fallback
   * filesystem backend (an injected backend carries its own). Used verbatim;
   * `undefined` reads the store's own id, or mints one on first boot.
   */
  originId?: string
  /**
   * The clock bound for a write stamp received from a peer, in milliseconds
   * (env `WAS_REPLICATION_CLOCK_BOUND_MS`), applied only to the fallback
   * filesystem backend. `undefined` means `REPLICATION_CLOCK_BOUND_MS`.
   */
  replicationClockBoundMs?: number
  /**
   * The physical clock (epoch milliseconds) the fallback filesystem backend's
   * hybrid logical clock reads, applied only to that backend (an injected
   * backend carries its own). `undefined` means `Date.now`. A test freezes
   * or steps it to drive the write stamps.
   */
  physicalClock?: () => number
  /**
   * Performs the HTTP GET of a foreign `did:webvh` history log, which the
   * capability verifier fetches when such a DID invokes a delegated
   * capability whose chain verified (see `lib/peerWebvh.ts`). `undefined`
   * means `fetchPeerLog`: `https` on the default port, no redirects, public
   * addresses only. A test injects one to serve a peer log from memory. No
   * configuration setting reaches it.
   */
  peerLogFetcher?: PeerLogFetcher
  /**
   * The foreign `did:webvh` DIDs whose log is never fetched (config
   * `WAS_WEBVH_BLOCKLIST`): each entry a host name, which blocks every DID on
   * that host (compared case-insensitively), or a full `did:webvh` DID. A
   * blocked DID cannot invoke a delegated capability here; it is answered
   * like any DID whose chain did not verify. A malformed entry is refused at
   * registration. `undefined` means none is blocked.
   */
  webvhBlocklist?: string[]
  /**
   * Makes the requests a replica registration's pull loop sends its source
   * peer (see `sync/peerFetch.ts`). `undefined` means `fetchFromPeer`:
   * `https` on the default port, no redirects, public addresses only. A test
   * injects one to reach a peer booted in the same process. No configuration
   * setting reaches it.
   */
  peerFetch?: PeerFetch
  /**
   * The delay between two pull cycles of a replica registration that both
   * reached the peer, in milliseconds. `undefined` means
   * `REPLICATION_PULL_INTERVAL_MS`.
   */
  replicationPullIntervalMs?: number
}

/**
 * Decorates the instance with the PWS storage/config surface, registers the
 * protocol-level plugins and content-type parsers, and mounts the route groups.
 * @param fastify {import('fastify').FastifyInstance}
 * @param options {FastifyWasOptions}
 * @returns {Promise<void>}
 */
async function wasPlugin(
  fastify: FastifyInstance,
  options: FastifyWasOptions
): Promise<void> {
  const {
    serverUrl,
    backends: backendsOption,
    backend,
    defaultBackend,
    controlPlaneBackend,
    ownsBackend = true,
    cors: corsOptions,
    dataDir,
    storageLimitPerSpace,
    maxUploadBytes,
    maxSpacesPerController,
    maxCollectionsPerSpace,
    providers,
    enabledBackendProviders,
    kmsRecordKek,
    authorizeProvisioning,
    onboardingToken,
    discloseVersion = true,
    serverKeySeed,
    adminDid,
    originId,
    replicationClockBoundMs,
    physicalClock,
    peerLogFetcher,
    webvhBlocklist,
    peerFetch,
    replicationPullIntervalMs
  } = options

  // Fail fast on a missing or malformed base URL: without one no ZCap
  // invocationTarget can be built or matched, and one carrying a path, query,
  // or fragment silently breaks every match and Location header (URL-joins
  // drop the base path).
  assertValidServerUrl(serverUrl)

  // An empty token would read as no gate at all, so it is refused rather than
  // silently leaving provisioning open.
  if (onboardingToken !== undefined && onboardingToken.trim() === '') {
    throw new Error('onboardingToken must not be empty.')
  }
  // The two provisioning gates are alternative ways to configure the same seam.
  if (authorizeProvisioning && onboardingToken) {
    throw new Error(
      'authorizeProvisioning and onboardingToken are mutually exclusive.'
    )
  }

  // Refused here, before any backend is opened, like the other options.
  const compiledWebvhBlocklist = compileWebvhBlocklist({
    entries: webvhBlocklist ?? [],
    source: 'webvhBlocklist'
  })

  if (backend !== undefined && backendsOption !== undefined) {
    throw new Error('backend and backends are mutually exclusive.')
  }
  const backends = backend !== undefined ? [backend] : backendsOption
  // A composition that runs the backend lifecycle itself needs the backends
  // in hand, or there is nothing for it to close.
  if (
    !ownsBackend &&
    (backends === undefined ||
      backends.length === 0 ||
      backends.some(candidate => typeof candidate !== 'object'))
  ) {
    throw new Error(
      'ownsBackend: false requires an injected, already open backend option.'
    )
  }

  fastify.decorate('serverUrl', serverUrl)
  fastify.decorate('discloseVersion', discloseVersion)
  // Every option check above runs before a backend is opened, so a refused
  // option leaves the store untouched. A backend the plugin opens logs
  // through the Fastify pino logger from its first line.
  // No backends option means the fallback filesystem backend, opened like any
  // other opener. An explicit empty list is passed through, and the set
  // refuses it as no backend configured.
  const backendsOrOpeners =
    backends !== undefined
      ? backends
      : [
          ({ logger }: { logger: FastifyBaseLogger }) =>
            openFallbackBackend({
              dataDir,
              logger,
              capacityBytes: storageLimitPerSpace,
              maxUploadBytes,
              maxSpacesPerController,
              maxCollectionsPerSpace,
              originId,
              ...(replicationClockBoundMs !== undefined && {
                clockBoundMs: replicationClockBoundMs
              }),
              ...(physicalClock !== undefined && { physicalClock })
            })
        ]
  const opened: StorageBackend[] = []
  // Backend lifecycle: a backend arrives open (its async factory ran the
  // startup work), so only the optional shutdown hook (pool drain) is wired,
  // to Fastify's close. Wired before anything below can throw, so a failed
  // registration still releases every backend opened so far when the app is
  // closed. The pull loops stop first, in the same hook, so no cycle applies
  // into a closed backend.
  fastify.addHook('onClose', async () => {
    if (fastify.hasDecorator('replication')) {
      await fastify.replication.stop()
    }
    if (ownsBackend) {
      for (const backend of opened) {
        await backend.close?.()
      }
    }
  })
  for (const backendOrOpener of backendsOrOpeners) {
    if (typeof backendOrOpener === 'function') {
      opened.push(await backendOrOpener({ logger: fastify.log }))
    } else {
      // Route the backend's diagnostics through the Fastify pino logger (an
      // injected backend defaults to a silent logger until wired here).
      if (ownsBackend) {
        backendOrOpener.logger = fastify.log
      }
      opened.push(backendOrOpener)
    }
  }

  // A backend that never ran its async factory has no settled origin id, and
  // `/service` would advertise none to a replication peer. Refuse it here
  // rather than on the first request.
  for (const backend of opened) {
    if (typeof backend.originId !== 'string' || backend.originId === '') {
      throw new Error(
        'A storage backend carries no origin id. Obtain the backend from ' +
          'its async open() factory before injecting it.'
      )
    }
  }
  // The set the request layer routes a Collection's data plane through; its
  // control plane is what every handler reads as `storage`.
  const serverBackends = new ServerBackends({
    backends: opened,
    defaultId: defaultBackend,
    controlPlaneId: controlPlaneBackend
  })
  const storage = serverBackends.controlPlane
  fastify.decorate('serverBackends', serverBackends)
  fastify.decorate('storage', storage)

  // The buffered-body limit, derived from the control plane's per-upload cap
  // and applied as every route's `bodyLimit`. Set per route rather than on
  // the instance so a downstream composition that registers this plugin on
  // its own instance gets the same bound. A route that sets its own
  // `bodyLimit` (the exchanges POST) keeps it. A server backend other than
  // the control plane enforces its own cap inside its writes.
  const bodyLimit = bufferedBodyLimit(storage.maxUploadBytes)
  fastify.addHook('onRoute', routeOptions => {
    if (routeOptions.bodyLimit === undefined) {
      routeOptions.bodyLimit = bodyLimit
    }
  })

  // The server's own identity. The `server` Space is provisioned (or checked)
  // once storage is up, and the export-signing key is derived from the seed.
  // Whether the key is listed by a resolvable server DID is read per
  // `/service` request rather than fixed here, since the admin writes that
  // log after boot; the read at listen time below only warns. It runs once
  // the server is listening, and reads the `serverUrl` decoration then, so a
  // composition that learns its port from `listen()` is checked against the
  // URL it serves. Fastify does not await it, and logs what it throws.
  if (adminDid !== undefined) {
    await provisionServerSpace({ storage, adminDid })
  }
  const serverSigningKey =
    serverKeySeed === undefined
      ? undefined
      : await createServerSigningKey({ seed: serverKeySeed })
  fastify.decorate('serverSigningKey', serverSigningKey)
  // The foreign did:webvh resolver, one per app, so its cache and rate limits
  // are not shared with another app in the same process.
  fastify.decorate(
    'peerWebvh',
    new PeerWebvhResolver({
      fetchLog: peerLogFetcher ?? fetchPeerLog,
      logger: fastify.log,
      blocklist: compiledWebvhBlocklist
    })
  )
  // One pull loop per stored replica registration, started once the routes
  // are ready so a peer that pulls back finds this server serving.
  const replication = new ReplicationManager({
    serverBackends,
    getServerUrl: () => fastify.serverUrl,
    signingKey: serverSigningKey,
    peerFetch: peerFetch ?? fetchFromPeer,
    logger: fastify.log,
    ...(replicationPullIntervalMs !== undefined && {
      pullIntervalMs: replicationPullIntervalMs
    })
  })
  fastify.decorate('replication', replication)
  fastify.addHook('onReady', async function startReplication() {
    await replication.start()
  })
  if (serverSigningKey !== undefined) {
    fastify.addHook('onListen', async function warnWithoutServerDid() {
      const did = await resolveServerDid({
        storage,
        serverBackends,
        serverUrl: fastify.serverUrl,
        signingKey: serverSigningKey,
        logger: fastify.log
      })
      if (did === undefined) {
        fastify.log.warn(
          { exportSigningMethod: serverSigningKey.exportSigningMethod },
          'No server DID lists the export-signing key yet; exports are ' +
            'unsigned until the admin writes the server history log.'
        )
      }
    })
  }

  // The provider-adapter registry the resolver (lib/backendRegistry.ts) consults
  // to build a Collection's selected external backend. Injected (rather than a
  // module-global mutable registry) so parallel test suites stay isolated -- the
  // same rationale as the injected `storage`. Empty in production this stage.
  fastify.decorate('backendProviders', providers ?? new Map())
  // The optional registration allowlist (config `WAS_ENABLED_BACKENDS`);
  // `undefined` = permissive (any provider may be registered).
  fastify.decorate('enabledBackendProviders', enabledBackendProviders)
  // The at-rest key-record encryption registry (config `KMS_RECORD_KEK`);
  // `undefined` = disabled (records written plaintext). Read at the KMS
  // orchestration seam (KeyRequest), never inside a backend.
  fastify.decorate('kmsRecordKek', kmsRecordKek)
  // The provisioning gate for `POST /spaces/`, Create Space by Id, and
  // `POST /kms/keystores`: a custom callback, or the stock onboarding-token
  // check when a token is set, or `undefined` = allow (the teaching default).
  // Read by the `provisioningGate` onRequest hook installed by the route
  // groups carrying those endpoints.
  fastify.decorate(
    'authorizeProvisioning',
    authorizeProvisioning ??
      (onboardingToken ? onboardingTokenAuthorizer(onboardingToken) : undefined)
  )

  // Every response links to the service description (spec "Discovering the
  // Service Description"), so the hook sits on the root instance.
  addServiceLinkHook(fastify)

  // Open CORS by default (`cors: false` leaves it to the composition).
  // `exposedHeaders` is required for browser clients: without it,
  // cross-origin JS cannot read `Location` (space/resource creation), `ETag`
  // (conditional writes), `Link` (pagination, policy linksets), or
  // `Allow` -- which RFC 9110 makes the whole point of the `405` a `PUT` at a
  // container URL answers, since it names the methods the container does
  // accept. `maxAge` lets browsers cache the preflight answer instead of
  // re-asking before nearly every signed request. No PWS route serves
  // `PATCH`, so it is not offered.
  if (corsOptions !== false) {
    fastify.register(cors, {
      origin: corsOptions?.origin ?? '*',
      methods: corsOptions?.methods ?? [
        'GET',
        'HEAD',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS'
      ],
      exposedHeaders: ['Location', 'ETag', 'Link', 'Allow'],
      maxAge: CORS_PREFLIGHT_MAX_AGE
    })
  }

  // Multipart file uploading. The cap is `files: 2`, not `1`: a write MUST carry
  // exactly one file part, and `resolveResourceInput` enforces that by iterating
  // the parts and rejecting a second one with `invalid-request-body` (400). With
  // a `files: 1` limit busboy would instead silently drop the second part and
  // raise its own `FST_FILES_LIMIT` (413), so the second part must be allowed
  // through to the iterator to be caught and rejected with the correct error.
  //
  // `fileSize` bounds the in-memory buffer of the single permitted part to the
  // buffered-body limit, the same bound the JSON and text parsers get: the
  // backend's per-upload cap when one is configured, else the server's own
  // buffered-body default (`MAX_UPLOAD_BYTES=unlimited` does not uncap an
  // in-memory buffer). Left unset, `@fastify/multipart` would fall back to
  // Fastify's 1 MiB `bodyLimit`. `throwFileSizeLimit` makes `toBuffer()` throw
  // at the boundary, which the request layer maps to `payload-too-large` (413)
  // naming the limit, so an oversize multipart upload is rejected before it is
  // fully buffered. Large binaries should use the streaming raw-body path, not
  // multipart.
  fastify.register(Multipart, {
    throwFileSizeLimit: true,
    limits: {
      files: 2,
      fileSize: bufferedBodyLimit(storage.maxUploadBytes)
    }
  })

  // Parse every JSON media type (`application/json` and the structured-suffix
  // `application/<suffix>+json`, e.g. `application/jose+json` for EDV-over-PWS
  // encrypted documents, `application/ld+json`, etc.) as JSON. Fastify's
  // built-in JSON parser is registered under the exact media type
  // `application/json`, and `getParser` resolves an exact media type ahead of
  // the regex list, so this parser serves the suffix types while the built-in
  // one keeps plain `application/json`. The expression is the one
  // `isJsonContentType()` decides by downstream (digest capture, resource-input
  // resolution), so a body it parses is one the request layer stores as a
  // document, and a type it ends before (`+jsonl`, `+json-seq`) falls through
  // to the catch-all below as a byte stream. Registered on the root instance
  // so every route group inherits it.
  fastify.addContentTypeParser(
    JSON_MEDIA_TYPE,
    { parseAs: 'string' },
    fastify.getDefaultJsonParser('error', 'error')
  )

  // Catch-all parser for arbitrary binary representations. The spec ("Content
  // Types and Representations") lets a Resource be any media type, so a raw
  // (non-multipart) blob PUT/POST -- `application/octet-stream`,
  // `application/jsonl`, images, etc. -- must reach the handler as a byte
  // stream. Fastify only ships parsers for `application/json` and `text/plain`
  // and would otherwise reject every other media type with a 415 before the
  // route runs. This bare pass-through leaves `request.body` as the raw stream,
  // which `resolveResourceInput` normalizes to a `kind: 'binary'` input that the
  // backend streams straight to storage. More specific parsers still win over
  // this fallback: the built-in JSON/text parsers, the `+json` regex above,
  // `@fastify/multipart`'s `multipart/*`, and the `application/x-tar` import
  // parser are all matched ahead of it.
  fastify.addContentTypeParser('*', function (_request, payload, done) {
    done(null, payload)
  })

  fastify.register(initServiceDescriptionRoutes)
  fastify.register(initSpacesRepositoryRoutes)
  fastify.register(initSpaceRoutes)
  fastify.register(initCollectionRoutes)
  fastify.register(initResourceRoutes)
  fastify.register(initKmsRoutes)
  // The ephemeral exchanges facet: unauthenticated by design (no zcap hook
  // chain), so it stays a sibling of the route groups rather than one of them.
  fastify.register(initExchangeRoutes)
}

export const fastifyWas = fp(wasPlugin, {
  fastify: '5.x',
  name: 'fastify-was'
})
