# Web Spaces Server Roadmap -- archived (completed) items

Completed items from [ROADMAP.md](../ROADMAP.md), moved here verbatim when they
ship so that item-number references (WSS-N) in the active roadmap, commit
messages, and design docs keep resolving. Append-only: newest at the bottom; do
not rewrite or summarize items on the way in. Ids remain permanent and are never
reused. CHANGELOG.md stays the record of _what_ landed; this file preserves each
item's acceptance criteria and context.

Items completed before this archive existed (2026-07-23) were dropped outright
and live only in git history of ROADMAP.md.

---

### WSS-38: Conformance tests for the delegated Create Space failure shapes

- status: done
- done: 2026-08-06
- priority: medium
- labels: authz, conformance-suite
- acceptance:
  - [x] Chain rooted in a different DID than the body's controller: 400,
        `controller-mismatch`, Space not created
  - [x] Expired delegation (proof backdated via ezcap's `now` override, past the
        verifier's clock-skew tolerance): 400, `controller-mismatch`, Space not
        created
  - [x] Tampered delegation proof: 400, `controller-mismatch`, Space not created
  - [x] Optional-tier test: the three responses' `detail` strings are pairwise
        distinct (the differentiation SHOULD), asserting nothing about wording

Suite-side work (lands in `@interop/was-conformance-suite`, tracked here per
convention); discovered-from: WSS-8. The error registry folds all three
delegated Create Space verification failures into `controller-mismatch` as a
MUST, but the suite currently only exercises the basic signer-mismatch case -- a
server that 500s or 404-masks an expired delegation or a tampered proof would
pass today. All three shapes are black-box constructible because the suite mints
its own zcaps. The detail-differentiation SHOULD goes in the optional tier only,
as a wording-agnostic pairwise-distinctness check: `detail` is non-normative
free text, so asserting on phrasing (or requiring differentiation at all in the
normative tier) would over-constrain conforming servers. Note the distinctness
check is a signal, not proof -- per-request echo content (e.g. a request id) in
`detail` could mask an undifferentiated implementation.

---

### WSS-51: Reconcile the `encryption.version` descriptor text with the implementation

- status: done
- done: 2026-08-09
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The Collection Data Model descriptor definition and the implementation
        agree on `version`'s type and optionality (spec today: a required
        string, e.g. `"0.1"`; server: an optional positive integer)
  - [x] The error surface for a version transition is reconciled: the spec today
        folds any `version` change or removal into 409 `encryption-immutable`,
        while the server allows increases (a future scheme migration) and
        rejects decreases/removals with 400 `invalid-request-body`
        (`#/encryption/version`) -- amend one side and update the error-registry
        row to match
  - [x] The server rejects an unrecognized `version` of a recognized scheme with
        `unsupported-encryption-scheme`, per the spec's
        accept-only-what-you-enforce SHOULD (registry defines only `edv`/`1`;
        the server today accepts any positive integer)
  - [x] Conformance coverage for the reconciled version-transition behavior
        added (deliberately left out of WSS-43 because of this divergence)

Discovered while implementing WSS-43 (discovered-from: WSS-43). Touches the same
descriptor text WSS-33 extends (the scheme-version registry column and the
never-backwards rail), so the two should land as one spec edit.

Spec update 2026-08: the spec side has moved and made the calls. `version` is
now an optional positive integer (absent means `1`), matching the server --
first criterion met. On the error surface the spec kept 409
`encryption-immutable` for a decrease or removal (its error-registry row now
says so explicitly), so the remaining reconciliation is server-side: swap the
400 `invalid-request-body` throws in `assertEncryptionVersionTransition`
(`src/lib/encryption.ts`) for `EncryptionImmutableError`, then add the
conformance coverage.

Resolution 2026-08-09: server-side reconciliation landed. Version decreases and
removals now throw `encryption-immutable` (409, pointer `#/encryption/version`);
the registry entry pins recognized `versions` per scheme (`edv`: 1) and an
unrecognized version of a recognized scheme is rejected with
`unsupported-encryption-scheme` (400, pointer `#/encryption/version`).
Conformance coverage added in `@interop/was-conformance-suite` 0.4.3
(`encryption.version-*`, six tests incl. one optional-tier).

### WSS-34: Spec the `epochsMac` authenticated epoch configuration

- status: retired
- priority: medium
- labels: spec-side, encryption
- retired: 2026-08-12
- acceptance:
  - [ ] The descriptor member `epochsMac: { v: 1, alg: "HS256", mac }` and its
        MAC/HKDF construction defined
  - [ ] The whole-config replay limitation owned in the text

Shipped in the client stack, 2026-07-20; the server stores it opaquely. The spec
should define: an HMAC-SHA256 over
`"was-epoch-config/v1." + JSON.stringify({ scheme, version, currentEpoch, epochs })`
(epoch ids in descriptor order, `version` null when absent), keyed via
HKDF-SHA256 from the current epoch's 32-byte secret with info
`"was-epoch-config-mac/v1"` -- a key the server never holds. Writers verify it
before encrypting, so a server that points `currentEpoch` back at an epoch a
revoked reader still holds fails to authenticate. The text must also own the
limitation: a replay of an _entire_ old consistent configuration (old list plus
its old MAC) is only detectable with client-side monotonic state, out of scope
for the descriptor itself. Pairs with the layered-revocation item (WSS-30).

Retired 2026-08-12: `epochsMac` was removed stack-wide in was-client 0.32.0 --
on a log-governed descriptor its coverage is a strict subset of log-chain
verification (the entry proof covers the full epoch configuration), so there is
no mechanism left to spec. The construction above is preserved verbatim as the
historical record.

### WSS-55: Collection-level metadata endpoints (`/space/{s}/{c}/meta`)

- status: done
- done: 2026-08-12
- priority: medium
- labels: http-api, data-model, encryption
- touches:
  - portable-web-spaces-spec -- normative text tracked as WASS-9 in that repo's
    `_spec/ROADMAP.md` (done, moved to archive)
  - was-teaching-server -- routes, both backends, `metaVersion` validators,
    server tests + conformance-suite coverage (done; suite tests published in
    `@interop/was-conformance-suite` 0.5.0)
  - was-client -- consumer, tracked as WCL-8 in that repo's ROADMAP.md (done)
- acceptance:
  - [x] `GET`/`PUT` `/space/{space_id}/{collection_id}/meta` mirroring the
        Resource metadata operations: server-managed members plus user-writable
        `custom`, full-replacement PUT
  - [x] An independent `metaVersion` ETag with the same conditional-request
        semantics as the Resource `/meta` one
  - [x] The reserved-segment collision behavior for a Resource whose id is
        `meta` matches the Resource-level rule
  - [x] Filesystem + postgres backends, storage-backend contract tests, and
        conformance-suite coverage (suite tests land in
        `@interop/was-conformance-suite` 0.5.0, pending publish)

The server half of WASS-9 (see that item for motivation and the rejected
blind-derived-id alternative): was-client's WCL-1 persists the blinded-index
schema in this envelope, and encrypted Collections gain client-encrypted
name/tags. The Resource-level `/meta` machinery (validators, full-replacement
semantics, encrypted-`custom` passthrough) is the template.

### WSS-56: Codec-path blinded-index conformance coverage + Reverse-gap cross-link

- status: done
- done: 2026-08-12
- priority: medium
- labels: tests, conformance-suite, encryption, query
- touches:
  - "@interop/was-conformance-suite" -- the `blinded-index-api` suite gains the
    codec-path cases (suite-side items are tracked here per convention, like
    WSS-38) (done; three codec-path tests land in 0.6.0, pending publish)
  - was-teaching-server ROADMAP.md -- the Reverse gaps section gains the
    blinded-index cross-link (second acceptance box) (done 2026-08-12)
- acceptance:
  - [x] The conformance suite exercises blinded-index queries against envelopes
        produced by the was-client codec path (`createEdvEncryption` +
        `Collection.declareIndex()` / `find()`): codec-written `indexed` entries
        match on the server and `find()` round-trips, including a `unique`
        conflict case. Today the `blinded-index-api` suite seeds documents by
        direct PUT of hand-built envelopes only, so nothing proves the two
        writers produce server-matchable tokens for the same content.
        (2026-08-12: `codec path` group in `blinded-index-api` -- equals
        round-trip, has + count, unique 409 conflict -- 183/183 conformant
        against this server)
  - [x] The Reverse gaps section cross-links the blinded-index envelope and
        descriptor semantics the server already serves (the `hmac` member,
        `indexed` entries, persisted index schema) to their spec home, ECS-2 in
        the encrypted-collections spec roadmap -- the PWS spec's Query Profile
        Registry covers only the `/query` wire shape. (2026-08-12)

Follow-on from was-client WCL-1 (codec-path content search, client side shipped
in was-client 0.35.x): the server's `blinded-index-query` matches `indexed`
entries regardless of who wrote them, but conformance coverage never writes
through the codec path, and the spec-side envelope semantics live in the
encrypted-collections spec, which this ROADMAP's Reverse gaps section does not
yet point at.

### WSS-29: Spec the key-epochs surface (`epoch` feed member, descriptor/stamp rails)

- status: done
- done: 2026-08-20
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The optional `epoch` member added to the `changes` profile registry
        entry (or `key-epochs` documented as an extension)
  - [x] The descriptor/stamp surface (`encryption.epochs` / `currentEpoch`
        rails, `Key-Epoch` Resource stamp) covered

The `changes` profile's registry entry omits the `epoch` member the server emits
on feed documents (the `key-epochs` stamp, carried so a replicating reader picks
the right epoch key without a `/meta` fetch per Resource) -- and more broadly
the served key-epochs surface is unspecified: the EDV-over-PWS appendix
currently declares epoch bookkeeping deliberately client-side.

Closed 2026-08-20 by the roadmap reconciliation: the spec now carries `epoch` in
item summaries (mirroring the Resource Metadata property), the `Key-Epoch`
header and `epoch` stamping, and the Key Epochs section with its server
validation and epoch-stamping text; nothing remains unspecified.

### WSS-32: Spec the `was` envelope-binding protected-header parameter

- status: done
- done: 2026-08-20
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The private JWE protected-header member `was: { v, resource?, epoch? }`
        specified in the EDV-over-PWS appendix
  - [x] The rules carried into the text: `resource` omitted for content-derived
        ids, pre-binding vintage accepted, `v` greater than supported is a
        refusal
  - [x] The metadata (`custom`) envelope's `{ v, resource }` binding covered

Shipped in the client stack, 2026-07-20. Writers now emit and readers verify
this member -- the scheme version, the resource id the envelope was written
under, and the key-epoch id, all AEAD-covered by the JWE, so a server-side
envelope swap between ids, an epoch relabel, or a per-envelope scheme downgrade
fails on decrypt.

Closed 2026-08-20 by the roadmap reconciliation: the Encrypted Collections spec
defines the binding (`#was-binding`, `#binding-verification`, `#content-ids`),
including the metadata envelope's binding and the greater-than-version refusal.
The "pre-binding vintage accepted" rule no longer applies: the profile admits no
unbound envelope.

### WSS-33: Spec the `encryption.version` descriptor member

- status: done
- done: 2026-08-20
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The Encryption Scheme Registry gains a scheme-version column
  - [ ] Migration guidance written: only key-wrap material is rewritten, never
        ciphertext bodies (the rewrap path), with the cached-CEK caveat
  - [x] The never-backwards rail documented (once set, never decreases, never
        removed)

Spec update 2026-08: the Encryption Scheme Registry now carries a `version`
column (`edv`/`1`) and the descriptor text documents the set-once,
version-monotonic rail (absent `version` means `1`; raising permitted). Only the
rewrap migration guidance (with the cached-CEK caveat) remains unwritten.

The server now validates an optional positive-integer `version` on the
`encryption` descriptor and enforces that, once set, it never decreases and is
never removed (the same never-backwards rail as `currentEpoch`); clients stamp
`version: 1` when declaring epochs. The per-resource-CEK-under-epoch-key layout
means moving a Resource to a new epoch only rewraps the JWE `recipients` --
which suggests a future client-driven bulk **rewrap** operation as a cheap
post-removal migration (honest caveat: rewrapping does not help against a reader
that cached the CEKs themselves).

Closed on the server side 2026-08-20: the registry column and the
never-backwards text shipped in the spec; the remaining rewrap migration
guidance is Encrypted Collections territory and was re-homed as ECS-5 in that
spec's roadmap.

### WSS-72: Admit `capabilityDelegation` members as root invokers of a did:webvh-controlled Space's DELETE

- status: retired
- priority: high
- labels: security, zcap, authorization, client-annex
- retired: 2026-09-01
- discovered-from: freewallet FW-400 design pass v3 (2026-08-31)
- touches:
  - `src/requests/SpaceRequest.ts:504-520` -- the Delete Space handler's
    `fetchSpaceAndVerify` call, the one site the rule fires at
  - `src/zcap.ts` `webvhVerifier` and `src/lib/webvhController.ts`
    `dereferenceFragment` -- where the relation check lives, shared with WSS-71
  - `test/` -- the admission and refusal matrix below
  - `ARCHITECTURE.md` -- the current-key-set rule's prose
  - the spec's authorization profile (W2, co-designed as WASS-2)
  - wallet-core `decisions/0004` -- amended wallet-side
- acceptance:
  - [ ] The rule fires in the Space DELETE handler and nowhere else
  - [ ] A root-capability invocation signed by a `capabilityDelegation` member
        of the resolved controller document is admitted: on the account Space
        and on the auxiliary annex Space of that account. An unlock Space is out
        of reach by construction, since its controller is its own did:key rather
        than the account did:webvh (corrected 2026-08-31 with FW-400 v4)
  - [ ] The same verification method is refused on a resource DELETE, on a
        collection DELETE, and on `PUT /space/{id}`
  - [ ] A verification method belonging to another did:webvh's document is
        refused, as is a signing key absent from the document
  - [ ] Existing `capabilityInvocation` root DELETE behavior is unchanged
  - [ ] A delegated capability still cannot authorize a Space DELETE (WASS-2)
  - [ ] The log is resolved and fully verified out of the Space being deleted
        before the delete runs, and the caches are busted after
  - [ ] Lands together with WSS-71
  - [ ] A minimum-version note in CHANGELOG.md

Context: freewallet's transient wallet must delete its own account and every
Space that account owns, holding nothing but a standing unlock credential. What
such a visit has is the credential's ladder verification method, published under
`assertionMethod` and `capabilityDelegation`. It has no enrolled client, so it
holds no `capabilityInvocation` method anywhere in the account document.

The first design mechanism was a ladder-signed DELETE delegation on the bare
Space URL, and it was rejected. A capability naming a bare Space URL attenuates
over every path beneath it, so the delegation is far wider than the one verb it
was minted for, and WASS-2 forbids a delegated container DELETE outright. Direct
root invocation avoids both: nothing is minted, nothing is stored, and the
authorization ends with the request.

Why plain membership rather than a ladder-VM sub-clause. Every
`capabilityDelegation` member of an account document is one of two things: an
enrolled client, which already root-invokes today, or a ladder verification
method of a standing unlock credential. Both are the account's own authority by
construction, so a sub-clause would restate the membership test in narrower
words with no security gained. (The freewallet design's Q1 reopens this on one
ground the census misses: a retired credential whose ladder strike went
unattributed leaves a verification method under `capabilityDelegation` that this
rule would still admit.)

Note 2026-08-31 (freewallet FW-400 v4). The v3 design assumed unlock Spaces
would be promoted to the account did:webvh, which would have put them inside
this rule. That structure was withdrawn. An unlock Space keeps its own did:key
controller, so this rule reaches the account Space and the auxiliary annex
Space(s) only. The sibling unlock Spaces are deleted through a ladder-signed
child of the management capability the unlock did:key already delegated to the
account, which needs two other server changes rather than this one: an explicit
client-annex clause predicate for that child (landing beside WSS-67's narrowing
of predicate 1), and WSS-60's enforcement carrying the spec exception for an
exact-target, exactly-`['DELETE']` delegated capability. Approved by the
maintainer 2026-08-31, with the clause predicate admitting two exact action
sets: `['DELETE']` for the delete itself, and `['GET']` for the Space
Description read the deletion walk probes existence with. Both are target-exact
against the parent capability's own `invocationTarget`.

Retired 2026-09-01 (freewallet FW-400 v5). W1, the mechanism this item was the
server half of, was withdrawn by the maintainer, and the design now deletes
every Space of the account through a ladder-VM-signed delegation invoked by the
visit's annex key. That shape works on today's server with no server change, so
the item closes rather than shipping.

Three measurements against main @ `6bd3e3f`, 2026-09-01, by in-process probes
over `startTestServer` from `test/helpers.js` (the probes are not committed),
settle why. The membership rule this item was thought to formalize is not a
formalization but a net widening: root invocation already enforces
`capabilityInvocation` (`webvhVerifier` restates `controller: did` on the
reconstructed method at `src/zcap.ts:276`, routing jsigs'
`ControllerProofPurpose` to the resolved document), so a ladder VM's root
invocation is refused today -- 404 on both `GET` and `DELETE`, against 200 / 204
for a `capabilityInvocation` member. See the re-scoped WSS-71 for the full
matrix. The delegated shape needs no rule at all: a `['DELETE']` delegation on a
bare Space URL, invoked by its did:key delegatee, deleted the Space with a 204,
because `isRootInvocation` (`src/zcap.ts:334-340`) is called at two sites and
the Space DELETE handler is neither of them
(`src/requests/SpaceRequest.ts:489-520` calls only `fetchSpaceAndVerify`). And a
root invocation would have sat outside the client-annex clause entirely, since
the chain inspector skips index 0 (`src/lib/clientAnnexClause.ts:453-457`),
where a delegation is inspected and can be bounded.

The obligations move rather than vanish. WSS-60 must land carrying the exception
for an exact-target, exactly-`['DELETE']` delegated Space DELETE (FW-400 W2), or
it breaks every deletion the ceremony sends. The client-annex clause gains the
third predicate that bounds the ladder-signed case (FW-400 W3), landing with
WSS-67's narrowing of predicate 1. The context above is preserved verbatim as
the historical record, including its rejection of the delegated shape, which the
v5 measurements reverse.

### WSS-67: Narrow the client-annex clause's first predicate to the account Space's items subtree

- status: done
- done: 2026-09-01
- priority: high
- labels: security, zcap, client-annex
- discovered-from: freewallet FW-356 design pass (2026-08-26), re-decided as
  blocking 2026-08-28 once FW-359 shipped
- touches:
  - `src/lib/clientAnnexClause.ts` -- the first admission predicate and the
    header comment's locked-property statement (shipped: the predicate gains the
    target and action bounds, the header comment is rewritten)
  - `test/client-annex-clause-api.test.ts` -- the admission cases (shipped: both
    directions covered)
  - `ARCHITECTURE.md:177-202` -- the only prose description of the clause
    (shipped: the Chain inspection text now describes two bounded shapes plus
    the target-exact one)
  - app-connect-spec `decisions/0003-ladder-authority-clauses.md` -- the
    normative home of the rule this predicate implements (shipped: predicate 1
    and the locked property amended in place, 2026-09-01)
  - wallet-core `decisions/0013` -- its Revisit Criteria 1 names this narrowing
    as a trigger, and `decisions/0004` states the wallet-side convention the
    narrowing would make enforced (shipped: 0004 records the narrowing as
    landed; 0013's criterion is not triggered, since the clause still skips a
    link whose proof method carries both relations)
- acceptance:
  - [x] The first predicate gains a target bound: a ladder-signed delegation
        whose grantee is the pointed annex DID is admitted only when its
        `invocationTarget` is within the account Space's items subtree -- the
        target a generation delegation already carries. A Space-level target,
        which reaches Update Space Description and so the Space's controller, is
        refused
  - [x] Keystore targets are refused by the same bound, stated explicitly rather
        than left to fall out of the subtree test
  - [x] The action bound is decided on the record: either the full verb set
        (matching what a generation delegation needs) or a narrower set, with
        the reason written down. Today the predicate reads no action at all
  - [x] Tests drive both directions: the generation-delegation shape stays
        admitted, and a ladder-signed delegation to the same grantee with a
        Space-level target is refused
  - [x] The header comment's locked-property paragraph is rewritten. It
        currently concedes that the first disjunct "is silent about what that
        key subsequently delegates" and names "target attenuation, the action
        limitations, and the parent's expiry" as the bound -- while the
        predicate itself applies no target attenuation
  - [x] `ARCHITECTURE.md:177-202` is updated to describe two bounded predicates
        rather than one bounded and one grantee-keyed
  - [x] A minimum-version note in CHANGELOG.md, since a wallet minting a wider
        ladder-signed delegation than the items subtree would start being
        refused. No shipped wallet does: freewallet's generation delegation
        targets exactly that subtree

Context: the clause admits a ladder-signed delegation under two disjuncts. The
second is exact -- a `PUT` on the signing DID's own account log, or `GET`/`PUT`
on the delegated-clients auxiliary Space in the trailing-slash form that
excludes Update Space Description -- and its stated safety property holds: all
the delegation can do is write a log, and the write is the record.

The first is bounded by grantee identity alone. It admits on sole-`controller`
equality against the account document's `#DelegatedClients` annex DID behind a
syntactic self-hosted-`did:webvh` gate, and returns before
`capability.invocationTarget` is ever read. So a ladder verification method may
delegate anything the account controls, the Space-level target included, so long
as the grantee is the pointed annex DID.

That was tolerable while the annex verification method held
`capabilityInvocation` only: whatever it received, it could exercise but not
pass on. Freewallet's FW-359 (2026-08-28, wallet-core `decisions/0013`) gave the
per-visit annex method `capabilityDelegation` beside `capabilityInvocation` so
that a transient session can mint App Connect grants. The chain is now root ->
ladder-signed delegation to the annex DID -> annex-signed grant to an arbitrary
third party, and this repo's own test pins that the third link is skipped by the
inspector ("a two-relation annex VM is outside the clause"). The onward step is
offline signing and leaves no entry in any log.

The clause's header comment was revised in the same change and states the
consequence honestly, but the predicate was not touched. What bounds those
onward grants today is a wallet-side convention -- freewallet scopes its
generation delegation to the items subtree -- rather than anything this server
enforces. This item moves that bound server-side.

Two things sharpen the priority. The exposure is live now on every
ladder-anchored account, which is most passphrase accounts on a wallet whose
default signup is credential-anchored. And freewallet FW-356 proposes to keep a
standing ladder verification method for the life of each unlock credential,
which would make the surface permanent and multiply it by the number of standing
credentials; that item's design records this narrowing as blocking its approval.

Superseding note 2026-09-01 (freewallet FW-400 v5). An earlier note here
described a third clause predicate for FW-400's account deletion, then withdrew
it: FW-400 v3 deleted each Space by direct root invocation, so the clause was
untouched and the replacement item was WSS-72. Both of those are now out of
date. WSS-72 is retired, and v5 deletes every Space of the account through a
delegation the ladder VM signs and the visit's annex key invokes. The third
predicate is back, and under v5 it is that design's only server change.

What it must admit: a ladder-signed delegation whose `invocationTarget` is a
bare Space URL and whose `allowedAction` is exactly `['DELETE']` (the delete) or
exactly `['GET']` (the Space Description read the deletion walk probes existence
with), target-exact against the parent's own `invocationTarget` when the parent
is delegated, and against the synthesized root's Space URL when it is not. It
covers all three Space kinds -- the account Space, the auxiliary annex Space(s),
and the sibling unlock Spaces. Predicate 1 admits those delegations target-blind
today (`src/lib/clientAnnexClause.ts:396-405`), which is exactly what this item
narrows, so the third predicate lands with the narrowing rather than after it.
The paired server obligation is WSS-60, which must carry the same exception on
the enforcement side.

Adjacent, not in scope: the clause is fail-open across implementations -- a
server running unmodified zcap verification accepts what this one refuses -- and
nothing is served that a client could read to learn the clause is enforced,
while the clause's own header says a wallet publishes a ladder verification
method only on a host advertising the profile. That standing contradiction is
freewallet FW-357's subject.

### WSS-71: Pin the root-invocation `capabilityInvocation` relation check

- status: done
- done: 2026-09-01
- priority: high
- labels: security, zcap, authorization, tests, docs
- discovered-from: freewallet FW-400 research pass (2026-08-31); re-scoped
  2026-09-01 once the suspected gap was measured and found not to exist
- touches:
  - `src/zcap.ts:253-285` -- `webvhVerifier`, where the check comes from: it
    makes no comparison of its own, it restates `controller: did` on the
    reconstructed method (`:276`), and that is what routes the purpose check to
    the resolved document (waived: no source change, the mechanism is pinned by
    a test rather than modified)
  - `src/lib/webvhController.ts:325-352` -- `dereferenceFragment`, reached
    through `webvhDidResolverDriver`, which serves the `did#fragment` node the
    proof-purpose comparison reads the relation out of (waived: no source
    change, the mechanism is documented rather than modified)
  - `test/` -- the regression test pinning the measured matrix (shipped:
    `test/root-invocation-relation.test.ts`)
  - ARCHITECTURE.md -- the current-key-set rule's description, which states the
    rule but not the mechanism that carries it on the invocation side (shipped:
    the entry now names the restated controller and the resolver driver)
- acceptance:
  - [x] A regression test pins the measured matrix on a promoted (did:webvh
        controlled) Space: a verification method listed under `assertionMethod`
        and `capabilityDelegation` only -- a ladder VM -- cannot root-invoke
        `GET` or `DELETE`, and neither can an `authentication`-only method; a
        `capabilityInvocation` member can do both, as can a method carrying all
        four relations
  - [x] The test asserts the refusal shape the server actually returns (404 at
        the route, from the maximum-privacy masking) and pins the underlying
        verifier message, so a silent widening in a jsigs or zcap upgrade fails
        the suite rather than passing quietly
  - [x] ARCHITECTURE.md's current-key-set paragraph names the mechanism on the
        invocation side: the restated `controller` plus the fragment-resolving
        driver route jsigs' `ControllerProofPurpose` to read the relation out of
        the resolved document, so root invocation and delegation proof are
        relation-scoped by the same code
  - [x] The bootstrap case is documented beside the test: requests that invoke
        as a bare did:key Space controller before promotion take the `did:key`
        branch, not the listed-VM lookup, so no relation applies to them

Filed on the suspicion that the root-invocation path did no relation check. The
suspicion is wrong, measured 2026-09-01 against main @ `6bd3e3f` by in-process
probes over `startTestServer` from `test/helpers.js` (the probe scripts are not
committed). `webvhVerifier` does look the keyId up by membership in the flat
`verificationMethod` array and compares no relation itself
(`src/zcap.ts:260-269`). But it restates `controller: did` on the verification
method it reconstructs (`src/zcap.ts:276`), and that routes jsigs'
`ControllerProofPurpose` to fetch the controller document and read
`capabilityInvocation` out of it. The relation check is therefore already
enforced on root invocations, by the same code as on the delegation-proof path.

The measured matrix, `GET` and `DELETE` on a promoted Space by root invocation:
all four relations -> 200 / 204; `capabilityInvocation` only -> 200 / 204;
`assertionMethod` plus `capabilityDelegation`, the ladder VM -> 404 / 404;
`authentication` only -> 404 / 404. The verifier's refusal reads
`Verification method ... not authorized by controller for proof purpose "capabilityInvocation"`.

So there is nothing to enforce and the item becomes two obligations. First a
regression test: the behavior is load-bearing for freewallet's FW-400, which
depends on a ladder VM being unable to root-invoke anything, and it rests on an
indirection (a restated `controller` string, resolved through the document
loader) that an unrelated refactor could drop without any local signal. Second a
wording fix, since this item's own premise text said the check "only runs on the
delegation-proof path" and that claim traveled into two design docs before it
was measured.

Note 2026-09-01. WSS-72 held the one designed exception to the membership check
this item was going to add. That item is retired: freewallet FW-400 v5 replaced
its mechanism with a delegation, so no exception is needed and nothing lands
with this item.

### WSS-74: CORS proxy response cache and upstream connection reuse

- status: done
- done: 2026-09-03
- priority: medium
- labels: performance, cors-proxy
- acceptance:
  - [x] A 2xx GET response relayed by `/api/cors` is served from an in-memory
        cache on a repeat request for the same URL within its TTL, taken from
        the upstream `Cache-Control` `max-age` when present and otherwise a
        short fixed default; non-2xx and non-GET responses are never cached
  - [x] The cache is bounded (LRU, capped entry count and per-entry size) so an
        open endpoint cannot grow it without limit
  - [x] A host validated by `checkProxyTarget` within a short window skips the
        DNS re-lookup, and the pinned undici `Agent` is reused across requests
        to the same pinned addresses rather than built and destroyed per
        request; the SSRF pinning guarantees are unchanged (a new pin set gets a
        new Agent)
  - [x] Tests in `test/` for the cache hit, the TTL expiry, the no-cache cases,
        and the Agent reuse

Context: the signup log fetched ten distinct issuer-registry URLs (five
registries, each a `.well-known/openid-federation` document and a `fetch?sub=`
document) five times each through the proxy. Every proxied request today does a
fresh DNS lookup, builds a new `Agent`, pays a full TLS handshake, and discards
it all in `finally` (`src/corsProxy.ts`). Federation metadata changes rarely, so
a short TTL removes most of that. The client side of the same pattern (the
wallet fetches the five well-known URLs twice back to back in one signup) is a
freewallet item, not this one.

### WSS-75: Cheap revalidation of cached did:webvh documents

- status: done
- done: 2026-09-03
- priority: low
- labels: performance, webvh
- acceptance:
  - [x] A cached verified document past its TTL is revalidated by comparing the
        log Resource's stored version (or an equivalent cheap validator) against
        the one it was verified from, and re-read and re-verified only when that
        differs; the TTL backstop for multi-process deployments is kept
  - [x] The per-verification `createDefaultDidResolver()` in
        `didResolverWithWebvh` (`src/zcap.ts`) is built once per storage backend
        (a `WeakMap`, like the two existing caches) rather than per request
  - [x] Tests in `test/`: a log rewrite past the TTL is picked up; an unchanged
        log past the TTL is not re-verified

Context: after promotion every verification resolves the account log, and an
annex-signed delegated invocation resolves the annex log as well. The cache in
`src/lib/webvhController.ts` has a 5 s TTL, so a ceremony longer than that
re-reads and re-verifies the whole log every 5 s. Measured on the signup log's
2-entry account log, one verification is about 2.6 ms; the cost is linear in log
length, and every enrollment or rotation appends an entry, so it grows with the
account's age rather than with any one request.

### WSS-76: Memoize access-control policy documents

- status: done
- done: 2026-09-03
- priority: low
- labels: performance, policy
- acceptance:
  - [x] `resolveEffectivePolicy` reads the Space, Collection, and Resource
        policy documents through a per-backend short-TTL cache in the shape of
        `lib/spaceDescriptionCache.ts`, keyed by the policy's level
  - [x] The policy PUT and DELETE handlers, Delete Collection, Delete Space, and
        import invalidate the affected entries
  - [x] Tests in `test/`: a policy write is visible on the next anonymous read;
        a deleted policy stops granting on the next read

Context: every anonymous read that falls through to the policy path issues three
policy reads before the Resource read itself (the signup log shows this on each
public `did.jsonl` read). Policies change only through their own handlers, so
they fit the Space Description cache pattern exactly.

### WSS-63: Move the Collection `indexes` declaration under `plaintext`

- status: done
- done: 2026-09-05
- priority: medium
- labels: data-model, query, breaking
- touches:
  - was-teaching-server: `src/lib/equalityIndex.ts` (`assertSupportedIndexes`,
    `normalizeIndexes`, `assertIndexesNotEncrypted` -- the exclusion becomes
    presence-based: `plaintext` and `encryption` both present is
    `invalid-request-body`, pointer `#/plaintext`),
    `src/requests/SpaceRequest.ts` (create body `plaintext`),
    `src/requests/CollectionRequest.ts` (update path, the added-unique-index
    scan, the `equality` query and `GET ?filter[...]` routes reading
    `plaintext.indexes`), ARCHITECTURE.md / AGENTS.md unaffected (neither
    documents `indexes`)
  - storage-core: SC-1 supplies `CollectionDescription.plaintext`
  - portable-web-spaces-spec: shape of record is decision record
    `_spec/decisions/0004-plaintext-and-encryption-counterparts.md`
    (2026-08-20); the spec text lands with the `equality` profile under WASS-26
  - was-conformance-suite: the `plaintext` declaration cases listed in the
    acceptance below (the `equality` query suite itself waits on spec WASS-26);
    suite-side items are tracked here
  - was-client: unaffected (no `indexes` producer or `equality` binding)
- acceptance:
  - [x] A Collection description carries `plaintext: { indexes: [...] }`; a
        top-level `indexes` is no longer read or stored (no compatibility
        fallback -- greenfield)
  - [x] `plaintext` and `encryption` both present on the resulting description
        is rejected with `invalid-request-body` on create and update, regardless
        of whether `plaintext.indexes` is empty
  - [x] `plaintext` is updatable (add, change; `{}` is the empty state, there is
        no removal) on an existing Collection; a malformed `plaintext`
        (non-object, non-array `indexes`, bad entry, empty or duplicate `name`,
        unknown `source`) is `invalid-request-body`
  - [x] The `equality` profile and `GET ?filter[...]` read their declarations
        from `plaintext.indexes`; existing `test/` coverage is moved to the new
        shape
  - [x] was-conformance-suite cases (a new `plaintext-declaration-api` suite or
        additions to `collection-api`): `plaintext.indexes` persist/echo,
        `plaintext` + `encryption` both present 400 on create and update,
        malformed `plaintext` 400, `plaintext` add/change on an existing
        Collection, `unique` index conflict 409

The spec settled server-side indexing as `plaintext.indexes` (decision 0004,
2026-08-20; text ships with WASS-26; server side landed 2026-09-05 in 0.26.0,
the conformance-suite cases in was-conformance-suite 0.8.0): the two mutually
exclusive top-level Collection members are `encryption` and `plaintext`, so the
exclusion is a structural fact rather than a cross-reference, and "indexes"
stops colliding with the blinded indexes of an encrypted Collection. The server
shipped the flat `indexes` ahead of the spec text; this item moves it. Note for
WSS-25 (b): with the presence-based exclusion, "`custom`-only indexes on
`encryption`-marked Collections" would need a `plaintext` member beside
`encryption`, which the spec forbids; and the spec already makes an encrypted
Collection's `custom` metadata an envelope, so that extension is superseded as
written.

### WSS-78: KMS key wrap accepts only AES-sized payloads

- status: done
- done: 2026-09-05
- priority: high
- labels: kms, correctness
- touches:
  - minimal-cipher: the WebCrypto `Kek` backend must accept every RFC 3394
    payload length and both backends must refuse malformed lengths with one
    distinguishable, exported error (its name is a library API contract and
    needs maintainer sign-off before coding); publish, then bump here. Shipped
    as `InvalidKeyLengthError` in minimal-cipher 7.9.0
- acceptance:
  - [x] minimal-cipher's `wrapKey` accepts any `unwrappedKey` whose length is a
        multiple of 8 bytes and at least 16, on both the WebCrypto and pure-JS
        backends, with byte-identical output; shorter or unaligned lengths throw
        the distinguishable error before either backend runs
  - [x] minimal-cipher's `unwrapKey` throws the same error for a ciphertext that
        is not a multiple of 8 bytes or is shorter than 24, instead of resolving
        `null` (which stays reserved for the integrity-check miss)
  - [x] `WrapKeyOperation` on an `AesKeyWrappingKey2019` key wraps 40, 48, and
        64-byte payloads, and maps the library's length error to a 400
        `invalid-request-body` with pointer `#/unwrappedKey` (`#/wrappedKey` on
        unwrap)
  - [x] `UnwrapKeyOperation` returns the same material for every length the wrap
        side accepts
  - [x] Tests in `test/` cover a 64-byte round trip, the 400 for an 8-byte and a
        20-byte payload, and the 16/24/32-byte cases keep passing

Context: the move from `node:crypto`'s `id-aes256-wrap` to minimal-cipher's
`Kek.wrapKey` imports the payload as an AES-GCM `CryptoKey` before wrapping, so
WebCrypto rejects any payload that is not 16, 24, or 32 bytes with a `DataError`
that `aesWrapKey` does not catch (the client sees a 500). The unwrap side has
the quieter form of the same defect: a 72-byte ciphertext fails the AES-GCM
import, the `catch` swallows it, and the operation reports `null`, which the
client reads as a wrong KEK. Verified against minimal-cipher 7.8.3.

The defect is upstream. minimal-cipher's pure-JS backend (`@noble/ciphers`
`aeskw`) already accepts every RFC 3394 length, so the two backends disagree on
what they accept while documenting identical output. The fix is in `aeskw.ts`:
the WebCrypto `Kek` falls through to the noble primitive whenever the payload is
not an AES key size (or, on unwrap, the ciphertext is not 24, 32, or 40 bytes),
and a single length check ahead of both backends throws the distinguishable
error. Output bytes for 16/24/32-byte payloads do not change, so previously
wrapped keys need no migration. This server keeps only the request-layer half:
catching that error and rethrowing it as the 400. RFC 3394's 16-byte minimum
stays; arbitrary lengths would be RFC 5649 key wrap with padding, a different
algorithm and key type, and are out of scope.

### WSS-79: Get Chunk leaks the chunk stream when the parent gate fails

- status: done
- done: 2026-09-05
- priority: high
- labels: chunks, correctness, filesystem-backend
- acceptance:
  - [x] When the parent-Resource read rejects or the parent is absent, the
        already-opened chunk stream is destroyed before the error is thrown
  - [x] A test in `test/` repeatedly GETs an orphan chunk (parent deleted, chunk
        file left) and asserts no file descriptor remains open (via a spy on the
        stream's `destroy`, or an fd count on Linux)

Context: `ChunkRequest.get` issues the parent-metadata read and `getChunk`
together under `Promise.allSettled`. On the filesystem backend `getChunk`
resolves only after the read stream's `open` event, so an fd is held by the time
the parent gate throws `ResourceNotFoundError`, and `autoClose` fires only on
end, error, or destroy. Each probe of an orphan chunk leaks one fd until
`EMFILE`. Related to the shared helper in WSS-80, which is the natural place for
the cleanup.

### WSS-80: One helper for the parent-gated parallel chunk reads

- status: done
- done: 2026-09-05
- priority: low
- labels: chunks, simplification
- acceptance:
  - [x] The three `Promise.allSettled` parent-gate blocks in `ChunkRequest.ts`
        (get, head, list) call one helper beside `getResourceMetadataOrThrow` in
        `collectionContext.ts` that takes the independent promise and applies
        the precedence rule (rejected parent read, then parent-absent 404, then
        rejected companion read)
  - [x] The helper owns the cleanup for a resolved-but-discarded companion value
        (WSS-79)
  - [x] Existing chunk tests keep passing

### WSS-81: Blinded-index candidate reads should skip meta sidecars

- status: done
- done: 2026-09-05
- priority: medium
- labels: filesystem-backend, performance, correctness
- acceptance:
  - [x] The blinded-index query path and the blinded-unique write path read JSON
        documents only (no `.meta.<id>.json` read per live Resource)
  - [x] A corrupt meta sidecar on an unrelated Resource does not fail a
        blinded-index query or a blinded-unique write
  - [x] `writeResource` calls the candidate reader only when a unique index
        (plaintext or blinded) actually requires it
  - [x] A test in `test/` writes an unparsable sidecar and asserts a
        blinded-index query still succeeds

Context: deleting `#readJsonCandidates` and deriving blinded-index candidates
from `#readEqualityCandidates` added one `readMetaSidecar` read per live
Resource (blobs included) on every blinded-index query and blinded-unique write,
and `readMetaSidecar` has no error handling, so one bad sidecar rejects the
whole `Promise.all`. A `jsonOnly` flag on `#readEqualityCandidates`, or a slim
JSON-only reader, restores the prior cost and failure surface.

### WSS-82: Skip the sidecar read on Resource and chunk misses

- status: done
- done: 2026-09-05
- priority: low
- labels: filesystem-backend, performance
- acceptance:
  - [x] `#readRepresentation` and `#statRepresentation` start the meta sidecar
        read only once `#findFile` has located the representation (or check the
        sidecar against the directory entries already in hand)
  - [x] Existing Resource and chunk 404 / HEAD tests keep passing

Context: both methods now issue `readMetaSidecar` concurrently with `#findFile`,
so every GET or HEAD for a nonexistent id pays a wasted sidecar open/read whose
result the following throw discards. Overlaps with WSS-77, which changes the
same lookup path.

### WSS-84: Key Operation handler still hand-rolls its body-shape check

- status: done
- done: 2026-09-05
- priority: low
- labels: kms, simplification
- acceptance:
  - [x] The Key Operation handler in `KeyRequest.ts` uses `assertJsonObjectBody`
        like the other handlers in that file
  - [x] A JSON array body is refused with the same 400 the helper produces
        elsewhere

Context: the remaining
`typeof request.body !== 'object' || request.body === null` check has no
`Array.isArray` exclusion, so the file now carries two definitions of "JSON
object body".

### WSS-62: Validate the `hmac` descriptor member (shape + permanence)

- status: done
- done: 2026-09-05
- priority: medium
- labels: encryption, data-model, validation
- touches:
  - was-teaching-server: `src/lib/encryption.ts` (a new `hmac` shape check
    beside `assertValidEncryptionEpochs`, and a permanence check inside
    `assertEncryptionDescriptorTransition`), `src/errors.ts` if the
    `encryption-immutable` detail text is widened; ARCHITECTURE.md / AGENTS.md
    unaffected (neither documents the descriptor members)
  - storage-core: unaffected; its `CollectionEncryption` type already declares
    `hmac` with the required shape, so the server's shape check narrows against
    that type rather than adding a local one
  - portable-web-spaces-spec: the rules are shipped text (WASS-20, 2026-08-20):
    `#blinding-key-member` and `#key-epoch-server-validation`
  - was-conformance-suite: `encryption-descriptor-api` gains the hmac cases
    listed in the acceptance below (suite-side items are tracked here, not in a
    separate roadmap)
  - was-client: unaffected (already mints `hmac` through the descriptor CAS and
    never changes `id`/`type` or drops the member)
- acceptance:
  - [x] On a create or update that supplies `encryption.hmac` for a recognized
        `edv` descriptor: `hmac` MUST be an object with non-empty string `id`
        and `type` and a non-empty `recipients` array whose entries have the
        epoch entry shape (`header.kid`, `header.alg` non-empty strings, string
        `encrypted_key`); a violation is `invalid-request-body` with a JSON
        pointer
  - [x] On an update of a stored descriptor that carries `hmac`: the member MUST
        remain present with `id` and `type` unchanged (`recipients` entries may
        change); a change or removal is `encryption-immutable` (409).
        Introducing `hmac` on a stored descriptor that lacks it is accepted (the
        WAS-EC provisioning-time rule stays client-side)
  - [x] The whole descriptor still round-trips unmodified (`hmac` included)
  - [x] Server `test/` coverage for each accepted and refused case
  - [x] was-conformance-suite `encryption-descriptor-api` cases: hmac round-trip
        (`encryption.hmac-persist-echo`), malformed hmac 400 (missing
        `id`/`type`, empty `recipients`, bad entry shape), hmac `id` change 409,
        hmac removal 409, hmac `recipients` change accepted, late hmac
        introduction accepted

Today `hmac` rides through the descriptor as an unknown extra member
(`encryption.ts` preserves unknown fields and
`assertEncryptionDescriptorTransition` has no `hmac` branch), so a client bug
can drop or replace the blinding key and orphan every blinded index in the
Collection. The spec now requires the shape check and the permanence invariant;
this item implements both.

### WSS-54: Read-side caching: 304 on `If-None-Match` and `Cache-Control`

- status: done
- done: 2026-09-07
- priority: low
- labels: caching
- acceptance:
  - [x] A Resource GET/HEAD with an `If-None-Match` that matches the current
        `ETag` returns 304 Not Modified with no body (and the `ETag` header),
        per RFC 9110 conditional-read semantics; a non-matching validator
        returns the full 200 representation
  - [x] The same conditional-read handling applies to the other ETag-emitting
        reads (chunk GET/HEAD, `/meta`, Collection Description)
  - [x] Non-idempotent responses are marked non-cacheable
        (`Cache-Control: no-store` on POST responses), per the spec SHOULD
  - [x] Integration tests in `test/`, plus optional-tier conformance tests in
        the `conditional-requests-api` suite (the spec keeps caching at
        SHOULD/MAY, so they stay optional-tier)

The read-side half of the caching story (discovered-from: WSS-45; recorded as
the one genuinely unimplemented area in the WSS-45 dark-section triage). The
write-side validators already exist: `formatEtag` in `src/lib/etag.ts` emits
strong version-based ETags on GET/HEAD, and `If-Match`/`If-None-Match` gate
writes via `src/lib/preconditions.ts` -- but no read path ever evaluates
`If-None-Match`, so clients re-download unchanged content. Note the spec defers
`Cache-Control` semantics in an editor's note, so keep the `no-store` marking
minimal and revisit if the spec text firms up.

A concrete consumer arrived 2026-09-07 (freewallet FW-134, the log-governed
collection encryption descriptors). Every resource log a wallet reads -- the
account `did.jsonl`, the user key roster, the annex generation log, and under
FW-134 one log per governed collection -- is re-downloaded whole and re-verified
from genesis on every visit. A client holding a verified head and its `ETag`
could confirm the log unchanged with a header round trip and skip both the body
and the chain verification. The log route is an ordinary Resource GET (body
`text/jsonl`), so the first acceptance box already covers it; nothing
log-specific is needed. The wallets adopt the header in their log store's read
path once this lands. Not a blocker for FW-134.

### WSS-88: Generation marker in the `ETag` so a hard delete cannot reuse a validator

- status: done
- done: 2026-09-07
- priority: high
- labels: caching, conditional-writes, wire-contract
- touches:
  - was-client: `parseEtag` reads the trailing integer after the last `.`;
    `If-Match` echoes the received validator string instead of rebuilding it
    from a number
  - conformance-suite: drop the literal `"1"` assertions; treat the validator as
    opaque
  - spec: already satisfied, the Conditional Requests text says the validator is
    opaque to clients and its derivation a server-side concern; no edit
- acceptance:
  - [x] `ETag` is `"<generation>.<version>"`; the generation is minted once per
        versioned record (Resource sidecar, chunk sidecar, Collection
        description, Collection metadata sidecar) and preserved through a
        Resource tombstone and re-create
  - [x] A chunk deleted and rewritten, and a Collection deleted and re-created
        under the same id, carry a different generation; a stale pre-delete
        `If-None-Match` gets 200 and a stale `If-Match` gets 412, on both
        backends
  - [x] Export/import carries the generation with the sidecars and the
        description
  - [x] was-client and the conformance suite consume the new shape (touches
        resolved)

Before this change the version counter restarted at 1 after a hard delete (chunk
delete, Delete Collection, Delete Space), so a re-created record could emit an
`ETag` equal to one a client cached from the old record, and the new 304 path
would answer it with the stale body. A counter that survives the delete would
need tombstones outside the Space tree and would tell a later controller of a
reused Space id how many writes the previous one made; a per-record random
generation needs no persistence beyond the record itself.

### WSS-85: `createApp` option to disable or replace the Fastify logger

- status: done (2026-09-07)
- priority: low
- labels: dx, testing
- acceptance:
  - [x] `createApp` accepts a `logger` option passed through to Fastify (`false`
        for silent, or a pino options object / instance), defaulting to the
        current `true`
  - [x] The backend diagnostics wiring in `src/plugin.ts` (the
        `storage.logger     = fastify.log` hand-off) still works when the logger
        is silent
  - [x] `test/helpers.ts` `startTestServer` defaults to `logger: false`, and the
        in-process consumers (was-react, was-sync) can opt in the same way
  - [x] CHANGELOG entry

Context: `createApp` in `src/server.ts` constructs Fastify with `logger: true`
and offers no way to change it. Every consumer that boots the server in-process
for its tests (was-react's and was-sync's integration suites, this repo's own
`test/`) gets one JSON log line per request in its test output, which buries
assertion failures. Requested from was-sync's WS-11, which moved its integration
suite from a fake server onto a live in-process instance.

### WSS-87: Governing-log sub-resource with a server-derived `encryption` member

- status: done
- done: 2026-09-07
- priority: medium
- labels: encryption, resource-log, data-model, cross-repo
- touches:
  - was-teaching-server (shipped 2026-09-07 in 0.28.0): `CollectionRequest` (the
    describe/list read path that serves `encryption`, and the create/update path
    that today accepts a client-written descriptor), `src/lib/encryption.ts`
    (the epoch and hmac transition checks move from Description PUT to log
    append for a governed Collection), the encrypted-Collection envelope
    enforcement (a log sub-resource is exempt), the listing and `changes` feed
    (a log sub-resource is not a Resource of the Collection), a new route
    `/space/{space_id}/{collection_id}/meta/log` beside the Collection `/meta`
    route (`CollectionRequest.getMeta` / `putMeta`), the problem-type registry
    in storage-core (one new entry)
  - portable-web-spaces-spec: WASS-27 is the normative half, written generically
    (a governing-log sub-resource and server-derived members, the `encryption`
    descriptor as the first governed member); the wire values were settled
    2026-09-07: path `.../meta/log`, declaration by guarded create, one new
    problem type `encryption-history-log-governed` (409), features flag
    `governed-history-logs`. Spec text landed and was committed 2026-09-07
    (e4907d4): the "Collection Governing History Log" section and its two
    operations, plus the registry, features, and cross-reference clauses.
    WASS-27 stays open in the spec repo only for its producer-side touches
  - storage-core: the new problem type in the shared registry
    (`https://wallet.storage/spec#encryption-history-log-governed`, 409).
    Shipped 2026-09-07 as `ProblemTypes.ENCRYPTION_HISTORY_LOG_GOVERNED` in
    storage-core 0.11.0 (published; the server depends on `^0.11.0`)
  - encrypted-collections-spec: owns the profile-level refusals this item does
    not implement (`state.type`, `history` inside `state`, proofs, chain); ECS-7
    resolves in this direction. Waived for this item 2026-09-07: ECS-7 is
    profile text that consumes the sub-resource and changes nothing this server
    serves; it stays `todo` in encrypted-collections-spec
  - was-client: the `/log` transport's `resourceLogStore` takes a Collection
    Resource handle today; the sub-resource is not a Resource, so the store
    needs a constructor over the Collection handle (or a raw URL). WCL-17
    carries that. The descriptor-store seam serves a governed Collection's
    descriptor from the derived member as today. Shipped 2026-09-07 in
    was-client 0.51.0 (0.52.0 is current; the server depends on `^0.52.0`):
    `resourceLogStore({ collection })` over `Collection.getHistoryLog` /
    `putHistoryLog`, plus a live-server integration test
  - freewallet FW-134 / dcw DCW-43: the producers; both drop their projection
    PUT and write the log alone. Waived for this item 2026-09-07: they consume
    the shipped server feature through was-client and do not change its
    contract; both stay `todo` in their own roadmaps
  - was-conformance-suite: a governed Collection's derived member equals the log
    head's `state` plus `history`; a direct `encryption` write on a governed
    Collection is refused; a log append violating epoch monotonicity is refused.
    Also: the suite's optional backend-description cases pin the exact
    `features` list and already fail on `chunked-streams`; they now also miss
    `governed-history-logs`. Shipped 2026-09-07 in suite 0.12.0 (the server
    depends on `^0.12.0`): a `governed-log-api` suite of 16 cases gated on the
    feature token, including the fast-forward append rule, and the `features`
    pin now carries the full list, conformant against this server
- acceptance:
  - [x] A Collection becomes log-governed by the guarded create of its log
        (`PUT .../meta/log` with `If-None-Match: *`) on a Collection whose
        Description holds no client-written `encryption` member; the create is
        refused with `encryption-immutable` (409) on one that does. No new
        Description member. For such a Collection the served `encryption` member
        on describe and on the Space listing is derived by the server from the
        governing log's head entry `state`, with `history: { method, resource }`
        stamped on. The server does not verify entry proofs or the hash chain;
        derivation is last-line parsing, and the member is exactly what a
        verifying reader would compute after stripping `history`
  - [x] The log is the sub-resource
        `/space/{space_id}/{collection_id}/meta/log`, not a Resource of the
        Collection and not part of the `/meta` body (a `PUT /meta` does not
        touch it): absent from listings and the `changes` feed, exempt from the
        encrypted-Collection envelope rule, and readable under any capability
        whose `invocationTarget` covers the Collection URL, so a share grantee
        or an app reads it with the zcap it already holds
  - [x] The log sub-resource supports the `/log` transport's three operations:
        read with `ETag`, append as a compare-and-swap on `If-Match` carrying
        the prior bytes verbatim, guarded create with `If-None-Match: *`; `412`
        on a lost race
  - [x] The epoch and hmac transition checks (`epochs` append-only,
        `currentEpoch` never older, `hmac` id/type permanent once present,
        `scheme`/`version` set-once) run on each log append against the prior
        head's `state`, and a violating append is refused before it lands. The
        server checks the WASS-27 line contract alone (JSON Lines, each line an
        object with a `state` member, last line is the head) and refuses an
        append that breaks it; `state.type`, the reserved `history` member
        inside `state`, proofs, and the chain are the profile's constraints and
        are NOT checked here
  - [x] A direct write of `encryption` on a governed Collection's Description is
        refused with `encryption-history-log-governed` (409, new registry
        entry); the descriptor is read-only on that path. A line-contract break
        on append is `invalid-request-body` (400); an epoch-transition violation
        on append raises what the Description PUT raises today
  - [x] Creating the log on a Collection that already carries a client-written
        `encryption` descriptor is refused (`encryption-immutable`);
        pre-release, there is no conversion, only re-provisioning
  - [x] Server `test/` coverage of the four refusals (direct member write,
        line-contract break, epoch-transition violation, governing an
        already-described Collection) and of derived == head-state equality; the
        backend advertises `governed-history-logs` in its features list;
        conformance-suite assertions gated on that flag **Server half held
        2026-09-07** -- `test/governed-log-api.test.ts` (21 cases) plus a
        backend-contract block run on both backends; the flag is advertised. The
        conformance-suite assertions landed 2026-09-07 (suite 0.11.0,
        unpublished)

Server half landed 2026-09-07 (uncommitted): the storage seam
(`getCollectionLog` / `writeCollectionLog` on both backends), the route and
handlers, derivation in `getCollectionOrThrow`, the refusals, and the tests. Two
notes from the implementation. An epoch-transition violation on append raises
what the Description PUT raises today, which for a dropped epoch or a backwards
`currentEpoch` is `invalid-request-body` (400), not `encryption-immutable`;
WASS-27's text says the latter and should follow the server. A log whose genesis
line carries no string `parameters.method` is served without a `history` stamp
(the storage-core type requires both members). storage-core 0.11.0 is published
and consumed from the registry. The Space listing (List Collections) carries no
`encryption` member for any Collection, governed or not, so the derived member
is served on describe alone. Done 2026-09-07: server 0.28.0, suite 0.12.0, and
was-client 0.52.0 are published, the spec text is committed, and the three
producer-side touches (ECS-7, FW-134, DCW-43) are waived for this item as noted
above.

Filed 2026-09-07 from freewallet FW-134's design pass. Under the
encrypted-collections log form each governed Collection's encryption descriptor
is the `state` of a hash-chained resource log's head, and today's design had
every producer append to the log and then PUT a point-state projection onto the
Collection Description, two requests with a drift window between them and an
ensure sweep to mend a tear. Deriving the projection server-side removes the
second write, the drift, and the mender, and lets the spec say what it already
half-says (encrypted-collections-spec ECS-7): the log is the only authoritative
serving and the point-state member is a projection of it. The server already
does the same thing one level up: it resolves a did:webvh Space controller by
reading `did.jsonl` out of its own storage. The difference here is that the
server does not verify the log; a verifying reader does, and everyone else
trusts the server exactly as much as they do now.

The sub-resource placement follows from two server rules. The envelope rule
refuses non-envelope content in an encrypted Collection, so the log cannot be a
document of the Collection it governs; and a document would show in listings and
the `changes` feed, where the sync driver would replicate it as a row. A
sub-resource beside `/meta` sits under the Collection URL for authorization and
outside its document set for everything else.

The read-side cost the wallets carry (one log fetch per governed Collection per
session, verified from genesis) is unaffected by this item; WSS-54 / WSS-86
(`If-None-Match` on reads) are the items that reduce it.

### WSS-89: A soft delete reopens the `/meta` validator reuse the generation closed

- status: done
- done: 2026-09-07
- priority: high
- labels: bug, conditional-writes, metadata, tombstones
- touches:
  - was-teaching-server (shipped 2026-09-07 in 0.28.0): `deleteResource` (the
    tombstone sidecar rewrite), the Resource `/meta` write path,
    `src/lib/etag.ts`, the Postgres schema (a `meta_generation` column on
    resources), CHANGELOG
  - portable-web-spaces-spec (waived 2026-09-07, tracked separately as WASS-28):
    WASS-28 records the lifecycle rule this item enforces
  - was-sync (shipped 2026-09-07): WS-13 pins the resurrection path's `/meta`
    write against this server
- acceptance:
  - [x] A Resource's `/meta` validator carries its own generation, minted by the
        first metadata write and independent of the content sidecar's
        `generation` (the shape Collections already have with
        `description_generation` beside `meta_generation`)
  - [x] The tombstone rewrite drops that generation together with `custom` and
        `metaVersion`, so a re-created Resource's first metadata write starts a
        fresh generation at `metaVersion` 1
  - [x] Regression test on both backends: write `/meta`, soft-delete, re-create,
        write `/meta` again; the pre-delete meta `ETag` fails `If-Match` with
        412, and `If-None-Match: *` on `/meta` succeeds on the re-created
        Resource
  - [x] The content validator's behavior is unchanged: `generation` kept and
        `version` continuing through the tombstone

Server side shipped 2026-09-07 (sidecar `metaGeneration`, Postgres
`meta_generation` migration v4, both backends, contract and HTTP regression
tests). The was-sync touch (WS-13) shipped the same day: its integration case
pins both the one-cycle resurrection and the 412 on the pre-delete meta `ETag`
against this server. The spec touch (WASS-28) was waived on 2026-09-07 and is
tracked separately in the spec repo.

The `<generation>.<version>` change (0.28.0) keeps a Resource's generation
through a soft delete so the content counter stays continuous. The `/meta`
validator is built from that same sidecar generation and `metaVersion`, but the
tombstone rewrite in `deleteResource` drops `metaVersion` while keeping the
generation. After a re-create, the first metadata write mints `metaVersion` 1
under the old generation, so the meta `ETag` `<gen>.1` recurs. A replica still
holding the pre-delete `<gen>.1` passes `If-Match` on `/meta` and clobbers the
re-created Resource's metadata with stale `custom`. That is the lost update the
generation was introduced to close, reopened on the soft-delete path for the
metadata validator alone.

Dropping `custom` on delete is right (the user metadata goes with the deleted
Resource, and the spec treats a Collection's metadata object the same way). The
fix is to make the metadata object's validator die with it: a separate meta
generation, gone with the tombstone. Keeping `metaVersion` through the tombstone
instead would also close the hole, but it would force every resurrecting client
to carry a meta `ETag` off the tombstone feed entry and use `If-Match`, and
would change the tombstone's documented feed shape; the separate generation
leaves both the spec text and the sync driver as they are.

### WSS-90: Create-if-absent preconditions on Collection and Space Descriptions

- status: done
- done: 2026-09-08
- priority: low
- labels: conditional-writes, spec
- touches:
  - portable-web-spaces-spec: WASS-31 (shipped 2026-09-07: `If-None-Match: *`
    and its 412 on Update Collection; the Space validator, the Read Space
    `ETag`, and both preconditions on Update Space)
  - was-conformance-suite: `conditional-requests-api` "Descriptions" group (four
    cases, drafted 2026-09-07 for 0.13.0; publish pending)
  - was-client: WCL-32 (the `ensureSpace` / `ensureSpaceAndCollection` create
    races; a 412 there has to become a re-read rather than an error)
- acceptance:
  - [x] `writeCollection` accepts `ifNoneMatch` beside `ifMatch`, evaluated
        atomically with the write like the metadata and log writes already are;
        `CollectionRequest.put` threads the parsed `If-None-Match: *` through
        instead of dropping it, and an existing Description answers 412
        `precondition-failed`
  - [x] Space Descriptions carry a server-managed version validator; Read Space
        emits it as a strong `ETag`, and `writeSpace` accepts `ifMatch` /
        `ifNoneMatch` on the same terms, with `SpaceRequest.put` threading the
        parsed headers through
  - [x] Conformance and `test/` coverage for both endpoints: guarded create
        succeeds on an absent target, 412 on a present one, `If-Match` CAS on
        the Space, and an unconditional PUT unchanged
  - [x] Spec text for both operations (the `If-None-Match: *` line and its 412
        on Update Collection; the Space validator, `ETag`, and preconditions),
        filed against the spec repo

Context: the client's `ensureSpace` and `ensureSpaceAndCollection` read the
Description, find it absent, and `PUT` a create. Two clients booting at once
both take that branch, and the loser's replace-semantics `PUT` overwrites the
winner's: a Space loses its `type` array (accepted at creation only) and a
collection its `backend`. `If-None-Match: *` is the only precondition that
states create-if-absent. The Collection Description handler parses it and drops
it; the Space handler reads no preconditions and its read emits no `ETag`, so
there is nothing to condition on. Neither endpoint rejects the header either, so
a client sending it gets no 412 and no protection. The Collection half reuses
the `ifMatch` / `assertTransition` plumbing `writeCollection` already has; the
Space half needs the validator first, which is the spec decision.

### WSS-91: Distinct problem type for an already-revoked revocation submission

- status: done
- done: 2026-09-09
- priority: medium
- labels: zcap, errors, revocation
- blocked-by: storage-core SC-2
- touches:
  - storage-core: SC-2 minted `ProblemTypes.CAPABILITY_ALREADY_REVOKED`
    (`#capability-already-revoked`, 400) on 2026-09-09; published as
    @interop/storage-core@0.12.0 (consumed here 2026-09-09)
  - was-client: WCL-39 maps the type to `AlreadyRevokedError` (waived here
    2026-09-09; tracked in the was-client roadmap)
  - wallet-core: WC-135 narrows `revokeTreatingAlreadyRevokedAsSuccess` to it
    (waived here 2026-09-09; tracked in the wallet-core roadmap)
- acceptance:
  - [x] `RevocationRequest` (`src/requests/RevocationRequest.ts`) answers the
        post-authorization store hit ("already revoked", the check that runs
        after `handleRevocationInvocationVerify`) with the SC-2 problem type
        instead of `INVALID_REQUEST_BODY`; the status stays 400
  - [x] Every other 400 on the route (malformed body, root capability, id
        mismatch, chain verification failure, no delegator) keeps
        `INVALID_REQUEST_BODY`, so a chain that fails to verify is never
        reported as revoked
  - [x] The oracle argument is recorded in the handler comment: the distinct
        type is emitted only after the masked authorization, so it discloses
        nothing an unauthorized prober could not already learn
  - [x] Server `test/` pins the type on a resubmission and pins
        `INVALID_REQUEST_BODY` on a tampered and on an expired chain

Discovered 2026-09-09 from wallet-core WC-135. Today every 400 on the revocation
route is one `InvalidRevocationError` carrying `INVALID_REQUEST_BODY` and the
title "Invalid Revoke Capability request"; the cases differ only in the
free-text `detail`. A client resubmitting a revocation blind (a resumed
ceremony) therefore cannot tell "already revoked" from "the chain does not
verify", and wallet-core currently treats both as success, which leaves a
still-valid generation delegation live for up to a year. Narrower than WSS-57:
that item types the denial on an invocation under a revoked chain; this one
types the answer to the revocation submission itself, on the one path whose
disclosure is already gated behind authorization.

### WSS-57: Typed denial reasons on zcap authorization failures

- status: done
- done: 2026-09-10
- priority: low
- labels: zcap, errors
- touches:
  - storage-core: SC-3 minted `ProblemTypes.CAPABILITY_REVOKED` and
    `CAPABILITY_EXPIRED` (`#capability-revoked` / `#capability-expired`, 404) on
    2026-09-09; published as @interop/storage-core@0.13.0. Earlier: SC-2 minted
    `ProblemTypes.CAPABILITY_ALREADY_REVOKED` (`#capability-already-revoked`,
    400), published as @interop/storage-core@0.12.0
  - zcap: the two verification-time expiry checks throw the exported
    `CapabilityExpiredError` (`name: 'CapabilityExpiredError'`), published as
    @interop/zcap@11.2.0
  - conformance-suite: `denial-reasons-api` (optional typed cases, required
    merged-not-found case), published as 0.14.0
  - was-client: WCL-40 maps both types to `CapabilityRevokedError` /
    `CapabilityExpiredError` (`NotFoundError` subclasses), published as 0.57.0
  - portable-web-spaces-spec: WASS-32 records the registry entries and the
    privacy note, joining the WASS-4 revocation text (waived for this item:
    still todo in the spec repo, handled by the maintainer)
- acceptance:
  - [x] An authorization denial distinguishes, at minimum, a revoked capability
        in the chain, an expired capability, and a generic verification failure,
        as distinct problem types in the error response (today every cause
        collapses into one generic unauthorized response)
  - [x] A security-considerations pass decides which reasons are safe to expose
        to which callers: reason detail must not become an oracle (e.g.
        confirming to an unauthorized prober that a given capability exists or
        was revoked); reasons may need to be limited to callers presenting the
        affected chain
  - [x] The problem-type spellings are recorded (registry + spec-side note,
        joining the WASS-4 revocation spec text when that lands)
  - [x] Server `test/` coverage for each distinguished cause

2026-09-09: implemented. The security pass settled on 404 for every denial, the
two causes named by `type` only, and only for a caller signing with the invoked
capability's controller key (ARCHITECTURE.md "Denial reasons"). 2026-09-10: the
four packages published and the temporary link overrides dropped; archived.

The diagnosability half of the revocation-observability question, minted
2026-08-19; the read/status-probe half (a client-queryable revocation endpoint)
is deliberately deferred until a use case needs it -- revocation records are
retention-bounded internal enforcement state (`capability.expires + 24h`, then
prunable), so a query surface would promote them into a contract with retention
and authorization questions of their own. Motivating case, from wallet-side
ceremony design: a chain that stops verifying is opaque to its holder and to the
Space owner alike -- "revoked" is indistinguishable from "expired", a policy
denial, or a verification-clause refusal, which hurts incident response and
forces grantee apps to treat every 403 as ambiguous. Typed denial reasons give
the holder the answer at exactly the moment it matters, without a new query
surface. Denials currently funnel through the generic authorization error in
`src/zcap.ts` / `src/authorize.ts`; the revocation cause originates in
`revocationChainInspector` (`src/lib/revocations.ts`) and is distinguishable at
that point.

### WSS-99: Decide what `DELETE` answers at a container's `meta` sub-resource

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, routes, wire-contract
- discovered-from: WSS-97
- touches:
  - portable-web-spaces-spec: the route table says there is no `DELETE` at
    `meta`, but does not say what a server answers there; whichever status is
    chosen wants a sentence
  - was-teaching-server: `src/routes.ts`, `src/requests/CollectionRequest.ts`
- acceptance:
  - [ ] `DELETE /space/:s/meta` and `DELETE /space/:s/:c/meta` answer the chosen
        status, decided by the maintainer
  - [ ] The case in `test/client-annex-clause-api.test.ts` that asserts a
        ladder-signed `DELETE` aimed at the Space Metadata URL is refused
        asserts that status, and still proves the clause refuses the invocation
        rather than the route refusing it first

`DELETE /space/:s/meta` currently answers `409 reserved-id`, before any
authorization. The `meta` segment occupies the `{collectionId}` position, so the
request routes to Delete Collection, whose `assertValidIds` rejects the reserved
id. The status is defensible but accidental, and it is unauthenticated where the
neighbouring refusals are masked as 404.

Three candidates. `405` with an `Allow` header naming `GET, HEAD, PUT` matches
what the v0.5 container rule already does for a `PUT` at a container URL, and
says the true thing: the method is not defined at this URL. `404` matches the
masking every other under-authorized refusal uses. `409 reserved-id` is what
falls out today. This is a wire-contract choice, so it is the maintainer's.

Found while fixing the invocation-time ladder bound: the clause test asserting
that a ladder-signed `DELETE` aimed at the Space Metadata URL is refused now
never reaches the clause, because the route refuses it first. That assertion is
left failing rather than retargeted, since retargeting it would bake in the
accidental status.

2026-09-12: resolved as 405. Both Metadata URLs register an explicit `DELETE`
that raises `MethodNotAllowedError`, so the request no longer falls through to
the parametric route one level up. The maintainer took the reading that a 405
says the true thing (the method is not defined at this URL) while 409
`reserved-id` answered a question the request had not asked, and that the
404-masking argument does not apply, since which methods a Metadata URL accepts
is static route-table knowledge rather than anything per-Space.

### WSS-6: Resource `id` supplied on POST create

- status: done (2026-09-12)
- priority: low
- labels: data-model, spec-blocked
- acceptance: none yet -- implement only once the spec defines a
  content-type-independent mechanism

`CollectionRequest.post` always generates a uuid and ignores any client-chosen
id. The spec's Create Resource error list (`reserved-id`, `id-conflict` for "the
supplied Resource `id`") implies a client can supply one, and its POST example
narrates "since no Resource id was specified, the server auto-generated an id"
-- but the Resource section never states the _mechanism_.

The spec defines it only for **Collections**: "When a Collection is created via
a `POST`, the client can specify the `id` of the Collection. If the `id` is not
specified, one is auto-generated." The Resource POST section leans on that
convention without restating it. A body `id` property works for a Collection
Description, whose body is a JSON object the server owns the schema of; it does
not generalize to a Resource, whose POST body **is** the stored content and may
be an opaque binary blob. There is no `Slug` header in the spec (grepped: zero
hits). So this is a spec ambiguity before it is a server gap. Implement only
once the spec nails a content-type-independent mechanism.

Resolved 2026-09-12 without implementation (WSS-104): the spec now says Create
Resource generates the id and a client choosing one uses Update (or Create by
Id) Resource, and it no longer lists `reserved-id` or an existing-id
`id-conflict` there. No POST mechanism is coming, so nothing remains to build.

### WSS-100: Spec text for `backend` surviving an omitting Collection Metadata update

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, spec-gap, wire-contract
- discovered-from: WSS-97
- touches:
  - portable-web-spaces-spec: "Update (or Create by Id) Collection" lists the
    qualifications to full replacement; `backend` needs to join `plaintext`
    there, or the server's deviation needs removing
  - was-teaching-server: `src/requests/collectionInput.ts`
  - was-conformance-suite: shipped -- suite 0.16.0, consumed 2026-09-12, as the
    optional `collection.meta-update-omits-backend-keeps-selection` (optional
    because registering a backend to select has no spec'd wire contract)
- acceptance:
  - [x] The spec says what an update omitting `backend` does
  - [x] The server matches it, and the comment in `composeCollectionMetadata`
        citing the rule points at the spec rather than at the reasoning

The spec makes a Collection Metadata `PUT` a full replacement, qualified only
for the server-managed members and for a log-governed `encryption`. `plaintext`
carries its own carve-out in its member definition. `backend` carries none, so
by the letter of the spec an update that omits it clears it, and a cleared
`backend` means the server default.

That is what this server did until 2026-09-12, and it silently stranded data: a
Collection selecting a registered external backend, updated with a body that
omits `backend` -- a rename, say -- repointed its data plane at the default,
leaving every Resource already stored in the external backend unreachable and
sending later writes elsewhere. The server now keeps the stored selection on an
omitting update, which deviates from the spec as written. Either the spec gains
the carve-out, or the rule becomes something else deliberately (a set-once
member like `encryption`, say, refusing a change outright once the Collection
holds Resources).

Status 2026-09-12: the carve-out was chosen over a set-once rule. The spec now
requires an update that omits `backend` to keep the stored selection (Update (or
Create by Id) Collection, the `backend` member definition, and Backends), and
the server comment cites it. The conformance case for the omitting update is the
remaining touch; it rides the suite's v0.5 pass.

### WSS-101: Answer 405 for every method a reserved endpoint does not implement

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, routes, wire-contract, errors
- discovered-from: WSS-99
- touches:
  - portable-web-spaces-spec: shipped -- WASS-38 landed 2026-09-12 (the
    `#methods-at-reserved-endpoints` subsection; container-`PUT` 405 raised to
    MUST; decision 0005 Amendment 4)
  - was-teaching-server: `src/routes.ts` (`refuseUnimplementedMethods`, called
    last in the Space, Collection and Resource groups), `src/errors.ts`
    (`MethodNotAllowedError` title and detail), ARCHITECTURE.md, CHANGELOG.md
  - storage-core: unaffected (no new problem type; the refusal is `about:blank`)
  - was-client: unaffected (`mapError` maps a 405 to a generic `WasError`
    through its status fallback)
  - was-conformance-suite: shipped -- suite 0.16.0, consumed 2026-09-12: the new
    `reserved-methods-api` suite loops over the reserved endpoints at all three
    levels, with container-`PUT` 405 and absent-Space cases;
    `collection.meta-reserved-resource-id-409` became
    `collection.meta-delete-405-not-reserved-id`
- acceptance:
  - [x] Every reserved endpoint answers each method it does not implement with
        405 and an `Allow` header read from the router, at all three levels;
        `OPTIONS` still reaches CORS preflight and `HEAD` follows `GET`
  - [x] The 405 is identical for an existing and an absent Space
  - [x] `MethodNotAllowedError` titles every 405 `Method Not Allowed` (RFC 9457
        section 4.2.1) and names the refusing URL in `detail`
  - [x] `test/error-registry-api.test.ts` covers the endpoints at each level,
        the absent-Space case, the empty `Allow`, `HEAD`, and CORS preflight
  - [x] The conformance suite's v0.5 pass asserts the rule

The WSS-99 fix answered `DELETE` at the two `meta` URLs with 405. A probe then
showed `meta` was not special: every other reserved endpoint still fell through
to the parametric route one level up and answered a `409 reserved-id` for a
method it lacked (`DELETE /space/{s}/linkset`, `GET /space/{s}/export`,
`PUT /space/{s}/{c}/quota`, `GET /space/{s}/{c}/query`). The maintainer chose a
general spec rule over a `meta`-only one, and this item is the server half.

The refusals are data-driven. Each group ends by reading which methods its
reserved endpoints implement from the router and registering a 405 for every
other method Fastify routes, so the `Allow` header cannot drift from the routes.
That helper must stay last in its group.

One consequence worth knowing: every Collection-level reserved segment is now a
static route for every method, so a reserved Resource id can no longer reach the
Resource `PUT` over HTTP. `assertValidId`'s reserved-id guard stays covered by
its unit tests and by tar import. The cross-collection `/space/{s}/query` is
anchored but served by nothing here, so it answers every method with an empty
`Allow`, which RFC 9110 permits.

### WSS-104: Reserved and duplicate Resource ids on Create Resource are unreachable

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, spec-gap, wire-contract
- discovered-from: WSS-97
- touches:
  - portable-web-spaces-spec: shipped -- WASS-39 landed 2026-09-12 (Create
    Resource and Update (or Create by Id) Resource drop `reserved-id`, Create
    Resource drops the existing-id `id-conflict`, the Collection `meta`
    paragraph drops the `POST` body `id` wording, Version History bullet)
  - was-teaching-server: unaffected (Create Resource already generates the id)
  - was-conformance-suite: shipped -- suite 0.16.0, consumed 2026-09-12:
    `write-validation.resource-reserved-id-put` and
    `ordering.resource-post-conflict-404` removed
- acceptance:
  - [x] The spec no longer lists an error for Resource creation that no HTTP
        request can produce
  - [x] The suite asserts no Resource `reserved-id` or existing-id `id-conflict`
  - [x] Suite 0.16.0 is published and consumed here

The spec listed `reserved-id` (409) and `id-conflict` (409) among the errors of
Create Resource (`POST /space/{s}/{c}/`), and said a reserved Resource id is
rejected "where a Resource id is supplied explicitly, as in a `POST` body's
`id`". The operation never said a body `id` names the Resource, though, and its
example has the server generate one. This server has always ignored a body `id`
there and minted a UUID, so neither error could occur.

Under v0.4 the suite reached the reserved-id guard with a `PUT` at a reserved
Resource id such as `.../quota`. Since WSS-101 every Collection-level reserved
segment is a static route that answers 405 for a method it lacks, so that path
is gone and no HTTP request produces `reserved-id` for a Resource. The suite's
first v0.5 replacement case sent the reserved id in a `POST` body and failed
here (201 with a generated id).

Decision 2026-09-12 (maintainer): the spec drops the errors rather than the
server honoring a body `id`. Honoring it would have been new wire behavior, and
a JSON Resource carrying its own `id` (a Verifiable Credential with a URL id,
say) would have been refused or placed at that id. `PUT` stays the only way to
choose a Resource id. The same reasoning removed `reserved-id` from Update (or
Create by Id) Resource, whose path a reserved segment turns into a reserved
endpoint. `assertValidId`'s reserved-id guard stays, covering tar import.

### WSS-97: Serve the v0.5 route table -- container descriptions at `meta`, the merged Collection Metadata object, trailing-slash canonical URLs

- status: done (2026-09-12)
- priority: high
- labels: was-v0.5, breaking, routes, persistence, zcap, migration
- design: settled 2026-09-11 (four points, each an ask answered in session):
  1. Predicate 3 splits by verb. DELETE branch: the target is the canonical
     Space URL `/space/{s}/`, equal to the parent's target unchanged, with
     `allowedAction` exactly `['DELETE']` (the shape WASS-2 restates). GET
     branch: the target is `/space/{s}/meta` with `allowedAction` exactly
     `['GET']`, and the parent's target is that meta URL or the Space URL. The
     DELETE grant's reach is unchanged: the zcap library's `/`-boundary prefix
     rule already let the old bare `/space/{s}` target cover the subtree, so the
     old bare-vs-slash distinction was cosmetic. What the distinction did carry
     was that a subtree grant (predicates 1 and 2) reached neither Update Space
     nor Delete Space; under v0.5 both sit inside the subtree, so the clause
     adds an invocation-time bound (the inspector receives the invoked target
     and action from `handleZcapVerify`): a chain carrying a ladder-signed link
     is refused on `PUT /space/{s}/meta`, and on `DELETE /space/{s}/` unless
     every ladder-signed link in the chain is exactly the DELETE shape above.
     (Amended 2026-09-12 from a check of the invoked capability alone, which an
     annex verification method's narrowing could satisfy. Signed off
     2026-09-12.) The app-connect-spec decision 0003 amendment and wallet-core
     WC-230 shape follow from this (drafted in the 2026-09-11 session report,
     not yet carried over).
  2. The Space root capability target (`attenuatedRootTarget`, and the
     `urn:zcap:root:` id a client mints for the Space) is the canonical
     `/space/{s}/`. The prefix rule covers `/meta` and every Collection; the
     bare form only redirects. WCL-41 mints the same string.
  3. `meta` joins the server's local reserved-Collection-id set now;
     storage-core 0.14.0 lacks it, so the drift-guard test stays red until a
     storage-core 0.14.1 adds it upstream and the devDependency is bumped.
  4. The server lands ahead of WCL-41: was-client 0.60.0 still speaks the v0.4
     table, so the `test/` API suites that drive the server through it stay red
     until the client half ships. Backend-contract and unit suites stay green.
     Persistence: one storage-port pair per container (`writeSpace` /
     `getSpaceMetadata`, `writeCollection` / `getCollectionMetadata`), one
     validator surfaced out of band as `metaGeneration` / `metaVersion`, stored
     as the `_generation` / `_version` file members on the filesystem and the
     `meta_generation` / `meta_version` columns in Postgres (migration v6
     renames the `description` jsonb to `metadata`, folds the Collection
     `meta_*` annotation columns into it, and drops the `description_*` pair).
     The Collection metadata sidecar file is gone; `custom`, `epoch`,
     `createdAt`, `updatedAt` live in the one Collection metadata file.
- design-approved: 2026-09-11
- blocked-by: storage-core SC-4 (DONE)
- touches:
  - portable-web-spaces-spec: shipped -- WASS-29 landed 2026-09-11 (decision
    `_spec/decisions/0005-container-descriptions-live-at-meta.md`, with its two
    2026-09-11 amendments)
  - was-teaching-server: `src/routes.ts` (the Space and Collection route
    tables),
    `src/requests/{SpaceRequest,CollectionRequest,SpacesRepositoryRequest,spaceContext}.ts`,
    `src/types.ts` (the storage-port methods for descriptions and metadata),
    `src/backends/filesystem.ts` and `src/backends/postgresSchema.ts` (the
    merge, plus a Postgres migration),
    `src/lib/{collectionListing,paths,validateId,metadataWrite}.ts`,
    `src/lib/clientAnnexClause.ts`; ARCHITECTURE.md and AGENTS.md; a CHANGELOG
    entry naming the break
  - storage-core: shipped -- SC-4 shipped the merged type (0.14.0), and 0.14.1
    added `meta` to the reserved-Collection-id registry; consumed here
    2026-09-12, so the drift-guard test is green
  - was-client: shipped -- WCL-41 released as 0.61.0; consumed here 2026-09-12,
    with the raw-request `test/` suites migrated to the v0.5 table, so the full
    Vitest suite is green
  - was-conformance-suite: shipped -- the v0.5 pass released as 0.16.0 and
    consumed here 2026-09-12 (`pnpm conformance:local` 262/262). Retired the
    two-validator case in favor of one asserting a shared `ETag`
  - wallet-core: waived 2026-09-12 (maintainer) -- WC-230 stays open in
    wallet-core. WC-230 filed 2026-09-11 is the minting half of the
    ladder-delegation redesign below -- `clientAnnex/spaceCapability.ts` mints
    exactly the single-verb, bare-Space-URL capability predicate 3 admits. The
    two items settle one shape together; neither should guess ahead of the other
  - freewallet: FW-523 filed 2026-09-11 (the downstream grant minters and the
    durable activity history that records their targets); it is blocked by this
    item, not blocking it
  - app-connect-spec: waived 2026-09-12 (maintainer) -- the decision 0003
    amendment for the invocation-time ladder bound (design point 1) is not
    carried over yet
- acceptance:
  - [x] Space routes: `GET`/`PUT` at `/space/:spaceId/meta` read and write the
        Space Metadata object; `GET /space/:spaceId/` lists Collections and
        `POST /space/:spaceId/` creates one; `DELETE /space/:spaceId/` deletes
        the Space; `PUT` at the bare Space URL is 405; the bare form
        308-redirects to the trailing-slash form
  - [x] `/space/:spaceId/collections` and `/collections/` are retired, the
        segment stays reserved, and the path MAY 308 to the Space URL
  - [x] Collection routes: `GET`/`PUT` at `/space/:s/:c/meta` read and write the
        merged object, `PUT` creating the Collection when absent;
        `GET /space/:s/:c/` lists members, `POST` adds one,
        `DELETE /space/:s/:c/` removes the Collection, `PUT` at the bare
        Collection URL is 405
  - [x] One validator. The description and metadata storage-port pairs collapse
        into one, the filesystem sidecar merges into the description file, and
        the Postgres `description_*` / `meta_*` column pairs unify under a
        migration. The lock namespaces that are deliberately disjoint today
        become one, and the comments saying why they were disjoint are replaced
  - [x] `If-None-Match: *` on the merged `PUT` means "create only if the
        Collection does not exist"; there is no never-written metadata state and
        no `DELETE` at `meta`
  - [x] `meta` joins the Space-level reserved Collection ids (it is already a
        reserved Resource id), and the Space-level route guard mirrors the one
        the Resource routes already have
  - [x] Container `url` members carry the trailing slash everywhere the server
        stamps one: the Space Metadata object, the List Spaces items, the
        Collection Metadata object, and the List Collection envelope. Resource
        URLs are unchanged. `lib/paths.ts` already has the `trailingSlash`
        option, so these are call-site fixes
  - [x] The ladder-delegation target rule is redesigned, not renamed. See the
        paragraph below; this box does not close on a mechanical substitution
  - [x] The conformance suite passes against the new route table

Context: PWS v0.5 moves a container's description to its `meta` sub-resource,
merges a Collection's description with its Metadata object into one object with
one validator, makes the trailing-slash form of a container URL canonical, and
turns the Space into an ordinary container whose `GET` lists Collections and
whose `POST` creates one. This server is the reference implementation and the
canonical "does the spec match an implementation?" check, so until it serves the
new table the spec text is unverified.

The persistence merge is the bulk of the work. A Collection's description and
its metadata are two objects today, with two validators, two storage-port method
pairs, a separate filesystem sidecar, and two sets of Postgres columns whose
schema comment states they are "deliberately INDEPENDENT". The filesystem
backend even takes disjoint locks so a metadata write and a description write
cannot block one another. All of that collapses into one object, one
`metaVersion`, and one lock.

The part that needs design before code is the ladder-delegation target rule in
`clientAnnexClause.ts`. Its predicate 3 exists precisely because the bare Space
URL and the trailing-slash Space URL are different targets today: the bare one
addresses the Space Description, so a narrow single-verb grant on it reaches
Update Space Description and Delete Space without being read as the broad
items-subtree grant. Under v0.5 the bare URL addresses nothing (it redirects),
the description moves to `/space/:spaceId/meta`, and `DELETE` keeps the trailing
slash -- so a `DELETE`-only grant on the Space URL is, by target string, the
same string as a broad subtree grant. The distinction the predicate rests on is
gone. Re-pointing `isBareSpaceUrlTarget` at the `meta` path handles the read
side, but expressing "DELETE the Space itself" narrowly needs a new answer. This
also intersects the spec's own WASS-2 (the container rule), which restated its
targets against the v0.5 layout.

Greenfield: no compatibility route table beyond the 308s the canonical-form rule
itself requires.

Status 2026-09-11: the server half is implemented (all acceptance boxes but the
conformance run). The `test/` API suites driven through `@interop/was-client`
0.60.0 fail against the new table by design until WCL-41 ships, and
`pnpm conformance:local` cannot pass until the suite's v0.5 pass lands; both are
the open touches above.

Status 2026-09-12: every acceptance box is met. Suite 0.16.0 is consumed and
`pnpm conformance:local` passes 262 of 262 with optional cases. The maintainer
waived the wallet-core WC-230 and app-connect-spec decision 0003 touches, so the
item is done; both stay open in their own repos.

### WSS-98: Serve the service description (first iteration, spec v0.5)

- status: done (2026-09-13)
- priority: high
- labels: was-v0.5, discovery, routes, cors
- blocked-by: WSS-97 (DONE) for the `"0.5"` entry to be true. The WASS-30 wire
  members were signed off 2026-09-11; only the `specs` key string stays
  provisional until the spec's WASS-36 rename
- touches:
  - portable-web-spaces-spec: waived -- drafted 2026-09-11 on branch
    `service-description` (the Service Description section; decision
    `_spec/decisions/0006-service-description.md`, draft). The spec fixes no
    path for the document: it is found by a `Link` header
  - was-teaching-server: shipped -- `src/server.ts` or `src/plugin.ts` (the
    route and a global `onSend` hook for the `Link` header),
    `src/config.default.ts` (the instance-disclosure switch), `src/plugin.ts`
    (the CORS registration already exposes `Link`),
    `test/service-description-api.test.ts` (new), `test/cors-preflight.test.ts`;
    ARCHITECTURE.md (the request lifecycle gains a hook every response passes
    through); a CHANGELOG entry
  - storage-core: shipped -- SC-5 there, archived 2026-09-13 (0.15.0 exports
    `ServiceDescription`, `ServiceDescriptionVersionEntry`, `PwsVersionEntry`);
    consumed from the registry 2026-09-13, and `buildServiceDescription` returns
    `ServiceDescription`
  - was-client: waived -- the fetch/parse helper and version selection before
    the first structural request (WCL-101 there, filed 2026-09-13)
  - was-conformance-suite: waived -- a discovery check that follows the `Link`
    from an arbitrary URL, including a 404, and validates the document (moved to
    WSS-106)
- acceptance:
  - [x] `GET {serverUrl}/service` returns the service description as
        `application/json` with no authorization,
        `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=...`,
        and an `ETag`. Fastify's implicit `HEAD` serves the bodyless form. The
        path is this server's choice, since the spec reserves none
  - [x] Every response carries `Link: <{serverUrl}/service>; rel="service"`:
        200s, the maximum-privacy 404s, 308 redirects, `OPTIONS` preflights, and
        error responses produced by the error handler. The hook appends to an
        existing `Link` header rather than replacing it, since pagination and
        policy responses already set one. A test asserts the header on an
        unauthorized `HEAD` of a private Resource and on a paginated listing
        whose `Link` has two relations
  - [x] `Access-Control-Expose-Headers` includes `Link` on every response; it
        already does through the CORS registration, and the test pins it so a
        CORS change cannot regress it
  - [x] The document is `{ url, specs, instance }`. `url` is the absolute
        service description URL. `specs` carries one entry under the spec's
        persistent identifier (provisionally `https://w3id.org/pws`) with
        `version: "0.5"`, `spaces` (absent when the Spaces Repository is
        disabled by configuration), `features`, `signatureAlgorithms`, and
        `zcapCryptosuites`. All URLs absolute, built from `serverUrl`
  - [x] `features` lists only what this configuration serves. The baseline for
        the default configuration is `listing`, `collection-management`,
        `space-management`, `linksets`, `policy`, `metadata`, `export`,
        `backends`, `query`, `quotas`. A feature the configuration disables (for
        example an unregistered backend provider) is not listed. Per-Backend
        tokens (`conditional-writes`, `chunked-streams`, `key-epochs`, the query
        profiles) stay on the Backend description and are not repeated
  - [x] `signatureAlgorithms` and `zcapCryptosuites` are derived from what
        `zcap.ts` actually verifies (`eddsa-jcs-2022`, and
        `Ed25519Signature2020` until WSS-69 drops it), not hand-typed, so WSS-69
        changes the advertisement by construction
  - [x] `instance` carries `name` (the package name), `source` (the repository,
        which also satisfies the AGPL network-source obligation), and
        `homepage`. `version` is included by default on this server, because
        `/health` and the welcome page already publish the exact build; one
        configuration switch removes the version from all three places together,
        for a hardened deployment
  - [x] The `"0.5"` entry is advertised only once WSS-97's route table is what
        the server serves. If this item lands first, the entry says `"0.4"` and
        the switch to `"0.5"` is part of WSS-97's acceptance
  - [x] The conformance suite's discovery check is tracked by WSS-106 (moved
        2026-09-13)
  - [x] Linkset builders (`buildLinkset` in `src/policy.ts`) add the `service`
        relation to the Space and Collection linksets

Context: WASS-30 adds the negotiation step PWS lacked. A client choosing a host
at signup, or deciding which URL layout to speak after WSS-97's breaking change,
needs an answer before any Space-scoped request is possible, and every signal
this server emits today (linksets, the Backend `features` array, `/health`) is
either Space-scoped or not a protocol feature. The spec settles the mechanism:
no fixed path, a `Link` header with the `service` relation on every response,
two CORS MUSTs, and a `specs` object keyed by persistent spec identifier whose
entries carry `version`, endpoint URLs, and feature tokens. A response with no
`service` link identifies a pre-0.5 server, which is what this server is until
the item lands.

The implementation is small. The document is static per configuration and can be
built once at plugin registration. The `Link` header is one global `onSend`
hook; the only care point is that `reply.header('Link', ...)` elsewhere already
carries pagination and policy links, so the hook reads the existing value and
appends. The CORS registration already lists `Link` under `exposedHeaders` and
uses `origin: '*'`, so the two spec MUSTs hold today for CORS requests; the test
pins them.

Two things this item does not do. It does not make the server mountable on a
subpath: `assertValidServerUrl` still rejects a `serverUrl` with a path, and
that is WSS-23. The spec's discovery design exists so that subpath mounting
works for clients; this server simply keeps its origin-root constraint until
WSS-23 lifts it, and the document's absolute URLs are built the same way either
way. And it does not advertise `exchanges` or a KMS entry: those have no
specification to be keyed under yet (decision 0006's consequences), so the
ephemeral-exchanges and keystore routes stay undiscoverable through this
document until one exists.

Greenfield: no second entry for `"0.4"` alongside `"0.5"`. The spec allows a
server to list both during a transition; this server switches route tables in
one release (WSS-97) and advertises one version at a time.

Server part landed 2026-09-13 (`src/serviceDescription.ts`). Two notes from
implementation. No handler sets a `Link` header today: pagination uses the
body's `next` member and linksets are bodies. The append path is still in the
hook and is covered by a test with a synthetic route whose `Link` has two
relations, standing in for the paginated listing the acceptance names. The
version-disclosure switch is `WAS_DISCLOSE_VERSION` (plugin option
`discloseVersion`); with it off, `/health` also drops the build commit and time.
The remaining box waits on the conformance suite's discovery check.

Status 2026-09-13: every server acceptance box is met. The service description
is typed with storage-core 0.15.0's `ServiceDescription`, and an app composed
without a `serverUrl` answers 404 at `/service`, since the spec requires `url`.
The full gate passes (1357 tests) and `pnpm conformance:local` passes 262
of 262. The maintainer moved the conformance discovery check to WSS-106 and
waived the spec and was-client touches, so the item is done; WCL-101 stays open
in was-client and the spec text rides its `service-description` branch.

### WSS-105: Fix the flaky List Keys ordering assertion

- status: done (2026-09-13)
- priority: low
- labels: tests, kms
- acceptance:
  - [x] `test/kms-key-api.test.ts` checks the List Keys order with the code-unit
        comparator the server sorts by (`compareCodeUnits`), not `localeCompare`
  - [x] The suite passes regardless of the case mix of the generated key ids

discovered-from: WSS-98. The assertion near line 1009 sorts the listed local ids
with `localeCompare`, which orders `z1ADnF...` before `z1ADVm...`, while the
server's keyset order puts uppercase first. It fails only when the random ids
differ first at a letter-case boundary; it failed once in a full run on
2026-09-13 and passed on seven reruns.

Both `localeCompare` sorts in the suite now use `compareCodeUnits` from
`src/lib/pagination.ts`, the comparator the backends' keyset order uses. The
paginated case's fixed-width ids were unaffected but switched for consistency.

### WSS-60: Enforce the container rule (unsafe methods at a container URL are controller-only)

- status: done (2026-09-13)
- priority: high
- labels: security, zcap, authorization
- touches:
  - portable-web-spaces-spec: WASS-2 in that repo's ROADMAP.md defines the rule
    (Delete Space, Update Space Metadata, Delete Collection, Update Collection
    Metadata become direct-root-invocation only, and Collection creation, a
    `POST` to the Space URL under v0.5, classifies as exact-target delegable);
    this item is the enforcement half and follows the spec text, including the
    Space DELETE exception and the delegated collection PUT exception below,
    both of which WASS-2's text must state before this item enforces them.
    WASS-2's targets were restated for the v0.5 layout (WASS-29): the two
    description writes are `PUT`s of the `meta` sub-resource, and every
    container URL carries a trailing slash
  - was-teaching-server: `src/requests/SpaceRequest.ts` (`putMeta`, `delete`,
    `post`), `src/requests/CollectionRequest.ts` (`putMeta`, `delete`),
    `src/routes.ts`, `src/lib/clientAnnexClause.ts` (the clause predicate
    covering the exception's ladder-signed case, freewallet FW-400 W3),
    AGENTS.md
  - wallet-core: WC-232 is the annex-side statement of the gap this item closes.
    Under v0.5 the generation delegation's target (the trailing-slash Space URL)
    IS the Delete Space URL and contains the Space Metadata URL, and
    `clientAnnexChainInspector` returns `{ valid: true }` at its
    `ladderLinks.length === 0` short-circuit, so a generation delegation signed
    by an enrolled client's promoted signer (the default arm) reaches both
    writes unchecked. Its action-set comments in `src/clientAnnex/log.ts` name
    that as an open gap until this lands
  - was-client: no change expected; its Collection-create binding already posts
    to the Space URL (WCL-41)
  - conformance-suite: negative-path assertions (a delegated capability with
    `allowedAction` covering `PUT`/`DELETE` invoked at a Space or Collection URL
    is denied with the maximum-privacy 404) and a positive assertion for
    exact-target delegated Collection creation
- acceptance:
  - [x] `PUT /space/{id}/meta` and `DELETE .../{collectionId}/` accept only
        direct root-capability invocation by the Space controller; a delegated
        capability is refused regardless of its `allowedAction`
  - [x] `PUT .../{collectionId}/meta` accepts direct root-capability invocation,
        and additionally a delegated capability whose `invocationTarget` is the
        Space's items subtree (the trailing-slash Space URL, the shape a
        generation delegation carries) and whose `allowedAction` covers `PUT`. A
        delegated capability whose target is the collection container URL
        itself, or a resource URL, is refused. This second exception is
        mandatory (freewallet FW-400 W2, decided 2026-09-01 under its review
        R3); see below
  - [x] `DELETE /space/{id}/` accepts direct root-capability invocation, and
        additionally a delegated capability whose `invocationTarget` is exactly
        that Space's canonical (trailing-slash) URL and whose `allowedAction` is
        exactly `['DELETE']`. This exception is mandatory (see below); it holds
        whatever DID method the Space's controller uses
  - [x] Regression tests for the exception: an exactly-`['DELETE']` delegation
        on the Space's canonical URL stays admitted, while a two-verb delegation
        carrying `DELETE` (say `['GET', 'DELETE']`) is refused, as is a
        `['DELETE']` delegation whose target is a prefix rather than that
        Space's own URL, and one whose target is the slash-less spelling
  - [x] Regression tests for the enrolled-client-signed arm (wallet-core
        WC-232): a generation delegation signed by an enrolled client's key, not
        a ladder VM's, invoked by a transient visit's annex VM, is refused
        `DELETE` on the account Space's canonical URL and `PUT` on its Metadata
        URL; a delegated-clients delegation (`['GET', 'PUT']` over the annex
        Space's container URL) is refused `PUT` on the annex Space's Metadata
        URL. The existing clause test covers the ladder-signed chain only
  - [x] Regression tests for the collection-PUT exception: a delegated
        `PUT .../{collectionId}/meta` under a Space-subtree delegation is
        admitted (a transient session's unlock-methods registry write, a
        generation collection create, and App Connect collection provisioning
        all ride this shape), while the same PUT under a capability targeting
        the collection container URL is refused
  - [ ] Every request freewallet's account-deletion ceremony and transient login
        send stays admitted with enforcement on: freewallet's `tests/e2e-was/`
        suite runs green against this server version before freewallet adopts it
        (waived at close, 2026-09-13: freewallet still pins was-client 0.60, a
        pre-v0.5 client, so its e2e suite fails at signup with a 405 against any
        v0.5 server; the run is owed by freewallet's v0.5 adoption item, and
        every shape those paths send is covered by the server tests and the
        conformance cases instead)
  - [x] Collection creation (`POST /space/{id}/`) stays where v0.5 put it and
        accepts an exact-target delegated capability (per the WASS-1 / WSS-59
        classes); the container rule does not make it controller-only
  - [x] The Update Space Metadata path (`SpaceRequest.putMeta`) keeps its
        body-controller consent check (`verifyBodyControllerConsent`) on top of
        the new rule
  - [x] Server `test/` coverage for each refused and permitted case, plus the
        conformance assertions above

Split out of portable-web-spaces-spec WASS-2 (2026-08-20), which keeps the spec
half. Today all four container unsafe handlers run capability-only verification
(`fetchSpaceAndVerify` / `handleZcapVerify`) that accepts a delegated chain
attenuating from the Space root, so a Space-scoped grant carrying `DELETE` can
delete the Space or any Collection in it. Collection creation is
`POST /space/{id}/` (`SpaceRequest.post`); this item's original text routed it
through a reserved `collections` endpoint, which WASS-29 retired, so WASS-2 now
classifies the `POST` at the Space URL as exact-target delegable instead.

Sequencing against WSS-59, revised 2026-09-13: independent, and this item goes
first. The original ordering rested on the `collections` create route, which
needed WSS-59's exact-target class for reserved path segments; that route is
gone. Everything this item governs (the container DELETEs, the two `meta` PUTs,
the Space-URL create POST) is decided in the Space and Collection request
handlers on the invoked verb, the invoked URL, and the chain's link shapes,
while WSS-59 reclassifies what `attenuatedRootTarget` covers at the reserved
endpoints. Neither needs the other's rule. WC-232 makes this item the one
closing a live authority gap on every account with a transient login, where
WSS-59 closes exposures that need a deliberately crafted grant.

The Space DELETE exception is mandatory, not a convenience (freewallet FW-400
W2, decided 2026-08-31 and widened 2026-09-01 to every Space). Enforcement built
from this item's original text would break three live paths at once. FW-400 v5
deletes the account Space and the auxiliary annex Space(s) through a
ladder-VM-signed delegation invoked by the visit's annex key; it deletes each
sibling unlock Space through a ladder-signed child of the `manageCapability` the
unlock did:key already delegated to the account; and today's remembered-session
unlock-Space delete rides that same `manageCapability` child. Every one of those
is a delegated Space DELETE. Land the exception with the rule or those deletions
all start failing.

Sequencing, decided 2026-09-01: this item is NOT a precondition of freewallet
FW-403 or FW-400. Both ship against the unenforced server, where ordinary chain
verification admits every delegated Space DELETE and collection PUT they send,
and the ladder-signed ones are bounded by the clause's third predicate (shipped
in 0.24.0). This item lands separately, later, and must carry both exceptions
below when it does. Its regression bar is therefore the live wallet traffic, not
only the spec's table: the freewallet e2e suite is the check.

The second exception, the delegated collection PUT (freewallet FW-400 W2, R3). A
transient session holds no root authority by construction: every request it
makes rides the generation delegation, whose `invocationTarget` is the Space's
items subtree. Three of its writers configure or create a collection through
that delegation: the unlock-methods registry write, the generation collection
create during an annex genesis or mend, and App Connect collection provisioning.
Enforcement built from this item's original text refuses all three, which breaks
the transient login itself on any account needing a mend. Those writers have no
migration target, so the rule carves them out instead. The container rule's
hazard is a data grant whose `invocationTarget` IS the container URL; a
Space-subtree parent is not that grant, and a capability targeting the
collection container URL directly stays refused.

WASS-2's rationale is the prefix hazard: a data grant's `invocationTarget` IS
the container URL, so no attenuation rule separates deleting a resource under a
collection from deleting the collection itself. A capability whose whole action
set is `['DELETE']` is not a data grant, which is why the exception is keyed on
the exact action set rather than on the Space's kind or its controller's DID
method. The root-only rule stands unchanged for `PUT /space/{id}/meta` and for
both collection container methods. The ladder-signed case is additionally
bounded by the client-annex clause's third predicate (FW-400 W3, target-exact
against the parent capability's own `invocationTarget`, admitting exactly
`['DELETE']` and exactly `['GET']`), which lands with WSS-67's narrowing of
predicate 1.

The rule must be signer-independent (wallet-core WC-232, 2026-09-13). The
clause's invocation-time bound (`ladderInvocationRefusal`) already refuses the
Space Metadata PUT and the non-target-exact Space DELETE, but only on a chain
carrying a ladder-signed link. The generation delegation is signed by the
account ladder VM OR by an enrolled client's promoted signer, and the second is
the default (freewallet's `ensureGenerationDelegation`, the revocation cascade's
re-mint, wallet-core's GC swap). An enrolled client's key is published under all
four document relations, so it is not a ladder VM, the chain carries no ladder
link, and the bound never runs. Before WSS-97 both writes sat outside the
delegation by layout (the slash-less Space URL); after it, the DELETE is at the
delegation's target and the Metadata PUT one segment inside it. The remedy is
this item's route-level rule, keyed on the exact verb-and-target shape of every
link rather than on who signed one, not a narrowing of the generation
delegation's action set (a permanent app-connect-spec wire artifact whose
structural attenuation would cap every transient App Connect grant).

Closed 2026-09-13. Shipped as a third chain inspector
(`src/lib/containerRule.ts`) composed into `handleZcapVerify` through a
`containerRule` option, reading the invoked capability alone. Touches resolved:
spec text landed (WASS-2 done); wallet-core WC-232 done (comments and changelog
corrected); conformance suite 0.17.0 carries the `container-rule` cases (273/273
locally); was-client waived as expected; the freewallet e2e run waived as noted
in its box. The residual self-narrowing path on the enrolled-client-signed arm
is WSS-107.

### WSS-109: A ladder-signed read of one Resource in an unlock Space

- status: done (2026-09-13)
- priority: medium
- labels: was-v0.5, zcap, authorization, client-annex
- touches:
  - was-teaching-server: `src/lib/clientAnnexClause.ts` (the admission
    predicates and the invocation-time bound), ARCHITECTURE.md's client-annex
    clause paragraph
  - wallet-core: WC-231 mints whatever shape this settles on
    (`src/clientAnnex/spaceCapability.ts`) -- waived 2026-09-13 (maintainer):
    the minter lands under WC-231 in its own repo
  - freewallet: `src/session/unlockMethods.ts` (`unlockEntryReaderFor`) and
    `src/session/accountSettings.ts`'s copy of the same reader -- waived
    2026-09-13 (maintainer): the readers follow WC-231 in their own repo
  - portable-web-spaces-spec and app-connect-spec decision 0003: to be assessed
    if the clause gains a predicate, since predicate 3's shape is restated there
    -- waived 2026-09-13 (maintainer): the dated amendment adding the fourth
    admitted form is handled by the user
- acceptance:
  - [x] A decision, signed off before any code, between (a) the clause admits a
        ladder-signed read of one Resource in an unlock Space, with its exact
        target, verb set, and parent bounds, and (b) the clause stays as it is
        and the wallet reads the keyring record through an authority that is not
        ladder-signed
  - [x] On (a): the predicate is implemented, the invocation-time bound still
        refuses every write it refuses today, and tests in `test/` assert the
        new shape is admitted and a widened sibling (another Resource path, a
        second verb, a Collection target) is refused
  - [ ] (n/a) On (b): the clause's header comment states that a ladder-signed
        Resource read is refused on purpose, and WC-231 is told which authority
        the wallet uses instead

WSS-97 split predicate 3 by verb. Its GET branch admits only a target-exact
`GET` of the Space Metadata object (`/space/<S>/meta`, `allowedAction` exactly
`['GET']`). Under the v0.4 layout the GET branch targeted the bare Space URL,
and WSS-97's own design note records that the zcap library's `/`-boundary prefix
rule let that target cover the Space's subtree. So a GET-only child of a stored
management zcap could read a Resource inside the Space. WSS-97 removed that
reach, and nothing replaced it.

freewallet relied on it. A transient session holds no enrolled-client key, only
the ladder VM, which stands under `capabilityDelegation` but not
`capabilityInvocation`. To read an unlock Space's keyring record it mints a
three-link chain: the unlock Space's root, the management zcap the unlock
identity delegated to the account DID at bind time, and a `['GET']` child signed
by the ladder VM for its own bare did:key. wallet-core now narrows that child's
target to the Space Metadata object, which serves the Space existence probe but
cannot name the keyring record. No current predicate admits a ladder-signed read
of that Resource: predicate 1 is bound to the annex DID and the account Space,
predicate 2 to the bridge and delegated-clients targets, and predicate 3 to
Space delete and Space Metadata read.

Option (a) would widen what a ladder VM may sign, so it has to keep the clause's
locked property (no ladder authority whose exercise leaves no record beyond a
read or a destruction). A plausible bound is a `['GET']` child whose target is a
Resource URL under the parent's own Space URL, parented on a delegated
capability whose target is that Space. Whether it is limited to unlock Spaces,
and how the server would recognize one, is part of the decision.

discovered-from: WSS-97. Filed from wallet-core WC-231.

Decided 2026-09-13: option (a), with no unlock Space special-casing. The shape
is predicate 4 in `src/lib/clientAnnexClause.ts`: a `['GET']` delegation whose
target is a Resource URL `/space/<S>/<C>/<R>` (reserved segments excluded),
under a parent targeting that same URL or the Space's canonical trailing-slash
URL, root or delegated. Touches: the server half shipped; the wallet-core,
freewallet, and decision 0003 entries were waived at close (2026-09-13), so
WC-231 and the freewallet readers stay open in their repos (they mint the
shape), and app-connect-spec decision 0003, which restates the clause's locked
property with the admitted forms, still needs a dated amendment adding this one,
handled by the user.

### WSS-110: `space-subtree-put` refuses a collection-scoped grant's Metadata writes

- status: done (2026-09-14)
- priority: high
- labels: was-v0.5, security, zcap, authorization
- touches:
  - was-react: WR-47 records the app-side half of this conflict;
    `src/storage/wasSync.ts` and `src/storage/wasRemoteStore.ts` make the three
    writes this rule refused -- WR-47 closed 2026-09-14 (done, no code change:
    the writes pass as written)
  - wallet-core: unaffected (the index declarations stay app-side)
  - portable-web-spaces-spec: unaffected (the spec has no such rule, and none is
    added)
  - was-conformance-suite: `container-rule-api`'s Collection-URL grant case
    flipped from a refusal to an admission (0.18.0, TBD)
- acceptance:
  - [x] `PUT /space/{s}/{c}/meta` carries no container rule: a delegated
        capability targeting the Collection container URL or the Collection
        Metadata URL writes the object (`src/requests/CollectionRequest.ts`)
  - [x] `PUT /space/{s}/{c}/meta/log` keeps `space-subtree-put`
  - [x] `test/container-rule-api.test.ts` asserts both admissions
  - [x] ARCHITECTURE.md's container-rule paragraph and CHANGELOG.md restated

Draft rather than todo: the unreleased `space-subtree-put` container rule
(`src/lib/containerRule.ts`, in 0.33.0) guards `PUT /space/{s}/{c}/meta` and
`PUT /space/{s}/{c}/meta/log`. It accepts a direct root-capability invocation,
or a delegated capability whose tail targets exactly the Space's canonical
trailing-slash URL. A capability targeting the Collection container URL, the
Collection Metadata URL, or a Resource URL is refused.

was-react never holds a Space-subtree grant: every grant it gets, from a wallet
or from a dev-mode provisioner, is scoped to one Collection. Under this rule
that refuses three app-side writes to the merged Metadata object: marking a
collection encrypted when the wallet did not already declare it, a public
collection's plaintext index declaration, and the compare-and-swap that declares
a private collection's blinded-index schema. All three are best-effort on the
was-react side and degrade with a warning instead of failing the session, but
equality queries on an undeclared index then fail.

The spec does not mandate this rule, so the conflict is a server decision, not a
spec violation, and there is nothing to accept yet. Three ways out: relax the
rule to also admit a collection-scoped grant on these two paths; move the index
declarations wallet-side, provisioned at grant time instead of written by the
app during sync; or have the wallet delegate a Space-subtree grant for this
purpose instead of a Collection-scoped one. See was-react WR-47 for the app-side
half of this.

Resolved 2026-09-14 by relaxing the rule on `PUT .../meta` only. The prefix
hazard is weak on that path: a holder of a Collection data grant already writes
and deletes every Resource in it, the `encryption` descriptor is immutable once
set, and Delete Collection stays controller-only. The log write keeps the rule,
since was-react never writes it and the guarded create is a permanent governance
declaration.

### WSS-106: Conformance checks for service description discovery

- status: done (2026-09-14)
- priority: high
- labels: was-v0.5, discovery, conformance, tests
- touches:
  - portable-web-spaces-spec: the Service Description section, drafted on branch
    `service-description` (decision
    `_spec/decisions/0006-service-description.md`); the checks' `specRefs`
    anchor into it. Unaffected: the anchors already exist on that branch, no
    spec change needed
  - was-conformance-suite: a new `src/suites/service-description-api.ts`,
    registered in `src/suites/index.ts`; a CHANGELOG entry and a version bump.
    Done 2026-09-14 (suite 0.19.0 published, 9 checks)
  - was-teaching-server: the `@interop/was-conformance-suite` devDependency
    bump; the server behavior under test shipped with WSS-98. Done 2026-09-14
    (suite 0.19.0 published and consumed, `pnpm conformance:local` 282/282)
- acceptance:
  - [x] The suite follows the `rel="service"` link rather than assuming
        `/service`, since the spec reserves no path. It starts from the server
        base URL and resolves the link target against the response URL
  - [x] The `Link` header with the `service` relation is asserted on a 200, on
        an error response (an unauthenticated read of a Space that does not
        exist), on a 308 slash-variant redirect, and on a CORS preflight, and
        every one points at the same URL (spec
        `#discovering-the-service-description`)
  - [x] `Access-Control-Expose-Headers` includes `Link` on those responses, and
        the document is served with `Access-Control-Allow-Origin: *`
  - [x] The document is read with no capability invocation and validated against
        the data model (spec `#service-description-data-model`): `url` and
        `specs` present, `specs` an object of arrays, each entry's `version` a
        bare `major.minor` string, and every URL member absolute
  - [x] The `https://w3id.org/pws` key carries an entry whose `version` is
        `"0.5"`. Its `features`, `signatureAlgorithms`, and `zcapCryptosuites`
        members are arrays of strings when present, and its `spaces` member,
        when present, answers `GET` as a Spaces Repository
  - [x] The `Cache-Control` and `ETag` SHOULD is an optional case, with a
        conditional re-read answering 304
  - [x] Every check carries `specRefs` into the Service Description section
  - [x] The suite is published and consumed here, and `pnpm conformance:local`
        passes with the new checks

discovered-from: WSS-98. That item's last acceptance box was the suite's
discovery check, and it moved here when WSS-98 was archived. The suite repo
keeps no roadmap of its own, so the item lives in this one. The checks assert
only what the spec requires of every server. This server's specifics stay in
`test/service-description-api.test.ts`: the `/service` path, the `features`
baseline, the `instance` members, and the `WAS_DISCLOSE_VERSION` switch.

### WSS-107: Self-narrowing under an enrolled-client-signed Space-subtree grant

- status: done (2026-09-14)
- priority: high
- labels: security, zcap, authorization, client-annex
- touches:
  - was-teaching-server: `src/lib/clientAnnexClause.ts` (the chain walk and
    `ladderInvocationRefusal`), `src/lib/containerRule.ts` (unchanged, its
    tail-only reading stays), ARCHITECTURE.md's "Chain inspection" and
    container-rule paragraphs (done here: `transientAnnexInvocationRefusal`
    beside the ladder bound)
  - wallet-core: WC-233 is the annex-side statement of this gap; its
    `GENERATION_DELEGATION_ACTIONS` comment states the closing rule (already
    shipped there; nothing further to file)
  - portable-web-spaces-spec: unaffected (the container rule's Delete Space
    exception keeps reading the invoked capability; the new bound is a
    client-annex clause rule, not a container-rule change)
  - app-connect-spec: unaffected (the generation delegation's shape and its
    re-delegation are unchanged)
  - freewallet / dcw: unaffected (no code change; the admitted delete shapes
    gain server tests)
- acceptance:
  - [x] The client-annex clause's chain walk classifies a link whose delegation
        proof method resolves in the annex document under `capabilityInvocation`
        (a transient annex VM) beside the ladder-signed category it already
        collects
  - [x] A Space DELETE on a canonical Space URL, or a Space Metadata PUT, is
        refused when any link in the chain is signed by a transient annex VM,
        whoever signed the links above it
  - [x] The residual admission test in `test/container-rule-api.test.ts`
        ("admits an annex-VM DELETE-only target-exact child of the generation
        delegation") flips to a 404 with the Space surviving
  - [x] The same refusal is tested against the delegated-clients sibling
        delegation targeting the auxiliary annex Space URL
  - [x] Admit tests stay green for the shapes freewallet invokes: a DELETE-only
        child of a two-verb `['GET', 'DELETE']` management parent (existing), a
        DELETE-only child of a three-verb `['GET', 'PUT', 'DELETE']` management
        parent with a ladder-VM-signed tail (new), and a two-link
        root-then-DELETE-only child signed by a ladder VM (new)
  - [x] ARCHITECTURE.md's "Chain inspection" paragraph states the bound, and the
        container-rule paragraph stops describing this arm as open
  - [x] CHANGELOG entry

The container rule's Delete Space exception reads the invoked capability alone:
target exactly the Space URL, `allowedAction` exactly `['DELETE']`. That is what
lets freewallet delete an unlock Space through a DELETE-only child of its
two-verb management grant. The same property leaves one path open on the
enrolled-client-signed arm. A transient visit holds a generation delegation (the
Space-subtree grant with the full verb set) signed by an enrolled client's key.
Its annex verification method stands under `capabilityDelegation` as well as
`capabilityInvocation`, so it can mint a child of that delegation with the same
target and `['DELETE']`, and invoke the child. The child satisfies the
exception, and no ladder link is in the chain, so the client-annex clause's
ladder bound never runs. The test file `test/container-rule-api.test.ts` asserts
this admission so a change here is noticed.

Remedy (decided with wallet-core WC-233, 2026-09-14): the bound keys on the
signer, not on the delegation's shape. A per-visit key's own delegation never
ends an account or its annex, so a Space DELETE whose chain carries a link
signed by a transient annex VM is refused (a Space Metadata PUT is already
controller-only at the route). The clause already resolves every
did:webvh-signed link's proof method to classify ladder VMs by relation
asymmetry; the transient VM is recognized by the shape of the signer's own
document, under `capabilityInvocation` and `capabilityDelegation` and no other
relation, rather than against the annex DID the `DelegatedClients` service entry
names, so a retired generation the entry no longer names and an annex a did:key
controller delegated to directly are covered too. The container rule stays
tail-only, so the management-grant shape freewallet relies on is untouched. No
legitimate delete is signed by a transient VM: freewallet's transient-login
deletion signs its DELETE-only children with the ladder VM and invokes them
under a did:key, and the annex GC's re-mint is signed by an enrolled client.

The alternative, reading the links above a DELETE-only tail in the container
rule and refusing any that grant POST, was set aside: it draws the management
line at one verb, and a signer-independent rule was no longer needed once the
transient VM was identified as the only signer with no legitimate delete.

discovered-from: WSS-60.

---

### WSS-112: List the authorization profile's service description entry and move the two signature members onto it

- status: done
- done: 2026-09-16
- priority: high
- labels: service-description, authorization, spec-alignment, breaking,
  wire-contract
- touches:
  - portable-web-spaces-spec: WASS-44. SHIPPED (2026-09-16): the zCap profile is
    the companion spec `PWS-AUTHZ`
    (`https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/`) with
    persistent identifier `https://w3id.org/pws/authz-profile` and version
    `0.1`; core requires a server to list every authorization profile it
    implements under the profile's identifier in `specs`, and the profile's
    entry (not core's) carries `signatureAlgorithms` and `zcapCryptosuites`.
    Decision 0008 in that repo records the wire move
  - storage-core: `PwsVersionEntry` (`src/was.ts:839-843`) loses
    `signatureAlgorithms` / `zcapCryptosuites`, and a new
    `AuthzProfileVersionEntry` type carries them: SC-7 (filed 2026-09-16,
    published as v0.17.0)
  - was-client: WCL-107 carries the client-side check for the profile entry
    (filed 2026-09-16, still `todo` in that repo)
  - was-conformance-suite: unaffected for now -- its service-description suite
    reads the two members off the core entry only when they are present, so it
    stays green (282/282) with them gone. Asserting the profile entry and its
    members, and re-citing the profile's anchors from the authorization, digest,
    delegation-cryptosuites, invocation-target, authz-ordering, and policy
    suites, is follow-up work; itemized there when scheduled
- acceptance:
  - [x] `buildServiceDescription` (`src/serviceDescription.ts`) lists a second
        key, `https://w3id.org/pws/authz-profile`, with one entry
        `{ version: '0.1', url, signatureAlgorithms, zcapCryptosuites }`, where
        `url` is the profile's rendered location; a new
        `AUTHZ_PROFILE_IDENTIFIER` / `AUTHZ_PROFILE_VERSION` pair sits beside
        `SPEC_IDENTIFIER` in `src/config.default.ts`
  - [x] The `https://w3id.org/pws` entry no longer carries `signatureAlgorithms`
        or `zcapCryptosuites`
  - [x] `test/service-description-api.test.ts` (around lines 92-93) asserts the
        members on the profile entry and their absence from the core entry
  - [x] ARCHITECTURE.md's `src/serviceDescription.ts` entry (around line
        175-179) names both entries, and its authorization prose (the
        current-key-set rule paragraph around line 302, the client-annex
        paragraph around line 481 that says PWS defines no venue at the
        authorization-profile layer) cites the profile spec rather than core:
        `https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/#current-key-set-rule`,
        `https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/#service-description-entry`
  - [x] CHANGELOG entry marks the wire change as breaking for clients that read
        the two members off the core entry

Filed 2026-09-16 from WASS-44. The move is a plain relocation: the values the
server advertises today (`EdDSA`; `Ed25519Signature2020` and `eddsa-jcs-2022`)
do not change, only the entry they sit on. The profile's entry advertises no
policy types; listing the profile means the server evaluates `PublicCanRead`,
which it already does.

### WSS-111: Remove the backend `features` vocabulary and move the surviving tokens to the service description

- status: done
- done: 2026-09-16
- priority: high
- labels: backends, service-description, spec-alignment, breaking, conformance
- touches:
  - portable-web-spaces-spec: WASS-40. SHIPPED (2026-09-16): the Backend
    `features` property is removed from spec.md, conditional writes and the
    `epoch` stamp are baseline server requirements, `changes-query` is a
    service-description `features` token, and no `equality-query` token exists
  - encrypted-collections-spec: ECS-9. SHIPPED (2026-09-16): the identifier is
    `https://w3id.org/pws/encrypted-collections`, the current version is `0.1`,
    and the entry's `features` array carries `blinded-index-query` and
    `governed-history-logs`, whose definitions now live in that spec's Service
    description section. This item is unblocked
  - was-client: WCL-106. SHIPPED (2026-09-16, was-client 0.67.0): the
    backend-descriptor feature probe is deleted in full, the degraded paths it
    paid for are gone (insert is always the atomic `If-None-Match: *` PUT), and
    `changes-query` is documented as server-wide. Re-adding a
    `blinded-index-query` gate over the WAS-EC version entry is WCL-107 there, a
    new mechanism blocked on ECS-9 rather than a survivor of WCL-106
  - was-conformance-suite: SHIPPED (2026-09-16, 0.21.0, published and consumed
    here): ungates the conditional-write checks, moves the `changes-query` gate
    to the service description, gates the three encrypted-collections suites on
    the WAS-EC entry, and drops the descriptor `features` assertions
- acceptance:
  - [x] `serverBackendDescriptor` (`src/lib/backends.ts`) stops returning a
        `features` array, and `SERVER_BACKEND_FEATURES` is deleted along with
        its doc comment
  - [x] `sanitizeBackendRecord`, `parseBackendRegistration`, and
        `buildBackendRecord` (`src/lib/backends.ts`) drop the `features` field:
        a BYOS registration body carrying `features` is no longer read, and a
        stored `StoredBackendRecord` no longer carries the field
  - [x] `changes-query` joins `SERVICE_FEATURES` (`src/serviceDescription.ts`)
  - [x] `equality-query` is dropped everywhere: the token comment in
        `src/lib/backends.ts`, and the two tests that assert it
        (`test/equality-query-api.test.ts:802-813`)
  - [x] `buildServiceDescription` (`src/serviceDescription.ts`) lists a third
        `specs` key, `https://w3id.org/pws/encrypted-collections`, carrying one
        entry: `version` `0.1`, the spec `url`, and a `features` array of
        `blinded-index-query` and `governed-history-logs`. The identifier,
        version, and spec URL join the constants in `config.default.ts` beside
        `AUTHZ_PROFILE_IDENTIFIER`, and the entry gets its own type beside
        `AuthzProfileVersionEntry` in `src/types.ts`. Both tokens come off the
        Backend descriptor in the same edit. Done: the constants are
        `ENCRYPTED_COLLECTIONS_IDENTIFIER` / `_VERSION` / `_URL`, the token list
        is `ENCRYPTED_COLLECTIONS_FEATURES`, and the type is
        `EncryptedCollectionsVersionEntry` (local until storage-core carries it
        beside its two siblings)
  - [x] The two advertisement tests return, rewritten against the WAS-EC version
        entry rather than `backend.describe().features`: one asserting
        `blinded-index-query` is listed (was
        `test/blinded-index-query-api.test.ts:263-265`), one asserting
        `governed-history-logs` is listed (was
        `test/governed-log-api.test.ts:654-657`).
        `test/service-description-api.test.ts` covers the entry's shape -- the
        key, the single entry, `version`, `url`, and both tokens
  - [x] `test/backends-api.test.ts:49`, `test/collection-api.test.ts:499-526`,
        and `test/spaces-api.test.ts:1013-1060` no longer assert a `features`
        array on a Backend descriptor
  - [x] ARCHITECTURE.md's Backends paragraph (around line 178, the
        `serviceDescription.ts` entry) and the filesystem/postgres `describe()`
        doc comments stop pointing at `SERVER_BACKEND_FEATURES`
        (`src/backends/filesystem.ts:414-420`,
        `src/backends/postgres.ts:522-524`) and instead state the server-side
        emulation contract: the server serializes writes itself and mints its
        own opaque validator over a storage engine offering no precondition
        primitive of its own, and a content hash is an acceptable strong
        validator
  - [x] Every backend the server offers (filesystem, PostgreSQL, and any
        registered `external` BYOS backend) honors `If-Match` and
        `If-None-Match: *` on a Resource write unconditionally, with no token
        gating that behavior
  - [x] was-conformance-suite: a check that every backend listed at
        `GET /space/:spaceId/backends` honors both preconditions on a Resource
        write, which needs a fake BYOS provider fixture to cover an `external`
        backend. Dropped as not needed: the preconditions are evaluated in the
        server, atomically with the write it serializes, before any backend is
        reached. Enumerating backends would re-test one code path once per
        registered backend and prove nothing about a storage engine. The
        existing conditional-write checks already cover that path
  - [x] was-conformance-suite: the existing suites that gate a check on a
        Backend-level token (`conditional-writes`, `changes-query`) re-gate on
        the service description instead

Context: the spec's Backend `features` array let a client-registered storage
engine opt out of guarantees the server can always provide, since the server --
not the storage engine -- serializes every write and mints the validator.
WASS-40 removed that vocabulary from the spec: conditional writes and the
`epoch` stamp are now baseline requirements of every backend a Collection may be
created on, `changes-query` moves to the service description because it varies
by whether a server keeps an ordered change log at all rather than by backend,
`equality-query` never had a defined token and is dropped, and
`blinded-index-query` / `governed-history-logs` move to the WAS-EC version entry
because they are optional affordances of that companion spec rather than of a
storage engine.

This server predates that decision: `SERVER_BACKEND_FEATURES` in
`src/lib/backends.ts` lists all seven tokens including `equality-query`,
`serverBackendDescriptor` stamps every server-configured backend with the full
list, and BYOS registration (`parseBackendRegistration`, `buildBackendRecord`)
accepts and stores a client-supplied `features` array with no vocabulary check
at all. Six tests across `test/backends-api.test.ts`,
`test/collection-api.test.ts`, `test/spaces-api.test.ts`,
`test/equality-query-api.test.ts`, `test/blinded-index-query-api.test.ts`, and
`test/governed-log-api.test.ts` assert against that array. Removing it is a
breaking change to the descriptor shape any deployed client reads, accepted
under the same greenfield stance the spec decision names.

This is spec-alignment work rather than new behavior: every backend this server
ships (filesystem, PostgreSQL) already serializes writes under its own lock and
already honors both preconditions unconditionally, so the guarantee itself does
not change, only its advertisement. The BYOS registration path is the one place
`features` currently does real work (a client-supplied array persisted
verbatim), and that path has no live external adapter yet, so dropping the field
there has no runtime backend to break today.

Interim state (2026-09-16): the three suites whose token moves to the WAS-EC
entry -- `chunked-streams`, `blinded-index-query`, `governed-history-logs` --
gate on a probe of the endpoint they test, reading `501 unsupported-operation`
as "not served". ECS-9 has since landed, so the probe gives way to the WAS-EC
entry check. `chunked-streams` has no replacement token: under ECS-9 a listed
entry is itself the claim that the chunk endpoints are served, so that suite
gates on the entry's presence rather than on any token.

### WSS-113: A fake BYOS provider adapter, so an `external` backend can be exercised

- status: done
- done: 2026-09-16
- priority: medium
- labels: backends, conformance, testing
- blocked-by: WSS-111
- touches:
  - unaffected: was-conformance-suite (nothing filed there: WSS-111 dropped the
    per-backend precondition check rather than deferring it here, so no fixture
    registering a fake provider is needed)
- acceptance: withdrawn 2026-09-16, closed without being built (see Context).
  None of the criteria below were met or are still sought:
  - [ ] An in-memory provider adapter, registered only under a test or
        development flag, gives a registered `external` backend a live data
        plane instead of failing closed in `lib/backendRegistry.ts`
  - [ ] A Collection created on that backend round-trips a Resource write and
        read through the adapter
  - [ ] was-conformance-suite: the deferred check -- every backend listed at
        `GET /space/:spaceId/backends` honors `If-Match` and `If-None-Match: *`
        on a Resource write -- runs against both the server `default` and the
        registered `external` backend

Context: discovered-from WSS-111. That item's acceptance asks the conformance
suite to check every listed backend honors both write preconditions, which needs
an `external` backend with a data plane to write through. This server registers
no provider adapters, so a registered `external` backend is selectable but
inert, and the check has nothing to exercise. The guarantee it would assert --
the server serializes the write and evaluates the precondition atomically with
it, whatever the storage engine offers -- is exactly the one that most needs a
non-server backend to be meaningful, since it is the case the removed `features`
vocabulary used to let a backend opt out of.

Closed 2026-09-16 without being built, as not needed. The guarantee it would
have exercised does not depend on the storage engine: the server evaluates
`If-Match` / `If-None-Match: *` itself, atomically with the write it serializes,
before any backend is reached. A fake provider adapter plus a per-backend loop
in the conformance suite would re-run one server code path once per registered
backend. The conditional-write checks already cover that path, and WSS-111
closed with this box dropped rather than deferred here.

### WSS-122: Bound request bodies before authorization, and let `MAX_UPLOAD_BYTES` govern them

- status: done
- done: 2026-09-17
- priority: high
- labels: security, availability, limits
- discovered-from: whole-codebase review (2026-09-17), verified (one chunked 400
  MiB request took RSS to 1.37 GB before the 413)
- acceptance:
  - [x] `captureRawBody` stops accumulating at the effective body limit and
        refuses the request there; Fastify's `bodyLimit` never sees a byte it
        has already buffered past the limit
  - [x] The buffered-parser limit (`application/json`, `+json`, `text/*`) is
        derived from `maxUploadBytes` rather than Fastify's 1 MiB default, or
        the two limits are documented as distinct with a config knob for the
        JSON one; the governed-log `PUT` no longer pins to 1 MiB under
        `MAX_UPLOAD_BYTES=unlimited`
  - [x] Multipart `limits` gain `fields` and `fieldSize` (the write path uses no
        fields)
  - [x] A body-too-large refusal is the registered `payload-too-large` problem,
        not `internal-error` with an empty `errors` entry
  - [x] Tests: a chunked over-limit JSON body is refused with bounded memory; a
        2 MiB JSON Resource write under the default `maxUploadBytes` succeeds

`captureRawBody` hands Fastify one buffer at `end`, so `bodyLimit` (enforced by
the content-type parser, downstream of `preParsing`) applies only after the
whole body is resident; a chunked request has no `content-length` shortcut. The
hook runs before any signature is verified. Separately, `createApp` never sets
`bodyLimit`, so JSON and text writes are capped at 1 MiB while the same bytes as
`application/octet-stream` (the unbuffered `'*'` parser) succeed up to 64 MiB,
and the quota report advertises the larger figure. The repo's upload-cap tests
pin `MAX_UPLOAD_BYTES` below 1 MiB, so they cannot see this.

### WSS-141: One masked-denial body, byte for byte

- status: done
- done: 2026-09-18
- priority: high
- labels: security, errors, spec-conformance
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/errors.ts` (`NotFoundError`, `DenialError`, `KeystoreNotFoundError`,
    `UnauthorizedError`), `src/requests/spaceContext.ts`,
    `src/requests/keystoreContext.ts` (shipped: byte-identical bodies, no change
    needed in `spaceContext.ts` / `keystoreContext.ts` beyond what the error
    classes already carry)
  - conformance-suite: an assertion that the absent-target and under-authorized
    404 bodies are identical (PWSCS-13 filed in that repo's roadmap; the
    published `space.create-post-conflict-preserves-original` case also needs
    re-signing as the body controller, since Create Space's `id-conflict` check
    now runs after consent verification)
- acceptance:
  - [x] The absent-Space and the failed-authorization 404 share one `title` and
        one `detail` string; same for the keystore pair
  - [x] A test compares the two bodies for a Space, a Collection, a Resource and
        a keystore, anonymous and with unverifiable auth headers
  - [x] `RevocationRequest`'s body-shape and chain 400s, and
        `SpacesRepositoryRequest.post`'s `id-conflict` 409, run after signature
        verification, so a caller without a verifying signature cannot tell an
        existing Space from an absent one by status
  - [x] A `did:webvh` resolution or method-lookup failure inside `getVerifier`
        surfaces as the masked 404, not a 400

Both 404s share status and `type`, but "Space not found or invalid
authorization." versus "URL not found or invalid authorization." (and a trailing
period on one title) tell an unauthenticated caller whether the Space exists.
Space ids are embedded in every self-hosted `did:webvh`, so polling
`GET /space/<S>/meta` turns Delete Space into an observable event. The spec's
access-control section makes indistinguishability a MUST.

### WSS-148: The `zcaps` segment comments argue from depth, which is wrong

- status: done
- done: 2026-09-18
- priority: low
- labels: cleanup, docs, routing
- discovered-from: was-client WCL-94 (2026-09-18)
- acceptance:
  - [x] `spaceRevocationsPath`'s header in `src/lib/paths.ts` no longer claims
        the `zcaps` segment is deeper than any Collection or Resource route
  - [x] The same claim above the `app.post` registration in `src/routes.ts` is
        corrected with it
  - [x] Both comments state the reasons the segment cannot be shadowed that
        routing actually rests on

Comment-only. `/space/:spaceId/zcaps/revocations/:revocationId` sits four
segments under `/space`, and both comments conclude from that depth that it
"shadows neither and needs no reserved-id entry". The depth is not greater than
a Collection or Resource route: `/space/:spaceId/:collectionId/:resourceId/meta`
is also four, and `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex`
is five. The conclusion holds, but not for the stated reason, so the comment
teaches a rule that does not generalize -- the same faulty argument would
license a new two-segment reserved prefix that really would collide.

Three things do keep a Collection named `zcaps` from reaching the route.
Fastify's radix router prefers a static segment over a parametric one at the
same position, so `zcaps` wins over `:collectionId`. The final segment is a zcap
id, an absolute URI, so it never equals one of the reserved sub-resource
segments (`meta`, `policy`, `chunks`) a Resource route reads in that position.
And the two are method-disjoint: revocation is `POST`-only, while the Resource
sub-resource routes at that depth answer `GET` / `PUT` / `DELETE`. Confirm the
router-precedence half against find-my-way before writing it down.

The client repeated the same argument in `was-client`'s own
`src/internal/paths.ts` and has corrected it (WCL-94, 2026-09-18); this is the
server half.

Resolution: both comments rewritten. `spaceRevocationsPath`'s header in
`src/lib/paths.ts` carries the argument; the `app.post` comment in
`src/routes.ts` states the method point and refers to it. The reasoning in the
Context above was itself half wrong, and the rewrite does not repeat it. A probe
of the live route table with `fastify.findRoute` shows that
static-beats-parametric precedence is method-scoped: find-my-way falls back to
the parametric branch when the static branch serves no handler for the method,
so `GET`, `PUT` and `DELETE` at `/space/s/zcaps/revocations/meta` all reach the
Resource routes with `collectionId: 'zcaps'`, and `POST /space/s/zcaps/` still
adds a Resource. The absolute-URI point was wrong too: the final segment is a
free parameter, so `POST /space/s/zcaps/revocations/meta` binds
`revocationId: 'meta'` and reaches this route. Method-disjointness is the whole
of it. PWS registers no other `POST` four segments under `/space` -- the only
handler there is the 405 `refuseUnimplementedMethods` synthesizes for Resource
metadata, which this route takes over for the `zcaps`/`revocations` id pair
alone. That single overlap is now stated in the comment rather than papered
over.

Scope note: the item said comment-only, but a comment asserting a routing
invariant with nothing pinning it is how the wrong one survived, so
`test/space-revocation-api.test.ts` gained a describe block, "the zcaps segment
shadows no Collection route", holding four `findRoute` assertions that cover
each claim. Suite green (1418 passed, 5 skipped, up from 1414), lint and
typecheck clean. Filed from was-client WCL-94, whose own copy of the argument
was corrected there.

---

### WSS-149: The delegated-clients clause admits POST

- status: done (2026-09-20)
- priority: medium
- labels: zcap, client-annex, export
- discovered-from: freewallet FW-530

The wallet backup export invokes `POST /space/{id}/export` on the client-annex
Space through the unlock record's `delegatedClients` delegation, which the
inspector clause's second bridge branch admitted only with `allowedAction`
within {GET, PUT}. The branch now admits {GET, PUT, POST}.

POST adds no authority a PUT holder lacked. Under a Space container it reaches
export, import, and Create Resource on each Collection container; a holder with
PUT already creates Resources by id, and Update Space Metadata is
controller-only whatever the actions carry. The wallet-side half is wallet-core
WC-249, which widens `DELEGATED_CLIENTS_DELEGATION_ACTIONS` at mint. Records
sealed before that carry the old pair, which this branch still admits.

`src/lib/clientAnnexClause.ts` (header comment plus the branch's `actionsWithin`
set), `ARCHITECTURE.md`, and `test/client-annex-clause-api.test.ts`, which
gained a cell admitting `['GET', 'PUT', 'POST']` and kept a refusal cell over a
set carrying DELETE.

---

### WSS-150: The Space export carries this server's Service Description

- status: done (2026-09-20)
- priority: medium
- labels: export, archive-layout, service-description
- discovered-from: freewallet FW-530

An account's Spaces may in future live on different servers. A per-Space archive
said nothing about the server that wrote it, so an importer could not read which
specification versions and feature set the contents were written under, or
refuse them, before writing anything. Every export now carries this server's
Service Description verbatim as the archive's `service.json` entry, beside
`manifest.yml`.

The Export Space handler builds the description with `buildServiceDescription`,
the same builder the `/service` route uses, and passes it to `exportSpace`; both
backends hand it to `packSpaceArchive`, which writes the entry. An app composed
without a `serverUrl` has no absolute URL to build a description from and
exports without the entry, as does a backend called directly outside a request.
`discloseVersion` is decorated onto the Fastify instance so the handler reads
the same switch the route does.

It is informational on import: `src/lib/importTar.ts` walks `space/` prefixed
entries and ignores it, which a new `buildImportPlan` cell pins.

`src/requests/SpaceRequest.ts`, `src/backends/filesystem.ts`,
`src/backends/postgres.ts`, `src/types.ts` (the `StorageBackend.exportSpace`
signature and the `discloseVersion` instance decoration), `src/plugin.ts`,
`src/lib/importTar.ts` (layout comment), `ARCHITECTURE.md`, plus cells in
`test/export-import-api.test.ts` and `test/importTar.test.ts`. The writer half
is `@interop/space-archive` SAR-3 (its optional `service` option and
`SpaceArchive.service`). The archive fixture is unchanged: an export run without
a description writes no entry, so `test/space-archive-fixture.test.ts` still
compares byte-identical.

---

### WSS-151: A fifth clause predicate for POST and PUT over a management zcap

- status: done (2026-09-20)
- priority: medium
- labels: zcap, client-annex, export
- discovered-from: freewallet FW-530

A transient wallet session holds, for each sibling unlock Space, the management
capability that Space's `did:key` controller delegated to the account did:webvh,
now carrying `['GET','PUT','DELETE','POST']`. The ladder VM may delegate from it
but not invoke it, so the session mints a single-verb child to its own bare
did:key: `POST` to invoke `POST /space/{id}/export` for the backup export.
Predicates 3 and 4 admit only DELETE-only and GET-only children, so such a child
was refused.

Predicate 5 admits it. The child's `invocationTarget` is the canonical
trailing-slash Space URL and equals the parent's unchanged; its `allowedAction`
is exactly `['POST']`, so a two-verb set never qualifies and neither does any
other verb. The parent must be a delegated capability rather than the Space's
synthesized root, its sole `controller` the delegator account, and the
controller DID of its own delegation proof the Space's stored controller (one
memoized Space Metadata read). So the parent is the management capability that
Space's controller granted the account, and the predicate widens who signs the
last link rather than what the account may do.

`ladderInvocationRefusal` needed no relaxing: `spaceOperationOf` classifies only
a `PUT` on a Space Metadata URL and a `DELETE` on a canonical Space URL, and
neither a `POST` at `/space/{id}/export` nor a `PUT` under the Space container
is either. The export route carries the default container rule and runs end to
end under the new shape.

A `PUT` branch for the restore's create-by-id was drafted beside it and
withdrawn before landing (`decisions/0002`, the second 2026-09-20 amendment): a
`PUT` child of the Space URL reaches every resource beneath the Space by prefix
attenuation, so a transient session on one credential could overwrite a
sibling's keyring record with no logged record of it. Create Space by Id is not
reachable on a `did:webvh` chain anyway -- `verifyBodyControllerConsent` threads
no `webvh` resolver context (WSS-131) -- and freewallet FW-531 re-adds a bounded
create-only shape when the restore's sibling stage lands.

`src/lib/clientAnnexClause.ts` (header comment, the predicate, the parent now
passed as a full chain capability with a `parentIsRoot` flag, the refusal
message), `ARCHITECTURE.md`, `decisions/0002` (a 2026-09-20 amendment), and
seven cells in `test/client-annex-clause-api.test.ts`. The wallet-side halves
are wallet-core's `SpaceCapabilityVerb` widening and freewallet FW-530.

### WSS-152: Space Metadata carries `backends`; import restores its user-writable members

- status: done (2026-09-20)
- priority: medium
- labels: spaces, backends, export-import
- discovered-from: freewallet FW-530
- touches:
  - storage-core: `SpaceMetadata.backends` and `ImportStats.spaceMetadata`
    (SC-8; needs a publish before this server can be published)
  - portable-web-spaces-spec: the Space Metadata Data Model's `backends` member,
    the user-writable / server-derived split, and the import bullet's restore
    rule (landed 2026-09-20)
  - space-archive: the checked-in fixture archive's Space Metadata entry carries
    `backends`, so the counterpart test still pins byte-identical exports
- acceptance:
  - [x] Every Space Metadata read carries `backends`, through one projection
        (`src/lib/spaceProjection.ts`) shared by Read Space, both create echoes,
        and the export archive entry
  - [x] A `backends` in a write body is dropped (`stampSpaceMetadata`)
  - [x] Import parses the archive's Space Metadata entry down to `type` and
        `name`, applies them only under a root invocation, and reports
        `spaceMetadata: 'restored' | 'skipped' | 'absent'`
  - [x] Both backends' import walks are identical on this path
  - [x] Tests in `test/export-import-api.test.ts`
  - [x] CHANGELOG entry, ARCHITECTURE.md

Two signed-off data-model changes. The backend description moves onto the Space
Metadata object so a client learns a Space's backends from the object it already
reads, and an archived Space Metadata object stops being inert: its
user-writable members are restored, but only for an invoker holding the Space's
root capability, since rewriting the Space's own description is the
controller's. The handler decides root from the verified invocation's
`Capability-Invocation` header (`isRootInvocation`), the same reading the
`controller-only` container rule makes.

### WSS-153: The service description lists the client annex profile

- status: done (2026-09-27)
- priority: medium
- labels: discovery, client-annex
- discovered-from: freewallet FW-180
- touches:
  - freewallet / wallet-core / dcw: the signup gate that refuses to publish a
    ladder verification method on a host whose service description lists no
    client-annex entry (freewallet FW-180, open)
  - app-connect-spec: the client annex profile text the entry's `url` will name
    (freewallet FW-205, open), and decision 0003's record of the clause's five
    predicates (freewallet FW-562, open)
- acceptance:
  - [x] `buildServiceDescription` lists `https://w3id.org/pws/client-annex` with
        one entry, `{ version: '0.1' }`, and no other member
  - [x] Tests in `test/service-description-api.test.ts`: the whole-document
        assertion and a cell pinning the entry to `version` alone
  - [x] `ARCHITECTURE.md`'s service description entry and the fail-open
        paragraph under the client-annex clause state the claim

The wire details were signed off 2026-09-26/27 under freewallet FW-180: the
identifier (provisional with the rest of the `pws` namespace), an entry of
exactly `version` and an optional `url` that a client treats as absent when it
carries any other member, and `0.1` meaning the clause as this server enforces
it today. The `url` is added when the profile text is published.

### WSS-154: Sandbox hosted pages served from Resources and chunks

- status: done
- done: 2026-09-27
- priority: high
- labels: security, serving
- touches:
  - freewallet (`deploy/nginx.conf.template`, ARCHITECTURE.md) -- until this
    lands, its proxy must add the header on the server's Resource and chunk
    routes, since it serves them on the wallet's origin; afterwards it must pass
    the header through unchanged. Its proxy adds the header now (the `/space/`
    entry of the `$was_csp` map, 2026-09-27). Once this ships, drop that entry
    and the "server does not send these headers yet" note in freewallet's
    `docs/deployment-fly.io.md`, or both proxy and server send the header. Done
    2026-09-27: the `/space/` entry is dropped and the docs say the proxy passes
    the server's header through. The wallet must not render fetched content as a
    `blob:` URL document or in an unsandboxed `srcdoc` or `about:blank` iframe,
    and its own CSP should allow scripts by nonce or hash rather than
    `script-src 'self'`
  - portable-web-spaces-spec -- whether Security Considerations says anything
    about hosted HTML on a wallet's origin is a spec decision
  - unaffected: was-conformance-suite (deployment hardening, not a protocol
    requirement, unless the spec text above adds one)
- acceptance:
  - [x] Every response on a PWS or `/kms` route carries
        `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-top-navigation-by-user-activation`,
        whatever the stored content type, except `application/pdf` (Chromium
        refuses to render a sandboxed PDF)
  - [x] The header never includes `allow-same-origin`
  - [x] Those responses carry no `X-Content-Type-Options: nosniff`, so a
        Resource stored with no type or a generic one is still sniffed
  - [x] The welcome page, `/common/`, `/service` and the CORS proxy are
        unchanged (JSON API responses were first left unchanged too; the hook
        moved group-wide on 2026-09-27 so a new route cannot miss it)
  - [x] Tests assert the header on a `text/html` Resource GET (signed, and
        anonymous under a public-read policy), a chunk GET, a HEAD, a Resource
        and a chunk 304 and 404, a JSON API response, a redirect and a 405, and
        its absence on a PDF and on the welcome page
  - [x] `docs/deployment-fly.io.md` drops its "the server does not send this
        header yet" caveats

Decided 2026-09-27, in choosing an origin layout for freewallet
(`docs/deployment-fly.io.md`, "Choosing an origin layout"). Freewallet moves its
server from `freewallet.cloud` onto `freewallet.me`, served through the wallet's
proxy, to remove the CORS preflights that dominated signup latency. A hosted
HTML Resource on that origin would otherwise run as the wallet, and its scripts
could read the wallet's `localStorage` and IndexedDB, key material included.
Anyone who can write a Resource could plant one.

The sandbox gives each hosted page an opaque origin. Pages keep scripts, the
DOM, WebCrypto and CORS `fetch()`, and lose all browser storage, cookies,
service workers and WebAuthn. That fits the current use, static pages. Hosted
apps with persistent state come later, and need either a content domain with
per-Space subdomains behind a navigation redirect, or storage the wallet grants
over `postMessage`. A grant flow has an identity problem to solve first. A
sandboxed page's messages arrive with origin `null`, so a wallet popup cannot
tell which page is asking.

The header is always on rather than a setting. The server cannot tell whether it
is deployed behind a wallet, and sandboxing a page on the server's own origin
costs only that page's storage. A setting to turn it off can come with a
content-domain layout, if one lands.

The default document for public Collections (WSS-64) is a Resource response and
must carry the header too. The CORS proxy's own headers stay WSS-124.

### WSS-123: CORS proxy: decide the SSRF check on the numeric address

- status: done
- done: 2026-09-27
- priority: high
- labels: security, cors-proxy
- discovered-from: whole-codebase review (2026-09-17), verified against a
  loopback service
- acceptance:
  - [x] `isBlockedIp` expands an IPv6 literal to 16 bytes and tests the embedded
        IPv4 of `::ffff:0:0/96`, `::/96`, `64:ff9b::/96` (NAT64) and `2002::/16`
        (6to4) with `isBlockedIpv4`; the dotted-quad regex stays as the
        DNS-result path
  - [x] Tests: `http://[::ffff:127.0.0.1]/`, `http://[::ffff:7f00:1]/`,
        `http://[::ffff:169.254.169.254]/` and `http://[64:ff9b::7f00:1]/` are
        refused 403

`isBlockedIpv6` matches an IPv4-mapped address only in dotted form, but the
WHATWG parser normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which no
prefix in the list matches. `dns.lookup` echoes the literal, the DNS pin is
built from it, and undici dials loopback. The endpoint is unauthenticated.

### WSS-124: CORS proxy: response hardening and cache-key hygiene

- status: done
- done: 2026-09-27
- priority: high
- labels: security, cors-proxy, caching
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/corsProxy.ts`; WSS-65 covers the same headers on served Resources
  - freewallet: drop the `/api/cors` entries of the `$was_csp` and
    `$was_nosniff` maps in `deploy/nginx.conf.template`, filed as FW-570
- acceptance:
  - [x] Every proxy reply carries `X-Content-Type-Options: nosniff`,
        `Content-Security-Policy: sandbox` (or `default-src 'none'`) and
        `Content-Disposition: attachment`, or the relayed `content-type` is
        restricted to a non-active allowlist; `Refresh` is dropped
  - [x] The response-cache and single-flight key is the fetched identity
        (origin + path + search, fragment stripped) with `Accept` normalized or
        omitted
  - [x] Replies vary on whatever request header still participates in the key
        (`Vary: Accept`), or `cache-control` from upstream is not relayed as
        `public`
  - [x] A test that an upstream `text/html` body is not executable on the proxy
        origin, and that two fragment variants of one URL share one upstream
        fetch

An upstream answering `text/html` with script is relayed verbatim on the PWS
origin, where the welcome page, static assets and any wallet frontend also live.
`url.href` keeps the fragment, so fragment variants of one URL each get their
own cache entry, their own in-flight slot and their own upstream fetch, each
buffering up to 10 MiB.

Note 2026-09-27: in the same-origin layout `docs/deployment-fly.io.md` now
recommends, `/api/cors` is served on the wallet's origin. A link to it can then
run any third party's HTML as the wallet, with no write grant needed. The
decided header set there is
`Content-Security-Policy: default-src 'none'; sandbox` plus
`X-Content-Type-Options: nosniff`. Until this lands, the wallet's proxy should
add them. Freewallet's does (the `/api/cors` entries of the `$was_csp` and
`$was_nosniff` maps in `deploy/nginx.conf.template`); once this ships, drop
those entries there.

### WSS-117: Guarded create on the `PUT /space/:spaceId/meta` create branch

- status: done
- done: 2026-09-27
- priority: high
- labels: security, consent, consistency
- discovered-from: whole-codebase review (2026-09-17), verified (28 of 30
  concurrent create pairs ended with the second writer's controller)
- acceptance:
  - [x] The create branch of `SpaceRequest.putMeta` passes `ifNoneMatch: '*'` to
        `writeSpace` unconditionally, as `SpacesRepositoryRequest.post` already
        does; a header-less loser is re-run once as an update, authorized
        against the winner's stored controller (amended 2026-09-27, see note)
  - [x] The `type` immutability check runs against the record the write actually
        observed, not the pre-verification read
  - [x] A test drives a `POST /spaces/ {id: X}` and a self-signed
        `PUT /space/X/meta` concurrently and asserts the stored controller is
        the winner's, whichever wins
  - [x] The comment claiming a concurrent create "surfaces here as 412" holds
        without a client-supplied header

The branch decision (authorize against the stored controller, or against the
body's own controller via `verifyBodyControllerConsent`) is made on an unlocked
read, and the write carries a precondition only when the client sent one. An
attacker PUTs `controller: attacker` for an id the victim is creating; the
victim's guarded create lands first; the attacker's unconditional write replaces
it. The victim got a 201 and now owns nothing. The same path bypasses the `type`
immutability check.

Note 2026-09-27: the criterion first read "maps the 412 the same way", which
would have answered the loser with `id-conflict` (409) as Create Space does. The
spec rules both 409 and a header-less 412 out for this operation. A `412` arises
only from an explicit precondition header, `id-conflict` is for a `POST` create,
and an unconditional `PUT` stays last-writer-wins. Serialized after the winner,
the loser's `PUT` is an update, which the spec requires be verified against the
stored controller. So it is re-run as one: another caller gets the masked 404,
and the same controller gets a 204, or a 400 if its `type` differs. The `type`
check moved into a new `writeSpace` `assertTransition` hook in both backends.

### WSS-155: Pin the `PUT /space/:spaceId/meta` update branch to the Space it authorized against

- status: done
- done: 2026-09-27
- priority: low
- labels: security, consistency
- acceptance:
  - [x] The update branch of `SpaceRequest.putMeta` refuses to write when the
        object `writeSpace` re-reads under its lock is absent or carries a
        different `metaGeneration` than the pre-read it authorized against, and
        re-runs the request once on the branch the fresh read selects
  - [x] A test deletes and re-creates a Space under another controller between
        the pre-read and the write, and asserts the new controller's Space is
        untouched

discovered-from: WSS-117. The update branch authorizes against the stored
controller of an unlocked pre-read, and without a client `If-Match` its write is
unconditional. If the Space is deleted and re-created under the same id by
another controller in that window, the former controller's update replaces the
new Space's Metadata object, `controller` included. The window needs the former
controller's own delete to land inside its own in-flight `PUT`, so the risk is
low. The `assertTransition` hook `writeSpace` gained in WSS-117 can carry the
generation check.

Note 2026-09-27: the check compares the full validator, generation and version,
rather than the generation alone, so a concurrent controller change is caught
too. The create branch is pinned the same way (the Space must still be absent),
which replaced the forced `If-None-Match: *`. The client's own preconditions now
reach the backend as sent. The re-run is bounded at three attempts rather than
one, and then answers 503 with `Retry-After: 1`.

### WSS-156: Pin the import's Space Metadata restore to the object it read

- status: done
- done: 2026-09-27
- priority: low
- labels: consistency, import
- acceptance:
  - [x] Both backends' import restore of the Space Metadata object writes only
        when the object under the write lock still carries the validator of the
        one it composed from, and otherwise re-reads and re-composes
  - [x] A test lands a controller change between the import's read and its
        write, and asserts the controller change survives

discovered-from: WSS-155. The restore composes its write from an unlocked
`getSpaceMetadata` read and writes it with no precondition. An Update Space
landing in between, a controller promotion included, is silently reverted.

Note 2026-09-27: only the filesystem backend needed the change. The Postgres
import takes the Space Metadata advisory lock before it reads the row, so its
read and write were already atomic. The filesystem restore gives up after three
attempts with 503 and `Retry-After: 1`, as Update Space does.

### WSS-114: Protect a promoted Space's `did.jsonl` from overwrite, rollback, and delete

- status: done
- done: 2026-09-27
- priority: high
- labels: security, webvh, authorization, log-continuity
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/requests/ResourceRequest.ts` (`put`, `delete`),
    `src/lib/governedLog.ts` (the fast-forward rule to reuse),
    `src/lib/webvhController.ts` (`resolveVerifiedDocument`, `reviseEntry`)
  - ARCHITECTURE.md's self-hosted `did:webvh` section
  - unaffected: portable-web-spaces-spec (the rule is wallet-specific, so the
    authz profile does not state it; the reasoning is recorded in
    portable-wallet-profile-spec's Security considerations, "A history log only
    grows at its host")
- acceptance:
  - [x] A `PUT` of `did.jsonl` in any Collection is accepted only when the
        stored bytes are a prefix of the incoming bytes (the same fast-forward
        rule `governedLog.ts` applies to `meta/log`); a body that shortens or
        rewrites the log is refused 412
  - [x] A `DELETE` of `did.jsonl` is refused while any stored Space or keystore
        controller names a DID anchored at that location, or unconditionally
        (decide which; the second is simpler and matches "the log is a Resource
        like any other" only for reads) -- decided: unconditionally, in every
        Collection, as 405 `about:blank` with `Allow: GET, HEAD, PUT`
  - [x] The resolver records the last-resolved head (entry count or version id)
        per log location and refuses a log that does not extend it
  - [x] Tests: a retired client's subtree grant cannot roll the log back to a
        version that still lists its key; a subtree grant cannot delete the log;
        a legitimate append still resolves
  - [x] ARCHITECTURE.md states that deleting the Collection holding a
        controller's log deadlocks the Space with no break-glass

Today `did.jsonl` is an ordinary Resource. `ResourceRequest.put` and `delete`
carry no container rule and no continuity rule, and their only log-specific step
is dropping the resolver cache, so the damage takes effect on the next request.
Two consequences. A `PUT` of unrelated bytes or a `DELETE` leaves the Space's
stored controller unresolvable, and every invocation, including the controller's
own, is a 404; the only repair (`PUT /space/S/meta` back to a `did:key`, or
restoring the log) authorizes against the broken controller.
`SpaceRequest.putMeta` guards this at promotion time only. And every prefix of a
valid webvh log is itself a valid log with the same SCID, so
`resolveVerifiedDocument` accepts a truncated log: a client whose key was
retired in entry 10, still holding the ordinary generation delegation on the
Space subtree, PUTs entries 1..9 over 1..10, its key is back under
`capabilityInvocation`, and it root-invokes `PUT /meta` to take the Space. The
governed history log has a fast-forward rule precisely so a write grant can add
history but not erase it; the DID log, which is the Space's authorization root,
has none.

Outcome: the resolver's head record (entry count plus head `versionId`, per DID,
in memory) survives cache invalidation and imports, and is dropped only when the
log's Collection or Space is deleted. A restore re-creates the Space and imports
an older log by design, so a record that outlived the Space would refuse it. An
append whose new entries fail verification still passes the prefix rule and
leaves the controller unresolvable; see WSS-157.

### WSS-157: Refuse a `did.jsonl` append that does not verify

- status: done
- done: 2026-09-27
- priority: medium
- labels: security, webvh, log-continuity
- discovered-from: WSS-114
- touches:
  - `src/lib/webvhLogWrite.ts`, `src/lib/webvhController.ts` (shipped:
    `verifyWebvhLog`, shared by resolution and the write rule)
  - ARCHITECTURE.md's self-hosted `did:webvh` section (shipped)
  - portable-wallet-profile-spec: the "A history log only grows at its host"
    consideration names this gap (shipped: the section now states the
    verify-on-append rule)
- acceptance:
  - [x] A `PUT` of `did.jsonl` that extends a stored log is refused 400
        `invalid-request-body` unless the new body verifies as a `did:webvh` log
        for the DID the stored log resolves to
  - [x] A create (no stored log) is unaffected
  - [x] Tests: an append of a tampered entry is refused and the controller still
        resolves; a legitimate append still succeeds

The fast-forward rule keeps the stored bytes, but an append of junk or of an
entry whose proof fails still leaves the controller unresolvable, and every
invocation on the Spaces it controls fails. Verifying on write costs one full
log verification per `did.jsonl` write.

The DID is read off the stored log's head entry (`state.id`), and the whole new
body is verified against it; the stored log is not re-verified, since the body
carries it verbatim. A stored `did.jsonl` that names no DID cannot be appended
to. A deactivating append verifies and is accepted.

### WSS-115: Container rule for Update Keystore

- status: done (2026-09-27)
- priority: high
- labels: security, kms, zcap, authorization
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/requests/KeystoreRequest.ts` (`update`),
    `src/requests/keystoreContext.ts` (`fetchKeystoreAndVerify`), `src/zcap.ts`
    (the `controller-only` header short-circuit): shipped
  - ARCHITECTURE.md's container-rule paragraph: shipped
- acceptance:
  - [x] `POST /kms/keystores/:keystoreId` refuses every delegated invocation off
        the `Capability-Invocation` header, the way `PUT /space/<S>/meta` does;
        a direct root invocation by the stored controller still succeeds
  - [x] Tests: a delegated capability on the keystore URL with
        `allowedAction: ['write']`, and one with no `allowedAction`, are both
        refused with the masked 404; key operations under the same grants still
        work

`fetchKeystoreAndVerify({ allowedAction: 'write' })` passes no `containerRule`,
so a delegated write grant, or the action-less "full keystore" delegation, POSTs
a new `controller`. The original controller's invocations become 404s, and
revocation is impossible since the root capability's controller is now the
attacker. Every custodial key in the keystore is permanently the attacker's.
This is the hazard the PWS container rule closes for `PUT /space/<S>/meta`, with
no `/kms` analogue.

### WSS-116: Resolve a proposed `did:webvh` keystore controller before storing it

- status: done (2026-09-27)
- priority: high
- labels: kms, webvh, ceremony
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] `KeystoreRequest.update` runs the same pre-store resolvability check
        `SpaceRequest.putMeta` runs (`resolveWebvhController`, refused with
        `UnresolvableControllerError`) when the proposed controller is a
        self-hosted `did:webvh`
  - [x] Tests: promotion to a DID whose log is absent is refused and the
        keystore stays under its `did:key`; promotion to a published log
        succeeds
  - [x] `validateDid.ts`'s comment on `assertValidSpaceController` names the
        keystore path as covered

`assertValidSpaceController` is syntactic only. A typo in the seven-segment DID
or a torn promotion ceremony (log not yet published) stores an unresolvable
controller, after which no request can authorize on the keystore and every key
record in it is inaccessible. There is no delete route (WSS-70) and no rotation
path that does not verify against the dead controller. With WSS-115 open, a
delegate can inflict this on the controller.

### WSS-119: Digest stream: handle the transform's error and drain it on early rejection

- status: done
- done: 2026-09-27
- priority: high
- labels: security, availability, digest
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] `captureRawBody` attaches an `error` listener to `DigestVerifyStream`
        (or destroys the wrapped payload) so a digest mismatch on a body the
        handler never consumed cannot become an uncaught exception
  - [x] A test sends a streamed body with a mismatching `Digest` and well-formed
        but unverifiable auth headers, and asserts the server answers 404 and
        stays up
  - [x] `start.ts` installs an `uncaughtException` / `unhandledRejection`
        handler that logs through pino and exits non-zero, so the next such
        defect is loud in the log rather than a silent restart

When the handler rejects before reading `request.body` (bad signature, masked
404, 405, a container-rule refusal), the transform's readable side is never
drained and has no error listener. `_flush` throws on mismatch, `pipe`'s
dest-error shim re-emits on a listener-less stream, and the process dies. One
unauthenticated request per crash.

### WSS-120: Digest transform breaks multipart uploads

- status: done (2026-09-27)
- priority: high
- labels: digest, multipart, correctness
- discovered-from: whole-codebase review (2026-09-17), verified with a signed
  client
- acceptance:
  - [x] A signed `multipart/form-data` Resource write with a correct `Digest`
        succeeds (today every one answers 400 "missing a file part")
  - [x] The multipart body is still digest-bound: either the transform is
        bypassed for multipart and busboy's consumed bytes are hashed, or
        `@fastify/multipart` is fed the transform's output instead of
        `request.raw`
  - [x] `test/` gains a multipart create and update case (none exists today)

`captureRawBody` pipes `request.raw` into the transform at `preParsing`, which
puts it into flowing mode. `@fastify/multipart` reads `request.raw` directly
when the handler calls `request.parts()`, by which time the leading boundary and
part headers are gone. Since unsigned writes are 401, every multipart write
carries a `Digest` and hits this.

Shipped with the body-limit change: a signed multipart body is tapped rather
than piped (`verifyDigestOfTappedStream`), and the multipart write path awaits
`request.multipartDigest` before storing. `test/resource-api.test.ts` covers a
multipart create, a multipart `PUT` update, and a swapped body under a valid
signature.

### WSS-121: Gate Request Body Integrity on body presence, not `Content-Type`

- status: done (2026-09-27)
- priority: high
- labels: security, digest
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] `verifyBodyDigest` and `captureRawBody` treat a request as bodied when
        it carries `content-length` or `transfer-encoding`, whatever its
        `Content-Type`; a bodied request whose signature does not cover `digest`
        is refused 400
  - [x] Tests: `POST /space/S/import` and `PUT .../meta/log` with a body and no
        `Content-Type`, signed without `digest`, are refused
  - [x] Decide whether the catch-all `'*'` parser should keep accepting a body
        with no `Content-Type` at all

The gate is `if (!contentType) return`. The plugin's `'*'` parser routes a
bodied request with no `Content-Type` to the handler as a raw stream, so no
`Digest` is demanded and nothing is hashed. Import Space untars `request.body`
directly and the governed-log `PUT` reads it as text, so both accept a body the
signature never covered; a captured signature is replayable with a different
body inside its `(created)`/`(expires)` window. Resource writes are protected
only by `resolveResourceInput` refusing a missing `Content-Type`, a handler
accident rather than a hook guarantee.

Resolution: `verifyBodyDigest` treats a request as bodied when it carries a
`Content-Type`, a `Transfer-Encoding`, or a non-zero `Content-Length`.
`captureRawBody` needed no change, since it already hashes a streamed body
whenever a `Digest` is sent. On the third point, the catch-all parser keeps
matching every media type, but a bodied request with no `Content-Type` never
reaches it: the hook refuses it as `missing-content-type` (400), the error the
spec already names for a Resource write without one. So the Import Space and
governed-log tests are refused with that type rather than
`invalid-authorization-header`. The conformance case for a Resource write with
no `Content-Type` still gets `missing-content-type`.

### WSS-125: Re-check container existence inside the write lock

- status: done
- done: 2026-09-27
- priority: high
- labels: filesystem-backend, consistency, security
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] `writeResource`, `writeChunk`, `writeCollection`, `writePolicy` and the
        import path refuse (404) when the Space, and where applicable the
        Collection, has no Metadata object at the moment of the write, checked
        under the same gate the write holds; `mkdir -p` never recreates a
        container directory
  - [x] A test issues a write whose prelude passed, then a Delete Space, then
        lets the write proceed, and asserts no directory is left behind
  - [x] `writePolicy` on a Collection with no Metadata object is refused rather
        than materializing a phantom directory that `listCollections` then
        reports as a public Collection

The Space gate prevents a write interleaving with a removal, not a write whose
shared acquisition comes after the removal released the exclusive side. The
request layer's existence check is a TOCTOU. The result is `spaces/S/C/` holding
live Resources and no `.space.S.json`: invisible to every route and listing,
charged to quota forever, and adopted by the next Space created under id `S`,
whose controller then lists the previous owner's data. Postgres foreign keys
refuse the same insert, so the two backends diverge.

Resolution: the premise about Postgres did not hold. Its `writeResource`,
`writeCollection`, `writePolicy`, `writeBackend` and import provisioned
NULL-metadata placeholder rows (`#ensureSpaceRow` / `#ensureCollectionRow`), so
a write after a Delete Space recreated a placeholder Space row the next Create
Space adopted, the same as the filesystem. Both backends now refuse: the
filesystem checks the Metadata files under the Space gate
(`#assertContainersExist`), Postgres under the `spaces` row lock
(`#lockLiveContainers`), and the placeholder-creating helpers are gone. The
refusals are pinned in the shared contract suite. A consequence: a
`FileSystemBackend` used as a provider adapter must hold the Space and
Collection itself (`provisionProviderContainers` in the test helpers).

### WSS-130: Signal handling, graceful shutdown, and temp-file cleanup

- status: done
- done: 2026-09-27
- priority: high
- labels: operations, filesystem-backend, availability
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/start.ts`, `package.json` (`start` pipes through `pino-pretty`, so a
    supervisor's signal reaches the shell), `src/lib/atomicFile.ts`
    (`tempPathFor` has one call site and no sweeper), `src/backends/*.ts`
    (`close`), `src/corsProxy.ts` (`onClose`)
  - WSS-47 covers `start.ts` test coverage (`test/start.test.ts` now spawns the
    entry point for the signal, startup-failure, and port-warning paths; the
    rest of WSS-47 stays open)
  - unaffected: other repos (process lifecycle and env parsing only; no wire or
    `@interop/*` API change)
- acceptance:
  - [x] `start.ts` handles `SIGTERM` and `SIGINT` by calling `fastify.close()`
        with a drain timeout, so `onClose` hooks (Postgres `pool.end`, undici
        agents) actually run in production
  - [x] Orphan `.tmp-*` files left by a killed in-flight write are swept at
        backend `init()` or excluded from the `du`-based quota, and the streamed
        write path removes its temp file on `close`/`aborted`
  - [x] Startup failure writes its message before exiting on a piped stderr
        (`process.exitCode = 1` and let the process drain, rather than
        `process.exit(1)` after `console.error`)
  - [x] `PORT` and `SERVER_URL` are cross-checked at startup: a loopback
        `SERVER_URL` whose effective port differs from `PORT` is a startup error
        or warning (the reverse-proxy case with a public host stays allowed)
  - [x] The listen host is configurable (`HOST`, defaulting to Fastify's
        dual-stack `localhost` or documented as `0.0.0.0`), and README's dev
        invocation binds loopback
  - [x] `parsePort` and `parseLimit` accept decimal integers only

Nothing registers a signal handler; Node's default disposition terminates
immediately. A kill mid-upload leaves `.tmp-<uuid>` in the Collection directory,
invisible to every listing but charged against `STORAGE_LIMIT_PER_SPACE`
forever. `console.error` then `process.exit(1)` can drop the carefully worded
config error on a pipe, so a container that failed on a bad `KMS_RECORD_KEKS`
exits 1 with empty logs. The `PORT`/`SERVER_URL` mismatch is the one
misconfiguration that breaks every ZCap match and is the only one not checked.

Shipped: `start.ts` closes the app on either signal (10 s drain, a second signal
or the deadline exits 1). `FileSystemBackend.init()` sweeps `.tmp-*` files under
the Space, keystore, and revocation trees (`sweepTempFiles` in `atomicFile.ts`);
the streamed write path already removed its temp file on a client disconnect,
and a test now pins it. A loopback `SERVER_URL` on another port warns rather
than failing, so a local reverse proxy stays possible. `HOST` defaults to
`0.0.0.0`, as the Dockerfile and `fly.toml` need. `pnpm start` no longer pipes;
`pnpm start:pretty` does.

### WSS-131: Engage the `did:webvh` resolver on every verification path

- status: done
- done: 2026-09-27
- priority: medium
- labels: webvh, zcap, revocation, authorization
- discovered-from: whole-codebase review (2026-09-17), verified for List Spaces
- touches:
  - `src/zcap.ts` (`verifyRevocationChain`, `handleRevocationInvocationVerify`,
    `activeWebvhContext`), `src/requests/controllerConsent.ts`,
    `src/requests/SpacesRepositoryRequest.ts` (`list`),
    `src/requests/SpaceRequest.ts` (create-branch validator)
  - ARCHITECTURE.md's revocation and client-annex paragraphs (the annex GC
    "tolerates a refused revocation" note describes this defect): updated, and a
    new "`did:webvh` resolver on every path" paragraph under ZCap Structure
  - unaffected: other repos (no wire change; grants that already verified on
    invocation become revocable, and freewallet's annex GC revocation stops
    being refused)
- acceptance:
  - [x] Both revocation functions pass the caller's `webvh` context through
        unconditionally, as `verifyZcap` does; `activeWebvhContext` is removed
        or its remaining use justified
  - [x] `verifyRevocationChain`'s `expectedRootCapability` accepts the same
        roots `verifyZcap` synthesizes for the Space family (the Space URL and a
        Resource or Collection URL under it), so a grant that verifies on
        invocation can be revoked
  - [x] `verifyBodyControllerConsent` threads `webvh`, so a delegated
        provisioning chain with a `did:webvh` link verifies; the `PUT /meta`
        create branch validates the body controller with `assertValidController`
        (creation stays `did:key`-only, as ARCHITECTURE states) rather than the
        update-only validator
  - [x] List Spaces goes through `handleZcapVerify` with `webvh` and the chain
        inspectors, so a promoted Space appears in its own controller's listing
        and a delegated `GET /spaces/` is revocation-checked; decide whether a
        `/spaces/` revocation scope is needed, and cap the per-controller
        verification loop for an unauthorized delegated caller
  - [x] Tests: revoke a child grant signed by a `did:webvh` method on a
        `did:key` Space; a `did:webvh` delegee self-revokes; List Spaces for a
        promoted controller returns the Space

The revocation path narrows the resolver to the scope's controller, so on a
`did:key` Space (the unlock-Space shape) a chain with any `did:webvh`-signed
link verifies on every route but answers 400 at revocation, and a `did:webvh`
delegee cannot self-revoke under the dual-root rule. Such grants stay live until
their own `expires`. `verifyZcap`'s own comment names this case as the reason it
engages the resolver unconditionally. The same missing option makes consent
verification refuse a `did:webvh` controller the create branch's validator
admits, and makes a promoted Space vanish from List Spaces (`totalItems: 0`).

Shipped: `activeWebvhContext` is removed, and both revocation functions pass the
caller's context through. `verifyRevocationChain` accepts the scope's root plus
the submitted chain's own root when it targets a URL under the scope
(`expectedRevocationRoots`), so a Collection- or Resource-rooted grant is
revocable. Consent threads `webvh`, which also engages the client-annex clause
there. The `PUT /meta` create branch runs `assertValidController`. List Spaces
goes through `handleZcapVerify` with `'no-revocation-scope'` (decided: a
`/spaces/`-rooted chain has no route to revoke it at, and a listing grant
exposes only ids and names, so its `expires` bounds it). The loop is capped by
construction: candidates are pre-filtered to the one controller that can verify,
the root signer or the base delegation's signer (`baseDelegationSigner`, shared
with the consent triage). Tests in `test/webvh-verification-paths-api.test.ts`.

### WSS-159: Implement the `writerId` writer-attribution surface

- status: done
- done: 2026-09-28
- priority: medium
- labels: data-model, wire-contract, replication, changes-feed
- touches:
  - storage-core: `ResourceMetadata`, `ResourceSummary`, and `ChangeDocument`
    already carry `writerId` (landed there ahead of this item, unpublished as
    0.22.0; this repo consumes it via a `link:` dependency until published)
  - unaffected: portable-web-spaces-spec (the `#writer-attribution` section, the
    Resource Metadata `writerId` property, the `Writer-Id` header, and the
    changes-feed/tombstone text were already specified; this item is the
    reference-server implementation of existing spec text, not a spec change)
  - unaffected: wallet-core (the consuming client-side change is tracked in that
    repo's own roadmap, out of scope here)
- acceptance:
  - [x] `Writer-Id` request header accepted on every content write (`POST`
        Create Resource, `PUT` Update-or-Create-by-Id) and on `DELETE`
  - [x] Top-level `writerId` member accepted on Update Resource Metadata
        (`PUT .../meta`), alongside `custom` and `epoch`
  - [x] Declare-or-clear at every level: a write declaring a value stores it, a
        write declaring none clears any stored value -- including the
        metadata-write level, which is the opposite of `epoch`'s
        preserve-on-omission
  - [x] A present but empty or non-string value (an empty header, a non-string
        or empty-string body member) is `invalid-request-body` (400); the value
        is otherwise never verified, computed, or defaulted, and never reaches
        any authorization decision
  - [x] Echoed on `/meta` reads, List Collection item summaries, `changes` feed
        documents, and tombstones; a tombstone carries the label its own
        `DELETE` declared, not the Resource's prior label
  - [x] Implemented in both backends (filesystem sidecar, Postgres `writer_id`
        column added directly to the `resources` table -- no migration, this
        server carries no production data), including the export/import round
        trip
  - [x] `Writer-Id` needs no CORS `allowedHeaders` addition: the server sets
        none, so `@fastify/cors` already reflects any requested header

Implements the PWS spec's `#writer-attribution` section end to end, following
the `Key-Epoch` / `epoch` stamp's existing plumbing (`src/lib/keyEpoch.ts`,
`src/lib/metadataWrite.ts`, `src/lib/metaSidecar.ts`, both backends) as the
template, in a new sibling `src/lib/writerAttribution.ts` (`WRITER_ID_HEADER`,
`parseWriterIdHeader`, `parseMetaWriterId`). The one place its semantics diverge
from `epoch` is metadata-write omission: `epoch` describes the content write and
survives an omitted metadata-write member, while `writerId` describes "whichever
write produced this revision" and is cleared by an omitted member at every
level, DELETE included. Tests: a new `writer-attribution stamping (writerId)`
block in the shared `storage-backend-contract.ts` suite (run against both
backends) and a new `writer-attribution (Writer-Id header + /meta writerId)`
block in `test/encryption-descriptor-api.test.ts` (the header/body HTTP surface,
alongside the existing `Key-Epoch` block it mirrors).

### WSS-118: Onboarding-token gate covers Space creation by `PUT /meta`

- status: done (2026-09-29)
- priority: high
- labels: provisioning, security
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/provisioning.ts`, `src/routes.ts` (the `provisioningRoutes` list),
    `src/requests/SpaceRequest.ts` (create branch), README's provisioning
    section: shipped
  - was-conformance-suite: PWSCS-15 filed. Four cases create a Space by a
    self-signed `PUT`, so the suite fails against this server run with
    `WAS_ONBOARDING_TOKEN` set (CI's conformance job) until it ships
  - unaffected: portable-web-spaces-spec (onboarding requirements are
    provider-specific and out of scope there)
- acceptance:
  - [x] With an onboarding token or `authorizeProvisioning` configured, the
        create branch of `PUT /space/:spaceId/meta` is gated exactly like
        `POST /spaces/` (either honor `request.provisioningAuthorized` there, or
        refuse create-by-PUT while a provisioning policy is configured; decide
        which)
  - [x] Tests: with a token configured, a self-signed create-by-PUT without the
        token is refused; with the token it succeeds
  - [x] `authorizeProvisioning` returning anything other than `'grant'`,
        `'deny'`, or `'verify'` fails closed (500 or deny), not open
  - [x] An empty or whitespace `WAS_ONBOARDING_TOKEN` is a startup error or a
        logged warning, not silently open provisioning

The gate lists `/spaces` and `/spaces/` only. `PUT /space/<new>/meta` creates a
Space when absent and authorizes the create against the body's own controller,
so a fresh `did:key` provisions freely with no token, defeating both the token
and the per-controller cap (one `did:key` per Space costs nothing). README
promises the gate covers Space creation.

Resolution: the gate honors the policy on `PUT /space/:spaceId/meta` whenever
the Space is absent, so a valid Bearer token creates by `PUT` as it does by
`POST`. A gated route now carries an optional `provisions` predicate; this one
checks for the Space's Metadata object, so an update is never gated. If a Space
appears between the gate's check and the handler's read, a granted request is
refused with the masked 404, since it carries no invocation to authorize an
update. An unknown decision is refused as `deny` and logged. A set but empty
`WAS_ONBOARDING_TOKEN` fails startup, and an empty `onboardingToken` option
fails plugin registration. Unset stays open provisioning. Under a gate, a
create-by-`PUT` refusal tells the caller the id is free, which open provisioning
(a 201) and `POST /spaces/` with an `id` (a 409) already do.

### WSS-160: Filesystem backend store version and migration runner

- status: done (2026-09-29)
- priority: medium
- labels: backends, migrations, operations
- acceptance:
  - [x] The data root holds `store.json`, a JSON object whose `version` member
        is an integer naming the storage layout. It is a sibling of `spaces/`,
        `keystores/` and `space-revocations/`, so it cannot collide with a Space
        or Collection id
  - [x] An ordered, append-only list of migration functions in the backend,
        version `n` being entry `n - 1`, mirroring `MIGRATIONS` in
        `postgresSchema.ts`
  - [x] At startup the backend applies pending migrations in order, holding a
        lock that keeps two processes on the same data dir from both running
        them, and rewrites `store.json` (temp file plus rename) after each step
  - [x] Each migration step is idempotent, so a run interrupted before its stamp
        write is safely repeated on the next boot
  - [x] An empty data dir is stamped with the current version and needs no
        migration
  - [x] Startup refuses, with an error naming both versions, when `store.json`
        names a version higher than the code knows, or when it is absent over a
        non-empty data dir
  - [x] The applied version is logged at startup
  - [x] The migrations run inside the server process at boot, not from a Fly
        `release_command`: Fly runs that command in a temporary machine that
        does not mount the app's volume
  - [x] Tests: fresh dir stamped; pending step applied once; interrupted step
        re-run; newer-than-code refused; unstamped non-empty dir refused

The refusal on an unstamped non-empty data dir means the existing staging and
prod filesystem volumes cannot boot the release that ships this. Under the
greenfield stance they are wiped on that deploy rather than given a fallback
that treats an unstamped store as version 0.

### WSS-161: Postgres backend refuses a database newer than the code

- status: done (2026-09-29)
- priority: medium
- labels: backends, migrations, operations
- acceptance:
  - [x] `applyMigrations` in `src/backends/postgresSchema.ts` refuses, inside
        the same transaction and advisory lock, when `schema_migrations` holds a
        version greater than `MIGRATIONS.length`; the error names both versions
  - [x] The applied version is logged at startup
  - [x] Test: a database carrying a version past the code's list refuses to
        start

The migration runner already exists (append-only `MIGRATIONS`, the
`schema_migrations` table, an advisory lock, one transaction). It applies what
is missing but does not notice migrations it does not know about, which is what
an older build sees after a rollback. It would then run against a schema it was
not written for.

### WSS-7: Authenticated provenance across export/import (server DID + signed metadata)

- status: done (2026-09-29)
- priority: medium
- labels: data-model, security
- touches:
  - was-teaching-server: `src/serviceDescription.ts` (the two new members on the
    core version entry), `src/server.ts` / `src/start.ts` (seed env var, boot
    provisioning of the `server` Space), `src/lib/webvhController.ts` (resolving
    the server's own DID), the export path in both backends,
    `src/lib/importTar.ts`, a new admin script beside
    `scripts/reencrypt-kms-records.ts`, ARCHITECTURE.md (Glossary entry for the
    `server` Space and the server identity), `docs/admin-guide.md`
  - space-archive: the envelope entry in the archive layout and the embedded DID
    log snapshot; the reader side verifies, so the wallets that read a backup
    see the outcome
  - portable-web-spaces-spec: the server-DID anchor (how a server advertises its
    identity in the Service Description) and the normative reference from
    Export/Import to the container spec that owns the envelope (WASS-25 in that
    repo's roadmap)
- acceptance:
  - [x] The server derives its Ed25519 signing key from a seed held in an env
        var (the `KMS_RECORD_KEK` pattern) and advertises it as a `did:key` on
        the `instance` member of `/service` (`exportSigningKey`), from first
        boot
  - [x] The server's DID is the self-hosted
        `did:webvh:{SCID}:{host}:space:server:id`, whose log is the `did.jsonl`
        Resource of Collection `id` in Space `server`; the server provisions
        that Space at boot when absent, typed `AuxiliarySpace` plus
        `ServerInstanceSpace`, with the admin DID from an env var as its
        controller, so it is hidden from List Spaces; the id is reserved on
        every client create, configured or not
  - [ ] The server never mints or extends its own log; an admin script builds
        the genesis entry (`updateKeys` = the admin's `did:key`, the server key
        as a `verificationMethod` under `assertionMethod` only,
        `portable: true`) and `PUT`s it through the ordinary write path, and the
        same script appends the rotation and domain-move entries
  - [x] Once the resolved current document lists the advertised key under
        `assertionMethod`, `/service` also carries the server DID (second new
        member); while the log is absent or does not list the key, that member
        is absent, exports are unsigned, and the server logs a warning at boot
  - [x] The server key resolves under no other verification relationship, so it
        can neither root-invoke nor be read as a ladder or transient annex
        verification method by the client-annex clause; a test pins that
  - [ ] Export signs each Resource metadata sidecar and each Space and
        Collection Metadata object over a canonical serialization covering the
        server-managed fields and the resource content digest, referencing the
        DID log `versionId`, and embeds a snapshot of the DID log so archives
        verify offline; the signature envelope is signing-time-agnostic (no
        export-specific context in the signed bytes); chunked resources use a
        composite digest over the ordered chunk-digest list
  - [ ] Import verifies signatures: verified archives keep `createdBy`;
        unverified archives import with `createdBy` dropped, not rejected; the
        import report distinguishes "signature invalid" from "signature valid,
        content mismatch"
  - [ ] `docs/admin-guide.md` gains runbooks for provisioning the identity,
        restoring the log after a data wipe, rotating the seed, `SERVER_URL`
        migration, and compromise recovery

Raised 2026-07-09, while implementing server-managed `createdBy`. Design revised
2026-09-29; the earlier decisions it replaces are summarized under _Superseded
decisions_ below.

_The gap._ The server records a server-managed `createdBy` (the DID of whoever
created a Space, Collection, or Resource) and refuses to let a client set it:
every live write path strips a `createdBy` carried in a request body and
substitutes the verified invoker's DID. Within a running server that property
holds. It does not survive **export/import**. An exported archive carries the
on-disk representation: `.meta.<id>.json` sidecars, `.space.<id>.json` and
`.collection.<id>.json` Metadata objects, and resource bodies. On import the
server reads `createdBy` straight out of those entries and persists it. Nothing
authenticates them. So:

- A hand-crafted archive can attribute any Resource to any DID. The importer
  only needs write access to a Space of its own.
- Round-tripping through export/import launders provenance: the value that comes
  back out is whatever the archive said, not what any server ever observed.
- The same is true of `createdAt` and the monotonic `version`. `createdBy` is
  simply the first field where the forgery is _interesting_, because it names a
  party rather than describing a byte range.

Import cannot fix this by validating harder. Import must preserve `createdBy`,
which is what makes a backup a backup, so it necessarily trusts the archive.
Refusing to import a `createdBy` would break restore; accepting it means
accepting whatever the file says. The trust has to come from somewhere else.

_The shape of a fix._ Give the server its own DID and signing key, distinct from
any Space controller, and have it sign the metadata it claims authorship of:

- On export, the server signs each `.meta.<id>.json` sidecar and each Space and
  Collection Metadata object, over a canonical serialization that covers the
  server-managed fields (`createdBy`, `createdAt`, `version`, `metaVersion`) and
  the resource content digest.
- On import, the server verifies the signature. An archive whose provenance was
  signed by a server DID the importer trusts keeps its `createdBy`; one that was
  not, or that fails verification, is imported with `createdBy` dropped (absent
  = "not recorded", the semantics already defined) rather than rejected. That
  degrades cleanly: a hand-rolled archive still imports, it just carries no
  attribution it did not earn.
- Cross-server import then becomes meaningful: `createdBy` from server B is
  worth something to server A exactly insofar as A trusts B's DID.

This turns `createdBy` from a value the current server happens to remember into
a statement some named server actually made, in effect a verifiable credential
about a storage event.

_Design decisions (2026-09-29)._

- **DID method: self-hosted `did:webvh`.** `did:key` cannot express key history;
  `did:web` has no verifiable history. `did:webvh` gives both, and its log is
  self-certifying (SCID-bound, hash-chained, each entry signed by the previously
  authorized update key), so an export embeds a log snapshot and an importer
  verifies provenance offline, against the key epoch the envelope names, without
  the origin server being reachable. Minted with `portable: true` so a
  `SERVER_URL` migration keeps the SCID.
- **The DID is hosted in a reserved Space.** The DID is
  `did:webvh:{SCID}:{host}:space:server:id`, the self-hosted path form the
  resolver in `lib/webvhController.ts` already reads: its log is the `did.jsonl`
  Resource of Collection `id` in Space `server`. Nothing new resolves it. The
  log gets the existing fast-forward and verify-on-append rules, and the
  archive's embedded snapshot verifies with `resolveDIDFromLog`. The spec
  reserves no Space ids, so the server provisions `server` at boot, before any
  client can claim it, typed `AuxiliarySpace` plus a subtype of its own so List
  Spaces hides it. The name says the Space hosts the server's identity, not that
  the server controls it (next point).
- **Two keys: the admin manages the DID, the server only signs.** The log's
  `updateKeys` is the admin's own `did:key`; the server's key appears in the
  document as a `verificationMethod` referenced from `assertionMethod` and from
  no other relation. The `server` Space's controller is that admin DID, read
  from an env var at boot (public data, so the env-var surface is fine). The
  server never writes into the Space; the admin does, through the ordinary front
  door, with an admin script that fetches the server's advertised key, builds
  the genesis entry, and `PUT`s the log. Rotation, a `SERVER_URL` move, and
  compromise recovery are the same script appending entries. Consequences:
  server compromise is no longer DID compromise. An attacker with the box forges
  envelopes until the admin appends a rotation entry, and cannot take the DID
  over. The server key holds no `capabilityInvocation`, so it can never
  root-invoke, and no `capabilityDelegation`, so the client-annex clause's
  relation-asymmetry checks never classify it as a ladder or transient annex
  method. The server DID is not the admin identity: the DID that authorizes
  operator actions is the admin's, and the server's signing key never enters the
  admin tool.
- **The server key comes from a seed in an env var.** A Fly secret, as the KEK
  already is, derives the Ed25519 key. It survives reboots and data wipes, and
  every machine of an app carries the same key. The server advertises the key as
  a `did:key` on the `instance` member of `/service`, beside `name` and
  `source`: the members describe this deployment, not a specification it
  implements, so they do not belong on a `specs` entry, and not as a `features`
  token, since those name spec sections served. A second `instance` member
  carries the server DID once the resolved current document lists the advertised
  key under `assertionMethod`; its absence tells the admin script the server has
  no identity yet, and its appearance is the script's success condition. A new
  seed value is a new `did:key`; the admin appends an entry that adds the new
  method and drops the old, and archives signed before it keep verifying against
  the epoch they name. A leaked seed is bounded the same way.
- **No self-mint, and no first-boot rule.** The server cannot mint its own log,
  since it holds no update key, so there is nothing to fork on a restore. Boot
  is a check: log absent means no identity yet, exports go unsigned and the
  server warns; log present means the current document must list the seed's key
  under `assertionMethod`, else the server refuses to sign and warns. The
  `SERVER_URL` mismatch case is the same check, since the DID string carries the
  host: a log minted for another host does not resolve as this server's.
- **The log is admin-custodied state.** It lives in the data dir and dies with a
  wipe. The admin signs every entry, so the admin's copy (kept by the script) is
  the source of truth, and after a wipe the script re-`PUT`s it, same SCID, same
  DID. Excluding `spaces/server` from a wipe is a deployment convenience, not a
  correctness requirement. The resolver's anti-rollback head record is in memory
  and dropped with the Space, so a full restore lands. Backing up the log is an
  operator duty (admin guide), as is holding the update key.
- **Sign on export, not on write.** The cost of sign-on-write is not CPU
  (Ed25519 sign is microseconds; every authenticated request already does a zcap
  signature verification) but complexity: canonicalization on every write path
  in both backends, and since `version`/`metaVersion` bump on every write, each
  write re-signs and discards the previous signature, machinery that ends up
  holding exactly one signature per object, over its latest state, which is what
  a single export-time pass produces anyway. Nor does sign-on-write buy real
  tamper-evidence here: the seed is on the same box as the store, and an
  importer cannot tell when a signature was made, so the exported artifact's
  trust semantics are identical either way. The obligation this choice imposes:
  the canonical serialization and signature envelope must be
  signing-time-agnostic, a statement about the object (server-managed fields +
  content digest + DID log `versionId`) with no export-specific context (no
  export timestamp, no manifest reference) inside the signed bytes, so signing
  the same envelope at write time can be added later as an opt-in producing
  bit-compatible signatures. Triggers for revisiting: custody separation (a
  backend where the store lives with a party the operator does not fully trust,
  such as an external Postgres or BYOS metadata on Google Drive), and write
  receipts (see _Option value_).
- **The envelope binds the content digest.** The signature is a claim that "DID
  X created content with digest D"; leaving the content unbound would let an
  archive pair authentic metadata with substituted bytes. This chains to the
  existing Request Body Integrity enforcement: the server verified a
  client-signed multihash over the content at write time, so the digest it
  attests at export traces back to something the client signed. Same multihash
  encoding (sha-256, `mh=`) as the `Digest` header, for consistency and hash
  agility. Riders:
  - _Chunked resources_ get a composite digest over the ordered list of chunk
    digests, not the concatenated bytes, so verification stays streaming and
    per-chunk. (Consequence for write receipts: the full-content digest exists
    only once the last chunk lands, so a receipt is mintable at completion, not
    per-chunk.)
  - _Conflated failure is intentional but must be reported distinctly._ A
    corrupted body fails verification and drops `createdBy` just like a forgery.
    That is correct, since the attribution does not apply to different bytes,
    but import must distinguish "signature invalid" from "signature valid,
    content mismatch" in its logging/report, or operators debugging bit-rot will
    conclude signatures are flaky.
  - _Content-transforming migrations invalidate provenance._ Any future tool
    that rewrites bytes (re-encryption, plaintext/EDV conversion) must either
    re-attest over the transformed content or accept the drop.
  - _Omission stays invisible._ Every surviving envelope still verifies after an
    object is deleted from an archive. Completeness is inherently the export
    manifest's job (see _Option value_); the per-object envelope covers
    portability, not completeness. Complementary, not redundant.
- **Signer id in the envelope.** A proof's `verificationMethod` is
  `did:webvh:{SCID}:{host}:space:server:id#{fragment}`, the fragment being
  whatever the admin script gives the method (the library's `createVMID` default
  is the last 8 characters of `publicKeyMultibase`; the full multibase is the
  alternative). The verifier reads the method off the resolved document at the
  named `versionId`, so the choice only has to be consistent in the script. It
  is a wire decision.

_Wire decisions (approved 2026-09-29)._

- Env vars: `WAS_SERVER_KEY_SEED`, a 32-byte Ed25519 seed in bnid's
  secret-key-seed encoding (multibase base58btc over a multihash-wrapped seed,
  `z1A...`, what `generateSecretKeySeed()` mints and `decodeSecretKeySeed()`
  reads; unset: no signing key, no key member on `/service`, unsigned exports);
  `WAS_ADMIN_DID`, a `did:key` string, the controller of the `server` Space
  (unset: the Space is not provisioned and the identity path is off). The Space
  id `server` is reserved unconditionally: a client create naming it is
  `reserved-id` (409) whether or not the identity is configured.
- `/service` members, on the document's `instance` member beside `name`,
  `source` and `homepage`: `exportSigningKey`, the `did:key` of the seed's key,
  present whenever the seed is set; `serverDid`, the server's `did:webvh`
  string, present only once the resolved current document lists that key under
  `assertionMethod`. Flat members, since the two have different lifecycles.
  (Revised 2026-09-29 from the core `specs` entry and the name `did`.)
- Space subtype: `ServerInstanceSpace`, so the `server` Space is typed
  `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`. Create Space refuses the
  subtype from clients; only boot provisioning writes it.
- Verification method fragment: the full `publicKeyMultibase`, so the signer id
  is `did:webvh:{SCID}:{host}:space:server:id#z6Mk...`, mirroring the `did:key`
  fragment convention and matching `exportSigningKey` by eye.
- Envelope: one Data Integrity proof (`eddsa-jcs-2022`, `proofPurpose`
  `assertionMethod`) per attested object over a plain JSON statement
  `{ id, type: 'StorageAttestation', createdBy, createdAt, version, digest, didLogVersionId }`,
  where `id` is the object's URL (the manifest's own key), `digest` is the
  `Digest` header's string form (`mh=` + base64url sha-256 multihash), a chunked
  Resource's `digest` is the multihash over the JCS serialization of the ordered
  array of chunk digest strings, a Space or Collection Metadata statement
  carries `metaVersion` in place of `version` and `digest`, and
  `didLogVersionId` names the log epoch explicitly since `proof.created` is not
  trustworthy. Not a VC; WASS-25 may wrap it later.
- Archive entries, at the root beside `manifest.yml` and `service.json`, both
  listed in the manifest: `provenance.jsonl`, one statement per line in manifest
  order; `did.jsonl`, the server's DID log snapshot, verbatim bytes as served.
  The layout under `space/` is untouched, so import's walk does not change.

_Superseded decisions (2026-07-22)._ The first design had the server mint its
own `did:webvh` on first boot, hold the update key as KEK-encrypted server state
outside Space storage, serve the log at a well-known route, and refuse to boot
when the identity was absent over a non-empty store (to avoid forking the
identity on a restore that lost the key), with an admin script as the only
override and a boot-time `SERVER_URL` check against a recorded URL. The
2026-09-29 revision drops all of that: the admin holds the update key, so the
server has nothing to mint, nothing to fork, and no key file to lose, and the
self-hosted path form replaces the well-known route. The one property the first
design had that this one gives up is a server that works with no operator step
at all; an unprovisioned server now runs and exports, unsigned.

_Spec status (resolved 2026-07-22)._ The spec defines `createdBy` on the Space,
Collection, and Resource Metadata data models (OPTIONAL, server-managed,
read-only) but no way to _authenticate_ that claim once the data leaves the
server, nor a server DID to anchor it. Resolution: the PWS spec itself gains
only (a) a server-DID anchor, how a server advertises its DID in the Service
Description, and (b) a normative reference from the Export/Import operations to
a separate reusable **container spec** (WASS-25 in the spec roadmap, draft) that
owns the envelope format, manifest, and verification procedure. The Keyhive
"concap" format check moves to WASS-25's design phase. Implementation does not
wait on either: WSS-7 ships against the de facto format, and the spec text is
extracted from it (this repo's existing pattern).

_Option value._ Once the server has a DID and signing key, other uses become
cheap; recorded here so the option value is not lost (razor: TLS already
authenticates live reads, so a signature only earns its keep where the statement
outlives the connection, stored for later, shown to a third party, or compared
between parties):

- **Write receipts**: a signed "stored resource `id` with content digest D at
  version N at time T" returned to the writer; the live-path counterpart of the
  export signing. The signing-time-agnostic envelope (see design decisions)
  keeps this a later opt-in: mint the same envelope at write time and return it
  to the client, without storing it.
- **Signed changes-feed checkpoints**: promoted to its own item, WSS-36.
- **Epoch anti-rollback**: a signed current-epoch statement for multi-recipient
  collections; with `epochsMac` retired (client 0.32.0), epoch configuration is
  bound by log-chain verification, and a server signature would additionally
  make the freshness claim third-party- and offline-verifiable.
- **Server as zcap delegatee**: the receiving direction. A user delegates a read
  capability to the server's DID so it can pull from a peer server unattended
  (server-to-server backup / replication / migration). This needs a
  `capabilityInvocation` method on the server DID, which the current design
  deliberately withholds; adding one is an admin log entry and a review of the
  clause consequences above. Any future federation story needs the server DID as
  a prerequisite.
- **Signed export manifest**: a whole-archive "backup receipt" over the
  manifest's content digests. The completeness complement to the per-object
  envelopes: per-object signatures cannot detect an object _omitted_ from an
  archive (see the digest-binding decision), so omission-detection is inherently
  the manifest's job.

_Related._ `createdBy` implementation: `invokerDid()` in
`src/auth-header-hooks.ts`; the strip-and-apply in `writeSpace` /
`writeCollection` / `_writeResourceLocked` (both backends). The import path that
trusts the archive: `importSpace` in `src/backends/filesystem.ts` (writes
Metadata objects and sidecars raw) and in `src/backends/postgres.ts` (routes
through `_upsertCollection`, still trusting the archived value).

_Split (2026-09-29)._ Closed with the identity slice shipped (the five ticked
criteria). The unticked criteria moved to their own items: WSS-164 (the admin
script and the remaining runbooks), WSS-165 (export signing and the archive
entries), WSS-166 (import verification). The _Option value_ list is parked as
WSS-167. The design and wire decisions above stay the record those items build
on.

### WSS-147: Small wire and doc corrections from the review

- status: done
- done: 2026-09-29
- priority: low
- labels: cleanup, wire-contract, docs
- discovered-from: whole-codebase review (2026-09-17)
- acceptance:
  - [x] `zcapCryptosuites` in the service description lists cryptosuite names
        only; `Ed25519Signature2020` is a proof `type` and either moves to a
        separate member or is dropped (WSS-69)
  - [x] `notModifiedReply` sends no `Content-Length: 0` on a 304 for an
        implicit-HEAD route
  - [x] `deriveGovernedEncryption` always stamps `history.resource` with the
        log's own URL and drops a client-written `history` when the genesis
        carries no `parameters.method`, or the doc says `history` is not
        server-guaranteed
  - [x] An identical-body governed-log `PUT` (zero new lines, stored bytes
        unchanged) is a no-op 204, not `invalid-request-body`
  - [x] `PUT /space/:spaceId/meta` on an existing Space is the full replacement
        its contract states (an omitted `name` is removed), or the contract says
        merge
  - [x] The 201 of a token-provisioned Create Space echoes what was persisted
        (no client-supplied `createdBy`); unknown body members are not stored
  - [x] `filter[__proto__]=v` on the equality query answers the documented 400,
        not an empty 200
  - [x] `StorageBackend`'s contract text matches `getResource` (throws),
        `getChunk` (rejects) and `deleteChunk` (resolves `false`); the
        `filesystem.ts` comment claiming `ifNoneMatch` takes precedence is
        corrected; `generator.ts`'s header matches keep-on-omit (which the spec
        and the code both do); `types.ts`'s `declaredBytes` note matches the
        multipart branch
  - [x] ARCHITECTURE.md states the single-instance assumption the 10 s
        `spaceMetadataCache` and `policyCache` TTLs rest on (a retired
        controller keeps authority on another instance for one TTL), and that
        `allowTargetQuery` bounds the accepted root set only (the query-bearing
        request URL is always an accepted target)
  - [x] `putMeta`'s uniqueness scan runs after the Resource-existence check, so
        a claim on an absent Resource is 404, not 409
  - [x] The chunk listing documents `count` as cardinality, or reports the
        extent alongside it; chunk writes are documented as outside the
        Resource-count quota
  - [x] Auxiliary Spaces count toward `maxSpacesPerController` but are excluded
        from List Spaces; document or expose them

### WSS-164: Admin runbooks for the server DID log via `di` (mint, rotate, restore)

- status: done
- done: 2026-09-30
- priority: medium
- labels: operations, security, tooling
- blocked-by: did-cli-typescript CLI-20, CLI-21, CLI-23
- acceptance:
  - [x] `docs/admin-guide.md`'s "Server identity" runbooks (provisioning, seed
        rotation, restore after a wipe) are step lists of `di` commands in place
        of the hand-built library calls (the mint sequence is sketched below);
        each runbook ends by checking `serverDid` on `/service`
  - [x] The provisioning runbook states that the log's update key is a
        CLI-managed key with pre-rotation armed (the CLI default), distinct from
        the admin `did:key` that controls the `server` Space and signs the
        `PUT`, and that the admin's CLI wallet (document, log, update-keys
        sidecar) must be backed up: losing the sidecar freezes the log
  - [x] A compromise-recovery runbook is added covering each secret separately:
        a leaked server seed (rotate the seed, `di did webvh replace-key`, note
        the `versionId` from which archives signed by the old key are suspect),
        a leaked update key (`di did webvh rotate-keys`, which the staged next
        key makes safe), and a leaked admin `did:key` (change `WAS_ADMIN_DID`,
        restate the Space controller)
  - [x] The runbooks never have the admin hold or print the server seed; the
        server key enters the log as its public `exportSigningKey` only
  - [x] A test drives the mint and rotate runbooks against an in-process server
        by invoking the `di` command factories (or the built `di` binary) and
        asserts `serverDid` on `/service` before and after

Split from WSS-7 (archived) on 2026-09-29; the design lives there. Rewritten on
2026-09-30 to use `@interop/did-cli` as the log author instead of a bespoke
script: the CLI already keeps a did:webvh's log and update keys in the admin's
local wallet with pre-rotation armed, and `di was` already signs writes into a
Space as its controller. The server never inspects the log's `updateKeys` (it
resolves the log and checks only that the document lists the export-signing key
under `assertionMethod` alone), so pre-rotation is invisible to it and needs no
server change. What changes against WSS-7's design: the log's update key is no
longer the admin `did:key` but a CLI-managed key whose staged successor makes a
single-key compromise non-fatal; the cost is a second secret to back up. The
server never mints or extends its own log (it holds no update key), so the CLI
is the only writer and the admin's copy is the source of truth; the CLI's
served-log fast-forward check (CLI-23) is what keeps that copy from diverging
after a failed `PUT` or a second admin machine. A rotation appends rather than
re-mints so that archives signed under the old key keep verifying against the
log epoch their envelope names (WSS-165). The three CLI items this depends on
live in did-cli-typescript's ROADMAP.md. The `SERVER_URL` move runbook is
WSS-168, split out on 2026-09-30.

Mint sequence, as the provisioning runbook will spell it out:

```
di was space add {SERVER_URL}/space/server --handle server --did <admin>
di was collection create server --id id --name "Server identity"
di did create webvh --url {SERVER_URL}/space/server/id \
  --verification-key <exportSigningKey multibase> --purpose assertionMethod \
  --vm-id-fragment multibase --save --handle server-id
di was put server/id/did.jsonl <log path> --content-type text/jsonl
```

### WSS-165: Export signs provenance (`provenance.jsonl` + DID log snapshot in the archive)

- status: done
- done: 2026-09-30
- priority: medium
- labels: data-model, security, export
- touches:
  - space-archive: two root entries in the layout beside `manifest.yml` and
    `service.json`, both listed in the manifest: `provenance.jsonl` and
    `did.jsonl`; the packer takes them and the reader exposes them without
    verifying (verification is the importer's, WSS-166, and the wallets' when
    they choose) -- shipped as SAR-5 (space-archive 0.5.0, unpublished; this
    server consumes it through a temporary `link:../space-archive` reference
    until it is published), including the second fixture
    `fixtures/space-archive-provenance.tar`
  - portable-web-spaces-spec: the normative reference from Export/Import to the
    container spec that owns the envelope (WASS-25 in that repo's roadmap) --
    pending: WASS-25 is still draft there; nothing in this item changes the PWS
    spec text itself
- acceptance:
  - [x] Both backends' `exportSpace` emit one statement per exported object
        (each Resource, the Space Metadata object, each Collection Metadata
        object) in manifest order into `provenance.jsonl`, each carrying one
        `eddsa-jcs-2022` Data Integrity proof (`proofPurpose` `assertionMethod`)
        by the seed-derived key, with `verificationMethod`
        `{serverDid}#{publicKeyMultibase}`
  - [x] The statement is
        `{ id, type: 'StorageAttestation', createdBy, createdAt, version, digest, didLogVersionId }`,
        where `id` is the object's URL (the manifest's own key), `digest` is the
        `Digest` header's string form (`mh=` + base64url sha-256 multihash) over
        the content, a chunked Resource's `digest` is the multihash over the JCS
        serialization of the ordered array of chunk digest strings, and a Space
        or Collection Metadata statement carries `metaVersion` in place of
        `version` and `digest`; `didLogVersionId` is the served log's head
        `versionId` at export time
  - [x] The signed bytes carry no export-specific context (no export timestamp,
        no manifest reference), so the same statement signed at write time later
        is bit-compatible
  - [x] The archive's root `did.jsonl` is the server's log snapshot, verbatim
        bytes as served, and the layout under `space/` is unchanged so
        `importTar.ts`'s walk does not move
  - [x] When the server has no identity (`serverDid` absent from `/service`) the
        export carries neither entry and the handler logs one `warn` line, not
        one per object
  - [x] `test/space-archive-fixture.test.ts` pins the two entries against the
        fixture that package checks in, and a test verifies every statement
        offline with `resolveDIDFromLog` over the embedded snapshot

Split from WSS-7 (archived) on 2026-09-29; the design decisions and the wire
decisions approved that day are recorded there and are settled: sign on export
rather than on write, the envelope binds the content digest, `didLogVersionId`
names the key epoch explicitly since `proof.created` is not trustworthy, and the
statement is not a VC (WASS-25 may wrap it later). The per-object envelope
covers portability, not completeness: an object omitted from an archive leaves
every surviving statement valid, and omission detection belongs to a signed
manifest (parked in WSS-167). The codec change in `@interop/space-archive` is a
prerequisite of the server half and is filed there under this item's `touches`.
Not blocked by WSS-164: the identity can be provisioned by hand per the admin
guide until the `di` runbooks land.

_Shipped (2026-09-30)._ Choices made where the item text left room, recorded for
WSS-166: a statement's `id` is the absolute URL on the exporting server
(`{serverUrl}/space/{S}/meta`, `.../{C}/meta`, `.../{C}/{R}`); a member the
stored record lacks is left out of the statement rather than nulled; the proof
carries no `created`, so re-signing an unchanged statement yields the same
bytes; a tombstone gets no statement; a chunked Resource's statement covers its
chunks only, not the parent representation's bytes, as the item states; the two
root entries are listed in the manifest with no documenting `url`, and are
packed after `service.json` in the order `provenance.jsonl`, `did.jsonl`, so an
importer holds the statements before the first object. Statements are built over
the archive's own entry tree in `src/lib/exportProvenance.ts`, so each Resource
is read twice per export.

### WSS-166: Import verifies provenance and drops unearned `createdBy`

- status: done
- done: 2026-09-30
- priority: medium
- labels: data-model, security, import
- touches:
  - storage-core: `ImportStats.provenance` added in 0.24.0 (publish pending;
    this repo links it until then)
  - was-client: unaffected (re-exports `ImportStats` from storage-core; picks up
    `provenance` with its next storage-core bump)
- blocked-by: WSS-165
- acceptance:
  - [x] Import reads `provenance.jsonl` and `did.jsonl` when present, verifies
        the embedded log offline (SCID pinning plus full chain verification via
        `@interop/did-method-webvh`), resolves each statement's
        `verificationMethod` at the `didLogVersionId` it names, and checks the
        proof and then the content digest against the imported bytes
  - [x] An object whose statement verifies keeps its `createdBy` (and
        `createdAt`, `version` / `metaVersion` as today); an object with no
        statement, a failing proof, or a digest mismatch is imported with
        `createdBy` dropped, not rejected, in both backends
  - [x] Which server DIDs an importer accepts attribution from is decided and
        documented before this ships (the importer's own `serverDid` at least;
        an allowlist for cross-server restores is a configuration decision to
        take to the user)
  - [x] The `ImportStats` report counts verified, unattested, `proof-invalid`
        and `content-mismatch` objects separately, and `handleError`-level
        logging tells the last two apart, so bit-rot is not read as a flaky
        signature
  - [x] Tests cover a verified round trip, a hand-edited `createdBy`, a
        substituted body under an authentic statement, and an archive from a
        server whose DID the importer does not accept

Split from WSS-7 (archived) on 2026-09-29. Import must preserve `createdBy` to
be a restore, so it necessarily trusts the archive; this item moves that trust
from the file to the signing server's DID. Degrades cleanly: a hand-rolled
archive still imports and just carries no attribution it did not earn. A
content-transforming migration (re-encryption, plaintext/EDV conversion) either
re-attests over the transformed bytes or accepts the drop; note that in the tool
that first does one.

### WSS-169: Build and judge the import plan in the Import Space handler, not in the backends

- status: done
- done: 2026-10-01
- priority: medium
- labels: cleanup, import, provenance, filesystem-backend, postgres-backend
- touches:
  - `src/requests/SpaceRequest.ts` (`import`), `src/lib/importTar.ts`,
    `src/lib/importProvenance.ts`, `src/backends/filesystem.ts`,
    `src/backends/postgres.ts`, `src/types.ts` (`StorageBackend.importSpace`),
    `test/storage-backend-contract.ts`: shipped here (server-internal; the
    shared call is `prepareImportPlan` in the new `src/lib/importPlan.ts`, and
    direct-to-backend tests use the `importArchive` helper in `test/helpers.ts`)
  - unaffected: storage-core, was-client (`ImportStats` and the Import Space
    wire contract are unchanged)
- acceptance:
  - [x] `StorageBackend.importSpace` takes a built plan and the provenance
        counts (`{ spaceId, plan, provenance, restoreSpaceMetadata }`) instead
        of a tar stream; a backend only persists what it is handed
  - [x] The Import Space handler extracts the entries, builds the plan, and
        judges the archive's provenance once, through one call, so a backend
        cannot skip verification by calling `buildImportPlan` directly
  - [x] `assertImportBodiesFit` moves with it, or is the one pre-flight each
        backend keeps because it reads the backend's own `maxUploadBytes`
  - [x] `buildVerifiedImportPlan` is gone, and `importTar.ts` no longer imports
        `importProvenance.ts` (the type-only cycle between the two goes with it)
  - [x] The backend contract tests build the plan through the same shared call
        the handler uses, so an archive-level test stays one per backend
  - [x] The import tests in `test/` and the conformance suite stay green on both
        backends

Context: both backends open `importSpace` the same way: `extractTarEntries`,
then `buildVerifiedImportPlan`, which builds the plan and runs
`applyImportProvenance` over it. Judging a signed archive and removing the
`createdBy` members it did not earn is request-level policy, not persistence,
and ARCHITECTURE.md gives the backends persistence alone. Threading the
backend's logger and the `ImportStats.provenance` counts through two backends
exists only to serve that call. A third backend that calls `buildImportPlan` on
its own imports unearned attribution and nothing fails. Hoisting the
plan-building into the handler removes the duplicated extraction code from both
backends and makes the verification step impossible to leave out. WSS-126 adds
further validation to the same pre-write path and lands more simply once that
path runs in one place.

### WSS-170: Move the provenance statement contract out of `exportProvenance.ts` into a neutral module

- status: done
- done: 2026-10-01
- priority: low
- labels: cleanup, provenance, export, import
- touches:
  - `src/lib/exportProvenance.ts`, `src/lib/importProvenance.ts`, and the new
    module (`src/lib/provenanceStatement.ts` or similar)
- acceptance:
  - [x] `STORAGE_ATTESTATION_TYPE`, `serverFieldsOf`, `fileDigest` and
        `chunkedDigest` live in one module that neither provenance module owns,
        together with the `Claims` members a statement attests
  - [x] `importProvenance.ts` imports nothing from `exportProvenance.ts`, and
        `exportProvenance.ts` nothing from `importProvenance.ts`
  - [x] ARCHITECTURE.md's two provenance entries point at the shared module for
        the digest and server-member rules
  - [x] The export, import and provenance tests stay green on both backends

Context: import verification needs the same digest form, the same chunked
composite digest, and the same reading of the server-managed members as export
signing, so those four pieces were exported from `exportProvenance.ts` and
imported by `importProvenance.ts`. Export and import are siblings: one signs
statements, the other judges them, and the contract between them (what a
statement names and how its `digest` is computed) belongs to neither. Keeping it
in the signing module reads as import depending on export's internals, and a
reader checking that the two sides agree has to find the shared pieces among the
signing code. Neither module imports the other today, so there is no cycle to
break; the move is for ownership and legibility only, which is why it is low
priority.

### WSS-163: Space subtypes in List Spaces results, optionally

- status: done
- done: 2026-10-01
- priority: low
- labels: spec-gap, wire-contract, list-spaces
- discovered-from: WSS-147
- touches:
  - the PWS spec, "List Spaces Operation" (auxiliary Spaces listed, a required
    `type` item member) -- text being updated in the spec repo
  - was-client, `listSpaces()` -- was-client ROADMAP item (filed)
  - `src/requests/SpacesRepositoryRequest.ts` -- shipped
  - `@interop/storage-core`, `SpaceSummary` -- shipped (required `type` member),
    publish pending
  - `@interop/was-conformance-suite` -- the
    `listSpaces includes a created space` case pins the old item shape and fails
    until updated
- acceptance:
  - [x] List Spaces takes no query parameter: auxiliary Spaces are always
        included in the results, and `totalItems` counts them
  - [x] each item carries the Space's `type` array, so a wallet can tell an
        auxiliary Space from a data Space without a Read Space per item
  - [x] the listing has no separate default shape: every item carries `type`
  - [x] spec text covers the listing; the conformance suite follow-up is noted
        under `touches:`

Auxiliary Spaces (`AuxiliarySpace` subtypes such as `DelegatedClientsSpace` and
`ServerInstanceSpace`) count toward `MAX_SPACES_PER_CONTROLLER` but are hidden
from List Spaces, so a controller near its quota cannot see what is using it.
The wire shape (parameter name, item member) is the maintainer's call.

Maintainer decision (2026-10-01): no opt-in parameter. List Spaces always lists
every Space the requester is authorized for, auxiliary Spaces included, and
every item always carries `type`.

### WSS-146: Startup and composition hardening in `plugin.ts` and `server.ts`

- status: done
- done: 2026-10-01
- priority: low
- labels: library-surface, config
- discovered-from: whole-codebase review (2026-09-17)
- acceptance:
  - [x] `createApp` / `fastifyWas` refuse `serverUrl: undefined` at registration
        (the documented library example passes `process.env.SERVER_URL`
        unguarded); `assertValidServerUrl` rejects userinfo
  - [x] The plugin sets `logger`, calls `init()` and `close()` only on a backend
        it built itself, or takes an explicit `ownsBackend` option
  - [x] CORS is an option (origin, methods without `PATCH`), or the docs state
        that a hardened composition inherits `origin: '*'` and the `'*'` parser
        on its own routes
  - [x] `src/requests/collectionContext.ts` builds the log URL with `new URL`,
        so a trailing-slash `SERVER_URL` does not yield `//space/...` in
        `encryption.history.resource`; `exchanges.ts` likewise

### WSS-158: Re-check the Space inside the lock on a revocation insert

- status: done
- done: 2026-10-01
- priority: medium
- labels: filesystem-backend, postgres-backend, consistency, revocation
- discovered-from: WSS-125
- acceptance:
  - [x] The filesystem `insertRevocation` checks a Space scope's Metadata object
        under the Space gate's shared side (`#underSpaceWrite` with
        `container`), so a Delete Space cannot land between the check and the
        write, and `mkdir -p` never recreates the Space's revocation directory
        after the delete removed it
  - [x] An insert under a Space with no Metadata object is refused with a 404 on
        both backends, not a `StorageError` (500). This includes the Postgres
        foreign-key violation (SQLSTATE `23503`) raised when the Space row was
        deleted first
  - [x] A contract test issues a revocation insert racing a Delete Space and
        asserts that either the insert is refused or the delete removed it. In
        both orders, a Space re-created under the same id has no revocations

`insertRevocation` reads the Space Metadata object before any lock, then creates
the record under `spaceRevocationsDir/<S>/`, a sibling tree outside the Space
dir. A Delete Space landing between the two removes that tree, and the insert's
`mkdir -p` recreates it. The record then outlives its Space and applies to the
next Space created under id `S`. Capability ids are normally random, so a stale
record rarely matches a new grant, but the stored state is wrong, and the new
Space's export carries the old record. On Postgres the `space_revocations`
foreign key refuses the same insert, but as a 500. The absent-scope refusal is a
`StorageError` on both backends today. The HTTP route masks unknown scopes
before the insert, so only the race reaches it. The keystore scope has the same
check-then-write shape. It is outside this item unless keystores gain a delete
path.

### WSS-94: Drop the filesystem backend's legacy stat-based fallbacks

- status: done (2026-10-01)
- priority: medium
- labels: filesystem-backend, cleanup, greenfield
- acceptance:
  - [x] `getResourceMetadata` reports no `createdAt` / `updatedAt` when the
        Resource has no sidecar, rather than substituting `birthtime` / `mtime`
        (both members are already optional on `ResourceMetadata`)
  - [x] `changesSince` drops the mtime fallback: a sidecar-less Resource has no
        feed position and is left out of the feed
  - [x] The `ETag` path stays as it is -- a Resource with no validator already
        carries no `ETag` -- and the three sites read consistently
  - [x] A test in `test/` writes a representation file into a Collection dir
        with no sidecar and asserts the metadata read omits the timestamps and
        the feed omits the Resource
  - [x] CHANGELOG.md records the behavior change

Context: three places in `src/backends/filesystem.ts` accommodate a Resource
written before the `.meta.` sidecar existed. `getResourceMetadata` (line 3506)
falls back to `stats.birthtime` / `stats.mtime` for `createdAt` / `updatedAt`;
`changesSince` (line 4341) falls back to the file's mtime for the feed's
ordering key; the ETag path (line 3620) leaves such a Resource without a content
`ETag`. The first two are data-migration accommodations for a `data/` tree
written by an older build, which this project does not carry. They are also
inconsistent with the neighbouring `createdBy`, which has no stat-based fallback
and is simply absent ("there is no stat-based fallback for it, as there is for
the timestamps"). Dropping them is type-clean: both timestamp members are
optional. The mtime fallback is worse than absence for the feed in particular --
a stat time bears no relation to the server's write order, so `cp` without `-p`,
a restore, or a `touch` silently moves a Resource's feed position, and can move
it below a checkpoint a client already holds (the same skip WSS-93 describes,
from a different cause). Once WSS-95 lands, the only way to reach these paths is
writing into `data/` behind the server's back.

### WSS-93: Changes-feed keyset is not a total order

- status: done (2026-10-01)
- priority: high
- labels: changes-feed, wire-contract, replication, filesystem-backend,
  postgres-backend
- touches:
  - portable-web-spaces-spec: the Query Profile Registry's `changes` profile.
    Its "Ordering and resumption" paragraph states the feed is ordered by an
    ascending `(updatedAt, id)` keyset and that the checkpoint is an
    `{ id, updatedAt }` object; both statements change (the new text is
    described below) (filed in parallel, see that repo)
  - storage-core: `ChangesCheckpoint` (`src/was.ts`), today
    `{ id: string, updatedAt: string }`, becomes the opaque checkpoint type, and
    the wire `ChangeDocument` gains the feed-position member (shipped in this
    change: `ChangesCheckpoint = string`, `ChangeDocument.checkpoint`, 0.26.0)
  - was-teaching-server: `src/backends/filesystem.ts` (`changesSince` and the
    Resource write paths that stamp the sidecar), `src/backends/postgres.ts`
    (`changesSince`, the `resources` table, and its write statements),
    `src/requests/CollectionRequest.ts` (`#queryChanges`, the checkpoint parse
    and the wire projection), `src/types.ts` (the `StorageBackend.changesSince`
    contract) (shipped 2026-10-01)
  - was-client: `Collection.changes()` passes the checkpoint through unchanged
    and needs only the new type; the loop guard in `Collection.documents()` that
    detects a non-advancing checkpoint concatenates `updatedAt` and `id` and
    must compare the opaque value instead (filed in parallel, see that repo)
  - was-sync: `createPullHandler` (`src/changesQuery.ts`) already treats the
    checkpoint as opaque; only its `SyncCheckpoint` alias follows the type
    (filed in parallel, see that repo)
  - conformance-suite: a case that writes two Resources into one Collection
    within a single millisecond, pages the feed with a checkpoint between them,
    and asserts neither is skipped; and a case asserting that a checkpoint from
    before a write, echoed back after it, surfaces the write (filed in parallel,
    see that repo)
- acceptance:
  - [x] Each write to a Collection takes a per-Collection feed position, a
        sequence number assigned inside the same per-Collection critical section
        that makes the write visible, so no write can ever land at or before a
        position already handed to a client
  - [x] Both backends order and seek on that position, and a page's returned
        checkpoint resumes exactly after the last document
  - [x] The checkpoint is opaque on the wire: a client stores it, compares it by
        equality only, and echoes it back verbatim. The server rejects a
        checkpoint it did not issue (including the retired `{ id, updatedAt }`
        shape) with `invalid-request-body` (400), and a replica then restarts
        its pull from the beginning
  - [x] Each feed document carries its feed position, so a client can build a
        checkpoint from any prefix of a page
  - [x] `updatedAt` stays a plain wall-clock stamp with no ordering role; the
        spec's "Ordering and resumption" paragraph says the feed is ordered by
        the issuing server's feed position, that the checkpoint is opaque and
        scoped to the server URL that issued it, and that `updatedAt` carries no
        ordering guarantee (server half shipped; the spec paragraph is filed in
        parallel in the spec repo)
  - [x] A test in `test/` (and a conformance case) covers both skips described
        below, with the backend clock injected or frozen so the same-millisecond
        condition is asserted rather than raced (the `test/` half shipped: the
        contract suite on both backends and `changes-query-api.test.ts`; the
        conformance case is filed in parallel in the suite repo)
  - [x] The checkpoint's exact encoding is agreed before it is coded, and the
        Query Profile Registry states it

Context: both backends key the feed on `(updatedAt, resourceId)` and seek
strictly past the checkpoint, and both stamp `updatedAt` from
`new Date().toISOString()` -- millisecond granularity. Two writes in a
Collection can therefore share an `updatedAt`, and the keyset stops being a
total order. Two skips follow. A client checkpoints on Resource `x` at time `T`
and a writer rewrites `x` within that same millisecond: `x` keeps its position,
every later pull skips it, and the replica serves the stale body until some
unrelated write moves `x`'s timestamp. And a Resource whose id sorts below the
checkpoint's id, written in the checkpoint's millisecond, sorts before the
checkpoint and is skipped the same way. A per-Resource tiebreak such as the
monotonic `version` the record already carries closes only the first skip. The
defect is not that two documents share a key; it is that a write can be assigned
a key behind a checkpoint already handed out. Only a per-Collection quantity
that only grows closes both.

A third gap hides behind the first two and constrains where the position is
assigned. A write that takes its key early and becomes visible late can still
land behind a checkpoint: writer A takes key `T`, is preempted, and finishes
after writer B took `T+1`, wrote, and was served to a reader who checkpointed
there. Both backends already serialize writes per Collection (a keyed lock in
the filesystem backend, an advisory lock in Postgres), so the position must be
taken inside that critical section, at the point the write becomes visible. This
is the same rule that makes a WAL log sequence number safe where a plain
database sequence (`nextval`, which is not commit-ordered) is not.

Two fixes were weighed. Stamping `updatedAt` as
`max(now, collectionWatermark + 1ms)` keeps the wire checkpoint unchanged and
makes the existing key a total order, at the cost of an `updatedAt` that runs
ahead of the wall clock during a burst. It was rejected for a structural reason
rather than that one: it makes `updatedAt` serve as the feed key, so the
receiving server must mint it, so it cannot be a fact about the write that
replicates verbatim between servers. The multi-primary direction recorded in
WSS-96 needs exactly that separation: a write's metadata (`updatedAt`,
`version`, `generation`) is owned by the server that accepted it and travels
with the write, while a feed position is a property of one server's feed and is
never replicated. The per-Collection sequence number is the design replication
feeds normally use (CouchDB's per-database update sequence, Postgres's WAL
position, Kafka's partition offset) and is the one to implement.

The checkpoint is opaque by decision, not merely by convention. CouchDB moved
its update sequence from an integer to an opaque string between 1.x and 2.x,
when a clustered feed needed one counter per shard, and broke every client that
had done arithmetic on it. Declaring the checkpoint opaque and scoped to the
issuing server now means the per-source or vector checkpoint that multi-primary
needs (WSS-96) can arrive without a second wire break. The client side is
already there: the RxDB pull handler in was-sync echoes the checkpoint verbatim
and RxDB persists it without inspection, so the only client code that reads
inside the checkpoint is the loop guard named under `touches`.

No compatibility path is offered for a persisted `{ id, updatedAt }` checkpoint.
The server refuses it as malformed, the replica restarts its pull from the
beginning, and the apply path, keyed by Resource id, makes that safe.

### WSS-95: Import writes a Resource with no sidecar, so it has no feed position

- status: done (2026-10-01)
- priority: high
- labels: import-export, changes-feed, filesystem-backend, postgres-backend
- blocked-by: WSS-93
- touches:
  - was-teaching-server: `src/backends/filesystem.ts` (`importSpace`),
    `src/backends/postgres.ts` (`importSpace`), and whatever allocates the feed
    ordering key once WSS-93 settles it (shipped 2026-10-01: the filesystem
    backend synthesizes the sidecar through its one feed-position path; Postgres
    already took a position and matched the synthesized values)
  - conformance-suite: an import case whose archive carries a Resource with no
    metadata entry, asserting the imported Resource appears in the changes feed
    (unaffected: conformance-suite (PWSCS-17 was filed and withdrawn on
    2026-10-01; import is a reserved, unspecified operation and the sidecar
    layout is this implementation's, so the server's contract test is the
    coverage))
- acceptance:
  - [x] `importSpace` never creates a Resource without the record that carries
        its feed ordering key: an archive entry with no metadata gets a
        synthesized one, stamped by the same allocation path an ordinary write
        uses, under the same per-Resource lock
  - [x] The archive's `createdAt`, `createdBy`, and `custom` are preserved when
        present; only the ordering key is minted
  - [x] A test in `test/` imports an archive carrying a Resource with no
        metadata entry and asserts the Resource appears in the changes feed at a
        position after every pre-existing document
  - [x] Both backends behave identically, and the storage-backend contract test
        covers it

Context: discovered-from WSS-93. `importSpace` in `src/backends/filesystem.ts`
(line 1730) writes the representation unconditionally and the sidecar only if
the archive carried one: "A metadata sidecar travels with a newly-created
resource ...; an absent one leaves `getResourceMetadata` to fall back to the
file's stat times." An archive this server exported always carries the sidecars,
since export packs the Collection dir verbatim, so the gap is reachable through
a hand-built or foreign archive -- on a fresh server with no history at all. The
Postgres backend differs in degree, not in kind: `#insertImportedResource`
(line 4825) falls back to `sidecar?.updatedAt ?? now`, so an imported Resource
always has a feed position, but that `now` is stamped outside whatever
allocation WSS-93 introduces. Whichever ordering key WSS-93 settles on, import
has to participate in allocating it: a watermarked `updatedAt` is computed on
the write path an import bypasses, and a per-Collection sequence has no value at
all for an imported Resource. Blocked on WSS-93 because the key's shape decides
what import mints.

### WSS-102: Stop re-parsing a governed Collection's history log on every Metadata read

- status: done (2026-10-01)
- priority: low
- labels: governed-history-logs, performance, filesystem-backend,
  postgres-backend
- acceptance:
  - [x] A `PUT /space/:spaceId/:collectionId/meta` on a log-governed Collection
        parses the log at most once per request, while the recheck under the
        backend's lock still sees the log state as of the lock
  - [x] `getCollectionOrThrow` no longer parses the whole log on each call:
        either the derived `encryption` is cached per Collection (invalidated by
        every `writeCollectionLog` and by Delete Collection / Delete Space /
        import), or the derivation reads only the head line it needs
  - [x] The Postgres `writeCollection` recheck reads the log columns from the
        row it already holds `FOR UPDATE` instead of issuing a second `SELECT`
  - [x] Existing governed-log tests stay green, plus a test that a log append is
        visible to the very next Metadata read and write

Context: `CollectionRequest.putMeta` calls `governedEncryptionOf`
(`src/requests/collectionContext.ts`) twice per write, once for the early
rejection and again inside `assertTransition` under the per-Collection lock.
Each call reads the whole log body and `deriveGovernedEncryption`
(`src/lib/governedLog.ts`) runs `parseGoverningLog` over every line, though only
the last line's `state` and the genesis line's `parameters.method` are used. The
log is append-only and grows without bound, so the cost is O(log size), twice.
Before v0.5 an annotation-only write (a rename, a `custom` or `epoch` edit) went
through a narrower endpoint that never touched the log; the merged full-replace
`PUT /meta` now pays it on every write. `getCollectionOrThrow`, which nearly
every Collection- and Resource-level handler calls, pays it once per request
too. A cache would follow the per-backend `LruCache` pattern of
`src/lib/spaceMetadataCache.ts` and `src/lib/policyCache.ts`. On Postgres the
recheck's log read is a second query against the `collections` row whose
`FOR UPDATE` lock `writeCollection` already holds, so the lock is held across an
extra round trip.

### WSS-171: Per-store origin id (`WAS_ORIGIN_ID`)

- status: done
- done: 2026-10-02
- priority: medium
- labels: replication, filesystem-backend, postgres-backend, config,
  service-description
- blocks: WSS-96, WSS-172, WSS-176
- touches:
  - was-teaching-server: `src/backends/filesystemStore.ts` (`store.json`), the
    Postgres schema (`MIGRATIONS`), `src/config.default.ts`, `start.ts`,
    `src/serviceDescription.ts`, `docs/admin-guide.md` -- shipped here
    (`src/lib/originId.ts`, the `store` row migration, `StoreOriginIdError`)
  - storage-core: `originId` on `PwsVersionEntry` -- shipped in 0.27.0 (publish
    pending)
  - portable-web-spaces-spec: `originId` on the core `https://w3id.org/pws`
    `specs` entry (not `instance`, which a client must not gate on) -- filed as
    WASS-47 (its Service Description acceptance line)
- acceptance:
  - [x] `WAS_ORIGIN_ID`, when set, is used verbatim and must match
        `[A-Za-z0-9_-]{1,64}`; a value outside that is refused at boot
  - [x] In `init()`, under the store lock, on every boot: a `store.json` (or
        Postgres store row) with no origin id gets `WAS_ORIGIN_ID` when set,
        else a minted random base58 id; one that carries an id is read from
        there. Not a migration step: an empty store runs none, and the step
        runner rewrites the file. `writeStoreVersion` preserves members it does
        not own
  - [x] A set `WAS_ORIGIN_ID` that differs from the stored id refuses to start,
        naming both
  - [x] `StorageBackend` exposes the id; `/service` advertises it as `originId`
        on the core `specs` entry, and the admin guide says it must be unique
        among every server a Space may replicate to, so a restored clone that
        will run beside its source boots with a fresh `WAS_ORIGIN_ID`
  - [x] Data-plane backend adapters share the hosting server's origin id and
        mint no stamps of their own
  - [x] Tests cover mint, verbatim use, mismatch refusal, the charset, a fresh
        dir minting, a kill between the id write and the version stamp keeping
        the id, and `writeStoreVersion` preserving it

Context (discovered-from: WSS-96, decision 2; the mint and advertisement rules
are design section 5.2 and open point 9, decision 0004 in `decisions/`). The
origin half of a write's replicated identity. Not the server DID: most
deployments have none, it embeds the host, and it changes if the admin re-mints
the log; the id only has to be stable and unique, since nothing verifies a
stamp. A human names a peer by URL or DID at registration and the server reads
the peer's origin id off its `/service`, so the id can be short and opaque; an
operator who wants a readable one sets it. A data wipe (staging) mints a fresh
id, which is fine, since there is no data to replicate.

---

### WSS-186: [L] Build backends through an async factory so none is half-built

- status: done
- done: 2026-10-03
- priority: low
- labels: cleanup, backend
- discovered-from: simplify pass over the origin id change (2026-10-03)
- acceptance:
  - [x] `FileSystemBackend` and `PostgresBackend` are obtained from an async
        factory (for example a static `open()`) that runs what `init()` runs
        today and returns a backend that already carries its origin id
  - [x] `StorageBackend.originId` is a plain readonly member with no "read
        before init()" throw, and the plugin's boot-time read of it is gone
  - [x] `start.ts`, `createApp`, `defaultBackend()`, and the test suites build
        backends through the factory; constructors are no longer public, or stay
        private to the factory
  - [x] The plugin's `ownsBackend` lifecycle keeps `close()` on `onClose` and no
        longer calls `init()`

`StorageBackend.init()` is optional, so the type admits an object that is
constructed but not usable: the origin id is settled by `init()`, and both
backends guard the gap with a getter that throws until then, which the plugin
reads once at registration so an injected backend that skipped `init()` fails
the boot instead of the first request. An async factory removes the half-built
state rather than guarding it. Decorating the Fastify instance with the id was
considered and rejected: the id is a store fact and belongs on the backend.

---

### WSS-172: [M] [blocks 8] Hybrid-logical-clock write stamp and the four-field validator

- status: done
- done: 2026-10-03
- priority: medium
- labels: data-model, etag, changes-feed, wire-contract, filesystem-backend,
  postgres-backend
- blocks: WSS-96, WSS-174, WSS-176, WSS-182, WSS-183, WSS-184, WSS-189, WSS-190
- touches:
  - portable-web-spaces-spec: the Resource data model (`updatedAtCounter` and
    `originId` members on Resource metadata and the Metadata objects; the
    validator layout; `version`/`metaVersion` retired), the `changes` profile
    (stamp members on the change document; the `(updatedAt, writerId)` tie-break
    sentence replaced by the stamp order) (filed as WASS-47 for the data model
    and the validator layout, and WASS-51 for the change document)
  - storage-core: the Resource metadata, `CollectionMetadata`, `SpaceMetadata`,
    and `ChangeDocument` types (shipped 2026-10-03, unpublished: storage-core
    0.28.0 adds `WriteStamp` and `ResourceMetaStamp`, and drops `version` /
    `metaVersion` from `ChangeDocument`)
  - was-teaching-server: `src/lib/etag.ts`, both backends' sidecar and row
    layouts and every write path that stamps them, `src/lib/preconditions.ts`,
    the `/meta` and Metadata-object projections, `changesSince` (shipped
    2026-10-03: both backends, `src/lib/hlc.ts`, provenance claims, import
    re-stamping, the boot refusal of a pre-stamp store)
  - was-client: types only (shipped 2026-10-03, unpublished: was-client 0.87.0
    drops `parseEtag`, `WriteAck.version` and `MasterState.version` /
    `metaVersion`, and carries the stamp on `WireDoc` and `MasterState`; it
    consumes storage-core through a `link:` until 0.28.0 is published)
  - was-sync: the apply comparison (filed as WS-23, which adopts the stamp data
    model in the replica schema and the push path)
  - conformance-suite: validator layout and stamp members on every record kind
    (filed as PWSCS-18: suite 0.27.0 fails 10 cases against this server, seven
    exact-shape asserts on the Space and Collection Metadata objects and their
    create echoes, which now carry the stamp members, and three asserting the
    withdrawn `writerId` rule on Update Resource Metadata; one optional case
    still reads `metaVersion` off a change document)
  - space-archive: filed as SAR-6 (retire `_version`, regenerate the fixtures)
- acceptance:
  - [x] Each backend holds one HLC per store: `l = max(l, now)`, counter
        incremented when `l` stood still, reset when it advanced; minted inside
        the write's critical section; the HLC is advanced by received stamps
        (WSS-176) under the clock bound
  - [x] Every versioned record (Resource, chunk, Resource `/meta`, Space and
        Collection Metadata objects) stores `updatedAt` (ISO, the HLC physical
        part), `updatedAtCounter`, and `originId` verbatim, and serves the first
        two on its metadata
  - [x] `formatEtag` emits `"<generation>.<ms>.<counter>.<origin>"` with `ms`
        the epoch integer; `If-Match` / `If-None-Match` compare the whole
        string; the `version` and `metaVersion` counters are removed from the
        sidecars, rows, and wire objects
  - [x] Each change document carries `updatedAtCounter` and `originId` beside
        `updatedAt`
  - [x] The ARCHITECTURE note that a client "may read the trailing integer as
        the revision number" is removed
  - [x] Tests freeze the clock and assert two same-ms writes get counters 0 and
        1, that a clock step backwards does not lower `updatedAt`, and the
        validator layout on every record kind

Context (discovered-from: WSS-96, decisions 2 and 3). The research note
`_spec/research-write-stamps.md` (2026-10-01) surveys CouchDB, Riak, Cassandra,
CockroachDB, MongoDB, Dynamo, Spanner, Automerge and Yjs: no system serves LWW,
dedup and a cross-replica validator from one field; time-plus- counter stamps
serve LWW and, carried verbatim, the validator, while dedup always needs an
origin-scoped key. The HLC paper's stamp has no node id and no tie-break, so the
origin is part of the order key and of the validator (two origins can mint the
same `(ms, counter)` for one Resource). The encoding is two members rather than
the paper's packed 64-bit integer, which exceeds JavaScript's safe range.

Server part landed 2026-10-03. The second acceptance box used to list the
Collection tombstone, which does not exist until WSS-174. That clause moved to
WSS-174's first acceptance box on 2026-10-03, since WSS-174 is blocked by this
item and the two could not both close otherwise. The receive rule (`observe`) is
built and tested, and gets its caller with WSS-176. The `/meta` write already
mints only the `/meta` stamp, which is WSS-190's server behavior; that item
keeps its spec text and conformance case. Follow-ups filed from this work:
WSS-191 (the sidecar as commit point), WSS-192 (the `/meta` `ETag` and
content-record members), WSS-193 (`epoch` on a `/meta` write). Settled with the
maintainer on 2026-10-03: the Postgres governed-log stamp columns are
`log_updated_at`, `log_updated_at_counter`, and `log_origin_id`; and an archive
exported by a pre-stamp release is not a supported import input (greenfield
only), so import does nothing about the retired members such an archive carries.

---

### WSS-173: [M] [blocks 2] `revisions` descriptor on the Collection Metadata object

- status: done
- done: 2026-10-03
- priority: medium
- labels: data-model, wire-contract, collection-metadata
- blocks: WSS-96, WSS-176
- touches:
  - portable-web-spaces-spec: the Collection Metadata data model (filed as
    WASS-49, which also carries the `resource-immutable` and
    `revisions-immutable` registry entries and the encrypted-collections
    `state.revisions` slot)
  - storage-core: `CollectionMetadata` (shipped 2026-10-03, unpublished:
    storage-core 0.30.0 adds `CollectionRevisions`,
    `CollectionMetadata.revisions`, and the `REVISIONS_IMMUTABLE` /
    `RESOURCE_IMMUTABLE` problem types; the server consumes it through a `link:`
    until it is published)
  - was-teaching-server: `src/lib/encryption.ts` (the descriptor-transition
    pattern to follow), `CollectionRequest`, both backends' Resource write paths
    (the immutable check), the governed-log derivation (shipped 2026-10-03:
    `src/lib/revisions.ts`, the transition check on Create Collection, Update
    Collection and the governed log, the derivation from `state.revisions`, and
    the write-once rule in both backends' Resource and chunk write paths)
  - conformance-suite: refusals and the immutable semantics (filed as PWSCS-19)
- acceptance:
  - [x] `revisions` is an optional object with `resolution` (closed set;
        `last-writer-wins` only in v1, default when absent), `immutable`
        (boolean, default false), and an optional client-declared `merge` object
        served verbatim; an unknown `resolution` is refused with
        `invalid-request-body` (400)
  - [x] Once set, `resolution` and `immutable` are immutable, refused with the
        same transition error class `encryption` uses; a governed Collection's
        descriptor is derived from the log like `encryption`
  - [x] On an `immutable` Collection an update of an existing Resource is
        refused (error name pending sign-off), a re-create over a tombstone or a
        repeat create with an equal body `Digest` is idempotent, and one with a
        different digest is refused
  - [x] Tests cover defaults, refusals, immutability, and the digest rule on
        plaintext and encrypted Collections

Context (discovered-from: WSS-96, decision 1). The two axes are independent:
resolution says what the server does with concurrent revisions, immutability
restricts which writes exist. A content-addressed, append-only Collection is the
immutable axis under the default resolution; its only conflict is a create
against a tombstone of the same id, which the stamp resolves. `keep-conflicts`
(losing revisions retained for a client merge, stale `If-Match` accepted as a
sibling) is reserved and not implemented. Member values are wire decisions
pending sign-off.

Implemented 2026-10-03. Judgment calls, for review. A tombstone keeps no bytes
and no digest on either backend, so a write over one is an ordinary create: the
stamp resolves it, as the context above says. "Equal body `Digest`" is read as
equal content type and equal stored bytes, a JSON body compared as the
`JSON.stringify` serialization both backends store; nothing stores a digest, so
the filesystem backend hashes both sides and Postgres compares the bytea.
Preconditions are evaluated first, so `If-None-Match: *` over a live Resource
stays a 412 rather than the no-op. The repeat takes no feed position and mints
no stamp. Create Collection by `POST` carries the full Metadata object, so it
declares `revisions` directly; the "first `PUT .../meta` of a Collection created
by `POST`" has no marker the server could read without a new stored member, so
it is not a declaring write here. On a governed Collection a direct `revisions`
write is checked against the derived descriptor and not stored (its `merge` is
dropped; the log holds the descriptor). No new error name was needed. Unknown
members of `revisions` are refused as `invalid-request-body`. Resource `/meta`
writes are not restricted on an immutable Collection; the decision does not name
them (open). The `encryption` half of creation-only is filed as WSS-194. Design
open point 7 (import) is recorded in the design doc: import is
skip-not-overwrite, so a differing archived body is skipped rather than refused;
the decision's premise that import bypasses the envelope rule does not hold
here, since `assertImportBodiesFit` enforces it.

---

### WSS-174: [M] [blocks 2] Collection tombstones

- status: done
- done: 2026-10-03
- priority: medium
- labels: data-model, replication, filesystem-backend, postgres-backend
- blocks: WSS-96, WSS-176
- touches:
  - portable-web-spaces-spec: Delete Collection, the Space listing -- filed
    WASS-48 (also: Delete Collection of an already deleted Collection answers
    404, while an id never used keeps the spec's 204)
  - storage-core: the Collection listing type -- SC-9 (0.31.0 TBD,
    `CollectionTombstoneSummary`), consumed here through a temporary `link:`
    until published
  - space-archive: the Metadata file and manifest dialect (tombstone form,
    `_version` retired, stamp members stored bare) -- SAR-7 (0.7.0 TBD, codec
    shipped locally), consumed here through a temporary `link:` until published
  - was-teaching-server: both backends' `deleteCollection` and Space listing,
    `src/lib/etag.ts` hard-delete rule, ARCHITECTURE.md -- shipped here
  - conformance-suite: the listing flag -- needs an item filed for the
    `?include=deleted` listing cases (none filed yet)
  - unaffected: wallet-backup (its survey acts only on the `collection` and
    `chunk` archive areas, so it skips the new tombstone area)
- acceptance:
  - [x] Delete Collection leaves a stamped tombstone (the Collection Metadata
        record marked deleted, carrying its generation and storing `updatedAt`,
        `updatedAtCounter`, and `originId` verbatim like every other versioned
        record) in place of the hard delete; Resources and chunks under it are
        still removed
  - [x] The tombstone exports as the Collection's `.collection.<id>.json` with
        `deleted: true` and no member directory, flagged on the manifest entry;
        import writes it only when the destination holds no record under that id
  - [x] A re-create under the same id mints a new generation; the tombstone's
        stamp decides against a replicated concurrent write
  - [x] The Space listing can include tombstoned Collections under a query flag
        (name pending sign-off) for the puller, and excludes them otherwise
  - [x] Tombstones are never reaped (WSS-13 owns retention)
  - [x] Tests cover the tombstone, the listing flag, and re-creation

Context (discovered-from: WSS-96, decision 5). A hard delete replicated by pull
resurrects on the next pull from a peer that still holds the Collection, the
Cassandra `gc_grace_seconds` hazard. The changes feed is per Collection, so the
Space listing is the channel in which a deleted Collection can be seen. Delete
Space needs no tombstone: a Space on two servers is two URL identities, each
deleted by its own root invocation, and the replication registration (WSS-176)
dies with the Space.

Shipped 2026-10-03. The query flag is `?include=deleted` (decision 0011),
honored only under a verified capability. The tombstone carries the stamp a
replicated write is compared against; the comparison itself is the apply path's
(WSS-176). The filesystem tombstone stays as `.collection.<id>.json` in the
emptied Collection dir, and an unfinished cascade is finished at boot, on a
read, by a retried delete, by a create over it, and by an import over it. A
retried delete answers 404; an id never used answers 204. Postgres keeps the
`collections` row with a `deleted` column (migration v10).

---

### WSS-175: [M] [blocks 2] Server sync key and verification of a peer's invocations

- status: done
- done: 2026-10-03
- priority: medium
- labels: replication, security, zcap, webvh, service-description
- blocks: WSS-96, WSS-176
- touches:
  - was-teaching-server: `src/lib/serverIdentity.ts`, `src/zcap.ts`,
    `src/lib/webvhController.ts`, `docs/admin-guide.md` (a `di` runbook step) --
    shipped here, with `src/lib/syncIdentity.ts`, `src/lib/peerWebvh.ts` and
    `src/lib/outboundAddress.ts`; `src/serviceDescription.ts` unaffected (no
    member names the key)
  - portable-web-spaces-spec: the peer `space:server:id` fetch, its bounds and
    the one-key signing rule -- covered by WASS-50 (the replication companion
    specification); the service description's `instance` member is unaffected
  - freewallet: delegating the pull capability to a server identity -- filed
    FW-638
  - did-cli: `di` 0.17.0 cannot add a relationship to a key the document already
    lists, so the runbook adds `capabilityInvocation` at mint or at a seed
    rotation -- filed CLI-24
- acceptance:
  - [x] The one seed key serves export signing and sync invocation; no second
        key is derived and no `/service` member names it. `resolveServerDid` and
        the import statement check require the key under `assertionMethod`,
        permit `capabilityInvocation`, and still refuse `capabilityDelegation`,
        `authentication` and `keyAgreement`
  - [x] The admin guide shows adding `capabilityInvocation` to the key's log
        entry; that relationship is the switch that enables replication
  - [x] The server signs sync invocations with the `did:webvh` method
        `{serverDid}#{key}`; a controller delegates the pull capability to
        `serverDid`; a registration on a server with no advertised `serverDid`,
        or whose log lacks the key under `capabilityInvocation`, is refused
        naming that
  - [x] A foreign `did:webvh` is resolved over the network only when it is the
        invoker named by a delegated capability whose chain already verified to
        the Space controller and its path is `space:server:id`; the log is
        fetched from that host, verified like any log, cached per DID,
        re-fetched once when a signature names a key the cached document lacks,
        with a size bound and timeout; any other foreign `did:webvh` stays
        refused
  - [x] Tests cover the `did:webvh` signing form, the bounded fetch, the
        re-fetch on a key miss, and the refusals

Context (discovered-from: WSS-96, decision 6c). The pulling server's own
`did:webvh` lives in its `server` Space, which no user controller replicates, so
the serving server cannot resolve it from storage. The fetch is the first
network resolution in this server and is bounded by shape and by the
controller's delegation. WSS-162's findings note covers the general question and
applies here; this item takes the bounded form only.

Shipped 2026-10-03. There is no `did:key` signing form (decision 0003), so the
acceptance line on tests names the `did:webvh` form alone. `loadSyncSigner`
(`src/lib/syncIdentity.ts`) returns the signer or the refusal reason; the
registration route that answers with it is WSS-176's. The fetch gate is a
pre-pass in `handleZcapVerify` on the PWS route families only: `/kms`,
revocation submission, create consent and List Spaces stay local-only. A peer
DID may invoke and may not delegate. A peer whose grant is revoked or expired
gets the plain masked `not-found`, since the pre-pass refuses before its key
resolves. A refresh of a DID with a verified head does not draw on the per-host
fetch window. Review findings left open: WSS-197 (the witness fetch in
`verifyWebvhLog`, older than this item) and WSS-198 (head records and fetch
bounds that outlive a restart or an eviction).

---

### WSS-182: [M] [blocks 2] Changes feed carries every record kind in the Collection

- status: done
- done: 2026-10-04
- priority: medium
- labels: changes-feed, replication, wire-contract, filesystem-backend,
  postgres-backend
- blocks: WSS-96, WSS-176
- touches:
  - portable-web-spaces-spec: the `changes` profile (the `kind` member, the
    `contentType` member, every content type admitted; the "Collection Metadata
    writes are invisible to replication" sentence revised) -- filed: WASS-51
  - storage-core: `ChangeDocument` -- shipped: 0.32.0 (the `kind` union,
    `isResourceChange`, `deleted`, `generation`), publish pending
  - was-teaching-server: `changesSince` in both backends, the feed position
    assignment on every write kind, ARCHITECTURE.md -- shipped with this item
  - was-client: `Collection.changes()` document type -- shipped: WCL-122
    (0.89.0, publish pending); the sync port filters to JSON `resource`
    documents and maps `deleted` to `_deleted`
  - was-sync, dcw, was-react: filter the feed on `kind` -- was-sync: WS-24
    (reads the port's documents only, no source change); was-react: WR-55
    (`SharedCollectionReader` filters on `kind`); unaffected: dcw (reads the
    feed only through the sync port)
  - conformance-suite: feed cases for binary Resources and the other kinds --
    shipped: PWSCS-20 (0.29.0, publish pending)
- acceptance:
  - [x] Every Resource write, whatever its content type (binary, `text/jsonl`,
        JSON), and every Resource tombstone takes a feed position and appears in
        the feed with a `contentType` member
  - [x] A Collection Metadata write and a governed-log append each take a feed
        position and appear in the feed, each change document carrying a `kind`
        member (`resource`, `collection-metadata`, `log`) that existing
        consumers filter on; a Resource change carries the Resource kind. The
        `policy` kind moved to WSS-183 (2026-10-04), since a policy has no stamp
        or tombstone until then
  - [x] Each change document carries the record's stamp and generation (a
        top-level `generation` member), so a puller can decide apply-or-skip
        from the feed alone
  - [x] The change document's `_deleted` member is renamed `deleted`, the
        tombstone marker every object in the design uses; was-sync maps it to
        RxDB's `_deleted` at its boundary; a `collection-metadata` or `log`
        document carries the record's absolute URL as its `id`
  - [x] Tests cover each kind in both backends, and the client repos' filters

Context (discovered-from: WSS-96, open point 7). The feed carried JSON Resources
only, so binary Resources, `did.jsonl`, their tombstones, Collection Metadata
writes, policies and the governed log were invisible to a replica, and the
controller's log, the one Collection the design always replicates, could not be
discovered. A separate replication listing was weighed and declined: one channel
with a `kind` discriminator is one checkpoint and one stamp order per
Collection, and a client syncing a Collection should see every Resource in it
regardless of content type. Space-level state (Space Metadata `name`, the Space
policy, Collection tombstones) has no Collection feed to ride and is discovered
by the pull loop (WSS-176) through the tombstone-aware Space listing and
conditional reads.

Shipped 2026-10-04. Sign-off the same day settled two wire details the
2026-10-02 decision left open: a `collection-metadata` or `log` document carries
the record's absolute URL as its `id`, and every document carries a top-level
`generation`. The `policy` kind moved to WSS-183. The Collection's own tombstone
is not in the feed, since Delete Collection removes the feed with the
Collection; the pull loop finds it through the Space listing.

---

### WSS-190: [M] A `/meta`-only write leaves the content record's stamp unchanged

- status: done
- done: 2026-10-04
- priority: medium
- labels: data-model, etag, changes-feed, filesystem-backend, postgres-backend
- touches:
  - portable-web-spaces-spec: the Update Resource Metadata operation (what it
    does and does not change), the Resource data model's `updatedAt` definition,
    and the `changes` profile's metadata-only sentence; text landed in the spec
    working tree 2026-10-04
  - was-teaching-server: both backends' `/meta` write path already kept the
    content stamp (shipped with WSS-172); the contract tests, the WSS-96 design
    doc sentence, and ARCHITECTURE.md landed here
  - was-sync: WS-23's design matrix row for a metadata-only push now reads as
    decided (2026-10-04); freewallet FW-639 and was-react WR-56 filed for the
    row sorting
  - conformance-suite: PWSCS-21 filed (a case asserting the content `ETag` and
    `updatedAt` survive a `/meta` write)
- acceptance:
  - [x] A `PUT /:id/meta` mints a stamp on the `/meta` record only: the content
        record's `updatedAt`, `updatedAtCounter`, `originId`, and `ETag` are
        unchanged by it, in both backends
  - [x] The change document a `/meta` write produces carries the unchanged
        content stamp at the top level and the new stamp under `meta`
  - [x] The WSS-96 design doc states the rule in one sentence under open point
        2, and the spec's Update Resource Metadata text says the operation does
        not change the content record's `updatedAt` or validator
  - [x] Tests in both backends write content, then `/meta`, and assert the
        content `ETag` and top-level `updatedAt` are byte-equal before and
        after, while `meta.updatedAt` moved

Context (discovered-from: WSS-96, open point 2; raised by was-sync WS-23's
review on 2026-10-03). Today the two records share one sidecar with one
`updatedAt`, and a `/meta` write sets `updatedAt: now` on it. WSS-96's open
point 2 (decided 2026-10-01) gives the `/meta` record its own nested stamp and
keeps the content record's `updatedAt` as the top-level member, which implies a
metadata write no longer moves the content stamp, since otherwise the content
validator would change on a write that touched no content. The design never
states it, and a reader of the current server behavior would assume the
opposite. The consequence for a replication client is visible: an app that bumps
a row's `updatedAt` on a metadata-only edit and sorts rows by it will see the
echo put the older content `updatedAt` back. was-sync's WS-23 takes the stamp
model's answer and points its consumers at the payload's own `updatedAt` for
sorting; this item makes the server and the spec say it.

---

### WSS-189: [M] Write responses carry the record's stamp and provenance, container writes included

- status: done
- done: 2026-10-04
- priority: medium
- labels: wire-contract, data-model, resource-api, filesystem-backend,
  postgres-backend
- touches:
  - portable-web-spaces-spec: the Create/Update Resource and Update Resource
    Metadata operation bullets and examples (`201` / `200` with a body), the
    `createdBy` definition's resurrection exception, Version History
  - storage-core: `ResourceMetadata` JSDoc notes the write response subset
  - was-client: `WriteAck` gains `updatedAt`, `updatedAtCounter`, `originId`,
    `createdBy`, and `meta` on a `/meta` write, lifted from a `2xx` body behind
    a shape guard; `putMeta` returns an ack with no validator
  - was-sync: WS-17 (the ack write-back stamps the members under WS-23's unit
    rule)
  - wallet-core: the engine may adopt the new ack members
  - conformance-suite: six strict-`204` sites accept `201` / `200` / `204` and
    check the body shape; ships before the server; landed in the suite working
    tree 2026-10-04 (seven sites, through one `assertResourceWriteResponse`
    helper), publish pending
  - was-teaching-server: `src/requests/ResourceRequest.ts`,
    `src/requests/CollectionRequest.ts`, `src/requests/SpaceRequest.ts`,
    `src/requests/SpacesRepositoryRequest.ts`, both backends' write return
    types, `writeSpace` and `writeCollection` included (breaking for custom
    backends), ARCHITECTURE.md, the WSS-96 design doc's wire inventory; shipped
    here 2026-10-04
- acceptance:
  - [x] `PUT /:id` answers `201 Created` when it created the Resource (a
        re-creation over a tombstone included) and `200 OK` when it updated a
        live one; `PUT /:id/meta` answers `200 OK` and never creates; both keep
        the `ETag` header and send `Content-Type: application/json`
  - [x] The body holds server-managed members only: `contentType`, `size`, and
        the record's full stamp (`updatedAt`, `updatedAtCounter`, `originId`)
        always; `createdAt` and `createdBy` only on a `201`; on a `/meta` write
        the nested `meta` stamp as well; no `custom` and no `data`
  - [x] A Resource re-created over a tombstone records this write's invoker as
        `createdBy` and this write's time as `createdAt` (fresh provenance; the
        tombstone's is not preserved), in both backends
  - [x] The values come from the write under its lock, so a concurrent writer
        cannot make the body describe another revision (a Postgres case pins it)
  - [x] The WSS-96 design doc's wire inventory gains the write response body as
        an item, and ARCHITECTURE.md describes the two statuses and the body
  - [x] Tests cover `201` / `200` on content writes, `200` on `/meta`, `404` on
        a `/meta` write to an absent Resource, the body members, and the stamp
        in the body equal to the stamp the feed then carries
  - [x] Container writes follow the same rule: `writeSpace` and
        `writeCollection` return the stored Metadata object and whether the
        write created it, and Create Space, Create Collection, and the
        create-by-`PUT` of a container's `meta` send that object and choose
        `201` or `204` from it, in place of an echo rebuilt from the request
  - [x] A test in both backends races two unconditional `PUT`s of one new
        Collection's `meta` and asserts the second response does not claim the
        create: its status, `createdAt`, and `createdBy` match a read

Context (discovered-from: WSS-96, via was-sync WS-17 and WS-23). A replication
client that pushes a write learns only an `ETag` from today's `204`, so the
server-assigned members (`createdBy`, the server's `updatedAt`, and under
WSS-172 the whole stamp) reach its local row only through the feed echo. RxDB
drops that echo when it is pulled while the push is still settling, and nothing
on the client can cover the push's own HTTP latency. was-sync's WS-17 design
(signed off 2026-10-02, body shape revised the same day) therefore has the write
response carry the server-managed members. WSS-96 then replaced the revision
counter with the stamp, and on 2026-10-03 the two were reconciled: the body
carries the full stamp, so the server changes its write response once and a
pushed row compares equal to its echo without waiting for it. WSS-96's wire
inventory has no entry for a write response body; this item adds it. The
statuses and the fresh-provenance rule are as signed off in was-sync's
`designs/WS-17-ack-carries-server-state.md`; the stamp members are WSS-172's.

Widened 2026-10-03 to container writes (discovered-from: WSS-172). The create
echo of a container is rebuilt in the handler from the request body, over no
prior object, with the invoker as `createdBy`. The handler decides create or
update from a read made before the backend's lock. Two unconditional `PUT`s of
one new Collection's `meta` can both read it as absent; the second write is then
an update in the backend, which keeps the first writer's `createdAt` and
`createdBy`, while its response is a `201` naming the second writer. The `ETag`
and the stamp members are right, since they come from the write. A guarded
create (`If-None-Match: *`) is unaffected. The Space create paths were not
traced; Update Space pins its write to its earlier read and may already be
covered.

Shipped 2026-10-04. A write-once repeat answers `200` with the stored members. A
content write's body carries no `meta`. The Space create paths were traced and
had no race: Create Space is always a guarded create, and Update Space pins its
write to its read. The Collection `PUT .../meta` race was real and is pinned by
a test.

### WSS-188: [H] [after WSS-187] A request-level tear and hold seam on the testing export

- status: done
- done: 2026-10-04
- priority: high
- labels: tests, fault-injection, consumers
- discovered-from: FW-634 (freewallet's test-infrastructure read, 2026-10-03)
- blocked-by: WSS-187 (DONE)
- touches:
  - [x] freewallet (FW-634: ports one torn-ceremony case to the seam)
  - [ ] wallet-core (WC-269: its integration tier tears with the seam)
- acceptance:
  - [x] A first check settles the mechanism. A root Fastify hook added after
        `createApp()` either reaches every route group, the KMS facet included,
        or the item records what does. Checked 2026-10-03: it reaches every
        group but runs behind each group's own hooks, so the hooks go on before
        the plugin is registered (see below)
  - [x] Tear, grade one: the first request matching a predicate (method, path,
        invoking DID) is refused before any handler runs, with a chosen status
  - [x] Tear, grade two: the first matching request is applied and its response
        is dropped, so the client sees a transport failure over a write that
        landed
  - [x] Hold: a matching request pauses until the test releases it
  - [x] Every request is recorded in order with its method, path, and invoking
        DID
  - [x] Each of the four has a test in this repo's own suite
        (`test/request-faults.test.ts`)
  - [x] The seam is reachable only through `was-teaching-server/testing`, and
        `FastifyWasOptions` gains no member for it

Consumers test ceremonies that write several resources in order, and most of
their open bugs are about a run interrupted between two of those writes. The
server has no way to fail a chosen request. Its only fault tests mock
`node:fs/promises` at the syscall level. So each consumer invents its own tear:
freewallet's Playwright suite aborts routes in the browser, compiles window-flag
seams into the app, and simulates a tab death, and wallet-core's fakes carry
hand-written kill switches.

The two tear grades are different states. A refused request leaves the store
untouched. A dropped response leaves the write durable while the client believes
it failed. The second is the case a consumer's re-run has to detect from stored
state, and a browser-side route abort cannot produce it.

The hold is for interleaving two clients at a chosen write, such as two signups
whose existence probes both miss before either one binds.

A wrapper around the storage backend was the other candidate. It tears after
authorization and has to cover the whole `StorageBackend` interface, about 50
members. The hook is tried first for that reason.

Findings, 2026-10-03. A root hook added after `createApp()` reaches every route
group, `/kms` included, but runs behind each group's own hooks. An unsigned
write that `requireAuthHeaders` refuses with a 401 never reaches a root
`onRequest` hook added that late, so the record would miss it. That a signed
request is seen at all rests on the order Fastify loads plugins in. The seam's
hooks are therefore added to the root instance before the protocol plugin is
registered. `createApp()` is split for that: it builds the instance and calls
`composeApp({ fastify, ...options })`, which `startTestServer()` calls itself
after adding the hooks. `composeApp` is not exported from the package root.

The seam is `src/lib/requestFaults.ts`, returned by `startTestServer()` as
`faults`: `refuse`, `dropResponse`, `hold`, `requests`, `reset`.

- The invoking DID is read off the `Authorization` header's `keyId` before any
  signature is verified, since the seam runs ahead of `parseAuthHeaders`. It
  names who the request claims to be signed by.
- An object predicate with no `method` never matches `OPTIONS`, so a browser's
  CORS preflight does not take a fault meant for the request behind it.
- The client stack retries. A `PUT` refused with a 5xx, or one whose response is
  dropped, is sent again by was-client's HTTP layer, and a fault that fires once
  is absorbed without the caller seeing it. The two tears take a `times` option
  for that (default 1, `Infinity` allowed), and a refusal with a 4xx status is
  not retried. Under grade two each retry is applied again.
- Grade two closes the socket in an `onSend` hook, after the handler has
  finished. It is meant for writes. A streamed response may have nothing to
  lose.
- A held request is an active connection, which `fastify.close()` waits on. A
  `preClose` hook releases every hold, and `reset()` does too.

### WSS-187: [H] Export the in-process test boot as `was-teaching-server/testing`

- status: done
- done: 2026-10-04
- priority: high
- labels: tests, packaging, consumers
- discovered-from: FW-633 (freewallet's test-infrastructure read, 2026-10-03)
- touches:
  - [x] freewallet (FW-633, done 2026-10-04: takes 0.40.0 from the registry as a
        devDependency and boots its conformance suite through this export)
  - [ ] wallet-core (WC-269: its integration tier boots through this export)
  - [x] was-sync, was-react, dcw (shipped: each boots its in-process server
        suites through this export, with `startTestServer` and
        `openTempBackend`, and no longer calls `new FileSystemBackend(...)`)
  - [x] `docs/consuming-server-as-library.md` (shipped: the "Testing against the
        server" section)
- acceptance:
  - [x] `package.json` exports `./testing`, built to `dist`, with types
  - [x] The export carries `startTestServer` (the `localhost` server URL fix-up
        included; since WSS-188 it boots through `composeApp()` and also returns
        `faults`) and a helper that opens a `FileSystemBackend` on a fresh temp
        dir and removes it on close
  - [x] The export carries the webvh identity provisioner
        (`provisionWebvhIdentity`, with its ladder and transient VM shapes).
        Decided 2026-10-03: it is exported
  - [x] The export pulls in no test runner: nothing under it imports `vitest`
  - [x] The server's own suites import the helpers from the same source file the
        export is built from, so there is one copy
  - [x] `docs/consuming-server-as-library.md` shows the boot through the export
        and through the async `open()` backend factory

The in-process boot lives in `test/helpers.ts`, which is outside `dist`. Every
consumer that runs tests against the real server copies the recipe: `createApp`
with `serverUrl: 'http://localhost'`, `listen({ port: 0 })`, read the port, then
set `fastify.serverUrl`. was-sync, was-react, dcw, and freewallet's conformance
suite each carry a copy, and wallet-core is about to add another. The
`localhost` detail matters, since webkms-client relaxes its loopback checks for
that host alone, and a copy that uses `127.0.0.1` fails in the KMS facet only.

The same consumers construct the backend with `new FileSystemBackend(...)`. The
0.40.0 source makes backends come only from the async `open()` factory, so each
of them breaks on that release. A shared helper that opens the backend gives
them one call to move to.

`provisionWebvhIdentity` is exported too (decided 2026-10-03). It builds a
did:webvh identity by hand, in the ladder and transient VM shapes, without
running a wallet ceremony. That suits a consumer test about a server rule, where
the identity is setup and the ceremony is not under test. A test about the
ceremonies themselves builds its account through wallet-core's account builder
(WC-270) instead.

The export is test support. It adds nothing to the production plugin's options.

### WSS-183: [M] [blocks 2] Stamped, tombstoned access-control policies

- status: done
- done: 2026-10-04
- priority: medium
- labels: data-model, authz, replication, etag, wire-contract,
  filesystem-backend, postgres-backend
- blocks: WSS-96, WSS-176
- touches:
  - portable-web-spaces-spec: "Access Control Policies" (the served stamp
    members, the `ETag`, the preconditions, the tombstone) -- filed: WASS-52
  - storage-core: `PolicyDocument` -- shipped: 0.34.0 (stamp members,
    `PolicyTombstone`, `PolicyChangeDocument`), publish pending
  - was-teaching-server: `PolicyRequest`, both backends' policy storage,
    `src/lib/policyCache.ts`, ARCHITECTURE.md -- shipped with this item
  - was-client: policy preconditions (optional) -- filed: WCL-123
  - conformance-suite: policy `ETag` and precondition cases -- filed: PWSCS-22
    (the current suite passes unchanged)
- acceptance:
  - [x] A stored policy carries the three stamp members and a generation;
        `GET /policy` at each level serves the four-field `ETag` and the stamp
        members as server-derived members a write body ignores
  - [x] `PUT` and `DELETE /policy` take `If-Match` / `If-None-Match: *`
  - [x] `DELETE` writes a tombstone (`deleted: true`) in place of the hard
        delete; a tombstoned policy grants nothing and reads as absent
        everywhere except the changes feed (WSS-182) and the apply path
        (WSS-176); the Space policy's tombstone is readable with its stamp by
        the pull loop (`GET /policy?include=deleted` under a capability, as
        decided 2026-10-02)
  - [x] A Collection or Resource `/policy` write or tombstone takes a feed
        position and appears in the `changes` feed as a `kind: policy` document
        carrying the policy's stamp, generation and URL (moved from WSS-182,
        2026-10-04). Decided 2026-10-04: the document carries the policy's
        absolute URL as `id`, like the other non-Resource kinds, with no
        `target` member. storage-core's `ChangeDocument` gains the kind
  - [x] Tests cover the validator, the preconditions, the tombstone and the
        fail-closed read at all three levels, in both backends

Context (discovered-from: WSS-96, open point 6). A policy had no validator, no
`updatedAt`, and a hard delete, so "LWW by stamp" could not order two replicas'
policies and a removed `PublicCanRead` policy would come back from a peer that
still held it, a privacy regression rather than a stale record.

Decided 2026-10-04: an export archive carries live policies only, each with its
stamp members and `_generation`. An import skips a level where the destination
holds a policy or a tombstone. A store holding policies written before stamps is
refused at startup (filesystem layout version 3, Postgres migration 12).

### WSS-200: [L] Feed counter file grows with every Resource policy

- status: done
- done: 2026-10-04
- priority: low
- labels: performance, filesystem-backend, changes-feed
- discovered-from: simplify pass over the stamped-policies change (2026-10-04)
- acceptance:
  - [x] A feed-visible write that is not a policy write (a Resource write, a
        Resource `/meta` write, a soft delete, a Collection Metadata write, a
        governed-log write) reads and rewrites a counter file whose size does
        not depend on how many Resource policies the Collection holds
  - [x] A `changesSince` poll that is caught up reads no per-policy state beyond
        one bounded file
  - [x] The feed still carries one `policy` document per policy record at the
        position of its latest write, tombstones included, and a policy file
        still matches its recorded position under the `feed:` key
  - [x] The item decides whether the per-record members
        (`collectionMetadataPosition`, `logPosition`,
        `collectionPolicyPosition`) become one map keyed by record, and
        `FeedRecord` one flat tagged union. If the layout changes, it is a new
        store version with a refusal step and no conversion step
  - [x] Tests in `test/`: a Collection holding many Resource policies takes a
        Resource write without rewriting their positions (observable through the
        bytes written to the counter file), and the storage contract's policy
        feed cases pass unchanged
  - [x] ARCHITECTURE.md (`lib/changesCheckpoint.ts`, the Glossary's Feed
        position) names where a policy's position is kept

Context: the filesystem backend keeps each Collection's feed counter in
`.feed.<collectionId>.json`. Every feed-visible write reads the file, takes the
next position, and rewrites it whole (`#takeFeedPosition`). The file also
records the latest position of each record that has no sidecar to carry it.
Since policies became versioned records, that includes
`resourcePolicyPositions`, a map with one entry per Resource policy ever
written. A policy delete leaves a tombstone, which keeps its entry, so the map
only grows. An ordinary Resource `PUT` therefore re-serializes the whole map,
and so does each `changesSince` poll that parses the file. The cost per write is
proportional to the number of Resource policies in the Collection, and an import
of n Resource policies writes O(n^2) bytes. A Collection with few per-Resource
policies does not notice.

One option keeps the Resource policy positions in their own per-Collection file
that only a policy write touches, still under the `feed:` key. That leaves the
existing counter members alone. Another stores the position in the policy file
itself, as a Resource sidecar stores `feedPosition`. The policy file is what an
export archives as stored, so export would then have to strip the member.

The counter's shape is a second, smaller cost. Each record kind has its own
member and its own branch in `advancedFeedCounter`, and `FeedRecord` mixes
string literals with `{ policy: string | undefined }`, where `undefined` means
the Collection's own policy. The Postgres backend is unaffected: a policy's
position is the `policies.feed_position` column.

Decided 2026-10-04: a Collection or Resource policy keeps its feed position in
its own policy file, as `_feedPosition`. The counter file keeps the Collection
Metadata object's and the log's positions in one `records` map, and `FeedRecord`
is a flat tagged union. The layout is filesystem store version 4, a refusal step
with no conversion.

---

### WSS-176: [M] [blocks 4] Replica registration, pull loop, and the apply path

- status: done
- done: 2026-10-04
- priority: medium
- labels: replication, routes, filesystem-backend, postgres-backend,
  space-metadata
- blocks: WSS-96, WSS-177, WSS-179, WSS-184
- touches:
  - portable-web-spaces-spec: the replication specification (registration
    object, pull loop, apply rule, clock bound; its own document and version),
    the Space Metadata object's `replicas` member, the `replication` entry on
    `/service`. Filed there as acceptance lines on WASS-50 (the wire details
    decided 2026-10-04) and WASS-51 (the `GET` form of the changes query).
    Decisions 0011 and 0013 were amended in place the same day
  - storage-core: `SpaceMetadata.replicas`, the registration type. Shipped
    2026-10-04, unpublished (0.35.0), as its SC-10: `ReplicaRegistration`,
    `ReplicaSummary`, `ReplicaStatus`, `ReplicaListing`, `ReplicaStallReason`,
    `ProblemTypes.REPLICA_REFUSED`, `CollectionMetadata.created`, and `replicas`
    and `zcaps` in `RESERVED_COLLECTION_IDS`. Consumed here by `link:` until
    0.35.0 is published
  - was-teaching-server: `routes.ts`, a `*Request` class for the registration,
    `src/lib/containerRule.ts`, a sync module, `StorageBackend` (apply methods),
    `src/lib/spaceProjection.ts`, ARCHITECTURE.md. Shipped 2026-10-04
  - was-client: the `replicas` member; a registration API. Filed as WCL-127
  - freewallet: the registration flow. Filed as acceptance lines on FW-638
  - conformance-suite: the registration endpoints. Filed as PWSCS-23, which also
    names the eight cases that fail against this server until the suite follows
    the `replicas` and `created` members and the `GET` query form
- acceptance:
  - [x] A controller-only, per-server registration sub-resource of the Space
        (`/space/:spaceId/replicas`) holds one source peer as a directed edge:
        `fromSpace`, `toSpace`, the delegated pull capability, an optional
        `collections` list of `{ id }` objects and a `role`; a `status`
        sub-resource serves the loop's runtime state per Collection; registering
        reads the peer's `/service` for its `originId` and its replication entry
        at a version this server speaks, refuses a peer lacking either or
        advertising this server's own id, and refuses a peer whose Space `type`
        set differs
  - [x] The registration is not replicated and is removed with Delete Space
  - [x] A pull loop per registration lists the peer's Space (tombstones
        included), filters by the Collection list with Space-level state and the
        controller's log Collection always included, pulls each Collection's
        changes feed under the per-peer opaque checkpoint, fetches each
        representation by `GET`, and applies through backend `apply*` methods
        that store the stamp verbatim and take a local feed position
  - [x] Apply is one comparison on `(ms, counter, origin)`: greater than the
        held revision applies, else skipped (dedup and loop check included);
        logs fast-forward or stall; revocations are not replicated; a received
        stamp more than the configured bound ahead of local time stalls the pull
        with a `warn`
  - [x] The served Space Metadata object carries a server-derived `replicas`
        member listing each registered peer's Space URL and role
  - [x] A peer answering 404 for the Space ends the cycle with one `warn`, and
        the loop backs off (reworded 2026-10-04 to follow the design's review:
        nothing stops a loop but the removal of its registration)
  - [x] Tests: the two-server test named on WSS-96

Context (discovered-from: WSS-96, decisions 4 to 6). Pull only, because a
replicated write must arrive with its origin stamp and no ordinary write route
can accept one without a new kind of trust. The replica is the Space so that
Space-level state, Collection lifecycle, and discovery ride one loop; the
Collection list gives per-peer selectivity. One-way replication is the default
shape: a registration names a source, and nothing flows back without a
counterpart registration on the other side.

The apply path also inherits the creating stamp from section 5.4 of the WSS-96
design: the stamp of a Collection's first write under its generation, stored
beside the generation, which decides a received generation change.

Shipped 2026-10-04. Wire details decided with the maintainer that day, beyond
the design: the `replica-refused` problem type (409), the `stall.reason` tokens,
the listing object, the `https://w3id.org/pws#replicas` linkset relation, the
Collection Metadata object's nested `created` stamp, and the read-only
`GET .../query?profile=changes` form of the feed (the pull capability carries no
`POST`). Two departures from the design text. The apply path checks the
registration on every apply, where the design said once per batch. A received
stamp that carries this server's own origin id goes through the one comparison
like any other, where section 5.2 said to refuse it. Follow-ups: WSS-201 and
WSS-202.

---

### WSS-177: [M] [blocks 1] Resolve a replicated peer-hosted `did:webvh` controller from storage

- status: done
- done: 2026-10-04
- priority: medium
- labels: replication, webvh, zcap, security
- blocks: WSS-96
- touches:
  - was-teaching-server: `src/lib/webvhController.ts`, `src/zcap.ts`,
    ARCHITECTURE.md (the Controller and self-hosted `did:webvh` entries) --
    shipped with this item
  - portable-web-spaces-spec: the authz profile's self-hosted rule -- filed:
    WASS-53 (the rule lives in the core spec's "Self-hosted histories" section)
  - freewallet: a controller log that now has copies; the DR flow (appending on
    the surviving replica) -- filed: FW-648
- acceptance:
  - [x] A `did:webvh` whose host is a registered peer and whose log Collection
        is replicated here resolves from the local copy, through the same
        verify, cache, head-record and fast-forward path as a native log; no
        network fetch
  - [x] Update Space to such a controller, and Create Space by Id under one,
        work on the replica
  - [x] Any other cross-host `did:webvh` resolves over the network as the
        invoker of a delegated capability, unless the operator's blocklist
        (`WAS_WEBVH_BLOCKLIST`) names it or its host. It may not sign a
        delegation link or be a controller (reworded 2026-10-04 by the
        maintainer; the line read "Any other cross-host `did:webvh` stays
        refused")
  - [x] Tests resolve a controller minted on server A against server B after a
        pull, and assert a key retired on A stops authorizing on B after the
        next pull

Context (discovered-from: WSS-96, decision 6b). The replica can authorize
nothing without the controller's document. Fetching it from the original host
was rejected: if that host is lost for good, a cached document can never be
refreshed and the account can never rotate a key again, which defeats the
disaster-recovery purpose of a replica. A replicated copy keeps the account
alive on the surviving server, where the wallet can keep appending.

Shipped 2026-10-04. The maintainer amended the third acceptance line that day:
wallets will delegate to long-lived services and agents that carry their own
`did:webvh`, so a foreign DID must resolve unless blocklisted. The network
resolver built for peer server DIDs now takes any cross-host `did:webvh`, any
path or the host-only form, still as an invoker only. Decided with the
maintainer: the invoker-only role, and the `WAS_WEBVH_BLOCKLIST` variable taking
host names and full DIDs. Choices made in implementation: a DID that two local
Spaces map through their registrations resolves from neither copy; a replicated
log that declares witnesses is refused; the blocklist covers the network path
only; `createdBy` records a network-resolved invoker. Follow-ups: WSS-205 to
WSS-209.

---

### WSS-208: [L] `createdBy` under a provisioning grant comes from an unverified keyId

- status: done
- done: 2026-10-04
- priority: low
- labels: provenance, provisioning, security
- discovered-from: WSS-177 (2026-10-04)
- acceptance:
  - [x] A create admitted by a provisioning token alone records no `createdBy`,
        or records one only from a signature the server verified
  - [x] A test creates under a token with a `keyId` naming another party's DID
        and asserts that DID is not recorded

Context: `invokerDid` narrows the signing `keyId` by shape and leaves the
verification to the authorization that ran before it. A create admitted by the
provisioning token runs no signature verification, so the recorded DID is the
caller's claim. That held for a `did:key` before. The shape check now also
admits any `did:webvh`, so the claim can name those too.

Shipped 2026-10-04. `invokerDid` returns no DID when the provisioning policy
granted the request, so every create path records no `createdBy` under a grant.
The reachable case was Create Space by Id with the policy consulted late, after
a Space deleted past the gate's check, under a custom `authorizeProvisioning`.
The test covers a `did:key` and a foreign `did:webvh` `keyId`.

---

### WSS-205: [H] A Space promoted to its own `did:webvh` cannot gain a new replica

- status: done
- done: 2026-10-05
- priority: high
- labels: replication, webvh, registration
- discovered-from: WSS-177 (2026-10-04)
- touches:
  - was-teaching-server: `src/sync/registration.ts`, ARCHITECTURE.md (the
    `src/sync/` section) -- shipped 2026-10-05
  - portable-web-spaces-spec: the registration checks (WASS-50; an acceptance
    line on the key-membership branch was added there 2026-10-05)
  - freewallet: the replica registration flow (FW-638; an acceptance line on
    registering a promoted account's Space was added there 2026-10-05)
- acceptance:
  - [x] A Space whose controller is a `did:webvh` hosted in that Space can be
        registered as the source of a new Space on another server
  - [x] The stranger case stays closed: a holder of a readable pull capability
        still cannot register another user's Space as a source
  - [x] A two-server test registers a replica of an already promoted Space,
        pulls, and promotes the replica to the replicated DID

Context: a registration is refused unless the peer Space's `controller` equals
the local Space's. A new local Space is created under a `did:key`. A peer Space
already promoted to a `did:webvh` therefore never matches. Promoting the local
Space first needs the DID to resolve here, which needs the registration. The
setup works only while the origin Space is still under its `did:key`, which is
how the tests register. An account that was promoted before it gained a replica
has no path to one, and that is the common order. The design decision is what
replaces literal equality, for example a proof that the local controller is a
key of the peer controller's document.

Shipped 2026-10-05. The controller check has a second branch: the peer
controller is a `did:webvh` hosted in the peer Space whose current document
lists the local Space's `did:key` controller under `capabilityInvocation`. The
log is read through the pull capability and verified offline, and the
registration must pull the log's Collection. After the first pull, Update Space
moves the local Space to the DID. The test registers a Space the origin promoted
first, pulls, promotes the copy, and refuses a stranger's key and a key listed
under `capabilityDelegation` alone.

---

### WSS-197: [H] verifyWebvhLog fetches a log's witness file from any host the log names

- status: done
- done: 2026-10-05
- priority: high
- labels: security, webvh, ssrf, import
- discovered-from: WSS-175 (adversarial review, 2026-10-03)
- touches:
  - was-teaching-server: `src/lib/webvhController.ts` (`verifyWebvhLog`),
    `src/lib/importProvenance.ts`, `src/lib/webvhLogWrite.ts`, ARCHITECTURE.md
    (shipped: `verifyWebvhLog` passes an empty proof list on every path; the
    three callers and the per-caller conditionals are gone)
  - did-method-webvh: filed WEBVH-29 (a no-network setting and bounds on the
    default witness fetch). The library already takes `fetch` and
    `witnessProofs`, so this item does not wait on it (WEBVH-29 still open)
- acceptance:
  - [x] `verifyWebvhLog` makes no network request on any path: a log that
        declares witnesses is verified against proofs the caller supplies, or
        refused
  - [x] The three callers that pass no proofs are covered by a regression test
        each: the import statement check, the `did.jsonl` append check, and the
        local controller path
  - [x] ARCHITECTURE.md says what a witnessed log does at this server

Context: when `witnessProofs` is omitted, `@interop/did-method-webvh` fetches
`did-witness.json` with the global `fetch` for a log whose parameters declare a
witness. That request has no address check, no timeout and no size bound, and it
follows redirects. The host comes from the DID the log names. An Import Space
archive carries its own `did.jsonl`, and a `did.jsonl` create is not verified,
so a Space controller chooses that host in both cases. The peer server path
already passes an empty proof list, which fails closed. Whether a witnessed
self-hosted log should verify at all is the decision this item needs.

---

Resolution (2026-10-05): refuse everywhere. A log that declares witnesses does
not verify at this server on any path, and no proof-supply path was added. A
stored `did-witness.json` beside the log would be a new wire artifact and gets
its own item if a wallet ever needs witnesses.

### WSS-128: [H] Refuse a governing log on a Collection that declares `plaintext`

- status: done
- done: 2026-10-05
- priority: high
- labels: governed-history-logs, encryption, consistency
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] The guarded create in `CollectionRequest.putLog`'s `assertTransition`
        refuses when the stored Metadata object carries `plaintext`, on the same
        terms as a stored `encryption`
  - [x] A test declares `plaintext.indexes`, attempts the log create, and
        asserts the refusal and that a later `PUT /meta` rename still works
  - [x] `test/governed-log-api.test.ts` covers both orders (it covers only "add
        `plaintext` to a governed Collection" today)

The declaration check reads `collectionMetadata.encryption` only. After the log
lands, the served object carries both `plaintext` and the derived `encryption`,
and every later `PUT /meta`, including a bare rename or a `custom` write, is
refused 400 by the exclusion rule. `plaintext` has no removal path and the log
is append-only, so the Collection's Metadata object is permanently unwritable;
the only remedy is Delete Collection. `POST .../query` answers 501 on such a
Collection while `GET ?filter[...]` still runs the equality machinery.

### WSS-133: [M] The Resource `/meta` validator covers every member it serves

- status: done (2026-10-05)
- priority: medium
- labels: conditional-requests, etag, consistency
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `@interop/was-conformance-suite`: no case pins the old shape (304/304 pass);
    PWSCS-25 filed (2026-10-05) to assert the new behavior
  - unaffected: `was-client` (treats the `ETag` as opaque)
  - `portable-web-spaces-spec`: WASS-56 filed (2026-10-05) so "Update Resource
    Metadata" says a content write moves the Metadata object's `ETag` too
- acceptance:
  - [x] The `/meta` `ETag` is a content-first composite: the content record's
        validator (`"<generation>.<ms>.<counter>.<originId>"`), followed by the
        `/meta` record's own validator once metadata has been written. It
        therefore moves with every content write and every `/meta` write, and
        exists from the Resource's first write
  - [x] `PUT /meta` evaluates `If-Match` against the composite, in both
        backends, and answers with it
  - [x] `getCollectionOrThrow` reads the Collection Metadata object before the
        log, so a served `ETag` never pairs with a newer log head
  - [x] Tests: a conditional `GET /meta` after a content-type or `epoch` change
        is 200; a conditional `GET /meta` on a Resource with no metadata written
        answers 304 against its `ETag`; a conditional Collection Metadata read
        racing a log append never returns 304 for a body the server would not
        serve

The `/meta` `ETag` is built from the `/meta` record's stamp and generation
alone, which a content write deliberately leaves untouched, while the
representation includes content-derived members (`contentType`, `size`, the
content stamp, `epoch`, `writerId`). A cached `/meta` can keep naming a key
epoch the Resource no longer carries, with every revalidation affirming it.
Separately, the parallel metadata/log read pairs the post-append validator with
the pre-append descriptor, so a 304 pins a stale recipient set.

### WSS-143: [M] Method refusals answer before the auth hook, and every container has them

- status: done
- done: 2026-10-05
- priority: medium
- labels: routing, spec-conformance
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] An anonymous unsafe method at a reserved endpoint or container URL
        answers 405 with `Allow`, not 401 (register the refusal routes outside
        the auth hook, or give them a route-level `onRequest` that
        short-circuits it)
  - [x] `/space/:spaceId/backends/:backendId` and
        `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex` are in
        their group's refusal list, so `GET /space/S/backends/x` is a 405 rather
        than backtracking to the Resource route's 409 `reserved-id`;
        `GET /space/S/meta/log` likewise
  - [x] The `/spaces/` group ends with `refuseUnimplementedMethods` and the bare
        `/spaces` redirects for the whole `CONTAINER_REDIRECT_METHODS` set
  - [x] The strip-slash 308 on Resource and chunk URLs applies to every method,
        or to none (today `PUT` only)
  - [x] Tests per case

### WSS-211: [M] Paths under a reserved segment answer by method, not by id

- status: done
- done: 2026-10-05
- priority: medium
- labels: routing, spec-conformance
- discovered-from: WSS-143 (2026-10-05)
- acceptance:
  - [x] A path one level under a Space-level reserved segment that is no
        registered endpoint (`GET /space/S/policy/x`, `GET /space/S/export/x`,
        `GET /space/S/zcaps/revocations`) answers 404 or 405, not a 409
        `reserved-id` from the Resource route one level up
  - [x] `/space/:spaceId/zcaps/revocations/:revocationId` is in the Space
        group's refusal list, so a method other than `POST` there is a 405 with
        `Allow: POST` rather than a 404
  - [x] The bare `/space/S/zcaps` and `/space/S/zcaps/` do not redirect to or
        list a Collection named by a reserved segment
  - [x] Decide whether the bare container forms (`/space/S`, `/space/S/C`) join
        the refusal lists, so `PATCH /space/S` is a 405 with `Allow` rather than
        a 404; today only `/spaces` does
  - [x] Tests per case

The method refusals cover each registered reserved endpoint, so a reserved
segment answers 405 for a method it lacks. A path under such a segment is still
matched by the parametric Resource route, whose reserved-id guard refuses it as
a 409 about ids. The refusal reads no ids and must not depend on whether the
Space exists. The default Fastify 404 body on the unmatched cases is WSS-142's.

### WSS-206: [M] Two local Spaces registering one source leave its replicated DID unresolvable

- status: done (2026-10-05)
- priority: medium
- labels: replication, webvh, registration, lockout
- discovered-from: WSS-177 (2026-10-04)
- acceptance:
  - [x] A registration whose `fromSpace` another local Space already registers,
        and which would pull the same controller-log Collection, is refused with
        `replica-refused`, or the resolver gains a safe rule for choosing a copy
  - [x] Update Space to a peer-hosted `did:webvh` is refused when the promoted
        Space's own registrations would, under the new controller, select the
        log Collection another local Space already maps
  - [x] A test shows no sequence of registrations and promotions leaves a Space
        whose controller no longer resolves

Context: a peer-hosted `did:webvh` resolves from storage only when exactly one
local Space maps it through a registration. With two, it resolves from neither
copy, since either could be an older prefix that still lists a retired key. If
that DID controls both Spaces, nobody can then remove either registration or
either Space, and there is no break-glass. Refusing the second registration
changes registration behaviour, so it was left out of the resolver change.

Refined 2026-10-05: Register Replica refuses the second registration since
v0.42.0, so the first line is met. A probe found the sequence the second line
asks about still open, through a promotion rather than a registration. Space A
registers source S pulling the log Collection C. Space B, under a `did:key`,
registers S pulling only another Collection, which is admitted since the
selections are disjoint. B is then promoted to the DID hosted at S/C, which
resolves through A's copy. The selection rule adds the controller's log
Collection to B's registration once B's controller is that DID, so B becomes a
second holder of C and the DID resolves from neither copy. B's new controller
can no longer invoke, so B cannot remove its registration, and when A is under
the same DID neither Space can be repaired. The promotion is the step to guard:
it already resolves the DID before storing it, and can refuse when the promoted
Space's own registrations would select the log Collection another local Space
maps.

### WSS-213: [M] Orphan representation files on the filesystem backend

- status: done
- done: 2026-10-06
- priority: medium
- labels: filesystem-backend, consistency
- discovered-from: the sidecar `fileName` change (2026-10-06)
- acceptance:
  - [x] A representation file no live sidecar names (a torn write under a
        different content-type, a delete that crashed after its tombstone, a
        sidecar write that failed after the bytes landed) never appears in
        `listResources`, the changes feed, `#countLiveResources`,
        `#readEqualityCandidates` or `listChunks`, and never counts toward a
        quota
  - [x] Either those listings decide liveness from the sidecar, or a sweep
        removes such a file (at boot, or on the next write of its id), and
        ARCHITECTURE.md says which
  - [x] A test in `test/` plants an orphan beside a live Resource of the same id
        and asserts the id is listed once and counted once

Context: since the sidecar records `fileName`, a write or delete removes only
the file the prior sidecar named, and the next write of an id no longer prunes
every stale `r.<id>.*` file in the Collection directory. Reads are unaffected,
since they open the named file. The directory-driven listings still count every
`r.`-prefixed file, so an orphan can list an id twice, under two content-types,
and inflate the Resource count. The feed's live branch also does not check
`sidecar.deleted`, which predates the change.

Shipped 2026-10-06: every path that lists a directory decides liveness from the
sidecar, and Delete Resource and Delete Chunk remove every representation file
of the id, so a delete is the one path that reclaims an orphan. The Collection
listing's `totalItems` and the Resource count quota are exact.
`test/filesystem-ghost-files.test.ts` plants the orphans.

### WSS-68: [M] Import trusts the tarball's Collection Description `id`

- status: done
- done: 2026-10-05
- priority: medium
- labels: data-model, import, validation
- acceptance:
  - [x] An imported Collection Description whose `id` is absent, or names a
        collection other than the one its tar path places it in, is either
        rejected or normalized to the path-derived id
  - [x] Whichever is chosen, it matches what the three write handlers already do
        (they set `id` from the URL segment unconditionally)
  - [x] A test imports a hand-crafted tar carrying both shapes

Every other write path to a Collection Description sets `id` from the URL
segment, so a client can neither omit it nor choose it: `CollectionRequest` does
it on create and update (`src/requests/CollectionRequest.ts:357`, `:373`), and
the POST-to-space handler does the same
(`src/requests/SpaceRequest.ts:442-443`). A body whose `id` disagrees with the
URL is refused as `invalid-request-body`.

Import is the exception. It parses the Collection Description out of the tarball
verbatim -- `JSON.parse(metaEntry.body.toString('utf8'))` at
`src/lib/importTar.ts:376-380` -- and synthesizes
`{ id: collectionId, type, name }` only when the tar carries no description
entry at all. So a hand-crafted tar can plant a Collection Description whose
`id` is missing, or whose `id` names a different collection than the tar path it
is stored under. Neither shape is reachable through any other route, and nothing
downstream re-derives the id.

Space Descriptions are not affected: import merges into a pre-existing Space and
never rewrites its description.

Discovered 2026-08-28 while confirming, for a was-client change, that `id` is
guaranteed present in a served Description. It is -- through the handlers.
Import is the one path that does not enforce it, which makes the guarantee
weaker than the handlers suggest. The consumer side now depends on it:
was-client 0.45.0's `ensureSpaceAndCollection` refuses a caller-supplied Space
description whose `id` does not name the Space being provisioned.

### WSS-126: [H] Import Space validates what it installs

- status: done
- done: 2026-10-05
- priority: high
- labels: import, security, consistency
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/lib/importTar.ts`, `src/backends/filesystem.ts` (`importSpace`,
    `#persistCollection`), `src/backends/postgres.ts`,
    `src/lib/metadataWrite.ts`, `src/requests/SpaceRequest.ts` (`import`)
    (shipped 2026-10-05: `lib/importRevocations.ts`, `lib/importTar.ts`,
    `lib/policyRecord.ts`, both backends' envelope pre-flight, the handler;
    ARCHITECTURE.md updated)
  - WSS-68 covers the archived Collection `id`; this item covers the rest
- acceptance:
  - [x] Validators (`_generation` / `_version`) from the archive are never
        stored; the import path mints a fresh generation (and starts the version
        at 1, or keeps the archived version if a reason to is found)
  - [x] Revocation records are installed only after `verifyRevocationChain`
        passes for each, or the archive's revocations are ignored with a
        documented reason; today a Space-subtree POST grant installs arbitrary
        `(delegator, capabilityId)` records and there is no un-revoke
  - [x] The effective `encryption` for the encrypted-write check is derived the
        way `getCollectionOrThrow` derives it (log head first), so a
        log-governed Collection's Resources are checked on import
  - [x] An archive carrying both an `encryption` member and a governing log for
        one Collection, or `plaintext` plus a log, is refused
  - [x] `plaintext.indexes`, each policy document, and the history log bytes
        pass the same validation the live write paths apply
        (`assertSupportedPlaintext`, `PolicyRequest.put`'s shape check, JSON
        parse) before anything is written
  - [x] Tests for each refusal on both backends

Each of these lets a tarball put a Collection into a state no live write can
reach and no live write can repair. A `_version` of 2^53 freezes the Collection
Metadata `ETag` (every `+1` returns the same number), so conditional reads are
304 forever and every `If-Match` compare-and-swap succeeds. A re-imported
hard-deleted Collection resurrects its old generation, so a client's cached
validator matches different bytes. A `null` index entry makes `normalizeIndexes`
throw on every Resource write and on the repair `PUT /meta`. A non-JSON log
makes every Metadata load 500. A falsy policy document falls through the `||`
chain in `policy.ts` to the broader level.

Note 2026-10-05, at done: the first criterion is met under the design that
superseded its wording. `_version` no longer exists; every record is re-stamped
by the importing store's clock. A well-formed archived `_generation` is kept by
design (a hard delete's successor record still cannot coincide with a held
validator, since the stamp half of the `ETag` is fresh), and a malformed one is
replaced by a minted one. Revocations take the verify branch: each archived
record's chain is verified under the destination Space and the record is rebuilt
server-side, and one that does not verify is skipped with a `warn` line rather
than refusing the import.

### WSS-127: [H] A Resource's access-control policy dies with the Resource

- status: done
- done: 2026-10-05
- priority: high
- labels: policy, security, consistency
- discovered-from: whole-codebase review (2026-09-17), verified on both backends
- touches:
  - `src/backends/filesystem.ts` and `src/backends/postgres.ts`
    (`deleteResource`), `src/backends/postgresSchema.ts` (no FK from `policies`
    to `resources`), `src/requests/ResourceRequest.ts` (`delete`),
    `src/lib/policyCache.ts` -- shipped with this item
  - ARCHITECTURE.md's soft-delete sentence, which lists what a delete drops --
    shipped with this item
- acceptance:
  - [x] `deleteResource` removes the Resource-level policy on both backends and
        the handler invalidates its cache entry (decided 2026-10-05: it is
        tombstoned like a Delete Policy, with a stamp and feed position, so the
        delete replicates and an import does not undo it)
  - [x] A test publishes `r1` with `PublicCanRead`, deletes it, re-creates `r1`,
        and asserts an anonymous GET is refused
  - [x] `PolicyRequest.put` at the Resource level refuses when the Resource does
        not exist (no pre-seeding of a future id), or the pre-seeding behavior
        is documented as intended
  - [x] The Collection listing's `public` flag reflects the effective policy (a
        Space-level `PublicCanRead` shows every Collection as public), or its
        doc states it reports the Collection level only

Delete Resource drops content, chunks, and the `/meta` object but never the
policy, so a `PublicCanRead` written to publish one record silently publishes
whatever next occupies that id (client-chosen ids such as `keyring` or `index`
collide routinely). No listing shows a Resource-level policy. Delete Collection
and Delete Space do clean policies up; the Resource level is the lone gap. The
container-rule half of policy control is WSS-61 / WSS-108.

### WSS-214: [M] Count live Resources from the directory listing, with tombstones under their own name

- status: done
- done: 2026-10-06
- priority: medium
- labels: performance, filesystem-backend, quotas, storage-layout
- discovered-from: review of the sidecar-read change (2026-10-06)
- touches:
  - `src/backends/filesystem.ts` (`deleteResource`, `#writeResourceLocked`,
    `#removeRepresentationFilesOf`, `#countLiveListed`, `#countLiveResources`,
    `listCollectionItems`, `#judgeRepresentations`, `#locateRepresentation`, the
    changes feed, export, the equality and unique-claim scans, the apply path),
    `src/lib/metaSidecar.ts`, `src/backends/filesystemStore.ts`,
    `docs/filesystem-layout.md` -- shipped: every by-id read goes through
    `readMetaSidecar`, which reads both names; `#writeFeedSidecar` removes the
    other name; export maps `.tombstone.<id>.json` back to `.meta.<id>.json`;
    layout version 5; orphans are reclaimed by the next create over a tombstone
  - unaffected: `@interop/space-archive` (a Resource tombstone does travel in an
    archive, as `.meta.<id>.json` with `deleted: true`, exactly as before:
    export renames the on-disk tombstone back and import writes it under the new
    name; the packer's `deleted: true` refusal covers Collection Metadata files
    only)
  - unaffected: the Postgres backend (liveness is the `deleted` column)
- acceptance:
  - [x] A Resource tombstone is stored as `.tombstone.<id>.json`, with the body
        it has today (the delete's stamp, the generation, `feedPosition`,
        `deleted: true`). A live sidecar stays `.meta.<id>.json`. The name has
        the same fixed-prefix, fixed-suffix shape as the live sidecar's and
        parses the same way, so a Resource id holding a dot (ids are not encoded
        in a sidecar name) stays unambiguous. Chunk sidecars are unchanged,
        since Delete Chunk leaves no tombstone
  - [x] Delete Resource writes the tombstone, then removes the live sidecar,
        then removes the one file the live sidecar named, and the chunk
        directory. It lists nothing
  - [x] A create over a tombstone writes the live sidecar, then removes the
        tombstone. A content write of a live Resource is unchanged
  - [x] When both names exist for one id (a crash between the two steps of a
        delete or a re-create), the one with the higher `feedPosition` is the
        Resource's state, on every path that reads a sidecar by id. The next
        write or delete of that id removes the other
  - [x] The listing's `totalItems` and the Resource count quota count the ids
        whose live sidecar name and representation file are both present in the
        directory listing, and open no sidecar outside the page. An id with both
        names present is resolved by reading those two sidecars, and only those
  - [x] `#reserveHeadroom` shares one in-flight measurement per Space: a caller
        that finds the cache entry expired while a measurement is running awaits
        it rather than starting another. Covers both the byte and the count
        quota
  - [x] The changes feed, export, replication apply, the equality and
        unique-claim scans, and the page judgement read a tombstone from its new
        name; `?include=deleted` and the feed's `deleted` documents are
        unchanged on the wire
  - [x] A representation file whose id has a tombstone or no sidecar is detected
        from names alone. Delete Resource no longer reclaims it; the item
        decides where orphans are reclaimed (the next write of the id, which
        already holds the id's lock, is the default) and
        `docs/filesystem-layout.md` says which
  - [x] The layout version advances. Its step refuses a data dir holding any
        sidecar with `deleted: true` under the live name, with the same
        wipe-or-restore message the feed-position step uses. No conversion
        migration
  - [x] Tests in `test/`: a Collection larger than one page lists with
        `totalItems` exact and no sidecar read outside the page (observable
        through a counter on the sidecar read); the count quota on a create
        reads no sidecar; two creates racing an expired cache entry run one
        measurement; a planted both-names id resolves to the higher
        `feedPosition` and the stale file is removed by the next write; a
        planted orphan beside a tombstone is not listed or counted; the existing
        ghost-file suite still passes; a data dir with an old-name tombstone is
        refused at boot

Context: the sidecar-read change made every path that lists a directory decide
liveness from the sidecar, so a tombstone sitting beside a file a crash left
behind is not counted. That made three paths read one sidecar per Resource
again: the listing's `totalItems` reads the sidecar of every id outside the page
(a 2,000-item listing measured 18x slower under that pattern before the
page-only read landed), the count quota's `#countLiveResources` reads every
sidecar in the Space on each re-measurement (default-on at 10,000, 5 s cache,
dropped on every delete, with no in-flight dedup so concurrent misses each
enumerate), and Delete Resource lists the whole Collection folder to find the
id's stray files. Reads of one Resource are unaffected.

The root is that liveness lives inside the sidecar's JSON, while a directory
listing yields names only, and a live sidecar and a tombstone share a name.
Giving the tombstone its own name puts liveness in the listing: the live count
is the number of ids with a live sidecar name and a matching file, with no
sidecar opened. One `readdir` yields both kinds, told apart by prefix. An infix
form (`.meta.<id>.deleted.json`) was set aside: a Resource id may contain a dot
and the sidecar name does not encode it, so the tombstone of `foo` would collide
with the live sidecar of `foo.deleted`. Encoding the id in the sidecar name
would settle that, but the name is an archive entry name owned by the archive
codec, so that is a separate change. Per operation the cost is one extra
directory entry change on a delete and on a re-create, one extra failed open on
a create that looks for a tombstone, and nothing on a `GET`. The crash window
between the two steps is resolved by `feedPosition`, which both bodies carry and
which later writes always exceed.

A live count kept in the feed counter file was considered and set aside: it is
O(1) per count but a second source of truth, can drift by one across a crash,
and needs a sweep under the feed lock to repair. Should the readdir itself show
up in a profile on a large Collection, it remains the next step, as a cache over
this layout rather than the truth. Readdir cost still grows with tombstones,
which are never reaped (WSS-13). The same change settles the delete ordering
case of WSS-135 for Delete Resource (tombstone before file removal).

### WSS-192: [M] The Resource `/meta` `ETag` does not move when a content write changes the served object

- status: done
- done: 2026-10-06
- priority: medium
- labels: etag, caching, resource-api, wire-contract
- discovered-from: WSS-172 review (2026-10-03)
- touches:
  - portable-web-spaces-spec: WASS-56 (filed under WSS-133)
  - was-teaching-server: shipped under WSS-133 (`resourceMetaEtag` in
    `src/lib/etag.ts`, docs/validators-and-stamps.md)
  - conformance-suite: PWSCS-25 (filed under WSS-133)
- acceptance:
  - [x] Decide which it is: the `/meta` `ETag` covers both records (the content
        stamp and the `/meta` stamp), or the served `/meta` object stops
        carrying content-record members
  - [x] A `GET .../meta` with `If-None-Match` after a content write that changed
        `size`, `contentType`, or the content stamp is answered 200
  - [x] Tests in both backends

Context (discovered-from: WSS-172 review). The served `/meta` object carries the
content record's `size`, `contentType`, `writerId`, `epoch`, and stamp
(`updatedAt`, `updatedAtCounter`, `originId`), while its `ETag` is built from
the nested `meta` stamp alone. A client holding that `ETag` is answered 304
after a content write and keeps the old members. The gap predates the stamp; the
two new top-level stamp members widen it. The choice is a wire decision.

Superseded by WSS-133 (the Resource `/meta` validator covers every member it
serves), done 2026-10-05, which chose the first option: the `/meta` `ETag` is
the content-first composite of both records' validators. Nothing further to do.

### WSS-134: [M] (*) Compose Update Collection under the lock

- status: done
- done: 2026-10-12
- priority: medium
- backend: *
- labels: consistency, plaintext-indexes, backend
- discovered-from: whole-codebase review (2026-09-17), verified (19 of 20
  trials)
- acceptance:
  - [x] The carry-forward of `plaintext`, `backend` and the other preserved
        members is computed from the record read under the `cmeta:` lock, not
        from the pre-verification read (move composition into the
        `assertTransition` callback, or have it return the object to persist)
  - [x] The unique-index declaration scan and the Resource write that reads the
        declaration serialize on one lock, so a Resource write in flight during
        a `unique: true` declaration cannot land a duplicate
  - [x] A test drives an unconditional rename concurrently with a `plaintext`
        add and asserts the declaration survives

The under-lock re-check re-runs assertions against the fresh record but the
object being written was composed against the stale one, and assertions catch
violations, not lost carry-forwards. A `unique: true` declaration disappears
with a 204 to both writers, or a `backend` selection silently reverts to the
default. The comment at the re-check claims the opposite.

Shipped 2026-10-12: `writeCollection` takes a composition callback in place of
`assertTransition` and persists what it returns; Update Collection composes and
runs the newly-unique scan inside it. Both backends read a Collection's `unique`
declarations under their own lock on a Resource write (the `uniqueIndexes`
option is gone). A Collection Metadata write excludes the Space's Resource
writes: the filesystem backend runs it on the exclusive side of the Space gate,
as a removal, and the Postgres Space row lock already serialized the two. A
shared-side-first attempt with a retry on the exclusive side was considered and
dropped: the filesystem backend is built to be read, so one rule, the same as a
removal's, beats a saved drain on a rename. A stale `If-Match` now answers 412
ahead of a body-derived 400/409, recorded in the CHANGELOG.

### WSS-145: [M] (*) Media-type edge cases in `resolveResourceInput`

- status: done
- done: 2026-10-12
- priority: medium
- backend: *
- labels: correctness, content-types
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [x] The `+json` parser regex is anchored so `application/ld+jsonl` and
        `application/ld+json-seq` take the binary path `isJsonContentType()`
        promises, instead of handing a parsed object to `pipeline` (500)
  - [x] The multipart branch matches case-insensitively and only
        `multipart/form-data`; `multipart/mixed` and other multipart types are
        stored as blobs or refused with a typed 415
  - [x] A chunk `PUT` declaring a JSON media type is stored byte-verbatim
        (chunks are ranges of a stream, not documents)
  - [x] The multipart 413 names the limit that was enforced (the server
        backend's), and `maxUploadBytes!` is not asserted on an optional field
  - [x] A multipart create's 201 echoes the stored `content-type`, not the
        request envelope's
  - [x] `test/` covers each case

### WSS-216: [M] (*) Second server-managed backend: filesystem and Postgres side by side, selectable per Collection

- status: done
- done: 2026-10-22
- priority: medium
- backend: *
- labels: backend, postgres, filesystem-backend
- discovered-from: question about per-Collection backends (2026-10-22)
- touches:
  - `src/start.ts`, `src/config.default.ts`, `src/plugin.ts`,
    `src/lib/backends.ts`, `src/lib/backendRegistry.ts`,
    `src/requests/collectionInput.ts`, `src/types.ts`, README.md "Storage
    Backends", docs/admin-guide.md (all shipped 2026-10-22, plus
    `src/lib/serverBackends.ts`, `src/lib/backendMirror.ts`,
    `src/lib/exportArchive.ts`, `src/lib/importAcrossBackends.ts`)
  - `@interop/space-archive`: the fixture archives' `backends` listing
    regenerated under the fixed id `fs` (0.8.2 TBD, publish pending)
- acceptance:
  - [x] A deployment configures both a filesystem data dir and a Postgres
        connection, names one of them the server's `default` backend with
        `WAS_DEFAULT_BACKEND=fs|postgres`, and the other is operable in the same
        process; a value naming an unconfigured backend refuses to start
  - [x] `GET /space/:spaceId/backends` lists both as server-managed entries
        (`fs` and `postgres`) in every Space, with `default` aliasing the
        configured one; a Collection created with `backend.id` naming the
        non-default one has its Resources, listings and `changes` feed served by
        that backend, while the Space and Collection Metadata objects, policies
        and backend records stay in the default backend
  - [x] A Collection on the non-default backend counts toward the Space's quota
        and appears in `GET /quotas` and the Collection quota read
  - [x] Export Space archives a Space whose Collections span both backends, and
        Import Space restores each Collection onto the backend its archived
        Metadata object names (or refuses with `unsupported-backend` when that
        backend is not configured)
  - [x] A server configured with only one backend behaves exactly as today: one
        `default` entry, no second id selectable
  - [x] Test: one suite boots a server over a temp data dir plus
        `WAS_TEST_DATABASE_URL`, creates one Collection on each backend, and
        asserts where the bytes landed

Goal: deploy with both a filesystem and a Postgres backend, set one of them as
the default, and switch per Collection.

Today the two are a whole-server choice: `DATABASE_URL` in `start.ts` swaps the
default backend from filesystem to Postgres for everything. The per-Collection
resolver (`src/lib/backendRegistry.ts`) already splits the data plane from the
control plane, but it only reaches a second backend through a
`managedBy: external` registration on one Space, built by a provider adapter
from the injected `providers` map, which the production start script leaves
empty. The server's own backends are not registrations: `src/lib/backends.ts`
builds one `default` descriptor from the active `StorageBackend` and says the
indirection "leaves room for multiple registered backends later". This item is
that room.

Shape, decided 2026-10-22 by the maintainer: a second server-managed entry in
the backends-available list, present in every Space without a registration. The
two server backends carry the fixed ids `fs` and `postgres`; `default` is an
alias of whichever one the deployment picked. The resolver short-circuits to
either as it does for `default` today, with no control-plane record read, no
adapter cache and no `providers` factory. `managedBy: external` and the
`providers` registry stay for storage the server does not own. The alternative
considered and rejected: a Postgres provider adapter in the `providers`
registry, registered on each Space through `POST /backends`, which would make a
connection the server already holds a per-Space secret-bearing record.

Config, decided 2026-10-22 by the maintainer: `WAS_DEFAULT_BACKEND=fs|postgres`
names the default. A backend is configured when its own setting is present
(`WAS_DATA_DIR`, defaulting to `data/`, for `fs`; `DATABASE_URL` for
`postgres`), so a deployment with `DATABASE_URL` set has both. Unset,
`WAS_DEFAULT_BACKEND` keeps today's rule (`postgres` when `DATABASE_URL` is set,
else `fs`); a value naming an unconfigured backend refuses to start. Both
backends take the same storage options (`maxUploadBytes`,
`maxSpacesPerController`, `maxCollectionsPerSpace`, `originId`); the origin id
must be one value for the process, since both backends mint stamps for one store
as seen by a replication peer. The item on several processes over one store
(WSS-185) is the neighbouring question.

Boundaries that follow from the current split and need a decision per path:

- Quota: `capacityBytes` and usage accounting live on each backend, so a Space's
  usage is the sum across both, or the control-plane backend owns the Space
  total and the data-plane backend reports per-Collection usage.
- Delete Collection and Delete Space must delete the Collection's Resources
  through the data-plane backend (WSS-136 lists this for external backends; it
  applies here as well).
- Replication: the pull loop stalls any Collection whose `backend` is not
  `default` (WSS-201); a server-managed second backend already implements the
  `apply*` methods, so the loop only needs to resolve the data backend.
- Export/Import: each backend's `exportSpace` / `importSpace` builds the archive
  from its own store, so a mixed Space needs the export to walk Collections
  through the resolver rather than ask one backend for the whole Space.
- The Postgres storage-contract tests are still skipped (WSS-46); the mixed
  suite depends on a Postgres being reachable from `test/`.

Shipped 2026-10-22, by the maintainer's direction: the server backends are
always a set (`ServerBackends`, `src/lib/serverBackends.ts`), each configured by
its own setting, with `default` an alias stored verbatim in `backend.id` and
resolved on every read; no configured backend refuses to start, and so does a
set whose origin ids differ. `WAS_DATA_DIR` no longer defaults to `data/` at
startup. The non-default backend keeps a copy of the Space and Collection
Metadata objects of the Collections it serves (`src/lib/backendMirror.ts`),
since both backends check the container and read the `unique` declarations in
their own store. The quota report lists one entry per server backend. Export
composes the entry trees of the backends a Space spans (`exportSpaceEntries` on
the contract, `src/lib/exportArchive.ts`) and Import splits the plan
(`src/lib/importAcrossBackends.ts`). Replication into a non-default server
backend stays stalled (WSS-218); the feed of such a Collection carries no policy
or log documents (WSS-217); a change of `backend.id` on an existing Collection
is WSS-219.

### WSS-217: [M] (*) Policies and the governing log of a Collection on a non-default server backend in its `changes` feed

- status: done
- done: 2026-10-22
- priority: medium
- backend: *
- labels: backend, changes-feed
- discovered-from: WSS-216 (2026-10-22)
- acceptance:
  - [x] The `changes` feed of a Collection whose `backend.id` names a server
        backend other than the default carries its Collection- and
        Resource-level policy documents and its governing-log documents, with
        the validator the control plane serves for each
  - [x] The `collection-metadata` document of such a feed carries the control
        plane's validator rather than the copy's
  - [x] A test over `WAS_TEST_DATABASE_URL` pins each document kind

The feed is served by the Collection's data backend, which holds a copy of the
Collection Metadata object (under its own stamp) and no policies or log, since
those stay on the default backend. Either the control-plane writes of those
records take a position in the data backend's feed, or the feed is composed from
both stores. Whichever is picked has to keep one per-Collection position
sequence.

### WSS-218: [M] (*) Replicate into a Collection on a non-default server backend

- status: done
- done: 2026-10-23
- priority: medium
- backend: *
- labels: backend, replication
- discovered-from: WSS-216 (2026-10-22)
- acceptance:
  - [x] The pull loop applies a peer Collection whose `backend.id` names a
        server backend of this deployment into that backend, through its
        `apply*` methods, under the peer's stamps
  - [x] The replica registration the apply path checks is found whichever
        backend the write lands on
  - [x] The loop routes the Collection's Resource, chunk and `/meta` applies to
        the selected backend, as the request layer's data-plane resolver does,
        and the Metadata object, log, policy and tombstone applies stay on the
        control plane
  - [x] A test over `WAS_TEST_DATABASE_URL` replicates one such Collection

The apply path refuses a write under a replica registration it cannot read from
its own store (`guardApply`, reason `unregistered`), and registrations live on
the default backend alone, so the loop stalls such a Collection with reason
`unsupported-backend`.

The control plane the loop writes through is the mirroring wrapper
(`mirroringControlPlane`), so an applied Metadata object, log or tombstone of a
Collection already held on another server backend reaches that backend's copy,
and a replicated update keeps the held `backend` selection. What remains is the
first apply of such a Collection from a peer and the Resource applies.

Open before coding: a peer's `backend.id` names the peer's backend, not this
server's. Whether `postgres` on the peer maps onto this deployment's `postgres`,
or the registration states where pulled Collections land regardless of the
peer's choice, is a wire-level decision to settle first.

Shipped 2026-10-23, by the maintainer's direction: a `backend.id` keeps its
meaning across servers (`default` through the local alias, a fixed id selects
this deployment's backend of that id), the stored object carries the peer's id
verbatim, and no new registration member. A Resource apply into another server
backend runs under no `replicaId`, the policy-copy convention, after the loop
checks the registration on the control plane; the loop brings that backend's
copy of the Collection level before the first Resource of a cycle. Chunks are
not replicated, so there is no chunk apply to route. The two-server test is
`test/mixed-backends-replication.test.ts`.

---

### WSS-14: [M] (*) Chunk replication for sync

- status: done
- done: 2026-10-26
- priority: medium
- backend: *
- labels: replication, sync
- design: designs/WSS-14-chunk-replication.md
- design-approved: 2026-10-25
- touches:
  - portable-web-spaces-spec: the Encrypted Collections profile (`ec/spec.md`,
    now hosted in this repo) "Chunk lifecycle" says a replicating server carries
    the chunk set with the parent write it surfaces, and a chunk-only mutation
    stays where it was made, behavior text only; the replication specification
    gains the chunk apply rule; its decision 0013, whose chunk sentences were a
    deferral to this item, is amended in place with the chunk apply rule, and
    WASS-50's acceptance line naming chunks among what does not replicate is
    revised. Part of replication `0.1`, no version bump. Filed 2026-10-25: 0013
    amended, WASS-50's acceptance box revised, the profile sentence written
    (checkout `portable-web-spaces-spec`)
  - storage-core: `ReplicaStallReason` gains `chunk-listing-obsolete` and
    `source-unavailable`
  - was-teaching-server: `src/sync/replication.ts`, `src/lib/replicaApply.ts`,
    `src/sync/peerClient.ts`, both backends (`stageChunk`,
    `applyResourceWithChunks`, `reclaimStaging`, the staging layouts, the stored
    registration's `pullsChunks`), `docs/replication.md`,
    `docs/changes-feed.md`, `docs/filesystem-layout.md`, ARCHITECTURE.md's
    replication facet entry; `decisions/0006` minted at approval
  - was-client: unaffected (no wire change)
  - conformance-suite: unaffected (no wire change)
- acceptance:
  - [x] The design doc is adversarially reviewed (2026-10-24, six lenses plus a
        critic; findings folded in, review log in its section 9)
  - [x] The design doc is approved (2026-10-25), every open point in its section
        8 decided, and the wire and layout names signed off (the staging layout,
        `pullsChunks`, the two stall reasons)
  - [x] Each invariant in design section 2 is upheld by a test named in section
        7, or its exemption is recorded in the doc
        (`test/chunk-replication-api.test.ts`,
        `test/filesystem-chunk-staging.test.ts`,
        `test/postgres-replica-apply.test.ts`; invariant 7 is exempt per the
        doc)
  - [x] Each changed consumer in design section 3 is handled, and each "changed"
        or "refused" cell of section 4 has a test or a doc sentence
  - [x] A two-server test replicates a chunked Resource byte for byte under the
        replica server's own chunk `ETag`s, converges a removal on the next
        parent write, and converges a concurrent whole-stream rewrite on the
        winning parent's set
  - [x] `docs/replication.md` no longer lists chunks among what does not
        replicate, and states the chunk-only-mutation caveat
  - [x] The spec and profile items in `touches` are filed

Pulled out of Someday / Maybe on 2026-10-23, with the design doc drafted the
same day. The design keeps chunk writes invisible to the `changes` feed, as the
core profile and the Encrypted Collections profile require, and discovers a
Resource's chunk set by reading its chunk listing when the parent's own feed
document applies, then each chunk the listing's `etag` shows an earlier run did
not stage, so a resumed chunk pull moves no held bytes. A chunk delete leaves no
tombstone and converges on the next parent write. The chunk set applies after
the parent revision that won last-writer-wins, pinned to that revision at apply
time, so two origins rewriting one stream converge on one origin's set.

Context from the WSS-96 design (2026-10-01), which this item inherited: a chunk
is a versioned record, so it takes the same origin stamp and four-field
validator (WSS-172), and a puller fetching chunk bytes with a plain `GET` learns
the stamp from the `ETag` alone. Chunks inherit the Collection's `revisions`
descriptor. The design revised two of those sentences on 2026-10-24: chunks
resolve with their parent revision, not per chunk under LWW (design section
5.3), and a replicated chunk carries the replica's own stamp and generation, the
peer's chunk `ETag` being opaque to it, so no stamp is learned from an `ETag`
and the validator layout is not a requirement on peers (design open point 3).
The three questions that design left open (discovery, chunk tombstones,
whole-stream consistency) are answered in the design doc's section 1.

### WSS-222: [L] (*) Chunk replication cleanups: fixed manifest members, one apply verb, cheaper staging

- status: done
- done: 2026-10-26
- priority: low
- backend: *
- labels: replication, chunks, backend, performance
- discovered-from: simplify review of the chunk replication work (2026-10-26)
- acceptance:
  - [x] The staging manifest's `kept` list and `swapped` flag are dropped, with
        docs/filesystem-layout.md and the chunk replication design doc amended
        (the loop stages every listed chunk, since a live chunk's validator is
        this server's own, and the manifest is written only once the swap is
        decided, so its presence is the flag), or the layout doc names the case
        that sets either to another value
  - [x] `applyResourceWithChunks` becomes a `chunks` option of `applyResource`,
        or `StorageBackend`'s doc says why the two verbs stay apart, and
        `reclaimStaging`'s `exceptRun` form goes once staging itself drops the
        registration's other runs for the Resource
  - [x] The quota pre-check of a chunk set runs behind the backend, so
        `usageCheckIsGross` leaves `StorageBackend`, and `pullsChunks` is read
        from the source server's service description per cycle rather than
        stored on the registration, or docs/replication.md states why the stored
        form stays
  - [x] `stageChunk` settles the Resource's staging and drops the registration's
        other runs on the first chunk of a run only, and credits the one index
        it stages; the data-backend registration re-check runs once per chunk
        set; a Collection that cannot hold chunks skips the chunk listing read
  - [x] The transfer phase of a chunk set reads a few chunks from the source
        server at once (a small fixed concurrency, the staging lock and quota
        headroom kept as they are), or the loop's doc says why it stays serial
  - [x] The replica state is persisted after a chunk pull only past a byte or
        document threshold and at the end of the Collection, rather than after
        every Resource whose chunks were pulled
  - [x] A test in `test/` covers each change kept

The chunk pull shipped with four backend methods, a stored capability flag, a
backend trait the loop pads its quota arithmetic by, and a manifest whose `kept`
is always empty and whose `swapped` is always `true`. Each is a special case
layered on the general apply path. Per chunk, staging re-scans the whole
Resource (settle, drop other runs, list the live set) and re-reads the
registration on the control plane, so staging an n-chunk set does O(n^2) work in
directory entries and 2n control-plane reads; every live Resource of a
chunk-pulling registration pays a chunk listing round trip, chunked or not; the
chunks of one set are transferred one at a time; and the replica state is
rewritten after every Resource whose chunks were pulled.

### WSS-223: [M] (*) Chunk listing entries carry each chunk's `etag`

- status: done
- done: 2026-10-26
- priority: medium
- backend: *
- labels: chunks, wire-contract
- discovered-from: was-client code review of chunk reaping (2026-10-26)
- touches:
  - was-teaching-server: `src/types.ts` (`ChunkListing`), `src/backends/*`
    (`listChunks`), `src/requests/ChunkRequest.ts` (list handler doc),
    ARCHITECTURE.md (chunk listing), docs/openapi if the listing is described
    there -- shipped 2026-10-26; the listing's shape is described in the handler
    doc and docs/validators-and-stamps.md (ARCHITECTURE.md does not describe it,
    and there is no openapi document)
  - was-client: shipped -- `WasTransport.listChunks` returns `etag` when present
    and the chunk reap pins each `deleteChunk` on it (`If-Match`)
  - was-conformance-suite: a listing case asserting each entry's `etag` equals
    the `ETag` the chunk's own `GET` serves -- shipped as PWSCS-27 in suite
    0.34.0 (2026-10-26), consumed here through a `link:` devDependency until it
    is published
- acceptance:
  - [x] Each `ChunkListing.chunks` entry carries `etag`: the quoted strong
        validator the chunk's own `GET` and `HEAD` answer with, so a client can
        pin a `DELETE` of a listed chunk with `If-Match` without a probe per
        chunk
  - [x] The filesystem backend formats it from the sidecar the listing already
        reads to judge liveness (no extra read or stat per chunk); the Postgres
        backend adds the validator columns to the listing's one `SELECT`
  - [x] A backend test per backend asserts the listed `etag` equals the one
        `getChunk` reports for the same chunk, and the chunk request tests cover
        the member on the wire

A client that replaces a chunked encrypted document deletes the chunks the new
document does not cover, and wants each delete pinned to the chunk it listed so
a concurrent writer's freshly stored chunk at the same index is left alone (the
server answers 412). The listing today reports only `index`, `size` and
`contentType`, so the client has nothing to pin on and its deletes are
unconditional. The cost is nil on both backends: the filesystem listing already
parses every chunk's sidecar (`LiveRepresentation.sidecar`) and the validator is
`formatEtag(validatorPartsOf(sidecar))`; the Postgres listing already fetches
the rows. The spec does not define the listing's shape, so this is a server
convention until it does.

### WSS-227: [M] (*) [blocks 1] Pause a replica registration, and replace its pull capability in place

- status: done
- done: 2026-10-27
- priority: medium
- backend: *
- labels: replication, registration, wire-contract
- discovered-from: freewallet FW-688 (2026-10-26)
- blocks: WSS-226
- touches:
  - was-teaching-server: `src/routes.ts` (a PUT route on the registration),
    `src/requests/ReplicaRequest.ts` (the PUT handler; `replicaEtag`, whose
    comment says the record never changes; the Delete Replica refusal text),
    `src/sync/replication.ts` (a per-registration pause; `status`),
    `src/sync/registration.ts` (re-validation of a replacement),
    `src/lib/webvhLogLocation.ts`, `src/types.ts` (a replace method on the
    backend contract), both backends, `src/config.default.ts` (the
    `REPLICATION_VERSION` comment), docs/replication.md ("Registrations", "The
    pull loop", "Stalls and backoff", "Guards on Delete Replica and Update
    Space"), ARCHITECTURE.md
  - storage-core: `ReplicaRegistration` gains `pausedAt` and the three write
    stamp members (`updatedAt`, `updatedAtCounter`, `originId`);
    `ReplicaStatus.state` gains `paused` -- shipped as part of SC-11 in
    storage-core 0.40.0 (2026-10-27), consumed here through a `link:` dependency
    until it is published
  - portable-web-spaces-spec: decision 0013 amended (against its "no PUT in v1"
    and "only the removal of its registration stops a loop") and WASS-50's text
    -- WASS-50's touches already name the pause and the in-place replacement
    (added 2026-10-26); the decision amendment rides that item
  - was-client: pause, resume, and capability replacement on `Space` -- WCL-137,
    filed
  - was-conformance-suite: PWSCS-23 gains the PUT cases -- unresolved (the suite
    repo has no roadmap file; the cases are to be added when PWSCS-23 is taken
    up)
- acceptance:
  - [x] The registration record gains `pausedAt`, an ISO 8601 UTC time; absent
        means not paused. A PUT on the registration URL writes and clears it.
        The body is the full record as a POST carries it; `id` must equal the
        URL's and only `capability` and `pausedAt` may differ from the stored
        record, any other difference being a 400 on that member's pointer. A
        body without `pausedAt` clears the pause. A PUT on an absent
        registration creates it through the POST path and answers 201
  - [x] `pausedAt` is server-set: a value in the body is ignored, the server
        stores its own clock when the registration goes from unpaused to paused
        (a create with the member present included), and keeps the stored time
        on a later PUT while paused
  - [x] The PUT takes optional `If-Match` and `If-None-Match: *`, parsed by
        `parseWritePreconditions` and evaluated by the backend atomically with
        the write; a miss is `precondition-failed` (412), `If-None-Match: *` on
        an existing registration included. POST keeps `id-conflict`
  - [x] A paused registration's loop does not run, at boot included, and
        `status.state` reports `paused` while no cycle is in flight. Clearing
        the member schedules a cycle at once
  - [x] A paused registration keeps mapping its did:webvh controller in
        `webvhLogLocation.ts`, so the DID still resolves and the Delete Replica
        guard still holds
  - [x] A PUT may also replace the pull capability, with the same `fromSpace`.
        The new capability is validated as a POST's is (grantee this server's
        DID, chain and actions, and a read of the source Space through it, which
        also re-reads `pullsChunks`). The registration keeps its id, its loop,
        and its `.replica.<id>.state.json` checkpoint, and the running loop uses
        the new capability from its next cycle
  - [x] The registration becomes a versioned record: a write stamp minted by the
        store's clock under the registration's lock on create and on every PUT,
        served in the body as `updatedAt`, `updatedAtCounter` and `originId`
        (ignored in a write body), with the generation kept for the record's
        life. The `ETag` is the standard four-segment `formatEtag` shape;
        `replicaEtag` and its comment go. The served `replicas` member on the
        Space Metadata object is unchanged by a PUT
  - [x] Both backends store the replaced record atomically, beside today's
        create-only `createReplica`
  - [x] The Delete Replica refusal no longer advises add-then-remove
  - [x] `REPLICATION_VERSION` stays `0.1`; its comment in
        `src/config.default.ts` (`:452-456`) names the pause and the in-place
        replacement
  - [x] Two-server tests: a paused registration pulls nothing, reports `paused`,
        and its DID resolves; a resume pulls; a replacement keeps the id and the
        checkpoint, so the next cycle does not re-read the source from the start

Context. A wallet's Stop keeps the copy as a snapshot. Deregistering would leave
a promoted Space's controller unresolvable, and the guard refuses it
(`ReplicaRequest.ts:232-251`, through `controllerUnmappedByRemoval`,
`webvhLogLocation.ts:570`). Leaving the loop running would back off on 404
against a source that refuses it, forever. Today the only pause is manager-wide
(`#paused`, `pause()` and `resume()` in `src/sync/replication.ts`, `:265`,
`:386-400`, checked in `#schedule` at `:520`), used by tests. A renewal or a
re-start of a stopped replica also needs a new pull capability. Without an
in-place replacement that is a new registration id with an empty checkpoint,
since loop state is per id, and the copy is read again from the start.

Wire details, settled 2026-10-27. The member name `pausedAt`, its format, the
PUT verb and the `paused` state were decided at filing. Decided since: the PUT
body is the full record with only `capability` and `pausedAt` free to differ,
and a PUT creates an absent registration; `pausedAt` is set by this server's
clock on the unpaused-to-paused transition, the client's value ignored; the PUT
takes optional `If-Match` and `If-None-Match: *` like every other write; and the
record gains a write stamp, so its `ETag` is the standard four-segment shape and
the stamp members are served in the body. The CORS defaults already list PUT
(`src/plugin.ts:554-562`).

---

### WSS-180: [M] (fs) Delete Space removes revocations before the Space directory

- status: done
- done: 2026-10-27
- priority: medium
- backend: fs
- labels: filesystem-backend, zcap, correctness
- acceptance:
  - [x] The filesystem backend's `deleteSpace` removes the Space directory
        before, or atomically with, the Space's revocation records, so a crash
        between the two steps cannot leave a live Space whose revoked grants
        verify again
  - [x] A revocation directory left behind by a crash after the Space directory
        is gone is removed on the next `deleteSpace` or at boot
  - [x] A test kills the delete between the two removals and asserts the Space
        is either whole or gone

Context (discovered-from: WSS-96, review 2026-10-01). `deleteSpace` removes the
Space-scoped revocation directory, which sits outside the Space tree, and only
then the Space directory (`src/backends/filesystem.ts:1365-1372`). A crash in
between leaves the Space in place with every stored revocation gone, so a
revoked grant verifies on the next invocation. The torn-state pass over the
replication design found it while checking Delete Space against an in-flight
pull; it is an existing defect independent of replication.

### WSS-230: [L] (fs) Keep Space revocations inside the Space dir

- status: done (2026-10-27)
- priority: low
- backend: fs
- labels: filesystem-backend, zcap, cleanup
- discovered-from: WSS-180 simplify review (2026-10-27)
- touches:
  - `src/backends/filesystem.ts` (`spaceRevocationsDir`, `#spaceRevocationDir`,
    `listCollections` and the quota measurement that treat every subdirectory of
    a Space dir as a Collection, `deleteSpace`, `writeSpace`,
    `#removeOrphanRevocationDirs`)
  - `src/backends/filesystemStore.ts` (a layout step that moves the existing
    `space-revocations/<spaceId>/` trees into their Space dirs)
  - `docs/filesystem-layout.md` ("Delete Space" and the layout listing)
  - `src/lib/validateId.ts` and `@interop/storage-core` (`.revocations` joins
    `RESERVED_COLLECTION_IDS`, storage-core 0.41.0, so no Collection can take
    the subdirectory's name)
- acceptance:
  - [x] A Space's zcap revocations live in a dot-prefixed subdirectory of its
        Space dir, which the Collection listing and the quota measurement skip
        as they skip the Space's dotfiles, so the `rm` of the Space dir removes
        the Space and its revocations in one step
  - [x] The three recovery sites a torn Delete Space needed (the retried delete,
        the create over the id in `writeSpace`, and the boot sweep) are gone,
        with the "Delete Space" paragraph of the layout doc that describes them
  - [x] The layout step moves an existing store's revocation trees in, and a
        store at the new version has no `space-revocations/` root
  - [x] The Delete Space tests assert the one-step removal, and the torn-delete
        cases are dropped with the window they covered

Context. Space revocations sit in a sibling root,
`space-revocations/<spaceId>/`, because `listCollections` takes every
subdirectory of a Space dir for a Collection. The sibling root is why Delete
Space is two removals, and why a kill between them needs recovery at three sites
(the retried delete, the create over the id, and the boot sweep). A dot-prefixed
subdirectory inside the Space dir, in the convention the `.space.<id>.json`,
`.meta.<id>.json` and `.tombstone.<id>.json` files already use, removes with the
Space dir and needs none of them. The Postgres backend has no such window, since
its revocations are rows keyed by Space id in the same store. The
`insertRevocation` gate checkbox of WSS-135 (a revocation racing Delete Space)
stays with that item. Decided at implementation (2026-10-27): the records count
toward the Space's byte quota, as the other Space-level files do; only the
Collection listing, the export walk and the boot sweeps skip the directory.

### WSS-231: [L] (*) Pack a Space's revocations inside the archive's Space tree

- status: done (2026-10-27)
- priority: low
- backend: *
- labels: export-import, zcap, cleanup
- discovered-from: WSS-230 (2026-10-27)
- touches:
  - `src/backends/filesystem.ts` and `src/backends/postgres.ts`
    (`exportSpaceEntries` returns the revocation records as a separate
    `revocations` list beside the entry tree)
  - `src/lib/exportArchive.ts` (packs that list under a top-level `revocations/`
    dir)
  - `src/lib/importTar.ts` (`REVOCATIONS_PREFIX`, the archive layout comment)
    and `src/lib/importPlan.ts` (`archivedRevocations`)
  - `@interop/space-archive` (the fixture archives its writer packs from the
    fixed entry tree, which `test/space-archive-fixture.test.ts` pins the
    server's export bytes to); shipped as 0.9.0: the `revocations` area moves
    under the Space dir and `packSpaceArchive` takes the directory in `entries`
  - unaffected: the wallet readers (`wallet-backup`, `freewallet`) walk the
    `collection` and `chunk` areas only, so no counterpart item
  - `docs/export-import.md` ("Archived revocations") and the archive layout
    listing
- acceptance:
  - [x] An export packs a Space's revocation records as
        `space/<spaceId>/.revocations/<digest>.json`, one entry per record,
        carried by the same Space-tree walk as every other Space-level entry;
        the separate `revocations` return of `exportSpaceEntries` and the
        top-level `revocations/` dir of the archive are gone from both backends
  - [x] The import walk reads the records from that directory, which it cannot
        take for a Collection since `.revocations` is a reserved Collection id,
        and still hands them to `importRevocations` after the data import
  - [x] The space-archive fixture is repacked from an entry tree that holds the
        directory, and the fixture test pins the server's bytes to it
  - [x] The archive layout comment in `importTar.ts` and the export-import doc
        list the directory in place of the top-level one

Context. WSS-230 moved the filesystem backend's revocation records into the
`.revocations/` subdirectory of the Space dir, and reserved that name as a
Collection id. The export still lifts them out of the tree and packs them under
a top-level `revocations/` dir, which predates the reservation: a subdirectory
of `space/<spaceId>/` read as a Collection on import, so the records could not
live there. With the name reserved, the Space tree can carry them, which drops
the second return value of `exportSpaceEntries` on both backends and the
special-cased walk in `exportArchive.ts`. The archive layout is a published
format read by the wallets' backup readers, so the entry path and the fixture
change need sign-off before they are coded, and the readers need a counterpart
item once the shape is settled.

---

### WSS-232: [L] (*) Classify every entry of the import plan through `parseArchivePath`

- status: done
- done: 2026-10-27
- priority: low
- backend: *
- labels: import-export, cleanup
- discovered-from: simplify review of the Space revocations move (2026-10-27)
- acceptance:
  - [x] `buildImportPlan` (`src/lib/importTar.ts`) finds the source Space id and
        sorts entries into Collections through `parseArchivePath`, with no regex
        over entry names left in the file
  - [x] An entry the package parses as `other` (a path deeper than the layout, a
        directory inside a chunk directory or inside the revocations directory)
        is refused as `invalid-import` at the plan stage, and a case in
        `test/importTar.test.ts` pins it
  - [x] A Collection's files stay keyed by their path relative to the Collection
        directory, chunk files under their `.chunks.<encId>/` segment, so
        `importedCollectionFiles` and the chunk plan are unchanged
  - [x] The `.revocations` exclusion in the Collection loop goes, since the
        classifier places those entries as `revocations`

Context: the import plan reads one archive with two parsers. Its tombstone and
revocation passes classify each entry through the archive package's
`parseArchivePath`, while the source-Space lookup and the Collection loop match
two hand regexes over the entry name. The package owns the layout and its
classifier is exhaustive, so each addition to the layout (the `.revocations`
directory was the last) needs a matching exclusion in the regex loop or it is
keyed into a Collection's files. The regex also admits what the classifier
refuses: a path deeper than the layout parses as `other` in the package but is
appended to a Collection's file list here, and is refused later, per file, if at
all. One classifier makes the plan refuse those where it refuses everything
else. Nothing is wrong today, which keeps the item low.

### WSS-233: [M] (fs) Rename the Metadata files to `.<level>.meta.<id>.json` (store layout 9)

- status: done
- done: 2026-10-27
- priority: medium
- backend: fs
- labels: data-model, filesystem-backend, export-import
- discovered-from: space-archive SAR-8 (2026-10-27)
- touches:
  - space-archive: the file-name dialect -- SAR-8 (0.10.0 TBD, codec shipped
    locally), consumed here through a temporary `link:` until published
  - was-teaching-server: the filesystem store's on-disk names (through the
    package's builders), layout step 9, `importTar.ts`, `exportProvenance.ts`,
    `spaceProjection.ts`, `collectionTombstone.ts` comments, the counterpart
    fixture test, ARCHITECTURE.md and the `docs/` layout pages -- shipped here
  - unaffected: postgres backend (its rows carry no file name; only its export
    goes through the package's builders, which it does not call by name)
- acceptance:
  - [x] The filesystem backend writes and reads `.space.meta.<spaceId>.json` and
        `.collection.meta.<collectionId>.json`, and the export archive carries
        the same names
  - [x] Layout step 9 refuses a store holding a Metadata file under an old name,
        every boot, and stamps a store with none
  - [x] `test/space-archive-fixture.test.ts` passes against the package's
        regenerated fixtures
  - [x] ARCHITECTURE.md, `docs/filesystem-layout.md`, `docs/export-import.md`
        and `docs/validators-and-stamps.md` name the new files

Context: the Space Metadata file was `.space.<spaceId>.json`, one `.space.`
prefix away from the Space's own `.space.policy.json`, so a Space id of `policy`
gave both one file name. The archive package had reserved the id on its writing
side (its SAR-1) while this server still created such a Space, which then could
not be exported. SAR-8 removed the collision instead, by adding a `meta` segment
to the Space and Collection Metadata file names. This server names its on-disk
Metadata files through the package's builders, so the rename reaches the
filesystem store's layout as well as the archive; layout step 9 refuses a store
written under the old names, in the pattern of the earlier no-conversion steps,
instead of renaming files in place. No Space id is reserved for the archive any
more; `validateId.ts` still reserves `server`.

### WSS-234: [M] (*) `startTestServer` returns the base server URL

- status: done (2026-10-29)
- priority: medium
- labels: tests, testing-counterpart
- backend: *
- discovered-from: WCL-140 (was-client, 2026-10-28); re-scoped 2026-10-29 to
  was-client decision 0003
- touches:
  - was-client: its `test/integration/globalSetup.ts` derives the base with
    `baseServerUrlOf` from the service URL it discovers off `serverUrl`; it
    switches to the returned value once this ships (follow-up to file there once
    this server's testing entry is published)
  - was-react, was-sync and dcw: their counterpart tests build clients from the
    value (follow-ups to file there on the same publish)
  - pws-conformance-suite: 0.34.0 still imports `spacesUrl` from
    `@interop/was-client/paths`, which was-client 0.100.0 removed, so
    `pnpm conformance:local` fails to load the suite under this repo's
    was-client 0.100.1 dedup (follow-up to file there; the server's wire
    behavior is unchanged)
- acceptance:
  - [x] `startTestServer` returns `baseServerUrl` (the listen origin in
        canonical form, with its trailing slash: the URL under which this server
        serves `service`, `spaces/` and `space/{id}/`) beside `serverUrl`, and
        `src/testing.ts` documents that ZCap clients are built with
        `new WasClient({ baseServerUrl })`
  - [x] `test/helpers.ts` builds its `@interop/was-client` from `baseServerUrl`
        instead of `spacesUrl({ baseUrl: serverUrl })`, opens Spaces with
        `was.space(id)` or `spaceAt(space.url)` as each test holds, and the
        suite is green against the was-client release that ships `baseServerUrl`
        (0.101.0 or later); the pair rule of LEARNINGS.md applies to the bump
        (shipped: was-client 0.100.1 is the release that carries
        `baseServerUrl`; the pair bump also ported every `was.request({ path })`
        in `test/` and `scripts/performance/` to the absolute `url` 0.100.0
        requires, and roots the one bare `was.grant({ target })` on a Collection
        at its Space with `spaceUrl`)
  - [x] A counterpart test asserts the layout the spec's Server Discovery
        section fixes: the service description's `url` is
        `{baseServerUrl}service`, its `spaces` member is
        `{baseServerUrl}spaces/`, and a Create Space `Location` is
        `{baseServerUrl}space/{id}/` (`test/server-layout-api.test.ts`)
  - [x] On the `@interop/storage-core` bump that makes `SpaceMetadata.id`
        optional (0.42.0), `StoredSpaceMetadata` in `src/types.ts` pins `id`
        back to required, so `listSpaces()` keeps returning a definite id and no
        call site adds a `!` or a throw (`listSpaces()` is typed as the stored
        shape less the validator parts; the perf seed script, outside `src/`,
        guards the was-client Space handle's now-optional `id` with one throw)

was-client decision 0003 (2026-10-29) supersedes 0002: a `WasClient` is built
from `{ baseServerUrl }`, the URL under which the spec's Server Layout places
`service`, `spaces/` and `space/{space_id}/`; `was.space(id)` is back and
`was.spaceAt(url)` still opens a Space the server named in `Location`. This
server's `serverUrl` (`createApp({ serverUrl })`, the listen origin) is that
base already, minus the trailing slash, so the counterpart only has to hand it
back under the name consumers now construct from. The spec's new root-reserved
Collection ids (`service`, `spaces`, `space`) apply only to a single fixed Space
served from an origin root, which this multi-tenant server is not, so nothing
changes in its reserved-segment handling.

### WSS-236: [M] (*) Rename the provenance statement's `didLogVersionId` to `didVersionId`

- status: done (2026-10-29)
- priority: medium
- backend: *
- labels: wire-contract, provenance, server-identity
- discovered-from: portable-web-spaces-spec WASS-7 (2026-10-29)
- touches:
  - was-teaching-server (this repo): shipped 2026-10-29 --
    `src/lib/exportProvenance.ts` (the statement type and the member it writes),
    `src/lib/importProvenance.ts` (the verifier's read of it),
    `test/exportProvenance.test.ts`, `test/storage-backend-contract.ts`,
    `test/sync-identity.test.ts`, `docs/admin-guide.md`,
    `docs/server-identity-and-provenance.md`, CHANGELOG.md; ARCHITECTURE.md did
    not name the member
  - space-archive: SAR-10 shipped 2026-10-29, unpublished (0.11.0) -- the
    fixture re-signed by this server's export; consumed here through a temporary
    `link:` until published
  - portable-web-spaces-spec: resolved 2026-10-29 -- the Archive provenance
    section and the did:webvh archive signer profile use `didVersionId`
  - was-conformance-suite: unaffected (no provenance cases yet)
- acceptance:
  - [x] an exported `provenance.jsonl` statement carries `didVersionId`, the
        `versionId` of the log entry whose document lists the signing key, and
        no `didLogVersionId`
  - [x] the import verifier resolves the signer at `didVersionId` and reports
        `unknownSigner` when it names no entry of the log; a statement carrying
        only `didLogVersionId` is `unknownSigner`
  - [x] the three tests and both docs name the member by its new name
  - [x] CHANGELOG entry names the rename as a wire change to the archive

Context: each provenance statement names the version of the signing DID's
document that listed the signing key when the statement was made, so that a
later key rotation does not invalidate an older archive. The member was
`didLogVersionId`, which is did:webvh's vocabulary. The PWS spec made its
provenance text method-neutral on 2026-10-29: the statement now carries
`didVersionId`, and a did:webvh archive signer profile in the spec's DID method
registry says it is the log entry's `versionId`. This server is the one writer
and verifier of the statement, so the rename lands here, and the space-archive
fixture is re-signed from it. Archives written under the old name are not
rewritten; the verifier does not accept them.

### WSS-237: [M] (*) Export manifest `url` values name the spec identifier `https://w3id.org/pws`

- status: done (2026-10-29)
- priority: medium
- backend: *
- labels: wire-contract, import-export, test-coverage
- discovered-from: portable-web-spaces-spec Space Archive Format review
  (2026-10-29)
- touches:
  - was-teaching-server (this repo): shipped 2026-10-29 --
    `test/storage.test.ts` (the manifest entry's own `url` and the Spaces `url`
    assertions), `test/space-archive-fixture.test.ts` (compares against the
    repacked space-archive fixtures), `package.json` (the space-archive version
    carrying the change), `docs/export-import.md`, ARCHITECTURE.md (the
    export/import paragraph), CHANGELOG.md
  - space-archive: SAR-9 shipped 2026-10-29, unpublished (0.11.0) -- the packer
    writes the five documenting URLs; consumed here through a temporary `link:`
    until published
  - portable-web-spaces-spec: resolved 2026-10-29 -- the manifest example and
    the prose under it name the identifier plus the section anchor as the `url`,
    not the rendered document's location
  - was-conformance-suite: unaffected (no suite reads the manifest's `url`
    values)
- acceptance:
  - [x] an exported archive's manifest carries
        `https://w3id.org/pws#archive-manifest` on its own entry,
        `https://w3id.org/pws#spaces` on `space` and the Space directory, and
        the `#collection-metadata-data-model`, `#access-control-policies` and
        `#resource-metadata-data-model` fragments on the entries the spec gives
        a shape to; no `github.io` URL appears in the manifest
  - [x] `test/storage.test.ts` asserts the `manifest.yml` entry's own `url` and
        the Spaces `url` under the new host
  - [x] the fixture counterpart test passes against the repacked space-archive
        fixtures (through the `link:`; the registry range follows the 0.11.0
        publish)
  - [x] `docs/export-import.md` and ARCHITECTURE.md say the manifest's `url`
        values are the spec identifier with a section fragment, and that
        archives written before this change carry the rendered-document host
  - [x] CHANGELOG entry names the change as wire text in exported archives

Context: the PWS spec's Space Archive Format section declares the manifest's
`url` values permanent wire text, and on 2026-10-29 settled that each is the
spec's identifier (`https://w3id.org/pws`) with the defining section's anchor as
the fragment, in place of the `https://w3c-ccg.github.io/...` location of the
rendered document. The packer is `@interop/space-archive`, which this server
exports through, so the server's manifests change on the version bump with no
code of its own; what the server owns is the test that pins the Spaces URL
(`test/storage.test.ts:183`, still the old host), the fixture comparison, and
the operator docs that describe the manifest. The w3id redirect for
`https://w3id.org/pws` is not registered yet; that is the spec's concern, and
the archive strings are opaque to the reader (the manifest is descriptive and
entries are classified by path), so this item does not wait on it. Archives
exported before the bump keep the old host; the importer does not read the
values, so they import unchanged.

### WSS-228: [M] (*) Export the two-server test helpers from the `/testing` entry

- status: done (2026-10-29)
- priority: medium
- backend: *
- labels: tests, replication, testing-entry
- discovered-from: freewallet FW-688 (2026-10-26)
- touches:
  - was-teaching-server: `src/testing.ts`, `test/helpers.ts`,
    docs/consuming-server-as-library.md ("Testing against the server")
  - freewallet: the replica ceremony's unit tier boots two real servers from
    `/testing` (FW-638, FW-688; both filed there, waiting on this entry's
    publish)
  - was-client: its live tests for replica pause, resume and capability
    replacement (WCL-143) boot a server with a provisioned identity from
    `/testing` (filed there, waiting on this entry's publish)
- acceptance:
  - [x] `injectPeerFetch` (`test/helpers.ts:1106`) is exported from
        `src/testing.ts`, and the suites import it from there
  - [x] Whatever else a two-server boot needs from outside the package is
        exported beside it: a server identity whose key may invoke
        (`provisionServerIdentity`, `test/helpers.ts:844`) and the log fetcher
        (`peerLogFetcherOf`, `:1154`), or one boot helper in the shape of
        `bootPeerServer` (`:1179`) -- both: the pieces and `bootPeerServer`,
        with `mintServerDid` and `frozenClock` beside them
  - [x] A test that imports only from the `/testing` entry boots a source and a
        replica server, registers, and pulls
  - [x] docs/consuming-server-as-library.md documents the helpers

Context. The wallet's replica ceremony is tested against two real servers in one
process rather than a second fake server. The server already takes `peerFetch`
and `peerLogFetcher` as plugin options (`src/plugin.ts:255-272`), but the
transport that routes one server's pulls to another through `fastify.inject`
lives in the test helpers, outside the published entry. `injectPeerFetch` routes
GET only, which is all a pull sends.

### WSS-235: [M] (*) [after SC-12] Rename `instance.exportSigningKey` to `exportSigningMethod` on `/service`

- status: done (2026-10-30)
- priority: medium
- backend: *
- labels: wire-contract, service-description, server-identity
- discovered-from: portable-web-spaces-spec WASS-7 (2026-10-29)
- touches:
  - was-teaching-server (this repo): `src/serviceDescription.ts` (the `instance`
    member it composes), `src/lib/serverIdentity.ts` (the field on the
    signing-key record and the identity log entry it writes), `src/plugin.ts`
    (the option it threads through), the two server-identity tests, README.md
    (the `WAS_SERVER_KEY_SEED` row), ARCHITECTURE.md (the service description
    and server identity paragraphs), `docs/admin-guide.md` (provisioning and
    rotation steps, the `jq` line), `docs/server-identity-and-provenance.md`,
    `docs/service-description.md`, CHANGELOG.md
  - storage-core: shipped 2026-10-30 -- SC-12 (the type the member is read
    from), published as 0.43.0
  - portable-web-spaces-spec: resolved 2026-10-29 -- the Instance Disclosure
    list and the Archive provenance section use the new name
  - was-conformance-suite: unaffected (nothing in it reads the member)
- acceptance:
  - [x] `/service` carries `instance.exportSigningMethod` with the value
        `exportSigningKey` carried, and no `exportSigningKey` member
  - [x] the identity module's signing-key record field uses the new name (the
        plugin options are unchanged)
  - [x] the server-identity API and runbook tests assert the new member
  - [x] README, ARCHITECTURE.md and the three docs name the member by its new
        name, including the admin guide's `jq` read and rotation step
  - [x] CHANGELOG entry names the rename as a wire change to `/service`

Context: the service description advertises the key the server signs its Space
archive exports with, under `instance.exportSigningKey`. The value is a
`did:key`, which identifies a verification method rather than carrying key
material, so the PWS spec renamed the member to `exportSigningMethod` on
2026-10-29. This server is the one writer of the member and its docs are the
operator's guide to provisioning the identity, so the rename reaches the service
description, the identity module, the tests and every doc that tells an
administrator to read the value off `/service`. No alias for the old name is
served.

### WSS-242: [M] (fs) A refused layout step strands the store between releases, and the deploy has no rollback

- status: done (2026-10-30)
- priority: medium
- backend: fs
- labels: server, storage, deploy, ops
- discovered-from: the v0.43.0 production deploy failure (2026-10-30)
- acceptance:
  - [x] The migration runner evaluates every refusing step (one that only
        inspects and throws) before any converting step writes, so a refused
        boot leaves `store.json` and the data dir as the previous release wrote
        them
  - [x] A test boots a store the previous layout wrote through a migration list
        whose converting step precedes a refusing step, and asserts the refusal
        leaves the store bootable by the previous migration list
  - [x] The Deploy workflow takes a volume snapshot before `flyctl deploy`
        (`flyctl volumes snapshots create`), so a failed deploy has a restore
        point of its own
  - [x] docs/deployment-fly.io.md gains a "Rolling back" section: dispatch the
        workflow on the previous tag, when that works, and restore the snapshot
        into a new volume when it does not

The v0.43.0 release deploy failed its health check. The boot ran layout steps 6,
7 and 8 (step 8 moves each Space's revocation records into its Space dir),
stamped `store.json` at 8 after each, and step 9 refused the Metadata files
under their old names. Dispatching the Deploy workflow on the v0.42.3 tag then
failed the same way: that release knows layouts up to 5 and refuses a
`store.json` stamped newer. Neither release booted, and the only machine was
left on a non-booting image, since Fly's rolling update replaces it in place
with no automatic rollback. The only way out was a wipe.

Two defects. The runner stamps converting steps before a later refusing step has
had its say, so a refusal that is meant to be harmless (boot again after fixing
the store) instead leaves the store readable by no release. And the deploy has
no safety net: no snapshot before the roll, no documented rollback, and a
dispatch on an older tag is only a rollback while the store is still at that
tag's layout.

### WSS-243: [M] (*) List the Portable Wallet Profile entry in the service description

- status: done (2026-10-30)
- priority: medium
- backend: *
- labels: service-description, wallet-profile, wire-contract
- discovered-from: portable-wallet-profile-spec PWP-1 (archived 2026-10-30)
- touches:
  - portable-wallet-profile-spec: PWP-1. SHIPPED (2026-09-16): identifier
    `https://w3id.org/pws/wallet-profile`, version `0.1`, entry members exactly
    `version` and an optional `url`
    (`https://interop-alliance.github.io/portable-wallet-profile-spec/`), no
    `features`. A server MUST NOT list the entry unless its PWS `0.5` entry
    carries `listing`, `collection-management`, `space-management`, `policy`,
    `export`, `encryption`, `changes-query` and its PWS-EC `0.1` entry carries
    `blinded-index-query`, `governed-history-logs`
  - was-conformance-suite: PWSCS-33 (filed) verifies the listing against the
    required tokens once this ships (the pair rule of LEARNINGS.md applies)
  - was-client: WCL-146 (filed) reads the entry
- acceptance:
  - [x] `SERVICE_FEATURES` (`src/serviceDescription.ts:74`) gains the
        `encryption` token. The server already implements the Collection
        `encryption` member (set-once, served from the governed log's head) but
        does not advertise it, and the wallet profile requires the token. Verify
        the PWS spec's definition of the token is met in full before adding it
  - [x] `WALLET_PROFILE_IDENTIFIER`, `WALLET_PROFILE_VERSION` (`'0.1'`) and
        `WALLET_PROFILE_URL` constants in `src/config.default.ts`, documented
        like the authz and EC profile constants beside them
  - [x] The service description lists the entry under its identifier with
        `version` and `url` only
  - [x] A test asserts the listing, and a test asserts the invariant the profile
        states: every token the profile requires is present in the PWS and
        PWS-EC entries this server serves, so the entry can never be listed
        while a required token is missing
  - [x] ARCHITECTURE.md's service description section names the profile among
        the `specs` keys the server lists
  - [x] CHANGELOG entry

Filed 2026-10-30 from portable-wallet-profile-spec PWP-1, whose spec text
shipped 2026-09-16; this is the server half it named. Listing the entry is a
conformance claim and adds no route. The one substantive change is the missing
`encryption` token, without which the server does not satisfy the profile and
may not list it.

### WSS-224: [M] (*) Admit a replica Space under a bootstrap did:key, and resolve the auxiliary Space's controller across Spaces

- status: done (2026-10-30)
- priority: medium
- backend: *
- labels: replication, registration, webvh, zcap
- discovered-from: freewallet FW-688 (2026-10-26)
- touches:
  - web-spaces-server: SHIPPED (2026-10-30): `src/sync/registration.ts`
    (`assertControllerBranch`, `readHostedControllerDocument`,
    `resolveMappedControllerDocument`, `assertBootstrapDelegation`),
    `src/zcap.ts` (`verifyOneLinkDelegation`), `src/lib/webvhController.ts` (the
    resolver context's `peer` takes any `resolve`/`resolveKey` pair),
    docs/replication.md ("Registration checks"), ARCHITECTURE.md (the
    `src/sync/` entry). `src/lib/webvhLogLocation.ts` needed no change: the
    cross-Space lookup is `locateWebvhLog` as it stood, reached through
    `resolveWebvhController`
  - portable-web-spaces-spec: resolved 2026-10-29 -- decision 0013 is amended
    and the replication companion (`replication/spec.md`, "The controller
    check") states the branch, with no binding of the local did:key to the
    capability; WASS-58's touches gain the `fromSpace` comparison
  - freewallet: the replica registration ceremony (FW-638, FW-688) creates and
    registers under the bootstrap did:key; unblocked by this item, nothing filed
    here
  - was-conformance-suite: PWSCS-23's registration-check cases (the suite's
    item, no new id filed here)
- acceptance:
  - [x] A registration onto a local Space whose controller is a did:key is
        admitted when the source Space's controller is a did:webvh this server
        can resolve, the pull capability's chain is `[root, capability]` (one
        delegated link), and that link's delegation proof is signed by a method
        the resolved document lists under `capabilityDelegation`. The local
        did:key need not appear in the document
  - [x] The did:webvh resolves either as today (hosted in `fromSpace`, its log
        read through the pull capability and verified offline) or from a local
        copy another registration on this server already maps
        (`locateWebvhLog`). The second form admits the auxiliary Space, whose
        controller's log lives in the account Space and reaches this server
        through the account replica's registration
  - [x] A re-delegated two-link chain is refused, and so is a ladder-signed
        capability the source server refuses (the registration's read of the
        source Space fails first)
  - [x] Update Space promotes the auxiliary replica Space to the account
        did:webvh resolved through the account replica's mapping, and the Delete
        Replica guard (`controllerUnmappedByRemoval`) refuses removing the
        account replica's registration while the auxiliary replica Space is
        controlled by that DID
  - [x] The `invocationTarget` comparison against `fromSpace`
        (`registration.ts:187`) is named in WASS-58's touches, so it also
        accepts the `*` subtree form once that marker ships. No dependency on
        WASS-58
  - [x] docs/replication.md and ARCHITECTURE.md state the branch, and a
        two-server test (in the style of
        `test/replicated-webvh-controller.test.ts`) covers each box above.
        Shipped as the "the bootstrap branch" block of that file, plus two
        refusals in its "promoted before it gained a replica" block (a
        re-delegated chain; a capability the origin does not admit). The Delete
        Replica guard and the Update Space promotion needed no code change:
        `controllerUnmappedByRemoval` and `controllerChangeConflict` already
        decide across Spaces; the tests pin it

Context. A wallet copies its account onto a second server by creating a Space
there, delegating a read-only pull capability to that server's `serverDid`, and
registering the source Space. The replica server creates a Space only under a
did:key. Today the controller check admits a local did:key only when the source
controller's document lists it under `capabilityInvocation`
(`assertLocalControllerIsPeerKey`, `registration.ts:498-572`, the branch WSS-205
added; the listing check is at `:566`). An account anchored in a standing
credential's ladder has no such key, so it cannot register a replica. The wallet
uses a bootstrap did:key K derived from a seed on its directory entry for the
replica server. K creates the replica Space, registers it, promotes it to the
account did:webvh after the first pull, and controls nothing afterwards.

The branch also has to cover the client-annex auxiliary Space. Its controller is
the account did:webvh, whose log is in the account Space, so today's requirement
that the log be hosted in `fromSpace` itself
(`hosted.fromSpace !== record.fromSpace`, `registration.ts:521`) refuses it.
This is the cross-Space case of WSS-96's open question 5. WSS-206's mapping rule
(`replicaMappingConflict`) is unchanged.

The squat analysis, from the design. The replica server cannot read the wallet's
replica pointer (it lives in the annex, which is not copied yet), so the gate
sits at the source server: the registration reads the source Space through the
capability, and the source refuses a ladder-signed pull with no pointer
(WSS-225). A third party holding a re-delegated grant fails the one-link
condition. One residue stays open, left to this item by the design: any reader
of the wallet's directory can register the recorded capability under its own
did:key in a tear between the wallet's mint and its POST, and then win
`replicaMappingConflict`. Binding the local did:key to a K recorded with the
capability would close it. Settled 2026-10-29 in the companion text: no binding.
The residue is accepted and recorded in the companion's security considerations
("The bootstrap key"); the first acceptance box above stands as written.
Related: WSS-207 (a log that declares witnesses still cannot replicate), WSS-210
(one function for where a did:webvh resolves from).

---

### WSS-238: [M] (*) `serverDid` moves to the core `specs` entry, and the replication entry carries `url`

- status: done
- done: 2026-10-30
- priority: medium
- backend: *
- labels: wire-contract, service-description, server-identity, replication
- discovered-from: portable-web-spaces-spec WASS-50 (2026-10-29)
- touches:
  - web-spaces-server (this repo): `src/serviceDescription.ts` (the `instance`
    member it composes and the core entry beside `originId`; the
    `REPLICATION_IDENTIFIER` entry's members), `src/config.default.ts` (the "no
    `url` until the text is published" comment), the two server-identity tests,
    `docs/service-description.md`, `docs/server-identity-and-provenance.md`,
    `docs/replication.md` (what a wallet reads to find the DID to delegate to),
    ARCHITECTURE.md (the service description paragraph), CHANGELOG.md
  - storage-core: the `ServiceDescription` type (the core entry gains
    `serverDid`; `instance` loses it) -- shipped in storage-core 0.44.0
  - freewallet / wallet-core: whatever reads the replica server's DID off
    `/service` before delegating the pull capability (FW-638, FW-688)
  - was-conformance-suite: a service-description case, if one asserts the
    member's placement
  - portable-web-spaces-spec: the text defining `serverDid` on the core version
    entry landed 2026-10-29 on the spec repo's `replication-spec` branch. It is
    not merged to main as of 2026-10-30
- acceptance:
  - [x] `/service` carries `serverDid` on the `https://w3id.org/pws` entry,
        beside `originId`, and `instance` no longer carries it
  - [x] The `https://w3id.org/pws/replication` entry carries `url`
        (`https://w3c-ccg.github.io/portable-web-spaces-spec/replication/`)
  - [x] `assertPeerServes` still reads `originId` and the replication entry and
        nothing else; no registration check reads `instance`
  - [x] The server-identity tests assert the new placement; docs and
        ARCHITECTURE.md name it
  - [x] CHANGELOG entry names the move as a wire change to `/service`

Context: the replication companion decided 2026-10-29 where the server's DID is
advertised. Core's Instance Disclosure says `instance` is optional operator
disclosure a client may not gate on, and a wallet gates on the DID: it is the
`controller` it delegates the pull capability to, and a server without one
cannot hold a replica. So the member sits on the core entry, as `originId` does
and for the same reason. The companion text now exists, so the replication
entry's `url` can be served. Related: WSS-235 (the other `instance` member that
moves or is renamed).

2026-10-30: implemented. `/service` serves `serverDid` on the core entry with no
alias under `instance`, and the replication entry serves `url`; archived.

### WSS-103: [L] (*) Make `spacePath` / `collectionPath` return the canonical container URL by default

- status: done
- done: 2026-10-30
- priority: low
- backend: *
- labels: cleanup, paths
- discovered-from: simplify pass on the v0.5 route table (2026-09-12)
- acceptance:
  - [x] `spacePath` and `collectionPath` in `src/lib/paths.ts` return the
        trailing-slash container form with no option
  - [x] The no-slash base the sub-resource builders extend (`spaceMetaPath`,
        `collectionMetaPath`, `policyPath`, `exportPath`, and so on) comes from
        a separately named internal builder, not from a flag on the public one
  - [x] No call site in `src/` or `test/` passes `trailingSlash` any more
  - [x] Every `url`, `Location`, `targetPath` and root-capability target is
        byte-identical before and after (the full `test/` run and the
        conformance suite stay green)

Context: v0.5 made the trailing-slash form the canonical address of a Space and
a Collection, used for their `url` members, the `Location` of a create, the
authorization `targetPath` of container operations, and the root capability's
`invocationTarget`. The builders kept their v0.4 default of the no-slash form,
so about 33 call sites outside `paths.ts` pass `trailingSlash: true`. Dropping
the flag at any of them is not a type error and yields a URL that is wrong only
by its last character, in exactly the members that need to be canonical. The
no-slash form is wanted mostly inside `paths.ts` itself, as the prefix the
sub-resource builders extend; about 9 external call sites use it, and each
should move to the named base builder or a sub-resource builder.

2026-10-30: implemented. `spacePath` and `collectionPath` take no flag and
return the container form, and the no-slash prefix lives in the unexported
`spaceBase` and `collectionBase` inside `paths.ts`. The roughly 9 external
no-slash call sites had already moved to sub-resource builders, so all 34 call
sites only dropped the flag; archived.

---

### WSS-225: [M] (*) Client-annex clause: a ladder-signed replica pull gated on the annex document's replica pointer

- status: done
- priority: medium
- backend: *
- labels: client-annex, zcap, replication, webvh
- discovered-from: freewallet FW-688 (2026-10-26)
- touches:
  - web-spaces-server: `src/lib/clientAnnexClause.ts`
    (`ladderDelegationAdmitted` and the module header), `src/config.default.ts`
    (the `CLIENT_ANNEX_VERSION` comment), docs/client-annex-clause.md (a sixth
    shape), ARCHITECTURE.md (the clause entry), `decisions/0002` (amended
    2026-10-26; shipped 2026-10-30, decision amended again)
  - app-connect-spec: decision 0003 (clause A's sixth predicate, the normative
    text) and decision 0001 (the `ReplicaServer` service entry type in the annex
    document) -- already shipped 2026-10-26, nothing further
  - wallet-core: the ladder-signed pull mint, the ladder-clause counterpart
    fixtures, and the `hostConformance.ts` header's predicate count -- follow-up
    to file there (freewallet FW-688 owns the mint)
  - portable-web-spaces-spec: resolved 2026-10-29 -- decision 0013 is amended
    and the replication companion ("Signing the pull capability") defines the
    `ReplicaServer` pointer and cites the predicate by name; WASS-58's touches
    gain the pull capability's target
- acceptance:
  - [x] A ladder-signed delegation is admitted when its sole `controller` equals
        the `serviceEndpoint` of a `https://w3id.org/pws#ReplicaServer` service
        entry in the annex document the delegator's account document names
        through its `DelegatedClients` entry. The annex document is resolved and
        verified out of this server's storage (`resolveWebvhController`), with
        no network fetch
  - [x] The controller parses as a did:webvh whose path is `space:server:id`
  - [x] The `invocationTarget` is the canonical trailing-slash URL of the
        account Space (the Space carrying the delegator's log) or of the
        auxiliary Space the `DelegatedClients` entry names. The `*` subtree form
        of either waits on WASS-58's marker and is not admitted yet
  - [x] `allowedAction` is present, non-empty, and within {GET, HEAD}, and the
        parent is the Space's synthesized root
  - [x] Two-server tests: admitted with the pointer present; for the
        account-Space target, refused when the pointer is absent, names another
        server, or sits only in a superseded generation; refused for POST, a
        Resource target, a non-root parent, and two controllers; a re-point to a
        generation with no pointer refuses the next account-Space pull
  - [x] Two-server test, expected result for now: a `['GET']` ladder-signed pull
        of the auxiliary Space with the pointer removed is still admitted,
        through predicate 2 branch two. The test names branch two as the
        admitting path, so the branch's later narrowing (freewallet FW-689)
        flips it to a refusal
  - [x] `CLIENT_ANNEX_VERSION` stays `0.1`; its comment in
        `src/config.default.ts` (`:433-437`) and the clause's header and
        `ladderDelegationAdmitted` JSDoc (`clientAnnexClause.ts:12-13`, `:626`)
        count six predicates
  - [x] docs/client-annex-clause.md and ARCHITECTURE.md describe the shape

Context. Clause A bounds what a ladder VM may delegate to five shapes
(`ladderDelegationAdmitted`, `clientAnnexClause.ts:647-826`), none with a
server-DID grantee. So a credential-anchored account cannot sign the pull
capability a replica server needs. The wallet records each replica server as a
service entry in the annex document before it delegates, so the pull is loud at
the annex log's grade. The source server is the only reader that acts on it.
Removing the entry ends that server's ladder-signed pull of the account Space;
the auxiliary-Space pull survives it until branch two is narrowed (see below).
The extra read is the annex document's local resolution. Predicate 1
(`:671-713`) only compares the annex DID string and locates its log; this
predicate resolves the document through the verified-document cache. Reading a
verified log fact as an authorization gate is not a locator fetch, so it stays
clear of decision 0013's rejection of acting on service entries.

Overlap with branch two, accepted 2026-10-26. Predicate 2's second branch
(`:724-736`) already admits a GET of a whole `DelegatedClientsSpace` to any
grantee, with no pointer gate. Predicates are alternatives, so a ladder-signed
auxiliary-Space pull to a `serverDid` stays admitted by branch two after the
pointer is removed. Dmitri accepted this rather than carve branch two in this
item: until a later design narrows branch two with a grantee bound (freewallet
FW-689), removing the pointer ends the account-Space pull only, and revocation
at the auxiliary Space is the auxiliary pull's only stop. That narrowing is what
makes the auxiliary pull pointer-gated in fact. The account-Space half has no
such overlap.

Candidate, not acceptance: verify the annex log incrementally from the cached
head. On a credential-anchored account the pointed generation grows by one entry
per transient visit, and the cache re-verifies the whole log from genesis
whenever its ETag moved, so the first pull after each visit pays for the whole
log, once per replica server.

2026-10-30: implemented. Predicate 6 sits after predicate 2's second branch in
`ladderDelegationAdmitted`; the shape checks run before the annex document is
resolved from storage, and an annex document that does not resolve admits
nothing. The "Resource target" refusal is pinned with a Collection container
target, since a GET-only grant of one Resource is predicate 4's shape and is
admitted to any grantee. `test/ladder-replica-pull.test.ts` holds the two-server
cases, including the branch-two auxiliary pull expected to flip under freewallet
FW-689; archived.

### WSS-226: [M] (*) Open the replicas route to a root-chained delegated invocation

- status: done
- priority: medium
- backend: *
- labels: replication, registration, zcap, client-annex
- discovered-from: freewallet FW-688 (2026-10-26)
- touches:
  - web-spaces-server: `src/requests/ReplicaRequest.ts` (each handler's
    `containerRule: 'controller-only'`, `:78`, `:144`, `:180`, `:224`, `:305`,
    and the module header), `src/routes.ts` (the replicas comment),
    `src/lib/containerRule.ts`, `src/lib/clientAnnexClause.ts`,
    docs/replication.md, docs/client-annex-clause.md ("Controller-only
    operations"), ARCHITECTURE.md (the `src/sync/` entry, "controller-only"),
    `decisions/0002` (amended 2026-10-26), `decisions/0005` (its Context says
    the registration record is controller-only) -- shipped 2026-10-31; the
    create bound lives in `src/sync/registration.ts`
    (`assertDelegatedCreateNamesRegisteredSource`), and
    `src/lib/containerRule.ts` needed no edit (it never named the route)
  - portable-web-spaces-spec: resolved 2026-10-29 -- decision 0013 is amended
    and the replication companion ("Registrations", Authorization) states the
    delegated path and the `POST` bound; WASS-1 / WSS-59's Authorization column
    for `replicas` still open
  - app-connect-spec: decision 0003 (the replica-server-side predicate) --
    already states predicate 7 (2026-10-26), nothing further
  - pws-client: the replica methods' "Controller-only" JSDoc
    (`Space.ts:791-875`); `/paths` exports `spaceReplicas` and
    `replicaRegistration` -- the JSDoc already names the delegated path and the
    create bound; the remaining wording is WCL-144's
  - was-conformance-suite: PWSCS-23 ("registration endpoints are
    controller-only, including GET") revised -- its delegated-route and
    POST-bound cases are filed; its touches now name this item
- acceptance:
  - [x] Every replicas route (list, register, read, remove, status, and
        WSS-227's PUT) admits a delegated invocation whose chain roots in the
        Space's root, in place of `controller-only`. The reads keep demanding
        the auth headers
  - [x] Clause A gains a predicate for it: the `invocationTarget` is the Space's
        replicas URL `/space/<S>/replicas` exactly (or its `*` subtree form once
        WASS-58's marker ships), `allowedAction` is within {GET, POST, PUT,
        DELETE}, the parent is the Space's synthesized root, with no pointer
        gate and no grantee bound
  - [x] A delegated POST is admitted only when its `fromSpace` equals the
        `fromSpace` of a registration already stored on that Space. A root POST
        stays unbounded
  - [x] The Delete Replica guard still refuses removing the one registration
        that maps the Space's did:webvh controller, for a delegated caller too
  - [x] Two-server tests: a ladder-signed delegated grant lists, reads status,
        re-registers against an existing `fromSpace`, pauses through PUT, and
        removes a registration on a promoted replica; a delegated POST naming a
        new `fromSpace` is refused; a root POST naming one is admitted
  - [x] docs, ARCHITECTURE.md, and the Context sentence of `decisions/0005`
        state the new authorization

Context. Once a replica Space is promoted to the account did:webvh, its replicas
routes need a root invocation by a key the account document lists under
`capabilityInvocation`. A credential-anchored account has none, and every pull
capability dies at its signer's next withdrawal, a passphrase change included.
So a session of another credential must be able to maintain the registration.
The wallet mints a short-lived grant on the replicas URL with its ladder VM, to
its own bare did:key, and invokes it as that did:key.

The predicate carries no pointer gate, since the replica server could read the
pointer only from its own copy of the annex, which lags by a pull and does not
exist before the auxiliary Space is copied. What the grant reaches is bounded
otherwise. The guard keeps the one mapping registration. A listing exposes pull
capabilities only their `serverDid` can invoke. The POST bound closes the one
widening: without it a phished credential's holder could register its own server
as a second source serving the account DID as `controller`
(`assertPeerSpaceMatches` only string-compares it, `registration.ts:452`), and
have that source's tombstones applied to the copy. It is shape-gated, like
predicates 1 to 5. WSS-225 and this item both edit `clientAnnexClause.ts` and
the clause's predicate count; whichever lands second updates the count. Related:
WSS-209 (a ladder-signed delegation on a replica, under the clause).

Done 2026-10-31. The create bound covers a `PUT` at an absent id as well as a
`POST`, since a `PUT` there creates through the same checks and the bound would
otherwise be void; a replacement needs none, `fromSpace` being fixed by `PUT`.
The refusal is `replica-refused` (409) on `#/fromSpace`, decided before the
source is read, since a delegated caller may list the registrations and learns
nothing from it. The two-server cases live in `test/ladder-replica-pull.test.ts`
("a ladder-signed maintenance grant on a promoted replica Space"); the
single-pair cases in `test/replication-api.test.ts`. The clause count is seven,
and the client-annex profile stays at `0.1`. Open tension for WSS-239: once a
second registration of one source sharing a Collection is refused on the same
Space, and the controller-log Collection is always selected, a delegated `POST`
re-registering the account Space has no admitted case left; the delegated path
then rests on `GET`, `PUT` and `DELETE`.

---
