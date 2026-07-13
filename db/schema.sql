-- ============================================================================
-- Fedline Assistant — Postgres schema + seed data
-- ============================================================================
-- Purpose
--   Backing store the DBAgent (a Bedrock collaborator) queries — via a Lambda —
--   to resolve a *user name* into the concrete IDs that fill the downstream
--   collaborator API calls (ABA, officeId, rollupAbaName, reportId, ...).
--
--   Flow:
--     1. Supervisor receives a request. If no user name is present it returns a
--        validation error (handled in the agent layer, not here).
--     2. With a user name, the Supervisor invokes the DBAgent, which calls the
--        DB-lookup Lambda. The Lambda runs `fedline.get_user_identifiers(:name)`
--        and returns a flat { id_type -> id_value } map for that user.
--     3. The Supervisor merges those IDs into TaskParams and routes to the EDD /
--        XShipReport / XShipDownload / Relationship collaborators.
--
--   `id_type` values intentionally match the param names in
--   src/shared/usecases.ts / src/shared/types.ts so the Lambda result maps
--   straight into TaskParams with no translation layer.
--
--   Param provenance — three sources fill a collaborator API call. Only the
--   middle group is stored here:
--     1. REQUEST-SUPPLIED — the user provides them per request, never stored:
--          officeId, startDate/endDate (and startDt/endDt), format/export opts.
--          e.g. eddSummaryReport: the caller passes `user name` + `officeId`.
--     2. DB-LOOKED-UP (this table) — resolved from the user name by the DBAgent:
--          userAba, aba, endpoint, denomination, differenceType, abaNumber,
--          abaGroup, rollupAbaName, zone, period, denomType, requestId, criteria.
--     3. RUNTIME-DERIVED — produced by a prior collaborator call, never stored:
--          reportId comes from an eddSummaryReport result. So eddDetailReport is
--          a 2-step orchestration: run eddSummaryReport first, read `reportId`
--          from its output, then call eddDetailReport. The Supervisor sequences
--          this; the DB has no reportId.
--
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS + ON CONFLICT upserts).
-- Target: PostgreSQL 13+ (RDS / Aurora Postgres on GovCloud).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS fedline;

SET search_path TO fedline, public;

-- ── Users ───────────────────────────────────────────────────────────────────
-- One row per requesting user. `full_name` is what the chat user types
-- ("Lei Liu"); it is matched case-insensitively by the lookup function.
CREATE TABLE IF NOT EXISTS fedline.app_user (
    user_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name     TEXT        NOT NULL,
    username      TEXT,
    email         TEXT,
    -- Login credential: a self-describing scrypt hash string produced by shared/auth.hashPassword
    -- ("scrypt$N$r$p$saltHex$hashHex"). Never store plaintext. NULL = login disabled for this user.
    password_hash TEXT,
    status        TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent add for databases created before credentials existed.
ALTER TABLE fedline.app_user ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Case-insensitive uniqueness on the display name we look users up by.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_full_name_lower_idx
    ON fedline.app_user (lower(full_name));

-- Case-insensitive uniqueness on the login handle (used by get_user_auth for authentication).
CREATE UNIQUE INDEX IF NOT EXISTS app_user_username_lower_idx
    ON fedline.app_user (lower(username));

-- ── User identifiers ─────────────────────────────────────────────────────────
-- The many IDs a single user owns. Key/value keyed by `id_type` so new param
-- names can be added without a schema migration. (user_id, id_type) is unique:
-- one canonical value per identifier per user.
CREATE TABLE IF NOT EXISTS fedline.user_identifier (
    identifier_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL
                      REFERENCES fedline.app_user (user_id) ON DELETE CASCADE,
    id_type       TEXT   NOT NULL,   -- matches a TaskParams field name
    id_value      TEXT   NOT NULL,   -- stored as text to preserve leading zeros
    label         TEXT,              -- optional human description
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, id_type)
);

