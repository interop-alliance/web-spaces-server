/**
 * The `ownedBy` option of the storage backends (Vitest): the principals of
 * the `OwnResourcesOnly` caveats a request was authorized under. A write or
 * a delete that finds a live Resource the principals do not own is refused
 * with `NotOwnResourceError` inside the critical section, before the
 * preconditions and the write-once rule, and changes nothing. A Collection
 * listing under principals holds, counts and pages only their Resources.
 * Calls the backend directly, with no HTTP. Runs against the filesystem
 * backend, and against Postgres too when `WAS_TEST_DATABASE_URL` is set.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'

import {
  NotOwnResourceError,
  PreconditionFailedError,
  ResourceImmutableError,
  ResourceNotFoundError
} from '../src/errors.js'
import { etagOf, formatEtag } from '../src/lib/etag.js'
import type {
  IDID,
  ResourceInput,
  StorageBackend,
  CollectionResourcesList
} from '../src/types.js'
import { binaryInput, openTempBackend, openTempPostgres } from './helpers.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

const CONTROLLER: IDID = 'did:key:z6MkOwnResourcesController'
const ALICE: IDID = 'did:key:z6MkOwnResourcesAlice'
const BOB: IDID = 'did:key:z6MkOwnResourcesBob'
const CAROL: IDID = 'did:key:z6MkOwnResourcesCarol'

/**
 * A stale `If-Match` value, which no stored Resource or chunk carries.
 */
const STALE_ETAG = '"stale.0.0.nobody"'

/**
 * Opens a backend for one suite, with the cleanup that closes it and
 * removes its storage.
 */
type BackendOpener = () => Promise<{
  backend: StorageBackend
  cleanup: () => Promise<void>
}>

/**
 * The filesystem backend over a private temp dir, which closing removes.
 * @returns {ReturnType<BackendOpener>}
 */
async function openFilesystem(): ReturnType<BackendOpener> {
  const backend = await openTempBackend({ prefix: 'was-own-resources-' })
  return { backend, cleanup: () => backend.close() }
}

/**
 * The Postgres backend over a throwaway schema, dropped by the cleanup.
 * @returns {ReturnType<BackendOpener>}
 */
async function openPostgres(): ReturnType<BackendOpener> {
  const { backend, dropSchema } = await openTempPostgres()
  return {
    backend,
    async cleanup() {
      await backend.close()
      await dropSchema()
    }
  }
}

/**
 * A JSON Resource body.
 * @param data {unknown}
 * @returns {ResourceInput}
 */
function jsonInput(data: unknown): ResourceInput {
  return { kind: 'json', contentType: 'application/json', data }
}

/**
 * Asserts a promise rejects with `NotOwnResourceError`.
 * @param promise {Promise<unknown>}
 * @returns {Promise<void>}
 */
async function assertNotOwn(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(
      err instanceof NotOwnResourceError,
      `expected NotOwnResourceError, got ${String(err)}`
    )
    return true
  })
}

/**
 * The `cursor` of a listing page's `next` URL.
 * @param page {CollectionResourcesList}
 * @returns {string}
 */
function cursorOf(page: CollectionResourcesList): string {
  return new URL(page.next!, 'http://x').searchParams.get('cursor')!
}

