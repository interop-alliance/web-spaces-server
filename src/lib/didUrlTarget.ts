/**
 * Dereference of a capability `invocationTarget` that is a `did:webvh` DID
 * URL, such as `did:webvh:<scid>:<host>/photos/cat.jpg`, to the URL it
 * dereferences to.
 *
 * The DID URL is split by `parseDidUrl` of `@interop/did-method-webvh`. The
 * DID's document is resolved, the `PathHandler` service whose `path` is the
 * longest complete match of the DID URL path is selected, and the rest of the
 * path is appended to that service's `serviceEndpoint` (`selectPathHandler`
 * and `pathHandlerUrl` of the same package). A target that is not a `did:`
 * URL is already the URL it names and is returned as it is.
 *
 * A version selector on the target (`versionId`, `versionNumber`,
 * `versionTime`) chooses which version of the document maps the path. An
 * unpinned target is mapped by the current document. Either way the document
 * comes from the history log this server stores for the DID, self-hosted or
 * a replicated copy, through the local resolver's cache
 * (`resolveStoredWebvhLog`). A pinned version is resolved from that same
 * verified log, so the head-record, deactivation, SCID, hash-chain and
 * no-witness rules of the current log apply to it as well. The verification
 * of a pinned version is kept with the verified log it was made from
 * ({@link verifiedVersionOf}), so requests under one pin read the log once
 * per verified read of it, not once per request.
 *
 * One dereferencer serves one verification. It memoizes the document per DID
 * and selector set, so every target the verification dereferences under one
 * (DID, selectors) pair is mapped by one document version, however often the
 * log is written meanwhile. It also memoizes the outcome per target string,
 * so the checks of one verification that read the same target map it once.
 *
 * A DID this server stores no log for is refused, unless the caller passes
 * `resolveNotHosted`, the seam a network resolver plugs into. With
 * `refetchNotHosted` as well, a caller may ask once more for such a DID's
 * document ({@link createTargetDereferencer}'s `refetch`), when a target it
 * maps does not dereference where the verification requires.
 *
 * Every refusal is the masked `UnauthorizedError`, its reason kept as the
 * `cause`. A server-side fault, such as a storage error reading the log, is
 * rethrown as it is, so it keeps its 5xx.
 *
 * The module also holds the two rules a chain rooted in a DID URL is held to
 * beyond the zcap library's own: the form a root's DID URL may take
 * ({@link isDidUrlRootTarget}) and the chain inspector that checks where
 * each link's target dereferences to ({@link didUrlChainInspector}). An
 * inspector written for https targets reads such a chain through
 * {@link withDereferencedTargets}.
 */
import {
  parseDidUrl,
  pathHandlerUrl,
  selectPathHandler
} from '@interop/did-method-webvh'
import type { DIDDoc, DIDLog } from '@interop/did-method-webvh'
import type { InspectCapabilityChain } from '@interop/zcap'

import { isServerFault, UnauthorizedError } from '../errors.js'
import { isUnderScope } from './isUnderScope.js'
import { resolveStoredWebvhLog, verifyWebvhLog } from './webvhController.js'
import type {
  TargetSelectors,
  WebvhResolverContext
} from './webvhController.js'

export type { TargetSelectors } from './webvhController.js'

/**
 * How many selector sets keep their verified version per verified log. A
 * `versionTime` takes any value, so the number is fixed, and the selector set
 * used least recently is dropped past it.
 */
const PINNED_VERSIONS_PER_LOG = 8

/**
 * The verification of each pinned version, per verified log and selector
 * set, keyed by the log array a resolver's cache entry holds. A resolver
 * builds a new array on each full verification of a log, so a write that
 * changes the log (an append among them) yields a new array, and the
 * versions verified from the old one go with it. Weakly held, so the
 * versions of a log leave memory when the cache entry that held it does.
 */
const pinnedVersions = new WeakMap<
  DIDLog,
  Map<string, Promise<{ doc: DIDDoc; deactivated: boolean }>>
>()

