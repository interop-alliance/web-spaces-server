/**
 * Request handlers for zcap revocation, one per route family:
 * - POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId
 * - POST /space/:spaceId/zcaps/revocations/:revocationId
 *
 * Both share one submission flow (`submitRevocation`), differing only in the
 * scope the revocation aggregates under -- a keystore or a Space -- the action
 * the invocation must carry (the webkms `write` vs the PWS route families'
 * HTTP verb), and the `/kms` delegation policy the PWS families do not impose.
 *
 * The wire contract is protocol-fixed by ezcap-express's
 * `authorizeZcapRevocation` / `@interop/webkms-client` (the conformance
 * suite): `:revocationId` is the to-be-revoked capability's id, URL-encoded;
 * the body is that capability, verbatim; success is 204 with no body. The
 * submission is authorized under the dual-root rule -- an invocation rooted
 * in the scope, or in the revocation URL itself, whose synthesized root is
 * controlled by every controller in the to-be-revoked capability's (fully
 * verified) chain -- so a delegee can revoke its own zcap without holding a
 * separate capability. Root zcaps cannot be revoked. The stored revocation is
 * consulted by the chain-inspection hook on every subsequent verification
 * rooted in that scope (`lib/revocations.ts`).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  capabilityActionOf,
  handleRevocationInvocationVerify,
  ROOT_PREFIX,
  verifyRevocationChain
} from '../zcap.js'
import { isPlainObject } from '../lib/isPlainObject.js'
import {
  revocationChainInspector,
  revocationRecordFor
} from '../lib/revocations.js'
import {
  clientAnnexChainInspector,
  composeChainInspectors
} from '../lib/clientAnnexClause.js'
import { absoluteSpaceUrl } from '../lib/paths.js'
import {
  KMS_MAX_CHAIN_LENGTH,
  KMS_MAX_DELEGATION_TTL
} from '../config.default.js'
import {
  CapabilityAlreadyRevokedError,
  InvalidRevocationError
} from '../errors.js'
import type { WebvhResolverContext } from '../lib/webvhController.js'
import type { IDID, RevocationRecord, RevocationScope } from '../types.js'
import { fetchKeystore } from './keystoreContext.js'
import { fetchSpace } from './spaceContext.js'

/**
 * Checks the submitted body is a revocable delegated capability naming the
 * revocation URL's id, and verifies its own delegation chain (it must root in
 * `rootTarget`). Rejects with `InvalidRevocationError` (400) on any of those,
 * and returns the capability together with what the chain verification yields:
 * its `delegator`, the `chainControllers` the dual-root invocation check reads,
 * and the `capabilities` the store is later checked against.
 *
 * Split out of {@link submitRevocation} so its failure can be captured and
 * re-raised after the invocation verifies, rather than answering an
 * unauthorized caller a 400 that an absent scope would have answered 404.
 *
 * @param options {object}
 * @param options.body {unknown}   the parsed request body
 * @param options.revocationId {string}   the URL's revocation id
 * @param options.rootTarget {string}   the scope's full URL, the required root
 *   of the submitted capability's chain
 * @param options.rootController {IDID}   the scope's controller
 * @param options.webvh {WebvhResolverContext}   resolver context for a
 *   `did:webvh` controller in the chain
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @returns {Promise<object>}   `{ capabilityBody, delegator, chainControllers,
 *   capabilities }`
 */
async function validateSubmittedCapability({
  body,
  revocationId,
  rootTarget,
  rootController,
  webvh,
  maxChainLength,
  maxDelegationTtl
}: {
  body: unknown
  revocationId: string
  rootTarget: string
  rootController: IDID
  webvh: WebvhResolverContext
  maxChainLength?: number
  maxDelegationTtl?: number
}) {
  if (!isPlainObject(body) || typeof body.id !== 'string') {
    throw new InvalidRevocationError({
      detail: 'The revocation body must be a capability with a string "id".'
    })
  }
  if (body.id.startsWith(ROOT_PREFIX)) {
    throw new InvalidRevocationError({
      detail: 'A root capability cannot be revoked.'
    })
  }
  // The submitted capability must be the one the URL names (the client
  // frames the id with `encodeURIComponent` into the final path segment).
  if (body.id !== revocationId) {
    throw new InvalidRevocationError({
      detail: 'The capability "id" does not match the revocation URL.'
    })
  }

  const verified = await verifyRevocationChain({
    capability: body,
    rootTarget,
    rootController,
    webvh,
    maxChainLength,
    maxDelegationTtl
  })
  return { capabilityBody: body, ...verified }
}

