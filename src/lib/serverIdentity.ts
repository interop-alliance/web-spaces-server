/**
 * The server's own identity: the export-signing key derived from
 * `WAS_SERVER_KEY_SEED`, the `server` Space that hosts the server's
 * `did:webvh` history log, and the check that ties the two together.
 *
 * The server holds no update key for its own DID. The admin named by
 * `WAS_ADMIN_DID` controls the `server` Space and writes the log
 * (`/space/server/id/did.jsonl`) through the ordinary front door, listing the
 * server's key as a verification method under `assertionMethod`, and under
 * `capabilityInvocation` too when the server is to sign sync invocations. The
 * server's part is to provision that Space at boot, advertise its key on
 * `/service` as `exportSigningMethod`, and advertise the DID as `serverDid`
 * once the resolved current document lists the key. Until then it signs
 * nothing.
 *
 * The log is written through the same `did.jsonl` rules every self-hosted
 * `did:webvh` gets: fast-forward and verify-on-append. It is read once per
 * check, and the check judges that read's bytes under the resolver's own
 * verification step (`verifyStoredLog` in `webvhController.ts`), the recorded
 * head included. Export Space takes the DID it puts in `service.json` and the
 * log snapshot it signs under from that one read, so the two cannot come from
 * different log versions.
 */
import type { FastifyBaseLogger } from 'fastify'
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDDoc, DIDLog } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { CountQuotaExceededError, PreconditionFailedError } from '../errors.js'
import { WEBVH_DOCUMENT_REVERIFY_AGE } from '../config.default.js'
import { backendScoped } from './backendCache.js'
import { etagOf } from './etag.js'
import {
  logDid,
  logHeadForgets,
  readStoredLog,
  verifyStoredLog
} from './webvhController.js'
import type { ServerBackends } from './serverBackends.js'
import {
  AUXILIARY_SPACE_TYPE,
  SERVER_INSTANCE_SPACE_TYPE,
  isServerInstanceSpace
} from './spaceType.js'
import {
  parseSelfHostedWebvh,
  parseWebvhSpacePath,
  WEBVH_LOG_RESOURCE_ID
} from './validateDid.js'
import type { IDID, StorageBackend } from '../types.js'

/**
 * The Space that hosts the server's identity. Provisioned at boot with the
 * admin DID as its controller; the server itself never writes into it.
 */
export const SERVER_SPACE_ID = 'server'

/**
 * The Collection in {@link SERVER_SPACE_ID} whose `did.jsonl` is the server's
 * history log, so the DID is `did:webvh:<scid>:<host>:space:server:id`.
 */
export const SERVER_IDENTITY_COLLECTION_ID = 'id'

/**
 * Whether a parsed `did:webvh` Space path is a server identity's: the history
 * log in the `id` Collection of a host's `server` Space, on this server or on
 * any other.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {boolean}
 */
export function isServerIdentityPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): boolean {
  return (
    spaceId === SERVER_SPACE_ID &&
    collectionId === SERVER_IDENTITY_COLLECTION_ID
  )
}

/**
 * Whether a DID parses as a server identity: a did:webvh on any host, a port
 * or a single-label host included, whose path is `space:server:id`.
 * @param did {string}
 * @returns {boolean}
 */
export function isServerIdentityDid(did: string): boolean {
  const parsed = parseWebvhSpacePath(did)
  return parsed !== undefined && isServerIdentityPath(parsed)
}

/**
 * The server's export-signing key pair plus the `did:key` it is advertised
 * as. Built once from the seed at registration.
 */
export interface ServerSigningKey {
  keyPair: Ed25519VerificationKey
  /** `did:key:` + the key's `publicKeyMultibase`, the `/service` member */
  exportSigningMethod: string
}

/**
 * Derives the export-signing key pair from the 32-byte seed
 * (`WAS_SERVER_KEY_SEED`, decoded by the config layer).
 * @param options {object}
 * @param options.seed {Uint8Array}   the 32-byte Ed25519 seed
 * @returns {Promise<ServerSigningKey>}
 */
