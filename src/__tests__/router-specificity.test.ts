/**
 * Router specificity regression tests.
 *
 * These three questions were found by the Fedline backtest's routing check (`full` mode), which
 * classified each as a FALSE POSITIVE: rows came back and looked fine, but they answered a
 * different question than the one asked. Each had a distinct root cause:
 *
 *   1. Substring keyword matching — "fees" satisfied BOTH "fee" and "fees", so the catch-all
 *      XShip Fee use case collected two points from one token and outscored the specific report.
 *   2. An oversized label bonus — the short label "XShip Fee" sits inside "xship fee waivers",
 *      so the generic total beat the waiver report on a question that named waivers explicitly.
 *   3. A dropped signal — extractParams captured `internal: true` but export selection ignored it,
 *      so "export the internal detail report" resolved to the plain export.
 *
 * A fourth defect surfaced while fixing (2): a sibling label sitting inside the primary phrasing
 * was silently added as a SECOND task, so a single-report question returned two tables.
 */
import { describe, expect, it } from "vitest";
import { route } from "../shared/router.js";
import { FEDLINE_CASES } from "../shared/backtest/cases.js";

const selected = (q: string) => route(q).tasks.map((t) => t.useCase);

describe("router specificity (backtest-found false positives)", () => {
  it("routes 'XShip institution fees' to the institution report, not the fee total", () => {
    expect(selected("Show XShip institution fees for 2026-Q2")).toEqual(["xShipInstitution"]);
  });

  it("routes 'XShip fee waivers' to the waiver report, not the fee total", () => {
    expect(selected("Show XShip fee waivers for 2026-Q2")).toEqual(["xShipWaiver"]);
  });

  it("routes an internal detail export to the internal artifact", () => {
    expect(selected("Export the internal EDD detail report for June 2026")).toEqual(["eddExportDetailInternal"]);
  });

  it("still routes a plain detail export to the plain artifact", () => {
    expect(selected("Export the EDD detail report for June 2026")).toEqual(["eddExportDetailReport"]);
  });

  it("honours 'confidential' as the internal signal too", () => {
    expect(selected("Export the confidential EDD detail report")).toEqual(["eddExportDetailInternal"]);
  });
});

describe("router single- vs multi-deliverable", () => {
  it("returns ONE task when the question names one report", () => {
    // "xship fee" is a substring of this phrasing; it must not become a second task.
    expect(selected("Show XShip fee waivers for 2026-Q2")).toHaveLength(1);
    expect(selected("Show XShip institution fees for 2026-Q2")).toHaveLength(1);
  });

  it("still orchestrates when the question genuinely enumerates two deliverables", () => {
    const tasks = selected("Give me the EDD summary report and export it");
    expect(tasks.length).toBeGreaterThan(1);
    expect(tasks).toContain("eddExportSummaryReport");
  });
});

describe("every Fedline backtest question routes to its own operation", () => {
  // The guard that matters. Fixing the first three defects tightened scoring enough to break a
  // FOURTH case (ABA relationships tying four use cases, resolved by declaration order) — caught
  // only because the live backtest re-ran. This asserts the whole set locally, so the next scoring
  // change cannot silently trade one routing fix for another regression.
  it.each(FEDLINE_CASES.map((c) => [c.caseId, c.question, c.operationId as string]))(
    "%s → %s",
    (_caseId, question, operationId) => {
      expect(route(question).tasks[0]?.useCase).toBe(operationId);
    },
  );
});

describe("the generic fee report still wins when nothing more specific is named", () => {
  // The fix must not over-correct: a question that names no distinguishing report should still land
  // on the catch-all total, which is the behaviour the specificity changes are carving exceptions out of.
  it("routes a bare fee question to the fee total", () => {
    expect(selected("What is the total XShip fee for 2026-Q2?")).toEqual(["xShipFee"]);
  });

  it("routes a bare 'xship fees' question to the fee total", () => {
    expect(selected("Show XShip fees for 2026-Q2")).toEqual(["xShipFee"]);
  });
});
