/**
 * The container rule -- the third `inspectCapabilityChain` inspector, beside
 * the revocation one (`lib/revocations.ts`) and the client-annex clause
 * (`lib/clientAnnexClause.ts`).
 *
 * An unsafe method at a container URL -- a Space or a Collection -- is
 * controller-only, with two exceptions. The hazard is the prefix one: a data
 * grant's `invocationTarget` IS the container URL, so the zcap library's
 * `/`-boundary target attenuation separates deleting a Resource under a
 * Collection from deleting the Collection itself in no way at all. Under the
 * v0.5 layout the Space Metadata object sits at `/space/<S>/meta` and Delete
 * Space is `DELETE /space/<S>/`, so a Space-subtree grant reaches both by
 * ordinary attenuation. This rule is the route-level answer: it reads the
 * shape of the invoked capability -- the chain's tail -- and nothing about
 * who signed any link, so it holds whatever DID method the controller or any
 * delegator uses. It is not the whole answer for Delete Space: the
 * client-annex clause adds two signer-keyed bounds on top of it (below).
 *
 * Four rules, spread over twelve protected operations:
 *
 * - `controller-only` -- only a direct root-capability invocation passes. A
 *   delegated capability is refused whatever its `allowedAction`. Used by
 *   `PUT /space/<S>/meta` on an existing Space, by `DELETE /space/<S>/<C>/`,
 *   and by Update Keystore (`POST /kms/keystores/<K>`), whose `controller`
 *   rewrite is the keystore analogue of the Space Metadata one: a keystore
 *   `write` grant, or an action-less one, would otherwise hand its holder
 *   every key in the keystore. It turns on nothing but whether the
 *   `Capability-Invocation` header embeds a delegated capability, so
 *   `handleZcapVerify` decides it from that header before any verification
 *   work; the inspector refuses the same chains as a backstop. The other two
 *   rules read the dereferenced chain's tail.
 * - `exact-delete` -- a direct root invocation, or a delegated capability
 *   whose tail targets exactly the Space's canonical trailing-slash URL with
 *   `allowedAction` exactly `['DELETE']`. A whole-action-set grant carrying
 *   DELETE is a data grant and is refused; a single-verb DELETE grant is not.
 *   Used by `DELETE /space/<S>/`.
 * - `space-subtree-put` -- a direct root invocation, or a delegated capability
 *   whose tail targets exactly the Space's canonical trailing-slash URL (the
 *   shape a wallet's generation delegation carries). The library already
 *   checks that the action covers the invoked verb. A capability targeting the
 *   Collection container URL, the Metadata or log URL, or a Resource URL is
 *   refused. Used by `PUT /space/<S>/<C>/meta`, which writes the Collection's
 *   configuration and creates the Collection when absent, and by
 *   `PUT /space/<S>/<C>/meta/log`, the guarded create of the Collection's
 *   governing history log (which from then on derives the Collection's served
 *   `encryption` descriptor, and refuses every direct `encryption` write).
 * - `replicas-subtree` -- a direct root invocation, or a delegated capability
 *   whose tail targets the Space's replicas URL `/space/<S>/replicas` or a URL
 *   beneath it. Used by every replicas route, the reads included. A grant on
 *   the Space URL, the shape an app's data grant carries, reaches the replicas
 *   URL by attenuation and would otherwise list the Space's pull capabilities,
 *   pause its pull loops and remove its registrations. The rule keeps such a
 *   grant out and admits the maintenance grant the client-annex clause's
 *   seventh shape describes, whose target is the replicas URL itself.
 *
 * Create Collection (`POST /space/<S>/`) carries no rule: it stays
 * exact-target delegable. An app holding a Collection-scoped grant (a wallet
 * delegates one Collection, not the Space) does not write that Collection's
 * Metadata object. Its index and `encryption` declarations are written by the
 * controller, or under a grant on the Space URL.
 *
 * The tail alone is read, not every link. A wallet mints a DELETE-only child
 * of a two-verb management parent and invokes the child; that shape stays
 * admitted, and it is the invoked grant that says what the caller may do. The
 * client-annex clause's two invocation-time bounds read the signers instead:
 * `ladderInvocationRefusal` reads the ladder-signed links, because that bound
 * is a statement about what a ladder verification method signed, and the
 * transient-annex bound refuses a Space DELETE under any link signed by a
 * per-visit annex key. The three compose: this rule refuses first (it is the
 * cheapest check, and needs no resolution), and the clause still refuses a
 * ladder-signed or transient-annex-signed chain that this rule would admit.
 *
 * A refusal binds the capability decision only, like every other chain
 * inspection failure. Every protected handler is capability-only, so a
 * refusal surfaces as the ordinary masked `not-found` denial.
 */
