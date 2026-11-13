/**
 * Server key relationships and the sync signer (Vitest). The one seed key
 * must be listed in the server's history log under `assertionMethod`, may
 * also be listed under `capabilityInvocation`, and must not be listed under
 * `capabilityDelegation`, `authentication` or `keyAgreement`. Covers that
 * rule at each place it is read: `resolveServerDid` (`/service`), export
 * signing, and the import statement check. Then the sync signer
 * (`loadSyncSigner`): it exists only when the key is listed under
 * `capabilityInvocation`, and a peer verifies its invocations against the
 * server's own log, end to end through a delegated capability whose
 * controller is `serverDid`.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { logToJsonlString, readLogFromString } from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'
import { collectBytes } from '@interop/space-archive'

import type { TempFileSystemBackend } from '../src/testing.js'
import { loadExportAttestor } from '../src/lib/exportProvenance.js'
import type { ExportAttestor } from '../src/lib/exportProvenance.js'
import {
  createServerSigningKey,
  resolveServerDid
} from '../src/lib/serverIdentity.js'
import type { ServerSigningKey } from '../src/lib/serverIdentity.js'
import { loadSyncSigner } from '../src/lib/syncIdentity.js'
import { ServerBackends } from '../src/lib/serverBackends.js'
import type { IDID } from '../src/types.js'
import {
  appendAfterFirstServerLogAccess,
  client,
  delegate,
  importArchive,
  openTempBackend,
  requestError,
  startTestServer,
  pwsClient,
  relistServerKey,
  zcapClients
} from './helpers.js'
import { mintServerDid, provisionServerIdentity } from '../src/testing.js'

const silent = pino({ level: 'silent' })

/**
 * Each relationship set the key may be listed under, and what it yields:
 * whether `serverDid` is advertised and whether a sync signer exists.
 */
const RELATIONSHIP_CASES: {
  purpose: string[]
  advertised: boolean
  invocation: boolean
}[] = [
  { purpose: ['assertionMethod'], advertised: true, invocation: false },
  {
    purpose: ['assertionMethod', 'capabilityInvocation'],
    advertised: true,
    invocation: true
  },
  ...['capabilityDelegation', 'authentication', 'keyAgreement'].flatMap(
    refused => [
      {
        purpose: ['assertionMethod', refused],
        advertised: false,
        invocation: false
      },
      {
        purpose: ['assertionMethod', 'capabilityInvocation', refused],
        advertised: false,
        invocation: false
      }
    ]
  )
]

