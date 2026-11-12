/**
 * Space backend registration API tests (Vitest): POST / PUT / DELETE
 * `/space/:id/backends[/:backendId]`. Asserts the secret-bearing write vs.
 * sanitized read split, capability-only authorization, and that registration
 * records do not travel in a Space export.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { TempFileSystemBackend } from '../src/testing.js'
import {
  importArchive,
  etagGeneration,
  openTempBackend,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Space backend registration (/backends)', () => {
  let fastify: FastifyInstance,
    backend: TempFileSystemBackend,
    baseServerUrl: string,
    alice: any,
    bob: any

  // A registration whose connection carries secret grant material; the response
  // and listing must never echo `authorizationCode` / `refreshToken`.
  function sampleRegistration(id = 'gdrive-1') {
    return {
      id,
      name: 'My Google Drive',
      managedBy: 'external',
      provider: 'google-drive',
      connection: {
        kind: 'oauth2',
        authorizationCode: 'super-secret-auth-code',
        refreshToken: 'super-secret-refresh-token',
        account: 'alice@example.com',
        scope: 'drive.file'
      }
    }
  }

  // The single server-configured filesystem backend, registered as `default`.
  // The server backends head every listing: the `default` alias, then the
  // filesystem backend under its fixed id.
  const defaultBackendDescriptor = {
    id: 'default',
    name: 'Server Filesystem',
    managedBy: 'server',
    persistence: 'durable'
  }
  const serverBackendDescriptors = [
    defaultBackendDescriptor,
    { ...defaultBackendDescriptor, id: 'fs' }
  ]

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  async function freshSpace(name: string): Promise<string> {
    const spaceId = crypto.randomUUID()
    await alice.pws.createSpace({ id: spaceId, name, controller: alice.did })
    return spaceId
  }

  function backendsUrl(spaceId: string, backendId?: string): string {
    const base = `/space/${spaceId}/backends`
    return new URL(
      backendId ? `${base}/${backendId}` : base,
      baseServerUrl
    ).toString()
  }

  function assertNoSecrets(descriptor: any): void {
    assert.equal(descriptor.connection.authorizationCode, undefined)
    assert.equal(descriptor.connection.refreshToken, undefined)
    assert.equal(descriptor.authorizationCode, undefined)
    assert.equal(descriptor.refreshToken, undefined)
  }

  it('POST registers an external backend (201, sanitized descriptor)', async () => {
    const spaceId = await freshSpace('Register Space')
    const response = await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    assert.equal(response.status, 201)
    assert.equal(
      response.headers.get('location'),
      backendsUrl(spaceId, 'gdrive-1')
    )
    assert.equal(response.data.id, 'gdrive-1')
    assert.equal(response.data.managedBy, 'external')
    assert.equal(response.data.provider, 'google-drive')
    assert.equal(response.data.connection.kind, 'oauth2')
    assert.equal(response.data.connection.status, 'registered')
    // Public connection metadata is surfaced; secrets are not.
    assert.equal(response.data.connection.account, 'alice@example.com')
    assert.equal(response.data.connection.scope, 'drive.file')
    assertNoSecrets(response.data)
  })

  it('GET /backends lists [default, registered] without secrets', async () => {
    const spaceId = await freshSpace('Listing Space')
    await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    const response = await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.length, 3)
    assert.deepStrictEqual(response.data.slice(0, 2), serverBackendDescriptors)
    assert.equal(response.data[2].id, 'gdrive-1')
    assertNoSecrets(response.data[2])
  })

  it('POST a duplicate id yields id-conflict (409)', async () => {
    const spaceId = await freshSpace('Duplicate Space')
    await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    let thrown: any
    try {
      await alice.pws.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: sampleRegistration()
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the duplicate-id POST to be rejected')
    assert.equal(thrown.response.status, 409)
    assert.equal(thrown.data.errors[0].pointer, '#/id')
  })

  it('POST id "default" is rejected (400)', async () => {
    const spaceId = await freshSpace('Reserved Id Space')
    let thrown: any
    try {
      await alice.pws.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: { ...sampleRegistration(), id: 'default' }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the default-id POST to be rejected')
    assert.equal(thrown.response.status, 400)
    assert.equal(thrown.data.errors[0].pointer, '#/id')
  })

  it('POST missing provider or connection is rejected (400)', async () => {
    const spaceId = await freshSpace('Invalid Body Space')

    for (const [field, body] of [
      ['provider', { id: 'x', connection: { kind: 'oauth2' } }],
      ['connection', { id: 'x', provider: 'google-drive' }]
    ] as const) {
      let thrown: any
      try {
        await alice.pws.request({
          url: backendsUrl(spaceId),
          method: 'POST',
          json: body
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, `expected missing ${field} to be rejected`)
      assert.equal(thrown.response.status, 400)
      assert.equal(thrown.data.errors[0].pointer, `#/${field}`)
    }
  })

  it('POST without auth headers is the masked not-found (404)', async () => {
    const spaceId = await freshSpace('Unauthenticated Space')
    const response = await fetch(
      new URL(`/space/${spaceId}/backends`, baseServerUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sampleRegistration())
      }
    )
    assert.equal(response.status, 404)
  })

  it('POST by a non-controller is masked as not-found (404)', async () => {
    const spaceId = await freshSpace('Foreign Controller Space')
    let thrown: any
    try {
      await bob.pws.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: sampleRegistration()
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, "expected bob's POST to alice's space to be rejected")
    assert.equal(thrown.response.status, 404)
  })

  it('PUT updates an existing backend (204) and the change is reflected', async () => {
    const spaceId = await freshSpace('Update Space')
    await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    const updated = sampleRegistration()
    updated.connection.account = 'alice-new@example.com'
    const putResponse = await alice.pws.request({
      url: backendsUrl(spaceId, 'gdrive-1'),
      method: 'PUT',
      json: updated
    })
    assert.equal(putResponse.status, 204)

    const listing = await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'GET'
    })
    const registered = listing.data.find((b: any) => b.id === 'gdrive-1')
    assert.equal(registered.connection.account, 'alice-new@example.com')
    assertNoSecrets(registered)
  })

  it('PUT creates a new backend at a chosen id (201)', async () => {
    const spaceId = await freshSpace('Upsert Create Space')
    const response = await alice.pws.request({
      url: backendsUrl(spaceId, 'gdrive-2'),
      method: 'PUT',
      json: sampleRegistration('gdrive-2')
    })
    assert.equal(response.status, 201)
    assert.equal(
      response.headers.get('location'),
      backendsUrl(spaceId, 'gdrive-2')
    )
    assert.equal(response.data.id, 'gdrive-2')
    assertNoSecrets(response.data)
  })

  it('PUT whose body id does not match the URL id is rejected (400)', async () => {
    const spaceId = await freshSpace('Mismatch Space')
    let thrown: any
    try {
      await alice.pws.request({
        url: backendsUrl(spaceId, 'gdrive-1'),
        method: 'PUT',
        json: sampleRegistration('different-id')
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the id-mismatch PUT to be rejected')
    assert.equal(thrown.response.status, 400)
    assert.equal(thrown.data.errors[0].pointer, '#/id')
  })

  it('DELETE deregisters a backend (204) and it no longer lists', async () => {
    const spaceId = await freshSpace('Delete Space')
    await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })

    const deleteResponse = await alice.pws.request({
      url: backendsUrl(spaceId, 'gdrive-1'),
      method: 'DELETE'
    })
    assert.equal(deleteResponse.status, 204)

    const listing = await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'GET'
    })
    assert.deepStrictEqual(listing.data, serverBackendDescriptors)
  })

  it('a registration and a deregistration each advance the Space Metadata ETag', async () => {
    // The served Space Metadata object lists the Space's backends, so a
    // change to the listing is a change to the representation and its strong
    // validator must change with it: a conditional read holding the prior
    // validator gets the new object, not a 304.
    const spaceId = await freshSpace('ETag Space')
    const metaUrl = new URL(`/space/${spaceId}/meta`, baseServerUrl).toString()
    const before = await alice.pws.request({ url: metaUrl, method: 'GET' })
    const etagBefore = before.headers.get('etag')!
    assert.deepStrictEqual(before.data.backends, serverBackendDescriptors)

    await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: sampleRegistration()
    })
    const registered = await responseOf(
      alice.pws.request({
        url: metaUrl,
        method: 'GET',
        headers: { 'if-none-match': etagBefore }
      })
    )
    assert.equal(registered.status, 200)
    const etagRegistered = registered.headers.get('etag')!
    assert.notEqual(etagRegistered, etagBefore)
    // A 200 comes back as the client's parsed result, body on `data`.
    const registeredBody = (registered as any).data
    assert.equal(registeredBody.backends.length, 3)
    assert.equal(registeredBody.backends[2].id, 'gdrive-1')
    // The generation is kept: only the version advanced.
    assert.equal(
      etagGeneration(etagRegistered),
      etagGeneration(etagBefore),
      'expected the same generation'
    )

    await alice.pws.request({
      url: backendsUrl(spaceId, 'gdrive-1'),
      method: 'DELETE'
    })
    const deregistered = await responseOf(
      alice.pws.request({
        url: metaUrl,
        method: 'GET',
        headers: { 'if-none-match': etagRegistered }
      })
    )
    assert.equal(deregistered.status, 200)
    const etagDeregistered = deregistered.headers.get('etag')!
    assert.notEqual(etagDeregistered, etagRegistered)
    assert.deepStrictEqual(
      (deregistered as any).data.backends,
      serverBackendDescriptors
    )

    // Deregistering an absent record changes nothing, so the validator holds
    // and the conditional read is a 304.
    await alice.pws.request({
      url: backendsUrl(spaceId, 'gdrive-1'),
      method: 'DELETE'
    })
    const unchanged = await responseOf(
      alice.pws.request({
        url: metaUrl,
        method: 'GET',
        headers: { 'if-none-match': etagDeregistered }
      })
    )
    assert.equal(unchanged.status, 304)
  })

  it('registration records do not travel in a Space export', async () => {
    const src = await freshSpace('Export Source Space')
    await alice.pws.request({
      url: backendsUrl(src),
      method: 'POST',
      json: sampleRegistration()
    })
    // Sanity: the record is present on the source.
    assert.equal((await backend.listBackends({ spaceId: src })).length, 1)

    const dst = await freshSpace('Export Target Space')
    const pack = await backend.exportSpace({ spaceId: src })
    await importArchive({ backend: backend, spaceId: dst, tarStream: pack })

    // The registration did not travel: the target has no registered backends,
    // so its GET /backends reports only the server default.
    assert.deepStrictEqual(await backend.listBackends({ spaceId: dst }), [])
    const listing = await alice.pws.request({
      url: backendsUrl(dst),
      method: 'GET'
    })
    assert.deepStrictEqual(listing.data, serverBackendDescriptors)
  })
})
