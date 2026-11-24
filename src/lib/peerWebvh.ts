/**
 * Network resolution of a foreign `did:webvh`: a DID on another host whose
 * history log this server does not store.
 *
 * Two kinds of party invoke here under such a DID. A replica pulls a Space
 * under a capability the Space's controller delegated to the pulling server's
 * DID, `did:webvh:<scid>:<host>:space:server:id`, whose log lives in that
 * server's `server` Space. And a wallet delegates to long-lived services and
 * agents that hold their own `did:webvh`, with any path or none. The log is
 * fetched from the URL the did:webvh method maps the DID to
 * (`https://<host>/<path>/did.jsonl`, or
 * `https://<host>/.well-known/did.jsonl` for the host-only form).
 *
 * The fetch is reached only through a peer grant on the verification context
 * (`WebvhResolverContext.peer`). The capability verifier issues one after it
 * has verified the delegation chain whose invoked capability names the DID as
 * its controller, so a request that does not carry such a chain causes no
 * request to any host. A DID on the operator's blocklist
 * (`lib/webvhBlocklist.ts`) gets no grant and is refused here too, before any
 * fetch. What this module adds is the bounds on the fetch itself:
 *
 * - The log is verified like a local log (SCID pinning, hash chain, update-key
 *   signatures), with no witness fetch, and must extend the last head verified
 *   for the DID, so a host cannot serve an older prefix to restore a retired
 *   key.
 * - A verified document is cached per DID for a TTL, then fetched and verified
 *   again, so a key the DID's controller retires stops verifying within one
 *   TTL.
 * - A signature naming a key the cached document lacks forces one fetch per DID
 *   per interval. A DID URL root that does not dereference to the Space a
 *   request addresses under the cached document takes the same one fetch, so
 *   a missing key and a failed dereference share the interval. A failed fetch
 *   or verification is remembered for a short time.
 * - A DID URL target's version selector picks its version from the verified
 *   log kept on the cache entry, with no second fetch. That version is
 *   verified once per fetched log and selector set, and kept with the log.
 * - A first-contact fetch, of a DID with no verified head here, is counted
 *   against a per-host window and a global limit on concurrent fetches. Past
 *   either it is refused, not queued. A DID this resolver already verified
 *   is refreshed outside the host window, under a concurrency limit of its
 *   own, so DIDs nobody verified cannot crowd out a known DID's refresh.
 *   A known DID's refreshes stay bounded by the TTL and the key-miss
 *   interval.
 * - The default fetcher ({@link fetchPeerLog}) speaks `https` only, on the
 *   default port, follows no redirect, refuses a host that resolves to a
 *   private, loopback or link-local address, and connects only to the addresses
 *   it checked. The body is read as a stream and abandoned at the byte that
 *   crosses the size limit, under one timeout covering the whole fetch.
 *
 * The fetcher is injectable (the `peerLogFetcher` plugin option), since the
 * host bound keeps a real fetch out of the test suite.
 */
import type { FastifyBaseLogger } from 'fastify'
import { LRUCache } from 'lru-cache'
import { fetch, type Agent, type Dispatcher, type Response } from 'undici'
import { parseVersionId, readLogFromString } from '@interop/did-method-webvh'
import type { DIDDoc, DIDLog } from '@interop/did-method-webvh'

import {
  PEER_WEBVH_CACHE_MAX,
  PEER_WEBVH_CACHE_TTL,
  PEER_WEBVH_FAILURE_TTL,
  PEER_WEBVH_FETCH_TIMEOUT_MS,
  PEER_WEBVH_HOST_FETCH_LIMIT,
  PEER_WEBVH_HOST_FETCH_WINDOW,
  PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL,
  PEER_WEBVH_LOG_MAX_BYTES,
  PEER_WEBVH_MAX_CONCURRENT_FETCHES
} from '../config.default.js'
import { PeerLogFetchError, PeerWebvhResolutionError } from '../errors.js'
import { verifiedVersionOf } from './didUrlTarget.js'
import {
  pinnedAgentFor,
  readBodyBounded,
  resolvePublicHost,
  vetAddresses,
  type AddressRefusal,
  type ResolvedAddress
} from './outboundAddress.js'
import { parseCrossHostWebvh } from './validateDid.js'
import { isBlockedWebvh, type WebvhBlocklist } from './webvhBlocklist.js'
import {
  extendsHead,
  headOf,
  verifyWebvhLog,
  type LogHead,
  type TargetSelectors
} from './webvhController.js'

