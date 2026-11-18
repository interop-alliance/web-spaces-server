/**
 * `createdBy` delegation chain tests (Vitest): a create records the DIDs of
 * the delegation chain its invocation verified under, as a list. A root
 * invocation lists the invoker alone. A delegated invocation lists the
 * controller of each delegated capability in delegation order, the invoker
 * last, and leaves out the Space controller (the root capability's). The
 * list is kept verbatim by every later write, whoever makes it. Covered for
 * a Space, a Collection and a Resource.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { rootCapabilityId } from '../src/zcap.js'
import {
  delegate,
  openTempBackend,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('createdBy delegation chains', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    app: any,
    bob: any

  /**
   * Delegates from a root capability: Alice grants `actions` on `target`
   * to `to`.
   */
  async function rootGrant({
    target,
    to,
    actions
  }: {
    target: string
    to: string
    actions: string[]
  }) {
    return delegate({
      signer: alice.signer,
      capability: rootCapabilityId(target),
      invocationTarget: target,
      controller: to,
      allowedActions: actions
    })
  }

  /**
   * Delegates a capability on to `to`, signed by its holder, with the same
   * target, actions and expiry.
   */
  async function subGrant({
    parent,
    signer,
    to
  }: {
    parent: any
    signer: any
    to: string
  }) {
    return delegate({
      signer,
      capability: parent,
      invocationTarget: parent.invocationTarget,
      controller: to,
      allowedActions: parent.allowedAction,
      expires: new Date(parent.expires)
    })
  }

  /**
   * Makes a request signed by `who` under `capability`, or under the root
   * capability of the Space the URL names when absent, returning the
   * response.
   */
  async function invoke({
    who,
    url,
    method,
    capability,
    json
  }: {
    who: any
    url: string
    method: string
    capability?: any
    json?: unknown
  }) {
    return who.pws.request({
      url,
      method,
      ...(capability !== undefined && { capability }),
      ...(json !== undefined && { json })
    })
  }

  /**
   * Reads a Metadata object (a Space, Collection or Resource `meta` URL)
   * under Alice's root capability.
   */
  async function readMeta(metaUrl: string) {
    const response = await invoke({ who: alice, url: metaUrl, method: 'GET' })
    assert.equal(response.status, 200)
    return response.data
  }

  /**
   * Creates a Space under Alice's root invocation of `/spaces/`, returning
   * its canonical URL.
   */
  async function rootSpace(): Promise<string> {
    const spaceId = randomUUID()
    const response = await alice.pws.request({
      url: new URL('/spaces/', baseServerUrl).toString(),
      method: 'POST',
      json: { id: spaceId, controller: alice.did }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data.createdBy, [alice.did])
    return new URL(`/space/${spaceId}/`, baseServerUrl).toString()
  }

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({
      alice,
      aliceDelegatedApp: app,
      bob
    } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('Space', () => {
    it('a root create records [controller]', async () => {
      const spaceUrl = await rootSpace()
      const meta = await readMeta(`${spaceUrl}meta`)
      assert.deepStrictEqual(meta.createdBy, [alice.did])
    })

    it('a one-link delegated POST create records [app], and an update by the controller keeps it', async () => {
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const grant = await rootGrant({
        target: spacesUrl,
        to: app.did,
        actions: ['POST']
      })
      const spaceId = randomUUID()
      const created = await invoke({
        who: app,
        url: spacesUrl,
        method: 'POST',
        capability: grant,
        json: { id: spaceId, controller: alice.did }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did])

      const spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
      const updated = await invoke({
        who: alice,
        url: `${spaceUrl}meta`,
        method: 'PUT',
        json: { name: 'Renamed by the controller', controller: alice.did }
      })
      assert.equal(updated.status, 204)
      const meta = await readMeta(`${spaceUrl}meta`)
      assert.equal(meta.name, 'Renamed by the controller')
      assert.deepStrictEqual(meta.createdBy, [app.did])
    })

    it('a one-link delegated PUT create records [app]', async () => {
      const spaceId = randomUUID()
      const spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
      const grant = await rootGrant({
        target: `${spaceUrl}meta`,
        to: app.did,
        actions: ['PUT']
      })
      const created = await invoke({
        who: app,
        url: `${spaceUrl}meta`,
        method: 'PUT',
        capability: grant,
        json: { controller: alice.did }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did])
      const meta = await readMeta(`${spaceUrl}meta`)
      assert.deepStrictEqual(meta.createdBy, [app.did])
    })

    it('a two-link delegated create records [app, bob], the controller left out', async () => {
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const first = await rootGrant({
        target: spacesUrl,
        to: app.did,
        actions: ['POST']
      })
      const second = await subGrant({
        parent: first,
        signer: app.signer,
        to: bob.did
      })
      const spaceId = randomUUID()
      const created = await invoke({
        who: bob,
        url: spacesUrl,
        method: 'POST',
        capability: second,
        json: { id: spaceId, controller: alice.did }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did, bob.did])
    })
  })

  describe('Collection', () => {
    let spaceUrl: string

    beforeAll(async () => {
      spaceUrl = await rootSpace()
    })

    it('a root create records [controller]', async () => {
      const created = await invoke({
        who: alice,
        url: spaceUrl,
        method: 'POST',
        json: { id: 'root-made' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [alice.did])
    })

    it('a one-link delegated create records [app], and an update by the controller keeps it', async () => {
      const grant = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['POST']
      })
      const created = await invoke({
        who: app,
        url: spaceUrl,
        method: 'POST',
        capability: grant,
        json: { id: 'app-made' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did])

      const metaUrl = `${spaceUrl}app-made/meta`
      const updated = await invoke({
        who: alice,
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'Renamed by the controller' } }
      })
      assert.equal(updated.status, 204)
      const meta = await readMeta(metaUrl)
      assert.equal(meta.custom.name, 'Renamed by the controller')
      assert.deepStrictEqual(meta.createdBy, [app.did])
    })

    it('a two-link delegated create records [app, bob], the controller left out', async () => {
      const first = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['POST']
      })
      const second = await subGrant({
        parent: first,
        signer: app.signer,
        to: bob.did
      })
      const created = await invoke({
        who: bob,
        url: spaceUrl,
        method: 'POST',
        capability: second,
        json: { id: 'bob-made' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did, bob.did])
      const meta = await readMeta(`${spaceUrl}bob-made/meta`)
      assert.deepStrictEqual(meta.createdBy, [app.did, bob.did])
    })

    it('a delegated create by PUT of the Metadata object records the chain', async () => {
      const grant = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['PUT']
      })
      const created = await invoke({
        who: app,
        url: `${spaceUrl}put-made/meta`,
        method: 'PUT',
        capability: grant,
        json: {}
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did])
    })
  })

  describe('Resource', () => {
    let spaceUrl: string
    let collectionUrl: string

    beforeAll(async () => {
      spaceUrl = await rootSpace()
      collectionUrl = `${spaceUrl}notes/`
      const created = await invoke({
        who: alice,
        url: spaceUrl,
        method: 'POST',
        json: { id: 'notes' }
      })
      assert.equal(created.status, 201)
    })

    it('a root create records [controller]', async () => {
      const created = await invoke({
        who: alice,
        url: `${collectionUrl}root-doc`,
        method: 'PUT',
        json: { by: 'alice' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [alice.did])
    })

    it('a one-link delegated POST create records [app]', async () => {
      const grant = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['POST']
      })
      const created = await invoke({
        who: app,
        url: collectionUrl,
        method: 'POST',
        capability: grant,
        json: { by: 'app' }
      })
      assert.equal(created.status, 201)
      const meta = await readMeta(`${created.data.url}/meta`)
      assert.deepStrictEqual(meta.createdBy, [app.did])
    })

    it('a one-link delegated PUT create records [app], and a later write by the controller keeps it', async () => {
      const grant = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['PUT']
      })
      const resourceUrl = `${collectionUrl}app-doc`
      const created = await invoke({
        who: app,
        url: resourceUrl,
        method: 'PUT',
        capability: grant,
        json: { by: 'app' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did])

      const overwritten = await invoke({
        who: alice,
        url: resourceUrl,
        method: 'PUT',
        json: { by: 'alice' }
      })
      assert.equal(overwritten.status, 200)
      const meta = await readMeta(`${resourceUrl}/meta`)
      assert.deepStrictEqual(meta.createdBy, [app.did])
    })

    it('a two-link delegated create records [app, bob], the controller left out', async () => {
      const first = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['PUT']
      })
      const second = await subGrant({
        parent: first,
        signer: app.signer,
        to: bob.did
      })
      const resourceUrl = `${collectionUrl}bob-doc`
      const created = await invoke({
        who: bob,
        url: resourceUrl,
        method: 'PUT',
        capability: second,
        json: { by: 'bob' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [app.did, bob.did])
      const meta = await readMeta(`${resourceUrl}/meta`)
      assert.deepStrictEqual(meta.createdBy, [app.did, bob.did])
    })

    it('keeps an intermediate delegatee that is the Space controller', async () => {
      const first = await rootGrant({
        target: spaceUrl,
        to: app.did,
        actions: ['PUT']
      })
      const second = await subGrant({
        parent: first,
        signer: app.signer,
        to: alice.did
      })
      const third = await subGrant({
        parent: second,
        signer: alice.signer,
        to: bob.did
      })
      const created = await invoke({
        who: bob,
        url: `${collectionUrl}relayed-doc`,
        method: 'PUT',
        capability: third,
        json: { by: 'bob' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.createdBy, [
        app.did,
        alice.did,
        bob.did
      ])
    })
  })
})
