/**
 * Chunk API integration tests (Vitest, in-process): the `chunked-streams`
 * feature -- addressing one chunk of a chunked Resource at
 * `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex`, plus the
 * `chunks/` discovery listing. A chunk body is opaque bytes + content-type,
 * stored exactly like a binary Resource representation, so these exercise the
 * raw-bytes put/get/head/delete round-trip, the JSON-envelope reuse path, the
 * listing, conditional writes, the bad-index and parent-missing guards, the
 * per-upload cap (413), the parent-delete cascade, and export/import carry.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import type { Space, Collection } from '@interop/pws-client'

import type { TempFileSystemBackend } from '../src/testing.js'
import {
  assertEtagAdvanced,
  parseEtagSegments,
  etagGeneration,
  openTempBackend,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

/**
 * Resolves the HTTP status of a signed request, whether it fulfills (2xx/3xx)
 * or rejects with a raw ky error (the `request()` escape hatch does not map
 * non-2xx to typed errors, so a rejection carries `err.response.status`).
 * @param promise {Promise<{ status: number }>}
 * @returns {Promise<number>}
 */
async function statusOf(promise: Promise<{ status: number }>): Promise<number> {
  return (await responseOf(promise)).status
}

describe('Chunk API (chunked-streams)', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    alice: any,
    aliceSpace: Space,
    dataCollection: Collection

  const spaceId = '426e7db8-26b5-4fdc-8068-9dcb948fd291'

  // The absolute member (one chunk) and container (listing) URLs.
  const chunkUrl = (resourceId: string, chunkIndex: number | string) =>
    `${baseServerUrl}space/${spaceId}/data/${resourceId}/chunks/${chunkIndex}`
  const listUrl = (resourceId: string) =>
    `${baseServerUrl}space/${spaceId}/data/${resourceId}/chunks/`
  const resourceUrl = (resourceId: string) =>
    `${baseServerUrl}space/${spaceId}/data/${resourceId}`

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-chunks-' })
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))

    aliceSpace = await alice.pws.createSpace({
      id: spaceId,
      name: "Alice's Chunk Space",
      controller: alice.did
    })
    dataCollection = await aliceSpace.createCollection({
      id: 'data',
      name: 'Chunked Data'
    })
  })

  afterAll(async () => {
    await fastify.close()
  })

  describe('conditional chunk reads (If-None-Match / 304)', () => {
    it('[signed] GET and HEAD of a chunk with a matching If-None-Match are 304', async () => {
      const resourceId = 'cond-read-chunk'
      await dataCollection.put(resourceId, { id: resourceId, name: 'Manifest' })
      const written = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([1, 2, 3])], {
          type: 'application/octet-stream'
        })
      })
      const etag = written.headers.get('etag')!

      for (const method of ['GET', 'HEAD']) {
        const getChunk = vi.spyOn(fastify.storage, 'getChunk')
        const unchanged = await responseOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method,
            headers: { 'if-none-match': etag }
          })
        )
        // The 304 ends the handler: the byte stream is never opened.
        assert.equal(getChunk.mock.calls.length, 0, method)
        getChunk.mockRestore()
        assert.equal(unchanged.status, 304, method)
        assert.equal(unchanged.headers.get('etag'), etag, method)
        assert.equal(await unchanged.text(), '', method)
      }

      // A stale validator gets the full chunk.
      const stale = await responseOf(
        alice.pws.request({
          url: chunkUrl(resourceId, 0),
          method: 'GET',
          headers: { 'if-none-match': '"99"' }
        })
      )
      assert.equal(stale.status, 200)
      assert.deepEqual(
        new Uint8Array(await stale.arrayBuffer()),
        new Uint8Array([1, 2, 3])
      )
    })

    it('[signed] a conditional GET of an orphan chunk is still 404', async () => {
      // The parent gate runs before the validator is consulted: an orphan
      // chunk reveals nothing through a 304 either.
      const chunkDir = path.join(
        backend.dataDir,
        'spaces',
        spaceId,
        'data',
        '.chunks.cond-read-orphan'
      )
      await mkdir(chunkDir, { recursive: true })
      await writeFile(
        path.join(chunkDir, 'r.0.application%2Foctet-stream.bin'),
        new Uint8Array([9])
      )
      const response = await responseOf(
        alice.pws.request({
          url: chunkUrl('cond-read-orphan', 0),
          method: 'GET',
          headers: { 'if-none-match': '*' }
        })
      )
      assert.equal(response.status, 404)
    })
  })

  describe('binary chunk round-trip', () => {
    it('[signed] PUT / GET / HEAD / DELETE a raw octet-stream chunk', async () => {
      const resourceId = 'binary-blob'
      // A chunked Resource's parent must exist before any chunk can be written.
      await dataCollection.put(resourceId, { id: resourceId, name: 'Manifest' })

      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
      const putResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([bytes], { type: 'application/octet-stream' })
      })
      assert.equal(putResponse.status, 204)
      // The chunk carries its own stamped validator.
      const putEtag = putResponse.headers.get('etag')
      parseEtagSegments(putEtag)

      // GET streams back the exact stored bytes with the stored content-type.
      const getResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'GET'
      })
      assert.equal(getResponse.status, 200)
      assert.match(
        getResponse.headers.get('content-type')!,
        /application\/octet-stream/
      )
      assert.equal(getResponse.headers.get('etag'), putEtag)
      assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), bytes)

      // HEAD carries the payload headers from stored metadata, no body.
      const headResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'HEAD'
      })
      assert.equal(headResponse.status, 200)
      assert.match(
        headResponse.headers.get('content-type')!,
        /application\/octet-stream/
      )
      assert.equal(
        headResponse.headers.get('content-length'),
        String(bytes.length)
      )
      assert.equal(headResponse.headers.get('etag'), putEtag)
      assert.equal(await headResponse.text(), '')

      // DELETE removes the chunk; a subsequent GET 404s.
      const deleteResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })
      assert.equal(deleteResponse.status, 204)
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'GET'
          })
        ),
        404
      )
    })

    it('[signed] a JSON-body chunk (EDV envelope reuse path) round-trips', async () => {
      const resourceId = 'json-envelope'
      await dataCollection.put(resourceId, { id: resourceId })

      const envelope = { index: 0, jwe: { ciphertext: 'AAAA' } }
      const putResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        json: envelope
      })
      assert.equal(putResponse.status, 204)

      const getResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'GET'
      })
      assert.equal(getResponse.status, 200)
      assert.match(
        getResponse.headers.get('content-type')!,
        /application\/json/
      )
      // A JSON content-type is auto-parsed onto `.data`.
      assert.equal(getResponse.data.jwe.ciphertext, 'AAAA')
    })

    it('[signed] a chunk declaring a JSON media type is stored byte-verbatim', async () => {
      // A chunk is a range of a stream, not a document: a slice of a JSON
      // stream need not parse as JSON, and must not be re-serialized.
      const resourceId = 'json-range'
      await dataCollection.put(resourceId, { id: resourceId })

      const slice = '{"partial": [1, 2,'
      for (const [index, type] of [
        [0, 'application/json'],
        [1, 'application/ld+json']
      ] as const) {
        const putResponse = await alice.pws.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([slice], { type })
        })
        assert.equal(putResponse.status, 204)
        // A plain signed fetch: pws-client would parse a JSON content type.
        const url = chunkUrl(resourceId, index)
        const headers = await signCapabilityInvocation({
          url,
          method: 'GET',
          headers: { date: new Date().toUTCString() },
          invocationSigner: alice.signer,
          capabilityAction: 'GET'
        })
        const getResponse = await fetch(url, { headers })
        assert.equal(getResponse.status, 200)
        assert.match(getResponse.headers.get('content-type')!, /json/)
        assert.equal(await getResponse.text(), slice)
      }
    })

    it('[signed] a text/plain chunk is stored byte-verbatim', async () => {
      const resourceId = 'text-range'
      await dataCollection.put(resourceId, { id: resourceId })
      // An astral-plane character: a string piped by UTF-16 code unit would
      // split it into lone surrogates.
      const slice = 'a range of text \u{1F600} cut mid-sentence'
      const putResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([slice], { type: 'text/plain' })
      })
      assert.equal(putResponse.status, 204)
      const getResponse = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'GET'
      })
      assert.equal(getResponse.status, 200)
      assert.equal(await getResponse.text(), slice)
    })
  })

  describe('listing', () => {
    it('[signed] lists multiple chunks in ascending index order with sizes and etags', async () => {
      const resourceId = 'multi-chunk'
      await dataCollection.put(resourceId, { id: resourceId })

      const chunkBytes = [
        new Uint8Array([1]),
        new Uint8Array([2, 2]),
        new Uint8Array([3, 3, 3])
      ]
      // Write out of order to prove the listing sorts by index, not write order.
      const putEtags: Record<number, string> = {}
      for (const index of [2, 0, 1]) {
        const response = await alice.pws.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([chunkBytes[index]!], {
            type: 'application/octet-stream'
          })
        })
        assert.equal(response.status, 204)
        putEtags[index] = response.headers.get('etag')!
      }

      const listing = await alice.pws.request({
        url: listUrl(resourceId),
        method: 'GET'
      })
      assert.equal(listing.status, 200)
      assert.match(listing.headers.get('content-type')!, /application\/json/)
      assert.equal(listing.data.resourceId, resourceId)
      assert.equal(listing.data.count, 3)
      assert.deepEqual(
        listing.data.chunks.map((chunk: { index: number }) => chunk.index),
        [0, 1, 2]
      )
      assert.deepEqual(
        listing.data.chunks.map((chunk: { size: number }) => chunk.size),
        [1, 2, 3]
      )
      for (const chunk of listing.data.chunks) {
        assert.equal(chunk.contentType, 'application/octet-stream')
        assert.deepEqual(Object.keys(chunk).sort(), [
          'contentType',
          'etag',
          'index',
          'size'
        ])
        // The listed `etag` is the one the chunk's write returned and its
        // own HEAD serves, so a client can pin a DELETE on it with no probe.
        assert.equal(chunk.etag, putEtags[chunk.index])
      }
      const heads = await Promise.all(
        listing.data.chunks.map((chunk: { index: number }) =>
          alice.pws.request({
            url: chunkUrl(resourceId, chunk.index),
            method: 'HEAD'
          })
        )
      )
      heads.forEach((head, position) => {
        assert.equal(
          head.headers.get('etag'),
          listing.data.chunks[position].etag
        )
      })
    })

    it('[signed] a listed etag pins a conditional DELETE of its chunk', async () => {
      const resourceId = 'listed-etag-delete'
      await dataCollection.put(resourceId, { id: resourceId })
      for (const index of [0, 1]) {
        const response = await alice.pws.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
        assert.equal(response.status, 204)
      }
      const listing = await alice.pws.request({
        url: listUrl(resourceId),
        method: 'GET'
      })
      assert.equal(listing.status, 200)
      // Another entry's etag is refused, and the chunk's own succeeds.
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'DELETE',
            headers: { 'if-match': listing.data.chunks[1].etag }
          })
        ),
        412
      )
      const pinned = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE',
        headers: { 'if-match': listing.data.chunks[0].etag }
      })
      assert.equal(pinned.status, 204)
    })

    it('[signed] a Resource with no chunks lists count 0', async () => {
      const resourceId = 'no-chunks'
      await dataCollection.put(resourceId, { id: resourceId })

      const listing = await alice.pws.request({
        url: listUrl(resourceId),
        method: 'GET'
      })
      assert.equal(listing.status, 200)
      assert.equal(listing.data.count, 0)
      assert.deepEqual(listing.data.chunks, [])
    })

    it('[signed] listing an absent Resource 404s', async () => {
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: listUrl('does-not-exist'),
            method: 'GET'
          })
        ),
        404
      )
    })

    it('the no-slash list URL 308-redirects to the trailing-slash form', async () => {
      const resourceId = 'redirect-list'
      await dataCollection.put(resourceId, { id: resourceId })

      // A read-reachable redirect: no auth headers needed, and it must emit the
      // concrete path with the trailing slash toggled (not the route template).
      const response = await fastify.inject({
        method: 'GET',
        url: `/space/${spaceId}/data/${resourceId}/chunks`
      })
      assert.equal(response.statusCode, 308)
      assert.equal(
        response.headers.location,
        `/space/${spaceId}/data/${resourceId}/chunks/`
      )
    })
  })

  describe('redirects', () => {
    it('the slash form of a chunk URL 308-redirects before any parser reads the body', async () => {
      // The redirect sits in the chunk write scope, so a body no JSON parser
      // would accept still gets the 308, not a 400 from the parser.
      const response = await fastify.inject({
        method: 'PUT',
        url: `/space/${spaceId}/data/some-resource/chunks/0/`,
        headers: { 'content-type': 'application/json' },
        payload: '{"partial": [1, 2,'
      })
      assert.equal(response.statusCode, 308)
      assert.equal(
        response.headers.location,
        `/space/${spaceId}/data/some-resource/chunks/0`
      )
    })
  })

  describe('guards', () => {
    it('[signed] PUT a chunk of an absent parent Resource 404s', async () => {
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl('parent-missing', 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([9])], {
              type: 'application/octet-stream'
            })
          })
        ),
        404
      )
    })

    it('[signed] a non-canonical :chunkIndex 400s', async () => {
      const resourceId = 'bad-index'
      await dataCollection.put(resourceId, { id: resourceId })

      // 'abc' non-integer, '-1' negative, '01' leading zero, '1.5' non-integer.
      for (const badIndex of ['abc', '-1', '01', '1.5']) {
        assert.equal(
          await statusOf(
            alice.pws.request({
              url: chunkUrl(resourceId, badIndex),
              method: 'GET'
            })
          ),
          400,
          `expected 400 for chunk index "${badIndex}"`
        )
      }
    })

    it('[signed] the chunk index range caps at 2^31-1 (both backends agree)', async () => {
      const resourceId = 'index-range'
      await dataCollection.put(resourceId, { id: resourceId })

      // The largest addressable index is valid: it 404s as an ABSENT chunk
      // (not a 400), while one past it exceeds MAX_CHUNK_INDEX (the Postgres
      // `chunk_index` column is int4, and the shared validation keeps the
      // filesystem to the same range) and is rejected up front.
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, '2147483647'),
            method: 'GET'
          })
        ),
        404
      )
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, '2147483648'),
            method: 'GET'
          })
        ),
        400
      )
    })

    it('[signed] an orphan chunk (no parent Resource) 404s on GET / HEAD / DELETE', async () => {
      // Fabricate out-of-band state the API cannot produce (writes require the
      // parent; parent deletes cascade): a chunk file on disk for a Resource
      // that does not exist. The member handlers must gate on the parent, like
      // the listing does, instead of serving the orphan's bytes.
      const chunkDir = path.join(
        backend.dataDir,
        'spaces',
        spaceId,
        'data',
        '.chunks.orphan-parent'
      )
      await mkdir(chunkDir, { recursive: true })
      await writeFile(
        path.join(chunkDir, 'r.0.application%2Foctet-stream.bin'),
        new Uint8Array([1, 2, 3])
      )

      for (const method of ['GET', 'HEAD', 'DELETE']) {
        assert.equal(
          await statusOf(
            alice.pws.request({
              url: chunkUrl('orphan-parent', 0),
              method
            })
          ),
          404,
          `expected 404 for orphan chunk ${method}`
        )
      }
    })

    it('[signed] probing an orphan chunk destroys the opened chunk stream', async () => {
      // Get Chunk reads the parent's metadata and opens the chunk stream
      // together; on the filesystem backend the stream holds a file
      // descriptor by the time the parent gate 404s. Every stream the gate
      // discards must be destroyed, or each probe leaks one descriptor.
      const chunkDir = path.join(
        backend.dataDir,
        'spaces',
        spaceId,
        'data',
        '.chunks.orphan-leak'
      )
      await mkdir(chunkDir, { recursive: true })
      await writeFile(
        path.join(chunkDir, 'r.0.application%2Foctet-stream.bin'),
        new Uint8Array([1, 2, 3])
      )
      // A chunk is located from its sidecar, so the orphan carries one that
      // names its file, and the read opens its stream before the parent gate
      // 404s.
      await writeFile(
        path.join(chunkDir, '.meta.0.json'),
        JSON.stringify({
          contentType: 'application/octet-stream',
          fileName: 'r.0.application%2Foctet-stream.bin'
        })
      )

      // Capture every stream the backend hands the handler.
      const { storage } = fastify
      const originalGetChunk = storage.getChunk.bind(storage)
      const streams: Readable[] = []
      storage.getChunk = async options => {
        const result = await originalGetChunk(options)
        streams.push(result.resourceStream)
        return result
      }
      try {
        for (let probe = 0; probe < 5; probe++) {
          assert.equal(
            await statusOf(
              alice.pws.request({
                url: chunkUrl('orphan-leak', 0),
                method: 'GET'
              })
            ),
            404
          )
        }
      } finally {
        storage.getChunk = originalGetChunk
      }
      assert.equal(streams.length, 5, 'expected one opened stream per probe')
      for (const stream of streams) {
        assert.ok(stream.destroyed, 'expected the discarded stream destroyed')
      }
    })

    it('an unauthenticated chunk write is the masked not-found (404)', async () => {
      const resourceId = 'no-auth-write'
      await dataCollection.put(resourceId, { id: resourceId })

      const response = await fetch(new URL(chunkUrl(resourceId, 0)), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'x'
      })
      assert.equal(response.status, 404)
    })
  })

  describe('conditional writes', () => {
    it('[signed] If-Match / If-None-Match gate on the chunk ETag', async () => {
      const resourceId = 'conditional'
      await dataCollection.put(resourceId, { id: resourceId })

      const created = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([1])], {
          type: 'application/octet-stream'
        })
      })
      const createdEtag = created.headers.get('etag')
      parseEtagSegments(createdEtag)

      // A stale If-Match is rejected...
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([2])], {
              type: 'application/octet-stream'
            }),
            headers: { 'if-match': '"noSuchGen.1.0.x"' }
          })
        ),
        412
      )

      // ...the matching one succeeds and advances the stamp.
      const updated = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([2])], {
          type: 'application/octet-stream'
        }),
        headers: { 'if-match': createdEtag! }
      })
      assert.equal(updated.status, 204)
      const updatedEtag = updated.headers.get('etag')
      assertEtagAdvanced({ before: createdEtag, after: updatedEtag })
      assert.equal(etagGeneration(updatedEtag!), etagGeneration(createdEtag!))

      // If-None-Match: * on an existing chunk 412s (create-if-absent fails).
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([3])], {
              type: 'application/octet-stream'
            }),
            headers: { 'if-none-match': '*' }
          })
        ),
        412
      )
    })

    it('[signed] DELETE of an absent chunk 404s; DELETE of a present one 204s', async () => {
      const resourceId = 'delete-chunk'
      await dataCollection.put(resourceId, { id: resourceId })

      // Unlike Delete Resource, deleting an absent chunk is a 404.
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'DELETE'
          })
        ),
        404
      )

      await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([7])], {
          type: 'application/octet-stream'
        })
      })
      const deleted = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'GET'
          })
        ),
        404
      )
    })

    it('[signed] deleting the last chunk removes the on-disk chunk directory', async () => {
      const resourceId = 'dir-cleanup'
      await dataCollection.put(resourceId, { id: resourceId })
      for (const index of [0, 1]) {
        await alice.pws.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
      }

      const chunkDir = path.join(
        backend.dataDir,
        'spaces',
        spaceId,
        'data',
        `.chunks.${resourceId}`
      )
      await stat(chunkDir) // present while chunks remain

      await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })
      await stat(chunkDir) // still present: chunk 1 remains

      // The last delete removes the emptied directory itself, so it neither
      // shows up in the export walk nor counts toward the du-based quota.
      await alice.pws.request({
        url: chunkUrl(resourceId, 1),
        method: 'DELETE'
      })
      await assert.rejects(stat(chunkDir), { code: 'ENOENT' })
    })

    it('a chunk delete is a hard delete: the re-created chunk starts a new generation', async () => {
      const resourceId = 'chunk-generation-reset'
      await dataCollection.put(resourceId, { id: resourceId })

      const created = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([1])], {
          type: 'application/octet-stream'
        })
      })
      const oldEtag = created.headers.get('etag')!
      parseEtagSegments(oldEtag)

      await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })

      // Unlike a Resource tombstone, a chunk keeps no sidecar across the
      // delete, so re-creating it mints a fresh generation.
      const recreated = await alice.pws.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([9, 9])], {
          type: 'application/octet-stream'
        })
      })
      const newEtag = recreated.headers.get('etag')
      parseEtagSegments(newEtag)
      assert.notEqual(etagGeneration(newEtag!), etagGeneration(oldEtag))

      // The old ETag is not the current one: a conditional GET with it is the
      // full (new) representation, never a 304.
      const conditional = await responseOf(
        alice.pws.request({
          url: chunkUrl(resourceId, 0),
          method: 'GET',
          headers: { 'if-none-match': oldEtag }
        })
      )
      assert.equal(conditional.status, 200)
      assert.equal(conditional.headers.get('etag'), newEtag)
      assert.deepEqual(
        new Uint8Array(await conditional.arrayBuffer()),
        new Uint8Array([9, 9])
      )

      // And an If-Match write against the old validator 412s: it names a
      // generation the current chunk no longer carries.
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([3])], {
              type: 'application/octet-stream'
            }),
            headers: { 'if-match': oldEtag }
          })
        ),
        412
      )
    })
  })

  describe('changes feed', () => {
    it('[signed] chunk writes do not surface on the changes feed; the parent manifest PUT does', async () => {
      const feedCollection = await aliceSpace.createCollection({
        id: 'feed',
        name: 'Feed'
      })
      const queryUrl = `${baseServerUrl}space/${spaceId}/feed/query`
      const feedChunkUrl = (index: number) =>
        `${baseServerUrl}space/${spaceId}/feed/manifest/chunks/${index}`

      await feedCollection.put('manifest', { id: 'manifest', sequence: 0 })

      // Drain the feed and keep the checkpoint after the initial write.
      const initial = await alice.pws.request({
        url: queryUrl,
        method: 'POST',
        json: { profile: 'changes', limit: 10 }
      })
      assert.ok(
        initial.data.documents.some(
          (document: { id: string }) => document.id === 'manifest'
        )
      )
      const checkpoint = initial.data.checkpoint

      // A chunk write and a chunk delete stamp only the chunk's own record:
      // neither touches the parent Resource's feed position.
      for (const index of [0, 1]) {
        await alice.pws.request({
          url: feedChunkUrl(index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
      }
      await alice.pws.request({ url: feedChunkUrl(1), method: 'DELETE' })
      const afterChunks = await alice.pws.request({
        url: queryUrl,
        method: 'POST',
        json: { profile: 'changes', limit: 10, checkpoint }
      })
      assert.deepEqual(afterChunks.data.documents, [])

      // The intended flow -- write chunks, then PUT the parent manifest with
      // its new sequence -- is what surfaces the change to replicators.
      await feedCollection.put('manifest', { id: 'manifest', sequence: 1 })
      const afterManifest = await alice.pws.request({
        url: queryUrl,
        method: 'POST',
        json: { profile: 'changes', limit: 10, checkpoint }
      })
      assert.deepEqual(
        afterManifest.data.documents.map(
          (document: { id: string }) => document.id
        ),
        ['manifest']
      )
    })
  })

  describe('parent-delete cascade', () => {
    it('[signed] deleting the parent Resource removes its chunks', async () => {
      const resourceId = 'cascade'
      await dataCollection.put(resourceId, { id: resourceId })
      for (const index of [0, 1]) {
        await alice.pws.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
      }

      // Delete the parent Resource.
      const deleted = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)

      // The chunks are gone (404), and the listing 404s since the parent is gone.
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: chunkUrl(resourceId, 0),
            method: 'GET'
          })
        ),
        404
      )
      assert.equal(
        await statusOf(
          alice.pws.request({
            url: listUrl(resourceId),
            method: 'GET'
          })
        ),
        404
      )
    })
  })

  describe('export / import round-trip', () => {
    it('[signed] chunks travel through Space export and import', async () => {
      const resourceId = 'exported'
      await dataCollection.put(resourceId, { id: resourceId, name: 'Exported' })
      const chunkBytes = [
        new Uint8Array([10, 11]),
        new Uint8Array([20, 21, 22])
      ]
      for (const index of [0, 1]) {
        await alice.pws.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([chunkBytes[index]!], {
            type: 'application/octet-stream'
          })
        })
      }

      const archive = await aliceSpace.export()

      // Import into a fresh Space (merges into a pre-provisioned target).
      const targetSpaceId = '6b5be748-5f39-4936-a895-409e393c399c'
      const targetSpace = await alice.pws.createSpace({
        id: targetSpaceId,
        name: 'Import Target',
        controller: alice.did
      })
      await targetSpace.import(archive)

      // The chunk bytes came back under the target Space's mirrored Collection.
      const targetChunkUrl = (index: number) =>
        `${baseServerUrl}space/${targetSpaceId}/data/${resourceId}/chunks/${index}`
      for (const index of [0, 1]) {
        const response = await alice.pws.request({
          url: targetChunkUrl(index),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          chunkBytes[index]
        )
      }

      // The listing round-trips too.
      const listing = await alice.pws.request({
        url: `${baseServerUrl}space/${targetSpaceId}/data/${resourceId}/chunks/`,
        method: 'GET'
      })
      assert.equal(listing.data.count, 2)
      assert.deepEqual(
        listing.data.chunks.map((chunk: { index: number }) => chunk.index),
        [0, 1]
      )
    })
  })

  describe('per-upload cap (413)', () => {
    let capFastify: FastifyInstance, capServerUrl: string, capAlice: any

    const capSpaceId = '94f03216-5ab4-4723-853c-cf837c171323'
    const maxUploadBytes = 1024

    beforeAll(async () => {
      ;({ fastify: capFastify, baseServerUrl: capServerUrl } =
        await startTestServer({
          backend: await openTempBackend({
            prefix: 'was-chunks-cap-',
            maxUploadBytes
          })
        }))
      ;({ alice: capAlice } = await zcapClients({
        baseServerUrl: capServerUrl
      }))

      const space = await capAlice.pws.createSpace({
        id: capSpaceId,
        name: 'Chunk Upload Cap Space',
        controller: capAlice.did
      })
      await space.createCollection({ id: 'data', name: 'Data' })
    })

    afterAll(async () => {
      await capFastify.close()
    })

    it('[signed] a chunk over maxUploadBytes is rejected with 413', async () => {
      const resourceId = 'too-big'
      await capAlice.pws
        .space(capSpaceId)
        .collection('data')
        .put(resourceId, { id: resourceId })

      const oversized = new Uint8Array(maxUploadBytes * 2)
      assert.equal(
        await statusOf(
          capAlice.pws.request({
            url: `${capServerUrl}space/${capSpaceId}/data/${resourceId}/chunks/0`,
            method: 'PUT',
            body: new Blob([oversized], { type: 'application/octet-stream' })
          })
        ),
        413
      )
    })
  })
})
