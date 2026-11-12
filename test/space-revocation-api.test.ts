/**
 * Space-scoped zcap revocation tests (Vitest):
 * POST `/space/:spaceId/zcaps/revocations/:revocationId`, the WAS-route
 * sibling of the `/kms` revocation endpoint. A capability delegated from a
 * Space's root capability is revoked here, and is rejected from then on
 * wherever a Space-rooted chain is verified -- the write routes
 * (`fetchSpaceAndVerify`) and the capability leg of the read routes
 * (`authorize`).
 *
 * Invocations are raw `@interop/ezcap` requests: the wire contract for
 * revocation is not (yet) part of the high-level `@interop/pws-client`
 * surface, and the negative cases need to shape the invocation by hand --
 * the same house pattern as the `/kms` revocation suite.
 */
import { it, describe, beforeAll, afterAll, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { ProblemTypes } from '@interop/storage-core'

import { spaceRevocationsPath } from '../src/lib/paths.js'
import {
  client,
  delegate,
  openTempBackend,
  requestError,
  rootZcap as makeRootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Space zcap revocations (/space/:spaceId/zcaps/revocations)', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any

  // Fresh ids per run so re-runs against a dirty data dir cannot collide.
  const spaceId = randomUUID()
  const otherSpaceId = randomUUID()
  const collectionId = 'credentials'

  let spaceUrl: string
  let otherSpaceUrl: string
  let collectionUrl: string

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ baseServerUrl }))

    spaceUrl = new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    otherSpaceUrl = new URL(`/space/${otherSpaceId}/`, baseServerUrl).toString()
    collectionUrl = new URL(
      `/space/${spaceId}/${collectionId}`,
      baseServerUrl
    ).toString()

    for (const id of [spaceId, otherSpaceId]) {
      const space = alice.pws.space(id)
      await space.configure({ name: 'Revocation Space', controller: alice.did })
      await space
        .collection(collectionId)
        .configure({ name: 'Credentials', force: true })
    }
  })
  afterAll(async () => {
    await fastify.close()
  })

  // The root capability for a target URL, controlled by Alice (this suite's
  // Space controller). Delegates to the shared builder.
  const rootZcap = (target: string) =>
    makeRootZcap({ target, controller: alice.did })

  /**
   * The revocation submission URL for a capability id, built by the shared
   * path builder -- so these tests pin `spaceRevocationsPath` against the
   * live route.
   */
  function revocationUrl(capabilityId: string, space = spaceId): string {
    return new URL(
      spaceRevocationsPath({ spaceId: space, revocationId: capabilityId }),
      baseServerUrl
    ).toString()
  }

  /**
   * Delegates read/write on a Collection from its Space's root capability --
   * the "session key" shape a controller hands an app.
   */
  async function sessionDelegate({
    target = collectionUrl,
    root = spaceUrl,
    controller = aliceDelegatedApp.did,
    allowedActions = ['GET', 'PUT', 'POST', 'DELETE']
  }: {
    target?: string
    root?: string
    controller?: string
    allowedActions?: string[]
  } = {}) {
    return delegate({
      signer: alice.signer,
      capability: `urn:zcap:root:${encodeURIComponent(root)}`,
      invocationTarget: target,
      controller,
      allowedActions
    })
  }

  /** Submits a revocation, invoking `capability` as `signer`. */
  async function revoke({
    capabilityToRevoke,
    signer,
    capability,
    url
  }: {
    capabilityToRevoke: any
    signer: any
    capability: any
    url?: string
  }) {
    return client({ signer }).request({
      url: url ?? revocationUrl(capabilityToRevoke.id),
      method: 'POST',
      action: 'POST',
      capability,
      json: capabilityToRevoke
    })
  }

  /** Reads a Resource under `zcap` -- the access a revocation withdraws. */
  async function readDoc({ zcap, signer }: { zcap: any; signer: any }) {
    return client({ signer }).request({
      url: `${collectionUrl}/doc-1`,
      method: 'GET',
      action: 'GET',
      capability: zcap
    })
  }

  /**
   * Mints a two-hop chain whose parent expires first: the app's one-hour
   * grant from `sessionDelegate()`, and under it a 30-minute grant to Bob. Once the
   * clock is shifted past both (`shiftClockPastExpiry`), the chain walk
   * refuses the expired parent link before the invocation purpose ever looks
   * at the leaf. ezcap refuses to sign an already-expired delegation, which
   * is why the chain is minted before the shift.
   */
  async function mintExpiredParentChain() {
    const parent = await sessionDelegate()
    const child = await delegate({
      signer: aliceDelegatedApp.signer,
      capability: parent,
      invocationTarget: collectionUrl,
      controller: bob.did,
      allowedActions: ['GET'],
      expires: new Date(Date.now() + 30 * 60 * 1000)
    })
    return { parent, child }
  }

  /**
   * Moves the clock two hours ahead: past every grant this suite mints and
   * past the verifier's 300s clock-skew grace. Only `Date` is faked: the
   * server runs in this process, so its verification reads the same shifted
   * clock, while the HTTP stack keeps its real timers. Callers restore the
   * clock in `afterEach` with `vi.useRealTimers()`.
   */
  function shiftClockPastExpiry() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
  }

  beforeAll(async () => {
    await alice.pws.space(spaceId).collection(collectionId).put('doc-1', {
      hello: 'world'
    })
  })

  describe('revoking a Space-rooted capability', () => {
    it('the delegator revokes; the delegee loses access', async () => {
      const zcap = await sessionDelegate()
      const before = await readDoc({ zcap, signer: aliceDelegatedApp.signer })
      assert.equal(before.status, 200)

      const response = await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })
      assert.equal(response.status, 204)

      const err = await requestError(
        readDoc({ zcap, signer: aliceDelegatedApp.signer })
      )
      assert.equal(err.status, 404)
      // The holder is told why: the type names the revocation, the status
      // stays the merged not-found.
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_REVOKED)

      // The controller's own (root) access is untouched: root zcaps cannot be
      // revoked, and no revocation applies to a chain of just the root.
      const doc = await alice.pws
        .space(spaceId)
        .collection(collectionId)
        .get('doc-1')
      assert.deepStrictEqual(doc, { hello: 'world' })
    })

    it('a revoked capability cannot write either (fetchSpaceAndVerify)', async () => {
      const zcap = await sessionDelegate()
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).request({
          url: `${collectionUrl}/doc-2`,
          method: 'PUT',
          action: 'PUT',
          capability: zcap,
          json: { escape: true }
        })
      )
      assert.equal(err.status, 404)
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_REVOKED)
      // ...and the write did not land.
      const doc = await alice.pws
        .space(spaceId)
        .collection(collectionId)
        .get('doc-2')
      assert.equal(doc, null)
    })

    it('a delegee revokes its own zcap (dual-root rule)', async () => {
      const zcap = await sessionDelegate()

      // The app is not the Space controller; it qualifies purely as a
      // controller in the to-be-revoked zcap's chain, so it invokes the
      // revocation URL's own root capability.
      const response = await revoke({
        capabilityToRevoke: zcap,
        signer: aliceDelegatedApp.signer,
        capability: rootZcap(revocationUrl(zcap.id))
      })
      assert.equal(response.status, 204)

      const err = await requestError(
        readDoc({ zcap, signer: aliceDelegatedApp.signer })
      )
      assert.equal(err.status, 404)
    })

    it('revocation withdraws only what the capability granted (permissive policy)', async () => {
      // A revoked capability falls through to the target's access-control
      // policy, which can only broaden access. Read access a PublicCanRead
      // policy already grants everyone therefore survives the revocation --
      // what is withdrawn is the capability, not the policy's grant.
      const publicCollectionId = 'public-notices'
      const publicCollection = alice.pws
        .space(spaceId)
        .collection(publicCollectionId)
      await publicCollection.configure({ name: 'Notices', force: true })
      await publicCollection.put('notice-1', { open: true })
      await publicCollection.setPublic()

      const publicUrl = new URL(
        `/space/${spaceId}/${publicCollectionId}`,
        baseServerUrl
      ).toString()
      const zcap = await sessionDelegate({ target: publicUrl })
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      // Reading with the revoked capability still succeeds -- via the policy,
      // not the capability. Writing, which no policy grants, does not.
      const response = await client({
        signer: aliceDelegatedApp.signer
      }).request({
        url: `${publicUrl}/notice-1`,
        method: 'GET',
        action: 'GET',
        capability: zcap
      })
      assert.equal(response.status, 200)

      const err = await requestError(
        client({ signer: aliceDelegatedApp.signer }).request({
          url: `${publicUrl}/notice-2`,
          method: 'PUT',
          action: 'PUT',
          capability: zcap,
          json: { sneaky: true }
        })
      )
      assert.equal(err.status, 404)
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_REVOKED)
    })

    it('a non-participant cannot revoke (masked 404)', async () => {
      const zcap = await sessionDelegate()

      // Bob is neither the Space controller nor in the zcap's chain.
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: bob.signer,
          capability: rootZcap(revocationUrl(zcap.id))
        })
      )
      assert.equal(err.status, 404)

      // The capability still works: nothing was stored.
      const response = await readDoc({
        zcap,
        signer: aliceDelegatedApp.signer
      })
      assert.equal(response.status, 200)
    })

    it('a non-participant resubmitting an already-revoked capability gets the same masked 404 (no revocation-state oracle)', async () => {
      const zcap = await sessionDelegate()
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      // Bob is unauthorized either way; the store must be consulted only
      // after authorization, so his answer is the masked 404 whether or not
      // the capability is already revoked (a 400 here would disclose
      // revocation state).
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: bob.signer,
          capability: rootZcap(revocationUrl(zcap.id))
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('rejected submissions', () => {
    it('resubmitting a stored revocation is the 400 capability-already-revoked', async () => {
      const zcap = await sessionDelegate()
      await revoke({
        capabilityToRevoke: zcap,
        signer: alice.signer,
        capability: rootZcap(spaceUrl)
      })

      // The second submission passes authorization, then trips the
      // post-authorization store check -- the chain contains a revoked
      // capability. That hit carries its own problem type, so a client
      // resubmitting blind can tell it from a chain that does not verify;
      // the 409 duplicate is reserved for a write race at the store.
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.type, ProblemTypes.CAPABILITY_ALREADY_REVOKED)
    })

    it('a root capability cannot be revoked (400)', async () => {
      const root = rootZcap(spaceUrl)
      const err = await requestError(
        revoke({
          capabilityToRevoke: root,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
      )
      assert.equal(err.status, 400)
    })

    it('the capability id must match the revocation URL (400)', async () => {
      const zcap = await sessionDelegate()
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl),
          url: revocationUrl('urn:uuid:some-other-capability')
        })
      )
      assert.equal(err.status, 400)
    })

    it("a chain rooted in another Space can't be revoked here (400)", async () => {
      // A zcap delegated from a *different* Space's root capability, submitted
      // to this Space's revocation endpoint.
      const foreignZcap = await sessionDelegate({
        target: otherSpaceUrl,
        root: otherSpaceUrl
      })
      const err = await requestError(
        revoke({
          capabilityToRevoke: foreignZcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl),
          url: revocationUrl(foreignZcap.id)
        })
      )
      assert.equal(err.status, 400)

      // Revoked at its own Space, it stops working there -- scoping cuts both
      // ways.
      const response = await revoke({
        capabilityToRevoke: foreignZcap,
        signer: alice.signer,
        capability: rootZcap(otherSpaceUrl),
        url: revocationUrl(foreignZcap.id, otherSpaceId)
      })
      assert.equal(response.status, 204)
    })

    it('a capability whose delegation proof does not verify is refused (400)', async () => {
      // The chain roots in this Space and the submitter is its controller, so
      // the submission is authorized -- what fails is the chain verification
      // itself: the body was altered after signing, so the delegation proof no
      // longer covers it. A revocation submission requires a *verifying*
      // chain; a capability that never verified cannot be recorded as revoked.
      const zcap = await sessionDelegate()
      const tampered = structuredClone(zcap)
      tampered.allowedAction = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH']

      const err = await requestError(
        revoke({
          capabilityToRevoke: tampered,
          signer: alice.signer,
          capability: rootZcap(spaceUrl),
          url: revocationUrl(tampered.id)
        })
      )
      assert.equal(err.status, 400)
      // A chain that fails to verify is never reported as revoked.
      assert.equal(err.data.type, ProblemTypes.INVALID_REQUEST_BODY)
      assert.equal(
        err.data.errors[0].detail,
        'The provided capability delegation is invalid.'
      )

      // Nothing was stored under that capability id: the untampered original
      // still works.
      const response = await readDoc({
        zcap,
        signer: aliceDelegatedApp.signer
      })
      assert.equal(response.status, 200)
    })

    describe('typed denial reasons', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('a revoked capability invoked by someone other than its controller is the plain not-found (no revocation oracle)', async () => {
        // Bob holds Alice's app's revoked capability (say, a leaked copy) but
        // not the app's key. The verifier matches the invoking key against
        // the capability controller before it runs the revocation inspector,
        // so Bob learns nothing about the revocation: his answer is the same
        // masked not-found any unauthorized caller gets.
        const zcap = await sessionDelegate()
        await revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
        const err = await requestError(readDoc({ zcap, signer: bob.signer }))
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.NOT_FOUND)
      })

      it('a revoked capability whose delegation proof does not verify is the plain not-found', async () => {
        // The proof is checked before the revocation inspector runs, so a
        // holder presenting a tampered copy of a revoked grant gets the
        // generic failure, not the typed one.
        const zcap = await sessionDelegate()
        await revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
        const tampered = { ...zcap, allowedAction: ['GET', 'PUT'] }
        const err = await requestError(
          readDoc({ zcap: tampered, signer: aliceDelegatedApp.signer })
        )
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.NOT_FOUND)
      })

      it('an expired invoked capability is capability-expired (404)', async () => {
        // The leaf's own `expires` has passed: the invocation purpose refuses
        // it after the chain and the controller match verified.
        const zcap = await sessionDelegate()
        shiftClockPastExpiry()

        const err = await requestError(
          readDoc({ zcap, signer: aliceDelegatedApp.signer })
        )
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.CAPABILITY_EXPIRED)
        assert.equal(
          err.data.errors[0].detail,
          'The invoked capability, or a capability in its delegation chain, ' +
            'has expired.'
        )
      })

      it('an expired parent in the chain is capability-expired too (404)', async () => {
        // The chain walk refuses the expired parent link (a different
        // verifier check from the leaf's own expiry), and the server reports
        // the same cause for both.
        const { child } = await mintExpiredParentChain()
        shiftClockPastExpiry()

        const err = await requestError(
          readDoc({ zcap: child, signer: bob.signer })
        )
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.CAPABILITY_EXPIRED)
      })

      it('an expired parent invoked by someone other than the leaf controller is the plain not-found', async () => {
        // The zcap library raises the parent-link expiry while walking the
        // chain, before it matches the invoking key to the leaf's controller,
        // so the server does that match itself before naming the cause. The
        // delegator's own key is not the leaf's controller.
        const { child } = await mintExpiredParentChain()
        shiftClockPastExpiry()

        const err = await requestError(
          readDoc({ zcap: child, signer: aliceDelegatedApp.signer })
        )
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.NOT_FOUND)
      })

      it('an expired capability that is also revoked reports the expiry', async () => {
        // The verifier checks expiry before it runs the revocation inspector,
        // so the first refusal wins; either way the grant is dead.
        const zcap = await sessionDelegate()
        await revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(spaceUrl)
        })
        shiftClockPastExpiry()

        const err = await requestError(
          readDoc({ zcap, signer: aliceDelegatedApp.signer })
        )
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.CAPABILITY_EXPIRED)
      })

      it('an expired capability invoked by someone other than its controller is the plain not-found', async () => {
        // A leaf's expiry is checked after the controller match, so a holder
        // of a copy without the invoking key sees the generic failure.
        const zcap = await sessionDelegate()
        shiftClockPastExpiry()

        const err = await requestError(readDoc({ zcap, signer: bob.signer }))
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.NOT_FOUND)
      })

      it('a capability that fails verification for any other reason stays the plain not-found', async () => {
        // Wrong action: the capability grants GET only, the request PUTs.
        const zcap = await sessionDelegate({ allowedActions: ['GET'] })
        const err = await requestError(
          client({ signer: aliceDelegatedApp.signer }).request({
            url: `${collectionUrl}/doc-3`,
            method: 'PUT',
            action: 'PUT',
            capability: zcap,
            json: { nope: true }
          })
        )
        assert.equal(err.status, 404)
        assert.equal(err.data.type, ProblemTypes.NOT_FOUND)
      })
    })

    describe('an expired chain', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('is refused as invalid-request-body, not reported as revoked (400)', async () => {
        // The delegation proof purpose checks a parent's `expires` against
        // the clock while walking the chain (a lone leaf's expiry is the
        // invocation purpose's concern), so the expired link has to be the
        // parent.
        const { child } = await mintExpiredParentChain()
        shiftClockPastExpiry()

        const err = await requestError(
          revoke({
            capabilityToRevoke: child,
            signer: alice.signer,
            capability: rootZcap(spaceUrl)
          })
        )
        assert.equal(err.status, 400)
        assert.equal(err.data.type, ProblemTypes.INVALID_REQUEST_BODY)
        assert.equal(
          err.data.errors[0].detail,
          'The provided capability delegation is invalid.'
        )
      })
    })

    it('a capability whose delegation proof was signed by the wrong key is refused (400)', async () => {
      // A second-hop delegation signed by someone who does not control the
      // parent capability: structurally a chain rooted in this Space, but the
      // middle proof does not verify.
      const parent = await sessionDelegate()
      const forged = await delegate({
        signer: bob.signer,
        capability: parent,
        invocationTarget: collectionUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })

      const err = await requestError(
        revoke({
          capabilityToRevoke: forged,
          signer: alice.signer,
          capability: rootZcap(spaceUrl),
          url: revocationUrl(forged.id)
        })
      )
      assert.equal(err.status, 400)
      assert.equal(
        err.data.errors[0].detail,
        'The provided capability delegation is invalid.'
      )

      // The parent, which was never revoked, still works.
      const response = await readDoc({
        zcap: parent,
        signer: aliceDelegatedApp.signer
      })
      assert.equal(response.status, 200)
    })

    it('an unknown Space is a masked 404', async () => {
      const zcap = await sessionDelegate()
      const unknownSpaceId = randomUUID()
      const unknownSpaceUrl = new URL(
        `/space/${unknownSpaceId}/`,
        baseServerUrl
      ).toString()
      const err = await requestError(
        revoke({
          capabilityToRevoke: zcap,
          signer: alice.signer,
          capability: rootZcap(unknownSpaceUrl),
          url: revocationUrl(zcap.id, unknownSpaceId)
        })
      )
      assert.equal(err.status, 404)
    })
  })

  /**
   * `zcaps` is a reserved Collection id, so the route table gives the segment
   * to the revocation route and the not-found wildcard beneath it. These pin
   * that no method at the revocation shape, and no path beneath the segment,
   * reaches the parametric Collection or Resource routes.
   */
  describe('the `zcaps` segment shadows no Collection route', () => {
    /**
     * The route parameters find-my-way binds for one method and path, or
     * `null` when nothing is registered. A `collectionId` means the parametric
     * Collection or Resource branch won; a `revocationId` means this route did,
     * and a `*` means the not-found wildcard did.
     */
    function routeParams(method: string, url: string) {
      return fastify.findRoute({ method: method as never, url })?.params ?? null
    }

    it('takes POST at its own shape, whatever the final segment', () => {
      const encoded = encodeURIComponent('urn:uuid:1e2f3a4b')
      assert.deepEqual(
        routeParams('POST', `/space/s/zcaps/revocations/${encoded}`),
        {
          spaceId: 's',
          revocationId: 'urn:uuid:1e2f3a4b'
        }
      )
      // The final segment is a free parameter, so a percent-encoded absolute
      // URI is not what keeps the routes apart.
      assert.deepEqual(routeParams('POST', '/space/s/zcaps/revocations/meta'), {
        spaceId: 's',
        revocationId: 'meta'
      })
    })

    it('refuses every other method at that shape itself', () => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        assert.deepEqual(
          routeParams(method, '/space/s/zcaps/revocations/meta'),
          { spaceId: 's', revocationId: 'meta' },
          `${method} should reach the revocation route's 405 refusal`
        )
      }
    })

    it('answers every other path beneath the segment as not found', () => {
      assert.deepEqual(routeParams('POST', '/space/s/zcaps/'), {
        spaceId: 's',
        '*': ''
      })
      assert.deepEqual(routeParams('GET', '/space/s/zcaps/revocations'), {
        spaceId: 's',
        '*': 'revocations'
      })
    })

    it('registers no other POST at Resource sub-resource depth', () => {
      // The claim the comment rests on: nothing real is shadowed, because PWS
      // has no POST there. The only POST handler at that depth is the 405
      // `refuseUnimplementedMethods` synthesizes, which this route takes over
      // for the `zcaps`/`revocations` id pair alone.
      assert.deepEqual(routeParams('POST', '/space/s/notes/revocations/meta'), {
        spaceId: 's',
        collectionId: 'notes',
        resourceId: 'revocations'
      })
    })
  })
})
