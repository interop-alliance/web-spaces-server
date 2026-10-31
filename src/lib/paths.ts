/**
 * Single source of truth for the server's relative URL path templates. The route
 * shapes registered in `routes.ts` (the `/spaces` repository, `/space/:spaceId`,
 * `/space/:spaceId/:collectionId`, the `policy` / `linkset` auxiliary resources,
 * and the `export` / `import` actions) are mirrored here as builder functions, so
 * handlers, the policy code, and the storage backends construct the same paths
 * from one place rather than re-deriving them inline (which risks drift from the
 * routes).
 *
 * A container (a Space or a Collection) is canonically addressed WITH the
 * trailing slash (spec "Reading This Document"): that form lists its members,
 * adds one, and deletes the container, and the bare form only redirects to it.
 * So `spacePath` and `collectionPath` return that form. The no-slash form is
 * not an address the server hands out. It exists only as the private
 * `spaceBase` and `collectionBase` prefixes that every sub-resource path
 * (`meta`, `policy`, `linkset`, ...) extends. A leaf Resource has no children,
 * so `resourcePath` has no container form.
 */

/**
 * The absolute URL of a path on this server: `path` resolved against the
 * server's base URL.
 * @param options {object}
 * @param options.path {string}   a path one of the builders below returns
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string}
 */
export function absoluteUrl({
  path,
  serverUrl
}: {
  path: string
  serverUrl: string
}): string {
  return new URL(path, serverUrl).toString()
}

/**
 * The service description (`/service`), the server-wide document every
 * response links to with the `service` relation. The specification fixes no
 * path for it; this is the one this server serves it at.
 * @returns {string}
 */
export function serviceDescriptionPath(): string {
  return `/service`
}

/**
 * The SpacesRepository container (`/spaces/`), the `POST` (Create Space) and
 * `GET` (List Spaces) target. The repository has no member paths: a Space is
 * addressed at `/space/:spaceId/`, not under `/spaces/`, so the `Location` of
 * a newly created Space is `spacePath({ spaceId })`.
 * @returns {string}
 */
export function spacesPath(): string {
  return `/spaces/`
}

/**
 * `/space/:spaceId` -- the prefix the Space's sub-resource paths extend. Not
 * an address of its own: the Space itself is {@link spacePath}.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
function spaceBase({ spaceId }: { spaceId: string }): string {
  return `/space/${spaceId}`
}

/**
 * `/space/:spaceId/` -- the canonical Space container URL: list Collections,
 * add one, delete the Space.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function spacePath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/`
}

/**
 * The absolute canonical URL of a Space on this server, which is the target
 * of the Space's root capability. A capability target compares as an exact
 * string, so every site derives it here.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string}
 */
export function absoluteSpaceUrl({
  spaceId,
  serverUrl
}: {
  spaceId: string
  serverUrl: string
}): string {
  return absoluteUrl({ path: spacePath({ spaceId }), serverUrl })
}

/**
 * `/space/:spaceId/meta` -- the Space Metadata object (reserved `meta`
 * segment), the "about it" document of the Space container.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function spaceMetaPath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/meta`
}

/**
 * `/space/:spaceId/export` -- the "Export Space" action path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function exportPath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/export`
}

/**
 * `/space/:spaceId/import` -- the "Import Space" action path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function importPath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/import`
}

/**
 * `/space/:spaceId/:collectionId` -- the prefix the Collection's sub-resource
 * paths extend. Not an address of its own: the Collection itself is
 * {@link collectionPath}.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
function collectionBase({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${spaceBase({ spaceId })}/${collectionId}`
}

/**
 * `/space/:spaceId/:collectionId/` -- the canonical Collection container URL:
 * list items, add one, delete the Collection.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function collectionPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionBase({ spaceId, collectionId })}/`
}

/**
 * The absolute canonical URL of a Collection on this server, which a created
 * Collection's `Location` names and a `changes` checkpoint is scoped to.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string}
 */
export function absoluteCollectionUrl({
  spaceId,
  collectionId,
  serverUrl
}: {
  spaceId: string
  collectionId: string
  serverUrl: string
}): string {
  return absoluteUrl({
    path: collectionPath({ spaceId, collectionId }),
    serverUrl
  })
}

/**
 * `/space/:spaceId/:collectionId/:resourceId`
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function resourcePath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `${collectionBase({ spaceId, collectionId })}/${resourceId}`
}

/**
 * The `policy` auxiliary resource path for whichever level the ids address:
 * Space (`spaceId`), Collection (`+ collectionId`), or Resource
 * (`+ collectionId + resourceId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {string}
 */
