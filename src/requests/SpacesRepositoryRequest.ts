/**
 * Request handler for SpacesRepository operations:
 * - POST /spaces/ (Create Space)
 * - GET /spaces/ (List Spaces).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import {
  baseDelegationSigner,
  isRootInvocation,
  verifyRequestZcap
} from '../zcap.js'
import { invalidateSpaceMetadata } from '../lib/spaceMetadataCache.js'
import {
  projectSpaceMetadata,
  writableSpaceMetadata
} from '../lib/spaceProjection.js'
import { formatEtag } from '../lib/etag.js'
import {
  assertBodyController,
  verifyBodyControllerConsent
} from './controllerConsent.js'
import { createdByOf } from '../auth-header-hooks.js'
import { assertCreatableSpaceId, assertValidId } from '../lib/validateId.js'
import {
  absoluteSpaceUrl,
  absoluteUrl,
  spacePath,
  spacesPath
} from '../lib/paths.js'
import { decodeCursor } from '../lib/cursor.js'
import {
  compareCodeUnits,
  nextPageUrl,
  parsePageParams,
  resolvePageSize
} from '../lib/pagination.js'
import { assertValidController, didOfMethodId } from '../lib/validateDid.js'
import {
  assertClientCreatableSpaceType,
  assertValidSpaceType,
  defaultSpaceType
} from '../lib/spaceType.js'
import {
  SpaceControllerMismatchError,
  IdConflictError,
  PreconditionFailedError,
  ProblemError
} from '../errors.js'
import type {
  IDID,
  MetadataWriteResult,
  SpaceMetadata,
  SpaceSummary,
  SpaceListing
} from '../types.js'

export class SpacesRepositoryRequest {
  /**
   * GET /spaces/
   * Request handler for "List Spaces" (spec "List Spaces Operation"): returns
   * `{ url, totalItems, items }` with only the Spaces the caller is authorized
   * to see. An anonymous or unauthorized request is NOT an error -- it gets the
   * empty-items 200, the spec's explicit exception to 404 masking -- so nothing
   * is revealed about which Spaces exist.
   *
   * Authorization is per Space controller: the root capability for `/spaces/`
   * is synthesized with the candidate Space's controller (see `verifyZcap`), so
   * one verification decides visibility for every Space sharing that
   * controller. Only one controller can verify: a bare-root invocation only
   * where the signer *is* the controller, a delegated one only where the
   * controller signed the chain's base delegation. The candidates are
   * filtered to that controller before any signature work, so a request costs
   * at most one verification however many controllers the server hosts. The
   * verification is the one every route runs, with the `did:webvh` resolver
   * and the client-annex clause, so a Space promoted to a self-hosted
   * `did:webvh` is listed for its controller. No revocation scope applies: a
   * delegated chain here roots in the `/spaces/` root capability, which no
   * revocation route accepts, so a listing grant is bounded by its `expires`.
   *
   * Auxiliary Spaces (typed `AuxiliarySpace`) are listed like any other. They
   * count toward the controller's `maxSpacesPerController` quota, so the
   * controller must be able to see what uses it. Each item carries the Space's
   * `type` array, so a wallet tells an auxiliary Space from a data Space
   * without a Read Space per item.
   *
   * OPTIONALLY cursor-paginated (spec "Pagination"): pagination happens here in
   * the handler, not the backend, because the page is a page of AUTHORIZED
   * items and the per-controller authorization filtering lives here. Spaces are
   * ordered by `id` ascending (code-unit), a `cursor` resumes strictly after
   * its anchor id, and a `next` link is emitted when one more authorized item
   * exists beyond the page. `totalItems` -- the full authorized count -- is
   * included ONLY on a complete, unpaginated listing (no `cursor` supplied and
   * the scan reached the end without a `next`); otherwise it is omitted, since
   * the spec permits it and computing the true total would mean verifying every
   * candidate controller.
   *
   * @param request {import('fastify').FastifyRequest}
   * @param reply {import('fastify').FastifyReply}
   * @returns {Promise<FastifyReply>}
   */
  static async get(
    request: FastifyRequest<{
      Querystring: Record<string, string | string[] | undefined>
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { serverUrl, storage } = request.server

    const items: SpaceSummary[] = []

    // No (complete) authorization presented: authorized to see no Spaces,
    // which is the empty 200, not an error. This runs BEFORE any cursor
    // validation, so an anonymous caller with a garbage cursor still gets the
    // empty 200 rather than an `invalid-cursor`.
    if (!request.zcap?.invocation) {
      return reply.send({
        url: spacesPath(),
        totalItems: 0,
        items
      } satisfies SpaceListing)
    }

    const { keyId, invocation } = request.zcap
    const zcapSigningDid = didOfMethodId(keyId)
    const rootInvocation = isRootInvocation({ invocation })
    const allowedTarget = absoluteUrl({ path: spacesPath(), serverUrl })

    const { limit, cursor } = parsePageParams({ query: request.query })

    // Decode the cursor now -- after the anonymous early-return, so an anonymous
    // caller never trips it. The per-space verification below is the
    // authorization; an invalid cursor from an authenticated caller is a 400
    // `invalid-cursor` (the spec's ordering note, as closely as this
    // per-controller-filtered operation allows).
    const after = cursor !== undefined ? decodeCursor(cursor).after : undefined

    const pageSize = resolvePageSize(limit)

    // The one controller whose Spaces this invocation can reveal (see above).
    // `undefined` when a delegated invocation's chain cannot be read, which
    // could not verify for any controller either.
    const eligibleController = rootInvocation
      ? zcapSigningDid
      : baseDelegationSigner({ invocation })

    // The eligible controller's Spaces, sorted by `id` ascending in code-unit
    // order -- the keyset order the cursor seeks within; do not rely on
    // backend ordering.
    const spaces = (await storage.listSpaces())
      .filter(space => space.controller === eligibleController)
      .sort((left, right) => compareCodeUnits(left.id, right.id))

    // Seek to the first space id strictly greater than the cursor's anchor.
    const found =
      after === undefined ? 0 : spaces.findIndex(space => space.id > after)
    const startIndex = found === -1 ? spaces.length : found
    // Verified lazily, on the first Space the eligible controller holds, and
    // at most once. A failed verification just excludes that controller's
    // Spaces -- never an error response.
    let authorized: boolean | undefined

    // Fill the page: collect authorized items in id order from the seek point.
    // Once the page is full, keep scanning only until ONE more authorized item
    // is found -- that sets `hasMore` (and thus `next`) -- rather than verifying
    // the whole tail.
    let hasMore = false
    for (let index = startIndex; index < spaces.length; index++) {
      const space = spaces[index]!
      if (authorized === undefined) {
        try {
          await verifyRequestZcap({
            request,
            allowedTarget,
            allowedAction: 'GET',
            spaceController: space.controller,
            requestName: 'List Spaces',
            // The `?limit`/`cursor` query selects a page of an already-
            // authorized target; it must still verify against the bare
            // `/spaces/` root capability (see `verifyZcap`).
            allowTargetQuery: true,
            // A chain rooted in the `/spaces/` root capability has no scope a
            // revocation could be stored under (see above).
            revocation: 'no-revocation-scope'
          })
          authorized = true
        } catch (err) {
          // A server-side fault (a storage error under a did:webvh log read)
          // is not a denial and keeps its 5xx.
          if (err instanceof ProblemError && err.statusCode >= 500) {
            throw err
          }
          request.log.debug(
            { err },
            'List Spaces: invocation did not verify for the candidate controller'
          )
          authorized = false
        }
      }
      if (!authorized) {
        continue
      }
      if (items.length === pageSize) {
        // One authorized item beyond a full page: there is a further page, but
        // we stop here without verifying the rest of the tail.
        hasMore = true
        break
      }
      // A Space is a container, so its `url` is the canonical trailing-slash
      // form (spec "Space Metadata Data Model").
      const item: SpaceSummary = {
        id: space.id,
        url: spacePath({ spaceId: space.id }),
        type: [...space.type].sort()
      }
      if (space.name !== undefined) {
        item.name = space.name
      }
      items.push(item)
    }

    const listing: SpaceListing = { url: spacesPath(), items }
    if (hasMore) {
      listing.next = nextPageUrl({
        path: spacesPath(),
        limit: pageSize,
        after: items[items.length - 1]!.id
      })
    }
    // `totalItems` is the full authorized count only when this response IS the
    // complete authorized set: no cursor was supplied AND the scan reached the
    // end without truncation (no `next`).
    if (cursor === undefined && !hasMore) {
      listing.totalItems = items.length
    }
    return reply.send(listing)
  }

  /**
   * POST /spaces/
   * Request handler for "Create Space" request
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
      Body: {
        id?: string
        name?: string
        type?: unknown
        controller: IDID
      }
    }>,
    reply: FastifyReply
  ): Promise<FastifyReply> {
    const { body } = request
    const { serverUrl, storage } = request.server

    // The Space Metadata body must carry a controller DID.
    assertBodyController({ body, requestName: 'Create Space' })
    // Reject a malformed / non-`did:key` controller before it is stored.
    assertValidController(body.controller, { requestName: 'Create Space' })
    // The OPTIONAL `type` array subtypes `Space` (e.g. an auxiliary Space).
    // Settable here only: it is immutable once the Space exists.
    const type =
      assertValidSpaceType(body.type, { requestName: 'Create Space' }) ??
      defaultSpaceType()
    // Only boot provisioning creates a `ServerInstanceSpace`.
    assertClientCreatableSpaceType(type, { requestName: 'Create Space' })
    // Reject a path-traversal / non-URL-safe client-supplied space id.
    if (body.id !== undefined) {
      assertValidId(body.id, { kind: 'space', requestName: 'Create Space' })
      assertCreatableSpaceId(body.id)
    }

    const spaceId = body.id || uuidv4()
    // Only the user-writable members are taken from the body, under the
    // validated `type`, not whatever shape the body carried under that name.
    const spaceMetadata = writableSpaceMetadata({ id: spaceId, type, body })

    // The invocation must be *authorized by* the body's controller (spec:
    // Create Space): signed directly by it, or via a delegation chain rooted
    // in it (see `verifyBodyControllerConsent`). Skipped when the provisioning
    // policy already vouched for the request (e.g. a valid onboarding token).
    const invocation = request.provisioningAuthorized
      ? undefined
      : await verifyBodyControllerConsent({
          request,
          controller: body.controller,
          allowedTarget: absoluteUrl({ path: spacesPath(), serverUrl }),
          allowedAction: 'POST',
          MismatchError: SpaceControllerMismatchError,
          requestName: 'Create Space'
        })

    // POST must never replace an existing Space: the write below is verified
    // against the *body's* controller, so without this check any caller could
    // overwrite a Space (controller included) by POSTing its id. Spec:
    // `id-conflict` (409); create-or-replace by id is PUT's job. This unlocked
    // read answers the common case; the guarded write below is what closes the
    // race between two creates. It runs only once the body controller has
    // consented, because a 409 here against an id that exists -- where a fresh
    // id would have failed the consent check -- would tell a caller with no
    // verifying signature which Spaces exist.
    if (
      body.id !== undefined &&
      (await storage.getSpaceMetadata({ spaceId: body.id }))
    ) {
      throw new IdConflictError({ kind: 'Space' })
    }

    // zCap checks out, continue.
    // The write is the guarded create (`If-None-Match: *` semantics),
    // evaluated atomically inside the backend: two concurrent creates of the
    // same id both pass the existence check above, and without the guard the
    // later full-replacement write would overwrite the winner's `controller`
    // and `type`. The loser's 412 is served as the spec's `id-conflict`
    // (409), since no client header was involved.
    let written: MetadataWriteResult<SpaceMetadata>
    try {
      written = await storage.writeSpace({
        spaceId,
        spaceMetadata,
        // The delegation chain the consent verified. A create the
        // provisioning policy granted records no `createdBy`, since no
        // signature was verified.
        createdBy: createdByOf({ request, invocation }),
        ifNoneMatch: '*'
      })
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        throw new IdConflictError({ kind: 'Space' })
      }
      throw err
    }
    // Bust any cached (e.g. negatively cached) description for this id so the
    // next read sees the freshly created Space.
    invalidateSpaceMetadata({ storage, spaceId })

    // `Location` names the Space that was created, in its canonical
    // trailing-slash (container) form (spec "Create Space").
    const createdSpaceUrl = absoluteSpaceUrl({ spaceId, serverUrl })
    reply.header('Location', createdSpaceUrl)
    // Surface the Metadata object's ETag so a client can chain a conditional
    // Update Space (read-modify-CAS on the Space Metadata object).
    reply.header('etag', formatEtag(written.validator))
    // The stored object as the write left it, through the projection Read
    // Space serves, so the create response and a subsequent read agree. An
    // id already in use was refused as a 409 by the guarded write, so it
    // created the Space. A Space that did not exist has no registered
    // backends, so the projection lists the server's own backends without a
    // read.
    return reply.status(201).send(
      await projectSpaceMetadata({
        serverBackends: request.server.serverBackends,
        spaceId,
        spaceMetadata: written.metadata,
        created: true
      })
    )
  }
}
