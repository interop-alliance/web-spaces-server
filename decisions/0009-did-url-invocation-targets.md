# 0009: DID URL invocation targets

- Status: accepted
- Date: 2026-11-22
- Driving work: letting a Space move to another provider and domain with its
  capabilities still working. The design was settled with the maintainer on
  2026-11-21, 2026-11-22 and 2026-11-23.
- Affects: web-spaces-server (`src/zcap.ts`, the root synthesis in the document
  loader, `src/lib/containerRule.ts`, `src/lib/clientAnnexClause.ts`,
  `src/lib/peerWebvh.ts`, `src/serviceDescription.ts`); `@interop/zcap` (the
  `dereferenceTarget` option of `CapabilityInvocation`, and the rule that a
  `did:` target and an https target never attenuate each other);
  `@interop/http-signature-zcap-verify` (passes the option through
  `verifyCapabilityInvocation`); the zCap authorization profile of the PWS spec
  (the `did-url-targets` token on its entry).

## Context

Every `invocationTarget` and every root capability names the provider's https
URL. When a Space moves to another provider, each capability issued for it is
invalid. The user's grants do not survive the move.

A `did:webvh` DID URL can stand in for that URL. A grant names a target such as
`did:webvh:<scid>:alice.example/photos/cat.jpg`. A `PathHandler` service in the
DID document maps the path to the current https URL. Repointing the service's
`serviceEndpoint` is the move. The user keeps a DID like
`did:webvh:<scid>:alice.example` across providers.

The request itself is still an https request. The HTTP signature covers the
https request URL through the Cavage `(request-target)`, and the invocation
proof's `invocationTarget` is that URL. The DID URL chain and the https request
meet at one comparison in `@interop/zcap`. That comparison is between the
invocation proof's `invocationTarget` and the invoked capability's
`invocationTarget`.

A DID URL may carry a selector such as `versionId`. A selector chooses which
version of the DID document applies. A different version may map the same path
to a different Collection. A delegate that could change the selector could reach
a different Collection than it was granted.

A refused DID URL grant surfaces as the masked `not-found`. A client needs a way
to learn beforehand whether the server accepts such a grant.

## Decision

A capability may name a DID URL as its `invocationTarget`. The server
dereferences the DID URL to an https URL and decides on that URL.

1. Root capability form. The root capability id is
   `urn:zcap:root:<url-encoded DID URL>`. Its target must dereference to exactly
   the canonical trailing-slash URL of the Space the request addresses, on this
   server. The server synthesizes the root and gives it that Space's controller.
   The holder of the DID's update keys is the controller in this trust model.
   They can do what they want with the mapping, and point 4 states the
   consequence. The root is synthesized with the Space's stored controller, and
   the chain must still be signed from it, so a DID document cannot create
   authority over a Space of someone else. The DID's update keys should be held
   by the Space controller. A deployment where they are separate parties trusts
   the DID's key holder with everything granted under DID URL roots. The root's
   DID URL ends in `/`, so a Space has one root id per `PathHandler` path. A
   root whose DID URL carries a selector or a fragment is refused. A DID URL
   root is admitted on every route of an existing Space, Update Space included.
   Creating a Space takes an https root, since no Space exists yet for the DID
   URL to dereference to. Nobody signs the root, so it is always read from the
   current document, and a repoint moves every chain beneath it.
2. The whole chain is in DID URL form. Every link beneath a DID URL root carries
   a DID URL `invocationTarget`. A chain that mixes forms is refused. That
   covers a DID URL root with https links and an https root with DID URL links.
   In `@interop/zcap`, a `did:` target and an https target never attenuate each
   other.
3. Which `did:webvh` a target may name. A target may name a self-hosted
   `did:webvh` on this server, one replicated here, or one not hosted here. The
   third is resolved over the network. Portability depends on the third, since
   the user keeps the DID across providers.
4. Where a link's target may dereference to. Each link's target must dereference
   to a URL at or beneath the URL its parent's target dereferences to. The root
   dereferences to the Space URL, so every link stays inside the Space. This is
   the attenuation rule of an https chain, applied to the dereferenced URLs. A
   link may dereference through a different `PathHandler` service than the root
   did. A document may therefore alias a path, for example `/pics` mapped to the
   `photos` Collection URL of the same Space. A handler that maps a path beneath
   a grant to a URL outside what that grant reaches does not widen the grant.
   One document may serve several Spaces under different paths, and each Space
   has its own root DID URL. A target that dereferences to another Space,
   another host, or a path above its parent's URL is refused as the masked
   `not-found`. A dereferenced URL must be in canonical form. One that a URL
   parser would rewrite, such as a dot segment, a percent-encoded dot segment or
   a backslash, is refused.

   The bound holds at the time of the request, not of issue. A `PathHandler`
   added to the document can make an issued grant reach more of the Space than
   its path suggests, up to the whole Space. Suppose the document maps `/` to
   the Space and a grant on `did:X/trash/` allows `DELETE`. A new handler maps
   `/trash` to the Space URL. The grant now dereferences to the Space URL and
   passes the container rule for Delete Space. A grant still never reaches
   outside the Space its root dereferences to. A repoint of the root's handler
   can move a grant to another Space of the same controller.

