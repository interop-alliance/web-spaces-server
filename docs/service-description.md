# The Service Description

This document covers `src/serviceDescription.ts`: the service description (spec
"Service Description") served at `GET /service`. It describes the document and
each of its six `specs` entries, the `instance` member, the `Link` header every
response carries, and caching. [ARCHITECTURE.md](../ARCHITECTURE.md) holds the
layer map and the glossary.

## The document

`GET /service` is unauthenticated. It serves a JSON document that lists six
entries in its `specs`. A client ignores a member it does not know. It treats an
entry whose `version` it does not speak, or whose `url` is not a string, as
absent.

## The core entry

The core entry sits under the `https://w3id.org/pws` identifier. It names the
spec version this server speaks (`0.5`), the Spaces Repository URL, and the
`features` tokens naming the optional sections of the core spec this server
serves, `changes-query` among them. The `created-by` token says the server
records `createdBy` on every Resource, Collection, and Space created under a
capability invocation. The `encryption` token says the server implements the
Collection `encryption` descriptor as the spec's "Encryption Scheme Registry"
section defines it: it recognizes the `edv` scheme, validates every write into a
Collection declaring it against the envelope profile, refuses a scheme or
version it does not recognize, keeps the descriptor creation-only, and checks
its key-epoch and `hmac` members.

It also carries `originId`, the active backend's origin id, which a replication
peer reads when it registers (see [replication.md](replication.md)).

Once the server has an identity, the core entry also carries `serverDid`, the
server's own self-hosted `did:webvh`. A controller delegates the replication
pull capability to that DID, so a client gates on it. Both members sit on the
core entry rather than on `instance` because the spec forbids a client gating on
`instance`. `serverDid` is present only under the rule in
[The instance member](#the-instance-member). The archive's `service.json`
carries both.

A Backend descriptor advertises no tokens of its own. Conditional writes, the
`epoch` stamp, and the `writerId` writer-attribution label are baseline
guarantees of every backend a Collection may be created on. The server, not the
storage engine, serializes each write and mints its own opaque validator. A
content hash would serve as a strong validator as well as the write stamp used
here. See [validators-and-stamps.md](validators-and-stamps.md).

## The authorization profile entry

The entry under `https://w3id.org/pws/authz-profile` names the zCap
authorization profile version (`0.1`) and its rendered location. It carries the
accepted `signatureAlgorithms` and `zcapCryptosuites` (profile
["Service Description Entry"](https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/#service-description-entry)).

Listing the profile is how a client learns this server authorizes with
capability invocations, before its first signed request. The last two members
are read off `zcap.ts` (`INVOCATION_SIGNATURE_ALGORITHMS`,
`delegationProofCryptosuites`), so a change to what verification accepts changes
the advertisement too. `zcapCryptosuites` lists Data Integrity cryptosuite names
only, so it names `eddsa-jcs-2022` alone. The legacy `Ed25519Signature2020`
proof type is still accepted but not advertised.

## The encrypted-collections entry

The third entry, under `https://w3id.org/pws/encrypted-collections`, is the
Encrypted Collections profile (version `0.1`). Listing it at all is this
server's claim that it serves the chunk endpoints. No token names those.

Its `features` array names the profile's two optional affordances this server
serves, `blinded-index-query` and `governed-history-logs`. They are affordances
of that companion specification, not of a storage engine, so they are listed on
this entry and not on a Backend descriptor.

## The client-annex entry

The fourth entry, under `https://w3id.org/pws/client-annex`, is the client annex
profile (version `0.1`). Listing it is this server's claim that it enforces the
client-annex delegation clause, described in
[client-annex-clause.md](client-annex-clause.md). It carries `version` alone,
since it is a conformance claim with nothing further to advertise.

## The replication entry

The fifth entry, under `https://w3id.org/pws/replication`, is the replication
specification (version `0.1`). Listing it is this server's claim that it serves
the `replicas` registration sub-resource, the pull loop and the apply path (see
[replication.md](replication.md)). A registration reads the peer's entry and
refuses a peer that lists none at this version. It carries `version` and `url`,
which is `https://w3c-ccg.github.io/portable-web-spaces-spec/replication/`.

## The wallet profile entry

The sixth entry, under `https://w3id.org/pws/wallet-profile`, is the Portable
Wallet Profile (version `0.1`). Listing it is this server's claim that it meets
the profile's "Server requirements": the core entry at version `0.5` carries
`listing`, `collection-management`, `space-management`, `policy`, `export`,
`encryption` and `changes-query`, and the encrypted-collections entry at version
`0.1` carries `blinded-index-query` and `governed-history-logs`. The entry is a
shorthand for those tokens and adds no route. The profile forbids listing it
while a required token is missing, so the module checks the required tokens
against the served lists when it loads and refuses to start otherwise, and a
test restates them from the profile text.

The entry carries `version` and `url` only. The profile admits no other member,
`features` included, and a client treats an entry carrying one as absent.

## The instance member

The document's `instance` member is the operator's disclosure of the deployed
software. It also carries the export-signing method when the server has an
identity (see
[server-identity-and-provenance.md](server-identity-and-provenance.md)).

- `exportSigningMethod` is the verification method the server will sign export
  archives with, as a `did:key`. It is present whenever `WAS_SERVER_KEY_SEED` is
  set.

`exportSigningMethod` sits on `instance` rather than on a `specs` entry because
it describes this deployment, not a specification it implements.

`serverDid` is not on `instance`. It sits on the core entry (see
[The core entry](#the-core-entry)). It is present only once the resolved current
document of the log at `server/id/did.jsonl` lists that key under
`assertionMethod`, and under `capabilityInvocation` at most. It is read per
request, since the admin writes that log after boot. The served body and its
`ETag` are recomputed when it changes. The outcome is memoized per backend on
the log Resource's `ETag`, so a request costs one metadata read while the log
stands still.

## The service Link header

The module installs the one hook every response passes through. It is a
root-level `onSend` hook (`addServiceLinkHook`, added by the plugin) that
appends `Link: <{serverUrl}/service>; rel="service"` to every response. That
covers successes, errors, 404s for unmatched routes, 308 redirects, 405
refusals, CORS preflights, and the teaching-server extras.

It appends to a `Link` header a handler already set rather than replacing it.
The CORS registration exposes `Link`, so a cross-origin client can read it. The
Space and Collection linksets carry the same URL under the `service` relation.

## Caching and version disclosure

The document is built per `serverUrl` and served with `Cache-Control: public`
and a content-hash `ETag`.

The `discloseVersion` option (`WAS_DISCLOSE_VERSION`) withholds the version from
the document's `instance` member, `/health`, and the welcome page together.
