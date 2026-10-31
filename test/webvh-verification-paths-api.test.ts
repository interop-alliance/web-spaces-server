/**
 * The `did:webvh` resolver on the verification paths outside the ordinary
 * route verification (Vitest): revocation submission, consent for a Space
 * create, and List Spaces. Each must resolve a self-hosted `did:webvh`
 * signing key whatever the scope's own controller is, so a grant that
 * verifies on invocation can also be revoked, provisioned through, and listed
 * with.
 *
 * Invocations are raw `@interop/ezcap` requests: these are wire-level
 * authorization shapes, not the high-level `@interop/pws-client` surface.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { ProblemTypes } from '@interop/storage-core'

import { spaceRevocationsPath } from '../src/lib/paths.js'
import {
  client,
  delegate,
  openTempBackend,
  provisionWebvhIdentity,
  requestError,
  rootZcap,
  startTestServer,
  zcapClients,
  type WebvhIdentity
} from './helpers.js'

describe('did:webvh on the revocation, consent, and listing paths', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any, bob: any

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('revocation on a did:key Space', () => {
    const spaceId = randomUUID()
    let spaceUrl: string
    let collectionUrl: string
    let docUrl: string
    // A separate self-hosted `did:webvh`; the Space above stays `did:key`.
    let grantee: WebvhIdentity

    beforeAll(async () => {
      spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
      collectionUrl = new URL(
        `/space/${spaceId}/credentials`,
        baseServerUrl
      ).toString()
      docUrl = `${collectionUrl}/doc-1`
      const space = alice.pws.space(spaceId)
      await space.configure({ name: 'Unlock-shaped', controller: alice.did })
      await space.collection('credentials').configure({ force: true })
      await space.collection('credentials').put('doc-1', { hello: 'world' })
      grantee = await provisionWebvhIdentity({ owner: alice, baseServerUrl })
    })

    function revocationUrl(capabilityId: string): string {
      return new URL(
        spaceRevocationsPath({ spaceId, revocationId: capabilityId }),
        baseServerUrl
      ).toString()
    }

    async function revoke({
      capabilityToRevoke,
      signer,
      capability
    }: {
      capabilityToRevoke: any
      signer: any
      capability: any
    }) {
      return client({ signer }).request({
        url: revocationUrl(capabilityToRevoke.id),
        method: 'POST',
        action: 'POST',
        capability,
        json: capabilityToRevoke
      })
    }

    async function readDoc({ zcap, signer }: { zcap: any; signer: any }) {
      return client({ signer }).request({
        url: docUrl,
        method: 'GET',
        action: 'GET',
        capability: zcap
      })
    }

    async function delegateToGrantee() {
      return delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: collectionUrl,
        controller: grantee.did,
        allowedActions: ['GET']
      })
    }

    it('the controller revokes a child grant signed by a did:webvh method', async () => {
      const parent = await delegateToGrantee()
      const child = await delegate({
        signer: grantee.clientKeyPair.signer(),
        capability: parent,
        invocationTarget: collectionUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(parent.expires)
      })
      const before = await readDoc({ zcap: child, signer: bob.signer })
      assert.equal(before.status, 200)

      const response = await revoke({
        capabilityToRevoke: child,
        signer: alice.signer,
        capability: rootZcap({ target: spaceUrl, controller: alice.did })
      })
      assert.equal(response.status, 204)

      const err = await requestError(
        readDoc({ zcap: child, signer: bob.signer })
      )
      assert.equal(err.status, 404)
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_REVOKED)
    })

    it('a did:webvh delegee revokes its own grant (dual-root rule)', async () => {
      const zcap = await delegateToGrantee()
      const signer = grantee.clientKeyPair.signer()
      const before = await readDoc({ zcap, signer })
      assert.equal(before.status, 200)

      const response = await revoke({
        capabilityToRevoke: zcap,
        signer,
        capability: rootZcap({
          target: revocationUrl(zcap.id),
          controller: grantee.did
        })
      })
      assert.equal(response.status, 204)

      const err = await requestError(readDoc({ zcap, signer }))
      assert.equal(err.status, 404)
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_REVOKED)
    })

    it("a grant rooted in a Resource's own root capability can be revoked", async () => {
      // `verifyZcap` accepts the Resource URL's own root on a Resource read,
      // so this grant verifies on invocation and must be revocable too.
      const zcap = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(docUrl)}`,
        invocationTarget: docUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const before = await readDoc({ zcap, signer: bob.signer })
      assert.equal(before.status, 200)

      const response = await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap({ target: spaceUrl, controller: alice.did })
      })
      assert.equal(response.status, 204)

      const err = await requestError(readDoc({ zcap, signer: bob.signer }))
      assert.equal(err.status, 404)
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_REVOKED)
    })
  })

  describe('consent for a Space create', () => {
    let grantee: WebvhIdentity

    beforeAll(async () => {
      grantee = await provisionWebvhIdentity({ owner: alice, baseServerUrl })
    })

    it('a provisioning chain with a did:webvh delegee creates the Space', async () => {
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const zcap = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spacesUrl)}`,
        invocationTarget: spacesUrl,
        controller: grantee.did,
        allowedActions: ['POST']
      })
      const spaceId = randomUUID()
      const response = await client({
        signer: grantee.clientKeyPair.signer()
      }).request({
        url: spacesUrl,
        method: 'POST',
        action: 'POST',
        capability: zcap,
        json: { id: spaceId, name: 'Provisioned', controller: alice.did }
      })
      assert.equal(response.status, 201)
      const description = await alice.pws.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
    })

    it('the create branch of PUT /meta refuses a did:webvh controller (400)', async () => {
      const spaceId = randomUUID()
      const metaUrl = new URL(
        `/space/${spaceId}/meta`,
        baseServerUrl
      ).toString()
      const err = await requestError(
        client({ signer: grantee.clientKeyPair.signer() }).request({
          url: metaUrl,
          method: 'PUT',
          action: 'PUT',
          capability: rootZcap({
            target: new URL(`/space/${spaceId}/`, baseServerUrl).toString(),
            controller: grantee.did
          }),
          json: { id: spaceId, controller: grantee.did }
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.type, ProblemTypes.INVALID_REQUEST_BODY)
      assert.equal(err.data.errors[0].pointer, '#/controller')
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })
  })

  describe('List Spaces for a promoted controller', () => {
    let account: WebvhIdentity
    let spacesUrl: string

    beforeAll(async () => {
      spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      account = await provisionWebvhIdentity({ owner: alice, baseServerUrl })
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${account.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: account.spaceId,
          name: 'Identity Space',
          controller: account.did
        }
      })
      assert.equal(promoted.status, 204)
    })

    async function listIds({
      signer,
      capability
    }: {
      signer: any
      capability: any
    }): Promise<string[]> {
      const response = await client({ signer }).request({
        url: spacesUrl,
        method: 'GET',
        action: 'GET',
        capability
      })
      assert.equal(response.status, 200)
      const listing = response.data as { items: Array<{ id: string }> }
      return listing.items.map(item => item.id)
    }

    it('the promoted controller lists its Space', async () => {
      const ids = await listIds({
        signer: account.clientKeyPair.signer(),
        capability: rootZcap({ target: spacesUrl, controller: account.did })
      })
      assert.deepStrictEqual(ids, [account.spaceId])
    })

    it("the promoted Space leaves the previous controller's listing", async () => {
      const ids = await listIds({
        signer: alice.signer,
        capability: rootZcap({ target: spacesUrl, controller: alice.did })
      })
      assert.ok(ids.length > 0)
      assert.ok(!ids.includes(account.spaceId))
    })

    it('a listing grant from the promoted controller lists its Spaces only', async () => {
      const zcap = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(spacesUrl)}`,
        invocationTarget: spacesUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const ids = await listIds({ signer: bob.signer, capability: zcap })
      assert.deepStrictEqual(ids, [account.spaceId])
    })
  })
})
