/**
 * The container copies a server backend other than the control plane holds.
 * Both server backends refuse a Resource write into a Collection, or a
 * Space, that has no Metadata object in their own store, and read the
 * Collection's `unique` index declarations under their lock. The control
 * plane owns every Space and Collection Metadata object; a Collection
 * selecting another server backend's id therefore gets a copy of
 * its Metadata object there, written through after the control-plane write,
 * and the Space Metadata object is copied on the first Collection the
 * backend serves in that Space and refreshed by every later Update Space.
 * The Collection's governing history log is copied the same way, after each
 * control-plane write of it, because the write-once recheck a Resource write
 * runs inside the data backend's lock reads the log from that backend's own
 * store; the copy is what closes the race with a guarded log create there.
 * The Collection's own policy and each Resource policy are copied too, with
 * every write and every delete, so the `changes` feed that backend serves
 * holds one position sequence for every record kind of the Collection.
 * Reads never consult a copy. A copy of a Metadata object or of the log takes
 * the data backend's own write stamp and generation; the `changes` feed
 * served from that backend carries the control plane's stamp and validator
 * instead on its `collection-metadata` and `log` documents, which
 * `restampFeedFromControlPlane` reads off the control plane once each per
 * page. A policy copy is written through `applyPolicy` under the control
 * plane's own generation and stamp, so its feed document is served as is.
 * Either way a feed document's `etag` is the one a GET of the record
 * answers.
 *
 * The copies follow the write itself: `mirroringControlPlane` wraps the
 * control plane so each write or delete of a container object or of a
 * Collection- or Resource-level policy, and each replicated apply of one, is
 * followed by the copy it calls for. The set exposes the wrapped backend as
 * `controlPlane`, which is what the handlers, the import path and the pull
 * loop write through, so no writer has to remember the copy.
 *
 * The two stores make a write-through non-atomic: a fault between the
 * control-plane write and the copy leaves the copy behind, and the next
 * write of the object, or a retried request, brings it level. A Resource
 * write that lands between a log's control-plane commit and its copy's
 * commit committed before the log write was answered, the same order the
 * single-backend gate produces. Delete Collection sweeps every other server
 * backend for a copy after the control plane's delete, on a retry too, so a
 * fault between the two leaves nothing behind for good.
 */
import { isWriteStamp } from '@interop/storage-core'

import { SpaceNotFoundError, StorageError } from '../errors.js'
import type { ApplyResult } from './replicaApply.js'
import { containerFeedDocument, type EtagValidator } from './etag.js'
import { stampOf, withoutStampMembers } from './hlc.js'
import { stripMetadataValidator } from './metadataValidator.js'
import type { ServerBackends } from './serverBackends.js'
import type {
  CollectionMetadata,
  FeedDocument,
  PolicyDocument,
  SpaceMetadata,
  StorageBackend,
  StoredCollectionMetadata
} from '../types.js'

/**
 * The copy of a Space Metadata object a server backend keeps: the stored
 * object's `controller` and user-writable members, and nothing the copy's own
 * write stamps.
 * @param stored {SpaceMetadata}
 * @returns {SpaceMetadata}
 */
function spaceCopyOf(stored: SpaceMetadata): SpaceMetadata {
  const { id, type, controller, name } = stored
  return {
    id,
    type,
    controller,
    ...(name !== undefined && { name })
  }
}

/**
 * Ensures `backend` holds a Space Metadata object for the Space, writing a
 * copy of the control plane's user-writable members when it does not. A
 * no-op for the control plane.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.backend {StorageBackend}   the server backend the copy is
 *   for
 * @param options.spaceId {string}
 * @returns {Promise<void>}
 * @throws {SpaceNotFoundError}   the control plane holds no such Space
 */
export async function ensureMirroredSpace({
  serverBackends,
  backend,
  spaceId
}: {
  serverBackends: ServerBackends
  backend: StorageBackend
  spaceId: string
}): Promise<void> {
  if (backend === serverBackends.controlPlane) {
    return
  }
  if (await backend.getSpaceMetadata({ spaceId })) {
    return
  }
  const stored = await serverBackends.controlPlane.getSpaceMetadata({
    spaceId
  })
  if (!stored) {
    throw new SpaceNotFoundError({ requestName: 'Write Collection' })
  }
  await backend.writeSpace({ spaceId, spaceMetadata: spaceCopyOf(stored) })
}