/**
 * Performs the HTTP GET of a foreign history log and resolves its body bytes.
 * It must not resolve more than `maxBytes` bytes, and should stop reading when
 * `signal` aborts. The resolver enforces both again on what it gets back.
 * Injected through the `peerLogFetcher` plugin option; {@link fetchPeerLog} is
 * the default.
 */
export type PeerLogFetcher = (options: {
  url: string
  maxBytes: number
  signal: AbortSignal
}) => Promise<Uint8Array>

/**
 * A verified foreign document, the log it was verified from, and the
 * monotonic time that log was fetched.
 */
interface PeerEntry {
  doc: DIDDoc
  log: DIDLog
  fetchedAt: number
}

/**
 * Resolves foreign `did:webvh` DIDs over the network, with the cache, rate
 * limits, blocklist and rollback check described in this module's header. One
 * instance per app, decorated as `fastify.peerWebvh`. Reached only through a
 * peer grant on a verification context.
 */
export class PeerWebvhResolver {
  #fetchLog: PeerLogFetcher
  #logger: FastifyBaseLogger
  #blocklist: WebvhBlocklist
  #documents = new LRUCache<string, PeerEntry>({ max: PEER_WEBVH_CACHE_MAX })
  /**
   * The head of the last log verified per DID. Kept apart from the documents
   * so it outlives a document's TTL.
   */
  #heads = new LRUCache<string, LogHead>({ max: PEER_WEBVH_CACHE_MAX })
  /**
   * DIDs whose last fetch or verification failed, each with that failure.
   */
  #failures = new LRUCache<string, Error>({
    max: PEER_WEBVH_CACHE_MAX,
    ttl: PEER_WEBVH_FAILURE_TTL
  })
  /**
   * DIDs that had an early fetch within the interval: a key miss, or a DID
   * URL root that did not dereference where a request required.
   */
  #keyMisses = new LRUCache<string, true>({
    max: PEER_WEBVH_CACHE_MAX,
    ttl: PEER_WEBVH_KEY_MISS_REFETCH_INTERVAL
  })
  /**
   * Monotonic start times of the recent fetches to each host.
   */
  #hostFetches = new LRUCache<string, number[]>({ max: PEER_WEBVH_CACHE_MAX })
  #inFlight = new Map<string, Promise<PeerEntry>>()
  /**
   * The number of fetches running now, for first-contact DIDs and for DIDs
   * with a verified head, counted apart.
   */
  #running = { firstContact: 0, known: 0 }

  /**
   * @param options {object}
   * @param options.fetchLog {PeerLogFetcher}   performs the log's HTTP GET
   * @param options.logger {FastifyBaseLogger}   logs failed fetches
   * @param options.blocklist {WebvhBlocklist}   the hosts and DIDs never
   *   fetched
   */
  constructor({
    fetchLog,
    logger,
    blocklist
  }: {
    fetchLog: PeerLogFetcher
    logger: FastifyBaseLogger
    blocklist: WebvhBlocklist
  }) {
    this.#fetchLog = fetchLog
    this.#logger = logger
    this.#blocklist = blocklist
  }

  /**
   * Whether this resolver may fetch the log of `did` at all: a `did:webvh` on
   * another host than this server's, of a shape the method maps to an
   * `https` URL on the default port, and not on the blocklist. Decides
   * nothing about the chain that names it, which the capability verifier
   * checks before it issues a grant.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}   this server's base URL
   * @returns {boolean}
   */
  mayFetch({ did, serverUrl }: { did: string; serverUrl: string }): boolean {
    const parsed = parseCrossHostWebvh(did, { serverUrl })
    return (
      parsed !== undefined &&
      !isBlockedWebvh({ blocklist: this.#blocklist, did, host: parsed.host })
    )
  }

  /**
   * Resolves a foreign DID to its verified document: from the cache while
   * the entry is within its TTL, otherwise by fetching and verifying the log.
   * @param options {object}
   * @param options.did {string}   a foreign `did:webvh`
   * @param options.serverUrl {string}   this server's base URL
   * @returns {Promise<DIDDoc>}
   */
  async resolve({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<DIDDoc> {
    const { entry } = await this.#current({ did, serverUrl })
    return entry.doc
  }

  /**
   * Resolves a foreign DID for a signature made with `keyId`. When the
   * cached document does not list that key, the log is fetched once more,
   * unless it was just fetched by this call or a key miss already forced a
   * fetch for this DID within the interval.
   * @param options {object}
   * @param options.did {string}   a foreign `did:webvh`
   * @param options.keyId {string}   the verification method the signature names
   * @param options.serverUrl {string}   this server's base URL
   * @returns {Promise<DIDDoc>}   a verified document listing `keyId`
   */
  async resolveKey({
    did,
    keyId,
    serverUrl
  }: {
    did: string
    keyId: string
    serverUrl: string
  }): Promise<DIDDoc> {
    const { entry, fetched } = await this.#current({ did, serverUrl })
    if (listsMethod({ doc: entry.doc, keyId })) {
      return entry.doc
    }
    if (fetched || this.#keyMisses.has(did)) {
      throw keyNotListed({ did, keyId })
    }
    const refreshed = await this.#refresh({ did, serverUrl, early: true })
    if (listsMethod({ doc: refreshed.doc, keyId })) {
      return refreshed.doc
    }
    throw keyNotListed({ did, keyId })
  }

  /**
   * Resolves a foreign DID for a DID URL invocation target, at the version
   * `selectors` names (the current one when there are none). The version is
   * picked from the verified log kept on the cache entry, so a selector costs
   * no fetch of its own, and verified from it once per fetched log and
   * selector set (`verifiedVersionOf`). A DID this resolver may not fetch
   * ({@link mayFetch}) is refused before any fetch.
   *
   * A selector naming a version after the cached log's last entry
   * ({@link namesVersionAfter}) is not resolved: the result says `ahead`, so
   * the caller may take the DID's early fetch and ask again. Every other
   * selector is answered from the cached log, or refused.
   * @param options {object}
   * @param options.did {string}   a foreign `did:webvh`
   * @param options.serverUrl {string}   this server's base URL
   * @param options.selectors {object}   the target's version selectors
   * @returns {Promise<{ ahead: false, doc: DIDDoc, fetched: boolean } |
   *   { ahead: true, fetched: boolean }>}   `fetched` is true when this call
   *   fetched the log
   */
  async resolveVersion({
    did,
    serverUrl,
    selectors
  }: {
    did: string
    serverUrl: string
    selectors: TargetSelectors
  }): Promise<
    | { ahead: false; doc: DIDDoc; fetched: boolean }
    | { ahead: true; fetched: boolean }
  > {
    if (!this.mayFetch({ did, serverUrl })) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'it is not a did:webvh this server may fetch.'
      })
    }
    const { entry, fetched } = await this.#current({ did, serverUrl })
    if (Object.keys(selectors).length === 0) {
      return { ahead: false, doc: entry.doc, fetched }
    }
    if (namesVersionAfter({ selectors, log: entry.log })) {
      return { ahead: true, fetched }
    }
    const { doc } = await verifiedVersionOf({ did, log: entry.log, selectors })
    return { ahead: false, doc, fetched }
  }

  /**
   * The cached current document of a foreign DID, when it is within its TTL,
   * read without a fetch and without touching the cache's recency.
   * @param options {object}
   * @param options.did {string}   a foreign `did:webvh`
   * @param options.serverUrl {string}   this server's base URL
   * @returns {DIDDoc | undefined}
   */
  cachedDocument({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): DIDDoc | undefined {
    if (!this.mayFetch({ did, serverUrl })) {
      return undefined
    }
    const cached = this.#documents.peek(did)
    if (
      cached === undefined ||
      performance.now() - cached.fetchedAt >= PEER_WEBVH_CACHE_TTL
    ) {
      return undefined
    }
    return cached.doc
  }

  /**
   * Whether a foreign DID's early fetch of the interval is spent (a key miss,
   * or a DID URL root that did not dereference where a request required).
   * @param options {object}
   * @param options.did {string}   a foreign `did:webvh`
   * @returns {boolean}
   */
  earlyFetchSpent({ did }: { did: string }): boolean {
    return this.#keyMisses.has(did)
  }

  /**
   * Fetches a foreign DID's log once more, when a DID URL root does not
   * dereference to the Space a request addresses under the cached document.
   * A DID gets one such early fetch per interval, shared with the key-miss
   * fetch of {@link resolveKey}.
   * @param options {object}
   * @param options.did {string}   a foreign `did:webvh`
   * @param options.serverUrl {string}   this server's base URL
   * @returns {Promise<boolean>}   whether a fresh document was fetched
   */
  async refetchOnMismatch({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<boolean> {
    if (!this.mayFetch({ did, serverUrl }) || this.#keyMisses.has(did)) {
      return false
    }
    await this.#refresh({ did, serverUrl, early: true })
    return true
  }

  /**
   * The cached entry when it is within its TTL, or a fresh one.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}
   * @returns {Promise<{ entry: PeerEntry, fetched: boolean }>}   `fetched` is
   *   true when this call fetched the log
   */
  async #current({
    did,
    serverUrl
  }: {
    did: string
    serverUrl: string
  }): Promise<{ entry: PeerEntry; fetched: boolean }> {
    const cached = this.#documents.get(did)
    if (
      cached !== undefined &&
      performance.now() - cached.fetchedAt < PEER_WEBVH_CACHE_TTL
    ) {
      return { entry: cached, fetched: false }
    }
    return { entry: await this.#refresh({ did, serverUrl }), fetched: true }
  }

  /**
   * Fetches and verifies the log, sharing one fetch among concurrent callers
   * for the same DID.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}
   * @param [options.early] {boolean}   the fetch is the DID's early fetch of
   *   the interval (see {@link #fetchAndVerify})
   * @returns {Promise<PeerEntry>}
   */
  async #refresh({
    did,
    serverUrl,
    early = false
  }: {
    did: string
    serverUrl: string
    early?: boolean
  }): Promise<PeerEntry> {
    const pending = this.#inFlight.get(did)
    if (pending !== undefined) {
      return await pending
    }
    const work = this.#fetchAndVerify({ did, serverUrl, early })
    this.#inFlight.set(did, work)
    try {
      return await work
    } finally {
      this.#inFlight.delete(did)
    }
  }

  /**
   * One fetch and verification of a foreign log. A failure drops the cached
   * document, so a stale one is never served in place of a failed refresh,
   * and is remembered for {@link PEER_WEBVH_FAILURE_TTL}. A blocked DID is
   * refused before any of that. The capability verifier already gives one no
   * grant, so this restates the bound where the fetch is made. A
   * first-contact fetch must fit the host window and the first-contact
   * concurrency limit; a known DID's fetch must fit the known concurrency
   * limit. A refusal by either limit is not remembered.
   *
   * An early fetch (a key miss, or a DID URL root that did not dereference
   * where a request required) spends the DID's early fetch of the interval
   * only once every check above has passed, right before the fetch starts,
   * with no await between the check of the budget and its use. A fetch
   * those checks refuse leaves the budget unspent.
   * @param options {object}
   * @param options.did {string}
   * @param options.serverUrl {string}
   * @param options.early {boolean}   the fetch is an early fetch
   * @returns {Promise<PeerEntry>}
   */
  async #fetchAndVerify({
    did,
    serverUrl,
    early
  }: {
    did: string
    serverUrl: string
    early: boolean
  }): Promise<PeerEntry> {
    const parsed = parseCrossHostWebvh(did, { serverUrl })
    if (parsed === undefined) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'it is not a did:webvh on another host.'
      })
    }
    if (
      isBlockedWebvh({ blocklist: this.#blocklist, did, host: parsed.host })
    ) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'it is on the blocklist.'
      })
    }
    const failure = this.#failures.get(did)
    if (failure !== undefined) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'its last fetch failed, and is not retried yet.',
        cause: failure
      })
    }
    // A concurrent caller may have spent it since this one checked. From
    // here to the fetch nothing is awaited.
    if (early && this.#keyMisses.has(did)) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'its early fetch of the interval is spent.'
      })
    }
    const kind = this.#heads.has(did) ? 'known' : 'firstContact'
    if (this.#running[kind] >= PEER_WEBVH_MAX_CONCURRENT_FETCHES) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'too many peer log fetches are running.'
      })
    }
    if (
      kind === 'firstContact' &&
      !this.#takeHostFetch({ host: parsed.host })
    ) {
      throw new PeerWebvhResolutionError({
        did,
        detail: `too many log fetches to "${parsed.host}" in the window.`
      })
    }
    if (early) {
      this.#keyMisses.set(did, true)
    }
    this.#running[kind]++
    try {
      const log = await this.#fetchLogOf({ did, url: parsed.logUrl })
      if (!extendsHead({ log, head: this.#heads.get(did) })) {
        throw new PeerWebvhResolutionError({
          did,
          detail: 'the log does not extend the last version verified here.'
        })
      }
      const { doc, deactivated } = await verifyWebvhLog({ did, log })
      if (deactivated) {
        throw new PeerWebvhResolutionError({
          did,
          detail: 'the DID has been deactivated.'
        })
      }
      // The log extends the recorded head, so this only moves it forward.
      this.#heads.set(did, headOf(log))
      const entry = { doc, log, fetchedAt: performance.now() }
      this.#documents.set(did, entry)
      return entry
    } catch (err) {
      this.#documents.delete(did)
      this.#failures.set(did, err as Error)
      this.#logger.warn({ err, did }, 'Could not resolve a foreign DID.')
      throw err instanceof PeerWebvhResolutionError
        ? err
        : new PeerWebvhResolutionError({
            did,
            detail: 'its history log could not be fetched or verified.',
            cause: err
          })
    } finally {
      this.#running[kind]--
    }
  }

  /**
   * Fetches a foreign log under the timeout and size limit, and parses it.
   * @param options {object}
   * @param options.did {string}
   * @param options.url {string}   the log URL the DID maps to
   * @returns {Promise<DIDLog>}
   */
  async #fetchLogOf({
    did,
    url
  }: {
    did: string
    url: string
  }): Promise<DIDLog> {
    const signal = AbortSignal.timeout(PEER_WEBVH_FETCH_TIMEOUT_MS)
    const bytes = await withDeadline({
      work: this.#fetchLog({
        url,
        maxBytes: PEER_WEBVH_LOG_MAX_BYTES,
        signal
      }),
      signal,
      url
    })
    if (bytes.byteLength > PEER_WEBVH_LOG_MAX_BYTES) {
      throw new PeerLogFetchError({
        url,
        detail: `the log is larger than ${PEER_WEBVH_LOG_MAX_BYTES} bytes.`
      })
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (err) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'the log is not UTF-8.',
        cause: err
      })
    }
    try {
      return readLogFromString(text)
    } catch (err) {
      throw new PeerWebvhResolutionError({
        did,
        detail: 'the log is not valid JSON Lines.',
        cause: err
      })
    }
  }

  /**
   * Counts a first-contact fetch to `host` against the window, or reports
   * that the host is at its limit.
   * @param options {object}
   * @param options.host {string}
   * @returns {boolean}   whether the fetch may start
   */
  #takeHostFetch({ host }: { host: string }): boolean {
    const now = performance.now()
    const recent = (this.#hostFetches.get(host) ?? []).filter(
      startedAt => now - startedAt < PEER_WEBVH_HOST_FETCH_WINDOW
    )
    const allowed = recent.length < PEER_WEBVH_HOST_FETCH_LIMIT
    if (allowed) {
      recent.push(now)
    }
    this.#hostFetches.set(host, recent)
    return allowed
  }
}

