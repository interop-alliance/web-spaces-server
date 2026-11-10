import assert from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { Readable } from 'node:stream'
import pg from 'pg'
import pino from 'pino'
import { vi } from 'vitest'
import { ZcapClient } from '@interop/ezcap'
import { PwsClient } from '@interop/pws-client'
import { decodeSecretKeySeed } from '@interop/bnid'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { ISigner } from '@interop/data-integrity-core'
import { readLogFromString, resolveDIDFromLog } from '@interop/did-method-webvh'
import { DataIntegrityProof } from '@interop/data-integrity-proof'
import { createVerifyCryptosuite } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import jsigs from '@interop/jsonld-signatures'

import {
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  ENCRYPTED_COLLECTIONS_VERSION
} from '../src/config.default.js'
import { PostgresBackend } from '../src/backends/postgres.js'
import type { PostgresBackendOptions } from '../src/backends/postgres.js'
import type { EtagValidator } from '../src/lib/etag.js'
import { compareStamps, isoOfMs } from '../src/lib/hlc.js'
import { prepareImportPlan } from '../src/lib/importPlan.js'
import { installImportRevocations } from '../src/lib/importRevocations.js'
import type { ImportRevocationScope } from '../src/lib/importRevocations.js'
import type { PeerServer } from '../src/testing.js'
import { rootCapabilityId } from '../src/zcap.js'
import type {
  FeedDocument,
  IDID,
  IRootZcap,
  ImportStats,
  ReplicaRegistration,
  ResourceInput,
  StorageBackend
} from '../src/types.js'

// The in-process boot and the webvh identity provisioner live in the source
// file the `was-teaching-server/testing` export is built from.
export {
  openTempBackend,
  provisionWebvhIdentity,
  startTestServer,
  webvhLogSigner,
  type TempFileSystemBackend,
  type WebvhIdentity
} from '../src/testing.js'

/**
 * Builds a root capability object for a target URL: the
 * `urn:zcap:root:<target>` whose controller is `controller`. Shared by the two
 * revocation suites, whose negative cases shape invocations by hand. The object
 * form is used because the ezcap client requires `https:` targets for *string*
 * root-capability ids; the object form reduces to the bare `zcap id="..."`
 * header either way.
 *
 * @param options {object}
 * @param options.target {string}   the capability's invocationTarget URL
 * @param options.controller {string}   the controller DID
 * @returns {IRootZcap}
 */
export function rootZcap({
  target,
  controller
}: {
  target: string
  controller: string
}): IRootZcap {
  return {
    '@context': 'https://w3id.org/zcap/v1',
    id: rootCapabilityId(target),
    invocationTarget: target,
    controller
  }
}

/**
 * Awaits a request expected to fail and returns the thrown error, failing the
 * test if the promise unexpectedly resolves. Shared by the two revocation
 * suites, whose negative cases need to inspect the thrown error's status.
 *
 * @param promise {Promise<unknown>}   the request expected to reject
 * @returns {Promise<any>}   the thrown error
 */
export async function requestError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (err) {
    return err
  }
  assert.fail('expected the request to be rejected')
}

/**
 * Awaits a request and returns its `Response` whether it succeeded or the
 * client rejected it for a non-2xx status (the http client treats a 304 Not
 * Modified as an error). Shared by the conditional-read cases, which assert on
 * the status and headers of a 304 and a 200 alike.
 *
 * @param promise {Promise<any>}   the request
 * @returns {Promise<Response>}   the response, from the value or the error
 */
export async function responseOf(promise: Promise<any>): Promise<Response> {
  try {
    return await promise
  } catch (err: any) {
    if (err.response) {
      return err.response
    }
    throw err
  }
}

/**
 * GETs an absolute or server-relative URL with an identity's signed capability
 * (the raw `pws.request` escape hatch). Shared by the pagination suites, whose
 * paginated reads carry a `?limit` / `cursor` query string that the high-level
 * list methods do not yet surface.
 *
 * @param options {object}
 * @param options.identity {any}   a test identity carrying a `pws` client
 * @param options.baseServerUrl {string}   base URL to resolve `url` against
 * @param options.url {string}   the absolute or server-relative URL to GET
 * @returns {Promise<any>}
 */
export async function signedGet({
  identity,
  baseServerUrl,
  url
}: {
  identity: any
  baseServerUrl: string
  url: string
}): Promise<any> {
  return identity.pws.request({
    url: new URL(url, baseServerUrl).toString(),
    method: 'GET'
  })
}

