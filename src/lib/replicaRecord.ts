/**
 * A replica registration as a versioned record. Both backends compose the
 * stored record through `composeReplicaRecord`, so the pause rule and the
 * placement of the stamp members cannot drift between them, and the
 * request layer reads the record's validator through `replicaValidator`.
 *
 * The record a write takes is the client's shape: the members a `POST` body
 * carries, without the stamp members. The write mints the stamp with the
 * store's clock inside its critical section and stores the stamp members on
 * the record, as a policy carries its own. `pausedAt` is server-set, and its
 * presence on the client's shape is the request to pause: a write that
 * pauses a registration that was not paused takes the stamp's own time, one
 * that keeps a paused registration paused keeps its stored time, and one
 * that omits the member resumes and drops it.
 */
import { isDeepStrictEqual } from 'node:util'
import type { ReplicaRegistration, WriteStamp } from '@interop/storage-core'

import type { EtagValidator, HeldValidators } from './etag.js'
import { formatEtag, mintValidator, stampedValidator } from './etag.js'
import type { HybridLogicalClock } from './hlc.js'
import { stampOf, withoutStampMembers } from './hlc.js'
import { assertReplicaWritePrecondition } from './preconditions.js'
import {
  IdConflictError,
  InvalidRequestBodyError,
  ReplicaRefusedError
} from '../errors.js'
import type { StoredReplica } from '../types.js'

/**
 * The request name a registration write reports in its errors.
 * @param options {object}
 * @param options.createOnly {boolean}   a `POST`'s write, else a `PUT`'s
 * @returns {string}
 */
export function replicaWriteRequestName({
  createOnly
}: {
  createOnly: boolean
}): string {
  return createOnly ? 'Register Replica' : 'Update Replica'
}

/**
 * The record a write stores: the client's shape under the write's stamp, with
 * `pausedAt` decided by the pause rule from its presence on the client's
 * shape.
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the client's shape; any stamp
 *   member on it is dropped, and the value of `pausedAt` is replaced
 * @param options.stamp {WriteStamp}   the write's stamp
 * @param [options.prior] {ReplicaRegistration}   the stored record a
 *   replacement writes over
 * @returns {ReplicaRegistration}
 */
export function composeReplicaRecord({
  record,
  stamp,
  prior
}: {
  record: ReplicaRegistration
  stamp: WriteStamp
  prior?: ReplicaRegistration
}): ReplicaRegistration {
  const { pausedAt, ...body } = withoutStampMembers(record)
  return {
    ...body,
    ...(pausedAt !== undefined && {
      pausedAt: prior?.pausedAt ?? stamp.updatedAt
    }),
    ...stamp
  }
}

/**
 * The members of a replacement that must equal the stored record's: every
 * member but `capability` and `pausedAt`, which a `PUT` exists to change, and
 * the stamp members, which the write sets. A difference is refused on that
 * member's pointer.
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the client's shape
 * @param options.stored {ReplicaRegistration}   the stored record
 * @param options.requestName {string}
 * @returns {void}
 * @throws {InvalidRequestBodyError}
 */
export function assertReplacementKeepsFixedMembers({
  record,
  stored,
  requestName
}: {
  record: ReplicaRegistration
  stored: ReplicaRegistration
  requestName: string
}): void {
  const fixed = ['fromSpace', 'toSpace', 'collections', 'role'] as const
  for (const member of fixed) {
    if (!isDeepStrictEqual(record[member], stored[member])) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          `The registration "${member}" cannot change. A PUT may differ from ` +
          'the stored registration in "capability" and "pausedAt" alone.',
        pointer: `#/${member}`
      })
    }
  }
}

/**
 * The bound on a create under a delegated invocation (POST, or PUT at an
 * absent id): the registration must name a `fromSpace` that a registration
 * already on the Space names. A delegated grant on the replicas route can
 * therefore re-register a source the Space has, and cannot introduce a new
 * one. Without the bound, the holder of a grant a phished credential signed
 * could register a server of their own as a second source. That source could
 * serve the account DID as `controller`, which the controller check compares
 * as a string, and have its tombstones applied to the copy. A root invocation
 * carries no bound. The request layer runs the check once before the peer is
 * read, so a refused body costs the source server nothing, and the write
 * decides it again from the registrations read inside its critical section,
 * where no concurrent Delete Replica can have emptied the set the first
 * check saw. A delegated caller may list the registrations, so the refusal
 * tells it nothing the listing would not.
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the registration to create
 * @param options.registered {StoredReplica[]}   the Space's registrations
 * @returns {void}
 * @throws {ReplicaRefusedError}
 */
