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
