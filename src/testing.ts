/**
 * Test support entry point (`@interop/web-spaces-server/testing`): the in-process
 * boot the server's own suites use, for a consumer that runs its tests against
 * the real server. Carries `startTestServer`, a temp-dir filesystem backend,
 * the request fault seam, the hand-built `did:webvh` identity provisioner,
 * and the two-server boot a replication test runs in one process: a server
 * identity whose key may invoke, the pull transport over `fastify.inject`,
 * and the peer log fetcher. It imports no test runner, and adds nothing to
 * the production plugin's options.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { EddsaJcs2022 } from '@interop/ed25519-signature/eddsa-jcs-2022'
import { ZcapClient } from '@interop/ezcap'
import {
  createDID,
  logToJsonlString,
  signerFromExternalKey
} from '@interop/did-method-webvh'
import type { DIDLog, ServiceEndpoint, Signer } from '@interop/did-method-webvh'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import { FileSystemBackend } from './backends/filesystem.js'
import type { FileSystemBackendOptions } from './backends/filesystem.js'
import {
  RequestFaults,
  RequestFaultDisarmedError
} from './lib/requestFaults.js'
import {
  absoluteSpaceUrl,
  absoluteUrl,
  replicasPath,
  replicaStatusPath,
  resourcePath
} from './lib/paths.js'
import { createServerSigningKey } from './lib/serverIdentity.js'
import type { ServerSigningKey } from './lib/serverIdentity.js'
import { WEBVH_LOG_RESOURCE_ID } from './lib/validateDid.js'
import { composeApp, createApp, createInstance } from './server.js'
import type { PeerFetch } from './sync/peerFetch.js'
import { capabilityActionOf, rootCapabilityId } from './zcap.js'
import type { IDID, StorageBackend } from './types.js'

export { RequestFaults, RequestFaultDisarmedError }
export type { RequestMatch, RequestRecord } from './lib/requestFaults.js'
export type { PeerFetch }

/**
 * Boots a test server on an OS-assigned ephemeral port and returns the
 * `baseServerUrl` it is actually reachable at, so parallel Vitest workers can
 * never collide on a port.
 *
 * ZCap `invocationTarget` URLs embed host and port, so the server's URL must
 * match the listening port exactly. The port is not known until the server
 * listens, so the app boots against a placeholder base URL and the
 * `serverUrl` decoration is corrected by the first `onListen` hook, before any
 * request is served. Handlers read `request.server.serverUrl` per request, and
 * the plugin's own listen-time read runs after that hook, so nothing captures
 * the placeholder.
 *
 * When the boot fails (a refused option, a port already in use), the Fastify
 * instance is closed before the error is rethrown, so a backend the plugin
 * already owns is closed with it.
 *
 * Callers must build their ZCap clients from the returned `baseServerUrl`, not
 * from a precomputed URL. It is the spec's base server URL, with its trailing
 * slash, the form `new PwsClient({ baseServerUrl })` takes. The no-slash form
 * `createApp({ serverUrl })` takes is the returned instance's `serverUrl`.
 *
 * The returned `faults` records every request and can refuse, drop the
 * response of, or hold a chosen one. Its hooks are added before the protocol
 * plugin, so they run ahead of every route group's own hooks.
 *
 * A suite that tears a server down and boots a replacement over the same
 * `dataDir` must pin the replacement to the returned `port`, so that ids minted
 * by the first server (which embed its URL) still resolve.
 *
 * The physical clock the server's write stamps read can be frozen or stepped:
 * pass `physicalClock` here when the server opens its own default backend,
 * or to `openTempBackend()` for an injected one.
 *
 * @param [options] {object}   `createApp()` options, minus `serverUrl`
 * @param [options.port] {number}   pin the listening port; defaults to an
 *   OS-assigned ephemeral port
 * @param [options.logger] {boolean|object}   Fastify logger; defaults to
 *   `false` so per-request log lines stay out of the test output
 * @returns {Promise<{ fastify: FastifyInstance, baseServerUrl: string, port: number, faults: RequestFaults }>}
 */
