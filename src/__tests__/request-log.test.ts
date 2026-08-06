/**
 * Durable request log — the server-side source behind the operations dashboard.
 *
 * The contract that matters here is that the dashboard runs ONE aggregation layer over two sources,
 * so a row read back from Postgres must arrive in exactly the shape the browser records locally
 * (see web/telemetry.js). These tests pin that mapping, the no-database degradation, and the
 * read-window clamping the metrics route applies.
 *
 * `shared/pg.js` is mocked, so nothing here touches a database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state: { hasDb: boolean; rows: unknown[]; calls: { text: string; values?: unknown[] }[]; fail: boolean } = {
  hasDb: true,
  rows: [],
  calls: [],
  fail: false,
};

vi.mock("../shared/pg.js", () => ({
  hasDatabase: () => state.hasDb,
  query: vi.fn(async (text: string, values?: unknown[]) => {
    state.calls.push({ text, values });
    if (state.fail) throw new Error("connection refused");
    return state.rows;
  }),
}));

const { appendRequestLog, readRequestLog } = await import("../shared/request-log.js");

beforeEach(() => {
  state.hasDb = true;
  state.rows = [];
  state.calls = [];
  state.fail = false;
});

function dbRow(over: Record<string, unknown> = {}) {
  return {
    request_id: "42",
    occurred_at: "2026-08-06T12:00:00.000Z",
    trace_id: "trace-1",
    user_ref: "7",
    user_name: "Lei Liu",
    question: "Run the EDD summary report for 2026-Q2",
    ok: true,
    http_status: 200,
    latency_ms: 4200,
    report_type: "EDD",
    report_id: "rep-1",
    orchestrated: true,
    rows_returned: 88,
    had_file: false,
    export_format: null,
    error: null,
    error_kind: null,
    trace: [{ stage: "route", agent: "Routing classifier", engine: "llm", status: "ran", model: "m", confidence: 0.9, latencyMs: 900 }],
    sections: [{ useCase: "eddSummaryReport", rows: 88, endpoint: "/api/v1/eddSummaryReport", httpMethod: "GET", backend: "fedline" }],
    kb: null,
    ...over,
  };
}

describe("request log — read mapping", () => {
  it("maps a row into the record shape the dashboard aggregates", async () => {
    state.rows = [dbRow()];
    const rec = (await readRequestLog({ from: new Date("2026-08-06T00:00:00Z"), to: new Date("2026-08-06T23:59:59Z") }))[0]!;

    // Server ids are namespaced so they can never collide with a browser-generated id.
    expect(rec.id).toBe("srv-42");
    expect(rec.ts).toBe(Date.parse("2026-08-06T12:00:00.000Z"));
    expect(rec).toMatchObject({
      ok: true, httpStatus: 200, latencyMs: 4200, type: "EDD", reportId: "rep-1",
      orchestrated: true, rows: 88, hadFile: false, userName: "Lei Liu", traceId: "trace-1",
    });
    expect(rec.trace).toHaveLength(1);
    expect(rec.sections[0]).toMatchObject({ useCase: "eddSummaryReport", rows: 88, backend: "fedline" });
  });

  it("turns SQL NULLs into absent fields, never into zeros or empty strings", async () => {
    // A network-level failure has no status, no report and no trace — the dashboard must be able to
    // tell "not observed" from "observed as zero".
    state.rows = [dbRow({
      ok: false, http_status: null, report_type: null, report_id: null, orchestrated: null,
      rows_returned: 0, error: "TIMEOUT: no response", error_kind: "timeout", trace: null, sections: null, kb: null,
    })];
    const rec = (await readRequestLog({ from: new Date(0), to: new Date() }))[0]!;

    expect(rec.ok).toBe(false);
    expect(rec.httpStatus).toBeUndefined();
    expect(rec.type).toBeUndefined();
    expect(rec.orchestrated).toBeUndefined();
    expect(rec.kb).toBeUndefined();
    expect(rec.errorKind).toBe("timeout");
    // JSONB columns are non-null in the schema, but a defensive null must still land as an array.
    expect(rec.trace).toEqual([]);
    expect(rec.sections).toEqual([]);
  });

  it("preserves KB provenance when the knowledge base answered", async () => {
    state.rows = [dbRow({ report_type: "KB", kb: { retrieval: "postgres", matched: 6, citations: 3 } })];
    const rec = (await readRequestLog({ from: new Date(0), to: new Date() }))[0]!;
    expect(rec.kb).toEqual({ retrieval: "postgres", matched: 6, citations: 3 });
  });

  it("returns nothing when no database is configured", async () => {
    state.hasDb = false;
    expect(await readRequestLog({ from: new Date(0), to: new Date() })).toEqual([]);
    expect(state.calls).toHaveLength(0);
  });
});

describe("request log — append", () => {
  const base = {
    question: "Run the EDD summary report",
    ok: true,
    latencyMs: 1234,
    rows: 12,
    hadFile: false,
    trace: [],
    sections: [],
  };

  it("passes the JSONB columns as serialized JSON", async () => {
    await appendRequestLog({
      ...base,
      traceId: "t1",
      userRef: "7",
      userName: "Lei Liu",
      httpStatus: 200,
      type: "EDD",
      trace: [{ stage: "route", agent: "Routing classifier", engine: "llm", status: "ran" }],
      sections: [{ useCase: "eddSummaryReport", rows: 12 }],
    });
    const call = state.calls[0]!;
    expect(call.text).toContain("fedline.log_request");
    // Positions 16/17/18 are trace / sections / kb.
    expect(JSON.parse(String(call.values?.[15]))).toHaveLength(1);
    expect(JSON.parse(String(call.values?.[16]))[0].useCase).toBe("eddSummaryReport");
    expect(call.values?.[17]).toBeNull();
  });

  it("truncates an oversized question so one prompt cannot bloat the table", async () => {
    await appendRequestLog({ ...base, question: "x".repeat(1200) });
    expect(String(state.calls[0]!.values?.[3])).toHaveLength(400);
  });

  it("reports failure instead of throwing when the insert fails", async () => {
    // Telemetry sits on the request path; it must never be able to fail the caller's request.
    state.fail = true;
    await expect(appendRequestLog(base)).resolves.toBe(false);
  });

  it("no-ops without a database", async () => {
    state.hasDb = false;
    expect(await appendRequestLog(base)).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});
