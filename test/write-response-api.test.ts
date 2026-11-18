/**
 * Write responses (Vitest): Create or Update Resource answers `201` when it
 * created the Resource and `200` when it updated a live one, Update Resource
 * Metadata answers `200`, and both carry the server-managed members as the
 * write left them. Container creates answer from the stored object and the
 * backend's create-or-update decision. Runs against the filesystem backend,
 * and against Postgres too when `WAS_TEST_DATABASE_URL` is set.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { stampOf } from '../src/lib/hlc.js'
import type { StorageBackend } from '../src/types.js'
import {
  client,
  delegate,
  openTempBackend,
  parseEtagSegments,
  requestError,
  splitResourceMetaEtag,
  startTestServer,
  zcapClients,
  openTempPostgres
} from './helpers.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

/**
 * The members a write response body may carry, and nothing else.
 */
const BODY_MEMBERS = new Set([
  'contentType',
  'size',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedAtCounter',
  'originId',
  'meta'
])

/**
 * Opens a backend for one suite, with the cleanup that removes its storage
 * once the server, which closes the backend, has closed.
 */
type BackendOpener = () => Promise<{
  backend: StorageBackend
  cleanup: () => Promise<void>
}>

/**
 * The filesystem backend over a private temp dir.
 * @returns {ReturnType<BackendOpener>}
 */
async function openFilesystem(): ReturnType<BackendOpener> {
  // Closing the backend removes its temp dir.
  const backend = await openTempBackend({ prefix: 'was-write-response-' })
  return { backend, cleanup: async () => {} }
}

/**
 * The Postgres backend over a throwaway schema, dropped by the cleanup.
 * @returns {ReturnType<BackendOpener>}
 */
async function openPostgres(): ReturnType<BackendOpener> {
  const { backend, dropSchema } = await openTempPostgres()
  return { backend, cleanup: dropSchema }
}

/**
 * Holds every `writeCollection` call until `count` of them have arrived, so
 * that many handlers have each made their unlocked read of the Collection
 * before any of them writes. Resolves a function that restores the backend.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.count {number}
 * @returns {() => void}
 */
function holdCollectionWrites({
  backend,
  count
}: {
  backend: StorageBackend
  count: number
}): () => void {
  const write = Object.getPrototypeOf(backend).writeCollection
  let arrivals = 0
  let open!: () => void
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  backend.writeCollection = async options => {
    arrivals += 1
    if (arrivals === count) {
      open()
    }
    await opened
    return write.call(backend, options)
  }
  return () => {
    delete (backend as Partial<StorageBackend>).writeCollection
  }
}

/**
 * Asserts a body holds server-managed members only, the stamp whole.
 * @param body {Record<string, unknown>}
 * @returns {void}
 */
function assertServerMembersOnly(body: Record<string, unknown>): void {
  for (const member of Object.keys(body)) {
    assert.ok(BODY_MEMBERS.has(member), `unexpected member ${member}`)
  }
  assert.equal(typeof body.contentType, 'string')
  assert.equal(typeof body.size, 'number')
  assert.equal(typeof body.updatedAt, 'string')
  assert.equal(typeof body.updatedAtCounter, 'number')
  assert.equal(typeof body.originId, 'string')
}

/**
 * Asserts an `ETag` names the given stamp.
 * @param etag {string | null}
 * @param stamp {any}
 * @returns {void}
 */
function assertEtagNamesStamp(etag: string | null, stamp: any): void {
  const segments = parseEtagSegments(etag)
  assert.equal(
    Date.parse(segments.stamp.updatedAt),
    Date.parse(stamp.updatedAt)
  )
  assert.equal(segments.stamp.updatedAtCounter, stamp.updatedAtCounter)
  assert.equal(segments.stamp.originId, stamp.originId)
}

