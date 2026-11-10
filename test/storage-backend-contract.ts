/**
 * Parameterized StorageBackend contract suite: the storage-level invariants
 * every backend must satisfy (types.ts `StorageBackend` docs), run against
 * both the filesystem and Postgres backends so their semantics cannot drift.
 * Not a test file itself -- see storage-contract-filesystem.test.ts and
 * storage-contract-postgres.test.ts for the per-backend entry points.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import * as tar from 'tar-stream'
import { pino } from 'pino'
import { createHeaderValue } from '@interop/http-digest-header'
import { collectBytes, readSpaceArchive } from '@interop/space-archive'
import {
  isCollectionTombstoneSummary,
  isWriteStamp
} from '@interop/storage-core'
import { logToJsonlString } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  etagOf,
  formatEtag,
  isMintedGeneration,
  resourceMetaEtag
} from '../src/lib/etag.js'
import { metadataEtagOf } from '../src/lib/metadataValidator.js'
import type { EtagValidator } from '../src/lib/etag.js'
import { compareStamps, stampOf, withoutStampMembers } from '../src/lib/hlc.js'
import { replicaValidator } from '../src/lib/replicaRecord.js'
import { extractTarEntries } from '../src/lib/importTar.js'
import { loadExportAttestor } from '../src/lib/exportProvenance.js'
import { ServerBackends } from '../src/lib/serverBackends.js'
import type { ExportAttestor } from '../src/lib/exportProvenance.js'
import { verifyRevocationChain } from '../src/zcap.js'
import { revocationRecordFor } from '../src/lib/revocations.js'
import {
  assertEtagAdvanced,
  bareDidKeyOf,
  delegate,
  importArchive,
  parseEtagSegments,
  binaryInput,
  REPLICA_CAPABILITY_ID,
  replicaRegistration,
  resourceDocuments,
  verifyProvenanceOffline,
  watchWitnessFetches
} from './helpers.js'
import {
  frozenClock,
  mintServerDid,
  provisionServerIdentity
} from '../src/testing.js'
import {
  CollectionNotFoundError,
  PreconditionFailedError,
  ProblemError,
  ResourceImmutableError,
  ResourceNotFoundError,
  StorageError,
  UniqueAttributeConflictError,
  QuotaExceededError,
  CountQuotaExceededError,
  PayloadTooLargeError,
  InvalidCursorError,
  InvalidImportError,
  KeystoreStateConflictError,
  KeyIdConflictError,
  DuplicateRevocationError,
  InvalidRequestBodyError
} from '../src/errors.js'
import type {
  StorageBackend,
  StoredBackendRecord,
  KeystoreConfig,
  KmsKeyRecord,
  RevocationRecord,
  ResourceInput,
  CollectionMetadata,
  CollectionSummary,
  CollectionLogResult,
  StoredCollectionMetadata,
  SpaceMetadata,
  IDID,
  ImportStats,
  WriteStamp,
  FeedDocument,
  ResourceWriteResult,
  ReplicaLoopState
} from '../src/types.js'

/** A backend instance plus its teardown, as produced by the suite factory. */
export interface BackendHarness {
  backend: StorageBackend
  cleanup(): Promise<void>
}

/** Per-backend capabilities the shared suite adapts its assertions to. */
export interface ContractOptions {
  /** suite display name (e.g. 'FileSystemBackend') */
  name: string
  /**
   * Builds a fresh, empty backend. `capacityBytes` / `maxUploadBytes` configure
   * the byte quotas; `maxSpacesPerController` / `maxCollectionsPerSpace`
   * configure the count quotas for the count-quota block.
   * `physicalClock` freezes or steps the clock the backend's write stamps
   * read.
   */
  makeBackend(options?: {
    physicalClock?: () => number
    capacityBytes?: number
    maxUploadBytes?: number
    maxSpacesPerController?: number
    maxCollectionsPerSpace?: number
  }): Promise<BackendHarness>
  /**
   * True when the backend enforces the per-Space quota as a HARD limit under
   * concurrency (transactional accounting). The filesystem backend's
   * documented soft limit skips the concurrent-writer block.
   */
  hardQuota: boolean
  /**
   * True when `reportUsage().usageBytes` is exactly the stored content bytes
   * (the Postgres counter); the filesystem's `du` includes file/block
   * overhead, so its figure is only asserted loosely.
   */
  exactUsage: boolean
}

/** Reads a Readable fully into a string. */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Asserts a later validator of one record moved past an earlier one: the same
 * generation and a strictly later write stamp. A container Metadata validator
 * (one carrying a `local` segment) also resets that segment to 0.
 * @param before {EtagValidator}
 * @param after {EtagValidator}
 * @returns {void}
 */
function assertValidatorAdvanced(
  before: EtagValidator,
  after: EtagValidator
): void {
  assertEtagAdvanced({
    before: formatEtag(before),
    after: formatEtag(after),
    container: before.local !== undefined
  })
}

/**
 * Asserts a validator a write returned describes the stored record segment by
 * segment, and that its formatted `ETag` parses into the same segments: the
 * record's generation, `ms` equal to `Date.parse(updatedAt)`, the counter,
 * the store's origin id, and on a container Metadata object the local
 * segment.
 * @param options {object}
 * @param options.validator {EtagValidator}   what the write returned
 * @param options.stored {object}   the record as read back
 * @param options.stored.generation {string | undefined}
 * @param options.stored.updatedAt {string | undefined}
 * @param options.stored.updatedAtCounter {number | undefined}
 * @param options.stored.originId {string | undefined}
 * @param [options.stored.local] {number}   a container's local segment
 * @param options.originId {string}   the backend's origin id
 * @param [options.ms] {number}   the expected physical part
 * @returns {void}
 */
function assertValidatorSegments({
  validator,
  stored,
  originId,
  ms
}: {
  validator: EtagValidator
  stored: {
    generation?: string
    updatedAt?: string
    updatedAtCounter?: number
    originId?: string
    local?: number
  }
  originId: string
  ms?: number
}): void {
  const container = stored.local !== undefined
  const segments = parseEtagSegments(formatEtag(validator), { container })
  assert.equal(segments.generation, stored.generation)
  assert.ok(isMintedGeneration(segments.generation))
  assert.equal(
    Date.parse(segments.stamp.updatedAt),
    Date.parse(stored.updatedAt!)
  )
  assert.equal(segments.stamp.updatedAtCounter, stored.updatedAtCounter)
  assert.equal(segments.stamp.originId, stored.originId)
  assert.equal(segments.stamp.originId, originId)
  if (container) {
    assert.equal(segments.local, stored.local)
  }
  if (ms !== undefined) {
    assert.equal(Date.parse(segments.stamp.updatedAt), ms)
  }
}

/**
 * The `ETag` of a validator whose stamp counter is moved by `by`: well formed,
 * and carried by no record the test wrote.
 * @param options {object}
 * @param options.validator {EtagValidator}
 * @param options.by {number}
 * @returns {string}
 */
function etagWithCounterBumped({
  validator,
  by
}: {
  validator: EtagValidator
  by: number
}): string {
  const { stamp } = validator
  return formatEtag({
    ...validator,
    stamp: { ...stamp, updatedAtCounter: stamp.updatedAtCounter + by }
  })
}

function jsonInput(data: unknown): ResourceInput {
  return { kind: 'json', contentType: 'application/json', data }
}

/**
 * A binary input whose stream yields a few bytes and then errors, standing in
 * for an upload the client abandons mid-body. The write must fail without
 * leaving anything behind -- including a quota reservation.
 */
function abortedBinaryInput(declaredBytes: number): ResourceInput {
  return {
    kind: 'binary',
    contentType: 'application/octet-stream',
    stream: Readable.from(
      (async function* () {
        yield Buffer.alloc(16)
        throw new Error('client went away')
      })()
    ),
    declaredBytes
  }
}

/**
 * Matches the 404 a write into a container with no Metadata object throws.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof ProblemError && err.statusCode === 404
}

const CONTROLLER = 'did:key:z6MkContractSuiteController' as IDID
const CREATOR_ONE = 'did:key:z6MkContractSuiteCreatorOne' as IDID
const CREATOR_TWO = 'did:key:z6MkContractSuiteCreatorTwo' as IDID

async function provisionSpace(
  backend: StorageBackend,
  spaceId: string,
  collectionId = 'col',
  controller: IDID = CONTROLLER
): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceMetadata: {
      id: spaceId,
      type: ['Space'],
      name: `Space ${spaceId}`,
      controller
    }
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: {
      id: collectionId,
      type: ['Collection'],
      name: `Collection ${collectionId}`
    }
  })
}

function keystoreConfig(
  keystoreId: string,
  overrides: Partial<KeystoreConfig> = {}
): KeystoreConfig {
  return {
    id: `https://kms.example/kms/keystores/${keystoreId}`,
    controller: CONTROLLER,
    sequence: 0,
    kmsModule: 'local-v1',
    ...overrides
  }
}

function keyRecord(keystoreId: string, localId: string): KmsKeyRecord {
  const now = new Date().toISOString()
  return {
    keystoreId,
    localId,
    meta: { created: now, updated: now },
    key: {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      id: `https://kms.example/kms/keystores/${keystoreId}/keys/${localId}`,
      type: 'Ed25519VerificationKey2020',
      publicKeyMultibase: 'z6MkfExample',
      privateKeyMultibase: 'zSecretExample'
    }
  }
}

function revocationRecord({
  capabilityId,
  delegator,
  expires
}: {
  capabilityId: string
  delegator: string
  expires?: string
}): RevocationRecord {
  return {
    capability: { id: capabilityId, ...(expires && { expires }) },
    meta: {
      delegator,
      rootTarget: 'https://kms.example/kms/keystores/ks',
      created: new Date().toISOString(),
      ...(expires && { expires })
    }
  }
}

/**
 * The server URL the revocation import cases root their capability chains in.
 */
const REVOCATION_SERVER_URL = 'https://pws.example'

/**
 * A Space's canonical trailing-slash URL under {@link REVOCATION_SERVER_URL}.
 * @param spaceId {string}
 * @returns {string}
 */
function revocationSpaceUrl(spaceId: string): string {
  return `${REVOCATION_SERVER_URL}/space/${spaceId}/`
}

/**
 * Delegates read access on a Space's `col` Collection from the Space's root
 * capability, signed by the Space controller's key.
 * @param options {object}
 * @param options.signer {any}   the Space controller's signer
 * @param options.spaceUrl {string}   the Space's canonical trailing-slash URL
 * @returns {Promise<any>}
 */
async function delegatedFromSpace({
  signer,
  spaceUrl
}: {
  signer: any
  spaceUrl: string
}): Promise<any> {
  const { did: delegee } = bareDidKeyOf(await Ed25519VerificationKey.generate())
  return delegate({
    signer,
    capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
    invocationTarget: `${spaceUrl}col`,
    controller: delegee,
    allowedActions: ['GET']
  })
}

/**
 * The revocation records a Space holds, read back off its export archive.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.spaceId {string}
 * @returns {Promise<RevocationRecord[]>}
 */
async function archivedRevocations({
  backend,
  spaceId
}: {
  backend: StorageBackend
  spaceId: string
}): Promise<RevocationRecord[]> {
  const entries = await extractTarEntries(
    await backend.exportSpace({ spaceId })
  )
  return [...entries]
    .filter(
      ([entryName, entry]) =>
        entryName.startsWith(`space/${spaceId}/.revocations/`) &&
        entry.type === 'file'
    )
    .map(([, entry]) => JSON.parse(entry.body!.toString('utf8')))
}

/**
 * A write stamp as a peer would serve it, minted by another origin.
 * @param options {object}
 * @param options.ms {number}   epoch milliseconds
 * @param [options.counter] {number}
 * @returns {WriteStamp}
 */
function peerStamp({
  ms,
  counter = 0
}: {
  ms: number
  counter?: number
}): WriteStamp {
  return {
    updatedAt: new Date(ms).toISOString(),
    updatedAtCounter: counter,
    originId: 'peer-origin'
  }
}

/**
 * Registers the shared StorageBackend contract suite for one backend.
 * @param options {ContractOptions}
 */
export function describeStorageBackendContract(options: ContractOptions): void {
  const { name, makeBackend, hardQuota, exactUsage } = options

  describe(`StorageBackend contract: ${name}`, () => {
    describe('absent-target getters and idempotent deletes', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('getters resolve falsy (never throw) on absent targets', async () => {
        const { backend } = harness
        assert.equal(
          await backend.getSpaceMetadata({ spaceId: 'nope' }),
          undefined
        )
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId: 'nope',
            collectionId: 'nope'
          }),
          undefined
        )
        assert.equal(
          await backend.getResourceMetadata({
            spaceId: 'nope',
            collectionId: 'nope',
            resourceId: 'nope'
          }),
          undefined
        )
        assert.equal(await backend.getPolicy({ spaceId: 'nope' }), undefined)
        assert.equal(
          await backend.getBackend({ spaceId: 'nope', backendId: 'nope' }),
          undefined
        )
        assert.equal(
          await backend.getKeystore({ keystoreId: 'nope' }),
          undefined
        )
        assert.equal(
          await backend.getKey({ keystoreId: 'nope', localId: 'nope' }),
          undefined
        )
      })

      it('getResource throws ResourceNotFoundError on an absent Resource', async () => {
        await expect(
          harness.backend.getResource({
            spaceId: 'nope',
            collectionId: 'nope',
            resourceId: 'nope'
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
      })

      it('listSpaces / listKeystoresByController resolve empty on an empty store', async () => {
        assert.deepEqual(await harness.backend.listSpaces(), [])
        assert.deepEqual(
          await harness.backend.listKeystoresByController({
            controller: CONTROLLER
          }),
          []
        )
      })

      it('deletes are idempotent on absent targets', async () => {
        const { backend } = harness
        await backend.deleteSpace({ spaceId: 'nope' })
        assert.equal(
          await backend.deleteCollection({
            spaceId: 'nope',
            collectionId: 'x'
          }),
          'absent'
        )
        await backend.deleteResource({
          spaceId: 'nope',
          collectionId: 'x',
          resourceId: 'y'
        })
        await backend.deletePolicy({ spaceId: 'nope' })
        await backend.deleteBackend({ spaceId: 'nope', backendId: 'x' })
      })
    })

    describe('metadata, upserts, listings', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('writeSpace is an upsert; listSpaces sorts by id', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-b')
        await provisionSpace(backend, 'space-a')
        await backend.writeSpace({
          spaceId: 'space-b',
          spaceMetadata: {
            id: 'space-b',
            type: ['Space'],
            name: 'Renamed',
            controller: CONTROLLER
          }
        })
        const spaces = await backend.listSpaces()
        assert.deepEqual(
          spaces.map(space => space.id),
          ['space-a', 'space-b']
        )
        assert.equal(
          (await backend.getSpaceMetadata({ spaceId: 'space-b' }))?.name,
          'Renamed'
        )
      })

      it('writeCollection upserts; listCollections sorts by id (code-unit order)', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId: 'space-a',
          collectionId: 'zeta',
          collectionMetadata: { id: 'zeta', type: ['Collection'], name: 'Z' }
        })
        const listing = await backend.listCollections({
          spaceId: 'space-a'
        })
        assert.deepEqual(
          listing.items.map(collection => collection.id),
          ['col', 'zeta']
        )
        assert.equal(listing.totalItems, 2)
        assert.equal((listing.items[1] as CollectionSummary).name, 'Z')
        // A short listing that fits in one page advertises no continuation link.
        assert.equal(listing.next, undefined)
      })

      it('listCollections surfaces each Collection `public` flag inline', async () => {
        const { backend } = harness
        const spaceId = 'space-public'
        // Three Collections: one with a `PublicCanRead` policy (public: true),
        // one with no policy at all (public: false), and one with an
        // unrecognized policy type (public: false, fail-closed).
        await provisionSpace(backend, spaceId, 'open')
        await backend.writeCollection({
          spaceId,
          collectionId: 'closed',
          collectionMetadata: { id: 'closed', type: ['Collection'] }
        })
        await backend.writeCollection({
          spaceId,
          collectionId: 'other',
          collectionMetadata: { id: 'other', type: ['Collection'] }
        })
        await backend.writePolicy({
          spaceId,
          collectionId: 'open',
          policy: { type: 'PublicCanRead' }
        })
        await backend.writePolicy({
          spaceId,
          collectionId: 'other',
          policy: { type: 'SomeUnrecognizedPolicy' }
        })
        const listing = await backend.listCollections({ spaceId })
        const publicById = new Map(
          listing.items.map(collection => [
            collection.id,
            (collection as CollectionSummary).public
          ])
        )
        // `false` is expressed on every item, not omitted.
        assert.equal(publicById.get('open'), true)
        assert.equal(publicById.get('closed'), false)
        assert.equal(publicById.get('other'), false)
      })

      it('deleteSpace removes the Space and its contents', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-gone')
        await backend.writeResource({
          spaceId: 'space-gone',
          collectionId: 'col',
          resourceId: 'r1',
          input: jsonInput({ hello: 'world' })
        })
        await backend.deleteSpace({ spaceId: 'space-gone' })
        assert.equal(
          await backend.getSpaceMetadata({ spaceId: 'space-gone' }),
          undefined
        )
        assert.equal(
          await backend.getResourceMetadata({
            spaceId: 'space-gone',
            collectionId: 'col',
            resourceId: 'r1'
          }),
          undefined
        )
      })
    })

    describe('resource round-trips and representation swap', () => {
      let harness: BackendHarness
      const spaceId = 'space-res'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('round-trips a JSON document byte-for-byte', async () => {
        const { backend } = harness
        const data = { a: 1, nested: { b: [1, 2, 3] } }
        const { validator: written } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'doc',
          input: jsonInput(data)
        })
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'doc'
        })
        assert.equal(result.storedResourceType, 'application/json')
        assert.equal(etagOf(result), formatEtag(written))
        assert.equal(
          await streamToString(result.resourceStream),
          JSON.stringify(data)
        )
      })

      it('round-trips a bare JSON primitive', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'primitive',
          input: jsonInput(null)
        })
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'primitive'
        })
        assert.equal(await streamToString(result.resourceStream), 'null')
      })

      it('round-trips a binary blob', async () => {
        const { backend } = harness
        const bytes = Buffer.from([0, 1, 2, 250, 251, 252])
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'blob',
          input: binaryInput(bytes)
        })
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'blob'
        })
        assert.equal(result.storedResourceType, 'application/octet-stream')
        const chunks: Buffer[] = []
        for await (const chunk of result.resourceStream) {
          chunks.push(Buffer.from(chunk))
        }
        assert.deepEqual(Buffer.concat(chunks), bytes)
      })

      it('a write under a new content-type replaces the single representation', async () => {
        const { backend } = harness
        const { validator: firstWrite } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap',
          input: jsonInput({ pws: 'json' })
        })
        const { validator: secondWrite } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap',
          input: binaryInput(Buffer.from('now text'), {
            contentType: 'text/plain'
          })
        })
        assertValidatorAdvanced(firstWrite, secondWrite)
        const result = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap'
        })
        assert.equal(result.storedResourceType, 'text/plain')
        assert.equal(etagOf(result), formatEtag(secondWrite))
        assert.equal(await streamToString(result.resourceStream), 'now text')
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'swap'
        })
        assert.equal(metadata?.contentType, 'text/plain')
      })

      it('getResourceMetadata reports contentType, size, timestamps, write stamp', async () => {
        const { backend } = harness
        const data = { size: 'check' }
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'meta-check',
          input: jsonInput(data)
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'meta-check'
        })
        assert.ok(metadata)
        assert.equal(metadata.contentType, 'application/json')
        assert.equal(metadata.size, Buffer.byteLength(JSON.stringify(data)))
        assert.ok(metadata.createdAt)
        assert.ok(metadata.updatedAt)
        assert.equal(typeof metadata.updatedAtCounter, 'number')
        assert.ok(metadata.originId)
        assert.equal(metadata.meta, undefined)
        assert.equal(metadata.custom, undefined)
      })

      it('getResourceContentStamp reads a tombstone that getResourceMetadata reads as absent', async () => {
        const { backend } = harness
        const target = {
          spaceId,
          collectionId: 'col',
          resourceId: 'stamp-check'
        }
        assert.equal(await backend.getResourceContentStamp(target), undefined)
        await backend.writeResource({ ...target, input: jsonInput({ a: 1 }) })
        const live = await backend.getResourceMetadata(target)
        assert.deepEqual(await backend.getResourceContentStamp(target), {
          stamp: {
            updatedAt: live?.updatedAt,
            updatedAtCounter: live?.updatedAtCounter,
            originId: live?.originId
          },
          deleted: false
        })
        await backend.deleteResource(target)
        assert.equal(await backend.getResourceMetadata(target), undefined)
        const tombstone = await backend.getResourceContentStamp(target)
        assert.equal(tombstone?.deleted, true)
        assert.equal(tombstone?.stamp.originId, live?.originId)
        assert.ok(
          String(tombstone?.stamp.updatedAt) >= String(live?.updatedAt),
          'the tombstone stamp sorts at or after the live one'
        )
      })
    })

    describe('content / metadata stamp independence', () => {
      let harness: BackendHarness
      const spaceId = 'space-ver'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('content writes move the content stamp; metadata writes move only the meta stamp', async () => {
        const { backend } = harness
        const { validator: content1 } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({ v: 1 })
        })
        const meta1 = (
          await backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'r',
            custom: { name: 'First' }
          })
        )?.validator
        assert.ok(meta1)
        // The metadata write left the content record's validator alone.
        const afterMeta1 = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r'
        })
        assert.equal(etagOf(afterMeta1), formatEtag(content1))

        const { validator: content2 } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({ v: 2 })
        })
        assertValidatorAdvanced(content1, content2)

        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'r'
        })
        // The content write preserved `custom` and the independent meta stamp.
        assert.equal(etagOf({ ...metadata!.meta }), formatEtag(meta1))
        assert.equal(metadata!.updatedAt, content2.stamp.updatedAt)
        assert.deepEqual(metadata?.custom, { name: 'First' })

        const meta2 = (
          await backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'r',
            custom: { name: 'Second' }
          })
        )?.validator
        assertValidatorAdvanced(meta1, meta2!)
        const after = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r'
        })
        // The metadata write did not move the content validator.
        assert.equal(etagOf(after), formatEtag(content2))
      })

      it('writeResourceMetadata resolves undefined for an absent Resource (no create)', async () => {
        assert.equal(
          await harness.backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'absent',
            custom: { name: 'x' }
          }),
          undefined
        )
      })

      it('an empty custom object clears the stored custom', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'clearable',
          input: jsonInput({})
        })
        const tempWrite = (
          await backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'clearable',
            custom: { name: 'temp' }
          })
        )?.validator
        const clearWrite = (
          await backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'clearable',
            custom: {}
          })
        )?.validator
        assertValidatorAdvanced(tempWrite!, clearWrite!)
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'clearable'
        })
        assert.equal(metadata?.custom, undefined)
        // The clearing write still moved the meta stamp.
        assert.equal(etagOf({ ...metadata!.meta }), formatEtag(clearWrite!))
      })

      it('a /meta write leaves the content stamp and ETag byte-equal under a stepped clock', async () => {
        // Its own backend under a controlled clock. The first /meta write
        // lands a second after the content write, so a content re-stamp would
        // show in `updatedAt`. The two /meta writes share one millisecond, so
        // only the counter tells them apart.
        const clock = frozenClock()
        const stepped = await makeBackend({ physicalClock: clock.read })
        try {
          const { backend } = stepped
          await provisionSpace(backend, spaceId)
          const target = { spaceId, collectionId: 'col', resourceId: 'stamped' }
          const { validator: content } = await backend.writeResource({
            ...target,
            input: jsonInput({ v: 1 })
          })
          const before = await backend.getResourceMetadata(target)
          assert.ok(before)
          assert.equal(before.meta, undefined, 'no /meta record yet')
          assert.equal(Date.parse(before.updatedAt!), clock.now)
          const contentEtag = etagOf(await backend.getResource(target))
          assert.equal(contentEtag, formatEtag(content))

          clock.now += 1000
          const meta1 = (
            await backend.writeResourceMetadata({
              ...target,
              custom: { name: 'First' }
            })
          )?.validator
          assert.ok(meta1)
          assert.equal(Date.parse(meta1.stamp.updatedAt), clock.now)
          const afterMeta1 = await backend.getResourceMetadata(target)
          assert.ok(afterMeta1)
          // The content record's stamp and generation are untouched.
          assert.deepEqual(stampOf(afterMeta1), stampOf(before))
          assert.equal(afterMeta1.generation, before.generation)
          assert.equal(etagOf(await backend.getResource(target)), contentEtag)
          // The nested /meta record carries the stamp this write minted.
          assert.deepEqual(afterMeta1.meta, {
            generation: meta1.generation,
            ...meta1.stamp
          })
          assert.equal(etagOf({ ...afterMeta1.meta }), formatEtag(meta1))

          const meta2 = (
            await backend.writeResourceMetadata({
              ...target,
              custom: { name: 'Second' }
            })
          )?.validator
          assert.ok(meta2)
          assert.equal(meta2.generation, meta1.generation)
          assert.equal(meta2.stamp.updatedAt, meta1.stamp.updatedAt)
          assert.equal(
            meta2.stamp.updatedAtCounter,
            meta1.stamp.updatedAtCounter + 1
          )
          assert.notEqual(formatEtag(meta2), formatEtag(meta1))
          const afterMeta2 = await backend.getResourceMetadata(target)
          assert.ok(afterMeta2)
          assert.deepEqual(stampOf(afterMeta2), stampOf(before))
          assert.equal(afterMeta2.generation, before.generation)
          assert.equal(etagOf(await backend.getResource(target)), contentEtag)
          assert.deepEqual(afterMeta2.meta, {
            generation: meta2.generation,
            ...meta2.stamp
          })
        } finally {
          await stepped.cleanup()
        }
      })
    })

    describe('Collection Metadata', () => {
      let harness: BackendHarness
      const spaceId = 'space-collection-meta'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /** The configuration members of a fresh Collection, by id. */
      function baseMetadata(collectionId: string): CollectionMetadata {
        return { id: collectionId, type: ['Collection'], name: collectionId }
      }

      /** Creates a fresh Collection in this suite's Space and returns its id. */
      async function freshCollection(createdBy?: IDID): Promise<string> {
        const collectionId = `col-${crypto.randomUUID()}`
        await harness.backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: baseMetadata(collectionId),
          ...(createdBy !== undefined && { createdBy })
        })
        return collectionId
      }

      it('is one object: a configuration write and an annotation write bump the same ETag', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()

        // The creating write stamps the one object; the merged read
        // carries the configuration members, the timestamps, and no `custom`.
        const created = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.ok(
          created,
          'an existing Collection resolves its Metadata object'
        )
        assert.equal(created.metaLocal, 0)
        assert.equal(typeof created.updatedAtCounter, 'number')
        assert.ok(created.originId)
        assert.equal(created.name, collectionId)
        assert.equal(created.custom, undefined)
        assert.ok(!Number.isNaN(Date.parse(created.createdAt!)))
        assert.ok(!Number.isNaN(Date.parse(created.updatedAt!)))

        // An annotation write (custom only) bumps the same validator.
        const { validator: annotated } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'First', tags: { a: 'b' } }
          }
        })
        assertEtagAdvanced({
          before: metadataEtagOf(created),
          after: formatEtag(annotated),
          container: true
        })
        assert.equal(annotated.generation, created.metaGeneration)
        const stored = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.deepEqual(stored?.custom, { name: 'First', tags: { a: 'b' } })
        assert.equal(metadataEtagOf(stored), formatEtag(annotated))
        assert.equal(stored?.name, collectionId)

        // A configuration write (rename) bumps it again, carrying `custom`.
        const { validator: renamed } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            name: 'Renamed',
            custom: { name: 'First', tags: { a: 'b' } }
          }
        })
        assertValidatorAdvanced(annotated, renamed)
        assert.equal(renamed.generation, created.metaGeneration)
        const reread = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(reread?.name, 'Renamed')
        assert.deepEqual(reread?.custom, { name: 'First', tags: { a: 'b' } })
        assert.equal(metadataEtagOf(reread), formatEtag(renamed))

        // A full replacement: the tags of the earlier write are gone.
        const { validator: replacement } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'Second' }
          }
        })
        const replaced = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.deepEqual(replaced?.custom, { name: 'Second' })
        assertValidatorAdvanced(renamed, replacement)
        assert.equal(metadataEtagOf(replaced), formatEtag(replacement))
      })

      it('an absent or empty custom clears the stored custom', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const { validator: tempWrite } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'temp' }
          }
        })
        // An empty object clears it (and still moves the stamp)...
        const { validator: clearWrite } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: { ...baseMetadata(collectionId), custom: {} }
        })
        assertValidatorAdvanced(tempWrite, clearWrite)
        const cleared = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(cleared?.custom, undefined)
        assert.ok(!('custom' in cleared!))
        assert.equal(metadataEtagOf(cleared), formatEtag(clearWrite))

        // ...and so does omitting it: the write is a full replacement.
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'again' }
          }
        })
        const { validator: omitWrite } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: baseMetadata(collectionId)
        })
        const omitted = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(omitted?.custom, undefined)
        assert.equal(metadataEtagOf(omitted), formatEtag(omitWrite))
      })

      it('a null custom clears the stored custom rather than faulting', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const { validator: tempWrite } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'temp' }
          }
        })
        // `null` is not reachable over HTTP, but `StorageBackend` is a
        // published interface: a `custom` that is not a non-empty object
        // clears the stored one on every backend, rather than faulting on one
        // and succeeding on another.
        const { validator: cleared } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: null as unknown as CollectionMetadata['custom']
          }
        })
        assertValidatorAdvanced(tempWrite, cleared)
        const stored = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(stored?.custom, undefined)
        assert.ok(!('custom' in stored!))
      })

      it('a later write does not backfill createdAt onto a Collection stored without one', async () => {
        // A pre-v0.5 archive carries no `.collection.meta.<id>.json`, so the import
        // plan falls back to `{ id, type, name }` and the Collection lands
        // with no `createdAt` at all. A later write must not stamp its own
        // clock as the creation time -- that would date the container later
        // than the contents it already holds -- so an absent `createdAt` is
        // preserved as absent, on the same terms as `createdBy`.
        const legacy = await makeBackend()
        try {
          const { backend } = legacy
          const legacySpaceId = 'space-legacy-created-at'
          const legacyCollectionId = 'legacy'
          await provisionSpace(backend, legacySpaceId)

          const pack = tar.pack()
          pack.entry(
            { name: 'manifest.yml' },
            'ubc-version: "0.1"\ncontents:\n  space: https://example/spec#spaces\n'
          )
          pack.entry({
            name: `space/${legacySpaceId}/${legacyCollectionId}/`,
            type: 'directory'
          })
          pack.finalize()
          await importArchive({
            backend: backend,
            spaceId: legacySpaceId,
            tarStream: Readable.from(pack)
          })

          const imported = await backend.getCollectionMetadata({
            spaceId: legacySpaceId,
            collectionId: legacyCollectionId
          })
          assert.ok(imported, 'the archive created the Collection')
          assert.equal(imported.createdAt, undefined)

          await backend.writeCollection({
            spaceId: legacySpaceId,
            collectionId: legacyCollectionId,
            collectionMetadata: {
              id: legacyCollectionId,
              type: ['Collection'],
              name: 'Renamed'
            }
          })
          const updated = await backend.getCollectionMetadata({
            spaceId: legacySpaceId,
            collectionId: legacyCollectionId
          })
          assert.equal(updated?.name, 'Renamed')
          assert.equal(updated?.createdAt, undefined)
          assert.ok(!('createdAt' in updated!))
          assert.ok(!Number.isNaN(Date.parse(updated!.updatedAt!)))
        } finally {
          await legacy.cleanup()
        }
      })

      it('resolves undefined for a Collection that does not exist', async () => {
        const { backend } = harness
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'absent'
          }),
          undefined
        )
      })

      it('If-None-Match: * fails once the Collection exists; If-Match compare-and-swaps on the one ETag', async () => {
        const { backend } = harness
        const collectionId = `col-${crypto.randomUUID()}`

        // `If-None-Match: *` creates the Collection once...
        const { validator: created } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: baseMetadata(collectionId),
          ifNoneMatch: '*'
        })
        assert.equal(created.local, 0)
        // ...and refuses against the existing Collection, for an annotation
        // write as much as for a configuration one: there is no separate
        // "metadata never written" state.
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId,
            collectionMetadata: {
              ...baseMetadata(collectionId),
              custom: { name: 'Again' }
            },
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)

        // A stale `If-Match` is rejected; the matching one succeeds.
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId,
            collectionMetadata: {
              ...baseMetadata(collectionId),
              custom: { name: 'Stale' }
            },
            ifMatch: etagWithCounterBumped({ validator: created, by: 99 })
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const { validator: fresh } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'Fresh' }
          },
          ifMatch: formatEtag(created)
        })
        assertValidatorAdvanced(created, fresh)
        assert.equal(
          fresh.generation,
          created.generation,
          'the generation is kept across writes'
        )
        // The annotation write moved the ETag, so its predecessor is stale for
        // a configuration write too.
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId,
            collectionMetadata: { ...baseMetadata(collectionId), name: 'X' },
            ifMatch: formatEtag(created)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('stamps createdAt on create and preserves it; updatedAt tracks each write', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const created = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.ok(created?.createdAt)
        assert.ok(created?.updatedAt)

        await new Promise(resolve => setTimeout(resolve, 5))
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            // A client-supplied timestamp is ignored: both are server-managed.
            createdAt: '2000-01-01T00:00:00.000Z',
            updatedAt: '2000-01-01T00:00:00.000Z',
            custom: { name: 'Later' }
          }
        })
        const after = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(after?.createdAt, created.createdAt)
        assert.ok(
          Date.parse(after!.updatedAt!) > Date.parse(created.updatedAt!),
          'updatedAt advanced with the write'
        )
      })

      it('an omitted epoch CLEARS the stored stamp', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'Stamped' },
            epoch: 'epoch-1'
          }
        })
        assert.equal(
          (await backend.getCollectionMetadata({ spaceId, collectionId }))
            ?.epoch,
          'epoch-1'
        )
        // Unlike `writeResourceMetadata` (which preserves the content stamp), a
        // Collection Metadata write with no epoch clears it: it replaces the
        // very `custom` envelope the stamp described.
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'Restamped' }
          }
        })
        const restamped = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(restamped?.epoch, undefined)
        assert.ok(!('epoch' in restamped!))
      })

      it('surfaces createdBy but never lets a write set it', async () => {
        const { backend } = harness
        const collectionId = await freshCollection(CREATOR_ONE)
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            // A forged top-level `createdBy` is dropped; one inside `custom`
            // stays inside `custom`. The server-managed one is preserved.
            createdBy: CREATOR_TWO,
            custom: { createdBy: CREATOR_TWO } as never
          },
          createdBy: CREATOR_TWO
        })
        const metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
      })

      it('deleting the Collection removes its metadata', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            ...baseMetadata(collectionId),
            custom: { name: 'Doomed' }
          }
        })
        await backend.deleteCollection({ spaceId, collectionId })
        assert.equal(
          await backend.getCollectionMetadata({ spaceId, collectionId }),
          undefined
        )
        // A Collection re-created under the same id starts a fresh life: no
        // annotations, a fresh generation.
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: baseMetadata(collectionId)
        })
        const revived = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(revived?.metaLocal, 0)
        assert.equal(revived?.custom, undefined)
      })

      it('a Collection re-created under the same id gets a new metaGeneration', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const before = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        await backend.deleteCollection({ spaceId, collectionId })
        // A Collection delete leaves a tombstone, and a create over it starts
        // under a FRESH generation, so the old validator matches nothing.
        const { validator: recreated } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: collectionId
          }
        })
        assert.notEqual(recreated.generation, before?.metaGeneration)
        // The pre-delete validator can no longer satisfy an If-Match.
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId,
            collectionMetadata: {
              id: collectionId,
              type: ['Collection'],
              name: 'Clobber'
            },
            ifMatch: metadataEtagOf(before)!
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })
    })

    describe('Collection tombstones', () => {
      let harness: BackendHarness
      const spaceId = 'space-tombstones'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId, 'keep')
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /**
       * Creates a Collection holding one Resource, deletes it, and returns
       * the live validator it had and the tombstone listing item.
       */
      async function deletedCollection(createdBy?: IDID) {
        const { backend } = harness
        const collectionId = `gone-${crypto.randomUUID()}`
        const { validator: live } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'Doomed',
            custom: { name: 'Doomed' }
          },
          ...(createdBy !== undefined && { createdBy })
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: jsonInput({ life: 'old' })
        })
        await backend.writePolicy({
          spaceId,
          collectionId,
          policy: { type: 'PublicCanRead' }
        })
        assert.equal(
          await backend.deleteCollection({ spaceId, collectionId }),
          'deleted'
        )
        const listing = await backend.listCollections({
          spaceId,
          includeDeleted: true,
          limit: 1000
        })
        const tombstone = listing.items.find(item => item.id === collectionId)
        assert.ok(tombstone && isCollectionTombstoneSummary(tombstone))
        return { collectionId, live, tombstone }
      }

      it('a deleted Collection reads as absent and its members are gone', async () => {
        const { backend } = harness
        const { collectionId } = await deletedCollection()
        assert.equal(
          await backend.getCollectionMetadata({ spaceId, collectionId }),
          undefined
        )
        assert.equal(
          await backend.getResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc'
          }),
          undefined
        )
        assert.equal(
          await backend.getPolicy({ spaceId, collectionId }),
          undefined
        )
        // A second delete finds no live Collection and writes nothing.
        assert.equal(
          await backend.deleteCollection({ spaceId, collectionId }),
          'already-deleted'
        )
        // A write into the tombstoned Collection is refused, as into an
        // absent one.
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'late',
            input: jsonInput({ late: true })
          })
        ).rejects.toBeInstanceOf(CollectionNotFoundError)
      })

      it('the default listing leaves a tombstone out; includeDeleted lists it with its stamp', async () => {
        const { backend } = harness
        const before = await backend.listCollections({ spaceId, limit: 1000 })
        const { collectionId, live, tombstone } = await deletedCollection()
        const after = await backend.listCollections({ spaceId, limit: 1000 })
        assert.equal(after.totalItems, before.totalItems)
        assert.ok(after.items.every(item => item.id !== collectionId))
        assert.ok(
          after.items.every(item => !isCollectionTombstoneSummary(item))
        )

        assert.deepEqual(Object.keys(tombstone).sort(), [
          'deleted',
          'id',
          'originId',
          'updatedAt',
          'updatedAtCounter',
          'url'
        ])
        assert.equal(tombstone.url, `/space/${spaceId}/${collectionId}/`)
        assert.equal(tombstone.originId, backend.originId)
        // The delete's stamp sorts above the live record's last write.
        assert.ok(compareStamps(tombstone, live.stamp) > 0)

        const withDeleted = await backend.listCollections({
          spaceId,
          includeDeleted: true,
          limit: 1000
        })
        assert.equal(withDeleted.totalItems, withDeleted.items.length)
        assert.equal(
          withDeleted.totalItems,
          after.totalItems +
            withDeleted.items.filter(isCollectionTombstoneSummary).length
        )
      })

      it('includeDeleted pages in id order and carries the flag on next', async () => {
        const { backend } = harness
        const pagedSpace = 'space-tombstone-pages'
        await provisionSpace(backend, pagedSpace, 'a')
        for (const collectionId of ['b', 'c', 'd']) {
          await backend.writeCollection({
            spaceId: pagedSpace,
            collectionId,
            collectionMetadata: { id: collectionId, type: ['Collection'] }
          })
        }
        await backend.deleteCollection({
          spaceId: pagedSpace,
          collectionId: 'b'
        })
        await backend.deleteCollection({
          spaceId: pagedSpace,
          collectionId: 'd'
        })

        const first = await backend.listCollections({
          spaceId: pagedSpace,
          includeDeleted: true,
          limit: 2
        })
        assert.deepEqual(
          first.items.map(item => item.id),
          ['a', 'b']
        )
        assert.equal(first.totalItems, 4)
        assert.ok(first.next?.includes('include=deleted'))
        const cursor = new URL(
          first.next!,
          'https://x.example'
        ).searchParams.get('cursor')!
        const second = await backend.listCollections({
          spaceId: pagedSpace,
          includeDeleted: true,
          limit: 2,
          cursor
        })
        assert.deepEqual(
          second.items.map(item => [
            item.id,
            isCollectionTombstoneSummary(item)
          ]),
          [
            ['c', false],
            ['d', true]
          ]
        )
        assert.equal(second.next, undefined)

        const plain = await backend.listCollections({
          spaceId: pagedSpace,
          limit: 1
        })
        assert.equal(plain.totalItems, 2)
        assert.ok(plain.next && !plain.next.includes('include='))
      })

      it('a re-create over a tombstone starts a new life above the delete', async () => {
        const { backend } = harness
        const { collectionId, live, tombstone } =
          await deletedCollection(CREATOR_ONE)
        // The old life's ETag cannot pass If-Match against the tombstone.
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId,
            collectionMetadata: { id: collectionId, type: ['Collection'] },
            ifMatch: formatEtag(live)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // The guarded create succeeds over the tombstone.
        const { validator: recreated } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: { id: collectionId, type: ['Collection'] },
          createdBy: CREATOR_TWO,
          ifNoneMatch: '*'
        })
        assert.notEqual(recreated.generation, live.generation)
        assert.ok(compareStamps(recreated.stamp, tombstone) > 0)
        const stored = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(stored?.createdBy, CREATOR_TWO)
        assert.equal(stored?.createdAt, recreated.stamp.updatedAt)
        assert.equal(stored?.custom, undefined)
        // The old life's Resource does not come back.
        assert.equal(
          await backend.getResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc'
          }),
          undefined
        )
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId,
            collectionMetadata: { id: collectionId, type: ['Collection'] },
            ifMatch: formatEtag(live)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // Live again: the default listing names it, includeDeleted no longer
        // lists a tombstone for it.
        const listing = await backend.listCollections({
          spaceId,
          includeDeleted: true,
          limit: 1000
        })
        const item = listing.items.find(entry => entry.id === collectionId)
        assert.ok(item && !isCollectionTombstoneSummary(item))
      })

      it('a re-created Collection starts a fresh changes feed', async () => {
        const { backend } = harness
        if (!backend.changesSince) {
          return
        }
        const collectionId = `feed-${crypto.randomUUID()}`
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: { id: collectionId, type: ['Collection'] }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: jsonInput({ life: 'old' })
        })
        const old = await backend.changesSince({
          spaceId,
          collectionId,
          limit: 10
        })
        await backend.deleteCollection({ spaceId, collectionId })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: { id: collectionId, type: ['Collection'] }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'fresh',
          input: jsonInput({ life: 'new' })
        })
        const fresh = await backend.changesSince({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.ok(old.feedGeneration)
        assert.notEqual(fresh.feedGeneration, old.feedGeneration)
        assert.deepEqual(
          fresh.documents.map(doc => [
            doc.kind === 'resource' ? doc.resourceId : doc.kind,
            doc.feedPosition
          ]),
          [
            ['collection-metadata', 1],
            ['fresh', 2]
          ]
        )
      })

      it('a tombstone does not count against the Collection quota', async () => {
        const quotaHarness = await makeBackend({ maxCollectionsPerSpace: 2 })
        try {
          const { backend } = quotaHarness
          await provisionSpace(backend, 'space-quota', 'one')
          await backend.writeCollection({
            spaceId: 'space-quota',
            collectionId: 'two',
            collectionMetadata: { id: 'two', type: ['Collection'] }
          })
          await backend.deleteCollection({
            spaceId: 'space-quota',
            collectionId: 'two'
          })
          // One live Collection and one tombstone: a second live one fits.
          await backend.writeCollection({
            spaceId: 'space-quota',
            collectionId: 'three',
            collectionMetadata: { id: 'three', type: ['Collection'] }
          })
          // Two live ones: a re-create over the tombstone is a create, and
          // the cap refuses it.
          await expect(
            backend.writeCollection({
              spaceId: 'space-quota',
              collectionId: 'two',
              collectionMetadata: { id: 'two', type: ['Collection'] }
            })
          ).rejects.toBeInstanceOf(CountQuotaExceededError)
          const usage = await backend.reportUsage({
            spaceId: 'space-quota',
            includeCollections: true
          })
          assert.ok(
            (usage.usageByCollection ?? []).every(entry => entry.id !== 'two')
          )
        } finally {
          await quotaHarness.cleanup()
        }
      })

      it('Delete Space removes the Space tombstones with it', async () => {
        const { backend } = harness
        const doomedSpace = 'space-tombstone-doomed'
        await provisionSpace(backend, doomedSpace, 'gone')
        await backend.deleteCollection({
          spaceId: doomedSpace,
          collectionId: 'gone'
        })
        await backend.deleteSpace({ spaceId: doomedSpace })
        await provisionSpace(backend, doomedSpace, 'other')
        const listing = await backend.listCollections({
          spaceId: doomedSpace,
          includeDeleted: true
        })
        assert.deepEqual(
          listing.items.map(item => item.id),
          ['other']
        )
      })

      it('export carries a tombstone in the Space directory, flagged on the manifest', async () => {
        const { backend } = harness
        const exportSpace = 'space-tombstone-export'
        await provisionSpace(backend, exportSpace, 'live')
        await backend.writeCollection({
          spaceId: exportSpace,
          collectionId: 'dead',
          collectionMetadata: { id: 'dead', type: ['Collection'] }
        })
        await backend.writeResource({
          spaceId: exportSpace,
          collectionId: 'dead',
          resourceId: 'doc',
          input: jsonInput({ life: 'old' })
        })
        const generation = (await backend.getCollectionMetadata({
          spaceId: exportSpace,
          collectionId: 'dead'
        }))!.metaGeneration
        await backend.deleteCollection({
          spaceId: exportSpace,
          collectionId: 'dead'
        })
        const archive = await readSpaceArchive(
          await collectBytes(
            await backend.exportSpace({ spaceId: exportSpace })
          )
        )
        const names: string[] = []
        const files = new Map<string, Uint8Array>()
        for await (const entry of archive.entries) {
          names.push(entry.name)
          if (entry.type === 'file') {
            files.set(entry.name, await entry.bytes())
          }
        }
        const tombstonePath = `space/${exportSpace}/.collection.meta.dead.json`
        assert.ok(files.has(tombstonePath))
        assert.ok(
          names.every(name => !name.startsWith(`space/${exportSpace}/dead/`))
        )
        assert.ok(names.every(name => name !== `space/${exportSpace}/dead`))
        const body = JSON.parse(
          Buffer.from(files.get(tombstonePath)!).toString('utf8')
        )
        assert.equal(body.deleted, true)
        assert.equal(body._generation, generation)
        assert.equal(body._local, undefined)
        assert.equal(typeof body.updatedAt, 'string')
        assert.equal(typeof body.updatedAtCounter, 'number')
        assert.equal(body.originId, backend.originId)
        assert.equal(body.name, undefined)
        assert.ok(
          JSON.stringify(archive.manifest.contents).includes('"deleted":true')
        )
      })

      it('import writes a tombstone only where the destination holds no record', async () => {
        const { backend } = harness
        const source = 'space-tombstone-source'
        await provisionSpace(backend, source, 'kept')
        for (const collectionId of [
          'absent-there',
          'live-there',
          'dead-there'
        ]) {
          await backend.writeCollection({
            spaceId: source,
            collectionId,
            collectionMetadata: { id: collectionId, type: ['Collection'] }
          })
          await backend.deleteCollection({ spaceId: source, collectionId })
        }
        const sourceListing = await backend.listCollections({
          spaceId: source,
          includeDeleted: true
        })
        assert.equal(sourceListing.items.length, 4)
        const archiveBytes = await collectBytes(
          await backend.exportSpace({ spaceId: source })
        )

        const destination = 'space-tombstone-destination'
        await provisionSpace(backend, destination, 'live-there')
        await backend.writeCollection({
          spaceId: destination,
          collectionId: 'dead-there',
          collectionMetadata: { id: 'dead-there', type: ['Collection'] }
        })
        await backend.deleteCollection({
          spaceId: destination,
          collectionId: 'dead-there'
        })
        const heldTombstone = (
          await backend.listCollections({
            spaceId: destination,
            includeDeleted: true
          })
        ).items.find(item => item.id === 'dead-there')
        const liveBefore = await backend.getCollectionMetadata({
          spaceId: destination,
          collectionId: 'live-there'
        })

        await importArchive({
          backend,
          spaceId: destination,
          tarStream: Readable.from([archiveBytes])
        })

        const listing = await backend.listCollections({
          spaceId: destination,
          includeDeleted: true
        })
        const byId = new Map(listing.items.map(item => [item.id, item]))
        // Absent at the destination: the tombstone is written, re-stamped by
        // this store's clock.
        const written = byId.get('absent-there')
        assert.ok(written && isCollectionTombstoneSummary(written))
        assert.equal(written.originId, backend.originId)
        // A live destination Collection is left as it was.
        assert.deepEqual(
          await backend.getCollectionMetadata({
            spaceId: destination,
            collectionId: 'live-there'
          }),
          liveBefore
        )
        // A held tombstone is left as it was.
        assert.deepEqual(byId.get('dead-there'), heldTombstone)
        // The imported tombstone reads as absent.
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId: destination,
            collectionId: 'absent-there'
          }),
          undefined
        )
      })

      it('import of a live archived Collection over a tombstone starts a new life', async () => {
        const { backend } = harness
        const source = 'space-tombstone-revive-source'
        await provisionSpace(backend, source, 'revived')
        await backend.writeResource({
          spaceId: source,
          collectionId: 'revived',
          resourceId: 'archived',
          input: jsonInput({ life: 'archived' })
        })
        const archiveBytes = await collectBytes(
          await backend.exportSpace({ spaceId: source })
        )

        const destination = 'space-tombstone-revive-destination'
        await provisionSpace(backend, destination, 'unrelated')
        await backend.writeCollection({
          spaceId: destination,
          collectionId: 'revived',
          collectionMetadata: { id: 'revived', type: ['Collection'] }
        })
        await backend.writeResource({
          spaceId: destination,
          collectionId: 'revived',
          resourceId: 'old',
          input: jsonInput({ life: 'old' })
        })
        await backend.deleteCollection({
          spaceId: destination,
          collectionId: 'revived'
        })
        const tombstone = (
          await backend.listCollections({
            spaceId: destination,
            includeDeleted: true
          })
        ).items.find(item => item.id === 'revived')
        assert.ok(tombstone && isCollectionTombstoneSummary(tombstone))

        const stats = await importArchive({
          backend,
          spaceId: destination,
          tarStream: Readable.from([archiveBytes])
        })
        assert.equal(stats.collectionsCreated, 1)
        const revived = await backend.getCollectionMetadata({
          spaceId: destination,
          collectionId: 'revived'
        })
        assert.ok(revived)
        assert.ok(compareStamps(stampOf(revived) as WriteStamp, tombstone) > 0)
        assert.equal(
          await backend.getResourceMetadata({
            spaceId: destination,
            collectionId: 'revived',
            resourceId: 'old'
          }),
          undefined
        )
        assert.ok(
          await backend.getResourceMetadata({
            spaceId: destination,
            collectionId: 'revived',
            resourceId: 'archived'
          })
        )
      })

      it('import refuses a tombstone body inside a Collection directory', async () => {
        const { backend } = harness
        const destination = 'space-tombstone-dirform'
        await provisionSpace(backend, destination, 'present')
        const pack = tar.pack()
        pack.entry(
          { name: 'manifest.yml' },
          'ubc-version: "0.1"\ncontents:\n  space:\n    url: x\n'
        )
        pack.entry(
          { name: 'space/src/bad/.collection.meta.bad.json' },
          JSON.stringify({
            deleted: true,
            updatedAt: '2026-10-03T00:00:00.000Z',
            updatedAtCounter: 0,
            originId: 'origin'
          })
        )
        pack.entry(
          { name: 'space/src/bad/r.doc.application%2Fjson.json' },
          '{}'
        )
        pack.finalize()
        const refusal = await importArchive({
          backend,
          spaceId: destination,
          tarStream: Readable.from(pack)
        }).catch((err: unknown) => err)
        assert.ok(refusal instanceof InvalidImportError)
        assert.match(refusal.detail ?? '', /holds a tombstone/)
        const listing = await backend.listCollections({
          spaceId: destination,
          includeDeleted: true
        })
        assert.deepEqual(
          listing.items.map(item => item.id),
          ['present']
        )
      })

      it('import keeps the archived generation of a tombstone', async () => {
        const { backend } = harness
        const source = 'space-tombstone-generation'
        await provisionSpace(backend, source, 'gen')
        const generation = (await backend.getCollectionMetadata({
          spaceId: source,
          collectionId: 'gen'
        }))!.metaGeneration
        await backend.deleteCollection({ spaceId: source, collectionId: 'gen' })
        const archiveBytes = await collectBytes(
          await backend.exportSpace({ spaceId: source })
        )
        const destination = 'space-tombstone-generation-copy'
        await provisionSpace(backend, destination, 'unrelated')
        await importArchive({
          backend,
          spaceId: destination,
          tarStream: Readable.from([archiveBytes])
        })
        const exported = await readSpaceArchive(
          await collectBytes(
            await backend.exportSpace({ spaceId: destination })
          )
        )
        let body: Record<string, unknown> | undefined
        for await (const entry of exported.entries) {
          if (entry.name === `space/${destination}/.collection.meta.gen.json`) {
            body = JSON.parse(
              Buffer.from(await entry.bytes()).toString('utf8')
            ) as Record<string, unknown>
          }
        }
        assert.equal(body?._generation, generation)
      })
    })

    describe('import validates what it installs', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      const manifest = 'ubc-version: "0.1"\ncontents:\n  space:\n    url: x\n'
      const edvLog = JSON.stringify({
        body: '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n',
        generation: 'gen'
      })

      /** Packs the given archive entries into a tar stream. */
      function archive(entries: Record<string, string>): Readable {
        const pack = tar.pack()
        pack.entry({ name: 'manifest.yml' }, manifest)
        for (const [name, body] of Object.entries(entries)) {
          pack.entry({ name }, body)
        }
        pack.finalize()
        return Readable.from(pack)
      }

      it('checks an archived Resource against the archived log head, not the Metadata object', async () => {
        const { backend } = harness
        const spaceId = 'space-import-governed-new'
        await provisionSpace(backend, spaceId, 'present')
        const refusal = await importArchive({
          backend,
          spaceId,
          tarStream: archive({
            'space/src/gov/.collection.meta.gov.json': JSON.stringify({
              id: 'gov',
              type: ['Collection']
            }),
            'space/src/gov/.collectionlog.gov.json': edvLog,
            'space/src/gov/r.doc.text%2Fplain.txt': 'not an envelope'
          })
        }).catch((err: unknown) => err)
        assert.ok(refusal instanceof ProblemError)
        assert.equal(refusal.statusCode, 422)
        assert.match(refusal.type, /encryption-scheme-mismatch/)
        const listing = await backend.listCollections({ spaceId })
        assert.deepEqual(
          listing.items.map(item => item.id),
          ['present']
        )
      })

      it('checks an archived Resource against an existing log-governed destination Collection', async () => {
        const { backend } = harness
        const spaceId = 'space-import-governed-existing'
        await provisionSpace(backend, spaceId, 'gov')
        await backend.writeCollectionLog({
          spaceId,
          collectionId: 'gov',
          body: '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n',
          ifNoneMatch: '*'
        })
        const refusal = await importArchive({
          backend,
          spaceId,
          tarStream: archive({
            'space/src/gov/r.doc.text%2Fplain.txt': 'not an envelope'
          })
        }).catch((err: unknown) => err)
        assert.ok(refusal instanceof ProblemError)
        assert.equal(refusal.statusCode, 422)
        assert.equal(
          await backend.getResourceMetadata({
            spaceId,
            collectionId: 'gov',
            resourceId: 'doc'
          }),
          undefined
        )
      })

      it('refuses, before writing, what a live write refuses: a descriptor beside a log, a null index entry, a typeless policy', async () => {
        const { backend } = harness
        const spaceId = 'space-import-shape'
        await provisionSpace(backend, spaceId, 'present')
        const cases: Array<[Record<string, string>, RegExp]> = [
          [
            {
              'space/src/col/.collection.meta.col.json': JSON.stringify({
                id: 'col',
                type: ['Collection'],
                encryption: { scheme: 'edv' }
              }),
              'space/src/col/.collectionlog.col.json': edvLog
            },
            /beside a governing history log/
          ],
          [
            {
              'space/src/col/.collection.meta.col.json': JSON.stringify({
                id: 'col',
                type: ['Collection'],
                plaintext: { indexes: [null] }
              })
            },
            /Collection Metadata file of Collection 'col' is malformed/
          ],
          [
            {
              'space/src/col/.collection.meta.col.json': JSON.stringify({
                id: 'col',
                type: ['Collection']
              }),
              'space/src/col/.collection.policy.json': JSON.stringify({
                public: true
              })
            },
            /no non-empty string 'type'/
          ]
        ]
        for (const [entries, expected] of cases) {
          const refusal = await importArchive({
            backend,
            spaceId,
            tarStream: archive(entries)
          }).catch((err: unknown) => err)
          assert.ok(refusal instanceof InvalidImportError, expected.source)
          assert.match(refusal.detail ?? '', expected)
        }
        const listing = await backend.listCollections({ spaceId })
        assert.deepEqual(
          listing.items.map(item => item.id),
          ['present']
        )
      })
    })

    describe('Metadata write preconditions', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      const spaceMetadata = (spaceId: string) => ({
        id: spaceId,
        type: ['Space'],
        name: `Space ${spaceId}`,
        controller: CONTROLLER
      })

      it('writeSpace returns a validator that getSpaceMetadata surfaces and bumps per write', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeSpace({
          spaceId: 'space-etag',
          spaceMetadata: spaceMetadata('space-etag')
        })
        assert.equal(created.local, 0)
        const stored = await backend.getSpaceMetadata({
          spaceId: 'space-etag'
        })
        assert.equal(stored?.metaGeneration, created.generation)
        assert.equal(metadataEtagOf(stored), formatEtag(created))
        // A caller spreading the read result back in does not smuggle the
        // validator into the stored body.
        const { validator: updated } = await backend.writeSpace({
          spaceId: 'space-etag',
          spaceMetadata: { ...stored!, name: 'Renamed' }
        })
        assertValidatorAdvanced(created, updated)
        const reread = await backend.getSpaceMetadata({
          spaceId: 'space-etag'
        })
        assert.equal(reread?.name, 'Renamed')
        assert.equal(metadataEtagOf(reread), formatEtag(updated))
        // The listing is the plain wire shape, validator stripped.
        const listed = (await backend.listSpaces()).find(
          space => space.id === 'space-etag'
        )
        assert.ok(listed)
        assert.equal('metaGeneration' in listed!, false)
        assert.equal('metaLocal' in listed!, false)
      })

      it('writeSpace If-None-Match: * creates when absent, 412s when present', async () => {
        const { backend } = harness
        await backend.writeSpace({
          spaceId: 'space-inm',
          spaceMetadata: spaceMetadata('space-inm'),
          ifNoneMatch: '*'
        })
        await expect(
          backend.writeSpace({
            spaceId: 'space-inm',
            spaceMetadata: { ...spaceMetadata('space-inm'), name: 'Two' },
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        assert.equal(
          (await backend.getSpaceMetadata({ spaceId: 'space-inm' }))?.name,
          'Space space-inm'
        )
      })

      it('writeSpace If-Match matches the current ETag or 412s', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeSpace({
          spaceId: 'space-im',
          spaceMetadata: spaceMetadata('space-im')
        })
        await expect(
          backend.writeSpace({
            spaceId: 'space-im',
            spaceMetadata: spaceMetadata('space-im'),
            ifMatch: etagWithCounterBumped({ validator: created, by: 9 })
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const { validator: second } = await backend.writeSpace({
          spaceId: 'space-im',
          spaceMetadata: spaceMetadata('space-im'),
          ifMatch: formatEtag(created)
        })
        assertValidatorAdvanced(created, second)
        // The consumed validator is stale now.
        await expect(
          backend.writeSpace({
            spaceId: 'space-im',
            spaceMetadata: spaceMetadata('space-im'),
            ifMatch: formatEtag(created)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('writeSpace strips a client-supplied _generation / _local and stamp from the stored body', async () => {
        const { backend } = harness
        const { validator: written } = await backend.writeSpace({
          spaceId: 'space-smuggle',
          spaceMetadata: {
            ...spaceMetadata('space-smuggle'),
            _generation: 'fake',
            _local: 999,
            updatedAt: '2000-01-01T00:00:00.000Z',
            updatedAtCounter: 7,
            originId: 'forged'
          } as SpaceMetadata
        })
        const stored = await backend.getSpaceMetadata({
          spaceId: 'space-smuggle'
        })
        assert.equal('_generation' in stored!, false)
        assert.equal('_local' in stored!, false)
        assert.equal(stored?.metaGeneration, written.generation)
        assert.equal(stored?.metaLocal, 0)
        // The stamp is the backend's, not the body's.
        assert.notEqual(stored?.updatedAt, '2000-01-01T00:00:00.000Z')
        assert.notEqual(stored?.originId, 'forged')
        assert.equal(metadataEtagOf(stored), formatEtag(written))
      })

      it('writeSpace If-Match honors the * and list forms', async () => {
        const { backend } = harness
        await expect(
          backend.writeSpace({
            spaceId: 'space-im-forms',
            spaceMetadata: spaceMetadata('space-im-forms'),
            ifMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const { validator: created } = await backend.writeSpace({
          spaceId: 'space-im-forms',
          spaceMetadata: spaceMetadata('space-im-forms')
        })
        const { validator: second } = await backend.writeSpace({
          spaceId: 'space-im-forms',
          spaceMetadata: spaceMetadata('space-im-forms'),
          ifMatch: '*'
        })
        assertValidatorAdvanced(created, second)
        const { validator: third } = await backend.writeSpace({
          spaceId: 'space-im-forms',
          spaceMetadata: spaceMetadata('space-im-forms'),
          ifMatch: `${formatEtag(created)}, ${formatEtag(second)}`
        })
        assertValidatorAdvanced(second, third)
        // A weak member never matches under strong comparison.
        await expect(
          backend.writeSpace({
            spaceId: 'space-im-forms',
            spaceMetadata: spaceMetadata('space-im-forms'),
            ifMatch: `W/${formatEtag(third)}`
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('writeSpace If-None-Match with a listed validator refuses the named current ETag', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeSpace({
          spaceId: 'space-inm-list',
          spaceMetadata: spaceMetadata('space-inm-list')
        })
        await expect(
          backend.writeSpace({
            spaceId: 'space-inm-list',
            spaceMetadata: spaceMetadata('space-inm-list'),
            ifNoneMatch: new Set([formatEtag(created)])
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const { validator: second } = await backend.writeSpace({
          spaceId: 'space-inm-list',
          spaceMetadata: spaceMetadata('space-inm-list'),
          ifNoneMatch: new Set([
            etagWithCounterBumped({ validator: created, by: 7 })
          ])
        })
        assertValidatorAdvanced(created, second)
      })

      it('writeSpace with both If-Match and If-None-Match: * is 412 whether or not the Space exists', async () => {
        const { backend } = harness
        await expect(
          backend.writeSpace({
            spaceId: 'space-both',
            spaceMetadata: spaceMetadata('space-both'),
            ifMatch: '"noSuchGen.1.0.x.0"',
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        assert.equal(
          await backend.getSpaceMetadata({ spaceId: 'space-both' }),
          undefined
        )
        const { validator: created } = await backend.writeSpace({
          spaceId: 'space-both',
          spaceMetadata: spaceMetadata('space-both')
        })
        await expect(
          backend.writeSpace({
            spaceId: 'space-both',
            spaceMetadata: spaceMetadata('space-both'),
            ifMatch: formatEtag(created),
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('writeSpace If-Match on an absent Space 412s', async () => {
        await expect(
          harness.backend.writeSpace({
            spaceId: 'space-im-absent',
            spaceMetadata: spaceMetadata('space-im-absent'),
            ifMatch: '"noSuchGen.1.0.x.0"'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        assert.equal(
          await harness.backend.getSpaceMetadata({
            spaceId: 'space-im-absent'
          }),
          undefined
        )
      })

      it('a Space deleted and re-created under the same id mints a new generation', async () => {
        const { backend } = harness
        const { validator: first } = await backend.writeSpace({
          spaceId: 'space-regen',
          spaceMetadata: spaceMetadata('space-regen')
        })
        await backend.deleteSpace({ spaceId: 'space-regen' })
        const { validator: second } = await backend.writeSpace({
          spaceId: 'space-regen',
          spaceMetadata: spaceMetadata('space-regen')
        })
        assert.notEqual(second.generation, first.generation)
      })

      it('writeCollection If-None-Match: * creates when absent, 412s when present', async () => {
        const { backend } = harness
        await backend.writeSpace({
          spaceId: 'space-col-inm',
          spaceMetadata: spaceMetadata('space-col-inm')
        })
        const { validator: created } = await backend.writeCollection({
          spaceId: 'space-col-inm',
          collectionId: 'guarded',
          collectionMetadata: {
            id: 'guarded',
            type: ['Collection'],
            name: 'One'
          },
          ifNoneMatch: '*'
        })
        assert.equal(created.local, 0)
        await expect(
          backend.writeCollection({
            spaceId: 'space-col-inm',
            collectionId: 'guarded',
            collectionMetadata: {
              id: 'guarded',
              type: ['Collection'],
              name: 'Two'
            },
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        assert.equal(
          (
            await backend.getCollectionMetadata({
              spaceId: 'space-col-inm',
              collectionId: 'guarded'
            })
          )?.name,
          'One'
        )
      })
    })

    describe('createdBy provenance', () => {
      let harness: BackendHarness
      const spaceId = 'space-created-by'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('writeResource with createdBy records it; getResourceMetadata surfaces it', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-first',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_ONE
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-first'
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
      })

      it('a second writeResource by a different createdBy does not change it (creator, not last writer)', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-first',
          input: jsonInput({ v: 2 }),
          createdBy: CREATOR_TWO
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-first'
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
      })

      it('a later writeResource does not backfill createdBy onto a Resource created without one', async () => {
        const { backend } = harness
        // Created with no invoker: its creator is unrecorded, permanently.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-no-backfill',
          input: jsonInput({ v: 1 })
        })
        // A later writer must not be promoted to "creator" by this write.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-no-backfill',
          input: jsonInput({ v: 2 }),
          createdBy: CREATOR_TWO
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-no-backfill'
        })
        assert.equal(metadata?.createdBy, undefined)
      })

      it('a later writeSpace does not backfill createdBy onto a Space created without one', async () => {
        const { backend } = harness
        const noCreatorSpaceId = 'space-created-by-none'
        // A token-provisioned Create Space records no invoker.
        await backend.writeSpace({
          spaceId: noCreatorSpaceId,
          spaceMetadata: {
            id: noCreatorSpaceId,
            type: ['Space'],
            controller: CONTROLLER
          }
        })
        // The controller's first authenticated update must not become "creator".
        await backend.writeSpace({
          spaceId: noCreatorSpaceId,
          spaceMetadata: {
            id: noCreatorSpaceId,
            type: ['Space'],
            name: 'Renamed',
            controller: CONTROLLER
          },
          createdBy: CREATOR_TWO
        })
        const metadata = await backend.getSpaceMetadata({
          spaceId: noCreatorSpaceId
        })
        assert.equal(metadata?.name, 'Renamed')
        assert.equal(metadata?.createdBy, undefined)
      })

      it('a later writeCollection does not backfill createdBy onto a Collection created without one', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'cb-no-backfill-collection',
          collectionMetadata: {
            id: 'cb-no-backfill-collection',
            type: ['Collection']
          }
        })
        await backend.writeCollection({
          spaceId,
          collectionId: 'cb-no-backfill-collection',
          collectionMetadata: {
            id: 'cb-no-backfill-collection',
            type: ['Collection'],
            name: 'Renamed'
          },
          createdBy: CREATOR_TWO
        })
        const metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'cb-no-backfill-collection'
        })
        assert.equal(metadata?.name, 'Renamed')
        assert.equal(metadata?.createdBy, undefined)
      })

      it('writeResource with no createdBy records none (absent key)', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-none',
          input: jsonInput({ v: 1 })
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-none'
        })
        assert.equal(metadata?.createdBy, undefined)
        assert.ok(!Object.prototype.hasOwnProperty.call(metadata, 'createdBy'))
      })

      it('writeResourceMetadata preserves createdBy and cannot set it via custom', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-meta',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_ONE
        })
        // A forged `createdBy` smuggled inside `custom` must land in `custom`,
        // never at the top level -- `custom` is arbitrary client data, but
        // `createdBy` is server-managed.
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-meta',
          custom: { createdBy: CREATOR_TWO }
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-meta'
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
        assert.deepEqual(metadata?.custom, { createdBy: CREATOR_TWO })
      })

      it('soft-delete then re-create under a different createdBy records fresh provenance', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-recreate',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_ONE
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-recreate'
        })
        const recreated = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-recreate',
          input: jsonInput({ v: 2 }),
          createdBy: CREATOR_TWO
        })
        // A write over a tombstone is a create: this write's invoker and
        // time, not the deleted Resource's.
        assert.equal(recreated.created, true)
        assert.equal(recreated.members.createdBy, CREATOR_TWO)
        assert.equal(
          recreated.members.createdAt,
          recreated.validator.stamp.updatedAt
        )
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'cb-recreate'
        })
        assert.equal(metadata?.createdBy, CREATOR_TWO)
        assert.equal(metadata?.createdAt, recreated.validator.stamp.updatedAt)
      })

      it('writeSpace records the first invoker as createdBy and preserves it on overwrite', async () => {
        const { backend } = harness
        const createdBySpaceId = 'space-created-by-space'
        await backend.writeSpace({
          spaceId: createdBySpaceId,
          spaceMetadata: {
            id: createdBySpaceId,
            type: ['Space'],
            name: 'Created By Space',
            controller: CONTROLLER
          },
          createdBy: CREATOR_ONE
        })
        let metadata = await backend.getSpaceMetadata({
          spaceId: createdBySpaceId
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)

        // A second write by a different invoker does not change the creator.
        await backend.writeSpace({
          spaceId: createdBySpaceId,
          spaceMetadata: {
            id: createdBySpaceId,
            type: ['Space'],
            name: 'Renamed Created By Space',
            controller: CONTROLLER
          },
          createdBy: CREATOR_TWO
        })
        metadata = await backend.getSpaceMetadata({
          spaceId: createdBySpaceId
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
        assert.equal(metadata?.name, 'Renamed Created By Space')
      })

      it('writeSpace drops a client-supplied createdBy inside the metadata document', async () => {
        const { backend } = harness
        const forgedSpaceId = 'space-created-by-forged'
        await backend.writeSpace({
          spaceId: forgedSpaceId,
          spaceMetadata: {
            id: forgedSpaceId,
            type: ['Space'],
            name: 'Forged createdBy Space',
            controller: CONTROLLER,
            createdBy: 'did:key:zEVIL'
          },
          createdBy: CREATOR_ONE
        })
        const metadata = await backend.getSpaceMetadata({
          spaceId: forgedSpaceId
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
      })

      it('writeSpace with no invoker drops a client-supplied createdBy rather than honoring it', async () => {
        const { backend } = harness
        const forgedSpaceId = 'space-created-by-forged-no-invoker'
        await backend.writeSpace({
          spaceId: forgedSpaceId,
          spaceMetadata: {
            id: forgedSpaceId,
            type: ['Space'],
            name: 'Forged createdBy Space, no invoker',
            controller: CONTROLLER,
            createdBy: 'did:key:zEVIL'
          }
        })
        const metadata = await backend.getSpaceMetadata({
          spaceId: forgedSpaceId
        })
        // Fail closed: unrecorded, not the value the body asked for.
        assert.equal(metadata?.createdBy, undefined)
        assert.ok(!('createdBy' in metadata!))
      })

      it('writeCollection records the first invoker as createdBy and preserves it on overwrite', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'cb-collection',
          collectionMetadata: {
            id: 'cb-collection',
            type: ['Collection'],
            name: 'Created By Collection'
          },
          createdBy: CREATOR_ONE
        })
        let metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'cb-collection'
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)

        await backend.writeCollection({
          spaceId,
          collectionId: 'cb-collection',
          collectionMetadata: {
            id: 'cb-collection',
            type: ['Collection'],
            name: 'Renamed Created By Collection'
          },
          createdBy: CREATOR_TWO
        })
        metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'cb-collection'
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
        assert.equal(metadata?.name, 'Renamed Created By Collection')
      })

      it('writeCollection drops a client-supplied createdBy inside the metadata document', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'cb-collection-forged',
          collectionMetadata: {
            id: 'cb-collection-forged',
            type: ['Collection'],
            name: 'Forged createdBy Collection',
            createdBy: 'did:key:zEVIL'
          },
          createdBy: CREATOR_ONE
        })
        const metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'cb-collection-forged'
        })
        assert.equal(metadata?.createdBy, CREATOR_ONE)
      })
    })

    describe('write results', () => {
      let harness: BackendHarness
      const spaceId = 'space-write-results'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('writeResource reports a create, then an update, with the members it left', async () => {
        const { backend } = harness
        const created = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'members',
          input: binaryInput(Buffer.from('abc')),
          createdBy: CREATOR_ONE
        })
        assert.equal(created.created, true)
        assert.deepEqual(created.members, {
          contentType: 'application/octet-stream',
          size: 3,
          createdAt: created.validator.stamp.updatedAt,
          ...created.validator.stamp,
          createdBy: CREATOR_ONE
        })

        const updated = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'members',
          input: jsonInput({ longer: true }),
          createdBy: CREATOR_TWO
        })
        assert.equal(updated.created, false)
        assert.deepEqual(updated.members, {
          contentType: 'application/json',
          size: JSON.stringify({ longer: true }).length,
          createdAt: created.members.createdAt,
          ...updated.validator.stamp,
          createdBy: CREATOR_ONE
        })
      })

      it('writeResourceMetadata reports the content stamp and the /meta stamp it minted', async () => {
        const { backend } = harness
        const content = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'meta-members',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_ONE
        })
        const written = (await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'meta-members',
          custom: { name: 'Named' }
        }))!
        assert.deepEqual(written.members, {
          ...content.members,
          meta: {
            ...written.validator.stamp,
            generation: written.validator.generation
          }
        })
      })

      it('concurrent writes of one new id each report their own revision', async () => {
        const { backend } = harness
        const creators = Array.from(
          { length: 6 },
          (_, index) => `did:key:z6MkContractSuiteRacer${index}` as IDID
        )
        const results = await Promise.all(
          creators.map((createdBy, index) =>
            backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId: 'raced',
              input: jsonInput({ racer: 'x'.repeat(index) }),
              createdBy
            })
          )
        )
        const creates = results.filter(result => result.created)
        assert.equal(creates.length, 1)
        const creator = creators[results.indexOf(creates[0]!)]
        for (const [index, result] of results.entries()) {
          // Each result describes its own write: its stamp, its bytes, and
          // the creator the row carried once it landed.
          assert.deepEqual(
            {
              updatedAt: result.members.updatedAt,
              updatedAtCounter: result.members.updatedAtCounter,
              originId: result.members.originId
            },
            result.validator.stamp
          )
          assert.equal(
            result.members.size,
            JSON.stringify({ racer: 'x'.repeat(index) }).length
          )
          assert.equal(result.members.createdBy, creator)
          assert.equal(result.members.createdAt, creates[0]!.members.createdAt)
        }
        // The feed carries the stamp of the write that landed last.
        const { documents } = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 1000
        })
        const doc = documents.find(
          document =>
            document.kind === 'resource' && document.resourceId === 'raced'
        )!
        const last = results.find(
          result =>
            result.validator.stamp.updatedAt === doc.updatedAt &&
            result.validator.stamp.updatedAtCounter === doc.updatedAtCounter
        )
        assert.ok(last, 'the feed stamp is one write result')
      })

      it('a write over a tombstone is a create with fresh provenance', async () => {
        const { backend } = harness
        const first = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tombstoned',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_ONE
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tombstoned'
        })
        const revived = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tombstoned',
          input: jsonInput({ v: 2 }),
          createdBy: CREATOR_TWO
        })
        assert.equal(revived.created, true)
        assert.equal(revived.members.createdBy, CREATOR_TWO)
        assert.equal(
          revived.members.createdAt,
          revived.validator.stamp.updatedAt
        )
        assert.notEqual(revived.members.createdAt, first.members.createdAt)
        // The generation continues across the tombstone.
        assert.equal(revived.validator.generation, first.validator.generation)
      })

      it('a write-once repeat reports no create and the stored members', async () => {
        const { backend } = harness
        const stored = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'once',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_ONE,
          immutable: true
        })
        const repeated = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'once',
          input: jsonInput({ v: 1 }),
          createdBy: CREATOR_TWO,
          immutable: true
        })
        assert.equal(repeated.created, false)
        assert.deepEqual(repeated.validator, stored.validator)
        assert.deepEqual(repeated.members, stored.members)
      })

      it('writeSpace and writeCollection report a create, then an update, with the stored object', async () => {
        const { backend } = harness
        const createdSpace = await backend.writeSpace({
          spaceId: 'space-write-results-new',
          spaceMetadata: {
            id: 'space-write-results-new',
            type: ['Space'],
            controller: CONTROLLER
          },
          createdBy: CREATOR_ONE
        })
        assert.equal(createdSpace.created, true)
        assert.equal(createdSpace.metadata.createdBy, CREATOR_ONE)
        assert.equal(
          createdSpace.metadata.updatedAt,
          createdSpace.validator.stamp.updatedAt
        )
        const storedSpace = await backend.getSpaceMetadata({
          spaceId: 'space-write-results-new'
        })
        const {
          metaGeneration: _generation,
          metaLocal: _local,
          ...storedSpaceBody
        } = storedSpace!
        assert.deepEqual(createdSpace.metadata, storedSpaceBody)
        const updatedSpace = await backend.writeSpace({
          spaceId: 'space-write-results-new',
          spaceMetadata: {
            id: 'space-write-results-new',
            type: ['Space'],
            name: 'Renamed',
            controller: CONTROLLER
          },
          createdBy: CREATOR_TWO
        })
        assert.equal(updatedSpace.created, false)
        assert.equal(updatedSpace.metadata.createdBy, CREATOR_ONE)
        assert.equal(updatedSpace.metadata.name, 'Renamed')

        const createdCollection = await backend.writeCollection({
          spaceId,
          collectionId: 'col-new',
          collectionMetadata: { id: 'col-new', type: ['Collection'] },
          createdBy: CREATOR_ONE
        })
        assert.equal(createdCollection.created, true)
        const storedCollection = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'col-new'
        })
        const {
          metaGeneration: _collectionGeneration,
          metaLocal: _collectionLocal,
          ...storedCollectionBody
        } = storedCollection!
        assert.deepEqual(createdCollection.metadata, storedCollectionBody)
        const updatedCollection = await backend.writeCollection({
          spaceId,
          collectionId: 'col-new',
          collectionMetadata: {
            id: 'col-new',
            type: ['Collection'],
            name: 'Named'
          },
          createdBy: CREATOR_TWO
        })
        assert.equal(updatedCollection.created, false)
        assert.equal(updatedCollection.metadata.createdBy, CREATOR_ONE)
        assert.equal(
          updatedCollection.metadata.createdAt,
          createdCollection.metadata.createdAt
        )

        await backend.deleteCollection({ spaceId, collectionId: 'col-new' })
        const recreated = await backend.writeCollection({
          spaceId,
          collectionId: 'col-new',
          collectionMetadata: { id: 'col-new', type: ['Collection'] },
          createdBy: CREATOR_TWO
        })
        assert.equal(recreated.created, true)
        assert.equal(recreated.metadata.createdBy, CREATOR_TWO)
      })
    })

    describe('conditional-write preconditions', () => {
      let harness: BackendHarness
      const spaceId = 'space-cond'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('If-None-Match: * creates when absent, 412s when present', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'inm',
          input: jsonInput({ v: 1 }),
          ifNoneMatch: '*'
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'inm',
            input: jsonInput({ v: 2 }),
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('If-Match matches the current ETag or 412s', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'im',
          input: jsonInput({ v: 1 })
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'im',
          input: jsonInput({ v: 2 }),
          ifMatch: formatEtag(created)
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'im',
            input: jsonInput({ v: 3 }),
            ifMatch: formatEtag(created)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('If-Match on an absent Resource 412s', async () => {
        await expect(
          harness.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'im-absent',
            input: jsonInput({}),
            ifMatch: '"noSuchGen.1.0.x.0"'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('conditional delete honors If-Match', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'del',
          input: jsonInput({ v: 1 })
        })
        await expect(
          backend.deleteResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'del',
            ifMatch: etagWithCounterBumped({ validator: created, by: 9 })
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'del',
          ifMatch: formatEtag(created)
        })
        await expect(
          backend.getResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'del'
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
      })

      it('a tombstone counts as absent; the generation continues and the stamp advances through recreate', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb',
          input: jsonInput({ v: 1 })
        })
        const { validator: second } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb',
          input: jsonInput({ v: 2 })
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb'
        })
        // Tombstoned: If-Match cannot be satisfied ...
        await expect(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'tomb',
            input: jsonInput({ v: 3 }),
            ifMatch: formatEtag(second)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // ... while If-None-Match: * (create-if-absent) succeeds. A tombstone
        // keeps the record's generation, and the re-create mints a stamp
        // above the tombstone's.
        const { validator: revived } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb',
          input: jsonInput({ v: 3 }),
          ifNoneMatch: '*'
        })
        assertValidatorAdvanced(second, revived)
        assert.equal(
          revived.generation,
          second.generation,
          'a soft delete keeps the generation'
        )
        const read = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'tomb'
        })
        assert.equal(read.generation, second.generation)
        assert.equal(etagOf(read), formatEtag(revived))
      })

      it('metadata preconditions gate on the composite /meta ETag', async () => {
        const { backend } = harness
        const { validator: content } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          input: jsonInput({})
        })
        // Before any metadata write the /meta ETag is the content ETag alone,
        // so If-Match with it passes. A stale content validator does not.
        await expect(
          backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'z' },
            ifMatch: etagWithCounterBumped({ validator: content, by: 2 })
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // If-None-Match: * -- only when no metadata has been written yet.
        const firstWrite = await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          custom: { name: 'a' },
          ifNoneMatch: '*'
        })
        assert.ok(firstWrite)
        assert.deepEqual(firstWrite.contentValidator, content)
        const firstMeta = firstWrite.validator
        const firstEtag = resourceMetaEtag({
          content,
          meta: firstMeta
        })
        await expect(
          backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'b' },
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // The /meta record's validator alone is not the /meta ETag.
        await expect(
          backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'b' },
            ifMatch: formatEtag(firstMeta)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const result = (
          await backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'b' },
            ifMatch: firstEtag
          })
        )?.validator
        assertValidatorAdvanced(firstMeta, result!)
        assert.equal(result?.generation, firstMeta.generation)
        const secondEtag = resourceMetaEtag({ content, meta: result })
        // A content write moves the /meta ETag, so the one held from before
        // it is stale.
        const { validator: content2 } = await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          input: jsonInput({ v: 2 })
        })
        await expect(
          backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'mp',
            custom: { name: 'c' },
            ifMatch: secondEtag
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const third = await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'mp',
          custom: { name: 'c' },
          ifMatch: resourceMetaEtag({ content: content2, meta: result })
        })
        assert.deepEqual(third?.contentValidator, content2)
      })

      it('a soft delete drops the /meta validator: the re-created Resource starts a new meta generation', async () => {
        const { backend } = harness
        const target = { spaceId, collectionId: 'col', resourceId: 'meta-tomb' }
        const { validator: created } = await backend.writeResource({
          ...target,
          input: jsonInput({ v: 1 })
        })
        const preDeleteMeta = (
          await backend.writeResourceMetadata({
            ...target,
            custom: { name: 'before' }
          })
        )?.validator
        assert.notEqual(
          preDeleteMeta?.generation,
          created.generation,
          'the /meta validator has a generation of its own'
        )
        await backend.deleteResource(target)
        const { validator: revived } = await backend.writeResource({
          ...target,
          input: jsonInput({ v: 2 })
        })
        // The content validator keeps its generation through the tombstone
        // and mints a stamp above it.
        assert.equal(revived.generation, created.generation)
        assertValidatorAdvanced(created, revived)
        // The re-created Resource has no metadata object yet, so the
        // pre-delete /meta ETag matches nothing ...
        await expect(
          backend.writeResourceMetadata({
            ...target,
            custom: { name: 'stale replica' },
            ifMatch: resourceMetaEtag({ content: created, meta: preDeleteMeta })
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // ... while a guarded first write succeeds, under a fresh generation
        // rather than the old `/meta` validator recurring.
        const revivedMeta = (
          await backend.writeResourceMetadata({
            ...target,
            custom: { name: 'after' },
            ifNoneMatch: '*'
          })
        )?.validator
        assert.notEqual(revivedMeta?.generation, preDeleteMeta?.generation)
        assert.notEqual(
          formatEtag(revivedMeta!),
          formatEtag(preDeleteMeta!),
          'a pre-delete /meta ETag never recurs on the re-created Resource'
        )
        const read = await backend.getResourceMetadata(target)
        assert.equal(read?.meta?.generation, revivedMeta?.generation)
        assert.equal(etagOf({ ...read!.meta }), formatEtag(revivedMeta!))
        assert.equal(read?.generation, created.generation)
        assert.deepEqual(read?.custom, { name: 'after' })
      })

      it('exactly one of N concurrent If-None-Match: * creators wins', async () => {
        // Create-if-absent must be atomic under concurrency: the filesystem
        // backend serializes on its per-Resource mutex, the Postgres backend
        // arbitrates on the primary key -- either way, one 201 and N-1 412s,
        // never a silent overwrite.
        const attempts = await Promise.allSettled(
          Array.from({ length: 8 }, (_, index) =>
            harness.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId: 'race-create',
              input: jsonInput({ writer: index }),
              ifNoneMatch: '*'
            })
          )
        )
        const winners = attempts.filter(
          attempt => attempt.status === 'fulfilled'
        )
        const losers = attempts.filter(
          attempt =>
            attempt.status === 'rejected' &&
            attempt.reason instanceof PreconditionFailedError
        )
        assert.equal(winners.length, 1)
        assert.equal(losers.length, attempts.length - 1)
        // The surviving representation is the winner's.
        const metadata = await harness.backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'race-create'
        })
        const winner = winners[0] as PromiseFulfilledResult<ResourceWriteResult>
        assert.equal(etagOf(metadata!), formatEtag(winner.value.validator))
      })

      it('unconditional delete of a tombstone is a stable no-op', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'redelete',
          input: jsonInput({})
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'redelete'
        })
        const feed1 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const tomb1 = resourceDocuments(feed1.documents).find(
          document => document.resourceId === 'redelete'
        )
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'redelete'
        })
        const feed2 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const tomb2 = resourceDocuments(feed2.documents).find(
          document => document.resourceId === 'redelete'
        )
        assert.deepEqual(tomb2, tomb1)
      })
    })

    describe('key-epoch stamping and Collection Metadata versioning', () => {
      let harness: BackendHarness
      const spaceId = 'space-epochs'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('a content write stores the declared epoch; metadata read surfaces it', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'e1',
          input: jsonInput({ v: 1 }),
          epoch: 'urn:epoch:1'
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'e1'
        })
        assert.equal(metadata?.epoch, 'urn:epoch:1')
      })

      it('surfaces the epoch on listings and the changes feed', async () => {
        const { backend } = harness
        const listing = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col'
        })
        const item = listing.items.find(entry => entry.id === 'e1')
        assert.equal((item as { epoch?: string }).epoch, 'urn:epoch:1')
        const feed = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const doc = resourceDocuments(feed.documents).find(
          entry => entry.resourceId === 'e1'
        )
        assert.equal((doc as { epoch?: string }).epoch, 'urn:epoch:1')
      })

      it('a content rewrite WITHOUT an epoch clears the stored stamp', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'e1',
          input: jsonInput({ v: 2 })
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'e1'
        })
        assert.equal(metadata?.epoch, undefined)
      })

      it('a metadata write PRESERVES the epoch when omitted, replaces it when supplied', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'e2',
          input: jsonInput({ v: 1 }),
          epoch: 'urn:epoch:1'
        })
        // Metadata write with no epoch preserves it.
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'e2',
          custom: {}
        })
        let metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'e2'
        })
        assert.equal(metadata?.epoch, 'urn:epoch:1')
        // Metadata write with an epoch replaces it.
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'e2',
          custom: {},
          epoch: 'urn:epoch:2'
        })
        metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'e2'
        })
        assert.equal(metadata?.epoch, 'urn:epoch:2')
      })

      it('writeCollection returns an advancing validator', async () => {
        const { backend } = harness
        // The Collection was created in `provisionSpace`; update it.
        const { validator: first } = await backend.writeCollection({
          spaceId,
          collectionId: 'col',
          collectionMetadata: {
            id: 'col',
            type: ['Collection'],
            name: 'Renamed once'
          }
        })
        const { validator: second } = await backend.writeCollection({
          spaceId,
          collectionId: 'col',
          collectionMetadata: {
            id: 'col',
            type: ['Collection'],
            name: 'Renamed twice'
          }
        })
        assertValidatorAdvanced(first, second)
        const metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'col'
        })
        assert.equal(metadataEtagOf(metadata), formatEtag(second))
      })

      it('If-Match on the Collection Metadata object compare-and-swaps (stale validator 412)', async () => {
        const { backend } = harness
        const current = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'col'
        })
        const currentEtag = metadataEtagOf(current)!
        // A matching If-Match succeeds and advances the stamp.
        const { validator: ok } = await backend.writeCollection({
          spaceId,
          collectionId: 'col',
          collectionMetadata: {
            id: 'col',
            type: ['Collection'],
            name: 'CAS ok'
          },
          ifMatch: currentEtag
        })
        assertEtagAdvanced({
          before: currentEtag,
          after: formatEtag(ok),
          container: true
        })
        assert.equal(
          ok.generation,
          current!.metaGeneration,
          'a metadata write keeps the Collection generation'
        )
        // The now-stale validator is rejected.
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId: 'col',
            collectionMetadata: {
              id: 'col',
              type: ['Collection'],
              name: 'CAS stale'
            },
            ifMatch: currentEtag
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('an unconditional writeCollection still upserts (no If-Match)', async () => {
        const { backend } = harness
        const before = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'col'
        })
        const { validator: result } = await backend.writeCollection({
          spaceId,
          collectionId: 'col',
          collectionMetadata: {
            id: 'col',
            type: ['Collection'],
            name: 'Unconditional'
          }
        })
        assertEtagAdvanced({
          before: metadataEtagOf(before),
          after: formatEtag(result),
          container: true
        })
      })

      it('the epoch survives an export / import round trip', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'e-export',
          input: jsonInput({ v: 1 }),
          epoch: 'urn:epoch:7'
        })
        const archive = await backend.exportSpace({ spaceId })
        const target = await makeBackend()
        try {
          await target.backend.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              name: `Space ${spaceId}`,
              controller: CONTROLLER
            }
          })
          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: archive
          })
          const metadata = await target.backend.getResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'e-export'
          })
          assert.equal(metadata?.epoch, 'urn:epoch:7')
        } finally {
          await target.cleanup()
        }
      })
    })

    describe('writer-attribution stamping (writerId)', () => {
      let harness: BackendHarness
      const spaceId = 'space-writer-id'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('a content write stores the declared label; metadata read surfaces it', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w1',
          input: jsonInput({ v: 1 }),
          writerId: 'writer-1'
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'w1'
        })
        assert.equal(metadata?.writerId, 'writer-1')
      })

      it('surfaces the label on listings and the changes feed', async () => {
        const { backend } = harness
        const listing = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col'
        })
        const item = listing.items.find(entry => entry.id === 'w1')
        assert.equal((item as { writerId?: string }).writerId, 'writer-1')
        const feed = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const doc = resourceDocuments(feed.documents).find(
          entry => entry.resourceId === 'w1'
        )
        assert.equal((doc as { writerId?: string }).writerId, 'writer-1')
      })

      it('a content rewrite WITHOUT the label clears the stored value', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w1',
          input: jsonInput({ v: 2 })
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'w1'
        })
        assert.equal(metadata?.writerId, undefined)
      })

      it('a metadata write leaves the content record writerId alone', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w2',
          input: jsonInput({ v: 1 }),
          writerId: 'writer-a'
        })
        // A metadata write carries no writer label: the content record's
        // `writerId` stays as the content write left it.
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'w2',
          custom: {}
        })
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'w2'
        })
        assert.equal(metadata?.writerId, 'writer-a')
      })

      it('DELETE declares the tombstone label; an unlabeled delete clears it', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w-del',
          input: jsonInput({ v: 1 }),
          writerId: 'writer-live'
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w-del',
          writerId: 'writer-deleter'
        })
        const feed = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const tomb = resourceDocuments(feed.documents).find(
          document => document.resourceId === 'w-del'
        )
        assert.equal(tomb?.deleted, true)
        assert.equal(
          (tomb as { writerId?: string }).writerId,
          'writer-deleter',
          'the tombstone carries the label the DELETE itself declared, not the prior content-write label'
        )

        // A second delete of the same id (re-create then delete again, with no
        // Writer-Id) clears the label.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w-del',
          input: jsonInput({ v: 2 }),
          writerId: 'writer-live-2'
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w-del'
        })
        const feed2 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        const tomb2 = resourceDocuments(feed2.documents).find(
          document => document.resourceId === 'w-del'
        )
        assert.equal(
          (tomb2 as { writerId?: string }).writerId,
          undefined,
          'a delete declaring no Writer-Id clears the stored label'
        )
      })

      it('the writerId survives an export / import round trip', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'w-export',
          input: jsonInput({ v: 1 }),
          writerId: 'writer-export'
        })
        const archive = await backend.exportSpace({ spaceId })
        const target = await makeBackend()
        try {
          await target.backend.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              name: `Space ${spaceId}`,
              controller: CONTROLLER
            }
          })
          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: archive
          })
          const metadata = await target.backend.getResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'w-export'
          })
          assert.equal(metadata?.writerId, 'writer-export')
        } finally {
          await target.cleanup()
        }
      })
    })

    describe('Collection Metadata write atomicity (key-epochs review fixes)', () => {
      let harness: BackendHarness
      const spaceId = 'space-atomicity'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('hands the composition callback undefined on a create', async () => {
        const { backend } = harness
        let seen: unknown = 'unset'
        await backend.writeCollection({
          spaceId,
          collectionId: 'at-create',
          collectionMetadata: ({ prior }) => {
            seen = prior
            return { id: 'at-create', type: ['Collection'], name: 'Created' }
          }
        })
        // A create has no prior object to read under the lock.
        assert.equal(seen, undefined)
      })

      it('hands the composition callback the current object (and its validator) on an update, and persists what it returns', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'at-update',
          collectionMetadata: {
            id: 'at-update',
            type: ['Collection'],
            name: 'First'
          }
        })
        let seen: StoredCollectionMetadata | undefined
        const written = await backend.writeCollection({
          spaceId,
          collectionId: 'at-update',
          collectionMetadata: ({ prior }) => {
            seen = prior
            return {
              id: 'at-update',
              type: ['Collection'],
              name: `Second after ${prior?.name}`
            }
          }
        })
        // The callback sees the current object read under the lock, carrying
        // the stamp it is about to supersede, and composes the stored object
        // from it.
        assert.equal(seen?.name, 'First')
        assert.equal(seen?.metaLocal, 0)
        assert.ok(seen?.updatedAt)
        assert.ok(seen?.metaGeneration)
        assert.equal(written.created, false)
        assert.equal(written.metadata.name, 'Second after First')
        const stored = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'at-update'
        })
        assert.equal(stored?.name, 'Second after First')
      })

      it('hands the composition callback the governing history log as of the lock', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'at-log',
          collectionMetadata: {
            id: 'at-log',
            type: ['Collection'],
            name: 'Governed'
          }
        })
        let seenLog: CollectionLogResult | undefined
        await backend.writeCollection({
          spaceId,
          collectionId: 'at-log',
          collectionMetadata: ({ log }) => {
            seenLog = log
            return {
              id: 'at-log',
              type: ['Collection'],
              name: 'Not yet governed'
            }
          }
        })
        // No log yet: the callback is handed none.
        assert.equal(seenLog, undefined)
        const created = await backend.writeCollectionLog({
          spaceId,
          collectionId: 'at-log',
          body: '{"state":{}}\n',
          ifNoneMatch: '*'
        })
        await backend.writeCollection({
          spaceId,
          collectionId: 'at-log',
          collectionMetadata: ({ log }) => {
            seenLog = log
            return { id: 'at-log', type: ['Collection'], name: 'Governed now' }
          }
        })
        // The very next Metadata write sees the log just written, body and
        // validator alike, without a read of its own.
        assert.equal(seenLog?.body, '{"state":{}}\n')
        assert.equal(formatEtag(seenLog!.validator), formatEtag(created!))
      })

      it('a throwing composition callback aborts the write (object and validator unchanged)', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'at-abort',
          collectionMetadata: {
            id: 'at-abort',
            type: ['Collection'],
            name: 'Keep'
          }
        })
        const before = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'at-abort'
        })
        class TransitionRejected extends Error {}
        await expect(
          backend.writeCollection({
            spaceId,
            collectionId: 'at-abort',
            collectionMetadata: () => {
              throw new TransitionRejected('the transition was refused')
            }
          })
        ).rejects.toBeInstanceOf(TransitionRejected)
        // The write was aborted inside the lock: nothing changed, no stamp moved.
        const after = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'at-abort'
        })
        assert.equal(after?.name, 'Keep')
        assert.equal(metadataEtagOf(after), metadataEtagOf(before))
      })

      it('a first metadata write after a refused policy write is a plain create', async () => {
        const { backend } = harness
        // A policy write with no Collection Metadata object is refused and
        // leaves nothing behind, so the first real metadata write is a plain create.
        await assert.rejects(
          backend.writePolicy({
            spaceId,
            collectionId: 'ph',
            policy: { rules: [] } as never
          }),
          isNotFound
        )
        const { validator: created } = await backend.writeCollection({
          spaceId,
          collectionId: 'ph',
          collectionMetadata: {
            id: 'ph',
            type: ['Collection'],
            name: 'Placeholder'
          }
        })
        assert.equal(created.local, 0)
        const metadata = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'ph'
        })
        assert.equal(metadataEtagOf(metadata), formatEtag(created))
      })

      it('does not persist a stale validator member; the archive carries _generation, not _local, metaGeneration or metaLocal', async () => {
        const { backend } = harness
        await backend.writeCollection({
          spaceId,
          collectionId: 'merge',
          collectionMetadata: {
            id: 'merge',
            type: ['Collection'],
            name: 'V1'
          }
        })
        // Simulate the request handler's read-merge-write: the read attaches
        // the out-of-band `metaGeneration` / `metaLocal` (and the stamp
        // members), which the handler spreads back into the next write. No
        // validator member may leak into the stored body.

        const read = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'merge'
        })
        const { validator: second } = await backend.writeCollection({
          spaceId,
          collectionId: 'merge',
          collectionMetadata: { ...read!, name: 'V2' }
        })
        const after = await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'merge'
        })
        assertEtagAdvanced({
          before: metadataEtagOf(read),
          after: metadataEtagOf(after),
          container: true
        })
        assert.equal(metadataEtagOf(after), formatEtag(second))
        assert.equal(after?.metaGeneration, read?.metaGeneration)
        assert.ok(!Object.prototype.hasOwnProperty.call(after, '_local'))
        assert.ok(!Object.prototype.hasOwnProperty.call(after, '_generation'))

        // The archived `.collection.meta.` body carries the internal `_generation`
        // interchange token and never the server-local `_local` segment or the
        // out-of-band `metaGeneration` / `metaLocal` -- identical members on
        // both backends (the Postgres jsonb-strip fix).
        const entries = await extractTarEntries(
          await backend.exportSpace({ spaceId })
        )
        const entry = [...entries].find(([entryName]) =>
          entryName.endsWith('.collection.meta.merge.json')
        )
        assert.ok(
          entry,
          'expected an archived .collection.meta.merge.json entry'
        )
        const body = JSON.parse(entry![1].body!.toString('utf8'))
        assert.equal(body._generation, after?.metaGeneration)
        assert.ok(!Object.prototype.hasOwnProperty.call(body, '_local'))
        assert.ok(!Object.prototype.hasOwnProperty.call(body, '_version'))
        assert.ok(!Object.prototype.hasOwnProperty.call(body, 'metaLocal'))
        assert.ok(!Object.prototype.hasOwnProperty.call(body, 'metaGeneration'))
      })

      // The transactional space-row lock guarantee: two concurrent creates of
      // different new Collections must not both slip past the count quota. Only
      // the transactional (Postgres) accounting passes this strictly -- the
      // filesystem's documented soft limit skips it.
      it.runIf(hardQuota)(
        'serializes concurrent creates against maxCollectionsPerSpace',
        async () => {
          const quotaHarness = await makeBackend({ maxCollectionsPerSpace: 2 })
          try {
            // provisionSpace writes the Space plus one Collection ('col'); the
            // cap is 2, so exactly one of two new creates may win.
            await provisionSpace(quotaHarness.backend, 'cc-quota')
            const attempts = await Promise.allSettled(
              ['new-a', 'new-b'].map(collectionId =>
                quotaHarness.backend.writeCollection({
                  spaceId: 'cc-quota',
                  collectionId,
                  collectionMetadata: {
                    id: collectionId,
                    type: ['Collection'],
                    name: collectionId
                  }
                })
              )
            )
            const accepted = attempts.filter(
              attempt => attempt.status === 'fulfilled'
            )
            const rejected = attempts.filter(
              attempt =>
                attempt.status === 'rejected' &&
                attempt.reason instanceof CountQuotaExceededError
            )
            assert.equal(accepted.length, 1)
            assert.equal(rejected.length, 1)
            const collections = await quotaHarness.backend.listCollections({
              spaceId: 'cc-quota'
            })
            assert.equal(collections.totalItems, 2)
          } finally {
            await quotaHarness.cleanup()
          }
        }
      )
    })

    describe('getCollectionMetadataAndLog (the optional one-read form)', () => {
      let harness: BackendHarness
      const spaceId = 'space-metadata-and-log'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it("answers what getCollectionMetadata then getCollectionLog answer, through a Collection's whole life", async ({
        skip
      }) => {
        const { backend } = harness
        if (!backend.getCollectionMetadataAndLog) {
          skip('the backend reads the Collection through the two methods')
        }
        const collectionId = 'one-read'
        const read = () =>
          backend.getCollectionMetadataAndLog!({ spaceId, collectionId })
        // The two reads the one-read form replaces, Metadata object first,
        // shaped as the one-read form answers: falsy for an absent
        // Collection, and no `log` member for one that is not governed.
        const readSeparately = async () => {
          const collectionMetadata = await backend.getCollectionMetadata({
            spaceId,
            collectionId
          })
          if (!collectionMetadata) {
            return undefined
          }
          const log = await backend.getCollectionLog({ spaceId, collectionId })
          return { collectionMetadata, ...(log && { log }) }
        }

        // Absent: falsy, as every getter resolves for not-found.
        assert.ok(!(await read()))
        assert.ok(!(await readSeparately()))

        // Live and not governed: the object with its validator, and no log
        // member at all.
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'One read'
          }
        })
        const live = await read()
        assert.deepStrictEqual(live, await readSeparately())
        assert.equal('log' in live!, false)

        // Governed: the log, beside the object whose local segment the log
        // write advanced.
        const logValidator = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: '{"state":{}}\n',
          ifNoneMatch: '*'
        })
        const governed = await read()
        assert.deepStrictEqual(governed, await readSeparately())
        assert.ok(governed?.log)
        assert.equal(governed.log.body, '{"state":{}}\n')
        assert.equal(
          formatEtag(governed.log.validator),
          formatEtag(logValidator!)
        )
        assert.equal(governed.collectionMetadata.metaLocal, 1)

        // Tombstoned: absent again.
        await backend.deleteCollection({ spaceId, collectionId })
        assert.ok(!(await read()))
        assert.ok(!(await readSeparately()))
      })
    })

    describe('pagination', () => {
      let harness: BackendHarness
      const spaceId = 'space-page'
      const ids = ['a1', 'a2', 'b1', 'b2', 'c1']
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
        for (const resourceId of ids) {
          await harness.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput({ id: resourceId })
          })
        }
        // A tombstone must be invisible to listings.
        await harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'zz-deleted',
          input: jsonInput({})
        })
        await harness.backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'zz-deleted'
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('pages in ascending id order with a cursor chain and totalItems', async () => {
        const { backend } = harness
        const page1 = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 2
        })
        assert.equal(page1.totalItems, ids.length)
        assert.deepEqual(
          page1.items.map(item => item.id),
          ['a1', 'a2']
        )
        assert.ok(page1.next)

        const cursor1 = new URL(page1.next!, 'http://x').searchParams.get(
          'cursor'
        )!
        const page2 = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 2,
          cursor: cursor1
        })
        assert.deepEqual(
          page2.items.map(item => item.id),
          ['b1', 'b2']
        )
        assert.ok(page2.next)

        const cursor2 = new URL(page2.next!, 'http://x').searchParams.get(
          'cursor'
        )!
        const page3 = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 2,
          cursor: cursor2
        })
        assert.deepEqual(
          page3.items.map(item => item.id),
          ['c1']
        )
        assert.equal(page3.next, undefined)
      })

      it('a page that exactly fills the Collection has no trailing empty page', async () => {
        const page = await harness.backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: ids.length
        })
        assert.equal(page.items.length, ids.length)
        assert.equal(page.next, undefined)
      })

      it('rejects a malformed cursor with InvalidCursorError', async () => {
        await expect(
          harness.backend.listCollectionItems({
            spaceId,
            collectionId: 'col',
            cursor: '!!!not-base64url!!!'
          })
        ).rejects.toBeInstanceOf(InvalidCursorError)
      })

      it('surfaces custom.name in listings', async () => {
        const { backend } = harness
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'a1',
          custom: { name: 'Named Resource' }
        })
        const page = await backend.listCollectionItems({
          spaceId,
          collectionId: 'col',
          limit: 1
        })
        assert.equal(page.items[0]!.name, 'Named Resource')
      })
    })

    describe('changes feed', () => {
      let harness: BackendHarness
      const spaceId = 'space-feed'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('advances updatedAt on an overwrite, and the overwrite reaches the feed', async () => {
        const { backend } = harness
        // Its own Collection, so the Resources it writes stay out of the
        // shared feed fixture the next test enumerates.
        const collectionId = 'col-overwrite'
        const resourceId = 'overwritten'
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: collectionId
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId,
          input: jsonInput({ n: 1 })
        })
        const first = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        })
        // The feed position a replicating client would checkpoint at after
        // seeing the create.
        const afterCreate = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 50
        })
        const checkpoint = afterCreate.checkpoint!
        // Far enough apart that the two writes cannot share a millisecond.
        await new Promise(resolve => setTimeout(resolve, 25))
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId,
          input: jsonInput({ n: 2 })
        })
        const second = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        })
        // An overwrite keeps the creation time and MOVES the modification
        // time forward. Binding one timestamp to both columns would rewind
        // `updatedAt` to the creation time instead.
        assert.equal(second!.createdAt, first!.createdAt)
        assert.ok(
          Date.parse(second!.updatedAt!) > Date.parse(first!.updatedAt!),
          'updatedAt must advance on an overwrite'
        )
        // A replica resuming from the create's checkpoint must be told about
        // the overwrite.
        const feed = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: checkpoint,
          limit: 50
        })
        assert.ok(
          resourceDocuments(feed.documents).some(
            doc => doc.resourceId === resourceId
          ),
          'an overwrite must surface in the change feed'
        )
      })

      it('orders by feed position, resumes from a checkpoint, and carries tombstones', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'one',
          input: jsonInput({ n: 1 })
        })
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'two',
          input: jsonInput({ n: 2 })
        })
        // A binary Resource is in the feed too, without `data`.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'bin',
          input: binaryInput(Buffer.from('x'))
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'one'
        })

        const full = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        // The Collection's create comes first, then the Resources in write
        // order.
        assert.deepEqual(
          full.documents.map(document =>
            document.kind === 'resource' ? document.resourceId : document.kind
          ),
          ['collection-metadata', 'two', 'bin', 'one']
        )
        const [live, bin, tombstone] = resourceDocuments(full.documents)
        assert.equal(live!.deleted, false)
        assert.equal(live!.contentType, 'application/json')
        assert.deepEqual(live!.data, { n: 2 })
        assert.equal(bin!.deleted, false)
        assert.equal(bin!.contentType, 'application/octet-stream')
        assert.equal(bin!.data, undefined)
        assert.equal(tombstone!.deleted, true)
        assert.equal(tombstone!.contentType, 'application/json')
        assert.equal(tombstone!.data, undefined)
        // The tombstone carries a content stamp later than the live write's.
        assert.ok(
          Date.parse(tombstone!.updatedAt) > Date.parse(live!.updatedAt) ||
            (tombstone!.updatedAt === live!.updatedAt &&
              tombstone!.updatedAtCounter > live!.updatedAtCounter),
          'a tombstone mints a later content stamp'
        )
        // Positions ascend through the page, and the page's checkpoint is the
        // last document's position.
        assert.ok(live!.feedPosition < tombstone!.feedPosition)
        assert.equal(full.checkpoint, tombstone!.feedPosition)

        // Paged: limit 1, then resume from the returned checkpoint.
        const page1 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 1
        })
        assert.equal(page1.documents.length, 1)
        assert.equal(page1.documents[0]!.kind, 'collection-metadata')
        const page2 = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          afterPosition: page1.checkpoint!,
          limit: 10
        })
        assert.deepEqual(
          resourceDocuments(page2.documents).map(
            document => document.resourceId
          ),
          ['two', 'bin', 'one']
        )

        // Nothing after the final checkpoint.
        const done = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          afterPosition: full.checkpoint!,
          limit: 10
        })
        assert.deepEqual(done.documents, [])
        assert.equal(done.checkpoint, null)
      })

      it('a metadata-only edit re-surfaces the Resource with custom, unchanged data/content stamp', async () => {
        const { backend } = harness
        const before = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        await backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'two',
          custom: { name: 'Two' }
        })
        const after = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          afterPosition: before.checkpoint!,
          limit: 100
        })
        assert.deepEqual(
          resourceDocuments(after.documents).map(
            document => document.resourceId
          ),
          ['two']
        )
        const doc = resourceDocuments(after.documents)[0]!
        const priorDoc = resourceDocuments(before.documents).find(
          document => document.resourceId === 'two'
        )!
        assert.equal(doc.updatedAt, priorDoc.updatedAt)
        assert.equal(doc.updatedAtCounter, priorDoc.updatedAtCounter)
        assert.equal(doc.originId, priorDoc.originId)
        assert.equal(priorDoc.meta, undefined)
        assert.ok(doc.meta?.updatedAt)
        assert.deepEqual(doc.data, { n: 2 })
        assert.deepEqual(doc.custom, { name: 'Two' })
      })

      it('a /meta write moves the Resource to a new position with its content stamp and validator unchanged', async () => {
        // Its own backend under a controlled clock, so a content re-stamp by
        // the /meta write would show in `updatedAt`.
        const clock = frozenClock()
        const stepped = await makeBackend({ physicalClock: clock.read })
        try {
          const { backend } = stepped
          const collectionId = 'col-meta-feed'
          await provisionSpace(backend, spaceId, collectionId)
          const target = { spaceId, collectionId, resourceId: 'r' }
          await backend.writeResource({ ...target, input: jsonInput({ n: 1 }) })
          const before = await backend.changesSince!({
            spaceId,
            collectionId,
            limit: 10
          })
          const [prior] = resourceDocuments(before.documents)
          assert.ok(prior)
          assert.equal(prior.meta, undefined)
          assert.equal(prior.metaValidator, undefined)
          const contentEtag = etagOf(await backend.getResource(target))
          assert.equal(formatEtag(prior.validator!), contentEtag)

          clock.now += 1000
          const meta1 = (
            await backend.writeResourceMetadata({
              ...target,
              custom: { name: 'First' }
            })
          )?.validator
          assert.ok(meta1)
          const first = await backend.changesSince!({
            spaceId,
            collectionId,
            afterPosition: before.checkpoint!,
            limit: 10
          })
          assert.equal(first.documents.length, 1)
          const [moved] = resourceDocuments(first.documents)
          assert.ok(moved)
          assert.equal(moved.resourceId, 'r')
          assert.ok(moved.feedPosition > prior.feedPosition)
          assert.equal(first.checkpoint, moved.feedPosition)
          // The top level is the content record, as before the /meta write.
          assert.deepEqual(stampOf(moved), stampOf(prior))
          assert.deepEqual(moved.validator, prior.validator)
          assert.equal(formatEtag(moved.validator!), contentEtag)
          assert.deepEqual(moved.data, { n: 1 })
          // The /meta record's new stamp rides under `meta`.
          assert.deepEqual(moved.meta, {
            generation: meta1.generation,
            ...meta1.stamp
          })
          assert.equal(formatEtag(moved.metaValidator!), formatEtag(meta1))
          assert.deepEqual(moved.custom, { name: 'First' })

          // A second /meta write, in the same millisecond, moves it again.
          const meta2 = (
            await backend.writeResourceMetadata({
              ...target,
              custom: { name: 'Second' }
            })
          )?.validator
          assert.ok(meta2)
          const second = await backend.changesSince!({
            spaceId,
            collectionId,
            afterPosition: first.checkpoint!,
            limit: 10
          })
          assert.equal(second.documents.length, 1)
          const [movedAgain] = resourceDocuments(second.documents)
          assert.ok(movedAgain)
          assert.ok(movedAgain.feedPosition > moved.feedPosition)
          assert.deepEqual(stampOf(movedAgain), stampOf(prior))
          assert.deepEqual(movedAgain.validator, prior.validator)
          assert.deepEqual(movedAgain.meta, {
            generation: meta2.generation,
            ...meta2.stamp
          })
          assert.ok(compareStamps(meta2.stamp, meta1.stamp) > 0)
          assert.equal(formatEtag(movedAgain.metaValidator!), formatEtag(meta2))
          assert.equal(etagOf(await backend.getResource(target)), contentEtag)

          // One document per record: the full feed holds the Resource once.
          const full = await backend.changesSince!({
            spaceId,
            collectionId,
            limit: 10
          })
          assert.deepEqual(
            resourceDocuments(full.documents).map(document => [
              document.resourceId,
              document.feedPosition
            ]),
            [['r', movedAgain.feedPosition]]
          )
        } finally {
          await stepped.cleanup()
        }
      })

      it('skips no write that lands in the checkpoint millisecond', async () => {
        // Its own backend under a frozen clock, so every write below lands in
        // one millisecond and only the stamp's counter tells them apart.
        const clock = frozenClock()
        const frozen = await makeBackend({ physicalClock: clock.read })
        const { backend } = frozen
        const collectionId = 'col-same-ms'
        await provisionSpace(backend, spaceId, collectionId)
        // The feed position, not `updatedAt`, is what the checkpoint rides
        // on.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'm',
          input: jsonInput({ n: 1 })
        })
        const first = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.deepEqual(
          resourceDocuments(first.documents).map(
            document => document.resourceId
          ),
          ['m']
        )

        // (a) The checkpointed Resource is rewritten in the same
        // millisecond: the next pull surfaces it.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'm',
          input: jsonInput({ n: 2 })
        })
        const second = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: first.checkpoint!,
          limit: 10
        })
        assert.deepEqual(
          resourceDocuments(second.documents).map(
            document => document.resourceId
          ),
          ['m']
        )
        assert.deepEqual(resourceDocuments(second.documents)[0]!.data, { n: 2 })

        // (b) A Resource whose id sorts below the checkpoint's, written in
        // the checkpoint's millisecond, is surfaced.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'a',
          input: jsonInput({ n: 3 })
        })
        const third = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: second.checkpoint!,
          limit: 10
        })
        assert.deepEqual(
          resourceDocuments(third.documents).map(
            document => document.resourceId
          ),
          ['a']
        )

        // (c) A checkpoint taken before a write, echoed back after it,
        // surfaces the write: the first checkpoint now yields both.
        const replay = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: first.checkpoint!,
          limit: 10
        })
        assert.deepEqual(
          resourceDocuments(replay.documents).map(
            document => document.resourceId
          ),
          ['m', 'a']
        )

        // The feed position orders the documents, not `updatedAt`: all three
        // writes shared one millisecond, and the stamp's counter tells them
        // apart, one tick per write in write order.
        const [original] = resourceDocuments(first.documents)
        const [rewritten, below] = resourceDocuments(replay.documents)
        assert.equal(rewritten!.updatedAt, original!.updatedAt)
        assert.equal(below!.updatedAt, original!.updatedAt)
        assert.equal(original!.updatedAt, new Date(clock.now).toISOString())
        assert.equal(
          rewritten!.updatedAtCounter,
          original!.updatedAtCounter + 1
        )
        assert.equal(below!.updatedAtCounter, original!.updatedAtCounter + 2)
        await frozen.cleanup()
      })

      it('a chunk write does not move its parent Resource in the feed', async () => {
        const { backend } = harness
        const collectionId = 'col-chunk-feed'
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: collectionId
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'parent',
          input: jsonInput({ chunked: true })
        })
        const before = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk'))
        })
        const after = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: before.checkpoint!,
          limit: 10
        })
        assert.deepEqual(after.documents, [])
        assert.equal(after.checkpoint, null)
      })

      it("import assigns fresh feed positions after the destination's own", async () => {
        const { backend } = harness
        const sourceSpaceId = 'space-feed-import-src'
        const targetSpaceId = 'space-feed-import-dst'
        await provisionSpace(backend, sourceSpaceId)
        await provisionSpace(backend, targetSpaceId)
        for (const resourceId of ['s1', 's2']) {
          await backend.writeResource({
            spaceId: sourceSpaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput({ resourceId })
          })
        }
        // The destination already holds history of its own.
        for (const resourceId of ['d1', 'd2', 'd3']) {
          await backend.writeResource({
            spaceId: targetSpaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput({ resourceId })
          })
        }
        const before = await backend.changesSince!({
          spaceId: targetSpaceId,
          collectionId: 'col',
          limit: 100
        })
        await importArchive({
          backend,
          spaceId: targetSpaceId,
          tarStream: await backend.exportSpace({ spaceId: sourceSpaceId })
        })
        const after = await backend.changesSince!({
          spaceId: targetSpaceId,
          collectionId: 'col',
          afterPosition: before.checkpoint!,
          limit: 100
        })
        assert.deepEqual(
          resourceDocuments(after.documents)
            .map(document => document.resourceId)
            .sort(),
          ['s1', 's2']
        )
        for (const document of after.documents) {
          assert.ok(document.feedPosition > before.checkpoint!)
        }

        // A feed position is one server's fact: no archive entry carries it.
        const entries = await extractTarEntries(
          await backend.exportSpace({ spaceId: sourceSpaceId })
        )
        for (const [entryName, entry] of entries) {
          assert.ok(
            !entryName.split('/').pop()!.startsWith('.feed.'),
            `unexpected feed counter entry ${entryName}`
          )
          if (entry.body !== undefined) {
            assert.ok(
              !entry.body.toString('utf8').includes('feedPosition'),
              `${entryName} carries a feed position`
            )
          }
        }
      })

      it('carries createdBy on live documents and on tombstones, and omits it when unrecorded', async () => {
        const { backend } = harness
        const feedSpaceId = 'space-feed-created-by'
        await provisionSpace(backend, feedSpaceId)
        await backend.writeResource({
          spaceId: feedSpaceId,
          collectionId: 'col',
          resourceId: 'live',
          input: jsonInput({ n: 1 }),
          createdBy: CREATOR_ONE
        })
        await backend.writeResource({
          spaceId: feedSpaceId,
          collectionId: 'col',
          resourceId: 'gone',
          input: jsonInput({ n: 2 }),
          createdBy: CREATOR_TWO
        })
        // Created with no invoker: nothing to replicate.
        await backend.writeResource({
          spaceId: feedSpaceId,
          collectionId: 'col',
          resourceId: 'anon',
          input: jsonInput({ n: 3 })
        })
        await backend.deleteResource({
          spaceId: feedSpaceId,
          collectionId: 'col',
          resourceId: 'gone'
        })

        const feed = await backend.changesSince!({
          spaceId: feedSpaceId,
          collectionId: 'col',
          limit: 100
        })
        const byId = new Map(
          resourceDocuments(feed.documents).map(document => [
            document.resourceId,
            document
          ])
        )
        assert.equal(byId.get('live')?.createdBy, CREATOR_ONE)
        assert.equal(byId.get('live')?.deleted, false)
        // A tombstone replicates its creator too.
        assert.equal(byId.get('gone')?.createdBy, CREATOR_TWO)
        assert.equal(byId.get('gone')?.deleted, true)
        assert.equal(byId.get('anon')?.createdBy, undefined)
      })

      it("carries the Resource's content validator, matching getResourceMetadata", async () => {
        const { backend } = harness
        const feedSpaceId = 'space-feed-generation'
        await provisionSpace(backend, feedSpaceId)
        await backend.writeResource({
          spaceId: feedSpaceId,
          collectionId: 'col',
          resourceId: 'one',
          input: jsonInput({ n: 1 })
        })

        const metadata = await backend.getResourceMetadata({
          spaceId: feedSpaceId,
          collectionId: 'col',
          resourceId: 'one'
        })
        const feed = await backend.changesSince!({
          spaceId: feedSpaceId,
          collectionId: 'col',
          limit: 100
        })
        const doc = resourceDocuments(feed.documents).find(
          document => document.resourceId === 'one'
        )
        assert.ok(doc, 'expected the Resource in the feed')
        assert.equal(doc!.validator?.generation, metadata!.generation)
        assert.equal(typeof doc!.validator?.generation, 'string')
        assert.equal(formatEtag(doc!.validator!), etagOf(metadata!))
      })

      it('reports a feed generation minted with the first position and replaced by a re-create', async () => {
        const { backend } = harness
        const collectionId = 'col-generation'
        const collectionMetadata = {
          id: collectionId,
          type: ['Collection'],
          name: collectionId
        }
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata
        })
        // The Collection's create took the first position, and minted the
        // generation with it.
        const created = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.equal(typeof created.feedGeneration, 'string')
        assert.deepEqual(
          created.documents.map(document => [
            document.kind,
            document.feedPosition
          ]),
          [['collection-metadata', 1]]
        )

        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'one',
          input: jsonInput({ n: 1 })
        })
        const first = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.equal(first.feedGeneration, created.feedGeneration)
        // Kept across later positions, and across an empty page.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'two',
          input: jsonInput({ n: 2 })
        })
        const second = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: first.checkpoint!,
          limit: 10
        })
        assert.equal(second.feedGeneration, first.feedGeneration)
        const drained = await backend.changesSince!({
          spaceId,
          collectionId,
          afterPosition: second.checkpoint!,
          limit: 10
        })
        assert.deepEqual(drained.documents, [])
        assert.equal(drained.feedGeneration, first.feedGeneration)

        // A re-create under the same id restarts the feed at 1 under a fresh
        // generation, so a position held from before cannot be read into it.
        await backend.deleteCollection({ spaceId, collectionId })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata
        })
        const reborn = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.equal(typeof reborn.feedGeneration, 'string')
        assert.notEqual(reborn.feedGeneration, first.feedGeneration)
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'one',
          input: jsonInput({ n: 1 })
        })
        const restarted = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.equal(restarted.feedGeneration, reborn.feedGeneration)
        assert.deepEqual(
          restarted.documents.map(document => [
            document.kind,
            document.feedPosition
          ]),
          [
            ['collection-metadata', 1],
            ['resource', 2]
          ]
        )
      })
    })

    describe('changes feed: every record kind', () => {
      let harness: BackendHarness
      const spaceId = 'space-feed-kinds'
      const logLine1 =
        '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n'
      const logLine2 =
        '{"state":{"scheme":"edv","version":1},"parameters":{}}\n'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /**
       * Creates a fresh Collection in this suite's Space and returns its id.
       */
      async function freshCollection(): Promise<string> {
        const collectionId = `col-${crypto.randomUUID()}`
        await harness.backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: collectionId
          }
        })
        return collectionId
      }

      /**
       * The whole feed of a Collection, or the part after `afterPosition`.
       */
      async function feedOf({
        collectionId,
        afterPosition
      }: {
        collectionId: string
        afterPosition?: number
      }) {
        return harness.backend.changesSince!({
          spaceId,
          collectionId,
          ...(afterPosition !== undefined && { afterPosition }),
          limit: 100
        })
      }

      /**
       * The one document of a kind in a page, asserting there is at most one.
       */
      function onlyOfKind<Kind extends FeedDocument['kind']>(
        page: { documents: FeedDocument[] },
        kind: Kind
      ): Extract<FeedDocument, { kind: Kind }> | undefined {
        const matches = page.documents.filter(
          (document): document is Extract<FeedDocument, { kind: Kind }> =>
            document.kind === kind
        )
        assert.ok(matches.length <= 1, `more than one ${kind} document`)
        return matches[0]
      }

      it('carries a binary Resource and its tombstone with contentType and no data', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'photo',
          input: binaryInput(Buffer.from('png bytes'), {
            contentType: 'image/png'
          })
        })
        const live = resourceDocuments(
          (await feedOf({ collectionId })).documents
        )
        assert.equal(live.length, 1)
        assert.equal(live[0]!.resourceId, 'photo')
        assert.equal(live[0]!.contentType, 'image/png')
        assert.equal(live[0]!.deleted, false)
        assert.equal(live[0]!.data, undefined)
        const metadata = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'photo'
        })
        assert.equal(formatEtag(live[0]!.validator!), etagOf(metadata!))

        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'photo'
        })
        const after = resourceDocuments(
          (await feedOf({ collectionId, afterPosition: live[0]!.feedPosition }))
            .documents
        )
        assert.equal(after.length, 1)
        assert.equal(after[0]!.resourceId, 'photo')
        assert.equal(after[0]!.deleted, true)
        // The tombstone keeps the last-known media type.
        assert.equal(after[0]!.contentType, 'image/png')
        assert.equal(after[0]!.data, undefined)
        assert.ok(after[0]!.feedPosition > live[0]!.feedPosition)
      })

      it('carries a text/jsonl Resource without data', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'did.jsonl',
          input: binaryInput(Buffer.from('{"a":1}\n'), {
            contentType: 'text/jsonl'
          })
        })
        const [document] = resourceDocuments(
          (await feedOf({ collectionId })).documents
        )
        assert.equal(document?.resourceId, 'did.jsonl')
        assert.equal(document?.contentType, 'text/jsonl')
        assert.equal(document?.deleted, false)
        assert.equal(document?.data, undefined)
      })

      it('a /meta write on a binary Resource re-surfaces it', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'blob',
          input: binaryInput(Buffer.from('blob'))
        })
        const before = await feedOf({ collectionId })
        const [prior] = resourceDocuments(before.documents)
        await backend.writeResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'blob',
          custom: { name: 'Blob' }
        })
        const after = resourceDocuments(
          (await feedOf({ collectionId, afterPosition: before.checkpoint! }))
            .documents
        )
        assert.equal(after.length, 1)
        assert.equal(after[0]!.resourceId, 'blob')
        assert.equal(after[0]!.contentType, 'application/octet-stream')
        assert.deepEqual(after[0]!.custom, { name: 'Blob' })
        assert.ok(after[0]!.meta)
        assert.ok(after[0]!.metaValidator)
        // The content stamp is unchanged by a metadata write.
        assert.equal(after[0]!.updatedAtCounter, prior!.updatedAtCounter)
        assert.equal(after[0]!.updatedAt, prior!.updatedAt)
      })

      it('a Collection create yields one collection-metadata document with its stamp and validator', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const page = await feedOf({ collectionId })
        assert.equal(page.documents.length, 1)
        const document = onlyOfKind(page, 'collection-metadata')
        assert.ok(document)
        assert.equal(document.feedPosition, 1)
        const stored = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.deepEqual(stampOf(document), stampOf(stored))
        assert.equal(formatEtag(document.validator!), metadataEtagOf(stored))
        assert.equal(page.checkpoint, 1)
      })

      it('a Collection Metadata update moves its document to a new position with the new stamp and validator', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: jsonInput({ n: 1 })
        })
        const before = await feedOf({ collectionId })
        const prior = onlyOfKind(before, 'collection-metadata')!
        const { validator } = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'renamed'
          }
        })
        const after = await feedOf({ collectionId })
        assert.deepEqual(
          after.documents.map(document => document.kind),
          ['resource', 'collection-metadata']
        )
        const moved = onlyOfKind(after, 'collection-metadata')!
        assert.ok(moved.feedPosition > prior.feedPosition)
        assert.equal(formatEtag(moved.validator!), formatEtag(validator))
        assert.deepEqual(stampOf(moved), validator.stamp)
        assert.ok(compareStamps(moved, prior) > 0)
        // A reader resuming after the old position sees only the move.
        const resumed = await feedOf({
          collectionId,
          afterPosition: before.checkpoint!
        })
        assert.deepEqual(
          resumed.documents.map(document => document.kind),
          ['collection-metadata']
        )
      })

      it('a governed-log create and an append each move one log document and leave the collection-metadata position', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const created = await feedOf({ collectionId })
        const metadataPosition = onlyOfKind(
          created,
          'collection-metadata'
        )!.feedPosition

        const logCreated = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: logLine1,
          ifNoneMatch: '*'
        })
        const afterCreate = await feedOf({ collectionId })
        assert.deepEqual(
          afterCreate.documents.map(document => document.kind),
          ['collection-metadata', 'log']
        )
        const firstLog = onlyOfKind(afterCreate, 'log')!
        assert.ok(firstLog.feedPosition > metadataPosition)
        assert.equal(formatEtag(firstLog.validator!), formatEtag(logCreated!))
        assert.deepEqual(stampOf(firstLog), logCreated!.stamp)
        // The log write advanced the object's local segment, which the
        // feed reports at the object's unmoved position.
        const metadataDocument = onlyOfKind(afterCreate, 'collection-metadata')!
        assert.equal(metadataDocument.feedPosition, metadataPosition)
        assert.equal(
          formatEtag(metadataDocument.validator!),
          metadataEtagOf(
            await backend.getCollectionMetadata({ spaceId, collectionId })
          )
        )
        assert.equal(metadataDocument.validator!.local, 1)

        const appended = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: logLine1 + logLine2,
          ifMatch: formatEtag(logCreated!)
        })
        const afterAppend = await feedOf({ collectionId })
        const secondLog = onlyOfKind(afterAppend, 'log')!
        assert.ok(secondLog.feedPosition > firstLog.feedPosition)
        assert.equal(formatEtag(secondLog.validator!), formatEtag(appended!))
        assert.equal(
          onlyOfKind(afterAppend, 'collection-metadata')!.feedPosition,
          metadataPosition
        )
        const resumed = await feedOf({
          collectionId,
          afterPosition: afterCreate.checkpoint!
        })
        assert.deepEqual(
          resumed.documents.map(document => document.kind),
          ['log']
        )

        // A byte-identical log write writes nothing and moves nothing.
        await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: logLine1 + logLine2,
          ifMatch: formatEtag(appended!)
        })
        const afterNoop = await feedOf({
          collectionId,
          afterPosition: afterAppend.checkpoint!
        })
        assert.deepEqual(afterNoop.documents, [])
        assert.equal(afterNoop.checkpoint, null)
      })

      it('a chunk write of a binary parent moves nothing', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'parent',
          input: binaryInput(Buffer.from('manifest'))
        })
        const before = await feedOf({ collectionId })
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk'))
        })
        const after = await feedOf({
          collectionId,
          afterPosition: before.checkpoint!
        })
        assert.deepEqual(after.documents, [])
      })

      it('gives unique, strictly ascending positions across kinds, and pages across them', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'json',
          input: jsonInput({ n: 1 })
        })
        await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: logLine1,
          ifNoneMatch: '*'
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'bin',
          input: binaryInput(Buffer.from('b'))
        })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: 'updated'
          }
        })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'json'
        })
        const full = await feedOf({ collectionId })
        const labels = full.documents.map(document =>
          document.kind === 'resource' ? document.resourceId : document.kind
        )
        assert.deepEqual(labels, ['log', 'bin', 'collection-metadata', 'json'])
        const positions = full.documents.map(document => document.feedPosition)
        for (let index = 1; index < positions.length; index++) {
          assert.ok(positions[index]! > positions[index - 1]!)
        }
        assert.equal(new Set(positions).size, positions.length)

        // Two documents a page, resuming from each page's checkpoint.
        const paged: string[] = []
        let afterPosition: number | undefined
        for (;;) {
          const page = await backend.changesSince!({
            spaceId,
            collectionId,
            ...(afterPosition !== undefined && { afterPosition }),
            limit: 2
          })
          if (page.checkpoint === null) {
            break
          }
          assert.ok(page.documents.length <= 2)
          paged.push(
            ...page.documents.map(document =>
              document.kind === 'resource' ? document.resourceId : document.kind
            )
          )
          afterPosition = page.checkpoint
        }
        assert.deepEqual(paged, labels)
      })

      it('an imported Collection takes fresh positions for its metadata, its log and its Resources', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const sourceSpaceId = 'space-feed-kinds-src'
          await provisionSpace(source.backend, sourceSpaceId)
          await source.backend.writeCollection({
            spaceId: sourceSpaceId,
            collectionId: 'governed',
            collectionMetadata: {
              id: 'governed',
              type: ['Collection'],
              name: 'governed'
            }
          })
          await source.backend.writeCollectionLog({
            spaceId: sourceSpaceId,
            collectionId: 'governed',
            body: logLine1,
            ifNoneMatch: '*'
          })
          // The envelope the governed Collection's `edv` scheme asks of
          // every write, since the import checks the archived Resources
          // against the log head, as a live write is checked.
          await source.backend.writeResource({
            spaceId: sourceSpaceId,
            collectionId: 'governed',
            resourceId: 'bin',
            input: jsonInput({
              id: 'urn:uuid:bin',
              sequence: 0,
              jwe: {
                protected: 'eyJlbmMiOiJYQzIwUCJ9',
                iv: 'aXY',
                ciphertext: 'Y2lwaGVydGV4dA',
                tag: 'dGFn'
              }
            })
          })
          // Move the source's positions well past the ones the import will
          // assign, so a carried position would show.
          for (let index = 0; index < 3; index++) {
            await source.backend.writeResourceMetadata({
              spaceId: sourceSpaceId,
              collectionId: 'governed',
              resourceId: 'bin',
              custom: { index }
            })
          }

          await provisionSpace(target.backend, sourceSpaceId)
          await importArchive({
            backend: target.backend,
            spaceId: sourceSpaceId,
            tarStream: await source.backend.exportSpace({
              spaceId: sourceSpaceId
            })
          })
          const feed = await target.backend.changesSince!({
            spaceId: sourceSpaceId,
            collectionId: 'governed',
            limit: 100
          })
          assert.deepEqual(
            feed.documents.map(document => [
              document.kind,
              document.feedPosition
            ]),
            [
              ['collection-metadata', 1],
              ['log', 2],
              ['resource', 3]
            ]
          )
          const stored = await target.backend.getCollectionMetadata({
            spaceId: sourceSpaceId,
            collectionId: 'governed'
          })
          assert.equal(
            formatEtag(onlyOfKind(feed, 'collection-metadata')!.validator!),
            metadataEtagOf(stored)
          )
          const log = await target.backend.getCollectionLog({
            spaceId: sourceSpaceId,
            collectionId: 'governed'
          })
          assert.equal(
            formatEtag(onlyOfKind(feed, 'log')!.validator!),
            formatEtag(log!.validator)
          )
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })
    })

    describe('blinded-index query', () => {
      let harness: BackendHarness
      const spaceId = 'space-blinded'
      const HMAC_ID = 'did:key:zHmacKeyA'
      const OTHER_HMAC_ID = 'did:key:zHmacKeyB'

      /**
       * A stored EDV encrypted-document envelope carrying one blinded
       * `indexed` entry. The attribute names/values stand in for the client's
       * HMAC-blinded base64url strings -- the backend matches them opaquely.
       */
      function envelope(
        docId: string,
        attributes: Array<{ name: string; value: string; unique?: boolean }>,
        hmacId = HMAC_ID
      ): unknown {
        return {
          id: docId,
          sequence: 0,
          indexed: [
            {
              hmac: { id: hmacId, type: 'Sha256HmacKey2019' },
              sequence: 0,
              attributes
            }
          ],
          jwe: {
            protected: 'eyJlbmMiOiJYQzIwUCJ9',
            iv: 'aXY',
            ciphertext: 'Y2lwaGVydGV4dA',
            tag: 'dGFn'
          }
        }
      }

      /** Runs a query and asserts it resolved a documents page (not a count). */
      async function queryPage(options: {
        equals?: Array<Record<string, string>>
        has?: string[]
        index?: string
        limit?: number
        cursor?: string
      }) {
        const { index = HMAC_ID, equals, has, limit, cursor } = options
        const result = await harness.backend.queryByBlindedIndex!({
          spaceId,
          collectionId: 'col',
          query: { index, ...(equals && { equals }), ...(has && { has }) },
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor })
        })
        assert.ok('documents' in result, 'expected a documents page')
        return result
      }

      /** The `id`s of a page's envelope documents. */
      function docIds(page: { documents: unknown[] }): string[] {
        return page.documents.map(document => (document as { id: string }).id)
      }

      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
        const { backend } = harness
        const write = (resourceId: string, document: unknown) =>
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput(document)
          })
        await write(
          'alpha',
          envelope('alpha', [
            { name: 'n1', value: 'v1' },
            { name: 'n2', value: 'v2' }
          ])
        )
        await write('beta', envelope('beta', [{ name: 'n1', value: 'v1' }]))
        await write('gamma', envelope('gamma', [{ name: 'n1', value: 'vX' }]))
        // Indexed under a different HMAC key: invisible to HMAC_ID queries.
        await write(
          'other-key',
          envelope('other-key', [{ name: 'n1', value: 'v1' }], OTHER_HMAC_ID)
        )
        // A JSON document with no `indexed` at all: never matches.
        await write('plain', { plain: true })
        // Binary and tombstoned resources are excluded from the candidate set.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'bin',
          input: binaryInput(Buffer.from('x'))
        })
        await write('gone', envelope('gone', [{ name: 'n1', value: 'v1' }]))
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'gone'
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('equals matches by blinded name/value, in ascending resourceId order, documents verbatim', async () => {
        const page = await queryPage({ equals: [{ n1: 'v1' }] })
        // 'other-key' (different hmac id) and 'gone' (tombstone) excluded.
        assert.deepEqual(docIds(page), ['alpha', 'beta'])
        assert.equal(page.hasMore, false)
        assert.equal(page.cursor, undefined)
        // The stored envelope passes through untouched (jwe and all).
        assert.deepEqual(
          page.documents[0],
          envelope('alpha', [
            { name: 'n1', value: 'v1' },
            { name: 'n2', value: 'v2' }
          ])
        )
      })

      it('equals ANDs the pairs within one element', async () => {
        const page = await queryPage({ equals: [{ n1: 'v1', n2: 'v2' }] })
        assert.deepEqual(docIds(page), ['alpha'])
        const none = await queryPage({ equals: [{ n1: 'v1', n2: 'nope' }] })
        assert.deepEqual(none.documents, [])
      })

      it('equals ORs across array elements', async () => {
        const page = await queryPage({
          equals: [{ n2: 'v2' }, { n1: 'vX' }]
        })
        assert.deepEqual(docIds(page), ['alpha', 'gamma'])
      })

      it('an empty equals element matches nothing (Mongo $all:[] parity)', async () => {
        const page = await queryPage({ equals: [{}] })
        assert.deepEqual(page.documents, [])
      })

      it('has requires every named attribute, value-independent', async () => {
        const one = await queryPage({ has: ['n1'] })
        assert.deepEqual(docIds(one), ['alpha', 'beta', 'gamma'])
        const both = await queryPage({ has: ['n1', 'n2'] })
        assert.deepEqual(docIds(both), ['alpha'])
      })

      it('an unknown index matches nothing', async () => {
        const page = await queryPage({
          index: 'did:key:zUnregistered',
          equals: [{ n1: 'v1' }]
        })
        assert.deepEqual(page.documents, [])
        assert.equal(page.hasMore, false)
      })

      it('count resolves only the match total', async () => {
        const result = await harness.backend.queryByBlindedIndex!({
          spaceId,
          collectionId: 'col',
          query: { index: HMAC_ID, equals: [{ n1: 'v1' }] },
          count: true
        })
        assert.deepEqual(result, { count: 2 })
      })

      it('paginates with the opaque cursor chain', async () => {
        const page1 = await queryPage({ has: ['n1'], limit: 2 })
        assert.deepEqual(docIds(page1), ['alpha', 'beta'])
        assert.equal(page1.hasMore, true)
        assert.ok(page1.cursor, 'expected a cursor on a non-final page')

        const page2 = await queryPage({
          has: ['n1'],
          limit: 2,
          cursor: page1.cursor
        })
        assert.deepEqual(docIds(page2), ['gamma'])
        assert.equal(page2.hasMore, false)
        assert.equal(page2.cursor, undefined)
      })

      it('a page that exactly fills the matches has no trailing empty page', async () => {
        const page = await queryPage({ has: ['n1'], limit: 3 })
        assert.deepEqual(docIds(page), ['alpha', 'beta', 'gamma'])
        assert.equal(page.hasMore, false)
      })

      it('rejects a malformed cursor with InvalidCursorError', async () => {
        await expect(
          harness.backend.queryByBlindedIndex!({
            spaceId,
            collectionId: 'col',
            query: { index: HMAC_ID, has: ['n1'] },
            cursor: 'not!!valid'
          })
        ).rejects.toBeInstanceOf(InvalidCursorError)
      })

      it('resolves empty on an absent Collection', async () => {
        const result = await harness.backend.queryByBlindedIndex!({
          spaceId,
          collectionId: 'no-such-collection',
          query: { index: HMAC_ID, has: ['n1'] }
        })
        assert.ok('documents' in result)
        assert.deepEqual(result.documents, [])
      })
    })

    describe('unique plaintext indexes (declaration read under the lock)', () => {
      let harness: BackendHarness
      const spaceId = 'space-unique-plaintext'

      function write(resourceId: string, data: unknown) {
        return harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId,
          input: jsonInput(data)
        })
      }

      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('a write takes the unique declaration from the stored Collection Metadata object, with no option passed', async () => {
        await write('holder', { slug: 'one' })
        // No declaration yet: a duplicate is admitted.
        await write('twin', { slug: 'one' })
        await harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'twin',
          input: jsonInput({ slug: 'other' })
        })
        await harness.backend.writeCollection({
          spaceId,
          collectionId: 'col',
          collectionMetadata: {
            id: 'col',
            type: ['Collection'],
            plaintext: { indexes: [{ name: 'slug', unique: true }] }
          }
        })
        await expect(write('claimant', { slug: 'one' })).rejects.toBeInstanceOf(
          UniqueAttributeConflictError
        )
        // A `custom`-sourced claim reads the same declaration.
        await harness.backend.writeCollection({
          spaceId,
          collectionId: 'col',
          collectionMetadata: {
            id: 'col',
            type: ['Collection'],
            plaintext: {
              indexes: [{ name: 'name', source: 'custom', unique: true }]
            }
          }
        })
        await harness.backend.writeResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'holder',
          custom: { name: 'same', tags: [] }
        })
        await expect(
          harness.backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'twin',
            custom: { name: 'same', tags: [] }
          })
        ).rejects.toBeInstanceOf(UniqueAttributeConflictError)
      })
    })

    describe('unique blinded attributes (write-time enforcement)', () => {
      let harness: BackendHarness
      const spaceId = 'space-unique'
      const HMAC_ID = 'did:key:zHmacKeyA'
      const OTHER_HMAC_ID = 'did:key:zHmacKeyB'

      /** An envelope with one indexed entry; attributes may carry `unique`. */
      function envelope(
        docId: string,
        attributes: Array<{ name: string; value: string; unique?: boolean }>,
        hmacId = HMAC_ID
      ): unknown {
        return {
          id: docId,
          sequence: 0,
          indexed: [
            {
              hmac: { id: hmacId, type: 'Sha256HmacKey2019' },
              sequence: 0,
              attributes
            }
          ],
          jwe: {
            protected: 'eyJlbmMiOiJYQzIwUCJ9',
            iv: 'aXY',
            ciphertext: 'Y2lwaGVydGV4dA',
            tag: 'dGFn'
          }
        }
      }

      function write(resourceId: string, document: unknown) {
        return harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId,
          input: jsonInput(document)
        })
      }

      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('rejects a second claim of a unique triple with UniqueAttributeConflictError (409)', async () => {
        await write(
          'holder',
          envelope('holder', [{ name: 'n1', value: 'v1', unique: true }])
        )
        await expect(
          write(
            'claimant',
            envelope('claimant', [{ name: 'n1', value: 'v1', unique: true }])
          )
        ).rejects.toBeInstanceOf(UniqueAttributeConflictError)
        await expect(
          write(
            'claimant',
            envelope('claimant', [{ name: 'n1', value: 'v1', unique: true }])
          )
        ).rejects.toMatchObject({ statusCode: 409 })
      })

      it('conflicts require unique on BOTH sides (reference-server parity)', async () => {
        // The same (name, value) WITHOUT `unique` coexists with the holder's
        // unique claim...
        await write(
          'nonunique',
          envelope('nonunique', [{ name: 'n1', value: 'v1' }])
        )
        // ...and a unique claim does not conflict with an existing NON-unique
        // holder of the same pair either (only unique-vs-unique collides).
        await write(
          'plain-pair',
          envelope('plain-pair', [{ name: 'nX', value: 'vX' }])
        )
        await write(
          'unique-over-plain',
          envelope('unique-over-plain', [
            { name: 'nX', value: 'vX', unique: true }
          ])
        )
      })

      it('keys on the full (hmac id, name, value) triple', async () => {
        // The same unique (name, value) under a DIFFERENT HMAC key: no conflict.
        await write(
          'other-key',
          envelope(
            'other-key',
            [{ name: 'n1', value: 'v1', unique: true }],
            OTHER_HMAC_ID
          )
        )
      })

      it('an update keeping its own unique attribute never self-conflicts', async () => {
        const prior = await harness.backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'holder'
        })
        const rewritten = await write(
          'holder',
          envelope('holder', [{ name: 'n1', value: 'v1', unique: true }])
        )
        assertEtagAdvanced({
          before: etagOf(prior),
          after: formatEtag(rewritten.validator)
        })
      })

      it("an update claiming another live document's unique triple is rejected", async () => {
        await write(
          'mover',
          envelope('mover', [{ name: 'n2', value: 'v2', unique: true }])
        )
        await expect(
          write(
            'mover',
            envelope('mover', [{ name: 'n1', value: 'v1', unique: true }])
          )
        ).rejects.toBeInstanceOf(UniqueAttributeConflictError)
      })

      it('a tombstoned holder frees its unique claim', async () => {
        await write(
          'ghost',
          envelope('ghost', [{ name: 'n3', value: 'v3', unique: true }])
        )
        await harness.backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'ghost'
        })
        await write(
          'successor',
          envelope('successor', [{ name: 'n3', value: 'v3', unique: true }])
        )
      })

      it('the unique conflict (409) wins over a failing precondition (412)', async () => {
        // Both apply: the write claims a held unique triple AND carries a
        // stale If-Match. Both backends must agree on the precedence.
        await expect(
          harness.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'claimant',
            input: jsonInput(
              envelope('claimant', [{ name: 'n1', value: 'v1', unique: true }])
            ),
            ifMatch: '"staleGen.1.0.x"'
          })
        ).rejects.toBeInstanceOf(UniqueAttributeConflictError)
      })

      it('exactly one of N concurrent claimants of a unique triple wins', async () => {
        const claimants = ['c1', 'c2', 'c3', 'c4', 'c5']
        const results = await Promise.allSettled(
          claimants.map(resourceId =>
            write(
              resourceId,
              envelope(resourceId, [
                { name: 'race', value: 'token', unique: true }
              ])
            )
          )
        )
        const wins = results.filter(result => result.status === 'fulfilled')
        const losses = results.filter(
          result =>
            result.status === 'rejected' &&
            result.reason instanceof UniqueAttributeConflictError
        )
        assert.equal(wins.length, 1, 'exactly one claimant must win')
        assert.equal(losses.length, claimants.length - 1)
      })
    })

    describe('quotas and upload caps', () => {
      // Capacities are sized generously (hundreds of KB) so the filesystem
      // backend's `du` figure -- which includes metadata files and block
      // overhead -- stays negligible next to the resource bodies.
      it('rejects a write that would exceed capacity with QuotaExceededError (507)', async () => {
        const harness = await makeBackend({ capacityBytes: 200_000 })
        try {
          await provisionSpace(harness.backend, 'space-q')
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-q',
              collectionId: 'col',
              resourceId: 'big',
              input: binaryInput(Buffer.alloc(300_000))
            })
          ).rejects.toBeInstanceOf(QuotaExceededError)
        } finally {
          await harness.cleanup()
        }
      })

      it('gives a failed write its byte-quota reservation back', async () => {
        const harness = await makeBackend({ capacityBytes: 200_000 })
        try {
          await provisionSpace(harness.backend, 'quota-rollback')
          // Passes the pre-flight (150k of 200k) and reserves that much
          // against the cached usage, then the body fails mid-stream.
          await assert.rejects(
            harness.backend.writeResource({
              spaceId: 'quota-rollback',
              collectionId: 'col',
              resourceId: 'aborted',
              input: abortedBinaryInput(150_000)
            }),
            /client went away/
          )
          // Nothing landed, so a write that fits the real usage is admitted;
          // a reservation that outlived the failure would refuse it (100k on
          // top of a phantom 150k exceeds 200k).
          await harness.backend.writeResource({
            spaceId: 'quota-rollback',
            collectionId: 'col',
            resourceId: 'fits',
            input: binaryInput(Buffer.alloc(100_000), {
              declaredBytes: 100_000
            })
          })
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects an oversize upload with PayloadTooLargeError (413)', async () => {
        const harness = await makeBackend({ maxUploadBytes: 64 })
        try {
          await provisionSpace(harness.backend, 'space-413')
          // Known-size JSON body over the cap.
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-413',
              collectionId: 'col',
              resourceId: 'json-big',
              input: jsonInput({ blob: 'x'.repeat(200) })
            })
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
          // Declared-size binary over the cap.
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-413',
              collectionId: 'col',
              resourceId: 'declared-big',
              input: binaryInput(Buffer.alloc(128), { declaredBytes: 128 })
            })
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
          // Undeclared-size stream over the cap (caught by the counting guard).
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-413',
              collectionId: 'col',
              resourceId: 'stream-big',
              input: binaryInput(Buffer.alloc(128))
            })
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
          // A small write still succeeds.
          await harness.backend.writeResource({
            spaceId: 'space-413',
            collectionId: 'col',
            resourceId: 'small',
            input: binaryInput(Buffer.alloc(16))
          })
        } finally {
          await harness.cleanup()
        }
      })

      it('reports usage and derived state', async () => {
        const harness = await makeBackend({ capacityBytes: 1_000_000 })
        try {
          await provisionSpace(harness.backend, 'space-report')
          const body = Buffer.alloc(100_000)
          await harness.backend.writeResource({
            spaceId: 'space-report',
            collectionId: 'col',
            resourceId: 'r',
            input: binaryInput(body)
          })
          const usage = await harness.backend.reportUsage({
            spaceId: 'space-report',
            includeCollections: true
          })
          assert.equal(usage.state, 'ok')
          assert.deepEqual(usage.limit, {
            capacityBytes: 1_000_000,
            isUnlimited: false
          })
          if (exactUsage) {
            assert.equal(usage.usageBytes, body.length)
            assert.deepEqual(usage.usageByCollection, [
              { id: 'col', usageBytes: body.length }
            ])
          } else {
            // The filesystem figure comes from `du`, whose units and rounding
            // are platform-dependent (macOS BSD `du` reports 512-byte block
            // counts); only its presence and shape are asserted here.
            assert.ok(usage.usageBytes >= 0)
          }
        } finally {
          await harness.cleanup()
        }
      })

      it('a delete frees quota headroom', async () => {
        const harness = await makeBackend({ capacityBytes: 200_000 })
        // Sizes are declared up front: the filesystem's cumulative accounting
        // counts declared bytes between `du` re-measurements, while an
        // undeclared stream is only TTL-bounded (its documented soft spot).
        const body = () =>
          binaryInput(Buffer.alloc(150_000), { declaredBytes: 150_000 })
        try {
          await provisionSpace(harness.backend, 'space-free')
          await harness.backend.writeResource({
            spaceId: 'space-free',
            collectionId: 'col',
            resourceId: 'a',
            input: body()
          })
          await expect(
            harness.backend.writeResource({
              spaceId: 'space-free',
              collectionId: 'col',
              resourceId: 'b',
              input: body()
            })
          ).rejects.toBeInstanceOf(QuotaExceededError)
          await harness.backend.deleteResource({
            spaceId: 'space-free',
            collectionId: 'col',
            resourceId: 'a'
          })
          await harness.backend.writeResource({
            spaceId: 'space-free',
            collectionId: 'col',
            resourceId: 'b',
            input: body()
          })
        } finally {
          await harness.cleanup()
        }
      })

      // The hard-limit-under-concurrency guarantee: N concurrent writers race
      // for headroom that only fits some of them; the accepted total must
      // never overshoot. Only the transactional (Postgres) accounting passes
      // this strictly -- the filesystem's documented soft limit skips it.
      it.runIf(hardQuota)(
        'enforces the quota as a hard limit under concurrent writers',
        async () => {
          const bodyBytes = 1000
          const capacityBytes = 3500 // fits 3 of 8 writers
          const harness = await makeBackend({ capacityBytes })
          try {
            await provisionSpace(harness.backend, 'space-race')
            const attempts = await Promise.allSettled(
              Array.from({ length: 8 }, (_, index) =>
                harness.backend.writeResource({
                  spaceId: 'space-race',
                  collectionId: 'col',
                  resourceId: `racer-${index}`,
                  input: binaryInput(Buffer.alloc(bodyBytes))
                })
              )
            )
            const accepted = attempts.filter(
              attempt => attempt.status === 'fulfilled'
            ).length
            const rejected = attempts.filter(
              attempt =>
                attempt.status === 'rejected' &&
                attempt.reason instanceof QuotaExceededError
            ).length
            assert.equal(accepted, 3)
            assert.equal(rejected, 5)
            const usage = await harness.backend.reportUsage({
              spaceId: 'space-race'
            })
            assert.equal(usage.usageBytes, accepted * bodyBytes)
          } finally {
            await harness.cleanup()
          }
        }
      )
    })

    describe('count quotas', () => {
      // Small caps (2-3) keep these fast; both backends enforce on the create
      // path only, reusing the `quota-exceeded` (507) problem type.
      function assertCountQuota(error: unknown): void {
        assert.ok(
          error instanceof CountQuotaExceededError,
          `expected CountQuotaExceededError, got ${error}`
        )
        assert.equal(error.statusCode, 507)
        assert.ok(error.type.endsWith('#quota-exceeded'))
      }

      it('rejects a Space create beyond maxSpacesPerController; a different controller is unaffected', async () => {
        const harness = await makeBackend({ maxSpacesPerController: 2 })
        const alice = 'did:key:z6MkCountAlice' as IDID
        const bob = 'did:key:z6MkCountBob' as IDID
        const writeSpace = (spaceId: string, controller: IDID) =>
          harness.backend.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              name: spaceId,
              controller
            }
          })
        try {
          await writeSpace('cq-a1', alice)
          await writeSpace('cq-a2', alice)
          let error: unknown
          try {
            await writeSpace('cq-a3', alice)
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
          // Overwriting an existing Space's metadata still succeeds at the
          // limit (an update is not a create).
          await writeSpace('cq-a1', alice)
          // A different controller can still create.
          await writeSpace('cq-b1', bob)
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects a Collection create beyond maxCollectionsPerSpace; overwriting an existing one still succeeds', async () => {
        const harness = await makeBackend({ maxCollectionsPerSpace: 2 })
        const writeCollection = (collectionId: string) =>
          harness.backend.writeCollection({
            spaceId: 'cq-cols',
            collectionId,
            collectionMetadata: {
              id: collectionId,
              type: ['Collection'],
              name: collectionId
            }
          })
        try {
          // provisionSpace writes the Space plus one Collection ('col'); add
          // one more to reach the cap of 2.
          await provisionSpace(harness.backend, 'cq-cols')
          await writeCollection('col2')
          let error: unknown
          try {
            await writeCollection('col3')
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
          // Overwriting an existing Collection metadata at the limit is fine.
          await writeCollection('col2')
        } finally {
          await harness.cleanup()
        }
      })

      it('rejects an import that would create more Collections than maxCollectionsPerSpace allows', async () => {
        const source = await makeBackend()
        const target = await makeBackend({ maxCollectionsPerSpace: 2 })
        try {
          const spaceId = 'cq-imp-cols'
          // Source Space with three Collections (each carrying a Resource so
          // the Collection travels in the export).
          await provisionSpace(source.backend, spaceId) // 'col'
          for (const collectionId of ['c2', 'c3']) {
            await source.backend.writeCollection({
              spaceId,
              collectionId,
              collectionMetadata: {
                id: collectionId,
                type: ['Collection'],
                name: collectionId
              }
            })
          }
          for (const collectionId of ['col', 'c2', 'c3']) {
            await source.backend.writeResource({
              spaceId,
              collectionId,
              resourceId: 'doc',
              input: jsonInput({ id: collectionId })
            })
          }
          const tarStream = await source.backend.exportSpace({ spaceId })
          // Target already holds 'col' (1 of 2). The import creates a second
          // Collection (reaching the cap) then a third, which exceeds it.
          await provisionSpace(target.backend, spaceId)
          let error: unknown
          try {
            await importArchive({ backend: target.backend, spaceId, tarStream })
          } catch (err) {
            error = err
          }
          assertCountQuota(error)
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('allows an import that only re-imports existing (skipped) items at the limit', async () => {
        const source = await makeBackend()
        const target = await makeBackend({ maxCollectionsPerSpace: 1 })
        try {
          const spaceId = 'cq-imp-skip'
          await provisionSpace(source.backend, spaceId)
          for (const resourceId of ['r1', 'r2']) {
            await source.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
          const tarStream = await source.backend.exportSpace({ spaceId })
          // Target already holds the identical Space exactly at its Collection
          // cap (1 Collection); re-importing the same archive skips every item,
          // so no create is attempted and nothing is rejected.
          await provisionSpace(target.backend, spaceId)
          for (const resourceId of ['r1', 'r2']) {
            await target.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
          const stats = await importArchive({
            backend: target.backend,
            spaceId,
            tarStream
          })
          assert.equal(stats.collectionsCreated, 0)
          assert.equal(stats.collectionsSkipped, 1)
          assert.equal(stats.resourcesCreated, 0)
          assert.equal(stats.resourcesSkipped, 2)
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('the default-on limits (100/100) do not trip normal writes', async () => {
        // A backend built with no count options still has the defaults active;
        // provisioning and a handful of writes must not be rejected.
        const harness = await makeBackend()
        try {
          await provisionSpace(harness.backend, 'cq-default')
          for (const resourceId of ['x1', 'x2', 'x3']) {
            await harness.backend.writeResource({
              spaceId: 'cq-default',
              collectionId: 'col',
              resourceId,
              input: jsonInput({ id: resourceId })
            })
          }
        } finally {
          await harness.cleanup()
        }
      })
    })

    describe('writes into a container with no Metadata object', () => {
      let harness: BackendHarness
      const policy = { type: 'PublicCanRead' } as unknown as Parameters<
        StorageBackend['writePolicy']
      >[0]['policy']
      const json: ResourceInput = {
        kind: 'json',
        contentType: 'application/json',
        data: { hello: 'world' }
      }
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /**
       * Provisions a Space with one Collection holding one Resource, then
       * deletes the Space: the request layer's existence check has passed by
       * the time each write below reaches the backend.
       */
      async function deletedSpace(spaceId: string): Promise<void> {
        const { backend } = harness
        await provisionSpace(backend, spaceId)
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: json
        })
        assert.ok(await backend.getSpaceMetadata({ spaceId }))
        await backend.deleteSpace({ spaceId })
      }

      /**
       * Re-creates the Space under the same id and asserts it adopted nothing
       * from the previous life.
       */
      async function assertNothingAdopted(spaceId: string): Promise<void> {
        const { backend } = harness
        await backend.writeSpace({
          spaceId,
          spaceMetadata: {
            id: spaceId,
            type: ['Space'],
            controller: CONTROLLER
          }
        })
        const listing = await backend.listCollections({ spaceId })
        assert.deepEqual(listing.items, [])
        assert.equal(await backend.getPolicy({ spaceId }), undefined)
        assert.equal(
          await backend.getPolicy({ spaceId, collectionId: 'col' }),
          undefined
        )
        assert.deepEqual(await backend.listBackends({ spaceId }), [])
      }

      it('refuses every write into a deleted Space, and the next Space under its id adopts nothing', async () => {
        const { backend } = harness
        const spaceId = 'space-gone'
        await deletedSpace(spaceId)

        await assert.rejects(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'r2',
            input: json
          }),
          isNotFound
        )
        await assert.rejects(
          backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'r',
            chunkIndex: 0,
            input: binaryInput(Buffer.from('chunk'))
          }),
          isNotFound
        )
        await assert.rejects(
          backend.writeCollection({
            spaceId,
            collectionId: 'col',
            collectionMetadata: { id: 'col', type: ['Collection'] }
          }),
          isNotFound
        )
        await assert.rejects(
          backend.writePolicy({ spaceId, policy }),
          isNotFound
        )
        await assert.rejects(
          backend.writePolicy({ spaceId, collectionId: 'col', policy }),
          isNotFound
        )
        await assert.rejects(
          backend.writeBackend({
            spaceId,
            backendId: 'ext-1',
            record: {
              id: 'ext-1',
              provider: 'test-provider',
              managedBy: 'external',
              connection: { kind: 'inmem' }
            } as StoredBackendRecord
          }),
          isNotFound
        )
        const pack = tar.pack()
        pack.entry(
          { name: 'manifest.yml' },
          'ubc-version: "0.1"\ncontents:\n  space: https://example/spec#spaces\n'
        )
        pack.entry({ name: `space/${spaceId}/col/`, type: 'directory' })
        pack.finalize()
        await assert.rejects(
          importArchive({
            backend: backend,
            spaceId,
            tarStream: Readable.from(pack)
          }),
          isNotFound
        )

        assert.equal(await backend.getSpaceMetadata({ spaceId }), undefined)
        assert.equal(
          (await backend.listSpaces()).some(space => space.id === spaceId),
          false
        )
        await assertNothingAdopted(spaceId)
      })

      it('a write racing the Space delete that removes its container leaves nothing behind', async () => {
        const { backend } = harness
        const spaceId = 'space-queued'
        await provisionSpace(backend, spaceId)
        // The request layer's existence check has passed; the delete and the
        // write then race. Either the write lands first and the delete removes
        // it, or it lands second and is refused. Neither order may leave data
        // for the next Space under this id.
        const deletion = backend.deleteSpace({ spaceId })
        const write = backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'late',
          input: json
        })
        await deletion
        const [outcome] = await Promise.allSettled([write])
        if (outcome!.status === 'rejected') {
          assert.ok(isNotFound(outcome!.reason), String(outcome!.reason))
        }
        await assertNothingAdopted(spaceId)
      })

      it('a revocation insert racing the Space delete leaves no record for the next Space', async () => {
        const { backend } = harness
        const capabilities = [
          {
            capabilityId: 'urn:zcap:raced-revocation',
            delegator: 'did:key:z6MkDelegator'
          }
        ]
        const record = revocationRecord(capabilities[0]!)
        // Both issue orders. Either the insert lands first and the delete
        // removes it, or it lands second and is refused with a 404. Neither
        // order may leave a record for the next Space under this id.
        for (const deleteFirst of [true, false]) {
          const spaceId = `space-rev-race-${deleteFirst ? 'delete' : 'insert'}`
          await provisionSpace(backend, spaceId)
          const operations = deleteFirst
            ? [
                backend.deleteSpace({ spaceId }),
                backend.insertRevocation({ scope: { spaceId }, record })
              ]
            : [
                backend.insertRevocation({ scope: { spaceId }, record }),
                backend.deleteSpace({ spaceId })
              ]
          const [first, second] = await Promise.allSettled(operations)
          const deletion = deleteFirst ? first! : second!
          const insertion = deleteFirst ? second! : first!
          assert.equal(deletion.status, 'fulfilled')
          if (insertion.status === 'rejected') {
            assert.ok(isNotFound(insertion.reason), String(insertion.reason))
          }
          await assertNothingAdopted(spaceId)
          assert.equal(
            await backend.isRevoked({ scope: { spaceId }, capabilities }),
            false
          )
          // Gone, not merely shadowed: the same pair inserts again cleanly.
          await backend.insertRevocation({ scope: { spaceId }, record })
        }
      })

      it('refuses Resource, chunk and policy writes into a deleted Collection', async () => {
        const { backend } = harness
        const spaceId = 'space-col-gone'
        await provisionSpace(backend, spaceId)
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: json
        })
        await backend.deleteCollection({ spaceId, collectionId: 'col' })

        await assert.rejects(
          backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'r2',
            input: json
          }),
          isNotFound
        )
        await assert.rejects(
          backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'r',
            chunkIndex: 0,
            input: binaryInput(Buffer.from('chunk'))
          }),
          isNotFound
        )
        await assert.rejects(
          backend.writePolicy({ spaceId, collectionId: 'col', policy }),
          isNotFound
        )
        const listing = await backend.listCollections({ spaceId })
        assert.deepEqual(listing.items, [])
      })

      it('refuses a policy on a Collection that was never created, and lists no Collection for it', async () => {
        const { backend } = harness
        const spaceId = 'space-no-col'
        await provisionSpace(backend, spaceId)
        await assert.rejects(
          backend.writePolicy({ spaceId, collectionId: 'phantom', policy }),
          isNotFound
        )
        const listing = await backend.listCollections({ spaceId })
        assert.deepEqual(
          listing.items.map(collection => collection.id),
          ['col']
        )
      })
    })

    describe('policies', () => {
      let harness: BackendHarness
      const spaceId = 'space-pol'
      const policy = { rules: [] } as unknown as Parameters<
        StorageBackend['writePolicy']
      >[0]['policy']
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
        // A Resource-level policy is written only over a live Resource.
        await harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({ hello: 'world' })
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('stores independent policies at all three levels', async () => {
        const { backend } = harness
        await backend.writePolicy({ spaceId, policy })
        await backend.writePolicy({ spaceId, collectionId: 'col', policy })
        await backend.writePolicy({
          spaceId,
          collectionId: 'col',
          resourceId: 'r',
          policy
        })
        assert.ok(await backend.getPolicy({ spaceId }))
        assert.ok(await backend.getPolicy({ spaceId, collectionId: 'col' }))
        assert.ok(
          await backend.getPolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'r'
          })
        )
        await backend.deletePolicy({ spaceId, collectionId: 'col' })
        assert.equal(
          await backend.getPolicy({ spaceId, collectionId: 'col' }),
          undefined
        )
        // The other two levels are untouched.
        assert.ok(await backend.getPolicy({ spaceId }))
        assert.ok(
          await backend.getPolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'r'
          })
        )
      })
    })

    describe('policy validators, preconditions and tombstones', () => {
      let harness: BackendHarness
      const spaceId = 'space-pol-versioned'
      const publicRead = { type: 'PublicCanRead' }
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
        // A Resource-level policy is written only over a live Resource.
        for (const resourceId of ['r-stamp', 'r-pre', 'r-tomb']) {
          await harness.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput({ resourceId })
          })
        }
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /**
       * The three policy levels, each under ids of its own so the cases
       * below do not share a record.
       */
      function levels(tag: string) {
        return [
          { spaceId: `${spaceId}` },
          { spaceId, collectionId: 'col' },
          { spaceId, collectionId: 'col', resourceId: `r-${tag}` }
        ]
      }

      it('stamps a write, serves the stamp members, and keeps the generation across an update', async () => {
        const { backend } = harness
        const target = { spaceId, collectionId: 'col', resourceId: 'r-stamp' }
        const created = await backend.writePolicy({
          ...target,
          policy: {
            ...publicRead,
            // A body's stamp members, `deleted` and `_generation` are not
            // stored from it.
            updatedAt: '2001-01-01T00:00:00.000Z',
            updatedAtCounter: 99,
            originId: 'forged',
            deleted: true,
            _generation: 'forged'
          }
        })
        assert.equal(created.created, true)
        assert.equal(created.validator.stamp.originId, backend.originId)
        assert.deepEqual(created.policy, {
          type: 'PublicCanRead',
          ...created.validator.stamp
        })
        assert.deepEqual(await backend.getPolicy(target), created.policy)
        const record = await backend.getPolicyRecord(target)
        assert.equal(record?.deleted, false)
        assert.deepEqual(record?.validator, created.validator)
        assert.notEqual(created.validator.generation, 'forged')

        const updated = await backend.writePolicy({
          ...target,
          policy: { type: 'Other' }
        })
        assert.equal(updated.created, false)
        assertValidatorAdvanced(created.validator, updated.validator)
      })

      it('evaluates If-Match and If-None-Match against the live policy', async () => {
        const { backend } = harness
        for (const target of levels('pre')) {
          await backend.deletePolicy(target)
          const { validator } = await backend.writePolicy({
            ...target,
            policy: publicRead,
            ifNoneMatch: '*'
          })
          const etag = formatEtag(validator)
          await expect(
            backend.writePolicy({
              ...target,
              policy: publicRead,
              ifNoneMatch: '*'
            })
          ).rejects.toBeInstanceOf(PreconditionFailedError)
          await expect(
            backend.writePolicy({
              ...target,
              policy: publicRead,
              ifMatch: etagWithCounterBumped({ validator, by: 1 })
            })
          ).rejects.toBeInstanceOf(PreconditionFailedError)
          await expect(
            backend.deletePolicy({
              ...target,
              ifMatch: etagWithCounterBumped({ validator, by: 1 })
            })
          ).rejects.toBeInstanceOf(PreconditionFailedError)
          const { validator: next } = await backend.writePolicy({
            ...target,
            policy: publicRead,
            ifMatch: etag
          })
          assertValidatorAdvanced(validator, next)
          const tombstone = await backend.deletePolicy({
            ...target,
            ifMatch: formatEtag(next)
          })
          assert.ok(tombstone)
          // A tombstone reads as absent: `If-Match` fails against it, and a
          // guarded create passes.
          await expect(
            backend.writePolicy({
              ...target,
              policy: publicRead,
              ifMatch: formatEtag(tombstone)
            })
          ).rejects.toBeInstanceOf(PreconditionFailedError)
          const recreated = await backend.writePolicy({
            ...target,
            policy: publicRead,
            ifNoneMatch: '*'
          })
          assert.equal(recreated.created, true)
        }
      })

      it('leaves a tombstone that reads as absent, and a write over it mints a new generation', async () => {
        const { backend } = harness
        for (const target of levels('tomb')) {
          const live = await backend.writePolicy({
            ...target,
            policy: publicRead
          })
          const tombstone = await backend.deletePolicy(target)
          assert.ok(tombstone)
          assertValidatorAdvanced(live.validator, tombstone)
          assert.equal(await backend.getPolicy(target), undefined)
          const record = await backend.getPolicyRecord(target)
          assert.ok(record?.deleted)
          assert.deepEqual(record.tombstone, {
            deleted: true,
            ...tombstone.stamp
          })
          assert.deepEqual(record.validator, tombstone)

          // A second delete, and a delete of a policy never written, write
          // nothing.
          assert.equal(await backend.deletePolicy(target), undefined)
          assert.deepEqual(
            (await backend.getPolicyRecord(target))?.validator,
            tombstone
          )

          const recreated = await backend.writePolicy({
            ...target,
            policy: publicRead
          })
          assert.equal(recreated.created, true)
          assert.notEqual(recreated.validator.generation, tombstone.generation)
          assert.ok(
            compareStamps(recreated.validator.stamp, tombstone.stamp) > 0
          )
        }
        assert.equal(
          await backend.deletePolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'never-written'
          }),
          undefined
        )
        assert.equal(
          await backend.getPolicyRecord({
            spaceId,
            collectionId: 'col',
            resourceId: 'never-written'
          }),
          undefined
        )
      })

      it('refuses a Resource-level policy over an absent or tombstoned Resource', async () => {
        const { backend } = harness
        await expect(
          backend.writePolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'r-never',
            policy: publicRead
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
        assert.equal(
          await backend.getPolicyRecord({
            spaceId,
            collectionId: 'col',
            resourceId: 'r-never'
          }),
          undefined
        )

        const target = { spaceId, collectionId: 'col', resourceId: 'r-gone' }
        await backend.writeResource({ ...target, input: jsonInput({ n: 1 }) })
        await backend.deleteResource(target)
        await expect(
          backend.writePolicy({ ...target, policy: publicRead })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
        assert.equal(await backend.getPolicyRecord(target), undefined)

        await backend.writeResource({ ...target, input: jsonInput({ n: 2 }) })
        const written = await backend.writePolicy({
          ...target,
          policy: publicRead
        })
        assert.equal(written.created, true)

        // The caller waives the check when the Collection's Resources live
        // on another backend, which this store cannot see.
        const elsewhere = { ...target, resourceId: 'r-elsewhere' }
        const waived = await backend.writePolicy({
          ...elsewhere,
          policy: publicRead,
          requireLiveResource: false
        })
        assert.equal(waived.created, true)
      })

      it('tombstones a Resource policy when the Resource is deleted', async () => {
        const { backend } = harness
        const cascadeSpace = 'space-pol-cascade'
        await provisionSpace(backend, cascadeSpace, 'feed')
        const target = {
          spaceId: cascadeSpace,
          collectionId: 'feed',
          resourceId: 'doc'
        }
        await backend.writeResource({ ...target, input: jsonInput({ n: 1 }) })
        const live = await backend.writePolicy({
          ...target,
          policy: publicRead
        })
        const start = await backend.changesSince!({
          spaceId: cascadeSpace,
          collectionId: 'feed',
          limit: 100
        })

        await backend.deleteResource(target)
        assert.equal(await backend.getPolicy(target), undefined)
        const record = await backend.getPolicyRecord(target)
        assert.ok(record?.deleted && record.validator)
        // The tombstone keeps the generation and takes a stamp above the
        // live policy's.
        assert.equal(record.validator.generation, live.validator.generation)
        assert.ok(
          compareStamps(record.validator.stamp, live.validator.stamp) > 0
        )

        // The policy tombstone follows the Resource tombstone in the feed.
        const page = await backend.changesSince!({
          spaceId: cascadeSpace,
          collectionId: 'feed',
          afterPosition: start.checkpoint ?? 0,
          limit: 100
        })
        assert.deepEqual(
          page.documents.map(document => [
            document.kind,
            'deleted' in document && document.deleted
          ]),
          [
            ['resource', true],
            ['policy', true]
          ]
        )
        assert.equal(
          page.documents[1]!.feedPosition,
          page.documents[0]!.feedPosition + 1
        )
        const policyDocument = page.documents[1] as Extract<
          FeedDocument,
          { kind: 'policy' }
        >
        assert.equal(policyDocument.resourceId, 'doc')
        assert.deepEqual(policyDocument.validator, record.validator)

        // A second delete writes nothing, and a re-create starts with no
        // policy.
        await backend.deleteResource(target)
        assert.deepEqual(
          (await backend.getPolicyRecord(target))?.validator,
          record.validator
        )
        await backend.writeResource({ ...target, input: jsonInput({ n: 2 }) })
        assert.equal(await backend.getPolicy(target), undefined)

        // A delete of a Resource with no policy writes no policy record.
        const bare = { ...target, resourceId: 'bare' }
        await backend.writeResource({ ...bare, input: jsonInput({ n: 1 }) })
        await backend.deleteResource(bare)
        assert.equal(await backend.getPolicyRecord(bare), undefined)
      })

      it('lists a Collection whose policy was deleted as not public', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-pol-public', 'shared')
        await backend.writePolicy({
          spaceId: 'space-pol-public',
          collectionId: 'shared',
          policy: publicRead
        })
        const before = await backend.listCollections({
          spaceId: 'space-pol-public'
        })
        assert.equal((before.items[0] as CollectionSummary).public, true)
        await backend.deletePolicy({
          spaceId: 'space-pol-public',
          collectionId: 'shared'
        })
        const after = await backend.listCollections({
          spaceId: 'space-pol-public'
        })
        assert.equal((after.items[0] as CollectionSummary).public, false)
      })

      it('puts a Collection or Resource policy write and tombstone in the feed, and no Space policy', async () => {
        const { backend } = harness
        const feedSpace = 'space-pol-feed'
        await provisionSpace(backend, feedSpace, 'feed')
        await backend.writeResource({
          spaceId: feedSpace,
          collectionId: 'feed',
          resourceId: 'doc',
          input: jsonInput({ hello: 'world' })
        })
        const start = await backend.changesSince!({
          spaceId: feedSpace,
          collectionId: 'feed',
          limit: 100
        })
        const after = start.checkpoint ?? 0
        await backend.writePolicy({ spaceId: feedSpace, policy: publicRead })
        const collectionPolicy = await backend.writePolicy({
          spaceId: feedSpace,
          collectionId: 'feed',
          policy: publicRead
        })
        await backend.writePolicy({
          spaceId: feedSpace,
          collectionId: 'feed',
          resourceId: 'doc',
          policy: publicRead
        })
        const resourceTombstone = await backend.deletePolicy({
          spaceId: feedSpace,
          collectionId: 'feed',
          resourceId: 'doc'
        })
        const page = await backend.changesSince!({
          spaceId: feedSpace,
          collectionId: 'feed',
          afterPosition: after,
          limit: 100
        })
        const policies = page.documents.filter(
          (document): document is Extract<FeedDocument, { kind: 'policy' }> =>
            document.kind === 'policy'
        )
        // One document per record, at the position of its latest write.
        assert.equal(policies.length, 2)
        const [collectionDocument, resourceDocument] = policies
        assert.equal(collectionDocument!.resourceId, undefined)
        assert.equal(collectionDocument!.deleted, false)
        assert.deepEqual(
          collectionDocument!.validator,
          collectionPolicy.validator
        )
        assert.deepEqual(
          stampOf(collectionDocument),
          collectionPolicy.validator.stamp
        )
        assert.equal(resourceDocument!.resourceId, 'doc')
        assert.equal(resourceDocument!.deleted, true)
        assert.deepEqual(resourceDocument!.validator, resourceTombstone)
        assert.ok(
          resourceDocument!.feedPosition > collectionDocument!.feedPosition
        )
        assert.equal(page.checkpoint, resourceDocument!.feedPosition)

        // Caught up: nothing past the last position.
        const caughtUp = await backend.changesSince!({
          spaceId: feedSpace,
          collectionId: 'feed',
          afterPosition: page.checkpoint!,
          limit: 100
        })
        assert.equal(caughtUp.documents.length, 0)

        // A page cut at the first policy document resumes at the second.
        const firstOnly = await backend.changesSince!({
          spaceId: feedSpace,
          collectionId: 'feed',
          afterPosition: after,
          limit: 1
        })
        assert.equal(firstOnly.documents.length, 1)
        assert.equal(firstOnly.documents[0]!.kind, 'policy')
      })

      it('exports live policies with their stamp and generation, and imports keep the generation under a fresh stamp', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const exportSpaceId = 'space-pol-export'
          await provisionSpace(source.backend, exportSpaceId)
          const spacePolicy = await source.backend.writePolicy({
            spaceId: exportSpaceId,
            policy: publicRead
          })
          await source.backend.writePolicy({
            spaceId: exportSpaceId,
            collectionId: 'col',
            policy: publicRead
          })
          await source.backend.deletePolicy({
            spaceId: exportSpaceId,
            collectionId: 'col'
          })
          await source.backend.writeResource({
            spaceId: exportSpaceId,
            collectionId: 'col',
            resourceId: 'doc',
            input: jsonInput({ n: 1 })
          })
          const resourcePolicy = await source.backend.writePolicy({
            spaceId: exportSpaceId,
            collectionId: 'col',
            resourceId: 'doc',
            policy: publicRead
          })

          const entries = await extractTarEntries(
            await source.backend.exportSpace({ spaceId: exportSpaceId })
          )
          const prefix = `space/${exportSpaceId}/`
          // The tombstoned Collection policy does not travel.
          assert.equal(
            entries.get(`${prefix}col/.collection.policy.json`),
            undefined
          )
          const archivedSpacePolicy = JSON.parse(
            entries.get(`${prefix}.space.policy.json`)!.body!.toString('utf8')
          )
          assert.deepEqual(archivedSpacePolicy, {
            ...spacePolicy.policy,
            _generation: spacePolicy.validator.generation
          })
          const archivedResourcePolicy = JSON.parse(
            entries
              .get(`${prefix}col/.r.doc.policy.json`)!
              .body!.toString('utf8')
          )
          assert.deepEqual(archivedResourcePolicy, {
            ...resourcePolicy.policy,
            _generation: resourcePolicy.validator.generation
          })

          // The destination holds a tombstone at the Space level: the import
          // skips the archived Space policy rather than undo the delete.
          await target.backend.writeSpace({
            spaceId: exportSpaceId,
            spaceMetadata: {
              id: exportSpaceId,
              type: ['Space'],
              name: 'Target',
              controller: CONTROLLER
            }
          })
          await target.backend.writePolicy({
            spaceId: exportSpaceId,
            policy: publicRead
          })
          await target.backend.deletePolicy({ spaceId: exportSpaceId })
          const stats = await importArchive({
            backend: target.backend,
            spaceId: exportSpaceId,
            tarStream: await source.backend.exportSpace({
              spaceId: exportSpaceId
            })
          })
          assert.equal(stats.policiesCreated, 1)
          assert.equal(stats.policiesSkipped, 1)
          assert.equal(
            await target.backend.getPolicy({ spaceId: exportSpaceId }),
            undefined
          )
          const imported = await target.backend.getPolicyRecord({
            spaceId: exportSpaceId,
            collectionId: 'col',
            resourceId: 'doc'
          })
          assert.equal(imported?.deleted, false)
          assert.equal(
            imported!.validator?.generation,
            resourcePolicy.validator.generation
          )
          assert.equal(
            imported!.validator?.stamp.originId,
            target.backend.originId
          )
          assert.notEqual(
            imported!.validator?.stamp.originId,
            resourcePolicy.validator.stamp.originId
          )
          // The imported policy takes a position in the destination's feed.
          const feed = await target.backend.changesSince!({
            spaceId: exportSpaceId,
            collectionId: 'col',
            limit: 100
          })
          assert.ok(
            feed.documents.some(
              document =>
                document.kind === 'policy' && document.resourceId === 'doc'
            )
          )
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })
    })

    describe('registered external backends', () => {
      let harness: BackendHarness
      const spaceId = 'space-back'
      const record: StoredBackendRecord = {
        id: 'gdrive-1',
        name: 'Drive',
        managedBy: 'external',
        provider: 'gdrive',
        connection: {
          kind: 'oauth-token',
          accessToken: 'SECRET-TOKEN'
        } as unknown as StoredBackendRecord['connection']
      }
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('round-trips the full record via getBackend and sanitizes listings', async () => {
        const { backend } = harness
        await backend.writeBackend({
          spaceId,
          backendId: record.id,
          record
        })
        const stored = await backend.getBackend({
          spaceId,
          backendId: record.id
        })
        assert.deepEqual(stored, record)
        const listed = await backend.listBackends({ spaceId })
        assert.equal(listed.length, 1)
        assert.equal(listed[0]!.id, record.id)
        // The secret boundary: no raw connection material in the listing.
        assert.equal(JSON.stringify(listed).includes('SECRET-TOKEN'), false)
        await backend.deleteBackend({ spaceId, backendId: record.id })
        assert.equal(
          await backend.getBackend({ spaceId, backendId: record.id }),
          undefined
        )
      })

      it('a registration and a removal each advance the Space Metadata local segment, stamp and generation kept', async () => {
        // The served Space Metadata object lists the registrations under
        // `backends`, so its strong validator must move with them; the body
        // is untouched, so the generation and the write stamp stay and only
        // the local segment advances.
        const { backend } = harness
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        const registered = { ...record, id: 'gdrive-2' }
        await backend.writeBackend({
          spaceId,
          backendId: registered.id,
          record: registered
        })
        const afterWrite = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterWrite.metaLocal, before.metaLocal! + 1)
        assert.equal(afterWrite.updatedAt, before.updatedAt)
        assert.equal(afterWrite.updatedAtCounter, before.updatedAtCounter)
        assert.equal(afterWrite.originId, before.originId)
        assert.notEqual(metadataEtagOf(afterWrite), metadataEtagOf(before))
        assert.equal(afterWrite.metaGeneration, before.metaGeneration)
        assert.equal(afterWrite.name, before.name)

        await backend.deleteBackend({ spaceId, backendId: registered.id })
        const afterDelete = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterDelete.metaLocal, before.metaLocal! + 2)
        assert.equal(afterDelete.updatedAt, before.updatedAt)
        assert.equal(afterDelete.metaGeneration, before.metaGeneration)

        // Removing an absent record changes the listing not at all.
        await backend.deleteBackend({ spaceId, backendId: registered.id })
        const unchanged = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(unchanged.metaLocal, afterDelete.metaLocal)
        assert.equal(metadataEtagOf(unchanged), metadataEtagOf(afterDelete))
      })
    })

    describe('replica registrations', () => {
      let harness: BackendHarness
      const spaceId = 'space-replicas'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('creates a registration once, and reads it back whole', async () => {
        const { backend } = harness
        const record = replicaRegistration({ id: 'peer-a', spaceId })
        const space = (await backend.getSpaceMetadata({ spaceId }))!
        const stored = await backend.createReplica({
          spaceId,
          record,
          pullsChunks: true
        })
        // The stored record is the client's shape under the write's stamp,
        // which the store's clock minted, and no `pausedAt`.
        const stamp = stampOf(stored.record)
        assert.ok(isWriteStamp(stamp))
        assert.equal(stamp.originId, backend.originId)
        assert.deepEqual(withoutStampMembers(stored.record), record)
        assert.equal(stored.record.pausedAt, undefined)
        assert.equal(stored.pullsChunks, true)
        assert.ok(isMintedGeneration(stored.generation))
        assert.equal(stored.spaceGeneration, space.metaGeneration)
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId: 'peer-a' }),
          stored
        )
        await assert.rejects(
          backend.createReplica({ spaceId, record, pullsChunks: false }),
          (err: unknown) =>
            err instanceof ProblemError && err.statusCode === 409
        )
        // The refused create left the stored record as it was.
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId: 'peer-a' }),
          stored
        )
      })

      it('refuses a registration on a Space with no Metadata object', async () => {
        const { backend } = harness
        await assert.rejects(
          backend.createReplica({
            spaceId: 'space-replicas-absent',
            record: replicaRegistration({
              id: 'peer-a',
              spaceId: 'space-replicas-absent'
            }),
            pullsChunks: false
          }),
          isNotFound
        )
        assert.deepEqual(
          await backend.listReplicas({ spaceId: 'space-replicas-absent' }),
          []
        )
      })

      it('lists a Space registrations by id, and every registration in the store', async () => {
        const { backend } = harness
        const otherSpace = 'space-replicas-other'
        await provisionSpace(backend, otherSpace)
        await backend.createReplica({
          spaceId,
          record: replicaRegistration({ id: 'peer-0', spaceId }),
          pullsChunks: false
        })
        await backend.createReplica({
          spaceId: otherSpace,
          record: replicaRegistration({ id: 'peer-z', spaceId: otherSpace }),
          pullsChunks: false
        })
        assert.deepEqual(
          (await backend.listReplicas({ spaceId })).map(
            replica => replica.record.id
          ),
          ['peer-0', 'peer-a']
        )
        const all = await backend.listAllReplicas()
        assert.deepEqual(
          all
            .map(replica => `${replica.spaceId}/${replica.record.id}`)
            .filter(key => key.startsWith('space-replicas'))
            .sort(),
          [
            `${spaceId}/peer-0`,
            `${spaceId}/peer-a`,
            `${otherSpace}/peer-z`
          ].sort()
        )
        assert.equal(
          all.find(replica => replica.record.id === 'peer-z')!.record.capability
            .id,
          REPLICA_CAPABILITY_ID
        )
      })

      it('a registration and a removal each advance the Space Metadata local segment', async () => {
        const { backend } = harness
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        await backend.createReplica({
          spaceId,
          record: replicaRegistration({ id: 'peer-local', spaceId }),
          pullsChunks: false
        })
        const afterCreate = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterCreate.metaLocal, before.metaLocal! + 1)
        assert.equal(afterCreate.metaGeneration, before.metaGeneration)
        assert.deepEqual(stampOf(afterCreate), stampOf(before))

        assert.equal(
          await backend.deleteReplica({ spaceId, replicaId: 'peer-local' }),
          true
        )
        const afterDelete = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterDelete.metaLocal, before.metaLocal! + 2)
        assert.deepEqual(stampOf(afterDelete), stampOf(before))
        assert.equal(
          await backend.getReplica({ spaceId, replicaId: 'peer-local' }),
          undefined
        )

        // Removing an absent registration changes nothing.
        assert.equal(
          await backend.deleteReplica({ spaceId, replicaId: 'peer-local' }),
          false
        )
        const unchanged = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(metadataEtagOf(unchanged), metadataEtagOf(afterDelete))
      })

      it('keeps loop state beside the record, and drops it with the record', async () => {
        const { backend } = harness
        const replicaId = 'peer-state'
        const record = replicaRegistration({ id: replicaId, spaceId })
        const created = await backend.createReplica({
          spaceId,
          record,
          pullsChunks: false
        })
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
        const state: ReplicaLoopState = {
          lastPullAt: '2026-10-04T00:00:00.000Z',
          failures: 2,
          collections: {
            col: {
              state: 'stalled',
              checkpoint: 'opaque',
              generation: 'gen',
              stall: {
                reason: 'fork',
                since: '2026-10-04T00:00:00.000Z',
                detail: 'a fork'
              }
            }
          }
        }
        assert.equal(
          await backend.writeReplicaState({ spaceId, replicaId, state }),
          true
        )
        assert.deepEqual(
          await backend.getReplicaState({ spaceId, replicaId }),
          state
        )
        // A state write leaves the record as it was.
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId }),
          created
        )

        assert.equal(await backend.deleteReplica({ spaceId, replicaId }), true)
        assert.equal(
          await backend.writeReplicaState({ spaceId, replicaId, state }),
          false
        )
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
        // A registration made again under the id starts with no state.
        await backend.createReplica({ spaceId, record, pullsChunks: false })
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
        assert.equal(
          (await backend.listReplicas({ spaceId })).filter(
            replica => replica.record.id === replicaId
          ).length,
          1
        )
      })

      it('leaves registrations and their state out of an export', async () => {
        const { backend } = harness
        const replicaId = 'peer-export'
        await backend.createReplica({
          spaceId,
          record: replicaRegistration({ id: replicaId, spaceId }),
          pullsChunks: false
        })
        await backend.writeReplicaState({
          spaceId,
          replicaId,
          state: { collections: { col: { state: 'synced' } } }
        })
        const archive = Buffer.from(
          await collectBytes(await backend.exportSpace({ spaceId }))
        ).toString('latin1')
        assert.equal(archive.includes(REPLICA_CAPABILITY_ID), false)
        assert.equal(archive.includes('.replica.'), false)
        assert.equal(archive.includes(replicaId), false)
        // The Space still lists its Collection only.
        assert.deepEqual(
          (await backend.listCollections({ spaceId })).items.map(
            item => item.id
          ),
          ['col']
        )
      })

      it('Delete Space removes the registrations and their state', async () => {
        const { backend } = harness
        const doomed = 'space-replicas-doomed'
        await provisionSpace(backend, doomed)
        const record = replicaRegistration({ id: 'peer-a', spaceId: doomed })
        const first = await backend.createReplica({
          spaceId: doomed,
          record,
          pullsChunks: false
        })
        await backend.writeReplicaState({
          spaceId: doomed,
          replicaId: 'peer-a',
          state: { collections: {} }
        })
        await backend.deleteSpace({ spaceId: doomed })
        assert.equal(
          await backend.getReplica({ spaceId: doomed, replicaId: 'peer-a' }),
          undefined
        )
        assert.deepEqual(await backend.listReplicas({ spaceId: doomed }), [])
        assert.equal(
          (await backend.listAllReplicas()).some(
            replica => replica.spaceId === doomed
          ),
          false
        )
        // A Space made again under the id takes a registration afresh, under
        // the new Space generation.
        await provisionSpace(backend, doomed)
        const second = await backend.createReplica({
          spaceId: doomed,
          record,
          pullsChunks: false
        })
        assert.notEqual(second.spaceGeneration, first.spaceGeneration)
        assert.equal(
          await backend.getReplicaState({
            spaceId: doomed,
            replicaId: 'peer-a'
          }),
          undefined
        )
      })

      it("creates a registration paused, under the write's own time", async () => {
        const { backend } = harness
        const record = replicaRegistration({ id: 'peer-paused', spaceId })
        const stored = await backend.createReplica({
          spaceId,
          record: { ...record, pausedAt: '2001-01-01T00:00:00.000Z' },
          pullsChunks: false
        })
        assert.equal(stored.record.pausedAt, stored.record.updatedAt)
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId: 'peer-paused' }),
          stored
        )
      })

      it('writeReplica creates when absent and replaces in place when stored', async () => {
        const { backend } = harness
        const record = replicaRegistration({ id: 'peer-put', spaceId })
        const space = (await backend.getSpaceMetadata({ spaceId }))!

        // A create: generation minted, local segment advanced.
        const created = await backend.writeReplica({
          spaceId,
          record,
          pullsChunks: false
        })
        assert.equal(created.prior, undefined)
        assert.ok(isMintedGeneration(created.stored.generation))
        assert.deepEqual(withoutStampMembers(created.stored.record), record)
        const afterCreate = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterCreate.metaLocal, space.metaLocal! + 1)
        const state = {
          collections: { col: { state: 'synced' as const, checkpoint: 'c1' } }
        }
        assert.ok(
          await backend.writeReplicaState({
            spaceId,
            replicaId: 'peer-put',
            state
          })
        )

        // A replacement that pauses: same generation, a stamp above, the
        // loop state kept, the Space Metadata object untouched.
        const replacement = {
          ...record,
          capability: { ...record.capability, id: 'urn:uuid:replacement' }
        }
        const paused = await backend.writeReplica({
          spaceId,
          record: { ...replacement, pausedAt: '2001-01-01T00:00:00.000Z' },
          pullsChunks: true
        })
        assert.deepEqual(paused.prior, created.stored)
        assert.equal(paused.stored.generation, created.stored.generation)
        assert.equal(
          paused.stored.spaceGeneration,
          created.stored.spaceGeneration
        )
        assert.ok(
          compareStamps(
            stampOf(paused.stored.record) as WriteStamp,
            stampOf(created.stored.record) as WriteStamp
          ) > 0
        )
        assert.equal(paused.stored.record.capability.id, 'urn:uuid:replacement')
        assert.equal(paused.stored.pullsChunks, true)
        assert.equal(
          paused.stored.record.pausedAt,
          paused.stored.record.updatedAt
        )
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId: 'peer-put' }),
          paused.stored
        )
        assert.deepEqual(
          await backend.getReplicaState({ spaceId, replicaId: 'peer-put' }),
          state
        )
        const afterReplace = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterReplace.metaLocal, afterCreate.metaLocal)

        // Paused again: the stored pause time is kept. A client value is
        // ignored.
        const stillPaused = await backend.writeReplica({
          spaceId,
          record: { ...replacement, pausedAt: '2002-01-01T00:00:00.000Z' },
          pullsChunks: true
        })
        assert.equal(
          stillPaused.stored.record.pausedAt,
          paused.stored.record.pausedAt
        )
        assert.notEqual(
          formatEtag(replicaValidator(stillPaused.stored)),
          formatEtag(replicaValidator(paused.stored))
        )

        // Resumed: the member is dropped.
        const resumed = await backend.writeReplica({
          spaceId,
          record: replacement,
          pullsChunks: true
        })
        assert.equal(resumed.stored.record.pausedAt, undefined)
      })

      it('writeReplica keeps pullsChunks under an unchanged capability and the fixed members', async () => {
        const { backend } = harness
        const record = replicaRegistration({ id: 'peer-fixed', spaceId })
        const created = await backend.writeReplica({
          spaceId,
          record,
          pullsChunks: true
        })
        assert.equal(created.stored.pullsChunks, true)
        // The stored capability stands, and the stored value with it.
        const kept = await backend.writeReplica({
          spaceId,
          record,
          pullsChunks: false
        })
        assert.equal(kept.stored.pullsChunks, true)
        // A new capability takes the value given for it.
        const swapped = await backend.writeReplica({
          spaceId,
          record: {
            ...record,
            capability: { ...record.capability, id: 'urn:uuid:swapped' }
          },
          pullsChunks: false
        })
        assert.equal(swapped.stored.pullsChunks, false)
        // A change to a fixed member refuses the write and leaves the stored
        // registration.
        await assert.rejects(
          backend.writeReplica({
            spaceId,
            record: { ...record, role: 'source', collections: [{ id: 'x' }] },
            pullsChunks: false
          }),
          (err: unknown) =>
            err instanceof InvalidRequestBodyError &&
            err.problems?.[0]?.pointer === '#/collections'
        )
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId: 'peer-fixed' }),
          swapped.stored
        )
      })

      it('writeReplica evaluates If-Match and If-None-Match: * atomically', async () => {
        const { backend } = harness
        const record = replicaRegistration({ id: 'peer-cas', spaceId })
        const created = await backend.writeReplica({
          spaceId,
          record,
          pullsChunks: false,
          ifNoneMatch: '*'
        })
        assert.equal(created.prior, undefined)
        const etag = formatEtag(replicaValidator(created.stored))

        await assert.rejects(
          backend.writeReplica({
            spaceId,
            record,
            pullsChunks: false,
            ifNoneMatch: '*'
          }),
          (err: unknown) => err instanceof PreconditionFailedError
        )
        await assert.rejects(
          backend.writeReplica({
            spaceId,
            record,
            pullsChunks: false,
            ifMatch: '"stale.0.0.none"'
          }),
          (err: unknown) => err instanceof PreconditionFailedError
        )
        // The refused writes left the record as it was.
        assert.deepEqual(
          await backend.getReplica({ spaceId, replicaId: 'peer-cas' }),
          created.stored
        )

        const matched = await backend.writeReplica({
          spaceId,
          record: { ...record, pausedAt: '2001-01-01T00:00:00.000Z' },
          pullsChunks: false,
          ifMatch: etag
        })
        assert.deepEqual(matched.prior, created.stored)
        assert.notEqual(formatEtag(replicaValidator(matched.stored)), etag)

        // If-Match on an absent registration cannot be satisfied.
        await assert.rejects(
          backend.writeReplica({
            spaceId,
            record: replicaRegistration({ id: 'peer-absent', spaceId }),
            pullsChunks: false,
            ifMatch: '*'
          }),
          (err: unknown) => err instanceof PreconditionFailedError
        )
        assert.equal(
          await backend.getReplica({ spaceId, replicaId: 'peer-absent' }),
          undefined
        )
      })

      it('writeReplica refuses a Space with no Metadata object', async () => {
        const { backend } = harness
        await assert.rejects(
          backend.writeReplica({
            spaceId: 'space-replicas-absent',
            record: replicaRegistration({
              id: 'peer-a',
              spaceId: 'space-replicas-absent'
            }),
            pullsChunks: false
          }),
          isNotFound
        )
      })
    })

    describe('the creating stamp of a Collection', () => {
      let harness: BackendHarness
      const spaceId = 'space-created'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('is the first write stamp, kept across an update and renewed by a re-create', async () => {
        const { backend } = harness
        const collectionId = 'lives'
        const collectionMetadata = {
          id: collectionId,
          type: ['Collection'],
          name: 'first'
        }
        const first = await backend.writeCollection({
          spaceId,
          collectionId,
          // A body cannot set the creating stamp.
          collectionMetadata: {
            ...collectionMetadata,
            created: peerStamp({ ms: 1 })
          }
        })
        assert.deepEqual(first.metadata.created, first.validator.stamp)

        const updated = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: { ...collectionMetadata, name: 'second' }
        })
        assert.deepEqual(updated.metadata.created, first.validator.stamp)
        assert.notDeepEqual(updated.validator.stamp, first.validator.stamp)
        const read = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        assert.deepEqual(read.created, first.validator.stamp)

        await backend.deleteCollection({ spaceId, collectionId })
        const again = await backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata
        })
        assert.deepEqual(again.metadata.created, again.validator.stamp)
        assert.ok(
          compareStamps(again.metadata.created!, first.validator.stamp) > 0
        )
      })
    })

    describe('the apply path', () => {
      let harness: BackendHarness
      const clock = frozenClock()
      const spaceId = 'space-apply'
      const replicaId = 'peer'
      // Each test works in a Collection of its own.
      let collections = 0
      async function freshCollection(): Promise<string> {
        const collectionId = `col-${++collections}`
        await harness.backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: { id: collectionId, type: ['Collection'] }
        })
        return collectionId
      }
      // A stamp `offset` ms from the store's frozen physical time.
      function stampAt(offset: number, counter = 0): WriteStamp {
        return peerStamp({ ms: clock.now + offset, counter })
      }
      async function feedOf(collectionId: string): Promise<FeedDocument[]> {
        const { documents } = await harness.backend.changesSince!({
          spaceId,
          collectionId,
          limit: 100
        })
        return documents
      }
      function liveCollection({
        collectionId,
        generation,
        stamp,
        created = stamp,
        members = {}
      }: {
        collectionId: string
        generation: string
        stamp: WriteStamp
        created?: WriteStamp
        members?: Partial<CollectionMetadata>
      }) {
        return {
          deleted: false as const,
          generation,
          metadata: {
            id: collectionId,
            type: ['Collection'],
            createdAt: created.updatedAt,
            created,
            ...members,
            ...stamp
          } as CollectionMetadata
        }
      }

      beforeAll(async () => {
        harness = await makeBackend({ physicalClock: clock.read })
        await provisionSpace(harness.backend, spaceId)
        await harness.backend.createReplica({
          spaceId,
          record: replicaRegistration({ id: replicaId, spaceId }),
          pullsChunks: false
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('applies nothing under a registration the Space does not hold', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const stamp = stampAt(1000)
        const unknown = { spaceId, replicaId: 'no-such-peer' }
        const results = [
          await backend.applySpaceName({ ...unknown, name: 'x', stamp }),
          await backend.applyCollection({
            ...unknown,
            collectionId,
            collection: { deleted: true, stamp }
          }),
          await backend.applyResource({
            ...unknown,
            collectionId,
            resourceId: 'r1',
            generation: 'gen1',
            stamp,
            resource: { deleted: false, input: jsonInput({ a: 1 }) }
          }),
          await backend.applyResourceMetadata({
            ...unknown,
            collectionId,
            resourceId: 'r1',
            meta: { ...stamp, generation: 'meta1' },
            custom: { name: 'x' }
          }),
          await backend.applyPolicy({
            ...unknown,
            generation: 'pol1',
            stamp,
            policy: { type: 'PublicCanRead' }
          }),
          await backend.applyCollectionLog({
            ...unknown,
            collectionId,
            body: '{"state":{}}\n',
            generation: 'log1',
            stamp
          }),
          await backend.beginChunkStaging({
            ...unknown,
            collectionId,
            resourceId: 'r1',
            run: { replicaId: 'no-such-peer', parentEtag: '"r1"' },
            listed: [{ index: 0, size: 5 }]
          }),
          await backend.stageChunk({
            ...unknown,
            collectionId,
            resourceId: 'r1',
            run: { replicaId: 'no-such-peer', parentEtag: '"r1"' },
            chunkIndex: 0,
            input: binaryInput(Buffer.from('chunk')),
            peerEtag: '"c0"'
          }),
          await backend.applyResource({
            ...unknown,
            collectionId,
            resourceId: 'r1',
            generation: 'gen1',
            stamp,
            resource: { deleted: false, input: jsonInput({ a: 1 }) },
            chunks: {
              run: { replicaId: 'no-such-peer', parentEtag: '"r1"' },
              staged: [0]
            }
          })
        ]
        for (const result of results) {
          assert.deepEqual(result, { outcome: 'unregistered' })
        }
        assert.ok(
          await backend.getCollectionMetadata({ spaceId, collectionId })
        )
        assert.equal(
          await backend.getResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'r1'
          }),
          undefined
        )
        assert.equal(await backend.getPolicy({ spaceId }), undefined)
      })

      it('refuses a stamp dated past the clock bound, and stores nothing', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const result = await backend.applyResource({
          spaceId,
          replicaId,
          collectionId,
          resourceId: 'future',
          generation: 'gen1',
          stamp: stampAt(10 * 60 * 1000),
          resource: { deleted: false, input: jsonInput({ a: 1 }) }
        })
        assert.equal(result.outcome, 'refused')
        assert.equal(
          result.outcome === 'refused' && result.reason,
          'clock-bound'
        )
        await assert.rejects(
          backend.getResource({ spaceId, collectionId, resourceId: 'future' }),
          ResourceNotFoundError
        )
        // A local write afterward is still stamped at local time.
        const written = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'local',
          input: jsonInput({ a: 1 })
        })
        assert.ok(
          Date.parse(written.validator.stamp.updatedAt) <
            clock.now + 5 * 60 * 1000
        )
      })

      it('rejects a malformed stamp as a server fault', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await assert.rejects(
          backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId: 'bad',
            generation: 'gen1',
            stamp: { ...stampAt(1000), originId: 'not an origin id' },
            resource: { deleted: false, input: jsonInput({ a: 1 }) }
          }),
          StorageError
        )
      })

      it('applies the Space name under the received stamp and keeps every other member', async () => {
        const { backend } = harness
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        const stamp = stampAt(2000)
        assert.deepEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'From the peer',
            stamp
          }),
          { outcome: 'applied' }
        )
        const applied = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(applied.name, 'From the peer')
        assert.deepEqual(stampOf(applied), stamp)
        assert.equal(applied.metaGeneration, before.metaGeneration)
        assert.equal(applied.metaLocal, 0)
        assert.equal(applied.controller, before.controller)
        assert.deepEqual(applied.type, before.type)

        // The same stamp again, and a lower one, are skipped.
        for (const lost of [stamp, stampAt(1500)]) {
          assert.deepEqual(
            await backend.applySpaceName({
              spaceId,
              replicaId,
              name: 'Lost',
              stamp: lost
            }),
            { outcome: 'skipped' }
          )
        }
        assert.equal(
          (await backend.getSpaceMetadata({ spaceId }))!.name,
          'From the peer'
        )

        // An absent name removes the stored one.
        assert.deepEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            stamp: stampAt(2000, 1)
          }),
          { outcome: 'applied' }
        )
        const cleared = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal('name' in cleared, false)
        // The registration still applies: the Space generation did not move.
        assert.equal(cleared.metaGeneration, before.metaGeneration)
      })

      it('applies a Resource under the peer stamp and generation, at a new feed position', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const resourceId = 'doc'
        const stamp = stampAt(3000)
        const positionsBefore = (await feedOf(collectionId)).map(
          document => document.feedPosition
        )
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen1',
            stamp,
            createdAt: '2026-01-02T03:04:05.000Z',
            createdBy: CREATOR_ONE,
            writerId: 'writer-1',
            resource: {
              deleted: false,
              input: jsonInput({ hello: 'peer' }),
              epoch: 'epoch-1'
            }
          }),
          { outcome: 'applied' }
        )
        const result = await backend.getResource({
          spaceId,
          collectionId,
          resourceId
        })
        assert.deepEqual(
          JSON.parse(await streamToString(result.resourceStream)),
          { hello: 'peer' }
        )
        const metadata = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.deepEqual(stampOf(metadata), stamp)
        assert.equal(metadata.generation, 'peerGen1')
        assert.equal(metadata.createdAt, '2026-01-02T03:04:05.000Z')
        assert.equal(metadata.createdBy, CREATOR_ONE)
        assert.equal(metadata.epoch, 'epoch-1')
        assert.equal(metadata.writerId, 'writer-1')
        // The validator is the peer's, so the `ETag` is byte-identical.
        assert.equal(
          etagOf({ generation: metadata.generation, ...stampOf(metadata) }),
          formatEtag({ generation: 'peerGen1', stamp })
        )

        const document = (await feedOf(collectionId)).find(
          candidate =>
            candidate.kind === 'resource' && candidate.resourceId === resourceId
        )!
        assert.ok(document)
        assert.ok(
          positionsBefore.every(position => position < document.feedPosition)
        )
        assert.deepEqual(stampOf(document), stamp)
        assert.equal(
          document.kind === 'resource' && document.createdBy,
          CREATOR_ONE
        )

        // An equal stamp and a lower one are skipped, and take no position.
        for (const lost of [stamp, stampAt(2500)]) {
          assert.deepEqual(
            await backend.applyResource({
              spaceId,
              replicaId,
              collectionId,
              resourceId,
              generation: 'peerGen1',
              stamp: lost,
              resource: { deleted: false, input: jsonInput({ hello: 'lost' }) }
            }),
            { outcome: 'skipped' }
          )
        }
        const after = (await feedOf(collectionId)).find(
          candidate =>
            candidate.kind === 'resource' && candidate.resourceId === resourceId
        )!
        assert.equal(after.feedPosition, document.feedPosition)

        // A greater stamp replaces the bytes, the type and the members.
        const next = stampAt(3000, 1)
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen1',
            stamp: next,
            createdAt: '2026-01-02T03:04:05.000Z',
            resource: {
              deleted: false,
              input: binaryInput(Buffer.from('bytes'), {
                contentType: 'text/plain'
              })
            }
          }),
          { outcome: 'applied' }
        )
        const replaced = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.equal(replaced.contentType, 'text/plain')
        assert.equal(replaced.size, 5)
        assert.deepEqual(stampOf(replaced), next)
        assert.equal(replaced.createdBy, undefined)
        assert.equal(replaced.epoch, undefined)
        assert.equal(replaced.writerId, undefined)
        const moved = (await feedOf(collectionId)).find(
          candidate =>
            candidate.kind === 'resource' && candidate.resourceId === resourceId
        )!
        assert.ok(moved.feedPosition > document.feedPosition)
      })

      it('skips a Resource whose stamp is below a local write, and applies one above it', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const resourceId = 'contested'
        const local = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId,
          input: jsonInput({ from: 'local' })
        })
        const localMs = Date.parse(local.validator.stamp.updatedAt)
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen',
            stamp: peerStamp({ ms: localMs - 1 }),
            resource: { deleted: false, input: jsonInput({ from: 'peer' }) }
          }),
          { outcome: 'skipped' }
        )
        const kept = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.equal(kept.generation, local.validator.generation)
        assert.deepEqual(stampOf(kept), local.validator.stamp)

        const winning = peerStamp({ ms: localMs + 5000 })
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen',
            stamp: winning,
            resource: { deleted: false, input: jsonInput({ from: 'peer' }) }
          }),
          { outcome: 'applied' }
        )
        // A local write afterward is stamped above the applied one.
        const rewritten = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId,
          input: jsonInput({ from: 'local again' })
        })
        assert.ok(compareStamps(rewritten.validator.stamp, winning) > 0)
        assert.equal(rewritten.validator.generation, 'peerGen')
      })

      it('applies a `/meta` record on its own stamp, and keeps it across a content apply', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const resourceId = 'annotated'
        const contentStamp = stampAt(4000)
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId,
          resourceId,
          generation: 'peerGen',
          stamp: contentStamp,
          resource: { deleted: false, input: jsonInput({ a: 1 }) }
        })
        const meta = { ...stampAt(4100), generation: 'peerMeta' }
        const positionBefore = (await feedOf(collectionId)).find(
          candidate =>
            candidate.kind === 'resource' && candidate.resourceId === resourceId
        )!.feedPosition
        assert.deepEqual(
          await backend.applyResourceMetadata({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            meta,
            custom: { name: 'A name', tags: ['one'] }
          }),
          { outcome: 'applied' }
        )
        const applied = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.deepEqual(applied.meta, meta)
        assert.deepEqual(applied.custom, { name: 'A name', tags: ['one'] })
        // The content record is untouched.
        assert.deepEqual(stampOf(applied), contentStamp)
        assert.equal(applied.generation, 'peerGen')
        const document = (await feedOf(collectionId)).find(
          candidate =>
            candidate.kind === 'resource' && candidate.resourceId === resourceId
        )!
        assert.ok(document.feedPosition > positionBefore)

        for (const lost of [meta, { ...stampAt(4050), generation: 'other' }]) {
          assert.deepEqual(
            await backend.applyResourceMetadata({
              spaceId,
              replicaId,
              collectionId,
              resourceId,
              meta: lost,
              custom: { name: 'Lost' }
            }),
            { outcome: 'skipped' }
          )
        }

        // A content apply keeps the `/meta` record and `custom`.
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId,
          resourceId,
          generation: 'peerGen',
          stamp: stampAt(4200),
          resource: { deleted: false, input: jsonInput({ a: 2 }) }
        })
        const afterContent = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.deepEqual(afterContent.meta, meta)
        assert.deepEqual(afterContent.custom, {
          name: 'A name',
          tags: ['one']
        })

        // An empty `custom` clears it.
        const cleared = { ...stampAt(4300), generation: 'peerMeta' }
        await backend.applyResourceMetadata({
          spaceId,
          replicaId,
          collectionId,
          resourceId,
          meta: cleared
        })
        const afterClear = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.equal(afterClear.custom, undefined)
        assert.deepEqual(afterClear.meta, cleared)

        // No `/meta` is applied to an absent Resource.
        assert.deepEqual(
          await backend.applyResourceMetadata({
            spaceId,
            replicaId,
            collectionId,
            resourceId: 'absent',
            meta: { ...stampAt(4400), generation: 'm' },
            custom: { name: 'x' }
          }),
          { outcome: 'skipped' }
        )
      })

      it('applies a Resource tombstone, skips a `/meta` under it, and re-creates over it', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const resourceId = 'doomed'
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId,
          resourceId,
          generation: 'peerGen',
          stamp: stampAt(5000),
          createdBy: CREATOR_ONE,
          resource: { deleted: false, input: jsonInput({ a: 1 }) }
        })
        await backend.applyResourceMetadata({
          spaceId,
          replicaId,
          collectionId,
          resourceId,
          meta: { ...stampAt(5050), generation: 'peerMeta' },
          custom: { name: 'gone soon' }
        })
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId,
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk'))
        })

        // A tombstone below the held stamp is skipped.
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen',
            stamp: stampAt(4900),
            resource: { deleted: true, contentType: 'application/json' }
          }),
          { outcome: 'skipped' }
        )
        const tombstone = stampAt(5100)
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen',
            stamp: tombstone,
            createdBy: CREATOR_ONE,
            writerId: 'deleter',
            resource: { deleted: true, contentType: 'application/json' }
          }),
          { outcome: 'applied' }
        )
        await assert.rejects(
          backend.getResource({ spaceId, collectionId, resourceId }),
          ResourceNotFoundError
        )
        assert.deepEqual(
          (await backend.listChunks({ spaceId, collectionId, resourceId }))
            .chunks,
          []
        )
        const document = (await feedOf(collectionId)).find(
          candidate =>
            candidate.kind === 'resource' && candidate.resourceId === resourceId
        )!
        assert.equal(document.kind === 'resource' && document.deleted, true)
        assert.equal(
          document.kind === 'resource' && document.contentType,
          'application/json'
        )
        assert.equal(
          document.kind === 'resource' && document.writerId,
          'deleter'
        )
        assert.equal(document.kind === 'resource' && document.meta, undefined)
        assert.deepEqual(stampOf(document), tombstone)
        assert.equal(document.validator!.generation, 'peerGen')

        // A `/meta` stamped after the tombstone is skipped while it holds.
        assert.deepEqual(
          await backend.applyResourceMetadata({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            meta: { ...stampAt(5200), generation: 'peerMeta' },
            custom: { name: 'too late' }
          }),
          { outcome: 'skipped' }
        )
        // A live record below the tombstone is skipped, one above it applies.
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen',
            stamp: stampAt(5080),
            resource: { deleted: false, input: jsonInput({ a: 'stale' }) }
          }),
          { outcome: 'skipped' }
        )
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'peerGen',
            stamp: stampAt(5300),
            resource: { deleted: false, input: jsonInput({ a: 'back' }) }
          }),
          { outcome: 'applied' }
        )
        const recreated = (await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId
        }))!
        assert.equal(recreated.custom, undefined)
        assert.equal(recreated.meta, undefined)
      })

      it('stores a tombstone for a Resource it never held', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const stamp = stampAt(5500)
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId: 'never-here',
            generation: 'peerGen',
            stamp,
            resource: { deleted: true, contentType: 'image/png' }
          }),
          { outcome: 'applied' }
        )
        // A stale copy arriving afterward is not created.
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId: 'never-here',
            generation: 'peerGen',
            stamp: stampAt(5400),
            resource: { deleted: false, input: jsonInput({ a: 1 }) }
          }),
          { outcome: 'skipped' }
        )
      })

      it('fast-forwards a did.jsonl whatever its stamp, and refuses a fork', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const resourceId = 'did.jsonl'
        const apply = (body: string, stamp: WriteStamp) =>
          backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'logGen',
            stamp,
            resource: {
              deleted: false,
              input: binaryInput(Buffer.from(body), {
                contentType: 'text/jsonl'
              })
            }
          })
        const read = async () =>
          streamToString(
            (await backend.getResource({ spaceId, collectionId, resourceId }))
              .resourceStream
          )
        assert.deepEqual(await apply('{"n":1}\n', stampAt(6000)), {
          outcome: 'applied'
        })
        // A longer log applies even under a lower stamp.
        const longer = stampAt(5900)
        assert.deepEqual(await apply('{"n":1}\n{"n":2}\n', longer), {
          outcome: 'applied'
        })
        assert.equal(await read(), '{"n":1}\n{"n":2}\n')
        assert.deepEqual(
          stampOf(
            (await backend.getResourceMetadata({
              spaceId,
              collectionId,
              resourceId
            }))!
          ),
          longer
        )
        // The same log and a prefix of it are skipped, whatever the stamp.
        assert.deepEqual(await apply('{"n":1}\n{"n":2}\n', stampAt(6100)), {
          outcome: 'skipped'
        })
        assert.deepEqual(await apply('{"n":1}\n', stampAt(6200)), {
          outcome: 'skipped'
        })
        const forked = await apply('{"n":1}\n{"n":"other"}\n', stampAt(6300))
        assert.equal(forked.outcome, 'refused')
        assert.equal(forked.outcome === 'refused' && forked.reason, 'fork')
        assert.equal(await read(), '{"n":1}\n{"n":2}\n')
        // A peer never deletes a history log.
        assert.deepEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId,
            resourceId,
            generation: 'logGen',
            stamp: stampAt(6400),
            resource: { deleted: true, contentType: 'text/jsonl' }
          }),
          { outcome: 'skipped' }
        )
        assert.equal(await read(), '{"n":1}\n{"n":2}\n')
      })

      it('fast-forwards a governing history log and advances the Collection Metadata local segment', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const first = '{"parameters":{"method":"m"},"state":{}}\n'
        const second = `${first}{"state":{}}\n`
        const before = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        const stamp = stampAt(7000)
        assert.deepEqual(
          await backend.applyCollectionLog({
            spaceId,
            replicaId,
            collectionId,
            body: first,
            generation: 'logGen',
            stamp
          }),
          { outcome: 'applied' }
        )
        const log = (await backend.getCollectionLog({ spaceId, collectionId }))!
        assert.equal(log.body, first)
        assert.equal(
          formatEtag(log.validator),
          formatEtag({ generation: 'logGen', stamp })
        )
        const afterCreate = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        assert.equal(afterCreate.metaLocal, before.metaLocal! + 1)
        assert.deepEqual(stampOf(afterCreate), stampOf(before))
        const document = (await feedOf(collectionId)).find(
          candidate => candidate.kind === 'log'
        )!
        assert.deepEqual(stampOf(document), stamp)

        // An append applies under a lower stamp; a prefix is skipped.
        const appended = stampAt(6900)
        assert.deepEqual(
          await backend.applyCollectionLog({
            spaceId,
            replicaId,
            collectionId,
            body: second,
            generation: 'logGen',
            stamp: appended
          }),
          { outcome: 'applied' }
        )
        const grown = (await backend.getCollectionLog({
          spaceId,
          collectionId
        }))!
        assert.equal(grown.body, second)
        assert.deepEqual(grown.validator.stamp, appended)
        assert.equal(
          (await backend.getCollectionMetadata({ spaceId, collectionId }))!
            .metaLocal,
          before.metaLocal! + 2
        )
        const moved = (await feedOf(collectionId)).find(
          candidate => candidate.kind === 'log'
        )!
        assert.ok(moved.feedPosition > document.feedPosition)
        for (const body of [second, first]) {
          assert.deepEqual(
            await backend.applyCollectionLog({
              spaceId,
              replicaId,
              collectionId,
              body,
              generation: 'logGen',
              stamp: stampAt(7100)
            }),
            { outcome: 'skipped' }
          )
        }
        const forked = await backend.applyCollectionLog({
          spaceId,
          replicaId,
          collectionId,
          body: `${first}{"state":{"other":true}}\n`,
          generation: 'logGen',
          stamp: stampAt(7200)
        })
        assert.equal(forked.outcome, 'refused')
        assert.equal(forked.outcome === 'refused' && forked.reason, 'fork')
        assert.equal(
          (await backend.getCollectionLog({ spaceId, collectionId }))!.body,
          second
        )
      })

      it('applies a policy and its tombstone at each level', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const levels = [
          {},
          { collectionId },
          { collectionId, resourceId: 'with-policy' }
        ]
        let offset = 8000
        for (const level of levels) {
          const stamp = stampAt((offset += 100))
          assert.deepEqual(
            await backend.applyPolicy({
              spaceId,
              replicaId,
              ...level,
              generation: 'polGen',
              stamp,
              policy: { type: 'PublicCanRead' }
            }),
            { outcome: 'applied' }
          )
          const record = (await backend.getPolicyRecord({ spaceId, ...level }))!
          assert.equal(record.deleted, false)
          assert.equal(
            formatEtag(record.validator!),
            formatEtag({ generation: 'polGen', stamp })
          )
          const served = (await backend.getPolicy({ spaceId, ...level }))!
          assert.equal(served.type, 'PublicCanRead')
          assert.deepEqual(stampOf(served), stamp)

          // An equal stamp and a lower one are skipped.
          for (const lost of [stamp, stampAt(offset - 50)]) {
            assert.deepEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'polGen',
                stamp: lost
              }),
              { outcome: 'skipped' }
            )
          }
          assert.ok(await backend.getPolicy({ spaceId, ...level }))

          const deleted = stampAt((offset += 100))
          assert.deepEqual(
            await backend.applyPolicy({
              spaceId,
              replicaId,
              ...level,
              generation: 'polGen',
              stamp: deleted
            }),
            { outcome: 'applied' }
          )
          assert.equal(
            await backend.getPolicy({ spaceId, ...level }),
            undefined
          )
          const tombstone = (await backend.getPolicyRecord({
            spaceId,
            ...level
          }))!
          assert.equal(tombstone.deleted, true)
          assert.equal(
            formatEtag(tombstone.validator!),
            formatEtag({ generation: 'polGen', stamp: deleted })
          )
          // A live policy below the tombstone is skipped.
          assert.deepEqual(
            await backend.applyPolicy({
              spaceId,
              replicaId,
              ...level,
              generation: 'polGen',
              stamp: stampAt(offset - 10),
              policy: { type: 'PublicCanRead' }
            }),
            { outcome: 'skipped' }
          )
        }
        // The Collection's two policies are in its feed, as tombstones.
        const policies = (await feedOf(collectionId)).filter(
          document => document.kind === 'policy'
        )
        assert.equal(policies.length, 2)
        assert.ok(
          policies.every(
            document => document.kind === 'policy' && document.deleted
          )
        )
      })

      it('skips every member record under an absent or tombstoned Collection', async () => {
        const { backend } = harness
        const tombstoned = await freshCollection()
        await backend.deleteCollection({ spaceId, collectionId: tombstoned })
        for (const collectionId of ['never-created', tombstoned]) {
          const stamp = stampAt(9000)
          const results = [
            await backend.applyResource({
              spaceId,
              replicaId,
              collectionId,
              resourceId: 'r1',
              generation: 'gen',
              stamp,
              resource: { deleted: false, input: jsonInput({ a: 1 }) }
            }),
            await backend.applyResource({
              spaceId,
              replicaId,
              collectionId,
              resourceId: 'r2',
              generation: 'gen',
              stamp,
              resource: { deleted: true, contentType: 'application/json' }
            }),
            await backend.applyResourceMetadata({
              spaceId,
              replicaId,
              collectionId,
              resourceId: 'r1',
              meta: { ...stamp, generation: 'meta' },
              custom: { name: 'x' }
            }),
            await backend.applyPolicy({
              spaceId,
              replicaId,
              collectionId,
              generation: 'pol',
              stamp,
              policy: { type: 'PublicCanRead' }
            }),
            await backend.applyCollectionLog({
              spaceId,
              replicaId,
              collectionId,
              body: '{"state":{}}\n',
              generation: 'log',
              stamp
            })
          ]
          for (const result of results) {
            assert.deepEqual(result, { outcome: 'skipped' })
          }
          assert.equal(
            await backend.getCollectionMetadata({ spaceId, collectionId }),
            undefined
          )
          assert.equal(
            await backend.getPolicyRecord({ spaceId, collectionId }),
            undefined
          )
        }
        // Neither id became a Collection.
        const listed = (await backend.listCollections({ spaceId })).items.map(
          item => item.id
        )
        assert.equal(listed.includes('never-created'), false)
        assert.equal(listed.includes(tombstoned), false)
      })

      it('creates a Collection under the peer generation, stamp and creating stamp', async () => {
        const { backend } = harness
        const collectionId = 'applied-create'
        const stamp = stampAt(10_000)
        const created = stampAt(9_500)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'colGen1',
              stamp,
              created,
              members: { name: 'From the peer', createdBy: CREATOR_ONE }
            })
          }),
          { outcome: 'applied' }
        )
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        assert.equal(stored.metaGeneration, 'colGen1')
        assert.equal(stored.metaLocal, 0)
        assert.deepEqual(stampOf(stored), stamp)
        assert.deepEqual(stored.created, created)
        assert.equal(stored.createdAt, created.updatedAt)
        assert.equal(stored.createdBy, CREATOR_ONE)
        assert.equal(stored.name, 'From the peer')
        assert.equal(
          metadataEtagOf(stored),
          formatEtag({ generation: 'colGen1', stamp, local: 0 })
        )
        const feed = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.deepEqual(
          feed.documents.map(document => [
            document.kind,
            document.feedPosition
          ]),
          [['collection-metadata', 1]]
        )
        // The Collection takes ordinary writes.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'r1',
          input: jsonInput({ a: 1 })
        })
        assert.ok(
          (await backend.listCollections({ spaceId })).items.some(
            item => item.id === collectionId
          )
        )
      })

      it('updates a Collection of the same life by stamp, merging the immutable members forward', async () => {
        const { backend } = harness
        const collectionId = 'applied-update'
        const created = stampAt(11_000)
        await backend.applyCollection({
          spaceId,
          replicaId,
          collectionId,
          collection: liveCollection({
            collectionId,
            generation: 'colGen',
            stamp: created,
            members: { name: 'one', revisions: { immutable: true } }
          })
        })
        const positionOf = async () =>
          (await feedOf(collectionId)).find(
            document => document.kind === 'collection-metadata'
          )!.feedPosition
        const firstPosition = await positionOf()

        // A lower and an equal stamp are skipped.
        for (const lost of [created, stampAt(10_900)]) {
          assert.deepEqual(
            await backend.applyCollection({
              spaceId,
              replicaId,
              collectionId,
              collection: liveCollection({
                collectionId,
                generation: 'colGen',
                stamp: lost,
                created,
                members: { name: 'lost' }
              })
            }),
            { outcome: 'skipped' }
          )
        }

        // The update omits `revisions.immutable`, which is kept.
        const updated = stampAt(11_100)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'colGen',
              stamp: updated,
              created,
              members: { name: 'two' }
            })
          }),
          { outcome: 'applied' }
        )
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        assert.equal(stored.name, 'two')
        assert.deepEqual(stored.revisions, { immutable: true })
        assert.deepEqual(stampOf(stored), updated)
        assert.deepEqual(stored.created, created)
        assert.equal(stored.metaGeneration, 'colGen')
        assert.ok((await positionOf()) > firstPosition)

        // A different set value is a fork, and nothing is stored.
        const forked = await backend.applyCollection({
          spaceId,
          replicaId,
          collectionId,
          collection: liveCollection({
            collectionId,
            generation: 'colGen',
            stamp: stampAt(11_200),
            created,
            members: { name: 'three', revisions: { immutable: false } }
          })
        })
        assert.equal(forked.outcome, 'refused')
        assert.equal(forked.outcome === 'refused' && forked.reason, 'fork')
        assert.equal(
          (await backend.getCollectionMetadata({ spaceId, collectionId }))!
            .name,
          'two'
        )
      })

      it('replaces a life created earlier, with its members, and skips one created earlier than the held life', async () => {
        const { backend } = harness
        const collectionId = 'applied-replace'
        const heldCreated = stampAt(12_000)
        await backend.applyCollection({
          spaceId,
          replicaId,
          collectionId,
          collection: liveCollection({
            collectionId,
            generation: 'oldGen',
            stamp: heldCreated,
            members: { name: 'old life' }
          })
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'old-member',
          input: jsonInput({ a: 1 })
        })
        await backend.writePolicy({
          spaceId,
          collectionId,
          policy: { type: 'PublicCanRead' }
        })

        // A life created before the held one loses, whatever its stamp.
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'olderGen',
              stamp: stampAt(13_000),
              created: stampAt(11_900),
              members: { name: 'older life' }
            })
          }),
          { outcome: 'skipped' }
        )
        assert.equal(
          (await backend.getCollectionMetadata({ spaceId, collectionId }))!
            .metaGeneration,
          'oldGen'
        )

        const newCreated = stampAt(12_500)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'newGen',
              stamp: newCreated,
              members: { name: 'new life' }
            })
          }),
          { outcome: 'applied' }
        )
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        assert.equal(stored.metaGeneration, 'newGen')
        assert.equal(stored.name, 'new life')
        assert.deepEqual(stored.created, newCreated)
        // The old life's members are gone, and the feed starts again.
        await assert.rejects(
          backend.getResource({
            spaceId,
            collectionId,
            resourceId: 'old-member'
          }),
          ResourceNotFoundError
        )
        assert.equal(
          await backend.getPolicyRecord({ spaceId, collectionId }),
          undefined
        )
        const feed = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 10
        })
        assert.deepEqual(
          feed.documents.map(document => [
            document.kind,
            document.feedPosition
          ]),
          [['collection-metadata', 1]]
        )
      })

      it('applies a Collection tombstone over a life created before it, whatever the later stamps', async () => {
        const { backend } = harness
        const collectionId = 'applied-delete'
        const created = stampAt(14_000)
        await backend.applyCollection({
          spaceId,
          replicaId,
          collectionId,
          collection: liveCollection({
            collectionId,
            generation: 'colGen',
            stamp: stampAt(14_500),
            created
          })
        })
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId,
          resourceId: 'member',
          generation: 'gen',
          stamp: stampAt(14_600),
          resource: { deleted: false, input: jsonInput({ a: 1 }) }
        })

        // A tombstone older than the life's creation is skipped.
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: { deleted: true, stamp: stampAt(13_900) }
          }),
          { outcome: 'skipped' }
        )
        assert.ok(
          await backend.getCollectionMetadata({ spaceId, collectionId })
        )

        // One after the creation wins, though the object and a member carry
        // later stamps.
        const deleted = stampAt(14_100)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: { deleted: true, stamp: deleted }
          }),
          { outcome: 'applied' }
        )
        assert.equal(
          await backend.getCollectionMetadata({ spaceId, collectionId }),
          undefined
        )
        const tombstoneOf = async () =>
          (
            await backend.listCollections({ spaceId, includeDeleted: true })
          ).items.find(item => item.id === collectionId)!
        const tombstone = await tombstoneOf()
        assert.ok(isCollectionTombstoneSummary(tombstone))
        assert.deepEqual(stampOf(tombstone), deleted)
        await assert.rejects(
          backend.getResource({ spaceId, collectionId, resourceId: 'member' }),
          isNotFound
        )

        // An older tombstone is skipped, a newer one restamps the held one.
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: { deleted: true, stamp: stampAt(14_050) }
          }),
          { outcome: 'skipped' }
        )
        const later = stampAt(14_200)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: { deleted: true, stamp: later }
          }),
          { outcome: 'applied' }
        )
        assert.deepEqual(stampOf((await tombstoneOf()) as WriteStamp), later)

        // A life created before the tombstone stays deleted; one created
        // after it is created.
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'colGen',
              stamp: stampAt(14_900),
              created
            })
          }),
          { outcome: 'skipped' }
        )
        const reborn = stampAt(14_300)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'rebornGen',
              stamp: reborn
            })
          }),
          { outcome: 'applied' }
        )
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId
        }))!
        assert.equal(stored.metaGeneration, 'rebornGen')
        assert.deepEqual(stored.created, reborn)
      })

      it('stores a tombstone for a Collection it never held', async () => {
        const { backend } = harness
        const collectionId = 'applied-tombstone-only'
        const stamp = stampAt(15_000)
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: { deleted: true, stamp }
          }),
          { outcome: 'applied' }
        )
        assert.equal(
          await backend.getCollectionMetadata({ spaceId, collectionId }),
          undefined
        )
        const listing = await backend.listCollections({
          spaceId,
          includeDeleted: true
        })
        const item = listing.items.find(
          candidate => candidate.id === collectionId
        )!
        assert.ok(isCollectionTombstoneSummary(item))
        assert.deepEqual(stampOf(item), stamp)
        assert.equal(
          (await backend.listCollections({ spaceId })).items.some(
            candidate => candidate.id === collectionId
          ),
          false
        )
        // A stale copy of the Collection arriving later is not created.
        assert.deepEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId,
            collection: liveCollection({
              collectionId,
              generation: 'staleGen',
              stamp: stampAt(15_500),
              created: stampAt(14_999)
            })
          }),
          { outcome: 'skipped' }
        )
      })

      it('counts an applied Collection create against the Collection quota', async () => {
        const limited = await makeBackend({
          physicalClock: clock.read,
          maxCollectionsPerSpace: 1
        })
        try {
          const { backend } = limited
          await provisionSpace(backend, spaceId)
          await backend.createReplica({
            spaceId,
            record: replicaRegistration({ id: replicaId, spaceId }),
            pullsChunks: false
          })
          await assert.rejects(
            backend.applyCollection({
              spaceId,
              replicaId,
              collectionId: 'over-quota',
              collection: liveCollection({
                collectionId: 'over-quota',
                generation: 'colGen',
                stamp: stampAt(16_000)
              })
            }),
            CountQuotaExceededError
          )
          assert.equal(
            await backend.getCollectionMetadata({
              spaceId,
              collectionId: 'over-quota'
            }),
            undefined
          )
          // An update of the Collection the Space holds is not a create.
          const held = (await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'col'
          }))!
          assert.deepEqual(
            await backend.applyCollection({
              spaceId,
              replicaId,
              collectionId: 'col',
              collection: liveCollection({
                collectionId: 'col',
                generation: held.metaGeneration!,
                stamp: stampAt(16_100),
                created: held.created!,
                members: { name: 'renamed by the peer' }
              })
            }),
            { outcome: 'applied' }
          )
        } finally {
          await limited.cleanup()
        }
      })
    })

    describe('WebKMS keystores, keys, revocations', () => {
      let harness: BackendHarness
      beforeAll(async () => {
        harness = await makeBackend()
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('updateKeystore gates on sequence and module immutability', async () => {
        const { backend } = harness
        await backend.writeKeystore({
          keystoreId: 'ks1',
          config: keystoreConfig('ks1')
        })
        // Happy path: sequence exactly previous + 1.
        await backend.updateKeystore({
          keystoreId: 'ks1',
          config: keystoreConfig('ks1', { sequence: 1 })
        })
        assert.equal(
          (await backend.getKeystore({ keystoreId: 'ks1' }))?.sequence,
          1
        )
        // Stale sequence.
        await expect(
          backend.updateKeystore({
            keystoreId: 'ks1',
            config: keystoreConfig('ks1', { sequence: 1 })
          })
        ).rejects.toBeInstanceOf(KeystoreStateConflictError)
        // Module change.
        await expect(
          backend.updateKeystore({
            keystoreId: 'ks1',
            config: keystoreConfig('ks1', {
              sequence: 2,
              kmsModule: 'other-module'
            })
          })
        ).rejects.toBeInstanceOf(KeystoreStateConflictError)
        // Missing keystore.
        await expect(
          backend.updateKeystore({
            keystoreId: 'missing',
            config: keystoreConfig('missing', { sequence: 1 })
          })
        ).rejects.toBeInstanceOf(KeystoreStateConflictError)
      })

      it('lists keystores by controller, sorted by local id', async () => {
        const { backend } = harness
        await backend.writeKeystore({
          keystoreId: 'ks3',
          config: keystoreConfig('ks3')
        })
        await backend.writeKeystore({
          keystoreId: 'ks2',
          config: keystoreConfig('ks2')
        })
        await backend.writeKeystore({
          keystoreId: 'other',
          config: keystoreConfig('other', {
            controller: 'did:key:z6MkSomeoneElse' as IDID
          })
        })
        const configs = await backend.listKeystoresByController({
          controller: CONTROLLER
        })
        assert.deepEqual(
          configs.map(config => config.id.split('/').pop()),
          ['ks1', 'ks2', 'ks3']
        )
      })

      it('insertKey is create-only (409 on duplicate) and round-trips the opaque record', async () => {
        const { backend } = harness
        const record = keyRecord('ks1', 'key1')
        await backend.insertKey({
          keystoreId: 'ks1',
          localId: 'key1',
          record
        })
        assert.deepEqual(
          await backend.getKey({ keystoreId: 'ks1', localId: 'key1' }),
          record
        )
        await expect(
          backend.insertKey({ keystoreId: 'ks1', localId: 'key1', record })
        ).rejects.toBeInstanceOf(KeyIdConflictError)
      })

      it('listKeys resolves empty for an empty keystore and sorts by local id', async () => {
        const { backend } = harness
        await backend.writeKeystore({
          keystoreId: 'ks-list',
          config: keystoreConfig('ks-list')
        })
        // No keys yet (nor any keys/ directory): an empty list, not a throw.
        assert.deepEqual(await backend.listKeys({ keystoreId: 'ks-list' }), [])
        // Insert out of order; listKeys returns them sorted by local id with
        // the opaque record round-tripped verbatim.
        const inserted = new Map<string, KmsKeyRecord>()
        for (const localId of ['key3', 'key1', 'key2']) {
          const record = keyRecord('ks-list', localId)
          inserted.set(localId, record)
          await backend.insertKey({ keystoreId: 'ks-list', localId, record })
        }
        const listed = await backend.listKeys({ keystoreId: 'ks-list' })
        assert.deepEqual(
          listed.map(entry => entry.localId),
          ['key1', 'key2', 'key3']
        )
        assert.deepEqual(listed[0]!.record, inserted.get('key1'))
      })

      it('listKeys on an unknown keystore resolves empty (no keys directory)', async () => {
        const { backend } = harness
        assert.deepEqual(await backend.listKeys({ keystoreId: 'nope' }), [])
      })

      it('insertRevocation is create-only and isRevoked consults unexpired records', async () => {
        const { backend } = harness
        const record = revocationRecord({
          capabilityId: 'urn:zcap:revoked-1',
          delegator: 'did:key:z6MkDelegator'
        })
        await backend.insertRevocation({ scope: { keystoreId: 'ks1' }, record })
        await expect(
          backend.insertRevocation({ scope: { keystoreId: 'ks1' }, record })
        ).rejects.toBeInstanceOf(DuplicateRevocationError)
        assert.equal(
          await backend.isRevoked({
            scope: { keystoreId: 'ks1' },
            capabilities: [
              {
                capabilityId: 'urn:zcap:revoked-1',
                delegator: 'did:key:z6MkDelegator'
              }
            ]
          }),
          true
        )
        assert.equal(
          await backend.isRevoked({
            scope: { keystoreId: 'ks1' },
            capabilities: [
              {
                capabilityId: 'urn:zcap:other',
                delegator: 'did:key:z6MkDelegator'
              }
            ]
          }),
          false
        )
      })

      it('an expired revocation counts as not revoked (pruned on the way through)', async () => {
        const { backend } = harness
        const expired = revocationRecord({
          capabilityId: 'urn:zcap:expired-1',
          delegator: 'did:key:z6MkDelegator',
          expires: new Date(Date.now() - 60_000).toISOString()
        })
        await backend.insertRevocation({
          scope: { keystoreId: 'ks1' },
          record: expired
        })
        assert.equal(
          await backend.isRevoked({
            scope: { keystoreId: 'ks1' },
            capabilities: [
              {
                capabilityId: 'urn:zcap:expired-1',
                delegator: 'did:key:z6MkDelegator'
              }
            ]
          }),
          false
        )
      })

      it('deleteSpace leaves keystores untouched (sibling tree)', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-kms')
        await backend.deleteSpace({ spaceId: 'space-kms' })
        assert.ok(await backend.getKeystore({ keystoreId: 'ks1' }))
      })

      it('a revocation is scoped: the same pair revoked under a keystore is not revoked under a Space', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-rev')
        const capabilities = [
          {
            capabilityId: 'urn:zcap:scoped-1',
            delegator: 'did:key:z6MkDelegator'
          }
        ]
        await backend.insertRevocation({
          scope: { keystoreId: 'ks1' },
          record: revocationRecord({
            capabilityId: 'urn:zcap:scoped-1',
            delegator: 'did:key:z6MkDelegator'
          })
        })
        assert.equal(
          await backend.isRevoked({
            scope: { spaceId: 'space-rev' },
            capabilities
          }),
          false
        )
        // The same `(delegator, capabilityId)` inserts cleanly under the Space
        // (the uniqueness gate is per scope), and now reads as revoked there.
        await backend.insertRevocation({
          scope: { spaceId: 'space-rev' },
          record: revocationRecord({
            capabilityId: 'urn:zcap:scoped-1',
            delegator: 'did:key:z6MkDelegator'
          })
        })
        assert.equal(
          await backend.isRevoked({
            scope: { spaceId: 'space-rev' },
            capabilities
          }),
          true
        )
      })

      it('deleteSpace removes the Space revocations with it', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-rev-gone')
        const capabilities = [
          {
            capabilityId: 'urn:zcap:cascade-1',
            delegator: 'did:key:z6MkDelegator'
          }
        ]
        await backend.insertRevocation({
          scope: { spaceId: 'space-rev-gone' },
          record: revocationRecord({
            capabilityId: 'urn:zcap:cascade-1',
            delegator: 'did:key:z6MkDelegator'
          })
        })
        await backend.deleteSpace({ spaceId: 'space-rev-gone' })
        assert.equal(
          await backend.isRevoked({
            scope: { spaceId: 'space-rev-gone' },
            capabilities
          }),
          false
        )
        // Gone, not merely shadowed: re-provisioning and re-inserting the same
        // pair does not conflict.
        await provisionSpace(backend, 'space-rev-gone')
        await backend.insertRevocation({
          scope: { spaceId: 'space-rev-gone' },
          record: revocationRecord({
            capabilityId: 'urn:zcap:cascade-1',
            delegator: 'did:key:z6MkDelegator'
          })
        })
      })

      it('insertRevocation rejects under an absent scope (no orphan records)', async () => {
        // The request layer 404-masks unknown scopes before the store is
        // reached; at the store, an absent-parent insert must reject the same
        // way on every backend rather than silently creating an orphan
        // record. An absent Space is the 404 a Delete Space race reaches.
        const { backend } = harness
        const record = revocationRecord({
          capabilityId: 'urn:zcap:orphan-1',
          delegator: 'did:key:z6MkDelegator'
        })
        await assert.rejects(
          backend.insertRevocation({
            scope: { spaceId: 'no-such-space' },
            record
          }),
          isNotFound
        )
        await expect(
          backend.insertRevocation({
            scope: { keystoreId: 'no-such-keystore' },
            record
          })
        ).rejects.toBeInstanceOf(StorageError)
      })
    })

    describe('write-once Collections (immutable)', () => {
      let harness: BackendHarness
      const spaceId = 'space-immutable'
      const collectionId = 'col'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId, collectionId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /**
       * The current feed checkpoint of the Collection.
       */
      async function feedCheckpoint(): Promise<number | null | undefined> {
        const page = await harness.backend.changesSince!({
          spaceId,
          collectionId,
          limit: 100
        })
        return page.checkpoint
      }

      it('a repeat of the stored bytes answers the stored validator and takes no feed position', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'repeat',
          input: jsonInput({ a: 1 }),
          immutable: true
        })
        const before = await feedCheckpoint()
        const { validator: repeated } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'repeat',
          input: jsonInput({ a: 1 }),
          immutable: true
        })
        assert.equal(formatEtag(repeated), formatEtag(created))
        assert.equal(await feedCheckpoint(), before)
        const stored = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'repeat'
        })
        assert.equal(etagOf(stored!), formatEtag(created))
      })

      it('a different body over a live Resource is refused and leaves the stored bytes', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'changed',
          input: jsonInput({ a: 1 }),
          immutable: true
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'changed',
            input: jsonInput({ a: 2 }),
            immutable: true
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
        const read = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'changed'
        })
        assert.equal(await streamToString(read.resourceStream), '{"a":1}')
      })

      it('equal bytes under a different content type are refused', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'typed',
          input: binaryInput(Buffer.from('same bytes'), {
            contentType: 'text/plain'
          }),
          immutable: true
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'typed',
            input: binaryInput(Buffer.from('same bytes')),
            immutable: true
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
      })

      it('compares a binary body byte for byte', async () => {
        const { backend } = harness
        const bytes = randomBytes(4096)
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'blob',
          input: binaryInput(bytes),
          immutable: true
        })
        const { validator: repeated } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'blob',
          input: binaryInput(Buffer.from(bytes)),
          immutable: true
        })
        assert.equal(formatEtag(repeated), formatEtag(created))
        const other = Buffer.from(bytes)
        other[4095] = other[4095]! ^ 1
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'blob',
            input: binaryInput(other),
            immutable: true
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
      })

      it('preconditions are evaluated first', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'guarded',
          input: jsonInput({ a: 1 }),
          immutable: true
        })
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'guarded',
            input: jsonInput({ a: 1 }),
            immutable: true,
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('a write over a tombstone is held to the deleted content: a repeat is a no-op, a change is refused', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'tombstoned',
          input: jsonInput({ a: 1 }),
          immutable: true
        })
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'tombstoned'
        })
        const before = await feedCheckpoint()
        // The tombstone keeps the deleted content's digest, so a different
        // body is refused and the Resource cannot be edited through a delete
        // and a re-create.
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'tombstoned',
            input: jsonInput({ a: 2 }),
            immutable: true
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
        // A repeat of the deleted content writes nothing: it answers the
        // tombstone's validator, takes no feed position, and leaves the
        // Resource deleted.
        const repeated = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'tombstoned',
          input: jsonInput({ a: 1 }),
          immutable: true
        })
        assert.equal(repeated.created, false)
        assertValidatorAdvanced(created, repeated.validator)
        assert.equal(repeated.members.size, 0)
        assert.equal(await feedCheckpoint(), before)
        await expect(
          backend.getResource({
            spaceId,
            collectionId,
            resourceId: 'tombstoned'
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
      })

      it('chunks follow the same rule', async () => {
        const { backend } = harness
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          input: jsonInput({ manifest: true }),
          immutable: true
        })
        const chunk = await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk zero')),
          immutable: true
        })
        const repeated = await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk zero')),
          immutable: true
        })
        assert.equal(formatEtag(repeated), formatEtag(chunk))
        await expect(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'chunked',
            chunkIndex: 0,
            input: binaryInput(Buffer.from('chunk 0 v2')),
            immutable: true
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
        // A new index is a create.
        await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 1,
          input: binaryInput(Buffer.from('chunk one')),
          immutable: true
        })
        const read = await backend.getChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0
        })
        assert.equal(await streamToString(read.resourceStream), 'chunk zero')
      })
    })

    describe('write-once Collections (rechecked under the lock)', () => {
      let harness: BackendHarness
      const spaceId = 'space-immutable-recheck'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId, 'plain')
        await provisionSpace(harness.backend, spaceId, 'governed')
        await provisionSpace(harness.backend, spaceId, 'unique')
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('hands the `immutable` recheck no log on an ungoverned Collection, and only over a live Resource', async () => {
        const { backend } = harness
        const seen: unknown[] = []
        const immutableUnder = async ({ log }: { log?: unknown }) => {
          seen.push(log)
          return false
        }
        await backend.writeResource({
          spaceId,
          collectionId: 'plain',
          resourceId: 'doc',
          input: jsonInput({ a: 1 }),
          immutable: immutableUnder
        })
        // A create has no stored bytes to protect: the recheck is not run.
        assert.deepEqual(seen, [])
        await backend.writeResource({
          spaceId,
          collectionId: 'plain',
          resourceId: 'doc',
          input: jsonInput({ a: 2 }),
          immutable: immutableUnder
        })
        assert.deepEqual(seen, [undefined])
        const read = await backend.getResource({
          spaceId,
          collectionId: 'plain',
          resourceId: 'doc'
        })
        assert.equal(await streamToString(read.resourceStream), '{"a":2}')
      })

      it('applies the rule when the log read under the lock declares it', async () => {
        const { backend } = harness
        const collectionId = 'governed'
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: jsonInput({ a: 1 })
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          input: jsonInput({ manifest: true })
        })
        const chunk = await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk zero'))
        })
        // The handler read the Collection as mutable; the log lands after.
        const body = '{"state":{"revisions":{"immutable":true}}}\n'
        const logValidator = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body,
          ifNoneMatch: '*'
        })
        let seenLog: { body: string; validator: unknown } | undefined
        const immutableUnder = async ({
          log
        }: {
          log?: { body: string; validator: unknown }
        }) => {
          seenLog = log
          return log !== undefined
        }
        await expect(
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'doc',
            input: jsonInput({ a: 2 }),
            immutable: immutableUnder
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
        assert.equal(seenLog?.body, body)
        assert.deepEqual(seenLog?.validator, logValidator)
        const { validator: repeated } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'doc',
          input: jsonInput({ a: 1 }),
          immutable: immutableUnder
        })
        assert.equal(formatEtag(repeated), formatEtag(created))

        await expect(
          backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'chunked',
            chunkIndex: 0,
            input: binaryInput(Buffer.from('chunk 0 v2')),
            immutable: immutableUnder
          })
        ).rejects.toBeInstanceOf(ResourceImmutableError)
        const repeatedChunk = await backend.writeChunk({
          spaceId,
          collectionId,
          resourceId: 'chunked',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('chunk zero')),
          immutable: immutableUnder
        })
        assert.equal(formatEtag(repeatedChunk), formatEtag(chunk))
      })

      it('a repeat ignores media type parameters and case', async () => {
        const { backend } = harness
        const { validator: created } = await backend.writeResource({
          spaceId,
          collectionId: 'plain',
          resourceId: 'typed',
          input: binaryInput(Buffer.from('same bytes'), {
            contentType: 'text/plain'
          }),
          immutable: true
        })
        const { validator: repeated } = await backend.writeResource({
          spaceId,
          collectionId: 'plain',
          resourceId: 'typed',
          input: binaryInput(Buffer.from('same bytes'), {
            contentType: 'Text/Plain; charset=utf-8'
          }),
          immutable: true
        })
        assert.equal(formatEtag(repeated), formatEtag(created))
      })

      it('decides the rule before the unique-claim scan', async () => {
        const { backend } = harness
        const collectionId = 'unique'
        const claim = (id: string, value: string) => ({
          id,
          sequence: 0,
          indexed: [
            {
              hmac: { id: 'urn:hmac:immutable', type: 'Sha256HmacKey2019' },
              sequence: 0,
              attributes: [{ name: 'n1', value, unique: true }]
            }
          ],
          jwe: {
            protected: 'eyJlbmMiOiJYQzIwUCJ9',
            iv: 'aXY',
            ciphertext: 'Y2lwaGVydGV4dA',
            tag: 'dGFn'
          }
        })
        const write = (resourceId: string, value: string) =>
          backend.writeResource({
            spaceId,
            collectionId,
            resourceId,
            input: jsonInput(claim(resourceId, value)),
            immutable: true
          })
        await write('holder', 'v1')
        const created = await write('other', 'v2')
        // A changed body that also collides with `holder`'s claim is
        // answered by the write-once rule, not the claim.
        await expect(write('other', 'v1')).rejects.toBeInstanceOf(
          ResourceImmutableError
        )
        // A repeat claims nothing new and is still the no-op.
        assert.equal(
          formatEtag((await write('other', 'v2')).validator),
          formatEtag(created.validator)
        )
        // A create still pays for the scan.
        await expect(write('claimant', 'v1')).rejects.toBeInstanceOf(
          UniqueAttributeConflictError
        )
      })
    })

    describe('chunks (chunked-streams)', () => {
      let harness: BackendHarness
      const spaceId = 'space-chunks'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
        await harness.backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          input: jsonInput({ manifest: true })
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('writeChunk rejects when the parent Resource is absent', async () => {
        await expect(
          harness.backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'no-such-parent',
            chunkIndex: 0,
            input: binaryInput(Buffer.from('orphan'))
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
      })

      it('writeChunk is an upsert that advances the chunk stamp', async () => {
        const { backend } = harness
        const first = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('v1'))
        })
        assert.ok(first.generation)
        const second = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 0,
          input: binaryInput(Buffer.from('v2-longer'))
        })
        assertValidatorAdvanced(first, second)
        assert.equal(
          second.generation,
          first.generation,
          'an upsert keeps the chunk generation'
        )
      })

      it('getChunk / getChunkMetadata read back bytes, content-type, size, validator', async () => {
        const { backend } = harness
        const bytes = Buffer.from([9, 8, 7, 6])
        const written = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 1,
          input: binaryInput(bytes, { contentType: 'application/octet-stream' })
        })
        const result = await backend.getChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 1
        })
        assert.equal(result.storedResourceType, 'application/octet-stream')
        assert.equal(etagOf(result), formatEtag(written))
        const readChunks: Buffer[] = []
        for await (const part of result.resourceStream) {
          readChunks.push(Buffer.from(part))
        }
        assert.deepEqual(Buffer.concat(readChunks), bytes)

        const metadata = await backend.getChunkMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 1
        })
        assert.equal(metadata?.contentType, 'application/octet-stream')
        assert.equal(metadata?.size, bytes.length)
        assert.equal(etagOf(metadata!), formatEtag(written))
      })

      it('getChunk throws / getChunkMetadata resolves undefined on an absent chunk', async () => {
        await expect(
          harness.backend.getChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 99
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
        assert.equal(
          await harness.backend.getChunkMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 99
          }),
          undefined
        )
      })

      it('listChunks returns the chunk set in ascending index order', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-chunks-list')
        await backend.writeResource({
          spaceId: 'space-chunks-list',
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({})
        })
        // An empty listing when the Resource has no chunks.
        const empty = await backend.listChunks({
          spaceId: 'space-chunks-list',
          collectionId: 'col',
          resourceId: 'r'
        })
        assert.deepEqual(empty, { count: 0, chunks: [] })
        // Write out of order to prove the sort is by index, not write order.
        for (const chunkIndex of [2, 0, 1]) {
          await backend.writeChunk({
            spaceId: 'space-chunks-list',
            collectionId: 'col',
            resourceId: 'r',
            chunkIndex,
            input: binaryInput(Buffer.alloc(chunkIndex + 1, 1))
          })
        }
        const listing = await backend.listChunks({
          spaceId: 'space-chunks-list',
          collectionId: 'col',
          resourceId: 'r'
        })
        assert.equal(listing.count, 3)
        assert.deepEqual(
          listing.chunks.map(chunk => chunk.index),
          [0, 1, 2]
        )
        assert.deepEqual(
          listing.chunks.map(chunk => chunk.size),
          [1, 2, 3]
        )
        // Each entry's `etag` is the validator the chunk's own read reports,
        // so a client can pin a delete of a listed chunk on it.
        for (const chunk of listing.chunks) {
          assert.equal(
            chunk.etag,
            etagOf(
              (await backend.getChunkMetadata({
                spaceId: 'space-chunks-list',
                collectionId: 'col',
                resourceId: 'r',
                chunkIndex: chunk.index
              }))!
            )
          )
        }
      })

      it('deleteChunk resolves true when it removes a chunk, false when absent', async () => {
        const { backend } = harness
        await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 5,
          input: binaryInput(Buffer.from('gone'))
        })
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 5
          }),
          true
        )
        // A second delete of the now-absent chunk is not idempotent: false.
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 5
          }),
          false
        )
      })

      it('chunk conditional writes gate on the chunk validator', async () => {
        const { backend } = harness
        const created = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 7,
          input: binaryInput(Buffer.from('a')),
          ifNoneMatch: '*'
        })
        // If-None-Match: * on an existing chunk 412s.
        await expect(
          backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 7,
            input: binaryInput(Buffer.from('b')),
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // A stale If-Match 412s; the matching one succeeds.
        await expect(
          backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 7,
            input: binaryInput(Buffer.from('b')),
            ifMatch: etagWithCounterBumped({ validator: created, by: 9 })
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        const updated = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 7,
          input: binaryInput(Buffer.from('b')),
          ifMatch: formatEtag(created)
        })
        assertValidatorAdvanced(created, updated)
      })

      it('a chunk rewritten at a deleted index starts a new generation', async () => {
        const { backend } = harness
        const before = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 11,
          input: binaryInput(Buffer.from('before'))
        })
        await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 11,
          input: binaryInput(Buffer.from('before-again'))
        })
        assert.equal(
          await backend.deleteChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 11
          }),
          true
        )
        // A chunk delete is a hard delete, so the counter goes with it: the
        // next write at that index starts under a FRESH generation, and the
        // two lives' ETags can never coincide.
        const after = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 11,
          input: binaryInput(Buffer.from('after'))
        })
        assert.notEqual(after.generation, before.generation)
        const metadata = await backend.getChunkMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 11
        })
        assert.equal(metadata?.generation, after.generation)
        assert.equal(etagOf(metadata!), formatEtag(after))
      })

      it('If-Match carrying a pre-delete chunk ETag 412s against the recreated chunk', async () => {
        const { backend } = harness
        const before = await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 12,
          input: binaryInput(Buffer.from('before'))
        })
        await backend.deleteChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 12
        })
        await backend.writeChunk({
          spaceId,
          collectionId: 'col',
          resourceId: 'parent',
          chunkIndex: 12,
          input: binaryInput(Buffer.from('after'))
        })
        // The recreated chunk is also at version 1, so without the generation
        // the stale validator would match. It must 412.
        await expect(
          backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'parent',
            chunkIndex: 12,
            input: binaryInput(Buffer.from('clobber')),
            ifMatch: formatEtag(before)
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
      })

      it('deleteResource cascade-removes the Resource chunks', async () => {
        const { backend } = harness
        await provisionSpace(backend, 'space-chunks-cascade')
        await backend.writeResource({
          spaceId: 'space-chunks-cascade',
          collectionId: 'col',
          resourceId: 'r',
          input: jsonInput({})
        })
        for (const chunkIndex of [0, 1]) {
          await backend.writeChunk({
            spaceId: 'space-chunks-cascade',
            collectionId: 'col',
            resourceId: 'r',
            chunkIndex,
            input: binaryInput(Buffer.from('x'))
          })
        }
        await backend.deleteResource({
          spaceId: 'space-chunks-cascade',
          collectionId: 'col',
          resourceId: 'r'
        })
        // The chunks are gone with their parent.
        await expect(
          backend.getChunk({
            spaceId: 'space-chunks-cascade',
            collectionId: 'col',
            resourceId: 'r',
            chunkIndex: 0
          })
        ).rejects.toBeInstanceOf(ResourceNotFoundError)
        const listing = await backend.listChunks({
          spaceId: 'space-chunks-cascade',
          collectionId: 'col',
          resourceId: 'r'
        })
        assert.equal(listing.count, 0)
      })

      // Exact-usage backends account usage transactionally, so two creators
      // racing on one not-yet-existing key must count its bytes once, not
      // twice (the lock-nothing `SELECT ... FOR UPDATE` race). The bodies are
      // the same length, so the final usage is one body's length regardless of
      // which write lands last. The du-measured filesystem backend skips this:
      // it re-measures from disk, so the race cannot inflate its figure.
      it.runIf(exactUsage)(
        'two creators racing on one new Resource count its bytes once',
        async () => {
          const race = await makeBackend()
          try {
            const spaceId = 'space-create-race'
            await provisionSpace(race.backend, spaceId)
            const bodyOne = Buffer.from('race-body-1')
            const bodyTwo = Buffer.from('race-body-2')
            await Promise.all([
              race.backend.writeResource({
                spaceId,
                collectionId: 'col',
                resourceId: 'raced',
                input: binaryInput(bodyOne)
              }),
              race.backend.writeResource({
                spaceId,
                collectionId: 'col',
                resourceId: 'raced',
                input: binaryInput(bodyTwo)
              })
            ])
            const usage = await race.backend.reportUsage({ spaceId })
            assert.equal(usage.usageBytes, bodyOne.length)
          } finally {
            await race.cleanup()
          }
        }
      )

      it.runIf(exactUsage)(
        'two creators racing on one new chunk count its bytes once',
        async () => {
          const race = await makeBackend()
          try {
            const spaceId = 'space-chunk-create-race'
            await provisionSpace(race.backend, spaceId)
            const parentInput = jsonInput({ manifest: true })
            await race.backend.writeResource({
              spaceId,
              collectionId: 'col',
              resourceId: 'parent',
              input: parentInput
            })
            const parentBytes = JSON.stringify({ manifest: true }).length
            const bodyOne = Buffer.from('race-body-1')
            const bodyTwo = Buffer.from('race-body-2')
            await Promise.all([
              race.backend.writeChunk({
                spaceId,
                collectionId: 'col',
                resourceId: 'parent',
                chunkIndex: 0,
                input: binaryInput(bodyOne)
              }),
              race.backend.writeChunk({
                spaceId,
                collectionId: 'col',
                resourceId: 'parent',
                chunkIndex: 0,
                input: binaryInput(bodyTwo)
              })
            ])
            const usage = await race.backend.reportUsage({ spaceId })
            assert.equal(usage.usageBytes, parentBytes + bodyOne.length)
          } finally {
            await race.cleanup()
          }
        }
      )
    })

    describe('Space deletion racing a write', () => {
      // Whichever of the two lands first, the other must resolve as itself or
      // as a PWS error -- never as a raw storage fault, which carries no
      // `type` and so renders a 500. The pair contends over the same records:
      // a write provisions the Space and its Collection, and the delete
      // removes the Space and everything under it. The filesystem backend
      // serializes them on its per-Space gate; Postgres serializes them on the
      // `spaces` row, which is why provisioning that row and locking it have
      // to be one statement -- with a lockless `ON CONFLICT DO NOTHING`
      // followed by a separate `FOR UPDATE`, a delete committing in between
      // leaves the writer locking nothing and its next insert raising a
      // foreign-key violation.
      it('resolves both sides without a raw storage fault', async () => {
        const race = await makeBackend()
        try {
          // The window is a statement wide, so the interleaving is sampled
          // rather than forced: repeat enough to land in it.
          for (let attempt = 0; attempt < 10; attempt++) {
            const spaceId = `space-delete-race-${attempt}`
            await provisionSpace(race.backend, spaceId)
            const outcomes = await Promise.allSettled([
              race.backend.writeResource({
                spaceId,
                collectionId: 'col',
                resourceId: 'doc',
                input: jsonInput({ racing: attempt })
              }),
              race.backend.deleteSpace({ spaceId }),
              race.backend.writeCollection({
                spaceId,
                collectionId: 'raced-col',
                collectionMetadata: {
                  id: 'raced-col',
                  type: ['Collection'],
                  name: 'raced-col'
                }
              })
            ])
            for (const outcome of outcomes) {
              if (outcome.status === 'rejected') {
                assert.ok(
                  outcome.reason instanceof ProblemError,
                  `unmapped storage fault: ${String(outcome.reason)}`
                )
              }
            }
          }
        } finally {
          await race.cleanup()
        }
      })
    })

    describe('write stamps and validator segments', () => {
      it('every record kind returns a validator whose segments match its stored stamp, and a backwards clock step lowers no stamp', async () => {
        const clock = frozenClock()
        const harness = await makeBackend({ physicalClock: clock.read })
        try {
          const { backend } = harness
          const originId = backend.originId
          const spaceId = 'space-segments'
          const collectionId = 'col'

          const { validator: spaceWritten } = await backend.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              controller: CONTROLLER
            }
          })
          const space = (await backend.getSpaceMetadata({ spaceId }))!
          assertValidatorSegments({
            validator: spaceWritten,
            stored: {
              ...space,
              generation: space.metaGeneration,
              local: space.metaLocal
            },
            originId,
            ms: clock.now
          })
          assert.equal(spaceWritten.local, 0)
          assert.equal(metadataEtagOf(space), formatEtag(spaceWritten))

          const { validator: collectionWritten } =
            await backend.writeCollection({
              spaceId,
              collectionId,
              collectionMetadata: { id: collectionId, type: ['Collection'] }
            })
          const collection = (await backend.getCollectionMetadata({
            spaceId,
            collectionId
          }))!
          assertValidatorSegments({
            validator: collectionWritten,
            stored: {
              ...collection,
              generation: collection.metaGeneration,
              local: collection.metaLocal
            },
            originId,
            ms: clock.now
          })
          // Same millisecond as the Space write: the counter tells them apart.
          assert.equal(
            collectionWritten.stamp.updatedAtCounter,
            spaceWritten.stamp.updatedAtCounter + 1
          )

          clock.now += 1000
          const { validator: docWritten } = await backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'doc',
            input: jsonInput({ n: 1 })
          })
          const doc = (await backend.getResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc'
          }))!
          assertValidatorSegments({
            validator: docWritten,
            stored: doc,
            originId,
            ms: clock.now
          })
          assert.equal(docWritten.stamp.updatedAtCounter, 0)

          const metaWritten = (await backend.writeResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc',
            custom: { name: 'Doc' }
          }))!.validator
          const withMeta = (await backend.getResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc'
          }))!
          assertValidatorSegments({
            validator: metaWritten,
            stored: withMeta.meta!,
            originId,
            ms: clock.now
          })
          assert.equal(metaWritten.stamp.updatedAtCounter, 1)

          const chunkWritten = await backend.writeChunk({
            spaceId,
            collectionId,
            resourceId: 'doc',
            chunkIndex: 0,
            input: binaryInput(Buffer.from('chunk'))
          })
          const chunk = (await backend.getChunkMetadata({
            spaceId,
            collectionId,
            resourceId: 'doc',
            chunkIndex: 0
          }))!
          assertValidatorSegments({
            validator: chunkWritten,
            stored: chunk,
            originId,
            ms: clock.now
          })

          await backend.writeCollection({
            spaceId,
            collectionId: 'logged',
            collectionMetadata: { id: 'logged', type: ['Collection'] }
          })
          const logCreated = (await backend.writeCollectionLog({
            spaceId,
            collectionId: 'logged',
            body: '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n',
            ifNoneMatch: '*'
          }))!
          const log = (await backend.getCollectionLog({
            spaceId,
            collectionId: 'logged'
          }))!
          assertValidatorSegments({
            validator: logCreated,
            stored: {
              generation: log.validator.generation,
              ...log.validator.stamp
            },
            originId,
            ms: clock.now
          })

          // The physical clock steps back 30 s. A write to a Resource the
          // store has never held, so no held stamp lifts it, still lands at
          // or above every stamp minted before the step.
          const latest = logCreated.stamp
          clock.now -= 30_000
          const { validator: otherWritten } = await backend.writeResource({
            spaceId,
            collectionId,
            resourceId: 'other',
            input: jsonInput({ n: 2 })
          })
          const other = (await backend.getResourceMetadata({
            spaceId,
            collectionId,
            resourceId: 'other'
          }))!
          assertValidatorSegments({
            validator: otherWritten,
            stored: other,
            originId
          })
          assert.ok(Date.parse(other.updatedAt!) >= Date.parse(doc.updatedAt!))
          assert.ok(
            compareStamps(otherWritten.stamp, latest) > 0,
            'above the last stamp minted before the step'
          )

          // A container rewrite after the step advances on the same terms.
          const { validator: collectionRewritten } =
            await backend.writeCollection({
              spaceId,
              collectionId,
              collectionMetadata: { id: collectionId, type: ['Collection'] }
            })
          assertValidatorAdvanced(collectionWritten, collectionRewritten)
          assert.ok(
            Date.parse(collectionRewritten.stamp.updatedAt) >=
              Date.parse(otherWritten.stamp.updatedAt)
          )
          const rewritten = (await backend.getCollectionMetadata({
            spaceId,
            collectionId
          }))!
          assertValidatorSegments({
            validator: collectionRewritten,
            stored: {
              ...rewritten,
              generation: rewritten.metaGeneration,
              local: rewritten.metaLocal
            },
            originId
          })
        } finally {
          await harness.cleanup()
        }
      })
    })

    describe('governing history log (governed-history-logs)', () => {
      let harness: BackendHarness
      const spaceId = 'space-log'
      const line1 = '{"state":{"scheme":"edv"},"parameters":{"method":"x"}}\n'
      const line2 = '{"state":{"scheme":"edv","version":1},"parameters":{}}\n'
      beforeAll(async () => {
        harness = await makeBackend()
        await provisionSpace(harness.backend, spaceId)
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      /** Creates a fresh Collection in this suite's Space and returns its id. */
      async function freshCollection(): Promise<string> {
        const collectionId = `col-${crypto.randomUUID()}`
        await harness.backend.writeCollection({
          spaceId,
          collectionId,
          collectionMetadata: {
            id: collectionId,
            type: ['Collection'],
            name: collectionId
          }
        })
        return collectionId
      }

      it('is absent until created, then round-trips the body verbatim with a stamped validator', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        assert.equal(
          await backend.getCollectionLog({ spaceId, collectionId }),
          undefined
        )
        const created = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: line1,
          ifNoneMatch: '*'
        })
        assert.ok(created?.generation)
        const stored = await backend.getCollectionLog({ spaceId, collectionId })
        assert.equal(stored?.body, line1)
        assert.equal(formatEtag(stored!.validator), formatEtag(created!))
        assert.equal(stored?.validator.generation, created?.generation)

        const appended = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: line1 + line2,
          ifMatch: formatEtag(created!)
        })
        assertValidatorAdvanced(created!, appended!)
        assert.equal(appended?.generation, created?.generation)
        const extended = await backend.getCollectionLog({
          spaceId,
          collectionId
        })
        assert.equal(extended?.body, line1 + line2)
      })

      it('resolves undefined (no create) for an absent Collection', async () => {
        assert.equal(
          await harness.backend.writeCollectionLog({
            spaceId,
            collectionId: 'absent-collection',
            body: line1,
            ifNoneMatch: '*'
          }),
          undefined
        )
      })

      it('evaluates the preconditions on the log ETag and runs assertTransition under the lock', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const seen: unknown[] = []
        const created = await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: line1,
          ifNoneMatch: '*',
          assertTransition: ({ prior, collectionMetadata }) => {
            seen.push(prior, collectionMetadata.id)
          }
        })
        assert.deepEqual(seen, [undefined, collectionId])
        // A second guarded create, and a stale If-Match, both fail closed.
        await expect(
          backend.writeCollectionLog({
            spaceId,
            collectionId,
            body: line1,
            ifNoneMatch: '*'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        await expect(
          backend.writeCollectionLog({
            spaceId,
            collectionId,
            body: line1 + line2,
            ifMatch: '"stale.9.0.x"'
          })
        ).rejects.toBeInstanceOf(PreconditionFailedError)
        // A throwing assertTransition aborts the write.
        await expect(
          backend.writeCollectionLog({
            spaceId,
            collectionId,
            body: line1 + line2,
            ifMatch: formatEtag(created!),
            assertTransition: ({ prior }) => {
              assert.equal(prior?.body, line1)
              throw new Error('refused')
            }
          })
        ).rejects.toThrow('refused')
        const stored = await backend.getCollectionLog({ spaceId, collectionId })
        assert.equal(stored?.body, line1)
        assert.equal(formatEtag(stored!.validator), formatEtag(created!))
      })

      it('advances the Collection Metadata local segment on each log write, keeping its stamp and generation', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        const before = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: line1,
          ifNoneMatch: '*'
        })
        const after = await backend.getCollectionMetadata({
          spaceId,
          collectionId
        })
        assert.equal(after?.metaGeneration, before?.metaGeneration)
        assert.equal(after?.metaLocal, before!.metaLocal! + 1)
        assert.equal(after?.updatedAt, before?.updatedAt)
        assert.equal(after?.updatedAtCounter, before?.updatedAtCounter)
        assert.equal(after?.originId, before?.originId)
        assert.notEqual(metadataEtagOf(after), metadataEtagOf(before))
        // The stored object itself is untouched (no derived member).
        assert.equal(after?.encryption, undefined)
        assert.equal(after?.name, collectionId)
      })

      it('goes away with its Collection, and is no Resource in the listing or the feed', async () => {
        const { backend } = harness
        const collectionId = await freshCollection()
        await backend.writeCollectionLog({
          spaceId,
          collectionId,
          body: line1,
          ifNoneMatch: '*'
        })
        const listing = await backend.listCollectionItems({
          spaceId,
          collectionId
        })
        assert.equal(listing.items.length, 0)
        const feed = await backend.changesSince!({
          spaceId,
          collectionId,
          limit: 100
        })
        assert.equal(resourceDocuments(feed.documents).length, 0)
        assert.deepEqual(
          feed.documents.map(document => document.kind),
          ['collection-metadata', 'log']
        )

        await backend.deleteCollection({ spaceId, collectionId })
        assert.equal(
          await backend.getCollectionLog({ spaceId, collectionId }),
          undefined
        )
      })

      it('travels in an export and is restored by an import', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const exportSpaceId = 'space-log-exp'
          await provisionSpace(source.backend, exportSpaceId)
          await source.backend.writeCollection({
            spaceId: exportSpaceId,
            collectionId: 'governed',
            collectionMetadata: {
              id: 'governed',
              type: ['Collection'],
              name: 'governed'
            }
          })
          const sourceLog = await source.backend.writeCollectionLog({
            spaceId: exportSpaceId,
            collectionId: 'governed',
            body: line1 + line2,
            ifNoneMatch: '*'
          })
          const tarStream = await source.backend.exportSpace({
            spaceId: exportSpaceId
          })
          await provisionSpace(target.backend, exportSpaceId)
          await importArchive({
            backend: target.backend,
            spaceId: exportSpaceId,
            tarStream
          })
          const restored = await target.backend.getCollectionLog({
            spaceId: exportSpaceId,
            collectionId: 'governed'
          })
          assert.equal(restored?.body, line1 + line2)
          // The archived generation is kept; the stamp is the importing
          // backend's own.
          assert.equal(restored?.validator.generation, sourceLog?.generation)
          assert.equal(
            restored?.validator.stamp.originId,
            target.backend.originId
          )
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })
    })

    describe('export / import round-trip', () => {
      it('restores the archived Space Metadata name under a root invocation, by an ordinary Metadata write', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const spaceId = 'space-exp-meta'
          await provisionSpace(source.backend, spaceId)
          const archive = async () =>
            await source.backend.exportSpace({ spaceId })

          // The destination carries its own name; the restore replaces it
          // through the same write `writeSpace` makes: a later stamp,
          // generation kept, `controller` untouched.
          await provisionSpace(target.backend, spaceId)
          await target.backend.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              name: 'Destination',
              controller: CONTROLLER
            }
          })
          const before = (await target.backend.getSpaceMetadata({ spaceId }))!
          const restored = await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: await archive(),
            restoreSpaceMetadata: true
          })
          assert.equal(restored.spaceMetadata, 'restored')
          const after = (await target.backend.getSpaceMetadata({ spaceId }))!
          assert.equal(after.name, `Space ${spaceId}`)
          assert.equal(after.controller, CONTROLLER)
          assertEtagAdvanced({
            before: metadataEtagOf(before),
            after: metadataEtagOf(after),
            container: true
          })
          assert.equal(after.metaGeneration, before.metaGeneration)

          // Not under a root invocation (the default, a backend driven outside
          // a request): the entry is reported and left alone.
          await target.backend.writeSpace({
            spaceId,
            spaceMetadata: { ...after, name: 'Destination' }
          })
          const skipped = await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: await archive()
          })
          assert.equal(skipped.spaceMetadata, 'skipped')
          assert.equal(
            (await target.backend.getSpaceMetadata({ spaceId }))!.name,
            'Destination'
          )

          // `type` is immutable once a Space exists, so an archive of a Space
          // of another kind is refused, and the destination keeps its name.
          const otherKind = 'space-exp-meta-kind'
          await source.backend.writeSpace({
            spaceId: otherKind,
            spaceMetadata: {
              id: otherKind,
              type: ['AuxiliarySpace', 'Space'],
              name: 'Auxiliary',
              controller: CONTROLLER
            }
          })
          await provisionSpace(target.backend, otherKind)
          await expect(
            importArchive({
              backend: target.backend,
              spaceId: otherKind,
              tarStream: await source.backend.exportSpace({
                spaceId: otherKind
              }),
              restoreSpaceMetadata: true
            })
          ).rejects.toBeInstanceOf(InvalidImportError)
          const kept = (await target.backend.getSpaceMetadata({
            spaceId: otherKind
          }))!
          assert.equal(kept.name, `Space ${otherKind}`)
          assert.deepEqual(kept.type, ['Space'])
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('round-trips a Space (metadata, resources, policies, tombstones) within the backend', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const spaceId = 'space-exp'
          await provisionSpace(source.backend, spaceId)
          await source.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            input: jsonInput({ keep: true }),
            createdBy: CREATOR_ONE
          })
          await source.backend.writeResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            custom: { name: 'Doc' }
          })
          await source.backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'gone',
            input: jsonInput({ keep: false })
          })
          await source.backend.deleteResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'gone'
          })
          await source.backend.writePolicy({
            spaceId,
            policy: { type: 'Marker', space: true } as never
          })
          await source.backend.writePolicy({
            spaceId,
            collectionId: 'col',
            policy: { type: 'Marker', collection: true } as never
          })
          await source.backend.writePolicy({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            policy: { type: 'Marker', resource: true } as never
          })
          // Backend registration records must NOT travel in an export.
          await source.backend.writeBackend({
            spaceId,
            backendId: 'ext',
            record: {
              id: 'ext',
              managedBy: 'external',
              provider: 'x',
              connection: { kind: 'token', secret: 'DO-NOT-EXPORT' } as never
            }
          })

          const tarStream = await source.backend.exportSpace({ spaceId })
          // Provision the destination Space (import merges into an existing
          // Space, as the request layer guarantees).
          await provisionSpace(target.backend, spaceId)
          await target.backend.deletePolicy({ spaceId })
          const stats = await importArchive({
            backend: target.backend,
            spaceId,
            tarStream
          })
          assert.equal(stats.collectionsSkipped, 1) // 'col' pre-provisioned
          assert.equal(stats.resourcesCreated, 2) // doc + the tombstone
          assert.equal(stats.policiesCreated, 2) // space + resource policy
          assert.equal(stats.policiesSkipped, 1) // collection policy skipped

          const result = await target.backend.getResource({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc'
          })
          assert.equal(
            await streamToString(result.resourceStream),
            JSON.stringify({ keep: true })
          )
          const metadata = await target.backend.getResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc'
          })
          assert.deepEqual(metadata?.custom, { name: 'Doc' })
          // An export without an attestor carries no provenance, so the
          // Resource's `createdBy` is unearned and dropped on import.
          assert.equal(metadata?.createdBy, undefined)
          assert.equal(stats.provenance.unattested, 3)

          // The tombstone carried over: invisible to reads, blocks
          // resurrection, and still replicates through the feed.
          await expect(
            target.backend.getResource({
              spaceId,
              collectionId: 'col',
              resourceId: 'gone'
            })
          ).rejects.toBeInstanceOf(ResourceNotFoundError)
          const feed = await target.backend.changesSince!({
            spaceId,
            collectionId: 'col',
            limit: 100
          })
          const tombstone = resourceDocuments(feed.documents).find(
            document => document.resourceId === 'gone'
          )
          assert.equal(tombstone?.deleted, true)

          // No secret-bearing backend record traveled.
          assert.equal(
            await target.backend.getBackend({ spaceId, backendId: 'ext' }),
            undefined
          )
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('carries Collection Metadata onto a newly-created Collection', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const spaceId = 'space-exp-collection-meta'
          await provisionSpace(source.backend, spaceId)
          await source.backend.writeCollection({
            spaceId,
            collectionId: 'col',
            collectionMetadata: {
              id: 'col',
              type: ['Collection'],
              name: 'col',
              custom: { name: 'Collection Label', tags: { kind: 'demo' } },
              epoch: 'epoch-exp'
            }
          })

          const tarStream = await source.backend.exportSpace({ spaceId })
          // Provision the destination Space around a DIFFERENT Collection, so
          // the archived 'col' is created rather than skipped (an existing
          // Collection keeps its own metadata, as it keeps its policy).
          await provisionSpace(target.backend, spaceId, 'other')
          await importArchive({ backend: target.backend, spaceId, tarStream })

          const metadata = await target.backend.getCollectionMetadata({
            spaceId,
            collectionId: 'col'
          })
          assert.deepEqual(metadata?.custom, {
            name: 'Collection Label',
            tags: { kind: 'demo' }
          })
          assert.equal(metadata?.epoch, 'epoch-exp')
          // The archived generation travels; the stamp is re-minted by the
          // destination's clock under its own origin, with a fresh local
          // segment.
          const sourceMetadata = await source.backend.getCollectionMetadata({
            spaceId,
            collectionId: 'col'
          })
          assert.equal(metadata?.metaGeneration, sourceMetadata?.metaGeneration)
          assert.equal(metadata?.originId, target.backend.originId)
          assert.equal(metadata?.metaLocal, 0)
          assert.ok(!Number.isNaN(Date.parse(metadata!.createdAt!)))
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('import drops non-canonical-index and orphan chunk files', async () => {
        const target = await makeBackend()
        try {
          const spaceId = 'space-imp-chunk-gates'
          // Hand-build an archive in the export dialect carrying three chunk
          // files: a canonical chunk 1 of 'doc', a NON-canonical spelling of
          // the same index (`r.01.*`, which must be dropped, not coerced onto
          // -- or stored alongside -- the canonical chunk), and a chunk of
          // 'ghost', which has no representation in the archive (an orphan
          // that must not be resurrected).
          const pack = tar.pack()
          pack.entry(
            { name: 'manifest.yml' },
            [
              "ubc-version: '0.1'",
              'contents:',
              '  space:',
              '    id: src',
              ''
            ].join('\n')
          )
          pack.entry(
            { name: 'space/src/col/r.doc.application%2Fjson.json' },
            JSON.stringify({ manifest: true })
          )
          pack.entry(
            {
              name: 'space/src/col/.chunks.doc/r.1.application%2Foctet-stream.bin'
            },
            'canonical'
          )
          pack.entry(
            {
              name: 'space/src/col/.chunks.doc/r.01.application%2Foctet-stream.bin'
            },
            'alias'
          )
          pack.entry(
            {
              name: 'space/src/col/.chunks.ghost/r.0.application%2Foctet-stream.bin'
            },
            'orphan'
          )
          pack.finalize()

          await provisionSpace(target.backend, spaceId)
          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: pack as unknown as Readable
          })

          // Only the canonical chunk landed, with its own bytes...
          const listing = await target.backend.listChunks({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc'
          })
          assert.deepEqual(
            listing.chunks.map(chunk => chunk.index),
            [1]
          )
          const chunk = await target.backend.getChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc',
            chunkIndex: 1
          })
          assert.equal(await streamToString(chunk.resourceStream), 'canonical')

          // ...and the orphan was skipped on both backends.
          const ghost = await target.backend.listChunks({
            spaceId,
            collectionId: 'col',
            resourceId: 'ghost'
          })
          assert.equal(ghost.count, 0)
          await expect(
            target.backend.getChunk({
              spaceId,
              collectionId: 'col',
              resourceId: 'ghost',
              chunkIndex: 0
            })
          ).rejects.toBeInstanceOf(ResourceNotFoundError)
        } finally {
          await target.cleanup()
        }
      })

      it('import gives a chunk without a usable sidecar a fresh one, and replaces archived generations this server could not have minted', async () => {
        const target = await makeBackend()
        try {
          const spaceId = 'space-imp-generations'
          const archivedStamp = {
            updatedAt: '2026-01-01T00:00:00.000Z',
            updatedAtCounter: 0,
            originId: 'zArchiveOrigin'
          }
          const badGenerations = ['a.b', 'quote"d', 'line\nbreak', '0OIl']
          const genesis = JSON.stringify({
            versionId: '1-hash1',
            parameters: { method: 'resource-log:0.1' },
            state: { scheme: 'edv' },
            proof: []
          })
          const pack = tar.pack()
          pack.entry(
            { name: 'manifest.yml' },
            [
              "ubc-version: '0.1'",
              'contents:',
              '  space:',
              '    id: src',
              ''
            ].join('\n')
          )
          pack.entry(
            { name: 'space/src/col/.collection.meta.col.json' },
            JSON.stringify({
              id: 'col',
              type: ['Collection'],
              name: 'col',
              ...archivedStamp,
              _generation: badGenerations[2]
            })
          )
          pack.entry(
            { name: 'space/src/col/r.doc.application%2Fjson.json' },
            JSON.stringify({ n: 1 })
          )
          pack.entry(
            { name: 'space/src/col/.meta.doc.json' },
            JSON.stringify({
              createdAt: archivedStamp.updatedAt,
              ...archivedStamp,
              generation: badGenerations[0],
              meta: { ...archivedStamp, generation: badGenerations[1] }
            })
          )
          // Chunk 0 has no sidecar, chunk 1 a sidecar that is not a JSON
          // object, chunk 2 one whose generation is not base58.
          for (const index of [0, 1, 2]) {
            pack.entry(
              {
                name: `space/src/col/.chunks.doc/r.${index}.application%2Foctet-stream.bin`
              },
              `chunk ${index}`
            )
          }
          pack.entry({ name: 'space/src/col/.chunks.doc/.meta.1.json' }, 'null')
          pack.entry(
            { name: 'space/src/col/.chunks.doc/.meta.2.json' },
            JSON.stringify({
              createdAt: archivedStamp.updatedAt,
              ...archivedStamp,
              generation: badGenerations[3]
            })
          )
          pack.entry(
            { name: 'space/src/logged/.collectionlog.logged.json' },
            JSON.stringify({
              body: `${genesis}\n`,
              generation: badGenerations[0],
              ...archivedStamp
            })
          )
          pack.finalize()

          await target.backend.writeSpace({
            spaceId,
            spaceMetadata: {
              id: spaceId,
              type: ['Space'],
              controller: CONTROLLER
            }
          })
          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: pack as unknown as Readable
          })

          /**
           * Asserts a generation is one this server could have minted, and
           * not one of the archived ones.
           * @param generation {string | undefined}
           * @returns {void}
           */
          function assertFresh(generation: string | undefined): void {
            assert.ok(isMintedGeneration(generation), String(generation))
            assert.ok(!badGenerations.includes(generation!))
          }

          const collection = (await target.backend.getCollectionMetadata({
            spaceId,
            collectionId: 'col'
          }))!
          assertFresh(collection.metaGeneration)
          parseEtagSegments(metadataEtagOf(collection), { container: true })

          const doc = (await target.backend.getResourceMetadata({
            spaceId,
            collectionId: 'col',
            resourceId: 'doc'
          }))!
          assertFresh(doc.generation)
          assertFresh(doc.meta?.generation)
          parseEtagSegments(etagOf(doc))

          for (const chunkIndex of [0, 1, 2]) {
            const chunk = await target.backend.getChunkMetadata({
              spaceId,
              collectionId: 'col',
              resourceId: 'doc',
              chunkIndex
            })
            assert.ok(chunk, `chunk ${chunkIndex} imported`)
            assertFresh(chunk.generation)
            const segments = parseEtagSegments(etagOf(chunk))
            assert.equal(segments.stamp.originId, target.backend.originId)
            assert.equal(
              Date.parse(segments.stamp.updatedAt),
              Date.parse(chunk.updatedAt!)
            )
          }

          const log = (await target.backend.getCollectionLog({
            spaceId,
            collectionId: 'logged'
          }))!
          assertFresh(log.validator.generation)
          parseEtagSegments(formatEtag(log.validator))
        } finally {
          await target.cleanup()
        }
      })

      it('round-trips a Space-scoped zcap revocation whose chain verifies under the destination Space', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const spaceId = 'space-exp-rev'
          const spaceUrl = revocationSpaceUrl(spaceId)
          const { did, signer } = bareDidKeyOf(
            await Ed25519VerificationKey.generate()
          )
          const controller = did as IDID
          const capability = await delegatedFromSpace({ signer, spaceUrl })
          const { delegator, capabilities } = await verifyRevocationChain({
            capability,
            rootTarget: spaceUrl,
            rootController: controller
          })
          await provisionSpace(source.backend, spaceId, 'col', controller)
          await source.backend.insertRevocation({
            scope: { spaceId },
            record: revocationRecordFor({
              capability,
              delegator,
              rootTarget: spaceUrl
            })
          })
          await provisionSpace(target.backend, spaceId, 'col', controller)
          const revocationScope = {
            spaceId,
            rootTarget: spaceUrl,
            rootController: controller,
            webvh: {
              storage: target.backend,
              serverBackends: new ServerBackends({
                backends: [target.backend]
              }),
              serverUrl: REVOCATION_SERVER_URL
            },
            invocation: { rootInvocation: true }
          }

          // With no revocation scope, the plan installs no revocation.
          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: await source.backend.exportSpace({ spaceId })
          })
          assert.equal(
            await target.backend.isRevoked({
              scope: { spaceId },
              capabilities
            }),
            false
          )

          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: await source.backend.exportSpace({ spaceId }),
            revocationScope
          })
          assert.equal(
            await target.backend.isRevoked({
              scope: { spaceId },
              capabilities
            }),
            true
          )
          // The stored record's `meta` is rebuilt server-side.
          const [stored, ...rest] = await archivedRevocations({
            backend: target.backend,
            spaceId
          })
          assert.equal(rest.length, 0)
          assert.equal(stored!.capability.id, capability.id)
          assert.equal(stored!.meta.delegator, delegator)
          assert.equal(stored!.meta.rootTarget, spaceUrl)
          assert.equal(
            Date.parse(stored!.meta.expires!),
            Date.parse(capability.expires) + 24 * 60 * 60 * 1000
          )

          // Re-importing the same archive skips the already-stored record
          // rather than rejecting the import as a duplicate.
          await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: await source.backend.exportSpace({ spaceId }),
            revocationScope
          })
          assert.equal(
            await target.backend.isRevoked({
              scope: { spaceId },
              capabilities
            }),
            true
          )
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })

      it('skips an archived revocation whose chain does not verify under the destination Space', async () => {
        const source = await makeBackend()
        const target = await makeBackend()
        try {
          const spaceId = 'space-exp-rev-skip'
          const spaceUrl = revocationSpaceUrl(spaceId)
          const otherSpaceUrl = revocationSpaceUrl('space-exp-rev-other')
          const { did, signer } = bareDidKeyOf(
            await Ed25519VerificationKey.generate()
          )
          const controller = did as IDID
          // A genuine delegation, but rooted in another Space's URL.
          const elsewhere = await delegatedFromSpace({
            signer,
            spaceUrl: otherSpaceUrl
          })
          const elsewhereVerified = await verifyRevocationChain({
            capability: elsewhere,
            rootTarget: otherSpaceUrl,
            rootController: controller
          })
          // A forged record: no proof at all.
          const forged = revocationRecord({
            capabilityId: 'urn:zcap:forged',
            delegator: 'did:key:z6MkDelegator'
          })
          // A root capability, which cannot be revoked.
          const root = revocationRecord({
            capabilityId: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
            delegator: controller
          })
          await provisionSpace(source.backend, spaceId, 'col', controller)
          for (const record of [
            forged,
            root,
            revocationRecordFor({
              capability: elsewhere,
              delegator: elsewhereVerified.delegator,
              rootTarget: spaceUrl
            })
          ]) {
            await source.backend.insertRevocation({
              scope: { spaceId },
              record
            })
          }
          assert.equal(
            (await archivedRevocations({ backend: source.backend, spaceId }))
              .length,
            3
          )

          await provisionSpace(target.backend, spaceId, 'col', controller)
          const stats = await importArchive({
            backend: target.backend,
            spaceId,
            tarStream: await source.backend.exportSpace({ spaceId }),
            revocationScope: {
              spaceId,
              rootTarget: spaceUrl,
              rootController: controller,
              webvh: {
                storage: target.backend,
                serverBackends: new ServerBackends({
                  backends: [target.backend]
                }),
                serverUrl: REVOCATION_SERVER_URL
              },
              invocation: { rootInvocation: true }
            }
          })
          // The import itself succeeds; only the revocations are skipped.
          assert.equal(stats.collectionsSkipped, 1)
          assert.deepStrictEqual(
            await archivedRevocations({ backend: target.backend, spaceId }),
            []
          )
          for (const capabilities of [
            elsewhereVerified.capabilities,
            [
              {
                capabilityId: forged.capability.id,
                delegator: forged.meta.delegator
              }
            ]
          ]) {
            assert.equal(
              await target.backend.isRevoked({
                scope: { spaceId },
                capabilities
              }),
              false
            )
          }
        } finally {
          await source.cleanup()
          await target.cleanup()
        }
      })
    })

    describe('export provenance', () => {
      let harness: BackendHarness
      let attestor: ExportAttestor
      const spaceId = 'space-provenance'
      const serverUrl = 'https://pws.example'

      /**
       * Exports the Space and opens the archive, collecting every content
       * file's bytes by archive path.
       */
      async function exportAndRead(withAttestor: boolean) {
        const archive = await readSpaceArchive(
          await collectBytes(
            await harness.backend.exportSpace({
              spaceId,
              ...(withAttestor && { attestor })
            })
          )
        )
        const files = new Map<string, Uint8Array>()
        for await (const entry of archive.entries) {
          if (entry.type === 'file') {
            files.set(entry.name, await entry.bytes())
          }
        }
        return { archive, files }
      }

      beforeAll(async () => {
        harness = await makeBackend()
        const { backend } = harness
        const { signingKey } = await provisionServerIdentity({
          backend,
          serverUrl,
          seed: randomBytes(32)
        })
        const loaded = await loadExportAttestor({
          storage: backend,
          serverBackends: new ServerBackends({ backends: [backend] }),
          serverUrl,
          signingKey,
          logger: pino({ level: 'silent' })
        })
        assert.ok('attestor' in loaded)
        attestor = loaded.attestor

        await provisionSpace(backend, spaceId)
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'plain',
          input: jsonInput({ hello: 'world' }),
          createdBy: CREATOR_ONE
        })
        // Eleven chunks, so the chunk files' name order (`r.10` before `r.2`)
        // differs from their index order.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'big',
          input: jsonInput({ chunks: 11 }),
          createdBy: CREATOR_TWO
        })
        for (let chunkIndex = 0; chunkIndex < 11; chunkIndex++) {
          await backend.writeChunk({
            spaceId,
            collectionId: 'col',
            resourceId: 'big',
            chunkIndex,
            input: binaryInput(Buffer.from(`chunk ${chunkIndex}`))
          })
        }
        // A tombstone holds no content and gets no statement.
        await backend.writeResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'gone',
          input: jsonInput({ soon: 'deleted' })
        })
        await backend.deleteResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'gone'
        })
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('signs one statement per exported object, in manifest order, verifiable offline', async () => {
        const { archive, files } = await exportAndRead(true)
        assert.ok(archive.provenance && archive.didLog)
        assert.deepStrictEqual(
          Buffer.from(archive.didLog),
          Buffer.from(attestor.didLog)
        )
        const { did, statements } = await verifyProvenanceOffline({
          provenance: archive.provenance,
          didLog: archive.didLog
        })
        assert.equal(did, attestor.serverDid)

        const base = `${serverUrl}/space/${spaceId}`
        assert.deepStrictEqual(
          statements.map(statement => statement.id),
          [
            `${base}/meta`,
            `${base}/col/meta`,
            `${base}/col/big`,
            `${base}/col/plain`
          ]
        )
        for (const statement of statements) {
          assert.equal(statement.type, 'StorageAttestation')
          assert.equal(statement.didVersionId, attestor.didVersionId)
          assert.equal(statement.proof.cryptosuite, 'eddsa-jcs-2022')
          assert.equal(statement.proof.proofPurpose, 'assertionMethod')
          assert.equal(
            statement.proof.verificationMethod,
            `${did}#${attestor.keyPair.publicKeyMultibase}`
          )
          assert.equal(statement.proof.created, undefined)
        }

        const [spaceStatement, collectionStatement, big, plain] = statements
        const spaceMetadata = await harness.backend.getSpaceMetadata({
          spaceId
        })
        assert.equal(spaceStatement.updatedAt, spaceMetadata!.updatedAt)
        assert.equal(
          spaceStatement.updatedAtCounter,
          spaceMetadata!.updatedAtCounter
        )
        assert.equal(spaceStatement.originId, spaceMetadata!.originId)
        assert.equal(spaceStatement.digest, undefined)
        assert.equal(spaceStatement.version, undefined)
        assert.equal(spaceStatement.metaVersion, undefined)
        const collectionMetadata = await harness.backend.getCollectionMetadata({
          spaceId,
          collectionId: 'col'
        })
        assert.equal(
          collectionStatement.updatedAt,
          collectionMetadata!.updatedAt
        )
        assert.equal(
          collectionStatement.updatedAtCounter,
          collectionMetadata!.updatedAtCounter
        )
        assert.equal(collectionStatement.originId, collectionMetadata!.originId)
        assert.equal(
          collectionStatement.createdAt,
          collectionMetadata!.createdAt
        )
        assert.equal(collectionStatement.digest, undefined)

        const plainMetadata = await harness.backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'plain'
        })
        assert.equal(plain.createdBy, CREATOR_ONE)
        assert.equal(plain.createdAt, plainMetadata!.createdAt)
        assert.equal(plain.updatedAt, plainMetadata!.updatedAt)
        assert.equal(plain.updatedAtCounter, plainMetadata!.updatedAtCounter)
        assert.equal(plain.originId, plainMetadata!.originId)
        const prefix = `space/${spaceId}/col/`
        const representation = [...files].find(([name]) =>
          name.startsWith(`${prefix}r.plain.`)
        )
        assert.ok(representation)
        assert.equal(
          plain.digest,
          await createHeaderValue({ data: representation[1] })
        )

        // The composite digest: each chunk's digest in index order, as a JSON
        // array of strings (its JCS serialization, since the strings are
        // plain ASCII), digested again.
        assert.equal(big.createdBy, CREATOR_TWO)
        const chunkDigests: string[] = []
        for (let chunkIndex = 0; chunkIndex < 11; chunkIndex++) {
          const chunk = [...files].find(([name]) =>
            name.startsWith(`${prefix}.chunks.big/r.${chunkIndex}.`)
          )
          assert.ok(chunk, `chunk ${chunkIndex} is archived`)
          chunkDigests.push(await createHeaderValue({ data: chunk[1] }))
        }
        assert.equal(
          big.digest,
          await createHeaderValue({ data: JSON.stringify(chunkDigests) })
        )
      })

      it('signs the same statement bytes on a later export', async () => {
        const first = await exportAndRead(true)
        const second = await exportAndRead(true)
        assert.deepStrictEqual(
          Buffer.from(second.archive.provenance!),
          Buffer.from(first.archive.provenance!)
        )
      })

      it('carries neither entry without an attestor', async () => {
        const { archive } = await exportAndRead(false)
        assert.equal(archive.provenance, undefined)
        assert.equal(archive.didLog, undefined)
        assert.equal(archive.manifest.contents['provenance.jsonl'], undefined)
        assert.equal(archive.manifest.contents['did.jsonl'], undefined)
      })
    })

    describe('import provenance', () => {
      let harness: BackendHarness
      let archiveBytes: Buffer
      const sourceSpaceId = 'space-attested'
      const serverUrl = 'https://pws.example'
      const FORGER = 'did:key:z6MkContractSuiteForger' as IDID
      const warnings: { msg: string; ids?: string[]; count?: number }[] = []
      let importCount = 0

      /**
       * Rewrites the exported archive: `edit` returns an entry's new body, or
       * `undefined` to leave the entry out. `before` adds entries ahead of
       * the named one.
       */
      async function rewriteArchive(
        edit: (name: string, body: Buffer) => Buffer | undefined,
        before?: (name: string) => { name: string; body: Buffer }[]
      ): Promise<Buffer> {
        const entries = await extractTarEntries(Readable.from([archiveBytes]))
        const pack = tar.pack()
        for (const [name, entry] of entries) {
          if (entry.type === 'directory') {
            pack.entry({ name, type: 'directory' })
            continue
          }
          for (const added of before?.(name) ?? []) {
            pack.entry({ name: added.name }, added.body)
          }
          const body = edit(name, entry.body!)
          if (body !== undefined) {
            pack.entry({ name }, body)
          }
        }
        pack.finalize()
        return Buffer.from(
          await collectBytes(pack as unknown as AsyncIterable<Uint8Array>)
        )
      }

      /**
       * Rewrites the one JSON line of a JSON Lines body that `match` selects.
       */
      function editJsonLine(
        body: Buffer,
        match: (line: any) => boolean,
        edit: (line: any) => void
      ): Buffer {
        const lines = body
          .toString('utf8')
          .split('\n')
          .map(line => {
            if (line.length === 0) {
              return line
            }
            const parsed = JSON.parse(line)
            if (!match(parsed)) {
              return line
            }
            edit(parsed)
            return JSON.stringify(parsed)
          })
        return Buffer.from(lines.join('\n'))
      }

      /**
       * Imports archive bytes into a fresh Space, returning its id and the
       * import's stats.
       */
      async function importInto(bytes: Buffer) {
        const { backend } = harness
        const spaceId = `restore-${++importCount}`
        await backend.writeSpace({
          spaceId,
          spaceMetadata: {
            id: spaceId,
            type: ['Space'],
            name: `Space ${spaceId}`,
            controller: CONTROLLER
          }
        })
        const stats = await importArchive({
          backend: backend,
          spaceId,
          tarStream: Readable.from([bytes])
        })
        return { spaceId, stats }
      }

      async function createdByOf(spaceId: string, resourceId: string) {
        const metadata = await harness.backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId
        })
        assert.ok(metadata, `${resourceId} was imported`)
        return metadata.createdBy
      }

      async function collectionCreatedBy(spaceId: string) {
        const metadata = await harness.backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        })
        assert.ok(metadata, 'the notes Collection was imported')
        return metadata.createdBy
      }

      const plainSidecar = `space/${sourceSpaceId}/col/.meta.plain.json`
      const isPlainStatement = (line: any) =>
        line.id === `${serverUrl}/space/${sourceSpaceId}/col/plain`

      /**
       * A metadata sidecar's bytes with its `createdBy` set to the forger.
       */
      function forgedSidecar(body: Buffer): Buffer {
        return Buffer.from(
          JSON.stringify({
            ...JSON.parse(body.toString('utf8')),
            createdBy: FORGER
          })
        )
      }

      /**
       * The five provenance counts, every one not given being zero.
       */
      function counts(
        given: Partial<ImportStats['provenance']>
      ): ImportStats['provenance'] {
        return {
          verified: 0,
          unattested: 0,
          proofInvalid: 0,
          contentMismatch: 0,
          unknownSigner: 0,
          ...given
        }
      }

      beforeAll(async () => {
        harness = await makeBackend()
        const { backend } = harness
        backend.logger = pino(
          { level: 'warn' },
          {
            write(line: string) {
              warnings.push(JSON.parse(line))
            }
          }
        )
        const { signingKey } = await provisionServerIdentity({
          backend,
          serverUrl,
          seed: randomBytes(32)
        })
        const loaded = await loadExportAttestor({
          storage: backend,
          serverBackends: new ServerBackends({ backends: [backend] }),
          serverUrl,
          signingKey,
          logger: pino({ level: 'silent' })
        })
        assert.ok('attestor' in loaded)

        await provisionSpace(backend, sourceSpaceId)
        await backend.writeCollection({
          spaceId: sourceSpaceId,
          collectionId: 'notes',
          collectionMetadata: { id: 'notes', type: ['Collection'], name: 'N' },
          createdBy: CREATOR_ONE
        })
        await backend.writeResource({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          resourceId: 'plain',
          input: jsonInput({ hello: 'world' }),
          createdBy: CREATOR_ONE
        })
        await backend.writeResource({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          resourceId: 'big',
          input: jsonInput({ chunks: 3 }),
          createdBy: CREATOR_TWO
        })
        for (let chunkIndex = 0; chunkIndex < 3; chunkIndex++) {
          await backend.writeChunk({
            spaceId: sourceSpaceId,
            collectionId: 'col',
            resourceId: 'big',
            chunkIndex,
            input: binaryInput(Buffer.from(`chunk ${chunkIndex}`))
          })
        }
        // A tombstone carries no statement and is not counted.
        await backend.writeResource({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          resourceId: 'gone',
          input: jsonInput({ soon: 'deleted' }),
          createdBy: CREATOR_ONE
        })
        await backend.deleteResource({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          resourceId: 'gone'
        })
        archiveBytes = Buffer.from(
          await collectBytes(
            await backend.exportSpace({
              spaceId: sourceSpaceId,
              attestor: loaded.attestor
            })
          )
        )
      })
      afterAll(async () => {
        await harness.cleanup()
      })

      it('keeps createdBy on a verified round trip', async () => {
        const { spaceId, stats } = await importInto(archiveBytes)
        // The Space Metadata object, two Collection Metadata objects, and the
        // two live Resources.
        assert.deepStrictEqual(stats.provenance, counts({ verified: 5 }))
        assert.equal(await createdByOf(spaceId, 'plain'), CREATOR_ONE)
        assert.equal(await createdByOf(spaceId, 'big'), CREATOR_TWO)
        assert.equal(await collectionCreatedBy(spaceId), CREATOR_ONE)
      })

      it('drops a hand-edited createdBy whose statement was edited to match (proofInvalid)', async () => {
        const before = warnings.length
        const forged = await rewriteArchive((name, body) => {
          if (name === plainSidecar) {
            return forgedSidecar(body)
          }
          if (name === 'provenance.jsonl') {
            return editJsonLine(body, isPlainStatement, line => {
              line.createdBy = FORGER
            })
          }
          return body
        })
        const { spaceId, stats } = await importInto(forged)
        assert.equal(stats.provenance.proofInvalid, 1)
        assert.equal(stats.provenance.verified, 4)
        assert.equal(stats.resourcesCreated, 3)
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
        assert.equal(await createdByOf(spaceId, 'big'), CREATOR_TWO)
        const logged = warnings.slice(before)
        assert.equal(logged.length, 1)
        assert.match(logged[0]!.msg, /proof does not verify/)
        assert.equal(logged[0]!.count, 1)
        assert.deepStrictEqual(logged[0]!.ids, [
          `${serverUrl}/space/${sourceSpaceId}/col/plain`
        ])
      })

      it('drops a createdBy edited in the sidecar alone (contentMismatch)', async () => {
        const forged = await rewriteArchive((name, body) =>
          name === plainSidecar ? forgedSidecar(body) : body
        )
        const { spaceId, stats } = await importInto(forged)
        assert.equal(stats.provenance.contentMismatch, 1)
        assert.equal(stats.provenance.verified, 4)
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
      })

      it('drops createdBy from a substituted body under an authentic statement (contentMismatch)', async () => {
        const before = warnings.length
        const prefix = `space/${sourceSpaceId}/col/r.plain.`
        const substituted = await rewriteArchive((name, body) =>
          name.startsWith(prefix)
            ? Buffer.from(JSON.stringify({ hello: 'substituted' }))
            : body
        )
        const { spaceId, stats } = await importInto(substituted)
        assert.deepStrictEqual(
          stats.provenance,
          counts({ verified: 4, contentMismatch: 1 })
        )
        // Imported anyway, with no attribution.
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
        const { resourceStream } = await harness.backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'plain'
        })
        assert.deepStrictEqual(
          JSON.parse(
            Buffer.from(await collectBytes(resourceStream)).toString()
          ),
          { hello: 'substituted' }
        )
        const logged = warnings.slice(before)
        assert.equal(logged.length, 1)
        assert.match(logged[0]!.msg, /does not match the archived object/)
      })

      it('judges only the representation the import writes when two files share a Resource id', async () => {
        // A forged second representation of `plain` is placed ahead of the
        // authentic file in archive order, so it is the one the import
        // writes. The authentic bytes behind it must not earn its createdBy.
        const prefix = `space/${sourceSpaceId}/col/r.plain.`
        const forgedName = `${prefix}text%2Fplain.txt`
        const substituted = await rewriteArchive(
          (_name, body) => body,
          name =>
            name.startsWith(prefix)
              ? [{ name: forgedName, body: Buffer.from('substituted') }]
              : []
        )
        const { spaceId, stats } = await importInto(substituted)
        assert.deepStrictEqual(
          stats.provenance,
          counts({ verified: 4, contentMismatch: 1 })
        )
        assert.equal(stats.resourcesCreated, 3)
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
        const { resourceStream } = await harness.backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'plain'
        })
        assert.equal(
          Buffer.from(await collectBytes(resourceStream)).toString(),
          'substituted'
        )
      })

      it('drops createdBy from a chunk substituted under an authentic statement', async () => {
        const chunk = `space/${sourceSpaceId}/col/.chunks.big/r.1.`
        const substituted = await rewriteArchive((name, body) =>
          name.startsWith(chunk) ? Buffer.from('another chunk') : body
        )
        const { spaceId, stats } = await importInto(substituted)
        assert.equal(stats.provenance.contentMismatch, 1)
        assert.equal(await createdByOf(spaceId, 'big'), undefined)
        assert.equal(await createdByOf(spaceId, 'plain'), CREATOR_ONE)
      })

      it('drops every createdBy from an archive with no provenance.jsonl (unattested)', async () => {
        const unsigned = await rewriteArchive((name, body) =>
          name === 'provenance.jsonl' ? undefined : body
        )
        const { spaceId, stats } = await importInto(unsigned)
        assert.deepStrictEqual(stats.provenance, counts({ unattested: 5 }))
        assert.equal(stats.resourcesCreated, 3)
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
        assert.equal(await createdByOf(spaceId, 'big'), undefined)
        assert.equal(await collectionCreatedBy(spaceId), undefined)
      })

      it('drops every createdBy when did.jsonl is absent (unknownSigner)', async () => {
        const withoutLog = await rewriteArchive((name, body) =>
          name === 'did.jsonl' ? undefined : body
        )
        const { spaceId, stats } = await importInto(withoutLog)
        assert.equal(stats.provenance.unknownSigner, 5)
        assert.equal(stats.provenance.verified, 0)
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
        assert.equal(await collectionCreatedBy(spaceId), undefined)
      })

      it('drops every createdBy when did.jsonl is tampered (unknownSigner)', async () => {
        const tampered = await rewriteArchive((name, body) =>
          name === 'did.jsonl'
            ? editJsonLine(
                body,
                () => true,
                line => {
                  line.versionTime = '2001-01-01T00:00:00Z'
                }
              )
            : body
        )
        const { spaceId, stats } = await importInto(tampered)
        assert.equal(stats.provenance.unknownSigner, 5)
        assert.equal(stats.provenance.verified, 0)
        assert.equal(await createdByOf(spaceId, 'big'), undefined)
      })

      it('drops every createdBy when did.jsonl declares witnesses, fetching nothing (unknownSigner)', async () => {
        // The statements are signed under a DID whose log declares a
        // witness. The importer verifies the snapshot with no witness
        // proofs, so it refuses the log rather than fetch the DID's
        // `did-witness.json` from the host the log names.
        const signingKey = await Ed25519VerificationKey.generate()
        const witnessKey = await Ed25519VerificationKey.generate()
        const { did, log } = await mintServerDid({
          serverUrl,
          publicKeyMultibase: signingKey.publicKeyMultibase!,
          witness: {
            threshold: 1,
            witnesses: [{ id: `did:key:${witnessKey.fingerprint()}` }]
          }
        })
        const attestor: ExportAttestor = {
          serverUrl,
          serverDid: did,
          didLog: Buffer.from(logToJsonlString(log)),
          didVersionId: log.at(-1)!.versionId,
          keyPair: new Ed25519VerificationKey({
            id: `${did}#${signingKey.publicKeyMultibase}`,
            controller: did,
            publicKeyMultibase: signingKey.publicKeyMultibase,
            privateKeyMultibase: signingKey.privateKeyMultibase
          })
        }
        const witnessed = Buffer.from(
          await collectBytes(
            await harness.backend.exportSpace({
              spaceId: sourceSpaceId,
              attestor
            })
          )
        )
        const watch = watchWitnessFetches()
        try {
          const { spaceId, stats } = await importInto(witnessed)
          assert.deepStrictEqual(stats.provenance, counts({ unknownSigner: 5 }))
          assert.equal(stats.resourcesCreated, 3)
          assert.equal(await createdByOf(spaceId, 'plain'), undefined)
          assert.equal(await createdByOf(spaceId, 'big'), undefined)
          assert.equal(await collectionCreatedBy(spaceId), undefined)
        } finally {
          watch.restore()
        }
        assert.deepStrictEqual(watch.witnessFetches, [])
      })

      it('drops createdBy when a statement names a log version the log lacks (unknownSigner)', async () => {
        const renamed = await rewriteArchive((name, body) =>
          name === 'provenance.jsonl'
            ? editJsonLine(body, isPlainStatement, line => {
                line.didVersionId = '9-QmNoSuchEntry'
              })
            : body
        )
        const { spaceId, stats } = await importInto(renamed)
        assert.equal(stats.provenance.unknownSigner, 1)
        assert.equal(stats.provenance.verified, 4)
        assert.equal(await createdByOf(spaceId, 'plain'), undefined)
      })

      it('gives a Resource archived with no metadata entry a fresh sidecar and a feed position', async () => {
        const { backend } = harness
        const bigSidecar = `space/${sourceSpaceId}/col/.meta.big.json`
        // `plain` loses its metadata entry. `big` keeps one, with a `custom`
        // member added (no statement claims `custom`, so `big` still verifies).
        const sidecarless = await rewriteArchive((name, body) => {
          if (name === plainSidecar) {
            return undefined
          }
          if (name === bigSidecar) {
            return Buffer.from(
              JSON.stringify({
                ...JSON.parse(body.toString('utf8')),
                custom: { name: 'Big' }
              })
            )
          }
          return body
        })
        const sourceBig = await backend.getResourceMetadata({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          resourceId: 'big'
        })

        // The destination Collection already holds history of its own.
        const spaceId = `restore-${++importCount}`
        await provisionSpace(backend, spaceId)
        for (const resourceId of ['d1', 'd2']) {
          await backend.writeResource({
            spaceId,
            collectionId: 'col',
            resourceId,
            input: jsonInput({ resourceId })
          })
        }
        const before = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          limit: 100
        })
        assert.equal(resourceDocuments(before.documents).length, 2)

        await importArchive({
          backend,
          spaceId,
          tarStream: Readable.from([sidecarless])
        })

        const plain = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'plain'
        })
        assert.ok(plain, 'plain was imported')
        assert.equal(typeof plain.createdAt, 'string')
        assert.equal(plain.updatedAt, plain.createdAt)
        assert.equal(typeof plain.generation, 'string')
        assert.equal(plain.originId, backend.originId)
        assert.equal(plain.createdBy, undefined)
        assert.equal(plain.custom, undefined)
        const served = await backend.getResource({
          spaceId,
          collectionId: 'col',
          resourceId: 'plain'
        })
        assert.equal(etagOf(served), etagOf(plain))
        assert.equal(
          await streamToString(served.resourceStream),
          JSON.stringify({ hello: 'world' })
        )

        const after = await backend.changesSince!({
          spaceId,
          collectionId: 'col',
          afterPosition: before.checkpoint!,
          limit: 100
        })
        assert.deepEqual(
          resourceDocuments(after.documents)
            .map(document => document.resourceId)
            .sort(),
          ['big', 'gone', 'plain']
        )
        for (const document of after.documents) {
          assert.ok(document.feedPosition > before.checkpoint!)
        }

        // The archived sidecar's members are kept; only the position is new.
        const big = await backend.getResourceMetadata({
          spaceId,
          collectionId: 'col',
          resourceId: 'big'
        })
        assert.ok(big, 'big was imported')
        assert.equal(big.createdAt, sourceBig!.createdAt)
        assert.equal(big.createdBy, CREATOR_TWO)
        assert.deepEqual(big.custom, { name: 'Big' })
      })
    })
  })
}
