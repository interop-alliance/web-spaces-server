/**
 * DID URL invocation targets naming a `did:webvh` this server stores no log
 * for (Vitest). The DID's document is resolved over the network, through the
 * foreign `did:webvh` resolver, its log served from memory by the injected
 * `peerLogFetcher`, which counts every fetch.
 *
 * The suite pins what the network adds to a DID URL chain:
 *
 * - a root invocation and a delegated chain verify, from one fetch;
 * - nothing is fetched for a request with no credential, a signature that
 *   does not verify, or a signer who is not the invoked capability's
 *   controller, nor for a DID on the blocklist;
 * - a root that does not dereference to the Space the request addresses under
 *   the cached document takes one early fetch, which picks up a repoint, and
 *   no second one within the interval, a budget the key-miss fetch shares;
 * - a pinned first link picks its version from the fetched log, with no second
 *   fetch;
 * - a root that dereferences to another Space here is the masked `not-found`;
 * - an early fetch refused by a remembered failure leaves the budget unspent;
 * - a link pinned to a version after the cached log takes the same early
 *   fetch, under the same budget; a `versionTime` takes none;
 * - a foreign invoker's pre-pass checks the root where that needs no fetch,
 *   so the invoker's log is not fetched at a Space the root does not
 *   dereference to, whichever controller that Space has.
 *
 * The time a failed fetch is remembered is lowered through a mock of the
 * config module, as the peer resolution suite does.
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
import type { DIDLog, ServiceEndpoint, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import type { PeerLogFetcher } from '../src/lib/peerWebvh.js'
import { signedInject } from '../src/testing.js'
import { rootCapabilityId } from '../src/zcap.js'
import {
  bindKey,
  delegate,
  openTempBackend,
  provisionWebvhIdentity,
  startTestServer,
  webvhLogSigner,
  zcapClients,
  pathHandler
} from './helpers.js'

/**
 * How long a failed fetch is remembered in this suite, in milliseconds.
 */
const FAILURE_TTL = 300

// `vi.mock` is hoisted above the constant, so it restates the value.
vi.mock('../src/config.default.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/config.default.js')>()),
  PEER_WEBVH_FAILURE_TTL: 300
}))

/**
 * A `did:webvh` minted on a fake host, with the log the injected fetcher
 * serves for it.
 */
interface ForeignDid {
  did: string
  url: string
  log: DIDLog
  logSigner: Signer
  keyPair: Ed25519VerificationKey
}

/**
 * Lists `keyPair` under every relationship a zcap needs, in the shape
 * `createDID` and `updateDID` take.
 *
 * @param keyPair {Ed25519VerificationKey}
 * @returns {object}
 */
function methodOf(keyPair: Ed25519VerificationKey) {
  return {
    type: 'Multikey',
    publicKeyMultibase: keyPair.publicKeyMultibase!,
    purpose: [
      'authentication',
      'assertionMethod',
      'capabilityInvocation',
      'capabilityDelegation'
    ]
  }
}

