/**
 * The Collection `revisions` descriptor: what the server does with concurrent
 * revisions of a Collection's Resources (`resolution`), and whether those
 * Resources are write-once (`immutable`), beside a client-declared `merge`
 * object the server stores and serves verbatim and never reads. This module
 * holds the descriptor's shape check, its transition check, the split of a
 * governing history log's `state` into the two descriptors it governs, and the
 * pieces of the write-once rule the request layer and both storage backends
 * share. It sits beside `encryption.ts`, whose creation-only pattern it follows.
 */
import { isDeepStrictEqual } from 'node:util'
import type {
  CollectionLogResult,
  CollectionMetadata,
  CollectionRevisions,
  ImmutableUnder
} from '../types.js'
import { InvalidRequestBodyError, RevisionsImmutableError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'

/**
 * The `resolution` values this server applies. A closed set: a value it does
 * not apply is refused rather than stored, so a client never mistakes an
 * unsupported disposition for an applied one. `last-writer-wins` is the
 * default when the member is absent. `keep-conflicts` is reserved and refused
 * like any other unknown value.
 */
const SUPPORTED_RESOLUTIONS: ReadonlySet<string> = new Set(['last-writer-wins'])

/**
 * The members a `revisions` descriptor may carry. Unlike `encryption`, an
 * unknown member is refused rather than kept: the descriptor governs how the
 * server treats writes, and a member it does not know is one it cannot apply.
 */
const REVISIONS_MEMBERS: ReadonlySet<string> = new Set([
  'resolution',
  'immutable',
  'merge'
])

/**
 * The two members that are set at creation and immutable afterward, each with
 * the value an absent member stands for.
 */
export const IMMUTABLE_MEMBER_DEFAULTS = {
  resolution: 'last-writer-wins',
  immutable: false
} as const

/**
 * Validates a client-supplied `revisions` descriptor and returns it to
 * persist, or `undefined` when absent. A present value must be an object
 * carrying only `resolution`, `immutable` and `merge`. `resolution` must name
 * a value in {@link SUPPORTED_RESOLUTIONS}, `immutable` must be a boolean, and
 * `merge` must be an object, kept verbatim. A break of any rule is
 * `invalid-request-body` (400) with a pointer to the member.
 *
 * @param options {object}
 * @param [options.revisions] {unknown}   the body's `revisions` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @param [options.pointer] {string}   JSON pointer of the descriptor itself
 *   (default `#/revisions`); omitted from the error when `null`, as for a
 *   history log line, which a JSON pointer cannot address
 * @returns {CollectionRevisions | undefined}
 */
export function assertValidRevisions({
  revisions,
  requestName,
  pointer = '#/revisions'
}: {
  revisions?: unknown
  requestName?: string
  pointer?: string | null
}): CollectionRevisions | undefined {
  if (revisions === undefined) {
    return undefined
  }
  const prefix = pointer === null ? 'state.revisions' : 'revisions'
  const at = (member?: string): string | undefined => {
    if (pointer === null) {
      return undefined
    }
    return member === undefined ? pointer : `${pointer}/${member}`
  }
  if (!isPlainObject(revisions)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Collection "${prefix}" must be an object.`,
      pointer: at()
    })
  }
  for (const member of Object.keys(revisions)) {
    if (!REVISIONS_MEMBERS.has(member)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Collection "${prefix}" carries an unknown member "${member}".`,
        pointer: at(member)
      })
    }
  }
  const { resolution, immutable, merge } = revisions
  if (
    resolution !== undefined &&
    (typeof resolution !== 'string' || !SUPPORTED_RESOLUTIONS.has(resolution))
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        `Collection "${prefix}.resolution" must be one of: ` +
        `${[...SUPPORTED_RESOLUTIONS].join(', ')}.`,
      pointer: at('resolution')
    })
  }
  if (immutable !== undefined && typeof immutable !== 'boolean') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Collection "${prefix}.immutable" must be a boolean.`,
      pointer: at('immutable')
    })
  }
  if (merge !== undefined && !isPlainObject(merge)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Collection "${prefix}.merge" must be an object.`,
      pointer: at('merge')
    })
  }
  return revisions as CollectionRevisions
}

/**
 * Enforces the creation-only rule on `revisions.resolution` and
 * `revisions.immutable` between the stored descriptor and the one a write is
 * about to persist. An absent member stands for its default
 * (`last-writer-wins`, `false`), and each member is compared by the value it
 * stands for. A write that restates a default, or drops an explicit one,
 * changes nothing and passes. A write that moves a member to another value is
 * refused with `revisions-immutable` (409): one that sets `immutable` on an
 * existing Collection, or one that drops a set `immutable` (an omitted
 * descriptor included, as with an omitted `encryption`). `merge` is not
 * compared: it may change freely.
 *
 * `declaring` marks a write that may declare the members: a governing history
 * log's guarded create. It may move a member off its default, but still may
 * not change one the stored descriptor sets to another value. The write that
 * creates a Collection has no stored descriptor and does not call this.
 *
 * @param options {object}
 * @param [options.existing] {CollectionRevisions}   the stored descriptor
 * @param [options.incoming] {CollectionRevisions}   the descriptor to persist
 * @param [options.declaring] {boolean}   the write may move a member off its
 *   default
 * @param [options.pointer] {string}   JSON pointer of the descriptor in the
 *   write (default `#/revisions`)
 * @returns {void}
 */
