/**
 * ZCap verification: handleZcapVerify() checks the capability-invocation
 * signature against the Space controller's Ed25519 key, synthesizing the root
 * capability via the document loader. Also home to the zcap *revocation*
 * verification pair, shared by the `/kms` and PWS route families:
 * verifyRevocationChain() validates a to-be-revoked capability's delegation
 * chain, and handleRevocationInvocationVerify() authorizes the submission
 * under the dual-root rule (the scope's root -- a keystore or a Space -- or
 * the revocation URL's own root controlled by any chain participant --
 * ezcap-express's `authorizeZcapRevocation` convention).
 *
 * A Space's controller is normally a `did:key`, resolved by the did:key driver.
 * On a Space promoted to a self-hosted `did:webvh` controller, both the
 * signature keyId and the jsigs purpose check resolve instead through
 * `lib/webvhController.ts`, which verifies the DID's history log out of local
 * storage. The log's location comes from the DID string itself, so it may live
 * in a Collection of a Space other than the one being invoked on. That branch
 * is engaged per verification (never module-global), on every verification
 * the request layer supplies a resolver context to, since a delegated link may
 * be signed by a `did:webvh` method on a `did:key`-controlled Space.
 *
 * A `did:webvh` on a replication peer's host whose log a replica
 * registration copies here resolves from that copy, through the same local
 * resolver (`lib/webvhLogLocation.ts`).
 *
 * A foreign `did:webvh` with no stored log -- a peer server's own DID, or a
 * service's or agent's DID on any host, under any path -- is resolved over
 * the network, as the invoker of a delegated capability on the PWS routes.
 * The HTTP-signature verifier resolves the invoker's key before it reads the
 * capability, so `handleZcapVerify` first verifies the embedded delegation
 * chain without that key ({@link peerInvokerGrant}). Only a chain that
 * verifies to the Space controller, and whose invoked capability names the
 * DID as its controller, lets the verification that follows fetch that one
 * DID's log (`lib/peerWebvh.ts`), and only when the operator's blocklist does
 * not name the DID or its host.
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyRequest } from 'fastify'
import {
  createDefaultDidResolver,
  securityLoader
} from '@interop/security-document-loader'
import type { LruCache } from '@interop/lru-memoize'
import { backendScoped } from './lib/backendCache.js'
import {
  decodeEmbeddedCapability,
  verifyCapabilityInvocation,
  type VerifyCapabilityInvocationResult
} from '@interop/http-signature-zcap-verify'
import { parseSignatureHeader } from '@interop/http-signature-header'
import jsigs from '@interop/jsonld-signatures'
import {
  CapabilityDelegation,
  // Aliased: the server's own `CapabilityExpiredError` (the problem+json
  // error) is the one this module throws; the library's is the cause it
  // recognizes by name.
  CapabilityExpiredError as ZcapCapabilityExpiredError,
  type InspectCapabilityChain
} from '@interop/zcap'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { createVerifyCryptosuite } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { DataIntegrityProof } from '@interop/data-integrity-proof'
import * as didKey from '@interop/did-method-key'
import type { IDocumentLoader, IPublicKey } from '@interop/data-integrity-core'
import {
  AuthVerificationError,
  CapabilityExpiredError,
  CapabilityRevokedError,
  InvalidRevocationError,
  ProblemError,
  UnauthorizedError,
  isServerFault
} from './errors.js'
import { hasAuthHeaders } from './auth-header-hooks.js'
import {
  CAPABILITY_REVOKED_ERROR_NAME,
  capabilitySummaries,
  revocationChainInspector
} from './lib/revocations.js'
import { capabilityControllers } from './lib/chainCapability.js'
import {
  clientAnnexChainInspector,
  composeChainInspectors
} from './lib/clientAnnexClause.js'
import { isPlainObject } from './lib/isPlainObject.js'
import { absoluteUrl } from './lib/paths.js'
import { didOfMethodId } from './lib/validateDid.js'
import {
  findVerificationMethod,
  resolveWebvhController,
  webvhDidResolverDriver,
  type WebvhResolverContext
} from './lib/webvhController.js'
import type { PeerWebvhResolver } from './lib/peerWebvh.js'
import { locateWebvhLog } from './lib/webvhLogLocation.js'
import {
  containerRuleInspector,
  type ContainerRule
} from './lib/containerRule.js'
import type {
  CapabilitySummary,
  IDID,
  IVerificationMethod,
  RevocationScope,
  StorageBackend
} from './types.js'

const didKeyDriver = didKey.driver()
didKeyDriver.use({
  multibaseMultikeyHeader: 'z6Mk',
  fromMultibase: Ed25519VerificationKey.from
})

/**
 * `jsonld-document-loader`'s `clone()` -- a copy of the loader carrying the
 * same static documents and protocol handlers, so the copy can be configured
 * without touching the original. It is not part of the loader type
 * `@interop/security-document-loader` publishes, so it is restated here.
 */
type CloneableLoader = ReturnType<typeof securityLoader> & {
  clone: () => CloneableLoader
}

/**
 * The shared base document loader, built once: `securityLoader()` registers
 * (and `structuredClone`s) the whole security context set on every call, which
 * is per-verification work that never varies. Every verification takes a
 * `clone()` of this loader and configures that instead, so nothing
 * request-specific -- the `urn` root-capability handler, a `did:webvh`-backed
 * DID resolver -- is ever set on this instance and no state can leak from one
 * request to the next. Its `did` protocol handler is the security loader's own
 * default resolver, a single cached did:key / did:web resolver reused across
 * requests (the no-`did:webvh` path).
 */
const baseDocumentLoader = securityLoader() as CloneableLoader

/**
 * The signature suites a delegation proof may be signed with, newest first.
 *
 * Clients sign delegation proofs with `eddsa-jcs-2022`, which canonicalizes as
 * plain JSON and so costs no JSON-LD canonicalization. `Ed25519Signature2020`
 * (URDNA2015) stays accepted because the server is the one party every client
 * meets and clients upgrade on their own schedule, and because stored grants
 * -- the capabilities a wallet records on a login activity and later submits
 * for revocation -- were minted under it. It leaves the verify side once no
 * deployed client still signs with it and no stored grant still needs
 * re-verifying; a follow-up item carries the removal.
 *
 * The two never collide: `DataIntegrityProof.matchProof` keys on `proof.type`
 * and `proof.cryptosuite`, so each suite in the array sees only its own proofs.
 * Both `jsigs.verify` and `verifyCapabilityInvocation` take an array here, as
 * does `CapabilityDelegation`'s `suite` option.
 *
 * @returns {[Ed25519Signature2020, DataIntegrityProof]}   a fresh instance of
 *   each accepted suite (suites are stateful during verification, so callers
 *   get their own pair rather than a shared one)
 */
function delegationProofSuites(): [Ed25519Signature2020, DataIntegrityProof] {
  return [
    new Ed25519Signature2020(),
    new DataIntegrityProof({ cryptosuite: createVerifyCryptosuite() })
  ]
}

/**
 * The Data Integrity cryptosuite names of the delegation-proof suites this
 * server verifies, as the `zcapCryptosuites` of the service description's
 * authorization profile entry advertises them. Read off
 * {@link delegationProofSuites}, so adding or dropping a Data Integrity suite
 * there changes the advertisement with it. Only a suite that carries a
 * `cryptosuite` name is listed. The legacy `Ed25519Signature2020` proof type
 * has none, so it is still accepted but not advertised.
 * @returns {string[]}
 */
export function delegationProofCryptosuites(): string[] {
  return delegationProofSuites()
    .map(suite => (suite as unknown as { cryptosuite?: unknown }).cryptosuite)
    .filter(name => typeof name === 'string')
}

/**
 * The prefix of every root capability id.
 */
export const ROOT_PREFIX = 'urn:zcap:root:'

/**
 * The root capability id convention: `urn:zcap:root:` + the url-encoded
 * invocation target (shared by PWS and webkms).
 * @param target {string}   the root invocation target (full URL)
 * @returns {string}
 */
export function rootCapabilityId(target: string): string {
  return `${ROOT_PREFIX}${encodeURIComponent(target)}`
}

/**
 * The invocation target a root capability id names: the id with its
 * {@link ROOT_PREFIX} removed, url-decoded. The inverse of
 * {@link rootCapabilityId}.
 * @param id {string}   a root capability id
 * @returns {string | undefined}   `undefined` when `id` is not a root
 *   capability id
 * @throws {URIError}   when the encoded target is not a valid escape sequence
 */
export function rootTargetOf(id: string): string | undefined {
  if (!id.startsWith(ROOT_PREFIX)) {
    return undefined
  }
  return decodeURIComponent(id.slice(ROOT_PREFIX.length))
}

