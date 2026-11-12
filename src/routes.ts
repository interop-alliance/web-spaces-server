/**
 * Route layer: maps URL patterns to *Request handler methods. Each group first
 * installs its auth-header requirement, if it has one, then the
 * `parseAuthHeaders` onRequest hook, and redirects the non-canonical slash
 * variant of a path to the canonical form with a 308 (spec "Reading This
 * Document"). The three groups beneath `/space/` install no requirement: a
 * request with no auth headers reaches its handler, whose authorization
 * answers the masked `not-found` (404), the same body an under-authorized
 * signed request gets. The `/spaces/` repository group answers an unsafe
 * method with no auth headers `missing-authorization` (401), since the
 * repository's existence is not sensitive. A container
 * -- the `/spaces/` repository, a Space, a Collection, a Resource's `chunks/`
 * -- is canonically addressed WITH the trailing slash: `GET` lists its
 * members, `POST` adds one, `DELETE` removes the container, and `PUT` is not
 * defined there (405). What a container *is* lives at its `meta`
 * sub-resource: `GET`/`PUT /space/:spaceId/meta` is the Space Metadata object
 * and `GET`/`PUT /space/:spaceId/:collectionId/meta` the Collection Metadata
 * object, and every other sub-resource path (`policy`, `linkset`, `meta`,
 * a Resource) carries no trailing slash. No two registered paths differ only
 * by a trailing slash. (The WebKMS `/kms` group is the exception on both
 * counts: it installs the strict `requireAuthHeaders` -- the webkms protocol
 * has no public reads -- and no slash redirects, since the protocol's URLs
 * are exact. Its 405 refusals are the same as every other group's.)
 *
 * A method a PWS URL does not implement is refused with a 405
 * (`refuseUnimplementedMethods`), and a path beneath a reserved segment that
 * no route serves is not found (`refusePathsBeneath`). Both, like the slash
 * redirects, are marked `config.noAuth`: they answer the same whoever asks,
 * so the group's auth and digest hooks skip them and an anonymous request
 * gets the 405, 404 or 308 before any authorization.
 */
import type { Readable } from 'node:stream'
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
  RouteShorthandOptionsWithHandler
} from 'fastify'
import { SpacesRepositoryRequest } from './requests/SpacesRepositoryRequest.js'
import { SpaceRequest } from './requests/SpaceRequest.js'
import { handleError, MethodNotAllowedError } from './errors.js'
import { ResourceRequest } from './requests/ResourceRequest.js'
import { ChunkRequest } from './requests/ChunkRequest.js'
import { sandboxHostedPage } from './lib/hostedPageSandbox.js'
import { JSON_MEDIA_TYPE } from '@interop/storage-core'
import { CollectionRequest } from './requests/CollectionRequest.js'
import { PolicyRequest, type PolicyParams } from './requests/PolicyRequest.js'
import { BackendRequest } from './requests/BackendRequest.js'
import { ReplicaRequest } from './requests/ReplicaRequest.js'
import { KeystoreRequest } from './requests/KeystoreRequest.js'
import { KeyRequest } from './requests/KeyRequest.js'
import { RevocationRequest } from './requests/RevocationRequest.js'
import {
  parseAuthHeaders,
  requireAuthHeaders,
  requireAuthHeadersOrPublicRead
} from './auth-header-hooks.js'
import { captureRawBody, verifyBodyDigest } from './digest.js'
import {
  RESERVED_COLLECTION_IDS,
  RESERVED_RESOURCE_IDS
} from './lib/validateId.js'
import {
  provisioningGateFor,
  spaceIsAbsent,
  unlessProvisioningAuthorized,
  type OnRequestHook,
  type ProvisioningRoute
} from './provisioning.js'

/**
 * Installs the `handleError` error handler and the hook chain every route group
 * shares, in the one order they all rely on: the optional provisioning gate,
 * the auth-header requirement, `parseAuthHeaders`, `captureRawBody`,
 * `verifyBodyDigest`, then the POST `Cache-Control: no-store` marking and the
 * hosted-page sandbox policy. The four auth and digest hooks skip a route
 * marked `config.noAuth` (a 405 refusal or a 308 redirect); the gate, the
 * two `onSend` hooks and the error handler still apply to it, so its 405 is
 * still a problem document carrying the sandbox policy.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}
 * @param [options.provisioningRoutes] {ProvisioningRoute[]}   routes (URLs
 *   exactly as registered in this group) that go through the provisioning
 *   gate; omit for groups with no provisioning endpoint
 * @param [options.authHeaders] {'every-method' | 'unsafe-methods'}   which
 *   requests the group answers `missing-authorization` (401) when they carry
 *   no auth headers: every one (`requireAuthHeaders`), or the unsafe methods
 *   (`requireAuthHeadersOrPublicRead`). Omitted for the groups beneath
 *   `/space/`, where the handler's authorization answers the masked
 *   `not-found` (404) instead
 * @returns {void}
 */