export async function startTestServer({
  port = 0,
  ...options
}: Omit<NonNullable<Parameters<typeof createApp>[0]>, 'serverUrl'> & {
  port?: number
} = {}): Promise<{
  fastify: FastifyInstance
  baseServerUrl: string
  port: number
  faults: RequestFaults
}> {
  const { logger = false, ...appOptions } = options
  const fastify = createInstance({ logger })
  const faults = new RequestFaults({ fastify })
  // Added before the plugin is registered, so it runs ahead of the plugin's
  // own `onListen` hook. Synchronous, so it has run by the time `listen()`
  // hands back control: Fastify starts the hooks as it resolves, without
  // awaiting.
  fastify.addHook('onListen', function setServerUrl(done) {
    // `localhost`, not `127.0.0.1`: webkms-client only relaxes its loopback
    // checks for a `localhost` host.
    const { port: listeningPort } = fastify.server.address() as AddressInfo
    fastify.serverUrl = `http://localhost:${listeningPort}`
    done()
  })
  composeApp({ fastify, ...appOptions, serverUrl: 'http://localhost' })
  try {
    await fastify.listen({ port })
  } catch (err) {
    await fastify.close()
    throw err
  }
  const { serverUrl } = fastify
  return {
    fastify,
    baseServerUrl: `${serverUrl}/`,
    port: Number(new URL(serverUrl).port),
    faults
  }
}

/**
 * A `FileSystemBackend` over a private temp dir, which `close()` removes.
 * Obtained from `openTempBackend()` alone. The class is exported as a type
 * only, so its inherited `open({ dataDir })` cannot be pointed at a dir the
 * caller wants to keep.
 */
class TempFileSystemBackend extends FileSystemBackend {
  /**
   * Removes the temp data dir. The plugin owns an injected backend by default,
   * so `fastify.close()` already calls this. Under `ownsBackend: false`, or
   * for a backend that never reached a server, the caller calls it. A repeat
   * call is a no-op.
   *
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await rm(this.dataDir, { recursive: true, force: true })
  }
}
export type { TempFileSystemBackend }

/**
 * Opens a `FileSystemBackend` on a fresh temp dir, through the async `open()`
 * factory. Each call gets its own dir, so suites never share storage and
 * parallel test workers cannot collide on the filesystem. The backend's
 * `close()` removes the dir.
 *
 * The plugin owns an injected backend by default, so closing the server
 * removes the dir. A test that restarts a server over the same data dir makes
 * its own dir and opens it with `FileSystemBackend.open({ dataDir })` instead.
 *
 * @param [options] {object}   `FileSystemBackend.open()` options, minus
 *   `dataDir`; `physicalClock` freezes or steps the clock the backend's
 *   write stamps read
 * @param [options.prefix] {string}   the temp dir's name prefix
 * @returns {Promise<TempFileSystemBackend>}
 */
export async function openTempBackend({
  prefix = 'was-test-',
  ...options
}: Omit<FileSystemBackendOptions, 'dataDir'> & {
  prefix?: string
} = {}): Promise<TempFileSystemBackend> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await TempFileSystemBackend.open({ ...options, dataDir })
  } catch (err) {
    await rm(dataDir, { recursive: true, force: true })
    throw err
  }
}

/**
 * A minted, published self-hosted `did:webvh` and the keys it lists.
 */
export interface WebvhIdentity {
  spaceId: string
  /**
   * the Space's canonical trailing-slash URL
   */
  spaceUrl: string
  did: string
  log: DIDLog
  /**
   * the update-key signer every log entry of this identity is signed by
   */
  logSigner: Signer
  /**
   * the enrolled-client key: all four relations
   */
  clientKeyPair: Ed25519VerificationKey
  /**
   * the delegation-only (ladder) key, when the document lists one
   */
  ladderKeyPair?: Ed25519VerificationKey
  /**
   * the invocation-and-delegation (transient annex) key, when listed
   */
  transientKeyPair?: Ed25519VerificationKey
}