/**
 * The version of a DID's document that `selectors` names, verified from a
 * log a resolver already verified as the DID's current log. It is
 * `verifyWebvhLog` with selectors, run once per log array and selector set
 * and then kept with that array ({@link pinnedVersions}), so each later
 * request under the same pin reads the outcome the one full verification
 * produced for those exact log entries and those exact selectors. A refusal
 * is kept as well: it follows from the log and the selectors alone, so a pin
 * that names no version costs one verification per log too.
 *
 * At most {@link PINNED_VERSIONS_PER_LOG} selector sets are kept per log.
 *
 * @param options {object}
 * @param options.did {string}   the DID the log resolves to
 * @param options.log {DIDLog}   the verified log, as the resolver's cache
 *   entry holds it. It must not be mutated
 * @param options.selectors {TargetSelectors}   at least one version selector
 * @returns {Promise<{ doc: DIDDoc, deactivated: boolean }>}
 */
export function verifiedVersionOf({
  did,
  log,
  selectors
}: {
  did: string
  log: DIDLog
  selectors: TargetSelectors
}): Promise<{ doc: DIDDoc; deactivated: boolean }> {
  const { versionId, versionNumber, versionTime } = selectors
  // Each selector by its parsed value. A `versionTime` is keyed by its
  // milliseconds, which tells an invalid date (`NaN`) from an absent one.
  const key = JSON.stringify([
    did,
    versionId ?? null,
    versionNumber ?? null,
    versionTime === undefined ? null : String(versionTime.getTime())
  ])
  let versions = pinnedVersions.get(log)
  if (versions === undefined) {
    versions = new Map()
    pinnedVersions.set(log, versions)
  }
  let version = versions.get(key)
  if (version !== undefined) {
    // Re-inserted, so the Map's order is least recently used first.
    versions.delete(key)
    versions.set(key, version)
    return version
  }
  version = verifyWebvhLog({ did, log, selectors })
  versions.set(key, version)
  if (versions.size > PINNED_VERSIONS_PER_LOG) {
    const [leastRecent] = versions.keys()
    versions.delete(leastRecent!)
  }
  return version
}

/**
 * Turns a capability's `invocationTarget` into the URL it dereferences to:
 * the `dereference` of {@link createTargetDereferencer}.
 */
export type DereferenceTarget = (options: { target: string }) => Promise<string>

/**
 * What one verification of a chain rooted in a DID URL carries: the admitted
 * root capability id, the Space URL it must dereference to, the dereferencer
 * every check of the verification shares, so one request reads one document
 * version per DID and selector set, the URL the root dereferences to as the
 * verification settled it (`didUrlVerificationFor` in `zcap.ts`), and the
 * chains the DID URL chain inspector passed.
 */
export interface DidUrlVerification {
  rootId: string
  spaceUrl: string
  dereference: DereferenceTarget
  rootUrl: () => Promise<string>
  inspected: WeakSet<object>
}

/**
 * Builds the target dereferencer of one verification.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.serverBackends {ServerBackends}   the set it belongs to
 * @param options.serverUrl {string}   this server's base URL
 * @param [options.resolveNotHosted] {Function}   resolves the document of a
 *   `did:webvh` this server stores no log for, at the version `selectors`
 *   names (the current one when there are none). Absent, such a DID is
 *   refused
 * @param [options.refetchNotHosted] {Function}   asks for a fresh document
 *   of such a DID, resolving whether one was fetched. Absent, `refetch`
 *   fetches nothing
 * @returns {{ dereference: DereferenceTarget,
 *   refetch: (options: { target: string }) => Promise<boolean>,
 *   forget: (options: { did: string }) => void }}
 *   `dereference` maps a target; `refetch` refreshes the document of the DID
 *   a target names, when it is one `resolveNotHosted` resolved, drops what
 *   this dereferencer read for it, and resolves whether it did; `forget`
 *   drops what this dereferencer read for a DID, for a caller that fetched
 *   a fresh log of it
 */