/**
 * Sends a signed `multipart/form-data` write carrying one file part, the
 * HTML-form convenience path, through a plain `fetch` (pws-client sends no
 * multipart bodies).
 * @param options {object}
 * @param options.signer {ISigner}   the invoking key
 * @param options.url {string}   the absolute Collection or Resource URL
 * @param options.method {'POST' | 'PUT'}
 * @param options.partType {string}   the file part's `Content-Type`
 * @param options.partBody {string}   the file part's body
 * @param [options.envelopeType] {string}   the request's own media type,
 *   before the boundary parameter (default `multipart/form-data`)
 * @returns {Promise<Response>}
 */
export async function signedMultipart({
  signer,
  url,
  method,
  partType,
  partBody,
  envelopeType = 'multipart/form-data'
}: {
  signer: ISigner
  url: string
  method: 'POST' | 'PUT'
  partType: string
  partBody: string
  envelopeType?: string
}): Promise<Response> {
  const boundary = 'was-test-boundary'
  const body = new TextEncoder().encode(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="part"\r\n' +
      `Content-Type: ${partType}\r\n\r\n` +
      `${partBody}\r\n` +
      `--${boundary}--\r\n`
  )
  const headers = await signCapabilityInvocation({
    url,
    method,
    headers: {
      date: new Date().toUTCString(),
      'content-type': `${envelopeType}; boundary=${boundary}`
    },
    body,
    invocationSigner: signer,
    capabilityAction: method
  })
  return fetch(url, { method, headers, body: new Blob([body]) })
}

/**
 * The four capturing segments of a validator as this server emits them:
 * generation, epoch milliseconds, counter, origin id. The `ETag` parsers
 * below build their patterns from it.
 */
const VALIDATOR_SEGMENTS =
  '([A-Za-z0-9]+)\\.(\\d+)\\.(\\d+)\\.([A-Za-z0-9_-]{1,64})'

/**
 * Parses an `ETag` header this server emits into the validator it formats,
 * asserting the layout: `"<generation>.<ms>.<counter>.<originId>"` on a
 * Resource, a chunk, a Resource's `/meta` object and a governed log, plus a
 * trailing `.<local>` segment with `container` set (a Space or Collection
 * Metadata object). Test-only: a client treats the whole value as opaque.
 *
 * @param etag {string | null | undefined}   the `ETag` header value
 * @param [options] {object}
 * @param [options.container] {boolean}   expect the five-segment form of a
 *   Space or Collection Metadata object
 * @returns {EtagValidator}
 */
export function parseEtagSegments(
  etag: string | null | undefined,
  { container = false }: { container?: boolean } = {}
): EtagValidator {
  assert.ok(etag, 'expected an ETag header')
  const pattern = container
    ? new RegExp(`^"${VALIDATOR_SEGMENTS}\\.(\\d+)"$`)
    : new RegExp(`^"${VALIDATOR_SEGMENTS}"$`)
  const match = pattern.exec(etag!)
  assert.ok(
    match,
    container
      ? `expected a quoted "<generation>.<ms>.<counter>.<origin>.<local>" ETag, got ${etag}`
      : `expected a quoted "<generation>.<ms>.<counter>.<origin>" ETag, got ${etag}`
  )
  return {
    generation: match![1]!,
    stamp: {
      updatedAt: isoOfMs(Number(match![2])),
      updatedAtCounter: Number(match![3]),
      originId: match![4]!
    },
    ...(container && { local: Number(match![5]) })
  }
}

/**
 * Splits a Resource `/meta` `ETag` into its two parts, each re-quoted as a
 * four-segment validator: the content record's, which equals the Resource's
 * own `ETag`, and the `/meta` record's, absent before the first metadata
 * write. Asserts the layout. Test-only: a client treats the whole value as
 * opaque.
 *
 * @param etag {string | null | undefined}   the `/meta` `ETag` header value
 * @returns {{ content: string, meta?: string }}
 */
export function splitResourceMetaEtag(etag: string | null | undefined): {
  content: string
  meta?: string
} {
  assert.ok(etag, 'expected an ETag header')
  const match = new RegExp(
    `^"(${VALIDATOR_SEGMENTS})(?:\\.(${VALIDATOR_SEGMENTS}))?"$`
  ).exec(etag!)
  assert.ok(
    match,
    `expected a quoted content validator, optionally followed by a /meta validator, got ${etag}`
  )
  // Group 1 is the whole content validator and group 6 the whole `/meta`
  // one; the groups between are the segments the shared pattern captures.
  return {
    content: `"${match![1]!}"`,
    ...(match![6] !== undefined && { meta: `"${match![6]}"` })
  }
}

