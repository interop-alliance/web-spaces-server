/**
 * The provenance statement contract: what a statement attests and how its
 * members are computed from an archived object. Export provenance signs
 * statements built from these pieces, and import provenance judges statements
 * against them. The contract belongs to neither side, so it lives here. Both
 * sides read the server-managed members off an archived JSON dot-file the
 * same way, digest a file's bytes in the `Digest` header's `mh=` form, and
 * digest a chunked Resource as the JCS serialization of its chunk digests in
 * chunk index order (the forms `lib/contentDigest.ts` defines).
 */
import {
  classifyCollectionFile,
  parseChunkIndexSegment
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'
import { isMetaStamp } from '@interop/storage-core'
import type { ResourceMetaStamp } from '../types.js'
import { isEnoent } from './atomicFile.js'
import { compositeChunkDigest, contentDigestOf } from './contentDigest.js'
import { isPlainObject } from './isPlainObject.js'

/**
 * The statement `type` every provenance statement carries.
 */
export const STORAGE_ATTESTATION_TYPE = 'StorageAttestation'

/**
 * The members a statement attests, as read off the archived object and keyed
 * by the statement's own member names: the creator and creation time, the
 * write stamp of the object's last write (`updatedAt`, `updatedAtCounter`,
 * `originId`), and, on a Resource whose `/meta` record exists, that record's
 * own stamp and generation (`meta`).
 */
export type Claims = {
  createdBy?: string
  createdAt?: string
  updatedAt?: string
  updatedAtCounter?: number
  originId?: string
  meta?: ResourceMetaStamp
}

/**
 * Every member of `Claims`, in the order a mismatch is reported.
 */
export const CLAIM_MEMBERS = [
  'createdBy',
  'createdAt',
  'updatedAt',
  'updatedAtCounter',
  'originId',
  'meta'
] as const satisfies readonly (keyof Claims)[]

/**
 * Whether a statement's member equals the claim read off the archived object.
 * Every claim is a string or an integer, compared exactly, except `meta`,
 * compared member by member over its four members. An absent claim matches an
 * absent member only.
 * @param options {object}
 * @param options.member {keyof Claims}
 * @param options.stated {unknown}   the statement's value
 * @param options.claimed {unknown}   the archived object's value
 * @returns {boolean}
 */
export function claimMatches({
  member,
  stated,
  claimed
}: {
  member: keyof Claims
  stated: unknown
  claimed: unknown
}): boolean {
  if (member !== 'meta' || stated === undefined || claimed === undefined) {
    return stated === claimed
  }
  if (!isMetaStamp(stated) || !isMetaStamp(claimed)) {
    return false
  }
  return (
    stated.updatedAt === claimed.updatedAt &&
    stated.updatedAtCounter === claimed.updatedAtCounter &&
    stated.originId === claimed.originId &&
    stated.generation === claimed.generation
  )
}

/**
 * The server-managed members a statement attests, read off one archived JSON
 * dot-file's bytes: a Space or Collection Metadata file, whose stamp members
 * are stored bare, or a Resource metadata sidecar. A body that is not a JSON
 * object yields no members, and a member of the wrong type is left out; a
 * `meta` that is not a whole stamp object is left out too. Export signs these
 * members, and import reads them back to check them against a statement.
 * @param options {object}
 * @param options.bytes {Uint8Array}
 * @returns {Claims}
 */
export function serverFieldsOf({ bytes }: { bytes: Uint8Array }): Claims {
  let body: unknown
  try {
    body = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return {}
  }
  if (!isPlainObject(body)) {
    return {}
  }
  const { meta } = body
  return {
    ...(typeof body.createdBy === 'string' && {
      createdBy: body.createdBy
    }),
    ...(typeof body.createdAt === 'string' && {
      createdAt: body.createdAt
    }),
    ...(typeof body.updatedAt === 'string' && {
      updatedAt: body.updatedAt
    }),
    ...(Number.isSafeInteger(body.updatedAtCounter) && {
      updatedAtCounter: body.updatedAtCounter as number
    }),
    ...(typeof body.originId === 'string' && {
      originId: body.originId
    }),
    ...(isMetaStamp(meta) && {
      meta: {
        updatedAt: meta.updatedAt,
        updatedAtCounter: meta.updatedAtCounter,
        originId: meta.originId,
        generation: meta.generation
      }
    })
  }
}

/**
 * An archive file's bytes, whether carried inline or read at call time.
 * Returns `undefined` when a file read at call time is gone (`ENOENT`): the
 * object was deleted after the backend built the entry tree.
 * @param file {ArchiveFile}
 * @returns {Promise<Uint8Array | undefined>}
 */
export async function fileBytes(
  file: ArchiveFile
): Promise<Uint8Array | undefined> {
  if ('bytes' in file) {
    return file.bytes
  }
  try {
    return await file.read()
  } catch (err) {
    if (isEnoent(err)) {
      return undefined
    }
    throw err
  }
}

/**
 * The `Digest` header's multihash form over one archive file's bytes, or
 * `undefined` when the file is gone.
 * @param file {ArchiveFile}
 * @returns {Promise<string | undefined>}
 */
export async function fileDigest(
  file: ArchiveFile
): Promise<string | undefined> {
  const bytes = await fileBytes(file)
  return bytes === undefined ? undefined : contentDigestOf(bytes)
}

/**
 * The composite digest of a chunked Resource (`compositeChunkDigest`) over
 * the chunk representations of an archived chunk directory, in chunk index
 * order. The directory's metadata sidecars are not content and are skipped.
 * Returns `undefined` when any chunk is gone. Export signs it, and import
 * recomputes it over the chunk files it restores.
 * @param chunkFiles {ArchiveEntry[]}   the chunk directory's entries
 * @returns {Promise<string | undefined>}
 */
export async function chunkedDigest(
  chunkFiles: ArchiveEntry[]
): Promise<string | undefined> {
  const chunks: { index: number; file: ArchiveFile }[] = []
  for (const entry of chunkFiles) {
    if ('files' in entry) {
      continue
    }
    const kind = classifyCollectionFile(entry.name)
    if (kind.kind !== 'representation') {
      continue
    }
    const index = parseChunkIndexSegment(kind.resourceId)
    if (index !== undefined) {
      chunks.push({ index, file: entry })
    }
  }
  chunks.sort((left, right) => left.index - right.index)
  const digests: string[] = []
  for (const { file } of chunks) {
    const digest = await fileDigest(file)
    if (digest === undefined) {
      return undefined
    }
    digests.push(digest)
  }
  return compositeChunkDigest(digests)
}
