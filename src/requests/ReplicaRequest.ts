/**
 * Request handlers for a Space's replica registrations (the replication
 * specification): add one (`POST /space/:spaceId/replicas`), list them
 * (`GET` there), read, replace or remove one (`GET` / `PUT` / `DELETE`
 * `/space/:spaceId/replicas/:replicaId`), and read its pull loop's runtime
 * state (`GET .../status`).
 *
 * A registration is a versioned record: each write stamps it, and its `ETag`
 * is the standard four-segment shape (`lib/replicaRecord.ts`). `PUT` is the
 * one way to change a stored registration. It carries the full record, and
 * may differ from the stored one in `capability` and `pausedAt` alone: it
 * pauses and resumes the pull loop, and replaces the pull capability in
 * place, the registration keeping its id, its loop and its checkpoint.
 *
 * Every method, the reads included, admits a root invocation by the Space's
 * controller and a delegated invocation whose invoked capability targets the
 * Space's replicas URL or a URL beneath it, the `replicas-subtree` container
 * rule (`lib/containerRule.ts`). A grant on the Space URL, an app's data
 * grant, is refused: it would reach these routes by attenuation and list the
 * pull capabilities, pause the loops and remove the registrations. The reads
 * keep demanding the auth headers. The delegated path carries two bounds. A
 * create, by POST or by PUT at an absent id, admits only a `fromSpace` a
 * registration already on the Space names (`lib/replicaRecord.ts`), decided
 * once here before the peer is read and again inside the write's critical
 * section, so a delegated grant can re-register a source the Space has and
 * cannot introduce a new one. A pause of the registration that maps the
 * Space's controller is refused, since a paused copy of the controller's log
 * never learns of a key the account withdrew, and a delegated grant is what a
 * withdrawn key would have signed. A root invocation carries neither bound.
 * Delete Replica keeps the registration that maps the Space's controller,
 * whoever invokes it. The delegated path exists because a promoted replica
 * Space, whose controller is an account did:webvh, must be maintained by a
 * session holding no key that document lists under `capabilityInvocation`. A
 * registration names one source peer. Data flows from `fromSpace` to
 * `toSpace`, this Space, and nothing flows back without a registration on
 * the peer's side.
 */
import { isDeepStrictEqual } from 'node:util'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ReplicaRegistration } from '@interop/storage-core'
import {
  InvalidRequestBodyError,
  ReplicaNotFoundError,
  ReplicaRefusedError
} from '../errors.js'
import { formatEtag, parseWritePreconditions } from '../lib/etag.js'
import { assertReplicaWritePrecondition } from '../lib/preconditions.js'
import {
  assertCreateNamesRegisteredSource,
  assertReplacementKeepsFixedMembers,
  replicaValidator
} from '../lib/replicaRecord.js'
import { invalidateSpaceMetadata } from '../lib/spaceMetadataCache.js'
import {
  controllerUnmappedByRemoval,
  invalidateReplicaIndex
} from '../lib/webvhLogLocation.js'
import {
  absoluteUrl,
  replicaPath,
  replicasPath,
  replicaStatusPath
} from '../lib/paths.js'
import { assertValidIds, isReplicaId } from '../lib/validateId.js'
import {
  assertReplicaAcceptable,
  parseReplicaRegistration
} from '../sync/registration.js'
import type { ReplicaListing, StorageBackend, StoredReplica } from '../types.js'
import { fetchSpaceAndVerify } from './spaceContext.js'

/**
 * The `ETag` of a stored registration: its generation and its stamp, the
 * four-segment shape every versioned record has.
 * @param stored {StoredReplica}
 * @returns {string}
 */
function replicaEtag(stored: StoredReplica): string {
  return formatEtag(replicaValidator(stored))
}

/**
 * The container rule every replicas route carries: a delegated invocation
 * passes only when the invoked capability targets the Space's replicas URL
 * or a URL beneath it.
 */
const containerRule = 'replicas-subtree'

/**
 * The bound on a create under a delegated invocation, decided here before
 * the peer is read so a refused body costs the source server nothing, and
 * again by the write under its lock, where it holds. A root invocation
 * carries no bound.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.spaceId {string}
 * @param options.record {ReplicaRegistration}
 * @param options.rootInvocation {boolean}
 * @returns {Promise<void>}
 * @throws {ReplicaRefusedError}
 */
async function assertDelegatedCreateNamesRegisteredSource({
  storage,
  spaceId,
  record,
  rootInvocation
}: {
  storage: StorageBackend
  spaceId: string
  record: ReplicaRegistration
  rootInvocation: boolean
}): Promise<void> {
  if (rootInvocation) {
    return
  }
  assertCreateNamesRegisteredSource({
    record,
    registered: await storage.listReplicas({ spaceId })
  })
}

