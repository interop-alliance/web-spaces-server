/**
 * Unit tests for the encryption-scheme library helpers (spec "Encryption Scheme
 * Registry"): the `edv` JWE structural validator (`isValidEdvEnvelope`), the EDV
 * Encrypted Document validator (`isValidEdvDocument`), the fail-closed scheme
 * gate (`assertSupportedEncryption`), the creation-only transition check
 * (`assertEncryptionTransition`), the Resource-content-write conformance gate
 * (`assertEncryptedWriteConforms`), and the Resource-metadata conformance gate
 * (`assertEncryptedMetaConforms`). These cover the pure logic directly,
 * complementing the over-the-wire suites; in particular
 * `assertEncryptionTransition` still exercises the `encryption-immutable` (409)
 * scheme-change path, which the wire suite can no longer reach in v1 (a second
 * recognized scheme is not expressible).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import {
  isValidEdvEnvelope,
  isValidEdvDocument,
  isValidJweRecipientEntry
} from '../src/lib/edvEnvelope.js'
import {
  assertSupportedEncryption,
  assertEncryptionTransition,
  assertEncryptionEpochsTransition,
  assertEncryptionHmacTransition,
  assertEncryptionDescriptorTransition,
  assertEncryptedWriteConforms,
  assertEncryptedMetaConforms
} from '../src/lib/encryption.js'
import type { CollectionEncryption } from '../src/types.js'
import {
  EncryptionImmutableError,
  UnsupportedEncryptionSchemeError,
  EncryptionSchemeMismatchError,
  InvalidRequestBodyError
} from '../src/errors.js'
import { recipient } from './helpers.js'

/** A valid multi-epoch descriptor naming `currentEpoch`, with two epochs. */
function epochDescriptor(): CollectionEncryption {
  return {
    scheme: 'edv',
    currentEpoch: 'urn:epoch:2',
    epochs: [
      { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp1#ka')] },
      { id: 'urn:epoch:1', recipients: [recipient('did:key:zApp2#ka')] }
    ]
  }
}

/** A minimal valid flattened JWE-JSON envelope. */
const flattened = { protected: 'eyJhbGciOiJkaXIifQ', ciphertext: 'c1' }

/**
 * A minimal valid EDV Encrypted Document: the JWE nested under `jwe`, alongside
 * the opaque EDV bookkeeping members the codec emits. This is the actual stored
 * representation (`application/json`), not a bare JWE.
 */
const edvDocument = { id: 'z1', sequence: 0, indexed: [], jwe: flattened }

describe('isValidEdvEnvelope', () => {
  const valid: [string, unknown][] = [
    ['flattened (protected + ciphertext)', flattened],
    [
      'flattened with encrypted_key + iv + tag',
      { protected: 'p', encrypted_key: 'k', iv: 'i', ciphertext: 'c', tag: 't' }
    ],
    [
      'general (recipients list)',
      {
        ciphertext: 'c',
        recipients: [{ header: { kid: 'k1' }, encrypted_key: 'ek1' }]
      }
    ],
    ['top-level encrypted_key only', { ciphertext: 'c', encrypted_key: 'k' }]
  ]
  for (const [label, body] of valid) {
    it(`accepts ${label}`, () => {
      assert.equal(isValidEdvEnvelope(body), true)
    })
  }

  const invalid: [string, unknown][] = [
    ['a non-object', 'not-an-object'],
    ['null', null],
    ['an array', [flattened]],
    ['a missing ciphertext', { protected: 'p' }],
    ['an empty-string ciphertext', { protected: 'p', ciphertext: '' }],
    ['a non-string ciphertext', { protected: 'p', ciphertext: 123 }],
    ['a non-string protected', { protected: 1, ciphertext: 'c' }],
    ['no key-delivery member', { ciphertext: 'c', iv: 'i', tag: 't' }],
    [
      'an empty recipients array (no other member)',
      { ciphertext: 'c', recipients: [] }
    ],
    ['a non-array recipients', { ciphertext: 'c', recipients: {} }],
    [
      'a recipient with non-string encrypted_key',
      { ciphertext: 'c', recipients: [{ encrypted_key: 5 }] }
    ],
    ['a plaintext JSON document', { hello: 'world' }]
  ]
  for (const [label, body] of invalid) {
    it(`rejects ${label}`, () => {
      assert.equal(isValidEdvEnvelope(body), false)
    })
  }
})

describe('isValidEdvDocument', () => {
  it('accepts an EDV Document with a valid `jwe` member', () => {
    assert.equal(isValidEdvDocument(edvDocument), true)
  })
  it('accepts a `jwe`-only object (no bookkeeping members)', () => {
    assert.equal(isValidEdvDocument({ jwe: flattened }), true)
  })
  const invalid: [string, unknown][] = [
    ['a non-object', 'not-an-object'],
    ['null', null],
    ['an array', [edvDocument]],
    ['a bare JWE (no `jwe` wrapper)', flattened],
    ['a plaintext JSON document', { hello: 'world' }],
    ['a `jwe` that is not a valid envelope', { jwe: { hello: 'world' } }],
    ['a non-object `jwe`', { jwe: 'nope' }]
  ]
  for (const [label, body] of invalid) {
    it(`rejects ${label}`, () => {
      assert.equal(isValidEdvDocument(body), false)
    })
  }
})

describe('assertSupportedEncryption', () => {
  it('accepts and returns a recognized `edv` descriptor', () => {
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: { scheme: 'edv' } }),
      { scheme: 'edv' }
    )
  })
  it('preserves extra forward-compat fields on a recognized descriptor', () => {
    const descriptor = { scheme: 'edv', recipients: [{ id: 'k1' }] }
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: descriptor }),
      descriptor
    )
  })
  it('returns undefined for an absent descriptor (plaintext)', () => {
    assert.equal(
      assertSupportedEncryption({ encryption: undefined }),
      undefined
    )
  })
  it('throws UnsupportedEncryptionSchemeError for an unrecognized scheme', () => {
    assert.throws(
      () => assertSupportedEncryption({ encryption: { scheme: 'rot13' } }),
      UnsupportedEncryptionSchemeError
    )
  })
})