describe('Server key relationships', () => {
  const serverUrl = 'https://pws.example'

  for (const { purpose, advertised, invocation } of RELATIONSHIP_CASES) {
    describe(`with the key under ${purpose.join(' + ')}`, () => {
      let backend: TempFileSystemBackend,
        signingKey: ServerSigningKey,
        did: string,
        didLog: string

      beforeAll(async () => {
        backend = await openTempBackend({ prefix: 'was-sync-identity-' })
        ;({ signingKey, did, didLog } = await provisionServerIdentity({
          backend,
          serverUrl,
          seed: randomBytes(32),
          purpose
        }))
      })
      afterAll(async () => {
        await backend.close()
      })

      it(`${advertised ? 'advertises' : 'does not advertise'} serverDid`, async () => {
        const resolved = await resolveServerDid({
          storage: backend,
          serverBackends: new ServerBackends({ backends: [backend] }),
          serverUrl,
          signingKey,
          logger: silent
        })
        assert.equal(resolved, advertised ? did : undefined)
      })

      it(`${invocation ? 'yields' : 'refuses'} a sync signer`, async () => {
        const loaded = await loadSyncSigner({
          storage: backend,
          serverBackends: new ServerBackends({ backends: [backend] }),
          serverUrl,
          signingKey,
          logger: silent
        })
        if (invocation) {
          assert.ok('signer' in loaded, JSON.stringify(loaded))
          assert.equal(loaded.serverDid, did)
          assert.equal(
            loaded.signer.id,
            `${did}#${signingKey.keyPair.publicKeyMultibase}`
          )
          return
        }
        assert.ok('refusal' in loaded)
        if (advertised) {
          assert.equal(loaded.refusal, 'no-capability-invocation')
          assert.match(loaded.reason, /"capabilityInvocation"/)
        } else {
          assert.equal(loaded.refusal, 'no-server-did')
          assert.match(loaded.reason, /advertises no serverDid/)
        }
      })

      it(`import ${advertised ? 'verifies' : 'refuses as unknownSigner'} statements signed under it`, async () => {
        const sourceSpaceId = 'source'
        await backend.writeSpace({
          spaceId: sourceSpaceId,
          spaceMetadata: {
            id: sourceSpaceId,
            type: ['Space'],
            controller: 'did:key:z6MkSyncIdentitySuiteController' as IDID
          }
        })
        await backend.writeCollection({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          collectionMetadata: { id: 'col', type: ['Collection'] }
        })
        await backend.writeResource({
          spaceId: sourceSpaceId,
          collectionId: 'col',
          resourceId: 'note',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { hello: 'world' }
          },
          createdBy: 'did:key:z6MkSyncIdentitySuiteCreator' as IDID
        })

        // Export signing reads the same rule. A refused document gets no
        // attestor, so the archive is signed here the way a server that
        // ignored the rule would sign it.
        const loaded = await loadExportAttestor({
          storage: backend,
          serverBackends: new ServerBackends({ backends: [backend] }),
          serverUrl,
          signingKey,
          logger: silent
        })
        let attestor: ExportAttestor
        if (advertised) {
          assert.ok('attestor' in loaded, JSON.stringify(loaded))
          attestor = loaded.attestor
        } else {
          assert.ok('reason' in loaded)
          const { publicKeyMultibase, privateKeyMultibase } = signingKey.keyPair
          attestor = {
            serverUrl,
            serverDid: did,
            didLog: Buffer.from(didLog),
            didVersionId: readLogFromString(didLog).at(-1)!.versionId,
            keyPair: new Ed25519VerificationKey({
              id: `${did}#${publicKeyMultibase}`,
              controller: did,
              publicKeyMultibase,
              privateKeyMultibase
            })
          }
        }
        const archive = Buffer.from(
          await collectBytes(
            await backend.exportSpace({ spaceId: sourceSpaceId, attestor })
          )
        )

        const destinationSpaceId = 'destination'
        await backend.writeSpace({
          spaceId: destinationSpaceId,
          spaceMetadata: {
            id: destinationSpaceId,
            type: ['Space'],
            controller: 'did:key:z6MkSyncIdentitySuiteController' as IDID
          }
        })
        const stats = await importArchive({
          backend,
          spaceId: destinationSpaceId,
          tarStream: Readable.from([archive])
        })
        // The Space Metadata object, the Collection, and the Resource.
        const judged = advertised ? 'verified' : 'unknownSigner'
        assert.deepStrictEqual(stats.provenance, {
          verified: 0,
          unattested: 0,
          proofInvalid: 0,
          contentMismatch: 0,
          unknownSigner: 0,
          [judged]: 3
        })
      })
    })
  }
})

