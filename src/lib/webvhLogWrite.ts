/**
 * The write rule for a `did.jsonl` Resource, the history log a self-hosted
 * `did:webvh` resolves from. The log is the authorization root of any Space
 * its DID controls, and the Collection it lives in is whatever the DID names,
 * so the rule keys on the Resource name in every Collection. A PUT must
 * fast-forward the stored log: the stored bytes verbatim, followed by any new
 * entries. So a write grant can add history but cannot erase it. Without the
 * rule, a retired client still holding a subtree grant could PUT a prefix of
 * the log that lists its key again, since every prefix of a valid log is a
 * valid log with the same SCID. An append must also verify: the whole new
 * body is verified as the history log of the DID the stored log names, so a
 * junk or tampered entry is refused before it can leave that DID's Spaces
 * with no resolvable controller. A DELETE is refused in the handler; the log
 * goes away only with its Collection or Space.
 */
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'
import {
  InvalidRequestBodyError,
  PreconditionFailedError,
  StorageError
} from '../errors.js'
import { readBoundedBody } from './bodyLimit.js'
import { storedJsonBytes } from './contentDigest.js'
import type { HeldValidators } from './etag.js'
import { etagOf } from './etag.js'
import { isFastForward } from './governedLog.js'
import { assertWritePrecondition } from './preconditions.js'
import { logDid, verifyWebvhLog } from './webvhController.js'
import { WEBVH_LOG_RESOURCE_ID } from './validateDid.js'
import { readWebvhLogResource } from './webvhLogLocation.js'
import type { ResourceInput, StorageBackend } from '../types.js'

/**
 * Applies the fast-forward rule to a `did.jsonl` write, before the write.
 * Reads the stored log and its `ETag`, evaluates the client's own
 * preconditions against that read, checks the incoming bytes extend it, and
 * verifies the extended log. Returns the input to write (a streamed body is
 * re-assembled after it was read) and the preconditions to write under:
 * `If-Match` on the `ETag` that was read, or `If-None-Match: *` when no log was stored. The
 * backend evaluates those atomically with the write, so a log that changed
 * after the read fails the write with 412 rather than being overwritten.
 *
 * Throws `precondition-failed` (412) when the body does not extend the
 * stored log, or when the client's preconditions do not hold,
 * `invalid-request-body` (400) when the extended log does not verify, and
 * `payload-too-large` (413) when a streamed body exceeds the route's
 * buffered-body limit.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.reply {FastifyReply}
 * @param options.dataBackend {StorageBackend}   the backend the write targets
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.input {ResourceInput}   the resolved write body
 * @param [options.ifMatch] {string}   the client's `If-Match`
 * @param [options.ifNoneMatch] {HeldValidators}   the client's `If-None-Match`
 * @param options.requestName {string}
 * @returns {Promise<{ input: ResourceInput, ifMatch?: string,
 *   ifNoneMatch?: HeldValidators }>}
 */
export async function guardWebvhLogWrite({
  request,
  reply,
  dataBackend,
  spaceId,
  collectionId,
  input,
  ifMatch,
  ifNoneMatch,
  requestName
}: {
  request: FastifyRequest
  reply: FastifyReply
  dataBackend: StorageBackend
  spaceId: string
  collectionId: string
  input: ResourceInput
  ifMatch?: string
  ifNoneMatch?: HeldValidators
  requestName: string
}): Promise<{
  input: ResourceInput
  ifMatch?: string
  ifNoneMatch?: HeldValidators
}> {
  const stored = await readWebvhLogResource({
    backend: dataBackend,
    spaceId,
    collectionId
  })
  if (!stored) {
    // A create: guard it against a concurrent create, which would otherwise
    // be overwritten by this one.
    return {
      input,
      ...(ifMatch !== undefined && { ifMatch }),
      ifNoneMatch: '*'
    }
  }
  const prior = await buffer(stored.resourceStream)
  const currentEtag = etagOf(stored)
  if (currentEtag === undefined) {
    // Every Resource write mints a validator, and the append must be pinned
    // to one: `If-Match: *` would let two appends checked against the same
    // read both land, the second overwriting the first.
    throw new StorageError({
      cause: new Error('The stored did.jsonl carries no ETag.'),
      requestName
    })
  }
  assertWritePrecondition({
    resourceId: WEBVH_LOG_RESOURCE_ID,
    exists: true,
    currentEtag,
    ifMatch,
    ifNoneMatch
  })
  const { input: guarded, body } = await assertExtends({
    request,
    reply,
    input,
    prior,
    requestName
  })
  await assertAppendVerifies({ prior, body, requestName })
  return { input: guarded, ifMatch: currentEtag }
}

/**
 * Checks the write body starts with the stored log's bytes. A JSON body is
 * compared as the backend serializes it. A streamed body is read whole, since
 * the extended log is verified next, and handed back as a stream of the same
 * bytes. It is read under the route's buffered-body limit, since a raw
 * `application/octet-stream` body reaches here unbounded.
 *
 * @param options {object}
 * @param options.request {FastifyRequest}
 * @param options.reply {FastifyReply}
 * @param options.input {ResourceInput}
 * @param options.prior {Buffer}   the stored log bytes
 * @param options.requestName {string}
 * @returns {Promise<{ input: ResourceInput, body: Buffer }>}   the input to
 *   write and the body bytes it carries
 */
async function assertExtends({
  request,
  reply,
  input,
  prior,
  requestName
}: {
  request: FastifyRequest
  reply: FastifyReply
  input: ResourceInput
  prior: Buffer
  requestName: string
}): Promise<{ input: ResourceInput; body: Buffer }> {
  const body =
    input.kind === 'json'
      ? storedJsonBytes(input.data)
      : await readBoundedBody({ request, reply, payload: input.stream })
  if (!isFastForward({ prior, body })) {
    throw new PreconditionFailedError({
      requestName,
      detail:
        'The stored did.jsonl history log is not a prefix of the body: a ' +
        'write carries the stored bytes verbatim followed by any new entries.'
    })
  }
  if (input.kind === 'json') {
    return { input, body }
  }
  return { input: { ...input, stream: Readable.from(body) }, body }
}

/**
 * Verifies an extended log as the history log of the DID the stored log
 * names (its head entry's `state.id`). The stored log is not re-verified:
 * the new body carries it verbatim, so a broken stored log fails here too,
 * and a stored `did.jsonl` that names no DID cannot be appended to.
 *
 * A log that declares witnesses is refused, whatever host its DID names.
 *
 * @param options {object}
 * @param options.prior {Buffer}   the stored log bytes
 * @param options.body {Buffer}   the extended log bytes
 * @param options.requestName {string}
 * @returns {Promise<void>}
 */
async function assertAppendVerifies({
  prior,
  body,
  requestName
}: {
  prior: Buffer
  body: Buffer
  requestName: string
}): Promise<void> {
  const refuse = (detail: string) =>
    new InvalidRequestBodyError({ requestName, detail })
  let did: string | undefined
  try {
    did = logDid(readLogFromString(prior.toString('utf8')))
  } catch {
    throw refuse('The stored did.jsonl is not a did:webvh history log.')
  }
  if (typeof did !== 'string') {
    throw refuse('The stored did.jsonl names no DID.')
  }
  let log: DIDLog
  try {
    log = readLogFromString(body.toString('utf8'))
  } catch {
    throw refuse('The did.jsonl body is not valid JSON Lines.')
  }
  try {
    await verifyWebvhLog({ did, log })
  } catch (err) {
    throw refuse(
      `The did.jsonl body does not verify as the history log of "${did}": ` +
        (err as Error).message
    )
  }
}
