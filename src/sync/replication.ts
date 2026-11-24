/**
 * The pull loops of the replication facet: one per stored replica
 * registration. A loop reads its source peer and stores what it reads through
 * the backend's apply path (`StorageBackend.apply*`), which keeps the peer's
 * write stamps. Nothing is pushed, and no request route accepts a stamp.
 *
 * One cycle reads, in order:
 *
 * - The peer Space's Metadata object, for its `name`, and the Space policy.
 *   Both are conditional reads against the `ETag` the last cycle saw.
 * - The peer's Collection listing, tombstones included. The registration's
 *   Collection list selects among them, and the Collection that holds the
 *   controller's history log is always selected. A selected tombstone is
 *   applied, unless this server already holds one at that stamp or a later
 *   one.
 * - Each selected Collection's Metadata object, when this server does not
 *   hold that life of the Collection yet, and then its changes feed from the
 *   stored checkpoint. Every change document is applied by kind, and the
 *   checkpoint advances past a document once it is applied or skipped. The
 *   Collection that holds the controller's history log is pulled first, so
 *   a key retired at the peer stops authorizing here after one cycle.
 *
 * A live Resource goes through the chunk pull when the peer lists the
 * Encrypted Collections entry (`pullsChunks` on the registration). A held
 * revision that wins or is equal already has its chunk set, so only its
 * `/meta` record is applied. Otherwise the loop reads the peer's chunk
 * listing, and when either server holds a chunk of the Resource it opens
 * the staging run on the data backend (`beginChunkStaging`, which checks
 * the quota), reads into staging each listed chunk whose `etag` is not
 * the one an earlier run staged, a few at once, reads the parent last as
 * the closing check, and
 * applies the parent and its set in one `applyResource` call with
 * `chunks`. So nothing live changes until the whole set is here, and the
 * parent takes its feed position only then. The loop state is persisted
 * inside a Collection's pull once the chunk pulls since the last persist
 * moved `REPLICA_STATE_PERSIST_BYTES` or ran for
 * `REPLICA_STATE_PERSIST_DOCUMENTS` Resources, and at the end of each
 * Collection. A chunk pull whose closing check fails, or whose request to
 * the peer fails, ends in a `retry` that holds the checkpoint, and staging
 * keyed by the document's `etag` lets the next cycle skip what it already
 * moved. The retry is bounded: after `REPLICA_CHUNK_PULL_RETRY_LIMIT`
 * consecutive cycles from one checkpoint the Collection stalls as
 * `chunk-listing-obsolete` (the peer rewrites the Resource faster than the
 * pull completes) or `source-unavailable` (the request keeps failing), and
 * the rest of the cycle goes on. A stop signal ends the chunk pull before
 * the next chunk, and a removed registration ends it at the next chunk
 * set.
 *
 * A refusal from the apply path stalls that Collection alone. The checkpoint
 * holds, the reason is stored with the loop state, and the Collection is
 * retried each cycle while the others go on. A request to the peer that
 * fails outside a chunk pull ends the cycle. The loop then backs off,
 * doubling its delay up to a limit, and logs one `warn` when the failures
 * begin. Nothing stops a loop but the removal of its registration.
 */
import type { Readable } from 'node:stream'
import type { FastifyBaseLogger } from 'fastify'
import type { ISigner } from '@interop/data-integrity-core'
import {
  isCollectionTombstoneSummary,
  isCreatedBy
} from '@interop/storage-core'
import {
  MAX_CHUNK_INDEX,
  fileNameFor,
  parseChunkIndexSegment
} from '@interop/space-archive'

import {
  REPLICA_CHUNK_PULL_CONCURRENCY,
  REPLICA_CHUNK_PULL_RETRY_LIMIT,
  REPLICA_STATE_PERSIST_BYTES,
  REPLICA_STATE_PERSIST_DOCUMENTS,
  REPLICATION_BACKOFF_BASE_MS,
  REPLICATION_BACKOFF_MAX_MS,
  REPLICATION_DOCUMENT_MAX_BYTES,
  REPLICATION_FEED_PAGE_SIZE,
  REPLICATION_PULL_INTERVAL_MS
} from '../config.default.js'
import { PeerRequestError, ProblemError } from '../errors.js'
import { ensureCollectionCopy } from '../lib/backendMirror.js'
import type { ServerBackends } from '../lib/serverBackends.js'
import { bufferedBodyLimit } from '../lib/bodyLimit.js'
import { generationOfEtag } from '../lib/etag.js'
import { invalidateCollectionGovernedDescriptors } from '../lib/governedDescriptorsCache.js'
import { compareStamps, stampOf, withoutStampMembers } from '../lib/hlc.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import {
  MAX_PAGE_SIZE,
  compareCodeUnits,
  cursorOfNextUrl
} from '../lib/pagination.js'
import {
  chunkPath,
  chunksContainerPath,
  collectionLogPath,
  collectionMetaPath,
  collectionPath,
  metaPath,
  policyPath,
  queryPath,
  resourcePath,
  spaceMetaPath
} from '../lib/paths.js'
import {
  invalidateCollectionPolicies,
  invalidatePolicy
} from '../lib/policyCache.js'
import {
  type ApplyResult,
  decideCollectionTombstoneApply,
  decideResourceApply,
  isReceivableStamp,
  registrationStands
} from '../lib/replicaApply.js'
import type { ServerSigningKey } from '../lib/serverIdentity.js'
import { invalidateSpaceMetadata } from '../lib/spaceMetadataCache.js'
import { loadSyncSigner } from '../lib/syncIdentity.js'
import { WEBVH_LOG_RESOURCE_ID } from '../lib/validateDid.js'
import {
  isUrlSafeSegment,
  RESERVED_COLLECTION_IDS,
  RESERVED_RESOURCE_IDS,
  spaceIdOfSpaceUrl
} from '../lib/validateId.js'
import {
  forgetDeletedWebvhLocation,
  invalidateResolvedWebvhDid
} from '../lib/webvhController.js'
import type {
  ChunkListing,
  ChunkStagingRun,
  CollectionMetadata,
  IDID,
  PolicyDocument,
  ReplicaCollectionState,
  ReplicaLoopState,
  ReplicaStallReason,
  ReplicaStatus,
  ResourceInput,
  ResourceMetaStamp,
  StorageBackend,
  StoredReplica,
  WriteStamp
} from '../types.js'
import {
  controllerLogCollectionId,
  peerCollectionSelector
} from './collectionSelection.js'
import { PeerClient } from './peerClient.js'
import type { PeerStream } from './peerClient.js'
import type { PeerFetch } from './peerFetch.js'
import { peerUrlOf, storedProjectionOfCollection } from './registration.js'

/**
 * Why a chunk pull ended in `retry`, kept so the bounded retry can name it
 * when the Collection stalls: `chunk-listing-obsolete` when the source
 * server's Resource was written again during the pull, `source-unavailable`
 * when a request inside it failed. `detail` names the URL and the status.
 */
interface ChunkPullFailure {
  reason: 'chunk-listing-obsolete' | 'source-unavailable'
  detail: string
}

/**
 * What applying one change did, beside the apply path's own outcomes. Both
 * extra outcomes leave the checkpoint before the document, so the Collection
 * is read again next cycle from there. `retry` means the peer's record moved
 * between the feed page and its read; one that carries `chunkPull` ended a
 * chunk pull and counts toward the bounded retry. `pending` means the step
 * stopped the Collection's pull and already recorded why in its loop state.
 * An apply result with `pulledBytes` finished a chunk pull that read that
 * many chunk bytes from the peer, which counts toward the next persist of
 * the loop state.
 */
type ChangeResult =
  | (ApplyResult & { pulledBytes?: number })
  | { outcome: 'retry'; chunkPull?: ChunkPullFailure }
  | { outcome: 'pending' }

/**
 * How a chunk pull ended: a change result, or `created` (the `/meta` read
 * it made) when neither server holds a chunk of the Resource, so the
 * document applies as a plain record.
 */
type ChunkPullEnd = ChangeResult | { created: { createdAt?: string } }

/**
 * How one Collection's pull ended: `done` when its feed was read to the end,
 * `pending` when it stopped early and is read again next cycle, or
 * `unregistered` when the registration is gone and the loop must stop.
 */
type CollectionOutcome = 'done' | 'pending' | 'unregistered'

/**
 * One loop's in-memory handle.
 */
interface Loop {
  spaceId: string
  replicaId: string
  timer?: NodeJS.Timeout
  // The cycle in flight, if any.
  running?: Promise<void>
  // Set by `wake` while a cycle is in flight: the next cycle is due at once.
  wakeRequested: boolean
  stopped: boolean
  // The bounded retry of the chunk pull, by Collection id: how many
  // consecutive cycles ended in a counted `retry` on a document of the same
  // Resource from the same checkpoint. In memory only, so a restart starts the count
  // over.
  chunkPullRetries: Map<string, ChunkPullRetryKey & { count: number }>
  // The Collection ids whose tombstone apply threw. The next cycle applies
  // such a tombstone even when this server holds it, which finishes a delete
  // the fault cut short. In memory only: boot finishes one too.
  tombstoneRetries: Set<string>
}

/**
 * What the bounded retry of a chunk pull counts under: the Collection's
 * checkpoint, and the `id` of the feed document whose pull ended in the
 * `retry`. A document of another Resource starts the count over. The
 * document's `etag` is not part of the key: a Resource the source server
 * rewrites during every pull meets the loop under a new `etag` each
 * cycle, and that is the case the `chunk-listing-obsolete` stall exists
 * for.
 */
interface ChunkPullRetryKey {
  checkpoint?: string
  documentId?: string
}

/**
 * The key of a loop in the manager's map.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.replicaId {string}
 * @returns {string}
 */
function loopKey({
  spaceId,
  replicaId
}: {
  spaceId: string
  replicaId: string
}): string {
  return `${spaceId}/${replicaId}`
}

/**
 * Whether an id a peer served names a record this server could store and
 * address: a URL-safe string outside the reserved ids of its level.
 * Positional, since a type guard narrows a parameter.
 * @param id {unknown}
 * @param reserved {ReadonlySet<string>}   the reserved ids of its level
 * @returns {boolean}
 */
function isStorableId(
  id: unknown,
  reserved: ReadonlySet<string>
): id is string {
  return typeof id === 'string' && isUrlSafeSegment(id) && !reserved.has(id)
}

/**
 * The stamp members of a JSON object a peer served, or `undefined` when it
 * carries no whole, storable stamp.
 * @param value {unknown}
 * @returns {WriteStamp | undefined}
 */
function receivedStampOf(value: unknown): WriteStamp | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const stamp = stampOf(value as Partial<WriteStamp>)
  return isReceivableStamp(stamp) ? stamp : undefined
}

export class ReplicationManager {
  /**
   * The transport to a peer, which a registration's checks read through too.
   */
  readonly peerFetch: PeerFetch
  #serverBackends: ServerBackends
  // The control plane, which holds the registrations and every container
  // object, and takes every apply but a Resource's.
  #storage: StorageBackend
  #getServerUrl: () => string
  #signingKey?: ServerSigningKey
  #logger: FastifyBaseLogger
  #pullIntervalMs: number
  #loops = new Map<string, Loop>()
  #paused = false
  #stopped = false

