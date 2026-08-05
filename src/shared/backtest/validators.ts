/**
 * Backtest validators — the assertions that turn a DispatchResult into classified findings.
 *
 * Split into three groups by what they can prove:
 *
 *   `validateTableData`  — pure, deterministic, no model calls. Everything provable from the rows,
 *                          the meta envelope and the request params.
 *   `validateRouting`    — did the agent layer select the operation the question asked for?
 *   `validateGrounding`  — is every figure in the LLM-authored text traceable to the data?
 *
 * Design rule: a check never passes by accident. When a precondition is missing (no rollup key in
 * meta, no agent text to check) the check is `skip`, never `pass` — see CheckStatus in ./types.
 */
import type { DispatchResult, TaskParams } from "../types.js";
import type { BacktestCase } from "./cases.js";
import type { CheckResult } from "./types.js";

/** Numbers are compared with a small relative tolerance so float summation noise is not a finding. */
const EPSILON = 1e-6;

function pass(id: string, category: CheckResult["category"], detail: string): CheckResult {
  return { id, category, status: "pass", detail };
}

function fail(
  id: string,
  category: CheckResult["category"],
  failureKind: NonNullable<CheckResult["failureKind"]>,
  detail: string,
  expected?: unknown,
  actual?: unknown,
): CheckResult {
  return { id, category, status: "fail", failureKind, detail, expected, actual };
}

function skip(id: string, category: CheckResult["category"], detail: string): CheckResult {
  return { id, category, status: "skip", detail };
}

