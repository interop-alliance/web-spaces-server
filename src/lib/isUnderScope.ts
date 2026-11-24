/**
 * The `/`-boundary subtree test the scope checks share: the revocation
 * routes' root check, Import Space's revocation gate, and the bound on where
 * a DID URL chain's links dereference to.
 */

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
