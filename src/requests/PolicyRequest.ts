/**
 * Request handlers for access-control policy operations: get/update/delete the
 * `policy` auxiliary resource at the Space, Collection, or Resource level (the
 * level is selected by which path params are present). Reading or modifying a
 * policy is privileged: every operation verifies a capability invocation against
 * the Space controller, and none consults the policy fallback (a policy is
 * controller-managed metadata, not public data). No hook stands behind that:
 * a request with no auth headers reaches the handler, and
 * `fetchSpaceAndVerify` answers it the masked `not-found` (404).
 *
 * A policy is a versioned record (`lib/policyRecord.ts`): a read serves its
 * write stamp members and its `ETag`, a write or delete takes `If-Match` /
 * `If-None-Match`, and a delete leaves a tombstone that reads as absent
 * unless asked for with `?include=deleted`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndVerify } from './spaceContext.js'
import {
  fetchCollectionAndBackend,
  isControlPlaneBackend
} from './collectionContext.js'
import { notModifiedReply, withEtag } from './notModified.js'
import { assertValidIds } from '../lib/validateId.js'
import { policyPath } from '../lib/paths.js'
import { invalidatePolicy } from '../lib/policyCache.js'
import { hasPolicyType } from '../lib/policyRecord.js'
import {
  type EtagValidator,
  formatEtag,
  parseWritePreconditions
} from '../lib/etag.js'
import { parseIncludeSections } from '../lib/pagination.js'
import { InvalidPolicyError, PolicyNotFoundError } from '../errors.js'
import type { PolicyDocument, PolicyWriteResult } from '../types.js'

/** Path params shared by the three policy route shapes. */
export interface PolicyParams {
  spaceId: string
  collectionId?: string
  resourceId?: string
}

export class PolicyRequest {
  /**
   * GET /space/:spaceId[/:collectionId[/:resourceId]]/policy
   * Read the access-control policy document set at this level, with its
   * write stamp members (`updatedAt`, `updatedAtCounter`, `originId`) and its
   * `ETag`. A conditional read whose `If-None-Match` covers the `ETag` is
   * answered 304. A deleted policy's tombstone is answered 404, the same as
   * no policy, unless the request asks for `?include=deleted`: then it is
   * answered 200 with its `ETag` and a body of `deleted: true` plus the stamp
   * of the delete. The read is capability-only, so the tombstone is only
   * ever served under a verified capability.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: PolicyParams
      Querystring: { include?: string | string[] }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { spaceId, collectionId, resourceId } = request.params
    const { storage } = request.server
    const requestName = 'Get Policy'

    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Verify (capability-only): a policy is controller-managed metadata, so
    // reading it requires a valid capability invocation -- no policy fallback.
    // `allowTargetQuery` lets a controller's root invocation of the
    // `?include=deleted` URL verify: the query selects what the read serves
    // and does not change the capability target.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: policyPath({ spaceId, collectionId, resourceId }),
      requestName,
      allowTargetQuery: true
    })

    // authorized, continue

    // An unknown `include` section is ignored, as on the Space listing.
    const includeDeleted = parseIncludeSections(request.query.include).includes(
      'deleted'
    )
    const record = await storage.getPolicyRecord({
      spaceId,
      collectionId,
      resourceId
    })
    if (!record || (record.deleted && !includeDeleted)) {
      throw new PolicyNotFoundError({ requestName })
    }
    const etag = record.validator && formatEtag(record.validator)
    const notModified = notModifiedReply({ request, reply, etag })
    if (notModified) {
      return notModified
    }
    return withEtag({ reply, etag })
      .status(200)
      .type('application/json')
      .send(JSON.stringify(record.deleted ? record.tombstone : record.policy))
  }

  /**
   * PUT /space/:spaceId[/:collectionId[/:resourceId]]/policy
   * Create or replace the access-control policy document at this level. The
   * body's `updatedAt`, `updatedAtCounter`, `originId` and `deleted` are
   * ignored. `If-Match` / `If-None-Match: *` are evaluated by the backend,
   * atomically with the write (412 otherwise). Answers 201 with the stored
   * policy when the write created it (over a tombstone included), else 204,
   * both with the new `ETag`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{ Params: PolicyParams; Body: unknown }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { spaceId, collectionId, resourceId } = request.params
    const { body } = request
    const { storage } = request.server
    const requestName = 'Update Policy'

    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // A policy document must be a JSON object carrying a non-empty string
    // `type` (`hasPolicyType`, a shape check only).
    if (!hasPolicyType(body)) {
      throw new InvalidPolicyError({ requestName })
    }
    const policy = body as PolicyDocument

    // Verify (capability-only): a policy is controller-managed metadata, so
    // writing it requires a valid capability invocation -- no policy fallback.
    const { allowedTarget: policyUrl } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: policyPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // A Resource-level policy is written only over a live Resource, which the
    // backend checks under the write's lock. A Collection on a registered
    // external backend keeps its Resources there, so the primary store has
    // nothing to check and the write goes through.
    let requireLiveResource: boolean | undefined
    if (collectionId !== undefined && resourceId !== undefined) {
      const { dataBackend } = await fetchCollectionAndBackend({
        request,
        spaceId,
        collectionId,
        requestName
      })
      requireLiveResource = isControlPlaneBackend({ request, dataBackend })
    }

    // Bust the cached policy at this exact level so the next read sees this
    // write (and does not keep serving a stale cached "no policy" negative).
    // The bust runs whatever the write's outcome: the control plane may hold
    // the policy when the copy another server backend keeps faulted.
    let result: PolicyWriteResult
    try {
      result = await storage.writePolicy({
        spaceId,
        collectionId,
        resourceId,
        policy,
        requireLiveResource,
        ...parseWritePreconditions(request.headers)
      })
    } finally {
      invalidatePolicy({ storage, spaceId, collectionId, resourceId })
    }
    const { validator, created, policy: stored } = result

    reply.header('Location', policyUrl).header('etag', formatEtag(validator))
    if (!created) {
      return reply.status(204).send()
    }
    return reply
      .status(201)
      .type('application/json')
      .send(JSON.stringify(stored))
  }

  /**
   * DELETE /space/:spaceId[/:collectionId[/:resourceId]]/policy
   * Remove the access-control policy document at this level (idempotent).
   * The backend leaves a tombstone in its place, which grants nothing, and
   * the 204 carries the tombstone's `ETag`. Deleting an absent or already
   * deleted policy writes nothing and answers 204 with no `ETag`.
   * `If-Match` / `If-None-Match` are evaluated against the live policy.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{ Params: PolicyParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { spaceId, collectionId, resourceId } = request.params
    const { storage } = request.server
    const requestName = 'Delete Policy'

    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Verify (capability-only): a policy is controller-managed metadata, so
    // deleting it requires a valid capability invocation -- no policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: policyPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // Bust the cached policy at this exact level so the next read sees it gone
    // rather than a stale cached grant, whatever the write's outcome: the
    // control plane may hold the tombstone when the copy another server
    // backend keeps faulted.
    let validator: EtagValidator | undefined
    try {
      validator = await storage.deletePolicy({
        spaceId,
        collectionId,
        resourceId,
        ...parseWritePreconditions(request.headers)
      })
    } finally {
      invalidatePolicy({ storage, spaceId, collectionId, resourceId })
    }
    return withEtag({
      reply,
      etag: validator === undefined ? undefined : formatEtag(validator)
    })
      .status(204)
      .send()
  }
}
