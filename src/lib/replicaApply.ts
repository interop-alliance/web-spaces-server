/**
 * The rules a storage backend applies a replicated record by. A pull loop
 * (`src/sync/`) reads a record from a peer and hands it to one of the
 * backend's `apply*` methods, which stores it after one comparison of write
 * stamps. Both backends decide through the functions here, so they cannot
 * drift on what is applied, skipped, or refused.
 *
 * A record is applied when its stamp sorts above the held one, by
 * `(ms, counter, originId)`. An equal or lower stamp is skipped, which is
 * also what stops a record a server pulled from being pulled back. Three
 * records follow other rules. A history log fast-forwards. A Collection
 * tombstone removes every life of the Collection created before it, whatever
 * the stamps of its members. Two lives of one Collection id are ordered by
 * their creating stamps. A chunk carries no received stamp at all: its set
 * is applied with its parent revision in one call (`applyResource` with
 * `chunks`), under a stamp and generation this server mints, so a chunk's
 * stamp orders nothing across servers.
 */
import { StorageError } from '../errors.js'
import type {
  CollectionMetadata,
  CollectionRevisions,
  ReplicaStallReason,
  WriteStamp
} from '../types.js'
import { isFastForward } from './governedLog.js'
import {
  type HybridLogicalClock,
  compareStamps,
  readingOfStamp
} from './hlc.js'
import { isValidOriginId } from './originId.js'
import { IMMUTABLE_MEMBER_DEFAULTS } from './revisions.js'
import { WEBVH_LOG_RESOURCE_ID } from './validateDid.js'

/**
 * What an `apply*` method did with a received record.
 *
 * - `applied` -- stored, under the received stamp.
 * - `skipped` -- not stored: the held record's stamp is equal or greater, or
 *   the record's Collection is absent or tombstoned here.
 * - `unregistered` -- not stored: the registration the apply ran under is
 *   gone, or was made for an earlier life of the Space. The loop stops.
 * - `refused` -- not stored, and the Collection's pull stalls on `reason`.
 */
export type ApplyResult =
  | { outcome: 'applied' }
  | { outcome: 'skipped' }
  | { outcome: 'unregistered' }
  | { outcome: 'refused'; reason: ReplicaStallReason; detail: string }

/**
 * The `refused` member of `ApplyResult`.
 */
type RefusedApply = Extract<ApplyResult, { outcome: 'refused' }>

/**
 * Whether a received value is a whole write stamp a store can hold: an
 * `updatedAt` that parses as a date at or after the epoch, a counter that is
 * a safe non-negative integer, and an origin id within the charset. A stamp
 * that fails this would break the `ETag` on every later read.
 * @param stamp {unknown}
 * @returns {boolean}
 */
export function isReceivableStamp(stamp: unknown): stamp is WriteStamp {
  if (typeof stamp !== 'object' || stamp === null) {
    return false
  }
  const candidate = stamp as Partial<WriteStamp>
  const reading = readingOfStamp(candidate)
  return (
    reading !== undefined &&
    reading.ms >= 0 &&
    reading.counter >= 0 &&
    isValidOriginId(candidate.originId)
  )
}

/**
 * Refuses a received stamp no store can hold. The pull loop checks every
 * stamp before it calls an apply method, so one that reaches a backend is a
 * fault of the caller.
 * @param stamps {unknown[]}   every stamp the received record carries
 * @returns {void}
 * @throws {StorageError}   a stamp is not one a store can hold
 */
export function assertReceivableStamps(
  stamps: unknown[]
): asserts stamps is WriteStamp[] {
  for (const stamp of stamps) {
    if (!isReceivableStamp(stamp)) {
      throw new StorageError({
        requestName: 'Apply Replicated Record',
        cause: new Error(
          `A replicated record carries an unusable write stamp: ${JSON.stringify(stamp)}`
        )
      })
    }
  }
}

/**
 * Whether a replica registration admits an apply: it is stored, and was made
 * under the Space Metadata object's current generation. The apply methods
 * check it inside their critical section (`guardApply`), and the pull loop
 * checks it on the control plane before a Resource apply into another
 * server backend, which holds no registrations.
 * @param options {object}
 * @param [options.registeredUnder] {string}   the Space generation the
 *   registration was made under; absent when the registration is not stored
 * @param [options.spaceGeneration] {string | null}   the Space Metadata
 *   object's generation; absent when the Space has no Metadata object
 * @returns {boolean}
 */
