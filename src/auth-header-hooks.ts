/**
 * Auth onRequest hooks: `requireAuthHeaders` (401 if Authorization /
 * Capability-Invocation are missing), `requireAuthHeadersOrPublicRead` (same,
 * but safe methods pass through unauthenticated), and `parseAuthHeaders`
 * (parses the auth headers into `request.zcap`). Every route group in
 * routes.js installs `parseAuthHeaders`. The `/kms` group installs
 * `requireAuthHeaders` ahead of it and the `/spaces/` repository group
 * `requireAuthHeadersOrPublicRead`. The groups beneath `/space/` install
 * neither: there a request with no auth headers is refused by its handler's
 * authorization, as the masked `not-found` (404).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  AuthHeaderParseError,
  MissingAuthError,
  MissingKeyIdError
} from './errors.js'
import { parseSignatureHeader } from '@interop/http-signature-header'
import {
  didOfMethodId,
  isValidController,
  parseSelfHostedWebvh,
  parseWebvhAddress
} from './lib/validateDid.js'
import type { IDID, ParsedZcap } from './types.js'
import type { VerifiedInvocation } from './zcap.js'

/**
 * Adds a request.zcap property, which contains the three parsed auth-related
 * request headers (`Authorization:`, `Capability-Invocation:`, and `Digest:`)
 *
 * Example Authorization header:
 *  Signature keyId="did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD#z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD",
 *    headers="(key-id) (created) (expires) (request-target) host capability-invocation content-type digest",
 *    signature="6GoRQ+rW69wBhNyERkafAXEZXZArezHvGRNUWC0HNI4Ss1xAiiMHdayS5aA2R6hLuYRNw6h9J9eCmQVMuHE1Bw==",
 *    created="1758150502",expires="1758151102"
 *
 * Example Capability-Invocation header:
 *  zcap id="urn:zcap:root:http%3A%2F%2Flocalhost%3A42957%2Fspaces%2F",action="POST"
 *
 * Example Digest header:
 *  mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA
 *
 * Example request.zcap object value from above headers:
 * {
 *   keyId: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD#z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD',
 *   headers: '(key-id) (created) (expires) (request-target) host capability-invocation content-type digest',
 *   signature: '0SXR+S2EiipdjzS9ahNyM9Zdfe2r3fZHJFTaYwK6HGq4dbWkJkiZkvg8DcvXUGxolF9AVc6LEtmbOfAGDAAVBg==',
 *   created: '1758151067',
 *   expires: '1758151667',
 *   invocation: 'zcap id="urn:zcap:root:http%3A%2F%2Flocalhost%3A40767%2Fspaces%2F",action="POST"',
 *   digest: 'mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA'
 * }
 *
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function parseAuthHeaders(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const { headers } = request

  // No Authorization header presented (e.g. an anonymous read that a fallback
  // policy may authorize). Leave `request.zcap` unset; the handler decides.
  if (!headers.authorization) {
    return
  }

  let keyId: string | undefined
  try {
    // { keyId, headers, signature, created, expires }
    const { params } = parseSignatureHeader(headers.authorization)
    keyId = params.keyId
    request.zcap = {
      ...params,
      invocation: headers['capability-invocation'],
      digest: headers.digest
    } as ParsedZcap
  } catch (err) {
    throw new AuthHeaderParseError({ cause: err as Error })
  }
  // Ensure keyId was parsed from the Authorization header
  if (!keyId) {
    throw new MissingKeyIdError()
  }
}

/**
 * The `createdBy` list a create records: the DIDs of the delegation chain the
 * creating invocation verified under. A root invocation lists the invoker
 * alone, the signing key's controller as the verifier matched it. Under a
 * delegated capability the list is the controller of each delegated
 * capability in the verified chain, in delegation order, so the last entry is
 * the invoker (the delegatee, whoever actually invoked). The root
 * capability's controller, the scope's own, is left out. Entries are kept as
 * they are otherwise, with no dedupe, so an intermediate delegatee that is
 * also the Space controller stays in.
 *
 * Every entry is read off the verified facts the authorization returned
 * (`invocation`). The `Authorization` and `Capability-Invocation` headers
 * are not consulted. Resolves to `undefined`, so the create records no
 * `createdBy`, in three cases. One is a request the provisioning policy
 * granted: a grant skips signature verification, and whatever the request
 * carries is then only the caller's claim. Another is a request with no
 * verified invocation passed. The last is an entry that fails to narrow to a
 * DID this server could have verified ({@link verifiableDidOf}). A controller
 * given as a list of one DID is read as that DID. A list of any other length
 * names no single delegatee, so it is an entry that fails to narrow. Callers
 * recording the list as server-managed provenance therefore treat it as
 * optional.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   the creating request
 * @param [options.invocation] {VerifiedInvocation}   the facts of the
 *   invocation the request verified, absent when none verified
 * @returns {IDID[] | undefined}
 */