  /**
   * @param options {object}
   * @param options.serverBackends {ServerBackends}   the server backends;
   *   their control plane takes every apply but a Resource's, which goes to
   *   the backend the Collection's `backend.id` selects
   * @param options.getServerUrl {() => string}   this server's base URL,
   *   read per cycle since a test boot sets it after `listen()`
   * @param [options.signingKey] {ServerSigningKey}   the server's seed key;
   *   without one every cycle fails for want of a sync signer
   * @param options.peerFetch {PeerFetch}   the transport to a peer
   * @param options.logger {FastifyBaseLogger}
   * @param [options.pullIntervalMs] {number}   the delay between two cycles
   *   that reached the peer; defaults to `REPLICATION_PULL_INTERVAL_MS`
   */
  constructor({
    serverBackends,
    getServerUrl,
    signingKey,
    peerFetch,
    logger,
    pullIntervalMs = REPLICATION_PULL_INTERVAL_MS
  }: {
    serverBackends: ServerBackends
    getServerUrl: () => string
    signingKey: ServerSigningKey | undefined
    peerFetch: PeerFetch
    logger: FastifyBaseLogger
    pullIntervalMs?: number
  }) {
    this.#serverBackends = serverBackends
    this.#storage = serverBackends.controlPlane
    this.#getServerUrl = getServerUrl
    this.#signingKey = signingKey
    this.peerFetch = peerFetch
    this.#logger = logger
    this.#pullIntervalMs = pullIntervalMs
  }

  /**
   * Starts one loop per stored registration that is not paused. Run once the
   * server is ready. A registration stored just before a crash gets its loop
   * here; a paused one gets it when a `PUT` clears its `pausedAt`.
   * @returns {Promise<void>}
   */
  async start(): Promise<void> {
    for (const { spaceId, record } of await this.#storage.listAllReplicas()) {
      if (record.pausedAt === undefined) {
        this.register({ spaceId, replicaId: record.id })
      }
    }
  }