/**
 * Refreshes the copy of a Space Metadata object in every server backend that
 * holds one, after Update Space stored it on the control plane, so a
 * promoted `controller` or a new `name` reaches each copy. A backend holding
 * no copy is left alone: it gets one on the first Collection it serves.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.metadata {SpaceMetadata}   the stored object as the
 *   control-plane write left it
 * @returns {Promise<void>}
 */
export async function mirrorSpaceMetadata({
  serverBackends,
  spaceId,
  metadata
}: {
  serverBackends: ServerBackends
  spaceId: string
  metadata: SpaceMetadata
}): Promise<void> {
  for (const backend of serverBackends.others()) {
    if (await backend.getSpaceMetadata({ spaceId })) {
      await backend.writeSpace({
        spaceId,
        spaceMetadata: spaceCopyOf(metadata)
      })
    }
  }
}

/**
 * Writes through a Collection Metadata object the control plane just stored
 * to the server backend its `backend.id` selects, when that is another
 * server backend. The copy carries the stored members less the write stamp
 * and validator; the server-managed members are the copy's own.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.metadata {CollectionMetadata}   the stored object as the
 *   control-plane write left it
 * @returns {Promise<void>}
 */
export async function mirrorCollectionMetadata({
  serverBackends,
  spaceId,
  collectionId,
  metadata
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
  metadata: CollectionMetadata
}): Promise<void> {
  const backend = serverBackends.resolveOther(metadata.backend?.id)
  if (backend === undefined) {
    return
  }
  await ensureMirroredSpace({ serverBackends, backend, spaceId })
  const {
    createdAt: _createdAt,
    created: _created,
    createdBy,
    ...writable
  } = withoutStampMembers(stripMetadataValidator(metadata))
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: writable,
    createdBy
  })
}

/**
 * Writes through a Collection's governing history log the control plane just
 * stored to the server backend the Collection selects, when that is another
 * server backend. The whole log is written, unconditionally: the control
 * plane evaluated the request's precondition and the line contract. The
 * copy of the Collection Metadata object is written first when the backend
 * holds none, so a copy an earlier fault left out is brought level here.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.body {string}   the log as stored, JSON Lines
 * @returns {Promise<void>}
 */
export async function mirrorCollectionLog({
  serverBackends,
  spaceId,
  collectionId,
  body
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
  body: string
}): Promise<void> {
  const backend = await collectionCopyBackend({
    serverBackends,
    spaceId,
    collectionId
  })
  if (backend === undefined) {
    return
  }
  await backend.writeCollectionLog({ spaceId, collectionId, body })
}

/**
 * The server backend a Collection's copies go to: the one its `backend.id`
 * selects when that is another server backend, with the copy of the
 * Collection Metadata object brought level first
 * ({@link ensureCollectionCopy}). `undefined` when the Collection is absent
 * on the control plane or selects the control plane.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<StorageBackend | undefined>}
 */
export async function collectionCopyBackend({
  serverBackends,
  spaceId,
  collectionId
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
}): Promise<StorageBackend | undefined> {
  const metadata = await serverBackends.controlPlane.getCollectionMetadata({
    spaceId,
    collectionId
  })
  const backend = serverBackends.resolveOther(metadata?.backend?.id)
  if (metadata === undefined || backend === undefined) {
    return undefined
  }
  await ensureCollectionCopy({
    serverBackends,
    backend,
    spaceId,
    collectionId,
    metadata
  })
  return backend
}

/**
 * Writes `backend`'s copy of a Collection Metadata object when it holds
 * none, so a copy an earlier fault left out is brought level. The pull loop
 * calls it before it applies a Collection's Resources to that backend, which
 * skips a Resource of a Collection it holds no copy of.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.backend {StorageBackend}   the server backend the
 *   Collection selects, other than the control plane
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.metadata {CollectionMetadata}   the object as the control
 *   plane holds it
 * @returns {Promise<void>}
 */
export async function ensureCollectionCopy({
  serverBackends,
  backend,
  spaceId,
  collectionId,
  metadata
}: {
  serverBackends: ServerBackends
  backend: StorageBackend
  spaceId: string
  collectionId: string
  metadata: CollectionMetadata
}): Promise<void> {
  if (await backend.getCollectionMetadata({ spaceId, collectionId })) {
    return
  }
  await mirrorCollectionMetadata({
    serverBackends,
    spaceId,
    collectionId,
    metadata
  })
}

