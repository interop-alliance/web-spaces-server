/**
 * Import provenance: judges an archive's `provenance.jsonl` statements against
 * its `did.jsonl` snapshot and its archived bytes, and drops each `createdBy`
 * the archive did not earn. The verifying half of `exportProvenance.ts`; the
 * statement contract the two share is in `provenanceStatement.ts`.
 *
 * The signer is the DID the snapshot's head entry names. The snapshot must
 * verify offline as that DID's history log (SCID pinning plus the full hash
 * chain and update-key checks). Any server DID whose log verifies is accepted:
 * there is no allowlist, and the importer's own DID gets no special treatment.
 * Each statement is then judged on its own. Its `verificationMethod` must name
 * the snapshot's DID, and its `id` must sit on the host that DID is anchored
 * at. The method must appear in the document at the log entry whose
 * `versionId` equals the statement's `didVersionId`, under
 * `assertionMethod`. It may also be listed under `capabilityInvocation`, the
 * relationship a server signs sync invocations under, and under no other.
 * Then the `eddsa-jcs-2022` proof is verified, and last the statement's
 * claims are compared with the archived object: its
 * `createdBy`, `createdAt`, its write stamp (`updatedAt`,
 * `updatedAtCounter`, `originId`) and, for a Resource, its `/meta` record's
 * stamp (`meta`) and its `digest`. The archived stamps are read here for
 * this comparison only; the importing backend re-stamps every record it
 * writes. A chunked Resource's `digest` covers its chunk files alone,
 * so a substituted parent representation of one still verifies; the check
 * binds `createdBy` to the chunks, not to that parent file.
 *
 * Every object the archive carries an attestable entry for gets one verdict:
 * the Space Metadata object, each Collection Metadata object, and each
 * Resource with a representation. A tombstone gets none. An object is judged
 * whether or not the destination already holds it, so the counts describe the
 * archive. Outside `verified`, the object's archived `createdBy` is removed
 * from the plan, so both backends import it without one. A tombstone's
 * sidecar is never attested, so its `createdBy` is removed too: the
 * tombstone's change document would otherwise carry it.
 */
import { readLogFromString } from '@interop/did-method-webvh'
import type { DIDDoc, DIDLog } from '@interop/did-method-webvh'
import { DataIntegrityProof } from '@interop/data-integrity-proof'
import { createVerifyCryptosuite } from '@interop/ed25519-signature/eddsa-jcs-2022'
import {
  ARCHIVE_DID_LOG_FILE,
  ARCHIVE_PROVENANCE_FILE,
  collectionMetadataFileName,
  spaceMetadataFileName
} from '@interop/space-archive'
import type { ArchiveFile } from '@interop/space-archive'
import type { FastifyBaseLogger } from 'fastify'
import type { ImportStats } from '../types.js'
import type { ImportPlan, TarEntry } from './importTar.js'
import { isPlainObject } from './isPlainObject.js'
import { withoutSidecarMembers } from './metaSidecar.js'
import { collectionMetaPath, resourcePath, spaceMetaPath } from './paths.js'
import {
  CLAIM_MEMBERS,
  chunkedDigest,
  claimMatches,
  fileDigest,
  serverFieldsOf,
  STORAGE_ATTESTATION_TYPE
} from './provenanceStatement.js'
import type { Claims } from './provenanceStatement.js'
import {
  isServerIdentityPath,
  signingKeyRelationshipProblem
} from './serverIdentity.js'
import { didOfMethodId, parseSelfHostedWebvh } from './validateDid.js'
import {
  dereferenceFragment,
  findVerificationMethod,
  headOf,
  logDid,
  verifyWebvhLog
} from './webvhController.js'

/**
 * One verdict: the name of the `ImportStats.provenance` count it adds to.
 */
type Verdict = keyof ImportStats['provenance']

/**
 * One parsed `provenance.jsonl` line: a `StorageAttestation` with a URL `id`.
 */
type Statement = Record<string, unknown> & { id: string }

/**
 * The verifying suite is stateless, so one instance serves every statement.
 */
