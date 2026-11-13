/**
 * Export provenance at the wire (Vitest, in-process): a server with an
 * identity signs one statement per exported object into the archive's
 * `provenance.jsonl` and embeds its history log snapshot as `did.jsonl`;
 * one without carries neither entry and logs a single `warn` line per export.
 * The statements' shape, order and digests are covered per backend by the
 * storage contract suite; this suite covers the handler's side of it.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { logToJsonlString } from '@interop/did-method-webvh'
import { readSpaceArchive } from '@interop/space-archive'

import { mintServerDid } from '../src/testing.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { createServerSigningKey } from '../src/lib/serverIdentity.js'
import {
  openTempBackend,
  startTestServer,
  verifyProvenanceOffline,
  pwsClient,
  zcapClients
} from './helpers.js'

describe('Export provenance (wire level)', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    alice: any,
    admin: any,
    adminKeyPair: Ed25519VerificationKey
  const seed = randomBytes(32)
  const spaceId = `provenance-${crypto.randomUUID()}`
  const logLines: { level: number; msg: string; reason?: string }[] = []

  async function exportArchive() {
    const response = await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/export`,
      method: 'POST'
    })
    assert.equal(response.status, 200)
    return readSpaceArchive(new Uint8Array(await response.arrayBuffer()))
  }

  function provenanceWarnings() {
    return logLines.filter(
      line => line.level === 40 && line.msg.startsWith('Exporting without')
    )
  }

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-export-provenance-' })
    adminKeyPair = await Ed25519VerificationKey.generate()
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend,
      serverKeySeed: seed,
      adminDid: `did:key:${adminKeyPair.publicKeyMultibase}`,
      logger: {
        level: 'warn',
        stream: {
          write(line: string) {
            logLines.push(JSON.parse(line))
          }
        }
      }
    }))
    admin = pwsClient({ signer: adminKeyPair.didKeySigner(), baseServerUrl })
    ;({ alice } = await zcapClients({ baseServerUrl }))
    const space = await alice.pws.createSpace({
      id: spaceId,
      controller: alice.did
    })
    await space.createCollection({ id: 'notes' })
    for (const resourceId of ['one', 'two', 'three']) {
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/notes/${resourceId}`,
        method: 'PUT',
        json: { resourceId }
      })
    }
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('carries neither entry and logs one warn line while the server has no identity', async () => {
    const before = provenanceWarnings().length
    const archive = await exportArchive()
    await archive.close()
    assert.equal(archive.provenance, undefined)
    assert.equal(archive.didLog, undefined)
    assert.equal(archive.manifest.contents['provenance.jsonl'], undefined)
    const warnings = provenanceWarnings().slice(before)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!.reason!, /There is no server history log/)
  })

  it('signs every object and embeds the served log once the admin publishes one', async () => {
    const signingKey = await createServerSigningKey({ seed })
    const { did, log } = await mintServerDid({
      serverUrl: baseServerUrl,
      publicKeyMultibase: signingKey.keyPair.publicKeyMultibase!,
      admin: adminKeyPair
    })
    await admin.space('server').collection('id').configure({ force: true })
    const published = await admin.request({
      url: `${baseServerUrl}space/server/id/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(log)], { type: 'text/jsonl' })
    })
    assert.equal(published.status, 201)

    const before = provenanceWarnings().length
    const archive = await exportArchive()
    await archive.close()
    assert.equal(provenanceWarnings().length, before)
    assert.ok(archive.provenance && archive.didLog)

    // The snapshot is the log's bytes exactly as the server serves them.
    const served = await admin.request({
      url: `${baseServerUrl}space/server/id/did.jsonl`,
      method: 'GET'
    })
    assert.equal(served.status, 200)
    assert.deepStrictEqual(
      Buffer.from(archive.didLog),
      Buffer.from(await served.arrayBuffer())
    )

    const { did: embeddedDid, statements } = await verifyProvenanceOffline({
      provenance: archive.provenance,
      didLog: archive.didLog
    })
    assert.equal(embeddedDid, did)
    const base = `${baseServerUrl}space/${spaceId}`
    assert.deepStrictEqual(
      statements.map(statement => statement.id),
      [
        `${base}/meta`,
        `${base}/notes/meta`,
        `${base}/notes/one`,
        `${base}/notes/three`,
        `${base}/notes/two`
      ]
    )
    // Resources are attributed to the invoker who created them.
    for (const statement of statements.slice(2)) {
      assert.equal(statement.createdBy, alice.did)
    }
  })
})
