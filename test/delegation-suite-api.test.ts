/**
 * Delegation-proof cryptosuite tests (Vitest): the server accepts a delegation
 * proof signed with either `eddsa-jcs-2022` or `Ed25519Signature2020`, at every
 * site that verifies one -- the invocation path, the revocation chain check,
 * and the revocation's own invocation.
 *
 * The rest of `test/` drives the server through the shared `client()` helper,
 * which signs with `eddsa-jcs-2022` -- what real clients now emit. This suite is
 * the home of the other half: `Ed25519Signature2020` is still accepted, because
 * clients upgrade on their own schedule and grants a wallet recorded before the
 * switch are submitted back for revocation under the old suite. The two may
 * also be mixed across the links of one chain, in either order.
 *
 * Invocations are raw `@interop/ezcap` requests: each test picks the suite its
 * delegations are signed with, which the high-level `@interop/pws-client`
 * surface does not expose.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { ZcapClient } from '@interop/ezcap'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { securityLoader } from '@interop/security-document-loader'
import type { ISigner } from '@interop/data-integrity-core'

import { spaceRevocationsPath } from '../src/lib/paths.js'
import {
  anHourFromNow,
  client as jcsClient,
  openTempBackend,
  requestError,
  rootZcap as makeRootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Delegation-proof cryptosuites', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any

  // Fresh ids per run so re-runs against a dirty data dir cannot collide.
  const spaceId = randomUUID()
  const collectionId = 'credentials'

  let spaceUrl: string
  let collectionUrl: string

  /**
   * A ZcapClient signing its delegation proofs with `Ed25519Signature2020` --
   * a client that has not upgraded yet.
   *
   * It is given an explicit document loader that serves the data-integrity
   * context. URDNA2015 expands the parent embedded in
   * `proof.capabilityChain`, so re-delegating a JCS-signed parent (which
   * carries that context) throws on this suite's default loader, at signing
   * time and before any server sees the chain. That is a client-side
   * limitation, not something the verify side can cover.
   */
  function legacyClient({ signer }: { signer: ISigner }): ZcapClient {
    return new ZcapClient({
      SuiteClass: Ed25519Signature2020,
      invocationSigner: signer,
      delegationSigner: signer,
      documentLoader: securityLoader().build()
    })
  }

  const rootCapabilityId = (target: string) =>
    `urn:zcap:root:${encodeURIComponent(target)}`

  /**
   * The delegation proof of a freshly delegated capability. `proof` is typed as
   * one proof or a set of them; a `delegate()` result always carries exactly
   * one.
   */
  function delegationProof(capability: any): Record<string, string> {
    const { proof } = capability
    return Array.isArray(proof) ? proof[0] : proof
  }

  /** Reads the seeded Resource under `capability`, invoking as `signer`. */
  async function readDoc({
    capability,
    signer
  }: {
    capability: any
    signer: ISigner
  }) {
    return jcsClient({ signer }).request({
      url: `${collectionUrl}/doc-1`,
      method: 'GET',
      action: 'GET',
      capability
    })
  }

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

    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Suite Space', controller: alice.did })
    await space
      .collection(collectionId)
      .configure({ name: 'Credentials', force: true })
    await space.collection(collectionId).put('doc-1', { hello: 'world' })
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('a single-link chain', () => {
    it('accepts an `eddsa-jcs-2022` delegation proof', async () => {
      const capability = await jcsClient({ signer: alice.signer }).delegate({
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: collectionUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET'],
        expires: anHourFromNow()
      })
      const proof = delegationProof(capability)
      assert.equal(proof.type, 'DataIntegrityProof')
      assert.equal(proof.cryptosuite, 'eddsa-jcs-2022')

      const response = await readDoc({
        capability,
        signer: aliceDelegatedApp.signer
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('still accepts an `Ed25519Signature2020` delegation proof', async () => {
      const capability = await legacyClient({ signer: alice.signer }).delegate({
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: collectionUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET'],
        expires: anHourFromNow()
      })
      assert.equal(delegationProof(capability).type, 'Ed25519Signature2020')

      const response = await readDoc({
        capability,
        signer: aliceDelegatedApp.signer
      })
      assert.equal(response.status, 200)
    })
  })

  describe('a chain mixing the two suites', () => {
    it('verifies an old-suite parent with a new-suite child', async () => {
      // One `expires` for both links: a child minted a moment after its
      // parent would otherwise outlive it by that moment and be refused.
      const expires = anHourFromNow()
      const parent = await legacyClient({ signer: alice.signer }).delegate({
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: collectionUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET'],
        expires
      })
      const child = await jcsClient({
        signer: aliceDelegatedApp.signer
      }).delegate({
        capability: parent,
        controller: bob.did,
        allowedActions: ['GET'],
        expires
      })

      const response = await readDoc({ capability: child, signer: bob.signer })
      assert.equal(response.status, 200)
    })

    it('verifies a new-suite parent with an old-suite child', async () => {
      // One `expires` for both links: a child minted a moment after its
      // parent would otherwise outlive it by that moment and be refused.
      const expires = anHourFromNow()
      const parent = await jcsClient({ signer: alice.signer }).delegate({
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: collectionUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET'],
        expires
      })
      const child = await legacyClient({
        signer: aliceDelegatedApp.signer
      }).delegate({
        capability: parent,
        controller: bob.did,
        allowedActions: ['GET'],
        expires
      })

      const response = await readDoc({ capability: child, signer: bob.signer })
      assert.equal(response.status, 200)
    })
  })

  describe('revocation', () => {
    it('revokes a capability delegated under either suite', async () => {
      for (const delegator of [jcsClient, legacyClient]) {
        const capability = await delegator({ signer: alice.signer }).delegate({
          capability: rootCapabilityId(spaceUrl),
          invocationTarget: collectionUrl,
          controller: aliceDelegatedApp.did,
          allowedActions: ['GET'],
          expires: anHourFromNow()
        })
        const before = await readDoc({
          capability,
          signer: aliceDelegatedApp.signer
        })
        assert.equal(before.status, 200)

        // The revocation is submitted by the delegator, invoking the Space's
        // root capability; its body is the capability being revoked, whose
        // delegation chain the server re-verifies.
        const response = await jcsClient({ signer: alice.signer }).request({
          url: new URL(
            spaceRevocationsPath({ spaceId, revocationId: capability.id }),
            baseServerUrl
          ).toString(),
          method: 'POST',
          action: 'POST',
          capability: makeRootZcap({
            target: spaceUrl,
            controller: alice.did
          }),
          json: capability
        })
        assert.equal(response.status, 204)

        const err = await requestError(
          readDoc({ capability, signer: aliceDelegatedApp.signer })
        )
        assert.equal(err.status, 404)
      }
    })
  })
})
