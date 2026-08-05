/**
 * Fedline backtest tests.
 *
 * Two things must hold for the suite to be worth anything:
 *   1. It genuinely passes against the real dispatch path (no case is mis-specified).
 *   2. It genuinely FAILS when the data is wrong — each validator is proven by feeding it a
 *      deliberately broken DispatchResult and asserting the exact failure kind it should classify.
 *
 * (2) is the important half: a validation suite that cannot fail is decoration.
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../shared/backtest/run.js";
import { FEDLINE_CASES, coverageGaps, fedlineOperationIds } from "../shared/backtest/cases.js";
import { extractNumbers, groundedNumbers, validateGrounding, validateRouting, validateTableData } from "../shared/backtest/validators.js";
import type { BacktestCase } from "../shared/backtest/cases.js";
import type { DispatchResult } from "../shared/types.js";

/** A minimal case + matching result pair used to exercise one validator at a time. */
const CASE: BacktestCase = {
  caseId: "probe",
  operationId: "ctDepositsSummary",
  type: "Report",
  question: "How much was deposited at site 3501 on 2026-07-31?",
  params: { siteId: "3501", startDate: "2026-07-31", endDate: "2026-07-31" },
  requiredColumns: ["carrierName", "amount", "dateTime"],
  numericColumns: ["amount"],
  rollups: [{ metaKey: "totalDepositAmount", column: "amount", op: "sum" }],
  countKeys: ["reportCount"],
  echoParams: ["siteId", "startDate"],
  dateColumns: ["dateTime"],
};

function result(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    type: "Report",
    useCase: "ctDepositsSummary",
    status: "ok",
    data: [
      { carrierName: "BRINKS-ALBUQ.", amount: 1000, dateTime: "2026-07-31 09:00:00.000 MT" },
      { carrierName: "GARDA-PHOENIX", amount: 2000, dateTime: "2026-07-31 11:00:00.000 MT" },
    ],
    meta: { totalDepositAmount: 3000, reportCount: 2, siteId: "3501", startDate: "2026-07-31" },
    latencyMs: 1,
    ...over,
  };
}

const byId = (checks: ReturnType<typeof validateTableData>, id: string) => checks.find((c) => c.id === id);

describe("backtest case coverage", () => {
  it("covers every Fedline operation exactly once", () => {
    expect(coverageGaps()).toEqual({ missing: [], unknown: [] });
    expect(FEDLINE_CASES.length).toBe(fedlineOperationIds().length);
    expect(new Set(FEDLINE_CASES.map((c) => c.caseId)).size).toBe(FEDLINE_CASES.length);
  });
});

describe("table-data validators (happy path)", () => {
  it("passes a well-formed result with no failures", () => {
    const checks = validateTableData(CASE, result());
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(byId(checks, "integrity.rollup.totalDepositAmount")?.status).toBe("pass");
  });
});

