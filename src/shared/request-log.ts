/**
 * Durable request telemetry — the server-side source behind the operations dashboard.
 *
 * The web UI records the same observations in localStorage (web/telemetry.js) so the dashboard works
 * before this is deployed and keeps working if the database is disabled. This module is the
 * deployment-wide equivalent: one row per /v1/ask attempt, readable by any signed-in user.
 *
 * The record shape here is INTENTIONALLY identical to the browser's, so the dashboard runs one
 * aggregation layer over either source. Change one and you must change the other.
 *
 * Availability: only the VPC-attached Lambdas can reach Postgres, so both functions no-op / return
 * empty when DATABASE_URL is unset rather than throwing. Telemetry is never allowed to fail a
 * request — a dashboard that costs availability is a bad trade.
 */
import { hasDatabase, query } from "./pg.js";
import { createLogger } from "./logger.js";
import type { AgentStep } from "./types.js";

const log = createLogger({ mod: "request-log" });

/** Per-section digest — what one backend operation actually returned. */
export interface RequestLogSection {
  useCase: string;
  rows: number;
  endpoint?: string;
  httpMethod?: string;
  backend?: string;
}

/** RAG provenance, present only when the knowledge base answered. */
export interface RequestLogKb {
  retrieval?: string;
  matched?: number;
  citations?: number;
}

/** One observation of a completed request attempt. */
export interface RequestLogRecord {
  /** Stable id for the row; server rows use "srv-<request_id>" so they never collide with local ids. */
  id: string;
  /** Epoch milliseconds, so the browser needs no date parsing. */
  ts: number;
  traceId?: string;
  userRef?: string;
  userName?: string;
  question: string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  type?: string;
  reportId?: string;
  orchestrated?: boolean;
  rows: number;
  hadFile: boolean;
  exportFormat?: string;
  error?: string;
  errorKind?: string;
  trace: AgentStep[];
  sections: RequestLogSection[];
  kb?: RequestLogKb;
}

/** What the entrypoint hands over; the id and timestamp are assigned by the database. */
export type RequestLogInput = Omit<RequestLogRecord, "id" | "ts">;

/** Row shape returned by fedline.read_request_log. */
interface Row {
  request_id: string;
  occurred_at: Date | string;
  trace_id: string | null;
  user_ref: string | null;
  user_name: string | null;
  question: string;
  ok: boolean;
  http_status: number | null;
  latency_ms: number;
  report_type: string | null;
  report_id: string | null;
  orchestrated: boolean | null;
  rows_returned: number;
  had_file: boolean;
  export_format: string | null;
  error: string | null;
  error_kind: string | null;
  trace: AgentStep[] | null;
  sections: RequestLogSection[] | null;
  kb: RequestLogKb | null;
}

/** Longest question text kept, so one pathological prompt cannot bloat the table. */
const MAX_QUESTION = 400;
const MAX_ERROR = 300;

/**
 * Append one observation. Returns false (never throws) when there is no database or the insert
 * fails — the caller is on the request path and must not be affected either way.
 */
export async function appendRequestLog(rec: RequestLogInput): Promise<boolean> {
  if (!hasDatabase()) return false;
  try {
    await query(
      `SELECT fedline.log_request(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16::jsonb, $17::jsonb, $18::jsonb
       )`,
      [
        rec.traceId ?? null,
        rec.userRef ?? null,
        rec.userName ?? null,
        (rec.question ?? "").slice(0, MAX_QUESTION),
        rec.ok,
        rec.httpStatus ?? null,
        Math.max(0, Math.round(rec.latencyMs || 0)),
        rec.type ?? null,
        rec.reportId ?? null,
        rec.orchestrated ?? null,
        Math.max(0, Math.round(rec.rows || 0)),
        Boolean(rec.hadFile),
        rec.exportFormat ?? null,
        rec.error ? rec.error.slice(0, MAX_ERROR) : null,
        rec.errorKind ?? null,
        JSON.stringify(rec.trace ?? []),
        JSON.stringify(rec.sections ?? []),
        rec.kb ? JSON.stringify(rec.kb) : null,
      ],
    );
    return true;
  } catch (err) {
    log.warn("request-log append failed; the request itself is unaffected", { error: String(err) });
    return false;
  }
}

/** Read a window of observations, newest first. Returns [] when there is no database. */
export async function readRequestLog(opts: {
  from: Date;
  to: Date;
  limit?: number;
  userRef?: string;
}): Promise<RequestLogRecord[]> {
  if (!hasDatabase()) return [];
  const rows = await query<Row>(
    "SELECT * FROM fedline.read_request_log($1, $2, $3, $4)",
    [opts.from.toISOString(), opts.to.toISOString(), opts.limit ?? 1000, opts.userRef ?? null],
  );
  return rows.map((r) => ({
    id: `srv-${r.request_id}`,
    ts: new Date(r.occurred_at).getTime(),
    traceId: r.trace_id ?? undefined,
    userRef: r.user_ref ?? undefined,
    userName: r.user_name ?? undefined,
    question: r.question,
    ok: r.ok,
    httpStatus: r.http_status ?? undefined,
    latencyMs: r.latency_ms,
    type: r.report_type ?? undefined,
    reportId: r.report_id ?? undefined,
    orchestrated: r.orchestrated ?? undefined,
    rows: r.rows_returned,
    hadFile: r.had_file,
    exportFormat: r.export_format ?? undefined,
    error: r.error ?? undefined,
    errorKind: r.error_kind ?? undefined,
    trace: r.trace ?? [],
    sections: r.sections ?? [],
    kb: r.kb ?? undefined,
  }));
}
