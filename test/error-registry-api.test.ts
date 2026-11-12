/**
 * Error-registry wire-coverage stragglers (Vitest): the error classes in
 * `src/errors.ts` that would otherwise have no wire-level regression guard --
 * `EncryptionImmutableError` (409), `InvalidCollectionError` (400) and
 * `MethodNotAllowedError` (405). These assert the server's wire contract
 * directly (status codes, problem `type`s, headers) via the signed
 * `pws.request()` escape hatch (raw `HttpResponse` / raw errors), mirroring
 * `wire-contract-api.test.ts`.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('Error registry wire coverage', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  const spaceId = `error-registry-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))

    // Provisioned over the wire: the high-level handles still speak the
    // pre-v0.5 table.
    await alice.pws.request({
      url: `${baseServerUrl}spaces/`,
      method: 'POST',
      json: { id: spaceId, name: 'Error Registry Space', controller: alice.did }
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /** Captures the raw error from a `pws.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /** Reads a Collection Metadata object over the wire (raw JSON). */
  async function readMeta(collectionId: string): Promise<any> {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    return response.data
  }

  describe('EncryptionImmutableError (409)', () => {
    // The scheme-CHANGE path cannot reach the 409 over the wire: an update's
    // descriptor must first pass `assertSupportedEncryption`, whose
    // fail-closed gate rejects any `scheme` not in
    // `SUPPORTED_ENCRYPTION_SCHEMES` with `unsupported-encryption-scheme`
    // (400), and v1 registers exactly one scheme (`edv`). Pin that masking
    // shape, plus proof the stored descriptor is not corrupted.
    it('scheme change masked by unsupported-encryption-scheme (400), descriptor intact', async () => {
      const collectionId = 'immutable-wire'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, encryption: { scheme: 'aes-gcm-siv' } }
        })
      )
      // The fail-closed scheme gate fires before the `encryption-immutable` 409 check.
      assert.equal(err.response.status, 400)
      assert.equal(
        err.data.type,
        'https://w3id.org/pws#unsupported-encryption-scheme'
      )
      assert.equal(err.data.errors?.[0]?.pointer, '#/encryption/scheme')
      // The stored descriptor is unchanged -- the 409's invariant still holds.
      assert.deepStrictEqual((await readMeta(collectionId)).encryption, {
        scheme: 'edv'
      })
    })

    // The descriptor-CLEAR path is reachable since v0.5: the merged
    // `PUT .../meta` is a full replacement, so a body that omits `encryption`
    // on an encrypted Collection is an attempt to clear the creation-only
    // descriptor (spec "Update Collection": `encryption-immutable`).
    it('omitting `encryption` on an encrypted Collection is encryption-immutable (409)', async () => {
      const collectionId = 'immutable-clear-wire'
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/${collectionId}/meta`,
          method: 'PUT',
          json: { id: collectionId, name: 'Now plaintext?' }
        })
      )
      assert.equal(err.response.status, 409)
      assert.equal(err.data.type, 'https://w3id.org/pws#encryption-immutable')
      assert.deepStrictEqual((await readMeta(collectionId)).encryption, {
        scheme: 'edv'
      })
    })
  })

  describe('MethodNotAllowedError (405)', () => {
    // A container's description is written at its `meta` sub-resource, so
    // `PUT` is not defined at the container URL itself (spec "Space Metadata
    // Data Model" / "Collection Metadata Data Model": SHOULD answer 405).
    for (const path of [`/space/${spaceId}/`, `/space/${spaceId}/some-id/`]) {
      it(`PUT ${path.replace(spaceId, ':spaceId')} is 405 with an Allow header`, async () => {
        const err = await rejection(
          alice.pws.request({
            url: new URL(path, baseServerUrl).href,
            method: 'PUT',
            json: { name: 'x' }
          })
        )
        assert.equal(err.response.status, 405)
        assert.equal(
          err.response.headers.get('allow'),
          'GET, HEAD, POST, DELETE'
        )
        assert.match(
          err.response.headers.get('content-type'),
          /application\/problem\+json/
        )
        assert.equal(err.data.type, 'about:blank')
        // With `type: about:blank` the title is the status phrase itself
        // (RFC 9457 section 4.2.1); the refusing URL is named in the detail.
        assert.equal(err.data.title, 'Method Not Allowed')
        assert.match(
          err.data.errors[0].detail,
          /^The method is not defined at this URL\./
        )
      })
    }

    // There is no `DELETE` at a container's Metadata URL (spec "Lifecycle":
    // deleting the container removes its Metadata object with it). Registered
    // explicitly so the refusal is about the method: without it the request
    // falls through to the parametric route one level up, whose reserved-id
    // guard answers the unrelated `409 reserved-id`.
    for (const path of [
      `/space/${spaceId}/meta`,
      `/space/${spaceId}/some-id/meta`
    ]) {
      it(`DELETE ${path.replace(spaceId, ':spaceId')} is 405 with an Allow header`, async () => {
        const err = await rejection(
          alice.pws.request({
            url: new URL(path, baseServerUrl).href,
            method: 'DELETE'
          })
        )
        assert.equal(err.response.status, 405)
        assert.equal(err.response.headers.get('allow'), 'GET, HEAD, PUT')
        assert.match(
          err.response.headers.get('content-type'),
          /application\/problem\+json/
        )
        assert.equal(err.data.type, 'about:blank')
        assert.equal(err.data.title, 'Method Not Allowed')
        assert.match(
          err.data.errors[0].detail,
          /^The method is not defined at this URL\./
        )
        // The detail names where the operation lives instead, and says
        // nothing about the `meta` sub-resource of a container -- that is the
        // container-`PUT` refusal's sentence, not this one's.
        assert.match(
          err.data.errors[0].detail,
          /removed by deleting the container it describes/
        )
      })
    }

    // Every reserved endpoint (spec "Methods at Reserved Endpoints") refuses
    // a method it does not implement with a 405 naming what it does, at all
    // three levels. Without the refusal these fell through to a Collection or
    // Resource operation on the reserved segment as an id, answering a
    // `409 reserved-id`. The Collection `c` and Resource `r` need not exist:
    // the refusal reads no ids.
    const refusals: { method: string; path: string; allow: string }[] = [
      { method: 'DELETE', path: '/space/:s/linkset', allow: 'GET, HEAD' },
      { method: 'GET', path: '/space/:s/export', allow: 'POST' },
      { method: 'PUT', path: '/space/:s/quotas', allow: 'GET, HEAD' },
      {
        method: 'DELETE',
        path: '/space/:s/collections',
        allow: 'GET, HEAD, POST'
      },
      {
        method: 'PATCH',
        path: '/space/:s/policy',
        allow: 'GET, HEAD, PUT, DELETE'
      },
      { method: 'PUT', path: '/space/:s/c/quota', allow: 'GET, HEAD' },
      { method: 'PUT', path: '/space/:s/c/query', allow: 'GET, HEAD, POST' },
      { method: 'PUT', path: '/space/:s/replicas', allow: 'GET, HEAD, POST' },
      { method: 'DELETE', path: '/space/:s/c/backend', allow: 'GET, HEAD' },
      {
        method: 'DELETE',
        path: '/space/:s/c/meta/log',
        allow: 'GET, HEAD, PUT'
      },
      { method: 'POST', path: '/space/:s/c/r/meta', allow: 'GET, HEAD, PUT' },
      { method: 'DELETE', path: '/space/:s/c/r/chunks/', allow: 'GET, HEAD' },
      // One of each new refusal shape; the full table is in
      // method-refusals-api.test.ts.
      { method: 'PATCH', path: '/space/:s/', allow: 'GET, HEAD, POST, DELETE' },
      { method: 'GET', path: '/space/:s/zcaps/revocations/x', allow: 'POST' }
    ]
    for (const { method, path, allow } of refusals) {
      it(`${method} ${path} is 405 with Allow: ${allow}`, async () => {
        const err = await rejection(
          alice.pws.request({
            url: new URL(path.replace(':s', spaceId), baseServerUrl).href,
            method,
            ...(['PUT', 'POST', 'PATCH'].includes(method) && { json: {} })
          })
        )
        assert.equal(err.response.status, 405)
        assert.equal(err.response.headers.get('allow'), allow)
        assert.equal(err.data.type, 'about:blank')
        assert.equal(err.data.title, 'Method Not Allowed')
      })
    }

    it('answers the same 405 whether or not the Space exists', async () => {
      // The refusal must reveal nothing the not-found rule protects, so an
      // unknown Space gets exactly the answer a real one does.
      const answers = []
      for (const id of [spaceId, `absent-${crypto.randomUUID()}`]) {
        const err = await rejection(
          alice.pws.request({
            url: `${baseServerUrl}space/${id}/linkset`,
            method: 'DELETE'
          })
        )
        answers.push({
          status: err.response.status,
          allow: err.response.headers.get('allow'),
          body: err.data
        })
      }
      assert.equal(answers[0]!.status, 405)
      assert.deepStrictEqual(answers[1], answers[0])
    })

    it('a reserved endpoint serving no methods sends an empty Allow', async () => {
      // `/space/:s/query` is anchored for cross-collection queries, which this
      // server does not serve. RFC 9110 allows an empty `Allow`.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/query`,
          method: 'POST',
          json: {}
        })
      )
      assert.equal(err.response.status, 405)
      assert.equal(err.response.headers.get('allow'), '')
      assert.match(
        err.data.errors[0].detail,
        /No methods are allowed at this URL\.$/
      )
    })

    it('a HEAD at a reserved endpoint refusing GET is 405 too', async () => {
      // Fastify exposes a HEAD beside every GET, the refusal included.
      const response = await fetch(`${baseServerUrl}space/${spaceId}/export`, {
        method: 'HEAD'
      })
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'POST')
    })

    it('leaves the CORS preflight at a reserved endpoint alone', async () => {
      const response = await fetch(`${baseServerUrl}space/${spaceId}/linkset`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Method': 'DELETE'
        }
      })
      assert.equal(response.status, 204)
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
    })
  })

  describe('InvalidCollectionError (400)', () => {
    // `InvalidCollectionError` is thrown at `CollectionRequest.putMeta` when
    // the Update (or Create By Id) Collection request has no body. A signed,
    // bodyless PUT (no Content-Type, so the digest hooks pass through) reaches
    // the handler and trips the `if (!body)` guard -- a plain wire-reachable
    // `invalid-request-body` (400).
    it('a bodyless PUT to a Collection Metadata object yields invalid-request-body (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/no-body-collection/meta`,
          method: 'PUT'
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.type, 'https://w3id.org/pws#invalid-request-body')
      assert.equal(err.data.title, 'Invalid Collection Metadata body')
    })

    it('a JSON `null` body PUT to a Collection Metadata object yields invalid-request-body (400)', async () => {
      // A parsed body of `null` is also falsy, so the same guard fires -- this
      // covers the bodied (signed `Digest`) path to the error in addition to
      // the bodyless one above.
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/null-body-collection/meta`,
          method: 'PUT',
          json: null
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.type, 'https://w3id.org/pws#invalid-request-body')
      assert.equal(err.data.title, 'Invalid Collection Metadata body')
    })

    // Create Collection takes the same Metadata object, so a bodyless POST to
    // the Space is refused the same way. The smallest valid body is `{}`.
    it('a bodyless POST to a Space yields invalid-request-body (400)', async () => {
      const err = await rejection(
        alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/`,
          method: 'POST'
        })
      )
      assert.equal(err.response.status, 400)
      assert.equal(err.data.type, 'https://w3id.org/pws#invalid-request-body')
      assert.equal(err.data.title, 'Invalid Create Collection body')
    })
  })
})
