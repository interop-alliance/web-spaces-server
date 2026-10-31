/**
 * Validation for the `controller` DID supplied in Space Description request
 * bodies. Two controller shapes are accepted, and only one of them everywhere:
 *
 * - An Ed25519 `did:key`, whose multibase encoding always begins `z6Mk` (the
 *   `0xed01` Ed25519-pub multicodec prefix) followed by base58btc characters.
 *   This is the only shape Space create, and the keystore routes, accept.
 * - Additionally, on Update Space only: a `did:webvh` whose history log this
 *   server stores, of the form
 *   `did:webvh:<scid>:<didDomainComponent>:space:<spaceId>:<collectionId>`.
 *   Its host is either this server ({@link parseSelfHostedWebvh}), with the
 *   log at `<spaceId>/<collectionId>/did.jsonl`, or a replication peer
 *   ({@link parsePeerHostedWebvh}), with the log read from the local replica
 *   of that peer Space (`lib/webvhLogLocation.ts`). Either way it resolves
 *   from local storage and never over the network. A `did:web`, and every
 *   other DID method, stay refused as controllers.
 *
 * A third parser, {@link parseCrossHostWebvh}, recognizes any `did:webvh` on
 * another host. It is never a controller shape. The capability verifier uses
 * it to decide whether a delegated invocation's signer is a foreign DID whose
 * log it may fetch.
 *
 * All are syntactic checks at the request layer, so a malformed or
 * unsupported controller is rejected on the way in, rather than being stored
 * and only failing later at capability-verification time. Whether a
 * syntactically accepted `did:webvh` actually *resolves* is a separate,
 * storage-reading check (`lib/webvhController.ts`), which Update Space and
 * Update Keystore both run before storing a `did:webvh` controller.
 */
import { getFileUrl } from '@interop/did-method-webvh'
import { InvalidControllerError } from '../errors.js'
import { isUrlSafeSegment } from './validateId.js'
import type { IDID } from '../types.js'

// An Ed25519 `did:key` is `did:key:` + `z6Mk` + a base58btc payload. The
// base58btc (Bitcoin) alphabet omits `0`, `O`, `I`, and `l`.
const DID_KEY_ED25519_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/

/**
 * A did:webvh SCID is a base58btc-encoded multihash of the first log entry.
 * Shape-checked only (the resolver re-derives and pins it against the log).
 */
const SCID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{16,}$/

/**
 * The method-specific path a self-hosted controller DID must carry: the log is
 * published as `did.jsonl` in a Collection of the Space named by the DID, i.e.
 * `<host>/space/<spaceId>/<collectionId>/did.jsonl`.
 */
const WEBVH_SPACE_SEGMENT = 'space'

/** The Resource holding a self-hosted DID's history log. */
export const WEBVH_LOG_RESOURCE_ID = 'did.jsonl'

/**
 * A parsed `did:webvh` address: its SCID, its host, its path segments, and
 * the URL its history log is published at.
 */
type WebvhAddress = {
  scid: string
  host: string
  path: string[]
  logUrl: string
}

/**
 * The DID a verification method id belongs to: the part before its `#`
 * fragment, or the whole id when it carries none.
 * @param id {string}   a method id (`did#fragment`) or a bare DID
 * @returns {string}
 */
export function didOfMethodId(id: string): string {
  return id.split('#')[0]!
}

/**
 * Returns true when `value` is a syntactically valid Ed25519 `did:key` DID.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isValidController(value: unknown): value is IDID {
  return typeof value === 'string' && DID_KEY_ED25519_PATTERN.test(value)
}

/**
 * Parses a `did:webvh` whose log lives in a PWS Collection on some host,
 * without regard to which host, or returns `undefined` when `value` is not
 * one.
 *
 * The accepted form is exactly
 * `did:webvh:<scid>:<didDomainComponent>:space:<spaceId>:<collectionId>`, where
 * the `didDomainComponent` is the DID-method encoding of a host (a port is
 * percent-encoded as `%3A`, since `:` is the method's own separator) and must
 * decode to a URL host, in lower case. Nothing else -- no extra path segments,
 * no other DID method -- parses. The log is read from
 * `<spaceId>/<collectionId>/did.jsonl` on that host.
 *
 * The `collectionId` may be any Collection whose name round-trips the DID path
 * encoding. PWS Collection ids are restricted to the RFC 3986 unreserved
 * charset ({@link isUrlSafeSegment}), and unreserved characters are never
 * percent-encoded, so that encoding is the identity and the round-trip rule
 * collapses to the same check: a segment carrying `%` or any other reserved
 * character fails the pattern and is refused here.
 *
 * @param value {unknown}   the candidate DID
 * @returns {{ scid: string, host: string, spaceId: string,
 *   collectionId: string } | undefined}   `host` is the decoded host, port
 *   included when the DID carries one
 */