/**
 * Refuses a write that would pause the one registration mapping a Space's
 * `did:webvh` controller to a local copy of its log, under a delegated
 * invocation. A paused copy stops following the source, so a key the account
 * withdrew there stays current here for as long as the pause holds, and a
 * ladder method it signed keeps every grant it signed valid. That is the
 * removal Delete Replica refuses, in a form that leaves the registration in
 * place. A root invocation may pause it: the controller's own key decides.
 * A body that keeps the registration paused is refused too, since the
 * pause it repeats was the controller's. A resume is never refused.
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}
 * @param options.spaceId {string}
 * @param options.replicaId {string}
 * @returns {Promise<void>}
 * @throws {ReplicaRefusedError}
 */
async function assertDelegatedPauseKeepsControllers({
  storage,
  serverUrl,
  spaceId,
  replicaId
}: {
  storage: StorageBackend
  serverUrl: string
  spaceId: string
  replicaId: string
}): Promise<void> {
  const unmapped = await controllerUnmappedByRemoval({
    storage,
    serverUrl,
    spaceId,
    replicaId
  })
  if (unmapped === undefined) {
    return
  }
  throw new ReplicaRefusedError({
    title: 'The replica registration cannot be paused.',
    pointer: '#/pausedAt',
    detail:
      `Space "${unmapped.spaceId}" is controlled by "${unmapped.did}", ` +
      'which resolves only from the log this registration replicates, and ' +
      'a paused copy would stop following that log. Pausing it takes the ' +
      "Space controller's own capability."
  })
}

