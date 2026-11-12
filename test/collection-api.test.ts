/**
 * Collections API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { NotFoundError } from '@interop/pws-client'
import type { Space } from '@interop/pws-client'
import type { CollectionMetadata } from '@interop/storage-core'

import type { TempFileSystemBackend } from '../src/testing.js'
import {
  assertEtagAdvanced,
  parseEtagSegments,
  etagGeneration,
  openTempBackend,
  requestError,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Collections API', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    alice: any,
    bob: any,
    aliceSpace: Space

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))

    // Provision the Space this suite operates on. This suite uses its own
    // temp dataDir, so it must create the Space here rather than relying on
    // filesystem state left behind by other test files.
    aliceSpace = await alice.pws.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('POST /space/:spaceId/ with no authorization headers is the masked not-found (404)', async () => {
    const response = await fetch(
      new URL('/space/any-space-id/', baseServerUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Anonymous Collection' })
      }
    )
    assert.equal(response.status, 404)
    assert.match(
      response.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  it('POST /space/:spaceId/ should fail (NotFoundError) on not found space id', async () => {
    // Adding a collection to a missing space is a write -- PWS does not
    // auto-create parents, so it surfaces as NotFoundError (server 404).
    await assert.rejects(
      alice.pws
        .space('space-id-that-does-not-exist')
        .createCollection({ name: 'Test Collection' }),
      (err: unknown) => err instanceof NotFoundError
    )
  })

  it('POST responses carry Cache-Control: no-store (non-idempotent, non-cacheable)', async () => {
    const collectionId = crypto.randomUUID()
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${alice.space1.id}/`,
      method: 'POST',
      json: { id: collectionId, name: 'No Store' }
    })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')

    // A failed POST is marked the same way; a read is not marked at all.
    const conflict = await responseOf(
      alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Conflict' }
      })
    )
    assert.equal(conflict.status, 409)
    assert.equal(conflict.headers.get('cache-control'), 'no-store')
    const read = await alice.pws.request({
      url: `${baseServerUrl}space/${alice.space1.id}/${collectionId}/`,
      method: 'GET'
    })
    assert.equal(read.headers.get('cache-control'), null)

    // Only a non-idempotent POST is marked: a slash-variant redirect performs
    // nothing, and Query and Export are reads that use POST to carry a body.
    // The redirect sits behind the auth-headers presence and parse gates but
    // before verification, so a well-formed, unsigned pair reaches it.
    const redirect = await fetch(
      new URL(`/space/${alice.space1.id}`, baseServerUrl),
      {
        method: 'POST',
        headers: {
          authorization:
            'Signature keyId="did:key:z6MkProbe#z6MkProbe",' +
            'headers="(request-target)",signature="cHJvYmU="',
          'capability-invocation': 'zcap id="urn:zcap:root:probe"'
        },
        redirect: 'manual'
      }
    )
    assert.equal(redirect.status, 308)
    assert.equal(redirect.headers.get('cache-control'), null)
    const query = await alice.pws.request({
      url: `${baseServerUrl}space/${alice.space1.id}/${collectionId}/query`,
      method: 'POST',
      json: { profile: 'changes' }
    })
    assert.equal(query.status, 200)
    assert.equal(query.headers.get('cache-control'), null)
    const exported = await alice.pws.request({
      url: `${baseServerUrl}space/${alice.space1.id}/export`,
      method: 'POST'
    })
    assert.equal(exported.status, 200)
    assert.equal(exported.headers.get('cache-control'), null)
  })

  it('[root] create collection via POST', async () => {
    const collection = await aliceSpace.createCollection({
      id: 'credentials',
      name: 'Verifiable Credentials'
    })
    assert.equal(collection.id, 'credentials')
    // The merged Collection Metadata object carries its timestamps, and the
    // client surfaces the object's one `ETag` alongside it.
    const {
      createdAt,
      updatedAt,
      updatedAtCounter,
      originId,
      etag,
      created,
      ...description
    } = (await collection.describe())! as CollectionMetadata & { etag?: string }
    assert.ok(!Number.isNaN(Date.parse(createdAt!)))
    assert.equal(updatedAt, createdAt)
    // The creating stamp is the first write's whole stamp.
    assert.deepStrictEqual(created, { updatedAt, updatedAtCounter, originId })
    assert.equal(updatedAtCounter, 0)
    assert.equal(typeof originId, 'string')
    parseEtagSegments(etag ?? null, { container: true })
    assert.deepStrictEqual(description, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection'],
      backend: { id: 'default' },
      createdBy: alice.did,
      url: `/space/${alice.space1.id}/credentials/`,
      linkset: `/space/${alice.space1.id}/credentials/linkset`
    })
  })

  it('POST with an existing collection id yields id-conflict (409)', async () => {
    const collectionId = crypto.randomUUID()
    await aliceSpace.createCollection({
      id: collectionId,
      name: 'Conflict Test Collection'
    })

    let expectedError: any
    try {
      await alice.pws.request({
        url: new URL(`/space/${alice.space1.id}/`, baseServerUrl).toString(),
        method: 'POST',
        json: { id: collectionId, name: 'Replacement' }
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the duplicate-id POST to be rejected')
    assert.equal(expectedError.response.status, 409)
    assert.equal(expectedError.data.type, 'https://w3id.org/pws#id-conflict')
    assert.equal(expectedError.data.errors[0].pointer, '#/id')

    // The Collection Metadata object is untouched.
    const description = await aliceSpace.collection(collectionId).describe()
    assert.equal(description!.name, 'Conflict Test Collection')
  })

  it('[root] list collection items via GET :collectionId/', async () => {
    const listing = await aliceSpace.collection('credentials').list()
    assert.ok(listing)
    assert.equal(listing.id, 'credentials')
    assert.equal(listing.url, `/space/${alice.space1.id}/credentials/`)
    assert.equal(listing.name, 'Verifiable Credentials')
    assert.deepStrictEqual(listing.type, ['Collection'])
    assert.equal(typeof listing.totalItems, 'number')
    assert.ok(Array.isArray(listing.items))
    assert.equal(listing.totalItems, listing.items.length)
  })

  it('[root] space.collections() lists the Space collections with the listing shape', async () => {
    // A fresh Space so the listing holds exactly the one Collection created
    // here, letting the full List Collections shape be asserted exactly (the
    // high-level client path; the raw wire form is pinned by the pagination
    // suite). This is the only place the `space.collections()` listing shape --
    // its `url`, `totalItems`, and per-entry `{ id, url, name, public }` -- is
    // asserted. `public` is `false` here (no `PublicCanRead` policy attached).
    const spaceId = crypto.randomUUID()
    const collectionId = crypto.randomUUID()
    const resourceId = crypto.randomUUID()
    const space = await alice.pws.createSpace({
      id: spaceId,
      name: 'List Collections Test Space',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: collectionId,
      name: 'List Collections Test Collection'
    })
    await collection.put(resourceId, {
      id: resourceId,
      name: 'List Collections Test Resource'
    })

    assert.deepStrictEqual(await space.collections(), {
      url: `/space/${spaceId}/`,
      totalItems: 1,
      items: [
        {
          id: collectionId,
          url: `/space/${spaceId}/${collectionId}/`,
          name: 'List Collections Test Collection',
          public: false
        }
      ]
    })
  })

  it('[root] get the Collection Metadata object via GET :collectionId/meta', async () => {
    const {
      createdAt,
      updatedAt,
      updatedAtCounter,
      originId,
      etag,
      created,
      ...description
    } = (await aliceSpace
      .collection('credentials')
      .describe())! as CollectionMetadata & { etag?: string }
    assert.equal(created?.updatedAt, createdAt)
    assert.ok(!Number.isNaN(Date.parse(createdAt!)))
    assert.ok(!Number.isNaN(Date.parse(updatedAt!)))
    assert.equal(typeof updatedAtCounter, 'number')
    assert.equal(typeof originId, 'string')
    parseEtagSegments(etag ?? null, { container: true })
    assert.deepStrictEqual(description, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection'],
      backend: { id: 'default' },
      createdBy: alice.did,
      url: `/space/${alice.space1.id}/credentials/`,
      linkset: `/space/${alice.space1.id}/credentials/linkset`
    })
  })

  it('[root] a PUT whose body carries a forged createdBy does not change the stored value', async () => {
    const collectionId = crypto.randomUUID()
    await aliceSpace.createCollection({
      id: collectionId,
      name: 'Forged createdBy Collection'
    })

    await alice.pws.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}/meta`,
        baseServerUrl
      ).toString(),
      method: 'PUT',
      json: { name: 'Renamed', createdBy: 'did:key:zEVIL' }
    })

    const description = await aliceSpace.collection(collectionId).describe()
    assert.equal(description?.createdBy, alice.did)
    assert.equal(description?.name, 'Renamed')
  })

  it('[root] create and delete a collection by id', async () => {
    const collection = aliceSpace.collection('new-collection')

    // Create new collection by id (upsert via configure -> PUT).
    await collection.configure({ name: 'New Collection', force: true })

    // Check it was created
    assert.notEqual(await collection.describe(), null)

    // Now delete collection
    await collection.delete()

    // Ensure it was deleted (reads return null on 404).
    assert.equal(await collection.describe(), null)

    // Deleting an already-deleted Collection answers 404 (it left a
    // tombstone), which the client's idempotent delete treats as done; it
    // does not 500 with an underlying ENOENT.
    await collection.delete()
    assert.equal(await collection.describe(), null)
  })

  it('a Collection re-created over its tombstone starts a new generation', async () => {
    const collectionId = crypto.randomUUID()
    const metaUrl = `${baseServerUrl}space/${alice.space1.id}/${collectionId}/meta`

    const created = await alice.pws.request({
      url: `${baseServerUrl}space/${alice.space1.id}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Regenerated' }
    })
    const oldEtag = created.headers.get('etag')!
    assert.ok(oldEtag, 'POST returns a Collection Metadata ETag')

    await aliceSpace.collection(collectionId).delete()

    // Re-creating under the same id starts a fresh Collection Metadata record:
    // no generation survives a hard Collection delete.
    await alice.pws.request({
      url: `${baseServerUrl}space/${alice.space1.id}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Regenerated Again' }
    })

    // The old validator names a generation the re-created Collection no
    // longer carries, so a conditional GET with it is the full Collection
    // Metadata object, never a 304.
    const conditional = await responseOf(
      alice.pws.request({
        url: metaUrl,
        method: 'GET',
        headers: { 'if-none-match': oldEtag }
      })
    )
    assert.equal(conditional.status, 200)
    const newEtag = conditional.headers.get('etag')
    assert.ok(newEtag, 'GET returns a Collection Metadata ETag')
    assert.notEqual(etagGeneration(newEtag!), etagGeneration(oldEtag))
  })

  it('[root] PUT with If-None-Match: * creates an absent Collection and 412s on a present one', async () => {
    const collectionId = 'guarded-collection'
    const metaUrl = `${baseServerUrl}space/${alice.space1.id}/${collectionId}/meta`

    const created = await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: { id: collectionId, name: 'Winner' },
      headers: { 'if-none-match': '*' }
    })
    assert.equal(created.status, 201)
    parseEtagSegments(created.headers.get('etag'), { container: true })

    // The loser of a create race: the same guarded PUT against the now-present
    // Collection is refused and the stored Collection Metadata is untouched.
    const thrown = await requestError(
      alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { id: collectionId, name: 'Loser' },
        headers: { 'if-none-match': '*' }
      })
    )
    assert.equal(thrown.response.status, 412)
    assert.equal(thrown.data.type, 'https://w3id.org/pws#precondition-failed')
    const stored = await aliceSpace.collection(collectionId).describe()
    assert.equal(stored!.name, 'Winner')

    // An unconditional PUT still upserts.
    const replaced = await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: { id: collectionId, name: 'Replaced' }
    })
    assert.equal(replaced.status, 204)
    assertEtagAdvanced({
      before: created.headers.get('etag'),
      after: replaced.headers.get('etag'),
      container: true
    })
  })

  it('[root] DELETE a never-created collection is idempotent (204, not 500)', async () => {
    const collection = aliceSpace.collection('never-existed-collection')
    await collection.delete()
    assert.equal(await collection.describe(), null)
  })

  it('PUT whose body id does not match the URL collection id yields invalid-request-body (400)', async () => {
    const collectionId = crypto.randomUUID()
    let expectedError: any
    try {
      await alice.pws.request({
        url: new URL(
          `/space/${alice.space1.id}/${collectionId}/meta`,
          baseServerUrl
        ).toString(),
        method: 'PUT',
        json: { id: crypto.randomUUID(), name: 'Mismatch' }
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the id-mismatch PUT to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://w3id.org/pws#invalid-request-body'
    )
    assert.equal(expectedError.data.errors[0].pointer, '#/id')

    // The Collection was not created.
    assert.equal(await aliceSpace.collection(collectionId).describe(), null)
  })

  describe('Collection backend selection', () => {
    it('POST with backend { id: "default" } persists and echoes it', async () => {
      const collectionId = crypto.randomUUID()
      const response = await alice.pws.request({
        url: new URL(`/space/${alice.space1.id}/`, baseServerUrl).toString(),
        method: 'POST',
        json: {
          id: collectionId,
          name: 'Explicit Backend',
          backend: { id: 'default' }
        }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(response.data.backend, { id: 'default' })

      // And it is reflected in the Collection Metadata object.
      const description = await aliceSpace.collection(collectionId).describe()
      assert.deepStrictEqual(description!.backend, { id: 'default' })
    })

    it('POST with an unknown backend id yields unsupported-backend (409)', async () => {
      let expectedError: any
      try {
        await alice.pws.request({
          url: new URL(`/space/${alice.space1.id}/`, baseServerUrl).toString(),
          method: 'POST',
          json: {
            id: crypto.randomUUID(),
            name: 'Bad Backend',
            backend: { id: 'no-such-backend' }
          }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(
        expectedError,
        'expected the unknown-backend POST to be rejected'
      )
      assert.equal(expectedError.response.status, 409)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#unsupported-backend'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/backend')
    })

    it('POST with a malformed backend yields invalid-request-body (400)', async () => {
      let expectedError: any
      try {
        await alice.pws.request({
          url: new URL(`/space/${alice.space1.id}/`, baseServerUrl).toString(),
          method: 'POST',
          json: {
            id: crypto.randomUUID(),
            name: 'Malformed Backend',
            backend: 'default'
          }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(
        expectedError,
        'expected the malformed-backend POST to be rejected'
      )
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#invalid-request-body'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/backend')
    })

    it('GET :collectionId/backend returns the full backend descriptor', async () => {
      const response = await alice.pws.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/backend`,
          baseServerUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, {
        id: 'default',
        name: 'Server Filesystem',
        managedBy: 'server',
        persistence: 'durable'
      })
    })

    it('GET :collectionId/backend on a missing collection yields 404', async () => {
      let expectedError: any
      try {
        await alice.pws.request({
          url: new URL(
            `/space/${alice.space1.id}/no-such-collection/backend`,
            baseServerUrl
          ).toString(),
          method: 'GET'
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected a 404 for the missing collection')
      assert.equal(expectedError.response.status, 404)
    })

    it('PUT create-by-id default-fills the backend', async () => {
      const collection = aliceSpace.collection(crypto.randomUUID())
      await collection.configure({ name: 'PUT Default Backend', force: true })
      const description = await collection.describe()
      assert.deepStrictEqual(description!.backend, { id: 'default' })
    })

    it('Collection linkset advertises the backend and quota relations', async () => {
      const response = await alice.pws.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/linkset`,
          baseServerUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const [entry] = response.data.linkset
      assert.deepStrictEqual(entry['https://w3id.org/pws#backend'], [
        {
          href: `/space/${alice.space1.id}/credentials/backend`,
          type: 'application/json'
        }
      ])
      assert.deepStrictEqual(entry['https://w3id.org/pws#quota'], [
        {
          href: `/space/${alice.space1.id}/credentials/quota`,
          type: 'application/json'
        }
      ])
    })
  })

  describe('Collection Metadata (/meta)', () => {
    // Build the absolute Collection `/meta` URL.
    const metaUrl = (collectionId: string) =>
      `${baseServerUrl}space/${alice.space1.id}/${collectionId}/meta`

    /** Creates a fresh Collection with a random id and returns that id. */
    async function freshCollection(): Promise<string> {
      const collectionId = crypto.randomUUID()
      await aliceSpace.createCollection({
        id: collectionId,
        name: 'Meta Collection'
      })
      return collectionId
    }

    it('[signed] GET /meta of a collection with no annotations yet 200s with its create-time ETag', async () => {
      const collectionId = await freshCollection()
      const response = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      // Creating the Collection wrote its Metadata object, so the one
      // validator is already minted before any annotation write...
      parseEtagSegments(response.headers.get('etag'), { container: true })
      // ...and the server-managed creator shows, with no annotations.
      assert.equal(response.data.createdBy, alice.did)
      assert.equal(response.data.custom, undefined)
      // The validator travels only as the header and stays out of the body.
      assert.equal(response.data.metaGeneration, undefined)
      assert.equal(response.data._generation, undefined)
    })

    it('[signed] GET /meta of a nonexistent collection 404s', async () => {
      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl('collection-that-does-not-exist'),
          method: 'GET'
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected a missing collection meta read to be rejected'
      )
      assert.equal(thrown.response.status, 404)
    })

    it("[signed] Bob's GET /meta of Alice's collection 404s (conflation)", async () => {
      const collectionId = await freshCollection()
      let thrown: any
      try {
        await bob.pws.request({ url: metaUrl(collectionId), method: 'GET' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's collection meta read to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('anonymous GET /meta of a PublicCanRead collection succeeds', async () => {
      const collectionId = await freshCollection()
      const collection = aliceSpace.collection(collectionId)

      // Before any policy: an anonymous /meta read is denied (404, no leak).
      const before = await fetch(new URL(metaUrl(collectionId)))
      assert.equal(before.status, 404)

      await collection.setPublic()

      const after = await fetch(new URL(metaUrl(collectionId)))
      assert.equal(after.status, 200)
      const meta = (await after.json()) as { createdBy?: string }
      assert.equal(meta.createdBy, alice.did)
    })

    it('[signed] PUT /meta sets custom, round-tripped by GET with a matching ETag', async () => {
      const collectionId = await freshCollection()
      const createdEtag = (
        await alice.pws.request({ url: metaUrl(collectionId), method: 'GET' })
      ).headers.get('etag')
      const put = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {
          custom: { name: 'Trip Photos', tags: { app: 'gallery' } }
        }
      })
      assert.equal(put.status, 204)
      const putEtag = put.headers.get('etag')
      // The annotation write is the next stamped write of the same
      // Collection Metadata object.
      assertEtagAdvanced({
        before: createdEtag,
        after: putEtag,
        container: true
      })

      const got = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(got.status, 200)
      assert.equal(got.headers.get('etag'), putEtag)
      assert.equal(got.data.custom.name, 'Trip Photos')
      assert.deepEqual(got.data.custom.tags, { app: 'gallery' })
      assert.equal(got.data.createdBy, alice.did)
      assert.ok(!Number.isNaN(Date.parse(got.data.createdAt)))
      assert.ok(!Number.isNaN(Date.parse(got.data.updatedAt)))
    })

    it('[signed] PUT /meta is a full replacement; an empty body clears custom', async () => {
      const collectionId = await freshCollection()
      const annotatedEtag = (
        await alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'Temporary', tags: { a: 'b' } } }
        })
      ).headers.get('etag')
      // A body with no `custom` clears every user-writable property.
      const cleared = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {}
      })
      // The clearing write is the third stamped write (create, annotation,
      // clear).
      assertEtagAdvanced({
        before: annotatedEtag,
        after: cleared.headers.get('etag'),
        container: true
      })

      const got = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(got.data.custom, undefined)
    })

    it('[signed] PUT /meta ignores server-managed top-level props (roundtrip)', async () => {
      const collectionId = await freshCollection()
      await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Before' } }
      })
      // GET the whole Metadata object, tweak custom, and PUT it back unstripped.
      const { data: meta } = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      const put = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {
          ...meta,
          createdBy: 'did:key:zSomeoneElse',
          createdAt: '1999-01-01T00:00:00.000Z',
          custom: { name: 'After' }
        }
      })
      assert.equal(put.status, 204)

      const { data: after } = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(after.createdBy, alice.did)
      assert.notEqual(after.createdAt, '1999-01-01T00:00:00.000Z')
      assert.equal(after.custom.name, 'After')
    })

    it('[signed] PUT /meta of a nonexistent collection creates it (201)', async () => {
      // `PUT .../meta` is Update (or Create by Id) Collection: an absent
      // Collection is created, annotations included.
      const collectionId = crypto.randomUUID()
      const created = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Created by meta' } }
      })
      assert.equal(created.status, 201)
      parseEtagSegments(created.headers.get('etag'), { container: true })

      const got = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(got.data.id, collectionId)
      assert.equal(got.data.custom.name, 'Created by meta')
      assert.equal(got.data.createdBy, alice.did)
    })

    it('[signed] PUT /meta with a non-object custom 400s', async () => {
      const collectionId = await freshCollection()
      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: 'not-an-object' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected an invalid custom body to be rejected')
      assert.equal(thrown.response.status, 400)
      assert.match(thrown.data.type, /#invalid-request-body$/)
    })

    it("[signed] Bob's PUT /meta of Alice's collection 404s (conflation)", async () => {
      const collectionId = await freshCollection()
      let thrown: any
      try {
        await bob.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'hijack' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's collection meta write to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('[signed] a stale If-Match on /meta is rejected with 412', async () => {
      const collectionId = await freshCollection()
      await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'One' } }
      })
      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'Two' } },
          headers: { 'if-match': '"99"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a stale If-Match to be rejected')
      assert.equal(thrown.response.status, 412)
    })

    it('[signed] If-None-Match: * writes once, then 412s', async () => {
      const collectionId = crypto.randomUUID()
      const created = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'First' } },
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 201)
      parseEtagSegments(created.headers.get('etag'), { container: true })

      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'Second' } },
          headers: { 'if-none-match': '*' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected create-if-absent on written metadata to fail')
      assert.equal(thrown.response.status, 412)

      // A Collection created by POST already has its Metadata object, so a
      // guarded write refuses even though no annotation was ever written.
      const postedId = await freshCollection()
      const refused = await requestError(
        alice.pws.request({
          url: metaUrl(postedId),
          method: 'PUT',
          json: { custom: { name: 'Too Late' } },
          headers: { 'if-none-match': '*' }
        })
      )
      assert.equal(refused.response.status, 412)
    })

    it('[signed] an omitted epoch CLEARS the stored stamp', async () => {
      const collectionId = await freshCollection()
      await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Stamped' }, epoch: 'epoch-1' }
      })
      const stamped = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(stamped.data.epoch, 'epoch-1')

      // Unlike the Resource-level rule, omitting `epoch` clears it: the write
      // replaced the whole `custom` envelope the stamp described.
      await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Restamped' } }
      })
      const cleared = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(cleared.data.epoch, undefined)
    })

    it('[signed] GET of /meta with a matching If-None-Match is 304, and a write moves the validator', async () => {
      const collectionId = await freshCollection()

      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      const createdEtag = described.headers.get('etag')!
      const unchanged = await responseOf(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': createdEtag }
        })
      )
      assert.equal(unchanged.status, 304)
      assert.equal(unchanged.headers.get('etag'), createdEtag)
      assert.equal(await unchanged.text(), '')

      // A stale validator gets the full Collection Metadata object.
      const stale = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET',
        headers: { 'if-none-match': '"99"' }
      })
      assert.equal(stale.status, 200)
      assert.equal(stale.data.id, collectionId)

      // After a write, the new ETag is the one that validates.
      const written = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Meta' } }
      })
      const metaEtag = written.headers.get('etag')!
      const metaUnchanged = await responseOf(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': metaEtag }
        })
      )
      assert.equal(metaUnchanged.status, 304)
      assert.equal(metaUnchanged.headers.get('etag'), metaEtag)
      const createdStale = await responseOf(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': createdEtag }
        })
      )
      assert.equal(createdStale.status, 200)
    })

    it('[signed] a configuration write and an annotation write advance the one Collection Metadata ETag', async () => {
      // A Collection's configuration and its annotations are one Metadata
      // object under one validator, so neither kind of write leaves the ETag
      // in place.
      const collectionId = await freshCollection()

      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      const createdEtag = described.headers.get('etag')!
      parseEtagSegments(createdEtag, { container: true })

      // An annotation write advances the validator...
      const annotated = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { name: 'Meta Collection', custom: { name: 'Shared' } }
      })
      const annotatedEtag = annotated.headers.get('etag')!
      assertEtagAdvanced({
        before: createdEtag,
        after: annotatedEtag,
        container: true
      })
      assert.equal(etagGeneration(annotatedEtag), etagGeneration(createdEtag))

      // ...and so does a configuration write, under the same generation.
      const configured = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {
          id: collectionId,
          type: ['Collection'],
          name: 'Renamed',
          custom: { name: 'Shared' }
        }
      })
      const configuredEtag = configured.headers.get('etag')!
      assertEtagAdvanced({
        before: annotatedEtag,
        after: configuredEtag,
        container: true
      })
      assert.equal(etagGeneration(configuredEtag), etagGeneration(createdEtag))

      const meta = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(meta.headers.get('etag'), configuredEtag)
      assert.equal(meta.data.name, 'Renamed')
      assert.equal(meta.data.custom.name, 'Shared')
    })

    it('a DELETE at the Collection Metadata URL is 405, not a reserved-id 409', () => {
      // The Collection Metadata route occupies the `:resourceId` position, so
      // `meta` is a reserved Resource id. DELETE used to fall through to the
      // Resource route and answer the reserved-id 409 -- an answer about ids,
      // to a request that asked about a method. The URL now registers its own
      // DELETE, which refuses the method and names what it accepts.
      const collectionId = 'credentials'
      return alice.pws
        .request({
          url: `${baseServerUrl}space/${alice.space1.id}/${collectionId}/meta`,
          method: 'DELETE'
        })
        .then(
          () => assert.fail('expected a DELETE at `meta` to be refused'),
          (thrown: any) => {
            assert.equal(thrown.response.status, 405)
            assert.equal(thrown.response.headers.get('allow'), 'GET, HEAD, PUT')
            assert.equal(thrown.data.type, 'about:blank')
          }
        )
    })
  })
})