/**
 * Builds a document loader whose `urn` protocol handler synthesizes
 * `urn:zcap:root:<target>` capabilities on demand, with the controller chosen
 * per target. The zcap library only dereferences a root capability it already
 * expects (per `expectedRootCapability`), so `controllerFor` sees expected
 * targets only -- it may still throw to refuse one outright.
 *
 * The loader is a clone of the shared `baseDocumentLoader`, so this handler and
 * the `did:webvh` resolver below are set on the clone alone and cannot outlive
 * the verification.
 *
 * When a `did:webvh` context is supplied, the loader's DID resolver also serves
 * the locally resolved controller document (and its verification-method
 * fragments), which is what lets the jsigs purpose check confirm the signing
 * method is listed under the document's `capabilityInvocation` /
 * `capabilityDelegation`.
 *
 * @param options {object}
 * @param options.controllerFor {(target: string) => IDID | string[]}   maps a
 *   decoded root invocation target to the controller(s) of its synthesized
 *   root capability
 * @param [options.webvh] {WebvhResolverContext}   engage the local `did:webvh`
 *   resolver for this verification
 * @returns {IDocumentLoader}
 */
function rootCapabilityLoader({
  controllerFor,
  webvh
}: {
  controllerFor: (target: string) => IDID | string[]
  webvh?: WebvhResolverContext
}): IDocumentLoader {
  const loader = baseDocumentLoader.clone()
  if (webvh) {
    loader.setDidResolver(didResolverWithWebvh(webvh))
  }
  loader.setProtocolHandler({
    protocol: 'urn',
    handler: {
      get: async ({ id, url }: { id: string; url?: string }) => {
        const resolvedUrl = url || id
        const rootZcapTarget = decodeURIComponent(
          resolvedUrl.split(ROOT_PREFIX)[1]!
        )
        return {
          '@context': 'https://w3id.org/zcap/v1',
          id: resolvedUrl,
          invocationTarget: rootZcapTarget,
          controller: controllerFor(rootZcapTarget)
        }
      }
    }
  })
  return loader.build()
}

/**
 * A pass-through stand-in for `CachedResolver`'s own internal memoization
 * (its `{ memoize }` cache extension point), installed on every resolver
 * {@link didResolverWithWebvh} builds. `createDefaultDidResolver()` returns a
 * `CachedResolver` with its own ~5s TTL cache of resolved documents; sharing
 * one resolver instance across verifications (rather than building a fresh,
 * cold one each time) would otherwise let that cache serve a document
 * `invalidateResolvedWebvhDid` already dropped, since it has no way to hear
 * about that invalidation. Document caching happens in exactly one place
 * instead: `lib/webvhController.ts`'s own invalidation-aware cache for
 * `did:webvh`, and no cache at all for `did:key` (deriving one is pure
 * computation, no I/O) or `did:web` (an external fetch this server does not
 * otherwise memoize). What the shared resolver instance actually saves is the
 * driver-registration setup, not resolution caching.
 * @param options {object}
 * @param options.fn {() => Promise<unknown>}
 * @returns {Promise<unknown>}
 */
async function bypassMemoize<T>({ fn }: { fn: () => Promise<T> }): Promise<T> {
  return await fn()
}

/**
 * One did:key + did:web + did:webvh resolver per storage backend and base URL,
 * scoped to the backend via the same factory as the Space Metadata cache and
 * did:webvh document caches (two backends in one process never share a
 * resolver, and the resolvers go with their backend), and within a backend
 * keyed by `serverUrl`, because the local `did:webvh` driver closes over the
 * base URL its DIDs must be anchored at. Built once rather than per
 * verification, since `createDefaultDidResolver()` is otherwise the same fixed
 * driver set on every call; see {@link bypassMemoize} for why its own result
 * cache is disabled rather than reused.
 */
const didResolvers = backendScoped(
  () => new Map<string, ReturnType<typeof createDefaultDidResolver>>()
)

/**
 * Returns the (lazily built, cached) DID resolver extended with the local
 * `did:webvh` driver for a request's storage backend and base URL. See
 * {@link didResolvers}.
 *
 * @param webvh {WebvhResolverContext}
 * @returns {ReturnType<typeof createDefaultDidResolver>}
 */
function didResolverWithWebvh(webvh: WebvhResolverContext) {
  // A peer grant belongs to one verification. The cached resolver's driver
  // closes over the context it was built with, so a grant gets a resolver of
  // its own and is never cached.
  if (webvh.peer !== undefined) {
    return buildDidResolver(webvh)
  }
  const byServerUrl = didResolvers.for(webvh.storage)
  let didResolver = byServerUrl.get(webvh.serverUrl)
  if (!didResolver) {
    didResolver = buildDidResolver(webvh)
    byServerUrl.set(webvh.serverUrl, didResolver)
  }
  return didResolver
}

/**
 * Builds a did:key + did:web resolver extended with the local `did:webvh`
 * driver over `webvh`. See {@link didResolverWithWebvh}.
 *
 * @param webvh {WebvhResolverContext}
 * @returns {ReturnType<typeof createDefaultDidResolver>}
 */
function buildDidResolver(webvh: WebvhResolverContext) {
  const didResolver = createDefaultDidResolver({
    cache: { memoize: bypassMemoize as LruCache['memoize'] }
  })
  // The local driver is the did-io `{ method, get }` shape, minus the key
  // *generation* half of the interface (this server only ever resolves).
  didResolver.use(
    webvhDidResolverDriver(webvh) as unknown as Parameters<
      typeof didResolver.use
    >[0]
  )
  return didResolver
}

/**
 * Resolves a `did:webvh` invocation keyId to a verifier, out of the locally
 * resolved (and log-verified) controller document. The returned
 * verificationMethod's `controller` is the bare `did:webvh` string, which is
 * what makes `@interop/zcap`'s string-compare `isController` match the promoted
 * Space's stored controller.
 *
 * @param options {object}
 * @param options.webvh {WebvhResolverContext}
 * @param options.keyId {string}   the `<did:webvh>#<fragment>` method URL
 * @returns {Promise<{ verifier: object, verificationMethod: IVerificationMethod }>}
 */
async function webvhVerifier({
  webvh,
  keyId
}: {
  webvh: WebvhResolverContext
  keyId: string
}) {
  const did = didOfMethodId(keyId)
  // A peer DID's resolver may fetch its log once more when the cached
  // document lacks the key; a local log is re-read on every write instead.
  const doc = await resolveWebvhController({ ...webvh, did, keyId })
  const method = findVerificationMethod({ doc, id: keyId })
  if (!method?.publicKeyMultibase) {
    throw new Error(
      `Verification method "${keyId}" is not in the current DID document.`
    )
  }
  // The resolved methods are `Multikey`; restate them in the suite's own shape
  // (the same fields, and `Ed25519VerificationKey.from` accepts either) so the
  // key material and the controller string are both explicit here.
  const verificationMethod = {
    id: keyId,
    type: 'Ed25519VerificationKey2020',
    controller: did,
    publicKeyMultibase: method.publicKeyMultibase
  }
  const key = await Ed25519VerificationKey.from(
    verificationMethod as IPublicKey
  )
  return {
    verifier: key.verifier(),
    verificationMethod: verificationMethod as IVerificationMethod
  }
}

/**
 * The signature algorithms an invocation's HTTP signature may use, by their
 * JSON Web Algorithms identifiers, as the `signatureAlgorithms` of the service
 * description's authorization profile entry advertises them. Every verifier
 * {@link createGetVerifier} builds is an `Ed25519VerificationKey` verifier,
 * whose algorithm JWA names `EdDSA`; a new key type there adds its name here.
 */
export const INVOCATION_SIGNATURE_ALGORITHMS = ['EdDSA']

/**
 * Builds the `verifyCapabilityInvocation` HTTP-signature key hook: resolves an
 * invocation's keyId to an Ed25519 verifier. `did:key` keyIds resolve through
 * the did:key driver as always; a `did:webvh` keyId resolves through the local
 * (log-verifying) controller-document resolver, when one is engaged.
 *
 * @param options {object}
 * @param [options.webvh] {WebvhResolverContext}   engage the local `did:webvh`
 *   resolver for this verification
 * @returns {(options: { keyId: string }) => Promise<{ verifier: object,
 *   verificationMethod: IVerificationMethod }>}
 */
function createGetVerifier({ webvh }: { webvh?: WebvhResolverContext } = {}) {
  return async function getVerifier({ keyId }: { keyId: string }) {
    try {
      if (webvh && keyId.startsWith('did:webvh:')) {
        return await webvhVerifier({ webvh, keyId })
      }
      const verificationMethod = await didKeyDriver.get({ url: keyId })
      const key = await Ed25519VerificationKey.from(
        verificationMethod as IPublicKey
      )
      const verifier = key.verifier()
      return {
        verifier,
        verificationMethod: verificationMethod as IVerificationMethod
      }
    } catch (err) {
      // A server-side fault met while resolving (a storage error under the
      // did:webvh log read) is not the client's doing and keeps its 5xx.
      if (isServerFault(err)) {
        throw err
      }
      throw keyResolutionError({ keyId, cause: err as Error })
    }
  }
}

/**
 * The `name` carried by an error raised while resolving an invocation's
 * signing key: a `did:webvh` whose history log does not resolve, a key the
 * resolved document does not list, or a `did:key` keyId that does not decode.
 * `verifyCapabilityInvocation` calls the key hook outside its own result
 * envelope, so such a failure reaches the server as a thrown error rather than
 * a `{ verified: false }` result; {@link verifiedOrThrow} reads this name to
 * answer the masked 404 rather than a 400. The keyId is entirely the client's
 * to choose, so an unresolvable one is a failed authorization, and answering
 * it differently would let a prober tell a key the server can resolve from one
 * it cannot.
 */
