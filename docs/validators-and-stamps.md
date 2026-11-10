# Validators, Write Stamps and Preconditions

How the server versions a record and decides what a write answers. This covers
the write stamp and its clock (`src/lib/hlc.ts`), the `ETag` validators and
conditional requests (`src/lib/etag.ts`, `src/lib/preconditions.ts`,
`src/lib/metadataValidator.ts`), access-control policies as versioned records
(`src/lib/policyRecord.ts`), and the status and body of a write's response.
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the glossary.

## The write stamp

Each storage backend holds one hybrid logical clock for its store, and a
versioned write mints its stamp with it inside the write's critical section. The
stamp is the clock reading plus the store's origin id, carried as `updatedAt`
(the ISO string of the reading's milliseconds), `updatedAtCounter`, and
`originId`. Stamps are ordered by `(ms, counter, originId)`, the first two
numerically and the origin id by plain string comparison.

The clock reading never runs below the largest physical time or stamp the clock
has seen. Within one millisecond the counter ticks, and it restarts at 0 when
the millisecond advances. A write over a stored record first raises the clock to
that record's stamp, so the mint is `max(now, held stamp + one counter tick)`.
The new stamp therefore sorts above the one it replaces, even when physical time
stepped back or the process restarted. The physical clock is injectable (a
`physicalClock` option), so a test can freeze or step it.

A chunk's stamp is local and orders nothing across servers. A replicated chunk
does not carry the source server's stamp: the replica server mints a stamp and a
generation for each chunk it stores, from its own clock, as it does for a chunk
a client writes, and the chunk set follows its parent revision (see
[replication.md](replication.md)). A chunk's `ETag` on one server therefore says
nothing about the same index on another. The chunk listing (`GET .../chunks/`)
carries each chunk's `ETag` as the entry's `etag`, the value its own `GET` and
`HEAD` serve and its `GET` answers 304 against, so a client that reaps chunks
can pin each `DELETE` with `If-Match`, or read a chunk conditionally, without a
`HEAD` per chunk.

### High-water mark

The clock persists a high-water mark of its physical part at most about once a
second. It lives in `clockHighWater` in the filesystem `store.json` (see
[filesystem-layout.md](filesystem-layout.md)) and in `store.clock_high_water` in
Postgres. A backend's `close()` persists it once more, so a clean restart starts
above every stamp minted before it. At boot the clock starts one millisecond
past that mark.

The mark can trail the last stamp minted before a crash by up to about a second,
so it is the held-stamp rule that keeps an overwrite above the stamp it
replaces. A failed write of the mark is logged at `warn` and retried at the next
mint. It does not fail the write that minted.

### Receive rule

The clock also has a receive rule for a stamp from a peer. It refuses one dated
more than the clock bound ahead of physical time
(`WAS_REPLICATION_CLOCK_BOUND_MS`, default 60000 ms). No request route receives
a peer's stamp. A peer's stamp enters a store through the apply path alone
(`lib/replicaApply.ts`, see [replication.md](replication.md)), which takes each
one in by that receive rule. Every other stamp comes from the store's own clock:
an import re-stamps every record it writes.

### Single-process assumption

One server process per store is an assumption the stamps rest on. Two processes
over one store would share its origin id and could mint the same stamp for two
different writes, which would give different bytes one strong validator. The
read caches described in [ARCHITECTURE.md](../ARCHITECTURE.md) rest on the same
assumption.

## The ETag

The `ETag` validators follow the spec sections "Caching" and "Conditional
Requests". A Resource, a chunk, a Resource's `/meta` object, a Collection's
governing history log, an access-control policy at each of its three levels, and
each container's Metadata object (the Space Metadata object, the Collection
Metadata object) carries a generation and the write stamp of its last write.

