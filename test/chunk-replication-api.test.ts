/**
 * Chunk replication between servers booted in one process: the chunk pull of
 * the replication facet, end to end. A registration whose source server lists
 * the Encrypted Collections entry reads each changed Resource's chunk listing,
 * stages the chunks it does not hold, closes on a read of the parent, and
 * applies the parent and its chunk set in one critical section.
 *
 * The servers are named `https://source.example`, `https://replica.example`
 * and `https://third.example` and never listen, as in
 * `replication-api.test.ts`. Each pull loop reaches its peer through the
 * plugin's `peerFetch` option, here a scripted transport over
 * `fastify.inject` that records every request and can hold or refuse the
 * ones a test names. Every pull is run by hand (`replication.pullNow`) with
 * the timers paused.
 */
import { it, describe, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { chunkDirName, readSpaceArchive } from '@interop/space-archive'

import {
  REPLICA_CHUNK_PULL_CONCURRENCY,
  REPLICA_CHUNK_PULL_RETRY_LIMIT,
  REPLICA_STATE_PERSIST_DOCUMENTS
} from '../src/config.default.js'
import type { PeerFetch, PeerResponse } from '../src/sync/peerFetch.js'
import {
  importArchive,
  parseEtagSegments,
  createPeerSpace,
  pathExists,
  pullOnce,
  verifyProvenanceOffline,
  zcapClients
} from './helpers.js'
import {
  type PeerServer,
  bootPeerServer,
  injectPeerFetch,
  signedInject,
  registerReplica,
  replicaStatus
} from '../src/testing.js'

/**
 * One request a pull loop made, as the scripted transport saw it. `status`
 * is set once the answer is known.
 */
interface Exchange {
  url: string
  status?: number
}

/**
 * A rule of the scripted transport: the requests it matches, how many more
 * it takes, and what it does with one. `run` resolves a response to answer
 * with, or `undefined` to forward the request.
 */
interface TransportRule {
  match: (url: string) => boolean
  remaining: number
  run: () => Promise<PeerResponse | undefined>
}

/**
 * The transport every pull loop uses: it hands each request to the app the
 * URL's origin names, records it, and applies the first rule that matches.
 * @param servers {Map<string, { fastify: FastifyInstance }>}
 * @returns {object}   the `peerFetch` to hand the apps, the record of
 *   exchanges, and the controls a test scripts the transport with
 */
function scriptedTransport(servers: Map<string, { fastify: FastifyInstance }>) {
  const forward = injectPeerFetch(servers)
  const exchanges: Exchange[] = []
  let rules: TransportRule[] = []

  const peerFetch: PeerFetch = async options => {
    const exchange: Exchange = { url: options.url }
    exchanges.push(exchange)
    const rule = rules.find(
      ({ match, remaining }) => remaining > 0 && match(options.url)
    )
    let response: PeerResponse | undefined
    if (rule !== undefined) {
      rule.remaining--
      response = await rule.run()
    }
    response ??= await forward(options)
    exchange.status = response.status
    return response
  }

  /**
   * Holds the next request to `url` until the test releases it. The request
   * reaches the peer only on release, so a write made while it is held is
   * what the peer answers it with.
   * @param url {string}
   * @returns {{ reached: Promise<void>, release: () => void }}
   */
  function hold(url: string): { reached: Promise<void>; release: () => void } {
    let reach: () => void = () => {}
    let release: () => void = () => {}
    const reached = new Promise<void>(resolve => {
      reach = resolve
    })
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    rules.push({
      match: candidate => candidate === url,
      remaining: 1,
      run: async () => {
        reach()
        await released
        return undefined
      }
    })
    return { reached, release }
  }

  /**
   * Answers requests to `url` with `status` and an empty body, `times`
   * times.
   * @param url {string}
   * @param status {number}
   * @param [times] {number}   defaults to every request
   */
  function refuse(url: string, status: number, times = Infinity): void {
    rules.push({
      match: candidate => candidate === url,
      remaining: times,
      run: async () => ({
        status,
        headers: { get: () => null },
        body: new Blob([]).stream(),
        release: () => {}
      })
    })
  }

  /**
   * Drops every rule and the record of exchanges.
   */
  function reset(): void {
    rules = []
    exchanges.length = 0
  }

  return { peerFetch, exchanges, hold, refuse, reset }
}

const servers = new Map<string, PeerServer>()
const transport = scriptedTransport(servers)

/**
 * Boots one server with an identity whose key may invoke, so it can pull.
 */
async function boot(options: {
  serverUrl: string
  start: number
}): Promise<PeerServer> {
  return bootPeerServer({
    ...options,
    prefix: 'was-chunk-replication-',
    peerFetch: transport.peerFetch,
    servers
  })
}

describe('Chunk replication between servers', () => {
  let source: PeerServer, replica: PeerServer, third: PeerServer
  let alice: { did: string; signer: any }

  /**
   * Sends one signed request to a server, under Alice's root capability of
   * the Space the path is under.
   */
  async function call(
    request: Omit<Parameters<typeof signedInject>[0], 'signer'>
  ) {
    return signedInject({ signer: alice.signer, ...request })
  }

  /**
   * Creates a Space under Alice's key on a server.
   */
  async function createSpace({
    server,
    spaceId
  }: {
    server: PeerServer
    spaceId: string
  }): Promise<void> {
    await createPeerSpace({ server, spaceId, controller: alice.did })
  }

  /**
   * Registers `from`'s Space as a source of `to`'s, with a `GET`-only pull
   * capability Alice delegates to `to`'s DID, and asserts the registration
   * records that the source lists chunk sets.
   */
  async function register({
    from,
    fromSpaceId,
    to,
    toSpaceId,
    replicaId = 'peer'
  }: {
    from: PeerServer
    fromSpaceId: string
    to: PeerServer
    toSpaceId: string
    replicaId?: string
  }): Promise<void> {
    const created = await registerReplica({
      signer: alice.signer,
      delegator: alice,
      from,
      fromSpaceId,
      to,
      toSpaceId,
      replicaId
    })
    assert.equal(created.statusCode, 201, created.payload)
    const stored = (await to.backend.listAllReplicas()).find(
      stored => stored.spaceId === toSpaceId && stored.record.id === replicaId
    )
    assert.equal(stored?.pullsChunks, true)
  }

  /**
   * Creates the source Space with a `files` Collection, the replica Space,
   * and the registration that pulls one from the other.
   */
  async function pair({
    from = source,
    fromSpaceId,
    to = replica,
    toSpaceId,
    collection = {}
  }: {
    from?: PeerServer
    fromSpaceId: string
    to?: PeerServer
    toSpaceId: string
    collection?: Record<string, unknown>
  }): Promise<void> {
    await createSpace({ server: from, spaceId: fromSpaceId })
    await createSpace({ server: to, spaceId: toSpaceId })
    const created = await call({
      server: from,
      path: `/space/${fromSpaceId}/`,
      method: 'POST',
      json: { id: 'files', name: 'Files', ...collection }
    })
    assert.equal(created.statusCode, 201, created.payload)
    await register({ from, fromSpaceId, to, toSpaceId })
  }

  const pull = pullOnce

  /**
   * Reads a registration's status, as Alice.
   */
  async function statusOf({
    server,
    spaceId,
    replicaId = 'peer'
  }: {
    server: PeerServer
    spaceId: string
    replicaId?: string
  }) {
    return replicaStatus({ signer: alice.signer, server, spaceId, replicaId })
  }

  /**
   * The status of the `files` Collection of a registration.
   */
  async function filesStatus(options: {
    server: PeerServer
    spaceId: string
    replicaId?: string
  }) {
    const status = await statusOf(options)
    return status.collections.find(({ id }: any) => id === 'files')
  }

  /**
   * The checkpoint a registration's loop state holds for `files`.
   */
  async function heldCheckpoint({
    server,
    spaceId
  }: {
    server: PeerServer
    spaceId: string
  }): Promise<string | undefined> {
    const state = await server.backend.getReplicaState({
      spaceId,
      replicaId: 'peer'
    })
    return state?.collections.files?.checkpoint
  }

  /**
   * Writes a Resource of the `files` Collection: a JSON body, or binary
   * bytes. Resolves the parent's `ETag`.
   */
  async function putParent({
    server,
    spaceId,
    resourceId,
    json,
    bytes
  }: {
    server: PeerServer
    spaceId: string
    resourceId: string
    json?: object
    bytes?: Uint8Array
  }): Promise<string> {
    const written = await call({
      server,
      path: `/space/${spaceId}/files/${resourceId}`,
      method: 'PUT',
      ...(json !== undefined && { json }),
      ...(bytes !== undefined && {
        body: bytes,
        contentType: 'application/octet-stream'
      })
    })
    assert.ok(written.statusCode < 300, written.payload)
    return String(written.headers.etag)
  }

  /**
   * Writes chunks of a Resource through raw `PUT`s, at indexes `from`,
   * `from + 1`, and so on.
   */
  async function putChunks({
    server,
    spaceId,
    resourceId,
    chunks,
    from = 0
  }: {
    server: PeerServer
    spaceId: string
    resourceId: string
    chunks: Uint8Array[]
    from?: number
  }): Promise<void> {
    for (const [offset, bytes] of chunks.entries()) {
      const written = await call({
        server,
        path: `/space/${spaceId}/files/${resourceId}/chunks/${from + offset}`,
        method: 'PUT',
        body: bytes,
        contentType: 'application/octet-stream'
      })
      assert.ok(written.statusCode < 300, written.payload)
    }
  }

  /**
   * Deletes one chunk of a Resource.
   */
  async function deleteChunk({
    server,
    spaceId,
    resourceId,
    index
  }: {
    server: PeerServer
    spaceId: string
    resourceId: string
    index: number
  }): Promise<void> {
    const deleted = await call({
      server,
      path: `/space/${spaceId}/files/${resourceId}/chunks/${index}`,
      method: 'DELETE'
    })
    assert.ok(deleted.statusCode < 300, deleted.payload)
  }

  /**
   * Reads a Resource's chunk listing and each listed chunk: the listing's
   * entries, and each chunk's bytes, `ETag` and content type. `undefined`
   * when the listing answers 404.
   */
  async function readChunks({
    server,
    spaceId,
    resourceId
  }: {
    server: PeerServer
    spaceId: string
    resourceId: string
  }): Promise<
    | {
        listed: Array<{
          index: number
          size: number
          contentType: string
          etag: string
        }>
        chunks: Array<{ bytes: Buffer; etag: string; contentType: string }>
      }
    | undefined
  > {
    const listing = await call({
      server,
      path: `/space/${spaceId}/files/${resourceId}/chunks/`
    })
    if (listing.statusCode === 404) {
      return undefined
    }
    assert.equal(listing.statusCode, 200, listing.payload)
    const listed = listing.json().chunks
    const chunks = []
    for (const { index } of listed) {
      const read = await call({
        server,
        path: `/space/${spaceId}/files/${resourceId}/chunks/${index}`
      })
      assert.equal(read.statusCode, 200, read.payload)
      chunks.push({
        bytes: read.rawPayload,
        etag: String(read.headers.etag),
        contentType: String(read.headers['content-type'])
      })
    }
    return { listed, chunks }
  }

  /**
   * Asserts that a Resource's chunks on a server carry exactly `expected`,
   * at indexes `indexes` (by default `0..n-1`).
   */
  async function assertChunks({
    server,
    spaceId,
    resourceId,
    expected,
    indexes = expected.map((_bytes, index) => index)
  }: {
    server: PeerServer
    spaceId: string
    resourceId: string
    expected: Uint8Array[]
    indexes?: number[]
  }): Promise<void> {
    const read = await readChunks({ server, spaceId, resourceId })
    assert.ok(read, `${server.serverUrl} lists the chunks of ${resourceId}`)
    assert.deepStrictEqual(
      read.listed.map(({ index }) => index),
      indexes
    )
    for (const [position, bytes] of expected.entries()) {
      assert.ok(
        read.chunks[position]!.bytes.equals(Buffer.from(bytes)),
        `chunk ${indexes[position]} on ${server.serverUrl}`
      )
    }
  }

  /**
   * Reads a Resource of the `files` Collection.
   */
  async function readParent({
    server,
    spaceId,
    resourceId
  }: {
    server: PeerServer
    spaceId: string
    resourceId: string
  }) {
    return call({ server, path: `/space/${spaceId}/files/${resourceId}` })
  }

  /**
   * The absolute URL of a path on the source server.
   */
  function sourceUrl(pathname: string): string {
    return `${source.serverUrl}${pathname}`
  }

  /**
   * The `files` Collection directory of a Space on a server.
   */
  function filesDir({
    server,
    spaceId
  }: {
    server: PeerServer
    spaceId: string
  }): string {
    return path.join(server.backend.dataDir, 'spaces', spaceId, 'files')
  }

  const exists = pathExists

  /**
   * Moves every server's clock to one instant past the latest, so no write
   * of one server reads as ahead of another's clock bound.
   */
  function alignClocks(): void {
    const now =
      Math.max(...[source, replica, third].map(({ clock }) => clock.now)) +
      1_000
    for (const server of [source, replica, third]) {
      server.clock.now = now
    }
  }

  /**
   * Distinct random bytes, one buffer per size.
   */
  function blobs(...sizes: number[]): Buffer[] {
    return sizes.map(size => randomBytes(size))
  }

  beforeAll(async () => {
    const identities = await zcapClients({
      baseServerUrl: 'https://unused.example'
    })
    alice = identities.alice
    source = await boot({
      serverUrl: 'https://source.example',
      start: Date.UTC(2026, 9, 1, 12, 0, 0)
    })
    replica = await boot({
      serverUrl: 'https://replica.example',
      start: Date.UTC(2026, 9, 1, 12, 0, 1)
    })
    third = await boot({
      serverUrl: 'https://third.example',
      start: Date.UTC(2026, 9, 1, 12, 0, 2)
    })
  })

  beforeEach(() => {
    transport.reset()
  })

  afterAll(async () => {
    await source?.fastify.close()
    await replica?.fastify.close()
    await third?.fastify.close()
  })

  describe('a first pull', () => {
    const chunks = blobs(3000, 5000, 700)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c1-src', toSpaceId: 'c1-dst' })
      await putParent({
        server: source,
        spaceId: 'c1-src',
        resourceId: 'stream',
        json: { manifest: 'one' }
      })
      await putChunks({
        server: source,
        spaceId: 'c1-src',
        resourceId: 'stream',
        chunks
      })
    })

    it('makes the parent and its set visible together, each chunk under an ETag the replica mints', async () => {
      const closing = transport.hold(sourceUrl('/space/c1-src/files/stream'))
      const pulling = pull({ server: replica, spaceId: 'c1-dst' })
      try {
        await closing.reached
        // Every chunk is staged, and nothing is served yet.
        const staged = await replica.backend.listStagedChunks({
          spaceId: 'c1-dst',
          collectionId: 'files',
          resourceId: 'stream',
          run: {
            replicaId: 'peer',
            parentEtag: String(
              (
                await readParent({
                  server: source,
                  spaceId: 'c1-src',
                  resourceId: 'stream'
                })
              ).headers.etag
            )
          }
        })
        assert.deepStrictEqual(
          staged.map(({ index }) => index),
          [0, 1, 2]
        )
        const parent = await readParent({
          server: replica,
          spaceId: 'c1-dst',
          resourceId: 'stream'
        })
        assert.equal(parent.statusCode, 404)
        assert.equal(
          await readChunks({
            server: replica,
            spaceId: 'c1-dst',
            resourceId: 'stream'
          }),
          undefined
        )
      } finally {
        closing.release()
        await pulling
      }

      const original = await readChunks({
        server: source,
        spaceId: 'c1-src',
        resourceId: 'stream'
      })
      const copy = await readChunks({
        server: replica,
        spaceId: 'c1-dst',
        resourceId: 'stream'
      })
      assert.ok(original && copy)
      // The listings agree on the set; each server lists its own chunk ETags.
      const withoutEtag = ({
        index,
        size,
        contentType
      }: (typeof copy.listed)[number]) => ({ index, size, contentType })
      assert.deepStrictEqual(
        copy.listed.map(withoutEtag),
        original.listed.map(withoutEtag)
      )
      for (const [index, chunk] of copy.chunks.entries()) {
        assert.ok(chunk.bytes.equals(chunks[index]!), `chunk ${index}`)
        assert.equal(chunk.contentType, original.chunks[index]!.contentType)
        assert.notEqual(chunk.etag, original.chunks[index]!.etag)
        assert.equal(copy.listed[index]!.etag, chunk.etag)
        assert.equal(original.listed[index]!.etag, original.chunks[index]!.etag)
        assert.equal(
          parseEtagSegments(chunk.etag).stamp.originId,
          replica.backend.originId
        )
      }
      const parent = await readParent({
        server: replica,
        spaceId: 'c1-dst',
        resourceId: 'stream'
      })
      assert.deepStrictEqual(parent.json(), { manifest: 'one' })
      const status = await filesStatus({ server: replica, spaceId: 'c1-dst' })
      assert.equal(status.state, 'synced')
    })

    it('reads no chunk on a pull with nothing new', async () => {
      await pull({ server: replica, spaceId: 'c1-dst' })
      assert.equal(
        transport.exchanges.filter(({ url }) => url.includes('/chunks')).length,
        0
      )
    })
  })

  describe('a re-run of an interrupted chunk pull', () => {
    const before = blobs(1000, 1000, 1000)
    const after = blobs(2000, 2100, 2200)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c2-src', toSpaceId: 'c2-dst' })
      await putParent({
        server: source,
        spaceId: 'c2-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c2-src',
        resourceId: 'r',
        chunks: before
      })
      await pull({ server: replica, spaceId: 'c2-dst' })
    })

    it('keeps each chunk staged under its listed source ETag and moves only the missing one', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      await putChunks({
        server: source,
        spaceId: 'c2-src',
        resourceId: 'r',
        chunks: after
      })
      const parentEtag = await putParent({
        server: source,
        spaceId: 'c2-src',
        resourceId: 'r',
        json: { revision: 'B' }
      })
      const sourceSet = await readChunks({
        server: source,
        spaceId: 'c2-src',
        resourceId: 'r'
      })
      assert.ok(sourceSet)

      // The first run stops at the third chunk.
      transport.refuse(sourceUrl('/space/c2-src/files/r/chunks/2'), 503, 1)
      await pull({ server: replica, spaceId: 'c2-dst' })
      const staged = await replica.backend.listStagedChunks({
        spaceId: 'c2-dst',
        collectionId: 'files',
        resourceId: 'r',
        run: { replicaId: 'peer', parentEtag }
      })
      assert.deepStrictEqual(
        staged.map(({ index, peerEtag }) => ({ index, peerEtag })),
        [
          { index: 0, peerEtag: sourceSet.chunks[0]!.etag },
          { index: 1, peerEtag: sourceSet.chunks[1]!.etag }
        ]
      )
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c2-dst' })).state,
        'syncing'
      )
      // The previous revision is served whole until the swap.
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'c2-dst',
            resourceId: 'r'
          })
        ).json(),
        { revision: 'A' }
      )
      await assertChunks({
        server: replica,
        spaceId: 'c2-dst',
        resourceId: 'r',
        expected: before
      })

      transport.reset()
      await pull({ server: replica, spaceId: 'c2-dst' })
      const chunkReads = transport.exchanges.filter(({ url }) =>
        /\/chunks\/\d+$/.test(url)
      )
      // The two staged chunks are listed under the ETags they were staged
      // under, so only the third is read.
      assert.deepStrictEqual(
        chunkReads.map(({ url, status }) => ({ url, status })),
        [{ url: sourceUrl('/space/c2-src/files/r/chunks/2'), status: 200 }]
      )
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'c2-dst',
            resourceId: 'r'
          })
        ).json(),
        { revision: 'B' }
      )
      await assertChunks({
        server: replica,
        spaceId: 'c2-dst',
        resourceId: 'r',
        expected: after
      })
      assert.deepStrictEqual(
        await replica.backend.listStagedChunks({
          spaceId: 'c2-dst',
          collectionId: 'files',
          resourceId: 'r',
          run: { replicaId: 'peer', parentEtag }
        }),
        []
      )
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c2-dst' })).state,
        'synced'
      )
    })
  })

  describe('a chunk removed on the source', () => {
    const chunks = blobs(800, 900, 1000)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c3-src', toSpaceId: 'c3-dst' })
      await putParent({
        server: source,
        spaceId: 'c3-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c3-src',
        resourceId: 'r',
        chunks
      })
      await pull({ server: replica, spaceId: 'c3-dst' })
    })

    it('is removed on the replica with the next parent write, and not before', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      await deleteChunk({
        server: source,
        spaceId: 'c3-src',
        resourceId: 'r',
        index: 1
      })
      await putParent({
        server: source,
        spaceId: 'c3-src',
        resourceId: 'r',
        json: { revision: 'B' }
      })
      await pull({ server: replica, spaceId: 'c3-dst' })
      await assertChunks({
        server: replica,
        spaceId: 'c3-dst',
        resourceId: 'r',
        expected: [chunks[0]!, chunks[2]!],
        indexes: [0, 2]
      })

      // A chunk-only delete moves no feed document, so nothing follows it.
      await deleteChunk({
        server: source,
        spaceId: 'c3-src',
        resourceId: 'r',
        index: 2
      })
      await pull({ server: replica, spaceId: 'c3-dst' })
      await assertChunks({
        server: replica,
        spaceId: 'c3-dst',
        resourceId: 'r',
        expected: [chunks[0]!, chunks[2]!],
        indexes: [0, 2]
      })
    })
  })

  describe('a revision rewritten during its chunk pull', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c4-src', toSpaceId: 'c4-dst' })
    })

    it('never serves the chunks of the earlier revision, and converges on the later one', async () => {
      const revisionA = blobs(1500, 1600)
      const revisionB = blobs(2500, 2600, 2700)
      await putParent({
        server: source,
        spaceId: 'c4-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c4-src',
        resourceId: 'r',
        chunks: revisionA
      })

      const firstChunk = transport.hold(
        sourceUrl('/space/c4-src/files/r/chunks/0')
      )
      const pulling = pull({ server: replica, spaceId: 'c4-dst' })
      try {
        await firstChunk.reached
        // Revision B lands on the source between the listing and the
        // first chunk read.
        source.clock.now += 1_000
        replica.clock.now += 1_000
        await putChunks({
          server: source,
          spaceId: 'c4-src',
          resourceId: 'r',
          chunks: revisionB
        })
        await putParent({
          server: source,
          spaceId: 'c4-src',
          resourceId: 'r',
          json: { revision: 'B' }
        })
      } finally {
        firstChunk.release()
        await pulling
      }
      // The closing read saw the parent move: nothing landed.
      const closing = transport.exchanges.find(
        ({ url }) => url === sourceUrl('/space/c4-src/files/r')
      )
      assert.equal(closing?.status, 200)
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c4-dst' })).state,
        'syncing'
      )
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'c4-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )
      assert.equal(
        await readChunks({
          server: replica,
          spaceId: 'c4-dst',
          resourceId: 'r'
        }),
        undefined
      )

      await pull({ server: replica, spaceId: 'c4-dst' })
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'c4-dst',
            resourceId: 'r'
          })
        ).json(),
        { revision: 'B' }
      )
      await assertChunks({
        server: replica,
        spaceId: 'c4-dst',
        resourceId: 'r',
        expected: revisionB
      })
    })
  })

  describe('a parent rewritten before the closing read', () => {
    const chunks = blobs(1200, 1300)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c6-src', toSpaceId: 'c6-dst' })
      await putParent({
        server: source,
        spaceId: 'c6-src',
        resourceId: 'bin',
        bytes: Buffer.from('first')
      })
      await putChunks({
        server: source,
        spaceId: 'c6-src',
        resourceId: 'bin',
        chunks
      })
    })

    it('ends the pull in a retry that holds the checkpoint, then converges', async () => {
      const closing = transport.hold(sourceUrl('/space/c6-src/files/bin'))
      const pulling = pull({ server: replica, spaceId: 'c6-dst' })
      try {
        await closing.reached
        source.clock.now += 1_000
        replica.clock.now += 1_000
        await putParent({
          server: source,
          spaceId: 'c6-src',
          resourceId: 'bin',
          bytes: Buffer.from('second')
        })
      } finally {
        closing.release()
        await pulling
      }
      assert.equal(
        transport.exchanges.find(
          ({ url }) => url === sourceUrl('/space/c6-src/files/bin')
        )?.status,
        200
      )
      // The checkpoint holds before the document, so the next pull reads it
      // again.
      const checkpoint = await heldCheckpoint({
        server: replica,
        spaceId: 'c6-dst'
      })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c6-dst' })).state,
        'syncing'
      )
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'c6-dst',
            resourceId: 'bin'
          })
        ).statusCode,
        404
      )

      await pull({ server: replica, spaceId: 'c6-dst' })
      assert.notEqual(
        await heldCheckpoint({ server: replica, spaceId: 'c6-dst' }),
        checkpoint
      )
      const parent = await readParent({
        server: replica,
        spaceId: 'c6-dst',
        resourceId: 'bin'
      })
      assert.equal(parent.rawPayload.toString(), 'second')
      assert.equal(
        parent.headers.etag,
        (
          await readParent({
            server: source,
            spaceId: 'c6-src',
            resourceId: 'bin'
          })
        ).headers.etag
      )
      await assertChunks({
        server: replica,
        spaceId: 'c6-dst',
        resourceId: 'bin',
        expected: chunks
      })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c6-dst' })).state,
        'synced'
      )
    })
  })

  describe('a two-way pair', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c5-a', toSpaceId: 'c5-b' })
      await register({
        from: replica,
        fromSpaceId: 'c5-b',
        to: source,
        toSpaceId: 'c5-a',
        replicaId: 'back'
      })
      await putParent({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'r',
        json: { from: 'source', revision: 0 }
      })
      await putChunks({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'r',
        chunks: blobs(500, 500, 500)
      })
      await pull({ server: replica, spaceId: 'c5-b' })
      await pull({ server: source, spaceId: 'c5-a', replicaId: 'back' })
    })

    it('converges both servers on the winning parent and its whole set', async () => {
      alignClocks()
      const base = source.clock.now
      // The source rewrites the stream as four chunks.
      const fromSource = blobs(600, 610, 620, 630)
      await putChunks({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'r',
        chunks: fromSource
      })
      await putParent({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'r',
        json: { from: 'source', revision: 1 }
      })
      // The replica rewrites it as two, later.
      replica.clock.now = base + 30_000
      const fromReplica = blobs(700, 710)
      await putChunks({
        server: replica,
        spaceId: 'c5-b',
        resourceId: 'r',
        chunks: fromReplica
      })
      await deleteChunk({
        server: replica,
        spaceId: 'c5-b',
        resourceId: 'r',
        index: 2
      })
      await putParent({
        server: replica,
        spaceId: 'c5-b',
        resourceId: 'r',
        json: { from: 'replica', revision: 1 }
      })

      await pull({ server: replica, spaceId: 'c5-b' })
      await pull({ server: source, spaceId: 'c5-a', replicaId: 'back' })
      await pull({ server: replica, spaceId: 'c5-b' })

      for (const [server, spaceId] of [
        [source, 'c5-a'],
        [replica, 'c5-b']
      ] as const) {
        assert.deepStrictEqual(
          (await readParent({ server, spaceId, resourceId: 'r' })).json(),
          { from: 'replica', revision: 1 }
        )
        await assertChunks({
          server,
          spaceId,
          resourceId: 'r',
          expected: fromReplica
        })
      }
      assert.equal(
        (await readParent({ server: source, spaceId: 'c5-a', resourceId: 'r' }))
          .headers.etag,
        (
          await readParent({
            server: replica,
            spaceId: 'c5-b',
            resourceId: 'r'
          })
        ).headers.etag
      )
    })

    it('leaves the source set untouched when the source pulls its own revision back', async () => {
      alignClocks()
      const chunks = blobs(900, 910, 920)
      await putParent({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'echo',
        json: { echo: true }
      })
      await putChunks({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'echo',
        chunks
      })
      const before = await readChunks({
        server: source,
        spaceId: 'c5-a',
        resourceId: 'echo'
      })
      assert.ok(before)

      // The source pulls back while the replica's chunk pull is incomplete.
      const secondChunk = transport.hold(
        sourceUrl('/space/c5-a/files/echo/chunks/1')
      )
      const pulling = pull({ server: replica, spaceId: 'c5-b' })
      try {
        await secondChunk.reached
        await pull({ server: source, spaceId: 'c5-a', replicaId: 'back' })
        assert.deepStrictEqual(
          await readChunks({
            server: source,
            spaceId: 'c5-a',
            resourceId: 'echo'
          }),
          before
        )
      } finally {
        secondChunk.release()
        await pulling
      }

      // And once the replica holds it: an equal stamp reads no chunk.
      transport.reset()
      await pull({ server: source, spaceId: 'c5-a', replicaId: 'back' })
      assert.deepStrictEqual(
        transport.exchanges.filter(({ url }) =>
          url.startsWith(`${replica.serverUrl}/space/c5-b/files/echo/chunks`)
        ),
        []
      )
      assert.deepStrictEqual(
        await readChunks({
          server: source,
          spaceId: 'c5-a',
          resourceId: 'echo'
        }),
        before
      )
    })
  })

  describe('the quota', () => {
    const revisionA = blobs(4096, 4096, 4096)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c7-src', toSpaceId: 'c7-dst' })
      await putParent({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        chunks: revisionA
      })
      await pull({ server: replica, spaceId: 'c7-dst' })
      await assertChunks({
        server: replica,
        spaceId: 'c7-dst',
        resourceId: 'r',
        expected: revisionA
      })
    })

    it('stalls a set that does not fit before anything is staged, and clears once it does', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      const revisionB = blobs(256 * 1024, 256 * 1024, 256 * 1024)
      await putChunks({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        chunks: revisionB
      })
      const parentEtag = await putParent({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        json: { revision: 'B' }
      })

      const { usageBytes } = await replica.backend.reportUsage({
        spaceId: 'c7-dst'
      })
      const capacity = replica.backend.capacityBytes
      replica.backend.capacityBytes = usageBytes + 64 * 1024
      try {
        await pull({ server: replica, spaceId: 'c7-dst' })
        const files = await filesStatus({ server: replica, spaceId: 'c7-dst' })
        assert.equal(files.state, 'stalled')
        assert.equal(files.stall.reason, 'quota-exceeded')
        assert.deepStrictEqual(
          transport.exchanges.filter(({ url }) => /\/chunks\/\d+$/.test(url)),
          []
        )
        assert.deepStrictEqual(
          await replica.backend.listStagedChunks({
            spaceId: 'c7-dst',
            collectionId: 'files',
            resourceId: 'r',
            run: { replicaId: 'peer', parentEtag }
          }),
          []
        )
        assert.deepStrictEqual(
          (
            await readParent({
              server: replica,
              spaceId: 'c7-dst',
              resourceId: 'r'
            })
          ).json(),
          { revision: 'A' }
        )
        await assertChunks({
          server: replica,
          spaceId: 'c7-dst',
          resourceId: 'r',
          expected: revisionA
        })
      } finally {
        replica.backend.capacityBytes = capacity
      }

      await pull({ server: replica, spaceId: 'c7-dst' })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c7-dst' })).state,
        'synced'
      )
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'c7-dst',
            resourceId: 'r'
          })
        ).json(),
        { revision: 'B' }
      )
      await assertChunks({
        server: replica,
        spaceId: 'c7-dst',
        resourceId: 'r',
        expected: revisionB
      })
    })

    it('stalls a set with a chunk over the upload cap, and clears once the cap admits it', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      const revisionC = blobs(1024, 64 * 1024)
      await putChunks({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        chunks: revisionC
      })
      await deleteChunk({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        index: 2
      })
      await putParent({
        server: source,
        spaceId: 'c7-src',
        resourceId: 'r',
        json: { revision: 'C' }
      })
      // What the replica holds before the pull, whichever revision the
      // earlier tests left it at: the stalled pull must change neither.
      const heldParent = (
        await readParent({
          server: replica,
          spaceId: 'c7-dst',
          resourceId: 'r'
        })
      ).json()
      const heldChunks = await readChunks({
        server: replica,
        spaceId: 'c7-dst',
        resourceId: 'r'
      })

      const cap = replica.backend.maxUploadBytes
      replica.backend.maxUploadBytes = 32 * 1024
      try {
        await pull({ server: replica, spaceId: 'c7-dst' })
        const files = await filesStatus({ server: replica, spaceId: 'c7-dst' })
        assert.equal(files.state, 'stalled')
        assert.equal(files.stall.reason, 'quota-exceeded')
        assert.deepStrictEqual(
          (
            await readParent({
              server: replica,
              spaceId: 'c7-dst',
              resourceId: 'r'
            })
          ).json(),
          heldParent
        )
        assert.deepStrictEqual(
          await readChunks({
            server: replica,
            spaceId: 'c7-dst',
            resourceId: 'r'
          }),
          heldChunks
        )
      } finally {
        replica.backend.maxUploadBytes = cap
      }

      await pull({ server: replica, spaceId: 'c7-dst' })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c7-dst' })).state,
        'synced'
      )
      await assertChunks({
        server: replica,
        spaceId: 'c7-dst',
        resourceId: 'r',
        expected: revisionC
      })
    })
  })

  describe('a delete during a chunk pull', () => {
    const chunks = blobs(1100, 1200, 1300)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c8-src', toSpaceId: 'c8-dst' })
      await putParent({
        server: source,
        spaceId: 'c8-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c8-src',
        resourceId: 'r',
        chunks
      })
      await pull({ server: replica, spaceId: 'c8-dst' })
    })

    it('ends in a retry at the listing, and the next pull applies the tombstone', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      await putParent({
        server: source,
        spaceId: 'c8-src',
        resourceId: 'r',
        json: { revision: 'B' }
      })
      const listing = transport.hold(sourceUrl('/space/c8-src/files/r/chunks/'))
      const pulling = pull({ server: replica, spaceId: 'c8-dst' })
      try {
        await listing.reached
        const deleted = await call({
          server: source,
          path: '/space/c8-src/files/r',
          method: 'DELETE'
        })
        assert.equal(deleted.statusCode, 204)
      } finally {
        listing.release()
        await pulling
      }
      assert.equal(
        transport.exchanges.find(
          ({ url }) => url === sourceUrl('/space/c8-src/files/r/chunks/')
        )?.status,
        404
      )
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c8-dst' })).state,
        'syncing'
      )
      await assertChunks({
        server: replica,
        spaceId: 'c8-dst',
        resourceId: 'r',
        expected: chunks
      })

      await pull({ server: replica, spaceId: 'c8-dst' })
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'c8-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )
      const collectionDir = filesDir({ server: replica, spaceId: 'c8-dst' })
      assert.equal(
        await exists(path.join(collectionDir, chunkDirName('r'))),
        false
      )
      assert.equal(
        await exists(path.join(collectionDir, `.staging${chunkDirName('r')}`)),
        false
      )
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c8-dst' })).state,
        'synced'
      )
    })
  })

  describe('a chunk deleted during its chunk pull', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c9-src', toSpaceId: 'c9-dst' })
    })

    it('ends in a retry, and the next pull converges on the remaining chunks', async () => {
      const chunks = blobs(1400, 1500, 1600)
      await putParent({
        server: source,
        spaceId: 'c9-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c9-src',
        resourceId: 'r',
        chunks
      })
      // The chunks of a set are read a few at once, so the delete lands
      // while the read of the deleted chunk is held: the source answers that
      // read with a 404.
      const heldChunk = transport.hold(
        sourceUrl('/space/c9-src/files/r/chunks/1')
      )
      const pulling = pull({ server: replica, spaceId: 'c9-dst' })
      try {
        await heldChunk.reached
        await deleteChunk({
          server: source,
          spaceId: 'c9-src',
          resourceId: 'r',
          index: 1
        })
      } finally {
        heldChunk.release()
        await pulling
      }
      assert.equal(
        transport.exchanges.find(
          ({ url }) => url === sourceUrl('/space/c9-src/files/r/chunks/1')
        )?.status,
        404
      )
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c9-dst' })).state,
        'syncing'
      )
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'c9-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )

      await pull({ server: replica, spaceId: 'c9-dst' })
      await assertChunks({
        server: replica,
        spaceId: 'c9-dst',
        resourceId: 'r',
        expected: [chunks[0]!, chunks[2]!],
        indexes: [0, 2]
      })
    })
  })

  describe('a chain of three servers', () => {
    const first = blobs(300, 310, 320)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c10-a', toSpaceId: 'c10-b' })
      await createSpace({ server: third, spaceId: 'c10-c' })
      await register({
        from: replica,
        fromSpaceId: 'c10-b',
        to: third,
        toSpaceId: 'c10-c'
      })
      await putParent({
        server: source,
        spaceId: 'c10-a',
        resourceId: 'r',
        json: { revision: 1 }
      })
      await putChunks({
        server: source,
        spaceId: 'c10-a',
        resourceId: 'r',
        chunks: first
      })
      await pull({ server: replica, spaceId: 'c10-b' })
      await pull({ server: third, spaceId: 'c10-c' })
      await assertChunks({
        server: third,
        spaceId: 'c10-c',
        resourceId: 'r',
        expected: first
      })
    })

    it('serves the downstream server the old revision while the middle one is mid-pull', async () => {
      alignClocks()
      const second = blobs(400, 410, 420)
      await putChunks({
        server: source,
        spaceId: 'c10-a',
        resourceId: 'r',
        chunks: second
      })
      await putParent({
        server: source,
        spaceId: 'c10-a',
        resourceId: 'r',
        json: { revision: 2 }
      })

      const middle = transport.hold(sourceUrl('/space/c10-a/files/r/chunks/1'))
      const pulling = pull({ server: replica, spaceId: 'c10-b' })
      try {
        await middle.reached
        await pull({ server: third, spaceId: 'c10-c' })
        assert.deepStrictEqual(
          (
            await readParent({
              server: third,
              spaceId: 'c10-c',
              resourceId: 'r'
            })
          ).json(),
          { revision: 1 }
        )
        await assertChunks({
          server: third,
          spaceId: 'c10-c',
          resourceId: 'r',
          expected: first
        })
      } finally {
        middle.release()
        await pulling
      }

      await pull({ server: third, spaceId: 'c10-c' })
      assert.deepStrictEqual(
        (
          await readParent({ server: third, spaceId: 'c10-c', resourceId: 'r' })
        ).json(),
        { revision: 2 }
      )
      await assertChunks({
        server: third,
        spaceId: 'c10-c',
        resourceId: 'r',
        expected: second
      })
    })
  })

  describe('a /meta-only write', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c12-src', toSpaceId: 'c12-dst' })
      await putParent({
        server: source,
        spaceId: 'c12-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c12-src',
        resourceId: 'r',
        chunks: blobs(200, 210)
      })
      await pull({ server: replica, spaceId: 'c12-dst' })
    })

    it('replicates its custom member and /meta stamp with no chunk read', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      const written = await call({
        server: source,
        path: '/space/c12-src/files/r/meta',
        method: 'PUT',
        json: { custom: { name: 'Stream' } }
      })
      assert.ok(written.statusCode < 300, written.payload)
      transport.reset()
      await pull({ server: replica, spaceId: 'c12-dst' })
      assert.deepStrictEqual(
        transport.exchanges.filter(({ url }) => url.includes('/chunks')),
        []
      )
      const original = await call({
        server: source,
        path: '/space/c12-src/files/r/meta'
      })
      const copy = await call({
        server: replica,
        path: '/space/c12-dst/files/r/meta'
      })
      assert.deepStrictEqual(copy.json().custom, { name: 'Stream' })
      assert.equal(copy.headers.etag, original.headers.etag)
    })
  })

  describe('an immutable Collection', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({
        fromSpaceId: 'c13-src',
        toSpaceId: 'c13-dst',
        collection: { revisions: { immutable: true } }
      })
      await putParent({
        server: source,
        spaceId: 'c13-src',
        resourceId: 'r',
        json: { life: 1 }
      })
      await putChunks({
        server: source,
        spaceId: 'c13-src',
        resourceId: 'r',
        chunks: blobs(330, 340, 350)
      })
      await pull({ server: replica, spaceId: 'c13-dst' })
    })

    it('replicates the delete; the source refuses a second life with other content', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      const deleted = await call({
        server: source,
        path: '/space/c13-src/files/r',
        method: 'DELETE'
      })
      assert.equal(deleted.statusCode, 204)
      // The tombstone keeps the deleted content's digest, so a write-once
      // Collection cannot be edited through a delete and a re-create: a
      // different body over the tombstone is refused on the source.
      const refused = await call({
        server: source,
        path: '/space/c13-src/files/r',
        method: 'PUT',
        json: { life: 2 }
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.match(refused.json().type, /#resource-immutable$/)
      // The replica takes the tombstone, and the chunk set goes with it.
      await pull({ server: replica, spaceId: 'c13-dst' })
      const files = await filesStatus({ server: replica, spaceId: 'c13-dst' })
      assert.equal(files.state, 'synced', JSON.stringify(files))
      const parent = await readParent({
        server: replica,
        spaceId: 'c13-dst',
        resourceId: 'r'
      })
      assert.equal(parent.statusCode, 404)
      const chunks = await call({
        server: replica,
        path: '/space/c13-dst/files/r/chunks/'
      })
      assert.equal(chunks.statusCode, 404)
    })
  })

  describe('a parent stamp past the clock bound', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c14-src', toSpaceId: 'c14-dst' })
    })

    it('stalls with clock-bound after staging, changes nothing live, and recovers', async () => {
      source.clock.now = replica.clock.now + 60 * 60 * 1000
      const chunks = blobs(410, 420)
      await putParent({
        server: source,
        spaceId: 'c14-src',
        resourceId: 'r',
        json: { early: true }
      })
      await putChunks({
        server: source,
        spaceId: 'c14-src',
        resourceId: 'r',
        chunks
      })
      await pull({ server: replica, spaceId: 'c14-dst' })
      const files = await filesStatus({ server: replica, spaceId: 'c14-dst' })
      assert.equal(files.state, 'stalled')
      assert.equal(files.stall.reason, 'clock-bound')
      // The set was staged before the apply refused the parent.
      const parentEtag = String(
        (
          await readParent({
            server: source,
            spaceId: 'c14-src',
            resourceId: 'r'
          })
        ).headers.etag
      )
      const staged = await replica.backend.listStagedChunks({
        spaceId: 'c14-dst',
        collectionId: 'files',
        resourceId: 'r',
        run: { replicaId: 'peer', parentEtag }
      })
      assert.deepStrictEqual(
        staged.map(({ index }) => index),
        [0, 1]
      )
      assert.equal(
        transport.exchanges.filter(({ url }) => /\/chunks\/\d+$/.test(url))
          .length,
        2
      )
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'c14-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )

      // Once local time catches up, the staged set is reused as it stands,
      // with no chunk read.
      alignClocks()
      transport.reset()
      await pull({ server: replica, spaceId: 'c14-dst' })
      assert.deepStrictEqual(
        transport.exchanges.filter(({ url }) => /\/chunks\/\d+$/.test(url)),
        []
      )
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'c14-dst' })).state,
        'synced'
      )
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'c14-dst',
            resourceId: 'r'
          })
        ).json(),
        { early: true }
      )
      const copy = await readChunks({
        server: replica,
        spaceId: 'c14-dst',
        resourceId: 'r'
      })
      assert.ok(copy)
      for (const [index, chunk] of copy.chunks.entries()) {
        assert.ok(chunk.bytes.equals(chunks[index]!))
        // The chunk carries this server's stamp, not the source's.
        assert.equal(
          parseEtagSegments(chunk.etag).stamp.originId,
          replica.backend.originId
        )
      }
    })
  })

  describe('a replicated tombstone', () => {
    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c15-src', toSpaceId: 'c15-dst' })
      await putParent({
        server: source,
        spaceId: 'c15-src',
        resourceId: 'r',
        json: { doomed: true }
      })
      await putChunks({
        server: source,
        spaceId: 'c15-src',
        resourceId: 'r',
        chunks: blobs(510, 520, 530)
      })
      await pull({ server: replica, spaceId: 'c15-dst' })
      assert.equal(
        await exists(
          path.join(
            filesDir({ server: replica, spaceId: 'c15-dst' }),
            chunkDirName('r')
          )
        ),
        true
      )
    })

    it('leaves no chunk directory on the replica', async () => {
      source.clock.now += 1_000
      replica.clock.now += 1_000
      const deleted = await call({
        server: source,
        path: '/space/c15-src/files/r',
        method: 'DELETE'
      })
      assert.equal(deleted.statusCode, 204)
      await pull({ server: replica, spaceId: 'c15-dst' })
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'c15-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )
      const collectionDir = filesDir({ server: replica, spaceId: 'c15-dst' })
      assert.equal(
        await exists(path.join(collectionDir, chunkDirName('r'))),
        false
      )
      assert.equal(
        await exists(path.join(collectionDir, `.staging${chunkDirName('r')}`)),
        false
      )
    })
  })

  describe('chunk staging', () => {
    it('counts toward usage, and goes with Delete Replica', async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c16-src', toSpaceId: 'c16-dst' })
      await putParent({
        server: source,
        spaceId: 'c16-src',
        resourceId: 'r',
        json: { staged: true }
      })
      await putChunks({
        server: source,
        spaceId: 'c16-src',
        resourceId: 'r',
        chunks: blobs(64 * 1024, 64 * 1024, 64 * 1024)
      })
      const before = await replica.backend.reportUsage({ spaceId: 'c16-dst' })
      transport.refuse(sourceUrl('/space/c16-src/files/r/chunks/2'), 503)
      await pull({ server: replica, spaceId: 'c16-dst' })
      const stagingDir = path.join(
        filesDir({ server: replica, spaceId: 'c16-dst' }),
        `.staging${chunkDirName('r')}`
      )
      assert.equal(await exists(path.join(stagingDir, 'peer')), true)
      const after = await replica.backend.reportUsage({ spaceId: 'c16-dst' })
      assert.ok(
        after.usageBytes - before.usageBytes >= 2 * 64 * 1024,
        `usage grew by ${after.usageBytes - before.usageBytes}`
      )

      const removed = await call({
        server: replica,
        path: '/space/c16-dst/replicas/peer',
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204)
      assert.equal(await exists(path.join(stagingDir, 'peer')), false)
    })

    it('keeps two registrations staging one Resource apart', async () => {
      alignClocks()
      // The third server holds revision A of the source's Resource, and the
      // source moves on to revision B. The replica pulls both.
      await pair({
        fromSpaceId: 'c16b-src',
        to: third,
        toSpaceId: 'c16b-mid'
      })
      await createSpace({ server: replica, spaceId: 'c16b-dst' })
      const revisionA = blobs(700, 710, 720)
      const revisionB = blobs(800, 810, 820)
      await putParent({
        server: source,
        spaceId: 'c16b-src',
        resourceId: 'r',
        json: { revision: 'A' }
      })
      await putChunks({
        server: source,
        spaceId: 'c16b-src',
        resourceId: 'r',
        chunks: revisionA
      })
      await pull({ server: third, spaceId: 'c16b-mid' })
      alignClocks()
      await putChunks({
        server: source,
        spaceId: 'c16b-src',
        resourceId: 'r',
        chunks: revisionB
      })
      await putParent({
        server: source,
        spaceId: 'c16b-src',
        resourceId: 'r',
        json: { revision: 'B' }
      })
      await register({
        from: source,
        fromSpaceId: 'c16b-src',
        to: replica,
        toSpaceId: 'c16b-dst'
      })
      await register({
        from: third,
        fromSpaceId: 'c16b-mid',
        to: replica,
        toSpaceId: 'c16b-dst',
        replicaId: 'second'
      })

      const fromSource = transport.hold(
        sourceUrl('/space/c16b-src/files/r/chunks/2')
      )
      const fromThird = transport.hold(
        `${third.serverUrl}/space/c16b-mid/files/r/chunks/2`
      )
      const pullingSource = pull({ server: replica, spaceId: 'c16b-dst' })
      const pullingThird = pull({
        server: replica,
        spaceId: 'c16b-dst',
        replicaId: 'second'
      })
      const stagingDir = path.join(
        filesDir({ server: replica, spaceId: 'c16b-dst' }),
        `.staging${chunkDirName('r')}`
      )
      try {
        await fromSource.reached
        await fromThird.reached
        // Both stage at once, each under its own registration.
        assert.equal(await exists(path.join(stagingDir, 'peer')), true)
        assert.equal(await exists(path.join(stagingDir, 'second')), true)

        // Revision A lands whole first.
        fromThird.release()
        await pullingThird
        assert.deepStrictEqual(
          (
            await readParent({
              server: replica,
              spaceId: 'c16b-dst',
              resourceId: 'r'
            })
          ).json(),
          { revision: 'A' }
        )
        await assertChunks({
          server: replica,
          spaceId: 'c16b-dst',
          resourceId: 'r',
          expected: revisionA
        })
      } finally {
        fromThird.release()
        fromSource.release()
        await pullingThird
        await pullingSource
      }

      // Then revision B replaces it whole, with no chunk of A left over.
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'c16b-dst',
            resourceId: 'r'
          })
        ).json(),
        { revision: 'B' }
      )
      await assertChunks({
        server: replica,
        spaceId: 'c16b-dst',
        resourceId: 'r',
        expected: revisionB
      })
      assert.equal(await exists(path.join(stagingDir, 'peer')), false)
      assert.equal(await exists(path.join(stagingDir, 'second')), false)
    })
  })

  describe('an export from the replica server', () => {
    const chunks = blobs(610, 620, 630)

    beforeAll(async () => {
      alignClocks()
      await pair({ fromSpaceId: 'c17-src', toSpaceId: 'c17-dst' })
      await putParent({
        server: source,
        spaceId: 'c17-src',
        resourceId: 'r',
        json: { exported: true }
      })
      await putChunks({
        server: source,
        spaceId: 'c17-src',
        resourceId: 'r',
        chunks
      })
      await pull({ server: replica, spaceId: 'c17-dst' })
    })

    it('carries the replicated chunks, and imports on a third server', async () => {
      const exported = await call({
        server: replica,
        path: '/space/c17-dst/export',
        method: 'POST'
      })
      assert.equal(exported.statusCode, 200, exported.payload)
      const tar = exported.rawPayload

      const archive = await readSpaceArchive(new Uint8Array(tar))
      const names: string[] = []
      for await (const entry of archive.entries) {
        names.push(entry.name)
      }
      await archive.close()
      assert.ok(archive.provenance && archive.didLog)
      const { statements } = await verifyProvenanceOffline({
        provenance: archive.provenance,
        didLog: archive.didLog
      })
      for (const index of [0, 1, 2]) {
        assert.ok(
          names.some(name =>
            name.includes(`files/${chunkDirName('r')}/r.${index}.`)
          ),
          `the archive carries chunk ${index}: ${names.join(', ')}`
        )
      }
      // The parent's statement digests its chunk set.
      const parentStatement = statements.find(
        statement =>
          statement.id === `${replica.serverUrl}/space/c17-dst/files/r`
      )
      assert.ok(parentStatement?.digest, JSON.stringify(statements))

      await createSpace({ server: third, spaceId: 'c17-imported' })
      const stats = await importArchive({
        backend: third.backend,
        spaceId: 'c17-imported',
        tarStream: Readable.from([tar])
      })
      // The Space, the Collection and the chunked Resource all verify.
      assert.deepStrictEqual(stats.provenance, {
        verified: 3,
        unattested: 0,
        proofInvalid: 0,
        contentMismatch: 0,
        unknownSigner: 0
      })
      const imported = await call({
        server: third,
        path: '/space/c17-imported/files/r'
      })
      assert.deepStrictEqual(imported.json(), { exported: true })
      await assertChunks({
        server: third,
        spaceId: 'c17-imported',
        resourceId: 'r',
        expected: chunks
      })
    })
  })

  describe('the bounded retry', () => {
    it('stalls as source-unavailable on a chunk the source keeps refusing, and clears', async () => {
      alignClocks()
      await pair({ fromSpaceId: 'cr1-src', toSpaceId: 'cr1-dst' })
      const chunks = blobs(100, 110, 120)
      await putParent({
        server: source,
        spaceId: 'cr1-src',
        resourceId: 'r',
        json: { refused: true }
      })
      await putChunks({
        server: source,
        spaceId: 'cr1-src',
        resourceId: 'r',
        chunks
      })
      const chunkUrl = sourceUrl('/space/cr1-src/files/r/chunks/1')
      transport.refuse(chunkUrl, 503)
      let checkpoint: string | undefined
      for (let cycle = 1; cycle < REPLICA_CHUNK_PULL_RETRY_LIMIT; cycle++) {
        await pull({ server: replica, spaceId: 'cr1-dst' })
        const files = await filesStatus({
          server: replica,
          spaceId: 'cr1-dst'
        })
        assert.equal(files.state, 'syncing', `cycle ${cycle}`)
        const held = await heldCheckpoint({
          server: replica,
          spaceId: 'cr1-dst'
        })
        checkpoint ??= held
        assert.equal(held, checkpoint, `cycle ${cycle}`)
      }
      await pull({ server: replica, spaceId: 'cr1-dst' })
      const files = await filesStatus({ server: replica, spaceId: 'cr1-dst' })
      assert.equal(files.state, 'stalled')
      assert.equal(files.stall.reason, 'source-unavailable')
      assert.match(files.stall.detail, /chunks\/1/)
      assert.match(files.stall.detail, /503/)
      assert.equal(
        await heldCheckpoint({ server: replica, spaceId: 'cr1-dst' }),
        checkpoint
      )
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'cr1-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )

      transport.reset()
      await pull({ server: replica, spaceId: 'cr1-dst' })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'cr1-dst' })).state,
        'synced'
      )
      await assertChunks({
        server: replica,
        spaceId: 'cr1-dst',
        resourceId: 'r',
        expected: chunks
      })
    })

    it('stalls as chunk-listing-obsolete on a parent rewritten during every pull, and clears', async () => {
      alignClocks()
      await pair({ fromSpaceId: 'cr2-src', toSpaceId: 'cr2-dst' })
      const chunks = blobs(130, 140)
      await putParent({
        server: source,
        spaceId: 'cr2-src',
        resourceId: 'r',
        json: { rewrite: 0 }
      })
      await putChunks({
        server: source,
        spaceId: 'cr2-src',
        resourceId: 'r',
        chunks
      })
      const parentUrl = sourceUrl('/space/cr2-src/files/r')

      for (let cycle = 1; cycle <= REPLICA_CHUNK_PULL_RETRY_LIMIT; cycle++) {
        const closing = transport.hold(parentUrl)
        const pulling = pull({ server: replica, spaceId: 'cr2-dst' })
        try {
          await closing.reached
          await putParent({
            server: source,
            spaceId: 'cr2-src',
            resourceId: 'r',
            json: { rewrite: cycle }
          })
        } finally {
          closing.release()
          await pulling
        }
        const files = await filesStatus({
          server: replica,
          spaceId: 'cr2-dst'
        })
        assert.equal(
          files.state,
          cycle < REPLICA_CHUNK_PULL_RETRY_LIMIT ? 'syncing' : 'stalled',
          `cycle ${cycle}`
        )
      }
      const files = await filesStatus({ server: replica, spaceId: 'cr2-dst' })
      assert.equal(files.stall.reason, 'chunk-listing-obsolete')
      assert.equal(
        (
          await readParent({
            server: replica,
            spaceId: 'cr2-dst',
            resourceId: 'r'
          })
        ).statusCode,
        404
      )

      await pull({ server: replica, spaceId: 'cr2-dst' })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'cr2-dst' })).state,
        'synced'
      )
      assert.deepStrictEqual(
        (
          await readParent({
            server: replica,
            spaceId: 'cr2-dst',
            resourceId: 'r'
          })
        ).json(),
        { rewrite: REPLICA_CHUNK_PULL_RETRY_LIMIT }
      )
      await assertChunks({
        server: replica,
        spaceId: 'cr2-dst',
        resourceId: 'r',
        expected: chunks
      })
    })
  })

  describe('the transfer of a chunk set', () => {
    it('reads a few chunks at once', async () => {
      alignClocks()
      assert.ok(REPLICA_CHUNK_PULL_CONCURRENCY >= 2)
      await pair({ fromSpaceId: 'cc1-src', toSpaceId: 'cc1-dst' })
      const chunks = blobs(300, 310, 320)
      await putParent({
        server: source,
        spaceId: 'cc1-src',
        resourceId: 'r',
        json: { concurrent: true }
      })
      await putChunks({
        server: source,
        spaceId: 'cc1-src',
        resourceId: 'r',
        chunks
      })
      const first = transport.hold(sourceUrl('/space/cc1-src/files/r/chunks/0'))
      const second = transport.hold(
        sourceUrl('/space/cc1-src/files/r/chunks/1')
      )
      const pulling = pull({ server: replica, spaceId: 'cc1-dst' })
      try {
        await first.reached
        // The second read is in flight while the first is still held.
        const secondReached = await Promise.race([
          second.reached.then(() => true),
          new Promise<boolean>(resolve =>
            setTimeout(() => resolve(false), 2_000)
          )
        ])
        assert.equal(secondReached, true, 'the chunks are read at once')
      } finally {
        first.release()
        second.release()
        await pulling
      }
      await assertChunks({
        server: replica,
        spaceId: 'cc1-dst',
        resourceId: 'r',
        expected: chunks
      })
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'cc1-dst' })).state,
        'synced'
      )
    })
  })

  describe('the loop state', () => {
    it('is persisted at the document threshold and at the end of the Collection, not after every chunked Resource', async () => {
      alignClocks()
      await pair({ fromSpaceId: 'cp1-src', toSpaceId: 'cp1-dst' })
      const count = REPLICA_STATE_PERSIST_DOCUMENTS + 1
      const sets: Buffer[][] = []
      for (let n = 0; n < count; n++) {
        sets.push(blobs(16))
        await putParent({
          server: source,
          spaceId: 'cp1-src',
          resourceId: `r${n}`,
          json: { n }
        })
        await putChunks({
          server: source,
          spaceId: 'cp1-src',
          resourceId: `r${n}`,
          chunks: sets[n]!
        })
      }
      const persisted = vi.spyOn(replica.backend, 'writeReplicaState')
      try {
        await pull({ server: replica, spaceId: 'cp1-dst' })
        // Once at the threshold, once at the end of the Collection, and once
        // at the end of the cycle.
        assert.equal(persisted.mock.calls.length, 3)
      } finally {
        persisted.mockRestore()
      }
      for (let n = 0; n < count; n++) {
        await assertChunks({
          server: replica,
          spaceId: 'cp1-dst',
          resourceId: `r${n}`,
          expected: sets[n]!
        })
      }
      assert.equal(
        (await filesStatus({ server: replica, spaceId: 'cp1-dst' })).state,
        'synced'
      )
    })
  })
})