function nearlyEqual(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Sum a column across rows, ignoring rows where it is absent/non-numeric. */
function sumColumn(rows: Record<string, unknown>[], column: string): number {
  let total = 0;
  for (const row of rows) {
    const v = Number(row[column]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/** The leading `yyyy-MM-dd` of a date-ish cell, or undefined when it is not a date at all. */
function isoDay(value: unknown): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ""));
  return m?.[1];
}

// ── Group 1: deterministic table-data validation ─────────────────────────────

/**
 * Everything provable about the response table without a model. Returns one CheckResult per
 * assertion, in a stable order so the UI rows do not reshuffle between runs.
 */
export function validateTableData(kase: BacktestCase, result: DispatchResult): CheckResult[] {
  const checks: CheckResult[] = [];
  const rows = result.data ?? [];
  const meta = result.meta ?? {};
  const minRows = kase.minRows ?? 1;

  // 1. Did the call succeed at all? A hard error means the operation returned nothing for a request
  //    that should have produced rows — a false negative, not merely a crash.
  if (result.status !== "ok" || result.error) {
    checks.push(
      fail("dispatch.ok", "dispatch", "false_negative",
        `Dispatch failed: ${result.error ?? "status was not 'ok'"}`, "ok", result.status),
    );
    return checks; // nothing downstream is meaningful
  }
  checks.push(pass("dispatch.ok", "dispatch", "Dispatch returned status 'ok'."));

  // 2. Non-empty table. An operation that should return rows and returns none is a false negative.
  if (rows.length < minRows) {
    checks.push(
      fail("rows.nonEmpty", "dispatch", "false_negative",
        `Expected at least ${minRows} row(s), got ${rows.length}.`, `>= ${minRows}`, rows.length),
    );
  } else {
    checks.push(pass("rows.nonEmpty", "dispatch", `Returned ${rows.length} row(s) (min ${minRows}).`));
  }

  // 3. Required columns present on every row.
  if (rows.length > 0) {
    const missingByColumn = kase.requiredColumns.filter((col) => rows.some((r) => !(col in r)));
    if (missingByColumn.length) {
      checks.push(
        fail("schema.requiredColumns", "schema", "data_integrity",
          `Column(s) missing from at least one row: ${missingByColumn.join(", ")}.`,
          kase.requiredColumns, Object.keys(rows[0] ?? {})),
      );
    } else {
      checks.push(
        pass("schema.requiredColumns", "schema",
          `All ${kase.requiredColumns.length} required column(s) present on every row.`),
      );
    }

    // 4. Uniform shape — ragged rows break the table render and every downstream aggregate.
    const firstKeys = Object.keys(rows[0] ?? {}).sort().join("|");
    const ragged = rows.findIndex((r) => Object.keys(r).sort().join("|") !== firstKeys);
    if (ragged > 0) {
      checks.push(
        fail("schema.uniform", "schema", "data_integrity",
          `Row ${ragged} has a different column set than row 0.`,
          Object.keys(rows[0] ?? {}), Object.keys(rows[ragged] ?? {})),
      );
    } else {
      checks.push(pass("schema.uniform", "schema", "Every row carries an identical column set."));
    }

    // 5. Required columns are actually populated. `null` is treated as a hole only for columns the
    //    case declares required — optional/always-null fields (e.g. denominationFound) are not listed.
    const blank = kase.requiredColumns.filter((col) =>
      rows.some((r) => r[col] === undefined || r[col] === null || r[col] === ""),
    );
    if (blank.length) {
      checks.push(
        fail("schema.populated", "schema", "data_integrity",
          `Required column(s) blank/null in at least one row: ${blank.join(", ")}.`, "non-empty", blank),
      );
    } else {
      checks.push(pass("schema.populated", "schema", "No required column is blank or null."));
    }

    // 6. Numeric columns hold finite numbers — NaN/Infinity poison every rollup built on them.
    const numericCols = kase.numericColumns ?? [];
    if (numericCols.length) {
      const bad = numericCols.filter((col) =>
        rows.some((r) => col in r && !Number.isFinite(Number(r[col]))),
      );
      if (bad.length) {
        checks.push(
          fail("schema.numericFinite", "schema", "data_integrity",
            `Non-finite value in numeric column(s): ${bad.join(", ")}.`, "finite numbers", bad),
        );
      } else {
        checks.push(
          pass("schema.numericFinite", "schema",
            `All ${numericCols.length} numeric column(s) hold finite values.`),
        );
      }
    }
  }

  // 7. Rollup reconciliation — the backend's claimed aggregate vs the aggregate recomputed from the
  //    rows it returned. This is the check that catches a headline figure disagreeing with its table.
  for (const rollup of kase.rollups ?? []) {
    const id = `integrity.rollup.${rollup.metaKey}`;
    const claimed = Number(meta[rollup.metaKey]);
    if (!Number.isFinite(claimed)) {
      checks.push(skip(id, "integrity", `meta.${rollup.metaKey} absent or non-numeric; nothing to reconcile.`));
      continue;
    }
    const recomputed = rollup.op === "sum" ? sumColumn(rows, rollup.column) : rows.length;
    if (!nearlyEqual(claimed, recomputed)) {
      checks.push(
        fail(id, "integrity", "data_integrity",
          `meta.${rollup.metaKey} (${claimed}) does not equal ${rollup.op} of '${rollup.column}' over the returned rows (${recomputed}).`,
          recomputed, claimed),
      );
    } else {
      checks.push(
        pass(id, "integrity", `meta.${rollup.metaKey} reconciles with ${rollup.op}('${rollup.column}') = ${recomputed}.`),
      );
    }
  }

  // 8. Claimed counts vs actual row count.
  for (const key of kase.countKeys ?? []) {
    const id = `integrity.count.${key}`;
    const claimed = Number(meta[key]);
    if (!Number.isFinite(claimed)) {
      checks.push(skip(id, "integrity", `meta.${key} absent or non-numeric; nothing to reconcile.`));
      continue;
    }
    if (claimed !== rows.length) {
      checks.push(
        fail(id, "integrity", "data_integrity",
          `meta.${key} claims ${claimed} row(s) but ${rows.length} were returned.`, rows.length, claimed),
      );
    } else {
      checks.push(pass(id, "integrity", `meta.${key} matches the returned row count (${rows.length}).`));
    }
  }

  // 9. Params echoed back. A response that quietly answers a different query than the one asked is
  //    the definition of a false positive: rows arrive, they look fine, they are for the wrong thing.
  for (const name of kase.echoParams ?? []) {
    const id = `params.echo.${name}`;
    const requested = kase.params[name];
    if (requested === undefined) {
      checks.push(skip(id, "params", `Param '${name}' not supplied by the case; nothing to echo.`));
      continue;
    }
    if (!(name in meta)) {
      checks.push(skip(id, "params", `meta.${name} not surfaced by this operation; cannot verify echo.`));
      continue;
    }
    if (String(meta[name]) !== String(requested)) {
      checks.push(
        fail(id, "params", "false_positive",
          `Requested ${name}='${String(requested)}' but the response reports '${String(meta[name])}' — the rows answer a different query.`,
          requested, meta[name]),
      );
    } else {
      checks.push(pass(id, "params", `Response echoes ${name}='${String(requested)}'.`));
    }
  }

  // 10. Every required path/query param was resolvable. dispatch stamps meta.endpointMissingParams
  //     when resolveEndpoint could not fill a required segment — a request that went out incomplete.
  const missingParams = meta.endpointMissingParams;
  if (Array.isArray(missingParams) && missingParams.length) {
    checks.push(
      fail("params.complete", "params", "false_positive",
        `Endpoint built with unresolved required param(s): ${missingParams.join(", ")}.`, [], missingParams),
    );
  } else {
    checks.push(pass("params.complete", "params", "Every required endpoint param resolved."));
  }

  // 11. Returned rows fall inside the requested date range.
  const start = isoDay(kase.params.startDate);
  const end = isoDay(kase.params.endDate);
  for (const col of kase.dateColumns ?? []) {
    const id = `params.dateRange.${col}`;
    if (!start || !end) {
      checks.push(skip(id, "params", `Case supplies no start/end date; range cannot be checked.`));
      continue;
    }
    const outside = rows
      .map((r) => isoDay(r[col]))
      .filter((d): d is string => Boolean(d))
      .filter((d) => d < start || d > end);
    if (outside.length) {
      checks.push(
        fail(id, "params", "false_positive",
          `${outside.length} row(s) have '${col}' outside the requested range ${start}..${end} (e.g. ${outside[0]}).`,
          `${start}..${end}`, outside.slice(0, 5)),
      );
    } else {
      checks.push(pass(id, "params", `All '${col}' values fall inside ${start}..${end}.`));
    }
  }

  return checks;
}

// ── Group 2: routing (false positive / false negative of operation selection) ──

/**
 * Compare the operation the agent layer chose against the one the question asks for.
 * `selected === undefined` means the router produced nothing usable and the caller fell back.
 */
export function validateRouting(kase: BacktestCase, selected: string | undefined): CheckResult[] {
  if (selected === undefined) {
    return [
      fail("routing.selected", "routing", "false_negative",
        `Router selected no operation for "${kase.question}"; the request fell back to the deterministic path.`,
        kase.operationId, null),
    ];
  }
  if (selected !== kase.operationId) {
    return [
      fail("routing.correct", "routing", "false_positive",
        `Router selected '${selected}' for a question that asks for '${kase.operationId}'.`,
        kase.operationId, selected),
    ];
  }
  return [pass("routing.correct", "routing", `Router selected '${selected}' as expected.`)];
}

// ── Group 3: grounding (hallucinated figures in LLM-authored text) ────────────

/**
 * Pull every number out of free text, normalising `$1,234.50` → 1234.5 and the accounting form
 * `(500)` → -500.
 *
 * A LEADING HYPHEN IS NOT A MINUS SIGN. Agent prose is full of hyphens that are punctuation, not
 * arithmetic — markdown bullets ("- 6 deposits"), identifiers ("GRP-100", "0520-0163-3-3500") and
 * em-dash clauses ("ABA 121000358 - the parent"). Reading those as negatives invented figures like
 * `-121000358` that were then reported as hallucinations, when the value was sitting in the data
 * with the opposite sign. Only the parenthesised accounting form denotes a negative here.
 *
 * Percentages are returned flagged so the caller can drop them: a percentage is a derived ratio,
 * not a claim about a value in the table.
 */
export function extractNumbersDetailed(text: string): Array<{ value: number; isPercent: boolean }> {
  const out: Array<{ value: number; isPercent: boolean }> = [];
  // A comma is a thousands separator ONLY when it groups exactly three digits. A loose `\d[\d,]*`
  // merged comma-separated ID LISTS into one giant number — the agent's "489_3998240,33_8431808"
  // became 399824033, a figure that appears nowhere and was duly reported as a hallucination.
  const re = /(\()?\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\))?\s*(%)?/g;
  for (const m of text.matchAll(re)) {
    const cleaned = (m[2] ?? "").replace(/,/g, "");
    if (!cleaned) continue;
    const n = Number(cleaned);
    if (!Number.isFinite(n)) continue;
    const negative = Boolean(m[1] && m[3]); // "(500)" only
    out.push({ value: negative ? -n : n, isPercent: Boolean(m[4]) });
  }
  return out;
}