function installGroupHooks(
  app: FastifyInstance,
  {
    provisioningRoutes,
    authHeaders
  }: {
    provisioningRoutes?: ProvisioningRoute[]
    authHeaders?: 'every-method' | 'unsafe-methods'
  } = {}
): void {
  app.setErrorHandler(handleError)

  if (provisioningRoutes) {
    // Gate provisioning (Create Space, by POST or by PUT of its Metadata
    // object, and Create Keystore): the configured policy may grant/deny, or
    // (the default) allow -- in which case the normal zcap path below runs.
    app.addHook('onRequest', provisioningGateFor(provisioningRoutes))
  }
  // The auth and digest hooks are skipped for a request the gate granted (it
  // carries a Bearer token, not an HTTP Signature), and for a `noAuth` route.
  function guarded(hook: OnRequestHook): OnRequestHook {
    return unlessNoAuthRoute(unlessProvisioningAuthorized(hook))
  }
  if (authHeaders === 'every-method') {
    // Every operation is privileged: 401 when auth headers are absent.
    app.addHook('onRequest', guarded(requireAuthHeaders))
  } else if (authHeaders === 'unsafe-methods') {
    // The SpacesRepository group. Create Space requires auth (401), and an
    // anonymous List Spaces proceeds to the spec's empty-items 200.
    app.addHook('onRequest', guarded(requireAuthHeadersOrPublicRead))
  }
  // Otherwise no requirement is installed. A request with no auth headers
  // reaches its handler: a read may be granted by an access-control policy
  // (e.g. a public Space, Collection or Resource), and anything else is
  // refused by the handler's authorization as the masked `not-found`.
  // Parse the relevant request headers, set the request.zcap parameter
  app.addHook('onRequest', guarded(parseAuthHeaders))
  // Capture raw body bytes (JSON/text) so the digest can be recomputed against
  // exactly what the client signed (spec "Request Body Integrity").
  app.addHook('preParsing', captureRawBodyUnlessNoAuth)
  // Enforce the Digest header binding: require it covered by the signature and,
  // when the raw body is available, recompute and compare it.
  app.addHook('preValidation', guarded(verifyBodyDigest))
  // Mark the response to a non-idempotent operation non-cacheable (spec
  // "Caching"). Only POST is non-idempotent here; reads carry an `ETag` for
  // validation instead, and the spec defers further `Cache-Control` semantics.
  app.addHook('onSend', markPostNoStore)
  // Stamp the hosted-page sandbox policy on every response in the group, so a
  // route serving stored bytes cannot be added without it.
  app.addHook('onSend', sandboxHostedPage)
}

/**
 * Wraps a group hook so it is skipped for a route marked `config.noAuth`: a
 * 405 method refusal or a 308 slash redirect, which answer the same whatever
 * the caller's identity. Every other request reaches the wrapped hook
 * unchanged.
 * @param hook {OnRequestHook}   the hook to guard
 * @returns {OnRequestHook}
 */
function unlessNoAuthRoute(hook: OnRequestHook): OnRequestHook {
  return async function skipForNoAuthRoute(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (request.routeOptions.config.noAuth) {
      return
    }
    await hook(request, reply)
  }
}

/**
 * The `preParsing` form of {@link unlessNoAuthRoute} for `captureRawBody`: a
 * `noAuth` route gets its body stream back untouched.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @param payload {Readable}   the raw request body stream
 * @returns {Promise<Readable>}   the stream Fastify should parse
 */
async function captureRawBodyUnlessNoAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: Readable
): Promise<Readable> {
  if (request.routeOptions.config.noAuth) {
    return payload
  }
  return captureRawBody(request, reply, payload)
}

/**
 * The `onSend` hook that stamps `Cache-Control: no-store` on the response to
 * a non-idempotent POST, whatever its status (spec "Caching"). Two kinds of
 * POST are left alone: a slash-variant redirect, which is a cacheable 308 that
 * performs nothing, and a route registered with `config.safe` -- a read that
 * uses POST only to carry a body (Query, Export).
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @param payload {unknown}
 * @returns {Promise<unknown>}
 */
async function markPostNoStore(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  if (
    request.method === 'POST' &&
    !request.routeOptions.config.safe &&
    (reply.statusCode < 300 || reply.statusCode >= 400)
  ) {
    reply.header('cache-control', 'no-store')
  }
  return payload
}

/**
 * Route config marking a POST route as a read (safe in the RFC 9110 sense):
 * it uses POST only to carry a request body, so `markPostNoStore` leaves its
 * response cacheable.
 */
const safeRoute = { config: { safe: true } }

/**
 * Route config marking a route that answers the same whatever the caller's
 * identity -- a 308 slash redirect here, and every 405 refusal through
 * `methodNotAllowed` -- so the group's auth and digest hooks skip it. A
 * redirect reveals nothing about its target, and the bare form of a container
 * URL reaches its 405 only through one.
 */
const noAuthRoute = { config: { noAuth: true } }

/**
 * Splits a request URL into its path and its query string (`?` included, or
 * empty), so a redirect can rewrite the path and carry the query over.
 * @param url {string}   the request URL (path plus optional query string)
 * @returns {{ pathPart: string, query: string }}
 */
function splitQuery(url: string): { pathPart: string; query: string } {
  const queryIndex = url.indexOf('?')
  return queryIndex === -1
    ? { pathPart: url, query: '' }
    : { pathPart: url.slice(0, queryIndex), query: url.slice(queryIndex) }
}

