/**
 * Encryption-enforcement API tests (Vitest): the server's fail-closed structural
 * validation of content AND metadata writes into an encrypted Collection (spec
 * "Encryption Scheme Registry" + "Encrypted Collections"). When a Collection
 * declares a recognized `encryption` scheme (`edv`), a Resource content write
 * MUST be a conforming envelope of that scheme -- media type `application/json`
 * carrying an EDV Encrypted Document (a JSON object whose `jwe` member is a
 * structurally valid JWE) -- and a `PUT /meta` write's `custom` value MUST be
 * the same envelope. A non-conforming write is rejected with
 * `encryption-scheme-mismatch` (422), so neither a buggy client nor a foreign
 * writer can ever land server-visible plaintext in an encrypted Collection. The
 * server validates structure only and never decrypts.
 *
 * These drive the wire contract directly via the signed `pws.request()` escape
 * hatch (raw `HttpResponse` / raw errors), mirroring `encryption-descriptor-api`.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import {
  openTempBackend,
  signedMultipart,
  startTestServer,
  zcapClients
} from './helpers.js'

const JSON_TYPE = 'application/json'
/** A minimal structurally-valid flattened JWE-JSON envelope (the inner `jwe`). */
const jwe = { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
/** The stored representation: an EDV Encrypted Document wrapping the `jwe`. */
const envelope = { id: 'z1', sequence: 0, indexed: [], jwe }

describe('Encryption enforcement API', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any, bob: any
  const spaceId = `enc-enforce-space-${crypto.randomUUID()}`
  const edvCollection = 'vault'
  const plainCollection = 'plain'

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))

    await alice.pws.createSpace({
      id: spaceId,
      name: 'Encryption Enforce Space',
      controller: alice.did
    })
    // An encrypted Collection and a plaintext one, both owned by Alice.
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: edvCollection, name: 'Vault', encryption: { scheme: 'edv' } }
    })
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: plainCollection, name: 'Plain' }
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /** PUTs a raw body with an explicit content type to a Resource by id. */
  function putRaw(options: {
    who?: any
    collectionId: string
    resourceId: string
    body: unknown
    contentType: string
  }): Promise<any> {
    const { who = alice, collectionId, resourceId, body, contentType } = options
    return who.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/${resourceId}`,
      method: 'PUT',
      body: new TextEncoder().encode(
        typeof body === 'string' ? body : JSON.stringify(body)
      ),
      headers: { 'content-type': contentType }
    })
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

  it('accepts a conforming EDV Document on POST (create) into an edv Collection', async () => {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/`,
      method: 'POST',
      body: new TextEncoder().encode(JSON.stringify(envelope)),
      headers: { 'content-type': JSON_TYPE }
    })
    assert.equal(response.status, 201)
  })

  it('accepts a conforming EDV Document on PUT (by id) into an edv Collection', async () => {
    const response = await putRaw({
      collectionId: edvCollection,
      resourceId: 'doc-put',
      body: envelope,
      contentType: JSON_TYPE
    })
    assert.equal(response.status, 201)
  })

  /**
   * PUTs a multipart body whose one file part carries `partType` and
   * `partBody`, signed by Alice, and returns the fetch Response.
   */
  async function putMultipart({
    resourceId,
    partType,
    partBody
  }: {
    resourceId: string
    partType: string
    partBody: string
  }): Promise<Response> {
    return signedMultipart({
      signer: alice.signer,
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/${resourceId}`,
      method: 'PUT',
      partType,
      partBody
    })
  }

  it('accepts a conforming EDV Document as the file part of a multipart PUT', async () => {
    // The check runs on the stored representation (the file part), not on
    // the `multipart/form-data` envelope.
    const response = await putMultipart({
      resourceId: 'doc-multipart',
      partType: JSON_TYPE,
      partBody: JSON.stringify(envelope)
    })
    assert.equal(response.status, 201, await response.text())
  })

  it('rejects a non-conforming file part of a multipart PUT (422)', async () => {
    const response = await putMultipart({
      resourceId: 'doc-multipart-plain',
      partType: JSON_TYPE,
      partBody: JSON.stringify({ hello: 'world' })
    })
    const text = await response.text()
    assert.equal(response.status, 422, text)
    assert.match(JSON.parse(text).type, /#encryption-scheme-mismatch/)
  })

  it('rejects a plaintext JSON body into an edv Collection (422 scheme-mismatch)', async () => {
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${edvCollection}/doc-plain`,
        method: 'PUT',
        json: { hello: 'world' }
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('rejects a bare JWE (no `jwe` wrapper) into an edv Collection (422)', async () => {
    // The B0 fail-closed shape gate: a bare JWE under application/json passes the
    // media-type gate but is not an EDV Document (no `jwe` member) -- 422.
    const err = await rejection(
      putRaw({
        collectionId: edvCollection,
        resourceId: 'doc-bare-jwe',
        body: jwe,
        contentType: JSON_TYPE
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('rejects a wrong content type (octet-stream) into an edv Collection (422)', async () => {
    const err = await rejection(
      putRaw({
        collectionId: edvCollection,
        resourceId: 'doc-binary',
        body: envelope,
        contentType: 'application/octet-stream'
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('rejects the right content type but a non-envelope body (422)', async () => {
    const err = await rejection(
      putRaw({
        collectionId: edvCollection,
        resourceId: 'doc-malformed',
        body: { not: 'an envelope' },
        contentType: JSON_TYPE
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('a plaintext Collection still accepts any body (no enforcement)', async () => {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${plainCollection}/plain-doc`,
      method: 'PUT',
      json: { hello: 'world' }
    })
    assert.equal(response.status, 201)
  })

  it('ordering: an under-authorized writer into an edv Collection gets 404, not 422', async () => {
    // Bob does not control Alice's Space, so his invocation fails verification
    // first. The 422 gate runs only after auth, so he must never observe it (no
    // information leak about the target's encryption state).
    const err = await rejection(
      putRaw({
        who: bob,
        collectionId: edvCollection,
        resourceId: 'doc-bob',
        body: { hello: 'world' },
        contentType: 'application/json'
      })
    )
    assert.equal(err.response.status, 404)
  })

  it('PUT .../meta on an edv Collection rejects a plaintext custom (422)', async () => {
    // Seed a Resource, then attempt a plaintext metadata write -- on an encrypted
    // Collection the `custom` value MUST be an envelope, so a `{ name }` is a 422.
    await putRaw({
      collectionId: edvCollection,
      resourceId: 'doc-meta',
      body: envelope,
      contentType: JSON_TYPE
    })
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${edvCollection}/doc-meta/meta`,
        method: 'PUT',
        json: { custom: { name: 'labeled' } }
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('PUT .../meta on an edv Collection accepts an envelope custom and versions it', async () => {
    // A conforming envelope custom is accepted (204) and carries its own `/meta`
    // ETag (the `/meta` stamp), independent of the content ETag. GET /meta returns
    // the opaque envelope verbatim (no plaintext name leaked).
    const put1 = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/doc-meta/meta`,
      method: 'PUT',
      json: { custom: envelope }
    })
    assert.equal(put1.status, 200)
    const metaEtag1 = put1.headers.get('etag')
    assert.ok(metaEtag1, 'PUT /meta returns a /meta ETag')

    const read = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/doc-meta/meta`,
      method: 'GET'
    })
    assert.equal(read.status, 200)
    assert.deepEqual(read.data.custom, envelope)
    assert.equal(read.headers.get('etag'), metaEtag1)

    // A second meta write moves the /meta ETag.
    const put2 = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/doc-meta/meta`,
      method: 'PUT',
      json: { custom: envelope }
    })
    assert.equal(put2.status, 200)
    assert.notEqual(put2.headers.get('etag'), metaEtag1)
  })

  it('PUT .../meta honors If-Match on the /meta ETag (412 on mismatch)', async () => {
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${edvCollection}/doc-meta/meta`,
        method: 'PUT',
        json: { custom: envelope },
        headers: { 'if-match': '"999"' }
      })
    )
    assert.equal(err.response.status, 412)
  })

  it('a plaintext Collection still accepts a plaintext /meta custom', async () => {
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${plainCollection}/plain-meta`,
      method: 'PUT',
      json: { hello: 'world' }
    })
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${plainCollection}/plain-meta/meta`,
      method: 'PUT',
      json: { custom: { name: 'labeled' } }
    })
    assert.equal(response.status, 200)
  })

  it('PUT the Collection /meta of an edv Collection rejects a plaintext custom (422)', async () => {
    // Collection Metadata takes the same branch as Resource Metadata: on an
    // encrypted Collection its `custom` IS the opaque envelope. `PUT .../meta`
    // is a full replacement and `encryption` is creation-only, so the descriptor
    // must be resent alongside `custom` or the write never reaches the
    // envelope check (it 409s as an attempted clear instead).
    const err = await rejection(
      alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${edvCollection}/meta`,
        method: 'PUT',
        json: {
          encryption: { scheme: 'edv' },
          custom: { name: 'labeled' }
        }
      })
    )
    assert.equal(err.response.status, 422)
    assert.match(err.data.type, /#encryption-scheme-mismatch/)
  })

  it('PUT the Collection /meta of an edv Collection accepts an envelope custom', async () => {
    const put = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/meta`,
      method: 'PUT',
      json: { encryption: { scheme: 'edv' }, custom: envelope }
    })
    assert.equal(put.status, 204)
    const metaEtag = put.headers.get('etag')
    assert.ok(metaEtag, 'PUT the Collection /meta returns a /meta ETag')

    // The envelope is returned verbatim (no plaintext name leaked).
    const read = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/meta`,
      method: 'GET'
    })
    assert.equal(read.status, 200)
    assert.deepEqual(read.data.custom, envelope)
    assert.equal(read.headers.get('etag'), metaEtag)
  })

  it('scope: PUT .../policy on an edv Collection still accepts application/json', async () => {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${edvCollection}/policy`,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
    assert.equal([200, 201, 204].includes(response.status), true)
  })
})