/**
 * `provisionWebvhIdentity()` could not publish the history log: the server
 * answered the `PUT` of `did.jsonl` with something other than 201. Never sent
 * over the wire.
 * @param options {object}
 * @param options.url {string}   the log URL the `PUT` targeted
 * @param options.status {number}   the status the server answered
 */
export class WebvhIdentityPublishError extends Error {
  constructor({ url, status }: { url: string; status: number }) {
    super(`PUT ${url} answered ${status}, expected 201.`)
    this.name = 'WebvhIdentityPublishError'
  }
}

/**
 * The history-log signer for a `did:key` key pair: the update-key signer a
 * `did:webvh` log's entries are signed by.
 *
 * @param options {object}
 * @param options.keyPair {Ed25519VerificationKey}
 * @returns {Signer}
 */
export function webvhLogSigner({
  keyPair
}: {
  keyPair: Ed25519VerificationKey
}): Signer {
  const signer = keyPair.didKeySigner()
  return signerFromExternalKey({
    publicKeyMultibase: keyPair.publicKeyMultibase!,
    sign: async ({ data }: { data: Uint8Array }) => await signer.sign({ data })
  })
}

/**
 * Provisions a Space controlled by a `did:key` client, mints a `did:webvh`
 * anchored in one of its Collections, and publishes the history log there.
 * Promotion of the Space to the new DID is left to the caller (Space creation
 * is `did:key`-only). When a step after the Space's creation fails, the Space
 * is deleted before the error is rethrown.
 *
 * @param options {object}
 * @param options.owner {object}   `{ did, pws }`: a `did:key` and a
 *   `@interop/pws-client` `PwsClient` signed by it, which creates the Space.
 *   This package does not depend on pws-client, so the caller brings its own
 *   and the parameter is typed by the members this function calls
 * @param options.baseServerUrl {string}   the base server URL of the server
 *   the log is anchored on
 * @param [options.withLadderKey] {boolean}   also list a method under
 *   `assertionMethod` and `capabilityDelegation` alone -- the ladder VM
 *   shape, recognized by relation asymmetry
 * @param [options.withTransientKey] {boolean}   also list a method under
 *   `capabilityInvocation` and `capabilityDelegation` alone -- the shape a
 *   per-visit annex verification method publishes under
 * @param [options.collectionId] {string}   the Collection anchoring the log
 * @param [options.services] {ServiceEndpoint[]}   service entries for the
 *   created document
 * @returns {Promise<WebvhIdentity>}   with `ladderKeyPair` and
 *   `transientKeyPair` typed as present when the matching flag is the literal
 *   `true`
 */
export async function provisionWebvhIdentity<
  WithLadderKey extends boolean = false,
  WithTransientKey extends boolean = false
>({
  owner,
  baseServerUrl,
  withLadderKey,
  withTransientKey,
  collectionId = 'id',
  services
}: {
  owner: {
    did: string
    pws: {
      space(spaceId: string): {
        configure(options: {
          name: string
          controller: string
        }): Promise<unknown>
        collection(collectionId: string): {
          configure(options: { force: boolean }): Promise<unknown>
        }
        delete(): Promise<unknown>
      }
      request(options: {
        url: string
        method: string
        headers: Record<string, string>
        body: Blob
      }): Promise<{ status: number }>
    }
  }
  baseServerUrl: string
  withLadderKey?: WithLadderKey
  withTransientKey?: WithTransientKey
  collectionId?: string
  services?: ServiceEndpoint[]
}): Promise<
  WebvhIdentity &
    Required<
      Pick<
        WebvhIdentity,
        | (WithLadderKey extends true ? 'ladderKeyPair' : never)
        | (WithTransientKey extends true ? 'transientKeyPair' : never)
      >
    >
