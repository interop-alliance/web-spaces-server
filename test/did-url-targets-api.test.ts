/**
 * DID URL invocation targets on the PWS Space routes (Vitest), end to end.
 *
 * The Space under test is promoted to a self-hosted `did:webvh` whose
 * document carries `PathHandler` services. A capability chain may root in
 * `urn:zcap:root:<encoded DID URL>`, whose DID URL is a `did:webvh` URL with a
 * path ending in `/` and no selector or fragment. The root's target must
 * dereference to exactly the canonical trailing-slash URL of the Space the
 * request addresses, and every link's target must be a DID URL that
 * dereferences at or beneath it. Every refusal is the masked `not-found`,
 * byte-identical to the body a signature by an unrelated key collects at the
 * same URL.
 *
 * The document's versions:
 *
 * - version 1: no services (as `provisionWebvhIdentity` mints it);
 * - version 2: `/` to the Space, `/pics` to its `photos` Collection, and
 *   `/pics/out` to its `albums` Collection, outside what `/pics` reaches;
 * - version 3, the current one until the last two groups update it: `/` and
 *   `/home` to the Space, `/pics` to its `albums` Collection, `/coll` to its
 *   `photos` Collection, `/other` to another Space on this server, `/up` to
 *   the `/space/` URL above every Space, and `/remote` to a Space URL on
 *   another host. Beneath `/photos`, which the `/` handler maps to the
 *   `photos` Collection: `/photos/up` to the Space URL and `/photos/x` to
 *   the `private` Collection, both outside it, `/photos/x/back` back inside
 *   it at `photos/doc-1`, and `/photos/2026` beneath it at `photos/doc-2`.
 *
 * Requests go out through `fastify.inject`, signed by
 * `signCapabilityInvocation`. The ezcap client refuses a DID URL capability at
 * an https URL, so it only mints the chains.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import { logToJsonlString, updateDID } from '@interop/did-method-webvh'
import type { DIDLog, ServiceEndpoint } from '@interop/did-method-webvh'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import jsigs from '@interop/jsonld-signatures'
import { ProblemTypes } from '@interop/storage-core'
import { KmsClient } from '@interop/webkms-client'
import { CapabilityDelegation } from '@interop/zcap'

import { absoluteSpaceUrl, spaceRevocationsPath } from '../src/lib/paths.js'
import { signedInject } from '../src/testing.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { rootCapabilityId } from '../src/zcap.js'
import {
  anHourFromNow,
  bareDidKeyOf,
  delegate,
  openTempBackend,
  provisionWebvhIdentity,
  pwsClient,
  startTestServer,
  zcapClients,
  pathHandler
} from './helpers.js'
import type { WebvhIdentity } from './helpers.js'

describe('DID URL invocation targets', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    server: { fastify: FastifyInstance; serverUrl: string },
    alice: any,
    bob: any,
    account: WebvhIdentity,
    did: string,
    spaceId: string,
    spaceUrl: string,
    otherSpaceUrl: string,
    sharedSpaceId: string,
    backend: TempFileSystemBackend,
    currentLog: DIDLog,
    owner: any,
    rogue: any

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    server = { fastify, serverUrl: baseServerUrl }
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))
    rogue = (await Ed25519VerificationKey.generate()).didKeySigner()

    account = await provisionWebvhIdentity({ owner: alice, baseServerUrl })
    ;({ did, spaceId, spaceUrl } = account)
    owner = account.clientKeyPair.signer()

    const space = alice.pws.space(spaceId)
    await space.collection('photos').configure({ force: true })
    await space.collection('photos').put('doc-1', { photo: 1 })
    await space.collection('photos').put('doc-2', { photo: 2 })
    await space.collection('albums').configure({ force: true })
    await space.collection('albums').put('a-1', { album: 1 })
    await space.collection('private').configure({ force: true })
    await space.collection('private').put('secret', { secret: true })
    // A tombstoned Collection, for the `?include=deleted` listing.
    await space.collection('gone').configure({ force: true })
    await space.collection('gone').delete()

    const otherSpaceId = randomUUID()
    await alice.pws
      .space(otherSpaceId)
      .configure({ name: 'Other Space', controller: alice.did })
    otherSpaceUrl = new URL(`/space/${otherSpaceId}/`, baseServerUrl).href

    // A second Space under the same controller, for the named denial causes.
    sharedSpaceId = randomUUID()
    await alice.pws
      .space(sharedSpaceId)
      .configure({ name: 'Shared Controller Space', controller: alice.did })
    await alice.pws.space(sharedSpaceId).collection('photos').configure({
      force: true
    })
    await alice.pws
      .space(sharedSpaceId)
      .collection('photos')
      .put('doc-1', { photo: 1 })

    const version2 = await updateDID({
      log: account.log,
      signer: account.logSigner,
      services: [
        pathHandler({ id: '#space', path: '/', serviceEndpoint: spaceUrl }),
        pathHandler({
          id: '#pics',
          path: '/pics',
          serviceEndpoint: `${spaceUrl}photos/`
        }),
        pathHandler({
          id: '#pics-out',
          path: '/pics/out',
          serviceEndpoint: `${spaceUrl}albums/`
        })
      ]
    })
    const version3 = await updateDID({
      log: version2.log,
      signer: account.logSigner,
      services: currentServices({ root: spaceUrl })
    })
    currentLog = version3.log
    const published = await alice.pws.request({
      url: `${spaceUrl}id/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(currentLog)], { type: 'text/jsonl' })
    })
    assert.equal(published.status, 200)

    const promoted = await alice.pws.request({
      url: `${spaceUrl}meta`,
      method: 'PUT',
      json: { id: spaceId, name: 'Identity Space', controller: did }
    })
    assert.equal(promoted.status, 204)
    const sharedPromoted = await alice.pws.request({
      url: `${baseServerUrl}space/${sharedSpaceId}/meta`,
      method: 'PUT',
      json: {
        id: sharedSpaceId,
        name: 'Shared Controller Space',
        controller: did
      }
    })
    assert.equal(sharedPromoted.status, 204)
  })

  afterAll(async () => {
    await fastify.close()
  })

  /**
   * The services of the document's current version, with `/` mounted at
   * `root`.
   *
   * @param options {object}
   * @param options.root {string}   the URL `/` dereferences to
   * @returns {ServiceEndpoint[]}
   */
  function currentServices({ root }: { root: string }): ServiceEndpoint[] {
    return [
      pathHandler({ id: '#space', path: '/', serviceEndpoint: root }),
      pathHandler({ id: '#home', path: '/home', serviceEndpoint: spaceUrl }),
      pathHandler({
        id: '#pics',
        path: '/pics',
        serviceEndpoint: `${spaceUrl}albums/`
      }),
      pathHandler({
        id: '#coll',
        path: '/coll',
        serviceEndpoint: `${spaceUrl}photos/`
      }),
      pathHandler({
        id: '#other',
        path: '/other',
        serviceEndpoint: otherSpaceUrl
      }),
      pathHandler({
        id: '#up',
        path: '/up',
        serviceEndpoint: new URL('/space/', baseServerUrl).href
      }),
      pathHandler({
        id: '#remote',
        path: '/remote',
        serviceEndpoint: `https://elsewhere.example/space/${spaceId}/`
      }),
      pathHandler({
        id: '#photos-up',
        path: '/photos/up',
        serviceEndpoint: spaceUrl
      }),
      pathHandler({
        id: '#photos-x',
        path: '/photos/x',
        serviceEndpoint: `${spaceUrl}private/`
      }),
      pathHandler({
        id: '#photos-x-back',
        path: '/photos/x/back',
        serviceEndpoint: `${spaceUrl}photos/doc-1`
      }),
      pathHandler({
        id: '#photos-2026',
        path: '/photos/2026',
        serviceEndpoint: `${spaceUrl}photos/doc-2`
      })
    ]
  }

  /**
   * Publishes a new version of the DID's history log through the request
   * layer, a fast-forward `PUT` by the Space's controller, which drops the
   * resolver's cached document for the DID.
   *
   * @param options {object}
   * @param options.services {ServiceEndpoint[]}   the new version's services
   * @returns {Promise<void>}
   */
  async function publishVersion({
    services
  }: {
    services: ServiceEndpoint[]
  }): Promise<void> {
    const updated = await updateDID({
      log: currentLog,
      signer: account.logSigner,
      services
    })
    const published = await signedInject({
      server,
      path: `/space/${spaceId}/id/did.jsonl`,
      signer: owner,
      method: 'PUT',
      body: new TextEncoder().encode(logToJsonlString(updated.log)),
      contentType: 'text/jsonl'
    })
    assert.equal(published.statusCode, 200, published.payload)
    currentLog = updated.log
  }

  /**
   * A Space-route GET or PUT by Bob under `capability`, asserted to be the
   * masked `not-found`.
   *
   * @param options {object}
   * @param options.path {string}
   * @param options.capability {object}
   * @param [options.method] {string}
   * @param [options.json] {object}
   * @returns {Promise<void>}
   */
  async function assertBobMasked({
    path,
    capability,
    method = 'GET',
    json
  }: {
    path: string
    capability: object
    method?: string
    json?: object
  }): Promise<void> {
    await assertMasked({
      response: await call({
        path,
        signer: bob.signer,
        capability,
        method,
        ...(json !== undefined && { json })
      }),
      path,
      method,
      ...(json !== undefined && { json })
    })
  }

  /**
   * The root capability id of a DID URL.
   *
   * @param [path] {string}   appended to the account DID
   * @returns {string}
   */
  function didRoot(path = '/'): string {
    return rootCapabilityId(`${did}${path}`)
  }

  /**
   * One signed request to a URL under the Space.
   *
   * @param options {object}
   * @param options.path {string}   the server-relative path
   * @param options.signer {any}
   * @param options.capability {string | object}
   * @param [options.method] {string}
   * @param [options.json] {object}
   * @returns {Promise<LightMyRequestResponse>}
   */
  async function call({
    path,
    signer,
    capability,
    method = 'GET',
    json
  }: {
    path: string
    signer: any
    capability: string | object
    method?: string
    json?: object
  }): Promise<LightMyRequestResponse> {
    return await signedInject({
      server,
      path,
      signer,
      capability,
      method,
      ...(json !== undefined && { json })
    })
  }

  /**
   * One signed request to any path on the server, the ones outside a Space
   * included. A root invocation, or a delegated one when `capability` is an
   * object.
   *
   * @param options {object}
   * @param options.path {string}   the server-relative path
   * @param options.signer {any}
   * @param options.capability {string | object}
   * @param [options.method] {string}
   * @param [options.action] {string}   the capability action; defaults to
   *   the method
   * @param [options.json] {object}
   * @returns {Promise<LightMyRequestResponse>}
   */
  async function anyCall({
    path,
    signer,
    capability,
    method = 'GET',
    action = method,
    json
  }: {
    path: string
    signer: any
    capability: string | object
    method?: string
    action?: string
    json?: object
  }): Promise<LightMyRequestResponse> {
    const headers = await signCapabilityInvocation({
      url: new URL(path, baseServerUrl).href,
      method,
      headers: { date: new Date().toUTCString() },
      ...(json !== undefined && { json }),
      capability: capability as any,
      capabilityAction: action,
      invocationSigner: signer
    })
    return await fastify.inject({
      method: method as any,
      url: path,
      headers: {
        ...(headers as Record<string, string>),
        host: new URL(baseServerUrl).host
      },
      ...(json !== undefined && { payload: JSON.stringify(json) })
    })
  }

  /**
   * Asserts a response is the masked `not-found`, byte for byte the body a
   * signature by an unrelated key collects for the same method and path.
   *
   * @param options {object}
   * @param options.response {LightMyRequestResponse}
   * @param options.path {string}
   * @param [options.method] {string}
   * @param [options.json] {object}
   * @returns {Promise<void>}
   */
  async function assertMasked({
    response,
    path,
    method = 'GET',
    json
  }: {
    response: LightMyRequestResponse
    path: string
    method?: string
    json?: object
  }): Promise<void> {
    const baseline = await anyCall({
      path,
      signer: rogue,
      capability: rootCapabilityId(spaceUrl),
      method,
      ...(json !== undefined && { json })
    })
    assert.equal(baseline.statusCode, 404)
    assert.equal(response.statusCode, 404, response.payload)
    assert.equal(
      response.headers['content-type'],
      baseline.headers['content-type']
    )
    assert.equal(response.payload, baseline.payload)
  }

  /**
   * Submits `revoked` to a Space's revocation route, under that Space's
   * https root unless `capability` names another invocation root.
   *
   * @param options {object}
   * @param options.revoked {object}   the capability to revoke, the body
   * @param options.signer {any}   the submitter's key
   * @param [options.atSpaceId] {string}   defaults to the Space under test
   * @param [options.capability] {string | object}   the invoked capability
   * @returns {Promise<LightMyRequestResponse>}
   */
  async function submitRevocation({
    revoked,
    signer,
    atSpaceId = spaceId,
    capability
  }: {
    revoked: any
    signer: any
    atSpaceId?: string
    capability?: string | object
  }): Promise<LightMyRequestResponse> {
    return await anyCall({
      path: spaceRevocationsPath({
        spaceId: atSpaceId,
        revocationId: revoked.id
      }),
      signer,
      capability:
        capability ??
        rootCapabilityId(
          absoluteSpaceUrl({ spaceId: atSpaceId, serverUrl: baseServerUrl })
        ),
      method: 'POST',
      json: revoked
    })
  }

  /**
   * Delegates from `parent` without the delegating side's own checks of the
   * child against its parent, for a chain the verifier is to refuse. Signed
   * as the ezcap client signs a delegation.
   *
   * @param options {object}
   * @param options.signer {any}   the delegation-proof signer
   * @param options.parent {string | object}   the parent capability
   * @param options.invocationTarget {string}
   * @param options.controller {string}
   * @param options.allowedActions {string[]}
   * @returns {Promise<any>}
   */
  async function delegateUnchecked({
    signer,
    parent,
    invocationTarget,
    controller,
    allowedActions
  }: {
    signer: any
    parent: string | { id: string; expires?: string }
    invocationTarget: string
    controller: string
    allowedActions: string[]
  }): Promise<any> {
    const parentCapability = typeof parent === 'string' ? parent : parent.id
    return await jsigs.sign(
      {
        '@context': 'https://w3id.org/zcap/v1',
        id: `urn:uuid:${randomUUID()}`,
        controller,
        parentCapability,
        invocationTarget,
        expires:
          typeof parent === 'string' || parent.expires === undefined
            ? anHourFromNow().toISOString().slice(0, -5) + 'Z'
            : parent.expires,
        allowedAction: allowedActions
      },
      {
        suite: new EddsaJcs2022({ signer }) as any,
        purpose: new CapabilityDelegation({
          parentCapability: parent as any,
          _skipLocalValidationForTesting: true
        }) as any
      } as any
    )
  }

  describe('admitted chains', () => {
    it('a root invocation of the DID URL root reads and writes', async () => {
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: owner,
        capability: didRoot()
      })
      assert.equal(read.statusCode, 200, read.payload)
      assert.deepEqual(read.json(), { photo: 1 })
      const written = await call({
        path: `/space/${spaceId}/photos/doc-3`,
        signer: owner,
        capability: didRoot(),
        method: 'PUT',
        json: { photo: 3 }
      })
      assert.equal(written.statusCode, 201, written.payload)
    })

    it('a second root path that dereferences to the Space is a root too', async () => {
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: owner,
        capability: didRoot('/home/')
      })
      assert.equal(read.statusCode, 200, read.payload)
    })

    it('a delegated chain reads and writes', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(read.statusCode, 200, read.payload)
      const written = await call({
        path: `/space/${spaceId}/photos/doc-4`,
        signer: bob.signer,
        capability: grant,
        method: 'PUT',
        json: { photo: 4 }
      })
      assert.equal(written.statusCode, 201, written.payload)
      // Outside the dereferenced Collection URL.
      const path = `/space/${spaceId}/albums/a-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })

    it('a two-link chain whose invoked capability carries its proof in an array reads', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const narrowed = await delegate({
        signer: bob.signer,
        capability: grant,
        invocationTarget: `${did}/photos/doc-1`,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(grant.expires)
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: { ...narrowed, proof: [narrowed.proof] }
      })
      assert.equal(read.statusCode, 200, read.payload)
    })

    it('a Resource-scoped link verifies at its dereferenced URL only', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/doc-1`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(read.statusCode, 200, read.payload)
      const path = `/space/${spaceId}/photos/doc-2`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })

    it('an alias handler is usable beneath the root', async () => {
      // `/pics` maps to the `albums` Collection URL, through another
      // `PathHandler` than the root's.
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/pics/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const read = await call({
        path: `/space/${spaceId}/albums/a-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(read.statusCode, 200, read.payload)
      assert.deepEqual(read.json(), { album: 1 })
      const path = `/space/${spaceId}/pics/a-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })
  })

  describe('refused roots', () => {
    const cases: Array<{ name: string; root: () => string }> = [
      {
        name: 'a root that dereferences to another Space on this server',
        root: () => didRoot('/other/')
      },
      {
        name: 'a root that dereferences to another host',
        root: () => didRoot('/remote/')
      },
      {
        name: 'a root that dereferences to a path above the Space URL',
        root: () => didRoot('/up/')
      },
      {
        name: 'a root that dereferences to a Collection URL',
        root: () => didRoot('/coll/')
      },
      {
        // `/home` dereferences to the Space URL, but the root form needs a
        // path ending in `/`.
        name: 'a root without the trailing slash',
        root: () => didRoot('/home')
      },
      { name: 'a root with no path', root: () => didRoot('') },
      {
        name: 'a root with a selector',
        root: () => didRoot('/?versionNumber=3')
      },
      { name: 'a root with a fragment', root: () => didRoot('/#space') },
      {
        name: 'a root naming a DID with no stored log',
        root: () =>
          rootCapabilityId(
            `did:webvh:${did.split(':')[2]}:elsewhere.invalid:space:${spaceId}:id/`
          )
      },
      {
        name: 'a root naming a did: method other than did:webvh',
        root: () =>
          rootCapabilityId(
            'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD/'
          )
      },
      {
        // A root id whose target does not encode back to the same id.
        name: 'a root id that is not the canonical encoding of its DID URL',
        root: () => `urn:zcap:root:${did}/`
      }
    ]

    for (const { name, root } of cases) {
      it(`refuses ${name} (404)`, async () => {
        const path = `/space/${spaceId}/photos/doc-1`
        await assertMasked({
          response: await call({ path, signer: owner, capability: root() }),
          path
        })
      })
    }

    it('refuses the same roots as the root of a delegated chain (404)', async () => {
      const path = `/space/${spaceId}/photos/doc-1`
      for (const root of [didRoot('/other/'), didRoot('/home')]) {
        const grant = await delegate({
          signer: owner,
          capability: root,
          invocationTarget: `${did}/photos/`,
          controller: bob.did,
          allowedActions: ['GET']
        })
        await assertMasked({
          response: await call({ path, signer: bob.signer, capability: grant }),
          path
        })
      }
    })
  })

  describe('refused links', () => {
    it('refuses a link that dereferences above the Space URL (404)', async () => {
      // The request URL is beneath what the link dereferences to, so only the
      // check that every link stays within the Space refuses it.
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/up/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })

    it('refuses an intermediate link outside the Space beneath which the tail returns (404)', async () => {
      const outside = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/up/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const tail = await delegate({
        signer: bob.signer,
        capability: outside,
        invocationTarget: `${did}/up/${spaceId}/photos/`,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(outside.expires)
      })
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: tail }),
        path
      })
    })

    it('refuses a DID URL root with an https link (404)', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${spaceUrl}photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })

    it('refuses an https root with a DID URL link (404)', async () => {
      const grant = await delegate({
        signer: owner,
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })

    it('still admits the https form of the same grant', async () => {
      const grant = await delegate({
        signer: owner,
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: `${spaceUrl}photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(read.statusCode, 200, read.payload)
    })
  })

  describe('version selectors', () => {
    it('a pin the first link introduces dereferences through that version', async () => {
      // Version 2 mapped `/pics` to the `photos` Collection; the current
      // version maps it to `albums`.
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/pics/?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(read.statusCode, 200, read.payload)
      const path = `/space/${spaceId}/albums/a-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })

    it('a link beneath the pin carries it unchanged', async () => {
      const pinned = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/pics/?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const narrowed = await delegate({
        signer: bob.signer,
        capability: pinned,
        invocationTarget: `${did}/pics/doc-1?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(pinned.expires)
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: narrowed
      })
      assert.equal(read.statusCode, 200, read.payload)
    })

    it('refuses a pin a later link introduces (404)', async () => {
      const unpinned = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const pinned = await delegateUnchecked({
        signer: bob.signer,
        parent: unpinned,
        invocationTarget: `${did}/pics/?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: pinned }),
        path
      })
    })

    it('refuses a changed pin (404)', async () => {
      const pinned = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/pics/?versionNumber=3`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const repinned = await delegateUnchecked({
        signer: bob.signer,
        parent: pinned,
        invocationTarget: `${did}/pics/?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      await assertMasked({
        response: await call({
          path,
          signer: bob.signer,
          capability: repinned
        }),
        path
      })
    })
  })

  // The dereferenced target is compared with the request URL as an https
  // target is, so a query the request adds is accepted.
  describe('query-bearing requests', () => {
    it('a paginated listing under a DID URL grant (200)', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const listed = await call({
        path: `/space/${spaceId}/photos/?limit=1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(listed.statusCode, 200, listed.payload)
      assert.equal(listed.json().items.length, 1)
    })

    it('`?include=deleted` under a DID URL grant lists the tombstone (200)', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const listed = await call({
        path: `/space/${spaceId}/?include=deleted`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(listed.statusCode, 200, listed.payload)
      assert.ok(JSON.stringify(listed.json()).includes('gone'), listed.payload)
    })

    it('a root invocation with a query (200)', async () => {
      const listed = await call({
        path: `/space/${spaceId}/photos/?limit=1`,
        signer: owner,
        capability: didRoot()
      })
      assert.equal(listed.statusCode, 200, listed.payload)
    })
  })

  describe('route families outside the Space routes refuse a DID URL root', () => {
    it('refuses it on /kms (404)', async () => {
      const keystore = await KmsClient.createKeystore({
        url: `${baseServerUrl}kms/keystores`,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      const keystoreUrl = (keystore as any).id as string
      const path = new URL(keystoreUrl).pathname
      // The webkms action vocabulary: a keystore read is `read`.
      const admitted = await anyCall({
        path,
        signer: alice.signer,
        capability: rootCapabilityId(keystoreUrl),
        action: 'read'
      })
      assert.equal(admitted.statusCode, 200, admitted.payload)
      const refused = await anyCall({
        path,
        signer: alice.signer,
        capability: didRoot(),
        action: 'read'
      })
      const baseline = await anyCall({
        path,
        signer: rogue,
        capability: rootCapabilityId(keystoreUrl),
        action: 'read'
      })
      assert.equal(refused.statusCode, 404)
      assert.equal(refused.payload, baseline.payload)
    })

    it('refuses it on List Spaces', async () => {
      const ids = (response: LightMyRequestResponse): string[] =>
        (response.json().items as Array<{ id: string }>).map(item => item.id)
      const admitted = await anyCall({
        path: '/spaces/',
        signer: owner,
        capability: rootCapabilityId(new URL('/spaces/', baseServerUrl).href)
      })
      assert.equal(admitted.statusCode, 200, admitted.payload)
      assert.ok(ids(admitted).includes(spaceId))
      const refused = await anyCall({
        path: '/spaces/',
        signer: owner,
        capability: didRoot()
      })
      assert.equal(refused.statusCode, 200, refused.payload)
      assert.deepEqual(ids(refused), [])
    })

    it('refuses it on /kms revocation submission (404)', async () => {
      const keystore = await KmsClient.createKeystore({
        url: `${baseServerUrl}kms/keystores`,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      const keystoreUrl = (keystore as any).id as string
      const grant = await delegate({
        signer: alice.signer,
        capability: rootCapabilityId(keystoreUrl),
        invocationTarget: keystoreUrl,
        controller: bob.did,
        allowedActions: ['read']
      })
      const path =
        `${new URL(keystoreUrl).pathname}/zcaps/revocations/` +
        encodeURIComponent(grant.id)
      const refused = await anyCall({
        path,
        signer: alice.signer,
        capability: didRoot(),
        method: 'POST',
        action: 'write',
        json: grant
      })
      const baseline = await anyCall({
        path,
        signer: rogue,
        capability: rootCapabilityId(keystoreUrl),
        method: 'POST',
        action: 'write',
        json: grant
      })
      assert.equal(baseline.statusCode, 404)
      assert.equal(refused.statusCode, 404, refused.payload)
      assert.equal(refused.payload, baseline.payload)
    })
  })

  describe('the revocation route under a DID URL root', () => {
    /**
     * Whether a Space holds a revocation of `revoked` by `delegator`.
     *
     * @param options {object}
     * @param options.atSpaceId {string}
     * @param options.revoked {{ id: string }}
     * @param options.delegator {string}
     * @returns {Promise<boolean>}
     */
    async function holds({
      atSpaceId,
      revoked,
      delegator
    }: {
      atSpaceId: string
      revoked: { id: string }
      delegator: string
    }): Promise<boolean> {
      return await backend.isRevoked({
        scope: { spaceId: atSpaceId },
        capabilities: [{ capabilityId: revoked.id, delegator }]
      })
    }

    /**
     * A DID URL grant from the Space controller to Bob.
     *
     * @returns {Promise<any>}
     */
    async function ownerGrant(): Promise<any> {
      return await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
    }

    it('the Space controller submits under the DID URL root', async () => {
      const grant = await ownerGrant()
      const revoked = await submitRevocation({
        revoked: grant,
        signer: owner,
        capability: didRoot()
      })
      assert.equal(revoked.statusCode, 204, revoked.payload)
      assert.equal(
        await holds({ atSpaceId: spaceId, revoked: grant, delegator: did }),
        true
      )
    })

    it('a delegated DID URL chain that reaches the revocation URL submits', async () => {
      const carol = bareDidKeyOf(await Ed25519VerificationKey.generate())
      const toCarol = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: carol.did,
        allowedActions: ['GET']
      })
      // Rooted in the Space's DID URL root, so its holder may revoke what
      // the Space's controller delegated, as under the https root.
      const revoker = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/zcaps/`,
        controller: bob.did,
        allowedActions: ['POST']
      })
      const revoked = await submitRevocation({
        revoked: toCarol,
        signer: bob.signer,
        capability: revoker
      })
      assert.equal(revoked.statusCode, 204, revoked.payload)
      assert.equal(
        await holds({ atSpaceId: spaceId, revoked: toCarol, delegator: did }),
        true
      )
    })

    it("refuses the DID URL root of one Space at another Space's revocation URL, as at an absent Space (404)", async () => {
      // The second Space shares the controller, so the submitted chain
      // verifies there; only the root's dereference refuses it.
      const grant = await ownerGrant()
      const atShared = await submitRevocation({
        revoked: grant,
        signer: owner,
        atSpaceId: sharedSpaceId,
        capability: didRoot()
      })
      const atAbsent = await submitRevocation({
        revoked: grant,
        signer: owner,
        atSpaceId: randomUUID(),
        capability: didRoot()
      })
      assert.equal(atAbsent.statusCode, 404)
      assert.equal(atShared.statusCode, 404, atShared.payload)
      assert.equal(
        atShared.headers['content-type'],
        atAbsent.headers['content-type']
      )
      assert.equal(atShared.payload, atAbsent.payload)
      assert.equal(
        await holds({
          atSpaceId: sharedSpaceId,
          revoked: grant,
          delegator: did
        }),
        false
      )
    })
  })

  describe('each link is bounded by its parent', () => {
    /**
     * Bob's grant on the `photos` Collection, and his own narrowing of it to
     * `target`.
     *
     * @param options {object}
     * @param options.target {string}   the narrowed DID URL target
     * @returns {Promise<{ grant: any, narrowed: any }>}
     */
    async function narrowedPhotosGrant({
      target
    }: {
      target: string
    }): Promise<{ grant: any; narrowed: any }> {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const narrowed = await delegate({
        signer: bob.signer,
        capability: grant,
        invocationTarget: target,
        controller: bob.did,
        allowedActions: ['GET', 'PUT'],
        expires: new Date(grant.expires)
      })
      return { grant, narrowed }
    }

    it('refuses a narrowing onto a nested handler that maps to the Space URL (404)', async () => {
      // `/photos/up` is the longest match for the narrowed path and maps to
      // the Space URL, above the `photos` Collection the grant reaches.
      const { narrowed } = await narrowedPhotosGrant({
        target: `${did}/photos/up/`
      })
      await assertBobMasked({
        path: `/space/${spaceId}/private/secret`,
        capability: narrowed
      })
      await assertBobMasked({
        path: `/space/${spaceId}/newcoll/meta`,
        capability: narrowed,
        method: 'PUT',
        json: { name: 'Created under a widened grant' }
      })
    })

    it('refuses the same narrowing onto a handler added after the grant (404)', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      await publishVersion({
        services: [
          ...currentServices({ root: spaceUrl }),
          pathHandler({
            id: '#photos-late',
            path: '/photos/late',
            serviceEndpoint: spaceUrl
          })
        ]
      })
      const narrowed = await delegate({
        signer: bob.signer,
        capability: grant,
        invocationTarget: `${did}/photos/late/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT'],
        expires: new Date(grant.expires)
      })
      // A first-link grant on the new handler's URL maps to the Space URL, so
      // it reads `private/secret`. That shows the verifier read the new log.
      const direct = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/late/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const secret = await call({
        path: `/space/${spaceId}/private/secret`,
        signer: bob.signer,
        capability: direct
      })
      assert.equal(secret.statusCode, 200, secret.payload)
      await assertBobMasked({
        path: `/space/${spaceId}/private/secret`,
        capability: narrowed
      })
      await assertBobMasked({
        path: `/space/${spaceId}/newcoll/meta`,
        capability: narrowed,
        method: 'PUT',
        json: { name: 'Created under a widened grant' }
      })
      // The grant itself still reaches what it always reached.
      const read = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(read.statusCode, 200, read.payload)
    })

    it('admits a nested handler that maps beneath the parent URL', async () => {
      // `/photos/2026` maps to `photos/doc-2`, beneath `photos/`.
      const { narrowed } = await narrowedPhotosGrant({
        target: `${did}/photos/2026`
      })
      const read = await call({
        path: `/space/${spaceId}/photos/doc-2`,
        signer: bob.signer,
        capability: narrowed
      })
      assert.equal(read.statusCode, 200, read.payload)
      assert.deepEqual(read.json(), { photo: 2 })
    })

    it('refuses a nested handler that maps to a sibling of the parent URL (404)', async () => {
      const { narrowed } = await narrowedPhotosGrant({
        target: `${did}/photos/x/`
      })
      await assertBobMasked({
        path: `/space/${spaceId}/private/secret`,
        capability: narrowed
      })
    })

    it('refuses a link that goes out of its parent and a tail that comes back in (404)', async () => {
      // `/photos/x/` maps to `private/`, outside `photos/`; the tail
      // `/photos/x/back` maps back to `photos/doc-1`.
      const { narrowed: outside } = await narrowedPhotosGrant({
        target: `${did}/photos/x/`
      })
      const tail = await delegate({
        signer: bob.signer,
        capability: outside,
        invocationTarget: `${did}/photos/x/back`,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(outside.expires)
      })
      await assertBobMasked({
        path: `/space/${spaceId}/photos/doc-1`,
        capability: tail
      })
    })

    it('refuses a narrower link under a pin whose version maps it outside the parent (404)', async () => {
      // Version 2 maps `/pics` to `photos/` and `/pics/out` to `albums/`.
      const pinned = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/pics/?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const narrowed = await delegate({
        signer: bob.signer,
        capability: pinned,
        invocationTarget: `${did}/pics/out/?versionNumber=2`,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(pinned.expires)
      })
      await assertBobMasked({
        path: `/space/${spaceId}/albums/a-1`,
        capability: narrowed
      })
    })
  })

  describe('named denial causes', () => {
    /**
     * Bob's GET grant on the `photos` Collection, in DID URL form or in https
     * form.
     *
     * @param options {object}
     * @param options.form {'did' | 'https'}
     * @returns {Promise<any>}
     */
    async function photosGrant({
      form
    }: {
      form: 'did' | 'https'
    }): Promise<any> {
      return await delegate({
        signer: owner,
        capability: form === 'did' ? didRoot() : rootCapabilityId(spaceUrl),
        invocationTarget:
          form === 'did' ? `${did}/photos/` : `${spaceUrl}photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
    }

    /**
     * Bob's GET of `photos/doc-1` in a Space, under `capability`.
     *
     * @param options {object}
     * @param options.atSpaceId {string}
     * @param options.capability {object}
     * @returns {Promise<LightMyRequestResponse>}
     */
    async function readPhoto({
      atSpaceId,
      capability
    }: {
      atSpaceId: string
      capability: object
    }): Promise<LightMyRequestResponse> {
      return await call({
        path: `/space/${atSpaceId}/photos/doc-1`,
        signer: bob.signer,
        capability
      })
    }

    it('names an expired DID URL grant only at the Space its root dereferences to', async () => {
      const didGrant = await photosGrant({ form: 'did' })
      const httpsGrant = await photosGrant({ form: 'https' })
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
        const httpsAtOwn = await readPhoto({
          atSpaceId: spaceId,
          capability: httpsGrant
        })
        assert.equal(httpsAtOwn.statusCode, 404)
        assert.equal(httpsAtOwn.json().type, ProblemTypes.CAPABILITY_EXPIRED)
        const didAtOwn = await readPhoto({
          atSpaceId: spaceId,
          capability: didGrant
        })
        assert.equal(didAtOwn.statusCode, 404)
        assert.equal(didAtOwn.json().type, ProblemTypes.CAPABILITY_EXPIRED)
        // The second Space shares the controller, so the chain verifies
        // there up to the expiry.
        const path = `/space/${sharedSpaceId}/photos/doc-1`
        await assertMasked({
          response: await readPhoto({
            atSpaceId: sharedSpaceId,
            capability: didGrant
          }),
          path
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('names a revoked DID URL grant only at the Space its root dereferences to', async () => {
      const grant = await photosGrant({ form: 'did' })
      // The Space controller revokes it in both Spaces. The root is not
      // dereferenced at submission, so the second Space accepts it too.
      for (const atSpaceId of [spaceId, sharedSpaceId]) {
        const revoked = await submitRevocation({
          revoked: grant,
          signer: owner,
          atSpaceId
        })
        assert.equal(revoked.statusCode, 204, revoked.payload)
      }
      const atOwn = await readPhoto({ atSpaceId: spaceId, capability: grant })
      assert.equal(atOwn.statusCode, 404)
      assert.equal(atOwn.json().type, ProblemTypes.CAPABILITY_REVOKED)
      const path = `/space/${sharedSpaceId}/photos/doc-1`
      await assertMasked({
        response: await readPhoto({
          atSpaceId: sharedSpaceId,
          capability: grant
        }),
        path
      })
    })
  })

  describe('revoking a DID URL grant', () => {
    it('the Space controller revokes it, and it is refused from then on', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      const before = await call({ path, signer: bob.signer, capability: grant })
      assert.equal(before.statusCode, 200, before.payload)
      const revoked = await submitRevocation({ revoked: grant, signer: owner })
      assert.equal(revoked.statusCode, 204, revoked.payload)
      // Bob holds the grant's own key, so the cause is named.
      const after = await call({ path, signer: bob.signer, capability: grant })
      assert.equal(after.statusCode, 404)
      assert.equal(after.json().type, ProblemTypes.CAPABILITY_REVOKED)
      // Anyone else presenting it gets the plain masked body.
      await assertMasked({
        response: await call({ path, signer: rogue, capability: grant }),
        path
      })
    })

    it('a delegator in the chain revokes the grant it made', async () => {
      const carol = bareDidKeyOf(await Ed25519VerificationKey.generate())
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const toCarol = await delegate({
        signer: bob.signer,
        capability: grant,
        invocationTarget: `${did}/photos/doc-1`,
        controller: carol.did,
        allowedActions: ['GET'],
        expires: new Date(grant.expires)
      })
      const path = `/space/${spaceId}/photos/doc-1`
      const before = await call({
        path,
        signer: carol.signer,
        capability: toCarol
      })
      assert.equal(before.statusCode, 200, before.payload)
      // The revocation URL's own root, controlled by every controller in the
      // revoked chain.
      const revoked = await submitRevocation({
        revoked: toCarol,
        signer: bob.signer,
        capability: rootCapabilityId(
          new URL(
            spaceRevocationsPath({
              spaceId: spaceId,
              revocationId: toCarol.id
            }),
            baseServerUrl
          ).href
        )
      })
      assert.equal(revoked.statusCode, 204, revoked.payload)
      const after = await call({
        path,
        signer: carol.signer,
        capability: toCarol
      })
      assert.equal(after.statusCode, 404)
      assert.equal(after.json().type, ProblemTypes.CAPABILITY_REVOKED)
    })

    /**
     * Bob's DID URL grant on the `photos` Collection and his sub-grant of
     * one Resource to Carol, which Bob, a party in the chain, may revoke.
     *
     * @returns {Promise<{ toCarol: any, carol: { did: string, signer: any } }>}
     */
    async function bobSubGrant(): Promise<{
      toCarol: any
      carol: { did: string; signer: any }
    }> {
      const carol = bareDidKeyOf(await Ed25519VerificationKey.generate())
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const toCarol = await delegate({
        signer: bob.signer,
        capability: grant,
        invocationTarget: `${did}/photos/doc-1`,
        controller: carol.did,
        allowedActions: ['GET'],
        expires: new Date(grant.expires)
      })
      return { toCarol, carol }
    }

    /**
     * Bob submits `revoked` at a Space id under that id's revocation URL
     * root, as a party in the revoked chain.
     *
     * @param options {object}
     * @param options.revoked {any}
     * @param options.atSpaceId {string}
     * @returns {Promise<LightMyRequestResponse>}
     */
    async function bobRevokes({
      revoked,
      atSpaceId
    }: {
      revoked: any
      atSpaceId: string
    }): Promise<LightMyRequestResponse> {
      return await submitRevocation({
        revoked,
        signer: bob.signer,
        atSpaceId,
        capability: rootCapabilityId(
          new URL(
            spaceRevocationsPath({
              spaceId: atSpaceId,
              revocationId: revoked.id
            }),
            baseServerUrl
          ).href
        )
      })
    }

    /**
     * Whether a Space holds a revocation of `revoked` by Bob.
     *
     * @param options {object}
     * @param options.atSpaceId {string}
     * @param options.revoked {{ id: string }}
     * @returns {Promise<boolean>}
     */
    async function holdsBobRevocation({
      atSpaceId,
      revoked
    }: {
      atSpaceId: string
      revoked: { id: string }
    }): Promise<boolean> {
      return await backend.isRevoked({
        scope: { spaceId: atSpaceId },
        capabilities: [{ capabilityId: revoked.id, delegator: bob.did }]
      })
    }

    it('refuses a delegate at another Space of the same controller, as at any other Space id (404)', async () => {
      const { toCarol } = await bobSubGrant()
      const sameController = await bobRevokes({
        revoked: toCarol,
        atSpaceId: sharedSpaceId
      })
      const otherController = await bobRevokes({
        revoked: toCarol,
        atSpaceId: new URL(otherSpaceUrl).pathname.split('/')[2]!
      })
      const absent = await bobRevokes({
        revoked: toCarol,
        atSpaceId: randomUUID()
      })
      for (const response of [sameController, otherController, absent]) {
        assert.equal(response.statusCode, 404, response.payload)
        assert.equal(
          response.headers['content-type'],
          absent.headers['content-type']
        )
        assert.equal(response.payload, absent.payload)
      }
      assert.equal(
        await holdsBobRevocation({
          atSpaceId: sharedSpaceId,
          revoked: toCarol
        }),
        false
      )
      // At the Space the root dereferences to, the same submission stands.
      const atOwn = await bobRevokes({ revoked: toCarol, atSpaceId: spaceId })
      assert.equal(atOwn.statusCode, 204, atOwn.payload)
      assert.equal(
        await holdsBobRevocation({ atSpaceId: spaceId, revoked: toCarol }),
        true
      )
    })

    it("the Space controller revokes under the revocation URL's own root once the DID is repointed away", async () => {
      // The controller is a party in every chain from the Space's root, so
      // the revocation URL's root admits it too. Its submission is not
      // dereferenced, whichever root it invokes.
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      await publishVersion({
        services: currentServices({ root: otherSpaceUrl })
      })
      try {
        const revoked = await submitRevocation({
          revoked: grant,
          signer: owner,
          capability: rootCapabilityId(
            new URL(
              spaceRevocationsPath({
                spaceId: spaceId,
                revocationId: grant.id
              }),
              baseServerUrl
            ).href
          )
        })
        assert.equal(revoked.statusCode, 204, revoked.payload)
      } finally {
        await publishVersion({ services: currentServices({ root: spaceUrl }) })
      }
      assert.equal(
        await backend.isRevoked({
          scope: { spaceId },
          capabilities: [{ capabilityId: grant.id, delegator: did }]
        }),
        true
      )
    })

    it('refuses a delegate once the DID is repointed away from the Space (404)', async () => {
      const { toCarol } = await bobSubGrant()
      await publishVersion({
        services: currentServices({ root: otherSpaceUrl })
      })
      try {
        await assertMasked({
          response: await bobRevokes({ revoked: toCarol, atSpaceId: spaceId }),
          path: spaceRevocationsPath({
            spaceId: spaceId,
            revocationId: toCarol.id
          }),
          method: 'POST',
          json: toCarol
        })
      } finally {
        await publishVersion({ services: currentServices({ root: spaceUrl }) })
      }
      assert.equal(
        await holdsBobRevocation({ atSpaceId: spaceId, revoked: toCarol }),
        false
      )
    })

    it('refuses a DID URL chain the Space controller did not sign, as its https twin', async () => {
      const didForm = await delegate({
        signer: rogue,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const httpsForm = await delegate({
        signer: rogue,
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: `${spaceUrl}photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const didAnswer = await submitRevocation({
        revoked: didForm,
        signer: owner
      })
      const httpsAnswer = await submitRevocation({
        revoked: httpsForm,
        signer: owner
      })
      assert.equal(httpsAnswer.statusCode, 400, httpsAnswer.payload)
      assert.equal(didAnswer.statusCode, httpsAnswer.statusCode)
      assert.equal(didAnswer.payload, httpsAnswer.payload)
    })

    it('refuses a malformed DID URL root, as an https root outside the Space', async () => {
      const httpsForm = await delegate({
        signer: owner,
        capability: rootCapabilityId(otherSpaceUrl),
        invocationTarget: `${otherSpaceUrl}photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const httpsAnswer = await submitRevocation({
        revoked: httpsForm,
        signer: owner
      })
      assert.equal(httpsAnswer.statusCode, 400, httpsAnswer.payload)
      const roots = [
        didRoot('/home'),
        didRoot('/?versionNumber=3'),
        didRoot('/#space'),
        rootCapabilityId(
          'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD/'
        )
      ]
      for (const root of roots) {
        const target =
          root === roots[3]
            ? 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD/photos/'
            : `${did}/photos/`
        const malformed = await delegate({
          signer: owner,
          capability: root,
          invocationTarget: target,
          controller: bob.did,
          allowedActions: ['GET']
        })
        const answer = await submitRevocation({
          revoked: malformed,
          signer: owner
        })
        assert.equal(answer.statusCode, httpsAnswer.statusCode, root)
        assert.equal(answer.payload, httpsAnswer.payload, root)
      }
    })

    it('masks an unauthorized submission of a DID URL chain as its https twin', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const httpsGrant = await delegate({
        signer: owner,
        capability: rootCapabilityId(spaceUrl),
        invocationTarget: `${spaceUrl}photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const baseline = await submitRevocation({
        revoked: httpsGrant,
        signer: rogue
      })
      const answer = await submitRevocation({ revoked: grant, signer: rogue })
      assert.equal(baseline.statusCode, 404)
      assert.equal(answer.statusCode, 404, answer.payload)
      assert.equal(
        answer.headers['content-type'],
        baseline.headers['content-type']
      )
      assert.equal(answer.payload, baseline.payload)
    })

    it('revokes a grant whose DID no longer dereferences to the Space', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      await publishVersion({
        services: currentServices({ root: otherSpaceUrl })
      })
      try {
        const revoked = await submitRevocation({
          revoked: grant,
          signer: owner
        })
        assert.equal(revoked.statusCode, 204, revoked.payload)
      } finally {
        await publishVersion({ services: currentServices({ root: spaceUrl }) })
      }
      // Mapped back to the Space, the grant stays revoked.
      const after = await call({
        path: `/space/${spaceId}/photos/doc-1`,
        signer: bob.signer,
        capability: grant
      })
      assert.equal(after.statusCode, 404)
      assert.equal(after.json().type, ProblemTypes.CAPABILITY_REVOKED)
    })

    describe('archived DID URL revocations', () => {
      /**
       * A Space controlled by Alice's `did:key` and a self-hosted
       * `did:webvh` whose document maps `/` to it.
       *
       * @returns {Promise<{ id: string, url: string, mapper: string }>}
       */
      async function mappedAliceSpace(): Promise<{
        id: string
        url: string
        mapper: string
      }> {
        const id = randomUUID()
        await alice.pws
          .space(id)
          .configure({ name: 'Archive Space', controller: alice.did })
        const url = absoluteSpaceUrl({ spaceId: id, serverUrl: baseServerUrl })
        const { did: mapper } = await provisionWebvhIdentity({
          owner: alice,
          baseServerUrl,
          services: [
            pathHandler({ id: '#space', path: '/', serviceEndpoint: url })
          ]
        })
        return { id, url, mapper }
      }

      /**
       * A Space whose archive holds one revoked DID URL grant, revoked by
       * Alice through the revocation route.
       *
       * @returns {Promise<{ grant: any, archive: Buffer }>}
       */
      async function revokedArchive(): Promise<{
        grant: any
        archive: Buffer
      }> {
        const source = await mappedAliceSpace()
        const grant = await delegate({
          signer: alice.signer,
          capability: rootCapabilityId(`${source.mapper}/`),
          invocationTarget: `${source.mapper}/`,
          controller: bob.did,
          allowedActions: ['GET']
        })
        const revoked = await submitRevocation({
          revoked: grant,
          signer: alice.signer,
          atSpaceId: source.id
        })
        assert.equal(revoked.statusCode, 204, revoked.payload)
        const exported = await alice.pws.request({
          url: `${source.url}export`,
          method: 'POST'
        })
        assert.equal(exported.status, 200)
        return {
          grant,
          archive: Buffer.from(await exported.arrayBuffer())
        }
      }

      /**
       * Whether a backend holds a revocation of `grant` by Alice in a Space.
       *
       * @param options {object}
       * @param options.storage {TempFileSystemBackend}
       * @param options.atSpaceId {string}
       * @param options.grant {{ id: string }}
       * @returns {Promise<boolean>}
       */
      async function holdsRevocation({
        storage,
        atSpaceId,
        grant
      }: {
        storage: TempFileSystemBackend
        atSpaceId: string
        grant: { id: string }
      }): Promise<boolean> {
        return await storage.isRevoked({
          scope: { spaceId: atSpaceId },
          capabilities: [{ capabilityId: grant.id, delegator: alice.did }]
        })
      }

      it('installs on another server, where the DID dereferences nowhere', async () => {
        const { grant, archive } = await revokedArchive()
        const secondBackend = await openTempBackend()
        const second = await startTestServer({ backend: secondBackend })
        try {
          const secondPws = pwsClient({
            signer: alice.signer,
            baseServerUrl: second.baseServerUrl
          })
          const destinationId = randomUUID()
          await secondPws
            .space(destinationId)
            .configure({ name: 'Destination', controller: alice.did })
          assert.equal(
            await holdsRevocation({
              storage: secondBackend,
              atSpaceId: destinationId,
              grant
            }),
            false
          )
          const imported = await secondPws.request({
            url: `${second.baseServerUrl}space/${destinationId}/import`,
            method: 'POST',
            body: archive,
            headers: { 'content-type': 'application/x-tar' }
          })
          assert.equal(imported.status, 200)
          assert.equal(
            await holdsRevocation({
              storage: secondBackend,
              atSpaceId: destinationId,
              grant
            }),
            true
          )
        } finally {
          await second.fastify.close()
        }
      })

      it('installs under a DID URL import grant whose target reaches the revocation URL', async () => {
        const { grant, archive } = await revokedArchive()
        const destination = await mappedAliceSpace()
        const carol = bareDidKeyOf(await Ed25519VerificationKey.generate())
        /**
         * Imports the archive under a DID URL grant to Carol on `target`.
         *
         * @param target {string}
         * @returns {Promise<void>}
         */
        async function importUnder(target: string): Promise<void> {
          const importGrant = await delegate({
            signer: alice.signer,
            capability: rootCapabilityId(`${destination.mapper}/`),
            invocationTarget: target,
            controller: carol.did,
            allowedActions: ['POST']
          })
          const imported = await signedInject({
            server,
            path: `/space/${destination.id}/import`,
            signer: carol.signer,
            method: 'POST',
            capability: importGrant,
            body: archive,
            contentType: 'application/x-tar'
          })
          assert.equal(imported.statusCode, 200, imported.payload)
        }
        // The import URL alone does not reach the revocation URL.
        await importUnder(`${destination.mapper}/import`)
        assert.equal(
          await holdsRevocation({
            storage: backend,
            atSpaceId: destination.id,
            grant
          }),
          false
        )
        // The whole Space, as the dereferenced target, does.
        await importUnder(`${destination.mapper}/`)
        assert.equal(
          await holdsRevocation({
            storage: backend,
            atSpaceId: destination.id,
            grant
          }),
          true
        )
      })
    })
  })

  describe('Update Space under a DID URL root', () => {
    it('a root invocation rewrites the Space Metadata object', async () => {
      const response = await call({
        path: `/space/${spaceId}/meta`,
        signer: owner,
        capability: didRoot(),
        method: 'PUT',
        json: { id: spaceId, name: 'Renamed Identity Space', controller: did }
      })
      assert.equal(response.statusCode, 204, response.payload)
      const read = await call({
        path: `/space/${spaceId}/meta`,
        signer: owner,
        capability: didRoot()
      })
      assert.equal(read.json().name, 'Renamed Identity Space')
    })

    it('refuses a delegated DID URL invocation (404)', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/`,
        controller: bob.did,
        allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
      })
      const json = { id: spaceId, name: 'Taken over', controller: bob.did }
      await assertBobMasked({
        path: `/space/${spaceId}/meta`,
        capability: grant,
        method: 'PUT',
        json
      })
    })

    it('refuses a DID URL root that dereferences to another Space (404)', async () => {
      const json = { id: spaceId, name: 'Elsewhere', controller: did }
      const path = `/space/${spaceId}/meta`
      await assertMasked({
        response: await call({
          path,
          signer: owner,
          capability: didRoot('/other/'),
          method: 'PUT',
          json
        }),
        path,
        method: 'PUT',
        json
      })
    })

    it('refuses a create at an absent id under a DID URL root', async () => {
      const absentId = randomUUID()
      const response = await call({
        path: `/space/${absentId}/meta`,
        signer: alice.signer,
        capability: didRoot(),
        method: 'PUT',
        json: { id: absentId, name: 'Never made', controller: alice.did }
      })
      assert.equal(response.statusCode, 404, response.payload)
      const read = await call({
        path: `/space/${absentId}/meta`,
        signer: alice.signer,
        capability: rootCapabilityId(
          absoluteSpaceUrl({ spaceId: absentId, serverUrl: baseServerUrl })
        )
      })
      assert.equal(read.statusCode, 404)
    })
  })

  describe('a repoint', () => {
    it('stops an unpinned grant from reaching the old Space', async () => {
      const grant = await delegate({
        signer: owner,
        capability: didRoot(),
        invocationTarget: `${did}/photos/`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const path = `/space/${spaceId}/photos/doc-1`
      const before = await call({ path, signer: bob.signer, capability: grant })
      assert.equal(before.statusCode, 200, before.payload)

      await publishVersion({
        services: currentServices({ root: otherSpaceUrl })
      })

      await assertMasked({
        response: await call({ path, signer: bob.signer, capability: grant }),
        path
      })
    })
  })
})