  /**
   * Starts the loop of a registration, with its first cycle due at once.
   * Does nothing for one that already has a loop.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {void}
   */
  register({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): void {
    const key = loopKey({ spaceId, replicaId })
    if (this.#stopped || this.#loops.has(key)) {
      return
    }
    const loop: Loop = {
      spaceId,
      replicaId,
      wakeRequested: false,
      stopped: false,
      chunkPullRetries: new Map(),
      tombstoneRetries: new Set()
    }
    this.#loops.set(key, loop)
    this.#schedule({ loop, delayMs: 0 })
  }

  /**
   * Stops the loop of a registration that was removed. A cycle in flight
   * ends on its own: the apply path resolves `unregistered` from then on.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {void}
   */
  unregister({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): void {
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    if (loop !== undefined) {
      this.#endLoop(loop)
    }
  }

  /**
   * Has a registration's next cycle run at once, after a `PUT` changed what
   * its loop reads: a pause, a resume, a new pull capability, or a create.
   * Starts the loop of a registration that has none, and otherwise
   * reschedules the one it has. A cycle in flight is left to finish, and its
   * successor is then due at once instead of at the interval or the backoff
   * it would have taken; a cycle that ends its loop instead starts a fresh
   * one (`#endLoopFromCycle`). A paused registration's cycle ends the loop.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {void}
   */
  wake({ spaceId, replicaId }: { spaceId: string; replicaId: string }): void {
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    if (loop === undefined) {
      this.register({ spaceId, replicaId })
    } else if (loop.running === undefined) {
      this.#schedule({ loop, delayMs: 0 })
    } else {
      loop.wakeRequested = true
    }
  }

  /**
   * Stops the loops of every registration on a Space, for Delete Space.
   * @param options {object}
   * @param options.spaceId {string}
   * @returns {void}
   */
  unregisterSpace({ spaceId }: { spaceId: string }): void {
    for (const loop of [...this.#loops.values()]) {
      if (loop.spaceId === spaceId) {
        this.#endLoop(loop)
      }
    }
  }

  /**
   * Holds every loop: no scheduled cycle starts until `resume()`. A cycle in
   * flight finishes. `pullNow()` still runs.
   * @returns {void}
   */
  pause(): void {
    this.#paused = true
  }

  /**
   * Lets the scheduled cycles run again, each due at once.
   * @returns {void}
   */
  resume(): void {
    this.#paused = false
    for (const loop of this.#loops.values()) {
      if (loop.running === undefined) {
        this.#schedule({ loop, delayMs: 0 })
      }
    }
  }

  /**
   * Runs one cycle of a registration's loop now and resolves when it ends,
   * after any cycle already in flight. Resolves at once for a registration
   * with no loop.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<void>}
   */
  async pullNow({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<void> {
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    if (loop === undefined) {
      return
    }
    await loop.running
    if (!loop.stopped) {
      await this.#runCycle(loop)
    }
  }

  /**
   * Stops every loop and waits for the cycles in flight. Run before the
   * storage backend closes.
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    this.#stopped = true
    const running = [...this.#loops.values()].map(loop => loop.running)
    for (const loop of [...this.#loops.values()]) {
      this.#endLoop(loop)
    }
    await Promise.allSettled(running)
  }

  /**
   * The runtime state of a registration's loop, as its `status` sub-resource
   * serves it, or `undefined` when the registration is not stored.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<ReplicaStatus | undefined>}
   */
  async status({
    spaceId,
    replicaId
  }: {
    spaceId: string
    replicaId: string
  }): Promise<ReplicaStatus | undefined> {
    const replica = await this.#storage.getReplica({ spaceId, replicaId })
    if (replica === undefined) {
      return undefined
    }
    const stored = await this.#storage.getReplicaState({ spaceId, replicaId })
    const collections = Object.entries(stored?.collections ?? {})
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([id, { state, lastAppliedAt, stall }]) => ({
        id,
        state,
        ...(lastAppliedAt !== undefined && { lastAppliedAt }),
        ...(stall !== undefined && { stall })
      }))
    const loop = this.#loops.get(loopKey({ spaceId, replicaId }))
    let state: ReplicaStatus['state'] = 'idle'
    if (loop?.running !== undefined) {
      state = 'pulling'
    } else if (replica.record.pausedAt !== undefined) {
      state = 'paused'
    } else if ((stored?.failures ?? 0) > 0) {
      state = 'backing-off'
    } else if (collections.some(collection => collection.state === 'stalled')) {
      state = 'stalled'
    }
    return {
      state,
      ...(stored?.lastPullAt !== undefined && {
        lastPullAt: stored.lastPullAt
      }),
      ...(stored?.lastSuccessAt !== undefined && {
        lastSuccessAt: stored.lastSuccessAt
      }),
      ...(stored?.nextPullAt !== undefined && {
        nextPullAt: stored.nextPullAt
      }),
      collections
    }
  }

  /**
   * Removes a loop and cancels its timer.
   * @param loop {Loop}
   * @returns {void}
   */
  #endLoop(loop: Loop): void {
    loop.stopped = true
    clearTimeout(loop.timer)
    this.#loops.delete(loopKey(loop))
  }

  /**
   * Ends a loop from inside its own cycle, on what the cycle read: a
   * registration that is gone or paused. A `wake` that landed while the
   * cycle ran (a resume, or a re-create under the id) found a loop with a
   * cycle in flight and set `wakeRequested` on it, so the registration it
   * reads now may no longer be the one the cycle read. A fresh loop is
   * started for it, whose first cycle reads the registration again and ends
   * at once if nothing has changed. `unregister` ends a loop without this,
   * since the registration is gone for good there.
   * @param loop {Loop}
   * @returns {void}
   */
  #endLoopFromCycle(loop: Loop): void {
    this.#endLoop(loop)
    if (loop.wakeRequested) {
      this.register({ spaceId: loop.spaceId, replicaId: loop.replicaId })
    }
  }

  /**
   * Schedules a loop's next cycle.
   * @param options {object}
   * @param options.loop {Loop}
   * @param options.delayMs {number}
   * @returns {void}
   */
  #schedule({ loop, delayMs }: { loop: Loop; delayMs: number }): void {
    clearTimeout(loop.timer)
    if (loop.stopped || this.#stopped) {
      return
    }
    if (loop.wakeRequested) {
      loop.wakeRequested = false
      delayMs = 0
    }
    loop.timer = setTimeout(() => {
      if (this.#paused || loop.running !== undefined) {
        return
      }
      void this.#runCycle(loop)
    }, delayMs)
    // A pending pull must not keep the process alive.
    loop.timer.unref()
  }

  /**
   * Runs one cycle, records how it ended in the loop state, and schedules
   * the next one. Never rejects. A cycle that threw outside its pull, on a
   * storage fault reading or writing the loop state, scheduled nothing, so
   * the next one is scheduled here.
   * @param loop {Loop}
   * @returns {Promise<void>}
   */
  async #runCycle(loop: Loop): Promise<void> {
    const run = this.#cycle(loop)
      .catch(err => {
        this.#logger.error(
          { err, spaceId: loop.spaceId, replicaId: loop.replicaId },
          'A replication cycle failed unexpectedly.'
        )
        this.#schedule({ loop, delayMs: REPLICATION_BACKOFF_BASE_MS })
      })
      .finally(() => {
        loop.running = undefined
      })
    loop.running = run
    await run
  }

  /**
   * One cycle: read the peer, apply, persist the state, schedule the next.
   * The registration is read first, so a cycle uses the pull capability a
   * `PUT` stored since the last one. A registration that is gone ends the
   * loop. A paused one ends it too, after dropping the `nextPullAt` and the
   * failure count of the loop state, since no cycle is due and a resume
   * starts a new loop (`wake`) with no backoff carried over.
   * @param loop {Loop}
   * @returns {Promise<void>}
   */
  async #cycle(loop: Loop): Promise<void> {
    const { spaceId, replicaId } = loop
    const replica = await this.#storage.getReplica({ spaceId, replicaId })
    if (replica === undefined) {
      this.#endLoopFromCycle(loop)
      return
    }
    const state: ReplicaLoopState = (await this.#storage.getReplicaState({
      spaceId,
      replicaId
    })) ?? { collections: {} }
    if (replica.record.pausedAt !== undefined) {
      if (state.nextPullAt !== undefined || state.failures !== undefined) {
        delete state.nextPullAt
        delete state.failures
        await this.#storage.writeReplicaState({ spaceId, replicaId, state })
      }
      // Last, so a resume that lands during the state write is seen.
      this.#endLoopFromCycle(loop)
      return
    }
    state.lastPullAt = new Date().toISOString()

    let registered = true
    let failure: unknown
    try {
      registered = await this.#pull({ loop, spaceId, replica, state })
    } catch (err) {
      failure = err
    }
    if (!registered) {
      this.#endLoopFromCycle(loop)
      return
    }

    let delayMs = this.#pullIntervalMs
    if (failure === undefined) {
      state.failures = 0
      state.lastSuccessAt = new Date().toISOString()
    } else {
      const failures = (state.failures ?? 0) + 1
      state.failures = failures
      delayMs = Math.min(
        REPLICATION_BACKOFF_BASE_MS * 2 ** (failures - 1),
        REPLICATION_BACKOFF_MAX_MS
      )
      const log = {
        err: failure,
        spaceId,
        replicaId,
        peer: replica.record.fromSpace
      }
      if (failures === 1) {
        this.#logger.warn(
          log,
          'A replication pull failed; the loop is backing off.'
        )
      } else {
        this.#logger.debug(log, 'A replication pull failed again.')
      }
    }
    // A `wake` during this cycle makes the next one due at once, the
    // backoff included; `#schedule` consumes the request.
    if (loop.wakeRequested) {
      delayMs = 0
    }
    state.nextPullAt = new Date(Date.now() + delayMs).toISOString()
    const stored = await this.#storage.writeReplicaState({
      spaceId,
      replicaId,
      state
    })
    if (!stored) {
      this.#endLoopFromCycle(loop)
      return
    }
    this.#schedule({ loop, delayMs })
  }

  /**
   * Reads the peer and applies what it serves. Mutates `state` as it goes
   * and persists it after each Collection whose state changed, and after
   * each Resource whose chunk pull ran.
   * @param options {object}
   * @param options.loop {Loop}   the loop the cycle runs in, for its stop
   *   signal and its bounded retry
   * @param options.spaceId {string}   the local Space
   * @param options.replica {StoredReplica}
   * @param options.state {ReplicaLoopState}
   * @returns {Promise<boolean>}   `false` when the registration is gone, or
   *   the loop was stopped during a chunk pull
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #pull({
    loop,
    spaceId,
    replica,
    state
  }: {
    loop: Loop
    spaceId: string
    replica: StoredReplica
    state: ReplicaLoopState
  }): Promise<boolean> {
    const { record } = replica
    const replicaId = record.id
    const serverUrl = this.#getServerUrl()
    const sync = await loadSyncSigner({
      storage: this.#storage,
      serverBackends: this.#serverBackends,
      serverUrl,
      signingKey: this.#signingKey,
      logger: this.#logger
    })
    if ('refusal' in sync) {
      throw new PeerRequestError({
        url: record.fromSpace,
        detail: `this server has no sync signer. ${sync.reason}`
      })
    }
    const peer = new PeerClient({
      peerFetch: this.peerFetch,
      signer: sync.signer as ISigner,
      capability: record.capability
    })
    const peerSpaceId = spaceIdOfSpaceUrl(record.fromSpace)!
    const peerUrl = (path: string): string =>
      peerUrlOf({ path, fromSpace: record.fromSpace })
    const context: PullContext = {
      spaceId,
      replicaId,
      peer,
      peerSpaceId,
      peerUrl,
      record,
      loop,
      pullsChunks: replica.pullsChunks,
      persist: () =>
        this.#storage.writeReplicaState({ spaceId, replicaId, state })
    }

    if (!(await this.#pullSpaceMetadata({ ...context, state }))) {
      return false
    }
    if (!(await this.#pullSpacePolicy({ ...context, state }))) {
      return false
    }

    const listing = await this.#listPeerCollections(context)
    const { selects, logCollectionId } = await this.#collectionSelector({
      spaceId,
      record
    })
    // A delete of a Collection this registration does not pull must not
    // remove a local Collection that happens to share its id.
    const tombstones = listing.tombstones.filter(({ id }) => selects(id))
    const held =
      tombstones.length > 0
        ? await this.#heldCollectionTombstones({ spaceId })
        : new Map<string, WriteStamp>()
    for (const { id: collectionId, stamp } of tombstones) {
      // A tombstone the apply would skip over a held one is not applied, so
      // the apply's lock on the Space is not taken for it.
      const heldStamp = held.get(collectionId)
      if (
        heldStamp !== undefined &&
        !loop.tombstoneRetries.has(collectionId) &&
        decideCollectionTombstoneApply({
          held: { kind: 'tombstone', stamp: heldStamp },
          stamp
        }) === 'skip'
      ) {
        // The Collection is deleted on both servers, so the loop keeps no
        // state for it.
        delete state.collections[collectionId]
        continue
      }
      // An apply that throws leaves the id in the set for the next cycle.
      loop.tombstoneRetries.add(collectionId)
      const result = await this.#storage.applyCollection({
        spaceId,
        replicaId,
        collectionId,
        collection: { deleted: true, stamp }
      })
      loop.tombstoneRetries.delete(collectionId)
      if (result.outcome === 'unregistered') {
        return false
      }
      this.#dropCaches({ kind: 'collection', result, spaceId, collectionId })
      if (result.outcome === 'applied') {
        delete state.collections[collectionId]
      }
    }

    // The Collection that holds the controller's history log goes first, so
    // a key retired at the peer stops authorizing here after this cycle,
    // whatever the chunk pulls of the others cost. The rest keep the peer's
    // listing order.
    const selected = listing.live.filter(selects)
    if (logCollectionId !== undefined && selected.includes(logCollectionId)) {
      selected.splice(selected.indexOf(logCollectionId), 1)
      selected.unshift(logCollectionId)
    }
    for (const collectionId of selected) {
      const collection: ReplicaCollectionState = state.collections[
        collectionId
      ] ?? { state: 'syncing' }
      state.collections[collectionId] = collection
      // A Collection's pull mutates its own entry alone.
      const before = JSON.stringify(collection)
      const outcome = await this.#pullCollection({
        ...context,
        collectionId,
        collection
      })
      if (outcome === 'unregistered') {
        return false
      }
      if (JSON.stringify(collection) === before) {
        continue
      }
      const stored = await this.#storage.writeReplicaState({
        spaceId,
        replicaId,
        state
      })
      if (!stored) {
        return false
      }
    }
    return true
  }

  /**
   * Applies the peer Space's `name`, when its Metadata object changed since
   * the last cycle.
   * @param options {object}   the pull context and the loop state
   * @returns {Promise<boolean>}   `false` when the registration is gone
   */
  async #pullSpaceMetadata({
    spaceId,
    replicaId,
    peer,
    peerSpaceId,
    peerUrl,
    state
  }: PullContext & { state: ReplicaLoopState }): Promise<boolean> {
    const url = peerUrl(spaceMetaPath({ spaceId: peerSpaceId }))
    const served = await peer.readJson({
      url,
      expect: [200, 304],
      ifNoneMatch: state.spaceMetaEtag
    })
    if (served.status === 304) {
      return true
    }
    const stamp = receivedStampOf(served.json)
    if (stamp === undefined) {
      throw new PeerRequestError({
        url,
        detail: 'the Space Metadata object carries no write stamp.'
      })
    }
    const { name } = served.json
    const result = await this.#storage.applySpaceName({
      spaceId,
      replicaId,
      ...(typeof name === 'string' && { name }),
      stamp
    })
    return this.#finishSpaceRecord({
      kind: 'space-name',
      result,
      spaceId,
      state,
      etagMember: 'spaceMetaEtag',
      etag: served.etag
    })
  }

  /**
   * Applies the peer's Space policy, live or a tombstone, when it changed
   * since the last cycle. A Space with no policy record answers 404.
   * @param options {object}   the pull context and the loop state
   * @returns {Promise<boolean>}   `false` when the registration is gone
   */
  async #pullSpacePolicy({
    spaceId,
    replicaId,
    peer,
    peerSpaceId,
    peerUrl,
    state
  }: PullContext & { state: ReplicaLoopState }): Promise<boolean> {
    const url = `${peerUrl(policyPath({ spaceId: peerSpaceId }))}?include=deleted`
    const served = await peer.readJson({
      url,
      expect: [200, 304, 404],
      ifNoneMatch: state.spacePolicyEtag
    })
    if (served.status !== 200) {
      return true
    }
    const result = await this.#applyServedPolicy({
      spaceId,
      replicaId,
      url,
      served
    })
    return this.#finishSpaceRecord({
      kind: 'space-policy',
      result,
      spaceId,
      state,
      etagMember: 'spacePolicyEtag',
      etag: served.etag
    })
  }

  /**
   * The tail both Space-level pulls share: drops the caches an applied record
   * leaves stale, and remembers the `ETag` unless the apply was refused, so a
   * clock-bound refusal is read again next cycle.
   * @param options {object}
   * @param options.kind {'space-name' | 'space-policy'}
   * @param options.result {ApplyResult}
   * @param options.spaceId {string}
   * @param options.state {ReplicaLoopState}
   * @param options.etagMember {'spaceMetaEtag' | 'spacePolicyEtag'}
   * @param options.etag {string | undefined}
   * @returns {boolean}   `false` when the registration is gone
   */
  #finishSpaceRecord({
    kind,
    result,
    spaceId,
    state,
    etagMember,
    etag
  }: {
    kind: 'space-name' | 'space-policy'
    result: ApplyResult
    spaceId: string
    state: ReplicaLoopState
    etagMember: 'spaceMetaEtag' | 'spacePolicyEtag'
    etag: string | undefined
  }): boolean {
    if (result.outcome === 'unregistered') {
      return false
    }
    this.#dropCaches({ kind, result, spaceId })
    if (result.outcome !== 'refused') {
      state[etagMember] = etag
    }
    return true
  }

  /**
   * Applies a policy as a peer's `GET .../policy?include=deleted` served it:
   * the body with its stamp members, under the generation in the `ETag`.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @param options.url {string}   the URL read, for an error
   * @param options.served {{ etag?: string, json: Record<string, unknown> }}
   * @returns {Promise<ApplyResult>}
   */
  async #applyServedPolicy({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    url,
    served
  }: {
    spaceId: string
    replicaId: string
    collectionId?: string
    resourceId?: string
    url: string
    served: { etag?: string; json: Record<string, unknown> }
  }): Promise<ApplyResult> {
    const stamp = receivedStampOf(served.json)
    const generation = generationOfEtag(served.etag)
    if (stamp === undefined || generation === undefined) {
      throw new PeerRequestError({
        url,
        detail: 'the policy carries no write stamp or no validator.'
      })
    }
    const deleted = served.json.deleted === true
    return this.#storage.applyPolicy({
      spaceId,
      replicaId,
      ...(collectionId !== undefined && { collectionId }),
      ...(resourceId !== undefined && { resourceId }),
      generation,
      stamp,
      ...(!deleted && {
        policy: withoutStampMembers(served.json) as unknown as PolicyDocument
      })
    })
  }

  /**
   * The stamp of every Collection tombstone the local Space holds, by
   * Collection id. It is a listing read, which takes no write lock. The read
   * only saves applies, so a listing page that fails does not fail the
   * cycle. The stamps read before it are returned, and a tombstone missing
   * from them is applied as if none were held.
   * @param options {object}
   * @param options.spaceId {string}   the local Space
   * @returns {Promise<Map<string, WriteStamp>>}
   */
  async #heldCollectionTombstones({
    spaceId
  }: {
    spaceId: string
  }): Promise<Map<string, WriteStamp>> {
    const held = new Map<string, WriteStamp>()
    let cursor: string | undefined
    try {
      do {
        // The largest page, since the filesystem backend reads every
        // Collection record of the Space for each page.
        const page = await this.#storage.listCollections({
          spaceId,
          cursor,
          limit: MAX_PAGE_SIZE,
          includeDeleted: true
        })
        for (const item of page.items) {
          const stamp = isCollectionTombstoneSummary(item)
            ? receivedStampOf(item)
            : undefined
          if (stamp !== undefined) {
            held.set(item.id, stamp)
          }
        }
        cursor = cursorOfNextUrl(page.next)
      } while (cursor !== undefined)
    } catch (err) {
      this.#logger.warn(
        { err, spaceId },
        'Reading the held Collection tombstones failed; applying each one.'
      )
    }
    return held
  }

  /**
   * Reads the peer's whole Collection listing, tombstones included.
   * @param options {object}   the pull context
   * @returns {Promise<{ live: string[], tombstones: { id: string, stamp: WriteStamp }[] }>}
   */
  async #listPeerCollections({ peer, record }: PullContext): Promise<{
    live: string[]
    tombstones: Array<{ id: string; stamp: WriteStamp }>
  }> {
    const live: string[] = []
    const tombstones: Array<{ id: string; stamp: WriteStamp }> = []
    let url: string | undefined = `${record.fromSpace}?include=deleted`
    while (url !== undefined) {
      const page: Awaited<ReturnType<PeerClient['readJson']>> =
        await peer.readJson({ url, expect: [200] })
      const items = Array.isArray(page.json.items) ? page.json.items : []
      for (const item of items) {
        if (
          !isPlainObject(item) ||
          !isStorableId(item.id, RESERVED_COLLECTION_IDS)
        ) {
          continue
        }
        if (item.deleted !== true) {
          live.push(item.id)
          continue
        }
        const stamp = receivedStampOf(item)
        if (stamp !== undefined) {
          tombstones.push({ id: item.id, stamp })
        }
      }
      const next: unknown = page.json.next
      url = undefined
      if (typeof next === 'string') {
        const followed = new URL(next, record.fromSpace)
        // A listing may not send the loop to another Space or host.
        if (`${followed.origin}${followed.pathname}` !== record.fromSpace) {
          throw new PeerRequestError({
            url: followed.toString(),
            detail: 'the listing\'s "next" leaves the peer Space.'
          })
        }
        url = followed.toString()
      }
    }
    return { live, tombstones }
  }

  /**
   * Which peer Collections this registration pulls, live or tombstoned: the
   * listed ones, or all of them with no list, and always the Collection that
   * holds the history log of the local Space's controller when the peer
   * Space hosts it. That Collection's id is returned beside the predicate,
   * since the cycle pulls it first.
   * @param options {object}
   * @param options.spaceId {string}   the local Space
   * @param options.record {StoredReplica['record']}
   * @returns {Promise<{ selects: (collectionId: string) => boolean, logCollectionId?: string }>}
   */
  async #collectionSelector({
    spaceId,
    record
  }: {
    spaceId: string
    record: StoredReplica['record']
  }): Promise<{
    selects: (collectionId: string) => boolean
    logCollectionId?: string
  }> {
    const local = await this.#storage.getSpaceMetadata({ spaceId })
    const localController = local?.controller
    return {
      selects: peerCollectionSelector({ record, localController }),
      logCollectionId: controllerLogCollectionId({ record, localController })
    }
  }

  /**
   * Pulls one Collection: its Metadata object when this server does not hold
   * that life of it yet, then its changes feed from the stored checkpoint.
   * Mutates `collection`.
   * @param options {object}   the pull context, the Collection id and its
   *   loop state
   * @returns {Promise<CollectionOutcome>}
   */
  async #pullCollection(options: CollectionPull): Promise<CollectionOutcome> {
    const {
      spaceId,
      replicaId,
      collectionId,
      collection,
      peer,
      peerSpaceId,
      peerUrl
    } = options

    const stored = await this.#storage.getCollectionMetadata({
      spaceId,
      collectionId
    })
    // The stored object is the peer's life of the Collection when its
    // generation is the one the loop state holds; otherwise it is pulled.
    const held =
      collection.generation !== undefined &&
      stored?.metaGeneration === collection.generation
        ? stored
        : await this.#pullCollectionMetadata(options)
    if (typeof held === 'string') {
      return held
    }
    // The feed's Resource documents are applied to the Collection's data
    // plane, the server backend its stored `backend.id` selects. A backend
    // other than the control plane needs its copy of the Collection, which a
    // fault after an earlier apply may have left out: without it the data
    // backend skips every Resource, and the checkpoint would pass them by.
    // The copy write is a step of the pull, so a refusal (the quota, a
    // Space gone) stalls this Collection alone.
    const dataBackend = this.#serverBackends.resolve(held.backend?.id)
    if (dataBackend === undefined) {
      return this.#recordStall({
        ...options,
        ...unsupportedBackendStall(held.backend?.id)
      })
    }
    if (dataBackend !== this.#storage) {
      const copied = await this.#applyStep({
        pull: options,
        apply: () =>
          ensureCollectionCopy({
            serverBackends: this.#serverBackends,
            backend: dataBackend,
            spaceId,
            collectionId,
            metadata: held
          })
      })
      if ('ended' in copied) {
        return copied.ended
      }
    }

    // A feed page inlines JSON bodies, so a full page can outgrow what the
    // loop buffers. The page size is then halved, down to one document.
    let limit = REPLICATION_FEED_PAGE_SIZE
    // What the chunk pulls moved since the loop state was last persisted.
    const sincePersist = { bytes: 0, documents: 0 }
    for (;;) {
      const params = new URLSearchParams({
        profile: 'changes',
        limit: String(limit)
      })
      if (collection.checkpoint !== undefined) {
        params.set('checkpoint', collection.checkpoint)
      }
      const url = `${peerUrl(
        queryPath({ spaceId: peerSpaceId, collectionId })
      )}?${params.toString()}`
      let page: Awaited<ReturnType<PeerClient['readJson']>>
      try {
        page = await peer.readJson({
          url,
          expect: [200, 400],
          // One document alone may hold a body as large as a JSON upload
          // into the backend the Resource is applied to.
          ...(limit === 1 && {
            maxBytes:
              REPLICATION_DOCUMENT_MAX_BYTES +
              bufferedBodyLimit(dataBackend.maxUploadBytes)
          })
        })
      } catch (err) {
        if (!(err instanceof PeerRequestError) || !err.bodyTooLarge) {
          throw err
        }
        if (limit === 1) {
          return this.#recordStall({
            ...options,
            reason: 'quota-exceeded',
            detail:
              "The next change document is larger than this server's upload cap."
          })
        }
        limit = Math.ceil(limit / 2)
        continue
      }
      if (page.status === 400) {
        if (collection.checkpoint === undefined) {
          throw new PeerRequestError({
            url,
            detail: 'the peer refused a changes query with no checkpoint.',
            status: 400
          })
        }
        // The peer's feed is in another life: the Collection was deleted and
        // created again. Read its Metadata object and its feed from the start.
        collection.checkpoint = undefined
        collection.generation = undefined
        return 'pending'
      }
      const documents = Array.isArray(page.json.documents)
        ? page.json.documents.filter(isPlainObject)
        : []
      // One registration verdict covers the Resource applies of a page.
      const registration = await this.#dataBackendRegistration({
        dataBackend,
        spaceId,
        replicaId
      })
      if (registration === undefined) {
        return 'unregistered'
      }
      const dataPlane = { backend: dataBackend, ...registration }
      const retries = options.loop.chunkPullRetries
      for (const document of documents) {
        const step = await this.#applyStep({
          pull: options,
          apply: () => this.#applyChange({ ...options, document, dataPlane })
        })
        if ('ended' in step) {
          retries.delete(collectionId)
          return step.ended
        }
        const { result } = step
        if (result.outcome === 'retry' && result.chunkPull !== undefined) {
          return this.#countChunkPullRetry({
            pull: options,
            document,
            failure: result.chunkPull
          })
        }
        retries.delete(collectionId)
        if (result.outcome === 'pending') {
          return 'pending'
        }
        if (result.outcome === 'retry') {
          collection.state = 'syncing'
          delete collection.stall
          return 'pending'
        }
        if (result.outcome === 'applied') {
          collection.lastAppliedAt = new Date().toISOString()
        }
        if (typeof document.checkpoint === 'string') {
          collection.checkpoint = document.checkpoint
        }
        // A run of chunk pulls may have moved many bytes, so their
        // checkpoint is kept before the end of the Collection's pull.
        if (result.pulledBytes !== undefined) {
          sincePersist.bytes += result.pulledBytes
          sincePersist.documents += 1
          if (
            sincePersist.bytes >= REPLICA_STATE_PERSIST_BYTES ||
            sincePersist.documents >= REPLICA_STATE_PERSIST_DOCUMENTS
          ) {
            if (!(await options.persist())) {
              return 'unregistered'
            }
            sincePersist.bytes = 0
            sincePersist.documents = 0
          }
        }
        // The Collection moved to another life under this very document.
        if (collection.generation === undefined) {
          return 'pending'
        }
      }
      if (documents.length < limit) {
        collection.state = 'synced'
        delete collection.stall
        return 'done'
      }
    }
  }

  /**
   * Reads the peer's Collection Metadata object and applies it. On `held`
   * this server holds the peer's life of the Collection, `collection`
   * carries its generation, and `held` is the object as stored.
   * @param options {object}   the pull context, the Collection id and its
   *   loop state
   * @returns {Promise<CollectionMetadata | 'pending' | 'unregistered'>}   the
   *   held object, now the peer's life of the Collection, or the outcome
   *   that stops the pull
   */
  async #pullCollectionMetadata(
    options: CollectionPull
  ): Promise<CollectionMetadata | Exclude<CollectionOutcome, 'done'>> {
    const {
      spaceId,
      replicaId,
      collectionId,
      collection,
      peer,
      peerSpaceId,
      peerUrl
    } = options
    const url = peerUrl(
      collectionMetaPath({ spaceId: peerSpaceId, collectionId })
    )
    const served = await peer.readJson({ url, expect: [200, 404] })
    if (served.status === 404) {
      // Deleted since the listing. Its tombstone arrives next cycle.
      return 'pending'
    }
    const generation = generationOfEtag(served.etag)
    const metadata = storedProjectionOfCollection(served.json)
    if (
      generation === undefined ||
      receivedStampOf(metadata) === undefined ||
      receivedStampOf(metadata.created) === undefined
    ) {
      throw new PeerRequestError({
        url,
        detail:
          'the Collection Metadata object carries no write stamp, no ' +
          'creating stamp, or no validator.'
      })
    }
    // A `backend.id` keeps its meaning across servers. `default` is this
    // server's default through its alias. A fixed id (`fs`, `postgres`)
    // selects this deployment's backend of that id. An id this deployment
    // does not configure, or a backend registered on the peer, stalls before
    // the object is stored, so no Collection here names a backend that
    // cannot serve it.
    const backendId = metadata.backend?.id
    if (this.#serverBackends.resolve(backendId) === undefined) {
      return this.#recordStall({
        ...options,
        ...unsupportedBackendStall(backendId)
      })
    }

    const step = await this.#applyStep({
      pull: options,
      apply: () =>
        this.#storage.applyCollection({
          spaceId,
          replicaId,
          collectionId,
          collection: { deleted: false, generation, metadata }
        })
    })
    if ('ended' in step) {
      return step.ended
    }
    const { result } = step
    this.#dropCaches({ kind: 'collection', result, spaceId, collectionId })
    if (result.outcome === 'applied') {
      collection.lastAppliedAt = new Date().toISOString()
    }
    const held = await this.#storage.getCollectionMetadata({
      spaceId,
      collectionId
    })
    if (held === undefined || held.metaGeneration !== generation) {
      // This server holds a tombstone, or a life of the Collection that wins
      // over the peer's. Its members are not pulled into that life.
      collection.state = 'skipped'
      delete collection.stall
      collection.generation = undefined
      collection.checkpoint = undefined
      return 'pending'
    }
    if (collection.generation !== generation) {
      collection.generation = generation
      collection.checkpoint = undefined
    }
    collection.state = 'syncing'
    delete collection.stall
    return held
  }

  /**
   * Applies one change document of a peer's feed, by `kind`. A `kind` this
   * server does not know is skipped.
   * @param options {object}   the pull context, the Collection id and its
   *   loop state, the change document, and the Collection's data plane with
   *   the `replicaId` a Resource apply there runs under
   * @returns {Promise<ChangeResult>}
   */
  async #applyChange(
    options: CollectionPull & {
      document: Record<string, unknown>
      dataPlane: { backend: StorageBackend; replicaId?: string }
    }
  ): Promise<ChangeResult> {
    const { document, spaceId, collectionId } = options
    // A Resource change drops its own cache, and a Collection Metadata change
    // drops the Collection's, inside the step: each needs more than the
    // final result to decide.
    if (document.kind === 'resource') {
      return this.#applyResourceChange(options)
    }
    if (document.kind === 'collection-metadata') {
      const outcome = await this.#pullCollectionMetadata(options)
      if (outcome === 'unregistered') {
        return { outcome: 'unregistered' }
      }
      // The read itself recorded a stall or a skip in the loop state.
      return { outcome: outcome === 'pending' ? 'pending' : 'skipped' }
    }
    if (document.kind === 'log') {
      const result = await this.#applyLogChange(options)
      this.#dropCaches({ kind: 'log', result, spaceId, collectionId })
      return result
    }
    if (document.kind === 'policy') {
      const result = await this.#applyPolicyChange(options)
      this.#dropCaches({
        kind: 'collection-policy',
        result,
        spaceId,
        collectionId
      })
      return result
    }
    return { outcome: 'skipped' }
  }

  /**
   * Applies a `resource` change document: the content record, then the
   * `/meta` record when the document carries one. When the registration
   * pulls chunk sets, a live record goes through the chunk pull first
   * ({@link ReplicationManager.#pullChunkSet}); a Resource that holds no
   * chunk on either server then applies as a plain record.
   * @param options {object}   as {@link ReplicationManager.#applyChange}
   * @returns {Promise<ChangeResult>}
   */
  async #applyResourceChange(
    options: CollectionPull & {
      document: Record<string, unknown>
      dataPlane: { backend: StorageBackend; replicaId?: string }
    }
  ): Promise<ChangeResult> {
    const {
      spaceId,
      collectionId,
      peer,
      peerSpaceId,
      peerUrl,
      document,
      dataPlane: { backend: dataBackend, replicaId }
    } = options
    const resourceId = document.id
    const stamp = receivedStampOf(document)
    const { generation, contentType } = document
    if (
      !isStorableId(resourceId, RESERVED_RESOURCE_IDS) ||
      stamp === undefined ||
      typeof generation !== 'string' ||
      typeof contentType !== 'string'
    ) {
      // Not a record this server could store or address.
      return { outcome: 'skipped' }
    }
    const members: ResourceApplyMembers = {
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      generation,
      stamp,
      ...(isCreatedBy(document.createdBy) && {
        createdBy: document.createdBy
      }),
      ...(typeof document.writerId === 'string' && {
        writerId: document.writerId
      })
    }

    if (document.deleted === true) {
      const result = await dataBackend.applyResource({
        ...members,
        resource: { deleted: true, contentType }
      })
      this.#dropCaches({
        kind: 'resource',
        result,
        spaceId,
        collectionId,
        resourceId
      })
      return result
    }

    const peerResource = { spaceId: peerSpaceId, collectionId, resourceId }
    let created: { createdAt?: string } | undefined
    // A history log is decided by its bytes and carries no chunk set.
    if (options.pullsChunks && resourceId !== WEBVH_LOG_RESOURCE_ID) {
      // The `ETag` keys the staging, as a directory name on the filesystem
      // backend and a key column on Postgres.
      if (!isStagingKeyEtag(document.etag)) {
        return {
          outcome: 'refused',
          reason: 'source-unavailable',
          detail:
            `The changes document of "${peerUrl(resourcePath(peerResource))}" ` +
            'carries no ETag of printable ASCII within ' +
            `${STAGING_ETAG_MAX_LENGTH} characters.`
        }
      }
      const chunked = await this.#pullChunkSet({
        pull: options,
        document,
        members,
        contentType,
        dataBackend,
        peerResource,
        run: { replicaId: options.replicaId, parentEtag: document.etag }
      })
      if (!('created' in chunked)) {
        return chunked
      }
      created = chunked.created
    }
    created ??= await this.#readCreatedAt({
      peer,
      peerUrl,
      peerResource,
      stamp
    })
    if (created === undefined) {
      return { outcome: 'retry' }
    }
    const acquired = await this.#acquireResourceInput({
      peer,
      peerUrl,
      peerResource,
      document,
      contentType
    })
    if (acquired === undefined) {
      return { outcome: 'retry' }
    }
    return this.#applyLiveResource({
      members,
      created,
      acquired,
      document,
      dataBackend
    })
  }

  /**
   * Applies a live `resource` change document's content record, then its
   * `/meta` record: one `applyResource`, with `chunks` when the content is
   * the parent of a chunk set, whose input is destroyed and released
   * whatever the outcome.
   * @param options {object}
   * @param options.members {ResourceApplyMembers}
   * @param options.created {{ createdAt?: string }}   from the `/meta` read
   * @param options.acquired {{ input: ResourceInput, release: () => void }}
   *   the content the apply stores
   * @param options.document {Record<string, unknown>}   the feed document
   * @param options.dataBackend {StorageBackend}   the backend that serves
   *   the Collection's data plane
   * @param [options.chunks] {{ run: ChunkStagingRun, staged: number[] }}
   *   the staged set the apply swaps in with the content
   * @returns {Promise<ApplyResult>}
   */
  async #applyLiveResource({
    members,
    created,
    acquired: { input, release },
    document,
    dataBackend,
    chunks
  }: {
    members: ResourceApplyMembers
    created: { createdAt?: string }
    acquired: { input: ResourceInput; release: () => void }
    document: Record<string, unknown>
    dataBackend: StorageBackend
    chunks?: { run: ChunkStagingRun; staged: number[] }
  }): Promise<ApplyResult> {
    const { spaceId, replicaId, collectionId, resourceId } = members
    const { epoch } = document
    let result: ApplyResult
    try {
      result = await dataBackend.applyResource({
        ...members,
        ...created,
        resource: {
          deleted: false,
          input,
          ...(typeof epoch === 'string' && { epoch })
        },
        ...(chunks !== undefined && { chunks })
      })
    } finally {
      if (input.kind === 'binary') {
        input.stream.destroy()
      }
      release()
    }
    this.#dropCaches({
      kind: 'resource',
      result,
      spaceId,
      collectionId,
      resourceId
    })
    if (result.outcome === 'unregistered' || result.outcome === 'refused') {
      return result
    }
    return this.#applyResourceMeta({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      document,
      dataBackend,
      contentResult: result
    })
  }

  /**
   * Reads the peer's `/meta` record of a Resource, for the members the
   * content write set, and checks that its content stamp is still the one
   * the feed document carries.
   * @param options {object}
   * @param options.peer {PeerClient}
   * @param options.peerUrl {(path: string) => string}
   * @param options.peerResource {{ spaceId: string, collectionId: string, resourceId: string }}
   * @param options.stamp {WriteStamp}   the feed document's content stamp
   * @returns {Promise<{ createdAt?: string } | undefined>}   `undefined`
   *   when the Resource was written again since the feed page was read
   */
  async #readCreatedAt({
    peer,
    peerUrl,
    peerResource,
    stamp
  }: {
    peer: PeerClient
    peerUrl: (path: string) => string
    peerResource: { spaceId: string; collectionId: string; resourceId: string }
    stamp: WriteStamp
  }): Promise<{ createdAt?: string } | undefined> {
    const meta = await peer.readJson({
      url: peerUrl(metaPath(peerResource)),
      expect: [200, 404]
    })
    const metaStamp = receivedStampOf(meta.json)
    if (
      meta.status === 404 ||
      metaStamp === undefined ||
      compareStamps(metaStamp, stamp) !== 0
    ) {
      return undefined
    }
    const { createdAt } = meta.json
    return typeof createdAt === 'string' ? { createdAt } : {}
  }

  /**
   * The chunk pull of one live `resource` document: it applies the
   * Resource together with its chunk set, or nothing. First the
   * last-writer-wins decision against the held content record, a tombstone
   * included, so a held revision that wins or is equal (which already has
   * its set, since the two land together) applies the `/meta` record alone,
   * reads nothing from the peer, and releases what an earlier run of the
   * registration staged for the Resource. Then the chunk listing, and the rest of the pull when
   * either server holds a chunk of the Resource. A request to the peer that
   * fails inside the pull ends it in a `retry` counted toward
   * `source-unavailable`, rather than ending the cycle.
   * @param chunk {ChunkPull}
   * @returns {Promise<ChunkPullEnd>}
   */
  async #pullChunkSet(chunk: ChunkPull): Promise<ChunkPullEnd> {
    const { members, dataBackend, document, run } = chunk
    const { spaceId, replicaId, collectionId, resourceId, stamp } = members
    // A held tombstone decides as a live record does.
    const held = await dataBackend.getResourceContentStamp({
      spaceId,
      collectionId,
      resourceId
    })
    const decided = decideResourceApply({
      resourceId,
      deleted: false,
      stamp,
      held: held?.stamp
    })
    if (decided !== undefined) {
      // What an earlier run staged for a revision the held one beats.
      await dataBackend.reclaimStaging({
        spaceId,
        collectionId,
        resourceId,
        replicaId: run.replicaId
      })
      return this.#applyResourceMeta({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        document,
        dataBackend,
        contentResult: decided
      })
    }
    try {
      return await this.#pullWinningChunkSet(chunk)
    } catch (err) {
      const failure = peerFailureOf(err)
      if (failure === undefined) {
        throw err
      }
      return {
        outcome: 'retry',
        chunkPull: { reason: 'source-unavailable', detail: failure.message }
      }
    }
  }

  /**
   * The chunk pull of a revision that wins over the held one, in order: the
   * peer's chunk listing and the `/meta` read together, the open of the
   * staging run with its quota pre-check, each listed chunk into staging,
   * the closing read of the parent, and one `applyResource` with `chunks`.
   * Nothing live changes before that last call.
   * @param chunk {ChunkPull}
   * @returns {Promise<ChunkPullEnd>}
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #pullWinningChunkSet(chunk: ChunkPull): Promise<ChunkPullEnd> {
    const { pull, members, dataBackend, peerResource, run } = chunk
    const { spaceId, collectionId, resourceId } = members
    const [listing, created] = await Promise.all([
      this.#readChunkListing(chunk),
      this.#readCreatedAt({
        peer: pull.peer,
        peerUrl: pull.peerUrl,
        peerResource,
        stamp: members.stamp
      })
    ])
    if (!('chunks' in listing)) {
      return listing
    }
    if (listing.chunks.length === 0) {
      // `beginChunkStaging` reads the live set again under the lock, so it
      // is read here only when the peer lists no chunk.
      const live = await dataBackend.listChunks({
        spaceId,
        collectionId,
        resourceId
      })
      if (live.count === 0) {
        // The Resource applies as a plain record, so no run of the
        // registration for it is left to finish.
        await dataBackend.reclaimStaging({
          spaceId,
          collectionId,
          resourceId,
          replicaId: run.replicaId
        })
        return created === undefined ? { outcome: 'retry' } : { created }
      }
    }
    if (created === undefined) {
      return obsoleteRetry(pull.peerUrl(metaPath(peerResource)))
    }
    // One registration verdict covers the staging of the set. On the
    // control plane the backend reads the registration itself.
    if (
      (await this.#dataBackendRegistration({
        dataBackend,
        spaceId,
        replicaId: pull.replicaId
      })) === undefined
    ) {
      return { outcome: 'unregistered' }
    }
    // Opens the run: drops the registration's staging of an earlier
    // revision of the Resource, checks the quota, and tells what an earlier
    // run of this pull staged.
    const opened = await dataBackend.beginChunkStaging({
      ...members,
      run,
      listed: listing.chunks
    })
    if (!('staged' in opened)) {
      return opened
    }
    const pulled = await this.#stageChunks({
      chunk,
      listed: listing.chunks,
      staged: opened.staged
    })
    if (!('staged' in pulled)) {
      return pulled
    }
    const parent = await this.#closingParentRead(chunk)
    if (!('input' in parent)) {
      return parent
    }
    const result = await this.#applyLiveResource({
      members,
      created,
      acquired: parent,
      document: chunk.document,
      dataBackend,
      // Every listed index is staged: a live chunk's validator is this
      // server's own, which no listed `etag` names.
      chunks: { run, staged: pulled.staged }
    })
    return { ...result, pulledBytes: pulled.pulledBytes }
  }

  /**
   * Reads and checks the peer's chunk listing of a Resource. The listing is
   * not paginated, so one larger than a document the loop buffers is read
   * again under the bound of a feed page of one document, and stalls the
   * Collection as `quota-exceeded` when it still does not fit. A listing
   * that fails its checks ({@link checkedChunkListing}) stalls it as
   * `source-unavailable`.
   * @param chunk {ChunkPull}
   * @returns {Promise<{ chunks: ListedChunk[] } | ChangeResult>}
   *   the checked entries, or how the chunk pull ends
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #readChunkListing({
    pull,
    dataBackend,
    peerResource
  }: ChunkPull): Promise<{ chunks: ListedChunk[] } | ChangeResult> {
    const url = pull.peerUrl(chunksContainerPath(peerResource))
    const bounds = [
      REPLICATION_DOCUMENT_MAX_BYTES,
      REPLICATION_DOCUMENT_MAX_BYTES +
        bufferedBodyLimit(dataBackend.maxUploadBytes)
    ]
    let served: Awaited<ReturnType<PeerClient['readJson']>> | undefined
    for (const maxBytes of bounds) {
      try {
        served = await pull.peer.readJson({ url, expect: [200, 404], maxBytes })
        break
      } catch (err) {
        if (!(err instanceof PeerRequestError) || !err.bodyTooLarge) {
          throw err
        }
      }
    }
    if (served === undefined) {
      return {
        outcome: 'refused',
        reason: 'quota-exceeded',
        detail: `The chunk listing at "${url}" is larger than this server reads.`
      }
    }
    if (served.status === 404) {
      // The parent is gone, or the grant no longer reaches it.
      return { outcome: 'retry', chunkPull: notFoundFailure(url) }
    }
    const chunks = checkedChunkListing(served.json)
    if (chunks === undefined) {
      return {
        outcome: 'refused',
        reason: 'source-unavailable',
        detail: `The chunk listing at "${url}" is malformed.`
      }
    }
    return { chunks }
  }

  /**
   * Stages each listed chunk, `REPLICA_CHUNK_PULL_CONCURRENCY` at a time, in
   * listing order. A chunk an earlier run staged under the `ETag` the listing
   * names is held as it stands, with no request; every other one is read.
   * Before each chunk it checks the loop's stop signal, so a stop ends the
   * pull at the next chunk. The first read that does not end `staged`, or that
   * throws, ends the pull: no further chunk is started, and the reads in
   * flight finish first, so what they staged is there for the re-run. The
   * registration was checked once for the set; a Delete Replica or a
   * Delete Space during the set is met by `stageChunk` on the control
   * plane, and by the swap on any backend.
   * @param options {object}
   * @param options.chunk {ChunkPull}
   * @param options.listed {ListedChunk[]}   the peer's checked listing
   * @param options.staged {{ index: number, peerEtag: string }[]}   what an
   *   earlier run of this pull staged
   * @returns {Promise<{ staged: number[], pulledBytes: number } | ChangeResult>}
   *   the staged indexes and the chunk bytes read from the peer, or how the
   *   pull ends
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #stageChunks({
    chunk,
    listed,
    staged
  }: {
    chunk: ChunkPull
    listed: ListedChunk[]
    staged: Array<{ index: number; peerEtag: string }>
  }): Promise<{ staged: number[]; pulledBytes: number } | ChangeResult> {
    const { pull } = chunk
    const stagedEtags = new Map(
      staged.map(({ index, peerEtag }) => [index, peerEtag])
    )
    const outcome = { staged: [] as number[], pulledBytes: 0 }
    let ended: ChangeResult | undefined
    let failure: unknown
    let next = 0
    const worker = async (): Promise<void> => {
      try {
        while (
          ended === undefined &&
          failure === undefined &&
          next < listed.length
        ) {
          // A stopped loop ends its cycle as a removed registration does.
          if (pull.loop.stopped) {
            ended = { outcome: 'unregistered' }
            return
          }
          const entry = listed[next++]!
          if (entry.etag === stagedEtags.get(entry.index)) {
            outcome.staged.push(entry.index)
            continue
          }
          const pulled = await this.#pullChunk({ chunk, entry })
          if (pulled === 'staged') {
            outcome.staged.push(entry.index)
            outcome.pulledBytes += entry.size
          } else {
            ended ??= pulled
          }
        }
      } catch (err) {
        failure ??= err
      }
    }
    const workers = Math.min(REPLICA_CHUNK_PULL_CONCURRENCY, listed.length)
    await Promise.all(Array.from({ length: workers }, worker))
    if (failure !== undefined) {
      throw failure
    }
    if (ended !== undefined) {
      return ended
    }
    outcome.staged.sort((left, right) => left - right)
    return outcome
  }

  /**
   * Reads one listed chunk and writes it to the run's staging, under the
   * `ETag` the source server serves it with, which a later run's listing is
   * compared against. A live chunk carries the validator this server minted
   * at its swap, which no listed `etag` names, so a parent rewritten with
   * its chunks untouched re-transfers them. A 404 is a `retry`.
   * @param options {object}
   * @param options.chunk {ChunkPull}
   * @param options.entry {ListedChunk}   the listed chunk
   * @returns {Promise<'staged' | ChangeResult>}   `staged` for a chunk read
   *   and staged
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #pullChunk({
    chunk: { pull, members, dataBackend, peerResource, run },
    entry
  }: {
    chunk: ChunkPull
    entry: ListedChunk
  }): Promise<'staged' | ChangeResult> {
    const { spaceId, replicaId, collectionId, resourceId } = members
    const chunkIndex = entry.index
    const url = pull.peerUrl(chunkPath({ ...peerResource, chunkIndex }))
    const served = await pull.peer.readStream({ url, expect: [200, 404] })
    if (served.status === 404) {
      return { outcome: 'retry', chunkPull: notFoundFailure(url) }
    }
    if (served.stream === undefined || served.etag === undefined) {
      discard(served)
      return {
        outcome: 'retry',
        chunkPull: {
          reason: 'source-unavailable',
          detail: `The source server answered "${url}" without a body or an ETag.`
        }
      }
    }
    let result: ApplyResult | { outcome: 'retry' }
    try {
      result = await dataBackend.stageChunk({
        spaceId,
        replicaId,
        collectionId,
        resourceId,
        run,
        chunkIndex,
        input: binaryInputOf({
          stream: served.stream,
          declaredBytes: served.declaredBytes,
          contentType: entry.contentType
        }),
        peerEtag: served.etag
      })
    } finally {
      discard(served)
    }
    // `skipped` means the Collection is gone here, so the document is
    // skipped as any apply into an absent Collection is. A `retry` (the
    // staging was removed during the transfer) is not counted. The parent
    // need not be held: a first replication stages the set of a new
    // Resource.
    return result.outcome === 'applied' ? 'staged' : result
  }

  /**
   * The closing check of a chunk pull, always a `GET` so a `GET`-only pull
   * capability suffices: the parent must still be the revision the feed
   * document named, else the staged chunks may belong to a newer one. An
   * inline JSON body comes from the feed document, so its read is
   * conditional on the document's `ETag` and must answer 304. A binary
   * parent is read as a plain record's content is
   * ({@link ReplicationManager.#acquireResourceInput}), a 404 a `retry`.
   * @param chunk {ChunkPull}
   * @returns {Promise<{ input: ResourceInput, release: () => void } | ChangeResult>}
   *   the parent's content, or a `retry` counted toward
   *   `chunk-listing-obsolete`
   * @throws {PeerRequestError}   a request to the peer failed
   */
  async #closingParentRead({
    pull,
    document,
    contentType,
    peerResource,
    run
  }: ChunkPull): Promise<
    { input: ResourceInput; release: () => void } | ChangeResult
  > {
    const url = pull.peerUrl(resourcePath(peerResource))
    if ('data' in document) {
      const served = await pull.peer.readStream({
        url,
        expect: [200, 304, 404],
        ifNoneMatch: run.parentEtag
      })
      discard(served)
      if (served.status !== 304) {
        return obsoleteRetry(url)
      }
      return {
        input: { kind: 'json', contentType, data: document.data },
        release: () => {}
      }
    }
    const acquired = await this.#acquireResourceInput({
      peer: pull.peer,
      peerUrl: pull.peerUrl,
      peerResource,
      document,
      contentType,
      expect: [200, 404]
    })
    return acquired ?? obsoleteRetry(url)
  }

  /**
   * Counts a `retry` that ended a chunk pull toward the bounded retry. The
   * count runs while the Collection's checkpoint holds and the pull meets
   * a feed document of the same Resource (its `id`), and at
   * `REPLICA_CHUNK_PULL_RETRY_LIMIT` the Collection stalls on the latest
   * failure's reason, the checkpoint still before the document. Below it
   * the Collection is `syncing`, read again next cycle.
   * @param options {object}
   * @param options.pull {CollectionPull}
   * @param options.document {Record<string, unknown>}   the feed document
   *   whose chunk pull ended in the `retry`
   * @param options.failure {ChunkPullFailure}
   * @returns {'pending'}
   */
  #countChunkPullRetry({
    pull,
    document,
    failure
  }: {
    pull: CollectionPull
    document: Record<string, unknown>
    failure: ChunkPullFailure
  }): 'pending' {
    const { loop, collectionId, collection } = pull
    const key: ChunkPullRetryKey = {
      checkpoint: collection.checkpoint,
      documentId: typeof document.id === 'string' ? document.id : undefined
    }
    const held = loop.chunkPullRetries.get(collectionId)
    const sameDocument =
      held !== undefined &&
      held.checkpoint === key.checkpoint &&
      held.documentId === key.documentId
    const count = sameDocument ? held.count + 1 : 1
    loop.chunkPullRetries.set(collectionId, { ...key, count })
    if (count >= REPLICA_CHUNK_PULL_RETRY_LIMIT) {
      return this.#recordStall({ ...pull, ...failure })
    }
    collection.state = 'syncing'
    delete collection.stall
    return 'pending'
  }

  /**
   * The `replicaId` a Resource apply into the Collection's data plane runs
   * under. On the control plane it is the registration's: the apply reads
   * the registration inside its critical section. Another server backend
   * holds no registrations. For it the registration is checked here, on the
   * control plane, by the rule the apply uses (`registrationStands`), and
   * the apply then runs under no `replicaId`, as a copy of a control-plane
   * record does. That backend still requires its copy of the Space and a
   * live copy of the Collection.
   * @param options {object}
   * @param options.dataBackend {StorageBackend}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @returns {Promise<{ replicaId?: string } | undefined>}   `undefined`
   *   when the registration is gone, or was made for an earlier life of the
   *   Space
   */
  async #dataBackendRegistration({
    dataBackend,
    spaceId,
    replicaId
  }: {
    dataBackend: StorageBackend
    spaceId: string
    replicaId: string
  }): Promise<{ replicaId?: string } | undefined> {
    if (dataBackend === this.#storage) {
      return { replicaId }
    }
    const [registration, space] = await Promise.all([
      this.#storage.getReplica({ spaceId, replicaId }),
      this.#storage.getSpaceMetadata({ spaceId })
    ])
    const stands = registrationStands({
      registeredUnder: registration?.spaceGeneration,
      spaceGeneration: space?.metaGeneration
    })
    return stands ? {} : undefined
  }

  /**
   * Gets the content of a Resource change document: the inline JSON body, or
   * the peer's byte stream.
   * @param options {object}
   * @param options.peer {PeerClient}
   * @param options.peerUrl {(path: string) => string}
   * @param options.peerResource {{ spaceId: string, collectionId: string, resourceId: string }}
   * @param options.document {Record<string, unknown>}
   * @param options.contentType {string}
   * @param [options.expect] {number[]}   the statuses handled, any but 200
   *   as a moved record; by default a 404 throws
   * @returns {Promise<{ input: ResourceInput, release: () => void } | undefined>}
   *   `undefined` when the peer's record moved since the feed page, so the
   *   change is retried
   */
  async #acquireResourceInput({
    peer,
    peerUrl,
    peerResource,
    document,
    contentType,
    expect
  }: {
    peer: PeerClient
    peerUrl: (path: string) => string
    peerResource: { spaceId: string; collectionId: string; resourceId: string }
    document: Record<string, unknown>
    contentType: string
    expect?: number[]
  }): Promise<{ input: ResourceInput; release: () => void } | undefined> {
    if ('data' in document) {
      return {
        input: { kind: 'json', contentType, data: document.data },
        release: () => {}
      }
    }
    const content = await peer.readStream({
      url: peerUrl(resourcePath(peerResource)),
      ...(expect !== undefined && { expect })
    })
    if (content.stream === undefined) {
      return undefined
    }
    if (content.etag !== document.etag) {
      discard(content)
      return undefined
    }
    return {
      input: binaryInputOf({ ...content, contentType }),
      release: content.release
    }
  }

  /**
   * Applies the `/meta` record a Resource change document carries, after its
   * content was applied or skipped.
   * @param options {object}
   * @param options.spaceId {string}
   * @param [options.replicaId] {string}   the id the apply runs under: the
   *   registration's on the control plane, none on another server backend
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.document {Record<string, unknown>}
   * @param options.dataBackend {StorageBackend}   the backend that serves
   *   the Collection's data plane
   * @param options.contentResult {ApplyResult}   the content apply's result,
   *   which stands when there is no meta record or its apply was skipped
   * @returns {Promise<ApplyResult>}
   */
  async #applyResourceMeta({
    spaceId,
    replicaId,
    collectionId,
    resourceId,
    document,
    dataBackend,
    contentResult
  }: {
    spaceId: string
    replicaId: string | undefined
    collectionId: string
    resourceId: string
    document: Record<string, unknown>
    dataBackend: StorageBackend
    contentResult: ApplyResult
  }): Promise<ApplyResult> {
    const metaRecord = document.meta
    if (
      !isPlainObject(metaRecord) ||
      receivedStampOf(metaRecord) === undefined ||
      typeof metaRecord.generation !== 'string'
    ) {
      return contentResult
    }
    const metaResult = await dataBackend.applyResourceMetadata({
      spaceId,
      replicaId,
      collectionId,
      resourceId,
      meta: metaRecord as unknown as ResourceMetaStamp,
      ...(isPlainObject(document.custom) && { custom: document.custom })
    })
    return metaResult.outcome === 'skipped' ? contentResult : metaResult
  }

  /**
   * Applies a `log` change document: the Collection's governing history log.
   * @param options {object}   as {@link ReplicationManager.#applyChange}
   * @returns {Promise<ChangeResult>}
   */
  async #applyLogChange({
    spaceId,
    replicaId,
    collectionId,
    peer,
    peerSpaceId,
    peerUrl,
    document
  }: PullContext & {
    collectionId: string
    document: Record<string, unknown>
  }): Promise<ChangeResult> {
    const stamp = receivedStampOf(document)
    const { generation } = document
    if (stamp === undefined || typeof generation !== 'string') {
      return { outcome: 'skipped' }
    }
    const served = await peer.read({
      url: peerUrl(collectionLogPath({ spaceId: peerSpaceId, collectionId })),
      expect: [200, 404]
    })
    if (served.status === 404 || served.etag !== document.etag) {
      return { outcome: 'retry' }
    }
    return this.#storage.applyCollectionLog({
      spaceId,
      replicaId,
      collectionId,
      body: served.body.toString('utf8'),
      generation,
      stamp
    })
  }

  /**
   * Applies a `policy` change document: the Collection's own policy or a
   * Resource's, live or a tombstone. Its `id` is the policy's URL on the
   * peer, which names the level.
   * @param options {object}   as {@link ReplicationManager.#applyChange}
   * @returns {Promise<ChangeResult>}
   */
  async #applyPolicyChange({
    spaceId,
    replicaId,
    collectionId,
    peer,
    peerSpaceId,
    peerUrl,
    document
  }: PullContext & {
    collectionId: string
    document: Record<string, unknown>
  }): Promise<ChangeResult> {
    const collectionUrl = peerUrl(
      collectionPath({ spaceId: peerSpaceId, collectionId })
    )
    const { id } = document
    if (typeof id !== 'string' || !id.startsWith(collectionUrl)) {
      return { outcome: 'skipped' }
    }
    // `policy` for the Collection's own, `<resourceId>/policy` for a
    // Resource's.
    const segments = id.slice(collectionUrl.length).split('/')
    const resourceId = segments.length === 2 ? segments[0] : undefined
    if (
      segments[segments.length - 1] !== 'policy' ||
      segments.length > 2 ||
      (resourceId !== undefined && !isUrlSafeSegment(resourceId))
    ) {
      return { outcome: 'skipped' }
    }
    const url = `${peerUrl(
      policyPath({ spaceId: peerSpaceId, collectionId, resourceId })
    )}?include=deleted`
    const served = await peer.readJson({ url, expect: [200, 404] })
    if (served.status === 404 || served.etag !== document.etag) {
      return { outcome: 'retry' }
    }
    return this.#applyServedPolicy({
      spaceId,
      replicaId,
      collectionId,
      ...(resourceId !== undefined && { resourceId }),
      url,
      served
    })
  }

  /**
   * Runs one apply step of a Collection's pull and handles the outcomes that
   * end the pull: a refusal, returned or thrown (see {@link stallOfError}),
   * stalls the Collection, and a registration that is gone stops the loop.
   * Any other error is rethrown.
   * @param options {object}
   * @param options.pull {CollectionPull}   the pull the step belongs to
   * @param options.apply {() => Promise<T>}   the step; one that answers
   *   nothing ends the pull only by throwing
   * @returns {Promise<{ ended: 'pending' | 'unregistered' } | { result: T }>}
   *   `ended` when the pull stops, else the step's result
   */
  async #applyStep<T extends ChangeResult | void>({
    pull,
    apply
  }: {
    pull: CollectionPull
    apply: () => Promise<T>
  }): Promise<{ ended: 'pending' | 'unregistered' } | { result: T }> {
    let result: T
    try {
      result = await apply()
    } catch (err) {
      const refusal = stallOfError(err)
      if (refusal === undefined) {
        throw err
      }
      return { ended: this.#recordStall({ ...pull, ...refusal }) }
    }
    const settled: ChangeResult | void = result
    if (settled === undefined) {
      return { result }
    }
    if (settled.outcome === 'unregistered') {
      return { ended: 'unregistered' }
    }
    if (settled.outcome === 'refused') {
      const { reason, detail } = settled
      return { ended: this.#recordStall({ ...pull, reason, detail }) }
    }
    return { result }
  }

  /**
   * Records a stall on a Collection's loop state, keeping the time of a
   * stall that already stood for the same reason. A clock-bound stall is
   * logged at `warn` when it begins, naming the peer. The Collection's pull
   * then stops for this cycle.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.replicaId {string}
   * @param options.collectionId {string}
   * @param options.collection {ReplicaCollectionState}
   * @param options.record {StoredReplica['record']}
   * @param options.reason {ReplicaStallReason}
   * @param options.detail {string}
   * @returns {'pending'}
   */
  #recordStall({
    spaceId,
    replicaId,
    collectionId,
    collection,
    record,
    reason,
    detail
  }: {
    spaceId: string
    replicaId: string
    collectionId: string
    collection: ReplicaCollectionState
    record: StoredReplica['record']
    reason: ReplicaStallReason
    detail: string
  }): 'pending' {
    const standing =
      collection.state === 'stalled' && collection.stall?.reason === reason
    if (!standing) {
      this.#logger.warn(
        { spaceId, replicaId, collectionId, peer: record.fromSpace, reason },
        `The pull of a Collection stalled: ${detail}`
      )
    }
    collection.state = 'stalled'
    collection.stall = {
      reason,
      since: standing ? collection.stall!.since : new Date().toISOString(),
      detail
    }
    return 'pending'
  }

  /**
   * The one place that lists which request-layer caches an applied record
   * leaves stale. Drops them only when the apply path reported `applied`.
   * @param options {object}
   * @param options.kind {string}   the kind of record applied
   * @param options.result {{ outcome: string }}   what the apply did
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}
   * @param [options.resourceId] {string}
   * @returns {void}
   */
  #dropCaches({
    kind,
    result,
    spaceId,
    collectionId,
    resourceId
  }: {
    kind:
      | 'space-name'
      | 'space-policy'
      | 'collection'
      | 'collection-policy'
      | 'log'
      | 'resource'
    result: { outcome: string }
    spaceId: string
    collectionId?: string
    resourceId?: string
  }): void {
    if (result.outcome !== 'applied') {
      return
    }
    const storage = this.#storage
    if (kind === 'space-name') {
      invalidateSpaceMetadata({ storage, spaceId })
    } else if (kind === 'space-policy') {
      invalidatePolicy({ storage, spaceId })
    } else if (kind === 'collection') {
      forgetDeletedWebvhLocation({
        storage,
        spaceId,
        collectionId: collectionId!
      })
      invalidateCollectionPolicies({
        storage,
        spaceId,
        collectionId: collectionId!
      })
      invalidateCollectionGovernedDescriptors({
        storage,
        spaceId,
        collectionId: collectionId!
      })
    } else if (kind === 'collection-policy') {
      invalidateCollectionPolicies({
        storage,
        spaceId,
        collectionId: collectionId!
      })
    } else if (kind === 'log') {
      invalidateCollectionGovernedDescriptors({
        storage,
        spaceId,
        collectionId: collectionId!
      })
    } else {
      invalidateResolvedWebvhDid({
        storage,
        spaceId,
        collectionId: collectionId!,
        resourceId: resourceId!
      })
    }
  }
}

