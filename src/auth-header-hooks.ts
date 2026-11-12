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
 * The DID of the party that signed this request's capability invocation, taken
 * from the parsed `keyId` with its verification-method fragment stripped
 * (`did:key:z6Mk...#z6Mk...` to `did:key:z6Mk...`). Under a delegated
 * capability this is the delegatee -- whoever actually invoked -- not the Space
 * controller.
 *
 * Resolves to `undefined` when the request carries no parsed invocation (an
 * anonymous read of a public Resource, or a provisioning-token request). It
 * does so too when the provisioning policy granted the request. A grant skips
 * signature verification, and a `keyId` parsed before the grant was decided
 * (Create Space by Id, when the policy is consulted late) is then only the
 * caller's claim. It also resolves to `undefined` when the stripped `keyId` is
 * neither a syntactically valid `did:key` nor a `did:webvh` this server could
 * have verified. That is a self-hosted one (the second accepted controller
 * shape -- recognized here so `createdBy` provenance keeps being recorded once
 * a Space is promoted to one), a
 * replicated one whose log a replica registration copies here (so a wallet's
 * creates on a replica under its origin-hosted DID keep their provenance), or
 * a foreign one invoking a delegated capability, whose log was fetched. The
 * check is syntactic, as it is for a `did:key`: whether the key verified was
 * decided by the authorization that ran before. Callers recording
 * it as server-managed provenance therefore treat it as optional, and never
 * persist a value that failed to narrow to a DID.
 *
 * @param request {import('fastify').FastifyRequest}
 * @returns {IDID | undefined}
 */
export function invokerDid(request: FastifyRequest): IDID | undefined {
  if (request.provisioningAuthorized) {
    return undefined
  }
  const keyId = request.zcap?.keyId
  const did = keyId === undefined ? undefined : didOfMethodId(keyId)
  if (isValidController(did)) {
    return did
  }
  const { serverUrl } = request.server
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
