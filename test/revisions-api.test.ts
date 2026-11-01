/**
 * `revisions` descriptor API tests: the Collection Metadata object's
 * `revisions` member (`resolution`, `immutable`, `merge`). Covers the
 * defaults, the shape refusals, `merge` served verbatim, the set-once rule on
 * `resolution` and `immutable` (`revisions-immutable`), the derivation from a
 * governing history log's `state.revisions` slot, and the write-once rule on
 * an immutable Collection (`resource-immutable`) for Resources and chunks, on
 * a plaintext and an encrypted Collection. Last, an import into an immutable
 * Collection skips a Resource the destination holds rather than refusing it.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { chunkDirName, metaSidecarFileName } from '@interop/space-archive'
import { tombstoneSidecarFileName } from '../src/lib/metaSidecar.js'

import type { TempFileSystemBackend } from '../src/testing.js'

import {
  entryLine,
  genesisLine,
  oneEpoch,
  openTempBackend,
  requestError,
  startTestServer,
  zcapClients
} from './helpers.js'

const JSON_TYPE = 'application/json'

/**
 * A structurally valid EDV Encrypted Document, its ciphertext varied by
 * `tag`.
 * @param tag {string}
 * @returns {object}
 */
function envelope(tag: string): object {
  return {
    id: 'z1',
    sequence: 0,
    indexed: [],
    jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: `c1phertext-${tag}` }
  }
}

