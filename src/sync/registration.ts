/**
 * The checks a replica registration passes before it is stored. The body
 * checks need nothing but the body and this server's URL, and a break of one
 * is `invalid-request-body` (400). The peer checks read the peer, and a break
 * of one is `replica-refused` (409): the registration is well formed, and the
 * state of the peer or of this server refuses it.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { ISigner } from '@interop/data-integrity-core'
import type { DIDDoc } from '@interop/did-method-webvh'

import {
  REPLICATION_IDENTIFIER,
  REPLICATION_VERSION,
  SPEC_IDENTIFIER,
  ENCRYPTED_COLLECTIONS_IDENTIFIER
} from '../config.default.js'
import {
  InvalidRequestBodyError,
  PeerRequestError,
  ReplicaRefusedError
} from '../errors.js'
import { actionsWithin } from '../lib/chainCapability.js'
import { generationOfEtag } from '../lib/etag.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import { mapInBatches } from '../lib/mapInBatches.js'
import { cursorOfNextUrl } from '../lib/pagination.js'
import { mergeAppliedCollectionMetadata } from '../lib/replicaApply.js'
import {
  absoluteSpaceUrl,
  absoluteUrl,
  collectionMetaPath,
  resourcePath,
  spaceMetaPath
} from '../lib/paths.js'
import type { ServerSigningKey } from '../lib/serverIdentity.js'
import { SERVER_SPACE_ID, keyRelationships } from '../lib/serverIdentity.js'
import { isSameTypeSet } from '../lib/spaceType.js'
import { loadSyncSigner } from '../lib/syncIdentity.js'
import {
  WEBVH_LOG_RESOURCE_ID,
  isValidController,
  parsePeerHostedWebvh
} from '../lib/validateDid.js'
import {
  isReplicaId,
  isUrlSafeSegment,
  spaceIdOfSpaceUrl
} from '../lib/validateId.js'
import {
  resolveWebvhController,
  verifyPeerServedLog
} from '../lib/webvhController.js'
import type { WebvhResolverContext } from '../lib/webvhController.js'
import { replicaMappingConflict } from '../lib/webvhLogLocation.js'
import {
  rootCapabilityId,
  throwIfServerFault,
  verifyOneLinkDelegation
} from '../zcap.js'
import { selectedCollectionIds } from './collectionSelection.js'
import type {
  CollectionMetadata,
  IDelegatedZcap,
  ReplicaRegistration,
  StorageBackend,
  StoredSpaceMetadata
} from '../types.js'
import { PeerClient } from './peerClient.js'
import type { PeerFetch } from './peerFetch.js'
import type { ServerBackends } from '../lib/serverBackends.js'

/**
 * The actions a pull capability may carry. The loop only reads.
 */
const PULL_ACTIONS = ['GET']

/**
 * An absolute URL for a path on the peer's server, resolved against the
 * peer Space URL.
 * @param options {object}
 * @param options.path {string}
 * @param options.fromSpace {string}   the peer Space URL
 * @returns {string}
 */
export function peerUrlOf({
  path,
  fromSpace
}: {
  path: string
  fromSpace: string
}): string {
  // The peer's Space URL supplies the origin the path is resolved against.
  return absoluteUrl({ path, serverUrl: fromSpace })
}

/**
 * Parses a registration body into the record to store. Members this server
 * does not know are dropped, and so are the stamp members, which the write
 * sets. `pausedAt` is kept as a marker: its presence means the registration
 * is paused, and the write replaces its value with the server's own time,
 * so it need only be a string here.
 *
 * @param options {object}
 * @param options.body {unknown}   the request body
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceId {string}   the local Space
 * @param options.requestName {string}
 * @returns {ReplicaRegistration}
 * @throws {InvalidRequestBodyError}
 */
