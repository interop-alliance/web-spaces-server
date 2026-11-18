/**
 * Import Space's gate on archived zcap revocation records. An archive's
 * `.revocations/` entries are installed in the destination Space's revocation
 * store one by one, after the rest of the archive is written, and each only
 * when two checks pass. The record's capability chain verifies under the
 * destination Space, through the same `verifyRevocationChain` the revocation
 * route runs. And the import's own invocation could have submitted that
 * revocation on the route: a root invocation by the Space controller, an
 * invoker the chain names as a controller, or a delegated capability that
 * reaches the revocation URL with `POST`. The record's `meta` is then rebuilt
 * server-side, so nothing the archive says about the delegator, the scope, or
 * the GC horizon is stored.
 *
 * A record that fails either check is skipped, and the import goes on. A
 * revocation is a fact about a chain rooted in a Space URL. A chain that does
 * not root in the destination Space could not be invoked there, so its
 * revocation is moot. An unverifiable record is also what a forged archive
 * would carry, and a revocation cannot be undone. Without the second check a
 * holder of any import grant could revoke another party's genuine capability
 * by packing its public document into an archive.
 *
 * The gate runs after the backend's `importSpace`, since a chain may carry a
 * link signed by a `did:webvh` whose history log the archive itself restores.
 */
import type { FastifyBaseLogger } from 'fastify'
import {
  isUnderScope,
  throwIfServerFault,
  verifyRevocationChain
} from '../zcap.js'
import type { VerifiedInvocation } from '../zcap.js'
import { DuplicateRevocationError, InvalidRevocationError } from '../errors.js'
import { asList } from './chainCapability.js'
import { absoluteUrl, spaceRevocationsPath } from './paths.js'
import { revocationRecordFor } from './revocations.js'
import type { WebvhResolverContext } from './webvhController.js'
import type { IDID, RevocationRecord, StorageBackend } from '../types.js'

/**
 * The destination Space's revocation scope: what an archived record's chain
 * must root in, the bounds the revocation route verifies under, and the
 * import's own verified invocation.
 */
export interface ImportRevocationScope {
  /**
   * the destination Space's id
   */
  spaceId: string
  /**
   * the destination Space's canonical trailing-slash URL
   */
  rootTarget: string
  /**
   * the destination Space's controller
   */
  rootController: IDID
  /**
   * resolver context for a `did:webvh` link in a chain
   */
  webvh: WebvhResolverContext
  /**
   * the import's verified invocation, which decides what it may revoke
   */
  invocation: Pick<
    VerifiedInvocation,
    'rootInvocation' | 'invoker' | 'invokedCapability'
  >
}

/**
 * Whether the import's invocation could have submitted a revocation of the
 * capability on the revocation route, under that route's dual-root rule. A
 * root invocation is the Space controller's, who may revoke anything
 * delegated from the Space. An invoker the verified chain names as a
 * controller may revoke its own grant or one below it. A delegated
 * capability may do so when it reaches the revocation URL, by the zcap
 * library's `/`-boundary attenuation rule, with `POST` among its actions, or
 * with no `allowedAction`, which admits every action.
 *
 * @param options {object}
 * @param options.invocation {VerifiedInvocation}   the import's invocation
 * @param options.chainControllers {string[]}   every controller in the
 *   revoked capability's verified chain
 * @param options.revocationUrl {string}   the capability's revocation URL
 * @returns {boolean}
 */
function invocationMayRevoke({
  invocation: { rootInvocation, invoker, invokedCapability },
  chainControllers,
  revocationUrl
}: {
  invocation: ImportRevocationScope['invocation']
  chainControllers: string[]
  revocationUrl: string
}): boolean {
  if (rootInvocation) {
    return true
  }
  if (invoker !== undefined && chainControllers.includes(invoker)) {
    return true
  }
  const { invocationTarget, allowedAction } = invokedCapability ?? {}
  if (invocationTarget === undefined) {
    return false
  }
  const actions = asList(allowedAction)
  return (
    isUnderScope({ target: revocationUrl, rootTarget: invocationTarget }) &&
    (actions.length === 0 || actions.includes('POST'))
  )
}

/**
 * Installs the archived revocation records the import may install, each
 * verified against the destination Space and rebuilt with server-side `meta`
 * (`revocationRecordFor`). A record is skipped with no log line when its
 * capability has expired (the chain could not verify, and the record would
 * be at its GC horizon within a day), when another record of the same
 * capability came before it, or when the store already holds it. A chain
 * that does not verify under the Space (rooted elsewhere, a bad or missing
 * proof, a root capability, which carries no chain, a shape the verifier
 * cannot read), or an invocation that could not submit the revocation is
 * skipped with one `warn` line naming the capability id. A server-side fault met while verifying or
 * storing is rethrown.
 *
 * @param options {object}
 * @param options.capabilities {RevocationRecord['capability'][]}   the
 *   archive's revoked capabilities, as parsed
 * @param options.scope {ImportRevocationScope}   the destination Space's scope
 * @param options.storage {StorageBackend}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ installed: number, skipped: number }>}
 */
export async function installImportRevocations({
  capabilities,
  scope,
  storage,
  logger
}: {
  capabilities: RevocationRecord['capability'][]
  scope: ImportRevocationScope
  storage: StorageBackend
  logger: FastifyBaseLogger
}): Promise<{ installed: number; skipped: number }> {
  const { spaceId, rootTarget, rootController, webvh, invocation } = scope
  const now = Date.now()
  const seen = new Set<string>()
  let installed = 0
  let skipped = 0
  for (const capability of capabilities) {
    const capabilityId = capability.id
    const expiresMs = capability.expires ? Date.parse(capability.expires) : NaN
    if (seen.has(capabilityId) || expiresMs <= now) {
      skipped += 1
      continue
    }
    seen.add(capabilityId)
    try {
      const { delegator, chainControllers } = await verifyRevocationChain({
        capability,
        rootTarget,
        rootController,
        webvh
      })
      const revocationUrl = absoluteUrl({
        path: spaceRevocationsPath({ spaceId, revocationId: capabilityId }),
        serverUrl: webvh.serverUrl
      })
      if (
        !invocationMayRevoke({ invocation, chainControllers, revocationUrl })
      ) {
        throw new InvalidRevocationError({
          detail:
            'The import invocation could not submit this revocation on the' +
            ' revocation route.'
        })
      }
      await storage.insertRevocation({
        scope: { spaceId },
        record: revocationRecordFor({ capability, delegator, rootTarget })
      })
      installed += 1
    } catch (err) {
      skipped += 1
      if (err instanceof DuplicateRevocationError) {
        continue
      }
      throwIfServerFault({ error: err })
      logger.warn(
        { err, capabilityId },
        'Skipping an archived revocation the import may not install.'
      )
    }
  }
  return { installed, skipped }
}