export async function createServerSigningKey({
  seed
}: {
  seed: Uint8Array
}): Promise<ServerSigningKey> {
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  return {
    keyPair,
    exportSigningMethod: `did:key:${keyPair.publicKeyMultibase}`
  }
}

/**
 * The id the export-signing key carries as a method of the server's DID,
 * `{serverDid}#{publicKeyMultibase}`: the method export provenance and sync
 * invocations sign with.
 * @param options {object}
 * @param options.serverDid {string}
 * @param options.signingKey {ServerSigningKey}
 * @returns {string}
 */
export function serverMethodId({
  serverDid,
  signingKey
}: {
  serverDid: string
  signingKey: ServerSigningKey
}): string {
  return `${serverDid}#${signingKey.keyPair.publicKeyMultibase}`
}

/**
 * The export-signing key pair named as the method {@link serverMethodId} of
 * the server's DID, so a signature it makes names that method.
 * @param options {object}
 * @param options.serverDid {string}
 * @param options.signingKey {ServerSigningKey}
 * @returns {Ed25519VerificationKey}
 */
export function serverKeyPair({
  serverDid,
  signingKey
}: {
  serverDid: string
  signingKey: ServerSigningKey
}): Ed25519VerificationKey {
  const { publicKeyMultibase, privateKeyMultibase } = signingKey.keyPair
  return new Ed25519VerificationKey({
    id: serverMethodId({ serverDid, signingKey }),
    controller: serverDid,
    publicKeyMultibase,
    privateKeyMultibase
  })
}

/**
 * Provisions the `server` Space at boot, or checks the one already stored.
 *
 * An absent Space is created as a guarded write with `adminDid` as its
 * controller, typed `['AuxiliarySpace', 'ServerInstanceSpace', 'Space']`, so
 * no client can claim the id afterwards. A stored
 * Space must carry that subtype and that controller; anything else means the
 * id was claimed before the admin DID was configured, or the admin DID
 * changed, and either is an operator decision, so registration fails naming
 * what was found. A create that loses a race against another instance
 * booting over the same storage re-reads and checks what the winner stored.
 * The create counts against `maxSpacesPerController` like any other, and a
 * refusal there is reported naming the setting, since the operator will not
 * otherwise connect a Space count quota to the admin DID.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.adminDid {string}   the `did:key` from `WAS_ADMIN_DID`
 * @returns {Promise<void>}
 */
export async function provisionServerSpace({
  storage,
  adminDid
}: {
  storage: StorageBackend
  adminDid: IDID
}): Promise<void> {
  let stored = await storage.getSpaceMetadata({ spaceId: SERVER_SPACE_ID })
  if (stored === undefined) {
    try {
      await storage.writeSpace({
        spaceId: SERVER_SPACE_ID,
        spaceMetadata: {
          id: SERVER_SPACE_ID,
          type: [AUXILIARY_SPACE_TYPE, SERVER_INSTANCE_SPACE_TYPE, 'Space'],
          controller: adminDid
        },
        ifNoneMatch: '*'
      })
      return
    } catch (err) {
      if (err instanceof CountQuotaExceededError) {
        throw new Error(
          `Cannot provision the Space "${SERVER_SPACE_ID}" for WAS_ADMIN_DID ` +
            `"${adminDid}": ${err.detail} Raise the limit, or use an admin ` +
            'DID that controls fewer Spaces.',
          { cause: err }
        )
      }
      if (!(err instanceof PreconditionFailedError)) {
        throw err
      }
      // Another instance created it first; check what it stored.
      stored = await storage.getSpaceMetadata({ spaceId: SERVER_SPACE_ID })
      if (stored === undefined) {
        throw err
      }
    }
  }
  if (!isServerInstanceSpace(stored)) {
    throw new Error(
      `The Space "${SERVER_SPACE_ID}" exists but is not typed ` +
        `"${SERVER_INSTANCE_SPACE_TYPE}"; it was created before WAS_ADMIN_DID ` +
        'was configured. Delete it, or unset WAS_ADMIN_DID.'
    )
  }
  if (stored.controller !== adminDid) {
    throw new Error(
      `WAS_ADMIN_DID is "${adminDid}" but the Space "${SERVER_SPACE_ID}" is ` +
        `controlled by "${stored.controller}". Update the Space's controller ` +
        'through the ordinary Update Space write, or restore WAS_ADMIN_DID.'
    )
  }
}

