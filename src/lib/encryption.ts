/**
 * Collection client-side encryption descriptor helpers (spec "Encrypted
 * Collections"). A Collection MAY carry a non-secret `encryption` descriptor
 * declaring that its Resources are client-encrypted and naming the scheme; any
 * authorized reader discovers it by reading the Collection Metadata object and
 * then decrypts with its own keys. The server never decrypts: it validates only the
 * descriptor's *shape* and enforces that it is declared at creation and immutable
 * afterward, storing the value opaquely. This mirrors the backend-selection
 * helpers in lib/backends.ts (validate on write / preserve on read), kept
 * separate because encryption is a per-Collection client concern, not a backend
 * capability.
 */
import type { CollectionEncryption, CollectionMetadata } from '../types.js'
import {
  InvalidRequestBodyError,
  EncryptionImmutableError,
  UnsupportedEncryptionSchemeError,
  EncryptionSchemeMismatchError
} from '../errors.js'
import { isValidEdvDocument } from './edvEnvelope.js'
import { isPlainObject } from './isPlainObject.js'
import { bareMediaType } from './mediaType.js'

/**
 * The encryption schemes this server recognizes and can enforce on write (spec
 * "Encryption Scheme Registry"). Each entry pins the scheme token to its
 * required stored-representation media type and the structural validator for its
 * envelope profile. v1 has exactly one entry: `edv` (EDV-over-PWS), an EDV
 * **Encrypted Document** (a JSON object whose `jwe` member is a JWE in JSON
 * serialization) carried as `application/json` -- matching what the EDV codec
 * actually stores and how a native EDV server serves an Encrypted Document.
 * "Marked with a recognized scheme" structurally implies "non-conforming writes
 * rejected here" -- the fail-closed guarantee: a plaintext object under
 * `application/json` passes the media-type gate but fails the structural
 * `jwe` gate, so it is still rejected. `versions` pins the wire-format
 * versions recognized for the scheme (spec: a positive integer per registered
 * revision, starting at `1`; an absent descriptor `version` means `1`).
 * Extending the registry (a new scheme, a new version, or a new media type for
 * an existing one) is the only place a scheme/version pair becomes acceptable.
 */
export const SUPPORTED_ENCRYPTION_SCHEMES: Record<
  string,
  {
    mediaType: string
    versions: ReadonlySet<number>
    validateEnvelope: (body: unknown) => boolean
  }
> = {
  edv: {
    mediaType: 'application/json',
    versions: new Set([1]),
    validateEnvelope: isValidEdvDocument
  }
}

/**
 * Validates a client-supplied Collection `encryption` descriptor and returns the
 * normalized value to persist, or `undefined` when absent (plaintext). Two
 * gates: (1) shape -- a present value must be an object with a non-empty string
 * `scheme`, else `invalid-request-body` (400, pointer `#/encryption`); (2)
 * fail-closed scheme gate -- the `scheme` MUST name one this server recognizes
 * and can enforce on write (`SUPPORTED_ENCRYPTION_SCHEMES`), else
 * `unsupported-encryption-scheme` (400, pointer `#/encryption/scheme`). Taking
 * the spec's SHOULD path, the reference server refuses to store a descriptor it
 * cannot back with write-time validation, rather than storing an unknown scheme
 * opaquely. Unknown **extra fields** on an otherwise-recognized descriptor are still
 * preserved (the whole object is returned, not reduced to `{ scheme }`) so
 * future public-reference fields a newer client adds (e.g. recipient key
 * references) survive an older server unchanged.
 *
 * @param options {object}
 * @param [options.encryption] {unknown}   the request body's `encryption` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {CollectionEncryption | undefined}   the descriptor to store, or undefined
 */
