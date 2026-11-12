/**
 * Request Body Integrity (spec "Request Body Integrity (Digest Header)"): binds
 * a request body to its HTTP Signature via the `Digest` header. Two hooks,
 * installed by every route group alongside the auth hooks:
 *
 * - `captureRawBody` (preParsing) reads a JSON/text body in full, bounded by
 *   the route's `bodyLimit`, and keeps the exact bytes on `request.rawBody`
 *   while handing the same bytes to Fastify's parser, so the digest can be
 *   recomputed against what the client actually signed. Re-serializing the parsed body is
 *   not guaranteed byte-identical, so we keep the raw bytes instead. Streamed
 *   bodies (tar imports, raw blobs) are not buffered; instead they pass through
 *   a hashing transform that verifies the `Digest` incrementally at
 *   end-of-stream, so large/binary uploads keep streaming yet are still bound
 *   to the signature. A multipart body is hashed by a tap on the raw request
 *   as `@fastify/multipart` reads it, and its verdict is awaited before the
 *   write.
 * - `verifyBodyDigest` (preValidation) runs on any request carrying a body
 *   (`requestHasBody`), whatever its `Content-Type`. It refuses a body with no
 *   `Content-Type` as `missing-content-type` (400). For a signed request it
 *   then enforces that the signature covers the `digest` header (MUST), that a
 *   `Digest` header is present, and -- when the raw body was captured --
 *   independently recomputes the body digest and compares it (SHOULD). A
 *   missing, malformed, uncovered, or non-matching digest is rejected with
 *   `invalid-authorization-header` (400).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyDigest, verifyHeaderValue } from '@interop/http-digest-header'
import { PassThrough, Transform, type Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { isJsonContentType } from '@interop/storage-core'
import { InvalidDigestError, MissingContentTypeError } from './errors.js'
import { readBoundedBody } from './lib/bodyLimit.js'
import { isMultipartFormData } from './lib/mediaType.js'

/**
 * True for the body shapes `verifyBodyDigest` recomputes: JSON
 * (`application/json` / `+json`) and text. These reach handlers fully parsed
 * (object / string), so buffering their bytes is cheap; streamed bodies
 * (multipart, `application/x-tar`) are deliberately excluded.
 * @param contentType {string | undefined}
 * @returns {boolean}
 */
function isBufferableBody(contentType: string | undefined): boolean {
  return (
    isJsonContentType(contentType) ||
    (typeof contentType === 'string' && contentType.startsWith('text/'))
  )
}

/**
 * A pass-through Transform that hashes the streamed bytes (SHA-256) and, at
 * end-of-stream, verifies the accumulated digest against the request's `Digest`
 * header -- erroring the stream (which fails the write) on a mismatch. This
 * binds a streamed/binary body to its signed `Digest` without buffering it. A
 * mismatch surfaces mid-write; consumers that persist the stream remove any
 * partial output on the resulting error (see the filesystem backend's blob
 * write).
 */
class DigestVerifyStream extends Transform {
  readonly #hash = createHash('sha256')
  readonly #digestHeader: string
  constructor(digestHeader: string) {
    super()
    this.#digestHeader = digestHeader
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.#hash.update(chunk)
    callback(null, chunk)
  }
  override _flush(callback: (error?: Error | null) => void): void {
    callback(
      digestMismatch({
        digest: this.#hash.digest(),
        header: this.#digestHeader
      })
    )
  }
}

/**
 * Compares a body's SHA-256 digest with the request's `Digest` header. A
 * malformed/unsupported header also reports unverified; it surfaces as the
 * same mismatch error either way (matching this hook's historical behavior
 * for streamed bodies).
 * @param options {object}
 * @param options.digest {Buffer}   the body's SHA-256 digest
 * @param options.header {string}   the request's `Digest` header value
 * @returns {InvalidDigestError | null}   the error to fail the request with,
 *   or `null` when the digest matches
 */
function digestMismatch({
  digest,
  header
}: {
  digest: Buffer
  header: string
}): InvalidDigestError | null {
  const { verified } = verifyDigest({ digest, headerValue: header })
  return verified
    ? null
    : new InvalidDigestError({
        detail: 'The `Digest` header does not match the request body.'
      })
}