describe("table-data validators (each failure mode)", () => {
  it("classifies a dispatch error as a false negative", () => {
    const checks = validateTableData(CASE, result({ status: "error", error: "boom", data: [] }));
    expect(byId(checks, "dispatch.ok")?.failureKind).toBe("false_negative");
  });

  it("classifies an empty table as a false negative", () => {
    const checks = validateTableData(CASE, result({ data: [], meta: { totalDepositAmount: 0, reportCount: 0 } }));
    expect(byId(checks, "rows.nonEmpty")?.failureKind).toBe("false_negative");
  });

  it("catches a rollup that disagrees with the rows", () => {
    const broken = result();
    broken.meta.totalDepositAmount = 9999; // rows sum to 3000
    const check = byId(validateTableData(CASE, broken), "integrity.rollup.totalDepositAmount");
    expect(check?.status).toBe("fail");
    expect(check?.failureKind).toBe("data_integrity");
    expect(check?.expected).toBe(3000);
    expect(check?.actual).toBe(9999);
  });

  it("catches a claimed count that disagrees with the row count", () => {
    const broken = result();
    broken.meta.reportCount = 7;
    expect(byId(validateTableData(CASE, broken), "integrity.count.reportCount")?.failureKind).toBe("data_integrity");
  });

  it("catches a missing required column", () => {
    const broken = result();
    delete (broken.data[1] as Record<string, unknown>).amount;
    expect(byId(validateTableData(CASE, broken), "schema.requiredColumns")?.failureKind).toBe("data_integrity");
  });

  it("catches ragged rows", () => {
    const broken = result();
    (broken.data[1] as Record<string, unknown>).extra = "surprise";
    expect(byId(validateTableData(CASE, broken), "schema.uniform")?.failureKind).toBe("data_integrity");
  });

  it("catches a non-finite numeric cell", () => {
    const broken = result();
    (broken.data[0] as Record<string, unknown>).amount = "not-a-number";
    expect(byId(validateTableData(CASE, broken), "schema.numericFinite")?.failureKind).toBe("data_integrity");
  });

  it("classifies a param the response did not honour as a false positive", () => {
    const broken = result();
    broken.meta.siteId = "9999"; // asked for 3501
    const check = byId(validateTableData(CASE, broken), "params.echo.siteId");
    expect(check?.failureKind).toBe("false_positive");
  });

  it("classifies rows outside the requested date range as a false positive", () => {
    const broken = result();
    (broken.data[1] as Record<string, unknown>).dateTime = "2026-08-15 11:00:00.000 MT";
    expect(byId(validateTableData(CASE, broken), "params.dateRange.dateTime")?.failureKind).toBe("false_positive");
  });

  it("classifies an unresolved required endpoint param as a false positive", () => {
    const broken = result();
    broken.meta.endpointMissingParams = ["siteId"];
    expect(byId(validateTableData(CASE, broken), "params.complete")?.failureKind).toBe("false_positive");
  });

  it("skips — never passes — a rollup whose meta key is absent", () => {
    const noMeta = result({ meta: { reportCount: 2, siteId: "3501", startDate: "2026-07-31" } });
    expect(byId(validateTableData(CASE, noMeta), "integrity.rollup.totalDepositAmount")?.status).toBe("skip");
  });
});

describe("routing validator", () => {
  it("flags no selection as a false negative", () => {
    expect(validateRouting(CASE, undefined)[0]?.failureKind).toBe("false_negative");
  });

  it("flags the wrong operation as a false positive", () => {
    const check = validateRouting(CASE, "eddSummaryReport")[0];
    expect(check?.failureKind).toBe("false_positive");
    expect(check?.actual).toBe("eddSummaryReport");
  });

  it("passes the expected operation", () => {
    expect(validateRouting(CASE, "ctDepositsSummary")[0]?.status).toBe("pass");
  });
});