const verifySuite = new DataIntegrityProof({
  cryptosuite: createVerifyCryptosuite()
})

/**
 * How many object ids one `warn` line names for a verdict and reason.
 */
const LOGGED_IDS_PER_REASON = 10

/**
 * The `warn` message per verdict outside `verified` and `unattested`.
 */
const REFUSAL_MESSAGES: Partial<Record<Verdict, string>> = {
  proofInvalid: 'a statement proof does not verify',
  contentMismatch:
    'a statement verifies but does not match the archived object ' +
    '(altered or damaged bytes)',
  unknownSigner: 'a statement signer cannot be established'
}

/**
 * The archive's signer, once its history log snapshot verifies: the DID its
 * head entry names, the parsed log, and the documents resolved per
 * `versionId`, seeded with the head's.
 */
interface ArchiveSigner {
  did: string
  log: DIDLog
  docs: Map<string, Promise<DIDDoc | undefined>>
}

/**
 * Judges the archive's provenance statements and returns the plan with every
 * unearned `createdBy` removed, plus the per-verdict counts. Never throws on
 * a bad statement or log: an archive with no provenance, or a broken one,
 * still imports, with no attribution it did not earn. Each verdict outside
 * `verified` and `unattested` is logged at `warn` once per distinct reason,
 * with a count and a sample of the object ids, so an archive of many bad
 * statements costs a bounded number of lines. A `proofInvalid` and a
 * `contentMismatch` get different messages, so bit-rot in the archived bytes
 * is not read as a bad signature.
 *
 * @param options {object}
 * @param options.entries {Map<string, TarEntry>}   the extracted archive
 * @param options.plan {ImportPlan}   the plan `buildImportPlan` built from it
 * @param options.logger {FastifyBaseLogger}
 * @returns {Promise<{ plan: ImportPlan, provenance: ImportStats['provenance'] }>}
 */
