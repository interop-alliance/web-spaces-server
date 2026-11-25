# 0008: Capability caveats and the `OwnResourcesOnly` caveat

- Status: accepted
- Date: 2026-11-20
- Driving work: letting a guest edit or delete only the Resources that guest
  created in a shared Collection, raised in GitHub issue 40 and its design
  discussion (2026-11-15).
- Affects: web-spaces-server (`src/zcap.ts`, a new chain inspector, the Resource
  write and delete paths of both backends, `src/serviceDescription.ts`);
  `@interop/storage-core` (the `zcapCaveats` member of the authorization profile
  entry type); portable-web-spaces-spec (a caveats section in the zCap
  authorization profile, with the must-understand rule, `zcapCaveats`, the suite
  rule and the `OwnResourcesOnly` definition); pws-client (mint a grant with the
  caveat, reading `zcapCaveats` first); pws-conformance-suite (cases for the
  caveat and for an unknown caveat type).

## Context

The use case is a shared Collection, such as comments. A guest may add to it and
may edit or delete only what that guest added. Today a `PUT` grant on the
Collection overwrites anyone's Resource, and a `DELETE` grant removes anyone's.
A second use case is a submissions inbox, where a guest may add to a Collection
and may read back only what that guest added.

A caveat restricts the capability that carries it. It keeps the action
vocabulary equal to the HTTP verbs. It also leaves access-control policies as a
mechanism that only broadens access. A moderator holds a grant without the
caveat.

The caveat's principal is the controller of the capability that carries it.
Every capability delegated beneath that one acts as the same principal. The
check therefore reads the chain recorded at creation (decision 0007) and not the
signing key.

`@interop/zcap` 12.0.0 and `@interop/http-signature-zcap-verify` 13.0.0 already
provide the must-understand rule. A chain with a caveat type the verifier was
not told it understands raises `UnsupportedCaveatError`. The verifier takes a
`supportedCaveats` handler map and returns the verified `caveats` on its result.

`OwnResourcesOnly` cannot be decided by the verifier, because the answer is in
the stored record. For a write or a delete, the backend decides it inside the
write's critical section, as it decides `If-Match`. For a read, the handler
decides it from the stored record it is about to serve.

The names are permanent once published. Each is a wire convention, so they are
settled here before any code uses them.

## Decision

A capability carries caveats in a typed `caveat` member. The first caveat type
is `OwnResourcesOnly`.

1. A capability carries caveats in the `caveat` member that the zcap v1 context
   already defines. Its value is one object or an array of objects. Each object
   has a non-empty string `type`. This was settled in the design discussion of
   GitHub issue 40 on 2026-11-15.
2. The first caveat type is named `OwnResourcesOnly`. Its object carries `type`
   alone, and one that carries any other member is refused, so a parameter added
   later cannot be ignored by a server released before it. It applies to every
   action the capability allows, `GET` and `HEAD` included. The principal is the
   controller of the capability that carries the caveat. A caveat on any link
   binds the invocation. When two links carry it, both must hold. Under a chain
   carrying it, the server answers as follows.
   - A request at the URL of an existing Resource, at its `meta` URL, or at a
     chunk URL beneath it succeeds only when the principal appears in the
     Resource's `createdBy` list. A Resource with no `createdBy` is refused.
   - A request that creates a Resource is unaffected. That covers a `POST` to
     the Collection and a `PUT` at an absent Resource id.
   - A `DELETE` at an absent Resource id is refused. A `DELETE` over a tombstone
     succeeds only when the principal appears in the tombstone's `createdBy`
     list. Without a caveat both answer 204.
   - A Collection listing succeeds and is filtered. It lists only the Resources
     whose `createdBy` holds the principal, and its `totalItems` counts only
     those. A public-read policy on the Collection does not widen it. A request
     with no authorization headers lists every Resource under the policy.
   - A chain is refused on every route when any delegated capability in it has
     no single controller. A create under it would record no `createdBy`, and
     its creator could not reach the Resource again. A revocation submission is
     still accepted.
   - A `GET` or `HEAD` that describes a container is unaffected. The capability
     decides it as if it carried no caveat. That covers the Collection Metadata
     and its governing history log, the Space Metadata, the Space listing, the
     `linkset` of either, the Collection's `backend`, and the Space's `backends`
     listing.
   - A revocation submission is unaffected.
   - A request at a `policy` URL is refused, at the Space, Collection and
     Resource levels and for every method.
   - Every other request is refused. That covers a query, the `changes` feed,
     the quota reports, the replicas routes, Export and Import Space, and every
     unsafe method at a container or one of its sub-resources, Create Collection
     among them. A route this list does not name is refused.
