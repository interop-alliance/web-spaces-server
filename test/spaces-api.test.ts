/**
 * Spaces Repository and Space API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { Space } from '@interop/pws-client'

import {
  assertEtagAdvanced,
  parseEtagSegments,
  client,
  etagGeneration,
  openTempBackend,
  requestError,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

/**
 * The server-derived `backends` member every Space Metadata read carries: this
 * suite's server runs the filesystem backend alone, listed under the `default`
 * alias and under its fixed id.
 */
const SERVED_BACKENDS = [
  {
    id: 'default',
    name: 'Server Filesystem',
    managedBy: 'server',
    persistence: 'durable'
  },
  {
    id: 'fs',
    name: 'Server Filesystem',
    managedBy: 'server',
    persistence: 'durable'
  }
]

/**
 * Asserts a served Space Metadata object carries its write stamp and returns
 * the rest of the object, so a suite can compare the stable members exactly.
 *
 * @param description {any}   the served Space Metadata object
 * @returns {any}
 */
function withoutStamp(description: any): any {
  const { updatedAt, updatedAtCounter, originId, ...rest } = description
  assert.ok(!Number.isNaN(Date.parse(updatedAt)))
  assert.equal(typeof updatedAtCounter, 'number')
  assert.equal(typeof originId, 'string')
  return rest
}

