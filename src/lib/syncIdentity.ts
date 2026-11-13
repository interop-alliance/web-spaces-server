/**
 * The signer a server invokes a peer's capabilities with when it replicates a
 * Space. It is the server identity's one seed key, named as the `did:webvh`
 * method `{serverDid}#{publicKeyMultibase}`, the same method export
 * provenance signs with. A controller delegates the pull capability to
 * `serverDid`, so a peer verifies the invocation against the server's
 * published history log.
 *
 * The admin enables this by listing the key under `capabilityInvocation` in
 * that log, beside `assertionMethod`. Without a `serverDid`, or without that
 * relationship, there is no signer, and the result says which is missing.
 * There is no `did:key` form: a server with no identity cannot replicate.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { ISigner } from '@interop/data-integrity-core'
import type { DIDDoc } from '@interop/did-method-webvh'
import type { StorageBackend } from '../types.js'
import type { ServerBackends } from './serverBackends.js'
import {
  resolveServerIdentity,
  serverKeyPair,
  serverMethodId
} from './serverIdentity.js'
import type { ServerSigningKey } from './serverIdentity.js'
import { relationshipMethodIds } from './webvhController.js'

/**
 * Loads the signer for sync invocations, or says why the server has none.
 *
 * The server must advertise a `serverDid` (the check `/service` makes), and
 * the resolved current document of its log must list the seed key as the
 * method `{serverDid}#{publicKeyMultibase}` under `capabilityInvocation`. The
 * returned signer's `id` is that method, so a source server verifies its
 * signature against this server's own log.
 *
 * Both checks read one judged log version. `resolveServerIdentity` hands back
 * the DID and the document it was judged from together, memoized on the log
 * Resource's `ETag`. A call while the log stands still costs one metadata
 * read; it runs once per pull cycle and once per replica registration.
 *
 * A refusal says why the server has no sync signer. `no-server-did`: no
 * `WAS_SERVER_KEY_SEED` is set, or `/service` advertises no `serverDid`.
 * `no-capability-invocation`: the server's history log does not list the key
 * under `capabilityInvocation`. `reason` says the same for a person to read.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the control plane
 * @param options.serverBackends {ServerBackends}   the set `storage` is the
 *   control plane of
 * @param options.serverUrl {string}
 * @param [options.signingKey] {ServerSigningKey}   the key derived from
 *   `WAS_SERVER_KEY_SEED`, absent when the seed is unset
 * @param options.logger {FastifyBaseLogger}   for the identity check's own
 *   once-per-log-version warnings
 * @returns {Promise<{ serverDid: string, signer: ISigner } | { refusal: string, reason: string }>}
 * @throws {ProblemError}   a storage fault met while reading the log (5xx),
 *   which is not a refusal
 */
export async function loadSyncSigner({
  storage,
  serverBackends,
  serverUrl,
  signingKey,
  logger
}: {
  storage: StorageBackend
  serverBackends: ServerBackends
  serverUrl: string
  signingKey: ServerSigningKey | undefined
  logger: FastifyBaseLogger
}): Promise<
  | { serverDid: string; signer: ISigner }
  | { refusal: 'no-server-did' | 'no-capability-invocation'; reason: string }
> {
  if (signingKey === undefined) {
    return {
      refusal: 'no-server-did',
      reason:
        'The server has no identity: WAS_SERVER_KEY_SEED is not set, so it ' +
        'advertises no serverDid.'
    }
  }
  const identity = await resolveServerIdentity({
    storage,
    serverBackends,
    serverUrl,
    signingKey,
    logger
  })
  if (identity === undefined) {
    return {
      refusal: 'no-server-did',
      reason:
        'The server advertises no serverDid: no verifying server history ' +
        'log lists its key under "assertionMethod".'
    }
  }
  const { serverDid, doc } = identity
  const { publicKeyMultibase } = signingKey.keyPair
  const methodId = serverMethodId({ serverDid, signingKey })
  if (!listsInvocationMethod({ doc, methodId, publicKeyMultibase })) {
    return {
      refusal: 'no-capability-invocation',
      reason:
        'The server history log does not list the server key under ' +
        `"capabilityInvocation" as "${methodId}".`
    }
  }
  return {
    serverDid,
    signer: serverKeyPair({ serverDid, signingKey }).signer()
  }
}

/**
 * Whether the document carries the method `methodId` with the server key and
 * names it under `capabilityInvocation`, the check a peer's verifier makes on
 * an invocation signed by that method. A relationship entry is an id string,
 * absolute or `#fragment`-relative, or an embedded method object.
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved current document
 * @param options.methodId {string}   `{serverDid}#{publicKeyMultibase}`
 * @param options.publicKeyMultibase {string}   the server key
 * @returns {boolean}
 */
function listsInvocationMethod({
  doc,
  methodId,
  publicKeyMultibase
}: {
  doc: DIDDoc
  methodId: string
  publicKeyMultibase: string
}): boolean {
  const docId = doc.id ?? ''
  const absolute = (id: string): string =>
    id.startsWith('#') ? `${docId}${id}` : id
  const carriesKey = (doc.verificationMethod ?? []).some(
    method =>
      typeof method.id === 'string' &&
      absolute(method.id) === methodId &&
      method.publicKeyMultibase === publicKeyMultibase
  )
  const named = relationshipMethodIds({
    entries: doc.capabilityInvocation,
    docId
  }).includes(methodId)
  return carriesKey && named
}