function describeOwnResources({
  name,
  openBackend
}: {
  name: string
  openBackend: BackendOpener
}): void {
  describe(`ownedBy (${name})`, () => {
    let backend: StorageBackend, cleanup: () => Promise<void>
    const spaceId = `own-resources-${crypto.randomUUID()}`

    beforeAll(async () => {
      ;({ backend, cleanup } = await openBackend())
      await backend.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller: CONTROLLER }
      })
    })

    afterAll(async () => {
      await cleanup?.()
    })

    /**
     * Creates a fresh Collection for one case.
     * @returns {Promise<string>}   its id
     */
    async function freshCollection(): Promise<string> {
      const collectionId = `c-${crypto.randomUUID()}`
      await backend.writeCollection({
        spaceId,
        collectionId,
        collectionMetadata: { id: collectionId, type: ['Collection'] }
      })
      return collectionId
    }

    /**
     * Writes a JSON Resource with the given `createdBy`, and resolves its
     * `ETag`.
     * @param options {object}
     * @param options.collectionId {string}
     * @param options.resourceId {string}
     * @param [options.createdBy] {IDID[]}
     * @returns {Promise<string>}
     */
    async function seed({
      collectionId,
      resourceId,
      createdBy
    }: {
      collectionId: string
      resourceId: string
      createdBy?: IDID[]
    }): Promise<string> {
      const { validator } = await backend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input: jsonInput({ seeded: resourceId }),
        createdBy
      })
      return formatEtag(validator)
    }

    /**
     * The stored content and `ETag` of a Resource.
     * @param options {object}
     * @param options.collectionId {string}
     * @param options.resourceId {string}
     * @returns {Promise<{ body: unknown, etag: string }>}
     */
    async function stored({
      collectionId,
      resourceId
    }: {
      collectionId: string
      resourceId: string
    }): Promise<{ body: unknown; etag: string }> {
      const result = await backend.getResource({
        spaceId,
        collectionId,
        resourceId
      })
      const chunks: Buffer[] = []
      for await (const chunk of result.resourceStream) {
        chunks.push(Buffer.from(chunk))
      }
      return {
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        etag: etagOf(result)!
      }
    }

    describe('writeResource', () => {
      it('writes over a Resource the principal owns', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [ALICE] })
        const result = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          input: jsonInput({ v: 2 }),
          ownedBy: [ALICE]
        })
        assert.equal(result.created, false)
        assert.deepEqual(result.members.createdBy, [ALICE])
        const after = await stored({ collectionId, resourceId: 'r' })
        assert.deepEqual(after.body, { v: 2 })
      })

      it('refuses a Resource the principal does not own, and writes nothing', async () => {
        const collectionId = await freshCollection()
        const etag = await seed({
          collectionId,
          resourceId: 'r',
          createdBy: [BOB]
        })
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE]
          })
        )
        const after = await stored({ collectionId, resourceId: 'r' })
        assert.deepEqual(after.body, { seeded: 'r' })
        assert.equal(after.etag, etag)
      })

      it('refuses a Resource with no createdBy', async () => {
        const collectionId = await freshCollection()
        const etag = await seed({ collectionId, resourceId: 'r' })
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE]
          })
        )
        assert.equal(
          (await stored({ collectionId, resourceId: 'r' })).etag,
          etag
        )
      })

      it('creates at an absent id', async () => {
        const collectionId = await freshCollection()
        const result = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          input: jsonInput({ v: 1 }),
          createdBy: [ALICE],
          ownedBy: [ALICE]
        })
        assert.equal(result.created, true)
        assert.deepEqual(result.members.createdBy, [ALICE])
      })

      it("creates over a tombstone of another principal's Resource", async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        const result = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          input: jsonInput({ v: 1 }),
          createdBy: [ALICE],
          ownedBy: [ALICE]
        })
        assert.equal(result.created, true)
        assert.deepEqual(result.members.createdBy, [ALICE])
      })

      it('refuses before a failing If-Match', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            ifMatch: STALE_ETAG
          })
        )
        // The same write by the owner fails the precondition instead.
        await assert.rejects(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            ownedBy: [BOB],
            ifMatch: STALE_ETAG
          }),
          PreconditionFailedError
        )
      })

      it('refuses before If-None-Match: *', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            ifNoneMatch: '*'
          })
        )
      })

      it('refuses before the write-once rule', async () => {
        const collectionId = await freshCollection()
        const { validator } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          input: jsonInput({ v: 1 }),
          createdBy: [BOB],
          immutable: true
        })
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            immutable: true,
            ownedBy: [ALICE]
          })
        )
        // A repeat of the stored bytes is refused too.
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 1 }),
            immutable: true,
            ownedBy: [ALICE]
          })
        )
        // The owner meets the write-once rule.
        await assert.rejects(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            input: jsonInput({ v: 2 }),
            immutable: true,
            ownedBy: [BOB]
          }),
          ResourceImmutableError
        )
        assert.equal(
          (await stored({ collectionId, resourceId: 'r' })).etag,
          formatEtag(validator)
        )
      })

      it('requires every principal in createdBy', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'one', createdBy: [ALICE] })
        await seed({
          collectionId,
          resourceId: 'both',
          createdBy: [ALICE, BOB]
        })
        await assertNotOwn(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'one',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE, BOB]
          })
        )
        const result = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'both',
          input: jsonInput({ v: 2 }),
          ownedBy: [BOB, ALICE]
        })
        assert.equal(result.created, false)
      })

      it('checks nothing with ownedBy absent or empty', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          input: jsonInput({ v: 2 })
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          input: jsonInput({ v: 3 }),
          ownedBy: []
        })
        const after = await stored({ collectionId, resourceId: 'r' })
        assert.deepEqual(after.body, { v: 3 })
      })
    })

    describe('getResource', () => {
      it('returns the createdBy of the record it serves, a re-created one included', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [ALICE] })
        const first = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        first.resourceStream.destroy()
        assert.deepEqual(first.createdBy, [ALICE])
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'r' })
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        const second = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        second.resourceStream.destroy()
        assert.deepEqual(second.createdBy, [BOB])
      })

      it('returns none for a Resource with no createdBy', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r' })
        const result = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        result.resourceStream.destroy()
        assert.equal(result.createdBy, undefined)
      })
    })

    describe('deleteResource', () => {
      it('deletes a Resource the principal owns', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [ALICE] })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          ownedBy: [ALICE]
        })
        await assert.rejects(
          backend.getResource({ spaceId, collectionId, resourceId: 'r' }),
          ResourceNotFoundError
        )
      })

      it('refuses a Resource the principal does not own, and removes nothing', async () => {
        const collectionId = await freshCollection()
        const etag = await seed({
          collectionId,
          resourceId: 'r',
          createdBy: [BOB]
        })
        await assertNotOwn(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            ownedBy: [ALICE]
          })
        )
        assert.equal(
          (await stored({ collectionId, resourceId: 'r' })).etag,
          etag
        )
      })

      it('refuses a Resource with no createdBy', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r' })
        await assertNotOwn(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            ownedBy: [ALICE]
          })
        )
      })

      it("refuses an absent id and another party's tombstone", async () => {
        const collectionId = await freshCollection()
        await assert.rejects(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'never',
            ownedBy: [ALICE]
          }),
          NotOwnResourceError
        )
        await seed({ collectionId, resourceId: 'bobs', createdBy: [BOB] })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'bobs'
        })
        await assert.rejects(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'bobs',
            ownedBy: [ALICE]
          }),
          NotOwnResourceError
        )
      })

      it("is the usual no-op over the principal's own tombstone", async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [ALICE] })
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'r' })
        const before = await backend.getResourceContentStamp({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'r',
          ownedBy: [ALICE]
        })
        const after = await backend.getResourceContentStamp({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        assert.deepEqual(after, before)
      })

      it('refuses before a failing If-Match', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await assertNotOwn(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            ownedBy: [ALICE],
            ifMatch: STALE_ETAG
          })
        )
        await assert.rejects(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            ownedBy: [BOB],
            ifMatch: STALE_ETAG
          }),
          PreconditionFailedError
        )
      })

      it('requires every principal in createdBy', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [ALICE] })
        await assertNotOwn(
          backend.deleteResource({
            spaceId,
            collectionId,
            resourceId: 'r',
            ownedBy: [ALICE, BOB]
          })
        )
      })

      it('checks nothing with ownedBy absent or empty', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'a', createdBy: [BOB] })
        await seed({ collectionId, resourceId: 'b', createdBy: [BOB] })
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'a' })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'b',
          ownedBy: []
        })
        const listing = await backend.listCollectionItems({
          spaceId,
          collectionId
        })
        assert.equal(listing.totalItems, 0)
      })
    })

    describe('writeResourceMetadata', () => {
      it('writes over a Resource the principal owns', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [ALICE] })
        const result = await backend.writeResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'r',
          custom: { name: 'mine' },
          ownedBy: [ALICE]
        })
        assert.ok(result !== undefined)
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        assert.deepEqual(metadata?.custom, { name: 'mine' })
      })

      it('refuses a Resource the principal does not own, and writes nothing', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await assertNotOwn(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'not mine' },
            ownedBy: [ALICE]
          })
        )
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'r'
        })
        assert.equal(metadata?.custom, undefined)
      })

      it('refuses a Resource with no createdBy', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r' })
        await assertNotOwn(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'x' },
            ownedBy: [ALICE]
          })
        )
      })

      it('resolves undefined at an absent id or a tombstone', async () => {
        const collectionId = await freshCollection()
        assert.equal(
          await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'never',
            custom: { name: 'x' },
            ownedBy: [ALICE]
          }),
          undefined
        )
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'r' })
        assert.equal(
          await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'x' },
            ownedBy: [ALICE]
          }),
          undefined
        )
      })

      it('refuses before a failing If-Match and before If-None-Match: *', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await backend.writeResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'r',
          custom: { name: 'first' }
        })
        await assertNotOwn(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'x' },
            ownedBy: [ALICE],
            ifMatch: STALE_ETAG
          })
        )
        await assertNotOwn(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'x' },
            ownedBy: [ALICE],
            ifNoneMatch: '*'
          })
        )
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'x' },
            ownedBy: [BOB],
            ifMatch: STALE_ETAG
          }),
          PreconditionFailedError
        )
      })

      it('requires every principal in createdBy', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        await assertNotOwn(
          backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'x' },
            ownedBy: [BOB, CAROL]
          })
        )
      })

      it('checks nothing with ownedBy absent or empty', async () => {
        const collectionId = await freshCollection()
        await seed({ collectionId, resourceId: 'r', createdBy: [BOB] })
        assert.ok(
          (await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'a' }
          })) !== undefined
        )
        assert.ok(
          (await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r',
            custom: { name: 'b' },
            ownedBy: []
          })) !== undefined
        )
      })
    })

    describe('writeChunk and deleteChunk', () => {
      /**
       * Seeds a parent Resource and its chunk 0, resolving the chunk's
       * `ETag`.
       * @param options {object}
       * @param options.collectionId {string}
       * @param [options.createdBy] {IDID[]}
       * @returns {Promise<string>}
       */
      async function seedChunk({
        collectionId,
        createdBy
      }: {
        collectionId: string
        createdBy?: IDID[]
      }): Promise<string> {
        await seed({ collectionId, resourceId: 'parent', createdBy })
        const validator = await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 0,
          input: binaryInput('chunk zero')
        })
        return formatEtag(validator)
      }

      /**
       * The `ETag` of chunk 0, or `undefined` when it is absent.
       * @param collectionId {string}
       * @returns {Promise<string | undefined>}
       */
      async function chunkEtag(
        collectionId: string
      ): Promise<string | undefined> {
        const metadata = await backend.getChunkMetadata({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 0
        })
        return metadata === undefined ? undefined : etagOf(metadata)
      }

      it('writes and deletes a chunk of a parent the principal owns', async () => {
        const collectionId = await freshCollection()
        const etag = await seedChunk({ collectionId, createdBy: [ALICE] })
        const rewritten = await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 0,
          input: binaryInput('chunk zero again'),
          ownedBy: [ALICE]
        })
        assert.notEqual(formatEtag(rewritten), etag)
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 1,
          input: binaryInput('chunk one'),
          ownedBy: [ALICE]
        })
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [ALICE]
          }),
          true
        )
        assert.equal(await chunkEtag(collectionId), undefined)
      })

      it('refuses a chunk write and delete under a parent the principal does not own', async () => {
        const collectionId = await freshCollection()
        const etag = await seedChunk({ collectionId, createdBy: [BOB] })
        await assertNotOwn(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('overwrite'),
            ownedBy: [ALICE]
          })
        )
        await assertNotOwn(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 1,
            input: binaryInput('new chunk'),
            ownedBy: [ALICE]
          })
        )
        await assertNotOwn(
          backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [ALICE]
          })
        )
        // An absent chunk index under such a parent is refused too.
        await assertNotOwn(
          backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 7,
            ownedBy: [ALICE]
          })
        )
        assert.equal(await chunkEtag(collectionId), etag)
        const listing = await backend.listChunks({
          spaceId,
          collectionId,
          resourceId: 'parent'
        })
        assert.deepEqual(
          listing.chunks.map(({ index }) => index),
          [0]
        )
      })

      it('refuses under a parent with no createdBy, or one missing a principal', async () => {
        const collectionId = await freshCollection()
        await seedChunk({ collectionId })
        await assertNotOwn(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('x'),
            ownedBy: [ALICE]
          })
        )
        const other = await freshCollection()
        await seedChunk({ collectionId: other, createdBy: [ALICE] })
        await assertNotOwn(
          backend.deleteChunk({
            spaceId,
            collectionId: other,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [ALICE, BOB]
          })
        )
      })

      it('refuses before a failing If-Match', async () => {
        const collectionId = await freshCollection()
        await seedChunk({ collectionId, createdBy: [BOB] })
        await assertNotOwn(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('x'),
            ownedBy: [ALICE],
            ifMatch: STALE_ETAG
          })
        )
        await assertNotOwn(
          backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [ALICE],
            ifMatch: STALE_ETAG
          })
        )
        await assert.rejects(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('x'),
            ownedBy: [BOB],
            ifMatch: STALE_ETAG
          }),
          PreconditionFailedError
        )
        await assert.rejects(
          backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [BOB],
            ifMatch: STALE_ETAG
          }),
          PreconditionFailedError
        )
      })

      it('refuses before the write-once rule', async () => {
        const collectionId = await freshCollection()
        const etag = await seedChunk({ collectionId, createdBy: [BOB] })
        await assertNotOwn(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('different'),
            immutable: true,
            ownedBy: [ALICE]
          })
        )
        await assert.rejects(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('different'),
            immutable: true,
            ownedBy: [BOB]
          }),
          ResourceImmutableError
        )
        assert.equal(await chunkEtag(collectionId), etag)
      })

      it('answers as it does without principals when no live parent stands', async () => {
        const collectionId = await freshCollection()
        await assert.rejects(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('x'),
            ownedBy: [ALICE]
          }),
          ResourceNotFoundError
        )
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [ALICE]
          }),
          false
        )
        await seedChunk({ collectionId, createdBy: [BOB] })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'parent'
        })
        await assert.rejects(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            input: binaryInput('x'),
            ownedBy: [ALICE]
          }),
          ResourceNotFoundError
        )
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0,
            ownedBy: [ALICE]
          }),
          false
        )
      })

      it('checks nothing with ownedBy absent or empty', async () => {
        const collectionId = await freshCollection()
        await seedChunk({ collectionId, createdBy: [BOB] })
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 1,
          input: binaryInput('one'),
          ownedBy: []
        })
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 0
          }),
          true
        )
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId,
            resourceId: 'parent',
            chunkIndex: 1,
            ownedBy: []
          }),
          true
        )
      })
    })

    describe('listCollectionItems', () => {
      // The creators of `r00` .. `r11`, in id order. Alice's own are
      // r01, r02, r05, r06, r07 and r10; the rest interleave with them.
      const CREATORS: Array<IDID[] | undefined> = [
        [BOB],
        [ALICE],
        [BOB, ALICE],
        undefined,
        [CAROL],
        [ALICE],
        [ALICE, CAROL],
        [CONTROLLER, ALICE],
        [BOB],
        [CAROL],
        [ALICE],
        undefined
      ]
      const idOf = (index: number) => `r${String(index).padStart(2, '0')}`
      const ownedBy = (principal: IDID) =>
        CREATORS.flatMap((creators, index) =>
          creators?.includes(principal) ? [idOf(index)] : []
        )
      let collectionId: string

      beforeAll(async () => {
        collectionId = await freshCollection()
        // Written out of id order, so storage order is not the keyset.
        const order = [7, 0, 11, 3, 5, 9, 1, 10, 2, 8, 4, 6]
        for (const index of order) {
          await seed({
            collectionId,
            resourceId: idOf(index),
            createdBy: CREATORS[index]
          })
        }
        // A tombstone of Alice's own is not listed.
        await seed({ collectionId, resourceId: 'r99', createdBy: [ALICE] })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'r99'
        })
      })

      /**
       * Reads every page of a filtered listing.
       * @param options {object}
       * @param options.principals {IDID[]}
       * @param options.limit {number}
       * @returns {Promise<CollectionResourcesList[]>}
       */
      async function allPages({
        principals,
        limit
      }: {
        principals: IDID[]
        limit: number
      }): Promise<CollectionResourcesList[]> {
        const pages: CollectionResourcesList[] = []
        let cursor: string | undefined
        for (;;) {
          const page = await backend.listCollectionItems({
            spaceId,
            collectionId,
            limit,
            cursor,
            ownedBy: principals
          })
          pages.push(page)
          if (page.next === undefined) {
            return pages
          }
          assert.ok(pages.length < 20, 'the listing does not end')
          cursor = cursorOf(page)
        }
      }

      it('lists and counts only the principal own Resources', async () => {
        const page = await backend.listCollectionItems({
          spaceId,
          collectionId,
          ownedBy: [ALICE]
        })
        const expected = ownedBy(ALICE)
        assert.deepEqual(
          page.items.map(({ id }) => id),
          expected
        )
        assert.equal(page.totalItems, expected.length)
        assert.equal(page.next, undefined)
      })

      it('pages over the filtered set across interleaved Resources', async () => {
        const expected = ownedBy(ALICE)
        for (const limit of [1, 2, 4, 5, 6, 7]) {
          const pages = await allPages({ principals: [ALICE], limit })
          assert.deepEqual(
            pages.flatMap(({ items }) => items.map(({ id }) => id)),
            expected,
            `limit ${limit}`
          )
          assert.equal(
            pages.length,
            Math.max(1, Math.ceil(expected.length / limit)),
            `limit ${limit}`
          )
          for (const page of pages) {
            assert.ok(page.items.length <= limit)
            assert.equal(page.totalItems, expected.length)
          }
          for (const page of pages.slice(0, -1)) {
            assert.equal(page.items.length, limit)
          }
        }
      })

      it('has no next when only Resources of others follow the page', async () => {
        // Alice's last own Resource is r10; r11 is no one's.
        const expected = ownedBy(ALICE)
        const head = await backend.listCollectionItems({
          spaceId,
          collectionId,
          limit: expected.length - 1,
          ownedBy: [ALICE]
        })
        assert.ok(head.next !== undefined)
        const tail = await backend.listCollectionItems({
          spaceId,
          collectionId,
          limit: expected.length - 1,
          cursor: cursorOf(head),
          ownedBy: [ALICE]
        })
        assert.deepEqual(
          tail.items.map(({ id }) => id),
          expected.slice(-1)
        )
        assert.equal(tail.next, undefined)
      })

      it('requires every principal', async () => {
        const page = await backend.listCollectionItems({
          spaceId,
          collectionId,
          ownedBy: [ALICE, CAROL]
        })
        assert.deepEqual(
          page.items.map(({ id }) => id),
          ['r06']
        )
        assert.equal(page.totalItems, 1)
        const none = await backend.listCollectionItems({
          spaceId,
          collectionId,
          ownedBy: ['did:key:z6MkOwnResourcesNobody']
        })
        assert.deepEqual(none.items, [])
        assert.equal(none.totalItems, 0)
        assert.equal(none.next, undefined)
      })

      it('lists everything with ownedBy absent or empty', async () => {
        const all = CREATORS.map((_creators, index) => idOf(index))
        for (const principals of [undefined, []]) {
          const first = await backend.listCollectionItems({
            spaceId,
            collectionId,
            limit: 5,
            ownedBy: principals
          })
          assert.equal(first.totalItems, all.length)
          assert.deepEqual(
            first.items.map(({ id }) => id),
            all.slice(0, 5)
          )
          assert.ok(first.next !== undefined)
        }
      })
    })
  })
}

describeOwnResources({ name: 'FileSystemBackend', openBackend: openFilesystem })

if (connectionString) {
  describeOwnResources({ name: 'PostgresBackend', openBackend: openPostgres })
} else {
  describe('ownedBy (PostgresBackend)', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
}