describe('assertEncryptionTransition', () => {
  it('throws EncryptionImmutableError (409) declaring a descriptor on a Collection that lacks one', () => {
    // Creation-only: the create declares the descriptor, so an update of a
    // stored Collection without one cannot add it.
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: {},
          incoming: { scheme: 'edv' }
        }),
      '#/encryption'
    )
  })
  it('is a no-op re-sending the same scheme', () => {
    assert.doesNotThrow(() =>
      assertEncryptionTransition({
        existing: { scheme: 'edv' },
        incoming: { scheme: 'edv' }
      })
    )
  })
  it('throws EncryptionImmutableError (409) changing an existing scheme', () => {
    // The 409 scheme-change path; two distinct schemes are cast in since v1's
    // `CollectionEncryption` type models only `edv`.
    assert.throws(
      () =>
        assertEncryptionTransition({
          existing: { scheme: 'edv' },
          incoming: { scheme: 'other' } as unknown as { scheme: 'edv' }
        }),
      EncryptionImmutableError
    )
  })
})

describe('isValidJweRecipientEntry', () => {
  const valid: [string, unknown][] = [
    ['a bare object', {}],
    ['header only', { header: { kid: 'k' } }],
    ['header + encrypted_key', { header: { kid: 'k' }, encrypted_key: 'ek' }],
    ['encrypted_key only', { encrypted_key: 'ek' }]
  ]
  for (const [label, entry] of valid) {
    it(`accepts ${label}`, () => {
      assert.equal(isValidJweRecipientEntry(entry), true)
    })
  }
  const invalid: [string, unknown][] = [
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
    ['a non-object header', { header: 'nope' }],
    ['a non-string encrypted_key', { encrypted_key: 5 }]
  ]
  for (const [label, entry] of invalid) {
    it(`rejects ${label}`, () => {
      assert.equal(isValidJweRecipientEntry(entry), false)
    })
  }
})