describe('Sync signer', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    admin: any,
    adminKeyPair: Ed25519VerificationKey,
    alice: any,
    signingKey: ServerSigningKey,
    serverDid: string,
    log: DIDLog,
    grant: any
  const seed = randomBytes(32)
  const spaceId = `sync-${crypto.randomUUID()}`

  /**
   * Loads the sync signer from the running server's own decorations.
   */
  async function load() {
    return loadSyncSigner({
      storage: fastify.storage,
      serverBackends: fastify.serverBackends,
      serverUrl: fastify.serverUrl,
      signingKey: fastify.serverSigningKey,
      logger: silent
    })
  }

  /**
   * Appends a log entry listing the server key under `purpose`, and stores
   * the log through the front door as the admin.
   */
  async function relistKey(purpose: string[]): Promise<void> {
    const { log: next } = await relisted(purpose)
    await publish(next)
  }

  /**
   * The next log version, listing the server key under `purpose`, unpublished,
   * with the relationships its resolved current document lists the key under,
   * read the way the server reads them.
   */
  async function relisted(
    purpose: string[]
  ): Promise<{ log: DIDLog; listedUnder: string[] }> {
    return await relistServerKey({
      log,
      adminKeyPair,
      publicKeyMultibase: signingKey.keyPair.publicKeyMultibase!,
      purpose
    })
  }

  async function publish(next: DIDLog): Promise<void> {
    const response = await admin.request({
      url: `${baseServerUrl}space/server/id/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(next)], { type: 'text/jsonl' })
    })
    // The first publish creates the log; each later one appends to it.
    assert.ok(response.status === 201 || response.status === 200)
    log = next
  }

  /**
   * Reads Alice's Resource under the grant to `serverDid`, signed by
   * `signer`.
   */
  function readUnderGrant(signer: any) {
    return client({ signer }).request({
      url: `${baseServerUrl}space/${spaceId}/notes/one`,
      method: 'GET',
      action: 'GET',
      capability: grant
    })
  }

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-sync-signer-' })
    adminKeyPair = await Ed25519VerificationKey.generate()
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend,
      serverKeySeed: seed,
      adminDid: `did:key:${adminKeyPair.publicKeyMultibase}`
    }))
    admin = pwsClient({ signer: adminKeyPair.didKeySigner(), baseServerUrl })
    ;({ alice } = await zcapClients({ baseServerUrl }))
    signingKey = await createServerSigningKey({ seed })

    const space = await alice.pws.createSpace({
      id: spaceId,
      controller: alice.did
    })
    await space.createCollection({ id: 'notes' })
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/notes/one`,
      method: 'PUT',
      json: { hello: 'peer' }
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('is refused naming the missing serverDid before the admin publishes a log', async () => {
    const loaded = await load()
    assert.ok('refusal' in loaded)
    assert.equal(loaded.refusal, 'no-server-did')
  })

  it('is refused naming the missing serverDid when no seed is configured', async () => {
    const loaded = await loadSyncSigner({
      storage: fastify.storage,
      serverBackends: fastify.serverBackends,
      serverUrl: fastify.serverUrl,
      signingKey: undefined,
      logger: silent
    })
    assert.ok('refusal' in loaded)
    assert.equal(loaded.refusal, 'no-server-did')
    assert.match(loaded.reason, /WAS_SERVER_KEY_SEED/)
  })

  it('is refused naming capabilityInvocation while the log lists only assertionMethod', async () => {
    await admin.space('server').collection('id').configure({ force: true })
    const created = await mintServerDid({
      serverUrl: baseServerUrl,
      publicKeyMultibase: signingKey.keyPair.publicKeyMultibase!,
      admin: adminKeyPair
    })
    serverDid = created.did
    await publish(created.log)

    const loaded = await load()
    assert.ok('refusal' in loaded)
    assert.equal(loaded.refusal, 'no-capability-invocation')
    assert.ok(
      loaded.reason.includes(
        `"${serverDid}#${signingKey.keyPair.publicKeyMultibase}"`
      ),
      loaded.reason
    )
  })

  it('an invocation by the key under a grant to serverDid is masked while the log lacks capabilityInvocation', async () => {
    grant = await delegate({
      signer: alice.signer,
      capability: `urn:zcap:root:${encodeURIComponent(`${baseServerUrl}space/${spaceId}/`)}`,
      invocationTarget: `${baseServerUrl}space/${spaceId}/`,
      controller: serverDid,
      allowedActions: ['GET']
    })
    // Signed as the sync signer would sign, though the server refuses to
    // hand one out yet.
    const { publicKeyMultibase, privateKeyMultibase } = signingKey.keyPair
    const signer = new Ed25519VerificationKey({
      id: `${serverDid}#${publicKeyMultibase}`,
      controller: serverDid,
      publicKeyMultibase,
      privateKeyMultibase
    }).signer()
    const err = await requestError(readUnderGrant(signer))
    assert.equal(err.status, 404)
    assert.equal(err.data.type, 'https://w3id.org/pws#not-found')
  })

  it('signs invocations a peer verifies once the log adds capabilityInvocation', async () => {
    await relistKey(['assertionMethod', 'capabilityInvocation'])
    const loaded = await load()
    assert.ok('signer' in loaded, JSON.stringify(loaded))
    assert.equal(loaded.serverDid, serverDid)
    assert.equal(
      loaded.signer.id,
      `${serverDid}#${signingKey.keyPair.publicKeyMultibase}`
    )

    const response = await readUnderGrant(loaded.signer)
    assert.equal(response.status, 200)
    assert.deepStrictEqual(response.data, { hello: 'peer' })
  })

  it('stops verifying, and is refused again, once the log drops capabilityInvocation', async () => {
    const before = await load()
    assert.ok('signer' in before)
    await relistKey(['assertionMethod'])

    const err = await requestError(readUnderGrant(before.signer))
    assert.equal(err.status, 404)
    const after = await load()
    assert.ok('refusal' in after)
    assert.equal(after.refusal, 'no-capability-invocation')
  })

  it('throws a storage fault met while reading the log, and refuses nothing', async () => {
    await relistKey(['assertionMethod', 'capabilityInvocation'])
    const getResource = fastify.storage.getResource.bind(fastify.storage)
    let reads = 0
    // The log changed, so the one content read is the identity check's.
    const spy = vi
      .spyOn(fastify.storage, 'getResource')
      .mockImplementation(async options => {
        reads++
        if (reads === 1) {
          throw new Error('disk fault')
        }
        return await getResource(options)
      })
    try {
      await assert.rejects(load(), (err: any) => err.statusCode === 500)
      assert.equal(reads, 1)
    } finally {
      spy.mockRestore()
    }
    const loaded = await load()
    assert.ok('signer' in loaded)
  })

  it('is refused naming the missing serverDid once the log drops assertionMethod, after a call that yielded a signer', async () => {
    await relistKey(['assertionMethod', 'capabilityInvocation'])
    const before = await load()
    assert.ok('signer' in before, JSON.stringify(before))

    // `updateDID` replaces the relationships with the ones it is given, so
    // the next version lists the key under capabilityInvocation alone.
    const next = await relisted(['capabilityInvocation'])
    assert.deepStrictEqual(next.listedUnder, ['capabilityInvocation'])
    await publish(next.log)

    const after = await load()
    assert.ok('refusal' in after, JSON.stringify(after))
    assert.equal(after.refusal, 'no-server-did')
    assert.match(after.reason, /advertises no serverDid/)
  })

  it('judges serverDid and capabilityInvocation from one log version, even when the log changes mid-call', async () => {
    // Version A lists the key under assertionMethod alone: a serverDid and
    // no signer. The call reads it and records its outcome.
    const listed = await relisted(['assertionMethod'])
    assert.deepStrictEqual(listed.listedUnder, ['assertionMethod'])
    await publish(listed.log)
    const warm = await load()
    assert.ok('refusal' in warm, JSON.stringify(warm))
    assert.equal(warm.refusal, 'no-capability-invocation')

    // Version B lists it under capabilityInvocation alone: no serverDid. A
    // serverDid judged from A paired with B's document would yield a signer
    // that neither version yields on its own.
    const next = await relisted(['capabilityInvocation'])
    assert.deepStrictEqual(next.listedUnder, ['capabilityInvocation'])

    // The call's first access to the server log, a metadata read or a
    // content read, completes; then B lands through the front door, which
    // also drops any document the resolver cached for the DID. Every later
    // access sees B.
    const spied = appendAfterFirstServerLogAccess({
      backend,
      append: async () => await publish(next.log)
    })

    let loaded: Awaited<ReturnType<typeof load>>
    try {
      loaded = await load()
    } finally {
      spied.restore()
    }

    // Both decisions came from the one access: version A's.
    assert.equal(spied.accesses(), 1)
    assert.ok('refusal' in loaded, JSON.stringify(loaded))
    assert.equal(loaded.refusal, 'no-capability-invocation')
    // The next call judges B alone.
    const after = await load()
    assert.ok('refusal' in after, JSON.stringify(after))
    assert.equal(after.refusal, 'no-server-did')
  })
})
