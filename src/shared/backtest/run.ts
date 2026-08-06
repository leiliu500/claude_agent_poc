/**
 * Fedline backtest runner.
 *
 * Replays every Fedline operation through the REAL dispatch path (`executeTask` — the same code the
 * action-group Lambdas and the local orchestration mode call) and validates the response table data.
 *
 * Two modes:
 *   - `data` (default): deterministic only. No model calls, so it finishes in milliseconds and is
 *     safe to run synchronously behind the HTTP deadline. Covers every table/integrity/param check.
 *   - `full`: additionally asks the agent layer which operation each question routes to (false
 *     positive / false negative of selection) and runs the post-dispatch agents to check that their
 *     figures are grounded in the rows. Issues model calls; proportionally slower.
 *
 * `full` degrades honestly: when the router or the post-dispatch agents are unavailable (no model
 * configured, GATEWAY_MOCK on, registry unreachable) the affected checks report `skip`, never `pass`.
 */
import type { DispatchResult, TaskRequest } from "../types.js";
import { executeTask } from "../dispatch.js";
import { runAnalytics } from "../analytics.js";
import { llmRoute } from "../llm-router.js";
import { route } from "../router.js";
import { runPostDispatch } from "../postdispatch/pipeline.js";
import { builtinBackends, seedBuiltinBackends } from "../gateway/seed.js";
import { getUseCase } from "../usecases.js";
import { createLogger } from "../logger.js";
import { FEDLINE_CASES, coverageGaps, type BacktestCase } from "./cases.js";
import { exercisableCount, registryCases, type RegistryCase } from "./registry-cases.js";
import { validateGrounding, validateRouting, validateTableData } from "./validators.js";
import type { BacktestMode, BacktestSummary, BacktestTotals, CaseResult, CheckResult } from "./types.js";

const log = createLogger({ mod: "backtest" });

export interface RunBacktestOptions {
  mode?: BacktestMode;
  /** Restrict the run to these caseIds (UI "re-run this case"); empty/absent ⇒ every case. */
  caseIds?: string[];
  /**
   * Which registered application to validate. Defaults to Fedline, the only one with an authored
   * suite; any other registered id runs the registry-derived sweep (see registry-cases.ts).
   */
  backendId?: string;
}

/** Which operation would the system actually run for this question? undefined ⇒ nothing selected. */
async function selectedOperationFor(question: string): Promise<string | undefined> {
  try {
    // Mirror the orchestrator exactly: the LLM router drives, the deterministic router is the net.
    const decision = (await llmRoute(question)) ?? route(question);
    return decision.tasks[0]?.useCase;
  } catch (err) {
    log.warn("routing check failed", { error: String(err) });
    return undefined;
  }
}

/**
 * Grounding resolves the target backend's post-dispatch policy from the registry. In a host that
 * has no database (the entrypoint Lambda), the registry is an in-process map that is only populated
 * by an EXPLICIT seed — so without this every grounding check reported `skip` and the post-dispatch
 * agents were never exercised. Seeding is idempotent and upserts, so it is safe to call per run.
 */
async function ensureRegistrySeeded(): Promise<void> {
  try {
    await seedBuiltinBackends();
  } catch (err) {
    // Non-fatal: grounding then reports `skip` (never `pass`), which is the honest outcome.
    log.warn("could not seed the backend registry for grounding", { error: String(err) });
  }
}

/** Grounding needs LLM-authored text; absent post-dispatch output ⇒ the check is skipped, not passed. */
async function groundingChecks(kase: BacktestCase, result: DispatchResult): Promise<CheckResult[]> {
  const analytics = runAnalytics([result]);
  let out;
  try {
    out = await runPostDispatch({ question: kase.question, results: [result], analytics });
  } catch (err) {
    log.warn("post-dispatch failed during backtest", { caseId: kase.caseId, error: String(err) });
    out = undefined;
  }
  if (!out) {
    return validateGrounding([], result.data, result.meta); // yields a single explicit skip
  }
  return validateGrounding(
    [
      { label: "analytics", text: out.insights.join("\n") },
      { label: "report", text: out.summary ?? "" },
    ],
    result.data,
    result.meta,
  );
}

