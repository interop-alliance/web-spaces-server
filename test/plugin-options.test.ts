/**
 * The `fastifyWas` composition options: `ownsBackend` (whether the plugin
 * wires the backend's logger and `close()`), `cors` (skip or
 * customize the `@fastify/cors` registration), and a `baseServerUrl` carrying a
 * trailing slash, which must not double the slash in the URLs the server
 * builds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

/**
 * A FileSystemBackend that counts the `close()` calls made on it.
 */
class LifecycleSpyBackend extends FileSystemBackend {
  closeCalls = 0

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

/**
 * A backend whose origin id was never settled, as one that skipped its async
 * factory would be.
 */
class UnsettledBackend extends LifecycleSpyBackend {
  get originId(): string {
    return ''
  }
}

/**
 * A backend written before capability caveats, which enforces none.
 */
class NoCaveatBackend extends LifecycleSpyBackend {
  readonly enforcedCaveats: string[] = []
}

let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'was-plugin-options-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/**
 * A silent app over its own sub-directory of the suite's data dir, with the
 * options under test layered on.
 *
 * @param name {string}   the sub-directory name
 * @param [options] {object}   further `createApp()` options
 * @returns {Promise<FastifyInstance>}
 */
async function testApp(
  name: string,
  options: Partial<Parameters<typeof createApp>[0]> = {}
): Promise<FastifyInstance> {
  return createApp({
    serverUrl: 'http://localhost',
    backend: await FileSystemBackend.open({
      dataDir: path.join(dataDir, name)
    }),
    logger: false,
    ...options
  })
}

describe('ownsBackend option', () => {
  it('manages the backend lifecycle by default', async () => {
    const backend = await LifecycleSpyBackend.open({
      dataDir: path.join(dataDir, 'owned')
    })
    const app = await testApp('owned', { backend })
    await app.ready()
    expect(backend.logger).toBe(app.log)
    await app.close()
    expect(backend.closeCalls).toBe(1)
  })

  it('ownsBackend: false leaves close and the logger to the composition', async () => {
    const backend = await LifecycleSpyBackend.open({
      dataDir: path.join(dataDir, 'composed')
    })
    const ownLogger = backend.logger
    const app = await testApp('composed', { backend, ownsBackend: false })
    await app.ready()
    expect(backend.logger).toBe(ownLogger)
    expect(backend.logger).not.toBe(app.log)
    await app.close()
    expect(backend.closeCalls).toBe(0)
  })

  it('ownsBackend: false without a backend is refused at registration', async () => {
    const app = createApp({
      serverUrl: 'http://localhost',
      dataDir: path.join(dataDir, 'unowned-default'),
      ownsBackend: false,
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'ownsBackend: false requires an injected, already open backend option.'
    )
  })

  it('ownsBackend: false with a backend function is refused, and opens nothing', async () => {
    let opened = false
    const app = createApp({
      serverUrl: 'http://localhost',
      backend: async () => {
        opened = true
        return FileSystemBackend.open({
          dataDir: path.join(dataDir, 'unowned-function')
        })
      },
      ownsBackend: false,
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'ownsBackend: false requires an injected, already open backend option.'
    )
    expect(opened).toBe(false)
  })
})

describe('backend option as a function', () => {
  it('is opened with the app logger and closed with the app', async () => {
    let backend: LifecycleSpyBackend | undefined
    const app = createApp({
      serverUrl: 'http://localhost',
      backend: async ({ logger }) => {
        backend = await LifecycleSpyBackend.open({
          dataDir: path.join(dataDir, 'function'),
          logger
        })
        return backend
      },
      logger: false
    })
    await app.ready()
    expect(backend?.logger).toBe(app.log)
    expect(app.storage.describe()).toEqual(backend!.describe())
    await app.close()
    expect(backend?.closeCalls).toBe(1)
  })

  it('is not called when another option is refused', async () => {
    let opened = false
    const app = createApp({
      serverUrl: 'http://localhost',
      backend: async () => {
        opened = true
        return FileSystemBackend.open({
          dataDir: path.join(dataDir, 'refused-option')
        })
      },
      onboardingToken: ' ',
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'onboardingToken must not be empty.'
    )
    expect(opened).toBe(false)
  })
})

describe('the backends set', () => {
  it('refuses an explicit empty `backends` list instead of opening the fallback', async () => {
    const app = createApp({
      serverUrl: 'http://localhost',
      backends: [],
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'No storage backend is configured.'
    )
  })

  it('refuses two backends under one fixed id, and closes both with the app', async () => {
    const first = await LifecycleSpyBackend.open({
      dataDir: path.join(dataDir, 'twin-1')
    })
    const second = await LifecycleSpyBackend.open({
      dataDir: path.join(dataDir, 'twin-2'),
      originId: first.originId
    })
    const app = createApp({
      serverUrl: 'http://localhost',
      backends: [first, second],
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'Two storage backends carry the id "fs".'
    )
    await app.close().catch(() => {})
    expect(first.closeCalls).toBe(1)
    expect(second.closeCalls).toBe(1)
  })

  it('refuses a default naming no configured backend', async () => {
    const app = createApp({
      serverUrl: 'http://localhost',
      backend: await FileSystemBackend.open({
        dataDir: path.join(dataDir, 'lonely')
      }),
      defaultBackend: 'postgres',
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'WAS_DEFAULT_BACKEND names "postgres", which is not a configured storage backend'
    )
    await app.close().catch(() => {})
  })

  it('refuses a control plane naming no configured backend', async () => {
    const app = createApp({
      serverUrl: 'http://localhost',
      backend: await FileSystemBackend.open({
        dataDir: path.join(dataDir, 'lonely-control')
      }),
      controlPlaneBackend: 'postgres',
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'WAS_CONTROL_PLANE_BACKEND names "postgres", which is not a configured storage backend'
    )
    await app.close().catch(() => {})
  })

  it('refuses `backend` beside `backends`', async () => {
    const backend = await FileSystemBackend.open({
      dataDir: path.join(dataDir, 'both')
    })
    const app = createApp({
      serverUrl: 'http://localhost',
      backend,
      backends: [backend],
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'backend and backends are mutually exclusive.'
    )
    await app.close().catch(() => {})
  })

  it('decorates the set, with the one backend as the default and the control plane', async () => {
    const app = await testApp('set')
    await app.ready()
    expect(app.serverBackends.default).toBe(app.storage)
    expect(app.serverBackends.controlPlane).toBe(app.storage)
    expect(app.serverBackends.defaultId).toBe('fs')
    expect(app.serverBackends.controlPlaneId).toBe('fs')
    expect(app.serverBackends.others()).toEqual([])
    await app.close()
  })
})

describe('a backend with no origin id', () => {
  it('is refused at registration, and still closed with the app', async () => {
    const backend = await UnsettledBackend.open({
      dataDir: path.join(dataDir, 'unsettled')
    })
    const app = createApp({
      serverUrl: 'http://localhost',
      backend,
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'A storage backend carries no origin id.'
    )
    // Closing an app whose boot failed reports the boot error again.
    await app.close().catch(() => {})
    expect(backend.closeCalls).toBe(1)
  })
})

describe('a backend that does not enforce an advertised caveat', () => {
  it('is refused at registration, and still closed with the app', async () => {
    const backend = await NoCaveatBackend.open({
      dataDir: path.join(dataDir, 'no-caveat')
    })
    const app = createApp({
      serverUrl: 'http://localhost',
      backend,
      logger: false
    })
    await expect(app.ready()).rejects.toThrow(
      'The storage backend "fs" does not enforce the capability caveat ' +
        'OwnResourcesOnly.'
    )
    await app.close().catch(() => {})
    expect(backend.closeCalls).toBe(1)
  })
})

describe('cors option', () => {
  /**
   * Sends a CORS preflight for a signed PUT from a browser origin.
   *
   * @param app {FastifyInstance}
   * @returns {Promise<import('light-my-request').Response>}
   */
  async function preflight(app: FastifyInstance) {
    return app.inject({
      method: 'OPTIONS',
      url: '/spaces/',
      headers: {
        origin: 'https://wallet.example',
        'access-control-request-method': 'PUT'
      }
    })
  }

  it('defaults to any origin, without PATCH', async () => {
    const app = await testApp('cors1')
    const response = await preflight(app)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    const methods = String(response.headers['access-control-allow-methods'])
    expect(methods).toContain('PUT')
    expect(methods).not.toContain('PATCH')
    await app.close()
  })

  it('cors: false registers no CORS plugin', async () => {
    const app = await testApp('cors2', { cors: false })
    const response = await preflight(app)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('a custom origin replaces the wildcard', async () => {
    const app = await testApp('cors3', {
      cors: { origin: 'https://wallet.example' }
    })
    const response = await preflight(app)
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://wallet.example'
    )
    // The defaults the option does not override are kept.
    expect(response.headers['access-control-max-age']).toBeDefined()
    await app.close()
  })

  it('a member set to undefined keeps the default', async () => {
    const app = await testApp('cors4', {
      cors: { origin: 'https://wallet.example', methods: undefined }
    })
    const response = await preflight(app)
    const methods = String(response.headers['access-control-allow-methods'])
    expect(methods).toContain('PUT')
    expect(methods).not.toContain('PATCH')
    await app.close()
  })
})

describe('baseServerUrl with a trailing slash', () => {
  let fastify: FastifyInstance, baseServerUrl: string, alice: any

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await FileSystemBackend.open({
        dataDir: path.join(dataDir, 'slash')
      })
    }))
    // The decorated base URL carries the trailing slash the validator admits.
    fastify.serverUrl = `${baseServerUrl}`
    ;({ alice } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('builds the governed log URL without a doubled slash', async () => {
    const spaceId = `slash-space-${crypto.randomUUID()}`
    const collectionId = `col-${crypto.randomUUID()}`
    await alice.pws.createSpace({
      id: spaceId,
      name: 'Slash Space',
      controller: alice.did
    })
    await alice.pws.request({
      url: `${baseServerUrl}space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId }
    })
    const metaUrl = `${baseServerUrl}space/${spaceId}/${collectionId}/meta`
    const genesis = JSON.stringify({
      versionId: '1-hash1',
      versionTime: '2026-10-01T00:00:00Z',
      parameters: { method: 'resource-log:0.1', scid: 'zScid' },
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
    await alice.pws.request({
      url: `${metaUrl}/log`,
      method: 'PUT',
      body: new TextEncoder().encode(genesis + '\n'),
      headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' }
    })

    const described = await alice.pws.request({ url: metaUrl, method: 'GET' })
    expect(described.data.encryption.history.resource).toBe(`${metaUrl}/log`)
  })

  it('builds the exchange URL without a doubled slash', async () => {
    const response = await fetch(
      `${baseServerUrl}workflows/ephemeral/exchanges`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: { type: 'Test' } })
      }
    )
    expect(response.status).toBe(201)
    const { location } = (await response.json()) as { location: string }
    expect(location).toMatch(
      new RegExp(`^${baseServerUrl}workflows/ephemeral/exchanges/[0-9a-f-]+$`)
    )
    expect(response.headers.get('location')).toBe(location)
  })
})
