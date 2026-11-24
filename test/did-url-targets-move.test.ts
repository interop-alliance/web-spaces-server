/**
 * A Space moving between two servers with its DID URL grants (Vitest), end to
 * end.
 *
 * Two test servers, each over its own temp-dir backend. The user's
 * `did:webvh` is hosted on neither: both servers resolve it over the network,
 * through a stubbed `peerLogFetcher` that serves one shared log from memory
 * and counts each server's fetches. Its document maps `/` to Space S on
 * server one, and the Space's controller issues DID URL grants under that
 * root.
 *
 * The move: Export Space on server one, Import Space on server two, then a
 * new log entry repoints the `PathHandler` to the Space's URL on server two.
 * The unchanged grant then works on server two, through the early fetch a
 * root that does not dereference to the Space takes. On server one it is
 * refused once the cached document expires. A grant revoked on server one
 * before the export stays revoked on server two, and an https grant issued
 * for server one does not work on server two.
 *
 * The cache TTL of a foreign document is lowered through a mock of the config
 * module, as the peer resolution suite does, so the expiry case runs in a
 * couple of seconds.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import {
  createDID,
  logToJsonlString,
  updateDID
} from '@interop/did-method-webvh'
import type { DIDLog, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { ProblemTypes } from '@interop/storage-core'

import type { PeerLogFetcher } from '../src/lib/peerWebvh.js'
import { spaceRevocationsPath } from '../src/lib/paths.js'
import { signedInject } from '../src/testing.js'
import { rootCapabilityId } from '../src/zcap.js'
import {
  bareDidKeyOf,
  delegate,
  openTempBackend,
  startTestServer,
  webvhLogSigner,
  zcapClients,
  pathHandler,
  sleep
} from './helpers.js'

/**
 * The cache TTL of a foreign document in this suite, in milliseconds.
 */
const CACHE_TTL = 1_500

// `vi.mock` is hoisted above the constant, so it restates the value.
vi.mock('../src/config.default.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/config.default.js')>()),
  PEER_WEBVH_CACHE_TTL: 1_500
}))

/**
 * One test server, the fetches its peer resolver made, and the Space under
 * test on it.
 */
interface TestServer {
  fastify: FastifyInstance
  baseServerUrl: string
  fetched: string[]
  spaceUrl: string
}

