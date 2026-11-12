/**
 * A Collection's governing history log (the `governed-history-logs` feature):
 * the `.../meta/log` sub-resource whose head entry's `state` the server serves
 * as the Collection's `encryption` descriptor. The `state`'s `revisions` slot,
 * when present, is served as the Collection's `revisions` descriptor instead.
 * The server checks the line contract alone (JSON Lines, each line an object
 * with a `state` member, the last line is the head) and, on each append, runs
 * the transition checks of both descriptors between the prior head and the new
 * one. It also checks the
 * two members the derived `history` stamp depends on: the genesis entry's
 * `parameters.method`, and the absence of a `history` member in every entry's
 * `state`. Entry proofs, the hash chain, and `state.type` belong to the
 * governing profile and are not checked here; a verifying reader checks them
 * and compares its result against the derived member.
 */
import type {
  CollectionEncryption,
  CollectionRevisions
} from '@interop/storage-core'
import type {
  CollectionLogResult,
  StoredCollectionLog,
  StoredCollectionMetadata
} from '../types.js'
import {
  type EtagValidator,
  type HeldValidators,
  etagOf,
  mintValidator,
  stampedValidator
} from './etag.js'
import type { HybridLogicalClock } from './hlc.js'
import { assertCollectionLogWritePrecondition } from './preconditions.js'
import {
  InvalidRequestBodyError,
  PreconditionFailedError,
  StorageError
} from '../errors.js'
import { isPlainObject } from './isPlainObject.js'
import {
  assertEncryptionDescriptorTransition,
  assertSupportedEncryption
} from './encryption.js'
import {
  assertRevisionsTransition,
  assertValidRevisions,
  splitGovernedState
} from './revisions.js'

/**
 * The descriptors a governing history log derives for its Collection: the
 * served `encryption` member, and the `revisions` member when the head's
 * `state` carries one.
 */
export interface GovernedDescriptors {
  encryption: CollectionEncryption
  revisions?: CollectionRevisions
}

/**
 * The content type the log is served under (JSON Lines, not JSON).
 */
export const LOG_CONTENT_TYPE = 'text/jsonl'

/**
 * Parses a log body under the line contract. Returns the head entry's `state`
 * and the genesis entry's `parameters.method` (the format identifier the
 * derived member's `history.method` echoes). Throws `invalid-request-body`
 * (400) on a body that breaks the contract: empty, a blank line other than a
 * trailing newline, a line that is not a JSON object, a line without an
 * object `state`, a `state` carrying a `history` member (the server stamps
 * that member itself), or a genesis entry without a string
 * `parameters.method`.
 *
 * @param options {object}
 * @param options.body {string}   the JSON Lines log body
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ head: Record<string, unknown>, method: string }}
 */
export function parseGoverningLog({
  body,
  requestName
}: {
  body: string
  requestName?: string
}): { head: Record<string, unknown>; method: string } {
  const lines = body.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  if (lines.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'A history log must carry at least one entry line.'
    })
  }
  const entries = lines.map((line, index) => {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      entry = undefined
    }
    if (!isPlainObject(entry) || !isPlainObject(entry.state)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          `History log line ${index + 1} must be a JSON object with an ` +
          'object "state" member.'
      })
    }
    if (Object.hasOwn(entry.state, 'history')) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          `History log line ${index + 1} carries a "history" member in its ` +
          '"state"; the server derives that member itself.'
      })
    }
    return entry
  })
  const parameters = entries[0]!.parameters
  if (!isPlainObject(parameters) || typeof parameters.method !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'The genesis entry of a history log must carry a string ' +
        '"parameters.method" naming its format.'
    })
  }
  return {
    head: entries.at(-1)!.state as Record<string, unknown>,
    method: parameters.method
  }
}

/**
 * A stored log as a backend hands it over: the body beside the validator built
 * from the stored generation and write stamp.
 * @param stored {StoredCollectionLog}
 * @returns {CollectionLogResult}
 */
export function collectionLogResultOf(
  stored: StoredCollectionLog
): CollectionLogResult {
  return {
    body: stored.body,
    validator: stampedValidator({
      generation: stored.generation,
      stamp: stored
    })
  }
}

