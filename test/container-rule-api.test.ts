/**
 * Container-rule tests (Vitest): unsafe methods at a container URL -- a Space
 * or a Collection -- are controller-only, with two exceptions.
 *
 * The rule is keyed on the shape of the INVOKED capability (the chain's tail)
 * and is independent of who signed any link, so it holds whatever DID method
 * the Space controller or a delegator uses. `PUT /space/{s}/meta` on an
 * existing Space and `DELETE /space/{s}/{c}/` take a direct root-capability
 * invocation alone. `DELETE /space/{s}/` additionally takes a delegated
 * capability whose tail targets exactly that Space's canonical trailing-slash
 * URL with `allowedAction` exactly `['DELETE']`. `PUT /space/{s}/{c}/meta/log`,
 * the guarded create that puts a Collection under history-log governance,
 * takes a direct root invocation or a delegated capability whose tail targets
 * exactly the Space's items subtree (that same trailing-slash URL), the shape
 * a wallet's generation delegation carries. `PUT /space/{s}/{c}/meta` carries
 * no rule: a grant on the Space subtree, on the Collection container URL, or
 * on the Metadata URL itself writes the object, so an app holding a
 * Collection-scoped grant can declare its own indexes and `encryption`.
 *
 * The rule composes with the client-annex clause's invocation-time bounds
 * (`src/lib/clientAnnexClause.ts`), which key on who signed a link rather
 * than on the invoked shape. The one the last two groups exercise: a Space
 * DELETE is refused whenever any link in the chain is signed by a transient
 * annex verification method -- the per-visit key a wallet publishes in its
 * client-annex document under invocation and delegation alone -- whoever
 * signed the links above it, and whichever document names the annex. A
 * per-visit key's own delegation never ends an account or its annex. The
 * shapes a wallet's own delete flows invoke (a ladder-signed DELETE-only
 * child, invoked under a `did:key`) and an enrolled-client-signed DELETE-only
 * child stay admitted.
 *
 * Refusals are masked as a 404 like any other unauthorized invocation, and
 * each negative case reads the target back to show nothing changed.
 *
 * Invocations are raw `@interop/ezcap` requests where the wire shape of the
 * capability is the point, and the high-level `@interop/pws-client` handles
 * where provisioning is.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import {
  anHourFromNow,
  assertSpaceController,
  bareDidKeyOf,
  client,
  delegate,
  openTempBackend,
  requestError,
  rootZcap,
  provisionWebvhIdentity,
  startTestServer,
  zcapClients
} from './helpers.js'
import type { WebvhIdentity } from './helpers.js'

/** The service-entry type IRI naming an account's current annex DID. */
const DELEGATED_CLIENTS_SERVICE_TYPE = 'https://w3id.org/byoe#DelegatedClients'

/** The auxiliary Space's full type array, as a wallet would send it. */
const AUXILIARY_TYPE = ['AuxiliarySpace', 'DelegatedClientsSpace', 'Space']

/** The closed PWS action vocabulary a generation delegation carries. */
const WAS_ACTIONS = ['GET', 'POST', 'PUT', 'DELETE']