/**
 * What every step of a pull is handed: the local Space and registration, the
 * peer client, and the peer Space's id and URL builder. Also the loop the
 * cycle runs in, whether the registration pulls chunk sets, and `persist`,
 * which stores the cycle's loop state and resolves `false` when the
 * registration is gone.
 */
interface PullContext {
  spaceId: string
  replicaId: string
  peer: PeerClient
  peerSpaceId: string
  peerUrl: (path: string) => string
  record: StoredReplica['record']
  loop: Loop
  pullsChunks: boolean
  persist: () => Promise<boolean>
}

/**
 * The pull context of one Collection, with its id and its loop state.
 */
type CollectionPull = PullContext & {
  collectionId: string
  collection: ReplicaCollectionState
}

/**
 * The members of a Resource content apply that a `resource` change document
 * sets. `replicaId` is the id the apply runs under: the registration's on
 * the control plane, none on another server backend.
 */
interface ResourceApplyMembers {
  spaceId: string
  replicaId?: string
  collectionId: string
  resourceId: string
  generation: string
  stamp: WriteStamp
  createdBy?: IDID[]
  writerId?: string
}

/**
 * What every step of one chunk pull is handed: the Collection's pull, the
 * feed document and the apply members it sets, the backend that serves the
 * Collection's data plane, the Resource's ids on the peer, and the staging
 * run, keyed by the registration and the document's `etag`.
 */
