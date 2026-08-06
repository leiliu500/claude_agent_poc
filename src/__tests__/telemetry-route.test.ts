/**
 * Telemetry Lambda: the async write invoke and the POST /v1/metrics read route.
 *
 * What is pinned here is the behaviour the dashboard depends on:
 *   · the read route is never anonymous — the log carries user names and question text;
 *   · a deployment without a database answers "unavailable" rather than an error, so the UI can
 *     quietly stay on its local store;
 *   · the requested window is clamped (never into the future, never wider than the log serves) and
 *     the row cap is reported, so a truncated read can't be mistaken for a complete picture.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RequestLogInput } from "../shared/request-log.js";

const state: {
  hasDb: boolean;
  read: { from: Date; to: Date; limit?: number; userRef?: string } | null;
  rows: number;
  appended: RequestLogInput[];
  readThrows: boolean;
} = { hasDb: true, read: null, rows: 0, appended: [], readThrows: false };

vi.mock("../shared/pg.js", () => ({ hasDatabase: () => state.hasDb, query: vi.fn(async () => []) }));

vi.mock("../shared/request-log.js", () => ({
  appendRequestLog: vi.fn(async (rec: RequestLogInput) => { state.appended.push(rec); return true; }),
  readRequestLog: vi.fn(async (opts: { from: Date; to: Date; limit?: number; userRef?: string }) => {
    state.read = opts;
    if (state.readThrows) throw new Error("read failed");
    return Array.from({ length: state.rows }, (_, i) => ({
      id: `srv-${i}`, ts: Date.now(), question: "q", ok: true, latencyMs: 1, rows: 0,
      hadFile: false, trace: [], sections: [],
    }));
  }),
}));

const { handler } = await import("../lambdas/telemetry/handler.js");

beforeEach(() => {
  state.hasDb = true;
  state.read = null;
  state.rows = 0;
  state.appended = [];
  state.readThrows = false;
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
    expect(state.read).toBeNull();
  });

  it("reports 'unavailable' — not an error — when no database is configured", async () => {
    state.hasDb = false;
    const res = await handler(metricsEvent({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any).statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ ok: true, source: "unavailable", records: [] });
  });

  it("resolves rangeMs into a window ending now", async () => {
    const before = Date.now();
    await handler(metricsEvent({ rangeMs: 60 * 60 * 1000 }));
    expect(state.read).not.toBeNull();
    const { from, to } = state.read!;
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime() - from.getTime()).toBe(60 * 60 * 1000);
  });

  it("clamps a window wider than the log serves down to 30 days", async () => {
    await handler(metricsEvent({ rangeMs: 365 * 24 * 60 * 60 * 1000 }));
    const { from, to } = state.read!;
    expect(to.getTime() - from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("never reads into the future, even when asked to", async () => {
    const future = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    await handler(metricsEvent({ to: future, rangeMs: 60 * 60 * 1000 }));
    expect(state.read!.to.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("caps the row limit and flags a truncated read", async () => {
    state.rows = 2000;
    const res = await handler(metricsEvent({ limit: 999999 }));
    expect(state.read!.limit).toBe(2000);
    expect(bodyOf(res)).toMatchObject({ ok: true, source: "postgres", truncated: true });
  });

  it("does not flag truncation when the window fits under the limit", async () => {
    state.rows = 3;
    const res = await handler(metricsEvent({ limit: 100 }));
    expect(bodyOf(res).truncated).toBe(false);
    expect(bodyOf(res).records).toHaveLength(3);
  });

  it("scope 'me' restricts the read to the calling user; the default is deployment-wide", async () => {
    await handler(metricsEvent({ scope: "me" }));
    expect(state.read!.userRef).toBe("7");
    await handler(metricsEvent({}));
    expect(state.read!.userRef).toBeUndefined();
  });

  it("returns 500 with no leaked detail when the read fails", async () => {
    state.readThrows = true;
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
    const { from, to } = state.read!;
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