`formatEtag` emits the two together as one strong `ETag` on GET/HEAD,
`"<generation>.<ms>.<counter>.<originId>"`, where `ms` is the stamp's
`updatedAt` in epoch milliseconds. Every write mints a new stamp, so the
validator moves with every write. A client treats the whole quoted value as
opaque, and `If-Match` and `If-None-Match` compare the whole string.

### Generation

The generation is a random base58 marker minted at the record's first write and
kept for the record's life. A Resource's content record continues through a
tombstone and its re-create, so its generation does too.

A hard delete (a chunk, a Space) removes the record, so the next record under
the same id mints a new generation and its validators never coincide with the
old record's. A chunk's generation is the replica server's own on a replicated
chunk, minted when the chunk set is swapped in, and dies with the chunk. A
client's stale cached `ETag` then matches nothing instead of being answered 304
over different bytes.

Delete Collection leaves a tombstone (see the Collection tombstone entry in the
[ARCHITECTURE.md](../ARCHITECTURE.md) Glossary), which keeps the generation and
takes the delete's stamp. A create over the tombstone mints a new generation,
with the same effect on held validators.

### The Resource `/meta` ETag

The Resource's `/meta` object is a record of its own, with its own stamp and
generation. A `/meta` write mints a stamp on that record only. The content
record's stamp and `ETag` do not change, so the Resource's top-level `updatedAt`
is the time of its last content write. The filesystem sidecar nests both under
its `meta` member, and Postgres keeps them in `meta_` columns.

The `/meta` body serves members of both records, so its `ETag` covers both
(`resourceMetaEtag`). It is the content record's four segments, the Resource's
own `ETag` value, followed by the `/meta` record's four once metadata has been
written:
`"<generation>.<ms>.<counter>.<originId>.<generation>.<ms>.<counter>.<originId>"`.
So it moves with every content write and every `/meta` write, and exists from
the Resource's first write.

A `/meta` `If-Match` is evaluated against this composite, in both backends.
`If-None-Match: *` on a `/meta` write passes only while no `/meta` record
exists. The changes feed's `metaEtag` is the same composite (see
[changes-feed.md](changes-feed.md)).

A soft delete drops that record together with `custom`, so a re-create's first
metadata write starts a fresh generation and a `/meta` `ETag` held from before
the delete cannot pass `If-Match` against it.

## Container Metadata validators

One validator covers a container's whole Metadata object. A Collection's
configuration write (`backend`, `encryption`, `generator`) and its annotation
write (`custom`, `epoch`) each mint the object's stamp. A container's Metadata
object appends a fifth segment, its local segment:
`"<generation>.<ms>.<counter>.<originId>.<local>"`.

Storage exposes one validator per container through `writeSpace` /
`getSpaceMetadata` and `writeCollection` / `getCollectionMetadata`, as the
out-of-band `metaGeneration` / `metaLocal` beside the stamp members of the body.

### The local segment

Some changes move a Metadata object's served representation without a write of
the object. A backend registered or deregistered on a Space changes the Space
Metadata object's served `backends` member. A governed-log write changes the
Collection Metadata object's derived `encryption` member (see
[governed-logs-and-revisions.md](governed-logs-and-revisions.md)).

A strong validator must move with the representation, so each of these advances
the object's local segment and keeps its generation and stamp, under the same
lock as a Metadata write. A stamp would replicate as a write of the object,
while the local segment is this server's own. The next stamped write resets it
to 0.

### Storage of the segments

The generation and local segment are embedded in the stored record as reserved
`_generation` / `_local` members. The filesystem backend keeps one file per
container (`.space.meta.<id>.json`, `.collection.meta.<id>.json`) holding the
wire body and the two together. Postgres keeps them as `meta_generation` /
`meta_local` columns on the `spaces` and `collections` rows, kept out of the
wire body. The stamp members are wire members and are stored in the body.