/**
 * Whether version selectors name a version after a log's last entry, one a
 * longer log could hold. A log only grows, so these are the selectors a fresh
 * fetch could answer where the cached log cannot:
 *
 * - `versionNumber` greater than the number of entries;
 * - a well-formed `versionId` whose version number is greater than the number
 *   of entries. A malformed one names no version, so it is not ahead.
 *
 * A `versionId` or `versionNumber` within the log's length names an entry it
 * already holds or one no longer log can hold (another entry hash at that
 * number), so it is answered from the cached log or refused. A `versionTime`
 * is never ahead: a time after the last entry is answered by the last cached
 * entry, the version current at that time as far as the log shows, and a time
 * before the first entry names no version.
 * @param options {object}
 * @param options.selectors {object}   the target's version selectors
 * @param options.log {DIDLog}   the cached verified log
 * @returns {boolean}
 */
function namesVersionAfter({
  selectors,
  log
}: {
  selectors: TargetSelectors
  log: DIDLog
}): boolean {
  const { versionNumber, versionId } = selectors
  if (typeof versionNumber === 'number' && versionNumber > log.length) {
    return true
  }
  if (typeof versionId !== 'string') {
    return false
  }
  try {
    return parseVersionId(versionId).versionNumber > log.length
  } catch {
    return false
  }
}