/**
 * What {@link judgeServerLog} decides from one read of the log: the server
 * DID with the parsed log and the resolved document, or the reason there is
 * none.
 */
type JudgedServerLog =
  | { serverDid: string; log: DIDLog; doc: DIDDoc }
  | { reason: string; warning?: Record<string, unknown> }

/**
 * What every read of the server identity takes: the control plane, the set it
 * is the control plane of (the log is read from the backend that serves its
 * Collection), the server URL, the export-signing key, and the logger the
 * identity check's warnings go to.
 */
export interface ServerIdentityContext {
  storage: StorageBackend
  serverBackends: ServerBackends
  serverUrl: string
  signingKey: ServerSigningKey
  logger: FastifyBaseLogger
}

/**
 * The outcome of {@link readServerIdentity}: the server DID with the bytes,
 * the parsed log and the resolved document it was judged from, or the reason
 * there is none.
 */
export type ServerIdentityRead =
  | { serverDid: string; logBytes: Buffer; log: DIDLog; doc: DIDDoc }
  | { reason: string }

/**
 * The reason {@link readServerIdentity} gives when no log is stored.
 */
const NO_LOG_REASON = 'There is no server history log.'

/**
 * The last outcome of {@link readServerIdentity} per backend, keyed on the
 * validator of the log it was read from: `logEtag` is the log Resource's
 * `ETag`, or `undefined` when there was no log. `identity` is the server DID
 * and the resolved document it was judged from, or
 * `undefined` when the log yields no DID, in which case `reason` says why.
 * `judgedAt` is the `performance.now()` of the judgment.
 *
 * Any write to the log changes the validator, so a hit is a read of the same
 * bytes unless they were rewritten out of band. A hit is therefore honored
 * only while the judgment is younger than `WEBVH_DOCUMENT_REVERIFY_AGE`, the
 * same bound the resolver's document cache keeps. A miss re-reads. An
 * operator problem is logged once per log version and reason, not once per
 * `/service` request.
 */
const serverDidMemo = backendScoped<{
  entry?: {
    logEtag: string | undefined
    identity: { serverDid: string; doc: DIDDoc } | undefined
    reason: string | undefined
    judgedAt: number
  }
}>(() => ({}))

/**
 * Resolves the server's DID from the stored log and checks that the resolved
 * current document lists the export-signing key the way
 * {@link signingKeyRelationshipProblem} requires: under `assertionMethod`,
 * optionally under `capabilityInvocation`, and under no other relationship.
 * Returns the DID string when it does, and
 * `undefined` otherwise: the log is absent, does not parse, names a DID not
 * hosted at `server/id` of this server, fails verification, or lists the key
 * wrongly. The reason is logged at `warn`, since each is an operator matter.
 * The rule is {@link readServerIdentity}'s.
 *
 * Read per `/service` request, through the memo {@link resolveServerIdentity}
 * describes, so a request costs one metadata read of the log while the log
 * stands still.
 *
 * @param options {ServerIdentityContext}
 * @returns {Promise<string | undefined>}
 */
export async function resolveServerDid(
  options: ServerIdentityContext
): Promise<string | undefined> {
  const identity = await memoizedServerIdentity(options)
  return identity?.serverDid
}

/**
 * The server's DID together with the resolved current document it was judged
 * from, under the rule {@link resolveServerDid} states. Returns `undefined`
 * when the log yields no DID. The sync signer reads both from here, so the
 * DID it signs as and the `capabilityInvocation` listing it checks come from
 * one log version. The document is the caller's own copy.
 *
 * The outcome is memoized per control plane on the log Resource's `ETag`
 * ({@link serverDidMemo}). A call costs one metadata read of the log while
 * the log stands still (plus the read that finds the log's backend in a set
 * of several). The log is read, parsed and its document resolved when it has
 * changed, or when the memoized judgment has reached
 * `WEBVH_DOCUMENT_REVERIFY_AGE`, by the read {@link readServerIdentity}
 * makes, which records the new outcome.
 *
 * @param options {ServerIdentityContext}
 * @returns {Promise<{ serverDid: string, doc: DIDDoc } | undefined>}
 */