export function assertSupportedEncryption({
  encryption,
  requestName
}: {
  encryption?: unknown
  requestName?: string
}): CollectionEncryption | undefined {
  if (encryption === undefined) {
    return undefined
  }
  const scheme = isPlainObject(encryption) ? encryption.scheme : undefined
  if (typeof scheme !== 'string' || scheme.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption" must be an object with a non-empty string "scheme".',
      pointer: '#/encryption'
    })
  }
  // Fail closed: only a recognized scheme (one the server validates on write) is
  // accepted; an unknown scheme is rejected rather than stored opaquely.
  if (!Object.hasOwn(SUPPORTED_ENCRYPTION_SCHEMES, scheme)) {
    throw new UnsupportedEncryptionSchemeError({ scheme })
  }
  // Validate the OPTIONAL key-epoch fields (`epochs` / `currentEpoch`) when
  // present: shape-only safety rails against client bugs (a dropped epoch, a
  // dangling `currentEpoch`), never crypto verification -- the server holds no
  // key. Absent fields are a plain single-key-set descriptor and pass unchanged.
  assertValidEncryptionEpochs({
    descriptor: encryption as CollectionEncryption,
    requestName
  })

  // Validate the OPTIONAL blinding-key member (`hmac`) when present, on the
  // same shape-only terms as the epochs.
  assertValidEncryptionHmac({
    descriptor: encryption as CollectionEncryption,
    requestName
  })

  // Validate the OPTIONAL scheme-version field when present: shape, then the
  // same fail-closed recognition gate as the scheme itself.
  assertValidEncryptionVersion({ descriptor: encryption, scheme, requestName })

  // Preserve the whole descriptor (only `scheme` is typed today; keep any extra
  // forward-compat fields on a recognized scheme).
  return encryption as CollectionEncryption
}