export function parseReplicaRegistration({
  body,
  serverUrl,
  spaceId,
  requestName
}: {
  body: unknown
  serverUrl: string
  spaceId: string
  requestName: string
}): ReplicaRegistration {
  const refuse = (detail: string, pointer: string): never => {
    throw new InvalidRequestBodyError({ requestName, detail, pointer })
  }
  if (!isPlainObject(body)) {
    return refuse('The registration must be a JSON object.', '#')
  }
  const { id, fromSpace, toSpace, capability, collections, role, pausedAt } =
    body

  if (typeof id !== 'string' || !isReplicaId(id)) {
    return refuse(
      'The registration "id" must be a URL-safe string that does not end in ".state".',
      '#/id'
    )
  }
  if (spaceIdOfSpaceUrl(fromSpace) === undefined) {
    return refuse(
      'The registration "fromSpace" must be the peer Space\'s canonical URL, ' +
        'ending in a slash.',
      '#/fromSpace'
    )
  }
  const localSpaceUrl = absoluteSpaceUrl({ spaceId, serverUrl })
  if (toSpace !== localSpaceUrl) {
    return refuse(
      `The registration "toSpace" must be this Space's canonical URL, "${localSpaceUrl}".`,
      '#/toSpace'
    )
  }
  if (role !== 'source') {
    return refuse('The registration "role" must be "source".', '#/role')
  }
  if (pausedAt !== undefined && typeof pausedAt !== 'string') {
    return refuse(
      'The registration "pausedAt", when present, must be a string. Its ' +
        'value is set by the server.',
      '#/pausedAt'
    )
  }

  let selected: Array<{ id: string }> | undefined
  if (collections !== undefined) {
    if (!Array.isArray(collections)) {
      return refuse(
        'The registration "collections" must be an array of { id } objects.',
        '#/collections'
      )
    }
    selected = collections.map((item, index) => {
      if (
        !isPlainObject(item) ||
        typeof item.id !== 'string' ||
        !isUrlSafeSegment(item.id)
      ) {
        return refuse(
          'Each "collections" item must be an object with a URL-safe string "id".',
          `#/collections/${index}`
        )
      }
      return { id: item.id }
    })
  }

  if (!isPlainObject(capability)) {
    return refuse(
      'The registration "capability" must be a delegated capability.',
      '#/capability'
    )
  }
  const pull = capability as unknown as IDelegatedZcap
  if (
    typeof pull.id !== 'string' ||
    typeof pull.parentCapability !== 'string'
  ) {
    return refuse(
      'The registration "capability" must be a delegated capability, with ' +
        'an "id" and a "parentCapability".',
      '#/capability'
    )
  }
  if (pull.invocationTarget !== fromSpace) {
    return refuse(
      'The capability "invocationTarget" must equal "fromSpace".',
      '#/capability/invocationTarget'
    )
  }
  if (capabilityChainOf(pull)[0] !== rootCapabilityId(fromSpace as string)) {
    return refuse(
      "The capability's chain must start at the peer Space's root capability.",
      '#/capability/proof/capabilityChain'
    )
  }
  if (!actionsWithin({ capability: pull, allowed: PULL_ACTIONS })) {
    return refuse(
      'The capability "allowedAction" must be present and within ["GET"].',
      '#/capability/allowedAction'
    )
  }

  return {
    id,
    fromSpace: fromSpace as string,
    toSpace: localSpaceUrl,
    capability: pull,
    ...(selected !== undefined && { collections: selected }),
    role,
    ...(pausedAt !== undefined && { pausedAt })
  }
}

/**
 * Whether a served Collection Metadata object is under log governance: its
 * `encryption` carries the derived `history` member.
 * @param served {Record<string, unknown>}   a peer's `GET .../meta` body
 * @returns {boolean}
 */
function isGovernedCollection(served: Record<string, unknown>): boolean {
  return (
    isPlainObject(served.encryption) && isPlainObject(served.encryption.history)
  )
}

/**
 * The members of a served Collection Metadata object a replica stores: the
 * object without the members a server derives at response time. On a
 * Collection under log governance the served `encryption` and `revisions` are
 * derived from the log, which replicates as its own record, so both are left
 * out.
 * @param served {Record<string, unknown>}   a peer's `GET .../meta` body
 * @returns {CollectionMetadata}
 */
export function storedProjectionOfCollection(
  served: Record<string, unknown>
): CollectionMetadata {
  const { url: _url, linkset: _linkset, ...rest } = served
  if (isGovernedCollection(served)) {
    const { encryption: _encryption, revisions: _revisions, ...stored } = rest
    return stored as unknown as CollectionMetadata
  }
  return rest as unknown as CollectionMetadata
}

