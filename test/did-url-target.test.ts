/**
 * Unit tests for the invocation target dereferencer
 * (`createTargetDereferencer` in `src/lib/didUrlTarget.ts`), driven directly
 * against a `FileSystemBackend`, since no route reaches it yet.
 *
 * Each DID under test is a self-hosted `did:webvh` whose history log is
 * written straight to the backend, its document carrying `PathHandler`
 * services. A dereference maps a DID URL path through the longest matching
 * service to the URL it dereferences to, through the current document or the
 * version a selector pins.
 *
 * The memo is observed with the trick the resolution cache suite uses: once a
 * dereferencer has read a DID's document, the stored log is overwritten with
 * garbage behind the resolver's back and the cache entry is dropped. The same
 * dereferencer still maps a second target under that DID, while a fresh one
 * re-reads the log and refuses.
 *
 * The verification kept per verified log for a pinned version is observed by
 * object identity: a full verification builds a new document, so a pin that
 * reads back the same document object did not verify the log again.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import {
  createDID,
  logToJsonlString,
  updateDID
} from '@interop/did-method-webvh'
import type {
  DIDDoc,
  DIDLog,
  ServiceEndpoint,
  Signer
} from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { UnauthorizedError } from '../src/errors.js'
import {
  createTargetDereferencer,
  verifiedVersionOf
} from '../src/lib/didUrlTarget.js'
import type { TargetSelectors } from '../src/lib/didUrlTarget.js'
import { ServerBackends } from '../src/lib/serverBackends.js'
import {
  invalidateResolvedWebvhDid,
  resolveStoredWebvhLog,
  verifyWebvhLog
} from '../src/lib/webvhController.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { openTempBackend, pathHandler, webvhLogSigner } from './helpers.js'

/**
 * The base URL the DIDs under test are anchored at. No server listens on it:
 * resolution is a storage read, so the host only has to match the DID string.
 */
const serverUrl = 'http://localhost:9999'