/**
 * Validates the OPTIONAL `version` member of a Collection `encryption` descriptor --
 * the encryption scheme's wire-format version, a sibling of `scheme`. Two
 * gates: (1) shape -- when present it MUST be a positive safe integer, else
 * `invalid-request-body` (400, pointer `#/encryption/version`); (2) fail-closed
 * recognition -- it MUST name a version of the (already-recognized) scheme this
 * server can enforce on write (`SUPPORTED_ENCRYPTION_SCHEMES[scheme].versions`),
 * else `unsupported-encryption-scheme` (400, pointer `#/encryption/version`) --
 * the spec's accept-only-what-you-enforce SHOULD, applied to versions on the
 * same terms as schemes. Absent means version `1` (spec) and passes unchanged.
 * Read from the still-`unknown`-shaped descriptor value: `version` is preserved
 * opaquely, not part of the typed `CollectionEncryption` shape.
 *
 * @param options {object}
 * @param options.descriptor {unknown}   the shape-validated descriptor value
 * @param options.scheme {string}   the descriptor's recognized `scheme`
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
function assertValidEncryptionVersion({
  descriptor,
  scheme,
  requestName
}: {
  descriptor: unknown
  scheme: string
  requestName?: string
}): void {
  const { version } = descriptor as { version?: unknown }
  if (version === undefined) {
    return
  }
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption.version" must be a positive safe integer.',
      pointer: '#/encryption/version'
    })
  }
  if (!SUPPORTED_ENCRYPTION_SCHEMES[scheme]!.versions.has(version)) {
    throw new UnsupportedEncryptionSchemeError({ scheme, version })
  }
}

/**
 * Validates the OPTIONAL key-epoch public-reference fields of a Collection
 * `encryption` descriptor (spec "Encrypted Collections"; the `key-epochs` feature).
 * Shape-only integrity checks that catch client bugs -- the server never
 * interprets key material, so these are safety rails, not cryptographic
 * verification. Rejects with `invalid-request-body` (400) and a precise
 * `pointer`. Rules:
 * - `epochs` and `currentEpoch` are all-or-nothing: either both absent (a plain
 *   single-key-set descriptor) or both present.
 * - `epochs`: a non-empty array; each entry an object with a non-empty string
 *   `id` (ids unique across the array) and a non-empty `recipients` array.
 * - each `recipients` entry carries the JWE recipients-entry members the
 *   descriptor requires: a `header` object with non-empty string `kid` and `alg`,
 *   plus a string `encrypted_key` (the wrapped epoch key).
 * - `currentEpoch`: a non-empty string naming an `id` that exists in `epochs`.
 *
 * @param options {object}
 * @param options.descriptor {CollectionEncryption}   the shape-validated descriptor
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
function assertValidEncryptionEpochs({
  descriptor,
  requestName
}: {
  descriptor: CollectionEncryption
  requestName?: string
}): void {
  const { epochs, currentEpoch } = descriptor
  // All-or-nothing: `epochs` and `currentEpoch` appear together or not at all.
  if ((epochs === undefined) !== (currentEpoch === undefined)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "encryption.epochs" and "encryption.currentEpoch" must both be present or both absent.',
      pointer: '#/encryption/epochs'
    })
  }
  if (epochs === undefined) {
    return
  }
  const ids = new Set<string>()
  assertNonEmptyArray({
    value: epochs,
    detail: 'Collection "encryption.epochs" must be a non-empty array.',
    pointer: '#/encryption/epochs',
    requestName
  }).forEach((epoch, epochIndex) => {
    const pointer = `#/encryption/epochs/${epochIndex}`
    if (!isPlainObject(epoch)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: 'Each "encryption.epochs" entry must be an object.',
        pointer
      })
    }
    const id = assertNonEmptyString({
      value: epoch.id,
      detail:
        'Each "encryption.epochs" entry must have a non-empty string "id".',
      pointer: `${pointer}/id`,
      requestName
    })
    if (ids.has(id)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Duplicate "encryption.epochs" id "${id}".`,
        pointer: `${pointer}/id`
      })
    }
    ids.add(id)
    assertValidRecipientEntries({
      recipients: assertNonEmptyArray({
        value: epoch.recipients,
        detail:
          'Each "encryption.epochs" entry must have a non-empty "recipients" array.',
        pointer: `${pointer}/recipients`,
        requestName
      }),
      pointer: `${pointer}/recipients`,
      requestName
    })
  })
  const current = assertNonEmptyString({
    value: currentEpoch,
    detail: 'Collection "encryption.currentEpoch" must be a non-empty string.',
    pointer: '#/encryption/currentEpoch',
    requestName
  })
  if (!ids.has(current)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `Collection "encryption.currentEpoch" ("${current}") does not name an epoch in "epochs".`,
      pointer: '#/encryption/currentEpoch'
    })
  }
}

/**
 * Validates the entries of a wrapped-key `recipients` array -- the shape shared
 * by every epoch and by the `hmac` blinding-key member. Each entry must carry
 * the JWE recipients-entry members the descriptor requires: a `header` object
 * with non-empty string `kid` and `alg`, plus a string `encrypted_key` (the
 * wrapped key). The member checks (optional chaining included) already reject
 * every non-object or malformed entry, so no generic JWE-entry shape test runs
 * first. Rejects with `invalid-request-body` (400) and a pointer to the entry.
 *
 * @param options {object}
 * @param options.recipients {unknown[]}   the (already non-empty) recipients array
 * @param options.pointer {string}   the JSON pointer of the array itself
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
function assertValidRecipientEntries({
  recipients,
  pointer,
  requestName
}: {
  recipients: unknown[]
  pointer: string
  requestName?: string
}): void {
  recipients.forEach((recipient, recipientIndex) => {
    const header = (recipient as { header?: { kid?: unknown; alg?: unknown } })
      ?.header
    if (
      typeof header?.kid !== 'string' ||
      header.kid.length === 0 ||
      typeof header.alg !== 'string' ||
      header.alg.length === 0 ||
      typeof (recipient as { encrypted_key?: unknown }).encrypted_key !==
        'string'
    ) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          'Each "recipients" entry must have a "header" object with non-empty string "kid" and "alg", plus a string "encrypted_key".',
        pointer: `${pointer}/${recipientIndex}`
      })
    }
  })
}

/**
 * Validates the OPTIONAL `hmac` member of a Collection `encryption` descriptor
 * (spec "The blinding-key member" / "Server validation"): the public reference
 * to the Collection's blinding key, under which a client blinds the attribute
 * names and values of its blinded indexes. Shape-only, on the same terms as the
 * epoch members: when present, `hmac` MUST be an object with non-empty string
 * `id` and `type` and a non-empty `recipients` array whose entries have the
 * epoch recipients-entry shape. `type` is opaque to the server. Rejects with
 * `invalid-request-body` (400) and a precise `pointer`; an absent member passes.
 *
 * @param options {object}
 * @param options.descriptor {CollectionEncryption}   the shape-validated descriptor
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
function assertValidEncryptionHmac({
  descriptor,
  requestName
}: {
  descriptor: CollectionEncryption
  requestName?: string
}): void {
  const { hmac } = descriptor as { hmac?: unknown }
  if (hmac === undefined) {
    return
  }
  if (!isPlainObject(hmac)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Collection "encryption.hmac" must be an object.',
      pointer: '#/encryption/hmac'
    })
  }
  const { id, type, recipients } = hmac
  assertNonEmptyString({
    value: id,
    detail: 'Collection "encryption.hmac" must have a non-empty string "id".',
    pointer: '#/encryption/hmac/id',
    requestName
  })
  assertNonEmptyString({
    value: type,
    detail: 'Collection "encryption.hmac" must have a non-empty string "type".',
    pointer: '#/encryption/hmac/type',
    requestName
  })
  assertValidRecipientEntries({
    recipients: assertNonEmptyArray({
      value: recipients,
      detail:
        'Collection "encryption.hmac" must have a non-empty "recipients" array.',
      pointer: '#/encryption/hmac/recipients',
      requestName
    }),
    pointer: '#/encryption/hmac/recipients',
    requestName
  })
}

/**
 * Asserts a descriptor member is a non-empty string, returning it narrowed.
 * Rejects with `invalid-request-body` (400) at the member's pointer.
 * @param options {object}
 * @param options.value {unknown}   the member's value
 * @param options.detail {string}   the problem detail
 * @param options.pointer {string}   the member's JSON pointer
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {string}
 */
