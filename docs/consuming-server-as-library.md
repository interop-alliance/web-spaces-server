# Consuming the Server as a Library

Besides running standalone, this package can be consumed as a dependency: the
whole PWS protocol surface (the PWS route groups, the WebKMS `/kms` facet, the
auth/digest hook chains, zcap verification, and the error handler) is exposed as
a single registerable Fastify plugin, `fastifyWas`. A downstream server composes
its own Fastify instance -- its own persistence, security plugins, and
operational endpoints -- and registers `fastifyWas` to speak the exact same wire
protocol as the teaching server. (The rationale and the upstream/downstream
split are described in the production roadmap's "Two-codebase strategy"
section.)

## Install

```bash
pnpm add @interop/web-spaces-server    # or: npm install @interop/web-spaces-server
```

The package is ESM-only (`"type": "module"`) and requires Node.js >= 24. Two
entry points are importable. The package root carries the server. The
`@interop/web-spaces-server/testing` subpath carries test support (see
[Testing against the server](#testing-against-the-server)). The `exports` map
does not expose deep `dist/...` paths.

## What the package exports

| Export                         | What it is                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `fastifyWas`                   | The PWS protocol surface as a Fastify plugin                                        |
| `FastifyWasOptions`            | The plugin's options type (see below)                                               |
| `createApp`                    | The teaching server's own composition, as a factory                                 |
| `FileSystemBackend`            | The reference persistence backend (JSON + blobs on disk)                            |
| `PostgresBackend`              | The PostgreSQL persistence backend (transactional quotas, multi-process safe)       |
| `defaultBackend`               | Opens the `FileSystemBackend` the standalone server uses (async)                    |
| `onboardingTokenAuthorizer`    | Stock `authorizeProvisioning` callback that checks a shared-secret bearer token     |
| `StorageBackend` (and friends) | The backend contract plus the rest of the domain types                              |
| `ProblemError` subclasses      | The typed protocol errors (`ResourceNotFoundError`, `PreconditionFailedError`, ...) |

The test support helpers (`startTestServer`, `openTempBackend`,
`provisionWebvhIdentity`, the `RequestFaults` seam) are exported from
`@interop/web-spaces-server/testing`, not from the root. See
[Testing against the server](#testing-against-the-server).

Importing anything from the package also loads its Fastify module augmentation,
so `FastifyInstance.serverUrl` / `.storage` and `FastifyRequest.zcap` are typed
on the decorated instance for free.

## A minimal server

```ts
import path from 'node:path'
import Fastify from 'fastify'
import { fastifyWas, FileSystemBackend } from '@interop/web-spaces-server'

const serverUrl = process.env.SERVER_URL ?? 'http://localhost:3002'

const fastify = Fastify({ logger: true })

fastify.register(fastifyWas, {
  serverUrl,
  backend: await FileSystemBackend.open({
    dataDir: path.join(import.meta.dirname, 'data')
  })
})

// The plugin leaves the server root to the composition (the teaching server
// serves its welcome page there); the conformance suite expects a 200 at `/`.
fastify.get('/', async () => {
  return { name: 'minimal-was-server' }
})

// The port must be the one in `serverUrl` -- see the warning below.
await fastify.listen({ port: 3002, host: '0.0.0.0' })
```

That is a complete PWS + WebKMS server: `POST /spaces/`, the Space / Collection
/ Resource routes, access-control policies, quotas, export/import, and the
`/kms` keystore facet all work, and the full conformance suite passes against it
(verified against exactly this composition).

Two things to get right:

- **`serverUrl` must exactly match the URL clients reach the server at.** ZCap
  capability `invocationTarget` URLs include the full host and port, and
  verification compares them as exact strings -- `localhost` vs `127.0.0.1`, or
  a mismatched port, makes every delegated invocation fail (as a masked `404`).
  This is a property of URL-based capabilities, not a bug.
- **Say where the data lives.** When no `backends` or `backend` is given, the
  plugin falls back to `defaultBackend()`, which roots its `data/` directory
  relative to the _installed package_ (i.e. inside `node_modules`) -- fine for
  the standalone checkout, almost never what a consumer wants. Pass a `dataDir`
  to move that root (the standalone server reads `WAS_DATA_DIR` into it; a
  library consumer reads its own env), or open a `FileSystemBackend` with an
  explicit `dataDir` through `await FileSystemBackend.open({ dataDir })` (plus
  `capacityBytes` / `maxUploadBytes` caps; the constructor is protected), or
  supply your own `StorageBackend` implementation. Injected backends carry their
  own root, so `dataDir` is ignored alongside them. The same holds for
  `originId`, the quotas and the clock options. `startTestServer` accepts
  `backends` and `defaultBackend` as well.

## Plugin options (`FastifyWasOptions`)

| Option                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`               | Required. Base URL used to build and match zcap `invocationTarget`s (exact-match, see above). Validated at registration: a missing value is refused, and it must be an absolute `http:`/`https:` URL with no userinfo, path, query, or fragment (sub-path deployment is not supported)                                                                                                                                                                                                                                |
| `backend`                 | The one-backend shorthand for `backends`: `backend: b` is `backends: [b]`. Passing both `backend` and `backends` is refused.                                                                                                                                                                                                                                                                                                                                                                                          |
| `backends`                | The server's own storage backends: an array of open `StorageBackend`s, or functions `({ logger }) => Promise<StorageBackend>` the plugin calls at registration, after validating its other options, with `fastify.log`, and closes with the app. Defaults to the fallback filesystem backend (see the caveat above). A backend with no origin id (one not obtained from `open()`) is refused, as are two backends under one fixed id or with different origin ids. Every backend opened so far is closed with the app |
| `defaultBackend`          | The fixed id (`fs` or `postgres`) that `default` aliases. Unset: `fs` when that backend is present, else the only backend                                                                                                                                                                                                                                                                                                                                                                                             |
| `ownsBackend`             | Whether the plugin manages every backend's lifecycle (default `true`): it sets each backend's `logger` to `fastify.log` and calls `close()` on Fastify's `onClose`. `false` does neither, for a composition that runs them itself, and requires injected, already open backends (the function form is refused). A backend is obtained from its async `open()` factory, which runs the migrations, so neither setting opens one                                                                                        |
| `cors`                    | The `@fastify/cors` registration. `false` registers none, so the composition can bring its own. An object overrides `origin` and/or `methods`. Default: `origin: '*'`, the methods the PWS routes serve, and the exposed headers browser clients need                                                                                                                                                                                                                                                                 |
| `dataDir`                 | Filesystem root of the fallback backend the plugin opens when no `backends` or `backend` is given. Injected backends carry their own root. `undefined` uses the project `data/` directory                                                                                                                                                                                                                                                                                                                             |
| `storageLimitPerSpace`    | Per-Space byte quota, applied only to the fallback filesystem backend (an injected backend carries its own `capacityBytes`)                                                                                                                                                                                                                                                                                                                                                                                           |
| `maxUploadBytes`          | Per-upload byte cap, likewise only for the fallback backend; also bounds the multipart buffer. Default-on: `undefined` applies the 64 MiB default; `Infinity` disables the cap                                                                                                                                                                                                                                                                                                                                        |
| `maxSpacesPerController`  | Max Spaces one controller may create (default-on count quota, default 100), only for the fallback backend; `Infinity` disables the cap                                                                                                                                                                                                                                                                                                                                                                                |
| `maxCollectionsPerSpace`  | Max Collections per Space (default-on count quota, default 100), only for the fallback backend; `Infinity` disables the cap                                                                                                                                                                                                                                                                                                                                                                                           |
| `providers`               | Provider-adapter registry for external (BYOS) Collection backends; defaults to empty                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `enabledBackendProviders` | Allowlist of registrable backend `provider` names; `undefined` = permissive                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `kmsRecordKek`            | At-rest WebKMS key-record encryption registry (multi-KEK, for rotation); `undefined` = key records written plaintext (the teaching default)                                                                                                                                                                                                                                                                                                                                                                           |
| `authorizeProvisioning`   | Gate callback for `POST /spaces/` and `POST /kms/keystores`; returns `'verify'` / `'grant'` / `'deny'` (or throws a `ProblemError`). `undefined` = allow (the teaching default)                                                                                                                                                                                                                                                                                                                                       |
| `onboardingToken`         | Shared-secret gate for the same two endpoints: when set, they require `Authorization: Bearer <token>` (which substitutes for zcap verification). Mutually exclusive with `authorizeProvisioning`                                                                                                                                                                                                                                                                                                                      |

## What the plugin does (and does not) register

`fastifyWas` is wrapped with `fastify-plugin`, so what it installs lands on the
**root** Fastify instance:

- decorations: `serverUrl`, `storage` (the control plane, with its logger wired
  to `fastify.log` unless `ownsBackend: false`), `serverBackends` (the
  `ServerBackends` set, whose `default` is `storage`), `backendProviders`,
  `enabledBackendProviders`;
- `@fastify/cors`, unless `cors: false` (by default `origin: '*'` and every
  method a PWS route serves -- PWS auth is signature-based, not cookie-based, so
  wide-open CORS is the protocol-appropriate setting; do not register
  `@fastify/cors` again yourself unless you pass `cors: false`);
- `@fastify/multipart` (its `fileSize` limit follows the backend's
  `maxUploadBytes`);
- content-type parsers: `application/*+json` parsed as JSON (the suffix ends at
  the media type, so `+jsonl` is not JSON), and a catch-all pass-through so
  arbitrary binary media types stream to storage;
- the route groups themselves, each in its own encapsulated context, so their
  auth/digest hooks and error handler do not apply to routes you add outside the
  plugin.

It deliberately does **not** register the teaching server's extras: the
static-assets route, the Handlebars welcome page, the `/health` probe, and the
`/api/cors` proxy are added by `createApp()`, not by the plugin. A downstream
composition brings its own equivalents (or uses `createApp` -- see next
section).

## The full teaching-server composition

If you want the standalone server's exact behavior (welcome page, `/health`,
CORS proxy included) inside your own process, use `createApp` -- it takes the
same options and passes them through to the plugin:

```ts
import { createApp } from '@interop/web-spaces-server'

const serverUrl = process.env.SERVER_URL
if (serverUrl === undefined) {
  throw new Error('SERVER_URL is required.')
}
const fastify = createApp({ serverUrl })
await fastify.listen({ port: 3002, host: '0.0.0.0' })
```

## Composing a hardened server

The intended production pattern is: register your policy and ops plugins first,
then `fastifyWas` with your persistence choice injected. Nothing protocol-shaped
lives downstream; anything that changes wire behavior belongs upstream in this
package.

```ts
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { fastifyWas, PostgresBackend } from '@interop/web-spaces-server'

const serverUrl = process.env.SERVER_URL
if (serverUrl === undefined) {
  throw new Error('SERVER_URL is required.')
}

const fastify = Fastify({ logger: true })

// The composition owns its backend: `open()` ran the migrations, and the
// composition drains the pool itself, so the plugin is told not to.
const backend = await PostgresBackend.open({
  connectionString: process.env.DATABASE_URL
})
fastify.addHook('onClose', async () => {
  await backend.close()
})

fastify.register(helmet)
fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' })
// ... metrics, an onboarding/registration gate, an admin route group ...

fastify.register(fastifyWas, {
  serverUrl,
  backend,
  ownsBackend: false
})

fastify.get('/health', async (request, reply) => {
  return reply.send({ status: 'pass' })
})

await fastify.listen({ port: 3002, host: '0.0.0.0' })
```

Two plugin defaults reach the composition's own routes, because `fastifyWas`
registers them on the root instance:

- `@fastify/cors` with `origin: '*'`. Every route the composition adds answers
  any origin too. To set its own CORS policy, a hardened composition passes
  `cors: false` and registers `@fastify/cors` itself, or passes a `cors` object
  with its own `origin`.
- The `'*'` catch-all content-type parser, which hands any body with an
  unmatched media type to the handler as a raw stream instead of answering 415.
  A composition route that expects only JSON checks the content type itself, or
  sits in an encapsulated context that calls `removeAllContentTypeParsers()` and
  adds back the parsers it accepts.

To let the plugin own the backend and log its startup work, pass the function
form instead:

```ts
fastify.register(fastifyWas, {
  serverUrl,
  backend: ({ logger }) =>
    PostgresBackend.open({ connectionString: process.env.DATABASE_URL, logger })
})
```

With `ownsBackend: false` the plugin does not set the backend's `logger`, so the
composition wires its own if it wants backend diagnostics in its log.

## Implementing a custom backend

The package ships two `StorageBackend` implementations: the reference
`FileSystemBackend` (JSON + blobs on disk) and `PostgresBackend` (rows in
PostgreSQL, with transactional quota accounting and row-lock conditional writes,
so multiple server processes can share one database). Both speak the same tar
export/import dialect, so archives migrate between them in either direction.

A custom persistence layer implements the same `StorageBackend` interface (the
package's second contract, alongside the wire protocol). The contract and its
invariants are documented on the interface itself; the load-bearing ones:

- getters resolve falsy for not-found (they do not throw);
- the request layer's Collection prelude reads a Collection through
  `getCollectionMetadataAndLogValidator`, and other paths still call
  `getCollectionMetadata`. A subclass that filters or instruments Collection
  reads overrides both;
- writes are upserts; deletes are idempotent;
- throw the package's typed errors (`PreconditionFailedError`,
  `PayloadTooLargeError`, ...) so the request layer's error handler maps them to
  the spec's problem-details responses;
- expose a `logger` property typed as Fastify's `FastifyBaseLogger`, defaulting
  to a silent logger -- the plugin overwrites it with `fastify.log` at
  registration (unless `ownsBackend: false`), so backend diagnostics flow to the
  server log.

```ts
import type { StorageBackend } from '@interop/web-spaces-server'

export class S3Backend implements StorageBackend {
  // ...
}
```

## Testing against the server

A consumer's own tests can boot the real server in-process through the
`@interop/web-spaces-server/testing` entry point. It carries the boot this
package's own suites use. It imports no test runner, so it works under Vitest,
`node:test`, or any other runner. It adds nothing to the plugin's options. It is
test support, not part of a production composition.

| Export                      | What it is                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `startTestServer`           | Boots the server on an OS-assigned port; returns `{ fastify, baseServerUrl, port, faults }`    |
| `RequestFaults`             | The class of `faults`: the request record and the tear and hold controls                       |
| `RequestMatch`              | The type of a fault's `match`: an object of `method` / `path` / `did`, or a function           |
| `RequestFaultDisarmedError` | Rejects the promise of a fault disarmed before any request took it                             |
| `RequestRecord`             | The type of one recorded request                                                               |
| `openTempBackend`           | Opens a `FileSystemBackend` on a fresh temp dir; its `close()` removes the dir                 |
| `TempFileSystemBackend`     | The type `openTempBackend()` returns (a type-only export)                                      |
| `provisionWebvhIdentity`    | Mints and publishes a self-hosted `did:webvh` with no wallet involved                          |
| `WebvhIdentity`             | The type `provisionWebvhIdentity()` returns                                                    |
| `webvhLogSigner`            | The `did:webvh` history-log signer for a `did:key` key pair                                    |
| `WebvhIdentityPublishError` | Thrown by `provisionWebvhIdentity()` when the log `PUT` is not answered 201                    |
| `frozenClock`               | A frozen, steppable physical clock for `physicalClock`                                         |
| `provisionServerIdentity`   | Writes a server identity into a bare backend: the `server` Space and its `did.jsonl` log       |
| `mintServerDid`             | Mints a server's `did:webvh` history log without writing it; `provisionServerIdentity` uses it |
| `injectPeerFetch`           | A pull-loop transport that hands each request to the in-process server the URL names           |
| `peerLogFetcherOf`          | A `peerLogFetcher` that reads a peer's `did:webvh` log from the peer's own storage             |
| `PeerFetch`                 | The type of the plugin's `peerFetch` option (a type-only export)                               |
| `bootPeerServer`            | Boots one server of a two-server replication test; returns a `PeerServer`                      |
| `PeerServer`                | The type `bootPeerServer()` returns                                                            |
| `signedInject`              | Sends one signed request to a booted `PeerServer` through `fastify.inject`                     |

`startTestServer()` takes the `createApp()` options except `serverUrl`, plus an
optional `port` and `logger`. The logger defaults to `false`. The server listens
on an OS-assigned port, so parallel test workers do not collide. The returned
`baseServerUrl` is `http://localhost:<port>/`, the origin with its trailing
slash: the base under which the server serves `service`, `spaces/` and
`space/{id}/`, and what a `@interop/pws-client` is built from
(`new PwsClient({ baseServerUrl })`). The no-slash form `createApp()` was given
is the returned instance's `fastify.serverUrl`, for a test that calls a
server-internal function taking `serverUrl`. The host is `localhost` because
`@interop/webkms-client` relaxes its loopback checks for that host alone.

ZCap `invocationTarget` URLs embed host and port. The port is not known until
the server listens, so build every client from the returned values, after the
boot.

When the boot fails, for example on a port already in use, `startTestServer()`
closes the Fastify instance before it rethrows. A backend the plugin owns is
closed with it. `openTempBackend()` likewise removes its temp dir when the
backend fails to open.

```ts
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { PwsClient } from '@interop/pws-client'
import {
  openTempBackend,
  startTestServer
} from '@interop/web-spaces-server/testing'

let fastify: FastifyInstance
let baseServerUrl: string
let did: string
let pws: PwsClient

beforeAll(async () => {
  const started = await startTestServer({ backend: await openTempBackend() })
  fastify = started.fastify
  baseServerUrl = started.baseServerUrl

  // Clients come after the boot, from the base server URL it returned: the
  // origin with its trailing slash, under which the server serves `service`,
  // `spaces/` and `space/{id}/`.
  const keyPair = await Ed25519VerificationKey.generate()
  did = `did:key:${keyPair.fingerprint()}`
  pws = PwsClient.fromSigner({
    baseServerUrl,
    signer: keyPair.didKeySigner()
  })
})

afterAll(async () => {
  await fastify.close()
})

it('creates a Space', async () => {
  const space = pws.space(randomUUID())
  await space.configure({ name: 'Test Space', controller: did })
  const metadata = await space.describe()
  assert.equal(metadata?.controller, did)
})
```

The examples here use `@interop/pws-client` and
`@interop/ed25519-verification-key`, which a consumer adds as its own dev
dependencies.

The plugin owns an injected backend by default (`ownsBackend: true`), so
`fastify.close()` calls the backend's `close()` and removes the temp dir. Call
`backend.close()` yourself when the server was started with
`ownsBackend: false`, when the backend never reached a server, or when a refused
plugin option failed the registration. A repeat call is a no-op.

A test that stops a server and boots a replacement over the same data needs a
dir that outlives the first server. It opens a plain `FileSystemBackend` over
its own dir through the async `open()` factory, and pins the replacement to the
first server's `port`. Ids the first server minted embed its URL, so they
resolve only on the same port. The test removes its dir when it is done.

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileSystemBackend } from '@interop/web-spaces-server'
import { startTestServer } from '@interop/web-spaces-server/testing'

const dataDir = await mkdtemp(path.join(tmpdir(), 'my-suite-'))

const first = await startTestServer({
  backend: await FileSystemBackend.open({ dataDir })
})
// ... write through clients built from first.baseServerUrl ...
await first.fastify.close()

const second = await startTestServer({
  backend: await FileSystemBackend.open({ dataDir }),
  port: first.port
})
// ... read back what the first server wrote ...
await second.fastify.close()
await rm(dataDir, { recursive: true, force: true })
```

`provisionWebvhIdentity()` sets up a self-hosted `did:webvh` by hand. It creates
a Space under a `did:key` owner, mints the DID in one of that Space's
Collections (`id` by default), and publishes its `did.jsonl` log there. It fits
a test about a server rule in which the identity is setup, not the thing under
test. The `owner` is a `{ did, pws }` pair, where `pws` is a `PwsClient` signed
by that `did:key`. The parameter is typed by the members the function calls,
since this package does not depend on `@interop/pws-client`. When a step fails
after the Space was created, the Space is deleted before the error is rethrown.

```ts
import { provisionWebvhIdentity } from '@interop/web-spaces-server/testing'

const ownerKey = await Ed25519VerificationKey.generate()
const owner = {
  did: `did:key:${ownerKey.fingerprint()}`,
  pws: PwsClient.fromSigner({
    baseServerUrl,
    signer: ownerKey.didKeySigner()
  })
}
const account = await provisionWebvhIdentity({
  owner,
  baseServerUrl,
  withLadderKey: true
})
// account.did resolves on this server. account.clientKeyPair and
// account.ladderKeyPair are listed in its document.
```

### Two servers in one process

A replication test runs a source server and a replica server in one process. The
replica registers the source and pulls from it, invoking the pull capability as
its own `did:webvh`, which the source server verifies by fetching the replica's
history log. A peer's `did:webvh` names a host with no port, which an ephemeral
test port cannot give, so the two servers never listen. Each is named by an
`https` URL such as `https://source.example`, every request reaches it through
`fastify.inject`, and the plugin's two network seams are replaced: `peerFetch`,
the pull loop's transport, and `peerLogFetcher`, the fetch of a foreign
`did:webvh` log.

`bootPeerServer()` does the whole boot. It opens a temp backend over a frozen
clock, writes a server identity whose key is listed under `capabilityInvocation`
(`provisionServerIdentity`), builds the app with that identity's seed and the
two seams wired to the other servers in `servers`, and pauses the replication
timers, so a test runs each pull by hand with
`fastify.replication.pullNow({ spaceId, replicaId })`. The returned `PeerServer`
carries the app, the backend, the clock (`clock.now` steps the write stamps),
and the server's `did` and `didLog`. A server is added to `servers` under its
URL, which must be a bare origin, since both seams look a server up by the
origin of the URL they are handed; a second boot at an origin already in the map
is refused. Both seams read the map on every call, so a server may be booted
after the others. A boot that fails after its backend opened closes the backend,
so no temp dir is left behind.

A consumer signs the requests it injects, as a client would. `signedInject()`
does that: it signs an invocation of the root capability of the Space the path
is under (or of the `capability` given) with the signer passed, and injects it
with a `host` header naming the server. `registerReplica()` is the registration
recipe: it delegates the source Space's root capability to the replica's `did`
as an ezcap delegation and posts the registration to the replica, and
`replicaStatus()` reads the registration's status document. The plugin owns each
server's backend, so `fastify.close()` is the teardown, and it removes the
server's temp dir.

```ts
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  bootPeerServer,
  registerReplica,
  replicaStatus
} from '@interop/web-spaces-server/testing'
import type { PeerServer } from '@interop/web-spaces-server/testing'

// The controller of the Spaces on both servers, and the signer of every
// request the test sends.
const keyPair = await Ed25519VerificationKey.generate()
const controller = `did:key:${keyPair.fingerprint()}`
const signer = keyPair.didKeySigner()

const servers = new Map<string, PeerServer>()
const source = await bootPeerServer({
  serverUrl: 'https://source.example',
  servers
})
const replica = await bootPeerServer({
  serverUrl: 'https://replica.example',
  servers
})

// A Space on each server, under one controller, through the backend.
for (const server of [source, replica]) {
  await server.backend.writeSpace({
    spaceId: 'data',
    spaceMetadata: { id: 'data', type: ['Space'], controller }
  })
}

// The registration: the source Space's root capability delegated to the
// replica's DID, posted to the replica as `peer`, signed by the controller.
await registerReplica({
  to: replica,
  toSpaceId: 'data',
  from: source,
  fromSpaceId: 'data',
  signer,
  delegator: { did: controller, signer }
})

await replica.fastify.replication.pullNow({
  spaceId: 'data',
  replicaId: 'peer'
})
const status = await replicaStatus({ server: replica, spaceId: 'data', signer })

// Teardown: closing each app closes its backend and removes its temp dir.
await source.fastify.close()
await replica.fastify.close()
```

The pieces are exported on their own for a boot that differs from this one. A
single listening server (`startTestServer`) gets an identity by calling
`provisionServerIdentity({ backend, serverUrl, seed })` before the boot and
passing the same `seed` as `serverKeySeed`; its `serverUrl` is the no-slash
form, `http://localhost:<port>`, which a pinned `port` makes known in advance.
`injectPeerFetch(servers)` and `peerLogFetcherOf(servers)` are the two seams,
each over a map of servers by origin, and `frozenClock()` is the clock
`physicalClock` takes.

The document always lists one enrolled-client key under all four signing
relations. `withLadderKey` adds a key under `assertionMethod` and
`capabilityDelegation` alone, the ladder verification method shape.
`withTransientKey` adds one under `capabilityInvocation` and
`capabilityDelegation` alone, the transient annex verification method shape. The
returned `ladderKeyPair` and `transientKeyPair` are typed as present when the
matching flag is the literal `true`. `services` sets the document's service
entries. The Space stays under the `did:key` owner. Promoting it to the new DID
is left to the test, since Space creation accepts a `did:key` controller alone.

### Failing and holding a request

`startTestServer()` also returns `faults`, for a test about a run interrupted
between two requests. Its hooks run ahead of every route group's own hooks, the
`/kms` routes included, so a fault fires before authorization and before any
handler.

| Member                                    | What it does                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `faults.requests`                         | Every request so far, in arrival order: `{ method, path, did?, status?, fault? }`             |
| `faults.refuse({ match, status, times })` | Answers the matching request with `status` (default 503) before any handler runs              |
| `faults.dropResponse({ match, times })`   | Lets the matching request be applied, then closes the connection in place of the response     |
| `faults.hold({ match })`                  | Pauses the matching request before any handler runs; returns `{ held, release }`              |
| `faults.reset()`                          | Disarms every fault not yet taken, releases every held request, and empties `faults.requests` |

The two tears leave different states. A refused request leaves the store
untouched. A dropped response leaves the write stored while the client sees a
transport failure. The second is the state a re-run has to detect from what is
stored.

`match` is an object naming any of `method`, `path`, and `did`, or a function
over the request's record. `path` is compared with the query string removed, as
an exact string or a `RegExp`. A string is compared with percent-encoding
decoded on both sides, so `my doc` matches a request for `my%20doc`. Its
trailing slash counts: a container URL and its no-slash form are different
requests. `did` is the DID of the `Authorization` header's `keyId`. It is read
before any signature is verified, so it names who the request claims to be
signed by. An object with no `method` never matches an `OPTIONS` request, so a
browser's CORS preflight does not take a fault meant for the request behind it.

A fault fires on the first matching request and is then disarmed. `refuse()` and
`dropResponse()` return `{ fired }`, a promise that resolves with the request's
record when the fault is first taken. `times` is a positive integer or
`Infinity`, and anything else throws a `RangeError`.

A fault disarmed before any request took it rejects its `fired` or `held`
promise with a `RequestFaultDisarmedError`. That happens on `reset()`, when the
server closes, and when a hold's `release()` is called before its request
arrives. A test awaiting a request that never came then fails with that error
instead of timing out.

A refusal is sent ahead of the CORS plugin, so it sets
`Access-Control-Allow-Origin: *` itself on a request that carries an `Origin`
header. A browser-driven test then reads the refusal's status instead of a CORS
failure. A record's `status` is read when the response head is written, after
every `onSend` hook.

`@interop/pws-client` retries a request that fails with a 5xx or a dropped
connection. A fault that fires once is then absorbed by the retry, and the
caller sees a success. Pass `times` (`Infinity` is allowed) to fail the retries
too, or refuse with a 4xx status, which is not retried. Under `dropResponse()`
each retried write is applied again.

`dropResponse()` is meant for writes. A response the server streams may have
nothing left to lose by the time the connection closes.

```ts
const { fastify, baseServerUrl, faults } = await startTestServer({
  backend: await openTempBackend()
})
// ... build clients, provision a Space and a `notes` Collection ...
const notes = pws.space(spaceId).collection('notes')
const path = `/space/${spaceId}/notes/second`

// A ceremony that writes two Resources, torn at the second write. The write
// lands, and the client is told it failed.
faults.dropResponse({ match: { method: 'PUT', path }, times: Infinity })
await notes.put('first', { step: 1 })
await assert.rejects(notes.put('second', { step: 2 }))

faults.reset()
assert.deepEqual(await notes.get('second'), { step: 2 })
```

A hold interleaves two clients at a chosen request. `held` resolves once the
request has arrived and is paused. Closing the server releases every held
request, so a test that fails before `release()` does not hang `close()`.

```ts
const { held, release } = faults.hold({ match: { method: 'PUT', path } })
const first = notes.put('second', { writer: 'first' })
await held
await notes.put('second', { writer: 'second' })
release()
await first
// The held write was applied last.
```

## Verifying your composition

The `pws-conformance` CLI (from
[`@interop/pws-conformance-suite`](https://github.com/interop-alliance/pws-conformance-suite))
runs against any PWS server by URL and is the definition of "speaks PWS." Point
it at your composed server:

```bash
npx pws-conformance http://localhost:3002
```

The URL must be exactly the `serverUrl` the server was started with (the same
exact-match rule as above). If your server gates `POST /spaces/` behind an
onboarding token, pass `--token`.
