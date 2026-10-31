# 0002: The client-annex clause admits enumerated ladder delegation shapes

- Status: accepted
- Date: 2026-09-01
- Driving work: the browser wallet's transient sessions. Account deletion needs
  ladder-signed DELETE-only and GET-only delegations, backup export a POST-only
  one, and replica registration a ladder-signed pull capability on the source
  server and a ladder-signed grant on a replica server's replicas route.
- Affects: was-teaching-server (`src/lib/clientAnnexClause.ts`, the admission
  predicates and the locked-property comment; `src/lib/containerRule.ts` and
  `src/requests/ReplicaRequest.ts` for the replicas route; the
  `CLIENT_ANNEX_VERSION` comment in `src/config.default.ts`;
  docs/client-annex-clause.md; ARCHITECTURE.md's restatement). The clause's
  normative home is app-connect-spec `decisions/0003` (clause A) and the
  companion-profile text it governs, amended in step. The replica pointer's
  service entry type is app-connect-spec `decisions/0001`'s, and the replication
  side is portable-web-spaces-spec decision 0013's. wallet-core and the wallets
  mint the shapes the clause admits.

## Context

A ladder VM is the verification method a standing unlock credential publishes in
the account document. The server recognizes it by relation asymmetry: a
`capabilityDelegation` member absent from `capabilityInvocation`. Unbounded, it
could delegate Space-scoped authority to any key with no log entry anywhere,
which the loudness model forbids. So the clause admits a ladder-signed
delegation only in enumerated shapes.

Each shape serves one need of a transient session on an account whose only
long-lived delegation signer is the ladder. Account deletion delegates and
invokes as the ladder VM's own bare did:key, the one identity that keeps
resolving while the walk deletes the Spaces every hosted document lives in. The
backup export invokes Export Space on a sibling unlock Space under the
management capability that Space's controller granted the account. A replica
server pulls the account under a capability delegated to its `serverDid`, and
after promotion its replicas route needs a grant a session of any standing
credential can sign.

## Decision

The normative text of each predicate is app-connect-spec `decisions/0003`,
clause A. This server implements it as follows. On the source server, a
ladder-signed delegation is admitted iff one of six predicates holds:

1. Annex-DID controller inside the account Space's items subtree: the sole
   `controller` is the annex DID the account document's `DelegatedClients` entry
   names, the target lies under the account Space's URL outside `/meta`, and the
   actions lie within the closed PWS verb set.
2. Bridge-shaped target: the delegator's own history log with actions within
   {PUT}, or a whole Space typed `AuxiliarySpace` and `DelegatedClientsSpace`
   with actions within {GET, PUT, POST}.
3. Target-exact single-verb Space DELETE (the target equals the parent's
   unchanged, actions exactly `['DELETE']`) or Space Metadata GET (actions
   exactly `['GET']`, narrowing from the Space or the same Metadata URL).
4. Target-exact GET of one Resource, under a parent that targets that Resource
   or its Space.
5. Target-exact POST on a Space URL, under a delegated management capability
   whose sole `controller` is the delegator account and whose delegator is that
   Space's stored controller.
6. Replica pull: the sole `controller` equals the `serviceEndpoint` of a
   `https://w3id.org/pws#ReplicaServer` service entry in the annex document the
   account document's `DelegatedClients` entry names, resolved and verified from
   this server's storage, and parses as a did:webvh whose path is
   `space:server:id`. The target is the canonical trailing-slash URL of the
   account Space or of that auxiliary Space. The actions lie within {GET, HEAD},
   and the parent is the Space's root.

On a replica server, the replicas route admits a delegated invocation rooted in
the Space's root, and a ladder-signed delegation on it is admitted when its
target is the Space's replicas URL exactly, its actions lie within {GET, POST,
PUT, DELETE}, and its parent is the Space's root. It carries no pointer gate and
no grantee bound. A delegated POST there may only name a `fromSpace` a
registration on that Space already names.

The sixth predicate's targets and the replicas URL also match their `*` subtree
form under the PWS spec's explicit subtree scope.

Two invocation-time bounds sit on top of the predicates. A chain with a
ladder-signed link is refused as a PUT on a Space Metadata URL, and as a DELETE
on a Space URL unless every ladder-signed link is itself the predicate 3 DELETE
shape. A DELETE on a Space URL is refused whenever any link is signed by a
transient annex VM.

The locked property: every admitted ladder delegation either resolves through a
loud annex entry, can only write a log, is a target-exact single-verb read, a
destruction of one Space, or a POST over a management grant the account already
holds, or is a pull by a server the pointed annex document names. The
replicas-route shape is the one exception, and it holds only on a replica
server, whose copy is never the account's log of record.

## Rejected Alternatives

- A sixth predicate with no pointer: any ladder-signed GET of the account Space
  to a `space:server:id` DID, with no record. It lets a phished credential copy
  the whole account to a server of the thief's choosing and decrypt the copy
  with the user key the same credential unwraps. That is the silent authority
  the clause exists to rule out. The other silent read shapes reach one Resource
  or the annex, with no listing of the account's collections; this one would
  reach everything. Do not reopen while loudness is the model.
