# 0007: `createdBy` lists the delegation chain a record was created under

- Status: accepted
- Date: 2026-11-17
- Driving work: recording who a record was created for as well as which key
  created it, raised in GitHub issue 40 and its design discussion (2026-11-15).
  The list is also what a later ownership caveat on a capability tests.
- Affects: web-spaces-server (`src/auth-header-hooks.ts`, the create paths of
  `SpacesRepositoryRequest`, `SpaceRequest`, `CollectionRequest`,
  `ResourceRequest` and `collectionContext.ts`, both backends,
  `src/lib/provenanceStatement.ts`, `src/lib/exportProvenance.ts`,
  `src/lib/importProvenance.ts`, `src/sync/replication.ts`); storage-core (the
  `createdBy` type on the Space, Collection and Resource shapes); pws-client and
  the wallet repos (code that compares `createdBy` with one DID);
  pws-conformance-suite (cases that read `createdBy`); portable-web-spaces-spec
  (the `createdBy` member and the `created-by` feature, issue 98).

## Context

`createdBy` held one DID, the invoker of the creating write. Most writes come
from an app a user delegated to, often under a fresh key per visit. The member
then named a key that meant little to a reader and that no later visit could
match.

The verified capability chain of the creating write already names every party
between the Space controller and the invoker. Recording it costs nothing extra
at verification time.

The member is permanent once stored. It is exported, signed into a provenance
statement, and replicated, so its shape had to be settled before any code wrote
it.

## Decision

`createdBy` is the list of DIDs the creating write was delegated through.

1. `createdBy` is an array of DID strings in every case. A record created by one
   party carries a one-element array.
2. A create under a delegated chain lists the controller of each delegated
   capability in the verified chain, in delegation order. The list runs from the
   root end to the invoker, and the invoker is its last entry.
3. The Space controller is left out of a delegated create's list. It is the
   controller of the root capability, which is not a delegated capability.
4. A create under a root invocation lists the invoker alone.
5. A create the provisioning policy granted records no `createdBy`, as before.
   An absent member means no invoker was verified.

The list holds DIDs, not capability ids. The server builds it only from a chain
that verified. A capability controller given as a verification method id is
recorded as its DID. A controller given as an array of one DID is recorded as
that DID. If any entry does not narrow to a DID the server could have verified,
an array of any other length included, the create records no `createdBy`.

The creating write records the list. Every later write keeps it unchanged, and
so does a tombstone, an export, an import of a `verified` object, and the
replicated apply path. The `StorageAttestation` provenance statement carries the
same array.

Nothing is granted to a DID for appearing in the list. It is provenance.

## Rejected Alternatives

- A single DID, the invoker. This is what the member held. It cannot name the
  user behind a per-visit app key, which is the case that prompted the change.
- A string for a root create and an array for a delegated one. Every reader
  would need two code paths for one member.
- Capability ids in place of DIDs. A grant that is revoked and issued again gets
  a new id, so a record created under the earlier grant would stop matching.
- Including the Space controller at the head of every delegated list. Every
  chain on a Space roots in the same controller, so the entry carries no
  information, and it goes stale when the Space is promoted to a `did:webvh`.
- An empty array for a root create. It follows from rule 3 applied literally,
  but the record would name no one, and readers would have to tell `[]` from an
  absent member.
- No `createdBy` for a root create. Absence already means a provisioning grant
  with no verified invoker.
- Invoker first, root end last. The order was settled on 2026-11-15 as
  delegation order, the order the chain itself is serialized in.

## Consequences

- This is a breaking change to a served member, the export archive, the
  provenance statement, and the `changes` feed documents. A reader that compared
  `createdBy` with one DID now tests membership or reads the last entry. There
  is no conversion of stored records and no acceptance of the old string.
- A root create and a one-link delegated create both carry one entry. A reader
  tells them apart only by comparing the entry with the Space's `controller`,
  and that comparison goes stale once the Space is promoted. A record created
  under the `did:key` controller keeps that `did:key`.
- Under a `did:webvh` controller every enrolled client's root create records the
  same account DID. The list does not name the client.
- An intermediate delegatee that equals the Space controller stays in the list,
  and a DID that appears twice in a chain appears twice in the list. Entries are
  recorded as the chain gives them.
- On a public-read Collection the list shows the delegation structure to any
  reader. A reader cannot tell from the list alone which entry authored the
  content.
- The zcap library's chain length limit bounds the size of the list.
- A caveat that restricts a capability to records its holder created can test
  the stored list against the controller of the capability carrying the caveat.
  Because the list holds every delegatee, a second app the same user delegated
  to matches what the first one created.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. The PWS spec settles a different shape for `createdBy` in issue 98.
2. A reader needs to tell which enrolled client of a `did:webvh` account created
   a record, which the list cannot answer.
3. A deployment's public Collections show that exposing the delegation structure
   to anonymous readers is a privacy problem in practice.

If revisited, a change to the member's shape is a new version of the
`created-by` feature, since stored records, archives and provenance statements
carry the array.