/**
 * Runs the peer checks of a registration and resolves the signer its pull
 * loop will use. Nothing is stored here.
 *
 * - The local Space is not the `server` Space.
 * - This server has a sync signer, and the capability is delegated to its
 *   DID.
 * - The peer's service description lists the replication specification at
 *   the version this server speaks and an `originId` that is not this
 *   server's.
 * - The peer Space, read through the capability, has the local Space's
 *   `type` set, and a controller the local one matches: the same DID, a
 *   `did:webvh` hosted in the peer Space whose current document lists the
 *   local `did:key` under `capabilityInvocation`, or a `did:webvh` this
 *   server resolves whose document admits the pull capability's one-link
 *   delegation (the bootstrap branch, {@link assertControllerBranch}).
 * - Each Collection the registration pulls that both sides hold agrees on
 *   the immutable members (`encryption`, `revisions.resolution`,
 *   `revisions.immutable`).
 *
 * @param options {object}
 * @param options.record {ReplicaRegistration}   the parsed registration
 * @param options.spaceId {string}   the local Space
 * @param options.spaceMetadata {StoredSpaceMetadata}   its Metadata object
 * @param options.storage {StorageBackend}   the control plane
 * @param options.serverBackends {ServerBackends}   the set `storage` is the
 *   control plane of
 * @param options.serverUrl {string}
 * @param [options.signingKey] {ServerSigningKey}
 * @param options.peerFetch {PeerFetch}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ pullsChunks: boolean }>}   whether the peer lists the
 *   Encrypted Collections entry, so the loop pulls chunk sets
 * @throws {ReplicaRefusedError}
 */
export async function assertReplicaAcceptable({
  record,
  spaceId,
  spaceMetadata,
  storage,
  serverBackends,
  serverUrl,
  signingKey,
  peerFetch,
  logger
}: {
  record: ReplicaRegistration
  spaceId: string
  spaceMetadata: StoredSpaceMetadata
  storage: StorageBackend
  serverBackends: ServerBackends
  serverUrl: string
  signingKey: ServerSigningKey | undefined
  peerFetch: PeerFetch
  logger: FastifyBaseLogger
}): Promise<{ pullsChunks: boolean }> {
  if (spaceId === SERVER_SPACE_ID) {
    throw new ReplicaRefusedError({
      detail: 'The "server" Space is not replicated.',
      pointer: '#/toSpace'
    })
  }
  const conflict = await replicaMappingConflict({
    storage,
    spaceId,
    record,
    localController: spaceMetadata.controller
  })
  if (conflict !== undefined) {
    throw new ReplicaRefusedError({
      detail:
        `Space "${conflict}" on this server already replicates the peer ` +
        'Space, with a Collection this registration would pull too. A ' +
        'did:webvh hosted in a Collection two local Spaces replicate ' +
        'resolves from neither copy.'
    })
  }
  const sync = await loadSyncSigner({
    storage,
    serverBackends,
    serverUrl,
    signingKey,
    logger
  })
  if ('refusal' in sync) {
    throw new ReplicaRefusedError({
      detail: `This server cannot replicate. ${sync.reason}`,
      pointer: '#/toSpace'
    })
  }
  if (record.capability.controller !== sync.serverDid) {
    throw new ReplicaRefusedError({
      detail:
        "The capability must be delegated to this server's DID, " +
        `"${sync.serverDid}".`,
      pointer: '#/capability/controller'
    })
  }

  const peer = new PeerClient({
    peerFetch,
    signer: sync.signer as ISigner,
    capability: record.capability
  })
  try {
    const { pullsChunks } = await assertPeerServes({ peer, record, storage })
    await assertPeerSpaceMatches({
      peer,
      record,
      spaceMetadata,
      webvh: { storage, serverBackends, serverUrl }
    })
    await assertImmutableMembersMatch({ peer, record, spaceId, storage })
    return { pullsChunks }
  } catch (err) {
    if (err instanceof PeerRequestError) {
      throw new ReplicaRefusedError({
        detail: `The peer could not be read. ${err.message}`
      })
    }
    throw err
  }
}