/**
 * Whether a document lists `keyId` in its `verificationMethod` array. Which
 * relationship the key is under is checked later, by the invocation proof
 * purpose, against the same document.
 * @param options {object}
 * @param options.doc {DIDDoc}
 * @param options.keyId {string}
 * @returns {boolean}
 */
function listsMethod({ doc, keyId }: { doc: DIDDoc; keyId: string }): boolean {
  return (doc.verificationMethod ?? []).some(method => method.id === keyId)
}

/**
 * The refusal for a signature whose key the resolved document does not list.
 * @param options {object}
 * @param options.did {string}
 * @param options.keyId {string}
 * @returns {PeerWebvhResolutionError}
 */
function keyNotListed({
  did,
  keyId
}: {
  did: string
  keyId: string
}): PeerWebvhResolutionError {
  return new PeerWebvhResolutionError({
    did,
    detail: `the document does not list "${keyId}".`
  })
}

/**
 * Settles with `work`, or rejects when `signal` aborts first. An injected
 * fetcher that ignores the signal is still cut off at the deadline, and its
 * late result is dropped.
 * @param options {object}
 * @param options.work {Promise<T>}
 * @param options.signal {AbortSignal}
 * @param options.url {string}   the fetched URL, for the error
 * @returns {Promise<T>}
 */