/**
 * The request's actual path with a trailing slash appended (preserving any
 * query string): the canonical target for a slash redirect. Built from
 * `request.url` rather than the route template so the `Location` carries the
 * concrete ids (`/space/abc123`), not the literal `/space/:spaceId` -- which a
 * client cannot follow.
 * @param url {string}   the request URL (path plus optional query string)
 * @returns {string}
 */
function withSlash(url: string): string {
  const { pathPart, query } = splitQuery(url)
  const canonical = pathPart.endsWith('/') ? pathPart : `${pathPart}/`
  return `${canonical}${query}`
}

/**
 * The request's actual path with its trailing slash stripped (preserving any
 * query string): the canonical target for a no-slash redirect (see
 * {@link withSlash}).
 * @param url {string}   the request URL (path plus optional query string)
 * @returns {string}
 */
function withoutSlash(url: string): string {
  const { pathPart, query } = splitQuery(url)
  const canonical = pathPart.endsWith('/') ? pathPart.slice(0, -1) : pathPart
  return `${canonical}${query}`
}

/**
 * Redirects to the trailing-slash canonical form of the request URL with a
 * `308` (Permanent Redirect), which -- unlike the default `302` -- requires the
 * client to replay the same method and body, so a redirected POST/PUT is not
 * silently downgraded to GET.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectAddSlash(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  return reply.redirect(withSlash(request.url), 308)
}

/**
 * Redirects to the no-trailing-slash canonical form of the request URL (see
 * {@link redirectAddSlash} for the `308` rationale).
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectStripSlash(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  return reply.redirect(withoutSlash(request.url), 308)
}

/**
 * Redirects the retired `/space/:spaceId/collections` endpoint (either slash
 * form) to the Space container URL, which lists and creates Collections since
 * v0.5, with a `308` so a POST is replayed as a POST (spec "Reserved Path
 * Segment Registry": a server MAY answer the retired path with a 308 to the
 * Space URL). Rewrites the path rather than toggling its slash, preserving
 * any query string. The rewrite strips the trailing `collections` segment off
 * the request path as sent, rather than rebuilding the path from
 * `request.params.spaceId` -- the router has already percent-decoded that
 * param, so rebuilding from it would emit a `Location` naming a different
 * resource (`/space/a%2Fb/collections` would redirect to `/space/a/b/`) or
 * inject a query into the path (`a%3Fx=1`). Toggling the request path
 * verbatim, as the slash redirects do, keeps the id byte-identical to what
 * the client sent.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {FastifyReply}
 */
function redirectCollectionsToSpace(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  const { pathPart, query } = splitQuery(request.url)
  // Both registered forms end in `collections` or `collections/`; dropping
  // that leaves the Space container URL, trailing slash included.
  const spaceUrl = pathPart.replace(/collections\/?$/, '')
  return reply.redirect(`${spaceUrl}${query}`, 308)
}

/**
 * Answers a method that is not defined at a URL with `405 Method Not Allowed`.
 * Two kinds of URL use it. A container URL refuses `PUT` (spec: a server MUST
 * answer a `PUT` at the Space URL with 405; the same for a Collection), since a
 * container is described at its `meta` sub-resource. And a reserved endpoint
 * refuses every method it does not implement (spec "Methods at Reserved
 * Endpoints"; see `refuseUnimplementedMethods`). Registered explicitly rather
 * than left to fall through, so the `Allow` header can name what the URL does
 * accept -- and so a request to a reserved endpoint does not reach the
 * parametric route one level up, whose reserved-id guard would answer the
 * unrelated `409 reserved-id`.
 *
 * Returns route options rather than a bare handler. The route is marked
 * `config.noAuth`, so the group's auth and digest hooks skip it, and the
 * refusal is thrown from a route-level `onRequest` hook, so it answers before
 * the body is parsed. An anonymous request, or one with a malformed body, gets
 * the same 405 as a signed one.
 * @param allow {string[]}   the methods implemented at the URL
 * @param [hint] {string}   one sentence naming where the refused operation
 *   lives instead
 * @returns {RouteShorthandOptionsWithHandler}
 */
function methodNotAllowed(
  allow: string[],
  hint?: string
): RouteShorthandOptionsWithHandler {
  async function refuseMethod(): Promise<never> {
    throw new MethodNotAllowedError({
      allow,
      ...(hint !== undefined && { hint })
    })
  }
  return { ...noAuthRoute, onRequest: refuseMethod, handler: refuseMethod }
}

/**
 * The methods a PWS container URL (a Space or a Collection) accepts: list its
 * members, add one, delete the container.
 */
const CONTAINER_METHODS: HTTPMethods[] = ['GET', 'HEAD', 'POST', 'DELETE']

/**
 * The order an `Allow` header lists methods in, so the header reads the same
 * however the routes happen to be registered.
 */
const ALLOW_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'QUERY']

/** The sentence a container-URL `PUT` refusal carries. */
const CONTAINER_PUT_HINT =
  'A container is described at its "meta" sub-resource.'

/** The sentence a Metadata-URL `DELETE` refusal carries. */
const CONTAINER_META_DELETE_HINT =
  'A Metadata object is removed by deleting the container it describes.'

/**
 * The methods a refusal or a not-found anchor is registered for: every method
 * Fastify routes except `OPTIONS`, which the CORS plugin's preflight route
 * answers. Read per instance, since a plugin can add a method.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @returns {HTTPMethods[]}
 */