/** Back-compat helper: just the values, percentages included. */
export function extractNumbers(text: string): number[] {
  return extractNumbersDetailed(text).map((n) => n.value);
}

/**
 * Build the set of figures an agent is allowed to state — everything traceable to the returned data:
 *
 *   1. every numeric cell and numeric meta value;
 *   2. every number appearing INSIDE a string cell/meta value — ids and codes like `GRP-100`,
 *      `0520-0163-3-3500` or a `489_3998240` reportId are data the agent may legitimately quote;
 *   3. whole-column aggregates (sum, avg, min, max, count);
 *   4. GROUP-BY subtotals — for each categorical column × numeric column, the per-group sum and
 *      count. Fedline's analytics prompt explicitly asks for "the total per depository institution
 *      and per carrier", so these are requested output, not invention. Omitting them made the
 *      grounding check fire on almost every case.
 *
 * Rounded and scaled forms are admitted too, since the prompts ask for readable prose ("$1.2M").
 */
export function groundedNumbers(rows: Record<string, unknown>[], meta: Record<string, unknown>): Set<number> {
  const allowed = new Set<number>();
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    allowed.add(n);
    allowed.add(Math.round(n));
    // Prose rounds to one OR two decimals ("average -68.5 per record" for -68.526…), so admit both.
    allowed.add(Math.round(n * 10) / 10);
    allowed.add(Math.round(n * 100) / 100);
    // Prose routinely states large currency scaled ("$1.6 M", "53.7k") and keeps a decimal or two,
    // so admit the scaled forms at 0/1/2 decimals rather than only the rounded integer.
    for (const scale of [1000, 1_000_000]) {
      const s = n / scale;
      allowed.add(Math.round(s));
      allowed.add(Math.round(s * 10) / 10);
      allowed.add(Math.round(s * 100) / 100);
    }
  };
  /** Admit every numeric substring of a textual value (ids, codes, dates). */
  const addFromText = (s: string) => {
    for (const m of s.matchAll(/\d[\d.]*/g)) {
      const n = Number((m[0] ?? "").replace(/\.$/, ""));
      if (Number.isFinite(n)) add(n);
    }
  };

  const numericColumns = new Map<string, number[]>();
  const categoricalColumns = new Map<string, string[]>();

  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (typeof v !== "boolean" && Number.isFinite(n) && String(v).trim() !== "") {
        add(n);
        const bucket = numericColumns.get(k) ?? [];
        bucket.push(n);
        numericColumns.set(k, bucket);
      } else {
        const s = String(v);
        addFromText(s);
        const bucket = categoricalColumns.get(k) ?? [];
        bucket.push(s);
        categoricalColumns.set(k, bucket);
      }
    }
  }

  // Whole-column aggregates.
  const columnSums = new Map<string, number>();
  for (const [key, values] of numericColumns) {
    if (!values.length) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    columnSums.set(key, sum);
    add(sum);
    add(sum / values.length);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    add(lo);
    add(hi);
    // Spread within a column — "shipments vary from 113 to 481, a 4.3-fold range" is a standard
    // way to state dispersion over figures already in the table.
    if (lo !== 0) add(hi / lo);
    add(hi - lo);
  }

  // Cross-column ratios and differences between two column totals. An analytics agent asked for
  // "decision-useful insights" legitimately states derived intensities — "about 181 units per
  // shipment", "4.5 rollup shipments per shipment", "net fee after waivers". These are arithmetic
  // over figures already in the table, not new facts, so they are traceable.
  for (const [aKey, aSum] of columnSums) {
    for (const [bKey, bSum] of columnSums) {
      if (aKey === bKey || bSum === 0) continue;
      add(aSum / bSum);
      add(aSum - bSum);
    }
  }

  // PER-ROW cross-column arithmetic — "row 7 averages ~147 volume per shipment (22,810 ÷ 155)".
  // Bounded at rows × numericColumns², and the components are both already in the table, so this
  // admits real per-record intensities without opening the door to arbitrary subset sums.
  const numKeys = [...numericColumns.keys()];
  for (const row of rows) {
    for (const a of numKeys) {
      const av = Number(row[a]);
      if (!Number.isFinite(av)) continue;
      for (const b of numKeys) {
        if (a === b) continue;
        const bv = Number(row[b]);
        if (!Number.isFinite(bv) || bv === 0) continue;
        add(av / bv);
        add(av - bv);
      }
    }
  }

  // Group-by subtotals: per categorical value, the count and each numeric column's sum/max.
  for (const [catKey, catValues] of categoricalColumns) {
    const groups = new Set(catValues);
    if (groups.size > 40) continue; // free-text column, not a grouping dimension
    for (const g of groups) {
      const members = rows.filter((r) => String(r[catKey] ?? "") === g);
      add(members.length);
      for (const numKey of numericColumns.keys()) {
        const values = members.map((r) => Number(r[numKey])).filter((n) => Number.isFinite(n));
        if (!values.length) continue;
        const sum = values.reduce((a, b) => a + b, 0);
        add(sum);
        add(sum / values.length);
        add(Math.max(...values));
        add(Math.min(...values));
      }
    }
  }

  for (const [, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    const n = Number(v);
    if (Number.isFinite(n) && String(v).trim() !== "") add(n);
    else addFromText(String(v));
  }

  // Row counts and small ordinals are always fair game ("3 insights", "top 5").
  add(rows.length);
  for (let i = 0; i <= 100; i++) allowed.add(i);
  return allowed;
}