const KEY_RESOLUTION_ERROR_NAME = 'KeyResolutionError'

/**
 * Wraps a key-resolution failure in an error {@link verifiedOrThrow}
 * recognizes by `name`. The underlying failure stays on `cause` for the debug
 * log; it never reaches the wire.
 * @param options {object}
 * @param options.keyId {string}   the keyId that could not be resolved
 * @param options.cause {Error}   the resolver's error
 * @returns {Error}
 */
function keyResolutionError({
  keyId,
  cause
}: {
  keyId: string
  cause: Error
}): Error {
  const err = new Error(
    `Could not resolve the invocation signing key "${keyId}".`,
    { cause }
  )
  err.name = KEY_RESOLUTION_ERROR_NAME
  return err
}

/**
 * Minimal logger surface used during verification (`request.log`).
 */
interface ZcapLogger {
  error: (...args: any[]) => void
  debug: (...args: any[]) => void
}

/**
 * Returns true when a `Capability-Invocation` header value is the bare root
 * form (`zcap id="urn:zcap:root:..."` -- the signer invokes the root capability
 * directly), false when it embeds a delegated capability
 * (`zcap capability="<base64url(gzip(json))>"`). The check is safe on the raw
 * header: a `capability=` substring cannot occur inside the root form's
 * url-encoded `id` (where `=` is percent-encoded).
 *
 * @param options {object}
 * @param options.invocation {string}   the raw `Capability-Invocation` header
 * @returns {boolean}
 */
export function isRootInvocation({
  invocation
}: {
  invocation: string
}): boolean {
  return !invocation.includes('capability=')
}

/**
 * The subset of an embedded delegated capability (and of the embedded entries
 * of its `proof.capabilityChain`) that the readers of an unverified
 * `Capability-Invocation` header look at.
 */
export interface EmbeddedDelegation {
  controller?: string | string[]
  parentCapability?: string
  expires?: string
  proof?: {
    verificationMethod?: string
    capabilityChain?: Array<string | EmbeddedDelegation>
  }
}

/**
 * The delegated capability a `Capability-Invocation` header embeds
 * (`capability="<base64url(gzip(json))>"`), decoded and NOT verified. Returns
 * `undefined` when the header embeds no capability or cannot be read.
 *
 * @param options {object}
 * @param options.invocation {string}   the raw `Capability-Invocation` header
 * @returns {EmbeddedDelegation | undefined}
 */
export function embeddedCapabilityOf({
  invocation
}: {
  invocation: string
}): EmbeddedDelegation | undefined {
  try {
    const encoded = parseSignatureHeader(invocation).params.capability
    if (typeof encoded !== 'string') {
      return undefined
    }
    return decodeEmbeddedCapability({ encoded }) as EmbeddedDelegation
  } catch {
    return undefined
  }
}

/**
 * The delegation chain a `Capability-Invocation` header embeds, read WITHOUT
 * verifying anything: `chain` in delegation order (the `capabilityChain`
 * entries, root id first and intermediate delegations embedded whole, plus
 * the invoked capability itself, which is not listed in its own chain), the
 * embedded `delegations` among them, and the `rootId` the chain hangs off.
 * Returns `undefined` when the header embeds no readable capability.
 *
 * @param options {object}
 * @param options.invocation {string}   the raw `Capability-Invocation` header
 * @returns {{ capability: EmbeddedDelegation, chain: Array<string |
 *   EmbeddedDelegation>, delegations: EmbeddedDelegation[], rootId?: string }
 *   | undefined}
 */
export function embeddedDelegations({ invocation }: { invocation: string }):
  | {
      capability: EmbeddedDelegation
      chain: Array<string | EmbeddedDelegation>
      delegations: EmbeddedDelegation[]
      rootId?: string
    }
  | undefined {
  const capability = embeddedCapabilityOf({ invocation })
  if (capability === undefined) {
    return undefined
  }
  const chain = [...(capability.proof?.capabilityChain ?? []), capability]
  const delegations = chain.filter(
    (entry): entry is EmbeddedDelegation =>
      typeof entry === 'object' && entry !== null
  )
  const rootId =
    typeof chain[0] === 'string' ? chain[0] : capability.parentCapability
  return { capability, chain, delegations, rootId }
}

/**
 * The DID that signed a delegated invocation's base delegation -- the one
 * hanging directly off the root capability -- read off the
 * `Capability-Invocation` header WITHOUT verifying anything. Only the root
 * capability's controller can validly make that delegation, so a caller that
 * must pick among candidate root controllers (List Spaces) can narrow them to
 * this one before any signature work; the verification that follows still
 * decides. Returns `undefined` when the header embeds no readable capability.
 *
 * @param options {object}
 * @param options.invocation {string}   the raw `Capability-Invocation` header
 *   (the delegated form)
 * @returns {string | undefined}
 */
export function baseDelegationSigner({
  invocation
}: {
  invocation: string
}): string | undefined {
  const embedded = embeddedDelegations({ invocation })
  if (embedded === undefined) {
    return undefined
  }
  const { delegations, rootId } = embedded
  const base =
    delegations.find(delegation => delegation.parentCapability === rootId) ??
    delegations[0]
  const signer = didOfMethodId(base?.proof?.verificationMethod ?? '')
  return signer || undefined
}

/**
 * Whether a verified invocation was of the synthesized root capability
 * itself. The verifier's dereferenced chain runs root to tail, the tail being
 * the invoked capability, so a root invocation's chain is that one link and a
 * delegated invocation's has at least one delegated link above it. A handler
 * whose behavior turns on root authority (Import Space's restore of the Space
 * Metadata object) reads it here, off what was verified, rather than off the
 * header's serialization.
 *
 * @param options {object}
 * @param options.result {VerifyCapabilityInvocationResult}   a successful
 *   verification result
 * @returns {boolean}
 */
function verifiedRootInvocation({
  result
}: {
  result: VerifyCapabilityInvocationResult
}): boolean {
  return result.dereferencedChain?.length === 1
}

/**
 * The facts of a verified invocation that a later authorization decision
 * reads: who signed it and what it invoked. `invoker` is the signing key's
 * controller, the DID the verifier matched the invoked capability's
 * `controller` against. `invokedCapability` is the embedded delegated
 * capability, with its `invocationTarget` and `allowedAction`, and is absent
 * on a root invocation, whose header carries the root capability's id alone.
 * Import Space reads these to decide which archived revocations the
 * invocation could have submitted on the revocation route
 * (`lib/importRevocations.ts`).
 */
export interface VerifiedInvocation {
  rootInvocation: boolean
  invoker?: string
  invokedCapability?: {
    invocationTarget?: string
    allowedAction?: string | string[]
  }
}

/**
 * Reads the {@link VerifiedInvocation} facts off a verified result.
 *
 * @param options {object}
 * @param options.result {VerifyCapabilityInvocationResult}   a successful
 *   verification result
 * @returns {VerifiedInvocation}
 */
export function verifiedInvocation({
  result
}: {
  result: VerifyCapabilityInvocationResult
}): VerifiedInvocation {
  const { capability, invoker } = result
  return {
    rootInvocation: verifiedRootInvocation({ result }),
    ...(invoker !== undefined && { invoker }),
    ...(isPlainObject(capability) && {
      invokedCapability: capability as VerifiedInvocation['invokedCapability']
    })
  }
}

