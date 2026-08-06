/**
 * Fedline backtest — result contracts.
 *
 * The backtest replays every Fedline operation through the real dispatch path and asserts a battery
 * of checks over the RESPONSE TABLE DATA. Each check is classified so the UI can report the three
 * failure modes the system actually cares about:
 *
 *   - `false_negative`  — the operation should have returned data and did not (empty table, error,
 *                         router failed to select an operation that clearly exists).
 *   - `false_positive`  — data came back, but it answers a DIFFERENT question than was asked
 *                         (wrong operation selected, params not honoured, rows outside the range).
 *   - `hallucination`   — an LLM-authored figure in the analytics insights / report summary is not
 *                         traceable to the returned rows or the deterministic rollups.
 *   - `data_integrity`  — the table contradicts itself (ragged columns, rollup ≠ sum of rows,
 *                         count ≠ row count, NaN in a numeric column).
 *
 * Everything here is JSON-serialisable: the whole summary crosses the wire to the UI verbatim.
 */

/** Which family of assertion a check belongs to (drives grouping in the UI). */
export type CheckCategory = "dispatch" | "schema" | "integrity" | "params" | "routing" | "grounding";

/** How a failed check should be counted in the totals. */
export type FailureKind = "false_negative" | "false_positive" | "hallucination" | "data_integrity";

/**
 * A check is `skipped` when its precondition is absent (e.g. grounding needs the post-dispatch agents,
 * which are off under GATEWAY_MOCK). Skipped is NOT a pass — it is reported separately so an
 * unexercised check can never be mistaken for a green one.
 */
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  /** Stable id, e.g. "integrity.rollup.totalDepositAmount" — safe to use as a UI key. */
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  /** Always populated: what was asserted, and on failure what was actually seen. */
  detail: string;
  /** Present only when status === "fail". */
  failureKind?: FailureKind;
  expected?: unknown;
  actual?: unknown;
}

export interface CaseResult {
  caseId: string;
  operationId: string;
  /** Human label from the use-case registry. */
  label: string;
  /** The natural-language question used for the routing check. */
  question: string;
  /**
   * "skip" means the case was NOT exercised — never a pass. It is used when an operation cannot be
   * validated safely or meaningfully (e.g. a non-GET operation the sweep must not fire, or one whose
   * required parameters have no authored values), and `skipReason` always says which.
   */
  status: "pass" | "fail" | "error" | "skip";
  rowCount: number;
  columns: string[];
  latencyMs: number;
  checks: CheckResult[];
  /** Set when the case threw before any check could run. */
  error?: string;
  /** Why the case was not exercised. Present exactly when status === "skip". */
  skipReason?: string;
}

/**
 * `data` replays the deterministic dispatch layer only — fast, no model calls, safe inside the
 * synchronous HTTP deadline. `full` adds the LLM routing check and the post-dispatch grounding
 * check, so it issues model calls and takes proportionally longer.
 */
export type BacktestMode = "data" | "full";

export interface BacktestTotals {
  cases: number;
  passed: number;
  failed: number;
  errored: number;
  /** Cases that were not exercised at all. Counted separately so they can never read as passes. */
  skipped: number;
  checks: number;
  checksPassed: number;
  checksFailed: number;
  checksSkipped: number;
  falsePositives: number;
  falseNegatives: number;
  hallucinations: number;
  dataIntegrity: number;
}

export interface BacktestSummary {
  backendId: string;
  /** Human name of the application, for the UI heading. */
  backendName?: string;
  /**
   * How the cases were obtained:
   *   · "authored" — a hand-written suite with realistic params and table expectations (Fedline);
   *   · "registry" — derived from the application's registered operations, so only the structural
   *     checks the spec can justify are possible. The UI must say which, because an all-green
   *     registry sweep proves far less than an all-green authored one.
   */
  suite?: "authored" | "registry";
  mode: BacktestMode;
  startedAt: string;
  durationMs: number;
  totals: BacktestTotals;
  cases: CaseResult[];
}