> {
  const spaceId = randomUUID()
  const space = owner.pws.space(spaceId)
  await space.configure({ name: 'Identity Space', controller: owner.did })
  try {
    await space.collection(collectionId).configure({ force: true })

    const [updateKeyPair, clientKeyPair, ladderKeyPair, transientKeyPair] =
      await Promise.all([
        Ed25519VerificationKey.generate(),
        Ed25519VerificationKey.generate(),
        withLadderKey ? Ed25519VerificationKey.generate() : undefined,
        withTransientKey ? Ed25519VerificationKey.generate() : undefined
      ])
    const logSigner = webvhLogSigner({ keyPair: updateKeyPair })

    // Relationship wiring is driven entirely through `purpose`: passing
    // explicit relationship arrays alongside would override it wholesale.
    const verificationMethods = [
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
    ]
    if (ladderKeyPair) {
      verificationMethods.push({
        type: 'Multikey',
        publicKeyMultibase: ladderKeyPair.publicKeyMultibase!,
        purpose: ['assertionMethod', 'capabilityDelegation']
      })
    }
    if (transientKeyPair) {
      verificationMethods.push({
        type: 'Multikey',
        publicKeyMultibase: transientKeyPair.publicKeyMultibase!,
        purpose: ['capabilityInvocation', 'capabilityDelegation']
      })
    }

    const created = await createDID({
      address: `${baseServerUrl}space/${spaceId}/${collectionId}`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: verificationMethods as any,
      ...(services ? { services } : {})
    })

    for (const keyPair of [clientKeyPair, ladderKeyPair, transientKeyPair]) {
      if (keyPair) {
        keyPair.id = `${created.did}#${keyPair.publicKeyMultibase}`
        keyPair.controller = created.did
      }
    }

    const logUrl = absoluteUrl({
      path: resourcePath({
        spaceId,
        collectionId,
        resourceId: WEBVH_LOG_RESOURCE_ID
      }),
      serverUrl: baseServerUrl
    })
    const published = await owner.pws.request({
      url: logUrl,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(created.log)], { type: 'text/jsonl' })
    })
    if (published.status !== 201) {
      throw new WebvhIdentityPublishError({
        url: logUrl,
        status: published.status
      })
    }

    const identity: WebvhIdentity = {
      spaceId,
      spaceUrl: absoluteSpaceUrl({ spaceId, serverUrl: baseServerUrl }),
      did: created.did,
      log: created.log,
      logSigner,
      clientKeyPair,
      ladderKeyPair,
      transientKeyPair
    }
    // A key pair is generated exactly when its flag is set, which the
    // compiler cannot follow through the conditional above.
    return identity as Awaited<
      ReturnType<typeof provisionWebvhIdentity<WithLadderKey, WithTransientKey>>
    >
  } catch (err) {
    // Best effort: the provisioning failure is the error worth reporting.
    await space.delete().catch(() => {})
    throw err
  }
}

/**
 * A frozen, steppable physical clock for a backend's hybrid logical clock
 * (`physicalClock` on `openTempBackend()` / `startTestServer()`). `now` is the
 * epoch milliseconds it reads; set it to step the clock, backwards included.
 *
 * @param [start] {number}   the initial reading; defaults to a fixed instant
 * @returns {{ now: number, read: () => number }}
 */
export function frozenClock(start = Date.UTC(2026, 9, 1)): {
  now: number
  read: () => number
} {
  const clock = {
    now: start,
    read: () => clock.now
  }
  return clock
}

