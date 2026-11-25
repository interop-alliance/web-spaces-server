# Web Spaces Server (_@interop/web-spaces-server_)

[![Node.js CI](https://github.com/interop-alliance/web-spaces-server/workflows/CI/badge.svg)](https://github.com/interop-alliance/web-spaces-server/actions?query=workflow%3A%22CI%22)

> A basic
> [Portable Web Spaces](https://w3c-ccg.github.io/portable-web-spaces-spec/)
> Server used to demonstrate the specification

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Security](#security)
- [License](#license)

## Background

See:

- [Portable Web Spaces Specification](https://w3c-ccg.github.io/portable-web-spaces-spec/)
- [ARCHITECTURE.md](ARCHITECTURE.md) -- request flow, domain model, and ZCap
  authorization structure
- [CONTRIBUTING.md](CONTRIBUTING.md) -- code style and contribution conventions
- [ROADMAP.md](ROADMAP.md) -- spec-gap analysis and tracked work items
  (structured `WSS-N` entries with status, priority, and acceptance criteria)

### Supported Features

Authorization: Uses `ZcapClient` from `@interop/ezcap`, see the
[zCap Developer Guide](https://github.com/interop-alliance/zcap-developer-guide)
for more details.

#### Spaces API

A container (a Space, a Collection) is canonically addressed WITH a trailing
slash: `GET` lists its members, `POST` adds one, `DELETE` removes the container,
and `PUT` is not defined there (405). Its description lives at its `meta`
sub-resource. The no-slash form of a container URL redirects to the slash form
with a `308`, so a client should build the canonical form directly (a signed
request must be re-signed for the redirect target).

- [Create Space](https://w3c-ccg.github.io/portable-web-spaces-spec/#http-api-post-spaces)
  (`POST /spaces/`)
- [List Spaces](https://w3c-ccg.github.io/portable-web-spaces-spec/#list-spaces-operation)
  (`GET /spaces/`)
- [Read Space](https://w3c-ccg.github.io/portable-web-spaces-spec/#read-space-operation)
  (`GET /space/:spaceId/meta` -- the Space Metadata object)
- [Update Space (or Create Space by Id)](https://w3c-ccg.github.io/portable-web-spaces-spec/#update-or-create-by-id-space-operation)
  (`PUT /space/:spaceId/meta`)
- [Delete Space](https://w3c-ccg.github.io/portable-web-spaces-spec/#delete-space-operation)
  (`DELETE /space/:spaceId/`)

#### Collections API

- [List Collections](https://w3c-ccg.github.io/portable-web-spaces-spec/#list-all-collections-operation)
  (`GET /space/:spaceId/`; the retired `/space/:spaceId/collections/` redirects
  here with a `308`)
- [Create Collection](https://w3c-ccg.github.io/portable-web-spaces-spec/#create-collection-add-collection-to-a-space-operation)
  (`POST /space/:spaceId/`)
- [Read Collection Metadata](https://w3c-ccg.github.io/portable-web-spaces-spec/#read-collection-metadata-operation)
  (`GET /space/:spaceId/:collectionId/meta` -- the merged Collection Metadata
  object: configuration members beside `createdAt`, the write stamp
  (`updatedAt`, `updatedAtCounter`, `originId`), `custom` and `epoch`, under one
  `ETag`)
- [Update Collection (or Create Collection by Id)](https://w3c-ccg.github.io/portable-web-spaces-spec/#update-or-create-by-id-collection-operation)
  (`PUT /space/:spaceId/:collectionId/meta` -- a full replacement that creates
  the Collection when absent)
- [List Resources in a Collection](https://w3c-ccg.github.io/portable-web-spaces-spec/#list-collection-operation)
  (`GET /space/:spaceId/:collectionId/`)
- [Delete Collection](https://w3c-ccg.github.io/portable-web-spaces-spec/#delete-collection-operation)
  (`DELETE /space/:spaceId/:collectionId/`)

#### Resources API

- [Create Resource](https://w3c-ccg.github.io/portable-web-spaces-spec/#create-resource-add-resource-to-collection-operation)
  (`POST /space/:spaceId/:collectionId/`)
  - both JSON objects and binary blobs
- [Get Resource by Id](https://w3c-ccg.github.io/portable-web-spaces-spec/#read-resource-operation)
  (`GET /space/:spaceId/:collectionId/:resourceId`)
- [Head Resource by Id](https://w3c-ccg.github.io/portable-web-spaces-spec/#content-types-and-representations)
  (`HEAD /space/:spaceId/:collectionId/:resourceId`)
  - same headers as `GET` with no body; `Content-Type`/`Content-Length` from the
    Resource's Metadata
- [Update Resource (or Create Resource by Id)](https://w3c-ccg.github.io/portable-web-spaces-spec/#update-or-create-by-id-resource-operation)
  (`PUT /space/:spaceId/:collectionId/:resourceId`)
- [Delete Resource by Id](https://w3c-ccg.github.io/portable-web-spaces-spec/#delete-resource-operation)
  (`DELETE /space/:spaceId/:collectionId/:resourceId`)

**Uploading binary resources (and large files).** Send the file as the **raw
request body** with its own `Content-Type` (e.g. `image/png`) -- not wrapped in
a form. The server streams a raw-body upload straight to storage (enforcing the
upload cap as it goes), so this is the path for large files. The write must
still be zCap-signed, and because the signature covers the `Digest` header, the
client hashes the whole body before sending (a plain browser `<form>` cannot do
this -- uploads are made programmatically by a signing client). The OPTIONAL
`multipart/form-data` upload is supported as a convenience for the HTML-form
workflow: it MUST carry exactly one file part, and the server buffers that part
in memory bounded by `MAX_UPLOAD_BYTES`, so it is best suited to smaller
uploads. Any other `multipart/*` media type is stored as an opaque blob, like
any other raw body. `MAX_UPLOAD_BYTES` also bounds a JSON or text Resource
write, which the server buffers in memory the same way.

#### Access Control Policy (public read)

By default every operation requires a capability invocation. A **policy**
auxiliary resource can override this to make a Space, Collection, or Resource
world-readable — the common "create public link" use case (e.g. a wallet sharing
a Verifiable Credential).

- CRUD the policy at any level (controller-only):
  - `GET|PUT|DELETE /space/:spaceId/policy`
  - `GET|PUT|DELETE /space/:spaceId/:collectionId/policy`
  - `GET|PUT|DELETE /space/:spaceId/:collectionId/:resourceId/policy`
- Discover a policy via the `linkset` property on the Space/Collection Metadata
  object, or `GET /space/:spaceId[/:collectionId]/linkset`
  (`application/linkset+json`, RFC9264).

How a read is authorized: the server tries the capability invocation first; if
none is presented, or it does not grant access, it falls back to the **effective
policy** (resolved most-specific-first: Resource > Collection > Space). Policies
are **permissive-only** — they can only broaden access beyond capabilities,
never deny a valid capability holder. A denied read returns `404` (so existence
is not leaked); writes always require a capability.

The policy document is a small, `type`-discriminated, extensible shape. v1
recognizes one type (any other `type` is treated as "grants nothing", so it
falls through to the capability-only decision):

```json
{ "type": "PublicCanRead" }
```

Set it, for example, on a `public-credentials` Collection so anyone can
`GET /space/:spaceId/public-credentials/:resourceId` without authorization. This
minimal canned-policy approach (cf. S3 `public-read`, `chmod o+r`) covers the
dominant public-read case; a richer policy language (e.g. Cedar) is left as a
future, separate tier.

#### Ephemeral Exchanges

A transient rendezvous for cross-device flows: one page creates an exchange
holding an opaque request, shows its URL as a QR code, and polls it until
another device (a phone wallet, say) posts the answer back. This is not part of
the PWS protocol; it is a small convenience facet the teaching server hosts
alongside it.

- `POST /workflows/ephemeral/exchanges` — body `{ "request": <opaque JSON> }`;
  returns `201` with the exchange URL in both the `Location` header and a
  `{ "location": ... }` body. Refused with `429` once the server is holding its
  cap of live exchanges.
- `POST /workflows/ephemeral/exchanges/:exchangeId` — with no body (or `{}`),
  returns the stored `request` verbatim ("begin"); with any other body, stores
  that body as the exchange's response and echoes it back (last write wins).
- `GET /workflows/ephemeral/exchanges/:exchangeId` — polls:
  `{ id, sequence: 0, state: "pending" }` until a response has been posted, then
  `{ id, sequence: 1, state: "complete", response }`.
- `GET /workflows/ephemeral/exchanges/:exchangeId/protocols` — the interaction
  endpoint a QR encodes; returns `{ "protocols": { "vcapi": <exchange URL> } }`.

**Security posture.** These routes are unauthenticated by design: the exchange
URL is a **capability URL**, and possession of that unguessable URL is the only
access control, so it must be handled as a secret (and only ever passed over a
channel that keeps it one). The server never inspects the relayed payloads —
they are opaque JSON to it. Every exchange is transient: in memory only,
expiring about ten minutes after creation, bounded in number, and lost on
restart. Nothing here reads or writes a Space, and no capability is granted.
Both `POST` bodies are capped at 64 KiB.

## Install

Requires Node.js 24.x and [`pnpm`](https://pnpm.io/).

```
pnpm install
```

This server is written in TypeScript. In development it runs directly via
[`tsx`](https://github.com/privatenumber/tsx) (no build step); for production it
is compiled with `tsc` to `dist/`.

## Usage

### Running in Development

`tsx` runs the TypeScript sources directly and watches for changes (views are
served from `src/views`, so no asset copy is needed). `HOST=localhost` keeps a
development server off the network:

```
SERVER_URL='http://localhost:3002' PORT=3002 HOST=localhost WAS_DATA_DIR=data pnpm dev
```

### Building and Starting the Server

`pnpm build` compiles `src/` to `dist/` and copies `src/views` > `dist/views`,
then `pnpm start` runs the compiled output as plain JSON logs
(`pnpm start:pretty` pipes them through `pino-pretty` for reading in a
terminal):

```
pnpm build
SERVER_URL='http://localhost:3002' PORT=3002 WAS_DATA_DIR=data pnpm start
```

`SIGTERM` or `SIGINT` shuts the server down gracefully. It stops accepting
connections, waits up to 10 seconds for in-flight requests, and closes the
storage backend. A supervisor should signal the `node` process itself: under
`pnpm start:pretty` the signal reaches the shell running the pipe, which does
not forward it.

### Using as a Library

The PWS protocol surface is also exported as a registerable Fastify plugin,
`fastifyWas`, so a downstream server can compose it with its own persistence
backend and security plugins. See
[Consuming the Server as a Library](docs/consuming-server-as-library.md). A
consumer's tests can boot the server in-process through the
`@interop/web-spaces-server/testing` entry point.

### Environment Variables

The whole env surface below is read and validated once at startup
(`loadConfigFromEnv` in `src/config.default.ts`): a missing `SERVER_URL` or any
malformed value fails startup immediately with the offending variable named,
rather than surfacing later as broken ZCap matching.

| Variable                         | Default                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SERVER_URL`                     | (none)                                              | **Required.** This server's base URL; used to build and match ZCap `invocationTarget` URLs (host and port must match the client's exactly). Must be an absolute `http:`/`https:` URL with no path, query, or fragment -- deploying under a sub-path is not supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PORT`                           | `3002`                                              | TCP port to listen on (a decimal integer between 1 and 65535). When `SERVER_URL` is a loopback URL (`localhost`, `127.x.x.x`, `[::1]`) on a different port, startup logs a warning, since clients reaching the listening port will match no capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `HOST`                           | `0.0.0.0`                                           | Address to listen on. The default binds every IPv4 interface, as a container deployment needs; `HOST=localhost` binds loopback only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_URL`                   | (unset = no Postgres backend)                       | Configures the **PostgreSQL storage backend**: a `postgres://` connection string (e.g. `postgres://was:was@localhost:5433/was`). Schema migrations are applied automatically at startup. May be set together with `WAS_DATA_DIR`, which makes both backends available. With neither set, startup fails. See [Storage Backends](#storage-backends).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WAS_DATA_DIR`                   | (unset = no filesystem backend)                     | Configures the **filesystem backend** and is its root for Spaces, keystores, and revocations. There is no default directory: unset, the server has no filesystem backend. A relative value resolves against the process working directory. Point it at a scratch directory to run a test suite against a fresh server each time. See [Storage Backends](#storage-backends).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WAS_DEFAULT_BACKEND`            | (unset = `fs` if configured, else the only backend) | `fs` or `postgres`: the backend the conventional `default` id aliases, the data plane of every Collection that selects `default` or no backend. Naming a backend that is not configured, or any other value, is a startup error. Set it once and keep it; see [Storage Backends](#storage-backends).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WAS_CONTROL_PLANE_BACKEND`      | (unset = `postgres` if configured, else `fs`)       | `fs` or `postgres`: the control plane, which holds every Space and Collection Metadata object, the policies, the registrations, keystores and revocations. Unset, the database holds it whenever one is configured, while `default` stays the filesystem backend. Naming a backend that is not configured, or any other value, is a startup error. Set it once and keep it; see [Storage Backends](#storage-backends).                                                                                                                                                                                                                                                                                                                                                               |
| `STORAGE_LIMIT_PER_SPACE`        | (unset = unlimited, warned)                         | Per-Space storage quota in **bytes** (spec "Quotas"). When set, writes that would push a Space over this limit are rejected with `quota-exceeded` (507). Unset means each Space is unlimited, and startup logs a warning; set `unlimited` to acknowledge the choice explicitly and silence it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAX_UPLOAD_BYTES`               | `67108864` (64 MiB)                                 | Per-upload size cap in **bytes** (spec "Quotas", the backend's `maxUploadBytes` constraint), default-on. A single upload exceeding it is rejected with `payload-too-large` (413) -- distinct from the cumulative `STORAGE_LIMIT_PER_SPACE`. Also bounds a buffered JSON or text Resource write, so both accept the same size. Set `unlimited` to remove the cap (filesystem backend only: the Postgres backend buffers each upload in memory as a single `bytea`, so it rejects `unlimited` at startup); a buffered body still falls back to a 64 MiB limit even when `unlimited` is set, since only a streamed blob write on the filesystem backend becomes uncapped.                                                                                                               |
| `MAX_SPACES_PER_CONTROLLER`      | `100`                                               | Max number of Spaces a single controller DID may create (a default-on count quota). A create beyond the limit is rejected with `quota-exceeded` (507); overwriting an existing Space never trips it. Auxiliary Spaces (typed `AuxiliarySpace`) count toward it, and List Spaces lists them with their `type`. Set `unlimited` for no cap. Hard (transactional) on the Postgres backend, soft under concurrency on the filesystem backend -- like the byte quota.                                                                                                                                                                                                                                                                                                                     |
| `MAX_COLLECTIONS_PER_SPACE`      | `100`                                               | Max number of Collections one Space may hold (a default-on count quota, also enforced during a tar import). A create beyond the limit is rejected with `quota-exceeded` (507); overwriting an existing Collection's description never trips it. Set `unlimited` for no cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KMS_RECORD_KEK`                 | (unset = disabled)                                  | At-rest encryption key for WebKMS key records: a single AES-256 key-encryption key (KEK) in base58btc Multikey form (`secretKeyMultibase`, header `0xa2 0x01`) -- the single-KEK alias. When set, the secret fields of newly generated `/kms` key records are envelope-encrypted under it before they reach storage; existing plaintext records stay readable. Unset means key records are stored **plaintext** (the teaching default). Mutually exclusive with `KMS_RECORD_KEKS`.                                                                                                                                                                                                                                                                                                   |
| `KMS_RECORD_KEKS`                | (unset = disabled)                                  | A comma-separated list of AES-256 KEKs (same Multikey form as `KMS_RECORD_KEK`), for registering more than one KEK so a rotation can add a new KEK while keeping the old one available to decrypt records already written under it. Each KEK is registered by an id derived from its material; surrounding whitespace is trimmed and empty entries ignored; a duplicate entry is a startup error. The **first entry is the current KEK** (the one that wraps new records) by default -- so a rotation is "prepend the new KEK, keep the old behind it". Use `KMS_RECORD_KEK` for the single-KEK case; setting both is a startup error.                                                                                                                                               |
| `KMS_RECORD_CURRENT_KEK`         | (unset = first entry)                               | Optionally overrides which registered KEK wraps **new** records: a `urn:kek:sha256:<hex>` id, a multibase KEK value (its id is derived), or the literal `none` (case-insensitive). It must name a KEK registered via `KMS_RECORD_KEK`/`KMS_RECORD_KEKS`. `none` is the **decrypt-only** posture -- existing encrypted records still read, but new key records are written **plaintext** (the wind-down path). Setting it with no KEK configured is a startup error.                                                                                                                                                                                                                                                                                                                  |
| `WAS_ONBOARDING_TOKEN`           | (unset = disabled)                                  | Shared-secret onboarding token gating provisioning: `POST /spaces/`, a `PUT /space/:spaceId/meta` that creates a Space, and `POST /kms/keystores`. When set, those require an `Authorization: Bearer <token>` header, which then substitutes for ZCap verification on that request; every other operation still uses the normal capability-invocation path. Unset means provisioning is open -- anyone may create a Space or keystore by proving control of the `controller` DID in the request body (the teaching default). A set but empty value is a startup error. See [Provisioning gate](#provisioning-gate).                                                                                                                                                                  |
| `WAS_DISCLOSE_VERSION`           | `true`                                              | Whether the exact server version is published. `false` removes it from `/health` (together with the build commit and time), from the welcome page, and from the service description's `instance` member, for a hardened deployment. Accepts `true` or `false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `WAS_SERVER_KEY_SEED`            | (unset = no signing key)                            | The 32-byte Ed25519 seed the server's export-signing key is derived from, in bnid's secret-key-seed encoding (`z1A...`, as `generateSecretKeySeed()` from `@interop/bnid` mints). The key is advertised on `/service` as `instance.exportSigningMethod`. Once the server DID lists it, exports carry signed provenance (`provenance.jsonl` plus the log snapshot `did.jsonl`). Unset means the server has no signing key and exports are unsigned. A malformed value or one of the wrong length is a startup error. See the [Administrator's Guide](docs/admin-guide.md#server-identity).                                                                                                                                                                                            |
| `WAS_ADMIN_DID`                  | (unset = not provisioned)                           | The Ed25519 `did:key` of the administrator. When set, the server provisions the `server` Space at startup with this DID as its controller (typed `AuxiliarySpace` + `ServerInstanceSpace`, listed for the admin by List Spaces; the id `server` is reserved on every client create regardless of this setting); the admin writes the server's `did:webvh` history log into that Space's `id` Collection. A stored `server` Space with another controller or without the subtype is a startup error. See the [Administrator's Guide](docs/admin-guide.md#server-identity).                                                                                                                                                                                                            |
| `WAS_ORIGIN_ID`                  | (unset = kept or minted)                            | The store's origin id, the origin half of a write's replicated identity: 1 to 64 characters from `[A-Za-z0-9_-]`, used verbatim. Unset, the store keeps the id it carries, or mints a random one on its first boot and keeps it for the store's life (filesystem: `originId` in the data dir's `store.json`; Postgres: the `store` table). A set value that differs from the stored id is a startup error naming both, as is a malformed value. It is one value across the configured backends: with it unset, two stores that each minted their own id fail startup, naming both. Advertised on `/service` as `originId` on the core specs entry. Must be unique among every server a Space may replicate to. See the [Administrator's Guide](docs/admin-guide.md#store-origin-id). |
| `WAS_REPLICATION_CLOCK_BOUND_MS` | `60000`                                             | The clock bound for a write stamp received from a peer: how far ahead of this server's physical clock, in milliseconds, its time may be before the store's hybrid logical clock refuses it. A positive integer; anything else is a startup error. A stamp dated further ahead stalls the pull of its Collection until local time catches up. See the [Administrator's Guide](docs/admin-guide.md#write-stamps).                                                                                                                                                                                                                                                                                                                                                                      |
| `WAS_WEBVH_BLOCKLIST`            | (unset = none)                                      | A comma-separated list of foreign `did:webvh` hosts and DIDs whose history log is not fetched. A `did:webvh` on another host may invoke a capability delegated to it once its delegation chain verified, and this server then fetches its log from that host. A host name entry blocks every DID on that host (compared case-insensitively). A full `did:webvh` entry blocks that DID alone. A blocked DID is refused before any fetch, with the same `404` as a chain that did not verify. A malformed entry is a startup error naming it. See the [Administrator's Guide](docs/admin-guide.md#foreign-didwebvh-invokers).                                                                                                                                                          |

### Provisioning gate

By default, anyone may create a Space or a WebKMS keystore by proving control of
the `controller` DID named in the request body -- the open, teaching-server
behavior. A Space is created by `POST /spaces/`, or by a `PUT` of the Metadata
object of a Space that does not exist yet (`PUT /space/:spaceId/meta`); a
keystore by `POST /kms/keystores`. A deployment can gate all three in one of two
mutually-exclusive ways. A `PUT` that updates an existing Space is not gated.

- **Onboarding token** -- set `WAS_ONBOARDING_TOKEN` (or pass `onboardingToken`
  to the `fastifyWas` plugin / `createApp`). Provisioning then requires an
  `Authorization: Bearer <token>` header matching the configured secret; a valid
  token substitutes for ZCap verification on that request. Leave it unset for
  open provisioning. A set but empty value is refused at startup.
- **Custom policy** -- pass an `authorizeProvisioning` callback to the plugin.
  It receives `{ request }` and returns `'verify'` (run the normal ZCap path),
  `'grant'` (authorize the request itself, skipping ZCap verification), or
  `'deny'` (403); it may also throw a `ProblemError` for a custom response. Any
  other return value is refused as `'deny'`.

Both configure the same seam; setting both at once is rejected at startup.

### Storage Backends

Two interchangeable first-party backends implement the same `StorageBackend`
contract (`src/types.ts`). The server runs any set of them, each configured by
its own setting:

- **Filesystem** (id `fs`): configured by `WAS_DATA_DIR`, which is its root.
  There is no default directory. Zero other setup.
- **PostgreSQL** (id `postgres`): configured by `DATABASE_URL`. Quota accounting
  is transactional (a _hard_ per-Space limit, unlike the filesystem's documented
  soft limit), conditional writes use row locks instead of an in-process mutex,
  and blob uploads are buffered `bytea` writes bounded by `MAX_UPLOAD_BYTES`
  (default 64 MiB; `MAX_UPLOAD_BYTES=unlimited` is rejected at startup, since
  the in-memory buffering makes an unbounded upload unsafe). A buffered JSON or
  text write is bounded the same way on either backend, and stays bounded at the
  64 MiB default even when `MAX_UPLOAD_BYTES=unlimited` is accepted (filesystem
  backend only), since a buffered body is held in memory regardless of the cap.

With neither setting, startup fails with "No storage backend is configured."
`WAS_DEFAULT_BACKEND` picks the backend that the id `default` aliases: the data
plane of every Collection that selects `default` or no backend. A client selects
the other backend per Collection with `backend: { id: 'postgres' }` (or `'fs'`).
`WAS_CONTROL_PLANE_BACKEND` picks the control plane, which holds every Space and
Collection Metadata object, the policies, the backend and replica registrations,
keystores and revocations, whatever a Collection selects. Unset, it is
`postgres` when that backend is configured, else `fs`. So a deployment with both
backends and neither setting keeps its records in the database and its Resource
bytes on disk; set `WAS_CONTROL_PLANE_BACKEND=fs` to keep everything on disk.
`GET /space/:spaceId/backends` lists the `default` alias entry first, then each
configured backend under its fixed id (the control plane first), then the
Space's registered external backends. Registering an external backend under
`default`, `fs` or `postgres` is refused.

A Collection on a backend other than the control plane has its Resources,
chunks, listings and `changes` feed served by that backend. That backend refuses
a write whose Space or Collection Metadata object is absent from its own store,
so the server keeps a copy (a mirror) of each there, of the Collection's
governing history log once it has one, and of each policy in the Collection.
Reads never consult the copy, and the Delete calls remove it. The Collection's
`changes` feed serves its `collection-metadata`, `log` and `policy` documents
under the control plane's validator, the one a GET of the record answers. The
write-through to the copy is not atomic, and a fault is brought level by the
next write or a retried request. A Collection's `backend` cannot change once set
(409 `backend-immutable`). `GET /space/:id/quotas` returns one `backends` entry
per server backend under its fixed id, and each enforces
`STORAGE_LIMIT_PER_SPACE` against its own per-Space usage. Export Space composes
one archive across the backends, and Import Space splits it back to them.

A Collection's `backend.id` is stored as sent. Changing `WAS_DEFAULT_BACKEND` on
a store that already has Collections therefore moves every `default`
Collection's data plane to the other backend, and its Resources appear missing.
Changing `WAS_CONTROL_PLANE_BACKEND` moves where every Space is looked up, so
every Space appears missing. Set both once. The origin id must be one value
across the backends. When adding Postgres beside an existing filesystem store,
set `WAS_ORIGIN_ID` to the filesystem store's id, which the fresh Postgres store
adopts.

Each backend assumes one server process per store. Every versioned write carries
a write stamp minted by the store's clock under the store's origin id, and two
processes over one data directory or database could mint the same stamp for two
different writes.

To run a disposable local Postgres with Podman (substitute `docker` if you
prefer; the commands are identical):

```bash
# One-time: pull and start Postgres 17 with a named volume for data.
# Host port 5433 avoids colliding with any system Postgres on 5432.
podman run -d --name was-postgres \
  -e POSTGRES_USER=was \
  -e POSTGRES_PASSWORD=was \
  -e POSTGRES_DB=was \
  -p 5433:5432 \
  -v was-pgdata:/var/lib/postgresql/data \
  docker.io/library/postgres:17

# Verify it is accepting connections:
podman exec was-postgres pg_isready -U was

# Day-to-day lifecycle:
podman stop was-postgres
podman start was-postgres

# Full teardown (drops all stored data):
podman rm -f was-postgres && podman volume rm was-pgdata
```

Then start the server against it:

```bash
DATABASE_URL=postgres://was:was@localhost:5433/was pnpm dev   # Postgres only
# Add WAS_DATA_DIR=data (and WAS_ORIGIN_ID) to run both backends
```

Schema migrations are embedded (`src/backends/postgresSchema.ts`) and applied
idempotently at startup. A data directory or database that holds any Space
written before write stamps is refused at startup, with no migration. Wipe it,
or restore each Space from an export archive into an empty store. To migrate
existing data between backends, export each Space from one server and import it
into the other -- both backends speak the same tar archive dialect
(`POST /space/:id/export` / `.../import`).

### Running Tests

The full gate (lint + build + Vitest integration tests):

```
pnpm test
```

Just the Vitest integration suite under `test/`:

```
pnpm test-node
```

The Postgres backend tests are **opt-in**: they are skipped unless
`WAS_TEST_DATABASE_URL` points at a running (disposable) Postgres. With the
Podman container above running:

```
pnpm test:pg
```

Each suite isolates itself in a throwaway `was_test_<hex>` schema, dropped on
teardown, so parallel test workers never collide and the container stays
reusable.

A run without `WAS_TEST_DATABASE_URL` prints a warning before and after the
tests that names the files it skipped. It also leaves out the storage-contract
tests for the hard quota under concurrent writers and for exact usage
accounting, since only the Postgres backend supports them. CI runs every suite
against a Postgres service container.

### Conformance Tests

Protocol conformance testing lives in its own package,
[`@interop/pws-conformance-suite`](https://github.com/interop-alliance/pws-conformance-suite),
which ships a `pws-conformance` CLI that runs against any PWS server by URL
(installed here as a devDependency). The URL passed to the CLI and the server's
`SERVER_URL` **must be byte-for-byte identical** (including host and port) —
ZCap `invocationTarget` URLs embed the full host:port, so even `localhost` vs
`127.0.0.1` or a port mismatch will make delegated-access tests 404.

For a local run, `pnpm conformance:local` does the whole dance for you: it spins
up the server on a fixed local URL, waits until it answers, runs the CLI against
that same URL, and tears the server down afterward (even if the suite fails) —
so the two URLs can't drift out of sync. The server stores under a fresh temp
dir that is removed after the run, so nothing lands in the project `data/`
directory (set `WAS_DATA_DIR` to keep a run's data instead).

```bash
# One-shot local run (recommended). Override the port with PORT=... if 3002 is
# taken; the server and CLI URLs are both derived from it, so they stay in
# sync. Extra arguments are forwarded to the CLI (no `--` separator needed;
# pnpm forwards them itself).
pnpm conformance:local
pnpm conformance:local --grep chunk --reporter json

# Against an already-running or external server. Start it with a matching
# SERVER_URL, then in another shell:
pnpm conformance https://pws.example.com

# With an onboarding token, for servers that require one for POST /spaces/:
pnpm conformance https://pws.example.com --token abc123

# TEST_SERVER_URL / TEST_ONBOARDING_TOKEN env vars still work as fallbacks:
TEST_SERVER_URL=https://pws.example.com pnpm conformance
```

Useful CLI options: `-s/--suite <id>`, `-g/--grep <pattern>`,
`--include-optional` / `--skip-optional`, `-r json`, `--timeout <ms>`,
`--fail-fast`. Exit codes: `0` conformant, `1` failures, `2` usage error or
server unreachable.

### Performance Tests

`pnpm perf:fs` measures the filesystem backend of the checked-out code. It
starts the server as its own process on a fresh temp data dir (with
`DATABASE_URL` and `WAS_ONBOARDING_TOKEN` cleared), fills Collections of 1, 500
and 2,000 Resources (pass `--sizes` for others) and the payload matrix below,
runs the tests, prints the Markdown tables, and stops the server. To compare two
versions, run it on each.

```bash
# Quick run, about 15 minutes filling fresh (8 from a seed, below):
pnpm perf:fs
# Full run, about 22 minutes (15 from a seed):
pnpm perf:fs --duration 20 --writes 300
# Other sizes, client counts, test lengths (seconds) and in-a-row write counts:
pnpm perf:fs --sizes 1,10000 --clients 10 --duration 30 --writes 500
# Other server settings come from the environment as usual:
STORAGE_LIMIT_PER_SPACE=1000000000 pnpm perf:fs
```

Each load test runs 5 clients for 10 s by default, each sending one request at a
time, and reports requests per second, average latency in ms, and failures:

- **Public read** and **public list** of each size, with
  [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (`brew install k6`
  on macOS). Without k6 these rows are skipped with a warning, and the rest
  still runs.
- **Signed read** of each size, and **signed write** and **signed delete** in
  the smallest and the largest size. A delete test runs in rounds: each client
  re-creates the same few Resources, untimed, then deletes them, timed, so the
  Collection stays near its size.
- **Write, 1 client**: one client writing new Resources in a row into the
  smallest and the largest size.

Every test that writes or deletes gets fresh data of its own size, so filling
Collections is a large part of a run, and it grows with the sizes. A run prints
an estimate of its length when it starts. It uses port 4455 (override with
`PORT=...`), and before starting its server it stops whatever else listens
there, naming each process it stops. That includes another `pnpm perf:fs` or
`pnpm perf:pg` run's server, so only one run measures at a time; the stopped run
fails rather than reporting numbers. A run also fails as soon as its own server
exits. It keeps the table and the server log in a temp dir, whose path it prints
at the end. The numbers depend on the machine, so compare runs made on the same
one.

Filling is the slow part at larger sizes: `pnpm perf:fs:seed` pre-fills a data
dir (`.perf-fs-seed`) once, directly through `FileSystemBackend`'s own write
methods (no HTTP, no signing; only the payload matrix goes over HTTP, as below).
Like `pnpm perf:pg`, `pnpm perf:fs` then uses that seed whenever it exists,
copying it into each run instead of refilling over signed HTTP; the sizes come
from the seed, and the original is left untouched, so it can be reused. With no
seed it fills fresh, and passing `--sizes` fills fresh with those sizes even
when a seed exists. `--seed-dir <path>` names a seed elsewhere (one written with
`pnpm perf:fs:seed --out <path>`). Each run prints which it did. Reseed with
`pnpm perf:fs:seed` again after a Collection-size change, or whenever you want a
clean baseline.

```bash
# Seed once, with Collections of 1, 500 and 2,000 Resources (pass `--sizes`
# for others):
pnpm perf:fs:seed
# Then run against it, as many times as you like:
pnpm perf:fs --duration 20 --writes 300
```

`pnpm perf:pg` runs the same tests against the Postgres backend instead, against
a local Postgres container the repo's `docker-compose.yml` defines
(`postgres:16-alpine`, matching `pnpm test:pg`'s connection convention):

```bash
# Start Postgres once:
docker compose up -d --wait
# Seed a fixed schema (`perf`) with Collections of 1, 500 and 2,000 Resources
# (pass `--sizes` for others), the payload matrix below, and 100 MiB of binary
# ballast (pass `--binary-total-mib` for more or less) -- this always resets the
# schema, so reseed after a size change or whenever you want a clean baseline:
pnpm perf:pg:seed
# Then run against it, as many times as you like; the seeded data is left in
# place afterward:
pnpm perf:pg --duration 20 --writes 300
```

Unlike `pnpm perf:fs`, there is no over-HTTP seeding fallback: `pnpm perf:pg`
always reads the sizes, the signing identity and the encrypted read targets' ids
that `pnpm perf:pg:seed` recorded in `.perf-pg-seed/seed-meta.json`. The seed
writes the Collection-size data straight through `PostgresBackend`, since
seeding thousands of Resources one signed HTTP request at a time is much slower.
Override the connection string with `--database-url` (or `DATABASE_URL`) if
Postgres is not at the default `postgres://was:was@localhost:5433/was`.

After the Collection-size tests, `pnpm perf:fs` and `pnpm perf:pg` both run a
payload matrix and report it as a second table. It reads and writes three
payloads (a JSON credential, a 100 KiB file and a 10 MiB file) in three kinds of
Collection: a public one (`PublicCanRead`, read unsigned through k6), a private
plaintext one, and a private encrypted one (`edv`). Each cell counts whole
files. In the encrypted Collection a 100 KiB file is one EDV document, while a
10 MiB file is one document plus ten 1 MiB chunks, so one write is 12 requests
(the document, each chunk, the document again) and one read is 11.

The encrypted Collection is set up the way freewallet sets up its own: the seed
uses `@interop/pws-client` with a throwaway X25519 key, installs the key epoch
with a blinded-index key, and writes real EDV envelopes and chunks. That part of
the seed runs over signed HTTP (through an in-process server on the same backend
for `pnpm perf:pg:seed` and `pnpm perf:fs:seed`, and against the server under
test for a fresh `pnpm perf:fs` run), because pws-client is what makes the
envelopes. Timed encrypted writes send copies of the stored envelopes and chunks
at fresh ids, and no read decrypts, so the numbers measure the server rather
than client-side crypto. Binary writes in every Collection create a file, timed,
then delete it, untimed, so repeated runs don't fill the database. JSON writes
create a new Resource each time.

`pnpm perf:remote` runs the same tests against a server that is already
deployed, such as a staging host, instead of a local one. It starts no server
and nothing can be seeded behind the server's back, so it fills fresh over
signed HTTP under a throwaway `did:key`, and deletes the Spaces it created when
the run ends, even when a test fails or you stop it with Ctrl-C. A second Ctrl-C
exits at once and skips that cleanup; the identity's key is never saved, so
Spaces left that way can only be removed on the server itself. The server must
allow Space creation (no `WAS_ONBOARDING_TOKEN`).

A server running both backends serves each Collection from the one it selects,
so one run measures both side by side, over the same network path at the same
time. `--split` (default `postgres=50,fs=50`) shares each test's Collections
among the backends by percent. Each test spreads its load round-robin over a
pool of Collections, the smallest that realizes the split (2 for `50/50`, 10 for
`30/70`; at most 20, so percents go in steps of 5), each created with its
backend's fixed id rather than `default`, so the host's `WAS_DEFAULT_BACKEND`
does not decide where it lands. The report keeps the combined tables and adds
one per backend under each. A backend's rates count the requests its Collections
answered over the whole test, so they add up to the combined rate. Every pool
member is filled to each size, so a `50/50` run seeds twice what a pool of one
does; the run prints the pool and the Resources it fills before it starts.
Before seeding anything, it reads the host's backends listing
(`GET /space/:spaceId/backends`) and stops if the split names a backend the host
does not list. `--split fs=100` measures one backend alone.

```bash
# Measure both backends side by side, half the Collections on each.
# `--payloads json,small` leaves out the 10 MiB file, which an uplink slower
# than about 1 MB/s can't send within pws-client's 10 s request timeout:
pnpm perf:remote --url https://staging.freewallet.me --payloads json,small
# Weight the run toward one backend, here 30% of the Collections on Postgres:
pnpm perf:remote --url https://staging.freewallet.me --split postgres=30,fs=70
# Measure one backend alone:
pnpm perf:remote --url https://staging.freewallet.me --split fs=100 --label "Filesystem"
# From a fast uplink, leave `--payloads` out to run all three payloads, the
# same matrix as `pnpm perf:fs` and `pnpm perf:pg`:
pnpm perf:remote --url https://staging.freewallet.me
# From far away, use more clients so the round trip doesn't cap every rate
# (5 clients / 185 ms is about 27 req/s):
pnpm perf:remote --url https://staging.freewallet.me --clients 25 --payloads json,small
# From a machine with little memory (512 MB), cap the clients of the 10 MiB
# tests: five clients each sending a 10 MiB file run Node out of memory there:
pnpm perf:remote --url https://staging.freewallet.me --large-file-clients 2
```

On a host whose metadata lives in Postgres (`WAS_CONTROL_PLANE_BACKEND`, which
is Postgres whenever both backends are configured), a request to a filesystem
Collection still reads its Space and Collection metadata from Postgres, so the
filesystem numbers include that work. A client cannot change it; it is what a
wallet on that host gets.

Every number includes the round trip from the machine running it, so compare
runs made from the same machine against hosts in the same region.
`--large-file-clients` (`pnpm perf:fs`, `pnpm perf:pg` and `pnpm perf:remote`
take it; it defaults to `--clients`) runs only the payload matrix's 10 MiB tests
with fewer clients, and the report header names the cap, so compare a capped run
only with one capped the same way. Without `--payloads json,small`, a run from a
slow uplink stops while filling, with
`Request to ".../space/perf-matrix-read/public-postgres-0/large" timed out.`,
and deletes the Spaces it created so far.

`--record <dir>` with `--runner <name>` also writes the run as a JSON run
record, at `<dir>/<runner>/<host>/<stamp>.json`, once the run completes: its
start and finish, the target, the version and build time the target's `/health`
reports, the runner and its machine, the settings, and every measurement. A run
that fails or is interrupted records nothing, and an existing record is never
replaced. The runner names the machine, so the records under one runner and host
form one series. They are kept in the `perf-results/` folder of the
[ops repo](https://github.com/interop-alliance/ops), whose README describes the
format and lists the runners:

```bash
# Record the run in an ops checkout next to this repo:
pnpm perf:remote --url https://staging.freewallet.me \
  --record ../ops/perf-results --runner laptop-omar
```

The ballast, seeded by `pnpm perf:pg:seed` only, is extra 10 MiB files in a
`perf-ballast` Space that no test reads. It grows the database past what
Postgres keeps in its own cache, so the binary reads aren't served purely from
memory. `pnpm perf:fs` seeds none: the filesystem backend's cache is the OS page
cache, which can hold all free RAM, so ballast small enough to copy into every
run could not push the matrix files out of it. Filesystem reads are page-cache
reads either way.

## Security

This is an experimental research server.

## License

[GNU AFFERO GENERAL PUBLIC LICENSE v3](LICENSE)