/**
 * Verifies the capability-invocation signature on a request against the Space
 * controller's key. Throws `AuthVerificationError` (400) if verification itself
 * errors. If the capability does not verify, throws the 404 `denialError`
 * picks: `CapabilityRevokedError`, `CapabilityExpiredError`, or the masked
 * `UnauthorizedError`.
 *
 * @param options {object}
 * @param options.url {string}   request URL (path), resolved against serverUrl
 * @param options.allowedTarget {string}   the capability's expected
 *   invocationTarget (full URL, including host and port)
 * @param options.allowedAction {string}   expected action, e.g. an HTTP verb
 * @param options.method {string}   the HTTP method of the request
 * @param options.headers {IncomingHttpHeaders}   the request headers (including
 *   `authorization`, `capability-invocation`, and `digest`)
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceController {IDID}   the DID that controls the Space: a
 *   `did:key`, or a self-hosted `did:webvh` on a promoted Space
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged whenever supplied, so a delegated
 *   capability's did:webvh controller resolves even on a did:key-controlled
 *   Space (the driver still refuses DIDs this server does not host)
 * @param [options.requestName] {string}   human-readable request name, used in
 *   error titles
 * @param options.logger {ZcapLogger}   logger for verification errors
 * @param [options.allowTargetQuery] {boolean}   tolerate query parameters that
 *   extend `allowedTarget` on the request URL (see `verifyZcap`)
 * @param [options.allowTargetAttenuation] {boolean}   accept a request URL
 *   that path-extends `allowedTarget` under a capability rooted at
 *   `allowedTarget` (see `verifyZcap`)
 * @param [options.attenuatedRootTarget] {string}   an ancestor target (e.g.
 *   the Space URL) whose root capability is also accepted as the root of a
 *   delegated chain that attenuates down to the request URL (see `verifyZcap`)
 * @param options.revocation {object|string}   the revocation-store check, run
 *   against the dereferenced chain after signature verification. REQUIRED so
 *   that skipping revocation is a stated decision, never an omission: pass
 *   `{ storage, scope }` -- the scope (keystore or Space) the chain roots
 *   in -- or the literal `'no-revocation-scope'` when the verified target has
 *   no scope a revocation could be stored under (a create/consent
 *   verification for a not-yet-existing resource, or a collection-level root
 *   like `/kms/keystores`).
 * @param [options.containerRule] {ContainerRule}   the container rule this
 *   operation carries, when it is an unsafe method at a container URL
 *   (`lib/containerRule.ts`). The `exact-delete`, `space-subtree-put` and
 *   `replicas-subtree` rules are keyed on the Space's canonical trailing-slash
 *   URL, which `attenuatedRootTarget` must then carry; `controller-only`
 *   reads no target.
 * @param [options.maxChainLength] {number}   max delegation chain length,
 *   root included (see `verifyZcap`)
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL in
 *   milliseconds (see `verifyZcap`)
 * @param [options.peerWebvh] {PeerWebvhResolver}   lets a foreign
 *   `did:webvh` with no stored log invoke a delegated capability here: when
 *   the request is signed by one, its delegation chain is verified first
 *   ({@link peerInvokerGrant}), and only a chain that verifies lets this
 *   resolver fetch the DID's log. Passed by the PWS route families; requires
 *   `webvh`.
 * @returns {Promise<VerifyCapabilityInvocationResult>}   the successful
 *   verification result (callers needing the dereferenced chain, e.g. the
 *   per-key `maxCapabilityChainLength` gate, read it from here)
 */
export async function handleZcapVerify({
  url,
  allowedTarget,
  allowedAction,
  method,
  headers,
  serverUrl,
  spaceController,
  webvh,
  requestName = '',
  logger,
  allowTargetQuery = false,
  allowTargetAttenuation = false,
  attenuatedRootTarget,
  revocation,
  maxChainLength,
  maxDelegationTtl,
  containerRule,
  peerWebvh
}: {
  url: string
  allowedTarget: string
  allowedAction: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
  webvh?: WebvhResolverContext
  requestName?: string
  logger: ZcapLogger
  allowTargetQuery?: boolean
  allowTargetAttenuation?: boolean
  attenuatedRootTarget?: string
  revocation:
    { storage: StorageBackend; scope: RevocationScope } | 'no-revocation-scope'
  maxChainLength?: number
  maxDelegationTtl?: number
  containerRule?: ContainerRule
  peerWebvh?: PeerWebvhResolver
}): Promise<VerifyCapabilityInvocationResult> {
  assertInvocationPresent({ headers, requestName })
  // The `controller-only` container rule turns on nothing but whether the
  // `Capability-Invocation` header embeds a delegated capability, so it is
  // decided here, before the library dereferences the chain, verifies every
  // delegation proof and resolves did:webvh documents. The refusal is the
  // masked `not-found` the inspector path would have produced -- never a named
  // `capability-revoked` or `capability-expired` cause, which the two
  // capability-only handlers carrying this rule could not have surfaced
  // anyway.
  if (
    containerRule === 'controller-only' &&
    !isRootInvocation({ invocation: capabilityInvocationHeader({ headers }) })
  ) {
    throw new UnauthorizedError({ requestName })
  }
  // The other three rules compare the tail's target against the Space URL;
  // the `controller-only` rule reads no target, so it also serves a container
  // outside the PWS route family (a `/kms` keystore).
  if (
    containerRule &&
    containerRule !== 'controller-only' &&
    !attenuatedRootTarget
  ) {
    throw new Error(
      'A container rule needs attenuatedRootTarget, the Space URL'
    )
  }

  // The chain inspectors, composed into the zcap library's single hook: the
  // container rule first (the cheapest check -- it reads the chain's tail
  // and resolves nothing), then the revocation-store check (whenever the
  // target has a scope), then the annex-chain clause bounding ladder-signed
  // delegations (whenever the did:webvh resolver is engaged -- without it no
  // did:webvh proof verifies, so there is no ladder delegation to bound).
  // The clause also takes the operation being verified, since the zcap
  // library's hook sees only the chain: its invocation-time bound needs the
  // target and action.
  const inspectors = [
    ...(containerRule
      ? [
          containerRuleInspector({
            rule: containerRule,
            spaceUrl: attenuatedRootTarget
          })
        ]
      : []),
    ...(revocation === 'no-revocation-scope'
      ? []
      : [revocationChainInspector(revocation)]),
    ...(webvh
      ? [
          clientAnnexChainInspector({
            ...webvh,
            invocation: { target: allowedTarget, action: allowedAction }
          })
        ]
      : [])
  ]
  const inspectCapabilityChain =
    inspectors.length > 0 ? composeChainInspectors(inspectors) : undefined
  // The peer pre-pass. Without a grant a foreign did:webvh invoker with no
  // stored log stays unresolvable, and the verification below answers the
  // masked `not-found`.
  const peerDid =
    peerWebvh !== undefined && webvh !== undefined
      ? await peerInvokerGrant({
          headers,
          serverUrl,
          spaceController,
          webvh,
          peerWebvh,
          rootsFor: () =>
            expectedRoots({
              allowedTarget,
              fullRequestUrl: absoluteUrl({ path: url, serverUrl }),
              allowTargetQuery,
              allowTargetAttenuation,
              attenuatedRootTarget
            }),
          inspectCapabilityChain,
          maxChainLength,
          maxDelegationTtl,
          logger
        })
      : undefined
  return verifiedOrThrow({
    verify: () =>
      verifyZcap({
        url,
        allowedTarget,
        allowedAction,
        method,
        headers,
        serverUrl,
        spaceController,
        webvh:
          peerDid !== undefined
            ? { ...webvh!, peer: { did: peerDid, resolver: peerWebvh! } }
            : webvh,
        allowTargetQuery,
        allowTargetAttenuation,
        attenuatedRootTarget,
        inspectCapabilityChain,
        maxChainLength,
        maxDelegationTtl
      }),
    failureMessage: 'ZCAP verification failed',
    headers,
    requestName,
    logger
  })
}

/**
 * The capability action a PWS request invokes, read off its HTTP method. The
 * action vocabulary is `GET`, `POST`, `PUT` and `DELETE`. `HEAD` is not an
 * action of its own. A `HEAD` request is authorized as a `GET`: its invocation
 * names the `GET` action, and a capability that permits `GET` permits it. The
 * HTTP signature still covers the request's real method.
 *
 * @param options {object}
 * @param options.method {string}   the HTTP method of the request
 * @returns {string}   the expected capability action
 */
export function capabilityActionOf({ method }: { method: string }): string {
  return method === 'HEAD' ? 'GET' : method
}

/**
 * {@link handleZcapVerify} for a Fastify request: the request URL, method and
 * headers, the server's base URL, the request logger and the local
 * `did:webvh` resolver context (the control plane, the backend set and the
 * base URL) are all read off `request`. The network resolver for a foreign
 * `did:webvh` invoker is an opt-in: set `peerWebvh` to hand it
 * `request.server.peerWebvh`, which only the PWS route families do.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   the request being authorized
 * @param [options.peerWebvh] {boolean}   let a foreign `did:webvh` with no
 *   stored log invoke a delegated capability (see `handleZcapVerify`)
 * @param [options.allowedAction] {string}   expected action; defaults to the
 *   action of the request's HTTP method (see `capabilityActionOf`), which is
 *   what a PWS route expects
 * @returns {Promise<VerifyCapabilityInvocationResult>}   as
 *   `handleZcapVerify` returns it; every other option is passed to it as is
 */
export async function verifyRequestZcap({
  request,
  peerWebvh = false,
  allowedAction = capabilityActionOf({ method: request.method }),
  ...options
}: {
  request: FastifyRequest
  peerWebvh?: boolean
  allowedAction?: string
} & Omit<
  Parameters<typeof handleZcapVerify>[0],
  | 'url'
  | 'method'
  | 'headers'
  | 'serverUrl'
  | 'webvh'
  | 'logger'
  | 'peerWebvh'
  | 'allowedAction'
>): Promise<VerifyCapabilityInvocationResult> {
  const { url, method, headers } = request
  const { serverUrl, storage, serverBackends } = request.server
  return await handleZcapVerify({
    ...options,
    allowedAction,
    url,
    method,
    headers,
    serverUrl,
    webvh: { storage, serverBackends, serverUrl },
    logger: request.log,
    ...(peerWebvh && { peerWebvh: request.server.peerWebvh })
  })
}

/**
 * The raw `Capability-Invocation` header, or the empty string when absent.
 *
 * @param options {object}
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @returns {string}
 */
function capabilityInvocationHeader({
  headers
}: {
  headers: IncomingHttpHeaders
}): string {
  return (headers['capability-invocation'] as string | undefined) ?? ''
}

