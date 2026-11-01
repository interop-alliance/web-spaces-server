/**
 * PostgreSQL schema for the `PostgresBackend`: an ordered list of migrations
 * (SQL scripts, and one step that checks the data before it reshapes the
 * schema) plus the tiny hand-rolled runner that applies them idempotently
 * (inside an advisory-locked transaction) on backend `open()`. The whole
 * schema is readable in this one file; there is no external migration tool.
 *
 * Collation note: every identifier or ISO-8601 timestamp column that
 * participates in an `ORDER BY` or keyset `>` comparison is declared
 * `COLLATE "C"` (byte order, which for UTF-8 is code-point order) so Postgres
 * ordering agrees with the JS code-unit comparisons the filesystem backend and
 * the pagination cursors use. (The two orders could theoretically diverge for
 * supplementary-plane characters -- unreachable here because the request layer
 * validates ids as URL-safe ASCII.) Timestamps are stored as the fixed-width
 * ISO-8601 strings the wire model uses (`new Date().toISOString()`), not
 * `timestamptz`, so they round-trip byte-identically. A write stamp's
 * `updatedAt` is the ISO string of its hybrid-logical-clock millisecond, so
 * the text column holds that millisecond exactly.
 */
import type { FastifyBaseLogger } from 'fastify'
import type pg from 'pg'
import { StoreOriginIdError, StoreVersionError } from '../errors.js'
import {
  isValidOriginId,
  settleOriginId as settleStoreOriginId
} from '../lib/originId.js'

/**
 * One schema migration: a SQL script, or a function run on the migrating
 * transaction's client for a step that must decide something before it
 * changes the schema (it refuses by throwing, which rolls the whole run
 * back).
 */
export type Migration = string | ((client: pg.PoolClient) => Promise<void>)

/**
 * Ordered migrations. Version `n` is `MIGRATIONS[n - 1]`; append only, never
 * edit an applied entry. Exported so a test can build a schema at an earlier
 * version.
 */
