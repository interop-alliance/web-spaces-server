# The Request Pipeline: Routes, Hooks, Caches and Denials

This document covers what a request passes through before a handler stores
anything: the route groups and their hook chain, the 405 refusals and redirects
derived from the router, request body integrity and the body limit, the
hosted-page sandbox, the two authorization read caches, and the shape of a
denial. [ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the
glossary.

## The hook chain

`src/routes.ts` has four `init*Routes(app)` functions that map URL patterns to
handler methods. Every group installs the same hook chain first: the
`parseAuthHeaders` `onRequest` hook, then the `captureRawBody` (preParsing) and
`verifyBodyDigest` (preValidation) digest hooks. The digest hooks are described
in [Request body integrity](#request-body-integrity).

Two groups install an auth-header requirement ahead of `parseAuthHeaders`. The
`/spaces/` repository group installs `requireAuthHeadersOrPublicRead`, so a
Create Space with no auth headers is `missing-authorization` (401), and an
anonymous List Spaces proceeds to its empty-items 200. The `/kms` group installs
`requireAuthHeaders`, so a request there with no auth headers is a 401. A method
refusal (405) skips the hook in every group. The three groups beneath `/space/`
install neither. See
[A request with no authorization headers](#a-request-with-no-authorization-headers).

`src/zcap.ts` holds `handleZcapVerify()`, which performs the
capability-invocation signature verification against the Space controller's key.
For the root and delegated invocation forms, see the ZCap Structure section of
[ARCHITECTURE.md](../ARCHITECTURE.md). For what happens to the dereferenced
chain after the signature verifies, see
[client-annex-clause.md](client-annex-clause.md).

## Container URLs and their sub-resources

A container -- a Space or a Collection -- is canonically addressed with a
trailing slash. `GET` lists its members, `POST` adds one, `DELETE` removes the
container, and `PUT` is not defined there. What a container _is_ lives at its
`meta` sub-resource instead:

- `GET`/`PUT /space/:spaceId/meta` is the Space Metadata object.
- `GET`/`PUT /space/:spaceId/:collectionId/meta` is the Collection Metadata
  object.

A `PUT` of a container URL answers 405, with an `Allow` header naming the
methods the container accepts. The spec assigns this refusal no problem `type`,
so it is RFC 9457's `about:blank`. Its `title` is the status phrase
`Method Not Allowed`, as RFC 9457 asks of an `about:blank` problem.

## Method refusals (405)

Every URL a group registers, the `/kms` group's included, answers the same 405
for each method it does not implement. Examples are a `DELETE` of either
Metadata URL, a `GET` of `export`, a `PATCH` of a Space, a Collection or a
Resource at either slash form, and a `DELETE` of a keystore.

Each group records its route URLs with an `onRoute` hook (`collectRouteUrls`)
and ends with `refuseUnimplementedMethods`. That call reads the implemented set
at each URL from the router (`hasRoute`) and registers a refusal for every other
method Fastify routes. Neither the URLs nor the `Allow` header can drift from
the routes. The only hand-written input is the `PUT`/`DELETE` hints and the two
anchors a Space does not serve. Those are the cross-collection
`/space/:spaceId/query` and the Collection-level shape
`/space/:spaceId/meta/log`, which answer 405 with an empty `Allow`.

The call must stay last in its group. `OPTIONS` is left to the CORS preflight,
and `HEAD` follows `GET`. A bare container form's `Allow` names the methods it
redirects for. The refusal reads no ids, so it answers the same whether or not
the Space, Collection, or Resource exists.

## Reserved paths

A path beneath a Space-level or Collection-level reserved segment that no route
serves is not found (404), as an unmatched URL is.

`refusePathsBeneath` registers a wildcard route, `<segment>/*`, for each id in
the reserved-id registry (`lib/validateId.ts`). It anchors the bare segment too
when no route serves it (`zcaps`), so it is not read as a Collection's bare
form. The route is marked `noAuth` and answers from a route-level `onRequest`
hook through `reply.callNotFound()`, so it reads no ids and parses no body.

Static and parametric routes beat a wildcard. The endpoints beneath a segment
(`backends/:backendId`, `meta/log`, `zcaps/revocations/:revocationId`) keep
answering, their 405 refusals included.

## Refusals and redirects skip authentication

A refusal and a slash redirect answer the same whatever the caller's identity.
Both carry the `noAuth` route config, and the group's auth-header,
`parseAuthHeaders` and digest hooks skip them. An anonymous `PUT` of a container
URL is therefore a 405, whether or not the container exists. A refusal is thrown
from a route-level `onRequest` hook, ahead of body parsing. The provisioning
gate, the error handler, the `no-store` marking and the
[hosted-page sandbox](#the-hosted-page-sandbox) still run on them. The
`no-store` marking is described in
[validators-and-stamps.md](validators-and-stamps.md).

## Slash redirects

The no-slash form of a container URL redirects to the slash form with a 308 for
every container method. The redirect is spec-defined; see the Trailing slashes
note in the glossary of [ARCHITECTURE.md](../ARCHITECTURE.md). A signed request
must be re-signed for the redirect target rather than replay its `Authorization`
header.

The slash form of a Resource or chunk URL redirects to the no-slash form the
same way, for every method the canonical form implements. It refuses `POST` with
the canonical form's `Allow`.

`/space/:spaceId/collections/` answers a 308 to the Space URL, which lists and
creates Collections. `collections` and `meta` are reserved Collection ids, and
so is `.revocations`, the system Collection the filesystem backend keeps a
Space's revocation records in; it is not a route, so every path at or beneath it
is not found.

## Request body integrity

`src/digest.ts` implements Request Body Integrity (spec "Request Body
Integrity"). `captureRawBody` (preParsing) tees JSON/text body bytes onto
`request.rawBody`. `verifyBodyDigest` (preValidation) requires the `digest`
header be covered by the signature. It recomputes the digest and compares it
against the body before capability verification. A failure is a 400
`invalid-authorization-header`.

It runs on any request that carries a body: a `Content-Type`, a
`Transfer-Encoding`, or a non-zero `Content-Length`. It refuses a body with no
`Content-Type` as `missing-content-type` (400) first. Without that check, the
catch-all parser would hand such a body to Import Space or the governed-log
`PUT` as a raw stream the signature never covered.

A signed `multipart/form-data` body, which `@fastify/multipart` reads off the
raw request itself, is tapped rather than piped. The hook hashes it as busboy
reads it and leaves the verdict on `request.multipartDigest`. The multipart
write path awaits that verdict before it stores anything. The media type is
matched case-insensitively and ignores parameters. Any other `multipart/*` type
is an opaque representation: it is piped through the digest transform and stored
as a blob like any other media type.

## Media types on a write

`src/requests/resourceInput.ts` turns a write's body into the shape the backend
stores. A JSON media type (`application/json`, or `application/<suffix>+json`
with the suffix ending at the media type) arrives parsed and is stored as a
document. `application/ld+jsonl` and `application/ld+json-seq` are not JSON
documents, so they reach the catch-all parser and are stored as byte streams. A
`multipart/form-data` body is the one file part it carries, stored under that
part's content type, which the create response's `content-type` names. Its
in-memory buffer is bounded by the buffered-body limit of the next section, the
`fileSize` limit `plugin.ts` gives `@fastify/multipart`, and the
`payload-too-large` (413) names that limit, and the server backend when the
limit is its `maxUploadBytes`. The data-plane backend the Collection selected
applies its own cap when it writes the buffered part. Into a Collection that
declares an `encryption` scheme, the conformance check runs on the file part's
content type and bytes, the representation that will be stored, once the part is
read; a raw body is checked on its own content type before it is resolved.

A chunk write (`PUT .../chunks/:chunkIndex`) stores its bytes as received
whatever media type they declare. A chunk is a range of a stream, not a
document, so a slice of a JSON stream need not parse as JSON and must not be
re-serialized. The route sits in its own encapsulated scope that removes the
JSON and text parsers, so every non-multipart body reaches the handler as a raw
stream through the catch-all. The chunk URL's slash-form redirect sits in the
same scope, so no parser refuses a body ahead of the 308. An empty body is
stored as a zero-byte chunk whatever its media type, as it is for
`application/octet-stream`. A body that still arrives parsed, from a chunk write
mounted outside that scope, is refused as `invalid-request-body` (400).

## The body limit

`captureRawBody` also bounds what it buffers, by the route's `bodyLimit`. That
limit comes from `src/lib/bodyLimit.ts`, which derives it from the active
backend's `maxUploadBytes`.

The body is read in the hook (`readBoundedBody`, the one bounded reader
`readTextBody` shares). An over-limit body is therefore refused with
`payload-too-large` (413) at the byte that crosses the limit. This happens
before any signature is verified and whichever parser the media type reaches.
The refusal closes the connection.

## The hosted-page sandbox

`src/lib/hostedPageSandbox.ts` is an `onSend` hook that every route group
installs (`installGroupHooks`). It stamps `Content-Security-Policy: sandbox ...`
on every response in the PWS and `/kms` groups, 304s, redirects and errors
included. A stored HTML page then runs with an opaque origin and cannot read the
storage of the origin serving it. This matters when a wallet serves this server
on its own origin. The hook is group-wide so that a new route serving stored
bytes, such as a default document, cannot be added without it.

It skips a response whose `content-type` is `application/pdf`. Chromium refuses
to render a PDF in a sandboxed document, and a browser's PDF viewer cannot reach
the serving origin's storage anyway.

A sandbox has no effect on a response read with `fetch()`, so the JSON responses
carry it harmlessly. The welcome page, `/common/`, `/service` and the CORS proxy
sit outside the groups and do not carry it. The CORS proxy sends its own
stricter set instead (`default-src 'none'; sandbox`, `nosniff`,
`Content-Disposition: attachment`).

The policy leaves out `allow-same-origin`, which combined with `allow-scripts`
would let a page lift its own sandbox. It also leaves out
`allow-popups-to-escape-sandbox`, so a popup a page opens is sandboxed too. It
is always on, with no setting. These responses send no
`X-Content-Type-Options: nosniff`, so a Resource stored with a generic type is
still sniffed, and runs sandboxed too.

## The read caches

`src/lib/spaceMetadataCache.ts` and `src/lib/policyCache.ts` are the two
short-TTL read caches on the authorization path, one per storage backend. The
first memoizes the Space Metadata object, whose `controller` every capability
check verifies against. The second memoizes the access-control policies the
policy fallback reads. It reads through `getPolicy`, which answers a deleted
policy's tombstone as no policy, so a tombstone is cached as an absence and
grants nothing.

Both expire entries after 10 s (`SPACE_METADATA_CACHE_TTL`, `POLICY_CACHE_TTL`
in `config.default.ts`). A write drops the affected entries, but only in the
process that made the write. The TTLs therefore rest on a single-instance
deployment.

When several instances share one storage backend, a controller retired by an
Update Space on one instance keeps its authority on another for up to one TTL. A
changed or deleted policy likewise keeps granting there for up to one TTL. The
write stamps rest on the same single-instance deployment; see
[validators-and-stamps.md](validators-and-stamps.md).

## Denial reasons

A refusal is a 404 whose `type` is the merged `not-found`, with two exceptions
named by `type` only, the status unchanged. The code is `denialError` in
`zcap.ts`, on the shared `verifiedOrThrow` path every route family uses.

- `capability-revoked` means the revocation inspector failed the chain.
- `capability-expired` means the zcap library raised its named expiry error for
  the invoked capability or one in its chain.

The two are told apart from every other cause by `err.name`, the cross-package
rule, since the verifier hands the cause back as a bare error or wrapped in a
jsigs `VerificationError`.

A cause is named only for a caller signing with the invoked capability's own
controller key. The zcap library performs that controller match itself, but only
after the chain walk, and the walk raises an expired parent link before it gets
there. So `denialError` repeats the match server-side (`invokerIsController`),
reading the signing key id and the embedded capability from the request headers.

The request signature is verified before any of this, and each named cause is
raised only after every delegation proof in the chain verified. A named cause
therefore reaches only the holder of the capability and its invoking key, and
tells it something about its own grant: a revocation it did not see, or an
`expires` it already carries. A copy of a revoked or expired grant invoked with
any other key, a tampered proof, a wrong action, or a chain that never verified
all stay the plain `not-found`. An under-authorized caller still cannot tell an
absent target from one it may not see.

The policy fallback in `authorize.ts` is unchanged. A denial with a named cause
still falls through to the target's access-control policy, and the error
surfaces only when the policy does not grant either.

A DID resolved over the network is the one holder that gets no named cause. Its
key is resolved only after its chain verifies, so a revoked or expired grant
leaves the key unresolved and the answer is the plain `not-found`. See
[webvh-controllers.md](webvh-controllers.md) for foreign invokers.

## The masked not-found

The plain `not-found` body is byte-identical whether the target is absent or the
caller is under-authorized. It has the same `title`, naming no entity noun, and
the same `detail`, `URL not found or invalid authorization.`.

A signing key the server cannot resolve is answered the same way. That covers an
unresolvable self-hosted `did:webvh`, a keyId absent from the resolved document,
and an undecodable `did:key`. The keyId is the client's own choice, and
resolving it is part of authorization, not request parsing.

Revocation submission's body-shape and chain-verification checks, and Create
Space's `id-conflict` existence check, run only after the invocation verifies.
Their 400s cannot be used to probe whether a scope or a Space id exists.

### A request with no authorization headers

A request beneath `/space/:spaceId` that carries no `Authorization` or no
`Capability-Invocation` header reaches its handler. A read may be granted by an
access-control policy. Anything else is refused by the handler's authorization
as the masked `not-found` (404), whether or not the target exists. That covers
every unsafe method, and the reads no policy serves: Get Policy at all three
levels and the replicas reads.

The refusal is raised where every capability verification starts
(`assertInvocationPresent` in `src/zcap.ts`), under the handler's own request
name. The body is therefore the same bytes an under-authorized signed request
gets at that URL. A handler's body-shape checks that run ahead of authorization
answer their 400 first, for an existing and an absent target alike. A handler
that runs target-dependent checks ahead of its verification calls
`assertInvocationPresent` before them. Create Space by Id does so ahead of its
create-only checks, and revocation submission ahead of verifying the submitted
chain.

Two answers stay `missing-authorization` (401). Create Space at the Spaces
Repository keeps it, since the repository's existence is not sensitive. The
`/kms` group keeps it on every method a route implements: it is the WebKMS
protocol, and the 401 is the same for an existing and an absent keystore.
