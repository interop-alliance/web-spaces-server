/**
 * Collection `changes` query-profile tests (Vitest): the replication change feed
 * served at `POST /space/:s/:c/query` (spec "Collection-level reserved
 * endpoints").
 *
 * Signed queries use the raw `pws.request` escape hatch: the high-level client
 * does not yet surface the change feed. The query parameters ride the signed
 * JSON body.
 *
 * The same-millisecond cases (a rewrite or a lower-sorting id landing in the
 * checkpoint's millisecond) are the storage contract's, under a frozen
 * clock, since the request layer only wraps the backend's feed position.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'
import { base64urlnopad } from '@scure/base'

import type { Space } from '@interop/pws-client'
import { isResourceChange } from '@interop/storage-core'

import { createApp } from '../src/server.js'
import { signedInject } from '../src/testing.js'
import type { IDID } from '../src/types.js'
import {
  entryLine,
  etagGeneration,
  genesisLine,
  oneEpoch,
  openTempBackend,
  parseEtagSegments,
  twoEpochs,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Collection changes query profile', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  /**
   * Builds a checkpoint in this server's encoding by hand, for the refusal
   * cases: the client never builds one, it only echoes what it was handed.
   */
  function forgeCheckpoint(value: unknown): string {
    return base64urlnopad.encode(
      new TextEncoder().encode(JSON.stringify(value))
    )
  }

  /** Decodes a checkpoint in this server's encoding. */
  function readCheckpoint(checkpoint: string): unknown {
    return JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(checkpoint))
    )
  }

  /** The absolute URL of one of Alice's Collections, the checkpoint's scope. */
  function feedUrl(collectionId: string): string {
    return new URL(
      `/space/${alice.space1.id}/${collectionId}/`,
      baseServerUrl
    ).toString()
  }

  /**
   * The absolute URL of a Collection's Metadata object.
   */
  function metaUrl(collectionId: string): string {
    return `${feedUrl(collectionId)}meta`
  }

  /** POSTs the `changes` query body to a Collection's `/query` with `signer`. */
  async function queryChanges(
    signer: any,
    collectionId: string,
    body: Record<string, unknown>
  ): Promise<any> {
    const url = new URL(
      `/space/${alice.space1.id}/${collectionId}/query`,
      baseServerUrl
    ).toString()
    return signer.pws.request({
      url,
      method: 'POST',
      json: { profile: 'changes', ...body }
    })
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
  })
  afterAll(async () => {
    await fastify.close()
  })

  /**
   * The `resource` documents of a page, in feed order: what a consumer that
   * syncs Resources keeps, skipping every other kind.
   */
  function resourceDocs(documents: any[]): any[] {
    return documents.filter(isResourceChange)
  }

  /** Creates a Collection and PUTs `{ n: <id> }` at each id, in order. */
  async function seedCollection(collectionId: string, ids: string[]) {
    const collection = await aliceSpace.createCollection({
      id: collectionId,
      name: collectionId
    })
    for (const id of ids) {
      await collection.put(id, { n: id })
    }
    return collection
  }

  it('returns changed documents with kind/id/deleted/stamp/data + checkpoint', async () => {
    await seedCollection('feed', ['c', 'a', 'b'])
    const { data } = await queryChanges(alice, 'feed', { limit: 10 })

    // The Collection's create comes first, then the Resources in write
    // order, not id order.
    assert.deepEqual(
      data.documents.map((doc: any) => doc.kind),
      ['collection-metadata', 'resource', 'resource', 'resource']
    )
    assert.deepEqual(
      resourceDocs(data.documents).map((doc: any) => doc.id),
      ['c', 'a', 'b']
    )
    for (const doc of resourceDocs(data.documents)) {
      assert.equal(doc.deleted, false)
      assert.equal('_deleted' in doc, false)
      assert.equal(doc.contentType, 'application/json')
      assert.equal(doc.version, undefined)
      assert.deepEqual(doc.data, { n: doc.id })
      assert.ok(typeof doc.updatedAt === 'string')
      assert.equal(typeof doc.updatedAtCounter, 'number')
      assert.equal(typeof doc.originId, 'string')
      assert.ok(typeof doc.checkpoint === 'string')
    }
    // The page's checkpoint is its last document's, an opaque string.
    const last = data.documents[data.documents.length - 1]
    assert.equal(typeof data.checkpoint, 'string')
    assert.equal(data.checkpoint, last.checkpoint)
    // This server's encoding: the Collection's absolute URL, its feed
    // counter's generation, and the feed position, base64url-encoded JSON.
    const { generation, ...rest } = readCheckpoint(data.checkpoint) as any
    assert.equal(typeof generation, 'string')
    // The Collection's create took position 1.
    assert.deepEqual(rest, { feed: feedUrl('feed'), position: 4 })
    // Every checkpoint of one feed carries the same generation.
    for (const doc of data.documents) {
      assert.equal(
        (readCheckpoint(doc.checkpoint) as any).generation,
        generation
      )
    }
  })

  it('surfaces a tombstone as deleted:true with no data', async () => {
    const collection = await seedCollection('with-delete', ['keep', 'remove'])
    const before = await queryChanges(alice, 'with-delete', { limit: 10 })
    const live = before.data.documents.find((doc: any) => doc.id === 'remove')
    await collection.resource('remove').delete()

    const { data } = await queryChanges(alice, 'with-delete', { limit: 10 })
    const byId = new Map(data.documents.map((doc: any) => [doc.id, doc]))
    assert.equal((byId.get('keep') as any).deleted, false)
    const tombstone = byId.get('remove') as any
    assert.equal(tombstone.kind, 'resource')
    assert.equal(tombstone.deleted, true)
    assert.equal('_deleted' in tombstone, false)
    assert.equal(tombstone.contentType, 'application/json')
    assert.equal(tombstone.data, undefined, 'tombstone carries no data')
    assert.equal(tombstone.version, undefined)
    // The delete minted a later content stamp.
    const later =
      Date.parse(tombstone.updatedAt) > Date.parse(live.updatedAt) ||
      (tombstone.updatedAt === live.updatedAt &&
        tombstone.updatedAtCounter > live.updatedAtCounter)
    assert.ok(later, 'delete minted a later stamp')
  })

  it('carries createdBy on live documents and on tombstones so provenance replicates', async () => {
    const collection = await seedCollection('creator-feed', ['keep', 'remove'])
    await collection.resource('remove').delete()

    const { data } = await queryChanges(alice, 'creator-feed', { limit: 10 })
    const byId = new Map(data.documents.map((doc: any) => [doc.id, doc]))
    assert.equal((byId.get('keep') as any).createdBy, alice.did)
    const tombstone = byId.get('remove') as any
    assert.equal(tombstone.deleted, true)
    assert.equal(tombstone.createdBy, alice.did)
  })

  it('carries the nested meta stamp and custom so a metadata edit replicates', async () => {
    const collection = await seedCollection('meta-feed', ['a'])
    const before = await queryChanges(alice, 'meta-feed', { limit: 10 })
    // A metadata-only edit: the resource re-surfaces in the feed carrying its
    // `custom` and a nested `meta` stamp, with the content stamp and `data`
    // unchanged.
    await collection.resource('a').setMeta({ custom: { name: 'labeled' } })

    const { data } = await queryChanges(alice, 'meta-feed', { limit: 10 })
    const doc = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(doc, 'expected the edited resource in the feed')
    assert.deepEqual(doc.custom, { name: 'labeled' })
    assert.equal(doc.metaVersion, undefined)
    assert.equal(typeof doc.meta.updatedAt, 'string')
    assert.equal(typeof doc.meta.updatedAtCounter, 'number')
    assert.equal(typeof doc.meta.originId, 'string')
    assert.equal(typeof doc.meta.generation, 'string')
    assert.equal(
      doc.updatedAt,
      before.data.documents.find((entry: any) => entry.id === 'a').updatedAt,
      'content stamp unchanged by a meta edit'
    )
    assert.deepEqual(doc.data, { n: 'a' })
  })

  it('carries etag/metaEtag matching the ETag headers a GET returns', async () => {
    const collection = await seedCollection('etag-feed', ['a'])
    await collection.resource('a').setMeta({ custom: { name: 'labeled' } })

    const { data } = await queryChanges(alice, 'etag-feed', { limit: 10 })
    const doc = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(doc, 'expected the resource in the feed')

    const resourceUrl = new URL(
      `/space/${alice.space1.id}/etag-feed/a`,
      baseServerUrl
    ).toString()
    const getResponse = await alice.pws.request({
      url: resourceUrl,
      method: 'GET'
    })
    assert.equal(typeof doc.etag, 'string')
    assert.equal(doc.etag, getResponse.headers.get('etag'))

    const metaResponse = await alice.pws.request({
      url: `${resourceUrl}/meta`,
      method: 'GET'
    })
    assert.equal(typeof doc.metaEtag, 'string')
    assert.equal(doc.metaEtag, metaResponse.headers.get('etag'))
  })

  it('carries metaEtag before any /meta write, matching GET .../meta', async () => {
    // No metadata was written, so the composite is the content validator
    // alone, as `GET .../meta` serves it from the first content write.
    await seedCollection('etag-feed-premeta', ['a'])

    const { data } = await queryChanges(alice, 'etag-feed-premeta', {
      limit: 10
    })
    const doc = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(doc, 'expected the resource in the feed')
    assert.equal(doc.meta, undefined)

    const resourceUrl = new URL(
      `/space/${alice.space1.id}/etag-feed-premeta/a`,
      baseServerUrl
    ).toString()
    const metaResponse = await alice.pws.request({
      url: `${resourceUrl}/meta`,
      method: 'GET'
    })
    assert.equal(typeof doc.metaEtag, 'string')
    assert.equal(doc.metaEtag, metaResponse.headers.get('etag'))
    assert.equal(doc.metaEtag, doc.etag)
  })

  it('carries etag on a tombstone', async () => {
    const collection = await seedCollection('etag-tombstone-feed', ['a'])
    await collection.resource('a').delete()

    const { data } = await queryChanges(alice, 'etag-tombstone-feed', {
      limit: 10
    })
    const tombstone = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(tombstone, 'expected the tombstone in the feed')
    assert.equal(tombstone.deleted, true)
    assert.equal(typeof tombstone.etag, 'string')
  })

  it('iterates by checkpoint, returning only newer changes', async () => {
    await seedCollection('iter', ['a', 'b', 'c', 'd', 'e'])
    const seen: string[] = []
    let checkpoint: string | undefined

    for (let guard = 0; guard < 10; guard++) {
      const { data } = await queryChanges(alice, 'iter', {
        limit: 2,
        ...(checkpoint && { checkpoint })
      })
      assert.ok(data.documents.length <= 2)
      // Caught up: the pull is empty with a null checkpoint.
      if (data.checkpoint === null) {
        assert.deepEqual(data.documents, [])
        break
      }
      seen.push(...resourceDocs(data.documents).map((doc: any) => doc.id))
      checkpoint = data.checkpoint
    }
    assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'd', 'e'])
  })

  it('rejects a body with no profile with 400 invalid-request-body', async () => {
    await seedCollection('missing-profile', ['a'])
    let thrown: any
    try {
      // `profile: undefined` overrides the helper's default and is dropped by
      // JSON serialization, so the signed body has no `profile` member.
      await queryChanges(alice, 'missing-profile', { profile: undefined })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected a missing profile to be rejected')
    assert.equal(thrown.response.status, 400)
    assert.equal(thrown.data.type, 'https://w3id.org/pws#invalid-request-body')
  })

  it('rejects an unknown profile with 501', async () => {
    await seedCollection('unknown-profile', ['a'])
    let thrown: any
    try {
      await queryChanges(alice, 'unknown-profile', {
        profile: 'something-else'
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected an unknown profile to be rejected')
    assert.equal(thrown.response.status, 501)
  })

  it("resumes from any document's checkpoint, not only the page's", async () => {
    await seedCollection('prefix-resume', ['a', 'b', 'c', 'd'])
    const { data } = await queryChanges(alice, 'prefix-resume', { limit: 10 })
    assert.deepEqual(
      data.documents.map((doc: any) => doc.id),
      [metaUrl('prefix-resume'), 'a', 'b', 'c', 'd']
    )
    // A client that applied only the Collection, `a` and `b` checkpoints on
    // `b`.
    const { data: rest } = await queryChanges(alice, 'prefix-resume', {
      limit: 10,
      checkpoint: data.documents[2].checkpoint
    })
    assert.deepEqual(
      rest.documents.map((doc: any) => doc.id),
      ['c', 'd']
    )
    assert.equal(rest.checkpoint, data.checkpoint)
  })

  describe('refuses a checkpoint this server did not issue for this Collection', () => {
    /** Asserts the query is refused as `invalid-request-body` at the checkpoint. */
    async function assertRefused(collectionId: string, checkpoint: unknown) {
      let thrown: any
      try {
        await queryChanges(alice, collectionId, { checkpoint })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected the checkpoint to be rejected')
      assert.equal(thrown.response.status, 400)
      assert.equal(
        thrown.data.type,
        'https://w3id.org/pws#invalid-request-body'
      )
      assert.equal(thrown.data.errors?.[0]?.pointer, '#/checkpoint')
    }

    it('the retired { id, updatedAt } object', async () => {
      await seedCollection('retired-checkpoint', ['a'])
      const { data } = await queryChanges(alice, 'retired-checkpoint', {
        limit: 10
      })
      await assertRefused('retired-checkpoint', {
        id: 'a',
        updatedAt: data.documents[0].updatedAt
      })
    })

    it("another Collection's checkpoint", async () => {
      await seedCollection('scope-one', ['a'])
      await seedCollection('scope-two', ['a'])
      const { data } = await queryChanges(alice, 'scope-one', { limit: 10 })
      await assertRefused('scope-two', data.checkpoint)
    })

    it("another server's checkpoint for the same path", async () => {
      await seedCollection('scope-server', ['a'])
      const { data } = await queryChanges(alice, 'scope-server', { limit: 10 })
      const { generation } = readCheckpoint(data.checkpoint) as any
      await assertRefused(
        'scope-server',
        forgeCheckpoint({
          feed: `https://elsewhere.example/space/${alice.space1.id}/scope-server/`,
          generation,
          position: 1
        })
      )
    })

    it('a checkpoint from before the Collection was deleted and re-created', async () => {
      // The re-created Collection has the same URL, and its feed restarts at
      // 1. Reading the old position would skip the new feed up to it.
      const collection = await seedCollection('reborn', ['a', 'b', 'c'])
      const { data: before } = await queryChanges(alice, 'reborn', {
        limit: 10
      })
      await collection.delete()
      await seedCollection('reborn', ['a', 'b'])
      await assertRefused('reborn', before.checkpoint)
      // A checkpoint held from before its first write is refused as well: no
      // position has been handed out under any generation yet.
      await aliceSpace.collection('reborn').delete()
      await aliceSpace.createCollection({ id: 'reborn', name: 'reborn' })
      await assertRefused('reborn', before.checkpoint)
      // The new feed issues checkpoints of its own, starting with the
      // Collection's create at position 1, which resume it.
      const { data: after } = await queryChanges(alice, 'reborn', { limit: 10 })
      const { generation, position } = readCheckpoint(after.checkpoint) as any
      assert.equal(position, 1)
      assert.notEqual(
        generation,
        (readCheckpoint(before.checkpoint) as any).generation
      )
      const { data: resumed } = await queryChanges(alice, 'reborn', {
        limit: 10,
        checkpoint: after.checkpoint
      })
      assert.deepEqual(resumed.documents, [])
      assert.equal(resumed.checkpoint, null)
    })

    it('strings that do not decode to this shape', async () => {
      await seedCollection('bad-checkpoint', ['a'])
      const feed = feedUrl('bad-checkpoint')
      const { data } = await queryChanges(alice, 'bad-checkpoint', {
        limit: 10
      })
      const { generation } = readCheckpoint(data.checkpoint) as any
      for (const checkpoint of [
        'not base64url!',
        forgeCheckpoint('just a string'),
        forgeCheckpoint({ feed }),
        forgeCheckpoint({ feed, generation }),
        forgeCheckpoint({ feed, position: 1 }),
        forgeCheckpoint({ feed, generation: 'other', position: 1 }),
        forgeCheckpoint({ feed, generation: 1, position: 1 }),
        forgeCheckpoint({ feed, generation, position: -1 }),
        forgeCheckpoint({ feed, generation, position: 1.5 }),
        forgeCheckpoint({ feed, generation, position: '1' }),
        forgeCheckpoint({ feed, generation, position: 1, extra: true }),
        42
      ]) {
        await assertRefused('bad-checkpoint', checkpoint)
      }
    })
  })

  it('returns 404 to a caller not authorized to read the Collection', async () => {
    await seedCollection('private-feed', ['a'])
    let thrown: any
    try {
      await queryChanges(bob, 'private-feed', { limit: 10 })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, "expected Bob's query to be rejected")
    assert.equal(thrown.response.status, 404)
  })

  describe('document kinds', () => {
    /**
     * The absolute URL of a Collection's governing history log.
     */
    function logUrl(collectionId: string): string {
      return `${metaUrl(collectionId)}/log`
    }

    /**
     * The absolute URL of a Resource in one of Alice's Collections.
     */
    function resourceUrl(collectionId: string, resourceId: string): string {
      return `${feedUrl(collectionId)}${resourceId}`
    }

    /**
     * The `ETag` header a signed GET of `url` answers with.
     */
    async function etagOf(url: string): Promise<string> {
      const response = await alice.pws.request({ url, method: 'GET' })
      const etag = response.headers.get('etag')
      assert.ok(etag, `expected an ETag on GET ${url}`)
      return etag
    }

    /**
     * The feed position a checkpoint carries.
     */
    function positionOf(checkpoint: string): number {
      return (readCheckpoint(checkpoint) as any).position
    }

    /**
     * Asserts the members every document carries, whatever its kind: the
     * write stamp, `generation` equal to the `ETag`'s first segment, the
     * `etag`, a checkpoint, and `deleted` in place of the retired
     * `_deleted`.
     */
    function assertCommonMembers(doc: any) {
      assert.ok(
        ['resource', 'collection-metadata', 'log'].includes(doc.kind),
        `unexpected kind ${doc.kind}`
      )
      assert.equal(typeof doc.id, 'string')
      assert.equal(typeof doc.deleted, 'boolean')
      assert.equal('_deleted' in doc, false)
      assert.equal(typeof doc.updatedAt, 'string')
      assert.equal(typeof doc.updatedAtCounter, 'number')
      assert.equal(typeof doc.originId, 'string')
      assert.equal(typeof doc.etag, 'string')
      assert.equal(doc.generation, etagGeneration(doc.etag))
      assert.equal(typeof doc.checkpoint, 'string')
    }

    /**
     * PUTs bytes with a media type at a Resource or chunk URL.
     */
    async function putBytes(
      url: string,
      bytes: Uint8Array<ArrayBuffer>,
      type: string
    ): Promise<any> {
      return alice.pws.request({
        url,
        method: 'PUT',
        body: new Blob([bytes], { type })
      })
    }

    /**
     * PUTs a governing history log body under the given preconditions and
     * returns the `ETag` it answers with.
     */
    async function putLog(
      collectionId: string,
      body: string,
      headers: Record<string, string>
    ): Promise<string> {
      const response = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'PUT',
        body: new TextEncoder().encode(body),
        headers: { 'content-type': 'text/jsonl', ...headers }
      })
      assert.equal(response.status, 204)
      const etag = response.headers.get('etag')
      assert.ok(etag, 'expected an ETag on the log write')
      return etag
    }

    it('a collection-metadata document names the Metadata object by URL and carries its ETag and stamp', async () => {
      await seedCollection('kinds-meta', [])
      const { data } = await queryChanges(alice, 'kinds-meta', { limit: 10 })
      assert.equal(data.documents.length, 1)
      const [doc] = data.documents
      assertCommonMembers(doc)
      assert.deepEqual(Object.keys(doc).sort(), [
        'checkpoint',
        'deleted',
        'etag',
        'generation',
        'id',
        'kind',
        'originId',
        'updatedAt',
        'updatedAtCounter'
      ])
      assert.equal(doc.kind, 'collection-metadata')
      assert.equal(doc.id, metaUrl('kinds-meta'))
      assert.equal(doc.deleted, false)
      // The Collection's create took the feed's first position.
      assert.equal(positionOf(doc.checkpoint), 1)
      assert.equal(data.checkpoint, doc.checkpoint)

      const read = await alice.pws.request({
        url: metaUrl('kinds-meta'),
        method: 'GET'
      })
      const etag = read.headers.get('etag')
      assert.equal(doc.etag, etag)
      const segments = parseEtagSegments(etag, { container: true })
      assert.equal(doc.generation, segments.generation)
      assert.equal(doc.updatedAt, read.data.updatedAt)
      assert.equal(doc.updatedAtCounter, read.data.updatedAtCounter)
      assert.equal(doc.originId, read.data.originId)
      assert.equal(doc.updatedAt, segments.stamp.updatedAt)
      assert.equal(doc.updatedAtCounter, segments.stamp.updatedAtCounter)
    })

    it('a Collection Metadata update moves the collection-metadata document', async () => {
      await seedCollection('kinds-meta-update', ['a'])
      const { data: before } = await queryChanges(alice, 'kinds-meta-update', {
        limit: 10
      })
      const [created] = before.documents
      assert.equal(created.kind, 'collection-metadata')

      const updated = await alice.pws.request({
        url: metaUrl('kinds-meta-update'),
        method: 'PUT',
        json: { id: 'kinds-meta-update', name: 'Renamed' }
      })
      assert.equal(updated.status, 204)

      const { data: after } = await queryChanges(alice, 'kinds-meta-update', {
        limit: 10,
        checkpoint: before.checkpoint
      })
      assert.equal(after.documents.length, 1)
      const [doc] = after.documents
      assertCommonMembers(doc)
      assert.equal(doc.kind, 'collection-metadata')
      assert.equal(doc.id, metaUrl('kinds-meta-update'))
      assert.equal(positionOf(doc.checkpoint), 3)
      assert.equal(doc.etag, await etagOf(metaUrl('kinds-meta-update')))
      assert.notEqual(doc.etag, created.etag)
      // The update keeps the object's generation.
      assert.equal(doc.generation, created.generation)

      // One document per record: from the start, the Metadata object now
      // follows the Resource written after its create.
      const { data: full } = await queryChanges(alice, 'kinds-meta-update', {
        limit: 10
      })
      assert.deepEqual(
        full.documents.map((entry: any) => entry.id),
        ['a', metaUrl('kinds-meta-update')]
      )
    })

    it('a binary Resource and its tombstone carry contentType and no data', async () => {
      await seedCollection('kinds-binary', [])
      const pngUrl = resourceUrl('kinds-binary', 'blob')
      await putBytes(
        pngUrl,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        'image/png'
      )

      const { data: live } = await queryChanges(alice, 'kinds-binary', {
        limit: 10
      })
      const [liveDoc] = resourceDocs(live.documents)
      assert.equal(resourceDocs(live.documents).length, 1)
      assertCommonMembers(liveDoc)
      assert.equal(liveDoc.id, 'blob')
      assert.equal(liveDoc.deleted, false)
      assert.equal(liveDoc.contentType, 'image/png')
      assert.equal('data' in liveDoc, false)
      assert.equal(liveDoc.etag, await etagOf(pngUrl))
      assert.equal(
        liveDoc.generation,
        parseEtagSegments(liveDoc.etag).generation
      )

      await alice.pws.request({ url: pngUrl, method: 'DELETE' })
      const { data: gone } = await queryChanges(alice, 'kinds-binary', {
        limit: 10,
        checkpoint: live.checkpoint
      })
      assert.equal(gone.documents.length, 1)
      const [tombstone] = gone.documents
      assertCommonMembers(tombstone)
      assert.equal(tombstone.kind, 'resource')
      assert.equal(tombstone.id, 'blob')
      assert.equal(tombstone.deleted, true)
      // A tombstone carries the last-known type, and no bytes.
      assert.equal(tombstone.contentType, 'image/png')
      assert.equal('data' in tombstone, false)
      assert.notEqual(tombstone.etag, liveDoc.etag)
    })

    it('a text/jsonl Resource rides the feed with no inline data', async () => {
      await seedCollection('kinds-jsonl', [])
      const lines = '{"n":1}\n{"n":2}\n'
      for (const resourceId of ['events', 'did.jsonl']) {
        await putBytes(
          resourceUrl('kinds-jsonl', resourceId),
          new TextEncoder().encode(lines),
          'text/jsonl'
        )
      }

      const { data } = await queryChanges(alice, 'kinds-jsonl', { limit: 10 })
      const docs = resourceDocs(data.documents)
      assert.deepEqual(
        docs.map((doc: any) => doc.id),
        ['events', 'did.jsonl']
      )
      for (const doc of docs) {
        assertCommonMembers(doc)
        assert.equal(doc.deleted, false)
        assert.match(doc.contentType, /^text\/jsonl/)
        assert.equal('data' in doc, false)
        assert.equal(doc.etag, await etagOf(resourceUrl('kinds-jsonl', doc.id)))
      }
    })

    it('a /meta write on a binary Resource re-surfaces it, content stamp unchanged', async () => {
      await seedCollection('kinds-binary-meta', [])
      const picUrl = resourceUrl('kinds-binary-meta', 'pic')
      await putBytes(
        picUrl,
        new Uint8Array([1, 2, 3]),
        'application/octet-stream'
      )
      await alice.pws.request({
        url: resourceUrl('kinds-binary-meta', 'other'),
        method: 'PUT',
        json: { n: 'other' }
      })
      const { data: before } = await queryChanges(alice, 'kinds-binary-meta', {
        limit: 10
      })
      const original = before.documents.find((doc: any) => doc.id === 'pic')

      await alice.pws.request({
        url: `${picUrl}/meta`,
        method: 'PUT',
        json: { custom: { name: 'labeled' } }
      })
      const { data: after } = await queryChanges(alice, 'kinds-binary-meta', {
        limit: 10,
        checkpoint: before.checkpoint
      })
      assert.equal(after.documents.length, 1)
      const [doc] = after.documents
      assertCommonMembers(doc)
      assert.equal(doc.kind, 'resource')
      assert.equal(doc.id, 'pic')
      assert.equal(doc.contentType, 'application/octet-stream')
      assert.equal('data' in doc, false)
      assert.deepEqual(doc.custom, { name: 'labeled' })
      assert.equal(typeof doc.meta.generation, 'string')
      assert.equal(doc.metaEtag, await etagOf(`${picUrl}/meta`))
      // The content record did not move.
      assert.equal(doc.etag, original.etag)
      assert.equal(doc.etag, await etagOf(picUrl))
    })

    it('a governed log takes a position on its guarded create and each append, and none on a refused re-send', async () => {
      await seedCollection('kinds-log', [])
      const { data: start } = await queryChanges(alice, 'kinds-log', {
        limit: 10
      })
      const [metaDoc] = start.documents
      assert.equal(metaDoc.kind, 'collection-metadata')

      // The guarded create.
      const genesis = genesisLine(oneEpoch) + '\n'
      const createdEtag = await putLog('kinds-log', genesis, {
        'if-none-match': '*'
      })
      const { data: created } = await queryChanges(alice, 'kinds-log', {
        limit: 10,
        checkpoint: start.checkpoint
      })
      // The log write does not move the collection-metadata document.
      assert.equal(created.documents.length, 1)
      const [logDoc] = created.documents
      assertCommonMembers(logDoc)
      assert.deepEqual(Object.keys(logDoc).sort(), [
        'checkpoint',
        'deleted',
        'etag',
        'generation',
        'id',
        'kind',
        'originId',
        'updatedAt',
        'updatedAtCounter'
      ])
      assert.equal(logDoc.kind, 'log')
      assert.equal(logDoc.id, logUrl('kinds-log'))
      assert.equal(logDoc.deleted, false)
      assert.equal(logDoc.etag, createdEtag)
      assert.equal(logDoc.etag, await etagOf(logUrl('kinds-log')))
      const segments = parseEtagSegments(logDoc.etag)
      assert.equal(logDoc.generation, segments.generation)
      assert.equal(logDoc.updatedAt, segments.stamp.updatedAt)
      assert.equal(logDoc.updatedAtCounter, segments.stamp.updatedAtCounter)
      assert.equal(logDoc.originId, segments.stamp.originId)
      assert.equal(positionOf(logDoc.checkpoint), 2)

      // The log write advanced the Metadata object's local segment without
      // a write of the object: its document keeps its position and stamp,
      // and carries the ETag the object now serves.
      const { data: whole } = await queryChanges(alice, 'kinds-log', {
        limit: 10
      })
      assert.deepEqual(
        whole.documents.map((doc: any) => doc.kind),
        ['collection-metadata', 'log']
      )
      const movedMeta = whole.documents[0]
      assert.equal(movedMeta.checkpoint, metaDoc.checkpoint)
      assert.equal(movedMeta.updatedAt, metaDoc.updatedAt)
      assert.equal(movedMeta.updatedAtCounter, metaDoc.updatedAtCounter)
      const metaEtag = await etagOf(metaUrl('kinds-log'))
      assert.equal(movedMeta.etag, metaEtag)
      assert.equal(
        parseEtagSegments(metaEtag, { container: true }).local,
        parseEtagSegments(metaDoc.etag, { container: true }).local! + 1
      )

      // An append.
      const extended =
        genesis + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const appendedEtag = await putLog('kinds-log', extended, {
        'if-match': createdEtag
      })
      const { data: appended } = await queryChanges(alice, 'kinds-log', {
        limit: 10,
        checkpoint: created.checkpoint
      })
      assert.equal(appended.documents.length, 1)
      const [appendDoc] = appended.documents
      assertCommonMembers(appendDoc)
      assert.equal(appendDoc.kind, 'log')
      assert.equal(appendDoc.id, logUrl('kinds-log'))
      assert.equal(appendDoc.etag, appendedEtag)
      assert.equal(appendDoc.generation, logDoc.generation)
      assert.equal(positionOf(appendDoc.checkpoint), 3)

      // A byte-identical PUT is refused and takes no position.
      const resent = await alice.pws
        .request({
          url: logUrl('kinds-log'),
          method: 'PUT',
          body: new TextEncoder().encode(extended),
          headers: { 'content-type': 'text/jsonl', 'if-match': appendedEtag }
        })
        .catch(err => err.response as Response)
      assert.equal(resent.status, 400)
      const { data: idle } = await queryChanges(alice, 'kinds-log', {
        limit: 10,
        checkpoint: appended.checkpoint
      })
      assert.deepEqual(idle.documents, [])
      assert.equal(idle.checkpoint, null)
    })

    it('a chunk write moves nothing on the feed', async () => {
      await seedCollection('kinds-chunks', ['manifest'])
      const { data: before } = await queryChanges(alice, 'kinds-chunks', {
        limit: 10
      })
      for (const index of [0, 1]) {
        await putBytes(
          `${resourceUrl('kinds-chunks', 'manifest')}/chunks/${index}`,
          new Uint8Array([index]),
          'application/octet-stream'
        )
      }
      const { data: after } = await queryChanges(alice, 'kinds-chunks', {
        limit: 10,
        checkpoint: before.checkpoint
      })
      assert.deepEqual(after.documents, [])
      assert.equal(after.checkpoint, null)
    })

    it('pages one document at a time across mixed kinds', async () => {
      await seedCollection('kinds-paging', ['a'])
      await putBytes(
        resourceUrl('kinds-paging', 'bin'),
        new Uint8Array([7]),
        'application/octet-stream'
      )
      await putLog('kinds-paging', genesisLine(oneEpoch) + '\n', {
        'if-none-match': '*'
      })
      await alice.pws.request({
        url: resourceUrl('kinds-paging', 'a'),
        method: 'DELETE'
      })
      await alice.pws.request({
        url: metaUrl('kinds-paging'),
        method: 'PUT',
        json: { id: 'kinds-paging', name: 'Renamed' }
      })

      const pages: any[] = []
      let checkpoint: string | undefined
      for (let guard = 0; guard < 10; guard++) {
        const { data } = await queryChanges(alice, 'kinds-paging', {
          limit: 1,
          ...(checkpoint && { checkpoint })
        })
        if (data.checkpoint === null) {
          assert.deepEqual(data.documents, [])
          break
        }
        assert.equal(data.documents.length, 1)
        // A one-document page's checkpoint is that document's.
        assert.equal(data.checkpoint, data.documents[0].checkpoint)
        pages.push(data.documents[0])
        checkpoint = data.checkpoint
      }

      // The create (position 1) and `a` (2) were overtaken: `a`'s delete
      // took 5 and the Metadata update 6. `bin` keeps 3 and the log 4.
      assert.deepEqual(
        pages.map((doc: any) => [doc.kind, doc.id, doc.deleted]),
        [
          ['resource', 'bin', false],
          ['log', logUrl('kinds-paging'), false],
          ['resource', 'a', true],
          ['collection-metadata', metaUrl('kinds-paging'), false]
        ]
      )
      assert.deepEqual(
        pages.map((doc: any) => positionOf(doc.checkpoint)),
        [3, 4, 5, 6]
      )
      for (const doc of pages) {
        assertCommonMembers(doc)
      }

      // The same documents come back on one page, so paging loses none.
      const { data: whole } = await queryChanges(alice, 'kinds-paging', {
        limit: 10
      })
      assert.deepEqual(whole.documents, pages)
    })
  })
})

describe('Collection changes feed under a base URL ending in a slash', () => {
  it('serves the absolute URLs a pull loop matches against', async () => {
    // Accepted by the config check and kept byte for byte. A replica server
    // builds the prefix it matches a policy document's `id` against with
    // `new URL`, so a doubled slash in the `id` would skip the document.
    const serverUrl = 'https://trailing-slash.example/'
    const spaceId = 'home'
    const collectionUrl = `https://trailing-slash.example/space/${spaceId}/docs/`
    const backend = await openTempBackend()
    const fastify = createApp({ serverUrl, backend, logger: false })
    try {
      const { alice } = await zcapClients({ baseServerUrl: serverUrl })
      await backend.writeSpace({
        spaceId,
        spaceMetadata: {
          id: spaceId,
          type: ['Space'],
          controller: alice.did as IDID
        }
      })
      const server = { fastify, serverUrl }
      const created = await signedInject({
        server,
        signer: alice.signer,
        path: `/space/${spaceId}/docs/meta`,
        method: 'PUT',
        json: { name: 'Docs' }
      })
      assert.equal(created.statusCode, 201, created.payload)
      const policy = await signedInject({
        server,
        signer: alice.signer,
        path: `/space/${spaceId}/docs/policy`,
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      assert.equal(policy.statusCode, 201, policy.payload)

      const feed = await signedInject({
        server,
        signer: alice.signer,
        path: `/space/${spaceId}/docs/query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      assert.equal(feed.statusCode, 200, feed.payload)
      const { documents } = feed.json()
      assert.deepEqual(
        documents.map((document: { id: string }) => document.id),
        [`${collectionUrl}meta`, `${collectionUrl}policy`]
      )
      const checkpoint = JSON.parse(
        new TextDecoder().decode(base64urlnopad.decode(documents[0].checkpoint))
      )
      assert.equal(checkpoint.feed, collectionUrl)
    } finally {
      await fastify.close()
    }
  })
})
