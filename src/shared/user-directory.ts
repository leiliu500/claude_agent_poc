/**
 * User → identifiers directory: the seam the DBAgent's Lambda uses to resolve a *user name*
 * into the concrete IDs that fill downstream collaborator API calls (ABA, userAba, abaGroup,
 * rollupAbaName, endpoint, denomination, differenceType, zone, period, denomType, ...).
 *
 * Two backends, chosen at runtime (mirrors how src/mock/data.ts stands in for the real REST API):
 *   - Postgres (production): when DATABASE_URL is set, query the schema in db/schema.sql via
 *     `fedline.get_user_id()` + `fedline.get_user_identifiers()`. The `pg` driver is imported
 *     lazily so the deterministic/local path needs no dependency and no database.
 *   - In-memory directory (default): a faithful copy of db/schema.sql's seed data, so the whole
 *     pipeline — tests, ORCHESTRATION_MODE=local, the api-entrypoint fallback — runs with zero infra.
 *
 * `id_type` keys deliberately match TaskParams field names (src/shared/types.ts) so the result
 * merges straight into a task's params with no translation layer.
 */
import { createLogger } from "./logger.js";

const log = createLogger({ mod: "user-directory" });

/** Result of resolving a user name. `found=false` means "no such active user". */
export interface UserLookup {
  found: boolean;
  /** Canonical display name as stored (when found). */
  fullName?: string;
  /** id_type -> id_value, ready to merge into TaskParams. */
  identifiers: Record<string, string>;
}

/**
 * In-code mirror of db/schema.sql seed data. SINGLE SOURCE OF TRUTH for the no-database path.
 * Keep in sync with the INSERTs in db/schema.sql. Keys = TaskParams field names.
 *
 * Note: officeId and the date range are REQUEST-supplied (not stored), and reportId is
 * RUNTIME-derived from an eddSummaryReport result — none of those live here. See db/schema.sql.
 */
const DIRECTORY: ReadonlyArray<{ fullName: string; identifiers: Record<string, string> }> = [
  {
    fullName: "Lei Liu",
    identifiers: {
      abaNumber: "000001",
      abaGroup: "GRP-100",
      aba: "011000015",
      userAba: "000001",
      rollupAbaName: "ROLLUP-EAST",
      endpoint: "web",
      denomination: "USD-100",
      differenceType: "NET",
      zone: "A1",
      period: "2026-Q2",
      denomType: "NOTE",
      requestId: "REQ-55021",
      criteria: "eyJ6b25lIjoiQTEifQ",
    },
  },
  {
    fullName: "Jordan Smith",
    identifiers: {
      abaNumber: "000002",
      abaGroup: "GRP-200",
      userAba: "000002",
      rollupAbaName: "ROLLUP-WEST",
      zone: "B1",
      period: "2026-Q2",
    },
  },
];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Look a user up in the in-code directory (the no-database path). */
function lookupInMemory(userName: string): UserLookup {
  const hit = DIRECTORY.find((u) => norm(u.fullName) === norm(userName));
  if (!hit) return { found: false, identifiers: {} };
  return { found: true, fullName: hit.fullName, identifiers: { ...hit.identifiers } };
}

/**
 * Look a user up in Postgres. Lazily imports `pg` so the dependency is only needed when a real
 * DATABASE_URL is configured. Throws on connection/query failure so the caller can decide whether
 * to surface the error or fall back.
 */
async function lookupPostgres(userName: string, databaseUrl: string): Promise<UserLookup> {
  // Lazy import keeps `pg` out of the bundle/closure for the default in-memory path. A non-literal
  // specifier defers module resolution to runtime (pg is provided via a Lambda layer when enabled).
  const pgModule = "pg";
  const pg = (await import(pgModule)) as unknown as { Pool: new (cfg: { connectionString: string }) => PgPool };
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const idRes = await pool.query<{ user_id: string }>("SELECT fedline.get_user_id($1) AS user_id", [userName]);
    const userId = idRes.rows[0]?.user_id;
    if (userId === null || userId === undefined) return { found: false, identifiers: {} };

    const res = await pool.query<{ identifiers: Record<string, string> }>(
      "SELECT fedline.get_user_identifiers($1) AS identifiers",
      [userName],
    );
    return { found: true, fullName: userName, identifiers: res.rows[0]?.identifiers ?? {} };
  } finally {
    await pool.end();
  }
}

/** Minimal structural type for the bits of pg.Pool we use (avoids a hard dependency on @types/pg). */
interface PgPool {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

/**
 * Resolve a user name to its stored identifiers. Uses Postgres when DATABASE_URL is set, else the
 * in-code directory. A Postgres failure degrades to the in-memory directory rather than failing the
 * whole request (the in-memory seed mirrors the database).
 */
export async function lookupUserIdentifiers(userName: string): Promise<UserLookup> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    try {
      return await lookupPostgres(userName, databaseUrl);
    } catch (err) {
      log.warn("postgres lookup failed; falling back to in-memory directory", { error: String(err) });
    }
  }
  return lookupInMemory(userName);
}

// ── User-name extraction ──────────────────────────────────────────────────────
// Explicit forms the chat user can use to name themselves, most specific first.
const USER_NAME_PATTERNS: RegExp[] = [
  /\buser(?:\s*name)?\s*[:=]\s*([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/i,
  /\b(?:for|as)\s+user\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/i,
  /\b(?:on behalf of|requested by)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/i,
];

/**
 * Pull a user name out of the question. Tries explicit "user name: X" style forms first, then
 * matches any known directory name appearing verbatim in the text. Returns undefined when no user
 * is identifiable — the caller treats that as a validation error.
 */
export function extractUserName(question: string): string | undefined {
  for (const re of USER_NAME_PATTERNS) {
    const m = question.match(re);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ");
  }
  // Fall back to any directory name mentioned directly (e.g. "...report for Lei Liu").
  const q = question.toLowerCase();
  for (const u of DIRECTORY) {
    if (q.includes(norm(u.fullName))) return u.fullName;
  }
  return undefined;
}

/** Names known to the in-code directory (used by tests + diagnostics). */
export function knownUserNames(): string[] {
  return DIRECTORY.map((u) => u.fullName);
}
