# History

## 0.46.1 - TBD

### Added

- The production Deploy workflow, run by hand, offers a `wipe_data` option, off
  by default. It clears the data volume and drops the Postgres `public` schema
  after the volume snapshot and before the deploy. A deploy from a published
  release never wipes.
- The production Deploy workflow, run by hand, takes a `ref` input naming the
  tag, branch or commit to deploy. A rollback runs the current workflow over a
  previous tag.

### Fixed

- The production Deploy workflow no longer stops when Fly refuses its volume
  snapshot because an earlier one is still scheduled. It warns and goes on.

## 0.46.0 - 2026-11-12

### Added

- Every Resource and chunk record stores the content digest of its stored
  representation, the `Digest` header's `mh=` multihash form (sha-256) over the
  bytes a `GET` serves, a JSON body as re-serialized. The filesystem sidecar
  carries it as `digest` and the Postgres `resources`, `chunks` and
  `chunk_staging` rows in a `digest` column, recorded inside the write's
  critical section with the stamp, on the request, replication and import paths.
  A soft delete keeps the deleted content's digest on the tombstone. Export
  strips the member from the archived sidecars and import ignores an archived
  one, recording the digest of each file it writes. The filesystem layout moves
  to version 10 and the Postgres schema to migration 16; each refuses a
  populated store written before it with `StoreVersionError`.

- The replicas routes admit a delegated invocation whose invoked capability
  targets the Space's replicas URL or a URL beneath it, in place of
  controller-only: list, register, read, replace, remove and status. That is the
  `replicas-subtree` container rule; a delegated grant on the Space URL is
  refused there. The reads keep demanding the auth headers. A create under a
  delegated invocation, by `POST` or by `PUT` at an absent id, admits only a
  `fromSpace` a registration on the Space already names, and is otherwise
  `replica-refused` (409) on `#/fromSpace`. The bound is decided before the
  source is read and again inside the write's critical section, which the
  Space's other registration writes and removals cannot enter meanwhile. A
  delegated `PUT` that would pause the registration mapping the Space's
  controller is `replica-refused` (409) on `#/pausedAt`. A root invocation
  carries neither bound. Delete Replica keeps the registration that maps the
  Space's controller for a delegated caller too.
- The client-annex clause admits a seventh ladder-signed shape, a maintenance
  grant on a Space's replicas URL: the target is `/space/<S>/replicas` exactly,
  the actions lie within `GET`, `HEAD`, `POST`, `PUT` and `DELETE`, the parent
  is the Space's root, and the delegator's log is a replicated copy rather than
  one self-hosted here, with no grantee bound and no pointer gate. It is the
  grant a wallet session holds to maintain the registrations of a promoted
  replica Space. The client-annex profile stays at `0.1`.
- The client-annex clause admits a sixth ladder-signed shape, the replica pull.
  A delegation a ladder verification method signs is admitted when its sole
  `controller` is the `serviceEndpoint` of a
  `https://w3id.org/pws#ReplicaServer` service entry in the client-annex
  document the account document names, and parses as a `did:webvh` whose path is
  `space:server:id`; its target is the canonical URL of the account Space or of
  the auxiliary Space carrying the annex log; its actions lie within `GET` and
  `HEAD`; and its parent is the Space's root. The annex document is resolved
  from this server's storage, with no network fetch. Removing the pointer, or
  re-pointing the account at an annex generation without it, ends the
  account-Space pull. The auxiliary-Space pull is still admitted by the
  bookkeeping-Space shape. The client-annex profile stays at `0.1`.
- `/testing`: a `PeerServer` carries its `signingKey`, so a two-server suite can
  invoke as a server does when it pulls.

### Changed

- BREAKING: the capability action vocabulary is `GET`, `POST`, `PUT` and
  `DELETE`. A `HEAD` request is authorized as a `GET`: its invocation names the
  `GET` action, and a capability that permits `GET` permits it. A `HEAD` signed
  with the action `HEAD` is refused as any action mismatch is (404). A replica
  pull capability must carry `allowedAction` within `["GET"]`. The client-annex
  clause refuses a ladder-signed delegation listing `HEAD`, and its replica pull
  shape admits `GET` alone. The `signedInject` test helper signs a `HEAD` as
  `GET`.
- BREAKING: a request with no `Authorization` or no `Capability-Invocation`
  header beneath `/space/:spaceId` answers the masked `not-found` (404) where it
  answered `missing-authorization` (401). That covers every unsafe method, Get
  Policy at all three levels, and the replicas reads. The body is the same bytes
  an under-authorized signed request gets at that URL. Create Space at
  `POST /spaces/` and every `/kms` route keep the 401.
- BREAKING: `PUT .../meta/log` with a body equal to the stored governing history
  log is refused with `invalid-request-body` (400) once its precondition passes,
  where it answered 204 and wrote nothing. A stale `If-Match` on such a body
  stays `precondition-failed` (412). A re-sent `did.jsonl` log of a self-hosted
  `did:webvh` stays a no-op.
- A refused `PUT .../meta/log` whose body the control plane already stores runs
  the copy to the Collection's server backend again before it answers, so a copy
  that faulted on the first attempt is brought level by the retry.
- Create Space by Id and revocation submission refuse a request with no auth
  headers before their create-only checks and the submitted chain's
  verification.
- BREAKING: `PUT /space/:spaceId/:collectionId/meta` carries the container rule
  the governing log write carries. It admits a root invocation, or a delegated
  one whose invoked capability targets exactly the Space's canonical URL. A
  delegated invocation whose capability targets the Collection URL, the Metadata
  URL or a Resource URL answers the masked `not-found` (404). Create Collection
  by `POST` keeps no rule.
- The write-once rule on an `immutable` Collection compares the digest of the
  bytes a write would store with the stored digest, and reads no stored bytes (a
  live filesystem sidecar with no digest is compared through a digest of its
  stored file, so the rule holds over it too). A write over a tombstone is held
  to the deleted content: a repeat is a no-op answering the tombstone's `ETag`
  with `size` 0 and the Resource stays deleted, and a different body is refused
  with `resource-immutable` (409). The repeat reclaims a file a torn delete left
  beside the tombstone. A tombstone with no digest (one an import wrote) still
  admits an ordinary create.
- Breaking wire change: the Collection `encryption` descriptor is creation-only.
  An Update Collection that adds `encryption` to an existing Collection without
  one is refused with `encryption-immutable` (409). Create Collection, a create
  by `PUT .../meta` (over a Collection tombstone too) and a governing history
  log's guarded create still declare it. On the replication apply path, a
  received update carrying `encryption` over a held Collection without one is
  refused as a `fork`, and Register Replica refuses such a pair with
  `replica-refused` (409).
- On the replication apply path, a received `revisions.resolution` or
  `revisions.immutable` other than its default, over a held Collection that
  lacks the member, is refused as a `fork`. Register Replica refuses such a pair
  with `replica-refused` (409).
- Register Replica compares the immutable members of a Collection only when both
  servers hold the same life of it (one generation). It leaves two Collections
  under log governance to their logs, and refuses a governed Collection paired
  with a client-written `encryption`. The refusal detail names the server that
  declares the member.
- Requires `@interop/pws-client` 0.108.0 (dev), which signs a `HEAD` under the
  `GET` action.
- Breaking wire change to `/service`. `serverDid` moves from `instance` to the
  core `https://w3id.org/pws` entry, beside `originId`. There is no alias under
  `instance`. The `https://w3id.org/pws/replication` entry now carries `url`.
  Requires `@interop/storage-core` 0.44.0.
- Register Replica's controller check gains a bootstrap branch. A local Space
  under a `did:key` the source controller's `did:webvh` document does not list
  is admitted when the pull capability is a one-link delegation from the source
  Space's root whose delegation proof a method listed under
  `capabilityDelegation` signs. A re-delegated capability is refused. The source
  controller's document is resolved from the log read through the capability
  when the DID is hosted in the source Space, and otherwise from the copy
  another registration on this server maps, so an auxiliary Space controlled by
  the account DID registers through the account replica's mapping, is promoted
  to that DID through it, and the account registration cannot be removed while
  it is. A log read through the capability is checked against the head this
  server last verified, and decides the check over any stored copy, so a
  replaced capability is admitted when the copy is absent or behind. A refusal
  from a mapped copy says the copy may be behind.
- Delete Space and Delete Collection answer `replica-refused` (409) when they
  would take the only copy of a log another Space's `did:webvh` controller
  resolves from. Delete Collection also refuses for the Space's own controller.
- Move the client devDependency from `@interop/was-client` to
  `@interop/pws-client` 0.104.0. Breaking for `/testing` consumers:
  `provisionWebvhIdentity` takes `owner` as `{ did, pws }`, a `PwsClient`, where
  it took `{ did, was }`.
- Internal: `spacePath` and `collectionPath` return the canonical trailing-slash
  container URL with no option. No wire change.
- The staging Deploy workflow's `wipe_data` option also drops the `public`
  schema of the staging Postgres database and creates it empty, so a manual
  deploy over a schema migration that refuses the stored rows starts over an
  empty store. It connects from the runner with the `staging` environment's new
  `DATABASE_URL` secret, before either wipe, so a database the runner cannot
  reach stops the job with nothing wiped. It leaves the database as it is, with
  a warning, when that secret is unset.
- Breaking for custom backends: `StorageBackend` requires
  `getCollectionMetadataAndLogValidator`, which reads a Collection Metadata
  object with the validator of its governing history log. The Collection prelude
  of the request layer reads through it, and other paths still call
  `getCollectionMetadata`, so a subclass that overrides one overrides both. No
  wire change.
- With Postgres as the control plane, a request that finds its Collection
  through that read makes one fewer round trip. The log's body is read only when
  its descriptors are not cached. A `changes` page restamped from the control
  plane takes one read.

### Fixed

- The `changes` feed builds its `id` URLs and checkpoint scope by resolving
  against the base URL. A `SERVER_URL` ending in a slash no longer doubles the
  slash, which made a replica server skip the Collection's policy documents.
- List Spaces and List Collection serve `type` lexically sorted, as Read Space
  and Read Collection Metadata do.

## 0.45.0 - 2026-10-30

### Added

- The service description lists the Portable Wallet Profile under
  `https://w3id.org/pws/wallet-profile`, version `0.1`, with `version` and `url`
  only. Listing it claims that the core and Encrypted Collections entries carry
  every token the profile requires; a test pins that invariant.
- The core entry's `features` array carries the `encryption` token. The server
  already implemented the Collection `encryption` descriptor (scheme validation,
  set-once rule, key-epoch and `hmac` checks) but did not advertise it.

## 0.44.0 - 2026-10-30

### Added

- The production Deploy workflow snapshots the app's data volume before each
  deploy, and docs/deployment-fly.io.md gains a "Rolling back" section: when a
  dispatch on the previous tag is enough, and when the snapshot restore or a
  wipe is the way back.
- A `pnpm perf:remote --record` run record carries `finished_at`, when the run's
  measurements ended, before it deletes its Spaces, so the minutes from
  `datetime` to it are how long the run took. The record stays `schema` 1:
  `finished_at` is a new member, absent in records made before it.

### Changed