An export archive's Metadata entry carries `_generation` alone, since the local
segment does not leave this server (see [export-import.md](export-import.md)).
The `ETag` is emitted on Read Space / Read Collection and on the Create/Update
responses. The Metadata-object pieces (the five-segment `ETag` and the reserved
`_generation` / `_local` file members) live in `src/lib/metadataValidator.ts`.

### Serialization of Metadata writes

A Space Metadata write is serialized per Space (the `spacemeta:` lock in the
filesystem backend, an advisory lock plus row lock in Postgres). A Collection
Metadata write is serialized per Collection (the `cmeta:` lock). The check and
the stamp are therefore atomic.

## Preconditions on writes

Writes are gated by `If-Match` / `If-None-Match: *`, which
`parseWritePreconditions` normalizes and the backends evaluate atomically with
the write through `preconditions.ts`. The client's own preconditions go to the
backend as sent, so a 412 answers only a header the client sent.

The Space and Collection Metadata objects take both headers. The
`If-None-Match: *` guarded create is what resolves two clients provisioning the
same Space or Collection at once. The loser's replace-semantics `PUT` would
otherwise rewrite the winner's `type` array or `backend`. It refuses whenever
the container already has a Metadata object, `ETag` or not.

### Update Space

Update Space (`PUT /space/:spaceId/meta`) chooses its authorization from an
unlocked read. Its write therefore passes `writeSpace` an `assertTransition`
hook that pins it to that read. The Space must still be absent on a create, and
carry the same validator on an update.

On a mismatch the handler re-reads and re-authorizes on the branch the fresh
read selects. A create that lost a race is then authorized as an update against
the winner's controller. After three attempts it answers 503 with `Retry-After`.

## Conditional reads

A GET/HEAD carrying `If-None-Match` is parsed by `parseIfNoneMatch` into the set
of validators the client holds (RFC 9110 weak comparison, list and `*` forms). A
handler answers 304 Not Modified with the `ETag` and no body when that set
covers the current one (`isNotModified`, sent by the shared
`requests/notModified.ts` helper).

The decision sits in each read handler, after authorization, so an
under-authorized conditional read still gets the 404 mask. A Resource or chunk
GET consults the stored metadata first when the header is present and opens the
byte stream only on a miss.

A representation with no validator (a Resource whose sidecar carries no stamp,
and so its `/meta` object) is matched only by `*`, which RFC 9110 makes true for
any current representation. Its 304 then carries no `ETag`, as its 200 would
not.

A Collection Metadata read takes the object and the governing log together, or
else the object before the log, never the log first. A log append advances the
object's local segment, so a read in the other order could serve the new `ETag`
over the old descriptors, and a 304 would then keep them. The Postgres backend
reads both in one statement (`getCollectionMetadataAndLog`), so an append is in
both or in neither. A backend without that method is read in two steps, the
object first, where the worst case is the old `ETag` over the new descriptors,
which the next revalidation replaces.

### Caching headers

Responses to non-idempotent POSTs are marked `Cache-Control: no-store` by an
`onSend` hook in `routes.ts`. A slash-variant redirect and a POST route
registered with `config.safe` (Query and Export, reads that use POST to carry a
body) stay cacheable. The spec defers further `Cache-Control` semantics.

## Write responses

A write answers from what the backend returns, not from a read made after it.
`writeResource` and `writeResourceMetadata` return the validator beside the
server-managed members as the write left them. `writeResourceMetadata` also
returns the content record's validator, for the `/meta` `ETag`. The filesystem
backend reads them under the per-Resource lock, and Postgres takes them from the
writing statement's `RETURNING`.

### Resources

Create or Update Resource (`PUT /space/:s/:c/:id`) answers `201` when the write
created the Resource, a write over a tombstone included, and `200` when it
updated a live one. A write-once repeat updates nothing, but the Resource is
live, so it answers `200` with the stored members. A write-once repeat over a
tombstone answers `200` too, with the tombstone's `ETag`, its media type and a
`size` of 0; the Resource stays deleted. Update Resource Metadata
(`PUT .../:id/meta`) answers `200` and never creates. A `/meta` write to an
absent Resource is a 404.

