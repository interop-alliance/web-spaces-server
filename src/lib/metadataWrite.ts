/**
 * Backend-agnostic normalization of a Space or Collection Metadata object
 * about to be persisted. Both storage backends run the same rules through
 * {@link normalizeMetadataWrite}, {@link stampSpaceMetadata},
 * {@link stampSpaceWrite}, {@link stampCollectionMetadata},
 * {@link resolveCollectionMetadataInput} and {@link restampImportedMetadata}
 * so their stored bodies cannot drift; only
 * the storage of the generation and the local validator segment differs
 * downstream (`_generation` / `_local` members in the filesystem metadata
 * file vs Postgres columns). The write stamp (`updatedAt`,
 * `updatedAtCounter`, `originId`) is part of the stored body on both: it is a
 * wire member.
 */
import type {
  CollectionLogResult,
  CollectionMetadata,
  CollectionMetadataInput,
  IDID,
  MetadataValidatorParts,
  SpaceMetadata,
  StoredCollectionMetadata,
  StoredSpaceMetadata,
  WriteStamp
} from '../types.js'
import { CountQuotaExceededError } from '../errors.js'
import {
  type EtagValidator,
  type HeldValidators,
  importedGeneration,
  mintValidator
} from './etag.js'
import {
  metadataEtagOf,
  type EmbeddedMetadataValidator
} from './metadataValidator.js'
import { type HybridLogicalClock, stampOf, withoutStampMembers } from './hlc.js'
import { assertSpaceWritePrecondition } from './preconditions.js'

/**
 * Whether a `custom` member holds anything to store. An absent or empty
 * object is stored as no `custom` at all.
 * @param custom {unknown}
 * @returns {boolean}
 */
export function hasCustomMembers(
  custom: unknown
): custom is Record<string, unknown> {
  return (
    custom !== undefined &&
    custom !== null &&
    typeof custom === 'object' &&
    Object.keys(custom).length > 0
  )
}

/**
 * Strips the validator-bearing and stamp members an incoming Space or
 * Collection Metadata object may carry, leaving the body to persist: the
 * embedded `_generation` / `_local` (the filesystem file layout; an archived
 * object carries `_generation`), `metaGeneration` / `metaLocal` (the
 * out-of-band parts a read result attaches, which a caller may have spread
 * back in), and the stamp members, which only the backend's clock sets. The
 * embedded `_generation` is handed back on its own, for the import path that
 * keeps an archived record's generation.
 *
 * @param options {object}
 * @param options.metadata {T}   the Space or Collection Metadata object
 * @returns {{ body: T, embeddedGeneration?: string }}
 */
export function normalizeMetadataWrite<
  T extends CollectionMetadata | SpaceMetadata
>({ metadata }: { metadata: T }): { body: T; embeddedGeneration?: string } {
  const {
    _generation: embeddedGeneration,
    _local: _embeddedLocal,
    metaGeneration: _staleGeneration,
    metaLocal: _staleLocal,
    ...body
  } = metadata as T & MetadataValidatorParts & EmbeddedMetadataValidator
  return {
    body: withoutStampMembers(body) as T,
    ...(embeddedGeneration !== undefined && { embeddedGeneration })
  }
}

/**
 * Re-stamps a Collection Metadata object an import is about to store: the
 * body without any archived stamp or validator member, carrying this server's
 * freshly minted `stamp` instead, as its write stamp and its creating stamp, and the generation it is stored under (the
 * archived `_generation` when the object carries one this server could have
 * minted, else a fresh one). The
 * archived stamp is read for provenance verification only, before this runs;
 * a stamp an archive could choose would let an importer date a record ahead
 * of every peer.
 *
 * @param options {object}
 * @param options.metadata {CollectionMetadata}   the archived object
 * @param options.stamp {WriteStamp}   minted by the importing backend's clock
 * @returns {{ body: CollectionMetadata, generation: string }}
 */
export function restampImportedMetadata({
  metadata,
  stamp
}: {
  metadata: CollectionMetadata
  stamp: WriteStamp
}): { body: CollectionMetadata; generation: string } {
  const { body, embeddedGeneration } = normalizeMetadataWrite({ metadata })
  return {
    // The creating stamp is the import's too. An archived one would let an
    // archive date a Collection's life ahead of every peer's.
    body: { ...body, ...stamp, created: stamp },
    generation: importedGeneration(embeddedGeneration)
  }
}