function assertNonEmptyString({
  value,
  detail,
  pointer,
  requestName
}: {
  value: unknown
  detail: string
  pointer: string
  requestName?: string
}): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestBodyError({ requestName, detail, pointer })
  }
  return value
}

/**
 * Asserts a descriptor member is a non-empty array, returning it narrowed.
 * Rejects with `invalid-request-body` (400) at the member's pointer.
 * @param options {object}
 * @param options.value {unknown}   the member's value
 * @param options.detail {string}   the problem detail
 * @param options.pointer {string}   the member's JSON pointer
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {unknown[]}
 */
function assertNonEmptyArray({
  value,
  detail,
  pointer,
  requestName
}: {
  value: unknown
  detail: string
  pointer: string
  requestName?: string
}): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestBodyError({ requestName, detail, pointer })
  }
  return value
}

/**
 * Enforces the blinding-key permanence rail on an UPDATE, when the existing
 * descriptor already carries an `hmac` member (spec "Server validation"). Call
 * only when an `incoming` descriptor was supplied and shape-validated. The
 * member MUST remain present with its `id` and `type` unchanged: every blinded
 * token in the Collection is computed under this key, so replacing or dropping
 * it would orphan every blinded index at once, just as a `scheme` change would
 * corrupt the Resources. Either violation is `encryption-immutable` (409) with
 * a pointer to the offending member. `recipients` entries MAY change (a reader
 * added or removed). Introducing `hmac` on a descriptor that lacks one is not a
 * server-side violation; the provisioning-time rule is a client-profile matter.
 *
 * @param options {object}
 * @param options.existing {CollectionEncryption}   the persisted descriptor
 * @param options.incoming {CollectionEncryption}   the validated request descriptor
 * @returns {void}
 */
