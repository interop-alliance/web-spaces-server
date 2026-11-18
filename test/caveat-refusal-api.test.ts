/**
 * Caveat refusal tests (Vitest): the server registers no caveat handler, so a
 * capability chain that carries a `caveat` does not verify. The request is
 * answered the masked `not-found` (404), the same body an absent target gets.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import type { ICaveat } from '@interop/data-integrity-core/zcap'

import { rootCapabilityId } from '../src/zcap.js'
import {
  anHourFromNow,
  client,
  openTempBackend,
  requestError,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Capability caveats', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    aliceDelegatedApp: any

  const spaceId = randomUUID()
  const collectionId = 'credentials'

  let spaceUrl: string
  let collectionUrl: string

  /**
   * Delegates `GET` on the Collection from the Space's root capability to the
   * delegated app, signed by Alice, with the given caveats if any.
   */
  async function delegateRead({ caveats }: { caveats?: ICaveat[] } = {}) {
    return client({ signer: alice.signer }).delegate({
      capability: rootCapabilityId(spaceUrl),
      invocationTarget: collectionUrl,
      controller: aliceDelegatedApp.did,
      allowedActions: ['GET'],
      expires: anHourFromNow(),
      caveats
    })
  }

  /**
   * Reads a Resource of the Collection under `capability`, invoking as the
   * delegated app.
   */
  async function read({
    capability,
    resourceId = 'doc-1'
  }: {
    capability: any
    resourceId?: string
  }) {
    return client({ signer: aliceDelegatedApp.signer }).request({
      url: `${collectionUrl}/${resourceId}`,
      method: 'GET',
      action: 'GET',
      capability
    })
  }

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, aliceDelegatedApp } = await zcapClients({ baseServerUrl }))

    spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      baseServerUrl
    ).toString()

    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Caveat Space', controller: alice.did })
    await space
      .collection(collectionId)
      .configure({ name: 'Credentials', force: true })
    await space.collection(collectionId).put('doc-1', { hello: 'world' })
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('accepts the same delegation with no caveat', async () => {
    const response = await read({ capability: await delegateRead() })
    assert.equal(response.status, 200)
  })

  it('answers a chain with a caveat the masked not-found', async () => {
    const caveat = { type: 'urn:example:caveat:OwnResourcesOnly' }
    const capability = await delegateRead({ caveats: [caveat] })
    assert.deepStrictEqual(capability.caveat, [caveat])
    const denied = await requestError(read({ capability }))
    assert.equal(denied.status, 404)
    assert.equal(denied.data.type, 'https://w3id.org/pws#not-found')
    assert.deepStrictEqual(denied.data.errors, [
      { detail: 'URL not found or invalid authorization.' }
    ])

    // The body is the one an absent target gets under a valid capability.
    const absent = await requestError(
      read({ capability: await delegateRead(), resourceId: 'no-such-doc' })
    )
    assert.equal(absent.status, 404)
    assert.deepStrictEqual(denied.data, absent.data)
  })
})