export const MIGRATIONS: Migration[] = [
  // v1: the full PWS + WebKMS + chunked-storage surface. (The 'description'
  // columns its comments describe were renamed by v6.)
  `
  -- The Spaces tree. 'description' is NULL for a placeholder row created by a
  -- write below the Space level (a resource/policy write to a Space whose
  -- description was never written) -- the analogue of a Space directory
  -- without a '.space.meta.' file; getSpaceDescription treats it as absent.
  -- 'usage_bytes' is the transactional quota counter (spec "Quotas"),
  -- maintained in the same transaction as every content write and delete.
  -- 'controller' denormalizes the Space controller (also present as
  -- description->>'controller') onto its own indexed column, keeping the
  -- per-controller COUNT(*) for the Spaces count quota cheap and lockable;
  -- writeSpace maintains it on every insert and update.
  CREATE TABLE spaces (
    space_id    text COLLATE "C" PRIMARY KEY,
    description jsonb,
    usage_bytes bigint NOT NULL DEFAULT 0,
    controller  text
  );
  CREATE INDEX spaces_controller_idx ON spaces (controller);

  -- 'description_generation' and 'description_version' are the two parts of
  -- the Collection Description ETag validator behind conditional (If-Match)
  -- Description writes, so concurrent recipient edits compare-and-swap
  -- instead of clobbering. The generation is the opaque marker minted by the
  -- FIRST real description write and kept for the Collection's whole life; it
  -- is NULL on a placeholder row, which has no description to validate yet. A
  -- Collection deleted and re-created under the same id mints a new one, so
  -- the two lives' validators can never coincide. The version is the
  -- monotonic counter writeCollection bumps on every write. Both are kept out
  -- of the stored 'description' jsonb -- they travel only as the ETag header.
  CREATE TABLE collections (
    space_id               text COLLATE "C" NOT NULL
                           REFERENCES spaces ON DELETE CASCADE,
    collection_id          text COLLATE "C" NOT NULL,
    description            jsonb,
    description_generation text,
    description_version    integer NOT NULL DEFAULT 1,
    PRIMARY KEY (space_id, collection_id)
  );

  -- One row per Resource, live or tombstoned. 'content' is the byte-for-byte
  -- representation (JSON stored as its serialized UTF-8 bytes, NOT jsonb --
  -- jsonb normalization would break byte fidelity); NULL on a tombstone.
  -- 'content_type' records the last-known type on a tombstone. 'generation'
  -- is the row's opaque content ETag marker, minted when the row is first
  -- created and preserved by every later write (a soft delete keeps it, and
  -- so does a re-create over the tombstone); paired with 'version' it is the
  -- content ETag validator. A hard delete removes the row, so the next
  -- Resource under the same id mints a new generation and the two lives'
  -- validators can never coincide. 'meta_version' is the independent '/meta'
  -- counter, paired with the 'meta_generation' column added in v4. 'custom'
  -- is the user-writable metadata (or the opaque encryption envelope on an
  -- encrypted Collection).
  -- 'created_by' is the Resource's creator -- the DID of the invoker of its
  -- FIRST content write, set once and preserved verbatim thereafter (the
  -- spec's OPTIONAL 'createdBy'); NULL for a row written by a caller with no
  -- resolved invoker. 'epoch' is the client-declared key epoch the content
  -- was encrypted under (multi-recipient encrypted Collections), stored
  -- opaquely (the server never computes or verifies it); NULL when no epoch
  -- was declared (a plaintext Collection, or an encrypted write that omitted
  -- the stamp). 'writer_id' is the client-declared writer-attribution label
  -- (spec "Writer attribution"), stored opaquely and never verified; NULL
  -- when no label was declared. Unlike 'epoch', a metadata write also sets
  -- it declare-or-clear (an omitted 'writerId' clears it), and a soft delete
  -- sets it from the deleting write's own declaration rather than preserving
  -- the row's prior value. None of the three is COLLATE "C": unlike
  -- 'created_at' / 'updated_at', they never participate in an ORDER BY or
  -- keyset comparison.
  CREATE TABLE resources (
    space_id      text COLLATE "C" NOT NULL,
    collection_id text COLLATE "C" NOT NULL,
    resource_id   text COLLATE "C" NOT NULL,
    content_type  text NOT NULL,
    content       bytea,
    is_json       boolean NOT NULL,
    size_bytes    bigint NOT NULL DEFAULT 0,
    generation    text NOT NULL,
    version       integer NOT NULL,
    meta_version  integer,
    custom        jsonb,
    deleted       boolean NOT NULL DEFAULT false,
    created_at    text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL,
    created_by    text,
    epoch         text,
    writer_id     text,
    PRIMARY KEY (space_id, collection_id, resource_id),
    FOREIGN KEY (space_id, collection_id)
      REFERENCES collections ON DELETE CASCADE
  );

  -- The changes-feed keyset: (updatedAt, resourceId) ascending within a
  -- collection. Also serves the tie-broken seek.
  CREATE INDEX resources_changes_idx
    ON resources (space_id, collection_id, updated_at, resource_id);

  -- Chunk storage for chunked Resources. One row per addressed chunk
  -- (space, collection, resource, index); 'bytes' is the opaque chunk
  -- representation (stored exactly like a binary Resource's content, never
  -- parsed), 'size' its byte length (the quota-counter input), and
  -- 'generation' with 'version' the chunk's own ETag validator (independent
  -- of the parent Resource's). A chunk delete removes the row outright, so
  -- the next chunk written at that index mints a new generation. The foreign
  -- key to 'resources' gives chunk rows the same ON DELETE CASCADE the
  -- Space/Collection tree already uses, so a HARD delete of the parent
  -- Resource (or its Collection or Space) removes its chunks with it; a SOFT
  -- delete (the tombstone UPDATE in deleteResource) removes them explicitly
  -- in the same transaction instead.
  CREATE TABLE chunks (
    space_id      text COLLATE "C" NOT NULL,
    collection_id text COLLATE "C" NOT NULL,
    resource_id   text COLLATE "C" NOT NULL,
    chunk_index   integer NOT NULL,
    content_type  text NOT NULL,
    bytes         bytea NOT NULL,
    size          bigint NOT NULL DEFAULT 0,
    generation    text NOT NULL,
    version       integer NOT NULL,
    PRIMARY KEY (space_id, collection_id, resource_id, chunk_index),
    FOREIGN KEY (space_id, collection_id, resource_id)
      REFERENCES resources ON DELETE CASCADE
  );

  -- Policies for all three levels in one table; '' sentinel columns keep the
  -- primary key total (Postgres PKs reject NULL). Space policy: ('', '');
  -- collection policy: (cid, ''); resource policy: (cid, rid).
  CREATE TABLE policies (
    space_id      text COLLATE "C" NOT NULL
                  REFERENCES spaces ON DELETE CASCADE,
    collection_id text COLLATE "C" NOT NULL DEFAULT '',
    resource_id   text COLLATE "C" NOT NULL DEFAULT '',
    policy        jsonb NOT NULL,
    PRIMARY KEY (space_id, collection_id, resource_id)
  );

  -- Registered external backend records; 'record' is the full secret-bearing
  -- StoredBackendRecord (same custody posture as the filesystem file).
  CREATE TABLE backend_records (
    space_id   text COLLATE "C" NOT NULL REFERENCES spaces ON DELETE CASCADE,
    backend_id text COLLATE "C" NOT NULL,
    record     jsonb NOT NULL,
    PRIMARY KEY (space_id, backend_id)
  );

  -- Space-scoped zcap revocations -- the PWS route families' sibling of the
  -- keystore-scoped 'revocations' table below. A separate table (rather than
  -- a nullable-FK union over one table) lets each keep its own
  -- ON DELETE CASCADE to its parent and its own composite primary key;
  -- deleting a Space here deletes its revocations. Columns mirror
  -- 'revocations', with 'space_id' referencing the spaces tree in place of
  -- 'keystore_id'.
  CREATE TABLE space_revocations (
    space_id      text COLLATE "C" NOT NULL REFERENCES spaces ON DELETE CASCADE,
    delegator     text COLLATE "C" NOT NULL,
    capability_id text COLLATE "C" NOT NULL,
    record        jsonb NOT NULL,
    expires       text COLLATE "C",
    PRIMARY KEY (space_id, delegator, capability_id)
  );

  -- WebKMS facet: a sibling tree to spaces, exactly as on the filesystem.
  -- 'controller' / 'sequence' / 'kms_module' are denormalized from the
  -- verbatim config for the list filter and the update gates.
  CREATE TABLE keystores (
    keystore_id text COLLATE "C" PRIMARY KEY,
    controller  text NOT NULL,
    sequence    integer NOT NULL,
    kms_module  text NOT NULL,
    config      jsonb NOT NULL
  );
  CREATE INDEX keystores_controller_idx ON keystores (controller);

  -- 'record' is the opaque (possibly envelope-encrypted above the backend)
  -- KmsKeyRecord, stored verbatim; the primary key is the create-only gate.
  CREATE TABLE kms_keys (
    keystore_id text COLLATE "C" NOT NULL
                REFERENCES keystores ON DELETE CASCADE,
    local_id    text COLLATE "C" NOT NULL,
    record      jsonb NOT NULL,
    PRIMARY KEY (keystore_id, local_id)
  );

  -- 'expires' is meta.expires (the GC horizon), NULL = never.
  CREATE TABLE revocations (
    keystore_id   text COLLATE "C" NOT NULL
                  REFERENCES keystores ON DELETE CASCADE,
    delegator     text COLLATE "C" NOT NULL,
    capability_id text COLLATE "C" NOT NULL,
    record        jsonb NOT NULL,
    expires       text COLLATE "C",
    PRIMARY KEY (keystore_id, delegator, capability_id)
  );
  `,
  // v2 (dropped by v6, which keeps these members inside the one Collection
  // Metadata object): Collection Metadata (the reserved 'meta' segment of a
  // Collection) --
  // the Collection-level sibling of the resource metadata columns. Kept on the
  // 'collections' row rather than in its own table: it is exactly one optional
  // metadata object per Collection, and it dies with the Collection.
  // 'meta_generation' and 'meta_version' are its ETag validator, both NULL
  // until the first metadata write (which mints the generation and keeps it
  // thereafter) and deliberately INDEPENDENT of the description validator (a
  // description write never touches them, and vice versa). 'meta_custom' is the
  // user-writable object (or the opaque encryption envelope on an encrypted
  // Collection), 'meta_epoch' the client-declared key epoch the envelope was
  // encrypted under (stored opaquely; NULL when unstamped -- and, unlike the
  // resource path, cleared by a metadata write that omits it, since the write
  // replaces the envelope the stamp describes). 'meta_created_at' /
  // 'meta_updated_at' are the metadata object's own timestamps, COLLATE "C"
  // like every other ISO-8601 column here.
  `
  ALTER TABLE collections
    ADD COLUMN meta_generation text,
    ADD COLUMN meta_version    integer,
    ADD COLUMN meta_custom     jsonb,
    ADD COLUMN meta_epoch      text,
    ADD COLUMN meta_created_at text COLLATE "C",
    ADD COLUMN meta_updated_at text COLLATE "C";
  `,
  // v3: the Collection's governing history log (the 'meta/log' sub-resource,
  // the 'governed-history-logs' feature). 'log_body' is the JSON Lines body
  // verbatim (text, never parsed into jsonb: the line framing and the entry
  // bytes a verifying reader hashes must survive byte-for-byte);
  // 'log_generation' / 'log_version' are its own ETag validator, NULL until
  // the guarded create, and independent of both the description and the
  // '/meta' validators. A log write does bump 'description_version', since
  // the served description's 'encryption' member is derived from the head.
  `
  ALTER TABLE collections
    ADD COLUMN log_body       text,
    ADD COLUMN log_generation text,
    ADD COLUMN log_version    integer;
  `,
  // v4: the Resource metadata object's own ETag generation. Paired with
  // 'meta_version' it is the '/meta' validator, minted by the first metadata
  // write and kept by every later one; independent of the row's content
  // 'generation'. A soft delete NULLs it together with 'meta_version' and
  // 'custom' (the metadata object goes with the deleted Resource), so a
  // re-created Resource's first metadata write mints a fresh one and a
  // pre-delete '/meta' ETag can never pass If-Match against it -- whereas the
  // content 'generation' survives the tombstone.
  `
  ALTER TABLE resources
    ADD COLUMN meta_generation text;
  `,
  // v5 (renamed by v6): the Space Description's own ETag validator, the
  // Space-level twin of
  // the collections columns of the same names: 'description_generation' is
  // minted by the first real description write and kept for the Space's whole
  // life (NULL on a placeholder row, which has no description to validate
  // yet); 'description_version' is the monotonic counter writeSpace bumps on
  // every write. Both stay out of the stored 'description' jsonb and travel
  // only as the ETag header, behind the guarded create (If-None-Match: *) and
  // compare-and-swap (If-Match) on Update Space.
  `
  ALTER TABLE spaces
    ADD COLUMN description_generation text,
    ADD COLUMN description_version    integer NOT NULL DEFAULT 1;
  `,
  // v6: the Space and Collection Metadata objects (spec v0.5). A container's
  // description and its '/meta' Metadata object are one object now, served at
  // the container's reserved 'meta' segment. The 'description' jsonb of each
  // table becomes 'metadata', and its validator pair becomes
  // 'meta_generation' / 'meta_version'. On 'collections' the separate
  // '/meta' columns are dropped first, together with the annotation values
  // they held, since the merged object keeps 'custom', 'epoch' and the
  // timestamps inside the jsonb. Nothing is copied across: a Collection
  // written before v6 carries no annotations or timestamps until its next
  // Metadata write. The 'log_*' columns are untouched.
  `
  ALTER TABLE collections
    DROP COLUMN meta_generation,
    DROP COLUMN meta_version,
    DROP COLUMN meta_custom,
    DROP COLUMN meta_epoch,
    DROP COLUMN meta_created_at,
    DROP COLUMN meta_updated_at;
  ALTER TABLE collections RENAME COLUMN description TO metadata;
  ALTER TABLE collections RENAME COLUMN description_generation TO meta_generation;
  ALTER TABLE collections RENAME COLUMN description_version TO meta_version;

  ALTER TABLE spaces RENAME COLUMN description TO metadata;
  ALTER TABLE spaces RENAME COLUMN description_generation TO meta_generation;
  ALTER TABLE spaces RENAME COLUMN description_version TO meta_version;
  `,
  // v7: the changes feed orders on a per-Collection feed position instead of
  // the (updated_at, resource_id) keyset, which is not a total order when
  // two writes share a millisecond. 'collections.feed_position' is the
  // counter: the last position handed out, 0 for a Collection with none.
  // Every Resource-level write takes the next one with
  // 'UPDATE collections SET feed_position = feed_position + 1 ... RETURNING',
  // whose row lock is held to commit, so positions are commit-ordered.
  // 'resources.feed_position' is the position the row's latest write took.
  // It is NULL for a row written before v7: no backfill, so such a Resource
  // is absent from the feed until it is rewritten. A chunk write takes none.
  // 'collections.feed_generation' is the counter's generation, minted with
  // the first position and kept for the row's life, NULL before it. The wire
  // checkpoint carries it, so a checkpoint from a Collection since deleted
  // and re-created under the same id is refused instead of skipping the new
  // feed's first positions.
  `
  ALTER TABLE collections
    ADD COLUMN feed_position bigint NOT NULL DEFAULT 0,
    ADD COLUMN feed_generation text;
  ALTER TABLE resources
    ADD COLUMN feed_position bigint;
  DROP INDEX resources_changes_idx;
  CREATE INDEX resources_feed_idx
    ON resources (space_id, collection_id, feed_position);
  `,
  // v8: the store row, one per schema, carrying the store's own facts. Its
  // first is the per-store origin id, the origin half of a write's
  // replicated identity. The migration creates the table only: the runner
  // fills the row on every boot, from WAS_ORIGIN_ID when set, else minted.
  // The 'singleton' key admits exactly one row.
  `
  CREATE TABLE store (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    origin_id text NOT NULL
  );
  `,
  // v9: every versioned record carries a write stamp in place of a version
  // counter. A schema holding any Space is refused, every boot, until it is
  // wiped or each Space is restored from an export archive (whose records an
  // import re-stamps): there is no stamping step. An empty schema is reshaped.
  reshapeForWriteStamps,
  // v10: Collection tombstones. Delete Collection keeps the 'collections' row
  // and marks it 'deleted'. A tombstoned row keeps 'meta_generation', carries
  // the delete's stamp in the stamp columns, and has 'metadata', the log
  // columns and 'feed_generation' NULL and 'feed_position' 0. It reads as
  // absent everywhere except the Space listing under '?include=deleted'. A
  // create over it clears the mark and mints a new generation. Its member
  // rows (Resources, chunks, policies) are removed in the delete's
  // transaction.
  `
  ALTER TABLE collections
    ADD COLUMN deleted boolean NOT NULL DEFAULT false;
  `,
  // v11: the changes feed carries every record kind in the Collection, not
  // Resources alone. A Collection Metadata write and a governing history log
  // write each take the Collection's next feed position, by the same
  // 'collections.feed_position' counter a Resource-level write takes, and
  // record it on the row: 'metadata_feed_position' for the Metadata object
  // and 'log_feed_position' for the log. Each is the position the record's
  // latest write took, and is NULL before it. No backfill: a Collection
  // written before v11 has no Metadata or log document in its feed until its
  // next write of that record. A tombstoned row has both NULL, like
  // 'feed_generation'.
  `
  ALTER TABLE collections
    ADD COLUMN metadata_feed_position bigint,
    ADD COLUMN log_feed_position bigint;
  `,
  // v12: an access-control policy is a versioned record with a write stamp
  // and a generation, and its delete leaves a tombstone. A schema holding any
  // policy row is refused, every boot, until it is wiped or each Space is
  // restored from an export archive (whose policies an import re-stamps):
  // there is no stamping step. An empty 'policies' table is reshaped.
  reshapePoliciesForWriteStamps,
  // v13: replica registrations (the replication specification), one source
  // peer of a Space per row. 'record' is the registration as the controller
  // wrote it, the delegated pull capability included (the same custody
  // posture as 'backend_records'). 'generation' is what the record's ETag is
  // made of. 'space_generation' is the Space Metadata object's generation at
  // the time the registration was made: the apply path stores a replicated
  // record only while the Space still carries it. 'state' is the pull loop's
  // own state (per-Collection checkpoints and stalls, pull times), NULL until
  // the loop first writes it, kept apart from 'record' so a checkpoint
  // advance never rewrites the capability. The rows go with the Space.
  `
  CREATE TABLE replicas (
    space_id         text COLLATE "C" NOT NULL
                     REFERENCES spaces ON DELETE CASCADE,
    replica_id       text COLLATE "C" NOT NULL,
    record           jsonb NOT NULL,
    generation       text NOT NULL,
    space_generation text NOT NULL,
    state            jsonb,
    PRIMARY KEY (space_id, replica_id)
  );
  `,
  // v14: chunk staging for the chunk pull of the replication facet. One row
  // per chunk a pull loop read from the source server and has not yet moved
  // into place, keyed by the registration ('replica_id'), the source
  // server's 'ETag' of the parent revision the feed document named
  // ('parent_etag', the quoted string as served) and the index. 'bytes',
  // 'size' and 'content_type' are the 'chunks' columns of the same name;
  // 'peer_etag' is the source server's 'ETag' of the chunk, an opaque string
  // kept for the conditional read of a re-run only. A staged chunk has no
  // generation and no stamp: both are minted when the swap moves the row
  // into 'chunks'. Staged bytes count in 'spaces.usage_bytes'. The foreign
  // key is to 'collections', not 'resources': the parent of a Resource
  // replicated for the first time has no row until the swap writes it. It
  // carries none to 'replicas' either, since a backend other than the
  // control plane holds no registrations. Delete Space removes the rows
  // through the cascade; every other path that ends a run (the swap, Delete
  // Resource, a tombstone apply, Delete Collection, Delete Replica, boot)
  // deletes them by code and returns their bytes to the counter.
  // 'replicas.pulls_chunks' records whether the source server lists the
  // Encrypted Collections profile, which gates the chunk pull; a
  // registration made before v14 reads false.
  `
  CREATE TABLE chunk_staging (
    space_id      text COLLATE "C" NOT NULL,
    collection_id text COLLATE "C" NOT NULL,
    resource_id   text COLLATE "C" NOT NULL,
    replica_id    text COLLATE "C" NOT NULL,
    parent_etag   text COLLATE "C" NOT NULL,
    chunk_index   integer NOT NULL,
    content_type  text NOT NULL,
    bytes         bytea NOT NULL,
    size          bigint NOT NULL DEFAULT 0,
    peer_etag     text NOT NULL,
    PRIMARY KEY (space_id, collection_id, resource_id, replica_id,
                 parent_etag, chunk_index),
    FOREIGN KEY (space_id, collection_id)
      REFERENCES collections ON DELETE CASCADE
  );

  ALTER TABLE replicas
    ADD COLUMN pulls_chunks boolean NOT NULL DEFAULT false;
  `,
  // v15: a replica registration is a versioned record. Its write stamp lives
  // in three columns beside 'generation', as a policy's does, out of the
  // 'record' jsonb, and 'PUT' at the registration URL replaces the row in
  // place. A row written before this version carries no stamp, and there is
  // no stamping step: the step refuses a schema that holds one.
  stampReplicas,
  // v16: every 'resources' and 'chunks' row carries 'digest', the content
  // digest of its stored representation (the 'Digest' header's 'mh=' form), a
  // tombstone keeping the deleted content's; 'chunk_staging' carries the
  // staged bytes' digest for the swap to copy. A row written before this
  // version carries none, and there is no digesting step: the step refuses a
  // schema that holds a live Resource, a chunk or a staged chunk. A tombstone
  // row passes with a NULL digest, which the write-once rule reads as
  // nothing to compare.
  addContentDigests
]

