/**
 * Request handlers for Collection operations: read/write the Collection
 * Metadata object (at the reserved `meta` sub-resource), delete a Collection,
 * list its items, add a Resource to it, and serve its query, quota, backend
 * and history-log sub-resources.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import type { ChangeDocument, ChangesCheckpoint } from '@interop/storage-core'

import { buildLinkset } from '../policy.js'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import {
  fetchCollectionAndBackend,
  getCollectionOrThrow,
  projectCollectionMetadata,
  resourceWriteOptions
} from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { composeCollectionMetadata } from './collectionInput.js'
import { parseCollectionMetadataBody } from '../lib/collectionMetadataBody.js'
import { invokerDid } from '../auth-header-hooks.js'
import { assertValidIds } from '../lib/validateId.js'
import { readTextBody } from '../lib/requestBody.js'
import {
  LOG_CONTENT_TYPE,
  assertGoverningLogAppend
} from '../lib/governedLog.js'
import type {
  CollectionDeleteOutcome,
  CollectionMetadata,
  NormalizedIndexDeclaration,
  StorageBackend
} from '../types.js'
import { parseBlindedIndexQueryBody } from '../lib/blindedIndex.js'
import {
  declaredIndexesOf,
  declaredUniqueIndexesOf,
  parseEqualityQueryBody,
  parseListFilter
} from '../lib/equalityIndex.js'
import { resolveBackendDescriptor } from '../lib/backends.js'
import { assertRevisionsTransition } from '../lib/revisions.js'
import { coerceQueryLimit, parsePageParams } from '../lib/pagination.js'
import {
  decodeChangesCheckpoint,
  encodeChangesCheckpoint
} from '../lib/changesCheckpoint.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import { restampFeedFromControlPlane } from '../lib/backendMirror.js'
import { forgetDeletedWebvhLocation } from '../lib/webvhController.js'
import { assertDeleteKeepsControllers } from '../lib/webvhLogLocation.js'
import { invalidateCollectionPolicies } from '../lib/policyCache.js'
import {
  getCachedGovernedDescriptors,
  invalidateCollectionGovernedDescriptors
} from '../lib/governedDescriptorsCache.js'
import {
  absoluteCollectionUrl,
  absoluteUrl,
  collectionPath,
  resourcePath,
  linksetPath,
  backendPath,
  collectionMetaPath,
  collectionLogPath,
  quotaPath,
  queryPath,
  policyPath
} from '../lib/paths.js'
import {
  formatEtag,
  parseWritePreconditions,
  resourceMetaEtag
} from '../lib/etag.js'
import {
  metadataEtagOf,
  stripMetadataValidator
} from '../lib/metadataValidator.js'
import {
  CollectionNotFoundError,
  EncryptionImmutableError,
  InvalidCollectionError,
  InvalidRequestBodyError,
  UnsupportedOperationError,
  UniqueAttributeConflictError,
  rethrowOrWrapStorageError
} from '../errors.js'
import { withStorageErrors } from '../lib/storageErrors.js'
import { notModifiedReply, withEtag } from './notModified.js'

/**
 * The normalized `unique: true` declarations a `plaintext.indexes` update ADDS
 * -- names that are unique in the incoming declaration but were not unique
 * (declared, or declared without `unique`) in the existing one. These are the claims a
 * declare-time conflict scan must verify against already-stored Resources; an
 * unchanged or removed unique claim needs no scan (it was enforced at write
 * time).
 *
 * @param options {object}
 * @param [options.existing] {CollectionMetadata}   the Collection's stored
 *   Metadata object
 * @param options.incoming {CollectionMetadata}   the object about to be
 *   persisted
 * @returns {NormalizedIndexDeclaration[]}
 */
function newlyUniqueDeclarations({
  existing,
  incoming
}: {
  existing?: CollectionMetadata
  incoming: CollectionMetadata
}): NormalizedIndexDeclaration[] {
  const existingUnique = new Set(
    declaredUniqueIndexesOf({ collectionMetadata: existing }).map(
      declaration => declaration.name
    )
  )
  return declaredUniqueIndexesOf({ collectionMetadata: incoming }).filter(
    declaration => !existingUnique.has(declaration.name)
  )
}

