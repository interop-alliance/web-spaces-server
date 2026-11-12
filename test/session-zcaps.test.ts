/**
 * Space-rooted delegated capabilities (Vitest) -- the "browser session key"
 * shape. The controller delegates, once,
 * from the Space's root capability: a read-only capability targeting the
 * Space URL, and a read/write capability attenuated down to one Collection.
 * The delegate (a stand-in for the refresh-surviving session key) then
 * invokes those capabilities against URLs *underneath* their targets --
 * resources, listings, metadata, the changes-query endpoint -- which the
 * space-family routes accept as RESTful target attenuation rooted at the
 * Space (see `verifyZcap`'s `attenuatedRootTarget`).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { Collection, Space } from '@interop/pws-client'

import {
  delegate,
  openTempBackend,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Space-rooted session capabilities', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any

  // Fresh ids per run so re-runs against a dirty data dir cannot collide.
  const spaceId = randomUUID()
  const collectionId = 'private-credentials'

  let spaceUrl: string
  let collectionUrl: string
  // The two "session" capabilities, delegated by Alice at "login".
  let spaceReadCap: any
  let collectionWriteCap: any

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ baseServerUrl }))

    spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      baseServerUrl
    ).toString()

    // Alice provisions a Space and a Collection...
    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Session Space', controller: alice.did })
    await space
      .collection(collectionId)
      .configure({ name: 'Credentials', force: true })

    // ...then delegates the session pair to her app's did:key. Both chains
    // root at the *Space's* root capability: the read capability targets the
    // canonical (trailing-slash) Space URL itself; the write capability
    // attenuates its target down to the Collection at delegation time (so the
    // session key can never write outside it -- in particular, never PUT the
    // Space Metadata object).
    spaceReadCap = await delegate({
      signer: alice.signer,
      capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
      invocationTarget: spaceUrl,
      controller: aliceDelegatedApp.did,
      allowedActions: ['GET']
    })
    collectionWriteCap = await delegate({
      signer: alice.signer,
      capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
      invocationTarget: collectionUrl,
      controller: aliceDelegatedApp.did,
      allowedActions: ['GET', 'PUT', 'POST', 'DELETE']
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('space-scoped read capability', () => {
    it('reads the Space Metadata object underneath the capability target', async () => {
      const handle = aliceDelegatedApp.pws.fromCapability(spaceReadCap)
      assert.ok(handle instanceof Space)
      const description = await handle.describe()
      assert.equal(description?.id, spaceId)
      assert.equal(description?.controller, alice.did)
    })

    it('reads a resource underneath the Space (target attenuation)', async () => {
      await alice.pws
        .space(spaceId)
        .collection(collectionId)
        .put('doc-1', { hello: 'world' })

      const doc = await aliceDelegatedApp.pws
        .space(spaceId, { capability: spaceReadCap })
        .collection(collectionId)
        .get('doc-1')
      assert.deepStrictEqual(doc, { hello: 'world' })
    })

    it('lists a Collection underneath the Space', async () => {
      const listing = await aliceDelegatedApp.pws
        .space(spaceId, { capability: spaceReadCap })
        .collection(collectionId)
        .list()
      assert.ok(listing)
      assert.ok(listing.items.some((item: any) => item.id === 'doc-1'))
    })

    it('cannot write with a GET/HEAD-only capability', async () => {
      await assert.rejects(
        aliceDelegatedApp.pws
          .space(spaceId, { capability: spaceReadCap })
          .collection(collectionId)
          .put('doc-intruder', { nope: true }),
        (err: any) => {
          // Action mismatch fails verification (404-masked unauthorized).
          assert.equal(err.status, 404)
          return true
        }
      )
      // ...and the write did not land.
      const doc = await alice.pws
        .space(spaceId)
        .collection(collectionId)
        .get('doc-intruder')
      assert.equal(doc, null)
    })
  })

  describe('collection-scoped write capability (rooted at the Space)', () => {
    it('writes and reads back a resource in the Collection', async () => {
      const handle = aliceDelegatedApp.pws.fromCapability(collectionWriteCap)
      assert.ok(handle instanceof Collection)
      const { etag } = await handle.put('doc-2', { from: 'session' })
      assert.ok(etag)
      assert.deepStrictEqual(await handle.get('doc-2'), { from: 'session' })
    })

    it('writes resource metadata (/meta)', async () => {
      const handle = aliceDelegatedApp.pws.fromCapability(collectionWriteCap)
      const { etag } = await handle
        .resource('doc-2')
        .setMeta({ custom: { synced: true } })
      assert.ok(etag)
    })

    it('queries the changes feed (POST .../query)', async () => {
      const response = await aliceDelegatedApp.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/query`,
        method: 'POST',
        json: { profile: 'changes', limit: 10 },
        capability: collectionWriteCap
      })
      const { documents } = response.data as {
        documents: Array<{ id: string }>
      }
      assert.ok(documents.some(doc => doc.id === 'doc-2'))
    })

    it('deletes a resource in the Collection', async () => {
      const handle = aliceDelegatedApp.pws.fromCapability(collectionWriteCap)
      await handle.resource('doc-2').delete()
      assert.equal(await handle.get('doc-2'), null)
    })

    it('cannot write outside its Collection', async () => {
      await alice.pws
        .space(spaceId)
        .collection('wallet-activity')
        .configure({ name: 'Activity', force: true })

      // Rejected either client-side (the invocation URL is not under the
      // capability's target) or server-side; the write must not land.
      await assert.rejects(
        aliceDelegatedApp.pws.request({
          url: `${baseServerUrl}space/${spaceId}/wallet-activity/doc-3`,
          method: 'PUT',
          json: { escape: true },
          capability: collectionWriteCap
        })
      )
      const doc = await alice.pws
        .space(spaceId)
        .collection('wallet-activity')
        .get('doc-3')
      assert.equal(doc, null)
    })

    it('cannot PUT the Space Metadata object (no Space takeover)', async () => {
      await assert.rejects(
        aliceDelegatedApp.pws.request({
          url: `${baseServerUrl}space/${spaceId}/meta`,
          method: 'PUT',
          json: { id: spaceId, controller: aliceDelegatedApp.did },
          capability: collectionWriteCap
        })
      )
      // The controller is untouched.
      const description = await alice.pws.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
    })
  })

  describe('root-of-chain enforcement', () => {
    it('rejects a chain rooted at the Collection URL (only the Space root is accepted)', async () => {
      // Delegated from the Collection's *own* root capability rather than the
      // Space's: valid-looking, but the space-family routes only ever accept
      // the Space root (or the exact request target's own root) -- the same
      // single-root rule the keystore routes apply.
      const collectionRootedCap = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(collectionUrl)}`,
        invocationTarget: collectionUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET', 'PUT', 'POST', 'DELETE']
      })
      await assert.rejects(
        aliceDelegatedApp.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/doc-4`,
          method: 'PUT',
          json: { rooted: 'wrong' },
          capability: collectionRootedCap
        }),
        (err: any) => {
          assert.equal(err.status ?? err.response?.status, 404)
          return true
        }
      )
      const doc = await alice.pws
        .space(spaceId)
        .collection(collectionId)
        .get('doc-4')
      assert.equal(doc, null)
    })

    it("rejects another Space's session capability", async () => {
      // Bob provisions his own Space and delegates a full session capability
      // for it to Alice's app -- which must still buy nothing in Alice's Space.
      const bobSpaceId = randomUUID()
      await bob.pws
        .space(bobSpaceId)
        .configure({ name: "Bob's Space", controller: bob.did })
      const bobSpaceUrl = new URL(
        `/space/${bobSpaceId}/`,
        baseServerUrl
      ).toString()
      const bobSessionCap = await delegate({
        signer: bob.signer,
        capability: `urn:zcap:root:${encodeURIComponent(bobSpaceUrl)}`,
        invocationTarget: bobSpaceUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET', 'PUT', 'POST', 'DELETE']
      })
      // Rejected either client-side (the invocation URL is not under the
      // capability's target) or server-side; the write must not land.
      await assert.rejects(
        aliceDelegatedApp.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/doc-5`,
          method: 'PUT',
          json: { crossSpace: true },
          capability: bobSessionCap
        })
      )
      const doc = await alice.pws
        .space(spaceId)
        .collection(collectionId)
        .get('doc-5')
      assert.equal(doc, null)
    })

    // Capability expiry is not re-tested here: `@interop/zcap` enforces
    // `expires` during chain verification with a deliberate 300s
    // `maxClockSkew` tolerance, so observing a rejection would mean minting
    // a capability and waiting out five minutes of skew (ezcap refuses to
    // sign an already-expired delegation).
  })
})
