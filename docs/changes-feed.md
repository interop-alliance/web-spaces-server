# The Changes Feed

How the `changes` query profile orders its feed: the feed position each write
takes, the documents the feed holds, how both backends store the counter, and
the wire checkpoint. The layer map and the glossary live in
[ARCHITECTURE.md](../ARCHITECTURE.md). The checkpoint code is
`src/lib/changesCheckpoint.ts`.

## Feed positions

The feed is ordered by a per-Collection feed position, a positive integer
sequence. In the glossary's terms, a feed position is a record's place in its
Collection's `changes` feed.

Every Resource-level write takes the next one: a content write, a metadata
write, a soft delete, and a Resource written by an import. It does so whatever
the Resource's content type.

A Collection Metadata write takes one too, the create included. So does a
governed-log write, the guarded create and each append. A log write takes no
position for the Metadata object, whose local segment it advances. A
byte-identical log write takes none. See
[governed-logs-and-revisions.md](governed-logs-and-revisions.md) and
[validators-and-stamps.md](validators-and-stamps.md) for the log and the local
segment.

A Collection's own policy and each Resource policy take one with every write and
every delete, which leaves a tombstone. A Space policy takes none, since it is
in no Collection. A chunk write takes none, so it never moves its parent. A
replicating server discovers a chunk set by reading the parent's chunk listing
when the parent's own feed document is applied, not from the feed (see
[replication.md](replication.md)).

The position is assigned inside the per-Collection critical section that makes
the write visible, so no write lands at or before a position a reader was
already handed.

The write stamp each feed document carries orders two revisions of one Resource,
not the feed. `updatedAt` alone has no ordering role, since two writes can share
a millisecond. See [validators-and-stamps.md](validators-and-stamps.md) for the
write stamp.

## Feed documents

The feed holds one document per record, at the position of its latest write.
Each document carries a `kind`. A consumer skips a `kind` it does not know.

- A `resource` document is a Resource or its tombstone, with its `contentType`,
  and its body inline as `data` when it is a live JSON Resource.
- A `collection-metadata` document is the Collection Metadata object.
- A `log` document is the Collection's governing history log.
- A `policy` document is the Collection's own policy or a Resource's.

None of the last three has an id of its own, so its `id` is the record's
absolute URL (`.../meta`, `.../meta/log`, `.../policy`), and it carries no body.

Every document carries the record's write stamp, its `generation`, and its
`etag`, so a puller can decide whether to apply a change from the feed alone. A
`resource` document also carries the `/meta` record's stamp and generation under
`meta`, once metadata was written. A `/meta` write moves the document to a new
position with a new `meta` stamp, and its top-level stamp and `etag` stay the
content record's.

A `resource` document carries the Resource's `createdBy` when one was recorded.
It is the array of DIDs the creating write was delegated through, the same value
a `GET` of the Resource's `/meta` serves, and a tombstone's document keeps it. A
`/meta` write or a content write by another invoker does not change it. The
other three kinds carry no `createdBy`, since they carry no body. A puller reads
a Collection's own list from its Metadata object, and the same shape rule
applies to it. The pull loop stores a document's `createdBy` only when it is a
non-empty array of DID strings, and stores the Resource without one otherwise.
How the list is derived is in
[validators-and-stamps.md](validators-and-stamps.md) under "Write responses".

A Collection on a server backend other than the control plane is fed from that
backend, which holds copies of its Metadata object, its governing log and its
policies. Each copy is written after the control-plane write, so the write takes
a position in that backend's feed and the feed stays one sequence. Every
document's `etag` is the one a GET of the record answers. A `policy` copy is
written through the backend's `applyPolicy` under the control plane's own
generation and stamp, so its document is served as is; the stamp comparison
there orders two copies of one record however they land, and a tombstone copy
lands over an absent copy. A `collection-metadata` or `log` copy carries the
backend's own stamp, and its document takes the control plane's stamp and
validator when the page is served (`restampFeedFromControlPlane` in
`src/lib/backendMirror.ts`, one read of each record per page). A copy whose
record the control plane no longer holds keeps the copy's stamp.

A tombstone is marked `deleted: true`. A Collection's own tombstone is not in
the feed, since the feed goes with the Collection.

## Storage of the counter

A position is one server's fact about its own feed. Export strips it and import
assigns fresh ones. An imported Resource with no archived metadata gets fresh
metadata, so it takes a position too. See [export-import.md](export-import.md).

### Filesystem backend

The filesystem backend keeps the counter in `.feed.<collectionId>.json` in the
Collection dir and stamps the position on the Resource's sidecar as
`feedPosition`. Both happen under a `feed:` key nested inside the per-Resource
lock. See [filesystem-layout.md](filesystem-layout.md) for the sidecar.

The counter file is `{ generation, position, records }`. Its `records` map holds
the latest position of the Collection Metadata object (key
`collection-metadata`) and of the log (key `log`), each absent until that record
took one.

A Collection's own policy and each Resource policy carry their position in the
policy file, as a reserved `_feedPosition` member written last, beside
`_generation`, in the same `feed:` section after the counter advances. A Space
policy takes none. The counter file's size does not depend on how many policies
the Collection holds.

`changesSince` reads the counter under that key and admits only positions at or
below it. A caught-up poll reads the counter file alone. Any other poll lists
the Collection dir and reads every policy file in it outside the key, admitting
the positions past the reader's. A policy file that does not parse is logged at
`warn` and left out.

### Postgres backend

The Postgres backend increments `collections.feed_position` with
`UPDATE ... RETURNING`, whose row lock is held to commit, so positions are
commit-ordered. It stamps `resources.feed_position` in the same transaction. A
policy's position is kept in `policies.feed_position`.

### The counter's generation

The counter has a generation, minted with the first position it hands out and
kept for the Collection's life (`generation` in the counter file,
`collections.feed_generation` in Postgres). It goes with the Collection, so a
Collection re-created under the same id, by hand or by an import, restarts at 1
under a fresh one. An import keeps the archived Collection Metadata generation,
so that one cannot tell the two lives apart.

## The checkpoint

On the wire the checkpoint is an opaque string, which a client compares by
equality only and echoes back verbatim. This server encodes it as
`base64urlnopad(JSON.stringify({ feed, generation, position }))`. Here `feed` is
the Collection's absolute trailing-slash URL and `generation` is the feed
counter's. A checkpoint is therefore scoped to the server, the Collection, and
the life of its feed that issued it.

Each feed document carries the checkpoint that resumes right after it, and the
page's `checkpoint` is its last document's.

A checkpoint this server did not issue for the Collection is
`invalid-request-body` (400) at `#/checkpoint`. So is one issued for the
Collection before it was deleted and re-created, since reading its position into
the new feed would skip every write at or below it. The handler learns the
current generation from the backend's page (`feedGeneration`), so the position
goes to the backend first and the generation is compared afterward.

A pull loop reads the feed from a stored checkpoint. See
[replication.md](replication.md).
