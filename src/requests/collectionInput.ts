/**
 * Shared composition of a Collection Metadata object from a request body, for
 * the two writes that carry one: Create Collection (`POST /space/:spaceId/`)
 * and Update (or Create by Id) Collection (`PUT /space/:spaceId/:collectionId/meta`).
 * Both take the merged object -- the configuration members beside the
 * annotation members `custom` and `epoch` -- and both are a full replacement
 * (spec "Update (or Create by Id) Collection"): a writable member the request
 * omits is cleared, except where the spec says otherwise (see
 * `composeCollectionMetadata`).
 *
 * The work is split in two on the same boundary every handler keeps: the
 * shape check runs before authorization (a malformed body is a 400 whoever
 * sends it; `parseCollectionMetadataBody` in `lib/collectionMetadataBody.ts`,
 * which Import Space shares), while the checks that read Space or Collection
 * state -- the backend allowlist, the encryption and revisions transitions,
 * the `custom` envelope -- run after it, so their 409/422 are observable only
 * to an authorized caller.
 */
import type { FastifyRequest } from 'fastify'
import type { ParsedCollectionMetadataBody } from '../lib/collectionMetadataBody.js'
import { assertSupportedBackend } from '../lib/backends.js'
import { assertEncryptionDescriptorTransition } from '../lib/encryption.js'
import {
  assertPlaintextNotEncrypted,
  declaredUniqueIndexesOf
} from '../lib/equalityIndex.js'
import {
  assertGovernedMergeUnchanged,
  assertRevisionsTransition
} from '../lib/revisions.js'
import type { GovernedDescriptors } from '../lib/governedLog.js'
import type { ServerBackends } from '../lib/serverBackends.js'
import { resolveMetadataCustom } from '../lib/customMetadata.js'
import {
  BackendImmutableError,
  EncryptionHistoryLogGovernedError,
  UnsupportedBackendError
} from '../errors.js'
import type { CollectionMetadata } from '../types.js'

/**
 * The descriptor checks a Collection Metadata write runs against the
 * Collection's current state: a direct `encryption` write on a log-governed
 * Collection is refused (`encryption-history-log-governed`, 409), the
 * `encryption` descriptor is declared at creation and immutable afterward
 * (`encryption-immutable`, 409), the `revisions` descriptor's `resolution` and
 * `immutable` are set at creation and immutable afterward
 * (`revisions-immutable`, 409), and the effective object may not carry both
 * `plaintext` and `encryption` (400). On a log-governed Collection a
 * `revisions` the body carries is checked against the derived descriptor, and
 * an omitted one is not a change, since the log holds it. Update Collection
 * runs it inside the backend's write, against the prior the backend reads
 * under its lock. A create (no `existing`, which includes a create over a
 * Collection tombstone) declares freely.
 * @param options {object}
 * @param options.parsed {ParsedCollectionMetadataBody}   the shape-checked body
 * @param [options.existing] {CollectionMetadata}   the stored object, on an
 *   update (absent on a create)
 * @param [options.governed] {GovernedDescriptors}   the descriptors derived
 *   from the Collection's history log, when it has one
 * @param options.requestName {string}   request name for error titles
 */
function assertCollectionMetadataTransition({
  parsed,
  existing,
  governed,
  requestName
}: {
  parsed: ParsedCollectionMetadataBody
  existing?: CollectionMetadata
  governed?: GovernedDescriptors
  requestName: string
}): void {
  if (governed !== undefined && parsed.encryption !== undefined) {
    throw new EncryptionHistoryLogGovernedError()
  }
  assertEncryptionDescriptorTransition({
    stored: existing,
    incoming: parsed.encryption
  })
  if (governed !== undefined) {
    if (parsed.revisions !== undefined) {
      assertRevisionsTransition({
        existing: governed.revisions,
        incoming: parsed.revisions
      })
      assertGovernedMergeUnchanged({
        governed: governed.revisions,
        incoming: parsed.revisions
      })
    }
  } else if (existing !== undefined) {
    assertRevisionsTransition({
      existing: existing.revisions,
      incoming: parsed.revisions
    })
  }
  assertPlaintextNotEncrypted({
    plaintext: parsed.plaintext ?? existing?.plaintext,
    encryption:
      parsed.encryption ?? existing?.encryption ?? governed?.encryption,
    requestName
  })
}