describe('assertSupportedEncryption (key-epoch fields)', () => {
  it('accepts and round-trips a valid multi-epoch descriptor verbatim', () => {
    const descriptor = epochDescriptor()
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: descriptor }),
      descriptor
    )
  })
  it('rejects `epochs` without `currentEpoch` (400)', () => {
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: {
            scheme: 'edv',
            epochs: [{ id: 'e1', recipients: [recipient('k')] }]
          }
        }),
      InvalidRequestBodyError
    )
  })
  it('rejects `currentEpoch` without `epochs` (400)', () => {
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: { scheme: 'edv', currentEpoch: 'e1' }
        }),
      InvalidRequestBodyError
    )
  })
  it('rejects a dangling `currentEpoch` that names no epoch (400)', () => {
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: {
            scheme: 'edv',
            currentEpoch: 'missing',
            epochs: [{ id: 'e1', recipients: [recipient('k')] }]
          }
        }),
      InvalidRequestBodyError
    )
  })
  it('rejects a malformed recipient entry (no header.kid) (400)', () => {
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: {
            scheme: 'edv',
            currentEpoch: 'e1',
            epochs: [
              { id: 'e1', recipients: [{ encrypted_key: 'ek' } as never] }
            ]
          }
        }),
      InvalidRequestBodyError
    )
  })
  it('rejects duplicate epoch ids (400)', () => {
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: {
            scheme: 'edv',
            currentEpoch: 'e1',
            epochs: [
              { id: 'e1', recipients: [recipient('k')] },
              { id: 'e1', recipients: [recipient('k2')] }
            ]
          }
        }),
      InvalidRequestBodyError
    )
  })
  it('rejects an empty recipients array (400)', () => {
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: {
            scheme: 'edv',
            currentEpoch: 'e1',
            epochs: [{ id: 'e1', recipients: [] }]
          }
        }),
      InvalidRequestBodyError
    )
  })
})

/** A valid `edv` descriptor carrying a blinding-key `hmac` member. */
function hmacDescriptor(): CollectionEncryption {
  return {
    scheme: 'edv',
    hmac: {
      id: 'urn:uuid:blinding-key-1',
      type: 'Sha256HmacKey2019',
      recipients: [recipient('did:key:zApp1#ka')]
    }
  }
}

describe('assertSupportedEncryption (hmac member)', () => {
  it('accepts and round-trips a descriptor carrying a valid `hmac` verbatim', () => {
    const descriptor = hmacDescriptor()
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: descriptor }),
      descriptor
    )
  })
  it('accepts a descriptor without `hmac` unchanged', () => {
    const descriptor = epochDescriptor()
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: descriptor }),
      descriptor
    )
  })
  const malformed: [string, unknown, string][] = [
    ['a non-object hmac', 'not-an-object', '#/encryption/hmac'],
    ['an array hmac', [], '#/encryption/hmac'],
    [
      'a missing id',
      { type: 'Sha256HmacKey2019', recipients: [recipient('k')] },
      '#/encryption/hmac/id'
    ],
    [
      'an empty id',
      { id: '', type: 'Sha256HmacKey2019', recipients: [recipient('k')] },
      '#/encryption/hmac/id'
    ],
    [
      'a missing type',
      { id: 'urn:k', recipients: [recipient('k')] },
      '#/encryption/hmac/type'
    ],
    [
      'a non-string type',
      { id: 'urn:k', type: 7, recipients: [recipient('k')] },
      '#/encryption/hmac/type'
    ],
    [
      'missing recipients',
      { id: 'urn:k', type: 'Sha256HmacKey2019' },
      '#/encryption/hmac/recipients'
    ],
    [
      'empty recipients',
      { id: 'urn:k', type: 'Sha256HmacKey2019', recipients: [] },
      '#/encryption/hmac/recipients'
    ],
    [
      'a recipient without header.kid',
      {
        id: 'urn:k',
        type: 'Sha256HmacKey2019',
        recipients: [recipient('k'), { encrypted_key: 'ek' }]
      },
      '#/encryption/hmac/recipients/1'
    ]
  ]
  for (const [label, hmac, pointer] of malformed) {
    it(`rejects ${label} (400, pointer ${pointer})`, () => {
      throwsInvalidBodyPointer(
        () =>
          assertSupportedEncryption({ encryption: { scheme: 'edv', hmac } }),
        pointer
      )
    })
  }
})