import type { InspectCapabilityChain } from '@interop/zcap'
import { actionsExactly, type ChainCapability } from './chainCapability.js'
import { REPLICAS_SEGMENT } from './paths.js'

/**
 * Which container rule one verification applies.
 */
export type ContainerRule =
  'controller-only' | 'exact-delete' | 'space-subtree-put' | 'replicas-subtree'

/**
 * Builds the container-rule inspection hook for one verification: the whole
 * decision, for all four rules. A chain of length one is the synthesized
 * root alone -- a direct root invocation -- and always passes. The zcap
 * library runs the hook on that chain too, so the root case needs no separate
 * treatment at the call site. `controller-only` refuses every longer chain;
 * `handleZcapVerify` reaches the same verdict off the invocation header
 * before any verification work, so for that rule this hook is the backstop
 * rather than the deciding check.
 *
 * @param options {object}
 * @param options.rule {ContainerRule}   the rule the invoked operation carries
 * @param [options.spaceUrl] {string}   the Space's canonical trailing-slash
 *   URL; `controller-only` reads none, and without one the other three rules
 *   match no tail and refuse every delegated chain
 * @returns {InspectCapabilityChain}
 */
export function containerRuleInspector({
  rule,
  spaceUrl
}: {
  rule: ContainerRule
  spaceUrl?: string
}): InspectCapabilityChain {
  return async ({ capabilityChain }) => {
    if (capabilityChain.length <= 1) {
      return { valid: true }
    }
    if (rule === 'controller-only') {
      return {
        valid: false,
        error: new Error(
          'This operation accepts a direct root-capability invocation only; ' +
            'a delegated capability is refused whatever its allowedAction.'
        )
      }
    }
    const tail = capabilityChain[capabilityChain.length - 1] as ChainCapability
    if (rule === 'exact-delete') {
      if (
        tail.invocationTarget === spaceUrl &&
        actionsExactly({ capability: tail, action: 'DELETE' })
      ) {
        return { valid: true }
      }
      return {
        valid: false,
        error: new Error(
          'Delete Space accepts a delegated capability only when the invoked ' +
            "capability's invocationTarget is exactly that Space's canonical " +
            'trailing-slash URL and its allowedAction is exactly ["DELETE"].'
        )
      }
    }
    if (rule === 'replicas-subtree') {
      const replicasUrl = spaceUrl && `${spaceUrl}${REPLICAS_SEGMENT}`
      const target = tail.invocationTarget
      if (
        replicasUrl !== undefined &&
        typeof target === 'string' &&
        (target === replicasUrl || target.startsWith(`${replicasUrl}/`))
      ) {
        return { valid: true }
      }
      return {
        valid: false,
        error: new Error(
          'The replicas routes accept a delegated capability only when the ' +
            "invoked capability's invocationTarget is the Space's replicas " +
            'URL or a URL beneath it.'
        )
      }
    }
    if (tail.invocationTarget === spaceUrl) {
      return { valid: true }
    }
    return {
      valid: false,
      error: new Error(
        'Writing a Collection Metadata object or its history log accepts ' +
          "a delegated capability only when the invoked capability's " +
          'invocationTarget is exactly ' +
          "the Space's canonical trailing-slash URL (its items subtree)."
      )
    }
  }
}