Both keep the `ETag` header and send a JSON body that holds only server-managed
members: `contentType`, `size`, and the content record's write stamp
(`updatedAt`, `updatedAtCounter`, `originId`). A `201` adds `createdAt` and
`createdBy`, so a writer learns no provenance it did not record. A `/meta` write
adds the nested `meta` stamp and generation. The body does not carry `custom`,
`epoch`, or `writerId`.

A Resource created over a tombstone records fresh provenance: this write's
invoker as `createdBy` and its stamp's time as `createdAt`. The tombstone's
values stay with the deleted Resource.

Create Resource (`POST`), a chunk `PUT`, Delete Resource, and the governing log
`PUT` keep their own answers. The `did.jsonl` write shares the Resource `PUT`
handler and answers the same way.

### Containers

Container writes follow the same rule. `writeSpace` and `writeCollection` return
the validator, whether the write created the container, and the stored object as
the write stamped it. Create Space, Create Collection, and the create-by-`PUT`
of a container's `meta` send that object through the read projection, and choose
`201` or `204` from the backend's answer.

Update Collection composes the object it stores inside the backend's write, from
the stored object the backend reads under the lock, so the members a full
replacement carries forward when the body omits them (`plaintext`, `backend`,
`generator`, a governed `revisions`) come from the record the write replaces.
Composed from a read made before the lock, a rename racing a `unique` index
declaration would store the object that read saw and drop the declaration, with
a `204` to both writers. The descriptor checks run in the same callback against
the same record. Since the backend evaluates `If-Match` and `If-None-Match`
before it runs the callback, a stale validator answers `412` ahead of any
refusal the body earns, such as an unknown `backend` (`409`) or a `plaintext`
beside an existing `encryption` (`400`).

A body that declares a `unique` index also runs its scan of the stored Resources
in that callback. A Collection Metadata write runs with no Resource write of the
Space in flight, so the scan and the write see every stored Resource and none
that is still landing. Postgres gets this from the Space row lock every Resource
write takes. The filesystem backend runs the write on the exclusive side of its
Space gate, as a container removal does. The gate admits a Resource write ahead
of a waiting exclusive write, so a Metadata write is delayed while writes to the
Space keep overlapping, like a removal; that backend is built to be read, not
for throughput. A Resource write reads the Collection's `unique` declarations
under its own lock rather than taking them from the handler, so a declaration
that lands between the handler's read and the write still binds it. A registered
external backend's adapter never receives the Collection Metadata object and its
writes do not pass through this server's lock, so a `unique` declaration on a
Collection stored there cannot be enforced; the declaration is refused
(`unsupported-backend`, 409). A Collection's `backend` is set at creation and
cannot move: an Update Collection body naming a backend other than the stored
one is refused (`backend-immutable`, 409, pointer `#/backend`), while one naming
the same backend under another of its ids (`default` for the backend it aliases)
is stored as sent.

Two unconditional `PUT`s of one new Collection's `meta` can both see it absent
before their writes, but only the first write creates it, and the second answers
`204`. Update Space pins its write to its pre-read (`assertTransition`), and
Create Space is a guarded create, so their create decision already matched the
backend's.

## Policies as versioned records

Access-control policies are versioned records at all three levels (Space,
Collection, Resource). The code lives in `src/lib/policyRecord.ts`. A stored
policy carries the write stamp of its last write and a generation. Get Policy
serves the stamp members (`updatedAt`, `updatedAtCounter`, `originId`) beside
the body and the four-segment `ETag`, and answers a conditional read 304. The
generation is in the `ETag` only. A `PUT` body's stamp members, `deleted` and
`_generation` are not stored.

### Writes

`PUT` and `DELETE` take `If-Match` / `If-None-Match: *`, evaluated by the
backend against the live policy under the write's lock (the filesystem `policy:`
key, the Postgres Space row). `PUT` answers 201 or 204 from what the backend
reports.

