/**
 * Id sanitization for path-traversal defense. `spaceId` / `collectionId` /
 * `resourceId` values arrive from URL params, request bodies, and tar-entry
 * names, then flow into filesystem paths (and glob patterns). This validator
 * rejects anything that is not a single, URL-safe path segment -- empty, `.`,
 * `..`, a value containing `/` or `\`, or any character outside the RFC 3986
 * "unreserved" set -- so a malicious id can never escape its parent directory.
 * It also rejects Collection / Resource ids that collide with the spec's
 * Reserved Path Segment Registry (`reserved-id`, 409).
 */
import { ARCHIVE_REVOCATIONS_DIR } from '@interop/space-archive'
import {
  InvalidSpaceIdError,
  InvalidCollectionIdError,
  InvalidResourceIdError,
  ReservedIdError
} from '../errors.js'

/**
 * Which kind of id is being validated (selects the thrown error class).
 */
export type IdKind = 'space' | 'collection' | 'resource'

/**
 * URL-safe id charset: the RFC 3986 "unreserved" characters
 * (ALPHA / DIGIT / `-` / `.` / `_` / `~`). This excludes path separators
 * (`/`, `\`) and every glob metacharacter, so a validated id is safe to use
 * both as a single path segment and inside a glob pattern.
 */
const ID_PATTERN = /^[A-Za-z0-9._~-]+$/

/**
 * Whether `id` is a single, URL-safe path segment: non-empty, not `.` / `..`,
 * free of path separators, and made only of the RFC 3986 "unreserved" charset
 * ({@link ID_PATTERN}). The shared safety predicate behind `assertValidId` (and
 * `assertValidBackendId` in `lib/backends.ts`); does **not** check the reserved
 * path-segment registry, which is id-kind specific.
 * @param id {string}
 * @returns {boolean}
 */
export function isUrlSafeSegment(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id !== '.' &&
    id !== '..' &&
    !id.includes('/') &&
    !id.includes('\\') &&
    ID_PATTERN.test(id)
  )
}

/**
 * Whether `id` can name a replica registration: a single, URL-safe path
 * segment that does not end in `.state`. An id ending in `.state` would name
 * another registration's state record.
 * @param id {string}
 * @returns {boolean}
 */
export function isReplicaId(id: string): boolean {
  return isUrlSafeSegment(id) && !id.endsWith('.state')
}

/**
 * Reserved path segments from the spec's Reserved Path Segment Registry. A
 * client-chosen Collection or Resource id matching one of these would shadow
 * the reserved route at that position (e.g. a Collection named `export` would
 * shadow `/space/{id}/export`), so the spec requires rejecting it with 409
 * `reserved-id`. Space ids have no reserved siblings (`/space/{id}` has no
 * static neighbors), so no set exists for the `space` kind.
 *
 * Exported as the server's authoritative per-kind sets so a client can mirror
 * them rather than hand-maintaining a copy (client #13). NOTE the one known
 * divergence from the pure spec registry: `.revocations` is not a route and
 * not in the registry, so a client mirroring the *spec* registry should omit
 * it. Kept byte-identical to `@interop/storage-core`'s exported registry
 * (locked by a drift-guard test); the local definition keeps the id-safety
 * logic self-contained.
 */
export const RESERVED_COLLECTION_IDS = new Set([
  'backends',
  // Retired in v0.5 (the Space URL lists Collections); the segment stays
  // reserved and the path answers with a 308 to the Space URL.
  'collections',
  'export',
  'import',
  'linkset',
  // The Space Metadata object is addressed at `/space/{id}/meta`, which
  // occupies the `{collectionId}` position.
  'meta',
  'policy',
  'query',
  'quotas',
  // The Space's replica registrations (`/space/{id}/replicas`).
  'replicas',
  // The Space's revocation endpoint sits under `/space/{id}/zcaps`.
  'zcaps',
  // Not a route: the system Collection the filesystem backend keeps a Space's
  // revocation records in, as the `.revocations/` subdirectory of the Space
  // dir, under the name the export archive gives it. Reserved so no
  // Collection dir can take the name.
  ARCHIVE_REVOCATIONS_DIR
])
/**
 * Space ids no client may create a Space under. Unlike the two registries
 * above, this is not a path-segment collision: `/space/{id}` has no static
 * neighbors. The `server` Space hosts the server's own identity
 * (`lib/serverIdentity.ts`) and is provisioned at boot, so a client create
 * naming it is refused with the same 409 `reserved-id`, whether or not the
 * Space exists yet, and whether or not the identity is configured. A stored
 * `server` Space is still addressable by its controller like any other.
 */
