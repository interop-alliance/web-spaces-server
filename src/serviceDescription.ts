/**
 * The service description (spec "Service Description"): the server-wide JSON
 * document naming the specification versions this server speaks, its Spaces
 * Repository URL, and the optional sections it implements. It lists six
 * entries: the core specification, whose entry also carries the store's origin
 * id (`lib/originId.ts`) and the server's own DID; the zCap authorization
 * profile, whose entry carries the signature algorithms and delegation
 * cryptosuites this server verifies; the Encrypted Collections profile, whose
 * entry claims the chunk endpoints and names the two optional affordances of
 * that profile this server serves; the client annex profile, whose entry
 * claims the client-annex delegation clause and carries `version` alone; the
 * replication specification, whose entry claims the `replicas` registration,
 * the pull loop and the apply path; and the Portable Wallet Profile, whose
 * entry is the claim that the core and Encrypted Collections entries carry
 * every token a wallet needs. It is served unauthenticated at `/service`, and
 * every response the server sends links to it with a
 * `Link: <...>; rel="service"` header, which is how a client finds it from any
 * URL it holds. The document has no auth hooks; it depends on `serverUrl`, the
 * configuration the plugin was registered with, the active backend's
 * `originId`, and one storage read: whether the server's own history log lists
 * its export-signing key (`lib/serverIdentity.ts`), which decides the core
 * entry's `serverDid`. The origin id and the server DID sit on the core entry
 * rather than on `instance` because a client may gate on them (a replication
 * peer on the origin id, a controller delegating a pull capability on the
 * DID), and the spec forbids a client gating on `instance`.
 */
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  AUTHZ_PROFILE_IDENTIFIER,
  AUTHZ_PROFILE_URL,
  AUTHZ_PROFILE_VERSION,
  CLIENT_ANNEX_IDENTIFIER,
  CLIENT_ANNEX_VERSION,
  ENCRYPTED_COLLECTIONS_IDENTIFIER,
  ENCRYPTED_COLLECTIONS_URL,
  ENCRYPTED_COLLECTIONS_VERSION,
  PACKAGE_INSTANCE,
  REPLICATION_IDENTIFIER,
  REPLICATION_URL,
  REPLICATION_VERSION,
  SERVER_VERSION,
  SERVICE_DESCRIPTION_MAX_AGE,
  SERVICE_LINK_RELATION,
  SPEC_IDENTIFIER,
  SPEC_VERSION,
  WALLET_PROFILE_IDENTIFIER,
  WALLET_PROFILE_URL,
  WALLET_PROFILE_VERSION
} from './config.default.js'
import { asList } from './lib/chainCapability.js'
import { absoluteUrl, serviceDescriptionPath, spacesPath } from './lib/paths.js'
import { resolveServerDid } from './lib/serverIdentity.js'
import type {
  AuthzProfileVersionEntry,
  PwsVersionEntry,
  EncryptedCollectionsVersionEntry,
  ServiceDescription,
  ServiceDescriptionVersionEntry
} from './types.js'
import { notModifiedReply } from './requests/notModified.js'
import {
  delegationProofCryptosuites,
  INVOCATION_SIGNATURE_ALGORITHMS
} from './zcap.js'

/**
 * The optional sections of the core specification this server implements, as
 * `features` tokens. No configuration switch this server offers disables one
 * of them, so the list is the same for every deployment. Guarantees every
 * backend provides -- conditional writes, key epochs -- are baseline
 * requirements rather than tokens, and the affordances of the Encrypted
 * Collections profile belong to {@link ENCRYPTED_COLLECTIONS_FEATURES}.
 *
 * - `encryption`: the Collection `encryption` descriptor (spec "Encryption
 *   Scheme Registry"): the `edv` scheme is recognized, every Resource and
 *   `custom` write into a Collection declaring it is validated against the
 *   envelope profile (`encryption-scheme-mismatch`), an unrecognized scheme or
 *   version is refused (`unsupported-encryption-scheme`), the descriptor is
 *   creation-only and version-monotonic (`encryption-immutable`), and its
 *   key-epoch and `hmac` members are checked (`lib/encryption.ts`).
 * - `created-by`: the server records `createdBy` on every Resource,
 *   Collection, and Space created under a capability invocation
 *   (`invokerDid`). A create the provisioning policy granted verifies no
 *   signature and records none.
 */
const SERVICE_FEATURES = [
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
] as const