export function registrationStands({
  registeredUnder,
  spaceGeneration
}: {
  registeredUnder?: string
  spaceGeneration?: string | null
}): boolean {
  return (
    typeof registeredUnder === 'string' && registeredUnder === spaceGeneration
  )
}

/**
 * The two checks every apply method makes first, inside its critical
 * section, once it has read the registration and the Space. The
 * registration must stand (`registrationStands`). Then the store's clock
 * takes in each received stamp, and one dated more than the clock bound
 * ahead of local time stops the apply.
 * @param options {object}
 * @param [options.registeredUnder] {string}   the Space generation the
 *   registration was made under; absent when the registration is not stored
 * @param [options.spaceGeneration] {string | null}   the Space Metadata
 *   object's generation; absent when the Space has no Metadata object
 * @param options.clock {HybridLogicalClock}   the store's clock
 * @param options.stamps {WriteStamp[]}   every stamp the record carries
 * @returns {ApplyResult | undefined}   the result that ends the apply, or
 *   `undefined` when it may go on
 */
export function guardApply({
  registeredUnder,
  spaceGeneration,
  clock,
  stamps
}: {
  registeredUnder?: string
  spaceGeneration?: string | null
  clock: HybridLogicalClock
  stamps: WriteStamp[]
}): ApplyResult | undefined {
  if (!registrationStands({ registeredUnder, spaceGeneration })) {
    return { outcome: 'unregistered' }
  }
  for (const stamp of stamps) {
    // A receivable stamp always has a reading (`assertReceivableStamps`).
    if (!clock.observe(readingOfStamp(stamp)!)) {
      return {
        outcome: 'refused',
        reason: 'clock-bound',
        detail:
          `A received write stamp is dated ${stamp.updatedAt}, more than ` +
          `${clock.bound} ms ahead of local time.`
      }
    }
  }
  return undefined
}

/**
 * Whether a received stamp wins over the held record's.
 * @param options {object}
 * @param options.incoming {WriteStamp}
 * @param [options.held] {Partial<WriteStamp>}   the held record's stamp;
 *   absent, or partial, when the store holds no stamped record
 * @returns {boolean}
 */
export function stampWins({
  incoming,
  held
}: {
  incoming: WriteStamp
  held?: Partial<WriteStamp>
}): boolean {
  if (!isReceivableStamp(held)) {
    return true
  }
  return compareStamps(incoming, held) > 0
}

/**
 * The Collection record a store holds under an id, as the Collection apply
 * rule reads it.
 */
export type HeldCollection =
  | {
      kind: 'live'
      generation: string
      stamp: Partial<WriteStamp>
      // Absent on a Collection stored before creating stamps existed.
      created?: WriteStamp
    }
  | { kind: 'tombstone'; stamp: Partial<WriteStamp> }

/**
 * The held Collection record as the Collection apply rule reads it, from the
 * parts a backend stores: a tombstone with its stamp, or a live Collection
 * with its generation, stamp and creating stamp. A live record with no
 * generation reads as none held. A creating stamp that is not receivable is
 * left out.
 * @param options {object}
 * @param options.deleted {boolean}   whether the record is a tombstone
 * @param [options.generation] {string}   the live record's generation
 * @param options.stamp {Partial<WriteStamp>}   the record's write stamp
 * @param [options.created] {unknown}   the live record's creating stamp
 * @returns {HeldCollection | undefined}
 */
export function heldCollection({
  deleted,
  generation,
  stamp,
  created
}: {
  deleted: boolean
  generation?: string
  stamp: Partial<WriteStamp>
  created?: unknown
}): HeldCollection | undefined {
  if (deleted) {
    return { kind: 'tombstone', stamp }
  }
  if (generation === undefined) {
    return undefined
  }
  return {
    kind: 'live',
    generation,
    stamp,
    ...(isReceivableStamp(created) && { created })
  }
}

/**
 * Decides what a received live Collection Metadata object does to the held
 * record.
 *
 * - `create` -- nothing is held, or a tombstone older than the received
 *   life's creating stamp is.
 * - `update` -- the same life is held under a lower stamp.
 * - `replace` -- another life is held, created before the received one. The
 *   held life is removed with its members, then the received one is created.
 * - `skip` -- anything else.
 *
 * Two lives with the same creating stamp cannot come from one origin. If two
 * ever tie, the greater generation string wins, so every server picks the
 * same one.
 *
 * @param options {object}
 * @param [options.held] {HeldCollection}
 * @param options.incoming {{ generation: string, stamp: WriteStamp, created: WriteStamp }}
 * @returns {'create' | 'update' | 'replace' | 'skip'}
 */