/**
 * Mints the history log of a server's `did:webvh`, anchored at
 * `{serverUrl}/space/server/id`, under a fresh admin update key. The
 * document lists one Multikey, the server's signing key, under `purpose`.
 * Nothing is written anywhere.
 *
 * @param options {object}
 * @param options.serverUrl {string}   the host the DID is minted for, with or
 *   without its trailing slash
 * @param options.publicKeyMultibase {string}   the signing key's public key
 * @param [options.admin] {Ed25519VerificationKey}   the admin key pair that
 *   holds the log's update key; a fresh one when omitted
 * @param [options.purpose] {string[]}   the relationships the key is listed
 *   under
 * @param [options.witness] {object}   the log's `witness` parameter
 * @returns {Promise<{ did: string, log: DIDLog, admin: Ed25519VerificationKey }>}
 */
export async function mintServerDid({
  serverUrl,
  publicKeyMultibase,
  admin,
  purpose = ['assertionMethod'],
  witness
}: {
  serverUrl: string
  publicKeyMultibase: string
  admin?: Ed25519VerificationKey
  purpose?: string[]
  witness?: { threshold: number; witnesses: { id: string }[] }
}): Promise<{ did: string; log: DIDLog; admin: Ed25519VerificationKey }> {
  admin ??= await Ed25519VerificationKey.generate()
  const { did, log } = await createDID({
    address: absoluteUrl({ path: '/space/server/id', serverUrl }),
    signer: webvhLogSigner({ keyPair: admin }),
    updateKeys: [admin.publicKeyMultibase!],
    vmIdFragment: 'multibase',
    portable: true,
    verificationMethods: [
      { type: 'Multikey', publicKeyMultibase, purpose }
    ] as any,
    ...(witness !== undefined && { witness })
  })
  return { did, log, admin }
}

/**
 * Gives a bare backend a server identity, the way an admin would through the
 * front door: the `server` Space under an admin `did:key`, its `id`
 * Collection, and a `did.jsonl` history log whose document lists the
 * seed-derived export-signing key under `purpose` (by default
 * `assertionMethod` only), named by its full `publicKeyMultibase`. Written
 * through the backend API, so no server needs to run. A server booted over
 * the backend with the same `seed` (`serverKeySeed`) then advertises the DID
 * on `/service`, and, when `purpose` lists `capabilityInvocation`, may
 * invoke a pull capability delegated to it.
 *
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.serverUrl {string}   the host the DID is minted for, the
 *   no-slash form `createApp()` takes
 * @param options.seed {Uint8Array}   the export-signing key's 32-byte seed
 * @param [options.purpose] {string[]}   the relationships the key is listed
 *   under
 * @returns {Promise<{ signingKey: ServerSigningKey, did: string, didLog: string }>}
 */
export async function provisionServerIdentity({
  backend,
  serverUrl,
  seed,
  purpose = ['assertionMethod']
}: {
  backend: StorageBackend
  serverUrl: string
  seed: Uint8Array
  purpose?: string[]
}): Promise<{ signingKey: ServerSigningKey; did: string; didLog: string }> {
  const signingKey = await createServerSigningKey({ seed })
  const { did, log, admin } = await mintServerDid({
    serverUrl,
    publicKeyMultibase: signingKey.keyPair.publicKeyMultibase!,
    purpose
  })
  const didLog = logToJsonlString(log)
  await backend.writeSpace({
    spaceId: 'server',
    spaceMetadata: {
      id: 'server',
      type: ['AuxiliarySpace', 'ServerInstanceSpace', 'Space'],
      controller: `did:key:${admin.publicKeyMultibase}` as IDID
    }
  })
  await backend.writeCollection({
    spaceId: 'server',
    collectionId: 'id',
    collectionMetadata: { id: 'id', type: ['Collection'], name: 'id' }
  })
  await backend.writeResource({
    spaceId: 'server',
    collectionId: 'id',
    resourceId: 'did.jsonl',
    input: {
      kind: 'binary',
      contentType: 'text/jsonl',
      stream: Readable.from([Buffer.from(didLog)])
    }
  })
  return { signingKey, did, didLog }
}

