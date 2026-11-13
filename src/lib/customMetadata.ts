/**
 * Validator for the user-writable `custom` object of a Metadata write body,
 * shared by the Resource-level (`PUT .../{resourceId}/meta`) and
 * Collection-level (`PUT .../{collectionId}/meta`) update handlers -- the two
 * carry the same `{ name, tags }` shape and must reject the same malformed
 * bodies with the same JSON-Pointer problem details.
 */
import { InvalidRequestBodyError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'
import { assertEncryptedMetaConforms } from './encryption.js'
import { hasCustomMembers } from './metadataWrite.js'
import type { CollectionEncryption, ResourceMetadataCustom } from '../types.js'

/**
 * Validates the `{ name, tags }` shape of a non-empty `custom` object on a
 * plaintext Collection, and returns the members it stores. Throws
 * `InvalidRequestBodyError` (400) when a member has the wrong type.
 *
 * On an encrypted Collection this shape check does not apply. A non-empty
 * `custom` there is the opaque encryption envelope, validated structurally by
 * `assertEncryptedMetaConforms` instead (a `422` on non-conformance).
 * `resolveMetadataCustom` picks between the two.
 * @param options {object}
 * @param options.custom {Record<string, unknown>}   the body's `custom` object
 * @param options.requestName {string}   request name for the 400 error title
 * @returns {ResourceMetadataCustom}
 */
function parsePlaintextCustom({
  custom,
  requestName
}: {
  custom: Record<string, unknown>
  requestName: string
}): ResourceMetadataCustom {
  const { name, tags } = custom
  if (name !== undefined && typeof name !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.name` property must be a string.',
      pointer: '/custom/name'
    })
  }
  if (tags !== undefined && !isPlainObject(tags)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom.tags` property must be a JSON object.',
      pointer: '/custom/tags'
    })
  }
  // Tag values MUST be strings (spec: values SHOULD be strings; the wire type
  // models them as `Record<string, string>`).
  if (
    tags !== undefined &&
    Object.values(tags).some(value => typeof value !== 'string')
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Every `custom.tags` value must be a string.',
      pointer: '/custom/tags'
    })
  }
  return {
    ...(name !== undefined && { name }),
    ...(tags !== undefined && { tags: tags as Record<string, string> })
  }
}

/**
 * Resolves the `custom` value a Metadata update (`PUT .../meta`) stores. Any
 * top-level body property other than `custom` is ignored here, so a client may
 * GET-modify-PUT the whole Metadata object.
 *
 * Two rules hold on every Collection. A `custom` that is present and not a
 * JSON object is `invalid-request-body` (400, pointer `/custom`). An empty or
 * omitted `custom` clears the stored annotations (returns `{}`); it is not an
 * envelope and is not held to the envelope check.
 *
 * A non-empty `custom` then branches on the target Collection's `encryption`
 * descriptor. On an encrypted Collection it MUST be a conforming envelope of
 * the scheme (stored opaquely, `422` otherwise). On a plaintext Collection it
 * MUST be a well-formed `{ name, tags }` object (`400` otherwise).
 *
 * Shared by the Resource-level and Collection-level update handlers, which call
 * it after authorization and the 404-if-missing check, so a 422/400 is
 * observable only to a caller authorized to write the target.
 * @param options {object}
 * @param options.collectionMetadata {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored Collection Metadata object
 * @param options.body {Record<string, unknown>}   the parsed request body
 * @param options.requestName {string}   request name for the 400 error title
 * @returns {ResourceMetadataCustom | Record<string, unknown>}
 */
export function resolveMetadataCustom({
  collectionMetadata,
  body,
  requestName
}: {
  collectionMetadata: { encryption?: CollectionEncryption }
  body: Record<string, unknown>
  requestName: string
}): ResourceMetadataCustom | Record<string, unknown> {
  const { custom } = body
  if (custom !== undefined && !isPlainObject(custom)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'The `custom` property must be a JSON object.',
      pointer: '/custom'
    })
  }
  if (!hasCustomMembers(custom)) {
    return {}
  }
  if (collectionMetadata.encryption?.scheme !== undefined) {
    assertEncryptedMetaConforms({ collectionMetadata, custom })
    return custom
  }
  return parsePlaintextCustom({ custom, requestName })
}