/**
 * Asserts a later `ETag` of the same record moved past an earlier one: the
 * same generation, and a write stamp that sorts strictly later
 * (`compareStamps`). With `container`,
 * both are the five-segment form and a stamped write resets the local
 * segment to 0.
 *
 * @param options {object}
 * @param options.before {string | null | undefined}
 * @param options.after {string | null | undefined}
 * @param [options.container] {boolean}
 * @returns {void}
 */
export function assertEtagAdvanced({
  before,
  after,
  container = false
}: {
  before: string | null | undefined
  after: string | null | undefined
  container?: boolean
}): void {
  const earlier = parseEtagSegments(before, { container })
  const later = parseEtagSegments(after, { container })
  assert.equal(later.generation, earlier.generation, 'same generation')
  assert.ok(
    compareStamps(later.stamp, earlier.stamp) > 0,
    `expected ${after} to carry a later stamp than ${before}`
  )
  if (container) {
    assert.equal(later.local, 0, 'a stamped write resets the local segment')
  }
}

/**
 * The generation segment of an `ETag` this server emits (either form).
 * Suites use it to compare generations across a hard delete and re-create.
 *
 * @param etag {string}   the `ETag` header value
 * @returns {string}
 */
export function etagGeneration(etag: string): string {
  const match = new RegExp(`^"${VALIDATOR_SEGMENTS}(?:\\.\\d+)?"$`).exec(etag)
  assert.ok(match, `expected a quoted stamp ETag, got ${etag}`)
  return match![1]!
}

/**
 * The disposable Postgres database the Postgres suites run against, from
 * `WAS_TEST_DATABASE_URL`. A suite skips itself when it is unset, so a call
 * with it unset is the suite's own mistake.
 * @returns {string}
 */
function testDatabaseUrl(): string {
  const connectionString = process.env.WAS_TEST_DATABASE_URL
  assert.ok(connectionString, 'WAS_TEST_DATABASE_URL is unset')
  return connectionString
}

/**
 * Runs one statement against the test database as an admin client outside
 * any backend's pool.
 * @param sql {string}
 * @param [values] {unknown[]}
 * @returns {Promise<pg.QueryResult>}
 */
export async function postgresAdminQuery(
  sql: string,
  values?: unknown[]
): Promise<pg.QueryResult> {
  const admin = new pg.Client({ connectionString: testDatabaseUrl() })
  await admin.connect()
  try {
    return await admin.query(sql, values)
  } finally {
    await admin.end()
  }
}

/**
 * Opens a Postgres backend over a throwaway `was_test_<hex>` schema of the
 * test database, the Postgres analogue of `openTempBackend()`'s temp dir.
 * `schema` reopens one an earlier call minted, for a reboot over the same
 * store. `dropSchema` removes the schema with everything in it; close the
 * backend first.
 * @param [options] {object}   the backend's own options, less the connection
 * @param [options.schema] {string}
 * @returns {Promise<{ backend: PostgresBackend, schema: string, dropSchema: () => Promise<void> }>}
 */