export function parseWebvhSpacePath(
  value: unknown
):
  | { scid: string; host: string; spaceId: string; collectionId: string }
  | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  // `did`, `webvh`, scid, didDomainComponent, `space`, spaceId, collectionId.
  const segments = value.split(':')
  if (segments.length !== 7) {
    return undefined
  }
  const [
    scheme,
    method,
    scid,
    didDomainComponent,
    spaceSegment,
    spaceId,
    collectionId
  ] = segments as [string, string, string, string, string, string, string]
  if (scheme !== 'did' || method !== 'webvh') {
    return undefined
  }
  if (spaceSegment !== WEBVH_SPACE_SEGMENT) {
    return undefined
  }
  if (!SCID_PATTERN.test(scid)) {
    return undefined
  }
  // Both ids land in a storage path, so they get the same URL-safe-segment
  // check every id parsed off a request URL gets (path-traversal defense).
  // For the collectionId this doubles as the round-trip rule described above.
  if (!isUrlSafeSegment(spaceId) || !isUrlSafeSegment(collectionId)) {
    return undefined
  }
  let host: string
  try {
    host = decodeURIComponent(didDomainComponent).toLowerCase()
  } catch {
    // A malformed percent-escape in the domain component.
    return undefined
  }
  // The decoded component must be a whole URL host and nothing more: no
  // userinfo, path or query smuggled in through the encoding.
  let parsed: URL
  try {
    parsed = new URL(`https://${host}`)
  } catch {
    return undefined
  }
  if (parsed.host !== host) {
    return undefined
  }
  return { scid, host, spaceId, collectionId }
}

/**
 * Parses a self-hosted `did:webvh` controller into the three parts the resolver
 * needs, or returns `undefined` when `value` is not one: the shape
 * {@link parseWebvhSpacePath} accepts, whose host decodes to this server's
 * own host. A cross-host domain does not parse.
 *
 * @param value {unknown}   the candidate controller DID
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {{ scid: string, spaceId: string, collectionId: string } |
 *   undefined}
 */
export function parseSelfHostedWebvh(
  value: unknown,
  { serverUrl }: { serverUrl: string }
): { scid: string; spaceId: string; collectionId: string } | undefined {
  const parsed = parseWebvhSpacePath(value)
  if (
    parsed === undefined ||
    parsed.host !== new URL(serverUrl).host.toLowerCase()
  ) {
    return undefined
  }
  const { scid, spaceId, collectionId } = parsed
  return { scid, spaceId, collectionId }
}

/**
 * A DNS host name of two or more labels, in lower case, with no port. Each
 * label is letters, digits and inner hyphens. The last label must start with a
 * letter, so an IPv4 literal does not match. A `%` cannot occur, so the
 * percent-encoded port (`%3A`) a `did:webvh` domain component can carry is
 * refused.
 */
const CROSS_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Whether `host` is a host name a cross-host `did:webvh` may name: a DNS name
 * in lower case, with no port, at most 253 characters long.
 * @param host {string}
 * @returns {boolean}
 */
export function isCrossHostName(host: string): boolean {
  return host.length <= 253 && CROSS_HOST_PATTERN.test(host)
}

/**
 * Whether `host` names this server, with or without its port.
 * @param options {object}
 * @param options.host {string}   a lower-case host name
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
function isOwnHost({
  host,
  serverUrl
}: {
  host: string
  serverUrl: string
}): boolean {
  const ownUrl = new URL(serverUrl)
  return (
    host === ownUrl.hostname.toLowerCase() || host === ownUrl.host.toLowerCase()
  )
}

/**
 * Parses any `did:webvh` on a host, without regard to which server reads it,
 * or returns `undefined` when `value` is not one. The accepted form is
 * `did:webvh:<scid>:<host>` or `did:webvh:<scid>:<host>:<segment>...`, where
 * `<host>` is a DNS name in lower case with no port ({@link isCrossHostName}),
 * and every path segment is a URL-safe segment (the RFC 3986 unreserved
 * charset, as {@link isUrlSafeSegment} checks), so nothing needs encoding
 * when the segments become the log URL's path.
 *
 * The log URL is the did:webvh method's own mapping (`getFileUrl` of
 * `@interop/did-method-webvh`): `https://<host>/<segments>/did.jsonl`, or
 * `https://<host>/.well-known/did.jsonl` for the host-only form.
 *
 * @param value {unknown}   the candidate DID
 * @returns {{ scid: string, host: string, path: string[], logUrl: string } |
 *   undefined}
 */
export function parseWebvhAddress(value: unknown): WebvhAddress | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  // `did`, `webvh`, scid, host, then the path segments, if any.
  const segments = value.split(':')
  if (segments.length < 4) {
    return undefined
  }
  const [scheme, method, scid, host] = segments as [
    string,
    string,
    string,
    string
  ]
  if (scheme !== 'did' || method !== 'webvh') {
    return undefined
  }
  if (!SCID_PATTERN.test(scid) || !isCrossHostName(host)) {
    return undefined
  }
  const path = segments.slice(4)
  if (!path.every(segment => isUrlSafeSegment(segment))) {
    return undefined
  }
  // The method's mapping of a DID this parser admitted. Restated as a check,
  // so a change in that mapping cannot send a fetch to another host.
  let logUrl: string
  let parsed: URL
  try {
    logUrl = getFileUrl(value)
    parsed = new URL(logUrl)
  } catch {
    return undefined
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.host !== host ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return undefined
  }
  return { scid, host, path, logUrl }
}

