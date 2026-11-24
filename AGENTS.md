# Agent Guidelines

## Specification

This project is a reference implementation of the Portable Web Spaces (PWS,
formerly Wallet Attached Storage / WAS) protocol and data model. The
specification is a W3C CCG work item; its home is
<https://github.com/w3c-ccg/portable-web-spaces-spec> (source:
[spec.md](https://github.com/w3c-ccg/portable-web-spaces-spec/blob/main/spec.md);
rendered: <https://w3c-ccg.github.io/portable-web-spaces-spec/>).

Spec-vs-implementation gap analyses: [server roadmap](./ROADMAP.md) (features
the spec defines that this server doesn't implement yet) and the
[client roadmap](https://github.com/interop-alliance/pws-client/blob/main/ROADMAP.md)
(the same analysis for the companion `pws-client` library, in its repo).

## Tech Stack

- TypeScript (strict, `target: ES2022`), compiled with `module`/
  `moduleResolution: NodeNext` -- so import specifiers keep their `.js`
  extension even though the source files are `.ts` (e.g. `import './server.js'`)
- Node.js 24.x, with `pnpm` as package manager
- Fastify 5.x API framework
- Dev runs via `tsx` (`pnpm dev`, no build step); production builds with `tsc`
  to `dist/` (`pnpm build`, which also copies `src/views` to `dist/views`) and
  runs `node dist/start.js`
- Tooling: ESLint (flat config) + Prettier, Vitest for `test/`

## Architecture

The request-flow layer map, domain glossary (Space / Collection / Resource /
Controller), and ZCap authorization structure live in @ARCHITECTURE.md -- read
it before making changes. Each module entry there ends with a pointer to the
topic doc under `docs/` that holds the full behavior description (validators and
stamps, the changes feed, governed logs, replication, export/import, server
identity, the client-annex clause, the storage layout, did:webvh controllers,
the service description). Read the topic doc before changing the behavior it
describes; the summary in ARCHITECTURE.md is not the whole rule.

**When adding an endpoint:** add the route in `routes.ts` and a handler method
on the matching `*Request` class. Always go through `request.server.storage` --
never import or instantiate a backend directly from a handler.

An unsafe method at a container URL (a Space or a Collection) passes the
`containerRule` option through `fetchSpaceAndVerify` / `handleZcapVerify`; see
`src/lib/containerRule.ts` for which rule each operation carries.

The replication facet (`src/sync/`) writes replicated records through the
backend's `apply*` methods only. Never give a request route a way to supply a
write stamp, and never store a peer's record through `writeResource` or the
other request-layer writes, which mint a local stamp.

Two facets sit outside that structure, each in its own self-contained module
with no auth hooks and no storage access: the CORS proxy (`src/corsProxy.ts`,
`/api/cors`) and the ephemeral exchanges rendezvous (`src/exchanges.ts`,
`/workflows/ephemeral/exchanges`). Both are unauthenticated by design; keep
anything touching Spaces out of them.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them.

Repo-specific addition: throw the custom error classes defined in
`src/errors.ts` rather than generic `Error`.

## Roadmap

All roadmap tracking lives in [ROADMAP.md](./ROADMAP.md); never create a
parallel task list elsewhere. Before filing, editing, or closing an item, read
the "Item format" section at the top of ROADMAP.md: it holds the item schema,
the id counter rule, the status and archive rules, and the `pnpm roadmap`
ordering step that follows every edit. Reference item ids only in the roadmap
documents, not in commit messages, PR descriptions, or CHANGELOG.md entries.

## Ecosystem conventions

- Cross-repo lessons (invariants, gotchas, and process recipes that span repos)
  live in the ecosystem learnings file,
  [byoe-ecosystem/LEARNINGS.md](https://github.com/interop-alliance/byoe-ecosystem/blob/main/LEARNINGS.md)
  (usually checked out beside this repo as `../byoe-ecosystem`); read it at the
  start of any cross-repo task.
- Cross-repo decisions are recorded as `decisions/NNNN-slug.md` in the repo that
  owns the contract; the convention and template are canonical in
  [isomorphic-lib-template's `decisions/`](https://github.com/interop-alliance/isomorphic-lib-template/tree/main/decisions).
- The domain vocabulary is @ARCHITECTURE.md's Glossary; the refinement rules and
  the mapping for skills that expect `CONTEXT.md` or `docs/adr/` are canonical
  in
  [isomorphic-lib-template's AGENTS.md](https://github.com/interop-alliance/isomorphic-lib-template/blob/main/AGENTS.md)
  ("Domain language") and
  [`decisions/README.md`](https://github.com/interop-alliance/isomorphic-lib-template/blob/main/decisions/README.md)
  ("Qualifying test").

## Test Suite

- `test/` holds integration tests that spin up a local Fastify server
  in-process; use these to test the implementation. Run with Vitest
  (`pnpm test-node`); config in `vite.config.ts`.
- Protocol conformance tests live in `@interop/pws-conformance-suite`, installed
  as a devDependency. `pnpm conformance:local` runs it against a freshly spawned
  local server; README.md's "Conformance Tests" section has the other
  invocations and the CLI options.

**Critical ZCap constraint**: ZCap capability `invocationTarget` URLs include
the full host and port. The server's `SERVER_URL` and the URL a client targets
must be exactly identical strings (`localhost` vs `127.0.0.1`, or a different
port, makes delegated-access requests 404). This is how URL-based capabilities
work, not a bug. A `did:webvh` DID URL target is the exception, since the server
dereferences it to the https URL.

The test helpers (`startTestServer`, `openTempBackend`, `faults`) are documented
in [docs/consuming-server-as-library.md](docs/consuming-server-as-library.md)
under "Testing against the server". Rules a suite in `test/` follows:

- Each suite opens its own temp-dir backend with `openTempBackend()`, injects it
  into `startTestServer({ backend })`, and closes it in `afterAll`. Suites never
  touch the gitignored `data/` directory and never hardcode a port.
- Build ZCap clients, and any URL derived from `baseServerUrl`, after the
  `startTestServer` call resolves, since the port is unknown before `listen()`.
- A suite that reboots a server over the same `dataDir` passes the first
  server's `port` back in, so ids minted by the first server still resolve.
- Use `faults` (`refuse`, `dropResponse`, `hold`) for a torn or interleaved
  request instead of mocking `node:fs/promises`, unless the fault under test is
  the syscall itself. pws-client retries a 5xx and a dropped connection, so pass
  `times` or refuse with a 4xx.

## Logging

- Never use `console.*` in `src/` (the only exception is the bootstrap
  `console.error` in `start.ts`, before the Fastify logger exists). Log through
  Fastify's pino logger instead.
- In request-layer code (handlers, hooks, the error handler) use `request.log`.
- Backends and other non-request code take an injected logger typed as Fastify's
  `FastifyBaseLogger` (reuse that type -- do not hand-roll a logger interface).
  `FileSystemBackend` exposes a `logger` property defaulting to a silent
  `pino({ level: 'silent' })`; `createApp()` wires `fastify.log` into the active
  backend, so anything reached via `request.server.storage` logs to the same
  place. New backends should follow the same pattern (`StorageBackend.logger`).
- Use pino's object-first call style, especially for errors:
  `logger.error({ err }, 'message')`, not `logger.error('message', err)`.
- Do not log inside error-class constructors. Let server-side faults surface to
  `handleError`, which logs 5xx (with the underlying `cause`) once via
  `request.log`; 4xx client errors are expected and not logged.
