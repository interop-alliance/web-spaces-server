/**
 * Replication between two servers booted in one process, each over its own
 * data dir: the replica registration sub-resource, the pull loop, and the
 * apply path, end to end.
 *
 * The two servers are named `https://source.example` and
 * `https://replica.example` and never listen. A peer server's DID must name
 * a host with no port, which an ephemeral test port cannot give. Requests
 * reach each server through `fastify.inject`, signed as a client would sign
 * them, and each server's pull loop reaches the other through the plugin's
 * `peerFetch` option, wired to the same `inject`. Every pull is run by hand
 * (`replication.pullNow`) with the timers paused, so a test decides when a
 * server sees its peer.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { ProblemTypes } from '@interop/storage-core'

import type { IDID } from '../src/types.js'

import {
  delegate,
  createPeerSpace,
  genesisLine,
  oneEpoch,
  pullOnce,
  zcapClients
} from './helpers.js'
import {
  type PeerServer,
  bootPeerServer,
  signedInject,
  registerReplica,
  replicaStatus
} from '../src/testing.js'

const servers = new Map<string, PeerServer>()

/**
 * Boots one server with an identity whose key may invoke, so it can pull.
 */
async function boot(options: {
  serverUrl: string
  start: number
}): Promise<PeerServer> {
  return bootPeerServer({
    ...options,
    prefix: 'was-replication-',
    servers
  })
}

