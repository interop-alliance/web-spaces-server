/**
 * Tests for the content digest the filesystem backend records on each
 * Resource and chunk sidecar: the `Digest` header's `mh=` form over the
 * stored representation, a JSON body as re-serialized and not as sent, a
 * binary body as sent. A soft delete keeps the deleted content's digest on
 * the tombstone. Export strips the member from the archived sidecars, and
 * import ignores an archived one and records the digest of the file it
 * writes.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import * as tar from 'tar-stream'
import { createHeaderValue } from '@interop/http-digest-header'
import { chunkDirName, metaSidecarFileName } from '@interop/space-archive'
import { extractTarEntries } from '../src/lib/importTar.js'
import { tombstoneSidecarFileName } from '../src/lib/metaSidecar.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('content digest API', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  let backend: TempFileSystemBackend
  const spaceId = `digest-space-${crypto.randomUUID()}`
  const collectionId = 'docs'

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
    await alice.pws.createSpace({
      id: spaceId,
      name: 'Digest Space',
      controller: alice.did
    })
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId }
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  const collectionDir = () =>
    path.join(backend.spacesDir, spaceId, collectionId)
  const resourceUrl = (resourceId: string) =>
    `${baseServerUrl}space/${spaceId}/${collectionId}/${resourceId}`

  /**
   * PUTs raw bytes under the Collection.
   * @param resourceId {string}
   * @param body {string | Uint8Array}
   * @param contentType {string}
   * @returns {Promise<any>}
   */
  function putRaw(
    resourceId: string,
    body: string | Uint8Array,
    contentType: string
  ): Promise<any> {
    return alice.pws.request({
      url: resourceUrl(resourceId),
      method: 'PUT',
      body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
      headers: { 'content-type': contentType }
    })
  }

  /**
   * Reads a sidecar file in the Collection dir as JSON.
   * @param fileName {string}
   * @returns {Promise<any>}
   */
  async function sidecar(fileName: string): Promise<any> {
    return JSON.parse(
      await readFile(path.join(collectionDir(), fileName), 'utf8')
    )
  }

  it('digests a JSON body as stored, after re-serialization, and not as sent', async () => {
    const sent = '{ "b" : [1, 2],\n  "a" : "x" }'
    await putRaw('doc', sent, 'application/json')
    const { digest } = await sidecar(metaSidecarFileName('doc'))
    assert.equal(
      digest,
      await createHeaderValue({ data: Buffer.from('{"b":[1,2],"a":"x"}') })
    )
    assert.notEqual(
      digest,
      await createHeaderValue({ data: Buffer.from(sent) })
    )
  })

  it('digests a binary body as sent, and a chunk records its own', async () => {
    const bytes = crypto.randomBytes(1024)
    await putRaw('blob', bytes, 'application/octet-stream')
    const { digest } = await sidecar(metaSidecarFileName('blob'))
    assert.equal(digest, await createHeaderValue({ data: bytes }))

    const chunkBytes = crypto.randomBytes(512)
    await alice.pws.request({
      url: `${resourceUrl('blob')}/chunks/0`,
      method: 'PUT',
      body: chunkBytes,
      headers: { 'content-type': 'application/octet-stream' }
    })
    const chunk = await sidecar(
      path.join(chunkDirName('blob'), metaSidecarFileName('0'))
    )
    assert.equal(chunk.digest, await createHeaderValue({ data: chunkBytes }))
    // The parent's digest is its own bytes', untouched by the chunk write.
    assert.equal((await sidecar(metaSidecarFileName('blob'))).digest, digest)
  })

  it("a soft delete keeps the deleted content's digest on the tombstone", async () => {
    await putRaw('gone', '{"v":1}', 'application/json')
    const { digest } = await sidecar(metaSidecarFileName('gone'))
    await alice.pws.request({ url: resourceUrl('gone'), method: 'DELETE' })
    const tombstone = await sidecar(tombstoneSidecarFileName('gone'))
    assert.equal(tombstone.deleted, true)
    assert.equal(tombstone.digest, digest)
  })

  it('export strips the digest, and import records the digest of the file it writes', async () => {
    const exported = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/export`,
      method: 'POST'
    })
    const entries = await extractTarEntries(
      Readable.from(Buffer.from(await exported.arrayBuffer()))
    )
    const docSidecarPath = `space/${spaceId}/${collectionId}/${metaSidecarFileName('doc')}`
    const chunkSidecarPath = `space/${spaceId}/${collectionId}/${chunkDirName('blob')}/${metaSidecarFileName('0')}`
    const archivedDoc = JSON.parse(
      entries.get(docSidecarPath)!.body!.toString('utf8')
    )
    assert.equal(archivedDoc.digest, undefined)
    assert.equal(
      JSON.parse(entries.get(chunkSidecarPath)!.body!.toString('utf8')).digest,
      undefined
    )

    // An archive whose sidecars claim a digest: import ignores the claim.
    const pack = tar.pack()
    for (const [name, entry] of entries) {
      if (entry.type === 'directory') {
        pack.entry({ name, type: 'directory' })
        continue
      }
      const body =
        name === docSidecarPath || name === chunkSidecarPath
          ? Buffer.from(
              JSON.stringify({
                ...JSON.parse(entry.body!.toString('utf8')),
                digest: 'mh=uEiBogus'
              })
            )
          : entry.body!
      pack.entry({ name }, body)
    }
    pack.finalize()
    const chunks: Buffer[] = []
    for await (const chunk of pack) {
      chunks.push(chunk as Buffer)
    }

    const destSpaceId = `digest-dest-${crypto.randomUUID()}`
    await alice.pws.createSpace({
      id: destSpaceId,
      name: 'Digest Destination',
      controller: alice.did
    })
    const imported = await alice.pws.request({
      url: `${baseServerUrl}space/${destSpaceId}/import`,
      method: 'POST',
      body: new Uint8Array(Buffer.concat(chunks)),
      headers: { 'content-type': 'application/x-tar' }
    })
    assert.equal(imported.status, 200)
    const destDir = path.join(backend.spacesDir, destSpaceId, collectionId)
    const importedDoc = JSON.parse(
      await readFile(path.join(destDir, metaSidecarFileName('doc')), 'utf8')
    )
    assert.equal(
      importedDoc.digest,
      await createHeaderValue({ data: Buffer.from('{"b":[1,2],"a":"x"}') })
    )
    const importedChunk = JSON.parse(
      await readFile(
        path.join(destDir, chunkDirName('blob'), metaSidecarFileName('0')),
        'utf8'
      )
    )
    assert.equal(
      importedChunk.digest,
      (await sidecar(path.join(chunkDirName('blob'), metaSidecarFileName('0'))))
        .digest
    )
    // An imported tombstone has no bytes, so it carries no digest.
    const importedTombstone = JSON.parse(
      await readFile(
        path.join(destDir, tombstoneSidecarFileName('gone')),
        'utf8'
      )
    )
    assert.equal(importedTombstone.deleted, true)
    assert.equal(importedTombstone.digest, undefined)
  })
})
