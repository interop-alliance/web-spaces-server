/**
 * Request handlers for chunk operations on a chunked Resource (the
 * `chunked-streams` feature): store, fetch, head, delete a single chunk at
 * `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex`, and list a
 * Resource's chunks at the `chunks/` container. A chunk body is opaque bytes +
 * content-type -- the server stores it exactly like a binary Resource
 * representation and never parses it (any encryption framing is client-side),
 * so the Collection-level encryption conformance check deliberately does NOT
 * apply here: an encrypted stream's chunks are ciphertext fragments, not
 * envelope documents.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fetchSpaceAndAuthorize, fetchSpaceAndVerify } from './spaceContext.js'
import {
  assertOwnReadOfParentServed,
  fetchBackendForResourceRead,
  fetchCollectionAndBackend,
  getResourceMetadataOrThrow,
  readChunkMetadataOrThrow,
  readGatedOnParentResource,
  writeOnceOptions
} from './collectionContext.js'
import { resolveResourceInput } from './resourceInput.js'
import { assertValidIds } from '../lib/validateId.js'
import { parseChunkIndexSegment } from '@interop/space-archive'
import { chunkPath, chunksContainerPath } from '../lib/paths.js'
import { etagOf, formatEtag, parseWritePreconditions } from '../lib/etag.js'
import { InvalidChunkIndexError, ResourceNotFoundError } from '../errors.js'
import { withStorageErrors } from '../lib/storageErrors.js'
import type { StorageBackend } from '../types.js'
import {
  notModifiedBeforeStream,
  sendHeadFromMetadata,
  withEtag
} from './notModified.js'

/**
 * Parses and validates the `:chunkIndex` path param -- the canonical decimal
 * spelling of an integer in `[0, MAX_CHUNK_INDEX]` (see
 * `parseChunkIndexSegment`) -- throwing `InvalidChunkIndexError` (400)
 * otherwise. Runs before any storage access, like `assertValidIds`.
 * @param raw {string}   the `:chunkIndex` path param
 * @param options {object}
 * @param options.requestName {string}   request name used in the error title
 * @returns {number}
 */
function parseChunkIndex(
  raw: string,
  { requestName }: { requestName: string }
): number {
  const chunkIndex = parseChunkIndexSegment(raw)
  if (chunkIndex === undefined) {
    throw new InvalidChunkIndexError({ requestName })
  }
  return chunkIndex
}

/** The URL params every chunk-member route carries. */
interface ChunkParams {
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: string
}

/**
 * The prologue Get Chunk and Head Chunk share. Validates the ids and the
 * `:chunkIndex` param before any storage access, authorizes the read
 * (capability-or-policy) against the chunk's own URL with the policy level
 * resolved at the parent Resource, as for Get Resource, and only then fetches
 * the Collection and its selected (data-plane) backend.
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.requestName {string}   request name used in error titles
 * @returns {Promise<object>}   the parsed ids, the chunk index, the
 *   Collection's data-plane backend, and `confirmOwnRead`, which the handler
 *   awaits once it holds what it serves: under an `OwnResourcesOnly` caveat
 *   it requires that the parent Resource is still the one the read was
 *   decided from
 */
async function authorizeChunkRead({
  request,
  requestName
}: {
  request: FastifyRequest<{ Params: ChunkParams }>
  requestName: string
}): Promise<{
  spaceId: string
  collectionId: string
  resourceId: string
  chunkIndex: number
  dataBackend: StorageBackend
  confirmOwnRead: () => Promise<void>
}> {
  const {
    params: { spaceId, collectionId, resourceId }
  } = request

  // Reject path-traversal / non-URL-safe ids before any storage access.
  assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
  const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
    requestName
  })

  // Authorize (capability-or-policy) against the chunk's own URL; the policy
  // level resolves at the parent Resource, as for Get Resource.
  const { ownResourcesOnly } = await fetchSpaceAndAuthorize({
    request,
    spaceId,
    collectionId,
    resourceId,
    targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
    requestName,
    ownResources: 'resource'
  })

  // authorized, continue

  // Fetch collection by id, and its selected (data-plane) backend. Under an
  // `OwnResourcesOnly` caveat a chunk is decided by its parent Resource's
  // `createdBy`.
  const { dataBackend, ownRead } = await fetchBackendForResourceRead({
    request,
    ownResourcesOnly,
    spaceId,
    collectionId,
    resourceId,
    requestName
  })
  const confirmOwnRead = () =>
    assertOwnReadOfParentServed({
      ownRead,
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })
  return {
    spaceId,
    collectionId,
    resourceId,
    chunkIndex,
    dataBackend,
    confirmOwnRead
  }
}

