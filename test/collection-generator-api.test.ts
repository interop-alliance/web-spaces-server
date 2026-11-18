/**
 * Collection app-attribution API tests (Vitest): the server's accept /
 * validate / persist / echo handling of the OPTIONAL `generator` object
 * (`{ id, origin?, url?, name? }`) of a Collection Metadata object (spec "Collection
 * Data Model"). It is an assertion by the Space controller -- writable at
 * create AND on update (so a wallet can backfill an existing Collection),
 * stored verbatim, never verified by the server and never an authorization
 * input -- in contrast to the server-observed, read-only `createdBy`, which
 * these writes must leave untouched. An update carrying `generator` replaces
 * the whole object; one omitting it keeps the stored value.
 *
 * These assert the server's wire contract directly (status codes, problem
 * `type`s, pointers, the echoed Metadata object) via the signed `pws.request()`
 * escape hatch (raw `HttpResponse` / raw errors).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('Collection generator attribution API', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  const spaceId = `generator-space-${crypto.randomUUID()}`
  const generator = {
    id: 'did:key:zAppKeyExample',
    origin: 'https://app.example.com',
    url: 'https://app.example.com/notes',
    name: 'Notes'
  }
  const other = { id: 'did:key:zOtherApp' }

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))

    await alice.pws.createSpace({
      id: spaceId,
      name: 'Generator Attribution Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /**
   * Reads a Collection Metadata object over the wire (raw JSON).
   */
  async function readDesc(collectionId: string): Promise<any> {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    return response.data
  }

  /**
   * Captures the raw error from a `pws.request()` rejection.
   */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /**
   * Creates a Collection with the given body members.
   */
  async function create(json: Record<string, unknown>): Promise<any> {
    return alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json
    })
  }

  /**
   * Replaces a Collection's Metadata object with the given body.
   */
  async function put(
    collectionId: string,
    json: Record<string, unknown>
  ): Promise<any> {
    return alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'PUT',
      json: { id: collectionId, ...json }
    })
  }

  it('persists and echoes the whole object on create', async () => {
    const response = await create({
      id: 'app-notes',
      name: 'App Notes',
      generator
    })
    assert.equal(response.status, 201)
    assert.deepEqual(response.data.generator, generator)
    assert.equal(response.data.generatorOrigin, undefined)
    assert.deepEqual((await readDesc('app-notes')).generator, generator)
  })

  it('accepts an id-only object and an id-plus-origin object', async () => {
    await create({ id: 'id-only', generator: other })
    assert.deepEqual((await readDesc('id-only')).generator, other)
    const withOrigin = { id: generator.id, origin: generator.origin }
    await create({ id: 'id-origin', generator: withOrigin })
    assert.deepEqual((await readDesc('id-origin')).generator, withOrigin)
  })

  it('omits the member when the create sent none', async () => {
    await create({ id: 'unattributed', name: 'Unattributed' })
    assert.equal((await readDesc('unattributed')).generator, undefined)
  })

  it('stamps attribution onto an existing collection that lacked it (backfill)', async () => {
    await create({ id: 'backfill', name: 'Backfill' })
    const response = await put('backfill', { name: 'Backfill', generator })
    assert.equal(response.status, 204)
    const desc = await readDesc('backfill')
    assert.deepEqual(desc.generator, generator)
    assert.equal(desc.name, 'Backfill')
  })

  it('replaces the whole stored object when an update supplies one', async () => {
    await create({ id: 'reattributed', generator })
    const response = await put('reattributed', { generator: other })
    assert.equal(response.status, 204)
    // The stored `origin` and `url` are not merged into the new object.
    assert.deepEqual((await readDesc('reattributed')).generator, other)
  })

  it('keeps the stored object when an update omits it', async () => {
    await create({ id: 'name-only-update', name: 'Before', generator })
    const response = await put('name-only-update', { name: 'After' })
    assert.equal(response.status, 204)
    const desc = await readDesc('name-only-update')
    assert.equal(desc.name, 'After')
    assert.deepEqual(desc.generator, generator)
  })

  it('creates a collection by id with attribution (PUT create branch)', async () => {
    const response = await put('put-created', { generator })
    assert.equal(response.status, 201)
    assert.deepEqual((await readDesc('put-created')).generator, generator)
  })

  it('leaves the server-observed createdBy untouched by an attribution write', async () => {
    await create({ id: 'provenance', generator })
    assert.deepEqual((await readDesc('provenance')).createdBy, [alice.did])
    await put('provenance', { generator: other })
    const desc = await readDesc('provenance')
    assert.deepEqual(desc.createdBy, [alice.did])
    assert.deepEqual(desc.generator, other)
  })

  describe('validation', () => {
    const cases: {
      name: string
      generator: unknown
      pointer: string
    }[] = [
      { name: 'a string', generator: generator.id, pointer: '#/generator' },
      { name: 'an array', generator: [generator], pointer: '#/generator' },
      { name: 'null', generator: null, pointer: '#/generator' },
      {
        name: 'a missing id',
        generator: { origin: generator.origin },
        pointer: '#/generator/id'
      },
      {
        name: 'a non-DID id',
        generator: { id: 'https://app.example.com' },
        pointer: '#/generator/id'
      },
      {
        name: 'an empty id',
        generator: { id: '' },
        pointer: '#/generator/id'
      },
      {
        name: 'an origin carrying a path',
        generator: { id: generator.id, origin: 'https://app.example.com/app' },
        pointer: '#/generator/origin'
      },
      {
        name: 'an origin with a trailing slash',
        generator: { id: generator.id, origin: 'https://app.example.com/' },
        pointer: '#/generator/origin'
      },
      {
        name: 'a non-string origin',
        generator: { id: generator.id, origin: 42 },
        pointer: '#/generator/origin'
      },
      {
        name: 'a url without an origin',
        generator: { id: generator.id, url: generator.url },
        pointer: '#/generator/url'
      },
      {
        name: 'a url on another origin',
        generator: {
          id: generator.id,
          origin: generator.origin,
          url: 'https://other.example.com/notes'
        },
        pointer: '#/generator/url'
      },
      {
        name: 'a url with a query',
        generator: { ...generator, url: `${generator.url}?tab=1` },
        pointer: '#/generator/url'
      },
      {
        name: 'a url with an empty query',
        generator: { ...generator, url: `${generator.url}?` },
        pointer: '#/generator/url'
      },
      {
        name: 'a url with a fragment',
        generator: { ...generator, url: `${generator.url}#top` },
        pointer: '#/generator/url'
      },
      {
        name: 'a url with an empty fragment',
        generator: { ...generator, url: `${generator.url}#` },
        pointer: '#/generator/url'
      },
      {
        name: 'a non-http(s) url',
        generator: {
          id: generator.id,
          origin: generator.origin,
          url: 'ftp://app.example.com/notes'
        },
        pointer: '#/generator/url'
      },
      {
        name: 'a relative url',
        generator: { ...generator, url: '/notes' },
        pointer: '#/generator/url'
      },
      {
        name: 'a non-string url',
        generator: { ...generator, url: 42 },
        pointer: '#/generator/url'
      },
      {
        name: 'an empty name',
        generator: { ...generator, name: '' },
        pointer: '#/generator/name'
      },
      {
        name: 'a non-string name',
        generator: { ...generator, name: 42 },
        pointer: '#/generator/name'
      },
      {
        name: 'an unknown member',
        generator: { ...generator, label: 'Notes' },
        pointer: '#/generator/label'
      }
    ]

    for (const [index, testCase] of cases.entries()) {
      it(`rejects ${testCase.name} (400)`, async () => {
        const err = await rejection(
          create({
            id: `bad-generator-${index}`,
            generator: testCase.generator
          })
        )
        assert.equal(err.response.status, 400)
        assert.match(err.data.type, /#invalid-request-body/)
        assert.equal(err.data.errors?.[0]?.pointer, testCase.pointer)
      })
    }

    it('does not persist a flat top-level generatorOrigin member', async () => {
      // A top-level member outside the Collection Metadata vocabulary is
      // ignored, not stored.
      const response = await create({
        id: 'flat-origin',
        generatorOrigin: 'https://app.example.com'
      })
      assert.equal(response.status, 201)
      assert.equal((await readDesc('flat-origin')).generatorOrigin, undefined)
    })

    it('rejects an invalid value on update too, leaving the stored one intact', async () => {
      await create({ id: 'update-validated', generator })
      const err = await rejection(
        put('update-validated', { generator: { id: 'not-a-did' } })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/generator/id')
      assert.deepEqual(
        (await readDesc('update-validated')).generator,
        generator
      )
    })
  })
})