interface ChunkPull {
  pull: CollectionPull
  document: Record<string, unknown>
  members: ResourceApplyMembers
  contentType: string
  dataBackend: StorageBackend
  peerResource: { spaceId: string; collectionId: string; resourceId: string }
  run: ChunkStagingRun
}

/**
 * The binary input of an apply, from a stream the source server served.
 * @param options {object}
 * @param options.stream {Readable}
 * @param [options.declaredBytes] {number}
 * @param options.contentType {string}
 * @returns {ResourceInput}
 */
function binaryInputOf({
  stream,
  declaredBytes,
  contentType
}: {
  stream: Readable
  declaredBytes?: number
  contentType: string
}): ResourceInput {
  return {
    kind: 'binary',
    contentType,
    stream,
    ...(declaredBytes !== undefined && { declaredBytes })
  }
}

/**
 * Releases a served response whose body, if one came, is not read.
 * @param served {PeerStream}
 */
function discard(served: PeerStream): void {
  if (served.stream !== undefined) {
    served.stream.destroy()
    served.release()
  }
}

/**
 * The `retry` of a chunk pull whose closing check failed: the source
 * server's Resource was written again during the pull.
 * @param url {string}   the URL whose read showed it
 * @returns {ChangeResult}
 */
function obsoleteRetry(url: string): ChangeResult {
  return {
    outcome: 'retry',
    chunkPull: {
      reason: 'chunk-listing-obsolete',
      detail: `The Resource at "${url}" was written again during its chunk pull.`
    }
  }
}