export function policyPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId?: string
  resourceId?: string
}): string {
  if (collectionId !== undefined && resourceId !== undefined) {
    return `${resourcePath({ spaceId, collectionId, resourceId })}/policy`
  }
  if (collectionId !== undefined) {
    return `${collectionBase({ spaceId, collectionId })}/policy`
  }
  return `${spaceBase({ spaceId })}/policy`
}

/**
 * `/space/:spaceId/backends` -- the "Space Backends Available" list path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function backendsPath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/backends`
}

/**
 * `/space/:spaceId/backends/:backendId` -- a single registered `external`
 * backend record (the `POST` `Location` target, and the `PUT`/`DELETE` member
 * path). Distinct from {@link backendPath}, which is a Collection's *selected*
 * backend resource.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.backendId {string}
 * @returns {string}
 */
export function registeredBackendPath({
  spaceId,
  backendId
}: {
  spaceId: string
  backendId: string
}): string {
  return `${backendsPath({ spaceId })}/${backendId}`
}

/**
 * The reserved segment beneath a Space URL that addresses its replica
 * registrations. Exported for a reader that holds the Space's canonical URL
 * and no Space id (the container rule).
 */
export const REPLICAS_SEGMENT = 'replicas'

/**
 * `/space/:spaceId/replicas` -- the Space's replica registrations: `GET`
 * lists them and `POST` adds one.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function replicasPath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/${REPLICAS_SEGMENT}`
}

/**
 * `/space/:spaceId/replicas/:replicaId` -- one replica registration.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.replicaId {string}
 * @returns {string}
 */
export function replicaPath({
  spaceId,
  replicaId
}: {
  spaceId: string
  replicaId: string
}): string {
  return `${replicasPath({ spaceId })}/${replicaId}`
}

/**
 * `/space/:spaceId/replicas/:replicaId/status` -- the runtime state of one
 * registration's pull loop.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.replicaId {string}
 * @returns {string}
 */
export function replicaStatusPath({
  spaceId,
  replicaId
}: {
  spaceId: string
  replicaId: string
}): string {
  return `${replicaPath({ spaceId, replicaId })}/status`
}

/**
 * `/space/:spaceId/quotas` -- the Space Quota report path (spec "Quotas").
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function quotasPath({ spaceId }: { spaceId: string }): string {
  return `${spaceBase({ spaceId })}/quotas`
}

/**
 * `/space/:spaceId/:collectionId/meta` -- the Collection Metadata (reserved
 * `meta` segment) path. It sits at the `:resourceId` position, so `meta` is a
 * reserved Resource id (see `lib/validateId.ts`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function collectionMetaPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionBase({ spaceId, collectionId })}/meta`
}

/**
 * `/space/:spaceId/:collectionId/meta/log` -- the Collection's governing
 * history log sub-resource (the `governed-history-logs` feature), a sibling
 * path under {@link collectionMetaPath}. A capability whose target covers the
 * Collection URL reaches the `GET`; the `PUT` carries the container rule
 * (`lib/containerRule.ts`), so it takes a direct root invocation or a grant on
 * the Space's items subtree.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function collectionLogPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionMetaPath({ spaceId, collectionId })}/log`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/meta` -- the Resource Metadata
 * (reserved `meta` segment) path, one level below its Collection-level sibling
 * {@link collectionMetaPath}, so it takes the full id triple.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function metaPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/meta`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex` -- a single
 * chunk of a chunked Resource (the `chunked-streams` feature). Chunks are
 * addressed under their parent Resource, so the `chunks` segment needs no
 * reserved-id entry (it sits a level below any Resource route) -- unlike
 * `meta`, which is also addressed at the Collection level and so occupies the
 * `:resourceId` position there.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @param options.chunkIndex {number}   non-negative integer chunk position
 * @returns {string}
 */