/**
 * The v16 step. Refuses a schema that holds a live Resource row, a chunk row
 * or a staged chunk row: each was written before records carried a content
 * digest, and the `chunks` and `chunk_staging` columns below are added
 * `NOT NULL` with no default. `resources.digest` is nullable: a tombstone
 * written with no bytes to digest (an import's, a replica apply's over no
 * prior row, or one written before this version) has none.
 * @param client {pg.PoolClient}   the migrating transaction's client
 * @returns {Promise<void>}
 */
async function addContentDigests(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT (SELECT COUNT(*) FROM resources WHERE NOT deleted)::int
          + (SELECT COUNT(*) FROM chunks)::int
          + (SELECT COUNT(*) FROM chunk_staging)::int AS count`
  )
  const count = rows[0]!.count
  if (count > 0) {
    throw new StoreVersionError({
      detail:
        `The Postgres schema holds ${count} live Resource, chunk or staged ` +
        'chunk row(s) written before records carried a content digest, and ' +
        'there is no digesting migration. Drop the schema, or restore each ' +
        'Space from an export archive into an empty store.'
    })
  }
  await client.query(`
    ALTER TABLE resources ADD COLUMN digest text;
    ALTER TABLE chunks ADD COLUMN digest text NOT NULL;
    ALTER TABLE chunk_staging ADD COLUMN digest text NOT NULL;
  `)
}

/**
 * The v15 step. Refuses a schema whose `replicas` table holds a row: each
 * was written before registrations carried write stamps, and the columns
 * below are added `NOT NULL` with no default.
 * @param client {pg.PoolClient}   the migrating transaction's client
 * @returns {Promise<void>}
 */
async function stampReplicas(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM replicas'
  )
  const count = rows[0]!.count
  if (count > 0) {
    throw new StoreVersionError({
      detail:
        `The Postgres schema holds ${count} replica registration(s) written ` +
        'before registrations carried write stamps, and there is no stamping ' +
        'migration. Delete the rows and make each registration again.'
    })
  }
  await client.query(`
    ALTER TABLE replicas
      ADD COLUMN updated_at         text COLLATE "C" NOT NULL,
      ADD COLUMN updated_at_counter integer NOT NULL,
      ADD COLUMN origin_id          text NOT NULL;
  `)
}

/**
 * The v9 step. Refuses a schema whose `spaces` table holds a row: every
 * record under it was written before records carried write stamps. Every
 * other table of the Spaces tree hangs off `spaces` by a cascading foreign
 * key, so an empty `spaces` table means an empty tree, and the reshape below
 * can add its columns `NOT NULL` with no default.
 *
 * The stamp is three columns per record: `updated_at` (the ISO string of the
 * stamp's millisecond), `updated_at_counter` (its logical counter) and
 * `origin_id` (the minting store's origin id). A Resource's `/meta` record
 * has its own three, `meta_updated_at`, `meta_updated_at_counter` and
 * `meta_origin_id`, beside the existing `meta_generation`; all four are NULL
 * until the first metadata write, and a soft delete NULLs them together with
 * `custom`. The Collection's governing history log has its own three under
 * the table's `log_` prefix, NULL until the guarded create. A Space or
 * Collection row keeps its stamp in these columns, out of the stored
 * `metadata` jsonb, and adds `meta_local`, the local segment of its `ETag`:
 * reset to 0 by every stamped write of the object and advanced by a change to
 * a member derived per read (a backend registration on a Space, a
 * governed-log write on a Collection). `store.clock_high_water` is the
 * persisted high-water mark of the store's hybrid logical clock, in epoch
 * milliseconds, NULL until the clock first mints.
 * @param client {pg.PoolClient}   the migrating transaction's client
 * @returns {Promise<void>}
 */
async function reshapeForWriteStamps(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM spaces'
  )
  const count = rows[0]!.count
  if (count > 0) {
    throw new StoreVersionError({
      detail:
        `The Postgres schema holds ${count} Space(s) written before records ` +
        'carried write stamps, and there is no stamping migration. Drop the ' +
        'schema, or restore each Space from an export archive into an empty ' +
        'store.'
    })
  }
  await client.query(`
    ALTER TABLE resources
      DROP COLUMN version,
      DROP COLUMN meta_version,
      ADD COLUMN updated_at_counter      integer NOT NULL,
      ADD COLUMN origin_id               text NOT NULL,
      ADD COLUMN meta_updated_at         text COLLATE "C",
      ADD COLUMN meta_updated_at_counter integer,
      ADD COLUMN meta_origin_id          text;

    ALTER TABLE chunks
      DROP COLUMN version,
      ADD COLUMN updated_at         text COLLATE "C" NOT NULL,
      ADD COLUMN updated_at_counter integer NOT NULL,
      ADD COLUMN origin_id          text NOT NULL;

    ALTER TABLE spaces
      DROP COLUMN meta_version,
      ADD COLUMN updated_at         text COLLATE "C" NOT NULL,
      ADD COLUMN updated_at_counter integer NOT NULL,
      ADD COLUMN origin_id          text NOT NULL,
      ADD COLUMN meta_local         integer NOT NULL DEFAULT 0;

    ALTER TABLE collections
      DROP COLUMN meta_version,
      DROP COLUMN log_version,
      ADD COLUMN updated_at             text COLLATE "C" NOT NULL,
      ADD COLUMN updated_at_counter     integer NOT NULL,
      ADD COLUMN origin_id              text NOT NULL,
      ADD COLUMN meta_local             integer NOT NULL DEFAULT 0,
      ADD COLUMN log_updated_at         text COLLATE "C",
      ADD COLUMN log_updated_at_counter integer,
      ADD COLUMN log_origin_id          text;

    ALTER TABLE store
      ADD COLUMN clock_high_water bigint;
  `)
}

/**
 * The v12 step. Refuses a schema whose `policies` table holds a row: every
 * such row was written before policies carried write stamps. Otherwise adds
 * the stamp columns `updated_at`, `updated_at_counter` and `origin_id` and
 * the `generation` column, all `NOT NULL`, the `deleted` tombstone mark, and
 * `feed_position`, the position the policy's latest write took in its
 * Collection's changes feed (NULL for a Space policy, which is in no feed),
 * with the index the feed reads it through.
 * A tombstoned row has `deleted` set and `policy` NULL, so the column loses
 * its `NOT NULL`.
 * @param client {pg.PoolClient}   the migrating transaction's client
 * @returns {Promise<void>}
 */
async function reshapePoliciesForWriteStamps(
  client: pg.PoolClient
): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM policies'
  )
  const count = rows[0]!.count
  if (count > 0) {
    throw new StoreVersionError({
      detail:
        `The Postgres schema holds ${count} access-control policy row(s) ` +
        'written before policies carried write stamps, and there is no ' +
        'stamping migration. Drop the schema, or restore each Space from an ' +
        'export archive into an empty store.'
    })
  }
  await client.query(`
    ALTER TABLE policies
      ALTER COLUMN policy DROP NOT NULL,
      ADD COLUMN deleted            boolean NOT NULL DEFAULT false,
      ADD COLUMN generation         text NOT NULL,
      ADD COLUMN updated_at         text COLLATE "C" NOT NULL,
      ADD COLUMN updated_at_counter integer NOT NULL,
      ADD COLUMN origin_id          text NOT NULL,
      ADD COLUMN feed_position      bigint;
    CREATE INDEX policies_feed_idx
      ON policies (space_id, collection_id, feed_position);
  `)
}

/**
 * Applies any not-yet-applied migrations, inside a transaction holding a
 * schema-scoped advisory lock so concurrent server instances sharing one
 * database serialize their startup migration runs. Idempotent: applied
 * versions are recorded in `schema_migrations` and skipped on the next run.
 * Refuses to start (`StoreVersionError`) when `schema_migrations` records a
 * version newer than `migrations` knows, as after a rollback to an older
 * build, rather than run against a schema this code was not written for.
 *
 * Then, in the same transaction, settles the store's origin id from the store
 * row. A stored id is the answer, and a configured id that differs from it
 * is refused, as is a malformed stored id (`StoreOriginIdError`). With no
 * row yet, the configured id is inserted, else a minted one. This runs on
 * every boot rather than as a migration step, so a store whose table the
 * migrations created on this boot gets its row in the same transaction. The
 * store row's persisted high-water mark of the hybrid logical clock is read
 * back with the id.
 * @param options {object}
 * @param options.client {pg.PoolClient}   a dedicated client (not the pool);
 *   the caller is responsible for releasing it
 * @param options.logger {FastifyBaseLogger}
 * @param [options.migrations] {Migration[]}   defaults to MIGRATIONS
 * @param [options.originId] {string}   the configured origin id
 *   (`WAS_ORIGIN_ID`); unset mints one on a store that carries none
 * @returns {Promise<{ version: number, originId: string, clockHighWater?: number }>}
 *   the version the schema is at afterwards, the store's origin id, and the
 *   clock's high-water mark when the store has one
 */
export async function applyMigrations({
  client,
  logger,
  migrations = MIGRATIONS,
  originId
}: {
  client: pg.PoolClient
  logger: FastifyBaseLogger
  migrations?: Migration[]
  originId?: string
}): Promise<{ version: number; originId: string; clockHighWater?: number }> {
  await client.query('BEGIN')
  try {
    // Scope the advisory lock to the active schema so parallel test schemas
    // in one database do not serialize against each other.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':was-migrations'))`
    )
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations'
    )
    const applied = new Set(rows.map(row => row.version))
    const currentVersion = migrations.length
    const newestApplied = Math.max(0, ...applied)
    if (newestApplied > currentVersion) {
      throw new StoreVersionError({
        detail:
          `The Postgres schema_migrations table records version ` +
          `${newestApplied}; this server knows up to version ${currentVersion}.`
      })
    }
    for (let index = 0; index < migrations.length; index++) {
      const version = index + 1
      if (applied.has(version)) {
        continue
      }
      logger.info({ version }, 'Applying Postgres schema migration')
      const migration = migrations[index]!
      if (typeof migration === 'string') {
        await client.query(migration)
      } else {
        await migration(client)
      }
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      )
    }
    const { originId: settledOriginId, clockHighWater } = await settleOriginId({
      client,
      originId
    })
    await client.query('COMMIT')
    logger.info(
      { version: currentVersion, originId: settledOriginId },
      'Postgres store ready'
    )
    return {
      version: currentVersion,
      originId: settledOriginId,
      ...(clockHighWater !== undefined && { clockHighWater })
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * Reads the store row's origin id, or inserts one when the row is absent.
 * Runs inside `applyMigrations`'s transaction, under its advisory lock, so no
 * other instance can insert between the read and the write. Also reads the
 * row's clock high-water mark, which a freshly inserted row lacks.
 * @param options {object}
 * @param options.client {pg.PoolClient}
 * @param [options.originId] {string}   the configured origin id
 * @returns {Promise<{ originId: string, clockHighWater?: number }>}   the
 *   store's origin id, and the clock's high-water mark when it has one
 */
async function settleOriginId({
  client,
  originId
}: {
  client: pg.PoolClient
  originId?: string
}): Promise<{ originId: string; clockHighWater?: number }> {
  const { rows } = await client.query<{
    origin_id: string
    clock_high_water: string | null
  }>('SELECT origin_id, clock_high_water FROM store')
  const stored = rows[0]?.origin_id
  // A `bigint` arrives as a string.
  const highWater = rows[0]?.clock_high_water ?? null
  if (stored !== undefined && !isValidOriginId(stored)) {
    throw StoreOriginIdError.malformed({
      id: stored,
      where: 'The Postgres store table'
    })
  }
  // A malformed configured id is refused here, before anything is written:
  // in the store row it would refuse every later boot.
  const settled = settleStoreOriginId({ stored, configured: originId })
  if (stored === undefined) {
    await client.query('INSERT INTO store (origin_id) VALUES ($1)', [settled])
  }
  return {
    originId: settled,
    ...(highWater !== null && { clockHighWater: Number(highWater) })
  }
}

/**
 * Persists a new high-water mark of the store's hybrid logical clock in the
 * store row's `clock_high_water` column. A mark is only ever raised: one at
 * or below the stored mark leaves the row as it is. Run by the backend's
 * clock on a cadence (see `lib/hlc.ts`), as its own autocommit statement.
 * @param options {object}
 * @param options.queryable {pg.Pool | pg.PoolClient}
 * @param options.clockHighWater {number}   epoch milliseconds
 * @returns {Promise<void>}
 */
export async function writeClockHighWater({
  queryable,
  clockHighWater
}: {
  queryable: pg.Pool | pg.PoolClient
  clockHighWater: number
}): Promise<void> {
  await queryable.query(
    `UPDATE store SET clock_high_water = $1
      WHERE clock_high_water IS NULL OR clock_high_water < $1`,
    [clockHighWater]
  )
}