/**
 * The failure of a chunk pull read the source server answered 404: the
 * parent is gone, or the pull capability no longer reaches it. A deleted
 * parent's tombstone is read from the held checkpoint next cycle, so only a
 * 404 that stands cycle after cycle stalls the Collection.
 * @param url {string}
 * @returns {ChunkPullFailure}
 */
function notFoundFailure(url: string): ChunkPullFailure {
  return {
    reason: 'source-unavailable',
    detail: `The source server answered 404 to "${url}".`
  }
}

/**
 * The `PeerRequestError` behind an error thrown inside a chunk pull, or
 * `undefined` for one that is not a failed request to the peer. A storage
 * write that read a peer stream may wrap the stream's error, so the `cause`
 * chain is followed. A refusal of the write ({@link stallOfError}) is not a
 * peer failure.
 * @param err {unknown}
 * @returns {PeerRequestError | undefined}
 */
function peerFailureOf(err: unknown): PeerRequestError | undefined {
  if (stallOfError(err) !== undefined) {
    return undefined
  }
  let current = err
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof PeerRequestError) {
      return current
    }
    current = current.cause
  }
  return undefined
}

/**
 * The longest feed document `ETag` a chunk pull keys its staging by. Its
 * base64url form names a filesystem directory, which stays within the
 * 255-byte name limit at this length.
 */
