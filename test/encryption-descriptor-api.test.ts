/**
 * Encryption-descriptor API tests (Vitest): the server's accept / validate /
 * persist / creation-only handling of a Collection's client-side `encryption`
 * descriptor (spec "Encrypted Collections"). The server never decrypts -- it
 * stores the descriptor opaquely, validates only its shape, and refuses an
 * update that adds, changes or clears it.
 *
 * These assert the server's wire contract directly (status codes, problem
 * `type`s, the echoed Metadata object) via the signed `pws.request()` escape hatch
 * (raw `HttpResponse` / raw errors), mirroring `wire-contract-api.test.ts` --
 * the high-level handles hide exactly those details. End-to-end coverage through
 * the high-level client lives in `@interop/pws-client`'s own EDV integration
 * suite and the `@interop/pws-conformance-suite` descriptor test.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('Encryption descriptor API', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  const spaceId = `enc-descriptor-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))

    await alice.pws.createSpace({
      id: spaceId,
      name: 'Encryption Descriptor Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /** Reads a Collection Metadata object over the wire (raw JSON). */
  async function readDesc(collectionId: string): Promise<any> {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    return response.data
  }

  /** Captures the raw error from a `pws.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /** A descriptor recipient entry (the JWE recipients-entry shape). */
  const recipient = (kid: string) => ({
    header: { kid, alg: 'ECDH-ES+A256KW' },
    encrypted_key: `wrapped-${kid}`
  })
  /** A valid two-epoch descriptor, `currentEpoch` = the newest. */
  const twoEpochDescriptor = () => ({
    scheme: 'edv',
    currentEpoch: 'urn:epoch:2',
    epochs: [
      { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp1#ka')] },
      { id: 'urn:epoch:1', recipients: [recipient('did:key:zApp2#ka')] }
    ]
  })

  it('persists and echoes the descriptor on create', async () => {
    const collectionId = 'vault'
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Vault', encryption: { scheme: 'edv' } }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('omits the descriptor for a plaintext collection (no encryption sent)', async () => {
    const collectionId = 'plain'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Plain' }
    })
    assert.equal((await readDesc(collectionId)).encryption, undefined)
  })

  it('preserves unknown extra descriptor fields opaquely (forward-compat)', async () => {
    const collectionId = 'forward'
    const descriptor = { scheme: 'edv', recipients: [{ id: 'k1', type: 'X' }] }
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: descriptor }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(
      (await readDesc(collectionId)).encryption,
      descriptor
    )
  })

  it('rejects a descriptor object without a string scheme (400)', async () => {
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-noscheme', encryption: { foo: 1 } }
      })
    )
    assert.equal(err.response.status, 400)
    // The http-client layer pre-parses the problem+json body onto `err.data`.
    assert.match(err.data.type, /#invalid-request-body/)
    assert.equal(err.data.errors?.[0]?.pointer, '#/encryption')
  })

  it('rejects a non-object descriptor (400)', async () => {
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-string', encryption: 'edv' }
      })
    )
    assert.equal(err.response.status, 400)
  })

  it('rejects an unrecognized scheme on create (400 unsupported-encryption-scheme)', async () => {
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: 'bad-scheme', encryption: { scheme: 'aes-gcm-siv' } }
      })
    )
    assert.equal(err.response.status, 400)
    assert.match(err.data.type, /#unsupported-encryption-scheme/)
    assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/scheme')
  })

  it('refuses declaring a descriptor on an existing plaintext collection (409 encryption-immutable, object unchanged)', async () => {
    // The descriptor is creation-only: an update cannot add one to a
    // Collection created without it.
    const collectionId = 'late-declare'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Late' }
    })
    const before = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: {
          id: collectionId,
          name: 'Late',
          encryption: { scheme: 'edv' }
        }
      })
    )
    assert.equal(err.response.status, 409)
    assert.match(err.data.type, /#encryption-immutable/)
    assert.equal(err.data.errors?.[0]?.pointer, '#/encryption')
    const after = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    assert.equal(after.headers.get('etag'), before.headers.get('etag'))
    assert.deepStrictEqual(after.data, before.data)
    assert.equal(after.data.encryption, undefined)
  })

  it('refuses declaring a descriptor on an existing collection under If-Match (409)', async () => {
    // A current validator does not turn the update into a create.
    const collectionId = 'late-declare-cas'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId }
    })
    const before = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        headers: { 'if-match': before.headers.get('etag') },
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
    )
    assert.equal(err.response.status, 409)
    assert.match(err.data.type, /#encryption-immutable/)
    assert.equal((await readDesc(collectionId)).encryption, undefined)
  })

  it('declares a descriptor on a create by PUT (absent collection, 201)', async () => {
    const collectionId = 'put-create-declare'
    const put = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 201)
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('declares a descriptor on a guarded create by PUT (If-None-Match: *, 201)', async () => {
    const collectionId = 'guarded-create-declare'
    const put = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 201)
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('declares a descriptor on a create by PUT over a Collection tombstone (201)', async () => {
    // A write over a tombstone is a create, so it may declare the descriptor
    // the deleted life lacked.
    const collectionId = 'tombstone-declare'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId }
    })
    const deleted = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/`,
      method: 'DELETE'
    })
    assert.equal(deleted.status, 204)
    const put = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 201)
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('allows re-sending the same descriptor (same -> same is a no-op)', async () => {
    const collectionId = 'idempotent'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    const put = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'PUT',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 204)
  })

  it('rejects changing to an unrecognized scheme (400 unsupported-encryption-scheme, descriptor unchanged)', async () => {
    // With v1 recognizing only `edv`, a scheme *change* names a scheme the
    // server cannot enforce, so the fail-closed `unsupported-encryption-scheme`
    // gate fires first -- before the `encryption-immutable` (409) check,
    // which the direct-transition unit test below still exercises. Either way the
    // stored descriptor cannot be corrupted.
    const collectionId = 'immutable'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, encryption: { scheme: 'other' } }
      })
    )
    assert.equal(err.response.status, 400)
    assert.match(err.data.type, /#unsupported-encryption-scheme/)
    // The stored descriptor is unchanged.
    assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
      scheme: 'edv'
    })
  })

  it('a name-only update omitting encryption is refused (full replacement, 409 encryption-immutable)', async () => {
    const collectionId = 'untouched'
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, encryption: { scheme: 'edv' } }
    })
    // `PUT .../meta` is a full replacement: an omitted `encryption` on an
    // already-encrypted Collection is an attempt to clear it, not a merge, so
    // a name-only rename is refused rather than silently dropping the
    // descriptor.
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, name: 'Renamed' }
      })
    )
    assert.equal(err.response.status, 409)
    assert.match(err.data.type, /#encryption-immutable/)
    const unchanged = await readDesc(collectionId)
    assert.deepStrictEqual(unchanged.encryption, { scheme: 'edv' })

    // The correct pattern under full replacement: resend the stored
    // descriptor alongside the new name.
    const put = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'PUT',
      json: { id: collectionId, name: 'Renamed', encryption: { scheme: 'edv' } }
    })
    assert.equal(put.status, 204)
    const desc = await readDesc(collectionId)
    assert.equal(desc.name, 'Renamed')
    assert.deepStrictEqual(desc.encryption, { scheme: 'edv' })
  })

  describe('scheme version (wire)', () => {
    it('round-trips a descriptor with version 1 verbatim on create', async () => {
      const collectionId = 'versioned'
      const descriptor = { scheme: 'edv', version: 1 }
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: descriptor }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(
        (await readDesc(collectionId)).encryption,
        descriptor
      )
    })

    it('accepts adding an explicit version 1 to a versionless descriptor (absent means 1)', async () => {
      const collectionId = 'version-late'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
      // Spec: re-declaring the standing values -- including an explicit
      // `version: 1` on a descriptor that had omitted it -- is an idempotent
      // no-op that MUST be accepted.
      const put = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, encryption: { scheme: 'edv', version: 1 } }
      })
      assert.equal(put.status, 204)
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
        scheme: 'edv',
        version: 1
      })
    })

    it('rejects removing the version once set (409 encryption-immutable, descriptor unchanged)', async () => {
      const collectionId = 'version-locked'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv', version: 1 } }
      })
      // The only version regression reachable over the wire in v1: a DECREASE
      // needs a stored version >= 2, which the recognition gate (only `edv` 1)
      // never stores -- the lib transition tests cover that path directly.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, encryption: { scheme: 'edv' } }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#encryption-immutable/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/version')
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
        scheme: 'edv',
        version: 1
      })
    })

    it('rejects an unrecognized version on create (400 unsupported-encryption-scheme)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/`,
          method: 'POST',
          json: { id: 'bad-version', encryption: { scheme: 'edv', version: 2 } }
        })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#unsupported-encryption-scheme/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/version')
    })

    it('rejects raising to an unrecognized version on update (400, not 409; descriptor unchanged)', async () => {
      const collectionId = 'version-raise'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv', version: 1 } }
      })
      // Raising is permitted by the transition rail (never `encryption-immutable`)
      // but subject to the recognition gate, which fires first here since the
      // registry recognizes only `edv` version 1.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, encryption: { scheme: 'edv', version: 2 } }
        })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#unsupported-encryption-scheme/)
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, {
        scheme: 'edv',
        version: 1
      })
    })
  })

  describe('key-epoch descriptor validation', () => {
    it('accepts a valid multi-epoch descriptor and round-trips it verbatim on GET', async () => {
      const collectionId = 'epochs-ok'
      const descriptor = twoEpochDescriptor()
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: descriptor }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(
        (await readDesc(collectionId)).encryption,
        descriptor
      )
    })

    it('rejects a malformed recipient entry (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-badrecip',
            encryption: {
              scheme: 'edv',
              currentEpoch: 'urn:epoch:1',
              epochs: [{ id: 'urn:epoch:1', recipients: [{ foo: 1 }] }]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.match(err.data.type, /#invalid-request-body/)
    })

    it('rejects `epochs` without `currentEpoch` (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-nocurrent',
            encryption: {
              scheme: 'edv',
              epochs: [
                { id: 'urn:epoch:1', recipients: [recipient('did:key:z#ka')] }
              ]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects `currentEpoch` without `epochs` (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-noepochs',
            encryption: { scheme: 'edv', currentEpoch: 'urn:epoch:1' }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects a dangling `currentEpoch` (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/`,
          method: 'POST',
          json: {
            id: 'epochs-dangling',
            encryption: {
              scheme: 'edv',
              currentEpoch: 'urn:epoch:missing',
              epochs: [
                { id: 'urn:epoch:1', recipients: [recipient('did:key:z#ka')] }
              ]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/currentEpoch')
    })

    it('rejects dropping an epoch on update (400 append-only)', async () => {
      const collectionId = 'epochs-drop'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochDescriptor() }
      })
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: {
            id: collectionId,
            encryption: {
              scheme: 'edv',
              currentEpoch: 'urn:epoch:2',
              epochs: [
                {
                  id: 'urn:epoch:2',
                  recipients: [recipient('did:key:zApp1#ka')]
                }
              ]
            }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects moving `currentEpoch` back to an older epoch on update (400)', async () => {
      const collectionId = 'epochs-rollback'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochDescriptor() }
      })
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: {
            id: collectionId,
            encryption: { ...twoEpochDescriptor(), currentEpoch: 'urn:epoch:1' }
          }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('allows appending an epoch + repointing `currentEpoch` (204)', async () => {
      const collectionId = 'epochs-append'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochDescriptor() }
      })
      const grown = {
        scheme: 'edv',
        currentEpoch: 'urn:epoch:3',
        epochs: [
          { id: 'urn:epoch:3', recipients: [recipient('did:key:zApp1#ka')] },
          ...twoEpochDescriptor().epochs
        ]
      }
      const put = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, encryption: grown }
      })
      assert.equal(put.status, 204)
      assert.deepStrictEqual((await readDesc(collectionId)).encryption, grown)
    })

    it('allows adding a recipient to an existing epoch (204)', async () => {
      const collectionId = 'epochs-addrecip'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: twoEpochDescriptor() }
      })
      const withNewRecipient = {
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
          twoEpochDescriptor().epochs[1]
        ]
      }
      const put = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, encryption: withNewRecipient }
      })
      assert.equal(put.status, 204)
    })
  })

  describe('blinding-key (`hmac`) descriptor validation', () => {
    /** A valid descriptor carrying a blinding-key `hmac` member. */
    const hmacDescriptor = () => ({
      scheme: 'edv',
      hmac: {
        id: 'urn:uuid:blinding-key-1',
        type: 'Sha256HmacKey2019',
        recipients: [recipient('did:key:zApp1#ka')]
      }
    })

    /** Creates a Collection carrying `hmacDescriptor()`. */
    async function createWithHmac(collectionId: string): Promise<void> {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: hmacDescriptor() }
      })
      assert.equal(response.status, 201)
    }

    it('accepts a valid hmac and round-trips it verbatim on GET', async () => {
      await createWithHmac('hmac-ok')
      assert.deepStrictEqual(
        (await readDesc('hmac-ok')).encryption,
        hmacDescriptor()
      )
    })

    const malformed: [string, unknown, string][] = [
      ['missing-id', { type: 'T', recipients: [recipient('k')] }, '/id'],
      ['missing-type', { id: 'urn:k', recipients: [recipient('k')] }, '/type'],
      [
        'empty-recipients',
        { id: 'urn:k', type: 'T', recipients: [] },
        '/recipients'
      ],
      [
        'bad-recipient-entry',
        { id: 'urn:k', type: 'T', recipients: [{ foo: 1 }] },
        '/recipients/0'
      ]
    ]
    for (const [label, hmac, pointerSuffix] of malformed) {
      it(`rejects hmac with ${label} (400 invalid-request-body)`, async () => {
        const err = await rejection(
          alice.pws.request({
            url: `${baseServerUrl}space/${spaceId}/`,
            method: 'POST',
            json: {
              id: `hmac-bad-${label}`,
              encryption: { scheme: 'edv', hmac }
            }
          })
        )
        assert.equal(err.response.status, 400)
        assert.match(err.data.type, /#invalid-request-body/)
        assert.equal(
          err.data.errors?.[0]?.pointer,
          `#/encryption/hmac${pointerSuffix}`
        )
      })
    }

    it('rejects changing hmac.id on update (409 encryption-immutable, descriptor unchanged)', async () => {
      const collectionId = 'hmac-id-change'
      await createWithHmac(collectionId)
      const changed = hmacDescriptor()
      changed.hmac.id = 'urn:uuid:blinding-key-2'
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, encryption: changed }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#encryption-immutable/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/hmac/id')
      assert.deepStrictEqual(
        (await readDesc(collectionId)).encryption,
        hmacDescriptor()
      )
    })

    it('rejects removing hmac on update (409 encryption-immutable, descriptor unchanged)', async () => {
      const collectionId = 'hmac-remove'
      await createWithHmac(collectionId)
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, encryption: { scheme: 'edv' } }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#encryption-immutable/)
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/hmac')
      assert.deepStrictEqual(
        (await readDesc(collectionId)).encryption,
        hmacDescriptor()
      )
    })

    it('allows changing hmac.recipients on update (204)', async () => {
      const collectionId = 'hmac-recipients'
      await createWithHmac(collectionId)
      const rewrapped = hmacDescriptor()
      rewrapped.hmac.recipients = [
        recipient('did:key:zApp1#ka'),
        recipient('did:key:zApp3#ka')
      ]
      const put = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, encryption: rewrapped }
      })
      assert.equal(put.status, 204)
      assert.deepStrictEqual(
        (await readDesc(collectionId)).encryption,
        rewrapped
      )
    })

    it('allows introducing hmac on a stored descriptor that lacks it (204)', async () => {
      const collectionId = 'hmac-late'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
      const put = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, encryption: hmacDescriptor() }
      })
      assert.equal(put.status, 204)
      assert.deepStrictEqual(
        (await readDesc(collectionId)).encryption,
        hmacDescriptor()
      )
    })
  })

  describe('key-epoch stamping (Key-Epoch header + /meta epoch)', () => {
    const collectionId = 'epoch-stamp'
    const resUrl = (rid: string) =>
      `${baseServerUrl}space/${spaceId}/${collectionId}/${rid}`
    const metaOf = async (rid: string) =>
      (
        await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/${rid}/meta`,
          method: 'GET'
        })
      ).data

    it('stamps the declared epoch and round-trips it through /meta, listing, and the changes feed', async () => {
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Epoch Stamp' }
      })
      const put = await alice.pws.request({
        url: resUrl('r1'),
        method: 'PUT',
        json: { id: 'r1', hello: 'world' },
        headers: { 'key-epoch': 'urn:epoch:1' }
      })
      assert.equal(put.status, 201)

      assert.equal((await metaOf('r1')).epoch, 'urn:epoch:1')

      const listing = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/`,
        method: 'GET'
      })
      const item = listing.data.items.find((entry: any) => entry.id === 'r1')
      assert.equal(item.epoch, 'urn:epoch:1')

      const changes = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      const doc = changes.data.documents.find((entry: any) => entry.id === 'r1')
      assert.equal(doc.epoch, 'urn:epoch:1')
    })

    it('PUT /meta with `epoch` sets it; without preserves it', async () => {
      // Supplying `epoch` replaces the stamp.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/r1/meta`,
        method: 'PUT',
        json: { custom: {}, epoch: 'urn:epoch:2' }
      })
      assert.equal((await metaOf('r1')).epoch, 'urn:epoch:2')
      // Omitting `epoch` preserves the stored value (unlike `custom`).
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/r1/meta`,
        method: 'PUT',
        json: { custom: { name: 'x' } }
      })
      assert.equal((await metaOf('r1')).epoch, 'urn:epoch:2')
    })

    it('a content rewrite WITHOUT the header clears the stamp', async () => {
      await alice.pws.request({
        url: resUrl('r1'),
        method: 'PUT',
        json: { id: 'r1', hello: 'again' }
      })
      assert.equal((await metaOf('r1')).epoch, undefined)
    })

    it('rejects an empty Key-Epoch header (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: resUrl('r-bad'),
          method: 'PUT',
          json: { id: 'r-bad' },
          headers: { 'key-epoch': '' }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('rejects a non-string / empty `epoch` in a /meta body (400)', async () => {
      await alice.pws.request({
        url: resUrl('r2'),
        method: 'PUT',
        json: { id: 'r2' }
      })
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/r2/meta`,
          method: 'PUT',
          json: { custom: {}, epoch: 123 }
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.errors?.[0]?.pointer, '/epoch')
    })
  })

  describe('writer-attribution (Writer-Id header)', () => {
    const collectionId = 'writer-id-stamp'
    const resUrl = (rid: string) =>
      `${baseServerUrl}space/${spaceId}/${collectionId}/${rid}`
    const metaOf = async (rid: string) =>
      (
        await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/${rid}/meta`,
          method: 'GET'
        })
      ).data

    it('stamps the declared label and round-trips it through /meta, listing, and the changes feed', async () => {
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Writer-Id Stamp' }
      })
      const put = await alice.pws.request({
        url: resUrl('r1'),
        method: 'PUT',
        json: { id: 'r1', hello: 'world' },
        headers: { 'writer-id': 'writer-1' }
      })
      assert.equal(put.status, 201)

      assert.equal((await metaOf('r1')).writerId, 'writer-1')

      const listing = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/`,
        method: 'GET'
      })
      const item = listing.data.items.find((entry: any) => entry.id === 'r1')
      assert.equal(item.writerId, 'writer-1')

      const changes = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      const doc = changes.data.documents.find((entry: any) => entry.id === 'r1')
      assert.equal(doc.writerId, 'writer-1')
    })

    it('a content rewrite WITHOUT the header clears the stamp', async () => {
      await alice.pws.request({
        url: resUrl('r1'),
        method: 'PUT',
        json: { id: 'r1', hello: 'again' }
      })
      assert.equal((await metaOf('r1')).writerId, undefined)
    })

    it('PUT /meta leaves the writerId untouched, and ignores a `writerId` member in its body', async () => {
      await alice.pws.request({
        url: resUrl('r2'),
        method: 'PUT',
        json: { id: 'r2' },
        headers: { 'writer-id': 'writer-2' }
      })
      assert.equal((await metaOf('r2')).writerId, 'writer-2')
      // A body `writerId` is ignored: neither set, validated, nor stored.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/r2/meta`,
        method: 'PUT',
        json: { custom: {}, writerId: 'writer-other' }
      })
      assert.equal((await metaOf('r2')).writerId, 'writer-2')
      // A metadata write without one leaves the label as well.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/r2/meta`,
        method: 'PUT',
        json: { custom: { name: 'x' } }
      })
      assert.equal((await metaOf('r2')).writerId, 'writer-2')
    })

    it('DELETE with a Writer-Id header labels the tombstone; the label rides the changes feed', async () => {
      await alice.pws.request({
        url: resUrl('r-del'),
        method: 'PUT',
        json: { id: 'r-del' },
        headers: { 'writer-id': 'writer-live' }
      })
      const del = await alice.pws.request({
        url: resUrl('r-del'),
        method: 'DELETE',
        headers: { 'writer-id': 'writer-deleter' }
      })
      assert.equal(del.status, 204)

      const changes = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      const tomb = changes.data.documents.find(
        (entry: any) => entry.id === 'r-del'
      )
      assert.equal(tomb.kind, 'resource')
      assert.equal(tomb.deleted, true)
      assert.equal('_deleted' in tomb, false)
      assert.equal(
        tomb.writerId,
        'writer-deleter',
        'the tombstone carries the label the DELETE itself declared, not the prior content-write label'
      )
    })

    it('rejects an empty Writer-Id header (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: resUrl('r-bad'),
          method: 'PUT',
          json: { id: 'r-bad' },
          headers: { 'writer-id': '' }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('does not validate a non-string / empty `writerId` in a /meta body', async () => {
      await alice.pws.request({
        url: resUrl('r3'),
        method: 'PUT',
        json: { id: 'r3' }
      })
      for (const writerId of [123, '']) {
        const response = await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/r3/meta`,
          method: 'PUT',
          json: { custom: {}, writerId }
        })
        assert.equal(response.status, 200)
      }
      assert.equal((await metaOf('r3')).writerId, undefined)
    })
  })

  describe('Collection Metadata object conditional writes (ETag / If-Match)', () => {
    it('GET returns an ETag; matching If-Match bumps it; stale If-Match 412s', async () => {
      const collectionId = 'cas-col'
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'CAS' }
      })
      assert.equal(created.status, 201)

      const got = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'GET'
      })
      const etag = got.headers.get('etag')
      assert.ok(etag, 'GET Collection surfaces an ETag')

      const updated = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, name: 'CAS updated' },
        headers: { 'if-match': etag! }
      })
      assert.equal(updated.status, 204)
      const newEtag = updated.headers.get('etag')
      assert.notEqual(newEtag, etag)

      // The original (now stale) validator is rejected -- the lost-update guard.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, name: 'CAS conflict' },
          headers: { 'if-match': etag! }
        })
      )
      assert.equal(err.response.status, 412)
      assert.match(err.data.type, /#precondition-failed/)
    })

    it('an unconditional PUT still works (no If-Match)', async () => {
      const collectionId = 'cas-uncond'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Uncond' }
      })
      const put = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, name: 'Uncond updated' }
      })
      assert.equal(put.status, 204)
      assert.ok(put.headers.get('etag'))
    })

    it('two sequential updates: the second reusing the first stale ETag 412s', async () => {
      const collectionId = 'cas-sequential'
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: 'Seq' }
      })
      const etag0 = created.headers.get('etag')!
      // First update with the create ETag succeeds.
      const first = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
        method: 'PUT',
        json: { id: collectionId, name: 'Seq 1' },
        headers: { 'if-match': etag0 }
      })
      assert.equal(first.status, 204)
      // Second update reusing the now-stale etag0 loses.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, name: 'Seq 2' },
          headers: { 'if-match': etag0 }
        })
      )
      assert.equal(err.response.status, 412)
    })
  })
})
