# Deploying on Fly.io

This repo ships a production `Dockerfile`, an example Fly.io configuration, and
a deploy workflow for it. The image is generic. Every setting comes from the
environment at run time.

## Choosing an origin layout

Decide this before the first deploy. The layout sets `SERVER_URL`, and
`SERVER_URL` is permanent. Space URLs, ZCap invocation targets, and the
did:webvh DIDs this server hosts all derive from it. Changing it later strands
every existing account.

The layout is two separate choices. The first is where a wallet's signed API
calls go, which decides how many CORS preflights the wallet waits on. The second
is where pages hosted in the server's Collections run when a browser opens them,
which decides whose browser storage those pages can reach. The examples below
use a wallet at `wallet.example` and a second registrable domain,
`wallet-content.example`.

### Where the wallet's API calls go

Cross origin means the server has an origin of its own and wallets call it
through CORS. The server allows any origin (`Access-Control-Allow-Origin: *`),
so several wallets and apps can share it on equal terms. Its welcome page at `/`
stays reachable, and it deploys on its own schedule.

The cost is preflights. A signed PWS request carries `Authorization`,
`Capability-Invocation` and `Digest` headers, and a browser sends a CORS
preflight before any request with those headers. The server marks its preflight
answers cacheable for a day. Browsers cache them per URL, though, and cap the
lifetime (Chrome at two hours). A wallet signup touches many distinct URLs, so
most of its requests still wait one extra round trip. The farther the browser is
from the server, the more that costs.

Same origin means the wallet app proxies the server's routes from its own
origin, and `SERVER_URL` is the wallet's origin. The wallet's requests then need
no preflight, and the server can run with no public address. Freewallet's image
works this way, with the route list in its `deploy/nginx.conf.template`. The
server's routes all sit at the root (`/spaces`, `/space/*`, `/kms/*`, and so
on), so the wallet's client-side routes must stay clear of them. The usual
overlap is `/`. The wallet takes it, and the server's welcome page is not
reachable. Only one wallet gets the benefit. Other wallets and apps still reach
the server cross origin, at the wallet's domain.

### Where hosted pages run

The server serves a Resource with the content type it was written with, so an
HTML Resource opened in a browser is a working page, scripts included. Browsers
isolate `localStorage`, IndexedDB, the Cache API and service workers by origin,
which is the scheme, host and port. The path plays no part. Every page served
from one origin shares one set of storage, with every other page there and with
anything else running on that origin. A script on one page can open another in
an iframe and read its storage. Cookies are coarser still. Their `Path`
attribute is no security boundary, and a page can set a cookie for its parent
domain, which every other subdomain then receives.

That leaves three places a hosted page can run:

- The wallet's origin. The page's scripts can read the wallet's storage, key
  material included, and anyone who can write a Resource can plant such a page.
- One shared content origin, such as `wallet-content.example`. Pages can't reach
  the wallet's storage. Every hosted page can read every other hosted page's
  storage, across Spaces and users.
- One origin per Space, as a subdomain of the content domain, such as
  `<label>.wallet-content.example`. Each Space's pages get storage of their own.

A browser navigation can't carry the HTTP Signature headers, so a page a browser
opens is always a public read. A public read does not check an invocation
target. That is what lets the server answer it under a hostname other than
`SERVER_URL`.

No browser mechanism splits one origin by path. A shared origin can only imitate
per-Space storage with a trusted wrapper page. The wrapper runs each hosted page
in an `<iframe sandbox="allow-scripts">`, which has no storage at all, and
stores data on the page's behalf over `postMessage`. Hosted pages then have to
be written for that wrapper, and IndexedDB, service workers and cookies are out
of reach.

### The options

1. Separate domains, one shared content origin. The wallet at `wallet.example`
   calls the server at `wallet-content.example`, and hosted pages run there too.
   Hosted pages can't reach the wallet's storage but can reach each other's.
   Signup waits on a preflight per distinct URL.
2. Separate domains, per-Space subdomains. As option 1, with each Space's pages
   on its own subdomain of `wallet-content.example`. Hosted pages are isolated
   from each other as well. Signup still waits on the preflights.
3. Same origin, sandboxed pages. The wallet proxies the server, and hosted pages
   are served from the wallet's origin with a sandbox header (see "The
   recommended layout" below). The header makes each page run in an opaque
   origin, so it can't reach the wallet's storage. Signup needs no preflights.
   Hosted pages keep their scripts but get no browser storage at all. Without
   the header, this option exposes the wallet's storage to every hosted page.