export async function openTempPostgres({
  schema = `was_test_${randomBytes(8).toString('hex')}`,
  ...options
}: Omit<PostgresBackendOptions, 'connectionString' | 'schema'> & {
  schema?: string
} = {}): Promise<{
  backend: PostgresBackend
  schema: string
  dropSchema: () => Promise<void>
}> {
  const backend = await PostgresBackend.open({
    ...options,
    connectionString: testDatabaseUrl(),
    schema
  })
  return {
    backend,
    schema,
    async dropSchema() {
      await postgresAdminQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  }
}

/**
 * Alice's did:key verification method id (matches the seed in `fixtures`).
 */
export const ALICE_KEY_ID =
  'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD' +
  '#z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'

/**
 * The full signed-headers list of a bodied write.
 */
export const FULL_COVERED =
  '(key-id) (created) (expires) (request-target) host ' +
  'capability-invocation content-type digest'

/**
 * Builds a syntactically valid Cavage `Authorization: Signature ...` header
 * with a placeholder signature value, for requests a hook refuses before any
 * signature is verified (the digest gate, the body limit).
 * @param [options] {object}
 * @param [options.covered] {string}   the signed-headers list
 * @param [options.keyId] {string}   the signing key id the header names
 * @returns {string}
 */
export function placeholderAuthHeader({
  covered = FULL_COVERED,
  keyId = ALICE_KEY_ID
}: { covered?: string; keyId?: string } = {}): string {
  return (
    `Signature keyId="${keyId}",headers="${covered}",` +
    'signature="cGxhY2Vob2xkZXI=",created="1758150502",expires="9999999999"'
  )
}

/**
 * The root `Capability-Invocation` header for a target URL.
 * @param options {object}
 * @param options.target {string}   the invocation target URL
 * @param [options.action] {string}   the capability action
 * @returns {string}
 */
export function rootInvocation({
  target,
  action = 'PUT'
}: {
  target: string
  action?: string
}): string {
  return `zcap id="${rootCapabilityId(target)}",action="${action}"`
}

/**
 * Computes the spec's `Digest` header value (multibase base64url multihash of
 * the body's SHA-256) for a string body.
 * @param body {string}
 * @returns {string}
 */
export function digestHeaderFor(body: string): string {
  const hash = createHash('sha256').update(body, 'utf8').digest()
  // multihash: sha2-256 (0x12), length 32 (0x20), then the digest bytes
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), hash])
  return `mh=u${multihash.toString('base64url')}`
}

export const fixtures = {
  alice: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1Air2KcEdUpJnJ9m61WFRUFgtC3LHrmGCpwFAkZ7rbbohX'
      })
    }
  },
  aliceDelegatedApp: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1AeeM8yN1D3cM56LsPmr3fFKuyv7MC4tdRkeiujMkyRy2u'
      })
    }
  },
  bob: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1AmpBeBetWxKMBpAcHsztGogaUki1LXWANSzTd5CiYoikA'
      })
    }
  },
  bobDelegatedApp: {
    secret: {
      adminKeySeedBytes: decodeSecretKeySeed({
        secretKeySeed: 'z1AfgF2HQvQaaAhod3KEYUHwY5epGtP5QmbEMKtMFf8XcYk'
      })
    }
  }
}

// const didKeyDriver = didKey.driver()
// didKeyDriver.use({
//   multibaseMultikeyHeader: 'z6Mk',
//   fromMultibase: Ed25519VerificationKey.from
// });
/**
 * The suite's default ZcapClient: delegation proofs are signed with
 * `eddsa-jcs-2022`, matching what `PwsClient.fromSigner` and wallet-core's
 * clients emit, so every suite driving this helper exercises the suite real
 * clients send. `Ed25519Signature2020` is still accepted by the server and is
 * exercised on its own in `delegation-suite-api.test.ts`.
 *
 * @param options {object}
 * @param options.signer {ISigner}
 * @returns {ZcapClient}
 */
export function client({ signer }: { signer: ISigner }): ZcapClient {
  return new ZcapClient({
    SuiteClass: EddsaJcs2022,
    invocationSigner: signer,
    delegationSigner: signer
  })
}

/**
 * Builds a high-level PWS client wrapping a ZcapClient for the given signer.
 *
 * @param options {object}
 * @param options.signer {ISigner}
 * @param options.baseServerUrl {string}   the suite's server URL, with or without
 *   its trailing slash (the client canonicalizes it)
 * @returns {PwsClient}
 */
export function pwsClient({
  signer,
  baseServerUrl
}: {
  signer: ISigner
  baseServerUrl: string
}): PwsClient {
  return new PwsClient({
    baseServerUrl: baseServerUrl,
    zcapClient: client({ signer })
  })
}

/**
 * Builds the test identities (Alice, her delegated app, and Bob), each carrying
 * a high-level `PwsClient` built from the suite's server URL. Suites drive the
 * server through these `pws` clients rather than raw `ZcapClient.request()`.
 *
 * @param options {object}
 * @param options.baseServerUrl {string}   the suite's in-process server URL, as
 *   `startTestServer` returns `baseServerUrl` (the client canonicalizes the
 *   trailing slash); also the zcap invocationTarget base, so it must name the
 *   injected app's origin
 * @returns {Promise<object>}
 */
