/**
 * Resource API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import { NotFoundError } from '@interop/pws-client'
import type { Space, Collection } from '@interop/pws-client'

import {
  assertEtagAdvanced,
  parseEtagSegments,
  etagGeneration,
  openTempBackend,
  responseOf,
  signedMultipart,
  splitResourceMetaEtag,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Resource API', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    bob: any,
    aliceSpace: Space,
    aliceCredentials: Collection

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))

    // Provision the Space and 'credentials' Collection this suite operates on.
    // This suite uses its own temp dataDir, so these must be created here
    // rather than relying on filesystem state left behind by other test files.
    aliceSpace = await alice.pws.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    aliceCredentials = await aliceSpace.createCollection({
      id: 'credentials',
      name: 'Verifiable Credentials'
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('GET a resource with no auth headers falls through to policy and 404s (no public policy)', async () => {
    // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
    // and is denied as 404 (no-leak) when no access-control policy grants it.
    const response = await fetch(
      new URL('/space/any-space-id/any-collection/any-resource', baseServerUrl),
      {
        method: 'GET'
      }
    )
    assert.equal(response.status, 404)
    assert.match(
      response.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  // TODO: make sure all iterations return ResourceNotFound error
  it('GET resource in a not-found space returns null (404 conflation)', async () => {
    const fetched = await alice.pws
      .space('space-id-that-does-not-exist')
      .collection('unknown-collection')
      .get('unknown-resource')
    assert.equal(fetched, null)
  })

  it('[root] POST (add) and GET Resource with proper authorization', async () => {
    // First, create the Resource (server-generated id).
    const result = await aliceCredentials.add({
      id: 'sample-resource',
      name: 'Sample Verifiable Credential'
    })
    assert.ok(result.id)
    assert.match(result.contentType!, /application\/json/)
    assert.ok(
      result.url.startsWith(
        `${baseServerUrl}space/${alice.space1.id}/credentials/`
      )
    )

    // Next, GET the created resource (auto-parsed to an object).
    const fetched = (await aliceCredentials.get(result.id)) as any
    assert.equal(fetched.name, 'Sample Verifiable Credential')
  })

  it('[root] POST (add) and GET a non-JSON resource', async () => {
    const blob = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
    const result = await aliceCredentials.add(blob)

    // GET returns a Blob for non-JSON content.
    const fetched = await aliceCredentials.get(result.id)
    assert.ok(fetched instanceof Blob)
    assert.equal(await fetched.text(), 'line 1\nline2\n')
  })

  it('[root] a text/plain body with multi-byte / astral characters round-trips byte-for-byte', async () => {
    // A `text/plain` body arrives at the server parsed as a string. It must be
    // written as its UTF-8 bytes, not iterated per UTF-16 code unit (which would
    // split astral-plane characters into lone surrogates and corrupt the bytes).
    const text = 'café — 𐐷 — 😀 ✅'
    const result = await aliceCredentials.add(
      new Blob([text], { type: 'text/plain' })
    )

    const fetched = await aliceCredentials.get(result.id)
    assert.ok(fetched instanceof Blob)
    assert.equal(await fetched.text(), text)
    // The stored size is the UTF-8 byte length, not the string length.
    assert.equal(
      (await fetched.arrayBuffer()).byteLength,
      new TextEncoder().encode(text).length
    )
  })

  it('[root] PUT and GET Resource', async () => {
    const resourceId = 'put-resource'
    await aliceCredentials.put(resourceId, {
      id: resourceId,
      name: 'PUT Resource Test'
    })

    const fetched = (await aliceCredentials.get(resourceId)) as any
    assert.equal(fetched.name, 'PUT Resource Test')
  })

  it('[root] PUT and GET an application/edv+json (structured-suffix JSON) resource', async () => {
    // Structured-suffix JSON media types (e.g. `application/edv+json` for
    // EDV-over-PWS encrypted documents) must be accepted as JSON, not rejected
    // with a 415. Send raw bytes with an explicit content type so the server's
    // `application/<suffix>+json` parser is exercised.
    const resourceId = 'edv-doc'
    const envelope = {
      id: resourceId,
      sequence: 0,
      jwe: { ciphertext: 'AAAA' }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(envelope))
    await aliceCredentials.put(resourceId, bytes, {
      contentType: 'application/edv+json'
    })

    const fetched = (await aliceCredentials.get(resourceId)) as any
    assert.equal(fetched.jwe.ciphertext, 'AAAA')

    // The structured-suffix content type is preserved on read.
    const meta = await aliceCredentials.resource(resourceId).meta()
    assert.match(meta!.contentType!, /application\/edv\+json/)
  })

  it('[root] PUT Resource to non-existent collection should fail (NotFoundError)', async () => {
    // Writing into a missing collection is a write -- PWS does not auto-create
    // parents, so it surfaces as NotFoundError (server 404).
    await assert.rejects(
      aliceSpace
        .collection('collection-does-not-exist')
        .put('some-resource', { name: 'test' }),
      (err: unknown) => err instanceof NotFoundError
    )
  })

  it('[root] PUT Resource should update existing resource (upsert)', async () => {
    const resourceId = 'upsert-resource'

    // Initial PUT
    await aliceCredentials.put(resourceId, {
      id: resourceId,
      name: 'Original Name'
    })

    // Second PUT with updated content
    await aliceCredentials.put(resourceId, {
      id: resourceId,
      name: 'Updated Name'
    })

    // GET should reflect the updated content
    const fetched = (await aliceCredentials.get(resourceId)) as any
    assert.equal(fetched.name, 'Updated Name')
  })

  it("[root] Bob should not be able to GET Alice's resources", async () => {
    // First, Alice creates a resource
    const result = await aliceCredentials.add({
      id: 'alice-private-resource',
      name: 'Alice Private Resource'
    })

    // Bob reads via his own client and gets null (404 conflated: not-found vs
    // unauthorized), so the resource's existence is not revealed.
    const seenByBob = await bob.pws
      .space(alice.space1.id)
      .collection('credentials')
      .get(result.id)
    assert.equal(seenByBob, null)

    // Clean up the created resource
    await aliceCredentials.resource(result.id).delete()
  })

  it('[root] POST (add) and DELETE Resource with proper authorization', async () => {
    // First, create the Resource
    const result = await aliceCredentials.add({
      id: 'sample-resource-to-delete',
      name: 'Sample Delete'
    })
    assert.match(result.contentType!, /application\/json/)

    // Next, GET the created resource (to check it was created)
    assert.notEqual(await aliceCredentials.get(result.id), null)

    // Delete the resource via its handle
    await aliceCredentials.resource(result.id).delete()

    // Finally, check that it was deleted (reads return null on 404).
    assert.equal(await aliceCredentials.get(result.id), null)
  })

  it('[un-authorized!] Read a public Resource by acl policy', async () => {
    // A genuinely unauthenticated read (a bare `fetch`, no signature) of a
    // Resource made public via the PublicCanRead policy: the read is served by
    // the policy fallback, not by capability verification.
    const publicCollection = await aliceSpace.createCollection({
      id: 'public-collection',
      name: 'Public Collection'
    })
    await publicCollection.put('public-vc', {
      id: 'public-vc',
      name: 'A shared Verifiable Credential'
    })

    const resourceUrl = `${baseServerUrl}space/${alice.space1.id}/public-collection/public-vc`

    // Before any policy: the anonymous read is denied (404, no leak).
    const beforeResponse = await fetch(new URL(resourceUrl))
    assert.equal(beforeResponse.status, 404)

    await publicCollection.setPublic()

    // With PublicCanRead: the same unauthenticated GET now succeeds and returns
    // the Resource body.
    const response = await fetch(new URL(resourceUrl))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { name: string }
    assert.equal(body.name, 'A shared Verifiable Credential')
  })

  describe('HEAD Resource', () => {
    it('[signed] HEAD a binary resource returns its content-type + content-length, no body', async () => {
      // 'line 1\nline2\n' is exactly 13 bytes.
      const blob = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
      const result = await aliceCredentials.add(blob)

      const response = await alice.pws.request({
        url: result.url,
        method: 'HEAD'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /text\/plain/)
      assert.equal(response.headers.get('content-length'), '13')
      // HEAD carries no body.
      assert.equal(await response.text(), '')
    })

    it('anonymous HEAD of a private resource 404s (conflation, no leak)', async () => {
      const resourceId = 'head-private'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'Private'
      })

      const resourceUrl = `${baseServerUrl}space/${alice.space1.id}/credentials/${resourceId}`
      const response = await fetch(new URL(resourceUrl), { method: 'HEAD' })
      assert.equal(response.status, 404)
    })

    it('anonymous HEAD in a PublicCanRead collection returns headers matching a GET', async () => {
      const publicCollection = await aliceSpace.createCollection({
        id: 'head-public',
        name: 'Head Public Collection'
      })
      await publicCollection.put('readme', { id: 'readme', name: 'Read Me' })
      await publicCollection.setPublic()

      const resourceUrl = `${baseServerUrl}space/${alice.space1.id}/head-public/readme`

      // The HEAD Content-Length must equal the exact byte length a GET returns,
      // and the Content-Type must equal the GET's (spec "Content Types and
      // Representations": both correspond to the Metadata `size`/`contentType`).
      const getResponse = await fetch(new URL(resourceUrl))
      const getBytes = await getResponse.arrayBuffer()

      const headResponse = await fetch(new URL(resourceUrl), { method: 'HEAD' })
      assert.equal(headResponse.status, 200)
      assert.equal(
        headResponse.headers.get('content-type'),
        getResponse.headers.get('content-type')
      )
      assert.equal(
        headResponse.headers.get('content-length'),
        String(getBytes.byteLength)
      )
      assert.equal(await headResponse.text(), '')
    })
  })

  describe('Resource Metadata (/meta)', () => {
    // Build the absolute `/meta` URL for a credentials-collection resource.
    const metaUrl = (resourceId: string) =>
      `${baseServerUrl}space/${alice.space1.id}/credentials/${resourceId}/meta`

    it('[signed] GET /meta of a JSON resource returns contentType + size', async () => {
      const resourceId = 'meta-json'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'Meta JSON Resource'
      })

      const response = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      const meta = response.data as { contentType: string; size: number }
      assert.equal(meta.contentType, 'application/json')
      // The server's serialization decides the stored bytes; just assert it
      // is a sensible positive integer (the public-read case below checks the
      // size against the exact bytes returned by a GET of the resource).
      assert.ok(Number.isInteger(meta.size) && meta.size > 0)
    })

    it('[signed] GET /meta of a binary resource returns its content-type + size', async () => {
      // 'line 1\nline2\n' is exactly 13 bytes.
      const blob = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
      const result = await aliceCredentials.add(blob)

      const response = await alice.pws.request({
        url: `${result.url}/meta`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const meta = response.data as { contentType: string; size: number }
      assert.equal(meta.contentType, 'text/plain')
      assert.equal(meta.size, 13)
    })

    it('[signed] GET /meta of a nonexistent resource 404s', async () => {
      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl('does-not-exist'),
          method: 'GET'
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a missing resource meta read to be rejected')
      assert.equal(thrown.response.status, 404)
    })

    it("[signed] Bob's GET /meta of Alice's resource 404s (conflation)", async () => {
      const resourceId = 'meta-private'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'Private Meta Resource'
      })

      let thrown: any
      try {
        await bob.pws.request({ url: metaUrl(resourceId), method: 'GET' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's meta read to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('anonymous GET /meta of a resource in a PublicCanRead collection succeeds', async () => {
      const publicCollection = await aliceSpace.createCollection({
        id: 'meta-public',
        name: 'Meta Public Collection'
      })
      await publicCollection.put('readme', { id: 'readme', name: 'Read Me' })

      const resourceUrl = `${baseServerUrl}space/${alice.space1.id}/meta-public/readme`

      // Before any policy: anonymous /meta read is denied (404, no leak).
      const beforeResponse = await fetch(new URL(`${resourceUrl}/meta`))
      assert.equal(beforeResponse.status, 404)

      await publicCollection.setPublic()

      // With PublicCanRead: anonymous /meta read succeeds, and the reported
      // size matches the exact byte length of a GET of the resource itself.
      const resourceBytes = await (
        await fetch(new URL(resourceUrl))
      ).arrayBuffer()
      const metaResponse = await fetch(new URL(`${resourceUrl}/meta`))
      assert.equal(metaResponse.status, 200)
      assert.match(
        metaResponse.headers.get('content-type')!,
        /application\/json/
      )
      const meta = (await metaResponse.json()) as {
        contentType: string
        size: number
      }
      assert.equal(meta.contentType, 'application/json')
      assert.equal(meta.size, resourceBytes.byteLength)
    })

    it('[signed] GET /meta carries createdAt + updatedAt timestamps', async () => {
      const resourceId = 'meta-timestamps'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const { data: meta } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.ok(
        !Number.isNaN(Date.parse(meta.createdAt)),
        'createdAt is an RFC3339 date-time'
      )
      assert.ok(
        !Number.isNaN(Date.parse(meta.updatedAt)),
        'updatedAt is an RFC3339 date-time'
      )
      // No user-writable metadata has been set, so `custom` is omitted.
      assert.equal(meta.custom, undefined)
    })

    it('[signed] GET /meta includes createdBy, the signing DID of the creator as a one-entry list', async () => {
      const resourceId = 'meta-created-by'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const { data: meta } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.deepEqual(meta.createdBy, [alice.did])
    })

    it('[signed] PUT /meta sets custom, surfaced by GET /meta and the listing', async () => {
      const resourceId = 'meta-writable'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const putResponse = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: {
          custom: {
            name: 'Hello World greeting',
            tags: { project: 'demo', status: 'draft' }
          }
        }
      })
      assert.equal(putResponse.status, 200)

      // GET /meta reflects the new custom object (server-managed fields intact).
      const { data: meta } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(meta.contentType, 'application/json')
      assert.equal(meta.custom.name, 'Hello World greeting')
      assert.deepEqual(meta.custom.tags, { project: 'demo', status: 'draft' })

      // The List Collection result now shows the custom.name as the Resource name.
      const { data: listing } = await alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/credentials/`,
        method: 'GET'
      })
      const entry = listing.items.find((item: any) => item.id === resourceId)
      assert.equal(entry.name, 'Hello World greeting')
    })

    it('[signed] PUT /meta is a full replacement; an empty body clears custom', async () => {
      const resourceId = 'meta-clear'
      await aliceCredentials.put(resourceId, { id: resourceId })

      await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: { custom: { name: 'Temporary' } }
      })
      // An empty body object clears all user-writable properties.
      await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: {}
      })

      const { data: meta } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(meta.custom, undefined)
    })

    it('[signed] PUT /meta ignores server-managed top-level props (roundtrip)', async () => {
      const resourceId = 'meta-roundtrip'
      await aliceCredentials.put(resourceId, { id: resourceId })

      // GET the whole Metadata object, tweak custom, and PUT it back unstripped.
      const { data: meta } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      const putResponse = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: {
          ...meta,
          contentType: 'text/totally-bogus',
          size: 999999,
          custom: { name: 'Roundtripped' }
        }
      })
      assert.equal(putResponse.status, 200)

      const { data: after } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      // Server-managed fields are untouched by the roundtrip; custom updated.
      assert.equal(after.contentType, 'application/json')
      assert.notEqual(after.size, 999999)
      assert.equal(after.custom.name, 'Roundtripped')
    })

    it('[signed] PUT /meta with a custom object does not disturb createdBy', async () => {
      const resourceId = 'meta-created-by-preserved'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const putResponse = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: { custom: { name: 'Some Custom Data' } }
      })
      assert.equal(putResponse.status, 200)

      const { data: meta } = await alice.pws.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.deepEqual(meta.createdBy, [alice.did])
      assert.equal(meta.custom.name, 'Some Custom Data')
    })

    it('[signed] PUT /meta of a nonexistent resource 404s (does not create)', async () => {
      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl('does-not-exist'),
          method: 'PUT',
          json: { custom: { name: 'nope' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected PUT /meta of a missing resource to be rejected'
      )
      assert.equal(thrown.response.status, 404)
    })

    it('[signed] PUT /meta with a non-object custom 400s', async () => {
      const resourceId = 'meta-badbody'
      await aliceCredentials.put(resourceId, { id: resourceId })

      let thrown: any
      try {
        await alice.pws.request({
          url: metaUrl(resourceId),
          method: 'PUT',
          json: { custom: 'not-an-object' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected an invalid custom body to be rejected')
      assert.equal(thrown.response.status, 400)
      assert.match(thrown.data.type, /#invalid-request-body$/)
    })

    it("[signed] Bob's PUT /meta of Alice's resource 404s (conflation)", async () => {
      const resourceId = 'meta-bob-write'
      await aliceCredentials.put(resourceId, { id: resourceId })

      let thrown: any
      try {
        await bob.pws.request({
          url: metaUrl(resourceId),
          method: 'PUT',
          json: { custom: { name: 'hijack' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's meta write to be rejected")
      assert.equal(thrown.response.status, 404)
    })
  })

  describe('Conditional Reads (If-None-Match / 304)', () => {
    const resourceUrl = (resourceId: string) =>
      `${baseServerUrl}space/${alice.space1.id}/credentials/${resourceId}`

    /**
     * Writes a text Resource (so a HEAD's empty body does not trip the JSON
     * parser) and returns its URL and ETag.
     */
    async function textResource(
      resourceId: string
    ): Promise<{ url: string; etag: string }> {
      const url = resourceUrl(resourceId)
      const created = await alice.pws.request({
        url,
        method: 'PUT',
        body: new Blob(['hello'], { type: 'text/plain' })
      })
      return { url, etag: created.headers.get('etag')! }
    }

    it('[signed] GET with a matching If-None-Match is 304 with the ETag and no body', async () => {
      const { url, etag } = await textResource('cond-read-get-match')
      const getResource = vi.spyOn(fastify.storage, 'getResource')
      const response = await responseOf(
        alice.pws.request({
          url,
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      // The 304 ends the handler: the byte stream is never opened.
      assert.equal(getResource.mock.calls.length, 0)
      getResource.mockRestore()
      assert.equal(response.status, 304)
      assert.equal(response.headers.get('etag'), etag)
      // RFC 9110 section 8.6: a 304 does not describe its own empty body.
      assert.equal(response.headers.get('content-length'), null)
      assert.equal(await response.text(), '')
    })

    it('[signed] GET with a stale If-None-Match is the full 200', async () => {
      const { url, etag } = await textResource('cond-read-get-stale')
      await alice.pws.request({
        url,
        method: 'PUT',
        body: new Blob(['hello again'], { type: 'text/plain' })
      })
      const response = await responseOf(
        alice.pws.request({
          url,
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(response.status, 200)
      const newEtag = response.headers.get('etag')
      assertEtagAdvanced({ before: etag, after: newEtag })
      assert.equal(etagGeneration(newEtag!), etagGeneration(etag))
      assert.equal(await response.text(), 'hello again')
    })

    it('[signed] a weak validator, a list, and `*` all match (RFC 9110 weak comparison)', async () => {
      const { url, etag } = await textResource('cond-read-get-forms')
      for (const ifNoneMatch of [`W/${etag}`, `"99", ${etag}`, '*']) {
        const response = await responseOf(
          alice.pws.request({
            url,
            method: 'GET',
            headers: { 'if-none-match': ifNoneMatch }
          })
        )
        assert.equal(response.status, 304, `If-None-Match: ${ifNoneMatch}`)
      }
    })

    it('[signed] HEAD with a matching If-None-Match is 304', async () => {
      const { url, etag } = await textResource('cond-read-head-match')
      const response = await responseOf(
        alice.pws.request({
          url,
          method: 'HEAD',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(response.status, 304)
      assert.equal(response.headers.get('etag'), etag)
      assert.equal(response.headers.get('content-length'), null)
    })

    it('[signed] GET /meta with a matching If-None-Match is 304 on the meta ETag', async () => {
      const resourceId = 'cond-read-meta'
      const { url } = await textResource(resourceId)
      const metaUrl = `${url}/meta`
      const written = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'Meta' } }
      })
      const metaEtag = written.headers.get('etag')!
      const unchanged = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'GET',
          headers: { 'if-none-match': metaEtag }
        })
      )
      assert.equal(unchanged.status, 304)
      assert.equal(unchanged.headers.get('etag'), metaEtag)
      assert.equal(unchanged.headers.get('content-length'), null)

      // A superseded /meta ETag misses.
      const rewritten = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'Meta 2' } }
      })
      assert.notEqual(rewritten.headers.get('etag'), metaEtag)
      const stale = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'GET',
          headers: { 'if-none-match': metaEtag }
        })
      )
      assert.equal(stale.status, 200)
    })

    it("[signed] GET /meta never written: the ETag is the Resource's own, and a conditional read with it is 304", async () => {
      // With no /meta record, the /meta ETag is the content record's
      // validator alone, so it equals the Resource's own ETag.
      const { url, etag: contentEtag } = await textResource(
        'cond-read-meta-unwritten'
      )
      const read = await alice.pws.request({
        url: `${url}/meta`,
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), contentEtag)
      for (const ifNoneMatch of [contentEtag, '*']) {
        const conditional = await responseOf(
          alice.pws.request({
            url: `${url}/meta`,
            method: 'GET',
            headers: { 'if-none-match': ifNoneMatch }
          })
        )
        assert.equal(conditional.status, 304, `If-None-Match: ${ifNoneMatch}`)
        assert.equal(conditional.headers.get('etag'), contentEtag)
      }
    })

    it('[signed] GET /meta after PUT /meta serves the composite, and the pre-write ETag misses', async () => {
      const { url, etag: contentEtag } = await textResource(
        'cond-read-meta-composite'
      )
      const metaUrl = `${url}/meta`
      const before = await alice.pws.request({ url: metaUrl, method: 'GET' })
      const beforeEtag = before.headers.get('etag')!
      await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'Composite' } }
      })
      const after = await alice.pws.request({ url: metaUrl, method: 'GET' })
      const afterEtag = after.headers.get('etag')!
      // Eight segments: the content ETag, then the /meta record's validator.
      const parts = splitResourceMetaEtag(afterEtag)
      assert.equal(parts.content, contentEtag)
      assert.ok(parts.meta, "the /meta record's validator follows")
      parseEtagSegments(parts.meta)
      assert.equal(afterEtag.split('.').length, 8)
      const stale = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'GET',
          headers: { 'if-none-match': beforeEtag }
        })
      )
      assert.equal(stale.status, 200)
      assert.equal(stale.headers.get('etag'), afterEtag)
    })

    it('[signed] a content write that changes the content type moves the /meta ETag', async () => {
      const { url } = await textResource('cond-read-meta-content-type')
      const metaUrl = `${url}/meta`
      await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'Typed' } }
      })
      const held = (
        await alice.pws.request({ url: metaUrl, method: 'GET' })
      ).headers.get('etag')!
      // The content write leaves the /meta record alone, but the body it
      // serves changes (`contentType`, `size`, the content stamp).
      const rewritten = await alice.pws.request({
        url,
        method: 'PUT',
        body: new Blob(['<p>hello</p>'], { type: 'text/html' })
      })
      const response = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'GET',
          headers: { 'if-none-match': held }
        })
      )
      assert.equal(response.status, 200)
      // The http client parsed the JSON body already.
      const body = (response as any).data
      assert.match(body.contentType, /^text\/html/)
      assert.deepEqual(body.custom, { name: 'Typed' })
      const parts = splitResourceMetaEtag(response.headers.get('etag'))
      assert.equal(parts.content, rewritten.headers.get('etag'))
      // The /meta record did not move.
      assert.equal(parts.meta, splitResourceMetaEtag(held).meta)
    })

    it('an under-authorized conditional GET is the 404 mask, never a 304', async () => {
      // A 304 would confirm the Resource exists, exactly what the mask hides.
      const { url, etag } = await textResource('cond-read-private')
      const anonymous = await fetch(new URL(url), {
        headers: { 'if-none-match': etag }
      })
      assert.equal(anonymous.status, 404)
      const other = await responseOf(
        bob.pws.request({
          url,
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(other.status, 404)
    })

    it('an anonymous conditional GET of a public Resource is 304', async () => {
      const publicCollection = await aliceSpace.createCollection({
        id: 'cond-read-public',
        name: 'Conditional Public'
      })
      await publicCollection.setPublic()
      await publicCollection.put('readme', { id: 'readme', name: 'Read Me' })
      const url = `${baseServerUrl}space/${alice.space1.id}/cond-read-public/readme`
      const first = await fetch(new URL(url))
      assert.equal(first.status, 200)
      const etag = first.headers.get('etag')!
      const second = await fetch(new URL(url), {
        headers: { 'if-none-match': etag }
      })
      assert.equal(second.status, 304)
      assert.equal(second.headers.get('etag'), etag)
      assert.equal(await second.text(), '')
    })
  })

  describe('Conditional Writes (ETag / If-Match)', () => {
    // Build the absolute resource URL for a credentials-collection resource.
    const resourceUrl = (resourceId: string) =>
      `${baseServerUrl}space/${alice.space1.id}/credentials/${resourceId}`

    it('surfaces an ETag on write and GET that advances on each write', async () => {
      const resourceId = 'cond-etag-roundtrip'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      assert.equal(created.status, 201)
      const createdEtag = created.headers.get('etag')
      parseEtagSegments(createdEtag)

      // GET echoes the same validator.
      const got = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'GET'
      })
      assert.equal(got.headers.get('etag'), createdEtag)

      // A second (unconditional) write advances the version, same generation.
      const updated = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })
      const updatedEtag = updated.headers.get('etag')
      assertEtagAdvanced({ before: createdEtag, after: updatedEtag })
      assert.equal(etagGeneration(updatedEtag!), etagGeneration(createdEtag!))
    })

    it('surfaces the ETag header on a HEAD response', async () => {
      // Use a text/plain resource: the http client auto-JSON-parses a body, and
      // a HEAD carries none, so a JSON content-type would make it choke on the
      // empty body. The ETag header path is identical to GET / `/meta`.
      const resourceId = 'cond-etag-head'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        body: new Blob(['hello'], { type: 'text/plain' })
      })
      const etag = created.headers.get('etag')!
      const head = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'HEAD'
      })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('etag'), etag)
    })

    it('a matching If-Match succeeds and advances the ETag', async () => {
      const resourceId = 'cond-ifmatch-ok'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const etag = created.headers.get('etag')!

      const updated = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 },
        headers: { 'if-match': etag }
      })
      assert.equal(updated.status, 200)
      const updatedEtag = updated.headers.get('etag')
      assertEtagAdvanced({ before: etag, after: updatedEtag })
      assert.equal(etagGeneration(updatedEtag!), etagGeneration(etag))
    })

    it('a stale If-Match is rejected with 412 precondition-failed', async () => {
      const resourceId = 'cond-ifmatch-stale'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const staleEtag = created.headers.get('etag')!
      // Advance the version so the original validator is now stale.
      await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })

      let thrown: any
      try {
        await alice.pws.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 3 },
          headers: { 'if-match': staleEtag }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a stale If-Match to be rejected')
      assert.equal(thrown.response.status, 412)
    })

    it('If-None-Match: * creates when absent and 412s when the target exists', async () => {
      const resourceId = 'cond-ifnonematch'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 },
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 201)
      parseEtagSegments(created.headers.get('etag'))

      // A second create-if-absent against the now-existing resource fails.
      let thrown: any
      try {
        await alice.pws.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 2 },
          headers: { 'if-none-match': '*' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected create-if-absent on an existing resource to be rejected'
      )
      assert.equal(thrown.response.status, 412)
    })

    it('serializes concurrent If-Match writers: exactly one wins, the other 412s', async () => {
      const resourceId = 'cond-concurrent'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 0 }
      })
      const etag = created.headers.get('etag')!

      // Two writers race with the same prior ETag; the per-resource lock lets
      // only one observe the matching version, so the other gets a 412.
      const results = await Promise.allSettled([
        alice.pws.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 1 },
          headers: { 'if-match': etag }
        }),
        alice.pws.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 2 },
          headers: { 'if-match': etag }
        })
      ])
      const fulfilled = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      assert.equal(fulfilled.length, 1, 'exactly one writer should win')
      assert.equal(rejected.length, 1, 'exactly one writer should be rejected')
      assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.response.status,
        412
      )
    })

    it('checks authorization before the precondition: Bob gets 404, not 412', async () => {
      const resourceId = 'cond-authz-first'
      await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })

      // Bob cannot write Alice's resource. Even with a bogus precondition he must
      // get the privacy-merged 404, never a 412 (a 412 would leak existence).
      let thrown: any
      try {
        await bob.pws.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 2 },
          headers: { 'if-match': '"999"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's conditional write to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('DELETE honors If-Match: a stale validator 412s, the matching one succeeds', async () => {
      const resourceId = 'cond-delete'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const etag = created.headers.get('etag')!

      // A stale If-Match delete is rejected...
      let thrown: any
      try {
        await alice.pws.request({
          url: resourceUrl(resourceId),
          method: 'DELETE',
          headers: { 'if-match': '"999"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a stale If-Match delete to be rejected')
      assert.equal(thrown.response.status, 412)

      // ...and the matching one succeeds, removing the resource.
      const deleted = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'DELETE',
        headers: { 'if-match': etag }
      })
      assert.equal(deleted.status, 204)
      const gone = await aliceCredentials.get(resourceId)
      assert.equal(gone, null)
    })

    it('a tombstone keeps the generation: PUT / DELETE / PUT continues the stamp', async () => {
      const resourceId = 'cond-tombstone-generation'
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const createdEtag = created.headers.get('etag')!
      parseEtagSegments(createdEtag)

      // The tombstone sidecar survives the content, continuing the stamp.
      await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'DELETE'
      })

      // Re-creating under the same id keeps the generation and mints a later
      // stamp, rather than starting a fresh generation.
      const recreated = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })
      const recreatedEtag = recreated.headers.get('etag')
      assertEtagAdvanced({ before: createdEtag, after: recreatedEtag })
      assert.equal(etagGeneration(recreatedEtag!), etagGeneration(createdEtag))
    })

    it('PUT /meta with If-Match from a GET of /meta succeeds, and a stale one is 412', async () => {
      const resourceId = 'cond-meta-if-match'
      const metaUrl = `${resourceUrl(resourceId)}/meta`
      await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      // Before any metadata write, the ETag a GET serves is the content ETag,
      // and it still gates the first metadata write.
      const unwritten = await alice.pws.request({ url: metaUrl, method: 'GET' })
      const first = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'first' } },
        headers: { 'if-match': unwritten.headers.get('etag')! }
      })
      assert.equal(first.status, 200)

      const read = await alice.pws.request({ url: metaUrl, method: 'GET' })
      const readEtag = read.headers.get('etag')!
      assert.equal(readEtag, first.headers.get('etag'))
      const second = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'second' } },
        headers: { 'if-match': readEtag }
      })
      assert.equal(second.status, 200)

      // The ETag read before the second write is now stale ...
      const staleMeta = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'stale' } },
          headers: { 'if-match': readEtag }
        })
      )
      assert.equal(staleMeta.status, 412)
      // ... and so is the current one once a content write lands.
      const current = second.headers.get('etag')!
      await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })
      const staleContent = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'stale' } },
          headers: { 'if-match': current }
        })
      )
      assert.equal(staleContent.status, 412)
      const meta = await aliceCredentials.resource(resourceId).meta()
      assert.deepEqual(meta!.custom, { name: 'second' })
    })

    it('a tombstone drops the /meta validator: PUT /meta, DELETE, PUT, PUT /meta starts a new meta generation', async () => {
      const resourceId = 'cond-tombstone-meta-generation'
      const metaUrl = `${resourceUrl(resourceId)}/meta`
      const created = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const createdEtag = created.headers.get('etag')!
      const preDeleteMeta = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'before' } }
      })
      const preDeleteMetaEtag = preDeleteMeta.headers.get('etag')!
      // The /meta ETag is the content ETag followed by the /meta record's.
      const preDeleteParts = splitResourceMetaEtag(preDeleteMetaEtag)
      assert.equal(preDeleteParts.content, createdEtag)
      assert.notEqual(
        etagGeneration(preDeleteParts.meta!),
        etagGeneration(createdEtag),
        'the /meta record carries its own generation'
      )

      await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'DELETE'
      })
      const recreated = await alice.pws.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })
      // The content validator continues through the tombstone, as before.
      assertEtagAdvanced({
        before: createdEtag,
        after: recreated.headers.get('etag')
      })
      assert.equal(
        etagGeneration(recreated.headers.get('etag')!),
        etagGeneration(createdEtag)
      )

      // A replica still holding the pre-delete /meta ETag is refused ...
      const stale = await responseOf(
        alice.pws.request({
          url: metaUrl,
          method: 'PUT',
          json: { custom: { name: 'stale replica' } },
          headers: { 'if-match': preDeleteMetaEtag }
        })
      )
      assert.equal(stale.status, 412)
      // ... while a guarded create of the metadata object succeeds, under a
      // fresh generation rather than the old one.
      const revivedMeta = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { custom: { name: 'after' } },
        headers: { 'if-none-match': '*' }
      })
      const revivedMetaEtag = revivedMeta.headers.get('etag')!
      const revivedParts = splitResourceMetaEtag(revivedMetaEtag)
      assert.equal(revivedParts.content, recreated.headers.get('etag'))
      assert.notEqual(revivedMetaEtag, preDeleteMetaEtag)
      assert.notEqual(
        etagGeneration(revivedParts.meta!),
        etagGeneration(preDeleteParts.meta!)
      )
      const meta = await aliceCredentials.resource(resourceId).meta()
      assert.deepEqual(meta!.custom, { name: 'after' })
    })
  })

  describe('Binary / non-JSON content types (raw PUT)', () => {
    it('[signed] PUT a raw application/octet-stream blob round-trips', async () => {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
      await aliceCredentials.put(
        'raw-octet',
        new Blob([bytes], { type: 'application/octet-stream' })
      )
      const got = (await aliceCredentials.get('raw-octet')) as Blob
      assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)
      const meta = await aliceCredentials.resource('raw-octet').meta()
      assert.equal(meta!.contentType, 'application/octet-stream')
      assert.equal(meta!.size, bytes.length)
    })

    it('[signed] a binary resource under a dotted id preserves its id and content-type', async () => {
      const bytes = new Uint8Array([10, 20, 30])
      await aliceCredentials.put(
        'photo.png',
        new Blob([bytes], { type: 'image/png' })
      )
      const got = (await aliceCredentials.get('photo.png')) as Blob
      assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)
      const meta = await aliceCredentials.resource('photo.png').meta()
      assert.equal(meta!.contentType, 'image/png')

      // The dotted id and its content-type must survive the on-disk filename
      // round-trip (the keyset is parsed back from the filename).
      const listing = await aliceCredentials.list()
      const entry = listing!.items.find(item => item.id === 'photo.png')
      assert.ok(entry, 'dotted id should appear in the Collection listing')
      assert.equal(entry!.contentType, 'image/png')
    })

    it('[signed] application/jsonl is stored as raw bytes, not parsed as JSON', async () => {
      // A JSON-Lines body is several JSON values, not one -- it must NOT be
      // routed through the JSON path (which would corrupt it).
      const body = '{"a":1}\n{"a":2}\n'
      const collection = await aliceSpace.createCollection({
        id: 'jsonl-public',
        name: 'Public JSONL'
      })
      await collection.put(
        'data.jsonl',
        new Blob([body], { type: 'application/jsonl' })
      )
      const meta = await collection.resource('data.jsonl').meta()
      assert.equal(meta!.contentType, 'application/jsonl')
      assert.equal(meta!.size, Buffer.byteLength(body))

      // Read the raw bytes back via a public read + plain fetch (a signed read
      // through the client would JSON-parse any "json"-bearing content-type).
      await collection.setPublic()
      const response = await fetch(
        new URL(
          `/space/${alice.space1.id}/jsonl-public/data.jsonl`,
          baseServerUrl
        )
      )
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/jsonl/)
      assert.equal(await response.text(), body)
    })

    it('[signed] a +json-prefixed non-JSON suffix (+jsonl, +json-seq) is stored as raw bytes', async () => {
      // `application/ld+jsonl` and `application/ld+json-seq` are not JSON
      // documents; the `+json` parser must not claim them by prefix.
      const body = '{"a":1}\n{"a":2}\n'
      for (const [resourceId, type] of [
        ['ld.jsonl', 'application/ld+jsonl'],
        ['ld.json-seq', 'application/ld+json-seq']
      ] as const) {
        await aliceCredentials.put(resourceId, new Blob([body], { type }))
        const meta = await aliceCredentials.resource(resourceId).meta()
        assert.equal(meta!.contentType, type)
        assert.equal(meta!.size, Buffer.byteLength(body))
        const response = await alice.pws.request({
          url: `${baseServerUrl}space/${alice.space1.id}/credentials/${resourceId}`,
          method: 'GET'
        })
        assert.equal(response.status, 200)
        assert.equal(await response.text(), body)
      }
    })

    it('[signed] a multipart type other than form-data is stored as a raw blob', async () => {
      const body =
        '--x\r\ncontent-type: text/plain\r\n\r\nfirst\r\n--x\r\n' +
        'content-type: text/plain\r\n\r\nsecond\r\n--x--\r\n'
      const type = 'multipart/mixed; boundary=x'
      await aliceCredentials.put('mixed', new Blob([body], { type }))
      const meta = await aliceCredentials.resource('mixed').meta()
      assert.equal(meta!.contentType, type)
      assert.equal(meta!.size, Buffer.byteLength(body))
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/credentials/mixed`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), type)
      assert.equal(await response.text(), body)
    })
  })

  describe('Multipart upload (HTML-form convenience path)', () => {
    it('[signed] a form field alongside the one file part is skipped, not refused', async () => {
      // The write path reads file parts only; an extra <input> in the form
      // must not turn the upload into a "missing a file part" refusal.
      const url = `${baseServerUrl}space/${alice.space1.id}/credentials/`
      const boundary = 'was-test-boundary'
      const body = new TextEncoder().encode(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="note"\r\n\r\n' +
          'a field the server ignores\r\n' +
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="a.json"\r\n' +
          'Content-Type: application/json\r\n\r\n' +
          '{"id":"from-form","name":"form upload"}\r\n' +
          `--${boundary}--\r\n`
      )
      const headers = await signCapabilityInvocation({
        url,
        method: 'POST',
        headers: {
          date: new Date().toUTCString(),
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body,
        invocationSigner: alice.signer,
        capabilityAction: 'POST'
      })
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: new Blob([body])
      })
      const text = await response.text()
      assert.equal(response.status, 201, text)
      const created = JSON.parse(text)
      // The 201 names the stored content type (the file part's), not the
      // request envelope's.
      assert.equal(created['content-type'], 'application/json')
      const stored: any = await aliceCredentials.get(created.id)
      assert.equal(stored.name, 'form upload')
    })

    it('[signed] the multipart media type is matched case-insensitively', async () => {
      const response = await signedMultipart({
        signer: alice.signer,
        url: `${baseServerUrl}space/${alice.space1.id}/credentials/`,
        method: 'POST',
        envelopeType: 'MULTIPART/FORM-DATA',
        partType: 'application/json',
        partBody: '{"id":"from-upper-form","name":"upper form upload"}'
      })
      const text = await response.text()
      assert.equal(response.status, 201, text)
      const created = JSON.parse(text)
      assert.equal(created['content-type'], 'application/json')
      const stored: any = await aliceCredentials.get(created.id)
      assert.equal(stored.name, 'upper form upload')
    })

    it('[signed] a multipart PUT replaces an existing Resource', async () => {
      await aliceCredentials.put('multipart-put', { name: 'before' })
      const response = await signedMultipart({
        signer: alice.signer,
        url: `${baseServerUrl}space/${alice.space1.id}/credentials/multipart-put`,
        method: 'PUT',
        partType: 'application/json',
        partBody: '{"name":"after"}'
      })
      assert.ok(response.ok, await response.text())
      const stored: any = await aliceCredentials.get('multipart-put')
      assert.equal(stored.name, 'after')
    })

    it('[signed] a multipart body that does not match its signed Digest is refused', async () => {
      // The digest is taken over the multipart body as busboy reads it, so a
      // body swapped under a valid signature still fails.
      const url = `${baseServerUrl}space/${alice.space1.id}/credentials/`
      const boundary = 'was-test-boundary'
      const encode = (name: string) =>
        new TextEncoder().encode(
          `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="a.json"\r\n' +
            'Content-Type: application/json\r\n\r\n' +
            `{"name":"${name}"}\r\n` +
            `--${boundary}--\r\n`
        )
      const headers = await signCapabilityInvocation({
        url,
        method: 'POST',
        headers: {
          date: new Date().toUTCString(),
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body: encode('signed'),
        invocationSigner: alice.signer,
        capabilityAction: 'POST'
      })
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: new Blob([encode('swapped')])
      })
      assert.equal(response.status, 400)
      const problem: any = await response.json()
      assert.match(problem.type, /#invalid-authorization-header$/)
    })
  })

  describe('Multipart upload under an unlimited cap', () => {
    let openFastify: FastifyInstance, openServerUrl: string, openAlice: any
    const openSpaceId = 'c1d9e4f3-5e3b-4d6c-8b2f-7a8e9f0b1c2d'

    beforeAll(async () => {
      ;({ fastify: openFastify, baseServerUrl: openServerUrl } =
        await startTestServer({
          backend: await openTempBackend({
            prefix: 'was-multipart-open-',
            maxUploadBytes: Infinity
          })
        }))
      ;({ alice: openAlice } = await zcapClients({
        baseServerUrl: openServerUrl
      }))
      const space = await openAlice.pws.createSpace({
        id: openSpaceId,
        name: 'Multipart Open Space',
        controller: openAlice.did
      })
      await space.createCollection({ id: 'data', name: 'Data' })
    })

    afterAll(async () => {
      await openFastify.close()
    })

    it("[signed] buffers a file part past Fastify's 1 MiB default under MAX_UPLOAD_BYTES=unlimited", async () => {
      // With no cap configured the multipart buffer is bounded by the
      // buffered-body limit (64 MiB), not by the 1 MiB `bodyLimit`
      // `@fastify/multipart` falls back to when it is given no `fileSize`.
      const response = await signedMultipart({
        signer: openAlice.signer,
        url: `${openServerUrl}space/${openSpaceId}/data/`,
        method: 'POST',
        partType: 'application/octet-stream',
        partBody: 'x'.repeat(2 * 1024 * 1024)
      })
      assert.equal(response.status, 201, await response.text())
    })
  })

  describe('Multipart upload over the server cap (413)', () => {
    let capFastify: FastifyInstance, capServerUrl: string, capAlice: any
    let capBackendId: string
    const capSpaceId = 'b0c8f3e2-4d2a-4c5b-9a1e-6f7d8e9a0b1c'
    const maxUploadBytes = 1024

    beforeAll(async () => {
      const backend = await openTempBackend({
        prefix: 'was-multipart-cap-',
        maxUploadBytes
      })
      capBackendId = backend.describe().id
      ;({ fastify: capFastify, baseServerUrl: capServerUrl } =
        await startTestServer({ backend }))
      ;({ alice: capAlice } = await zcapClients({
        baseServerUrl: capServerUrl
      }))
      const space = await capAlice.pws.createSpace({
        id: capSpaceId,
        name: 'Multipart Cap Space',
        controller: capAlice.did
      })
      await space.createCollection({ id: 'data', name: 'Data' })
    })

    afterAll(async () => {
      await capFastify.close()
    })

    it('[signed] names the server backend limit the multipart buffer enforced', async () => {
      const response = await signedMultipart({
        signer: capAlice.signer,
        url: `${capServerUrl}space/${capSpaceId}/data/`,
        method: 'POST',
        partType: 'application/octet-stream',
        partBody: 'x'.repeat(maxUploadBytes * 2)
      })
      const problemText = await response.text()
      assert.equal(response.status, 413, problemText)
      const problem = JSON.parse(problemText)
      assert.match(problem.type, /payload-too-large/, problemText)
      const detail: string = problem.errors[0].detail
      assert.ok(
        detail.includes(`'maxUploadBytes' of ${maxUploadBytes}`),
        detail
      )
      assert.ok(detail.includes(`for backend '${capBackendId}'`), detail)
    })
  })
})