/**
 * The peer's service description must list the replication specification at
 * this server's version, and an origin id that is not this server's. The
 * same read decides whether the peer lists the Encrypted Collections entry,
 * which is what gives it chunk endpoints: a registration made against a
 * peer that lists none pulls no chunk sets, since its chunk listing route
 * does not exist and would answer every chunk pull with a 404 or a 405.
 * The result is read once, here; a peer that drops the profile later is
 * covered by making the registration again.
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.storage {StorageBackend}
 * @returns {Promise<{ pullsChunks: boolean }>}
 */
async function assertPeerServes({
  peer,
  record,
  storage
}: {
  peer: PeerClient
  record: ReplicaRegistration
  storage: StorageBackend
}): Promise<{ pullsChunks: boolean }> {
  const { json } = await peer.readJson({
    url: peerUrlOf({ path: '/service', fromSpace: record.fromSpace }),
    expect: [200],
    signed: false
  })
  const specs = isPlainObject(json.specs) ? json.specs : {}
  const entriesOf = (identifier: string): Record<string, unknown>[] => {
    const entries = specs[identifier]
    return Array.isArray(entries) ? entries.filter(isPlainObject) : []
  }
  if (
    !entriesOf(REPLICATION_IDENTIFIER).some(
      entry => entry.version === REPLICATION_VERSION
    )
  ) {
    throw new ReplicaRefusedError({
      detail:
        'The peer does not list the replication specification ' +
        `("${REPLICATION_IDENTIFIER}") at version ${REPLICATION_VERSION}.`
    })
  }
  const originId = entriesOf(SPEC_IDENTIFIER)
    .map(entry => entry.originId)
    .find(value => typeof value === 'string')
  if (originId === undefined) {
    throw new ReplicaRefusedError({
      detail: 'The peer advertises no "originId".'
    })
  }
  if (originId === storage.originId) {
    throw new ReplicaRefusedError({
      detail:
        `The peer carries this server's own origin id ("${originId}"). ` +
        'Two servers that replicate need different origin ids.'
    })
  }
  return {
    pullsChunks: entriesOf(ENCRYPTED_COLLECTIONS_IDENTIFIER).length > 0
  }
}

/**
 * The peer Space, read through the pull capability, must have the local
 * Space's `type` set and a controller the local Space's controller matches
 * (see {@link assertControllerBranch}).
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.spaceMetadata {StoredSpaceMetadata}   the local object
 * @param options.webvh {WebvhResolverContext}   the control plane, its set
 *   and this server's base URL, for the controller check
 * @returns {Promise<void>}
 */
async function assertPeerSpaceMatches({
  peer,
  record,
  spaceMetadata,
  webvh
}: {
  peer: PeerClient
  record: ReplicaRegistration
  spaceMetadata: StoredSpaceMetadata
  webvh: WebvhResolverContext
}): Promise<void> {
  const peerSpaceId = spaceIdOfSpaceUrl(record.fromSpace)!
  const { json } = await peer.readJson({
    url: peerUrlOf({
      path: spaceMetaPath({ spaceId: peerSpaceId }),
      fromSpace: record.fromSpace
    }),
    expect: [200]
  })
  if (json.controller !== spaceMetadata.controller) {
    await assertControllerBranch({
      peer,
      record,
      webvh,
      peerController: json.controller,
      localController: spaceMetadata.controller
    })
  }
  if (
    !Array.isArray(json.type) ||
    !isSameTypeSet({ left: json.type, right: spaceMetadata.type })
  ) {
    throw new ReplicaRefusedError({
      detail: 'The peer Space has another "type" set than this Space.'
    })
  }
}

/**
 * The first proof's capability chain, `[]` when the capability has none.
 * @param capability {IDelegatedZcap}
 * @returns {Array<string | IDelegatedZcap>}
 */
function capabilityChainOf(
  capability: IDelegatedZcap
): Array<string | IDelegatedZcap> {
  return [capability.proof].flat()[0]?.capabilityChain ?? []
}

/**
 * Refuses the registration on the controller check.
 * @param options {object}
 * @param options.detail {string}   why, after the sentence every such refusal
 *   opens with
 * @param [options.pointer] {string}   the JSON pointer of the offending member
 * @throws {ReplicaRefusedError}
 */