/**
 * The scope-agnostic revocation submission: validate the body capability and
 * verify its delegation chain (it must root in `rootTarget`), which yields the
 * chain's controllers for the dual-root invocation check, then -- only once the
 * invocation is authorized -- surface any 400 that validation found, reject a
 * chain containing an already-revoked link (resubmissions included) with the
 * 400 `CapabilityAlreadyRevokedError`, and store the record.
 *
 * NOTHING a client can observe is decided before the invocation verifies. The
 * body-shape and chain failures are captured rather than thrown, because a
 * caller without a verifying signature would otherwise read a 400 here against
 * an existing Space or keystore and the masked 404 against an absent one --
 * the same existence oracle the 404 masking exists to close. A capture also
 * loses the `chainControllers` the dual-root rule needs, so verification then
 * runs with an empty set: only the scope's own root can authorize such a
 * submission, which is exactly right, since the alternate root is controlled by
 * the chain that failed to verify. The store check runs after authorization for
 * the same reason (an unauthorized caller must not probe whether a capability
 * is revoked), and that ordering is what lets the store hit carry a problem
 * type of its own -- every other 400 (malformed body, root capability, id
 * mismatch, a chain that does not verify) stays `InvalidRevocationError`, so a
 * chain that fails to verify is never reported as revoked. The record expires
 * one day after the capability itself does (from then on the capability is
 * rejected on expiry alone; the margin covers clock-skew grace periods).
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies url, method, headers,
 *   logger, and `request.server` for serverUrl + storage
 * @param options.revocationId {string}   the URL's revocation id (the
 *   to-be-revoked capability's id, already URL-decoded by the router)
 * @param options.scope {RevocationScope}   the keystore or Space the record is
 *   stored under
 * @param options.rootTarget {string}   the scope's full URL (the required root
 *   of the revoked capability's chain, and one of the two accepted invocation
 *   roots)
 * @param options.rootController {IDID}   the scope's controller
 * @param options.expectedAction {string}   the action the invocation must
 *   carry (`write` on `/kms`, `POST` on the PWS route families)
 * @param options.requestName {string}   human-readable request name, used in
 *   error titles
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @returns {Promise<void>}
 */