5. Selectors. A DID URL selector such as `versionId` is honored. It selects a
   version of the DID document. The path is then mapped by that version's
   `PathHandler`, independently. No pin is required. An unpinned target is read
   from the current document. Attenuation between two DID URL targets checks the
   two parts separately.
   - The target is split at the first `?` or `#`.
   - The path part must be equal to the parent's, or extend it at a `/`
     boundary.
   - The selector part must be byte-identical to the parent's.
   - One exception applies. The link directly beneath the root may introduce
     selectors, since the root carries none. The Space controller signs that
     link, so the choice of document version is theirs.
6. Service description. The zCap authorization profile entry of `GET /service`
   gains `features: ['did-url-targets']`. A client reads it before it issues a
   DID URL grant.
7. Fetch and cache for a DID not hosted here. The request signature is checked
   before any fetch. The fetch runs under the existing `PEER_WEBVH_*` bounds and
   `WAS_WEBVH_BLOCKLIST`. It uses the existing foreign `did:webvh` cache, with
   `PEER_WEBVH_CACHE_TTL` of 5 minutes. When the root does not dereference to
   the Space the request addresses under a cached document, the server
   refetches. That covers a root that dereferences to another host, one that
   dereferences to another Space here, and a path no `PathHandler` matches. A
   pin that names a version after the cached log takes the refetch too. That is
   a `versionNumber`, or the number part of a `versionId`, greater than the
   cached log's length. A `versionTime` does not refetch, since a time after the
   last cached entry resolves to the last cached version. A DID gets one early
   refetch per `PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL` of 60 seconds. A missing
   key, a root that does not dereference to the Space the request addresses, and
   a pin after the cached log share that budget. The budget is spent only when a
   fetch starts.

   When the invoker is also a `did:webvh` not hosted here, a local pre-pass
   precedes the fetch of the invoker's log. It verifies every delegation proof.
   It also checks that the root dereferences to the Space the request addresses,
   whenever that needs no fetch, because the target DID's log is stored here or
   its document is cached. A mismatch gives no grant, so the invoker's log is
   not fetched. One exception applies. A mismatch under a cached document passes
   while that DID's early refetch is unspent, since the full verification will
   refetch. That keeps a move from locking a foreign invoker out. A target DID
   neither stored nor cached passes to the full verification. The link checks,
   the container rule and the client-annex clause run only in the full
   verification.

8. The library hook. `CapabilityInvocation` in `@interop/zcap` takes an optional
   `dereferenceTarget({ invocationTarget })` that returns a Promise of a string.
   The library calls it on the invoked capability's target. It then runs its
   existing equality or prefix comparison on the result. The dereference
   consumes the selectors, so the result carries no query or fragment. The
   library refuses a hook result that carries one when the capability's target
   is a DID URL. The result is then compared as an https target is. A request
   may extend its path or add a query to it. A query on the https request
   selects no DID document, so it is not held to the capability's selectors.
   `@interop/http-signature-zcap-verify` passes it through
   `verifyCapabilityInvocation`. The server dereferences once per request, so
   the root synthesis and the hook see the same document version. The container
   rule and the client-annex clause decide on dereferenced targets. They call
   the server's dereference directly.
9. Named denial cause. A refusal of a DID URL chain names `capability-revoked`
   or `capability-expired` only when the chain's root dereferences to the Space
   the request addresses. Any other refusal is the plain `not-found`. The
   existing conditions for naming a cause still apply.
10. Revocation. A DID URL chain is accepted for revocation when its root has the
    form of point 1 and its delegation proofs verify back to the Space's
    controller. When the Space controller submits the revocation, the root is
    not dereferenced. That is a submission signed by a key of the Space's
    controller, under either root, or one whose invocation is rooted in the
    Space's own root. Import Space does not dereference it either. A stored
    revocation is keyed by delegator and capability id within the Space, so it
    needs no mapping. An archived revocation is installed before the DID is
    repointed, and it survives the move. When any other party in the chain
    submits, the root must dereference to the Space the request addresses.
    Without that, a delegate could submit its grant at any Space id and learn
    which Spaces share a controller. Who may submit a revocation is unchanged.
    The submission's own invocation may be rooted in the Space's DID URL root,
    under point 1. The root capability of the revocation URL itself stays in
    https form, so no second DID URL root form exists.