/**
 * The pull loops' transport for servers booted in one process that never
 * listen: the request is handed to the app the URL's origin names, through
 * `fastify.inject`. `servers` is read on every request, so a server may be
 * added after the transport is built. Routes `GET` only, which is all a pull
 * sends.
 *
 * @param servers {Map<string, { fastify: FastifyInstance }>}   the apps, by
 *   server origin
 * @returns {PeerFetch}
 */
export function injectPeerFetch(
  servers: Map<string, { fastify: FastifyInstance }>
): PeerFetch {
  return async ({ url, headers }) => {
    const target = new URL(url)
    const server = serverAt({ servers, url })
    const response = await server.fastify.inject({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host }
    })
    return {
      status: response.statusCode,
      headers: {
        get: (name: string) => {
          const value = response.headers[name.toLowerCase()]
          if (value === undefined) {
            return null
          }
          // Joined as `Headers.get` joins a multi-valued header.
          return Array.isArray(value) ? value.join(', ') : String(value)
        }
      },
      body: new Blob([new Uint8Array(response.rawPayload)]).stream(),
      release: () => {}
    }
  }
}

/**
 * The `peerLogFetcher` of a server booted beside its peers: a peer's
 * `did:webvh` log is read from the peer's own storage. `servers` is read on
 * every fetch, so a server may be added after the fetcher is built.
 *
 * @param servers {Map<string, { didLog: string }>}   the servers, by origin
 * @returns {(options: { url: string }) => Promise<Buffer>}
 */
export function peerLogFetcherOf(
  servers: Map<string, { didLog: string }>
): (options: { url: string }) => Promise<Buffer> {
  return async ({ url }) => Buffer.from(serverAt({ servers, url }).didLog)
}

/**
 * The server booted at the origin of `url`, from the servers a test keeps
 * by origin.
 *
 * @param options {object}
 * @param options.servers {Map<string, T>}
 * @param options.url {string}
 * @returns {T}
 */
function serverAt<T>({
  servers,
  url
}: {
  servers: Map<string, T>
  url: string
}): T {
  const origin = new URL(url).origin
  const server = servers.get(origin)
  if (server === undefined) {
    throw new Error(`No test server at ${origin}.`)
  }
  return server
}

/**
 * One of the servers a replication test boots in one process: its app, its
 * filesystem backend, the clock its write stamps read, and its own DID.
 */
export interface PeerServer {
  serverUrl: string
  fastify: FastifyInstance
  backend: TempFileSystemBackend
  clock: ReturnType<typeof frozenClock>
  did: string
  didLog: string
  /**
   * The server's sync key, the one its pull loop invokes with.
   */
  signingKey: ServerSigningKey
}

/**
 * Boots one server of a replication test over its own temp data dir, with
 * an identity whose key may invoke, so it can pull, and its timers paused so
 * every pull is run by hand (`fastify.replication.pullNow`). The server never
 * listens: its pull loop reaches its peers through `peerFetch`, and it is
 * added to `servers` under its URL. Requests reach it through
 * `signedInject`, signed as a client would sign them, with a `host` header
 * naming its URL's host.
 *
 * A peer's `did:webvh` must name a host with no port, which an ephemeral
 * test port cannot give, so each server is named by an `https` URL such as
 * `https://source.example`. The URL must be a bare origin, since the two
 * seams look a server up by the origin of the URL they are handed, and no
 * two servers may share one. A boot that fails after the backend opened
 * closes it, removing its temp dir.
 *
 * @param options {object}
 * @param options.serverUrl {string}   the no-slash form `createApp()` takes,
 *   a bare origin
 * @param options.servers {Map<string, PeerServer>}   the test's servers
 * @param [options.peerFetch] {PeerFetch}   the transport the pull loop uses;
 *   defaults to `injectPeerFetch(servers)`
 * @param [options.start] {number}   the clock's start, epoch milliseconds
 * @param [options.prefix] {string}   the temp dir prefix
 * @returns {Promise<PeerServer>}
 */