async function withDeadline<T>({
  work,
  signal,
  url
}: {
  work: Promise<T>
  signal: AbortSignal
  url: string
}): Promise<T> {
  // The late outcome of work cut off by the deadline is not anyone's to see.
  work.catch(() => {})
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        new PeerLogFetchError({
          url,
          detail: 'the fetch timed out.',
          cause: signal.reason
        })
      )
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Checks a peer log URL before any lookup: `https`, the default port, and no
 * credentials. The resolver builds the URL from a DID whose host already
 * excludes a port, so this restates the bound where the request is made.
 * @param options {object}
 * @param options.url {string}
 * @returns {URL}   the parsed URL
 */
export function checkPeerLogUrl({ url }: { url: string }): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (err) {
    throw new PeerLogFetchError({ url, detail: 'not a URL.', cause: err })
  }
  if (parsed.protocol !== 'https:') {
    throw new PeerLogFetchError({ url, detail: 'only https is fetched.' })
  }
  if (parsed.port !== '') {
    throw new PeerLogFetchError({ url, detail: 'only the default port.' })
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new PeerLogFetchError({ url, detail: 'credentials are refused.' })
  }
  return parsed
}

/**
 * Checks the addresses a peer host resolved to: there must be at least one,
 * and none may be private, loopback, link-local, unique-local, multicast or
 * otherwise non-public (which covers the `169.254.169.254` cloud metadata
 * address). A host with one such address is refused whole.
 * @param options {object}
 * @param options.url {string}   the fetched URL, for the error
 * @param options.addresses {ResolvedAddress[]}
 * @returns {void}
 */