/**
 * Verifies the `Digest` of a stream another reader consumes: hashes every
 * chunk through a `data` listener and settles the returned promise at
 * end-of-stream, rejecting with `InvalidDigestError` on a mismatch. For the
 * multipart body, which `@fastify/multipart` reads off `request.raw` itself
 * rather than off the stream the preParsing hook returns: piping that stream
 * through `DigestVerifyStream` would drain it before busboy attached, and the
 * upload would arrive empty. Attaching a `data` listener would start the flow
 * just the same, so the stream is paused again right after; the reader that
 * pipes it resumes it, and both see every byte. The verdict is awaited by the
 * multipart write path once the parts are consumed, before anything is stored.
 * @param options {object}
 * @param options.payload {Readable}   the stream to tap
 * @param options.digestHeader {string}   the request's `Digest` header value
 * @returns {Promise<void>}   settles at end-of-stream
 */
function verifyDigestOfTappedStream({
  payload,
  digestHeader
}: {
  payload: Readable
  digestHeader: string
}): Promise<void> {
  const hash = createHash('sha256')
  const verdict = new Promise<void>((resolve, reject) => {
    payload.on('data', (chunk: Buffer) => hash.update(chunk))
    payload.on('end', () => {
      const mismatch = digestMismatch({
        digest: hash.digest(),
        header: digestHeader
      })
      if (mismatch === null) {
        resolve()
      } else {
        reject(mismatch)
      }
    })
    payload.on('error', reject)
  })
  // A request refused before its body is consumed never awaits the verdict.
  verdict.catch(() => {})
  payload.pause()
  return verdict
}

/**
 * preParsing hook: for JSON/text bodies, reads the incoming payload into
 * `request.rawBody` and hands the same bytes to Fastify's content-type parser
 * (so `verifyBodyDigest` can recompute the digest). Other (streamed)
 * bodies are not buffered; when the request is signed with a `Digest` they pass
 * through a `DigestVerifyStream` that verifies that digest incrementally, so a
 * swapped binary/large body under a valid signed `Digest` is still rejected. A
 * multipart body is tapped rather than piped (`verifyDigestOfTappedStream`),
 * since `@fastify/multipart` reads the raw request itself; its verdict is
 * `request.multipartDigest`, awaited by the multipart write path.
 *
 * What is buffered is bounded by the route's `bodyLimit`, in this hook rather
 * than in Fastify's parser: the parser runs downstream and would see only the
 * single buffer handed to it at end-of-stream, so the whole body would be
 * resident by the time its own 413 fired, and a chunked request has no
 * `Content-Length` to short-circuit on. The body is read here in full
 * (`readBoundedBody`), so an over-limit body is refused with
 * `payload-too-large` (413) at the byte that crosses the limit, the rest of it
 * is never read, and the refusal is raised from this hook -- before any
 * signature is verified, whichever parser the media type reaches. The bound is
 * what an unauthenticated caller meets.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @param payload {Readable}   the raw request body stream
 * @returns {Promise<Readable>}   the stream Fastify should parse
 */
export async function captureRawBody(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: Readable
): Promise<Readable> {
  if (!isBufferableBody(request.headers['content-type'])) {
    // Streamed (non-buffered) body. Bind it to the signature by hashing it as it
    // flows; an unsigned/anonymous body (no `Digest`) has nothing to verify.
    // `parseAuthHeaders` (onRequest) has already run, so `request.zcap` is set
    // for a signed request.
    const digestHeader = request.zcap?.digest
    if (!digestHeader) {
      return payload
    }
    if (isMultipartFormData({ contentType: request.headers['content-type'] })) {
      // Read by `@fastify/multipart` off `request.raw`, not off the stream
      // returned here, so the digest is taken by a tap on that stream instead.
      // Any other `multipart/*` type is an opaque blob, piped below.
      request.multipartDigest = verifyDigestOfTappedStream({
        payload,
        digestHeader
      })
      return payload
    }
    const verify = new DigestVerifyStream(digestHeader)
    payload.on('error', err => verify.destroy(err))
    // A request refused before its body is consumed (a failed signature, a
    // masked 404, a 405) leaves the transform with no reader, and a mismatch
    // raised at end-of-stream would then be an uncaught exception. A consumer
    // that reads the body still receives the error through its own listener.
    verify.on('error', () => {})
    return payload.pipe(verify)
  }
  // Buffer the body once: the single buffer handed to Fastify's parser is the
  // same one `rawBody` keeps, so the steady-state cost is one copy of the body.
  const rawBody = await readBoundedBody({ request, reply, payload })
  request.rawBody = rawBody
  const passthrough = new PassThrough()
  passthrough.end(rawBody)
  return passthrough
}

