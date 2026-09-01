/**
 * Dashboard aggregation, computed in SQL over the WHOLE request log.
 *
 * Why this exists: the dashboard used to fetch a page of raw rows (capped at 2000) and aggregate
 * them in the browser. Every number was therefore computed over a truncated sample whenever the
 * window held more rows than the cap — a KPI that silently describes "the most recent 2000
 * requests" while being labelled "requests in range" is a wrong number, not a slow one. Postgres
 * aggregates the full window in one round trip instead, so the totals are the real totals.
 *
 * Fidelity to the browser implementation is deliberate and load-bearing — the local store is still
 * the fallback when there is no database, and the two must not disagree about what a metric MEANS:
 *   · latency percentiles are LINEAR-INTERPOLATED (percentile_cont) over latency_ms > 0, matching
 *     web/telemetry.js `agg.percentile`; a zero/absent timing is not an observation of "0 ms";
 *   · a "model invocation" is a trace step with engine='llm' AND status='ran' — a step that was
 *     skipped, or that fell back to deterministic, did not call a model;
 *   · empty buckets return total 0 (a real observation: no requests) but NULL latency (no
 *     observation at all), so the client draws a gap rather than interpolating through it.
 *
 * Everything here is read-only. Returns null when there is no database so the caller can fall back.
 */
import { hasDatabase, query } from "./pg.js";

/** Totals for one window. Percentiles are null when the window holds no timed request. */
export interface MetricsTotals {
  requests: number;
  succeeded: number;
  failed: number;
  medianMs: number | null;
  p95Ms: number | null;
  modelInvocations: number;
  fallbacks: number;
  rowsReturned: number;
  orchestrated: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Tokens from model ids without a configured price; costUsd is only the known-cost subtotal. */
  unpricedTokens: number;
}

/** One time bucket of the current window. `medianMs`/`p95Ms` are null when the bucket is empty. */
export interface MetricsBucket {
  t: number;
  total: number;
  ok: number;
  failed: number;
  medianMs: number | null;
  p95Ms: number | null;
  rowsReturned: number;
  modelInvocations: number;
  successRate: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedTokens: number;
}

export interface MetricsPayload {
  window: { from: number; to: number; prevFrom: number | null; prevTo: number | null; buckets: number };
  totals: MetricsTotals;
  /** Null when there is no comparable prior window — the UI omits the delta rather than faking it. */
  prev: MetricsTotals | null;
  series: MetricsBucket[];
  routing: Array<{ type: string; n: number }>;
  engines: Array<{ engine: string; steps: number }>;
  /** Steps that actually executed (ran + fallback) — the denominator for the engine mix. */
  stepsExecuted: number;
  stages: Array<{ stage: string; avgMs: number | null; steps: number }>;
  models: Array<{
    model: string;
    steps: number;
    calls: number;
    avgConfidence: number | null;
    medianMs: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    unpricedTokens: number;
  }>;
  useCases: Array<{ useCase: string; rows: number; calls: number }>;
  operations: Array<{ method: string | null; path: string; backend: string | null; calls: number; rows: number }>;
  kb: { answers: number; avgMatched: number | null; avgCitations: number | null; stores: Array<{ store: string; n: number }> };
  exports: { formats: Array<{ format: string; n: number }>; uploads: number };
  failures: MetricsRow[];
  activity: MetricsRow[];
}

/** The row subset the two row-level cards need. Deliberately NOT the whole record. */
export interface MetricsRow {
  id: string;
  ts: number;
  userName: string | null;
  question: string;
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  type: string | null;
  rows: number;
  error: string | null;
  errorKind: string | null;
  steps: number;
  llmSteps: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedTokens: number;
}

/** Rows returned for the two row-level cards. Bounded, so they cannot grow with the window. */
const FAILURE_ROWS = 8;
const ACTIVITY_ROWS = 40;

