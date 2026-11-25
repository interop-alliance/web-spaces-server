/**
 * `OwnResourcesOnly` caveat and conditional reads (Vitest, HTTP level). A
 * `GET` carrying `If-None-Match` is answered from the record's metadata,
 * with no byte stream opened. Under the caveat that metadata must be the
 * principal's own before the condition is evaluated, or a 304 would carry
 * another party's `ETag`.
 *
 * The read is decided from one metadata read and answered from a later one.
 * Each case swaps the Resource between the two: right after the deciding
 * read, the id is deleted and created again by another party, through the
 * backend. Nothing is raced, since the swap runs inside the deciding read.
 */
import { it, describe, beforeAll, afterAll, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { ISigner } from '@interop/data-integrity-core'

import { rootCapabilityId } from '../src/zcap.js'
import type { IDID } from '../src/types.js'
import {
  anHourFromNow,
  binaryInput,
  client,
  openTempBackend,
  startTestServer,
  zcapClients
} from './helpers.js'

/**
 * The masked `not-found` problem type.
 */
const NOT_FOUND = 'https://w3id.org/pws#not-found'

describe('OwnResourcesOnly caveat on a conditional read', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  let backend: Awaited<ReturnType<typeof openTempBackend>>
  let guest: { did: IDID; signer: ISigner }
  let guestGrant: any

  const spaceId = `own-conditional-${randomUUID()}`
  const collectionId = 'comments'
  const OTHER: IDID = 'did:key:z6MkOwnConditionalOther'
  let collectionUrl: string

  /**
   * A `GET` as the guest under the caveat grant, resolving the status and
   * body whether the request succeeded or was refused.
   */
  async function guestGet(
    url: string,
    headers?: Record<string, string>
  ): Promise<{ status: number; data: any; headers?: Headers }> {
    try {
      const response = await client({ signer: guest.signer }).request({
        url,
        method: 'GET',
        action: 'GET',
        capability: guestGrant,
        ...(headers !== undefined && { headers })
      })
      return {
        status: response.status,
        data: response.data,
        headers: response.headers
      }
    } catch (err: any) {
      if (typeof err?.status !== 'number') {
        throw err
      }
      return {
        status: err.status,
        data: err.data,
        headers: err.response?.headers
      }
    }
  }

  /**
   * Runs `swap` once, right after the first Metadata read of the Resource,
   * which is the read the request is decided from.
   */
  function swapAfterDecidingRead({
    resourceId,
    swap
  }: {
    resourceId: string
    swap: () => Promise<void>
  }): void {
    const metadataRead = backend.getResourceMetadata.bind(backend)
    let swapped = false
    vi.spyOn(backend, 'getResourceMetadata').mockImplementation(
      async options => {
        const metadata = await metadataRead(options)
        if (!swapped && options.resourceId === resourceId) {
          swapped = true
          await swap()
        }
        return metadata
      }
    )
  }

  /**
   * Deletes the Resource and creates it again as another party.
   */
  async function recreateAsOther(resourceId: string): Promise<void> {
    await backend.deleteResource({ spaceId, collectionId, resourceId })
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: {
        kind: 'json',
        contentType: 'application/json',
        data: { by: 'other' }
      },
      createdBy: [OTHER]
    })
  }

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
    const keyPair = await Ed25519VerificationKey.generate()
    guest = {
      did: `did:key:${keyPair.fingerprint()}`,
      signer: keyPair.didKeySigner()
    }
    await alice.pws.createSpace({
      id: spaceId,
      name: spaceId,
      controller: alice.did
    })
    const spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    collectionUrl = `${spaceUrl}${collectionId}/`
    await alice.pws.request({
      url: `${collectionUrl}meta`,
      method: 'PUT',
      json: { id: collectionId }
    })
    guestGrant = await client({ signer: alice.signer }).delegate({
      capability: rootCapabilityId(spaceUrl),
      invocationTarget: collectionUrl,
      controller: guest.did,
      allowedActions: ['GET', 'POST', 'PUT', 'DELETE'],
      expires: anHourFromNow(),
      caveats: [{ type: 'OwnResourcesOnly' }]
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await fastify.close()
  })

  it("Get Resource answers no 304 from another party's record", async () => {
    const resourceId = 'doc'
    const url = `${collectionUrl}${resourceId}`
    await client({ signer: guest.signer }).request({
      url,
      method: 'PUT',
      action: 'PUT',
      capability: guestGrant,
      json: { by: 'guest' }
    })
    // The guest's own record answers the condition.
    const own = await guestGet(url, { 'if-none-match': '*' })
    assert.equal(own.status, 304)

    swapAfterDecidingRead({
      resourceId,
      swap: () => recreateAsOther(resourceId)
    })
    const swapped = await guestGet(url, { 'if-none-match': '*' })
    assert.equal(swapped.status, 404, JSON.stringify(swapped.data))
    assert.equal(swapped.data?.type, NOT_FOUND)
    assert.equal(swapped.headers?.get('etag'), null)
  })

  it("Get Chunk answers no 304 from another party's record", async () => {
    const resourceId = 'chunked'
    const url = `${collectionUrl}${resourceId}`
    const chunkUrl = `${url}/chunks/0`
    await client({ signer: guest.signer }).request({
      url,
      method: 'PUT',
      action: 'PUT',
      capability: guestGrant,
      json: { by: 'guest' }
    })
    await client({ signer: guest.signer }).request({
      url: chunkUrl,
      method: 'PUT',
      action: 'PUT',
      capability: guestGrant,
      body: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' }
    })
    const own = await guestGet(chunkUrl, { 'if-none-match': '*' })
    assert.equal(own.status, 304)

    swapAfterDecidingRead({
      resourceId,
      swap: async () => {
        await recreateAsOther(resourceId)
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId,
          chunkIndex: 0,
          input: binaryInput(Buffer.from([4, 5, 6]))
        })
      }
    })
    const swapped = await guestGet(chunkUrl, { 'if-none-match': '*' })
    assert.equal(swapped.status, 404, JSON.stringify(swapped.data))
    assert.equal(swapped.data?.type, NOT_FOUND)
    assert.equal(swapped.headers?.get('etag'), null)
  })
})
