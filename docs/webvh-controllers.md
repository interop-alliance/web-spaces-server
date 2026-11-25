# did:webvh Controllers and Invokers

This document covers how the server accepts, resolves and verifies a `did:webvh`
as a Space controller, a delegator or the invoker of a capability. That includes
promotion of a Space to a self-hosted DID, the rule that keeps its history log
append-only, the resolver engaged on every verification path, the bounded
network fetch of a foreign DID's log, and DID URL invocation targets.
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the glossary.

## Accepted controller shapes

The controller is the DID that owns a Space. Its Ed25519 key signs capability
invocations and is checked during ZCap verification. Three shapes are accepted:

- A `did:key`. It is the only shape a Space may be created with.
- A self-hosted `did:webvh`, which a Space may be updated to (see
  [Self-hosted DIDs](#self-hosted-dids)).
- A `did:webvh` hosted on a replication peer, which a Space may be updated to on
  a replica that holds a copy of its log. The rule that locates that copy is in
  [replication.md](replication.md).

A controller is distinct from the wallet repos' `clientId`. An enrolled client
appears here as a verification method inside the controller's document, not as
the controller itself.

Any other cross-host `did:webvh`, `did:web`, and every other method are refused
as a controller or a delegator. The network exceptions are described in
[Foreign invokers resolved over the network](#foreign-invokers-resolved-over-the-network)
and [DID URL invocation targets](#did-url-invocation-targets).

## Self-hosted DIDs

The second accepted controller shape lets a wallet carry one stable user
identity whose DID document lists a verification method per enrolled client. The
DID must be anchored on this server:

```
did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>
```

Its history log is the `did.jsonl` Resource in that Collection of that Space.
Any Collection may host one, as long as its name round-trips the DID path
encoding. PWS Collection ids are restricted to the RFC 3986 unreserved charset,
which needs no percent-encoding, so the rule is just that check. A final DID
segment carrying `%` or another reserved character is refused by the parser.

A `did:webvh` on a replication peer's host,
`did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`, resolves the same way
from the local copy of its log, when exactly one replica registration maps it
there (see [replication.md](replication.md)). It may be a Space controller, a
keystore controller, a delegator, and a `createdBy`.

### Promotion

A Space is promoted to a self-hosted `did:webvh` by a `PUT` of its Space
Metadata object (at `meta`) with the new `controller`, still authorized by the
stored `did:key`. Creation stays `did:key`-only. The proposed controller must
resolve before it is stored, or the Space would be deadlocked.

## Resolution and verification

Resolution of a self-hosted DID is a local storage read, with no network fetch.
The log's Space need not be the Space an invocation targets. The DID string
carries the log's own `spaceId`, so a cross-Space controller resolves through
the same path as any other.

A capability-gated Collection works too. The server reads its own storage
regardless of read policy, so such a DID resolves for authorization while its
log stays unreadable without a capability.

The log is verified, not trusted. Verification is SCID pinning plus the full
hash-chain and update-key check, done by `@interop/did-method-webvh`. It matters
because after promotion the writes to that log are authorized by the very
document being resolved.

The server verifies a log against no witness proofs, on every path. A log that
declares witnesses does not verify here, self-hosted or not, and nothing fetches
`did-witness.json`.

## The current-key-set rule

Key validity is the current-key-set rule (profile
["Current-key-set rule"](https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/#current-key-set-rule)).
An invocation or delegation verifies if and only if its verification method is
in the currently resolved document, under the right verification relationship.

One piece of code carries that rule on both sides. `webvhVerifier` finds the
invocation key by membership in the flat `verificationMethod` array. It restates
`controller: <did>` on the method it reconstructs. That string sends jsigs'
`ControllerProofPurpose` to dereference the controller document through the
local webvh resolver driver (`webvhDidResolverDriver` / `dereferenceFragment`)
and read `capabilityInvocation` out of it. A root invocation and a delegation
proof are therefore relation-scoped identically, and a delegation-only method
cannot root-invoke.

Before promotion the Space controller is a `did:key`. It takes the `did:key`
branch of `createGetVerifier`, where no relation applies.

## The document cache

Resolved documents are cached, keyed by the log's location (Space plus
Collection). A write that could change a log at that location drops the entry.
Entries exist only for DIDs actually resolved for authorization. A `did.jsonl`
written into a Collection no reference names drops nothing and costs no
re-verification.

## Path-hosting is not endorsement

Anyone with a write grant on a user's Space can put a resolvable log under that
Space's path. That proves only that something wrote it there. A DID is
self-certified by its own SCID and log. It acquires authority only by being
referenced, as a Space's stored controller or by a capability delegated to it.
Where its log happens to live confers none.

## The log only grows

The log only grows at this server (`src/lib/webvhLogWrite.ts`).

- A `did.jsonl` in any Collection is written only by a fast-forward `PUT`. The
  stored bytes must be a prefix of the body, else 412. The write is pinned to
  the `ETag` of the log it checked.
- A `DELETE` of one is refused with 405 (`Allow: GET, HEAD, PUT`), before
  authorization.
- Every prefix of a valid log is a valid log with the same SCID. Without the
  rule, a subtree grant could restore a key a later entry retired, or leave the
  controller unresolvable.
- The resolver also records the head it last verified per DID (entry count and
  head `versionId`) and refuses a log that does not extend it. The record is in
  memory and survives cache invalidation. It is dropped only when the log's
  Collection or Space is deleted, so a restore that re-creates the Space can
  land an older log.
- A log goes away only with its Collection or Space. Deleting the Collection
  that holds a controller's log leaves every Space that DID controls with no
  resolvable controller, and there is no break-glass.
- An append must also verify. The whole body is verified as the history log of
  the DID the stored log's head names. A junk or tampered entry is refused as
  `invalid-request-body` (400) before it is stored.
- A stored `did.jsonl` that names no DID cannot be appended to. A create is not
  verified.

## The resolver on every path

Each verification engages the local `did:webvh` resolver, whatever the scope's
own controller is. That covers route invocations, both halves of a revocation
submission (the submitted chain and the submission's own invocation), create
consent, and List Spaces.

A delegated link may be signed by a self-hosted `did:webvh` method on a
`did:key` Space, the unlock-Space shape. Narrowing the resolver to the scope's
controller would leave such a grant live on every route yet unrevocable.

The resolver widens resolution only. It refuses any DID this server holds no log
for, and the chain still roots in the scope's root capability. A submitted chain
may root in the scope's root capability or in the root of any URL under it, the
same roots an invocation accepts. A grant delegated from a Collection's or a
Resource's own root is therefore revocable too.

List Spaces verifies against one candidate controller at most. That is the
signer of a root invocation, or the signer of a delegated chain's base
delegation, read off the header before any signature work. A listing grant roots
in the `/spaces/` root capability, which no revocation route accepts. It carries
no revocation scope, and its `expires` bounds it.

For the root and delegated invocation forms, see ARCHITECTURE.md's ZCap
Structure section. For the chain inspectors that run after verification, see
[client-annex-clause.md](client-annex-clause.md).

## Foreign invokers resolved over the network

Two bounded cases reach the network. The first is the invoker of a delegated
capability, described here. The second is a DID named by a DID URL target (see
[DID URL invocation targets](#did-url-invocation-targets)). Any `did:webvh` on
another host whose log this server does not store may invoke a delegated
capability on the PWS routes. That covers a peer server's DID,
`did:webvh:<scid>:<host>:space:server:id`, and a service's or an agent's DID,
under any path or none. It applies in `authorize()` and `fetchSpaceAndVerify()`.

The HTTP-signature verifier resolves the signing key before it reads the
capability, so a fetch made there would answer any host a request names.
`handleZcapVerify` therefore runs a pre-pass first (`peerInvokerGrant`). It
verifies the embedded delegation chain to the Space controller with local-only
resolution, through the same roots and chain inspectors the invocation applies.
It also requires the invoked capability's sole `controller` to equal the DID. It
gives no grant to a DID that is on the operator's blocklist, nor to one whose
log this server stores, since that DID resolves from storage (see
[replication.md](replication.md)). Only then does the verification that follows
fetch that one DID's log.

A foreign DID with no stored log may invoke. It may not delegate or be a
controller, since every link of the chain must be signed by a key this server
resolves without a fetch. A root invocation by a foreign DID never fetches.
`/kms`, revocation submission, create consent and List Spaces stay local-only.
Every refusal is the plain masked `not-found`.

### The peer log resolver

`src/lib/peerWebvh.ts` is the one network resolution of a foreign `did:webvh`:
any DID on another host whose log this server does not store, with any path or
none. It covers a peer server's own DID,
`did:webvh:<scid>:<host>:space:server:id`, and a service's or an agent's DID. It
resolves one only as the invoker of a delegated capability on the PWS routes, or
as the DID a DID URL target names.

- The log is fetched from the URL the did:webvh method maps the DID to
  (`https://<host>/<path>/did.jsonl`, or `https://<host>/.well-known/did.jsonl`
  for a host-only DID), by `getFileUrl` of `@interop/did-method-webvh`.
- A DID whose host carries a port, or is an IP address, is refused.
- The log is verified like any log (see
  [Resolution and verification](#resolution-and-verification)).
- The log must extend the last head verified for the DID, so a host cannot serve
  an older prefix to restore a retired key.
- A verified document is cached per DID in an LRU for a TTL, then fetched and
  verified again.
- A signature that names a key the cached document lacks forces one fetch per
  DID per interval. A DID URL root that does not dereference to the Space a
  request addresses takes the same fetch, so the two share the interval.
- A failure is remembered briefly, so a failing host is not asked on every
  request.
- A first-contact fetch is one for a DID with no verified head here. Those are
  counted per host over a window and refused past a limit. A refresh of a DID
  that already verified does not draw on that window, so other DIDs on its host
  cannot starve it.
- Each of the two kinds also has its own limit on fetches in flight, and a fetch
  past it is refused, not queued.
- The body is size-bounded and the fetch has a timeout. The `PEER_WEBVH_*`
  constants in `config.default.ts` set these bounds.

The default fetcher, `fetchPeerLog`, speaks `https` only, on the default port,
follows no redirect, and connects only to the public addresses it checked after
DNS. `lib/outboundAddress.ts` holds those address checks, the pinned lookup and
the size-bounded body reader, shared with the CORS proxy.

`peerLogFetcher` is a plugin and `createApp` option that replaces the fetcher in
tests, since the host bound keeps a real fetch out of the suite. No environment
variable reaches the fetcher.

The resolver is one per app, decorated as `peerWebvh`, and `mayFetch` tells it
whether a DID may be fetched at all.

## DID URL invocation targets

A capability may name a `did:webvh` DID URL as its `invocationTarget`, such as
`did:webvh:<scid>:alice.example/photos/cat.jpg`. A `PathHandler` service in the
DID document maps the path to an https URL, and the server decides on that URL.
Repointing the service's `serviceEndpoint` moves a Space to another provider,
and the grants that name the DID URL keep working. A grant that names an https
URL stays bound to the provider that issued it.

The request is still an https request. The HTTP signature covers its URL. A DID
URL chain and the https request meet where the library compares the invocation
proof's `invocationTarget` with the dereferenced target of the invoked
capability.

A server lists `did-url-targets` in the `features` of its authorization profile
entry (see [service-description.md](service-description.md)). A client reads it
before it issues such a grant.

### The root capability

The root capability id is `urn:zcap:root:<url-encoded DID URL>`.

- The DID URL ends in `/`. A Space has one root id per `PathHandler` path.
- It carries no selector and no fragment. Such a root is refused.
- It must dereference to exactly the canonical trailing-slash URL of the Space
  the request addresses, on this server.
- The server synthesizes it with the Space's controller. The holder of the DID's
  update keys is the controller in this trust model. They can do what they want
  with the mapping. The server synthesizes the root with the Space's stored
  controller, and the chain must still be signed from that controller, so a DID
  document cannot create authority over a Space of someone else. A mapping
  change can widen an issued grant, as described under "The chain". The DID's
  update keys should be held by the Space controller. A deployment where they
  are separate parties trusts the DID's key holder with everything granted under
  DID URL roots.

A DID URL root is admitted on every route of an existing Space, Update Space
included. Create Space takes an https root, since no Space exists yet for the
DID URL to dereference to. Nobody signs the root, so it is always read from the
current document, and a repoint moves every chain beneath it. The `/kms` routes
take an https root alone.

### The chain

Every link beneath a DID URL root carries a DID URL `invocationTarget`. A chain
that mixes the two forms is refused, whichever way it mixes. The library never
attenuates a `did:` target to an https target or the reverse.

Each link must dereference to a URL at or beneath the URL its parent
dereferences to. The root dereferences to the Space URL, so every link stays
inside the Space. This is the https attenuation rule applied to dereferenced
URLs.

- A link may dereference through a different `PathHandler` than its parent did.
  A document may alias a path, such as `/pics` mapped to the `photos` Collection
  URL of the same Space.
- A handler that maps a path beneath a grant to a URL outside what the grant
  reaches does not widen the grant. The check bounds the result, not the
  handler.
- A dereferenced URL must be in canonical form. One that a URL parser would
  rewrite is refused. That covers a dot segment, in plain or percent-encoded
  form, and a backslash.
- A target that dereferences to another Space, another host, or a path above its
  parent's URL is refused as the masked `not-found`.

One document may serve several Spaces under different paths. Each Space has its
own root DID URL.

The rule bounds each link by its parent's URL at the time of the request, not at
the time of issue. A `PathHandler` added to the document can make an issued
grant reach more of the Space than its path suggests, up to the whole Space. For
example, the document maps `/` to the Space and a grant on `did:X/trash/` allows
`DELETE`. A new handler maps `/trash` to the Space URL. The grant now
dereferences to the Space URL and passes the container rule for Delete Space.
What remains is the bound that every link dereferences at or beneath its
parent's URL and the root to the Space. A grant never reaches outside the Space
its root dereferences to. A repoint of the root's handler can move a grant to
another Space of the same controller.

The container rule and the client-annex clause decide on dereferenced targets.
The full verification shares one dereferencer between the library's hook and
both inspectors, so it reads one document version per DID and selector set. The
root synthesis does not dereference. The local-only pre-pass for a foreign
invoker builds its own dereferencer, so that request may read the root's
document twice.

### Selectors

A selector such as `versionId` chooses the version of the DID document that maps
the path. An unpinned target is mapped by the current document. No pin is
required.

Attenuation between two DID URL targets checks the two parts separately.

- The target is split at the first `?` or `#`.
- The path part must equal the parent's, or extend it at a `/` boundary.
- The selector part must be byte-identical to the parent's.
- The link directly beneath the root may introduce selectors, since the root
  carries none. The Space controller signs that link, so the choice of document
  version is theirs.

The rule keeps a delegate from changing the selector. An older version may map
`/photos` to a different Collection, and a delegate that could add a pin would
reach it. A target carrying a fragment is refused.

The https request URL may extend its path or add a query to the invoked target's
dereferenced URL. A query on the https request selects no DID document, so it is
not held to the capability's selectors.

### Which DID may be named

A target may name a self-hosted `did:webvh` on this server, one replicated here,
or one not hosted here. The first two resolve from the local copy of their log.
A selector picks its version from that same verified log.

A DID not hosted here resolves over the network, which is the second network
case of this server (see
[Foreign invokers resolved over the network](#foreign-invokers-resolved-over-the-network)).
Portability depends on it, since the user keeps the DID across providers.

- The request signature and every delegation proof are checked before the fetch
  of the DID a target names. A request whose signature does not verify fetches
  no target DID. The invoker fetch above is a separate case.
- The fetch runs through the peer log resolver, under the same `PEER_WEBVH_*`
  bounds and `WAS_WEBVH_BLOCKLIST`. A blocklisted DID is refused before any
  fetch.
- The verified document is cached for `PEER_WEBVH_CACHE_TTL`, 5 minutes. A
  selector picks its version from the log kept on the cache entry and costs no
  fetch of its own.
- When the root does not dereference to the Space the request addresses under a
  cached document, the server fetches once more. That covers a root that
  dereferences to another host or another Space here, and a path no
  `PathHandler` matches.
- A DID gets one such early fetch per `PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL`, 60
  seconds. A missing key and a failed dereference share that budget. A
  verification that already fetched the DID's log takes no second one.

A pin that names a version after the cached log takes the same early fetch. That
is a `versionNumber`, or the number part of a `versionId`, greater than the
cached log's length. A `versionTime` does not refetch. A time after the last
cached entry resolves to the last cached version. After a pin's early fetch the
root and every link are dereferenced again from the fresh log, so a chain is
refused when that log maps the root elsewhere. The early fetch is one budget per
DID per interval with three triggers: a missing key, a root that does not
dereference to the Space the request addresses, and a pin after the cached log.
The budget is spent only when a fetch starts.

When the invoker is also a `did:webvh` not hosted here, a pre-pass precedes the
fetch of the invoker's log. It verifies every delegation proof and the
revocation store. It also checks that the root dereferences to the Space the
request addresses, whenever that needs no fetch. That is the case when the
target DID's log is stored here or its document is cached.

- A mismatch gives no grant, so the invoker's log is not fetched.
- A mismatch under a cached document passes while that DID's early fetch is
  unspent, since the full verification will refetch. This keeps a move from
  locking a foreign invoker out.
- A target DID neither stored nor cached passes to the full verification.
- The link checks, the container rule and the client-annex clause run only in
  the full verification.

A refusal masks the status and the body. It does not mask the fetch. The holder
of a valid grant on a DID not hosted here can present it at another Space id.
The server fetches the DID's log only when that Space has the same controller,
since the chain verifies there and the root mismatch takes the early fetch. The
holder can see a slower answer, and the host of the log sees the request. The
same holds when a delegate submits a revocation. It is limited to one probe per
DID per interval and one per cache expiry. A target DID neither stored nor
cached passes the pre-pass without a root check, so on the first probe a foreign
invoker's log can be fetched before the full verification refuses.

### Named denial causes

A refusal of a DID URL chain names `capability-revoked` or `capability-expired`
only when the chain's root dereferences to the Space the request addresses. Any
other refusal is the plain `not-found`. The conditions for naming a cause in
ARCHITECTURE.md's ZCap Structure still apply. The gate matters because the
library raises an expiry before the dereference check runs. Without it, a grant
for one Space presented at another would name its expiry when the two Spaces
share a controller.

### Revocation

A DID URL chain is accepted for revocation in a Space scope when its root has
the form above and its delegation proofs verify back to the Space's controller.

- When a key of the Space's controller signs the submission, the root is not
  dereferenced, under either root. Import Space does not dereference it either.
  A stored revocation is keyed by delegator and capability id within the Space,
  so it needs no mapping. An archived revocation is installed before the DID is
  repointed, and it survives the move.
- Any other party must dereference. When another party in the chain submits, the
  root must dereference to the Space the request addresses. Otherwise a delegate
  could submit its grant at any Space id and learn which Spaces share a
  controller. The refusal is the masked `not-found`.
- The submission's own invocation may be rooted in the Space's DID URL root. The
  root capability of the revocation URL itself stays https, so no second DID URL
  root form exists.
- A keystore scope takes an https chain alone.

### Moving a Space

A move is an export, an import on the other server, and a repoint of the
`PathHandler`. The grants that name the DID URL work on the new server
unchanged, and revocations made before the move are in force there.

The server the Space moved to picks up the repoint within about a minute. The
server it moved from keeps serving its cached document until
`PEER_WEBVH_CACHE_TTL` expires, so it may accept grants for up to 5 minutes
after the repoint. Https grants issued for the old server do not work on the new
one.

## The blocklist

The operator's blocklist (`lib/webvhBlocklist.ts`) reaches the network resolver.
`WAS_WEBVH_BLOCKLIST` and the `webvhBlocklist` plugin option take
comma-separated entries. An entry is a host name, which blocks every DID on that
host, or a full `did:webvh` DID. A blocked DID is refused before any fetch with
the masked `not-found`. A malformed entry refuses startup.

The blocklist covers the network path only. A DID whose log this server stores
never takes that path.