describe('assertEncryptionHmacTransition', () => {
  it('is a no-op when the existing descriptor has no hmac (late introduction)', () => {
    assert.doesNotThrow(() =>
      assertEncryptionHmacTransition({
        existing: { scheme: 'edv' },
        incoming: hmacDescriptor()
      })
    )
  })
  it('allows re-sending the same hmac', () => {
    assert.doesNotThrow(() =>
      assertEncryptionHmacTransition({
        existing: hmacDescriptor(),
        incoming: hmacDescriptor()
      })
    )
  })
  it('allows changing the recipients (reader added or removed)', () => {
    const incoming = hmacDescriptor()
    incoming.hmac!.recipients = [recipient('did:key:zApp2#ka')]
    assert.doesNotThrow(() =>
      assertEncryptionHmacTransition({ existing: hmacDescriptor(), incoming })
    )
  })
  it('rejects removing hmac (409 encryption-immutable, pointer #/encryption/hmac)', () => {
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: { encryption: hmacDescriptor() },
          incoming: { scheme: 'edv' }
        }),
      '#/encryption/hmac'
    )
  })
  it('rejects changing hmac.id (409, pointer #/encryption/hmac/id)', () => {
    const incoming = hmacDescriptor()
    incoming.hmac!.id = 'urn:uuid:blinding-key-2'
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: { encryption: hmacDescriptor() },
          incoming
        }),
      '#/encryption/hmac/id'
    )
  })
  it('rejects changing hmac.type (409, pointer #/encryption/hmac/type)', () => {
    const incoming = hmacDescriptor()
    incoming.hmac!.type = 'OtherKeyType'
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: { encryption: hmacDescriptor() },
          incoming
        }),
      '#/encryption/hmac/type'
    )
  })
})

/** Asserts `fn` throws an InvalidRequestBodyError carrying `pointer`. */
function throwsInvalidBodyPointer(fn: () => void, pointer: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof InvalidRequestBodyError)
    assert.equal(
      (err as { problems?: { pointer?: string }[] }).problems?.[0]?.pointer,
      pointer
    )
    return true
  })
}

describe('assertSupportedEncryption (scheme version)', () => {
  it('accepts and round-trips a descriptor with version 1 verbatim', () => {
    const descriptor = { scheme: 'edv', version: 1 }
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: descriptor }),
      descriptor
    )
  })
  it('accepts a versionless descriptor (absent means version 1) unchanged', () => {
    assert.deepStrictEqual(
      assertSupportedEncryption({ encryption: { scheme: 'edv' } }),
      { scheme: 'edv' }
    )
  })
  const rejected: [string, unknown][] = [
    ['version 0', 0],
    ['a negative version', -1],
    ['a non-integer version', 1.5],
    ['a non-number version', '1']
  ]
  for (const [label, version] of rejected) {
    it(`rejects ${label} (400, pointer #/encryption/version)`, () => {
      throwsInvalidBodyPointer(
        () =>
          assertSupportedEncryption({ encryption: { scheme: 'edv', version } }),
        '#/encryption/version'
      )
    })
  }
  it('rejects an unrecognized version of a recognized scheme (400 unsupported-encryption-scheme)', () => {
    // The registry recognizes only `edv` version 1; the fail-closed
    // accept-only-what-you-enforce gate applies to versions like schemes.
    assert.throws(
      () =>
        assertSupportedEncryption({
          encryption: { scheme: 'edv', version: 2 }
        }),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedEncryptionSchemeError)
        assert.equal(
          (err as { problems?: { pointer?: string }[] }).problems?.[0]?.pointer,
          '#/encryption/version'
        )
        return true
      }
    )
  })
})

describe('assertEncryptionDescriptorTransition (scheme version)', () => {
  it('allows keeping the same version', () => {
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: {
          encryption: { scheme: 'edv', version: 1 } as CollectionEncryption
        },
        incoming: { scheme: 'edv', version: 1 } as CollectionEncryption
      })
    )
  })
  it('allows raising the version (a future migration)', () => {
    // The transition rail alone: whether the raised version is actually
    // storable is the recognition gate's call (`assertSupportedEncryption`).
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: {
          encryption: { scheme: 'edv', version: 1 } as CollectionEncryption
        },
        incoming: { scheme: 'edv', version: 2 } as CollectionEncryption
      })
    )
  })
  it('allows adding a version to a versionless descriptor', () => {
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: { encryption: { scheme: 'edv' } },
        incoming: { scheme: 'edv', version: 1 } as CollectionEncryption
      })
    )
  })
  it('is a no-op when neither descriptor carries a version', () => {
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: { encryption: { scheme: 'edv' } },
        incoming: { scheme: 'edv' }
      })
    )
  })
  it('rejects lowering the version (409 encryption-immutable, pointer #/encryption/version)', () => {
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: {
            encryption: { scheme: 'edv', version: 2 } as CollectionEncryption
          },
          incoming: { scheme: 'edv', version: 1 } as CollectionEncryption
        }),
      '#/encryption/version'
    )
  })
  it('rejects dropping the version once set (409 encryption-immutable, pointer #/encryption/version)', () => {
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: {
            encryption: { scheme: 'edv', version: 1 } as CollectionEncryption
          },
          incoming: { scheme: 'edv' }
        }),
      '#/encryption/version'
    )
  })
})