3. The service description advertises the caveat types the server understands as
   a `zcapCaveats` array on the authorization profile entry, beside
   `zcapCryptosuites`. The member's presence claims the must-understand rule,
   even as an empty array. Under that rule a chain with a caveat type the server
   does not understand is refused. Each value is a caveat `type` the server
   enforces, for example `["OwnResourcesOnly"]`.
4. A capability that carries a caveat must be signed with `eddsa-jcs-2022`. The
   other links of its chain may use either accepted suite. A capability with a
   caveat signed under the legacy `Ed25519Signature2020` suite is refused as the
   masked `not-found`.
5. Caveats are a new version of the zCap authorization profile. The profile
   version that defines the `caveat` member, the must-understand rule,
   `zcapCaveats` and `OwnResourcesOnly` is higher than the one before it, and a
   server that enforces them lists that version on its entry. This was settled
   on 2026-11-20.

The refusals in this record answer as the masked `not-found` (404), as a chain
that fails verification does.

### Why the caveat covers reads

A caveat narrows the capability that carries it. A reader expects "own Resources
only" to hold for every action the capability allows. An earlier draft applied
it to `PUT` and `DELETE` alone. A `GET` grant carrying the caveat would then
have read every Resource in the Collection, with no error to show the caveat was
not enforced.

Which actions a grant allows is already stated in `allowedAction`. The comments
use case therefore takes two grants. One allows `GET` on the Collection and
carries no caveat. The other allows `POST`, `PUT` and `DELETE` and carries it. A
public-read policy on the Collection can stand in for the first.

The Collection listing is filtered to the principal's own Resources, so a guest
can find what it created without a second grant. `totalItems` is filtered too,
since the full count would show how many Resources other parties created.

A query and the `changes` feed are refused under the caveat, because their
answers name Resources the principal did not create. Refusing is the safe first
rule. Filtering them is left as later work.

The caveat is about Resources. A Collection or Space Metadata object names none,
and neither does the Space listing, which names Collections. Those reads are
left to `allowedAction` and the target. A guest also reads the Collection
Metadata to learn how to write there, for example its `encryption` and
`revisions` members. The same grant without the caveat reads all three, so
nothing more is disclosed.

The same holds for the other reads that describe a container, such as the
governing history log, a `linkset` and the `backend` selection. The quota
reports are refused, for the reason `totalItems` is filtered. They report usage
that other parties caused.

Create Collection is refused, and so is every other unsafe method at a
container. A caveat grant is meant for a guest of one Collection, and a
container is not one of the principal's Resources.

A `policy` URL is refused at every level. A policy is managed by the controller.
Without this rule a guest could attach a public-read policy to a Resource it
created, or delete a policy the controller set on it. The rule holds whatever is
decided for a data grant with no caveat at a `policy` URL.

A request the list does not name is refused, so a route added later is closed to
a caveat grant until this record says otherwise.

### Why a client reads `zcapCaveats`

A server running a verifier released before the must-understand rule ignores
`caveat`. A grant minted with the caveat would act there as an unrestricted
grant. A client reads the member before it mints.

### Why `eddsa-jcs-2022`

`eddsa-jcs-2022` signs the capability's JSON as written, so the caveat object is
covered. `Ed25519Signature2020` signs the RDF form. The zcap v1 context defines
`caveat` as a set of node references and aliases `type` to `@type`. It defines
no term for `OwnResourcesOnly` or for any caveat parameter. Canonicalization
runs in safe mode. Such a capability is therefore expected to fail to sign or to
verify under the legacy suite.

This was established by reading the context and the library source. It has not
been observed in a test.

Supporting the legacy suite would need a published JSON-LD context per caveat
type, plus an `allowedContexts` entry. `@interop/zcap` 12 refuses any other
context on a delegated capability.

### Why a delete at an absent id is refused

Delete Resource is idempotent, so an absent id answers 204. Another party's
Resource answers the masked `not-found`. A guest could tell the two apart and
test whether an id exists, leaving no trace. Refusing the absent id closes that.
A tombstone keeps its `createdBy`, so a guest's repeat delete of its own
Resource still answers 204.

A `PUT` still tells the two apart, since a `PUT` at an absent id creates. That
probe leaves a Resource under the guest's own `createdBy` each time it misses. A
Collection that must hide which ids exist takes its Resources by `POST`, which
mints a random id.