export function chunkPath({
  spaceId,
  collectionId,
  resourceId,
  chunkIndex
}: {
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: number
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/chunks/${chunkIndex}`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/chunks/` -- the chunk listing
 * (container) path of a chunked Resource. Always the trailing-slash container
 * form: a reader discovers the chunk count here before fetching `0..count-1`.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function chunksContainerPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/chunks/`
}

/**
 * `/space/:spaceId/:collectionId/backend` -- the "Collection Backend Selected"
 * resource path (reserved `backend` segment at the Resource level).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function backendPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionBase({ spaceId, collectionId })}/backend`
}

/**
 * `/space/:spaceId/:collectionId/quota` -- the per-Collection storage quota
 * report path (reserved `quota` segment at the Resource level; spec "Quotas").
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function quotaPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionBase({ spaceId, collectionId })}/quota`
}

/**
 * `/space/:spaceId/:collectionId/query` -- the reserved `query` endpoint for a
 * Collection (spec "Collection-level reserved endpoints"). The PWS server serves
 * the replication change feed as the `changes` profile of this endpoint.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function queryPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionBase({ spaceId, collectionId })}/query`
}

/**
 * The `linkset` discovery resource path for a Space (`spaceId`) or Collection
 * (`+ collectionId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @returns {string}
 */
export function linksetPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId?: string
}): string {
  const anchor =
    collectionId !== undefined
      ? collectionBase({ spaceId, collectionId })
      : spaceBase({ spaceId })
  return `${anchor}/linkset`
}

/**
 * `/kms/keystores` -- the WebKMS keystores collection (create/list target; the
 * `/kms` facet) or one of its member keystores
 * (`/kms/keystores/:keystoreId`). Unlike the PWS builders there is no
 * trailing-slash container form: the webkms protocol
 * (`@interop/webkms-client`) posts to the bare collection path.
 * @param options {object}
 * @param [options.keystoreId] {string}   the keystore's server-generated local
 *   id; when present, the member path, otherwise the collection path
 * @returns {string}
 */
export function kmsKeystoresPath({
  keystoreId
}: { keystoreId?: string } = {}): string {
  return keystoreId !== undefined
    ? `/kms/keystores/${keystoreId}`
    : '/kms/keystores'
}

/**
 * `/kms/keystores/:keystoreId/keys` -- a keystore's keys collection (the
 * `GenerateKeyOperation` target) or one of its member keys
 * (`/kms/keystores/:keystoreId/keys/:keyId`, the key-operation / description
 * target). Like `kmsKeystoresPath`, no trailing-slash form exists: the webkms
 * protocol's URLs are exact.
 * @param options {object}
 * @param options.keystoreId {string}   the keystore's local id
 * @param [options.keyId] {string}   the key's server-generated local id; when
 *   present, the member path, otherwise the collection path
 * @returns {string}
 */
export function kmsKeysPath({
  keystoreId,
  keyId
}: {
  keystoreId: string
  keyId?: string
}): string {
  const keysPath = `${kmsKeystoresPath({ keystoreId })}/keys`
  return keyId !== undefined ? `${keysPath}/${keyId}` : keysPath
}

/**
 * `/kms/keystores/:keystoreId/zcaps/revocations/:revocationId` -- a keystore's
 * zcap revocation submission target (POST; the ezcap-express
 * `/zcaps/revocations/` convention). `revocationId` is the *to-be-revoked
 * capability's id*, URL-encoded into the single path segment the route
 * expects -- the same `encodeURIComponent` framing `@interop/webkms-client`'s
 * `revokeCapability` puts on the wire.
 * @param options {object}
 * @param options.keystoreId {string}   the keystore's local id
 * @param options.revocationId {string}   the to-be-revoked capability's id
 *   (raw, un-encoded)
 * @returns {string}
 */
export function kmsRevocationsPath({
  keystoreId,
  revocationId
}: {
  keystoreId: string
  revocationId: string
}): string {
  return (
    `${kmsKeystoresPath({ keystoreId })}/zcaps/revocations/` +
    encodeURIComponent(revocationId)
  )
}

/**
 * `/space/:spaceId/zcaps/revocations/:revocationId` -- a Space's zcap
 * revocation submission target (POST), the WAS-route sibling of
 * `kmsRevocationsPath` and the same ezcap-express `/zcaps/revocations/`
 * convention. `revocationId` is the *to-be-revoked capability's id*,
 * URL-encoded into the single path segment the route expects.
 *
 * `zcaps` is a reserved Collection id (`lib/validateId.ts`), so no Collection
 * is created under it. Only `POST` is served here. Every other method at this
 * shape is refused with a 405 (`Allow: POST`), and every other path beneath
 * `zcaps`, the bare segment included, is not found (`routes.ts`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.revocationId {string}   the to-be-revoked capability's id
 *   (raw, un-encoded)
 * @returns {string}
 */
export function spaceRevocationsPath({
  spaceId,
  revocationId
}: {
  spaceId: string
  revocationId: string
}): string {
  return (
    `${spaceBase({ spaceId })}/zcaps/revocations/` +
    encodeURIComponent(revocationId)
  )
}