/**
 * The optional affordances of the Encrypted Collections profile this server
 * serves, as the `features` tokens of that profile's version entry (profile
 * "Feature tokens"). The chunk endpoints are not among them: listing the entry
 * at all is the claim that they are served.
 *
 * - `blinded-index-query`: the `blinded-index` query profile over a
 *   Collection's blinded tokens, with the `unique` constraint enforced.
 * - `governed-history-logs`: the `meta/log` sub-resource, with the Collection's
 *   served `encryption` member derived from the log's head entry.
 */
export const ENCRYPTED_COLLECTIONS_FEATURES = [
  'blinded-index-query',
  'governed-history-logs'
] as const

/**
 * Throws unless every `required` token is in the `served` list of the entry
 * `identifier` names. `required` is typed from `served`, so a token the
 * server does not serve is a type error first and a refusal to start second.
 * @param options {object}
 * @param options.identifier {string}
 * @param options.served {readonly string[]}
 * @param options.required {readonly string[]}
 * @returns {void}
 */
function assertServed<Token extends string>({
  identifier,
  served,
  required
}: {
  identifier: string
  served: readonly Token[]
  required: readonly NoInfer<Token>[]
}): void {
  const missing = required.filter(token => !served.includes(token))
  if (missing.length > 0) {
    throw new Error(
      `The ${WALLET_PROFILE_IDENTIFIER} entry requires ${identifier} ` +
        `tokens this server does not serve: ${missing.join(', ')}`
    )
  }
}

// The Portable Wallet Profile's "Server requirements", restated from the
// profile text: the tokens the core entry (at `SPEC_VERSION`) and the
// Encrypted Collections entry (at `ENCRYPTED_COLLECTIONS_VERSION`) carry
// when the profile's entry is listed. The profile forbids listing it while
// one is missing. A profile version that pins other versions or another token
// set is a new pair of calls.
assertServed({
  identifier: SPEC_IDENTIFIER,
  served: SERVICE_FEATURES,
  required: [
    'listing',
    'collection-management',
    'space-management',
    'policy',
    'export',
    'encryption',
    'changes-query'
  ]
})
assertServed({
  identifier: ENCRYPTED_COLLECTIONS_IDENTIFIER,
  served: ENCRYPTED_COLLECTIONS_FEATURES,
  required: ['blinded-index-query', 'governed-history-logs']
})

/**
 * The absolute URL of the service description for a server base URL.
 * @param serverUrl {string}
 * @returns {string}
 */
export function serviceDescriptionUrl(serverUrl: string): string {
  return absoluteUrl({ path: serviceDescriptionPath(), serverUrl })
}

/**
 * Builds the service description for a server base URL. Every URL in it is
 * absolute, built from `serverUrl`.
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.originId {string}   the store's origin id, carried on the
 *   core specification's entry
 * @param options.discloseVersion {boolean}   include `instance.version`
 * @param [options.identity] {object}   the server's identity members:
 *   `exportSigningMethod` goes under `instance`, `serverDid` on the core
 *   specification's entry; absent members are left out
 * @returns {ServiceDescription}
 */
export function buildServiceDescription({
  serverUrl,
  originId,
  discloseVersion,
  identity = {}
}: {
  serverUrl: string
  originId: string
  discloseVersion: boolean
  identity?: { exportSigningMethod?: string; serverDid?: string }
}): ServiceDescription {
  return {
    url: serviceDescriptionUrl(serverUrl),
    specs: {
      [SPEC_IDENTIFIER]: [
        {
          version: SPEC_VERSION,
          spaces: absoluteUrl({ path: spacesPath(), serverUrl }),
          features: [...SERVICE_FEATURES],
          originId,
          // A controller delegates the pull capability to the server DID, so
          // a client gates on it. It sits here, beside `originId`, rather
          // than under `instance`.
          ...(identity.serverDid !== undefined && {
            serverDid: identity.serverDid
          })
        } satisfies PwsVersionEntry
      ],
      [AUTHZ_PROFILE_IDENTIFIER]: [
        {
          version: AUTHZ_PROFILE_VERSION,
          url: AUTHZ_PROFILE_URL,
          signatureAlgorithms: INVOCATION_SIGNATURE_ALGORITHMS,
          zcapCryptosuites: delegationProofCryptosuites()
        } satisfies AuthzProfileVersionEntry
      ],
      [ENCRYPTED_COLLECTIONS_IDENTIFIER]: [
        {
          version: ENCRYPTED_COLLECTIONS_VERSION,
          url: ENCRYPTED_COLLECTIONS_URL,
          features: [...ENCRYPTED_COLLECTIONS_FEATURES]
        } satisfies EncryptedCollectionsVersionEntry
      ],
      // A conformance claim with nothing further to advertise, so the entry
      // carries `version` alone.
      [CLIENT_ANNEX_IDENTIFIER]: [
        {
          version: CLIENT_ANNEX_VERSION
        } satisfies ServiceDescriptionVersionEntry
      ],
      // Listing the entry is the claim that replication is served. A peer's
      // registration check reads it, beside `originId` on the core entry.
      [REPLICATION_IDENTIFIER]: [
        {
          version: REPLICATION_VERSION,
          url: REPLICATION_URL
        } satisfies ServiceDescriptionVersionEntry
      ],
      // A conformance claim over the core and Encrypted Collections entries,
      // checked above when the module loads. The profile admits `version` and
      // `url` only; a client treats an entry with any other member as absent.
      [WALLET_PROFILE_IDENTIFIER]: [
        {
          version: WALLET_PROFILE_VERSION,
          url: WALLET_PROFILE_URL
        } satisfies ServiceDescriptionVersionEntry
      ]
    },
    instance: {
      name: PACKAGE_INSTANCE.name,
      ...(discloseVersion && { version: SERVER_VERSION }),
      source: PACKAGE_INSTANCE.source,
      homepage: PACKAGE_INSTANCE.homepage,
      ...(identity.exportSigningMethod !== undefined && {
        exportSigningMethod: identity.exportSigningMethod
      })
    }
  }
}