## Rejected Alternatives

- Applying the caveat to `PUT` and `DELETE` alone, with reads unaffected. One
  grant would then serve the comments use case. The caveat would not mean what
  its name says, and the inbox use case could not be expressed.
- Keeping that narrower rule under a name that states it, such as
  `ModifyOwnResourcesOnly`. This removes the surprise and still leaves reads
  unrestricted.
- An `actions` parameter on the caveat that lists the actions it restricts. It
  repeats what `allowedAction` and a second grant already express, and adds a
  parameter to the wire shape.
- `features` tokens on the authorization entry, such as `caveats` or
  `caveat-own-resources-only`. That entry has no `features` array today. Each
  type name would also get a second kebab-case form to map back to the
  capability's `type` value.
- No service description member, with the profile version as the claim. This is
  the approach the spec took when it rejected a `policyTypes` member. Every new
  caveat type would then be a profile version bump. A server could not support
  the rule without every type the profile defines. A policy type the server does
  not understand costs a client nothing. A caveat type it does not understand
  makes a grant unusable there, so a per-type answer is useful.
- Requiring every link of a chain that contains a caveat to be `eddsa-jcs-2022`.
  This is stricter than needed. A link with no caveat is signed correctly under
  either suite. The rule would also refuse a caveat grant delegated beneath an
  older legacy-signed grant.
- Accepting both suites, with a new PWS caveats JSON-LD context. That is a new
  permanent URL and vocabulary to maintain, for a suite the server no longer
  advertises.
- No stated suite rule, leaving the legacy suite to fail on its own. The
  behavior would then depend on a library's canonicalization mode.

## Consequences

- A guest cannot read, edit or delete a Resource created by a party above the
  caveat's link. A Resource with no `createdBy`, such as one an import stored
  without it, is refused to a chain carrying the caveat.
- A shared Collection whose guests read everything and change only their own
  takes two grants per guest, or one caveat grant beside a public-read policy.
- A guest holding only a caveat grant lists its own Resources in the Collection.
  It cannot query the Collection or read its `changes` feed.
- A guest cannot publish its own Resource through a policy. The controller sets
  any policy on it.
- The chunk write and the chunk delete carry the same condition as the Resource
  write and delete, since a chunk request is decided by its parent's
  `createdBy`.
- A guest holding only a caveat grant reads the Collection Metadata, so one
  grant is enough to write to an encrypted or write-once Collection.
- A filtered listing reads the `createdBy` of every Resource it passes over, and
  its `totalItems` cannot come from a count of the Collection. The filesystem
  backend derives the unfiltered count from the names in a directory listing, so
  the filtered count costs it a read per Resource.
- A second app the same user delegated to matches what the first app created,
  and so does a later visit of the same app under a new key. The principal is
  the controller of the capability carrying the caveat, and every capability
  beneath it acts as that principal. Decision 0007's list holds every delegatee
  of a creating write.
- Another guest holding the same kind of grant does not match.
- For a write or a delete the decision is made in the backend, inside the
  write's critical section, so the backend's write and delete options gain a
  condition. Both backends implement it. A backend lists the caveat types it
  enforces, and the server refuses to start with one that leaves out a type it
  advertises.
- A read is decided outside any lock. `createdBy` is set at creation and kept on
  every later write. A create over a tombstone records a new one, so the handler
  checks the `createdBy` of the record it serves, and not only the one it read
  to decide.
- A chain with an unknown caveat type is refused on every route family, the
  `/kms` routes included.
- A deployment on an older verifier cannot enforce the caveat. It advertises no
  `zcapCaveats`, and a client that reads the member before minting never issues
  the grant there.
- A signer that only produces `Ed25519Signature2020` cannot issue a caveat
  grant. Clients sign a delegated capability with `eddsa-jcs-2022` already.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. The PWS spec settles a different shape for caveats, or a different
   advertisement than `zcapCaveats`, in its authorization profile.
2. A caveat type is needed that tests more than the stored `createdBy` list, so
   that the verifier or the backend cannot decide it alone.
3. A deployment needs caveat grants signed with `Ed25519Signature2020`. That
   would call for a published JSON-LD context per caveat type.
4. A guest holding a caveat grant needs to query its own Resources or follow
   them in the `changes` feed. That would call for those reads filtered by
   `createdBy`. A Resource tombstone keeps its `createdBy`, so a filtered feed
   could carry a guest's own deletes.
