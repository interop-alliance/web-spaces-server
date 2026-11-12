/**
 * Custom error classes (each carries type / title / detail / statusCode) plus
 * handleError, the Fastify error handler installed by each route group.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import {
  ProblemTypes,
  type ProblemType,
  type Problem
} from '@interop/storage-core'

// Re-export the wire `Problem` entry shape (one element of the `errors` array)
// so the rest of the server keeps importing it from this one module.
export type { Problem }

/**
 * Base class for the server's error hierarchy. Carries the four
 * `application/problem+json` fields (`type` / `title` / `detail` /
 * `statusCode`) plus an optional `problems` array of `{ detail, pointer }`
 * entries; `handleError` serializes these to the wire. Subclasses set their
 * distinguishing values via `super({ ... })`.
 * @param options {object}
 * @param options.type {ProblemType | 'about:blank'}   problem-kind URI (see
 *   @interop/storage-core), or RFC 9457's `about:blank` for a problem whose
 *   whole meaning is its HTTP status code
 * @param options.title {string}   short human-readable summary
 * @param options.detail {string}   specific explanation of the occurrence
 * @param options.statusCode {number}   HTTP status code
 * @param [options.problems] {Problem[]}   per-field error entries
 * @param [options.cause] {Error}   the underlying error, when wrapping one
 */
export class ProblemError extends Error {
  type: ProblemType | 'about:blank'
  title: string
  detail: string
  statusCode: number
  problems?: Problem[]
  constructor({
    type,
    title,
    detail,
    statusCode,
    problems,
    cause
  }: {
    type: ProblemType | 'about:blank'
    title: string
    detail: string
    statusCode: number
    problems?: Problem[]
    cause?: Error
  }) {
    super(detail, cause ? { cause } : undefined)
    this.type = type
    this.title = title
    this.detail = detail
    this.statusCode = statusCode
    if (problems) {
      this.problems = problems
    }
  }
}

/**
 * Whether an error is a server-side fault: a 5xx `ProblemError`, such as a
 * storage error. A caller that turns other failures into a denial or a
 * refusal rethrows one of these, so it keeps its 5xx.
 * @param err {unknown}
 * @returns {boolean}
 */
export function isServerFault(err: unknown): err is ProblemError {
  return err instanceof ProblemError && err.statusCode >= 500
}

/**
 * The one `detail` every masked 404 carries -- the absent-target family below
 * and the authorization-denial family further down alike. It names no entity,
 * so the body of "there is nothing here" and the body of "you may not see what
 * is here" are the same bytes.
 */
const MASKED_NOT_FOUND_DETAIL = 'URL not found or invalid authorization.'

/**
 * The `title` shared by both masked-404 families. An absent target and a
 * failed authorization reach it with the same `requestName` (one handler names
 * the request for both paths), and a throw site that names no request gets the
 * same request-less title on either path, so the two bodies stay identical
 * whether or not a name was threaded through.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {string}
 */
function maskedTitle({ requestName }: { requestName?: string }): string {
  return requestName ? `Invalid ${requestName} request` : 'Invalid request'
}

/**
 * 404 -- shared base for the `*NotFoundError` family: an entity does not exist,
 * or the caller is not authorized (the PWS existence-masking convention). The
 * exported subclasses are thin `instanceof` markers; they carry no entity noun
 * on the wire, because naming one ("Space not found...") would tell an
 * unauthorized caller which layer of the URL exists. The body is byte-identical
 * to `UnauthorizedError`'s: same `type`, same `title`, same `detail`, which is
 * what the spec's indistinguishability requirement asks for.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
class NotFoundError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.NOT_FOUND,
      title: maskedTitle({ requestName }),
      detail: MASKED_NOT_FOUND_DETAIL,
      statusCode: 404
    })
  }
}

/**
 * 400 -- shared base for the `Invalid*IdError` family: a provided id is not
 * URL-safe / otherwise invalid. The exported subclasses differ only in the
 * entity noun, which fills the default title and (lower-cased) the detail.
 * @param options {object}
 * @param options.entity {string}   the entity noun (e.g. `Space`)
 * @param [options.requestName] {string}   request name used in the error title
 */
class InvalidIdError extends ProblemError {
  constructor({
    entity,
    requestName
  }: {
    entity: string
    requestName?: string
  }) {
    super({
      type: ProblemTypes.INVALID_ID,
      title: `Invalid ${requestName || entity} request`,
      detail: `Invalid ${entity.toLowerCase()} id (make sure it is URL-safe).`,
      statusCode: 400
    })
  }
}

/**
 * 404 -- the requested Space does not exist, or the caller is not authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class SpaceNotFoundError extends NotFoundError {}

/**
 * 400 -- the provided space id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidSpaceIdError extends InvalidIdError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({ entity: 'Space', requestName })
  }
}

/**
 * 400 — the provided collection id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidCollectionIdError extends InvalidIdError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({ entity: 'Collection', requestName })
  }
}

/**
 * 400 — the provided resource id is not URL-safe / otherwise invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidResourceIdError extends InvalidIdError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({ entity: 'Resource', requestName })
  }
}

/**
 * 400 — the `:chunkIndex` path param of a chunk operation (the
 * `chunked-streams` feature) is not a canonical non-negative integer. The
 * canonical-form requirement (no leading zeros, no sign) keeps every chunk
 * addressable at exactly one URL.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidChunkIndexError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_ID,
      title: `Invalid ${requestName || 'Chunk'} request`,
      detail: 'Invalid chunk index (must be a canonical non-negative integer).',
      statusCode: 400
    })
  }
}

/**
 * 409 — a `POST` create operation supplied an `id` that already exists.
 * Create-or-replace at a client-chosen id is the idempotent `PUT` path, which
 * does not conflict.
 * @param options {object}
 * @param options.kind {string}   what was being created ('Space', 'Collection',
 *   'Resource'), used in the error title and detail
 */
export class IdConflictError extends ProblemError {
  constructor({ kind }: { kind: string }) {
    const detail = `Use PUT to create-or-replace a ${kind} at a chosen id.`
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: `A ${kind} with this id already exists.`,
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * 409 — a write claims a `unique: true` indexed attribute already claimed by
 * another live Resource in the same Collection. Two invariants share it: the
 * EDV blinded one (an `indexed` blinded attribute's (HMAC key id, name, value)
 * triple; the `blinded-index-query` feature, `variant: 'blinded'`, the
 * default) and the plaintext equality one (a `unique`-declared `plaintext.indexes`
 * attribute's (name, value) pair; the `equality-query` feature,
 * `variant: 'equality'`). Reuses the `id-conflict` problem type (like the
 * WebKMS conflicts): a unique attribute is a client-chosen identifier-like
 * claim, and the registry defines no more specific kind. Only ever observable
 * by a caller already authorized to write the target.
 */
export class UniqueAttributeConflictError extends ProblemError {
  constructor({
    variant = 'blinded'
  }: { variant?: 'blinded' | 'equality' } = {}) {
    const attribute =
      variant === 'equality'
        ? 'unique indexed attribute'
        : 'unique blinded index attribute'
    const detail =
      `Could not write document; a ${attribute} is already` +
      ' in use by another Resource in this Collection.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: `A ${attribute} is already in use.`,
      detail,
      statusCode: 409,
      problems: [
        {
          detail,
          pointer: variant === 'equality' ? '#/plaintext/indexes' : '#/indexed'
        }
      ]
    })
  }
}