export async function resolveServerIdentity(
  options: ServerIdentityContext
): Promise<{ serverDid: string; doc: DIDDoc } | undefined> {
  const identity = await memoizedServerIdentity(options)
  if (identity === undefined) {
    return undefined
  }
  // The memo keeps its document for the life of a log version, and the read
  // that judged it hands the same object out, so this caller gets a copy.
  return { serverDid: identity.serverDid, doc: structuredClone(identity.doc) }
}

/**
 * The memoized half of {@link resolveServerIdentity}. The document it returns
 * may be the memo's own, so it stays inside this module.
 *
 * @param options {ServerIdentityContext}
 * @returns {Promise<{ serverDid: string, doc: DIDDoc } | undefined>}
 */
async function memoizedServerIdentity({
  storage,
  serverBackends,
  serverUrl,
  signingKey,
  logger
}: ServerIdentityContext): Promise<
  { serverDid: string; doc: DIDDoc } | undefined
> {
  const memo = serverDidMemo.for(storage)
  const backend = await serverLogBackend({ serverBackends })
  const metadata = await serverLogMetadata({ backend })
  if (metadata === undefined) {
    memo.entry = noLogEntry()
    return undefined
  }
  const logEtag = etagOf(metadata)
  const { entry } = memo
  if (
    logEtag !== undefined &&
    entry !== undefined &&
    entry.logEtag === logEtag &&
    performance.now() - entry.judgedAt < WEBVH_DOCUMENT_REVERIFY_AGE
  ) {
    return entry.identity
  }
  const read = await readIdentityFrom({
    storage,
    backend,
    serverUrl,
    signingKey,
    logger
  })
  return 'serverDid' in read ? read : undefined
}

/**
 * Reads the server history log once and judges the server's DID from that
 * read's bytes alone ({@link judgeServerLog}, the rule `/service` advertises
 * `serverDid` under). Returns the DID with the bytes, the parsed log and the
 * resolved document it was judged from, or the reason there is none. Export
 * Space calls it directly, so the `serverDid` its `service.json` carries and
 * the log snapshot it signs under come from one log version.
 * The returned document is the one the memo keeps, so a caller only reads it.
 *
 * A refused read is made once more when the log has changed since. A read
 * that fell behind a concurrent append does not extend the head another
 * reader recorded meanwhile, and that says nothing about the stored log. The
 * second read is judged alone, the same way.
 *
 * Records the outcome, the DID with its document, in {@link serverDidMemo}
 * under the `ETag` of that same read, which is what
 * {@link resolveServerIdentity} checks before it reads again.
 * A reason that is an operator matter is logged at `warn` once per log
 * version and reason: not again when the memo already holds both.
 *
 * @param options {ServerIdentityContext}
 * @returns {Promise<ServerIdentityRead>}
 */
export async function readServerIdentity({
  storage,
  serverBackends,
  serverUrl,
  signingKey,
  logger
}: ServerIdentityContext): Promise<ServerIdentityRead> {
  const backend = await serverLogBackend({ serverBackends })
  return await readIdentityFrom({
    storage,
    backend,
    serverUrl,
    signingKey,
    logger
  })
}

/**
 * {@link readServerIdentity}, given the backend that serves the log's
 * Collection.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.backend {StorageBackend}   the backend that serves the log's
 *   Collection
 * @param options.serverUrl {string}
 * @param options.signingKey {ServerSigningKey}
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<ServerIdentityRead>}
 */