function describeWriteResponses({
  name,
  openBackend
}: {
  name: string
  openBackend: BackendOpener
}): void {
  describe(`Write responses (${name})`, () => {
    let fastify: FastifyInstance,
      baseServerUrl: string,
      backend: StorageBackend,
      cleanup: () => Promise<void>,
      alice: any,
      bob: any
    const spaceId = `write-response-${crypto.randomUUID()}`
    const collectionId = 'notes'

    function resourceUrl(resourceId: string): string {
      return `${baseServerUrl}space/${spaceId}/${collectionId}/${resourceId}`
    }

    function put(resourceId: string, json: unknown, headers = {}) {
      return alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json,
        headers
      })
    }

    function putMeta(resourceId: string, json: unknown) {
      return alice.pws.request({
        url: `${resourceUrl(resourceId)}/meta`,
        method: 'PUT',
        json
      })
    }

    async function readMeta(resourceId: string): Promise<any> {
      const response = await alice.pws.request({
        url: `${resourceUrl(resourceId)}/meta`,
        method: 'GET'
      })
      return response.data
    }

    /**
     * The `resource` document the changes feed carries for an id.
     */
    async function feedDocument(resourceId: string): Promise<any> {
      const { data } = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/query`,
        method: 'POST',
        json: { profile: 'changes', limit: 1000 }
      })
      return data.documents.find(
        (doc: any) => doc.kind === 'resource' && doc.id === resourceId
      )
    }

    beforeAll(async () => {
      ;({ backend, cleanup } = await openBackend())
      ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
      ;({ alice, bob } = await zcapClients({ baseServerUrl }))
      await alice.pws.request({
        url: `${baseServerUrl}spaces/`,
        method: 'POST',
        json: { id: spaceId, controller: alice.did }
      })
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Notes' }
      })
    })
    afterAll(async () => {
      await fastify.close()
      await cleanup()
    })

    it('a create answers 201 with this write provenance and the stamp the feed then carries', async () => {
      const response = await put(
        'created',
        { n: 1 },
        { 'key-epoch': 'epoch-1', 'writer-id': 'writer-a' }
      )
      assert.equal(response.status, 201)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      const body = response.data
      assertServerMembersOnly(body)
      // Client-declared members stay out of the body.
      assert.equal(body.epoch, undefined)
      assert.equal(body.writerId, undefined)
      assert.equal(body.meta, undefined)
      assert.equal(body.contentType, 'application/json')
      assert.equal(body.size, JSON.stringify({ n: 1 }).length)
      assert.deepEqual(body.createdBy, [alice.did])
      assert.equal(body.createdAt, body.updatedAt)
      assertEtagNamesStamp(response.headers.get('etag'), body)

      const doc = await feedDocument('created')
      assert.deepEqual(stampOf(doc), stampOf(body))
      assert.deepEqual(doc.createdBy, body.createdBy)
      const meta = await readMeta('created')
      assert.equal(meta.createdAt, body.createdAt)
      assert.deepEqual(meta.createdBy, body.createdBy)
    })

    it('an update answers 200 without provenance', async () => {
      const created = await put('updated', { n: 1 })
      const response = await put('updated', { n: 22 })
      assert.equal(response.status, 200)
      const body = response.data
      assertServerMembersOnly(body)
      assert.equal(body.createdAt, undefined)
      assert.equal(body.createdBy, undefined)
      assert.equal(body.size, JSON.stringify({ n: 22 }).length)
      assert.notDeepEqual(stampOf(body), stampOf(created.data))
      assertEtagNamesStamp(response.headers.get('etag'), body)
      assert.deepEqual(stampOf(await feedDocument('updated')), stampOf(body))
    })

    it('a binary write reports the stored media type and size', async () => {
      const response = await alice.pws.request({
        url: resourceUrl('blob'),
        method: 'PUT',
        body: new Uint8Array([1, 2, 3, 4, 5]),
        headers: { 'content-type': 'application/octet-stream' }
      })
      assert.equal(response.status, 201)
      assert.equal(response.data.contentType, 'application/octet-stream')
      assert.equal(response.data.size, 5)
    })

    it('a metadata write answers 200 with the /meta stamp and the content stamp unchanged', async () => {
      const created = await put('annotated', { n: 1 })
      const response = await putMeta('annotated', {
        custom: { name: 'Annotated' }
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      const body = response.data
      assertServerMembersOnly(body)
      assert.equal(body.custom, undefined)
      assert.equal(body.createdAt, undefined)
      assert.equal(body.createdBy, undefined)
      // The content record did not move.
      assert.deepEqual(stampOf(body), stampOf(created.data))
      assert.equal(typeof body.meta.generation, 'string')
      // The /meta ETag is the content ETag followed by the /meta record's.
      const metaEtag = splitResourceMetaEtag(response.headers.get('etag'))
      assert.equal(metaEtag.content, created.headers.get('etag'))
      assertEtagNamesStamp(metaEtag.meta ?? null, body.meta)
      const doc = await feedDocument('annotated')
      assert.deepEqual(doc.meta, body.meta)
      assert.deepEqual((await readMeta('annotated')).meta, body.meta)
    })

    it('a metadata write to an absent Resource is a 404', async () => {
      const err = await requestError(
        putMeta('never-written', { custom: { name: 'Nothing' } })
      )
      assert.equal(err.response.status, 404)
    })

    it('a re-create over a tombstone answers 201 with fresh provenance', async () => {
      await put('revived', { n: 1 })
      await alice.pws.request({ url: resourceUrl('revived'), method: 'DELETE' })

      // Bob re-creates the id under a grant on the Collection.
      const spaceUrl = `${baseServerUrl}space/${spaceId}/`
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: `${spaceUrl}${collectionId}/`,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const response: any = await client({ signer: bob.signer }).request({
        url: resourceUrl('revived'),
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { n: 2 }
      })
      assert.equal(response.status, 201)
      assert.deepEqual(response.data.createdBy, [bob.did])
      assert.equal(response.data.createdAt, response.data.updatedAt)

      const meta = await readMeta('revived')
      assert.deepEqual(meta.createdBy, [bob.did])
      assert.equal(meta.createdAt, response.data.createdAt)
      const doc = await feedDocument('revived')
      assert.deepEqual(doc.createdBy, [bob.did])
      assert.deepEqual(stampOf(doc), stampOf(response.data))
    })

    it('a write-once repeat answers 200 with the stored members', async () => {
      const onceId = `once-${crypto.randomUUID()}`
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: onceId, revisions: { immutable: true } }
      })
      const url = `${baseServerUrl}space/${spaceId}/${onceId}/doc`
      const created = await alice.pws.request({
        url,
        method: 'PUT',
        json: { n: 1 }
      })
      assert.equal(created.status, 201)
      const repeated = await alice.pws.request({
        url,
        method: 'PUT',
        json: { n: 1 }
      })
      assert.equal(repeated.status, 200)
      assert.equal(repeated.headers.get('etag'), created.headers.get('etag'))
      assert.deepEqual(stampOf(repeated.data), stampOf(created.data))
      assert.equal(repeated.data.size, created.data.size)
      assert.equal(repeated.data.createdBy, undefined)
    })

    it('two unconditional creates of one Collection by PUT answer one 201 and one 204', async () => {
      const raceId = `race-${crypto.randomUUID()}`
      const metaUrl = `${baseServerUrl}space/${spaceId}/${raceId}/meta`
      const spaceUrl = `${baseServerUrl}space/${spaceId}/`
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      // Both handlers read the Collection as absent before either writes.
      const restore = holdCollectionWrites({ backend, count: 2 })
      let responses: any[]
      try {
        responses = await Promise.all([
          alice.pws.request({
            url: metaUrl,
            method: 'PUT',
            json: { name: 'Alice' }
          }),
          client({ signer: bob.signer }).request({
            url: metaUrl,
            method: 'PUT',
            action: 'PUT',
            capability,
            json: { name: 'Bob' }
          })
        ])
      } finally {
        restore()
      }
      assert.deepEqual(
        responses.map(response => response.status).sort(),
        [201, 204]
      )
      const createResponse = responses.find(response => response.status === 201)
      const updateResponse = responses.find(response => response.status === 204)
      const storedResponse = await alice.pws.request({
        url: metaUrl,
        method: 'GET'
      })
      const stored = storedResponse.data
      // The create's body names the Collection's creator, and the update
      // claims nothing.
      assert.equal(createResponse.data.createdAt, stored.createdAt)
      assert.deepEqual(createResponse.data.createdBy, stored.createdBy)
      assert.ok(!updateResponse.data)
      // The update landed last, over the create.
      assert.equal(
        updateResponse.headers.get('etag'),
        storedResponse.headers.get('etag')
      )
    })

    it('Create Collection answers with the stored object', async () => {
      const newId = `created-${crypto.randomUUID()}`
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: newId, name: 'Fresh', createdBy: ['did:key:zIgnored'] }
      })
      assert.equal(response.status, 201)
      const { data: stored } = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${newId}/meta`,
        method: 'GET'
      })
      assert.deepEqual(response.data, stored)
      assert.deepEqual(response.data.createdBy, [alice.did])
    })

    it('Create Space answers with the stored object', async () => {
      const newSpaceId = `space-${crypto.randomUUID()}`
      const response = await alice.pws.request({
        url: `${baseServerUrl}spaces/`,
        method: 'POST',
        json: { id: newSpaceId, controller: alice.did, name: 'Fresh' }
      })
      assert.equal(response.status, 201)
      const { data: stored } = await alice.pws.request({
        url: `${baseServerUrl}space/${newSpaceId}/meta`,
        method: 'GET'
      })
      assert.deepEqual(response.data, stored)
    })
  })
}

describeWriteResponses({
  name: 'FileSystemBackend',
  openBackend: openFilesystem
})

if (connectionString) {
  describeWriteResponses({ name: 'PostgresBackend', openBackend: openPostgres })
} else {
  describe('Write responses (PostgresBackend)', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
}
