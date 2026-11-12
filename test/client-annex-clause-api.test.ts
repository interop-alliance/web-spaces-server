/**
 * Client-annex-clause tests (Vitest): the bound on what a *ladder* verification
 * method of a self-hosted `did:webvh` account document may delegate.
 *
 * A ladder VM is recognized by relation asymmetry alone -- listed under
 * `capabilityDelegation`, absent from `capabilityInvocation`. A delegation it
 * signs is admitted only when it names the account document's annex DID as its
 * sole controller with a target inside the account Space's items subtree (the
 * Space Metadata URL excluded) and actions within the closed PWS verb
 * vocabulary, when its target is bridge-shaped (the account's own history log
 * with `PUT`, or the canonical URL of a delegated-clients bookkeeping Space
 * with `GET`/`PUT`), or when it is target-exact and single-verb: the canonical
 * Space URL equal to its parent capability's own, granted exactly `DELETE`, or
 * the Space Metadata URL under a parent on that URL or on the Space, granted
 * exactly `GET`, or one Resource URL under a parent on that URL or on its
 * Space, granted exactly `GET`, or the canonical Space URL equal to its
 * parent's own under a management capability the Space's controller delegated
 * to the account, granted exactly `POST`. On top of the
 * delegation shapes, a chain
 * carrying any ladder-signed link is refused at invocation time against Update
 * Space Metadata (`PUT .../meta`) and against Delete Space
 * (`DELETE /space/{s}/`) unless the invoked capability is that DELETE-only
 * shape -- under v0.5 both operations sit inside the subtree a generation
 * delegation covers.
 * Everything else is refused, and the refusal is masked as a 404 like any other
 * unauthorized invocation -- while still falling through to the access-control
 * policy, so a world-readable target keeps serving.
 *
 * A method holding both `capabilityInvocation` and `capabilityDelegation` --
 * the shape a per-visit annex verification method publishes under -- is not
 * ladder authority, so the clause skips the link it signed.
 *
 * The sixth shape, a replica pull gated on the annex document's replica
 * pointer, needs a second server to invoke as, so it is covered in
 * `ladder-replica-pull.test.ts`.
 *
 * Invocations are raw `@interop/ezcap` requests: these are wire-level
 * authorization shapes, not the high-level `@interop/pws-client` surface.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { KmsClient } from '@interop/webkms-client'

import { logToJsonlString, updateDID } from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'

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

describe('client-annex clause (ladder-VM delegation bounds)', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any, bob: any

  /** The account identity every ladder delegation below is signed under. */
  let account: WebvhIdentity & Required<Pick<WebvhIdentity, 'ladderKeyPair'>>
  /** The annex DID the account document's service entry names. */
  let clientAnnex: WebvhIdentity &
    Required<Pick<WebvhIdentity, 'transientKeyPair'>>
  let accountSpaceUrl: string
  let accountSpaceMetaUrl: string
  let accountLogUrl: string
  let credentialsUrl: string
  let openCollectionUrl: string

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))

    // The annex identity is provisioned first: the account document's service entry
    // has to name it, and a DID string is only known once its log is minted.
    clientAnnex = await provisionWebvhIdentity({
      owner: alice,
      baseServerUrl,
      withLadderKey: false,
      withTransientKey: true
    })
    account = await provisionWebvhIdentity({
      owner: alice,
      baseServerUrl,
      withLadderKey: true,
      services: [
        {
          id: '#delegated-clients',
          type: DELEGATED_CLIENTS_SERVICE_TYPE,
          serviceEndpoint: clientAnnex.did
        }
      ]
    })

    accountSpaceUrl = new URL(
      `/space/${account.spaceId}/`,
      baseServerUrl
    ).toString()
    accountSpaceMetaUrl = `${accountSpaceUrl}meta`
    accountLogUrl = `${accountSpaceUrl}id/did.jsonl`
    credentialsUrl = `${accountSpaceUrl}credentials`
    openCollectionUrl = `${accountSpaceUrl}open`

    const accountSpace = alice.pws.space(account.spaceId)
    await accountSpace.collection('credentials').configure({ force: true })
    await accountSpace
      .collection('credentials')
      .put('doc-1', { hello: 'world' })
    // A log-shaped target outside the `id` Collection, for the branch-one
    // refusal case.
    await accountSpace.collection('other').configure({ force: true })
    const openCollection = accountSpace.collection('open')
    await openCollection.configure({ force: true })
    await openCollection.put('note-1', { open: true })
    await openCollection.setPublic()

    // Promotion by ordering: the Space is created under Alice's `did:key`,
    // populated, and only then handed to the account DID.
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
  })

  afterAll(async () => {
    await fastify.close()
  })

  /** The account Space's root capability id, the parent of every WAS-route
   * delegation below. */
  function accountSpaceRoot(): string {
    return `urn:zcap:root:${encodeURIComponent(accountSpaceUrl)}`
  }

  describe('control: a non-ladder chain is untouched', () => {
    it('an ordinary client VM delegates an arbitrary target end to end', async () => {
      const delegated = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })
  })

  describe('predicate (i): the annex DID as controller', () => {
    it('admits a ladder delegation controlled by the annex DID', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET']
      })
      const response = await client({
        signer: clientAnnex.clientKeyPair.signer()
      }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('refuses a ladder delegation to some other controller (404)', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('the refused delegation cannot write either, and nothing lands', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: { escape: true }
        })
      )
      assert.equal(err.status, 404)

      const readBack = await client({
        signer: account.clientKeyPair.signer()
      }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({
          target: accountSpaceUrl,
          controller: account.did
        })
      })
      assert.deepStrictEqual(readBack.data, { hello: 'world' })
    })

    it('admits the generation-delegation shape on the Space subtree', async () => {
      // The shape a wallet actually mints: the trailing-slash account Space
      // URL with the full closed PWS verb vocabulary, granted to the annex
      // DID. Both a read and a write under it land.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const annex = client({ signer: clientAnnex.clientKeyPair.signer() })

      const read = await annex.request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { hello: 'world' })

      const written = await annex.request({
        url: `${credentialsUrl}/doc-generation`,
        method: 'PUT',
        action: 'PUT',
        capability: delegated,
        json: { minted: 'under-generation-delegation' }
      })
      assert.equal(written.status, 201)

      const readBack = await annex.request({
        url: `${credentialsUrl}/doc-generation`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(readBack.status, 200)
      assert.deepStrictEqual(readBack.data, {
        minted: 'under-generation-delegation'
      })
    })

    it('refuses the Space Metadata URL as a target to the same grantee (404)', async () => {
      // The Metadata URL is carved out of the items subtree: `PUT` there is
      // Update Space Metadata, and so the Space's controller.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceMetaUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: accountSpaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: {
            id: account.spaceId,
            name: 'Account Space',
            controller: bob.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: accountSpaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })
    })

    it('refuses the subtree grant invoked against Update Space Metadata, now by the container rule (404)', async () => {
      // The generation-delegation shape covers `.../meta` by attenuation under
      // v0.5, so the refusal is not the delegation shape's: the same grant
      // serves ordinary reads and writes (previous case) and refuses the
      // controller rewrite. The refusal now comes from the container rule --
      // `PUT /space/{s}/meta` is `controller-only`, refused before this clause
      // runs -- which shadows the clause's own PUT bound on the same case.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const annex = client({ signer: clientAnnex.clientKeyPair.signer() })
      const err = await requestError(
        annex.request({
          url: accountSpaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: {
            id: account.spaceId,
            name: 'Account Space',
            controller: bob.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceController({
        spaceUrl: accountSpaceUrl,
        controller: account.did,
        signer: account.clientKeyPair.signer()
      })

      // The GET half of the same URL is an ordinary read under the subtree.
      const read = await annex.request({
        url: accountSpaceMetaUrl,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
    })

    it('refuses the subtree grant invoked against Delete Space (404)', async () => {
      // `DELETE /space/{s}/` is the subtree URL itself, so a whole-subtree
      // grant matches it exactly; the invocation-time bound refuses any
      // ladder-descended chain there unless the invoked capability is the
      // DELETE-only shape of predicate (iii). A fresh account, so a failure
      // cannot take the suite's shared Space with it.
      const other = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withLadderKey: true,
        services: [
          {
            id: '#delegated-clients',
            type: DELEGATED_CLIENTS_SERVICE_TYPE,
            serviceEndpoint: clientAnnex.did
          }
        ]
      })
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${other.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: other.spaceId,
          name: 'Other Account',
          controller: other.did
        }
      })
      assert.equal(promoted.status, 204)
      const otherSpaceUrl = new URL(
        `/space/${other.spaceId}/`,
        baseServerUrl
      ).toString()
      const delegated = await delegate({
        signer: other.ladderKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(otherSpaceUrl)}`,
        invocationTarget: otherSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const annex = client({ signer: clientAnnex.clientKeyPair.signer() })
      const err = await requestError(
        annex.request({
          url: otherSpaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)

      // The Space survives: its Metadata object still reads back under the
      // same grant.
      const read = await annex.request({
        url: `${otherSpaceUrl}meta`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
      assert.equal((read.data as { controller: string }).controller, other.did)
    })

    it('refuses a subtree grant narrowed onward into the DELETE-only shape (404)', async () => {
      // The bypass the invocation-time bound has to survive. The annex's
      // per-visit verification method holds `capabilityInvocation` beside
      // `capabilityDelegation`, so it is not ladder authority and may mint
      // onward grants. Handed the ladder-signed whole-subtree grant, it
      // narrows its own child to the Space URL with exactly `DELETE` -- a
      // legal attenuation that lands a chain tail indistinguishable from the
      // predicate (iii) DELETE shape. A bound reading only the tail would
      // admit it and delete the Space; the bound reads the ladder-signed
      // links, which here carry the whole verb vocabulary.
      const other = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withLadderKey: true,
        services: [
          {
            id: '#delegated-clients',
            type: DELEGATED_CLIENTS_SERVICE_TYPE,
            serviceEndpoint: clientAnnex.did
          }
        ]
      })
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${other.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: other.spaceId,
          name: 'Narrowed Account',
          controller: other.did
        }
      })
      assert.equal(promoted.status, 204)
      const otherSpaceUrl = new URL(
        `/space/${other.spaceId}/`,
        baseServerUrl
      ).toString()

      const generationDelegation = await delegate({
        signer: other.ladderKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(otherSpaceUrl)}`,
        invocationTarget: otherSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const narrowed = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: generationDelegation,
        invocationTarget: otherSpaceUrl,
        controller: bob.did,
        allowedActions: ['DELETE'],
        expires: new Date(generationDelegation.expires)
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: otherSpaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: narrowed
        })
      )
      assert.equal(err.status, 404)

      // The Space survives the refusal.
      const read = await client({
        signer: other.clientKeyPair.signer()
      }).request({
        url: `${otherSpaceUrl}meta`,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({
          target: otherSpaceUrl,
          controller: other.did
        })
      })
      assert.equal(read.status, 200)
      assert.equal((read.data as { controller: string }).controller, other.did)
    })

    it("refuses a subtree target in another of the account's Spaces (404)", async () => {
      // A second Space promoted to the same account DID. The delegation hangs
      // off that Space's own root, so the zcap library's target attenuation
      // passes and the refusal is the clause's: the Space is not the one
      // carrying the account DID's log.
      const otherSpaceId = randomUUID()
      const otherSpace = alice.pws.space(otherSpaceId)
      await otherSpace.configure({ name: 'Other', controller: alice.did })
      await otherSpace.collection('notes').configure({ force: true })
      await otherSpace.collection('notes').put('note-1', { other: true })
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${otherSpaceId}/meta`,
        method: 'PUT',
        json: { id: otherSpaceId, name: 'Other', controller: account.did }
      })
      assert.equal(promoted.status, 204)

      const otherSpaceUrl = new URL(
        `/space/${otherSpaceId}/`,
        baseServerUrl
      ).toString()
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(otherSpaceUrl)}`,
        invocationTarget: otherSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: `${otherSpaceUrl}notes/note-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses an action outside the PWS verb vocabulary (404)', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET', 'PATCH']
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses an absent `allowedAction` on a subtree target (404)', async () => {
      // An empty `allowedActions` omits `allowedAction` from the delegation,
      // which permits any action in the zcap model.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: []
      })
      assert.equal(delegated.allowedAction, undefined)
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('a two-relation annex VM is outside the clause', () => {
    it('skips the grant link that annex VM signed, so it serves (200)', async () => {
      // The chain a transient wallet session mints: the root, then the
      // ladder-signed generation delegation the clause judges and admits
      // under predicate (i), then the grant the annex's own per-visit
      // verification method signs. That method holds `capabilityInvocation`
      // *and* `capabilityDelegation`, so the relation asymmetry does not
      // match and the clause skips its link. Were the link judged as ladder
      // authority, neither predicate could hold -- the controller is Bob, not
      // the annex DID, and the target is an ordinary Collection -- and this
      // read would be a 404.
      const generationDelegation = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET']
      })
      const grant = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: generationDelegation,
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(generationDelegation.expires)
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: grant
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('still serves when the generation delegation targets the subtree', async () => {
      // The same depth-3 chain, with the generation delegation in the shape a
      // wallet mints it: the trailing-slash account Space URL and the full
      // verb vocabulary. The clause admits the middle link on all three of its
      // bounds, and skips the annex-signed link as before.
      const generationDelegation = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const grant = await delegate({
        signer: clientAnnex.transientKeyPair.signer(),
        capability: generationDelegation,
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(generationDelegation.expires)
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: grant
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })
  })

  describe('a refusal still falls through to the access-control policy', () => {
    it('a world-readable target serves a refused ladder invocation (200)', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: openCollectionUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${openCollectionUrl}/note-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { open: true })
    })

    it('but the policy grants reads only -- a write is still refused', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: openCollectionUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${openCollectionUrl}/note-1`,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: { open: false }
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe("predicate (ii), branch one: the account's own log target", () => {
    /** PUTs an account's log bytes back, under `capability`. */
    async function putLog({
      signer,
      capability,
      url = accountLogUrl,
      log = account.log
    }: {
      signer: any
      capability: any
      url?: string
      log?: DIDLog
    }): Promise<any> {
      const jsonl = logToJsonlString(log)
      return client({ signer }).request({
        url,
        method: 'PUT',
        action: 'PUT',
        capability,
        headers: { 'content-type': 'text/jsonl' },
        body: new Blob([jsonl], { type: 'text/jsonl' })
      })
    }

    it("admits a PUT-only delegation of the account's own log", async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const response = await putLog({
        signer: bob.signer,
        capability: delegated
      })
      assert.equal(response.status, 200)
    })

    it('the same target granted GET is not the bridge, but predicate (iv) admits it (200)', async () => {
      // Branch one is PUT-only. The log is also a Resource under the account
      // Space, whose root is the parent here, so a GET-only grant of it is
      // the target-exact Resource read of predicate (iv) and serves.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountLogUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const response = await client({ signer: bob.signer }).request({
        url: accountLogUrl,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
    })

    it('refuses actions outside {PUT} (404)', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountLogUrl,
        controller: bob.did,
        allowedActions: ['PUT', 'DELETE']
      })
      const err = await requestError(
        putLog({ signer: bob.signer, capability: delegated })
      )
      assert.equal(err.status, 404)
    })

    it("refuses a log-shaped target that is not the account's own log (404)", async () => {
      const otherLogUrl = `${accountSpaceUrl}other/did.jsonl`
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: otherLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        putLog({
          signer: bob.signer,
          capability: delegated,
          url: otherLogUrl
        })
      )
      assert.equal(err.status, 404)
    })

    it("refuses another Space's `id/did.jsonl`, even account-controlled (404)", async () => {
      // A second Space promoted to the same account DID, with a Collection
      // named `id`: the exact shape a hardcoded `<S>/id/did.jsonl` match
      // would admit, but not the log the account DID itself is anchored in.
      const decoySpaceId = randomUUID()
      const decoySpace = alice.pws.space(decoySpaceId)
      await decoySpace.configure({ name: 'Decoy', controller: alice.did })
      await decoySpace.collection('id').configure({ force: true })
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${decoySpaceId}/meta`,
        method: 'PUT',
        json: { id: decoySpaceId, name: 'Decoy', controller: account.did }
      })
      assert.equal(promoted.status, 204)

      const decoySpaceUrl = new URL(
        `/space/${decoySpaceId}/`,
        baseServerUrl
      ).toString()
      const decoyLogUrl = `${decoySpaceUrl}id/did.jsonl`
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(decoySpaceUrl)}`,
        invocationTarget: decoyLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        putLog({ signer: bob.signer, capability: delegated, url: decoyLogUrl })
      )
      assert.equal(err.status, 404)
    })

    it('admits the bridge for an account anchored outside `id`', async () => {
      // The DID string carries its own log Collection, so an account anchored
      // in a `keys` Collection reaches the same bridge.
      const keysAccount = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withLadderKey: true,
        collectionId: 'keys'
      })
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${keysAccount.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: keysAccount.spaceId,
          name: 'Keys Account Space',
          controller: keysAccount.did
        }
      })
      assert.equal(promoted.status, 204)

      const keysSpaceUrl = new URL(
        `/space/${keysAccount.spaceId}/`,
        baseServerUrl
      ).toString()
      const keysLogUrl = `${keysSpaceUrl}keys/did.jsonl`
      const delegated = await delegate({
        signer: keysAccount.ladderKeyPair.signer(),
        capability: `urn:zcap:root:${encodeURIComponent(keysSpaceUrl)}`,
        invocationTarget: keysLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const response = await putLog({
        signer: bob.signer,
        capability: delegated,
        url: keysLogUrl,
        log: keysAccount.log
      })
      assert.equal(response.status, 200)
    })
  })

  describe('predicate (ii), branch two: a delegated-clients Space', () => {
    let auxSpaceId: string
    let auxSpaceUrl: string
    let auxSpaceRoot: string

    beforeAll(async () => {
      // Creation is `did:key`-only, so the auxiliary Space is created (and its
      // Collection provisioned) under Alice, then promoted to the account DID.
      auxSpaceId = randomUUID()
      auxSpaceUrl = new URL(`/space/${auxSpaceId}/`, baseServerUrl).toString()
      auxSpaceRoot = `urn:zcap:root:${encodeURIComponent(auxSpaceUrl)}`

      const created = await alice.pws.request({
        url: new URL('/spaces/', baseServerUrl).toString(),
        method: 'POST',
        json: {
          id: auxSpaceId,
          name: 'Delegated Clients',
          controller: alice.did,
          type: AUXILIARY_TYPE
        }
      })
      assert.equal(created.status, 201)
      await alice.pws
        .space(auxSpaceId)
        .collection('clients')
        .configure({ force: true })

      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${auxSpaceId}/meta`,
        method: 'PUT',
        json: {
          id: auxSpaceId,
          name: 'Delegated Clients',
          controller: account.did
        }
      })
      assert.equal(promoted.status, 204)
    })

    it('admits a GET/PUT grant on the whole auxiliary Space', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: auxSpaceRoot,
        invocationTarget: auxSpaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const recordUrl = `${auxSpaceUrl}clients/rec-1`
      const written = await client({ signer: bob.signer }).request({
        url: recordUrl,
        method: 'PUT',
        action: 'PUT',
        capability: delegated,
        json: { clientId: 'client-1' }
      })
      assert.equal(written.status, 201)

      const read = await client({ signer: bob.signer }).request({
        url: recordUrl,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { clientId: 'client-1' })
    })

    it('refuses the no-slash form of the same Space URL (404)', async () => {
      // Under v0.5 the no-slash form is not a canonical target (the route only
      // redirects), so it matches nothing here. Annex-profile grants pass the
      // canonical trailing-slash target explicitly (pws-client
      // `GrantOptions.target`).
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: auxSpaceRoot,
        invocationTarget: auxSpaceUrl.slice(0, -1),
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${auxSpaceUrl}clients/rec-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the whole-Space grant invoked against Update Space Metadata, now by the container rule (404)', async () => {
      // The admitted GET/PUT grant covers `.../meta` by attenuation; the
      // auxiliary Space's controller rewrite stays out of ladder reach all the
      // same. The refusing check is now the container rule's
      // (`controller-only` on `PUT /space/{s}/meta`, decided before this
      // clause runs); the clause's own PUT bound would refuse it too.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: auxSpaceRoot,
        invocationTarget: auxSpaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${auxSpaceUrl}meta`,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: {
            id: auxSpaceId,
            name: 'Delegated Clients',
            controller: bob.did
          }
        })
      )
      assert.equal(err.status, 404)

      const metadata = await client({ signer: bob.signer }).request({
        url: `${auxSpaceUrl}meta`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(metadata.status, 200)
      assert.equal(
        (metadata.data as { controller: string }).controller,
        account.did
      )
    })

    it('admits the {GET, PUT, POST} set on the same Space', async () => {
      // POST is what the backup export invokes on the annex Space; it joins
      // GET and PUT at mint rather than riding a delegation of its own.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: auxSpaceRoot,
        invocationTarget: auxSpaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT', 'POST']
      })
      const read = await client({ signer: bob.signer }).request({
        url: `${auxSpaceUrl}clients/rec-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { clientId: 'client-1' })
    })

    it('refuses actions outside {GET, PUT, POST} on the same Space (404)', async () => {
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: auxSpaceRoot,
        invocationTarget: auxSpaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT', 'POST', 'DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${auxSpaceUrl}clients/rec-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the same shape over an ordinary Space (404)', async () => {
      // The account's own Space is typed `['Space']` and controlled by the same
      // DID: only the Metadata type separates it from the case above.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })
  })

  /**
   * Creates an ordinary Space under Alice's `did:key` and, when `controller`
   * is given, promotes it to that DID (Space creation is `did:key`-only).
   * `url` is the canonical trailing-slash Space URL, the target of the
   * Space's root capability; `metaUrl` addresses its Metadata object;
   * `resourceUrl` names one record in a `keyring` Collection, the shape a
   * transient session reads under predicate (iv). The record exists only
   * when `withResource` is set: it is seeded before the promotion, while
   * Alice's `did:key` still controls the Space.
   *
   * @param [options] {object}
   * @param [options.controller] {string}   promote the Space to this DID
   * @param [options.withResource] {boolean}   seed the keyring record
   * @returns {Promise<{ spaceId: string, url: string, metaUrl: string, resourceUrl: string, root: string }>}
   */
  async function makeSpace({
    controller,
    withResource = false
  }: { controller?: string; withResource?: boolean } = {}): Promise<{
    spaceId: string
    url: string
    metaUrl: string
    resourceUrl: string
    root: string
  }> {
    const spaceId = randomUUID()
    const space = alice.pws.space(spaceId)
    await space.configure({ name: 'Unlock Space', controller: alice.did })
    if (withResource) {
      await space.collection('keyring').configure({ force: true })
      await space.collection('keyring').put('record-1', { keyring: true })
    }
    if (controller !== undefined) {
      const promoted = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'PUT',
        json: { id: spaceId, name: 'Unlock Space', controller }
      })
      assert.equal(promoted.status, 204)
    }
    const url = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    return {
      spaceId,
      url,
      metaUrl: `${url}meta`,
      resourceUrl: `${url}keyring/record-1`,
      root: `urn:zcap:root:${encodeURIComponent(url)}`
    }
  }

  /**
   * Mints the ladder-signed child of a chain: `controller` is the ladder
   * key's bare `did:key` (`bareDidKeyOf` in the helpers), the signer that
   * key, `allowedActions` defaults to `['GET']`, and `keyPair` to the
   * account's ladder key. Predicate (i) can never admit these chains: the
   * controller is a bare `did:key`, not the account document's annex
   * `did:webvh`.
   *
   * @param options {object}
   * @param options.invocationTarget {string}   the child's target
   * @param options.capability {string | object}   the parent, a root id or a
   *   delegated capability
   * @param [options.allowedActions] {string[]}
   * @param [options.expires] {Date}   an expiry within the parent's
   * @param [options.keyPair] {any}   the ladder key pair signing the child
   * @returns {Promise<{ child: object, ladder: { did: string, signer: any } }>}
   */
  async function ladderChild({
    invocationTarget,
    capability,
    allowedActions = ['GET'],
    expires,
    keyPair = account.ladderKeyPair
  }: {
    invocationTarget: string
    capability: string | object
    allowedActions?: string[]
    expires?: Date
    keyPair?: any
  }): Promise<{ child: any; ladder: { did: string; signer: any } }> {
    const ladder = bareDidKeyOf(keyPair)
    const child = await delegate({
      signer: keyPair.signer(),
      capability,
      invocationTarget,
      controller: ladder.did,
      allowedActions,
      expires
    })
    return { child, ladder }
  }

  describe('predicate (iii): a target-exact DELETE of a Space or GET of its Metadata', () => {
    it('admits a DELETE under a manageCapability parent, and the Space goes', async () => {
      // The three-link chain: a sibling unlock Space's root, the
      // `manageCapability` its `did:key` controller delegated to the account
      // DID, then the ladder-signed child that keeps the same canonical Space
      // target and narrows the actions to `DELETE` alone.
      const unlock = await makeSpace()
      const manage = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.url,
        controller: account.did,
        allowedActions: ['GET', 'PUT', 'DELETE'],
        expires: anHourFromNow()
      })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.url,
        allowedActions: ['DELETE'],
        expires: new Date(manage.expires)
      })

      const deleted = await client({ signer: ladder.signer }).request({
        url: unlock.url,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(deleted.status, 204)

      const gone = await requestError(
        client({ signer: alice.signer }).request({
          url: unlock.metaUrl,
          method: 'GET',
          action: 'GET',
          capability: rootZcap({ target: unlock.url, controller: alice.did })
        })
      )
      assert.equal(gone.status, 404)
    })

    it("admits a DELETE straight off an account Space's own root", async () => {
      // The two-link chain: the synthesized root's own target is the canonical
      // Space URL, so the ladder-signed child matches it unchanged.
      const space = await makeSpace({ controller: account.did })
      const { child: delegated, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.url,
        allowedActions: ['DELETE']
      })
      const deleted = await client({ signer: ladder.signer }).request({
        url: space.url,
        method: 'DELETE',
        action: 'DELETE',
        capability: delegated
      })
      assert.equal(deleted.status, 204)
    })

    it('admits the GET half under the Space root: a Space Metadata read (200)', async () => {
      // The parent is the Space's synthesized root, on the canonical Space
      // URL; the child narrows to the Metadata URL with `GET` alone.
      const space = await makeSpace({ controller: account.did })
      const { child: delegated, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.metaUrl
      })
      const response = await client({ signer: ladder.signer }).request({
        url: space.metaUrl,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      const metadata = response.data as { id: string; controller: string }
      assert.equal(metadata.id, space.spaceId)
      assert.equal(metadata.controller, account.did)
    })

    it('admits the GET half under a parent already on the Metadata URL (200)', async () => {
      // The other parent shape: a delegated capability whose own target is
      // the Metadata URL, so the child keeps it unchanged.
      const unlock = await makeSpace()
      const manage = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.metaUrl,
        controller: account.did,
        allowedActions: ['GET', 'PUT'],
        expires: anHourFromNow()
      })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.metaUrl,
        expires: new Date(manage.expires)
      })
      const response = await client({ signer: ladder.signer }).request({
        url: unlock.metaUrl,
        method: 'GET',
        action: 'GET',
        capability: child
      })
      assert.equal(response.status, 200)
      assert.equal((response.data as { id: string }).id, unlock.spaceId)
    })

    it("refuses a target under the parent's Space rather than the Space (404)", async () => {
      const { child: delegated, ladder } = await ladderChild({
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a GET on the Space URL itself (404)', async () => {
      // The GET branch admits the Metadata URL only: a GET on the container
      // would cover every member by attenuation, and the account Space is not
      // delegated-clients bookkeeping either.
      const { child: delegated, ladder } = await ladderChild({
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a two-verb {GET, DELETE} set on the Space URL (404)', async () => {
      const { child: delegated, ladder } = await ladderChild({
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        allowedActions: ['GET', 'DELETE']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: accountSpaceUrl,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('never reaches the clause with a DELETE aimed at the Metadata URL (405)', async () => {
      // The DELETE branch takes the Space URL alone; the Metadata URL is the
      // GET branch's, and only with `GET`. The clause never gets to say so
      // here: there is no `DELETE` at a Metadata URL, and the route answers
      // 405 before authorization runs at all. The refusal of a wrong verb at
      // this target is still observed one case below, where `PUT` is routable
      // and so does reach the clause.
      const space = await makeSpace({ controller: account.did })
      const { child: delegated, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.metaUrl,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.metaUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability: delegated
        })
      )
      assert.equal(err.status, 405)
      assert.equal(err.response.headers.get('allow'), 'GET, HEAD, PUT')
    })

    it('refuses a single verb outside {GET} and {DELETE} (404)', async () => {
      // `PUT` on the Metadata URL is Update Space Metadata, which could
      // rewrite the Space's controller.
      const { child: delegated, ladder } = await ladderChild({
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceMetaUrl,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: accountSpaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: {
            id: account.spaceId,
            name: 'Account Space',
            controller: account.did
          }
        })
      )
      assert.equal(err.status, 404)
    })

    it('stops verifying once the ladder VM leaves the account document', async () => {
      // The current-key-set rule applied to the delegation link: the child is
      // minted and exercised while the ladder VM stands, then one log entry
      // drops that method from the document and the same still-unexpired child
      // refuses. A fresh account identity, so the removal leaves the suite's
      // shared one untouched.
      const retiring = await provisionWebvhIdentity({
        owner: alice,
        baseServerUrl,
        withLadderKey: true
      })
      const space = await makeSpace({ controller: retiring.did })
      const { child: deleteChild, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.url,
        allowedActions: ['DELETE'],
        keyPair: retiring.ladderKeyPair
      })

      // A GET child on the Metadata URL proves the chain verifies right now,
      // without spending the Space the DELETE child is aimed at.
      const { child: readChild } = await ladderChild({
        capability: space.root,
        invocationTarget: space.metaUrl,
        keyPair: retiring.ladderKeyPair
      })
      const before = await client({ signer: ladder.signer }).request({
        url: space.metaUrl,
        method: 'GET',
        action: 'GET',
        capability: readChild
      })
      assert.equal(before.status, 200)

      // The removal entry restates the document with the ordinary client key
      // alone, signed by the update key still in `updateKeys`. It lands in the
      // log's own Collection, so that write drops the cached document too.
      const removed = await updateDID({
        log: retiring.log,
        signer: retiring.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: retiring.clientKeyPair.publicKeyMultibase!,
            purpose: [
              'authentication',
              'assertionMethod',
              'capabilityInvocation',
              'capabilityDelegation'
            ]
          }
        ] as any
      })
      const published = await alice.pws.request({
        url: `${baseServerUrl}space/${retiring.spaceId}/id/did.jsonl`,
        method: 'PUT',
        headers: { 'content-type': 'text/jsonl' },
        body: new Blob([logToJsonlString(removed.log)], { type: 'text/jsonl' })
      })
      assert.equal(published.status, 200)

      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.url,
          method: 'DELETE',
          action: 'DELETE',
          capability: deleteChild
        })
      )
      assert.equal(err.status, 404)

      // The Space the refused DELETE was aimed at is still there, read back
      // under the client key the removal entry kept.
      const metadata = await client({
        signer: retiring.clientKeyPair.signer()
      }).request({
        url: space.metaUrl,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({ target: space.url, controller: retiring.did })
      })
      assert.equal(metadata.status, 200)

      // The read half stops verifying with it, so nothing the ladder signed
      // survives the removal.
      const readErr = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.metaUrl,
          method: 'GET',
          action: 'GET',
          capability: readChild
        })
      )
      assert.equal(readErr.status, 404)
    })
  })

  describe('predicate (iv): a target-exact GET of one Resource', () => {
    it('admits the read under a manageCapability parent on the Space (200)', async () => {
      // The three-link chain a transient session holds: the unlock Space's
      // root, the management zcap its `did:key` controller delegated to the
      // account DID at bind time, and the ladder-signed child narrowed from
      // the whole Space down to the one Resource with `GET` alone.
      const unlock = await makeSpace({ withResource: true })
      const manage = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.url,
        controller: account.did,
        allowedActions: ['GET', 'PUT', 'DELETE'],
        expires: anHourFromNow()
      })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.resourceUrl,
        expires: new Date(manage.expires)
      })
      const response = await client({ signer: ladder.signer }).request({
        url: unlock.resourceUrl,
        method: 'GET',
        action: 'GET',
        capability: child
      })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { keyring: true })
    })

    it("admits the read straight off an account Space's own root (200)", async () => {
      const space = await makeSpace({
        controller: account.did,
        withResource: true
      })
      const { child, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.resourceUrl
      })
      const response = await client({ signer: ladder.signer }).request({
        url: space.resourceUrl,
        method: 'GET',
        action: 'GET',
        capability: child
      })
      assert.equal(response.status, 200)
    })

    it('admits the read under a parent already on the Resource URL (200)', async () => {
      const unlock = await makeSpace({ withResource: true })
      const manage = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.resourceUrl,
        controller: account.did,
        allowedActions: ['GET', 'PUT'],
        expires: anHourFromNow()
      })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.resourceUrl,
        expires: new Date(manage.expires)
      })
      const response = await client({ signer: ladder.signer }).request({
        url: unlock.resourceUrl,
        method: 'GET',
        action: 'GET',
        capability: child
      })
      assert.equal(response.status, 200)
    })

    it('refuses a second verb on the Resource URL (404)', async () => {
      const space = await makeSpace({
        controller: account.did,
        withResource: true
      })
      const { child, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.resourceUrl,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.resourceUrl,
          method: 'GET',
          action: 'GET',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a single verb other than GET on the Resource URL (404)', async () => {
      const space = await makeSpace({
        controller: account.did,
        withResource: true
      })
      const { child, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.resourceUrl,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.resourceUrl,
          method: 'PUT',
          action: 'PUT',
          capability: child,
          json: { keyring: false }
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the Collection container as a target (404)', async () => {
      // A GET on the container would cover every member by attenuation.
      const space = await makeSpace({
        controller: account.did,
        withResource: true
      })
      const { child, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: `${space.url}keyring/`
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.resourceUrl,
          method: 'GET',
          action: 'GET',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the Collection Metadata URL as a target (404)', async () => {
      // Three segments, but `meta` is a reserved Resource id: the predicate
      // admits a Resource, not any three-segment path.
      const space = await makeSpace({
        controller: account.did,
        withResource: true
      })
      const { child, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: `${space.url}keyring/meta`
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${space.url}keyring/meta`,
          method: 'GET',
          action: 'GET',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it("refuses a Resource in a Space other than the parent's (404)", async () => {
      // Aiming a child outside its parent's subtree never reaches the clause:
      // the zcap library's own target attenuation refuses the chain first. So
      // the case is only recorded through a parent the library does accept,
      // one test below.
      const parentSpace = await makeSpace({ controller: account.did })
      const otherSpace = await makeSpace({
        controller: account.did,
        withResource: true
      })
      const { child, ladder } = await ladderChild({
        capability: parentSpace.root,
        invocationTarget: otherSpace.resourceUrl
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: otherSpace.resourceUrl,
          method: 'GET',
          action: 'GET',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a parent on the Collection rather than the Resource or the Space (404)', async () => {
      // The one case the clause's parent bound decides on its own: the
      // library's attenuation admits a Resource under a Collection-targeted
      // parent, and the clause refuses it, since the parent is neither the
      // Resource URL nor the Space's canonical URL.
      const unlock = await makeSpace({ withResource: true })
      const manage = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: `${unlock.url}keyring/`,
        controller: account.did,
        allowedActions: ['GET', 'PUT'],
        expires: anHourFromNow()
      })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.resourceUrl,
        expires: new Date(manage.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: unlock.resourceUrl,
          method: 'GET',
          action: 'GET',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('predicate (v): a target-exact POST over a management zcap', () => {
    /**
     * The management zcap a sibling unlock Space's `did:key` controller
     * delegates to the account DID at bind time: the whole Space, all four
     * verbs, the parent every predicate (v) child hangs from.
     *
     * @param options {object}
     * @param options.unlock {{ url: string, root: string }}   the Space
     * @param [options.controller] {string}   the grantee, the account DID by
     *   default
     * @returns {Promise<any>}
     */
    async function manageCapability({
      unlock,
      controller = account.did
    }: {
      unlock: { url: string; root: string }
      controller?: string
    }): Promise<any> {
      return await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.url,
        controller,
        allowedActions: ['GET', 'PUT', 'DELETE', 'POST'],
        expires: anHourFromNow()
      })
    }

    it('admits a POST-only child, and Export Space runs under it (200)', async () => {
      // The three-link chain a transient session holds for a backup export:
      // the unlock Space's root, the management zcap its `did:key` controller
      // delegated to the account DID, and the ladder-signed child that keeps
      // the same canonical Space target and narrows the actions to `POST`.
      const unlock = await makeSpace({ withResource: true })
      const manage = await manageCapability({ unlock })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.url,
        allowedActions: ['POST'],
        expires: new Date(manage.expires)
      })
      const response = await client({ signer: ladder.signer }).request({
        url: `${unlock.url}export`,
        method: 'POST',
        action: 'POST',
        capability: child
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/x-tar')
    })

    it('refuses a PUT-only child (404)', async () => {
      // A `PUT` branch was drafted for the restore's create-by-id and
      // withdrawn before it landed: a `PUT` child of the Space URL reaches
      // every resource beneath the Space by prefix attenuation, so a
      // transient session on one credential could overwrite a sibling
      // credential's keyring record with no logged record of it. The write
      // this cell attempts is exactly that reach.
      const unlock = await makeSpace({ withResource: true })
      const manage = await manageCapability({ unlock })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.url,
        allowedActions: ['PUT'],
        expires: new Date(manage.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${unlock.url}keyring/record-2`,
          method: 'PUT',
          action: 'PUT',
          capability: child,
          json: { keyring: 'restored' }
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a two-verb {POST, PUT} child (404)', async () => {
      const unlock = await makeSpace()
      const manage = await manageCapability({ unlock })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.url,
        allowedActions: ['POST', 'PUT'],
        expires: new Date(manage.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${unlock.url}export`,
          method: 'POST',
          action: 'POST',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a child aimed below the Space URL (404)', async () => {
      // The target is the export endpoint itself rather than the canonical
      // Space URL, so it is not the parent's target unchanged. The library's
      // attenuation admits the chain; the clause is what refuses it.
      const unlock = await makeSpace()
      const manage = await manageCapability({ unlock })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: `${unlock.url}export`,
        allowedActions: ['POST'],
        expires: new Date(manage.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${unlock.url}export`,
          method: 'POST',
          action: 'POST',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a child aimed at the Space Metadata URL (404)', async () => {
      // `PUT` on a Metadata URL is the controller rewrite. The predicate takes
      // the container URL alone, and the invocation-time bound and the
      // `controller-only` container rule refuse this one over again.
      const unlock = await makeSpace()
      const manage = await manageCapability({ unlock })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.metaUrl,
        allowedActions: ['PUT'],
        expires: new Date(manage.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: unlock.metaUrl,
          method: 'PUT',
          action: 'PUT',
          capability: child,
          json: {
            id: unlock.spaceId,
            name: 'Unlock Space',
            controller: alice.did
          }
        })
      )
      assert.equal(err.status, 404)
    })

    it("refuses a child whose parent is the Space's synthesized root (404)", async () => {
      // Predicate (iii)'s DELETE branch takes a root parent; this one does
      // not. A root parent means no management capability was ever granted,
      // so there is nothing for the last link to widen the signer of.
      const space = await makeSpace({ controller: account.did })
      const { child, ladder } = await ladderChild({
        capability: space.root,
        invocationTarget: space.url,
        allowedActions: ['POST']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${space.url}export`,
          method: 'POST',
          action: 'POST',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a parent granted to a DID other than the account (404)', async () => {
      // The parent's sole `controller` must be the account whose document
      // publishes the ladder VM, since the predicate rests on the account
      // already holding this management capability. The verifier's own
      // delegator check reaches the same verdict here -- a ladder VM of one
      // account cannot delegate a capability controlled by another party --
      // and the clause states it as a shape requirement all the same.
      const unlock = await makeSpace()
      const manage = await manageCapability({ unlock, controller: bob.did })
      const { child, ladder } = await ladderChild({
        capability: manage,
        invocationTarget: unlock.url,
        allowedActions: ['POST'],
        expires: new Date(manage.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${unlock.url}export`,
          method: 'POST',
          action: 'POST',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })

    it("refuses a parent the Space's controller did not delegate (404)", async () => {
      // A four-link chain: the Space's controller grants Bob the whole Space,
      // Bob passes it to the account, and the ladder VM narrows to `POST`.
      // The parent's controller is the account, but the party that delegated
      // it is Bob rather than the Space's stored controller, so the parent is
      // not the management capability the predicate names.
      const unlock = await makeSpace()
      const toBob = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.url,
        controller: bob.did,
        allowedActions: ['GET', 'PUT', 'DELETE', 'POST'],
        expires: anHourFromNow()
      })
      const relayed = await client({ signer: bob.signer }).delegate({
        capability: toBob,
        invocationTarget: unlock.url,
        controller: account.did,
        allowedActions: ['GET', 'PUT', 'DELETE', 'POST'],
        expires: new Date(toBob.expires)
      })
      const { child, ladder } = await ladderChild({
        capability: relayed,
        invocationTarget: unlock.url,
        allowedActions: ['POST'],
        expires: new Date(relayed.expires)
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${unlock.url}export`,
          method: 'POST',
          action: 'POST',
          capability: child
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('the clause also runs on the /kms route family', () => {
    let keystoreId: string

    beforeAll(async () => {
      const config = await KmsClient.createKeystore({
        url: `${baseServerUrl}kms/keystores`,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      keystoreId = config.id!
      // Promote the keystore to the account DID, still authorized by the
      // stored `did:key`.
      const kmsClient = new KmsClient({ keystoreId })
      await kmsClient.updateKeystore({
        config: {
          id: keystoreId,
          sequence: 1,
          controller: account.did,
          kmsModule: 'local-v1'
        },
        invocationSigner: alice.signer
      })
    })

    it('an ordinary client VM still delegates keystore reads (200)', async () => {
      const delegated = await delegate({
        signer: account.clientKeyPair.signer(),
        capability: rootZcap({
          target: keystoreId,
          controller: account.did
        }),
        invocationTarget: keystoreId,
        controller: bob.did,
        allowedActions: ['read']
      })
      const response = await client({ signer: bob.signer }).request({
        url: keystoreId,
        method: 'GET',
        action: 'read',
        capability: delegated
      })
      assert.equal(response.status, 200)
    })

    it('a ladder-signed keystore delegation is refused (404)', async () => {
      // No kms target can be bridge-shaped, and a `/kms/...` path is not
      // inside any Space's items subtree, so no predicate can hold.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: rootZcap({
          target: keystoreId,
          controller: account.did
        }),
        invocationTarget: keystoreId,
        controller: bob.did,
        allowedActions: ['read']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: keystoreId,
          method: 'GET',
          action: 'read',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a keystore delegation to the annex DID (404)', async () => {
      // The grantee bound of predicate (i) holds -- the sole controller is the
      // annex DID the account document names -- and the delegation is still
      // refused: a `/kms/...` target is outside the account Space's items
      // subtree.
      const delegated = await delegate({
        signer: account.ladderKeyPair.signer(),
        capability: rootZcap({
          target: keystoreId,
          controller: account.did
        }),
        invocationTarget: keystoreId,
        controller: clientAnnex.did,
        allowedActions: ['read']
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: keystoreId,
          method: 'GET',
          action: 'read',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })
  })
})