export function createTargetDereferencer({
  storage,
  serverBackends,
  serverUrl,
  resolveNotHosted,
  refetchNotHosted
}: Omit<WebvhResolverContext, 'peer'> & {
  resolveNotHosted?: (options: {
    did: string
    selectors: TargetSelectors
  }) => Promise<DIDDoc>
  refetchNotHosted?: (options: { did: string }) => Promise<boolean>
}): {
  dereference: DereferenceTarget
  refetch: (options: { target: string }) => Promise<boolean>
  forget: (options: { did: string }) => void
} {
  const documents = new Map<string, Promise<DIDDoc>>()
  // The outcome of mapping each DID URL, by target string. A target's
  // outcome follows from the memoized document alone, so a failure is kept
  // like a URL, until `refetch` drops the DID's documents.
  const urls = new Map<string, Promise<string>>()
  // The DIDs whose documents came through `resolveNotHosted`.
  const notHosted = new Set<string>()

  /**
   * The document that maps a target's path: the selected version of the
   * DID's document, read once per (DID, selectors) for this dereferencer.
   *
   * @param options {object}
   * @param options.did {string}
   * @param options.selectors {TargetSelectors}
   * @returns {Promise<DIDDoc>}
   */
  function documentOf({
    did,
    selectors
  }: {
    did: string
    selectors: TargetSelectors
  }): Promise<DIDDoc> {
    // The parsed selectors, so two encodings of one selector set share a
    // document. A `versionTime` serializes as its ISO 8601 form.
    const key = `${did}?${JSON.stringify(selectors)}`
    let document = documents.get(key)
    if (document === undefined) {
      document = resolveDocument({ did, selectors })
      documents.set(key, document)
    }
    return document
  }

  /**
   * Resolves the selected version of a DID's document, without the memo.
   *
   * @param options {object}
   * @param options.did {string}
   * @param options.selectors {TargetSelectors}
   * @returns {Promise<DIDDoc>}
   */
  async function resolveDocument({
    did,
    selectors
  }: {
    did: string
    selectors: TargetSelectors
  }): Promise<DIDDoc> {
    const stored = await resolveStoredWebvhLog({
      storage,
      serverBackends,
      serverUrl,
      did
    })
    if (stored === undefined) {
      if (resolveNotHosted === undefined) {
        throw new Error(
          `"${did}" is not a did:webvh DID whose history log this server ` +
            'stores.'
        )
      }
      notHosted.add(did)
      return await resolveNotHosted({ did, selectors })
    }
    if (Object.keys(selectors).length === 0) {
      return stored.doc
    }
    const { doc, deactivated } = await verifiedVersionOf({
      did,
      log: stored.log,
      selectors
    })
    if (deactivated) {
      throw new Error(`The DID "${did}" has been deactivated.`)
    }
    return doc
  }

  /**
   * Maps a `did:webvh` DID URL to the URL it dereferences to, once per target
   * string for this dereferencer.
   *
   * @param options {object}
   * @param options.target {string}
   * @returns {Promise<string>}
   */
  function dereferenceDidUrl({ target }: { target: string }): Promise<string> {
    let url = urls.get(target)
    if (url === undefined) {
      url = mapDidUrl({ target })
      urls.set(target, url)
    }
    return url
  }

  /**
   * Maps a `did:webvh` DID URL to the URL it dereferences to, without the
   * memo.
   *
   * @param options {object}
   * @param options.target {string}
   * @returns {Promise<string>}
   */
  async function mapDidUrl({ target }: { target: string }): Promise<string> {
    if (!target.startsWith('did:webvh:')) {
      throw new Error(`The target "${target}" is not a did:webvh DID URL.`)
    }
    const { did, path, fragment, ...selectors } = parseDidUrl(target)
    // `parseDidUrl` leaves out an empty fragment, which is still a fragment.
    if (fragment !== undefined || target.includes('#')) {
      throw new Error(`The target "${target}" carries a fragment.`)
    }
    if (path === '') {
      throw new Error(`The target "${target}" has no path to dereference.`)
    }
    const doc = await documentOf({ did, selectors })
    const selection = selectPathHandler(doc, path)
    if (selection === undefined) {
      throw new Error(
        `No PathHandler service in the document of "${did}" matches the ` +
          `path "${path}".`
      )
    }
    return pathHandlerUrl(selection)
  }

  /**
   * Turns an `invocationTarget` into the URL it dereferences to.
   *
   * @param options {object}
   * @param options.target {string}   the capability's `invocationTarget`
   * @returns {Promise<string>}
   */
  async function dereference({ target }: { target: string }): Promise<string> {
    if (!target.startsWith('did:')) {
      return target
    }
    try {
      return await dereferenceDidUrl({ target })
    } catch (err) {
      if (isServerFault(err)) {
        throw err
      }
      throw new UnauthorizedError({ cause: err as Error })
    }
  }

  /**
   * Refreshes the document of the DID a target names, when this dereferencer
   * read it through `resolveNotHosted`, and drops every document it read for
   * that DID and every target it mapped under it, so the next dereference
   * reads the fresh one.
   *
   * @param options {object}
   * @param options.target {string}   a DID URL
   * @returns {Promise<boolean>}   whether a fresh document was fetched
   */
  async function refetch({ target }: { target: string }): Promise<boolean> {
    if (refetchNotHosted === undefined || !target.startsWith('did:webvh:')) {
      return false
    }
    const { did } = parseDidUrl(target)
    if (!notHosted.has(did) || !(await refetchNotHosted({ did }))) {
      return false
    }
    forget({ did })
    return true
  }

  /**
   * Drops every document this dereferencer read for a DID and every target
   * it mapped under it, so the next dereference reads the document again.
   *
   * @param options {object}
   * @param options.did {string}
   * @returns {void}
   */
  function forget({ did }: { did: string }): void {
    for (const key of [...documents.keys()]) {
      if (key.startsWith(`${did}?`)) {
        documents.delete(key)
      }
    }
    // `parseDidUrl` reads the DID as everything before the first `/`, `?` or
    // `#`.
    for (const key of [...urls.keys()]) {
      if (
        key.startsWith(did) &&
        ['', '/', '?', '#'].includes(key.charAt(did.length))
      ) {
        urls.delete(key)
      }
    }
  }

  return { dereference, refetch, forget }
}