export async function bootPeerServer({
  serverUrl,
  servers,
  peerFetch = injectPeerFetch(servers),
  start,
  prefix = 'was-peer-'
}: {
  serverUrl: string
  servers: Map<string, PeerServer>
  peerFetch?: PeerFetch
  start?: number
  prefix?: string
}): Promise<PeerServer> {
  if (new URL(serverUrl).origin !== serverUrl) {
    throw new Error(
      `bootPeerServer: serverUrl must be a bare origin such as ` +
        `https://source.example; got "${serverUrl}".`
    )
  }
  if (servers.has(serverUrl)) {
    throw new Error(
      `bootPeerServer: a server at ${serverUrl} is already booted.`
    )
  }
  const clock = frozenClock(start)
  const backend = await openTempBackend({ prefix, physicalClock: clock.read })
  try {
    const seed = randomBytes(32)
    const { did, didLog, signingKey } = await provisionServerIdentity({
      backend,
      serverUrl,
      seed,
      purpose: ['assertionMethod', 'capabilityInvocation']
    })
    const fastify = createApp({
      serverUrl,
      backend,
      logger: false,
      serverKeySeed: seed,
      peerFetch,
      peerLogFetcher: peerLogFetcherOf(servers)
    })
    try {
      await fastify.ready()
    } catch (err) {
      // The plugin owns the backend once the app is built; closing the
      // instance closes it.
      await fastify.close().catch(() => {})
      throw err
    }
    fastify.replication.pause()
    const server = {
      serverUrl,
      fastify,
      backend,
      clock,
      did,
      didLog,
      signingKey
    }
    servers.set(serverUrl, server)
    return server
  } catch (err) {
    await backend.close().catch(() => {})
    throw err
  }
}

/**
 * Sends one signed request to a server that never listens, through
 * `fastify.inject`, signed as a client would sign it: a capability
 * invocation of the root capability of the Space the path is under, unless
 * `capability` names another, with a `host` header naming the server URL's
 * host. The invocation names the method's capability action, so a `HEAD` is
 * signed as `GET`.
 *
 * @param options {object}
 * @param options.server {{ fastify: FastifyInstance, serverUrl: string }}
 * @param options.path {string}   the server-relative path, under a Space
 * @param options.signer {object}   the invocation signer
 * @param [options.method] {string}   defaults to `GET`
 * @param [options.capability] {object|string}   defaults to the root
 *   capability of the Space the path is under
 * @param [options.json] {object}   a JSON body
 * @param [options.body] {Uint8Array}   a binary body
 * @param [options.contentType] {string}
 * @param [options.headers] {Record<string, string>}   headers sent outside
 *   the signature, such as `if-match`
 * @returns {Promise<LightMyRequestResponse>}
 */
export async function signedInject({
  server,
  path,
  signer,
  method = 'GET',
  capability,
  json,
  body,
  contentType,
  headers: extraHeaders = {}
}: {
  server: { fastify: FastifyInstance; serverUrl: string }
  path: string
  signer: any
  method?: string
  capability?: any
  json?: object
  body?: Uint8Array
  contentType?: string
  headers?: Record<string, string>
}): Promise<LightMyRequestResponse> {
  const spaceId = /^\/space\/([^/]+)/.exec(path)?.[1]
  if (spaceId === undefined) {
    throw new Error(`signedInject: path must be under a Space; got "${path}".`)
  }
  const url = absoluteUrl({ path, serverUrl: server.serverUrl })
  const spaceUrl = absoluteSpaceUrl({ spaceId, serverUrl: server.serverUrl })
  const headers = await signCapabilityInvocation({
    url,
    method,
    headers: {
      date: new Date().toUTCString(),
      ...(contentType !== undefined && { 'content-type': contentType })
    },
    ...(json !== undefined && { json }),
    ...(body !== undefined && { body }),
    capability: capability ?? rootCapabilityId(spaceUrl),
    capabilityAction: capabilityActionOf({ method }),
    invocationSigner: signer
  })
  let payload: string | Buffer | undefined
  if (json !== undefined) {
    payload = JSON.stringify(json)
  } else if (body !== undefined) {
    payload = Buffer.from(body)
  }
  return server.fastify.inject({
    method: method as any,
    url: path,
    headers: {
      ...(headers as Record<string, string>),
      ...extraHeaders,
      host: new URL(server.serverUrl).host
    },
    ...(payload !== undefined && { payload })
  })
}