/**
 * Adds the global `onSend` hook that puts the `service` link on every response:
 * successes, errors from any error handler, 404s for unmatched routes,
 * redirects, and CORS preflights alike. The hook appends to a `Link` header a
 * handler already set rather than replacing it. It must be called on the root
 * instance (or inside a `fastify-plugin`-wrapped plugin) so the hook reaches
 * every route and the not-found handler.
 * @param fastify {FastifyInstance}
 * @returns {void}
 */
export function addServiceLinkHook(fastify: FastifyInstance): void {
  // The link is a function of `serverUrl` alone, so it is rebuilt only when
  // that changes (the test helpers reassign it after `listen()`).
  let linkFor: string | undefined
  let serviceLink = ''
  fastify.addHook('onSend', async (request, reply, payload) => {
    const { serverUrl } = request.server
    if (linkFor !== serverUrl) {
      linkFor = serverUrl
      serviceLink =
        `<${serviceDescriptionUrl(serverUrl)}>; ` +
        `rel="${SERVICE_LINK_RELATION}"`
    }
    const existing = reply.getHeader('link')
    if (existing === undefined) {
      reply.header('link', serviceLink)
    } else {
      const links = asList(existing).map(String)
      reply.header('link', [...links, serviceLink].join(', '))
    }
    return payload
  })
}

/**
 * Registers `GET /service` (and Fastify's implicit bodyless `HEAD`). The
 * serialized document and its `ETag` are computed once per `serverUrl` and
 * server DID, since the document changes with nothing else: the store's origin
 * id is fixed for the backend's life. The DID is read per request through the
 * cached resolver, because the admin writes the server's history log after
 * boot.
 * @param fastify {FastifyInstance}
 * @param options {object}
 * @param options.discloseVersion {boolean}   include `instance.version`
 * @returns {Promise<void>}
 */
export async function initServiceDescriptionRoutes(
  fastify: FastifyInstance,
  { discloseVersion }: { discloseVersion: boolean }
): Promise<void> {
  let cached:
    | {
        serverUrl: string
        did: string | undefined
        body: string
        etag: string
      }
    | undefined

  fastify.get(
    serviceDescriptionPath(),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { serverUrl, serverSigningKey, storage, serverBackends } =
        request.server
      const did =
        serverSigningKey === undefined
          ? undefined
          : await resolveServerDid({
              storage,
              serverBackends,
              serverUrl,
              signingKey: serverSigningKey,
              logger: request.log
            })
      if (
        cached === undefined ||
        cached.serverUrl !== serverUrl ||
        cached.did !== did
      ) {
        const body = JSON.stringify(
          buildServiceDescription({
            serverUrl,
            originId: storage.originId,
            discloseVersion,
            identity: {
              exportSigningMethod: serverSigningKey?.exportSigningMethod,
              serverDid: did
            }
          })
        )
        const digest = createHash('sha256').update(body).digest('base64url')
        cached = { serverUrl, did, body, etag: `"${digest}"` }
      }
      reply.header(
        'cache-control',
        `public, max-age=${SERVICE_DESCRIPTION_MAX_AGE}`
      )
      return (
        notModifiedReply({ request, reply, etag: cached.etag }) ??
        reply
          .status(200)
          .header('etag', cached.etag)
          .type('application/json')
          .send(cached.body)
      )
    }
  )
}
