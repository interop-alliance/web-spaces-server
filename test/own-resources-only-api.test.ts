/**
 * `OwnResourcesOnly` caveat tests (Vitest, HTTP level): a capability carrying
 * the caveat `{ type: 'OwnResourcesOnly' }` reaches only the Resources whose
 * `createdBy` lists the controller of that capability (the principal). Every
 * capability delegated beneath it acts as the same principal, and a caveat on
 * two links of one chain means both principals must be listed.
 *
 * Covered here: the must-understand rule for an unknown caveat type (a Space
 * route and a `/kms` route), creates, reads and writes of the principal's own
 * Resource and of another party's (its `meta` and its chunks included), the
 * refusal coming before a precondition or the write-once rule, a second app
 * of the same principal, two caveats in one chain, the filtered Collection
 * listing, the container reads the caveat leaves alone, the routes it refuses,
 * revocation, the proof suite rule, the caveat shape, a public-read policy,
 * a Resource with no `createdBy`, and the service description.
 *
 * Every refusal is the masked `not-found` (404), the body an absent target
 * gets. Invocations are raw `@interop/ezcap` requests, since the wire shape
 * of each capability is the point.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { ZcapClient } from '@interop/ezcap'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import jsigs from '@interop/jsonld-signatures'
import {
  CapabilityDelegation,
  constants as zcapConstants,
  documentLoader
} from '@interop/zcap'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { securityLoader } from '@interop/security-document-loader'
import {
  KmsClient,
  KeystoreAgent,
  type AsymmetricKey
} from '@interop/webkms-client'
import type { ISigner } from '@interop/data-integrity-core'
import type { ICaveat } from '@interop/data-integrity-core/zcap'

import { spaceRevocationsPath } from '../src/lib/paths.js'
import { rootCapabilityId } from '../src/zcap.js'
import {
  anHourFromNow,
  client,
  genesisLine,
  oneEpoch,
  openTempBackend,
  rootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

/**
 * The caveat under test.
 */
const OWN_RESOURCES_ONLY: ICaveat = { type: 'OwnResourcesOnly' }

/**
 * The masked `not-found` problem type.
 */
const NOT_FOUND = 'https://w3id.org/pws#not-found'

/**
 * The PWS action vocabulary every data grant here carries.
 */
const ALL_ACTIONS = ['GET', 'POST', 'PUT', 'DELETE']

/**
 * One chunk's bytes.
 */
const CHUNK_BYTES = new Uint8Array([1, 2, 3])

/**
 * A test identity: a `did:key` and its signer.
 */
interface Identity {
  did: string
  signer: ISigner
}

/**
 * What a request answered, whether it succeeded or was refused.
 */
interface Outcome {
  status: number
  data: any
  headers?: Headers
  response?: any
}

/**
 * Awaits a request and returns its status, parsed body and headers, from the
 * response or from the error the client raised for a non-2xx status.
 *
 * @param promise {Promise<any>}   the request
 * @returns {Promise<Outcome>}
 */
async function outcome(promise: Promise<any>): Promise<Outcome> {
  try {
    const response = await promise
    return {
      status: response.status,
      data: response.data,
      headers: response.headers,
      response
    }
  } catch (err: any) {
    if (typeof err?.status !== 'number') {
      throw err
    }
    return {
      status: err.status,
      data: err.data,
      headers: err.response?.headers,
      response: err.response
    }
  }
}

/**
 * Generates a fresh `did:key` identity.
 *
 * @returns {Promise<Identity>}
 */
async function newIdentity(): Promise<Identity> {
  const keyPair = await Ed25519VerificationKey.generate()
  return {
    did: `did:key:${keyPair.fingerprint()}`,
    signer: keyPair.didKeySigner()
  }
}

/**
 * A ZcapClient signing its delegation proofs with `Ed25519Signature2020`,
 * with the document loader the legacy suite needs (see
 * `delegation-suite-api.test.ts`).
 *
 * @param signer {ISigner}
 * @returns {ZcapClient}
 */
function legacyClient(signer: ISigner): ZcapClient {
  return new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: signer,
    delegationSigner: signer,
    documentLoader: securityLoader().build()
  })
}