/**
 * 409 — a client-supplied id collides with a segment from the spec's Reserved
 * Path Segment Registry: the id would shadow the reserved route at that
 * position (e.g. a Collection named `export` would shadow
 * `/space/{id}/export`).
 * @param options {object}
 * @param options.kind {string}   which id position collided ('collection',
 *   'resource'), used in the error title and detail
 * @param options.id {string}   the offending reserved id
 */
export class ReservedIdError extends ProblemError {
  constructor({
    kind,
    id,
    detail = `'${id}' is a reserved path segment and cannot be used as a ${kind} id.`
  }: {
    kind: string
    id: string
    detail?: string
  }) {
    super({
      type: ProblemTypes.RESERVED_ID,
      title: `Invalid ${kind} id (from reserved list).`,
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * 409 — a backend reference cannot be honored. Three occurrences, distinguished
 * by `detail` / `pointer`: a Collection create/update names a `backend` id not in
 * the Space's backends-available list (the default `#/backend` detail); a
 * registration names a `provider` the server does not permit (the allowlist gate,
 * `#/provider`); or a selected backend is registered but has no live adapter yet
 * (the resolver's data-plane backstop). Spec `unsupported-backend`.
 * @param options {object}
 * @param options.backendId {string}   the unrecognized backend (or provider) id
 * @param [options.detail] {string}   a specific explanation; defaults to the
 *   backends-available message
 * @param [options.pointer] {string}   RFC 6901 JSON Pointer to the offending
 *   field; defaults to `#/backend`
 */
export class UnsupportedBackendError extends ProblemError {
  constructor({
    backendId,
    detail,
    pointer = '#/backend'
  }: {
    backendId: string
    detail?: string
    pointer?: string
  }) {
    const resolvedDetail =
      detail ??
      `Backend '${backendId}' is not in this Space's backends-available list.`
    super({
      type: ProblemTypes.UNSUPPORTED_BACKEND,
      title:
        "Unsupported backend id, check the space's 'backends available' list.",
      detail: resolvedDetail,
      statusCode: 409,
      problems: [{ detail: resolvedDetail, pointer }]
    })
  }
}

/**
 * 409 — a replica registration refused over the state of the peer or of this
 * server, as opposed to a malformed body: no sync identity, a peer that does
 * not serve replication, a peer carrying this server's origin id, a differing
 * `controller` or `type`, a differing immutable Collection member, another
 * local Space that already replicates the same peer Collection, or the
 * `server` Space. Also the removal of a registration refused because a
 * Space's `did:webvh` controller resolves only through it, which passes its
 * own `title` and no `pointer`. Also an Update Space whose controller change
 * would leave a peer-hosted `did:webvh` with two local copies of its log or
 * none, which passes its own `title` and the `#/controller` pointer. Only a
 * caller already authorized as the Space controller sees it.
 * @param options {object}
 * @param options.detail {string}   the cause, for a person to read
 * @param [options.title] {string}   defaults to the registration refusal's
 * @param [options.pointer] {string | null}   RFC 6901 JSON Pointer to the
 *   member of the registration the refusal is about; defaults to
 *   `#/fromSpace`. `null` for a refusal that is about no request body
 */
export class ReplicaRefusedError extends ProblemError {
  constructor({
    detail,
    title = 'The replica registration was refused.',
    pointer = '#/fromSpace'
  }: {
    detail: string
    title?: string
    pointer?: string | null
  }) {
    super({
      type: ProblemTypes.REPLICA_REFUSED,
      title,
      detail,
      statusCode: 409,
      ...(pointer !== null && { problems: [{ detail, pointer }] })
    })
  }
}

/**
 * 409 -- a Collection update tried to add a client-side `encryption`
 * descriptor to an existing Collection that lacks one, to change or clear an
 * existing descriptor, or to move its scheme `version` backwards. The
 * descriptor is creation-only and version-monotonic (spec "Creation-only
 * members"). It is declared by the write that creates the Collection, since
 * under replication a late declaration cannot be merged. Changing its scheme,
 * decreasing or removing its `version`, or clearing it on a populated
 * Collection would corrupt the stored, client-encrypted Resources. Like the
 * other state-conflict 409s (`id-conflict`, `unsupported-backend`), it is only
 * observable by a caller already authorized to update the Collection -- it is
 * checked after capability verification.
 * @param options {object}
 * @param [options.detail] {string}   which rail was violated
 * @param [options.pointer] {string}   JSON pointer to the offending member
 */
export class EncryptionImmutableError extends ProblemError {
  constructor({ detail, pointer }: { detail?: string; pointer?: string } = {}) {
    const resolvedDetail =
      detail ??
      "A Collection's 'encryption' descriptor is declared at creation and cannot be added, changed, or cleared."
    super({
      type: ProblemTypes.ENCRYPTION_IMMUTABLE,
      title: 'Collection encryption descriptor is immutable.',
      detail: resolvedDetail,
      statusCode: 409,
      problems: [{ detail: resolvedDetail, pointer: pointer ?? '#/encryption' }]
    })
  }
}

/**
 * 409 -- a Collection Metadata write, or an append to the Collection's
 * governing history log, tried to change the `resolution` or `immutable`
 * member of the `revisions` descriptor. Both are immutable once set and are
 * declared only by the write that creates the Collection, so a write that
 * adds one to an existing Collection, drops one, or changes one is refused.
 * The counterpart of `encryption-immutable`. Only observable by a caller
 * already authorized to update the Collection.
 * @param options {object}
 * @param [options.detail] {string}   which member was changed
 * @param [options.pointer] {string}   JSON pointer to the offending member
 */
export class RevisionsImmutableError extends ProblemError {
  constructor({ detail, pointer }: { detail?: string; pointer?: string } = {}) {
    const resolvedDetail =
      detail ??
      "A Collection's 'revisions.resolution' and 'revisions.immutable' are set at creation and cannot be added, changed, or cleared."
    super({
      type: ProblemTypes.REVISIONS_IMMUTABLE,
      title: 'Collection revisions descriptor is immutable.',
      detail: resolvedDetail,
      statusCode: 409,
      problems: [{ detail: resolvedDetail, pointer: pointer ?? '#/revisions' }]
    })
  }
}

/**
 * 409 -- an Update Collection body named a `backend` that resolves to a
 * backend other than the one the stored Collection selects. The selection is
 * made when the Collection is created and cannot move afterward: the
 * Collection's Resources live on the selected backend, and a move would leave
 * them there while reads went elsewhere. Only observable by a caller already
 * authorized to update the Collection.
 * @param options {object}
 * @param options.backendId {string}   the backend id the body named
 */
export class BackendImmutableError extends ProblemError {
  constructor({ backendId }: { backendId: string }) {
    const detail =
      `A Collection's 'backend' is set at creation and cannot be changed; ` +
      `'${backendId}' selects a different backend than the stored one.`
    super({
      type: ProblemTypes.BACKEND_IMMUTABLE,
      title: 'Collection backend selection is immutable.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/backend' }]
    })
  }
}

/**
 * 409 -- a Resource or chunk write into a Collection whose `revisions`
 * descriptor sets `immutable` would change stored bytes: an update of a live
 * Resource or chunk, or a repeat create whose body differs from the stored
 * one. A repeat create with an equal body is not refused; it answers the
 * current `ETag`. Only observable by a caller already authorized to write the
 * target.
 * @param options {object}
 * @param [options.requestName] {string}   request name for the error title
 */
export class ResourceImmutableError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.RESOURCE_IMMUTABLE,
      title: `${requestName || 'Write'} refused: the Collection is immutable.`,
      detail:
        'This Collection is write-once: a stored Resource or chunk cannot be ' +
        'changed. Only a repeat of the stored bytes is accepted.',
      statusCode: 409
    })
  }
}

