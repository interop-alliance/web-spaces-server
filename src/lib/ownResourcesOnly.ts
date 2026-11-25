/**
 * The `OwnResourcesOnly` capability caveat. A capability that carries it
 * reaches only the Resources its own controller created. The principal of a
 * caveat is the controller of the capability that carries it, and a Resource
 * is the principal's own when the principal appears in the Resource's
 * `createdBy` list.
 *
 * The zcap verifier cannot decide the caveat, since the answer is in the
 * stored record. Its handler here decides what needs no storage: the shape of
 * the caveat, the proof suite of the capability that carries it, and whether
 * the route serves a chain carrying the caveat at all. The rest is decided
 * where the record is read. A backend decides a write or a delete inside the
 * write's critical section, from the `ownedBy` option. A read handler decides
 * from the record it is about to serve.
 */
import type { CapabilityCaveat, CaveatHandler } from '@interop/zcap'
import { delegationChainDids, verifiableDidOf } from '../auth-header-hooks.js'
import { asList } from './chainCapability.js'
import { NotOwnResourceError, UnauthorizedError } from '../errors.js'
import type { IDID, StorageBackend } from '../types.js'

/**
 * The caveat `type` this module enforces.
 */
export const OWN_RESOURCES_ONLY = 'OwnResourcesOnly'

/**
 * The caveat types the server enforces, as the service description lists
 * them. A chain carrying any other type is refused by the verifier.
 */
export const SUPPORTED_CAVEAT_TYPES = [OWN_RESOURCES_ONLY]

/**
 * The caveat types the server advertises that a backend does not enforce.
 * A write, a delete and a listing under a capability caveat are decided by
 * the backend, so one that leaves a type out would serve such a grant as if
 * it carried no caveat. Empty for a backend that may be served.
 *
 * @param backend {Pick<StorageBackend, 'enforcedCaveats'>}
 * @returns {string[]}
 */
export function unenforcedCaveatTypes(
  backend: Pick<StorageBackend, 'enforcedCaveats'>
): string[] {
  return SUPPORTED_CAVEAT_TYPES.filter(
    type => !backend.enforcedCaveats?.includes(type)
  )
}

/**
 * How a route answers a chain that carries `OwnResourcesOnly`.
 *
 * - `unaffected` -- the capability decides the request as if it carried no
 *   caveat. A read that describes a container, a request that can only create
 *   a Resource, and a revocation submission.
 * - `resource` -- a request at the URL of a Resource, at its `meta` URL, or at
 *   a chunk URL beneath it. The verification succeeds and hands back the
 *   principals, and the handler or the backend checks them against the
 *   Resource's `createdBy`.
 * - `listing` -- a Collection listing. The verification succeeds and hands
 *   back the principals, and the listing is filtered by them.
 *
 * A route that names no rule refuses the chain.
 */
export type OwnResourcesRule = 'unaffected' | 'resource' | 'listing'

/**
 * Whether a Resource is the principals' own: every principal appears in its
 * `createdBy` list. A Resource with no `createdBy` is no one's own. With no
 * principals there is no caveat to hold, and the answer is `true`.
 *
 * @param options {object}
 * @param [options.ownedBy] {IDID[]}   the principals, one per caveat
 * @param [options.createdBy] {unknown}   the stored record's `createdBy`
 * @returns {boolean}
 */
export function ownsResource({
  ownedBy,
  createdBy
}: {
  ownedBy?: IDID[]
  createdBy?: unknown
}): boolean {
  if (ownedBy === undefined || ownedBy.length === 0) {
    return true
  }
  if (!Array.isArray(createdBy)) {
    return false
  }
  return ownedBy.every(principal => createdBy.includes(principal))
}

/**
 * Refuses a write or a delete under `OwnResourcesOnly` caveats when the
 * record it found is not the principals' own (`ownsResource`). A backend
 * calls it inside the critical section, from the record read there, before
 * anything else the request decides from that record. With no principals it
 * passes.
 *
 * @param options {object}
 * @param [options.ownedBy] {IDID[]}   the principals, one per caveat
 * @param [options.createdBy] {unknown}   the stored record's `createdBy`
 * @returns {void}
 * @throws {NotOwnResourceError}
 */
export function assertOwnsResource({
  ownedBy,
  createdBy
}: {
  ownedBy?: IDID[]
  createdBy?: unknown
}): void {
  if (!ownsResource({ ownedBy, createdBy })) {
    throw new NotOwnResourceError()
  }
}

/**
 * The principal of one caveat: the controller of the capability that carries
 * it, in the form a `createdBy` list records a delegated controller. Resolves
 * `undefined` for a capability with more than one controller, or one that is
 * not a DID this server could have verified.
 *
 * @param options {object}
 * @param options.capability {object}   the capability carrying the caveat
 * @param options.serverUrl {string}   this server's base URL
 * @returns {IDID | undefined}
 */