export function decideCollectionApply({
  held,
  incoming
}: {
  held?: HeldCollection
  incoming: { generation: string; stamp: WriteStamp; created: WriteStamp }
}): 'create' | 'update' | 'replace' | 'skip' {
  if (held === undefined) {
    return 'create'
  }
  if (held.kind === 'tombstone') {
    return stampWins({ incoming: incoming.created, held: held.stamp })
      ? 'create'
      : 'skip'
  }
  if (held.generation === incoming.generation) {
    return stampWins({ incoming: incoming.stamp, held: held.stamp })
      ? 'update'
      : 'skip'
  }
  if (held.created === undefined) {
    return 'replace'
  }
  const order = compareStamps(incoming.created, held.created)
  if (order !== 0) {
    return order > 0 ? 'replace' : 'skip'
  }
  return incoming.generation > held.generation ? 'replace' : 'skip'
}

/**
 * Decides what a received Collection tombstone does to the held record. A
 * tombstone carries no generation. It removes any life created before its
 * stamp, whatever the stamps of that life's later writes.
 *
 * - `write` -- nothing is held. The tombstone is stored, so a stale copy of
 *   the Collection arriving later is not created.
 * - `delete` -- a live Collection created before the tombstone is held. It
 *   is deleted with its members and the tombstone takes the received stamp.
 * - `restamp` -- an older tombstone is held and takes the received stamp.
 * - `skip` -- anything else.
 *
 * @param options {object}
 * @param [options.held] {HeldCollection}
 * @param options.stamp {WriteStamp}   the received tombstone's stamp
 * @returns {'write' | 'delete' | 'restamp' | 'skip'}
 */
export function decideCollectionTombstoneApply({
  held,
  stamp
}: {
  held?: HeldCollection
  stamp: WriteStamp
}): 'write' | 'delete' | 'restamp' | 'skip' {
  if (held === undefined) {
    return 'write'
  }
  if (held.kind === 'tombstone') {
    return stampWins({ incoming: stamp, held: held.stamp }) ? 'restamp' : 'skip'
  }
  return stampWins({ incoming: stamp, held: held.created }) ? 'delete' : 'skip'
}

/**
 * Merges a received Collection Metadata object over the held one of the same
 * life, for an `update`. The received object replaces the held one, except
 * for the members that are immutable once set: `encryption`,
 * `revisions.resolution`, `revisions.immutable` and `backend`, which keeps
 * the held selection as Update Collection's `backend-immutable` rule does.
 * One the received object omits and the held one sets is kept. Two different
 * set values cannot be ordered, so the result is a fork naming the member.
 * `encryption` is declared only by the write that creates a Collection, so a
 * received descriptor the held object lacks is a fork too.
 * `encryption.version` takes the greater of the two. An absent
 * `revisions.resolution` or `revisions.immutable` stands for its default, so
 * a received value other than the default over a held object that lacks the
 * member is a fork, and a restated default is taken.
 *
 * A fork's text says where each object is. The apply path merges the peer's
 * object over the local one, which is the default. The registration check
 * also merges the other way round and passes `sides` to say so.
 *
 * @param options {object}
 * @param options.held {CollectionMetadata}
 * @param options.incoming {CollectionMetadata}
 * @param [options.sides] {{ held: string, incoming: string }}   where each
 *   object is, as a fork's text names it
 * @returns {{ metadata: CollectionMetadata } | { fork: string }}
 */