describe('moving a Space with its DID URL grants', () => {
  const spaceId = randomUUID()
  const logUrl = 'https://user.example/accounts/u1/did.jsonl'
  /**
   * The user's log, as the fake host serves it to both servers.
   */
  let served: Uint8Array | undefined
  let one: TestServer, two: TestServer
  let alice: any, bob: any, carol: { did: string; signer: any }, rogue: any
  let did: string, log: DIDLog, logSigner: Signer
  let grant: any, revokedGrant: any, httpsGrant: any

  /**
   * Boots a server whose peer resolver fetches the shared log.
   *
   * @returns {Promise<TestServer>}
   */
  async function bootServer(): Promise<TestServer> {
    const fetched: string[] = []
    const peerLogFetcher: PeerLogFetcher = async ({ url }) => {
      fetched.push(url)
      if (url !== logUrl || served === undefined) {
        throw new Error(`No log is served at ${url}.`)
      }
      return served
    }
    const { fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend(),
      peerLogFetcher
    })
    return {
      fastify,
      baseServerUrl,
      fetched,
      spaceUrl: new URL(`/space/${spaceId}/`, baseServerUrl).href
    }
  }

  /**
   * Serves a new version of the user's log, mapping `/` to `root`.
   *
   * @param root {string}
   * @returns {Promise<void>}
   */
  async function repoint(root: string): Promise<void> {
    const updated = await updateDID({
      log,
      signer: logSigner,
      services: [pathHandler({ path: '/', serviceEndpoint: root })]
    })
    log = updated.log
    served = new TextEncoder().encode(logToJsonlString(log))
  }

  /**
   * A signed GET of `photos/doc-1` in the Space on `server`.
   *
   * @param options {object}
   * @param options.server {TestServer}
   * @param options.signer {any}
   * @param options.capability {string | object}
   * @returns {Promise<LightMyRequestResponse>}
   */
  async function readPhoto({
    server,
    signer,
    capability
  }: {
    server: TestServer
    signer: any
    capability: string | object
  }): Promise<LightMyRequestResponse> {
    return await signedInject({
      server: { fastify: server.fastify, serverUrl: server.baseServerUrl },
      path: `/space/${spaceId}/photos/doc-1`,
      signer,
      capability
    })
  }

  /**
   * Asserts a response is the masked `not-found`, byte for byte what a
   * signature by an unrelated key collects for the same read on `server`.
   *
   * @param options {object}
   * @param options.server {TestServer}
   * @param options.response {LightMyRequestResponse}
   * @returns {Promise<void>}
   */
  async function assertMasked({
    server,
    response
  }: {
    server: TestServer
    response: LightMyRequestResponse
  }): Promise<void> {
    const baseline = await readPhoto({
      server,
      signer: rogue,
      capability: rootCapabilityId(server.spaceUrl)
    })
    assert.equal(baseline.statusCode, 404)
    assert.equal(response.statusCode, 404, response.payload)
    assert.equal(response.payload, baseline.payload)
  }

  /**
   * The number of fetches of the user's log `server` made.
   *
   * @param server {TestServer}
   * @returns {number}
   */
  function fetchesOn(server: TestServer): number {
    return server.fetched.filter(url => url === logUrl).length
  }

  beforeAll(async () => {
    one = await bootServer()
    two = await bootServer()
    // The suite's keys are fixed, so Alice and Bob are the same DIDs on both
    // servers.
    ;({ alice, bob } = await zcapClients({ baseServerUrl: one.baseServerUrl }))
    carol = bareDidKeyOf(await Ed25519VerificationKey.generate())
    rogue = (await Ed25519VerificationKey.generate()).didKeySigner()

    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Moving Space', controller: alice.did })
    await space.collection('photos').configure({ force: true })
    await space.collection('photos').put('doc-1', { photo: 1 })

    const updateKeyPair = await Ed25519VerificationKey.generate()
    logSigner = webvhLogSigner({ keyPair: updateKeyPair })
    const clientKeyPair = await Ed25519VerificationKey.generate()
    const created = await createDID({
      address: 'https://user.example/accounts/u1',
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [
        {
          type: 'Multikey',
          publicKeyMultibase: clientKeyPair.publicKeyMultibase!,
          purpose: ['authentication', 'capabilityInvocation']
        }
      ] as any,
      services: [pathHandler({ path: '/', serviceEndpoint: one.spaceUrl })]
    })
    did = created.did
    log = created.log
    served = new TextEncoder().encode(logToJsonlString(log))

    const root = rootCapabilityId(`${did}/`)
    grant = await delegate({
      signer: alice.signer,
      capability: root,
      invocationTarget: `${did}/photos/`,
      controller: bob.did,
      allowedActions: ['GET']
    })
    revokedGrant = await delegate({
      signer: alice.signer,
      capability: root,
      invocationTarget: `${did}/photos/`,
      controller: carol.did,
      allowedActions: ['GET']
    })
    httpsGrant = await delegate({
      signer: alice.signer,
      capability: rootCapabilityId(one.spaceUrl),
      invocationTarget: `${one.spaceUrl}photos/`,
      controller: bob.did,
      allowedActions: ['GET']
    })
  })
  afterAll(async () => {
    await one.fastify.close()
    await two.fastify.close()
  })

  it('the DID URL grant works on server one', async () => {
    const read = await readPhoto({
      server: one,
      signer: bob.signer,
      capability: grant
    })
    assert.equal(read.statusCode, 200, read.payload)
    assert.deepEqual(read.json(), { photo: 1 })
    assert.equal(fetchesOn(one), 1)
  })

  it('a second DID URL grant is revoked on server one', async () => {
    const before = await readPhoto({
      server: one,
      signer: carol.signer,
      capability: revokedGrant
    })
    assert.equal(before.statusCode, 200, before.payload)
    const revoked = await signedInject({
      server: { fastify: one.fastify, serverUrl: one.baseServerUrl },
      path: spaceRevocationsPath({ spaceId, revocationId: revokedGrant.id }),
      signer: alice.signer,
      method: 'POST',
      json: revokedGrant
    })
    assert.equal(revoked.statusCode, 204, revoked.payload)
    const after = await readPhoto({
      server: one,
      signer: carol.signer,
      capability: revokedGrant
    })
    assert.equal(after.statusCode, 404)
    assert.equal(after.json().type, ProblemTypes.CAPABILITY_REVOKED)
  })

  it('the Space is exported from server one and imported on server two', async () => {
    const exported = await alice.pws.request({
      url: `${one.spaceUrl}export`,
      method: 'POST'
    })
    assert.equal(exported.status, 200)
    const archive = Buffer.from(await exported.arrayBuffer())
    const { alice: aliceOnTwo } = await zcapClients({
      baseServerUrl: two.baseServerUrl
    })
    await aliceOnTwo.pws
      .space(spaceId)
      .configure({ name: 'Moving Space', controller: alice.did })
    const imported = await aliceOnTwo.pws.request({
      url: `${two.spaceUrl}import`,
      method: 'POST',
      body: archive,
      headers: { 'content-type': 'application/x-tar' }
    })
    assert.equal(imported.status, 200)

    // Not repointed yet: the root dereferences to server one, and this
    // request's own fetch leaves no early fetch to take.
    await assertMasked({
      server: two,
      response: await readPhoto({
        server: two,
        signer: bob.signer,
        capability: grant
      })
    })
    assert.equal(fetchesOn(two), 1)
  })

  it('after the repoint the unchanged grant works on server two', async () => {
    await repoint(two.spaceUrl)
    // Server two's cached document still maps `/` to server one; the
    // mismatch fetches the log once more and reads the repoint.
    const read = await readPhoto({
      server: two,
      signer: bob.signer,
      capability: grant
    })
    assert.equal(read.statusCode, 200, read.payload)
    assert.deepEqual(read.json(), { photo: 1 })
    assert.equal(fetchesOn(two), 2)
  })

  it('the revocation made on server one is in force on server two', async () => {
    const read = await readPhoto({
      server: two,
      signer: carol.signer,
      capability: revokedGrant
    })
    assert.equal(read.statusCode, 404)
    assert.equal(read.json().type, ProblemTypes.CAPABILITY_REVOKED)
  })

  it('an https grant issued for server one does not work on server two', async () => {
    const onOne = await readPhoto({
      server: one,
      signer: bob.signer,
      capability: httpsGrant
    })
    assert.equal(onOne.statusCode, 200, onOne.payload)
    await assertMasked({
      server: two,
      response: await readPhoto({
        server: two,
        signer: bob.signer,
        capability: httpsGrant
      })
    })
  })

  it('on server one the grant is refused once the cached document expires', async () => {
    // Within the TTL server one still serves its cached document, which maps
    // `/` to its own Space.
    const cached = await readPhoto({
      server: one,
      signer: bob.signer,
      capability: grant
    })
    assert.equal(cached.statusCode, 200, cached.payload)
    assert.equal(fetchesOn(one), 1)

    await sleep(CACHE_TTL + 100)
    await assertMasked({
      server: one,
      response: await readPhoto({
        server: one,
        signer: bob.signer,
        capability: grant
      })
    })
    assert.equal(fetchesOn(one), 2)
  })
})