describe('OwnResourcesOnly caveat', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any
  let backend: Awaited<ReturnType<typeof openTempBackend>>
  let guestA: Identity, guestA2: Identity, guestB: Identity, moderator: Identity
  // One expiry for every grant, so a sub-delegation never outlives its parent.
  let expires: Date

  const spaceId = `own-${randomUUID()}`
  let spaceUrl: string

  // The caveat grants on the `comments` Collection, and the moderator's.
  let guestAGrant: any, guestA2Grant: any, guestBGrant: any
  let moderatorGrant: any
  // Guest A's grant on the same target with no caveat, for comparisons.
  let guestAPlain: any

  /**
   * The canonical URL of a Space.
   */
  function spaceUrlFor(id: string): string {
    return new URL(`/space/${id}/`, baseServerUrl).toString()
  }

  /**
   * The canonical URL of a Space the URL addresses.
   */
  function spaceUrlOf(url: string): string {
    const [, , id] = new URL(url).pathname.split('/')
    return spaceUrlFor(id!)
  }

  /**
   * The canonical URL of a Collection, in the main Space by default.
   */
  function collectionUrl(collectionId = 'comments', space = spaceUrl): string {
    return `${space}${collectionId}/`
  }

  /**
   * The URL of a Resource, in the `comments` Collection by default.
   */
  function resourceUrl(resourceId: string, collection = collectionUrl()) {
    return `${collection}${resourceId}`
  }

  /**
   * Delegates a capability. From the Space's root by Alice when `parent` is
   * absent, else from `parent` by its holder `from`.
   */
  async function grant({
    to,
    target = collectionUrl(),
    actions = ALL_ACTIONS,
    caveats,
    from,
    parent,
    legacy = false
  }: {
    to: Identity
    target?: string
    actions?: string[]
    caveats?: ICaveat[]
    from?: Identity
    parent?: any
    legacy?: boolean
  }): Promise<any> {
    const delegator: Identity = from ?? alice
    const zcapClient = legacy
      ? legacyClient(delegator.signer)
      : client({ signer: delegator.signer })
    return zcapClient.delegate({
      capability: parent ?? rootCapabilityId(spaceUrlOf(target)),
      invocationTarget: target,
      controller: to.did,
      allowedActions: actions,
      expires,
      ...(caveats !== undefined && { caveats })
    })
  }

  /**
   * Makes a signed request as `who` under `capability`, or under the root
   * capability of the Space the URL names when absent (Alice's root
   * invocation).
   */
  async function call({
    who,
    url,
    method = 'GET',
    capability,
    json,
    body,
    headers
  }: {
    who: Identity
    url: string
    method?: string
    capability?: any
    json?: object
    body?: Uint8Array
    headers?: Record<string, string>
  }): Promise<Outcome> {
    return outcome(
      client({ signer: who.signer }).request({
        url,
        method,
        action: method === 'HEAD' ? 'GET' : method,
        capability:
          capability ??
          rootZcap({ target: spaceUrlOf(url), controller: alice.did }),
        ...(json !== undefined && { json }),
        ...(body !== undefined && { body }),
        ...(headers !== undefined && { headers })
      })
    )
  }

  /**
   * Writes one chunk's bytes.
   */
  async function putChunk({
    who,
    url,
    capability
  }: {
    who: Identity
    url: string
    capability?: any
  }): Promise<Outcome> {
    return call({
      who,
      url,
      method: 'PUT',
      capability,
      body: CHUNK_BYTES,
      headers: { 'content-type': 'application/octet-stream' }
    })
  }

  /**
   * Creates a Collection under Alice's root invocation of its Metadata URL.
   */
  async function createCollection(
    collectionId: string,
    body: object = {},
    space = spaceUrl
  ): Promise<void> {
    const created = await call({
      who: alice,
      url: `${collectionUrl(collectionId, space)}meta`,
      method: 'PUT',
      json: { name: collectionId, ...body }
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))
  }

  /**
   * Creates a Space controlled by Alice.
   */
  async function createSpace(id: string): Promise<void> {
    const created = await outcome(
      alice.pws.request({
        url: new URL('/spaces/', baseServerUrl).toString(),
        method: 'POST',
        json: { id, name: id, controller: alice.did }
      })
    )
    assert.equal(created.status, 201, JSON.stringify(created.data))
  }

  /**
   * Reads a Resource's Metadata object under Alice's root invocation.
   */
  async function metaOf(url: string): Promise<any> {
    const read = await call({ who: alice, url: `${url}/meta` })
    assert.equal(read.status, 200)
    return read.data
  }

  /**
   * Asserts a refusal is the masked `not-found`.
   */
  function assertMasked(result: Outcome, label: string): void {
    assert.equal(result.status, 404, `${label}: ${JSON.stringify(result.data)}`)
    assert.equal(result.data?.type, NOT_FOUND, label)
  }

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
    guestA = await newIdentity()
    guestA2 = await newIdentity()
    guestB = await newIdentity()
    moderator = await newIdentity()
    expires = anHourFromNow()

    spaceUrl = spaceUrlFor(spaceId)
    await createSpace(spaceId)
    await createCollection('comments', { plaintext: { indexes: ['topic'] } })

    const own = [OWN_RESOURCES_ONLY]
    guestAGrant = await grant({ to: guestA, caveats: own })
    guestBGrant = await grant({ to: guestB, caveats: own })
    moderatorGrant = await grant({ to: moderator })
    guestAPlain = await grant({ to: guestA })
    // Guest A's second app, delegated beneath the caveat grant with no
    // caveat of its own: it acts as guest A.
    guestA2Grant = await grant({
      from: guestA,
      parent: guestAGrant,
      target: guestAGrant.invocationTarget,
      to: guestA2
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('an unknown caveat type', () => {
    it('is refused as the masked not-found on a Space route', async () => {
      // Guest A creates the fixture, so a grant with OwnResourcesOnly alone
      // reads it and only the unknown caveat can explain a refusal.
      const seeded = await call({
        who: guestA,
        url: resourceUrl('unknown-caveat-doc'),
        method: 'PUT',
        capability: guestAPlain,
        json: { hello: 'world' }
      })
      assert.equal(seeded.status, 201)
      const knownOnly = await call({
        who: guestA,
        url: resourceUrl('unknown-caveat-doc'),
        capability: guestAGrant
      })
      assert.equal(knownOnly.status, 200)
      const baseline = await call({
        who: guestA,
        url: resourceUrl('unknown-caveat-doc'),
        capability: await grant({ to: guestA, actions: ['GET'] })
      })
      assert.equal(baseline.status, 200)

      const unknown = { type: 'urn:example:caveat:Unknown' }
      for (const caveats of [[unknown], [OWN_RESOURCES_ONLY, unknown]]) {
        const capability = await grant({ to: guestA, caveats })
        assert.deepStrictEqual(capability.caveat, caveats)
        assertMasked(
          await call({
            who: guestA,
            url: resourceUrl('unknown-caveat-doc'),
            capability
          }),
          JSON.stringify(caveats)
        )
      }
    })

    it('is refused as the masked not-found on a /kms route', async () => {
      const config = await KmsClient.createKeystore({
        url: `${baseServerUrl}kms/keystores`,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      const keystoreId = config.id!
      const keystoreAgent = new KeystoreAgent({
        capabilityAgent: { getSigner: () => alice.signer } as any,
        keystoreId,
        kmsClient: new KmsClient({ keystoreId })
      })
      const key = (await keystoreAgent.generateKey({
        type: 'asymmetric'
      })) as AsymmetricKey
      const keyUrl = key.kmsId!

      async function signUnder(caveats?: ICaveat[]): Promise<Outcome> {
        const capability = await client({ signer: alice.signer }).delegate({
          capability: rootZcap({ target: keystoreId, controller: alice.did }),
          invocationTarget: keyUrl,
          controller: guestA.did,
          allowedActions: ['sign'],
          expires,
          ...(caveats !== undefined && { caveats })
        })
        return outcome(
          client({ signer: guestA.signer }).request({
            url: keyUrl,
            method: 'POST',
            action: 'sign',
            capability,
            json: {
              type: 'SignOperation',
              invocationTarget: keyUrl,
              verifyData: Buffer.from('data to sign').toString('base64url')
            }
          })
        )
      }

      assert.equal((await signUnder()).status, 200)
      assertMasked(
        await signUnder([{ type: 'urn:example:caveat:Unknown' }]),
        'unknown caveat on /kms'
      )
      // A keystore serves no caveat, the one the server understands
      // included.
      assertMasked(
        await signUnder([OWN_RESOURCES_ONLY]),
        'OwnResourcesOnly on /kms'
      )
    })
  })

  describe('creating a Resource', () => {
    it('a POST to the Collection is unaffected (201)', async () => {
      const created = await call({
        who: guestA,
        url: collectionUrl(),
        method: 'POST',
        capability: guestAGrant,
        json: { text: 'posted' }
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      const location = created.headers!.get('location')!
      assert.ok(location)
      const meta = await metaOf(new URL(location, baseServerUrl).toString())
      assert.deepStrictEqual(meta.createdBy, [guestA.did])
    })

    it('a PUT at an absent Resource id is unaffected (201)', async () => {
      const created = await call({
        who: guestA,
        url: resourceUrl(`put-create-${randomUUID()}`),
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'put' }
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
    })
  })

  describe("the principal's own Resource", () => {
    const resourceId = 'own-doc'
    let url: string

    beforeAll(async () => {
      url = resourceUrl(resourceId)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'mine' }
      })
      assert.equal(created.status, 201)
    })

    it('can be read with GET and HEAD', async () => {
      const read = await call({ who: guestA, url, capability: guestAGrant })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { text: 'mine' })
      const head = await call({
        who: guestA,
        url,
        method: 'HEAD',
        capability: guestAGrant
      })
      assert.equal(head.status, 200)
    })

    it('can be replaced with PUT (200)', async () => {
      const updated = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'mine, edited' }
      })
      assert.equal(updated.status, 200, JSON.stringify(updated.data))
      const read = await call({ who: guestA, url, capability: guestAGrant })
      assert.deepStrictEqual(read.data, { text: 'mine, edited' })
    })

    it('has its meta read and written', async () => {
      const read = await call({
        who: guestA,
        url: `${url}/meta`,
        capability: guestAGrant
      })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data.createdBy, [guestA.did])
      const written = await call({
        who: guestA,
        url: `${url}/meta`,
        method: 'PUT',
        capability: guestAGrant,
        json: { custom: { name: 'mine' } }
      })
      assert.equal(written.status, 200, JSON.stringify(written.data))
      assert.deepStrictEqual((await metaOf(url)).custom, { name: 'mine' })
    })

    it('has a chunk written, read, listed and deleted', async () => {
      const chunkUrl = `${url}/chunks/0`
      const written = await putChunk({
        who: guestA,
        url: chunkUrl,
        capability: guestAGrant
      })
      assert.equal(written.status, 204, JSON.stringify(written.data))
      const read = await call({
        who: guestA,
        url: chunkUrl,
        capability: guestAGrant
      })
      assert.equal(read.status, 200)
      const head = await call({
        who: guestA,
        url: chunkUrl,
        method: 'HEAD',
        capability: guestAGrant
      })
      assert.equal(head.status, 200)
      const listed = await call({
        who: guestA,
        url: `${url}/chunks/`,
        capability: guestAGrant
      })
      assert.equal(listed.status, 200, JSON.stringify(listed.data))
      const deleted = await call({
        who: guestA,
        url: chunkUrl,
        method: 'DELETE',
        capability: guestAGrant
      })
      assert.equal(deleted.status, 204, JSON.stringify(deleted.data))
    })

    it('can be deleted (204)', async () => {
      const deleted = await call({
        who: guestA,
        url,
        method: 'DELETE',
        capability: guestAGrant
      })
      assert.equal(deleted.status, 204, JSON.stringify(deleted.data))
      const gone = await call({ who: alice, url })
      assert.equal(gone.status, 404)
    })
  })

  describe('a Resource the principal did not create', () => {
    const byGuestA = 'victim-by-guest-a'
    const byController = 'victim-by-controller'
    const byModerator = 'victim-by-moderator'
    const original = { text: 'original' }

    /**
     * One request shape tried against a Resource and an absent id.
     */
    interface Probe {
      label: string
      method: string
      suffix: string
      json?: object
      chunk?: boolean
      // A PUT at an absent id creates, so its denial is compared with the
      // same request under a grant that does not allow it (under-authorized).
      underAuthorized?: boolean
    }

    const probes: Probe[] = [
      { label: 'GET', method: 'GET', suffix: '' },
      { label: 'HEAD', method: 'HEAD', suffix: '' },
      {
        label: 'PUT',
        method: 'PUT',
        suffix: '',
        json: { text: 'tampered' },
        underAuthorized: true
      },
      {
        label: 'DELETE',
        method: 'DELETE',
        suffix: ''
      },
      { label: 'GET meta', method: 'GET', suffix: '/meta' },
      {
        label: 'PUT meta',
        method: 'PUT',
        suffix: '/meta',
        json: { custom: { name: 'tampered' } }
      },
      { label: 'PUT chunk', method: 'PUT', suffix: '/chunks/1', chunk: true },
      {
        label: 'PUT existing chunk',
        method: 'PUT',
        suffix: '/chunks/0',
        chunk: true
      },
      { label: 'GET chunk', method: 'GET', suffix: '/chunks/0' },
      { label: 'HEAD chunk', method: 'HEAD', suffix: '/chunks/0' },
      { label: 'list chunks', method: 'GET', suffix: '/chunks/' },
      { label: 'DELETE chunk', method: 'DELETE', suffix: '/chunks/0' }
    ]

    /**
     * Sends one probe at a Resource URL.
     */
    async function probe({
      who,
      capability,
      url,
      method,
      suffix,
      json,
      chunk
    }: {
      who: Identity
      capability: any
      url: string
      method: string
      suffix: string
      json?: object
      chunk?: boolean
    }): Promise<Outcome> {
      return call({
        who,
        url: `${url}${suffix}`,
        method,
        capability,
        ...(json !== undefined && { json }),
        ...(chunk === true && {
          body: CHUNK_BYTES,
          headers: { 'content-type': 'application/octet-stream' }
        })
      })
    }

    /**
     * Asserts every probe is refused as the masked `not-found`, with the body
     * the same request at an absent id gets (a Resource PUT: the same
     * request under-authorized), and that the Resource and its chunk are unchanged
     * afterward.
     */
    async function assertNoReach({
      who,
      capability,
      resourceId
    }: {
      who: Identity
      capability: any
      resourceId: string
    }): Promise<void> {
      const url = resourceUrl(resourceId)
      const absentUrl = resourceUrl(`absent-${randomUUID()}`)
      const readOnly = await grant({ to: who, actions: ['GET'] })
      // Every probe runs before any assertion, so one report names every
      // request that answered differently.
      const mismatches: string[] = []
      for (const shape of probes) {
        const denied = await probe({ who, capability, url, ...shape })
        const absent = await probe({
          who,
          ...shape,
          ...(shape.underAuthorized === true
            ? { capability: readOnly, url }
            : { capability, url: absentUrl })
        })
        if (absent.status !== 404) {
          mismatches.push(`${shape.label}: compared request ${absent.status}`)
        }
        if (denied.status !== 404) {
          mismatches.push(`${shape.label}: status ${denied.status}`)
          continue
        }
        if (shape.method === 'HEAD') {
          continue
        }
        if (denied.data?.type !== NOT_FOUND) {
          mismatches.push(`${shape.label}: type ${denied.data?.type}`)
        }
        try {
          assert.deepStrictEqual(denied.data, absent.data)
        } catch {
          mismatches.push(
            `${shape.label}: body ${JSON.stringify(denied.data)}, ` +
              `absent ${JSON.stringify(absent.data)}`
          )
        }
      }
      assert.deepStrictEqual(mismatches, [])
      const read = await call({ who: alice, url })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, original)
      assert.equal((await metaOf(url)).custom, undefined)
      const chunk = await call({ who: alice, url: `${url}/chunks/0` })
      assert.equal(chunk.status, 200)
      const extra = await call({ who: alice, url: `${url}/chunks/1` })
      assert.equal(extra.status, 404)
    }

    beforeAll(async () => {
      const creators: Array<[string, Identity, any]> = [
        [byGuestA, guestA, guestAGrant],
        [byController, alice, undefined],
        [byModerator, moderator, moderatorGrant]
      ]
      for (const [resourceId, who, capability] of creators) {
        const url = resourceUrl(resourceId)
        const created = await call({
          who,
          url,
          method: 'PUT',
          capability,
          json: original
        })
        assert.equal(created.status, 201)
        const chunk = await putChunk({
          who,
          url: `${url}/chunks/0`,
          capability
        })
        assert.equal(chunk.status, 204)
      }
      assert.deepStrictEqual(
        (await metaOf(resourceUrl(byController))).createdBy,
        [alice.did]
      )
      assert.deepStrictEqual(
        (await metaOf(resourceUrl(byModerator))).createdBy,
        [moderator.did]
      )
    })

    it("another guest cannot reach guest A's Resource", async () => {
      await assertNoReach({
        who: guestB,
        capability: guestBGrant,
        resourceId: byGuestA
      })
    })

    it('guest A cannot reach a Resource the controller created', async () => {
      await assertNoReach({
        who: guestA,
        capability: guestAGrant,
        resourceId: byController
      })
    })

    it('guest A cannot reach a Resource the moderator created', async () => {
      await assertNoReach({
        who: guestA,
        capability: guestAGrant,
        resourceId: byModerator
      })
    })

    it('the refusal comes before a failing If-Match (404, not 412)', async () => {
      const url = resourceUrl(byGuestA)
      const headers = { 'if-match': '"no-such-validator"' }
      for (const method of ['PUT', 'DELETE']) {
        const json = method === 'PUT' ? { text: 'tampered' } : undefined
        const denied = await call({
          who: guestB,
          url,
          method,
          capability: guestBGrant,
          headers,
          ...(json !== undefined && { json })
        })
        assertMasked(denied, `${method} with If-Match`)
        // The owner meets the precondition failure, so it is there to meet.
        const owner = await call({
          who: guestA,
          url,
          method,
          capability: guestAGrant,
          headers,
          ...(json !== undefined && { json })
        })
        assert.equal(owner.status, 412, `${method}: ${owner.status}`)
      }
      const read = await call({ who: alice, url })
      assert.deepStrictEqual(read.data, original)
    })

    it('the refusal comes before the write-once rule (404, not 409)', async () => {
      await createCollection('ledger', { revisions: { immutable: true } })
      const ledger = collectionUrl('ledger')
      const own = [OWN_RESOURCES_ONLY]
      const aGrant = await grant({ to: guestA, target: ledger, caveats: own })
      const bGrant = await grant({ to: guestB, target: ledger, caveats: own })
      const url = resourceUrl('entry', ledger)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: aGrant,
        json: { v: 1 }
      })
      assert.equal(created.status, 201)

      assertMasked(
        await call({
          who: guestB,
          url,
          method: 'PUT',
          capability: bGrant,
          json: { v: 2 }
        }),
        'write-once PUT by another guest'
      )
      // The owner meets the write-once refusal.
      const owner = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: aGrant,
        json: { v: 2 }
      })
      assert.equal(owner.status, 409, JSON.stringify(owner.data))
    })

    it('a chain with no caveat is unaffected (the moderator)', async () => {
      const url = resourceUrl(`moderated-${randomUUID()}`)
      await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: original
      })
      const read = await call({
        who: moderator,
        url,
        capability: moderatorGrant
      })
      assert.equal(read.status, 200)
      const edited = await call({
        who: moderator,
        url,
        method: 'PUT',
        capability: moderatorGrant,
        json: { text: 'moderated' }
      })
      assert.equal(edited.status, 200)
      const deleted = await call({
        who: moderator,
        url,
        method: 'DELETE',
        capability: moderatorGrant
      })
      assert.equal(deleted.status, 204)
    })

    it('a root invocation is unaffected (the controller)', async () => {
      const url = resourceUrl(`rooted-${randomUUID()}`)
      await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: original
      })
      assert.equal((await call({ who: alice, url })).status, 200)
      const edited = await call({
        who: alice,
        url,
        method: 'PUT',
        json: { text: 'by the controller' }
      })
      assert.equal(edited.status, 200)
      const deleted = await call({ who: alice, url, method: 'DELETE' })
      assert.equal(deleted.status, 204)
    })
  })

  describe('one principal across keys', () => {
    it("guest A's second app reads, edits and deletes what guest A created", async () => {
      const url = resourceUrl(`shared-${randomUUID()}`)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'from guest A' }
      })
      assert.equal(created.status, 201)

      const read = await call({ who: guestA2, url, capability: guestA2Grant })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { text: 'from guest A' })
      const meta = await call({
        who: guestA2,
        url: `${url}/meta`,
        capability: guestA2Grant
      })
      assert.equal(meta.status, 200)
      const edited = await call({
        who: guestA2,
        url,
        method: 'PUT',
        capability: guestA2Grant,
        json: { text: 'edited by the second app' }
      })
      assert.equal(edited.status, 200)
      const deleted = await call({
        who: guestA2,
        url,
        method: 'DELETE',
        capability: guestA2Grant
      })
      assert.equal(deleted.status, 204)
    })

    it('guest A reads, edits and deletes what its second app created', async () => {
      const url = resourceUrl(`from-app-${randomUUID()}`)
      const created = await call({
        who: guestA2,
        url,
        method: 'PUT',
        capability: guestA2Grant,
        json: { text: 'from the second app' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual((await metaOf(url)).createdBy, [
        guestA.did,
        guestA2.did
      ])

      const read = await call({ who: guestA, url, capability: guestAGrant })
      assert.equal(read.status, 200)
      const edited = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'edited by guest A' }
      })
      assert.equal(edited.status, 200)
      const deleted = await call({
        who: guestA,
        url,
        method: 'DELETE',
        capability: guestAGrant
      })
      assert.equal(deleted.status, 204)
    })

    it('guest B does not match what the second app created', async () => {
      const url = resourceUrl(`app-only-${randomUUID()}`)
      const created = await call({
        who: guestA2,
        url,
        method: 'PUT',
        capability: guestA2Grant,
        json: { text: 'from the second app' }
      })
      assert.equal(created.status, 201)
      assertMasked(
        await call({ who: guestB, url, capability: guestBGrant }),
        'guest B GET'
      )
    })
  })

  describe('two caveats in one chain', () => {
    let doubleGrant: any

    beforeAll(async () => {
      doubleGrant = await grant({
        from: guestA,
        parent: guestAGrant,
        target: guestAGrant.invocationTarget,
        to: guestA2,
        caveats: [OWN_RESOURCES_ONLY]
      })
      assert.deepStrictEqual(doubleGrant.caveat, [OWN_RESOURCES_ONLY])
    })

    it('refuses a Resource guest A created directly', async () => {
      const url = resourceUrl(`direct-${randomUUID()}`)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'direct' }
      })
      assert.equal(created.status, 201)
      for (const method of ['GET', 'PUT', 'DELETE']) {
        assertMasked(
          await call({
            who: guestA2,
            url,
            method,
            capability: doubleGrant,
            ...(method === 'PUT' && { json: { text: 'tampered' } })
          }),
          `double-caveat ${method}`
        )
      }
      const read = await call({ who: alice, url })
      assert.deepStrictEqual(read.data, { text: 'direct' })
    })

    it('reaches a Resource whose createdBy lists both principals', async () => {
      // Created by the second app under the single-caveat chain.
      const viaSingle = resourceUrl(`via-single-${randomUUID()}`)
      await call({
        who: guestA2,
        url: viaSingle,
        method: 'PUT',
        capability: guestA2Grant,
        json: { text: 'via single' }
      })
      const read = await call({
        who: guestA2,
        url: viaSingle,
        capability: doubleGrant
      })
      assert.equal(read.status, 200)

      // Created under the double-caveat chain itself.
      const viaDouble = resourceUrl(`via-double-${randomUUID()}`)
      const created = await call({
        who: guestA2,
        url: viaDouble,
        method: 'PUT',
        capability: doubleGrant,
        json: { text: 'via double' }
      })
      assert.equal(created.status, 201)
      assert.deepStrictEqual((await metaOf(viaDouble)).createdBy, [
        guestA.did,
        guestA2.did
      ])
      const edited = await call({
        who: guestA2,
        url: viaDouble,
        method: 'PUT',
        capability: doubleGrant,
        json: { text: 'edited' }
      })
      assert.equal(edited.status, 200)
      // Guest A, under its own single-caveat grant, matches it too.
      const byGuestA = await call({
        who: guestA,
        url: viaDouble,
        capability: guestAGrant
      })
      assert.equal(byGuestA.status, 200)
      const deleted = await call({
        who: guestA2,
        url: viaDouble,
        method: 'DELETE',
        capability: doubleGrant
      })
      assert.equal(deleted.status, 204)
    })
  })

  describe('the Collection listing', () => {
    const board = () => collectionUrl('board')
    let aGrant: any, aPlain: any, bGrant: any, modGrant: any
    // Ids interleave the owners, so a page boundary falls between parties.
    const owners: Array<[string, 'a' | 'b' | 'alice' | 'mod']> = [
      ['b-01', 'a'],
      ['b-02', 'b'],
      ['b-03', 'alice'],
      ['b-04', 'a'],
      ['b-05', 'mod'],
      ['b-06', 'a'],
      ['b-07', 'b'],
      ['b-08', 'a'],
      ['b-09', 'a']
    ]
    const ownedBy = (owner: string) =>
      owners.filter(([, who]) => who === owner).map(([id]) => id)

    /**
     * Follows a listing's `next` links from `url`, returning every page.
     */
    async function pages({
      who,
      capability,
      url
    }: {
      who: Identity
      capability?: any
      url: string
    }): Promise<any[]> {
      const seen: any[] = []
      let next: string | undefined = url
      while (next !== undefined) {
        const page = await call({ who, url: next, capability })
        assert.equal(page.status, 200, JSON.stringify(page.data))
        seen.push(page.data)
        next =
          page.data.next === undefined
            ? undefined
            : new URL(page.data.next, baseServerUrl).toString()
        assert.ok(seen.length < 20, 'runaway pagination')
      }
      return seen
    }

    beforeAll(async () => {
      await createCollection('board', { plaintext: { indexes: ['topic'] } })
      const own = [OWN_RESOURCES_ONLY]
      aGrant = await grant({ to: guestA, target: board(), caveats: own })
      bGrant = await grant({ to: guestB, target: board(), caveats: own })
      aPlain = await grant({ to: guestA, target: board() })
      modGrant = await grant({ to: moderator, target: board() })
      const writers = {
        a: [guestA, aGrant],
        b: [guestB, bGrant],
        alice: [alice, undefined],
        mod: [moderator, modGrant]
      } as const
      for (const [resourceId, owner] of owners) {
        const [who, capability] = writers[owner]
        const created = await call({
          who,
          url: resourceUrl(resourceId, board()),
          method: 'PUT',
          capability,
          json: { topic: 't', owner }
        })
        assert.equal(created.status, 201)
      }
    })

    it("lists only the principal's own Resources and counts only those", async () => {
      const listed = await call({
        who: guestA,
        url: board(),
        capability: aGrant
      })
      assert.equal(listed.status, 200, JSON.stringify(listed.data))
      assert.deepStrictEqual(
        listed.data.items.map((item: any) => item.id),
        ownedBy('a')
      )
      assert.equal(listed.data.totalItems, ownedBy('a').length)

      const listedB = await call({
        who: guestB,
        url: board(),
        capability: bGrant
      })
      assert.deepStrictEqual(
        listedB.data.items.map((item: any) => item.id),
        ownedBy('b')
      )
      assert.equal(listedB.data.totalItems, ownedBy('b').length)
    })

    it('paginates the filtered listing with limit', async () => {
      const seen = await pages({
        who: guestA,
        capability: aGrant,
        url: `${board()}?limit=2`
      })
      assert.ok(seen.length > 1, 'expected more than one page')
      for (const page of seen) {
        assert.ok(page.items.length <= 2, JSON.stringify(page.items))
        assert.equal(page.totalItems, ownedBy('a').length)
      }
      assert.deepStrictEqual(
        seen.flatMap(page => page.items.map((item: any) => item.id)),
        ownedBy('a')
      )
    })

    it("the controller's listing is unfiltered", async () => {
      const listed = await call({ who: alice, url: board() })
      assert.equal(listed.status, 200)
      assert.deepStrictEqual(
        listed.data.items.map((item: any) => item.id),
        owners.map(([id]) => id)
      )
      assert.equal(listed.data.totalItems, owners.length)
      // So is a grant with no caveat.
      const plain = await call({
        who: guestA,
        url: board(),
        capability: aPlain
      })
      assert.equal(plain.data.totalItems, owners.length)
    })

    it('refuses a filter[...] listing on a Collection with no public-read policy', async () => {
      const filterUrl = `${board()}?filter%5Btopic%5D=t`
      const plain = await call({
        who: guestA,
        url: filterUrl,
        capability: aPlain
      })
      assert.equal(plain.status, 200, JSON.stringify(plain.data))
      assertMasked(
        await call({ who: guestA, url: filterUrl, capability: aGrant }),
        'filter listing'
      )
    })
  })

  describe('container reads', () => {
    let spaceCaveat: any, spacePlain: any

    /**
     * Asserts a read answers the same under the caveat grant as under the
     * same grant with no caveat, and succeeds.
     */
    async function assertSameRead({
      url,
      caveat,
      plain
    }: {
      url: string
      caveat: any
      plain: any
    }): Promise<void> {
      const withCaveat = await call({ who: guestA, url, capability: caveat })
      const without = await call({ who: guestA, url, capability: plain })
      assert.equal(
        without.status,
        200,
        `${url}: ${JSON.stringify(without.data)}`
      )
      assert.equal(
        withCaveat.status,
        without.status,
        `${url}: ${JSON.stringify(withCaveat.data)}`
      )
      assert.deepStrictEqual(withCaveat.data, without.data, url)
      assert.equal(
        withCaveat.headers?.get('etag'),
        without.headers?.get('etag'),
        url
      )
    }

    beforeAll(async () => {
      spaceCaveat = await grant({
        to: guestA,
        target: spaceUrl,
        caveats: [OWN_RESOURCES_ONLY]
      })
      spacePlain = await grant({ to: guestA, target: spaceUrl })
    })

    it('Collection meta, linkset and backend answer as with no caveat', async () => {
      for (const suffix of ['meta', 'linkset', 'backend']) {
        await assertSameRead({
          url: `${collectionUrl()}${suffix}`,
          caveat: guestAGrant,
          plain: guestAPlain
        })
      }
    })

    it('the Collection governing history log answers as with no caveat', async () => {
      const collectionId = `governed-${randomUUID()}`
      const created = await call({
        who: alice,
        url: spaceUrl,
        method: 'POST',
        json: { id: collectionId, name: collectionId }
      })
      assert.equal(created.status, 201)
      const logUrl = `${collectionUrl(collectionId)}meta/log`
      const governed = await outcome(
        client({ signer: alice.signer }).request({
          url: logUrl,
          method: 'PUT',
          action: 'PUT',
          capability: rootZcap({ target: spaceUrl, controller: alice.did }),
          body: new TextEncoder().encode(genesisLine(oneEpoch) + '\n'),
          headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' }
        })
      )
      assert.equal(governed.status, 204, JSON.stringify(governed.data))
      const target = collectionUrl(collectionId)
      await assertSameRead({
        url: logUrl,
        caveat: await grant({
          to: guestA,
          target,
          caveats: [OWN_RESOURCES_ONLY]
        }),
        plain: await grant({ to: guestA, target })
      })
    })

    it('Space meta, listing, linkset and backends answer as with no caveat', async () => {
      for (const suffix of ['meta', '', 'linkset', 'backends']) {
        await assertSameRead({
          url: `${spaceUrl}${suffix}`,
          caveat: spaceCaveat,
          plain: spacePlain
        })
      }
    })

    it('a Space-URL caveat grant reaches only own Resources beneath it', async () => {
      const own = resourceUrl(`space-grant-${randomUUID()}`)
      const created = await call({
        who: guestA,
        url: own,
        method: 'PUT',
        capability: spaceCaveat,
        json: { text: 'mine' }
      })
      assert.equal(created.status, 201)
      assert.equal(
        (await call({ who: guestA, url: own, capability: spaceCaveat })).status,
        200
      )
      const foreign = resourceUrl(`by-controller-${randomUUID()}`)
      const seeded = await call({
        who: alice,
        url: foreign,
        method: 'PUT',
        json: { text: 'controller' }
      })
      assert.equal(seeded.status, 201)
      assert.equal((await call({ who: alice, url: foreign })).status, 200)
      assertMasked(
        await call({
          who: guestA,
          url: foreign,
          capability: spaceCaveat
        }),
        'Space-URL caveat grant on the controller Resource'
      )
    })
  })

  describe('refused routes', () => {
    let spaceCaveat: any, spacePlain: any

    /**
     * Asserts a request is refused under the caveat grant, and answers
     * `plainStatus` under the same grant with no caveat. The caveat request
     * goes first, so a baseline write cannot hide a refused one.
     */
    async function assertRefusedUnderCaveat({
      label,
      url,
      method,
      caveat,
      plain,
      plainStatus,
      json,
      body,
      headers
    }: {
      label: string
      url: string
      method: string
      caveat: any
      plain: any
      plainStatus: number
      json?: object
      body?: Uint8Array
      headers?: Record<string, string>
    }): Promise<void> {
      const request = {
        url,
        method,
        ...(json !== undefined && { json }),
        ...(body !== undefined && { body }),
        ...(headers !== undefined && { headers })
      }
      assertMasked(
        await call({ who: guestA, capability: caveat, ...request }),
        label
      )
      const without = await call({ who: guestA, capability: plain, ...request })
      assert.equal(
        without.status,
        plainStatus,
        `${label} with no caveat: ${JSON.stringify(without.data)}`
      )
    }

    beforeAll(async () => {
      spaceCaveat = await grant({
        to: guestA,
        target: spaceUrl,
        caveats: [OWN_RESOURCES_ONLY]
      })
      spacePlain = await grant({ to: guestA, target: spaceUrl })
    })

    describe('policy URLs', () => {
      const policySpaceId = `own-policy-${randomUUID()}`
      let policySpaceUrl: string
      let docsUrl: string
      let ownDocUrl: string
      let collectionCaveat: any, collectionPlain: any
      let policySpaceCaveat: any, policySpacePlain: any

      beforeAll(async () => {
        await createSpace(policySpaceId)
        policySpaceUrl = spaceUrlFor(policySpaceId)
        await createCollection('docs', {}, policySpaceUrl)
        docsUrl = collectionUrl('docs', policySpaceUrl)
        collectionCaveat = await grant({
          to: guestA,
          target: docsUrl,
          caveats: [OWN_RESOURCES_ONLY]
        })
        collectionPlain = await grant({ to: guestA, target: docsUrl })
        policySpaceCaveat = await grant({
          to: guestA,
          target: policySpaceUrl,
          caveats: [OWN_RESOURCES_ONLY]
        })
        policySpacePlain = await grant({ to: guestA, target: policySpaceUrl })
        ownDocUrl = resourceUrl('own-doc', docsUrl)
        const created = await call({
          who: guestA,
          url: ownDocUrl,
          method: 'PUT',
          capability: collectionCaveat,
          json: { text: 'mine' }
        })
        assert.equal(created.status, 201)
        // A policy the controller set at each level, so a read has one to
        // find. The unknown type grants nothing.
        for (const url of [
          `${policySpaceUrl}policy`,
          `${docsUrl}policy`,
          `${ownDocUrl}/policy`
        ]) {
          const set = await call({
            who: alice,
            url,
            method: 'PUT',
            json: { type: 'SomethingUnsupported' }
          })
          assert.ok(set.status < 300, `${url}: ${set.status}`)
        }
      })

      for (const level of ['Space', 'Collection', 'Resource'] as const) {
        it(`refuses GET, PUT and DELETE at the ${level} policy URL`, async () => {
          const url = {
            Space: `${policySpaceUrl}policy`,
            Collection: `${docsUrl}policy`,
            Resource: `${ownDocUrl}/policy`
          }[level]
          const caveat =
            level === 'Space' ? policySpaceCaveat : collectionCaveat
          const plain = level === 'Space' ? policySpacePlain : collectionPlain
          await assertRefusedUnderCaveat({
            label: `GET ${level} policy`,
            url,
            method: 'GET',
            caveat,
            plain,
            plainStatus: 200
          })
          const json = { type: 'SomethingElseUnsupported' }
          const put = await call({
            who: guestA,
            url,
            method: 'PUT',
            capability: caveat,
            json
          })
          assertMasked(put, `PUT ${level} policy`)
          const putPlain = await call({
            who: guestA,
            url,
            method: 'PUT',
            capability: plain,
            json
          })
          assert.ok(
            putPlain.status >= 200 && putPlain.status < 300,
            `PUT ${level} policy with no caveat: ${putPlain.status}`
          )
          const del = await call({
            who: guestA,
            url,
            method: 'DELETE',
            capability: caveat
          })
          assertMasked(del, `DELETE ${level} policy`)
          const delPlain = await call({
            who: guestA,
            url,
            method: 'DELETE',
            capability: plain
          })
          assert.ok(
            delPlain.status >= 200 && delPlain.status < 300,
            `DELETE ${level} policy with no caveat: ${delPlain.status}`
          )
        })
      }
    })

    it('refuses the POST query profile', async () => {
      await assertRefusedUnderCaveat({
        label: 'POST equality query',
        url: `${collectionUrl()}query`,
        method: 'POST',
        caveat: guestAGrant,
        plain: guestAPlain,
        plainStatus: 200,
        json: { profile: 'equality', equals: [{ topic: 'x' }] }
      })
    })

    it('refuses the changes feed, POST and GET', async () => {
      await assertRefusedUnderCaveat({
        label: 'POST changes',
        url: `${collectionUrl()}query`,
        method: 'POST',
        caveat: guestAGrant,
        plain: guestAPlain,
        plainStatus: 200,
        json: { profile: 'changes' }
      })
      await assertRefusedUnderCaveat({
        label: 'GET changes',
        url: `${collectionUrl()}query?profile=changes`,
        method: 'GET',
        caveat: guestAGrant,
        plain: guestAPlain,
        plainStatus: 200
      })
    })

    it('refuses the quota reports', async () => {
      await assertRefusedUnderCaveat({
        label: 'Space quotas',
        url: `${spaceUrl}quotas`,
        method: 'GET',
        caveat: spaceCaveat,
        plain: spacePlain,
        plainStatus: 200
      })
      await assertRefusedUnderCaveat({
        label: 'Collection quota',
        url: `${collectionUrl()}quota`,
        method: 'GET',
        caveat: guestAGrant,
        plain: guestAPlain,
        plainStatus: 200
      })
    })

    it('refuses Create Collection', async () => {
      const collectionId = `created-${randomUUID()}`
      assertMasked(
        await call({
          who: guestA,
          url: spaceUrl,
          method: 'POST',
          capability: spaceCaveat,
          json: { id: collectionId, name: collectionId }
        }),
        'Create Collection'
      )
      const absent = await call({
        who: alice,
        url: `${collectionUrl(collectionId)}meta`
      })
      assert.equal(absent.status, 404)
      const plain = await call({
        who: guestA,
        url: spaceUrl,
        method: 'POST',
        capability: spacePlain,
        json: { id: `${collectionId}-plain`, name: collectionId }
      })
      assert.equal(plain.status, 201, JSON.stringify(plain.data))
    })

    it('refuses Update Collection under a Space-URL grant', async () => {
      const collectionId = `updated-${randomUUID()}`
      await createCollection(collectionId)
      await assertRefusedUnderCaveat({
        label: 'Update Collection',
        url: `${collectionUrl(collectionId)}meta`,
        method: 'PUT',
        caveat: spaceCaveat,
        plain: spacePlain,
        plainStatus: 204,
        json: { name: 'renamed' }
      })
    })

    it('refuses Export Space', async () => {
      await assertRefusedUnderCaveat({
        label: 'Export Space',
        url: `${spaceUrl}export`,
        method: 'POST',
        caveat: spaceCaveat,
        plain: spacePlain,
        plainStatus: 200
      })
    })

    it('refuses Import Space', async () => {
      // A body that is not a tar: an authorized caller gets the 400.
      await assertRefusedUnderCaveat({
        label: 'Import Space',
        url: `${spaceUrl}import`,
        method: 'POST',
        caveat: spaceCaveat,
        plain: spacePlain,
        plainStatus: 400,
        body: new TextEncoder().encode('not a tar'),
        headers: { 'content-type': 'application/x-tar' }
      })
    })

    it('refuses the replicas routes', async () => {
      const replicasUrl = `${spaceUrl}replicas`
      await assertRefusedUnderCaveat({
        label: 'List replicas',
        url: replicasUrl,
        method: 'GET',
        caveat: await grant({
          to: guestA,
          target: replicasUrl,
          caveats: [OWN_RESOURCES_ONLY]
        }),
        plain: await grant({ to: guestA, target: replicasUrl }),
        plainStatus: 200
      })
    })

    it('refuses Delete Space under an exactly-DELETE Space grant', async () => {
      const doomedId = `own-doomed-${randomUUID()}`
      await createSpace(doomedId)
      const doomedUrl = spaceUrlFor(doomedId)
      await assertRefusedUnderCaveat({
        label: 'Delete Space',
        url: doomedUrl,
        method: 'DELETE',
        caveat: await grant({
          to: guestA,
          target: doomedUrl,
          actions: ['DELETE'],
          caveats: [OWN_RESOURCES_ONLY]
        }),
        plain: await grant({
          to: guestA,
          target: doomedUrl,
          actions: ['DELETE']
        }),
        plainStatus: 204
      })
    })

    it('refuses the controller-only container writes (container rule)', async () => {
      const collectionId = `kept-${randomUUID()}`
      await createCollection(collectionId)
      assertMasked(
        await call({
          who: guestA,
          url: collectionUrl(collectionId),
          method: 'DELETE',
          capability: spaceCaveat
        }),
        'Delete Collection'
      )
      assertMasked(
        await call({
          who: guestA,
          url: `${spaceUrl}meta`,
          method: 'PUT',
          capability: spaceCaveat,
          json: { name: 'renamed', controller: alice.did }
        }),
        'Update Space'
      )
      const kept = await call({
        who: alice,
        url: `${collectionUrl(collectionId)}meta`
      })
      assert.equal(kept.status, 200)
    })
  })

  describe('revocation', () => {
    /**
     * The revocation submission URL of a capability id.
     */
    function revocationUrl(capabilityId: string): string {
      return new URL(
        spaceRevocationsPath({ spaceId, revocationId: capabilityId }),
        baseServerUrl
      ).toString()
    }

    it("the controller revokes guest A's caveat grant", async () => {
      const revocable = await grant({
        to: guestA,
        caveats: [OWN_RESOURCES_ONLY]
      })
      const url = resourceUrl(`revocable-${randomUUID()}`)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: revocable,
        json: { text: 'mine' }
      })
      assert.equal(created.status, 201)

      const revoked = await call({
        who: alice,
        url: revocationUrl(revocable.id),
        method: 'POST',
        json: revocable
      })
      assert.equal(revoked.status, 204, JSON.stringify(revoked.data))

      const after = await call({ who: guestA, url, capability: revocable })
      assert.equal(after.status, 404)
    })

    it('guest A revokes its own caveat grant (dual-root rule)', async () => {
      const revocable = await grant({
        to: guestA,
        caveats: [OWN_RESOURCES_ONLY]
      })
      const submissionUrl = revocationUrl(revocable.id)
      const revoked = await call({
        who: guestA,
        url: submissionUrl,
        method: 'POST',
        capability: rootZcap({ target: submissionUrl, controller: guestA.did }),
        json: revocable
      })
      assert.equal(revoked.status, 204, JSON.stringify(revoked.data))
    })

    it('a submission invoked under a caveat-carrying chain is not refused for the caveat', async () => {
      const spaceCaveat = await grant({
        to: guestA,
        target: spaceUrl,
        caveats: [OWN_RESOURCES_ONLY]
      })
      const parent = await grant({ to: guestA, caveats: [OWN_RESOURCES_ONLY] })
      const child = await grant({
        from: guestA,
        parent,
        target: parent.invocationTarget,
        to: guestA2
      })
      const url = resourceUrl(`child-${randomUUID()}`)
      const created = await call({
        who: guestA2,
        url,
        method: 'PUT',
        capability: child,
        json: { text: 'from the child' }
      })
      assert.equal(created.status, 201)

      const revoked = await call({
        who: guestA,
        url: revocationUrl(child.id),
        method: 'POST',
        capability: spaceCaveat,
        json: child
      })
      assert.equal(revoked.status, 204, JSON.stringify(revoked.data))
      const after = await call({ who: guestA2, url, capability: child })
      assert.equal(after.status, 404)
    })
  })

  describe('the proof suite rule', () => {
    it('refuses a caveat grant signed with Ed25519Signature2020', async () => {
      const url = resourceUrl(`legacy-target-${randomUUID()}`)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'mine' }
      })
      assert.equal(created.status, 201)

      // The legacy suite canonicalizes in safe mode, and the zcap context
      // defines no term for the caveat type, so a client cannot sign one.
      await assert.rejects(
        grant({ to: guestA, caveats: [OWN_RESOURCES_ONLY], legacy: true }),
        /Safe mode validation error/
      )

      // The nearest wire shape: a legacy-signed grant with the caveat
      // added after signing. Without the caveat it verifies.
      const legacy = await grant({ to: guestA, legacy: true })
      const proof = Array.isArray(legacy.proof) ? legacy.proof[0] : legacy.proof
      assert.equal(proof.type, 'Ed25519Signature2020')
      assert.equal(
        (await call({ who: guestA, url, capability: legacy })).status,
        200
      )
      assertMasked(
        await call({
          who: guestA,
          url,
          capability: { ...legacy, caveat: [OWN_RESOURCES_ONLY] }
        }),
        'legacy-signed caveat grant'
      )
    })

    it('accepts a caveat link signed with eddsa-jcs-2022 beneath a legacy-signed parent', async () => {
      const parent = await grant({ to: guestA, legacy: true })
      const child = await grant({
        from: guestA,
        parent,
        target: parent.invocationTarget,
        to: guestA2,
        caveats: [OWN_RESOURCES_ONLY]
      })
      const url = resourceUrl(`mixed-${randomUUID()}`)
      const created = await call({
        who: guestA2,
        url,
        method: 'PUT',
        capability: child,
        json: { text: 'mixed' }
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      const read = await call({ who: guestA2, url, capability: child })
      assert.equal(read.status, 200)
      // The principal is the second app, so guest A's own Resource is not
      // its own.
      const foreign = resourceUrl(`by-guest-a-${randomUUID()}`)
      const seeded = await call({
        who: guestA,
        url: foreign,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'guest A' }
      })
      assert.equal(seeded.status, 201)
      assert.equal(
        (await call({ who: guestA, url: foreign, capability: guestAGrant }))
          .status,
        200
      )
      assertMasked(
        await call({
          who: guestA2,
          url: foreign,
          capability: child
        }),
        'mixed chain on a Resource guest A created'
      )
    })
  })

  it('refuses a caveat object carrying a member besides type', async () => {
    const url = resourceUrl(`shape-${randomUUID()}`)
    const created = await call({
      who: guestA,
      url,
      method: 'PUT',
      capability: guestAGrant,
      json: { text: 'mine' }
    })
    assert.equal(created.status, 201)
    const extra = await grant({
      to: guestA,
      caveats: [{ type: 'OwnResourcesOnly', extra: 1 }]
    })
    assertMasked(
      await call({ who: guestA, url, capability: extra }),
      'caveat with an extra member'
    )
    assert.equal(
      (await call({ who: guestA, url, capability: guestAGrant })).status,
      200
    )
  })

  describe('a public-read policy', () => {
    const publicBoard = () => collectionUrl('public-board')
    let aGrant: any, bGrant: any
    const resourceId = 'public-doc'

    beforeAll(async () => {
      await createCollection('public-board', {
        plaintext: { indexes: ['topic'] }
      })
      const set = await call({
        who: alice,
        url: `${publicBoard()}policy`,
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      assert.ok(set.status < 300)
      const own = [OWN_RESOURCES_ONLY]
      aGrant = await grant({ to: guestA, target: publicBoard(), caveats: own })
      bGrant = await grant({ to: guestB, target: publicBoard(), caveats: own })
      const created = await call({
        who: guestA,
        url: resourceUrl(resourceId, publicBoard()),
        method: 'PUT',
        capability: aGrant,
        json: { topic: 't', text: 'public' }
      })
      assert.equal(created.status, 201)
    })

    it("grants another guest's read, while its writes stay refused", async () => {
      const url = resourceUrl(resourceId, publicBoard())
      const read = await call({ who: guestB, url, capability: bGrant })
      assert.equal(read.status, 200, JSON.stringify(read.data))
      assert.deepStrictEqual(read.data, { topic: 't', text: 'public' })
      const head = await call({
        who: guestB,
        url,
        method: 'HEAD',
        capability: bGrant
      })
      assert.equal(head.status, 200)
      assertMasked(
        await call({
          who: guestB,
          url,
          method: 'PUT',
          capability: bGrant,
          json: { text: 'tampered' }
        }),
        'PUT under a public-read policy'
      )
      assertMasked(
        await call({ who: guestB, url, method: 'DELETE', capability: bGrant }),
        'DELETE under a public-read policy'
      )
      const kept = await call({ who: alice, url })
      assert.deepStrictEqual(kept.data, { topic: 't', text: 'public' })
    })

    it('serves a filter[...] listing under the caveat grant', async () => {
      const listed = await call({
        who: guestB,
        url: `${publicBoard()}?filter%5Btopic%5D=t`,
        capability: bGrant
      })
      assert.equal(listed.status, 200, JSON.stringify(listed.data))
    })

    it('keeps the signed listing filtered, while an unsigned one lists everything', async () => {
      const signed = await call({
        who: guestB,
        url: publicBoard(),
        capability: bGrant
      })
      assert.equal(signed.status, 200, JSON.stringify(signed.data))
      assert.equal(signed.data.totalItems, 0)
      assert.deepStrictEqual(signed.data.items, [])
      const unsigned = await fetch(publicBoard())
      assert.equal(unsigned.status, 200)
      const listing = (await unsigned.json()) as {
        totalItems: number
        items: Array<{ id: string }>
      }
      assert.equal(listing.totalItems, 1)
      assert.deepStrictEqual(
        listing.items.map(({ id }) => id),
        [resourceId]
      )
    })
  })

  describe('a chain that cannot record createdBy', () => {
    it('is refused when a link above the caveat names two controllers', async () => {
      const second = await newIdentity()
      // A grant to two moderators: a create under it records no `createdBy`.
      // `@interop/ezcap` signs for one controller only, so it is signed here.
      const root = rootCapabilityId(spaceUrl)
      const shared = await jsigs.sign(
        {
          '@context': zcapConstants.ZCAP_CONTEXT_URL,
          id: `urn:uuid:${randomUUID()}`,
          controller: [moderator.did, second.did],
          parentCapability: root,
          invocationTarget: collectionUrl(),
          allowedAction: ALL_ACTIONS,
          expires: `${expires.toISOString().slice(0, -5)}Z`
        },
        {
          documentLoader,
          suite: new EddsaJcs2022({ signer: alice.signer }),
          purpose: new CapabilityDelegation({ parentCapability: root })
        }
      )
      const guestGrant = await grant({
        from: moderator,
        parent: shared,
        to: guestA,
        caveats: [OWN_RESOURCES_ONLY]
      })
      assertMasked(
        await call({
          who: guestA,
          url: collectionUrl(),
          method: 'POST',
          capability: guestGrant,
          json: { text: 'unreachable' }
        }),
        'POST under a caveat chain with a two-controller link'
      )
      assertMasked(
        await call({
          who: guestA,
          url: resourceUrl(`no-creator-${randomUUID()}`),
          method: 'PUT',
          capability: guestGrant,
          json: { text: 'unreachable' }
        }),
        'PUT under a caveat chain with a two-controller link'
      )
      // The same chain with no caveat creates, with no `createdBy` recorded.
      const plain = await grant({ from: moderator, parent: shared, to: guestA })
      const created = await call({
        who: guestA,
        url: resourceUrl(`no-creator-${randomUUID()}`),
        method: 'PUT',
        capability: plain,
        json: { text: 'reachable' }
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
    })
  })

  describe('a Resource replaced between the ownership check and the read', () => {
    /**
     * Creates guest A's Resource with one chunk, and returns a function that
     * deletes it and has guest B create it again, chunk included.
     */
    async function ownedThenSwapped(resourceId: string) {
      const url = resourceUrl(resourceId)
      const created = await call({
        who: guestA,
        url,
        method: 'PUT',
        capability: guestAGrant,
        json: { text: 'guest A' }
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      const chunk = await putChunk({
        who: guestA,
        url: `${url}/chunks/0`,
        capability: guestAGrant
      })
      assert.equal(chunk.status, 204)
      return async function swap(): Promise<void> {
        const deleted = await call({ who: alice, url, method: 'DELETE' })
        assert.equal(deleted.status, 204)
        const recreated = await call({
          who: guestB,
          url,
          method: 'PUT',
          capability: guestBGrant,
          json: { text: 'guest B' }
        })
        assert.equal(recreated.status, 201, JSON.stringify(recreated.data))
        const rechunked = await putChunk({
          who: guestB,
          url: `${url}/chunks/0`,
          capability: guestBGrant
        })
        assert.equal(rechunked.status, 204)
      }
    }

    /**
     * Runs `swap` once, just before the backend's `method` serves its
     * `nth` read of the Resource, and restores the method afterward.
     */
    async function withSwapBefore<T>({
      method,
      resourceId,
      nth = 1,
      swap,
      run
    }: {
      method: 'getResource' | 'getResourceMetadata' | 'getChunk' | 'listChunks'
      resourceId: string
      nth?: number
      swap: () => Promise<void>
      run: () => Promise<T>
    }): Promise<T> {
      const real = backend[method].bind(backend) as (
        options: any
      ) => Promise<any>
      let seen = 0
      ;(backend as any)[method] = async (options: any) => {
        if (options.resourceId === resourceId && ++seen === nth) {
          await swap()
        }
        return real(options)
      }
      try {
        const result = await run()
        assert.ok(seen >= nth, `${method} was not reached`)
        return result
      } finally {
        delete (backend as any)[method]
      }
    }

    it("Get Resource does not serve the other party's content", async () => {
      const resourceId = `raced-get-${randomUUID()}`
      const swap = await ownedThenSwapped(resourceId)
      assertMasked(
        await withSwapBefore({
          method: 'getResource',
          resourceId,
          swap,
          run: () =>
            call({
              who: guestA,
              url: resourceUrl(resourceId),
              capability: guestAGrant
            })
        }),
        'GET after the swap'
      )
    })

    it('Head Resource and Get Resource Metadata are refused', async () => {
      for (const [method, suffix] of [
        ['HEAD', ''],
        ['GET', '/meta']
      ] as const) {
        const resourceId = `raced-meta-${randomUUID()}`
        const swap = await ownedThenSwapped(resourceId)
        const result = await withSwapBefore({
          method: 'getResourceMetadata',
          resourceId,
          // The first read is the ownership check, the second the one served.
          nth: 2,
          swap,
          run: () =>
            call({
              who: guestA,
              url: `${resourceUrl(resourceId)}${suffix}`,
              method,
              capability: guestAGrant
            })
        })
        assert.equal(result.status, 404, `${method} ${suffix}`)
      }
    })

    it('Get Chunk and the chunk listing are refused', async () => {
      for (const [method, suffix] of [
        ['getChunk', '/chunks/0'],
        ['listChunks', '/chunks/']
      ] as const) {
        const resourceId = `raced-chunk-${randomUUID()}`
        const swap = await ownedThenSwapped(resourceId)
        assertMasked(
          await withSwapBefore({
            method,
            resourceId,
            swap,
            run: () =>
              call({
                who: guestA,
                url: `${resourceUrl(resourceId)}${suffix}`,
                capability: guestAGrant
              })
          }),
          `GET ${suffix} after the swap`
        )
      }
    })
  })

  it('refuses a Resource with no createdBy (an import of an unattested archive)', async () => {
    const sourceId = `own-source-${randomUUID()}`
    const destId = `own-dest-${randomUUID()}`
    await createSpace(sourceId)
    const sourceUrl = spaceUrlFor(sourceId)
    await createCollection('notes', {}, sourceUrl)
    const sourceNotes = collectionUrl('notes', sourceUrl)
    const created = await call({
      who: guestA,
      url: resourceUrl('note', sourceNotes),
      method: 'PUT',
      capability: await grant({
        to: guestA,
        target: sourceNotes,
        caveats: [OWN_RESOURCES_ONLY]
      }),
      json: { text: 'mine' }
    })
    assert.equal(created.status, 201)

    // This server has no identity, so its export carries no provenance and
    // the import keeps no createdBy.
    const exported = await call({
      who: alice,
      url: `${sourceUrl}export`,
      method: 'POST'
    })
    assert.equal(exported.status, 200)
    const tarBytes = new Uint8Array(await exported.response.arrayBuffer())
    await createSpace(destId)
    const destUrl = spaceUrlFor(destId)
    const imported = await call({
      who: alice,
      url: `${destUrl}import`,
      method: 'POST',
      body: tarBytes,
      headers: { 'content-type': 'application/x-tar' }
    })
    assert.equal(imported.status, 200, JSON.stringify(imported.data))
    const destNotes = collectionUrl('notes', destUrl)
    const url = resourceUrl('note', destNotes)
    assert.equal((await metaOf(url)).createdBy, undefined)

    const caveat = await grant({
      to: guestA,
      target: destNotes,
      caveats: [OWN_RESOURCES_ONLY]
    })
    const plain = await grant({ to: guestA, target: destNotes })
    assert.equal(
      (await call({ who: guestA, url, capability: plain })).status,
      200
    )
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assertMasked(
        await call({
          who: guestA,
          url,
          method,
          capability: caveat,
          ...(method === 'PUT' && { json: { text: 'tampered' } })
        }),
        `${method} of a Resource with no createdBy`
      )
    }
    const listed = await call({
      who: guestA,
      url: destNotes,
      capability: caveat
    })
    assert.equal(listed.status, 200)
    assert.deepStrictEqual(listed.data.items, [])
    assert.equal(listed.data.totalItems, 0)
  })

  it('the service description lists the caveat types on the authorization profile entry', async () => {
    const response = await fetch(`${baseServerUrl}service`)
    assert.equal(response.status, 200)
    const { specs } = (await response.json()) as {
      specs: Record<string, Array<Record<string, unknown>>>
    }
    const [profile] = specs['https://w3id.org/pws/authz-profile']!
    assert.equal(profile!.version, '0.2')
    assert.deepStrictEqual(profile!.zcapCaveats, ['OwnResourcesOnly'])
  })
})