/**
 * Registers `from`'s Space as a source of `to`'s: delegates a pull capability
 * on the source Space to `to`'s DID, signed by `delegator`, and posts the
 * registration to `to` under `signer`, the local Space's controller.
 * Resolves the registration response, whatever its status.
 *
 * @param options {object}
 * @param options.to {{ fastify: FastifyInstance, serverUrl: string, did: string }}
 *   the server that pulls
 * @param options.toSpaceId {string}
 * @param options.from {{ serverUrl: string }}   the source server
 * @param options.fromSpaceId {string}
 * @param options.signer {object}   the local Space's controller key, which
 *   signs the registration
 * @param options.delegator {{ did: string, signer: object }}   the source
 *   Space's controller
 * @param [options.replicaId] {string}   defaults to `peer`
 * @param [options.allowedActions] {string[]}   of the pull capability;
 *   defaults to `['GET']`
 * @param [options.expires] {Date}   of the pull capability; defaults to an
 *   hour from now
 * @param [options.overrides] {object}   members laid over the registration
 *   body
 * @returns {Promise<LightMyRequestResponse>}
 */
export async function registerReplica({
  to,
  toSpaceId,
  from,
  fromSpaceId,
  signer,
  delegator,
  replicaId = 'peer',
  allowedActions = ['GET'],
  expires = new Date(Date.now() + 60 * 60 * 1000),
  overrides = {}
}: {
  to: { fastify: FastifyInstance; serverUrl: string; did: string }
  toSpaceId: string
  from: { serverUrl: string }
  fromSpaceId: string
  signer: any
  delegator: { did: string; signer: any }
  replicaId?: string
  allowedActions?: string[]
  expires?: Date
  overrides?: Record<string, unknown>
}): Promise<LightMyRequestResponse> {
  const fromSpace = absoluteSpaceUrl({
    spaceId: fromSpaceId,
    serverUrl: from.serverUrl
  })
  const capability = await new ZcapClient({
    SuiteClass: EddsaJcs2022,
    invocationSigner: delegator.signer,
    delegationSigner: delegator.signer
  }).delegate({
    capability: rootCapabilityId(fromSpace),
    invocationTarget: fromSpace,
    controller: to.did,
    allowedActions,
    expires
  })
  return signedInject({
    server: to,
    signer,
    path: replicasPath({ spaceId: toSpaceId }),
    method: 'POST',
    json: {
      id: replicaId,
      fromSpace,
      toSpace: absoluteSpaceUrl({
        spaceId: toSpaceId,
        serverUrl: to.serverUrl
      }),
      capability,
      role: 'source',
      ...overrides
    }
  })
}

/**
 * Reads a registration's status on `server`, signed by `signer`, and
 * resolves the status document. Fails when the read is not answered 200.
 *
 * @param options {object}
 * @param options.server {{ fastify: FastifyInstance, serverUrl: string }}
 * @param options.spaceId {string}
 * @param options.signer {object}
 * @param [options.replicaId] {string}   defaults to `peer`
 * @returns {Promise<any>}
 */
export async function replicaStatus({
  server,
  spaceId,
  signer,
  replicaId = 'peer'
}: {
  server: { fastify: FastifyInstance; serverUrl: string }
  spaceId: string
  signer: any
  replicaId?: string
}): Promise<any> {
  const response = await signedInject({
    server,
    signer,
    path: replicaStatusPath({ spaceId, replicaId })
  })
  assert.equal(response.statusCode, 200, response.payload)
  return response.json()
}
