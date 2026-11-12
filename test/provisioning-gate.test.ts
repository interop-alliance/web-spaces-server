/**
 * Provisioning gate tests (Vitest): the `authorizeProvisioning` plugin option
 * and the built-in onboarding-token check (`onboardingToken` /
 * `WAS_ONBOARDING_TOKEN`) over the open provisioning endpoints
 * (`POST /spaces/`, Create Space by Id at `PUT /space/:spaceId/meta`,
 * `POST /kms/keystores`). Covers the onboarding-token happy and error paths,
 * custom `grant`/`deny`/`verify` decisions and a fail-closed unknown decision,
 * the registration-time guards, and the default (neither configured) zcap path
 * as a regression guard.
 */
import { it, describe, afterEach } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { AuthorizeProvisioning } from '../src/types.js'
import {
  digestHeaderFor,
  openTempBackend,
  placeholderAuthHeader,
  rootInvocation,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Provisioning gate', () => {
  let alice: any
  let baseServerUrl: string
  const TOKEN = 'super-secret-onboarding-token'

  // Per-test teardown: each `boot()` registers its server + temp dir here.
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  /**
   * Boots a server on an OS-assigned ephemeral port with the given provisioning
   * config over a fresh temp dir, sets the suite `baseServerUrl` and rebuilds Alice's
   * client to match, and registers its teardown for `afterEach`.
   * @param options {object}
   * @param [options.onboardingToken] {string}
   * @param [options.authorizeProvisioning] {AuthorizeProvisioning}
   * @returns {Promise<{ fastify: FastifyInstance, backend: FileSystemBackend }>}
   */
  async function boot({
    onboardingToken,
    authorizeProvisioning
  }: {
    onboardingToken?: string
    authorizeProvisioning?: AuthorizeProvisioning
  } = {}): Promise<{ fastify: FastifyInstance; backend: FileSystemBackend }> {
    const backend = await openTempBackend({ prefix: 'was-provisioning-' })
    const started = await startTestServer({
      backend,
      ...(onboardingToken !== undefined && { onboardingToken }),
      ...(authorizeProvisioning !== undefined && { authorizeProvisioning })
    })
    const { fastify } = started
    baseServerUrl = started.baseServerUrl
    ;({ alice } = await zcapClients({ baseServerUrl }))
    cleanups.push(async () => {
      await fastify.close()
    })
    return { fastify, backend }
  }

  /** A minimal Create Space body naming Alice as controller. */
  function createSpaceBody(id: string) {
    return { id, name: 'Provisioned Space', controller: alice.did }
  }

  /**
   * PUTs a Space Metadata body with a Bearer token and no zcap invocation.
   * @param options {object}
   * @param options.spaceId {string}
   * @param options.token {string}
   * @param options.body {object}
   * @returns {Promise<Response>}
   */
  async function putMetaWithBearer({
    spaceId,
    token,
    body
  }: {
    spaceId: string
    token: string
    body: object
  }): Promise<Response> {
    return fetch(new URL(`/space/${spaceId}/meta`, baseServerUrl), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }

  describe('onboardingToken configured', () => {
    it('POST /spaces/ with a correct Bearer token creates the space (201)', async () => {
      const { backend } = await boot({ onboardingToken: TOKEN })
      const spaceId = `token-space-${crypto.randomUUID()}`
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody(spaceId))
      })
      assert.equal(response.status, 201)
      assert.equal(
        response.headers.get('location'),
        `${baseServerUrl}space/${spaceId}/`
      )
      // The space landed in storage with the body's controller.
      const stored = await backend.getSpaceMetadata({ spaceId })
      assert.equal(stored?.controller, alice.did)

      // Normal auth still works afterwards: a signed GET by the controller
      // returns the Space Metadata object (200), proving the token gate does not
      // disturb the zcap path for subsequent operations.
      const signed = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'GET'
      })
      assert.equal(signed.status, 200)
    })

    it('POST /spaces/ with a Bearer token stores and echoes no client-supplied createdBy or unknown member', async () => {
      await boot({ onboardingToken: TOKEN })
      const spaceId = `token-strip-${crypto.randomUUID()}`
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          ...createSpaceBody(spaceId),
          createdBy: 'did:key:zAttacker',
          foo: 1
        })
      })
      assert.equal(response.status, 201)
      const echoed = (await response.json()) as Record<string, unknown>
      assert.equal('createdBy' in echoed, false)
      assert.equal('foo' in echoed, false)
      assert.equal(echoed.name, 'Provisioned Space')

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.status, 200)
      const stored = read.data as Record<string, unknown>
      assert.equal('createdBy' in stored, false)
      assert.equal('foo' in stored, false)
    })

    it('POST /spaces/ with no Authorization header returns 401', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody('no-auth'))
      })
      assert.equal(response.status, 401)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('POST /spaces/ with a wrong Bearer token returns 403', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer not-the-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody('wrong-token'))
      })
      assert.equal(response.status, 403)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('POST /spaces/ with a zcap-signed invocation but no token returns 401', async () => {
      await boot({ onboardingToken: TOKEN })
      let thrown: any
      try {
        await alice.pws.createSpace(createSpaceBody('signed-no-token'))
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a signed create with no token to be rejected')
      assert.equal(thrown.status, 401)
    })

    it('POST /kms/keystores with a correct Bearer token creates the keystore (201)', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/kms/keystores', baseServerUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ controller: alice.did, sequence: 0 })
      })
      assert.equal(response.status, 201)
      assert.ok(response.headers.get('location'))
    })

    it('POST /kms/keystores with no token returns 401', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/kms/keystores', baseServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controller: alice.did, sequence: 0 })
      })
      assert.equal(response.status, 401)
    })

    it('POST /spaces (no trailing slash) with a correct Bearer token gets the canonical 308 redirect', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces', baseServerUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody('no-slash')),
        redirect: 'manual'
      })
      assert.equal(response.status, 308)
      assert.equal(response.headers.get('location'), '/spaces/')
    })

    it('Create Space by Id with a correct Bearer token creates the space (201)', async () => {
      const { backend } = await boot({ onboardingToken: TOKEN })
      const spaceId = `token-put-${crypto.randomUUID()}`
      const response = await putMetaWithBearer({
        spaceId,
        token: TOKEN,
        body: createSpaceBody(spaceId)
      })
      assert.equal(response.status, 201)
      assert.equal(
        response.headers.get('location'),
        `${baseServerUrl}space/${spaceId}/`
      )
      const stored = await backend.getSpaceMetadata({ spaceId })
      assert.equal(stored?.controller, alice.did)
      // A token-provisioned create carries no invocation to record.
      assert.equal(stored?.createdBy, undefined)
    })

    it('Create Space by Id with a zcap-signed invocation but no token returns 401', async () => {
      const { backend } = await boot({ onboardingToken: TOKEN })
      const spaceId = `signed-put-${crypto.randomUUID()}`
      let thrown: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/meta`,
          method: 'PUT',
          json: createSpaceBody(spaceId)
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a signed create-by-PUT with no token to fail')
      assert.equal(thrown.response.status, 401)
      assert.equal(await backend.getSpaceMetadata({ spaceId }), undefined)
    })

    it('Create Space by Id with a wrong Bearer token returns 403', async () => {
      const { backend } = await boot({ onboardingToken: TOKEN })
      const spaceId = `wrong-put-${crypto.randomUUID()}`
      const response = await putMetaWithBearer({
        spaceId,
        token: 'not-the-token',
        body: createSpaceBody(spaceId)
      })
      assert.equal(response.status, 403)
      assert.equal(await backend.getSpaceMetadata({ spaceId }), undefined)
    })

    it('an update of an existing Space by PUT is not gated (204)', async () => {
      await boot({ onboardingToken: TOKEN })
      const spaceId = `token-update-${crypto.randomUUID()}`
      const created = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(createSpaceBody(spaceId))
      })
      assert.equal(created.status, 201)
      const updated = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'PUT',
        json: { ...createSpaceBody(spaceId), name: 'Renamed' }
      })
      assert.equal(updated.status, 204)
    })

    it('a Bearer token cannot update an existing Space by PUT', async () => {
      const { backend } = await boot({ onboardingToken: TOKEN })
      const spaceId = `token-no-update-${crypto.randomUUID()}`
      await backend.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller: alice.did }
      })
      const response = await putMetaWithBearer({
        spaceId,
        token: TOKEN,
        body: { ...createSpaceBody(spaceId), name: 'Hijack' }
      })
      // An existing Space is not gated, so the Bearer header reaches
      // `parseAuthHeaders`, which cannot parse it as an HTTP Signature.
      assert.equal(response.status, 400)
      const stored = await backend.getSpaceMetadata({ spaceId })
      assert.equal(stored?.name, undefined)
    })

    it('non-provisioning routes are unaffected: anonymous GET /spaces/ is 200', async () => {
      await boot({ onboardingToken: TOKEN })
      const response = await fetch(new URL('/spaces/', baseServerUrl))
      assert.equal(response.status, 200)
    })
  })

  describe('custom authorizeProvisioning', () => {
    it("a 'deny' decision returns 403 on POST /spaces/", async () => {
      await boot({ authorizeProvisioning: async () => 'deny' as const })
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody('denied'))
      })
      assert.equal(response.status, 403)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it("a 'grant' decision creates the space with no auth headers (201)", async () => {
      const { backend } = await boot({
        authorizeProvisioning: async () => 'grant' as const
      })
      const spaceId = `granted-${crypto.randomUUID()}`
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody(spaceId))
      })
      assert.equal(response.status, 201)
      const stored = await backend.getSpaceMetadata({ spaceId })
      assert.equal(stored?.controller, alice.did)
    })

    it("a 'deny' decision returns 403 on Create Space by Id", async () => {
      const { backend } = await boot({
        authorizeProvisioning: async () => 'deny' as const
      })
      const spaceId = `denied-put-${crypto.randomUUID()}`
      let thrown: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/meta`,
          method: 'PUT',
          json: createSpaceBody(spaceId)
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a denied create-by-PUT to fail')
      assert.equal(thrown.response.status, 403)
      assert.equal(await backend.getSpaceMetadata({ spaceId }), undefined)
    })

    it('an unknown decision fails closed (403)', async () => {
      const { backend } = await boot({
        authorizeProvisioning: (async () =>
          'allow') as unknown as AuthorizeProvisioning
      })
      const spaceId = `unknown-${crypto.randomUUID()}`
      const response = await fetch(new URL('/spaces/', baseServerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSpaceBody(spaceId))
      })
      assert.equal(response.status, 403)
      assert.equal(await backend.getSpaceMetadata({ spaceId }), undefined)
    })

    it("a 'grant' for a Space created before the handler runs is refused (404)", async () => {
      const spaceId = `raced-${crypto.randomUUID()}`
      // The callback stands in for a concurrent create landing between the
      // gate's existence check and the handler's read.
      const { backend } = await boot({
        authorizeProvisioning: async ({ request }) => {
          await request.server.storage.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              controller: alice.did,
              name: 'Winner'
            }
          })
          return 'grant' as const
        }
      })
      const response = await fetch(
        new URL(`/space/${spaceId}/meta`, baseServerUrl),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...createSpaceBody(spaceId), name: 'Loser' })
        }
      )
      assert.equal(response.status, 404)
      const stored = await backend.getSpaceMetadata({ spaceId })
      assert.equal(stored?.name, 'Winner')
    })

    it('a Space deleted after the gate took the PUT for an update still reaches the policy (403)', async () => {
      let policyCalls = 0
      const { backend } = await boot({
        authorizeProvisioning: async () => {
          policyCalls++
          return 'deny' as const
        }
      })
      const spaceId = `deleted-${crypto.randomUUID()}`
      await backend.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller: alice.did }
      })
      // The first read of this Space is the gate's existence check. Deleting
      // the Space right after it stands in for a concurrent Delete Space
      // landing before the handler's read.
      const getSpaceMetadata = backend.getSpaceMetadata.bind(backend)
      let reads = 0
      backend.getSpaceMetadata = async options => {
        const found = await getSpaceMetadata(options)
        if (options.spaceId === spaceId && reads++ === 0) {
          await backend.deleteSpace({ spaceId })
        }
        return found
      }
      let thrown: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${spaceId}/meta`,
          method: 'PUT',
          json: createSpaceBody(spaceId)
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected the create to be put to the policy and denied'
      )
      assert.equal(thrown.response.status, 403)
      assert.equal(policyCalls, 1)
      assert.equal(await getSpaceMetadata({ spaceId }), undefined)
    })

    it.each([
      [
        'a did:key',
        'did:key:z6MkgpJp9jpAsqFCKqKMvHsAL5VEnkcd8FhhZdwnX33BFDgs' +
          '#z6MkgpJp9jpAsqFCKqKMvHsAL5VEnkcd8FhhZdwnX33BFDgs'
      ],
      [
        'a foreign did:webvh',
        'did:webvh:QmfZTTAnvwFDEU4Z37Cpx8zJBpPvC1JGjprQEkqkV4cH3j:' +
          'peer.example.com#key-1'
      ]
    ])(
      "a 'grant' reached after the gate took the PUT for an update records no createdBy from an unverified keyId naming %s",
      async (_label, keyId) => {
        // The callback grants on anything, standing in for one that grants
        // on some header other than the `Signature` Authorization.
        const { backend } = await boot({
          authorizeProvisioning: async () => 'grant' as const
        })
        const spaceId = `late-grant-${crypto.randomUUID()}`
        await backend.writeSpace({
          spaceId,
          spaceMetadata: { id: spaceId, type: ['Space'], controller: alice.did }
        })
        // The gate's existence check sees the Space, so the auth hooks parse
        // the `Signature` header. Deleting the Space right after that read
        // sends the handler down the create branch, where it consults the
        // policy late.
        const getSpaceMetadata = backend.getSpaceMetadata.bind(backend)
        let reads = 0
        backend.getSpaceMetadata = async options => {
          const found = await getSpaceMetadata(options)
          if (options.spaceId === spaceId && reads++ === 0) {
            await backend.deleteSpace({ spaceId })
          }
          return found
        }
        const metaUrl = new URL(
          `/space/${spaceId}/meta`,
          baseServerUrl
        ).toString()
        // The signature is never verified. The digest hook still needs the
        // `digest` header covered and a `Digest` that matches the body.
        const body = JSON.stringify(createSpaceBody(spaceId))
        const response = await fetch(metaUrl, {
          method: 'PUT',
          headers: {
            authorization: placeholderAuthHeader({ keyId }),
            'capability-invocation': rootInvocation({ target: metaUrl }),
            'content-type': 'application/json',
            digest: digestHeaderFor(body)
          },
          body
        })
        assert.equal(response.status, 201)
        const echoed = (await response.json()) as Record<string, unknown>
        assert.equal('createdBy' in echoed, false)
        const stored = await getSpaceMetadata({ spaceId })
        assert.equal(stored?.controller, alice.did)
        assert.equal(stored?.createdBy, undefined)
      }
    )

    it("a 'verify' decision leaves the normal zcap create-space path working (201)", async () => {
      await boot({ authorizeProvisioning: async () => 'verify' as const })
      const space = await alice.pws.createSpace(
        createSpaceBody(`verified-${crypto.randomUUID()}`)
      )
      assert.ok(space.id)
    })
  })

  it('rejects on ready() when both onboardingToken and authorizeProvisioning are set', async () => {
    const backend = await openTempBackend({ prefix: 'was-provisioning-' })
    // Never listens -- the rejection happens at `ready()` -- so any valid base
    // URL will do, and this test stays independent of the boots above.
    const fastify = createApp({
      serverUrl: 'http://localhost',
      backend,
      onboardingToken: TOKEN,
      authorizeProvisioning: async () => 'grant' as const
    })
    try {
      await assert.rejects(async () => {
        await fastify.ready()
      }, /authorizeProvisioning and onboardingToken are mutually exclusive/)
    } finally {
      await fastify.close()
      // A refused option fails registration before the plugin wires the
      // backend's close.
      await backend.close()
    }
  })

  it('rejects on ready() when onboardingToken is empty', async () => {
    const backend = await openTempBackend({ prefix: 'was-provisioning-' })
    const fastify = createApp({
      serverUrl: 'http://localhost',
      backend,
      onboardingToken: '  '
    })
    try {
      await assert.rejects(async () => {
        await fastify.ready()
      }, /onboardingToken must not be empty/)
    } finally {
      await fastify.close()
      // A refused option fails registration before the plugin wires the
      // backend's close.
      await backend.close()
    }
  })

  it('default (neither option): a self-signed create by PUT still returns 201', async () => {
    await boot()
    const spaceId = `default-put-${crypto.randomUUID()}`
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/meta`,
      method: 'PUT',
      json: createSpaceBody(spaceId)
    })
    assert.equal(response.status, 201)
  })

  it('default (neither option): a zcap-signed create space still returns 201', async () => {
    await boot()
    const space = await alice.pws.createSpace(
      createSpaceBody(`default-${crypto.randomUUID()}`)
    )
    assert.ok(space.id)
  })
})