/** Asserts `fn` throws an EncryptionImmutableError carrying `pointer`. */
function throwsImmutablePointer(fn: () => void, pointer: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EncryptionImmutableError)
    assert.equal(
      (err as { problems?: { pointer?: string }[] }).problems?.[0]?.pointer,
      pointer
    )
    return true
  })
}

describe('assertEncryptionEpochsTransition', () => {
  it('is a no-op when the existing descriptor has no epochs', () => {
    assert.doesNotThrow(() =>
      assertEncryptionEpochsTransition({
        existing: { scheme: 'edv' },
        incoming: epochDescriptor()
      })
    )
  })
  it('allows appending a new epoch and repointing currentEpoch to it', () => {
    const existing = epochDescriptor()
    const incoming: CollectionEncryption = {
      scheme: 'edv',
      currentEpoch: 'urn:epoch:3',
      epochs: [
        { id: 'urn:epoch:3', recipients: [recipient('did:key:zApp1#ka')] },
        ...existing.epochs!
      ]
    }
    assert.doesNotThrow(() =>
      assertEncryptionEpochsTransition({ existing, incoming })
    )
  })
  it('allows adding a recipient to an existing epoch (currentEpoch unchanged)', () => {
    const existing = epochDescriptor()
    const incoming: CollectionEncryption = {
      scheme: 'edv',
      currentEpoch: 'urn:epoch:2',
      epochs: [
        {
          id: 'urn:epoch:2',
          recipients: [
            recipient('did:key:zApp1#ka'),
            recipient('did:key:zApp3#ka')
          ]
        },
        existing.epochs![1]!
      ]
    }
    assert.doesNotThrow(() =>
      assertEncryptionEpochsTransition({ existing, incoming })
    )
  })
  it('rejects dropping an existing epoch (400 append-only)', () => {
    const existing = epochDescriptor()
    const incoming: CollectionEncryption = {
      scheme: 'edv',
      currentEpoch: 'urn:epoch:2',
      epochs: [existing.epochs![0]!]
    }
    assert.throws(
      () => assertEncryptionEpochsTransition({ existing, incoming }),
      InvalidRequestBodyError
    )
  })
  it('rejects moving currentEpoch back to an older existing epoch (400)', () => {
    const existing = epochDescriptor()
    const incoming: CollectionEncryption = {
      ...epochDescriptor(),
      currentEpoch: 'urn:epoch:1'
    }
    assert.throws(
      () => assertEncryptionEpochsTransition({ existing, incoming }),
      InvalidRequestBodyError
    )
  })
})

describe('assertEncryptionDescriptorTransition', () => {
  it('throws EncryptionImmutableError (409) adding a descriptor to a Collection that has none', () => {
    throwsImmutablePointer(
      () =>
        assertEncryptionDescriptorTransition({
          stored: {},
          incoming: epochDescriptor()
        }),
      '#/encryption'
    )
  })
  it('is a no-op for a create (no stored Collection), whatever it declares', () => {
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: undefined,
        incoming: epochDescriptor()
      })
    )
  })
  it('is a no-op when a Collection with no descriptor stays without one', () => {
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: {},
        incoming: undefined
      })
    )
  })
  it('throws EncryptionImmutableError (409) when the write would clear an existing descriptor', () => {
    // The clear-the-descriptor race: a persisted descriptor with no incoming one.
    assert.throws(
      () =>
        assertEncryptionDescriptorTransition({
          stored: { encryption: { scheme: 'edv' } },
          incoming: undefined
        }),
      EncryptionImmutableError
    )
  })
  it('delegates to the set-once rail: a scheme change throws EncryptionImmutableError (409)', () => {
    assert.throws(
      () =>
        assertEncryptionDescriptorTransition({
          stored: { encryption: { scheme: 'edv' } },
          incoming: { scheme: 'other' } as unknown as CollectionEncryption
        }),
      EncryptionImmutableError
    )
  })
  it('delegates to the epoch rail: dropping an existing epoch throws InvalidRequestBodyError (400)', () => {
    const existing = epochDescriptor()
    const incoming: CollectionEncryption = {
      scheme: 'edv',
      currentEpoch: 'urn:epoch:2',
      epochs: [existing.epochs![0]!]
    }
    assert.throws(
      () =>
        assertEncryptionDescriptorTransition({
          stored: { encryption: existing },
          incoming
        }),
      InvalidRequestBodyError
    )
  })
  it('passes a valid same-scheme epoch append', () => {
    const existing = epochDescriptor()
    const incoming: CollectionEncryption = {
      scheme: 'edv',
      currentEpoch: 'urn:epoch:3',
      epochs: [
        { id: 'urn:epoch:3', recipients: [recipient('did:key:zApp1#ka')] },
        ...existing.epochs!
      ]
    }
    assert.doesNotThrow(() =>
      assertEncryptionDescriptorTransition({
        stored: { encryption: existing },
        incoming
      })
    )
  })
})