/**
 * Check that every figure in the agent-authored text is traceable to the data. Years and percentages
 * are excluded (a percentage is derived, and a year is context, not a claim about the rows).
 */
export function validateGrounding(
  texts: { label: string; text: string }[],
  rows: Record<string, unknown>[],
  meta: Record<string, unknown>,
): CheckResult[] {
  const present = texts.filter((t) => t.text.trim().length > 0);
  if (!present.length) {
    return [skip("grounding.numbers", "grounding", "No agent-authored text was produced; nothing to ground.")];
  }

  const allowed = groundedNumbers(rows, meta);
  // Compare on MAGNITUDE. Sign in agent prose is presentational — a decrease is written "-5.14",
  // an identifier in an aside is written "(121000358)" — while the data may carry the opposite
  // sign or none. What grounding actually asserts is that the FIGURE exists in the data, so a sign
  // mismatch is not evidence of invention and must not be reported as one.
  const allowedAbs = new Set<number>();
  for (const n of allowed) allowedAbs.add(Math.abs(n));
  const allowedList = [...allowedAbs];

  /**
   * The sentence the figure appears in — without it a bare number is not diagnosable. The number is
   * matched in BOTH plain and comma-grouped form, since the agent writes "190,905" while the parsed
   * value is 190905; searching only the plain form returned an empty snippet for exactly the
   * large currency figures most worth inspecting.
   */
  const contextOf = (text: string, n: number): string => {
    const plain = Math.abs(n).toString();
    const grouped = Math.abs(n).toLocaleString("en-US");
    const alts = [...new Set([plain, grouped])].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Digit guards, not \b: without them "1.5" matched inside "11.5%" and the finding quoted a
    // sentence that did not contain the figure at all — a misleading report is worse than none.
    const hit = new RegExp(`[^.!?\\n]*(?<![\\d.])(?:${alts.join("|")})(?![\\d.])[^.!?\\n]*`).exec(text)?.[0]?.trim();
    return hit ? (hit.length > 130 ? hit.slice(0, 127) + "…" : hit) : "(figure not located in text)";
  };

  const checks: CheckResult[] = [];
  for (const { label, text } of present) {
    const id = `grounding.numbers.${label}`;
    const ungrounded = extractNumbersDetailed(text)
      // A percentage is a derived ratio, not a claim about a value in the table.
      .filter((n) => !n.isPercent)
      .map((n) => Math.abs(n.value))
      // A 4-digit value in 1900..2100 is a year, not a figure drawn from the table.
      .filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100))
      .filter((n) => !allowedAbs.has(n) && !allowedList.some((a) => nearlyEqual(a, n)));

    if (ungrounded.length) {
      const unique = [...new Set(ungrounded)];
      checks.push(
        fail(id, "grounding", "hallucination",
          `${unique.length} figure(s) in the ${label} text are not traceable to the returned rows or rollups: ` +
            unique.slice(0, 3).map((n) => `${n} ("${contextOf(text, n)}")`).join("; "),
          "figures present in rows/rollups", unique.slice(0, 10)),
      );
    } else {
      checks.push(pass(id, "grounding", `Every figure in the ${label} text is traceable to the data.`));
    }
  }
  return checks;
}

/** Convenience for the runner: the params a case sends, as the dispatch layer wants them. */
export function caseParams(kase: BacktestCase): TaskParams {
  return { ...kase.params };
}