export function assertEncryptionHmacTransition({
  existing,
  incoming
}: {
  existing: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  const existingHmac = existing.hmac
  if (existingHmac === undefined) {
    // No prior blinding key: a late introduction has nothing to preserve.
    return
  }
  const incomingHmac = incoming.hmac
  if (incomingHmac === undefined) {
    throw new EncryptionImmutableError({
      detail:
        'Collection "encryption.hmac" is permanent and may not be removed once set.',
      pointer: '#/encryption/hmac'
    })
  }
  if (incomingHmac.id !== existingHmac.id) {
    throw new EncryptionImmutableError({
      detail: `Collection "encryption.hmac.id" is permanent and may not change (from "${existingHmac.id}" to "${incomingHmac.id}").`,
      pointer: '#/encryption/hmac/id'
    })
  }
  if (incomingHmac.type !== existingHmac.type) {
    throw new EncryptionImmutableError({
      detail: `Collection "encryption.hmac.type" is permanent and may not change (from "${existingHmac.type}" to "${incomingHmac.type}").`,
      pointer: '#/encryption/hmac/type'
    })
  }
}

/**
 * Enforces the epoch-safety rails on an UPDATE, when the existing descriptor already
 * carries `epochs` (spec "Encrypted Collections"; the `key-epochs` feature).
 * Call only when an `incoming` descriptor was supplied and shape-validated. Rules
 * (both `invalid-request-body`, 400):
 * - **append-only**: every existing epoch id must still be present in
 *   `incoming.epochs` -- dropping an epoch would strand every Resource stamped
 *   with it (the removed reader could still hold that epoch's key, but no
 *   remaining reader could find it).
 * - **`currentEpoch` never moves backwards**: the incoming `currentEpoch` must
 *   equal the existing one OR name an epoch id that was NOT in the existing
 *   `epochs` list (a freshly appended epoch). This is the array-order-independent
 *   formulation of "monotonic".
 *
 * Recipients WITHIN an existing epoch MAY change (adding a recipient wraps the
 * epoch key to it; escrow adds entries to old epochs), so that is not
 * restricted. A first declaration of `epochs` on a descriptor that had none is
 * likewise unrestricted (there is nothing to append to yet).
 *
 * @param options {object}
 * @param options.existing {CollectionEncryption}   the persisted descriptor
 * @param options.incoming {CollectionEncryption}   the validated request descriptor
 * @returns {void}
 */
export function assertEncryptionEpochsTransition({
  existing,
  incoming
}: {
  existing: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  const existingEpochs = existing.epochs
  if (existingEpochs === undefined || existingEpochs.length === 0) {
    // No prior epochs: a first epoch declaration has nothing to append to.
    return
  }
  const incomingIds = new Set((incoming.epochs ?? []).map(epoch => epoch.id))
  // Append-only: no existing epoch id may vanish.
  for (const epoch of existingEpochs) {
    if (!incomingIds.has(epoch.id)) {
      throw new InvalidRequestBodyError({
        detail: `Collection "encryption.epochs" is append-only: epoch "${epoch.id}" may not be removed.`,
        pointer: '#/encryption/epochs'
      })
    }
  }
  // `currentEpoch` never moves backwards: keep it, or repoint it to a
  // newly-appended epoch id (one that did not exist before).
  const existingIds = new Set(existingEpochs.map(epoch => epoch.id))
  const { currentEpoch } = incoming
  if (
    currentEpoch !== existing.currentEpoch &&
    existingIds.has(currentEpoch as string)
  ) {
    throw new InvalidRequestBodyError({
      detail: `Collection "encryption.currentEpoch" may not move back to the existing epoch "${currentEpoch}"; repoint it only to a newly appended epoch.`,
      pointer: '#/encryption/currentEpoch'
    })
  }
}

/**
 * Enforces every `encryption`-descriptor transition check between a stored
 * Collection and a write that updates it, in one call: the creation-only rule
 * and the unchanging `scheme` ({@link assertEncryptionTransition}), the key-epoch
 * checks ({@link assertEncryptionEpochsTransition}), the permanent blinding
 * key ({@link assertEncryptionHmacTransition}) and the scheme-version check
 * ({@link assertEncryptionVersionTransition}). Unlike those, which require a
 * supplied `incoming`, this also accepts an absent one. A write that would
 * clear a stored descriptor is refused with `encryption-immutable` (409), on
 * the same terms as changing it. A Collection with no descriptor that stays
 * without one passes.
 *
 * The descriptor is creation-only (spec "Creation-only members"). The write
 * that creates the Collection declares it, so an absent `stored` (a create)
 * passes whatever it declares. A `stored` Collection with no `encryption`
 * member has none, and adding one is refused. Update Collection runs this
 * inside the backend's write, against the stored object the backend reads
 * under its lock, so a concurrent descriptor write cannot be clobbered and the
 * epoch append-only check holds unconditionally, not just under `If-Match`.
 * An append to a governing history log runs it against the prior head.
 *
 * @param options {object}
 * @param options.stored {Pick<CollectionMetadata, 'encryption'> | undefined}
 *   the stored Collection, or `undefined` when the write creates it
 * @param [options.incoming] {CollectionEncryption}   the descriptor about to be
 *   stored (absent when the write would drop the descriptor entirely)
 * @returns {void}
 */
export function assertEncryptionDescriptorTransition({
  stored,
  incoming
}: {
  stored: Pick<CollectionMetadata, 'encryption'> | undefined
  incoming?: CollectionEncryption
}): void {
  if (stored === undefined) {
    // A create declares freely.
    return
  }
  const existing = stored.encryption
  if (incoming === undefined && existing === undefined) {
    // A Collection without a descriptor stays without one.
    return
  }
  if (incoming === undefined || existing === undefined) {
    // Creation-only: an update neither clears a descriptor nor adds one.
    throw new EncryptionImmutableError()
  }
  assertEncryptionTransition({ existing, incoming })
  assertEncryptionEpochsTransition({ existing, incoming })
  assertEncryptionHmacTransition({ existing, incoming })
  assertEncryptionVersionTransition({ existing, incoming })
}

/**
 * Enforces the scheme-version rail on an UPDATE, when the existing descriptor
 * already carries a `version` (spec "Encrypted Collections"; the scheme-version
 * field). Call only when an `incoming` descriptor was supplied (and shape-validated).
 * Once set, the descriptor's `version` follows the same never-backwards philosophy
 * as `currentEpoch`: an update may not REMOVE it and may not DECREASE it
 * (increasing is allowed, a future scheme migration). Either violation is
 * `encryption-immutable` (409, pointer `#/encryption/version`). The spec gives a
 * version regression the same conflict as a scheme change, since both would
 * corrupt the stored, client-encrypted Resources. A descriptor that
 * had no prior `version` is unrestricted: adding a version to a versionless
 * descriptor has nothing to move backwards from. Both values are read from the
 * still-`unknown`-shaped descriptor: `version` is preserved opaquely, not part
 * of the typed `CollectionEncryption` shape.
 *
 * @param options {object}
 * @param options.existing {CollectionEncryption}   the persisted descriptor
 * @param options.incoming {CollectionEncryption}   the validated request descriptor
 * @returns {void}
 */
function assertEncryptionVersionTransition({
  existing,
  incoming
}: {
  existing: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  const existingVersion = (existing as { version?: unknown }).version
  if (typeof existingVersion !== 'number') {
    // No prior version: nothing to move backwards from.
    return
  }
  const incomingVersion = (incoming as { version?: unknown }).version
  if (incomingVersion === undefined) {
    throw new EncryptionImmutableError({
      detail:
        'Collection "encryption.version" may not be removed once it has been set.',
      pointer: '#/encryption/version'
    })
  }
  if ((incomingVersion as number) < existingVersion) {
    throw new EncryptionImmutableError({
      detail: `Collection "encryption.version" may not decrease (from ${existingVersion} to ${incomingVersion as number}).`,
      pointer: '#/encryption/version'
    })
  }
}

/**
 * Enforces the unchanging `scheme` of a Collection's stored `encryption`
 * descriptor on an update. Call only when an `incoming` descriptor was
 * supplied (and shape-validated). Re-sending the same `scheme` is a no-op.
 * Changing it is refused with `encryption-immutable` (409), since it would
 * corrupt the stored, client-encrypted Resources. The creation-only rule and
 * clearing are the caller's checks
 * ({@link assertEncryptionDescriptorTransition}). The `scheme` is the immutable
 * identity. The comparison ignores the other members, whose evolution (e.g.
 * adding a recipient) is a separate, allowed operation.
 *
 * @param options {object}
 * @param options.existing {CollectionEncryption}   the stored descriptor
 * @param options.incoming {CollectionEncryption}   the validated request descriptor
 * @returns {void}
 */
export function assertEncryptionTransition({
  existing,
  incoming
}: {
  existing: CollectionEncryption
  incoming: CollectionEncryption
}): void {
  if (existing.scheme !== incoming.scheme) {
    throw new EncryptionImmutableError()
  }
}

/**
 * Fail-closed structural validation of a Resource **content** write into an
 * encrypted Collection (spec "Encryption Scheme Registry"). When the target
 * Collection declares a recognized `encryption` scheme, a write MUST be a
 * conforming envelope of that scheme -- two gates: (1) the request `Content-Type`
 * MUST be the scheme's registered media type (so a binary/`octet-stream`,
 * `multipart`, or plain `application/json` upload is rejected outright), and (2)
 * the parsed body MUST satisfy the scheme's structural envelope profile. A
 * failure of either is `encryption-scheme-mismatch` (422). No-op when the
 * Collection has no descriptor (plaintext) or -- defensively -- an unrecognized
 * scheme (which `assertSupportedEncryption` prevents from ever being stored), so
 * plaintext Collections and API documents are unaffected. The server validates
 * structure only; it never decrypts. Call this **after** capability verification
 * and the 404-if-missing check, and before resolving the body stream, so a wrong
 * content type is rejected without consuming the upload and a 422 is observable
 * only to a caller already authorized to write the target.
 *
 * @param options {object}
 * @param options.collectionMetadata {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored Collection Metadata object
 * @param [options.contentType] {string}   the request `Content-Type` header
 * @param options.body {unknown}   the parsed request body (an object for the
 *   `application/<suffix>+json` media types the scheme registry uses)
 * @returns {void}
 */
export function assertEncryptedWriteConforms({
  collectionMetadata,
  contentType,
  body
}: {
  collectionMetadata: { encryption?: CollectionEncryption }
  contentType?: string
  body: unknown
}): void {
  const resolved = resolveEncryptionProfile({ collectionMetadata })
  if (resolved === undefined) {
    return
  }
  const { scheme, profile } = resolved
  // Gate 1: the stored representation's media type. Compare the bare media type
  // (parameters like `; charset=utf-8` stripped), case-insensitively.
  const mediaType = bareMediaType({ contentType })
  if (mediaType !== profile.mediaType) {
    throw new EncryptionSchemeMismatchError({
      detail: `A write into a Collection encrypted with the '${scheme}' scheme must use Content-Type '${profile.mediaType}'.`
    })
  }
  // Gate 2: the envelope's structural profile (server validates shape, not
  // contents -- it never decrypts).
  if (!profile.validateEnvelope(body)) {
    throw new EncryptionSchemeMismatchError({
      detail: `Resource body is not a structurally valid '${scheme}' encryption envelope.`
    })
  }
}

/**
 * Resolves a Collection's declared encryption scheme to its registry profile.
 * Returns `undefined` when the Collection has no descriptor (plaintext) or --
 * defensively -- names an unrecognized scheme, so the write-time conformance
 * checks below are a no-op in both cases.
 * @param options {object}
 * @param options.collectionMetadata {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored Collection Metadata object
 * @returns {{ scheme: string, profile: object } | undefined}
 */
function resolveEncryptionProfile({
  collectionMetadata
}: {
  collectionMetadata: { encryption?: CollectionEncryption }
}):
  | { scheme: string; profile: (typeof SUPPORTED_ENCRYPTION_SCHEMES)[string] }
  | undefined {
  const scheme = collectionMetadata.encryption?.scheme
  if (scheme === undefined) {
    return undefined
  }
  const profile = SUPPORTED_ENCRYPTION_SCHEMES[scheme]
  return profile ? { scheme, profile } : undefined
}

/**
 * Fail-closed structural validation of a Resource **metadata** write (`PUT
 * /meta`) into an encrypted Collection (spec "Encrypted Collections"). When the
 * target Collection declares a recognized `encryption` scheme, the user-writable
 * `custom` object MUST be a conforming envelope of that scheme -- the same
 * structural profile used for content -- so a plaintext `{ name, tags }` cannot
 * be stored server-visibly. Unlike {@link assertEncryptedWriteConforms} there is
 * **no media-type gate**: the metadata document itself stays `application/json`
 * (its server-managed top-level fields are plaintext); only the `custom`
 * sub-value is the envelope. A non-conforming `custom` is
 * `encryption-scheme-mismatch` (422). No-op when the Collection has no descriptor
 * (plaintext) or -- defensively -- an unrecognized scheme. The server validates
 * structure only; it never decrypts. Call this **after** capability verification
 * and the 404-if-missing check, before the write, so a 422 is observable only to
 * a caller already authorized to write the target.
 *
 * An absent or empty `custom` is rejected here like any other non-envelope.
 * Call this through `resolveMetadataCustom`, which answers a clearing write
 * first, and not directly from a handler.
 *
 * @param options {object}
 * @param options.collectionMetadata {{ encryption?: CollectionEncryption }}
 *   the target Collection's stored Collection Metadata object
 * @param options.custom {unknown}   the request body's `custom` value
 * @returns {void}
 */
export function assertEncryptedMetaConforms({
  collectionMetadata,
  custom
}: {
  collectionMetadata: { encryption?: CollectionEncryption }
  custom: unknown
}): void {
  const resolved = resolveEncryptionProfile({ collectionMetadata })
  if (resolved === undefined) {
    return
  }
  const { scheme, profile } = resolved
  if (!profile.validateEnvelope(custom)) {
    throw new EncryptionSchemeMismatchError({
      detail: `Resource metadata "custom" is not a structurally valid '${scheme}' encryption envelope.`
    })
  }
}
