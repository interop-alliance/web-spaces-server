/**
 * Network resolution of a foreign `did:webvh` (Vitest).
 *
 * A Space controller delegates a capability to a `did:webvh` on another host:
 * a peer server's own DID, `did:webvh:<scid>:<host>:space:server:id`, or a
 * service's DID under any path or none. The holder invokes it signing as
 * `{did}#{key}`. The serving server fetches the log from the URL the method
 * maps the DID to (`https://<host>/<path>/did.jsonl`, or
 * `https://<host>/.well-known/did.jsonl`), but only once the delegation chain
 * naming that DID as invoker has verified to the Space controller, and only
 * for a DID the operator's blocklist does not name.
 *
 * The peer log fetch goes through the injected `peerLogFetcher`, which serves
 * minted logs from memory and counts every fetch, so the suite can assert
 * both what verifies and what never causes a fetch. The tunables are lowered
 * through a mock of the config module, so the TTL and timeout cases run in
 * well under a few seconds. The default fetcher's own bounds (scheme, port,
 * address ranges, redirects, size, timeout) are unit-tested at the end.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { Agent } from 'undici'
import {
  createDID,
  logToJsonlString,
  updateDID
} from '@interop/did-method-webvh'
import type { DIDLog, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import { ProblemTypes } from '@interop/storage-core'

import { parseWebvhBlocklist } from '../src/config.default.js'
import { createApp } from '../src/server.js'
import { spaceMetaPath, spaceRevocationsPath } from '../src/lib/paths.js'
import { compileWebvhBlocklist } from '../src/lib/webvhBlocklist.js'
import {
  assertPublicAddresses,
  checkPeerLogUrl,
  fetchPeerLog,
  readBoundedResponse,
  type PeerLogFetcher
} from '../src/lib/peerWebvh.js'
import {
  bindKey,
  client,
  delegate,
  openTempBackend,
  requestError,
  rootZcap,
  startTestServer,
  webvhLogSigner,
  zcapClients,
  sleep
} from './helpers.js'

vi.mock('../src/config.default.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/config.default.js')>()),
  PEER_WEBVH_CACHE_TTL: 1_500,
  PEER_WEBVH_FAILURE_TTL: 60_000,
  PEER_WEBVH_FETCH_TIMEOUT_MS: 1_000,
  PEER_WEBVH_LOG_MAX_BYTES: 32 * 1024,
  PEER_WEBVH_HOST_FETCH_LIMIT: 3,
  PEER_WEBVH_MAX_CONCURRENT_FETCHES: 2
}))

/**
 * A minted peer server identity on a fake host, with the log the injected
 * fetcher currently serves for it.
 */
interface Peer {
  host: string
  // the log URL the DID maps to
  url: string
  did: string
  log: DIDLog
  logSigner: Signer
  keyPair: Ed25519VerificationKey
}

/**
 * A promise the test settles by hand, to hold an injected fetch open.
 * @returns {{ promise: Promise<void>, open: () => void }}
 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

/**
 * Waits until `check` holds, polling, for at most two seconds.
 * @param check {() => boolean}
 * @returns {Promise<void>}
 */
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!check()) {
    assert.ok(performance.now() < deadline, 'the condition never held')
    await sleep(10)
  }
}

/**
 * Lists `keyPair` in a log entry under `purpose`, in the shape `createDID`
 * and `updateDID` take.
 * @param keyPair {Ed25519VerificationKey}
 * @param purpose {string[]}
 * @returns {object}
 */
function methodOf(keyPair: Ed25519VerificationKey, purpose: string[]) {
  return {
    type: 'Multikey',
    publicKeyMultibase: keyPair.publicKeyMultibase!,
    purpose
  }
}

