/**
 * The Postgres backend's replica registrations and apply path: the
 * `replicas` table, the registration records and their loop state, and each
 * `apply*` method's comparison against the held record.
 *
 * OPT-IN, like the rest of the Postgres suite: requires a disposable Postgres
 * reachable via `WAS_TEST_DATABASE_URL`, and is skipped with a visible notice
 * when unset. Each test runs in a throwaway `was_test_<hex>` schema.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import { text as streamText } from 'node:stream/consumers'
import type { PostgresBackend } from '../src/backends/postgres.js'
import { MIGRATIONS } from '../src/backends/postgresSchema.js'
import {
  IdConflictError,
  QuotaExceededError,
  SpaceNotFoundError
} from '../src/errors.js'
import { formatEtag } from '../src/lib/etag.js'
import { withoutStampMembers } from '../src/lib/hlc.js'
import { binaryInput, openTempPostgres, postgresAdminQuery } from './helpers.js'
import type {
  CollectionMetadata,
  ReplicaRegistration,
  WriteStamp
} from '../src/types.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

const spaceId = 'space-1'
const replicaId = 'from-peer'
const controller = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
// A fixed physical clock, so a test dates a received stamp against it.
const NOW = Date.parse('2026-10-04T12:00:00.000Z')

/**
 * A stamp from a peer, `offset` ms from the frozen clock.
 * @param offset {number}
 * @param [counter] {number}
 * @returns {WriteStamp}
 */
function peerStamp(offset: number, counter = 0): WriteStamp {
  return {
    updatedAt: new Date(NOW + offset).toISOString(),
    updatedAtCounter: counter,
    originId: 'peer-origin'
  }
}

const registration = {
  id: replicaId,
  fromSpace: 'https://peer.example/space/space-9/',
  toSpace: 'https://pws.example/space/space-1/',
  capability: { id: 'urn:uuid:pull' },
  role: 'source'
} as unknown as ReplicaRegistration