function refuseController({
  detail,
  pointer
}: {
  detail: string
  pointer?: string
}): never {
  throw new ReplicaRefusedError({
    detail: `The peer Space has another controller than this Space. ${detail}`,
    ...(pointer !== undefined && { pointer })
  })
}

/**
 * The controller check for a peer Space whose controller differs from the
 * local Space's. A wallet promotes its Space to a `did:webvh` before the
 * Space gains a replica, so the peer controller is that DID while a new
 * local Space is still under a `did:key`. The local Space cannot be promoted
 * first, since the DID resolves here only through a registration. The local
 * controller must be a `did:key`, and the peer controller a `did:webvh` this
 * server resolves one of two ways: hosted in the peer Space itself, its log
 * read through the pull capability ({@link readHostedControllerDocument}),
 * or hosted elsewhere, from the local copy another registration maps
 * ({@link assertMappedControllerResolves}). The second covers an auxiliary
 * Space whose controller's log lives in the account Space. A copy can lag the
 * source. A key the source retired is still caught, since the source verifies
 * the capability when the peer Space is read through it. A key the source
 * added is refused here until the next pull brings the copy forward, and the
 * refusal says so.
 *
 * With the document resolved, the registration is admitted in one of two
 * branches:
 *
 * - The listed-key branch: the DID is hosted in the peer Space and the
 *   document lists the local `did:key` under `capabilityInvocation`, the
 *   relationship a controller invokes under. A key listed under
 *   `capabilityDelegation` alone, a ladder method, does not pass.
 * - The bootstrap branch ({@link assertBootstrapDelegation}): the pull
 *   capability's chain is exactly `[root, capability]` and its delegation
 *   proof verifies under a method the document lists under
 *   `capabilityDelegation`. The local `did:key` need not appear in the
 *   document: a wallet derives one to create and register the replica Space
 *   and promotes the Space to the DID after the first pull.
 *
 * Nothing is fetched by DID.
 *
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.webvh {WebvhResolverContext}   the control plane, its set
 *   and this server's base URL
 * @param options.peerController {unknown}   the peer Space's `controller`
 * @param options.localController {string}   the local Space's `controller`
 * @returns {Promise<void>}
 * @throws {ReplicaRefusedError}
 */
async function assertControllerBranch({
  peer,
  record,
  webvh,
  peerController,
  localController
}: {
  peer: PeerClient
  record: ReplicaRegistration
  webvh: WebvhResolverContext
  peerController: unknown
  localController: string
}): Promise<void> {
  const hosted = parsePeerHostedWebvh(peerController, {
    serverUrl: webvh.serverUrl
  })
  if (!isValidController(localController) || hosted === undefined) {
    return refuseController({
      detail:
        'A Space replicates between Spaces of one controller, or onto a ' +
        'Space under a did:key from a Space whose did:webvh controller this ' +
        'server can resolve.'
    })
  }
  const did = peerController as string
  if (hosted.fromSpace !== record.fromSpace) {
    // A mapped copy admits the bootstrap branch alone.
    await assertMappedControllerResolves({ webvh, did })
    return await assertBootstrapDelegation({
      record,
      did,
      webvh,
      refusalNote:
        ' The copy of the log on this server may be behind the peer: retry ' +
        'after the registration that keeps it pulls again.'
    })
  }
  // The registration must pull the log's Collection, else the copy the
  // promotion needs would never arrive.
  const selected = selectedCollectionIds({ record, localController })
  if (selected !== undefined && !selected.has(hosted.collectionId)) {
    return refuseController({
      detail:
        `The registration does not pull Collection "${hosted.collectionId}", ` +
        "which holds the peer controller's history log.",
      pointer: '#/collections'
    })
  }
  const doc = await readHostedControllerDocument({
    peer,
    record,
    did,
    hosted,
    storage: webvh.storage
  })
  const publicKeyMultibase = localController.slice('did:key:'.length)
  const { listedUnder } = keyRelationships({ doc, publicKeyMultibase })
  if (listedUnder.includes('capabilityInvocation')) {
    return
  }
  // A stored copy may be absent or behind this log: a replaced capability
  // reaches here with its own registration mapping the DID, and can name
  // a key the copy has not pulled. So the bootstrap verifier resolves the
  // DID to the document just verified, over any stored log, and checks that
  // the document lists the signing key.
  await assertBootstrapDelegation({
    record,
    did,
    webvh: { ...webvh, peer: { did, document: doc } }
  })
}

