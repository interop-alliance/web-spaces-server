/**
 * Wire-level tests (Vitest) for the Space export/import HTTP handlers
 * (`POST /space/:spaceId/export` and `POST /space/:spaceId/import`). These
 * cover the request layer only -- status codes, response headers, 404 authz
 * masking for non-controllers, the `application/x-tar` request/response
 * content-types, the streamed export/import round-trip, the `ImportStats`
 * response body shape, and the `invalid-import` problem-details shapes that a
 * malformed upload produces. The archive-building/parsing logic itself is
 * covered separately at the lib layer in `test/importTar.test.ts`; this suite
 * does not duplicate it.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import * as tar from 'tar-stream'
import YAML from 'yaml'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { createDID, logToJsonlString } from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'

import { WEBVH_DOCUMENT_REVERIFY_AGE } from '../src/config.default.js'
import { extractTarEntries } from '../src/lib/importTar.js'
import { etagOf } from '../src/lib/etag.js'
import { createServerSigningKey } from '../src/lib/serverIdentity.js'
import type { ServerSigningKey } from '../src/lib/serverIdentity.js'
import { mintServerDid } from '../src/testing.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { spaceRevocationsPath } from '../src/lib/paths.js'
import {
  anHourFromNow,
  appendAfterFirstServerLogAccess,
  bareDidKeyOf,
  binaryInput,
  client,
  delegate,
  openTempBackend,
  pwsClient,
  relistServerKey,
  rootZcap,
  startTestServer,
  webvhLogSigner,
  zcapClients
} from './helpers.js'

const NOT_FOUND_TYPE = 'https://w3id.org/pws#not-found'
const INVALID_IMPORT_TYPE = 'https://w3id.org/pws#invalid-import'

/**
 * Serializes a set of tar entries to a `Uint8Array`, for a signed `x-tar`
 * import body. A `null` body marks a directory entry; a string body is packed
 * as a UTF-8 file.
 *
 * @param entries {Array<[string, string | null]>}   `[name, body]` pairs
 * @returns {Promise<Uint8Array>}
 */
