/**
 * Shared Postgres access: a single, lazily-created connection pool reused across warm Lambda
 * invocations.
 *
 * Why a shared pool: user-directory.ts opens a fresh `pg.Pool` and `end()`s it on every call, which
 * pays a full connect/handshake per request. The report-memory store does two queries per turn, so
 * it uses this pooled helper instead — the pool is created once per warm container and reused.
 *
 * `pg` is imported lazily (a literal dynamic import so esbuild bundles it) only when DATABASE_URL is
 * set, so the default in-memory paths (tests, ORCHESTRATION_MODE=local) need no database and pay no
 * connection cost.
 */
import { createLogger } from "./logger.js";

const log = createLogger({ mod: "pg" });

/** Minimal structural type for the bits of pg.Pool we use (avoids a hard dep on @types/pg). */
export interface PgPool {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

let _poolPromise: Promise<PgPool> | undefined;

/** True when a database is configured; callers use this to choose the Postgres vs in-memory path. */
export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * TLS config for RDS. RDS Postgres requires SSL (rejects plaintext with "no pg_hba.conf entry ...
 * no encryption"), so every pool must connect over TLS. We don't pin the RDS CA here, so cert
 * verification is disabled — acceptable inside the private VPC; set DATABASE_SSL=disable only for a
 * local Postgres that doesn't speak TLS. Shared by this pool and user-directory's pools.
 */
export function sslConfig(): boolean | { rejectUnauthorized: boolean } {
  if ((process.env.DATABASE_SSL ?? "").toLowerCase() === "disable") return false;
  return { rejectUnauthorized: false };
}

/** Get (or lazily create) the shared pool. Throws if no DATABASE_URL or if `pg` cannot be loaded. */
async function pool(): Promise<PgPool> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!_poolPromise) {
    _poolPromise = (async () => {
      const pg = (await import("pg")) as unknown as {
        Pool: new (cfg: {
          connectionString: string;
          max?: number;
          idleTimeoutMillis?: number;
          ssl?: boolean | { rejectUnauthorized: boolean };
        }) => PgPool;
      };
      // Keep the pool small: a Lambda container serves one request at a time, so a couple of
      // connections is plenty and stays well under RDS connection limits across warm containers.
      return new pg.Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 30_000, ssl: sslConfig() });
    })().catch((err) => {
      // Reset so a transient failure (e.g. cold pg load) can be retried on the next call.
      _poolPromise = undefined;
      throw err;
    });
  }
  return _poolPromise;
}

/** Run a parameterised query against the shared pool. */
export async function query<R>(text: string, values?: unknown[]): Promise<R[]> {
  const p = await pool();
  const res = await p.query<R>(text, values);
  return res.rows;
}

/** Test seam: drop the cached pool so a subsequent call recreates it. */
export function resetPoolForTests(): void {
  _poolPromise = undefined;
  void log;
}
