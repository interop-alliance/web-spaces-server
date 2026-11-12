# Governing History Logs and the Revisions Descriptor

This document covers the `governed-history-logs` feature (a Collection's
governing history log), the `encryption` and `revisions` descriptors derived
from it, the cache that memoizes that derivation, the Collection `revisions`
descriptor with its write-once rule, and the checks Import applies to both.
[ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the glossary.

## The governing log

`src/lib/governedLog.ts` implements the `governed-history-logs` feature: a
Collection's governing history log, served at its own sub-resource
(`GET`/`PUT /space/:spaceId/:collectionId/meta/log`, `CollectionRequest.getLog`
/ `putLog`).

The log is not a Resource. It is absent from listings, exempt from the
encrypted-Collection envelope rule, and left untouched by a `PUT /meta`. The
[changes feed](changes-feed.md) carries it as its own `log` document, apart from
the Resources.

It is served as `text/jsonl` with its own `ETag`, from its generation and write
stamp (see [validators-and-stamps.md](validators-and-stamps.md)), so a
conditional `GET` behaves like any other record. A `PUT` is either a guarded
create (`If-None-Match: *`) or a compare-and-swap append (`If-Match` carrying
the prior bytes verbatim plus one new line), 412 on a lost race.

`GET` is capability-or-policy at the Collection's target. `PUT` is
capability-only, like `/meta`, and carries the same container rule as `/meta`
(see [client-annex-clause.md](client-annex-clause.md)): a direct root
invocation, or a delegated capability whose tail targets exactly the Space's
canonical trailing-slash URL.

## Guarded create

The guarded create is the declaration that puts the Collection under log
governance. It is refused with `encryption-immutable` (409) on a Collection
whose Metadata object already carries a client-written `encryption` member, or a
`plaintext` member. The derived `encryption` and a stored `plaintext` would
exclude each other on every later Metadata write, and `plaintext` has no removal
path.

The guarded create is one of the writes that may declare `encryption`, which is
creation-only (spec "Creation-only members"). The others create the Collection:
Create Collection, and a create by `PUT .../meta`, a create over a Collection
tombstone included. An Update Collection that adds `encryption` to an existing
Collection without one is refused with `encryption-immutable` (409). Under
replication, a late first declaration on one server and a full replacement
without it on another could not be merged.

## Derived descriptors

From then on, the Collection's served `encryption` member is derived from the
log's last line's `state`. It is read by Get Collection and by every handler
that loads the Collection Metadata object through `getCollectionOrThrow`, so the
write-time envelope check sees it too.

A `history: { method, resource }` member is always stamped on. `method` comes
from the genesis line's `parameters.method`, and `resource` is the log's own
URL. The stored Collection Metadata object never carries that derived member. A
direct `encryption` write against it is refused with
`encryption-history-log-governed` (409), and its other fields still update
normally.

The `state` has one reserved slot, `revisions`. It is taken out of the derived
`encryption` member and served as the Collection's `revisions` member instead,
replacing any stored one.

A direct `revisions` write on a governed Collection is checked against the
derived descriptor and is not stored. A body `merge` that differs from the
derived one is refused with `revisions-immutable` (409, pointer
`#/revisions/merge`). Omitting `merge` or restating the derived one passes. The
stored `revisions` member is carried forward untouched by such a write. The
guarded create may move a member off its default, but may not change one the
stored object sets to another value (`revisions-immutable`, 409).

The derivation is memoized per backend by the log's validator (see
[The descriptor cache](#the-descriptor-cache)). Update Collection composes under
the lock, from the log the backend hands its composition callback, so a Metadata
write parses the log at most once.

## Log writes

The server verifies neither proofs nor a hash chain. It checks that the body is
JSON Lines, each line a JSON object with an object `state` member and the last
line the head. It also checks that the genesis line's `parameters` carries a
string `method`, and that no line's `state` carries a `history` member, since
the server stamps that member itself. A break of any of these is
`invalid-request-body` (400).

It also checks that an append fast-forwards the stored log. The body must be the
stored bytes verbatim followed by exactly one new line. A body the stored log is
not a prefix of is `precondition-failed` (412), with or without `If-Match`. A
body adding more than one line is `invalid-request-body` (400).

A body equal to the stored log byte for byte adds no line. Once its
preconditions pass, it is refused with `invalid-request-body` (400) and nothing
is written, so neither the log's `ETag` nor the Collection Metadata object's
moves. Under a stale `If-Match` it stays a 412. A writer that retries after a
dropped response reads the log to learn whether its append landed. A body that
is a strict prefix of the stored log would erase lines and stays a 412. The
`did.jsonl` log of a self-hosted `did:webvh` is an ordinary Resource, and a
re-sent body there stays a no-op.

On every append the server runs the same `encryption` and `revisions` transition
checks against the prior head that an ordinary Collection Metadata update runs.
It also checks the shape of the head's `revisions` slot. The fast-forward rule
keeps the log append-only at the server: a write capability can add history but
not erase it, while a break inside an appended entry stays the verifying
reader's to detect.

A log write mints the log's own stamp. It also advances the Collection Metadata
object's local segment, since the object's served content changed, and leaves
that object's stamp untouched, `updatedAt` included. It is serialized with
Collection Metadata writes through the same per-Collection lock.

## The descriptor cache

`src/lib/governedDescriptorsCache.ts` is a read cache, one per storage backend.
It memoizes the `encryption` and `revisions` descriptors derived from a
log-governed Collection's history log. It saves the parse, since the log is
append-only and grows. On the request path it also saves the read of the log's
body: `getCollectionOrThrow` reads the log's validator with the Metadata object
and reads the body only when no entry is cached under that validator. The
filesystem backend keeps the validator in the log file, so its validator read
still reads the body.

An entry is keyed by Collection and by the log's own four-segment `ETag`, so a
log write leaves the old key behind and the next derivation misses on a new one.
It therefore carries none of the multi-instance staleness that the Space
Metadata and policy caches carry (see [ARCHITECTURE.md](../ARCHITECTURE.md)).

Delete Collection, Delete Space, and Import Space drop entries by prefix.
Entries expire after 600 s and are capped at 1000
(`GOVERNED_DESCRIPTORS_CACHE_TTL`, `GOVERNED_DESCRIPTORS_CACHE_MAX`).

## The revisions descriptor

`src/lib/revisions.ts` holds the Collection `revisions` descriptor: `resolution`
(a closed set, `last-writer-wins` only, which is also the default), `immutable`
(a boolean, default `false`), and `merge` (an object the server stores and
serves verbatim and does not read).

It holds the shape check, which refuses an unknown `resolution` (the reserved
`keep-conflicts` included), a wrong member type, and an unknown member as
`invalid-request-body` (400).

It holds the transition check. `resolution` and `immutable` are declared by the
write that creates the Collection (a Create Collection `POST`, a create by
`PUT .../meta`, or a governing log's guarded create) and are immutable
afterward. An absent member stands for its default, and members are compared by
the value they stand for. Restating a default, or dropping an explicit default,
passes. Setting `immutable: true` on an existing Collection, or dropping or
changing a set `immutable: true`, is refused with `revisions-immutable` (409).
So a full replacement that omits a set `immutable: true` is refused, as one that
omits a set `encryption` is. A governing log's guarded create may move a member
off its default, but may not change one set to another value. `merge` follows
the body.

The module also holds the split of a governing log's `state` into its
`encryption` and `revisions` parts, and the write-once rule.

## The write-once rule

The rule is decided in two ways. A handler that read the Collection as
write-once passes `immutable: true` to the backend. Otherwise it passes a
recheck callback as `immutable` (built by `writeOnceOptions` in
`requests/collectionContext.ts`). Over a live Resource or chunk, the backend
calls it inside the write's critical section with the governing history log it
reads there.

A log's guarded create is the one write that can declare `immutable` on an
existing Collection. In the filesystem backend, a log write that may create the
log runs on the exclusive side of the Space gate, so it cannot land between a
write's log read and its bytes. An append stays on the shared side. In the
Postgres backend, the recheck reads the log under the `collections` row lock a
log write takes. See [filesystem-layout.md](filesystem-layout.md) for the gate.
A Collection on a server backend other than the control plane runs its Resource
writes under that backend's lock, so the server writes the log through to that
backend as a copy after each control-plane write of it
(`src/lib/backendMirror.ts`), and the recheck there reads the copy. If the copy
faults, the request answers a 5xx though the control plane holds the log. The
retry is refused as a re-sent log, and the server runs the copy again before it
answers the refusal. A Resource write that lands between the two commits
committed before the log write was answered.

Inside the critical section, after its preconditions pass, the backend compares
a write over a live Resource or chunk with the stored record. The media type is
compared without its parameters and case-insensitively, so a retry that adds
`; charset=utf-8` is still a repeat. The bytes are compared through the content
digest every record carries (`lib/contentDigest.ts`): the backend digests the
bytes the write would store, a JSON body as the `JSON.stringify` serialization
both backends store, and compares that with the stored `digest`. So a different
key order is a different body, and no stored bytes are read. The filesystem
backend digests a binary body through the upload cap, so an over-cap body
answers `payload-too-large` (413), as a write would, and over a live record it
compares the stored file's size first, so a body of another length is refused
before it is read. A live sidecar with no `digest` is still held: the backend
digests the stored file and compares that, so the rule never lapses over a live
record.

A repeat is a no-op answering the stored `ETag`, with no new stamp and no feed
position. A repeat over a live Resource or chunk whose sidecar carries no
validator stamps the sidecar and answers the new `ETag`. Any other write is
refused with `resource-immutable` (409).

A tombstone keeps the digest of the content it replaced, so a write over one is
held to the same rule against the deleted content. The repeat is the only write
the id takes again, so on the filesystem backend it reclaims a representation
file a delete cut short left beside the tombstone. A repeat of it is a no-op
answering the tombstone's `ETag`, with `size` 0, and the Resource stays deleted.
A different body is refused with `resource-immutable`: a write-once Collection
cannot be edited through a delete and a re-create. A tombstone with no digest,
one an import or a replica apply wrote with no bytes to digest, holds nothing to
compare, so a write over it is an ordinary create.

A filesystem representation file no sidecar names is a write torn between its
bytes and its sidecar, which never committed. It is not a stored Resource or
chunk, so a write over it is a create, whatever its body.

Both backends decide the rule before the unique-claim scans (blinded `unique`
attributes and `unique` plaintext indexes). A write the rule answers runs no
Collection scan, and a changed body that also collides answers
`resource-immutable`.

Delete, Resource `/meta` writes, and imports are not restricted. An import is
skip-not-overwrite, so it never changes a stored Resource, and an archived body
that differs from a stored one is skipped rather than refused. The rule holds on
plaintext and encrypted Collections alike, and on a `did.jsonl`, whose append is
an update.

## Import checks

Import checks the descriptor too (see [export-import.md](export-import.md)). The
plan builder (`lib/importTar.ts`) runs the shape check on an archived Collection
Metadata object's `revisions` member. When the archive also carries the
Collection's governing log, it requires the log head's `revisions` slot to keep
what the archived object sets (the guarded-create check). A break of either
refuses the import as `invalid-import` (400).
