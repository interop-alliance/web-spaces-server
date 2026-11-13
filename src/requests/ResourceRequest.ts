/**
 * Request handlers for Resource operations: create-by-id, get, and delete a
 * Resource (JSON object or binary blob).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import {
  fetchCollectionAndBackend,
  getCollectionOrThrow,
  getResourceMetadataOrThrow,
  isControlPlaneBackend,
  resourceWriteOptions
} from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { resolveBackend } from '../lib/backendRegistry.js'
import { assertValidIds } from '../lib/validateId.js'
import { resolveMetadataCustom } from '../lib/customMetadata.js'
import { assertJsonObjectBody } from '../lib/requestBody.js'
import { resourcePath, metaPath } from '../lib/paths.js'
import {
  etagOf,
  formatEtag,
  parseWritePreconditions,
  resourceMetaEtag,
  resourceMetaEtagOf
} from '../lib/etag.js'
import { parseMetaEpoch } from '../lib/keyEpoch.js'
import { parseWriterIdHeader } from '../lib/writerAttribution.js'
import { invalidateResolvedWebvhDid } from '../lib/webvhController.js'
import { invalidatePolicy } from '../lib/policyCache.js'
import { guardWebvhLogWrite } from '../lib/webvhLogWrite.js'
import { WEBVH_LOG_RESOURCE_ID } from '../lib/validateDid.js'
import { MethodNotAllowedError, ResourceNotFoundError } from '../errors.js'
import { withStorageErrors } from '../lib/storageErrors.js'
import {
  notModifiedBeforeStream,
  notModifiedReply,
  sendHeadFromMetadata,
  withEtag
} from './notModified.js'
import type { ResourceMetadata, ResourceWriteMembers } from '../types.js'

/**
 * The body of a Resource write response: the server-managed members of the
 * Resource Metadata object as the write left them. `contentType`, `size` and
 * the content record's stamp always. `createdAt` and `createdBy` only when
 * the write recorded them (`provenance`), so a writer learns no provenance
 * it did not cause. The `/meta` record's stamp only on a metadata write
 * (`metaStamp`). No `custom`, `epoch`, or `writerId`.
 * @param options {object}
 * @param options.members {ResourceWriteMembers}
 * @param [options.provenance] {boolean}   the write created the Resource
 * @param [options.metaStamp] {boolean}   the write was a metadata write
 * @returns {Partial<ResourceMetadata>}
 */
function writeResponseBody({
  members: { contentType, size, createdAt, createdBy, meta, ...stamp },
  provenance = false,
  metaStamp = false
}: {
  members: ResourceWriteMembers
  provenance?: boolean
  metaStamp?: boolean
}): Partial<ResourceMetadata> {
  return {
    contentType,
    size,
    ...(provenance && createdAt !== undefined && { createdAt }),
    ...stamp,
    ...(provenance && createdBy !== undefined && { createdBy }),
    ...(metaStamp && meta !== undefined && { meta })
  }
}

