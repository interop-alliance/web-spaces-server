# Server Identity and Export Provenance

How the server holds an identity of its own, and how it uses that identity to
sign an export archive's provenance and to judge one on import. This doc covers
`lib/serverIdentity.ts`, `lib/provenanceStatement.ts`, `lib/exportProvenance.ts`
and `lib/importProvenance.ts`. [ARCHITECTURE.md](../ARCHITECTURE.md) holds the
layer map and the glossary, including the entries for the `server` Space, Server
identity and Provenance statement. The one-key rationale is in
[decision 0003](../decisions/0003-one-server-key-for-export-and-sync.md).

## Two keys, two holders

The server's own identity is held by two keys with two holders. The server
derives an Ed25519 export-signing key from `WAS_SERVER_KEY_SEED`, and that seed
is its only secret. The administrator's `did:key` (`WAS_ADMIN_DID`) holds the
update key of the server's `did:webvh` history log. The server therefore never
mints or extends its own log, and a compromised server cannot take the DID over.

The DID is the self-hosted `did:webvh:{scid}:{host}:space:server:id`. Its log is
the `did.jsonl` Resource of the `id` Collection in the `server` Space. It is
written under the same rules as any Space controller's log, fast-forward and
verify-on-append. See [webvh-controllers.md](webvh-controllers.md) for those
rules. The identity check reads the log itself and verifies those bytes with the
resolver's own step (`verifyStoredLog` in `webvhController.ts`), the recorded
head included. It does not use the resolver's document cache.

The same seed key also signs sync invocations once the log lists it under
`capabilityInvocation`. That signer is described in
[replication.md](replication.md) (`lib/syncIdentity.ts`).

## The `server` Space

The plugin provisions the `server` Space at registration when `WAS_ADMIN_DID` is
set. The create is a guarded create, typed
`['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`, with the admin DID as
controller. The server refuses to start over a stored `server` Space that lacks
the subtype or carries another controller.

A create that loses the guarded write to another instance booting over the same
storage re-reads and checks what the winner stored. One the Space count quota
refuses fails naming `WAS_ADMIN_DID`.

The Space id `server` is reserved on every client create
(`assertCreatableSpaceId`, `reserved-id` 409), configured or not. The subtype is
refused there too (`assertClientCreatableSpaceType`), while the shape check
still admits it. The admin's own Update Space must restate the stored `type`
set, so it goes through.

The log is admin-custodied state. It dies with a data wipe, and the admin's copy
is what restores it.

## Resolving the server DID

`readServerIdentity` reads the log once and judges that read's bytes. The log's
head must name a DID hosted at `server/id` of this server. The log must verify
as that DID's current log under the resolver's own step (`verifyStoredLog` in
`lib/webvhController.ts`). That step refuses a log that does not extend the head
this server last verified, and a deactivated DID, and records the new head. The
signing key must be listed under `assertionMethod`. The check reads every method
that carries the key and any method embedded in a relationship.
`resolveServerIdentity` memoizes that outcome on the log's `ETag`: the DID with
the resolved document it was judged from. A call while the log stands still
costs one metadata read. A memoized outcome is honored for
`WEBVH_DOCUMENT_REVERIFY_AGE` at most, after which the log is read and judged
again, so bytes rewritten under an unchanged `ETag` are noticed within that age.
`/service` reads the DID through `resolveServerDid`, a wrapper over it. The sync
signer reads the DID and the document together, so its `serverDid` and its
`capabilityInvocation` check come from one log version.

The key may also be listed under `capabilityInvocation`, which is how the admin
enables replication. It may not be listed under `capabilityDelegation`,
`authentication` or `keyAgreement`. A key under `capabilityDelegation` without
`capabilityInvocation` would read as a ladder verification method to the
client-annex clause.

One predicate, `signingKeyRelationshipProblem`, decides this for `/service`, the
export snapshot check and the import statement check. See
[service-description.md](service-description.md) for how `/service` advertises
the result as `exportSigningMethod` (under `instance`) and `serverDid` (on the
core `specs` entry).

A log that is absent, does not verify, or lists the key otherwise leaves
`serverDid` off `/service` with a `warn` line, logged once per log version and
reason and not once per request. The server signs nothing in that case.

A read can fall behind a concurrent append: another reader verifies the longer
log and records its head, and the earlier read no longer extends that head.
`readServerIdentity` therefore reads once more when a read is refused and the
log's `ETag` has changed since, and judges the second read alone.

## The provenance statement

`lib/provenanceStatement.ts` holds the provenance statement contract. It is
shared by the signing half and the verifying half below, and owned by neither.
It holds the statement `type` (`STORAGE_ATTESTATION_TYPE`), the members a
statement attests (`Claims`, `CLAIM_MEMBERS`), and the rules for computing them
from an archived object.

- `serverFieldsOf` reads the server-managed members off an archived Metadata
  file or `.meta.<id>.json` sidecar.
- `fileDigest` digests a file's bytes in the `Digest` header's `mh=` form.
- `chunkedDigest` computes a chunked Resource's composite digest.

Both digest forms are defined once in `lib/contentDigest.ts`, which is also
where the backends take the content digest each Resource and chunk record
stores. The statements digest the archived bytes, not the stored value, so a
statement still detects bytes damaged after they were written.

Export signs what these compute, and import recomputes the same values to judge
a statement.

## Signing on export

`loadExportAttestor` in `lib/exportProvenance.ts` runs once per Export Space
request. It reads the log once, through `readServerIdentity`, and that read's
bytes are the snapshot the archive embeds. The server DID is judged from them
under the `/service` rule. The snapshot's document must also list the seed key
as the method `{serverDid}#{publicKeyMultibase}`. It hands back the server DID
with the attestor, and the handler puts that DID in the archive's
`service.json`. A log appended during the export therefore cannot leave
`service.json` and the snapshot on different log versions. A document that lists
the key under another id still yields a `serverDid` but no provenance.