export function assertRevisionsTransition({
  existing,
  incoming,
  declaring = false,
  pointer = '#/revisions'
}: {
  existing?: CollectionRevisions
  incoming?: CollectionRevisions
  declaring?: boolean
  pointer?: string
}): void {
  for (const [member, fallback] of Object.entries(IMMUTABLE_MEMBER_DEFAULTS)) {
    const key = member as keyof typeof IMMUTABLE_MEMBER_DEFAULTS
    const before = existing?.[key] ?? fallback
    const after = incoming?.[key] ?? fallback
    if (before === after) {
      continue
    }
    if (before === fallback && declaring) {
      continue
    }
    const detail =
      before === fallback
        ? `Collection "revisions.${member}" is declared only when the ` +
          'Collection is created; it cannot be set afterward.'
        : `Collection "revisions.${member}" cannot change once set (from ` +
          `${JSON.stringify(before)} to ${JSON.stringify(after)}).`
    throw new RevisionsImmutableError({
      detail,
      pointer: `${pointer}/${member}`
    })
  }
}

/**
 * Refuses a direct `revisions.merge` write on a log-governed Collection that
 * differs from the one the log declares. The log holds the whole descriptor
 * there, so a body `merge` is never stored, and accepting a different one
 * would report a change that did not happen. A body that omits `merge`, or
 * restates the derived one, passes. Refused with `revisions-immutable` (409):
 * on a governed Collection the descriptor changes only through the log.
 *
 * @param options {object}
 * @param [options.governed] {CollectionRevisions}   the descriptor derived
 *   from the log head
 * @param [options.incoming] {CollectionRevisions}   the body's descriptor
 * @returns {void}
 */
export function assertGovernedMergeUnchanged({
  governed,
  incoming
}: {
  governed?: CollectionRevisions
  incoming?: CollectionRevisions
}): void {
  if (
    incoming?.merge === undefined ||
    isDeepStrictEqual(incoming.merge, governed?.merge)
  ) {
    return
  }
  throw new RevisionsImmutableError({
    detail:
      'Collection "revisions.merge" is declared by the governing history ' +
      'log on this Collection; change it by appending to the log.',
    pointer: '#/revisions/merge'
  })
}

/**
 * Splits a governing history log's head `state` into the two descriptors it
 * governs. The `state` is the `encryption` descriptor, with one reserved slot,
 * `revisions`, carrying the Collection's `revisions` descriptor. The slot is
 * taken out of the encryption state, so the served `encryption` member never
 * carries it.
 *
 * @param state {Record<string, unknown>}   a log line's `state`
 * @returns {{ encryptionState: Record<string, unknown>,
 *   revisions?: CollectionRevisions }}
 */
export function splitGovernedState(state: Record<string, unknown>): {
  encryptionState: Record<string, unknown>
  revisions?: CollectionRevisions
} {
  const { revisions, ...encryptionState } = state
  return {
    encryptionState,
    ...(revisions !== undefined && {
      revisions: revisions as CollectionRevisions
    })
  }
}

/**
 * Whether a Collection is write-once: its `revisions` descriptor (stored, or
 * derived from its governing history log) sets `immutable: true`.
 * @param collectionMetadata {CollectionMetadata}   the Collection Metadata
 *   object as served
 * @returns {boolean}
 */
export function isImmutableCollection(
  collectionMetadata: Pick<CollectionMetadata, 'revisions'>
): boolean {
  return collectionMetadata.revisions?.immutable === true
}

/**
 * Decides the write-once rule for one write, inside its critical section.
 * `true` was read by the request layer and is never taken back. A recheck
 * callback is asked with the governing history log `readLog` reads under the
 * write's lock. An absent option leaves the rule off without reading the log.
 * @param options {object}
 * @param [options.immutable] {true | ImmutableUnder}   the write's option
 * @param options.readLog {Function}   reads the Collection's governing
 *   history log under the write's lock (`undefined` when it has none)
 * @returns {Promise<boolean>}
 */
export async function resolveWriteOnce({
  immutable,
  readLog
}: {
  immutable?: true | ImmutableUnder
  readLog: () => Promise<CollectionLogResult | undefined>
}): Promise<boolean> {
  if (immutable === undefined || immutable === true) {
    return immutable === true
  }
  return immutable({ log: await readLog() })
}