async function readIdentityFrom({
  storage,
  backend,
  serverUrl,
  signingKey,
  logger
}: Omit<ServerIdentityContext, 'serverBackends'> & {
  backend: StorageBackend
}): Promise<ServerIdentityRead> {
  const memo = serverDidMemo.for(storage)
  // The outcome is recorded only over the entry this call started from. A
  // slower call that read an older version must not replace what a faster
  // one recorded for a newer version.
  const before = memo.entry
  const judgeRead = { storage, backend, serverUrl, signingKey }
  let read = await readAndJudgeServerLog(judgeRead)
  if (
    read !== undefined &&
    'reason' in read.judged &&
    (await serverLogChanged({ backend, logEtag: read.logEtag }))
  ) {
    read = await readAndJudgeServerLog(judgeRead)
  }
  if (read === undefined) {
    if (memo.entry === before) {
      memo.entry = noLogEntry()
    }
    return { reason: NO_LOG_REASON }
  }
  const { logEtag, logBytes, judged } = read
  const reason = 'reason' in judged ? judged.reason : undefined
  const logged =
    logEtag !== undefined &&
    memo.entry?.logEtag === logEtag &&
    memo.entry.reason === reason
  if ('warning' in judged && judged.warning !== undefined && !logged) {
    logger.warn(judged.warning, judged.reason)
  }
  // A log with no validator cannot be told apart from its next version, so
  // its outcome is not memoized.
  if (logEtag !== undefined && memo.entry === before) {
    memo.entry = {
      logEtag,
      identity:
        'serverDid' in judged
          ? { serverDid: judged.serverDid, doc: judged.doc }
          : undefined,
      reason,
      judgedAt: performance.now()
    }
  }
  if ('serverDid' in judged) {
    return { ...judged, logBytes }
  }
  return { reason: judged.reason }
}

/**
 * One read of the server history log and the judgment of that read's bytes,
 * or `undefined` when no log is stored.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.backend {StorageBackend}   the backend that serves the log's
 *   Collection
 * @param options.serverUrl {string}
 * @param options.signingKey {ServerSigningKey}
 * @returns {Promise<{ logEtag: string | undefined, logBytes: Buffer,
 *   judged: JudgedServerLog } | undefined>}
 */
async function readAndJudgeServerLog({
  storage,
  backend,
  serverUrl,
  signingKey
}: {
  storage: StorageBackend
  backend: StorageBackend
  serverUrl: string
  signingKey: ServerSigningKey
}): Promise<
  | { logEtag: string | undefined; logBytes: Buffer; judged: JudgedServerLog }
  | undefined
> {
  // Taken before the read, as the resolver takes it (see `verifyStoredLog`).
  const forgets = logHeadForgets({ storage })
  const stored = await readStoredLog({
    backend,
    spaceId: SERVER_SPACE_ID,
    collectionId: SERVER_IDENTITY_COLLECTION_ID
  })
  if (stored === undefined) {
    return undefined
  }
  const { bytes: logBytes, etag: logEtag } = stored
  const judged = await judgeServerLog({
    storage,
    logBytes,
    forgets,
    serverUrl,
    signingKey
  })
  return { logEtag, logBytes, judged }
}

/**
 * Whether the stored server history log is no longer the version read under
 * `logEtag`: its validator differs, or the log is gone. A read with no
 * validator cannot be compared and counts as unchanged.
 *
 * @param options {object}
 * @param options.backend {StorageBackend}   the backend that serves the log's
 *   Collection
 * @param [options.logEtag] {string}   the validator of the read
 * @returns {Promise<boolean>}
 */
async function serverLogChanged({
  backend,
  logEtag
}: {
  backend: StorageBackend
  logEtag: string | undefined
}): Promise<boolean> {
  if (logEtag === undefined) {
    return false
  }
  const metadata = await serverLogMetadata({ backend })
  return metadata === undefined || etagOf(metadata) !== logEtag
}

/**
 * The server history log Resource's metadata, or `undefined` when no log is
 * stored. Its `ETag` is the validator the memo is keyed on.
 * @param options {object}
 * @param options.backend {StorageBackend}   the backend that serves the log's
 *   Collection
 * @returns {ReturnType<StorageBackend['getResourceMetadata']>}
 */