const STAGING_ETAG_MAX_LENGTH = 160

/**
 * Whether a feed document's `etag` can key a chunk pull's staging: a
 * string of printable ASCII, not empty, and at most
 * `STAGING_ETAG_MAX_LENGTH` characters.
 * @param etag {unknown}
 * @returns {boolean}
 */
function isStagingKeyEtag(etag: unknown): etag is string {
  return (
    typeof etag === 'string' &&
    etag.length <= STAGING_ETAG_MAX_LENGTH &&
    /^[ -~]+$/.test(etag)
  )
}

/**
 * The longest chunk `contentType` a chunk listing may carry.
 */
const CHUNK_CONTENT_TYPE_MAX_LENGTH = 128

/**
 * A media type of RFC 9110 token characters, with optional parameters of
 * printable ASCII.
 */
const MEDIA_TYPE_SHAPE =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(;[ -~]*)?$/

/**
 * Whether a listed chunk's `contentType` is one a store can hold: a bounded
 * ASCII media type (`MEDIA_TYPE_SHAPE`), whose chunk file name
 * (`fileNameFor`, which percent-encodes it) fits a 255-byte filesystem
 * name at any index.
 * @param contentType {unknown}
 * @returns {boolean}
 */
function isStorableChunkContentType(
  contentType: unknown
): contentType is string {
  return (
    typeof contentType === 'string' &&
    contentType.length <= CHUNK_CONTENT_TYPE_MAX_LENGTH &&
    MEDIA_TYPE_SHAPE.test(contentType) &&
    fileNameFor({ resourceId: String(MAX_CHUNK_INDEX), contentType }).length <=
      255
  )
}