/**
 * Writes through a Collection- or Resource-level policy record the control
 * plane holds, live or a tombstone, to the server backend the Collection
 * selects, when that is another server backend, so the write takes a
 * position in that backend's `changes` feed. The copy goes through
 * `applyPolicy` under the control plane's own generation and stamp, so the
 * copy's validator is the record's and the feed serves it as is. The stamp
 * comparison there orders two copies of one record however they land, and
 * a tombstone is written over no record too, so a copy a fault left out is
 * brought level by the next write of the record.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.resourceId] {string}
 * @param options.validator {EtagValidator}   the record's generation and
 *   stamp, as the control-plane write minted them
 * @param [options.policy] {PolicyDocument}   the policy as the control-plane
 *   write stored it; absent for a tombstone
 * @returns {Promise<void>}
 * @throws {StorageError}   the backend refused the copy
 */
export async function mirrorPolicy({
  serverBackends,
  spaceId,
  collectionId,
  resourceId,
  validator,
  policy
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
  resourceId?: string
  validator: EtagValidator
  policy?: PolicyDocument
}): Promise<void> {
  const backend = await collectionCopyBackend({
    serverBackends,
    spaceId,
    collectionId
  })
  if (backend === undefined) {
    return
  }
  await copyPolicy({
    backend,
    spaceId,
    collectionId,
    resourceId,
    validator,
    policy
  })
}

/**
 * Writes one policy record, live or a tombstone, to the backend its
 * Collection's copies go to, through `applyPolicy` under the record's own
 * generation and stamp.
 * @param options {object}
 * @param options.backend {StorageBackend}   the backend the copy goes to
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.resourceId] {string}
 * @param options.validator {EtagValidator}
 * @param [options.policy] {PolicyDocument}   absent for a tombstone
 * @returns {Promise<void>}
 * @throws {StorageError}   the backend refused the copy
 */
async function copyPolicy({
  backend,
  spaceId,
  collectionId,
  resourceId,
  validator,
  policy
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
  resourceId?: string
  validator: EtagValidator
  policy?: PolicyDocument
}): Promise<void> {
  const result = await backend.applyPolicy({
    spaceId,
    collectionId,
    resourceId,
    generation: validator.generation,
    stamp: validator.stamp,
    policy: policy && (withoutStampMembers(policy) as PolicyDocument)
  })
  if (result.outcome === 'refused') {
    throw new StorageError({
      cause: new Error(
        `The copy of a policy was refused (${result.reason}): ${result.detail}`
      )
    })
  }
}

/**
 * Writes through the policy records the control plane holds for a
 * Collection, its own and one per named Resource, to the server backend the
 * Collection selects. Import Space calls it after the control plane's
 * import, since that import stores its policies inside the backend, past
 * the write-through. A level the control plane holds no record at is left
 * alone.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceIds {Iterable<string>}   the Resources whose policy
 *   records to copy
 * @returns {Promise<void>}
 */
export async function mirrorCollectionPolicies({
  serverBackends,
  spaceId,
  collectionId,
  resourceIds
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
  resourceIds: Iterable<string>
}): Promise<void> {
  const backend = await collectionCopyBackend({
    serverBackends,
    spaceId,
    collectionId
  })
  if (backend === undefined) {
    return
  }
  for (const resourceId of [undefined, ...resourceIds]) {
    const stored = await serverBackends.controlPlane.getPolicyRecord({
      spaceId,
      collectionId,
      resourceId
    })
    if (stored?.validator === undefined) {
      continue
    }
    await copyPolicy({
      backend,
      spaceId,
      collectionId,
      resourceId,
      validator: stored.validator,
      policy: stored.deleted ? undefined : stored.policy
    })
  }
}