export async function zcapClients({
  baseServerUrl
}: {
  baseServerUrl: string
}) {
  // Set up Alice's root / admin key pair and client
  const aliceAdminKeyPair = await Ed25519VerificationKey.generate({
    seed: fixtures.alice.secret.adminKeySeedBytes
  })
  const aliceRootDid = `did:key:${aliceAdminKeyPair.fingerprint()}`
  const aliceRootSigner = aliceAdminKeyPair.didKeySigner()

  // Set up a key pair for Alice's delegated app
  const aliceDelegatedAppKeyPair = await Ed25519VerificationKey.generate({
    seed: fixtures.aliceDelegatedApp.secret.adminKeySeedBytes
  })
  const aliceDelegatedAppDid = `did:key:${aliceDelegatedAppKeyPair.fingerprint()}`
  const aliceDelegatedAppSigner = aliceDelegatedAppKeyPair.didKeySigner()

  // Set up Bob's root / admin key pair and client
  const bobAdminKeyPair = await Ed25519VerificationKey.generate({
    seed: fixtures.bob.secret.adminKeySeedBytes
  })
  const bobRootDid = `did:key:${bobAdminKeyPair.fingerprint()}`
  const bobRootSigner = bobAdminKeyPair.didKeySigner()

  return {
    alice: {
      // did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD
      did: aliceRootDid,
      // the raw invocation signer, for clients that take one directly (e.g.
      // `@interop/webkms-client`) rather than wrapping a ZcapClient
      signer: aliceRootSigner,
      pws: pwsClient({ signer: aliceRootSigner, baseServerUrl }),
      space1: {
        id: '426e7db8-26b5-4fdc-8068-9dcb948fd291'
      },
      space2: {
        id: '6b5be748-5f39-4936-a895-409e393c399c'
      }
    },
    aliceDelegatedApp: {
      // did:key:z6MksgunmKuHjE2GvC3DYLBC3p7i1QkMRyhWxT4rNNnKxZar
      did: aliceDelegatedAppDid,
      signer: aliceDelegatedAppSigner,
      pws: pwsClient({ signer: aliceDelegatedAppSigner, baseServerUrl })
    },
    bob: {
      // did:key:z6MkgpJp9jpAsqFCKqKMvHsAL5VEnkcd8FhhZdwnX33BFDgs
      did: bobRootDid,
      signer: bobRootSigner,
      pws: pwsClient({ signer: bobRootSigner, baseServerUrl }),
      space2: {
        id: '94f03216-5ab4-4723-853c-cf837c171323'
      }
    }
  }
}

/**
 * A published `did:webvh` key pair's own bare `did:key` identity: the DID a
 * ladder-signed DELETE-only child names as controller, and the signer the
 * matching invocation is signed under. The deletion ceremony's delegatee is
 * this key rather than the `did:webvh` fragment -- it is the one identity
 * that keeps resolving while the walk deletes the Spaces every hosted
 * document lives in.
 *
 * @param keyPair {any}   the key pair (typically an account's ladder key)
 * @returns {{ did: string, signer: any }}
 */
export function bareDidKeyOf(keyPair: any): { did: string; signer: any } {
  const did = `did:key:${keyPair.publicKeyMultibase}`
  return { did, signer: keyPair.didKeySigner() }
}

/**
 * One hour out: the default expiry a suite's delegations carry.
 *
 * @returns {Date}
 */
export function anHourFromNow(): Date {
  return new Date(Date.now() + 60 * 60 * 1000)
}

/**
 * Delegates from a parent capability. The shared shape the zcap-authorization
 * suites mint their grants with.
 *
 * @param options {object}
 * @param options.signer {any}   the delegation-proof signer
 * @param options.capability {any}   the parent capability, or its root id
 * @param options.invocationTarget {string}
 * @param options.controller {string}
 * @param [options.allowedActions] {string[]}   omitted, the grant inherits
 *   the parent's (none, under a root parent)
 * @param [options.expires] {Date}   an expiry within the parent's, for a
 *   sub-delegation; defaults to an hour from now
 * @returns {Promise<any>}
 */
export async function delegate({
  signer,
  capability,
  invocationTarget,
  controller,
  allowedActions,
  expires = anHourFromNow()
}: {
  signer: any
  capability: any
  invocationTarget: string
  controller: string
  allowedActions?: string[]
  expires?: Date
}): Promise<any> {
  return client({ signer }).delegate({
    capability,
    invocationTarget,
    controller,
    allowedActions,
    expires
  })
}

/**
 * Asserts a Space still carries `controller`, read from its Metadata object
 * under a root invocation by that controller's key. The survival check after
 * a refused controller rewrite or delete.
 *
 * @param options {object}
 * @param options.spaceUrl {string}   the Space's canonical trailing-slash URL
 * @param options.controller {string}   the DID the Space should still carry,
 *   and the one the root capability is invoked under
 * @param options.signer {ISigner}   that controller's key
 * @returns {Promise<void>}
 */
