/**
 * Telemetry Lambda: the async write invoke and the POST /v1/metrics read route.
 *
 * What is pinned here is the behaviour the dashboard depends on:
 *   · the read route is never anonymous — the log carries user names and question text;
 *   · a deployment without a database answers "unavailable" rather than an error, so the UI can
 *     quietly stay on its local store;
 *   · the requested window is clamped (never into the future, never wider than the log serves);
 *   · the route returns AGGREGATES, not rows — there is no row cap left to misreport, and the
 *     previous window is offered only when it fits inside the retained range.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RequestLogInput } from "../shared/request-log.js";
import type { MetricsPayload } from "../shared/request-metrics.js";

interface AggArgs {
  from: Date;
  to: Date;
  prevFrom: Date | null;
  prevTo: Date | null;
  buckets: number;
  userRef?: string;
}

const state: {
  hasDb: boolean;
  agg: AggArgs | null;
  requests: number;
  appended: RequestLogInput[];
  aggThrows: boolean;
} = { hasDb: true, agg: null, requests: 0, appended: [], aggThrows: false };

const emptyPayload = (a: AggArgs, requests: number): MetricsPayload => ({
  window: { from: +a.from, to: +a.to, prevFrom: a.prevFrom ? +a.prevFrom : null, prevTo: a.prevTo ? +a.prevTo : null, buckets: a.buckets },
  totals: { requests, succeeded: requests, failed: 0, medianMs: null, p95Ms: null, modelInvocations: 0, fallbacks: 0, rowsReturned: 0, orchestrated: 0 },
  prev: null,
  series: Array.from({ length: a.buckets }, (_, i) => ({
    t: +a.from + i, total: 0, ok: 0, failed: 0, medianMs: null, p95Ms: null, rowsReturned: 0, modelInvocations: 0, successRate: null,
  })),
  routing: [], engines: [], stepsExecuted: 0, stages: [], models: [], useCases: [], operations: [],
  kb: { answers: 0, avgMatched: null, avgCitations: null, stores: [] },
  exports: { formats: [], uploads: 0 },
  failures: [], activity: [],
});

vi.mock("../shared/pg.js", () => ({ hasDatabase: () => state.hasDb, query: vi.fn(async () => []) }));

vi.mock("../shared/request-log.js", () => ({
  appendRequestLog: vi.fn(async (rec: RequestLogInput) => { state.appended.push(rec); return true; }),
}));

vi.mock("../shared/request-metrics.js", () => ({
  aggregateRequestLog: vi.fn(async (opts: AggArgs) => {
    state.agg = opts;
    if (state.aggThrows) throw new Error("aggregation failed");
    return emptyPayload(opts, state.requests);
  }),
}));

const { handler } = await import("../lambdas/telemetry/handler.js");

beforeEach(() => {
  state.hasDb = true;
  state.agg = null;
  state.requests = 0;
  state.appended = [];
  state.aggThrows = false;
});

/**
 * An API-Gateway v2 event carrying the authorizer context the token authorizer injects.
 * `userId: null` models the misconfigured/unauthenticated case (null, not undefined — an explicit
 * `undefined` argument would silently take the default).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function metricsEvent(body: unknown, userId: string | null = "7"): any {
  return {
    rawPath: "/v1/metrics",
    requestContext: { http: { path: "/v1/metrics" }, authorizer: { lambda: userId ? { userId, userName: "Lei Liu" } : {} } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    headers: {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: any) => JSON.parse(res.body as string);

describe("telemetry: write path", () => {
  it("appends the record handed over by the entrypoint", async () => {
    const record: RequestLogInput = {
      question: "Run the EDD summary report", ok: true, latencyMs: 900, rows: 4,
      hadFile: false, trace: [], sections: [], userRef: "7",
    };
    expect(await handler({ mode: "log", record })).toEqual({ ok: true });
    expect(state.appended).toHaveLength(1);
    expect(state.appended[0]!.question).toBe("Run the EDD summary report");
  });

  it("ignores a log invoke with no record instead of throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await handler({ mode: "log" } as any)).toEqual({ ok: false });
    expect(state.appended).toHaveLength(0);
  });
});

describe("telemetry: POST /v1/metrics", () => {
  it("rejects a request with no authenticated caller", async () => {
    const res = await handler(metricsEvent({}, null));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).statusCode).toBe(401);
    expect(state.agg).toBeNull();
  });

  it("reports 'unavailable' — not an error — when no database is configured", async () => {
    state.hasDb = false;
    const res = await handler(metricsEvent({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ ok: true, source: "unavailable" });
    expect(state.agg).toBeNull();
  });

  it("resolves rangeMs into a window ending now", async () => {
    const before = Date.now();
    await handler(metricsEvent({ rangeMs: 60 * 60 * 1000 }));
    expect(state.agg).not.toBeNull();
    const { from, to } = state.agg!;
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime() - from.getTime()).toBe(60 * 60 * 1000);
  });

  it("clamps a window wider than the log serves down to 30 days", async () => {
    await handler(metricsEvent({ rangeMs: 365 * 24 * 60 * 60 * 1000 }));
    const { from, to } = state.agg!;
    expect(to.getTime() - from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("never reads into the future, even when asked to", async () => {
    const future = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    await handler(metricsEvent({ to: future, rangeMs: 60 * 60 * 1000 }));
    expect(state.agg!.to.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // ── The aggregate contract ──
  it("returns totals for the whole window, with no row cap to disclose", async () => {
    state.requests = 25_000; // far more than any per-request row limit would have returned
    const res = await handler(metricsEvent({ rangeMs: 24 * 60 * 60 * 1000 }));
    const body = bodyOf(res);
    expect(body).toMatchObject({ ok: true, source: "postgres" });
    expect(body.totals.requests).toBe(25_000);
    // The old contract's escape hatches must be gone, not merely unset: their presence is what let a
    // partial read look complete.
    expect(body.truncated).toBeUndefined();
    expect(body.records).toBeUndefined();
  });

  it("offers the immediately preceding window of equal length for the deltas", async () => {
    await handler(metricsEvent({ rangeMs: 60 * 60 * 1000 }));
    const { from, to, prevFrom, prevTo } = state.agg!;
    expect(prevTo!.getTime()).toBe(from.getTime());
    expect(from.getTime() - prevFrom!.getTime()).toBe(to.getTime() - from.getTime());
  });

  it("offers NO prior window when it would fall outside the retained range", async () => {
    // A 30-day window has no comparable predecessor inside a 30-day retention: comparing against it
    // would be a delta against history we do not actually hold.
    await handler(metricsEvent({ rangeMs: 30 * 24 * 60 * 60 * 1000 }));
    expect(state.agg!.prevFrom).toBeNull();
    expect(state.agg!.prevTo).toBeNull();
  });

  it("clamps the bucket count and defaults it", async () => {
    await handler(metricsEvent({ buckets: 999_999 }));
    expect(state.agg!.buckets).toBe(200);
    await handler(metricsEvent({ buckets: 14 }));
    expect(state.agg!.buckets).toBe(14);
    await handler(metricsEvent({}));
    expect(state.agg!.buckets).toBe(12);
  });

  it("returns one series entry per requested bucket", async () => {
    const res = await handler(metricsEvent({ buckets: 14 }));
    expect(bodyOf(res).series).toHaveLength(14);
  });

  it("scope 'me' restricts the read to the calling user; the default is deployment-wide", async () => {
    await handler(metricsEvent({ scope: "me" }));
    expect(state.agg!.userRef).toBe("7");
    await handler(metricsEvent({}));
    expect(state.agg!.userRef).toBeUndefined();
  });

  it("returns 500 with no leaked detail when the aggregation fails", async () => {
    state.aggThrows = true;
    const res = await handler(metricsEvent({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).statusCode).toBe(500);
    expect(bodyOf(res).error).toBe("Could not read the request log.");
  });

  it("tolerates a malformed body by falling back to the default window", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: any = metricsEvent({});
    ev.body = "{not json";
    await handler(ev);
    const { from, to } = state.agg!;
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