/**
 * The `changes` feed page of a Collection on a server backend other than
 * the control plane,
 * with its `collection-metadata` and `log` documents carrying the control
 * plane's stamp and validator in place of the copy's, read off the control
 * plane in one read per page. The feed position stays the data backend's,
 * since the copies take their positions in its one sequence. A `resource`
 * document is that backend's own, and a `policy` document already carries
 * the control plane's validator, which its copy was written under. A record
 * the control plane does not hold (a copy a fault left behind) keeps the
 * copy's stamp.
 * @param options {object}
 * @param options.controlPlane {StorageBackend}   the control plane
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.documents {FeedDocument[]}   the page as the data backend
 *   served it
 * @returns {Promise<FeedDocument[]>}
 */
export async function restampFeedFromControlPlane({
  controlPlane,
  spaceId,
  collectionId,
  documents
}: {
  controlPlane: StorageBackend
  spaceId: string
  collectionId: string
  documents: FeedDocument[]
}): Promise<FeedDocument[]> {
  const kinds = new Set(documents.map(doc => doc.kind))
  // A page with a `log` document takes the log's validator and the Metadata
  // object in one read, with no log body. A page with neither kind reads
  // nothing.
  let metadata: StoredCollectionMetadata | undefined
  let logValidator: EtagValidator | undefined
  if (kinds.has('log')) {
    const stored = await controlPlane.getCollectionMetadataAndLogValidator({
      spaceId,
      collectionId
    })
    metadata = stored?.collectionMetadata
    logValidator = stored?.logValidator
  } else if (kinds.has('collection-metadata')) {
    metadata = await controlPlane.getCollectionMetadata({
      spaceId,
      collectionId
    })
  }
  const metadataStamp = stampOf(metadata)
  return documents.map(doc => {
    if (
      doc.kind === 'collection-metadata' &&
      metadata !== undefined &&
      isWriteStamp(metadataStamp)
    ) {
      return containerFeedDocument({
        kind: doc.kind,
        feedPosition: doc.feedPosition,
        stamp: metadataStamp,
        generation: metadata.metaGeneration,
        local: metadata.metaLocal ?? 0
      })
    }
    if (doc.kind === 'log' && logValidator !== undefined) {
      return containerFeedDocument({
        kind: doc.kind,
        feedPosition: doc.feedPosition,
        stamp: logValidator.stamp,
        generation: logValidator.generation
      })
    }
    return doc
  })
}

/**
 * Removes the copy of a deleted Collection from every server backend other
 * than the default that holds one, so the Resources it holds go with the
 * Collection. Run after the control plane's delete whatever its outcome, so
 * a retry after a fault between the two removes the copy the first attempt
 * left behind. A backend holding no copy of the Space or the Collection is
 * left alone.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {Promise<void>}
 */
export async function mirrorCollectionDelete({
  serverBackends,
  spaceId,
  collectionId
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionId: string
}): Promise<void> {
  for (const backend of serverBackends.others()) {
    if (!(await backend.getSpaceMetadata({ spaceId }))) {
      continue
    }
    if (await backend.getCollectionMetadata({ spaceId, collectionId })) {
      await backend.deleteCollection({ spaceId, collectionId })
    }
  }
}

/**
 * The control plane as the server writes through it: every write or delete
 * of a Space or Collection Metadata object or of a governing log, and every
 * replicated apply of one, is followed by the copy the other server
 * backends keep. Every other member is the wrapped backend's own, so the
 * result reads, stamps and closes as that backend does.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}   the set the backend is
 *   the control plane of
 * @param options.backend {StorageBackend}   the control plane as opened
 * @returns {StorageBackend}
 */