export async function assertSpaceController({
  spaceUrl,
  controller,
  signer
}: {
  spaceUrl: string
  controller: string
  signer: ISigner
}): Promise<void> {
  const metadata = await client({ signer }).request({
    url: `${spaceUrl}meta`,
    method: 'GET',
    action: 'GET',
    capability: rootZcap({ target: spaceUrl, controller })
  })
  assert.equal((metadata.data as { controller: string }).controller, controller)
}

/**
 * Asserts that the Encrypted Collections profile entry in the server's service
 * description advertises a given optional affordance. The whole document is
 * pinned in `test/service-description-api.test.ts`; this reads just the one
 * token, so a feature's own suite proves its advertisement alongside its
 * behavior.
 * @param options {object}
 * @param options.baseServerUrl {string}
 * @param options.feature {string}   the `features` token to expect
 * @returns {Promise<void>}
 */
export async function assertEncryptedCollectionsFeature({
  baseServerUrl,
  feature
}: {
  baseServerUrl: string
  feature: string
}): Promise<void> {
  const response = await fetch(`${baseServerUrl}service`)
  const document = (await response.json()) as {
    specs: Record<string, Array<{ version: string; features?: string[] }>>
  }
  const entries = document.specs[ENCRYPTED_COLLECTIONS_IDENTIFIER] ?? []
  const entry = entries.find(
    candidate => candidate.version === ENCRYPTED_COLLECTIONS_VERSION
  )
  assert.ok(entry, 'expected an Encrypted Collections version entry')
  assert.ok(
    entry.features?.includes(feature),
    `expected the Encrypted Collections entry to advertise ${feature}`
  )
}

/**
 * Gives a test provider's adapter backend the Space and Collection that a
 * routed write lands in. The control plane keeps the real Metadata objects in
 * the server's default backend, but a backend refuses any write into a
 * container that has no Metadata object of its own.
 * @param options {object}
 * @param options.backend {StorageBackend}   the provider's adapter
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.controller {string}
 * @returns {Promise<void>}
 */
export async function provisionProviderContainers({
  backend,
  spaceId,
  collectionId,
  controller
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
  controller: string
}): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceMetadata: {
      id: spaceId,
      type: ['Space'],
      controller: controller as IDID
    }
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: { id: collectionId, type: ['Collection'] }
  })
}

/**
 * Verifies an archive's provenance offline, the way an importer would: the
 * embedded `did.jsonl` snapshot is verified with `resolveDIDFromLog` (SCID,
 * hash chain, update keys), then every statement's `eddsa-jcs-2022` proof is
 * checked against the verification method the snapshot's document lists,
 * under `assertionMethod`. Throws on the first statement that fails.
 *
 * @param options {object}
 * @param options.provenance {Uint8Array}   the `provenance.jsonl` bytes
 * @param options.didLog {Uint8Array}   the `did.jsonl` bytes
 * @returns {Promise<{ did: string, statements: any[] }>}   the statements, in
 *   archive order
 */
export async function verifyProvenanceOffline({
  provenance,
  didLog
}: {
  provenance: Uint8Array
  didLog: Uint8Array
}): Promise<{ did: string; statements: any[] }> {
  const log = readLogFromString(Buffer.from(didLog).toString('utf8'))
  const { did, doc } = await resolveDIDFromLog(log)
  assert.ok(doc, 'the embedded log resolves to a document')
  const text = Buffer.from(provenance).toString('utf8')
  assert.ok(text.endsWith('\n'), 'every statement line ends with a newline')
  const statements: any[] = text
    .slice(0, -1)
    .split('\n')
    .map(line => JSON.parse(line))
  for (const statement of statements) {
    const methodId: string = statement.proof.verificationMethod
    const method: object | undefined = doc.verificationMethod?.find(
      vm => vm.id === methodId
    )
    assert.ok(method, `the log lists ${methodId}`)
    const result = await jsigs.verify(structuredClone(statement), {
      suite: new DataIntegrityProof({ cryptosuite: createVerifyCryptosuite() }),
      purpose: new jsigs.purposes.AssertionProofPurpose({ controller: doc }),
      documentLoader: async (url: string) => {
        if (url !== methodId) {
          throw new Error(`Unexpected document load: "${url}".`)
        }
        return {
          document: {
            '@context': 'https://w3id.org/security/multikey/v1',
            ...method
          }
        }
      }
    })
    assert.ok(
      result.verified,
      `statement ${statement.id} verifies: ${String(result.error)}`
    )
  }
  return { did, statements }
}