describe('Replication between two servers', () => {
  let source: PeerServer, replica: PeerServer
  let alice: { did: string; signer: any }, bob: { did: string; signer: any }

  /**
   * Sends one signed request to a server. `capability` defaults to the root
   * capability of the Space the path is under.
   */
  async function call({
    signer = alice.signer,
    ...request
  }: Omit<Parameters<typeof signedInject>[0], 'signer'> & { signer?: any }) {
    return signedInject({ signer, ...request })
  }

  /**
   * Creates a Space under Alice's key on a server.
   */
  async function createSpace({
    server,
    spaceId,
    controller = alice.did
  }: {
    server: PeerServer
    spaceId: string
    controller?: string
  }): Promise<void> {
    await createPeerSpace({ server, spaceId, controller })
  }

  /**
   * Registers `from`'s Space as the source of `to`'s, with a pull capability
   * Alice delegates to `to`'s DID by default, and resolves the registration
   * response.
   */
  async function register({
    delegator = alice,
    ...options
  }: Omit<Parameters<typeof registerReplica>[0], 'signer' | 'delegator'> & {
    delegator?: { did: string; signer: any }
  }) {
    return registerReplica({ signer: alice.signer, delegator, ...options })
  }

  const pull = pullOnce

  /**
   * Reads a registration's status, as Alice.
   */
  async function statusOf(
    options: Omit<Parameters<typeof replicaStatus>[0], 'signer'>
  ) {
    return replicaStatus({ signer: alice.signer, ...options })
  }

  beforeAll(async () => {
    const identities = await zcapClients({
      baseServerUrl: 'https://unused.example'
    })
    alice = identities.alice
    bob = identities.bob
    source = await boot({
      serverUrl: 'https://source.example',
      start: Date.UTC(2026, 9, 1, 12, 0, 0)
    })
    replica = await boot({
      serverUrl: 'https://replica.example',
      start: Date.UTC(2026, 9, 1, 12, 0, 1)
    })
  })

  afterAll(async () => {
    await source?.fastify.close()
    await replica?.fastify.close()
  })

  describe('a registration', () => {
    beforeAll(async () => {
      await createSpace({ server: source, spaceId: 'reg-src' })
      await createSpace({ server: replica, spaceId: 'reg-dst' })
    })

    it('is stored, read back unchanged, and listed on the Space Metadata object', async () => {
      const before = await call({
        server: replica,
        path: '/space/reg-dst/meta'
      })
      const created = await register({
        to: replica,
        toSpaceId: 'reg-dst',
        from: source,
        fromSpaceId: 'reg-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
      assert.equal(
        created.headers.location,
        'https://replica.example/space/reg-dst/replicas/peer'
      )
      const record = created.json()
      // The record is served under its write stamp, as every versioned
      // record is.
      assert.deepStrictEqual(Object.keys(record).sort(), [
        'capability',
        'fromSpace',
        'id',
        'originId',
        'role',
        'toSpace',
        'updatedAt',
        'updatedAtCounter'
      ])
      assert.equal(record.originId, replica.backend.originId)

      const read = await call({
        server: replica,
        path: '/space/reg-dst/replicas/peer'
      })
      assert.equal(read.statusCode, 200)
      assert.deepStrictEqual(read.json(), record)
      assert.equal(read.headers.etag, created.headers.etag)
      // The four-segment ETag: generation, stamp ms, counter, origin id.
      assert.match(String(read.headers.etag), /^"[^".]+\.\d+\.\d+\.[^".]+"$/)
      assert.equal(
        String(read.headers.etag).slice(1, -1).split('.')[1],
        String(Date.parse(record.updatedAt))
      )

      const listed = await call({
        server: replica,
        path: '/space/reg-dst/replicas'
      })
      assert.deepStrictEqual(listed.json(), {
        url: '/space/reg-dst/replicas',
        totalItems: 1,
        items: [record]
      })

      // The served Space Metadata object lists the edge, with no id and no
      // capability, and its validator moved in the local segment only.
      const after = await call({ server: replica, path: '/space/reg-dst/meta' })
      assert.deepStrictEqual(after.json().replicas, [
        {
          fromSpace: 'https://source.example/space/reg-src/',
          toSpace: 'https://replica.example/space/reg-dst/',
          role: 'source'
        }
      ])
      assert.deepStrictEqual(before.json().replicas, [])
      const segments = (etag: unknown) => String(etag).slice(1, -1).split('.')
      assert.deepStrictEqual(
        segments(after.headers.etag).slice(0, 4),
        segments(before.headers.etag).slice(0, 4)
      )
      assert.notEqual(
        segments(after.headers.etag)[4],
        segments(before.headers.etag)[4]
      )
      assert.equal(after.json().updatedAt, before.json().updatedAt)
    })

    it('is advertised by the Space linkset and the service description', async () => {
      const linkset = await call({
        server: replica,
        path: '/space/reg-dst/linkset'
      })
      assert.deepStrictEqual(
        linkset.json().linkset[0]['https://w3id.org/pws#replicas'],
        [{ href: '/space/reg-dst/replicas', type: 'application/json' }]
      )
      const service = await replica.fastify.inject({ url: '/service' })
      assert.deepStrictEqual(
        service.json().specs['https://w3id.org/pws/replication'],
        [
          {
            version: '0.1',
            url: 'https://w3c-ccg.github.io/portable-web-spaces-spec/replication/'
          }
        ]
      )
    })

    it('refuses a duplicate id as id-conflict', async () => {
      const again = await register({
        to: replica,
        toSpaceId: 'reg-dst',
        from: source,
        fromSpaceId: 'reg-src'
      })
      assert.equal(again.statusCode, 409)
      assert.equal(again.json().type, ProblemTypes.ID_CONFLICT)
    })

    it('demands the auth headers on every read', async () => {
      for (const path of [
        '/space/reg-dst/replicas',
        '/space/reg-dst/replicas/peer',
        '/space/reg-dst/replicas/peer/status'
      ]) {
        const anonymous = await replica.fastify.inject({ url: path })
        assert.equal(anonymous.statusCode, 401, path)
      }
    })

    it('refuses a delegated grant on the Space URL, the shape of a data grant', async () => {
      // A delegated capability over the whole Space, every verb, reaches the
      // replicas routes by attenuation, and the container rule keeps it out:
      // it would list the pull capabilities, pause the loops and remove the
      // registrations.
      const spaceUrl = 'https://replica.example/space/reg-dst/'
      const grant = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
      })
      for (const [method, path] of [
        ['GET', '/space/reg-dst/replicas'],
        ['GET', '/space/reg-dst/replicas/peer'],
        ['GET', '/space/reg-dst/replicas/peer/status'],
        ['DELETE', '/space/reg-dst/replicas/peer']
      ] as const) {
        const delegated = await call({
          server: replica,
          path,
          method,
          signer: bob.signer,
          capability: grant
        })
        assert.equal(delegated.statusCode, 404, `${method} ${path}`)
        assert.equal(delegated.json().type, ProblemTypes.NOT_FOUND)
      }
    })

    it('admits a delegated grant on the replicas URL, bounding a create to a registered source', async () => {
      const spaceUrl = 'https://replica.example/space/reg-dst/'
      const grant = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: `${spaceUrl}replicas`,
        controller: bob.did,
        allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
      })
      const asBob = (
        request: Omit<Parameters<typeof call>[0], 'server' | 'signer'>
      ) =>
        call({
          server: replica,
          signer: bob.signer,
          capability: grant,
          ...request
        })
      for (const path of [
        '/space/reg-dst/replicas',
        '/space/reg-dst/replicas/peer',
        '/space/reg-dst/replicas/peer/status'
      ]) {
        const read = await asBob({ path })
        assert.equal(read.statusCode, 200, `${path}: ${read.payload}`)
      }

      // A create may name only a source a registration on the Space already
      // names: `reg-src` is registered as `peer`, `reg-other` is not, though
      // it exists and its pull capability would pass the peer checks.
      await createPeerSpace({
        server: source,
        spaceId: 'reg-other',
        controller: alice.did
      })
      const pullCapabilityFor = async (fromSpace: string) =>
        delegate({
          signer: alice.signer,
          capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
          invocationTarget: fromSpace,
          controller: replica.did,
          allowedActions: ['GET']
        })
      const registration = async (id: string, fromSpace: string) => ({
        id,
        fromSpace,
        toSpace: spaceUrl,
        capability: await pullCapabilityFor(fromSpace),
        role: 'source'
      })
      const newSource = 'https://source.example/space/reg-other/'
      const refusedPost = await asBob({
        path: '/space/reg-dst/replicas',
        method: 'POST',
        json: await registration('other', newSource)
      })
      assert.equal(refusedPost.statusCode, 409, refusedPost.payload)
      assert.equal(refusedPost.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.equal(refusedPost.json().errors[0].pointer, '#/fromSpace')
      // A PUT at an absent id is a create, and carries the same bound.
      const refusedPut = await asBob({
        path: '/space/reg-dst/replicas/other',
        method: 'PUT',
        json: await registration('other', newSource)
      })
      assert.equal(refusedPut.statusCode, 409, refusedPut.payload)
      assert.equal(refusedPut.json().type, ProblemTypes.REPLICA_REFUSED)

      const again = await asBob({
        path: '/space/reg-dst/replicas',
        method: 'POST',
        json: await registration(
          'again',
          'https://source.example/space/reg-src/'
        )
      })
      assert.equal(again.statusCode, 201, again.payload)
      const removed = await asBob({
        path: '/space/reg-dst/replicas/again',
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204, removed.payload)
    })

    it('refuses a malformed body as invalid-request-body', async () => {
      const cases: Array<{
        overrides?: Record<string, unknown>
        allowedActions?: string[]
        pointer: string
      }> = [
        { overrides: { id: 'bad.state' }, pointer: '#/id' },
        { overrides: { id: 'a/b' }, pointer: '#/id' },
        {
          overrides: { fromSpace: 'https://source.example/space/reg-src' },
          pointer: '#/fromSpace'
        },
        {
          overrides: { toSpace: 'https://replica.example/space/other/' },
          pointer: '#/toSpace'
        },
        { overrides: { role: 'target' }, pointer: '#/role' },
        {
          overrides: { collections: [{ name: 'x' }] },
          pointer: '#/collections/0'
        },
        {
          allowedActions: ['GET', 'PUT'],
          pointer: '#/capability/allowedAction'
        }
      ]
      for (const { overrides, allowedActions, pointer } of cases) {
        const response = await register({
          to: replica,
          toSpaceId: 'reg-dst',
          from: source,
          fromSpaceId: 'reg-src',
          replicaId: 'malformed',
          ...(overrides !== undefined && { overrides }),
          ...(allowedActions !== undefined && { allowedActions })
        })
        assert.equal(response.statusCode, 400, pointer)
        const problem = response.json()
        assert.equal(problem.type, ProblemTypes.INVALID_REQUEST_BODY)
        assert.equal(problem.errors[0].pointer, pointer)
      }
    })

    it('refuses a peer Space under another controller as replica-refused', async () => {
      await createSpace({
        server: source,
        spaceId: 'reg-bob',
        controller: bob.did
      })
      const response = await register({
        to: replica,
        toSpaceId: 'reg-dst',
        from: source,
        fromSpaceId: 'reg-bob',
        replicaId: 'bobs',
        delegator: bob
      })
      assert.equal(response.statusCode, 409, response.payload)
      assert.equal(response.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(response.json().errors[0].detail, /another controller/)
    })

    it('refuses a peer Space with another type set', async () => {
      await source.backend.writeSpace({
        spaceId: 'reg-aux',
        spaceMetadata: {
          id: 'reg-aux',
          type: ['AuxiliarySpace', 'DelegatedClientsSpace', 'Space'],
          controller: alice.did as IDID
        }
      })
      const response = await register({
        to: replica,
        toSpaceId: 'reg-dst',
        from: source,
        fromSpaceId: 'reg-aux',
        replicaId: 'aux'
      })
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(response.json().errors[0].detail, /"type" set/)
    })

    it('refuses a peer that carries its own origin id', async () => {
      await createSpace({ server: replica, spaceId: 'reg-self' })
      const response = await register({
        to: replica,
        toSpaceId: 'reg-dst',
        from: replica,
        fromSpaceId: 'reg-self',
        replicaId: 'self'
      })
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(response.json().errors[0].detail, /own origin id/)
    })

    it('refuses a capability delegated to another DID', async () => {
      const fromSpace = 'https://source.example/space/reg-src/'
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
        invocationTarget: fromSpace,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const response = await register({
        to: replica,
        toSpaceId: 'reg-dst',
        from: source,
        fromSpaceId: 'reg-src',
        replicaId: 'not-ours',
        overrides: { capability }
      })
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.equal(response.json().errors[0].pointer, '#/capability/controller')
    })

    it('reserves the `replicas` and `zcaps` Collection ids', async () => {
      for (const id of ['replicas', 'zcaps']) {
        const response = await call({
          server: replica,
          path: '/space/reg-dst/',
          method: 'POST',
          json: { id, name: id }
        })
        assert.equal(response.statusCode, 409, id)
        assert.equal(response.json().type, ProblemTypes.RESERVED_ID)
      }
    })

    it('is removed by DELETE, with its status and its listing entry', async () => {
      const removed = await call({
        server: replica,
        path: '/space/reg-dst/replicas/peer',
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204)
      for (const path of [
        '/space/reg-dst/replicas/peer',
        '/space/reg-dst/replicas/peer/status'
      ]) {
        const gone = await call({ server: replica, path })
        assert.equal(gone.statusCode, 404, path)
      }
      const meta = await call({ server: replica, path: '/space/reg-dst/meta' })
      assert.deepStrictEqual(meta.json().replicas, [])
      // Idempotent.
      const again = await call({
        server: replica,
        path: '/space/reg-dst/replicas/peer',
        method: 'DELETE'
      })
      assert.equal(again.statusCode, 204)
    })

    it('goes with Delete Space', async () => {
      await createSpace({ server: replica, spaceId: 'reg-gone' })
      const created = await register({
        to: replica,
        toSpaceId: 'reg-gone',
        from: source,
        fromSpaceId: 'reg-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
      const deleted = await call({
        server: replica,
        path: '/space/reg-gone/',
        method: 'DELETE'
      })
      assert.equal(deleted.statusCode, 204)
      assert.deepStrictEqual(
        (await replica.backend.listAllReplicas()).filter(
          ({ spaceId }) => spaceId === 'reg-gone'
        ),
        []
      )
    })
  })

  describe('a registration under PUT', () => {
    const path = '/space/put-dst/replicas/peer'
    let stored: any

    /**
     * Reads the stored registration on the replica, as Alice.
     */
    async function read() {
      const response = await call({ server: replica, path })
      assert.equal(response.statusCode, 200, response.payload)
      return response
    }

    /**
     * PUTs `record` at the registration URL.
     */
    async function put(
      record: Record<string, unknown>,
      headers?: Record<string, string>
    ) {
      return call({
        server: replica,
        path,
        method: 'PUT',
        json: record,
        ...(headers !== undefined && { headers })
      })
    }

    /**
     * Writes a Resource on the source and resolves its id.
     */
    async function writeOnSource(resourceId: string) {
      const written = await call({
        server: source,
        path: `/space/put-src/notes/${resourceId}`,
        method: 'PUT',
        json: { resourceId }
      })
      assert.ok([201, 204].includes(written.statusCode), written.payload)
    }

    /**
     * Whether the replica serves the Resource.
     */
    async function heldByReplica(resourceId: string) {
      const read = await call({
        server: replica,
        path: `/space/put-dst/notes/${resourceId}`
      })
      return read.statusCode === 200
    }

    /**
     * Holds the replica's next loop-state read until `release()` is called,
     * so a cycle stays in flight while a PUT lands. `spy` reports the read;
     * the caller restores it.
     */
    function holdReplicaStateRead() {
      let release!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const readState = replica.backend.getReplicaState.bind(replica.backend)
      const spy = vi
        .spyOn(replica.backend, 'getReplicaState')
        .mockImplementationOnce(async options => {
          await held
          return readState(options)
        })
      return { release, spy }
    }

    beforeAll(async () => {
      await createSpace({ server: source, spaceId: 'put-src' })
      await createSpace({ server: replica, spaceId: 'put-dst' })
      await call({
        server: source,
        path: '/space/put-src/',
        method: 'POST',
        json: { id: 'notes', name: 'Notes' }
      })
      await writeOnSource('first')
      const created = await register({
        to: replica,
        toSpaceId: 'put-dst',
        from: source,
        fromSpaceId: 'put-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.ok(await heldByReplica('first'))
      stored = (await read()).json()
    })

    it("pauses the loop, under the server's own time and a new ETag", async () => {
      const before = await read()
      const meta = await call({ server: replica, path: '/space/put-dst/meta' })
      const paused = await put({
        ...stored,
        pausedAt: '2001-01-01T00:00:00.000Z'
      })
      assert.equal(paused.statusCode, 204, paused.payload)
      assert.notEqual(paused.headers.etag, before.headers.etag)
      const segments = (etag: unknown) => String(etag).slice(1, -1).split('.')
      // Same generation, a stamp above the stored one. The test clocks are
      // frozen, so the stamp moves in its counter.
      const [generation, ms, counter] = segments(paused.headers.etag)
      const [priorGeneration, priorMs, priorCounter] = segments(
        before.headers.etag
      )
      assert.equal(generation, priorGeneration)
      assert.equal(ms, priorMs)
      assert.ok(Number(counter) > Number(priorCounter))

      const after = await read()
      assert.equal(after.headers.etag, paused.headers.etag)
      const record = after.json()
      // The client's value is ignored: the server's clock sets the member,
      // to the write's own time.
      assert.notEqual(record.pausedAt, '2001-01-01T00:00:00.000Z')
      assert.equal(record.pausedAt, record.updatedAt)
      assert.equal(record.id, 'peer')
      assert.deepStrictEqual(record.capability, stored.capability)

      // The status reports the pause, and nothing is pulled.
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).state,
        'paused'
      )
      await writeOnSource('while-paused')
      // The cycle the pause woke finds the registration paused, ends the
      // loop, and drops the cycle the status would otherwise still report.
      assert.ok(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).nextPullAt
      )
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).nextPullAt,
        undefined
      )
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.equal(await heldByReplica('while-paused'), false)
      // A boot starts no loop for it either.
      await replica.fastify.replication.start()
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.equal(await heldByReplica('while-paused'), false)

      // The served Space Metadata object is unchanged by the PUT.
      const metaAfter = await call({
        server: replica,
        path: '/space/put-dst/meta'
      })
      assert.equal(metaAfter.headers.etag, meta.headers.etag)
      assert.deepStrictEqual(metaAfter.json().replicas, meta.json().replicas)
    })

    it('keeps pausedAt across a PUT that stays paused', async () => {
      const before = await read()
      const again = await put({ ...before.json(), pausedAt: 'anything' })
      assert.equal(again.statusCode, 204, again.payload)
      const after = await read()
      assert.equal(after.json().pausedAt, before.json().pausedAt)
      assert.notEqual(after.headers.etag, before.headers.etag)
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).state,
        'paused'
      )
    })

    it('resumes with a body that omits pausedAt, and the next pull applies', async () => {
      const { pausedAt: _pausedAt, ...record } = (await read()).json()
      const resumed = await put(record)
      assert.equal(resumed.statusCode, 204, resumed.payload)
      const after = (await read()).json()
      assert.equal(after.pausedAt, undefined)
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).state,
        'idle'
      )
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.ok(await heldByReplica('while-paused'))
    })

    it('replaces the pull capability in place, keeping the id and the checkpoint', async () => {
      const before = (await read()).json()
      const stateBefore = await replica.backend.getReplicaState({
        spaceId: 'put-dst',
        replicaId: 'peer'
      })
      assert.ok(stateBefore?.collections.notes?.checkpoint)
      const fromSpace = 'https://source.example/space/put-src/'
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
        invocationTarget: fromSpace,
        controller: replica.did,
        allowedActions: ['GET']
      })
      assert.notEqual(capability.id, before.capability.id)
      const replaced = await put({ ...before, capability })
      assert.equal(replaced.statusCode, 204, replaced.payload)
      const after = (await read()).json()
      assert.equal(after.id, 'peer')
      assert.deepStrictEqual(after.capability, capability)
      assert.equal(after.pausedAt, undefined)
      // The checkpoint survives the replacement, so the next cycle reads
      // the feed from where it left off.
      assert.deepStrictEqual(
        await replica.backend.getReplicaState({
          spaceId: 'put-dst',
          replicaId: 'peer'
        }),
        stateBefore
      )
      await writeOnSource('after-replacement')
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.ok(await heldByReplica('after-replacement'))
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).state,
        'idle'
      )
    })

    it('wakes the loop only for a change it reads', async () => {
      const before = (await read()).json()
      const wake = vi.spyOn(replica.fastify.replication, 'wake')
      try {
        // A repeat of the stored body leaves the scheduled cycle alone.
        const repeated = await put(before)
        assert.equal(repeated.statusCode, 204, repeated.payload)
        assert.equal(wake.mock.calls.length, 0)
        const paused = await put({ ...before, pausedAt: 'now' })
        assert.equal(paused.statusCode, 204, paused.payload)
        assert.equal(wake.mock.calls.length, 1)
        const resumed = await put(before)
        assert.equal(resumed.statusCode, 204, resumed.payload)
        assert.equal(wake.mock.calls.length, 2)
      } finally {
        wake.mockRestore()
      }
      await pull({ server: replica, spaceId: 'put-dst' })
    })

    it('has a cycle in flight at a PUT schedule its successor at once', async () => {
      const before = (await read()).json()
      // Hold the cycle at its loop-state read until the PUT has landed.
      const { release, spy } = holdReplicaStateRead()
      try {
        const cycle = pull({ server: replica, spaceId: 'put-dst' })
        await vi.waitFor(() => assert.equal(spy.mock.calls.length, 1))
        const fromSpace = 'https://source.example/space/put-src/'
        const capability = await delegate({
          signer: alice.signer,
          capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
          invocationTarget: fromSpace,
          controller: replica.did,
          allowedActions: ['GET']
        })
        const replaced = await put({ ...before, capability })
        assert.equal(replaced.statusCode, 204, replaced.payload)
        release()
        await cycle
      } finally {
        spy.mockRestore()
      }
      // The held cycle ran under the old capability; its successor is due
      // now rather than at the pull interval.
      const status = await statusOf({ server: replica, spaceId: 'put-dst' })
      assert.ok(status.nextPullAt)
      assert.ok(Date.parse(status.nextPullAt) - Date.now() < 1_000)
    })

    it('starts a loop for a resume that lands while the paused cycle is in flight', async () => {
      const before = (await read()).json()
      const paused = await put({ ...before, pausedAt: 'now' })
      assert.equal(paused.statusCode, 204, paused.payload)
      // Hold the paused registration's cycle at its loop-state read, so the
      // resume lands on a loop with a cycle in flight. That cycle read
      // `pausedAt` and ends its loop; the resume must not be lost with it.
      const { release, spy } = holdReplicaStateRead()
      try {
        const cycle = pull({ server: replica, spaceId: 'put-dst' })
        await vi.waitFor(() => assert.equal(spy.mock.calls.length, 1))
        const resumed = await put(before)
        assert.equal(resumed.statusCode, 204, resumed.payload)
        release()
        await cycle
      } finally {
        spy.mockRestore()
      }
      // A fresh loop stands for the resumed registration: a pull by hand
      // runs a cycle, where a registration with no loop pulls nothing.
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).state,
        'idle'
      )
      await writeOnSource('after-held-resume')
      await pull({ server: replica, spaceId: 'put-dst' })
      assert.ok(await heldByReplica('after-held-resume'))
    })

    it('re-validates a replacement capability as a POST does', async () => {
      const before = (await read()).json()
      const fromSpace = 'https://source.example/space/put-src/'
      const toBob = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
        invocationTarget: fromSpace,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const refused = await put({ ...before, capability: toBob })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.deepStrictEqual((await read()).json(), before)
    })

    it("refuses a change to any other member on that member's pointer", async () => {
      const before = (await read()).json()
      // A `fromSpace` change is caught by the body parser first, since the
      // capability's `invocationTarget` no longer equals it.
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ collections: [{ id: 'notes' }] }, '#/collections'],
        [
          { fromSpace: 'https://source.example/space/other/' },
          '#/capability/invocationTarget'
        ]
      ]
      for (const [change, pointer] of cases) {
        const refused = await put({ ...before, ...change })
        assert.equal(refused.statusCode, 400, refused.payload)
        assert.equal(refused.json().type, ProblemTypes.INVALID_REQUEST_BODY)
        assert.equal(refused.json().errors[0].pointer, pointer, pointer)
      }
      const otherId = await put({ ...before, id: 'other' })
      assert.equal(otherId.statusCode, 400)
      assert.equal(otherId.json().errors[0].pointer, '#/id')
      const badPause = await put({ ...before, pausedAt: 42 })
      assert.equal(badPause.statusCode, 400)
      assert.equal(badPause.json().errors[0].pointer, '#/pausedAt')
      assert.deepStrictEqual((await read()).json(), before)
    })

    it('takes If-Match and If-None-Match: *', async () => {
      const current = await read()
      const record = current.json()
      const stale = await put(
        { ...record, pausedAt: 'x' },
        { 'if-match': '"stale.0.0.none"' }
      )
      assert.equal(stale.statusCode, 412, stale.payload)
      assert.equal(stale.json().type, ProblemTypes.PRECONDITION_FAILED)
      const exists = await put(record, { 'if-none-match': '*' })
      assert.equal(exists.statusCode, 412)
      assert.deepStrictEqual((await read()).json(), record)

      // A stale view is told so (412) before its body is judged (400): the
      // client re-reads rather than treating the body as refused for good.
      const staleBody = await put(
        { ...record, collections: [{ id: 'notes' }] },
        { 'if-match': '"stale.0.0.none"' }
      )
      assert.equal(staleBody.statusCode, 412, staleBody.payload)

      // A stale conditional write with a new capability costs the source
      // server no read: the precondition is evaluated before the peer checks.
      const fromSpace = 'https://source.example/space/put-src/'
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
        invocationTarget: fromSpace,
        controller: replica.did,
        allowedActions: ['GET']
      })
      const peerReads = vi.spyOn(source.fastify, 'inject')
      try {
        const staleCapability = await put(
          { ...record, capability },
          { 'if-match': '"stale.0.0.none"' }
        )
        assert.equal(staleCapability.statusCode, 412, staleCapability.payload)
        assert.equal(peerReads.mock.calls.length, 0)
      } finally {
        peerReads.mockRestore()
      }
      assert.deepStrictEqual((await read()).json(), record)

      const fresh = await put(
        { ...record, pausedAt: 'x' },
        { 'if-match': String(current.headers.etag) }
      )
      assert.equal(fresh.statusCode, 204, fresh.payload)
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'put-dst' })).state,
        'paused'
      )
      // Back to running for the cases that follow.
      const { pausedAt: _pausedAt, ...resumed } = (await read()).json()
      assert.equal((await put(resumed)).statusCode, 204)
    })

    it('creates an absent registration, as a POST would', async () => {
      const before = (await read()).json()
      const created = await call({
        server: replica,
        path: '/space/put-dst/replicas/second',
        method: 'PUT',
        json: { ...before, id: 'second' }
      })
      assert.equal(created.statusCode, 201, created.payload)
      assert.equal(
        created.headers.location,
        'https://replica.example/space/put-dst/replicas/second'
      )
      assert.match(String(created.headers.etag), /^"[^".]+\.\d+\.\d+\.[^".]+"$/)
      assert.equal(created.json().id, 'second')
      const status = await statusOf({
        server: replica,
        spaceId: 'put-dst',
        replicaId: 'second'
      })
      assert.equal(status.state, 'idle')
      const meta = await call({ server: replica, path: '/space/put-dst/meta' })
      assert.equal(meta.json().replicas.length, 2)

      // A create may be made paused. It starts no loop, as POST starts none.
      const wake = vi.spyOn(replica.fastify.replication, 'wake')
      let pausedCreate
      try {
        pausedCreate = await call({
          server: replica,
          path: '/space/put-dst/replicas/third',
          method: 'PUT',
          json: { ...before, id: 'third', pausedAt: 'now' }
        })
        assert.equal(wake.mock.calls.length, 0)
      } finally {
        wake.mockRestore()
      }
      assert.equal(pausedCreate.statusCode, 201, pausedCreate.payload)
      assert.equal(pausedCreate.json().pausedAt, pausedCreate.json().updatedAt)
      assert.equal(
        (
          await statusOf({
            server: replica,
            spaceId: 'put-dst',
            replicaId: 'third'
          })
        ).state,
        'paused'
      )
    })

    it("refuses a root invocation signed by a key other than the controller's", async () => {
      const before = (await read()).json()
      const asBob = await call({
        server: replica,
        path,
        method: 'PUT',
        json: before,
        signer: bob.signer
      })
      assert.equal(asBob.statusCode, 404)
    })
  })

  describe('the changes feed by GET', () => {
    beforeAll(async () => {
      await createSpace({ server: source, spaceId: 'feed' })
      await call({
        server: source,
        path: '/space/feed/',
        method: 'POST',
        json: { id: 'notes', name: 'Notes' }
      })
      await call({
        server: source,
        path: '/space/feed/notes/one',
        method: 'PUT',
        json: { n: 1 }
      })
    })

    it("serves the POST form's page under a GET-only capability", async () => {
      const spaceUrl = 'https://source.example/space/feed/'
      const readOnly = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const byGet = await call({
        server: source,
        path: '/space/feed/notes/query?profile=changes&limit=10',
        signer: bob.signer,
        capability: readOnly
      })
      assert.equal(byGet.statusCode, 200, byGet.payload)
      const byPost = await call({
        server: source,
        path: '/space/feed/notes/query',
        method: 'POST',
        json: { profile: 'changes', limit: 10 }
      })
      assert.deepStrictEqual(byGet.json(), byPost.json())
      assert.deepStrictEqual(
        byGet.json().documents.map((doc: any) => doc.kind),
        ['collection-metadata', 'resource']
      )

      // The checkpoint resumes after the page.
      const resumed = await call({
        server: source,
        path: `/space/feed/notes/query?profile=changes&checkpoint=${byGet.json().checkpoint}`,
        signer: bob.signer,
        capability: readOnly
      })
      assert.deepStrictEqual(resumed.json().documents, [])

      // The same capability cannot run the POST form.
      const refused = await call({
        server: source,
        path: '/space/feed/notes/query',
        method: 'POST',
        signer: bob.signer,
        capability: readOnly,
        json: { profile: 'changes' }
      })
      assert.equal(refused.statusCode, 404)
    })

    it('serves no other profile and requires one', async () => {
      const other = await call({
        server: source,
        path: '/space/feed/notes/query?profile=equality'
      })
      assert.equal(other.statusCode, 501)
      const none = await call({
        server: source,
        path: '/space/feed/notes/query?limit=5'
      })
      assert.equal(none.statusCode, 400)
      assert.equal(none.json().errors[0].pointer, '#/profile')
    })
  })

  describe('a pull', () => {
    const binary = Buffer.from([0, 1, 2, 3, 250, 251, 252])

    beforeAll(async () => {
      await createSpace({ server: source, spaceId: 'home' })
      // The replica Space carries another id than its source.
      await createSpace({ server: replica, spaceId: 'mirror' })
      await call({
        server: source,
        path: '/space/home/',
        method: 'POST',
        json: { id: 'notes', name: 'Notes' }
      })
      await call({
        server: source,
        path: '/space/home/notes/hello',
        method: 'PUT',
        json: { hello: 'world' }
      })
      await call({
        server: source,
        path: '/space/home/notes/hello/meta',
        method: 'PUT',
        json: { custom: { name: 'Greeting' } }
      })
      await call({
        server: source,
        path: '/space/home/notes/blob',
        method: 'PUT',
        body: binary,
        contentType: 'application/octet-stream'
      })
      await call({
        server: source,
        path: '/space/home/notes/policy',
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      const created = await register({
        to: replica,
        toSpaceId: 'mirror',
        from: source,
        fromSpaceId: 'home'
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'mirror' })
    })

    it('leaves the replica serving the same bytes, ETag and updatedAt', async () => {
      for (const resourceId of ['hello', 'blob']) {
        const original = await call({
          server: source,
          path: `/space/home/notes/${resourceId}`
        })
        const copy = await call({
          server: replica,
          path: `/space/mirror/notes/${resourceId}`
        })
        assert.equal(copy.statusCode, 200, copy.payload)
        assert.ok(copy.rawPayload.equals(original.rawPayload), resourceId)
        assert.equal(copy.headers.etag, original.headers.etag)
        assert.equal(
          copy.headers['content-type'],
          original.headers['content-type']
        )

        const originalMeta = await call({
          server: source,
          path: `/space/home/notes/${resourceId}/meta`
        })
        const copyMeta = await call({
          server: replica,
          path: `/space/mirror/notes/${resourceId}/meta`
        })
        assert.deepStrictEqual(copyMeta.json(), originalMeta.json())
        assert.equal(copyMeta.headers.etag, originalMeta.headers.etag)
        assert.equal(
          copyMeta.json().originId,
          source.backend.originId,
          'the stamp names the origin server'
        )
      }
    })

    it('carries the Collection under its generation and creating stamp', async () => {
      const original = await call({
        server: source,
        path: '/space/home/notes/meta'
      })
      const copy = await call({
        server: replica,
        path: '/space/mirror/notes/meta'
      })
      assert.equal(copy.statusCode, 200)
      const stored = ({ url: _url, linkset: _linkset, ...rest }: any) => rest
      assert.deepStrictEqual(stored(copy.json()), stored(original.json()))
      assert.deepStrictEqual(copy.json().created, original.json().created)
      // The first four segments are the replicated validator.
      const replicated = (etag: unknown) =>
        String(etag).slice(1, -1).split('.').slice(0, 4)
      assert.deepStrictEqual(
        replicated(copy.headers.etag),
        replicated(original.headers.etag)
      )
    })

    it('carries the Collection policy', async () => {
      const anonymous = await replica.fastify.inject({
        url: '/space/mirror/notes/hello',
        headers: { host: 'replica.example' }
      })
      assert.equal(anonymous.statusCode, 200)
      assert.deepStrictEqual(anonymous.json(), { hello: 'world' })
    })

    it('reports the Collection as synced', async () => {
      const status = await statusOf({ server: replica, spaceId: 'mirror' })
      assert.equal(status.state, 'idle')
      assert.ok(status.lastSuccessAt)
      assert.ok(status.nextPullAt)
      assert.deepStrictEqual(
        status.collections.map(({ id, state }: any) => ({ id, state })),
        [{ id: 'notes', state: 'synced' }]
      )
    })

    it('applies nothing on a second pull', async () => {
      const before = await call({
        server: replica,
        path: '/space/mirror/notes/query?profile=changes'
      })
      await pull({ server: replica, spaceId: 'mirror' })
      const after = await call({
        server: replica,
        path: '/space/mirror/notes/query?profile=changes'
      })
      assert.equal(after.json().checkpoint, before.json().checkpoint)
    })

    it('carries an update, a Resource delete and the Space name', async () => {
      source.clock.now += 5_000
      await call({
        server: source,
        path: '/space/home/notes/hello',
        method: 'PUT',
        json: { hello: 'again' }
      })
      await call({
        server: source,
        path: '/space/home/notes/blob',
        method: 'DELETE'
      })
      await call({
        server: source,
        path: '/space/home/meta',
        method: 'PUT',
        json: { controller: alice.did, name: 'Home' }
      })
      await pull({ server: replica, spaceId: 'mirror' })

      const hello = await call({
        server: replica,
        path: '/space/mirror/notes/hello'
      })
      assert.deepStrictEqual(hello.json(), { hello: 'again' })
      // The `/meta` record did not move with the content write.
      const meta = await call({
        server: replica,
        path: '/space/mirror/notes/hello/meta'
      })
      assert.deepStrictEqual(meta.json().custom, { name: 'Greeting' })
      const blob = await call({
        server: replica,
        path: '/space/mirror/notes/blob'
      })
      assert.equal(blob.statusCode, 404)
      const space = await call({ server: replica, path: '/space/mirror/meta' })
      assert.equal(space.json().name, 'Home')
      assert.equal(space.json().id, 'mirror')
    })

    it('is one-way: nothing written on the replica reaches the source', async () => {
      replica.clock.now += 60_000
      const written = await call({
        server: replica,
        path: '/space/mirror/notes/local-only',
        method: 'PUT',
        json: { stays: 'here' }
      })
      assert.equal(written.statusCode, 201)
      await pull({ server: replica, spaceId: 'mirror' })
      const absent = await call({
        server: source,
        path: '/space/home/notes/local-only'
      })
      assert.equal(absent.statusCode, 404)
      assert.deepStrictEqual(
        (await call({ server: source, path: '/space/home/meta' })).json()
          .replicas,
        []
      )
    })

    it('converges both servers on the write with the greater stamp', async () => {
      // The counterpart registration makes the pair two-way.
      const counterpart = await register({
        to: source,
        toSpaceId: 'home',
        from: replica,
        fromSpaceId: 'mirror'
      })
      assert.equal(counterpart.statusCode, 201, counterpart.payload)

      // Both write the same Resource while no pull runs. The replica's clock
      // reads later, so its write carries the greater stamp.
      source.clock.now = Date.UTC(2026, 9, 1, 13, 0, 0)
      replica.clock.now = Date.UTC(2026, 9, 1, 13, 0, 30)
      await call({
        server: source,
        path: '/space/home/notes/contested',
        method: 'PUT',
        json: { from: 'source' }
      })
      await call({
        server: replica,
        path: '/space/mirror/notes/contested',
        method: 'PUT',
        json: { from: 'replica' }
      })

      await pull({ server: replica, spaceId: 'mirror' })
      await pull({ server: source, spaceId: 'home' })
      await pull({ server: replica, spaceId: 'mirror' })

      const onSource = await call({
        server: source,
        path: '/space/home/notes/contested'
      })
      const onReplica = await call({
        server: replica,
        path: '/space/mirror/notes/contested'
      })
      assert.deepStrictEqual(onSource.json(), { from: 'replica' })
      assert.deepStrictEqual(onReplica.json(), { from: 'replica' })
      assert.equal(onSource.headers.etag, onReplica.headers.etag)

      // And the other way round.
      source.clock.now = Date.UTC(2026, 9, 1, 14, 0, 30)
      replica.clock.now = Date.UTC(2026, 9, 1, 14, 0, 0)
      await call({
        server: replica,
        path: '/space/mirror/notes/contested',
        method: 'PUT',
        json: { from: 'replica, earlier' }
      })
      await call({
        server: source,
        path: '/space/home/notes/contested',
        method: 'PUT',
        json: { from: 'source, later' }
      })
      await pull({ server: source, spaceId: 'home' })
      await pull({ server: replica, spaceId: 'mirror' })
      await pull({ server: source, spaceId: 'home' })
      for (const [server, spaceId] of [
        [source, 'home'],
        [replica, 'mirror']
      ] as const) {
        const read = await call({
          server,
          path: `/space/${spaceId}/notes/contested`
        })
        assert.deepStrictEqual(read.json(), { from: 'source, later' })
      }

      // The replica's own Resource reached the source through the
      // counterpart registration.
      const local = await call({
        server: source,
        path: '/space/home/notes/local-only'
      })
      assert.deepStrictEqual(local.json(), { stays: 'here' })
    })

    it('stalls a Collection on a stamp past the clock bound, and recovers', async () => {
      // The source's clock runs an hour ahead of the replica's.
      source.clock.now = replica.clock.now + 60 * 60 * 1000
      await call({
        server: source,
        path: '/space/home/notes/from-the-future',
        method: 'PUT',
        json: { early: true }
      })
      await pull({ server: replica, spaceId: 'mirror' })
      let status = await statusOf({ server: replica, spaceId: 'mirror' })
      assert.equal(status.state, 'stalled')
      const [notes] = status.collections
      assert.equal(notes.state, 'stalled')
      assert.equal(notes.stall.reason, 'clock-bound')
      assert.ok(notes.stall.since)
      const absent = await call({
        server: replica,
        path: '/space/mirror/notes/from-the-future'
      })
      assert.equal(absent.statusCode, 404)

      // The stall clears itself once local time catches up.
      replica.clock.now = source.clock.now
      await pull({ server: replica, spaceId: 'mirror' })
      status = await statusOf({ server: replica, spaceId: 'mirror' })
      assert.equal(status.collections[0].state, 'synced')
      assert.equal(status.collections[0].stall, undefined)
      const arrived = await call({
        server: replica,
        path: '/space/mirror/notes/from-the-future'
      })
      assert.deepStrictEqual(arrived.json(), { early: true })
    })

    it('carries a Collection delete as a tombstone', async () => {
      source.clock.now += 5_000
      const deleted = await call({
        server: source,
        path: '/space/home/notes/',
        method: 'DELETE'
      })
      assert.equal(deleted.statusCode, 204)
      await pull({ server: replica, spaceId: 'mirror' })
      const gone = await call({
        server: replica,
        path: '/space/mirror/notes/meta'
      })
      assert.equal(gone.statusCode, 404)
      const listing = await call({
        server: replica,
        path: '/space/mirror/?include=deleted'
      })
      const tombstone = listing
        .json()
        .items.find((item: any) => item.id === 'notes')
      assert.equal(tombstone.deleted, true)
      assert.equal(tombstone.originId, source.backend.originId)
    })

    it('backs off when the peer Space is gone', async () => {
      await createSpace({ server: source, spaceId: 'short-lived' })
      await createSpace({ server: replica, spaceId: 'orphan' })
      const created = await register({
        to: replica,
        toSpaceId: 'orphan',
        from: source,
        fromSpaceId: 'short-lived'
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'orphan' })
      assert.equal(
        (await statusOf({ server: replica, spaceId: 'orphan' })).state,
        'idle'
      )

      await call({
        server: source,
        path: '/space/short-lived/',
        method: 'DELETE'
      })
      await pull({ server: replica, spaceId: 'orphan' })
      const status = await statusOf({ server: replica, spaceId: 'orphan' })
      assert.equal(status.state, 'backing-off')
      assert.ok(Date.parse(status.nextPullAt) > Date.now())
      // The registration stands until the controller removes it.
      const read = await call({
        server: replica,
        path: '/space/orphan/replicas/peer'
      })
      assert.equal(read.statusCode, 200)
    })
  })

  describe('a registration that selects some Collections', () => {
    it('applies a peer tombstone only to a Collection it selects', async () => {
      await createSpace({ server: source, spaceId: 'tomb-src' })
      await createSpace({ server: replica, spaceId: 'tomb-dst' })
      const base =
        Math.max(source.clock.now, replica.clock.now) + 10 * 60 * 1000
      // The replica's own Collection is created before the source deletes
      // its namesake, so the tombstone's stamp sorts above it.
      replica.clock.now = base
      source.clock.now = base
      await call({
        server: replica,
        path: '/space/tomb-dst/',
        method: 'POST',
        json: { id: 'photos', name: 'Local photos' }
      })
      const kept = await call({
        server: replica,
        path: '/space/tomb-dst/photos/local',
        method: 'PUT',
        json: { mine: true }
      })
      assert.equal(kept.statusCode, 201, kept.payload)

      source.clock.now = base + 1_000
      await call({
        server: source,
        path: '/space/tomb-src/',
        method: 'POST',
        json: { id: 'photos', name: 'Photos' }
      })
      await call({
        server: source,
        path: '/space/tomb-src/',
        method: 'POST',
        json: { id: 'notes', name: 'Notes' }
      })
      await call({
        server: source,
        path: '/space/tomb-src/notes/one',
        method: 'PUT',
        json: { n: 1 }
      })
      source.clock.now = base + 5_000
      const deleted = await call({
        server: source,
        path: '/space/tomb-src/photos/',
        method: 'DELETE'
      })
      assert.equal(deleted.statusCode, 204)

      const created = await register({
        to: replica,
        toSpaceId: 'tomb-dst',
        from: source,
        fromSpaceId: 'tomb-src',
        overrides: { collections: [{ id: 'notes' }] }
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'tomb-dst' })

      const notes = await call({
        server: replica,
        path: '/space/tomb-dst/notes/one'
      })
      assert.deepStrictEqual(notes.json(), { n: 1 })
      const photos = await call({
        server: replica,
        path: '/space/tomb-dst/photos/meta'
      })
      assert.equal(photos.statusCode, 200, photos.payload)
      const local = await call({
        server: replica,
        path: '/space/tomb-dst/photos/local'
      })
      assert.deepStrictEqual(local.json(), { mine: true })
    })
  })

  describe('a registration with a hostile id', () => {
    it('does not reach another Space through an encoded path in DELETE or GET', async () => {
      await createSpace({ server: replica, spaceId: 'inj-a' })
      await createSpace({ server: replica, spaceId: 'inj-b' })
      const hostile = 'x%2F..%2F..%2Finj-b%2F.space.inj-b'

      const removed = await call({
        server: replica,
        path: `/space/inj-a/replicas/${hostile}`,
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204, removed.payload)
      const meta = await call({ server: replica, path: '/space/inj-b/meta' })
      assert.equal(meta.statusCode, 200, meta.payload)
      assert.equal(meta.json().id, 'inj-b')

      const read = await call({
        server: replica,
        path: `/space/inj-a/replicas/${hostile}`
      })
      assert.equal(read.statusCode, 404, read.payload)
      const status = await call({
        server: replica,
        path: `/space/inj-a/replicas/${hostile}/status`
      })
      assert.equal(status.statusCode, 404, status.payload)
      const stateSuffix = await call({
        server: replica,
        path: '/space/inj-a/replicas/peer.state'
      })
      assert.equal(stateSuffix.statusCode, 404, stateSuffix.payload)
      const metaAfter = await call({
        server: replica,
        path: '/space/inj-b/meta'
      })
      assert.equal(metaAfter.statusCode, 200)
    })
  })

  describe('a pull loop under faults and large feeds', () => {
    it('schedules the next cycle after a storage fault outside the pull', async () => {
      await createSpace({ server: source, spaceId: 'flt-src' })
      await createSpace({ server: replica, spaceId: 'flt-dst' })
      const created = await register({
        to: replica,
        toSpaceId: 'flt-dst',
        from: source,
        fromSpaceId: 'flt-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'flt-dst' })

      // Fake timers wrap only the faulting cycle. The reschedule delay is
      // the 5 s backoff base, which is not waited out.
      const spy = vi
        .spyOn(replica.backend, 'getReplicaState')
        .mockRejectedValueOnce(new Error('simulated storage fault'))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        vi.clearAllTimers()
        await pull({ server: replica, spaceId: 'flt-dst' })
        assert.equal(spy.mock.calls.length, 1)
        assert.equal(vi.getTimerCount(), 1)
      } finally {
        vi.useRealTimers()
        spy.mockRestore()
      }
      // The loop still pulls.
      await pull({ server: replica, spaceId: 'flt-dst' })
      const status = await statusOf({
        server: replica,
        spaceId: 'flt-dst'
      })
      assert.equal(status.state, 'idle')
    })

    it('keeps a stall that a Collection Metadata change recorded mid-feed', async () => {
      await createSpace({ server: source, spaceId: 'stl-src' })
      await createSpace({ server: replica, spaceId: 'stl-dst' })
      await call({
        server: source,
        path: '/space/stl-src/',
        method: 'POST',
        json: { id: 'items', name: 'Items' }
      })
      await call({
        server: source,
        path: '/space/stl-src/items/one',
        method: 'PUT',
        json: { n: 1 }
      })
      const created = await register({
        to: replica,
        toSpaceId: 'stl-dst',
        from: source,
        fromSpaceId: 'stl-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'stl-dst' })
      let status = await statusOf({ server: replica, spaceId: 'stl-dst' })
      assert.equal(status.collections[0].state, 'synced')

      // The source's Collection Metadata write is stamped an hour ahead.
      source.clock.now =
        Math.max(source.clock.now, replica.clock.now) + 3_600_000
      const renamed = await call({
        server: source,
        path: '/space/stl-src/items/meta',
        method: 'PUT',
        json: { name: 'Renamed' }
      })
      assert.ok(renamed.statusCode < 300, renamed.payload)
      await pull({ server: replica, spaceId: 'stl-dst' })
      status = await statusOf({ server: replica, spaceId: 'stl-dst' })
      assert.equal(status.state, 'stalled')
      assert.equal(status.collections[0].state, 'stalled')
      assert.equal(status.collections[0].stall.reason, 'clock-bound')

      // Once local time catches up, the stall clears.
      replica.clock.now = source.clock.now
      await pull({ server: replica, spaceId: 'stl-dst' })
      status = await statusOf({ server: replica, spaceId: 'stl-dst' })
      assert.equal(status.collections[0].state, 'synced')
    })

    it('halves the feed page size when a page outgrows the buffer', async () => {
      await createSpace({ server: source, spaceId: 'big-src' })
      await createSpace({ server: replica, spaceId: 'big-dst' })
      await call({
        server: source,
        path: '/space/big-src/',
        method: 'POST',
        json: { id: 'bulk', name: 'Bulk' }
      })
      // Twelve inline JSON bodies of about 400 KB exceed the 4 MiB a page
      // may buffer, yet each document alone fits.
      const filler = 'x'.repeat(400 * 1024)
      for (let index = 0; index < 12; index++) {
        const written = await call({
          server: source,
          path: `/space/big-src/bulk/doc-${index}`,
          method: 'PUT',
          json: { index, filler }
        })
        assert.equal(written.statusCode, 201, written.payload)
      }
      const created = await register({
        to: replica,
        toSpaceId: 'big-dst',
        from: source,
        fromSpaceId: 'big-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull({ server: replica, spaceId: 'big-dst' })

      for (let index = 0; index < 12; index++) {
        const copy = await call({
          server: replica,
          path: `/space/big-dst/bulk/doc-${index}`
        })
        assert.equal(copy.statusCode, 200, `doc-${index}`)
        assert.equal(copy.json().index, index)
      }
      const status = await statusOf({ server: replica, spaceId: 'big-dst' })
      assert.deepStrictEqual(
        status.collections.map(({ id, state }: any) => ({ id, state })),
        [{ id: 'bulk', state: 'synced' }]
      )
    })
  })

  describe("a registration's check of the immutable members", () => {
    it('does not compare two lives of one Collection id', async () => {
      await createSpace({ server: source, spaceId: 'lives-src' })
      await createSpace({ server: replica, spaceId: 'lives-dst' })
      // Each server creates its own `notes`, so the two generations differ.
      // The apply path replaces one life or skips the other, and merges
      // neither.
      await call({
        server: source,
        path: '/space/lives-src/',
        method: 'POST',
        json: { id: 'notes', revisions: { immutable: true } }
      })
      await call({
        server: replica,
        path: '/space/lives-dst/',
        method: 'POST',
        json: { id: 'notes' }
      })
      const created = await register({
        to: replica,
        toSpaceId: 'lives-dst',
        from: source,
        fromSpaceId: 'lives-src'
      })
      assert.equal(created.statusCode, 201, created.payload)
    })

    it('admits one life both servers hold under log governance', async () => {
      await createSpace({ server: source, spaceId: 'gov-src' })
      await createSpace({ server: replica, spaceId: 'gov-dst' })
      // The stored object keeps the `revisions` the create declared. The
      // served one derives its descriptors from the log, which restates it.
      await call({
        server: source,
        path: '/space/gov-src/',
        method: 'POST',
        json: { id: 'vault', revisions: { immutable: true } }
      })
      const governed = await call({
        server: source,
        path: '/space/gov-src/vault/meta/log',
        method: 'PUT',
        body: new TextEncoder().encode(
          genesisLine({ ...oneEpoch, revisions: { immutable: true } }) + '\n'
        ),
        contentType: 'text/jsonl',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(governed.statusCode, 204, governed.payload)
      const forward = await register({
        to: replica,
        toSpaceId: 'gov-dst',
        from: source,
        fromSpaceId: 'gov-src'
      })
      assert.equal(forward.statusCode, 201, forward.payload)
      await pull({ server: replica, spaceId: 'gov-dst' })

      // The counterpart reads the replica's copy of the same life.
      const counterpart = await register({
        to: source,
        toSpaceId: 'gov-src',
        from: replica,
        fromSpaceId: 'gov-dst'
      })
      assert.equal(counterpart.statusCode, 201, counterpart.payload)
    })
  })
})
