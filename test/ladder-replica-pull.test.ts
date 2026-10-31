/**
 * The two replica shapes of the client-annex clause (Vitest). On the source
 * server, a ladder-signed pull capability is admitted only while the
 * client-annex document names the replica server through a `ReplicaServer`
 * pointer. On the replica server, a ladder-signed maintenance grant on a
 * promoted replica Space's replicas URL is admitted with no pointer, and the
 * route bounds a delegated create to a source the Space already registers.
 *
 * Two servers are booted in one process and never listen, as in
 * `replicated-webvh-controller.test.ts`. `https://origin.example` hosts a
 * credential-anchored account whose document lists a ladder method
 * (`capabilityDelegation` with no `capabilityInvocation`) and names its
 * client-annex DID; the annex document points at the server identity of
 * `https://mirror.example`. The mirror registers the account Space and the
 * annex Space under pull capabilities the ladder method signs, and pulls.
 *
 * The shape refusals are direct invocations on the origin, signed by the
 * mirror's own sync key under a ladder-signed grant, so each case is decided
 * by the origin's clause and not by the mirror's registration checks, which
 * refuse most of these shapes on their own before the origin is read.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import {
  createDID,
  logToJsonlString,
  updateDID
} from '@interop/did-method-webvh'
import type { DIDLog, ServiceEndpoint, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import jsigs from '@interop/jsonld-signatures'
import {
  CapabilityDelegation,
  constants as zcapConstants,
  documentLoader
} from '@interop/zcap'
import { ProblemTypes } from '@interop/storage-core'

import type { PeerServer } from '../src/testing.js'
import { rootCapabilityId } from '../src/zcap.js'
import {
  anHourFromNow,
  bareDidKeyOf,
  bindKey,
  createPeerSpace,
  delegate,
  pullOnce,
  webvhLogSigner,
  zcapClients
} from './helpers.js'
import { bootPeerServer, mintServerDid, signedInject } from '../src/testing.js'

/**
 * The service-entry type IRI naming an account's current annex DID.
 */
const DELEGATED_CLIENTS_SERVICE_TYPE = 'https://w3id.org/byoe#DelegatedClients'

/**
 * The service-entry type IRI of a replica pointer in the annex document.
 */
const REPLICA_SERVER_SERVICE_TYPE = 'https://w3id.org/pws#ReplicaServer'

/**
 * The type of a client-annex auxiliary Space.
 */
const auxiliaryType = ['AuxiliarySpace', 'DelegatedClientsSpace', 'Space']

/**
 * The relations of an enrolled client's method, and of a ladder method.
 */
const CLIENT_RELATIONS = [
  'authentication',
  'assertionMethod',
  'capabilityInvocation',
  'capabilityDelegation'
]
const LADDER_RELATIONS = ['assertionMethod', 'capabilityDelegation']

/**
 * A `did:webvh` minted on the origin, with the keys its document lists.
 */
interface Identity {
  did: string
  log: DIDLog
  logSigner: Signer
  client: Ed25519VerificationKey
  ladder: Ed25519VerificationKey
}

/**
 * A credential-anchored account on the origin: the Space carrying its log,
 * the auxiliary Space carrying its annex log, both promoted to the account
 * DID.
 */
interface Account {
  name: string
  account: Identity
  annex: Identity
  spaceUrl: string
  annexSpaceUrl: string
}

/**
 * A bootstrap `did:key`: the controller of a replica Space on the mirror,
 * or Alice's.
 */
type DidKey = ReturnType<typeof bareDidKeyOf>

const servers = new Map<string, PeerServer>()

/**
 * A verification method entry in the shape `createDID` and `updateDID` take.
 * @param keyPair {Ed25519VerificationKey}
 * @param purpose {string[]}
 * @returns {object}
 */
function method(keyPair: Ed25519VerificationKey, purpose: string[]) {
  return {
    type: 'Multikey',
    publicKeyMultibase: keyPair.publicKeyMultibase!,
    purpose
  }
}

/**
 * The account document's service entry naming its annex DID.
 * @param annexDid {string}
 * @returns {ServiceEndpoint}
 */
function delegatedClients(annexDid: string): ServiceEndpoint {
  return {
    id: '#delegated-clients',
    type: DELEGATED_CLIENTS_SERVICE_TYPE,
    serviceEndpoint: annexDid
  }
}

/**
 * The annex document's replica pointers, one per replica server. The server
 * dispatches on `type` alone, so the ids here are plain ordinals.
 * @param dids {string[]}   the replica servers' DIDs
 * @returns {ServiceEndpoint[]}
 */