async function runCase(kase: BacktestCase, mode: BacktestMode): Promise<CaseResult> {
  const spec = getUseCase(kase.operationId);
  const started = performance.now();
  const base = {
    caseId: kase.caseId,
    operationId: kase.operationId as string,
    label: spec?.label ?? kase.operationId,
    question: kase.question,
  };

  try {
    const task: TaskRequest = { type: kase.type, useCase: kase.operationId, params: { ...kase.params } };
    const result = await executeTask(task);

    const checks: CheckResult[] = validateTableData(kase, result);
    if (mode === "full") {
      checks.push(...validateRouting(kase, await selectedOperationFor(kase.question)));
      checks.push(...(await groundingChecks(kase, result)));
    }

    const failed = checks.some((c) => c.status === "fail");
    return {
      ...base,
      status: failed ? "fail" : "pass",
      rowCount: result.data?.length ?? 0,
      columns: result.data?.length ? Object.keys(result.data[0] ?? {}) : [],
      latencyMs: Math.round(performance.now() - started),
      checks,
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      rowCount: 0,
      columns: [],
      latencyMs: Math.round(performance.now() - started),
      checks: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function tally(cases: CaseResult[]): BacktestTotals {
  const totals: BacktestTotals = {
    cases: cases.length,
    passed: 0, failed: 0, errored: 0, skipped: 0,
    checks: 0, checksPassed: 0, checksFailed: 0, checksSkipped: 0,
    falsePositives: 0, falseNegatives: 0, hallucinations: 0, dataIntegrity: 0,
  };
  for (const c of cases) {
    if (c.status === "pass") totals.passed++;
    else if (c.status === "fail") totals.failed++;
    else if (c.status === "skip") totals.skipped++;
    else totals.errored++;

    for (const check of c.checks) {
      totals.checks++;
      if (check.status === "pass") totals.checksPassed++;
      else if (check.status === "skip") totals.checksSkipped++;
      else {
        totals.checksFailed++;
        if (check.failureKind === "false_positive") totals.falsePositives++;
        else if (check.failureKind === "false_negative") totals.falseNegatives++;
        else if (check.failureKind === "hallucination") totals.hallucinations++;
        else if (check.failureKind === "data_integrity") totals.dataIntegrity++;
      }
    }
  }
  return totals;
}

/**
 * A coverage hole is reported as its own failing case rather than a silent omission — otherwise a
 * newly-registered Fedline operation with no case would make the suite look greener than it is.
 */
function coverageCase(): CaseResult | undefined {
  const { missing, unknown } = coverageGaps();
  if (!missing.length && !unknown.length) return undefined;
  const checks: CheckResult[] = [];
  if (missing.length) {
    checks.push({
      id: "coverage.missing", category: "dispatch", status: "fail", failureKind: "false_negative",
      detail: `Fedline operation(s) registered but never exercised by a backtest case: ${missing.join(", ")}.`,
      expected: [], actual: missing,
    });
  }
  if (unknown.length) {
    checks.push({
      id: "coverage.unknown", category: "dispatch", status: "fail", failureKind: "data_integrity",
      detail: `Backtest case(s) name an operation Fedline does not register: ${unknown.join(", ")}.`,
      expected: [], actual: unknown,
    });
  }
  return {
    caseId: "coverage", operationId: "—", label: "Operation coverage", question: "—",
    status: "fail", rowCount: 0, columns: [], latencyMs: 0, checks,
  };
}

/** The default (and only authored) application. Any other id runs the registry-derived sweep. */
export const AUTHORED_BACKEND_ID = "fedline";

/**
 * Replay one registry-derived case. Only safe, parameterless operations reach here — everything
 * else was already marked skipped by `registryCases`, with its reason.
 *
 * The checks are deliberately few: a registration document justifies "the call succeeded and
 * returned a table with consistent columns", and nothing more. Inventing column or rollup
 * expectations for an application nobody authored a suite for would manufacture green ticks.
 */
async function runRegistryCase(rc: RegistryCase, backendId: string): Promise<CaseResult> {
  const started = performance.now();
  if (rc.skipReason) {
    return {
      caseId: rc.caseId, operationId: rc.operationId, label: rc.label, question: "—",
      status: "skip", rowCount: 0, columns: [], latencyMs: 0, checks: [], skipReason: rc.skipReason,
    };
  }

  try {
    const result = await executeTask({ useCase: rc.operationId, params: {} } as TaskRequest);
    const rows: Record<string, unknown>[] = Array.isArray(result?.data) ? result.data : [];
    const firstRow = rows[0];
    const columns = firstRow ? Object.keys(firstRow) : [];
    const checks: CheckResult[] = [];

    checks.push({
      id: "dispatch.ok",
      category: "dispatch",
      status: result?.status === "ok" ? "pass" : "fail",
      failureKind: result?.status === "ok" ? undefined : "false_negative",
      detail: result?.status === "ok"
        ? `${rc.method} ${rc.path} returned status 'ok'.`
        : `${rc.method} ${rc.path} returned status '${String(result?.status)}'.`,
      expected: ["ok"], actual: [String(result?.status)],
    });

    // Column consistency is the one table property a spec-less sweep can honestly assert: whatever
    // the columns are, every row must carry the same ones.
    const ragged = rows.filter((r: Record<string, unknown>) => {
      const keys = Object.keys(r);
      return keys.length !== columns.length || keys.some((k) => !columns.includes(k));
    });
    const firstRagged = ragged[0];
    checks.push({
      id: "rows.uniformColumns",
      category: "schema",
      status: rows.length ? (ragged.length ? "fail" : "pass") : "skip",
      failureKind: ragged.length ? "data_integrity" : undefined,
      detail: rows.length
        ? (ragged.length
            ? `${ragged.length} row(s) do not carry the same columns as the first row.`
            : `All ${rows.length} row(s) carry the same ${columns.length} column(s).`)
        : "No rows returned, so there is nothing to check for column consistency.",
      expected: columns, actual: firstRagged ? Object.keys(firstRagged) : columns,
    });

    const failed = checks.some((c) => c.status === "fail");
    return {
      caseId: rc.caseId, operationId: rc.operationId, label: rc.label,
      question: "—",
      status: failed ? "fail" : "pass",
      rowCount: rows.length, columns,
      latencyMs: Math.round(performance.now() - started),
      checks,
    };
  } catch (err) {
    log.warn("registry case failed", { backendId, operationId: rc.operationId, error: String(err) });
    return {
      caseId: rc.caseId, operationId: rc.operationId, label: rc.label, question: "—",
      status: "error", rowCount: 0, columns: [], latencyMs: Math.round(performance.now() - started),
      checks: [], error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Validate an application that has no authored suite, from its registered operations alone. */
async function runRegistrySweep(backendId: string, mode: BacktestMode, startedAt: string, t0: number): Promise<BacktestSummary> {
  const backend = builtinBackends().find((b) => b.backendId === backendId);
  if (!backend) {
    throw new Error(
      `Unknown application '${backendId}'. Validation replays through the in-process dispatch path, ` +
      `so it can only exercise applications this deployment has registered.`,
    );
  }
  const derived = registryCases(backend);
  log.info("registry sweep started", { backendId, operations: derived.length, exercisable: exercisableCount(derived) });
  const cases = await Promise.all(derived.map((rc) => runRegistryCase(rc, backendId)));
  return {
    backendId,
    backendName: backend.name ?? backendId,
    suite: "registry",
    mode,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    totals: tally(cases),
    cases,
  };
}

/** Run the response-validation sweep for one application and return a JSON-serialisable summary. */
export async function runBacktest(options: RunBacktestOptions = {}): Promise<BacktestSummary> {
  const mode: BacktestMode = options.mode === "full" ? "full" : "data";
  const backendId = options.backendId?.trim() || AUTHORED_BACKEND_ID;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  // The registry sweep needs the in-process registry populated in either mode — unlike the authored
  // suite, its operation list IS the registry.
  if (backendId !== AUTHORED_BACKEND_ID) {
    await ensureRegistrySeeded();
    return runRegistrySweep(backendId, mode, startedAt, t0);
  }

  const wanted = options.caseIds?.length ? new Set(options.caseIds) : undefined;
  const selected = FEDLINE_CASES.filter((c) => !wanted || wanted.has(c.caseId));

  log.info("backtest started", { backendId, mode, cases: selected.length });

  // Only `full` needs the registry (for the grounding check's policy lookup); `data` stays hermetic.
  if (mode === "full") await ensureRegistrySeeded();

  // Cases are independent; `data` mode is pure CPU and `full` mode benefits from overlapping the
  // model calls, so run them concurrently either way.
  const cases = await Promise.all(selected.map((c) => runCase(c, mode)));

  // Coverage is only meaningful for a full sweep — a filtered re-run legitimately skips operations.
  const coverage = wanted ? undefined : coverageCase();
  if (coverage) cases.push(coverage);

  const summary: BacktestSummary = {
    backendId: AUTHORED_BACKEND_ID,
    backendName: "Fedline",
    suite: "authored",
    mode,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    totals: tally(cases),
    cases,
  };
  log.info("backtest completed", {
    backendId,
    mode,
    cases: summary.totals.cases,
    failed: summary.totals.failed,
    falsePositives: summary.totals.falsePositives,
    falseNegatives: summary.totals.falseNegatives,
    hallucinations: summary.totals.hallucinations,
    dataIntegrity: summary.totals.dataIntegrity,
  });
  return summary;
}
