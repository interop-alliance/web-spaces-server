/**
 * The request fault seam `startTestServer()` returns: every request is
 * recorded, and a chosen one can be refused before its handler, have its
 * response dropped after it is applied, or be held until released.
 */
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { zcapClients } from './helpers.js'
import {
  openTempBackend,
  RequestFaultDisarmedError,
  startTestServer
} from '../src/testing.js'
import type { RequestFaults } from '../src/testing.js'

describe('request faults', () => {
  let fastify: FastifyInstance
  let baseServerUrl: string
  let faults: RequestFaults
  let alice: Awaited<ReturnType<typeof zcapClients>>['alice']
  let bob: Awaited<ReturnType<typeof zcapClients>>['bob']
  const spaceId = randomUUID()
  const collectionPath = `/space/${spaceId}/notes/`

  beforeAll(async () => {
    const started = await startTestServer({ backend: await openTempBackend() })
    ;({ fastify, baseServerUrl, faults } = started)
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Faults', controller: alice.did })
    await space.collection('notes').configure({ force: true })
  })

  beforeEach(() => {
    faults.reset()
  })

  afterAll(async () => {
    await fastify.close()
  })

  function notes() {
    return alice.pws.space(spaceId).collection('notes')
  }

  it('records every request in order with method, path, and DID', async () => {
    await notes().put('recorded', { n: 1 })
    await notes().get('recorded')
    await fetch(`${baseServerUrl}service?x=1`)
    // An unsigned write the auth hooks refuse is still recorded.
    await fetch(new URL(`${collectionPath}unsigned`, baseServerUrl), {
      method: 'DELETE'
    })

    assert.deepStrictEqual(faults.requests, [
      {
        method: 'PUT',
        path: `${collectionPath}recorded`,
        did: alice.did,
        status: 201
      },
      {
        method: 'GET',
        path: `${collectionPath}recorded`,
        did: alice.did,
        status: 200
      },
      { method: 'GET', path: '/service', status: 200 },
      { method: 'DELETE', path: `${collectionPath}unsigned`, status: 404 }
    ])
  })

  it('reaches the KMS facet ahead of its auth hooks', async () => {
    const { fired } = faults.refuse({
      match: { path: /^\/kms\// },
      status: 502
    })
    const response = await fetch(`${baseServerUrl}kms/keystores/none`)
    assert.equal(response.status, 502)
    assert.equal((await fired).fault, 'refused')
  })

  it('refuses the first matching request before its handler runs', async () => {
    const path = `${collectionPath}refused`
    const { fired } = faults.refuse({
      match: { method: 'PUT', path, did: alice.did },
      status: 400
    })

    await assert.rejects(notes().put('refused', { n: 1 }))
    const record = await fired
    assert.equal(record.status, 400)
    assert.equal(record.fault, 'refused')

    // Nothing was stored, and the fault fired once: the retry lands.
    assert.equal(await notes().get('refused'), null)
    await notes().put('refused', { n: 2 })
    assert.deepStrictEqual(await notes().get('refused'), { n: 2 })
  })

  it('refuses as many matching requests as `times` says', async () => {
    faults.refuse({ match: { path: '/service' }, times: 2 })
    const statuses = []
    for (let attempt = 0; attempt < 3; attempt++) {
      statuses.push((await fetch(`${baseServerUrl}service`)).status)
    }
    assert.deepStrictEqual(statuses, [503, 503, 200])
  })

  it('refuses a `times` that is not a positive integer or Infinity', () => {
    for (const times of [0, -1, 1.5, NaN]) {
      assert.throws(
        () => faults.refuse({ match: { path: '/service' }, times }),
        RangeError
      )
    }
    assert.equal(faults.requests.length, 0)
  })

  it('matches a global pattern on every request', async () => {
    faults.refuse({ match: { path: /\/service/g }, times: Infinity })
    const statuses = []
    for (let attempt = 0; attempt < 3; attempt++) {
      statuses.push((await fetch(`${baseServerUrl}service`)).status)
    }
    assert.deepStrictEqual(statuses, [503, 503, 503])
  })

  it('matches a string path across percent-encodings', async () => {
    const { fired } = faults.refuse({
      match: { path: `${collectionPath}my doc` },
      status: 400
    })
    const response = await fetch(
      new URL(`${collectionPath}my%20doc`, baseServerUrl)
    )
    assert.equal(response.status, 400)
    assert.equal((await fired).path, `${collectionPath}my%20doc`)
  })

  it('lets a cross-origin page read a refusal', async () => {
    faults.refuse({ match: { path: '/service' }, status: 400 })
    const response = await fetch(`${baseServerUrl}service`, {
      headers: { origin: 'https://app.example' }
    })
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })

  it('rejects the promise of a fault disarmed before it is taken', async () => {
    const { fired } = faults.refuse({ match: { path: '/never' } })
    const { held } = faults.hold({ match: { path: '/never' } })
    faults.reset()
    await assert.rejects(fired, RequestFaultDisarmedError)
    await assert.rejects(held, RequestFaultDisarmedError)
  })

  it('disarms a hold released before its request arrives', async () => {
    const { held, release } = faults.hold({ match: { path: '/service' } })
    release()
    await assert.rejects(held, RequestFaultDisarmedError)
    assert.equal((await fetch(`${baseServerUrl}service`)).status, 200)
    assert.equal(faults.requests[0]!.fault, undefined)
  })

  it('matches on the invoking DID', async () => {
    const { fired } = faults.refuse({ match: { did: bob.did }, status: 400 })
    await notes().put('by-did', { n: 1 })
    await assert.rejects(bob.pws.space(randomUUID()).describe())
    assert.equal((await fired).did, bob.did)
  })

  it('leaves a CORS preflight alone when no method is named', async () => {
    const path = `${collectionPath}preflight`
    faults.refuse({ match: { path }, status: 400 })
    const preflight = await fetch(new URL(path, baseServerUrl), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'PUT'
      }
    })
    assert.equal(preflight.status, 204)
    await assert.rejects(notes().put('preflight', { n: 1 }))
  })

  it('drops the response of a write that landed', async () => {
    const path = `${collectionPath}dropped`
    // The client retries a transport failure, so every attempt is dropped.
    faults.dropResponse({ match: { method: 'PUT', path }, times: Infinity })

    await assert.rejects(notes().put('dropped', { n: 1 }))

    // The client saw a transport failure, and the write is durable.
    const [record] = faults.requests.filter(request => request.path === path)
    assert.equal(record!.fault, 'dropped')
    assert.equal(record!.status, 201)
    faults.reset()
    assert.deepStrictEqual(await notes().get('dropped'), { n: 1 })
  })

  it('holds a request until the test releases it', async () => {
    const path = `${collectionPath}held`
    const { held, release } = faults.hold({ match: { method: 'PUT', path } })

    const first = notes().put('held', { writer: 'first' })
    await held
    // The held write has not been applied, so a second one lands ahead of it.
    await notes().put('held', { writer: 'second' })
    assert.deepStrictEqual(await notes().get('held'), { writer: 'second' })

    release()
    await first
    assert.deepStrictEqual(await notes().get('held'), { writer: 'first' })
  })

  it('releases a held request when the server closes', async () => {
    const started = await startTestServer({ backend: await openTempBackend() })
    const { held } = started.faults.hold({ match: { path: '/service' } })
    const pending = fetch(`${started.baseServerUrl}service`)
    await held
    await started.fastify.close()
    assert.equal((await pending).status, 200)
  })
})