function replicaPointers(dids: string[]): ServiceEndpoint[] {
  return dids.map((did, index) => ({
    id: `#replica-${index + 1}`,
    type: REPLICA_SERVER_SERVICE_TYPE,
    serviceEndpoint: did
  }))
}

/**
 * Signs a delegation from `parent` with no check on the shape of
 * `controller`, so a two-controller grant can be minted; `@interop/ezcap`
 * refuses anything but one DID string there.
 * @param options {object}
 * @param options.signer {object}   the delegating key's signer
 * @param options.parent {string | object}   the parent capability: a root
 *   id, or a delegated capability
 * @param options.controller {string | string[]}
 * @param options.invocationTarget {string}
 * @param options.allowedActions {string[]}
 * @returns {Promise<object>}   the signed capability
 */
async function signDelegation({
  signer,
  parent,
  controller,
  invocationTarget,
  allowedActions
}: {
  signer: any
  parent: string | { id: string }
  controller: string | string[]
  invocationTarget: string
  allowedActions: string[]
}): Promise<object> {
  const capability = {
    '@context': zcapConstants.ZCAP_CONTEXT_URL,
    id: `urn:uuid:${randomUUID()}`,
    controller,
    parentCapability: typeof parent === 'string' ? parent : parent.id,
    invocationTarget,
    allowedAction: allowedActions,
    expires: `${anHourFromNow().toISOString().slice(0, -5)}Z`
  }
  return jsigs.sign(capability, {
    documentLoader,
    suite: new EddsaJcs2022({ signer }),
    purpose: new CapabilityDelegation({ parentCapability: parent as any })
  })
}