/**
 * Whether a root capability's decoded target has the form a DID URL root may
 * take: a `did:webvh` DID URL with a path that ends in `/`, and no selector
 * and no fragment. A root carries no selector, so it is always read from the
 * DID's current document, and a repoint of its `PathHandler` moves every
 * chain beneath it.
 *
 * @param options {object}
 * @param options.target {string}   the decoded root invocation target
 * @returns {boolean}
 */
export function isDidUrlRootTarget({ target }: { target: string }): boolean {
  if (!target.startsWith('did:webvh:') || /[?#]/.test(target)) {
    return false
  }
  return parseDidUrl(target).path.endsWith('/')
}

/**
 * Builds the chain inspector of a verification whose chain roots in a DID URL
 * root capability. The chain passes when:
 *
 * - its root is the root capability the verification admitted, `rootId`;
 * - the root's target dereferences to exactly `spaceUrl`, the canonical
 *   trailing-slash URL of the Space the request addresses, compared byte for
 *   byte;
 * - every delegated link's target is a DID URL, and dereferences to a URL at
 *   or beneath the URL its parent's target dereferences to (the root's, for
 *   the first link), in a form a URL parser leaves unchanged. A target whose
 *   dereferenced path carries a dot segment, or any other form a parser
 *   rewrites, is refused.
 *
 * Each link is bounded by its parent, and the root by the Space URL, so every
 * link stays inside the Space. This is the attenuation rule of an https chain,
 * applied to the dereferenced URLs. A link may dereference through a
 * different `PathHandler` than its parent did, so a document may alias a path
 * within what the parent reaches. A handler that maps a path beneath a grant
 * to a URL outside what that grant reaches does not widen the grant: the
 * `PathHandler` with the longest matching path is selected, so a delegate
 * could otherwise narrow its grant's DID URL onto a handler that maps
 * somewhere wider.
 *
 * The zcap library checks that the links attenuate one another as DID URLs,
 * path and selectors apart, and that the request URL attenuates the invoked
 * link's dereferenced target. This inspector adds where each link may reach.
 *
 * A chain that passes is added to `inspected`, so the verification can
 * confirm afterwards that this inspection ran on the chain it verified.
 *
 * @param options {DidUrlVerification}
 * @param options.rootId {string}   the admitted DID URL root capability id
 * @param options.spaceUrl {string}   the Space's canonical trailing-slash URL
 * @param options.rootUrl {() => Promise<string>}   the URL the root's target
 *   dereferences to, as the verification settled it. It resolves the same
 *   promise until the verification fetches a fresh log, which is how the
 *   inspector learns the root was settled again
 * @param options.dereference {DereferenceTarget}   the verification's
 *   dereferencer
 * @param options.inspected {WeakSet<object>}   collects each chain that
 *   passed
 * @returns {InspectCapabilityChain}
 */
export function didUrlChainInspector({
  rootId,
  spaceUrl,
  rootUrl: rootUrlOf,
  dereference,
  inspected
}: DidUrlVerification): InspectCapabilityChain {
  return async ({ capabilityChain }) => {
    try {
      const [, ...links] = capabilityChain
      const notAdmitted = unadmittedRootError({ capabilityChain, rootId })
      if (notAdmitted !== undefined) {
        throw notAdmitted
      }
      // A link pinned to a version after the cached log may fetch a fresh
      // log while the links are read, and the root is then settled again.
      // The chain is read once more against the fresh log, so the root and
      // every link are decided from one state of it.
      let settled = false
      for (let pass = 0; pass < 2 && !settled; pass++) {
        const rootSettling = rootUrlOf()
        const rootUrl = await rootSettling
        if (rootUrl !== spaceUrl || !spaceUrl.endsWith('/')) {
          throw new Error(
            `The root capability's target dereferences to "${rootUrl}", ` +
              `not to the Space URL "${spaceUrl}".`
          )
        }
        let parentUrl = rootUrl
        for (const link of links) {
          const target = link.invocationTarget
          if (typeof target !== 'string' || !target.startsWith('did:')) {
            throw new Error(
              'Every capability beneath a DID URL root must carry a DID ' +
                'URL invocationTarget.'
            )
          }
          const url = await dereference({ target })
          if (!isCanonicalUrlWithin({ url, parentUrl })) {
            throw new Error(
              `The target "${target}" dereferences to "${url}", which is ` +
                `not a URL at or beneath "${parentUrl}", the URL its ` +
                "parent's target dereferences to."
            )
          }
          parentUrl = url
        }
        settled = rootUrlOf() === rootSettling
      }
      if (!settled) {
        throw new Error(
          'The DID URL chain was read against a log that changed twice ' +
            'during one verification.'
        )
      }
    } catch (err) {
      // A server-side fault is found in the result by the caller and keeps
      // its 5xx.
      return { valid: false, error: err as Error }
    }
    inspected.add(capabilityChain)
    return { valid: true }
  }
}

/**
 * The refusal of a chain that does not root in the root capability a
 * verification admitted, or `undefined` when it does.
 *
 * @param options {object}
 * @param options.capabilityChain {Array<{ id?: string }>}   the dereferenced
 *   chain, root first
 * @param options.rootId {string}   the admitted DID URL root capability id
 * @returns {Error | undefined}
 */
export function unadmittedRootError({
  capabilityChain,
  rootId
}: {
  capabilityChain: Array<{ id?: string }>
  rootId: string
}): Error | undefined {
  if (capabilityChain[0]?.id === rootId) {
    return undefined
  }
  return new Error(
    `The chain does not root in the admitted root capability "${rootId}".`
  )
}

/**
 * Wraps a chain inspector that decides on https targets, so it can read a
 * chain rooted in a DID URL. The wrapped inspector is handed a copy of the
 * chain details in which every capability carries the URL its
 * `invocationTarget` dereferences to. The capabilities themselves are left
 * as they are, and so is everything else in the details.
 *
 * @param options {object}
 * @param options.dereference {DereferenceTarget}   the verification's
 *   dereferencer
 * @param options.inspector {InspectCapabilityChain}   the inspector to wrap
 * @returns {InspectCapabilityChain}
 */
export function withDereferencedTargets({
  dereference,
  inspector
}: {
  dereference: DereferenceTarget
  inspector: InspectCapabilityChain
}): InspectCapabilityChain {
  return async details => {
    const capabilityChain = await Promise.all(
      details.capabilityChain.map(async capability =>
        typeof capability.invocationTarget === 'string'
          ? {
              ...capability,
              invocationTarget: await dereference({
                target: capability.invocationTarget
              })
            }
          : capability
      )
    )
    return await inspector({ ...details, capabilityChain })
  }
}

/**
 * Whether a dereferenced URL is its parent's dereferenced URL or a URL beneath
 * it at a `/` boundary, in a form a URL parser leaves unchanged. The parser
 * removes `.` and `..` segments (their percent-encoded forms too) and
 * rewrites a `\` as a `/`, so a URL it would change could name a resource
 * outside the prefix it appears to carry. The parent's URL passed the same
 * test, or is the Space URL.
 *
 * @param options {object}
 * @param options.url {string}   the link's dereferenced URL
 * @param options.parentUrl {string}   the parent's dereferenced URL
 * @returns {boolean}
 */
function isCanonicalUrlWithin({
  url,
  parentUrl
}: {
  url: string
  parentUrl: string
}): boolean {
  if (!URL.canParse(url) || new URL(url).href !== url) {
    return false
  }
  return isUnderScope({ target: url, rootTarget: parentUrl })
}