export function mergeAppliedCollectionMetadata({
  held,
  incoming,
  sides = { held: 'here', incoming: 'on the peer' }
}: {
  held: CollectionMetadata
  incoming: CollectionMetadata
  sides?: { held: string; incoming: string }
}): { metadata: CollectionMetadata } | { fork: string } {
  const merged: CollectionMetadata = { ...incoming }
  if (held.backend !== undefined) {
    merged.backend = held.backend
  }

  if (held.encryption === undefined) {
    if (incoming.encryption !== undefined) {
      return {
        fork: `"encryption" is declared ${sides.incoming} and absent ${sides.held}.`
      }
    }
  } else {
    if (incoming.encryption === undefined) {
      merged.encryption = held.encryption
    } else if (incoming.encryption.scheme !== held.encryption.scheme) {
      return {
        fork:
          `"encryption.scheme" is "${incoming.encryption.scheme}" ` +
          `${sides.incoming} and "${held.encryption.scheme}" ${sides.held}.`
      }
    } else {
      const heldVersion = (held.encryption as { version?: unknown }).version
      const incomingVersion = (incoming.encryption as { version?: unknown })
        .version
      if (
        typeof heldVersion === 'number' &&
        (typeof incomingVersion !== 'number' || incomingVersion < heldVersion)
      ) {
        merged.encryption = {
          ...incoming.encryption,
          version: heldVersion
        } as CollectionMetadata['encryption']
      }
    }
  }

  const revisions: CollectionRevisions = { ...incoming.revisions }
  for (const member of ['resolution', 'immutable'] as const) {
    const heldValue = held.revisions?.[member]
    const incomingValue = incoming.revisions?.[member]
    if (heldValue === undefined) {
      if (
        incomingValue !== undefined &&
        incomingValue !== IMMUTABLE_MEMBER_DEFAULTS[member]
      ) {
        return {
          fork:
            `"revisions.${member}" is ${JSON.stringify(incomingValue)} ` +
            `${sides.incoming} and absent ${sides.held}.`
        }
      }
      continue
    }
    if (incomingValue === undefined) {
      Object.assign(revisions, { [member]: heldValue })
    } else if (incomingValue !== heldValue) {
      return {
        fork:
          `"revisions.${member}" is ${JSON.stringify(incomingValue)} ` +
          `${sides.incoming} and ${JSON.stringify(heldValue)} ${sides.held}.`
      }
    }
  }
  if (Object.keys(revisions).length > 0) {
    merged.revisions = revisions
  }
  return { metadata: merged }
}

/**
 * Decides what a received history log does to the held one, for a
 * Collection's governing history log and for a `did.jsonl` Resource alike. A
 * log only grows, so the stamps do not decide.
 *
 * - `apply` -- nothing is held, or the held bytes are a strict prefix of the
 *   received ones.
 * - `skip` -- the received bytes equal the held ones, or are a prefix of
 *   them.
 * - `fork` -- neither is a prefix of the other.
 *
 * @param options {object}
 * @param [options.held] {string | Uint8Array}   the held log's bytes
 * @param options.incoming {string | Uint8Array}   the received log's bytes
 * @returns {'apply' | 'skip' | 'fork'}
 */
export function decideLogApply({
  held,
  incoming
}: {
  held?: string | Uint8Array
  incoming: string | Uint8Array
}): 'apply' | 'skip' | 'fork' {
  if (held === undefined) {
    return 'apply'
  }
  const extendsHeld = isFastForward({ prior: held, body: incoming })
  const extendsIncoming = isFastForward({ prior: incoming, body: held })
  if (extendsHeld) {
    // Each fast-forwards to the other only when the two are equal.
    return extendsIncoming ? 'skip' : 'apply'
  }
  return extendsIncoming ? 'skip' : 'fork'
}

/**
 * The result that stops the apply of a history log that forked: neither the
 * held log nor the received one is a prefix of the other.
 * @param logName {string}   names the log in the detail
 * @returns {ApplyResult}
 */
export function logForkResult(logName: string): ApplyResult {
  return {
    outcome: 'refused',
    reason: 'fork',
    detail: `The stored ${logName} is not a prefix of the peer's, nor the peer's of it.`
  }
}

/**
 * Decides what a received Resource content record, live or a tombstone,
 * does to the held one. A `did.jsonl` history log is never deleted by a
 * peer, and a live one is decided by its bytes (`decideLogApply`), not by
 * its stamp. Every other record is stored when its stamp wins.
 * @param options {object}
 * @param options.resourceId {string}
 * @param options.deleted {boolean}   whether the received record is a
 *   tombstone
 * @param options.stamp {WriteStamp}   the received stamp
 * @param [options.held] {Partial<WriteStamp>}   the held content record's
 *   stamp, live or a tombstone; absent when none is held
 * @param [options.log] {object}   for a live `did.jsonl` only: the received
 *   bytes as `incoming`, and the held live log's bytes as `held`, absent
 *   when no live log is held
 * @returns {ApplyResult | undefined}   the result that ends the apply, or
 *   `undefined` when the record is to be stored
 */