describe('DID URL targets on a did:webvh not hosted here', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    server: { fastify: FastifyInstance; serverUrl: string },
    alice: any,
    bob: any,
    rogue: any,
    spaceId: string,
    spaceUrl: string,
    secondSpaceId: string,
    secondSpaceUrl: string

  /**
   * What the injected fetcher serves, by URL.
   */
  const served = new Map<string, Uint8Array>()
  /**
   * Every URL the injected fetcher was asked for, in order.
   */
  const fetched: string[] = []
  const peerLogFetcher: PeerLogFetcher = async ({ url }) => {
    fetched.push(url)
    const answer = served.get(url)
    if (answer === undefined) {
      throw new Error(`No log is served at ${url}.`)
    }
    return answer
  }

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend(),
      peerLogFetcher,
      webvhBlocklist: ['blocked.example']
    }))
    server = { fastify, serverUrl: baseServerUrl }
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
    rogue = (await Ed25519VerificationKey.generate()).didKeySigner()

    spaceId = randomUUID()
    spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).href
    const space = alice.pws.space(spaceId)
    await space.configure({
      name: 'Network Target Space',
      controller: alice.did
    })
    await space.collection('photos').configure({ force: true })
    await space.collection('photos').put('doc-1', { photo: 1 })
    await space.collection('albums').configure({ force: true })
    await space.collection('albums').put('a-1', { album: 1 })

    // A second Space under the same controller.
    secondSpaceId = randomUUID()
    secondSpaceUrl = new URL(`/space/${secondSpaceId}/`, baseServerUrl).href
    const second = alice.pws.space(secondSpaceId)
    await second.configure({ name: 'Second Space', controller: alice.did })
    await second.collection('photos').configure({ force: true })
    await second.collection('photos').put('doc-1', { photo: 'second' })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /**
   * Serves a foreign DID's current log through the injected fetcher.
   *
   * @param foreign {ForeignDid}
   * @returns {void}
   */
  function publish(foreign: ForeignDid): void {
    served.set(
      foreign.url,
      new TextEncoder().encode(logToJsonlString(foreign.log))
    )
  }

  /**
   * Mints a `did:webvh` on `host` with `services`, and serves its log.
   *
   * @param options {object}
   * @param options.host {string}
   * @param options.services {ServiceEndpoint[]}
   * @returns {Promise<ForeignDid>}
   */
  async function mintForeign({
    host,
    services
  }: {
    host: string
    services: ServiceEndpoint[]
  }): Promise<ForeignDid> {
    const updateKeyPair = await Ed25519VerificationKey.generate()
    const logSigner = webvhLogSigner({ keyPair: updateKeyPair })
    const keyPair = await Ed25519VerificationKey.generate()
    const created = await createDID({
      address: `https://${host}/accounts/a1`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [methodOf(keyPair)] as any,
      services
    })
    const foreign = {
      did: created.did,
      url: `https://${host}/accounts/a1/did.jsonl`,
      log: created.log,
      logSigner,
      keyPair: bindKey(keyPair, created.did)
    }
    publish(foreign)
    return foreign
  }

  /**
   * Appends a log entry and serves the longer log.
   *
   * @param options {object}
   * @param options.foreign {ForeignDid}
   * @param [options.services] {ServiceEndpoint[]}   the new services
   * @param [options.keyPair] {Ed25519VerificationKey}   a key that replaces
   *   the DID's key
   * @returns {Promise<void>}
   */
  async function update({
    foreign,
    services,
    keyPair
  }: {
    foreign: ForeignDid
    services?: ServiceEndpoint[]
    keyPair?: Ed25519VerificationKey
  }): Promise<void> {
    const updated = await updateDID({
      log: foreign.log,
      signer: foreign.logSigner,
      ...(services !== undefined && { services }),
      ...(keyPair !== undefined && {
        vmIdFragment: 'multibase',
        verificationMethods: [methodOf(keyPair)] as any
      })
    })
    foreign.log = updated.log
    if (keyPair !== undefined) {
      foreign.keyPair = bindKey(keyPair, foreign.did)
    }
    publish(foreign)
  }

  /**
   * The number of fetches made for one foreign DID's log.
   *
   * @param foreign {ForeignDid}
   * @returns {number}
   */
  function fetchesOf(foreign: ForeignDid): number {
    return fetched.filter(url => url === foreign.url).length
  }

  /**
   * One signed GET of a path under a Space.
   *
   * @param options {object}
   * @param options.path {string}
   * @param options.signer {any}
   * @param options.capability {string | object}
   * @returns {Promise<LightMyRequestResponse>}
   */
  async function get({
    path,
    signer,
    capability
  }: {
    path: string
    signer: any
    capability: string | object
  }): Promise<LightMyRequestResponse> {
    return await signedInject({ server, path, signer, capability })
  }

  /**
   * Asserts a response is the masked `not-found`, byte for byte what a
   * signature by an unrelated key collects at the same path.
   *
   * @param options {object}
   * @param options.response {LightMyRequestResponse}
   * @param options.path {string}
   * @returns {Promise<void>}
   */
  async function assertMasked({
    response,
    path
  }: {
    response: LightMyRequestResponse
    path: string
  }): Promise<void> {
    const baseline = await get({
      path,
      signer: rogue,
      capability: rootCapabilityId(spaceUrl)
    })
    assert.equal(baseline.statusCode, 404)
    assert.equal(response.statusCode, 404, response.payload)
    assert.equal(response.payload, baseline.payload)
  }

  /**
   * The root capability id of a foreign DID's `/` path.
   *
   * @param foreign {ForeignDid}
   * @returns {string}
   */
  function rootOf(foreign: ForeignDid): string {
    return rootCapabilityId(`${foreign.did}/`)
  }

  it('verifies a root invocation and a delegated chain from one fetch', async () => {
    const foreign = await mintForeign({
      host: 'happy.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const path = `/space/${spaceId}/photos/doc-1`
    const asRoot = await get({
      path,
      signer: alice.signer,
      capability: rootOf(foreign)
    })
    assert.equal(asRoot.statusCode, 200, asRoot.payload)
    const grant = await delegate({
      signer: alice.signer,
      capability: rootOf(foreign),
      invocationTarget: `${foreign.did}/photos/`,
      controller: bob.did,
      allowedActions: ['GET']
    })
    const delegated = await get({ path, signer: bob.signer, capability: grant })
    assert.equal(delegated.statusCode, 200, delegated.payload)
    assert.deepEqual(delegated.json(), { photo: 1 })
    assert.equal(fetchesOf(foreign), 1)
  })

  it('fetches nothing for a request whose signature does not authorize it', async () => {
    const foreign = await mintForeign({
      host: 'unsigned.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const path = `/space/${spaceId}/photos/doc-1`

    // No credential at all.
    const anonymous = await fastify.inject({
      method: 'GET',
      url: path,
      headers: { host: new URL(baseServerUrl).host }
    })
    assert.equal(anonymous.statusCode, 404)

    // A signature that does not verify.
    const headers = (await signCapabilityInvocation({
      url: new URL(path, baseServerUrl).href,
      method: 'GET',
      headers: { date: new Date().toUTCString() },
      capability: rootOf(foreign),
      capabilityAction: 'GET',
      invocationSigner: alice.signer
    })) as Record<string, string>
    const tampered = await fastify.inject({
      method: 'GET',
      url: path,
      headers: {
        ...headers,
        authorization: headers.authorization!.replace(
          /signature="[^"]{4}/,
          'signature="AAAA'
        ),
        host: new URL(baseServerUrl).host
      }
    })
    assert.equal(tampered.statusCode, 404)

    // A good signature by a key that is not the root's controller.
    await assertMasked({
      response: await get({ path, signer: rogue, capability: rootOf(foreign) }),
      path
    })
    assert.equal(fetchesOf(foreign), 0)

    // The same root signed by the Space's controller fetches, and verifies.
    const signed = await get({
      path,
      signer: alice.signer,
      capability: rootOf(foreign)
    })
    assert.equal(signed.statusCode, 200, signed.payload)
    assert.equal(fetchesOf(foreign), 1)
  })

  it("fetches no target document in a foreign invoker's pre-pass", async () => {
    // The invoker is a second DID not hosted here. Its pre-pass verifies the
    // chain before the request signature is checked, and dereferences no
    // target; its own log is fetched for the signature, as before.
    const target = await mintForeign({
      host: 'prepass-target.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const invoker = await mintForeign({
      host: 'prepass-invoker.example',
      services: []
    })
    const grant = await delegate({
      signer: alice.signer,
      capability: rootOf(target),
      invocationTarget: `${target.did}/photos/`,
      controller: invoker.did,
      allowedActions: ['GET']
    })
    const path = `/space/${spaceId}/photos/doc-1`
    const headers = (await signCapabilityInvocation({
      url: new URL(path, baseServerUrl).href,
      method: 'GET',
      headers: { date: new Date().toUTCString() },
      capability: grant,
      capabilityAction: 'GET',
      invocationSigner: invoker.keyPair.signer()
    })) as Record<string, string>
    const tampered = await fastify.inject({
      method: 'GET',
      url: path,
      headers: {
        ...headers,
        authorization: headers.authorization!.replace(
          /signature="[^"]{4}/,
          'signature="AAAA'
        ),
        host: new URL(baseServerUrl).host
      }
    })
    assert.equal(tampered.statusCode, 404)
    assert.equal(fetchesOf(invoker), 1)
    assert.equal(fetchesOf(target), 0)

    const signed = await get({
      path,
      signer: invoker.keyPair.signer(),
      capability: grant
    })
    assert.equal(signed.statusCode, 200, signed.payload)
    assert.equal(fetchesOf(target), 1)
  })

  it('refuses a DID on a blocklisted host with no fetch (404)', async () => {
    const foreign = await mintForeign({
      host: 'blocked.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const path = `/space/${spaceId}/photos/doc-1`
    await assertMasked({
      response: await get({
        path,
        signer: alice.signer,
        capability: rootOf(foreign)
      }),
      path
    })
    assert.equal(fetchesOf(foreign), 0)
  })

  it('refuses a root that dereferences to another Space here, from one fetch (404)', async () => {
    const foreign = await mintForeign({
      host: 'elsewhere.example',
      services: [pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl })]
    })
    const path = `/space/${spaceId}/photos/doc-1`
    await assertMasked({
      response: await get({
        path,
        signer: alice.signer,
        capability: rootOf(foreign)
      }),
      path
    })
    // This request fetched the log itself, so the mismatch fetched no more.
    assert.equal(fetchesOf(foreign), 1)
  })

  it('picks up a repoint with one early fetch, and takes no second one', async () => {
    const foreign = await mintForeign({
      host: 'repoint.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const atFirst = await get({
      path: `/space/${spaceId}/photos/doc-1`,
      signer: alice.signer,
      capability: rootOf(foreign)
    })
    assert.equal(atFirst.statusCode, 200, atFirst.payload)
    assert.equal(fetchesOf(foreign), 1)

    await update({
      foreign,
      services: [pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl })]
    })
    // The cached document still maps `/` to the first Space; the mismatch
    // fetches the log once more and the repoint is read.
    const atSecond = await get({
      path: `/space/${secondSpaceId}/photos/doc-1`,
      signer: alice.signer,
      capability: rootOf(foreign)
    })
    assert.equal(atSecond.statusCode, 200, atSecond.payload)
    assert.deepEqual(atSecond.json(), { photo: 'second' })
    assert.equal(fetchesOf(foreign), 2)

    // Back at the first Space, the mismatch finds the budget spent.
    const path = `/space/${spaceId}/photos/doc-1`
    await assertMasked({
      response: await get({
        path,
        signer: alice.signer,
        capability: rootOf(foreign)
      }),
      path
    })
    assert.equal(fetchesOf(foreign), 2)
  })

  it('shares the early fetch with the key-miss fetch', async () => {
    // The DID also invokes: Alice delegates to it under its own DID URL
    // root, and it signs with its own key.
    const foreign = await mintForeign({
      host: 'shared-budget.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const grant = await delegate({
      signer: alice.signer,
      capability: rootOf(foreign),
      invocationTarget: `${foreign.did}/photos/`,
      controller: foreign.did,
      allowedActions: ['GET']
    })
    /**
     * The DID's own GET of `photos/doc-1` in a Space, under the grant.
     *
     * @param atSpaceId {string}
     * @returns {Promise<LightMyRequestResponse>}
     */
    async function readAs(atSpaceId: string): Promise<LightMyRequestResponse> {
      return await get({
        path: `/space/${atSpaceId}/photos/doc-1`,
        signer: foreign.keyPair.signer(),
        capability: grant
      })
    }
    const first = await readAs(spaceId)
    assert.equal(first.statusCode, 200, first.payload)
    assert.equal(fetchesOf(foreign), 1)

    // A new key the cached document lacks: the key-miss fetch.
    await update({
      foreign,
      keyPair: await Ed25519VerificationKey.generate()
    })
    const rotated = await readAs(spaceId)
    assert.equal(rotated.statusCode, 200, rotated.payload)
    assert.equal(fetchesOf(foreign), 2)

    // A repoint now finds the interval's early fetch spent.
    await update({
      foreign,
      services: [pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl })]
    })
    const repointed = await readAs(secondSpaceId)
    assert.equal(repointed.statusCode, 404, repointed.payload)
    assert.equal(fetchesOf(foreign), 2)
  })

  it('picks a pinned first link version from the fetched log', async () => {
    const foreign = await mintForeign({
      host: 'pinned.example',
      services: [
        pathHandler({ path: '/', serviceEndpoint: spaceUrl }),
        pathHandler({ path: '/pics', serviceEndpoint: `${spaceUrl}photos/` })
      ]
    })
    await update({
      foreign,
      services: [
        pathHandler({ path: '/', serviceEndpoint: spaceUrl }),
        pathHandler({ path: '/pics', serviceEndpoint: `${spaceUrl}albums/` })
      ]
    })
    const grant = await delegate({
      signer: alice.signer,
      capability: rootOf(foreign),
      invocationTarget: `${foreign.did}/pics/?versionNumber=1`,
      controller: bob.did,
      allowedActions: ['GET']
    })
    const read = await get({
      path: `/space/${spaceId}/photos/doc-1`,
      signer: bob.signer,
      capability: grant
    })
    assert.equal(read.statusCode, 200, read.payload)
    const path = `/space/${spaceId}/albums/a-1`
    await assertMasked({
      response: await get({ path, signer: bob.signer, capability: grant }),
      path
    })
    assert.equal(fetchesOf(foreign), 1)
  })
  it('leaves the early fetch unspent when a remembered failure refuses it', async () => {
    const foreign = await mintForeign({
      host: 'failed-first.example',
      services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
    })
    const log = served.get(foreign.url)!
    served.delete(foreign.url)
    // The first fetch fails and is remembered; the early fetch the failed
    // dereference asks for is refused by that memory, before any fetch.
    const path = `/space/${spaceId}/photos/doc-1`
    await assertMasked({
      response: await get({
        path,
        signer: alice.signer,
        capability: rootOf(foreign)
      }),
      path
    })
    assert.equal(fetchesOf(foreign), 1)

    served.set(foreign.url, log)
    await new Promise(resolve => setTimeout(resolve, FAILURE_TTL + 100))
    const served200 = await get({
      path,
      signer: alice.signer,
      capability: rootOf(foreign)
    })
    assert.equal(served200.statusCode, 200, served200.payload)
    assert.equal(fetchesOf(foreign), 2)

    // The interval's early fetch is still there for a repoint.
    await update({
      foreign,
      services: [pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl })]
    })
    const repointed = await get({
      path: `/space/${secondSpaceId}/photos/doc-1`,
      signer: alice.signer,
      capability: rootOf(foreign)
    })
    assert.equal(repointed.statusCode, 200, repointed.payload)
    assert.equal(fetchesOf(foreign), 3)
  })
  describe('a pin to a version after the cached log', () => {
    /**
     * A foreign DID mapping `/` to the Space and `/pics` to its `photos`
     * Collection, its document cached here by one root invocation.
     *
     * @param host {string}
     * @returns {Promise<ForeignDid>}
     */
    async function cachedForeign(host: string): Promise<ForeignDid> {
      const foreign = await mintForeign({
        host,
        services: [
          pathHandler({ path: '/', serviceEndpoint: spaceUrl }),
          pathHandler({ path: '/pics', serviceEndpoint: `${spaceUrl}photos/` })
        ]
      })
      const warm = await get({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: alice.signer,
        capability: rootOf(foreign)
      })
      assert.equal(warm.statusCode, 200, warm.payload)
      assert.equal(fetchesOf(foreign), 1)
      return foreign
    }

    /**
     * Bob's GET of a path under a grant whose first link is pinned.
     *
     * @param options {object}
     * @param options.foreign {ForeignDid}
     * @param options.target {string}   the pinned DID URL target
     * @param options.path {string}
     * @returns {Promise<LightMyRequestResponse>}
     */
    async function readPinned({
      foreign,
      target,
      path
    }: {
      foreign: ForeignDid
      target: string
      path: string
    }): Promise<LightMyRequestResponse> {
      const grant = await delegate({
        signer: alice.signer,
        capability: rootOf(foreign),
        invocationTarget: target,
        controller: bob.did,
        allowedActions: ['GET']
      })
      return await get({ path, signer: bob.signer, capability: grant })
    }

    it('reads a version published after the cache was filled, through one early fetch', async () => {
      const foreign = await cachedForeign('pin-new.example')
      await update({
        foreign,
        services: [
          pathHandler({ path: '/', serviceEndpoint: spaceUrl }),
          pathHandler({ path: '/pics', serviceEndpoint: `${spaceUrl}albums/` })
        ]
      })
      const read = await readPinned({
        foreign,
        target: `${foreign.did}/pics/?versionNumber=2`,
        path: `/space/${spaceId}/albums/a-1`
      })
      assert.equal(read.statusCode, 200, read.payload)
      assert.deepEqual(read.json(), { album: 1 })
      assert.equal(fetchesOf(foreign), 2)
    })

    it('refuses a pin whose early fetch shows the root moved away', async () => {
      const foreign = await cachedForeign('pin-moved.example')
      const pics = pathHandler({
        path: '/pics',
        serviceEndpoint: `${spaceUrl}albums/`
      })
      await update({
        foreign,
        services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl }), pics]
      })
      await update({
        foreign,
        services: [
          pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl }),
          pics
        ]
      })
      // The cached log still maps the root to the Space. Version 2 maps the
      // pinned link beneath it, and the current version maps the root
      // elsewhere.
      const path = `/space/${spaceId}/albums/a-1`
      await assertMasked({
        response: await readPinned({
          foreign,
          target: `${foreign.did}/pics/?versionNumber=2`,
          path
        }),
        path
      })
      assert.equal(fetchesOf(foreign), 2)
    })

    it('costs a bogus pin at most one early fetch per interval', async () => {
      const foreign = await cachedForeign('pin-bogus.example')
      const path = `/space/${spaceId}/photos/doc-1`
      for (const expectedFetches of [2, 2]) {
        await assertMasked({
          response: await readPinned({
            foreign,
            target: `${foreign.did}/pics/?versionNumber=99`,
            path
          }),
          path
        })
        assert.equal(fetchesOf(foreign), expectedFetches)
      }
      // A versionId whose number is past the log also finds it spent.
      await assertMasked({
        response: await readPinned({
          foreign,
          target: `${foreign.did}/pics/?versionId=7-zNotAnEntry`,
          path
        }),
        path
      })
      assert.equal(fetchesOf(foreign), 2)
    })

    it('shares the early fetch with a root mismatch', async () => {
      const foreign = await cachedForeign('pin-shared.example')
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await readPinned({
          foreign,
          target: `${foreign.did}/pics/?versionNumber=5`,
          path
        }),
        path
      })
      assert.equal(fetchesOf(foreign), 2)
      // A repoint is not picked up until the interval passes.
      await update({
        foreign,
        services: [pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl })]
      })
      const repointed = await get({
        path: `/space/${secondSpaceId}/photos/doc-1`,
        signer: alice.signer,
        capability: rootOf(foreign)
      })
      assert.equal(repointed.statusCode, 404, repointed.payload)
      assert.equal(fetchesOf(foreign), 2)
    })

    it('answers a versionTime after the cached log from the cache', async () => {
      const foreign = await cachedForeign('pin-time.example')
      const read = await readPinned({
        foreign,
        target: `${foreign.did}/pics/?versionTime=2099-01-01T00:00:00Z`,
        path: `/space/${spaceId}/photos/doc-1`
      })
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(fetchesOf(foreign), 1)
    })
  })

  describe("a foreign invoker's pre-pass checks the root without a fetch", () => {
    let otherControllerSpaceId: string

    beforeAll(async () => {
      otherControllerSpaceId = randomUUID()
      await bob.pws
        .space(otherControllerSpaceId)
        .configure({ name: "Bob's Space", controller: bob.did })
    })

    /**
     * A foreign invoker, never seen here, and Alice's DID URL grant to it
     * under `root`.
     *
     * @param options {object}
     * @param options.host {string}
     * @param options.root {string}   the DID URL the grant roots in, ending
     *   in `/`
     * @returns {Promise<{ invoker: ForeignDid, grant: any }>}
     */
    async function invokerWithGrant({
      host,
      root
    }: {
      host: string
      root: string
    }): Promise<{ invoker: ForeignDid; grant: any }> {
      const invoker = await mintForeign({ host, services: [] })
      const grant = await delegate({
        signer: alice.signer,
        capability: rootCapabilityId(root),
        invocationTarget: `${root}photos/`,
        controller: invoker.did,
        allowedActions: ['GET']
      })
      return { invoker, grant }
    }

    /**
     * The invoker's own GET of `photos/doc-1` in a Space, under its grant.
     *
     * @param options {object}
     * @param options.invoker {ForeignDid}
     * @param options.grant {any}
     * @param options.atSpaceId {string}
     * @returns {Promise<LightMyRequestResponse>}
     */
    async function readAs({
      invoker,
      grant,
      atSpaceId
    }: {
      invoker: ForeignDid
      grant: any
      atSpaceId: string
    }): Promise<LightMyRequestResponse> {
      return await get({
        path: `/space/${atSpaceId}/photos/doc-1`,
        signer: invoker.keyPair.signer(),
        capability: grant
      })
    }

    /**
     * Presents the grant at an absent Space id, at another controller's
     * Space and at the second Space of Alice's, each a masked 404.
     *
     * @param options {object}
     * @param options.invoker {ForeignDid}
     * @param options.grant {any}
     * @returns {Promise<void>}
     */
    async function probe({
      invoker,
      grant
    }: {
      invoker: ForeignDid
      grant: any
    }): Promise<void> {
      for (const atSpaceId of [
        randomUUID(),
        otherControllerSpaceId,
        secondSpaceId
      ]) {
        const response = await readAs({ invoker, grant, atSpaceId })
        assert.equal(response.statusCode, 404, response.payload)
      }
    }

    it('fetches no invoker log where a cached target root dereferences elsewhere, once the early fetch is spent', async () => {
      const target = await mintForeign({
        host: 'probe-target.example',
        services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
      })
      // The target's document goes into the cache.
      const warm = await get({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: alice.signer,
        capability: rootOf(target)
      })
      assert.equal(warm.statusCode, 200, warm.payload)
      assert.equal(fetchesOf(target), 1)

      // While the target's early fetch is unspent, a cached mismatch is left
      // to the full verification, which may fetch the document once more as
      // after a move. That pass fetches this invoker's log, and spends the
      // early fetch.
      const first = await invokerWithGrant({
        host: 'probe-first.example',
        root: `${target.did}/`
      })
      await probe(first)
      assert.equal(fetchesOf(first.invoker), 1)
      assert.equal(fetchesOf(target), 2)

      // From then on the pre-pass refuses at the second Space too.
      const second = await invokerWithGrant({
        host: 'probe-second.example',
        root: `${target.did}/`
      })
      await probe(second)
      assert.equal(fetchesOf(second.invoker), 0)
      assert.equal(fetchesOf(target), 2)

      // At the Space the root dereferences to, it is fetched and verifies.
      const read = await readAs({ ...second, atSpaceId: spaceId })
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(fetchesOf(second.invoker), 1)
    })

    it('fetches no invoker log where a self-hosted target root dereferences elsewhere', async () => {
      const { did: target } = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
      })
      const probed = await invokerWithGrant({
        host: 'probe-local.example',
        root: `${target}/`
      })
      await probe(probed)
      assert.equal(fetchesOf(probed.invoker), 0)
      const read = await readAs({ ...probed, atSpaceId: spaceId })
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(fetchesOf(probed.invoker), 1)
    })

    it('still admits a foreign invoker after a move', async () => {
      const target = await mintForeign({
        host: 'probe-move.example',
        services: [pathHandler({ path: '/', serviceEndpoint: spaceUrl })]
      })
      const moving = await invokerWithGrant({
        host: 'probe-mover.example',
        root: `${target.did}/`
      })
      const before = await readAs({ ...moving, atSpaceId: spaceId })
      assert.equal(before.statusCode, 200, before.payload)
      assert.equal(fetchesOf(target), 1)
      await update({
        foreign: target,
        services: [pathHandler({ path: '/', serviceEndpoint: secondSpaceUrl })]
      })
      // The cached document still maps `/` to the first Space. The pre-pass
      // leaves that to the full verification, which fetches it once more.
      const after = await readAs({ ...moving, atSpaceId: secondSpaceId })
      assert.equal(after.statusCode, 200, after.payload)
      assert.equal(fetchesOf(target), 2)
    })
  })
})
