/**
 * HEAD is authorized as GET (Vitest). The capability action vocabulary is
 * `GET`, `POST`, `PUT` and `DELETE`. A HEAD request's invocation names the
 * `GET` action, and a capability that permits `GET` permits it. A HEAD signed
 * with the action `HEAD` is an action mismatch, refused with the masked 404.
 *
 * Requests go out over `fetch` with headers from `signCapabilityInvocation`,
 * so the action each one names is explicit. The cases cover both
 * authorization paths: capability-or-policy (a Resource read) and
 * capability-only (the replicas listing).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import { ProblemTypes } from '@interop/storage-core'

import { rootCapabilityId } from '../src/zcap.js'
import {
  delegate,
  openTempBackend,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('HEAD is authorized as GET', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    aliceDelegatedApp: any
  const spaceId = randomUUID()
  const collectionId = 'private-notes'
  const resourceId = 'note'
  let spaceUrl: string
  let resourceUrl: string
  let replicasUrl: string

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, aliceDelegatedApp } = await zcapClients({ baseServerUrl }))
    spaceUrl = `${baseServerUrl}space/${spaceId}/`
    resourceUrl = `${spaceUrl}${collectionId}/${resourceId}`
    replicasUrl = `${spaceUrl}replicas`

    await alice.pws.request({
      url: `${baseServerUrl}spaces/`,
      method: 'POST',
      json: { id: spaceId, name: 'HEAD Space', controller: alice.did }
    })
    await alice.pws.request({
      url: spaceUrl,
      method: 'POST',
      json: { id: collectionId, name: 'Private notes' }
    })
    await alice.pws.request({
      url: resourceUrl,
      method: 'PUT',
      body: new Blob(['hello'], { type: 'text/plain' })
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /**
   * Sends a HEAD signed as a capability invocation naming `action`.
   *
   * @param options {object}
   * @param options.url {string}   the absolute URL
   * @param options.action {string}   the capability action the invocation names
   * @param options.signer {object}   the invocation signer
   * @param [options.capability] {object|string}   defaults to the root
   *   capability of `url`
   * @returns {Promise<Response>}
   */
  async function signedHead({
    url,
    action,
    signer,
    capability
  }: {
    url: string
    action: string
    signer: any
    capability?: any
  }): Promise<Response> {
    const headers = await signCapabilityInvocation({
      url,
      method: 'HEAD',
      headers: { date: new Date().toUTCString() },
      ...(capability !== undefined && { capability }),
      capabilityAction: action,
      invocationSigner: signer
    })
    return fetch(url, { method: 'HEAD', headers: headers as any })
  }

  /**
   * Asserts the masked refusal an unauthorized read gets: a 404 with no body,
   * since a HEAD carries none.
   */
  async function assertRefused(response: Response): Promise<void> {
    assert.equal(response.status, 404)
    assert.equal(await response.text(), '')
  }

  describe('under the root capability', () => {
    it('a HEAD of a Resource signed with action GET succeeds', async () => {
      const response = await signedHead({
        url: resourceUrl,
        action: 'GET',
        signer: alice.signer
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-length'), '5')
      assert.equal(await response.text(), '')
    })

    it('a HEAD of a Resource signed with action HEAD is refused (404)', async () => {
      await assertRefused(
        await signedHead({
          url: resourceUrl,
          action: 'HEAD',
          signer: alice.signer
        })
      )
    })

    it('a capability-only HEAD signed with action GET succeeds', async () => {
      const response = await signedHead({
        url: replicasUrl,
        action: 'GET',
        signer: alice.signer
      })
      assert.equal(response.status, 200)
    })

    it('a capability-only HEAD signed with action HEAD is refused (404)', async () => {
      await assertRefused(
        await signedHead({
          url: replicasUrl,
          action: 'HEAD',
          signer: alice.signer
        })
      )
    })

    it('action HEAD is refused the way any action mismatch is', async () => {
      const asHead = await signedHead({
        url: resourceUrl,
        action: 'HEAD',
        signer: alice.signer
      })
      const asPut = await signedHead({
        url: resourceUrl,
        action: 'PUT',
        signer: alice.signer
      })
      assert.equal(asHead.status, asPut.status)
      assert.equal(
        asHead.headers.get('content-type'),
        asPut.headers.get('content-type')
      )
    })

    it('a GET signed with action HEAD is refused (404)', async () => {
      const headers = await signCapabilityInvocation({
        url: resourceUrl,
        method: 'GET',
        headers: { date: new Date().toUTCString() },
        capabilityAction: 'HEAD',
        invocationSigner: alice.signer
      })
      const response = await fetch(resourceUrl, {
        method: 'GET',
        headers: headers as any
      })
      assert.equal(response.status, 404)
      assert.equal(
        ((await response.json()) as { type: string }).type,
        ProblemTypes.NOT_FOUND
      )
    })
  })

  describe('under a delegated GET-only grant', () => {
    let readGrant: any

    beforeAll(async () => {
      readGrant = await delegate({
        signer: alice.signer,
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: spaceUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET']
      })
    })

    it('authorizes a HEAD signed with action GET', async () => {
      const response = await signedHead({
        url: resourceUrl,
        action: 'GET',
        signer: aliceDelegatedApp.signer,
        capability: readGrant
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-length'), '5')
    })

    it('refuses a HEAD signed with action HEAD (404)', async () => {
      await assertRefused(
        await signedHead({
          url: resourceUrl,
          action: 'HEAD',
          signer: aliceDelegatedApp.signer,
          capability: readGrant
        })
      )
    })
  })
})