export function assertPublicAddresses({
  url,
  addresses
}: {
  url: string
  addresses: ResolvedAddress[]
}): void {
  const refusal = vetAddresses(addresses)
  if (refusal !== undefined) {
    throw addressRefusalError({ url, refusal })
  }
}

/**
 * The `PeerLogFetchError` for a host whose addresses were refused.
 * @param options {object}
 * @param options.url {string}   the fetched URL, for the error
 * @param options.refusal {AddressRefusal}   a `no-address` or `blocked` refusal
 * @returns {PeerLogFetchError}
 */
function addressRefusalError({
  url,
  refusal
}: {
  url: string
  refusal: Exclude<AddressRefusal, { refusal: 'unresolved' }>
}): PeerLogFetchError {
  if (refusal.refusal === 'no-address') {
    return new PeerLogFetchError({ url, detail: 'the host has no address.' })
  }
  return new PeerLogFetchError({
    url,
    detail: `the host resolves to a non-public address (${refusal.address}).`
  })
}

/**
 * The shared setup of an outbound request to a peer: checks the URL, resolves
 * its host and checks every address, then builds an agent that connects only
 * to those addresses, so a DNS answer that changes after the check is never
 * used. Both peer fetchers (the log fetch below and `sync/peerFetch.ts`) go
 * through it, so this safety code exists once. A refused URL or address
 * rejects with `PeerLogFetchError`. Any other rejection is the lookup's own
 * failure, which the caller words.
 * @param options {object}
 * @param options.url {string}
 * @returns {Promise<{ href: string, agent: Agent, release: () => void }>}
 *   `release` closes the one-request agent, and is called once the response
 *   has been read or abandoned
 */
