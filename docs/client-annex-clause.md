# Chain Inspection: the Client-Annex Clause and the Container Rule

This document describes how the server inspects a verified capability chain
before it admits an invocation. It covers the revocation inspector, the
client-annex clause (the annex-chain inspector, with its seven admitted shapes
and two invocation-time bounds), and the container rule.
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map, the root-vs-delegated
invocation explanation, the denial-reason material, and the glossary.

## The inspectors

After signature verification, the dereferenced chain passes through two composed
inspectors. The revocation inspector (`lib/revocations.ts`) fails a chain
containing any capability with a stored revocation, with an error named
`CapabilityRevokedError`. The annex-chain inspector (`lib/clientAnnexClause.ts`)
bounds what a _ladder_ verification method may delegate.

Both inspectors bind the capability decision only. A refusal falls through to
the target's access-control policy like any other failed verification, so a
world-readable read still serves.

The container rule (below) is read by a third chain inspector. It is composed
first because it resolves nothing.

## Ladder verification methods

A ladder VM is the stable, credential-derived method a wallet publishes on a
ladder-anchored account document. It is recognized by relation asymmetry: a
`capabilityDelegation` member of the resolved self-hosted `did:webvh` document
that is absent from `capabilityInvocation`. (Resolution of that document is
described in [webvh-controllers.md](webvh-controllers.md).)

A delegation signed by a ladder VM is admitted only in one of seven shapes.

## Shape 1: the Space items subtree

The first shape is bounded by grantee, target, and action together. See
[decision 0002](../decisions/0002-ladder-delegation-target-verb-predicate.md)
for the target-and-verb predicate this family of shapes rests on.

- Its sole `controller` equals the client-annex DID named by the account
  document's `https://w3id.org/byoe#DelegatedClients` service entry (a
  self-hosted `did:webvh` string, compared by pointer equality).
- Its `invocationTarget` lies within the items subtree of the Space that carries
  the delegator's own history log: the trailing-slash Space URL, or any path
  under it, except the Space Metadata URL `/space/<S>/meta` and anything under
  it.
- Its `allowedAction` is present, non-empty, and drawn from the closed PWS verb
  vocabulary {GET, POST, PUT, DELETE}. A `HEAD` request is authorized as a
  `GET`, so `HEAD` is not an action of its own.