export function assertCreateNamesRegisteredSource({
  record,
  registered
}: {
  record: ReplicaRegistration
  registered: StoredReplica[]
}): void {
  if (registered.some(stored => stored.record.fromSpace === record.fromSpace)) {
    return
  }
  throw new ReplicaRefusedError({
    detail:
      'A delegated invocation may register only a source Space a ' +
      `registration on this Space already names; none names "${record.fromSpace}". ` +
      "Registering a new source takes the Space controller's own capability."
  })
}

/**
 * The validator of a stored registration: its generation and the stamp
 * members its record carries.
 * @param stored {StoredReplica}
 * @returns {EtagValidator}
 */
export function replicaValidator(stored: StoredReplica): EtagValidator {
  return stampedValidator({
    generation: stored.generation,
    stamp: stampOf(stored.record) as WriteStamp
  })
}

/**
 * The decision both backends make inside a registration write's critical
 * section, from the stored registration they read there: a create-only
 * write over one is `IdConflictError`, the preconditions are evaluated
 * against its `ETag`, a replacement must keep the fixed members, a create
 * under `requireRegisteredSource` must name a source the Space's other
 * registrations name, the validator is minted above its stamp (and the
 * generation with it on a create), and the stored record is composed. The
 * preconditions go before the fixed members, as on every other versioned
 * record: a stale conditional write is told so (412) rather than that its
 * body is malformed (400), which a client treats as final. `pullsChunks` is
 * what the request layer's peer checks found for the client's capability; a
 * replacement that keeps the stored capability keeps the stored value with
 * it. The caller persists what comes back.
 * @param options {object}
 * @param [options.prior] {StoredReplica}   the stored registration, if any
 * @param options.record {ReplicaRegistration}   the client's shape
 * @param options.pullsChunks {boolean}   whether the loop pulls chunk sets
 *   under the client's capability
 * @param options.clock {HybridLogicalClock}   the store's clock
 * @param options.currentSpaceGeneration {() => Promise<string>}   the Space
 *   Metadata object's current generation, read only on a create
 * @param options.listReplicas {() => Promise<StoredReplica[]>}   the Space's
 *   registrations, read only on a create under `requireRegisteredSource`
 * @param [options.requireRegisteredSource] {boolean}   the write is under a
 *   delegated invocation, so a create must name a registered source
 *   ({@link assertCreateNamesRegisteredSource})
 * @param [options.createOnly] {boolean}
 * @param [options.ifMatch] {string}
 * @param [options.ifNoneMatch] {HeldValidators}
 * @returns {Promise<{ stored: StoredReplica, prior?: StoredReplica }>}   the
 *   stored registration, and the one it replaced
 * @throws {IdConflictError}
 * @throws {InvalidRequestBodyError}
 * @throws {PreconditionFailedError}
 * @throws {ReplicaRefusedError}
 */
export async function decideReplicaWrite({
  prior,
  record,
  pullsChunks,
  clock,
  currentSpaceGeneration,
  listReplicas,
  requireRegisteredSource = false,
  createOnly = false,
  ifMatch,
  ifNoneMatch
}: {
  prior: StoredReplica | undefined
  record: ReplicaRegistration
  pullsChunks: boolean
  clock: HybridLogicalClock
  currentSpaceGeneration: () => Promise<string>
  listReplicas: () => Promise<StoredReplica[]>
  requireRegisteredSource?: boolean
  createOnly?: boolean
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}): Promise<{ stored: StoredReplica; prior?: StoredReplica }> {
  if (createOnly && prior !== undefined) {
    throw new IdConflictError({ kind: 'Replica' })
  }
  assertReplicaWritePrecondition({
    replicaId: record.id,
    exists: prior !== undefined,
    currentEtag: prior && formatEtag(replicaValidator(prior)),
    ifMatch,
    ifNoneMatch
  })
  if (prior !== undefined) {
    assertReplacementKeepsFixedMembers({
      record,
      stored: prior.record,
      requestName: replicaWriteRequestName({ createOnly })
    })
  } else if (requireRegisteredSource) {
    // A replacement needs no bound: `fromSpace` is a fixed member, so it
    // already equals the stored registration's. A PUT the request layer took
    // for a replacement lands here as a create when the registration was
    // removed meanwhile, and is bounded as one.
    assertCreateNamesRegisteredSource({
      record,
      registered: await listReplicas()
    })
  }
  const validator = await mintValidator({
    clock,
    prior: prior && { generation: prior.generation, ...stampOf(prior.record) }
  })
  const keepsCapability =
    prior !== undefined &&
    isDeepStrictEqual(record.capability, prior.record.capability)
  const stored: StoredReplica = {
    record: composeReplicaRecord({
      record,
      stamp: validator.stamp,
      prior: prior?.record
    }),
    generation: validator.generation,
    spaceGeneration: prior?.spaceGeneration ?? (await currentSpaceGeneration()),
    pullsChunks: keepsCapability ? prior.pullsChunks : pullsChunks
  }
  return { stored, prior }
}