describe('Spaces', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    bob: any,
    aliceDelegatedApp: any

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('Spaces Repository API', () => {
    it('GET /spaces/ without auth headers returns the empty listing (200)', async () => {
      // List Spaces is the spec's exception to 404 masking: an anonymous
      // request is not an error -- it is simply authorized to see no spaces.
      const response = await fetch(new URL('/spaces/', baseServerUrl))
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.deepStrictEqual(await response.json(), {
        url: '/spaces/',
        totalItems: 0,
        items: []
      })
    })
    it('POST /spaces/ should 401 error when no authorization headers', async () => {
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST'
      })
      assert.equal(response.status, 401)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })
  })

  describe('Space API', () => {
    it('[root] create space via POST', async () => {
      const space = await alice.pws.createSpace({
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })
      assert.equal(space.id, alice.space1.id)
      assert.deepStrictEqual(withoutStamp(await space.describe()), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        createdBy: [alice.did],
        url: `/space/${alice.space1.id}/`,
        linkset: `/space/${alice.space1.id}/linkset`,
        backends: SERVED_BACKENDS,
        replicas: []
      })
    })

    it('[root] Space linkset advertises the backends-available and quotas relations', async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/linkset`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const [entry] = (response.data as { linkset: Array<Record<string, any>> })
        .linkset
      assert.deepStrictEqual(
        entry!['https://w3id.org/pws#backends-available'],
        [
          {
            href: `/space/${alice.space1.id}/backends`,
            type: 'application/json'
          }
        ]
      )
      assert.deepStrictEqual(entry!['https://w3id.org/pws#quotas'], [
        { href: `/space/${alice.space1.id}/quotas`, type: 'application/json' }
      ])
    })

    it('two concurrent POST /spaces/ with the same id yield one 201 and one 409, the winner untouched', async () => {
      const spaceId = crypto.randomUUID()
      const post = (name: string) =>
        alice.pws
          .request({
            url: new URL('/spaces/', baseServerUrl).toString(),
            method: 'POST',
            json: { id: spaceId, name, controller: alice.did }
          })
          .then(
            () => 201,
            (err: any) => err.response.status as number
          )
      const statuses = await Promise.all([post('First'), post('Second')])
      assert.deepEqual(statuses.slice().sort(), [201, 409])
      // The guarded write inside the backend refused the loser, so the
      // winner's Space Metadata is what is stored (its name was not replaced).
      const stored = await alice.pws.space(spaceId).describe()
      assert.equal(stored!.name, statuses[0] === 201 ? 'First' : 'Second')
    })

    it('POST /spaces/ with an existing id yields id-conflict (409)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Conflict Test Space',
        controller: alice.did
      })

      let expectedError: any
      try {
        await alice.pws.request({
          url: new URL('/spaces/', baseServerUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Replacement', controller: alice.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the duplicate-id POST to be rejected')
      assert.equal(expectedError.response.status, 409)
      assert.equal(expectedError.data.type, 'https://w3id.org/pws#id-conflict')
      assert.equal(expectedError.data.errors[0].pointer, '#/id')
    })

    it("POST /spaces/ cannot overwrite another controller's Space", async () => {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: "Alice's Space",
        controller: alice.did
      })

      // Bob signs with his own key and supplies his own controller -- before
      // the existence check, Create Space verified against the body's
      // controller, so this request silently replaced Alice's Space
      // (controller included).
      let expectedError: any
      try {
        await bob.pws.request({
          url: new URL('/spaces/', baseServerUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Hijacked', controller: bob.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the takeover POST to be rejected')
      assert.equal(expectedError.response.status, 409)

      // Alice's Space Metadata (controller included) is untouched.
      const description = await alice.pws.space(spaceId).describe()
      assert.equal(description.controller, alice.did)
      assert.equal(description.name, "Alice's Space")
    })

    it('[root] create space by id via PUT', async () => {
      const space = alice.pws.space(alice.space2.id)
      // configure() upserts the space by id (PUT).
      await space.configure({
        name: "Alice's Space #2 (School)",
        controller: alice.did
      })
      assert.notEqual(await space.describe(), null)
    })

    it('[root] the Create Space 201 body carries the same createdBy a later GET returns', async () => {
      const spaceId = crypto.randomUUID()
      const response = await alice.pws.request({
        url: new URL('/spaces/', baseServerUrl).toString(),
        method: 'POST',
        json: { id: spaceId, name: 'Created Space', controller: alice.did }
      })
      assert.equal(response.status, 201)
      assert.deepEqual((response.data as { createdBy?: string[] }).createdBy, [
        alice.did
      ])

      const description = await alice.pws.space(spaceId).describe()
      assert.deepEqual(description?.createdBy, [alice.did])
    })

    it('[root] a PUT whose body carries a forged createdBy does not change the stored value', async () => {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Forged createdBy Space',
        controller: alice.did
      })

      await alice.pws.request({
        url: new URL(`/space/${spaceId}/meta`, baseServerUrl).toString(),
        method: 'PUT',
        json: {
          name: 'Renamed',
          controller: alice.did,
          createdBy: ['did:key:zEVIL']
        }
      })

      const description = await alice.pws.space(spaceId).describe()
      assert.deepEqual(description?.createdBy, [alice.did])
      assert.equal(description?.name, 'Renamed')
    })

    it('[root] a PUT /meta that omits name removes the stored name (full replacement)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Named Space',
        controller: alice.did
      })
      const metaUrl = new URL(
        `/space/${spaceId}/meta`,
        baseServerUrl
      ).toString()

      const named = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { name: 'Renamed', controller: alice.did }
      })
      assert.equal(named.status, 204)
      assert.equal((await alice.pws.space(spaceId).describe())?.name, 'Renamed')

      const unnamed = await alice.pws.request({
        url: metaUrl,
        method: 'PUT',
        json: { controller: alice.did }
      })
      assert.equal(unnamed.status, 204)
      const description = await alice.pws.space(spaceId).describe()
      assert.equal('name' in description!, false)
      // The immutable and server-managed members survive the replacement.
      assert.deepEqual(description?.type, ['Space'])
      assert.deepEqual(description?.createdBy, [alice.did])
    })

    it('GET a space with no auth headers falls through to policy and 404s (no public policy)', async () => {
      // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
      // and is denied as 404 (no-leak) when no access-control policy grants it.
      const spaceUrl = new URL(
        `/space/${alice.space1.id}/meta`,
        baseServerUrl
      ).toString()
      const response = await fetch(spaceUrl, { method: 'GET' })
      assert.equal(response.status, 404)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('describing a not-found space returns null (404 conflation)', async () => {
      const missing = await alice.pws
        .space('space-id-that-does-not-exist')
        .describe()
      assert.equal(missing, null)
    })

    it('[root] read space via GET with proper authorization', async () => {
      const spaceDescription = await alice.pws.space(alice.space1.id).describe()
      assert.deepStrictEqual(withoutStamp(spaceDescription), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        createdBy: [alice.did],
        url: `/space/${alice.space1.id}/`,
        linkset: `/space/${alice.space1.id}/linkset`,
        backends: SERVED_BACKENDS,
        replicas: []
      })
    })

    it('[delegated] authorized app should GET /space/:spaceId/meta', async () => {
      // First, Alice (re-)provisions the Space -- via the idempotent PUT path,
      // since POSTing an existing id now yields `id-conflict` (409).
      const space = alice.pws.space(alice.space1.id)
      await space.configure({
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })

      // Alice delegates GET access on the space to the app.
      const zcap = await space.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET']
      })

      // Alice's app rebuilds a handle from the capability and reads the space.
      const handle = aliceDelegatedApp.pws.fromCapability(zcap)
      assert.ok(handle instanceof Space)
      assert.deepStrictEqual(withoutStamp(await handle.describe()), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        createdBy: [alice.did],
        url: `/space/${alice.space1.id}/`,
        linkset: `/space/${alice.space1.id}/linkset`,
        backends: SERVED_BACKENDS,
        replicas: []
      })
    })

    it('[root] Bob should not be able to GET Alice space', async () => {
      // First, Alice (re-)provisions the Space -- via the idempotent PUT path,
      // since POSTing an existing id now yields `id-conflict` (409).
      await alice.pws.space(alice.space1.id).configure({
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })

      // Bob reads with his own client and gets null (404 conflated: not-found
      // vs unauthorized), so the space's existence is not revealed.
      const seenByBob = await bob.pws.space(alice.space1.id).describe()
      assert.equal(seenByBob, null)
    })

    it('[root] Alice should be able to DELETE her provisioned space', async () => {
      // First, create the space
      const space = await alice.pws.createSpace({
        id: 'a-space-to-delete',
        name: "Alice's Test Space to be deleted",
        controller: alice.did
      })

      // Now delete the space
      await space.delete()

      // Check that the space was deleted (reads return null on 404).
      assert.equal(await space.describe(), null)
    })
  })

  describe('Space Metadata ETag and conditional writes', () => {
    const metaUrl = (spaceId: string) => `${baseServerUrl}space/${spaceId}/meta`
    const spaceMetadata = (spaceId: string, name: string) => ({
      id: spaceId,
      name,
      controller: alice.did
    })

    it('[root] Create Space (POST and PUT) and Get Space emit the Space Metadata ETag', async () => {
      const posted = await alice.pws.request({
        url: `${baseServerUrl}spaces/`,
        method: 'POST',
        json: spaceMetadata('etag-post', 'Posted')
      })
      parseEtagSegments(posted.headers.get('etag'), { container: true })

      const put = await alice.pws.request({
        url: metaUrl('etag-put'),
        method: 'PUT',
        json: spaceMetadata('etag-put', 'Put')
      })
      assert.equal(put.status, 201)
      const createdEtag = put.headers.get('etag')
      parseEtagSegments(createdEtag, { container: true })

      const read = await alice.pws.request({
        url: metaUrl('etag-put'),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), createdEtag)
      // The validator travels only as the header and stays out of the body.
      assert.equal(read.data.metaGeneration, undefined)
      assert.equal(read.data._generation, undefined)
      assert.equal(read.data._local, undefined)
      assert.equal(read.data.generation, undefined)

      // An update is a later stamped write under the same generation.
      const updated = await alice.pws.request({
        url: metaUrl('etag-put'),
        method: 'PUT',
        json: spaceMetadata('etag-put', 'Put Again')
      })
      assert.equal(updated.status, 204)
      const updatedEtag = updated.headers.get('etag')
      assertEtagAdvanced({
        before: createdEtag,
        after: updatedEtag,
        container: true
      })
      assert.equal(etagGeneration(updatedEtag!), etagGeneration(createdEtag!))
    })

    it('[root] Get Space with a matching If-None-Match is 304', async () => {
      const created = await alice.pws.request({
        url: metaUrl('etag-304'),
        method: 'PUT',
        json: spaceMetadata('etag-304', 'Cached')
      })
      const etag = created.headers.get('etag')!
      const unchanged = await responseOf(
        alice.pws.request({
          url: metaUrl('etag-304'),
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(unchanged.status, 304)
      assert.equal(unchanged.headers.get('etag'), etag)
      assert.equal(await unchanged.text(), '')

      // A stale validator gets the full Space Metadata object.
      const stale = await alice.pws.request({
        url: metaUrl('etag-304'),
        method: 'GET',
        headers: { 'if-none-match': '"99"' }
      })
      assert.equal(stale.status, 200)
      assert.equal(stale.data.id, 'etag-304')
    })

    it('[root] an under-authorized conditional GET still gets the 404 mask', async () => {
      const created = await alice.pws.request({
        url: metaUrl('etag-masked'),
        method: 'PUT',
        json: spaceMetadata('etag-masked', 'Masked')
      })
      const etag = created.headers.get('etag')!
      const masked = await responseOf(
        bob.pws.request({
          url: metaUrl('etag-masked'),
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(masked.status, 404)
    })

    it('[root] PUT with If-None-Match: * creates an absent Space and 412s on a present one', async () => {
      const created = await alice.pws.request({
        url: metaUrl('guarded-create'),
        method: 'PUT',
        json: { ...spaceMetadata('guarded-create', 'Winner'), type: ['Space'] },
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 201)
      parseEtagSegments(created.headers.get('etag'), { container: true })

      // The loser of a create race: same guarded PUT against the now-present
      // Space, refused without touching the stored Space Metadata object.
      const thrown = await requestError(
        alice.pws.request({
          url: metaUrl('guarded-create'),
          method: 'PUT',
          json: spaceMetadata('guarded-create', 'Loser'),
          headers: { 'if-none-match': '*' }
        })
      )
      assert.equal(thrown.response.status, 412)
      assert.equal(thrown.data.type, 'https://w3id.org/pws#precondition-failed')
      const stored = await alice.pws.space('guarded-create').describe()
      assert.equal(stored.name, 'Winner')
    })

    it('[root] PUT with If-Match is a compare-and-swap on the Space Metadata ETag', async () => {
      const created = await alice.pws.request({
        url: metaUrl('cas'),
        method: 'PUT',
        json: spaceMetadata('cas', 'One')
      })
      const current = created.headers.get('etag')!

      const stale = await requestError(
        alice.pws.request({
          url: metaUrl('cas'),
          method: 'PUT',
          json: spaceMetadata('cas', 'Stale'),
          headers: { 'if-match': '"99"' }
        })
      )
      assert.equal(stale.response.status, 412)
      assert.equal((await alice.pws.space('cas').describe()).name, 'One')

      const swapped = await alice.pws.request({
        url: metaUrl('cas'),
        method: 'PUT',
        json: spaceMetadata('cas', 'Two'),
        headers: { 'if-match': current }
      })
      assert.equal(swapped.status, 204)
      assertEtagAdvanced({
        before: current,
        after: swapped.headers.get('etag'),
        container: true
      })
      assert.equal((await alice.pws.space('cas').describe()).name, 'Two')

      // The consumed validator no longer matches.
      const replay = await requestError(
        alice.pws.request({
          url: metaUrl('cas'),
          method: 'PUT',
          json: spaceMetadata('cas', 'Three'),
          headers: { 'if-match': current }
        })
      )
      assert.equal(replay.response.status, 412)
    })

    it('[root] If-Match on an absent Space is 412, not a create', async () => {
      const thrown = await requestError(
        alice.pws.request({
          url: metaUrl('cas-absent'),
          method: 'PUT',
          json: spaceMetadata('cas-absent', 'Never'),
          headers: { 'if-match': '"abc.1"' }
        })
      )
      assert.equal(thrown.response.status, 412)
      assert.equal(await alice.pws.space('cas-absent').describe(), null)
    })

    it('[root] an unconditional PUT still upserts (last writer wins)', async () => {
      await alice.pws.request({
        url: metaUrl('unconditional'),
        method: 'PUT',
        json: spaceMetadata('unconditional', 'First')
      })
      const second = await alice.pws.request({
        url: metaUrl('unconditional'),
        method: 'PUT',
        json: spaceMetadata('unconditional', 'Second')
      })
      assert.equal(second.status, 204)
      assert.equal(
        (await alice.pws.space('unconditional').describe()).name,
        'Second'
      )
    })

    it('[root] a Space deleted and re-created under the same id gets a fresh generation', async () => {
      const first = await alice.pws.request({
        url: metaUrl('regen'),
        method: 'PUT',
        json: spaceMetadata('regen', 'First life')
      })
      const oldEtag = first.headers.get('etag')!
      await alice.pws.space('regen').delete()
      const second = await alice.pws.request({
        url: metaUrl('regen'),
        method: 'PUT',
        json: spaceMetadata('regen', 'Second life')
      })
      const newEtag = second.headers.get('etag')!
      parseEtagSegments(newEtag, { container: true })
      assert.notEqual(etagGeneration(newEtag), etagGeneration(oldEtag))
      // The old validator matches nothing on the new record.
      const conditional = await responseOf(
        alice.pws.request({
          url: metaUrl('regen'),
          method: 'GET',
          headers: { 'if-none-match': oldEtag }
        })
      )
      assert.equal(conditional.status, 200)
    })

    // Settles a request to its HTTP status, success or refusal alike.
    const statusOf = async (pending: Promise<any>): Promise<number> =>
      (await responseOf(pending)).status

    it("a self-signed create-via-PUT racing a POST /spaces/ cannot replace the winner's controller", async () => {
      // Alice POSTs and Bob PUTs the same id; whichever lands first owns it.
      // A losing PUT is re-authorized as an update of Alice's Space (404).
      const rounds = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const spaceId = crypto.randomUUID()
          const [posted, put] = await Promise.all([
            statusOf(
              alice.pws.request({
                url: new URL('/spaces/', baseServerUrl).toString(),
                method: 'POST',
                json: { id: spaceId, controller: alice.did }
              })
            ),
            statusOf(
              bob.pws.request({
                url: metaUrl(spaceId),
                method: 'PUT',
                json: { id: spaceId, controller: bob.did }
              })
            )
          ])
          return { spaceId, posted, put }
        })
      )
      for (const { spaceId, posted, put } of rounds) {
        if (posted === 201) {
          assert.equal(put, 404, `${spaceId}: Bob's PUT should be refused`)
          const stored = await alice.pws.space(spaceId).describe()
          assert.equal(stored!.controller, alice.did)
        } else {
          assert.equal(posted, 409, `${spaceId}: Alice's POST should conflict`)
          assert.equal(put, 201)
          const stored = await bob.pws.space(spaceId).describe()
          assert.equal(stored!.controller, bob.did)
        }
      }
    })

    it('[root] two concurrent unconditional create-via-PUTs by one controller yield one 201 and one 204', async () => {
      const spaceId = crypto.randomUUID()
      const statuses = await Promise.all(
        ['First', 'Second'].map(name =>
          statusOf(
            alice.pws.request({
              url: metaUrl(spaceId),
              method: 'PUT',
              json: spaceMetadata(spaceId, name)
            })
          )
        )
      )
      // The losing create is re-run as an update of the
      // winner's Space, so it still succeeds (last writer wins).
      assert.deepEqual(statuses.slice().sort(), [201, 204])
    })

    it("[root] a concurrent create-via-PUT naming a different type cannot change the winner's type", async () => {
      const spaceId = crypto.randomUUID()
      const types = [['Space'], ['ExampleSpace', 'Space']]
      const statuses = await Promise.all(
        types.map(type =>
          statusOf(
            alice.pws.request({
              url: metaUrl(spaceId),
              method: 'PUT',
              json: { ...spaceMetadata(spaceId, 'Typed'), type }
            })
          )
        )
      )
      // Whichever create lands first sets the type; the other is replayed as
      // an update and refused by the immutability check.
      assert.deepEqual(statuses.slice().sort(), [201, 400])
      const winner = types[statuses.indexOf(201)]
      const stored = await alice.pws.space(spaceId).describe()
      assert.deepEqual(stored!.type, winner)
    })
  })

  describe('Create Space chain of authorization', () => {
    // The spec defines Create Space (POST and create-via-PUT) authorization as
    // *authorized by* the body's controller: signed directly by it, or via a
    // delegation chain rooted in it (delegated provisioning). A request bound
    // to neither is rejected with `controller-mismatch` (400).

    /**
     * Performs a signed request expected to fail, returning the thrown error.
     *
     * @param options {object}
     * @param options.client {PwsClient}
     * @param options.request {object}   `pws.request()` input
     * @returns {Promise<any>}
     */
    async function requestError({
      client,
      request
    }: {
      client: any
      request: object
    }): Promise<any> {
      try {
        await client.request(request)
      } catch (err) {
        return err
      }
      assert.fail('expected the request to be rejected')
    }

    it('[root] POST signed by a different DID than the body controller yields controller-mismatch (400)', async () => {
      // Bob signs a bare-root invocation but names Alice as the controller:
      // Alice has authorized nothing, so this must be rejected.
      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: bob.pws,
        request: {
          url: new URL('/spaces/', baseServerUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Unconsented', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/controller')

      // The Space was not created: its named controller cannot read it.
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })

    it("[delegated] a provisioning service creates a Space on Alice's behalf via POST", async () => {
      // Alice delegates a POST /spaces/ capability to her provisioning app...
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['POST'],
        target: spacesUrl
      })

      // ...and the app creates a Space that Alice controls from the start.
      const spaceId = crypto.randomUUID()
      const response = await aliceDelegatedApp.pws.request({
        url: spacesUrl,
        method: 'POST',
        capability: zcap,
        json: {
          id: spaceId,
          name: 'Provisioned for Alice',
          controller: alice.did
        }
      })
      assert.equal(response.status, 201)
      assert.equal(response.data.controller, alice.did)

      // The stored controller is Alice's DID: her root key reads the Space.
      const description = await alice.pws.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
      assert.equal(description?.name, 'Provisioned for Alice')
    })

    it('[delegated] a POST chain not rooted in the body controller yields controller-mismatch (400)', async () => {
      // The app holds a capability delegated by Alice, but names Bob as the
      // controller: the chain is not rooted in Bob, so Bob has consented to
      // nothing.
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['POST'],
        target: spacesUrl
      })

      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: aliceDelegatedApp.pws,
        request: {
          url: spacesUrl,
          method: 'POST',
          capability: zcap,
          json: { id: spaceId, name: 'Squatted on Bob', controller: bob.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      // The differentiated cause (spec SHOULD): the chain roots in Alice's
      // DID, not the body's controller (Bob).
      assert.match(
        expectedError.data.errors[0].detail,
        new RegExp(`rooted in "${alice.did}", not the body's controller`)
      )
      assert.equal(await bob.pws.space(spaceId).describe(), null)
    })

    it('[delegated] an expired delegation names the expiry in the controller-mismatch detail', async () => {
      // Alice's delegation to her app has expired: the chain is correctly
      // rooted in the body's controller, so the differentiated cause (spec
      // SHOULD) is the expiry -- Alice must re-delegate. Delegated through the
      // raw ZcapClient so the delegation proof can be backdated before its own
      // `expires` (`grant` cannot mint an already-expired zcap); well past the
      // verifier's clock-skew tolerance.
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const zcap = await client({ signer: alice.signer }).delegate({
        controller: aliceDelegatedApp.did,
        invocationTarget: spacesUrl,
        allowedActions: ['POST'],
        expires: new Date(Date.now() - 10 * 60 * 1000),
        now: Date.now() - 20 * 60 * 1000
      })

      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: aliceDelegatedApp.pws,
        request: {
          url: spacesUrl,
          method: 'POST',
          capability: zcap,
          json: { id: spaceId, name: 'Too Late', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      assert.match(
        expectedError.data.errors[0].detail,
        /a delegation in the chain expired at/
      )
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })

    it('[delegated] a tampered delegation proof names the failed proof in the controller-mismatch detail', async () => {
      // The chain is rooted in the body's controller and unexpired, but its
      // delegation proof does not verify: the differentiated cause (spec
      // SHOULD) falls through to the failed-proof clause.
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['POST'],
        target: spacesUrl
      })
      const proofValue: string = zcap.proof.proofValue
      const tampered = {
        ...zcap,
        proof: {
          ...zcap.proof,
          proofValue:
            proofValue.slice(0, -2) + (proofValue.endsWith('aa') ? 'bb' : 'aa')
        }
      }

      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: aliceDelegatedApp.pws,
        request: {
          url: spacesUrl,
          method: 'POST',
          capability: tampered,
          json: { id: spaceId, name: 'Tampered', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      assert.match(
        expectedError.data.errors[0].detail,
        /the delegation chain proof failed verification/
      )
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })

    it('[root] create-via-PUT signed by a different DID than the body controller yields controller-mismatch (400)', async () => {
      // The consent gap this closes: a PUT create used to verify against the
      // signer, never tying the invocation to the body's controller.
      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: bob.pws,
        request: {
          url: new URL(`/space/${spaceId}/meta`, baseServerUrl).toString(),
          method: 'PUT',
          json: { name: 'Unconsented', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })

    it('[root] PUT whose body id does not match the URL space id yields invalid-request-body (400)', async () => {
      // The Space `id` is immutable: a PUT body that carries a non-matching
      // `id` is rejected before any controller/capability check.
      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: alice.pws,
        request: {
          url: new URL(`/space/${spaceId}/meta`, baseServerUrl).toString(),
          method: 'PUT',
          json: { id: crypto.randomUUID(), controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#invalid-request-body'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/id')

      // The Space was not created.
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })

    it("[delegated] a provisioning service creates a Space on Alice's behalf via PUT", async () => {
      // Alice delegates a PUT capability for the (not yet existing) Space's
      // Metadata URL.
      const spaceId = crypto.randomUUID()
      const metaUrl = new URL(
        `/space/${spaceId}/meta`,
        baseServerUrl
      ).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['PUT'],
        target: metaUrl
      })

      const response = await aliceDelegatedApp.pws.request({
        url: metaUrl,
        method: 'PUT',
        capability: zcap,
        json: { name: 'Provisioned by PUT', controller: alice.did }
      })
      assert.equal(response.status, 201)

      const description = await alice.pws.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
      assert.equal(description?.name, 'Provisioned by PUT')
    })

    it('[delegated] a PUT-create chain not rooted in the body controller yields controller-mismatch (400)', async () => {
      const spaceId = crypto.randomUUID()
      const metaUrl = new URL(
        `/space/${spaceId}/meta`,
        baseServerUrl
      ).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['PUT'],
        target: metaUrl
      })

      const expectedError = await requestError({
        client: aliceDelegatedApp.pws,
        request: {
          url: metaUrl,
          method: 'PUT',
          capability: zcap,
          json: { name: 'Squatted on Bob', controller: bob.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      assert.match(
        expectedError.data.errors[0].detail,
        new RegExp(`rooted in "${alice.did}", not the body's controller`)
      )
      assert.equal(await bob.pws.space(spaceId).describe(), null)
    })

    it('[delegated] a PUT-create chain rooted at a different target names the root target in the detail', async () => {
      // Alice's delegation chain roots at Space A's root capability, but its
      // invocationTarget (and the app's invocation) is Space B's Metadata URL:
      // the differentiated cause (spec SHOULD) names the mismatched root
      // target and Space B's root target.
      const grantedSpaceId = crypto.randomUUID()
      const grantedSpaceUrl = new URL(
        `/space/${grantedSpaceId}/`,
        baseServerUrl
      ).toString()

      const spaceId = crypto.randomUUID()
      const spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
      const metaUrl = new URL(
        `/space/${spaceId}/meta`,
        baseServerUrl
      ).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['PUT'],
        target: metaUrl,
        capability: `urn:zcap:root:${encodeURIComponent(grantedSpaceUrl)}`
      })
      const expectedError = await requestError({
        client: aliceDelegatedApp.pws,
        request: {
          url: metaUrl,
          method: 'PUT',
          capability: zcap,
          json: { name: 'Wrong Root', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://w3id.org/pws#controller-mismatch'
      )
      assert.match(
        expectedError.data.errors[0].detail,
        new RegExp(`rooted at "${grantedSpaceUrl}", not at "${spaceUrl}"`)
      )
      assert.equal(await alice.pws.space(spaceId).describe(), null)
    })

    it('[root] an update still verifies against the stored controller, not the body', async () => {
      // Once the Space exists, only the *stored* controller (or its delegate)
      // may update it -- the body's controller is just the proposed new value.
      // Bob cannot seize Alice's Space by PUTting it with himself as the
      // controller (masked as 404, per the error-handling privacy invariant).
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: "Alice's Space",
        controller: alice.did
      })

      const expectedError = await requestError({
        client: bob.pws,
        request: {
          url: new URL(`/space/${spaceId}/meta`, baseServerUrl).toString(),
          method: 'PUT',
          json: { name: 'Seized', controller: bob.did }
        }
      })
      assert.equal(expectedError.response.status, 404)

      const description = await alice.pws.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
      assert.equal(description?.name, "Alice's Space")
    })
  })

  describe('List Spaces (GET /spaces/)', () => {
    // The suite's server is shared across tests, so the listings below assert
    // containment / exclusion of known spaces rather than exact contents.

    it('[root] a controller lists only their own spaces', async () => {
      const aliceSpaceId = crypto.randomUUID()
      const bobSpaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: aliceSpaceId,
        name: 'Alice Listing Test',
        controller: alice.did
      })
      await bob.pws.createSpace({
        id: bobSpaceId,
        name: 'Bob Listing Test',
        controller: bob.did
      })

      const listing = await alice.pws.listSpaces()
      assert.equal(listing.url, '/spaces/')
      assert.equal(listing.totalItems, listing.items.length)
      assert.deepStrictEqual(
        listing.items.find((item: any) => item.id === aliceSpaceId),
        {
          id: aliceSpaceId,
          name: 'Alice Listing Test',
          url: `/space/${aliceSpaceId}/`,
          type: ['Space']
        }
      )
      // Bob's space is invisible to Alice...
      assert.ok(!listing.items.some((item: any) => item.id === bobSpaceId))

      // ...and vice versa.
      const bobListing = await bob.pws.listSpaces()
      assert.ok(bobListing.items.some((item: any) => item.id === bobSpaceId))
      assert.ok(!bobListing.items.some((item: any) => item.id === aliceSpaceId))
    })

    it('[root] a signer controlling no spaces gets the empty listing', async () => {
      // The delegated app's own DID controls no Space (it only ever acts via
      // delegation), so its bare-root listing is empty -- not an error.
      const listing = await aliceDelegatedApp.pws.listSpaces()
      assert.deepStrictEqual(listing, {
        url: '/spaces/',
        totalItems: 0,
        items: []
      })
    })

    it("[delegated] an app with a GET /spaces/ capability lists the delegator's spaces", async () => {
      const aliceSpaceId = crypto.randomUUID()
      const bobSpaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: aliceSpaceId,
        name: 'Delegated Listing Test',
        controller: alice.did
      })
      await bob.pws.createSpace({
        id: bobSpaceId,
        name: 'Bob Bystander Space',
        controller: bob.did
      })

      // Alice delegates List Spaces to her app...
      const spacesUrl = new URL('/spaces/', baseServerUrl).toString()
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET'],
        target: spacesUrl
      })

      // ...and the app sees the spaces of the chain's root (Alice), no others.
      const response = await aliceDelegatedApp.pws.request({
        url: spacesUrl,
        method: 'GET',
        capability: zcap
      })
      assert.equal(response.status, 200)
      const listing = response.data
      assert.equal(listing.totalItems, listing.items.length)
      assert.ok(listing.items.some((item: any) => item.id === aliceSpaceId))
      assert.ok(
        !listing.items.some((item: any) => item.id === bobSpaceId),
        "a chain rooted in Alice must not reveal Bob's spaces"
      )
    })
  })

  describe('Space Backends (/backends)', () => {
    // The single server-configured filesystem backend, registered as `default`.
    // The server backends head every listing: the `default` alias, then
    // each configured backend under its fixed id.
    const defaultBackendDescriptor = {
      id: 'default',
      name: 'Server Filesystem',
      managedBy: 'server',
      persistence: 'durable'
    }
    const serverBackendDescriptors = [
      defaultBackendDescriptor,
      { ...defaultBackendDescriptor, id: 'fs' }
    ]

    it('[signed] GET /backends lists the default backend descriptor', async () => {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Backends Test Space',
        controller: alice.did
      })

      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/backends`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.deepStrictEqual(response.data, serverBackendDescriptors)
    })

    it('anonymous GET /backends of a private space 404s (no leak)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Private Backends Space',
        controller: alice.did
      })

      const response = await fetch(
        new URL(`/space/${spaceId}/backends`, baseServerUrl)
      )
      assert.equal(response.status, 404)
    })

    it('anonymous GET /backends of a PublicCanRead space succeeds', async () => {
      const spaceId = crypto.randomUUID()
      const space = await alice.pws.createSpace({
        id: spaceId,
        name: 'Public Backends Space',
        controller: alice.did
      })
      await space.setPublic()

      const response = await fetch(
        new URL(`/space/${spaceId}/backends`, baseServerUrl)
      )
      assert.equal(response.status, 200)
      const backends = (await response.json()) as unknown[]
      assert.deepStrictEqual(backends, serverBackendDescriptors)
    })
  })
})
