# Replication

How a server replicates a Space from a peer server: the sync signer, replica
registrations and the checks they pass, the pull loop, and the apply path that
stores what the loop reads. The replication facet writes replicated records only
through the backend's `apply*` methods, and no request route can supply a write
stamp. [ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the
glossary (see Replica registration, Pull loop and Creating stamp there).

## The sync signer

`src/lib/syncIdentity.ts` holds the signer a server invokes a peer's
capabilities with when it replicates a Space. It is the same seed key as the
export-signing key, named as the method `{serverDid}#{publicKeyMultibase}`.

`loadSyncSigner` returns a signer only when `resolveServerDid` yields a
`serverDid` and the resolved document lists the key under
`capabilityInvocation`. `resolveServerDid` is described in
[server-identity-and-provenance.md](server-identity-and-provenance.md).
Otherwise `loadSyncSigner` returns a refusal with a reason: no advertised
`serverDid`, or the key not listed under `capabilityInvocation`. A storage fault
met while reading the log is thrown as its 5xx and is not a refusal.

A controller delegates the pull capability to `serverDid`, which a wallet reads
from the core `https://w3id.org/pws` entry of `/service`. A peer verifies the
invocation against the server's log. There is no second key and no `/service`
member. Listing the relationship is the switch that enables replication. Every
read a pull loop makes of a peer Space is signed with it (`sync/peerClient.ts`).

## Registrations

`src/sync/` is the replication facet: replica registrations and their pull
loops. A registration is one source peer of a Space, a directed edge the
controller writes at `POST /space/:spaceId/replicas`
(`requests/ReplicaRequest.ts`). It carries:

- `id`
- `fromSpace`, the peer Space's URL
- `toSpace`, this Space's URL
- `capability`, the pull capability, delegated to this server's DID with
  `allowedAction` exactly `GET`
- an optional `collections` list
- `role`, which is `source`
- `pausedAt`, present only while the pull loop is paused (see
  [Pause and capability replacement](#pause-and-capability-replacement))

The served record also carries the write stamp members `updatedAt`,
`updatedAtCounter` and `originId`. A value for any of them in a write body is
ignored.

`GET` there lists the records as `{ url, totalItems, items }`. `GET`, `PUT` and
`DELETE` of `/space/:spaceId/replicas/:replicaId` read, create or replace, and
remove one, and `GET .../status` reads the pull loop's state.

### Authorization

Every replicas route admits a root invocation by the Space's controller and a
delegated invocation whose invoked capability targets the Space's replicas URL
or a URL beneath it. That is the `replicas-subtree` container rule (see
[client-annex-clause.md](client-annex-clause.md#the-container-rule)). A
delegated grant on the Space URL, the shape of an app's data grant, reaches the
routes by attenuation and is refused with the masked `not-found`. Admitted, it
would list the Space's pull capabilities, pause its loops and remove its
registrations. The reads verify a capability and consult no access-control
policy, so an anonymous read is the masked `not-found` (404). On a promoted
replica Space, whose controller is an account `did:webvh`, the client-annex
clause admits a ladder-signed grant on the Space's replicas URL under the
Space's root, with no pointer gate (see
[client-annex-clause.md](client-annex-clause.md#shape-7-a-maintenance-grant-on-the-replicas-route)).

The delegated path carries two bounds. The first is on a create. A create under
a delegated invocation, by `POST` or by `PUT` at an absent id, admits only a
`fromSpace` that a registration already on the Space names, and is otherwise
`replica-refused` (409) on `#/fromSpace`. The handler decides it once before the
source is read, so a refused body costs the source server nothing. The write
decides it again from the registrations it reads inside its critical section,
which no other registration write or Delete Replica of the Space can enter
meanwhile, so a registration removed between the two reads does not satisfy the
bound. A `PUT` the handler read as a replacement is bounded as a create when the
registration is gone by the time the write runs. A delegated grant can therefore
re-register a source the Space has, replace a pull capability in place, resume,
and remove a registration, and cannot introduce a new source. Without the bound,
the holder of a grant a phished credential signed could register a server of
their own as a second source. That source could serve the account DID as
`controller`, which the controller check compares as a string, and have its
tombstones applied to the copy. A root create is unbounded. A replacement
through `PUT` needs no bound, since `fromSpace` cannot change by `PUT`.

The second bound is on a pause. A delegated `PUT` that carries `pausedAt` on the
one registration mapping a local Space's `did:webvh` controller to a copy of its
log is `replica-refused` (409) on `#/pausedAt`. A paused copy stops following
the source, so a key the account withdrew there would stay current here for as
long as the pause held, and every grant a ladder method of that key set signed
would stay valid. That is the lockout Delete Replica refuses, in a form that
leaves the registration in place. The controller's own capability may pause it.
A resume is never refused.

Delete Replica refuses to remove the one registration that maps the Space's
controller whoever invokes it (see
[Guards on Delete Replica and Update Space](#guards-on-delete-replica-and-update-space)).

A registration is a versioned record (see
[validators-and-stamps.md](validators-and-stamps.md)). Every write mints a write
stamp with the store's clock inside the write's critical section, and the
generation is minted at the first write and kept for the record's life. The
`ETag` is the standard four-segment `"<generation>.<ms>.<counter>.<originId>"`.
POST and `PUT` both answer with it.

Both backends store a registration through one write,
`StorageBackend.writeReplica`, which takes the client's shape of the record, the
`pullsChunks` the peer checks found for its capability, an optional `createOnly`
(the POST), and the preconditions, and resolves the stored registration with the
one it replaced. `createReplica` is the create-only form. The decision is shared
(`decideReplicaWrite` in `src/lib/replicaRecord.ts`) and made inside the write's
critical section, from the registration read there: a create-only write over one
is `id-conflict`, the preconditions are evaluated against its `ETag`, the fixed
members are compared, the stamp is minted above its stamp, and `pausedAt` is
decided by the pause rule from its presence on the client's shape. The
preconditions go before the fixed members, as on every other versioned record,
so a conditional write made from a stale view answers 412 rather than 400. A
replacement that keeps the stored capability keeps the stored `pullsChunks` with
it, whatever the request layer passed.

A record is stored inside the Space (`.replica.<id>.json` beside
`.replica.<id>.state.json` in the filesystem Space dir, a row of the Postgres
`replicas` table), so Delete Space removes it. It is not replicated and not
exported. Storing or removing one advances the Space Metadata object's local
segment, since the served `replicas` member changed (see
[validators-and-stamps.md](validators-and-stamps.md)). A replacement through
`PUT` does not, because the served `replicas` member lists `fromSpace`,
`toSpace` and `role` alone, and those cannot change.

## Pause and capability replacement

`PUT /space/:spaceId/replicas/:replicaId` takes the full record, as POST does.
Its `id` must equal the URL's, or the answer is `invalid-request-body` (400) on
`#/id`. Against a stored registration the body may differ in `capability` and
`pausedAt` alone. A difference in `toSpace`, `collections` or `role` is
`invalid-request-body` (400) on that member's pointer. A changed `fromSpace` is
refused earlier, by the body parser, since the capability's `invocationTarget`
no longer equals it. The comparison is made inside the write's critical section,
against the registration stored there, so a registration created or removed
under the id meanwhile is judged, not the one an earlier read saw.

A `PUT` at an absent registration creates it through the same checks as POST and
answers 201 with `Location` and the record. A replacement answers 204. Both
carry the new `ETag`. `If-Match` and `If-None-Match: *` are optional and are
evaluated by the backend atomically with the write, after a first evaluation at
the request layer against the registration read before the peer checks, so a
stale conditional write costs the source server no read. A miss is
`precondition-failed` (412), `If-None-Match: *` on an existing registration
included. POST keeps `id-conflict` (409) for an existing id. A create that
carries `pausedAt` starts no loop, by `PUT` as by POST.

`pausedAt` is an RFC 3339 UTC time, and the server sets it. A body that carries
`pausedAt` pauses the registration, and a body that omits it resumes. A
non-string value is `invalid-request-body` (400) on `#/pausedAt`. The client's
value is otherwise ignored. On the change from unpaused to paused the server
stores the write's own stamp time. A later `PUT` while the registration is still
paused keeps the stored time, so replacing the capability of a paused
registration does not move it. A create, by POST or `PUT`, that carries
`pausedAt` makes the registration paused.

A `capability` that differs from the stored one is validated as a POST's is: the
grantee is this server's DID, the chain and actions pass, and a read of the
source Space through it succeeds. That read also refreshes `pullsChunks`. A
capability equal to the stored one is not re-read, so a pause or a resume costs
no request to the source server; the handler decides that from a read before the
write, and the write keeps the stored `pullsChunks` when the capability it finds
under the lock is unchanged too. The registration keeps its id, its loop and its
`.replica.<id>.state.json` checkpoint (the `state` column in Postgres), so the
next cycle does not read the source from the start. A pause, a resume, a new
capability or a create has the loop react at once; a `PUT` that repeats the
stored body leaves the scheduled cycle alone.

A paused registration still maps a peer-hosted `did:webvh` controller onto the
local copy of the log, because the index reads every stored registration. The
DID keeps resolving, and Delete Replica still refuses to remove the one
registration that maps a controller. Under a delegated invocation, pausing that
registration is refused as well (see [Authorization](#authorization)).

## Registration checks

`sync/registration.ts` holds the checks a registration passes before it is
stored. A malformed body is `invalid-request-body` (400). The rest read the
peer, and a break of one is `replica-refused` (409). The checks are:

- The local Space is not the `server` Space.
- This server has a sync signer, and the capability is delegated to its DID.
- The peer's `/service` lists the replication entry at this server's version and
  an `originId` that is not this server's (see
  [service-description.md](service-description.md)).
- The peer Space, read through the capability, has the local Space's `type` set,
  and a controller the local one matches.
- Each Collection both sides hold as the same life (one generation) agrees on
  the immutable members. Two lives of one id are not compared, since the apply
  path replaces one or skips the other and merges neither. Two Collections under
  log governance are left to their logs. A governed Collection paired with one
  that stores a client-written `encryption` is refused.

The peer Space's id need not equal the local one.

The `/service` read also records whether the source server lists the Encrypted
Collections entry. The answer is stored as `pullsChunks` on the stored
registration. It is not a member of the wire record the controller sends and
reads back. A registration made against a server without the entry pulls no
chunks.

The controller match has three branches. The two controllers are equal; or the
peer controller is a `did:webvh` hosted in the peer Space whose current document
lists the local Space's `did:key` controller under `capabilityInvocation` (the
listed-key branch); or the local Space's controller is a `did:key` and the pull
capability is a one-link delegation from the peer Space's root whose delegation
proof a method the peer controller's document lists under `capabilityDelegation`
signs (the bootstrap branch). The second and third are the common order: a
wallet promotes its Space to its `did:webvh` before the Space gains a replica,
and a new local Space is created under a `did:key`. The local Space cannot be
promoted first, since the DID resolves here only through a registration.

The listed-key branch admits a local Space created under one of the account's
enrolled client keys. The bootstrap branch admits one created under a `did:key`
the wallet derives for the purpose, as an account with no enrolled client must,
since a ladder method is listed under `capabilityDelegation` alone. The local
`did:key` need not appear in the document, and nothing binds it to the
capability: a pull capability that leaks lets its holder register a copy under a
key of their choosing, readable until the controller revokes the capability at
the source. A re-delegated grant fails the one-link condition, and a capability
the source refuses fails the registration at its read of the peer Space, before
any branch is tried, which is what gates a ladder-signed pull on the
client-annex replica pointer the source checks.

The peer controller's document is resolved one of two ways, and never fetched by
DID. A DID hosted in the peer Space itself has its `did.jsonl` read through the
pull capability and verified offline, as a replicated copy is, against the head
this server last verified. The registration must pull the log's Collection, so
the copy the promotion needs arrives with the first pull. That read decides over
any stored copy: replacing a capability finds the registration's own mapping,
whose copy may not exist yet, or may not list the key that signed the new
capability. A DID hosted in another Space of the peer host resolves from the
local copy that exactly one other registration on this server maps (see
[Where a replicated log lives](#where-a-replicated-log-lives)), which is how the
client-annex auxiliary Space registers: its controller is the account
`did:webvh`, whose log lives in the account Space and reaches this server
through the account replica's registration. Only the bootstrap branch reads a
mapped copy; the listed-key branch takes the hosted DID alone. A mapped copy can
lag the source. A key the source retired is still caught, since the source
verifies the capability at the read of the peer Space. A key the source added is
refused until the next pull of the registration that keeps the copy, and the
refusal says the copy may be behind. Once the first pull lands, Update Space
moves the local Space to the DID, resolved through the same mapping, and the
controllers are equal from then on. Without the controller check, a holder of
any readable pull capability could register another user's Space as a source and
read the copy through root invocations.

One check reads no peer. A registration is refused when another local Space
already replicates the same peer Space with a Collection in common, since a
`did:webvh` hosted in a Collection two local Spaces replicate resolves from
neither copy (see
[Where a replicated log lives](#where-a-replicated-log-lives)). Two
registrations on one local Space may overlap. The check is not atomic with the
write, so two concurrent registrations can both pass, and the resolver then
refuses the DID.

## Guards on Delete Replica and Update Space

Delete Replica is refused with the same `replica-refused` (409) while the
registration is the only one that maps a local Space's `did:webvh` controller to
a copy of its log. Removing it would leave that Space with no resolvable
controller, and both repairs, a new registration and Update Space, are
authorized by the controller. The handler scans every stored Space for such a
controller. The caller changes that Space's controller first. To pause the loop
or replace the pull capability, the caller `PUT`s the registration instead of
removing it, the pause under the controller's own capability. A removal that
ends a two-Space mapping is allowed. A keystore controller is not checked.

Delete Space and Delete Collection are refused the same way when they would take
the only copy a local Space's controller resolves from. Delete Space is not
refused for the Space's own controller, which goes with it, so a Space that
keeps the copy of its own controller's log can always be deleted. Delete
Collection is refused for it, since that Space stays and would have no
controller. A Space with no registrations is not checked, so a self-hosted log
goes away with its Collection or Space as before.

Update Space is refused with the same `replica-refused` (409, pointer
`#/controller`) when the controller change would break a mapping. A registration
that lists its Collections always pulls the one holding its Space's controller
log, so a controller change moves what the Space's own registrations pull. It
touches at most two peer Collections: the one hosting the new controller's log,
which the change may add to a selection, and the one hosting the current
controller's log, which it may remove.

- An added Collection that another local Space's registration of the same peer
  Space already pulls is refused, since the DID would then resolve from neither
  copy and the new controller could not invoke to undo the change.
- A removed Collection the Space was the one holder of is refused while some
  local Space's controller is a `did:webvh` hosted there, since that Space would
  be left with no resolvable controller, the lockout Delete Replica refuses. A
  demotion back to a `did:key` is such a change.

The caller changes that Space's controller first, or registers the log's
Collection on this Space by name, which holds it whatever the controller.
`controllerChangeConflict` in `lib/webvhLogLocation.ts` decides both cases, and
shares the second with Delete Replica, Delete Space and Delete Collection. These
checks read the stored registrations and the other Spaces' controllers afresh,
past the caches, so a controller another process wrote a moment ago counts. A
Space with no registrations is not checked. None of the checks is atomic with
its write.

## Where a replicated log lives

`src/lib/webvhLogLocation.ts` decides where this server stores the history log
of a `did:webvh`. A self-hosted DID's log is the one the DID names. A DID hosted
in a Space on a replication peer, `did:webvh:<scid>:<H>:space:<S>:<C>`, has a
local copy when exactly one local Space X holds a replica registration whose
`fromSpace` is `https://H/space/S/` and which pulls Collection C. The log is
then X's `C/did.jsonl`, and X need not be S. `locateWebvhLog` makes the mapping,
and the resolver reads that log through the same verify, cache, head-record and
fast-forward path as a native one (see
[webvh-controllers.md](webvh-controllers.md)).

The mapping goes through the registration because a local Space named S could
belong to anyone on this server. A registration passes the controller check in
`sync/registration.ts`, so only the peer Space's controller, a current
invocation key of its `did:webvh` document, or a holder of a one-link pull
capability that controller's document admits, can make one. When two or more
local Spaces map one DID, it has no location and does not resolve from storage.
An older copy could list a retired key, and the head record is lost on restart,
so picking either copy would let the older one win.

The registrations are read through an index of every stored registration, cached
per backend for `REPLICA_INDEX_CACHE_TTL`. Storing or removing a registration
drops it, and so does Delete Space. The head record of a replicated DID is keyed
by the DID alone, so it survives a change of the local Space that keeps the
copy. The apply path's write of a `did.jsonl` drops the cached document, so a
key retired at the origin stops authorizing after the next pull.

Such a DID may be a Space controller, a keystore controller, a delegator, and
the `createdBy` of a write. `lib/serverIdentity.ts`, `lib/syncIdentity.ts` and
import provenance stay native-only. `invokerDid` (`createdBy`) also records a
DID resolved over the network, since the authorization that ran before decided
its key. A create the provisioning policy granted verifies no signature, so it
records no `createdBy`.

## The apply path

`src/lib/replicaApply.ts` holds the rules the apply path stores a replicated
record by. A storage backend's `apply*` methods take a record a pull loop read
from a peer and store it under the peer's write stamp and generation, so the
record's `ETag` here equals the peer's. No request route reaches them. The one
other caller is the policy copy a server backend other than the control plane
keeps (`src/lib/backendMirror.ts`), which hands `applyPolicy` the stamp and
generation the control plane's own write minted, with no registration. Both
backends decide through this module. The write stamp and the clock are described
in [validators-and-stamps.md](validators-and-stamps.md).

A record is applied when its stamp sorts above the held one by
`(ms, counter, originId)`, and skipped otherwise. An equal stamp is a record
this server already holds, which is also what stops a record from travelling
round a two-way pair. Three records follow other rules:

- A history log (a Collection's governing log, or a `did.jsonl`) fast-forwards:
  the held bytes must be a prefix of the received ones, a prefix of the held
  bytes is skipped, and anything else is a fork.
- A Collection tombstone carries no generation. It removes any life of the
  Collection created before its stamp, with its members, whatever their stamps,
  so a delete wins over a later member write.
- Two lives of one Collection id are ordered by their creating stamps (see the
  Creating stamp entry in the [ARCHITECTURE.md](../ARCHITECTURE.md) glossary). A
  received life created after the held one replaces it, members included, and
  one created before it is skipped.

An update of a held life replaces the object except for the members that are
immutable once set (`encryption`, `revisions.resolution`, `revisions.immutable`,
and `backend`, which keeps the held selection). One the received object omits is
kept, and two different set values are a fork. An `encryption` descriptor the
received object carries and the held one lacks is a fork as well, since only the
write that creates a Collection declares it. An absent `revisions.resolution` or
`revisions.immutable` stands for its default. A received value other than the
default over a held object that lacks the member is a fork, and a restated
default is taken.

Each apply method runs inside the critical section the matching request-layer
write takes, and checks there, in order:

1. The registration is still stored and was made for the Space's current
   generation, else `unregistered`.
2. The backend's clock takes the received stamps in, else `refused` with reason
   `clock-bound`.
3. The record's Collection is live, else `skipped`.

An applied record takes a local feed position, so it appears in this server's
own `changes` feed and a third server can pull it from here (see
[changes-feed.md](changes-feed.md)). A chunked Resource takes its position once
its chunk set is complete. Preconditions, the encrypted-Collection envelope
rule, the write-once rule and the unique-attribute claims are not evaluated,
since the origin server admitted the write. Quotas and the upload cap are. The
Space Metadata object replicates its `name` alone: `controller`, `type` and the
server-derived members stay per server. Revocations, backend registrations and
keystores are not replicated. Chunks replicate with their parent Resource. A
chunk-only write on the source server takes no feed position, so it replicates
with the next write of the parent.

### Chunks

A chunked Resource is applied with its chunk set. The rules are:

- The loop discovers the set when the parent's feed document applies. It reads
  the parent's chunk listing on the source server, then reads each listed chunk
  an earlier run did not stage under the `etag` the listing names, a few at once
  (`REPLICA_CHUNK_PULL_CONCURRENCY`), then reads the parent last as a closing
  check. The parent's `ETag` must still equal the one the feed document named,
  else the pull is run again next cycle. A chunk-only delete on the source
  server during the pull is not caught by that check: it converges on the next
  write of the parent, as any chunk delete does.
- The listing is untrusted input. Each `index` must be an integer in range,
  strictly ascending and unique. Each `size` must be a non-negative integer.
  Each `contentType` must be an ASCII media type of at most 128 characters. Each
  `etag` must be a string. A listing that fails stalls the Collection as
  `source-unavailable`. So does a feed document whose `etag` is not printable
  ASCII of at most 160 characters, since that `ETag` keys the staging. A chunk
  read the source server answers without an `ETag` is retried next cycle.
- The chunks are staged, and nothing live changes until the set is whole. The
  backend's `beginChunkStaging` opens the run once per chunk pull: it drops the
  registration's staging of the Resource under any other revision, makes the
  quota pre-check of the set, and reports what the run already holds, with the
  source server's `ETag` for each. On the filesystem backend it first finishes a
  swap of the Resource a fault left torn, which changes the live set before the
  pre-check answers; a Postgres swap is one transaction, so there is none to
  finish. `stageChunk` writes one chunk to staging. Then `applyResource` with
  `chunks` takes the parent and its set in one critical section. It removes the
  live indexes the source server no longer lists, moves the staged chunks into
  place, writes the parent and takes its feed position. `reclaimStaging` removes
  staging nobody owns, and `listStagedChunks` is a plain read of a run.
- The quota pre-check is the backend's. Each listed size is checked against the
  upload cap, and the set's net growth (the listed sizes, less what the run
  already staged, less the live chunks the swap frees) against the remaining
  capacity. The filesystem backend reads the remaining capacity from the same
  cached measurement its in-write check reads (and reads none under no quota). A
  set that does not fit stalls the Collection as `quota-exceeded` with nothing
  staged. A 507 or 413 during staging stays authoritative. While a run is open,
  each `stageChunk` credits the live chunks at the indexes the run has staged so
  far, so a same-size rewrite of a stream fits under a quota its live set
  already fills. A chunk directory left beside a tombstone is credited too,
  since the swap removes it. A swap refused as `container-refused` releases the
  run's staging, as a loss does.
- There is no last-writer-wins per chunk. The set resolves with its parent
  revision. The loop decides it before reading anything from the source server,
  against the held content record, a tombstone included. When the held parent
  wins or is equal, the staging is discarded and the set stays as it is.
- A chunk carries this server's own stamp and generation, minted at the swap.
  The source server's chunk `ETag` is opaque here. It is kept with what a run
  staged and nothing else: a re-run keeps a staged chunk the listing still names
  under the same `etag` and reads every other one, with no request for the kept
  ones. A live chunk's validator is this server's own, which no listing names,
  so a parent rewritten on the source server with its chunks untouched
  re-transfers them.
- An individual chunk delete does not replicate on its own. It converges on the
  next write of the parent, when the chunk pull removes the index the source
  server no longer lists.
- A Resource with no chunks costs one listing read.
- The chunk pull runs only when the registration's `pullsChunks` is true. The
  flag is read from the source server's `/service` once, when the registration
  is made, and stored with it rather than read again each cycle: the
  registration check already reads that document, a server that drops the
  profile after registration is not a case worth one more request per cycle per
  registration, and making the registration again covers it.

## Where a replicated Collection lands

A Collection's `backend.id` keeps its meaning across servers. `default` selects
this server's default through its alias, and a fixed id (`fs`, `postgres`)
selects this deployment's backend of that id, as it does for a request. The
control plane, which `WAS_CONTROL_PLANE_BACKEND` names, holds the registrations
and every container object whatever the Collection selects. The stored copy of
the Collection Metadata object carries the peer's `backend.id` verbatim, so the
object stays the same on every server, and a replicated update keeps the held
selection, as `backend-immutable` does for a request.

The pull loop writes through the control plane (the mirroring wrapper, see
`lib/backendMirror.ts`), so an applied Collection Metadata object, governing log
or policy of a Collection on another server backend reaches that backend's copy,
and an applied tombstone removes it. The Resource documents of the feed are
applied to the backend the stored `backend.id` selects, content and `/meta`
record alike. Before the first Resource of a cycle the loop brings that
backend's copy of the Collection level, since a backend holding no copy skips
every Resource of the Collection and the checkpoint would pass them by.

Registrations live on the control plane, so a Resource apply into another server
backend cannot read one. The loop checks the registration on the control plane
first, by the rule the apply uses. The registration must be stored, and made
under the Space Metadata object's current generation. One verdict covers the
Resource documents of a feed page. The apply then runs under no `replicaId`, the
way a policy copy is written. That backend still requires its copy of the Space
and a live copy of the Collection. The copy write before the first Resource is a
step of the pull, so a refusal there (the quota, a Space gone) stalls this
Collection alone. A registration removed between the check and the write is the
window a Delete Replica already has against an apply on the control plane, whose
lock it does not take.

A page read of the feed is bounded by the upload cap of the backend the Resource
is applied to, so a document the data backend would refuse as too large stalls
the Collection before its body is buffered.

A replicated `did.jsonl` lands on that backend with the rest of its Collection.
The `did:webvh` resolver reads a log from the backend its Collection selects, so
a peer-hosted DID whose log Collection names `postgres` resolves here once its
log is applied there.

## The pull loop

`sync/replication.ts` is the `ReplicationManager`, one per app, decorated as
`replication`. It runs one pull loop per stored registration that is not paused,
started at `onReady` and on registration. A cycle begins by reading the
registration, so it uses the pull capability a `PUT` stored since the last
cycle. A registration that is gone ends its loop. A paused one ends it too, and
drops `nextPullAt` and the failure count from the loop state, so the status
reports no cycle that will not run and a resume carries no backoff over. `wake`
schedules a cycle at once, and starts the loop of a registration that has none.
A `PUT` calls it after a pause, a resume, a capability replacement, or a create.
A cycle in flight is left to finish, and its successor is then due at once
rather than at the interval or the backoff. A cycle that ends its loop instead,
on reading a paused or absent registration, starts a fresh loop when a `wake`
landed while it ran, so a resume that races the paused registration's last cycle
is not lost. The status `state` is `pulling` while a cycle is in flight, else
`paused` for a paused registration, else `backing-off`, `stalled` or `idle`. A
cycle reads the peer Space's Metadata object and policy (conditional reads),
then its Collection listing under `?include=deleted`.

The registration's `collections` list selects among the listed Collections, live
and tombstoned, and the Collection that holds the controller's history log is
always selected. That Collection is pulled first in every cycle, so a retired
key stops authorizing here even while a long chunk pull is waiting. The rule is
`peerCollectionSelector` in `sync/collectionSelection.ts`, which the pull loop
shares with `lib/webvhLogLocation.ts`, so the two cannot drift. A selected
tombstone is applied. One for a Collection the registration does not pull is
ignored, so it cannot remove a local Collection that shares its id.

For each selected live Collection the loop applies the Collection Metadata
object when this server does not hold that life of the Collection, then reads
its `changes` feed from the stored checkpoint and applies each document by
`kind`. A Resource's content is read by `GET`, or taken from the document's
inline `data`, and its `/meta` object is read for the members the content write
set. An `ETag` that no longer equals the one the feed named means the record
moved, and the Collection is read again next cycle. The checkpoint advances past
a document once it is applied or skipped.

A chunk pull checks the stop signal between chunks, so a shutdown does not wait
for a whole stream. The registration is checked once per chunk set, before the
run is opened; on the control plane each staging and the swap check it again
under the lock, and on another server backend the swap meets a Space gone. The
loop persists its state inside a Collection's pull once the chunk pulls since
the last persist moved `REPLICA_STATE_PERSIST_BYTES` or ran for
`REPLICA_STATE_PERSIST_DOCUMENTS` Resources, and at the end of each Collection,
so a long pull that is cut by a restart loses at most that much of its
checkpoint, without a write of the state after every small chunked Resource.

Staging is keyed by the registration and the parent revision's `ETag`. A pull
that is run again within one process life moves only the chunks that are
missing. Opening a run reclaims the registration's staging of the Resource under
any other revision before the quota check, since those bytes still count toward
usage. All staging is reclaimed at boot, and a swap that was cut short is
finished first. The next chunk pull stages again what the restart removed.
Delete Replica, Delete Resource, Delete Collection and Delete Space reclaim the
staging in their scope. Delete Replica does so even when the registration is
already gone. See [filesystem-layout.md](filesystem-layout.md) for the staging
layout.

A feed page too large to buffer is asked for again at half the size, down to one
document, which is read up to the upload cap. A binary Resource's read times out
on the wait for the response and for each chunk, so a long transfer is not cut
off.

## Stalls and backoff

A `refused` apply stalls that Collection alone. The checkpoint holds and the
reason (`clock-bound`, `fork`, `quota-exceeded`, `unsupported-backend`,
`container-refused`, `chunk-listing-obsolete`, `source-unavailable`) is stored
with the loop state, which `GET .../replicas/:replicaId/status` serves beside
the loop `state` and the pull times. The Collection is retried each cycle while
the others go on, and a clock-bound stall clears itself as local time catches
up. A Collection whose `backend.id` selects no server backend of this deployment
stalls as `unsupported-backend`, before its Metadata object is stored: a fixed
id this deployment does not configure, or a backend registered on the peer. The
stall detail reads: The Collection selects backend "<id>", which is not a server
backend this deployment configures. The stall clears once the deployment
configures that backend. See
[Where a replicated Collection lands](#where-a-replicated-collection-lands).

Two reasons come from the chunk pull. `chunk-listing-obsolete` means the source
server rewrites the Resource faster than the pull completes, so the closing
check fails cycle after cycle. `source-unavailable` means a request to the
source server keeps failing inside a chunk pull, or its chunk listing is
malformed. The detail names the URL. Both follow a bounded retry. A pull that
cannot complete holds the checkpoint, and the Collection stays `syncing`. After
`REPLICA_CHUNK_PULL_RETRY_LIMIT` consecutive cycles stuck on one feed document,
counted in memory and so restarted by a restart, the Collection stalls. The
stall clears on the first chunk pull that passes. A request that fails inside a
chunk pull stalls that Collection rather than ending the cycle. A reader of the
status treats a reason it does not recognize as stalled for an unrecognized
reason.

A request to the peer that fails outside a chunk pull, a 404 for the Space
included, ends the cycle. The loop then backs off, doubling its delay up to a
limit, and logs one `warn` when the failures begin. Only the removal of its
registration or a pause stops a loop. The manager stops every loop in the same
`onClose` hook that closes the backend, ahead of it.

## Transport

`sync/peerFetch.ts` is the transport. `fromSpace` is a URL the controller
supplies, so every request to it is bound as the peer log fetch is (see
`lib/peerWebvh.ts` in [webvh-controllers.md](webvh-controllers.md)): `https`
only, the default port, no redirect followed, and a connection only to the
public addresses checked after DNS. The plugin's `peerFetch` option replaces it
in tests.

The feed has a read-only form for the loop,
`GET /space/:spaceId/:collectionId/query?profile=changes`, with `checkpoint` and
`limit` in the query string, verified under the `GET` action. The `POST` form
needs a `POST` capability, which a pull capability does not carry.