function routedMethods(app: FastifyInstance): HTTPMethods[] {
  return app.supportedMethods.filter(
    method => method !== 'OPTIONS'
  ) as HTTPMethods[]
}

/**
 * Records the URL template of every route a group registers, so the group can
 * refuse the methods it does not implement at each of them
 * (`refuseUnimplementedMethods`) without listing its URLs by hand. Call it
 * before the group's routes. `onRoute` is encapsulated, so the set holds the
 * group's own routes only.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @returns {Set<string>}   the URL templates, growing as routes are added
 */
function collectRouteUrls(app: FastifyInstance): Set<string> {
  const urls = new Set<string>()
  app.addHook('onRoute', routeOptions => {
    urls.add(routeOptions.url)
  })
  return urls
}

/**
 * Registers a `405 Method Not Allowed` route for every method a URL in the
 * group does not implement (spec "Methods at Reserved Endpoints"), with an
 * `Allow` header naming the methods it does. Without these, a method the
 * endpoint lacks falls through to the parametric route one level up -- a
 * Collection or Resource operation on the reserved segment as an id -- and is
 * refused as a `409 reserved-id`, which answers a question the request never
 * asked. The refusal is registered before any storage access and does not
 * look at the path's ids, so it answers the same whether or not the Space,
 * Collection, or Resource exists. It also answers ahead of the auth hooks
 * (see `methodNotAllowed`), so an anonymous caller gets the 405, not a 401.
 *
 * The URLs are the ones the group registered (`collectRouteUrls`), and the
 * implemented set at each is read from the router itself (`hasRoute`), so
 * neither can drift from the routes. That makes the call order matter: call
 * it at the end of the route group, after its real routes. `HEAD` is never
 * registered here: Fastify exposes it beside every `GET`, so it is
 * implemented wherever `GET` is and refused wherever a `GET` refusal is
 * registered.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @param urls {Iterable<string>}   the group's route URL templates
 * @param [options] {object}
 * @param [options.anchors] {string[]}   URL templates no route serves that
 *   still answer 405, with an empty `Allow`, rather than fall through
 * @param [options.hints] {object}   per URL, per method, one sentence naming
 *   where the refused operation lives instead
 * @returns {void}
 */
function refuseUnimplementedMethods(
  app: FastifyInstance,
  urls: Iterable<string>,
  {
    anchors = [],
    hints = {}
  }: {
    anchors?: string[]
    hints?: Record<string, Partial<Record<string, string>>>
  } = {}
): void {
  const candidates = routedMethods(app)
  // Snapshot first: the refusals registered below are routes too.
  for (const url of [...urls, ...anchors]) {
    const allow = candidates
      .filter(method => app.hasRoute({ url, method }))
      .sort((a, b) => ALLOW_ORDER.indexOf(a) - ALLOW_ORDER.indexOf(b))
    for (const method of candidates) {
      if (method === 'HEAD' || allow.includes(method)) {
        continue
      }
      app.route({
        method,
        url,
        ...methodNotAllowed(allow, hints[url]?.[method])
      })
    }
  }
}

/**
 * The handler of a not-found anchor (`notFoundAt`). `reply.callNotFound()`
 * hands the request to the not-found handler an unmatched URL reaches, so
 * the two answer alike. The reply is awaited, not just acted on:
 * `callNotFound` sends asynchronously, and a hook that resolves before the
 * reply is sent lets Fastify go on to parse the body and run the handler. A
 * reply is a thenable that settles once it is sent, so awaiting it holds the
 * hook until the 404 is out.
 * @param _request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
async function notFound(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  reply.callNotFound()
  await reply
}

/**
 * Registers the app's not-found answer at a URL for every routed method
 * (`routedMethods`). The route is marked `config.noAuth` and answers from a
 * route-level `onRequest` hook, as a 405 refusal does (`methodNotAllowed`),
 * so it reads no ids, parses no body, and answers the same whoever asks and
 * whether or not the Space exists. The `handler` is required by Fastify and
 * never reached.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @param url {string}   the route URL template
 * @returns {void}
 */
function notFoundAt(app: FastifyInstance, url: string): void {
  app.route({
    method: routedMethods(app),
    url,
    ...noAuthRoute,
    onRequest: notFound,
    handler: notFound
  })
}

/**
 * Answers every path beneath a reserved segment that no route serves as not
 * found (`notFoundAt`), instead of letting it reach the parametric route one
 * level up. A path such as `/space/S/policy/x`, `/space/S/meta/x` or
 * `/space/S/C/policy/meta` would otherwise match the Collection or Resource
 * route with the reserved segment as an id, whose reserved-id guard answers a
 * `409 reserved-id`, an answer about ids to a request for a URL that does not
 * exist. The segments are the reserved ids of the position below `base`
 * (`lib/validateId.ts`), so a segment added to the registry is covered
 * without an edit here. Each gets a wildcard route, `<base>/<id>/*`. Static
 * and parametric routes beat a wildcard, so the endpoints a group registers
 * beneath the same segment (`backends/:backendId`, `meta/log`,
 * `zcaps/revocations/:revocationId`) keep answering, their 405 refusals
 * included. The wildcard also matches the segment's own slash form,
 * `<base>/<id>/`, so that form is not read as a Collection container. A
 * wildcard does not match the bare segment, so a segment that no route serves
 * at all (`zcaps`, whose only route lies two levels down) is anchored there
 * too, or it would be read as a Collection's bare form and redirected to a
 * listing of it. Call it after the group's refusals, so a 405 counts as a
 * route at the bare form.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @param base {string}   the URL template of the position above the segment
 * @param ids {Iterable<string>}   the reserved ids of the position below it
 * @returns {void}
 */