async function serverLogMetadata({
  backend
}: {
  backend: StorageBackend
}): ReturnType<StorageBackend['getResourceMetadata']> {
  return await backend.getResourceMetadata({
    spaceId: SERVER_SPACE_ID,
    collectionId: SERVER_IDENTITY_COLLECTION_ID,
    resourceId: WEBVH_LOG_RESOURCE_ID
  })
}

/**
 * The memo entry that records that no server history log is stored.
 * @returns {object}
 */
function noLogEntry(): {
  logEtag: undefined
  identity: undefined
  reason: string
  judgedAt: number
} {
  return {
    logEtag: undefined,
    identity: undefined,
    reason: NO_LOG_REASON,
    judgedAt: performance.now()
  }
}

/**
 * The rule that decides the server's DID from the bytes of its history log.
 * The log's head must name a DID hosted at `server/id` of this server. The
 * log must verify as that DID's current log, under the resolver's own step
 * (`verifyStoredLog`): it extends the head this server last verified and is
 * not deactivated. Its document must list the export-signing key the way
 * {@link signingKeyRelationshipProblem} requires.
 *
 * A refusal carries a `reason`. When the reason is an operator matter it also
 * carries `warning`, the bindings to log it with. A log that does not parse
 * or names no DID carries none.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane, which keys the
 *   recorded log heads
 * @param options.logBytes {Buffer}   the log, as the log Resource serves it
 * @param options.forgets {number}   `logHeadForgets`, taken before the read
 * @param options.serverUrl {string}
 * @param options.signingKey {ServerSigningKey}
 * @returns {Promise<JudgedServerLog>}
 */
async function judgeServerLog({
  storage,
  logBytes,
  forgets,
  serverUrl,
  signingKey
}: {
  storage: StorageBackend
  logBytes: Buffer
  forgets: number
  serverUrl: string
  signingKey: ServerSigningKey
}): Promise<JudgedServerLog> {
  const logText = logBytes.toString('utf8')
  let did: string | undefined
  try {
    did = logDid(readLogFromString(logText))
  } catch {
    did = undefined
  }
  if (did === undefined) {
    return { reason: 'The server history log names no DID.' }
  }
  const parsed = parseSelfHostedWebvh(did, { serverUrl })
  if (parsed === undefined || !isServerIdentityPath(parsed)) {
    return {
      reason:
        'The stored server history log names a DID not hosted at ' +
        `${SERVER_SPACE_ID}/${SERVER_IDENTITY_COLLECTION_ID} of this server; ` +
        'the server identity is not advertised.',
      warning: { did }
    }
  }
  let verified: { log: DIDLog; doc: DIDDoc }
  try {
    verified = await verifyStoredLog({
      storage,
      did,
      spaceId: parsed.spaceId,
      collectionId: parsed.collectionId,
      selfHosted: true,
      logText,
      forgets
    })
  } catch (err) {
    return {
      reason:
        'The server history log does not verify; the server identity is not ' +
        'advertised.',
      warning: { err, did }
    }
  }
  const problem = signingKeyRelationshipProblem({
    doc: verified.doc,
    publicKeyMultibase: signingKey.keyPair.publicKeyMultibase
  })
  if (problem !== undefined) {
    return {
      reason: `${problem} The server identity is not advertised.`,
      warning: { did, exportSigningMethod: signingKey.exportSigningMethod }
    }
  }
  return { serverDid: did, ...verified }
}

/**
 * The server backend that serves the server history log's Collection.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @returns {Promise<StorageBackend>}
 */
async function serverLogBackend({
  serverBackends
}: {
  serverBackends: ServerBackends
}): Promise<StorageBackend> {
  return serverBackends.dataBackendOf({
    spaceId: SERVER_SPACE_ID,
    collectionId: SERVER_IDENTITY_COLLECTION_ID
  })
}

/**
 * The relationship the server key must be listed under, for export signing.
 */
const REQUIRED_RELATIONSHIP = 'assertionMethod'

/**
 * The one relationship the server key may also be listed under. It lets the
 * server sign sync invocations with the same key. The admin adds it to enable
 * replication.
 */
const PERMITTED_RELATIONSHIP = 'capabilityInvocation'