/**
 * Whether the request's signing key belongs to the invoked capability's
 * controller. The zcap library runs the same match, but only after the chain
 * walk, and the walk names an expired parent link before it gets there. This
 * server-side match gates the named denial causes, so a leaked copy of a
 * grant invoked with some other key stays the masked `not-found`. A root
 * invocation carries no embedded capability and never reaches a named cause;
 * an unreadable header counts as no match. The comparison mirrors the
 * library's `isController`: the controller set includes the key id itself or
 * the DID it is a fragment of.
 * @param options {object}
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @returns {boolean}
 */
function invokerIsController({
  headers
}: {
  headers: IncomingHttpHeaders
}): boolean {
  let keyId: unknown
  try {
    keyId = parseSignatureHeader(headers.authorization ?? '').params.keyId
  } catch {
    return false
  }
  const capability = embeddedCapabilityOf({
    invocation: capabilityInvocationHeader({ headers })
  })
  if (typeof keyId !== 'string' || capability === undefined) {
    return false
  }
  const controllers = capabilityControllers(capability)
  return (
    controllers.includes(keyId) || controllers.includes(didOfMethodId(keyId))
  )
}

/**
 * Maps a verification result that did not verify to the server's denial
 * error. Two causes are named by their problem type, both still 404: a
 * revoked capability in the chain (the revocation inspector's error, told by
 * its name) and an expired capability (the zcap library's named expiry
 * error). Every other cause is the masked `UnauthorizedError`. A cause is
 * named only for a caller signing with the invoked capability's own
 * controller key (`invokerIsController`), so it reports something about the
 * caller's own grant and nothing to anyone else. Both shapes the verifier
 * hands back are read: a bare error, or a jsigs `VerificationError` wrapping
 * it in `errors`.
 * @param options {object}
 * @param options.error {Error}   the verify result's `error`
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @param options.requestName {string}   request name used in error titles
 * @returns {ProblemError}
 */
function denialError({
  error,
  headers,
  requestName
}: {
  error?: Error
  headers: IncomingHttpHeaders
  requestName: string
}): UnauthorizedError | CapabilityRevokedError | CapabilityExpiredError {
  const cause =
    (error as { errors?: Error[] } | undefined)?.errors?.[0] ?? error
  const named =
    cause?.name === CAPABILITY_REVOKED_ERROR_NAME ||
    cause?.name === ZcapCapabilityExpiredError.name
  if (!named || !invokerIsController({ headers })) {
    return new UnauthorizedError({ requestName })
  }
  if (cause?.name === CAPABILITY_REVOKED_ERROR_NAME) {
    return new CapabilityRevokedError({ requestName, cause })
  }
  return new CapabilityExpiredError({ requestName, cause })
}

/**
 * Refuses a request that carries no capability invocation (no `Authorization`
 * or no `Capability-Invocation` header) with the masked `UnauthorizedError`
 * (404). A request with no credential is answered exactly as a signed one
 * that lacks the privilege, under the same request name, so the two bodies
 * are the same bytes. The PWS route groups beneath `/space/` let such a
 * request reach its handler, and every capability verification starts here.
 * A handler that runs other checks ahead of its verification calls it first,
 * so those checks answer nothing to a request with no credential.
 * @param options {object}
 * @param options.headers {IncomingHttpHeaders}
 * @param [options.requestName] {string}   request name used in the error
 *   title
 * @returns {void}
 */
export function assertInvocationPresent({
  headers,
  requestName
}: {
  headers: IncomingHttpHeaders
  requestName?: string
}): void {
  if (!hasAuthHeaders({ headers })) {
    throw new UnauthorizedError({ requestName })
  }
}

/**
 * Runs a capability-invocation verification and maps its failure modes to the
 * server's errors: a thrown verification error is logged and rethrown as
 * `AuthVerificationError` (400) -- unless it came from resolving the signing
 * key (see {@link KEY_RESOLUTION_ERROR_NAME}), which is the masked
 * `UnauthorizedError` (404) instead, or is a 5xx `ProblemError` from a
 * storage fault, which is rethrown as is -- and a result that did not verify becomes
 * the same 5xx when a storage fault is behind it ({@link serverFaultIn}), or
 * the 404 denial `denialError` picks (`capability-revoked`,
 * `capability-expired`, or the masked `UnauthorizedError`). Shared by
 * `handleZcapVerify` and
 * `handleRevocationInvocationVerify`, which differ only in what they verify
 * and in the log message.
 * @param options {object}
 * @param options.verify {() => Promise<VerifyCapabilityInvocationResult>}
 *   the verification to run
 * @param options.failureMessage {string}   log message for a thrown error
 * @param options.headers {IncomingHttpHeaders}   the request headers, read by
 *   `denialError` to gate the named causes
 * @param options.requestName {string}   request name used in error titles
 * @param options.logger {ZcapLogger}   logger for verification errors
 * @returns {Promise<VerifyCapabilityInvocationResult>}   the verified result
 */
async function verifiedOrThrow({
  verify,
  failureMessage,
  headers,
  requestName,
  logger
}: {
  verify: () => Promise<VerifyCapabilityInvocationResult>
  failureMessage: string
  headers: IncomingHttpHeaders
  requestName: string
  logger: ZcapLogger
}): Promise<VerifyCapabilityInvocationResult> {
  let zcapVerifyResult: VerifyCapabilityInvocationResult
  try {
    zcapVerifyResult = await verify()
  } catch (err) {
    // A key the request named but the server cannot resolve is a failed
    // authorization, not a malformed request: answer it exactly as a
    // signature that did not verify, so the keyId reveals nothing. It is a
    // client-caused condition, so it is logged at debug rather than error.
    if ((err as Error)?.name === KEY_RESOLUTION_ERROR_NAME) {
      logger.debug({ err }, failureMessage)
      throw new UnauthorizedError({ requestName })
    }
    // A server-side fault (a storage error under a did:webvh log read) is
    // neither a client error nor a denial: it keeps its 5xx, which
    // `handleError` logs with its cause.
    if (isServerFault(err)) {
      throw err
    }
    logger.error({ err }, failureMessage)
    throw new AuthVerificationError({ requestName, cause: err as Error })
  }
  if (!zcapVerifyResult.verified) {
    // The verifier catches a fault raised under a document loader or a chain
    // inspector and hands it back here. It keeps its 5xx too.
    throwIfServerFault({ error: zcapVerifyResult.error })
    throw denialError({ error: zcapVerifyResult.error, headers, requestName })
  }
  return zcapVerifyResult
}

/**
 * The server-side fault behind a verification that did not verify, when there
 * is one: a 5xx `ProblemError` such as a storage error under a `did:webvh`
 * log read or a revocation lookup. The verifier does not throw for a fault
 * raised by a document loader or a chain inspector. It returns the fault as
 * the result's `error`, bare, among a `VerificationError`'s `errors`, or as a
 * `cause`, so all three are read.
 * @param options {object}
 * @param [options.error] {unknown}   the verify result's `error`
 * @param [options.depth] {number}   how deep this call is in the walk
 * @returns {ProblemError | undefined}
 */
export function serverFaultIn({
  error,
  depth = 0
}: {
  error?: unknown
  depth?: number
}): ProblemError | undefined {
  if (!(error instanceof Error) || depth > 4) {
    return undefined
  }
  if (isServerFault(error)) {
    return error
  }
  const { errors } = error as { errors?: unknown }
  const nested = [...(Array.isArray(errors) ? errors : []), error.cause]
  for (const inner of nested) {
    const fault = serverFaultIn({ error: inner, depth: depth + 1 })
    if (fault !== undefined) {
      return fault
    }
  }
  return undefined
}

/**
 * Throws the server-side fault behind a verification that did not verify,
 * when there is one ({@link serverFaultIn}), so it keeps its 5xx rather than
 * reading as a denial; returns otherwise.
 * @param options {object}
 * @param [options.error] {unknown}   the verify result's `error`, or a caught
 *   error
 * @returns {void}
 */
export function throwIfServerFault({ error }: { error?: unknown }): void {
  const fault = serverFaultIn({ error })
  if (fault !== undefined) {
    throw fault
  }
}

/**
 * The result of a `jsigs.verify` run under the `CapabilityDelegation` proof
 * purpose, reduced to what its callers read.
 */
type DelegationChainResult = {
  verified: boolean
  error?: Error
  results?: Array<{
    purposeResult?: { delegator?: { id?: string } | string }
  }>
}

/**
 * Verifies a delegated capability's chain (`CapabilityDelegation` proof
 * purpose, under every accepted delegation-proof suite), as the peer pre-pass
 * and the revocation chain check both do. The result is handed back as the
 * library returns it; a caller reads a server fault out of it.
 * @param options {object}
 * @param options.capability {object}   the delegated capability
 * @param options.documentLoader {IDocumentLoader}   synthesizes the root
 * @param options.expectedRootCapability {string[]}   the accepted roots
 * @param options.allowTargetAttenuation {boolean}
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}
 * @returns {Promise<DelegationChainResult>}
 */
