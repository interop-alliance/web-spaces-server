/**
 * The Postgres backend's side of the `OwnResourcesOnly` caveat: the `ownedBy`
 * option of the Resource and chunk writes and deletes, decided inside the
 * write's transaction before the preconditions and the write-once rule, and
 * the filtered Collection listing, its `totalItems` and its pagination.
 *
 * OPT-IN like the other Postgres suites: requires a disposable Postgres
 * reachable via `WAS_TEST_DATABASE_URL`, and skipped with a visible notice
 * when unset. Each test operates in a throwaway `was_test_<hex>` schema,
 * dropped afterwards.
 *
 *   WAS_TEST_DATABASE_URL=postgres://was:was@localhost:5433/was pnpm test:pg
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import type { PostgresBackend } from '../src/backends/postgres.js'
import {
  NotOwnResourceError,
  PreconditionFailedError,
  ResourceImmutableError,
  ResourceNotFoundError
} from '../src/errors.js'
import { cursorOfNextUrl } from '../src/lib/pagination.js'
import type { IDID } from '../src/types.js'
import { binaryInput, openTempPostgres } from './helpers.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

const CONTROLLER: IDID =
  'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const ALICE: IDID = 'did:key:z6MkAliceAliceAliceAliceAliceAliceAliceAlice'
const BOB: IDID = 'did:key:z6MkBobBobBobBobBobBobBobBobBobBobBobBobBob'

const SPACE = 'space1'
const COLLECTION = 'notes'

/**
 * A JSON `ResourceInput` over one document.
 * @param data {object}
 * @returns {object}
 */
function jsonInput(data: Record<string, unknown>): {
  kind: 'json'
  contentType: string
  data: Record<string, unknown>
} {
  return { kind: 'json', contentType: 'application/json', data }
}