/**
 * Parses a `did:webvh` on another host than this server's, or returns
 * `undefined` when `value` is not one. Any path is accepted, and the
 * host-only form too ({@link parseWebvhAddress}). A DID on this server's host
 * resolves through the local resolver ({@link parseSelfHostedWebvh}).
 *
 * This shape alone grants nothing. The capability verifier fetches such a
 * DID's log only for the invoker of a delegated capability whose chain it
 * already verified to the Space controller, and only when the log is not
 * stored here ({@link parsePeerHostedWebvh}).
 *
 * @param value {unknown}   the candidate DID
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {{ scid: string, host: string, path: string[], logUrl: string } |
 *   undefined}
 */
export function parseCrossHostWebvh(
  value: unknown,
  { serverUrl }: { serverUrl: string }
): WebvhAddress | undefined {
  const parsed = parseWebvhAddress(value)
  if (parsed === undefined || isOwnHost({ host: parsed.host, serverUrl })) {
    return undefined
  }
  return parsed
}

/**
 * Parses a `did:webvh` hosted in a Space of another server, of the form
 * `did:webvh:<scid>:<host>:space:<spaceId>:<collectionId>`, or returns
 * `undefined` when `value` is not one. `<host>` is a DNS name with no port,
 * and not this server's host. The result names the peer Space's canonical URL,
 * `https://<host>/space/<spaceId>/`, which a replica registration names as
 * its `fromSpace` when this server holds a copy of that Space.
 *
 * This shape alone resolves nothing. `lib/webvhLogLocation.ts` maps it to a
 * local Space through the replica registrations.
 *
 * @param value {unknown}   the candidate DID
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {{ scid: string, host: string, spaceId: string,
 *   collectionId: string, fromSpace: string } | undefined}
 */
export function parsePeerHostedWebvh(
  value: unknown,
  { serverUrl }: { serverUrl: string }
):
  | {
      scid: string
      host: string
      spaceId: string
      collectionId: string
      fromSpace: string
    }
  | undefined {
  const parsed = parseCrossHostWebvh(value, { serverUrl })
  if (parsed === undefined || parsed.path.length !== 3) {
    return undefined
  }
  const [spaceSegment, spaceId, collectionId] = parsed.path as [
    string,
    string,
    string
  ]
  if (spaceSegment !== WEBVH_SPACE_SEGMENT) {
    return undefined
  }
  return {
    scid: parsed.scid,
    host: parsed.host,
    spaceId,
    collectionId,
    fromSpace: `https://${parsed.host}/${WEBVH_SPACE_SEGMENT}/${spaceId}/`
  }
}

/**
 * Returns true when `value` is a syntactically valid `did:webvh` controller
 * shape: one anchored in a Space on *this* server
 * ({@link parseSelfHostedWebvh}), or in a Space on another server that a
 * replica registration may copy here ({@link parsePeerHostedWebvh}). The
 * second shape resolves only through a registration, which the caller's
 * resolvability check (`resolveWebvhController`) reads.
 * @param value {unknown}
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
export function isWebvhControllerShape(
  value: unknown,
  { serverUrl }: { serverUrl: string }
): value is IDID {
  return (
    parseSelfHostedWebvh(value, { serverUrl }) !== undefined ||
    parsePeerHostedWebvh(value, { serverUrl }) !== undefined
  )
}

/**
 * Asserts that `controller` is a valid Ed25519 `did:key`, throwing
 * InvalidControllerError (400) otherwise.
 * @param controller {unknown}   the `controller` value from the request body
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidController(
  controller: unknown,
  { requestName }: { requestName?: string } = {}
): void {
  if (!isValidController(controller)) {
    throw new InvalidControllerError({ requestName })
  }
}

/**
 * Asserts that `controller` is a controller shape a Space (or a keystore) may
 * be *updated* to, or listed by: an Ed25519 `did:key`, or a `did:webvh`
 * controller shape ({@link isWebvhControllerShape}). The sibling of
 * {@link assertValidController}, kept separate so the create paths stay
 * `did:key`-only by construction rather than by a flag.
 *
 * The check is syntactic only. The two update paths, Update Space and Update
 * Keystore, each follow it with the resolvability check in
 * `lib/webvhController.ts` before storing a `did:webvh` controller.
 *
 * @param controller {unknown}   the `controller` value from the request body
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidSpaceController(
  controller: unknown,
  { serverUrl, requestName }: { serverUrl: string; requestName?: string }
): void {
  if (
    !isValidController(controller) &&
    !isWebvhControllerShape(controller, { serverUrl })
  ) {
    throw new InvalidControllerError({ requestName, allowWebvh: true })
  }
}
