/**
 * Storage tests (Vitest).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { fileNameFor } from '@interop/space-archive'
import { resourceMetaEtag } from '../src/lib/etag.js'
import { compareStamps, withoutStampMembers } from '../src/lib/hlc.js'
import { PreconditionFailedError } from '../src/errors.js'
import { importArchive, resourceDocuments } from './helpers.js'
import { extractTarEntries } from '../src/lib/importTar.js'

/**
 * Consumes a readable stream into a single string (test helper).
 * @param stream {Readable}
 * @returns {Promise<string>}
 */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * True when the first write stamp is strictly later than the second.
 * @param later {{ updatedAt?: string, updatedAtCounter?: number }}
 * @param earlier {{ updatedAt?: string, updatedAtCounter?: number }}
 * @returns {boolean}
 */
function isLaterStamp(
  later: { updatedAt?: string; updatedAtCounter?: number },
  earlier: { updatedAt?: string; updatedAtCounter?: number }
): boolean {
  return (
    isLaterOrEqualStamp(later, earlier) &&
    !(
      later.updatedAt === earlier.updatedAt &&
      later.updatedAtCounter === earlier.updatedAtCounter
    )
  )
}

/**
 * True when the first write stamp is the same as or later than the second: a
 * later `updatedAt`, or the same one with a counter at least as high.
 * @param later {{ updatedAt?: string, updatedAtCounter?: number }}
 * @param earlier {{ updatedAt?: string, updatedAtCounter?: number }}
 * @returns {boolean}
 */
function isLaterOrEqualStamp(
  later: { updatedAt?: string; updatedAtCounter?: number },
  earlier: { updatedAt?: string; updatedAtCounter?: number }
): boolean {
  const laterMs = Date.parse(later.updatedAt!)
  const earlierMs = Date.parse(earlier.updatedAt!)
  return (
    laterMs > earlierMs ||
    (laterMs === earlierMs &&
      (later.updatedAtCounter ?? 0) >= (earlier.updatedAtCounter ?? 0))
  )
}

