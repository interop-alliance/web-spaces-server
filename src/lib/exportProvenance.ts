/**
 * Export provenance: the signed statements an export archive carries in its
 * `provenance.jsonl`, one per exported object, and the server's DID history
 * log snapshot it carries as `did.jsonl`, so the statements verify offline.
 *
 * A statement is a plain JSON object,
 * `{ id, type: 'StorageAttestation', createdBy, createdAt, updatedAt,
 * updatedAtCounter, originId, meta, digest, didVersionId }`, with one
 * `eddsa-jcs-2022` Data Integrity proof
 * (`proofPurpose` `assertionMethod`) by the export-signing key, named as
 * `{serverDid}#{publicKeyMultibase}`. `id` is the object's absolute URL on
 * this server. `digest` is the `Digest` header's multihash form (`mh=` plus a
 * base64url sha-256 multihash) over the Resource's content as archived; for a
 * chunked Resource it is the same form over the JCS serialization of its
 * chunk digests, in chunk index order. `updatedAt`, `updatedAtCounter` and
 * `originId` are the object's write stamp; a Resource's `meta` is its `/meta`
 * record's stamp and generation, present once metadata was written. A Space
 * or Collection Metadata statement carries no `meta` and no `digest`.
 * `didVersionId` names the version of the signing DID's document that lists
 * the key, since `proof.created` is not trustworthy: for a `did:webvh` signer,
 * the `versionId` of the log entry.
 *
 * The signed bytes say nothing about the export itself: no export time and
 * no reference to the manifest. The proof carries no `created` either, and
 * Ed25519 signatures are deterministic, so the same statement signed at any
 * other time is the same bytes. That keeps a later write-time signature
 * interchangeable with an export-time one.
 *
 * Statements are built from the archive's own entry tree, after the backend
 * has built it and before it is packed, so both backends share this code and
 * every digest is over the very bytes the archive carries. The statements sit
 * ahead of the `space/` tree, so each Resource is read twice: once here to
 * digest it, once when it is packed. The export is not one transaction, so a
 * Resource written between the two reads leaves a statement that does not
 * match its archived bytes, and an importer drops that one attribution. A
 * backend may also build the tree before it reads any file, so an object
 * deleted after the tree was built is gone by the time it is digested here.
 * It gets no statement, and the export goes on.
 */