function refusePathsBeneath(
  app: FastifyInstance,
  base: string,
  ids: Iterable<string>
): void {
  for (const id of ids) {
    const url = `${base}/${id}`
    if (!routedMethods(app).some(method => app.hasRoute({ url, method }))) {
      notFoundAt(app, url)
    }
    notFoundAt(app, `${url}/*`)
  }
}

/**
 * The methods the bare (no-slash) form of a container URL redirects for: the
 * container's own plus `PUT`, so a `PUT` at the bare form reaches the 405
 * rather than a 404. OPTIONS is left to the CORS plugin's preflight route.
 */
const CONTAINER_REDIRECT_METHODS: HTTPMethods[] = [...CONTAINER_METHODS, 'PUT']

/**
 * The methods the trailing-slash form of a Resource or chunk URL redirects
 * for, to the no-slash canonical form: the methods the canonical form
 * implements. `POST` is left out, since neither URL implements it, so the
 * slash form refuses it with the same `Allow` the canonical form sends rather
 * than advertising it in a redirect's `Allow`. OPTIONS is left to the CORS
 * plugin's preflight route.
 */
const STRIP_SLASH_METHODS: HTTPMethods[] = ['GET', 'HEAD', 'PUT', 'DELETE']

/**
 * Registers the access-control policy routes at one level's `policy` URL
 * (Space, Collection or Resource): Get, Put and Delete Policy. A policy is not
 * public data, so its GET is privileged: the handler verifies a capability
 * and consults no policy, so an anonymous read is the masked `not-found`.
 * @param app {import('fastify').FastifyInstance}   the owning route group
 * @param url {string}   the `policy` URL template
 * @returns {void}
 */
function registerPolicyRoutes(app: FastifyInstance, url: string): void {
  app.get<{
    Params: PolicyParams
    Querystring: { include?: string | string[] }
  }>(url, PolicyRequest.get)
  app.put(url, PolicyRequest.put)
  app.delete(url, PolicyRequest.delete)
}