/**
 * One entry of a source server's chunk listing, as `checkedChunkListing`
 * checked it. The `etag` is the source server's own, opaque here, and
 * compared only against the one an earlier run staged the index under.
 */
type ListedChunk = ChunkListing['chunks'][number]

/**
 * The entries of a source server's chunk listing, checked before any of it
 * is used: each `index` one a chunk route addresses
 * (`parseChunkIndexSegment`), strictly
 * ascending, each `size` a non-negative safe integer, each `contentType` a
 * media type a store can hold (`isStorableChunkContentType`), and each
 * `etag` a string.
 * @param json {Record<string, unknown>}   the listing body
 * @returns {ListedChunk[] | undefined}   `undefined` for a
 *   malformed listing
 */
function checkedChunkListing(
  json: Record<string, unknown>
): ListedChunk[] | undefined {
  if (!Array.isArray(json.chunks)) {
    return undefined
  }
  const checked: ListedChunk[] = []
  let previous = -1
  for (const entry of json.chunks) {
    if (!isPlainObject(entry)) {
      return undefined
    }
    const { index, size, contentType, etag } = entry
    if (
      typeof index !== 'number' ||
      parseChunkIndexSegment(String(index)) !== index ||
      index <= previous ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !isStorableChunkContentType(contentType) ||
      typeof etag !== 'string'
    ) {
      return undefined
    }
    checked.push({ index, size, contentType, etag })
    previous = index
  }
  return checked
}

/**
 * The stall of a Collection whose `backend.id` selects no server backend of
 * this deployment.
 * @param [backendId] {string}   the Collection's selection
 * @returns {{ reason: ReplicaStallReason, detail: string }}
 */
function unsupportedBackendStall(backendId: string | undefined): {
  reason: ReplicaStallReason
  detail: string
} {
  return {
    reason: 'unsupported-backend',
    detail:
      `The Collection selects backend "${backendId}", which is not a ` +
      'server backend this deployment configures.'
  }
}

/**
 * The stall an error thrown by the apply path stands for, or `undefined` for
 * an error that is not a refusal of the write: a quota or the upload cap
 * (`quota-exceeded`), or a Space or Collection that is gone
 * (`container-refused`).
 * @param err {unknown}
 * @returns {{ reason: ReplicaStallReason, detail: string } | undefined}
 */
function stallOfError(
  err: unknown
): { reason: ReplicaStallReason; detail: string } | undefined {
  if (!(err instanceof ProblemError)) {
    return undefined
  }
  if (err.statusCode === 507 || err.statusCode === 413) {
    return { reason: 'quota-exceeded', detail: err.message }
  }
  if (err.statusCode === 404) {
    return { reason: 'container-refused', detail: err.message }
  }
  return undefined
}