/**
 * The backend-agnostic body of `writeCollectionLog`, run inside the backend's
 * critical section against the stored log and the live Collection Metadata
 * object it read there. In order: the precondition against the stored log's
 * `ETag`, the refusal of a body equal to the stored log, the caller's
 * transition check, and the new validator's mint. A re-sent log whose
 * preconditions pass extends the stored bytes by no line, so it is refused
 * with `invalid-request-body` (400) and the backend stores nothing. Otherwise
 * the backend stores the log under the minted validator.
 * @param options {object}
 * @param options.collectionId {string}   for the error detail
 * @param options.collectionMetadata {StoredCollectionMetadata}   the live
 *   Collection Metadata object
 * @param [options.prior] {StoredCollectionLog}   the stored log, if any
 * @param options.body {string}   the new JSON Lines body
 * @param [options.ifMatch] {string}
 * @param [options.ifNoneMatch] {HeldValidators}
 * @param [options.assertTransition] {Function}   run against the prior log
 *   and the Collection Metadata object; throwing aborts the write
 * @param options.clock {HybridLogicalClock}   the store's clock
 * @returns {Promise<EtagValidator>}
 */
export async function mintCollectionLogWrite({
  collectionId,
  collectionMetadata,
  prior,
  body,
  ifMatch,
  ifNoneMatch,
  assertTransition,
  clock
}: {
  collectionId: string
  collectionMetadata: StoredCollectionMetadata
  prior?: StoredCollectionLog
  body: string
  ifMatch?: string
  ifNoneMatch?: HeldValidators
  assertTransition?: (context: {
    prior?: CollectionLogResult
    collectionMetadata: StoredCollectionMetadata
  }) => void | Promise<void>
  clock: HybridLogicalClock
}): Promise<EtagValidator> {
  assertCollectionLogWritePrecondition({
    collectionId,
    currentEtag: prior && etagOf(prior),
    ifMatch,
    ifNoneMatch
  })
  if (prior?.body === body) {
    throw new InvalidRequestBodyError({
      requestName: 'Write Collection History Log',
      detail:
        'The body equals the stored history log: an append carries the ' +
        'stored bytes verbatim followed by one new line.'
    })
  }
  await assertTransition?.({
    prior: prior && collectionLogResultOf(prior),
    collectionMetadata
  })
  return mintValidator({ clock, prior })
}

/**
 * The fast-forward rule an append-only log write passes: the stored bytes are
 * a prefix of the new body, compared byte for byte. A body equal to the stored
 * log passes too. Shared by the governing history log and the `did.jsonl`
 * history log of a self-hosted `did:webvh`.
 * @param options {object}
 * @param options.prior {string | Uint8Array}   the stored log
 * @param options.body {string | Uint8Array}   the new log body
 * @returns {boolean}
 */
export function isFastForward({
  prior,
  body
}: {
  prior: string | Uint8Array
  body: string | Uint8Array
}): boolean {
  // `Buffer.from` copies a byte array, so only a string is converted.
  const priorBytes = typeof prior === 'string' ? Buffer.from(prior) : prior
  const bodyBytes = typeof body === 'string' ? Buffer.from(body) : body
  return (
    bodyBytes.length >= priorBytes.length &&
    Buffer.compare(bodyBytes.subarray(0, priorBytes.length), priorBytes) === 0
  )
}

/**
 * The number of entry lines in a log body under the line contract (a
 * trailing newline closes the last line rather than opening an empty one).
 * @param body {string}
 * @returns {number}
 */