CREATE INDEX IF NOT EXISTS user_identifier_user_idx
    ON fedline.user_identifier (user_id);
CREATE INDEX IF NOT EXISTS user_identifier_type_idx
    ON fedline.user_identifier (id_type);

-- ── Lookup function ──────────────────────────────────────────────────────────
-- Returns a single JSON object: { "<id_type>": "<id_value>", ... } for the
-- given user name (case-insensitive). Empty object if the user has no IDs;
-- the Lambda distinguishes "unknown user" via get_user_id() below.
CREATE OR REPLACE FUNCTION fedline.get_user_identifiers(p_full_name TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(jsonb_object_agg(ui.id_type, ui.id_value), '{}'::jsonb)
    FROM   fedline.app_user u
    JOIN   fedline.user_identifier ui ON ui.user_id = u.user_id
    WHERE  lower(u.full_name) = lower(btrim(p_full_name))
    AND    u.status = 'active';
$$;

-- Resolve a name to a user_id (NULL when unknown) — lets the Lambda return a
-- clean "unknown user" error vs. "known user, no IDs".
CREATE OR REPLACE FUNCTION fedline.get_user_id(p_full_name TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
    SELECT u.user_id
    FROM   fedline.app_user u
    WHERE  lower(u.full_name) = lower(btrim(p_full_name))
    AND    u.status = 'active'
    LIMIT  1;
$$;

-- ── Authentication lookup ─────────────────────────────────────────────────────
-- Resolve a LOGIN HANDLE (username) to the row the login Lambda needs to verify a
-- password: (user_id, full_name, password_hash). Returns no rows for an unknown or
-- inactive user. The Lambda verifies the scrypt hash itself (in shared/auth) and,
-- on success, calls get_user_identifiers(full_name) to fill the session token.
CREATE OR REPLACE FUNCTION fedline.get_user_auth(p_username TEXT)
RETURNS TABLE (user_id BIGINT, full_name TEXT, password_hash TEXT)
LANGUAGE sql
STABLE
AS $$
    SELECT u.user_id, u.full_name, u.password_hash
    FROM   fedline.app_user u
    WHERE  lower(u.username) = lower(btrim(p_username))
    AND    u.status = 'active'
    LIMIT  1;
$$;

-- ── Report memory (cross-session, per user) ──────────────────────────────────
-- Remembers what a user's prior report runs produced so a follow-up can reuse them
-- instead of recomputing. The headline case: an eddSummaryReport produces a `reportId`
-- that an eddDetailReport needs; without memory the summary is re-run every time the
-- user later asks for the detail. Here the summary's reportId is persisted per user +
-- `report_key` (a signature of the summary's identifying params) and recalled on the
-- next turn — even in a later session.
--
-- `report_key` is computed in code (src/shared/orchestrator.ts eddSummarySig) from the
-- params that identify a specific summary (officeId, userAba, aba, endpoint, denomination,
-- differenceType, startDate, endDate). One canonical row per (user_id, report_key).
CREATE TABLE IF NOT EXISTS fedline.report_memory (
    memory_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL
                    REFERENCES fedline.app_user (user_id) ON DELETE CASCADE,
    report_key  TEXT   NOT NULL,   -- signature of the summary's identifying params
    use_case    TEXT   NOT NULL,   -- the use case that produced the report (e.g. eddSummaryReport)
    report_id   TEXT   NOT NULL,   -- the reusable id downstream calls need
    params      JSONB  NOT NULL DEFAULT '{}'::jsonb,  -- params the report ran with (for follow-ups)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, report_key)
);

CREATE INDEX IF NOT EXISTS report_memory_user_idx
    ON fedline.report_memory (user_id);
-- Ordered lookup of a user's most recent report of a given use case (recall_latest_report).
CREATE INDEX IF NOT EXISTS report_memory_user_usecase_recent_idx
    ON fedline.report_memory (user_id, use_case, updated_at DESC);

-- Upsert one memory row. Called after a report that yields a reusable id runs.
CREATE OR REPLACE FUNCTION fedline.remember_report(
    p_user_id   BIGINT,
    p_key       TEXT,
    p_use_case  TEXT,
    p_report_id TEXT,
    p_params    JSONB
) RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO fedline.report_memory (user_id, report_key, use_case, report_id, params)
    VALUES (p_user_id, p_key, p_use_case, p_report_id, COALESCE(p_params, '{}'::jsonb))
    ON CONFLICT (user_id, report_key) DO UPDATE
        SET use_case   = EXCLUDED.use_case,
            report_id  = EXCLUDED.report_id,
            params     = EXCLUDED.params,
            updated_at = now();
$$;

-- Recall a specific remembered report by its exact signature (the safe primary path).
CREATE OR REPLACE FUNCTION fedline.recall_report(p_user_id BIGINT, p_key TEXT)
RETURNS TABLE (report_id TEXT, params JSONB, use_case TEXT)
LANGUAGE sql
STABLE
AS $$
    SELECT rm.report_id, rm.params, rm.use_case
    FROM   fedline.report_memory rm
    WHERE  rm.user_id = p_user_id
    AND    rm.report_key = p_key
    LIMIT  1;
$$;

-- Recall a user's most recently updated report for a use case (drives the "now the
-- detail" follow-up when the detail request repeats no distinguishing params).
CREATE OR REPLACE FUNCTION fedline.recall_latest_report(p_user_id BIGINT, p_use_case TEXT)
RETURNS TABLE (report_id TEXT, params JSONB, report_key TEXT)
LANGUAGE sql
STABLE
AS $$
    SELECT rm.report_id, rm.params, rm.report_key
    FROM   fedline.report_memory rm
    WHERE  rm.user_id = p_user_id
    AND    rm.use_case = p_use_case
    ORDER  BY rm.updated_at DESC
    LIMIT  1;
$$;

-- ── Knowledge base (RAG / pgvector) ───────────────────────────────────────────
-- Backing store for the KB collaborator's Retrieval-Augmented Generation. Documents are chunked and
-- embedded (Bedrock Titan Text Embeddings V2, 1024-dim) by the ingest-kb Lambda; the KB action-group
-- Lambda embeds the user's query and retrieves the nearest chunks via fedline.search_kb().
--
-- Requires the pgvector extension (available on RDS PostgreSQL 15+ / Aurora Postgres). If the target
-- instance/role cannot create it, provision it once out-of-band; the rest of this block is guarded so
-- a failed CREATE EXTENSION is the only thing to fix.
--
-- IMPORTANT: install the extension (and therefore the `vector` TYPE + operators) into `public`, NOT
-- into `fedline`. This whole script runs with `search_path = fedline, public`, so a bare
-- CREATE EXTENSION would land the type in `fedline` — then the unqualified `::vector` casts in the
-- app queries (ingest INSERT, search_kb call) fail with "type vector does not exist" because the
-- Lambda connections don't have `fedline` on their search_path. `public` is always on the path.
-- The DO block relocates the extension if a prior run already created it in another schema.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'vector' AND n.nspname <> 'public'
    ) THEN
        ALTER EXTENSION vector SET SCHEMA public;
    END IF;
END
$$;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

-- One row per source document.
CREATE TABLE IF NOT EXISTS fedline.kb_document (
    doc_id      TEXT PRIMARY KEY,             -- stable id (e.g. the S3 key)
    title       TEXT NOT NULL,
    source_uri  TEXT,                         -- where the doc came from (s3://..., kb://...)
    content_hash TEXT,                        -- hash of the source text; lets ingest skip unchanged docs
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per chunk of a document, with its embedding. 1024 = Titan Text Embeddings V2 dimension;
-- keep this in sync with KB_EMBED_DIM in src/shared/kb.ts.
CREATE TABLE IF NOT EXISTS fedline.kb_chunk (
    chunk_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id      TEXT NOT NULL REFERENCES fedline.kb_document (doc_id) ON DELETE CASCADE,
    chunk_index INT  NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(1024) NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (doc_id, chunk_index)
);

-- Approximate-nearest-neighbour index for cosine distance (pgvector HNSW).
CREATE INDEX IF NOT EXISTS kb_chunk_embedding_hnsw
    ON fedline.kb_chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kb_chunk_doc_idx
    ON fedline.kb_chunk (doc_id);

-- Upsert a document's metadata row. Returns the doc_id so the caller can attach chunks.
CREATE OR REPLACE FUNCTION fedline.upsert_kb_document(
    p_doc_id       TEXT,
    p_title        TEXT,
    p_source_uri   TEXT,
    p_content_hash TEXT,
    p_metadata     JSONB
) RETURNS TEXT
LANGUAGE sql
AS $$
    INSERT INTO fedline.kb_document (doc_id, title, source_uri, content_hash, metadata)
    VALUES (p_doc_id, p_title, p_source_uri, p_content_hash, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (doc_id) DO UPDATE
        SET title        = EXCLUDED.title,
            source_uri   = EXCLUDED.source_uri,
            content_hash = EXCLUDED.content_hash,
            metadata     = EXCLUDED.metadata,
            updated_at   = now()
    RETURNING doc_id;
$$;

-- Retrieve the nearest chunks to a query embedding. Returns cosine SIMILARITY (1 - distance) as
-- `score` (higher is closer), joined with the parent document's title/source.
CREATE OR REPLACE FUNCTION fedline.search_kb(p_query vector(1024), p_match_count INT DEFAULT 6)
RETURNS TABLE (doc_id TEXT, title TEXT, content TEXT, source_uri TEXT, score DOUBLE PRECISION)
LANGUAGE sql
STABLE
AS $$
    SELECT c.doc_id, d.title, c.content, d.source_uri,
           1 - (c.embedding <=> p_query) AS score
    FROM   fedline.kb_chunk c
    JOIN   fedline.kb_document d ON d.doc_id = c.doc_id
    ORDER  BY c.embedding <=> p_query
    LIMIT  GREATEST(p_match_count, 1);
$$;

-- ── Agentic API Gateway (runtime backend registry / pgvector) ─────────────────
-- Durable catalog of applications the gateway routes to. A backend is registered at RUNTIME by its
-- OpenAPI spec (src/shared/gateway/*): its metadata lands in fedline.gateway_backend and each of its
-- operations (method + path template + params) lands in fedline.gateway_operation with an embedding
-- of the operation's searchable text (Bedrock Titan Text Embeddings V2, 1024-dim — the SAME model the
-- KB uses, so gateway retrieval reuses shared/kb.embedText). The supervisor's Gateway collaborator
-- (and the local orchestrator's gateway fallback) call fedline.search_gateway() to find the operation
-- most relevant to a question, then invoke it through the generic HTTP proxy.
--
-- This is the ONLY durable registry: an in-memory registry lives in a single Lambda process and is
-- not shared between the register Lambda and the proxy, so runtime registration requires the DB.
CREATE TABLE IF NOT EXISTS fedline.gateway_backend (
    backend_id    TEXT PRIMARY KEY,                 -- stable id chosen at registration
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    base_url      TEXT NOT NULL,                     -- every operation path resolves against this
    auth          JSONB NOT NULL DEFAULT '{"type":"none"}'::jsonb,  -- BackendAuth (secret VALUE never stored)
    -- PostDispatchPolicy: what runs after a successful invoke (analytics/report agents, or passthrough).
    -- NULL ⇒ passthrough. Lets each app declare a completely different post-dispatch pipeline as metadata.
    post_dispatch JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent migration for catalogs created before post_dispatch existed.
ALTER TABLE fedline.gateway_backend ADD COLUMN IF NOT EXISTS post_dispatch JSONB;

-- One row per invocable backend operation, with its embedding. 1024 = Titan v2 (== KB_EMBED_DIM).
CREATE TABLE IF NOT EXISTS fedline.gateway_operation (
    op_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    backend_id   TEXT NOT NULL REFERENCES fedline.gateway_backend (backend_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,                    -- unique within a backend (OpenAPI operationId)
    method       TEXT NOT NULL,
    path         TEXT NOT NULL,                    -- path template with {param} placeholders
    summary      TEXT,
    description  TEXT,
    params       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- BackendParam[]
    keywords     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- lexical hints (unused by the vector path)
    embedding    vector(1024) NOT NULL,
    UNIQUE (backend_id, operation_id)
);

CREATE INDEX IF NOT EXISTS gateway_operation_embedding_hnsw
    ON fedline.gateway_operation USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS gateway_operation_backend_idx
    ON fedline.gateway_operation (backend_id);

-- Upsert a backend's metadata row (its operations are replaced separately by the register Lambda).
-- p_post_dispatch is the PostDispatchPolicy JSON (NULL ⇒ passthrough).
CREATE OR REPLACE FUNCTION fedline.upsert_gateway_backend(
    p_backend_id    TEXT,
    p_name          TEXT,
    p_description   TEXT,
    p_base_url      TEXT,
    p_auth          JSONB,
    p_post_dispatch JSONB DEFAULT NULL
) RETURNS TEXT
LANGUAGE sql
AS $$
    INSERT INTO fedline.gateway_backend (backend_id, name, description, base_url, auth, post_dispatch)
    VALUES (p_backend_id, p_name, COALESCE(p_description, ''), p_base_url,
            COALESCE(p_auth, '{"type":"none"}'::jsonb), p_post_dispatch)
    ON CONFLICT (backend_id) DO UPDATE
        SET name          = EXCLUDED.name,
            description    = EXCLUDED.description,
            base_url       = EXCLUDED.base_url,
            auth           = EXCLUDED.auth,
            post_dispatch  = EXCLUDED.post_dispatch,
            updated_at     = now()
    RETURNING backend_id;
$$;

-- Retrieve the operations nearest a query embedding, joined to their backend. Returns cosine
-- SIMILARITY (1 - distance) as `score` (higher is closer), mirroring fedline.search_kb.
CREATE OR REPLACE FUNCTION fedline.search_gateway(p_query vector(1024), p_match_count INT DEFAULT 5)
RETURNS TABLE (
    backend_id   TEXT,
    backend_name TEXT,
    base_url     TEXT,
    operation_id TEXT,
    method       TEXT,
    path         TEXT,
    summary      TEXT,
    description  TEXT,
    params       JSONB,
    keywords     JSONB,
    score        DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
    SELECT b.backend_id, b.name AS backend_name, b.base_url,
           o.operation_id, o.method, o.path, o.summary, o.description, o.params, o.keywords,
           1 - (o.embedding <=> p_query) AS score
    FROM   fedline.gateway_operation o
    JOIN   fedline.gateway_backend b ON b.backend_id = o.backend_id
    ORDER  BY o.embedding <=> p_query
    LIMIT  GREATEST(p_match_count, 1);
$$;

-- ============================================================================
-- Seed data
-- ============================================================================

-- Example user: Lei Liu. Demo password is "Password123!" (scrypt hash below — the SAME string the
-- in-code directory mirror uses; see src/shared/user-directory.ts). Rotate in real deployments.
INSERT INTO fedline.app_user (full_name, username, email, password_hash)
VALUES ('Lei Liu', 'lliu', 'ttoulliu2002@gmail.com',
        'scrypt$16384$8$1$4e95fe52bac616715279bdcf9158b451$7180a85c78347901d1179b8f415e1687240b3ed26e9a132e9d65a7b22ab7d585')
ON CONFLICT (lower(full_name)) DO UPDATE
    SET username      = EXCLUDED.username,
        email         = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        updated_at    = now();

-- All the IDs that fill the downstream collaborator API calls for Lei Liu.
-- id_type names == TaskParams field names (src/shared/types.ts).
INSERT INTO fedline.user_identifier (user_id, id_type, id_value, label)
SELECT u.user_id, v.id_type, v.id_value, v.label
FROM   fedline.app_user u
CROSS  JOIN (VALUES
    -- Office the user belongs to — now resolved at login and carried in the session token
    -- (previously request-supplied; the chat user no longer types it).
    ('officeId',       '12345',                   'Requesting user''s office id'),
    -- Relationship / shared ABA identifiers
    ('abaNumber',      '000001',                  '9-digit ABA routing number'),
    ('abaGroup',       'GRP-100',                 'ABA group identifier'),
    ('aba',            '011000015',               'Target ABA for report path segment'),
    ('userAba',        '000001',                  'Requesting user''s ABA'),
    ('rollupAbaName',  'ROLLUP-EAST',             'Rollup ABA name (XShip)'),
    -- EDD path segments looked up by user name (officeId is request-supplied;
    -- reportId is derived from an eddSummaryReport result — neither is stored)
    ('endpoint',       'web',                     'Endpoint/channel segment'),
    ('denomination',   'USD-100',                 'Denomination filter'),
    ('differenceType', 'NET',                     'Difference-type filter'),
    -- XShipReport path segments
    ('zone',           'A1',                      'Activity zone code'),
    ('period',         '2026-Q2',                 'Reporting period'),
    ('denomType',      'NOTE',                    'Denomination type'),
    -- XShipDownload path segments
    ('requestId',      'REQ-55021',               'Prepared activity-download request id'),
    ('criteria',       'eyJ6b25lIjoiQTEifQ',      'Encoded activity criteria token')
) AS v(id_type, id_value, label)
WHERE  lower(u.full_name) = lower('Lei Liu')
ON CONFLICT (user_id, id_type) DO UPDATE
    SET id_value = EXCLUDED.id_value,
        label    = EXCLUDED.label;

-- A second example user (sparser entitlements) to exercise multi-user lookup.
-- Demo password is also "Password123!" (distinct scrypt salt/hash).
INSERT INTO fedline.app_user (full_name, username, email, password_hash)
VALUES ('Jordan Smith', 'jsmith', NULL,
        'scrypt$16384$8$1$99e607407b770fcc2ad30efd3a7e9d7d$51d40ebe49da36302092693402fa883074e35cf381eefe963a25f9c236b6cee8')
ON CONFLICT (lower(full_name)) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        updated_at    = now();

INSERT INTO fedline.user_identifier (user_id, id_type, id_value, label)
SELECT u.user_id, v.id_type, v.id_value, v.label
FROM   fedline.app_user u
CROSS  JOIN (VALUES
    ('officeId',      '67890',       'Requesting user''s office id'),
    ('abaNumber',     '000002',      '9-digit ABA routing number'),
    ('abaGroup',      'GRP-200',     'ABA group identifier'),
    ('userAba',       '000002',      'Requesting user''s ABA'),
    ('rollupAbaName', 'ROLLUP-WEST', 'Rollup ABA name (XShip)'),
    ('zone',          'B1',          'Activity zone code'),
    ('period',        '2026-Q2',     'Reporting period')
) AS v(id_type, id_value, label)
WHERE  lower(u.full_name) = lower('Jordan Smith')
ON CONFLICT (user_id, id_type) DO UPDATE
    SET id_value = EXCLUDED.id_value,
        label    = EXCLUDED.label;

-- ── Smoke checks (uncomment to verify after load) ────────────────────────────
-- SELECT fedline.get_user_id('Lei Liu');                 -- -> a user_id
-- SELECT fedline.get_user_id('Nobody');                  -- -> NULL (unknown)
-- SELECT fedline.get_user_identifiers('lei liu');        -- -> { "abaNumber": "000001", ... }
