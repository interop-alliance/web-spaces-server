/**
 * The content digest a Resource or chunk record carries: the `Digest`
 * header's `mh=` multihash form (sha-256) over the stored representation,
 * the bytes a `GET` serves. A JSON body is digested as stored, after the
 * `JSON.stringify` re-serialization both backends write, and not as sent, so
 * the value equals the request's `Digest` header only for a binary body.
 * Both backends record it inside the write's critical section, with the
 * stamp, and the write-once rule compares it in place of the stored bytes.
 * The module also holds the composite digest of a chunked Resource, which
 * export and import provenance compute over the chunk digests in index
 * order. One `createHeaderValue` is the single encoder for every form.
 */
import { PassThrough, Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHeaderValue } from '@interop/http-digest-header'
import { createSignCryptosuite } from '@interop/ed25519-signature/eddsa-jcs-2022'

/**
 * The bytes both backends store for a JSON body, and the bytes the
 * write-once rule digests for one: the `JSON.stringify` serialization of the
 * parsed value. Every write and every comparison serializes through this one
 * function, so the digest a write records and the digest a repeat computes
 * cannot drift apart.
 * @param data {unknown}   the parsed JSON value
 * @returns {Buffer}
 */
export function storedJsonBytes(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data))
}

/**
 * The content digest of bytes held in memory.
 * @param bytes {Uint8Array}
 * @returns {Promise<string>}   the `mh=` form
 */
export async function contentDigestOf(bytes: Uint8Array): Promise<string> {
  return createHeaderValue({ data: bytes })
}

/**
 * A pass-through transform that digests the bytes flowing through it. The
 * filesystem backend puts it last before the file write in a streamed write's
 * pipeline, so the digest covers exactly the bytes the file receives, with
 * no second read of the body or the file. `digest` settles when the stream
 * ends, and rejects when the pipeline fails, so a refused write leaves no
 * pending hash.
 * @returns {{ tap: Transform, digest: Promise<string> }}
 */
export function digestTap(): { tap: Transform; digest: Promise<string> } {
  const hashed = new PassThrough()
  const digest = createHeaderValue({
    data: Readable.toWeb(hashed) as ReadableStream<Uint8Array>
  })
  // A pipeline that fails before its end rejects `digest` through the
  // destroyed branch; the caller surfaces the pipeline's own error.
  digest.catch(() => {})
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (hashed.write(chunk)) {
        callback(null, chunk)
      } else {
        hashed.once('drain', () => callback(null, chunk))
      }
    },
    flush(callback) {
      hashed.end()
      callback()
    },
    destroy(err, callback) {
      hashed.destroy(err ?? undefined)
      callback(err)
    }
  })
  return { tap, digest }
}

/**
 * The content digest of a byte stream, read through `guards` (the upload cap
 * for an incoming body), so a body a write would refuse is refused here too.
 * The stream is consumed.
 * @param options {object}
 * @param options.stream {Readable}
 * @param [options.guards] {Transform[]}   byte-limit transforms to read the
 *   stream through
 * @returns {Promise<string>}   the `mh=` form
 */
export async function streamDigestOf({
  stream,
  guards = []
}: {
  stream: Readable
  guards?: Transform[]
}): Promise<string> {
  const { tap, digest } = digestTap()
  await pipeline([
    stream,
    ...guards,
    tap,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
  ])
  return digest
}

/**
 * The composite digest of a chunked Resource: its chunk digests, in chunk
 * index order, serialized with JCS, and that serialization digested in the
 * same `mh=` form. The parent representation's own bytes are not covered.
 * Neither backend stores it; export provenance signs it and import
 * provenance recomputes it over the chunk files it restores.
 * @param digests {readonly string[]}   the chunk digests, by ascending index
 * @returns {Promise<string>}
 */
export async function compositeChunkDigest(
  digests: readonly string[]
): Promise<string> {
  const serialized = await createSignCryptosuite().canonize(digests)
  return createHeaderValue({ data: serialized })
}
