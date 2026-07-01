/**
 * One-off DB migration Lambda: applies db/schema.sql to RDS from inside the VPC.
 *
 * The RDS instance is in private subnets with no bastion / NAT / internet gateway, so the only way
 * to run DDL against it is from a VPC-attached Lambda. This function is deployed with the DB role +
 * VPC config + DATABASE_URL (see terraform/main.tf) and invoked manually after a deploy that changes
 * db/schema.sql. The script is idempotent (CREATE ... IF NOT EXISTS / OR REPLACE / ON CONFLICT), so
 * re-invoking is safe.
 *
 * schema.sql is copied next to this bundle at build time (scripts/build.mjs) and read at runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "../../shared/pg.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "db-migrate" });

export const handler = async (
  event?: { query?: string; reset?: string },
): Promise<{ ok: boolean; error?: string; rows?: unknown[]; cleared?: number }> => {
  if (!process.env.DATABASE_URL) {
    return { ok: false, error: "DATABASE_URL is not set — nothing to migrate." };
  }
  // Admin maintenance: clear the report-memory cache (e.g. after the reportId format changed, old
  // rows hold stale ids). Scoped to that one table — not arbitrary DML.
  if (event?.reset === "report_memory") {
    try {
      const rows = await query<{ n: string }>(
        "WITH d AS (DELETE FROM fedline.report_memory RETURNING 1) SELECT count(*)::text AS n FROM d",
      );
      return { ok: true, cleared: Number(rows[0]?.n ?? 0) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  // Admin read-back path: run a caller-supplied SELECT to inspect the private DB (VPC-only, IAM-gated).
  // Guarded to read-only (SELECT/WITH) so this one-off can't be used to mutate data.
  if (event?.query) {
    const q = event.query.trim();
    if (!/^(select|with)\b/i.test(q)) {
      return { ok: false, error: "Only read-only SELECT/WITH queries are allowed here." };
    }
    try {
      const rows = await query<Record<string, unknown>>(q);
      return { ok: true, rows };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  let sql: string;
  try {
    sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  } catch (err) {
    log.error("could not read bundled schema.sql", { error: String(err) });
    return { ok: false, error: `schema.sql not found in bundle: ${String(err)}` };
  }
  try {
    // The whole idempotent script runs in one simple-protocol query (no bind params), which handles
    // the $$-quoted function bodies that a naive split-on-';' would break.
    await query(sql);
    log.info("schema applied successfully");
    return { ok: true };
  } catch (err) {
    log.error("schema apply failed", { error: String(err) });
    return { ok: false, error: String(err) };
  }
};