/**
 * One statement, one round trip. Every aggregate is a separate CTE over the same window so the
 * planner scans the log once; the final SELECT assembles them into a single JSON document.
 *
 * `tagged` unions the current and previous windows behind a `w` tag so totals, steps and sections
 * are each expressed ONCE and evaluated for both — the alternative is two near-identical copies of
 * every aggregate, which is exactly how the two windows drift apart.
 */
const SQL = `
WITH p AS (
  SELECT $1::timestamptz AS f,
         $2::timestamptz AS t,
         $3::timestamptz AS pf,
         $4::timestamptz AS pt,
         GREATEST(1, LEAST(200, $5::int)) AS nb,
         $6::text AS user_ref
),
-- A null user_ref is the deployment-wide view; a non-null one scopes every aggregate below to that
-- user, so "scope: me" cannot leak another user's counts into a total.
tagged AS (
  SELECT 'cur'::text AS w, r.* FROM fedline.request_log r, p
   WHERE r.occurred_at >= p.f AND r.occurred_at < p.t
     AND (p.user_ref IS NULL OR r.user_ref = p.user_ref)
  UNION ALL
  SELECT 'prv'::text AS w, r.* FROM fedline.request_log r, p
   WHERE p.pf IS NOT NULL AND r.occurred_at >= p.pf AND r.occurred_at < p.pt
     AND (p.user_ref IS NULL OR r.user_ref = p.user_ref)
),
steps AS (
  SELECT g.w, g.request_id,
         jsonb_array_length(COALESCE(g.usage, '[]'::jsonb)) > 0 AS has_usage,
         e->>'stage'  AS stage,
         e->>'engine' AS engine,
         e->>'status' AS status,
         NULLIF(e->>'model', '') AS model,
         CASE WHEN jsonb_typeof(e->'confidence') = 'number' THEN (e->>'confidence')::double precision END AS confidence,
         CASE WHEN jsonb_typeof(e->'latencyMs')  = 'number' THEN (e->>'latencyMs')::double precision  END AS latency_ms
    FROM tagged g, LATERAL jsonb_array_elements(COALESCE(g.trace, '[]'::jsonb)) e
),
usage AS (
  SELECT g.w, g.request_id,
         NULLIF(e->>'model', '') AS model,
         NULLIF(e->>'operation', '') AS operation,
         COALESCE(CASE WHEN jsonb_typeof(e->'inputTokens')  = 'number' THEN (e->>'inputTokens')::bigint  END, 0) AS input_tokens,
         COALESCE(CASE WHEN jsonb_typeof(e->'outputTokens') = 'number' THEN (e->>'outputTokens')::bigint END, 0) AS output_tokens,
         COALESCE(CASE WHEN jsonb_typeof(e->'totalTokens')  = 'number' THEN (e->>'totalTokens')::bigint  END, 0) AS total_tokens,
         CASE WHEN jsonb_typeof(e->'costUsd') = 'number' THEN (e->>'costUsd')::double precision END AS cost_usd
    FROM tagged g, LATERAL jsonb_array_elements(COALESCE(g.usage, '[]'::jsonb)) e
),
secs AS (
  SELECT g.w,
         NULLIF(e->>'useCase', '')    AS use_case,
         NULLIF(e->>'endpoint', '')   AS endpoint,
         NULLIF(e->>'httpMethod', '') AS http_method,
         NULLIF(e->>'backend', '')    AS backend,
         COALESCE(CASE WHEN jsonb_typeof(e->'rows') = 'number' THEN (e->>'rows')::bigint END, 0) AS rows
    FROM tagged g, LATERAL jsonb_array_elements(COALESCE(g.sections, '[]'::jsonb)) e
),
-- Per-window totals. FILTER on the ordered-set aggregate keeps untimed rows out of the percentile
-- without dropping them from the counts.
tot AS (
  SELECT g.w,
         count(*)                                        AS requests,
         count(*) FILTER (WHERE g.ok)                     AS succeeded,
         count(*) FILTER (WHERE NOT g.ok)                 AS failed,
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY g.latency_ms) FILTER (WHERE g.latency_ms > 0) AS median_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY g.latency_ms) FILTER (WHERE g.latency_ms > 0) AS p95_ms,
         COALESCE(sum(g.rows_returned), 0)                AS rows_returned,
         count(*) FILTER (WHERE g.orchestrated)           AS orchestrated
    FROM tagged g GROUP BY g.w
),
step_tot AS (
  SELECT s.w,
         count(*) FILTER (WHERE NOT s.has_usage AND s.engine = 'llm' AND s.status = 'ran') AS legacy_model_invocations,
         count(*) FILTER (WHERE s.status = 'fallback')                 AS fallbacks
    FROM steps s GROUP BY s.w
),
usage_tot AS (
  SELECT u.w, count(*) AS calls,
         COALESCE(sum(u.input_tokens), 0) AS input_tokens,
         COALESCE(sum(u.output_tokens), 0) AS output_tokens,
         COALESCE(sum(u.total_tokens), 0) AS total_tokens,
         COALESCE(sum(u.cost_usd), 0) AS cost_usd,
         COALESCE(sum(u.total_tokens) FILTER (WHERE u.cost_usd IS NULL), 0) AS unpriced_tokens
    FROM usage u GROUP BY u.w
),
-- Bucket index by arithmetic rather than generate_series, so a window that does not divide evenly
-- cannot produce an off-by-one extra bucket. LEAST() pins the right edge into the last bucket.
binned AS (
  SELECT LEAST(p.nb - 1,
               GREATEST(0, floor(extract(epoch FROM (g.occurred_at - p.f))
                                 / NULLIF(extract(epoch FROM (p.t - p.f)) / p.nb, 0))::int)) AS idx,
         g.ok, g.latency_ms, g.rows_returned, g.request_id, g.trace, g.usage
    FROM tagged g, p WHERE g.w = 'cur'
),
bin_steps AS (
  SELECT b.idx, count(*) FILTER (WHERE s.engine = 'llm' AND s.status = 'ran') AS model_invocations
    FROM binned b
    JOIN LATERAL jsonb_array_elements(COALESCE(b.trace, '[]'::jsonb)) e ON TRUE
    JOIN LATERAL (SELECT e->>'engine' AS engine, e->>'status' AS status) s ON TRUE
   WHERE jsonb_array_length(COALESCE(b.usage, '[]'::jsonb)) = 0
   GROUP BY b.idx
),
bin_usage AS (
  SELECT b.idx, count(*) AS calls,
         COALESCE(sum(CASE WHEN jsonb_typeof(e->'inputTokens') = 'number' THEN (e->>'inputTokens')::bigint ELSE 0 END), 0) AS input_tokens,
         COALESCE(sum(CASE WHEN jsonb_typeof(e->'outputTokens') = 'number' THEN (e->>'outputTokens')::bigint ELSE 0 END), 0) AS output_tokens,
         COALESCE(sum(CASE WHEN jsonb_typeof(e->'totalTokens') = 'number' THEN (e->>'totalTokens')::bigint ELSE 0 END), 0) AS total_tokens,
         COALESCE(sum(CASE WHEN jsonb_typeof(e->'costUsd') = 'number' THEN (e->>'costUsd')::double precision ELSE 0 END), 0) AS cost_usd,
         COALESCE(sum(CASE WHEN jsonb_typeof(e->'costUsd') IS DISTINCT FROM 'number' AND jsonb_typeof(e->'totalTokens') = 'number' THEN (e->>'totalTokens')::bigint ELSE 0 END), 0) AS unpriced_tokens
    FROM binned b, LATERAL jsonb_array_elements(COALESCE(b.usage, '[]'::jsonb)) e
   GROUP BY b.idx
),
axis AS (SELECT generate_series(0, (SELECT nb FROM p) - 1) AS idx),
series AS (
  SELECT a.idx,
         (SELECT extract(epoch FROM (p.f + (p.t - p.f) * a.idx / p.nb)) * 1000 FROM p) AS t_ms,
         count(b.*)                                       AS total,
         count(b.*) FILTER (WHERE b.ok)                    AS ok,
         count(b.*) FILTER (WHERE NOT b.ok)                AS failed,
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY b.latency_ms) FILTER (WHERE b.latency_ms > 0) AS median_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY b.latency_ms) FILTER (WHERE b.latency_ms > 0) AS p95_ms,
         COALESCE(sum(b.rows_returned), 0)                 AS rows_returned,
         COALESCE(max(bs.model_invocations), 0) + COALESCE(max(bu.calls), 0) AS model_invocations,
         COALESCE(max(bu.input_tokens), 0) AS input_tokens,
         COALESCE(max(bu.output_tokens), 0) AS output_tokens,
         COALESCE(max(bu.total_tokens), 0) AS total_tokens,
         COALESCE(max(bu.cost_usd), 0) AS cost_usd,
         COALESCE(max(bu.unpriced_tokens), 0) AS unpriced_tokens
    FROM axis a
    LEFT JOIN binned b   ON b.idx = a.idx
    LEFT JOIN bin_steps bs ON bs.idx = a.idx
    LEFT JOIN bin_usage bu ON bu.idx = a.idx
   GROUP BY a.idx
),
routing AS (
  SELECT g.report_type AS type, count(*) AS n
    FROM tagged g WHERE g.w = 'cur' AND g.ok AND g.report_type IS NOT NULL
   GROUP BY g.report_type
),
-- 'ran' AND 'fallback' both EXECUTED; only 'skipped' never happened. A fallback step ran
-- deterministic code after a model failure, so it belongs in the engine mix (under whichever engine
-- it reports) even though it is not a model invocation.
engines AS (
  SELECT s.engine, count(*) AS steps FROM steps s
   WHERE s.w = 'cur' AND s.status <> 'skipped' AND s.engine IS NOT NULL GROUP BY s.engine
),
stages AS (
  SELECT s.stage, avg(s.latency_ms) AS avg_ms, count(*) FILTER (WHERE s.latency_ms IS NOT NULL) AS steps
    FROM steps s
   WHERE s.w = 'cur' AND s.status <> 'skipped' AND s.stage IS NOT NULL AND s.latency_ms IS NOT NULL
   GROUP BY s.stage
),
trace_models AS (
  SELECT s.model,
         count(*) AS steps,
         count(*) FILTER (WHERE NOT s.has_usage AND s.engine = 'llm' AND s.status = 'ran') AS legacy_calls,
         avg(s.confidence) AS avg_confidence,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.latency_ms IS NOT NULL) AS median_ms
    FROM steps s WHERE s.w = 'cur' AND s.status <> 'skipped' AND s.model IS NOT NULL GROUP BY s.model
),
usage_models AS (
  SELECT u.model, count(*) AS calls,
         sum(u.input_tokens) AS input_tokens, sum(u.output_tokens) AS output_tokens,
         sum(u.total_tokens) AS total_tokens, COALESCE(sum(u.cost_usd), 0) AS cost_usd,
         COALESCE(sum(u.total_tokens) FILTER (WHERE u.cost_usd IS NULL), 0) AS unpriced_tokens
    FROM usage u WHERE u.w = 'cur' AND u.model IS NOT NULL GROUP BY u.model
),
models AS (
  SELECT COALESCE(tm.model, um.model) AS model, COALESCE(tm.steps, 0) AS steps,
         COALESCE(um.calls, 0) + COALESCE(tm.legacy_calls, 0) AS calls, tm.avg_confidence, tm.median_ms,
         COALESCE(um.input_tokens, 0) AS input_tokens, COALESCE(um.output_tokens, 0) AS output_tokens,
         COALESCE(um.total_tokens, 0) AS total_tokens, COALESCE(um.cost_usd, 0) AS cost_usd,
         COALESCE(um.unpriced_tokens, 0) AS unpriced_tokens
    FROM trace_models tm FULL OUTER JOIN usage_models um ON um.model = tm.model
),
-- Total executed steps, so the mix's own denominator comes from the same filter as its segments.
step_exec AS (
  SELECT count(*) AS executed, count(*) FILTER (WHERE s.status = 'fallback') AS fallbacks
    FROM steps s WHERE s.w = 'cur' AND s.status <> 'skipped'
),
use_cases AS (
  SELECT x.use_case, sum(x.rows) AS rows, count(*) AS calls
    FROM secs x WHERE x.w = 'cur' AND x.use_case IS NOT NULL GROUP BY x.use_case
),
operations AS (
  SELECT x.http_method AS method, x.endpoint AS path, x.backend,
         count(*) AS calls, sum(x.rows) AS rows
    FROM secs x WHERE x.w = 'cur' AND x.endpoint IS NOT NULL
   GROUP BY x.http_method, x.endpoint, x.backend
),
kb_recs AS (SELECT g.kb FROM tagged g WHERE g.w = 'cur' AND g.kb IS NOT NULL),
kb_tot AS (
  SELECT count(*) AS answers,
         avg(CASE WHEN jsonb_typeof(kb->'matched')   = 'number' THEN (kb->>'matched')::double precision   END) AS avg_matched,
         avg(CASE WHEN jsonb_typeof(kb->'citations') = 'number' THEN (kb->>'citations')::double precision END) AS avg_citations
    FROM kb_recs
),
kb_stores AS (
  SELECT NULLIF(kb->>'retrieval', '') AS store, count(*) AS n
    FROM kb_recs WHERE NULLIF(kb->>'retrieval', '') IS NOT NULL GROUP BY 1
),
export_formats AS (
  SELECT g.export_format AS format, count(*) AS n
    FROM tagged g WHERE g.w = 'cur' AND g.export_format IS NOT NULL GROUP BY g.export_format
),
uploads AS (SELECT count(*) AS n FROM tagged g WHERE g.w = 'cur' AND g.had_file),
row_base AS (
  SELECT g.request_id, g.occurred_at, g.user_name, g.question, g.ok, g.http_status, g.latency_ms,
         g.report_type, g.rows_returned, g.error, g.error_kind,
         (SELECT count(*) FROM jsonb_array_elements(COALESCE(g.trace, '[]'::jsonb)) e2
           WHERE e2->>'status' = 'ran') AS steps,
         (SELECT count(*) FROM jsonb_array_elements(COALESCE(g.trace, '[]'::jsonb)) e3
           WHERE e3->>'engine' = 'llm' AND e3->>'status' = 'ran') AS llm_steps,
         COALESCE(NULLIF(jsonb_array_length(COALESCE(g.usage, '[]'::jsonb)), 0),
           (SELECT count(*) FROM jsonb_array_elements(COALESCE(g.trace, '[]'::jsonb)) e4
             WHERE e4->>'engine' = 'llm' AND e4->>'status' = 'ran')) AS model_calls,
         (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e5->'inputTokens') = 'number' THEN (e5->>'inputTokens')::bigint ELSE 0 END), 0)
            FROM jsonb_array_elements(COALESCE(g.usage, '[]'::jsonb)) e5) AS input_tokens,
         (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e6->'outputTokens') = 'number' THEN (e6->>'outputTokens')::bigint ELSE 0 END), 0)
            FROM jsonb_array_elements(COALESCE(g.usage, '[]'::jsonb)) e6) AS output_tokens,
         (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e7->'totalTokens') = 'number' THEN (e7->>'totalTokens')::bigint ELSE 0 END), 0)
            FROM jsonb_array_elements(COALESCE(g.usage, '[]'::jsonb)) e7) AS total_tokens,
         (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e8->'costUsd') = 'number' THEN (e8->>'costUsd')::double precision ELSE 0 END), 0)
            FROM jsonb_array_elements(COALESCE(g.usage, '[]'::jsonb)) e8) AS cost_usd,
         (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e9->'costUsd') IS DISTINCT FROM 'number' AND jsonb_typeof(e9->'totalTokens') = 'number' THEN (e9->>'totalTokens')::bigint ELSE 0 END), 0)
            FROM jsonb_array_elements(COALESCE(g.usage, '[]'::jsonb)) e9) AS unpriced_tokens
    FROM tagged g WHERE g.w = 'cur'
),
row_json AS (
  SELECT rb.*, jsonb_build_object(
           'id', 'srv-' || rb.request_id,
           'ts', (extract(epoch FROM rb.occurred_at) * 1000)::bigint,
           'userName', rb.user_name, 'question', rb.question, 'ok', rb.ok,
           'httpStatus', rb.http_status, 'latencyMs', rb.latency_ms, 'type', rb.report_type,
           'rows', rb.rows_returned, 'error', rb.error, 'errorKind', rb.error_kind,
           'steps', rb.steps, 'llmSteps', rb.llm_steps, 'modelCalls', rb.model_calls,
           'inputTokens', rb.input_tokens, 'outputTokens', rb.output_tokens,
           'totalTokens', rb.total_tokens, 'costUsd', rb.cost_usd,
           'unpricedTokens', rb.unpriced_tokens) AS j
    FROM row_base rb
)
SELECT jsonb_build_object(
  'window', jsonb_build_object(
    'from', (SELECT (extract(epoch FROM f) * 1000)::bigint FROM p),
    'to',   (SELECT (extract(epoch FROM t) * 1000)::bigint FROM p),
    'prevFrom', (SELECT (extract(epoch FROM pf) * 1000)::bigint FROM p),
    'prevTo',   (SELECT (extract(epoch FROM pt) * 1000)::bigint FROM p),
    'buckets',  (SELECT nb FROM p)),
  'totals', (SELECT to_jsonb(x) FROM (
      SELECT COALESCE(t.requests, 0) AS "requests", COALESCE(t.succeeded, 0) AS "succeeded",
             COALESCE(t.failed, 0) AS "failed", t.median_ms AS "medianMs", t.p95_ms AS "p95Ms",
             COALESCE(ut.calls, 0) + COALESCE(st.legacy_model_invocations, 0) AS "modelInvocations",
             COALESCE(st.fallbacks, 0) AS "fallbacks",
             COALESCE(t.rows_returned, 0) AS "rowsReturned", COALESCE(t.orchestrated, 0) AS "orchestrated",
             COALESCE(ut.input_tokens, 0) AS "inputTokens", COALESCE(ut.output_tokens, 0) AS "outputTokens",
             COALESCE(ut.total_tokens, 0) AS "totalTokens", COALESCE(ut.cost_usd, 0) AS "costUsd",
             COALESCE(ut.unpriced_tokens, 0) AS "unpricedTokens"
        FROM (SELECT 1) _
        LEFT JOIN tot t ON t.w = 'cur' LEFT JOIN step_tot st ON st.w = 'cur'
        LEFT JOIN usage_tot ut ON ut.w = 'cur') x),
  'prev', (SELECT to_jsonb(x) FROM (
      SELECT t.requests AS "requests", t.succeeded AS "succeeded", t.failed AS "failed",
             t.median_ms AS "medianMs", t.p95_ms AS "p95Ms",
             COALESCE(ut.calls, 0) + COALESCE(st.legacy_model_invocations, 0) AS "modelInvocations",
             COALESCE(st.fallbacks, 0) AS "fallbacks",
             t.rows_returned AS "rowsReturned", t.orchestrated AS "orchestrated",
             COALESCE(ut.input_tokens, 0) AS "inputTokens", COALESCE(ut.output_tokens, 0) AS "outputTokens",
             COALESCE(ut.total_tokens, 0) AS "totalTokens", COALESCE(ut.cost_usd, 0) AS "costUsd",
             COALESCE(ut.unpriced_tokens, 0) AS "unpricedTokens"
        FROM tot t LEFT JOIN step_tot st ON st.w = t.w LEFT JOIN usage_tot ut ON ut.w = t.w WHERE t.w = 'prv') x),
  'series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      't', s.t_ms::bigint, 'total', s.total, 'ok', s.ok, 'failed', s.failed,
      'medianMs', s.median_ms, 'p95Ms', s.p95_ms, 'rowsReturned', s.rows_returned,
      'modelInvocations', s.model_invocations,
      'inputTokens', s.input_tokens, 'outputTokens', s.output_tokens, 'totalTokens', s.total_tokens,
      'costUsd', s.cost_usd, 'unpricedTokens', s.unpriced_tokens,
      'successRate', CASE WHEN s.total > 0 THEN (s.ok::double precision / s.total) * 100 END
    ) ORDER BY s.idx) FROM series s), '[]'::jsonb),
  'routing', COALESCE((SELECT jsonb_agg(jsonb_build_object('type', type, 'n', n) ORDER BY n DESC, type) FROM routing), '[]'::jsonb),
  'engines', COALESCE((SELECT jsonb_agg(jsonb_build_object('engine', engine, 'steps', steps) ORDER BY steps DESC) FROM engines), '[]'::jsonb),
  'stepsExecuted', (SELECT executed FROM step_exec),
  'stages',  COALESCE((SELECT jsonb_agg(jsonb_build_object('stage', stage, 'avgMs', avg_ms, 'steps', steps) ORDER BY avg_ms DESC NULLS LAST) FROM stages), '[]'::jsonb),
  'models',  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'model', model, 'steps', steps, 'calls', calls, 'avgConfidence', avg_confidence, 'medianMs', median_ms,
      'inputTokens', input_tokens, 'outputTokens', output_tokens, 'totalTokens', total_tokens,
      'costUsd', cost_usd, 'unpricedTokens', unpriced_tokens
    ) ORDER BY total_tokens DESC, calls DESC) FROM models), '[]'::jsonb),
  'useCases',COALESCE((SELECT jsonb_agg(jsonb_build_object('useCase', use_case, 'rows', rows, 'calls', calls) ORDER BY rows DESC, use_case) FROM use_cases), '[]'::jsonb),
  'operations', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', method, 'path', path, 'backend', backend, 'calls', calls, 'rows', rows) ORDER BY calls DESC, rows DESC, path) FROM operations), '[]'::jsonb),
  'kb', jsonb_build_object(
     'answers', (SELECT answers FROM kb_tot),
     'avgMatched', (SELECT avg_matched FROM kb_tot),
     'avgCitations', (SELECT avg_citations FROM kb_tot),
     'stores', COALESCE((SELECT jsonb_agg(jsonb_build_object('store', store, 'n', n) ORDER BY n DESC) FROM kb_stores), '[]'::jsonb)),
  'exports', jsonb_build_object(
     'formats', COALESCE((SELECT jsonb_agg(jsonb_build_object('format', format, 'n', n) ORDER BY n DESC) FROM export_formats), '[]'::jsonb),
     'uploads', (SELECT n FROM uploads)),
  'failures', COALESCE((SELECT jsonb_agg(j ORDER BY occurred_at DESC)
                          FROM (SELECT * FROM row_json WHERE NOT ok ORDER BY occurred_at DESC LIMIT ${FAILURE_ROWS}) q), '[]'::jsonb),
  'activity', COALESCE((SELECT jsonb_agg(j ORDER BY occurred_at DESC)
                          FROM (SELECT * FROM row_json ORDER BY occurred_at DESC LIMIT ${ACTIVITY_ROWS}) q), '[]'::jsonb)
) AS payload
`;

/**
 * Aggregate the request log over [from, to), plus the immediately preceding window of equal length
 * when one is given. Returns null when there is no database.
 */
export async function aggregateRequestLog(opts: {
  from: Date;
  to: Date;
  prevFrom: Date | null;
  prevTo: Date | null;
  buckets: number;
  userRef?: string;
}): Promise<MetricsPayload | null> {
  if (!hasDatabase()) return null;
  const rows = await query<{ payload: MetricsPayload }>(SQL, [
    opts.from.toISOString(),
    opts.to.toISOString(),
    opts.prevFrom ? opts.prevFrom.toISOString() : null,
    opts.prevTo ? opts.prevTo.toISOString() : null,
    opts.buckets,
    opts.userRef ?? null,
  ]);
  return rows[0]?.payload ?? null;
}