### Tombstones

Delete Policy leaves a tombstone, `deleted: true` plus the delete's stamp, with
the generation kept and no `type`, and answers 204 with its `ETag`. A delete of
an absent or already deleted policy writes nothing and answers 204 with no
`ETag`.

A tombstone reads as absent everywhere. `getPolicy` answers it as no policy, so
the policy fallback, the policy cache, the listing's `public` flag and the
linkset never see it. Only `getPolicyRecord` returns it, for Get Policy under
`?include=deleted` (capability-only, like every policy read), which answers it
200 with its `ETag`, and for the changes feed (see
[changes-feed.md](changes-feed.md)). A plain Get Policy answers it with the same
404 as no policy. A `PUT` over a tombstone is a create: 201, a new generation,
and a stamp above the tombstone's.

### Storage

The filesystem backend stores a policy file as the served body with
`_generation` embedded, and for a Collection or Resource policy the server-local
`_feedPosition` as well. A `PUT` body's `_feedPosition` is not stored, and no
read of a policy carries it, `getPolicy` and the policy cache included. Postgres
keeps the body in `policies.policy` (NULL on a tombstone) and the stamp,
generation and `deleted` mark in columns.

### Export and import

Export carries live policies only, as stored, with `_generation` but without
`_feedPosition`. Import drops an archived `_feedPosition` and assigns a fresh
position. It keeps the archived generation, re-stamps with the importing store's
clock, and skips a level where the destination holds any policy record, a
tombstone included, so an import does not undo a delete. An archived tombstone
refuses the import as `invalid-import` (400). See
[export-import.md](export-import.md).

### Deletes that remove policies

Delete Collection and Delete Space remove their policies outright. Delete
Resource tombstones the Resource's policy, inside the delete's critical section,
with its own stamp and the feed position after the Resource tombstone's. So a
`PublicCanRead` written to publish one record does not publish whatever next
occupies its id, and the policy delete replicates and survives an import.

A Resource-level policy write is refused with the Resource's 404 while the
Resource is absent or a tombstone, checked under the same lock, so a policy
cannot be seeded for an id before it is written. A Collection stored on a
registered external backend keeps its Resources outside the primary store, so
that check is skipped there and the policy tombstone is written by the handler
after the data-plane delete, not atomically with it. The apply path and import
write a policy whatever the Resource's state.

The Space listing's `public` flag reports the Collection's own policy only, not
one inherited from the Space.

## Replica registrations as versioned records

A replica registration (see [replication.md](replication.md)) is a versioned
record. Each write, POST or `PUT`, goes through the backend's `writeReplica`,
whose decision is shared by both backends (`decideReplicaWrite` in
`src/lib/replicaRecord.ts`) and made inside the write's critical section from
the registration read there: the create-only conflict, the fixed-member
comparison, the preconditions, the stamp, and `pausedAt` from its presence on
the client's shape. The stamp is minted with the store's clock, and the
generation is minted at the first write and kept for the record's life. The
served record carries the stamp members beside its own, and a value for them in
a write body is ignored. The `ETag` is the four-segment shape. `PUT` takes
`If-Match` / `If-None-Match: *`, evaluated by the backend against the stored
registration atomically with the write, and answers 412 on a miss. Delete
Replica removes the record outright, with no tombstone.

The filesystem backend stores the stamp members in `.replica.<id>.json` itself,
beside `_generation`, `_spaceGeneration` and `_pullsChunks`. Postgres keeps them
in the `updated_at`, `updated_at_counter` and `origin_id` columns of `replicas`,
out of the `record` jsonb. A store that holds an unstamped registration is
refused (see [filesystem-layout.md](filesystem-layout.md)).

A replacement does not change the Space Metadata object's served `replicas`
member, so it does not advance that object's local segment. A create does.