/**
 * Imports an archive straight into a backend the way the Import Space handler
 * does: the plan is built and its provenance judged through the same shared
 * call (`prepareImportPlan`), then handed to `importSpace`, and the archive's
 * revocation records are verified and installed last
 * (`installImportRevocations`).
 *
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.spaceId {string}
 * @param options.tarStream {Readable}
 * @param [options.restoreSpaceMetadata] {boolean}
 * @param [options.revocationScope] {ImportRevocationScope}   the destination
 *   Space's revocation scope; omitted, no archived revocation is installed
 * @returns {Promise<ImportStats>}
 */
export async function importArchive({
  backend,
  spaceId,
  tarStream,
  restoreSpaceMetadata,
  revocationScope
}: {
  backend: StorageBackend
  spaceId: string
  tarStream: Readable
  restoreSpaceMetadata?: boolean
  revocationScope?: ImportRevocationScope
}): Promise<ImportStats> {
  const logger = backend.logger ?? pino({ level: 'silent' })
  const { plan, provenance, revocations } = await prepareImportPlan({
    tarStream,
    logger
  })
  const stats = await backend.importSpace({
    spaceId,
    plan,
    provenance,
    ...(restoreSpaceMetadata !== undefined && { restoreSpaceMetadata })
  })
  if (revocationScope !== undefined) {
    await installImportRevocations({
      capabilities: revocations,
      scope: revocationScope,
      storage: backend,
      logger
    })
  }
  return stats
}

/**
 * A descriptor recipient entry (the JWE recipients-entry shape).
 * @param kid {string}
 * @returns {{ header: { kid: string, alg: string }, encrypted_key: string }}
 */
export function recipient(kid: string): {
  header: { kid: string; alg: string }
  encrypted_key: string
} {
  return {
    header: { kid, alg: 'ECDH-ES+A256KW' },
    encrypted_key: `wrapped-${kid}`
  }
}

/**
 * A valid `encryption` descriptor with one epoch and one recipient.
 */
export const oneEpoch = {
  type: 'WasEpochConfiguration',
  scheme: 'edv',
  currentEpoch: 'urn:epoch:1',
  epochs: [{ id: 'urn:epoch:1', recipients: [recipient('did:key:zApp1#ka')] }]
}

/**
 * `oneEpoch` after a second epoch was added and made current.
 */