/**
 * Registers SpacesRepository routes (POST/GET /spaces/, the bare `/spaces`
 * redirect, and the 405 refusals of every other method). Installs the
 * `requireAuthHeadersOrPublicRead` then `parseAuthHeaders` onRequest hooks and
 * the `handleError` error handler. It is the one PWS group that answers an
 * unsafe method with no auth headers `missing-authorization` (401).
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpacesRepositoryRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  // `/spaces` (no trailing slash) is gated too, so a deployment with a
  // provisioning policy refuses a tokenless Create Space there as it does at
  // the canonical form, rather than redirecting it first.
  installGroupHooks(app, {
    provisioningRoutes: [
      { method: 'POST', url: '/spaces' },
      { method: 'POST', url: '/spaces/' }
    ],
    authHeaders: 'unsafe-methods'
  })
  const urls = collectRouteUrls(app)

  // The repository container: canonically `/spaces/`; the bare form redirects
  // there for every PWS method (see the Space container's note on OPTIONS).
  app.route({
    method: CONTAINER_REDIRECT_METHODS,
    url: '/spaces',
    ...noAuthRoute,
    handler: redirectAddSlash
  })
  // Add a Space to a SpacesRepository (Create Space)
  app.post('/spaces/', SpacesRepositoryRequest.post)

  // List Spaces
  app.get('/spaces/', SpacesRepositoryRequest.get)

  // Every other method is refused with a 405. Last in the group, so the
  // implemented set above is complete when it is read.
  refuseUnimplementedMethods(app, urls)
}

/**
 * Registers Space routes: the Space container (list/add Collections, delete
 * the Space), its Metadata object at `meta`, the retired `collections`
 * redirect, and the policy / linkset / backends / quotas / revocation /
 * export / import sub-resources. Installs the auth hooks and the
 * `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initSpaceRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  // Create Space by Id (`PUT` of the Metadata object of a Space that does not
  // exist yet) provisions a Space as `POST /spaces/` does, so it goes through
  // the same gate. An update of an existing Space is not gated.
  installGroupHooks(app, {
    provisioningRoutes: [
      { method: 'PUT', url: '/space/:spaceId/meta', provisions: spaceIsAbsent }
    ]
  })
  const urls = collectRouteUrls(app)

  // The Space container: canonically `/space/:spaceId/`; the bare form
  // redirects there for every PWS method (a 308 replays the method and body).
  // Listed explicitly rather than `app.all`, which would also claim OPTIONS
  // and shadow the CORS plugin's preflight route with a redirect a browser
  // will not follow.
  app.route({
    method: CONTAINER_REDIRECT_METHODS,
    url: '/space/:spaceId',
    ...noAuthRoute,
    handler: redirectAddSlash
  })
  // List Collections (a `GET` of the container lists its members)
  app.get('/space/:spaceId/', SpaceRequest.listCollections)
  // Add Collection to a Space
  app.post('/space/:spaceId/', SpaceRequest.post)
  // Delete Space
  app.delete('/space/:spaceId/', SpaceRequest.delete)
  // `PUT` is not defined at the container: the Space is written at `meta`.

  // The Space Metadata object (reserved `meta` segment; static-beats-parametric
  // routing keeps it ahead of the `:collectionId` parameter in the Collection
  // routes, and `meta` is a reserved Collection id -- see `lib/validateId.ts`).
  // Read Space, and Update (or Create by Id) Space.
  app.get('/space/:spaceId/meta', SpaceRequest.getMeta)
  app.put('/space/:spaceId/meta', SpaceRequest.putMeta)

  // The retired `collections` endpoint (reserved segment): listing and
  // creating Collections moved to the Space URL in v0.5, so both slash forms
  // redirect there for the two methods it served.
  for (const url of [
    '/space/:spaceId/collections',
    '/space/:spaceId/collections/'
  ]) {
    app.route({
      method: ['GET', 'POST'],
      url,
      ...noAuthRoute,
      handler: redirectCollectionsToSpace
    })
  }

  // Space access-control policy (reserved segment; Fastify routes static
  // segments ahead of the `:collectionId` parameter, so this never collides).
  // Its GET is privileged, as are the Collection- and Resource-level policy
  // GETs below (`registerPolicyRoutes`).
  registerPolicyRoutes(app, '/space/:spaceId/policy')

  // Space linkset (RFC9264 policy discovery)
  app.get('/space/:spaceId/linkset', SpaceRequest.linkset)

  // Space Backends Available (reserved segment; static-beats-parametric routing
  // keeps this ahead of the `:collectionId` parameter in the Collection routes).
  app.get('/space/:spaceId/backends', SpaceRequest.listBackends)

  // Register / replace / deregister an `external` backend record. Static
  // `backends` beats the parametric `:collectionId` / `:resourceId` of the
  // Collection/Resource route groups, so these resolve correctly (the same
  // mechanism that keeps the GET above and the singular `/backend` working).
  app.post('/space/:spaceId/backends', BackendRequest.post)
  app.put('/space/:spaceId/backends/:backendId', BackendRequest.put)
  app.delete('/space/:spaceId/backends/:backendId', BackendRequest.delete)

  // Replica registrations (reserved segment). Every method admits the Space
  // controller's root invocation and a delegated invocation whose invoked
  // capability targets the replicas URL or a URL beneath it, the
  // `replicas-subtree` container rule (`requests/ReplicaRequest.ts`), which
  // keeps a data grant on the Space URL out. Each `GET` verifies a capability
  // and consults no policy, so an anonymous read is the masked `not-found`.
  app.get<{ Params: { spaceId: string } }>(
    '/space/:spaceId/replicas',
    ReplicaRequest.list
  )
  app.post('/space/:spaceId/replicas', ReplicaRequest.post)
  app.get<{ Params: { spaceId: string; replicaId: string } }>(
    '/space/:spaceId/replicas/:replicaId',
    ReplicaRequest.get
  )
  app.put('/space/:spaceId/replicas/:replicaId', ReplicaRequest.put)
  app.delete('/space/:spaceId/replicas/:replicaId', ReplicaRequest.delete)
  app.get<{ Params: { spaceId: string; replicaId: string } }>(
    '/space/:spaceId/replicas/:replicaId/status',
    ReplicaRequest.status
  )

  // Space Quota report (reserved segment; static-beats-parametric routing keeps
  // this ahead of the `:collectionId` parameter). The per-Collection breakdown
  // (spec's `?include=collections`) is opt-in via that query string -- see the
  // handler note on the ZCap query-string limitation.
  app.get('/space/:spaceId/quotas', SpaceRequest.quotas)

  // Revoke a zcap delegated from this Space (`:revocationId` = the URL-encoded
  // id of the capability being revoked, which is also the request body).
  // `POST`-only. `zcaps` is a reserved Collection id, so no Collection is
  // created under it; see `spaceRevocationsPath` for the other methods.
  app.post(
    '/space/:spaceId/zcaps/revocations/:revocationId',
    RevocationRequest.postSpace
  )

  // POST /space/12345/export
  app.post('/space/:spaceId/export', safeRoute, SpaceRequest.export)

  // POST /space/12345/import
  app.addContentTypeParser('application/x-tar', (_req, body, done) => {
    done(null, body)
  })
  app.post('/space/:spaceId/import', SpaceRequest.import)

  // Every Space-level URL refuses the methods it does not implement with a
  // 405, rather than letting them fall through to a Collection operation on
  // the reserved segment. Last in the group, so the implemented set above is
  // complete when it is read. The canonical container's `PUT` refusal comes
  // from here too, with a hint; the bare form's `Allow` names the methods it
  // redirects for.
  refuseUnimplementedMethods(app, urls, {
    anchors: [
      // The Collection-level `meta/log` shape, which a Space does not serve,
      // answers 405 rather than the not-found of the `meta/*` wildcard below.
      '/space/:spaceId/meta/log',
      // The cross-collection query the spec reserves and this server does not
      // serve.
      '/space/:spaceId/query'
    ],
    hints: {
      '/space/:spaceId/': { PUT: CONTAINER_PUT_HINT },
      '/space/:spaceId/meta': { DELETE: CONTAINER_META_DELETE_HINT }
    }
  })
  // Every other path beneath a Space-level reserved segment is not found, and
  // so is the bare `zcaps` segment, which no route serves.
  refusePathsBeneath(app, '/space/:spaceId', RESERVED_COLLECTION_IDS)
}

/**
 * Registers Collection routes: the Collection container (list/add Resources,
 * delete the Collection), its Metadata object at `meta` with the governing
 * history log beneath it, and the policy / linkset / backend / quota / query
 * sub-resources. Installs the auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initCollectionRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app)
  const urls = collectRouteUrls(app)

  // The Collection container: canonically `/space/:spaceId/:collectionId/`;
  // the bare form redirects there for every PWS method (see the Space
  // container's note on OPTIONS).
  app.route({
    method: CONTAINER_REDIRECT_METHODS,
    url: '/space/:spaceId/:collectionId',
    ...noAuthRoute,
    handler: redirectAddSlash
  })
  // List Collection items (a `GET` of the container lists its members)
  app.get('/space/:spaceId/:collectionId/', CollectionRequest.list)
  // Add Resource to a Collection
  app.post('/space/:spaceId/:collectionId/', CollectionRequest.post)
  // Delete Collection
  app.delete('/space/:spaceId/:collectionId/', CollectionRequest.delete)
  // `PUT` is not defined at the container: the Collection is written at
  // `meta`.

  // Collection access-control policy (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter).
  registerPolicyRoutes(app, '/space/:spaceId/:collectionId/policy')

  // Collection linkset (RFC9264 policy discovery)
  app.get('/space/:spaceId/:collectionId/linkset', CollectionRequest.linkset)

  // The Collection Metadata object (reserved `meta` segment): the merged
  // description-plus-annotations object. Like the Space-level `meta`, this one
  // sits at the next level's id position (`:resourceId`), so `meta` is a
  // reserved Resource id; static-beats-parametric routing keeps it ahead of
  // the `:resourceId` parameter in Resource routes.
  // Read Collection Metadata, and Update (or Create by Id) Collection: a full
  // replacement that creates the Collection when absent.
  app.get('/space/:spaceId/:collectionId/meta', CollectionRequest.getMeta)
  app.put('/space/:spaceId/:collectionId/meta', CollectionRequest.putMeta)
  // The Collection's governing history log (the `governed-history-logs`
  // feature), a sub-resource beside `/meta`: not a Resource of the Collection,
  // so it needs no reserved id, but it sits at the Resource `/meta` depth and
  // must be registered here, ahead of the `:resourceId/meta` Resource route.
  app.get('/space/:spaceId/:collectionId/meta/log', CollectionRequest.getLog)
  app.put('/space/:spaceId/:collectionId/meta/log', CollectionRequest.putLog)

  // Collection Backend Selected (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter in Resource routes).
  app.get('/space/:spaceId/:collectionId/backend', CollectionRequest.getBackend)

  // Per-Collection Quota report (reserved segment; static-beats-parametric
  // routing keeps this ahead of the `:resourceId` parameter in Resource routes).
  app.get('/space/:spaceId/:collectionId/quota', CollectionRequest.getQuota)

  // Collection query (reserved segment; spec "Collection-level reserved
  // endpoints"). The PWS server serves the replication change feed as the
  // `changes` profile; params ride the signed
  // POST body. Static-beats-parametric routing keeps this ahead of the
  // `:resourceId` parameter in Resource routes.
  app.post(
    '/space/:spaceId/:collectionId/query',
    safeRoute,
    CollectionRequest.query
  )
  // The read-only form of the `changes` profile, with its parameters in the
  // query string, so a `GET`-only capability can read the feed.
  app.get(
    '/space/:spaceId/:collectionId/query',
    CollectionRequest.queryChangesByGet
  )

  // Every Collection-level URL refuses the methods it does not implement
  // with a 405 (see the Space group's note).
  refuseUnimplementedMethods(app, urls, {
    hints: {
      '/space/:spaceId/:collectionId/': { PUT: CONTAINER_PUT_HINT },
      '/space/:spaceId/:collectionId/meta': {
        DELETE: CONTAINER_META_DELETE_HINT
      }
    }
  })
  // Every other path beneath a Collection-level reserved segment is not found.
  refusePathsBeneath(
    app,
    '/space/:spaceId/:collectionId',
    RESERVED_RESOURCE_IDS
  )
}

/**
 * Registers Resource routes (create-by-id, get, delete a Resource). Installs the
 * auth hooks and the `handleError` error handler.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initResourceRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app)
  const urls = collectRouteUrls(app)

  // A Resource URL carries no trailing slash; the slash form redirects to it
  // for every PWS method (see the Space container's note on OPTIONS).
  app.route({
    method: STRIP_SLASH_METHODS,
    url: '/space/:spaceId/:collectionId/:resourceId/',
    ...noAuthRoute,
    handler: redirectStripSlash
  })

  // Create a Resource by Id
  app.put('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.put)

  // Head Resource. Declared before the GET route so it overrides Fastify's
  // auto-exposed HEAD (which would share the GET handler and stream the body
  // without a Content-Length); this handler reads only the Metadata and sets
  // Content-Type/Content-Length from it (spec "Content Types and Representations").
  app.head('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.head)

  // Get Resource
  app.get('/space/:spaceId/:collectionId/:resourceId', ResourceRequest.get)

  // Delete Resource
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId',
    ResourceRequest.delete
  )

  // Resource access-control policy (reserved segment)
  registerPolicyRoutes(app, '/space/:spaceId/:collectionId/:resourceId/policy')

  // Resource metadata (reserved segment; spec "Resource Metadata Data Model")
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/meta',
    ResourceRequest.getMeta
  )
  // Update Resource Metadata (full replacement of the user-writable `custom`).
  app.put(
    '/space/:spaceId/:collectionId/:resourceId/meta',
    ResourceRequest.putMeta
  )

  // Chunked Resource chunks (the `chunked-streams` feature). The member form
  // (`chunks/:chunkIndex`) addresses one stored chunk; the container form
  // (`chunks/`) is the discovery/reassembly listing. The `chunks` segment sits
  // below the Resource level, so it needs no reserved-id entry (`meta` does,
  // because it is also addressed one level up, on a Collection and a Space).

  // Store a chunk by index. A chunk is a range of a stream, not a document,
  // so its bytes are stored as received whatever media type they declare.
  // This encapsulated scope drops the JSON and text parsers, so every
  // non-multipart body reaches the handler as a raw stream through the
  // catch-all. The slash-form redirect sits in the same scope so no parser
  // can refuse the body ahead of it. The registration is awaited so the
  // routes are in the router when the group's 405 refusals are derived below.
  await app.register(async chunkWrites => {
    chunkWrites.removeContentTypeParser([
      'application/json',
      'text/plain',
      JSON_MEDIA_TYPE
    ])
    // A chunk URL carries no trailing slash either; the slash form redirects
    // to it for every PWS method.
    chunkWrites.route({
      method: STRIP_SLASH_METHODS,
      url: '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex/',
      ...noAuthRoute,
      handler: redirectStripSlash
    })
    chunkWrites.put(
      '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
      ChunkRequest.put
    )
  })

  // Head Chunk. Declared before the GET route for the same reason as Head
  // Resource: serve Content-Type/Content-Length from stored metadata without
  // opening the byte stream.
  app.head(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.head
  )

  // Get a chunk's bytes
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.get
  )

  // Delete a chunk
  app.delete(
    '/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex',
    ChunkRequest.delete
  )

  // List a Resource's chunks (container form; trailing slash is canonical)
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/chunks', // trailing slash required
    noAuthRoute,
    redirectAddSlash
  )
  app.get(
    '/space/:spaceId/:collectionId/:resourceId/chunks/',
    ChunkRequest.list
  )

  // Every Resource-level URL refuses the methods it does not implement with
  // a 405 (see the Space group's note).
  refuseUnimplementedMethods(app, urls)
}

/**
 * Registers the WebKMS keystore and key routes (the `/kms` facet).
 * Installs the same hook chain as the PWS groups
 * except that the auth requirement is the strict `requireAuthHeaders`: every
 * webkms route, GETs included, is zcap-invoked -- the protocol has no public
 * reads. No slash-redirect variants either; the protocol's URLs are exact --
 * only these shapes are registered.
 * @param app {import('fastify').FastifyInstance}
 * @param options {object}   Fastify plugin options
 * @returns {Promise<void>}
 */