/**
 * True when a request carries a body: a `Content-Type`, a `Transfer-Encoding`,
 * or a non-zero `Content-Length`. The framing headers count on their own
 * because the catch-all parser hands a bodied request with no `Content-Type`
 * to its handler as a raw stream, and Import Space and the governed-log `PUT`
 * read that stream. A `Content-Length` of `0` is bodyless, as Fastify treats
 * it.
 * @param request {import('fastify').FastifyRequest}
 * @returns {boolean}
 */
function requestHasBody(request: FastifyRequest): boolean {
  const {
    'content-type': contentType,
    'content-length': contentLength,
    'transfer-encoding': transferEncoding
  } = request.headers
  return (
    Boolean(contentType) ||
    transferEncoding !== undefined ||
    (contentLength !== undefined && contentLength !== '0')
  )
}

/**
 * preValidation hook: enforces the `Digest` header binding for any request that
 * carries a body (`requestHasBody`). A body with no `Content-Type` is refused
 * with `missing-content-type` (400) first, signed or not. Bodyless requests and
 * anonymous reads (no parsed `request.zcap`) are passed through.
 * @param request {import('fastify').FastifyRequest}
 * @param reply {import('fastify').FastifyReply}
 * @returns {Promise<void>}
 */
export async function verifyBodyDigest(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  // Bodyless requests carry no Digest -- nothing to bind.
  if (!requestHasBody(request)) {
    return
  }
  // A body with no declared media type reaches no handler: the catch-all
  // parser would hand it over as a raw stream, whatever the route expects.
  if (!request.headers['content-type']) {
    throw new MissingContentTypeError()
  }
  // No parsed auth headers: there is no signature to bind the body to. Leave
  // the request to the handler's authorization, which grants a safe method
  // only under an access-control policy and refuses an unsafe one as the
  // masked `not-found`.
  const { zcap } = request
  if (!zcap) {
    return
  }

  // MUST: `digest` is among the signature's covered (signed) headers. Guard the
  // `headers` param itself: an `Authorization` header that omits `headers="..."`
  // leaves it undefined, and splitting that would be a 500 rather than the
  // intended `invalid-authorization-header` (400).
  if (!zcap.headers || !zcap.headers.split(/\s+/).includes('digest')) {
    throw new InvalidDigestError({
      detail:
        'The request signature must cover the `digest` header when the ' +
        'request carries a body.'
    })
  }
  // The `Digest` header itself MUST be present.
  if (!zcap.digest) {
    throw new InvalidDigestError({
      detail: 'A `Digest` header is required when the request carries a body.'
    })
  }

  // SHOULD: independently recompute and compare, when the raw body was captured.
  // Streamed bodies (multipart, tar import, raw blobs) are not buffered here;
  // `captureRawBody` has already wrapped them in a `DigestVerifyStream`, or
  // tapped a multipart body, to verify the digest as the body is consumed.
  if (request.rawBody === undefined) {
    return
  }
  const { verified, error } = await verifyHeaderValue({
    data: request.rawBody,
    headerValue: zcap.digest
  })
  if (!verified) {
    throw new InvalidDigestError({
      detail: error
        ? 'The `Digest` header is malformed or uses an unsupported algorithm.'
        : 'The `Digest` header does not match the request body.',
      cause: error
    })
  }
}