/**
 * Resolves the server-managed members of a Space Metadata object about to be
 * written by `writeSpace`, against the prior stored object read under the
 * backend's per-Space lock. The client-supplied object is wire input and may
 * carry its own `createdBy`, or any of the members the server derives per
 * read (`url`, `linkset`, `backends`; `lib/spaceProjection.ts`); all are
 * discarded, since the server alone is authoritative for them, and the
 * derived ones are never stored at all. The write stamp is this write's
 * `stamp`.
 *
 * `createdBy` names the Space's creator, not its last writer: taken from this
 * write's invoker only when this write CREATES the Space, and preserved
 * verbatim afterward -- including preserved-as-absent, so a Space created with
 * no invoker (a token-provisioned create) never has a later writer backfilled
 * into it as its creator.
 *
 * @param options {object}
 * @param options.spaceMetadata {SpaceMetadata}   the supplied object
 * @param [options.prior] {StoredSpaceMetadata}   the stored object, if any
 * @param [options.createdBy] {IDID}   this write's invoker
 * @param options.stamp {WriteStamp}   this write's stamp
 * @returns {SpaceMetadata}
 */
export function stampSpaceMetadata({
  spaceMetadata,
  prior,
  createdBy,
  stamp
}: {
  spaceMetadata: SpaceMetadata
  prior?: StoredSpaceMetadata
  createdBy?: IDID
  stamp: WriteStamp
}): SpaceMetadata {
  const {
    createdBy: _suppliedCreatedBy,
    url: _suppliedUrl,
    linkset: _suppliedLinkset,
    backends: _suppliedBackends,
    replicas: _suppliedReplicas,
    ...rest
  } = spaceMetadata
  const creator = prior ? prior.createdBy : createdBy
  return {
    ...normalizeMetadataWrite({ metadata: rest }).body,
    ...(creator !== undefined && { createdBy: creator }),
    ...stamp
  }
}

/**
 * The backend-agnostic body of `writeSpace`, run inside the backend's
 * critical section against the prior stored object it read there: the
 * precondition, the caller's transition check, the count quota, the validator
 * mint and {@link stampSpaceMetadata}. Persisting the stamped object is left
 * to the backend.
 *
 * The count quota applies on the create path only: a brand-new Space must not
 * push its controller past `maxSpacesPerController`, and overwriting an
 * existing Space's Metadata never trips it. `countOwnedSpaces` is called only
 * then, so a backend counts only when the result can matter.
 *
 * `createdBy`, the stamp members, and the validator-bearing members the wire
 * input may carry are resolved by the shared rules above, so the stored body
 * never holds a client-supplied `createdBy`, stamp or `_generation` on either
 * backend. The object keeps its generation for the Space's whole life; a
 * Space deleted and re-created under the same id mints a new one, so the two
 * lives' validators can never coincide. The stamp is minted over the prior
 * one, and resets the local segment.
 *
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.spaceMetadata {SpaceMetadata}   the supplied object
 * @param [options.prior] {StoredSpaceMetadata}   the stored object, if any
 * @param [options.createdBy] {IDID}   this write's invoker
 * @param [options.ifMatch] {string}
 * @param [options.ifNoneMatch] {HeldValidators}
 * @param [options.assertTransition] {Function}   run against `prior`;
 *   throwing aborts the write
 * @param [options.maxSpacesPerController] {number}   the count quota, if set
 * @param options.countOwnedSpaces {Function}   counts the Spaces stored under
 *   the supplied object's `controller`
 * @param options.clock {HybridLogicalClock}   the store's clock
 * @returns {Promise<{ validator: EtagValidator, stamped: SpaceMetadata }>}
 */
export async function stampSpaceWrite({
  spaceId,
  spaceMetadata,
  prior,
  createdBy,
  ifMatch,
  ifNoneMatch,
  assertTransition,
  maxSpacesPerController,
  countOwnedSpaces,
  clock
}: {
  spaceId: string
  spaceMetadata: SpaceMetadata
  prior?: StoredSpaceMetadata
  createdBy?: IDID
  ifMatch?: string
  ifNoneMatch?: HeldValidators
  assertTransition?: (prior?: StoredSpaceMetadata) => void | Promise<void>
  maxSpacesPerController?: number
  countOwnedSpaces: () => Promise<number>
  clock: HybridLogicalClock
}): Promise<{ validator: EtagValidator; stamped: SpaceMetadata }> {
  assertSpaceWritePrecondition({
    spaceId,
    exists: prior !== undefined,
    currentEtag: metadataEtagOf(prior),
    ifMatch,
    ifNoneMatch
  })

  await assertTransition?.(prior)

  if (maxSpacesPerController !== undefined && prior === undefined) {
    if ((await countOwnedSpaces()) >= maxSpacesPerController) {
      throw new CountQuotaExceededError({
        scope: 'Spaces per controller',
        limit: maxSpacesPerController
      })
    }
  }

  const validator = await mintValidator({
    clock,
    prior: prior && { generation: prior.metaGeneration, ...stampOf(prior) },
    local: 0
  })
  const stamped = stampSpaceMetadata({
    spaceMetadata,
    prior,
    createdBy,
    stamp: validator.stamp
  })
  return { validator, stamped }
}