4. Same origin, per-Space subdomains. The wallet proxies the server at
   `wallet.example`, so its API calls need no preflight. A navigation to a
   Resource there (a request with `Sec-Fetch-Mode: navigate`) is redirected to
   the Space's subdomain of `wallet-content.example`, with the path kept. The
   page runs there with storage of its own. The wallet origin keeps the sandbox
   header from option 3 on Resource responses, so a navigation that misses the
   redirect still can't reach the wallet's storage. This is the only option that
   fixes both the preflights and the isolation while leaving hosted pages their
   storage.

The per-Space subdomains in options 2 and 4 must sit under a registrable domain
other than the wallet's. A subdomain of `wallet.example` is same-site with the
wallet, so its pages could set cookies the wallet receives.

This server does not serve per-Space subdomains or redirect navigations, so
options 2 and 4 are not available.

### The recommended layout

Option 3 suits a deployment whose hosted pages are static sites: documents,
galleries, demos, pages that read public data. It needs one domain and no DNS
beyond the wallet's own. Every response on the server's PWS routes, except a
PDF, carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-top-navigation-by-user-activation
```

The header has no effect on the wallet's own `fetch()` calls. It leaves out
`allow-same-origin`, since combined with `allow-scripts` that token lets a page
lift its own sandbox. It also leaves content sniffing on, so a Resource stored
with no type or a generic one still renders. A sniffed page arrives with the
same header and runs sandboxed too. A Resource stored as `application/pdf` goes
out without the header. Chromium will not render a PDF in a sandboxed document,
and a browser's PDF viewer cannot reach the origin's storage anyway.

A sandboxed page keeps scripts, the DOM, WebCrypto, `fetch()` to any CORS API
(PWS included, with `Origin: null`), forms, dialogs, downloads and popups. A
popup it opens inherits the sandbox, so a wallet page opened that way also runs
with an opaque origin and cannot read the wallet's keys. The page loses
`localStorage`, `sessionStorage`, IndexedDB, the Cache API, cookies, service
workers, WebAuthn, and permission prompts such as camera and geolocation.
Reading `localStorage` throws, and some libraries touch it at startup, so a page
built for full browser storage may fail to load rather than just forget its
state.

The layout can grow into option 4 later. A content domain added behind a
navigation redirect gives hosted pages storage of their own, and path-form links
shared in the meantime keep working.

The server sends this header itself, so a proxy in front of it has nothing to
add. It must pass the header through unchanged.

### What per-Space subdomains cost

- DNS and certificates cost little. One wildcard DNS record and one wildcard
  certificate cover every Space, so nothing is provisioned when a Space is
  created. A wildcard certificate names no labels in Certificate Transparency
  logs. The first visit to a Space's pages costs one DNS lookup, and browsers
  can often reuse an open HTTP/2 connection for the new hostname. Signup and
  login never touch these hostnames.
- The hostname reveals the Space. A URL path travels inside TLS, but a hostname
  does not. The label appears in DNS queries and in the TLS SNI, so resolvers
  and network observers can tell which Space's pages someone opens. A hashed
  label hides the Space id but is still linkable across visits.
- The label needs an encoding. Space ids can't be DNS labels as they are. They
  allow uppercase letters and `._~`, hostnames are case-insensitive, and a label
  is at most 63 characters. Whatever encoding is chosen becomes a permanent URL
  convention.
- The label must match the Space. A request to one Space's subdomain for another
  Space's path has to be refused. Otherwise that page runs with the first
  Space's origin and reads its storage.
- The content domain belongs on the Public Suffix List. Without an entry, a page
  on one subdomain can set a cookie for the whole content domain, and every
  other Space's pages receive it. Browsers also treat all the subdomains as one
  site. That site is the unit for SameSite rules, storage partitioning, Chrome's
  site isolation into separate processes, and Firefox's storage quota groups. An
  entry makes each subdomain its own site. Storage isolation between Spaces does
  not wait on it, since that already follows from the separate origins.

### The Public Suffix List

The list (<https://github.com/publicsuffix/list>) names the suffixes under which
independent parties hold names, such as `com` and `co.uk` in its ICANN section
and `github.io` in its private section. Browsers embed a copy to decide where
one site ends and the next begins. To add the content domain:

1. Open a pull request adding `wallet-content.example` to the private section,
   with a comment naming the operator and a contact address. Explain the reason
   in the pull request. Untrusted content from many users on per-user subdomains
   is what the private section is for. The maintainers refuse entries whose only
   aim is to get past certificate rate limits.
2. Publish a DNS TXT record at `_psl.wallet-content.example` whose value is the
   pull request's URL, and keep it in place for as long as the entry exists.
3. Keep the domain's registration renewed well ahead. The guidelines ask for
   more than two years remaining at submission.

Volunteers review the requests, which can take weeks. Browsers then pick up the
change in their next releases, since each embeds a snapshot at build time.
Removal is possible, but copies in shipped software linger for years, so treat
an entry as permanent. Once listed, the bare content domain is a public suffix
itself. It can no longer set cookies for its subdomains, and it should serve
nothing but perhaps a redirect.

Get the wildcard certificate working before the entry lands, and confirm the
certificate authority keeps renewing it afterwards. The CA/Browser Forum rules
restrict wildcard certificates directly under a public suffix, and a certificate
that renews every 90 days has to survive that check each time.

### Rules for every layout

- `/api/cors` relays a third-party URL's response with that URL's content type.
  The server sends every reply there with
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, so a
  link to it cannot run anyone's HTML on the origin serving it. A proxy in front
  of the server must not strip or replace these headers on `/api/cors`.
- A wallet must not render fetched content as a `blob:` URL document or in an
  unsandboxed `srcdoc` or `about:blank` iframe. Each of those runs with the
  wallet's origin. A `data:` URL document gets an opaque origin instead.
- A wallet's own CSP should allow scripts by nonce or hash. `script-src 'self'`
  would admit any JavaScript Resource the same origin serves.

## Files

| File                                   | Purpose                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `Dockerfile`                           | Two-stage build: compiles `dist/`, then installs production dependencies only.   |
| `.dockerignore`                        | Keeps `data/`, `node_modules/`, `.git` and local files out of the build context. |
| `fly.toml`                             | Example Fly.io app with placeholder values. See "Example: Fly.io" below.         |
| `.github/workflows/deploy.yml`         | Deploys to Fly.io when a GitHub release is published, or by hand.                |
| `.github/workflows/deploy-staging.yml` | Deploys to the staging app after CI passes on `main`, or by hand.                |

## What a reverse proxy in front of the server must do

1. Pass the `Host` header through unchanged. HTTP Signatures cover `host`, and
   the server verifies the signature over the headers it receives. A proxy that
   rewrites `Host` to its upstream's name breaks every signed request.
2. Leave paths alone. The signature also covers `(request-target)`, and the
   server does not run under a sub-path (`SERVER_URL` refuses one). So no prefix
   stripping and no rewrites.
3. Set `SERVER_URL` to the origin the browser sees, not the server's internal
   name. ZCap invocation targets are built from it and matched against it.
4. Do not compress responses. When nginx gzips a response, it turns a strong
   `ETag` into a weak one, and conditional writes (`If-Match`) need the strong
   one.
5. Let the server enforce the upload size. It applies `MAX_UPLOAD_BYTES` itself,
   so the proxy should accept bodies at least that large.

## Configuration

The README's Environment Variables table lists every setting. `SERVER_URL` is
the one that is required. Keep secrets such as `WAS_ONBOARDING_TOKEN`,
`KMS_RECORD_KEK`, `WAS_SERVER_KEY_SEED` and `DATABASE_URL` in the platform's
secret store rather than in the repo. Leaving `STORAGE_LIMIT_PER_SPACE` unset
makes startup log a warning until you set a quota or `unlimited`.

Changing `SERVER_URL` gives the server a new identity. Space URLs, ZCap
invocation targets, and the did:webvh DIDs this server hosts all derive from it.
Moving the server to another host does not carry existing accounts over.

The image runs `node dist/start.js` as root and logs JSON to stdout. Root is
there because platform volumes often mount owned by root. Where the data
directory can belong to an unprivileged user, add a `USER` line.

## Storage

### Filesystem backend

Data lives under `WAS_DATA_DIR`, which must be a persistent volume. A platform
that wipes a container's disk on restart loses the data, so use Postgres there.
The filesystem backend serializes writes inside one process, so run exactly one
server process. A deploy then stops it and starts the new one, which means a
short outage.

The data directory's `store.json` records its storage layout version. The server
applies any pending layout migrations when it starts, before it listens. Do not
move this into a Fly `release_command`: Fly runs that command in a temporary
machine that does not mount the app's volume. A volume written by a release
older than the stamp is taken as the baseline layout and migrated forward on the
next start. A server refuses to start on a data directory stamped with a newer
version than it knows.

### Postgres backend

Setting `DATABASE_URL` selects the Postgres backend. The server applies its
schema migrations at startup. Put the database in the same region as the server.
A signup makes many sequential requests, each with several queries, so a distant
database adds up the same way the preflights did.

Postgres makes the server stateless on disk. Conditional writes and quota
accounting use row locks, advisory locks, and transactions, and the server's
caches have short TTLs so several processes can share one database. That allows
a deploy that starts the new process and waits for its health check before
stopping the old one.

One piece of state is still held in process memory. The ephemeral exchanges
under `/workflows/ephemeral/exchanges` live in an in-process cache
(`src/exchanges.ts`). With two processes behind a load balancer, a request can
reach one that never saw the exchange. Keep one process until the exchanges move
to storage.

`MAX_UPLOAD_BYTES=unlimited` is refused by the Postgres backend at startup.

## Checking a deployment

`/health` reports the version and build time from `dist/build-info.json`. The
image is built without `.git`, so the commit reads `null`.

## Running the image locally

```sh
docker build -t was-teaching-server .
docker run --rm -p 3002:3002 \
  -e SERVER_URL=http://localhost:3002 \
  -e WAS_DATA_DIR=/data -v was-data:/data \
  was-teaching-server