async function packTar(
  entries: Array<[string, string | null]>
): Promise<Uint8Array> {
  const pack = tar.pack()
  for (const [name, body] of entries) {
    if (body === null) {
      pack.entry({ name, type: 'directory' })
    } else {
      pack.entry({ name }, body)
    }
  }
  pack.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of pack) {
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** A minimal, valid UBC v0.1 manifest body (YAML). */
function validManifestYaml(): string {
  return YAML.stringify({
    'ubc-version': '0.1',
    contents: { space: { url: 'https://example/spec#spaces' } }
  })
}

/**
 * Exports a Space and returns its archive entries.
 *
 * @param options {object}
 * @param options.pws {any}   a client handle signing as the Space controller
 * @param options.baseServerUrl {string}
 * @param options.spaceId {string}
 * @returns {Promise<Awaited<ReturnType<typeof extractTarEntries>>>}
 */
async function exportSpaceEntries({
  pws,
  baseServerUrl,
  spaceId
}: {
  pws: any
  baseServerUrl: string
  spaceId: string
}): Promise<Awaited<ReturnType<typeof extractTarEntries>>> {
  const response = await pws.request({
    url: `${baseServerUrl}space/${spaceId}/export`,
    method: 'POST'
  })
  assert.equal(response.status, 200)
  return await extractTarEntries(
    Readable.from(Buffer.from(await response.arrayBuffer()))
  )
}

/**
 * The `serverDid` member of a Service Description's core `specs` entry.
 *
 * @param document {any}   a parsed Service Description
 * @returns {string | undefined}
 */
function serverDidOf(document: any): string | undefined {
  return document.specs['https://w3id.org/pws'][0].serverDid
}

/**
 * Exports a Space and reads the server's `/service` response, returning the
 * raw bytes of the archive's `service.json` entry and of the response body.
 * Also checks that the entry is written immediately after the manifest, which
 * the reader relies on.
 *
 * @param options {object}
 * @param options.pws {any}   a client handle signing as the Space controller
 * @param options.baseServerUrl {string}
 * @param options.spaceId {string}
 * @returns {Promise<{ entry: Buffer, served: Buffer }>}
 */
async function serviceEntryAndServedBody({
  pws,
  baseServerUrl,
  spaceId
}: {
  pws: any
  baseServerUrl: string
  spaceId: string
}): Promise<{ entry: Buffer; served: Buffer }> {
  const entries = await exportSpaceEntries({ pws, baseServerUrl, spaceId })
  assert.deepEqual([...entries.keys()].slice(0, 2), [
    'manifest.yml',
    'service.json'
  ])
  const served = await fetch(new URL('/service', baseServerUrl))
  assert.equal(served.status, 200)
  return {
    entry: entries.get('service.json')!.body!,
    served: Buffer.from(await served.arrayBuffer())
  }
}

describe('Export/Import Space API (wire level)', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any, bob: any
  const sourceSpaceId = `export-src-${crypto.randomUUID()}`
  const collectionId = 'notes'
  const resourceId = 'note1'

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice, bob } = await zcapClients({ baseServerUrl }))

    // Provision a source Space with one Collection and one Resource, so the
    // export has real content to stream back and the round-trip has something
    // to reconstruct.
    const space = await alice.pws.createSpace({
      id: sourceSpaceId,
      name: 'Export Source',
      controller: alice.did
    })
    await space.createCollection({ id: collectionId, name: 'Notes' })
    await alice.pws.request({
      url: `${baseServerUrl}space/${sourceSpaceId}/${collectionId}/${resourceId}`,
      method: 'PUT',
      json: { id: resourceId, hello: 'world' }
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('Export (POST /space/:spaceId/export)', () => {
    it('returns 200 with an application/x-tar body for the controller', async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/x-tar/)
      const bytes = new Uint8Array(await response.arrayBuffer())
      assert.ok(bytes.length > 0, 'expected a non-empty tar body')
    })

    it("carries the served Service Description as the archive's service.json", async () => {
      const { entry, served } = await serviceEntryAndServedBody({
        pws: alice.pws,
        baseServerUrl,
        spaceId: sourceSpaceId
      })
      assert.deepStrictEqual(entry, served)
      // A server with no identity advertises neither identity member.
      const document = JSON.parse(served.toString('utf8'))
      assert.equal(document.instance.exportSigningMethod, undefined)
      assert.equal(serverDidOf(document), undefined)
    })

    it('masks a non-controller export as 404 (not 403)', async () => {
      // Bob is not the Space controller. The privacy-merged authz convention
      // answers with `not-found` rather than leaking the Space's existence.
      let expectedError: any
      try {
        await bob.pws.request({
          url: `${baseServerUrl}space/${sourceSpaceId}/export`,
          method: 'POST'
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(
        expectedError,
        'expected the non-controller export to be denied'
      )
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })

    it('masks an export of a non-existent Space as 404', async () => {
      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${crypto.randomUUID()}/export`,
          method: 'POST'
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })
  })

  describe('Import (POST /space/:spaceId/import)', () => {
    it('round-trips: an exported tar imports into a fresh Space (200 + ImportStats)', async () => {
      // Export the source Space, then import that same tar into a distinct,
      // pre-provisioned destination Space and confirm the Resource is restored.
      const exportResponse = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const tarBytes = new Uint8Array(await exportResponse.arrayBuffer())

      const destSpaceId = `export-dest-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: destSpaceId,
        name: 'Import Destination',
        controller: alice.did
      })

      const importResponse = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(importResponse.status, 200)

      // ImportStats: all six tally fields present and numeric, with at least the
      // one Collection and one Resource from the source counted as created.
      const stats = importResponse.data
      for (const field of [
        'collectionsCreated',
        'collectionsSkipped',
        'resourcesCreated',
        'resourcesSkipped',
        'policiesCreated',
        'policiesSkipped'
      ]) {
        assert.equal(
          typeof stats[field],
          'number',
          `expected numeric ImportStats.${field}`
        )
      }
      assert.ok(stats.collectionsCreated >= 1, 'expected a Collection created')
      assert.ok(stats.resourcesCreated >= 1, 'expected a Resource created')
      // Alice invoked the root capability, so the archived Space Metadata
      // object's user-writable members were applied.
      assert.equal(stats.spaceMetadata, 'restored')
      // This server has no identity, so its export carries no provenance:
      // every object it holds is counted unattested, and nothing else.
      const { unattested, ...attested } = stats.provenance
      assert.ok(unattested >= 3, 'expected unattested objects counted')
      assert.deepStrictEqual(attested, {
        verified: 0,
        proofInvalid: 0,
        contentMismatch: 0,
        unknownSigner: 0
      })

      // The imported Resource is readable in the destination Space.
      const readBack = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/${collectionId}/${resourceId}`,
        method: 'GET'
      })
      assert.equal(readBack.status, 200)
      assert.equal(readBack.data.hello, 'world')
    })

    it('is idempotent on re-import: a second import skips the existing items', async () => {
      // A re-import over the same destination counts the pre-existing Collection
      // and Resource as skipped rather than created.
      const exportResponse = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const tarBytes = new Uint8Array(await exportResponse.arrayBuffer())

      const destSpaceId = `export-dest-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: destSpaceId,
        name: 'Re-import Destination',
        controller: alice.did
      })

      const first = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(first.status, 200)
      assert.ok(first.data.collectionsCreated >= 1)

      const second = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(second.status, 200)
      assert.equal(second.data.collectionsCreated, 0)
      assert.ok(second.data.collectionsSkipped >= 1)
      assert.ok(second.data.resourcesSkipped >= 1)
    })

    it('masks a non-controller import as 404 (not 403)', async () => {
      // Authorization is checked before the archive is applied, so Bob's import
      // is denied with the privacy-merged `not-found` even with a valid tar.
      const tarBytes = await packTar([
        ['manifest.yml', validManifestYaml()],
        ['space/', null],
        [`space/${sourceSpaceId}/`, null],
        [
          `space/${sourceSpaceId}/.space.meta.${sourceSpaceId}.json`,
          JSON.stringify({ id: sourceSpaceId })
        ]
      ])
      let expectedError: any
      try {
        await bob.pws.request({
          url: `${baseServerUrl}space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(
        expectedError,
        'expected the non-controller import to be denied'
      )
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })

    it('rejects a non-tar body with 400 invalid-import', async () => {
      // Garbage bytes are not a decodable tar. The extractor throws a generic
      // Error, which the handler wraps as `invalid-import` (400) -- exercising
      // the catch-and-wrap branch for unexpected decode failures.
      const garbage = new TextEncoder().encode(
        'this is definitely not a tar archive'.repeat(8)
      )
      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${sourceSpaceId}/import`,
          method: 'POST',
          body: garbage,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError, 'expected the garbage upload to be rejected')
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('rejects a tar with no manifest with 400 invalid-import', async () => {
      // A well-formed tar that lacks `manifest.yml` fails the manifest check,
      // which throws a typed InvalidImportError -- passed through unchanged
      // (400 `invalid-import`) by the handler.
      const tarBytes = await packTar([['space/', null]])
      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('rejects a tar with an unsupported manifest version with 400 invalid-import', async () => {
      const tarBytes = await packTar([
        ['manifest.yml', YAML.stringify({ 'ubc-version': '0.2' })]
      ])
      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('rejects a valid manifest carrying no space data with 400 invalid-import', async () => {
      // The manifest validates, but there is no `space/<id>/` data to plan --
      // buildImportPlan throws a typed InvalidImportError.
      const tarBytes = await packTar([['manifest.yml', validManifestYaml()]])
      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('masks an import into a non-existent Space as 404', async () => {
      const tarBytes = await packTar([['manifest.yml', validManifestYaml()]])
      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${crypto.randomUUID()}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })
  })

  describe("the Space Metadata object's server-derived backends", () => {
    it('is served on Read Space, naming the server default backend', async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const { backends } = response.data
      assert.ok(Array.isArray(backends), 'expected a backends array')
      assert.ok(
        backends.some((backend: any) => backend.id === 'default'),
        "expected the server's default backend in the listing"
      )
      // The same listing `GET /space/{id}/backends` serves.
      const served = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/backends`,
        method: 'GET'
      })
      assert.deepEqual(backends, served.data)
    })

    it("rides along in the archive's Space Metadata entry", async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const entries = await extractTarEntries(
        Readable.from(Buffer.from(await response.arrayBuffer()))
      )
      const archived = JSON.parse(
        entries
          .get(`space/${sourceSpaceId}/.space.meta.${sourceSpaceId}.json`)!
          .body!.toString('utf8')
      )
      assert.ok(
        archived.backends.some((backend: any) => backend.id === 'default'),
        'expected the backends listing in the archived object'
      )
      // The archived generation still travels beside it; the local counter
      // does not.
      assert.equal(typeof archived._generation, 'string')
      assert.equal(archived._local, undefined)
    })

    it('is ignored when a write body supplies one', async () => {
      const spaceId = `backends-write-${crypto.randomUUID()}`
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'PUT',
        json: {
          id: spaceId,
          name: 'Supplied backends',
          controller: alice.did,
          backends: [{ id: 'forged', managedBy: 'server' }]
        }
      })
      assert.equal(created.status, 201)
      assert.ok(
        !created.data.backends.some((backend: any) => backend.id === 'forged'),
        'expected the supplied backends to be dropped from the create echo'
      )

      const updated = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'PUT',
        json: {
          id: spaceId,
          name: 'Supplied backends again',
          controller: alice.did,
          backends: [{ id: 'forged', managedBy: 'server' }]
        }
      })
      assert.equal(updated.status, 204)

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'GET'
      })
      assert.ok(
        !read.data.backends.some((backend: any) => backend.id === 'forged'),
        'expected the supplied backends never to be stored'
      )
    })
  })

  describe('import and the archived Space Metadata object', () => {
    /**
     * Provisions a Space carrying a distinctive `name` (and the given `type`),
     * and exports it. The archive's Space Metadata entry is what each case
     * below restores (or declines to restore) into a fresh destination Space.
     *
     * @param options {object}
     * @param [options.type] {string[]}   the source Space's `type`; the
     *   destination's is the default `['Space']`
     * @returns {Promise<{ tarBytes: Uint8Array, type: string[], name: string }>}
     */
    async function archivedSource({
      type = ['Space']
    }: { type?: string[] } = {}): Promise<{
      tarBytes: Uint8Array
      type: string[]
      name: string
    }> {
      const spaceId = `meta-src-${crypto.randomUUID()}`
      const name = 'Archived Name'
      const created = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'PUT',
        json: { id: spaceId, type, name, controller: alice.did }
      })
      assert.equal(created.status, 201)
      const exported = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/export`,
        method: 'POST'
      })
      return {
        tarBytes: new Uint8Array(await exported.arrayBuffer()),
        type,
        name
      }
    }

    /**
     * Provisions a plain destination Space to import into.
     *
     * @returns {Promise<string>}   the destination Space id
     */
    async function destination(): Promise<string> {
      const spaceId = `meta-dest-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Destination Name',
        controller: alice.did
      })
      return spaceId
    }

    it('restores the archived name under a root invocation', async () => {
      const { tarBytes, type, name } = await archivedSource()
      const destSpaceId = await destination()

      const imported = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'restored')

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, name)
      assert.deepEqual(read.data.type, [...type].sort())
      // Never the controller, and never a server-derived member: the
      // destination keeps its own.
      assert.equal(read.data.controller, alice.did)
      assert.equal(read.data.id, destSpaceId)
      assert.equal(read.data.url, `/space/${destSpaceId}/`)
    })

    it("refuses an archive whose type differs from the destination's (400 invalid-import)", async () => {
      // A Space's `type` is immutable once it exists, so an archive of a
      // Space of another kind is refused rather than applied -- before
      // anything is written, so the destination keeps its name too.
      const { tarBytes } = await archivedSource({
        type: ['AuxiliarySpace', 'Space']
      })
      const destSpaceId = await destination()

      let expectedError: any
      try {
        await alice.pws.request({
          url: `${baseServerUrl}space/${destSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
      assert.match(expectedError.data.errors[0].detail, /"type" does not match/)

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
      assert.deepEqual(read.data.type, ['Space'])
    })

    it('treats a Space Metadata entry that is not a JSON object as absent', async () => {
      // A garbage entry is not a Space Metadata object; the rest of the
      // archive imports as it would with no entry at all.
      const destSpaceId = await destination()
      const tarBytes = await packTar([
        ['manifest.yml', validManifestYaml()],
        ['space/', null],
        [`space/${destSpaceId}/`, null],
        [`space/${destSpaceId}/.space.meta.${destSpaceId}.json`, '{not json'],
        [`space/${destSpaceId}/notes/`, null]
      ])
      const imported = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'absent')
      assert.equal(imported.data.collectionsCreated, 1)

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
    })

    it('skips them under a delegated chain, reporting "skipped"', async () => {
      const { tarBytes, name } = await archivedSource()
      const destSpaceId = await destination()

      // A Space-subtree grant to Bob: it reaches the import route by
      // attenuation, but it is not an invocation of the root capability.
      const spaceUrl = new URL(
        `/space/${destSpaceId}/`,
        baseServerUrl
      ).toString()
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT', 'POST', 'DELETE'],
        expires: anHourFromNow()
      })
      const imported = await client({ signer: bob.signer }).request({
        url: new URL(`/space/${destSpaceId}/import`, baseServerUrl).toString(),
        method: 'POST',
        action: 'POST',
        capability,
        headers: { 'content-type': 'application/x-tar' },
        body: Buffer.from(tarBytes)
      })
      assert.equal(imported.status, 200)
      assert.equal((imported.data as any).spaceMetadata, 'skipped')

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
      assert.notEqual(read.data.name, name)
      assert.deepEqual(read.data.type, ['Space'])
      assert.equal(read.data.controller, alice.did)
    })

    it('reports "absent" for an archive carrying no Space Metadata entry', async () => {
      const destSpaceId = await destination()
      const tarBytes = await packTar([
        ['manifest.yml', validManifestYaml()],
        ['space/', null],
        [`space/${destSpaceId}/`, null],
        [`space/${destSpaceId}/notes/`, null]
      ])
      const imported = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'absent')

      const read = await alice.pws.request({
        url: `${baseServerUrl}space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
    })
  })

  describe('a Space whose id is `policy`', () => {
    // The Space Metadata file is `.space.meta.<spaceId>.json`, so a Space
    // named `policy` keeps it apart from the Space's own policy file,
    // `.space.policy.json`, in the Space dir and in the archive alike. Under
    // the earlier `.space.<spaceId>.json` name the two collided, and the
    // Space could be created but not exported.
    const spaceId = 'policy'
    const metadataEntry = `space/${spaceId}/.space.meta.${spaceId}.json`
    const policyEntry = `space/${spaceId}/.space.policy.json`

    async function provision(): Promise<void> {
      const space = await alice.pws.createSpace({
        id: spaceId,
        name: 'Policy Space',
        controller: alice.did
      })
      await space.createCollection({ id: collectionId, name: 'Notes' })
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/${resourceId}`,
        method: 'PUT',
        json: { id: resourceId, hello: 'policy' }
      })
    }

    it('exports its Metadata and policy files apart and imports both', async () => {
      await provision()
      const policyWrite = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/policy`,
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      assert.equal(policyWrite.status, 201)

      const exported = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/export`,
        method: 'POST'
      })
      assert.equal(exported.status, 200)
      const tarBytes = new Uint8Array(await exported.arrayBuffer())
      const entries = await extractTarEntries(
        Readable.from(Buffer.from(tarBytes))
      )
      const metadata = JSON.parse(
        entries.get(metadataEntry)!.body!.toString('utf8')
      )
      assert.equal(metadata.id, spaceId)
      assert.equal(metadata.name, 'Policy Space')
      const policy = JSON.parse(
        entries.get(policyEntry)!.body!.toString('utf8')
      )
      assert.equal(policy.type, 'PublicCanRead')

      // The Space is lost and restored from the archive. The Metadata object,
      // the policy and the Resource all come back.
      const deleted = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Fresh Policy Space',
        controller: alice.did
      })
      const imported = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'restored')

      const readMetadata = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/meta`,
        method: 'GET'
      })
      assert.equal(readMetadata.data.name, 'Policy Space')
      const readPolicy = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/policy`,
        method: 'GET'
      })
      assert.equal(readPolicy.status, 200)
      assert.equal(readPolicy.data.type, 'PublicCanRead')
      const readResource = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/${collectionId}/${resourceId}`,
        method: 'GET'
      })
      assert.equal(readResource.data.hello, 'policy')
    })
  })

  describe('archived zcap revocations', () => {
    /**
     * The Space's canonical trailing-slash URL.
     */
    function spaceUrlOf(spaceId: string): string {
      return new URL(`/space/${spaceId}/`, baseServerUrl).toString()
    }

    /**
     * Exports a Space and returns its archive entries.
     */
    async function exportEntries(spaceId: string) {
      return await exportSpaceEntries({
        pws: alice.pws,
        baseServerUrl,
        spaceId
      })
    }

    /**
     * The revocation records a Space holds, read off its export archive.
     */
    async function storedRevocations(spaceId: string): Promise<any[]> {
      const entries = await exportEntries(spaceId)
      return [...entries]
        .filter(
          ([entryName, entry]) =>
            entryName.startsWith(`space/${spaceId}/.revocations/`) &&
            entry.type === 'file'
        )
        .map(([, entry]) => JSON.parse(entry.body!.toString('utf8')))
    }

    /**
     * Imports archive bytes into a Space under Alice's root invocation.
     */
    async function importInto(spaceId: string, tarBytes: Uint8Array) {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(response.status, 200)
    }

    it('installs an archived revocation only where its chain roots', async () => {
      // A Space holding one real revocation: a grant Alice delegated from
      // the Space's root capability, revoked through the revocation route.
      const spaceId = `revoked-src-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Revocation Source',
        controller: alice.did
      })
      const spaceUrl = spaceUrlOf(spaceId)
      const grant = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const revoked = await client({ signer: alice.signer }).request({
        url: new URL(
          spaceRevocationsPath({ spaceId, revocationId: grant.id }),
          baseServerUrl
        ).toString(),
        method: 'POST',
        action: 'POST',
        capability: rootZcap({ target: spaceUrl, controller: alice.did }),
        json: grant
      })
      assert.equal(revoked.status, 204)
      const [original] = await storedRevocations(spaceId)
      assert.equal(original.capability.id, grant.id)

      // The archive also carries a forged record: no proof, and a
      // capability no one delegated.
      const forged = {
        capability: { id: 'urn:zcap:forged' },
        meta: {
          delegator: bob.did,
          rootTarget: spaceUrl,
          created: new Date().toISOString()
        }
      }
      const archived = await exportEntries(spaceId)
      const tarBytes = await packTar([
        ...[...archived].map(([entryName, entry]): [string, string | null] => [
          entryName,
          entry.type === 'directory' ? null : entry.body!.toString('utf8')
        ]),
        [`space/${spaceId}/.revocations/forged.json`, JSON.stringify(forged)]
      ])

      // A fresh Space has another root, so the chain does not verify there
      // and the import installs nothing.
      const freshSpaceId = `revoked-dest-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: freshSpaceId,
        name: 'Revocation Destination',
        controller: alice.did
      })
      await importInto(freshSpaceId, tarBytes)
      assert.deepEqual(await storedRevocations(freshSpaceId), [])

      // The same Space id, deleted and created again, has the chain's root:
      // the genuine record is installed with server-built `meta`, and the
      // forged one is skipped.
      const deleted = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Revocation Source',
        controller: alice.did
      })
      assert.deepEqual(await storedRevocations(spaceId), [])
      await importInto(spaceId, tarBytes)
      const restored = await storedRevocations(spaceId)
      assert.equal(restored.length, 1)
      assert.equal(restored[0].capability.id, grant.id)
      assert.equal(restored[0].meta.rootTarget, spaceUrl)
      assert.equal(restored[0].meta.delegator, original.meta.delegator)
    })

    /**
     * The archive of a Space with one extra record naming `capability` as
     * revoked, as a forged or foreign archive would carry it.
     */
    async function archiveNaming(spaceId: string, capability: any) {
      const archived = await exportEntries(spaceId)
      return packTar([
        ...[...archived].map(([entryName, entry]): [string, string | null] => [
          entryName,
          entry.type === 'directory' ? null : entry.body!.toString('utf8')
        ]),
        [
          `space/${spaceId}/.revocations/named.json`,
          JSON.stringify({ capability })
        ]
      ])
    }

    /**
     * Imports archive bytes under a delegated capability.
     */
    async function importUnder({
      signer,
      capability,
      spaceId,
      tarBytes
    }: {
      signer: any
      capability: any
      spaceId: string
      tarBytes: Uint8Array
    }) {
      const response = await client({ signer }).request({
        url: `${spaceUrlOf(spaceId)}import`,
        method: 'POST',
        action: 'POST',
        capability,
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(response.status, 200)
    }

    /**
     * Reads the Space Metadata object under a delegated GET grant and returns
     * the status: 200 while the grant stands, 404 once it is revoked.
     */
    async function readStatus(spaceId: string, grant: any): Promise<number> {
      try {
        const response = await client({ signer: bob.signer }).request({
          url: `${spaceUrlOf(spaceId)}meta`,
          method: 'GET',
          action: 'GET',
          capability: grant
        })
        return response.status
      } catch (err: any) {
        return err.status
      }
    }

    it("installs a revocation only when the import's own grant could submit it on the revocation route", async () => {
      const spaceId = `revoked-grant-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Revocation Grant',
        controller: alice.did
      })
      const spaceUrl = spaceUrlOf(spaceId)
      const root = `urn:zcap:root:${encodeURIComponent(spaceUrl)}`
      // Bob's genuine, live grant, which Alice never revoked.
      const bobGrant = await delegate({
        signer: alice.signer,
        capability: root,
        invocationTarget: `${spaceUrl}meta`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      assert.equal(await readStatus(spaceId, bobGrant), 200)
      const tarBytes = await archiveNaming(spaceId, bobGrant)

      // Carol holds an import-only grant: `POST` on the import URL alone.
      // It does not reach the revocation URL, so on the revocation route she
      // could not revoke Bob's grant, and the import does not either.
      const carol = bareDidKeyOf(await Ed25519VerificationKey.generate())
      const importOnly = await delegate({
        signer: alice.signer,
        capability: root,
        invocationTarget: `${spaceUrl}import`,
        controller: carol.did,
        allowedActions: ['POST']
      })
      await importUnder({
        signer: carol.signer,
        capability: importOnly,
        spaceId,
        tarBytes
      })
      assert.deepEqual(await storedRevocations(spaceId), [])
      assert.equal(await readStatus(spaceId, bobGrant), 200)

      // A `POST` grant on the whole Space reaches the revocation URL by
      // attenuation, as it does on the route, so the same archive installs
      // the record under it.
      const subtree = await delegate({
        signer: alice.signer,
        capability: root,
        invocationTarget: spaceUrl,
        controller: carol.did,
        allowedActions: ['POST']
      })
      await importUnder({
        signer: carol.signer,
        capability: subtree,
        spaceId,
        tarBytes
      })
      const [stored, ...rest] = await storedRevocations(spaceId)
      assert.equal(rest.length, 0)
      assert.equal(stored.capability.id, bobGrant.id)
      assert.equal(stored.meta.delegator, alice.did)
      assert.equal(await readStatus(spaceId, bobGrant), 404)
    })

    it('installs a revocation of a grant the importing invoker holds', async () => {
      const spaceId = `revoked-own-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Revocation Own',
        controller: alice.did
      })
      const spaceUrl = spaceUrlOf(spaceId)
      const root = `urn:zcap:root:${encodeURIComponent(spaceUrl)}`
      const bobGrant = await delegate({
        signer: alice.signer,
        capability: root,
        invocationTarget: `${spaceUrl}meta`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const importOnly = await delegate({
        signer: alice.signer,
        capability: root,
        invocationTarget: `${spaceUrl}import`,
        controller: bob.did,
        allowedActions: ['POST']
      })
      // Bob is a controller in the chain he names, so he may revoke his own
      // grant, as the revocation route lets a delegee do.
      await importUnder({
        signer: bob.signer,
        capability: importOnly,
        spaceId,
        tarBytes: await archiveNaming(spaceId, bobGrant)
      })
      const [stored] = await storedRevocations(spaceId)
      assert.equal(stored.capability.id, bobGrant.id)
      assert.equal(await readStatus(spaceId, bobGrant), 404)
    })

    it('installs a revocation whose chain resolves through a history log the archive restores', async () => {
      // A `did:webvh` hosted in the Space's `id` Collection, holding one key
      // under every relationship a delegation needs.
      const spaceId = `revoked-webvh-${crypto.randomUUID()}`
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Revocation Webvh',
        controller: alice.did
      })
      await alice.pws.space(spaceId).collection('id').configure({ force: true })
      const updateKeyPair = await Ed25519VerificationKey.generate()
      const clientKeyPair = await Ed25519VerificationKey.generate()
      const created = await createDID({
        address: `${baseServerUrl}space/${spaceId}/id`,
        signer: webvhLogSigner({ keyPair: updateKeyPair }),
        updateKeys: [updateKeyPair.publicKeyMultibase!],
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: clientKeyPair.publicKeyMultibase!,
            purpose: [
              'authentication',
              'assertionMethod',
              'capabilityInvocation',
              'capabilityDelegation'
            ]
          }
        ] as any
      })
      clientKeyPair.id = `${created.did}#${clientKeyPair.publicKeyMultibase}`
      clientKeyPair.controller = created.did
      const published = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/id/did.jsonl`,
        method: 'PUT',
        headers: { 'content-type': 'text/jsonl' },
        body: new Blob([logToJsonlString(created.log)], { type: 'text/jsonl' })
      })
      assert.equal(published.status, 201)

      // Alice delegates to the DID, which delegates onward to Bob. The link
      // to Bob is signed by a key only that log resolves.
      const spaceUrl = spaceUrlOf(spaceId)
      const toWebvh = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: created.did,
        allowedActions: ['GET']
      })
      const toBob = await delegate({
        signer: clientKeyPair.signer(),
        capability: toWebvh,
        invocationTarget: `${spaceUrl}meta`,
        controller: bob.did,
        allowedActions: ['GET']
      })
      assert.equal(await readStatus(spaceId, toBob), 200)
      const revoked = await client({ signer: alice.signer }).request({
        url: new URL(
          spaceRevocationsPath({ spaceId, revocationId: toBob.id }),
          baseServerUrl
        ).toString(),
        method: 'POST',
        action: 'POST',
        capability: rootZcap({ target: spaceUrl, controller: alice.did }),
        json: toBob
      })
      assert.equal(revoked.status, 204)
      assert.equal(await readStatus(spaceId, toBob), 404)

      // The Space is lost and restored from its archive. The log comes back
      // with the archive, so the record's chain verifies again and Bob stays
      // revoked. Verified before the log landed, the record would be skipped.
      const exportResponse = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/export`,
        method: 'POST'
      })
      const tarBytes = new Uint8Array(await exportResponse.arrayBuffer())
      const deleted = await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)
      await alice.pws.createSpace({
        id: spaceId,
        name: 'Revocation Webvh',
        controller: alice.did
      })
      await importInto(spaceId, tarBytes)
      const [restored, ...rest] = await storedRevocations(spaceId)
      assert.equal(rest.length, 0)
      assert.equal(restored.capability.id, toBob.id)
      assert.equal(restored.meta.delegator, created.did)
      assert.equal(await readStatus(spaceId, toBob), 404)
    })
  })
})

