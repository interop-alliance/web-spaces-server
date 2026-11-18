/**
 * Collection app-attribution helpers (spec "Collection Data Model"): the
 * OPTIONAL `generator` object of a Collection Metadata object. It names the
 * application the Collection was provisioned for (the AS2 `generator` sense):
 * its DID (`id`, REQUIRED), the Web origin that DID was bound to at
 * provisioning time (`origin`) -- e.g. the browser-attested requesting origin
 * of an App Connect exchange, preserved so attribution survives without the
 * app-key credential at hand -- the application's canonical URL (`url`), and
 * its human-readable display label (`name`).
 *
 * Every member is an ASSERTION BY THE SPACE CONTROLLER, not a server
 * observation: the server validates only the shape, stores the object
 * verbatim, and echoes it on reads. Nothing here is ever an authorization
 * input, and the server never defaults or computes a member -- contrast the
 * server-observed, read-only `createdBy`, whose last entry under delegated
 * provisioning is the invoker (the wallet user), not the application. The
 * object is writable at CREATE and on UPDATE (so a controller can backfill
 * Collections provisioned before an application recorded its attribution). An
 * update
 * carrying `generator` replaces the whole object; an update omitting it keeps
 * the stored one. There is no clear/removal mechanism.
 */
import type { CollectionMetadata } from '../types.js'
import { InvalidRequestBodyError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'
import { escapePointerToken } from './requestBody.js'

/**
 * The members a `generator` object may carry. Any other member is rejected.
 */
const GENERATOR_MEMBERS: readonly string[] = ['id', 'origin', 'url', 'name']

/**
 * Validates the OPTIONAL client-supplied Collection `generator` object and
 * returns the value to persist, or `undefined` when absent (no attribution
 * asserted). A present value MUST be a plain object carrying only `id`,
 * `origin`, `url` and `name`:
 *
 * - `id` is REQUIRED and MUST be a DID string (a `did:` prefix).
 * - `origin`, when present, MUST be the ASCII serialization of a Web origin.
 * - `url`, when present, MUST come with `origin`, MUST be an absolute `http:`
 *   or `https:` URL whose origin equals `origin`, and MUST carry no query and
 *   no fragment (not even an empty `?` or `#`).
 * - `name`, when present, MUST be a non-empty string.
 *
 * A failure is `invalid-request-body` (400) with a pointer to the offending
 * member (`#/generator`, `#/generator/id`, `#/generator/origin`,
 * `#/generator/url`, `#/generator/name`, or the unknown member's own
 * pointer). The checks are
 * deliberately shallow: the server does not resolve the DID, does not verify
 * that the application controls it or that the origin served it, and never
 * treats any member as an authorization input.
 *
 * @param options {object}
 * @param [options.generator] {unknown}   the request body's `generator` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {CollectionMetadata['generator']}   the value to store, or
 *   undefined when absent
 */
export function assertValidGenerator({
  generator,
  requestName
}: {
  generator?: unknown
  requestName?: string
}): CollectionMetadata['generator'] {
  if (generator === undefined) {
    return undefined
  }
  if (!isPlainObject(generator)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "generator" must be an object with an "id" member (and optionally "origin", "url" and "name").',
      pointer: '#/generator'
    })
  }
  const unknownMember = Object.keys(generator).find(
    member => !GENERATOR_MEMBERS.includes(member)
  )
  if (unknownMember !== undefined) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Collection "generator" carries an unknown member "${unknownMember}"; only "id", "origin", "url" and "name" are allowed.`,
      pointer: `#/generator/${escapePointerToken(unknownMember)}`
    })
  }
  const { id, origin, url, name } = generator
  if (!isDidString(id)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "generator.id" must be a DID string (starting "did:").',
      pointer: '#/generator/id'
    })
  }
  if (
    origin !== undefined &&
    (typeof origin !== 'string' || !isWebOrigin(origin))
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "generator.origin" must be the ASCII serialization of a Web origin (e.g. "https://app.example.com").',
      pointer: '#/generator/origin'
    })
  }
  if (url !== undefined) {
    assertValidGeneratorUrl({ url, origin, requestName })
  }
  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Collection "generator.name" must be a non-empty string.',
      pointer: '#/generator/name'
    })
  }
  return {
    id,
    ...(origin !== undefined && { origin }),
    ...(url !== undefined && { url: url as string }),
    ...(name !== undefined && { name })
  }
}

/**
 * Validates a present `generator.url` against its sibling `origin`: the
 * origin must be present, the URL must parse as an absolute `http:` or
 * `https:` URL whose origin equals it, and the raw string must contain no `?`
 * and no `#`. The raw-string test matters because the URL parser reports an
 * empty `search` and `hash` for a bare trailing `?` or `#`. A failure is
 * `invalid-request-body` (400, pointer `#/generator/url`).
 *
 * @param options {object}
 * @param options.url {unknown}   the `generator.url` value
 * @param [options.origin] {string}   the already-validated `generator.origin`
 * @param [options.requestName] {string}   request name for the 400 error title
 */
function assertValidGeneratorUrl({
  url,
  origin,
  requestName
}: {
  url: unknown
  origin?: string
  requestName?: string
}): void {
  const reject = (detail: string): never => {
    throw new InvalidRequestBodyError({
      requestName,
      detail,
      pointer: '#/generator/url'
    })
  }
  if (origin === undefined) {
    return reject('Collection "generator.url" requires "generator.origin".')
  }
  if (typeof url !== 'string') {
    return reject('Collection "generator.url" must be a string.')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return reject('Collection "generator.url" must be an absolute URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return reject('Collection "generator.url" must be an http(s) URL.')
  }
  if (url.includes('?') || url.includes('#')) {
    return reject(
      'Collection "generator.url" must carry no query and no fragment.'
    )
  }
  if (parsed.origin !== origin) {
    return reject('Collection "generator.url" must share "generator.origin".')
  }
}

/**
 * Tests whether a value is a non-empty string in the DID form, narrowing it to
 * the `generator.id` wire type. Shape only -- the DID is never resolved.
 *
 * @param value {unknown}   the candidate DID
 * @returns {boolean}
 */
function isDidString(
  value: unknown
): value is NonNullable<CollectionMetadata['generator']>['id'] {
  return typeof value === 'string' && value.startsWith('did:')
}

/**
 * Tests whether a string is exactly the ASCII serialization of a Web origin:
 * it parses as a URL AND that URL's `origin` re-serializes to the same string.
 * This rejects an empty string, an unparseable value, and any string carrying
 * a path, query, fragment, credentials, or a trailing slash. An opaque origin
 * (a scheme with no host, which the URL parser serializes as `"null"`)
 * therefore fails.
 *
 * @param value {string}   the candidate origin serialization
 * @returns {boolean}
 */
function isWebOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}