```

## Example: Fly.io

`fly.toml` and the deploy workflow run the server as a private Fly app behind a
wallet app on the same origin. That is option 3 under "Choosing an origin
layout" above. The server sends the sandbox header itself, and the wallet's
proxy passes it through. The wallet app proxies the server's routes over
Flycast, a private address inside the Fly organization's network, so the server
app has no public IP. Each repo deploys its own app.

The values in `fly.toml` are placeholders: the app name `was-teaching-server`
and `SERVER_URL=https://wallet.example.com`. The workflow replaces them at
deploy time.

### First-time setup

Deploy the server app before the wallet app. nginx resolves the server's Flycast
name once at startup and fails to start if it does not resolve. With your own
app name and the wallet's domain:

```sh
fly apps create <app>
fly volumes create was_data --app <app> --region iad --size 1
fly secrets set --app <app> WAS_ONBOARDING_TOKEN=...   # optional
fly secrets set --app <app> WAS_SERVER_KEY_SEED=z...     # optional, see the admin guide
fly deploy --app <app> --env SERVER_URL=https://<domain> --no-public-ips --ha=false
fly ips allocate-v6 --private --app <app>
```

`--ha=false` keeps the app to one Machine.

Create the volume in the region `primary_region` names in `fly.toml`. A volume
cannot move regions later. `fly ips list --app <app>` should show only the
private (Flycast) address. Release any public address with `fly ips release`.
The wallet app then reaches the server at `<app>.flycast:80`.