/**
 * The current document of a `did:webvh` hosted in the peer Space, read
 * through the pull capability and verified under the rules a replicated copy
 * resolves under ({@link verifyPeerServedLog}).
 *
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.did {string}   the peer controller
 * @param options.hosted {object}   where the peer Space hosts its log
 * @param options.hosted.spaceId {string}
 * @param options.hosted.collectionId {string}
 * @param options.storage {StorageBackend}   the control plane
 * @returns {Promise<DIDDoc>}
 */
async function readHostedControllerDocument({
  peer,
  record,
  did,
  hosted,
  storage
}: {
  peer: PeerClient
  record: ReplicaRegistration
  did: string
  hosted: { spaceId: string; collectionId: string }
  storage: StorageBackend
}): Promise<DIDDoc> {
  const { body } = await peer.read({
    url: peerUrlOf({
      path: resourcePath({
        spaceId: hosted.spaceId,
        collectionId: hosted.collectionId,
        resourceId: WEBVH_LOG_RESOURCE_ID
      }),
      fromSpace: record.fromSpace
    }),
    expect: [200]
  })
  try {
    return await verifyPeerServedLog({
      storage,
      did,
      logText: body.toString('utf8')
    })
  } catch (err) {
    return refuseController({
      detail:
        "The peer controller's history log does not verify: " +
        (err as Error).message
    })
  }
}

/**
 * A `did:webvh` hosted in another Space of the peer host must resolve from
 * the local copy of its log that exactly one other registration on this
 * server maps (`lib/webvhLogLocation.ts`), through the same verify and
 * cache path every invocation uses, which the bootstrap verifier then takes
 * too.
 *
 * @param options {object}
 * @param options.webvh {WebvhResolverContext}
 * @param options.did {string}   the peer controller
 * @returns {Promise<void>}
 */
async function assertMappedControllerResolves({
  webvh,
  did
}: {
  webvh: WebvhResolverContext
  did: string
}): Promise<void> {
  try {
    await resolveWebvhController({ ...webvh, did })
  } catch (err) {
    // A storage fault under the log read is not the registration's doing
    // and keeps its 5xx.
    throwIfServerFault({ error: err })
    return refuseController({
      detail:
        'The peer controller is hosted in another Space than the peer Space, ' +
        'and resolves from no copy a registration on this server keeps: ' +
        (err as Error).message
    })
  }
}

/**
 * The bootstrap branch: the pull capability's chain is exactly
 * `[root, capability]`, and the one link's delegation proof verifies under
 * a method the peer controller's document lists under
 * `capabilityDelegation`. A re-delegated grant fails the one-link condition,
 * and a capability the peer refuses never reaches here, since the peer Space
 * is read through it first. The document comes through `webvh`: from
 * storage when this server maps the DID to a copy, else from the peer grant
 * the caller set over the document read through the pull capability.
 *
 * @param options {object}
 * @param options.record {ReplicaRegistration}
 * @param options.did {string}   the peer controller
 * @param options.webvh {WebvhResolverContext}
 * @param [options.refusalNote] {string}   what a proof refusal adds after its
 *   reason
 * @returns {Promise<void>}
 */
async function assertBootstrapDelegation({
  record,
  did,
  webvh,
  refusalNote = ''
}: {
  record: ReplicaRegistration
  did: string
  webvh: WebvhResolverContext
  refusalNote?: string
}): Promise<void> {
  const { capability } = record
  if (
    capability.parentCapability !== rootCapabilityId(record.fromSpace) ||
    capabilityChainOf(capability).length !== 1
  ) {
    return refuseController({
      detail:
        'A Space under a did:key registers only under a capability delegated ' +
        "straight from the peer Space's root capability, unless the peer " +
        'controller is hosted in the peer Space and its document lists the ' +
        'did:key under "capabilityInvocation"; a re-delegated one is refused.',
      pointer: '#/capability/proof/capabilityChain'
    })
  }
  const failure = await verifyOneLinkDelegation({
    capability,
    rootTarget: record.fromSpace,
    rootController: did,
    webvh
  })
  if (failure !== undefined) {
    return refuseController({
      detail:
        "The capability's delegation proof does not verify under a method " +
        "the peer controller's document lists under " +
        `"capabilityDelegation": ${failure.message}${refusalNote}`,
      pointer: '#/capability/proof'
    })
  }
}