export class CollectionRequest {
  /**
   * POST /space/:spaceId/:collectionId/
   * Request handler for "Create Resource" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async post(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { serverUrl } = request.server
    const requestName = 'Create Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Verify (capability-only): creating a Resource requires a valid capability
    // invocation; no access-control-policy fallback. The container rule does
    // not apply: a POST adds a member rather than writing the container.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionPath({ spaceId, collectionId }),
      requestName
    })

    // Fetch collection by id
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // zCap checks out, continue
    const resourceId = uuidv4()

    // Route resource bytes to the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionMetadata
    })
    // Runs the encrypted-Collection conformance check (422) after auth and the
    // 404 above, so it is only observable by a caller authorized to write here.
    const input = await resolveResourceInput(request, { collectionMetadata })
    // The key epoch, writer id, unique indexes, write-once rule and
    // `createdBy` of the write (`resourceWriteOptions`).
    const writeOptions = resourceWriteOptions({
      request,
      spaceId,
      collectionId,
      collectionMetadata,
      requestName
    })
    const written = await withStorageErrors({ requestName }, () =>
      dataBackend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input,
        ...writeOptions
      })
    )

    const createdUrl = absoluteUrl({
      path: resourcePath({ spaceId, collectionId, resourceId }),
      serverUrl
    })
    reply.header('Location', createdUrl)
    // Surface the created Resource's ETag so a client can chain a conditional
    // write (the conditional-writes feature).
    reply.header('etag', formatEtag(written.validator))

    // The stored content type: for a multipart upload that is the file part's,
    // not the request envelope's.
    return reply.status(201).send({
      id: resourceId,
      'content-type': input.contentType,
      url: createdUrl
    })
  }

  /**
   * GET /space/:spaceId/:collectionId/linkset
   * Request handler for the Collection's linkset (RFC9264): advertises the
   * Collection's access-control `policy` and selected `backend` resources for
   * discovery. Readable by whoever may read the Collection (capability or
   * fallback policy).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async linkset(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { serverUrl, storage } = request.server
    const requestName = 'Get Collection Linkset'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: linksetPath({ spaceId, collectionId }),
      requestName
    })

    const linkset = await buildLinkset({
      storage,
      serverUrl,
      spaceId,
      collectionId
    })
    return reply
      .status(200)
      .type('application/linkset+json')
      .send(JSON.stringify(linkset))
  }

  /**
   * GET /space/:spaceId/:collectionId/backend
   * Request handler for "Collection Backend Selected": returns the detailed
   * backend description object for the Collection's selected backend (resolved
   * from the Collection's stored `{ id }` against the Space's backends-available;
   * default-filled for Collections created before the property existed).
   *
   * Authorization is capability-or-policy, the same as Read Collection
   * Metadata: the selected backend is no more sensitive than the Metadata
   * object, so a public-readable Collection may also read its backend.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getBackend(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const requestName = 'Get Collection Backend'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: backendPath({ spaceId, collectionId }),
      requestName
    })

    // Fetch collection by id
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    const backend = await resolveBackendDescriptor({
      serverBackends: request.server.serverBackends,
      spaceId,
      collectionMetadata
    })
    return reply.status(200).type('application/json').send(backend)
  }

  /**
   * GET /space/:spaceId/:collectionId/meta
   * Request handler for "Read Collection Metadata": the Collection Metadata
   * object, the "about it" document of the Collection container (spec
   * "Collection Metadata Data Model") -- its configuration members (`name`,
   * `backend`, `encryption` / `plaintext`, `generator`)
   * beside the server-managed `createdBy`, `createdAt` and `updatedAt`, the
   * opaque `epoch` stamp and the user-writable `custom` object (omitted when
   * empty). There is no `contentType` / `size`: a Collection is a container,
   * with no stored representation to describe. One `ETag` covers the whole
   * object. On a log-governed Collection the `encryption` member is derived
   * from the log head (`getCollectionOrThrow`).
   *
   * Authorization is capability-or-policy against the `meta` URL; a capability
   * on the Collection container covers it too, and the policy level resolves
   * at the Collection, so a public-readable Collection may read its Metadata.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const requestName = 'Read Collection Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): the capability's `invocationTarget` is
    // the full `/meta` URL (matching the request URL), and the policy level
    // resolves at the Collection.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionMetaPath({ spaceId, collectionId }),
      requestName
    })

    // authorized, continue. Metadata cannot exist apart from its Collection:
    // an absent Collection is a 404, conflated with an unauthorized read.
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // `metaGeneration` / `metaLocal` are out-of-band `ETag` parts, not part
    // of the wire body: the projection below strips them, and the `ETag`
    // header is built from them and the body's stamp members.
    const metaEtag = metadataEtagOf(collectionMetadata)

    // A conditional read (spec "Caching") against the object's `ETag`.
    const notModified = notModifiedReply({ request, reply, etag: metaEtag })
    if (notModified) {
      return notModified
    }

    // The served projection: the self `url`, the linkset, the default-filled
    // backend, and `type` sorted (`projectCollectionMetadata`).
    return withEtag({
      reply: reply.status(200).type('application/json'),
      etag: metaEtag
    }).send(
      JSON.stringify(
        projectCollectionMetadata({
          spaceId,
          collectionId,
          collectionMetadata
        })
      )
    )
  }

  /**
   * PUT /space/:spaceId/:collectionId/meta
   * Request handler for "Update (or Create by Id) Collection": a full
   * replacement of the Collection Metadata object that creates the Collection
   * when none exists under the id (201, `Location` naming the Collection
   * container) and reconfigures it otherwise (204). A writable member the
   * body omits is cleared, with the spec's exceptions (`plaintext` is kept,
   * the creation-only `encryption` may not be added or dropped, the read-only
   * members are ignored); the composition rules live in
   * `composeCollectionMetadata`. One
   * `ETag` covers the object, so `If-None-Match: *` is the guarded create and
   * `If-Match` the compare-and-swap on it. Authorization is capability-only
   * (the `PUT` action) against the `meta` URL; a capability on the Collection
   * container covers it too.
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async putMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      body
    } = request
    if (!body) {
      throw new InvalidCollectionError()
    }
    const { serverUrl, storage } = request.server
    const requestName = 'Update Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Pre-auth body shape (400). The deeper `custom` check is deferred until
    // after authorization, where the encryption descriptor in effect decides
    // whether a non-empty `custom` is a plaintext `{ name, tags }` or an
    // opaque envelope (an empty or omitted one clears on both); gating it on
    // auth keeps a 422/400 observable only to a caller authorized to write
    // here.
    const parsed = parseCollectionMetadataBody({ body, requestName })
    // The Collection `id` is immutable: when the body carries one, it must
    // match the `{collection_id}` in the URL (spec spells this out for Update
    // Space; applied here for parity). `invalid-request-body` (400).
    if (parsed.body.id !== undefined && parsed.body.id !== collectionId) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Collection Metadata "id" (${String(parsed.body.id)}) does not match the URL Collection id (${collectionId}).`,
        pointer: '#/id'
      })
    }

    // Verify (capability-only): writing the object requires a valid
    // capability invocation; no access-control-policy fallback. The
    // container rule: the write takes a direct root invocation, or a
    // delegated capability whose invoked grant targets exactly the Space's
    // canonical URL. A grant on the Collection container URL, on this
    // Metadata URL, or on a Resource URL is refused, so a Collection data
    // grant does not rewrite the Collection's configuration. The sibling
    // `meta/log` write carries the same rule, and Delete Collection stays
    // controller-only.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionMetaPath({ spaceId, collectionId }),
      requestName,
      containerRule: 'space-subtree-put'
    })

    // zCap checks out, continue. The object is composed inside the backend's
    // write, from the stored object the backend reads under its lock: a full
    // replacement carries an omitted `plaintext`, `backend` or `generator`
    // forward from the stored object, and composed against a pre-lock read it
    // would carry forward what that read saw and drop what a concurrent write
    // added in between (a just-declared `unique` index, a `backend`
    // selection) with a 204 to both writers. The descriptor checks
    // (`encryption`, `revisions`, the `plaintext` / `encryption` exclusion)
    // run inside the same callback, against the same record, so an appended
    // epoch cannot be rolled back either. The guarantees hold
    // unconditionally, not just under `If-Match`.
    //
    // The stored object is the backend's record (not `getCollectionOrThrow`),
    // since the derived `encryption` and `revisions` of a log-governed
    // Collection must not be re-persisted; the governed descriptors are
    // derived from the log the backend hands over, read under the same lock,
    // memoized by the log's validator so the log is parsed only if it moved.
    //
    // `If-Match` (the `conditional-writes` feature) makes the write a
    // compare-and-swap on the object's current `ETag`, so two clients
    // concurrently editing it (e.g. both adding a recipient) cannot silently
    // clobber one another, and `If-None-Match: *` makes the PUT a guarded
    // create (two clients racing to provision the same Collection cannot both
    // succeed, so the loser cannot overwrite the winner's `backend`). Both
    // opt-in: an unconditional PUT still upserts. Evaluated atomically with
    // the write inside the backend, before the composition, so a stale
    // validator or a present object surfaces as 412 `precondition-failed`
    // (rethrown unchanged) ahead of any refusal the body earns below.
    // Rethrow a typed ProblemError from the data-plane backend unchanged
    // (e.g. a 507 quota / 412 precondition) rather than flattening it to a
    // 500; wrap anything genuinely unexpected. `handleError` logs the 5xx once.
    const written = await withStorageErrors({ requestName }, () =>
      storage.writeCollection({
        spaceId,
        collectionId,
        createdBy: invokerDid(request),
        ...parseWritePreconditions(request.headers),
        collectionMetadata: async ({ prior, log }) => {
          const existing = prior && stripMetadataValidator(prior)
          const collectionMetadata = await composeCollectionMetadata({
            request,
            spaceId,
            collectionId,
            parsed,
            existing,
            governed: prior
              ? await getCachedGovernedDescriptors({
                  storage,
                  serverUrl,
                  spaceId,
                  collectionId,
                  logValidator: log?.validator,
                  readLog: async () => log
                })
              : undefined,
            requestName
          })

          // Adding a `unique: true` claim for a name that was not unique
          // before MUST be rejected if the Collection's already-stored
          // Resources already violate it (spec "Collection Metadata Data
          // Model"). Scan for a pre-existing conflict before acknowledging
          // the update, when the data-plane backend supports the scan. The
          // backend's write excludes the Space's Resource writes, and a
          // Resource write reads the declaration under the lock this write
          // holds, so one racing this update either finished before the scan
          // or sees the declaration. A Collection on a registered external
          // backend cannot declare one (`composeCollectionMetadata` refuses
          // it), so the scan only ever runs on the server's own backends.
          const newlyUnique = newlyUniqueDeclarations({
            existing,
            incoming: collectionMetadata
          })
          if (newlyUnique.length > 0) {
            const dataBackend = await resolveBackend({
              request,
              spaceId,
              collectionId,
              collectionMetadata
            })
            if (dataBackend.findEqualityUniqueViolation) {
              const violation = await dataBackend.findEqualityUniqueViolation({
                spaceId,
                collectionId,
                indexes: newlyUnique
              })
              if (violation) {
                throw new UniqueAttributeConflictError({ variant: 'equality' })
              }
            }
          }
          return collectionMetadata
        }
      })
    )

    // Surface the new `ETag` so a client can chain a conditional update
    // (read-modify-CAS on the object).
    reply.header('etag', formatEtag(written.validator))
    // Create or update is the backend's answer, decided under its lock: two
    // unconditional creates that both read the Collection as absent above
    // land as one create and one update.
    if (!written.created) {
      return reply.status(204).send()
    }
    // Created: `Location` names the Collection (its canonical container URL),
    // not the Metadata object that was written (spec "Update Collection").
    reply.header(
      'Location',
      absoluteCollectionUrl({ spaceId, collectionId, serverUrl })
    )
    // The stored object as the write left it, through the projection Read
    // Collection Metadata serves, so the create response and a subsequent
    // read agree. A created Collection has no governing log yet, so no
    // member is derived from one.
    return reply.status(201).send(
      projectCollectionMetadata({
        spaceId,
        collectionId,
        collectionMetadata: written.metadata
      })
    )
  }

  /**
   * GET /space/:spaceId/:collectionId/meta/log
   * Request handler for "Get Collection History Log" (the
   * `governed-history-logs` feature): the governing log's JSON Lines body,
   * verbatim, served as `text/jsonl` with its own `ETag`. Authorization is
   * capability-or-policy at the Collection level, like `/meta`: any
   * capability whose target covers the Collection URL reads it, so a share
   * grantee or an app reads the log with the zcap it already holds. A
   * Collection with no log is a 404, conflated with an unauthorized read.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getLog(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Get Collection History Log'

    assertValidIds({ spaceId, collectionId }, { requestName })

    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionLogPath({ spaceId, collectionId }),
      requestName
    })

    // authorized, continue

    const log = await withStorageErrors({ requestName }, () =>
      storage.getCollectionLog({ spaceId, collectionId })
    )
    if (!log) {
      throw new CollectionNotFoundError({ requestName })
    }

    const etag = formatEtag(log.validator)
    const notModified = notModifiedReply({ request, reply, etag })
    if (notModified) {
      return notModified
    }
    return reply
      .status(200)
      .type(LOG_CONTENT_TYPE)
      .header('etag', etag)
      .send(log.body)
  }

  /**
   * PUT /space/:spaceId/:collectionId/meta/log
   * Request handler for "Write Collection History Log" (the
   * `governed-history-logs` feature): the `/log` transport's guarded create
   * (`If-None-Match: *`) and compare-and-swap append (`If-Match`, the prior
   * bytes carried verbatim plus the new line), `412` on a lost race. The
   * guarded create is the declaration that makes the Collection log-governed;
   * it is refused with `encryption-immutable` (409) on a Collection whose
   * Metadata object already holds a client-written `encryption` member, or a
   * `plaintext` member, which the derived `encryption` would exclude. It may
   * declare a `revisions` slot in its `state`, but must keep the `resolution`
   * and `immutable` the stored object already sets (`revisions-immutable`,
   * 409). Each write checks the line contract (`invalid-request-body`, 400)
   * and, against the prior head, both descriptors' transition checks,
   * atomically with the write. Authorization is capability-only (the `PUT` action), as
   * for `/meta`. Does NOT create a Collection. Returns 204 with the log's new
   * `ETag`. A body equal to the stored log, byte for byte, extends it by no
   * line: the backend refuses it with `invalid-request-body` (400) once its
   * precondition passes, and writes nothing.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async putLog(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage } = request.server
    const requestName = 'Write Collection History Log'

    assertValidIds({ spaceId, collectionId }, { requestName })

    // The container rule: writing the log takes a direct root invocation, or
    // a delegated capability whose invoked grant targets exactly the Space's
    // items subtree (the trailing-slash Space URL). The guarded create puts
    // the Collection under log governance, and from then on the log's head
    // derives the served `encryption` descriptor and refuses every direct
    // `encryption` write, so a grant aimed at the Collection container URL,
    // this log URL, or a Resource URL is refused. The sibling `PUT /meta`
    // carries the same rule.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionLogPath({ spaceId, collectionId }),
      requestName,
      containerRule: 'space-subtree-put'
    })

    // zCap checks out, continue

    // Buffered in memory, so bounded by the route's `bodyLimit`: the backend's
    // per-upload cap when it has one (named in the refusal), else the server's
    // fallback (plugin.ts).
    const body = await readTextBody({
      request,
      reply,
      backendId:
        storage.maxUploadBytes === undefined ? undefined : storage.describe().id
    })

    const written = await withStorageErrors({ requestName }, () =>
      storage.writeCollectionLog({
        spaceId,
        collectionId,
        body,
        ...parseWritePreconditions(request.headers),
        assertTransition: ({ prior, collectionMetadata }) => {
          // The declaration: a log may only govern a Collection whose stored
          // Metadata object holds no client-written descriptor. Pre-release
          // there is no conversion, only re-provisioning.
          if (prior === undefined && collectionMetadata.encryption) {
            throw new EncryptionImmutableError({
              detail:
                "A history log cannot govern a Collection whose 'encryption' " +
                'descriptor was written on its Metadata object.'
            })
          }
          // A stored `plaintext` member is refused on the same terms. The
          // derived `encryption` and `plaintext` exclude each other, and
          // `plaintext` has no removal path, so a log over it would leave
          // every later Metadata write refused by the exclusion rule.
          if (prior === undefined && collectionMetadata.plaintext) {
            throw new EncryptionImmutableError({
              detail:
                "A history log cannot govern a Collection whose 'plaintext' " +
                'member was written on its Metadata object.',
              pointer: '#/plaintext'
            })
          }
          const { revisions } = assertGoverningLogAppend({
            body,
            prior: prior?.body,
            requestName
          })
          // The guarded create declares the governed `revisions`. It may add
          // a member the stored object lacks, the way a create does, but
          // must keep any the stored object already sets.
          if (prior === undefined) {
            assertRevisionsTransition({
              existing: collectionMetadata.revisions,
              incoming: revisions,
              declaring: true
            })
          }
        }
      })
    )
    if (!written) {
      throw new CollectionNotFoundError({ requestName })
    }

    return reply.status(204).header('etag', formatEtag(written)).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/quota
   * Request handler for the per-Collection "Quotas" report (spec "Quotas"):
   * the storage report for a single Collection, scoped to its backend (a single
   * backend-usage entry whose `usageBytes` reflects only this Collection). A
   * backend that cannot account per-Collection yields `unsupported-operation`
   * (501); the filesystem backend supports it.
   *
   * Authorization is capability-or-policy, the same as the Space Quota report:
   * a caller not authorized to read it receives a 404 (maximum-privacy
   * invariant), and a public-readable Collection may read its quota.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getQuota(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const requestName = 'Get Collection Quota'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): readable by whoever may read the
    // Collection (capability invocation, else the effective policy).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: quotaPath({ spaceId, collectionId }),
      requestName
    })

    // Fetch collection by id, and report against the Collection's selected
    // (data-plane) backend. A backend that cannot account per-Collection omits
    // `reportCollectionUsage`; the spec sanctions a 501 there.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })
    if (!dataBackend.reportCollectionUsage) {
      throw new UnsupportedOperationError({ requestName })
    }

    const usage = await dataBackend.reportCollectionUsage({
      spaceId,
      collectionId
    })
    return reply.status(200).type('application/json').send(usage)
  }

  /**
   * POST /space/:spaceId/:collectionId/query
   * The reserved Collection `query` endpoint (spec "Collection-level reserved
   * endpoints"). This server serves two profiles, selected by the body's
   * `profile`:
   *
   * - `changes` -- the replication change feed: every record of the
   *   Collection (each Resource and tombstone whatever its content type, the
   *   Collection Metadata object, the governing history log) changed
   *   strictly after the opaque `checkpoint`, in feed position order, capped
   *   at `limit`.
   * - `blinded-index` -- the EDV blinded-attribute query (the
   *   `blinded-index-query` backend feature): `{index, equals | has, count,
   *   limit, cursor}` evaluated against the HMAC-blinded `indexed` entries of
   *   the Collection's stored documents, answering `{documents, hasMore,
   *   cursor?}` (matching documents verbatim, opaque-cursor paginated) or
   *   `{count}`.
   * - `equality` -- the plaintext equality query (the `equality-query` backend
   *   feature): `{equals | has, count, limit, cursor}` evaluated against the
   *   attributes the server extracts from the Collection's Resources per its
   *   declared `plaintext.indexes`, answering `{documents, hasMore, cursor?}` (each
   *   document `{id, data?, custom?}`) or `{count}`. Only plaintext Collections
   *   serve it; an encrypted Collection answers `unsupported-operation` (501).
   *
   * The query parameters ride the signed JSON POST body (covered by the
   * `Digest`), so no `allowTargetQuery` is needed. A body with no `profile`
   * member is malformed (the registry marks `profile` REQUIRED) and yields
   * `invalid-request-body` (400); a body naming any other profile, or a
   * backend without the profile's method, yields `unsupported-operation`
   * (501). Authorization is capability-or-policy, the
   * same read semantics as List Collection: an under-authorized caller
   * receives a 404.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async query(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Body: {
        profile?: string
        checkpoint?: unknown
        limit?: unknown
        index?: unknown
        equals?: unknown
        has?: unknown
        count?: unknown
        cursor?: unknown
      }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      body
    } = request
    const requestName = 'Collection Query'

    // The signed body is covered by the Digest, so the bare `/query` target
    // authorizes it.
    const { collectionMetadata, dataBackend } =
      await CollectionRequest.#authorizeQuery({
        request,
        spaceId,
        collectionId,
        requestName
      })

    // "You did not say which profile" is a malformed request (the Query
    // Profile Registry marks `profile` REQUIRED), not an unsupported feature:
    // 400, distinct from the 501 an unrecognized profile gets below.
    if (body?.profile === undefined) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: "The query body is missing the required 'profile' member.",
        pointer: '#/profile'
      })
    }

    if (body.profile === 'changes' && dataBackend.changesSince) {
      return CollectionRequest.#queryChanges({
        reply,
        serverUrl: request.server.serverUrl,
        controlPlane: request.server.storage,
        dataBackend,
        spaceId,
        collectionId,
        body,
        requestName
      })
    }
    if (body.profile === 'blinded-index' && dataBackend.queryByBlindedIndex) {
      // Validate/normalize the EDV query body fields (400 on a malformed
      // query), then let the backend evaluate and paginate.
      const parsed = parseBlindedIndexQueryBody({ body, requestName })
      const result = await dataBackend.queryByBlindedIndex({
        spaceId,
        collectionId,
        ...parsed
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }
    if (body.profile === 'equality' && dataBackend.queryByEquality) {
      // The `equality` profile applies only to plaintext Collections: an
      // encrypted Collection's documents are opaque envelopes the server cannot
      // extract attributes from, so it answers `unsupported-operation` (501).
      if (collectionMetadata.encryption !== undefined) {
        throw new UnsupportedOperationError({ requestName })
      }
      // Resolve the declared indexes off the control-plane description: an
      // undeclared/empty declaration means every named attribute fails the
      // fail-closed declared-names check (400). Parse/validate the query body
      // against it, then let the backend extract, match, and paginate.
      const indexes = declaredIndexesOf({ collectionMetadata })
      const parsed = parseEqualityQueryBody({ body, indexes, requestName })
      const result = await dataBackend.queryByEquality({
        spaceId,
        collectionId,
        indexes,
        ...parsed
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }

    // Any other profile, or a backend without the profile's method.
    throw new UnsupportedOperationError({ requestName })
  }

  /**
   * GET /space/:spaceId/:collectionId/query?profile=changes
   * The read-only form of the `changes` profile: the same feed `POST` serves,
   * with `profile`, `checkpoint` and `limit` carried in the query string and
   * the invocation verified under the `GET` action. It exists so a
   * capability limited to `GET` can read the feed, which is what a
   * replication peer holds. The other profiles carry a body and are served
   * by `POST` alone, so any other `profile` here is `unsupported-operation`
   * (501), and a missing one is `invalid-request-body` (400). The response
   * is the `POST` form's, byte for byte.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async queryChangesByGet(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Querystring: { profile?: string; checkpoint?: string; limit?: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId },
      query: { profile, checkpoint, limit }
    } = request
    const requestName = 'Collection Query'

    // The query string is part of the signed request target.
    const { dataBackend } = await CollectionRequest.#authorizeQuery({
      request,
      spaceId,
      collectionId,
      requestName,
      allowTargetQuery: true
    })

    if (typeof profile !== 'string') {
      throw new InvalidRequestBodyError({
        requestName,
        detail: "The query is missing the required 'profile' parameter.",
        pointer: '#/profile'
      })
    }
    if (profile !== 'changes' || !dataBackend.changesSince) {
      throw new UnsupportedOperationError({ requestName })
    }
    return CollectionRequest.#queryChanges({
      reply,
      serverUrl: request.server.serverUrl,
      controlPlane: request.server.storage,
      dataBackend,
      spaceId,
      collectionId,
      body: {
        ...(typeof checkpoint === 'string' && { checkpoint }),
        ...(typeof limit === 'string' && { limit })
      },
      requestName
    })
  }

  /**
   * The prelude both forms of the Collection `query` endpoint share, in this
   * order so the masking is the same: reject a non-URL-safe id, authorize
   * (capability-or-policy: readable by whoever may read the Collection), then
   * fetch the Collection and its selected (data-plane) backend.
   *
   * @param options {object}
   * @param options.request {import('fastify').FastifyRequest}
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.requestName {string}
   * @param [options.allowTargetQuery] {boolean}   tolerate query parameters
   *   on the signed target (the `GET` form)
   * @returns {Promise<{ collectionMetadata: StoredCollectionMetadata,
   *   dataBackend: StorageBackend }>}
   */
  static async #authorizeQuery({
    request,
    spaceId,
    collectionId,
    requestName,
    allowTargetQuery
  }: {
    request: FastifyRequest
    spaceId: string
    collectionId: string
    requestName: string
    allowTargetQuery?: boolean
  }): ReturnType<typeof fetchCollectionAndBackend> {
    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: queryPath({ spaceId, collectionId }),
      requestName,
      allowTargetQuery
    })
    return await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })
  }

  /**
   * The `changes` profile of the Collection `query` endpoint (see `query`
   * above): parses the checkpoint/limit, pulls the page from the backend's
   * change feed, and projects it to the wire shape.
   *
   * The checkpoint is opaque on the wire (`lib/changesCheckpoint.ts`). It
   * carries a feed position scoped to this Collection's absolute URL and to
   * the generation of its feed counter, so a checkpoint issued by another
   * server or for another Collection, one in the retired `{ id, updatedAt }`
   * shape, or one issued for this Collection before it was deleted and
   * re-created is refused with `invalid-request-body` (400). A replica then
   * restarts its pull from the beginning. The generation is the backend's to
   * know, so the position is handed to the backend first and the generation
   * compared with the one its page reports.
   *
   * @param options {object}
   * @param options.reply {import('fastify').FastifyReply}
   * @param options.serverUrl {string}   this server's base URL
   * @param options.controlPlane {StorageBackend}   the control plane
   * @param options.dataBackend {StorageBackend}   the backend the feed is
   *   served from
   * @param options.spaceId {string}
   * @param options.collectionId {string}
   * @param options.body {object}   the query POST body
   * @param options.requestName {string}
   * @returns {Promise<FastifyReply>}
   */
  static async #queryChanges({
    reply,
    serverUrl,
    controlPlane,
    dataBackend,
    spaceId,
    collectionId,
    body,
    requestName
  }: {
    reply: FastifyReply
    serverUrl: string
    controlPlane: StorageBackend
    dataBackend: StorageBackend
    spaceId: string
    collectionId: string
    body: {
      checkpoint?: unknown
      limit?: unknown
    }
    requestName: string
  }): Promise<FastifyReply> {
    // The feed a checkpoint is scoped to: this Collection's canonical
    // container URL on this server.
    const feed = absoluteCollectionUrl({ spaceId, collectionId, serverUrl })

    // Parse the optional checkpoint: absent = start of feed. A present one
    // must be a checkpoint this server issued for this Collection, under the
    // generation its feed counter still carries (checked against the page
    // below).
    const refusedCheckpoint = () =>
      new InvalidRequestBodyError({
        requestName,
        detail:
          'The checkpoint was not issued by this server for this Collection.',
        pointer: '#/checkpoint'
      })
    let resumeFrom: { generation: string; position: number } | undefined
    if (body.checkpoint !== undefined) {
      resumeFrom = decodeChangesCheckpoint({
        checkpoint: body.checkpoint,
        feed
      })
      if (resumeFrom === undefined) {
        throw refusedCheckpoint()
      }
    }

    // Coerce `limit` (the requested batch size) to a positive integer, else
    // default; the backend clamps an oversized value to its own maximum.
    const DEFAULT_BATCH = 100
    const limit = coerceQueryLimit({ limit: body.limit }) ?? DEFAULT_BATCH

    const result = await dataBackend.changesSince!({
      spaceId,
      collectionId,
      ...(resumeFrom !== undefined && { afterPosition: resumeFrom.position }),
      limit
    })
    // A checkpoint from another life of this feed: the Collection was deleted
    // and re-created under the same URL since it was issued, and its counter
    // restarted at 1, so reading the position would skip the new feed up to
    // it. A feed that has handed out no position yet has no generation, and
    // no checkpoint can have been issued under it.
    if (
      resumeFrom !== undefined &&
      resumeFrom.generation !== result.feedGeneration
    ) {
      throw refusedCheckpoint()
    }

    // Project the change feed to the wire shape, one document per record,
    // discriminated on `kind`. Every document carries the record's write
    // stamp (`updatedAt`, `updatedAtCounter`, `originId`) and `generation`,
    // so a puller can decide whether to apply a change from the feed alone,
    // and the record's `etag`, quoted exactly as the `ETag` header carries
    // it, so a replica can send `If-Match` without a GET per record. The
    // stamp orders two revisions of one record; the feed itself is ordered
    // by feed position. Each document carries the opaque checkpoint that
    // resumes right after it, so a client can checkpoint on any prefix of a
    // page.
    //
    // A `resource` document's `id` is the Resource id. Its body stays under
    // `data` (kept out of the user JSON so arbitrary bodies -- not only
    // objects -- round-trip), inline for a JSON Resource only. The
    // user-writable `custom` (the opaque encryption envelope on an encrypted
    // Collection), the `/meta` record's own stamp (`meta`) and `metaEtag`
    // ride along so a metadata-only edit replicates alongside content, as
    // does the server-managed `createdBy`.
    //
    // A `collection-metadata`, `log` or `policy` document has no id of its
    // own, so its `id` is the record's absolute URL. It carries no body. A
    // `policy` document is the Collection's own policy or a Resource's, and
    // carries `deleted: true` on a tombstone.
    // `feedGeneration` is set whenever the page has a document: every
    // position on it was handed out under it.
    const issueCheckpoint = (position: number): ChangesCheckpoint =>
      encodeChangesCheckpoint({
        feed,
        generation: result.feedGeneration!,
        position
      })
    const containerRecordUrls = {
      'collection-metadata': absoluteUrl({
        path: collectionMetaPath({ spaceId, collectionId }),
        serverUrl
      }),
      log: absoluteUrl({
        path: collectionLogPath({ spaceId, collectionId }),
        serverUrl
      })
    }
    // A Collection on another server backend is fed from there, where its
    // Metadata object and log are copies under that backend's own stamps;
    // their documents take the control plane's stamp and validator, the ones
    // a GET of each record answers.
    const feedDocuments =
      dataBackend === controlPlane
        ? result.documents
        : await restampFeedFromControlPlane({
            controlPlane,
            spaceId,
            collectionId,
            documents: result.documents
          })
    const documents: ChangeDocument[] = feedDocuments.map(doc => {
      const etag = doc.validator && formatEtag(doc.validator)
      const base = {
        updatedAt: doc.updatedAt,
        updatedAtCounter: doc.updatedAtCounter,
        originId: doc.originId,
        ...(doc.validator !== undefined && {
          generation: doc.validator.generation
        }),
        checkpoint: issueCheckpoint(doc.feedPosition),
        ...(etag !== undefined && { etag })
      }
      if (doc.kind === 'policy') {
        return {
          kind: doc.kind,
          id: absoluteUrl({
            path: policyPath({
              spaceId,
              collectionId,
              resourceId: doc.resourceId
            }),
            serverUrl
          }),
          deleted: doc.deleted,
          ...base
        }
      }
      if (doc.kind !== 'resource') {
        return {
          kind: doc.kind,
          id: containerRecordUrls[doc.kind],
          deleted: false,
          ...base
        }
      }
      // The `/meta` ETag as `GET .../meta` serves it, the composite of the
      // content and `/meta` validators, so a replica can echo it as
      // `If-Match` on a metadata write.
      const metaEtag = resourceMetaEtag({
        content: doc.validator,
        meta: doc.metaValidator
      })
      return {
        kind: doc.kind,
        id: doc.resourceId,
        contentType: doc.contentType,
        deleted: doc.deleted,
        ...base,
        ...(doc.meta !== undefined && { meta: doc.meta }),
        ...(metaEtag !== undefined && { metaEtag }),
        ...(doc.createdBy !== undefined && { createdBy: doc.createdBy }),
        ...(doc.data !== undefined && { data: doc.data }),
        ...(doc.custom !== undefined && { custom: doc.custom }),
        // The client-declared key epoch (the `key-epochs` feature) rides the
        // feed so a replicating reader picks the right epoch key without a
        // `/meta` fetch.
        ...(doc.epoch !== undefined && { epoch: doc.epoch }),
        // The writer-attribution label (spec "Writer attribution") rides the
        // feed so a replica recognizes its own writes echoed back; a
        // tombstone carries the label its DELETE declared, if any.
        ...(doc.writerId !== undefined && { writerId: doc.writerId })
      }
    })

    // The page's checkpoint is its last document's, or null on an empty page.
    const checkpoint =
      result.checkpoint === null ? null : issueCheckpoint(result.checkpoint)
    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify({ documents, checkpoint }))
  }

  /**
   * DELETE /space/:spaceId/:collectionId/
   * Request handler for "Delete Collection" request (the Collection container
   * URL, in its canonical trailing-slash form). Refused with `replica-refused`
   * (409) while it holds the only copy of a log a Space's `did:webvh`
   * controller resolves from.
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { storage, serverUrl } = request.server
    const requestName = 'Delete Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Verify (capability-only): deleting a Collection requires a valid
    // capability invocation; no access-control-policy fallback.
    // The container rule: Delete Collection is controller-only. A delegated
    // capability is refused whatever its `allowedAction`.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: collectionPath({ spaceId, collectionId }),
      requestName,
      containerRule: 'controller-only'
    })

    await assertDeleteKeepsControllers({
      storage,
      serverUrl,
      spaceId,
      collectionId
    })

    // Delete Collection leaves a tombstone. A delete of an already deleted
    // Collection writes nothing and answers the masked 404,
    // the same body an absent Collection gets on a read. A delete of an id
    // with no record at all is idempotent and answers 204 (spec "Delete
    // Collection").
    let outcome: CollectionDeleteOutcome
    try {
      outcome = await storage.deleteCollection({ spaceId, collectionId })
    } catch (err) {
      // Rethrow a typed ProblemError from the data-plane backend unchanged
      // (e.g. a 507 quota / 412 precondition) rather than flattening it to a
      // 500; wrap anything genuinely unexpected. `handleError` logs the 5xx once.
      rethrowOrWrapStorageError({ err, requestName })
    } finally {
      // Deleting a Collection drops any history log a self-hosted did:webvh
      // controller resolves from it; bust every document cached from that
      // Collection. Done in `finally` because a recursive delete is not
      // atomic: a failure partway through has already removed some entries.
      // A log re-created in the Collection afterwards starts a history of its
      // own, so its recorded heads go too.
      forgetDeletedWebvhLocation({ storage, spaceId, collectionId })
      // ...and every policy cached at the Collection level or under any of
      // its Resources, and the descriptor derived from its governing log.
      invalidateCollectionPolicies({ storage, spaceId, collectionId })
      invalidateCollectionGovernedDescriptors({
        storage,
        spaceId,
        collectionId
      })
    }

    if (outcome === 'already-deleted') {
      throw new CollectionNotFoundError({ requestName })
    }
    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/
   * List Collection items: a `GET` of the Collection container lists its
   * members (spec "Reading This Document").
   *
   * With one or more `filter[<attr>]=<value>` query parameters this becomes the
   * anonymous-cacheable entry point over the same equality machinery as the
   * POST `equality` query profile: the filters map to a single-element `equals`
   * conjunction (string-valued equality only) and the handler answers the same
   * `{documents, hasMore, cursor?}` page. Authorization is the ordinary
   * capability-or-policy GET path (a `PublicCanRead` Collection answers a filter
   * query anonymously, so an HTTP cache can serve it); `allowTargetQuery`
   * already tolerates the query string. Every filter attribute MUST be declared
   * in the Collection's `plaintext.indexes` (fail-closed 400, which also covers
   * encrypted Collections -- they can never carry `plaintext`); the data-plane backend
   * MUST serve `queryByEquality` (else 501). With no `filter[...]` parameter the
   * existing listing behavior is unchanged.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string }
      Querystring: Record<string, string | string[] | undefined>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId }
    } = request
    const { limit, cursor } = parsePageParams({ query: request.query })
    const requestName = 'List Collection'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then the
    // effective access-control policy as a fallback (a public-readable Collection).
    // `allowTargetQuery` lets the signed-request path tolerate the `?limit`/
    // `cursor` pagination query parameters: per the spec they select a page
    // within an already-authorized target and do not change the capability
    // target. Authorization still runs before any cursor validation below, so an
    // under-authorized caller gets the merged 404 -- never an `invalid-cursor`.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      targetPath: collectionPath({ spaceId, collectionId }),
      requestName,
      allowTargetQuery: true
    })

    // Fetch collection by id, and list (or filter-query) from the Collection's
    // selected (data-plane) backend.
    const { collectionMetadata, dataBackend } = await fetchCollectionAndBackend(
      {
        request,
        spaceId,
        collectionId,
        requestName
      }
    )

    // GET equality filter: `filter[<attr>]=<value>` maps to the equality profile
    // over the same machinery. Present filters take this cacheable path; their
    // absence leaves the ordinary listing below untouched.
    const filters = parseListFilter({ query: request.query, requestName })
    if (filters !== undefined) {
      // Fail-closed declared-names check, the same rule as the POST profile:
      // every filter attribute MUST be declared in the Collection's
      // `plaintext.indexes` (an encrypted Collection has none, so a filter
      // there is always a 400).
      const indexes = declaredIndexesOf({ collectionMetadata })
      const declared = new Set(indexes.map(declaration => declaration.name))
      for (const name of Object.keys(filters)) {
        if (!declared.has(name)) {
          throw new InvalidRequestBodyError({
            requestName,
            detail: `Filter attribute "${name}" is not declared in the Collection's "plaintext.indexes".`,
            pointer: `#/filter/${name}`
          })
        }
      }
      if (!dataBackend.queryByEquality) {
        throw new UnsupportedOperationError({ requestName })
      }
      // The canonical GET semantics: a single-element `equals` conjunction over
      // string values. Reuse the already-parsed `limit` / `cursor` params and
      // answer the same page shape as the POST profile.
      const result = await dataBackend.queryByEquality({
        spaceId,
        collectionId,
        indexes,
        query: { equals: [{ ...filters }] },
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor })
      })
      return reply
        .status(200)
        .type('application/json')
        .send(JSON.stringify(result))
    }

    const collectionItems = await dataBackend.listCollectionItems({
      spaceId,
      collectionId,
      // Pass the control-plane Metadata object: a data-plane (external)
      // backend does not hold it, and the listing's `name`/`type`/encryption
      // flag come from it.
      collectionMetadata,
      ...(limit !== undefined && { limit }),
      ...(cursor !== undefined && { cursor })
    })

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify(collectionItems))
  }
}
