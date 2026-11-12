/**
 * Shared handler prelude for the create-by-consent bootstrap (paralleling
 * spaceContext.ts / keystoreContext.ts): the operations that create a
 * top-level resource owned by a DID named in the request *body* (Create
 * Space, the create form of Update Space, Create Keystore) have no stored
 * controller to verify against yet, so the invocation must be *authorized by*
 * the body's controller -- signed directly by it, or via a delegation chain
 * rooted in it. Verifying against the signer instead would let anyone install
 * an unrelated, non-consenting DID as controller.
 */
import type { FastifyRequest } from 'fastify'
import {
  assertInvocationPresent,
  baseDelegationSigner,
  embeddedDelegations,
  isRootInvocation,
  rootTargetOf,
  verifyRequestZcap
} from '../zcap.js'
import { InvalidRequestBodyError, type ProblemError } from '../errors.js'
import { didOfMethodId } from '../lib/validateDid.js'
import type { IDID } from '../types.js'

/**
 * Static pre-triage of a *failed* delegated consent verification, naming the
 * cause for the `controller-mismatch` error's non-normative `detail` (a spec
 * SHOULD, stated in Create Space Errors and the error registry: in a delegated
 * provisioning flow the cause determines who must act). The chain verifier
 * reports failure opaquely, so this re-reads the submitted chain from the
 * `Capability-Invocation` header -- WITHOUT verifying signatures; verification
 * already failed -- and distinguishes, in order:
 *
 * - chain rooted elsewhere: the chain's root capability targets a URL other
 *   than the accepted root targets, or the base delegation is signed by a DID
 *   other than the body's controller;
 * - expired delegation: a delegation in the chain carries an `expires` in the
 *   past;
 * - failed proof: everything lines up statically, so a signature (or another
 *   verifier-level check) must have failed.
 *
 * Best-effort by design: a capability that cannot be decoded yields
 * `undefined`, keeping the generic detail. Privacy-safe per the spec's note --
 * everything inspected here (the body's controller, the submitted chain) was
 * supplied by the caller, so the granularity reveals nothing the caller does
 * not already hold.
 *
 * @param options {object}
 * @param options.invocation {string}   the raw `Capability-Invocation` header
 *   (the delegated form, embedding `capability="<base64url(gzip(json))>"`)
 * @param options.controller {IDID}   the controller DID named in the request
 *   body, which the chain must root in
 * @param options.allowedTarget {string}   the expected root invocationTarget
 *   (full URL, including host and port)
 * @param [options.attenuatedRootTarget] {string}   an ancestor URL whose root
 *   capability is also accepted, and which the detail names as the expected
 *   root when present
 * @returns {string | undefined}   a cause clause for the error detail, or
 *   `undefined` when the submitted capability cannot be decoded
 */
function triageDelegatedConsentFailure({
  invocation,
  controller,
  allowedTarget,
  attenuatedRootTarget
}: {
  invocation: string
  controller: IDID
  allowedTarget: string
  attenuatedRootTarget?: string
}): string | undefined {
  // The submitted chain, in delegation order: the `capabilityChain` entries
  // (root id first, intermediate delegations embedded whole) plus the invoked
  // capability itself, which is not listed in its own chain.
  const embedded = embeddedDelegations({ invocation })
  if (embedded === undefined) {
    return undefined
  }
  const { delegations, rootId } = embedded
  // Chain rooted elsewhere (a): the root capability at the base of the chain
  // targets neither accepted root (another endpoint, or another server
  // entirely). The verifier accepts the attenuated root as well as the target
  // itself, so a chain rooted at either is not the cause.
  const rootTarget =
    typeof rootId === 'string' ? rootTargetOf(rootId) : undefined
  if (
    rootTarget !== undefined &&
    rootTarget !== allowedTarget &&
    rootTarget !== attenuatedRootTarget
  ) {
    return (
      `the delegation chain is rooted at "${rootTarget}",` +
      ` not at "${attenuatedRootTarget ?? allowedTarget}"`
    )
  }
  // Chain rooted elsewhere (b): the base delegation (the one hanging directly
  // off the root capability) is signed by a DID other than the body's
  // controller -- only the root's controller can validly make that delegation.
  const baseSigner = baseDelegationSigner({ invocation })
  if (baseSigner && baseSigner !== controller) {
    return (
      `the delegation chain is rooted in "${baseSigner}",` +
      ` not the body's controller`
    )
  }
  // Expired delegation: any zcap in the chain whose `expires` has passed.
  for (const delegation of delegations) {
    if (delegation.expires !== undefined) {
      const expiresMs = Date.parse(delegation.expires)
      if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) {
        return `a delegation in the chain expired at ${delegation.expires}`
      }
    }
  }
  // Nothing statically wrong: a proof (or another verifier-level check, e.g.
  // allowedAction) must have failed.
  return 'the delegation chain proof failed verification'
}