export async function applyImportProvenance({
  entries,
  plan,
  logger
}: {
  entries: Map<string, TarEntry>
  plan: ImportPlan
  logger: FastifyBaseLogger
}): Promise<{ plan: ImportPlan; provenance: ImportStats['provenance'] }> {
  const provenance: ImportStats['provenance'] = {
    verified: 0,
    unattested: 0,
    proofInvalid: 0,
    contentMismatch: 0,
    unknownSigner: 0
  }
  const statements = readStatements({
    bytes: entries.get(ARCHIVE_PROVENANCE_FILE)?.body
  })
  // With no statements every object is unattested, and the signer is never
  // read, so the log is not verified.
  let signer: ArchiveSigner | { reason: string } = {
    reason: 'The archive carries no provenance statements.'
  }
  if (statements.size > 0) {
    signer = await establishSigner({
      bytes: entries.get(ARCHIVE_DID_LOG_FILE)?.body
    })
    if ('reason' in signer) {
      logger.warn(
        { reason: signer.reason },
        'Import provenance: the archive signer cannot be established; ' +
          'attested objects are imported without createdBy.'
      )
    }
  }
  const refusals = new Map<
    string,
    { verdict: Verdict; reason: string; count: number; ids: string[] }
  >()

  async function judge({
    path,
    claims,
    digest
  }: {
    path: string
    claims: Claims
    digest?: () => Promise<string | undefined>
  }): Promise<boolean> {
    const statement = statements.get(path)
    if (statement === undefined) {
      provenance.unattested++
      return false
    }
    const outcome = await judgeStatement({ statement, signer, claims, digest })
    provenance[outcome.verdict]++
    if ('reason' in outcome) {
      const key = `${outcome.verdict}\n${outcome.reason}`
      const refusal = refusals.get(key) ?? {
        verdict: outcome.verdict,
        reason: outcome.reason,
        count: 0,
        ids: []
      }
      refusal.count++
      if (refusal.ids.length < LOGGED_IDS_PER_REASON) {
        refusal.ids.push(statement.id)
      }
      refusals.set(key, refusal)
    }
    return outcome.verdict === 'verified'
  }

  const { sourceSpaceId } = plan
  const spacePrefix = `space/${sourceSpaceId}/`
  const spaceMetadataBytes = entries.get(
    `${spacePrefix}${spaceMetadataFileName(sourceSpaceId)}`
  )?.body
  if (spaceMetadataBytes !== undefined) {
    // An import never restores the Space Metadata object's `createdBy`, so
    // the verdict is only counted.
    await judge({
      path: spaceMetaPath({ spaceId: sourceSpaceId }),
      claims: serverFieldsOf({ bytes: spaceMetadataBytes })
    })
  }

  // A Collection tombstone (`plan.collectionTombstones`) carries no
  // statement and is not counted: only live Collections are judged.
  const collections = []
  for (const collection of plan.collections) {
    const { collectionId } = collection
    const metadataBytes = entries.get(
      `${spacePrefix}${collectionId}/${collectionMetadataFileName(collectionId)}`
    )?.body
    const metadataClaims =
      metadataBytes === undefined
        ? undefined
        : serverFieldsOf({ bytes: metadataBytes })
    const metadataVerified =
      metadataClaims !== undefined &&
      (await judge({
        path: collectionMetaPath({ spaceId: sourceSpaceId, collectionId }),
        claims: metadataClaims
      }))
    // A `createdBy` is earned only as a claim the statement attests. One of
    // any other shape than a list of DIDs is read as no claim
    // (`serverFieldsOf`), so a verified statement says nothing of it and it
    // is removed.
    const metadataEarned =
      metadataVerified && metadataClaims.createdBy !== undefined
    const collectionMetadata = metadataEarned
      ? collection.collectionMetadata
      : withoutCreatedBy(collection.collectionMetadata)

    // The chunk files the plan will write, per chunked Resource, as the
    // archive files `chunkedDigest` reads: the digest then covers the bytes
    // the import stores.
    const chunkDirs = new Map<string, ArchiveFile[]>()
    for (const { resourceId, fileName, body } of collection.chunkFiles) {
      const files = chunkDirs.get(resourceId) ?? []
      files.push({ name: fileName, bytes: body })
      chunkDirs.set(resourceId, files)
    }
    const resourceMetadata = new Map(collection.resourceMetadata)
    const earned = new Set<string>()
    for (const { resourceId, body } of collection.resources) {
      const sidecar = resourceMetadata.get(resourceId)
      const chunkFiles = chunkDirs.get(resourceId)
      const claims =
        sidecar === undefined ? {} : serverFieldsOf({ bytes: sidecar })
      const verified = await judge({
        path: resourcePath({
          spaceId: sourceSpaceId,
          collectionId,
          resourceId
        }),
        claims,
        digest: () =>
          chunkFiles === undefined
            ? fileDigest({ name: resourceId, bytes: body })
            : chunkedDigest(chunkFiles)
      })
      // As for the Collection Metadata object: a sidecar `createdBy` that
      // was not read as a claim is not attested.
      if (verified && claims.createdBy !== undefined) {
        earned.add(resourceId)
      }
    }
    // Every sidecar outside a verified Resource loses its `createdBy`:
    // unattested Resources, and tombstones, which carry no statement. So
    // does a verified one whose `createdBy` is not a list of DIDs.
    for (const [resourceId, bytes] of resourceMetadata) {
      if (!earned.has(resourceId)) {
        resourceMetadata.set(
          resourceId,
          withoutSidecarMembers({ bytes, members: ['createdBy'] })
        )
      }
    }
    collections.push({ ...collection, collectionMetadata, resourceMetadata })
  }

  for (const { verdict, reason, count, ids } of refusals.values()) {
    logger.warn(
      { reason, count, ids },
      `Import provenance: ${REFUSAL_MESSAGES[verdict]}; the objects are ` +
        'imported without createdBy.'
    )
  }
  return { plan: { ...plan, collections }, provenance }
}