describe("grounding validator", () => {
  const rows = result().data;
  const meta = result().meta;

  it("extracts numbers from currency, thousands separators and parentheses", () => {
    expect(extractNumbers("Total $1,234.50 across 7 deposits, variance (500)")).toEqual([1234.5, 7, -500]);
  });

  it("admits figures present in the rows and their aggregates", () => {
    const allowed = groundedNumbers(rows, meta);
    expect(allowed.has(1000)).toBe(true);   // a cell
    expect(allowed.has(3000)).toBe(true);   // the sum
    expect(allowed.has(1500)).toBe(true);   // the average
  });

  it("passes text whose figures all come from the data", () => {
    const checks = validateGrounding(
      [{ label: "report", text: "Total deposited: $3,000 across 2 deposits; largest was $2,000." }],
      rows, meta,
    );
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("flags an invented figure as a hallucination", () => {
    const checks = validateGrounding(
      [{ label: "report", text: "Total deposited: $8,675,309 across 2 deposits." }],
      rows, meta,
    );
    expect(checks[0]?.failureKind).toBe("hallucination");
    expect(String(checks[0]?.detail)).toContain("8675309");
  });

  it("does not treat a year as a hallucinated figure", () => {
    const checks = validateGrounding(
      [{ label: "report", text: "Across 2026 the total was $3,000." }],
      rows, meta,
    );
    expect(checks[0]?.status).toBe("pass");
  });

  it("skips — never passes — when no agent text was produced", () => {
    const checks = validateGrounding([], rows, meta);
    expect(checks[0]?.status).toBe("skip");
  });

  // ── Regressions from the first live `full` run, where the model was finally reachable. ──
  // Every one of these produced a bogus "hallucination" against real agent output.
  describe("does not invent hallucinations of its own", () => {
    it("treats a leading hyphen as punctuation, not a minus sign", () => {
      // Markdown bullets, em-dash clauses and hyphenated ids are not negative numbers.
      expect(extractNumbers("- 6 deposits")).toEqual([6]);
      expect(extractNumbers("ABA 121000358 - the parent institution")).toEqual([121000358]);
      // The accounting form still denotes a negative.
      expect(extractNumbers("variance (500)")).toEqual([-500]);
    });

    it("ignores percentages, which are derived ratios not table values", () => {
      const checks = validateGrounding(
        [{ label: "report", text: "Deposits rose 2.3% with 13.2% concentrated in one carrier." }],
        rows, meta,
      );
      expect(checks[0]?.status).toBe("pass");
    });

    it("admits numbers embedded in identifier strings", () => {
      const idRows = [{ abaGroup: "GRP-100", abaNumber: "121000358", active: true }];
      const allowed = groundedNumbers(idRows, {});
      expect(allowed.has(100)).toBe(true);
      expect(allowed.has(121000358)).toBe(true);
    });

    it("admits group-by subtotals, which the analytics prompt explicitly requests", () => {
      const deposits = [
        { carrierName: "BRINKS", amount: 3000 },
        { carrierName: "BRINKS", amount: 4000 },
        { carrierName: "GARDA", amount: 5000 },
      ];
      const allowed = groundedNumbers(deposits, {});
      expect(allowed.has(7000)).toBe(true);  // BRINKS subtotal — the figure that fired falsely
      expect(allowed.has(5000)).toBe(true);  // GARDA subtotal
      expect(allowed.has(12000)).toBe(true); // whole-column total
    });

    it("still catches a genuinely invented figure", () => {
      // The check must stay sharp after all that loosening.
      const checks = validateGrounding(
        [{ label: "report", text: "Total deposited: $8,675,309." }],
        rows, meta,
      );
      expect(checks[0]?.failureKind).toBe("hallucination");
    });
  });
});

describe("runBacktest against the real dispatch path", () => {
  it("passes every Fedline case in data mode", async () => {
    const summary = await runBacktest({ mode: "data" });
    const failing = summary.cases.filter((c) => c.status !== "pass");
    // Name the offenders so a regression is diagnosable straight from the test output.
    expect(
      failing.map((c) => `${c.caseId}: ${c.checks.filter((k) => k.status === "fail").map((k) => k.detail).join("; ")}`),
    ).toEqual([]);
    expect(summary.totals.cases).toBe(FEDLINE_CASES.length);
    expect(summary.totals.checksFailed).toBe(0);
    expect(summary.totals.checks).toBeGreaterThan(FEDLINE_CASES.length * 5);
  });

  it("honours a caseIds filter and omits the coverage case", async () => {
    const summary = await runBacktest({ mode: "data", caseIds: ["ct-deposits-summary"] });
    expect(summary.cases.map((c) => c.caseId)).toEqual(["ct-deposits-summary"]);
  });

  it("reports data mode's routing/grounding checks as absent rather than passed", async () => {
    const summary = await runBacktest({ mode: "data" });
    const ids = summary.cases.flatMap((c) => c.checks.map((k) => k.id));
    expect(ids.some((id) => id.startsWith("routing."))).toBe(false);
    expect(ids.some((id) => id.startsWith("grounding."))).toBe(false);
  });
});