function principalOf({
  capability,
  serverUrl
}: {
  capability: object
  serverUrl: string
}): IDID | undefined {
  const controllers = asList(
    (capability as { controller?: unknown }).controller
  )
  const [controller] = controllers
  return controllers.length === 1 && typeof controller === 'string'
    ? verifiableDidOf({ id: controller, serverUrl })
    : undefined
}

/**
 * Whether every proof on a capability is an `eddsa-jcs-2022` Data Integrity
 * proof. That suite signs the capability's JSON as written, so the caveat
 * object is covered by the signature.
 *
 * @param options {object}
 * @param options.capability {object}   the capability carrying the caveat
 * @returns {boolean}
 */
function signedWithJcs({ capability }: { capability: object }): boolean {
  const proofs = asList(
    (capability as { proof?: unknown }).proof as
      { type?: unknown; cryptosuite?: unknown } | undefined
  )
  return (
    proofs.length > 0 &&
    proofs.every(
      entry =>
        entry?.type === 'DataIntegrityProof' &&
        entry.cryptosuite === 'eddsa-jcs-2022'
    )
  )
}

/**
 * The `supportedCaveats` map a verification passes to the zcap library. It
 * registers `OwnResourcesOnly` alone, so a chain with any other caveat type
 * is refused by the library before a proof is verified.
 *
 * The handler refuses a caveat when the route names no rule, when the caveat
 * object carries a member besides `type`, when the capability carrying it is
 * not signed with `eddsa-jcs-2022`, or when that capability has no single
 * principal. Each refusal fails the chain, which the caller answers as the
 * masked `not-found`.
 *
 * @param options {object}
 * @param [options.rule] {OwnResourcesRule}   how the route answers a chain
 *   carrying the caveat; absent, the chain is refused
 * @param options.serverUrl {string}   this server's base URL
 * @returns {Map<string, CaveatHandler>}
 */
export function ownResourcesCaveats({
  rule,
  serverUrl
}: {
  rule?: OwnResourcesRule
  serverUrl: string
}): Map<string, CaveatHandler> {
  const handler: CaveatHandler = async ({ caveat, capability }) => {
    const valid =
      rule !== undefined &&
      Object.keys(caveat).every(member => member === 'type') &&
      signedWithJcs({ capability }) &&
      principalOf({ capability, serverUrl }) !== undefined
    return { valid }
  }
  return new Map([[OWN_RESOURCES_ONLY, handler]])
}

/**
 * The principals a verified chain's `OwnResourcesOnly` caveats name, one per
 * caveat, in chain order. Resolves `undefined` when the chain carries none,
 * or when the route's rule leaves the request unaffected.
 *
 * @param options {object}
 * @param [options.rule] {OwnResourcesRule}   the route's rule
 * @param [options.caveats] {CapabilityCaveat[]}   the verified result's
 *   caveats
 * @param options.serverUrl {string}   this server's base URL
 * @returns {IDID[] | undefined}
 * @throws {UnauthorizedError}   a caveat names no single principal
 */
export function ownResourcesPrincipals({
  rule,
  caveats = [],
  serverUrl
}: {
  rule?: OwnResourcesRule
  caveats?: CapabilityCaveat[]
  serverUrl: string
}): IDID[] | undefined {
  if (rule !== 'resource' && rule !== 'listing') {
    return undefined
  }
  const principals: IDID[] = []
  for (const { caveat, capability } of caveats) {
    if (caveat.type !== OWN_RESOURCES_ONLY) {
      continue
    }
    const principal = principalOf({ capability, serverUrl })
    // The handler refused a chain with such a capability, so a verified
    // result never reaches this. The request is refused if one does.
    if (principal === undefined) {
      throw new UnauthorizedError({})
    }
    principals.push(principal)
  }
  return principals.length > 0 ? principals : undefined
}

/**
 * Whether a verified chain that carries an `OwnResourcesOnly` caveat could
 * record a `createdBy` list. A create records the controller of every
 * delegated capability in the chain, and records none when one of them names
 * no single DID. A Resource created under such a chain would be no one's own,
 * so its creator could never reach it again. A chain with no
 * `OwnResourcesOnly` caveat passes.
 *
 * @param options {object}
 * @param [options.caveats] {CapabilityCaveat[]}   the verified result's
 *   caveats
 * @param options.delegatedControllers {Array<string | string[]>}   the
 *   controller of each delegated capability in the chain, in delegation order
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
export function caveatChainRecordsCreators({
  caveats = [],
  delegatedControllers,
  serverUrl
}: {
  caveats?: CapabilityCaveat[]
  delegatedControllers: Array<string | string[]>
  serverUrl: string
}): boolean {
  if (!caveats.some(({ caveat }) => caveat.type === OWN_RESOURCES_ONLY)) {
    return true
  }
  return (
    delegationChainDids({ entries: delegatedControllers, serverUrl }) !==
    undefined
  )
}