/**
 * Why the resolved document does not list the export-signing key the way the
 * server requires. The key must be listed under `assertionMethod`. It may also
 * be listed under `capabilityInvocation`. It must not be listed under
 * `capabilityDelegation`, `authentication` or `keyAgreement`. A key that could
 * delegate would be read as a ladder or transient annex method by the
 * client-annex clause. The server has no use for the other two. Returns
 * `undefined` when the document lists it correctly. This one predicate serves
 * `/service`, export signing and the import statement check.
 *
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved current document
 * @param options.publicKeyMultibase {string}   the server key's public key
 * @returns {string | undefined}
 */
export function signingKeyRelationshipProblem({
  doc,
  publicKeyMultibase
}: {
  doc: DIDDoc
  publicKeyMultibase: string
}): string | undefined {
  const { methodIds, listedUnder } = keyRelationships({
    doc,
    publicKeyMultibase
  })
  if (methodIds.size === 0 && listedUnder.length === 0) {
    return 'The resolved server document lists no verification method for the export-signing key.'
  }
  if (!listedUnder.includes(REQUIRED_RELATIONSHIP)) {
    return `The resolved server document does not list the export-signing key under "${REQUIRED_RELATIONSHIP}".`
  }
  const refused = listedUnder.filter(
    relationship =>
      relationship !== REQUIRED_RELATIONSHIP &&
      relationship !== PERMITTED_RELATIONSHIP
  )
  if (refused.length > 0) {
    return (
      'The resolved server document lists the export-signing key under ' +
      `${refused.map(name => `"${name}"`).join(', ')}; it may be listed ` +
      `only under "${REQUIRED_RELATIONSHIP}" and "${PERMITTED_RELATIONSHIP}".`
    )
  }
  return undefined
}

/**
 * Where a document lists a key: the ids of every verification method that
 * carries it, and the verification relationships that name one of those
 * methods or embed the key. Every method id is read, not just the first, so a
 * second method carrying the same key cannot slip past a check. Shared with
 * the replica registration check, which reads whether a local `did:key` is a
 * current invocation key of the peer controller's document.
 *
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved current document
 * @param options.publicKeyMultibase {string}   the key
 * @returns {{ methodIds: Set<string>, listedUnder: string[] }}
 */
export function keyRelationships({
  doc,
  publicKeyMultibase
}: {
  doc: DIDDoc
  publicKeyMultibase: string
}): {
  methodIds: Set<string>
  listedUnder: Array<
    | 'authentication'
    | 'assertionMethod'
    | 'keyAgreement'
    | 'capabilityInvocation'
    | 'capabilityDelegation'
  >
} {
  const methodIds = new Set(
    (doc.verificationMethod ?? [])
      .filter(vm => vm.publicKeyMultibase === publicKeyMultibase)
      .map(vm => vm.id)
      .filter((id): id is string => typeof id === 'string')
  )
  const listedUnder = (
    [
      'authentication',
      'assertionMethod',
      'keyAgreement',
      'capabilityInvocation',
      'capabilityDelegation'
    ] as const
  ).filter(relationship =>
    referencesKey(doc[relationship], { methodIds, publicKeyMultibase })
  )
  return { methodIds, listedUnder }
}

/**
 * Whether a verification relationship references the key: by one of its
 * method ids, or through an embedded method carrying the key itself.
 * @param relationship {unknown}   the document member
 * @param options {object}
 * @param options.methodIds {Set<string>}   ids of the methods carrying the key
 * @param options.publicKeyMultibase {string}   the key itself
 * @returns {boolean}
 */
function referencesKey(
  relationship: unknown,
  {
    methodIds,
    publicKeyMultibase
  }: { methodIds: Set<string>; publicKeyMultibase: string }
): boolean {
  if (!Array.isArray(relationship)) {
    return false
  }
  return relationship.some(entry => {
    if (typeof entry === 'string') {
      return methodIds.has(entry)
    }
    if (typeof entry !== 'object' || entry === null) {
      return false
    }
    return (
      methodIds.has(entry.id) || entry.publicKeyMultibase === publicKeyMultibase
    )
  })
}