describe('the client-annex clause admits a ladder-signed replica pull under a pointer', () => {
  let origin: PeerServer, mirror: PeerServer
  /**
   * The mirror's sync key, bound to its DID, so a test can invoke as the
   * mirror does when it pulls.
   */
  let mirrorKey: Ed25519VerificationKey
  let alice: DidKey
  /**
   * The server identity of a third server, which the mirror is not.
   */
  let otherServerDid: string

  /**
   * Sends one signed request. `capability` defaults to the root capability
   * of the Space the path is under.
   */
  async function call({
    signer = alice.signer,
    ...request
  }: Omit<Parameters<typeof signedInject>[0], 'signer'> & { signer?: any }) {
    return signedInject({ signer, ...request })
  }

  /**
   * Creates a Space under Alice's `did:key` on the origin, with an `id`
   * Collection for a history log.
   */
  async function createSpaceWithIdCollection({
    spaceId,
    type
  }: {
    spaceId: string
    type?: string[]
  }): Promise<void> {
    await createPeerSpace({
      server: origin,
      spaceId,
      controller: alice.did,
      type
    })
    await createCollection({ server: origin, spaceId, collectionId: 'id' })
  }

  /**
   * Creates a Collection under the Space's root capability.
   */
  async function createCollection({
    server,
    spaceId,
    collectionId,
    signer
  }: {
    server: PeerServer
    spaceId: string
    collectionId: string
    signer?: any
  }): Promise<void> {
    const created = await call({
      server,
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId },
      signer
    })
    assert.equal(created.statusCode, 201, created.payload)
  }

  /**
   * Writes a history log on the origin under the Space's root capability.
   */
  async function putLog({
    spaceId,
    collectionId,
    log,
    signer
  }: {
    spaceId: string
    collectionId: string
    log: DIDLog
    signer?: any
  }) {
    return call({
      server: origin,
      path: `/space/${spaceId}/${collectionId}/did.jsonl`,
      method: 'PUT',
      body: new TextEncoder().encode(logToJsonlString(log)),
      contentType: 'text/jsonl',
      signer
    })
  }

  /**
   * Mints a `did:webvh` whose log lives at `<spaceId>/<collectionId>` on the
   * origin, and publishes the log there. The document lists one enrolled
   * client key, a ladder key when asked, and `services`.
   */
  async function mintOnOrigin({
    spaceId,
    collectionId = 'id',
    withLadder = false,
    services,
    signer
  }: {
    spaceId: string
    collectionId?: string
    withLadder?: boolean
    services?: ServiceEndpoint[]
    signer?: any
  }): Promise<Identity> {
    const updateKey = await Ed25519VerificationKey.generate()
    const logSigner = webvhLogSigner({ keyPair: updateKey })
    const client = await Ed25519VerificationKey.generate()
    const ladder = await Ed25519VerificationKey.generate()
    const { did, log } = await createDID({
      address: `${origin.serverUrl}/space/${spaceId}/${collectionId}`,
      signer: logSigner,
      updateKeys: [updateKey.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [
        method(client, CLIENT_RELATIONS),
        ...(withLadder ? [method(ladder, LADDER_RELATIONS)] : [])
      ] as any,
      ...(services !== undefined && { services })
    })
    const published = await putLog({ spaceId, collectionId, log, signer })
    assert.equal(published.statusCode, 201, published.payload)
    return {
      did,
      log,
      logSigner,
      client: bindKey(client, did),
      ladder: bindKey(ladder, did)
    }
  }

  /**
   * Update Space on the origin, naming `controller`, under Alice's key.
   */
  async function promote(spaceId: string, controller: string) {
    const promoted = await call({
      server: origin,
      path: `/space/${spaceId}/meta`,
      method: 'PUT',
      json: { name: spaceId, controller }
    })
    assert.equal(promoted.statusCode, 204, promoted.payload)
  }

  /**
   * Provisions one credential-anchored account on the origin. Its annex
   * document carries one replica pointer per DID in `pointers`, and its
   * annex Space is typed `annexType`, a client-annex auxiliary Space unless
   * a test says otherwise.
   */
  async function provisionAccount({
    name,
    pointers,
    annexType = auxiliaryType
  }: {
    name: string
    pointers: string[]
    annexType?: string[]
  }): Promise<Account> {
    const annexSpaceId = `${name}-annex`
    await createSpaceWithIdCollection({ spaceId: name })
    await createSpaceWithIdCollection({
      spaceId: annexSpaceId,
      type: annexType
    })
    // The annex is minted first: the account document names its DID.
    const annex = await mintOnOrigin({
      spaceId: annexSpaceId,
      services: replicaPointers(pointers)
    })
    const account = await mintOnOrigin({
      spaceId: name,
      withLadder: true,
      services: [delegatedClients(annex.did)]
    })
    await promote(name, account.did)
    await promote(annexSpaceId, account.did)
    return {
      name,
      account,
      annex,
      spaceUrl: `${origin.serverUrl}/space/${name}/`,
      annexSpaceUrl: `${origin.serverUrl}/space/${annexSpaceId}/`
    }
  }

  /**
   * Mints a second annex generation for `acct` with no replica pointer, in a
   * `gen2` Collection of its annex Space, and re-points the account document
   * at it, under the account's own client key.
   */
  async function repointToUnpointedAnnexGeneration(acct: Account) {
    const annexSpaceId = `${acct.name}-annex`
    const signer = acct.account.client.signer()
    await createCollection({
      server: origin,
      spaceId: annexSpaceId,
      collectionId: 'gen2',
      signer
    })
    const gen2 = await mintOnOrigin({
      spaceId: annexSpaceId,
      collectionId: 'gen2',
      signer
    })
    const repointed = await updateDID({
      log: acct.account.log,
      signer: acct.account.logSigner,
      vmIdFragment: 'multibase',
      verificationMethods: [
        method(acct.account.client, CLIENT_RELATIONS),
        method(acct.account.ladder, LADDER_RELATIONS)
      ] as any,
      services: [delegatedClients(gen2.did)]
    })
    const published = await putLog({
      spaceId: acct.name,
      collectionId: 'id',
      log: repointed.log,
      signer
    })
    assert.equal(published.statusCode, 200, published.payload)
  }

  /**
   * A ladder-signed grant to the mirror from a Space's root, the account
   * Space's unless `spaceUrl` names another, with the pull shape unless an
   * option says otherwise.
   */
  async function ladderGrant({
    acct,
    spaceUrl = acct.spaceUrl,
    invocationTarget = spaceUrl,
    allowedActions = ['GET'],
    controller = mirror.did,
    parent = rootCapabilityId(spaceUrl)
  }: {
    acct: Account
    spaceUrl?: string
    invocationTarget?: string
    allowedActions?: string[]
    controller?: string | string[]
    parent?: string | { id: string }
  }) {
    return signDelegation({
      signer: acct.account.ladder.signer(),
      parent,
      controller,
      invocationTarget,
      allowedActions
    })
  }

  /**
   * Sends Register Replica on the mirror for the origin's Space at
   * `fromSpace`, as a source of the mirror's Space `toSpaceId`, under the
   * pull capability `delegator` signs to the mirror's DID. `signer` is the
   * local Space's bootstrap `did:key`.
   */
  async function postRegistration({
    toSpaceId,
    fromSpace,
    delegator,
    signer
  }: {
    toSpaceId: string
    fromSpace: string
    delegator: any
    signer: any
  }) {
    const capability = await delegate({
      signer: delegator,
      capability: rootCapabilityId(fromSpace),
      invocationTarget: fromSpace,
      controller: mirror.did,
      allowedActions: ['GET']
    })
    return call({
      server: mirror,
      path: `/space/${toSpaceId}/replicas`,
      method: 'POST',
      json: {
        id: 'origin',
        fromSpace,
        toSpace: `${mirror.serverUrl}/space/${toSpaceId}/`,
        capability,
        role: 'source'
      },
      signer
    })
  }

  /**
   * The status of the mirror's registration `origin` on Space `spaceId`.
   */
  async function statusOf({
    spaceId,
    signer
  }: {
    spaceId: string
    signer: any
  }) {
    const response = await call({
      server: mirror,
      path: `/space/${spaceId}/replicas/origin/status`,
      signer
    })
    assert.equal(response.statusCode, 200, response.payload)
    return response.json()
  }

  /**
   * Runs one pull cycle of the mirror's registration `origin` on `spaceId`.
   */
  async function pull(spaceId: string) {
    await pullOnce({ server: mirror, spaceId, replicaId: 'origin' })
  }

  /**
   * Invokes `capability` on the origin as the mirror's server identity, the
   * way its pull loop does.
   */
  async function invokeAsMirror({
    path,
    capability,
    method: verb = 'GET'
  }: {
    path: string
    capability: any
    method?: string
  }) {
    return call({
      server: origin,
      path,
      method: verb,
      capability,
      signer: mirrorKey.signer()
    })
  }

  beforeAll(async () => {
    ;({ alice } = await zcapClients({
      baseServerUrl: 'https://unused.example'
    }))
    origin = await bootPeerServer({
      serverUrl: 'https://origin.example',
      servers,
      prefix: 'was-ladder-pull-'
    })
    mirror = await bootPeerServer({
      serverUrl: 'https://mirror.example',
      servers,
      prefix: 'was-ladder-pull-'
    })
    mirrorKey = bindKey(mirror.signingKey.keyPair, mirror.did)
    const otherKey = await Ed25519VerificationKey.generate()
    ;({ did: otherServerDid } = await mintServerDid({
      serverUrl: 'https://other.example',
      publicKeyMultibase: otherKey.publicKeyMultibase!,
      purpose: ['assertionMethod', 'capabilityInvocation']
    }))
    assert.match(
      otherServerDid,
      /^did:webvh:[^:]+:other\.example:space:server:id$/
    )
  })

  afterAll(async () => {
    await origin?.fastify.close()
    await mirror?.fastify.close()
  })

  describe('an account whose annex document points at the mirror', () => {
    let acct: Account
    /**
     * The bootstrap `did:key` of each replica Space on the mirror, listed in
     * no document.
     */
    let accountBootstrap: DidKey
    let annexBootstrap: DidKey

    beforeAll(async () => {
      acct = await provisionAccount({ name: 'acct', pointers: [mirror.did] })
      accountBootstrap = bareDidKeyOf(await Ed25519VerificationKey.generate())
      annexBootstrap = bareDidKeyOf(await Ed25519VerificationKey.generate())
      await createPeerSpace({
        server: mirror,
        spaceId: 'acct-copy',
        controller: accountBootstrap.did
      })
      await createPeerSpace({
        server: mirror,
        spaceId: 'acct-annex-copy',
        controller: annexBootstrap.did,
        type: auxiliaryType
      })
    })

    /**
     * Registers the origin's Space at `fromSpace` as the source of the
     * mirror's `toSpaceId` under a ladder-signed pull grant, pulls once, and
     * asserts the history log the mirror now holds is `expectedLog`.
     */
    async function registerPullAndReadLog({
      toSpaceId,
      fromSpace,
      bootstrap,
      expectedLog
    }: {
      toSpaceId: string
      fromSpace: string
      bootstrap: DidKey
      expectedLog: DIDLog
    }) {
      const created = await postRegistration({
        toSpaceId,
        fromSpace,
        delegator: acct.account.ladder.signer(),
        signer: bootstrap.signer
      })
      assert.equal(created.statusCode, 201, created.payload)
      await pull(toSpaceId)
      const copy = await call({
        server: mirror,
        path: `/space/${toSpaceId}/id/did.jsonl`,
        signer: bootstrap.signer
      })
      assert.equal(copy.statusCode, 200, copy.payload)
      assert.equal(copy.payload, logToJsonlString(expectedLog))
    }

    it('admits the ladder-signed pull of the account Space, and the mirror pulls it', async () => {
      await registerPullAndReadLog({
        toSpaceId: 'acct-copy',
        fromSpace: acct.spaceUrl,
        bootstrap: accountBootstrap,
        expectedLog: acct.account.log
      })
    })

    it('admits the ladder-signed pull of the auxiliary Space', async () => {
      await registerPullAndReadLog({
        toSpaceId: 'acct-annex-copy',
        fromSpace: acct.annexSpaceUrl,
        bootstrap: annexBootstrap,
        expectedLog: acct.annex.log
      })
    })

    describe('the shape, invoked on the origin as the mirror', () => {
      it('admits the one-link GET grant on the Space URL (200)', async () => {
        const listed = await invokeAsMirror({
          path: '/space/acct/',
          capability: await ladderGrant({ acct })
        })
        assert.equal(listed.statusCode, 200, listed.payload)
      })

      it('admits the {GET, HEAD} set, and reaches the changes feed under it (200)', async () => {
        const capability = await ladderGrant({
          acct,
          allowedActions: ['GET', 'HEAD']
        })
        const feed = await invokeAsMirror({
          path: '/space/acct/id/query?profile=changes',
          capability
        })
        assert.equal(feed.statusCode, 200, feed.payload)
      })

      it('refuses a set carrying POST (404)', async () => {
        const refused = await invokeAsMirror({
          path: '/space/acct/',
          capability: await ladderGrant({
            acct,
            allowedActions: ['GET', 'POST']
          })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it('refuses a target below the Space URL (404)', async () => {
        // A Collection container: no predicate admits it. A GET of one
        // Resource would be admitted to any grantee as a target-exact read.
        const refused = await invokeAsMirror({
          path: '/space/acct/id/',
          capability: await ladderGrant({
            acct,
            invocationTarget: `${acct.spaceUrl}id/`
          })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it('refuses a parent other than the Space root (404)', async () => {
        // The enrolled client grants the account a read of its own Space;
        // the ladder then hangs the pull off that grant instead of the root.
        const management = await delegate({
          signer: acct.account.client.signer(),
          capability: rootCapabilityId(acct.spaceUrl),
          invocationTarget: acct.spaceUrl,
          controller: acct.account.did,
          allowedActions: ['GET']
        })
        const refused = await invokeAsMirror({
          path: '/space/acct/',
          capability: await ladderGrant({ acct, parent: management })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it('refuses two controllers, the mirror among them (404)', async () => {
        const refused = await invokeAsMirror({
          path: '/space/acct/',
          capability: await ladderGrant({
            acct,
            controller: [mirror.did, otherServerDid]
          })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })
    })

    describe('a re-point to an annex generation with no pointer', () => {
      beforeAll(async () => {
        // The next generation's log lands in another Collection of the
        // auxiliary Space, under the account's own client key.
        await repointToUnpointedAnnexGeneration(acct)
      })

      it('refuses the next pull of the account Space, so the mirror backs off', async () => {
        await pull('acct-copy')
        const status = await statusOf({
          spaceId: 'acct-copy',
          signer: accountBootstrap.signer
        })
        assert.equal(status.state, 'backing-off')
      })

      it('still admits the pull of the auxiliary Space, through the bookkeeping-Space shape', async () => {
        // Expected for now. The clause's predicates are alternatives, and
        // its second predicate's second branch admits a GET of a whole
        // delegated-clients Space to any grantee, with no pointer check. Once
        // that branch gains a grantee bound, this pull is refused too.
        const before = await statusOf({
          spaceId: 'acct-annex-copy',
          signer: annexBootstrap.signer
        })
        await pull('acct-annex-copy')
        const status = await statusOf({
          spaceId: 'acct-annex-copy',
          signer: annexBootstrap.signer
        })
        assert.equal(status.state, 'idle')
        assert.ok(
          Date.parse(status.lastSuccessAt) >= Date.parse(before.lastSuccessAt)
        )
      })
    })
  })

  describe('an account whose annex log sits in a Space not typed as bookkeeping', () => {
    // The bookkeeping-Space shape declines a Space typed `Space` alone, so
    // what admits the pull of this annex Space is the pointer shape's
    // annex-Space arm, and nothing else.
    let acct: Account

    beforeAll(async () => {
      acct = await provisionAccount({
        name: 'plain',
        pointers: [mirror.did],
        annexType: ['Space']
      })
    })

    it('admits the GET grant on the annex Space URL under the pointer (200)', async () => {
      const listed = await invokeAsMirror({
        path: '/space/plain-annex/',
        capability: await ladderGrant({ acct, spaceUrl: acct.annexSpaceUrl })
      })
      assert.equal(listed.statusCode, 200, listed.payload)
    })

    it('refuses a set carrying POST, which the bookkeeping-Space shape would admit (404)', async () => {
      const refused = await invokeAsMirror({
        path: '/space/plain-annex/',
        capability: await ladderGrant({
          acct,
          spaceUrl: acct.annexSpaceUrl,
          allowedActions: ['GET', 'POST']
        })
      })
      assert.equal(refused.statusCode, 404, refused.payload)
    })
  })

  describe('an account whose annex document carries no pointer at the mirror', () => {
    /**
     * Registers an account Space on the mirror under a fresh bootstrap key,
     * and returns the response.
     */
    async function registerAccountSpace(acct: Account) {
      const bootstrap = bareDidKeyOf(await Ed25519VerificationKey.generate())
      await createPeerSpace({
        server: mirror,
        spaceId: `${acct.name}-copy`,
        controller: bootstrap.did
      })
      return postRegistration({
        toSpaceId: `${acct.name}-copy`,
        fromSpace: acct.spaceUrl,
        delegator: acct.account.ladder.signer(),
        signer: bootstrap.signer
      })
    }

    /**
     * Asserts a registration was refused at the mirror's read of the source
     * Space, which the origin's clause refused.
     */
    function assertRefusedAtSource(
      response: Awaited<ReturnType<typeof postRegistration>>
    ) {
      assert.equal(response.statusCode, 409, response.payload)
      assert.equal(response.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(response.json().errors[0].detail, /could not be read/)
    }

    it('refuses the pull when the pointer is absent', async () => {
      const acct = await provisionAccount({ name: 'unpointed', pointers: [] })
      assertRefusedAtSource(await registerAccountSpace(acct))
    })

    it('refuses the pull when the pointer names another server', async () => {
      const acct = await provisionAccount({
        name: 'elsewhere',
        pointers: [otherServerDid]
      })
      assertRefusedAtSource(await registerAccountSpace(acct))
    })

    it('refuses the pull when the pointer sits only in a superseded generation', async () => {
      // The first annex generation carries the pointer, and the account
      // document names a second generation that does not restate it.
      const acct = await provisionAccount({
        name: 'swapped',
        pointers: [mirror.did]
      })
      await repointToUnpointedAnnexGeneration(acct)
      assertRefusedAtSource(await registerAccountSpace(acct))
    })
  })

  describe('a ladder-signed maintenance grant on a promoted replica Space', () => {
    // The mirror holds a copy of the account Space, promoted to the account
    // DID, which resolves there through the registration's mapping. The
    // account holds no key that can root-invoke on the mirror, so a session
    // maintains the registrations under a grant the ladder signs to the
    // session's bare did:key, on the Space's replicas URL.
    const spaceId = 'maint-copy'
    let spaceUrl: string
    let acct: Account
    let session: DidKey
    let grant: object
    /**
     * A second Space on the origin under the account DID: a source the
     * controller may add and a delegated grant may not.
     */
    let extraSpaceUrl: string

    /**
     * Sends one request on the mirror as the session, under the grant.
     */
    async function asSession({
      path,
      method: verb = 'GET',
      json,
      capability = grant
    }: {
      path: string
      method?: string
      json?: object
      capability?: object
    }) {
      return call({
        server: mirror,
        path,
        method: verb,
        json,
        capability,
        signer: session.signer
      })
    }

    /**
     * A registration body naming `fromSpace` as a source of the mirror's
     * Space, under a pull capability `delegator` signs to the mirror.
     */
    async function registration({
      id,
      fromSpace,
      delegator
    }: {
      id: string
      fromSpace: string
      delegator: any
    }) {
      return {
        id,
        fromSpace,
        toSpace: spaceUrl,
        capability: await delegate({
          signer: delegator,
          capability: rootCapabilityId(fromSpace),
          invocationTarget: fromSpace,
          controller: mirror.did,
          allowedActions: ['GET']
        }),
        role: 'source'
      }
    }

    /**
     * A ladder-signed grant to the session from the mirror Space's root, on
     * the replicas URL with every verb unless an option says otherwise.
     */
    async function maintenanceGrant({
      invocationTarget = `${spaceUrl}replicas`,
      allowedActions = ['GET', 'POST', 'PUT', 'DELETE'],
      parent = rootCapabilityId(spaceUrl)
    }: {
      invocationTarget?: string
      allowedActions?: string[]
      parent?: string | { id: string }
    } = {}) {
      return signDelegation({
        signer: acct.account.ladder.signer(),
        parent,
        controller: session.did,
        invocationTarget,
        allowedActions
      })
    }

    beforeAll(async () => {
      spaceUrl = `${mirror.serverUrl}/space/${spaceId}/`
      acct = await provisionAccount({ name: 'maint', pointers: [mirror.did] })
      const bootstrap = bareDidKeyOf(await Ed25519VerificationKey.generate())
      await createPeerSpace({
        server: mirror,
        spaceId,
        controller: bootstrap.did
      })
      const registered = await postRegistration({
        toSpaceId: spaceId,
        fromSpace: acct.spaceUrl,
        delegator: acct.account.ladder.signer(),
        signer: bootstrap.signer
      })
      assert.equal(registered.statusCode, 201, registered.payload)
      await pull(spaceId)
      const promoted = await call({
        server: mirror,
        path: `/space/${spaceId}/meta`,
        method: 'PUT',
        json: { name: spaceId, controller: acct.account.did },
        signer: bootstrap.signer
      })
      assert.equal(promoted.statusCode, 204, promoted.payload)

      await createPeerSpace({
        server: origin,
        spaceId: 'maint-extra',
        controller: alice.did
      })
      await promote('maint-extra', acct.account.did)
      extraSpaceUrl = `${origin.serverUrl}/space/maint-extra/`

      session = bareDidKeyOf(await Ed25519VerificationKey.generate())
      grant = await maintenanceGrant()
    })

    it('lists the registrations, and reads one and its status (200)', async () => {
      const listed = await asSession({ path: `/space/${spaceId}/replicas` })
      assert.equal(listed.statusCode, 200, listed.payload)
      assert.equal(listed.json().totalItems, 1)
      const read = await asSession({
        path: `/space/${spaceId}/replicas/origin`
      })
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(read.json().fromSpace, acct.spaceUrl)
      const status = await asSession({
        path: `/space/${spaceId}/replicas/origin/status`
      })
      assert.equal(status.statusCode, 200, status.payload)
      assert.equal(status.json().state, 'idle')
    })

    it('re-registers the source the Space already has (201)', async () => {
      const again = await asSession({
        path: `/space/${spaceId}/replicas`,
        method: 'POST',
        json: await registration({
          id: 'origin-again',
          fromSpace: acct.spaceUrl,
          delegator: acct.account.ladder.signer()
        })
      })
      assert.equal(again.statusCode, 201, again.payload)
    })

    it('refuses a create naming a source the Space does not register (409), by POST and by PUT', async () => {
      // The pull capability is signed by an enrolled client key, so nothing
      // but the route's bound stands between this body and a registration.
      const body = await registration({
        id: 'extra',
        fromSpace: extraSpaceUrl,
        delegator: acct.account.client.signer()
      })
      for (const [verb, path] of [
        ['POST', `/space/${spaceId}/replicas`],
        ['PUT', `/space/${spaceId}/replicas/extra`]
      ] as const) {
        const refused = await asSession({ path, method: verb, json: body })
        assert.equal(refused.statusCode, 409, `${verb}: ${refused.payload}`)
        assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
        assert.equal(refused.json().errors[0].pointer, '#/fromSpace')
      }
      const listed = await asSession({ path: `/space/${spaceId}/replicas` })
      assert.equal(listed.json().totalItems, 2)
    })

    it("admits that source under the controller's root invocation, after which the grant maintains it", async () => {
      // The account's enrolled client key root-invokes on the mirror, where
      // the account DID resolves from the copy the registration maps.
      const body = await registration({
        id: 'extra',
        fromSpace: extraSpaceUrl,
        delegator: acct.account.client.signer()
      })
      const created = await call({
        server: mirror,
        path: `/space/${spaceId}/replicas`,
        method: 'POST',
        json: body,
        signer: acct.account.client.signer()
      })
      assert.equal(created.statusCode, 201, created.payload)
      const paused = await asSession({
        path: `/space/${spaceId}/replicas/extra`,
        method: 'PUT',
        json: { ...created.json(), pausedAt: 'now' }
      })
      assert.equal(paused.statusCode, 204, paused.payload)
    })

    it('pauses a registration the Space can spare through PUT (204), and its status reads paused', async () => {
      const read = await asSession({
        path: `/space/${spaceId}/replicas/origin-again`
      })
      const paused = await asSession({
        path: `/space/${spaceId}/replicas/origin-again`,
        method: 'PUT',
        json: { ...read.json(), pausedAt: 'now' }
      })
      assert.equal(paused.statusCode, 204, paused.payload)
      const status = await asSession({
        path: `/space/${spaceId}/replicas/origin-again/status`
      })
      assert.equal(status.json().state, 'paused')
    })

    it('removes a registration the Space can spare (204)', async () => {
      for (const replicaId of ['origin-again', 'extra']) {
        const removed = await asSession({
          path: `/space/${spaceId}/replicas/${replicaId}`,
          method: 'DELETE'
        })
        assert.equal(removed.statusCode, 204, removed.payload)
      }
    })

    it("keeps the registration that maps the Space's controller (409)", async () => {
      const refused = await asSession({
        path: `/space/${spaceId}/replicas/origin`,
        method: 'DELETE'
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      const listed = await asSession({ path: `/space/${spaceId}/replicas` })
      assert.equal(listed.json().totalItems, 1)
    })

    it("refuses to pause the registration that maps the Space's controller (409), and resumes it", async () => {
      // Once `origin` is the one registration mapping the controller, a
      // paused copy of its log would keep a withdrawn key current here. The
      // controller's own key may pause it; the grant may not.
      const read = await asSession({
        path: `/space/${spaceId}/replicas/origin`
      })
      const refused = await asSession({
        path: `/space/${spaceId}/replicas/origin`,
        method: 'PUT',
        json: { ...read.json(), pausedAt: 'now' }
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.equal(refused.json().errors[0].pointer, '#/pausedAt')
      const byController = await call({
        server: mirror,
        path: `/space/${spaceId}/replicas/origin`,
        method: 'PUT',
        json: { ...read.json(), pausedAt: 'now' },
        signer: acct.account.client.signer()
      })
      assert.equal(byController.statusCode, 204, byController.payload)
      const resumed = await asSession({
        path: `/space/${spaceId}/replicas/origin`,
        method: 'PUT',
        json: read.json()
      })
      assert.equal(resumed.statusCode, 204, resumed.payload)
      const status = await asSession({
        path: `/space/${spaceId}/replicas/origin/status`
      })
      assert.notEqual(status.json().state, 'paused')
    })

    describe('the shape', () => {
      it('refuses a target beneath the replicas URL (404)', async () => {
        const refused = await asSession({
          path: `/space/${spaceId}/replicas/origin`,
          capability: await maintenanceGrant({
            invocationTarget: `${spaceUrl}replicas/origin`
          })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it('refuses the whole-Space target (404)', async () => {
        const refused = await asSession({
          path: `/space/${spaceId}/replicas`,
          capability: await maintenanceGrant({ invocationTarget: spaceUrl })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it('admits HEAD, which every GET route answers (200)', async () => {
        const read = await asSession({
          path: `/space/${spaceId}/replicas`,
          method: 'HEAD',
          capability: await maintenanceGrant({
            allowedActions: ['GET', 'HEAD']
          })
        })
        assert.equal(read.statusCode, 200, read.payload)
      })

      it('refuses a set carrying a verb the routes do not serve (404)', async () => {
        const refused = await asSession({
          path: `/space/${spaceId}/replicas`,
          capability: await maintenanceGrant({
            allowedActions: ['GET', 'PATCH']
          })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it("refuses the shape where the account's log is self-hosted (404)", async () => {
        // On the origin the account Space holds the log of record, so the
        // shape would hand the session that Space's registrations with no
        // record anywhere. The same grant, on the mirror, is admitted.
        const refused = await call({
          server: origin,
          path: `/space/${acct.name}/replicas`,
          capability: await signDelegation({
            signer: acct.account.ladder.signer(),
            parent: rootCapabilityId(acct.spaceUrl),
            controller: session.did,
            invocationTarget: `${acct.spaceUrl}replicas`,
            allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
          }),
          signer: session.signer
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })

      it('refuses a parent other than the Space root (404)', async () => {
        const management = await delegate({
          signer: acct.account.client.signer(),
          capability: rootCapabilityId(spaceUrl),
          invocationTarget: spaceUrl,
          controller: acct.account.did,
          allowedActions: ['GET', 'POST', 'PUT', 'DELETE']
        })
        const refused = await asSession({
          path: `/space/${spaceId}/replicas`,
          capability: await maintenanceGrant({ parent: management })
        })
        assert.equal(refused.statusCode, 404, refused.payload)
      })
    })
  })
})