function lineCount(body: string): number {
  const lines = body.split('\n')
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

/**
 * The checks a log write runs atomically with the write: the line contract
 * on the new body, the head `state`'s shape as an encryption descriptor (the
 * same gate a Collection Metadata write passes) and the shape of its
 * `revisions` slot, the fast-forward rule against the stored log, and both
 * descriptors' transitions from the prior head (`epochs` append-only,
 * `currentEpoch` never older, `hmac` id and type permanent, `scheme`
 * unchanged and `version` never lower; `revisions.resolution` and
 * `revisions.immutable` unchanged), raising exactly what a Collection Metadata
 * write raises.
 *
 * The fast-forward rule is what keeps the log append-only at the server: an
 * append carries the stored bytes verbatim followed by exactly one new line.
 * A body the stored log is not a prefix of presumes a log that is not the
 * current one (a stale read, or a rewritten prefix) and is refused as
 * `precondition-failed` (412), whether or not the write carried `If-Match`;
 * a body that extends the stored bytes by other than one line is a malformed
 * append (`invalid-request-body`, 400). So a holder of a write capability
 * can add to the history but cannot erase it; a break inside an appended
 * entry (a bad proof, a broken hash chain) is still the verifying reader's
 * to detect under the governing profile. A create (no stored log) is bound
 * by the line contract alone. An append compares against the prior head's
 * `state`, which is always an object, so the comparison always has a stored
 * descriptor and the creation-only refusal for an absent one does not apply
 * here.
 *
 * @param options {object}
 * @param options.body {string}   the new log body
 * @param [options.prior] {string}   the stored log body, absent on a create
 * @param options.requestName {string}
 * @returns {{ revisions?: CollectionRevisions }}   the new head's `revisions`
 *   slot, for the guarded create's declaration check
 */
export function assertGoverningLogAppend({
  body,
  prior,
  requestName
}: {
  body: string
  prior?: string
  requestName: string
}): { revisions?: CollectionRevisions } {
  const { head } = parseGoverningLog({ body, requestName })
  const { encryptionState, revisions } = splitGovernedState(head)
  const incoming = assertSupportedEncryption({
    encryption: encryptionState,
    requestName
  })
  assertValidRevisions({ revisions, requestName, pointer: null })
  const declared = { ...(revisions !== undefined && { revisions }) }
  if (prior === undefined) {
    return declared
  }
  if (!isFastForward({ prior, body })) {
    throw new PreconditionFailedError({
      requestName,
      detail:
        'The stored history log is not a prefix of the body: an append ' +
        'carries the stored bytes verbatim followed by the new line.'
    })
  }
  const added = lineCount(body) - lineCount(prior)
  if (added !== 1) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        `An append adds exactly one line to the stored history log ` +
        `(${added} added).`
    })
  }
  const existing = splitGovernedState(
    parseGoverningLog({ body: prior, requestName }).head
  )
  assertEncryptionDescriptorTransition({
    stored: { encryption: existing.encryptionState as CollectionEncryption },
    incoming
  })
  assertRevisionsTransition({
    existing: existing.revisions,
    incoming: revisions
  })
  return declared
}

/**
 * Parses a stored governing history log. The body is stored data, validated
 * when it was written (a `/log` PUT or an import), so a body the parser
 * rejects here (the genesis `method` and the `history` refusals included) is
 * a server-side fault and surfaces as `StorageError` (500) rather than as the
 * client-facing 400 the parser raises. Shared by the descriptor derivation
 * below and the import plan's envelope check.
 *
 * @param options {object}
 * @param options.body {string}   the stored log body
 * @returns {ReturnType<typeof parseGoverningLog>}
 */
export function parseStoredGoverningLog({
  body
}: {
  body: string
}): ReturnType<typeof parseGoverningLog> {
  try {
    return parseGoverningLog({ body })
  } catch (err) {
    throw new StorageError({
      cause: new Error('Stored history log breaks the line contract.', {
        cause: err
      })
    })
  }
}

/**
 * The encryption descriptor a stored governing history log's head declares,
 * without the `history` member `deriveGovernedDescriptors` stamps on: the
 * log head's `state` without its `revisions` slot. What the envelope check on
 * an import runs against, for the destination's stored log and the archive's
 * alike, since that check does not read `history`.
 *
 * @param options {object}
 * @param options.body {string}   the stored log body
 * @returns {CollectionEncryption}
 */
export function storedGoverningEncryption({
  body
}: {
  body: string
}): CollectionEncryption {
  const { head } = parseStoredGoverningLog({ body })
  return splitGovernedState(head).encryptionState as CollectionEncryption
}

/**
 * The derived descriptors of a governed Collection. The `encryption` member
 * is the log head's `state` without its `revisions` slot, with
 * `history: { method, resource }` stamped on, `method` being the genesis
 * entry's format identifier and `resource` the log's own URL. Exactly what a
 * verifying reader computes after stripping `history`. The `revisions`
 * member is the head's `revisions` slot verbatim, absent when the slot is.
 * The body is read with `parseStoredGoverningLog`, so a body that does not
 * parse is a `StorageError` (500).
 *
 * @param options {object}
 * @param options.body {string}   the stored log body
 * @param options.logUrl {string}   the absolute URL of the log sub-resource
 * @returns {GovernedDescriptors}
 */
export function deriveGovernedDescriptors({
  body,
  logUrl
}: {
  body: string
  logUrl: string
}): GovernedDescriptors {
  const { head, method } = parseStoredGoverningLog({ body })
  const { encryptionState, revisions } = splitGovernedState(head)
  return {
    encryption: {
      ...encryptionState,
      history: { method, resource: logUrl }
    } as CollectionEncryption,
    ...(revisions !== undefined && { revisions })
  }
}
