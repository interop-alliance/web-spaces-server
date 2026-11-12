/**
 * Collection `equality` query-profile tests (Vitest): the plaintext
 * equality query served at `POST /space/:s/:c/query` (the `equality-query`
 * backend feature). Unlike the `blinded-index` profile, the server extracts and
 * indexes the attributes a Collection declares in its `plaintext.indexes` from
 * plaintext JSON Resource content (and `custom` metadata) at query time -- a
 * plain Resource write is immediately queryable.
 *
 * These assert the server's wire contract directly (status codes, problem
 * `type`s / `pointer`s, the `{documents, hasMore, cursor?}` / `{count}` page
 * shapes) via the signed `pws.request()` escape hatch, mirroring
 * `blinded-index-query-api.test.ts` and `encryption-descriptor-api.test.ts`. They
 * cover the `plaintext` member and its `indexes` declaration (validation,
 * update, presence-based mutual exclusion with `encryption`), the query matcher
 * (equals / has, strict typing, multi-valued arrays, blob + custom-sourced
 * matching), count and pagination, the
 * reindex-free declaration-update semantics, and write-time uniqueness.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/pws-client'

import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('Collection equality query profile', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  const spaceId = () => alice.space1.id

  /**
   * Creates a Collection with the given declared `plaintext.indexes` via PUT
   * (create-by-id); the POST create path honors the declaration on the same
   * terms (covered below). A create returns 201 with the persisted description
   * body.
   */
  async function createIndexedCollection(
    collectionId: string,
    indexes: unknown
  ): Promise<any> {
    return createPlaintextCollection(collectionId, { indexes })
  }

  /**
   * Creates a Collection with the given `plaintext` member (any shape, so the
   * validation cases can send malformed ones) via PUT (create-by-id).
   */
  async function createPlaintextCollection(
    collectionId: string,
    plaintext: unknown
  ): Promise<any> {
    return alice.pws.request({
      url: `${baseServerUrl}space/${spaceId()}/${collectionId}/meta`,
      method: 'PUT',
      json: { id: collectionId, name: collectionId, plaintext }
    })
  }

  /** PUTs a JSON Resource by id into a Collection. */
  async function putDoc(
    collectionId: string,
    resourceId: string,
    data: Record<string, unknown>,
    who: any = alice
  ): Promise<any> {
    return who.pws.request({
      url: `${baseServerUrl}space/${spaceId()}/${collectionId}/${resourceId}`,
      method: 'PUT',
      json: { id: resourceId, ...data }
    })
  }

  /** PUTs a binary blob Resource by id (a non-JSON representation). */
  async function putBlob(
    collectionId: string,
    resourceId: string,
    bytes: string,
    contentType = 'image/png'
  ): Promise<any> {
    return alice.pws.request({
      url: `${baseServerUrl}space/${spaceId()}/${collectionId}/${resourceId}`,
      method: 'PUT',
      body: new TextEncoder().encode(bytes),
      headers: { 'content-type': contentType }
    })
  }

  /** PUTs a Resource's `custom` metadata object. */
  async function putMeta(
    collectionId: string,
    resourceId: string,
    custom: Record<string, unknown>
  ): Promise<any> {
    return alice.pws.request({
      url: `${baseServerUrl}space/${spaceId()}/${collectionId}/${resourceId}/meta`,
      method: 'PUT',
      json: { custom }
    })
  }

  /** POSTs an `equality` query body to a Collection's `/query`. */
  async function query(
    collectionId: string,
    body: Record<string, unknown>,
    who: any = alice
  ): Promise<any> {
    return who.pws.request({
      url: `${baseServerUrl}space/${spaceId()}/${collectionId}/query`,
      method: 'POST',
      json: { profile: 'equality', ...body }
    })
  }

  /** Captures the raw error from a `pws.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))

    aliceSpace = await alice.pws.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    // Reference `aliceSpace` so the high-level create is not flagged unused; the
    // suite drives the server through the raw request escape hatch thereafter.
    assert.ok(aliceSpace)
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('plaintext.indexes declaration', () => {
    it('persists and echoes a declared plaintext.indexes array on create, and on GET', async () => {
      const created = await createIndexedCollection('decl-echo', [
        'parentId',
        { name: 'author' },
        { name: 'slug', source: 'content', unique: true }
      ])
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.plaintext, {
        indexes: [
          'parentId',
          { name: 'author' },
          { name: 'slug', source: 'content', unique: true }
        ]
      })
      assert.equal(created.data.indexes, undefined)
      const desc = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-echo/meta`,
        method: 'GET'
      })
      assert.deepStrictEqual(desc.data.plaintext, {
        indexes: [
          'parentId',
          { name: 'author' },
          { name: 'slug', source: 'content', unique: true }
        ]
      })
    })

    it('preserves a plaintext member other than indexes verbatim', async () => {
      // The whole `plaintext` object round-trips, like `encryption`: a member
      // the server does not type yet is stored and echoed, not dropped.
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-extra/meta`,
        method: 'PUT',
        json: {
          id: 'decl-extra',
          name: 'decl-extra',
          plaintext: { indexes: ['parentId'], schema: { type: 'object' } }
        }
      })
      assert.equal(created.status, 201)
      const desc = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-extra/meta`,
        method: 'GET'
      })
      assert.deepStrictEqual(desc.data.plaintext, {
        indexes: ['parentId'],
        schema: { type: 'object' }
      })
    })

    it('a top-level indexes member is ignored, not read or stored', async () => {
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-flat/meta`,
        method: 'PUT',
        json: { id: 'decl-flat', name: 'decl-flat', indexes: ['parentId'] }
      })
      assert.equal(created.status, 201)
      assert.equal(created.data.indexes, undefined)
      assert.equal(created.data.plaintext, undefined)
      const err = await rejection(query('decl-flat', { has: ['parentId'] }))
      assert.equal(err.response.status, 400)
    })

    it('POST create honors plaintext: persists the declaration and enforces the encryption exclusion', async () => {
      // POST /space/:spaceId/ (create with a server- or client-chosen id)
      // validates and persists `plaintext` on the same terms as PUT.
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/`,
        method: 'POST',
        json: { id: 'decl-post', plaintext: { indexes: ['parentId'] } }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual(created.data.plaintext, { indexes: ['parentId'] })
      const desc = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-post/meta`,
        method: 'GET'
      })
      assert.deepStrictEqual(desc.data.plaintext, { indexes: ['parentId'] })

      // The plaintext/encryption mutual exclusion holds on POST create too,
      // by presence: an empty `plaintext` still excludes `encryption`.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/`,
          method: 'POST',
          json: {
            id: 'decl-post-encrypted',
            plaintext: {},
            encryption: { scheme: 'edv' }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext')
    })

    it('plaintext is updatable: a supplied object replaces it, an absent one leaves it untouched, {} is the empty state', async () => {
      await createIndexedCollection('decl-clear', ['parentId'])
      // A name-only update does not touch the stored `plaintext`.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
        method: 'PUT',
        json: { id: 'decl-clear', name: 'Renamed' }
      })
      let desc = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
        method: 'GET'
      })
      assert.deepStrictEqual(desc.data.plaintext, { indexes: ['parentId'] })
      assert.equal(desc.data.name, 'Renamed')

      // A changed declaration replaces the stored one.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
        method: 'PUT',
        json: { id: 'decl-clear', plaintext: { indexes: ['author'] } }
      })
      desc = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
        method: 'GET'
      })
      assert.deepStrictEqual(desc.data.plaintext, { indexes: ['author'] })

      // `{}` is the empty state: the member stays present with no
      // declaration, and a later query naming the old attribute now 400s.
      // An update still cannot add `encryption`: the descriptor is
      // creation-only (409 `encryption-immutable`).
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
        method: 'PUT',
        json: { id: 'decl-clear', plaintext: {} }
      })
      desc = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
        method: 'GET'
      })
      assert.deepStrictEqual(desc.data.plaintext, {})
      const err = await rejection(query('decl-clear', { has: ['author'] }))
      assert.equal(err.response.status, 400)
      const enc = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/decl-clear/meta`,
          method: 'PUT',
          json: { id: 'decl-clear', encryption: { scheme: 'edv' } }
        })
      )
      assert.equal(enc.response.status, 409)
      assert.match(enc.data.type, /#encryption-immutable/)
      assert.equal(enc.data.errors?.[0]?.pointer, '#/encryption')
    })

    it('rejects a non-object plaintext (400, pointer #/plaintext)', async () => {
      const err = await rejection(
        createPlaintextCollection('bad-plaintext', ['parentId'])
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext')
    })

    it('rejects a non-array indexes (400, pointer #/plaintext/indexes)', async () => {
      const err = await rejection(createIndexedCollection('bad-notarray', 'x'))
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext/indexes')
    })

    it('rejects an empty-string entry (400, pointer #/plaintext/indexes/0)', async () => {
      const err = await rejection(createIndexedCollection('bad-empty', ['']))
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext/indexes/0')
    })

    it('rejects an object entry with no name (400, pointer #/plaintext/indexes/2/name)', async () => {
      const err = await rejection(
        createIndexedCollection('bad-noname', ['a', 'b', { source: 'content' }])
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext/indexes/2/name')
    })

    it('rejects a bad source (400, pointer #/plaintext/indexes/0/source)', async () => {
      const err = await rejection(
        createIndexedCollection('bad-source', [
          { name: 'x', source: 'elsewhere' }
        ])
      )
      assert.equal(err.response.status, 400)
      assert.equal(
        err.data.errors?.[0]?.pointer,
        '#/plaintext/indexes/0/source'
      )
    })

    it('rejects a non-boolean unique (400, pointer #/plaintext/indexes/0/unique)', async () => {
      const err = await rejection(
        createIndexedCollection('bad-unique', [{ name: 'x', unique: 'yes' }])
      )
      assert.equal(err.response.status, 400)
      assert.equal(
        err.data.errors?.[0]?.pointer,
        '#/plaintext/indexes/0/unique'
      )
    })

    it('rejects duplicate names across the array regardless of source (400)', async () => {
      const err = await rejection(
        createIndexedCollection('bad-dup', [
          'tag',
          { name: 'tag', source: 'custom' }
        ])
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext/indexes/1/name')
    })

    it('rejects declaring plaintext together with an encryption descriptor (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/mx-create/meta`,
          method: 'PUT',
          json: {
            id: 'mx-create',
            plaintext: { indexes: ['parentId'] },
            encryption: { scheme: 'edv' }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext')
    })

    it('rejects adding plaintext to an already-encrypted Collection (400), even an empty one', async () => {
      const descriptor = { scheme: 'edv' }
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/mx-enc-first/meta`,
        method: 'PUT',
        json: { id: 'mx-enc-first', encryption: descriptor }
      })
      // `encryption` is creation-only and cleared by omission (`PUT .../meta`
      // is a full replacement), so every update must resend it -- this test
      // exercises the mutual-exclusion check, not that immutability rail, so
      // both requests carry the descriptor forward alongside `plaintext`.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/mx-enc-first/meta`,
          method: 'PUT',
          json: {
            id: 'mx-enc-first',
            encryption: descriptor,
            plaintext: { indexes: ['parentId'] }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/plaintext')
      const empty = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/mx-enc-first/meta`,
          method: 'PUT',
          json: { id: 'mx-enc-first', encryption: descriptor, plaintext: {} }
        })
      )
      assert.equal(empty.response.status, 400)
      assert.equal(empty.data.errors?.[0]?.pointer, '#/plaintext')
    })

    it('rejects adding an encryption descriptor to an already-indexed Collection (409, creation-only)', async () => {
      // The creation-only rule refuses the update before the exclusion
      // check is reached.
      await createIndexedCollection('mx-idx-first', ['parentId'])
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/mx-idx-first/meta`,
          method: 'PUT',
          json: { id: 'mx-idx-first', encryption: { scheme: 'edv' } }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#encryption-immutable/)
    })
  })

  describe('equals / has matching', () => {
    it('returns matching JSON documents (data present) in ascending id order with hasMore false', async () => {
      await createIndexedCollection('m-basic', ['parentId', 'author'])
      await putDoc('m-basic', 'gamma', { parentId: 'p1', author: 'alice' })
      await putDoc('m-basic', 'alpha', { parentId: 'p1', author: 'bob' })
      await putDoc('m-basic', 'beta', { parentId: 'p2', author: 'alice' })

      const { data } = await query('m-basic', { equals: [{ parentId: 'p1' }] })
      assert.deepEqual(
        data.documents.map((doc: any) => doc.id),
        ['alpha', 'gamma']
      )
      assert.equal(data.hasMore, false)
      assert.equal(data.cursor, undefined)
      // `data` carries the stored JSON content verbatim; no `custom`.
      assert.deepEqual(data.documents[0].data, {
        id: 'alpha',
        parentId: 'p1',
        author: 'bob'
      })
      assert.equal(data.documents[0].custom, undefined)
    })

    it('equals is a disjunction across elements and a conjunction within one', async () => {
      await createIndexedCollection('m-orand', ['parentId', 'author'])
      await putDoc('m-orand', 'r1', { parentId: 'p1', author: 'alice' })
      await putDoc('m-orand', 'r2', { parentId: 'p2', author: 'carol' })
      await putDoc('m-orand', 'r3', { parentId: 'p1', author: 'dave' })

      // OR across two elements.
      const or = await query('m-orand', {
        equals: [{ parentId: 'p2' }, { author: 'dave' }]
      })
      assert.deepEqual(
        or.data.documents.map((doc: any) => doc.id),
        ['r2', 'r3']
      )

      // AND within one element.
      const and = await query('m-orand', {
        equals: [{ parentId: 'p1', author: 'alice' }]
      })
      assert.deepEqual(
        and.data.documents.map((doc: any) => doc.id),
        ['r1']
      )
    })

    it('an empty equals element matches nothing', async () => {
      await createIndexedCollection('m-empty', ['parentId'])
      await putDoc('m-empty', 'r1', { parentId: 'p1' })
      const { data } = await query('m-empty', { equals: [{}] })
      assert.deepEqual(data.documents, [])
      assert.equal(data.hasMore, false)
    })

    it('has matches Resources carrying every named attribute with an indexable value', async () => {
      await createIndexedCollection('m-has', ['parentId', 'author'])
      await putDoc('m-has', 'both', { parentId: 'p1', author: 'alice' })
      await putDoc('m-has', 'onlyparent', { parentId: 'p1' })
      // A null value is not indexable, so `author` is absent for matching.
      await putDoc('m-has', 'nullauthor', { parentId: 'p1', author: null })

      const { data } = await query('m-has', { has: ['parentId', 'author'] })
      assert.deepEqual(
        data.documents.map((doc: any) => doc.id),
        ['both']
      )
    })

    it('matches multi-valued (array) attributes per element', async () => {
      await createIndexedCollection('m-multi', ['tags'])
      await putDoc('m-multi', 'r1', { tags: ['red', 'green'] })
      await putDoc('m-multi', 'r2', { tags: ['blue'] })

      const red = await query('m-multi', { equals: [{ tags: 'red' }] })
      assert.deepEqual(
        red.data.documents.map((doc: any) => doc.id),
        ['r1']
      )
      // Both carry an indexable `tags` array.
      const has = await query('m-multi', { has: ['tags'] })
      assert.deepEqual(
        has.data.documents.map((doc: any) => doc.id),
        ['r1', 'r2']
      )
    })

    it('matches by strict JSON type (no coercion): "1" != 1, true != "true"', async () => {
      await createIndexedCollection('m-strict', ['count', 'active'])
      await putDoc('m-strict', 'num', { count: 1, active: true })
      await putDoc('m-strict', 'str', { count: '1', active: 'true' })

      const numMatch = await query('m-strict', { equals: [{ count: 1 }] })
      assert.deepEqual(
        numMatch.data.documents.map((doc: any) => doc.id),
        ['num']
      )
      const strMatch = await query('m-strict', { equals: [{ count: '1' }] })
      assert.deepEqual(
        strMatch.data.documents.map((doc: any) => doc.id),
        ['str']
      )
      const boolMatch = await query('m-strict', { equals: [{ active: true }] })
      assert.deepEqual(
        boolMatch.data.documents.map((doc: any) => doc.id),
        ['num']
      )
      const boolStr = await query('m-strict', { equals: [{ active: 'true' }] })
      assert.deepEqual(
        boolStr.data.documents.map((doc: any) => doc.id),
        ['str']
      )
    })

    it('matches a blob Resource via its custom-sourced attribute ({ id, custom }, no data)', async () => {
      // The server's plaintext `custom` metadata is limited to `{ name, tags }`,
      // so `name` is the indexable custom-sourced attribute (a blob has no
      // extractable JSON content).
      await createIndexedCollection('m-blob', [
        { name: 'name', source: 'custom' }
      ])
      await putBlob('m-blob', 'photo1', 'PNGBYTES')
      await putMeta('m-blob', 'photo1', { name: 'vacation' })
      await putBlob('m-blob', 'photo2', 'PNGBYTES2')
      await putMeta('m-blob', 'photo2', { name: 'work' })

      const { data } = await query('m-blob', { equals: [{ name: 'vacation' }] })
      assert.equal(data.documents.length, 1)
      const [doc] = data.documents
      assert.equal(doc.id, 'photo1')
      assert.equal(doc.data, undefined) // a blob carries no `data`
      assert.deepEqual(doc.custom, { name: 'vacation' })
    })
  })

  describe('count and pagination', () => {
    it('count: true returns a bare { count }', async () => {
      await createIndexedCollection('c-count', ['parentId'])
      await putDoc('c-count', 'a', { parentId: 'p1' })
      await putDoc('c-count', 'b', { parentId: 'p1' })
      await putDoc('c-count', 'c', { parentId: 'p2' })

      const { data } = await query('c-count', {
        equals: [{ parentId: 'p1' }],
        count: true
      })
      assert.deepEqual(data, { count: 2 })
    })

    it('paginates with the opaque cursor riding the signed body', async () => {
      await createIndexedCollection('c-page', ['parentId'])
      await putDoc('c-page', 'a', { parentId: 'p1' })
      await putDoc('c-page', 'b', { parentId: 'p1' })
      await putDoc('c-page', 'c', { parentId: 'p1' })

      const page1 = await query('c-page', {
        equals: [{ parentId: 'p1' }],
        limit: 2
      })
      assert.deepEqual(
        page1.data.documents.map((doc: any) => doc.id),
        ['a', 'b']
      )
      assert.equal(page1.data.hasMore, true)
      assert.ok(page1.data.cursor, 'expected a cursor on a non-final page')

      const page2 = await query('c-page', {
        equals: [{ parentId: 'p1' }],
        limit: 2,
        cursor: page1.data.cursor
      })
      assert.deepEqual(
        page2.data.documents.map((doc: any) => doc.id),
        ['c']
      )
      assert.equal(page2.data.hasMore, false)
      assert.equal(page2.data.cursor, undefined)
    })

    it('rejects a malformed cursor with 400 invalid-cursor', async () => {
      await createIndexedCollection('c-badcursor', ['parentId'])
      await putDoc('c-badcursor', 'a', { parentId: 'p1' })
      const err = await rejection(
        query('c-badcursor', { has: ['parentId'], cursor: 'not!!valid' })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-cursor/)
    })
  })

  describe('malformed query bodies', () => {
    it('rejects neither / both of equals and has (400)', async () => {
      await createIndexedCollection('q-bad', ['parentId'])
      const neither = await rejection(query('q-bad', {}))
      assert.equal(neither.response.status, 400)
      const both = await rejection(
        query('q-bad', { equals: [{ parentId: 'p1' }], has: ['parentId'] })
      )
      assert.equal(both.response.status, 400)
    })

    it('rejects a non-indexable equals value (400)', async () => {
      await createIndexedCollection('q-badval', ['parentId'])
      const err = await rejection(
        query('q-badval', { equals: [{ parentId: { nested: true } }] })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects an undeclared attribute in equals or has (fail-closed 400)', async () => {
      await createIndexedCollection('q-undeclared', ['parentId'])
      const eq = await rejection(
        query('q-undeclared', { equals: [{ author: 'x' }] })
      )
      assert.equal(eq.response.status, 400)
      assert.match(eq.data.type, /#invalid-request-body/)
      const has = await rejection(query('q-undeclared', { has: ['author'] }))
      assert.equal(has.response.status, 400)
    })

    it('a Collection with no declared indexes fails every named attribute (400)', async () => {
      // A plain Collection created without `plaintext`.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/`,
        method: 'POST',
        json: { id: 'q-noindexes', name: 'q-noindexes' }
      })
      const err = await rejection(query('q-noindexes', { has: ['parentId'] }))
      assert.equal(err.response.status, 400)
    })

    it('answers an equality query against an encrypted Collection with 501', async () => {
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/q-encrypted/meta`,
        method: 'PUT',
        json: { id: 'q-encrypted', encryption: { scheme: 'edv' } }
      })
      const err = await rejection(query('q-encrypted', { has: ['anything'] }))
      assert.equal(err.response.status, 501)
      assert.match(err.data.type, /#unsupported-operation/)
    })
  })

  describe('reindex-free declaration update', () => {
    it('adding an index entry later makes pre-existing Resources queryable immediately', async () => {
      await createIndexedCollection('u-reindex', ['parentId'])
      await putDoc('u-reindex', 'r1', { parentId: 'p1', author: 'alice' })
      await putDoc('u-reindex', 'r2', { parentId: 'p1', author: 'bob' })

      // Before declaring `author`, querying it is a fail-closed 400.
      const before = await rejection(
        query('u-reindex', { equals: [{ author: 'alice' }] })
      )
      assert.equal(before.response.status, 400)

      // Declare `author` (no reindex, no rewrite of the Resources).
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/u-reindex/meta`,
        method: 'PUT',
        json: {
          id: 'u-reindex',
          plaintext: { indexes: ['parentId', 'author'] }
        }
      })

      // The pre-existing Resources are immediately queryable on the new attr.
      const after = await query('u-reindex', { equals: [{ author: 'alice' }] })
      assert.deepEqual(
        after.data.documents.map((doc: any) => doc.id),
        ['r1']
      )
    })
  })

  describe('authorization', () => {
    it('is capability-only: an authenticated non-controller is denied (404) even on a PublicCanRead Collection', async () => {
      await createIndexedCollection('a-public', ['parentId'])
      await putDoc('a-public', 'r1', { parentId: 'p1' })
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId()}/a-public/policy`,
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      // Bob's capability does not verify; the read-granting policy does not
      // cover the POST query (a write-action authorize path), so 404.
      const err = await rejection(query('a-public', { has: ['parentId'] }, bob))
      assert.equal(err.response.status, 404)
    })
  })

  describe('write-time uniqueness', () => {
    it('a content-sourced unique claim held by another Resource is a 409; self re-assert and absent values are not', async () => {
      await createIndexedCollection('uq-content', [
        { name: 'slug', unique: true }
      ])
      await putDoc('uq-content', 'holder', { slug: 'hello' })

      // A different Resource claiming the same (name, value) is a 409.
      const conflict = await rejection(
        putDoc('uq-content', 'claimant', { slug: 'hello' })
      )
      assert.equal(conflict.response.status, 409)
      assert.match(conflict.data.type, /#id-conflict/)

      // The holder re-asserting its own value is not a self-conflict.
      const reassert = await putDoc('uq-content', 'holder', { slug: 'hello' })
      assert.equal(reassert.status, 200)

      // A Resource whose unique attribute is absent makes no claim.
      const noClaim = await putDoc('uq-content', 'noclaim', { other: 'x' })
      assert.equal(noClaim.status, 201)

      // A multi-valued unique value claims each element: a second array sharing
      // one element conflicts.
      await createIndexedCollection('uq-multi', [{ name: 'ref', unique: true }])
      await putDoc('uq-multi', 'a', { ref: ['x', 'y'] })
      const multiConflict = await rejection(
        putDoc('uq-multi', 'b', { ref: ['y', 'z'] })
      )
      assert.equal(multiConflict.response.status, 409)
    })

    it('a custom-sourced unique claim enforces on the metadata PUT path (409)', async () => {
      await createIndexedCollection('uq-custom', [
        { name: 'name', source: 'custom', unique: true }
      ])
      await putDoc('uq-custom', 'r1', {})
      await putDoc('uq-custom', 'r2', {})

      const first = await putMeta('uq-custom', 'r1', { name: 'dup' })
      assert.equal(first.status, 200)
      const conflict = await rejection(
        putMeta('uq-custom', 'r2', { name: 'dup' })
      )
      assert.equal(conflict.response.status, 409)
      // The same Resource re-asserting its own value is not a conflict.
      const reassert = await putMeta('uq-custom', 'r1', { name: 'dup' })
      assert.equal(reassert.status, 200)

      // A claim on an absent Resource is the masked 404, not the 409: the
      // existence check runs before the uniqueness scan.
      const absent = await rejection(
        putMeta('uq-custom', 'no-such-resource', { name: 'dup' })
      )
      assert.equal(absent.response.status, 404)
    })

    it('adding a unique claim over already-conflicting stored Resources is a 409', async () => {
      // Declare `slug` non-unique first, then store two Resources sharing a slug.
      await createIndexedCollection('uq-add', ['slug'])
      await putDoc('uq-add', 'r1', { slug: 'same' })
      await putDoc('uq-add', 'r2', { slug: 'same' })

      // Promoting `slug` to unique must be rejected: the stored Resources
      // already violate it.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId()}/uq-add/meta`,
          method: 'PUT',
          json: {
            id: 'uq-add',
            plaintext: { indexes: [{ name: 'slug', unique: true }] }
          }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#id-conflict/)
    })
  })
})