- The replica pointer in the account document, which a replica server could read
  at registration. The account document is world-readable, so every replica
  server would be listed for anyone. Rejected where the pointer's home is
  decided (app-connect-spec `decisions/0001`); the sixth predicate reads the
  capability-gated annex document instead.
- A pointer gate on the replicas-route shape. The replica server could read the
  pointer only from its own copy of the annex, which lags the source by a pull
  and does not exist before the auxiliary Space is copied.
- An unbounded delegated POST on the replicas route. A credential holder could
  register a second source serving the account DID as `controller`, since the
  registration only compares that string, and have its tombstones applied to the
  copy.
- A PUT child of a Space URL beside predicate 5's POST, for a restore creating a
  sibling unlock Space by id. The target attenuation is a `/`-boundary prefix
  rule, so such a child reaches every Resource beneath the Space, including
  another credential's keyring record, and the overwrite leaves no trace in
  either log. A bounded create-only shape may be added later instead.
- Relying on predicate 1's admission for the deletion chains. Predicate 1 admits
  only an annex-DID grantee inside the items subtree, and the deletion
  ceremony's grantee is the ladder VM's own did:key.
- A general ladder-may-delegate-anything predicate. It dissolves the clause.
- Identifying the ladder VM by subject instead of relation asymmetry. It carries
  the pitfalls the existing rule avoids: action-set normalization, a
  verification method the predicate never receives, and an embedded-node method
  that yields no multibase.

## Consequences

- The reference server implements predicates 1 to 6 and the replicas-route
  shape, as its seventh predicate, admitted only where the delegator's log is a
  replicated copy. The replicas route admits a delegated invocation whose
  invoked capability targets the replicas URL or a URL beneath it, bounds a
  delegated create (POST, or PUT at an absent id) to a `fromSpace` a
  registration on the Space already names, and refuses a delegated pause of the
  registration that maps the Space's controller.
- The client-annex profile version is `0.1`. A change to what the clause admits
  is a new version.
- A DELETE admitted under predicate 3, and every replicas-route grant, writes no
  log. The account-Space DELETE removes the log any record would live in. A
  replica is reached by a credential-anchored account only through the ladder,
  and its copy is never the log of record.
- The sixth predicate costs one local resolution of the annex document per
  chain. The cache revalidates on the log's `ETag` and re-verifies the whole log
  when it moved, and on a credential-anchored account the pointed generation
  grows by one entry per transient visit.
- Predicate 2's second branch still admits a GET of a whole auxiliary Space to
  any grantee, with no pointer. So removing a replica pointer ends that server's
  ladder-signed pull of the account Space, but not of the auxiliary Space, until
  that branch is narrowed.
- The predicate list grows by one carve-out per standing grant a
  credential-anchored account needs. The sixth predicate is the first gated on a
  record rather than on shape alone.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. app-connect-spec `decisions/0003` changes clause A's normative predicates;
   this record follows the normative home.
2. A new ceremony needs a new action set or a changed target rule. Extend it as
   a new enumerated shape rather than loosening the target-exactness or the
   two-verb bound.
3. A further standing grant would need another carve-out, and a loud record
   could gate it the way the replica pointer gates the sixth predicate.
   Generalize the record-gated form so later grants reuse it, rather than adding
   predicates one by one.
4. Predicate 2's second branch is narrowed. Drop the auxiliary-Space consequence
   above.

## Changelog

- 2026-09-20: a fifth shape added, a target-exact POST over a delegated
  management capability; its PUT half was withdrawn before landing.
- 2026-10-26: rewritten to state the whole current clause. The fourth shape (a
  GET of one Resource) is now listed. A sixth predicate (a replica pull gated on
  the annex document's replica pointer) and a replica-server shape on the
  replicas route are added, with the pointer-less replica pull rejected and the
  locked property restated. The title is widened from the target-exact shapes to
  the enumerated ones.
- 2026-10-30: the sixth predicate is implemented. The annex document is resolved
  from storage through the verified-document cache, the grantee's shape check is
  a did:webvh path of `space:server:id` on any host, and the auxiliary-Space
  target is the Space carrying the annex log. The consequence on predicate 2's
  second branch stands, pinned by a test.
- 2026-10-31: the replicas-route shape is implemented as the seventh predicate,
  and the replicas route trades `controller-only` for a `replicas-subtree`
  container rule, so a data grant on the Space URL stays out while the
  maintenance grant passes. The create bound covers a PUT at an absent id as
  well as a POST, since a PUT there creates through the same checks; a
  replacement needs none, `fromSpace` being fixed by PUT. The refusal is
  `replica-refused` (409) on `#/fromSpace`, decided before the source is read
  and again inside the write's critical section. A delegated pause of the
  registration that maps the Space's controller is refused the same way on
  `#/pausedAt`, since a paused copy would keep a withdrawn key current. The
  shape's `allowedAction` set admits `HEAD`, which every `GET` route answers.
  The shape is refused where the delegator's log is self-hosted, so it holds on
  a replica server only, as decided. The client-annex profile stays at `0.1`.