export class ReplicaRequest {
  /**
   * POST /space/:spaceId/replicas
   * Registers a source peer. The body is checked, a delegated invocation's
   * `fromSpace` is checked against the registrations the Space already holds
   * (`replica-refused`, 409, when none names it), then the peer is read
   * (`sync/registration.ts`), and only then is the record stored, under the
   * same bound decided again inside the write, and its pull loop started.
   * Responds 201 with the record, its `ETag`, and a `Location`. A duplicate
   * id is `id-conflict` (409).
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{ Params: { spaceId: string }; Body: unknown }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId },
      body
    } = request
    const { serverUrl, storage, serverSigningKey, replication } = request.server
    const requestName = 'Register Replica'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId }, { requestName })

    // Verify before the body is judged, so its 400s tell an unauthorized
    // caller nothing.
    const { spaceMetadata, rootInvocation } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicasPath({ spaceId }),
      requestName,
      containerRule
    })
    const record = parseReplicaRegistration({
      body,
      serverUrl,
      spaceId,
      requestName
    })
    await assertDelegatedCreateNamesRegisteredSource({
      storage,
      spaceId,
      record,
      rootInvocation
    })
    const { pullsChunks } = await assertReplicaAcceptable({
      record,
      spaceId,
      spaceMetadata,
      storage,
      serverBackends: request.server.serverBackends,
      serverUrl,
      signingKey: serverSigningKey,
      peerFetch: replication.peerFetch,
      logger: request.log
    })

    const stored = await storage.createReplica({
      spaceId,
      record,
      pullsChunks,
      requireRegisteredSource: !rootInvocation
    })
    // The Space Metadata object lists the registration under `replicas` and
    // its validator advanced with it, so the cached object is stale. The
    // registration may map a peer-hosted did:webvh onto this Space's copy.
    invalidateSpaceMetadata({ storage, spaceId })
    invalidateReplicaIndex({ storage })
    if (stored.record.pausedAt === undefined) {
      replication.register({ spaceId, replicaId: record.id })
    }

    reply.header(
      'Location',
      absoluteUrl({
        path: replicaPath({ spaceId, replicaId: record.id }),
        serverUrl
      })
    )
    reply.header('ETag', replicaEtag(stored))
    return reply.status(201).send(stored.record)
  }

  /**
   * PUT /space/:spaceId/replicas/:replicaId
   * Creates or replaces a registration. The body is the full record, as
   * POST carries it, with `id` equal to the URL's. On a stored registration
   * only `capability` and `pausedAt` may differ, and a difference elsewhere
   * is `invalid-request-body` (400) on that member's pointer. A body that
   * carries `pausedAt` pauses the pull loop, one that omits it resumes; the
   * stored value is the server's own time. A capability that differs from
   * the stored one passes the peer checks a POST's does; one that does not
   * is not re-read. A create under a delegated invocation carries POST's
   * `fromSpace` bound, and a delegated pause of the registration that maps
   * the Space's controller is `replica-refused` (409) on `#/pausedAt`. The
   * loop reacts at once to a pause, a resume, a new capability or a create,
   * and a repeat of the stored body leaves its schedule alone. The body is
   * judged against the stored registration inside the write's critical
   * section, the create bound with it. `If-Match` and `If-None-Match: *` are
   * evaluated by the backend atomically with the write (412). Responds 201
   * with the record and a `Location` when the registration did not exist,
   * else 204, both under the new `ETag`. The registration keeps its id, its
   * loop and its checkpoint.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId },
      body
    } = request
    const { serverUrl, storage, serverSigningKey, replication } = request.server
    const requestName = 'Update Replica'

    assertValidIds({ spaceId }, { requestName })
    // Verify before the body is judged, so its 400s tell an unauthorized
    // caller nothing.
    const { spaceMetadata, rootInvocation } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaPath({ spaceId, replicaId }),
      requestName,
      containerRule
    })
    const record = parseReplicaRegistration({
      body,
      serverUrl,
      spaceId,
      requestName
    })
    if (record.id !== replicaId) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `The registration "id" must equal the URL's, "${replicaId}".`,
        pointer: '#/id'
      })
    }
    // The peer checks need the network, so they run outside the write's
    // lock, and only for a capability the stored record does not already
    // carry, so a pause or a resume costs no read of the source server. The
    // read here decides that alone; the write judges the body against the
    // stored registration again inside its critical section, where it
    // cannot go stale, and its verdict is the one that counts. The same
    // precondition and fixed-member checks run here first only to spare a
    // doomed write the peer checks: a stale `If-Match` under a retry loop
    // would otherwise cost the source server a read per attempt.
    const prior = await storage.getReplica({ spaceId, replicaId })
    const preconditions = parseWritePreconditions(request.headers)
    assertReplicaWritePrecondition({
      replicaId,
      exists: prior !== undefined,
      currentEtag: prior && replicaEtag(prior),
      ...preconditions
    })
    const sameCapability = (stored: StoredReplica | undefined): boolean =>
      stored !== undefined &&
      isDeepStrictEqual(record.capability, stored.record.capability)
    if (prior !== undefined) {
      assertReplacementKeepsFixedMembers({
        record,
        stored: prior.record,
        requestName
      })
      // The pause guard reads the replica index and the Space listing, so it
      // runs after the cheap checks above and only against a stored
      // registration, the one thing a pause can hold.
      if (!rootInvocation && record.pausedAt !== undefined) {
        await assertDelegatedPauseKeepsControllers({
          storage,
          serverUrl,
          spaceId,
          replicaId
        })
      }
    } else {
      // A PUT at an absent id is a create, and carries the delegated path's
      // bound as POST does. A replacement needs none, `fromSpace` being a
      // fixed member. The write decides both again under its lock, and
      // bounds as a create a PUT whose registration was removed meanwhile.
      await assertDelegatedCreateNamesRegisteredSource({
        storage,
        spaceId,
        record,
        rootInvocation
      })
    }
    // Under an unchanged capability the stored value stands, checked when
    // that capability was stored; the write keeps it when the capability it
    // finds under the lock is unchanged too.
    const pullsChunks =
      prior !== undefined && sameCapability(prior)
        ? prior.pullsChunks
        : (
            await assertReplicaAcceptable({
              record,
              spaceId,
              spaceMetadata,
              storage,
              serverBackends: request.server.serverBackends,
              serverUrl,
              signingKey: serverSigningKey,
              peerFetch: replication.peerFetch,
              logger: request.log
            })
          ).pullsChunks

    const { stored, prior: replaced } = await storage.writeReplica({
      spaceId,
      record,
      pullsChunks,
      requireRegisteredSource: !rootInvocation,
      ...preconditions
    })
    const created = replaced === undefined
    // A create changes the served `replicas` member of the Space Metadata
    // object, and adds a registration to the index that maps a peer-hosted
    // did:webvh onto this Space's copy. A replacement changes neither: the
    // index reads `fromSpace` and `collections`, which a replacement keeps.
    if (created) {
      invalidateSpaceMetadata({ storage, spaceId })
      invalidateReplicaIndex({ storage })
    }
    // The loop reacts at once to a create, a pause, a resume, or a new
    // capability. A write that changed none of those, a repeat of the
    // stored body, leaves the scheduled cycle alone. A create that is
    // paused starts no loop, as POST starts none for one.
    const paused = record.pausedAt !== undefined
    const wasPaused = replaced?.record.pausedAt !== undefined
    const loopChanged = created
      ? !paused
      : paused !== wasPaused || !sameCapability(replaced)
    if (loopChanged) {
      replication.wake({ spaceId, replicaId })
    }

    reply.header('ETag', replicaEtag(stored))
    if (!created) {
      return reply.status(204).send()
    }
    reply.header(
      'Location',
      absoluteUrl({ path: replicaPath({ spaceId, replicaId }), serverUrl })
    )
    return reply.status(201).send(stored.record)
  }

  /**
   * GET /space/:spaceId/replicas
   * Lists the Space's registrations, capabilities included.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{ Params: { spaceId: string } }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId }
    } = request
    const { storage } = request.server
    const requestName = 'List Replicas'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicasPath({ spaceId }),
      requestName,
      containerRule
    })

    const replicas = await storage.listReplicas({ spaceId })
    return reply.status(200).send({
      url: replicasPath({ spaceId }),
      totalItems: replicas.length,
      items: replicas.map(({ record }) => record)
    } satisfies ReplicaListing)
  }

  /**
   * GET /space/:spaceId/replicas/:replicaId
   * Reads one registration back as it was written, under its `ETag`.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Replica'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaPath({ spaceId, replicaId }),
      requestName,
      containerRule
    })

    // An id no registration can carry names none, and never reaches storage.
    const stored = isReplicaId(replicaId)
      ? await storage.getReplica({ spaceId, replicaId })
      : undefined
    if (stored === undefined) {
      throw new ReplicaNotFoundError({ requestName })
    }
    reply.header('ETag', replicaEtag(stored))
    return reply.status(200).send(stored.record)
  }

  /**
   * DELETE /space/:spaceId/replicas/:replicaId
   * Removes a registration and its loop state, stops its pull loop, and
   * reclaims the chunk staging its loop left on every server backend.
   * Nothing already pulled is removed. Idempotent: 204 whether or not a
   * registration was stored. Refused with `replica-refused` (409) while the
   * registration is the only one that maps a Space's `did:webvh` controller
   * to a local copy of its log, for a delegated caller as for the controller.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId }
    } = request
    const { serverUrl, storage, replication } = request.server
    const requestName = 'Delete Replica'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaPath({ spaceId, replicaId }),
      requestName,
      containerRule
    })

    // An id no registration can carry names none, and never reaches storage.
    if (!isReplicaId(replicaId)) {
      return reply.status(204).send()
    }
    // A did:webvh hosted on the peer resolves here only through a
    // registration. Removing the last one that maps a Space's controller
    // would leave that Space with no resolvable controller and no
    // break-glass, since re-registering and Update Space are both authorized
    // by the controller.
    const unmapped = await controllerUnmappedByRemoval({
      storage,
      serverUrl,
      spaceId,
      replicaId
    })
    if (unmapped !== undefined) {
      throw new ReplicaRefusedError({
        title: 'The replica registration cannot be removed.',
        pointer: null,
        detail:
          `Space "${unmapped.spaceId}" is controlled by "${unmapped.did}", ` +
          'which resolves only from the log this registration replicates. ' +
          'Change that controller first. To pause the pull loop or replace ' +
          'the pull capability, PUT the registration instead.'
      })
    }
    const deleted = await storage.deleteReplica({ spaceId, replicaId })
    if (deleted) {
      invalidateSpaceMetadata({ storage, spaceId })
      invalidateReplicaIndex({ storage })
    }
    replication.unregister({ spaceId, replicaId })
    // The chunk staging the registration's loop left, on every server
    // backend a Collection's data plane may live on, whether or not this
    // call removed the record: a repeat delete reclaims what an earlier one
    // missed. The loop is stopped first; a chunk its cycle in flight stages
    // after this is reclaimed at the next boot. The registration is gone
    // by now, so a reclaim that fails is logged and does not fail the
    // delete: the staging is reclaimed at the next boot or repeat delete.
    for (const backend of request.server.serverBackends.all()) {
      try {
        await backend.reclaimStaging({ spaceId, replicaId })
      } catch (err) {
        request.log.warn(
          { err, spaceId, replicaId, backend: backend.describe().id },
          'Reclaiming the chunk staging of a removed replica registration failed'
        )
      }
    }
    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/replicas/:replicaId/status
   * The runtime state of the registration's pull loop: the loop `state`, the
   * pull times, and one item per Collection it has pulled, with the stall
   * of a stalled one. It changes with every cycle, so it is not cacheable.
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async status(
    request: FastifyRequest<{
      Params: { spaceId: string; replicaId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, replicaId }
    } = request
    const requestName = 'Get Replica Status'

    assertValidIds({ spaceId }, { requestName })
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: replicaStatusPath({ spaceId, replicaId }),
      requestName,
      containerRule
    })

    // An id no registration can carry names none, and never reaches storage.
    const status = isReplicaId(replicaId)
      ? await request.server.replication.status({ spaceId, replicaId })
      : undefined
    if (status === undefined) {
      throw new ReplicaNotFoundError({ requestName })
    }
    reply.header('Cache-Control', 'no-store')
    return reply.status(200).send(status)
  }
}