Whether a `did:webvh` not hosted here may be a Space controller is out of scope.
It is a separate decision.

### Why a selector is fixed along the chain

A pin chooses which version's mapping applies. Suppose the current document maps
`/photos` to the `photos` Collection, and version 3 mapped it to `private`. A
holder of `.../photos/` could delegate itself `.../photos/?versionId=3` if any
link could add a pin. Only the link signed by the Space controller may introduce
one, and every link beneath it carries the selector unchanged.

## Rejected Alternatives

- A hook that replaces the comparison, such as a `matchTarget` returning a
  boolean. It moves a security rule out of the library, and every consumer would
  reimplement it.
- Refusing selectors on a target. `versionId` is a general DID URL mechanism,
  and a pin does not prevent a move.
- Keeping the library's https query rule for DID URLs, where a target with a
  query could only gain more query parameters. It would stop a pinned grant from
  being narrowed by path, though the pin and the path are independent.
- Letting any link add a pin, with a server-side check that every link
  dereferences at or beneath its parent's URL. It costs one dereference per link
  and a second rule to specify.
- Admitting a selector on the root's DID URL. A caller could name a root pinned
  to an old document version, and a repoint would not stop the chains beneath
  it.
- Requiring every link to dereference through the same `PathHandler` as the
  root. It forbids aliases, and it needs a definition of the same handler across
  document versions for a pinned link. The at-or-beneath-the-parent check bounds
  the chain without either.
- A dedicated service description member naming DID methods, or a profile
  version bump with no token.
- Requiring a link to dereference to exactly its parent's URL plus the path the
  link adds. It forbids aliases. The holder of the DID's update keys is the
  controller in this trust model, so the rule would guard against the party that
  is already trusted.
- Tightening only the container rules to require the tail's DID path to equal
  the root's. The reason is the same as for the entry above.
- Dropping the refetch on a root mismatch, to hide the fetch from a grant holder
  that probes other Space ids. A moved Space would then be picked up only when
  the cache expires.
- A separate, shorter cache TTL for target dereference. It is a second cache
  policy and more fetches.

## Consequences

- A Space can move between providers by repointing the `PathHandler`
  `serviceEndpoint`. Grants that name DID URLs keep working. Grants that name
  https URLs do not, and stay bound to the provider that issued them.
- The server a Space moved to picks up the move within about a minute. The
  server it moved from may accept grants for up to 5 minutes after the repoint,
  since it serves a cached document for that long.
- A DID URL grant is a chain in one form. A client that mixes the two forms in a
  chain is refused, and so is a target that dereferences outside the Space.
- The holder of the DID's update keys is the controller in this trust model. A
  mapping change can break a grant, move it to another Space of the same
  controller, or widen it up to the whole Space. A DID document cannot create
  authority over a Space of someone else, since the chain must be signed from
  the Space's stored controller. The DID's update keys should be held by the
  Space controller.
- A client reads `features` on the authorization entry before it issues a DID
  URL grant. A server without the token answers such a grant with the masked
  `not-found`.
- Dereference of a DID not hosted here adds a network fetch to a request. It
  runs under the existing bounds, the blocklist and the cache, and only after
  the request signature is checked.
- A refusal masks the status and the body. It does not mask the fetch. The
  holder of a valid DID URL grant on a DID not hosted here can present it at
  another Space id. The server fetches the DID's log only when that Space has
  the same controller, since the chain verifies there and the root mismatch
  takes the early refetch. The holder can see that as a slower answer, and the
  host of the log sees the request. The same holds when a delegate submits a
  revocation. It is limited to one probe per DID per interval and one per cache
  expiry. This is accepted as the cost of picking up a move within a minute. A
  target DID neither stored nor cached passes the pre-pass without a root check.
  On the first probe at a Space with the same controller, a foreign invoker's
  log can therefore be fetched before the full verification refuses.
- `@interop/zcap` gains an optional hook, and
  `@interop/http-signature-zcap-verify` passes it through. A caller that does
  not pass it sees no change.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. A deployment needs a server it moved from to stop accepting grants sooner
   than the cache TTL allows. That would call for a shorter or separate refresh
   policy for target dereference.
2. A use case needs a link to dereference outside the Space URL its root
   dereferences to, such as a grant that spans two Spaces.
3. A use case needs a delegate to choose a document version. That would reopen
   the rule that selectors are fixed beneath the root's first link.
4. The PWS spec settles a different advertisement than the `did-url-targets`
   token for this capability.
5. A use case needs a whole chain fixed to one document version from the root.
   That would reopen the refusal of a selector on the root.
6. A deployment where the DID's update keys and the Space controller are
   different parties that do not trust each other.

If revisited, the change to the library hook should stay a separate decision
from the chain rules above, since the hook is shared with other consumers.