import type { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import jsigs from '@interop/jsonld-signatures'
import {
  ARCHIVE_REVOCATIONS_DIR,
  classifyCollectionFile
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'
import {
  absoluteUrl,
  collectionMetaPath,
  resourcePath,
  spaceMetaPath
} from './paths.js'
import {
  chunkedDigest,
  fileBytes,
  fileDigest,
  serverFieldsOf,
  STORAGE_ATTESTATION_TYPE
} from './provenanceStatement.js'
import type { Claims } from './provenanceStatement.js'
import {
  readServerIdentity,
  serverKeyPair,
  serverMethodId
} from './serverIdentity.js'
import type {
  ServerIdentityContext,
  ServerSigningKey
} from './serverIdentity.js'
import { headOf } from './webvhController.js'

/**
 * What an export needs to sign its provenance: the server's DID, the log
 * snapshot the archive embeds (verbatim bytes) and its head `versionId`, and
 * the export-signing key named under the server DID.
 */
export interface ExportAttestor {
  /** the base URL the statements' `id`s are built on */
  serverUrl: string
  serverDid: string
  /** the log's bytes, exactly as the log Resource serves them */
  didLog: Uint8Array
  /**
   * the version of the signing DID's document that lists the key; for this
   * server's `did:webvh` signer, the `versionId` of the snapshot's head entry
   */
  didVersionId: string
  /** the signing key pair, its `id` `{serverDid}#{publicKeyMultibase}` */
  keyPair: Ed25519VerificationKey
}

/**
 * Loads what an export needs to sign its provenance, or says why it cannot,
 * together with the server DID the export's `service.json` carries.
 *
 * The server history log is read once (`readServerIdentity`). That read's
 * bytes decide the server DID under the rule `/service` advertises
 * `serverDid` under, and they are the snapshot the archive embeds. So the
 * `serverDid` handed back and the snapshot come from one log version, even
 * when the log is appended while the export runs.
 *
 * The snapshot's document must also list the export-signing key as the method
 * `{serverDid}#{publicKeyMultibase}`. A document that lists the key under
 * another id still yields a `serverDid`, but no attestor. The snapshot is what
 * an importer verifies against, so it is judged by the bytes that travel.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.serverBackends {ServerBackends}   the set `storage` is the
 *   control plane of
 * @param options.serverUrl {string}
 * @param [options.signingKey] {ServerSigningKey}   absent on a server with
 *   no export-signing key, which has no identity to sign with
 * @param options.logger {FastifyBaseLogger}   for the identity check's
 *   once-per-log-version warnings
 * @returns {Promise<{ serverDid: string | undefined } &
 *   ({ attestor: ExportAttestor } | { reason: string })>}
 */
export async function loadExportAttestor({
  storage,
  serverBackends,
  serverUrl,
  signingKey,
  logger
}: Omit<ServerIdentityContext, 'signingKey'> & {
  signingKey: ServerSigningKey | undefined
}): Promise<
  { serverDid: string | undefined } & (
    { attestor: ExportAttestor } | { reason: string }
  )
> {
  if (signingKey === undefined) {
    return {
      serverDid: undefined,
      reason: 'No export-signing key is configured.'
    }
  }
  const identity = await readServerIdentity({
    storage,
    serverBackends,
    serverUrl,
    signingKey,
    logger
  })
  if (!('serverDid' in identity)) {
    return { serverDid: undefined, reason: identity.reason }
  }
  const { serverDid, logBytes, log, doc } = identity
  const { publicKeyMultibase } = signingKey.keyPair
  const methodId = serverMethodId({ serverDid, signingKey })
  const listed = (doc.verificationMethod ?? []).some(
    method =>
      method.id === methodId && method.publicKeyMultibase === publicKeyMultibase
  )
  if (!listed) {
    return {
      serverDid,
      reason:
        `The server document lists the export-signing key under an id ` +
        `other than "${methodId}".`
    }
  }
  return {
    serverDid,
    attestor: {
      serverUrl,
      serverDid,
      didLog: logBytes,
      didVersionId: headOf(log).versionId,
      keyPair: serverKeyPair({ serverDid, signingKey })
    }
  }
}

/**
 * Reads the server-managed members off one archived JSON dot-file: a Space or
 * Collection Metadata object or a Resource metadata sidecar. A file that is
 * gone yields `undefined`.
 * @param options {object}
 * @param options.file {ArchiveFile}
 * @returns {Promise<Claims | undefined>}
 */
async function archivedServerFields({
  file
}: {
  file: ArchiveFile
}): Promise<Claims | undefined> {
  const bytes = await fileBytes(file)
  return bytes === undefined ? undefined : serverFieldsOf({ bytes })
}

/**
 * Signs one statement with the attestor's key: one `eddsa-jcs-2022` proof,
 * `proofPurpose` `assertionMethod`, with no `created`. The proof is made
 * straight from the suite, not through `jsigs.sign`, which would add a
 * JSON-LD `@context` the statement does not carry.
 * @param options {object}
 * @param options.statement {Record<string, unknown>}
 * @param options.suite {EddsaJcs2022}
 * @returns {Promise<string>}   the signed statement as one JSON line
 */
async function signStatement({
  statement,
  suite
}: {
  statement: Record<string, unknown>
  suite: EddsaJcs2022
}): Promise<string> {
  const proof = await suite.createProof({
    document: { ...statement },
    purpose: new jsigs.purposes.AssertionProofPurpose(),
    proofSet: [],
    // JCS needs no document loader; any load attempt is a bug.
    documentLoader: async (url: string) => {
      throw new Error(`Unexpected document load: "${url}".`)
    }
  })
  return JSON.stringify({ ...statement, proof })
}

/**
 * Builds the archive's `provenance.jsonl` body from its entry tree: one
 * signed statement per exported object, in the order the manifest lists the
 * object's entry. The Space Metadata object is attested at its
 * `.space.meta.<id>.json` entry, a Collection Metadata object at its
 * `.collection.meta.<id>.json` entry, and a Resource at its representation
 * file, with the server-managed members read off its `.meta.<id>.json` sidecar.
 * A Resource with a chunk directory beside its representation gets the
 * composite chunk digest. A tombstone (a sidecar with no representation)
 * holds no content and gets no statement, and neither does an object whose
 * file, or one of whose chunks, was deleted after the tree was built.
 *
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.entries {ArchiveEntry[]}   the archive's top-level entries,
 *   in pack order, as handed to `packSpaceArchive`
 * @param options.attestor {ExportAttestor}
 * @returns {Promise<string>}   the JSON Lines body, one statement per line
 */
export async function attestArchiveEntries({
  spaceId,
  entries,
  attestor
}: {
  spaceId: string
  entries: ArchiveEntry[]
  attestor: ExportAttestor
}): Promise<string> {
  const suite = new EddsaJcs2022({
    signer: attestor.keyPair.signer(),
    // No `created`: the proof must not depend on when it was made.
    date: null
  })
  const urlOf = (path: string): string =>
    absoluteUrl({ path, serverUrl: attestor.serverUrl })
  const lines: string[] = []

  async function attest(statement: Record<string, unknown>): Promise<void> {
    lines.push(
      await signStatement({
        statement: {
          ...statement,
          didVersionId: attestor.didVersionId
        },
        suite
      })
    )
  }

  async function attestMetadata({
    id,
    file
  }: {
    id: string
    file: ArchiveFile
  }): Promise<void> {
    const fields = await archivedServerFields({ file })
    if (fields === undefined) {
      return
    }
    await attest({
      id,
      type: STORAGE_ATTESTATION_TYPE,
      ...fields
    })
  }

  for (const entry of entries) {
    // A Space-level file other than the Space Metadata object gets no
    // statement. That includes a Collection tombstone, which holds no
    // content. Neither does a revocation record, which is not a stored
    // object.
    if (!('files' in entry)) {
      if (classifyCollectionFile(entry.name).kind === 'spaceMetadata') {
        await attestMetadata({
          id: urlOf(spaceMetaPath({ spaceId })),
          file: entry
        })
      }
      continue
    }
    if (entry.name === ARCHIVE_REVOCATIONS_DIR) {
      continue
    }
    const collectionId = entry.name
    const sidecars = new Map<string, ArchiveFile>()
    const chunkDirs = new Map<string, ArchiveEntry[]>()
    for (const child of entry.files) {
      const kind = classifyCollectionFile(child.name)
      if ('files' in child) {
        if (kind.kind === 'chunkDirectory') {
          chunkDirs.set(kind.resourceId, child.files)
        }
      } else if (kind.kind === 'metaSidecar') {
        sidecars.set(kind.resourceId, child)
      }
    }
    for (const child of entry.files) {
      if ('files' in child) {
        continue
      }
      const kind = classifyCollectionFile(child.name)
      if (kind.kind === 'collectionMetadata') {
        await attestMetadata({
          id: urlOf(collectionMetaPath({ spaceId, collectionId })),
          file: child
        })
        continue
      }
      if (kind.kind !== 'representation') {
        continue
      }
      const { resourceId } = kind
      const chunkFiles = chunkDirs.get(resourceId)
      const digest =
        chunkFiles === undefined
          ? await fileDigest(child)
          : await chunkedDigest(chunkFiles)
      if (digest === undefined) {
        continue
      }
      const sidecar = sidecars.get(resourceId)
      const fields =
        sidecar === undefined
          ? undefined
          : await archivedServerFields({ file: sidecar })
      await attest({
        id: urlOf(resourcePath({ spaceId, collectionId, resourceId })),
        type: STORAGE_ATTESTATION_TYPE,
        ...fields,
        digest
      })
    }
  }
  return lines.map(line => `${line}\n`).join('')
}