async function verifyDelegationChain({
  capability,
  documentLoader,
  expectedRootCapability,
  allowTargetAttenuation,
  maxChainLength,
  maxDelegationTtl,
  inspectCapabilityChain
}: {
  capability: object
  documentLoader: IDocumentLoader
  expectedRootCapability: string[]
  allowTargetAttenuation: boolean
  maxChainLength?: number
  maxDelegationTtl?: number
  inspectCapabilityChain?: InspectCapabilityChain
}): Promise<DelegationChainResult> {
  const suite = delegationProofSuites()
  return (await jsigs.verify(capability, {
    documentLoader,
    suite,
    purpose: new CapabilityDelegation({
      suite,
      expectedRootCapability,
      allowTargetAttenuation,
      maxChainLength,
      maxDelegationTtl,
      inspectCapabilityChain
    })
  })) as DelegationChainResult
}

/**
 * The root capabilities an invocation may root in, and whether its target may
 * attenuate. Shared by {@link verifyZcap} and the peer pre-pass, so the chain
 * the pre-pass admits roots where the invocation's own verification requires.
 *
 * With any of the attenuation options set, the acceptable roots are the
 * ancestor's root capability (a delegated chain rooted at e.g. the Space URL,
 * narrowing to the request URL), the `allowedTarget`'s own (a root invocation,
 * or a delegated chain for the exact target), and, under `allowTargetQuery`,
 * the query-bearing request URL's own (a controller invoking the query URL
 * directly). Under `allowTargetAttenuation` alone that leaves
 * `allowedTarget`'s own as the only acceptable root: a path-extended request
 * URL is never itself one. A one-element list is matched exactly as the bare
 * string form the option also accepts. With none set, `allowedTarget`'s own
 * root is the only one.
 *
 * @param options {object}
 * @param options.allowedTarget {string}
 * @param options.fullRequestUrl {string}   the absolute request URL
 * @param options.allowTargetQuery {boolean}
 * @param options.allowTargetAttenuation {boolean}
 * @param [options.attenuatedRootTarget] {string}
 * @returns {{ rootCapabilities: string[], attenuates: boolean }}
 */
function expectedRoots({
  allowedTarget,
  fullRequestUrl,
  allowTargetQuery,
  allowTargetAttenuation,
  attenuatedRootTarget
}: {
  allowedTarget: string
  fullRequestUrl: string
  allowTargetQuery: boolean
  allowTargetAttenuation: boolean
  attenuatedRootTarget?: string
}): { rootCapabilities: string[]; attenuates: boolean } {
  const attenuates = Boolean(
    allowTargetQuery || attenuatedRootTarget || allowTargetAttenuation
  )
  if (!attenuates) {
    return { rootCapabilities: [rootCapabilityId(allowedTarget)], attenuates }
  }
  const rootTargets = [
    ...(attenuatedRootTarget ? [attenuatedRootTarget] : []),
    allowedTarget,
    ...(allowTargetQuery ? [fullRequestUrl] : [])
  ]
  return {
    rootCapabilities: [...new Set(rootTargets.map(rootCapabilityId))],
    attenuates
  }
}

/**
 * The peer pre-pass: decides whether this verification may resolve the
 * request's signing DID over the network, before anything resolves it. The
 * HTTP-signature verifier resolves the signing key before it reads the
 * capability, so a fetch made there would be an unauthenticated request to
 * any host a request names. This runs first, and issues a grant only when:
 *
 * - the signing keyId's DID is a `did:webvh` on another host, of a shape the
 *   method maps to an `https` URL on the default port, and neither it nor its
 *   host is on the blocklist (`PeerWebvhResolver.mayFetch`);
 * - this server stores no log for the DID (`locateWebvhLog`), since a DID it
 *   stores resolves from storage and never over the network;
 * - the invocation embeds a delegated capability (a root invocation by a
 *   foreign DID never fetches, nor does a header that also carries an `id`)
 *   whose `controller` is exactly that DID;
 * - that capability's delegation chain verifies to the Space controller,
 *   through the same roots and chain inspectors (revocation, client-annex
 *   clause, container rule) the invocation's own verification applies.
 *
 * The chain is verified here with the local resolver alone, so every
 * delegation link must be signed by a key this server resolves without a
 * fetch. A foreign DID may invoke, and may not delegate. The invocation's own
 * verification decodes the same header, so it sees the same chain.
 *
 * A request that fails any check gets no grant and causes no fetch. Its
 * signing key then stays unresolvable, which the verification answers with
 * the masked `not-found`.
 *
 * @param options {object}
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceController {IDID}   the controller of the root
 * @param options.webvh {WebvhResolverContext}   the local resolver context
 * @param options.peerWebvh {PeerWebvhResolver}   the network resolver, asked
 *   whether it may fetch the DID at all
 * @param options.rootsFor {Function}   computes the roots the invocation may
 *   root in ({@link expectedRoots}), called only once a chain is to be
 *   verified
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   the
 *   invocation's chain inspectors
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @param options.logger {ZcapLogger}   logs a refused chain at debug
 * @returns {Promise<string | undefined>}   the DID the grant names, or
 *   `undefined` when the request earns none
 */
async function peerInvokerGrant({
  headers,
  serverUrl,
  spaceController,
  webvh,
  peerWebvh,
  rootsFor,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl,
  logger
}: {
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
  webvh: WebvhResolverContext
  peerWebvh: PeerWebvhResolver
  rootsFor: () => { rootCapabilities: string[]; attenuates: boolean }
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
  logger: ZcapLogger
}): Promise<string | undefined> {
  let did: string
  const invocation = capabilityInvocationHeader({ headers })
  try {
    const { keyId } = parseSignatureHeader(headers.authorization ?? '').params
    if (typeof keyId !== 'string') {
      return undefined
    }
    did = didOfMethodId(keyId)
    if (!peerWebvh.mayFetch({ did, serverUrl })) {
      return undefined
    }
    if (isRootInvocation({ invocation })) {
      return undefined
    }
    // The verifier reads `id` first and runs a header carrying both as a
    // root invocation, so the chain verified here would not be the one it
    // checks.
    if (parseSignatureHeader(invocation).params.id !== undefined) {
      return undefined
    }
  } catch {
    return undefined
  }
  const capability = embeddedCapabilityOf({ invocation })
  if (capability === undefined) {
    return undefined
  }
  const controllers = capabilityControllers(capability)
  if (controllers.length !== 1 || controllers[0] !== did) {
    return undefined
  }
  // A DID whose log this server stores (a replicated peer-hosted one) takes
  // the storage path alone, so it is never fetched.
  if (
    (await locateWebvhLog({ storage: webvh.storage, serverUrl, did })) !==
    undefined
  ) {
    return undefined
  }
  const documentLoader = rootCapabilityLoader({
    controllerFor: () => spaceController,
    webvh
  })
  const expected = rootsFor()
  let result: DelegationChainResult
  try {
    result = await verifyDelegationChain({
      capability,
      documentLoader,
      expectedRootCapability: expected.rootCapabilities,
      allowTargetAttenuation: expected.attenuates,
      maxChainLength,
      maxDelegationTtl,
      inspectCapabilityChain
    })
  } catch (err) {
    result = { verified: false, error: err as Error }
  }
  if (!result.verified) {
    // A storage fault keeps its 5xx, as on the invocation's own path. The
    // verifier hands a loader or inspector fault back in the result.
    throwIfServerFault({ error: result.error })
    logger.debug(
      { err: result.error, did },
      'A foreign invoker chain did not verify; its log is not fetched.'
    )
    return undefined
  }
  return did
}

