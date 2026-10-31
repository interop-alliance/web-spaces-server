# 0005: A local validator segment on container Metadata objects, and `replicas` on the Space object

- Status: accepted
- Date: 2026-10-02
- Driving work: the multi-primary Spaces design
  (`designs/WSS-96-multi-primary-spaces.md`, approved 2026-10-02). The design
  makes the origin stamp the validator of every record, and a container Metadata
  object's served representation moves on changes that are not writes, so the
  stamp alone could not be its validator.
- Affects: was-teaching-server (`src/lib/etag.ts`'s `formatEtag` and
  `EtagValidator`; `#bumpSpaceMetaVersion` in both backends and the governed-log
  append; `src/lib/spaceProjection.ts`, which derives `replicas` beside
  `backends`; `parseWritePreconditions` on the two container Metadata routes;
  ARCHITECTURE.md's `etag.ts` entry and the Glossary's Space entry).
  pws-client's Space Metadata type gains the member. The conformance suite's
  exact-shape asserts on the Space Metadata object and the validator regex.

## Context

A strong validator must move with the representation. A Space Metadata object's
served form carries derived members a write never sets: `backends` moves when a
backend is registered or deregistered, and `replicas` moves when a replica
registration is added or removed. A Collection Metadata object's served
`encryption` moves on a governed-log append.

The replication order is the four-field stamp
`(generation, ms, counter, originId)`, minted by a write at its origin and
compared by every peer. Minting a stamp on a derived change would turn a local
bookkeeping action into a write that wins last-writer-wins on every peer over a
real earlier edit: a rename at t1 would lose to a backend registration at t2.
Not moving the validator would serve a 304 over changed `backends`, `replicas`
or derived `encryption`. Neither is acceptable.

A second question sat beside it. The registration record itself is read under
the controller's capability or a delegated one rooted in the Space, and never
anonymously, but a `replicas` member on the served Space Metadata object tells
every reader of that object (an app's Space-wide grant, the client-annex
clause's `GET /space/<S>/meta` shape) which hosts hold the user's data.

## Decision

- A container Metadata object's served `ETag` carries a fifth, local segment:
  `"<generation>.<ms>.<counter>.<originId>.<local>"`. `local` is a non-negative
  integer per container record, reset to `0` by a stamped write and advanced by
  each derived-member change: a backend or replica registration and removal on a
  Space, a governed-log append on a Collection. It is never replicated, never
  served as a member, and outside the replication order. A container's
  `If-Match` compares all five segments.
- Resources keep the four-field form. A Resource's validator is therefore
  byte-identical on every replica, which the `If-None-Match` 304 path relies on;
  container Metadata objects are compared across replicas on the four-field
  stamp alone.
- `replicas` stays on the served Space Metadata object, as
  `[{ fromSpace, toSpace, role }]`, the registration's own vocabulary with no
  registration `id` and nothing dynamic. It is derived in `spaceProjection.ts`
  beside `backends` and moves the Space Metadata `ETag`'s local segment on add
  and delete.
- The topology disclosure is accepted. The object's readers are the controller's
  own sessions or a holder of a Space-wide grant the controller chose to issue,
  who already reads the data itself.

## Rejected Alternatives

- **Serving `backends` and `replicas` only at their sub-resources.** It removes
  one derived member from the validated object and closes the disclosure
  question, but it gives up carrying `backends` on the Space Metadata object,
  which lets a reader learn it without a second request, and it does not help
  the Collection Metadata object, whose derived `encryption` still moves on a
  log append.
- **Minting a stamp on a derived change.** A local bookkeeping change would
  replicate as a write and win last-writer-wins on every peer over a real
  earlier edit. It also makes `backends` and `replicas`, which are per-server
  state, look like replicated members.
- **Not moving the validator at all.** A conditional read would be answered 304
  over a changed representation, which breaks the strong validator contract the
  spec's Caching section rests on.

## Consequences

- Two validator shapes exist: four fields on a Resource, a chunk, a Resource's
  `/meta` object and a policy; five on a Space or Collection Metadata object. A
  client treats the whole quoted value as opaque, as the spec asks, and does not
  read the trailing integer as a revision number.
- Served container Metadata objects are not byte-identical across replicas
  (`backends`, `replicas`, `history.resource`), so the byte-equality claim in
  the replication test is scoped to Resources.
- The local segment is one more per-record member in each backend's storage
  layout.
- Any reader of the Space Metadata object learns the Space's replica hosts. A
  controller who does not want that issues no Space-wide grant.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. A reader class may read the Space Metadata object without a Space-wide grant,
   for example a listing or discovery flow that serves it under a narrower
   capability. Move `replicas` to its sub-resource then.
2. A second derived member must itself replicate, so that a derived change on
   one server has to reach its peers. The local segment cannot carry that; the
   member would need a stamp of its own.
3. The container Metadata objects stop carrying derived members altogether, at
   which point the local segment has no job and the four-field form can cover
   every record.