/**
 * Parses `provenance.jsonl` into its statements, keyed by the URL path of the
 * object each names. A line that is not a `StorageAttestation` object with a
 * URL `id` is skipped. When two statements name one object, the first is
 * kept: a statement only ever earns `createdBy` by verifying in full, so the
 * choice can drop an attribution but cannot grant one.
 * @param options {object}
 * @param [options.bytes] {Buffer}   the entry's bytes, absent when the archive
 *   carries none
 * @returns {Map<string, Statement>}
 */
function readStatements({ bytes }: { bytes?: Buffer }): Map<string, Statement> {
  const statements = new Map<string, Statement>()
  if (bytes === undefined) {
    return statements
  }
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim().length === 0) {
      continue
    }
    let statement: unknown
    try {
      statement = JSON.parse(line)
    } catch {
      continue
    }
    if (
      !isPlainObject(statement) ||
      statement.type !== STORAGE_ATTESTATION_TYPE ||
      typeof statement.id !== 'string'
    ) {
      continue
    }
    let path: string
    try {
      path = new URL(statement.id).pathname
    } catch {
      continue
    }
    if (!statements.has(path)) {
      statements.set(path, statement as Statement)
    }
  }
  return statements
}

/**
 * Establishes the archive's signer from its `did.jsonl` snapshot: the log
 * must parse, its head must name a DID, and the whole log must verify as that
 * DID's history log.
 * @param options {object}
 * @param [options.bytes] {Buffer}   the entry's bytes, absent when the archive
 *   carries none
 * @returns {Promise<ArchiveSigner | { reason: string }>}
 */
async function establishSigner({
  bytes
}: {
  bytes?: Buffer
}): Promise<ArchiveSigner | { reason: string }> {
  if (bytes === undefined) {
    return { reason: 'The archive carries no DID history log.' }
  }
  let log: DIDLog
  try {
    log = readLogFromString(bytes.toString('utf8'))
  } catch {
    return { reason: 'The archived DID history log does not parse.' }
  }
  const did = logDid(log)
  if (did === undefined) {
    return { reason: 'The archived DID history log names no DID.' }
  }
  let head: { doc: DIDDoc; deactivated: boolean }
  try {
    head = await verifyWebvhLog({ did, log })
  } catch (err) {
    return {
      reason: `The archived DID history log does not verify: ${(err as Error).message}`
    }
  }
  // Every statement of one export names the head, so the document that
  // verification just resolved answers them without a second pass.
  const docs = new Map<string, Promise<DIDDoc | undefined>>()
  docs.set(
    headOf(log).versionId,
    Promise.resolve(head.deactivated ? undefined : head.doc)
  )
  return { did, log, docs }
}

/**
 * The signer's document at one log version: the log is cut after the entry
 * whose `versionId` matches and verified up to there. Every prefix of a valid
 * log is a valid log, so this is the document the signer published at that
 * version. Returns `undefined` when no entry carries the `versionId`, or the
 * document there is deactivated. Memoized per `versionId`; the head is
 * seeded by `establishSigner`.
 * @param options {object}
 * @param options.signer {ArchiveSigner}
 * @param options.versionId {string}
 * @returns {Promise<DIDDoc | undefined>}
 */
function documentAt({
  signer,
  versionId
}: {
  signer: ArchiveSigner
  versionId: string
}): Promise<DIDDoc | undefined> {
  let doc = signer.docs.get(versionId)
  if (doc === undefined) {
    doc = (async () => {
      const index = signer.log.findIndex(entry => entry.versionId === versionId)
      if (index === -1) {
        return undefined
      }
      try {
        const resolved = await verifyWebvhLog({
          did: signer.did,
          log: signer.log.slice(0, index + 1)
        })
        return resolved.deactivated ? undefined : resolved.doc
      } catch {
        return undefined
      }
    })()
    signer.docs.set(versionId, doc)
  }
  return doc
}

/**
 * Judges one statement against the archive's signer and the archived object.
 * @param options {object}
 * @param options.statement {Statement}
 * @param options.signer {ArchiveSigner | { reason: string }}
 * @param options.claims {Claims}   the members read off the archived object
 * @param [options.digest] {() => Promise<string | undefined>}   the archived
 *   content's digest, for a Resource
 * @returns {Promise<{ verdict: Verdict, reason?: string }>}
 */