- **Breaking:** the package is renamed to `@interop/web-spaces-server`
  (repository: <https://github.com/interop-alliance/web-spaces-server>). The
  test support entry point is now `@interop/web-spaces-server/testing`.
- **Breaking (`/service` wire change):** the `instance` member advertises the
  server's export-signing key as `exportSigningMethod`, the name the PWS spec
  resolved for its Instance Disclosure list, in place of `exportSigningKey`. The
  value is unchanged, the key's `did:key`. No alias for the old name is served.
  The identity module's signing-key record carries the new field name too; the
  plugin options are unchanged.

### Fixed

- A filesystem layout step that refuses the store (one with no conversion) now
  runs before any pending converting step writes, so a refused boot leaves
  `store.json` and the data dir as the previous release wrote them, and that
  release boots on them again. Before, the converting steps ahead of the refusal
  were applied and stamped first, and the store then booted on neither release.

## 0.43.0 - 2026-10-29

### Changed

- **Breaking (archive wire change):** a provenance statement in an export
  archive's `provenance.jsonl` names the version of the signing DID's document
  that lists the signing key as `didVersionId`, the member the PWS spec's
  Archive provenance section now fixes, in place of `didLogVersionId`. For this
  server's `did:webvh` identity it is the log entry's `versionId`, as the spec's
  `did:webvh` archive signer profile says. The import verifier reads
  `didVersionId` alone: a statement carrying only `didLogVersionId` names no
  version and is counted as `unknownSigner`, so its `createdBy` is dropped.
  Archives written under the old name are not rewritten. The
  `@interop/space-archive` provenance fixture is re-signed under the new member.
- **Archive wire text:** the `url` values in an exported archive's
  `manifest.yml` are the PWS spec's identifier with the defining section's
  anchor as the fragment (`https://w3id.org/pws#spaces`,
  `https://w3id.org/pws#archive-manifest`, ...), as the spec's Space Archive
  Format section fixes them, in place of the rendered document's
  `w3c-ccg.github.io` location. The packer is `@interop/space-archive` 0.11.0.
  Import never reads the values, so archives written under the old host import
  unchanged.

### Added

- The `was-teaching-server/testing` entry point exports the two-server boot the
  replication suites run in one process: `bootPeerServer` (a server over a temp
  backend and a frozen clock, with an identity whose key may invoke, its pull
  loop reaching the other servers through `fastify.inject`, and its timers
  paused), and the pieces it is built from, `provisionServerIdentity`,
  `mintServerDid`, `injectPeerFetch`, `peerLogFetcherOf` and `frozenClock`, with
  the `PeerServer` and `PeerFetch` types, `signedInject`, which signs a request
  as a client would and injects it into a server that never listens, and the
  registration recipe over it, `registerReplica` (delegates the pull capability
  and posts the registration) and `replicaStatus`. `mintServerDid` takes the
  admin key pair as `admin`, a fresh one when omitted, and a `serverUrl` with or
  without its trailing slash. `@interop/ezcap`, which the delegation signs with,
  is a dependency of the package rather than a devDependency. `bootPeerServer`
  takes a bare-origin `serverUrl` (the key both seams look a server up by),
  refuses a second boot at one, and closes its backend when the boot fails after
  opening it. The in-repo suites import them from there, and a test that imports
  only the entry point boots a source and a replica server, registers, and
  pulls. docs/consuming-server-as-library.md documents the helpers under "Two
  servers in one process".
- **Breaking (testing entry point):** `startTestServer` (the
  `was-teaching-server/testing` entry point) returns `baseServerUrl` in place of
  `serverUrl`: the listen origin with its trailing slash, the base under which
  the server serves `service`, `spaces/` and `space/{id}/`, and the value a
  `@interop/was-client` is built from (`new WasClient({ baseServerUrl })`). A
  test that calls a server-internal function taking `serverUrl` reads the
  no-slash form from the returned instance's `fastify.serverUrl`.
  `provisionWebvhIdentity` takes `baseServerUrl` too, and publishes the history
  log through the owner client's `request({ url })`, the shape
  `@interop/was-client` 0.100 gives that escape hatch. The in-repo suites and
  the perf scripts build their clients and URLs from `baseServerUrl`, and a new
  suite asserts the layout the spec's Server Discovery section fixes.
- The conformance suite devDependency is `@interop/pws-conformance-suite`
  0.35.0, the release ported to `@interop/was-client` 0.100.
- `pnpm perf:pg` runs the same local load-performance check as `pnpm perf:fs`
  (see 0.42.2's entry) against the Postgres backend instead, so the two are
  directly comparable. A new `docker-compose.yml` defines a local Postgres
  container matching `pnpm test:pg`'s existing connection convention
  (`postgres://was:was@localhost:5433/was`). `pnpm perf:pg:seed` resets a fixed
  schema (`perf`) and fills it directly through `PostgresBackend`'s own write
  methods; `pnpm perf:pg` always runs against that pre-seeded schema (there is
  no over-HTTP seeding fallback, since seeding Postgres one signed request at a
  time is far slower than writing straight through the backend), and leaves the
  seeded data in place afterward for inspection or reuse.
- `pnpm perf:pg` also runs a payload matrix, reported as its own table: reads
  and writes of a JSON credential, a 100 KiB file and a 10 MiB file in a public,
  a private plaintext and a private encrypted (`edv`) Collection, each counted
  in whole files. `pnpm perf:pg:seed` sets up the encrypted Collection the way
  freewallet does, with a key epoch, a blinded-index key, and real EDV envelopes
  and chunks written through `@interop/was-client` over an in-process server.
  Timed encrypted writes send copies of the stored envelopes and chunks, so
  client-side crypto stays out of the numbers, and binary writes delete their
  files untimed so repeated runs don't fill the database. The seed's new
  `--binary-total-mib` (default 100) adds that much extra binary data in a
  `perf-ballast` Space, to grow the database past Postgres's own cache; `0`
  skips the ballast.
- `pnpm perf:fs` runs the same payload matrix, so the two backends' tables
  compare directly. A fresh run seeds it over signed HTTP against the server
  under test, and `pnpm perf:fs:seed` seeds it through an in-process server and
  records the encrypted read targets' ids in `seed-meta.json`, so a seed dir
  from before this release must be reseeded. No binary ballast is seeded, since
  the filesystem backend's cache is the OS page cache.
- `pnpm perf:fs` and `pnpm perf:fs:seed` default to Collection sizes of 1, 500
  and 2,000 Resources (`--sizes 1,500,2000`), the same as `pnpm perf:pg:seed`,
  so the two backends' default runs cover the same sizes. With the payload
  matrix, the default run now takes about 15 minutes filling fresh (8 from a
  seed), and the full run (`--duration 20 --writes 300`) about 22 (15 from a
  seed).
- Like `pnpm perf:pg`, `pnpm perf:fs` uses the seed `pnpm perf:fs:seed` wrote
  (`.perf-fs-seed`) whenever it exists, with no `--seed-dir` needed. It fills
  fresh over signed HTTP when there is no seed, or when `--sizes` is given.
  `--seed-dir <path>` still names a seed elsewhere, and each run prints which it
  used.
- `pnpm perf:fs` and `pnpm perf:pg` stop whatever listens on their port (4455,
  or `PORT`) before starting their server, instead of refusing to run, naming
  each process they stop. A run also fails as soon as its own server exits:
  before, two runs started together could leave one measuring the other's
  server.
- `pnpm perf:remote --url <https://host>` runs the same load tests against an
  already-deployed server. It spawns no server and fills fresh over signed HTTP
  under a throwaway `did:key`, then deletes the Spaces it created, even when a
  test fails or the run is stopped with Ctrl-C (a second Ctrl-C exits at once,
  skipping the cleanup). The target must allow Space creation (no onboarding
  token). `--payloads` narrows the payload matrix (`json`, `small`, `large`),
  for a machine whose upload is too slow to send 10 MiB within was-client's 10 s
  request timeout, and `--label` titles the report.
- `pnpm perf:remote` measures a host's filesystem and Postgres backends side by
  side in one run. `--split` (default `postgres=50,fs=50`) shares each test's
  Collections among the backends by percent: each test spreads its load
  round-robin over the smallest pool of Collections that realizes the split,
  each created with its backend's fixed id, and the report adds a table per
  backend under each combined one. The run reads the host's backends listing
  first and stops before seeding when the split names a backend the host does
  not list; `--split fs=100` measures one backend alone. `pnpm perf:fs` and
  `pnpm perf:pg` run and report as before.
- The perf runs retry an untimed setup request (a seed write over HTTP, a Space
  or Collection create, a delete test's refill, a serial-write warm-up, and
  `pnpm perf:remote`'s health check) on a network fault, up to eight attempts:
  one that times out, whose connection never opened (undici's
  `UND_ERR_CONNECT_TIMEOUT`), or whose connection closed partway through the
  response (`UND_ERR_SOCKET` or `ECONNRESET`, which fetch reports as
  `terminated`). A response lost on a long network path, or a path that drops
  connections, no longer ends a run. Each fault is found under the `WasError`
  was-client wraps it in. A timed request is still never retried and counts as a
  failure. A delete test's refill now writes 10 at a time instead of every
  client's Resources at once.
- `pnpm perf:remote` reports the error that ends a run with its cause chain and
  the URL it was requesting, e.g.
  `terminated (other side closed, UND_ERR_SOCKET) requesting "https://..."`,
  instead of a bare `terminated` or `fetch failed`. Its report header counts the
  retries the run made, by fault, e.g.
  `Retries of untimed requests after a network fault: 37 (21 timed out, 14 never connected, 2 dropped)`,
  so two runs over the same path can be compared for how much the network got in
  the way.
- `pnpm perf:remote --record <dir> --runner <name>` also writes a completed run
  as a JSON run record at `<dir>/<runner>/<host>/<stamp>.json`: the run's start,
  the target, the server version and build time its `/health` reports, the
  runner and its machine, `--label`, the tooling versions, the load settings,
  and one entry per measurement, the whole test and, on a run split across two
  backends, each backend's part. Size tests are named by stable ids
  (`serial-write` rather than `Write, 1 client (100 in a row)`), so changing
  `--writes` doesn't split a series. A run that fails or is interrupted records
  nothing, and an existing record is never replaced.
- The perf runs' public read and list tests discard the response bodies k6
  reads, so reading the 10 MiB file no longer runs k6 out of memory on a small
  machine; the measured rates are unchanged, since each body is still read in
  full. A k6 killed by a signal is now reported by that signal, instead of as
  "exited with code 1" with no output.
- The perf runs take `--large-file-clients`, which caps the clients of the
  payload matrix's 10 MiB tests (it defaults to `--clients`), so a run fits a
  512 MB machine, where five clients each sending a 10 MiB file ran Node out of
  memory. The report header names the cap.
- Chunk replication. A pull loop that applies a chunked Resource now reads the
  source server's chunk listing, stages each listed chunk it does not hold under
  the `etag` the listing names, and applies the parent and its chunk set in one
  critical section, so the replica never serves an envelope over a partial set
  and the parent reaches the replica's own `changes` feed only with its set.
  Each replicated chunk carries the replica server's own stamp and validator;
  the source server's chunk `ETag` is opaque. A chunk-only mutation on the
  source server replicates with the next parent write. Staging lives in
  `.staging.chunks.<id>/` beside the chunk directory (filesystem layout
  version 6) or the `chunk_staging` table (Postgres); staged bytes count toward
  usage, and a same-size rewrite of a stream fits under the source server's
  quota. Chunk sets are pulled only from a source server whose `/service` lists
  the Encrypted Collections entry, recorded on the registration when it is made;
  a registration made before this release pulls no chunk sets until it is made
  again. Two new stall reasons: `chunk-listing-obsolete` (the Resource is
  rewritten on the source server faster than its chunk set can be pulled) and
  `source-unavailable` (a request inside a chunk pull keeps failing), each after
  a bounded number of cycles stuck on one feed document. The Collection that
  holds the controller's history log is pulled first in every cycle. The chunks
  of a set are read a few at once, the quota pre-check of a set is made by the
  backend when its staging run is opened, and the loop persists its state once
  the chunk pulls since the last persist moved 64 MiB or ran for 16 Resources,
  and at the end of each Collection.
- Each entry of the chunk listing (`GET .../chunks/`) carries `etag`, the `ETag`
  the chunk's own `GET` and `HEAD` serve and its `GET` answers 304 against, so a
  client can pin a `DELETE` of a listed chunk with `If-Match`, or read it
  conditionally, without a `HEAD` per chunk.
- `PUT /space/:spaceId/replicas/:replicaId` creates or replaces a replica
  registration (controller-only). Against a stored registration the body may
  differ in `capability` and `pausedAt` alone; any other difference is
  `invalid-request-body` (400) on that member. It answers 201 with `Location`
  when it creates and 204 when it replaces, takes `If-Match` /
  `If-None-Match: *` (412 on a miss), and carries the new `ETag`. `pausedAt`
  pauses the pull loop: a body that carries it pauses, one that omits it
  resumes, and the server stores its own time. A paused registration has no
  loop, its status `state` reads `paused` with no `nextPullAt`, a resume starts
  a cycle at once with no backoff carried over, and it still maps a peer-hosted
  `did:webvh` controller onto the local log copy. A different `capability` is
  validated as a POST's is and replaces the pull capability in place; the
  registration keeps its id, its loop and its checkpoint, and a cycle in flight
  is followed at once by one under the new capability. A `PUT` that repeats the
  stored body leaves the loop's schedule alone, and no replacement touches the
  Space Metadata object's local segment. `If-Match` is evaluated before the
  fixed members, so a stale conditional write answers 412 rather than 400, and
  once more at the request layer before the peer checks, so it costs the source
  server no read. A resume that lands while the paused registration's last cycle
  is in flight starts a fresh loop rather than being lost, and a create that
  carries `pausedAt` starts no loop by `PUT`, as by POST.

### Fixed

- `pnpm perf:fs` works again: it now passes `@interop/was-client` 0.97 the
  Spaces Repository URL (`<base>/spaces/`) it requires, where it failed at its
  first signed request before.
- The Postgres backend quotes the `schema` option in the connection
  `search_path`, so a mixed-case schema name resolves to the schema `open()`
  creates instead of being folded to lowercase. `pnpm perf:pg` quotes it the
  same way.
- The filesystem backend keeps a Space's zcap revocation records in the
  `.revocations/` subdirectory of its Space dir (filesystem layout version 8,
  whose step moves an existing store's `space-revocations/` trees in), so Delete
  Space is one removal and a process killed during it can no longer leave a live
  Space whose revoked grants verify again. Create Space removes a Space dir a
  killed delete left without its Metadata file before making the new Space, so a
  Space re-created under the id inherits neither the old life's revocations nor
  its Collections. The records now count toward the Space's usage on the
  filesystem backend, as the other Space-level files do; an insert is not
  refused at capacity. `.revocations` is a reserved Collection id (409
  `reserved-id`), listed in `RESERVED_COLLECTION_IDS`.
- An export archive packs a Space's revocation records inside the Space tree, as
  `space/<spaceId>/.revocations/<digest>.json`, in place of the top-level
  `revocations/` directory, and the manifest lists the directory inside the
  Space's contents (`@interop/space-archive` 0.9.0). Import Space reads the
  records from there, and an archive written under the old layout imports with
  no revocation installed.
- The filesystem backend's replica listings log and skip a registration file
  that does not read, so one damaged file no longer fails Read Space or the
  start of every pull loop.

### Changed

- `PostgresBackend` refuses an invalid `schema` option with the new
  `InvalidSchemaNameError` (from `src/errors.ts`) instead of a plain `Error`;
  the message is unchanged. `assertValidSchemaName` throws the same error.
- **Breaking (filesystem store layout 9):** the Space Metadata file is
  `.space.meta.<spaceId>.json` and the Collection Metadata file (live in its
  Collection dir, or a tombstone in the Space dir) is
  `.collection.meta.<collectionId>.json`, on disk and in the export archive,
  following `@interop/space-archive` 0.10.0. The `meta` segment keeps each name
  apart from the Space's or Collection's own policy file for every id, so the
  package no longer reserves the Space id `policy`. There is no conversion step:
  a store holding a Metadata file under an old name is refused at boot with
  `StoreVersionError`, every boot, until it is wiped or each Space is restored
  from an export archive into an empty store.
- Import Space places every archive entry through the archive package's path
  classifier. An entry the layout holds nowhere (a path deeper than the layout
  goes, a directory inside a chunk directory or inside the revocations
  directory) is refused as `invalid-import` (400) when the plan is built, where
  it was previously ignored or keyed into a Collection and refused per file. The
  plan itself is unchanged.
- A replica registration is a versioned record. It carries `updatedAt`,
  `updatedAtCounter` and `originId`, and its `ETag` is the four-segment
  `"<generation>.<ms>.<counter>.<originId>"` instead of the generation alone.
- Backend contract:
  `StorageBackend.writeReplica({ spaceId, record, pullsChunks, createOnly?, ifMatch?, ifNoneMatch? })`
  creates or replaces a registration and resolves `{ stored, prior }`, `prior`
  being the registration it replaced. The pause request is `pausedAt` on
  `record`; the stamp, the pause time, the fixed-member check and the
  preconditions are decided by the shared `decideReplicaWrite` inside the
  write's critical section, and a replacement that keeps the stored capability
  keeps its `pullsChunks`. `createReplica` is the create-only form.
- Filesystem layout version 7 and Postgres schema migration 15 refuse a store
  that holds an unstamped replica registration, on every boot, with no
  conversion. Wipe the data dir or delete the rows, then make each registration
  again.
- The Delete Replica refusal for a controller-mapping registration points to
  `PUT` for pausing or replacing the capability, in place of add-then-remove.
- Consumes `@interop/storage-core` 0.40.0 (the two stall reasons, `pausedAt` and
  the `paused` status state).

## 0.42.3 - 2026-10-26

### Added

- The server's own storage backends are a set, selectable per Collection.
  `WAS_DATA_DIR` configures the filesystem backend and `DATABASE_URL` the
  Postgres backend; a deployment may set both, and `WAS_DEFAULT_BACKEND` (`fs`
  or `postgres`) names the one the `default` id aliases (unset: `fs` when
  configured, else the only one). With neither setting the server refuses to
  start, and so does a default naming an unconfigured backend or two backends
  whose origin ids differ (set `WAS_ORIGIN_ID` to one value). Each backend
  carries a fixed id (`fs`, `postgres`) and `GET /space/:spaceId/backends`, the
  Space Metadata object's `backends` member and the quota report list them: the
  backends listing opens with the `default` alias, then each server backend
  under its fixed id; the quota report has one entry per server backend under
  its fixed id, each enforcing its own per-Space limit. A Collection created
  with `backend.id` naming the non-default server backend has its Resources,
  listings and `changes` feed served there, while its Metadata object, policies
  and log stay on the default backend, with a copy of the Space and Collection
  Metadata objects kept on the selected backend under its own stamp. Export
  Space composes the archive across the backends, and Import Space restores each
  Collection onto the backend its archived Metadata object names, refusing an
  archive naming an unconfigured one with `unsupported-backend` (409) before
  writing anything. Registering an external backend under `default`, `fs` or
  `postgres` is refused. The plugin takes `backends` (a list) beside the
  one-backend `backend`, and `defaultBackend`; it decorates `serverBackends`. An
  Update Collection body naming a backend other than the stored one is refused
  with `backend-immutable` (409, pointer `#/backend`); restating the selection
  under another id of the same backend is stored as sent. The selected backend
  also keeps a copy of the Collection's governing history log, written after
  each log write, so the write-once recheck under its lock reads it, and a copy
  of each Collection- and Resource-level policy, written after every policy
  write and delete, so its `changes` feed holds the Collection's
  `collection-metadata`, `log` and `policy` documents in one position sequence.
  Those documents carry the control plane's stamp and `etag`, the ones a GET of
  each record answers; a policy copy is stored under them, and Import Space
  copies the policies of such a Collection after the default backend's import,
  its Resource policies included. Update Space refreshes the Space copy's
  `controller` and `name`. Delete Collection sweeps the other server backends
  for a copy on every attempt, so a copy a faulted first attempt left behind
  goes on the retry. Import routes an existing Collection's Resources by the
  live object's `backend.id`, and the other backends import before the default
  one, so a fault leaves the default backend untouched. The plugin refuses an
  explicit empty `backends` list instead of opening the fallback filesystem
  backend.
- `WAS_CONTROL_PLANE_BACKEND` (`fs` or `postgres`) names the control plane, the
  server backend that holds every Space and Collection Metadata object, the
  policies, the registrations, keystores and revocations, apart from
  `WAS_DEFAULT_BACKEND`, which keeps naming the data plane of a Collection that
  selects `default` or no backend. Unset, the control plane is `postgres` when
  that backend is configured, else `fs`, so a deployment with both and neither
  setting keeps its records in the database and its Resource bytes on disk. The
  plugin takes `controlPlaneBackend`, and `serverBackends` exposes
  `controlPlane` and `controlPlaneId`. The copies a server backend keeps, the
  export and import composition and the pull loop act on the backends other than
  the control plane. The `did:webvh` resolver reads a history log from the
  backend its Collection selects, so a log Collection on a backend other than
  the control plane, self-hosted or replicated, resolves.
- The replication pull loop replicates a peer Collection into the server backend
  its `backend.id` names here: `default` through this server's alias, a fixed id
  (`fs`, `postgres`) into this deployment's backend of that id. The Collection
  Metadata object keeps the peer's `backend.id` verbatim and lands on the
  control plane with the Collection's policies and log, while its Resource
  content and `/meta` records are applied to the selected backend after the loop
  checks the registration on the control plane; the loop brings that backend's
  copy of the Collection level before the first Resource of a cycle. A
  Collection naming a backend this deployment does not configure, or one
  registered on the peer, stalls as `unsupported-backend` before its Metadata
  object is stored, with the detail naming the id. The copies a non-default
  server backend keeps follow every write of a container object through the
  control plane, the apply path's included, so a replicated Metadata object, log
  or tombstone of a Collection held on that backend reaches its copy; a
  replicated update keeps the held `backend` selection. `applyResource` and
  `applyResourceMetadata` take an optional `replicaId`, as `applyPolicy` does.

### Fixed

- The CI conformance job sets `WAS_DATA_DIR` for each of its two server runs,
  since the server no longer has a default data directory. The conformance suite
  is raised to 0.32.0, whose backends and quota cases accept the `default` alias
  listed beside the backend's fixed id.
- Update Collection composed the object it stored from a read made before the
  backend's lock, so a full replacement racing another write carried forward
  what that read saw: an unconditional rename could drop a just-declared
  `unique` index, or revert a `backend` selection, with a 204 to both writers.
  The composition now runs inside the backend's write, against the record read
  under the lock (`writeCollection` takes a composition callback in place of
  `assertTransition`). A Resource write now reads the Collection's `unique`
  index declarations under the backend's lock instead of taking them from the
  handler (the `uniqueIndexes` write option is gone), and a Collection Metadata
  write runs with no Resource write of the Space in flight (on the filesystem
  backend, the exclusive side of the Space gate), so a write racing a `unique`
  declaration cannot land a duplicate its scan did not see. Since the backend
  evaluates `If-Match` before the composition, a stale validator on Update
  Collection now answers 412 ahead of a refusal the body earns (an unknown
  `backend`, a `plaintext` beside an existing `encryption`), where the body's
  refusal came first before.
- A `unique: true` plaintext index declaration on a Collection stored on a
  registered external backend is refused (409 `unsupported-backend`, pointer
  `#/plaintext/indexes`), as is selecting an external backend on a Collection
  that declares one. The adapter never receives the declaration, so the claim
  went unenforced there.
- Media types on a write. The `application/<suffix>+json` parser ends at the
  media type, so `application/ld+jsonl` and `application/ld+json-seq` are stored
  as byte streams instead of answering 500. The multipart write path matches
  `multipart/form-data` alone, case-insensitively; any other `multipart/*` body
  is stored as a blob. A chunk `PUT` declaring a JSON or text media type is
  stored byte-verbatim (a chunk is a range of a stream, not a document), and an
  empty chunk body under such a type is stored as a zero-byte chunk, as under
  `application/octet-stream`, instead of answering 400. The chunk URL's
  slash-form redirect answers 308 before any parser reads the body. The
  multipart buffer is bounded by the buffered-body limit under every
  `MAX_UPLOAD_BYTES` setting (it fell back to Fastify's 1 MiB default under
  `unlimited`), and its `payload-too-large` names that limit, and the server
  backend when the limit is its `maxUploadBytes`. A multipart create's 201 names
  the stored content type (the file part's), not the request envelope's, and a
  multipart write into an encrypted Collection is checked on the file part, not
  on the `multipart/form-data` envelope. The JSON body parser is registered
  under `@interop/storage-core`'s `JSON_MEDIA_TYPE`, the rule
  `isJsonContentType` decides by.

### Changed

- The conformance suite devDependency is now `@interop/pws-conformance-suite`
  0.33.0 (renamed from `@interop/was-conformance-suite`); its CLI is
  `pws-conformance`, which `pnpm conformance`, `pnpm conformance:local` and CI
  invoke.

- Export archive manifests point at the renamed Portable Web Spaces
  specification (`@interop/space-archive` 0.8.3).
- Codebase-wide cleanup pass with no change in behavior: duplicated logic in the
  two storage backends, the request layer, the authorization path, the
  replication loop and the import/export path now goes through shared helpers
  (`src/lib/jsonBytes.ts`, `src/lib/storageErrors.ts`, `pickStamp`,
  `absoluteUrl`, `verifyRequestZcap`, `withEtag`, `collectionsList`,
  `resolvePublicHost`, among others), and dead branches, nested ternaries and
  unused exports are removed.
- Fewer file opens and queries on hot paths: filesystem JSON metadata reads no
  longer go through `fs-json-store`; revocation checks, replica applies and
  equality scans run their independent reads concurrently; the Postgres equality
  and blinded-index candidate scan is one query that no longer transfers
  non-JSON blob bytes; the Postgres apply guard and governed-log writes use one
  statement each; `List Spaces` filters by controller before sorting.
- `fs-json-store` is no longer a dependency.
- Test helpers and the library-consumer docs follow `@interop/was-client`'s
  convention that `WasClient`'s `serverUrl` is the Spaces Repository URL
  (`<base>/spaces/`). `startTestServer` still returns the base `serverUrl`.
- `pnpm conformance:local` runs the server over a fresh temp data dir, removed
  after the run, instead of the project `data/` directory. An explicit
  `WAS_DATA_DIR` still wins.
- `pnpm run lint` now refuses hand-written copies of the shared helpers
  (`absoluteUrl`, `didOfMethodId`, `isPlainObject`, `pickStamp`, `isEnoent`,
  `asList`, the root-capability prefix) and nested ternaries through
  `no-restricted-syntax`, and runs `jscpd` (`pnpm run lint:dup`) as a copy-paste
  detector over `src/`. A project `.claude/settings.json` hook runs ESLint on
  every `src/` file an agent edits.

## 0.42.2 - 2026-10-09

### Added

- The service description's core entry advertises the `created-by` feature
  token. The server records `createdBy` on every Resource, Collection, and Space
  created under a capability invocation, and the token says so to a client that
  builds on attribution.
- `pnpm perf:fs` runs a local load-performance check of the filesystem backend:
  it starts the server on a fresh temp data dir, fills Collections at each given
  size, measures public and signed reads/writes/deletes (k6 for the public ones,
  `@interop/was-client` for the signed ones), and prints a Markdown report with
  a scaling summary comparing the smallest and largest size. `pnpm perf:fs:seed`
  pre-seeds a reusable data dir directly through the backend's own write
  methods, and `pnpm perf:fs --seed-dir <path>` runs against it instead of
  refilling over signed HTTP every time.

### Changed

- The filesystem backend's per-Space `du` usage snapshot is cached for 20 s
  (`QUOTA_USAGE_CACHE_TTL`, was 5 s).
- ARCHITECTURE.md is now the layer map and glossary alone. The per-module
  behavior descriptions moved verbatim into topic docs under `docs/` (request
  pipeline, validators and stamps, changes feed, governed logs, replication,
  export/import, server identity and provenance, the client-annex clause,
  storage layout, `did:webvh` controllers, service description), each entry in
  ARCHITECTURE.md pointing at its doc. Historical notes about retired behavior
  were dropped. AGENTS.md's roadmap conventions moved into ROADMAP.md's "Item
  format" section, and its conformance and test-helper sections now point at
  README.md and `docs/consuming-server-as-library.md`.
- Delete Resource tombstones the Resource's access-control policy in the same
  critical section, with its own stamp and feed position, so a `PublicCanRead`
  written to publish one record no longer publishes whatever next occupies its
  id, and the policy delete replicates. A Resource-level policy `PUT` is refused
  with the Resource's 404 while the Resource is absent or a tombstone. Before,
  the policy outlived the Resource and could be written for an id not yet used.
- The filesystem backend records the basename of a Resource's or chunk's
  representation file in its `.meta.<id>.json` sidecar as `fileName`. Reads,
  writes and the replication apply path open that name instead of listing the
  Collection directory or deriving the name from `contentType`. Export strips
  `fileName`, and import records the file it writes.
- A filesystem representation file no sidecar names is not a Resource or chunk.
  It reads as absent, and a write over it is a create, even on a write-once
  Collection. A live sidecar that names a missing file answers 500, unless its
  Collection, or a chunk's parent Resource, is being deleted, which reads as
  absent. Delete Chunk removes the sidecar before the file, so a read racing it
  answers 404. A read racing Delete Space can still answer 500.
- A filesystem representation file no live sidecar names, which a crash can
  leave behind, no longer shows up in the Collection listing and its
  `totalItems`, the changes feed, export, the equality query and unique checks,
  or the chunk listing. A delete cut short after its tombstone now reaches the
  changes feed as a delete, where it was reported as a live Resource and did not
  replicate.
- A Resource whose filesystem sidecar does not parse is left out of every
  listing, scan and query, the changes feed and export, with a `warn` line. The
  Resource's own reads and writes still fail on it. A unique value it holds is
  not defended while the sidecar stands damaged, so a write of another Resource
  may take it.
- Filesystem Delete Chunk finds the chunk from its sidecar. A chunk file with no
  sidecar answers 404 and is left in place. A retry of a delete cut short after
  removing the sidecar answers 404 too.
- The filesystem Collection listing reads only the sidecars that fill its page.
  Export reads each sidecar once, and the changes feed reads a tombstone's once.
- The filesystem backend stores a Resource tombstone as `.tombstone.<id>.json`
  instead of under the live sidecar's `.meta.<id>.json` name. Delete Resource
  writes the tombstone, then removes the live sidecar and every file of the id.
  A create over a tombstone writes the live sidecar, then removes the tombstone.
  When a crash leaves both names, the body with the higher `feedPosition` is the
  Resource's state on every path, and the next write or delete of the id removes
  the other. A read opens only the names that can stand: one in a chunk dir, and
  the ones a directory scan listed. A name that does not parse beside one that
  does is read as absent, with a `warn` line, and the next write or delete of
  the id removes it. Archives still carry a tombstone as `.meta.<id>.json`.
- The filesystem Collection listing's `totalItems` counts the ids with a live
  sidecar name and a representation file in the directory listing, and opens no
  sidecar outside the listing page. A tombstone, a file beside it, and a file
  with no sidecar do not count.
- A file a crash left beside a filesystem Resource is reclaimed by the next
  Delete Resource of the id or the next create over its tombstone. Filesystem
  Delete Chunk removes every representation file of the index.
- The byte quota shares one measurement per Space: a write that finds the cached
  figure expired while a measurement is running awaits it.
- The filesystem storage layout advances to version 5. A data dir holding a
  Resource tombstone under the live sidecar name is refused at startup with
  `StoreVersionError`, until it is wiped or restored from an export archive.
  There is no conversion step.
- Import Space checks an archived Collection Metadata file's `id` the way the
  Collection write handlers check a body's: an absent `id` is set from the
  Collection directory the file is stored under, and one naming another
  Collection, or a file that is not a JSON object, refuses the import as
  `invalid-import` (400). Before, the archived object was stored verbatim.
- Import Space installs an archived zcap revocation record only when its
  capability chain verifies under the destination Space and the import's own
  invocation could have submitted it on the revocation route (the controller's
  root invocation, an invoker the chain names, or a delegated `POST` grant that
  reaches the revocation URL). The record's `meta` is rebuilt server-side. A
  record that fails either check is skipped with a `warn` line, an expired one
  silently. The records are installed after the rest of the archive, so a chain
  signed by a `did:webvh` whose log the archive restores verifies. An archive
  with more than 1000 revocation records is `invalid-import` (400). Before, any
  archived `(delegator, capabilityId)` record was installed as the archive
  carried it.
- Import Space applies to an archived Collection Metadata object the shape check
  a Collection Metadata write applies, through the same parser (`name`,
  `encryption`, `plaintext`, `generator`, `revisions`, `epoch`, and the
  `plaintext`/`encryption` exclusion), requires a non-empty string `type` of
  each archived policy, and refuses a Collection Metadata `encryption` or
  `plaintext` beside an archived governing log. Each break is `invalid-import`
  (400) before anything is written.
- The import's encrypted-Collection envelope check derives the effective
  `encryption` from the governing log's head first, as a live write does, so an
  import into or of a log-governed Collection checks its Resources. Before, a
  governed Collection's Resources were not checked.
- A server-side fault met while verifying a submitted revocation's chain
  surfaces as its 5xx rather than as a 400 `invalid-revocation`.
- The filesystem backend's byte-quota usage cache is an `LruCache`
  (`@interop/lru-memoize`), the library behind the Space Metadata and policy
  caches, bounded by `QUOTA_USAGE_CACHE_MAX`. Its TTL counts from the start of a
  measurement rather than its completion.

### Fixed

- Filesystem Delete Chunk invalidates the byte-quota usage cache the same way
  every other free does, so a measurement already running when the chunk was
  deleted no longer caches its pre-delete total.

### Removed

- **BREAKING**: the per-Space Resource count quota. The
  `MAX_RESOURCES_PER_SPACE` setting and the `maxResourcesPerSpace` plugin and
  backend option are gone, and neither backend refuses a Resource create for the
  number of Resources a Space holds. A `MAX_RESOURCES_PER_SPACE` still set in
  the environment is ignored. On the filesystem backend the count listed every
  Collection of the Space each time its cache expired, so its cost grew with the
  Space. The byte quota (`STORAGE_LIMIT_PER_SPACE`) and the
  Spaces-per-controller and Collections-per-Space quotas are unchanged.

## 0.42.1 - 2026-10-05

### Changed

- A `405` method refusal and a `308` slash redirect answer ahead of the
  auth-header and digest hooks. An anonymous `PUT` of a container URL, or an
  unimplemented method at a reserved endpoint, is a `405` with `Allow`, not a
  `401`. `/spaces/` refuses the methods it does not implement, and the bare
  `/spaces` redirects for every container method. `GET /space/:s/backends/:b`,
  `GET /space/:s/meta/log` and an unimplemented method at a chunk URL are `405`
  rather than a `409` `reserved-id` or a `404`. The slash form of a Resource or
  chunk URL redirects for every method the canonical form implements, not only
  `PUT`, and refuses `POST` with the canonical form's `Allow`.
- A path beneath a reserved segment that no route serves, such as
  `GET /space/:s/policy/x`, answers `404` rather than a `409` `reserved-id`. The
  bare `/space/:s/zcaps` is not found, and is no longer redirected to a
  Collection listing. Every URL the server routes, the revocation endpoint, both
  forms of a container URL and of a Resource URL, and the `/kms` keystore URLs
  included, refuses an unimplemented method with a `405` and `Allow`; a
  `DELETE /kms/keystores/:k` was a `404`. The `405` detail no longer names the
  kind of endpoint; it reads `The method is not defined at this URL.` before the
  hint and the `Allow` list.
- Register Replica admits a peer Space whose controller is a `did:webvh` hosted
  in that Space when the local Space's `did:key` controller is listed under
  `capabilityInvocation` in the DID's current document. A Space promoted to its
  `did:webvh` before it gained a replica can now be registered as a source. The
  log is read through the pull capability and verified offline, and the
  registration must pull the log's Collection. A key the document does not list,
  or lists under `capabilityDelegation` alone, is refused with `replica-refused`
  (409).
- Silence request logging for the `/health` probe.
- Update Space refuses with `replica-refused` (409, pointer `#/controller`) a
  controller change that would break a replicated `did:webvh` mapping: a
  promotion under which one of the Space's own replica registrations would pull
  the Collection holding the DID's log beside another local Space's registration
  of the same peer Space, and a change away from a peer-hosted `did:webvh` that
  would leave another Space's controller with no copy of its log. Without it the
  DID resolved from neither copy, or from none, and the Space could not be
  repaired by its controller. The registration, Delete Replica, and Update Space
  checks now read the other Spaces' controllers from storage rather than the
  Space Metadata cache.
- The guarded create of a governing history log is refused with
  `encryption-immutable` (409) on a Collection whose Metadata object carries a
  `plaintext` member. Before, the log landed and every later Metadata write was
  refused by the `plaintext` / `encryption` exclusion rule.
- History-log verification passes no witness proofs on any path. A `did:webvh`
  log that declares witnesses is refused, and the server never fetches
  `did-witness.json`. Before, the self-hosted, append and import paths let the
  library fetch it from the host the log named.
- A Resource's `/meta` `ETag` covers both records its body serves. It is the
  content record's validator, the Resource's own `ETag` value, followed by the
  `/meta` record's validator once metadata has been written. A content write now
  moves it, and it is present from the Resource's first write. `PUT /meta`
  evaluates `If-Match` against it and answers with it, and the changes feed's
  `metaEtag` carries it.
- A Collection Metadata read takes the object before the governing log. A read
  racing a log append could serve the new `ETag` with the old derived
  descriptors, and conditional reads then answered 304 over them.

## 0.42.0 - 2026-10-04

### Added

- A `did:webvh` hosted on a replication peer resolves from storage.
  `did:webvh:<scid>:<H>:space:<S>:<C>` resolves from a local copy, with no
  network fetch, when exactly one local Space holds a replica registration whose
  `fromSpace` is `https://H/space/S/` and which pulls Collection `C`. The log
  goes through the same verification, cache and fast-forward rules as a
  self-hosted one. Two or more local Spaces mapping the DID means it does not
  resolve from storage. Such a DID may be a Space controller, a keystore
  controller, a delegator and a `createdBy`. A key retired at the origin stops
  authorizing after the next pull.
- Two guards keep such a DID resolvable. Register Replica refuses, with
  `replica-refused` (409), a registration when another local Space already
  replicates the same peer Space with a Collection in common. Delete Replica
  refuses, with the same type, to remove the only registration that maps a local
  Space's `did:webvh` controller to a copy of its log.
- `WAS_WEBVH_BLOCKLIST` and the `webvhBlocklist` plugin option. A
  comma-separated list of host names or full `did:webvh` DIDs whose log is never
  fetched. A blocked DID is refused before any fetch with the masked
  `not-found`. A malformed entry refuses startup. It covers the network path
  only.
- Replica registrations. `POST /space/:spaceId/replicas` registers one source
  peer of a Space: `id`, `fromSpace`, `toSpace`, `capability`, an optional
  `collections` list and `role` (`source`). `GET` there lists the records as
  `{ url, totalItems, items }`. `GET` and `DELETE` of
  `/space/:spaceId/replicas/:replicaId` read and remove one. Every method is
  controller-only. A record goes with Delete Space, and is not exported.
- A registration is checked against the peer before it is stored. The peer must
  list the replication specification and an `originId` that is not this
  server's, and the peer Space must have the local Space's `controller` and
  `type` set. A refusal is the new `replica-refused` problem type (409). A
  malformed body is `invalid-request-body` (400).
- A pull loop per registration. It reads the peer Space's Metadata object,
  policy and Collection listing, then each selected Collection's changes feed,
  and stores every record under the peer's write stamp and generation, so a
  replicated Resource has the same bytes, `ETag` and `updatedAt` on both
  servers. A record is applied when its stamp is greater than the held one. A
  history log fast-forwards. A Collection delete removes its members whatever
  their stamps.
- `GET /space/:spaceId/replicas/:replicaId/status` serves a loop's state, its
  pull times, and one item per Collection. A stalled Collection carries a
  `stall` with a `reason` from `clock-bound`, `fork`, `quota-exceeded`,
  `unsupported-backend` and `container-refused`.
- A read-only form of the `changes` query profile:
  `GET /space/:spaceId/:collectionId/query?profile=changes`, with `checkpoint`
  and `limit` in the query string, verified under the `GET` action.
- The Space Metadata object carries a server-derived `replicas` member, each
  registration's `fromSpace`, `toSpace` and `role`. The Space linkset lists the
  registrations under `https://w3id.org/pws#replicas`.
- The Collection Metadata object carries a server-managed `created` member, the
  write stamp of the write that created the Collection.
- `/service` lists the replication specification,
  `https://w3id.org/pws/replication`, at version `0.1`.
- Plugin options `peerFetch` and `replicationPullIntervalMs`.

### Changed

- Any `did:webvh` on another host may invoke a delegated capability, under any
  path or none. Before, only a peer server's own DID could. The log is fetched
  from the URL the did:webvh method maps the DID to. Such a DID cannot sign a
  delegation link and cannot be a controller. All fetch bounds are unchanged,
  and a DID whose host carries a port, or is an IP address, is refused.
- `createdBy` now records a foreign `did:webvh` that invoked over the network.
- A `did.jsonl` that declares witnesses is refused when it is a replicated log
  or is appended to a log that is not self-hosted.
- **BREAKING**: `replicas` and `zcaps` are reserved Collection ids. Creating a
  Collection under either answers `reserved-id` (409).
- `GET /space/:spaceId/:collectionId/query` no longer answers 405.
- `@interop/http-signature-zcap-invoke` is a runtime dependency. The pull loop
  signs its reads of a peer with it.

- **BREAKING**: an access-control policy is a versioned record at all three
  levels. Get Policy serves `updatedAt`, `updatedAtCounter` and `originId`
  beside the policy body, and the four-segment `ETag`. A conditional read is
  answered 304. A `PUT` body's stamp members and `deleted` are ignored.
- `PUT` and `DELETE .../policy` take `If-Match` and `If-None-Match: *` (412
  otherwise). `PUT` answers `201` or `204` with the new `ETag`, from the
  backend's decision under its lock.
- **BREAKING**: Delete Policy leaves a tombstone, `deleted: true` plus the
  delete's write stamp, and answers `204` with its `ETag`. A tombstone grants
  nothing and Get Policy answers it `404`, the same as no policy.
  `GET .../policy?include=deleted` answers it `200` with its `ETag`. A `PUT`
  over a tombstone creates the policy under a new generation. Deleting an absent
  or already deleted policy writes nothing.
- A Collection or Resource policy write or delete takes a feed position. The
  `changes` feed carries it as a `kind: 'policy'` document whose `id` is the
  policy's absolute URL, with `deleted: true` on a tombstone.
- Export carries live policies only, each with its stamp members and
  `_generation`. Import keeps the archived generation, re-stamps the policy, and
  skips a level where the destination holds a tombstone. An archived policy
  tombstone refuses the import as `invalid-import` (400).
- **BREAKING**: a store holding policies written before this release is refused
  at startup with `StoreVersionError`. The filesystem layout moves to version 3,
  which refuses a data directory holding any policy file. Postgres schema
  migration 12 refuses a `policies` table holding any row, then adds the stamp,
  `generation`, `deleted` and `feed_position` columns. Wipe the store, or
  restore each Space from an export archive.
- A Collection or Resource policy file on the filesystem backend carries its own
  `changes` feed position as a reserved `_feedPosition` member. A `PUT` body's
  `_feedPosition` is not stored, no policy read serves it, export strips it, and
  import assigns a fresh position.
- The filesystem feed counter file is `{ generation, position, records }`, with
  the Collection Metadata object's and the log's positions under `records`. Its
  size no longer depends on how many policies the Collection holds. A caught-up
  `changes` poll reads the counter file alone.
- **BREAKING**: the filesystem layout moves to version 4, which refuses a data
  directory holding any feed counter file or any Collection- or Resource-level
  policy file, with `StoreVersionError` on every boot. A Space policy alone
  passes. Wipe the store, or restore each Space from an export archive.

### Fixed

- A conditional `GET` of a Resource or a chunk that answered 304 went on to open
  the byte stream and send a second time. The 304 reached the client, and the
  server logged `FST_ERR_REP_ALREADY_SENT`. The handler now stops at the 304.
- A create admitted by a provisioning grant records no `createdBy`. Create Space
  by Id could record one taken from an unverified `Signature` `keyId`, when a
  Space deleted after the provisioning gate's check sent the request to the
  policy late and a custom `authorizeProvisioning` granted it.

## 0.41.1 - 2026-10-04

### Fixed

- Widen the import-reservation test's quota margin for block-counted `du`.

## 0.41.0 - 2026-10-04

### Changed

- **BREAKING**: the `changes` query profile carries every record of the
  Collection. Each document has a required `kind`: `resource`,
  `collection-metadata`, or `log`. A consumer skips a `kind` it does not know.
- **BREAKING**: the change document's `_deleted` member is renamed `deleted`.
- The feed carries every Resource and tombstone whatever its content type, each
  with a `contentType` member. `data` is inline for a live JSON Resource only.
- A Collection Metadata write and a governed-log write each take a feed
  position. Their documents carry the record's absolute URL as `id` and no body.
  A new Collection's feed therefore starts with its `collection-metadata`
  document.
- Every change document carries the record's `generation` beside its write stamp
  and `etag`.
- Postgres schema migration 11 adds `collections.metadata_feed_position` and
  `collections.log_feed_position`. The filesystem feed counter file gains
  `collectionMetadataPosition` and `logPosition`.
- **BREAKING**: Create or Update Resource (`PUT /space/:s/:c/:id`) answers `201`
  when it created the Resource and `200` when it updated it, in place of `204`.
  Update Resource Metadata (`PUT .../:id/meta`) answers `200`. Both send a JSON
  body of server-managed members: `contentType`, `size`, and the content
  record's write stamp. A `201` adds `createdAt` and `createdBy`, and a `/meta`
  write adds the nested `meta` stamp. A write-once repeat answers `200`.
- **BREAKING**: a Resource re-created over a tombstone records this write's
  invoker as `createdBy` and its time as `createdAt`. Both backends used to keep
  the tombstone's values.
- Create Space, Create Collection, and a create by `PUT` of a container's `meta`
  answer with the stored object the write returns. The `201` or `204` of a `PUT`
  comes from the backend's create-or-update decision under its lock, so of two
  racing unconditional creates of one Collection only one answers `201`.
- **BREAKING** for custom backends: `StorageBackend.writeResource` returns
  `ResourceWriteResult` (`validator`, `created`, `members`) and
  `writeResourceMetadata` returns `validator` and `members`, or `undefined`.
  `writeSpace` and `writeCollection` return `MetadataWriteResult` (`validator`,
  `created`, `metadata`). Each used to return the validator alone.
- `provisionWebvhIdentity()` in `was-teaching-server/testing` expects `201` from
  the log `PUT`.

## 0.40.0 - 2026-10-04

### Added

- Write stamps. Each storage backend holds one hybrid logical clock per store.
  Every versioned write mints its stamp inside its critical section as
  `max(now, held stamp + one counter tick)`. Every versioned record stores the
  stamp as `updatedAt`, `updatedAtCounter`, and `originId`: Resource content, a
  chunk, a Resource's `/meta` record, the Space and Collection Metadata objects,
  and a governing history log. A Resource's `/meta` record carries its stamp and
  generation as one nested
  `meta: { updatedAt, updatedAtCounter, originId, generation }` object. The
  Space Metadata object now serves `updatedAt`, `updatedAtCounter`, and
  `originId`.

- The clock's physical part is persisted as `clockHighWater` in the filesystem
  `store.json` and as `store.clock_high_water` in Postgres, at most about once a
  second and again on `close()`, and seeds the clock at boot. A failed write of
  the mark is logged and does not fail the request. `FileSystemBackend` gains a
  `close()` method.

- `WAS_REPLICATION_CLOCK_BOUND_MS` (default 60000): how far ahead of physical
  time a write stamp received from a peer may be dated. No request path receives
  one yet. The plugin takes it as `replicationClockBoundMs`. The plugin,
  `startTestServer()`, and `openTempBackend()` take a `physicalClock` option, so
  a test can freeze or step the clock.

- A per-store origin id, the origin half of a write's replicated identity.
  `WAS_ORIGIN_ID` sets it verbatim (`[A-Za-z0-9_-]{1,64}`); unset, the store
  mints a random base58 id on first boot and keeps it. Stored as `originId` in
  the filesystem data dir's `store.json` and in the Postgres `store` table. A
  set value that differs from the stored id refuses startup. `/service`
  advertises it as `originId` on the core `https://w3id.org/pws` entry.

- Writer attribution (spec `#writer-attribution`): an optional `Writer-Id`
  request header on content writes and `DELETE`, stored as the Resource Metadata
  `writerId` property and echoed on `/meta` reads, listing item summaries, the
  `changes` feed, and tombstones. Declare-or-clear on content writes and
  deletes; a present but empty or non-string value is `invalid-request-body`. A
  metadata write leaves it untouched, and a `writerId` member in an Update
  Resource Metadata body is ignored. The value is never verified, computed, or
  used in any authorization decision.

- Server identity, the first half of authenticated export provenance. The server
  derives an Ed25519 export-signing key from `WAS_SERVER_KEY_SEED` and
  advertises it on the `/service` document's `instance` member as
  `exportSigningKey` (a `did:key`). With `WAS_ADMIN_DID` set, it provisions the
  `server` Space at startup under that admin `did:key`, typed
  `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`. The Space id `server` is
  reserved on every client create (`reserved-id`, 409), configured or not, and a
  client create naming `ServerInstanceSpace` is `invalid-request-body`. The
  server's own DID is the self-hosted `did:webvh:{scid}:{host}:space:server:id`,
  whose log the admin writes at `/space/server/id/did.jsonl` with the server key
  as a verification method under `assertionMethod` only. Once that log resolves
  and lists the key that way, `instance` also carries the DID as `serverDid`; a
  log listing the key under any other relationship, or not at all, withdraws it.

- Signed export provenance. While the server DID is advertised, Export Space
  adds two root entries to the archive: `provenance.jsonl`, one
  `StorageAttestation` statement per exported object (the Space Metadata object,
  each Collection Metadata object, each Resource), and `did.jsonl`, the server's
  history log snapshot as served. A statement is
  `{ id, type, createdBy, createdAt, updatedAt, updatedAtCounter, originId, meta, digest, didLogVersionId }`:
  `id` is the object's URL, the three stamp members its write stamp, `meta` a
  Resource's `/meta` record stamp and generation, and `digest` the `mh=` sha-256
  multihash of its archived content (a chunked Resource digests the JCS array of
  its chunk digests). A Metadata statement carries no `meta` and no `digest`.
  Each carries one `eddsa-jcs-2022` proof (`assertionMethod`, no `created`) by
  the export-signing key, named `{serverDid}#{publicKeyMultibase}`. Without an
  identity the export carries neither entry and the server logs one `warn` line
  per export.

- Import Space verifies export provenance. The archive's `did.jsonl` must verify
  offline as the history log of the DID its head names; any server DID whose log
  verifies is accepted. Each statement's method is resolved at the log version
  its `didLogVersionId` names and must sit under `assertionMethod` alone. Then
  its proof is verified and its claims (stamps included) and `digest` are
  compared with the archived bytes. An object outside `verified` is still
  imported, with its `createdBy` dropped; a tombstone's `createdBy` is always
  dropped. `ImportStats` gains `provenance`, counting `verified`, `unattested`,
  `proofInvalid`, `contentMismatch`, and `unknownSigner` objects. A
  `proofInvalid` and a `contentMismatch` are logged apart at `warn`.

- Admin runbooks for the server identity log in `docs/admin-guide.md`, written
  as `di` (`@interop/did-cli`) command sequences: provisioning, seed rotation,
  update-key rotation, restore after a data wipe, and compromise recovery for
  each secret. The log's update key is a CLI-managed key with pre-rotation
  armed, distinct from the admin `did:key` that controls the `server` Space and
  signs the `PUT`; the admin never holds the server seed. The `id` Collection is
  published world-readable so resolvers and the CLI's fast-forward check read
  the served log. A test drives the runbooks against an in-process server
  through the `di` binary.

- The filesystem backend versions its storage layout. The data root holds
  `store.json` with an integer `version`, and the backend applies pending layout
  migrations at startup, under a lock file, before it serves requests. An empty
  data dir is stamped with the current version. One that holds data but no
  `store.json` is taken as the baseline layout and migrated forward.

- `@digitalcredentials/bnid` is replaced by its maintained fork `@interop/bnid`
  (same API).

- Depends on `@interop/space-archive` 0.5.0, which carries the provenance root
  entries.

- Depends on `@interop/storage-core` 0.24.0, whose `ImportStats` carries
  `provenance`.

- Import Space no longer restores a `createdBy` its archive does not attest. An
  archive exported without provenance, by an older release or by a server with
  no identity, imports with no `createdBy` on any object.

- The filesystem backend refuses to start when `store.json` names a newer
  version than the server knows.
- The Postgres backend refuses to start when its `schema_migrations` table
  records a newer version than the server knows, as after a rollback to an older
  build. It logs the schema version at startup.
- The provisioning gate (`WAS_ONBOARDING_TOKEN` / `authorizeProvisioning`) now
  covers Create Space by Id: a `PUT /space/:spaceId/meta` that creates a Space
  needs the token (or the policy's `grant`), as `POST /spaces/` does. An update
  of an existing Space is not gated. Before, a self-signed `PUT` created a Space
  with no token.
- An `authorizeProvisioning` decision other than `grant`, `deny`, or `verify` is
  refused as `deny`.
- A set but empty or whitespace-only `WAS_ONBOARDING_TOKEN` is a startup error,
  and an empty `onboardingToken` plugin option fails registration. Unset still
  means open provisioning.
- The JSON content-type check comes from `@interop/storage-core` (0.21.0) as
  `isJsonContentType`, the rule was-client shares. The local `isJson` helper is
  removed.
- Small wire corrections from the whole-codebase review:
  - The service description's `zcapCryptosuites` lists Data Integrity
    cryptosuite names only (`['eddsa-jcs-2022']`). `Ed25519Signature2020`
    delegation proofs are still verified, just no longer advertised there.
  - A 304 on an implicitly-HEAD route no longer sends `Content-Length: 0`.
  - A governed history log is refused as `invalid-request-body` (400) when its
    genesis carries no string `parameters.method` or any entry `state` carries a
    `history` member; the served `encryption.history` is always stamped. A `PUT`
    of the stored log bytes unchanged is a no-op 204 instead of a 400.
  - `PUT /space/:spaceId/meta` on an existing Space is a full replacement of the
    user-writable members: an omitted `name` is removed.
  - Create Space stores and echoes only `id`, `type`, `controller` and `name`; a
    client-supplied `createdBy` or unknown member is dropped on the token path
    too.
  - `filter[__proto__]=v` on the equality query answers the documented 400.
  - A unique-index claim on an absent Resource's `/meta` answers 404, not 409.
  - Docs: the backend contract text for `getResource`, the precondition order
    comments, the `declaredBytes` note, the chunk listing `count`, the quota
    rows (chunks and auxiliary Spaces), the single-instance assumption behind
    the metadata and policy cache TTLs, and `allowTargetQuery`.

- `fastifyWas` / `createApp` options `ownsBackend` and `cors`. With
  `ownsBackend: false` the plugin leaves the backend's `logger` and `close()` to
  the composition; it requires an injected, already open `backend`.
  `cors: false` skips `@fastify/cors`, and a `cors` object overrides `origin`
  and/or `methods`; a member set to `undefined` keeps the default.

- A `was-teaching-server/testing` entry point for consumer tests.
  `startTestServer()` boots `createApp()` on an OS-assigned port and returns its
  `http://localhost:<port>` `serverUrl`. `openTempBackend()` opens a
  `FileSystemBackend` on a fresh temp dir that its `close()` removes.
  `provisionWebvhIdentity()` mints and publishes a self-hosted `did:webvh` in a
  new Space. `webvhLogSigner()` builds a history-log signer from a `did:key` key
  pair. The entry point imports no test runner.

- Request fault injection on the `was-teaching-server/testing` entry point.
  `startTestServer()` also returns `faults`, a `RequestFaults` that records
  every request (`method`, `path`, invoking `did`, `status`) and arms faults on
  a matching one. `refuse()` answers it with a chosen status before any handler
  runs. `dropResponse()` lets it be applied and closes the connection in place
  of the response. `hold()` pauses it until released. The tears take `times`,
  for a client that retries. A fault disarmed before a request took it rejects
  its promise with `RequestFaultDisarmedError`. The hooks run ahead of every
  route group's own, and the plugin's options are unchanged.

- The Collection Metadata object's optional `revisions` descriptor: `resolution`
  (only `last-writer-wins`, the default), `immutable` (boolean, default
  `false`), and `merge` (an object served verbatim and not read). An unknown
  `resolution` (`keep-conflicts` included), a wrong member type, or an unknown
  member is `invalid-request-body` (400). `resolution` and `immutable` are
  declared by the write that creates the Collection and are immutable afterward.
  An absent member stands for its default, so restating a default passes.
  Setting `immutable: true` on an existing Collection, or dropping or changing
  it, is `revisions-immutable` (409). On a log-governed Collection the
  descriptor is derived from the head `state.revisions` slot, which the derived
  `encryption` member no longer carries, and a log append runs the same check. A
  governing log's guarded create may move a member off its default. A direct
  `PUT .../meta` whose `revisions.merge` differs from the derived one is
  `revisions-immutable` (409), and the stored `revisions` member is carried
  forward untouched. Import runs the shape check on an archived `revisions`
  member, and checks it against the archived governing log's head, refusing a
  break as `invalid-import` (400).

- On an `immutable` Collection, a Resource or chunk write over a live one is
  refused with `resource-immutable` (409), unless its media type and bytes equal
  the stored ones. The media type is compared without parameters and
  case-insensitively. That repeat writes nothing and answers the current `ETag`.
  A repeat over a Resource whose sidecar was torn from its bytes stamps the
  sidecar instead of failing. The rule is decided before the unique-claim scans.
  A write over a tombstone is a create. A governing log's guarded create can
  declare `immutable` on an existing Collection, so the backend rechecks it
  inside the write's critical section. Delete, Resource `/meta` writes, and
  imports are not restricted. `StorageBackend.writeResource` and `writeChunk`
  take an `immutable` option, the flag or a recheck callback. Requires
  `@interop/storage-core` 0.30.0.

- Collection tombstones. Delete Collection keeps the Collection Metadata record,
  marked `deleted: true`, with its generation and a fresh write stamp, and still
  removes the Resources, chunks, policies, governing log, and feed counter. A
  tombstone reads as absent everywhere else: Read Collection, writes into it,
  `id-conflict`, the Collection count quota, `totalItems`, and import's
  existence check. A create over it mints a new generation and a stamp above the
  tombstone's, and inherits nothing from the old life. Tombstones are never
  reaped. Delete Space still removes everything.
- The Space listing takes `?include=deleted`, honored only under a verified
  capability. Tombstoned Collections are then listed as
  `{ id, url, deleted: true, updatedAt, updatedAtCounter, originId }`, counted
  in `totalItems`, and the `next` link carries the flag. A listing served by a
  public-read policy ignores it. `StorageBackend.listCollections` takes
  `includeDeleted`.
- Export writes a tombstone as `.collection.<id>.json` in the Space directory
  with no Collection directory, flagged on the manifest. Import writes it only
  when the destination holds no record under that id, keeping the archived
  generation and re-stamping it. An archive holding one Collection both ways is
  `invalid-import` (400), and so is a `deleted: true` body inside a Collection
  directory. A tombstone gets no provenance statement.
- The filesystem backend keeps a tombstone as the Collection's
  `.collection.<id>.json` in its emptied directory, written before the members
  are removed. A delete cut short is finished at boot, on the next read of the
  Collection, by a retried delete, or by a create over it. The Postgres backend
  keeps the `collections` row with a new `deleted` column (schema migration 10)
  and deletes in one transaction.
- Requires `@interop/storage-core` 0.31.0 (`CollectionTombstoneSummary`) and
  `@interop/space-archive` 0.7.0 (the tombstone archive form).

- A server resolves a peer server's `did:webvh`
  (`did:webvh:<scid>:<host>:space:server:id`) over the network, only as the
  invoker of a delegated capability on the PWS routes. The embedded delegation
  chain must first verify to the Space controller with local resolution, and the
  invoked capability's sole `controller` must be that DID. The log is fetched
  from `https://<host>/space/server/id/did.jsonl` and verified. It must extend
  the last verified head, and a witnessed log is refused. Documents are cached
  per DID with a TTL. Fetches are bounded by size, timeout, a per-host window,
  an in-flight limit, and a short failure memory. The default fetcher uses
  `https` on the default port, follows no redirect, and connects only to public
  addresses. The `peerLogFetcher` plugin and `createApp` option replaces it in
  tests. The `PEER_WEBVH_*` constants in `config.default.ts` set the bounds.

- `loadSyncSigner` returns a signer for the server's sync invocations, the seed
  key as `{serverDid}#{publicKeyMultibase}`, when the server's log lists the key
  under `capabilityInvocation`. Otherwise it returns a refusal with a reason.

### Changed

- Delete Collection of an already deleted Collection answers the masked
  `not-found` (404) and writes nothing. An id never used still answers 204.
  `StorageBackend.deleteCollection` resolves `deleted`, `already-deleted`, or
  `absent`. On the filesystem, a Collection directory left without a Metadata
  file is removed by a delete.

- The `ETag` is `"<generation>.<ms>.<counter>.<originId>"`, from the record's
  generation and write stamp, with `ms` the stamp's `updatedAt` in epoch
  milliseconds. A Space or Collection Metadata object adds a fifth, local
  segment, stored as `_local` (Postgres `meta_local`) and left out of exports. A
  backend registration or removal and a governed-log write advance it and mint
  no stamp. A stamped write resets it to 0. `If-Match` and `If-None-Match`
  compare the whole string. This is a wire-contract change.

- A `/meta` write mints only the `/meta` record's stamp. The content stamp, the
  content `ETag`, and `writerId` are untouched.

- `changes` documents carry `updatedAtCounter`, `originId`, and the nested
  `meta` beside `updatedAt`.

- Import re-stamps every record it writes with the importing server's clock and
  origin id. The archived stamps are read for provenance verification only, and
  the archived generations are kept. An archived generation that is not a base58
  string is replaced with a fresh one, and a chunk archived without a usable
  sidecar gets a fresh one on both backends.

- The Create Space and Create Collection responses, and the create-by-`PUT` of a
  container's `meta`, return the same object a read serves, stamp members
  included.

- A filesystem data dir or Postgres schema that holds any Space from before
  write stamps is refused at boot with `StoreVersionError`. There is no
  migration. To upgrade, wipe the store. The Postgres backend adds the columns
  `updated_at_counter`, `origin_id`, `meta_updated_at`,
  `meta_updated_at_counter`, `meta_origin_id`, `meta_local`, `log_updated_at`,
  `log_updated_at_counter`, and `log_origin_id`, and `store.clock_high_water`,
  and drops `version`, `meta_version`, and `log_version`.

- One server process per store is now an assumption the write stamps rest on,
  beside the read caches. Two processes over one store would share its origin id
  and could mint the same stamp for two different writes.

- The startup warning for an export-signing key no server DID lists is logged
  once the server is listening, and reads `serverUrl` then. An app that never
  listens (`inject()` only) does not log it.

- `FileSystemBackend` and `PostgresBackend` are obtained from a static async
  `open()` factory, which runs the store migrations and settles the origin id
  before it resolves; their constructors are protected and
  `StorageBackend.init()` is gone. `originId` is a plain member, with no "read
  before init" throw. `defaultBackend()` is async, and the plugin's
  `ownsBackend` lifecycle wires `close()` only. A composition that constructed a
  backend and called `init()` now awaits `open()` instead. `open()` returns the
  type of the class it is called on, and `PostgresBackend.open()` reports the
  open failure even when ending the pool also fails.

- The `fastifyWas` / `createApp` `backend` option also accepts a function,
  `({ logger }) => Promise<StorageBackend>`. The plugin calls it at
  registration, after validating its other options, with `fastify.log`, so the
  backend's startup work logs through the app logger and a refused option leaves
  the store untouched. The plugin closes that backend with the app, so the
  function form is refused with `ownsBackend: false`. The server entry point
  hands the Postgres backend over this way. The plugin also refuses, at
  registration, a backend with no origin id (one that did not come from
  `open()`), after wiring its `close()`, so a failed registration still releases
  it.

- `serverUrl` is a required `fastifyWas` / `createApp` option, refused at
  registration when missing. `assertValidServerUrl` also rejects a URL carrying
  userinfo (`user:pass@`). The code paths for an app with no `serverUrl` are
  gone: `/service`, the `service` link and linkset entry, and an export's
  `service.json` are always present.

- The default CORS registration no longer lists `PATCH`, which no route serves.

- A trailing-slash `serverUrl` no longer yields a doubled slash in the governed
  log URL (`encryption.history.resource`) or in a minted exchange URL.

- List Spaces lists auxiliary Spaces (typed `AuxiliarySpace`) like any other
  Space, and `totalItems` counts them. They count toward
  `MAX_SPACES_PER_CONTROLLER`, so a controller can now see what uses its quota.
  Every item carries the Space's `type` array. This is a wire-contract change.

- The Import Space handler now decodes the archive, builds its merge plan, and
  judges its provenance once, before the backend is called. The backend
  `importSpace` contract takes that plan and the provenance counts in place of a
  tar stream, and only persists what it is handed.

- The provenance statement contract (the statement type, the attested members,
  the server-managed member reading, and the file and chunked digests) moved
  into its own module, shared by export signing and import verification.

- The filesystem backend no longer substitutes a file's stat times for a
  Resource's missing `createdAt` / `updatedAt`; Read Resource Metadata omits
  them instead. Such a Resource has no changes-feed position and is left out of
  the feed. A `/meta` write on one takes its own time as `createdAt` rather than
  the file's birth time.

- The `changes` feed is ordered by a per-Collection feed position instead of the
  `(updatedAt, id)` keyset, which skipped writes that shared a millisecond with
  a checkpoint. Every content write, metadata write, soft delete, and imported
  Resource takes the Collection's next position, assigned inside the
  per-Collection critical section that makes the write visible. A chunk write
  takes none. A Resource imported with no metadata entry, or with one that is
  not a JSON object, gets fresh metadata on both backends: `createdAt` and a
  write stamp at import time, a new generation, and no `createdBy`. This is a
  wire-contract change:
  - The checkpoint is an opaque string, scoped to this server and Collection and
    to one life of the Collection's feed. A client compares it by equality only
    and echoes it back verbatim. A checkpoint issued before the Collection was
    deleted and re-created under the same id, by hand or by an import, is
    refused like a foreign one, since the re-created feed restarts at 1.
  - Each feed document carries `checkpoint`, the checkpoint that resumes right
    after it. The page's `checkpoint` is its last document's, or `null`.
  - A checkpoint this server did not issue for the Collection, including the
    retired `{ id, updatedAt }` object, is refused with `invalid-request-body`
    (400) at `#/checkpoint`. A replica restarts its pull from the beginning.
  - The write stamp on each document orders revisions of one Resource. It does
    not order the feed.

  The filesystem backend keeps the counter and its generation in
  `.feed.<collectionId>.json` in the Collection dir and the position in each
  sidecar's `feedPosition`; the Postgres backend adds
  `collections.feed_position` (the counter), `collections.feed_generation`, and
  `resources.feed_position` (schema version 7). The position never leaves the
  server: export strips it, and import assigns fresh ones. Depends on
  `@interop/storage-core` 0.26.0, whose `ChangesCheckpoint` is a string and
  whose `ChangeDocument` carries `checkpoint`.

- A log-governed Collection's served `encryption` member is derived from its
  history log once per log version and memoized per backend, keyed by the log's
  `ETag`. The log body is still read on each request. Only the parse is saved.
  Delete Collection, Delete Space, and Import Space drop the affected entries.
  New settings `GOVERNED_DESCRIPTORS_CACHE_TTL` (600 s) and
  `GOVERNED_DESCRIPTORS_CACHE_MAX` (1000) in `config.default.ts`.

- The `assertTransition` callback of `StorageBackend.writeCollection` now
  receives `{ prior, log }`: the prior Collection Metadata object and the
  governing history log, both read under the backend's lock. Update Collection
  derives the governed descriptor for its recheck from that log instead of
  reading it again. On Postgres the log columns come from the
  `SELECT ... FOR UPDATE` that already locks the Collection row, so the recheck
  issues no second query. This is a backend contract change.

- The server's seed key may be listed under `capabilityInvocation` as well as
  `assertionMethod`. `capabilityDelegation`, `authentication` and `keyAgreement`
  are still refused. This applies to `/service`, export signing and the import
  statement check. The admin guide gains an "Enabling replication" section and a
  changed `--purpose` step.

### Removed

- The `version` and `metaVersion` counters, from sidecars, rows, Metadata files
  (`_version`, Postgres `meta_version`), and wire objects, the `changes`
  documents and provenance statements included.
- The validator members (`generation`, `version`) on chunk listing items.

### Fixed

- A Space-scoped revocation insert racing a Delete Space no longer leaves a
  record that the next Space under the same id inherits. Both backends re-check
  the Space Metadata object under the lock Delete Space takes. An insert under a
  Space with no Metadata object is now the masked 404, not a 500.
- A storage fault met while verifying a delegated chain now answers 5xx. A
  failed revocation lookup, or a failed read of a delegator's `did:webvh` log,
  used to answer the masked 404, which a client read as a denial.

## 0.39.0 - 2026-09-28

### Added

- A production `Dockerfile`, an example Fly.io `fly.toml`, and two deploy
  workflows. One deploys to a staging app after CI passes on `main`, the other
  to production when a GitHub release is published. Each takes the app name and
  `SERVER_URL` from its GitHub environment's variables.
  `docs/deployment-fly.io.md` covers choosing an origin layout, the setup, and
  the rules a reverse proxy in front of the server must follow.
- `SIGTERM` and `SIGINT` shut the server down gracefully: it stops accepting
  connections, waits up to 10 seconds for in-flight requests, and runs its close
  hooks (the Postgres pool drain among them). A second signal, or a close still
  pending at the deadline, exits with code 1. A handle left open after a
  successful close no longer keeps the process alive past the deadline.
- A `HOST` env variable sets the listen address (default `0.0.0.0`).
- Startup warns when `SERVER_URL` is a loopback URL on a port other than `PORT`,
  since no capability would then match a request sent to the listening port.

### Changed

- **BREAKING**: a Collection Metadata object's `generator` is now an object
  `{ id, origin?, url?, name? }`, replacing the DID string and the flat
  `generatorOrigin` member. `id` is required and DID-shaped. `origin` is a Web
  origin. `url` needs `origin`, must be an http(s) URL on that origin, and
  carries no query or fragment. `name` is a non-empty display label. Unknown
  members are rejected (`invalid-request-body`, pointer to the member).
- An update omitting `generator` now keeps the stored value. A supplied one
  replaces it whole.
- `pnpm start` writes plain JSON logs. `pnpm start:pretty` keeps the
  `pino-pretty` pipe, which does not forward a signal to the server.
- `PORT` and the byte and count limit variables accept decimal digits only. Hex,
  binary, octal and exponent forms (`0x10`, `1e3`) are refused at startup.

### Fixed

- The filesystem backend removes, at startup, the staging temp files a killed
  process left behind. They were invisible to listings but counted against the
  Space's storage quota for good. Only files untouched for an hour are removed,
  so a process sharing the data directory keeps its in-flight writes. An
  unreadable entry is logged and skipped rather than failing startup.
- A startup failure's message is no longer lost when stderr is a pipe. The
  process closes what it opened and exits with code 1 once the output drains.
- Revocation resolves a self-hosted `did:webvh` signing key on a `did:key` Space
  too. A child grant signed by a `did:webvh` method can now be revoked, and a
  `did:webvh` delegee can revoke its own grant. Both used to answer 400 and 404.
- A grant rooted in a Collection's or a Resource's own root capability can now
  be revoked. It verified on invocation but was refused at revocation (400).
- A delegated Create Space chain with a `did:webvh` link now verifies.
- The create branch of `PUT /space/:spaceId/meta` refuses a `did:webvh`
  controller as `invalid-request-body` (400), as Create Space does.
- List Spaces lists a Space promoted to a self-hosted `did:webvh` for that
  controller. It runs the same verification as every other route, the
  client-annex clause included, and verifies at most one controller per request.

### Security

- A `did.jsonl` Resource, in any Collection, is append-only. A `PUT` must keep
  the stored bytes as a prefix of the body (412 otherwise), and a `DELETE`
  answers 405 with `Allow: GET, HEAD, PUT`. The log is removed only with its
  Collection or Space. The `did:webvh` resolver also refuses a log that does not
  extend the last one it verified for that DID, until the log's Collection or
  Space is deleted.
- An append to a stored `did.jsonl` must verify as the `did:webvh` history log
  of the DID the stored log names, or it is refused as `invalid-request-body`
  (400). A junk or tampered entry no longer leaves that DID's Spaces with no
  resolvable controller. A streamed append body is read under the buffered-body
  limit (413 past it).
- Update Keystore (`POST /kms/keystores/:keystoreId`) accepts only a direct root
  invocation by the stored controller. A delegated keystore grant, whether it
  carries `write` or no `allowedAction`, is refused with the masked 404, so it
  can no longer rewrite the keystore's `controller`. Key operations under such a
  grant are unchanged.
- A streamed body with a mismatching `Digest` no longer crashes the server when
  the request is refused before the body is read. One unauthenticated request
  could previously kill the process.
- The digest checks now apply to any request that carries a body, not only one
  with a `Content-Type`. A bodied request with no `Content-Type` is refused as
  `missing-content-type` (400) before it reaches a handler. Before, Import Space
  and a governed-log `PUT` accepted such a body without a signed `Digest`, so a
  captured signature could be replayed with a different body.
- The server now logs an uncaught exception or unhandled rejection at `fatal`
  and exits with code 1.
- Update Keystore resolves and verifies a proposed self-hosted `did:webvh`
  controller from its history log before storing it, as Update Space does. A DID
  whose log is absent or does not verify is refused as `invalid-request-body`
  (400, pointer `#/controller`), and the keystore keeps its current controller.
- A write into a Space or Collection re-checks, atomically with the write, that
  the container still has its Metadata object, and answers 404 otherwise. This
  covers Resource, chunk, Collection Metadata, policy and backend-registration
  writes and Import Space, on both backends. A write that raced a Delete Space
  used to recreate the Space's storage with no Metadata object. The data was
  unreachable, still counted against the quota, and was adopted by the next
  Space created under the same id. A policy write no longer creates a Collection
  that has no Metadata object.

- Every response on a PWS or `/kms` route (including 304s, redirects and error
  responses) carries
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-top-navigation-by-user-activation`,
  whatever the stored content type, except `application/pdf`, which Chromium
  refuses to render sandboxed. A hosted HTML page runs with an opaque origin, so
  it cannot read the storage of the origin serving it. The policy omits
  `allow-same-origin` and is always on. It also omits
  `allow-popups-to-escape-sandbox`, so a popup the page opens is sandboxed too.
  These responses send no `X-Content-Type-Options: nosniff`. The header has no
  effect on JSON responses read with `fetch()`. The welcome page, `/common/`,
  `/service` and the CORS proxy do not carry it.

- Every CORS proxy reply, errors included, carries
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, in
  place of the upstream's own. An upstream HTML page opened through the proxy no
  longer runs on the server's origin. The upstream `Refresh` header is no longer
  relayed.

- The CORS proxy strips the fragment from the target URL, so fragment variants
  of one URL share one cache entry and one upstream fetch. The cache key uses
  the `Accept` header normalized, and replies carry `Vary: Accept`. A target URL
  carrying credentials is refused with 400.

- The CORS proxy refuses an IPv6 literal that embeds a blocked IPv4 address, in
  hex form as well as dotted form: IPv4-mapped (`::ffff:0:0/96`),
  IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`).
  Before, `http://[::ffff:127.0.0.1]/`, which the URL parser rewrites to
  `[::ffff:7f00:1]`, reached loopback. It also refuses IPv6 multicast
  (`ff00::/8`) and the local-use NAT64 prefix (`64:ff9b:1::/48`).

- `PUT /space/:spaceId/meta` writes only against the Space it was authorized
  against. Before, a create authorized by the body's own `controller` could land
  after a concurrent create of the same id and replace the winner's `controller`
  and `type`. An update could likewise land on a Space deleted or re-created in
  between, or one whose controller had just changed. The request is now re-read
  and re-authorized when that Space changes before the write. A create that lost
  to a concurrent create is then an update: another caller gets the 404
  `not-found`, and the Space's controller gets a 204, or a 400 if its `type`
  differs. A delegated capability gets the 404 there too, since updates are
  controller-only. An update whose Space was deleted becomes a create (201). A
  412 comes only from the client's own `If-Match` or `If-None-Match`, evaluated
  as sent. If the Space keeps changing across three attempts, the answer is 503
  with `Retry-After: 1`.

- A Space import restoring the Space Metadata object no longer reverts an Update
  Space that lands during it, such as a controller change. The restore now reads
  the object and writes over it under the same lock. This affected the
  filesystem backend only.

- The CORS proxy's cache key also normalizes `Accept` media-type parameters.
  Media ranges and parameter names are lower-cased, and whitespace around `;`
  and `=` is dropped.

## 0.38.0 - 2026-09-27

### Added

- The service description lists a fourth entry, under
  `https://w3id.org/pws/client-annex` at version `0.1`, claiming that this
  server enforces the client-annex delegation clause. A wallet checks it before
  publishing a ladder verification method, since the clause fails open on a
  server that does not implement it. The entry carries `version` alone, and a
  client treats one with any member beyond `version` and `url` as absent.

- The Space Metadata object carries `backends`, the server-derived listing of
  the backends the Space serves -- the same array `GET /space/:spaceId/backends`
  returns -- so a reader learns it without a second request. It is read-only: a
  `backends` supplied in a Create Space or Update Space Metadata body is
  dropped, as `createdBy` is. `src/lib/spaceProjection.ts` holds the projection
  from the stored record to the served object, used by Read Space and both
  create echoes, and the one to the export archive's `.space.<id>.json` entry,
  which stamps `backends` alone. Requires `@interop/storage-core` 0.19.0.

- Import Space restores the archived Space Metadata object's `name` under an
  invocation of the Space's root capability, decided off the verified invocation
  rather than the header's serialization; under a delegated chain it skips the
  entry. The archived `type` is checked, not applied: a Space's `type` is
  immutable once it exists, so an archive naming a different set of types than
  the destination's is refused as `invalid-import` (400) before anything is
  written, and a `type` Update Space would refuse is ignored. An entry that does
  not parse as a JSON object is treated as absent, so the rest of the archive
  still imports. `controller` and the server-derived members are never restored.
  The outcome is reported as the new `ImportStats` member `spaceMetadata`:
  `'restored'`, `'skipped'` (a delegated chain, or a Space with no stored object
  to apply the entry over), or `'absent'` when the archive carried no Space
  Metadata entry. The restore makes the same write Update Space Metadata does,
  on both backends, so the object's monotonic version bumps with it and the
  write is serialized with concurrent Space Metadata writes.

- Registering or deregistering a backend advances the Space Metadata object's
  `ETag` version (generation kept), since the object's `backends` member
  changed: a conditional read holding the prior validator gets the new object
  rather than a 304. A deregistration that found no record leaves the validator
  as it was.

- Every Space export carries this server's Service Description verbatim as the
  archive's `service.json` entry, beside `manifest.yml`, so an importer can read
  which specification versions and feature set the contents were written under
  before it writes anything. The Export Space handler builds it with the same
  `buildServiceDescription` the `/service` route uses; an app composed without a
  `serverUrl` exports without the entry. `StorageBackend.exportSpace` takes it
  as an optional `service` option, and imports ignore the entry. Requires
  `@interop/space-archive` 0.2.0.

### Changed

- Space exports name the corrected PWS spec URLs in their `manifest.yml`: the
  spec's rendered host `https://w3c-ccg.github.io/portable-web-spaces-spec/`
  and, for the Collection Metadata and policy entries, the anchors
  `#collection-metadata-data-model` and `#access-control-policies`. The values
  come from `@interop/space-archive`; this server holds no copy of them.

- The client-annex inspector clause admits a fifth delegation shape: a
  target-exact single-verb `POST` child of a management capability a Space's own
  controller delegated to the account did:webvh. The child's `invocationTarget`
  is the canonical trailing-slash Space URL, equal to the parent's unchanged,
  and its `allowedAction` is exactly `['POST']`; the parent must be a delegated
  capability whose sole `controller` is the delegator account and whose own
  delegation proof was signed by the Space's stored controller. This is what
  lets a transient wallet session invoke Export Space on a sibling unlock Space.
  The invocation is not classified by the clause's invocation-time bounds, so
  those are unchanged. A `PUT` branch for the restore's create-by-id was drafted
  and withdrawn: such a child reaches every resource beneath the Space by prefix
  attenuation.

- The client-annex inspector clause's delegated-clients branch admits
  `allowedAction` within {GET, PUT, POST}, widened from {GET, PUT}. POST reaches
  the annex Space's export and import endpoints and Create Resource on each
  Collection container beneath it, which is what the wallet backup export
  invokes; it adds no authority a PUT holder lacked, since PUT already creates
  Resources by id and Update Space Metadata stays controller-only.

- The per-Space export archive codec now comes from `@interop/space-archive`
  instead of `@interop/wallet-backup`. This drops wallet-core and the rest of
  wallet-backup's dependency set from the server's dependency tree.
- The per-Space export archive codec now comes from `@interop/wallet-backup`
  rather than this server's own copy: the file-name dialect, the `manifest.yml`
  document, the packer, and the six manifest URL constants moved there and the
  local `src/lib/resourceFileName.ts`, `src/lib/exportManifest.ts` and
  `src/lib/exportTar.ts` are deleted. Both backends pack through the package's
  writer, so the server and a wallet reading a backup speak one codec. The
  archive bytes are unchanged, pinned by a new counterpart test against the
  fixture archive the package checks in.
- The buffered-body limit (`application/json`, `+json`, `text/*`) is now derived
  from the active backend's `maxUploadBytes` instead of Fastify's 1 MiB default,
  so the same bytes accepted as `application/octet-stream` now also pass as
  JSON. `MAX_UPLOAD_BYTES=unlimited` keeps buffered bodies bounded at a 64 MiB
  default, since a buffered body is held in memory. The governed-log
  `PUT /meta/log` uses the same limit.
- Fastify's and `@fastify/multipart`'s own over-limit errors are now answered as
  the registered `payload-too-large` problem (413) instead of `internal-error`
  with an empty `errors` entry.
- Corrected the `zcaps` segment comments in `src/lib/paths.ts` and
  `src/routes.ts`. Both argued that the revocation route shadows nothing because
  it is deeper than any Collection or Resource route; it is the same depth as
  `/space/:spaceId/:collectionId/:resourceId/meta` and one shallower than the
  chunk routes. What keeps them apart is the method: the route is `POST`-only
  and PWS registers no other `POST` at that depth, so find-my-way resolves the
  other methods to the parametric routes and a Collection named `zcaps` stays
  usable. `test/space-revocation-api.test.ts` now pins the routing. Comments and
  tests only; no behavior change.

### Fixed

- `captureRawBody` now bounds the body it buffers before Fastify's parser sees
  it: an announced over-limit `Content-Length` is refused before a byte is read,
  and a chunked body is refused at the byte that crosses the limit, with the
  rest of the body never read. Previously the whole body was buffered first, so
  a large chunked request could exhaust memory before the limit fired. The
  refusal is raised from the hook for every buffered media type, `text/jsonl`
  included, and closes the connection, since the unread rest may still be
  arriving.
- A signed `multipart/form-data` upload no longer fails with "missing a file
  part": the digest verification stream drained the raw request before
  `@fastify/multipart` read it. The digest is now taken by a tap on the raw
  request as busboy reads it, and its verdict is awaited before the write.
- The absent-target 404 family (Space, Collection, Resource, Policy, Keystore,
  Key not found) and the masked authorization-denial 404 now serialize one
  byte-identical body: `title` `Invalid <request> request` with no trailing
  period, `detail` `URL not found or invalid authorization.`. Previously the
  detail named the entity ("Space not found or invalid authorization.") and the
  denial title carried a trailing period, so an unauthenticated caller could
  tell whether a Space exists -- observable against Delete Space, since Space
  ids are embedded in every self-hosted `did:webvh`.
- Revocation submission (`POST .../zcaps/revocations/:id` and its `/kms`
  sibling): the body-shape and chain-verification 400s now run only after the
  invocation verifies, so an unauthorized caller gets the masked 404 whether or
  not the revocation scope exists.
- Create Space with an existing `id`: the `id-conflict` 409 existence check now
  runs after body-controller consent verification, so a non-consenting signature
  gets the same controller-mismatch 400 it gets at a fresh id.
- A signing key the server cannot resolve (an unresolvable `did:webvh`, a keyId
  absent from the resolved document, an undecodable `did:key`) is now the masked
  404 instead of the 400 `invalid-authorization-header`.
- The published conformance suite's
  `space.create-post-conflict-preserves-original` case signs as a non-consenting
  controller and expects 409; it now gets the 400 controller-mismatch instead. A
  suite update is pending.

## 0.37.0 - 2026-09-16

### Added

- `WAS_DATA_DIR`: the filesystem root the default backend stores Spaces,
  keystores, and revocations under, resolved against the process working
  directory. Unset keeps the project `data/` directory. It lets a test suite
  point each run at a scratch directory instead of accumulating every earlier
  run's Spaces. Also available as the `dataDir` option on `createApp()` and
  `defaultBackend()`, and read by the offline KMS re-encryption tool, whose
  default root therefore cannot drift from the server's.

## 0.36.0 - 2026-09-16

### Added

- The service description's `features` array now carries `changes-query`. The
  replication change feed varies by whether a server keeps an ordered change log
  at all rather than by backend, so the spec moved its token here.
- A third entry in the service description's `specs`, under
  `https://w3id.org/pws/encrypted-collections`: the Encrypted Collections
  profile at version `0.1`, with its rendered location and a `features` array
  carrying `blinded-index-query` and `governed-history-logs`. Listing the entry
  at all is the claim that this server serves the chunk endpoints; no token
  names those.

### Changed

- **Breaking for clients that read `signatureAlgorithms` or `zcapCryptosuites`
  off the core entry.** The service description now lists the zCap authorization
  profile as a second entry in `specs`, under
  `https://w3id.org/pws/authz-profile`, with its version (`0.1`) and rendered
  location. The two signature members moved from the `https://w3id.org/pws`
  entry onto the profile entry; the values they carry (`EdDSA`;
  `Ed25519Signature2020` and `eddsa-jcs-2022`) are unchanged.
- **Breaking for clients matching problem types or link relations by their full
  URI.** Every problem `type` and every PWS link relation the server emits now
  carries the base identifier `https://w3id.org/pws`, replacing
  `https://wallet.storage/spec`. The fragments are unchanged, so `not-found`
  becomes `https://w3id.org/pws#not-found` and the `policy` relation becomes
  `https://w3id.org/pws#policy`.

### Removed

- **Breaking for clients that read a Backend descriptor's `features` array.**
  The `features` property is gone from the Backend data model, dropped from the
  spec. The default backend advertises no tokens, and a registration no longer
  reads, stores, or echoes the field. Conditional writes and the `epoch` stamp
  are baseline requirements of every backend a Collection may be created on,
  since the server -- not the storage engine -- serializes each write and mints
  its own opaque validator. `equality-query` is dropped outright; it never had a
  defined token. `blinded-index-query` and `governed-history-logs` belong to the
  Encrypted Collections profile and are now advertised under its own entry in
  `specs`.
- The `storageMode` member of a backend descriptor, dropped from the spec. The
  default backend no longer advertises it, a registration no longer stores or
  echoes it, and an unknown `storageMode` member in a registration body is
  ignored like any other unknown member.

## 0.35.1 - 2026-09-14

### Fixed

- Fix pnpm lock.

## 0.35.0 - 2026-09-14

### Fixed

- Closed an authorization gap where a delegation signed by a transient per-visit
  client-annex key could be narrowed into a Delete Space invocation without ever
  passing through a ladder-signed link. Such a chain is now refused outright.
  The per-visit key is recognized by the relation shape of its own DID document,
  so the refusal also covers a retired annex generation whose grant is still
  live and an annex a `did:key` controller delegated to directly.

## 0.34.0 - 2026-09-14

### Changed

- `@interop/was-conformance-suite` devDependency raised to 0.19.0, which adds
  the Service Description suite; `pnpm conformance:local` runs its nine checks.

## 0.33.0 - 2026-09-14

### Added

- The service description: `GET /service` returns the unauthenticated JSON
  document naming the spec version this server speaks (`0.5`, keyed by
  `https://w3id.org/pws`), the Spaces Repository URL, the `features` it
  implements, the accepted `signatureAlgorithms` and `zcapCryptosuites`, and an
  `instance` member (name, version, source, homepage). It is served with
  `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=3600`, an
  `ETag`, and 304 on a matching `If-None-Match`.
- Every response carries `Link: <{serverUrl}/service>; rel="service"`, errors,
  redirects, and CORS preflights included.
- The Space and Collection linksets carry a `service` relation to the service
  description.
- `WAS_DISCLOSE_VERSION=false` (plugin option `discloseVersion`) withholds the
  server version from the service description, `/health`, and the welcome page.
  `/health` then also omits the build commit and time.

### Changed

- Bumped `@interop/storage-core` to 0.15.0, whose `ServiceDescription` type now
  types the service description.
- An unsafe method at a container URL is now controller-only, with two
  exceptions. `PUT /space/{s}/meta` on an existing Space and
  `DELETE /space/{s}/{c}/` accept a direct root-capability invocation alone; a
  delegated capability is refused whatever its `allowedAction`.
  `DELETE /space/{s}/` additionally accepts a delegated capability whose invoked
  grant targets exactly that Space's canonical trailing-slash URL with
  `allowedAction` exactly `['DELETE']`. `PUT /space/{s}/{c}/meta/log` (the
  guarded create and append of a Collection's governing history log) accepts a
  direct root invocation or a delegated capability whose invoked grant targets
  exactly the Space's items subtree (that same trailing-slash URL). The check
  reads the invoked capability's shape, so it holds whatever DID method the
  controller or a delegator uses. `PUT /space/{s}/{c}/meta` carries no rule: a
  grant on the Space subtree, on the Collection container URL, or on the
  Metadata URL itself writes the object, so an app holding a Collection-scoped
  grant can declare its own indexes and `encryption` descriptor. Collection
  creation (`POST /space/{s}/`) is unchanged. A refusal is the ordinary masked
  404 `not-found`.
- The client-annex clause admits a fourth ladder-signed delegation shape: a
  target-exact read of one Resource. The delegation targets a Resource URL
  `/space/{s}/{c}/{r}` (a Collection Metadata object, a policy, or a query
  endpoint does not qualify) with `allowedAction` exactly `['GET']`, under a
  parent whose target is that same URL or the Space's canonical trailing-slash
  URL. It restores the read a transient wallet session makes of an unlock
  Space's keyring record, which the v0.5 narrowing of the Space Metadata read
  had removed. No Space is special-cased; the parent bounds which Space the read
  can target.

## 0.32.0 - 2026-09-12

### Changed

Breaking: this server now speaks PWS spec v0.5's route table for Spaces and
Collections.

- A Space or Collection is canonically addressed with a trailing slash: `GET`
  lists its members, `POST` adds one, `DELETE` removes it, and `PUT` there is
  405 (`Allow` header, problem type `about:blank`, title `Method Not Allowed`).
  The no-slash form redirects with a 308 for every method.
- A method a reserved endpoint does not implement is 405 with an `Allow` header
  naming the methods it does, at every level. For example, `DELETE` at either
  Metadata URL is 405 with `Allow: GET, HEAD, PUT`, since the object is removed
  by deleting its container. Such requests used to fall through to a Collection
  or Resource operation on the reserved segment and answer 409 `reserved-id`.
- The Space description moved to `GET`/`PUT /space/:spaceId/meta`, the new Space
  Metadata object; `PUT` creates the Space when absent or replaces it.
- The Collection description and the former `/meta` object are merged into one
  Collection Metadata object at `GET`/`PUT /space/:spaceId/:collectionId/meta`,
  under one `ETag`; `PUT` is a full replacement that creates the Collection when
  absent.
- `GET`/`POST /space/:spaceId/` now list/create Collections. The
  `/space/:spaceId/collections/` endpoint is retired and 308s to the Space URL;
  `collections` and `meta` are reserved Collection ids.
- A Collection Metadata update that omits `backend` keeps the stored backend
  selection; only a create with none is assigned the default.
- Container `url` members and the `Location` of a newly created Space or
  Collection carry the trailing slash; Resource URLs are unchanged.
- The Space root capability's `invocationTarget` is now the trailing-slash Space
  URL.
- The ladder-delegation clause (`lib/clientAnnexClause.ts`) was updated for the
  new route table: its target-exact shape now splits into a DELETE grant on the
  Space URL and a GET grant on the Space Metadata URL, and an invocation-time
  check refuses a ladder-descended chain invoked as `PUT` on a Space Metadata
  URL or as `DELETE` on a Space URL, unless every ladder-signed delegation in
  the chain is itself a target-exact DELETE-only grant of that Space.
- Bumped `@interop/storage-core` to 0.14.1, which adds `meta` to the reserved
  Collection id registry this server mirrors.
- Bumped the `@interop/was-client` devDependency to 0.61.0, which speaks the
  v0.5 route table, and migrated the integration tests to it.
- Postgres migration v6 renames the `spaces` and `collections` `description`
  columns to `metadata` and their validator columns to `meta_generation` /
  `meta_version`. It drops the Collection `/meta` columns without copying their
  values, so an existing Collection loses its `custom`, `epoch` and timestamps.
  The filesystem backend's separate Collection `/meta` sidecar file is gone; the
  merged object lives in the Collection's own metadata file.

`@interop/was-conformance-suite` 0.15.0 still speaks the previous (v0.4) route
table; running it against this server requires the corresponding suite release.

### Fixed

- A Create Collection request with no body is 400 `invalid-request-body`; it
  used to be a 500.
- A delegated Space Metadata create whose chain is signed by someone other than
  the body's controller named the wrong cause in its `controller-mismatch`
  detail. It reported the chain as rooted at the Space URL, a root the server
  accepts, instead of naming the signer.

Backend correctness defects found in a review of `src/backends/`.

Postgres backend:

- Overwriting a Resource reset its `updated_at` to the row's creation time,
  because one bind parameter fed both `created_at` and `updated_at`. The
  overwrite was therefore invisible to the `changes` query profile, whose keyset
  seeks past the checkpoint, so a replicating client never saw the new content.
- Concurrent Collection Description updates could exhaust the connection pool
  permanently. The encryption-transition check runs inside the write transaction
  and reads the Collection's governing history log, which checked out a second
  pooled connection; ten such writes at once deadlocked the backend until
  restart. A transaction now publishes its client to the reads that run inside
  it, so a nested read joins the transaction instead of checking out a second
  connection, and the pool has a connection timeout so a future nesting mistake
  fails loudly rather than hanging.
- Deleting a Collection measured the freed bytes with an unlocked `SUM` taken
  before the cascade delete, so bytes committed in between were removed but
  never subtracted, inflating the Space's usage counter permanently. The freed
  total now comes from the `DELETE ... RETURNING` rows themselves.
- A Resource or chunk write derived its usage delta from a pre-read, which could
  double-count against a concurrent Space import. The delta now comes from the
  writing statement's own snapshot.
- Concurrent writes and deletes of one Collection could deadlock in Postgres and
  surface as a 500, because transactions took the `spaces` and `collections` row
  locks in opposite orders. Every transaction that mutates stored bytes now
  takes the Space row first.
- A write that raced a Space delete could fail with a foreign-key violation,
  which carries no problem type and so rendered a 500. Provisioning the Space
  row took no lock on a row that already existed, so a delete could commit
  before the write's separate `SELECT ... FOR UPDATE`, which then locked
  nothing. Provisioning and locking are now one statement.

Filesystem backend:

- A blob upload with no `Content-Length` reserved zero bytes against the Space's
  capacity and was never credited afterwards, so streamed writes could exceed
  the quota. The reservation is now reconciled with the bytes actually written.
- Importing a Space wrote each Resource without taking that Resource's write
  lock, so a concurrent write could leave a stored `ETag` that did not describe
  the stored bytes: a conditional read would then be answered 304 over different
  content.
- Deleting a Collection or a Space concurrently with a write to it could
  recreate its directory with no description, leaving storage that no route
  could reach but that still counted against quotas. Container deletes and
  path-creating writes are now mutually exclusive.
- Listing a Collection's items reported an I/O failure as an empty listing. Only
  a missing directory now yields an empty list; every other error surfaces.
- Deleting a Resource invalidated the Space's cached usage measurement before
  removing the bytes, so a concurrent measurement could re-cache the pre-delete
  total and refuse the client's follow-up write for the cache lifetime.
- A read racing a delete, a chunk listing racing a chunk delete, and a Resource
  create racing an unrelated Collection delete each surfaced a raw filesystem
  error as a 500. The first two now answer 404 and omit the vanished chunk
  respectively, and the third no longer fails.
- A Space import that wrote nothing, or failed part-way, kept its whole
  reservation against the Space's capacity until the usage cache expired.

Defects found in a review of the route-table change above.

- A ladder-signed whole-subtree delegation could still reach Delete Space. The
  invocation-time bound read only the chain's tail, and a client annex's own
  verification method -- which holds both capability relations, and so is not
  ladder authority -- could narrow such a grant into a target-exact DELETE-only
  child by ordinary attenuation. The bound now reads every ladder-signed link in
  the chain.
- An Update Collection Metadata request that omitted `backend` repointed the
  Collection at the server's default backend, stranding the Resources already
  written to the selected one. An omitted `backend` now keeps the stored
  selection; only a create with none takes the default.
- A Collection created with an `encryption` descriptor and no `custom` could
  never be updated again, because every later write was judged as a `custom`
  envelope and refused with 422. An omitted `custom` is now the cleared state on
  an encrypted Collection as on a plaintext one.
- The two backends disagreed on `createdAt` for a Collection Metadata object
  stored without one, which is how every pre-v0.5 archive imports: the
  filesystem backend left it absent, Postgres stamped the update's own clock as
  the creation time. Both now share one stamping rule, which preserves it as
  absent. The shared rule also settles a `custom: null` write, which faulted on
  the filesystem backend and cleared on Postgres.
- The retired `/space/:spaceId/collections` redirect rebuilt its `Location` from
  the router-decoded Space id, so a percent-encoded id redirected to a different
  resource, and one containing `?` injected a query into the path.
- `Allow` is exposed through CORS, so a browser client can read what a container
  accepts from the 405 that names it.
- The 201 creating a Collection by `PUT .../meta` omitted `createdBy`, so it
  disagreed with the Read that follows it.
- A delegated-provisioning grant minted on a Space's container URL could update
  an existing Space's Metadata object but not create one by `PUT`.

## 0.31.0 - 2026-09-10

### Changed

- Bumped `@interop/ed25519-verification-key` to 8.2.0 and switched test fixtures
  that mint a bare `did:key` signer to its new `didKeySigner()` method instead
  of hand-setting `keyPair.id` before calling `signer()`.

## 0.30.0 - 2026-09-10

### Added

- Typed denial reasons on a refused capability invocation. The status stays the
  merged `not-found` 404 on every route family, and two causes are now named by
  `type` alone (`@interop/storage-core` 0.13.0): `capability-revoked` when a
  capability in the invoked chain has a stored revocation, and
  `capability-expired` when the invoked capability, or one in its chain, has
  expired (the named error `@interop/zcap` 11.2.0 raises). Every other cause
  keeps `not-found`. A cause is named only when the request is signed by the
  invoked capability's controller; a copy of the grant invoked with any other
  key still gets the plain `not-found`.

### Changed

- Resubmitting a stored revocation now answers with the distinct
  `capability-already-revoked` problem type (`@interop/storage-core` 0.12.0),
  still 400. Every other 400 on the revocation route (malformed body, root
  capability, id mismatch, a chain that does not verify) keeps
  `invalid-request-body`, so a chain that fails to verify is never reported as
  revoked. The type is emitted only after the 404-masking authorization, so it
  discloses nothing an unauthorized prober could not already learn. A client
  resubmitting a revocation blind can now tell "already done" from "refused"; it
  used to get one type for both, differing only in `detail`.

## 0.29.0 - 2026-09-08

### Added

- Create-if-absent preconditions on the Space and Collection Descriptions.
  Update (or Create by Id) Collection now honors `If-None-Match: *`: the write
  proceeds only when no Description exists under that id, else 412
  `precondition-failed`, evaluated atomically with the write (the header was
  parsed and dropped before). The Space Description gains a server-managed
  version validator on the same terms as the Collection's: Read Space emits it
  as a strong `ETag` (and answers a covering `If-None-Match` with 304), Create
  Space and Update Space return the new `ETag`, and Update Space honors
  `If-Match` (compare-and-swap) and `If-None-Match: *` (guarded create), 412 on
  a failed one. An unconditional PUT still upserts. The guarded create resolves
  two clients provisioning the same Space or Collection at once, where the
  loser's replacement used to drop the winner's `type` array or `backend`.
  Postgres gains a schema migration adding the two validator columns to
  `spaces`. `If-Match` on every conditional write now takes its RFC 9110 forms
  (`*`, and a comma-separated list of validators), and `If-None-Match` on a
  write takes a list of validators as well as `*`, refusing when one of them
  names the current `ETag`. A request carrying both headers evaluates them in
  the RFC's order, `If-Match` first.
- Create Space is a guarded create inside the storage backend: two concurrent
  `POST /spaces/` with the same client-supplied `id` can no longer both succeed,
  with the later one replacing the first's `controller`. The loser gets the same
  `id-conflict` (409) as before.

### Fixed

- Filesystem backend: a JSON metadata read (a description, policy, metadata
  sidecar, history log, backend record, or keystore config) no longer fails with
  an `ENOENT` 500 when a concurrent hard delete removes the directory between
  the store's existence check and its read. The window was reachable through the
  List Spaces scan the Spaces count quota runs on every create, so a Create
  Space racing another controller's Delete Space could fail.
- Both backends: Delete Space (and, on the filesystem, Delete Collection) is
  serialized with the Description write of the same id, so a delete landing
  inside a concurrent write's read-then-write can no longer resurrect the record
  with the deleted life's generation.
- Postgres backend: a Space Description write no longer holds a row lock on the
  `spaces` row, which is also the usage counter every Collection and Resource
  write locks, so Update Space and unrelated writes in the Space no longer stall
  each other.
- Read Space decides a conditional `If-None-Match` read against the stored
  description rather than the short-lived per-process cache, so a 304 from one
  server instance cannot affirm a validator another instance has already
  superseded.

## 0.28.0 - 2026-09-07

### Added

- `createApp` accepts a `logger` option passed through to Fastify: `false` for
  silent, or a pino options object or instance. The default stays `true`. The
  backend's diagnostics follow the same logger, so a silent app logs nothing.
  The test helper `startTestServer` now defaults to `logger: false`, so
  in-process suites no longer print a log line per request.
- Conditional reads: a GET or HEAD carrying an `If-None-Match` that covers the
  current `ETag` is answered 304 Not Modified with the `ETag` header and no
  body, per RFC 9110 (weak comparison, so `W/"3"` matches `"3"`; a list and `*`
  are honored). Applies to every ETag-emitting read: Resource, chunk, Resource
  and Collection `/meta`, and the Collection Description. A Resource or chunk
  GET consults the stored metadata before opening the byte stream, so a 304
  never reads the content. A representation with no `ETag` (a legacy Resource,
  or metadata never written) is matched only by `*` and its 304 carries no
  `ETag`, per RFC 9110. Authorization runs first, so an under-authorized
  conditional read still gets the 404 mask.
- Responses to non-idempotent POSTs carry `Cache-Control: no-store` (spec
  "Caching"); slash-variant redirects and the read-shaped Query and Export POSTs
  stay cacheable.
- Governing history logs (the `governed-history-logs` backend feature): a
  Collection may carry a history log at the `meta/log` sub-resource (`GET` /
  `PUT /space/{space_id}/{collection_id}/meta/log`, `text/jsonl`, its own
  `ETag`), with a guarded create (`If-None-Match: *`) and a compare-and-swap
  append (`If-Match`, prior bytes carried verbatim), 412 on a lost race. The
  guarded create makes the Collection log-governed, refused with
  `encryption-immutable` (409) on one whose Description already carries a
  client-written `encryption` member. A governed Collection's served
  `encryption` member is derived from the log head's `state`, with
  `history: { method, resource }` stamped on; a direct write of the member is
  refused with the new `encryption-history-log-governed` problem type (409).
  Each write checks the line contract (`invalid-request-body`, 400) and runs the
  encryption descriptor's transition checks against the prior head. The log is
  not a Resource: absent from listings and the `changes` feed, exempt from the
  envelope rule, untouched by `PUT /meta`, readable under any capability
  covering the Collection URL. A log write also bumps the Description's `ETag`.
  Stored as `.collectionlog.<id>.json` beside the metadata sidecar (carried by
  export/import); the Postgres schema gains `log_body`, `log_generation`, and
  `log_version` on `collections` (migration v3). Requires
  `@interop/storage-core` 0.11.0.
- The `changes` feed carries each document's current content `etag` and `/meta`
  `metaEtag`, the quoted validators exactly as the server emits them in the
  `ETag` header, so a replica can send `If-Match` from feed state without a GET
  per Resource.

### Fixed

- A Resource's `/meta` `ETag` now carries a generation of its own, minted by the
  first metadata write and dropped by a soft delete together with `custom` and
  `metaVersion`, so a `/meta` `ETag` held from before the delete cannot pass
  `If-Match` against the re-created Resource. The content validator is
  unchanged. The `.meta.<id>.json` sidecar gains `metaGeneration`; the Postgres
  schema gains `meta_generation` on `resources` (migration v4).
- A history log write fast-forwards the stored log: the body must carry the
  stored bytes verbatim followed by exactly one new line. A body the stored log
  is not a prefix of (a stale read or a rewritten prefix) is 412
  `precondition-failed` whether or not the write carries `If-Match`; a body
  adding no line or several is 400 `invalid-request-body`. A write capability
  can therefore add to a log but not erase or rewrite it.
- Import Space validates an archived governing history log (the stored-record
  shape plus the line contract and head-descriptor check a log write passes) and
  rejects the archive with `invalid-import` (400); an unchecked entry could
  break every read of the Collection it governs. A stored log the line contract
  rejects now surfaces as `storage-error` (500) rather than as
  `invalid-request-body`.
- Import Space no longer fails with a 500 on a chunk metadata sidecar whose JSON
  is not an object.
- A history log `PUT` body is bounded while it is buffered: the backend's
  `maxUploadBytes` (else Fastify's `bodyLimit`) applies, 413 `payload-too-large`
  past it.

### Changed

- **Breaking:** the `ETag` validator is now `"<generation>.<version>"` instead
  of `"<version>"`. The generation is a random base58 marker minted when a
  record's version counter starts (a Resource, chunk, Collection Description, or
  `/meta` object) and kept for the record's life, tombstone and re-create
  included. A hard delete (a chunk, a Collection, a Space) takes it with the
  record, so a record re-created under the same id gets a new generation and a
  stale `ETag` from before the delete can no longer be answered 304 over
  different bytes, or pass `If-Match` against the new record. Clients must echo
  the quoted value back verbatim; the trailing integer is still the per-record
  revision. Stored as `generation` in metadata sidecars and `_generation` in
  Collection description files; the Postgres schema gains `generation`
  (resources, chunks), `description_generation` and `meta_generation`
  (collections) with no migration, so an existing database must be recreated. An
  `If-Match` against a record with no validator (a legacy Resource, or metadata
  never written) now fails with 412; previously an unwritten metadata object
  compared as `"0"`.

## 0.27.0 - 2026-09-05

### Added

- The Collection `encryption` descriptor's `hmac` member (the blinded-index
  blinding key) is now validated on create and update: it must be an object with
  non-empty string `id` and `type` and a non-empty `recipients` array whose
  entries have the epoch recipients-entry shape, else 400 `invalid-request-body`
  with a pointer into `#/encryption/hmac`. On an update of a descriptor that
  already carries `hmac`, the member must remain present with `id` and `type`
  unchanged; removing it or changing either is 409 `encryption-immutable`.
  `recipients` may change, and introducing `hmac` on a descriptor that lacks it
  is accepted.

## 0.26.0 - 2026-09-05

### Changed

- The WebKMS Key Operation handler checks its body shape through the shared
  JSON-object-body helper, so a JSON array body is refused with the same 400
  `invalid-request-body` as the other keystore handlers.
- The filesystem backend reads a Resource's or chunk's meta sidecar only after
  locating the representation, so a GET or HEAD for a nonexistent id no longer
  pays a wasted sidecar read.
- **BREAKING**: the Collection `indexes` declaration moved under a new
  `plaintext` member (`plaintext.indexes`), following
  `@interop/storage-core@0.10.0`. A top-level `indexes` is no longer read or
  stored. `plaintext` and `encryption` are counterparts: a create or update
  whose result carries both is `invalid-request-body` (pointer `#/plaintext`),
  by presence, so an empty `plaintext` still excludes `encryption`. `plaintext`
  is updatable: a supplied object replaces the stored one, `{}` is the empty
  state, an absent member leaves it untouched. Malformed `plaintext` errors
  point at `#/plaintext/...`; the `equality` `id-conflict` pointer is now
  `#/plaintext/indexes`.
- Update to `@interop/storage-core@0.10.0`.
- Update to `@interop/did-method-webvh@5.8.0`. A self-hosted `did:webvh`
  controller now resolves through the library's `resolveDID` with its
  `resolveControlledDid` hook, which hands it the log read from local storage;
  the library applies its own SCID and requested-DID pinning, and the server
  still fetches nothing over the network.
- The WebKMS AES-KW key type and the at-rest key record cipher wrap keys through
  `@interop/minimal-cipher`'s `createKek` (new direct dependency) instead of a
  local `node:crypto` AES Key Wrap. Same RFC 3394 bytes, so existing wrapped
  keys and records still unwrap.
- The client-annex clause's module header and ARCHITECTURE.md say a wallet
  publishes a ladder VM on a host it assumes enforces the profile, and that the
  server advertises nothing a client could check. Docs only.

### Fixed

- Blinded-index queries and unique-blinded writes on the filesystem backend read
  JSON documents only again: no meta sidecar read per live Resource, and a
  corrupt sidecar on an unrelated Resource no longer fails the query or the
  write.
- List Keys on the filesystem backend now orders key ids in code-unit order, the
  order the shared keyset pager seeks with (the Postgres backend already did).
  The handler uses that pager instead of its own cursor scan.
- Get Chunk and Head Chunk issue the parent-Resource check and the chunk read
  concurrently, as List Chunks already did; the filesystem backend reads a
  representation and its metadata sidecar concurrently, and the Postgres
  backend's usage report issues its two queries at once.
- Get Chunk destroys the chunk stream it opened when the parent-Resource check
  fails (parent absent, tombstoned, or its read rejected). On the filesystem
  backend that stream already held a file descriptor, so every probe of an
  orphan chunk leaked one until `EMFILE`. The parent gate the three chunk read
  handlers share is now one helper.
- The CORS proxy no longer relays an upstream `Link` header. A browser acts on
  `Link: rel=preload` on the proxy's reply and resolves relative URLs against
  the proxy's origin, so an upstream 404 page was making wallets request
  `/build/assets/...` from the storage host.
- Wrap Key and Unwrap Key on an `AesKeyWrappingKey2019` key accept every RFC
  3394 length (a multiple of 8 bytes, at least 16), not only the three AES key
  sizes; a 64-byte payload was a 500. A payload or wrapped key of any other
  length is `invalid-request-body` (pointer `#/unwrappedKey` or `#/wrappedKey`)
  instead of a 500 on wrap and a misleading `unwrappedKey: null` on unwrap. The
  fix is `@interop/minimal-cipher@7.9.0`, whose WebCrypto AES-KW backend now
  matches its pure-JS one; wrapped bytes for 16/24/32-byte keys are unchanged.

## 0.25.1 - 2026-09-03

### Changed

- CORS preflight responses now carry `Access-Control-Max-Age: 86400`, so
  browsers cache the preflight answer instead of re-asking before nearly every
  signed request (Chrome's default without the header is 5 s, and about half of
  a wallet signup's requests were preflights).
- The filesystem backend caches the per-Space live Resource count used by the
  `MAX_RESOURCES_PER_SPACE` create-path check, in the same shape as the byte
  quota's usage cache (short TTL, each accepted create adds one, deletes and
  import invalidate). A Resource create no longer enumerates every Collection
  directory of the Space.
- The Space Description memoization TTL is 10 s (was 5 s). Writes still
  invalidate explicitly; the TTL is only the multi-process backstop.
- A cached, verified `did:webvh` controller document past its TTL is now
  revalidated by comparing the `did.jsonl` log Resource's stored version against
  the one it was verified from. The log is re-read and re-verified only when
  that version differs (or the Resource is gone); an unchanged log just extends
  the entry's freshness window, up to a hard re-verify age of 60 s after which
  the log is fully re-verified regardless of version. Freshness is measured on
  the monotonic clock, so a backward wall-clock step cannot revive a stale
  entry. Same-process writes still invalidate outright. The cache is
  `lru-cache`'s `fetch()` path, which supplies the concurrent-caller dedup, the
  stale-entry hand-off, and the drop on rejection. The DID resolver that carries
  the local `did:webvh` driver is built once per storage backend and base URL
  instead of once per verification, with its own internal result cache disabled
  (through `createDefaultDidResolver`'s new `cache` option in
  `@interop/security-document-loader` 10.1.0) so document caching lives in one
  invalidation-aware place.
- The per-backend caches (Space Description, policy, `did:webvh` document, DID
  resolver) share one backend-scoping factory and one prefix-delete helper in
  `src/lib/backendCache.ts`.
- The `/api/cors` proxy caches 2xx responses in memory, keyed by the target URL
  and the forwarded `Accept` header, so a wallet signup fetching the same
  issuer-registry federation documents over and over stops paying a fresh DNS
  lookup and TLS handshake each time. TTL comes from the upstream
  `Cache-Control` `max-age`, capped at 1 hour and defaulting to 60 s when
  absent; `no-store`, `no-cache`, `private`, and non-positive `max-age`
  responses are not cached, nor are non-2xx responses or bodies over 1 MiB. The
  cache is an LRU bounded to 500 entries and 50 MiB (`lru-cache` is now a direct
  dependency). `s-maxage` takes precedence over `max-age`, as it does for any
  shared cache. Concurrent requests for the same uncached URL share one upstream
  fetch.
- The proxy's SSRF check reuses a hostname's resolved addresses for 30 s instead
  of doing a fresh DNS lookup, and the pinned undici `Agent` is now reused
  across requests that dial the same host with the same resolved addresses
  instead of being built and torn down per request. An Agent is dropped after 5
  minutes without use, once any request still on it has finished. A re-resolved
  host still gets its own Agent.
- The proxy asks upstreams for an identity encoding and no longer relays
  hop-by-hop headers, `content-encoding` (the body is relayed decoded),
  `content-length`, `set-cookie`, `date`, `age`, or any `access-control-*`
  header (the proxy's own CORS answer is the one it sends; an upstream
  `Access-Control-Allow-Origin` would have overwritten it). A cache hit is
  replayed with an `Age` header counted from the upstream's `Age` at storage
  time, and an entry's lifetime is the upstream lifetime less that age, so a
  downstream cache does not restart `max-age` at replay time.
- The filesystem backend's byte and Resource-count quota checks reserve the
  pending write against their cached snapshot; a write that then fails (an
  aborted upload, a mid-stream cap) now gives that reservation back instead of
  letting a phantom write refuse valid ones until the snapshot expires.
- An invalidation of a cached `did:webvh` controller document now also reaches a
  slot whose fill or revalidation is still in flight: the waiting resolve still
  gets the document it verified, and the result is not written back, so a
  document read from before the invalidating write cannot outlive it.
- `resolveEffectivePolicy` now reads the Space, Collection, and Resource policy
  documents through a per-backend short-TTL cache, in the same shape as the
  Space Description cache. Policy PUT and DELETE invalidate their own level;
  Delete Collection drops every entry under the Collection, and Delete Space and
  Space import drop every entry under the Space. Those bulk invalidations run
  even when the delete or import fails partway, since neither is atomic.
- Access-control policy dot-files are named per level: a Space's own policy is
  `.space.policy.json` in the Space dir, a Collection's own policy is
  `.collection.policy.json` in the Collection dir, and a Resource's policy is
  `.r.<resourceId>.policy.json` alongside its representation (was
  `.policy.<id>.json` for all three, which made a Resource named like its
  Collection share the Collection's policy file). The export archive carries the
  same names. No migration: existing on-disk policy files under the old names
  are not read.

### Notes

- A regression test that a ladder-signed single-verb Space delegation stops
  verifying once the ladder verification method leaves the account document: the
  same unexpired child is refused (404) after one log entry removes that method,
  and the Space it targeted survives.

## 0.25.0 - 2026-09-01

### Changed

- The client-annex clause's first admission predicate gains a target bound and
  an action bound. A ladder-signed delegation to the account's annex DID is
  admitted only when its `invocationTarget` lies within the items subtree of the
  Space carrying the delegator's own history log, meaning the trailing-slash
  Space URL or a path under it. The bare Space URL is refused, since it reaches
  Update Space Description (a controller rewrite) and Delete Space; keystore
  (`/kms/...`) targets are refused as well. Its `allowedAction` must be present,
  non-empty, and drawn from the closed PWS verb vocabulary (`GET`, `HEAD`,
  `POST`, `PUT`, `DELETE`). The predicate previously admitted on grantee
  identity alone and read neither target nor action.

### Notes

- **Wallet requirement from 0.25.0: a ladder-signed delegation to a client annex
  must target the account Space's items subtree.** A wider one is refused, and
  the refusal falls through to access-control policy like any other failed
  verification. No shipped wallet mints a wider one: freewallet's generation
  delegation targets exactly that subtree, with the full verb set the new action
  bound admits.
- Root invocations on a Space promoted to a self-hosted `did:webvh` were already
  scoped by the resolved document's `capabilityInvocation` relation, so a
  delegation-only verification method could not root-invoke. A regression suite
  now pins that matrix and the verifier's refusal message. No behavior change.

## 0.24.0 - 2026-09-01

### Added

- A third admission predicate in the client-annex clause: a ladder-signed
  delegation is admitted when its `invocationTarget` is a bare Space URL (no
  trailing slash) equal to its parent capability's target unchanged, and its
  `allowedAction` is exactly `['GET']` or exactly `['DELETE']`. Both chain
  lengths are covered -- a child of a delegated capability, and a child of a
  Space's synthesized root. A two-verb set is refused.

## 0.23.0 - 2026-08-29

### Added

- Delegation proofs signed with `eddsa-jcs-2022` are accepted, beside the
  `Ed25519Signature2020` proofs accepted until now. Both suites are passed at
  every site that verifies a delegation proof: the capability-invocation path,
  the revocation chain check, and the revocation's own invocation. The links of
  a single chain may mix the two suites in either order. Clients are moving
  their delegation proofs to `eddsa-jcs-2022`, which canonicalizes with JCS and
  so costs no JSON-LD canonicalization; this release ships the verify side
  first, so a client can upgrade at any time afterward.

### Notes

- `Ed25519Signature2020` is not removed. Clients upgrade on their own schedule,
  and grants a wallet recorded before the switch are submitted back for
  revocation under the old suite. Removal waits until neither is true.

## 0.22.1 - 2026-08-28

### Changed

- The ladder-delegation bound formerly called the companion clause is renamed
  the client-annex clause (`clientAnnexChainInspector`,
  `lib/clientAnnexClause.ts`); the refusal message wording follows. Internal
  rename only; no wire or protocol behavior changes.

### Notes

- **Minimum server version for a wallet's transient-session grants: 0.22.0.** A
  wallet running the transient-VM delegation fix (wallet-core 0.58.0 and later)
  mints App Connect and share grants signed by a per-visit verification method
  of its client annex. Verifying such a grant means resolving that annex
  `did:webvh`, whose history log lives in a per-generation Collection rather
  than in `id`. Self-hosted resolution reached only the `id` Collection before
  0.22.0, so an older deployment cannot resolve the delegator and refuses the
  grant. The refusal is masked as a 404, byte-identical to the symptom of the
  wallet bug the fix removes, so a wallet that still sees 404s after upgrading
  should check the server version. (The webvh context itself has been threaded
  on the PWS routes since 0.16.0, widened in 0.16.1; 0.22.0 is the binding
  requirement.)

## 0.22.0 - 2026-08-19

### Added

- Space Descriptions accept a `type` array subtyping `Space` at creation
  (`POST /spaces/` and the create branch of `PUT /space/{spaceId}`), defaulting
  to `['Space']`. A malformed `type` is `400 invalid-request-body` on `#/type`.
  `type` is immutable once the Space exists: an Update Space body carrying a
  different set is a `400`, and an absent one preserves the stored value. Spaces
  typed `AuxiliarySpace` are excluded from `GET /spaces/`.
- Ladder-signed delegations are bounded by a second capability-chain inspector
  beside the revocation one, on both route families (the companion profile's
  delegation clause). A delegation signed by a delegation-only verification
  method of a self-hosted `did:webvh` document (`capabilityDelegation` without
  `capabilityInvocation`) is admitted only when its `controller` equals the
  companion DID named by the document's `https://w3id.org/byoe#DelegatedClients`
  service entry, or when its `invocationTarget` is the account log resource URL
  with `allowedAction` within `PUT`, or the trailing-slash URL of a
  `DelegatedClientsSpace`-typed Space with `allowedAction` within `GET`/`PUT`. A
  refused delegation does not authorize; the refusal falls through to
  access-control policy, so world-readable reads still serve.

### Changed

- Self-hosted `did:webvh` resolution is generalized: the history log may live in
  any Collection whose name round-trips the DID path encoding
  (`did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`), not only the `id`
  Collection. A Space's controller log may live in a different Space. The
  resolved-document cache is re-keyed by the log's location, so invalidation
  targets the written Collection.
- Update to `@interop/ezcap@7.4.3` (its client now pairs a url with a
  trailing-slash subtree `invocationTarget`); the subtree delegation tests
  invoke through the ezcap client instead of hand-signing.

## 0.21.1 - 2026-08-18

### Changed

- Update to latest `@interop/data-integrity-core@8.7.1`.

## 0.21.0 - 2026-08-12

### Added

- **Collection Metadata at `GET`/`PUT /space/{spaceId}/{collectionId}/meta`**,
  the Collection-level sibling of Resource Metadata. `GET` returns the
  server-managed `createdAt` / `updatedAt` / `createdBy` (read from the
  Collection Description), the opaque `epoch` stamp, and the user-writable
  `custom` object, with the `metaVersion` ETag once metadata has been written;
  authorization is capability-or-policy, so a `PublicCanRead` Collection may be
  read anonymously, and a missing or unauthorized Collection is a `404`. `PUT`
  fully replaces `custom` (`400 invalid-request-body` on a malformed one), is
  capability-only, never creates (`404`), honors `If-Match` / `If-None-Match` on
  the `metaVersion` (`412`), and returns `204` with the new ETag. On an
  encrypted Collection `custom` is the opaque envelope, structurally validated
  (`422 encryption-scheme-mismatch`). The Collection's `metaVersion` is
  independent of its `descriptionVersion` and of every Resource's versions.
  Collection Metadata travels in a Space export and is restored on import for a
  newly-created Collection, on both backends.
- `meta` is now a reserved Resource id (`409 reserved-id`): Collection Metadata
  occupies the `{resource_id}` position.

### Changed

- Collection Metadata `epoch` semantics differ from the Resource-level rule: an
  update that omits `epoch` CLEARS the stored stamp rather than preserving it,
  because the stamp describes the `custom` envelope the write replaces
  wholesale.

## 0.20.0 - 2026-08-12

### Added

- **An ephemeral exchanges facet at `/workflows/ephemeral/exchanges`**, a
  transient, unauthenticated rendezvous for cross-device flows.
  `POST /workflows/ephemeral/exchanges` with `{ "request": <opaque JSON> }`
  mints an exchange and returns `201` with its URL in both the `Location` header
  and a `{ "location": ... }` body (`400` when `request` is absent, `429` once
  the server holds its cap of 1000 live exchanges).
  `POST /workflows/ephemeral/exchanges/:exchangeId` with no body or `{}` returns
  the stored request verbatim, and with any other body stores that body as the
  exchange's response and echoes it (last write wins).
  `GET /workflows/ephemeral/exchanges/:exchangeId` returns
  `{ id, sequence: 0, state: "pending" }` until a response is posted, then
  `{ id, sequence: 1, state: "complete", response }`.
  `GET /workflows/ephemeral/exchanges/:exchangeId/protocols` returns
  `{ "protocols": { "vcapi": <exchange URL> } }` for a QR-carried interaction
  URL. Every route answers `404` for an unknown or expired id. The exchange URL
  is a capability URL -- possession of it is the only access control -- and the
  relayed payloads are opaque JSON the server never inspects. Exchanges are held
  in memory only, expire ~10 minutes after creation, and are lost on restart;
  both `POST` bodies are capped at 64 KiB.

## 0.19.0 - 2026-08-11

### Added

- **Round-trips the Collection Description's `generator` and `generatorOrigin`
  members** (spec "Collection Data Model"), pairing with the new wire types in
  `@interop/storage-core` 0.6.0. `generator` names the DID of the application a
  Collection was provisioned for and `generatorOrigin` the Web origin that DID
  was bound to at provisioning time. Both are assertions by the Space
  controller: writable at Create Collection AND on Update Collection (so a
  wallet can backfill Collections provisioned earlier), persisted verbatim, and
  echoed on reads. Neither is verified, defaulted, or computed by the server,
  and neither is ever an authorization input -- unlike the server-observed,
  read-only `createdBy`, which these writes leave untouched. They merge like
  `name`: a supplied value overwrites, an absent one preserves the stored value.
- Shape validation for both members, rejected with 400 `invalid-request-body`:
  `generator` must be a DID string (pointer `#/generator`), and
  `generatorOrigin` must be the ASCII serialization of a Web origin -- a path,
  query, fragment, or trailing slash is refused (pointer `#/generatorOrigin`).

## 0.18.0 - 2026-08-10

### Changed

- **Breaking: the key-epoch request header is renamed from `WAS-Key-Epoch` to
  `Key-Epoch`.** Only the new spelling is accepted; there is no dual-read
  tolerance for the old one. Pairs with the client-side rename in
  `@interop/was-client` 0.32.0 (`WAS_KEY_EPOCH_HEADER` to `KEY_EPOCH_HEADER`),
  so client and server flip together.

## 0.17.2 - 2026-08-09

### Changed

- Encryption descriptor `version` regressions (a decrease, or removing a set
  version) are now rejected with 409 `encryption-immutable` (pointer
  `#/encryption/version`) instead of 400 `invalid-request-body`, matching the
  spec's error registry.
- An unrecognized `version` of a recognized encryption scheme is now rejected
  with 400 `unsupported-encryption-scheme` rather than accepted unenforced; the
  scheme registry pins the recognized versions per scheme (`edv`: 1).

## 0.17.1 - 2026-08-06

### Changed

- **Internal refactor: deduplicated shared logic across layers; no wire
  changes.** The Space tar-archive contract (entry names, meta-sidecar shape,
  import pre-flight, tar packing), cursor-pagination shaping, the List
  Collection response body, and the default backend descriptor now each live
  once in `src/lib/` and are consumed by both storage backends. Request handlers
  share `fetchCollectionAndBackend` / `getResourceMetadataOrThrow` preludes and
  one route-group hook installer; the provisioning gate takes its route list
  from `routes.ts` instead of a parallel hardcoded set; query-index body parsing
  shares one envelope validator.
- **Streamed-body `Digest` verification now uses `@interop/http-digest-header`'s
  new `verifyDigest`** (3.1.0), replacing the hand-rolled multihash comparison
  in `src/digest.ts`.
- **Performance.** The JSON-LD document loader is built once and cloned per zcap
  verification (previously rebuilt with ~22 cloned contexts on every
  authenticated request), and the DID resolver cache now survives across
  requests. The filesystem write path does one directory scan and one sidecar
  read per locked write (was three and two); listings, policy-level lookups, and
  Postgres COUNT+page queries run concurrently; JSON/text request bodies are
  buffered once instead of three times.

## 0.17.0 - 2026-08-06

### Added

- **Build-provenance stamp and stale-build fail-fast.** `pnpm build` now writes
  `dist/build-info.json` (version, git commit with a `-dirty` suffix for an
  unclean tree, build time). Startup refuses to serve when the stamped version
  does not match `package.json` (sources updated without a rebuild), and
  `/health` reports the stamped version, commit, and build time -- the code
  actually running, not the `package.json` on disk.

## 0.16.1 - 2026-08-03

### Fixed

- **Delegated capabilities whose controller is a self-hosted `did:webvh` now
  verify on a `did:key`-controlled Space too.** The local `did:webvh` resolver
  is engaged whenever it is available, not only when the Space controller itself
  is a `did:webvh`. This widens resolution only, never authority: the driver
  still refuses any DID this server does not host, and the capability chain
  still roots in the Space's own root capability.

## 0.16.0 - 2026-08-01

### Changed

- **The Collection `encryption` member is now called the encryption
  "descriptor"** (previously "marker"), following the spec's rename. Nothing
  changes on the wire except the `encryption-immutable` problem+json strings,
  which now match the spec verbatim: title
  `"Collection encryption descriptor is immutable."` and detail
  `"A Collection's 'encryption' descriptor is set-once and cannot be changed or cleared."`
  -- the error `type`, status, and pointer are unchanged. Internal helpers
  (`assertEncryptionDescriptorTransition`), comments, and tests renamed to
  match; no public export carried the old word.

### Added

- **A Space (or keystore) may now be controlled by a self-hosted `did:webvh`.**
  Alongside the existing Ed25519 `did:key`, "Update Space" -- and, under the
  same rules, "Update Keystore" / "List Keystores" on the `/kms` facet --
  accepts a `did:webvh` anchored on this server
  (`did:webvh:<scid>:<host>:space:<spaceId>:id`), whose history log is the
  `did.jsonl` Resource in that Space's world-readable `id` Collection. This lets
  a wallet hold one stable user identity whose DID document carries a
  verification method per enrolled client, instead of a single shared key. The
  flow is promotion by ordering: create with a `did:key`, publish the log, then
  PUT the Description naming the `did:webvh` (still authorized by the stored
  `did:key`) -- creation stays `did:key`-only. Cross-host `did:webvh`,
  `did:web`, and every other DID method are refused, and a proposed `did:webvh`
  must resolve and fully verify before it is stored (otherwise a typo or an
  unpublished log would deadlock the Space, since after promotion the controller
  being named authorizes its own updates); both failures are 400
  `invalid-request-body` pointing at `#/controller`.
- **Capability verification against a resolved `did:webvh` controller.** On a
  promoted Space or keystore, invocation keyIds (`<did:webvh>#<fragment>`), the
  delegation chain, and the revocation routes all resolve through the DID's
  currently resolved document, so a verification method no longer listed in it
  stops verifying (the current-key-set rule); `createdBy` provenance records a
  `did:webvh` invoker too. Resolution is a local storage read, never a network
  fetch (no liveness or SSRF surface), and the log is verified rather than
  trusted: the SCID pinned in the DID plus full log verification (hash chain,
  prerotation, update-key signatures, via `@interop/did-method-webvh`) rules out
  a forged controller document. Verified documents are cached per storage
  backend on a short TTL and invalidated by any write, delete, or import that
  could change the log.

## 0.15.0 - 2026-07-23

### Added

- **List Collections now reports each Collection's `public` flag inline.** Every
  item in the List Collections response carries `public` -- `true` iff a
  `PublicCanRead` access-control policy is attached to that Collection, `false`
  otherwise (expressed, not omitted). Clients rendering a Collection browser no
  longer need one policy probe per listed Collection (an N+1). Only the page's
  Collections are probed: the filesystem backend reads each page item's policy
  alongside its description, and the Postgres backend resolves the whole page in
  a single batch query over its ids. Unrecognized policy types fail closed to
  `false`.

### Changed

- **Test-suite hardening (test-only; no runtime changes).** Added wire-level
  coverage for Space export/import (authz 404 masking, the `application/x-tar`
  response type, a streamed round-trip asserting the `ImportStats` shape, and
  the remaining `invalid-import` error shapes). Added wire-level regression
  guards for the last uncovered error classes: `InvalidCollectionError`
  (bodyless or JSON-`null` Update Collection body) and the recorded finding that
  `EncryptionImmutableError` is masked over the wire by the fail-closed
  `unsupported-encryption-scheme` 400 while only one scheme is registered (the
  reachable wire shape is pinned instead). Cleaned up weak and duplicated tests:
  the public-read Resource case now genuinely exercises an unauthenticated read,
  the standalone list-collections suite was folded into the collection suite,
  the served `version` is now asserted against `package.json` instead of a
  tautological type check, and shared revocation/pagination test setup was
  deduplicated into `test/helpers.ts`.

## 0.14.0 - 2026-07-22

### Changed

- **A Collection query with no `profile` member is now rejected with 400
  `invalid-request-body`** (pointer `#/profile`) instead of 501
  `unsupported-operation`: the Query Profile Registry marks `profile` REQUIRED,
  so omitting it is a malformed request, distinct from naming a profile the
  server does not serve (which keeps answering 501).
- **Differentiated `controller-mismatch` failure causes.** Per the spec's SHOULD
  (Create Space Errors and the error registry), a failed delegated consent
  verification (Create Space via POST or create-via-PUT, Create Keystore) now
  names the cause in the non-normative `detail` string via a static pre-triage
  of the submitted chain: a chain rooted at a different target, a base
  delegation signed by a DID other than the body's controller, an expired
  delegation, or -- when nothing is statically wrong -- a failed proof. The
  `controller-mismatch` error type and 400 status are unchanged, and a
  capability that cannot be decoded keeps the generic detail.

## 0.13.0 - 2026-07-21

### Added

- **Scheme-version rail for the Collection `encryption` marker.** The marker
  gains an optional `version` member (the encryption scheme's version). When
  present it must be a positive safe integer, else `invalid-request-body` (400,
  pointer `#/encryption/version`). Once a marker has `version` set, an update
  may neither remove it nor decrease it -- the same never-backwards rule as
  `currentEpoch` -- while raising it is allowed as a future migration; either
  violation is `invalid-request-body` (400, pointer `#/encryption/version`). The
  transition check runs inside `writeCollection`'s in-lock `assertTransition`
  callback, so it holds under concurrent marker writes. The value is stored
  opaquely, as the marker's other public-reference fields are.

## 0.12.0 - 2026-07-20

### Added

- **Cursor pagination for the List Collections
  (`GET /space/{spaceId}/collections/`) and List Spaces (`GET /spaces/`)
  operations.** Both accept the optional `limit` / `cursor` query parameters and
  return one keyset-ordered page (ascending by id, code-unit order) at a time,
  with a `next` continuation link when a further page may follow -- the same
  profile the List Collection operation already uses. `limit` defaults to 100
  and clamps to 1000; a malformed cursor is rejected with `invalid-cursor`
  (400), after authorization, so an under-authorized caller still gets the
  merged 404. The `limit` / `cursor` parameters select a page within an
  already-authorized target and do not change the capability target, so a `next`
  link verifies against the same bare list capability.
  - List Spaces paginates in the request handler, since the page is a page of
    the Spaces the caller is authorized to see (per-controller authorization
    filtering happens there); it emits `totalItems` only on a complete,
    unpaginated listing (no cursor and no `next`), since computing the true
    total would mean verifying every candidate controller. An anonymous request
    still returns the empty listing without validating a cursor.

### Changed

- The `StorageBackend.listCollections` port now accepts
  `{ spaceId, limit?, cursor? }` and returns the paginated `CollectionsList`
  (`{ url, totalItems, items, next? }`) instead of a bare `CollectionSummary[]`;
  both the filesystem and Postgres backends implement it with the shared keyset
  machinery, and the filesystem backend now sorts Collections in code-unit order
  (matching the cursor seek). Internal full-Space enumerations (import and
  create count-quota checks) read every Collection through a dedicated
  unpaginated path, so they are never truncated to a page.

## 0.11.0 - 2026-07-19

### Added

- **The `equality` query profile (the `equality-query` backend feature).** A
  plaintext Collection can now declare which top-level attributes the server
  extracts and indexes, and answer server-side equality queries over them at
  `POST /space/{spaceId}/{collectionId}/query` with `{ "profile": "equality" }`.
  The body carries exactly one of `equals` (a disjunction of `{ name: value }`
  conjunctions) or `has` (attributes that must be present), plus optional
  `count`, `limit`, and an opaque `cursor`; matching is strict JSON equality
  (`"1"` never matches `1`; a multi-valued array attribute matches any element)
  and a query naming an attribute the Collection does not declare is rejected
  fail-closed (`invalid-request-body`, 400). The response is a
  `{ documents: [{ id, data?, custom? }], hasMore, cursor? }` page in ascending
  Resource-id order (`data` for JSON Resources, `custom` for any Resource with
  custom metadata -- so blob Resources are queryable through their `custom`
  tags), or `{ count }`. Unlike the client-computed `blinded-index` profile, the
  server does the extraction, so a plain Resource write is immediately
  queryable; the profile is capability-or-policy readable like List Collection,
  and an encrypted Collection answers `unsupported-operation` (501). Both
  first-party backends evaluate through one shared module so their semantics
  cannot drift.
- **The `indexes` Collection Description property.** A plaintext Collection opts
  in by declaring `indexes`: an array of attribute-name strings, or objects
  `{ name, source: "content" | "custom", unique: true }` where `source` (default
  `content`) names where the attribute is extracted from -- a JSON Resource's
  content, or any Resource's `custom` metadata object. Declared names must be
  unique across the array. Unlike `encryption`, `indexes` is updatable (entries
  may be added or removed); it MUST NOT be combined with an `encryption` marker
  (rejected `invalid-request-body`, 400, in both directions). An entry marked
  `unique: true` claims per-Collection uniqueness for that attribute's
  `(name, value)` pairs: a content or metadata write whose extracted value is
  already held by a different Resource is rejected with `id-conflict` (409),
  enforced atomically with the write; adding a unique claim to a Collection
  whose stored Resources already violate it is likewise rejected (409).
- **The GET `filter[attr]=value` equality filter on List Collection.**
  `GET /space/{spaceId}/{collectionId}/?filter[attr]=value` runs the equality
  profile over the same machinery from the anonymous, HTTP-cacheable listing
  endpoint: it answers the same document page. Every filter attribute must be
  declared in the Collection's `indexes` (fail-closed 400); on a `PublicCanRead`
  Collection the filter query needs no capability, so a cache can serve it.

## 0.10.2 - 2026-07-23

### Changed

- Protocol conformance testing now uses the extracted
  `@interop/was-conformance-suite` package (devDependency) instead of the
  in-tree `conformance/` directory, which has been removed. `pnpm conformance`
  now runs the package's `was-conformance` CLI (URL passed positionally;
  `TEST_SERVER_URL` / `TEST_ONBOARDING_TOKEN` env vars still work as fallbacks),
  and `pnpm conformance:local` still spins up a matched local server but
  delegates the test run to the CLI, forwarding any extra arguments. CI now
  exercises the production build against the CLI twice -- open provisioning and
  onboarding-token-gated -- and uploads the JSON conformance reports as build
  artifacts.

## 0.10.1 - 2026-07-19

### Fixed

- CORS registration now sets `exposedHeaders: ['Location', 'ETag', 'Link']`, so
  browser-based clients can read the `Location` header on space/resource
  creation, `ETag` for metaVersion concurrency, and `Link` for pagination and
  policy linkset discovery. Previously these were blocked by the default CORS
  response-header allowlist, breaking browser wallets.

## 0.10.0 - 2026-07-19

### Added

- **Chunk addressing for chunked Resources (the `chunked-streams` backend
  feature).** A Resource can now carry an ordered set of opaque chunks,
  addressed at
  `PUT|GET|HEAD|DELETE /space/{spaceId}/{collectionId}/{resourceId}/chunks/{n}`
  with a discovery listing at `.../chunks/` (JSON
  `{ resourceId, count, chunks: [{ index, size, contentType, version }] }`; the
  no-slash form 308-redirects to the container form). A chunk body is raw bytes
  plus a content-type, stored exactly like a binary Resource representation --
  the server never parses or reassembles chunks, so any encryption framing (e.g.
  an EDV `{ index, offset, sequence, jwe }` chunk document, or a future
  authenticated per-chunk AEAD layout) is purely a client concern. Both backends
  implement and advertise the feature, which completes the spec's four-token
  `features` vocabulary (`conditional-writes`, `changes-query`,
  `blinded-index-query`, `chunked-streams`).
- Chunk semantics: every chunk operation requires its parent Resource to exist
  (404 otherwise -- chunks cannot be orphaned, and an orphan left by out-of-band
  state is unreadable), each chunk carries its own monotonic `ETag` and honors
  `If-Match` / `If-None-Match` (412 on mismatch), oversized chunk bodies reuse
  the per-upload cap (`payload-too-large`, 413), and -- unlike Delete Resource
  -- deleting an absent chunk is a 404, so a reassembling reader can distinguish
  "gone" from "never written". A non-canonical `{n}` (negative, non-integer,
  leading zeros) or one above 2^31-1 is a 400 (both backends enforce the same
  index range). Deleting the parent Resource cascade-deletes its chunks; chunk
  bytes count toward Space/Collection usage and quotas; Space export archives
  carry chunk files and imports restore them (skip-not-overwrite, both backends,
  cross-backend compatible), holding each restored chunk to the same
  canonical-index rule as the live route and skipping orphan chunk files whose
  parent Resource is absent or tombstoned. Chunk writes and deletes never
  surface on the `changes` feed (per spec): a replicating client finishes a
  chunked write by `PUT`ting the parent Resource's own content, which does.
- Authorization follows the existing exact-match model: chunk writes are
  capability-only and chunk reads capability-or-policy, each against the chunk's
  own full URL (or the `chunks/` container URL for the listing), with the parent
  Resource's policy governing reads.

### Fixed

- Postgres backend: the Space's `usage_bytes` quota counter no longer
  over-counts when two writers race to create the same not-yet-existing
  Resource. Under `READ COMMITTED` a `SELECT ... FOR UPDATE` on an absent row
  locks nothing, so both creators read "no prior row" and both counted their
  full byte size as the usage delta, permanently inflating the counter by one
  write's size. Same-key creates now serialize on a transaction-scoped advisory
  lock and re-read the row under lock, so the second writer's precondition,
  version, and usage delta are all computed from the first writer's committed
  row.

### Added

- **Offline re-encryption tool for at-rest WebKMS key records**
  (`pnpm reencrypt-kms-records [--dry-run] [--data-dir <path>]`,
  `scripts/reencrypt-kms-records.ts`). With the server stopped, it walks every
  stored key record, decrypts each through the configured KEK registry
  (plaintext records pass through), and rewrites it in place under the current
  KEK -- or back to plaintext under `KMS_RECORD_CURRENT_KEK=none`. This is what
  makes a rotation finishable: records written before encryption was enabled (or
  under a since-rotated KEK) can now be re-wrapped, so an old KEK can finally be
  retired from `KMS_RECORD_KEKS`, and the decrypt-only wind-down can end with
  the KEK variables dropped entirely. Idempotent (records already in the target
  form are untouched); filesystem backend only (refuses to run when
  `DATABASE_URL` is set).
- **ZCap revocation on the PWS route families.** A capability delegated from a
  Space's root capability can now be revoked, via
  `POST /space/:spaceId/zcaps/revocations/:revocationId` -- the sibling of the
  existing `/kms` revocation endpoint, and the same wire contract
  (`:revocationId` is the to-be-revoked capability's id, URL-encoded; the body
  is that capability, verbatim; success is 204). Previously the only lever
  against a leaked Space or Collection capability was a short `expires` and
  waiting it out. The submission is authorized under the dual-root rule: an
  invocation rooted in the Space, or in the revocation URL itself, whose
  synthesized root is controlled by every controller in the to-be-revoked
  capability's chain -- so a delegee can revoke its own capability without
  holding a separate one. A root capability is never revocable; resubmitting a
  stored revocation is a 400.
- A revoked capability is rejected from then on wherever a Space-rooted chain is
  verified: the write and privileged routes, and the capability leg of the read
  routes. Because access-control policies are permissive, revoking a capability
  withdraws only what that capability granted -- access a policy already grants
  everyone (a public-readable Space) is unaffected.
- Space exports carry the Space's revocation records (top-level `revocations/`
  entries in the archive, on both backends), and imports restore them under the
  destination Space's scope -- so an export/import round-trip (backup/restore,
  backend migration) does not resurrect a revoked capability. Archives from
  servers that predate this carry none and import as before.
- **Multi-recipient encrypted Collections and key epochs.** An encrypted
  Collection's `encryption` marker may now carry per-epoch wrapped collection
  keys -- `epochs` (each an `{ id, recipients }`, where a recipient is the JWE
  recipients-entry shape: a `header` with `kid` / `alg` plus a wrapped
  `encrypted_key`) and a `currentEpoch`. Each app holds its own key-agreement
  key and gets the epoch key wrapped to it, so adding a reader wraps the current
  key to it and removing one appends a fresh epoch that excludes it. The server
  never holds a key: it validates only the marker's shape (recipients are
  well-formed, `currentEpoch` names an epoch that exists) and enforces two
  safety rails on update -- `epochs` is append-only and `currentEpoch` never
  moves backwards -- rejecting a violation with `invalid-request-body` (400).
  Recipient churn within an epoch stays a free update (the set-once check is
  still scheme-only).
- A Resource may declare the key epoch its content was encrypted under, so a
  reader picks the right key before attempting decryption: a `WAS-Key-Epoch`
  request header on a content write (working uniformly for JSON, raw-stream, and
  multipart writes), or a top-level `epoch` member on a `PUT .../meta` body. The
  value is advisory client-declared metadata -- the server stores it opaquely,
  never computing or verifying it, and requires only that a present value be a
  non-empty string (400 otherwise). A content write stores the header's value
  and clears the stamp when absent (the new ciphertext's epoch is unknown); a
  metadata write preserves the stored value unless the body supplies a new one.
  The stamp is returned by `GET .../meta`, rides each List Collection item and
  each `changes`-feed document, and survives a Space export/import round-trip,
  on both backends.
- **Conditional Collection Description writes.**
  `PUT /space/:spaceId/:collectionId` now honors an `If-Match` precondition
  against the Collection Description's monotonic version, evaluated atomically
  with the write (a stale validator is `precondition-failed`, 412), and every
  create/update surfaces the new version as an `ETag` header -- as does `GET` of
  the Collection. This gives recipient edits a compare-and-swap so two clients
  concurrently changing the marker cannot silently clobber one another; an
  unconditional `PUT` still works exactly as before. Both backends advertise the
  `key-epochs` feature token.
- **Multi-KEK registration for at-rest key-record encryption.** An operator can
  now register more than one key-encryption key (KEK) for the WebKMS key-record
  cipher, so a rotation adds a new KEK while keeping the old one available to
  decrypt records already written under it. Two new env variables join the
  existing `KMS_RECORD_KEK` (which stays the single-KEK alias):
  `KMS_RECORD_KEKS` takes a comma-separated list of AES-256 Multikey KEKs -- the
  first entry is the current KEK by default, so a rotation is "prepend the new
  KEK, keep the old one behind it"; `KMS_RECORD_CURRENT_KEK` optionally names
  which registered KEK wraps new records (a `urn:kek:sha256:` id, a multibase
  value, or the literal `none`). `none` selects a decrypt-only posture: existing
  encrypted records still read, but new key records are written plaintext -- the
  path for winding encryption back down. Malformed or ambiguous configuration
  (both single and list forms set, a current-KEK reference that matches nothing,
  a duplicate list entry) fails fast at startup without echoing any secret.

### Changed

- The revocation store (`StorageBackend.insertRevocation` / `isRevoked`) is now
  keyed on a `RevocationScope` -- a keystore or a Space -- rather than a
  keystore id. A revocation stored under one scope has no effect on the other;
  Space revocations live outside the Space's own tree and are deleted with the
  Space.

### Fixed

- **Space exports are now byte-reproducible.** Every entry in an export archive
  is written with a fixed `mtime` (the Unix epoch) instead of the wall-clock
  time it was packed, on both backends. Previously two exports of an unchanged
  Space differed whenever they straddled a one-second boundary, which made
  byte-for-byte comparisons of consecutive exports intermittently fail. An
  export is now a pure function of the Space's contents -- content-addressable
  and diff-stable. The timestamp carried no meaning on import.

## 0.9.0 - 2026-07-09

### Added

- **Server-managed `createdBy` provenance on Spaces, Collections, and
  Resources.** A read-only `createdBy` (a `did:key` DID string) now records who
  created each Space, Collection, and Resource: taken from the invoker of the
  _first_ write (the capability's signing key, fragment stripped) and preserved
  verbatim on every later write, so it names the creator rather than the last
  writer. It is server-authoritative -- a `createdBy` supplied in a client's
  request body is always dropped, never honored -- and is omitted/absent when
  there was no resolved invoker (a token-provisioned Space create, or data
  written before this change). Recorded only when a write _creates_ the record:
  an object created without an invoker keeps an absent `createdBy` forever,
  rather than a later writer being backfilled as its creator. A soft-deleted
  Resource keeps its `createdBy` on its tombstone, so re-creating it under a
  different invoker still reports the original creator; export/import
  round-trips the value. Surfaced in `GET /space/:spaceId`,
  `GET /space/:spaceId/:collectionId`, and
  `GET /space/:spaceId/:collectionId/:resourceId/meta`, and echoed in the 201
  body of Create Space / Create Collection so a create response and a subsequent
  GET agree. The `changes` query profile carries it on live documents and on
  tombstones, so a replica learns each Resource's creator from the feed rather
  than fetching `/meta` per Resource.

### Changed

- The `changes` query profile's response documents are now typed by the shared
  `ChangeDocument` / `ChangesPage` wire shapes from `@interop/storage-core`,
  rather than an inline shape. The `StorageBackend.changesSince` port keeps its
  own (differently named) document shape: it is the storage contract, not the
  wire model.

- **Blinded-index EDV query (the `blinded-index` query profile /
  `blinded-index-query` feature).** The reserved Collection
  `POST /space/{s}/{c}/query` endpoint gains a second profile alongside
  `changes`: the EDV blinded-attribute query. A body of
  `{ profile: 'blinded-index', index, equals | has, count?, limit?, cursor? }`
  is evaluated against the HMAC-blinded `indexed` entries of the Collection's
  stored documents (the envelopes `@interop/edv-client`'s IndexHelper produces):
  `equals` is an OR across array elements of an AND within each element's
  blinded `{name: value}` pairs, scoped to the `index` HMAC key id; `has`
  requires every named blinded attribute be present. Matching is opaque string
  comparison -- the server performs no cryptography and never sees plaintext
  attribute names or values, so it is agnostic to the client's
  attribute-blinding version. The response is `{ documents, hasMore, cursor? }`
  -- the matching stored documents verbatim, ascending by resource id -- or
  `{ count }` for a count query. Pagination closes the known EDV protocol gap
  (`limit` + `hasMore` with no way to resume) by reusing PWS's opaque cursor
  convention: `cursor` is present iff `hasMore`, and echoing it back in the next
  query body resumes the scan. Query parameters ride the signed JSON POST body
  (covered by the `Digest`); authorization is capability-or-policy with the same
  read semantics as List Collection (an under-authorized caller receives a 404).
  A malformed query body is a 400 `invalid-request-body`; a malformed cursor is
  a 400 `invalid-cursor`; an unknown profile, or a backend without the
  affordance, stays 501 `unsupported-operation`.

  Implemented as an optional `StorageBackend.queryByBlindedIndex` method, served
  by both first-party backends through a shared evaluator
  (`src/lib/blindedIndex.ts` -- validation, matching, ordering, and cursor
  pagination in one place, so the backends cannot drift), with a full-scan
  strategy deliberate for these teaching backends. Both backends now advertise
  `features: [..., 'blinded-index-query']`. Covered by a new backend-contract
  block (run against filesystem and Postgres) and a `blinded-index-query-api`
  integration suite.

- **`unique: true` blinded-attribute enforcement on write.** The other half of
  the EDV blinded-index affordance: a Resource write whose `indexed` blinded
  attributes include one marked `unique: true` is rejected with **409**
  (`UniqueAttributeConflictError`, reusing the `id-conflict` problem type like
  the WebKMS conflicts) when another live JSON document in the same Collection
  already claims the same triple. Semantics match the EDV reference servers
  exactly: a conflict requires `unique: true` on **both** sides (an existing
  document carrying the same pair without `unique` does not conflict), the claim
  is keyed on the full **(HMAC key id, name, value)** triple (the same pair
  under a different HMAC key is no conflict), a document keeping its own unique
  attribute across an update never self-conflicts, enforcement applies to create
  and update alike, and a tombstoned holder frees its claim. The check is atomic
  with the write: only unique-carrying JSON writes pay for it -- the filesystem
  backend serializes them per Collection on its keyed mutex (nested outside the
  ordinary per-Resource lock), and the Postgres backend takes a per-Collection
  transaction-scoped advisory lock (held to commit, so of N racing claimants
  exactly one wins) -- so plain writes keep their existing locking. The conflict
  scan lives with the query evaluator in `src/lib/blindedIndex.ts`
  (`collectUniqueBlindedTerms` / `assertNoUniqueBlindedConflict`), shared by
  both backends. When a unique conflict and a failing `If-Match` both apply, the
  409 wins over the 412 (both backends agree; pinned by the contract suite).
  Space import (tar merge) bypasses `writeResource` and therefore does not
  enforce the invariant -- imports restore a controller's own export, matching
  the check's write-path scope. Covered by a new backend-contract block
  (including an N-concurrent- claimants race) and an API-level 409 test.

- **Config validation & fail-fast startup.** The whole env surface
  (`SERVER_URL`, `PORT`, `DATABASE_URL`, `STORAGE_LIMIT_PER_SPACE`,
  `MAX_UPLOAD_BYTES`, `WAS_ENABLED_BACKENDS`, `KMS_RECORD_KEK`,
  `WAS_ONBOARDING_TOKEN`) is now read and validated in one place,
  `loadConfigFromEnv()` (`src/config.default.ts`), consumed by `start.ts`.
  `SERVER_URL` is required (unset previously started a server whose ZCap
  matching silently failed on every request) and must be an absolute
  `http:`/`https:` URL with no path, query, or fragment -- a sub-path
  `SERVER_URL` would silently break every delegated invocation and `Location`
  header (the URL-join sites drop a base path), so it is rejected at startup
  instead. `PORT` is validated as an integer in 1-65535 (default 3002). The
  `fastifyWas` plugin applies the same `serverUrl` shape check at registration
  (`assertValidServerUrl`), so a downstream composition inherits the fail-fast
  behavior; omitting `serverUrl` there remains allowed (test compositions).

- **Provisioning gate (`authorizeProvisioning` / `WAS_ONBOARDING_TOKEN`).** A
  new seam that lets a deployment gate the two open provisioning endpoints
  (`POST /spaces/` and `POST /kms/keystores`) without touching the rest of the
  ZCap surface. The `fastifyWas` plugin gains an `authorizeProvisioning`
  callback (`{ request }` in, `'verify'` / `'grant'` / `'deny'` out -- or a
  thrown `ProblemError`) plus a built-in, off-by-default onboarding-token check
  (`onboardingToken` option / `WAS_ONBOARDING_TOKEN` env), implemented as a
  stock authorizer over that same seam (`onboardingTokenAuthorizer`, exported):
  when a token is set, the two endpoints require an
  `Authorization: Bearer <token>` header (timing-safe compared), which then
  substitutes for ZCap verification on that request while every other operation
  keeps its normal capability-invocation path. The two options are mutually
  exclusive (rejected at startup). Default behavior (neither configured) is
  unchanged -- provisioning stays open, authorized by proving control of the
  body's `controller` DID (the teaching default). Adds `src/provisioning.ts`.
  The conformance suite's high-level `WasClient` suites now provision Spaces
  through the token path when `TEST_ONBOARDING_TOKEN` is set (a shared
  `provisionSpace` helper), so the full suite passes against a token-gated
  server:
  `WAS_ONBOARDING_TOKEN=abc TEST_ONBOARDING_TOKEN=abc pnpm conformance:local`.

- **WebKMS List Keys (`GET /kms/keystores/:keystoreId/keys`).** A fork extension
  beyond upstream webkms-switch (which has no key list): enumerates a keystore's
  public key descriptions — the Get Key Description projection per key
  (`describeKmsKey`, never a secret field) plus `keyUrl`, the key's canonical
  invocation URL (`<keystoreId>/keys/<localId>`), which the `publicAlias` /
  `publicAliasTemplate` override otherwise erases from `id` — exactly the handle
  a recovery client needs to rediscover — sorted by local id and paginated with
  the standard opaque cursor (`KEY_LIST_LIMIT` per page; an empty keystore
  returns `{ results: [] }`, not 404). Capability-verified as `read` against the
  keystore controller with `<keystoreId>/keys` accepted as an attenuated target,
  so a `sign`-scoped delegation on one key URL still cannot enumerate the
  keystore. Adds `listKeys` to the `StorageBackend` contract (both backends) and
  `KeyRequest.list`.

- **PostgreSQL storage backend (`DATABASE_URL`).** A second first-party
  `StorageBackend` (`src/backends/postgres.ts`, schema in
  `src/backends/postgresSchema.ts`), implementing the full PWS + WebKMS surface
  over rows and selected by setting `DATABASE_URL` (unset keeps the default
  filesystem backend). Four deliberate design departures: **transactional quota
  accounting** (`spaces.usage_bytes`, maintained in the same transaction as
  every content write/delete -- the per-Space capacity is now a _hard_ limit
  under concurrency, closing the filesystem backend's documented soft-limit
  caveat); **row-lock concurrency** (`SELECT ... FOR UPDATE` transactions
  replace the single-process `KeyedMutex`, so conditional writes stay correct
  across multiple server processes sharing one database); **buffered `bytea`
  blobs** (bounded by `maxUploadBytes`, which defaults to a 64 MiB cap on this
  backend rather than "unbounded"; chunked-row streaming is a planned
  follow-up); and **cross-backend export/import** (the same tar archive dialect
  as the filesystem backend, so a Space exported from one imports into the other
  -- the migration path in both directions -- with the Postgres apply loop
  additionally atomic in one transaction). Embedded idempotent migrations run at
  startup under an advisory lock; `ORDER BY` / keyset columns are `COLLATE "C"`
  so pagination and change-feed ordering match the filesystem's code-unit order
  exactly. New optional `StorageBackend.init()` / `close()` lifecycle hooks
  (wired by the plugin), `PostgresBackend` exported from the package root, and a
  new shared backend-contract test suite (`test/storage-backend-contract.ts`)
  run against both backends -- opt-in for Postgres via `WAS_TEST_DATABASE_URL`
  (`pnpm test:pg`), with per-suite throwaway schemas for isolation. Shared logic
  extracted so the two backends cannot drift: precondition evaluation
  (`src/lib/preconditions.ts`), quota report derivation
  (`src/lib/backendUsage.ts`), export manifest building
  (`src/lib/exportManifest.ts`), and page-size clamping
  (`src/lib/pagination.ts`).

- **At-rest encryption of WebKMS key records (`KMS_RECORD_KEK`).** The optional,
  schema-compatible hardening increment: when a record KEK is configured, the
  secret-bearing fields of a stored `/kms` key record (`privateKeyMultibase` /
  `secret`, and anything not on the plaintext allowlist) are envelope-encrypted
  -- a fresh per-record `A256GCM` content-encryption key wrapped `A256KW` under
  a config-supplied AES-256 KEK -- before the record reaches storage, so a
  disk/database dump exposes only ciphertext and a `kekId`. It is **off by
  default** (plaintext when unset, the teaching default), needs **no schema
  migration** to enable (old plaintext records stay readable via an
  unconditional decrypt pass-through, and are never retroactively rewritten),
  and supports **KEK rotation without re-encryption** (each record keeps the
  `kekId` it was written under). The wire projection (`KmsKeyDescription`) is
  untouched: secrets never crossed the wire and still don't. New pure,
  backend-agnostic cipher `src/lib/kmsRecordCipher.ts`, applied at the KMS
  orchestration seam in `src/requests/KeyRequest.ts` (encrypt before
  `insertKey`, single decrypt funnel after `getKey`). See the `KMS_RECORD_KEK`
  environment variable in the README.

- **Library entry point (`src/index.ts`) and package `exports` map.** The
  package is now consumable as a dependency, not only runnable standalone:
  `import { fastifyWas, createApp, FileSystemBackend, defaultBackend } from 'was-teaching-server'`,
  plus the `StorageBackend` contract (and the rest of the domain types) and the
  typed protocol errors. The entry point also loads the Fastify module
  augmentation, so a consumer sees the decorated `FastifyInstance` typed. `tsc`
  now emits declarations (`declaration` / `declarationMap`), and `package.json`
  gains `main` / `types` / `exports` pointing at `dist/`, plus a `files`
  allowlist (`dist`, `common`, `src` -- so the emitted source/declaration maps
  resolve -- and `CHANGELOG.md`) so the published tarball excludes the test
  suites. Usage (including composing a minimal or hardened server from the
  plugin) is documented in `docs/consuming-server-as-library.md`.

### Security

- **Default-on limits.** The server no longer runs unbounded out of the box:
  - `MAX_UPLOAD_BYTES` now defaults to **64 MiB** on both backends (previously
    unset meant no cap on the filesystem backend, and the catch-all binary
    content-type parser hands the handler a raw stream that bypasses Fastify's
    `bodyLimit` entirely -- so a raw blob PUT/POST had no size limit at all, and
    an unbounded multipart part could buffer without limit). Set
    `MAX_UPLOAD_BYTES=unlimited` to opt out explicitly (filesystem backend only:
    the Postgres backend buffers each upload in memory as a single `bytea` and
    rejects `unlimited` at startup).
  - New **count quotas**, default-on: `MAX_SPACES_PER_CONTROLLER` (100),
    `MAX_COLLECTIONS_PER_SPACE` (100), and `MAX_RESOURCES_PER_SPACE` (10000,
    live Resources across a Space's Collections; tombstones don't count). A
    create beyond a limit is rejected with a 507 `quota-exceeded` problem
    (`CountQuotaExceededError`, exported); overwrites never trip a count check,
    deletes free slots, and the tar import path enforces the Collection/Resource
    counts identically on both backends. Enforcement is transactional (hard
    under concurrency) on Postgres -- Space counts serialize on a per-controller
    advisory lock, and the `spaces` table gains a backfilled, indexed
    `controller` column (automatic migration) -- and soft on the filesystem
    backend, matching the byte quota's posture. Each accepts `unlimited` to opt
    out. Matching `fastifyWas` plugin options (`maxSpacesPerController` /
    `maxCollectionsPerSpace` / `maxResourcesPerSpace`) apply to the default
    backend; both backend constructors take them directly. Pinned by the shared
    backend contract suite for both backends.
  - `STORAGE_LIMIT_PER_SPACE` stays unlimited when unset, but startup now logs a
    **warning** prompting an explicit choice;
    `STORAGE_LIMIT_PER_SPACE=unlimited` acknowledges and silences it (the
    warning lives in `start.ts` only, so library and test compositions stay
    silent). A startup warning is also logged when the per-upload cap is
    explicitly disabled.
- **`StorageError` responses no longer leak internal fault details.** The 500
  `storage-error` problem+json body copied the underlying cause message into its
  `title` and `detail`, so filesystem paths, errnos, or SQL fragments from a
  failed backend operation could reach clients. The wire body is now a generic
  "An internal storage error occurred."; the underlying `cause` still goes to
  the server log via `handleError`. Pinned by a no-leak regression test.
- **`/api/cors` proxy is no longer an open SSRF vector.** The proxy now only
  fetches `http`/`https` URLs and refuses any host that resolves to a private,
  loopback, or link-local address (RFC 1918, `127.0.0.0/8`, `169.254.0.0/16`
  cloud-metadata, CGNAT, IPv6 ULA/link-local, and IPv4-mapped forms), so a
  request like `?url=http://169.254.169.254/...` is rejected before any fetch.
  Redirects are now followed manually (capped at 5 hops) with every hop
  re-validated the same way, closing the bypass where an allowed public URL 302s
  the proxy to an internal address. (Adding a lightweight auth gate remains a
  reasonable follow-up.)
- **`/api/cors` proxy hardening: DNS-rebinding protection and a response size
  cap.** Two remaining gaps in the CORS proxy are closed. The SSRF host check
  validated the resolved addresses but the subsequent `fetch` re-resolved DNS
  independently, so a rebinding attacker could pass validation with a public IP
  and have the connection land on a private one (a TOCTOU); the proxy now pins
  each hop's connection to exactly the addresses it validated -- a per-request
  undici `Agent` whose `connect.lookup` resolves only from that pin map -- while
  keeping the original hostname on the wire so TLS certificate validation and
  SNI still work. The relayed response body is now capped at 10 MiB, enforced
  both from a declared `content-length` (rejected before reading the body) and
  incrementally while streaming (the upstream stream is cancelled once the cap
  is exceeded); an oversized response is a 502. Uses undici's `fetch` so the
  dispatcher and fetch share one build.
- **Streamed and binary request bodies are now bound to their signed `Digest`.**
  Previously only JSON/text bodies were recomputed and compared; an
  `application/octet-stream`, image, multipart, or tar body could be swapped
  under a valid signed `Digest`. Such bodies now pass through a hashing
  transform that verifies the digest incrementally at end-of-stream, failing the
  write on a mismatch (the partial file is removed).
- **KMS "unsupported key type / operation" gate is no longer bypassable via
  prototype-chain names.** `generateKmsKey` and `runKeyOperation` now guard with
  `Object.hasOwn`, so a client-supplied `type`/operation of `constructor`,
  `toString`, etc. is rejected as unsupported rather than resolving to an
  inherited `Object` member.
- **Backend-id enumeration is closed on Collection create/update.** The
  backends-available check now runs after capability verification (like the
  `id-conflict` / `encryption-immutable` conflicts), so an unauthorized caller
  can no longer probe a Space's registered backend ids by distinguishing a `409`
  from the masked `404`.

### Fixed

- **`FileSystemBackend.deleteSpace()` is idempotent.** Deleting an absent Space
  resolves instead of rejecting with `ENOENT`, matching the documented
  `StorageBackend` delete contract (pinned by the new backend-contract suite).
- **Slash/no-slash redirects now send a followable `Location`.** The
  canonicalization redirects emitted the literal route template (e.g.
  `Location: /space/:spaceId`) with a `302`; they now build the concrete request
  path (trailing slash toggled, query string preserved) and use `308` so a
  redirected POST/PUT replays its method and body. The List-Collections no-slash
  redirect is also registered as `GET` (it was mistakenly a `PUT`, so
  `GET /space/:id/collections` fell through to a `409`).
- **A description-less Collection directory no longer 500s the whole Space
  listing.** `listCollections` / `listCollectionItems` fall back to the
  directory name instead of dereferencing an undefined description.
- **`text/plain` (and other string-parsed) resource bodies are stored
  byte-for-byte.** A string body is written as its UTF-8 bytes rather than
  iterated per character, so multi-byte / astral-plane content is no longer
  corrupted.
- **Collection delete is idempotent.** Deleting an absent (or already-deleted)
  Collection resolves `204` instead of surfacing an `ENOENT` as a `500`.
- **Space import inherits the write-path guards.** Import now enforces the
  per-upload size cap (413) and fail-closed encryption conformance (422) on
  every staged resource, and no longer resurrects a tombstoned resource (it
  checks the metadata sidecar, not only the content file, before writing).
- **External-backend Collection listing no longer 500s.** `listCollectionItems`
  accepts the caller's control-plane Collection description, which a selected
  data-plane backend does not hold.
- **Malformed `Authorization` (missing `headers="..."`) is a clean `400`**
  rather than an unhandled `500`.
- **Repeated `?include=` on `/quotas` no longer 500s** (an unauthenticated-
  reachable fault on a public-readable Space); the value is normalized when the
  query parser yields an array.
- Typed backend errors are no longer flattened to `500` (or double-logged) by
  the Collection/Resource read/delete handlers; a memoized external-backend
  adapter logs with the stable instance logger rather than the first request's;
  a revocation with an unparseable `expires` no longer throws a `RangeError`;
  and zcap verification failures log the underlying error (object-first) instead
  of dropping it.

### Changed

- **Atomic, durable writes in the filesystem backend.** Every write the
  `FileSystemBackend` performs now goes through one audited helper module
  (`src/lib/atomicFile.ts`): bytes are staged into a `.tmp-<uuid>` file in the
  same directory, fsync'd, `rename`d (or hard-`link`ed, for the create-only
  `wx`-style key/revocation inserts, preserving their EEXIST conflict semantics)
  onto the final path, and the containing directory is fsync'd -- so a crash or
  power loss mid-write can no longer leave a torn JSON document or a truncated
  blob under a Resource's name. Previously, JSON resource bodies and
  `importSpace` writes went directly to the final path, and blob uploads
  streamed into it (with cleanup only on pipeline error, not crash); blobs now
  stream into the temp file and are committed whole. Descriptions, sidecars,
  policies, and keystore configs (previously written via fs-json-store, which
  was atomic per-file but never fsync'd the directory) route through the same
  helper; their read paths are unchanged. (The Postgres backend is unaffected --
  durability there is the database's WAL.)
- **The `conformance/` suite no longer pins the default backend's display name**
  (`Server Filesystem`); it asserts a non-empty `name` instead, so the suite
  passes against any conforming PWS server -- including a Postgres-backed one
  (`DATABASE_URL=... pnpm conformance:local`).
- **The PWS protocol surface is now a registerable Fastify plugin, `fastifyWas`
  (`src/plugin.ts`).** The plugin owns the `serverUrl` / `storage` /
  backend-provider decorations, CORS, multipart, the content-type parsers, and
  the route groups (the four PWS groups plus the WebKMS `/kms` facet) --
  everything from `routes.ts` down, including the per-group auth/digest hook
  chains and error handler. `createApp()` (`src/server.ts`) is now the thin
  community-edition composition: it registers `fastifyWas` (passing its options
  through unchanged) plus the teaching-server extras (static assets, welcome
  page, `/health`, the CORS proxy). No wire-behavior change; this is the
  enabling refactor for the two-codebase strategy -- a hardened downstream
  server can register the same plugin around its own persistence and policy
  plugins. Adds `fastify-plugin` as a dependency (the decorations/parsers land
  on the root instance, as before).

## 0.8.0 - 2026-07-02

### Added

- **Space-rooted delegated capabilities on the space-family routes.** Every
  `/space/:spaceId/...` route now also accepts a delegated capability chain
  rooted at the _Space's_ root capability with RESTful target attenuation -- the
  same shape the WebKMS keystore routes already allowed. A controller can
  delegate one capability for the whole Space (or, by attenuating the
  `invocationTarget` at delegation time, for a single Collection under it) and
  the delegate can invoke it against any URL underneath: resources, listings,
  `/meta`, the changes-query endpoint, `/quotas` (composing with the existing
  query-parameter attenuation). Root invocations of the exact target's own root
  capability verify unchanged, so this only widens what the Space controller can
  delegate, never who can access. Implemented as `verifyZcap`'s new
  `attenuatedRootTarget` option, threaded through `authorize()` and the
  `spaceContext` preludes; exercised by the new `test/session-zcaps.test.ts`
  suite (the browser-session-key shape: space-wide read + per-collection
  read/write, negative cases included -- notably that a collection-scoped
  capability cannot PUT the Space Description, and that only the Space root is
  accepted as a chain root).
- **WebKMS `/kms` facet: zcap revocations + delegation policy.** Delegated
  capabilities on the `/kms` facet can now be revoked, and every keystore-rooted
  verification enforces a unified delegation policy; driven end-to-end by
  `@interop/webkms-client`'s `revokeCapability` in the new
  `test/kms-revocation-api.test.ts` suite:
  - `POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId`
    (`:revocationId` = the URL-encoded id of the capability being revoked, which
    is also the request body; 204 on success). Authorization follows
    ezcap-express's `authorizeZcapRevocation` dual-root rule: the invocation may
    root in the keystore, or in the revocation URL itself, whose synthesized
    root capability is controlled by _every controller in the to-be-revoked
    capability's fully verified chain_ -- so a delegee can revoke its own zcap
    without holding a separate capability. The submitted chain must root in the
    keystore being posted to; root zcaps cannot be revoked (400); a chain
    containing an already-revoked link (resubmissions included) is a 400, with
    the 409 duplicate reserved for a write race.
  - Revocations are checked on every subsequent keystore-rooted invocation via
    the zcap library's `inspectCapabilityChain` hook (`src/lib/revocations.ts`;
    written route-family-agnostic so a later WAS-side store can reuse it).
    Storage is the new insert-once `StorageBackend` pair `insertRevocation` /
    `isRevoked`, unique on `(delegator, capability.id)` per keystore under
    `data/keystores/<localId>/revocations/`; records lapse one day past the
    capability's own `expires` (the filesystem analogue of a TTL index, pruned
    lazily on read).
  - Unified delegation policy on all `/kms` verifications: max chain length 10
    (`KMS_MAX_CHAIN_LENGTH`) and a single 90-day max delegation TTL
    (`KMS_MAX_DELEGATION_TTL`). The per-key `maxCapabilityChainLength` stored at
    generate time is now enforced at operation time.
  - `handleZcapVerify` now returns the verification result (the dereferenced
    chain feeds the per-key gate), and `verifyZcap` grew optional
    `inspectCapabilityChain` / `maxChainLength` / `maxDelegationTtl`
    pass-throughs -- absent on the PWS route families, whose behavior is
    unchanged. New runtime dependencies `@interop/zcap` and
    `@interop/jsonld-signatures` (both already in the tree transitively) power
    the revocation route's standalone `CapabilityDelegation` chain verification.

- **WebKMS `/kms` facet: local KMS module + key operations.** The `/kms` facet
  now generates and uses server-held keys, driven end-to-end by
  `@interop/webkms-client`'s `KeystoreAgent` and all four key classes
  (`AsymmetricKey`, `KeyAgreementKey`, `Hmac`, `Kek`) in the new
  `test/kms-key-api.test.ts` suite:
  - `POST /kms/keystores/:keystoreId/keys` (`GenerateKeyOperation`, responding
    200 + `Location` + `{ keyId, keyDescription }` per webkms-switch),
    `POST .../keys/:keyId` (operation dispatch by envelope `type`), and
    `GET .../keys/:keyId` (public key description; capability-verified with the
    `read` action). Every key route roots its capability in the **keystore** URL
    with the key URL accepted as an attenuated target (a new
    `allowTargetAttenuation` mode in `verifyZcap`); the expected zcap action is
    the decapitalized operation name (`generateKey`, `sign`, ...).
  - The single in-process `local-v1` module (`src/lib/kmsModule.ts`): Ed25519
    sign (via `@interop/ed25519-verification-key`), X25519 `deriveSecret` (via
    `@interop/x25519-key-agreement-key`, a new runtime dependency; raw ECDH, no
    KDF), HMAC-SHA-256 sign/verify and AES-256-KW wrap/unwrap (node crypto).
    Custody draws the line on what is served: asymmetric verify is client-local
    by design and requesting it is a clean 400 not-supported. `publicAlias` /
    `publicAliasTemplate` are applied to the description `id` at generate time
    and re-applied stably on every read.
  - Fixed: a wrong-length HMAC `signatureValue` is an ordinary
    `{ verified: false }` (not an uncaught `timingSafeEqual` throw), and a
    failed AES-KW unwrap resolves `{ unwrappedKey: null }`. A mismatched
    `deriveSecret` `publicKey.type` is likewise a clean 400.
  - Key records are stored using the `{ keystoreId, localId, meta, key }` shape
    (secret material included, plaintext this increment; `controller`
    deliberately not stored -- it is read live from the keystore config), as
    opaque units behind new insert-once `StorageBackend` methods (`insertKey` /
    `getKey`, with the protocol's 409 duplicate conflict) under
    `data/keystores/<localId>/keys/<keyLocalId>.json`. Wire projections never
    include secret fields.

- **WebKMS `/kms` facet: keystore lifecycle.** The server now hosts the first
  slice of the Interop TypeScript analogue of Digital Bazaar's WebKMS system,
  interoperating with `@interop/webkms-client@14.4.2` (whose `KmsClient` drives
  the new test suite, `test/kms-keystore-api.test.ts` -- the client is the
  conformance suite for this wire contract):
  - `POST /kms/keystores` (Create Keystore, 201 + `Location` + bare config;
    authorization is the chain-to-body-controller bootstrap rule, mirroring
    Create Space), `GET /kms/keystores?controller=<did>` (list-by-controller,
    `{ results }` capped at 100 -- you can only list your own),
    `GET /kms/keystores/:keystoreId` (bare config), and
    `POST /kms/keystores/:keystoreId` (update: `sequence` must be exactly
    previous+1 and `kmsModule` is immutable -- both gated atomically in storage
    with a 409 state conflict -- responding with the `{ config }` wrapper).
    Local ids follow webkms-switch's scheme (multibase base58btc,
    multihash-framed 128-bit random, via `@digitalcredentials/bnid`, now a
    runtime dependency).
  - The `/kms` route group is the first to use the strict `requireAuthHeaders`
    hook: every webkms route -- GETs included -- is zcap-invoked, with `read` /
    `write` zcap actions (not HTTP verbs); the protocol has no public reads.
    Unknown keystores and failed authorization stay masked as `not-found` (404),
    the server-wide convention.
  - Storage grows a keystore tree (`data/keystores/<localId>/config.json`, a
    sibling of `spaces/` -- the facet is deliberately separable) behind new
    `StorageBackend` methods (`writeKeystore` / `getKeystore` / `updateKeystore`
    / `listKeystoresByController`).

- **Operational `/health` liveness endpoint.** A public, unauthenticated,
  side-effect-free `GET /health` returns `200` with an `application/health+json`
  body (`{ "status": "pass", "version": ... }`, following the IETF
  `draft-inadarei-api-health-check` shape) so load balancers, uptime monitors,
  and orchestrators can poll cheaply; `HEAD /health` serves a bodyless `200` for
  probes that don't want a body. This is an operational affordance, not a PWS
  protocol feature. `scripts/conformance-local.ts` now polls `/health` for
  startup readiness instead of the HTML welcome page.

- **Encryption Scheme Registry enforcement (spec "Encryption Scheme
  Registry").** The server now provides the fail-closed guarantee that plaintext
  can never land in a Collection marked encrypted with a recognized scheme:
  - A Collection `encryption` marker is gated against a recognized-scheme
    registry (`SUPPORTED_ENCRYPTION_SCHEMES`; v1 has `edv` ->
    `application/json`). An unrecognized `scheme` is now rejected with the new
    `unsupported-encryption-scheme` (400) error rather than stored opaquely.
  - A Resource **content** write into a recognized-scheme Collection is
    structurally validated (`Create Resource` `POST`, `Put Resource` `PUT`): the
    request `Content-Type` MUST be the scheme's registered media type and the
    body MUST be a structurally valid envelope. For `edv` that is an **EDV
    Encrypted Document** -- a JSON object whose `jwe` member is a JWE in JSON
    serialization (`isValidEdvDocument` wrapping `isValidEdvEnvelope`, shape
    only, never decrypted) -- carried as `application/json`, matching what the
    EDV codec actually stores (the earlier bare-`application/jose+json` JWE
    profile was corrected to this before release). A non-conforming body (a
    plaintext object, or a bare JWE with no `jwe` wrapper) is the new
    `encryption-scheme-mismatch` (422). Checked after capability verification,
    so an under-authorized caller still receives the privacy-merged `not-found`
    (404).
  - Requires `@interop/storage-core` ^0.3.1 (adds the two new problem types).

- **Encrypted Resource Metadata profile (spec "Encrypted Collections").** On a
  Collection with a recognized `encryption` marker, a Resource's user-writable
  `custom` metadata is now stored as an encryption **envelope** (the same
  EDV-Document profile as content), symmetric with how content is stored:
  - `PUT .../meta` on an encrypted Collection validates `custom` structurally as
    a conforming envelope (`assertEncryptedMetaConforms`), rejecting a plaintext
    `{ name, tags }` (or any non-envelope) with `encryption-scheme-mismatch`
    (422), checked after auth + 404. The metadata document itself stays
    `application/json`; only its `custom` sub-value is the envelope. The server
    stores it opaquely and never decrypts. Plaintext Collections are unaffected
    (`{ name, tags }` validated as before).
  - The `/meta` sub-resource now carries its **own** monotonic `metaVersion`
    ETag (V2 metadata versioning), independent of the content `version`: a
    metadata-only write bumps `metaVersion` (and `updatedAt`) but leaves the
    content ETag untouched, and honors `If-Match` / `If-None-Match` on
    `metaVersion` (412 on mismatch), evaluated atomically under the per-Resource
    write lock. `GET .../meta` returns the `metaVersion` as its `ETag`.
  - The replication change feed (`changesSince`) now carries `metaVersion` and
    the `custom` envelope, so a metadata-only edit replicates alongside content
    (re-surfacing the Resource with a bumped `updatedAt` / `metaVersion` but
    unchanged `version` / `data`).
  - List Collection omits `name` from item summaries on an encrypted Collection
    (the server cannot project a name out of an opaque envelope).

### Fixed

- **Top-level falsy JSON Resources no longer 500.** Storing a bare top-level
  JSON `null` (and likewise `false`, `0`, `""`) into a plaintext Collection
  failed with a 500: the filesystem backend wrote JSON via `fs-json-store`,
  whose `write` re-reads through `readExisting`, which treats a falsy
  round-tripped value as "file does not exist". The backend now serializes and
  writes JSON Resource bodies directly (creating the Collection dir as needed),
  so any top-level JSON value -- object, array, or bare primitive -- round-trips
  intact.

## 0.7.0 - 2026-06-28

### Added

- **Collection client-side encryption marker (spec "Encrypted Collections").** A
  Collection may now carry a non-secret `encryption` marker (e.g.
  `{ "scheme": "edv" }`) declaring its Resources client-side encrypted. The
  server stores it opaquely (it never decrypts), validates only its shape
  (`invalid-request-body` 400 on a malformed marker), and enforces **set-once**
  immutability: declaring a marker on a Collection that lacks one is allowed,
  but changing its `scheme` or clearing it on an existing Collection is rejected
  with the new `encryption-immutable` (409) error. Accepted on Create Collection
  (`POST`) and Update Collection (`PUT`) and echoed in the Collection
  Description, so any authorized reader -- including a delegated consumer -- can
  discover it. New helper `src/lib/encryption.ts` (mirrors the `backend`
  validate/resolve pattern).
- **Per-Collection backend resolver (registered backends are now selectable).**
  A Collection may now **select** a registered `external` backend as its
  `backend`, and its **data plane** (resource bytes, metadata, listings, change
  feed) is routed to that backend's adapter, while the server `default` backend
  keeps the **control plane** (Space/Collection descriptions, policies, backend
  registry records). A new resolver (`src/lib/backendRegistry.ts`) maps a
  Collection's selected `backend.id` to a memoized `StorageBackend` adapter
  built from an injected **provider registry** (`createApp({ providers })`); for
  the `default` selection it short-circuits to the server backend, so existing
  behavior is unchanged. The production provider registry ships **empty**, so a
  Collection that selects an `external` backend with no registered provider
  adapter fails closed with `unsupported-backend` (409) on its data-plane
  operations until a provider is wired (stages 4-5: Google OAuth, Drive adapter,
  at-rest secret encryption). Still provider-agnostic plumbing -- no Google
  dependency.
- **Backend registration allowlist (`WAS_ENABLED_BACKENDS`).** An operator may
  restrict which backend `provider`s a wallet can register via a comma-separated
  env list; a registration whose `provider` is not listed is rejected fast with
  `unsupported-backend` (409). Unset means **permissive** (any provider may be
  registered), preserving prior behavior.

- **Backend registration write endpoints.** A wallet can now register an
  `external` ("Bring Your Own Storage") backend against a Space via
  `POST /space/{id}/backends`, replace it with
  `PUT /space/{id}/backends/{backendId}` (upsert), and deregister it with
  `DELETE /space/{id}/backends/{backendId}`. Authorization is the Space
  controller's capability (capability-only, like Create Collection / Delete
  Space). The write body is secret-bearing (a generic `provider` + `connection`
  envelope), but every response and the `GET /space/{id}/backends` listing
  return a **sanitized** descriptor whose `connection` is reduced to public
  fields (`kind` / `status` / ...) -- the secret connection material is
  reachable only via the internal `getBackend` storage method. The
  `StorageBackend` contract gains `writeBackend` / `getBackend` / `listBackends`
  / `deleteBackend`.

  This increment is provider-agnostic **plumbing**: a registered backend is
  listed but **not yet selectable** as a Collection's `backend` (Collection
  create/select still resolves only `default`), at-rest secret encryption is
  deferred, and registration records do **not** travel in a Space export (after
  import the user re-registers). The live token exchange and provider adapter
  are future work.

### Fixed

- **Raw (non-multipart) binary blob writes now work for any content-type.** A
  `PUT`/`POST` carrying a raw body of an arbitrary media type --
  `application/octet-stream`, `application/jsonl`, `image/png`, etc. -- was
  rejected with `415 Unsupported Media Type` before reaching the handler,
  because Fastify ships content-type parsers only for `application/json` and
  `text/plain`. A catch-all parser now passes any other media type through to
  the handler as a raw byte stream (the `kind: 'binary'` storage path), so only
  multipart uploads were possible before. More specific parsers (the built-in
  JSON/text parsers, the `application/*+json` parser, `@fastify/multipart`, and
  the `application/x-tar` import parser) still take precedence.
- **Dotted resource ids (e.g. `index.html`, `photo.png`) no longer mis-parse.**
  The on-disk filename `r.<id>.<encodedContentType>.<ext>` was split naively on
  `.`, so an id containing a dot was read back under the wrong id and
  content-type (and broke Collection-listing keysets). The id and content-type
  filename segments are now dot-escaped (`%2E`) so the separators are
  unambiguous; dot-free ids and types are byte-identical to before.
- **`application/jsonl` (and `json5` / `json-seq`) are no longer mistaken for
  JSON.** The `isJson` content-type test matched any media type merely
  containing the substring `json`, routing JSON-Lines bodies through the JSON
  path (corrupting them). The `json` token is now anchored to the end of the
  media type, so only `application/json` and `application/<prefix>+json` are
  treated as JSON.

## 0.6.0 - 2026-06-15

### Added

- **Replication change feed: the `changes` query profile.** The reserved
  Collection query endpoint `POST /space/{id}/{cid}/query` now serves a
  `changes` profile -- the basis for replicating a PWS Collection into a
  local-first in-browser database such as RxDB. The signed JSON body carries
  `{ profile: "changes", checkpoint?, limit? }`; the response is the
  Collection's JSON documents and tombstones changed strictly after
  `checkpoint`, in change order (`(updatedAt, resourceId)`), each as
  `{ id, _deleted, updatedAt, version, data? }`, plus the next `checkpoint`
  (`null` when nothing changed). A tombstone is surfaced as `_deleted: true`
  with no `data`; binary (non-JSON) Resources are excluded. The default
  filesystem backend advertises the new `changes-query` feature token; a backend
  without the change feed (or any other profile) yields `unsupported-operation`
  (501). The `StorageBackend` contract gains an optional `changesSince` method.

### Changed

- **Resource deletes are now soft deletes (tombstones).** Deleting a Resource
  drops its content representation but keeps its metadata sidecar as a tombstone
  (`deleted: true`, a bumped `version` and `updatedAt`, the last-known
  `contentType` retained), so the change feed (for replication) can surface the
  delete until clients catch up. With no content file left, a tombstone is
  invisible to every normal read path (`GET` / metadata / List Collection all
  404 or skip it), so the change is transparent to the existing API. Re-creating
  a deleted id continues its monotonic `version`, and an export/import roundtrip
  carries tombstones across. Garbage-collection of old tombstones is future
  work.

## 0.5.0 - 2026-06-15

### Added

- **`GET /space/{id}/quotas?include=collections` opt-in.** The Space Quota
  report now omits the per-Collection `usageByCollection` breakdown by default
  and includes it only when `?include=collections` is requested (spec "Quotas"),
  keeping the hot-path payload lean. Previously the breakdown was returned
  unconditionally because a query string broke ZCap `invocationTarget` matching;
  the handler now threads the scoped `allowTargetQuery` flag (introduced for
  pagination) so the signed request authorizes against the bare `/quotas` target
  despite the query. The high-level client requests the breakdown via
  `space.quotas({ includeCollections: true })` (`@interop/was-client@^0.7.1`).

### Changed

- The `StorageBackend.reportUsage` contract gains an `includeCollections?`
  option; the breakdown is computed/returned only when set.

  accepts optional `?limit` and `?cursor` query parameters and returns a `next`
  link (a ready-to-follow URL with the opaque cursor and limit baked in) when a
  further page may follow; the absence of `next` is the authoritative
  end-of-list signal. Items are returned in a stable total order (ascending
  `resourceId`, which also fixes the prior nondeterministic listing order, since
  glob v13 does not sort). The filesystem backend reads `.meta` sidecars only
  for the items on the page (previously one per Resource on every list). A
  malformed or un-honorable cursor yields the new `invalid-cursor` (400) problem
  type; authorization is checked before cursor validation, so an
  under-authorized caller still gets the privacy-merged `404`. Pagination is
  OPTIONAL: a request with neither parameter returns the first page (or
  everything, if it fits). The opaque cursor codec lives in `src/lib/cursor.ts`.
  ZCap verification gained a scoped `allowTargetQuery` flag (List Collection
  only) so a capability for the bare Collection authorizes the query-bearing
  `next` URL, honoring the spec's "Pagination parameters and authorization" rule
  (the `limit`/`cursor` parameters select a page within an already-authorized
  target and do not change the target a capability must match). Uses the new
  `invalid-cursor` problem type and `CollectionResourcesList.next` field from
  `@interop/storage-core@^0.2.3`.

- **Conditional writes (`conditional-writes` feature).** The filesystem backend
  now exposes each Resource's monotonic `version` as an HTTP `ETag` strong
  validator (returned on `GET` / `HEAD` / `GET .../meta` and on the `PUT` /
  `POST` write responses) and honors the RFC9110 write preconditions:
  - `If-Match: "<etag>"` -- update-if-unchanged: the write proceeds only if the
    Resource's current ETag matches, else `412 precondition-failed`.
  - `If-None-Match: *` -- create-if-absent: the write proceeds only if the
    Resource does not yet exist, else `412 precondition-failed`. `DELETE` honors
    `If-Match` the same way. The precondition is evaluated atomically with the
    write under a per-Resource in-process mutex (ported from
    `@interop/edv-server`), so two concurrent writers cannot both observe the
    same prior version and both succeed -- the lost-update guard. Authorization
    is checked _before_ the precondition, so a `412` is only ever observable by
    a caller already authorized to write the target (an under-authorized caller
    gets the privacy-merged `404`). This is single-instance write locking only;
    horizontally-scaled locking is out of scope. Uses the new
    `precondition-failed` (412) problem type from
    `@interop/storage-core@^0.2.2`.

- The default filesystem backend descriptor now carries a `features` array
  (surfaced at `GET /space/{id}/backends` and `GET /space/{id}/{cid}/backend`),
  using the `features` field added in `@interop/storage-core@^0.2.0`. It
  advertises `['conditional-writes']` (above); the remaining _server
  affordances_ (`blinded-index-query`, `chunked-streams`) are added as each
  lands.

- Accept `application/<suffix>+json` request bodies (e.g. `application/edv+json`
  for EDV-over-PWS encrypted documents, `application/ld+json`) by parsing them
  as JSON. Fastify's built-in parser only matches `application/json` exactly, so
  structured-suffix JSON media types previously returned 415; a root-level
  content-type parser now handles them (the suffix content type is preserved on
  read). `isJson()` already treated `+json` as JSON downstream.

- `HEAD /space/{id}/{cid}/{rid}` (Head Resource). Returns the same headers a
  `GET` would, with no body: a bodyless 200 whose `Content-Type` and
  `Content-Length` are set from the Resource Metadata's `contentType`/`size`
  (spec "Content Types and Representations"). Authorized as a read
  (capability-or-policy, the same decision as `GET`), and reads only the
  Metadata so it never opens the resource byte stream. Registered explicitly
  ahead of the `GET` route to override Fastify's auto-exposed HEAD, which would
  share the streaming GET handler and yield no `Content-Length`.

- Space and Collection Description objects now carry a relative `url` property
  (`/space/{id}` and `/space/{id}/{cid}`) in their `GET` responses, alongside
  the existing `linkset` (spec: the server populates the description `url`),
  consistent with the `url` already present on List Spaces / List Collections
  items.

- Reject a multipart write that does not carry exactly one file part with
  `invalid-request-body` (400) (spec "Content Types and Representations").
  `resolveResourceInput` now iterates `request.parts()` rather than taking the
  first file part and silently ignoring extras, so both zero file parts and more
  than one are rejected. The multipart `files` limit was raised from 1 to 2 so a
  disallowed second part reaches the handler to be rejected with this 400 (a
  `files: 1` limit instead has busboy silently drop it and raise its own
  `FST_FILES_LIMIT` 413). The single permitted part is buffered in memory
  bounded by the backend's `maxUploadBytes` (a multipart `fileSize` limit), so
  an oversize multipart upload is rejected with `payload-too-large` (413) before
  it is fully buffered. Large binaries should use the streaming raw-body upload
  path; multipart is a convenience for the HTML-form workflow (see the README).

- Live `@interop/was-client` conformance coverage for storage introspection:
  `space.backends()` / `space.quotas()` (the backend list and the per-backend
  quota report with its per-collection breakdown) and `collection.backend()` /
  `collection.quota()` (the Collection's selected backend descriptor and its
  backend-scoped usage report). The collection-level tests require a published
  client that exposes those methods.

### Changed

- The Space and Collection `id` is now immutable on update: a `PUT /space/{id}`
  (resp. `PUT /space/{id}/{cid}`) whose body carries an `id` that does not match
  the id in the URL is rejected with `invalid-request-body` (400, pointer
  `#/id`), before any controller/capability check. (The spec spells this out for
  Update Space; it is applied to Update Collection for parity.)

- Space and Collection Description `type` arrays are served lexically sorted
  (spec SHOULD).

## 0.4.0 - 2026-06-13

### Added

- Enforce Request Body Integrity via the `Digest` header (spec "Request Body
  Integrity"). Any request carrying a `Content-Type` must cover the `digest`
  header in its HTTP Signature (MUST) and present a `Digest` header; for
  JSON/text bodies the server now independently recomputes the body's multihash
  and compares it to the header (SHOULD), so a body cannot be swapped without
  invalidating the signature. A missing, uncovered, malformed, or non-matching
  digest is rejected with `invalid-authorization-header` (400). Implemented as
  two route-group hooks (`src/digest.ts`): `captureRawBody` (preParsing) tees
  the exact body bytes onto `request.rawBody` so the digest is checked against
  precisely what the client signed (re-serializing the parsed JSON is not
  guaranteed byte-identical); `verifyBodyDigest` (preValidation) performs the
  checks before capability verification. Streamed bodies (multipart uploads, tar
  import) are left unbuffered and get the covered-header + presence checks only.
  Adds the `@interop/http-digest-header` dependency (`verifyHeaderValue`).

- Implement Update Resource Metadata, `PUT /space/{id}/{cid}/{rid}/meta` (spec
  "Update Resource Metadata"), replacing the previous `unsupported-operation`
  (501) stub. A `PUT` is a full replacement of the Metadata object's
  user-writable `custom` object (`name`, `tags`): any property omitted is
  cleared, and a body with no `custom` (e.g. `{}`) clears them all.
  Server-managed properties are untouched and any top-level property other than
  `custom` in the body is ignored, so a client may GET-modify-PUT the whole
  object. The operation does not create -- a `PUT` to the `/meta` of a
  nonexistent Resource is a 404 -- and returns 204; a malformed body or `custom`
  shape is `invalid-request-body` (400). Authorization is capability-only (the
  `PUT` action), like Put Resource. Read Resource Metadata (`GET .../meta`) now
  also returns the OPTIONAL `createdAt` / `updatedAt` timestamps and the
  `custom` object, and a Resource's `custom.name` is surfaced as its `name` in
  List Collection results. Metadata is persisted in a per-Resource sidecar
  (`.meta.<resourceId>.json`, the same dot-file convention as `.policy.`) via
  the new `StorageBackend` `writeResourceMetadata()`; the sidecar is
  created/maintained on Resource writes, swept on delete, and carried through
  Space export/import.

- Implement the per-Collection Quota report, `GET /space/{id}/{cid}/quota` (spec
  "Quotas"). Returns a single backend-usage entry scoped to the Collection:
  `usageBytes` reflects only that Collection's consumption, while `state` /
  `limit` / `restrictedActions` describe the backend's overall condition (the
  quota is a per-backend limit). Backed by the new optional
  `StorageBackend.reportCollectionUsage()` (filesystem: the Collection's slice
  of the existing one-pass `du` breakdown); a backend that cannot account
  per-Collection omits the method and the endpoint returns
  `unsupported-operation` (501). Authorization is capability-or-policy, so an
  unauthorized caller gets the maximum-privacy 404.

- Implement the per-upload `maxUploadBytes` constraint and `payload-too-large`
  (413) enforcement (spec "Quotas"). A new `MAX_UPLOAD_BYTES` env var (parsed by
  `parseMaxUploadBytes`, threaded through `createApp` to the default backend)
  caps the size of a single Create/Update Resource write, distinct from the
  cumulative per-Space quota: an oversized JSON or blob write is rejected with
  `payload-too-large` (413) -- via an up-front size pre-flight plus a streaming
  `_uploadCapGuard` for bodies whose size is not declared -- while smaller
  uploads still succeed. The cap is advertised in both the Space and
  per-Collection quota reports under `constraints.maxUploadBytes`. This wires
  the previously type-only `PayloadTooLargeError`.

- Advertise the remaining quota/backend linkset relations (spec linksets): the
  Collection linkset now carries the `quota` relation
  (`https://wallet.storage/spec#quota`, alongside the `backend` relation), and
  the Space linkset now carries `backends-available`
  (`https://wallet.storage/spec#backends-available`) and `quotas`
  (`https://wallet.storage/spec#quotas`), all unconditionally (their endpoints
  always exist).

- Implement Collection backend selection (spec "Collection Backend Selected" /
  "Backends"). A Collection Description now carries an optional `backend` object
  (`{ "id": "default" }` by default); Create Collection (POST) and Update/Create
  Collection (PUT) accept a body `backend`, validate its `id` against the
  Space's backends-available, and persist the normalized value. An unknown id is
  rejected with `unsupported-backend` (409) -- the error registry's previously
  type-only entry now has its emit site -- and a malformed `backend` (not an
  object with a string `id`) is `invalid-request-body` (400). The new
  `GET /space/{id}/{cid}/backend` ("Collection Backend Selected") returns the
  full backend descriptor for the Collection's selection, and the Collection
  linkset now advertises the `backend` relation
  (`https://wallet.storage/spec#backend`). Get Collection reports the selected
  backend, default-filled for Collections created before the property existed.

- Implement the List Spaces operation, `GET /spaces/` (spec "List Spaces
  Operation"), replacing the hardcoded 501. The response is
  `{ url, totalItems, items }` with only the Spaces the caller is authorized to
  see; each item carries `id`, `name` (when set), and the relative `url`
  (`/space/{id}`). An anonymous or unauthorized request is not an error -- it
  gets the empty-items `200`, the spec's explicit exception to 404 masking, so
  the listing reveals nothing about which Spaces exist (the SpacesRepository
  route group now installs `requireAuthHeadersOrPublicRead` so the read can
  reach the handler; Create Space still 401s without auth headers). Candidates
  come from the new `StorageBackend.listSpaces()` (filesystem backend: the
  subdirectories of the spaces root), and authorization is decided once per
  distinct Space controller: a bare-root invocation lists the signer's own
  Spaces, while a delegated invocation lists the Spaces of whichever controller
  roots its capability chain.

- Complete the spec's Error Type Registry (`src/problem-types.ts`): added the
  three missing problem kinds and matching error classes -- `reserved-id` (409,
  `ReservedIdError`), `unsupported-backend` (409, `UnsupportedBackendError`),
  and `payload-too-large` (413, `PayloadTooLargeError`). `reserved-id` is
  enforced immediately: the id sanitizer (`src/lib/validateId.ts`) now carries
  the spec's full Reserved Path Segment Registry, per id position -- Collection
  ids may not be `backends` / `collections` / `export` / `linkset` / `policy` /
  `query` / `quotas` (plus this server's non-spec `import`), and Resource ids
  may not be `backend` / `linkset` / `policy` / `query` / `quota` -- and a
  collision is rejected with the spec's `reserved-id` (409) instead of the
  previous `invalid-id` (400), which also only covered `policy` and `linkset`.
  This closes a routing hole on verbs without a static route: for example,
  `PUT /space/:spaceId/export` used to fall through to the parametric Create
  Collection route and happily create a Collection literally named `export`,
  shadowing the export endpoint. The other two new kinds have no emit sites yet:
  `unsupported-backend` awaits the Collection `backend` property, and
  `payload-too-large` awaits the per-upload `maxUploadBytes` constraint.

- Support the spec's delegated Create Space chain of authorization. The
  invocation on `POST /spaces/` (and on create-via-`PUT /space/:spaceId`, see
  Fixed below) must be _authorized by_ the body's `controller`: signed directly
  by it (the common case), or signed by another DID presenting a delegation
  chain rooted in it -- enabling provisioning services that create a Space on a
  user's behalf, with the user's DID as `controller` from the start. Previously
  `POST /spaces/` rejected any signer other than the body's `controller` with
  `controller-mismatch` _before_ verification, which blocked the delegated form.
  The friendly pre-verification 400 is kept for bare-root invocations (where the
  signer is the invoker, so it must be the controller); a delegated invocation
  is instead judged by the capability-chain verification (which synthesizes the
  root capability with the body's `controller` as its controller), and a chain
  not rooted in the body's `controller` is rejected with the spec's
  `controller-mismatch` (400). New `isRootInvocation()` helper in `src/zcap.ts`
  distinguishes the two `Capability-Invocation` header forms;
  `SpaceControllerMismatchError` now carries the spec's "signed by it, or via a
  delegation chain rooted in it" detail (and an optional `cause`).

- Enforce a per-Space storage quota (spec "Quotas"). A new
  `STORAGE_LIMIT_PER_SPACE` environment variable sets each Space's capacity in
  bytes; when configured, writes that would push a Space over its limit are
  rejected with a new `quota-exceeded` (507) error. Enforcement lives in
  `FileSystemBackend.writeResource` and `importSpace`: a cheap `du`-based
  pre-flight rejects writes whose size is known up front (JSON bodies and blobs
  with a `Content-Length`), and a byte-counting streaming guard hard-caps blobs
  whose size is not declared (cleaning up the partial file on overflow). The
  limit is a soft cap under concurrency (two simultaneous writes can each pass
  the pre-flight and jointly overshoot); the streaming guard still bounds each
  individual write. Unset (`STORAGE_LIMIT_PER_SPACE` absent) leaves every Space
  unlimited, as before, with zero enforcement overhead. The per-upload
  `maxUploadBytes` / `payload-too-large` (413) constraint remains future work.

- Implement the `GET /space/:spaceId/quotas` ("Quotas") endpoint. Returns the
  Space's storage report grouped by backend (spec "Quotas"); this reference
  server ships one server-configured backend, so the `backends` array has a
  single entry. Each entry combines the backend's identity (`id` / `name` /
  `managedBy`, from its `describe()`) with measured `usageBytes`, a derived
  `state` (`ok` / `near-limit` / `over-quota`), the configured `limit`
  (`isUnlimited` by default -- the filesystem backend reports an unlimited quota
  unless a `capacityBytes` is configured), `restrictedActions`
  (`["POST", "PUT"]` once `over-quota`), a `measuredAt` timestamp, and a
  per-Collection `usageByCollection` breakdown. Usage is measured with `du` (GNU
  coreutils) on the Space's storage directory. Authorization is
  capability-or-policy, the same as List Collections and the backends list (a
  caller not authorized to read the report receives a 404, per the spec's
  maximum-privacy invariant). The new `StorageBackend.reportUsage()` port method
  backs the endpoint, and `FileSystemBackend` gains an optional `capacityBytes`
  constructor option that drives the `state` thresholds.

  _Known limitation:_ the spec makes the per-Collection breakdown opt-in via
  `?include=collections`, but a query string in the request URL currently breaks
  ZCap `invocationTarget` matching (the signed root capability target would
  include the query and no longer match the bare `/quotas` path). For now the
  breakdown is returned unconditionally and the query parameter is not
  consulted, pending an upstream fix in the ezcap client. The per-Collection
  `/quota` endpoint (`GET /space/:spaceId/:collectionId/quota`) is not yet
  implemented.

- Implement the `GET /space/:spaceId/backends` ("Space Backends Available")
  endpoint. Returns the list of storage backends registered for the Space; this
  reference server ships one server-configured backend, so the list has a single
  entry derived from the active backend's own `describe()`. Each entry is a
  Backend description object (spec "Backend Data Model"): `id`, `name`,
  `managedBy`, `storageMode`, and `persistence`. Authorization is
  capability-or-policy, the same as List Collections (a public-readable Space
  may list its backends).
- Implement `/meta` resource endpoint.
- Observability on the access-control policy authorization path. A
  policy-granted read now emits an info log -- "Access granted by access-control
  policy." with `spaceId` / `collectionId` / `resourceId` / `action` /
  `policyType` -- so public-access decisions are auditable, and an unrecognized
  policy `type` now emits a warn as it fail-closes in `policyGrants`. The
  decision logic is unchanged; this is purely diagnostics.
- Test + CI tooling:
  - Added a `test:coverage` script (`vitest run --coverage`) and wired coverage
    into CI: the `test` job now runs `pnpm run test:coverage` and uploads the
    v8/lcov `coverage/` report (reporters already configured in
    `vite.config.ts`) as a downloadable build artifact.
  - Added direct unit tests for the previously integration-only core --
    `test/zcap.test.ts` (the `handleZcapVerify` error contract:
    `UnauthorizedError` on a failed invocation vs `AuthVerificationError` +
    `cause` + logging on a verification error), `test/auth-header-hooks.test.ts`
    (header gating and `request.zcap` parsing), and `test/importTar.test.ts`
    (manifest validation, merge-plan building, tar extraction, and the
    id-traversal guards). Coverage of all three modules is now ~94-100%.
- Memoized the Space Description lookup. Every authorized handler reads the
  Space Description through `getSpaceDescriptionOrThrow` in
  `src/requests/spaceContext.ts`, so it is now cached per storage backend via
  `@interop/lru-memoize` (a `WeakMap`-scoped `LruCache` per backend, short TTL
  from `SPACE_DESCRIPTION_CACHE_TTL`). Writes invalidate explicitly through the
  new `invalidateSpaceDescription()` -- wired into Space create
  (`POST /spaces/`), update (`PUT /space/:spaceId`), and delete -- so a read
  after a write never serves a stale description; the TTL is a backstop that
  also bounds staleness across multiple server processes sharing one backend. No
  API change.

### Fixed

- Close the create-via-PUT controller consent gap. `PUT /space/:spaceId`
  creating a _new_ Space used to verify the invocation against the signer
  itself, never tying it to the body's `controller` -- so any signer could
  create a Space whose stored controller is an unrelated, non-consenting DID
  (squatting meaningful ids "in their name", or burning per-controller
  onboarding allowances). Creates now apply the same
  authorized-by-body-controller rule as `POST /spaces/` (signed by the body's
  `controller` directly, or via a delegation chain rooted in it; violations are
  `controller-mismatch`, 400). Updates of an existing Space are unchanged: they
  verify against the _stored_ controller, with the body's `controller` as just
  the proposed new value.
- Dead-code and error-handling cleanup:
  - `src/lib/importTar.ts` now throws the typed `InvalidImportError` for the
    five archive-validation failures instead of generic `Error`, and the
    invalid-YAML case chains the underlying parse error as its `cause`
    (`InvalidImportError` gained an optional `cause`). The `Import Space`
    handler no longer flattens every failure into a fresh `InvalidImportError`:
    typed `ProblemError`s now propagate unchanged (preserving status code and
    message), and only an unexpected decode failure is wrapped -- keeping the
    original as the `cause`.
  - `resolveResourceInput` (`src/requests/resourceInput.ts`) guards the
    multipart parse: a `multipart` request with no file part now returns a clean
    `400` instead of throwing a raw `TypeError` on a non-null assertion.
- Validate the Space `controller` DID at the request layer. `POST /spaces/`
  (Create Space) and `PUT /space/:spaceId` (Update Space) now reject a body
  whose `controller` is not a syntactically valid Ed25519 `did:key` with a typed
  400 (`InvalidControllerError`, pointer `#/controller`) on the way in -- rather
  than storing a malformed controller that only fails later, at
  capability-verification time. New `src/lib/validateDid.ts` exports
  `assertValidController` / `isValidController`.
- Reject `POST /spaces/` (Create Space) with an `id` that already exists,
  instead of silently overwriting the existing Space. The handler now checks for
  an existing Space Description before anything else and rejects with the spec's
  `id-conflict` (409) error type (new `ProblemTypes.ID_CONFLICT` catalog entry
  and `IdConflictError` class, pointer `#/id`). Create-or-replace at a
  client-chosen id remains available via the idempotent `PUT /space/:spaceId`.
  Create Collection (`POST /space/:spaceId/`) gets the same `id-conflict` (409)
  check instead of silently overwriting -- there it runs _after_ the capability
  verification, so an unauthorized caller cannot probe Collection ids;
  create-or-replace remains the idempotent `PUT /space/:spaceId/:collectionId`.

### Changed

- Adopt `@interop/storage-core` for the shared PWS wire model and error
  vocabulary, replacing the in-repo declarations that were drifting from the
  `was-client` copies. `src/types.ts` now imports/re-exports the data-model
  shapes (`SpaceDescription`, `CollectionDescription`, `BackendDescriptor`,
  `BackendUsage`, `ResourceMetadata`, etc.) from core and keeps only the
  server-local contracts (`StorageBackend`, `ResourceInput`, `ResourceResult`,
  `ParsedZcap`, the Fastify augmentation); `src/problem-types.ts` is removed in
  favor of core's `ProblemTypes` / `ProblemType`, and `errors.ts` re-exports the
  wire `Problem` shape from core. Two listing types were renamed to remove a
  cross-repo collision: the resources-in-a-collection listing is now
  `CollectionResourcesList` (was `CollectionListing`). The unified types also
  tightened two producer behaviors: `FileSystemBackend.describe()` now returns
  the always-populated `Required<BackendDescriptor>`, and `PUT .../meta` now
  rejects non-string `custom.tags` values (400), matching the spec's string-tag
  guidance.
- Tighten `PUT .../policy` body validation: a policy `type` that is empty or
  whitespace-only is now rejected with a 400 (`InvalidPolicyError`) instead of
  being stored. The recognized-types set stays intentionally open (an unknown
  `type` is stored and fail-closes at evaluation time), so this is a shape check
  only, not a known-types allowlist.
- Centralize the relative URL path templates. New `src/lib/paths.ts` exposes
  `spacePath` / `collectionPath` / `resourcePath` / `policyPath` / `linksetPath`
  builders that mirror the route shapes in `routes.ts`; the policy and linkset
  code (`src/policy.ts`, `PolicyRequest`, and the Space/Collection linkset
  handlers) now builds those paths through the helpers rather than re-deriving
  them inline. The linkset relation URI moved from `src/policy.ts` into
  `config.default.ts` (`POLICY_LINK_RELATION`). The follow-up full sweep then
  routed _every_ remaining inline path template through the module: the
  trailing-slash container forms via a `trailingSlash` option on `spacePath` /
  `collectionPath`, plus new `spacesPath` (SpacesRepository container and member
  -- the latter being the create `Location`, deliberately `/spaces/:id`),
  `collectionsPath`, `exportPath`, and `importPath` builders. All `*Request.ts`
  `targetPath`s, the `Location`-header `new URL(...)` constructions, the
  `List Collections` `url` field, and the `FileSystemBackend` listing `url`
  fields now build through the helpers, making `src/lib/paths.ts` the single
  source of truth for every server path shape. New `test/paths.test.ts` pins
  each builder's member-vs-container output. No API change.
- Removed dead code: the commented-out `@fastify/accepts` import/registration in
  `src/server.ts`, the commented debug log in `src/auth-header-hooks.ts`, and
  the three speculative `// TODO: use a uuid v5 or another hash based id`
  comments (random v4 ids are correct for these server-assigns-id create
  endpoints; deterministic ids have no natural key here and would change
  semantics).
- Extracted the fetch-space-and-verify boilerplate repeated across ~18 handlers
  (in five files) into the new neutral module `src/requests/spaceContext.ts`. It
  loads the Space and builds the capability `invocationTarget` URL once, then
  exposes two named entry points so each call site names its authorization
  model: `fetchSpaceAndAuthorize()` (**capability-or-policy** -- capability
  invocation first, then access-control policy fallback; for read/list
  endpoints) and `fetchSpaceAndVerify()` (**capability-only**; for
  write/privileged + policy endpoints). Both return the verified context. The
  old `getSpaceController` helper was dropped (subsumed). No behavior change,
  except the handlers that fetched the Collection before verifying now verify
  first.

### Removed

- The in-memory storage backend (`src/backends/memory.ts`). It was never wired
  into the server or the test suite -- its purpose was to drive the
  `StorageBackend` port to the right level of abstraction, which it has done.
  That abstraction now lives in the port (`src/types.ts`) and survives the
  removal; a future durable/queryable backend (SQLite/Postgres/LMDB) will be the
  real second adapter that proves the port.

## 0.3.0 - 2026-06-06

### Added

- Access-control **policy** documents, enabling world-readable ("public read")
  Collections and Resources. A `policy` auxiliary resource may be set at the
  Space, Collection, or Resource level via
  `GET|PUT|DELETE /space/{id}[/{col}[/{res}]]/policy`. Reads (`GET`/`HEAD`) now
  fall back to the effective policy when no capability is presented, or when the
  presented capability does not authorize the request -- so an anonymous `GET`
  of a resource in a Collection whose policy is `{ "type": "PublicCanRead" }`
  succeeds. Policies are **permissive-only** (they broaden access beyond
  capabilities, never restrict a valid capability holder) and resolved
  most-specific-first (Resource over Collection over Space, per the spec). The
  policy document is a `type`-discriminated, extensible shape: v1 recognizes
  only `PublicCanRead`; any unrecognized `type` grants nothing (fail-closed).
  New modules: `src/policy.ts` (resolution + evaluation + linkset building),
  `src/authorize.ts` (the capability-then-policy decision), and
  `src/requests/PolicyRequest.ts` (the policy CRUD handler).
- **Linkset discovery** (RFC9264): Space and Collection Description objects now
  carry a `linkset` property, and `GET /space/{id}/linkset` /
  `GET /space/{id}/{col}/linkset` return an `application/linkset+json` document
  advertising the access-control `policy` resource (relation
  `https://wallet.storage/spec#policy`) when one is set.
- Space export/import now round-trips policies. Space-, Collection-, and
  Resource-level `.policy.*` documents are carried in the export tarball and
  restored on import: the space policy fills in when the target has none (no
  clobber), and Collection/Resource policies travel with a newly-created
  Collection/Resource. `ImportStats` gains `policiesCreated` /
  `policiesSkipped`.

### Changed

- Read requests (`GET`/`HEAD`) on Space / Collection / Resource routes no longer
  require auth headers up front: they are allowed through so the handler can
  fall back to an access-control policy. An anonymous (or unauthorized) read
  that no policy grants is now denied with **404** (consistent with the existing
  no-leak policy for failed capability invocation) rather than **401**. Writes,
  and all SpacesRepository (`/spaces`) admin routes, still require auth (401
  when absent). `policy` and `linkset` are now reserved id segments and cannot
  be used as Collection or Resource ids.

## 0.2.0 - 2026-06-06

### Added

- Emit the spec-REQUIRED `type` property on every `application/problem+json`
  error response. A new `src/problem-types.ts` defines a `ProblemTypes` catalog
  of problem-_kind_ `type` URIs (e.g. `#not-found`, `#invalid-id`,
  `#controller-mismatch`), keyed by the kind of problem and reused across
  operations per [[RFC9457]] -- not per operation. Privacy-sensitive conditions
  (Space / Collection / Resource not found, failed capability invocation) all
  collapse to a single `#not-found` so `type` cannot be used to probe resource
  existence. Body-validation responses now also carry a `pointer` (RFC 6901 JSON
  Pointer, `#/field` form) identifying the offending field; the combined
  Create/Update Space "name and controller" check is split so each missing field
  reports its own `#/name` / `#/controller` pointer. The PWS spec gains an
  "Error Type Registry" appendix documenting the catalog.

### Changed

- Re-parent the error classes in `src/errors.ts` onto a shared `ProblemError`
  base carrying `type` / `title` / `detail` / `statusCode` and an optional
  `problems: { detail, pointer }[]` array, removing the repeated field-triad
  boilerplate. `handleError` now serializes `type` and the `problems` array
  (falling back to `[{ detail }]`).
- Refactor `conformance/helpers.ts` to dogfood `@interop/was-client`: identities
  built by `buildZcapClients()` now carry a high-level `was` client alongside
  the raw `rootClient`, a new `wasClient({ signer })` helper mirrors
  `zcapClient({ signer })`, and `createSpace()`'s ZCap path goes through
  `WasClient.request()`. The exported helper surface is unchanged.

### Security

- Sanitize `spaceId` / `collectionId` / `resourceId` against path traversal. A
  new `src/lib/validateId.ts` exports `assertValidId(id, { kind })` /
  `assertValidIds(ids)`, which reject any id that is not a single URL-safe path
  segment (empty, `.`, `..`, containing `/` or `\`, or outside the RFC 3986
  unreserved charset -- which also excludes every glob metacharacter). It is
  enforced at the request layer (every `SpaceRequest` / `CollectionRequest` /
  `ResourceRequest` handler, plus client-supplied ids in the Create Space /
  Create Collection bodies) before any storage access, and at the tar-import
  layer (`src/lib/importTar.ts`) for every id parsed out of an archive entry
  name. As defense in depth, `FileSystemBackend` now asserts that every built
  path resolves within its `spaces/` root before any filesystem operation. New
  `InvalidCollectionIdError` / `InvalidResourceIdError` (400) join the existing
  `InvalidSpaceIdError`.

### Fixed

- Replace generic `throw new Error('Could not ...')` in the Collection and
  Resource create/update/delete paths with
  `StorageError({ cause, requestName })` so storage failures surface a typed 500
  with a title/detail through `handleError` instead of a bare 500 (and rename
  the `e` catch vars to `err`).
- Validate request bodies and headers before use: Create Space (`POST /spaces/`)
  and Update Space (`PUT /space/:spaceId`) now reject a body missing `name` or
  `controller` with a typed 400 (`InvalidRequestBodyError`) rather than failing
  deeper, and `resolveResourceInput` rejects a missing `Content-Type` header
  with a typed 400 (`MissingContentTypeError`) instead of asserting it non-null.

### Changed

- Make the storage backend an injectable dependency of `createApp()`. The app
  factory now accepts a `backend` (`createApp({ serverUrl, backend })`) and
  decorates the Fastify instance with it; request handlers read it as
  `request.server.storage` rather than importing a module-level facade.
  `src/storage.ts` no longer holds a hardcoded singleton — it exposes
  `defaultBackend()` (a filesystem backend rooted at `data/`), which
  `createApp()` uses when no backend is injected (production / `start.ts`). Each
  `test/` suite now injects its own `FileSystemBackend` over an `mkdtemp` temp
  dir and removes it in `afterAll`, so suites no longer share (or leak) the
  gitignored `data/` directory.

- Decouple the `StorageBackend` persistence port from the HTTP transport.
  `writeResource` now takes a transport-neutral `ResourceInput` value object
  (`{ kind: 'json'; data } | { kind: 'binary'; stream }`, both carrying a
  `contentType`) instead of a raw Fastify `request`. A new request-layer
  adapter, `resolveResourceInput()` in `src/requests/resourceInput.ts`, is now
  the only place that reads `request.body` / `request.file()` and distinguishes
  multipart from raw-blob bodies; the backends (`filesystem`, `memory`) no
  longer import Fastify at all.

  _Architectural note (ports & adapters):_ `StorageBackend` is a driven
  (secondary) port with two interchangeable adapters. Passing the inbound
  `FastifyRequest` into it coupled that driven port to the HTTP driving
  (primary) adapter — the one dependency direction hexagonal architecture
  forbids. Routing the conversion through `resolveResourceInput()` restores the
  boundary: backends now depend only on domain types, can be unit-tested with
  plain values (no fake request objects — see `test/storage.test.ts`), and the
  multipart/blob distinction lives where it belongs, in the HTTP layer.

- Tighten the `StorageBackend` contract so a Resource has exactly one current
  representation, identified by `resourceId` alone within a Collection.
  Previously a resource's identity was effectively `(resourceId, contentType)`
  -- an emergent property of how each backend stored the content-type out of
  band (filename segment on the filesystem, composite
  `${resourceId}::${contentType}` map key in memory). As a result, `PUT`-ing an
  id as one content-type and then re-`PUT`-ing it under another left two stored
  representations instead of replacing the first; `getResource` returned a
  nondeterministic one and the listing emitted the id twice. Now `writeResource`
  replaces any prior representation regardless of its content-type (the
  filesystem backend prunes the old file after writing the new one; the memory
  backend overwrites in place), and `getResource`'s `contentType` parameter is
  advisory -- the single representation is resolved by `resourceId` alone, with
  the stored content-type returned in `ResourceResult.storedResourceType`. The
  content-type stays human-visible in the filesystem filename; it is now a
  descriptive attribute, not part of identity. No method signatures or spec
  behaviour changed.

- Route all server diagnostics through the Fastify pino logger instead of
  scattered `console.*` calls. `FileSystemBackend` now logs through an injected
  logger (`StorageBackend.logger`, typed as Fastify's `FastifyBaseLogger`);
  `createApp()` wires `fastify.log` into the active backend, and the backend
  defaults to a silent pino logger until then. `StorageError` no longer logs
  from its constructor -- `handleError` now logs 5xx faults (including the
  underlying `cause`) once, through `request.log`, leaving 4xx client errors
  unlogged.

### Fixed

- `GET /space/:spaceId/:collectionId/:resourceId` no longer masks every
  `getResource` failure as a 404. The handler previously swallowed any error
  from the backend and reported "resource not found"; it now re-throws a genuine
  `ResourceNotFoundError` as the 404 and wraps any other failure as a typed 500
  (`StorageError`) so real storage faults are no longer hidden.

## 0.1.0 - 2026-06-04

### Changed

- Convert the codebase from JavaScript (ES2020 + JSDoc) to TypeScript (strict,
  `NodeNext`). Dev runs via `tsx`; production builds with `tsc` to `dist/`.
  Tooling adopted: ESLint flat config, Prettier, Vitest.
- Migrate the `test/` integration suite to Vitest; keep the `conformance/` suite
  standalone (run via `tsx --test`).
- Bump `@interop/*` packages to v7: `did-method-key` 7.x, `ed25519-signature`
  7.x, `ed25519-verification-key` 7.x; update `security-document-loader` to
  9.2.x and `ezcap` (dev) to 7.x.
- Swap `@interop-alliance/http-signature-zcap-verify` for the typed
  `@interop/http-signature-zcap-verify` fork.

### Added

- Add `@interop/data-integrity-core` as a direct dependency (source of shared
  types).

### Fixed

- `writeResource` now awaits `request.file()` in both backends (multipart
  resource writes).
- `ResourceRequest.delete` / `CollectionRequest.delete` now import the
  `StorageError` they throw.
- Fix test ordering bug in collection and resource api tests.

## 0.0.6 - 2026-05-31

### Changed

- Migrate to `@interop/` forks of the key, signature and DID packages.

## 0.0.5 - 2026-05-11

### Added

- Implement 'List Collections' request.

## 0.0.4 - 2026-05-11

### Changed

- Refactor storage.js into file and memory backends.
- Fix start server error logging.
- Refactor listCollectionItems to use 'items' instead of 'rows'.
- Add exportSpace functionality to FileSystemBackend.
- Bump deps to latest.

## 0.0.3 - 2026-03-25

### Changed

- Add PUT Resource route.
- Refactor listCollections result objects.

## 0.0.2 - 2026-03-24

### Changed

- Add SERVER_URL and PORT env vars, better errors.

## 0.0.1 - 2025-08-25

### Added

- Initial commits