export function decideResourceApply({
  resourceId,
  deleted,
  stamp,
  held,
  log
}: {
  resourceId: string
  deleted: boolean
  stamp: WriteStamp
  held?: Partial<WriteStamp>
  log?: { held?: Uint8Array; incoming: Uint8Array }
}): ApplyResult | undefined {
  if (deleted && resourceId === WEBVH_LOG_RESOURCE_ID) {
    return { outcome: 'skipped' }
  }
  if (log !== undefined) {
    const decision = decideLogApply(log)
    if (decision === 'fork') {
      return logForkResult(`"${resourceId}" history log`)
    }
    return decision === 'skip' ? { outcome: 'skipped' } : undefined
  }
  return stampWins({ incoming: stamp, held })
    ? undefined
    : { outcome: 'skipped' }
}

/**
 * The refusal of a chunk swap whose chunk set does not match the staging:
 * an index listed twice, or a staged index the run holds no staged chunk
 * for. Each is a fault of the caller, which derives the list from the
 * source server's listing and its own staging.
 * @param options {object}
 * @param options.resourceId {string}   names the Resource in the detail
 * @param options.staged {number[]}
 * @param options.stagedHeld {Set<number>}   the indexes staged under the run
 * @returns {RefusedApply | undefined}   the refusal, or `undefined` when the
 *   set matches
 */
export function chunkSetRefusal({
  resourceId,
  staged,
  stagedHeld
}: {
  resourceId: string
  staged: number[]
  stagedHeld: Set<number>
}): RefusedApply | undefined {
  const refused = (detail: string): RefusedApply => ({
    outcome: 'refused',
    reason: 'container-refused',
    detail: `The chunk set of Resource '${resourceId}' ${detail}`
  })
  if (new Set(staged).size !== staged.length) {
    return refused('names an index twice.')
  }
  const unstaged = staged.find(index => !stagedHeld.has(index))
  if (unstaged !== undefined) {
    return refused(`stages index ${unstaged}, which is not staged.`)
  }
  return undefined
}

/**
 * The quota pre-check of a chunk set, made by `beginChunkStaging` before
 * anything is staged. Each listed chunk must fit the upload cap. The set's
 * net growth is the listed sizes, less what the run already staged (counted
 * in the usage already), less the live chunks the swap frees, so a set the
 * size of the live one fits under a quota the live set fills. Both backends
 * decide through this one function, so they cannot drift on what fits. The
 * check is advisory: a 507 or 413 from staging stays authoritative.
 * @param options {object}
 * @param options.listed {Array<{ index: number, size: number }>}   the
 *   source server's listing
 * @param options.staged {Array<{ size: number }>}   what the run holds
 * @param options.liveBytes {number}   the live chunk bytes the swap frees
 * @param options.usageBytes {number}   the Space's usage
 * @param [options.capacityBytes] {number}   the Space's capacity; absent
 *   for no byte quota
 * @param [options.maxUploadBytes] {number}   the upload cap; absent for none
 * @returns {RefusedApply | undefined}   the `quota-exceeded` refusal, or
 *   `undefined` when the set fits
 */
export function chunkSetQuotaRefusal({
  listed,
  staged,
  liveBytes,
  usageBytes,
  capacityBytes,
  maxUploadBytes
}: {
  listed: Array<{ index: number; size: number }>
  staged: Array<{ size: number }>
  liveBytes: number
  usageBytes: number
  capacityBytes?: number
  maxUploadBytes?: number
}): RefusedApply | undefined {
  const refused = (detail: string): RefusedApply => ({
    outcome: 'refused',
    reason: 'quota-exceeded',
    detail
  })
  const oversized =
    maxUploadBytes === undefined
      ? undefined
      : listed.find(({ size }) => size > maxUploadBytes)
  if (oversized !== undefined) {
    return refused(
      `Chunk ${oversized.index} is ${oversized.size} bytes, over this ` +
        `server's upload cap of ${maxUploadBytes} bytes.`
    )
  }
  if (capacityBytes === undefined) {
    return undefined
  }
  const sum = (sizes: Array<{ size: number }>): number =>
    sizes.reduce((total, { size }) => total + size, 0)
  const growth = sum(listed) - sum(staged) - liveBytes
  if (usageBytes + growth <= capacityBytes) {
    return undefined
  }
  return refused(
    `The chunk set needs ${growth} more bytes, and the Space uses ` +
      `${usageBytes} of its ${capacityBytes}.`
  )
}