export const twoEpochs = {
  ...oneEpoch,
  currentEpoch: 'urn:epoch:2',
  epochs: [
    { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp2#ka')] },
    ...oneEpoch.epochs
  ]
}

/**
 * A governing history log entry line: the profile's members with `state` as
 * given.
 * @param options {object}
 * @param options.ordinal {number}
 * @param options.state {object}
 * @param [options.parameters] {object}
 * @returns {string}
 */
export function entryLine({
  ordinal,
  state,
  parameters = {}
}: {
  ordinal: number
  state: Record<string, unknown>
  parameters?: Record<string, unknown>
}): string {
  return JSON.stringify({
    versionId: `${ordinal}-hash${ordinal}`,
    versionTime: '2026-09-07T00:00:00Z',
    parameters,
    state,
    proof: []
  })
}

/**
 * A governing history log's genesis line: carries the format identifier and
 * the SCID.
 * @param state {object}
 * @returns {string}
 */
export function genesisLine(state: Record<string, unknown>): string {
  return entryLine({
    ordinal: 1,
    state,
    parameters: { method: 'resource-log:0.1', scid: 'zScid' }
  })
}

/**
 * A changes-feed document of the `resource` kind.
 */
export type ResourceFeedDocument = Extract<FeedDocument, { kind: 'resource' }>

/**
 * The `resource` documents of a changes-feed page, in feed order.
 * @param documents {FeedDocument[]}
 * @returns {ResourceFeedDocument[]}
 */
export function resourceDocuments(
  documents: FeedDocument[]
): ResourceFeedDocument[] {
  return documents.filter(
    (document): document is ResourceFeedDocument => document.kind === 'resource'
  )
}

/**
 * Sets a key pair's id and controller to a method of `did`.
 * @param keyPair {Ed25519VerificationKey}
 * @param did {string}
 * @returns {Ed25519VerificationKey}
 */
export function bindKey(
  keyPair: Ed25519VerificationKey,
  did: string
): Ed25519VerificationKey {
  keyPair.id = `${did}#${keyPair.publicKeyMultibase}`
  keyPair.controller = did
  return keyPair
}

/**
 * A binary `ResourceInput` over one in-memory body.
 * @param bytes {Buffer | string}
 * @param [options] {object}
 * @param [options.contentType] {string}
 * @param [options.declaredBytes] {number}
 * @returns {ResourceInput}
 */
export function binaryInput(
  bytes: Buffer | string,
  options: { contentType?: string; declaredBytes?: number } = {}
): ResourceInput {
  return {
    kind: 'binary',
    contentType: options.contentType ?? 'application/octet-stream',
    stream: Readable.from([Buffer.from(bytes)]),
    ...(options.declaredBytes !== undefined && {
      declaredBytes: options.declaredBytes
    })
  }
}

/**
 * Whether a path exists.
 * @param target {string}
 * @returns {Promise<boolean>}
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return false
    }
    throw err
  }
}

/**
 * Creates a Space on one server of a replication suite, through its backend.
 * @param options {object}
 * @param options.server {PeerServer}
 * @param options.spaceId {string}
 * @param options.controller {string}   the controller DID
 * @param [options.type] {string[]}   the Space's `type`; defaults to
 *   `['Space']`
 * @returns {Promise<void>}
 */
export async function createPeerSpace({
  server,
  spaceId,
  controller,
  type = ['Space']
}: {
  server: PeerServer
  spaceId: string
  controller: string
  type?: string[]
}): Promise<void> {
  await server.backend.writeSpace({
    spaceId,
    spaceMetadata: { id: spaceId, type, controller: controller as IDID }
  })
}

/**
 * Runs one pull cycle of a registration.
 * @param options {object}
 * @param options.server {PeerServer}
 * @param options.spaceId {string}
 * @param [options.replicaId] {string}
 * @returns {Promise<void>}
 */
export async function pullOnce({
  server,
  spaceId,
  replicaId = 'peer'
}: {
  server: PeerServer
  spaceId: string
  replicaId?: string
}): Promise<void> {
  await server.fastify.replication.pullNow({ spaceId, replicaId })
}

/**
 * Watches the global `fetch` for a request of a `did-witness.json`.
 * `@interop/did-method-webvh` makes one, with the global `fetch`, when it
 * verifies a log that declares witnesses and is given no witness proofs. A
 * watched request is recorded and refused, so it never leaves the process.
 * Every other request passes through, so a test's own HTTP clients keep
 * working. Call `restore` when the test ends.
 *
 * @returns {{ witnessFetches: string[], restore: () => void }}
 */
export function watchWitnessFetches(): {
  witnessFetches: string[]
  restore: () => void
} {
  const realFetch = globalThis.fetch
  const witnessFetches: string[] = []
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('did-witness.json')) {
        witnessFetches.push(url)
        throw new Error(`Unexpected witness fetch: "${url}".`)
      }
      return realFetch(input, init)
    })
  return { witnessFetches, restore: () => spy.mockRestore() }
}

export const REPLICA_CAPABILITY_ID = 'urn:uuid:test-suite-pull-capability'

/**
 * A replica registration for a backend-level test. The capability is a
 * stand-in: a backend stores it and never reads it.
 * @param options {object}
 * @param options.id {string}
 * @param options.spaceId {string}   the local Space
 * @param [options.collectionId] {string}   the one selected Collection
 * @returns {ReplicaRegistration}
 */
export function replicaRegistration({
  id,
  spaceId,
  collectionId = 'col'
}: {
  id: string
  spaceId: string
  collectionId?: string
}): ReplicaRegistration {
  const fromSpace = `https://peer.example/space/${spaceId}/`
  return {
    id,
    fromSpace,
    toSpace: `https://pws.example/space/${spaceId}/`,
    capability: {
      '@context': ['https://w3id.org/zcap/v1'],
      id: REPLICA_CAPABILITY_ID,
      parentCapability: rootCapabilityId(fromSpace),
      controller: 'did:webvh:scid:pws.example:space:server:id',
      invocationTarget: fromSpace,
      allowedAction: ['GET', 'HEAD'],
      expires: '2099-01-01T00:00:00Z',
      proof: {}
    } as unknown as ReplicaRegistration['capability'],
    collections: [{ id: collectionId }],
    role: 'source'
  }
}
