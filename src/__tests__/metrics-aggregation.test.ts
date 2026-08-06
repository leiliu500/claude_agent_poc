/**
 * The browser's local aggregator (web/telemetry.js `aggregateLocal`) is the fallback producer of the
 * dashboard payload; Postgres is the primary one (src/shared/request-metrics.ts). They must agree on
 * what every metric MEANS, or the dashboard reports different numbers depending on which source
 * answered — a difference a viewer cannot see and would have no reason to suspect.
 *
 * These tests pin the definitions that are easy to get wrong on either side. Each one names the SQL
 * construct it mirrors, so a change to one is a visible change to the other.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const TELEMETRY_JS = join(here, "../../web/telemetry.js");

/* eslint-disable @typescript-eslint/no-explicit-any */
let T: any;

beforeAll(() => {
  const store = new Map<string, string>();
  const sandbox: any = {
    window: {},
    console,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(TELEMETRY_JS, "utf8"), sandbox, { filename: "telemetry.js" });
  T = sandbox.window.Telemetry;
});

const HOUR = 60 * 60 * 1000;
const base = 1_700_000_000_000;

function rec(over: Partial<any> = {}): any {
  return {
    id: "r" + Math.random().toString(36).slice(2, 8),
    ts: base,
    question: "q",
    ok: true,
    latencyMs: 100,
    rows: 0,
    hadFile: false,
    trace: [],
    sections: [],
    ...over,
  };
}

const win = (over: Partial<any> = {}) => ({
  from: base - HOUR, to: base + HOUR, prevFrom: null, prevTo: null, buckets: 4, ...over,
});

describe("local aggregation: definitions shared with the SQL producer", () => {
  it("interpolates percentiles linearly, like percentile_cont", () => {
    // Four samples, p95 falls between the top two: 300 + (400-300) * (2.85 - 2) = 385.
    const recs = [100, 200, 300, 400].map((ms) => rec({ latencyMs: ms }));
    const m = T.aggregateLocal(recs, win());
    expect(m.totals.medianMs).toBe(250);
    expect(m.totals.p95Ms).toBeCloseTo(385, 6);
  });

  it("excludes untimed requests from the percentile but not from the counts", () => {
    // SQL: FILTER (WHERE latency_ms > 0) on the ordered-set aggregate. A missing timing is not an
    // observation of "0 ms" — including it would drag the median toward zero.
    const recs = [rec({ latencyMs: 0 }), rec({ latencyMs: 100 }), rec({ latencyMs: 300 })];
    const m = T.aggregateLocal(recs, win());
    expect(m.totals.requests).toBe(3);
    expect(m.totals.medianMs).toBe(200);
  });

  it("counts a model invocation only when a model really ran", () => {
    // engine='llm' AND status='ran'. A skipped step never happened; a fallback step means the model
    // call FAILED and deterministic code answered — neither is a model invocation.
    const recs = [rec({ trace: [
      { stage: "route", engine: "llm", status: "ran", model: "m1", latencyMs: 10 },
      { stage: "report", engine: "llm", status: "skipped", model: "m1" },
      { stage: "analytics", engine: "llm", status: "fallback", model: "m1", latencyMs: 5 },
    ] })];
    const m = T.aggregateLocal(recs, win());
    expect(m.totals.modelInvocations).toBe(1);
    expect(m.totals.fallbacks).toBe(1);
  });

  it("counts fallback steps as executed in the engine mix", () => {
    // status <> 'skipped'. A fallback step DID execute, so the mix's total and the card's own
    // "N fell back" note are drawn from the same set.
    const recs = [rec({ trace: [
      { stage: "route", engine: "llm", status: "ran", latencyMs: 10 },
      { stage: "report", engine: "deterministic", status: "fallback", latencyMs: 5 },
      { stage: "gateway", engine: "proxy", status: "skipped" },
    ] })];
    const m = T.aggregateLocal(recs, win());
    expect(m.stepsExecuted).toBe(2);
    expect(m.engines.find((e: any) => e.engine === "proxy")).toBeUndefined();
    expect(m.engines.find((e: any) => e.engine === "deterministic").steps).toBe(1);
  });

  it("leaves an empty bucket's latency null while still reporting a zero count", () => {
    // An empty bucket is a real observation of "no requests" but NO observation of latency, so the
    // line must break rather than interpolate through it.
    const m = T.aggregateLocal([rec({ ts: base })], win({ buckets: 4 }));
    const empty = m.series.filter((b: any) => b.total === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const b of empty) {
      expect(b.medianMs).toBeNull();
      expect(b.p95Ms).toBeNull();
      expect(b.successRate).toBeNull();
    }
  });

  it("returns no prior baseline when the previous window is empty", () => {
    // An empty baseline is not a baseline of zero; a delta against it would read "+100%".
    const m = T.aggregateLocal([rec()], win({ prevFrom: base - 5 * HOUR, prevTo: base - 4 * HOUR }));
    expect(m.prev).toBeNull();
  });

  it("orders the row lists newest-first regardless of the input order", () => {
    // The lists are a tail-slice, so trusting the caller's order silently turns "most recent" into
    // "oldest" — a wrong list that still looks plausible.
    const asc = [rec({ ts: base - 3000 }), rec({ ts: base - 2000 }), rec({ ts: base - 1000 })];
    const fromAsc = T.aggregateLocal(asc, win());
    const fromDesc = T.aggregateLocal(asc.slice().reverse(), win());
    expect(fromAsc.activity.map((r: any) => r.ts)).toEqual([base - 1000, base - 2000, base - 3000]);
    expect(fromDesc.activity.map((r: any) => r.ts)).toEqual(fromAsc.activity.map((r: any) => r.ts));
  });

  it("counts only successful requests in the routing breakdown", () => {
    const recs = [rec({ type: "EDD" }), rec({ type: "EDD" }), rec({ type: "KB", ok: false })];
    const m = T.aggregateLocal(recs, win());
    expect(m.routing).toEqual([{ type: "EDD", n: 2 }]);
  });

  it("sums section rows per use case and counts the calls separately", () => {
    const recs = [
      rec({ sections: [{ useCase: "eddSummaryReport", rows: 5, endpoint: "/a", httpMethod: "GET", backend: "fedline" }] }),
      rec({ sections: [{ useCase: "eddSummaryReport", rows: 7, endpoint: "/a", httpMethod: "GET", backend: "fedline" }] }),
    ];
    const m = T.aggregateLocal(recs, win());
    expect(m.useCases).toEqual([{ useCase: "eddSummaryReport", rows: 12, calls: 2 }]);
    expect(m.operations).toEqual([{ method: "GET", path: "/a", backend: "fedline", calls: 2, rows: 12 }]);
  });

  it("reports an empty window without inventing zeros for absent measurements", () => {
    const m = T.aggregateLocal([], win());
    expect(m.totals.requests).toBe(0);
    expect(m.totals.medianMs).toBeNull();
    expect(m.totals.p95Ms).toBeNull();
    expect(m.kb.avgMatched).toBeNull();
    expect(m.routing).toEqual([]);
    expect(m.activity).toEqual([]);
  });

  it("ignores records outside the window", () => {
    const recs = [rec({ ts: base - 5 * HOUR }), rec({ ts: base }), rec({ ts: base + 5 * HOUR })];
    const m = T.aggregateLocal(recs, win());
    expect(m.totals.requests).toBe(1);
  });
});