export async function openPinnedAgent({ url }: { url: string }): Promise<{
  href: string
  agent: Agent
  release: () => void
}> {
  const parsed = checkPeerLogUrl({ url })
  const resolved = await resolvePublicHost({ url: parsed })
  if ('refusal' in resolved) {
    if (resolved.refusal === 'unresolved') {
      // The lookup's own failure, which the caller words.
      throw resolved.cause
    }
    throw addressRefusalError({ url, refusal: resolved })
  }
  const agent = pinnedAgentFor(resolved)
  const release = (): void => {
    agent.destroy().catch(() => {
      // best-effort teardown of a one-request agent
    })
  }
  return { href: parsed.href, agent, release }
}

/**
 * The default {@link PeerLogFetcher}. Makes the GET through the agent
 * {@link openPinnedAgent} builds. The agent is closed after the one fetch.
 * @param options {object}
 * @param options.url {string}
 * @param options.maxBytes {number}
 * @param options.signal {AbortSignal}
 * @returns {Promise<Uint8Array>}
 */
export async function fetchPeerLog({
  url,
  maxBytes,
  signal
}: {
  url: string
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  let pinned: Awaited<ReturnType<typeof openPinnedAgent>>
  try {
    pinned = await openPinnedAgent({ url })
  } catch (err) {
    if (err instanceof PeerLogFetchError) {
      throw err
    }
    throw new PeerLogFetchError({
      url,
      detail: 'the host does not resolve.',
      cause: err
    })
  }
  try {
    return await readBoundedResponse({
      url: pinned.href,
      dispatcher: pinned.agent,
      maxBytes,
      signal
    })
  } finally {
    pinned.release()
  }
}

/**
 * Makes the GET and reads the body up to `maxBytes`. A redirect is refused
 * rather than followed, as is any status other than 200. A declared
 * `Content-Length` over the limit is refused before the body is read, and an
 * undeclared one is abandoned at the byte that crosses it. Exported for the
 * unit tests, which drive it against a local server through a plain agent.
 * @param options {object}
 * @param options.url {string}
 * @param options.dispatcher {Dispatcher}   the agent to connect through
 * @param options.maxBytes {number}
 * @param options.signal {AbortSignal}   aborts the connection and the read
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedResponse({
  url,
  dispatcher,
  maxBytes,
  signal
}: {
  url: string
  dispatcher: Dispatcher
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal,
      dispatcher,
      headers: { accept: 'text/jsonl', 'accept-encoding': 'identity' }
    })
  } catch (err) {
    throw new PeerLogFetchError({
      url,
      detail: 'the request failed.',
      cause: err
    })
  }
  const refuse = async (detail: string) => {
    await response.body?.cancel().catch(() => {})
    return new PeerLogFetchError({ url, detail })
  }
  if (response.status >= 300 && response.status < 400) {
    throw await refuse(`a redirect (${response.status}) is not followed.`)
  }
  if (response.status !== 200) {
    throw await refuse(`the host answered ${response.status}.`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw await refuse(`the log is larger than ${maxBytes} bytes.`)
  }
  let body: Buffer | undefined
  try {
    body = await readBodyBounded({ body: response.body, maxBytes })
  } catch (err) {
    throw new PeerLogFetchError({
      url,
      detail: 'the body could not be read.',
      cause: err
    })
  }
  if (body === undefined) {
    throw new PeerLogFetchError({
      url,
      detail: `the log is larger than ${maxBytes} bytes.`
    })
  }
  return body
}
