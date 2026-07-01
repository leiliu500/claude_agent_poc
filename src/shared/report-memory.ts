/**
 * Per-user report memory: remembers what a user's prior report runs produced so a follow-up turn
 * can reuse them instead of recomputing.
 *
 * The headline case: an `eddSummaryReport` produces a `reportId` that an `eddDetailReport` needs.
 * Without memory the summary is re-run every time the user later asks for the detail. Here the
 * summary's reportId is persisted per user + signature and recalled on the next turn — even in a
 * later session (the store is Postgres, keyed by user_id).
 *
 * Two backends, chosen at runtime (mirrors shared/user-directory.ts):
 *   - Postgres (production): when DATABASE_URL is set, via the fedline.remember_report /
 *     recall_report / recall_latest_report functions in db/schema.sql.
 *   - In-process Map (default): ephemeral per-container store so tests, ORCHESTRATION_MODE=local
 *     and the api-entrypoint local fallback run with zero infra. Not cross-session — that's fine
 *     for those paths; only the flow-process node (VPC-attached) reaches Postgres.
 *
 * Every function is best-effort: a Postgres failure logs and degrades to the in-memory map rather
 * than failing the request. Memory is an optimisation, never a correctness dependency — a miss just
 * means today's behaviour (run the summary to obtain the reportId).
 */
import { createLogger } from "./logger.js";
import { hasDatabase, query } from "./pg.js";
import type { TaskParams } from "./types.js";

const log = createLogger({ mod: "report-memory" });

/** A remembered report: the reusable id plus the params it ran with. */
export interface RememberedReport {
  reportId: string;
  useCase: string;
  params: TaskParams;
}

export interface RememberInput {
  /** The requesting user's id (fedline.app_user.user_id, as a string). Memory is per user. */
  userId: string;
  /** Signature of the report's identifying params (orchestrator.eddSummarySig). */
  key: string;
  useCase: string;
  reportId: string;
  params: TaskParams;
}

// ── In-process fallback store (ephemeral; used when no DATABASE_URL or on a Postgres failure) ──
interface MemRow extends RememberedReport {
  key: string;
  updatedAt: number;
}
/** userId -> (report_key -> row). */
const MEM = new Map<string, Map<string, MemRow>>();
let _memClock = 0; // monotonic stand-in for updated_at (Date.now() is avoided for determinism/tests)

function memBucket(userId: string): Map<string, MemRow> {
  let b = MEM.get(userId);
  if (!b) {
    b = new Map();
    MEM.set(userId, b);
  }
  return b;
}

function rememberInMemory(input: RememberInput): void {
  memBucket(input.userId).set(input.key, {
    key: input.key,
    reportId: input.reportId,
    useCase: input.useCase,
    params: input.params,
    updatedAt: ++_memClock,
  });
}

function recallInMemory(userId: string, key: string): RememberedReport | undefined {
  const row = MEM.get(userId)?.get(key);
  return row ? { reportId: row.reportId, useCase: row.useCase, params: row.params } : undefined;
}

function recallLatestInMemory(userId: string, useCase: string): RememberedReport | undefined {
  let best: MemRow | undefined;
  for (const row of MEM.get(userId)?.values() ?? []) {
    if (row.useCase === useCase && (!best || row.updatedAt > best.updatedAt)) best = row;
  }
  return best ? { reportId: best.reportId, useCase: best.useCase, params: best.params } : undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a report a user ran so a later turn can reuse its reportId. Best-effort: never throws.
 * Requires a userId (memory is per user) — a no-op without one (e.g. the legacy no-auth path).
 */
export async function rememberReport(input: RememberInput): Promise<void> {
  if (!input.userId || !input.reportId || !input.key) return;
  // Always keep the in-memory mirror warm so a later Postgres failure still has something to serve.
  rememberInMemory(input);
  if (!hasDatabase()) return;
  try {
    await query("SELECT fedline.remember_report($1::bigint, $2, $3, $4, $5::jsonb)", [
      input.userId,
      input.key,
      input.useCase,
      input.reportId,
      JSON.stringify(input.params ?? {}),
    ]);
    log.info("remembered report", { userId: input.userId, useCase: input.useCase, key: input.key });
  } catch (err) {
    log.warn("postgres remember_report failed; kept in-memory only", { error: String(err) });
  }
}

/** Recall a specific remembered report by exact signature. Best-effort: returns undefined on miss/error. */
export async function recallReport(userId: string, key: string): Promise<RememberedReport | undefined> {
  if (!userId || !key) return undefined;
  if (hasDatabase()) {
    try {
      const rows = await query<{ report_id: string; params: TaskParams; use_case: string }>(
        "SELECT report_id, params, use_case FROM fedline.recall_report($1::bigint, $2)",
        [userId, key],
      );
      const row = rows[0];
      if (row) return { reportId: row.report_id, params: row.params ?? {}, useCase: row.use_case };
      return undefined;
    } catch (err) {
      log.warn("postgres recall_report failed; using in-memory mirror", { error: String(err) });
    }
  }
  return recallInMemory(userId, key);
}

/** Recall a user's most recent report for a use case (the "now the detail" convenience path). */
export async function recallLatestReport(userId: string, useCase: string): Promise<RememberedReport | undefined> {
  if (!userId || !useCase) return undefined;
  if (hasDatabase()) {
    try {
      const rows = await query<{ report_id: string; params: TaskParams; report_key: string }>(
        "SELECT report_id, params, report_key FROM fedline.recall_latest_report($1::bigint, $2)",
        [userId, useCase],
      );
      const row = rows[0];
      if (row) return { reportId: row.report_id, params: row.params ?? {}, useCase };
      return undefined;
    } catch (err) {
      log.warn("postgres recall_latest_report failed; using in-memory mirror", { error: String(err) });
    }
  }
  return recallLatestInMemory(userId, useCase);
}

/** Test seam: clear the in-process fallback store between cases. */
export function clearMemoryForTests(): void {
  MEM.clear();
  _memClock = 0;
}