/**
 * Performs the underlying capability-invocation verification: builds a document
 * loader whose `urn` protocol handler synthesizes the root capability on demand
 * (its controller is the Space controller), then calls
 * verifyCapabilityInvocation().
 *
 * @param options {object}
 * @param options.url {string}   request URL (path), resolved against serverUrl
 * @param options.allowedTarget {string}   expected invocationTarget (full URL)
 * @param options.allowedAction {string}   expected action, e.g. an HTTP verb
 * @param options.method {string}   the HTTP method of the request
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @param options.serverUrl {string}   this server's base URL
 * @param options.spaceController {IDID}   the DID that controls the Space: a
 *   `did:key`, or a self-hosted `did:webvh` on a promoted Space
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged whenever supplied, so a delegated
 *   capability's did:webvh controller resolves even on a did:key-controlled
 *   Space (the driver still refuses DIDs this server does not host)
 * @param [options.allowTargetQuery] {boolean}   when set, accept a request URL
 *   that adds query parameters to `allowedTarget` (e.g. List Collection's
 *   `?limit`/`cursor`) as authorized by a capability for the bare target. The
 *   spec requires that pagination parameters select a page within an
 *   already-authorized target without changing the target a capability must
 *   match. The zcap library otherwise requires the capability's
 *   `invocationTarget` to equal the full request URL exactly, so this enables
 *   target attenuation (the library treats a `?`-query suffix as a valid RESTful
 *   attenuation) and admits both the bare-target root capability (a delegate
 *   following `next`) and the query-bearing one (a controller invoking the URL
 *   directly). The actual gate -- the bare-target root capability -- is
 *   unchanged. (TODO: the `/quotas` endpoint should adopt this too, so its
 *   per-Collection breakdown can return to the spec's `?include=collections`
 *   opt-in.)
 * @param [options.allowTargetAttenuation] {boolean}   when set, accept a
 *   request URL that *path*-extends `allowedTarget` (e.g. a WebKMS key
 *   operation posted to `<keystoreId>/keys/<keyId>` under a capability rooted
 *   at the keystore). The root capability is `allowedTarget`'s alone -- unlike
 *   `allowTargetQuery`, the extended URL is never itself an acceptable root --
 *   so both a root invocation by the controller and a delegated zcap whose
 *   `invocationTarget` narrows down to the request URL verify against the
 *   `allowedTarget` root (the webkms authorization model, which roots the
 *   invocation target at the keystore id).
 * @param [options.attenuatedRootTarget] {string}   when set, an *ancestor*
 *   invocation target (the Space URL for the PWS route families) whose root
 *   capability is accepted -- in addition to `allowedTarget`'s own -- as the
 *   root of the invocation. This is what lets a controller delegate one
 *   capability for a whole Space (or a Collection under it, by attenuating
 *   the `invocationTarget` down at delegation time) and have the delegate
 *   invoke it against any URL underneath: the chain roots at the ancestor's
 *   root capability and narrows toward the request URL (RESTful attenuation,
 *   the same shape `allowTargetAttenuation` gives the WebKMS keystore).
 *   Root invocations of `allowedTarget`'s own root capability verify
 *   unchanged, so this only widens what the Space controller can delegate,
 *   never who can access.
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   hook run
 *   against the dereferenced chain after signature verification -- the
 *   extension point for the revocation check (a stored revocation of any
 *   capability in the chain fails the verification, scoped to the keystore or
 *   the Space the request roots in) and the annex-chain clause
 *   (`lib/clientAnnexClause.ts`), composed by `handleZcapVerify`.
 * @param [options.maxChainLength] {number}   max delegation chain length,
 *   root included (the `/kms` families pass `KMS_MAX_CHAIN_LENGTH`; absent,
 *   the zcap library's own default applies)
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL in
 *   milliseconds, measured `expires` minus the delegation proof's `created`
 *   (the `/kms` families pass `KMS_MAX_DELEGATION_TTL`; absent, unbounded)
 * @returns {Promise<VerifyCapabilityInvocationResult>}
 */