A Fly volume belongs to one machine, which matches the filesystem backend's
one-process rule. Do not scale the app past one Machine. Each added Machine gets
a volume of its own, volumes do not sync, and requests would land on diverging
copies of the data.

A volume lives on one physical host and is not replicated. If that host fails,
the volume can be lost. Fly snapshots volumes daily and keeps the snapshots for
five days by default. List them with `fly volumes snapshots list <volume-id>`. A
snapshot restores into a new volume. Those snapshots are the only copy of the
data, so take backups of your own (Export Space, or a copy of `/data`) or use
Postgres for anything that must not be lost.

To switch to Postgres, create a cluster in the same region (Fly Managed Postgres
works) and run `fly secrets set --app <app> DATABASE_URL=postgres://...`. Then
remove the `[mounts]` section and `WAS_DATA_DIR` from `fly.toml` and deploy.
`[deploy] strategy = "bluegreen"` then gives deploys with no outage.

### Deploying from CI

Two workflows deploy the same image to two Fly apps:

- `.github/workflows/deploy-staging.yml` deploys to a staging app each time the
  CI workflow passes on a push to `main`. It deploys the commit CI tested.
- `.github/workflows/deploy.yml` deploys to the production app when a GitHub
  release is published.

A change reaches production in three steps. Merge it to `main`, check it on
staging, then publish a release whose tag points at the commit staging runs.
Both workflows can also run by hand from the Actions tab (`workflow_dispatch`).

