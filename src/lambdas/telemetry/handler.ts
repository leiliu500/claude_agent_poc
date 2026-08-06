/**
 * Telemetry Lambda — the write and read side of the durable request log.
 *
 * Two entry paths, one function, because both need the same VPC attachment and the same table:
 *
 *   1. WRITE — a direct async invoke from the API entrypoint:
 *          { mode: "log", record: RequestLogInput }   ->  { ok }
 *      The entrypoint has no VPC config (it must reach Bedrock over the public endpoints), so it
 *      cannot write to RDS itself. It fires this invoke with InvocationType=Event, meaning the
 *      caller pays only the ~10ms enqueue and never blocks on the insert.
 *
 *   2. READ — POST /v1/metrics behind the same token authorizer as /v1/ask:
 *          { rangeMs?, from?, to?, buckets?, scope? }  ->  { ok, source, ...MetricsPayload }
 *      Returns AGGREGATES computed in SQL over the whole window, not a page of rows. The dashboard
 *      used to fetch raw records and sum them in the browser, which silently capped every KPI at
 *      the fetch limit; the database now does the arithmetic over every matching row.
 *
 * When the database is disabled the read path returns `source: "unavailable"` — the dashboard then
 * aggregates its local store with the same definitions and says which source it used.
 */
import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { hasDatabase } from "../../shared/pg.js";
import { appendRequestLog } from "../../shared/request-log.js";
import type { RequestLogInput } from "../../shared/request-log.js";
import { aggregateRequestLog } from "../../shared/request-metrics.js";
import type { MetricsPayload } from "../../shared/request-metrics.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "telemetry" });

/** Widest window a caller may ask for (30 days) — matches the dashboard's longest range. */
const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Series resolution. Bounded so one request cannot ask the database for thousands of buckets. */
const MAX_BUCKETS = 200;
const DEFAULT_BUCKETS = 12;

interface LogEvent {
  mode: "log";
  record: RequestLogInput;
}

/**
 * There is no `truncated` flag any more, and its absence is the point: the aggregates cover every
 * row in the window, so there is nothing left to clip. The two row-level lists (failures, activity)
 * are deliberately bounded, and each is labelled in the UI as "most recent N".
 */
type MetricsResponse =
  | ({ ok: true; source: "postgres" } & MetricsPayload)
  | { ok: boolean; source: "unavailable"; error?: string };

interface AuthorizerLambdaContext {
  userId?: string;
  userName?: string;
  username?: string;
  ids?: string;
}

type MetricsEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerLambdaContext>;

function respond(statusCode: number, body: MetricsResponse): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

interface MetricsRequest {
  /** Window width ending now. Ignored when both `from` and `to` are given. */
  rangeMs?: number;
  from?: string;
  to?: string;
  /** Number of time buckets for the series. Clamped server-side. */
  buckets?: number;
  /** "me" restricts to the calling user; anything else (default) is the deployment-wide view. */
  scope?: "me" | "all";
}

function parseBody(event: MetricsEvent): MetricsRequest {
  let raw = event.body ?? "{}";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  try {
    return raw.trim() ? (JSON.parse(raw) as MetricsRequest) : {};
  } catch {
    return {};
  }
}

/** Resolve the requested window, clamped to MAX_RANGE_MS and never extending into the future. */
function resolveWindow(req: MetricsRequest): { from: Date; to: Date } {
  const now = Date.now();
  const to = req.to ? Date.parse(req.to) : now;
  const toMs = Number.isFinite(to) ? Math.min(to, now) : now;
  let fromMs: number;
  if (req.from) {
    const parsed = Date.parse(req.from);
    fromMs = Number.isFinite(parsed) ? parsed : toMs - 24 * 60 * 60 * 1000;
  } else {
    const range = Number.isFinite(req.rangeMs) ? Number(req.rangeMs) : 24 * 60 * 60 * 1000;
    fromMs = toMs - Math.max(60_000, range);
  }
  // Clamp rather than reject: a dashboard asking for "all recorded" gets the widest window we serve.
  if (toMs - fromMs > MAX_RANGE_MS) fromMs = toMs - MAX_RANGE_MS;
  return { from: new Date(fromMs), to: new Date(toMs) };
}

const isLogEvent = (event: unknown): event is LogEvent =>
  typeof event === "object" && event !== null && (event as LogEvent).mode === "log";

export const handler = async (event: MetricsEvent | LogEvent): Promise<APIGatewayProxyResultV2 | { ok: boolean }> => {
  // ── Write path: async invoke from the entrypoint. Never throws — a failed insert must not
  //    produce an error metric that looks like a request failure. ──
  if (isLogEvent(event)) {
    if (!event.record) return { ok: false };
    const written = await appendRequestLog(event.record);
    return { ok: written };
  }

  // ── Read path: POST /v1/metrics. ──
  const ctx = event.requestContext?.authorizer?.lambda;
  if (!ctx?.userId) {
    // The route sits behind the token authorizer, so this only fires if the route is misconfigured.
    return respond(401, { ok: false, source: "unavailable", error: "UNAUTHORIZED: a valid session token is required." });
  }
  if (!hasDatabase()) {
    return respond(200, { ok: true, source: "unavailable" });
  }

  const req = parseBody(event);
  const { from, to } = resolveWindow(req);
  // The immediately preceding window of equal length, for the KPI deltas. Only offered when it lies
  // wholly inside the retained range — comparing against a window we would not serve on its own
  // would produce a delta against partial history.
  const span = to.getTime() - from.getTime();
  const prevFromMs = from.getTime() - span;
  const hasPrev = to.getTime() - prevFromMs <= MAX_RANGE_MS;
  const buckets = Math.max(1, Math.min(MAX_BUCKETS, Number(req.buckets) || DEFAULT_BUCKETS));

  try {
    // Aggregated in SQL over the WHOLE window — not a page of rows summed in the browser, which is
    // what made these numbers describe "the most recent N requests" instead of the range.
    const payload = await aggregateRequestLog({
      from,
      to,
      prevFrom: hasPrev ? new Date(prevFromMs) : null,
      prevTo: hasPrev ? from : null,
      buckets,
      userRef: req.scope === "me" ? ctx.userId : undefined,
    });
    if (!payload) return respond(200, { ok: true, source: "unavailable" });
    log.info("metrics aggregated", {
      from: from.toISOString(),
      to: to.toISOString(),
      requests: payload.totals.requests,
      buckets,
      scope: req.scope ?? "all",
    });
    return respond(200, { ok: true, source: "postgres", ...payload });
  } catch (err) {
    log.error("metrics aggregation failed", { error: String(err) });
    return respond(500, { ok: false, source: "unavailable", error: "Could not read the request log." });
  }
};
