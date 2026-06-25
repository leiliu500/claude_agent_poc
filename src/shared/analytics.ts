/**
 * Pure analytics over dispatch results. No I/O — used by the analytics Flow Lambda and
 * by local orchestration mode.
 */
import type {
  AnalyticsMetric,
  AnalyticsResult,
  DispatchResult,
  NumericSummary,
} from "./types.js";

function isNumeric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function summariseNumeric(values: number[]): NumericSummary {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    sum: round(sum),
    avg: round(sum / values.length),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    count: values.length,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function analyseRows(rows: Record<string, unknown>[]): {
  numericSummary: Record<string, NumericSummary>;
  categoricalSummary: Record<string, Record<string, number>>;
} {
  const numericCols: Record<string, number[]> = {};
  const catCols: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (isNumeric(v)) {
        (numericCols[k] ??= []).push(v);
      } else if (typeof v === "string" || typeof v === "boolean") {
        const bucket = (catCols[k] ??= {});
        const key = String(v);
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
    }
  }

  const numericSummary: Record<string, NumericSummary> = {};
  for (const [col, vals] of Object.entries(numericCols)) {
    if (vals.length) numericSummary[col] = summariseNumeric(vals);
  }
  // Only keep low-cardinality categoricals (distributions, not free text).
  const categoricalSummary: Record<string, Record<string, number>> = {};
  for (const [col, dist] of Object.entries(catCols)) {
    if (Object.keys(dist).length <= 12) categoricalSummary[col] = dist;
  }
  return { numericSummary, categoricalSummary };
}

function highlightsFor(result: DispatchResult, metric: Omit<AnalyticsMetric, "highlights">): string[] {
  const out: string[] = [`${result.data.length} record(s) returned for ${result.useCase}.`];
  // Surface the largest numeric rollup as a highlight.
  const entries = Object.entries(metric.numericSummary);
  if (entries.length) {
    const [col, s] = entries.sort((a, b) => b[1].sum - a[1].sum)[0]!;
    out.push(`${col}: total ${s.sum}, avg ${s.avg} across ${s.count} rows.`);
  }
  // Surface dominant category.
  for (const [col, dist] of Object.entries(metric.categoricalSummary)) {
    const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0];
    if (top && Object.keys(dist).length > 1) {
      out.push(`Most common ${col}: '${top[0]}' (${top[1]}).`);
      break;
    }
  }
  return out;
}

export function runAnalytics(results: DispatchResult[]): AnalyticsResult {
  const metrics: Record<string, AnalyticsMetric> = {};
  let totalRows = 0;
  let okTasks = 0;
  let erroredTasks = 0;
  const notes: string[] = [];

  for (const r of results) {
    const key = `${r.type}:${r.useCase}`;
    if (r.status === "error") {
      erroredTasks++;
      notes.push(`${key} failed: ${r.error ?? "unknown error"}`);
      metrics[key] = { rowCount: 0, numericSummary: {}, categoricalSummary: {}, highlights: [`Task failed: ${r.error}`] };
      continue;
    }
    okTasks++;
    totalRows += r.data.length;
    const { numericSummary, categoricalSummary } = analyseRows(r.data);
    const partial = { rowCount: r.data.length, numericSummary, categoricalSummary };
    metrics[key] = { ...partial, highlights: highlightsFor(r, partial) };
  }

  if (results.length > 1) {
    notes.push(`Orchestrated ${results.length} tasks; combined ${totalRows} rows.`);
  }

  return {
    metrics,
    aggregate: { totalRows, totalTasks: results.length, okTasks, erroredTasks, notes },
  };
}