Each workflow reads its values from a GitHub environment of its own, so the two
apps never share a token. To set up production:

1. Create a deploy token scoped to the one app:
   `fly tokens create deploy --app <app>`.
2. In the GitHub repo settings, create an environment named `production`. Store
   the token there as the `FLY_API_TOKEN` secret.
3. On the same environment, add two variables: `FLY_APP` (the app name) and
   `SERVER_URL` (the public origin, such as `https://wallet.example.com`). The
   workflow fails before deploying if either is missing.
4. Limit the environment's deployment branches and tags to `main` and `v*`. A
   release event runs on its tag, so a `main`-only rule would block it.

Staging is a second app with a volume of its own, set up as under "First-time
setup" above. Its `SERVER_URL` is the staging wallet's domain, and the staging
wallet app proxies to the staging server's Flycast name. Then:

1. Create a deploy token scoped to the staging app.
2. Create an environment named `staging`, with the token as its `FLY_API_TOKEN`
   secret and the staging app's `FLY_APP` and `SERVER_URL` as its variables.
3. Limit the environment's deployment branches to `main`.
4. If the staging app uses Postgres, add its connection string as the
   environment's `DATABASE_URL` secret too, the same value as the app's Fly
   secret. The workflow connects from a GitHub runner, outside Fly, so the
   database needs an endpoint the internet reaches, as a Neon database has. A
   cluster reachable only on Fly's private network, such as Fly Managed
   Postgres, cannot be wiped this way.

Running the staging workflow by hand offers a `wipe_data` option, on by default.
It clears the staging volume before deploying, through `fly machine exec` on the
running machine, then drops the `public` schema of the staging Postgres database
and creates it empty, so the server starts over an empty data directory and an
empty schema. The volume wipe goes through the same Machines API the deploy
uses, so the deploy token covers it. The Postgres wipe connects from the runner
with the environment's `DATABASE_URL` secret, and is skipped with a warning when
the environment has none. The workflow connects to the database before either
wipe, so a database it cannot reach, or a machine it cannot reach, stops the job
with nothing wiped. The server keeps every table in `public`, so give it a
database of its own. A wipe also removes the `server` Space's `did:webvh` log,
which the admin puts back as under "Server identity" in the admin guide. A
deploy after CI never wipes.

Neither workflow runs on pull requests, so a pull request from a fork cannot
read the tokens or the variables. The staging workflow runs after every CI run,
but deploys only when the run passed and was triggered by a push.

A deploy from a workstation needs the same two values, passed as in the
first-time setup above. A plain `fly deploy` would deploy the placeholders.

### Rolling back

The production workflow snapshots the app's data volume before each deploy
(`fly volumes snapshots create`), so a deploy that fails its health check has a
restore point from just before the roll. Fly replaces the one machine in place,
so a failed deploy leaves it on the new image, down, with no automatic rollback.
The snapshot step needs the deploy token to cover volume snapshots; if it fails,
the deploy does not run.

Which way back depends on what the failed boot wrote. The server stamps
`store.json` after each converting layout step, and a server refuses a
`store.json` newer than it knows. The runner runs every pending refusing step
before any converting step writes, so a boot a refusing step refused wrote
nothing.

- The new release stamped nothing. Dispatch the Deploy workflow on the previous
  tag (`gh workflow run deploy.yml --ref v<previous>`). The previous release
  boots on the volume as it is.
- The new release stamped a newer layout, or the failure is not a layout refusal
  and the previous release still does not boot. Restore the snapshot into a new
  volume (`fly volumes snapshots list <volume-id>`, then
  `fly volumes create <name> --snapshot-id <snapshot-id>`), attach it to the
  machine in place of the current one, and dispatch the workflow on the previous
  tag. If the data is disposable, create an empty volume instead
  (`fly volumes create <name> --region <region> --size <gb>`), attach it in
  place of the current one, and re-run the failed deploy. With a Postgres
  backend, an empty volume leaves the database's rows in place, so drop its
  `public` schema too before the re-run
  (`psql "$DATABASE_URL" --command 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'`).
  The staging workflow's `wipe_data` option is no help here: its volume wipe
  runs `fly machine exec`, which needs a running machine, and the job stops
  there before it reaches the database.

Read the machine's log first (`fly logs --app <app> --no-tail`): a
`StoreVersionError` names the layout version `store.json` carries and the one
the running release knows, which tells the two cases apart.