describe('assertEncryptionTransition (recipient/epoch evolution passes)', () => {
  it('passes when only recipients/epochs change and `scheme` is unchanged', () => {
    // The transition rule is scheme-only, so recipient/epoch churn is an allowed
    // update -- pin that explicitly (it never trips `encryption-immutable`).
    assert.doesNotThrow(() =>
      assertEncryptionTransition({
        existing: { scheme: 'edv' },
        incoming: epochDescriptor()
      })
    )
    assert.doesNotThrow(() =>
      assertEncryptionTransition({
        existing: epochDescriptor(),
        incoming: {
          scheme: 'edv',
          currentEpoch: 'urn:epoch:3',
          epochs: [
            { id: 'urn:epoch:3', recipients: [recipient('did:key:zApp1#ka')] },
            ...epochDescriptor().epochs!
          ]
        }
      })
    )
  })
})

describe('assertEncryptedWriteConforms', () => {
  const edv = { encryption: { scheme: 'edv' as const } }

  it('is a no-op for a plaintext Collection (any body/content type)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionMetadata: {},
        contentType: 'application/json',
        body: { hello: 'world' }
      })
    )
  })
  it('accepts a conforming EDV Document under application/json', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionMetadata: edv,
        contentType: 'application/json',
        body: edvDocument
      })
    )
  })
  it('accepts the media type with parameters (charset)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedWriteConforms({
        collectionMetadata: edv,
        contentType: 'application/JSON; charset=utf-8',
        body: edvDocument
      })
    )
  })
  it('rejects a wrong content type (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionMetadata: edv,
          contentType: 'application/octet-stream',
          body: edvDocument
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a missing content type (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionMetadata: edv,
          contentType: undefined,
          body: edvDocument
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a right content type but plaintext body (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionMetadata: edv,
          contentType: 'application/json',
          body: { hello: 'world' }
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a bare JWE (no `jwe` wrapper) as non-conforming (422)', () => {
    assert.throws(
      () =>
        assertEncryptedWriteConforms({
          collectionMetadata: edv,
          contentType: 'application/json',
          body: flattened
        }),
      EncryptionSchemeMismatchError
    )
  })
})

describe('assertEncryptedMetaConforms', () => {
  const edv = { encryption: { scheme: 'edv' as const } }

  it('is a no-op for a plaintext Collection (any custom)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedMetaConforms({
        collectionMetadata: {},
        custom: { name: 'Hello', tags: { x: 'y' } }
      })
    )
  })
  it('accepts a conforming EDV Document `custom` (no media-type gate)', () => {
    assert.doesNotThrow(() =>
      assertEncryptedMetaConforms({
        collectionMetadata: edv,
        custom: edvDocument
      })
    )
  })
  it('rejects a plaintext `{ name, tags }` custom (422)', () => {
    assert.throws(
      () =>
        assertEncryptedMetaConforms({
          collectionMetadata: edv,
          custom: { name: 'Hello', tags: { x: 'y' } }
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects an undefined/absent custom (422)', () => {
    assert.throws(
      () =>
        assertEncryptedMetaConforms({
          collectionMetadata: edv,
          custom: undefined
        }),
      EncryptionSchemeMismatchError
    )
  })
  it('rejects a bare JWE (no `jwe` wrapper) custom (422)', () => {
    assert.throws(
      () =>
        assertEncryptedMetaConforms({
          collectionMetadata: edv,
          custom: flattened
        }),
      EncryptionSchemeMismatchError
    )
  })
})
