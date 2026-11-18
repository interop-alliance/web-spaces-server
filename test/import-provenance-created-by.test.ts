/**
 * Import provenance against a forged `createdBy` (Vitest, real signatures):
 * an archive whose signed statements attest no `createdBy` for an object has
 * that object's archived `createdBy` edited to a value that is not a list of
 * DIDs. The statement still verifies, since a malformed value reads as no
 * claim, and the forged member must not reach the plan.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import * as tar from 'tar-stream'
import { pino } from 'pino'
import {
  collectBytes,
  collectionMetadataFileName,
  metaSidecarFileName
} from '@interop/space-archive'

import { openTempBackend, provisionServerIdentity } from '../src/testing.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { loadExportAttestor } from '../src/lib/exportProvenance.js'
import { applyImportProvenance } from '../src/lib/importProvenance.js'
import { buildImportPlan, extractTarEntries } from '../src/lib/importTar.js'
import { ServerBackends } from '../src/lib/serverBackends.js'
import type { IDID } from '../src/types.js'

const serverUrl = 'https://pws.example'
const spaceId = 'space-forged'
const owner = 'did:key:z6MkImportProvenanceOwner' as IDID
const creator: IDID[] = ['did:key:z6MkImportProvenanceCreator']
const forged = 'did:key:z6MkForged'

function jsonInput(data: unknown) {
  return { kind: 'json' as const, contentType: 'application/json', data }
}

describe('import provenance with a malformed createdBy', () => {
  let backend: TempFileSystemBackend
  let archiveBytes: Buffer

  async function judgedPlan(bytes: Buffer) {
    const entries = await extractTarEntries(Readable.from([bytes]))
    return applyImportProvenance({
      entries,
      plan: buildImportPlan(entries),
      logger: pino({ level: 'silent' })
    })
  }

  /**
   * The archive with the named files' `createdBy` set to the forged string.
   */
  async function forgedArchive(names: string[]): Promise<Buffer> {
    const entries = await extractTarEntries(Readable.from([archiveBytes]))
    const pack = tar.pack()
    for (const [name, entry] of entries) {
      if (entry.type === 'directory') {
        pack.entry({ name, type: 'directory' })
        continue
      }
      const forgedHere = names.some(suffix => name.endsWith(suffix))
      const body = forgedHere
        ? Buffer.from(
            JSON.stringify({
              ...JSON.parse(entry.body!.toString('utf8')),
              createdBy: forged
            })
          )
        : entry.body!
      pack.entry({ name }, body)
    }
    pack.finalize()
    return Buffer.from(
      await collectBytes(pack as unknown as AsyncIterable<Uint8Array>)
    )
  }

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-import-created-by-' })
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
    await backend.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        name: 'Forged',
        controller: owner
      }
    })
    // No createdBy is recorded for the bare Collection or its Resource.
    await backend.writeCollection({
      spaceId,
      collectionId: 'bare',
      collectionMetadata: { id: 'bare', type: ['Collection'], name: 'Bare' }
    })
    await backend.writeResource({
      spaceId,
      collectionId: 'bare',
      resourceId: 'note',
      input: jsonInput({ hello: 'world' })
    })
    // The control: createdBy recorded and attested.
    await backend.writeCollection({
      spaceId,
      collectionId: 'owned',
      collectionMetadata: { id: 'owned', type: ['Collection'], name: 'Owned' },
      createdBy: creator
    })
    await backend.writeResource({
      spaceId,
      collectionId: 'owned',
      resourceId: 'note',
      input: jsonInput({ hello: 'owner' }),
      createdBy: creator
    })
    archiveBytes = Buffer.from(
      await collectBytes(
        await backend.exportSpace({ spaceId, attestor: loaded.attestor })
      )
    )
  })
  afterAll(async () => {
    await backend.close()
  })

  it('keeps an attested createdBy and no other on an untouched archive', async () => {
    const { plan, provenance } = await judgedPlan(archiveBytes)
    assert.equal(provenance.verified, 5)
    const bare = plan.collections.find(entry => entry.collectionId === 'bare')!
    const owned = plan.collections.find(
      entry => entry.collectionId === 'owned'
    )!
    assert.equal((bare.collectionMetadata as any).createdBy, undefined)
    assert.deepEqual((owned.collectionMetadata as any).createdBy, creator)
    assert.deepEqual(
      JSON.parse(owned.resourceMetadata.get('note')!.toString('utf8'))
        .createdBy,
      creator
    )
  })

  it('does not import a forged non-list createdBy whose statement still verifies', async () => {
    const bytes = await forgedArchive([
      `/bare/${collectionMetadataFileName('bare')}`,
      `/bare/${metaSidecarFileName('note')}`
    ])
    // The forged files really carry the string.
    const entries = await extractTarEntries(Readable.from([bytes]))
    const sidecar = [...entries].find(([name]) =>
      name.endsWith(`/bare/${metaSidecarFileName('note')}`)
    )!
    assert.equal(
      JSON.parse(sidecar[1].body!.toString('utf8')).createdBy,
      forged
    )

    const { plan, provenance } = await judgedPlan(bytes)
    // Every object still verifies: the statements attest no createdBy and a
    // malformed value reads as no claim.
    assert.equal(provenance.verified, 5)
    assert.equal(provenance.contentMismatch, 0)
    const bare = plan.collections.find(entry => entry.collectionId === 'bare')!
    const owned = plan.collections.find(
      entry => entry.collectionId === 'owned'
    )!
    assert.equal('createdBy' in bare.collectionMetadata, false)
    assert.equal(
      'createdBy' in
        JSON.parse(bare.resourceMetadata.get('note')!.toString('utf8')),
      false
    )
    // The control: the well-formed attested list survives.
    assert.deepEqual((owned.collectionMetadata as any).createdBy, creator)
    assert.deepEqual(
      JSON.parse(owned.resourceMetadata.get('note')!.toString('utf8'))
        .createdBy,
      creator
    )
  })
})