export class ChunkRequest {
  /**
   * PUT /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Put Chunk": stores chunk `chunkIndex` of the Resource
   * (raw bytes body, upsert). The parent Resource MUST already exist (404
   * otherwise -- chunks cannot be orphaned). Authorization is capability-only
   * against the chunk's own full URL, the same exact-match zcap target rule as
   * every other route. Supports `If-Match` / `If-None-Match` on the chunk's
   * own ETag, and the backend's `maxUploadBytes` cap (413). Returns 204 with
   * the chunk's new ETag.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async put(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'Put Chunk'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
      requestName
    })

    // Verify (capability-only): writing a chunk requires a valid capability
    // invocation against the chunk's own URL; no access-control-policy fallback.
    const { ownResourcesOnly: ownedBy } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
      requestName,
      ownResources: 'resource'
    })

    // zCap checks out, continue

    // Fetch collection by id, and route chunk bytes to the Collection's
    // selected (data-plane) backend.
    const { collectionMetadata, dataBackend } = await fetchCollectionAndBackend(
      {
        request,
        spaceId,
        collectionId,
        requestName
      }
    )
    // The route scope removed the JSON and text parsers, so the body arrives
    // as a stream and is stored as received whatever media type it declares.
    const input = await resolveResourceInput(request)
    // Surface any `If-Match` / `If-None-Match` write precondition to the
    // storage layer, which evaluates it against the chunk's own validator
    // atomically with the write (412 `precondition-failed` on a mismatch).
    const written = await withStorageErrors({ requestName }, () =>
      dataBackend
        .writeChunk({
          spaceId,
          collectionId,
          resourceId,
          chunkIndex,
          input,
          // Chunks inherit the Collection's write-once rule
          // (`revisions.immutable`).
          ...writeOnceOptions({
            request,
            spaceId,
            collectionId,
            collectionMetadata
          }),
          ownedBy,
          ...parseWritePreconditions(request.headers)
        })
        // The backend names an absent parent under its own request name.
        // The masked body must be the one every other refusal of this
        // request carries.
        .catch((err: unknown) => {
          if (err instanceof ResourceNotFoundError) {
            throw new ResourceNotFoundError({ requestName })
          }
          throw err
        })
    )
    // Return the new ETag so a client can chain a subsequent conditional write.
    return reply.status(204).header('etag', formatEtag(written)).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Get Chunk": streams the chunk's stored bytes.
   * Authorization is capability-or-policy (the same read decision as Get
   * Resource, resolved at the Resource's policy level -- a chunk reveals a
   * fragment of the same content).
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Get Chunk'
    const {
      spaceId,
      collectionId,
      resourceId,
      chunkIndex,
      dataBackend,
      confirmOwnRead
    } = await authorizeChunkRead({ request, requestName })

    // A conditional read (spec "Caching") consults the chunk's metadata first
    // (through the same parent-Resource gate as Head Chunk) and answers 304
    // without opening the byte stream.
    const notModified = await notModifiedBeforeStream({
      request,
      reply,
      readMetadata: () =>
        readChunkMetadataOrThrow({
          dataBackend,
          spaceId,
          collectionId,
          resourceId,
          chunkIndex,
          requestName
        })
    })
    if (notModified) {
      return reply
    }

    // The parent Resource must exist (and not be a tombstone) for any of its
    // chunks to be readable: an orphan chunk left behind by out-of-band
    // state 404s here exactly like the Resource route and the chunk listing
    // do -- checked via its metadata, never its byte stream. A chunk stream
    // the gate discards is destroyed, since the filesystem backend has
    // already opened its file descriptor by then.
    const result = await withStorageErrors({ requestName }, () =>
      readGatedOnParentResource({
        dataBackend,
        spaceId,
        collectionId,
        resourceId,
        companion: dataBackend.getChunk({
          spaceId,
          collectionId,
          resourceId,
          chunkIndex
        }),
        discard: ({ resourceStream }) => resourceStream.destroy(),
        requestName
      })
    )
    // The stream is already open, so it is destroyed on a refusal.
    try {
      await confirmOwnRead()
    } catch (err) {
      result.resourceStream.destroy()
      throw err
    }

    return withEtag({
      reply: reply.status(200).type(result.storedResourceType),
      etag: etagOf(result)
    }).send(result.resourceStream)
  }

  /**
   * HEAD /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Head Chunk": the same authorization as Get Chunk with
   * no response body; `Content-Type` / `Content-Length` come from the chunk's
   * stored metadata, so the byte stream is never opened (mirrors Head
   * Resource). Registered explicitly ahead of the GET route for the same
   * reason Head Resource is.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async head(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const requestName = 'Head Chunk'
    // The same read decision as Get Chunk, against the same target (a HEAD
    // reveals nothing a GET would not).
    const {
      spaceId,
      collectionId,
      resourceId,
      chunkIndex,
      dataBackend,
      confirmOwnRead
    } = await authorizeChunkRead({ request, requestName })
    // The same parent-Resource existence gate as Get Chunk (an orphan chunk's
    // headers reveal what a GET would).
    const metadata = await readChunkMetadataOrThrow({
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      chunkIndex,
      requestName
    })
    await confirmOwnRead()

    return sendHeadFromMetadata({ request, reply, metadata })
  }

  /**
   * DELETE /space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex
   * Request handler for "Delete Chunk": removes one stored chunk. Unlike
   * Delete Resource, deleting an absent chunk is a 404 (mirroring the EDV
   * chunk contract -- a reassembling reader must be able to distinguish "gone"
   * from "never written"). Authorization is capability-only against the
   * chunk's own URL. Supports `If-Match` (412 on mismatch). Returns 204.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async delete(
    request: FastifyRequest<{ Params: ChunkParams }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'Delete Chunk'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })
    const chunkIndex = parseChunkIndex(request.params.chunkIndex, {
      requestName
    })

    // Verify (capability-only): deleting a chunk requires a valid capability
    // invocation; no access-control-policy fallback.
    const { ownResourcesOnly: ownedBy } = await fetchSpaceAndVerify({
      request,
      spaceId,
      targetPath: chunkPath({ spaceId, collectionId, resourceId, chunkIndex }),
      requestName,
      ownResources: 'resource'
    })

    // Fetch collection by id, and delete from the Collection's selected
    // (data-plane) backend.
    const { dataBackend } = await fetchCollectionAndBackend({
      request,
      spaceId,
      collectionId,
      requestName
    })

    // zCap checks out, continue. An `If-Match` precondition is evaluated by
    // the storage layer atomically with the removal (412 on mismatch).
    const { ifMatch } = parseWritePreconditions(request.headers)
    const removed = await withStorageErrors({ requestName }, async () => {
      // The same parent-Resource existence gate as the read handlers: a
      // chunk of an absent (or tombstoned) parent is a 404, not a deletable
      // orphan.
      await getResourceMetadataOrThrow({
        dataBackend,
        spaceId,
        collectionId,
        resourceId,
        requestName
      })
      return await dataBackend.deleteChunk({
        spaceId,
        collectionId,
        resourceId,
        chunkIndex,
        ifMatch,
        ownedBy
      })
    })
    if (!removed) {
      throw new ResourceNotFoundError({ requestName })
    }

    return reply.status(204).send()
  }

  /**
   * GET /space/:spaceId/:collectionId/:resourceId/chunks/
   * Request handler for "List Chunks": the discovery/reassembly listing. The
   * server never reassembles a chunked Resource -- a reader learns the chunk
   * set here (count + per-chunk index/size/contentType/etag) and fetches
   * `0..count-1` itself. `count` is the number of chunks stored, not their
   * total byte size (sum the per-chunk `size` values for that). It matches
   * the highest index plus one only when no index is missing. Each entry's
   * `etag` is the `ETag` the chunk's own GET and HEAD answer with, and the
   * one its GET answers 304 against, so a client can pin a `DELETE` with
   * `If-Match`, or read a chunk conditionally, without a HEAD per chunk. Requires the
   * parent Resource to exist (404 otherwise). Authorization is
   * capability-or-policy against the `chunks/` container path, resolved at
   * the Resource's policy level. Chunks count toward the Space's byte quota.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async list(
    request: FastifyRequest<{
      Params: { spaceId: string; collectionId: string; resourceId: string }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const {
      params: { spaceId, collectionId, resourceId }
    } = request
    const requestName = 'List Chunks'

    // Reject path-traversal / non-URL-safe ids before any storage access.
    assertValidIds({ spaceId, collectionId, resourceId }, { requestName })

    // Authorize (capability-or-policy) against the `chunks/` container path;
    // the policy level resolves at the parent Resource.
    const { ownResourcesOnly } = await fetchSpaceAndAuthorize({
      request,
      spaceId,
      collectionId,
      resourceId,
      targetPath: chunksContainerPath({ spaceId, collectionId, resourceId }),
      requestName,
      ownResources: 'resource'
    })

    // authorized, continue

    // Fetch collection by id, and list from the Collection's selected
    // (data-plane) backend. The parent Resource must exist for its chunk
    // listing to (an absent Resource has no `chunks/` container) -- checked via
    // its metadata, never its byte stream.
    const { dataBackend, ownRead } = await fetchBackendForResourceRead({
      request,
      ownResourcesOnly,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })
    const listing = await withStorageErrors({ requestName }, () =>
      readGatedOnParentResource({
        dataBackend,
        spaceId,
        collectionId,
        resourceId,
        companion: dataBackend.listChunks({
          spaceId,
          collectionId,
          resourceId
        }),
        requestName
      })
    )
    // Under an `OwnResourcesOnly` caveat the parent Resource is still the one
    // the read was decided from.
    await assertOwnReadOfParentServed({
      ownRead,
      dataBackend,
      spaceId,
      collectionId,
      resourceId,
      requestName
    })

    return reply
      .status(200)
      .type('application/json')
      .send(JSON.stringify({ resourceId, ...listing }))
  }
}