export function mirroringControlPlane({
  serverBackends,
  backend
}: {
  serverBackends: ServerBackends
  backend: StorageBackend
}): StorageBackend {
  const mirrored: Pick<
    StorageBackend,
    | 'writeSpace'
    | 'writeCollection'
    | 'writeCollectionLog'
    | 'deleteCollection'
    | 'deleteSpace'
    | 'writePolicy'
    | 'deletePolicy'
    | 'applySpaceName'
    | 'applyCollection'
    | 'applyCollectionLog'
    | 'applyPolicy'
  > = {
    async writeSpace(options) {
      const result = await backend.writeSpace(options)
      // A created Space has no copy yet; one follows the first Collection a
      // backend serves in it.
      if (!result.created) {
        await mirrorSpaceMetadata({
          serverBackends,
          spaceId: options.spaceId,
          metadata: result.metadata
        })
      }
      return result
    },
    async writeCollection(options) {
      const result = await backend.writeCollection(options)
      await mirrorCollectionMetadata({
        serverBackends,
        spaceId: options.spaceId,
        collectionId: options.collectionId,
        metadata: result.metadata
      })
      return result
    },
    async writeCollectionLog(options) {
      const validator = await backend.writeCollectionLog(options)
      if (validator !== undefined) {
        await mirrorCollectionLog({
          serverBackends,
          spaceId: options.spaceId,
          collectionId: options.collectionId,
          body: options.body
        })
      }
      return validator
    },
    async deleteCollection(options) {
      const outcome = await backend.deleteCollection(options)
      // The sweep runs on a repeat delete too, so a copy a faulted first
      // attempt left behind goes on the retry.
      if (outcome !== 'absent') {
        await mirrorCollectionDelete({ serverBackends, ...options })
      }
      return outcome
    },
    async deleteSpace(options) {
      await backend.deleteSpace(options)
      await mirrorSpaceDelete({ serverBackends, spaceId: options.spaceId })
    },
    async writePolicy(options) {
      const result = await backend.writePolicy(options)
      // A Space policy is in no Collection, so it has no copy.
      if (options.collectionId !== undefined) {
        await mirrorPolicy({
          serverBackends,
          spaceId: options.spaceId,
          collectionId: options.collectionId,
          resourceId: options.resourceId,
          validator: result.validator,
          policy: result.policy
        })
      }
      return result
    },
    async deletePolicy(options) {
      const validator = await backend.deletePolicy(options)
      if (validator !== undefined && options.collectionId !== undefined) {
        await mirrorPolicy({
          serverBackends,
          spaceId: options.spaceId,
          collectionId: options.collectionId,
          resourceId: options.resourceId,
          validator
        })
      }
      return validator
    },
    async applySpaceName(options) {
      const result = await backend.applySpaceName(options)
      if (result.outcome === 'applied') {
        const stored = await backend.getSpaceMetadata({
          spaceId: options.spaceId
        })
        if (stored) {
          await mirrorSpaceMetadata({
            serverBackends,
            spaceId: options.spaceId,
            metadata: stored
          })
        }
      }
      return result
    },
    async applyCollection(options): Promise<ApplyResult> {
      const result = await backend.applyCollection(options)
      if (result.outcome !== 'applied') {
        return result
      }
      const { spaceId, collectionId } = options
      if (options.collection.deleted) {
        await mirrorCollectionDelete({ serverBackends, spaceId, collectionId })
        return result
      }
      // The copy is of the object as stored, merged over the held one.
      const stored = await backend.getCollectionMetadata({
        spaceId,
        collectionId
      })
      if (stored) {
        await mirrorCollectionMetadata({
          serverBackends,
          spaceId,
          collectionId,
          metadata: stored
        })
      }
      return result
    },
    async applyCollectionLog(options) {
      const result = await backend.applyCollectionLog(options)
      if (result.outcome === 'applied') {
        await mirrorCollectionLog({
          serverBackends,
          spaceId: options.spaceId,
          collectionId: options.collectionId,
          body: options.body
        })
      }
      return result
    },
    async applyPolicy(options) {
      const result = await backend.applyPolicy(options)
      if (result.outcome === 'applied' && options.collectionId !== undefined) {
        const { spaceId, collectionId, resourceId, generation, stamp } = options
        await mirrorPolicy({
          serverBackends,
          spaceId,
          collectionId,
          resourceId,
          validator: { generation, stamp },
          policy: options.policy
        })
      }
      return result
    }
  }
  // Every other member is read off the backend itself, and a method is bound
  // to it so its private fields resolve; a property set lands on it too.
  return new Proxy(backend, {
    get(target, property) {
      if (Object.hasOwn(mirrored, property)) {
        return mirrored[property as keyof typeof mirrored]
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    }
  })
}

/**
 * Removes a deleted Space's copy from every server backend other than the
 * default, with the Collections and Resources each holds for it. A backend
 * holding no copy is left alone.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @returns {Promise<void>}
 */
export async function mirrorSpaceDelete({
  serverBackends,
  spaceId
}: {
  serverBackends: ServerBackends
  spaceId: string
}): Promise<void> {
  for (const backend of serverBackends.others()) {
    if (await backend.getSpaceMetadata({ spaceId })) {
      await backend.deleteSpace({ spaceId })
    }
  }
}
