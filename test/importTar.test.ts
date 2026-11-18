/**
 * Unit tests for the tar import helpers (`src/lib/importTar.ts`): the manifest
 * validator, the merge-plan builder, and the tar entry extractor. These exercise
 * the archive-parsing logic directly -- without an HTTP round-trip or the
 * filesystem backend -- to cover the malformed-archive branches (which surface
 * to clients as `InvalidImportError`) and the id-traversal guards.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import YAML from 'yaml'
import * as tar from 'tar-stream'

import {
  archivedRevocations,
  validateManifest,
  buildImportPlan,
  extractTarEntries,
  type TarEntry
} from '../src/lib/importTar.js'
import { IMPORT_MAX_REVOCATIONS } from '../src/config.default.js'
import {
  InvalidImportError,
  InvalidCollectionIdError,
  InvalidResourceIdError
} from '../src/errors.js'

/** Wraps a UTF-8 string as a `file` TarEntry. */
function fileEntry(body: string): TarEntry {
  return { type: 'file', body: Buffer.from(body, 'utf8') }
}

/** A minimal, valid UBC v0.1 manifest body (YAML). */
function validManifestYaml(): string {
  return YAML.stringify({
    'ubc-version': '0.1',
    contents: { space: { url: 'https://example/spec#spaces' } }
  })
}

describe('validateManifest', () => {
  it('accepts a well-formed UBC v0.1 manifest', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())]
    ])
    assert.doesNotThrow(() => validateManifest(entries))
  })

  it('throws InvalidImportError when manifest.yml is missing', () => {
    const entries = new Map<string, TarEntry>()
    let thrown: any
    try {
      validateManifest(entries)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof InvalidImportError)
    assert.equal(thrown.statusCode, 400)
    assert.match(thrown.detail, /missing manifest/i)
  })

  it('throws InvalidImportError (with cause) on invalid YAML', () => {
    const entries = new Map<string, TarEntry>([
      // Unterminated flow mapping -- YAML.parse throws.
      ['manifest.yml', fileEntry('ubc-version: "0.1"\ncontents: {')]
    ])
    let thrown: any
    try {
      validateManifest(entries)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof InvalidImportError)
    assert.match(thrown.detail, /not valid YAML/i)
    // The underlying parse error is preserved as the cause chain.
    assert.ok(thrown.cause instanceof Error)
  })

  it('throws InvalidImportError on an unsupported manifest version', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(YAML.stringify({ 'ubc-version': '0.2' }))]
    ])
    assert.throws(
      () => validateManifest(entries),
      (err: Error) =>
        err instanceof InvalidImportError && /Unsupported/i.test(err.message)
    )
  })

  it('throws InvalidImportError when contents.space is absent', () => {
    const entries = new Map<string, TarEntry>([
      [
        'manifest.yml',
        fileEntry(YAML.stringify({ 'ubc-version': '0.1', contents: {} }))
      ]
    ])
    assert.throws(
      () => validateManifest(entries),
      (err: Error) =>
        err instanceof InvalidImportError &&
        /does not describe a PWS space export/i.test(err.message)
    )
  })
})