With no identity the handler logs one `warn` line naming the reason and the
export carries no provenance. With one, the backend's `exportSpace` hands its
finished entry tree to `attestArchiveEntries` before packing it. See
[export-import.md](export-import.md) for the archive and its entry tree.

### What a statement holds

`attestArchiveEntries` emits one `StorageAttestation` statement per exported
object in manifest order. Those objects are the Space Metadata object, each
Collection Metadata object, and each Resource with a representation. A tombstone
holds no content and gets none. A Collection tombstone is a Space-level file
entry and gets no statement either.

A statement is
`{ id, type, createdBy, createdAt, updatedAt, updatedAtCounter, originId, meta, digest, didVersionId }`.

- `id` is the object's absolute URL on this server.
- The server-managed members are read back off the archived Metadata file or
  `.meta.<id>.json` sidecar, and a member the record lacks is left out.
- `digest` is the `Digest` header's `mh=` form over the representation's
  archived bytes. A chunked Resource's `digest` is the same form over the JCS
  serialization of its chunk digests in index order, so its parent
  representation's bytes are not covered. These reading and digest rules live in
  `lib/provenanceStatement.ts`.
- `updatedAt`, `updatedAtCounter` and `originId` are the object's write stamp as
  archived. See [validators-and-stamps.md](validators-and-stamps.md).
- A Resource's `meta` is its `/meta` record's stamp and generation, present once
  metadata was written. A Metadata statement carries no `meta` and no `digest`.
- `didVersionId` is the version of the signing DID's document that lists the
  key, since `proof.created` is not trustworthy. For a `did:webvh` signer it is
  the `versionId` of the log entry, here the snapshot head's. The name is
  method-neutral; the spec's `did:webvh` archive signer profile gives it this
  meaning.

### The proof

Each statement carries one `eddsa-jcs-2022` proof, `proofPurpose`
`assertionMethod`. It is made straight from the suite rather than through
`jsigs.sign`, which would add a JSON-LD `@context` the statement does not carry.
The proof has no `created`, and Ed25519 is deterministic, so signing the same
statement again yields the same bytes. That keeps a later write-time signature
interchangeable with an export-time one.

### Where it lands

The statements go into the archive's `provenance.jsonl` and the snapshot into
its `did.jsonl`, both root entries ahead of `space/`. Each Resource is read
twice, once to digest it and once to pack it.

The export is not one transaction. A Resource written between the two reads
leaves a statement that does not match its archived bytes. One deleted after the
backend built the entry tree gets no statement, and the export goes on. Import
verifies both entries, as described next.

## Verifying on import

`lib/importProvenance.ts` is the verifying half. The Import Space handler runs
it through one call, `prepareImportPlan` in `lib/importPlan.ts`, which extracts
the archive and builds the plan with `importTar.ts` first. It removes every
`createdBy` the archive did not earn before the plan reaches a backend. A
backend's `importSpace` takes the judged plan and the verdict counts, and
persists what it is handed. See [export-import.md](export-import.md) for the
import plan.

### The signer

The signer is the DID the `did.jsonl` snapshot's head names. The whole snapshot
must verify offline as that DID's history log (`verifyWebvhLog`). Any server DID
whose log verifies is accepted. There is no allowlist and no setting, and the
importer's own `serverDid` gets no special treatment. The log, not the importer,
establishes who signed.

### Judging a statement

A statement is judged on its own.

1. Its `verificationMethod` must name the snapshot's DID, and that DID must be
   the `server/id` DID of the host the statement's `id` names.
2. The document is resolved at the log entry whose `versionId` equals the
   statement's `didVersionId`, by verifying the log up to that entry. It must
   list the method under `assertionMethod`, and at most `capabilityInvocation`.
3. The `eddsa-jcs-2022` proof is verified.
4. The statement's claims are compared with the archived object: `createdBy`,
   `createdAt`, the write stamp (`updatedAt`, `updatedAtCounter`, `originId`),
   and for a Resource its `meta` and its `digest` (the composite chunk digest
   for a chunked Resource). `meta` is compared member by member.

The archived object's members and digests are computed by the same
`lib/provenanceStatement.ts` functions export signs with.

### Verdicts

Each object the archive carries an attestable entry for gets one verdict,
whether or not the destination already holds it.

- `verified`.
- `unattested`: no statement, or no `provenance.jsonl`.
- `proofInvalid`.
- `contentMismatch`.
- `unknownSigner`: no `did.jsonl`, a log that does not verify, a method outside
  the snapshot's DID, a version the log lacks, or a method there that is not
  under `assertionMethod` or is under any relationship besides
  `capabilityInvocation`.

The counts are the `provenance` member of the returned `ImportStats`. Outside
`verified` the object is still imported, with its `createdBy` removed.

A tombstone carries no statement and is not counted. Its sidecar loses
`createdBy` too, since the tombstone's change document carries it. A Collection
tombstone travels on the plan apart from the live Collections
(`collectionTombstones`), so it is never judged or counted. The Space Metadata
object's verdict is counted only, since an import never restores its
`createdBy`.

A `proofInvalid` and a `contentMismatch` are logged at `warn` with different
messages, so damaged bytes are not read as a bad signature. `createdAt` keeps
its import behavior whatever the verdict.

The archived stamps are read for this comparison only. The importing backend
re-stamps every record it writes with its own clock and origin id, and keeps
each record's archived generation.