/**
 * 409 -- an Update Collection wrote the `encryption` member directly on a
 * Collection whose descriptor is governed by its history log (the
 * `.../meta/log` sub-resource, the `governed-history-logs` feature). The served
 * member is derived from the log head, so the Metadata object path is read-only
 * for it: a change is an append to the log. Like `encryption-immutable`, only
 * observable by a caller already authorized to update the Collection.
 */
export class EncryptionHistoryLogGovernedError extends ProblemError {
  constructor() {
    const detail =
      "This Collection's 'encryption' descriptor is governed by its history " +
      'log (meta/log); append to the log instead of writing the member.'
    super({
      type: ProblemTypes.ENCRYPTION_HISTORY_LOG_GOVERNED,
      title: 'Collection encryption descriptor is governed by its history log.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/encryption' }]
    })
  }
}

/**
 * 400 — a Collection create/update supplied an `encryption` descriptor naming a
 * `scheme` -- or a `version` of a recognized scheme -- this server does not
 * recognize and therefore cannot enforce on write. Taking the spec's
 * fail-closed SHOULD path ("Encryption Scheme Registry"), the reference server
 * rejects such a descriptor rather than storing it opaquely, so every accepted
 * descriptor is one whose non-conforming (e.g. plaintext) writes it will
 * reject. A pure body-shape rejection, checked before capability verification
 * like the other `invalid`-shaped 400s.
 * @param options {object}
 * @param options.scheme {string}   the scheme token
 * @param [options.version] {number}   the unrecognized version of a recognized
 *   scheme (absent when the scheme itself is unrecognized)
 */
export class UnsupportedEncryptionSchemeError extends ProblemError {
  constructor({ scheme, version }: { scheme: string; version?: number }) {
    const detail =
      version === undefined
        ? `This server does not support the '${scheme}' encryption scheme.`
        : `This server does not support version ${version} of the '${scheme}' encryption scheme.`
    super({
      type: ProblemTypes.UNSUPPORTED_ENCRYPTION_SCHEME,
      title: 'Unsupported encryption scheme.',
      detail,
      statusCode: 400,
      problems: [
        {
          detail,
          pointer:
            version === undefined
              ? '#/encryption/scheme'
              : '#/encryption/version'
        }
      ]
    })
  }
}

/**
 * 422 — a content write into a Collection whose `encryption` descriptor declares a
 * recognized scheme did not conform to that scheme's envelope profile: the
 * request `Content-Type` was not the scheme's registered media type, or the body
 * was not a structurally valid envelope (spec "Encryption Scheme Registry"). The
 * server validates structure only and never decrypts. Like the write-time 409s
 * (`id-conflict`, `encryption-immutable`), it is only ever observable by a caller
 * already authorized to write the target -- it is checked after capability
 * verification, so an under-authorized caller receives the privacy-merged
 * `not-found` (404) instead.
 * @param options {object}
 * @param [options.detail] {string}   which gate failed (media type vs envelope shape)
 */
export class EncryptionSchemeMismatchError extends ProblemError {
  constructor({ detail }: { detail?: string } = {}) {
    const message =
      detail ??
      "Resource body does not conform to the Collection's declared encryption scheme."
    super({
      type: ProblemTypes.ENCRYPTION_SCHEME_MISMATCH,
      title: 'Encrypted Collection write does not conform to its scheme.',
      detail: message,
      statusCode: 422,
      problems: [{ detail: message }]
    })
  }
}

/**
 * 412 — a conditional write's `If-Match` / `If-None-Match` precondition
 * evaluated false: the Resource's current `ETag` did not match, or a
 * create-if-absent (`If-None-Match: *`) target already exists. Header-driven
 * and deliberately distinct from the 409 conflict kinds (`id-conflict`,
 * `reserved-id`, `unsupported-backend`). A `412` is only ever observable by a
 * caller already authorized to write the target -- the request layer checks
 * authorization before the backend evaluates the precondition.
 * @param options {object}
 * @param [options.detail] {string}   a specific explanation of the mismatch
 * @param [options.requestName] {string}   request name used in the error title
 */
export class PreconditionFailedError extends ProblemError {
  constructor({
    detail,
    requestName
  }: { detail?: string; requestName?: string } = {}) {
    const message = detail ?? 'A conditional request precondition was not met.'
    super({
      type: ProblemTypes.PRECONDITION_FAILED,
      title: requestName
        ? `Precondition Failed (${requestName})`
        : 'Precondition Failed',
      detail: message,
      statusCode: 412,
      problems: [{ detail: message }]
    })
  }
}

/**
 * 503 -- a write could not settle against a stable view of its target, because
 * concurrent writers kept replacing it between the read that chose how to
 * authorize the write and the write itself. The spec assigns this refusal no
 * error `type`, so the problem `type` is RFC 9457's `about:blank` and the
 * `title` is the status phrase. `handleError` emits the RFC 9110 `Retry-After`
 * header from `retryAfter`, in seconds.
 * @param options {object}
 * @param options.detail {string}   what could not be written
 * @param options.retryAfter {number}   seconds until a retry may succeed
 */
export class ServiceUnavailableError extends ProblemError {
  retryAfter: number
  constructor({ detail, retryAfter }: { detail: string; retryAfter: number }) {
    super({
      type: 'about:blank',
      title: 'Service Unavailable',
      detail,
      statusCode: 503
    })
    this.retryAfter = retryAfter
  }
}

/**
 * Internal signal, never sent: the Space Metadata object a write re-read under
 * its lock is not the one the write was composed from (a Space created,
 * deleted, or rewritten in between). The Update Space handler catches it,
 * re-reads, and re-runs authorization. One that escapes answers 500.
 */
export class StaleSpaceMetadataError extends Error {
  constructor() {
    super('The Space Metadata object changed before the write.')
    this.name = 'StaleSpaceMetadataError'
  }
}

/**
 * Startup refusal: a backend's store is at a storage layout version this
 * server cannot run on. For the filesystem backend, either its `store.json`
 * names a version newer than the code knows, or it has no `store.json` over a
 * data directory that already holds data. For the Postgres backend, its
 * `schema_migrations` table records a version newer than the code knows.
 * Never sent over the wire.
 * @param options {object}
 * @param options.detail {string}   names the stored and the known version
 */
export class StoreVersionError extends Error {
  constructor({ detail }: { detail: string }) {
    super(detail)
    this.name = 'StoreVersionError'
  }
}