The whole vocabulary is admitted rather than a chosen subset, because the
generation delegation a wallet already mints carries exactly it, and a child
capability may not exceed its parent. The target bound does the narrowing.
Keystore targets are outside the subtree by path. The `meta` exclusion refuses a
ladder delegation aimed at the Metadata object directly, though a whole-subtree
grant still covers it by attenuation at invocation time (see
[The ladder invocation-time bound](#the-ladder-invocation-time-bound)). An
onward grant minted by a two-relation annex verification method is a child of
the admitted delegation, so it cannot exceed that subtree either.

## Shape 2: bridge-shaped grants

The second shape is bridge-shaped, with two branches.

- The `invocationTarget` is the delegator account's own history log resource URL
  (derived from the account DID, which carries its log's Space and Collection)
  with `allowedAction` within {PUT}.
- Or it is the trailing-slash URL of a Space whose Metadata object declares it
  delegated-clients bookkeeping (typed `AuxiliarySpace` +
  `DelegatedClientsSpace`, the only combination Create Space accepts for the
  latter) with `allowedAction` within {GET, PUT, POST}.

The POST reaches that Space's export and import endpoints and Create Resource on
each Collection container beneath it, and adds no authority a PUT holder lacked.

## Shape 3: a single-verb grant on the Space itself

The third shape is a target-exact single-verb grant on the Space itself, split
by verb.

- Its DELETE branch: `invocationTarget` is the canonical trailing-slash Space
  URL, equal to the parent capability's own target unchanged -- whether that
  parent is a delegated capability or the Space's synthesized root -- and
  `allowedAction` is exactly {DELETE}.
- Its GET branch: `invocationTarget` is the Space Metadata URL
  `/space/<S>/meta`, `allowedAction` is exactly {GET}, and the parent's target
  is either that same Metadata URL or the Space's canonical trailing-slash URL.

Either branch only narrows toward the one read or delete the ladder VM may sign
and cannot widen it. A two-verb set does not qualify on either branch.

## Shape 4: a single-verb read of one Resource

The fourth shape is a target-exact single-verb read of one Resource. Its
`invocationTarget` is a Resource URL `/space/<S>/<C>/<R>`, three URL-safe
segments with `<C>` and `<R>` outside the reserved path-segment registry, so a
Collection Metadata object, a policy, or a query endpoint does not qualify. Its
`allowedAction` is exactly {GET}. The parent's target is either that same
Resource URL or the Space's canonical trailing-slash URL. The parent may be a
delegated capability or the Space's synthesized root.

This is the shape a transient wallet session mints to read one record, the
keyring record of an unlock Space, under the management delegation the Space's
controller granted the account at bind time. The server recognizes no unlock
Space. The shape holds for any Space, since the parent already bounds which
Space the read can target. By attenuation the grant also reaches the reads under
that Resource URL (its `/meta`, `/policy`, and chunks), all reads.

## Shape 5: a single-verb POST over a management capability

The fifth shape is a target-exact single-verb `POST` over a delegated management
capability. Its `invocationTarget` is the canonical trailing-slash Space URL,
equal to the parent capability's own target unchanged. Its `allowedAction` is
exactly {POST}. A two-verb set does not qualify, and neither does any other
verb.

The parent must be a delegated capability rather than the Space's synthesized
root. Its sole `controller` must be the delegator account itself. The controller
DID of the parent's own delegation proof must be the Space's stored controller
(one memoized Space Metadata read), so the parent is the management capability
that Space's controller delegated to the account.

This is the shape a transient wallet session mints from the management zcap of a
sibling unlock Space to invoke Export Space on it (the backup export). Like the
third shape's DELETE branch, it widens who signs the last link of a grant the
account already holds rather than what the account may do. It reaches no Space
the account holds no management capability on.

The invocation is not classified by the invocation-time bounds below. Those read
`PUT` on a Space Metadata URL and `DELETE` on a canonical Space URL, and a
`POST` at `/space/<S>/export` is neither.

## Shape 6: a replica pull under the annex document's pointer

The sixth shape is the pull grant a wallet session signs to a replica server. It
is the first shape gated on a record rather than on shape alone. Four bounds
hold together.

- Its sole `controller` equals the `serviceEndpoint` of a service entry of type
  `https://w3id.org/pws#ReplicaServer` in the client-annex document, the
  document the account's `DelegatedClients` entry names. The string must also
  parse as a `did:webvh` whose path is `space:server:id`, a server identity, on
  any host, a port or a single-label host included.
- Its `invocationTarget` is the canonical trailing-slash URL of the account
  Space (the Space carrying the delegator's log) or of the auxiliary Space
  carrying the annex log.
- Its `allowedAction` is present, non-empty, and within {GET}.
- Its parent is the Space's synthesized root.

The server resolves and verifies the annex document out of its own storage, as
it does any local `did:webvh`, through the verified-document cache and with no
network fetch. The first shape compares the annex DID string alone; this one
reads the document. An annex document that does not resolve admits nothing. The
shape checks run first, so only a pull-shaped grant pays for the read.

The pointer is the record. A credential's annex rung writes it into the annex
log before any delegation names the server, so a ladder-signed copy of the
account always leaves a logged entry. Removing the pointer ends that server's
ladder-signed pull of the account Space, and so does a generation swap that does
not restate it. The auxiliary-Space pull survives both today: the shapes are
alternatives, and the second shape's Space branch admits a GET of a whole
delegated-clients Space to any grantee with no pointer check. Revocation at the
auxiliary Space is that pull's only stop until the branch gains a grantee bound.
A pull grant an enrolled client signs is not a ladder delegation, and the clause
does not bound it.

Under today's target attenuation the Space URL covers the Space listing and each
Collection's `changes` feed, which is what the pull loop reads. A GET of one
Resource under the Space is the fourth shape, admitted to any grantee, so a
pull-shaped grant narrowed to one Resource is not refused by this shape's target
bound.

## Shape 7: a maintenance grant on the replicas route

The seventh shape is the grant a wallet session holds to maintain the replica
registrations of a promoted replica Space, on the replica server. Four bounds
hold together.

- Its `invocationTarget` is the Space's replicas URL `/space/<S>/replicas`
  exactly. A registration URL beneath it does not qualify as the target. The
  grant reaches those by attenuation.
- Its `allowedAction` is present, non-empty, and within {GET, POST, PUT,
  DELETE}, the actions the replicas routes serve. Every `GET` route answers
  `HEAD`, which is authorized as a `GET`.
- Its parent is the Space's synthesized root.
- The delegator's log is a registration's copy, not a log self-hosted on this
  server.

No grantee bound and no pointer gate apply. A promoted replica Space's
controller is the account `did:webvh`, and a credential-anchored account holds
no key that document lists under `capabilityInvocation`, so nothing can
root-invoke there. The wallet signs this grant with the ladder VM to its own
bare `did:key`, invokes it as that `did:key`, and keeps it short-lived. With it
the session lists the registrations, reads a status, re-registers a source,
replaces a pull capability in place, pauses and resumes, and removes a
registration.

The replica server cannot gate the grant on the annex pointer. Its copy of the
client-annex document lags the source by a pull, and does not exist before the
auxiliary Space is copied. What the grant reaches is bounded on the route
instead (see [replication.md](replication.md#authorization)). A delegated
create, by `POST` or by `PUT` at an absent id, admits only a `fromSpace` a
registration on the Space already names, so the grant cannot introduce a new
source. A delegated pause of the one registration that maps the Space's
controller is refused, and Delete Replica keeps that registration. A listing
exposes pull capabilities only the replica server's own DID can invoke.

The shape is the one exception to the rule that every admitted ladder delegation
leaves a record. It holds only on a replica server, whose copy is never the
account's log of record, and the fourth bound enforces that. On the server that
hosts the account's log of record, the same grant is refused. There the
controller's root invocation and the other shapes maintain the Space, and
admitting the shape would hand a ladder-signed grant the account Space's own
registrations with no record anywhere.

## The ladder invocation-time bound

The zcap library's target attenuation is a `/`-boundary prefix rule. A grant on
the trailing-slash Space URL (`/space/<S>/`) therefore reaches both
`PUT /space/<S>/meta` (the controller rewrite) and `DELETE /space/<S>/` (Delete
Space) by ordinary attenuation. A subtree grant admitted under the first shape,
or the second shape's Space branch, reaches both.

The clause closes this with an invocation-time bound. It applies to any chain
carrying a ladder-signed link, regardless of which shape admitted it.

- Invoked as `PUT` on a Space Metadata URL, the chain is refused outright.
- Invoked as `DELETE` on a canonical Space URL, the chain is refused unless
  every ladder-signed link in the chain is itself the third shape's DELETE
  branch (target-exact, action exactly `DELETE`).

The bound reads the ladder-signed links rather than the chain's tail, because
the tail's shape is not the ladder VM's to determine. An annex verification
method holds both relations and so is not ladder authority. It can narrow a
whole-subtree grant into a target-exact DELETE-only child by ordinary
attenuation, and a tail-only check would read that narrowing as the third shape
it is not. A genuine third-shape grant still verifies, and may still be
delegated onward, since attenuation can only keep such a child target-exact and
DELETE-only.

`handleZcapVerify` threads the operation's target and action into the inspector
through its `invocation` option, since the zcap library's chain-inspection hook
otherwise sees only the dereferenced chain. The revocation route, whose target
is never a Space or Space Metadata URL, builds the inspector without one and
gets the delegation-shape bound alone. Create Space by Id verifies a chain with
a `did:webvh` link, but the bound still refuses one that carries a ladder-signed
link.

## The transient-annex bound

A second invocation-time bound targets a different signer: the _transient annex
VM_, a per-visit method a wallet publishes in its client-annex document under
`capabilityInvocation` and `capabilityDelegation` and under no other relation.
It is not a ladder VM, so the ladder bound never sees the links it signs.

A path therefore needs its own bound. A transient VM holding a generation
delegation -- the Space-subtree grant with the full verb vocabulary, signed by
an enrolled client's key, so no ladder link is anywhere in the chain -- could
narrow it into a target-exact DELETE-only child and invoke it. That would
satisfy the container rule's DELETE exception without tripping the ladder bound.
A `DELETE` on a canonical Space URL is refused whenever any link in the chain is
signed by a transient annex VM, whoever signed the links above it.

The bound reads who signed a link, not who invokes it. A per-visit key's own
delegation never ends an account or its annex, while a DELETE-only child an
enrolled client signs to the annex DID stays admitted. A wallet's own delete
flows sign their DELETE-only children with the ladder VM and invoke them under a
`did:key`, and the annex garbage collector's re-mint is signed by an enrolled
client, so no admitted shape is lost.

A `PUT` on a Space Metadata URL needs no branch of this bound. The container
rule's `controller-only` rule refuses every delegated invocation there, off the
header, before any chain is read.

### Recognizing a transient annex VM

A transient annex VM is recognized by the shape of the signer's own document
alone: listed under `capabilityInvocation` and `capabilityDelegation`, and
absent from `authentication`, `assertionMethod`, and `keyAgreement`. Nothing
else a wallet publishes has that shape. An enrolled-client method carries all
four signing relations, and a ladder VM is absent from `capabilityInvocation`.

The document is the one the delegation-proof verification just resolved, so the
check costs no further read. Reading nothing but the signer's document keeps the
bound total. It holds for a retired annex generation the account document's
`DelegatedClients` entry no longer names but whose grant is still live, since
the annex garbage collector re-points that entry before it revokes that
generation's grant. It also holds for an annex a `did:key` controller delegated
to directly, where no delegator document exists to walk.

## Fail-open across servers

The clause is fail-open across servers. A server running unmodified verification
accepts exactly what this clause refuses, so a wallet signs up an account only
on a host that claims the client-annex profile. The wallet checks once, at
signup, and does not re-check. A host that drops the claim later leaves that
account's ladder VMs standing.

This server makes that claim with its service description's
`https://w3id.org/pws/client-annex` entry at version `0.1`, which names the
clause as enforced here, with its seven admission predicates. A change to what
the clause admits is a new version of that entry.

## The container rule

The container rule lives in `lib/containerRule.ts`. An unsafe method at a
container URL is controller-only, with two exceptions. A fourth rule, on the
replicas routes, is of the same kind: it reads the invoked capability's target
to keep a data grant out of a reserved sub-resource.

The hazard is that a data grant's `invocationTarget` is the container URL
itself, and the zcap library's target attenuation is a `/`-boundary prefix rule.
Nothing separates writing a Resource under a Collection from rewriting or
deleting the Collection.

### Controller-only operations

`PUT /space/<S>/meta` on an existing Space and `DELETE /space/<S>/<C>/` accept
nothing else. Any delegated invocation is refused there, whatever its
`allowedAction`.

Update Keystore (`POST /kms/keystores/<K>`) carries the same rule. Its body
rewrites the keystore's `controller`, so a keystore `write` grant, or an
action-less one, would otherwise hand its holder every key in the keystore and
leave the old controller unable to revoke it.

That refusal turns on nothing but whether the `Capability-Invocation` header
embeds a delegated capability. A root invocation carries only the capability id,
and a delegated one embeds the capability itself. `handleZcapVerify` decides it
straight off that header, before signature or chain verification, so no chain is
dereferenced and no delegation proof is verified for a request refused this way.

### Exceptions

The other rules below still need the dereferenced chain, since they admit some
delegated shapes and not others. The third chain inspector reads the invoked
capability, the chain's tail, for those. A chain of length one is the
synthesized root alone, so a direct root invocation always passes.

- `DELETE /space/<S>/` also accepts a delegated capability whose tail targets
  exactly that Space's canonical trailing-slash URL with `allowedAction` exactly
  `['DELETE']`. A single-verb DELETE grant is not a data grant, which is why the
  exception is keyed on the exact action set.
- `PUT /space/<S>/<C>/meta/log` also accepts one whose tail targets exactly the
  Space's items subtree, the trailing-slash Space URL a wallet's generation
  delegation carries. A transient session can then put a Collection under log
  governance or append to its log. The guarded create of that log is the
  declaration that starts governing the Collection's `encryption` descriptor and
  refuses every direct `encryption` write from then on (see
  [governed-logs-and-revisions.md](governed-logs-and-revisions.md)). A tail
  aimed at the Collection container URL, at the log URL, or at a Resource stays
  refused there.
- `PUT /space/<S>/<C>/meta` accepts the same tail, one targeting exactly the
  Space's canonical trailing-slash URL. A tail aimed at the Collection container
  URL, at the Metadata URL itself, or at a Resource is refused. The write
  replaces the Collection's configuration and creates the Collection when
  absent, so a Collection data grant does not reach it. An app that holds a
  Collection-scoped grant does not declare its own indexes or `encryption`
  through this write. The controller writes them, or the app holds a grant on
  the Space URL.

### The replicas routes

Every replicas route (`/space/<S>/replicas`, a registration beneath it, and its
`status`), the reads included, carries the `replicas-subtree` rule. A direct
root invocation passes. A delegated capability passes only when its tail targets
the Space's replicas URL or a URL beneath it. A tail on the Space URL, the shape
of an app's data grant, is refused, since it would reach the routes by
attenuation and with them the Space's pull capabilities, its pull loops and its
registrations. The maintenance grant of
[Shape 7](#shape-7-a-maintenance-grant-on-the-replicas-route) targets the
replicas URL itself and passes. The bounds on what an admitted delegated
invocation may do there are the route's (see
[replication.md](replication.md#authorization)).

### Operations outside the rule

Create Collection (`POST /space/<S>/`) is outside the rule.

### What the rule does not read

The tail alone is read. A DELETE-only child of a two-verb management parent
still deletes the Space. The rule says nothing about who signed any link, so it
holds whatever DID method the controller or a delegator uses. The clause's two
invocation-time bounds close that gap between them.

- The ladder bound runs on a chain carrying a ladder-signed link.
- The transient-annex bound covers the case the ladder bound cannot: a
  generation delegation signed by an enrolled client's key, carrying no
  ladder-signed link at all, narrowed downstream into a DELETE-only child by a
  transient annex verification method. It refuses any chain carrying a link
  signed by that kind of method outright, whatever shape the link or the links
  above it have.

## How the rule and the clause compose

The two compose rather than overlap. The container rule refuses first on the
invoked shape. The clause still refuses a ladder-signed or
transient-annex-signed chain the rule would admit, reading those links instead
of the tail.

- The clause's `PUT`-on-Space-Metadata branches are shadowed by the rule. The
  rule already refuses any delegated `PUT /space/<S>/meta` regardless of chain
  composition, so the clause's own refusal there never decides anything on its
  own. It is kept as defense in depth.
- The clause's `DELETE`-on-canonical-Space-URL branches still decide a case the
  rule does not. The rule reads only the tail, so a ladder-signed link earlier
  in the chain that is not itself target-exact-DELETE-only, later narrowed to
  that shape by attenuation, passes the rule but is still refused by the ladder
  bound.
- Any chain carrying a transient-annex-signed link is refused by the
  transient-annex bound regardless of the tail's shape.

A refusal binds the capability decision only and surfaces as the ordinary masked
`not-found`, since all five handlers are capability-only. See the denial-reason
material in [ARCHITECTURE.md](../ARCHITECTURE.md).