describe('DID URL invocation target dereference', () => {
  let storage: TempFileSystemBackend,
    serverBackends: ServerBackends,
    spaceId: string,
    spaceUrl: string

  beforeAll(async () => {
    storage = await openTempBackend()
    serverBackends = new ServerBackends({ backends: [storage] })
    spaceId = randomUUID()
    spaceUrl = `${serverUrl}/space/${spaceId}/`
    await storage.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'
      }
    })
  })
  afterAll(async () => {
    await storage.close()
  })

  /**
   * Writes a history log straight to the backend as the `did.jsonl` of a
   * Collection, bypassing the request layer and its invalidation calls.
   *
   * @param options {object}
   * @param options.collectionId {string}
   * @param options.text {string}   the log, as JSON Lines
   * @returns {Promise<void>}
   */
  async function writeLog({
    collectionId,
    text
  }: {
    collectionId: string
    text: string
  }): Promise<void> {
    await storage.writeResource({
      spaceId,
      collectionId,
      resourceId: 'did.jsonl',
      input: {
        kind: 'binary',
        contentType: 'text/plain',
        stream: Readable.from([Buffer.from(text)])
      }
    })
  }

  /**
   * Mints a `did:webvh` anchored in a new Collection of the Space, with the
   * given services, and publishes its history log there.
   *
   * @param options {object}
   * @param options.services {ServiceEndpoint[]}
   * @returns {Promise<{ did: string, log: DIDLog, signer: Signer,
   *   collectionId: string }>}
   */
  async function publishDid({
    services
  }: {
    services: ServiceEndpoint[]
  }): Promise<{
    did: string
    log: DIDLog
    signer: Signer
    collectionId: string
  }> {
    const collectionId = `id-${randomUUID()}`
    const updateKeyPair = await Ed25519VerificationKey.generate()
    const signer = webvhLogSigner({ keyPair: updateKeyPair })
    const clientKeyPair = await Ed25519VerificationKey.generate()
    const created = await createDID({
      address: `${serverUrl}/space/${spaceId}/${collectionId}`,
      signer,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [
        {
          type: 'Multikey',
          publicKeyMultibase: clientKeyPair.publicKeyMultibase!,
          purpose: ['authentication', 'capabilityInvocation']
        }
      ],
      services
    })
    await storage.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: {
        id: collectionId,
        type: ['Collection'],
        name: collectionId
      }
    })
    await writeLog({ collectionId, text: logToJsonlString(created.log) })
    return { did: created.did, log: created.log, signer, collectionId }
  }

  /**
   * A dereferencer over the suite's backend.
   *
   * @param [options] {object}
   * @param [options.resolveNotHosted] {Function}
   * @returns {ReturnType<typeof createTargetDereferencer>}
   */
  function dereferencer({
    resolveNotHosted
  }: {
    resolveNotHosted?: (options: {
      did: string
      selectors: TargetSelectors
    }) => Promise<DIDDoc>
  } = {}): ReturnType<typeof createTargetDereferencer> {
    return createTargetDereferencer({
      storage,
      serverBackends,
      serverUrl,
      resolveNotHosted
    })
  }

  /**
   * Asserts that a dereference is refused as the masked `UnauthorizedError`,
   * for the reason `reason` matches.
   *
   * @param options {object}
   * @param options.target {string}
   * @param options.reason {RegExp}   matched against the refusal's cause
   * @returns {Promise<void>}
   */
  async function assertRefused({
    target,
    reason
  }: {
    target: string
    reason: RegExp
  }): Promise<void> {
    await assert.rejects(dereferencer().dereference({ target }), err => {
      assert.ok(err instanceof UnauthorizedError)
      assert.equal(err.statusCode, 404)
      assert.match((err.cause as Error).message, reason)
      return true
    })
  }

  describe('path handlers', () => {
    let did: string

    beforeAll(async () => {
      ;({ did } = await publishDid({
        services: [
          pathHandler({ id: '#space', path: '/', serviceEndpoint: spaceUrl }),
          pathHandler({
            id: '#pics',
            path: '/pics',
            serviceEndpoint: `${spaceUrl}photos/`
          })
        ]
      }))
    })

    it('maps a path through the / handler', async () => {
      const { dereference } = dereferencer()
      assert.equal(await dereference({ target: `${did}/` }), spaceUrl)
      assert.equal(
        await dereference({ target: `${did}/photos/cat.jpg` }),
        `${spaceUrl}photos/cat.jpg`
      )
    })

    it('maps an alias through the longest matching handler', async () => {
      const { dereference } = dereferencer()
      assert.equal(
        await dereference({ target: `${did}/pics/cat.jpg` }),
        `${spaceUrl}photos/cat.jpg`
      )
      assert.equal(
        await dereference({ target: `${did}/pics` }),
        `${spaceUrl}photos/`
      )
      // `/picsx` is not beneath `/pics`, so the `/` handler maps it.
      assert.equal(
        await dereference({ target: `${did}/picsx` }),
        `${spaceUrl}picsx`
      )
    })

    it('refuses a target with a fragment', async () => {
      await assertRefused({
        target: `${did}/photos/#key`,
        reason: /carries a fragment/
      })
      await assertRefused({
        target: `${did}/photos/#`,
        reason: /carries a fragment/
      })
    })

    it('refuses a target with no path', async () => {
      await assertRefused({ target: did, reason: /no path/ })
    })

    it('refuses an unsupported DID parameter', async () => {
      await assertRefused({
        target: `${did}/photos/?service=files`,
        reason: /Unsupported DID parameter/
      })
    })
  })

  it('refuses a path no handler matches', async () => {
    const { did } = await publishDid({
      services: [
        pathHandler({
          id: '#docs',
          path: '/docs',
          serviceEndpoint: `${spaceUrl}docs/`
        })
      ]
    })
    assert.equal(
      await dereferencer().dereference({ target: `${did}/docs/a.pdf` }),
      `${spaceUrl}docs/a.pdf`
    )
    await assertRefused({
      target: `${did}/photos/cat.jpg`,
      reason: /No PathHandler service/
    })
  })

  describe('version selectors', () => {
    let did: string, firstVersionId: string

    beforeAll(async () => {
      const published = await publishDid({
        services: [
          pathHandler({
            id: '#space',
            path: '/',
            serviceEndpoint: `${spaceUrl}old/`
          })
        ]
      })
      did = published.did
      firstVersionId = published.log[0]!.versionId
      const updated = await updateDID({
        log: published.log,
        signer: published.signer,
        services: [
          pathHandler({
            id: '#space',
            path: '/',
            serviceEndpoint: `${spaceUrl}new/`
          })
        ]
      })
      await writeLog({
        collectionId: published.collectionId,
        text: logToJsonlString(updated.log)
      })
      invalidateResolvedWebvhDid({
        storage,
        spaceId,
        collectionId: published.collectionId
      })
    })

    it('maps an unpinned target through the current document', async () => {
      assert.equal(
        await dereferencer().dereference({ target: `${did}/cat.jpg` }),
        `${spaceUrl}new/cat.jpg`
      )
    })

    it('maps a pinned target through the version it names', async () => {
      const { dereference } = dereferencer()
      assert.equal(
        await dereference({
          target: `${did}/cat.jpg?versionId=${encodeURIComponent(firstVersionId)}`
        }),
        `${spaceUrl}old/cat.jpg`
      )
      assert.equal(
        await dereference({ target: `${did}/cat.jpg?versionNumber=1` }),
        `${spaceUrl}old/cat.jpg`
      )
      assert.equal(
        await dereference({ target: `${did}/cat.jpg?versionNumber=2` }),
        `${spaceUrl}new/cat.jpg`
      )
    })

    it('refuses a pin that names no version of the log', async () => {
      await assertRefused({
        target: `${did}/cat.jpg?versionNumber=3`,
        reason: /Could not verify the history log/
      })
    })
  })

  describe('pinned version verification', () => {
    /**
     * The verified current log of a DID, as the resolver's cache holds it.
     *
     * @param options {object}
     * @param options.did {string}
     * @returns {Promise<DIDLog>}
     */
    async function storedLog({ did }: { did: string }): Promise<DIDLog> {
      const stored = await resolveStoredWebvhLog({
        storage,
        serverBackends,
        serverUrl,
        did
      })
      assert.ok(stored)
      return stored.log
    }

    it('verifies a pin once per verified log, and again after an append', async () => {
      const published = await publishDid({
        services: [
          pathHandler({
            id: '#space',
            path: '/',
            serviceEndpoint: `${spaceUrl}old/`
          })
        ]
      })
      const { did, collectionId } = published
      const selectors = { versionNumber: 1 }
      const firstLog = await storedLog({ did })
      // A second request within the cache TTL reads the same verified log.
      const secondLog = await storedLog({ did })
      assert.strictEqual(secondLog, firstLog)
      const pinned = await verifiedVersionOf({ did, log: firstLog, selectors })
      const again = await verifiedVersionOf({ did, log: secondLog, selectors })
      assert.strictEqual(again.doc, pinned.doc)
      // A full verification of the same log builds a new, equal document.
      const fresh = await verifyWebvhLog({ did, log: firstLog, selectors })
      assert.notStrictEqual(fresh.doc, pinned.doc)
      assert.deepEqual(fresh.doc, pinned.doc)

      const updated = await updateDID({
        log: published.log,
        signer: published.signer,
        services: [
          pathHandler({
            id: '#space',
            path: '/',
            serviceEndpoint: `${spaceUrl}new/`
          })
        ]
      })
      await writeLog({ collectionId, text: logToJsonlString(updated.log) })
      invalidateResolvedWebvhDid({ storage, spaceId, collectionId })
      const appendedLog = await storedLog({ did })
      assert.notStrictEqual(appendedLog, firstLog)
      const afterAppend = await verifiedVersionOf({
        did,
        log: appendedLog,
        selectors
      })
      assert.notStrictEqual(afterAppend.doc, pinned.doc)
      assert.deepEqual(afterAppend.doc, pinned.doc)
      const second = await verifiedVersionOf({
        did,
        log: appendedLog,
        selectors: { versionNumber: 2 }
      })
      assert.equal(second.doc.service?.[0]?.serviceEndpoint, `${spaceUrl}new/`)
    })

    it('keeps a pin that names no version, once per log', async () => {
      const { did } = await publishDid({
        services: [
          pathHandler({ id: '#space', path: '/', serviceEndpoint: spaceUrl })
        ]
      })
      const log = await storedLog({ did })
      const selectors = { versionNumber: 3 }
      const refusals = await Promise.all(
        [0, 1].map(() =>
          verifiedVersionOf({ did, log, selectors }).then(
            () => assert.fail('the pin names no version'),
            (err: unknown) => err
          )
        )
      )
      assert.match((refusals[0] as Error).message, /Could not verify/)
      assert.strictEqual(refusals[1], refusals[0])
    })

    it('keeps a bounded number of selector sets per log', async () => {
      const { did } = await publishDid({
        services: [
          pathHandler({ id: '#space', path: '/', serviceEndpoint: spaceUrl })
        ]
      })
      const log = await storedLog({ did })
      // Distinct times at or after the only entry, each naming version 1.
      const created = Date.parse(log[0]!.versionTime)
      const at = (offset: number): TargetSelectors => ({
        versionTime: new Date(created + offset)
      })
      const first = await verifiedVersionOf({ did, log, selectors: at(0) })
      assert.strictEqual(
        (await verifiedVersionOf({ did, log, selectors: at(0) })).doc,
        first.doc
      )
      for (let offset = 1; offset <= 8; offset++) {
        await verifiedVersionOf({ did, log, selectors: at(offset) })
      }
      const evicted = await verifiedVersionOf({ did, log, selectors: at(0) })
      assert.notStrictEqual(evicted.doc, first.doc)
      assert.deepEqual(evicted.doc, first.doc)
    })
  })

  it('refuses a did: target that is not a did:webvh', async () => {
    await assertRefused({
      target: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD/x',
      reason: /not a did:webvh DID URL/
    })
  })

  it('returns a target that is not a did: URL unchanged', async () => {
    const target = 'https://example.com/space/abc/photos/?q=1#frag'
    assert.equal(await dereferencer().dereference({ target }), target)
  })

  describe('a DID this server stores no log for', () => {
    let foreignDid: string

    beforeAll(async () => {
      const { did } = await publishDid({
        services: [
          pathHandler({ id: '#space', path: '/', serviceEndpoint: spaceUrl })
        ]
      })
      // The same SCID on another host: a DID no log here belongs to.
      const scid = did.split(':')[2]
      foreignDid = `did:webvh:${scid}:example.com:space:${spaceId}:id`
    })

    it('is refused', async () => {
      await assertRefused({
        target: `${foreignDid}/photos/`,
        reason: /whose history log this server stores/
      })
    })

    it('is handed to the resolver for DIDs not hosted here, once', async () => {
      const calls: Array<{ did: string; selectors: TargetSelectors }> = []
      const { dereference } = dereferencer({
        resolveNotHosted: async options => {
          calls.push(options)
          return {
            id: options.did,
            service: [
              pathHandler({
                id: `${options.did}#space`,
                path: '/',
                serviceEndpoint: 'https://example.com/space/remote/'
              })
            ]
          } as DIDDoc
        }
      })
      assert.equal(
        await dereference({ target: `${foreignDid}/photos/` }),
        'https://example.com/space/remote/photos/'
      )
      assert.equal(
        await dereference({ target: `${foreignDid}/docs/a.pdf` }),
        'https://example.com/space/remote/docs/a.pdf'
      )
      await dereference({ target: `${foreignDid}/x?versionNumber=1` })
      assert.deepEqual(calls, [
        { did: foreignDid, selectors: {} },
        { did: foreignDid, selectors: { versionNumber: 1 } }
      ])
    })
  })

  it('reads one document per DID for every target it dereferences', async () => {
    const { did, collectionId } = await publishDid({
      services: [
        pathHandler({ id: '#space', path: '/', serviceEndpoint: spaceUrl })
      ]
    })
    const { dereference } = dereferencer()
    assert.equal(
      await dereference({ target: `${did}/photos/` }),
      `${spaceUrl}photos/`
    )
    // Behind the resolver's back: a fresh read of the log now fails.
    await writeLog({ collectionId, text: 'not a history log' })
    invalidateResolvedWebvhDid({ storage, spaceId, collectionId })
    assert.equal(
      await dereference({ target: `${did}/docs/a.pdf` }),
      `${spaceUrl}docs/a.pdf`
    )
    await assertRefused({
      target: `${did}/docs/a.pdf`,
      reason: /not valid JSON Lines/
    })
  })
})