/**
 * Startup refusal: a Postgres schema name, given as the backend's `schema`
 * option or to a caller that acts on the schema before the backend opens, is
 * not a plain identifier (an ASCII letter or `_`, then ASCII letters, digits
 * or `_`). Never sent over the wire.
 * @param options {object}
 * @param options.schema {string}   the offending name
 */
export class InvalidSchemaNameError extends Error {
  constructor({ schema }: { schema: string }) {
    super(`Invalid Postgres schema name: "${schema}".`)
    this.name = 'InvalidSchemaNameError'
  }
}

/**
 * Startup refusal about the store's origin id: `WAS_ORIGIN_ID` names an id
 * other than the one the store already carries (`mismatch`), or the stored id
 * is malformed. The stored id is permanent for the store's life, so neither
 * side is taken over the other. Never sent over the wire.
 * @param options {object}
 * @param options.detail {string}   names the stored id and what is wrong
 */
export class StoreOriginIdError extends Error {
  constructor({ detail }: { detail: string }) {
    super(detail)
    this.name = 'StoreOriginIdError'
  }

  /**
   * The refusal for an id, configured or stored, that is not well-formed.
   * @param options {object}
   * @param options.id {string}   the offending id
   * @param options.where {string}   where it came from
   * @returns {StoreOriginIdError}
   */
  static malformed({
    id,
    where
  }: {
    id: string
    where: string
  }): StoreOriginIdError {
    return new StoreOriginIdError({
      detail:
        `${where} names the origin id "${id}", which is not a well-formed ` +
        `origin id (1 to 64 ASCII letters, digits, '_' or '-').`
    })
  }

  /**
   * The refusal for a configured id that differs from the stored one.
   * @param options {object}
   * @param options.stored {string}   the id the store carries
   * @param options.configured {string}   the id the environment names
   * @returns {StoreOriginIdError}
   */
  static mismatch({
    stored,
    configured
  }: {
    stored: string
    configured: string
  }): StoreOriginIdError {
    return new StoreOriginIdError({
      detail:
        `WAS_ORIGIN_ID is "${configured}", but this store already carries ` +
        `the origin id "${stored}". The stored id is permanent; unset ` +
        `WAS_ORIGIN_ID or set it to the stored id. A restored clone that ` +
        `will run beside its source needs a fresh, empty store under the ` +
        `new id.`
    })
  }
}

/**
 * Startup refusal: the filesystem backend could not take the migration lock
 * on its data directory before the timeout, because another live process
 * holds it (or a process on another host left it behind). Never sent over the
 * wire.
 * @param options {object}
 * @param options.lockPath {string}   the lock file that stayed held
 */
export class StoreLockTimeoutError extends Error {
  constructor({ lockPath }: { lockPath: string }) {
    super(
      `Timed out waiting for the store migration lock at ${lockPath}. ` +
        'Remove it if no other server process uses this data directory.'
    )
    this.name = 'StoreLockTimeoutError'
  }
}

/**
 * Internal signal, never sent: the fetch of a peer server's history log was
 * refused or failed. The URL was not `https` on the default port, the host
 * resolved to a non-public address, the host answered a redirect or a status
 * other than 200, the body crossed the size limit, or the fetch timed out.
 * The peer resolver records it as the cause of its own refusal.
 * @param options {object}
 * @param options.url {string}   the log URL
 * @param options.detail {string}   what went wrong
 * @param [options.cause] {unknown}   the underlying failure
 */
export class PeerLogFetchError extends Error {
  constructor({
    url,
    detail,
    cause
  }: {
    url: string
    detail: string
    cause?: unknown
  }) {
    super(`Could not fetch the peer log at "${url}": ${detail}`, { cause })
    this.name = 'PeerLogFetchError'
  }
}

/**
 * Internal signal, never sent: a request a pull loop made to a peer failed.
 * The URL was refused before any connection, the host did not resolve or
 * resolved to a non-public address, the request timed out, or the peer
 * answered a status the loop cannot use. The loop ends its cycle on it and
 * backs off.
 * @param options {object}
 * @param options.url {string}   the requested URL
 * @param options.detail {string}   what went wrong
 * @param [options.status] {number}   the status the peer answered, if any
 * @param [options.bodyTooLarge] {boolean}   the body was larger than the
 *   reader's bound, so a smaller request may still succeed
 * @param [options.cause] {unknown}   the underlying failure
 */
export class PeerRequestError extends Error {
  status?: number
  bodyTooLarge: boolean

  constructor({
    url,
    detail,
    status,
    bodyTooLarge = false,
    cause
  }: {
    url: string
    detail: string
    status?: number
    bodyTooLarge?: boolean
    cause?: unknown
  }) {
    super(`The request to the peer at "${url}" failed: ${detail}`, { cause })
    this.name = 'PeerRequestError'
    this.status = status
    this.bodyTooLarge = bodyTooLarge
  }
}

/**
 * Internal signal, never sent: a peer server's `did:webvh` could not be
 * resolved over the network. The fetch was refused or failed, the log did not
 * verify, or the document does not list the requested key. The capability
 * verifier wraps it as a key it cannot resolve, which answers the masked
 * `not-found`.
 * @param options {object}
 * @param options.did {string}   the peer DID
 * @param options.detail {string}   what went wrong
 * @param [options.cause] {unknown}   the underlying failure
 */
export class PeerWebvhResolutionError extends Error {
  constructor({
    did,
    detail,
    cause
  }: {
    did: string
    detail: string
    cause?: unknown
  }) {
    super(`Could not resolve the peer DID "${did}": ${detail}`, { cause })
    this.name = 'PeerWebvhResolutionError'
  }
}

/**
 * 400 — a pagination `cursor` query parameter is malformed or can no longer be
 * honored (not valid base64url, not JSON, or missing its keyset position; spec
 * `invalid-cursor`). Like `precondition-failed`, it is only ever observable by a
 * caller already authorized to list the target -- the request layer checks
 * authorization before the backend validates the cursor, so an under-authorized
 * caller receives the privacy-merged `not-found` (404) instead.
 * @param options {object}
 * @param [options.detail] {string}   a specific explanation of the failure
 * @param [options.cause] {Error}   the underlying parse error, when wrapping one
 */
export class InvalidCursorError extends ProblemError {
  constructor({ detail, cause }: { detail?: string; cause?: Error } = {}) {
    const message =
      detail ??
      'The pagination cursor is malformed or can no longer be honored.'
    super({
      type: ProblemTypes.INVALID_CURSOR,
      title: 'Invalid pagination cursor',
      detail: message,
      statusCode: 400,
      problems: [{ detail: message }],
      cause
    })
  }
}

/**
 * 400 -- the Collection Metadata request body is missing or invalid.
 */
export class InvalidCollectionError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: 'Invalid Collection Metadata body',
      detail: 'Collection Metadata body is missing or invalid.',
      statusCode: 400
    })
  }
}

