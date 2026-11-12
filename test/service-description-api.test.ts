/**
 * Service description API tests (Vitest): the unauthenticated `GET /service`
 * document, its caching headers and conditional read, the `Link` header with
 * the `service` relation on every kind of response, the `service` relation in
 * the Space and Collection linksets, and the version-disclosure switch.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/pws-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { SERVICE_DESCRIPTION_MAX_AGE } from '../src/config.default.js'
import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as {
  name: string
  version: string
  repository: { url: string }
  homepage: string
}

describe('Service description API', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    alice: any,
    aliceSpace: Space

  const serviceLink = () => `<${baseServerUrl}service>; rel="service"`

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-service-' })
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))

    aliceSpace = await alice.pws.createSpace({
      id: alice.space1.id,
      name: "Alice's Space",
      controller: alice.did
    })
    const collection = await aliceSpace.createCollection({
      id: 'private-notes',
      name: 'Private Notes'
    })
    await collection.put('note', { id: 'note', name: 'secret' })
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('GET /service', () => {
    it('serves the document without authorization', async () => {
      const response = await fetch(`${baseServerUrl}service`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('cache-control')).toBe(
        `public, max-age=${SERVICE_DESCRIPTION_MAX_AGE}`
      )
      expect(response.headers.get('etag')).toMatch(/^"[^"]+"$/)

      expect(await response.json()).toEqual({
        url: `${baseServerUrl}service`,
        specs: {
          'https://w3id.org/pws': [
            {
              version: '0.5',
              spaces: `${baseServerUrl}spaces/`,
              features: [
                'listing',
                'collection-management',
                'space-management',
                'linksets',
                'policy',
                'metadata',
                'export',
                'backends',
                'query',
                'quotas',
                'encryption',
                'changes-query',
                'created-by'
              ],
              // A replication peer may gate on it, so it sits on the core
              // entry rather than on `instance`.
              originId: backend.originId
            }
          ],
          'https://w3id.org/pws/authz-profile': [
            {
              version: '0.1',
              url:
                'https://w3c-ccg.github.io/portable-web-spaces-spec/' +
                'authz-profile/',
              signatureAlgorithms: ['EdDSA'],
              zcapCryptosuites: ['eddsa-jcs-2022']
            }
          ],
          'https://w3id.org/pws/encrypted-collections': [
            {
              version: '0.1',
              url: 'https://interop-alliance.github.io/encrypted-collections-spec/',
              features: ['blinded-index-query', 'governed-history-logs']
            }
          ],
          'https://w3id.org/pws/client-annex': [{ version: '0.1' }],
          'https://w3id.org/pws/replication': [
            {
              version: '0.1',
              url:
                'https://w3c-ccg.github.io/portable-web-spaces-spec/' +
                'replication/'
            }
          ],
          'https://w3id.org/pws/wallet-profile': [
            {
              version: '0.1',
              url: 'https://interop-alliance.github.io/portable-wallet-profile-spec/'
            }
          ]
        },
        instance: {
          name: packageJson.name,
          version: packageJson.version,
          source: packageJson.repository.url,
          homepage: packageJson.homepage
        }
      })
    })

    it('carries the signature members on the profile entry only', async () => {
      const response = await fetch(`${baseServerUrl}service`)
      const { specs } = (await response.json()) as {
        specs: Record<string, Record<string, unknown>[]>
      }
      const core = specs['https://w3id.org/pws']![0]!
      const profile = specs['https://w3id.org/pws/authz-profile']![0]!
      expect(profile.signatureAlgorithms).toEqual(['EdDSA'])
      expect(profile.zcapCryptosuites).toEqual(['eddsa-jcs-2022'])
      expect(core).not.toHaveProperty('signatureAlgorithms')
      expect(core).not.toHaveProperty('zcapCryptosuites')
    })

    it('lists the client annex entry with version alone', async () => {
      // The entry is a conformance claim a wallet checks at signup. It has
      // nothing to advertise beyond its version, so it carries no other
      // member.
      const response = await fetch(`${baseServerUrl}service`)
      const { specs } = (await response.json()) as {
        specs: Record<string, Record<string, unknown>[]>
      }
      const entries = specs['https://w3id.org/pws/client-annex']!
      expect(entries).toHaveLength(1)
      expect(Object.keys(entries[0]!)).toEqual(['version'])
      expect(entries[0]!.version).toBe('0.1')
    })

    it('lists the wallet profile entry with version and url only', async () => {
      // The profile admits exactly those two members and no `features`; a
      // client treats an entry carrying anything else as absent.
      const response = await fetch(`${baseServerUrl}service`)
      const { specs } = (await response.json()) as {
        specs: Record<string, Record<string, unknown>[]>
      }
      const entries = specs['https://w3id.org/pws/wallet-profile']!
      expect(entries).toHaveLength(1)
      expect(Object.keys(entries[0]!).sort()).toEqual(['url', 'version'])
      expect(entries[0]!.version).toBe('0.1')
    })

    it('carries every token the wallet profile requires', async () => {
      // The profile's "Required specifications" table, restated here from the
      // spec text rather than read off the server's constants, so the entry
      // can never be listed while a required token is missing from the PWS
      // or Encrypted Collections entry it is a shorthand for.
      const required = {
        'https://w3id.org/pws': {
          version: '0.5',
          features: [
            'listing',
            'collection-management',
            'space-management',
            'policy',
            'export',
            'encryption',
            'changes-query'
          ]
        },
        'https://w3id.org/pws/encrypted-collections': {
          version: '0.1',
          features: ['blinded-index-query', 'governed-history-logs']
        }
      }
      const response = await fetch(`${baseServerUrl}service`)
      const { specs } = (await response.json()) as {
        specs: Record<string, { version: string; features?: string[] }[]>
      }
      expect(specs).toHaveProperty(['https://w3id.org/pws/wallet-profile'])
      for (const [identifier, { version, features }] of Object.entries(
        required
      )) {
        const entries = specs[identifier]
        expect(entries, identifier).toBeDefined()
        const entry = entries!.find(candidate => candidate.version === version)
        expect(entry, identifier).toBeDefined()
        for (const token of features) {
          expect(entry!.features, `${identifier} ${token}`).toContain(token)
        }
      }
    })

    it('serves a bodyless HEAD with the same validator', async () => {
      const get = await fetch(`${baseServerUrl}service`)
      const head = await fetch(`${baseServerUrl}service`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect(head.headers.get('etag')).toBe(get.headers.get('etag'))
      expect(head.headers.get('link')).toBe(serviceLink())
    })

    it('answers 304 to a conditional GET holding the current ETag', async () => {
      const first = await fetch(`${baseServerUrl}service`)
      const etag = first.headers.get('etag')!
      const response = await fetch(`${baseServerUrl}service`, {
        headers: { 'if-none-match': etag }
      })
      expect(response.status).toBe(304)
      expect(response.headers.get('etag')).toBe(etag)
      expect(response.headers.get('cache-control')).toBe(
        `public, max-age=${SERVICE_DESCRIPTION_MAX_AGE}`
      )
    })

    it('sends no Content-Length on a 304, to GET or to HEAD', async () => {
      // RFC 9110 section 8.6. HEAD here is Fastify's implicit HEAD route,
      // whose own onSend hook would stamp `Content-Length: 0` on an empty
      // reply.
      const first = await fetch(`${baseServerUrl}service`)
      const etag = first.headers.get('etag')!
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`${baseServerUrl}service`, {
          method,
          headers: { 'if-none-match': etag }
        })
        expect(response.status, method).toBe(304)
        expect(response.headers.get('etag'), method).toBe(etag)
        expect(response.headers.get('content-length'), method).toBeNull()
      }
    })
  })

  describe('the service Link header', () => {
    const expectDiscoverable = (response: Response) => {
      expect(response.headers.get('link')).toBe(serviceLink())
      expect(
        response.headers.get('access-control-expose-headers') ?? ''
      ).toMatch(/(^|,\s*)Link(\s*,|$)/)
    }

    it('is on the service description itself', async () => {
      expectDiscoverable(await fetch(`${baseServerUrl}service`))
    })

    it('is on an unauthorized HEAD of a private Resource (404)', async () => {
      const response = await fetch(
        `${baseServerUrl}space/${alice.space1.id}/private-notes/note`,
        { method: 'HEAD' }
      )
      expect(response.status).toBe(404)
      expectDiscoverable(response)
    })

    it('is on an authorized listing (200)', async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/private-notes/`,
        method: 'GET'
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('link')).toBe(serviceLink())
    })

    it('is on a canonicalization redirect (308)', async () => {
      const response = await fetch(`${baseServerUrl}spaces`, {
        redirect: 'manual'
      })
      expect(response.status).toBe(308)
      expectDiscoverable(response)
    })

    it('is on an error from the error handler (404)', async () => {
      const response = await fetch(
        `${baseServerUrl}space/${alice.space1.id}/private-notes/note`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'anonymous write' })
        }
      )
      expect(response.status).toBe(404)
      expectDiscoverable(response)
    })

    it('is on a 405 at a reserved endpoint', async () => {
      const response = await fetch(
        `${baseServerUrl}space/${alice.space1.id}/export`
      )
      expect(response.status).toBe(405)
      expectDiscoverable(response)
    })

    it('is on a 404 for a URL no route matches', async () => {
      const response = await fetch(`${baseServerUrl}no-such-route`)
      expect(response.status).toBe(404)
      expectDiscoverable(response)
    })

    it('is on a CORS preflight', async () => {
      const response = await fetch(
        `${baseServerUrl}space/${alice.space1.id}/private-notes/note`,
        {
          method: 'OPTIONS',
          headers: {
            origin: 'https://wallet.example',
            'access-control-request-method': 'PUT'
          }
        }
      )
      expect(response.status).toBe(204)
      expect(response.headers.get('link')).toBe(serviceLink())
    })

    it('is on the teaching-server extras (/health)', async () => {
      expectDiscoverable(await fetch(`${baseServerUrl}health`))
    })

    it('appends to a Link header a handler already set', async () => {
      const app = createApp({
        backend: await FileSystemBackend.open({ dataDir: backend.dataDir }),
        logger: false,
        serverUrl: 'https://pws.example'
      })
      app.get('/test-links', async (request, reply) => {
        return reply
          .header(
            'link',
            '<https://pws.example/a?cursor=1>; rel="next", ' +
              '<https://pws.example/a>; rel="first"'
          )
          .send({})
      })
      const response = await app.inject({ method: 'GET', url: '/test-links' })
      expect(response.headers.link).toBe(
        '<https://pws.example/a?cursor=1>; rel="next", ' +
          '<https://pws.example/a>; rel="first", ' +
          '<https://pws.example/service>; rel="service"'
      )
      await app.close()
    })
  })

  describe('linksets', () => {
    const serviceRelation = () => [
      { href: `${baseServerUrl}service`, type: 'application/json' }
    ]

    it('the Space linkset carries the service relation', async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/linkset`,
        method: 'GET'
      })
      expect(response.status).toBe(200)
      expect(response.data.linkset[0].service).toEqual(serviceRelation())
    })

    it('the Collection linkset carries the service relation', async () => {
      const response = await alice.pws.request({
        url: `${baseServerUrl}space/${alice.space1.id}/private-notes/linkset`,
        method: 'GET'
      })
      expect(response.status).toBe(200)
      expect(response.data.linkset[0].service).toEqual(serviceRelation())
    })
  })
})

describe('Service description with the version withheld', () => {
  let fastify: FastifyInstance, baseServerUrl: string

  beforeAll(async () => {
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend: await openTempBackend({ prefix: 'was-service-' }),
      discloseVersion: false
    }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('omits instance.version and keeps the other members', async () => {
    const response = await fetch(`${baseServerUrl}service`)
    const body = (await response.json()) as { instance: object }
    expect(body.instance).toEqual({
      name: packageJson.name,
      source: packageJson.repository.url,
      homepage: packageJson.homepage
    })
  })

  it('omits the version from /health', async () => {
    const response = await fetch(`${baseServerUrl}health`)
    expect(await response.json()).toEqual({ status: 'pass' })
  })

  it('omits the version from the welcome page', async () => {
    const response = await fetch(baseServerUrl)
    const body = await response.text()
    expect(body).toMatch(/Welcome|W\.A\.S\./)
    expect(body).not.toContain(packageJson.version)
  })
})