async function submitRevocation({
  request,
  revocationId,
  scope,
  rootTarget,
  rootController,
  expectedAction,
  requestName,
  maxChainLength,
  maxDelegationTtl
}: {
  request: FastifyRequest
  revocationId: string
  scope: RevocationScope
  rootTarget: string
  rootController: IDID
  expectedAction: string
  requestName: string
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<void> {
  const { url, method, headers, body } = request
  const { serverUrl, storage, serverBackends } = request.server

  // Validate the body capability and verify its own delegation chain, holding
  // any failure back until the invocation has verified: a 400 raised here
  // would answer differently for an existing scope than for an absent one,
  // whose masked 404 was already thrown by the caller's `fetch*` (see the
  // note above). Structural only -- the revocation store is not consulted
  // until after authorization either. Only the 400 is held back; a
  // server-side fault met while verifying the chain surfaces as its 5xx.
  let validated:
    Awaited<ReturnType<typeof validateSubmittedCapability>> | undefined
  let validationError: InvalidRevocationError | undefined
  try {
    validated = await validateSubmittedCapability({
      body,
      revocationId,
      rootTarget,
      rootController,
      webvh: { storage, serverBackends, serverUrl },
      maxChainLength,
      maxDelegationTtl
    })
  } catch (err) {
    if (!(err instanceof InvalidRevocationError)) {
      throw err
    }
    validationError = err
  }

  await handleRevocationInvocationVerify({
    url,
    method,
    headers,
    serverUrl,
    rootTarget,
    rootController,
    webvh: { storage, serverBackends, serverUrl },
    // With no verified chain there are no chain controllers, so the
    // revocation URL's synthesized root is controlled by nobody and only the
    // scope's own root can authorize the submission.
    chainControllers: validated?.chainControllers ?? [],
    expectedAction,
    // The *invoking* chain is checked against the store as on every other
    // route -- a revoked capability cannot authorize a revocation -- and
    // against the annex-chain clause, as in `handleZcapVerify`.
    inspectCapabilityChain: composeChainInspectors([
      revocationChainInspector({ storage, scope }),
      clientAnnexChainInspector({ storage, serverBackends, serverUrl })
    ]),
    maxChainLength,
    maxDelegationTtl,
    requestName,
    logger: request.log
  })

  // The caller is authorized, so a 400 no longer discloses anything an
  // unauthorized prober could not already learn: surface whatever the body
  // and chain validation found.
  if (validationError !== undefined) {
    throw validationError
  }
  // `validated` is set whenever no error was captured.
  const { capabilityBody, delegator, capabilities } = validated!

  // NOW consult the store for the to-be-revoked chain. A chain containing an
  // already-revoked link (resubmissions
  // included) is the 400 `capability-already-revoked`; the 409 duplicate
  // stays reserved for a write race at the store. Running this after the
  // masked authorization keeps revocation state undisclosed to unauthorized
  // callers (they got the 404 above), which is what makes the distinct type
  // safe to emit: an authorized submitter could learn the same fact by
  // invoking the capability.
  if (await storage.isRevoked({ scope, capabilities })) {
    throw new CapabilityAlreadyRevokedError()
  }

  const record = revocationRecordFor({
    capability: capabilityBody as RevocationRecord['capability'],
    delegator,
    rootTarget
  })
  await storage.insertRevocation({ scope, record })
}

export class RevocationRequest {
  /**
   * POST /kms/keystores/:keystoreId/zcaps/revocations/:revocationId
   * Revoke a capability delegated from a keystore. Carries the unified `/kms`
   * delegation policy, and the webkms `write` action. Responds 204, no body; a
   * concurrent duplicate insert is the 409 `DuplicateRevocationError`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{
      Params: { keystoreId: string; revocationId: string }
      Body: Record<string, unknown>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Revoke Capability'
    const { keystoreId, revocationId } = request.params

    // 404-masks an unknown keystore before any verification work.
    const config = await fetchKeystore({ request, keystoreId, requestName })

    await submitRevocation({
      request,
      revocationId,
      scope: { keystoreId },
      rootTarget: config.id,
      rootController: config.controller,
      expectedAction: 'write',
      requestName,
      maxChainLength: KMS_MAX_CHAIN_LENGTH,
      maxDelegationTtl: KMS_MAX_DELEGATION_TTL
    })

    return reply.status(204).send()
  }

  /**
   * POST /space/:spaceId/zcaps/revocations/:revocationId
   * Revoke a capability delegated from a Space -- the WAS-route sibling of
   * `post`, scoped to the Space rather than a keystore. The revoked capability
   * is rejected from then on wherever a Space-rooted chain is verified: the
   * write/privileged routes (`fetchSpaceAndVerify`) and the capability leg of
   * the read routes (`authorize`). The invoked action is the HTTP verb, since
   * PWS capabilities are scoped by HTTP method. No delegation-policy caps
   * apply, matching the rest of the PWS route families.
   *
   * Responds 204, no body; a concurrent duplicate insert is the 409
   * `DuplicateRevocationError`.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async postSpace(
    request: FastifyRequest<{
      Params: { spaceId: string; revocationId: string }
      Body: Record<string, unknown>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Revoke Capability'
    const { spaceId, revocationId } = request.params
    const { serverUrl } = request.server

    // 404-masks an unknown Space before any verification work.
    const spaceMetadata = await fetchSpace({ request, spaceId, requestName })

    await submitRevocation({
      request,
      revocationId,
      scope: { spaceId },
      // The Space's root capability target is its canonical (trailing-slash)
      // container URL, the same root every space-family route accepts.
      rootTarget: absoluteSpaceUrl({ spaceId, serverUrl }),
      rootController: spaceMetadata.controller,
      expectedAction: capabilityActionOf({ method: request.method }),
      requestName
    })

    return reply.status(204).send()
  }
}