/**
 * 405 -- the method is not defined at this URL. The route layer raises it for
 * every method a URL does not implement (`refuseUnimplementedMethods` in
 * `routes.ts`), and Delete Resource raises it for a `did:webvh` history log.
 * The spec assigns this refusal no error `type`, so the problem `type` is RFC
 * 9457's `about:blank`: the HTTP status is the whole meaning. For that reason
 * the `title` is the status phrase itself, `Method Not Allowed`, as RFC 9457
 * section 4.2.1 says it SHOULD be when `type` is `about:blank`; the optional
 * `hint` and the `Allow` list are the per-occurrence specifics and go in
 * `detail`. `handleError` emits the RFC 9110 `Allow` header from `allow`, the
 * methods the URL does accept.
 * @param options {object}
 * @param options.allow {string[]}   the methods defined at the URL
 * @param [options.hint] {string}   one sentence naming where the refused
 *   operation lives instead, sited between the refusal and the `Allow` list
 */
export class MethodNotAllowedError extends ProblemError {
  allow: string[]
  constructor({ allow, hint }: { allow: string[]; hint?: string }) {
    super({
      type: 'about:blank',
      title: 'Method Not Allowed',
      detail: [
        'The method is not defined at this URL.',
        ...(hint ? [hint] : []),
        // An empty `Allow` is legal (RFC 9110: the URL allows no methods), and
        // a reserved endpoint the server anchors but serves nothing at has one.
        allow.length > 0
          ? `Allowed methods: ${allow.join(', ')}.`
          : 'No methods are allowed at this URL.'
      ].join(' '),
      statusCode: 405
    })
    this.allow = allow
  }
}

/**
 * 404 — the requested Collection does not exist, or the caller is not
 * authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class CollectionNotFoundError extends NotFoundError {}

/**
 * 404 — the requested Resource does not exist, or the caller is not authorized.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class ResourceNotFoundError extends NotFoundError {}

/**
 * 404 — no replica registration is stored on the Space under the id. Only
 * the Space controller reaches it, and it carries the masked body.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class ReplicaNotFoundError extends NotFoundError {}

/**
 * 404 — no access-control policy document is set at the requested level
 * (reported as not-found, consistent with the privacy-merged kind).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class PolicyNotFoundError extends NotFoundError {}

/**
 * 400 — the access-control policy document is missing or malformed (it must be
 * a JSON object carrying a non-empty string `type`).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class InvalidPolicyError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'Policy'} body`,
      detail:
        'Policy document must be a JSON object with a non-empty string "type".',
      statusCode: 400
    })
  }
}

/**
 * 404 -- shared base for the authorization-denial family. Every denial keeps
 * the same masked status and the same `title` as the `*NotFoundError` family,
 * so an under-authorized caller cannot tell an absent target from one it may
 * not see; the subclasses differ only in the problem `type` and the detail.
 * `UnauthorizedError`, the masked default, shares the detail too, so its body
 * is byte-identical to an absent target's -- the two named causes below are
 * raised only for the holder of the capability being refused.
 * @param options {object}
 * @param options.type {ProblemType}   the problem type naming the cause
 * @param options.detail {string}   the problem detail
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.cause] {Error}   the verifier's or inspector's error
 */
class DenialError extends ProblemError {
  constructor({
    type,
    detail,
    requestName,
    cause
  }: {
    type: ProblemType
    detail: string
    requestName?: string
    cause?: Error
  }) {
    super({
      type,
      title: maskedTitle({ requestName }),
      detail,
      statusCode: 404,
      cause
    })
  }
}

/**
 * 404 -- capability invocation did not verify (reported as not-found so as not
 * to leak resource existence). Its body is byte for byte the one an absent
 * target answers with (`NotFoundError` above): same `type`, `title` and
 * `detail`.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class UnauthorizedError extends DenialError {
  constructor({ requestName }: { requestName?: string }) {
    super({
      type: ProblemTypes.NOT_FOUND,
      detail: MASKED_NOT_FOUND_DETAIL,
      requestName
    })
  }
}

/**
 * 404 -- a capability in the invoked delegation chain has a stored
 * revocation. Only the `type` (`capability-revoked`) names the cause. Raised
 * only for the holder of the capability and its invoking key (`denialError`
 * in `zcap.ts` enforces that), so it tells a prober nothing.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.cause] {Error}   the inspector's error
 */
export class CapabilityRevokedError extends DenialError {
  constructor({ requestName, cause }: { requestName?: string; cause?: Error }) {
    super({
      type: ProblemTypes.CAPABILITY_REVOKED,
      detail: 'A capability in the invoked delegation chain has been revoked.',
      requestName,
      cause
    })
  }
}

/**
 * 404 -- the invoked capability, or a capability in its delegation chain, has
 * expired (`capability-expired`). Same terms as `CapabilityRevokedError`: the
 * cause names something already written in the presented capability, and it
 * is raised only for the holder of the capability and its invoking key.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.cause] {Error}   the verifier's expiry error
 */
export class CapabilityExpiredError extends DenialError {
  constructor({ requestName, cause }: { requestName?: string; cause?: Error }) {
    super({
      type: ProblemTypes.CAPABILITY_EXPIRED,
      detail:
        'The invoked capability, or a capability in its delegation chain, ' +
        'has expired.',
      requestName,
      cause
    })
  }
}

/**
 * 401 — required `Authorization` / `Capability-Invocation` headers are missing.
 */
export class MissingAuthError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.MISSING_AUTHORIZATION,
      title: 'Invalid request',
      detail: 'Authorization and Capability-Invocation headers are required.',
      statusCode: 401
    })
  }
}

/**
 * 403 — provisioning (creating Spaces or keystores) is refused by the server's
 * configured provisioning policy (`authorizeProvisioning` returned `deny`).
 * There is no dedicated `forbidden` problem type in `@interop/storage-core`, so
 * this deliberately reuses `MISSING_AUTHORIZATION`.
 */
export class ProvisioningNotAuthorizedError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.MISSING_AUTHORIZATION,
      title: 'Provisioning not authorized',
      detail: 'Creating Spaces and keystores is not authorized on this server.',
      statusCode: 403
    })
  }
}

/**
 * 401 — the server requires an onboarding token to provision, but the request
 * carried no `Authorization: Bearer <token>` header.
 */
export class MissingOnboardingTokenError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.MISSING_AUTHORIZATION,
      title: 'Invalid request',
      detail:
        'An onboarding token (Authorization: Bearer) is required to create ' +
        'Spaces and keystores on this server.',
      statusCode: 401
    })
  }
}

/**
 * 403 — the onboarding token presented in the `Authorization: Bearer` header
 * did not match the configured token.
 */
export class InvalidOnboardingTokenError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid request',
      detail: 'The provided onboarding token is not valid.',
      statusCode: 403
    })
  }
}

/**
 * 400 — the `Authorization` header did not include a `keyId` parameter.
 */
export class MissingKeyIdError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid Authorization header',
      detail: 'Authorization header is missing the keyId parameter.',
      statusCode: 400
    })
  }
}

/**
 * 400 — failed to parse the `Authorization`, `Capability-Invocation`, or
 * `Digest` headers.
 * @param options {object}
 * @param options.cause {Error}   the underlying parse error
 */
