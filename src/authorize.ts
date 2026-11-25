/**
 * Per-request authorization decision. Replaces the inline `handleZcapVerify`
 * call in read handlers with a two-step decision: first try the capability
 * invocation (if auth headers are present); if that does not grant access, fall
 * back to the target's effective access-control policy (see policy.ts). Throws
 * the same errors as `handleZcapVerify` when neither path authorizes the
 * request. The decision is permissive: a policy can only broaden access, never
 * deny a valid capability holder.
 */
import type { FastifyRequest } from 'fastify'
import { verifyRequestZcap } from './zcap.js'
import { hasAuthHeaders, isSafeMethod } from './auth-header-hooks.js'
import {
  resolveEffectivePolicy,
  policyGrants,
  type AccessAction
} from './policy.js'
import { UnauthorizedError } from './errors.js'
import type { OwnResourcesRule } from './lib/ownResourcesOnly.js'
import type { IDID } from './types.js'

/**
 * What granted a request. `ownResourcesOnly` is present when a capability
 * granted it and the chain carries `OwnResourcesOnly` caveats the handler
 * must check: the principals, one per caveat (see `VerifiedInvocation`).
 */
export interface Authorization {
  grantedBy: 'capability' | 'policy'
  ownResourcesOnly?: IDID[]
}

/**
 * Whether the target's effective access-control policy grants the action to
 * everyone. A grant is logged, so a request allowed purely by a policy is
 * auditable.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies the control plane and
 *   the logger
 * @param options.action {AccessAction}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}   policy-resolution level
 * @param [options.resourceId] {string}   policy-resolution level
 * @returns {Promise<boolean>}
 */
export async function policyGrantsRequest({
  request,
  action,
  spaceId,
  collectionId,
  resourceId
}: {
  request: FastifyRequest
  action: AccessAction
  spaceId: string
  collectionId?: string
  resourceId?: string
}): Promise<boolean> {
  const policy = await resolveEffectivePolicy({
    storage: request.server.storage,
    spaceId,
    collectionId,
    resourceId
  })
  if (!policyGrants({ policy, action, logger: request.log })) {
    return false
  }
  request.log.info(
    { spaceId, collectionId, resourceId, action, policyType: policy?.type },
    'Access granted by access-control policy.'
  )
  return true
}

/**
 * Authorizes a request against a target, by capability invocation first and the
 * effective access-control policy second.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   the request (supplies url, method,
 *   headers, logger, and `request.server` for serverUrl + storage)
 * @param options.allowedTarget {string}   the capability's expected
 *   invocationTarget (full URL, including host and port)
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @param options.spaceController {IDID}   the DID that controls the Space: a
 *   `did:key`, or a self-hosted `did:webvh` on a promoted Space
 * @param [options.requestName] {string}   human-readable request name, used in
 *   error titles
 * @param [options.allowTargetQuery] {boolean}   tolerate query parameters that
 *   extend `allowedTarget` on the capability-invocation path (see `verifyZcap`)
 * @param [options.attenuatedRootTarget] {string}   ancestor target (the Space
 *   URL) whose root capability is also accepted as the root of a delegated
 *   chain attenuating down to the request URL (see `verifyZcap`)
 * @param [options.admitDidUrlRoot] {boolean}   admit a chain rooted in a DID
 *   URL under the Space `attenuatedRootTarget` names (see `handleZcapVerify`)
 * @param [options.ownResources] {OwnResourcesRule}   how the route answers a
 *   chain carrying the `OwnResourcesOnly` caveat (see `handleZcapVerify`)
 * @returns {Promise<Authorization>}   resolves when authorized, naming what
 *   granted the request: a verified capability invocation, or the
 *   access-control policy fallback; throws otherwise
 */
export async function authorize({
  request,
  allowedTarget,
  spaceId,
  collectionId,
  resourceId,
  spaceController,
  requestName = '',
  allowTargetQuery = false,
  attenuatedRootTarget,
  admitDidUrlRoot = false,
  ownResources
}: {
  request: FastifyRequest
  allowedTarget: string
  spaceId: string
  collectionId?: string
  resourceId?: string
  spaceController: IDID
  requestName?: string
  allowTargetQuery?: boolean
  attenuatedRootTarget?: string
  admitDidUrlRoot?: boolean
  ownResources?: OwnResourcesRule
}): Promise<Authorization> {
  const { method } = request
  const { storage } = request.server
  const action: AccessAction = isSafeMethod(method) ? 'read' : 'write'

  // 1. If the caller presented a capability invocation, try it first. Success
  // authorizes the request; failure -- a revoked capability included -- falls
  // through to the policy check (we hold the error to re-throw if the policy
  // does not grant access either). Revoking a capability therefore withdraws
  // only what the capability granted: access a policy already grants everyone
  // (a public-readable Space) survives, which is the permissive-policy model.
  let zcapError: Error | undefined
  if (hasAuthHeaders(request)) {
    try {
      const { ownResourcesOnly } = await verifyRequestZcap({
        request,
        peerWebvh: true,
        allowedTarget,
        spaceController,
        requestName,
        allowTargetQuery,
        attenuatedRootTarget,
        admitDidUrlRoot,
        ownResources,
        revocation: { storage, scope: { spaceId } }
      })
      return {
        grantedBy: 'capability',
        ...(ownResourcesOnly !== undefined && { ownResourcesOnly })
      }
    } catch (err) {
      zcapError = err as Error
    }
  }

  // 2. Fall back to the target's effective access-control policy.
  if (
    await policyGrantsRequest({
      request,
      action,
      spaceId,
      collectionId,
      resourceId
    })
  ) {
    return { grantedBy: 'policy' }
  }

  // Neither a capability nor a policy authorizes this request. Re-throw the
  // capability error when there was one, else a generic 404 (no leak).
  throw zcapError ?? new UnauthorizedError({ requestName })
}