describe('revisions descriptor API', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  const spaceId = `revisions-space-${crypto.randomUUID()}`

  let backend: TempFileSystemBackend

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
    await alice.pws.createSpace({
      id: spaceId,
      name: 'Revisions Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  const metaUrl = (collectionId: string) =>
    `${baseServerUrl}space/${spaceId}/${collectionId}/meta`

  /**
   * Creates a Collection by POST with the given body members.
   * @param body {object}
   * @returns {Promise<string>}   the Collection id
   */
  async function createCollection(body: object = {}): Promise<string> {
    const collectionId = `col-${crypto.randomUUID()}`
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, ...body }
    })
    return collectionId
  }

  /**
   * Reads a Collection Metadata object.
   * @param collectionId {string}
   * @returns {Promise<any>}
   */
  async function readMeta(collectionId: string): Promise<any> {
    const response = await alice.pws.request({
      url: metaUrl(collectionId),
      method: 'GET'
    })
    return response.data
  }

  /**
   * PUTs a Collection Metadata body.
   * @param collectionId {string}
   * @param json {object}
   * @param [headers] {object}
   * @returns {Promise<any>}
   */
  function putMeta(
    collectionId: string,
    json: object,
    headers: Record<string, string> = {}
  ): Promise<any> {
    return alice.pws.request({
      url: metaUrl(collectionId),
      method: 'PUT',
      json,
      headers
    })
  }

  /**
   * PUTs raw bytes to a URL under the Space.
   * @param url {string}
   * @param body {string}
   * @param [contentType] {string}
   * @returns {Promise<any>}
   */
  function putRaw(
    url: string,
    body: string,
    contentType = JSON_TYPE
  ): Promise<any> {
    return alice.pws.request({
      url,
      method: 'PUT',
      body: new TextEncoder().encode(body),
      headers: { 'content-type': contentType }
    })
  }

  /**
   * Asserts a rejection is the given problem type, status, and pointer.
   * @param err {any}
   * @param options {object}
   * @param options.status {number}
   * @param options.type {string}   the type's fragment
   * @param [options.pointer] {string}
   * @returns {void}
   */
  function assertProblem(
    err: any,
    {
      status,
      type,
      pointer
    }: { status: number; type: string; pointer?: string }
  ): void {
    assert.equal(err.response?.status, status, JSON.stringify(err.data))
    assert.match(err.data.type, new RegExp(`#${type}$`))
    if (pointer !== undefined) {
      assert.equal(err.data.errors[0].pointer, pointer)
    }
  }

  describe('defaults and shape', () => {
    it('a Collection declared without `revisions` serves none, and its Resources update as before', async () => {
      const collectionId = await createCollection()
      assert.equal((await readMeta(collectionId)).revisions, undefined)
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      await putRaw(docUrl, '{"v":1}')
      const updated = await putRaw(docUrl, '{"v":2}')
      assert.equal(updated.status, 200)
    })

    it('serves a declared descriptor verbatim, `merge` included', async () => {
      const revisions = {
        resolution: 'last-writer-wins',
        immutable: true,
        merge: { discipline: 'crdt', options: { nested: [1, 2] } }
      }
      const collectionId = await createCollection({ revisions })
      assert.deepEqual((await readMeta(collectionId)).revisions, revisions)

      // The guarded create-by-PUT declares it as well.
      const byPut = `col-${crypto.randomUUID()}`
      const created = await putMeta(
        byPut,
        { revisions },
        { 'if-none-match': '*' }
      )
      assert.equal(created.status, 201)
      assert.deepEqual(created.data.revisions, revisions)
      assert.deepEqual((await readMeta(byPut)).revisions, revisions)
    })

    it('refuses an unknown `resolution`, the reserved `keep-conflicts` included', async () => {
      for (const resolution of ['keep-conflicts', 'first-writer-wins', 7]) {
        const err = await requestError(
          createCollection({ revisions: { resolution } })
        )
        assertProblem(err, {
          status: 400,
          type: 'invalid-request-body',
          pointer: '#/revisions/resolution'
        })
      }
      const err = await requestError(
        putMeta(`col-${crypto.randomUUID()}`, {
          revisions: { resolution: 'keep-conflicts' }
        })
      )
      assertProblem(err, {
        status: 400,
        type: 'invalid-request-body',
        pointer: '#/revisions/resolution'
      })
    })

    it('refuses a descriptor of the wrong shape, with a pointer to the member', async () => {
      const cases: Array<[unknown, string]> = [
        ['immutable', '#/revisions'],
        [[], '#/revisions'],
        [{ immutable: 'yes' }, '#/revisions/immutable'],
        [{ merge: 'lww' }, '#/revisions/merge'],
        [{ merge: [] }, '#/revisions/merge'],
        [{ conflicts: 'keep' }, '#/revisions/conflicts']
      ]
      for (const [revisions, pointer] of cases) {
        const err = await requestError(createCollection({ revisions }))
        assertProblem(err, {
          status: 400,
          type: 'invalid-request-body',
          pointer
        })
      }
    })
  })

  describe('set-once `resolution` and `immutable`', () => {
    it('`merge` may change while the set members are restated', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true, merge: { v: 1 } }
      })
      const updated = await putMeta(collectionId, {
        revisions: { immutable: true, merge: { v: 2 } }
      })
      assert.equal(updated.status, 204)
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true,
        merge: { v: 2 }
      })
      // Dropping `merge` alone is allowed too: it follows the body.
      await putMeta(collectionId, { revisions: { immutable: true } })
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true
      })
    })

    it('refuses a change to a set member', async () => {
      const collectionId = await createCollection({
        revisions: { resolution: 'last-writer-wins', immutable: true }
      })
      const err = await requestError(
        putMeta(collectionId, {
          revisions: { resolution: 'last-writer-wins', immutable: false }
        })
      )
      assertProblem(err, {
        status: 409,
        type: 'revisions-immutable',
        pointer: '#/revisions/immutable'
      })
    })

    it('refuses a full replacement that omits a set member', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const omitted = await requestError(putMeta(collectionId, { name: 'x' }))
      assertProblem(omitted, {
        status: 409,
        type: 'revisions-immutable',
        pointer: '#/revisions/immutable'
      })
      const partial = await requestError(
        putMeta(collectionId, { revisions: { merge: {} } })
      )
      assertProblem(partial, {
        status: 409,
        type: 'revisions-immutable',
        pointer: '#/revisions/immutable'
      })
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true
      })
    })

    it('an absent member and its default are the same value', async () => {
      // Restating the defaults over a Collection declared without them.
      const bare = await createCollection({ revisions: { merge: { v: 1 } } })
      const restated = {
        resolution: 'last-writer-wins',
        immutable: false,
        merge: { v: 2 }
      }
      const updated = await putMeta(bare, { revisions: restated })
      assert.equal(updated.status, 204)
      assert.deepEqual((await readMeta(bare)).revisions, restated)
      // Dropping the explicit defaults again, and the whole descriptor.
      assert.equal(
        (await putMeta(bare, { revisions: { merge: { v: 3 } } })).status,
        204
      )
      assert.equal((await putMeta(bare, { name: 'x' })).status, 204)
      assert.equal((await readMeta(bare)).revisions, undefined)
      // An explicit default still cannot move to another value.
      const explicit = await createCollection({
        revisions: { immutable: false }
      })
      assertProblem(
        await requestError(
          putMeta(explicit, { revisions: { immutable: true } })
        ),
        {
          status: 409,
          type: 'revisions-immutable',
          pointer: '#/revisions/immutable'
        }
      )
    })

    it('refuses declaring a member on an existing Collection that lacks it', async () => {
      const collectionId = await createCollection()
      const err = await requestError(
        putMeta(collectionId, { revisions: { immutable: true } })
      )
      assertProblem(err, {
        status: 409,
        type: 'revisions-immutable',
        pointer: '#/revisions/immutable'
      })
      // `merge` alone carries no set-once member.
      const mergeOnly = await putMeta(collectionId, {
        revisions: { merge: { a: 1 } }
      })
      assert.equal(mergeOnly.status, 204)
    })
  })

  describe('a log-governed Collection', () => {
    /**
     * PUTs a governing history log body.
     * @param collectionId {string}
     * @param body {string}
     * @param headers {object}
     * @returns {Promise<any>}
     */
    function putLog(
      collectionId: string,
      body: string,
      headers: Record<string, string>
    ): Promise<any> {
      return alice.pws.request({
        url: `${metaUrl(collectionId)}/log`,
        method: 'PUT',
        body: new TextEncoder().encode(body),
        headers: { 'content-type': 'text/jsonl', ...headers }
      })
    }

    it('derives `revisions` from the head `state.revisions` slot, keeping it out of `encryption`', async () => {
      const collectionId = await createCollection()
      const revisions = { immutable: true, merge: { kind: 'none' } }
      const genesis = genesisLine({ ...oneEpoch, revisions })
      const created = await putLog(collectionId, `${genesis}\n`, {
        'if-none-match': '*'
      })
      assert.equal(created.status, 204)
      const meta = await readMeta(collectionId)
      assert.deepEqual(meta.revisions, revisions)
      assert.equal(meta.encryption.revisions, undefined)
      assert.equal(meta.encryption.scheme, 'edv')

      // An append that changes `immutable` is refused ...
      const flipped = entryLine({
        ordinal: 2,
        state: { ...oneEpoch, revisions: { immutable: false } }
      })
      const err = await requestError(
        putLog(collectionId, `${genesis}\n${flipped}\n`, {
          'if-match': created.headers.get('etag')
        })
      )
      assertProblem(err, {
        status: 409,
        type: 'revisions-immutable',
        pointer: '#/revisions/immutable'
      })
      // ... as is one that drops it.
      const dropped = entryLine({ ordinal: 2, state: oneEpoch })
      assertProblem(
        await requestError(
          putLog(collectionId, `${genesis}\n${dropped}\n`, {
            'if-match': created.headers.get('etag')
          })
        ),
        { status: 409, type: 'revisions-immutable' }
      )

      // One that changes `merge` alone is served.
      const remerged = entryLine({
        ordinal: 2,
        state: { ...oneEpoch, revisions: { immutable: true, merge: { v: 2 } } }
      })
      const appended = await putLog(collectionId, `${genesis}\n${remerged}\n`, {
        'if-match': created.headers.get('etag')
      })
      assert.equal(appended.status, 204)
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true,
        merge: { v: 2 }
      })

      // A direct write is checked against the derived descriptor.
      assertProblem(
        await requestError(
          putMeta(collectionId, { revisions: { immutable: false } })
        ),
        {
          status: 409,
          type: 'revisions-immutable',
          pointer: '#/revisions/immutable'
        }
      )
      // A `merge` other than the log's would be dropped, so it is refused.
      assertProblem(
        await requestError(
          putMeta(collectionId, {
            revisions: { immutable: true, merge: { v: 3 } }
          })
        ),
        {
          status: 409,
          type: 'revisions-immutable',
          pointer: '#/revisions/merge'
        }
      )
      // Restating the derived descriptor, `merge` included, passes.
      const echoed = await putMeta(collectionId, {
        revisions: { immutable: true, merge: { v: 2 } }
      })
      assert.equal(echoed.status, 204)
      // Omitting the member is no change: the log holds it.
      const renamed = await putMeta(collectionId, { name: 'renamed' })
      assert.equal(renamed.status, 204)
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true,
        merge: { v: 2 }
      })

      // The governed flag is enforced on Resource writes.
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      await putRaw(docUrl, JSON.stringify(envelope('a')))
      assertProblem(
        await requestError(putRaw(docUrl, JSON.stringify(envelope('b')))),
        { status: 409, type: 'resource-immutable' }
      )
    })

    it('refuses a log whose `state.revisions` has the wrong shape', async () => {
      const collectionId = await createCollection()
      const genesis = genesisLine({
        ...oneEpoch,
        revisions: { resolution: 'keep-conflicts' }
      })
      assertProblem(
        await requestError(
          putLog(collectionId, `${genesis}\n`, { 'if-none-match': '*' })
        ),
        { status: 400, type: 'invalid-request-body' }
      )
    })

    it('a guarded create keeps the members the stored object sets', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const genesis = genesisLine(oneEpoch)
      assertProblem(
        await requestError(
          putLog(collectionId, `${genesis}\n`, { 'if-none-match': '*' })
        ),
        {
          status: 409,
          type: 'revisions-immutable',
          pointer: '#/revisions/immutable'
        }
      )
      const restated = genesisLine({
        ...oneEpoch,
        revisions: { immutable: true }
      })
      const created = await putLog(collectionId, `${restated}\n`, {
        'if-none-match': '*'
      })
      assert.equal(created.status, 204)
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true
      })
    })
  })

  describe('the write-once rule on an immutable Collection', () => {
    const kinds = [
      {
        label: 'plaintext',
        declaration: {},
        first: '{"v":1}',
        second: '{"v":2}'
      },
      {
        label: 'encrypted',
        declaration: { encryption: { scheme: 'edv' } },
        first: JSON.stringify(envelope('first')),
        second: JSON.stringify(envelope('second'))
      }
    ]

    for (const { label, declaration, first, second } of kinds) {
      it(`[${label}] a repeat is a no-op answering the same ETag; a change is refused`, async () => {
        const collectionId = await createCollection({
          ...declaration,
          revisions: { immutable: true }
        })
        const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
        const created = await putRaw(docUrl, first)
        assert.equal(created.status, 201)
        const etag = created.headers.get('etag')

        const repeated = await putRaw(docUrl, first)
        assert.equal(repeated.status, 200)
        assert.equal(repeated.headers.get('etag'), etag)

        assertProblem(await requestError(putRaw(docUrl, second)), {
          status: 409,
          type: 'resource-immutable'
        })
        const read = await alice.pws.request({
          url: docUrl,
          method: 'GET'
        })
        assert.deepEqual(read.data, JSON.parse(first))
        assert.equal(read.headers.get('etag'), etag)

        // Create Resource mints a fresh id, so it is always a create.
        const posted = await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/`,
          method: 'POST',
          body: new TextEncoder().encode(second),
          headers: { 'content-type': JSON_TYPE }
        })
        assert.equal(posted.status, 201)
      })

      it(`[${label}] delete is allowed; a write over the tombstone is held to the deleted content`, async () => {
        const collectionId = await createCollection({
          ...declaration,
          revisions: { immutable: true }
        })
        const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
        const created = await putRaw(docUrl, first)
        const deleted = await alice.pws.request({
          url: docUrl,
          method: 'DELETE'
        })
        assert.equal(deleted.status, 204)
        // The tombstone keeps the deleted content's digest, so a different
        // body is refused: a write-once Collection cannot be edited through
        // a delete and a re-create.
        assertProblem(await requestError(putRaw(docUrl, second)), {
          status: 409,
          type: 'resource-immutable'
        })
        // A repeat of the deleted content is a no-op answering the
        // tombstone's validator, and the Resource stays deleted.
        const repeated = await putRaw(docUrl, first)
        assert.equal(repeated.status, 200)
        const tombstoneEtag = repeated.headers.get('etag')
        assert.ok(tombstoneEtag, 'expected the tombstone validator')
        assert.notEqual(tombstoneEtag, created.headers.get('etag'))
        assert.equal(repeated.data.size, 0)
        const read = await requestError(
          alice.pws.request({ url: docUrl, method: 'GET' })
        )
        assert.equal(read.response?.status, 404)
        // The tombstone stands unchanged.
        const tombstone = JSON.parse(
          await readFile(
            path.join(
              backend.spacesDir,
              spaceId,
              collectionId,
              tombstoneSidecarFileName('doc')
            ),
            'utf8'
          )
        )
        assert.equal(tombstone.deleted, true)
        assert.equal(typeof tombstone.digest, 'string')
      })

      it(`[${label}] chunks follow the rule`, async () => {
        const collectionId = await createCollection({
          ...declaration,
          revisions: { immutable: true }
        })
        const parent = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
        await putRaw(parent, first)
        const chunk = `${parent}/chunks/0`
        const created = await putRaw(
          chunk,
          'chunk zero',
          'application/octet-stream'
        )
        const repeated = await putRaw(
          chunk,
          'chunk zero',
          'application/octet-stream'
        )
        assert.equal(repeated.headers.get('etag'), created.headers.get('etag'))
        assertProblem(
          await requestError(
            putRaw(chunk, 'chunk 0 v2', 'application/octet-stream')
          ),
          { status: 409, type: 'resource-immutable' }
        )
      })
    }

    it('a repeat under the same media type with a parameter is still the no-op', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      const created = await putRaw(docUrl, '{"v":1}')
      const repeated = await putRaw(
        docUrl,
        '{"v":1}',
        'application/json; charset=utf-8'
      )
      assert.equal(repeated.status, 200)
      assert.equal(repeated.headers.get('etag'), created.headers.get('etag'))
    })

    it('a write over a Resource whose sidecar is missing is a create', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const collectionDir = path.join(backend.spacesDir, spaceId, collectionId)
      const chunkDir = path.join(collectionDir, chunkDirName('doc'))
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      const chunkUrl = `${docUrl}/chunks/0`
      await putRaw(docUrl, '{"v":1}')
      await putRaw(chunkUrl, 'chunk zero', 'application/octet-stream')
      // A write torn between the bytes and the sidecar leaves this state. A
      // file no sidecar names never committed, so it is not a stored
      // Resource or chunk, and the write-once rule does not bind it.
      await rm(path.join(chunkDir, metaSidecarFileName('0')))
      await rm(path.join(collectionDir, metaSidecarFileName('doc')))

      const created = await putRaw(docUrl, '{"v":2}')
      assert.equal(created.status, 201)
      const etag = created.headers.get('etag')
      assert.ok(etag, 'expected the create to answer a validator')
      const read = await alice.pws.request({
        url: docUrl,
        method: 'GET'
      })
      assert.deepEqual(read.data, { v: 2 })
      assert.equal(read.headers.get('etag'), etag)
      // The create committed, so the rule binds from here on.
      assertProblem(await requestError(putRaw(docUrl, '{"v":3}')), {
        status: 409,
        type: 'resource-immutable'
      })

      const chunk = await putRaw(
        chunkUrl,
        'chunk one',
        'application/octet-stream'
      )
      assert.equal(chunk.status, 204)
      assert.ok(chunk.headers.get('etag'), 'expected a chunk validator')
      assertProblem(
        await requestError(
          putRaw(chunkUrl, 'chunk two', 'application/octet-stream')
        ),
        { status: 409, type: 'resource-immutable' }
      )
    })

    it('a repeat over a re-create torn before its sidecar answers 201 with fresh provenance', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: false }
      })
      const collectionDir = path.join(backend.spacesDir, spaceId, collectionId)
      const sidecarPath = path.join(collectionDir, metaSidecarFileName('doc'))
      const tombstonePath = path.join(
        collectionDir,
        tombstoneSidecarFileName('doc')
      )
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      await putRaw(docUrl, '{"v":1}')
      await alice.pws.request({
        url: docUrl,
        method: 'DELETE'
      })
      const tombstone = await readFile(tombstonePath)
      await putRaw(docUrl, '{"v":2}')
      // The re-create's bytes landed and its sidecar did not.
      await rm(sidecarPath)
      await writeFile(tombstonePath, tombstone)

      const healed = await putRaw(docUrl, '{"v":2}')
      assert.equal(healed.status, 201)
      assert.equal(healed.data.createdBy, alice.did)
      assert.equal(healed.data.createdAt, healed.data.updatedAt)
      const read = await alice.pws.request({
        url: docUrl,
        method: 'GET'
      })
      assert.deepEqual(read.data, { v: 2 })
      assert.equal(read.headers.get('etag'), healed.headers.get('etag'))
    })

    it('a write-once repeat over a tombstone reclaims the file a torn delete left beside it', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const collectionDir = path.join(backend.spacesDir, spaceId, collectionId)
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      await putRaw(docUrl, '{"v":1}')
      const [fileName] = (await readdir(collectionDir)).filter(name =>
        name.startsWith('r.doc.')
      )
      assert.ok(fileName, 'expected the stored representation file')
      const bytes = await readFile(path.join(collectionDir, fileName))
      await alice.pws.request({ url: docUrl, method: 'DELETE' })
      // A delete cut short after its tombstone: the file is back beside it.
      await writeFile(path.join(collectionDir, fileName), bytes)

      // The repeat is the only write the id takes again, so it reclaims the
      // file, and the tombstone stands.
      const repeated = await putRaw(docUrl, '{"v":1}')
      assert.equal(repeated.status, 200)
      const names = await readdir(collectionDir)
      assert.ok(!names.some(name => name.startsWith('r.doc.')))
      assert.ok(names.includes(tombstoneSidecarFileName('doc')))
      const read = await requestError(
        alice.pws.request({ url: docUrl, method: 'GET' })
      )
      assert.equal(read.response?.status, 404)
    })

    it('a live sidecar with no digest is still held, through the stored file', async () => {
      // The rule never lapses over a live Resource: a sidecar that lost its
      // digest is compared through a digest of the file it names.
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const collectionDir = path.join(backend.spacesDir, spaceId, collectionId)
      const sidecarPath = path.join(collectionDir, metaSidecarFileName('doc'))
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      const created = await putRaw(docUrl, '{"v":1}')
      const { digest, ...undigested } = JSON.parse(
        await readFile(sidecarPath, 'utf8')
      )
      assert.equal(typeof digest, 'string')
      await writeFile(sidecarPath, JSON.stringify(undigested))

      assertProblem(await requestError(putRaw(docUrl, '{"v":2}')), {
        status: 409,
        type: 'resource-immutable'
      })
      const repeated = await putRaw(docUrl, '{"v":1}')
      assert.equal(repeated.status, 200)
      assert.equal(repeated.headers.get('etag'), created.headers.get('etag'))
      const read = await alice.pws.request({ url: docUrl, method: 'GET' })
      assert.deepEqual(read.data, { v: 1 })
    })

    it('a tombstone with no digest admits a create', async () => {
      // An import writes a tombstone with no bytes to digest. Such a
      // tombstone holds nothing the rule can compare, so a write over it is
      // an ordinary create.
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const collectionDir = path.join(backend.spacesDir, spaceId, collectionId)
      const tombstonePath = path.join(
        collectionDir,
        tombstoneSidecarFileName('doc')
      )
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      await putRaw(docUrl, '{"v":1}')
      await alice.pws.request({ url: docUrl, method: 'DELETE' })
      const { digest, ...undigested } = JSON.parse(
        await readFile(tombstonePath, 'utf8')
      )
      assert.equal(typeof digest, 'string')
      await writeFile(tombstonePath, JSON.stringify(undigested))

      const created = await putRaw(docUrl, '{"v":2}')
      assert.equal(created.status, 201)
      const read = await alice.pws.request({ url: docUrl, method: 'GET' })
      assert.deepEqual(read.data, { v: 2 })
    })

    it('a Resource metadata write is not refused', async () => {
      const collectionId = await createCollection({
        revisions: { immutable: true }
      })
      const docUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/doc`
      await putRaw(docUrl, '{"v":1}')
      const meta = await alice.pws.request({
        url: `${docUrl}/meta`,
        method: 'PUT',
        json: { custom: { name: 'annotated' } }
      })
      assert.equal(meta.status, 200)
    })
  })

  describe('import', () => {
    it('skips a Resource the immutable destination holds rather than refusing it', async () => {
      const collectionId = `col-${crypto.randomUUID()}`
      // The destination: an immutable Collection holding `doc`.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, revisions: { immutable: true } }
      })
      await putRaw(
        `${baseServerUrl}space/${spaceId}/${collectionId}/doc`,
        '{"v":1}'
      )

      // The source: a mutable Collection of the same id holding a different
      // `doc` and a new `other`.
      const sourceSpaceId = `revisions-source-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: sourceSpaceId,
        name: 'Revisions Source',
        controller: alice.did
      })
      await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/`,
        method: 'POST',
        json: { id: collectionId }
      })
      await putRaw(
        `${baseServerUrl}space/${sourceSpaceId}/${collectionId}/doc`,
        '{"v":2}'
      )
      await putRaw(
        `${baseServerUrl}space/${sourceSpaceId}/${collectionId}/other`,
        '{"v":3}'
      )
      const exported = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const tarBytes = new Uint8Array(await exported.arrayBuffer())

      const imported = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.resourcesSkipped, 1)
      assert.equal(imported.data.resourcesCreated, 1)

      const kept = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/doc`,
        method: 'GET'
      })
      assert.deepEqual(kept.data, { v: 1 })
      const added = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/other`,
        method: 'GET'
      })
      assert.deepEqual(added.data, { v: 3 })
      assert.deepEqual((await readMeta(collectionId)).revisions, {
        immutable: true
      })
    })
  })
})