export function createdByOf({
  request,
  invocation
}: {
  request: FastifyRequest
  invocation?: Pick<
    VerifiedInvocation,
    'rootInvocation' | 'invoker' | 'delegatedControllers'
  >
}): IDID[] | undefined {
  if (request.provisioningAuthorized || invocation === undefined) {
    return undefined
  }
  const entries = invocation.rootInvocation
    ? [invocation.invoker]
    : invocation.delegatedControllers
  if (entries.length === 0) {
    return undefined
  }
  return delegationChainDids({ entries, serverUrl: request.server.serverUrl })
}

/**
 * Narrows the controllers of a verified delegation chain to one DID each, in
 * the same order. A controller given as a list of one DID is read as that
 * DID. Resolves `undefined` when an entry names no single DID this server
 * could have verified ({@link verifiableDidOf}), such as a list of any other
 * length.
 *
 * @param options {object}
 * @param options.entries {Array<string | string[] | undefined>}   the
 *   controllers, in delegation order
 * @param options.serverUrl {string}   this server's base URL
 * @returns {IDID[] | undefined}
 */
export function delegationChainDids({
  entries,
  serverUrl
}: {
  entries: Array<string | string[] | undefined>
  serverUrl: string
}): IDID[] | undefined {
  const chain: IDID[] = []
  for (const entry of entries) {
    const controller =
      Array.isArray(entry) && entry.length === 1 ? entry[0] : entry
    const did =
      typeof controller === 'string'
        ? verifiableDidOf({ id: controller, serverUrl })
        : undefined
    if (did === undefined) {
      return undefined
    }
    chain.push(did)
  }
  return chain
}

/**
 * The DID a verification method id (or a bare DID) names, when it is one this
 * server could have verified, and `undefined` otherwise. That is a
 * syntactically valid `did:key` or a `did:webvh` address. The `did:webvh` may
 * be a self-hosted one (the second accepted controller shape, recognized here
 * so `createdBy` provenance keeps being recorded once a Space is promoted to
 * one). It may be a replicated one whose log a replica registration copies
 * here, so a wallet's creates on a replica under its origin-hosted DID keep
 * their provenance. It may also be a foreign one invoking a delegated
 * capability, whose log was fetched. The check is syntactic, as it is for a
 * `did:key`: whether the key verified was decided by the authorization that
 * ran before.
 *
 * @param options {object}
 * @param options.id {string}   a verification method id or a DID
 * @param options.serverUrl {string}   this server's base URL
 * @returns {IDID | undefined}
 */
export function verifiableDidOf({
  id,
  serverUrl
}: {
  id: string
  serverUrl: string
}): IDID | undefined {
  const did = didOfMethodId(id)
  if (isValidController(did)) {
    return did
  }
  if (
    parseSelfHostedWebvh(did, { serverUrl }) !== undefined ||
    parseWebvhAddress(did) !== undefined
  ) {
    return did as IDID
  }
  return undefined
}

/**
 * True when the request presents both auth-related headers a capability
 * invocation needs (`Authorization` and `Capability-Invocation`). The presence
 * test the hooks below gate on. Presence only -- neither header is parsed or
 * verified here. It is the one definition of that test: the hooks, the policy
 * fallback and `assertInvocationPresent` in `zcap.ts` all read it.
 *
 * @param request {Pick<import('fastify').FastifyRequest, 'headers'>}
 * @returns {boolean}
 */
export function hasAuthHeaders(
  request: Pick<FastifyRequest, 'headers'>
): boolean {
  const { headers } = request
  return Boolean(headers.authorization && headers['capability-invocation'])
}

/**
 * True for the safe (read) HTTP methods, `GET` and `HEAD`: the ones an
 * anonymous request may make, and the ones an access-control policy grants as
 * a `read`.
 *
 * @param method {string}   the request method
 * @returns {boolean}
 */
export function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

/**
 * onRequest hook that enforces presence of the auth-related headers. Throws
 * MissingAuthError (401) when `Authorization` or `Capability-Invocation` is
 * absent. For route groups where every operation, reads included, is
 * privileged: the WebKMS `/kms` group uses it (every webkms route is
 * zcap-invoked; the protocol has no public reads). No PWS group qualifies --
 * even the SpacesRepository group lets anonymous List Spaces reads through,
 * answered with the spec's empty-items 200.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function requireAuthHeaders(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  if (!hasAuthHeaders(request)) {
    throw new MissingAuthError()
  }
}

/**
 * Like `requireAuthHeaders`, but lets safe (read) methods through without auth
 * so the handler can decide what an anonymous read sees: for List Spaces, the
 * empty-items 200. Unsafe methods (Create Space) still require auth, answered
 * `missing-authorization` (401), since the repository's existence is not
 * sensitive. Used by the SpacesRepository group alone.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function requireAuthHeadersOrPublicRead(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  if (hasAuthHeaders(request)) {
    return
  }
  // Safe methods may proceed unauthenticated; authorize() decides via policy.
  if (isSafeMethod(request.method)) {
    return
  }
  throw new MissingAuthError()
}
