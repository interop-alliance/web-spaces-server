/**
 * Per-Collection backend resolver tests.
 * Proves that a Collection may now *select* a registered `external` backend and
 * that its **data plane** (resource bytes) is routed to that backend's adapter,
 * while the server `default` backend keeps the control plane. The provider
 * adapter is injected via `createApp({ providers })` -- here a fake `test-provider`
 * provider whose adapter is a second `FileSystemBackend` over its own dir, so a
 * routed Resource lands there and not in the default dir (zero Google
 * dependency). Also covers fail-closed behavior and the registration allowlist
 * (`WAS_ENABLED_BACKENDS`).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { TempFileSystemBackend } from '../src/testing.js'
import type { BackendProviderRegistry } from '../src/types.js'
import {
  openTempBackend,
  provisionProviderContainers,
  requestError,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Per-Collection backend resolver (selectable registered backends)', () => {
  let fastify: FastifyInstance,
    defaultBackend: TempFileSystemBackend,
    providerBackend: TempFileSystemBackend,
    baseServerUrl: string,
    alice: any
  // How many adapters the `no-caveat-provider` factory has built.
  let noCaveatAdapters = 0

  beforeAll(async () => {
    defaultBackend = await openTempBackend({ prefix: 'was-test-default-' })
    providerBackend = await openTempBackend({ prefix: 'was-test-provider-' })
    // A fake `test-provider` whose adapter is a second filesystem backend over
    // its own dir, so a Resource routed to it lands there, not in the default dir.
    // `no-caveat-provider` builds an adapter written before capability
    // caveats, which enforces none.
    const providers: BackendProviderRegistry = new Map([
      ['test-provider', () => providerBackend],
      [
        'no-caveat-provider',
        () => {
          noCaveatAdapters += 1
          return Object.create(providerBackend, {
            enforcedCaveats: { value: [] }
          })
        }
      ]
    ])
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: defaultBackend,
      providers
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await providerBackend.close()
  })

  function url(relativePath: string): string {
    return new URL(relativePath, baseServerUrl).toString()
  }

  async function freshSpace(name: string): Promise<string> {
    const spaceId = crypto.randomUUID()
    await alice.pws.createSpace({ id: spaceId, name, controller: alice.did })
    return spaceId
  }

  async function registerBackend(
    spaceId: string,
    id: string,
    provider = 'test-provider'
  ) {
    return alice.pws.request({
      url: url(`/space/${spaceId}/backends`),
      method: 'POST',
      json: {
        id,
        provider,
        managedBy: 'external',
        connection: { kind: 'inmem' }
      }
    })
  }

  it("routes a selecting Collection's resource data to the registered backend", async () => {
    const spaceId = await freshSpace('Resolver Space')
    await registerBackend(spaceId, 'mem-1')

    // Create a Collection that selects the registered backend.
    const collectionId = 'photos'
    const createCol = await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/meta`),
      method: 'PUT',
      json: { id: collectionId, backend: { id: 'mem-1' } }
    })
    assert.equal(createCol.status, 201)
    assert.deepStrictEqual(createCol.data.backend, { id: 'mem-1' })

    await provisionProviderContainers({
      backend: providerBackend,
      spaceId,
      collectionId,
      controller: alice.did
    })

    // PUT a Resource into it.
    const resourceId = 'r1'
    const putRes = await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
      method: 'PUT',
      json: { hello: 'world' }
    })
    assert.equal(putRes.status, 201)

    // The bytes landed in the provider backend, NOT the default backend.
    const fromProvider = await providerBackend.getResource({
      spaceId,
      collectionId,
      resourceId
    })
    assert.equal(fromProvider.storedResourceType, 'application/json')
    let defaultThrew: unknown
    try {
      await defaultBackend.getResource({ spaceId, collectionId, resourceId })
    } catch (err) {
      defaultThrew = err
    }
    assert.ok(defaultThrew, 'resource must NOT exist in the default backend')

    // GET reads it back through the API (proving the read also resolves).
    const getRes = await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
      method: 'GET'
    })
    assert.equal(getRes.status, 200)
    assert.deepStrictEqual(getRes.data, { hello: 'world' })

    // GET .../backend echoes the external descriptor (resolved from the record).
    const backendRes = await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/backend`),
      method: 'GET'
    })
    assert.equal(backendRes.status, 200)
    assert.equal(backendRes.data.id, 'mem-1')
    assert.equal(backendRes.data.provider, 'test-provider')
  })

  it('the default Collection path still writes to the default backend (unchanged)', async () => {
    const spaceId = await freshSpace('Default Path Space')
    const collectionId = 'notes'
    // No `backend` selection -> defaults to the server `default`.
    await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/meta`),
      method: 'PUT',
      json: { id: collectionId }
    })
    const resourceId = 'd1'
    await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
      method: 'PUT',
      json: { kind: 'default' }
    })

    // Lands in the default backend; never touches the provider backend.
    const fromDefault = await defaultBackend.getResource({
      spaceId,
      collectionId,
      resourceId
    })
    assert.equal(fromDefault.storedResourceType, 'application/json')
    let providerThrew: unknown
    try {
      await providerBackend.getResource({ spaceId, collectionId, resourceId })
    } catch (err) {
      providerThrew = err
    }
    assert.ok(providerThrew, 'resource must NOT exist in the provider backend')
  })

  it('a selection whose provider has no factory fails closed (409) at data-plane', async () => {
    const spaceId = await freshSpace('No Factory Space')
    // Registration is permissive (no allowlist), so an unknown provider records
    // fine; it is only the *data plane* that fails closed (no adapter factory).
    await registerBackend(spaceId, 'orphan-1', 'no-such-provider')
    const collectionId = 'docs'
    const createCol = await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/meta`),
      method: 'PUT',
      json: { id: collectionId, backend: { id: 'orphan-1' } }
    })
    // The selection itself is accepted (the backend is registered).
    assert.equal(createCol.status, 201)

    let thrown: any
    try {
      await alice.pws.request({
        url: url(`/space/${spaceId}/${collectionId}/r1`),
        method: 'PUT',
        json: { x: 1 }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the data-plane write to fail closed')
    assert.equal(thrown.response.status, 409)
  })

  it('an adapter that does not enforce an advertised caveat fails closed (409) at data-plane', async () => {
    const spaceId = await freshSpace('No Caveat Adapter Space')
    await registerBackend(spaceId, 'no-caveat-1', 'no-caveat-provider')
    const collectionId = 'docs'
    const createCol = await alice.pws.request({
      url: url(`/space/${spaceId}/${collectionId}/meta`),
      method: 'PUT',
      json: { id: collectionId, backend: { id: 'no-caveat-1' } }
    })
    assert.equal(createCol.status, 201)

    // The controller's own root invocation carries no caveat and is refused
    // all the same: the adapter is never served.
    for (const method of ['PUT', 'GET']) {
      const refused = await requestError(
        alice.pws.request({
          url: url(`/space/${spaceId}/${collectionId}/r1`),
          method,
          ...(method === 'PUT' && { json: { x: 1 } })
        })
      )
      assert.equal(refused.response.status, 409, method)
      assert.match(refused.data.type, /#unsupported-backend/)
      assert.match(
        refused.data.errors[0].detail,
        /capability caveat OwnResourcesOnly/
      )
    }
    // A refused adapter is not memoized: each request built its own.
    assert.equal(noCaveatAdapters, 2)
  })

  it('selecting an unknown backend id is rejected at Collection write (409 unsupported-backend)', async () => {
    const spaceId = await freshSpace('Unknown Id Space')
    let thrown: any
    try {
      await alice.pws.request({
        url: url(`/space/${spaceId}/docs/meta`),
        method: 'PUT',
        json: { id: 'docs', backend: { id: 'does-not-exist' } }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the unknown-backend selection to be rejected')
    assert.equal(thrown.response.status, 409)
    assert.equal(thrown.data.errors[0].pointer, '#/backend')
  })

  it("a Collection's `backend` cannot change once set (409 backend-immutable), but may be restated", async () => {
    const spaceId = await freshSpace('Immutable Selection Space')
    await registerBackend(spaceId, 'mem-fixed')
    const metaUrl = url(`/space/${spaceId}/docs/meta`)
    const created = await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: { id: 'docs' }
    })
    assert.equal(created.status, 201)

    // Onto a registered external backend: refused, nothing stored.
    const moved = await requestError(
      alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { id: 'docs', backend: { id: 'mem-fixed' } }
      })
    )
    assert.equal(moved.response.status, 409)
    assert.match(moved.data.type, /#backend-immutable/)
    assert.equal(moved.data.errors[0].pointer, '#/backend')
    const unchanged = await alice.pws.request({ url: metaUrl, method: 'GET' })
    assert.equal(unchanged.data.backend.id, 'default')

    // The same backend under another of its ids is a restatement, stored as
    // sent; an omitted `backend` keeps the stored one.
    const restated = await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: { id: 'docs', backend: { id: 'fs' }, name: 'Docs' }
    })
    assert.equal(restated.status, 204)
    const described = await alice.pws.request({ url: metaUrl, method: 'GET' })
    assert.equal(described.data.backend.id, 'fs')
    const kept = await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: { id: 'docs', name: 'Docs again' }
    })
    assert.equal(kept.status, 204)

    // And off a registered external backend: refused as well.
    const external = await alice.pws.request({
      url: url(`/space/${spaceId}/notes/meta`),
      method: 'PUT',
      json: { id: 'notes', backend: { id: 'mem-fixed' } }
    })
    assert.equal(external.status, 201)
    const back = await requestError(
      alice.pws.request({
        url: url(`/space/${spaceId}/notes/meta`),
        method: 'PUT',
        json: { id: 'notes', backend: { id: 'default' } }
      })
    )
    assert.equal(back.response.status, 409)
    assert.match(back.data.type, /#backend-immutable/)
  })

  it("a `unique` index declaration on a registered backend's Collection is refused (409 unsupported-backend)", async () => {
    const spaceId = await freshSpace('Unique On External Space')
    await registerBackend(spaceId, 'mem-unique')
    const metaUrl = url(`/space/${spaceId}/docs/meta`)

    // The adapter never receives the declaration, so it cannot enforce the
    // claim; a create declaring one is refused and stores nothing.
    const refused = await requestError(
      alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: {
          id: 'docs',
          backend: { id: 'mem-unique' },
          plaintext: { indexes: [{ name: 'slug', unique: true }] }
        }
      })
    )
    assert.equal(refused.response.status, 409)
    assert.match(refused.data.type, /#unsupported-backend/)
    assert.equal(refused.data.errors[0].pointer, '#/plaintext/indexes')
    const missing = await requestError(
      alice.pws.request({ url: metaUrl, method: 'GET' })
    )
    assert.equal(missing.response.status, 404)

    // A non-unique index is fine there.
    const created = await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: {
        id: 'docs',
        backend: { id: 'mem-unique' },
        plaintext: { indexes: ['slug'] }
      }
    })
    assert.equal(created.status, 201)

    // Adding the claim to the stored Collection is refused the same way.
    const added = await requestError(
      alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: {
          id: 'docs',
          plaintext: { indexes: [{ name: 'slug', unique: true }] }
        }
      })
    )
    assert.equal(added.response.status, 409)
    assert.match(added.data.type, /#unsupported-backend/)

    // Moving a declaring Collection onto the registered backend is refused
    // too, by the selection's immutability, which is decided first.
    const declaring = await alice.pws.request({
      url: url(`/space/${spaceId}/notes/meta`),
      method: 'PUT',
      json: {
        id: 'notes',
        plaintext: { indexes: [{ name: 'slug', unique: true }] }
      }
    })
    assert.equal(declaring.status, 201)
    const moved = await requestError(
      alice.pws.request({
        url: url(`/space/${spaceId}/notes/meta`),
        method: 'PUT',
        json: { id: 'notes', backend: { id: 'mem-unique' } }
      })
    )
    assert.equal(moved.response.status, 409)
    assert.match(moved.data.type, /#backend-immutable/)
  })
})

describe('Backend registration allowlist (WAS_ENABLED_BACKENDS)', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    alice: any

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-test-allowlist-' })
    // Only `test-provider` may be registered.
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend,
      enabledBackendProviders: ['test-provider']
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  function backendsUrl(spaceId: string): string {
    return new URL(`/space/${spaceId}/backends`, baseServerUrl).toString()
  }

  async function freshSpace(name: string): Promise<string> {
    const spaceId = crypto.randomUUID()
    await alice.pws.createSpace({ id: spaceId, name, controller: alice.did })
    return spaceId
  }

  it('accepts a provider on the allowlist (201)', async () => {
    const spaceId = await freshSpace('Allowed Provider Space')
    const response = await alice.pws.request({
      url: backendsUrl(spaceId),
      method: 'POST',
      json: {
        id: 'mem-1',
        provider: 'test-provider',
        managedBy: 'external',
        connection: { kind: 'inmem' }
      }
    })
    assert.equal(response.status, 201)
    assert.equal(response.data.provider, 'test-provider')
  })

  it('rejects a provider not on the allowlist at POST (409, #/provider)', async () => {
    const spaceId = await freshSpace('Disallowed Provider Space')
    let thrown: any
    try {
      await alice.pws.request({
        url: backendsUrl(spaceId),
        method: 'POST',
        json: {
          id: 'gd-1',
          provider: 'gdrive',
          managedBy: 'external',
          connection: { kind: 'oauth2' }
        }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the disallowed provider to be rejected')
    assert.equal(thrown.response.status, 409)
    assert.equal(thrown.data.errors[0].pointer, '#/provider')
  })
})