describe('Export Space service.json on a server with an identity', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    backend: TempFileSystemBackend,
    adminKeyPair: Ed25519VerificationKey,
    signingKey: ServerSigningKey,
    log: DIDLog
  const seed = randomBytes(32)
  const spaceId = `export-identity-${crypto.randomUUID()}`

  beforeAll(async () => {
    adminKeyPair = await Ed25519VerificationKey.generate()
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend,
      serverKeySeed: seed,
      adminDid: `did:key:${adminKeyPair.publicKeyMultibase}`
    }))
    // The admin publishes the server's history log, listing the
    // export-signing key, so `/service` advertises the server DID.
    const admin = pwsClient({
      signer: adminKeyPair.didKeySigner(),
      baseServerUrl
    })
    signingKey = await createServerSigningKey({ seed })
    ;({ log } = await mintServerDid({
      serverUrl: baseServerUrl,
      publicKeyMultibase: signingKey.keyPair.publicKeyMultibase!,
      admin: adminKeyPair
    }))
    await admin.space('server').collection('id').configure({ force: true })
    const published = await admin.request({
      url: `${baseServerUrl}space/server/id/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(log)], { type: 'text/jsonl' })
    })
    assert.equal(published.status, 201)

    ;({ alice } = await zcapClients({ baseServerUrl }))
    await alice.pws.createSpace({ id: spaceId, controller: alice.did })
  })
  afterAll(async () => {
    await fastify.close()
  })

  /**
   * The next log version after `prior`, listing the export-signing key under
   * `purpose` alone. Asserts the resolved document lists it so: `updateDID`
   * replaces the relationships rather than merging them.
   */
  async function relisted({
    prior,
    purpose
  }: {
    prior: DIDLog
    purpose: string[]
  }): Promise<DIDLog> {
    const { log: next, listedUnder } = await relistServerKey({
      log: prior,
      adminKeyPair,
      publicKeyMultibase: signingKey.keyPair.publicKeyMultibase!,
      purpose
    })
    assert.deepStrictEqual(listedUnder, purpose)
    return next
  }

  /**
   * Stores `next` as the server history log through a backend write, which
   * mints a new stamp and so a new `ETag`.
   */
  async function storeLog(next: DIDLog): Promise<void> {
    await backend.writeResource({
      spaceId: 'server',
      collectionId: 'id',
      resourceId: 'did.jsonl',
      input: binaryInput(logToJsonlString(next), { contentType: 'text/jsonl' })
    })
  }

  /**
   * Rewrites the stored log's bytes to `next` out of band: the sidecar, and
   * so the log's `ETag`, stay as they were.
   */
  async function rewriteLogInPlace(next: DIDLog): Promise<void> {
    const target = {
      spaceId: 'server',
      collectionId: 'id',
      resourceId: 'did.jsonl'
    }
    const etagBefore = etagOf((await backend.getResourceMetadata(target))!)
    const collectionDir = path.join(backend.spacesDir, 'server', 'id')
    const { fileName } = JSON.parse(
      await readFile(path.join(collectionDir, '.meta.did.jsonl.json'), 'utf8')
    )
    await writeFile(
      path.join(collectionDir, fileName),
      logToJsonlString(next),
      'utf8'
    )
    assert.equal(
      etagOf((await backend.getResourceMetadata(target))!),
      etagBefore
    )
  }

  /**
   * The `serverDid` the running server's `/service` advertises, if any.
   */
  async function advertisedServerDid(): Promise<string | undefined> {
    const response = await fetch(new URL('/service', baseServerUrl))
    assert.equal(response.status, 200)
    return serverDidOf(await response.json())
  }

  /**
   * Exports the test Space and returns its archive entries.
   */
  async function exportEntries(): Promise<
    Awaited<ReturnType<typeof extractTarEntries>>
  > {
    return await exportSpaceEntries({
      pws: alice.pws,
      baseServerUrl,
      spaceId
    })
  }

  it('carries the identity members, byte-identical to the /service body', async () => {
    const { entry, served } = await serviceEntryAndServedBody({
      pws: alice.pws,
      baseServerUrl,
      spaceId
    })
    const document = JSON.parse(served.toString('utf8'))
    assert.equal(typeof document.instance.exportSigningMethod, 'string')
    assert.match(serverDidOf(document)!, /^did:webvh:/)
    assert.deepStrictEqual(entry, served)
  })

  it('takes serverDid and the provenance snapshot from one log version, even when the log changes mid-export', async () => {
    // The next log version lists the key under `authentication` alone, so
    // judged on its own it advertises no server DID and signs nothing.
    const before = logToJsonlString(log)
    const beforeVersionId = log.at(-1)!.versionId
    const next = await relisted({ prior: log, purpose: ['authentication'] })

    // The export's first access to the server log, a metadata read or a
    // content read, completes; then the next version lands, written straight
    // to the backend. Every later access during the export sees it.
    const spied = appendAfterFirstServerLogAccess({
      backend,
      append: async () => await storeLog(next)
    })

    let entries: Awaited<ReturnType<typeof extractTarEntries>>
    try {
      entries = await exportEntries()
    } finally {
      spied.restore()
    }
    // Later cases build on the stored version.
    log = next

    // The export read the log once, and judged both outputs from that read:
    // the version from before the write.
    assert.equal(spied.accesses(), 1)
    const service = JSON.parse(entries.get('service.json')!.body!.toString())
    const serverDid = serverDidOf(service)
    assert.match(serverDid!, /^did:webvh:/)
    assert.equal(entries.get('did.jsonl')?.body?.toString(), before)
    const provenance = entries.get('provenance.jsonl')?.body?.toString()
    assert.ok(provenance, 'the archive carries provenance')
    for (const line of provenance.trim().split('\n')) {
      const statement = JSON.parse(line)
      assert.ok(statement.proof.verificationMethod.startsWith(`${serverDid}#`))
      assert.equal(statement.didVersionId, beforeVersionId)
    }
    // The version that landed mid-export is stored, and judged on its own
    // it advertises no server DID.
    assert.equal(await advertisedServerDid(), undefined)
  })

  it('judges service.json from the log as stored, not from what /service last read', async () => {
    // A version listing the key under assertionMethod again. `/service`
    // reads it and records that it advertises the server DID.
    const listed = await relisted({ prior: log, purpose: ['assertionMethod'] })
    await storeLog(listed)
    log = listed
    const serverDid = await advertisedServerDid()
    assert.match(serverDid!, /^did:webvh:/)

    // The next version drops assertionMethod. Any backend write mints a new
    // stamp, so `/service` would read it at once. Its bytes are rewritten in
    // place instead, out of band: the sidecar and so the log's `ETag` stay,
    // and `/service` keeps the outcome it recorded for that `ETag`.
    const next = await relisted({ prior: log, purpose: ['authentication'] })
    await rewriteLogInPlace(next)
    assert.equal(await advertisedServerDid(), serverDid)

    // The export reads the stored bytes, so its service.json and its
    // provenance agree with the version it reads: no server DID, nothing
    // signed. An export that took service.json's DID from the memo ahead of
    // its own read would carry the stale DID with no provenance.
    const entries = await exportEntries()
    const service = JSON.parse(entries.get('service.json')!.body!.toString())
    assert.equal(serverDidOf(service), undefined)
    assert.equal(entries.has('provenance.jsonl'), false)
    assert.equal(entries.has('did.jsonl'), false)
    log = next
  })

  it('signs under the appended version when another reader verified it before the export judged its own read', async () => {
    const listed = await relisted({ prior: log, purpose: ['assertionMethod'] })
    await storeLog(listed)
    log = listed
    const next = await relisted({
      prior: log,
      purpose: ['assertionMethod', 'capabilityInvocation']
    })

    // The export's read of the log completes. Then the next version lands,
    // and `/service` verifies it and records its head, all before the export
    // judges its own read. That read no longer extends the recorded head,
    // which says nothing about the stored log.
    const spied = appendAfterFirstServerLogAccess({
      backend,
      append: async () => {
        await storeLog(next)
        assert.match((await advertisedServerDid())!, /^did:webvh:/)
      }
    })
    let entries: Awaited<ReturnType<typeof extractTarEntries>>
    try {
      entries = await exportEntries()
    } finally {
      spied.restore()
    }
    log = next

    // The export read again and took every output from the appended version.
    const service = JSON.parse(entries.get('service.json')!.body!.toString())
    const serverDid = serverDidOf(service)
    assert.match(serverDid!, /^did:webvh:/)
    assert.equal(
      entries.get('did.jsonl')?.body?.toString(),
      logToJsonlString(next)
    )
    const provenance = entries.get('provenance.jsonl')?.body?.toString()
    assert.ok(provenance, 'the archive carries provenance')
    for (const line of provenance.trim().split('\n')) {
      assert.equal(JSON.parse(line).didVersionId, next.at(-1)!.versionId)
    }
  })

  it('judges the log again under an unchanged ETag once the recorded outcome reaches the re-verify age', async () => {
    const serverDid = await advertisedServerDid()
    assert.match(serverDid!, /^did:webvh:/)

    // Rewritten out of band to a version that advertises no server DID. The
    // `ETag` stands, so `/service` keeps the outcome it recorded.
    const next = await relisted({ prior: log, purpose: ['authentication'] })
    await rewriteLogInPlace(next)
    log = next
    assert.equal(await advertisedServerDid(), serverDid)

    const now = performance.now.bind(performance)
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => now() + WEBVH_DOCUMENT_REVERIFY_AGE)
    try {
      assert.equal(await advertisedServerDid(), undefined)
    } finally {
      clock.mockRestore()
    }
  })
})
