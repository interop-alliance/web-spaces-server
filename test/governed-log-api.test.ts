/**
 * Governing history log API tests (the `governed-history-logs` feature): the
 * `/space/:spaceId/:collectionId/meta/log` sub-resource, whose head entry's
 * `state` the server serves as the Collection's `encryption` descriptor.
 * Covers the declaration by guarded create, the derived member (head `state`
 * plus `history`), the compare-and-swap append, and the refusals: a direct
 * `encryption` write on a governed Collection, a line-contract break, an
 * epoch-transition violation, and governing a Collection that already carries
 * a client-written descriptor.
 */
import { it, describe, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import {
  assertEncryptedCollectionsFeature,
  assertEtagAdvanced,
  entryLine,
  genesisLine,
  oneEpoch,
  parseEtagSegments,
  openTempBackend,
  recipient,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

/** A minimal structurally-valid EDV Encrypted Document envelope. */
const envelope = {
  id: 'z1',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

const twoEpochs = {
  ...oneEpoch,
  currentEpoch: 'urn:epoch:2',
  epochs: [
    { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp2#ka')] },
    ...oneEpoch.epochs
  ]
}

describe('Governing history log API (meta/log)', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    aliceDelegatedApp: any
  const spaceId = `governed-log-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    // A small per-upload cap, so the oversize-log refusal is cheap to hit.
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend({ maxUploadBytes: 64 * 1024 })
    }))
    ;({ alice, aliceDelegatedApp } = await zcapClients({ baseServerUrl }))
    await alice.pws.createSpace({
      id: spaceId,
      name: 'Governed Log Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  // The canonical (trailing-slash) container URL of a Collection.
  const collectionUrl = (collectionId: string) =>
    `${baseServerUrl}space/${spaceId}/${collectionId}/`
  // The Collection Metadata object's URL.
  const metaUrl = (collectionId: string) => `${collectionUrl(collectionId)}meta`
  const logUrl = (collectionId: string) => `${metaUrl(collectionId)}/log`

  /** Creates a fresh plaintext-by-default Collection and returns its id. */
  async function freshCollection(body: object = {}): Promise<string> {
    const collectionId = `col-${crypto.randomUUID()}`
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId, ...body }
    })
    return collectionId
  }

  /**
   * PUTs a log body under the given preconditions. Resolves the status and
   * `ETag` of a success, or the status and parsed problem document of a
   * rejection (the client has already consumed the body by then).
   */
  async function putLog({
    collectionId,
    body,
    headers = {}
  }: {
    collectionId: string
    body: string
    headers?: Record<string, string>
  }): Promise<{ status: number; etag: string | null; problem?: any }> {
    try {
      const response = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'PUT',
        body: new TextEncoder().encode(body),
        headers: { 'content-type': 'text/jsonl', ...headers }
      })
      return { status: response.status, etag: response.headers.get('etag') }
    } catch (err: any) {
      if (!err.response) {
        throw err
      }
      return { status: err.response.status, etag: null, problem: err.data }
    }
  }

  /** The text body of a log read (not pre-parsed: JSON Lines is not JSON). */
  async function logText(response: any): Promise<string> {
    return response.data ?? (await response.text())
  }

  /** Captures the raw error from a `pws.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /** Governs a fresh Collection with a one-epoch genesis; returns id + ETag. */
  async function governedCollection(): Promise<{
    collectionId: string
    body: string
    etag: string
  }> {
    const collectionId = await freshCollection()
    const body = genesisLine(oneEpoch) + '\n'
    const created = await putLog({
      collectionId,
      body,
      headers: { 'if-none-match': '*' }
    })
    assert.equal(created.status, 204)
    return { collectionId, body, etag: created.etag! }
  }

  describe('declaration and derivation', () => {
    it('[signed] a guarded create governs the Collection: encryption is derived from the head state with history stamped on', async () => {
      const { collectionId, etag } = await governedCollection()
      parseEtagSegments(etag)

      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.deepEqual(described.data.encryption, {
        ...oneEpoch,
        history: { method: 'resource-log:0.1', resource: logUrl(collectionId) }
      })
    })

    it('[signed] the log reads back verbatim as text/jsonl with its ETag, and 304s on If-None-Match', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.status, 200)
      assert.match(read.headers.get('content-type')!, /^text\/jsonl/)
      assert.equal(read.headers.get('etag'), etag)
      assert.equal(await logText(read), body)

      const conditional = await responseOf(
        alice.pws.request({
          url: logUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(conditional.status, 304)
      assert.equal(conditional.headers.get('etag'), etag)
    })

    it('[signed] a Collection with no log 404s on the log read', async () => {
      const collectionId = await freshCollection()
      const err = await rejection(
        alice.pws.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
    })

    it('[signed] a log write on a nonexistent Collection is a 404, never a create', async () => {
      const response = await putLog({
        collectionId: `absent-${crypto.randomUUID()}`,
        body: genesisLine(oneEpoch) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 404)
    })

    it('[delegated] a capability on the Collection URL covers the log read', async () => {
      const { collectionId, body } = await governedCollection()
      // Rooted at the Space: a bare `pws.grant({ target })` roots at the
      // target's own root capability, which this server refuses.
      const zcap = await alice.pws.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET'],
        target: collectionUrl(collectionId),
        spaceUrl: `${baseServerUrl}space/${spaceId}/`
      })
      const read = await aliceDelegatedApp.pws.request({
        url: logUrl(collectionId),
        method: 'GET',
        capability: zcap
      })
      assert.equal(read.status, 200)
      assert.equal(await logText(read), body)
    })
  })

  describe('append (compare-and-swap)', () => {
    it('[signed] an If-Match append carrying the prior bytes lands, bumps the log ETag, and moves the derived member to the new head', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const appended = await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      assert.equal(appended.status, 204)
      assertEtagAdvanced({ before: etag, after: appended.etag })

      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.encryption.currentEpoch, 'urn:epoch:2')
      assert.equal(described.data.encryption.epochs.length, 2)
    })

    it('[signed] a log write is visible to the very next Metadata read and write', async () => {
      const collectionId = await freshCollection()
      // The Metadata object is read before the Collection is governed, so
      // whatever the server memoizes about it is warm.
      const ungoverned = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(ungoverned.data.encryption, undefined)

      const body = genesisLine(oneEpoch) + '\n'
      const created = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 204)
      // The next read serves the derived member...
      const governed = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(governed.data.encryption.currentEpoch, 'urn:epoch:1')
      // ...and the next write is already refused as governed.
      const direct = await rejection(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { encryption: oneEpoch }
        })
      )
      assert.equal(direct.response.status, 409)
      assert.match(direct.data.type, /#encryption-history-log-governed$/)

      const appended = await putLog({
        collectionId,
        body: body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n',
        headers: { 'if-match': created.etag! }
      })
      assert.equal(appended.status, 204)
      // The read right after the append serves the new head, under a moved
      // Metadata ETag.
      const moved = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(moved.data.encryption.currentEpoch, 'urn:epoch:2')
      assert.notEqual(moved.headers.get('etag'), governed.headers.get('etag'))
      // A Metadata write right after it lands against the new head, and the
      // stored object still carries no descriptor of its own: the read after
      // the write derives the same head again.
      const annotated = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: envelope }
      })
      assert.equal(annotated.status, 204)
      const after = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(after.data.encryption.currentEpoch, 'urn:epoch:2')
      assert.equal(after.data.encryption.epochs.length, 2)
      assert.deepStrictEqual(after.data.custom, envelope)
    })

    it('[signed] a stale If-Match is a 412 and the log is unchanged', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const first = await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      const lost = await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      assert.equal(lost.status, 412)
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), first.etag)
    })

    it('[signed] a body the stored log is not a prefix of is a 412 even under a current If-Match, and the log is unchanged', async () => {
      const { collectionId, etag } = await governedCollection()
      // A rewritten genesis (different versionId) under the current ETag.
      const rewritten =
        entryLine({
          ordinal: 9,
          state: oneEpoch,
          parameters: { method: 'resource-log:0.1', scid: 'zScid' }
        }) +
        '\n' +
        entryLine({ ordinal: 2, state: twoEpochs }) +
        '\n'
      const refused = await putLog({
        collectionId,
        body: rewritten,
        headers: { 'if-match': etag }
      })
      assert.equal(refused.status, 412)
      assert.match(refused.problem.type, /#precondition-failed$/)
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), etag)
    })

    it('[signed] an append of several lines is 400 invalid-request-body', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const refused = await putLog({
        collectionId,
        body:
          body +
          entryLine({ ordinal: 2, state: twoEpochs }) +
          '\n' +
          entryLine({ ordinal: 3, state: twoEpochs }) +
          '\n',
        headers: { 'if-match': etag }
      })
      assert.equal(refused.status, 400)
      assert.match(refused.problem.type, /#invalid-request-body$/)
    })

    it('[signed] an appended entry whose state carries history is 400 invalid-request-body', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const refused = await putLog({
        collectionId,
        body:
          body +
          entryLine({
            ordinal: 2,
            state: { ...twoEpochs, history: { method: 'resource-log:0.1' } }
          }) +
          '\n',
        headers: { 'if-match': etag }
      })
      assert.equal(refused.status, 400)
      assert.match(refused.problem.type, /#invalid-request-body$/)
    })

    it('[signed] re-sending the stored log is a 204 no-op: the ETag is unchanged', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const metaBefore = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      const variants: Record<string, string>[] = [{ 'if-match': etag }, {}]
      for (const headers of variants) {
        const resent = await putLog({ collectionId, body, headers })
        assert.equal(resent.status, 204)
        assert.equal(resent.etag, etag)
      }
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), etag)
      assert.equal(await logText(read), body)
      // Nothing was written, so the Collection Metadata object did not move.
      const metaAfter = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(
        metaAfter.headers.get('etag'),
        metaBefore.headers.get('etag')
      )
    })

    it('[signed] re-sending the stored log still honors its preconditions', async () => {
      const { collectionId, body } = await governedCollection()
      const stale = await putLog({
        collectionId,
        body,
        headers: { 'if-match': '"stale.9"' }
      })
      assert.equal(stale.status, 412)
      assert.match(stale.problem.type, /#precondition-failed$/)
    })

    it('[signed] a strict prefix of the stored log is a 412 and the log is unchanged', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const appended = await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      assert.equal(appended.status, 204)
      const erased = await putLog({
        collectionId,
        body,
        headers: { 'if-match': appended.etag! }
      })
      assert.equal(erased.status, 412)
      assert.match(erased.problem.type, /#precondition-failed$/)
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(await logText(read), extended)
    })

    it('[signed] a write carrying no precondition is bound by the body: a fast-forward lands, a stale body is a 412', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const landed = await putLog({ collectionId, body: extended })
      assert.equal(landed.status, 204)
      assertEtagAdvanced({ before: etag, after: landed.etag })
      // A lost race: a second line built on the genesis alone, after the
      // append above moved the head, so the stored log is not its prefix.
      const stale = await putLog({
        collectionId,
        body: body + entryLine({ ordinal: 2, state: oneEpoch }) + '\n'
      })
      assert.equal(stale.status, 412)
      assert.match(stale.problem.type, /#precondition-failed$/)
    })

    it('[signed] a guarded create on an existing log is a 412', async () => {
      const { collectionId, body } = await governedCollection()
      const raced = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(raced.status, 412)
    })

    it('[signed] a log write bumps the Collection Metadata ETag', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const before = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      const after = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.notEqual(after.headers.get('etag'), before.headers.get('etag'))
      // The append advanced the local segment alone: the Metadata object's
      // generation and stamp are untouched.
      const beforeSegments = parseEtagSegments(before.headers.get('etag'), {
        container: true
      })
      const afterSegments = parseEtagSegments(after.headers.get('etag'), {
        container: true
      })
      assert.equal(afterSegments.local, beforeSegments.local! + 1)
      assert.equal(afterSegments.generation, beforeSegments.generation)
      assert.deepEqual(afterSegments.stamp, beforeSegments.stamp)
      // A conditional read against the stale Collection Metadata ETag is a 200.
      const conditional = await responseOf(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': before.headers.get('etag')! }
        })
      )
      assert.equal(conditional.status, 200)
    })

    it('[signed] a Collection Metadata read racing a log append never pairs the new ETag with the old descriptors', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const storage = fastify.storage
      // Cache the old head's descriptors, as a Collection in use has them.
      // The racing read then takes its descriptors from the validator it
      // read, with no second log read.
      await alice.pws.request({ url: metaUrl(collectionId), method: 'GET' })
      const readMetadata = storage.getCollectionMetadata.bind(storage)
      const readLog = storage.getCollectionLog.bind(storage)
      // The racing read's log read lands an append right after it read the
      // old log. A Metadata read that runs beside the log read waits for
      // that append, so it would see the advanced local segment. A Metadata
      // read that completed before the log read began does not wait.
      let armed = true
      let logReadStarted = false
      let appending = false
      let appended!: () => void
      const appendDone = new Promise<void>(resolve => {
        appended = resolve
      })
      const logSpy = vi
        .spyOn(storage, 'getCollectionLog')
        .mockImplementation(async options => {
          if (!armed || options.collectionId !== collectionId) {
            return readLog(options)
          }
          armed = false
          logReadStarted = true
          const prior = await readLog(options)
          appending = true
          await storage.writeCollectionLog({
            spaceId,
            collectionId,
            body: extended,
            ifMatch: etag
          })
          appending = false
          appended()
          return prior
        })
      const metadataSpy = vi
        .spyOn(storage, 'getCollectionMetadata')
        .mockImplementation(async options => {
          if (options.collectionId === collectionId && !appending) {
            await new Promise(resolve => setImmediate(resolve))
            if (logReadStarted && !appending) {
              await appendDone
            }
          }
          return readMetadata(options)
        })
      let raced: any
      try {
        raced = await alice.pws.request({
          url: metaUrl(collectionId),
          method: 'GET'
        })
      } finally {
        logSpy.mockRestore()
        metadataSpy.mockRestore()
      }
      assert.equal(armed, false, 'the log read landed the append')
      // The racing read served the descriptors of the old head under the old
      // ETag, so revalidating that ETag now is a 200 with the new head.
      assert.equal(raced.data.encryption.currentEpoch, 'urn:epoch:1')
      const conditional = await responseOf(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': raced.headers.get('etag')! }
        })
      )
      assert.equal(conditional.status, 200)
      assert.notEqual(
        conditional.headers.get('etag'),
        raced.headers.get('etag')
      )
      assert.equal(
        (conditional as any).data.encryption.currentEpoch,
        'urn:epoch:2'
      )
    })
  })

  describe('refusals', () => {
    it('[signed] a direct encryption write on a governed Collection is 409 encryption-history-log-governed', async () => {
      const { collectionId } = await governedCollection()
      const err = await rejection(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { id: collectionId, encryption: twoEpochs }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#encryption-history-log-governed$/)
      // The descriptor is unchanged.
      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.encryption.currentEpoch, 'urn:epoch:1')
    })

    it('[signed] a Collection Metadata update without encryption still lands on a governed Collection', async () => {
      const { collectionId } = await governedCollection()
      const response = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { id: collectionId, name: 'Renamed' }
      })
      assert.equal(response.status, 204)
      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.name, 'Renamed')
      assert.equal(described.data.encryption.scheme, 'edv')
    })

    it('[signed] a plaintext member on a governed Collection is refused like on any encrypted one', async () => {
      const { collectionId } = await governedCollection()
      const err = await rejection(
        alice.pws.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { id: collectionId, plaintext: {} }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('[signed] a line-contract break is 400 invalid-request-body', async () => {
      const collectionId = await freshCollection()
      for (const body of [
        '',
        'not json\n',
        JSON.stringify({ versionId: '1-x', parameters: {} }) + '\n',
        // A genesis without a string `parameters.method`.
        entryLine({ ordinal: 1, state: oneEpoch }) + '\n',
        entryLine({
          ordinal: 1,
          state: oneEpoch,
          parameters: { method: 7 }
        }) + '\n',
        // A `state` carrying the `history` member the server stamps.
        genesisLine({
          ...oneEpoch,
          history: { method: 'resource-log:0.1', resource: 'urn:x' }
        }) + '\n',
        genesisLine(oneEpoch) +
          '\n\n' +
          entryLine({ ordinal: 2, state: oneEpoch })
      ]) {
        const response = await putLog({
          collectionId,
          body,
          headers: { 'if-none-match': '*' }
        })
        assert.equal(response.status, 400, `body ${JSON.stringify(body)}`)
        assert.match(response.problem.type, /#invalid-request-body$/)
      }
      // None of them declared the Collection governed.
      const err = await rejection(
        alice.pws.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
    })

    it('[signed] a log body over the upload cap is 413 payload-too-large', async () => {
      const collectionId = await freshCollection()
      // Pad the genesis line past the backend's `maxUploadBytes`.
      const body =
        entryLine({
          ordinal: 1,
          state: oneEpoch,
          parameters: { method: 'resource-log:0.1', pad: 'x'.repeat(64 * 1024) }
        }) + '\n'
      const response = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 413)
      assert.match(response.problem.type, /#payload-too-large$/)
    })

    it('[signed] a head state that is not a supported descriptor is refused as a Collection Metadata write would be', async () => {
      const collectionId = await freshCollection()
      const response = await putLog({
        collectionId,
        body: genesisLine({ type: 'Other', scheme: 'unknown' }) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 400)
      assert.match(response.problem.type, /#unsupported-encryption-scheme$/)
    })

    it('[signed] an epoch-transition violation on append is refused as a Collection Metadata PUT refuses it', async () => {
      const collectionId = await freshCollection()
      const body = genesisLine(twoEpochs) + '\n'
      const created = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 204)
      // Dropping an epoch, and moving `currentEpoch` back, are both refused.
      const rolledBack =
        body + entryLine({ ordinal: 2, state: oneEpoch }) + '\n'
      const response = await putLog({
        collectionId,
        body: rolledBack,
        headers: { 'if-match': created.etag! }
      })
      // Dropping an epoch is the Collection Metadata PUT's 400 append-only
      // refusal.
      assert.equal(response.status, 400)
      assert.match(response.problem.type, /#invalid-request-body$/)
      assert.match(response.problem.errors[0].pointer, /epochs/)
      // The log is unchanged.
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), created.etag)
    })

    it('[signed] governing a Collection that already carries a client-written descriptor is 409 encryption-immutable', async () => {
      const collectionId = await freshCollection({
        encryption: { scheme: 'edv' }
      })
      const response = await putLog({
        collectionId,
        body: genesisLine(oneEpoch) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 409)
      assert.match(response.problem.type, /#encryption-immutable$/)
      const err = await rejection(
        alice.pws.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
    })

    it('[signed] governing a Collection that declares plaintext is 409 encryption-immutable, and the Collection stays writable', async () => {
      const collectionId = await freshCollection({
        plaintext: { indexes: ['kind'] }
      })
      const response = await putLog({
        collectionId,
        body: genesisLine(oneEpoch) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 409)
      assert.match(response.problem.type, /#encryption-immutable$/)
      assert.equal(response.problem.errors[0].pointer, '#/plaintext')
      const err = await rejection(
        alice.pws.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
      // The exclusion rule never engages: a later rename still lands.
      const renamed = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {
          id: collectionId,
          name: 'Renamed plaintext',
          plaintext: { indexes: ['kind'] }
        }
      })
      assert.equal(renamed.status, 204)
      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.name, 'Renamed plaintext')
      assert.deepEqual(described.data.plaintext, { indexes: ['kind'] })
    })
  })

  describe('a sub-resource, not a Resource', () => {
    it('[signed] the log is absent from the listing, is no Resource on the changes feed, and the envelope rule applies to Resources but not to it', async () => {
      const { collectionId } = await governedCollection()

      // The governed Collection is encrypted: a plaintext Resource write is
      // refused by the envelope rule, a conforming envelope lands...
      const plain = await rejection(
        alice.pws.request({
          url: collectionUrl(collectionId),
          method: 'POST',
          json: { hello: 'world' }
        })
      )
      assert.equal(plain.response.status, 422)
      const created = await alice.pws.request({
        url: collectionUrl(collectionId),
        method: 'POST',
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        headers: { 'content-type': 'application/json' }
      })
      assert.equal(created.status, 201)
      // ...while the log itself (JSON Lines, no envelope) is exempt: the
      // create above already succeeded on this Collection.

      const listing = await alice.pws.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      const ids = listing.data.items.map((item: any) => item.id)
      assert.equal(ids.length, 1)
      assert.ok(!ids.some((id: string) => /log|meta/.test(id)))

      const feed = await alice.pws.request({
        url: `${collectionUrl(collectionId)}query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      // The log rides the feed as a `log` document at its own URL, never as a
      // `resource` one.
      assert.deepEqual(
        feed.data.documents.map((doc: any) => doc.kind),
        ['collection-metadata', 'log', 'resource']
      )
      assert.equal(feed.data.documents[1].id, logUrl(collectionId))
      assert.equal(feed.data.documents[2].id, created.data.id)
    })

    it('[signed] a PUT /meta does not touch the log', async () => {
      const { collectionId, etag } = await governedCollection()
      const meta = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: envelope }
      })
      assert.equal(meta.status, 204)
      const read = await alice.pws.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), etag)
    })

    it('[signed] a scheme change on append is 409 encryption-immutable', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const response = await putLog({
        collectionId,
        body:
          body +
          entryLine({
            ordinal: 2,
            state: { ...oneEpoch, scheme: 'edv', version: 0 }
          }) +
          '\n',
        headers: { 'if-match': etag }
      })
      assert.equal(response.status, 400)
    })

    it('[signed] deleting the Collection takes the log with it', async () => {
      const { collectionId, body } = await governedCollection()
      await alice.pws.request({
        url: collectionUrl(collectionId),
        method: 'DELETE'
      })
      // Re-created under the same id, the Collection is not governed.
      await alice.pws.request({
        url: `${baseServerUrl}space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: collectionId }
      })
      const described = await alice.pws.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.encryption, undefined)
      const recreated = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(recreated.status, 204)
    })
  })

  it('advertises governed-history-logs in the Encrypted Collections entry', async () => {
    await assertEncryptedCollectionsFeature({
      baseServerUrl,
      feature: 'governed-history-logs'
    })
  })
})