if (!connectionString) {
  describe('PostgresBackend replica apply path', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
} else {
  describe('PostgresBackend replica apply path', () => {
    let backend: PostgresBackend
    let schema: string
    let dropSchema: () => Promise<void>

    beforeEach(async () => {
      ;({ backend, schema, dropSchema } = await openTempPostgres({
        physicalClock: () => NOW
      }))
      await backend.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller, name: 'One' }
      })
    })

    afterEach(async () => {
      await backend.close()
      await dropSchema()
    })

    /**
     * A received live Collection Metadata object.
     */
    function peerCollection({
      stamp,
      created = stamp,
      ...members
    }: Partial<CollectionMetadata> & {
      stamp: WriteStamp
      created?: WriteStamp
    }): CollectionMetadata {
      return {
        id: 'notes',
        name: 'notes',
        type: ['Collection'],
        createdAt: created.updatedAt,
        created,
        ...members,
        ...stamp
      } as CollectionMetadata
    }

    async function applyNotes(
      options: { generation?: string; stamp?: WriteStamp } = {}
    ) {
      return backend.applyCollection({
        spaceId,
        replicaId,
        collectionId: 'notes',
        collection: {
          deleted: false,
          generation: options.generation ?? 'genPeerA',
          metadata: peerCollection({ stamp: options.stamp ?? peerStamp(-1000) })
        }
      })
    }

    describe('registrations', () => {
      it('migrates the replicas table', async () => {
        const { rows } = await postgresAdminQuery(
          `SELECT MAX(version) AS version FROM "${schema}".schema_migrations`
        )
        assert.equal(rows[0].version, MIGRATIONS.length)
        await postgresAdminQuery(`SELECT state FROM "${schema}".replicas`)
      })

      it('creates, reads, lists and deletes a registration', async () => {
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        const stored = await backend.createReplica({
          spaceId,
          record: registration,
          pullsChunks: false
        })
        // The record is served under the write's stamp.
        assert.deepStrictEqual(withoutStampMembers(stored.record), registration)
        assert.equal(stored.record.originId, backend.originId)
        assert.equal(stored.spaceGeneration, before.metaGeneration)
        assert.ok(stored.generation.length > 0)

        const afterCreate = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterCreate.metaLocal, before.metaLocal! + 1)
        assert.equal(afterCreate.updatedAt, before.updatedAt)

        assert.deepStrictEqual(
          await backend.getReplica({ spaceId, replicaId }),
          stored
        )
        assert.deepStrictEqual(await backend.listReplicas({ spaceId }), [
          stored
        ])
        assert.deepStrictEqual(await backend.listAllReplicas(), [
          { ...stored, spaceId }
        ])

        assert.equal(await backend.deleteReplica({ spaceId, replicaId }), true)
        assert.equal(await backend.deleteReplica({ spaceId, replicaId }), false)
        const afterDelete = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterDelete.metaLocal, before.metaLocal! + 2)
        assert.equal(
          await backend.getReplica({ spaceId, replicaId }),
          undefined
        )
        assert.deepStrictEqual(await backend.listReplicas({ spaceId }), [])
      })

      it('refuses a duplicate id and an absent Space', async () => {
        await backend.createReplica({
          spaceId,
          record: registration,
          pullsChunks: false
        })
        await assert.rejects(
          backend.createReplica({
            spaceId,
            record: registration,
            pullsChunks: false
          }),
          IdConflictError
        )
        await assert.rejects(
          backend.createReplica({
            spaceId: 'nowhere',
            record: registration,
            pullsChunks: false
          }),
          SpaceNotFoundError
        )
        assert.deepStrictEqual(
          await backend.listReplicas({ spaceId: 'nowhere' }),
          []
        )
      })

      it('keeps loop state beside the record and drops both with the Space', async () => {
        assert.equal(
          await backend.writeReplicaState({
            spaceId,
            replicaId,
            state: { collections: {} }
          }),
          false
        )
        await backend.createReplica({
          spaceId,
          record: registration,
          pullsChunks: false
        })
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
        const state = {
          lastPullAt: '2026-10-04T12:00:00.000Z',
          collections: {
            notes: { state: 'synced' as const, checkpoint: 'abc' }
          }
        }
        assert.equal(
          await backend.writeReplicaState({ spaceId, replicaId, state }),
          true
        )
        assert.deepStrictEqual(
          await backend.getReplicaState({ spaceId, replicaId }),
          state
        )
        await backend.deleteSpace({ spaceId })
        assert.deepStrictEqual(await backend.listAllReplicas(), [])
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
      })
    })

    describe('apply', () => {
      beforeEach(async () => {
        await backend.createReplica({
          spaceId,
          record: registration,
          pullsChunks: false
        })
      })

      it('applies nothing without the registration, or under another Space generation', async () => {
        assert.deepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId: 'unknown',
            name: 'Peer',
            stamp: peerStamp(1000)
          }),
          { outcome: 'unregistered' }
        )
        // The Space is deleted and created again: the registration is gone,
        // and one made for the old life would not match the new generation.
        await backend.deleteSpace({ spaceId })
        await backend.writeSpace({
          spaceId,
          spaceMetadata: { id: spaceId, type: ['Space'], controller }
        })
        assert.deepStrictEqual(await applyNotes(), { outcome: 'unregistered' })
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'notes'
          }),
          undefined
        )
      })

      it('refuses a stamp past the clock bound', async () => {
        assert.partialDeepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'Future',
            stamp: peerStamp(120_000)
          }),
          { outcome: 'refused', reason: 'clock-bound' }
        )
        assert.equal((await backend.getSpaceMetadata({ spaceId }))!.name, 'One')
      })

      it('applies the Space name under a greater stamp only', async () => {
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        assert.deepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'Older',
            stamp: peerStamp(-5000)
          }),
          { outcome: 'skipped' }
        )
        const stamp = peerStamp(1000)
        assert.deepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'Peer',
            stamp
          }),
          { outcome: 'applied' }
        )
        const after = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(after.name, 'Peer')
        assert.equal(after.controller, controller)
        assert.equal(after.metaGeneration, before.metaGeneration)
        assert.equal(after.metaLocal, 0)
        assert.partialDeepStrictEqual(after, stamp)
        // The same stamp again is a repeat.
        assert.deepStrictEqual(
          await backend.applySpaceName({ spaceId, replicaId, stamp }),
          { outcome: 'skipped' }
        )
        // An absent name removes the stored one.
        await backend.applySpaceName({
          spaceId,
          replicaId,
          stamp: peerStamp(2000)
        })
        assert.equal(
          'name' in (await backend.getSpaceMetadata({ spaceId }))!,
          false
        )
        // A local write still mints above the applied stamp.
        const written = await backend.writeSpace({
          spaceId,
          spaceMetadata: { id: spaceId, type: ['Space'], controller }
        })
        assert.ok(Date.parse(written.validator.stamp.updatedAt) >= NOW + 2000)
      })

      it('creates and updates a Collection under the received validator', async () => {
        const stamp = peerStamp(-1000)
        assert.deepStrictEqual(await applyNotes({ stamp }), {
          outcome: 'applied'
        })
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        }))!
        assert.equal(stored.metaGeneration, 'genPeerA')
        assert.deepStrictEqual(stored.created, stamp)
        assert.partialDeepStrictEqual(stored, stamp)
        assert.deepStrictEqual(await applyNotes({ stamp }), {
          outcome: 'skipped'
        })

        const feed = await backend.changesSince({
          spaceId,
          collectionId: 'notes',
          limit: 10
        })
        assert.deepStrictEqual(
          feed.documents.map(document => document.kind),
          ['collection-metadata']
        )

        const later = peerStamp(-500)
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: {
              deleted: false,
              generation: 'genPeerA',
              metadata: peerCollection({
                stamp: later,
                created: stamp,
                name: 'renamed'
              })
            }
          }),
          { outcome: 'applied' }
        )
        const updated = (await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        }))!
        assert.equal(updated.name, 'renamed')
        assert.deepStrictEqual(updated.created, stamp)
      })

      it('records the creating stamp on a local create', async () => {
        const { metadata, validator } = await backend.writeCollection({
          spaceId,
          collectionId: 'local',
          collectionMetadata: {
            id: 'local',
            name: 'local'
          } as CollectionMetadata
        })
        assert.deepStrictEqual(metadata.created, validator.stamp)
        const updated = await backend.writeCollection({
          spaceId,
          collectionId: 'local',
          collectionMetadata: {
            id: 'local',
            name: 'again'
          } as CollectionMetadata
        })
        assert.deepStrictEqual(updated.metadata.created, validator.stamp)
        assert.deepStrictEqual(
          (await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'local'
          }))!.created,
          validator.stamp
        )
      })

      it('stalls an update that forks an immutable member', async () => {
        const stamp = peerStamp(-1000)
        await backend.applyCollection({
          spaceId,
          replicaId,
          collectionId: 'notes',
          collection: {
            deleted: false,
            generation: 'genPeerA',
            metadata: peerCollection({
              stamp,
              revisions: { immutable: true }
            })
          }
        })
        assert.partialDeepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: {
              deleted: false,
              generation: 'genPeerA',
              metadata: peerCollection({
                stamp: peerStamp(-500),
                created: stamp,
                revisions: { immutable: false }
              })
            }
          }),
          { outcome: 'refused', reason: 'fork' }
        )
      })

      it('deletes a Collection on a tombstone and skips its members afterward', async () => {
        await applyNotes({ stamp: peerStamp(-3000) })
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId: 'notes',
          resourceId: 'doc',
          generation: 'genDoc',
          stamp: peerStamp(-100),
          resource: {
            deleted: false,
            input: { kind: 'json', contentType: 'application/json', data: {} }
          }
        })
        // A tombstone older than the Collection's creating stamp loses.
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: { deleted: true, stamp: peerStamp(-4000) }
          }),
          { outcome: 'skipped' }
        )
        // One after it wins, although the member's stamp is newer still.
        const deletedAt = peerStamp(-2000)
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: { deleted: true, stamp: deletedAt }
          }),
          { outcome: 'applied' }
        )
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'notes'
          }),
          undefined
        )
        const listing = await backend.listCollections({
          spaceId,
          includeDeleted: true
        })
        assert.partialDeepStrictEqual(listing.items, [
          { id: 'notes', deleted: true, ...deletedAt }
        ])
        assert.equal((await backend.reportUsage({ spaceId })).usageBytes, 0)
        assert.deepStrictEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId: 'notes',
            resourceId: 'doc',
            generation: 'genDoc',
            stamp: peerStamp(-50),
            resource: {
              deleted: false,
              input: { kind: 'json', contentType: 'application/json', data: {} }
            }
          }),
          { outcome: 'skipped' }
        )
        // A life created before the tombstone stays deleted; one created
        // after it is created.
        assert.deepStrictEqual(await applyNotes({ stamp: peerStamp(-3000) }), {
          outcome: 'skipped'
        })
        assert.deepStrictEqual(
          await applyNotes({ generation: 'genPeerB', stamp: peerStamp(-1000) }),
          { outcome: 'applied' }
        )
        // A tombstone for an id never held is stored.
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'never',
            collection: { deleted: true, stamp: peerStamp(-10) }
          }),
          { outcome: 'applied' }
        )
      })

      it('replaces one life of a Collection with a later one', async () => {
        await applyNotes({ generation: 'genPeerA', stamp: peerStamp(-3000) })
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId: 'notes',
          resourceId: 'doc',
          generation: 'genDoc',
          stamp: peerStamp(-2500),
          resource: {
            deleted: false,
            input: { kind: 'json', contentType: 'application/json', data: {} }
          }
        })
        const before = await backend.changesSince({
          spaceId,
          collectionId: 'notes',
          limit: 10
        })
        // An earlier life loses.
        assert.deepStrictEqual(
          await applyNotes({ generation: 'genOld', stamp: peerStamp(-9000) }),
          { outcome: 'skipped' }
        )
        assert.deepStrictEqual(
          await applyNotes({ generation: 'genPeerB', stamp: peerStamp(-2000) }),
          { outcome: 'applied' }
        )
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        }))!
        assert.equal(stored.metaGeneration, 'genPeerB')
        assert.equal(
          await backend.getResourceMetadata({
            spaceId,
            collectionId: 'notes',
            resourceId: 'doc'
          }),
          undefined
        )
        const after = await backend.changesSince({
          spaceId,
          collectionId: 'notes',
          limit: 10
        })
        assert.notEqual(after.feedGeneration, before.feedGeneration)
        assert.deepStrictEqual(
          after.documents.map(document => document.kind),
          ['collection-metadata']
        )
      })

      describe('Resources', () => {
        const target = { spaceId, replicaId, collectionId: 'notes' }
        const at = { spaceId, collectionId: 'notes', resourceId: 'doc' }

        beforeEach(async () => {
          await applyNotes({ stamp: peerStamp(-9000) })
        })

        function applyDoc({
          stamp,
          data
        }: {
          stamp: WriteStamp
          data: unknown
        }) {
          return backend.applyResource({
            ...target,
            resourceId: 'doc',
            generation: 'genDoc',
            stamp,
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: [controller],
            writerId: 'writer-a',
            resource: {
              deleted: false,
              epoch: 'epoch-1',
              input: { kind: 'json', contentType: 'application/json', data }
            }
          })
        }

        it('stores the received bytes under the received validator', async () => {
          const stamp = peerStamp(-1000, 3)
          assert.deepStrictEqual(await applyDoc({ stamp, data: { a: 1 } }), {
            outcome: 'applied'
          })
          const read = await backend.getResource(at)
          assert.equal(await streamText(read.resourceStream), '{"a":1}')
          assert.equal(
            formatEtag({ generation: read.generation!, stamp }),
            formatEtag({ generation: 'genDoc', stamp })
          )
          assert.partialDeepStrictEqual(read, stamp)
          assert.partialDeepStrictEqual(await backend.getResourceMetadata(at), {
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: [controller],
            epoch: 'epoch-1',
            writerId: 'writer-a',
            ...stamp
          })
          assert.equal((await backend.reportUsage({ spaceId })).usageBytes, 7)
          const feed = await backend.changesSince({
            ...at,
            limit: 10
          })
          assert.partialDeepStrictEqual(feed.documents.at(-1), {
            kind: 'resource',
            resourceId: 'doc',
            data: { a: 1 },
            ...stamp
          })
        })

        it('applies a greater stamp and skips an equal or lower one', async () => {
          await applyDoc({ stamp: peerStamp(-1000), data: { a: 1 } })
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-1000), data: { a: 2 } }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-2000), data: { a: 2 } }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-1000, 1), data: { a: 3 } }),
            { outcome: 'applied' }
          )
          assert.equal(
            await streamText((await backend.getResource(at)).resourceStream),
            '{"a":3}'
          )
          // A local write over the applied record sorts above it.
          const local = await backend.writeResource({
            ...at,
            input: {
              kind: 'json',
              contentType: 'application/json',
              data: { local: true }
            }
          })
          assert.equal(local.validator.generation, 'genDoc')
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-500), data: { a: 4 } }),
            { outcome: 'skipped' }
          )
        })

        it('applies a tombstone, then a later re-create', async () => {
          await applyDoc({ stamp: peerStamp(-1000), data: { a: 1 } })
          await backend.applyResourceMetadata({
            ...target,
            resourceId: 'doc',
            meta: { ...peerStamp(-900), generation: 'genMeta' },
            custom: { name: 'Doc' }
          })
          const deletedAt = peerStamp(-800)
          assert.deepStrictEqual(
            await backend.applyResource({
              ...target,
              resourceId: 'doc',
              generation: 'genDoc',
              stamp: deletedAt,
              writerId: 'writer-b',
              resource: { deleted: true, contentType: 'application/json' }
            }),
            { outcome: 'applied' }
          )
          assert.equal(await backend.getResourceMetadata(at), undefined)
          assert.equal((await backend.reportUsage({ spaceId })).usageBytes, 0)
          const feed = await backend.changesSince({ ...at, limit: 10 })
          assert.partialDeepStrictEqual(feed.documents.at(-1), {
            kind: 'resource',
            resourceId: 'doc',
            deleted: true,
            writerId: 'writer-b',
            createdBy: [controller],
            ...deletedAt
          })
          // A `/meta` stamped after the tombstone is skipped while it holds.
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'doc',
              meta: { ...peerStamp(-700), generation: 'genMeta' },
              custom: { name: 'Late' }
            }),
            { outcome: 'skipped' }
          )
          // A write stamped before the delete loses to it.
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-850), data: { a: 2 } }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-600), data: { a: 5 } }),
            { outcome: 'applied' }
          )
          const recreated = (await backend.getResourceMetadata(at))!
          assert.equal(recreated.meta, undefined)
          assert.equal(recreated.custom, undefined)
        })

        it('applies a tombstone for a Resource never held', async () => {
          assert.deepStrictEqual(
            await backend.applyResource({
              ...target,
              resourceId: 'gone',
              generation: 'genGone',
              stamp: peerStamp(-800),
              resource: { deleted: true, contentType: 'text/plain' }
            }),
            { outcome: 'applied' }
          )
          const feed = await backend.changesSince({ ...at, limit: 10 })
          assert.partialDeepStrictEqual(feed.documents.at(-1), {
            kind: 'resource',
            resourceId: 'gone',
            deleted: true,
            contentType: 'text/plain'
          })
        })

        it('applies /meta on its own stamp and keeps it across a content apply', async () => {
          await applyDoc({ stamp: peerStamp(-1000), data: { a: 1 } })
          const meta = { ...peerStamp(-900), generation: 'genMeta' }
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'doc',
              meta,
              custom: { name: 'Doc' }
            }),
            { outcome: 'applied' }
          )
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'doc',
              meta: { ...peerStamp(-950), generation: 'genMeta' },
              custom: { name: 'Older' }
            }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'absent',
              meta
            }),
            { outcome: 'skipped' }
          )
          await applyDoc({ stamp: peerStamp(-500), data: { a: 2 } })
          const stored = (await backend.getResourceMetadata(at))!
          assert.deepStrictEqual(stored.meta, meta)
          assert.deepStrictEqual(stored.custom, { name: 'Doc' })
          assert.partialDeepStrictEqual(stored, peerStamp(-500))
        })

        it('fast-forwards a did.jsonl and refuses a fork', async () => {
          const applyLog = (text: string, stamp: WriteStamp) =>
            backend.applyResource({
              ...target,
              resourceId: 'did.jsonl',
              generation: 'genLog',
              stamp,
              resource: {
                deleted: false,
                input: {
                  kind: 'binary',
                  contentType: 'text/jsonl',
                  stream: Readable.from(Buffer.from(text))
                }
              }
            })
          assert.deepStrictEqual(await applyLog('{"v":1}\n', peerStamp(-900)), {
            outcome: 'applied'
          })
          assert.deepStrictEqual(
            await applyLog('{"v":1}\n{"v":2}\n', peerStamp(-800)),
            { outcome: 'applied' }
          )
          // A prefix is a no-op whatever its stamp.
          assert.deepStrictEqual(await applyLog('{"v":1}\n', peerStamp(-100)), {
            outcome: 'skipped'
          })
          assert.partialDeepStrictEqual(
            await applyLog('{"v":1}\n{"x":2}\n', peerStamp(-50)),
            { outcome: 'refused', reason: 'fork' }
          )
          assert.equal(
            await streamText(
              (
                await backend.getResource({
                  ...at,
                  resourceId: 'did.jsonl'
                })
              ).resourceStream
            ),
            '{"v":1}\n{"v":2}\n'
          )
        })

        it('applies a policy and its tombstone at each level', async () => {
          const policy = { type: 'PublicCanRead' } as never
          for (const level of [
            {},
            { collectionId: 'notes' },
            { collectionId: 'notes', resourceId: 'doc' }
          ]) {
            const stamp = peerStamp(-900)
            assert.deepStrictEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'genPolicy',
                stamp,
                policy
              }),
              { outcome: 'applied' }
            )
            const stored = (await backend.getPolicyRecord({
              spaceId,
              ...level
            }))!
            assert.deepStrictEqual(stored.validator, {
              generation: 'genPolicy',
              stamp
            })
            assert.deepStrictEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'genPolicy',
                stamp: peerStamp(-950)
              }),
              { outcome: 'skipped' }
            )
            assert.deepStrictEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'genPolicy',
                stamp: peerStamp(-800)
              }),
              { outcome: 'applied' }
            )
            assert.equal(
              await backend.getPolicy({ spaceId, ...level }),
              undefined
            )
            assert.equal(
              (await backend.getPolicyRecord({ spaceId, ...level }))!.deleted,
              true
            )
          }
          assert.deepStrictEqual(
            await backend.applyPolicy({
              spaceId,
              replicaId,
              collectionId: 'absent',
              generation: 'genPolicy',
              stamp: peerStamp(-700),
              policy
            }),
            { outcome: 'skipped' }
          )
        })

        it('fast-forwards the governing history log', async () => {
          const applyLog = (body: string, stamp: WriteStamp) =>
            backend.applyCollectionLog({
              ...target,
              body,
              generation: 'genGovLog',
              stamp
            })
          const before = (await backend.getCollectionMetadata(at))!
          const stamp = peerStamp(-900)
          assert.deepStrictEqual(await applyLog('{"state":{}}\n', stamp), {
            outcome: 'applied'
          })
          assert.deepStrictEqual(await backend.getCollectionLog(at), {
            body: '{"state":{}}\n',
            validator: { generation: 'genGovLog', stamp }
          })
          const after = (await backend.getCollectionMetadata(at))!
          assert.equal(after.metaLocal, before.metaLocal! + 1)
          assert.equal(after.updatedAt, before.updatedAt)
          assert.deepStrictEqual(
            await applyLog('{"state":{}}\n', peerStamp(-100)),
            {
              outcome: 'skipped'
            }
          )
          assert.partialDeepStrictEqual(
            await applyLog('{"state":{"x":1}}\n', peerStamp(-100)),
            { outcome: 'refused', reason: 'fork' }
          )
          assert.deepStrictEqual(
            await applyLog(
              '{"state":{}}\n{"state":{"x":1}}\n',
              peerStamp(-100)
            ),
            { outcome: 'applied' }
          )
          const feed = await backend.changesSince({ ...at, limit: 10 })
          assert.equal(feed.documents.at(-1)!.kind, 'log')
        })
      })

      describe('chunks', () => {
        const at = { spaceId, collectionId: 'notes', resourceId: 'doc' }
        const runA = { replicaId, parentEtag: '"genDoc.a"' }
        const runB = { replicaId, parentEtag: '"genDoc.b"' }

        beforeEach(async () => {
          await applyNotes({ stamp: peerStamp(-9000) })
        })

        function stage({
          index,
          text,
          run = runA,
          resourceId = 'doc'
        }: {
          index: number
          text: string
          run?: { replicaId: string; parentEtag: string }
          resourceId?: string
        }) {
          return backend.stageChunk({
            ...at,
            replicaId,
            resourceId,
            run,
            chunkIndex: index,
            input: binaryInput(text),
            peerEtag: `"peer-${index}-${text}"`
          })
        }

        function swap({
          stamp,
          envelope,
          run = runA,
          staged = []
        }: {
          stamp: WriteStamp
          envelope: string
          run?: { replicaId: string; parentEtag: string }
          staged?: number[]
        }) {
          return backend.applyResource({
            ...at,
            replicaId,
            generation: 'genDoc',
            stamp,
            createdAt: '2026-10-01T00:00:00.000Z',
            resource: { deleted: false, input: binaryInput(envelope) },
            chunks: { run, staged }
          })
        }

        function begin({
          run = runA,
          listed,
          resourceId = 'doc',
          collectionId = 'notes',
          replicaId: under = replicaId
        }: {
          run?: { replicaId: string; parentEtag: string }
          listed: Array<{ index: number; size: number }>
          resourceId?: string
          collectionId?: string
          replicaId?: string
        }) {
          return backend.beginChunkStaging({
            spaceId,
            replicaId: under,
            collectionId,
            resourceId,
            run,
            listed
          })
        }

        async function chunkTexts(): Promise<Record<number, string>> {
          const listing = await backend.listChunks(at)
          const texts: Record<number, string> = {}
          for (const { index } of listing.chunks) {
            const chunk = await backend.getChunk({ ...at, chunkIndex: index })
            texts[index] = await streamText(chunk.resourceStream)
          }
          return texts
        }

        async function usage(): Promise<number> {
          return (await backend.reportUsage({ spaceId })).usageBytes
        }

        it('migrates the staging table and the pullsChunks column', async () => {
          await postgresAdminQuery(
            `SELECT replica_id, parent_etag, peer_etag
               FROM "${schema}".chunk_staging`
          )
          const { rows } = await postgresAdminQuery(
            `SELECT pulls_chunks FROM "${schema}".replicas`
          )
          assert.deepStrictEqual(rows, [{ pulls_chunks: false }])
          const stored = await backend.createReplica({
            spaceId,
            record: { ...registration, id: 'with-chunks' },
            pullsChunks: true
          })
          assert.equal(stored.pullsChunks, true)
          assert.deepStrictEqual(
            await backend.getReplica({ spaceId, replicaId: 'with-chunks' }),
            stored
          )
        })

        it('swaps a staged set in with its parent, removing the live chunks it does not list', async () => {
          for (const [index, text] of ['aa', 'bbb', 'cccc'].entries()) {
            assert.deepStrictEqual(await stage({ index, text }), {
              outcome: 'applied'
            })
          }
          // Staged chunks are served by nothing, and the parent is not held.
          assert.deepStrictEqual(await backend.listChunks(at), {
            count: 0,
            chunks: []
          })
          assert.equal(await backend.getResourceMetadata(at), undefined)
          assert.equal(await usage(), 9)

          const first = peerStamp(-1000)
          assert.deepStrictEqual(
            await swap({ stamp: first, envelope: 'env1', staged: [0, 1, 2] }),
            { outcome: 'applied' }
          )
          assert.deepStrictEqual(await chunkTexts(), {
            0: 'aa',
            1: 'bbb',
            2: 'cccc'
          })
          assert.partialDeepStrictEqual(
            await backend.getResourceMetadata(at),
            first
          )
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runA }),
            []
          )
          assert.equal(await usage(), 4 + 9)
          const first0 = (await backend.getChunkMetadata({
            ...at,
            chunkIndex: 0
          }))!
          const first1 = (await backend.getChunkMetadata({
            ...at,
            chunkIndex: 1
          }))!
          // Each chunk is a local record under this store's clock.
          for (const chunk of [first0, first1]) {
            assert.equal(chunk.originId, backend.originId)
            assert.notEqual(chunk.generation, 'genDoc')
          }

          // The next revision lists 0 again, replaces 1, adds 3 and drops 2.
          // Every listed chunk is staged, since a live chunk's validator is
          // this server's own.
          await stage({ index: 0, text: 'aa', run: runB })
          await stage({ index: 1, text: 'BBBBB', run: runB })
          await stage({ index: 3, text: 'd', run: runB })
          // Nothing live moved before the swap.
          assert.deepStrictEqual(await chunkTexts(), {
            0: 'aa',
            1: 'bbb',
            2: 'cccc'
          })
          assert.equal(await usage(), 4 + 9 + 8)
          assert.deepStrictEqual(
            await swap({
              stamp: peerStamp(-500),
              envelope: 'env-2',
              run: runB,
              staged: [0, 1, 3]
            }),
            { outcome: 'applied' }
          )
          assert.deepStrictEqual(await chunkTexts(), {
            0: 'aa',
            1: 'BBBBB',
            3: 'd'
          })
          assert.equal(
            await streamText((await backend.getResource(at)).resourceStream),
            'env-2'
          )
          assert.equal(await usage(), 5 + 2 + 5 + 1)
          for (const [index, before] of [first0, first1].entries()) {
            const rewritten = (await backend.getChunkMetadata({
              ...at,
              chunkIndex: index
            }))!
            assert.equal(rewritten.originId, backend.originId)
            assert.notEqual(rewritten.generation, before.generation)
          }
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runB }),
            []
          )
        })

        it('releases the staging on a loss', async () => {
          await stage({ index: 0, text: 'new' })
          await swap({ stamp: peerStamp(-500), envelope: 'env', staged: [0] })
          await stage({ index: 0, text: 'old', run: runB })
          assert.equal(await usage(), 3 + 3 + 3)
          assert.deepStrictEqual(
            await swap({
              stamp: peerStamp(-1000),
              envelope: 'old',
              run: runB,
              staged: [0]
            }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runB }),
            []
          )
          assert.deepStrictEqual(await chunkTexts(), { 0: 'new' })
          assert.equal(await usage(), 3 + 3)
        })

        it('refuses a set that does not match the staging', async () => {
          await stage({ index: 0, text: 'aa' })
          assert.partialDeepStrictEqual(
            await swap({ stamp: peerStamp(-1000), envelope: 'e', staged: [1] }),
            { outcome: 'refused', reason: 'container-refused' }
          )
          assert.partialDeepStrictEqual(
            await swap({
              stamp: peerStamp(-1000),
              envelope: 'e',
              staged: [0, 0]
            }),
            { outcome: 'refused', reason: 'container-refused' }
          )
          assert.equal(await backend.getResourceMetadata(at), undefined)
          // The refusal releases the staging, as a loss does.
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runA }),
            []
          )
          assert.equal(await usage(), 0)
        })

        it('lists staged chunks with their peer ETags, a restage replacing one', async () => {
          await stage({ index: 2, text: 'cc' })
          await stage({ index: 0, text: 'a' })
          await stage({ index: 0, text: 'AAAA' })
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runA }),
            [
              { index: 0, size: 4, peerEtag: '"peer-0-AAAA"' },
              { index: 2, size: 2, peerEtag: '"peer-2-cc"' }
            ]
          )
          assert.equal(await usage(), 6)
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runB }),
            []
          )
          // Opening a run of a later revision drops the registration's
          // earlier one; staging alone does not.
          await stage({ index: 0, text: 'z', run: runB })
          assert.equal(
            (await backend.listStagedChunks({ ...at, run: runA })).length,
            2
          )
          assert.deepStrictEqual(
            await begin({ run: runB, listed: [{ index: 0, size: 1 }] }),
            { staged: [{ index: 0, size: 1, peerEtag: '"peer-0-z"' }] }
          )
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runA }),
            []
          )
          assert.equal(await usage(), 1)
        })

        it('opens a run under the registration and a live Collection only, and checks the quota', async () => {
          assert.deepStrictEqual(
            await begin({ listed: [], replicaId: 'unknown' }),
            { outcome: 'unregistered' }
          )
          assert.deepStrictEqual(
            await begin({ listed: [], collectionId: 'absent' }),
            { outcome: 'skipped' }
          )
          // A chunk over the upload cap.
          const cap = backend.maxUploadBytes
          backend.maxUploadBytes = 4
          assert.partialDeepStrictEqual(
            await begin({ listed: [{ index: 0, size: 5 }] }),
            { outcome: 'refused', reason: 'quota-exceeded' }
          )
          backend.maxUploadBytes = cap
          // 20 bytes held, a quota of 30: a 10-byte set fits and an 11-byte
          // one does not. The check is net of what the run staged already
          // and of the live set the swap frees.
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId: 'notes',
            resourceId: 'filler',
            generation: 'genFiller',
            stamp: peerStamp(-2000),
            resource: { deleted: false, input: binaryInput('f'.repeat(20)) }
          })
          backend.capacityBytes = 30
          const ten = [
            { index: 0, size: 4 },
            { index: 1, size: 6 }
          ]
          assert.deepStrictEqual(await begin({ listed: ten }), { staged: [] })
          assert.partialDeepStrictEqual(
            await begin({ listed: [...ten, { index: 2, size: 1 }] }),
            { outcome: 'refused', reason: 'quota-exceeded' }
          )
          await stage({ index: 0, text: 'aaaa' })
          assert.deepStrictEqual(await begin({ listed: ten }), {
            staged: [{ index: 0, size: 4, peerEtag: '"peer-0-aaaa"' }]
          })
          await stage({ index: 1, text: 'bbbbbb' })
          await swap({ stamp: peerStamp(-1000), envelope: '', staged: [0, 1] })
          assert.equal(await usage(), 30)
          // The live set of 10 bytes frees under the swap, so a set of 10
          // fits again under the full quota and a set of 11 does not.
          assert.deepStrictEqual(await begin({ run: runB, listed: ten }), {
            staged: []
          })
          assert.partialDeepStrictEqual(
            await begin({
              run: runB,
              listed: [...ten, { index: 2, size: 1 }]
            }),
            { outcome: 'refused', reason: 'quota-exceeded' }
          )
        })

        it('answers unregistered and skipped without staging', async () => {
          assert.deepStrictEqual(
            await backend.stageChunk({
              ...at,
              replicaId: 'unknown',
              run: runA,
              chunkIndex: 0,
              input: binaryInput('x'),
              peerEtag: '"x"'
            }),
            { outcome: 'unregistered' }
          )
          assert.deepStrictEqual(
            await backend.stageChunk({
              ...at,
              collectionId: 'absent',
              replicaId,
              run: runA,
              chunkIndex: 0,
              input: binaryInput('x'),
              peerEtag: '"x"'
            }),
            { outcome: 'skipped' }
          )
          assert.equal(await usage(), 0)
        })

        it('reclaims staging by registration and by Resource', async () => {
          await stage({ index: 0, text: 'aa' })
          await stage({ index: 1, text: 'bb' })
          await stage({ index: 0, text: 'ccc', resourceId: 'other' })
          assert.equal(await usage(), 7)
          assert.equal(await backend.reclaimStaging({ spaceId, replicaId }), 2)
          assert.equal(await usage(), 0)
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runA }),
            []
          )

          await stage({ index: 0, text: 'aa' })
          await stage({ index: 0, text: 'ccc', resourceId: 'other' })
          assert.equal(
            await backend.reclaimStaging({
              spaceId,
              collectionId: 'notes',
              resourceId: 'doc'
            }),
            1
          )
          assert.equal(await usage(), 3)
          assert.equal(
            (
              await backend.listStagedChunks({
                ...at,
                resourceId: 'other',
                run: runA
              })
            ).length,
            1
          )
          assert.equal(await backend.reclaimStaging({ spaceId }), 1)
          assert.equal(await backend.reclaimStaging({ spaceId }), 0)
          assert.equal(await usage(), 0)
        })

        it('counts staged bytes toward usage and fits a same-size rewrite under a full quota', async () => {
          // 20 bytes elsewhere, and a 50-byte stream of two chunks under a
          // 0-byte envelope: 70 bytes held, a quota of 70.
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId: 'notes',
            resourceId: 'filler',
            generation: 'genFiller',
            stamp: peerStamp(-2000),
            resource: { deleted: false, input: binaryInput('f'.repeat(20)) }
          })
          await stage({ index: 0, text: 'a'.repeat(25) })
          await stage({ index: 1, text: 'b'.repeat(25) })
          await swap({ stamp: peerStamp(-1000), envelope: '', staged: [0, 1] })
          assert.equal(await usage(), 70)
          backend.capacityBytes = 70

          // A new index has no live chunk to credit.
          await assert.rejects(
            stage({ index: 2, text: 'c', run: runB }),
            QuotaExceededError
          )
          assert.equal(await usage(), 70)
          await stage({ index: 0, text: 'A'.repeat(25), run: runB })
          await stage({ index: 1, text: 'B'.repeat(25), run: runB })
          assert.equal(await usage(), 120)
          assert.deepStrictEqual(
            await swap({
              stamp: peerStamp(-500),
              envelope: '',
              run: runB,
              staged: [0, 1]
            }),
            { outcome: 'applied' }
          )
          assert.equal(await usage(), 70)
          assert.deepStrictEqual(await chunkTexts(), {
            0: 'A'.repeat(25),
            1: 'B'.repeat(25)
          })
        })

        it('removes the chunks and the staging on a tombstone', async () => {
          await stage({ index: 0, text: 'aa' })
          await swap({ stamp: peerStamp(-1000), envelope: 'env', staged: [0] })
          await stage({ index: 0, text: 'bbb', run: runB })
          assert.deepStrictEqual(
            await backend.applyResource({
              ...at,
              replicaId,
              generation: 'genDoc',
              stamp: peerStamp(-500),
              resource: {
                deleted: true,
                contentType: 'application/octet-stream'
              }
            }),
            { outcome: 'applied' }
          )
          assert.deepStrictEqual(await backend.listChunks(at), {
            count: 0,
            chunks: []
          })
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runB }),
            []
          )
          assert.equal(await usage(), 0)
        })

        it('removes the staging on Delete Resource and Delete Collection', async () => {
          await stage({ index: 0, text: 'aa' })
          await swap({ stamp: peerStamp(-1000), envelope: 'env', staged: [0] })
          await stage({ index: 0, text: 'bbb', run: runB })
          await backend.deleteResource(at)
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runB }),
            []
          )
          assert.equal(await usage(), 0)

          await stage({ index: 0, text: 'cccc', resourceId: 'fresh' })
          assert.equal(await usage(), 4)
          await backend.deleteCollection({ spaceId, collectionId: 'notes' })
          assert.equal(await usage(), 0)
          const { rows } = await postgresAdminQuery(
            `SELECT COUNT(*)::int AS count FROM "${schema}".chunk_staging`
          )
          assert.equal(rows[0].count, 0)
        })

        it('takes no feed position for a staged chunk', async () => {
          const before = await backend.changesSince({ ...at, limit: 10 })
          await stage({ index: 0, text: 'aa' })
          const staged = await backend.changesSince({ ...at, limit: 10 })
          assert.deepStrictEqual(staged, before)
          await swap({ stamp: peerStamp(-1000), envelope: 'env', staged: [0] })
          const after = await backend.changesSince({ ...at, limit: 10 })
          assert.equal(after.documents.length, before.documents.length + 1)
          assert.partialDeepStrictEqual(after.documents.at(-1), {
            kind: 'resource',
            resourceId: 'doc'
          })
        })

        it('reclaims every staging row at open', async () => {
          await stage({ index: 0, text: 'aa' })
          await stage({ index: 0, text: 'bbb', resourceId: 'other' })
          assert.equal(await usage(), 5)
          await backend.close()
          ;({ backend } = await openTempPostgres({
            schema,
            physicalClock: () => NOW
          }))
          assert.equal(await usage(), 0)
          assert.deepStrictEqual(
            await backend.listStagedChunks({ ...at, run: runA }),
            []
          )
        })
      })
    })
  })
}