describe('container rule (unsafe methods at a container URL)', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any, bob: any

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
  })

  afterAll(async () => {
    await fastify.close()
  })

  /** One provisioned Space, with the URLs every case below addresses. */
  interface TestSpace {
    spaceId: string
    spaceUrl: string
    spaceMetaUrl: string
    rootId: string
  }

  /**
   * Provisions a fresh Space controlled by Alice's `did:key`, with one
   * Collection holding one Resource.
   *
   * @param [options] {object}
   * @param [options.collectionId] {string}   the Collection to create
   * @returns {Promise<TestSpace>}
   */
  async function provisionSpace({
    collectionId = 'notes'
  }: { collectionId?: string } = {}): Promise<TestSpace> {
    const spaceId = `container-${randomUUID()}`
    const created = await alice.pws.request({
      url: `${baseServerUrl}spaces/`,
      method: 'POST',
      json: { id: spaceId, name: 'Container Space', controller: alice.did }
    })
    assert.equal(created.status, 201)
    const space = alice.pws.space(spaceId)
    await space.collection(collectionId).configure({ force: true })
    await space.collection(collectionId).put('doc-1', { hello: 'world' })
    const spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    return {
      spaceId,
      spaceUrl,
      spaceMetaUrl: `${spaceUrl}meta`,
      rootId: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`
    }
  }

  /**
   * Asserts a Space is still there and still carries the expected controller.
   *
   * @param options {object}
   * @param options.space {TestSpace}
   * @param options.controller {string}
   * @returns {Promise<void>}
   */
  async function assertSpaceIntact({
    space,
    controller
  }: {
    space: TestSpace
    controller: string
  }): Promise<void> {
    const read = await alice.pws.request({
      url: `${baseServerUrl}space/${space.spaceId}/meta`,
      method: 'GET'
    })
    assert.equal(read.status, 200)
    assert.equal((read.data as { controller: string }).controller, controller)
  }

  /**
   * Asserts a Collection is still there, by reading its Metadata object.
   *
   * @param options {object}
   * @param options.space {TestSpace}
   * @param options.collectionId {string}
   * @returns {Promise<any>}   the Collection Metadata object
   */
  async function readCollectionMeta({
    space,
    collectionId
  }: {
    space: TestSpace
    collectionId: string
  }): Promise<any> {
    const read = await alice.pws.request({
      url: `${baseServerUrl}space/${space.spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    assert.equal(read.status, 200)
    return read.data
  }

  describe('a direct root invocation is admitted on all four operations', () => {
    it('PUT /space/{s}/meta rewrites the Space Metadata object', async () => {
      const space = await provisionSpace()
      const response = await client({ signer: alice.signer }).request({
        url: space.spaceMetaUrl,
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        }),
        json: {
          id: space.spaceId,
          name: 'Renamed by the controller',
          controller: alice.did
        }
      })
      assert.equal(response.status, 204)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('PUT /space/{s}/{c}/meta creates and updates a Collection', async () => {
      const space = await provisionSpace()
      const created = await client({ signer: alice.signer }).request({
        url: `${space.spaceUrl}fresh/meta`,
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        }),
        json: { name: 'Fresh' }
      })
      assert.equal(created.status, 201)
      const updated = await client({ signer: alice.signer }).request({
        url: `${space.spaceUrl}fresh/meta`,
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        }),
        json: { name: 'Fresher' }
      })
      assert.equal(updated.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'fresh' })
      assert.equal(meta.name, 'Fresher')
    })

    it('DELETE /space/{s}/{c}/ removes the Collection', async () => {
      const space = await provisionSpace()
      const response = await client({ signer: alice.signer }).request({
        url: `${space.spaceUrl}notes/`,
        method: 'DELETE',
        action: 'DELETE',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        })
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/notes/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })

    it('DELETE /space/{s}/ removes the Space', async () => {
      const space = await provisionSpace()
      const response = await client({ signer: alice.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        })
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('a Space-subtree grant with the full verb set', () => {
    /**
     * The generation-delegation shape: the trailing-slash Space URL with the
     * whole PWS verb vocabulary, delegated to Bob.
     *
     * @param space {TestSpace}
     * @returns {Promise<any>}
     */
    async function subtreeGrant(space: TestSpace): Promise<any> {
      return delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
    }

    it('cannot PUT the Space Metadata object (404, controller unchanged)', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: {
            id: space.spaceId,
            name: 'Seized',
            controller: bob.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('cannot DELETE the Space (404, the Space survives)', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('cannot DELETE a Collection (404, the Collection survives)', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${space.spaceUrl}notes/`,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await readCollectionMeta({ space, collectionId: 'notes' })
    })

    it('but CAN PUT a Collection Metadata object, created or updated', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      // The generation-collection create a transient session performs.
      const created = await client({ signer: bob.signer }).request({
        url: `${space.spaceUrl}generation/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Generation' }
      })
      assert.equal(created.status, 201)
      // ...and the unlock-methods registry write over an existing one.
      const updated = await client({ signer: bob.signer }).request({
        url: `${space.spaceUrl}notes/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Unlock methods' }
      })
      assert.equal(updated.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.name, 'Unlock methods')
    })
  })

  describe('the Delete Space exception', () => {
    it('admits an exactly-DELETE grant on the canonical Space URL', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const response = await client({ signer: bob.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })

    it('admits a DELETE-only child of a two-verb management parent', async () => {
      // The freewallet `manageCapability` shape: a Space's controller hands
      // out `['GET', 'DELETE']` on the Space URL, and the holder narrows it to
      // a DELETE-only child before invoking. The tail is what the rule reads.
      const space = await provisionSpace()
      const parent = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'DELETE']
      })
      const child = await delegate({
        signer: bob.signer,
        capability: parent,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const response = await client({ signer: bob.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(response.status, 204)
    })

    it('refuses a two-verb tail carrying DELETE (404)', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('refuses a DELETE-only tail whose target is a prefix (404)', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: new URL('/space/', baseServerUrl).toString(),
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('refuses a DELETE-only tail in the slash-less spelling (404)', async () => {
      // The slash-less Space URL is not a canonical target under v0.5. The
      // zcap library may refuse it before the rule does; either way the
      // request is denied and the Space stays.
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl.replace(/\/$/, ''),
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })
  })

  describe('Update Collection Metadata carries no container rule', () => {
    it('admits a grant targeting the Collection container URL', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/`,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${space.spaceUrl}notes/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Renamed under a container grant' }
      })
      assert.equal(response.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.name, 'Renamed under a container grant')
    })

    it('admits a grant targeting the Collection Metadata URL itself', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/meta`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${space.spaceUrl}notes/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Renamed under a meta grant' }
      })
      assert.equal(response.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.name, 'Renamed under a meta grant')
    })

    it('refuses a grant targeting a Resource URL', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/doc-1`,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${space.spaceUrl}notes/meta`,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: { name: 'Renamed under a resource grant' }
        })
      )
      // A Resource URL is neither the Metadata URL nor a prefix of it, so the
      // signing client refuses to mint the invocation and the request never
      // reaches the wire. The Collection Metadata object is unchanged either
      // way.
      assert.match(err.message, /invocationTarget/)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.notEqual(meta.name, 'Renamed under a resource grant')
    })
  })

  describe('the governing history log write', () => {
    /**
     * The genesis line of a governing history log: the JSON Lines entry whose
     * `state` the server serves as the Collection's `encryption` descriptor.
     *
     * @returns {string}
     */
    function genesisLog(): string {
      return (
        JSON.stringify({
          versionId: '1-hash1',
          versionTime: '2026-09-07T00:00:00Z',
          parameters: { method: 'resource-log:0.1', scid: 'zScid' },
          state: {
            type: 'WasEpochConfiguration',
            scheme: 'edv',
            currentEpoch: 'urn:epoch:1',
            epochs: [
              {
                id: 'urn:epoch:1',
                recipients: [
                  {
                    header: { kid: 'did:key:zApp1#ka', alg: 'ECDH-ES+A256KW' },
                    encrypted_key: 'wrapped-zApp1'
                  }
                ]
              }
            ]
          },
          proof: []
        }) + '\n'
      )
    }

    /**
     * The guarded create of a Collection's log, under one capability.
     *
     * @param options {object}
     * @param options.space {TestSpace}
     * @param options.signer {any}   the invoking signer
     * @param options.capability {any}   the capability to invoke, or a root id
     * @returns {Promise<any>}
     */
    async function putLog({
      space,
      signer,
      capability
    }: {
      space: TestSpace
      signer: any
      capability: any
    }): Promise<any> {
      return client({ signer }).request({
        url: `${space.spaceUrl}notes/meta/log`,
        method: 'PUT',
        action: 'PUT',
        capability,
        headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' },
        body: new TextEncoder().encode(genesisLog())
      })
    }

    /**
     * Asserts the Collection is still ungoverned: no log to read, and no
     * derived `encryption` descriptor on its Metadata object.
     *
     * @param space {TestSpace}
     * @returns {Promise<void>}
     */
    async function assertUngoverned(space: TestSpace): Promise<void> {
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.encryption, undefined)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/notes/meta/log`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    }

    it('refuses a grant targeting the Collection container URL (404)', async () => {
      // The guarded create is the declaration that puts the Collection under
      // log governance, and the head's `state` is served as its `encryption`
      // descriptor from then on -- so it takes the same rule the sibling
      // `PUT .../meta` takes, not a Collection-container data grant.
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/`,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        putLog({ space, signer: bob.signer, capability })
      )
      assert.equal(err.status, 404)
      await assertUngoverned(space)
    })

    it('admits a Space-subtree grant', async () => {
      const space = await provisionSpace()
      const capability = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const response = await putLog({ space, signer: bob.signer, capability })
      assert.equal(response.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.encryption.currentEpoch, 'urn:epoch:1')
    })

    it('admits a direct root invocation', async () => {
      const space = await provisionSpace()
      const response = await putLog({
        space,
        signer: alice.signer,
        capability: rootZcap({ target: space.spaceUrl, controller: alice.did })
      })
      assert.equal(response.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.encryption.currentEpoch, 'urn:epoch:1')
    })
  })

  describe('the enrolled-client-signed arm (no ladder link in the chain)', () => {
    // Every verification method here is published under all four relations
    // (the enrolled-client shape) or under invocation plus delegation (the
    // transient annex shape), so no link any of them signs is ladder-signed
    // and the clause's ladder bound never runs. What stands between these
    // delegations and the container writes is the container rule, plus the
    // clause's transient-annex bound on the one shape the rule admits.
    let account: WebvhIdentity
    let clientAnnex: WebvhIdentity &
      Required<Pick<WebvhIdentity, 'transientKeyPair'>>
    let auxSpace: TestSpace

    beforeAll(async () => {
      clientAnnex = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withTransientKey: true
      })
      account = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        services: [
          {
            id: '#delegated-clients',
            type: DELEGATED_CLIENTS_SERVICE_TYPE,
            serviceEndpoint: clientAnnex.did
          }
        ]
      })
      // Promotion by ordering: a Space is created under Alice's `did:key` and
      // only then handed to the account DID. The account Space and the
      // delegated-clients bookkeeping Space (typed as such) are independent,
      // so their two chains run side by side.
      const auxSpaceId = `annex-${randomUUID()}`
      await Promise.all([
        (async () => {
          await alice.pws
            .space(account.spaceId)
            .collection('credentials')
            .configure({ force: true })
          const promoted = await alice.pws.request({
            url: `${baseServerUrl}space/${account.spaceId}/meta`,
            method: 'PUT',
            json: {
              id: account.spaceId,
              name: 'Account Space',
              controller: account.did
            }
          })
          assert.equal(promoted.status, 204)
        })(),
        (async () => {
          const createdAux = await alice.pws.request({
            url: new URL('/spaces/', baseServerUrl).toString(),
            method: 'POST',
            json: {
              id: auxSpaceId,
              name: 'Delegated Clients',
              controller: alice.did,
              type: AUXILIARY_TYPE
            }
          })
          assert.equal(createdAux.status, 201)
          const auxPromoted = await alice.pws.request({
            url: `${baseServerUrl}space/${auxSpaceId}/meta`,
            method: 'PUT',
            json: {
              id: auxSpaceId,
              name: 'Delegated Clients',
              controller: account.did
            }
          })
          assert.equal(auxPromoted.status, 204)
        })()
      ])
      const auxUrl = new URL(`/space/${auxSpaceId}/`, baseServerUrl).toString()
      auxSpace = {
        spaceId: auxSpaceId,
        spaceUrl: auxUrl,
        spaceMetaUrl: `${auxUrl}meta`,
        rootId: `urn:zcap:root:${encodeURIComponent(auxUrl)}`
      }
    })

    /**
     * The generation delegation as a wallet mints it by default: signed by an
     * ENROLLED CLIENT's key (published under all four relations, so not a
     * ladder VM), targeting the account Space's items subtree with the whole
     * PWS verb vocabulary, controlled by the annex DID.
     *
     * @returns {Promise<any>}
     */
    async function generationDelegation(): Promise<any> {
      return delegate({
        signer: account.clientKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(account.spaceUrl)}`,
        invocationTarget: account.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
    }

    it('refuses the annex VM DELETE of the account Space (404)', async () => {
      const capability = await generationDelegation()
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: account.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: account.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses the annex VM PUT of the account Space Metadata object (404)', async () => {
      const capability = await generationDelegation()
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: `${account.spaceUrl}meta`,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: {
            id: account.spaceId,
            name: 'Seized',
            controller: clientAnnex.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: account.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses a delegated-clients grant PUT of the annex Space Metadata object (404)', async () => {
      const capability = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: auxSpace.rootId,
        invocationTarget: auxSpace.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: auxSpace.spaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: {
            id: auxSpace.spaceId,
            name: 'Delegated Clients',
            controller: clientAnnex.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: auxSpace.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('still lets the annex VM PUT a Collection Metadata object under the generation delegation', async () => {
      const capability = await generationDelegation()
      const response = await client({
        signer: clientAnnex.transientKeyPair.signer()
      }).request({
        url: `${account.spaceUrl}credentials/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Credentials' }
      })
      assert.equal(response.status, 204)
    })

    it('refuses an annex-VM DELETE-only target-exact child of the generation delegation (404)', async () => {
      // The one shape the container rule admits on this arm: the annex
      // verification method holds both relations, so it is not ladder
      // authority and may narrow the generation delegation into a
      // target-exact DELETE-only child, exactly the Delete Space exception's
      // shape. The clause's transient-annex bound refuses it on the signer:
      // the child is signed by a per-visit key, whoever signed the links
      // above it.
      const parent = await generationDelegation()
      const child = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: parent,
        invocationTarget: account.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: account.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: child
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: account.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses the same child handed on to a did:key invoker (404)', async () => {
      // The bound reads the signer of a link, not the invoker: the
      // transient-signed child is the tainted link whoever ends up holding it.
      const parent = await generationDelegation()
      const child = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: parent,
        invocationTarget: account.spaceUrl,
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: account.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: child
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: account.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses an annex-VM PUT-only child of the generation delegation against the Space Metadata object (404)', async () => {
      // The `controller-only` rule at this route refuses every delegated
      // invocation off the header, so the transient-annex bound carries no
      // PUT branch; this case pins that the rule covers a transient-signed
      // link too, not only a transient invoker of an enrolled-client link.
      const parent = await generationDelegation()
      const child = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: parent,
        invocationTarget: account.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: `${account.spaceUrl}meta`,
          method: 'PUT',
          action: 'PUT',
          capability: child,
          json: {
            id: account.spaceId,
            name: 'Seized',
            controller: clientAnnex.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: account.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses an annex-VM DELETE-only child of the delegated-clients sibling delegation against the annex Space (404)', async () => {
      // The sibling delegation a wallet mints carries `['GET', 'PUT', 'POST']`,
      // so a
      // DELETE-only child of it already fails attenuation. It is widened to
      // the full verb set here so the refusal turns on the signer alone: the
      // auxiliary annex Space is the account's, and a per-visit key never
      // ends it either.
      const sibling = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: auxSpace.rootId,
        invocationTarget: auxSpace.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const child = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: sibling,
        invocationTarget: auxSpace.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: auxSpace.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: child
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: auxSpace.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })
    it('refuses the same narrowing by a retired annex generation the account no longer names (404)', async () => {
      // The annex GC re-points `DelegatedClients` to the next generation and
      // tolerates a refused revocation, so a retired generation's grant can
      // outlive the pointer. Recognition reads the signer's own document, so
      // the pointer's absence changes nothing.
      const retired = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withTransientKey: true
      })
      const parent = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(account.spaceUrl)}`,
        invocationTarget: account.spaceUrl,
        controller: retired.did,
        allowedActions: WAS_ACTIONS
      })
      const child = await delegate({
        signer: retired.transientKeyPair.signer(),
        capability: parent,
        invocationTarget: account.spaceUrl,
        controller: retired.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: retired.transientKeyPair.signer() }).request({
          url: account.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: child
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: account.spaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses the same narrowing under a grant a did:key controller made to the annex directly (404)', async () => {
      // No delegator document names the annex here: the Space's `did:key`
      // controller hands the annex DID the Space URL with the full verb set.
      // The signer's own document still tells the per-visit key.
      const space = await provisionSpace()
      const parent = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const child = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: parent,
        invocationTarget: space.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: child
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('admits an enrolled-client-signed DELETE-only child invoked by the annex VM, and the Space goes', async () => {
      // The bound reads who signed a link, not who invokes it. An enrolled
      // client (all four relations) narrows the Space's root into a
      // target-exact DELETE-only child for the annex DID; no link is signed
      // by a per-visit key, so the container rule's exact-delete exception
      // decides alone and the per-visit invoker deletes the Space.
      const space = await provisionSpace()
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${space.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: space.spaceId,
          name: 'Enrolled Space',
          controller: account.did
        }
      })
      assert.equal(promoted.status, 204)
      const child = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['DELETE']
      })
      const response = await client({
        signer: clientAnnex.transientKeyPair.signer()
      }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('the ladder-signed DELETE-only tail (the shapes a transient login invokes)', () => {
    // A wallet's transient-login deletion signs its DELETE-only children with
    // the account's ladder VM and invokes them under that key's bare
    // `did:key`. No link is signed by a per-visit key, so the transient-annex
    // bound stays out of it; the ladder bound admits a chain whose every
    // ladder-signed link is target-exact and DELETE-only; the container rule
    // reads the same tail.
    let ladderAccount: WebvhIdentity &
      Required<Pick<WebvhIdentity, 'ladderKeyPair'>>

    beforeAll(async () => {
      ladderAccount = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withLadderKey: true
      })
    })

    it('admits a DELETE-only child of a three-verb management parent, and the Space goes', async () => {
      // The unlock-Space shape: a Space's `did:key` controller hands the
      // account `['GET', 'PUT', 'DELETE']` on the Space URL, the ladder VM
      // narrows it to a DELETE-only child on the same target, and the child's
      // bare `did:key` controller invokes.
      const space = await provisionSpace()
      const ladder = bareDidKeyOf(ladderAccount.ladderKeyPair)
      const manage = await delegate({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: ladderAccount.did,
        allowedActions: ['GET', 'PUT', 'DELETE'],
        expires: anHourFromNow()
      })
      const child = await delegate({
        signer: ladderAccount.ladderKeyPair.signer(),
        capability: manage,
        invocationTarget: space.spaceUrl,
        controller: ladder.did,
        allowedActions: ['DELETE'],
        expires: new Date(manage.expires)
      })
      const response = await client({ signer: ladder.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })

    it("admits a DELETE-only child straight off an account Space's root, and the Space goes", async () => {
      // The two-link chain: the Space is the account's own, so the
      // ladder-signed child hangs from the synthesized root, whose target is
      // the same canonical Space URL.
      const space = await provisionSpace()
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${space.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: space.spaceId,
          name: 'Container Space',
          controller: ladderAccount.did
        }
      })
      assert.equal(promoted.status, 204)
      const ladder = bareDidKeyOf(ladderAccount.ladderKeyPair)
      const child = await delegate({
        signer: ladderAccount.ladderKeyPair.signer(),
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: ladder.did,
        allowedActions: ['DELETE']
      })
      const response = await client({ signer: ladder.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.pws.request({
          url: `${baseServerUrl}space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })
  })
})