export class ResourceRequest {
  /**
   * PUT /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Create (or Update) Resource by Id" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Put Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Verify (capability-only): creating/updating a Resource requires a valid
    // capability invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // zCap checks out, continue

    // Fetch collection by id
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // Route resource bytes to the Collection's selected (data-plane) backend.
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionMetadata
    })
    // Runs the encrypted-Collection conformance check (422) after auth and the
    // 404 above, so it is only observable by a caller authorized to write here.
    const resolvedInput = await resolveResourceInput(request, {
      collectionMetadata
    })
    // A `did.jsonl` in any Collection may be the history log a self-hosted
    // did:webvh controller resolves from, so its write must fast-forward the
    // stored log (412 otherwise), under preconditions pinned to the log read.
    const clientPreconditions = parseWritePreconditions(request.headers)
    const { input, ...preconditions } =
      resourceId === WEBVH_LOG_RESOURCE_ID
        ? await guardWebvhLogWrite({
            request,
            reply,
            dataBackend,
            spaceId,
            collectionId,
            input: resolvedInput,
            ...clientPreconditions,
            requestName
          })
        : { input: resolvedInput, ...clientPreconditions }
    // The key epoch, writer id, unique indexes, write-once rule and
    // `createdBy` of the write (`resourceWriteOptions`).
    const writeOptions = resourceWriteOptions({
      request,
      spaceId,
      collectionId,
      collectionMetadata,
      requestName
    })
    // Surface any `If-Match` / `If-None-Match` write precondition to the storage
    // layer, which evaluates it atomically with the write (returning 412
    // `precondition-failed` on a mismatch -- rethrown unchanged below).
    const written = await withStorageErrors({ requestName }, () =>
      dataBackend.writeResource({
        spaceId,
        collectionId,
        resourceId,
        input,
        ...writeOptions,
        ...preconditions
      })
    )
    // A write of `did.jsonl` into ANY Collection may replace the history log a
    // self-hosted did:webvh controller resolves from, so any document cached
    // from the previous log is stale as of this write.
    invalidateResolvedWebvhDid({ storage, spaceId, collectionId, resourceId })
    // `201` when the write created the Resource (over a tombstone included),
    // `200` when it updated a live one. A write the write-once rule answered
    // as a repeat updated nothing, but the Resource is live: `200`. The body
    // is the server-managed members as the write left them, and the new
    // `ETag` lets a client chain a subsequent conditional write.
    return reply
      .status(written.created ? 201 : 200)
      .header('etag', formatEtag(written.validator))
      .type('application/json')
      .send(
        JSON.stringify(
          writeResponseBody({
            members: written.members,
            provenance: written.created
          })
        )
      )
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Get Resource" request
   * Before this, `parseAuthHeaders()` hook executed, resulting in:
   * request.zcap: {
   *   keyId, headers, signature, created, expires, invocation, digest
   * }
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'Get Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy): capability invocation first, then fall
    // back to the effective access-control policy (e.g. a world-readable
    // Resource). Throws on denial.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // authorized, continue

    // Fetch collection by id, and read the bytes from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // A conditional read (spec "Caching") consults the Metadata first and
    // answers 304 without opening the byte stream.
    const notModified = await notModifiedBeforeStream({
      request,
      reply,
      readMetadata: () =>
        getResourceMetadataOrThrow({
          dataBackend,
          spaceId,
          collectionId,
          resourceId,
          requestName
        })
    })
    if (notModified) {
      return reply
    }

    const contentType = request.headers['content-type']
    // Rethrow a typed ProblemError unchanged -- `getResource`'s
    // ResourceNotFoundError (404) for an absent resource, or a typed fault a
    // data-plane backend raises -- and wrap anything unexpected as a 500.
    const result = await withStorageErrors({ requestName }, () =>
      dataBackend.getResource({
        spaceId,
        collectionId,
        resourceId,
        contentType
      })
    )

    // Surface the ETag validator (the conditional-writes feature) when the
    // backend tracks one for this Resource.
    return withEtag({
      reply: reply.status(200).type(result.storedResourceType),
      etag: etagOf(result)
    }).send(result.resourceStream)
  }

  /**
   * HEAD /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Head Resource" request: the same authorization as Get
   * Resource but with no response body. Per spec "Content Types and
   * Representations", the response `Content-Type` and `Content-Length`
   * correspond to the `contentType` and `size` of the Resource's Metadata object
   * (the bytes a GET would return). HEAD is a safe method, authorized as a read
   * (capability-or-policy), the same as GET; it reads only the Metadata so it
   * never opens the resource byte stream.
   *
   * Registered explicitly (ahead of the GET route) rather than relying on
   * Fastify's auto-exposed HEAD, which would share the GET handler and stream
   * the whole body -- yielding no `Content-Length` for a streamed representation.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async head(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'Head Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy): the same read decision as Get Resource,
    // against the same target (a HEAD reveals nothing a GET would not).
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // authorized, continue

    // Fetch collection by id, and read Metadata from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })
    const metadata = await getResourceMetadataOrThrow({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })

    return sendHeadFromMetadata({ request, reply, metadata })
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId/meta
   * Request handler for "Read Resource Metadata" request. Returns the REQUIRED
   * server-managed fields (`contentType`, `size`), the OPTIONAL `createdAt` /
   * `updatedAt` timestamps, and the user-writable `custom` object (omitted when
   * empty). Authorization is capability-or-policy, the same as Get Resource:
   * metadata reveals nothing beyond what a GET of the resource itself exposes via
   * Content-Type / Content-Length, so a `PublicCanRead` policy also grants
   * metadata reads.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async getMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'Get Resource Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy): the capability's `invocationTarget` is
    // the full `/meta` URL (matching the request URL), and the policy level
    // resolves at the resource as for Get Resource.
    await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: metaPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // authorized, continue

    // Fetch collection by id, and read Metadata from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })
    const metadata = await getResourceMetadataOrThrow({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })

    // The content `generation` is an out-of-band ETag part, not part of the
    // Resource Metadata wire body, so it is stripped before serializing; the
    // content record's stamp stays as the top-level members. The body mixes
    // members of the content record (`contentType`, `size`, the content
    // stamp, `epoch`, `writerId`) and of the `/meta` record (`custom`, the
    // nested `meta` stamp), so its ETag is the composite of both validators,
    // content first. A content write and a `/meta` write each move it. Before
    // any metadata write it is the content ETag alone. A `/meta` write leaves
    // the Resource's own ETag untouched.
    const { generation: _generation, ...metadataBody } = metadata
    const metaEtag = resourceMetaEtagOf(metadata)

    // A conditional read (spec "Caching") against the `/meta` ETag.
    const notModified = notModifiedReply({ request, reply, etag: metaEtag })
    if (notModified) {
      return notModified
    }

    return withEtag({
      reply: reply.status(200).type('application/json'),
      etag: metaEtag
    }).send(JSON.stringify(metadataBody))
  }

  /**
   * PUT /space/:spaceId/:collectionId/:resourceId/meta
   * Request handler for "Update Resource Metadata" request. A full replacement
   * of the Metadata object's user-writable `custom` object (any property omitted
   * is cleared; a body with no `custom` clears them all). The body may also
   * carry `epoch` (omitted preserves the stored stamp). Server-managed
   * properties are untouched, and any other top-level property in the body
   * is ignored, `writerId` included: the label belongs to the content record
   * and a metadata write leaves it as it is. So a client may GET-modify-PUT
   * the whole object. Does NOT create: a `PUT` to the `/meta` of a
   * nonexistent Resource is a 404.
   * Authorization is capability-only (the `PUT` action), the same as Put
   * Resource. Returns 200 with the server-managed members as the write left
   * them, the `/meta` record's stamp included.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async putMeta(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
      Body: unknown
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'Update Resource Metadata'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Pre-auth body shape (400): the body MUST be a JSON object. The deeper
    // `custom` shape check is deferred until after authorization, where the
    // Collection's `encryption` descriptor decides whether `custom` is a plaintext
    // `{ name, tags }` or an opaque envelope (see `resolveMetadataCustom`) --
    // neither is knowable before reading the Collection Metadata object, and gating
    // the check on auth keeps a 422/400 observable only to a caller authorized to
    // write here.
    const body = assertJsonObjectBody({
      body: request.body,
      requestName,
      detail: 'Request body must be a JSON object.'
    })

    // Verify (capability-only): writing metadata requires a valid capability
    // invocation (the `PUT` action); no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: metaPath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // zCap checks out, continue

    // Fetch collection by id
    const collectionMetadata = await getCollectionOrThrow({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // Branch on the Collection's encryption descriptor. On an encrypted Collection
    // a non-empty `custom` MUST be a conforming envelope of the scheme (stored
    // opaquely, `422` on a plaintext/malformed value); on a plaintext Collection
    // it MUST be a well-formed `{ name, tags }` object (`400` otherwise). An
    // empty or omitted `custom` clears the stored annotations on both, and a
    // `custom` that is not a JSON object is a `400` on both.
    const custom = resolveMetadataCustom({
      collectionMetadata,
      body,
      requestName
    })

    // The key-epoch stamp (the `key-epochs` feature) MAY also be declared here
    // as a top-level `epoch` member (a sibling of `custom`). Unlike `custom`
    // (full-replace), an omitted `epoch` PRESERVES the stored value -- it
    // describes the content write, not the metadata write. A present value must
    // be a non-empty string (400).
    const { epoch } = parseMetaEpoch({ body, requestName })

    // Write Metadata to the Collection's selected (data-plane) backend. An
    // `If-Match` / `If-None-Match` precondition (the `conditional-writes`
    // feature) is evaluated on the `/meta` `ETag` a GET serves atomically
    // with the write; a mismatch surfaces as 412 `precondition-failed` (rethrown unchanged).
    const dataBackend = await resolveBackend({
      request,
      spaceId,
      collectionId,
      collectionMetadata
    })
    const written = await withStorageErrors({ requestName }, () =>
      dataBackend.writeResourceMetadata({
        spaceId,
        collectionId,
        resourceId,
        custom,
        epoch,
        ...parseWritePreconditions(request.headers)
      })
    )
    // A Metadata object cannot exist apart from its Resource: a PUT to the
    // `/meta` of a nonexistent Resource is a 404 (this operation does not create).
    if (!written) {
      throw new ResourceNotFoundError({ requestName })
    }

    // Return the new `/meta` ETag (the composite of the content record's
    // validator and the `/meta` record's) so a client can chain a subsequent
    // conditional metadata write, and the server-managed members as the
    // write left them. A metadata write never creates, so the body carries
    // no provenance.
    const metaEtag = resourceMetaEtag({
      content: written.contentValidator,
      meta: written.validator
    })
    return withEtag({ reply: reply.status(200), etag: metaEtag })
      .type('application/json')
      .send(
        JSON.stringify(
          writeResponseBody({ members: written.members, metaStamp: true })
        )
      )
  }

  /**
   * DELETE /space/:spaceId/:collectionId/:resourceId
   * Request handler for "Delete Resource" request
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
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const { storage } = request.server
    const requestName = 'Delete Resource'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // A `did.jsonl` in any Collection may be the history log a self-hosted
    // did:webvh controller resolves from, and removing it would leave that
    // controller unresolvable, the controller's own invocations included. It
    // goes away only with its Collection or Space. The refusal reads no
    // storage, so it answers the same whether or not the log exists.
    if (resourceId === WEBVH_LOG_RESOURCE_ID) {
      throw new MethodNotAllowedError({
        allow: ['GET', 'HEAD', 'PUT'],
        hint: 'A did:webvh history log is removed only with its Collection or Space.'
      })
    }

    // Verify (capability-only): deleting a Resource requires a valid capability
    // invocation; no access-control-policy fallback.
    await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: resourcePath({ spaceId, collectionId, resourceId }),
      requestName
    })

    // Fetch collection by id, and delete from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // zCap checks out, continue. An `If-Match` precondition is evaluated by the
    // storage layer atomically with the removal; a mismatch surfaces as 412
    // `precondition-failed` (rethrown unchanged below).
    const { ifMatch } = parseWritePreconditions(request.headers)
    // A deletion is a revision like any other, so the `Writer-Id` header MAY
    // declare its own writer-attribution label (spec "Writer attribution");
    // where the backend keeps a tombstone, this is the label it carries.
    // Absent clears any stored label, the same as a content write.
    const { writerId } = parseWriterIdHeader({
      headers: request.headers,
      requestName
    })
    await withStorageErrors({ requestName }, async () => {
      await dataBackend.deleteResource({
        spaceId,
        collectionId,
        resourceId,
        ifMatch,
        writerId
      })
      // An external data-plane backend keeps no policies, so the Resource's
      // policy is tombstoned in the control-plane store here. The two stores
      // make this non-atomic: a fault between the two writes leaves the
      // policy live over a deleted Resource, and a retried delete removes it.
      if (!isControlPlaneBackend({ request, dataBackend })) {
        await storage.deletePolicy({ spaceId, collectionId, resourceId })
      }
    })
    // The delete tombstoned the Resource's policy, so drop its cached grant.
    invalidatePolicy({ storage, spaceId, collectionId, resourceId })
    return reply.status(204).send()
  }
}