/**
 * Whether two `backend.id` values select one backend: the same server backend
 * under either of its ids (`default`, or its fixed id), or the same external
 * id. An absent id is the default.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param [options.stored] {string}   the stored Collection's selection
 * @param options.incoming {string}   the selection the write composed
 * @returns {boolean}
 */
function selectsSameBackend({
  serverBackends,
  stored,
  incoming
}: {
  serverBackends: ServerBackends
  stored?: string
  incoming: string
}): boolean {
  const storedBackend = serverBackends.resolve(stored)
  const incomingBackend = serverBackends.resolve(incoming)
  if (storedBackend !== undefined || incomingBackend !== undefined) {
    return storedBackend === incomingBackend
  }
  return stored === incoming
}

/**
 * Composes the Collection Metadata object a write persists, from the parsed
 * body and the Collection's current state. Runs after authorization. The
 * rules, in order:
 *
 * - `id` is the URL's (or the body's, on Create Collection); `type` is
 *   `['Collection']`.
 * - `backend` is validated against the Space's backends-available (bad shape
 *   400, unknown id 409). A create with none gets the server default; an
 *   update with none keeps the stored selection (spec "Update (or Create by
 *   Id) Collection").
 * - `encryption`: a direct write on a log-governed Collection is refused
 *   (`encryption-history-log-governed`, 409). Otherwise the descriptor is
 *   declared by the create and immutable afterward: an update that adds one
 *   to a Collection without one is refused (`encryption-immutable`, 409). An
 *   omitted member on an encrypted Collection is an attempt to clear it,
 *   refused the same way, as is any narrowing change.
 * - `revisions`: `resolution` and `immutable` are declared by the create and
 *   immutable afterward, so an update that adds, drops, or changes one is
 *   refused (`revisions-immutable`, 409); `merge` follows the body. On a
 *   log-governed Collection the log holds the descriptor: a body `revisions`
 *   is checked against the derived one and not stored, a `merge` that differs
 *   from the derived one is refused (`revisions-immutable`, 409), and the
 *   stored descriptor is carried forward untouched.
 * - `plaintext` and `generator` are the spec's carve-outs from clearing: an
 *   omitted member leaves the stored one untouched, and a supplied one
 *   replaces it whole. The result may not carry both `plaintext` and
 *   `encryption` (400). A `unique: true` index declaration is refused on a
 *   Collection stored on a registered external backend
 *   (`unsupported-backend`, 409): the server enforces the claim inside its own
 *   backends' Resource writes, which read the declaration under their lock,
 *   and an external adapter holds no copy of the declaration.
 * - `name` and `epoch` are taken from the body alone: omitted means cleared. A create with no `name` gets the Collection
 *   id as its name.
 * - `custom`, when present, is the plaintext `{ name, tags }` object or, on an
 *   encrypted Collection, a conforming envelope (422 otherwise). An omitted
 *   `custom` is the cleared state on either kind of Collection and is never
 *   judged as an envelope, so a Collection born with no annotations stays
 *   writable without minting one.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}   supplies `request.server`
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.parsed {ParsedCollectionMetadataBody}   the shape-checked body
 * @param [options.existing] {CollectionMetadata}   the stored object, on an
 *   update (absent on a create)
 * @param [options.governed] {GovernedDescriptors}   the descriptors derived
 *   from the Collection's history log, when it has one
 * @param options.requestName {string}   request name for error titles
 * @returns {Promise<CollectionMetadata>}   the object to hand to
 *   `writeCollection` (validator-free; `createdBy` and the timestamps are the
 *   backend's to stamp)
 */