export async function initKmsRoutes(
  app: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  installGroupHooks(app, {
    provisioningRoutes: [{ method: 'POST', url: '/kms/keystores' }],
    authHeaders: 'every-method'
  })
  const urls = collectRouteUrls(app)

  // Create Keystore
  app.post('/kms/keystores', KeystoreRequest.post)

  // List Keystores by controller (`?controller=<did>`)
  app.get('/kms/keystores', KeystoreRequest.list)

  // Get Keystore config
  app.get('/kms/keystores/:keystoreId', KeystoreRequest.get)

  // Update Keystore config
  app.post('/kms/keystores/:keystoreId', KeystoreRequest.update)

  // Generate Key (GenerateKeyOperation)
  app.post('/kms/keystores/:keystoreId/keys', KeyRequest.generate)

  // List Keys (fork extension: enumerate the keystore's public key
  // descriptions). Static `/keys` beats the parametric `/keys/:keyId` below,
  // so this never collides with the key-description GET.
  app.get('/kms/keystores/:keystoreId/keys', KeyRequest.list)

  // Key operation dispatch by envelope type (Sign / Verify / DeriveSecret /
  // WrapKey / UnwrapKey)
  app.post('/kms/keystores/:keystoreId/keys/:keyId', KeyRequest.operation)

  // Public key description
  app.get('/kms/keystores/:keystoreId/keys/:keyId', KeyRequest.get)

  // Revoke a delegated zcap (`:revocationId` = the URL-encoded id of the
  // capability being revoked, which is also the request body)
  app.post(
    '/kms/keystores/:keystoreId/zcaps/revocations/:revocationId',
    RevocationRequest.post
  )

  // Every keystore URL refuses the methods it does not implement with a 405
  // (see the Space group's note). The webkms protocol has no public reads,
  // but a refusal is not a read: it answers before the strict auth hook, so
  // an anonymous caller learns the `Allow` set and nothing else.
  refuseUnimplementedMethods(app, urls)
}
