/**
 * Two server backends in one process: a filesystem data dir as the default
 * and a Postgres schema beside it, selectable per Collection. Covers the
 * backends listing (`default` alias, `fs`, `postgres`), routing of a
 * Collection's Resources, listing and `changes` feed to the backend its
 * `backend.id` selects, the copy of the Space and Collection Metadata objects
 * that backend keeps (and the `unique` index declaration it enforces from
 * it), the per-backend quota report, the policy and log copies that give the
 * `changes` feed served there one position sequence under the control plane's
 * validators, the delete cascades, Export and Import of a Space spanning
 * both, the refusal of an archive naming a backend a
 * server does not configure, and a deployment whose default is Postgres.
 *
 * OPT-IN: requires a disposable Postgres reachable via `WAS_TEST_DATABASE_URL`
 * (the README's "Storage Backends" section has a one-liner); skipped with a
 * visible notice when unset. Each server runs in a throwaway `was_test_<hex>`
 * schema, dropped on cleanup.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'

import type { PostgresBackend } from '../src/backends/postgres.js'
import { ResourceImmutableError, StorageError } from '../src/errors.js'
import { extractTarEntries } from '../src/lib/importTar.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import type { CollectionMetadata, ReplicaRegistration } from '../src/types.js'
import {
  entryLine,
  genesisLine,
  oneEpoch,
  openTempBackend,
  openTempPostgres,
  twoEpochs,
  requestError,
  startTestServer,
  zcapClients
} from './helpers.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

const FS_DESCRIPTOR = {
  id: 'fs',
  name: 'Server Filesystem',
  managedBy: 'server',
  persistence: 'durable'
}
const POSTGRES_DESCRIPTOR = {
  id: 'postgres',
  name: 'Server PostgreSQL',
  managedBy: 'server',
  persistence: 'durable'
}

describe.skipIf(!connectionString)(
  'Two server backends, selectable per Collection',
  () => {
    let fastify: FastifyInstance,
      fsBackend: TempFileSystemBackend,
      pgBackend: PostgresBackend,
      dropSchema: () => Promise<void>,
      baseServerUrl: string,
      alice: any

    beforeAll(async () => {
      fsBackend = await openTempBackend({ prefix: 'was-test-mixed-fs-' })
      ;({ backend: pgBackend, dropSchema } = await openTempPostgres({
        originId: fsBackend.originId
      }))
      // The filesystem backend is both the default and the control plane
      // here, so Postgres is the other backend throughout.
      ;({ fastify, baseServerUrl } = await startTestServer({
        backends: [fsBackend, pgBackend],
        controlPlaneBackend: 'fs'
      }))
      ;({ alice } = await zcapClients({ baseServerUrl }))
    })
    afterAll(async () => {
      await fastify.close()
      await dropSchema()
    })

    function url(relativePath: string): string {
      return new URL(relativePath, baseServerUrl).toString()
    }

    async function freshSpace(name: string): Promise<string> {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({ id: spaceId, name, controller: alice.did })
      return spaceId
    }

    async function createCollection(
      spaceId: string,
      collectionId: string,
      body: Record<string, unknown> = {}
    ) {
      return alice.pws.request({
        url: url(`/space/${spaceId}/${collectionId}/meta`),
        method: 'PUT',
        json: { id: collectionId, ...body }
      })
    }

    async function putResource(
      spaceId: string,
      collectionId: string,
      resourceId: string,
      json: unknown
    ) {
      return alice.pws.request({
        url: url(`/space/${spaceId}/${collectionId}/${resourceId}`),
        method: 'PUT',
        json
      })
    }

    // A `PublicCanRead` policy at the level `policyPath` names
    // (`/space/<s>/<c>/policy` or `/space/<s>/<c>/<r>/policy`).
    async function putPublicRead(policyPath: string) {
      const written = await alice.pws.request({
        url: url(policyPath),
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      assert.equal(written.status, 201)
      return written
    }

    /**
     * Whether a backend holds a live Resource, read through its own API.
     */
    async function holds(
      backend: { getResource: (typeof fsBackend)['getResource'] },
      spaceId: string,
      collectionId: string,
      resourceId: string
    ): Promise<boolean> {
      try {
        await backend.getResource({ spaceId, collectionId, resourceId })
        return true
      } catch {
        return false
      }
    }

    it('lists the default alias and both server backends in every Space', async () => {
      const spaceId = await freshSpace('Listing Space')
      const response = await alice.pws.request({
        url: url(`/space/${spaceId}/backends`),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, [
        { ...FS_DESCRIPTOR, id: 'default' },
        FS_DESCRIPTOR,
        POSTGRES_DESCRIPTOR
      ])
      // The served Space Metadata object carries the same listing.
      const meta = await alice.pws.request({
        url: url(`/space/${spaceId}/meta`),
        method: 'GET'
      })
      assert.deepStrictEqual(meta.data.backends, response.data)
    })

    it('serves a Collection selecting `postgres` from the Postgres backend, and `default` from the filesystem', async () => {
      const spaceId = await freshSpace('Routing Space')
      const created = await createCollection(spaceId, 'pg-notes', {
        backend: { id: 'postgres' }
      })
      assert.equal(created.status, 201)
      // The selection is stored as sent.
      assert.deepStrictEqual(created.data.backend, { id: 'postgres' })
      await createCollection(spaceId, 'fs-notes')

      const put = await putResource(spaceId, 'pg-notes', 'r1', { on: 'pg' })
      assert.equal(put.status, 201)
      await putResource(spaceId, 'fs-notes', 'r2', { on: 'fs' })

      assert.equal(await holds(pgBackend, spaceId, 'pg-notes', 'r1'), true)
      assert.equal(await holds(fsBackend, spaceId, 'pg-notes', 'r1'), false)
      assert.equal(await holds(fsBackend, spaceId, 'fs-notes', 'r2'), true)
      assert.equal(await holds(pgBackend, spaceId, 'fs-notes', 'r2'), false)

      // The read, the listing and the changes feed resolve the same way.
      const read = await alice.pws.request({
        url: url(`/space/${spaceId}/pg-notes/r1`),
        method: 'GET'
      })
      assert.deepStrictEqual(read.data, { on: 'pg' })
      const listing = await alice.pws.request({
        url: url(`/space/${spaceId}/pg-notes/`),
        method: 'GET'
      })
      assert.equal(listing.data.totalItems, 1)
      const feed = await alice.pws.request({
        url: url(`/space/${spaceId}/pg-notes/query`),
        method: 'POST',
        json: { profile: 'changes' }
      })
      assert.equal(feed.status, 200)
      const resourceDocuments = feed.data.documents.filter(
        (document: { kind: string }) => document.kind === 'resource'
      )
      assert.equal(resourceDocuments.length, 1)

      // `GET .../backend` resolves the selection to the Postgres descriptor,
      // and the `default` selection to the alias entry.
      const selected = await alice.pws.request({
        url: url(`/space/${spaceId}/pg-notes/backend`),
        method: 'GET'
      })
      assert.deepStrictEqual(selected.data, POSTGRES_DESCRIPTOR)
      const defaulted = await alice.pws.request({
        url: url(`/space/${spaceId}/fs-notes/backend`),
        method: 'GET'
      })
      assert.deepStrictEqual(defaulted.data, {
        ...FS_DESCRIPTOR,
        id: 'default'
      })

      // The Collection Metadata object itself stays on the control plane,
      // with a copy on the backend it selects.
      const held = await pgBackend.getCollectionMetadata({
        spaceId,
        collectionId: 'pg-notes'
      })
      assert.ok(held, 'the Postgres backend holds a copy of the object')
      assert.ok(
        await fsBackend.getCollectionMetadata({
          spaceId,
          collectionId: 'pg-notes'
        }),
        'the control plane holds the object'
      )
    })

    it('an update of the Collection Metadata object reaches the copy, so a `unique` declaration is enforced there', async () => {
      const spaceId = await freshSpace('Unique Space')
      await createCollection(spaceId, 'people', {
        backend: { id: 'postgres' },
        plaintext: { indexes: [{ name: 'email', unique: true }] }
      })
      const first = await putResource(spaceId, 'people', 'p1', {
        email: 'a@example.com'
      })
      assert.equal(first.status, 201)
      const duplicate = await requestError(
        putResource(spaceId, 'people', 'p2', { email: 'a@example.com' })
      )
      assert.equal(duplicate.response.status, 409)

      // A rename reaches the copy as well.
      const renamed = await createCollection(spaceId, 'people', {
        backend: { id: 'postgres' },
        name: 'People (renamed)',
        plaintext: { indexes: [{ name: 'email', unique: true }] }
      })
      assert.equal(renamed.status, 204)
      const copy = await pgBackend.getCollectionMetadata({
        spaceId,
        collectionId: 'people'
      })
      assert.equal(copy?.name, 'People (renamed)')
    })

    it('reports the quota per server backend, and a Collection quota from its own backend', async () => {
      const spaceId = await freshSpace('Quota Space')
      await createCollection(spaceId, 'pg-docs', {
        backend: { id: 'postgres' }
      })
      await putResource(spaceId, 'pg-docs', 'd1', { size: 'some bytes' })

      const report = await alice.pws.request({
        url: url(`/space/${spaceId}/quotas`),
        method: 'GET'
      })
      assert.equal(report.status, 200)
      assert.deepStrictEqual(
        report.data.backends.map((entry: { id: string }) => entry.id),
        ['fs', 'postgres']
      )
      const [fsUsage, pgUsage] = report.data.backends
      assert.ok(pgUsage.usageBytes > 0, 'the Postgres entry measures the write')
      assert.equal(typeof fsUsage.usageBytes, 'number')

      const collectionQuota = await alice.pws.request({
        url: url(`/space/${spaceId}/pg-docs/quota`),
        method: 'GET'
      })
      assert.equal(collectionQuota.data.id, 'postgres')
      assert.ok(collectionQuota.data.usageBytes > 0)
    })

    it('Delete Collection and Delete Space remove the copies', async () => {
      const spaceId = await freshSpace('Delete Space')
      await createCollection(spaceId, 'gone', { backend: { id: 'postgres' } })
      await putResource(spaceId, 'gone', 'g1', { x: 1 })
      await createCollection(spaceId, 'stays', { backend: { id: 'postgres' } })
      await putResource(spaceId, 'stays', 's1', { x: 2 })

      const deleted = await alice.pws.request({
        url: url(`/space/${spaceId}/gone/`),
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)
      assert.equal(await holds(pgBackend, spaceId, 'gone', 'g1'), false)
      assert.equal(await holds(pgBackend, spaceId, 'stays', 's1'), true)

      const spaceDeleted = await alice.pws.request({
        url: url(`/space/${spaceId}/`),
        method: 'DELETE'
      })
      assert.equal(spaceDeleted.status, 204)
      assert.equal(await pgBackend.getSpaceMetadata({ spaceId }), undefined)
      assert.equal(await fsBackend.getSpaceMetadata({ spaceId }), undefined)
    })

    it('exports a Space spanning both backends and imports each Collection onto the backend it names', async () => {
      const sourceId = await freshSpace('Export Source')
      await createCollection(sourceId, 'on-pg', { backend: { id: 'postgres' } })
      await putResource(sourceId, 'on-pg', 'p1', { from: 'pg' })
      await putPublicRead(`/space/${sourceId}/on-pg/policy`)
      await putPublicRead(`/space/${sourceId}/on-pg/p1/policy`)
      await createCollection(sourceId, 'on-fs')
      await putResource(sourceId, 'on-fs', 'f1', { from: 'fs' })

      const exported = await alice.pws.request({
        url: url(`/space/${sourceId}/export`),
        method: 'POST'
      })
      assert.equal(exported.status, 200)
      const tarBytes = Buffer.from(await exported.arrayBuffer())
      const entries = await extractTarEntries(Readable.from(tarBytes))
      const names = [...entries.keys()]
      assert.ok(
        names.some(name => name.includes('/on-pg/r.p1.')),
        `the Postgres Collection's Resource travels: ${names.join(', ')}`
      )
      assert.ok(names.some(name => name.includes('/on-fs/r.f1.')))
      assert.equal(
        names.filter(name =>
          name.endsWith('/on-pg/.collection.meta.on-pg.json')
        ).length,
        1,
        'the Metadata object travels once'
      )

      const destinationId = await freshSpace('Import Destination')
      const imported = await alice.pws.request({
        url: url(`/space/${destinationId}/import`),
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.collectionsCreated, 2)
      assert.equal(imported.data.resourcesCreated, 2)
      assert.equal(await holds(pgBackend, destinationId, 'on-pg', 'p1'), true)
      assert.equal(await holds(fsBackend, destinationId, 'on-pg', 'p1'), false)
      assert.equal(await holds(fsBackend, destinationId, 'on-fs', 'f1'), true)
      const read = await alice.pws.request({
        url: url(`/space/${destinationId}/on-pg/p1`),
        method: 'GET'
      })
      assert.deepStrictEqual(read.data, { from: 'pg' })
      // The imported policies reach the Postgres copy under the control
      // plane's validators, so its feed lists them.
      for (const resourceId of [undefined, 'p1']) {
        const level = {
          spaceId: destinationId,
          collectionId: 'on-pg',
          resourceId
        }
        const [onControl, onPg] = await Promise.all([
          fsBackend.getPolicyRecord(level),
          pgBackend.getPolicyRecord(level)
        ])
        assert.equal(onControl?.deleted, false)
        assert.deepEqual(onPg?.validator, onControl?.validator)
      }

      // A server configuring the filesystem backend alone refuses the
      // archive before writing anything.
      const fsOnly = await openTempBackend({ prefix: 'was-test-fs-only-' })
      const single = await startTestServer({ backend: fsOnly })
      try {
        const { alice: single_alice } = await zcapClients({
          baseServerUrl: single.baseServerUrl
        })
        const lonelyId = crypto.randomUUID()
        await single_alice.pws.createSpace({
          id: lonelyId,
          name: 'No Postgres here',
          controller: single_alice.did
        })
        const refused = await requestError(
          single_alice.pws.request({
            url: new URL(
              `/space/${lonelyId}/import`,
              single.baseServerUrl
            ).toString(),
            method: 'POST',
            body: tarBytes,
            headers: { 'content-type': 'application/x-tar' }
          })
        )
        assert.equal(refused.response.status, 409)
        assert.match(refused.data.type, /#unsupported-backend/)
        assert.equal(
          await fsOnly.getCollectionMetadata({
            spaceId: lonelyId,
            collectionId: 'on-fs'
          }),
          undefined
        )
      } finally {
        await single.fastify.close()
      }
    })

    it('a Collection cannot move between server backends (409 backend-immutable), but may restate its selection', async () => {
      const spaceId = await freshSpace('Fixed Selection Space')
      await createCollection(spaceId, 'fixed', { backend: { id: 'postgres' } })
      await putResource(spaceId, 'fixed', 'f1', { x: 1 })

      const moved = await requestError(
        createCollection(spaceId, 'fixed', { backend: { id: 'default' } })
      )
      assert.equal(moved.response.status, 409)
      assert.match(moved.data.type, /#backend-immutable/)
      assert.equal(moved.data.errors[0].pointer, '#/backend')
      assert.equal(await holds(pgBackend, spaceId, 'fixed', 'f1'), true)

      const restated = await createCollection(spaceId, 'fixed', {
        backend: { id: 'postgres' },
        name: 'Fixed'
      })
      assert.equal(restated.status, 204)

      // `fs` and `default` are one backend here.
      await createCollection(spaceId, 'onfs')
      const aliased = await createCollection(spaceId, 'onfs', {
        backend: { id: 'fs' }
      })
      assert.equal(aliased.status, 204)
      const toPostgres = await requestError(
        createCollection(spaceId, 'onfs', { backend: { id: 'postgres' } })
      )
      assert.equal(toPostgres.response.status, 409)
      assert.match(toPostgres.data.type, /#backend-immutable/)
    })

    it('Update Space refreshes the copy of the Space Metadata object', async () => {
      const spaceId = await freshSpace('Rename Space')
      await createCollection(spaceId, 'pg', { backend: { id: 'postgres' } })
      assert.equal(
        (await pgBackend.getSpaceMetadata({ spaceId }))?.name,
        'Rename Space'
      )
      const renamed = await alice.pws.request({
        url: url(`/space/${spaceId}/meta`),
        method: 'PUT',
        json: { name: 'Renamed', controller: alice.did }
      })
      assert.equal(renamed.status, 204)
      assert.equal(
        (await pgBackend.getSpaceMetadata({ spaceId }))?.name,
        'Renamed'
      )
    })

    it('keeps the copies on a replicated apply, which writes through the control plane', async () => {
      const spaceId = await freshSpace('Replicated Space')
      const replicaId = 'from-peer'
      await fsBackend.createReplica({
        spaceId,
        record: {
          id: replicaId,
          fromSpace: 'https://peer.example/space/peer-space/',
          toSpace: url(`/space/${spaceId}/`),
          capability: { id: 'urn:uuid:pull' },
          role: 'source'
        } as unknown as ReplicaRegistration,
        pullsChunks: false
      })
      const stamp = {
        updatedAt: '2026-10-22T12:00:00.000Z',
        updatedAtCounter: 0,
        originId: 'peer-origin'
      }
      const applied = await fastify.storage.applyCollection({
        spaceId,
        replicaId,
        collectionId: 'pulled',
        collection: {
          deleted: false,
          generation: 'genPeer',
          metadata: {
            id: 'pulled',
            type: ['Collection'],
            backend: { id: 'postgres' },
            createdAt: stamp.updatedAt,
            created: stamp,
            ...stamp
          } as CollectionMetadata
        }
      })
      assert.equal(applied.outcome, 'applied')
      assert.ok(await pgBackend.getSpaceMetadata({ spaceId }))
      const copy = await pgBackend.getCollectionMetadata({
        spaceId,
        collectionId: 'pulled'
      })
      assert.equal(copy?.backend?.id, 'postgres')

      const body =
        genesisLine({ ...oneEpoch, revisions: { immutable: true } }) + '\n'
      const logApplied = await fastify.storage.applyCollectionLog({
        spaceId,
        replicaId,
        collectionId: 'pulled',
        body,
        generation: 'genLog',
        stamp: { ...stamp, updatedAtCounter: 1 }
      })
      assert.equal(logApplied.outcome, 'applied')
      assert.equal(
        (await pgBackend.getCollectionLog({ spaceId, collectionId: 'pulled' }))
          ?.body,
        body
      )

      const removed = await fastify.storage.applyCollection({
        spaceId,
        replicaId,
        collectionId: 'pulled',
        collection: { deleted: true, stamp: { ...stamp, updatedAtCounter: 2 } }
      })
      assert.equal(removed.outcome, 'applied')
      assert.equal(
        await pgBackend.getCollectionMetadata({
          spaceId,
          collectionId: 'pulled'
        }),
        undefined
      )
    })

    it("copies a governing history log to the Collection's backend, where the write-once recheck reads it", async () => {
      const spaceId = await freshSpace('Governed Space')
      await createCollection(spaceId, 'ledger', { backend: { id: 'postgres' } })
      const first = await putResource(spaceId, 'ledger', 'e1', { v: 1 })
      assert.equal(first.status, 201)

      const body =
        genesisLine({ ...oneEpoch, revisions: { immutable: true } }) + '\n'
      const governed = await alice.pws.request({
        url: url(`/space/${spaceId}/ledger/meta/log`),
        method: 'PUT',
        body: new TextEncoder().encode(body),
        headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' }
      })
      assert.equal(governed.status, 204)
      const copy = await pgBackend.getCollectionLog({
        spaceId,
        collectionId: 'ledger'
      })
      assert.equal(copy?.body, body)

      // A write that read the Collection before the log existed hands the
      // backend the recheck; the backend decides it from the copy it reads
      // under its own lock.
      let handed: boolean | undefined
      await assert.rejects(
        pgBackend.writeResource({
          spaceId,
          collectionId: 'ledger',
          resourceId: 'e1',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { v: 2 }
          },
          immutable: async ({ log }) => {
            handed = log !== undefined
            return handed
          }
        }),
        ResourceImmutableError
      )
      assert.equal(handed, true)
    })

    it("the feed of a Collection on the other backend carries its policies and log under the control plane's validators", async () => {
      const spaceId = await freshSpace('Feed Space')
      await createCollection(spaceId, 'feed', { backend: { id: 'postgres' } })
      const resource = await putResource(spaceId, 'feed', 'r1', { v: 1 })
      assert.equal(resource.status, 201)

      const collectionPolicy = await putPublicRead(
        `/space/${spaceId}/feed/policy`
      )
      await putPublicRead(`/space/${spaceId}/feed/r1/policy`)
      const resourcePolicyGone = await alice.pws.request({
        url: url(`/space/${spaceId}/feed/r1/policy`),
        method: 'DELETE'
      })
      assert.equal(resourcePolicyGone.status, 204)
      const governed = await alice.pws.request({
        url: url(`/space/${spaceId}/feed/meta/log`),
        method: 'PUT',
        body: new TextEncoder().encode(genesisLine(oneEpoch) + '\n'),
        headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' }
      })
      assert.equal(governed.status, 204)

      // The copies took positions in the Postgres feed: the Collection
      // policy live, the Resource policy a tombstone.
      const policyCopy = await pgBackend.getPolicyRecord({
        spaceId,
        collectionId: 'feed'
      })
      assert.equal(policyCopy?.deleted, false)
      const tombstoneCopy = await pgBackend.getPolicyRecord({
        spaceId,
        collectionId: 'feed',
        resourceId: 'r1'
      })
      assert.equal(tombstoneCopy?.deleted, true)

      // Each document's `etag` is the one a GET of the record answers from
      // the control plane, not the copy's.
      const [meta, log] = await Promise.all([
        alice.pws.request({ url: url(`/space/${spaceId}/feed/meta`) }),
        alice.pws.request({ url: url(`/space/${spaceId}/feed/meta/log`) })
      ])
      const feed = await alice.pws.request({
        url: url(`/space/${spaceId}/feed/query`),
        method: 'POST',
        json: { profile: 'changes' }
      })
      assert.equal(feed.status, 200)
      const byKind = (kind: string) =>
        feed.data.documents.filter(
          (document: { kind: string }) => document.kind === kind
        )
      assert.equal(byKind('resource').length, 1)
      assert.deepEqual(
        byKind('collection-metadata').map((document: any) => [
          document.id,
          document.etag
        ]),
        [[url(`/space/${spaceId}/feed/meta`), meta.headers.get('etag')]]
      )
      assert.deepEqual(
        byKind('log').map((document: any) => [document.id, document.etag]),
        [[url(`/space/${spaceId}/feed/meta/log`), log.headers.get('etag')]]
      )
      assert.deepEqual(
        byKind('policy').map((document: any) => [
          document.id,
          document.deleted,
          document.etag
        ]),
        [
          [
            url(`/space/${spaceId}/feed/policy`),
            false,
            collectionPolicy.headers.get('etag')
          ],
          [
            url(`/space/${spaceId}/feed/r1/policy`),
            true,
            resourcePolicyGone.headers.get('etag')
          ]
        ]
      )
      // One position sequence: every document resumes after the one before.
      const checkpoints = feed.data.documents.map(
        (document: { checkpoint: string }) => document.checkpoint
      )
      assert.equal(new Set(checkpoints).size, checkpoints.length)
      assert.equal(feed.data.checkpoint, checkpoints.at(-1))
    })

    it('a Delete Collection whose copy removal faulted removes the copy on the retry', async () => {
      const spaceId = await freshSpace('Torn Delete Space')
      await createCollection(spaceId, 'torn', { backend: { id: 'postgres' } })
      await putResource(spaceId, 'torn', 't1', { x: 1 })

      const faulted = vi
        .spyOn(pgBackend, 'deleteCollection')
        .mockRejectedValue(new Error('pool gone'))
      try {
        const failed = await requestError(
          alice.pws.request({
            url: url(`/space/${spaceId}/torn/`),
            method: 'DELETE'
          })
        )
        assert.equal(failed.response.status, 500)
      } finally {
        faulted.mockRestore()
      }
      assert.equal(await holds(pgBackend, spaceId, 'torn', 't1'), true)

      // The control plane holds a tombstone, so the retry is the masked 404,
      // and it still sweeps the copy.
      const retried = await requestError(
        alice.pws.request({
          url: url(`/space/${spaceId}/torn/`),
          method: 'DELETE'
        })
      )
      assert.equal(retried.response.status, 404)
      assert.equal(await holds(pgBackend, spaceId, 'torn', 't1'), false)
      assert.equal(
        await pgBackend.getCollectionMetadata({
          spaceId,
          collectionId: 'torn'
        }),
        undefined
      )
    })

    it("imports an existing Collection's Resources onto the backend its live object selects", async () => {
      const sourceId = await freshSpace('Live Source')
      await createCollection(sourceId, 'docs', { backend: { id: 'postgres' } })
      await putResource(sourceId, 'docs', 'd1', { from: 'archive' })
      const exported = await alice.pws.request({
        url: url(`/space/${sourceId}/export`),
        method: 'POST'
      })
      const tarBytes = Buffer.from(await exported.arrayBuffer())

      // The destination's `docs` is on the default backend already.
      const destinationId = await freshSpace('Live Destination')
      await createCollection(destinationId, 'docs')
      const imported = await alice.pws.request({
        url: url(`/space/${destinationId}/import`),
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.collectionsSkipped, 1)
      assert.equal(imported.data.resourcesCreated, 1)
      assert.equal(await holds(fsBackend, destinationId, 'docs', 'd1'), true)
      assert.equal(await holds(pgBackend, destinationId, 'docs', 'd1'), false)
      const read = await alice.pws.request({
        url: url(`/space/${destinationId}/docs/d1`),
        method: 'GET'
      })
      assert.deepStrictEqual(read.data, { from: 'archive' })
    })

    it("a fault in another backend's import leaves the control plane untouched, and a retry completes it", async () => {
      const sourceId = await freshSpace('Torn Import Source')
      await createCollection(sourceId, 'on-pg', { backend: { id: 'postgres' } })
      await putResource(sourceId, 'on-pg', 'p1', { from: 'pg' })
      const exported = await alice.pws.request({
        url: url(`/space/${sourceId}/export`),
        method: 'POST'
      })
      const tarBytes = Buffer.from(await exported.arrayBuffer())

      const destinationId = await freshSpace('Torn Import Destination')
      const importUrl = url(`/space/${destinationId}/import`)
      const faulted = vi
        .spyOn(pgBackend, 'importSpace')
        .mockRejectedValue(new StorageError({ cause: new Error('pool gone') }))
      try {
        const failed = await requestError(
          alice.pws.request({
            url: importUrl,
            method: 'POST',
            body: tarBytes,
            headers: { 'content-type': 'application/x-tar' }
          })
        )
        assert.equal(failed.response.status, 500)
      } finally {
        faulted.mockRestore()
      }
      assert.equal(
        await fsBackend.getCollectionMetadata({
          spaceId: destinationId,
          collectionId: 'on-pg'
        }),
        undefined,
        'no Collection is created with its Resources absent'
      )

      const retried = await alice.pws.request({
        url: importUrl,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(retried.status, 200)
      assert.equal(retried.data.collectionsCreated, 1)
      assert.equal(retried.data.resourcesCreated, 1)
      const read = await alice.pws.request({
        url: url(`/space/${destinationId}/on-pg/p1`),
        method: 'GET'
      })
      assert.deepStrictEqual(read.data, { from: 'pg' })
    })

    it('refuses registering an external backend under a server backend id', async () => {
      const spaceId = await freshSpace('Reserved Ids Space')
      for (const id of ['default', 'fs', 'postgres']) {
        const refused = await requestError(
          alice.pws.request({
            url: url(`/space/${spaceId}/backends`),
            method: 'POST',
            json: {
              id,
              provider: 'test-provider',
              managedBy: 'external',
              connection: { kind: 'inmem' }
            }
          })
        )
        assert.equal(refused.response.status, 400, id)
        assert.equal(refused.data.errors[0].pointer, '#/id')
      }
    })
  }
)

describe.skipIf(!connectionString)('Postgres as the default backend', () => {
  let fastify: FastifyInstance,
    fsBackend: TempFileSystemBackend,
    pgBackend: PostgresBackend,
    dropSchema: () => Promise<void>,
    baseServerUrl: string,
    alice: any

  beforeAll(async () => {
    fsBackend = await openTempBackend({ prefix: 'was-test-pg-default-fs-' })
    ;({ backend: pgBackend, dropSchema } = await openTempPostgres({
      originId: fsBackend.originId
    }))
    ;({ fastify, baseServerUrl } = await startTestServer({
      backends: [fsBackend, pgBackend],
      defaultBackend: 'postgres'
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await dropSchema()
  })

  it('aliases `default` to Postgres and keeps the control plane there', async () => {
    assert.equal(fastify.storage.describe().id, 'postgres')
    const spaceId = crypto.randomUUID()
    const created = await alice.pws.createSpace({
      id: spaceId,
      name: 'Postgres Default',
      controller: alice.did
    })
    assert.ok(created)
    const listing = await alice.pws.request({
      url: new URL(`/space/${spaceId}/backends`, baseServerUrl).toString(),
      method: 'GET'
    })
    assert.deepStrictEqual(listing.data, [
      { ...POSTGRES_DESCRIPTOR, id: 'default' },
      POSTGRES_DESCRIPTOR,
      FS_DESCRIPTOR
    ])
    assert.ok(await pgBackend.getSpaceMetadata({ spaceId }))
    assert.equal(await fsBackend.getSpaceMetadata({ spaceId }), undefined)

    // A Collection selecting `fs` lands its Resources on the filesystem.
    await alice.pws.request({
      url: new URL(`/space/${spaceId}/on-fs/meta`, baseServerUrl).toString(),
      method: 'PUT',
      json: { id: 'on-fs', backend: { id: 'fs' } }
    })
    await alice.pws.request({
      url: new URL(`/space/${spaceId}/on-fs/r1`, baseServerUrl).toString(),
      method: 'PUT',
      json: { on: 'fs' }
    })
    const held = await fsBackend.getResource({
      spaceId,
      collectionId: 'on-fs',
      resourceId: 'r1'
    })
    assert.equal(held.storedResourceType, 'application/json')
  })

  it('serves a governed Collection from the control plane in one read, with the log body read only on a cache miss', async () => {
    const spaceId = crypto.randomUUID()
    await alice.pws.createSpace({
      id: spaceId,
      name: 'Governed on Postgres',
      controller: alice.did
    })
    const metaUrl = new URL(
      `/space/${spaceId}/governed/meta`,
      baseServerUrl
    ).toString()
    const logUrl = new URL(
      `/space/${spaceId}/governed/meta/log`,
      baseServerUrl
    ).toString()
    await alice.pws.request({
      url: metaUrl,
      method: 'PUT',
      json: { id: 'governed' }
    })
    const body = genesisLine(oneEpoch) + '\n'
    const created = await alice.pws.request({
      url: logUrl,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' },
      body: new TextEncoder().encode(body)
    })
    const logEtag = created.headers.get('etag')!

    const pairSpy = vi.spyOn(pgBackend, 'getCollectionMetadataAndLogValidator')
    const metadataSpy = vi.spyOn(pgBackend, 'getCollectionMetadata')
    const logSpy = vi.spyOn(pgBackend, 'getCollectionLog')
    try {
      // The first read derives the descriptors, so it reads the log's body.
      const first = await alice.pws.request({ url: metaUrl, method: 'GET' })
      assert.equal(first.data.encryption.currentEpoch, 'urn:epoch:1')
      assert.equal(pairSpy.mock.calls.length, 1)
      assert.equal(logSpy.mock.calls.length, 1)
      // The second finds them cached under the validator it read.
      const second = await alice.pws.request({ url: metaUrl, method: 'GET' })
      assert.deepStrictEqual(second.data, first.data)
      assert.equal(second.headers.get('etag'), first.headers.get('etag'))
      assert.equal(pairSpy.mock.calls.length, 2)
      assert.equal(logSpy.mock.calls.length, 1)
      assert.equal(metadataSpy.mock.calls.length, 0)

      // An append moves the validator, so the next read derives again and
      // serves the new head under a new ETag.
      await alice.pws.request({
        url: logUrl,
        method: 'PUT',
        headers: { 'content-type': 'text/jsonl', 'if-match': logEtag },
        body: new TextEncoder().encode(
          body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
        )
      })
      logSpy.mockClear()
      const third = await alice.pws.request({ url: metaUrl, method: 'GET' })
      assert.equal(third.data.encryption.currentEpoch, 'urn:epoch:2')
      assert.notEqual(third.headers.get('etag'), first.headers.get('etag'))
      assert.equal(logSpy.mock.calls.length, 1)
    } finally {
      pairSpy.mockRestore()
      metadataSpy.mockRestore()
      logSpy.mockRestore()
    }
  })
})