if (!connectionString) {
  describe('PostgresBackend OwnResourcesOnly', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
} else {
  describe('PostgresBackend OwnResourcesOnly', () => {
    let backend: PostgresBackend
    let dropSchema: () => Promise<void>

    /**
     * Writes one JSON Resource into the test Collection.
     * @param resourceId {string}
     * @param [createdBy] {IDID[]}
     * @returns {Promise<void>}
     */
    async function seed(resourceId: string, createdBy?: IDID[]): Promise<void> {
      await backend.writeResource({
        spaceId: SPACE,
        collectionId: COLLECTION,
        resourceId,
        input: jsonInput({ id: resourceId, v: 1 }),
        ...(createdBy !== undefined && { createdBy })
      })
    }

    /**
     * Reads a live Resource's JSON content back.
     * @param resourceId {string}
     * @returns {Promise<unknown>}
     */
    async function contentOf(resourceId: string): Promise<unknown> {
      const { resourceStream } = await backend.getResource({
        spaceId: SPACE,
        collectionId: COLLECTION,
        resourceId
      })
      const parts: Buffer[] = []
      for await (const part of resourceStream) {
        parts.push(Buffer.from(part))
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    }

    /**
     * Soft-deletes a Resource with no principals.
     * @param resourceId {string}
     * @returns {Promise<void>}
     */
    async function tombstone(resourceId: string): Promise<void> {
      await backend.deleteResource({
        spaceId: SPACE,
        collectionId: COLLECTION,
        resourceId
      })
    }

    /**
     * Walks every page of the listing under `ownedBy`.
     * @param options {object}
     * @param [options.ownedBy] {IDID[]}
     * @param options.limit {number}
     * @returns {Promise<{ ids: string[], totals: number[], pages: number }>}
     */
    async function walkListing({
      ownedBy,
      limit
    }: {
      ownedBy?: IDID[]
      limit: number
    }): Promise<{ ids: string[]; totals: number[]; pages: number }> {
      const ids: string[] = []
      const totals: number[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await backend.listCollectionItems({
          spaceId: SPACE,
          collectionId: COLLECTION,
          limit,
          ...(cursor !== undefined && { cursor }),
          ...(ownedBy !== undefined && { ownedBy })
        })
        pages++
        assert.ok(page.items.length <= limit)
        ids.push(...page.items.map(item => item.id))
        totals.push(page.totalItems)
        cursor = cursorOfNextUrl(page.next)
        // A page that says more may follow carries a full page of items.
        if (cursor !== undefined) {
          assert.equal(page.items.length, limit)
        }
      } while (cursor !== undefined)
      return { ids, totals, pages }
    }

    beforeEach(async () => {
      ;({ backend, dropSchema } = await openTempPostgres())
      await backend.writeSpace({
        spaceId: SPACE,
        spaceMetadata: { id: SPACE, type: ['Space'], controller: CONTROLLER }
      })
      await backend.writeCollection({
        spaceId: SPACE,
        collectionId: COLLECTION,
        collectionMetadata: { id: COLLECTION, type: ['Collection'] }
      })
      await seed('alices', [CONTROLLER, ALICE])
      await seed('bobs', [CONTROLLER, BOB])
      await seed('nobodys')
    })

    afterEach(async () => {
      await backend.close()
      await dropSchema()
    })

    describe('writeResource', () => {
      it('writes over a Resource the principal owns, keeping its createdBy', async () => {
        const { created } = await backend.writeResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices',
          input: jsonInput({ v: 2 }),
          createdBy: [CONTROLLER, ALICE],
          ownedBy: [ALICE]
        })
        assert.equal(created, false)
        assert.deepEqual(await contentOf('alices'), { v: 2 })
        const metadata = await backend.getResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices'
        })
        assert.deepEqual(metadata?.createdBy, [CONTROLLER, ALICE])
      })

      it('refuses a Resource the principal does not own, writing nothing', async () => {
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE]
          }),
          NotOwnResourceError
        )
        assert.deepEqual(await contentOf('bobs'), { id: 'bobs', v: 1 })
      })

      it('refuses a Resource with no createdBy', async () => {
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'nobodys',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE]
          }),
          NotOwnResourceError
        )
        assert.deepEqual(await contentOf('nobodys'), { id: 'nobodys', v: 1 })
      })

      it('creates at an absent id', async () => {
        const { created } = await backend.writeResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'fresh',
          input: jsonInput({ v: 1 }),
          createdBy: [CONTROLLER, ALICE],
          ownedBy: [ALICE]
        })
        assert.equal(created, true)
      })

      it("creates over another principal's tombstone, under the writer's createdBy", async () => {
        await tombstone('bobs')
        const { created } = await backend.writeResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'bobs',
          input: jsonInput({ v: 2 }),
          createdBy: [CONTROLLER, ALICE],
          ownedBy: [ALICE]
        })
        assert.equal(created, true)
        const metadata = await backend.getResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'bobs'
        })
        assert.deepEqual(metadata?.createdBy, [CONTROLLER, ALICE])
      })

      it('requires every principal when two are listed', async () => {
        await seed('both', [ALICE, BOB])
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE, BOB]
          }),
          NotOwnResourceError
        )
        const { created } = await backend.writeResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'both',
          input: jsonInput({ v: 2 }),
          ownedBy: [ALICE, BOB]
        })
        assert.equal(created, false)
      })

      it('refuses before a failing If-Match or If-None-Match', async () => {
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          NotOwnResourceError
        )
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            ifNoneMatch: '*'
          }),
          NotOwnResourceError
        )
        // The owner gets the precondition's answer.
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          PreconditionFailedError
        )
      })

      it('refuses before the write-once rule', async () => {
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            immutable: true
          }),
          NotOwnResourceError
        )
        // The owner gets the write-once rule's answer.
        await assert.rejects(
          backend.writeResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            input: jsonInput({ v: 2 }),
            ownedBy: [ALICE],
            immutable: true
          }),
          ResourceImmutableError
        )
      })

      it('changes nothing with an absent or empty ownedBy', async () => {
        await backend.writeResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'bobs',
          input: jsonInput({ v: 2 })
        })
        await backend.writeResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'nobodys',
          input: jsonInput({ v: 2 }),
          ownedBy: []
        })
        assert.deepEqual(await contentOf('bobs'), { v: 2 })
        assert.deepEqual(await contentOf('nobodys'), { v: 2 })
      })
    })

    describe('deleteResource', () => {
      /**
       * Whether a Resource is live.
       * @param resourceId {string}
       * @returns {Promise<boolean>}
       */
      async function isLive(resourceId: string): Promise<boolean> {
        const metadata = await backend.getResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId
        })
        return metadata !== undefined
      }

      it('deletes a Resource the principal owns', async () => {
        await backend.deleteResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices',
          ownedBy: [ALICE]
        })
        assert.equal(await isLive('alices'), false)
      })

      it('refuses a Resource the principal does not own, or one with no createdBy', async () => {
        for (const resourceId of ['bobs', 'nobodys']) {
          await assert.rejects(
            backend.deleteResource({
              spaceId: SPACE,
              collectionId: COLLECTION,
              resourceId,
              ownedBy: [ALICE]
            }),
            NotOwnResourceError
          )
          assert.equal(await isLive(resourceId), true)
        }
      })

      it('refuses before a failing If-Match', async () => {
        await assert.rejects(
          backend.deleteResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          NotOwnResourceError
        )
        await assert.rejects(
          backend.deleteResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          PreconditionFailedError
        )
      })

      it("refuses an absent id and another party's tombstone", async () => {
        await tombstone('bobs')
        for (const resourceId of ['absent', 'bobs']) {
          await assert.rejects(
            backend.deleteResource({
              spaceId: SPACE,
              collectionId: COLLECTION,
              resourceId,
              ownedBy: [ALICE]
            }),
            NotOwnResourceError
          )
        }
      })

      it("is the usual no-op over the principal's own tombstone", async () => {
        await tombstone('alices')
        await backend.deleteResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices',
          ownedBy: [ALICE]
        })
        assert.equal(await isLive('alices'), false)
      })

      it('requires every principal when two are listed', async () => {
        await assert.rejects(
          backend.deleteResource({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            ownedBy: [ALICE, BOB]
          }),
          NotOwnResourceError
        )
        assert.equal(await isLive('alices'), true)
      })

      it('changes nothing with an absent or empty ownedBy', async () => {
        await backend.deleteResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'bobs'
        })
        await backend.deleteResource({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'nobodys',
          ownedBy: []
        })
        assert.equal(await isLive('bobs'), false)
        assert.equal(await isLive('nobodys'), false)
      })
    })

    describe('writeResourceMetadata', () => {
      /**
       * The stored `custom` of a Resource.
       * @param resourceId {string}
       * @returns {Promise<unknown>}
       */
      async function customOf(resourceId: string): Promise<unknown> {
        const metadata = await backend.getResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId
        })
        return metadata?.custom
      }

      it('writes the metadata of a Resource the principal owns', async () => {
        const result = await backend.writeResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices',
          custom: { name: 'mine' },
          ownedBy: [ALICE]
        })
        assert.ok(result !== undefined)
        assert.deepEqual(await customOf('alices'), { name: 'mine' })
      })

      it('refuses a Resource the principal does not own, or one with no createdBy', async () => {
        for (const resourceId of ['bobs', 'nobodys']) {
          await assert.rejects(
            backend.writeResourceMetadata({
              spaceId: SPACE,
              collectionId: COLLECTION,
              resourceId,
              custom: { name: 'theirs' },
              ownedBy: [ALICE]
            }),
            NotOwnResourceError
          )
          assert.equal(await customOf(resourceId), undefined)
        }
      })

      it('refuses before a failing If-Match or If-None-Match', async () => {
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            custom: { name: 'theirs' },
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          NotOwnResourceError
        )
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            custom: { name: 'theirs' },
            ownedBy: [ALICE],
            ifNoneMatch: '*'
          }),
          NotOwnResourceError
        )
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            custom: { name: 'mine' },
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          PreconditionFailedError
        )
      })

      it('resolves undefined at an absent id or a tombstone', async () => {
        await tombstone('bobs')
        for (const resourceId of ['absent', 'bobs']) {
          const result = await backend.writeResourceMetadata({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId,
            custom: { name: 'x' },
            ownedBy: [ALICE]
          })
          assert.equal(result, undefined)
        }
      })

      it('requires every principal when two are listed', async () => {
        await assert.rejects(
          backend.writeResourceMetadata({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            custom: { name: 'x' },
            ownedBy: [BOB, ALICE]
          }),
          NotOwnResourceError
        )
      })

      it('changes nothing with an absent or empty ownedBy', async () => {
        await backend.writeResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'bobs',
          custom: { name: 'a' }
        })
        await backend.writeResourceMetadata({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'nobodys',
          custom: { name: 'b' },
          ownedBy: []
        })
        assert.deepEqual(await customOf('bobs'), { name: 'a' })
        assert.deepEqual(await customOf('nobodys'), { name: 'b' })
      })
    })

    describe('writeChunk and deleteChunk', () => {
      /**
       * The number of chunks stored under a Resource.
       * @param resourceId {string}
       * @returns {Promise<number>}
       */
      async function chunkCount(resourceId: string): Promise<number> {
        const { count } = await backend.listChunks({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId
        })
        return count
      }

      beforeEach(async () => {
        for (const resourceId of ['alices', 'bobs', 'nobodys']) {
          await backend.writeChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId,
            chunkIndex: 0,
            input: binaryInput('chunk zero')
          })
        }
      })

      it('writes and deletes a chunk under a parent the principal owns', async () => {
        await backend.writeChunk({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices',
          chunkIndex: 1,
          input: binaryInput('chunk one'),
          ownedBy: [ALICE]
        })
        assert.equal(await chunkCount('alices'), 2)
        const removed = await backend.deleteChunk({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'alices',
          chunkIndex: 0,
          ownedBy: [ALICE]
        })
        assert.equal(removed, true)
        assert.equal(await chunkCount('alices'), 1)
      })

      it('refuses a chunk write or delete under a parent the principal does not own, or one with no createdBy', async () => {
        for (const resourceId of ['bobs', 'nobodys']) {
          await assert.rejects(
            backend.writeChunk({
              spaceId: SPACE,
              collectionId: COLLECTION,
              resourceId,
              chunkIndex: 1,
              input: binaryInput('chunk one'),
              ownedBy: [ALICE]
            }),
            NotOwnResourceError
          )
          await assert.rejects(
            backend.deleteChunk({
              spaceId: SPACE,
              collectionId: COLLECTION,
              resourceId,
              chunkIndex: 0,
              ownedBy: [ALICE]
            }),
            NotOwnResourceError
          )
          assert.equal(await chunkCount(resourceId), 1)
        }
      })

      it('refuses a chunk delete at an absent index under a parent the principal does not own', async () => {
        await assert.rejects(
          backend.deleteChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            chunkIndex: 7,
            ownedBy: [ALICE]
          }),
          NotOwnResourceError
        )
      })

      it('refuses before the chunk preconditions and the write-once rule', async () => {
        await assert.rejects(
          backend.writeChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            chunkIndex: 0,
            input: binaryInput('other bytes'),
            ownedBy: [ALICE],
            ifNoneMatch: '*'
          }),
          NotOwnResourceError
        )
        await assert.rejects(
          backend.writeChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            chunkIndex: 0,
            input: binaryInput('other bytes'),
            ownedBy: [ALICE],
            immutable: true
          }),
          NotOwnResourceError
        )
        await assert.rejects(
          backend.deleteChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'bobs',
            chunkIndex: 0,
            ownedBy: [ALICE],
            ifMatch: '"no-such-validator"'
          }),
          NotOwnResourceError
        )
        // The owner gets the precondition's and the rule's answers.
        await assert.rejects(
          backend.writeChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            chunkIndex: 0,
            input: binaryInput('other bytes'),
            ownedBy: [ALICE],
            ifNoneMatch: '*'
          }),
          PreconditionFailedError
        )
        await assert.rejects(
          backend.writeChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'alices',
            chunkIndex: 0,
            input: binaryInput('other bytes'),
            ownedBy: [ALICE],
            immutable: true
          }),
          ResourceImmutableError
        )
      })

      it('answers as it does with no principals when the parent is not live', async () => {
        await tombstone('bobs')
        for (const resourceId of ['absent', 'bobs']) {
          await assert.rejects(
            backend.writeChunk({
              spaceId: SPACE,
              collectionId: COLLECTION,
              resourceId,
              chunkIndex: 0,
              input: binaryInput('chunk zero'),
              ownedBy: [ALICE]
            }),
            ResourceNotFoundError
          )
          const removed = await backend.deleteChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId,
            chunkIndex: 0,
            ownedBy: [ALICE]
          })
          assert.equal(removed, false)
        }
      })

      it('changes nothing with an absent or empty ownedBy', async () => {
        await backend.writeChunk({
          spaceId: SPACE,
          collectionId: COLLECTION,
          resourceId: 'bobs',
          chunkIndex: 1,
          input: binaryInput('chunk one'),
          ownedBy: []
        })
        assert.equal(
          await backend.deleteChunk({
            spaceId: SPACE,
            collectionId: COLLECTION,
            resourceId: 'nobodys',
            chunkIndex: 0
          }),
          true
        )
        assert.equal(await chunkCount('bobs'), 2)
        assert.equal(await chunkCount('nobodys'), 0)
      })
    })

    describe('listCollectionItems', () => {
      // Ids in listing order, matching and non-matching interleaved. The
      // last id in keyset order is not Alice's, so a page ending on her last
      // Resource must carry no `next`.
      const LAYOUT: Array<[string, IDID[] | undefined]> = [
        ['r00', [CONTROLLER, ALICE]],
        ['r01', [CONTROLLER, BOB]],
        ['r02', undefined],
        ['r03', [CONTROLLER, ALICE]],
        ['r04', [ALICE, BOB]],
        ['r05', [CONTROLLER, BOB]],
        ['r06', [CONTROLLER, ALICE]],
        ['r07', [CONTROLLER, ALICE]],
        ['r08', undefined],
        ['r09', [CONTROLLER, BOB]]
      ]

      beforeEach(async () => {
        for (const resourceId of ['alices', 'bobs', 'nobodys']) {
          await tombstone(resourceId)
        }
        for (const [resourceId, createdBy] of LAYOUT) {
          await seed(resourceId, createdBy)
        }
        // A tombstone of Alice's is not listed.
        await tombstone('r06')
      })

      it("lists only the principal's live Resources, across pages", async () => {
        const aliceIds = ['r00', 'r03', 'r04', 'r07']
        for (const limit of [1, 2, 3, 4, 10]) {
          const { ids, totals, pages } = await walkListing({
            ownedBy: [ALICE],
            limit
          })
          assert.deepEqual(ids, aliceIds, `limit ${limit}`)
          assert.ok(totals.every(total => total === aliceIds.length))
          assert.equal(pages, Math.max(1, Math.ceil(aliceIds.length / limit)))
        }
      })

      it('requires every principal when two are listed', async () => {
        const { ids, totals } = await walkListing({
          ownedBy: [ALICE, BOB],
          limit: 1
        })
        assert.deepEqual(ids, ['r04'])
        assert.deepEqual(totals, [1])
      })

      it('lists nothing for a principal with no Resources', async () => {
        const page = await backend.listCollectionItems({
          spaceId: SPACE,
          collectionId: COLLECTION,
          ownedBy: ['did:key:z6MkNobodyNobodyNobodyNobodyNobodyNobody']
        })
        assert.deepEqual(page.items, [])
        assert.equal(page.totalItems, 0)
        assert.equal(page.next, undefined)
      })

      it('lists every live Resource with an absent or empty ownedBy', async () => {
        const live = LAYOUT.map(([resourceId]) => resourceId).filter(
          resourceId => resourceId !== 'r06'
        )
        for (const ownedBy of [undefined, []]) {
          const { ids, totals } = await walkListing({ ownedBy, limit: 4 })
          assert.deepEqual(ids, live)
          assert.ok(totals.every(total => total === live.length))
        }
      })
    })
  })
}