describe('Storage API', () => {
  describe('fileNameFor()', () => {
    it('should map a content type to filename', () => {
      const filename = fileNameFor({
        resourceId: '12345',
        contentType: 'application/json'
      })
      assert.equal(filename, 'r.12345.application%2Fjson.json')
    })
  })

  describe('FileSystemBackend.exportSpace()', () => {
    it('should export space tarball with manifest and serialized files', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-export-test-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'credentials'
      const resourceId = 'credential-1'

      try {
        await backend.writeSpace({
          spaceId,
          spaceMetadata: {
            id: spaceId,
            type: ['Space'],
            name: 'Export Test Space',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'Verifiable Credentials'
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: {
              id: resourceId,
              type: ['VerifiableCredential']
            }
          }
        })

        const pack = await backend.exportSpace({ spaceId })
        const entries: Array<{ name: string; body: Buffer }> = []
        const extract = tar.extract()

        await new Promise<void>((resolve, reject) => {
          extract.on('entry', (header, stream, next) => {
            const chunks: Buffer[] = []
            stream.on('data', chunk =>
              chunks.push(Buffer.from(chunk as Uint8Array))
            )
            stream.on('end', () => {
              entries.push({
                name: header.name,
                body: Buffer.concat(chunks)
              })
              next()
            })
            stream.on('error', reject)
          })
          extract.on('finish', resolve)
          extract.on('error', reject)
          pack.on('error', reject)
          pack.pipe(extract)
        })

        const resourceFilename = fileNameFor({
          resourceId,
          contentType: 'application/json'
        })
        const entryNames = entries.map(entry => entry.name)

        assert.ok(entryNames.includes('manifest.yml'))
        assert.ok(entryNames.includes('space/'))
        assert.ok(entryNames.includes(`space/${spaceId}/`))
        assert.ok(
          entryNames.includes(`space/${spaceId}/.space.meta.${spaceId}.json`)
        )
        assert.ok(entryNames.includes(`space/${spaceId}/${collectionId}/`))
        assert.ok(
          entryNames.includes(
            `space/${spaceId}/${collectionId}/.collection.meta.${collectionId}.json`
          )
        )
        assert.ok(
          entryNames.includes(
            `space/${spaceId}/${collectionId}/${resourceFilename}`
          )
        )

        const manifestEntry = entries.find(
          entry => entry.name === 'manifest.yml'
        )
        assert.ok(manifestEntry)
        const manifest = YAML.parse(manifestEntry.body.toString('utf8'))

        assert.equal(manifest['ubc-version'], '0.1')
        assert.equal(
          manifest.contents['manifest.yml'].url,
          'https://w3id.org/pws#archive-manifest'
        )
        assert.equal(manifest.contents.space.url, 'https://w3id.org/pws#spaces')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('is byte-reproducible: entries carry a fixed mtime, not wall-clock', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-export-repro-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const spaceId = 'repro-space'

      try {
        await backend.writeSpace({
          spaceId,
          spaceMetadata: {
            id: spaceId,
            type: ['Space'],
            name: 'Repro Test Space',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId,
          collectionId: 'credentials',
          collectionMetadata: { id: 'credentials', type: ['Collection'] }
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'credentials',
          resourceId: 'vc-1',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { id: 'vc-1' }
          }
        })

        async function exportBytes(): Promise<Buffer> {
          const pack = await backend.exportSpace({ spaceId })
          const chunks: Buffer[] = []
          for await (const chunk of pack) {
            chunks.push(Buffer.from(chunk))
          }
          return Buffer.concat(chunks)
        }

        // Every entry header carries the fixed epoch mtime (tar-stream would
        // otherwise stamp wall-clock time, making exports that straddle a
        // one-second boundary differ).
        const first = await exportBytes()
        const mtimes: Array<{ name: string; mtime: Date | undefined }> = []
        const extract = tar.extract()
        await new Promise<void>((resolve, reject) => {
          extract.on('entry', (header, stream, next) => {
            mtimes.push({ name: header.name, mtime: header.mtime })
            stream.resume()
            stream.on('end', next)
            stream.on('error', reject)
          })
          extract.on('finish', resolve)
          extract.on('error', reject)
          Readable.from(first).pipe(extract)
        })
        assert.ok(mtimes.length > 0)
        for (const { name, mtime } of mtimes) {
          assert.equal(mtime?.getTime(), 0, `entry ${name} mtime not epoch`)
        }

        // And two exports of the unchanged Space agree byte-for-byte, even
        // across a one-second boundary.
        await new Promise(resolve => setTimeout(resolve, 1100))
        const second = await exportBytes()
        assert.ok(first.equals(second))
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend export/import round-trips policies', () => {
    it('restores space, collection, and resource policies', async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'was-policy-roundtrip-')
      )
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const src = 'source-space'
      const dst = 'target-space'
      const collectionId = 'credentials'
      const resourceId = 'vc-1'

      try {
        // Populate the source space with a policy at every level.
        await backend.writeSpace({
          spaceId: src,
          spaceMetadata: {
            id: src,
            type: ['Space'],
            name: 'Source',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId: src,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'Verifiable Credentials'
          }
        })
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { id: resourceId }
          }
        })
        await backend.writePolicy({
          spaceId: src,
          policy: { type: 'SpaceLevelPolicy' }
        })
        await backend.writePolicy({
          spaceId: src,
          collectionId,
          policy: { type: 'PublicCanRead' }
        })
        await backend.writePolicy({
          spaceId: src,
          collectionId,
          resourceId,
          policy: { type: 'ResourceLevelPolicy' }
        })

        // Export the source, then import the archive into a fresh target space.
        const pack = await backend.exportSpace({ spaceId: src })
        await backend.writeSpace({
          spaceId: dst,
          spaceMetadata: {
            id: dst,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        const stats = await importArchive({
          backend: backend,
          spaceId: dst,
          tarStream: pack
        })

        assert.equal(stats.policiesCreated, 3)
        assert.equal(stats.policiesSkipped, 0)
        // Each is restored with a stamp minted by the importing store.
        assert.deepEqual(
          withoutStampMembers((await backend.getPolicy({ spaceId: dst }))!),
          { type: 'SpaceLevelPolicy' }
        )
        assert.deepEqual(
          withoutStampMembers(
            (await backend.getPolicy({ spaceId: dst, collectionId }))!
          ),
          { type: 'PublicCanRead' }
        )
        assert.deepEqual(
          withoutStampMembers(
            (await backend.getPolicy({
              spaceId: dst,
              collectionId,
              resourceId
            }))!
          ),
          { type: 'ResourceLevelPolicy' }
        )
        assert.equal(
          (await backend.getPolicy({ spaceId: dst }))?.originId,
          backend.originId
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('restores resource metadata sidecars (custom + timestamps)', async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'was-meta-roundtrip-')
      )
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const src = 'source-space'
      const dst = 'target-space'
      const collectionId = 'credentials'
      const resourceId = 'vc-1'

      try {
        await backend.writeSpace({
          spaceId: src,
          spaceMetadata: {
            id: src,
            type: ['Space'],
            name: 'Source',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId: src,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'Verifiable Credentials'
          }
        })
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { id: resourceId }
          }
        })
        await backend.writeResourceMetadata({
          spaceId: src,
          collectionId,
          resourceId,
          custom: { name: 'Credential One', tags: { status: 'final' } }
        })
        const before = await backend.getResourceMetadata({
          spaceId: src,
          collectionId,
          resourceId
        })

        const pack = await backend.exportSpace({ spaceId: src })
        await backend.writeSpace({
          spaceId: dst,
          spaceMetadata: {
            id: dst,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        await importArchive({ backend: backend, spaceId: dst, tarStream: pack })

        const after = await backend.getResourceMetadata({
          spaceId: dst,
          collectionId,
          resourceId
        })
        assert.deepEqual(after!.custom, {
          name: 'Credential One',
          tags: { status: 'final' }
        })
        // `createdAt` survives the roundtrip; the write stamps are re-minted
        // by the importing backend's clock, so they never fall behind.
        assert.equal(after!.createdAt, before!.createdAt)
        assert.ok(isLaterOrEqualStamp(after!, before!))
        assert.ok(after!.meta, 'the imported /meta record carries a stamp')
        assert.equal(after!.originId, backend.originId)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('carries tombstones across an export/import roundtrip', async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'was-tombstone-roundtrip-')
      )
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const src = 'source-space'
      const dst = 'target-space'
      const collectionId = 'notes'

      try {
        await backend.writeSpace({
          spaceId: src,
          spaceMetadata: {
            id: src,
            type: ['Space'],
            name: 'Source',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId: src,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'Notes'
          }
        })
        // A live resource and a soft-deleted one (a tombstone), in the same
        // Collection.
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId: 'live',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId: 'gone',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        await backend.deleteResource({
          spaceId: src,
          collectionId,
          resourceId: 'gone'
        })
        const srcTombstone = await backend.readMetaSidecar({
          collectionDir: path.join(tempDir, 'spaces', src, collectionId),
          resourceId: 'gone'
        })

        const pack = await backend.exportSpace({ spaceId: src })
        await backend.writeSpace({
          spaceId: dst,
          spaceMetadata: {
            id: dst,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        await importArchive({ backend: backend, spaceId: dst, tarStream: pack })

        // The tombstone survives: no content file, a `deleted` sidecar carried
        // verbatim, and it stays invisible to normal reads on the target. Two
        // members do not travel: the feed position, since the target
        // Collection assigns its own (the Collection's create took 1, the live
        // Resource 2, the tombstone 3), whatever the source's was; and the
        // digest of the deleted content, which export strips and an imported
        // tombstone, having no bytes, cannot recompute.
        const dstCollectionDir = path.join(tempDir, 'spaces', dst, collectionId)
        const dstTombstone = await backend.readMetaSidecar({
          collectionDir: dstCollectionDir,
          resourceId: 'gone'
        })
        const {
          feedPosition: srcFeedPosition,
          updatedAt: srcUpdatedAt,
          updatedAtCounter: srcCounter,
          digest: srcDigest,
          ...srcRest
        } = srcTombstone!
        const {
          feedPosition: dstFeedPosition,
          updatedAt: dstUpdatedAt,
          updatedAtCounter: dstCounter,
          ...dstRest
        } = dstTombstone!
        assert.equal(typeof srcDigest, 'string')
        assert.equal(dstTombstone!.digest, undefined)
        assert.deepEqual(dstRest, srcRest, 'tombstone sidecar carried verbatim')
        // The write stamp is re-minted by the importing backend's clock.
        assert.ok(
          isLaterOrEqualStamp(
            { updatedAt: dstUpdatedAt, updatedAtCounter: dstCounter },
            { updatedAt: srcUpdatedAt, updatedAtCounter: srcCounter }
          )
        )
        assert.equal(srcFeedPosition, 4)
        assert.equal(dstFeedPosition, 3)
        const dstFiles = (await readdir(dstCollectionDir)).filter(name =>
          name.startsWith('r.gone.')
        )
        assert.deepEqual(
          dstFiles,
          [],
          'no content file for the carried tombstone'
        )

        const listing = await backend.listCollectionItems({
          spaceId: dst,
          collectionId
        })
        assert.deepEqual(
          listing.items.map(item => item.id),
          ['live'],
          'listing shows the live resource but not the tombstone'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend resourceId prefix collisions', () => {
    it('does not match a resourceId that is a prefix of another', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-prefix-test-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'notes'

      try {
        await backend.writeSpace({
          spaceId,
          spaceMetadata: {
            id: spaceId,
            type: ['Space'],
            name: 'Prefix Test Space',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'Notes'
          }
        })
        // `note` is a prefix of `notebook`; the loose `r.note*` glob would have
        // matched both.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'note',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { which: 'note' }
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'notebook',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { which: 'notebook' }
          }
        })

        // getResource resolves the exact id, not the prefix-sharing sibling.
        const noteResult = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        assert.deepEqual(
          JSON.parse(await streamToString(noteResult.resourceStream)),
          {
            which: 'note'
          }
        )

        // deleteResource removes only the exact id, leaving the sibling intact.
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })

        const remaining = (
          await readdir(path.join(tempDir, 'spaces', spaceId, collectionId))
        ).filter(name => name.startsWith('r.'))
        assert.deepEqual(remaining, ['r.notebook.application%2Fjson.json'])

        const notebookResult = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'notebook'
        })
        assert.deepEqual(
          JSON.parse(await streamToString(notebookResult.resourceStream)),
          { which: 'notebook' }
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend tombstone soft-delete', () => {
    /**
     * Provisions a Space + Collection holding one JSON Resource, and returns the
     * backend, the temp dir, and the Collection dir path.
     */
    async function provisionResource() {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-tombstone-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'notes'
      await backend.writeSpace({
        spaceId,
        spaceMetadata: {
          id: spaceId,
          type: ['Space'],
          name: 'Tombstone Test Space',
          controller: 'did:key:test-controller'
        }
      })
      await backend.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata: {
          id: collectionId,
          type: ['Collection'],
          name: 'Notes'
        }
      })
      await backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'note',
        input: { kind: 'json', contentType: 'application/json', data: { v: 1 } }
      })
      const collectionDir = path.join(tempDir, 'spaces', spaceId, collectionId)
      return { backend, tempDir, spaceId, collectionId, collectionDir }
    }

    it('drops the content file and leaves a tombstone in place of the sidecar', async () => {
      const { backend, tempDir, spaceId, collectionId, collectionDir } =
        await provisionResource()
      try {
        const live = await backend.readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })

        // No content representation remains, and the live sidecar gave way
        // to the tombstone, under its own name.
        const entries = await readdir(collectionDir)
        assert.deepEqual(
          entries.filter(name => name.startsWith('r.')),
          [],
          'content file should be gone'
        )
        assert.ok(
          entries.includes('.tombstone.note.json'),
          'the tombstone should stand under its own name'
        )
        assert.ok(
          !entries.includes('.meta.note.json'),
          'the live sidecar should be gone'
        )

        // The tombstone records `deleted`, a later write stamp under the kept
        // `generation`, and the last-known content-type (the content filename
        // no longer carries it).
        const sidecar = await backend.readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        assert.equal(sidecar?.deleted, true)
        assert.ok(
          isLaterStamp(sidecar!, live!),
          'the delete mints a later content stamp'
        )
        assert.equal(sidecar?.generation, live?.generation)
        assert.equal(sidecar?.contentType, 'application/json')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('is invisible to getResource / getResourceMetadata after deletion', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionResource()
      try {
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })

        await assert.rejects(
          backend.getResource({ spaceId, collectionId, resourceId: 'note' }),
          'getResource 404s on a tombstone'
        )
        const meta = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        assert.equal(meta, undefined, 'getResourceMetadata 404s on a tombstone')

        const listing = await backend.listCollectionItems({
          spaceId,
          collectionId
        })
        assert.deepEqual(listing.items, [], 'listing skips the tombstone')
        assert.equal(listing.totalItems, 0)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('mints a later stamp under the kept generation when a tombstoned id is re-created', async () => {
      const { backend, tempDir, spaceId, collectionId, collectionDir } =
        await provisionResource()
      try {
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        const tombstone = await backend.readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        const { validator: revived } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'note',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 2 }
          }
        })
        assert.equal(
          revived.generation,
          tombstone?.generation,
          'a re-create keeps the generation'
        )
        assert.ok(
          compareStamps(tombstone!, revived.stamp) < 0,
          're-create mints a stamp above the tombstone'
        )

        // The revived Resource is readable and no longer a tombstone.
        const result = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        assert.deepEqual(
          JSON.parse(await streamToString(result.resourceStream)),
          {
            v: 2
          }
        )
        const sidecar = await backend.readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        assert.equal(
          sidecar?.deleted,
          undefined,
          'tombstone flag cleared on revive'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('is idempotent: re-deleting a tombstone does not churn its stamp', async () => {
      const { backend, tempDir, spaceId, collectionId, collectionDir } =
        await provisionResource()
      try {
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        const first = await backend.readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        const second = await backend.readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        assert.equal(second?.updatedAt, first?.updatedAt, 'updatedAt unchanged')
        assert.equal(
          second?.updatedAtCounter,
          first?.updatedAtCounter,
          'stamp counter unchanged'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend.changesSince()', () => {
    /**
     * Provisions an empty Space + Collection and returns the backend, temp dir,
     * and ids. Each test writes its own Resources.
     */
    async function provisionCollection() {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-changes-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'notes'
      await backend.writeSpace({
        spaceId,
        spaceMetadata: {
          id: spaceId,
          type: ['Space'],
          name: 'Changes Test Space',
          controller: 'did:key:test-controller'
        }
      })
      await backend.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata: {
          id: collectionId,
          type: ['Collection'],
          name: 'Notes'
        }
      })
      return { backend, tempDir, spaceId, collectionId }
    }

    it('returns the Collection create, then JSON documents with data + write stamp, in write order, plus a checkpoint', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        for (const id of ['b', 'a', 'c']) {
          await backend.writeResource({
            spaceId,
            collectionId,
            resourceId: id,
            input: {
              kind: 'json',
              contentType: 'application/json',
              data: { id }
            }
          })
        }
        const page = await backend.changesSince({
          spaceId,
          collectionId,
          limit: 10
        })
        const { checkpoint } = page
        // The Collection's create took the first position.
        assert.equal(page.documents[0]!.kind, 'collection-metadata')
        assert.equal(page.documents[0]!.feedPosition, 1)
        const documents = resourceDocuments(page.documents)
        // Ordered by feed position, which is write order, not by id.
        assert.deepEqual(
          documents.map(doc => doc.resourceId),
          ['b', 'a', 'c']
        )
        assert.deepEqual(
          documents.map(doc => doc.feedPosition),
          [2, 3, 4]
        )
        for (const doc of documents) {
          assert.equal(doc.deleted, false)
          assert.equal(typeof doc.updatedAtCounter, 'number')
          assert.equal(doc.originId, backend.originId)
          assert.deepEqual(doc.data, { id: doc.resourceId })
        }
        assert.equal(checkpoint, 4, "the last document's feed position")
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('iterates by checkpoint: each page is newer, ending empty with a null checkpoint', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        for (const id of ['a', 'b', 'c', 'd', 'e']) {
          await backend.writeResource({
            spaceId,
            collectionId,
            resourceId: id,
            input: {
              kind: 'json',
              contentType: 'application/json',
              data: { id }
            }
          })
        }
        const seen: string[] = []
        let afterPosition: number | undefined
        // Pull two at a time until a page comes back short (catch-up complete).
        for (let guard = 0; guard < 10; guard++) {
          const page = await backend.changesSince({
            spaceId,
            collectionId,
            afterPosition,
            limit: 2
          })
          seen.push(
            ...resourceDocuments(page.documents).map(doc => doc.resourceId)
          )
          if (page.documents.length < 2) {
            // Final short page: the next pull is empty with a null checkpoint.
            const tail = await backend.changesSince({
              spaceId,
              collectionId,
              // An empty page leaves the reader where it was.
              afterPosition: page.checkpoint ?? afterPosition,
              limit: 2
            })
            assert.deepEqual(tail.documents, [])
            assert.equal(tail.checkpoint, null)
            break
          }
          afterPosition = page.checkpoint ?? undefined
        }
        assert.deepEqual(
          seen.sort(),
          ['a', 'b', 'c', 'd', 'e'],
          'every change seen once'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('surfaces tombstones with deleted:true and no data', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'live',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'gone',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'gone'
        })

        const { documents } = await backend.changesSince({
          spaceId,
          collectionId,
          limit: 10
        })
        const byId = new Map(
          resourceDocuments(documents).map(doc => [doc.resourceId, doc])
        )
        assert.equal(byId.get('live')!.deleted, false)
        assert.deepEqual(byId.get('live')!.data, { v: 1 })
        const tombstone = byId.get('gone')!
        assert.equal(tombstone.deleted, true)
        assert.equal(tombstone.data, undefined, 'tombstone carries no data')
        assert.ok(
          isLaterStamp(tombstone, byId.get('live')!),
          'the delete minted a later content stamp'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('carries binary (non-JSON) Resources with their contentType and no data', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'pic',
          input: {
            kind: 'binary',
            contentType: 'image/png',
            stream: Readable.from(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
          }
        })
        const { documents } = await backend.changesSince({
          spaceId,
          collectionId,
          limit: 10
        })
        const resources = resourceDocuments(documents)
        assert.deepEqual(
          resources.map(doc => [doc.resourceId, doc.contentType]),
          [
            ['doc', 'application/json'],
            ['pic', 'image/png']
          ]
        )
        assert.deepEqual(resources[0]!.data, { v: 1 })
        assert.equal(resources[1]!.data, undefined)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('replicates a metadata-only edit: new meta stamp + custom, unchanged content stamp/data', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        // A metadata-only edit: the content stamp stays, the `meta` stamp is
        // new, and the edit re-surfaces the resource in the feed carrying
        // `custom` with `data` unchanged.
        const contentBefore = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc'
        })
        const written = (
          await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc',
            custom: { name: 'labeled', tags: { s: 'draft' } }
          })
        )?.validator
        assert.ok(written, 'the metadata write returns a validator')

        const meta = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc'
        })
        assert.equal(
          meta!.updatedAt,
          contentBefore!.updatedAt,
          'content stamp preserved by a meta write'
        )
        assert.equal(meta!.updatedAtCounter, contentBefore!.updatedAtCounter)
        assert.equal(meta!.meta?.generation, written!.generation)
        assert.equal(
          meta!.meta?.updatedAtCounter,
          written!.stamp.updatedAtCounter
        )

        const { documents } = await backend.changesSince({
          spaceId,
          collectionId,
          limit: 10
        })
        const doc = resourceDocuments(documents).find(
          entry => entry.resourceId === 'doc'
        )!
        assert.equal(doc.updatedAt, contentBefore!.updatedAt)
        assert.equal(doc.updatedAtCounter, contentBefore!.updatedAtCounter)
        assert.equal(doc.meta?.generation, written!.generation)
        assert.deepEqual(doc.data, { v: 1 })
        assert.deepEqual(doc.custom, { name: 'labeled', tags: { s: 'draft' } })
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('a content write preserves an existing meta stamp', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        await backend.writeResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc',
          custom: { name: 'first' }
        })
        const metaBefore = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc'
        })
        // A second content write moves the content stamp but must not disturb
        // the `meta` stamp.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 2 }
          }
        })
        const meta = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc'
        })
        assert.ok(isLaterStamp(meta!, metaBefore!), 'content stamp advanced')
        assert.deepEqual(
          meta!.meta,
          metaBefore!.meta,
          'meta stamp preserved by a content write'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('honors an If-Match / If-None-Match precondition on the meta validator', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        // If-None-Match: * succeeds on the first metadata write (none exists yet).
        const firstWrite = await backend.writeResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc',
          custom: { name: 'first' },
          ifNoneMatch: '*'
        })
        assert.ok(firstWrite, 'the first metadata write returns a validator')
        // The `/meta` ETag is the composite of the content and `/meta`
        // validators.
        const first = resourceMetaEtag({
          content: firstWrite.contentValidator,
          meta: firstWrite.validator
        })
        // A second If-None-Match: * now fails (metadata already exists).
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc',
            custom: { name: 'again' },
            ifNoneMatch: '*'
          }),
          PreconditionFailedError
        )
        // If-Match on the current metadata ETag succeeds; a stale one fails.
        await backend.writeResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'doc',
          custom: { name: 'second' },
          ifMatch: first
        })
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc',
            custom: { name: 'third' },
            ifMatch: first
          }),
          PreconditionFailedError
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('omits `name` from an encrypted-Collection listing, keeps it for plaintext', async () => {
      const { backend, tempDir, spaceId } = await provisionCollection()
      try {
        // A plaintext Collection surfaces `custom.name`; an encrypted one omits it
        // (its `custom` is an opaque envelope the server cannot project).
        await backend.writeCollection({
          spaceId,
          collectionId: 'enc',
          collectionMetadata: {
            id: 'enc',
            type: ['Collection'],
            name: 'Encrypted',
            encryption: { scheme: 'edv' }
          }
        })
        for (const collectionId of ['notes', 'enc']) {
          await backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'doc',
            input: {
              kind: 'json',
              contentType: 'application/json',
              data: { v: 1 }
            }
          })
          await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc',
            // On the encrypted Collection this stands in for the opaque envelope
            // (an object with no `name` the server could project anyway).
            custom:
              collectionId === 'enc'
                ? { jwe: { protected: 'p', ciphertext: 'c' } }
                : { name: 'Visible Name' }
          })
        }
        const plain = await backend.listCollectionItems({
          spaceId,
          collectionId: 'notes'
        })
        const enc = await backend.listCollectionItems({
          spaceId,
          collectionId: 'enc'
        })
        assert.equal(plain.items[0]!.name, 'Visible Name')
        assert.equal(
          enc.items[0]!.name,
          undefined,
          'no name on encrypted listing'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('keeps the Collection-level positions in the feed counter, which Delete Collection removes', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n',
          ifNoneMatch: '*'
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 1 }
          }
        })
        const collectionDir = path.join(
          tempDir,
          'spaces',
          spaceId,
          collectionId
        )
        const counterPath = path.join(
          collectionDir,
          `.feed.${collectionId}.json`
        )
        const counter = JSON.parse(await readFile(counterPath, 'utf8'))
        assert.equal(counter.position, 3)
        assert.deepEqual(counter.records, { 'collection-metadata': 1, log: 2 })
        assert.equal(typeof counter.generation, 'string')
        // Neither stored record carries a position of its own.
        for (const fileName of [
          `.collection.meta.${collectionId}.json`,
          `.collectionlog.${collectionId}.json`
        ]) {
          const stored = await readFile(
            path.join(collectionDir, fileName),
            'utf8'
          )
          assert.ok(!stored.includes('Position'), `${fileName} has a position`)
        }

        await backend.deleteCollection({ spaceId, collectionId })
        assert.ok(
          !(await readdir(collectionDir)).includes(
            `.feed.${collectionId}.json`
          ),
          'the counter goes with the Collection'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('exports no feed position of any kind, and an import writes a fresh counter', async () => {
      const { backend, tempDir, spaceId, collectionId } =
        await provisionCollection()
      try {
        await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n',
          ifNoneMatch: '*'
        })
        // The envelope the governed Collection's `edv` scheme asks of every
        // write; the import checks the archived Resources against the log head.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'pic',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: {
              id: 'urn:uuid:pic',
              sequence: 0,
              jwe: {
                protected: 'eyJlbmMiOiJYQzIwUCJ9',
                iv: 'aXY',
                ciphertext: 'Y2lwaGVydGV4dA',
                tag: 'dGFn'
              }
            }
          }
        })
        const entries = await extractTarEntries(
          await backend.exportSpace({ spaceId })
        )
        const names = [...entries.keys()]
        const bodies = [...entries.values()].flatMap(entry =>
          entry.body === undefined ? [] : [entry.body.toString('utf8')]
        )
        assert.ok(
          !names.some(name => path.basename(name).startsWith('.feed.')),
          'no feed counter travels'
        )
        for (const body of bodies) {
          assert.ok(!body.includes('feedPosition'))
          assert.ok(!body.includes('FeedPosition'))
          assert.ok(!body.includes('"records"'))
        }

        // Import into a fresh Space: the Collection, its log and its
        // Resource take positions 1 to 3 in the destination's counter.
        const targetSpaceId = 'target-space'
        await backend.writeSpace({
          spaceId: targetSpaceId,
          spaceMetadata: {
            id: targetSpaceId,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        await importArchive({
          backend,
          spaceId: targetSpaceId,
          tarStream: await backend.exportSpace({ spaceId })
        })
        const counter = JSON.parse(
          await readFile(
            path.join(
              tempDir,
              'spaces',
              targetSpaceId,
              collectionId,
              `.feed.${collectionId}.json`
            ),
            'utf8'
          )
        )
        assert.deepEqual(counter.records, { 'collection-metadata': 1, log: 2 })
        assert.equal(counter.position, 3)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend.reportUsage()', () => {
    /**
     * Provisions a Space with one Collection holding one JSON Resource, on a
     * backend with the given (optional) configured capacity.
     */
    async function provision(capacityBytes?: number) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-usage-test-'))
      await mkdir(path.join(tempDir, 'spaces'))
      // Provision unlimited so the writes below are never blocked by quota
      // enforcement, then apply the capacity afterward -- these tests exercise
      // reportUsage()'s state derivation, not the write-path enforcement.
      const backend = await FileSystemBackend.open({ dataDir: tempDir })
      const spaceId = 'usage-space'
      const collectionId = 'credentials'
      await backend.writeSpace({
        spaceId,
        spaceMetadata: {
          id: spaceId,
          type: ['Space'],
          name: 'Usage Test Space',
          controller: 'did:key:test-controller'
        }
      })
      await backend.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata: {
          id: collectionId,
          type: ['Collection'],
          name: 'Credentials'
        }
      })
      await backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'vc-1',
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: { id: 'vc-1', name: 'A Verifiable Credential' }
        }
      })
      backend.capacityBytes = capacityBytes
      return { backend, spaceId, collectionId, tempDir }
    }

    it('reports non-zero usage and an unlimited limit by default', async () => {
      const { backend, spaceId, collectionId, tempDir } = await provision()
      try {
        const usage = await backend.reportUsage({ spaceId })
        assert.equal(usage.id, 'fs')
        assert.equal(usage.managedBy, 'server')
        assert.equal(usage.state, 'ok')
        assert.ok(usage.usageBytes > 0)
        assert.deepStrictEqual(usage.limit, { isUnlimited: true })
        assert.deepStrictEqual(usage.restrictedActions, [])
        // The per-Collection breakdown is opt-in (spec `?include=collections`),
        // so it is omitted by default and included only when requested.
        assert.equal(usage.usageByCollection, undefined)
        const detailed = await backend.reportUsage({
          spaceId,
          includeCollections: true
        })
        assert.ok(detailed.usageByCollection)
        assert.deepStrictEqual(
          detailed.usageByCollection!.map(collection => collection.id),
          [collectionId]
        )
        assert.ok(detailed.usageByCollection![0]!.usageBytes > 0)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('reports near-limit / over-quota states against a configured capacity', async () => {
      // Measure actual usage first, then size a capacity to land in each band.
      const probe = await provision()
      const usageBytes = (
        await probe.backend.reportUsage({
          spaceId: probe.spaceId
        })
      ).usageBytes
      await rm(probe.tempDir, { recursive: true, force: true })

      // near-limit: usage is at/above 90% but below capacity.
      const near = await provision(Math.ceil(usageBytes / 0.95))
      try {
        const usage = await near.backend.reportUsage({ spaceId: near.spaceId })
        assert.equal(usage.state, 'near-limit')
        assert.equal(usage.limit.isUnlimited, false)
        assert.deepStrictEqual(usage.restrictedActions, [])
      } finally {
        await rm(near.tempDir, { recursive: true, force: true })
      }

      // over-quota: usage meets/exceeds capacity; writes become restricted.
      const over = await provision(Math.floor(usageBytes / 2))
      try {
        const usage = await over.backend.reportUsage({ spaceId: over.spaceId })
        assert.equal(usage.state, 'over-quota')
        assert.deepStrictEqual(usage.restrictedActions, ['POST', 'PUT'])
      } finally {
        await rm(over.tempDir, { recursive: true, force: true })
      }
    })
  })
})