describe('peer server did:webvh resolution', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any, bob: any

  /**
   * What the injected fetcher serves, by URL. A function value lets a case
   * stall or misbehave.
   */
  const served = new Map<
    string,
    | Uint8Array
    | ((options: { maxBytes: number; signal: AbortSignal }) => Promise<any>)
  >()
  /**
   * Every URL the injected fetcher was asked for, in order.
   */
  const fetched: string[] = []
  const peerLogFetcher: PeerLogFetcher = async ({ url, maxBytes, signal }) => {
    fetched.push(url)
    const answer = served.get(url)
    if (answer === undefined) {
      throw new Error(`No peer log is served at ${url}.`)
    }
    if (typeof answer === 'function') {
      return await answer({ maxBytes, signal })
    }
    return answer
  }

  const spaceId = randomUUID()
  let spaceUrl: string, docUrl: string

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend(),
      peerLogFetcher
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
    spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    docUrl = new URL(
      `/space/${spaceId}/credentials/doc-1`,
      baseServerUrl
    ).toString()
    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Replicated Space', controller: alice.did })
    await space.collection('credentials').configure({ force: true })
    await space.collection('credentials').put('doc-1', { hello: 'world' })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /**
   * The number of fetches made for one URL.
   * @param url {string}
   * @returns {number}
   */
  function fetchesOf(url: string): number {
    return fetched.filter(entry => entry === url).length
  }

  /**
   * The peer log URL the server fetches for a host.
   * @param host {string}
   * @returns {string}
   */
  function logUrlOf(host: string): string {
    return `https://${host}/space/server/id/did.jsonl`
  }

  /**
   * Serves a peer's current log through the injected fetcher.
   * @param peer {Peer}
   * @returns {void}
   */
  function publish(peer: Peer): void {
    served.set(peer.url, new TextEncoder().encode(logToJsonlString(peer.log)))
  }

  /**
   * Mints a peer server identity at `address` and serves its log.
   * @param options {object}
   * @param options.host {string}   the fake host the log is served for
   * @param [options.path] {string}   the DID path, `space/server/id` by
   *   default; the empty string mints the host-only form
   * @param [options.purpose] {string[]}   the relationships the key is under
   * @param [options.address] {string}   overrides the address the DID is minted at
   * @param [options.witness] {object}   the log's `witness` parameter
   * @returns {Promise<Peer>}
   */
  async function mintPeer({
    host,
    path = 'space/server/id',
    purpose = ['assertionMethod', 'capabilityInvocation'],
    address = path === '' ? `https://${host}` : `https://${host}/${path}`,
    witness
  }: {
    host: string
    path?: string
    purpose?: string[]
    address?: string
    witness?: { threshold: number; witnesses: { id: string }[] }
  }): Promise<Peer> {
    const updateKeyPair = await Ed25519VerificationKey.generate()
    const logSigner = webvhLogSigner({ keyPair: updateKeyPair })
    const keyPair = await Ed25519VerificationKey.generate()
    const created = await createDID({
      address,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [methodOf(keyPair, purpose)] as any,
      ...(witness !== undefined && { witness })
    })
    const peer = {
      host,
      url:
        path === ''
          ? `https://${host}/.well-known/did.jsonl`
          : `https://${host}/${path}/did.jsonl`,
      did: created.did,
      log: created.log,
      logSigner,
      keyPair: bindKey(keyPair, created.did)
    }
    publish(peer)
    return peer
  }

  /**
   * Appends a log entry listing exactly `keyPairs` under the peer key's
   * relationships, and serves the longer log.
   * @param peer {Peer}
   * @param keyPairs {Ed25519VerificationKey[]}
   * @returns {Promise<void>}
   */
  async function rotate(
    peer: Peer,
    keyPairs: Ed25519VerificationKey[]
  ): Promise<void> {
    const updated = await updateDID({
      log: peer.log,
      signer: peer.logSigner,
      vmIdFragment: 'multibase',
      verificationMethods: keyPairs.map(keyPair =>
        methodOf(keyPair, ['assertionMethod', 'capabilityInvocation'])
      ) as any
    })
    peer.log = updated.log
    for (const keyPair of keyPairs) {
      bindKey(keyPair, peer.did)
    }
    publish(peer)
  }

  /**
   * Alice delegates a read of her Space to `controller`.
   * @param controller {string}
   * @returns {Promise<any>}
   */
  async function grantTo(controller: string): Promise<any> {
    return delegate({
      signer: alice.signer,
      capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
      invocationTarget: spaceUrl,
      controller,
      allowedActions: ['GET']
    })
  }

  /**
   * Reads the Resource under `capability`, signing with `keyPair`.
   * @param options {object}
   * @param options.keyPair {Ed25519VerificationKey}
   * @param options.capability {any}
   * @returns {Promise<any>}
   */
  async function read({
    keyPair,
    capability
  }: {
    keyPair: Ed25519VerificationKey
    capability: any
  }): Promise<any> {
    return client({ signer: keyPair.signer() as any }).request({
      url: docUrl,
      method: 'GET',
      action: 'GET',
      capability
    })
  }

  /**
   * Asserts a request was refused with the masked `not-found`.
   * @param promise {Promise<unknown>}
   * @returns {Promise<void>}
   */
  async function assertMasked(promise: Promise<unknown>): Promise<void> {
    const err = await requestError(promise)
    assert.equal(err.status, 404)
    assert.equal(err.data.type, ProblemTypes.NOT_FOUND)
  }

  describe('a verified chain', () => {
    it('lets a peer DID invoke, and fetches its log once', async () => {
      const peer = await mintPeer({ host: 'peer-ok.example' })
      assert.match(
        peer.did,
        /^did:webvh:[^:]+:peer-ok\.example:space:server:id$/
      )
      const zcap = await grantTo(peer.did)

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await read({ keyPair: peer.keyPair, capability: zcap })
        assert.equal(response.status, 200)
        assert.deepStrictEqual(response.data, { hello: 'world' })
      }
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('fetches once more on a key miss, and not again within the interval', async () => {
      const peer = await mintPeer({ host: 'peer-miss.example' })
      const zcap = await grantTo(peer.did)
      assert.equal(
        (await read({ keyPair: peer.keyPair, capability: zcap })).status,
        200
      )
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)

      // The admin adds a key; a signature with it misses the cached document.
      const added = await Ed25519VerificationKey.generate()
      await rotate(peer, [peer.keyPair, added])
      assert.equal(
        (await read({ keyPair: added, capability: zcap })).status,
        200
      )
      assert.equal(fetchesOf(logUrlOf(peer.host)), 2)

      // A key the log never lists misses again, inside the interval.
      const unknown = bindKey(await Ed25519VerificationKey.generate(), peer.did)
      await assertMasked(read({ keyPair: unknown, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 2)
    })

    it('drops a retired key once the cached document expires', async () => {
      const peer = await mintPeer({ host: 'peer-ttl.example' })
      const zcap = await grantTo(peer.did)
      assert.equal(
        (await read({ keyPair: peer.keyPair, capability: zcap })).status,
        200
      )
      const retired = peer.keyPair
      const replacement = await Ed25519VerificationKey.generate()
      await rotate(peer, [replacement])

      // Within the TTL the cached document still lists the retired key.
      assert.equal(
        (await read({ keyPair: retired, capability: zcap })).status,
        200
      )
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)

      await sleep(1_600)
      await assertMasked(read({ keyPair: retired, capability: zcap }))
      // The TTL fetch is the only one: a miss right after a fetch forces none.
      assert.equal(fetchesOf(logUrlOf(peer.host)), 2)
      assert.equal(
        (await read({ keyPair: replacement, capability: zcap })).status,
        200
      )
      assert.equal(fetchesOf(logUrlOf(peer.host)), 2)
    })

    it('refuses an older prefix of a log it already verified', async () => {
      const peer = await mintPeer({ host: 'peer-prefix.example' })
      const genesis = peer.log
      const original = peer.keyPair
      const replacement = await Ed25519VerificationKey.generate()
      await rotate(peer, [replacement])
      const zcap = await grantTo(peer.did)
      assert.equal(
        (await read({ keyPair: replacement, capability: zcap })).status,
        200
      )

      // The host now serves the genesis entry alone, which lists the retired
      // key. The key miss fetches it, and the head check refuses it.
      peer.log = genesis
      publish(peer)
      await assertMasked(read({ keyPair: original, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 2)
    })

    it('refuses a key not listed under capabilityInvocation', async () => {
      const peer = await mintPeer({
        host: 'peer-assert.example',
        purpose: ['assertionMethod']
      })
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('refuses a log that does not verify', async () => {
      const peer = await mintPeer({ host: 'peer-tampered.example' })
      const [first, ...rest] = logToJsonlString(peer.log).split('\n')
      const entry = JSON.parse(first!)
      entry.versionTime = '2020-01-01T00:00:00Z'
      served.set(
        logUrlOf(peer.host),
        new TextEncoder().encode([JSON.stringify(entry), ...rest].join('\n'))
      )
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('refuses the log of another DID (a wrong SCID)', async () => {
      const peer = await mintPeer({ host: 'peer-scid.example' })
      const other = await mintPeer({ host: 'peer-scid.example' })
      // The host serves the other DID's log at the one URL both share.
      assert.notEqual(peer.did, other.did)
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('refuses an oversize log, and remembers the failure', async () => {
      const peer = await mintPeer({ host: 'peer-big.example' })
      served.set(logUrlOf(peer.host), async ({ maxBytes }) => {
        return new Uint8Array(maxBytes + 1)
      })
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('refuses a fetch that outlasts the timeout', async () => {
      const peer = await mintPeer({ host: 'peer-slow.example' })
      // Ignores the abort signal; the resolver's own deadline cuts it off.
      served.set(logUrlOf(peer.host), () => new Promise(() => {}))
      const zcap = await grantTo(peer.did)
      const started = performance.now()
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.ok(performance.now() - started < 3_000)
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('limits fetches per host', async () => {
      const host = 'peer-busy.example'
      const outcomes: number[] = []
      for (let index = 0; index < 4; index++) {
        const peer = await mintPeer({ host })
        const zcap = await grantTo(peer.did)
        try {
          outcomes.push(
            (await read({ keyPair: peer.keyPair, capability: zcap })).status
          )
        } catch (err: any) {
          outcomes.push(err.status)
        }
      }
      assert.deepStrictEqual(outcomes, [200, 200, 200, 404])
      assert.equal(fetchesOf(logUrlOf(host)), 3)
    })

    it('refreshes a verified DID after DIDs nobody verified use up its host window', async () => {
      const host = 'peer-victim.example'
      const victim = await mintPeer({ host })
      const victimLog = served.get(logUrlOf(host))!
      const victimZcap = await grantTo(victim.did)
      assert.equal(
        (await read({ keyPair: victim.keyPair, capability: victimZcap }))
          .status,
        200
      )

      // Any Space owner can delegate to fresh DIDs on the victim's host. The
      // host serves only its own log, so each of them fails to verify.
      const attackers: { peer: Peer; zcap: any }[] = []
      for (let index = 0; index < 3; index++) {
        const peer = await mintPeer({ host })
        attackers.push({ peer, zcap: await grantTo(peer.did) })
      }
      served.set(logUrlOf(host), victimLog)
      for (const { peer, zcap } of attackers) {
        await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      }
      // The victim's first fetch and two attacker fetches fill the window;
      // the third attacker DID is refused without a fetch.
      assert.equal(fetchesOf(logUrlOf(host)), 3)

      await sleep(1_600)
      assert.equal(
        (await read({ keyPair: victim.keyPair, capability: victimZcap }))
          .status,
        200
      )
      assert.equal(fetchesOf(logUrlOf(host)), 4)
    })

    it('limits concurrent first-contact fetches, and still refreshes a verified DID', async () => {
      const known = await mintPeer({ host: 'peer-known.example' })
      const knownZcap = await grantTo(known.did)
      assert.equal(
        (await read({ keyPair: known.keyPair, capability: knownZcap })).status,
        200
      )
      await sleep(1_600)

      const held = gate()
      const holding: { peer: Peer; zcap: any }[] = []
      for (const host of ['peer-hold-1.example', 'peer-hold-2.example']) {
        const peer = await mintPeer({ host })
        const bytes = served.get(logUrlOf(host))!
        served.set(logUrlOf(host), async () => {
          await held.promise
          return bytes
        })
        holding.push({ peer, zcap: await grantTo(peer.did) })
      }
      const third = await mintPeer({ host: 'peer-hold-3.example' })
      const thirdZcap = await grantTo(third.did)

      const pending = holding.map(({ peer, zcap }) =>
        read({ keyPair: peer.keyPair, capability: zcap })
      )
      await until(() =>
        holding.every(({ peer }) => fetchesOf(logUrlOf(peer.host)) === 1)
      )
      try {
        await assertMasked(
          read({ keyPair: third.keyPair, capability: thirdZcap })
        )
        assert.equal(fetchesOf(logUrlOf(third.host)), 0)
        // The stale known DID is refreshed on its own budget.
        assert.equal(
          (await read({ keyPair: known.keyPair, capability: knownZcap }))
            .status,
          200
        )
        assert.equal(fetchesOf(logUrlOf(known.host)), 2)
      } finally {
        held.open()
      }
      for (const response of await Promise.all(pending)) {
        assert.equal(response.status, 200)
      }
    })

    it('shares one in-flight fetch among concurrent requests', async () => {
      const peer = await mintPeer({ host: 'peer-shared.example' })
      const bytes = served.get(logUrlOf(peer.host))!
      const held = gate()
      served.set(logUrlOf(peer.host), async () => {
        await held.promise
        return bytes
      })
      const zcap = await grantTo(peer.did)
      const reads = [0, 1, 2].map(() =>
        read({ keyPair: peer.keyPair, capability: zcap })
      )
      await until(() => fetchesOf(logUrlOf(peer.host)) === 1)
      await sleep(150)
      held.open()
      for (const response of await Promise.all(reads)) {
        assert.equal(response.status, 200)
      }
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('shares one in-flight fetch that fails among concurrent requests', async () => {
      const peer = await mintPeer({ host: 'peer-shared-fail.example' })
      const held = gate()
      served.set(logUrlOf(peer.host), async () => {
        await held.promise
        throw new Error('The peer host is down.')
      })
      const zcap = await grantTo(peer.did)
      const reads = [0, 1, 2].map(() =>
        assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      )
      await until(() => fetchesOf(logUrlOf(peer.host)) === 1)
      await sleep(150)
      held.open()
      await Promise.all(reads)
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('refuses a log that declares witnesses', async () => {
      const witnessKey = await Ed25519VerificationKey.generate()
      const peer = await mintPeer({
        host: 'peer-witnessed.example',
        witness: {
          threshold: 1,
          witnesses: [{ id: `did:key:${witnessKey.fingerprint()}` }]
        }
      })
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 1)
    })

    it('lets a DID under any other path invoke, fetched from its mapped URL', async () => {
      const agent = await mintPeer({
        host: 'agent-path.example',
        path: 'agents/a1',
        purpose: ['capabilityInvocation']
      })
      assert.match(agent.did, /^did:webvh:[^:]+:agent-path\.example:agents:a1$/)
      const zcap = await grantTo(agent.did)
      const response = await read({ keyPair: agent.keyPair, capability: zcap })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
      assert.deepStrictEqual(
        fetched.filter(url => url.includes(agent.host)),
        ['https://agent-path.example/agents/a1/did.jsonl']
      )
    })

    it('lets a host-only DID invoke, fetched from .well-known', async () => {
      const agent = await mintPeer({
        host: 'agent-root.example',
        path: '',
        purpose: ['capabilityInvocation']
      })
      assert.match(agent.did, /^did:webvh:[^:]+:agent-root\.example$/)
      const zcap = await grantTo(agent.did)
      const response = await read({ keyPair: agent.keyPair, capability: zcap })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(
        fetched.filter(url => url.includes(agent.host)),
        ['https://agent-root.example/.well-known/did.jsonl']
      )
    })

    it('records a foreign invoker as createdBy', async () => {
      const agent = await mintPeer({
        host: 'agent-writer.example',
        path: 'agents/w1'
      })
      const zcap = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: agent.did,
        allowedActions: ['GET', 'PUT']
      })
      const written = await client({
        signer: agent.keyPair.signer() as any
      }).request({
        url: new URL(
          `/space/${spaceId}/credentials/by-agent`,
          baseServerUrl
        ).toString(),
        method: 'PUT',
        action: 'PUT',
        capability: zcap,
        json: { from: 'agent' }
      })
      assert.equal(written.status, 201)
      assert.deepEqual((written.data as any).createdBy, [agent.did])
    })

    it('refuses a write under a read-only delegation', async () => {
      const peer = await mintPeer({ host: 'peer-write.example' })
      const zcap = await grantTo(peer.did)
      assert.equal(
        (await read({ keyPair: peer.keyPair, capability: zcap })).status,
        200
      )
      await assertMasked(
        client({ signer: peer.keyPair.signer() as any }).request({
          url: docUrl,
          method: 'PUT',
          action: 'PUT',
          capability: zcap,
          json: { hello: 'peer' }
        })
      )
      assert.deepStrictEqual(
        await alice.pws.space(spaceId).collection('credentials').get('doc-1'),
        { hello: 'world' }
      )
    })
  })

  describe('no fetch at all', () => {
    it('when a delegation proof does not verify', async () => {
      const peer = await mintPeer({ host: 'nofetch-proof.example' })
      const zcap = await grantTo(peer.did)
      zcap.allowedAction = ['GET', 'PUT']
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('when the chain roots outside the Space', async () => {
      const peer = await mintPeer({ host: 'nofetch-root.example' })
      // The root targets every Space on the server, which no route accepts.
      const allSpaces = new URL('/space/', baseServerUrl).toString()
      const zcap = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(allSpaces)}`,
        invocationTarget: spaceUrl,
        controller: peer.did,
        allowedActions: ['GET']
      })
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('when the chain is not delegated by the Space controller', async () => {
      const peer = await mintPeer({ host: 'nofetch-signer.example' })
      const zcap = await delegate({
        signer: bob.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: peer.did,
        allowedActions: ['GET']
      })
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('when the invoked capability names another controller', async () => {
      const peer = await mintPeer({ host: 'nofetch-controller.example' })
      const zcap = await grantTo(bob.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('when a peer DID signs a delegation in the chain', async () => {
      const delegator = await mintPeer({ host: 'nofetch-delegator.example' })
      const invoker = await mintPeer({ host: 'nofetch-invoker.example' })
      const parent = await grantTo(delegator.did)
      const child = await delegate({
        signer: delegator.keyPair.signer(),
        capability: parent,
        invocationTarget: spaceUrl,
        controller: invoker.did,
        allowedActions: ['GET']
      })
      await assertMasked(read({ keyPair: invoker.keyPair, capability: child }))
      assert.equal(fetchesOf(logUrlOf(delegator.host)), 0)
      assert.equal(fetchesOf(logUrlOf(invoker.host)), 0)
    })

    it('for a header that carries both an id and a capability', async () => {
      const peer = await mintPeer({ host: 'nofetch-mixed.example' })
      const zcap = await grantTo(peer.did)
      const rootId = `urn:zcap:root:${encodeURIComponent(spaceUrl)}`
      const headers = await signCapabilityInvocation({
        url: docUrl,
        method: 'GET',
        headers: { host: new URL(baseServerUrl).host },
        capability: zcap,
        // Appends an `id` parameter after the embedded capability, inside
        // the signed header value.
        capabilityAction: `GET",id="${rootId}`,
        invocationSigner: peer.keyPair.signer() as any
      })
      assert.match(
        headers['capability-invocation'],
        /^zcap capability="[^"]+",action="GET",id="urn:zcap:root:/
      )
      const response = await fastify.inject({
        method: 'GET',
        url: new URL(docUrl).pathname,
        headers
      })
      assert.equal(response.statusCode, 404)
      assert.equal(response.json().type, ProblemTypes.NOT_FOUND)
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('for a root invocation by a peer DID', async () => {
      const peer = await mintPeer({ host: 'nofetch-rootinv.example' })
      await assertMasked(
        read({
          keyPair: peer.keyPair,
          capability: rootZcap({ target: spaceUrl, controller: peer.did })
        })
      )
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('when a foreign DID under another path signs a delegation in the chain', async () => {
      const delegator = await mintPeer({
        host: 'nofetch-agent-delegator.example',
        path: 'agents/d1',
        purpose: ['capabilityInvocation', 'capabilityDelegation']
      })
      const invoker = await mintPeer({ host: 'nofetch-agent-invoker.example' })
      const parent = await grantTo(delegator.did)
      const child = await delegate({
        signer: delegator.keyPair.signer(),
        capability: parent,
        invocationTarget: spaceUrl,
        controller: invoker.did,
        allowedActions: ['GET']
      })
      await assertMasked(read({ keyPair: invoker.keyPair, capability: child }))
      assert.equal(
        fetched.filter(url => url.includes('nofetch-agent')).length,
        0
      )
    })

    it('for a DID whose path carries a segment that is not URL-safe', async () => {
      // `%3F` decodes to `?`. The method would keep it percent-encoded in the
      // log URL, but this server refuses any segment outside the unreserved
      // charset before a URL is built.
      const peer = await mintPeer({
        host: 'nofetch-segment.example',
        path: 'agents/a%3Fb'
      })
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetched.filter(url => url.includes(peer.host)).length, 0)
    })

    it('for a DID whose host carries a port', async () => {
      const peer = await mintPeer({
        host: 'nofetch-port.example',
        address: 'https://nofetch-port.example:8443/space/server/id'
      })
      assert.match(peer.did, /nofetch-port\.example%3A8443/)
      const zcap = await grantTo(peer.did)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetched.filter(url => url.includes(peer.host)).length, 0)
    })

    it('for a revoked capability', async () => {
      const peer = await mintPeer({ host: 'nofetch-revoked.example' })
      const zcap = await grantTo(peer.did)
      const revoked = await client({ signer: alice.signer }).request({
        url: new URL(
          spaceRevocationsPath({ spaceId, revocationId: zcap.id }),
          baseServerUrl
        ).toString(),
        method: 'POST',
        action: 'POST',
        capability: rootZcap({ target: spaceUrl, controller: alice.did }),
        json: zcap
      })
      assert.equal(revoked.status, 204)
      await assertMasked(read({ keyPair: peer.keyPair, capability: zcap }))
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
    })

    it('and a 5xx, not the mask, when the revocation lookup faults', async () => {
      const peer = await mintPeer({ host: 'nofetch-fault.example' })
      const zcap = await grantTo(peer.did)
      const spy = vi
        .spyOn(fastify.storage, 'isRevoked')
        .mockRejectedValue(new Error('disk fault'))
      try {
        const err = await requestError(
          read({ keyPair: peer.keyPair, capability: zcap })
        )
        assert.equal(err.status, 500)
        assert.equal(err.data.type, ProblemTypes.STORAGE_ERROR)
      } finally {
        spy.mockRestore()
      }
      assert.equal(fetchesOf(logUrlOf(peer.host)), 0)
      const response = await read({ keyPair: peer.keyPair, capability: zcap })
      assert.equal(response.status, 200)
    })
  })

  describe('as a controller', () => {
    /**
     * Alice's Update Space naming `controller`, as a root invocation.
     * @param controller {string}
     * @returns {Promise<any>}
     */
    async function promote(controller: string): Promise<any> {
      return client({ signer: alice.signer }).request({
        url: new URL(spaceMetaPath({ spaceId }), baseServerUrl).toString(),
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: spaceUrl,
          controller: alice.did
        }),
        json: { name: 'Replicated Space', controller }
      })
    }

    it('cannot be stored, under a space path or any other, and is never fetched', async () => {
      const server = await mintPeer({ host: 'controller-server.example' })
      const agent = await mintPeer({
        host: 'controller-agent.example',
        path: 'agents/c1'
      })
      for (const did of [server.did, agent.did]) {
        const err = await requestError(promote(did))
        assert.equal(err.status, 400, did)
        assert.equal(err.data.type, ProblemTypes.INVALID_REQUEST_BODY, did)
      }
      assert.equal(fetched.filter(url => url.includes('controller-')).length, 0)
      const meta = await client({ signer: alice.signer }).request({
        url: new URL(spaceMetaPath({ spaceId }), baseServerUrl).toString(),
        method: 'GET',
        action: 'GET',
        capability: rootZcap({ target: spaceUrl, controller: alice.did })
      })
      assert.equal((meta.data as any).controller, alice.did)
    })
  })

  describe('the blocklist', () => {
    let blocked: FastifyInstance, blockedUrl: string
    let byHost: Peer, byDid: Peer, allowed: Peer
    const blockedSpaceId = randomUUID()
    let blockedSpaceUrl: string

    beforeAll(async () => {
      byHost = await mintPeer({ host: 'blocked-host.example' })
      byDid = await mintPeer({ host: 'blocked-did.example', path: 'agents/b1' })
      allowed = await mintPeer({
        host: 'blocked-did.example',
        path: 'agents/b2'
      })
      ;({ fastify: blocked, baseServerUrl: blockedUrl } = await startTestServer(
        {
          backend: await openTempBackend(),
          peerLogFetcher,
          // A host is compared case-insensitively; a DID entry names one DID.
          webvhBlocklist: [' BLOCKED-HOST.example ', byDid.did]
        }
      ))
      const { alice: blockedAlice } = await zcapClients({
        baseServerUrl: blockedUrl
      })
      const space = blockedAlice.pws.space(blockedSpaceId)
      await space.configure({ name: 'Blocklist Space', controller: alice.did })
      await space.collection('credentials').configure({ force: true })
      await space.collection('credentials').put('doc-1', { hello: 'world' })
      blockedSpaceUrl = new URL(
        `/space/${blockedSpaceId}/`,
        blockedUrl
      ).toString()
    })
    afterAll(async () => {
      await blocked?.close()
    })

    /**
     * Reads the blocklist server's Resource under a grant to `peer`.
     * @param peer {Peer}
     * @returns {Promise<any>}
     */
    async function readBlocked(peer: Peer): Promise<any> {
      const zcap = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(blockedSpaceUrl)}`,
        invocationTarget: blockedSpaceUrl,
        controller: peer.did,
        allowedActions: ['GET']
      })
      return client({ signer: peer.keyPair.signer() as any }).request({
        url: new URL(
          `/space/${blockedSpaceId}/credentials/doc-1`,
          blockedUrl
        ).toString(),
        method: 'GET',
        action: 'GET',
        capability: zcap
      })
    }

    it('refuses every DID on a blocked host, with no fetch', async () => {
      await assertMasked(readBlocked(byHost))
      assert.equal(fetchesOf(byHost.url), 0)
    })

    it('refuses a blocked DID, with no fetch, and admits its neighbor', async () => {
      await assertMasked(readBlocked(byDid))
      assert.equal(fetchesOf(byDid.url), 0)
      const response = await readBlocked(allowed)
      assert.equal(response.status, 200)
      assert.equal(fetchesOf(allowed.url), 1)
    })
  })
})

describe('the did:webvh blocklist setting', () => {
  const scid = 'QmbbLRNKupeZRGTmrEnENTwifoo7sbndRFJCnC7AhSwB59'

  it('compiles host and DID entries, lowering hosts', () => {
    const did = `did:webvh:${scid}:Agent.Example:agents:a1`
    const { hosts, dids } = compileWebvhBlocklist({
      entries: [' Evil.Example ', '', did],
      source: 'test'
    })
    assert.deepStrictEqual([...hosts], ['evil.example'])
    assert.deepStrictEqual(
      [...dids],
      [`did:webvh:${scid}:agent.example:agents:a1`]
    )
  })

  it('parses the env value, and refuses a malformed entry naming it', () => {
    assert.equal(parseWebvhBlocklist(undefined), undefined)
    assert.equal(parseWebvhBlocklist(' , '), undefined)
    assert.deepStrictEqual(
      parseWebvhBlocklist(`evil.example, did:webvh:${scid}:agent.example`),
      ['evil.example', `did:webvh:${scid}:agent.example`]
    )
    for (const entry of [
      'evil.example:8443',
      'https://evil.example',
      '10.0.0.1',
      'localhost',
      `did:web:evil.example`,
      `did:webvh:${scid}:evil.example%3A8443`,
      `did:webvh:${scid}:evil.example:a%2Fb`,
      'did:webvh:short:evil.example'
    ]) {
      assert.throws(
        () => parseWebvhBlocklist(`ok.example,${entry}`),
        (err: Error) =>
          err.message.includes('WAS_WEBVH_BLOCKLIST') &&
          err.message.includes(entry),
        entry
      )
    }
  })

  it('refuses a malformed plugin option at registration', async () => {
    const backend = await openTempBackend()
    const app = createApp({
      serverUrl: 'https://pws.example',
      backend,
      logger: false,
      webvhBlocklist: ['not a host']
    })
    try {
      await assert.rejects(async () => {
        await app.ready()
      }, /webvhBlocklist entry "not a host"/)
    } finally {
      await app.close().catch(() => {})
      await backend.close()
    }
  })
})

describe('the default peer log fetcher', () => {
  it('fetches https on the default port only', () => {
    assert.throws(
      () =>
        checkPeerLogUrl({
          url: 'http://peer.example/space/server/id/did.jsonl'
        }),
      { name: 'PeerLogFetchError' }
    )
    assert.throws(
      () =>
        checkPeerLogUrl({
          url: 'https://peer.example:8443/space/server/id/did.jsonl'
        }),
      { name: 'PeerLogFetchError' }
    )
    assert.throws(
      () =>
        checkPeerLogUrl({
          url: 'https://user:pass@peer.example/space/server/id/did.jsonl'
        }),
      { name: 'PeerLogFetchError' }
    )
    assert.equal(
      checkPeerLogUrl({ url: 'https://peer.example/space/server/id/did.jsonl' })
        .hostname,
      'peer.example'
    )
  })

  it('refuses private, loopback, link-local and metadata addresses', () => {
    const url = 'https://peer.example/space/server/id/did.jsonl'
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1'
    ]) {
      const family = address.includes(':') ? 6 : 4
      assert.throws(
        () =>
          assertPublicAddresses({
            url,
            addresses: [
              { address: '93.184.215.14', family: 4 },
              { address, family }
            ]
          }),
        { name: 'PeerLogFetchError' },
        address
      )
    }
    assert.throws(() => assertPublicAddresses({ url, addresses: [] }), {
      name: 'PeerLogFetchError'
    })
    assert.doesNotThrow(() =>
      assertPublicAddresses({
        url,
        addresses: [
          { address: '93.184.215.14', family: 4 },
          { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }
        ]
      })
    )
  })

  it('refuses a host that resolves to a non-public address', async () => {
    for (const url of [
      'https://localhost/space/server/id/did.jsonl',
      'https://127.0.0.1/space/server/id/did.jsonl',
      'https://169.254.169.254/space/server/id/did.jsonl',
      'https://[::1]/space/server/id/did.jsonl'
    ]) {
      await assert.rejects(
        fetchPeerLog({
          url,
          maxBytes: 1024,
          signal: AbortSignal.timeout(2_000)
        }),
        { name: 'PeerLogFetchError' },
        url
      )
    }
  })

  describe('reading the response', () => {
    let server: Server, baseUrl: string, agent: Agent

    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://169.254.169.254/' })
          res.end()
        } else if (req.url === '/declared-large') {
          res.writeHead(200, { 'content-length': '4096' })
          res.end(Buffer.alloc(4096))
        } else if (req.url === '/streamed-large') {
          res.writeHead(200)
          for (let index = 0; index < 8; index++) {
            res.write(Buffer.alloc(512))
          }
          res.end()
        } else if (req.url === '/slow') {
          res.writeHead(200)
          res.write('{')
          // Never ends: the signal must cut the read off.
        } else if (req.url === '/missing') {
          res.writeHead(404)
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'text/jsonl' })
          res.end('{"ok":true}\n')
        }
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
      agent = new Agent()
    })
    afterAll(async () => {
      await agent.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    })

    /**
     * Reads a path of the local server under a 1 KiB limit.
     * @param path {string}
     * @param [timeoutMs] {number}
     * @returns {Promise<Uint8Array>}
     */
    function readPath(path: string, timeoutMs = 2_000): Promise<Uint8Array> {
      return readBoundedResponse({
        url: `${baseUrl}${path}`,
        dispatcher: agent,
        maxBytes: 1024,
        signal: AbortSignal.timeout(timeoutMs)
      })
    }

    it('reads a body within the limit', async () => {
      const bytes = await readPath('/ok')
      assert.equal(new TextDecoder().decode(bytes), '{"ok":true}\n')
    })

    it('does not follow a redirect', async () => {
      await assert.rejects(readPath('/redirect'), {
        name: 'PeerLogFetchError',
        message: /redirect/
      })
    })

    it('refuses a status other than 200', async () => {
      await assert.rejects(readPath('/missing'), { name: 'PeerLogFetchError' })
    })

    it('refuses a declared length over the limit', async () => {
      await assert.rejects(readPath('/declared-large'), {
        name: 'PeerLogFetchError',
        message: /larger than 1024/
      })
    })

    it('abandons a streamed body at the byte that crosses the limit', async () => {
      await assert.rejects(readPath('/streamed-large'), {
        name: 'PeerLogFetchError',
        message: /larger than 1024/
      })
    })

    it('stops a body that outlasts the signal', async () => {
      const started = performance.now()
      await assert.rejects(readPath('/slow', 200), {
        name: 'PeerLogFetchError'
      })
      assert.ok(performance.now() - started < 2_000)
    })
  })
})