describe('buildImportPlan', () => {
  /** Builds a complete, valid space-export entries map for spaceId `S1`. */
  function validSpaceEntries(): Map<string, TarEntry> {
    const spacePolicy = { type: 'PublicCanRead' }
    const collectionPolicy = { type: 'PublicCanRead', scope: 'collection' }
    const resourcePolicy = { type: 'PublicCanRead', scope: 'resource' }
    return new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/', { type: 'directory' }],
      ['space/S1/', { type: 'directory' }],
      ['space/S1/.space.meta.S1.json', fileEntry(JSON.stringify({ id: 'S1' }))],
      ['space/S1/.space.policy.json', fileEntry(JSON.stringify(spacePolicy))],
      ['space/S1/colA/', { type: 'directory' }],
      [
        'space/S1/colA/.collection.meta.colA.json',
        fileEntry(
          JSON.stringify({ id: 'colA', type: ['Collection'], name: 'A' })
        )
      ],
      [
        'space/S1/colA/.collection.policy.json',
        fileEntry(JSON.stringify(collectionPolicy))
      ],
      [
        'space/S1/colA/.r.res1.policy.json',
        fileEntry(JSON.stringify(resourcePolicy))
      ],
      [
        'space/S1/colA/.meta.res1.json',
        fileEntry(
          JSON.stringify({
            createdAt: '2026-06-10T09:12:00.000Z',
            updatedAt: '2026-06-12T13:25:00.000Z',
            custom: { name: 'Resource One' }
          })
        )
      ],
      [
        'space/S1/colA/r.res1.application%2Fjson.json',
        fileEntry(JSON.stringify({ hello: 'world' }))
      ],
      [
        'space/S1/colB/.collection.meta.colB.json',
        fileEntry(
          JSON.stringify({ id: 'colB', type: ['Collection'], name: 'B' })
        )
      ]
    ])
  }

  it("carries the archived Space Metadata object's type and name", () => {
    const entries = validSpaceEntries()
    entries.set(
      'space/S1/.space.meta.S1.json',
      fileEntry(
        JSON.stringify({
          id: 'S1',
          type: ['AuxiliarySpace', 'Space'],
          name: 'Archived',
          controller: 'did:key:z6MkArchived',
          createdBy: ['did:key:z6MkArchived'],
          url: '/space/S1/',
          backends: [{ id: 'default' }]
        })
      )
    )
    // Only the two user-writable members travel; `controller` and the
    // server-derived members are the destination's.
    assert.deepStrictEqual(buildImportPlan(entries).spaceMetadata, {
      type: ['AuxiliarySpace', 'Space'],
      name: 'Archived'
    })
    // An entry carrying neither member is present but has nothing to apply.
    assert.deepStrictEqual(
      buildImportPlan(validSpaceEntries()).spaceMetadata,
      {}
    )
  })

  it('drops a malformed type or name, and reads a non-object entry as absent', () => {
    const planFor = (body: string) => {
      const entries = validSpaceEntries()
      entries.set('space/S1/.space.meta.S1.json', fileEntry(body))
      return buildImportPlan(entries)
    }
    // A `type` that Update Space would refuse is dropped, not carried.
    assert.deepStrictEqual(
      planFor(JSON.stringify({ type: ['Foo'], name: 'N' })).spaceMetadata,
      { name: 'N' }
    )
    assert.deepStrictEqual(
      planFor(JSON.stringify({ type: ['DelegatedClientsSpace', 'Space'] }))
        .spaceMetadata,
      {}
    )
    assert.deepStrictEqual(
      planFor(JSON.stringify({ type: [], name: 42 })).spaceMetadata,
      {}
    )
    // Not a JSON object at all: as if the archive carried no entry, so the
    // rest of the archive still imports.
    for (const body of ['{not json', '', 'null', '[]', '"text"']) {
      const plan = planFor(body)
      assert.equal(plan.spaceMetadata, undefined, `expected absent for ${body}`)
      assert.equal(plan.collections.length, 2)
    }
  })

  it('builds a plan with sorted collections, policies, and resources', () => {
    const plan = buildImportPlan(validSpaceEntries())

    assert.deepStrictEqual(plan.spacePolicy?.policy, { type: 'PublicCanRead' })
    assert.deepStrictEqual(
      plan.collections.map(c => c.collectionId),
      ['colA', 'colB']
    )

    const [colA, colB] = plan.collections
    assert.equal(colA!.collectionMetadata.name, 'A')
    assert.deepStrictEqual(colA!.collectionPolicy?.policy, {
      type: 'PublicCanRead',
      scope: 'collection'
    })
    assert.equal(colA!.resources.length, 1)
    assert.equal(colA!.resources[0]!.resourceId, 'res1')
    assert.equal(colA!.resources[0]!.fileName, 'r.res1.application%2Fjson.json')
    assert.deepStrictEqual(colA!.resourcePolicies.get('res1')?.policy, {
      type: 'PublicCanRead',
      scope: 'resource'
    })
    // The resource's metadata sidecar is carried as raw bytes, keyed by id.
    const metaBytes = colA!.resourceMetadata.get('res1')
    assert.ok(metaBytes, 'expected a metadata sidecar for res1')
    assert.deepStrictEqual(JSON.parse(metaBytes!.toString('utf8')), {
      createdAt: '2026-06-10T09:12:00.000Z',
      updatedAt: '2026-06-12T13:25:00.000Z',
      custom: { name: 'Resource One' }
    })

    // colB has only its metadata file (no policy, no resources).
    assert.equal(colB!.resources.length, 0)
    assert.equal(colB!.collectionPolicy, undefined)
  })

  it("ignores the archive's service.json rather than refusing it", () => {
    // The exporting server's Service Description travels beside the manifest.
    // It is informational on import: the walk reads it as neither Space data
    // nor an unknown entry to refuse.
    const entries = validSpaceEntries()
    const withService = new Map<string, TarEntry>([
      ['manifest.yml', entries.get('manifest.yml')!],
      [
        'service.json',
        fileEntry(JSON.stringify({ url: 'https://pws.example/service' }))
      ],
      ...entries
    ])
    const plan = buildImportPlan(withService)
    assert.deepStrictEqual(
      plan.collections.map(collection => collection.collectionId),
      ['colA', 'colB']
    )
  })

  it('synthesizes a default Collection Metadata object when none is in the archive', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/S1/colA/r.res1.text%2Fplain.txt', fileEntry('hi')]
    ])
    const plan = buildImportPlan(entries)
    const [colA] = plan.collections
    assert.deepStrictEqual(colA!.collectionMetadata, {
      id: 'colA',
      type: ['Collection'],
      name: 'colA'
    })
  })

  it('sets an absent Collection Metadata `id` from the archive path, as the write handlers do', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      [
        'space/S1/colA/.collection.meta.colA.json',
        fileEntry(JSON.stringify({ type: ['Collection'], name: 'A' }))
      ]
    ])
    const [colA] = buildImportPlan(entries).collections
    assert.deepStrictEqual(colA!.collectionMetadata, {
      id: 'colA',
      type: ['Collection'],
      name: 'A'
    })
  })

  it('throws InvalidImportError on a Collection Metadata `id` naming another Collection', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      [
        'space/S1/colA/.collection.meta.colA.json',
        fileEntry(
          JSON.stringify({ id: 'colB', type: ['Collection'], name: 'A' })
        )
      ]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: unknown) =>
        err instanceof InvalidImportError &&
        /names id "colB"/.test(err.detail ?? '')
    )
  })

  it('throws InvalidImportError on a Collection Metadata file that is not a JSON object', () => {
    for (const body of ['not json', '[1]', '"colA"']) {
      const entries = new Map<string, TarEntry>([
        ['manifest.yml', fileEntry(validManifestYaml())],
        ['space/S1/colA/.collection.meta.colA.json', fileEntry(body)]
      ])
      assert.throws(
        () => buildImportPlan(entries),
        (err: unknown) =>
          err instanceof InvalidImportError &&
          /Collection Metadata file of Collection 'colA'/.test(err.detail ?? '')
      )
    }
  })

  it('throws InvalidImportError when the archive has no space data', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: Error) =>
        err instanceof InvalidImportError &&
        /does not contain space data/i.test(err.message)
    )
  })

  it('rejects a path-traversal collection id parsed from the archive', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/S1/../.collection.meta.x.json', fileEntry('{}')]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: Error) => err instanceof InvalidCollectionIdError
    )
  })

  it('throws InvalidImportError on an entry the archive layout holds nowhere', () => {
    // The package's classifier places every entry; one it places as `other`
    // refuses the plan, so a stray path is never keyed into a Collection's
    // files and refused later, per file, if at all.
    const strays = [
      // Deeper than the layout goes.
      'space/S1/colA/nested/r.res9.text%2Fplain.txt',
      // A directory inside a chunk directory.
      'space/S1/colA/.chunks.res1/sub/',
      // A directory inside the revocations directory.
      'space/S1/.revocations/sub/',
      // A file where the layout holds the `space/` directory.
      'space'
    ]
    for (const name of strays) {
      const entries = validSpaceEntries()
      entries.set(
        name,
        name.endsWith('/') ? { type: 'directory' } : fileEntry('x')
      )
      assert.throws(
        () => buildImportPlan(entries),
        (err: Error) =>
          err instanceof InvalidImportError &&
          err.message.includes(name) &&
          /no place in the archive layout/i.test(err.message),
        name
      )
    }
  })

  it('rejects a non-URL-safe resource id parsed from the archive', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      // resourceId "a*b" carries a glob metachar -> assertValidId rejects it.
      ['space/S1/colA/r.a*b.text%2Fplain.txt', fileEntry('hi')]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: Error) => err instanceof InvalidResourceIdError
    )
  })

  it('reads the capabilities of the revocation records (and none when absent)', () => {
    // An archive without a `.revocations/` dir (e.g. from a Space with no
    // revocation) yields an empty list.
    assert.deepStrictEqual(archivedRevocations(validSpaceEntries()), [])

    // Only the capability is read. The record's `meta` is the exporting
    // server's and is rebuilt on import, so a record without one passes.
    const record = {
      capability: { id: 'urn:zcap:delegated-1' },
      meta: {
        delegator: 'did:key:z6MkDelegator',
        rootTarget: 'https://pws.example/space/S1',
        created: '2026-07-01T00:00:00.000Z'
      }
    }
    const metaless = { capability: { id: 'urn:zcap:delegated-2' } }
    const entries = validSpaceEntries()
    entries.set('space/S1/.revocations/', { type: 'directory' })
    entries.set(
      'space/S1/.revocations/abc123.json',
      fileEntry(JSON.stringify(record))
    )
    entries.set(
      'space/S1/.revocations/def456.json',
      fileEntry(JSON.stringify(metaless))
    )
    assert.deepStrictEqual(archivedRevocations(entries), [
      record.capability,
      metaless.capability
    ])
  })

  it('throws InvalidImportError on a malformed revocation record', () => {
    const badJson = validSpaceEntries()
    badJson.set('space/S1/.revocations/broken.json', fileEntry('{not json'))
    assert.throws(
      () => archivedRevocations(badJson),
      (err: Error) =>
        err instanceof InvalidImportError && /not valid JSON/i.test(err.message)
    )

    // Parses, but names no capability id.
    for (const body of [{ capability: {}, meta: {} }, { meta: {} }, []]) {
      const badShape = validSpaceEntries()
      badShape.set(
        'space/S1/.revocations/keyless.json',
        fileEntry(JSON.stringify(body))
      )
      assert.throws(
        () => archivedRevocations(badShape),
        (err: Error) =>
          err instanceof InvalidImportError && /malformed/i.test(err.message),
        JSON.stringify(body)
      )
    }
  })

  it('throws InvalidImportError on more revocation records than the import verifies', () => {
    const entries = validSpaceEntries()
    for (let index = 0; index <= IMPORT_MAX_REVOCATIONS; index++) {
      entries.set(
        `space/S1/.revocations/${index}.json`,
        fileEntry(JSON.stringify({ capability: { id: `urn:zcap:${index}` } }))
      )
    }
    assert.throws(
      () => archivedRevocations(entries),
      (err: Error) =>
        err instanceof InvalidImportError &&
        /more than \d+ revocation records/.test(err.message)
    )
    entries.delete(`space/S1/.revocations/${IMPORT_MAX_REVOCATIONS}.json`)
    assert.equal(archivedRevocations(entries).length, IMPORT_MAX_REVOCATIONS)
  })

  /** A stored-log record whose single line carries a supported descriptor. */
  function logRecord(body: string): string {
    return JSON.stringify({ body, generation: 'zgen' })
  }
  const genesis = JSON.stringify({
    versionId: '1-hash1',
    parameters: { method: 'resource-log:0.1' },
    state: {
      type: 'WasEpochConfiguration',
      scheme: 'edv',
      currentEpoch: 'urn:epoch:1',
      epochs: [
        {
          id: 'urn:epoch:1',
          recipients: [
            {
              header: { kid: 'did:key:zApp1#ka', alg: 'ECDH-ES+A256KW' },
              encrypted_key: 'wrapped'
            }
          ]
        }
      ]
    },
    proof: []
  })

  it('carries a well-formed governing history log on the plan', () => {
    const entries = validSpaceEntries()
    entries.set(
      'space/S1/colA/.collectionlog.colA.json',
      fileEntry(logRecord(genesis + '\n'))
    )
    const [colA] = buildImportPlan(entries).collections
    assert.equal(
      colA!.collectionLog?.toString('utf8'),
      logRecord(genesis + '\n')
    )
  })

  it('throws InvalidImportError on a Collection Metadata `encryption` or `plaintext` beside a governing log', () => {
    for (const member of [
      { encryption: { scheme: 'edv' } },
      { plaintext: { indexes: ['a'] } }
    ]) {
      const entries = validSpaceEntries()
      entries.set(
        'space/S1/colA/.collection.meta.colA.json',
        fileEntry(
          JSON.stringify({ id: 'colA', type: ['Collection'], ...member })
        )
      )
      entries.set(
        'space/S1/colA/.collectionlog.colA.json',
        fileEntry(logRecord(genesis + '\n'))
      )
      assert.throws(
        () => buildImportPlan(entries),
        (err: unknown) =>
          err instanceof InvalidImportError &&
          /beside a governing history log/.test(err.detail ?? '')
      )
    }
  })

  it('throws InvalidImportError on a Collection Metadata member a write would refuse', () => {
    const malformed: Array<Record<string, unknown>> = [
      { name: 7 },
      { encryption: { scheme: 'no-such-scheme' } },
      { plaintext: { indexes: [null] } },
      { plaintext: { indexes: ['a'] }, encryption: { scheme: 'edv' } },
      { generator: 'not-an-object' },
      { epoch: '' }
    ]
    for (const members of malformed) {
      const entries = validSpaceEntries()
      entries.set(
        'space/S1/colA/.collection.meta.colA.json',
        fileEntry(
          JSON.stringify({ id: 'colA', type: ['Collection'], ...members })
        )
      )
      assert.throws(
        () => buildImportPlan(entries),
        (err: unknown) =>
          err instanceof InvalidImportError &&
          /Collection Metadata file of Collection 'colA'/.test(
            err.detail ?? ''
          ),
        JSON.stringify(members)
      )
    }
  })

  it('throws InvalidImportError on a policy file with no non-empty string `type`', () => {
    for (const policy of [{}, { type: '' }, { type: 3 }, { type: ' ' }]) {
      const entries = validSpaceEntries()
      entries.set(
        'space/S1/colA/.collection.policy.json',
        fileEntry(JSON.stringify(policy))
      )
      assert.throws(
        () => buildImportPlan(entries),
        (err: unknown) =>
          err instanceof InvalidImportError &&
          /no non-empty string 'type'/.test(err.detail ?? ''),
        JSON.stringify(policy)
      )
    }
  })

  it('throws InvalidImportError on a governing history log the read path could not parse', () => {
    const cases: Array<[string, RegExp]> = [
      ['{not json', /not valid JSON/i],
      ['null', /must be an object/i],
      ['{}', /must be an object/i],
      [JSON.stringify({ body: genesis }), /generation/i],
      [logRecord(''), /malformed/i],
      [logRecord('not json\n'), /malformed/i],
      [logRecord(JSON.stringify({ state: { scheme: 'bogus' } })), /malformed/i]
    ]
    for (const [record, expected] of cases) {
      const entries = validSpaceEntries()
      entries.set('space/S1/colA/.collectionlog.colA.json', fileEntry(record))
      assert.throws(
        () => buildImportPlan(entries),
        (err: Error) =>
          err instanceof InvalidImportError && expected.test(err.message),
        `record ${record}`
      )
    }
  })

  /** Replaces the fixture's `colA` Metadata entry with the given members. */
  function withCollectionMetadata(
    members: Record<string, unknown>
  ): Map<string, TarEntry> {
    const entries = validSpaceEntries()
    entries.set(
      'space/S1/colA/.collection.meta.colA.json',
      fileEntry(
        JSON.stringify({ id: 'colA', type: ['Collection'], ...members })
      )
    )
    return entries
  }

  it('carries a well-formed `revisions` descriptor on the plan', () => {
    const revisions = { immutable: true, merge: { kind: 'none' } }
    const [colA] = buildImportPlan(
      withCollectionMetadata({ revisions })
    ).collections
    assert.deepEqual(colA!.collectionMetadata.revisions, revisions)
  })

  it('throws InvalidImportError on a `revisions` descriptor a write would refuse', () => {
    const cases: unknown[] = [
      'yes',
      { resolution: 'keep-conflicts' },
      { immutable: 'yes' },
      { merge: [] },
      { immutable: true, extra: 1 }
    ]
    for (const revisions of cases) {
      assert.throws(
        () => buildImportPlan(withCollectionMetadata({ revisions })),
        (err: Error) =>
          err instanceof InvalidImportError &&
          /Collection Metadata file of Collection 'colA' is malformed/.test(
            err.message
          ),
        `revisions ${JSON.stringify(revisions)}`
      )
    }
  })

  it('throws InvalidImportError when the archived log drops a set `revisions` member', () => {
    const governed = (state: Record<string, unknown>) =>
      logRecord(
        JSON.stringify({
          ...JSON.parse(genesis),
          state: { ...JSON.parse(genesis).state, ...state }
        }) + '\n'
      )
    const dropped = withCollectionMetadata({ revisions: { immutable: true } })
    dropped.set(
      'space/S1/colA/.collectionlog.colA.json',
      fileEntry(governed({}))
    )
    assert.throws(
      () => buildImportPlan(dropped),
      (err: Error) =>
        err instanceof InvalidImportError && /immutable/.test(err.message)
    )
    // A log that keeps the member, or declares one the object lacks, passes.
    const kept = withCollectionMetadata({ revisions: { immutable: true } })
    kept.set(
      'space/S1/colA/.collectionlog.colA.json',
      fileEntry(governed({ revisions: { immutable: true } }))
    )
    assert.doesNotThrow(() => buildImportPlan(kept))
    const declared = withCollectionMetadata({})
    declared.set(
      'space/S1/colA/.collectionlog.colA.json',
      fileEntry(governed({ revisions: { immutable: true } }))
    )
    assert.doesNotThrow(() => buildImportPlan(declared))
  })

  it('tolerates a chunk metadata sidecar whose JSON is not an object', () => {
    const entries = validSpaceEntries()
    entries.set('space/S1/colA/.chunks.res1/.meta.0.json', fileEntry('null'))
    entries.set('space/S1/colA/.chunks.res1/.meta.1.json', fileEntry('[1]'))
    const [colA] = buildImportPlan(entries).collections
    const sidecars = colA!.chunkFiles.filter(f =>
      f.fileName.startsWith('.meta.')
    )
    assert.equal(sidecars.length, 2)
    for (const sidecar of sidecars) {
      assert.equal(sidecar.generation, undefined)
    }
  })
})