export class AuthHeaderParseError extends ProblemError {
  constructor({ cause }: { cause: Error }) {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid authorization headers',
      detail:
        'Error parsing Authorization, Capability-Invocation, or Digest headers.',
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — the `Digest` header is missing, malformed, not covered by the request
 * signature, or does not match the received body (spec "Request Body
 * Integrity"). All of these are reported as `invalid-authorization-header`.
 * @param options {object}
 * @param options.detail {string}   which of the digest conditions failed
 * @param [options.cause] {Error}   the underlying error, when wrapping one
 */
export class InvalidDigestError extends ProblemError {
  constructor({ detail, cause }: { detail: string; cause?: Error }) {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: 'Invalid Digest header',
      detail,
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — an error was thrown while verifying the authorization headers.
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 * @param options.cause {Error}   the underlying verification error
 */
export class AuthVerificationError extends ProblemError {
  constructor({ requestName, cause }: { requestName: string; cause: Error }) {
    super({
      type: ProblemTypes.INVALID_AUTHORIZATION_HEADER,
      title: `Invalid ${requestName} request.`,
      detail: 'Error verifying authorization headers.',
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — the `controller` field is present but is not one of the controller
 * shapes this server accepts. Caught at the request layer so a malformed
 * controller is rejected on the way in rather than failing later, at
 * capability-verification time.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.allowWebvh] {boolean}   set on the one call site (Update
 *   Space) that also accepts a self-hosted `did:webvh`, so the message names
 *   both accepted shapes there and stays `did:key`-only everywhere else
 */
export class InvalidControllerError extends ProblemError {
  constructor({
    requestName,
    allowWebvh = false
  }: { requestName?: string; allowWebvh?: boolean } = {}) {
    const detail = allowWebvh
      ? 'The "controller" property must be a valid did:key DID, or a' +
        ' did:webvh DID hosted by this server.'
      : 'The "controller" property must be a valid did:key DID.'
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'request'} body`,
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }]
    })
  }
}

/**
 * 400 — the proposed `controller` is a syntactically self-hosted `did:webvh`,
 * but its history log does not resolve to a verified DID document: the log is
 * absent, malformed, fails verification, names a different DID, or the DID has
 * been deactivated.
 *
 * Refused before the promotion is stored, because after it both Update Space
 * and writes to the Collection holding the log are authorized by the very
 * controller being named -- so storing an unresolvable one would deadlock the
 * Space with no break-glass.
 *
 * @param options {object}
 * @param options.did {string}   the proposed controller DID
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.cause] {Error}   the underlying resolution failure
 */
export class UnresolvableControllerError extends ProblemError {
  constructor({
    did,
    requestName,
    cause
  }: {
    did: string
    requestName?: string
    cause?: Error
  }) {
    const detail =
      `The "controller" DID ("${did}") could not be resolved and verified` +
      ` from its history log in this server's storage.`
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'request'} body`,
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }],
      cause
    })
  }
}

/**
 * The shared body of the two body-controller consent failures below (Create
 * Space and Create Keystore): one `detail` template, one `#/controller`
 * problem entry, one 400. Module-private -- callers throw one of the two
 * exported subclasses, which differ only in their `title`.
 * @param options {object}
 * @param options.title {string}   the problem title of the concrete request
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 * @param [options.causeDetail] {string}   the differentiated failure cause,
 *   appended to the non-normative `detail` (spec SHOULD)
 * @param [options.cause] {Error}   the underlying chain-verification failure
 */
class ControllerMismatchError extends ProblemError {
  constructor({
    title,
    zcapSigningDid,
    controller,
    causeDetail,
    cause
  }: {
    title: string
    zcapSigningDid: string
    controller: string
    causeDetail?: string
    cause?: Error
  }) {
    const detail =
      `The invocation must be authorized by the 'controller' DID in the` +
      ` request body ("${controller}"): signed by it, or via a delegation` +
      ` chain rooted in it (invocation signed by "${zcapSigningDid}").` +
      (causeDetail ? ` Cause: ${causeDetail}.` : '')
    super({
      type: ProblemTypes.CONTROLLER_MISMATCH,
      title,
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/controller' }],
      cause
    })
  }
}

/**
 * 400 — the capability invocation on a Create Space request (via POST or
 * create-via-PUT) is not *authorized by* the `controller` in the request body:
 * it is neither signed directly by that DID nor accompanied by a delegation
 * chain rooted in it.
 * @param options {object}
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 * @param [options.causeDetail] {string}   the differentiated failure cause
 *   (chain rooted elsewhere / expired delegation / failed proof) from the
 *   static chain triage, appended to the non-normative `detail` (spec SHOULD)
 * @param [options.cause] {Error}   the underlying chain-verification failure,
 *   for a delegated invocation rejected at verification time
 */
export class SpaceControllerMismatchError extends ControllerMismatchError {
  constructor(options: {
    zcapSigningDid: string
    controller: string
    causeDetail?: string
    cause?: Error
  }) {
    super({ ...options, title: 'Invalid Create Space request' })
  }
}

/**
 * 500 — an underlying storage operation failed. The client-visible `title` /
 * `detail` are deliberately generic: the underlying `cause` can carry
 * server-internal specifics (filesystem paths, errnos, SQL) and is logged
 * server-side by `handleError`, never serialized to the wire.
 * @param options {object}
 * @param options.cause {Error}   the underlying storage error
 * @param [options.requestName] {string}   request name used in the error title
 */
export class StorageError extends ProblemError {
  constructor({ cause, requestName }: { cause: Error; requestName?: string }) {
    super({
      type: ProblemTypes.STORAGE_ERROR,
      title: requestName ? `Storage Error (${requestName})` : 'Storage Error',
      detail: 'An internal storage error occurred.',
      statusCode: 500,
      cause
    })
  }
}

/**
 * 500 — an at-rest WebKMS key record could not be decrypted (its KEK is not
 * registered, or the ciphertext failed to authenticate). A server-side
 * misconfiguration of `KMS_RECORD_KEK`, never a client error; `handleError`
 * logs the underlying `cause`.
 * @param options {object}
 * @param options.cause {Error}   the underlying cipher error
 * @param [options.requestName] {string}   request name used in the error title
 */
export class KmsRecordCipherError extends ProblemError {
  constructor({ cause, requestName }: { cause: Error; requestName?: string }) {
    super({
      type: ProblemTypes.INTERNAL_ERROR,
      title: requestName
        ? `KMS Record Cipher Error (${requestName})`
        : 'KMS Record Cipher Error',
      detail:
        'A stored key record could not be decrypted. This is a server ' +
        'configuration error (KMS_RECORD_KEK).',
      statusCode: 500,
      cause
    })
  }
}

/**
 * Rethrows a structured failure from a storage call unchanged (any
 * `ProblemError`, e.g. a 507 quota-exceeded raised by the backend), preserving
 * its status code; wraps anything else -- a genuinely unexpected fault -- as a
 * 500 `StorageError`. For use in request handlers' catch blocks around storage
 * operations.
 * @param options {object}
 * @param options.err {unknown}   the caught error
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {never}
 */
export function rethrowOrWrapStorageError({
  err,
  requestName
}: {
  err: unknown
  requestName?: string
}): never {
  if (err instanceof ProblemError) {
    throw err
  }
  throw new StorageError({ cause: err as Error, requestName })
}

/**
 * 507 — a write was rejected because the target backend's per-Space storage
 * quota is exhausted (spec "Quotas"). Distinct from `payload-too-large` (413),
 * which is a per-request upload-size limit rather than a cumulative one.
 * @param options {object}
 * @param options.spaceId {string}   the Space whose quota is exhausted
 * @param options.capacityBytes {number}   the configured per-Space limit
 * @param [options.requestName] {string}   request name used in the error title
 */
export class QuotaExceededError extends ProblemError {
  constructor({
    spaceId,
    capacityBytes,
    requestName
  }: {
    spaceId: string
    capacityBytes: number
    requestName?: string
  }) {
    super({
      type: ProblemTypes.QUOTA_EXCEEDED,
      title: `Insufficient Storage${requestName ? ` (${requestName})` : ''}`,
      detail: `Space '${spaceId}' storage quota of ${capacityBytes} bytes is exhausted.`,
      statusCode: 507
    })
  }
}

/**
 * 507 — a create was rejected because a default-on count quota is exhausted:
 * too many Spaces for one controller, or too many Collections in a Space.
 * Distinct from `QuotaExceededError` (also 507), which caps cumulative bytes
 * rather than item counts; both reuse the spec's `quota-exceeded` problem type
 * (there is no count-specific slug). Only the create path trips this --
 * overwriting an existing item never does.
 * @param options {object}
 * @param options.scope {string}   short phrase naming the exhausted count (e.g.
 *   `'Spaces per controller'`, `'Collections per Space'`), used in the detail
 *   message
 * @param options.limit {number}   the configured maximum count
 */
export class CountQuotaExceededError extends ProblemError {
  constructor({ scope, limit }: { scope: string; limit: number }) {
    super({
      type: ProblemTypes.QUOTA_EXCEEDED,
      title: 'Insufficient Storage',
      detail: `Count quota exceeded: ${scope} limit is ${limit}.`,
      statusCode: 507
    })
  }
}

const PAYLOAD_TOO_LARGE_TITLE =
  "Upload exceeds the backend's maximum upload size."

/**
 * 413 — an upload exceeds a per-request size limit: the target backend's
 * `maxUploadBytes` constraint, or the server's buffered-body limit when the
 * body is one the request layer holds in memory. Distinct from
 * `quota-exceeded` (507): this limit is per-request, not cumulative, so smaller
 * uploads may still succeed.
 * @param options {object}
 * @param options.maxUploadBytes {number}   the limit that was exceeded
 * @param [options.backendId] {string}   the backend enforcing the limit; absent
 *   when the limit is the server's own buffered-body limit rather than a
 *   backend's cap
 * @param [options.uploadBytes] {number}   the upload's size, when known up
 *   front (a streamed upload without a Content-Length only reveals the
 *   overflow, not the total)
 */
export class PayloadTooLargeError extends ProblemError {
  constructor({
    maxUploadBytes,
    backendId,
    uploadBytes
  }: {
    maxUploadBytes: number
    backendId?: string
    uploadBytes?: number
  }) {
    const size =
      uploadBytes === undefined ? 'Upload' : `Upload size ${uploadBytes}`
    super({
      type: ProblemTypes.PAYLOAD_TOO_LARGE,
      title: PAYLOAD_TOO_LARGE_TITLE,
      detail:
        backendId === undefined
          ? `${size} exceeds the buffered request body limit of ${maxUploadBytes} bytes.`
          : `${size} exceeds 'maxUploadBytes' of ${maxUploadBytes} for backend '${backendId}'.`,
      statusCode: 413
    })
  }
}

/**
 * 400 — a required field of the request body is missing or invalid.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param [options.detail] {string}   specific detail describing the problem
 * @param [options.pointer] {string}   RFC 6901 JSON Pointer (`#/field` form)
 *   to the offending body field
 */
export class InvalidRequestBodyError extends ProblemError {
  constructor({
    requestName,
    detail,
    pointer
  }: { requestName?: string; detail?: string; pointer?: string } = {}) {
    const resolvedDetail =
      detail || 'Request body is missing one or more required fields.'
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: `Invalid ${requestName || 'request'} body`,
      detail: resolvedDetail,
      statusCode: 400,
      ...(pointer ? { problems: [{ detail: resolvedDetail, pointer }] } : {})
    })
  }
}

/**
 * 400 — the request is missing a required `Content-Type` header.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class MissingContentTypeError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.MISSING_CONTENT_TYPE,
      title: `Invalid ${requestName || 'request'}`,
      detail: 'A Content-Type header is required for this request.',
      statusCode: 400
    })
  }
}

/**
 * 501 — the server does not implement this OPTIONAL operation (e.g. updating
 * Resource Metadata, which is not yet supported).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class UnsupportedOperationError extends ProblemError {
  constructor({ requestName }: { requestName?: string } = {}) {
    super({
      type: ProblemTypes.UNSUPPORTED_OPERATION,
      title: `Unsupported ${requestName || 'operation'}`,
      detail: 'This server does not implement this optional operation.',
      statusCode: 501
    })
  }
}

/**
 * 400 — the uploaded archive is not a valid PWS space export.
 * @param options {object}
 * @param [options.message] {string}   detail message describing the problem
 * @param [options.cause] {Error}   the underlying error, when wrapping one
 */
export class InvalidImportError extends ProblemError {
  constructor({ message, cause }: { message?: string; cause?: Error } = {}) {
    super({
      type: ProblemTypes.INVALID_IMPORT,
      title: 'Invalid space import',
      detail:
        message || 'The uploaded archive is not a valid PWS space export.',
      statusCode: 400,
      cause
    })
  }
}

// WebKMS facet errors (`/kms`). The webkms
// protocol is status-code driven -- `@interop/webkms-client` distinguishes
// only 404 and 409 -- so these reuse the nearest PWS problem-kind URIs rather
// than minting a parallel registry for a non-PWS route family.

/**
 * 404 — the requested keystore does not exist, or the caller is not
 * authorized (the PWS existence-masking convention, kept for consistency
 * within this server).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class KeystoreNotFoundError extends NotFoundError {}

/**
 * 400 — the capability invocation on a Create Keystore request is not
 * *authorized by* the `controller` in the request body: it is neither signed
 * directly by that DID nor accompanied by a delegation chain rooted in it.
 * The keystore-creation bootstrap rule, mirroring Create Space.
 * @param options {object}
 * @param options.zcapSigningDid {string}   DID that signed the invocation
 * @param options.controller {string}   controller DID supplied in the body
 * @param [options.causeDetail] {string}   the differentiated failure cause
 *   (chain rooted elsewhere / expired delegation / failed proof) from the
 *   static chain triage, appended to the non-normative `detail` (spec SHOULD)
 * @param [options.cause] {Error}   the underlying chain-verification failure,
 *   for a delegated invocation rejected at verification time
 */
export class KeystoreControllerMismatchError extends ControllerMismatchError {
  constructor(options: {
    zcapSigningDid: string
    controller: string
    causeDetail?: string
    cause?: Error
  }) {
    super({ ...options, title: 'Invalid Create Keystore request' })
  }
}

/**
 * 409 — a keystore config update could not be applied: the supplied `sequence`
 * is not exactly the stored sequence + 1, or the immutable `kmsModule` does
 * not match. One merged conflict kind; the client distinguishes only the 409
 * status.
 * `ID_CONFLICT` is the nearest PWS problem kind (a 409 state conflict on an
 * identified record) -- the webkms protocol has no type registry of its own.
 */
export class KeystoreStateConflictError extends ProblemError {
  constructor() {
    const detail =
      'Could not update keystore configuration: sequence must be exactly the' +
      ' stored sequence + 1 and "kmsModule" cannot change.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: 'Keystore configuration state conflict.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/sequence' }]
    })
  }
}

/**
 * 404 — the requested KMS-held key does not exist, or the caller is not
 * authorized (the same existence-masking as `KeystoreNotFoundError`).
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 */
export class KeyNotFoundError extends NotFoundError {}

/**
 * 409 — a key record already exists at `(keystoreId, localId)`. Key local ids
 * are server-generated 128-bit random values, so this is effectively
 * unreachable through the API; the storage layer still enforces insert-once
 * semantics (a unique-index insert), and
 * `@interop/webkms-client` maps a 409 on generate to its `DuplicateError`.
 */
export class KeyIdConflictError extends ProblemError {
  constructor() {
    const detail = 'Duplicate key identifier.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: 'A key with this id already exists.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * 400 — a well-formed key operation names an operation this KMS does not serve
 * for the key's type (e.g. `VerifyOperation` on an asymmetric key -- custody
 * is the criterion: asymmetric verify needs only the public key and is
 * client-local), or an operation type it does not recognize at all. A clean
 * 400.
 * @param options {object}
 * @param options.operationType {string}   the operation envelope's `type`
 * @param [options.keyType] {string}   the target key's type, when known
 */
export class UnsupportedKeyOperationError extends ProblemError {
  constructor({
    operationType,
    keyType
  }: {
    operationType: string
    keyType?: string
  }) {
    const detail = keyType
      ? `Unsupported operation "${operationType}" for key type "${keyType}".`
      : `Unknown operation type "${operationType}".`
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: 'Unsupported key operation.',
      detail,
      statusCode: 400,
      problems: [{ detail, pointer: '#/type' }]
    })
  }
}

/**
 * 400 — a submitted zcap revocation cannot be accepted: the body is not a
 * revocable delegated capability (root zcaps cannot be revoked), its id does
 * not match the revocation URL, its chain does not root in the keystore being
 * posted to, or its delegation chain fails verification. A chain that fails
 * to verify is never reported as revoked: the one already-revoked case is the
 * distinct `CapabilityAlreadyRevokedError`.
 * @param options {object}
 * @param options.detail {string}   which of the revocation conditions failed
 * @param [options.cause] {Error}   the underlying chain-verification failure
 */
export class InvalidRevocationError extends ProblemError {
  constructor({ detail, cause }: { detail: string; cause?: Error }) {
    super({
      type: ProblemTypes.INVALID_REQUEST_BODY,
      title: 'Invalid Revoke Capability request',
      detail,
      statusCode: 400,
      cause
    })
  }
}

/**
 * 400 — the submitted, verifying capability (or a capability in its chain) is
 * already revoked in the scope posted to, so the submission has nothing left
 * to do. The status matches ezcap-express's `authorizeZcapRevocation`, which
 * folds this case into its generic 400; the distinct problem type lets a
 * client resubmitting a revocation blind (a resumed ceremony) tell "already
 * done" from "refused". It is thrown only after the 404-masking authorization,
 * so it discloses nothing an unauthorized prober could not already learn. The
 * 409 duplicate is reserved for a write race at the store.
 */
export class CapabilityAlreadyRevokedError extends ProblemError {
  constructor() {
    super({
      type: ProblemTypes.CAPABILITY_ALREADY_REVOKED,
      title: 'Capability already revoked',
      detail:
        'The capability (or a capability in its chain) is already revoked.',
      statusCode: 400
    })
  }
}

/**
 * 409 — a revocation record already exists at `(delegator, capabilityId)`
 * (`@interop/webkms-client` maps a 409 to its `DuplicateError`). Reached only
 * on a concurrent-submission race: a sequential resubmission trips the
 * post-authorization store check first and is the 400
 * `CapabilityAlreadyRevokedError`.
 */
export class DuplicateRevocationError extends ProblemError {
  constructor() {
    const detail = 'Duplicate revocation.'
    super({
      type: ProblemTypes.ID_CONFLICT,
      title: 'This capability is already revoked.',
      detail,
      statusCode: 409,
      problems: [{ detail, pointer: '#/id' }]
    })
  }
}

/**
 * The over-limit errors Fastify and `@fastify/multipart` raise themselves,
 * mapped to the problem detail each one warrants. They carry a 413 status but
 * no problem `type`, so `handleError` would otherwise render them as
 * `internal-error` with an empty `errors` entry.
 */
const FRAMEWORK_TOO_LARGE_DETAILS: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE:
    'Request body exceeds the buffered request body limit.',
  FST_REQ_FILE_TOO_LARGE: 'The uploaded file exceeds the per-upload limit.',
  FST_FILES_LIMIT: 'The request carries more file parts than are accepted.',
  FST_FIELDS_LIMIT: 'The request carries more form fields than are accepted.',
  FST_PARTS_LIMIT: 'The request carries more parts than are accepted.'
}

/**
 * Fastify error handler installed by each route group. Serializes the error to
 * an `application/problem+json` response using its `type` / `title` / `detail`
 * (or `problems`), defaulting to a 500 internal error when no statusCode is
 * present. The spec requires `type` and `title`, so both always fall back to a
 * sensible value. A `MethodNotAllowedError` also sets the `Allow` header RFC
 * 9110 requires on a 405, and a `ServiceUnavailableError` the `Retry-After`
 * header. A framework over-limit error (Fastify's or
 * `@fastify/multipart`'s, which carry no `type`) is answered as the registered
 * `payload-too-large` problem.
 * @param error {Error & { statusCode?: number, type?: string, title?: string, detail?: string, problems?: Problem[], allow?: string[], retryAfter?: number }}
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<FastifyReply>}
 */
export async function handleError(
  error: Error & {
    statusCode?: number
    type?: string
    title?: string
    detail?: string
    problems?: Problem[]
    allow?: string[]
    retryAfter?: number
  },
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  // A framework over-limit error carries no `type`; answer the registered
  // `payload-too-large` problem in its place.
  const frameworkDetail =
    FRAMEWORK_TOO_LARGE_DETAILS[(error as { code?: string }).code ?? '']
  const problem =
    frameworkDetail !== undefined && error.type === undefined
      ? new ProblemError({
          type: ProblemTypes.PAYLOAD_TOO_LARGE,
          title: PAYLOAD_TOO_LARGE_TITLE,
          detail: frameworkDetail,
          statusCode: 413
        })
      : error
  const statusCode = problem.statusCode || 500
  if (error.allow) {
    reply.header('allow', error.allow.join(', '))
  }
  if (error.retryAfter !== undefined) {
    reply.header('retry-after', String(error.retryAfter))
  }
  // Log server-side faults (5xx, e.g. a StorageError and its underlying
  // `cause`) here through the request logger -- rather than in the error
  // constructors -- so logging lives in one place. Client errors (4xx) are
  // expected and not logged.
  if (statusCode >= 500) {
    request.log.error({ err: error }, error.title || 'Request error')
  }
  return reply
    .status(statusCode)
    .type('application/problem+json')
    .send({
      type: problem.type || ProblemTypes.INTERNAL_ERROR,
      title: problem.title || 'Request error',
      errors: problem.problems ?? [{ detail: problem.detail }]
    })
}