export async function verifyZcap({
  url,
  allowedTarget,
  allowedAction,
  method,
  headers,
  serverUrl,
  spaceController,
  webvh,
  allowTargetQuery = false,
  allowTargetAttenuation = false,
  attenuatedRootTarget,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl
}: {
  url: string
  allowedTarget: string
  allowedAction: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  spaceController: IDID
  webvh?: WebvhResolverContext
  allowTargetQuery?: boolean
  allowTargetAttenuation?: boolean
  attenuatedRootTarget?: string
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<VerifyCapabilityInvocationResult> {
  const fullRequestUrl = absoluteUrl({ path: url, serverUrl })
  const roots = expectedRoots({
    allowedTarget,
    fullRequestUrl,
    allowTargetQuery,
    allowTargetAttenuation,
    attenuatedRootTarget
  })
  const common = {
    expectedAction: allowedAction,
    expectedHost: new URL(serverUrl).host
  }
  const expected = roots.attenuates
    ? {
        ...common,
        expectedRootCapability: roots.rootCapabilities,
        // The proof's invocationTarget is the invoked URL: `allowedTarget`
        // itself, a path under it (accepted as a RESTful attenuation), or
        // (under `allowTargetQuery`) the query-bearing request URL.
        // The array form is narrowed to `string` by the verify fork's option
        // type, but the underlying `@interop/zcap` CapabilityInvocation
        // accepts `string | string[]` -- hence the cast.
        expectedTarget: [
          ...new Set([allowedTarget, fullRequestUrl])
        ] as unknown as string,
        allowTargetAttenuation: true
      }
    : {
        ...common,
        rootInvocationTarget: allowedTarget,
        expectedRootCapability: rootCapabilityId(allowedTarget),
        expectedTarget: allowedTarget
      }

  // The webvh resolver is engaged whenever a context is supplied, not only
  // when the Space controller itself is a did:webvh: a delegated capability
  // on a did:key-controlled Space (an unlock Space's management zcap) may
  // name a self-hosted did:webvh as its delegated controller, and verifying
  // its invocation requires resolving that document. This widens resolution
  // only, never authority -- the driver refuses any DID this server does not
  // host, and the chain still roots in the Space's own root capability. A
  // did:key-only verification never dereferences a webvh URL, so it pays
  // nothing beyond the driver construction.
  const documentLoader = rootCapabilityLoader({
    controllerFor: () => spaceController,
    webvh
  })

  // Returns the following object:
  // {
  //     capability, capabilityAction, controller,
  //     dereferencedChain,
  //     invoker: controller,
  //     verificationMethod,
  //     verified: true
  //   }
  return await verifyCapabilityInvocation({
    url: fullRequestUrl,
    method,
    headers: headers as Record<string, string>,
    ...expected,
    documentLoader,
    getVerifier: createGetVerifier({ webvh }),
    inspectCapabilityChain,
    maxChainLength,
    maxDelegationTtl,
    suite: delegationProofSuites()
  })
}

/**
 * The root capabilities a submitted chain may root in: the scope's own, plus
 * the chain's own root when that root targets a URL under the scope. The
 * second covers a grant delegated from a Collection's or a Resource's root
 * capability, which `verifyZcap` accepts on invocation (as `allowedTarget`'s
 * own root), so every grant that verifies on invocation can also be revoked.
 * The chain's root is read off the unverified body, which is safe: it only
 * names which root the verification then requires, and the loader's
 * `controllerFor` still refuses any target outside the scope.
 *
 * @param options {object}
 * @param options.capability {Record<string, unknown>}   the submitted
 *   capability
 * @param options.rootTarget {string}   the scope's full URL
 * @returns {string[]}   the accepted root capability ids
 */
function expectedRevocationRoots({
  capability,
  rootTarget
}: {
  capability: Record<string, unknown>
  rootTarget: string
}): string[] {
  const scopeRoot = rootCapabilityId(rootTarget)
  const proofs = [capability.proof ?? []].flat() as Array<{
    capabilityChain?: unknown[]
  }>
  const chainRoot = proofs.find(proof => Array.isArray(proof?.capabilityChain))
    ?.capabilityChain?.[0]
  if (typeof chainRoot !== 'string') {
    return [scopeRoot]
  }
  let target: string | undefined
  try {
    target = rootTargetOf(chainRoot)
  } catch {
    return [scopeRoot]
  }
  if (target === undefined || !isUnderScope({ target, rootTarget })) {
    return [scopeRoot]
  }
  return [...new Set([scopeRoot, rootCapabilityId(target)])]
}

/**
 * Whether a root capability's invocation target is the scope's own URL or a
 * path under it. `rootTarget` is a container URL (the Space's carries its
 * trailing slash; the keystore's does not), so the subtree prefix is formed on
 * a slash boundary either way.
 *
 * @param options {object}
 * @param options.target {string}   the decoded root invocation target
 * @param options.rootTarget {string}   the scope's full URL
 * @returns {boolean}
 */
export function isUnderScope({
  target,
  rootTarget
}: {
  target: string
  rootTarget: string
}): boolean {
  const subtree = rootTarget.endsWith('/') ? rootTarget : `${rootTarget}/`
  return target === rootTarget || target.startsWith(subtree)
}

/**
 * Verifies the delegation chain of a capability submitted for revocation
 * (`CapabilityDelegation` proof purpose over the embedded chain), throwing
 * `InvalidRevocationError` (400) when it does not verify. A server-side fault
 * met while verifying is thrown as its own 5xx instead. The chain must root
 * in the revocation's scope: its root capability's invocation target must be
 * `rootTarget` -- the keystore URL, or the canonical (trailing-slash) Space
 * URL for a WAS-route revocation -- or a path under it (enforced where the
 * root is synthesized,
 * so a chain aimed at another keystore or Space -- or another service --
 * cannot be submitted here, per ezcap-express `authorizeZcapRevocation`).
 * Deliberately structural only -- it does NOT consult the revocation store:
 * this runs before the invocation is authorized, and a store-dependent
 * failure here would disclose revocation state to unauthorized callers
 * (400 already-revoked vs the masked 404). The caller checks the returned
 * `capabilities` against the store after authorization.
 *
 * @param options {object}
 * @param options.capability {object}   the delegated capability to be revoked
 *   (the request body, verbatim)
 * @param options.rootTarget {string}   the scope's full URL -- the keystore or
 *   the Space -- which the chain is required to root in
 * @param options.rootController {IDID}   the scope's controller (controller of
 *   the synthesized root capability)
 * @param [options.webvh] {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver; engaged whenever supplied, as in `verifyZcap`,
 *   so a chain link signed by a `did:webvh` method verifies on a
 *   `did:key`-controlled scope too
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @returns {Promise<{ delegator: string, chainControllers: string[],
 *   capabilities: CapabilitySummary[] }>}   the capability's delegator (its
 *   delegation proof's controller), every controller in its chain (the
 *   parties allowed to submit the revocation), and the chain's
 *   `(capabilityId, delegator)` pairs for the caller's post-authorization
 *   revocation-store check
 */
export async function verifyRevocationChain({
  capability,
  rootTarget,
  rootController,
  webvh,
  maxChainLength,
  maxDelegationTtl
}: {
  capability: Record<string, unknown>
  rootTarget: string
  rootController: IDID
  webvh?: WebvhResolverContext
  maxChainLength?: number
  maxDelegationTtl?: number
}): Promise<{
  delegator: string
  chainControllers: string[]
  capabilities: CapabilitySummary[]
}> {
  const chainControllers: string[] = []
  let capabilities: CapabilitySummary[] = []
  const documentLoader = rootCapabilityLoader({
    controllerFor: target => {
      if (!isUnderScope({ target, rootTarget })) {
        throw new Error(
          `The root capability from the revocation's delegation chain must` +
            ` have an invocation target that starts with "${rootTarget}".`
        )
      }
      return rootController
    },
    webvh
  })
  const result = await verifyDelegationChain({
    capability,
    documentLoader,
    expectedRootCapability: expectedRevocationRoots({
      capability,
      rootTarget
    }),
    // Attenuation is always tolerated when judging revocability: a zcap
    // delegated with attenuation rules an invocation endpoint would refuse
    // can still be revoked (ezcap-express `_verifyDelegation`).
    allowTargetAttenuation: true,
    maxChainLength,
    maxDelegationTtl,
    inspectCapabilityChain: async details => {
      // Capture every controller in the dereferenced chain -- these are the
      // parties the dual-root rule lets submit this revocation -- and the
      // chain's lookup pairs for the caller's post-authorization store check.
      for (const chainCapability of details.capabilityChain) {
        chainControllers.push(...capabilityControllers(chainCapability))
      }
      capabilities = capabilitySummaries(details)
      return { valid: true }
    }
  })
  if (!result.verified) {
    // A server-side fault met under the document loader (a storage error
    // under a did:webvh log read) is not the submitter's doing and keeps its
    // 5xx rather than reading as an invalid delegation.
    throwIfServerFault({ error: result.error })
    throw new InvalidRevocationError({
      detail: 'The provided capability delegation is invalid.',
      cause: result.error
    })
  }
  const rawDelegator = result.results?.[0]?.purposeResult?.delegator
  const delegator =
    typeof rawDelegator === 'string' ? rawDelegator : rawDelegator?.id
  if (!delegator) {
    throw new InvalidRevocationError({
      detail: 'The capability delegation has no identifiable delegator.'
    })
  }
  return { delegator, chainControllers, capabilities }
}

/**
 * Verifies a delegated capability whose chain is exactly `[root, capability]`:
 * the root capability of `rootTarget`, controlled by `rootController`, and
 * one delegated link. The link's delegation proof must verify under the
 * `CapabilityDelegation` purpose, which also requires the proof's
 * verification method to be one `rootController`'s resolved document lists
 * under `capabilityDelegation`. A `did:webvh` root controller resolves
 * through `webvh`, under the rules of the grant the context carries, else
 * from storage. The replica registration's bootstrap branch verifies the
 * pull capability this way.
 *
 * A server fault met under the document loader (a storage error under a
 * `did:webvh` log read) is thrown, as it is not the capability's doing. Any
 * other failure is returned, for the caller to word its refusal with.
 *
 * @param options {object}
 * @param options.capability {object}   the delegated capability
 * @param options.rootTarget {string}   the root capability's invocation
 *   target, the only target the chain may root in
 * @param options.rootController {string}   the root capability's controller
 * @param options.webvh {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver, with a peer grant when the caller holds the
 *   controller's document
 * @returns {Promise<Error | undefined>}   why the chain does not verify, or
 *   `undefined` when it does
 */
export async function verifyOneLinkDelegation({
  capability,
  rootTarget,
  rootController,
  webvh
}: {
  capability: object
  rootTarget: string
  rootController: string
  webvh: WebvhResolverContext
}): Promise<Error | undefined> {
  // `expectedRootCapability` alone pins the root the chain may have.
  const documentLoader = rootCapabilityLoader({
    controllerFor: () => rootController as IDID,
    webvh
  })
  let error: unknown
  try {
    const result = await verifyDelegationChain({
      capability,
      documentLoader,
      expectedRootCapability: [rootCapabilityId(rootTarget)],
      allowTargetAttenuation: false,
      maxChainLength: 2
    })
    if (result.verified) {
      return undefined
    }
    error = result.error
  } catch (err) {
    error = err
  }
  throwIfServerFault({ error })
  return error instanceof Error
    ? error
    : new Error('The delegation proof does not verify.')
}

/**
 * Verifies the capability invocation on a revocation submission under the
 * dual-root rule: the invocation may root in the scope -- the keystore or the
 * Space -- (whose controller may revoke anything delegated from it, delegates
 * of a revocation capability included, via target attenuation), or in the
 * revocation URL itself, whose
 * synthesized root capability is controlled by *every controller in the
 * to-be-revoked capability's chain* -- so a delegee can revoke its own zcap
 * without holding a separate capability (ezcap-express
 * `authorizeZcapRevocation`). Throws like `handleZcapVerify`:
 * `AuthVerificationError` (400) when verification errors, and the 404
 * `denialError` picks (`CapabilityRevokedError`, `CapabilityExpiredError`, or
 * the masked `UnauthorizedError`) when the invocation does not verify.
 *
 * @param options {object}
 * @param options.url {string}   request URL (path), resolved against serverUrl
 * @param options.method {string}   the HTTP method of the request
 * @param options.headers {IncomingHttpHeaders}   the request headers
 * @param options.serverUrl {string}   this server's base URL
 * @param options.rootTarget {string}   the scope's full URL (the keystore or
 *   the Space)
 * @param options.rootController {IDID}   the scope's controller
 * @param options.webvh {WebvhResolverContext}   storage + serverUrl for the
 *   local `did:webvh` resolver, as in `verifyZcap`, so a `did:webvh` delegee
 *   can self-revoke under the dual-root rule
 * @param options.chainControllers {string[]}   every controller in the
 *   to-be-revoked capability's (already verified) chain
 * @param options.expectedAction {string}   the action the invocation must
 *   carry: the webkms `write` on `/kms`, the HTTP verb (`POST`) on the PWS
 *   route families, whose capabilities are scoped by HTTP method
 * @param [options.inspectCapabilityChain] {InspectCapabilityChain}   the
 *   revocation-store hook, run against the *invoking* chain
 * @param [options.maxChainLength] {number}   max chain length, root included
 * @param [options.maxDelegationTtl] {number}   max delegated-zcap TTL (ms)
 * @param [options.requestName] {string}   request name used in error titles
 * @param options.logger {ZcapLogger}   logger for verification errors
 * @returns {Promise<void>}
 */
export async function handleRevocationInvocationVerify({
  url,
  method,
  headers,
  serverUrl,
  rootTarget,
  rootController,
  webvh,
  chainControllers,
  expectedAction,
  inspectCapabilityChain,
  maxChainLength,
  maxDelegationTtl,
  requestName = '',
  logger
}: {
  url: string
  method: string
  headers: IncomingHttpHeaders
  serverUrl: string
  rootTarget: string
  rootController: IDID
  webvh: WebvhResolverContext
  chainControllers: string[]
  expectedAction: string
  inspectCapabilityChain?: InspectCapabilityChain
  maxChainLength?: number
  maxDelegationTtl?: number
  requestName?: string
  logger: ZcapLogger
}): Promise<void> {
  assertInvocationPresent({ headers, requestName })
  const fullRequestUrl = absoluteUrl({ path: url, serverUrl })
  const documentLoader = rootCapabilityLoader({
    controllerFor: target => {
      if (target === rootTarget) {
        return rootController
      }
      if (target === fullRequestUrl) {
        return chainControllers
      }
      throw new Error(
        `Unexpected root capability target "${target}" on a revocation.`
      )
    },
    webvh
  })

  await verifiedOrThrow({
    verify: () =>
      verifyCapabilityInvocation({
        url: fullRequestUrl,
        method,
        headers: headers as Record<string, string>,
        expectedAction,
        expectedHost: new URL(serverUrl).host,
        expectedRootCapability: [
          rootCapabilityId(rootTarget),
          rootCapabilityId(fullRequestUrl)
        ],
        // The invoked target is the revocation URL, a path under the scope's
        // root; accept either as a delegated zcap's (attenuated) target. The
        // array form is narrowed to `string` by the verify fork's option type
        // (see the same cast in `verifyZcap`'s attenuation branch).
        expectedTarget: [rootTarget, fullRequestUrl] as unknown as string,
        allowTargetAttenuation: true,
        documentLoader,
        getVerifier: createGetVerifier({ webvh }),
        inspectCapabilityChain,
        maxChainLength,
        maxDelegationTtl,
        suite: delegationProofSuites()
      }),
    failureMessage: 'ZCAP revocation invocation verification failed',
    headers,
    requestName,
    logger
  })
}