/**
 * Resolves the server-managed members of a Collection Metadata object about
 * to be written by `writeCollection`, against the prior stored object read
 * under the backend's per-Collection lock. The server-managed members are the
 * backend's, never the body's: the client-supplied object is wire input and
 * may carry its own `createdBy` / `createdAt` or stamp members, and all are
 * discarded here, since the server alone is authoritative for them.
 *
 * `createdBy` names the Collection's creator, not its last writer: taken from
 * this write's invoker only when this write CREATES the Collection, and
 * preserved verbatim afterward -- including preserved-as-absent, so a
 * Collection created with no invoker never has a later writer backfilled into
 * it as its creator. `createdAt` is resolved on the same terms: stamped with
 * this write's clock only when this write creates the Collection, and
 * afterward preserved verbatim from the prior object -- including
 * preserved-as-absent, so a Collection stored without one (an object imported
 * from a pre-v0.5 archive, say) is never given a creation time later than its
 * own contents. The write stamp is this write's `stamp`, and a creating
 * write's `createdAt` is the stamp's `updatedAt`. `created`, the creating
 * stamp, is resolved the same way: this write's whole stamp when it creates
 * the Collection, and the prior object's afterward.
 *
 * `custom` is kept verbatim only when it is a non-empty object (`{ name, tags }`
 * on a plaintext Collection, the opaque envelope on an encrypted one); an
 * absent, empty, null, or non-object one clears it. `epoch` is kept only when
 * supplied: the stamp describes the `custom` envelope this write replaces
 * wholesale, so an omitted one clears rather than mislabels the new envelope.
 *
 * @param options {object}
 * @param options.collectionMetadata {CollectionMetadata}   the supplied object
 * @param [options.prior] {StoredCollectionMetadata}   the stored object, if any
 * @param [options.createdBy] {IDID}   this write's invoker
 * @param options.stamp {WriteStamp}   this write's stamp
 * @returns {CollectionMetadata}
 */
export function stampCollectionMetadata({
  collectionMetadata,
  prior,
  createdBy,
  stamp
}: {
  collectionMetadata: CollectionMetadata
  prior?: StoredCollectionMetadata
  createdBy?: IDID
  stamp: WriteStamp
}): CollectionMetadata {
  const {
    createdBy: _suppliedCreatedBy,
    createdAt: _suppliedCreatedAt,
    created: _suppliedCreated,
    custom,
    epoch,
    ...rest
  } = normalizeMetadataWrite({ metadata: collectionMetadata }).body
  const creator = prior ? prior.createdBy : createdBy
  const createdAt = prior ? prior.createdAt : stamp.updatedAt
  const created = prior ? prior.created : stamp
  const hasCustom = hasCustomMembers(custom)
  return {
    ...rest,
    ...(creator !== undefined && { createdBy: creator }),
    ...(createdAt !== undefined && { createdAt }),
    ...(created !== undefined && { created }),
    ...stamp,
    ...(hasCustom && { custom }),
    ...(epoch !== undefined && { epoch })
  }
}

/**
 * The object a Collection Metadata write persists: the one the caller handed
 * over, or the result of its composition callback, run under the write's lock
 * against the prior object and, when the Collection exists, its governing
 * history log. The log is read only when the callback will see it; a create
 * has none, since the log goes with its Collection.
 * @param options {object}
 * @param options.input {CollectionMetadataInput}
 * @param [options.prior] {StoredCollectionMetadata}   the object read under
 *   the lock, absent on a create
 * @param options.readLog {Function}   reads the Collection's governing history
 *   log under the write's lock (`undefined` when it has none)
 * @returns {Promise<CollectionMetadata>}
 */
export async function resolveCollectionMetadataInput({
  input,
  prior,
  readLog
}: {
  input: CollectionMetadataInput
  prior?: StoredCollectionMetadata
  readLog: () => Promise<CollectionLogResult | undefined>
}): Promise<CollectionMetadata> {
  if (typeof input !== 'function') {
    return input
  }
  const log = prior ? await readLog() : undefined
  return input({ prior, log })
}