/**
 * Verifies that the invocation is authorized by `controller` (the DID named
 * in the request body). For the bare-root invocation form the signer *is* the
 * invoker, so a mismatch is rejected up front, before any signature work. The
 * delegated form instead carries a capability chain, judged by the
 * verification (which synthesizes the root capability with `controller` as
 * its controller): a delegated invocation that fails to verify is a chain not
 * rooted in the body's controller, wrapped in `MismatchError` (spec
 * `controller-mismatch`, 400) with the failure cause statically triaged into
 * its `detail` (see `triageDelegatedConsentFailure`). Root-form verification
 * failures keep their generic errors -- the signer already matched the
 * controller.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, `request.zcap`, and `request.server` for serverUrl
 * @param options.controller {IDID}   the controller DID named in the request
 *   body, which must authorize the invocation
 * @param options.allowedTarget {string}   the capability's expected
 *   invocationTarget (full URL, including host and port)
 * @param options.allowedAction {string}   expected action, e.g. an HTTP verb
 * @param options.MismatchError {new (options) => ProblemError}   the
 *   operation's `controller-mismatch` error class (constructed with
 *   `{ zcapSigningDid, controller, causeDetail?, cause? }`)
 * @param [options.attenuatedRootTarget] {string}   an ancestor URL whose root
 *   capability is also accepted as the base of a delegated chain, so a grant
 *   minted on the container attenuates down to the sub-resource being written
 *   (see `verifyZcap`)
 * @param [options.requestName] {string}   human-readable request name, used
 *   in error titles
 * @param [options.maxChainLength] {number}   max delegation chain length,
 *   root included (see `verifyZcap`)
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL in
 *   milliseconds (see `verifyZcap`)
 * @returns {Promise<void>}
 */
export async function verifyBodyControllerConsent({
  request,
  controller,
  allowedTarget,
  allowedAction,
  attenuatedRootTarget,
  MismatchError,
  requestName,
  maxChainLength,
  maxDelegationTtl
}: {
  request: FastifyRequest
  controller: IDID
  allowedTarget: string
  allowedAction: string
  attenuatedRootTarget?: string
  MismatchError: new (options: {
    zcapSigningDid: string
    controller: string
    causeDetail?: string
    cause?: Error
  }) => ProblemError
  requestName?: string
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<void> {
  // Every caller already refused a request with no auth headers: the
  // `/spaces/` and `/kms` groups through their auth-header hook (401), and
  // Create Space by Id through its own `assertInvocationPresent` (the masked
  // 404). The check is repeated here so `request.zcap` is set whatever the
  // caller did.
  assertInvocationPresent({ headers: request.headers })
  const { keyId, invocation } = request.zcap!
  const zcapSigningDid = didOfMethodId(keyId)
  const rootInvocation = isRootInvocation({ invocation })
  if (rootInvocation && zcapSigningDid !== controller) {
    throw new MismatchError({ zcapSigningDid, controller })
  }

  try {
    // The local did:webvh resolver `verifyRequestZcap` supplies is engaged
    // here as on every other verification path: a delegated provisioning
    // chain may carry a link signed by a self-hosted `did:webvh` method, even
    // though the body's controller (the chain's root) is a `did:key`.
    await verifyRequestZcap({
      request,
      allowedTarget,
      allowedAction,
      spaceController: controller,
      requestName,
      attenuatedRootTarget,
      // Consent verifies a chain rooted in the BODY's controller for a
      // resource that does not exist yet, so there is no keystore or Space
      // scope a revocation could have been stored under.
      revocation: 'no-revocation-scope',
      maxChainLength,
      maxDelegationTtl
    })
  } catch (err) {
    if (!rootInvocation) {
      throw new MismatchError({
        zcapSigningDid,
        controller,
        causeDetail: triageDelegatedConsentFailure({
          invocation,
          controller,
          allowedTarget,
          attenuatedRootTarget
        }),
        cause: err as Error
      })
    }
    throw err
  }
}

/**
 * Asserts a Space Metadata body carries a `controller` DID (the `name`
 * property is optional; see spec: Space Metadata object), narrowing it.
 * Shared by Create Space and Update Space, the two operations that take a
 * Space Metadata body.
 * @param options {object}
 * @param [options.body] {{ controller?: unknown }}   the parsed request body
 * @param options.requestName {string}   request name used in the error title
 * @returns {IDID}   the body's controller
 */
export function assertBodyController({
  body,
  requestName
}: {
  body?: { controller?: IDID }
  requestName: string
}): IDID {
  if (!body?.controller) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Space Metadata body requires a "controller" property.',
      pointer: '#/controller'
    })
  }
  return body.controller
}