const RESERVED_SPACE_IDS = new Set(['server'])

export const RESERVED_RESOURCE_IDS = new Set([
  'backend',
  'linkset',
  // Collection Metadata is addressed at `/space/{id}/{collectionId}/meta`,
  // which occupies the `{resourceId}` position; the Resource-level `/meta`
  // sits one level lower and shadows nothing.
  'meta',
  'policy',
  'query',
  'quota'
])

/**
 * The 400 `invalid-id` error class each id kind throws for an unsafe id.
 */
const INVALID_ID_ERRORS: Record<
  IdKind,
  new (options: { requestName?: string }) => Error
> = {
  space: InvalidSpaceIdError,
  collection: InvalidCollectionIdError,
  resource: InvalidResourceIdError
}

/**
 * The reserved path-segment set each id kind may not take. Collections and
 * Resources have one; a Space id does not.
 */
const RESERVED_IDS: Record<IdKind, ReadonlySet<string> | undefined> = {
  space: undefined,
  collection: RESERVED_COLLECTION_IDS,
  resource: RESERVED_RESOURCE_IDS
}

/**
 * Asserts that an id is a single, URL-safe path segment that does not collide
 * with a reserved path segment -- throwing the typed 400 `invalid-id` error
 * matching `kind` for an unsafe id, or the 409 `reserved-id` error for a
 * reserved-segment collision.
 * @param id {string}   the id parsed from a URL param, body, or tar entry
 * @param options {object}
 * @param options.kind {IdKind}   which id is being validated
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidId(
  id: string,
  { kind, requestName }: { kind: IdKind; requestName?: string }
): void {
  if (!isUrlSafeSegment(id)) {
    throw new INVALID_ID_ERRORS[kind]({ requestName })
  }

  // Collections and Resources may not take a reserved path-segment name.
  if (RESERVED_IDS[kind]?.has(id)) {
    throw new ReservedIdError({ kind, id })
  }
}

/**
 * Asserts that a client-chosen Space id is not one of
 * {@link RESERVED_SPACE_IDS}, throwing the 409 `reserved-id` error. Run on
 * the two create paths only (Create Space, and Create Space by Id), not on
 * every route param, since the reserved Space itself is served normally.
 * @param id {string}   the client-chosen Space id
 * @returns {void}
 */
export function assertCreatableSpaceId(id: string): void {
  if (RESERVED_SPACE_IDS.has(id)) {
    throw new ReservedIdError({
      kind: 'space',
      id,
      detail: `'${id}' is reserved for the server and cannot be used as a space id.`
    })
  }
}

/**
 * Convenience wrapper that validates whichever of `spaceId` / `collectionId` /
 * `resourceId` are present on a request's params object. Call at the top of a
 * handler, before any storage access.
 * @param ids {object}
 * @param [ids.spaceId] {string}
 * @param [ids.collectionId] {string}
 * @param [ids.resourceId] {string}
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidIds(
  ids: { spaceId?: string; collectionId?: string; resourceId?: string },
  { requestName }: { requestName?: string } = {}
): void {
  if (ids.spaceId !== undefined) {
    assertValidId(ids.spaceId, { kind: 'space', requestName })
  }
  if (ids.collectionId !== undefined) {
    assertValidId(ids.collectionId, { kind: 'collection', requestName })
  }
  if (ids.resourceId !== undefined) {
    assertValidId(ids.resourceId, { kind: 'resource', requestName })
  }
}

/**
 * The Space id a canonical Space URL names, or `undefined` when the value is
 * not one: an absolute URL whose path is `/space/<id>/`, with no query and no
 * fragment.
 * @param value {unknown}
 * @returns {string | undefined}
 */
export function spaceIdOfSpaceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const match = /^\/space\/([^/]+)\/$/.exec(url.pathname)
  if (
    match === null ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href !== value ||
    !isUrlSafeSegment(match[1]!)
  ) {
    return undefined
  }
  return match[1]
}