async function judgeStatement({
  statement,
  signer,
  claims,
  digest
}: {
  statement: Statement
  signer: ArchiveSigner | { reason: string }
  claims: Claims
  digest?: () => Promise<string | undefined>
}): Promise<{ verdict: Verdict; reason: string } | { verdict: 'verified' }> {
  if ('reason' in signer) {
    return { verdict: 'unknownSigner', reason: signer.reason }
  }
  const { proof, ...document } = statement
  if (!isPlainObject(proof)) {
    return { verdict: 'proofInvalid', reason: 'The statement has no proof.' }
  }
  const methodId = proof.verificationMethod
  if (typeof methodId !== 'string' || didOfMethodId(methodId) !== signer.did) {
    return {
      verdict: 'unknownSigner',
      reason: 'The proof names a method outside the archived DID.'
    }
  }
  const anchored = parseSelfHostedWebvh(signer.did, { serverUrl: statement.id })
  if (anchored === undefined || !isServerIdentityPath(anchored)) {
    return {
      verdict: 'unknownSigner',
      reason:
        'The archived DID is not the server DID of the host the statement ' +
        'names.'
    }
  }
  const versionId = statement.didVersionId
  const doc =
    typeof versionId === 'string'
      ? await documentAt({ signer, versionId })
      : undefined
  if (doc === undefined) {
    return {
      verdict: 'unknownSigner',
      reason:
        'The statement names no live version of the archived DID history log.'
    }
  }
  const publicKeyMultibase = findVerificationMethod({
    doc,
    id: methodId
  })?.publicKeyMultibase
  if (
    typeof publicKeyMultibase !== 'string' ||
    signingKeyRelationshipProblem({ doc, publicKeyMultibase }) !== undefined
  ) {
    return {
      verdict: 'unknownSigner',
      reason:
        'The signing method is not listed under "assertionMethod", or is ' +
        'also listed under a relationship other than "capabilityInvocation", ' +
        'at the named log version.'
    }
  }

  if (
    proof.type !== 'DataIntegrityProof' ||
    proof.cryptosuite !== 'eddsa-jcs-2022' ||
    proof.proofPurpose !== 'assertionMethod'
  ) {
    return {
      verdict: 'proofInvalid',
      reason: 'The proof is not an "eddsa-jcs-2022" "assertionMethod" proof.'
    }
  }
  const result = await verifySuite.verifyProof({
    proof: structuredClone(proof),
    proofSet: [],
    document: structuredClone(document),
    // JCS needs no context; the one load is the signing method itself.
    documentLoader: async (url: string) => {
      if (url !== methodId) {
        throw new Error(`Unexpected document load: "${url}".`)
      }
      return { document: dereferenceFragment({ doc, id: methodId }) }
    }
  })
  if (!result.verified) {
    return {
      verdict: 'proofInvalid',
      reason: String(result.error?.message ?? 'The signature does not verify.')
    }
  }

  // A member the object lacks must be absent from the statement too.
  const mismatched = CLAIM_MEMBERS.filter(
    member =>
      !claimMatches({
        member,
        stated: statement[member],
        claimed: claims[member]
      })
  )
  if (mismatched.length > 0) {
    return {
      verdict: 'contentMismatch',
      reason: `The archived ${mismatched.map(member => `"${member}"`).join(', ')} differ from the statement.`
    }
  }
  if (digest !== undefined && statement.digest !== (await digest())) {
    return {
      verdict: 'contentMismatch',
      reason: 'The archived content does not match the statement digest.'
    }
  }
  return { verdict: 'verified' }
}

/**
 * A record with its `createdBy` removed.
 * @param record {T}
 * @returns {Omit<T, 'createdBy'>}
 */
function withoutCreatedBy<T extends { createdBy?: unknown }>(
  record: T
): Omit<T, 'createdBy'> {
  const { createdBy: _dropped, ...rest } = record
  return rest
}