export async function composeCollectionMetadata({
  request,
  spaceId,
  collectionId,
  parsed,
  existing,
  governed,
  requestName
}: {
  request: FastifyRequest
  spaceId: string
  collectionId: string
  parsed: ParsedCollectionMetadataBody
  existing?: CollectionMetadata
  governed?: GovernedDescriptors
  requestName: string
}): Promise<CollectionMetadata> {
  const { serverBackends } = request.server
  // An omitted `backend` keeps the stored selection on an update; only a
  // create with none gets the server default (spec "Update (or Create by Id)
  // Collection"). The carried-forward value is not re-validated against the
  // Space's backends-available: it was accepted when it was selected, and a
  // backend deregistered since must not make an unrelated rename fail.
  const backend =
    parsed.body.backend === undefined && existing?.backend !== undefined
      ? existing.backend
      : await assertSupportedBackend({
          serverBackends,
          spaceId,
          backend: parsed.body.backend,
          requestName
        })
  // The selection is set at creation and cannot move: the Collection's
  // Resources live on the selected backend, so a body naming another one
  // would leave them there while reads went elsewhere. A body may restate the
  // selection under another id of the same backend (`default` for the
  // backend it aliases), which is stored as sent.
  if (
    existing !== undefined &&
    !selectsSameBackend({
      serverBackends,
      stored: existing.backend?.id,
      incoming: backend.id
    })
  ) {
    throw new BackendImmutableError({ backendId: backend.id })
  }
  // Update Collection composes inside the backend's write, so this runs
  // against the record the write replaces.
  assertCollectionMetadataTransition({
    parsed,
    existing,
    governed,
    requestName
  })
  const plaintext = parsed.plaintext ?? existing?.plaintext
  // A `unique` claim is enforced inside the Resource write of the server's
  // own backends, which read the declaration under their lock (a server
  // backend other than the control plane holds a copy of the Collection
  // Metadata object for that). A registered external backend's adapter never receives
  // the Collection Metadata object, so it cannot enforce the claim; the
  // declaration is refused rather than stored unenforced. Checked on the
  // composed pair, so selecting an external backend on a Collection that
  // already declares one is refused too.
  if (
    !serverBackends.has(backend.id) &&
    declaredUniqueIndexesOf({ collectionMetadata: { plaintext } }).length > 0
  ) {
    throw new UnsupportedBackendError({
      backendId: backend.id,
      detail: `Backend '${backend.id}' is a registered external backend, which does not enforce a 'unique' plaintext index declaration.`,
      pointer: '#/plaintext/indexes'
    })
  }
  const generator = parsed.generator ?? existing?.generator
  const encryption = parsed.encryption ?? governed?.encryption
  // A governed Collection's descriptor lives in its log, so a body
  // `revisions` that passed the check above is not stored. The stored one is
  // carried forward as it is: the served descriptor is the log's either way.
  const revisions =
    governed === undefined ? parsed.revisions : existing?.revisions

  // An omitted `custom` is the cleared state, on an encrypted Collection as
  // much as on a plaintext one (spec "Lifecycle": clearing the annotations is
  // a `PUT` carrying an empty `custom` object "or none at all"). It is never
  // run through the envelope validator, which judges a *present* value and
  // rejects `undefined` -- absence is not a malformed envelope, it is the
  // absence of annotations. Checking presence alone, rather than presence on
  // a create, is what lets an encrypted Collection born with no annotations
  // be updated afterward: every write would otherwise have to mint an
  // envelope, which a caller holding no keys (an `epoch` rotation, a rename)
  // cannot do.
  const custom =
    parsed.body.custom === undefined
      ? undefined
      : resolveMetadataCustom({
          collectionMetadata: { encryption },
          body: parsed.body,
          requestName
        })

  // A create with no `name` gets the id; an update with none clears it.
  const name =
    parsed.name ?? (existing === undefined ? collectionId : undefined)
  return {
    id: collectionId,
    type: ['Collection'],
    ...(name !== undefined && { name }),
    backend,
    ...(parsed.encryption !== undefined && { encryption: parsed.encryption }),
    ...(plaintext !== undefined && { plaintext }),
    ...(generator !== undefined && { generator }),
    ...(revisions !== undefined && { revisions }),
    ...(parsed.epoch !== undefined && { epoch: parsed.epoch }),
    ...(custom !== undefined && {
      custom: custom as CollectionMetadata['custom']
    })
  }
}
