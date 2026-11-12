/**
 * Unit tests for the ZCap verification wrapper (`src/zcap.ts`). These pin the
 * error-handling contract of `handleZcapVerify` -- the part the module owns and
 * that the `*-api` integration suites only exercise indirectly:
 *
 * - an invocation that does not verify -> `UnauthorizedError` (404), no logging
 *   (an expected client-side denial);
 * - verification that *errors* (here: a structurally invalid `serverUrl`, which
 *   throws inside `verifyZcap`) -> `AuthVerificationError` (400), with the
 *   underlying error preserved as `cause` and surfaced to the logger.
 *
 * The positive (verified=true) path -- for both root and delegated invocations
 * -- is covered end-to-end by the API integration suites and the conformance
 * suite, which drive real signed requests.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { handleZcapVerify, verifyZcap } from '../src/zcap.js'
import { AuthVerificationError, UnauthorizedError } from '../src/errors.js'

const serverUrl = 'http://localhost:9999'
const baseArgs = {
  url: '/space/s1',
  allowedTarget: `${serverUrl}/space/s1`,
  allowedAction: 'GET',
  method: 'GET',
  serverUrl,
  spaceController:
    'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' as const
}

/**
 * A logger stub that records whether `error()` was called. `debug()` is
 * recorded separately: a key-resolution failure is a client-caused condition
 * and logs there rather than at `error`.
 */
function recordingLogger() {
  const calls: unknown[][] = []
  const debugCalls: unknown[][] = []
  return {
    calls,
    debugCalls,
    error: (...args: unknown[]) => {
      calls.push(args)
    },
    debug: (...args: unknown[]) => {
      debugCalls.push(args)
    }
  }
}

describe('handleZcapVerify', () => {
  it('throws UnauthorizedError (404) when the invocation does not verify', async () => {
    const logger = recordingLogger()
    let thrown: any
    try {
      // No auth headers -> verifyCapabilityInvocation returns verified=false.
      await handleZcapVerify({
        ...baseArgs,
        headers: {},
        requestName: 'Read Space',
        logger,
        revocation: 'no-revocation-scope'
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof UnauthorizedError)
    assert.equal(thrown.statusCode, 404)
    // A failed-verification denial is expected client behavior -- not logged.
    assert.equal(logger.calls.length, 0)
  })

  it('wraps a verification error as AuthVerificationError (400), preserving cause and logging it', async () => {
    const logger = recordingLogger()
    let thrown: any
    try {
      // A malformed serverUrl makes `new URL(serverUrl)` throw inside
      // verifyZcap, which handleZcapVerify catches and wraps.
      await handleZcapVerify({
        ...baseArgs,
        serverUrl: 'not-a-valid-url',
        headers: {
          authorization: 'Signature keyId="did:key:z6MkExample#z6MkExample"',
          'capability-invocation': 'zcap id="urn:zcap:root:example"'
        },
        requestName: 'Read Space',
        logger,
        revocation: 'no-revocation-scope'
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof AuthVerificationError)
    assert.equal(thrown.statusCode, 400)
    assert.ok(thrown.cause instanceof Error)
    // The underlying fault is surfaced to the logger (once).
    assert.equal(logger.calls.length, 1)
  })
})

describe('verifyZcap', () => {
  it('returns verified=false for an unsigned request rather than throwing', async () => {
    const result = await verifyZcap({ ...baseArgs, headers: {} })
    assert.equal(result.verified, false)
  })
})