/**
 * Each Collection the registration pulls that both sides already hold as the
 * same life must agree on the immutable members. With no `collections` list,
 * every local Collection is checked.
 *
 * Two lives of one id (different generations) are not compared. The apply
 * path never merges them: it replaces the held life or skips the received
 * one.
 *
 * A Collection under log governance stores no `encryption`, and its served
 * `revisions` is derived from the log. Where both sides are governed the logs
 * decide, on the apply path. Where one side is governed and the other stores
 * a client-written `encryption`, the two cannot be merged.
 * @param options {object}
 * @param options.peer {PeerClient}
 * @param options.record {ReplicaRegistration}
 * @param options.spaceId {string}   the local Space
 * @param options.storage {StorageBackend}
 * @returns {Promise<void>}
 */
async function assertImmutableMembersMatch({
  peer,
  record,
  spaceId,
  storage
}: {
  peer: PeerClient
  record: ReplicaRegistration
  spaceId: string
  storage: StorageBackend
}): Promise<void> {
  const peerSpaceId = spaceIdOfSpaceUrl(record.fromSpace)!
  let collectionIds = record.collections?.map(({ id }) => id)
  if (collectionIds === undefined) {
    collectionIds = []
    let cursor: string | undefined
    do {
      const page = await storage.listCollections({ spaceId, cursor })
      collectionIds.push(...page.items.map(({ id }) => id))
      cursor = cursorOfNextUrl(page.next)
    } while (cursor !== undefined)
  }
  // The reads run in batches, and their outcomes are then taken in list
  // order, so the error thrown is the one a read in order would meet first.
  const outcomes = await mapInBatches({
    items: collectionIds,
    map: async (
      collectionId
    ): Promise<{ fork?: string } | { error: unknown }> => {
      try {
        const stored = await storage.getCollectionMetadataAndLogValidator({
          spaceId,
          collectionId
        })
        if (!stored) {
          return {}
        }
        const { collectionMetadata: local } = stored
        const served = await peer.readJson({
          url: peerUrlOf({
            path: collectionMetaPath({ spaceId: peerSpaceId, collectionId }),
            fromSpace: record.fromSpace
          }),
          expect: [200, 404]
        })
        if (served.status === 404) {
          return {}
        }
        if (generationOfEtag(served.etag) !== local.metaGeneration) {
          return {}
        }
        const incoming = storedProjectionOfCollection(served.json)
        const peerGoverned = isGovernedCollection(served.json)
        const localGoverned = stored.logValidator !== undefined
        if (peerGoverned) {
          return localGoverned || local.encryption === undefined
            ? {}
            : {
                fork:
                  '"encryption" is derived from a governing history log on ' +
                  'the peer and declared directly here.'
              }
        }
        if (localGoverned && incoming.encryption !== undefined) {
          return {
            fork:
              '"encryption" is declared directly on the peer and derived ' +
              'from a governing history log here.'
          }
        }
        const forward = mergeAppliedCollectionMetadata({
          held: local,
          incoming
        })
        const backward = mergeAppliedCollectionMetadata({
          held: incoming,
          incoming: local,
          sides: { held: 'on the peer', incoming: 'here' }
        })
        const fork = [forward, backward].find(result => 'fork' in result)
        return fork !== undefined && 'fork' in fork ? { fork: fork.fork } : {}
      } catch (err) {
        return { error: err }
      }
    }
  })
  for (const [index, outcome] of outcomes.entries()) {
    if ('error' in outcome) {
      throw outcome.error
    }
    if (outcome.fork !== undefined) {
      throw new ReplicaRefusedError({
        detail: `Collection "${collectionIds[index]}" differs from the peer's: ${outcome.fork}`,
        pointer:
          record.collections === undefined
            ? '#/fromSpace'
            : `#/collections/${index}`
      })
    }
  }
}