describe('extractTarEntries', () => {
  it('round-trips files and directories from a tar stream', async () => {
    const pack = tar.pack()
    pack.entry({ name: 'manifest.yml' }, 'ubc-version: "0.1"')
    pack.entry({ name: 'space/', type: 'directory' })
    pack.entry({ name: 'space/S1/r.note.text%2Fplain.txt' }, 'hello')
    pack.finalize()

    // tar-stream is streamx-based, not a Node Readable; bridge via the
    // async-iterable protocol both implement.
    const entries = await extractTarEntries(Readable.from(pack))

    assert.equal(entries.size, 3)
    assert.equal(entries.get('space/')!.type, 'directory')
    assert.equal(
      entries.get('manifest.yml')!.body!.toString('utf8'),
      'ubc-version: "0.1"'
    )
    assert.equal(
      entries.get('space/S1/r.note.text%2Fplain.txt')!.body!.toString('utf8'),
      'hello'
    )
  })
})

describe('buildImportPlan Collection tombstones', () => {
  const generation = 'AbCdEfGhJkL'
  const tombstoneBody = JSON.stringify({
    deleted: true,
    updatedAt: '2026-10-03T00:00:00.000Z',
    updatedAtCounter: 0,
    originId: 'origin',
    _generation: generation
  })

  it('plans a tombstone in the Space directory with its archived generation', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/s1/.space.meta.s1.json', fileEntry('{}')],
      ['space/s1/.collection.meta.gone.json', fileEntry(tombstoneBody)],
      ['space/s1/.collection.policy.json', fileEntry('{"type":"X"}')]
    ])
    const plan = buildImportPlan(entries)
    assert.deepEqual(plan.collections, [])
    assert.deepEqual(plan.collectionTombstones, [
      { collectionId: 'gone', generation }
    ])
  })

  it('refuses an archive holding one Collection both as a tombstone and a directory', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/s1/.collection.meta.both.json', fileEntry(tombstoneBody)],
      [
        'space/s1/both/.collection.meta.both.json',
        fileEntry('{"id":"both","type":["Collection"]}')
      ]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: unknown) =>
        err instanceof InvalidImportError &&
        /both as a tombstone/.test(err.detail ?? '')
    )
  })

  it('refuses a Space-level Collection Metadata file that is not a tombstone', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      [
        'space/s1/.collection.meta.live.json',
        fileEntry('{"id":"live","type":["Collection"]}')
      ]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: unknown) => err instanceof InvalidImportError
    )
  })

  it('refuses a tombstone body inside a Collection directory', () => {
    const entries = new Map<string, TarEntry>([
      ['manifest.yml', fileEntry(validManifestYaml())],
      ['space/s1/dir/.collection.meta.dir.json', fileEntry(tombstoneBody)]
    ])
    assert.throws(
      () => buildImportPlan(entries),
      (err: unknown) =>
        err instanceof InvalidImportError &&
        /holds a tombstone/.test(err.detail ?? '')
    )
  })
})
