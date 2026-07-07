/**
 * End-to-end local pipeline tests: router → dispatch → analytics → report.
 * No AWS required — this is exactly what ORCHESTRATION_MODE=local runs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { route } from "../shared/router.js";
import { executeTasks } from "../shared/dispatch.js";
import { runAnalytics } from "../shared/analytics.js";
import { generateReport } from "../shared/report.js";
import { parseSupervisorOutput, extractLastJsonObject } from "../shared/supervisor-parse.js";
import { resolveEndpoint } from "../shared/usecases.js";
import { makeActionGroupHandler } from "../shared/action-group.js";
import { readFlowInputs } from "../shared/flow-io.js";
import { handler as dispatchHandler } from "../lambdas/dispatch/handler.js";
import { handler as processHandler } from "../lambdas/flow-process/handler.js";
import { handler as dbHandler } from "../lambdas/action-groups/db/handler.js";
import { orchestrate, extractReportId } from "../shared/orchestrator.js";
import { clearMemoryForTests } from "../shared/report-memory.js";
import { extractUserName, lookupUserIdentifiers } from "../shared/user-directory.js";
import { generateMock } from "../mock/data.js";
import { ValidationError } from "../shared/errors.js";
import type { AuthContext } from "../shared/types.js";

async function pipeline(question: string) {
  const decision = route(question);
  const results = await executeTasks(decision.tasks);
  const analytics = runAnalytics(results);
  const report = generateReport({
    question,
    type: decision.type,
    dispatchResults: results,
    analytics,
    generatedAt: "2026-06-25T00:00:00.000Z",
  });
  return { decision, results, analytics, report };
}

describe("router", () => {
  it("routes an EDD summary question to EDD", () => {
    const d = route("Show me the EDD summary report for 2026-Q2");
    expect(d.type).toBe("EDD");
    expect(d.tasks[0]!.useCase).toBe("eddSummaryReport");
    expect(d.tasks[0]!.params.period).toBe("2026-Q2");
  });

  it("detects orchestration when asked to summarise AND export", () => {
    const d = route("Give me the EDD summary report and export it for 2026-Q2");
    expect(d.requiresOrchestration).toBe(true);
    const ids = d.tasks.map((t) => t.useCase);
    expect(ids).toContain("eddSummaryReport");
    expect(ids).toContain("eddExportSummaryReport");
  });

  it("'Export the EDD summary report' routes ONLY to the export use case (not the paged summary)", () => {
    const d = route(
      "Export the EDD summary report for endpoint wire, denomination USD, differenceType net, startDate 2026-04-01, endDate 2026-06-30.",
    );
    expect(d.type).toBe("EDD");
    // The export artifact is the primary (and only) deliverable — must not hit /eddReport/summary/.
    expect(d.tasks[0]!.useCase).toBe("eddExportSummaryReport");
    expect(d.tasks.map((t) => t.useCase)).not.toContain("eddSummaryReport");
  });

  it("routes ABA download questions to XShipDownload with extracted ABA", () => {
    const d = route("Download shipping activity by ABA 123456789 for zone B1");
    expect(d.type).toBe("XShipDownload");
    expect(d.tasks[0]!.params.abaNumber).toBe("123456789");
  });

  it("routes relationship questions", () => {
    const d = route("What is the ABA group relationship in the xshi file?");
    expect(d.type).toBe("Relationship");
    expect(d.tasks[0]!.useCase).toBe("xshiFileAbaGroup");
  });
});

describe("end-to-end local pipeline", () => {
  it("produces a final report with sections and a summary", async () => {
    const { report } = await pipeline("EDD detail report for 2026-Q2");
    expect(report.type).toBe("EDD");
    expect(report.sections.length).toBeGreaterThan(0);
    expect(report.sections[0]!.rows.length).toBeGreaterThan(0);
    expect(report.summary).toMatch(/Enhanced Due-Diligence/);
    expect(report.reportId).toMatch(/^RPT-EDD-/);
  });

  it("orchestrates multiple tasks into multiple sections", async () => {
    const { report, results } = await pipeline("XShip fee summary and fee detail for 2026-Q2");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(report.sections.length).toBe(results.length);
  });

  it("computes numeric summaries in analytics", async () => {
    const { analytics } = await pipeline("XShip fee detail for 2026-Q2");
    const key = Object.keys(analytics.metrics)[0]!;
    expect(analytics.metrics[key]!.rowCount).toBeGreaterThan(0);
  });
});

describe("action-group handler (Bedrock contract)", () => {
  it("executes a valid use case and returns the envelope", async () => {
    const handler = makeActionGroupHandler("EDD");
    const resp = await handler({
      messageVersion: "1.0",
      actionGroup: "edd-actions",
      apiPath: "/run",
      httpMethod: "POST",
      requestBody: {
        content: {
          "application/json": {
            properties: [
              { name: "useCase", value: "eddSummaryReport" },
              { name: "params", value: JSON.stringify({ period: "2026-Q2" }) },
            ],
          },
        },
      },
    });
    expect(resp.response.httpStatusCode).toBe(200);
    const body = JSON.parse(resp.response.responseBody["application/json"].body);
    expect(body.useCase).toBe("eddSummaryReport");
    expect(body.status).toBe("ok");
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("rejects a use case from the wrong type", async () => {
    const handler = makeActionGroupHandler("EDD");
    const resp = await handler({
      actionGroup: "edd-actions",
      requestBody: { content: { "application/json": { properties: [{ name: "useCase", value: "xShipFee" }] } } },
    });
    expect(resp.response.httpStatusCode).toBe(422);
  });
});

describe("endpoint resolution", () => {
  it("fills the EDD summary path and query from params", () => {
    const ep = resolveEndpoint("eddSummaryReport", {
      officeId: "OFF1", userAba: "111111111", aba: "222222222", endpoint: "wire",
      denomination: "USD", differenceType: "net", startDate: "2026-04-01", endDate: "2026-06-30",
      pageNumber: 1, pageSize: 50, sortField: "riskScore", sortOrder: "desc",
    })!;
    expect(ep.method).toBe("GET");
    expect(ep.path).toBe("/eddReport/summary/OFF1/111111111/222222222/wire/USD/net/2026-04-01/2026-06-30");
    expect(ep.url).toContain("?pageNumber=1&pageSize=50&sortField=riskScore&sortOrder=desc");
    expect(ep.missing).toHaveLength(0);
  });

  it("reports missing path params instead of dropping them", () => {
    const ep = resolveEndpoint("eddDetailReport", {})!;
    expect(ep.path).toBe("/eddReport/detail/{reportId}");
    expect(ep.missing).toContain("reportId");
  });

  it("selects the XShip fee export path when an export is requested", () => {
    const ep = resolveEndpoint("xShipFee", {
      rollupAbaName: "ROLL", period: "2026-Q2", export: true,
      formatType: "csv", reportName: "fees", aba: "333333333",
    })!;
    expect(ep.path).toBe("/csv/fees/ROLL/2026-Q2/333333333");
  });

  it("puts the relationship identifier on the query string", () => {
    const ep = resolveEndpoint("xshiFileAba", { abaNumber: "123456789" })!;
    expect(ep.url).toBe("/xshipRelationshipFile/xshipABA?abaNumber=123456789");
  });
});

describe("flow input reader", () => {
  it("reads named inputs from the inputs[] array", () => {
    const inputs = readFlowInputs({
      node: "Dispatch",
      inputs: [
        { name: "question", type: "String", value: "hi" },
        { name: "agentResponse", type: "String", value: "{}" },
      ],
    });
    expect(inputs.get("question")).toBe("hi");
    expect(inputs.get("agentResponse")).toBe("{}");
  });

  it("falls back to the single value when not an inputs[] array", () => {
    const inputs = readFlowInputs({ document: { a: 1 } });
    expect(inputs.single()).toEqual({ a: 1 });
  });

  it("reads the real Bedrock Flow shape: event.node.inputs", () => {
    const inputs = readFlowInputs({
      node: {
        name: "Process",
        inputs: [
          { name: "question", expression: "$.data.question", value: "hello", type: "STRING" },
          { name: "agentResponse", expression: "$.data", value: "{}", type: "STRING" },
        ],
      },
      messageVersion: "1.0",
    });
    expect(inputs.get("question")).toBe("hello");
    expect(inputs.get("agentResponse")).toBe("{}");
  });
});

describe("dispatch flow node", () => {
  it("uses supervisor dispatchResults when present", async () => {
    const agentResponse = JSON.stringify({
      type: "EDD",
      tasks: [],
      dispatchResults: [
        { type: "EDD", useCase: "eddSummaryReport", status: "ok", data: [{ x: 1 }], meta: {}, latencyMs: 3 },
      ],
    });
    const out = await dispatchHandler({
      inputs: [
        { name: "question", value: "edd summary" },
        { name: "agentResponse", value: agentResponse },
      ],
    });
    expect(out.type).toBe("EDD");
    expect(out.dispatchResults).toHaveLength(1);
    expect(out.dispatchResults[0]!.data).toHaveLength(1);
  });

  it("falls back to the local router when the agent output is unusable", async () => {
    const out = await dispatchHandler({
      inputs: [
        { name: "question", value: "EDD detail report for 2026-Q2" },
        { name: "agentResponse", value: "sorry, no structured output here" },
      ],
    });
    expect(out.type).toBe("EDD");
    expect(out.dispatchResults.length).toBeGreaterThan(0);
    expect(out.dispatchResults[0]!.status).toBe("ok");
  });
});

describe("flow-process node (combined dispatch+analytics+report)", () => {
  it("builds a full report from the supervisor's dispatchResults", async () => {
    const agentResponse = JSON.stringify({
      type: "EDD",
      tasks: [],
      dispatchResults: [
        { type: "EDD", useCase: "eddSummaryReport", status: "ok", data: [{ riskScore: 10 }], meta: {}, latencyMs: 2 },
      ],
    });
    const report = await processHandler({
      inputs: [
        { name: "question", value: "edd summary for 2026-Q2" },
        { name: "agentResponse", value: agentResponse },
      ],
    });
    expect(report.type).toBe("EDD");
    expect(report.sections).toHaveLength(1);
    expect(report.summary).toMatch(/Enhanced Due-Diligence/);
  });

  it("falls back to deterministic orchestration when the agent output is unusable", async () => {
    const report = await processHandler({
      inputs: [
        { name: "question", value: "user name: Lei Liu, XShip fee summary for 2026-Q2" },
        { name: "agentResponse", value: "no json here" },
      ],
    });
    expect(report.type).toBe("XShipReport");
    expect(report.sections.length).toBeGreaterThan(0);
  });

  it("never throws and returns a valid report even on empty input", async () => {
    const report = await processHandler({});
    expect(report.reportId).toMatch(/^RPT-/);
    expect(Array.isArray(report.sections)).toBe(true);
  });
});

describe("user directory (DBAgent seam)", () => {
  it("extracts an explicit 'user name: X' form", () => {
    expect(extractUserName("user name: Lei Liu, EDD summary for 2026-Q2")).toBe("Lei Liu");
  });

  it("matches a known directory name mentioned directly", () => {
    expect(extractUserName("Run the EDD summary for Lei Liu")).toBe("Lei Liu");
  });

  it("returns undefined when no user is identifiable", () => {
    expect(extractUserName("EDD summary report for 2026-Q2")).toBeUndefined();
  });

  it("resolves a known user's stored identifiers", async () => {
    const lookup = await lookupUserIdentifiers("lei liu");
    expect(lookup.found).toBe(true);
    expect(lookup.identifiers.abaNumber).toBe("000001");
    expect(lookup.identifiers.userAba).toBe("000001");
    expect(lookup.identifiers.endpoint).toBe("web");
  });

  it("reports an unknown user as not found", async () => {
    const lookup = await lookupUserIdentifiers("Nobody Here");
    expect(lookup.found).toBe(false);
    expect(Object.keys(lookup.identifiers)).toHaveLength(0);
  });
});

describe("DBAgent action group", () => {
  it("returns identifiers for a known user", async () => {
    const resp = await dbHandler({
      actionGroup: "db-run",
      requestBody: {
        content: { "application/json": { properties: [{ name: "params", value: JSON.stringify({ userName: "Lei Liu" }) }] } },
      },
    });
    expect(resp.response.httpStatusCode).toBe(200);
    const body = JSON.parse(resp.response.responseBody["application/json"].body);
    expect(body.found).toBe(true);
    expect(body.identifiers.aba).toBe("011000015");
  });

  it("rejects a missing user name with 400", async () => {
    const resp = await dbHandler({ actionGroup: "db-run", requestBody: { content: { "application/json": { properties: [] } } } });
    expect(resp.response.httpStatusCode).toBe(400);
  });

  it("returns 404 for an unknown user", async () => {
    const resp = await dbHandler({
      actionGroup: "db-run",
      parameters: [{ name: "userName", value: "Ghost User" }],
    });
    expect(resp.response.httpStatusCode).toBe(404);
  });
});

describe("orchestrator (supervisor-equivalent)", () => {
  it("requires a user name", async () => {
    await expect(orchestrate("EDD summary report for 2026-Q2")).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown user", async () => {
    await expect(orchestrate("EDD summary for user name: Ghost User")).rejects.toBeInstanceOf(ValidationError);
  });

  it("merges the user's DB identifiers into EDD summary params", async () => {
    const { type, results } = await orchestrate("EDD summary report for Lei Liu, 2026-Q2");
    expect(type).toBe("EDD");
    const summary = results.find((r) => r.useCase === "eddSummaryReport")!;
    // userAba/aba/endpoint/denomination/differenceType come from the DB and fill the path.
    expect(String(summary.meta.endpoint)).toContain("/eddReport/summary/");
    expect(String(summary.meta.endpoint)).toContain("/011000015/");
    // The only unfilled path params are the request-supplied ones (officeId + date range),
    // never the DB-resolved identifiers.
    const missing = (summary.meta.endpointMissingParams as string[] | undefined) ?? [];
    for (const dbParam of ["userAba", "aba", "endpoint", "denomination", "differenceType"]) {
      expect(missing).not.toContain(dbParam);
    }
  });

  it("lets explicit request params override the user's stored DB defaults", async () => {
    const { results } = await orchestrate(
      "It is Lei Liu, office_id:001 Run the EDD summary report, endpoint wire, denomination USD, " +
        "differenceType net, startDate 2026-04-01, endDate 2026-06-30.",
    );
    const summary = results.find((r) => r.useCase === "eddSummaryReport")!;
    // officeId from the request, userAba/aba from the DB, and endpoint/denomination OVERRIDDEN by
    // the explicit request values (wire/USD), not the stored defaults (web/USD-100).
    expect(String(summary.meta.endpoint)).toBe(
      "/eddReport/summary/001/000001/011000015/wire/USD/net/2026-04-01/2026-06-30",
    );
    expect(summary.meta.endpointMissingParams).toBeUndefined();
  });

  it("runs eddSummaryReport first, then eddDetailReport with the derived reportId", async () => {
    const { results } = await orchestrate("EDD detail report for Lei Liu, 2026-Q2");
    const ids = results.map((r) => r.useCase);
    expect(ids).toContain("eddSummaryReport");
    expect(ids).toContain("eddDetailReport");
    expect(ids.indexOf("eddSummaryReport")).toBeLessThan(ids.indexOf("eddDetailReport"));
    const summary = results.find((r) => r.useCase === "eddSummaryReport")!;
    const detail = results.find((r) => r.useCase === "eddDetailReport")!;
    // The detail endpoint is filled with the exact reportId the summary produced (id_id format,
    // e.g. `${eddLoadID}_${ncdwRecordID}`), so there is no missing path param.
    expect(String(summary.meta.reportId)).toMatch(/^\d+_\d+$/);
    expect(String(detail.meta.endpoint)).toContain(`/eddReport/detail/${summary.meta.reportId}`);
  });
});

describe("cross-session report memory", () => {
  // Memory is keyed on the authenticated user; the in-process store persists across turns within
  // the process, so clear it between cases to isolate them.
  beforeEach(() => clearMemoryForTests());

  async function authForLeiLiu(userId: string): Promise<AuthContext> {
    const lookup = await lookupUserIdentifiers("Lei Liu");
    return { userId, userName: "Lei Liu", identifiers: lookup.identifiers };
  }

  it("reuses a prior summary's reportId for a later detail request WITHOUT re-running the summary", async () => {
    const auth = await authForLeiLiu("1");

    // Turn 1 (this session): the user runs the EDD summary — its reportId gets remembered.
    const t1 = await orchestrate("EDD summary report for 2026-Q2", auth);
    expect(t1.results.map((r) => r.useCase)).toContain("eddSummaryReport");
    const summaryReportId = String(t1.results.find((r) => r.useCase === "eddSummaryReport")!.meta.reportId);
    expect(summaryReportId).toMatch(/^\d+_\d+$/); // `${eddLoadID}_${ncdwRecordID}`

    // Turn 2 (later): the user asks for the detail. The summary is NOT re-run — the detail runs
    // directly against the remembered reportId. This is the whole point of the feature.
    const t2 = await orchestrate("EDD detail report for 2026-Q2", auth);
    const useCases = t2.results.map((r) => r.useCase);
    expect(useCases).toContain("eddDetailReport");
    expect(useCases).not.toContain("eddSummaryReport");
    const detail = t2.results.find((r) => r.useCase === "eddDetailReport")!;
    expect(String(detail.meta.endpoint)).toContain(`/eddReport/detail/${summaryReportId}`);
  });

  it("serves 'now the detail' (no period repeated) from the user's most recent remembered summary", async () => {
    const auth = await authForLeiLiu("1");
    await orchestrate("EDD summary report for 2026-Q2", auth);

    // A bare detail ask, repeating no period, follows up on the last summary via recall_latest.
    const t2 = await orchestrate("Give me the EDD detail report", auth);
    const useCases = t2.results.map((r) => r.useCase);
    expect(useCases).toContain("eddDetailReport");
    expect(useCases).not.toContain("eddSummaryReport");
  });

  it("without a userId (legacy path) memory is disabled and the summary still runs first", async () => {
    const auth = await authForLeiLiu(""); // empty userId => memory off
    const t = await orchestrate("EDD detail report for 2026-Q2", auth);
    const useCases = t.results.map((r) => r.useCase);
    expect(useCases).toContain("eddSummaryReport");
    expect(useCases).toContain("eddDetailReport");
    expect(useCases.indexOf("eddSummaryReport")).toBeLessThan(useCases.indexOf("eddDetailReport"));
  });
});

describe("EDD detail from request-supplied record ids (no summary needed)", () => {
  beforeEach(() => clearMemoryForTests());

  it("routes eddLoadID/ncdwRecordID out of the question", () => {
    const d = route("Generate detail report for eddLoadID=6321 and ncdwRecordID=3003698918");
    expect(d.type).toBe("EDD");
    const detail = d.tasks.find((t) => t.useCase === "eddDetailReport")!;
    expect(detail.params.eddLoadID).toBe("6321");
    expect(detail.params.ncdwRecordID).toBe("3003698918");
  });

  it("composes reportId = eddLoadID_ncdwRecordID and runs the detail WITHOUT a summary", async () => {
    const lookup = await lookupUserIdentifiers("Lei Liu");
    const auth: AuthContext = { userId: "1", userName: "Lei Liu", identifiers: lookup.identifiers };
    const { results } = await orchestrate(
      "Generate detail report for eddLoadID=6321 and ncdwRecordID=3003698918",
      auth,
    );
    const useCases = results.map((r) => r.useCase);
    expect(useCases).toContain("eddDetailReport");
    expect(useCases).not.toContain("eddSummaryReport"); // record was given directly
    const detail = results.find((r) => r.useCase === "eddDetailReport")!;
    expect(String(detail.meta.endpoint)).toBe("/eddReport/detail/6321_3003698918");
  });

  it("uses an explicit report_id verbatim", () => {
    const d = route("EDD detail report_id=6321_3003698918");
    const detail = d.tasks.find((t) => t.useCase === "eddDetailReport")!;
    expect(detail.params.reportId).toBe("6321_3003698918");
  });

  it("routes a LIST of record-id pairs to eddExportDetailReport with the comma-joined reportId", () => {
    const d = route("EDD detail for 489_3998240,33_8431808");
    expect(d.type).toBe("EDD");
    expect(d.tasks).toHaveLength(1);
    const detail = d.tasks[0]!;
    expect(detail.useCase).toBe("eddExportDetailReport");
    expect(detail.params.reportId).toBe("489_3998240,33_8431808");
  });

  it("pairs TWO eddLoadID/ncdwRecordID written out separately into a comma-joined export list", () => {
    const d = route(
      "generate export detail report for eddLoadID=8030, ncdwRecordID=3003632029 and eddLoadID=8031, ncdwRecordID=3003611822",
    );
    expect(d.type).toBe("EDD");
    expect(d.tasks).toHaveLength(1);
    const detail = d.tasks[0]!;
    expect(detail.useCase).toBe("eddExportDetailReport");
    // Both pairs kept, positionally joined — not just the first.
    expect(detail.params.reportId).toBe("8030_3003632029,8031_3003611822");
  });

  it("expands both separately-written pairs end-to-end (no summary, two records)", async () => {
    const lookup = await lookupUserIdentifiers("Lei Liu");
    const auth: AuthContext = { userId: "1", userName: "Lei Liu", identifiers: lookup.identifiers };
    const { results } = await orchestrate(
      "generate export detail report for eddLoadID=8030, ncdwRecordID=3003632029 and eddLoadID=8031, ncdwRecordID=3003611822",
      auth,
    );
    expect(results.map((r) => r.useCase)).not.toContain("eddSummaryReport");
    const detail = results.find((r) => r.useCase === "eddExportDetailReport")!;
    expect(String(detail.meta.endpoint)).toContain("8030_3003632029");
    expect(String(detail.meta.endpoint)).toContain("8031_3003611822");
    const env = detail.meta.result as { reportDataList: Array<{ edd: unknown }> };
    expect(env.reportDataList).toHaveLength(2);
  });

  it("runs eddExportDetailReport over the id list WITHOUT a summary and expands every pair", async () => {
    const lookup = await lookupUserIdentifiers("Lei Liu");
    const auth: AuthContext = { userId: "1", userName: "Lei Liu", identifiers: lookup.identifiers };
    const { results } = await orchestrate("EDD detail for 489_3998240,33_8431808", auth);
    const useCases = results.map((r) => r.useCase);
    expect(useCases).toContain("eddExportDetailReport");
    expect(useCases).not.toContain("eddSummaryReport"); // records were given directly
    const detail = results.find((r) => r.useCase === "eddExportDetailReport")!;
    // One reportDataList entry per requested pair.
    const env = detail.meta.result as { reportDataList: Array<{ edd: unknown }> };
    expect(env.reportDataList).toHaveLength(2);
    expect(detail.data).toHaveLength(2);
  });
});

describe("EDD summary -> detail reportId derivation (the rule the agent applies)", () => {
  it("takes the selected summary record's eddLoadID + ncdwRecordID as the detail report_id", () => {
    const summary = {
      type: "EDD", useCase: "eddSummaryReport", status: "ok",
      data: [
        { adviceNumber: 41, eddLoadID: 2233, ncdwRecordID: 3003696182 },
        { adviceNumber: 42, eddLoadID: 2234, ncdwRecordID: 3003696183 },
      ],
      meta: {}, latencyMs: 1,
    } as unknown as import("../shared/types.js").DispatchResult;
    // No stored/fixed id — it is composed from the selected (here first) record.
    expect(extractReportId(summary)).toBe("2233_3003696182");
  });

  it("prefers a backend-surfaced meta.reportId when the summary already carries one", () => {
    const summary = {
      type: "EDD", useCase: "eddSummaryReport", status: "ok",
      data: [{ eddLoadID: 1, ncdwRecordID: 2 }],
      meta: { reportId: "489_3998240" }, latencyMs: 1,
    } as unknown as import("../shared/types.js").DispatchResult;
    expect(extractReportId(summary)).toBe("489_3998240");
  });
});

describe("EDD mock shapes (realistic API simulation)", () => {
  const eddParams = {
    officeId: "121000374", aba: "052001633", endpoint: "0520016333300",
    denomination: "FF", differenceType: "4", startDate: "2024-04-01", endDate: "2024-05-01",
    pageNumber: 2, pageSize: 5,
  };

  it("summary returns EDD records with the real reportDataList fields + totalEdds", () => {
    const { rows, meta } = generateMock("eddSummaryReport", eddParams);
    expect(rows.length).toBeLessThanOrEqual(5); // capped by pageSize
    const r = rows[0]!;
    for (const f of ["adviceNumber", "aba", "abaName", "endpointNumber", "depositType", "endpointName",
      "depositDate", "depositAmount", "denomination", "differenceType", "differenceAmount", "eddLoadID", "ncdwRecordID"]) {
      expect(r).toHaveProperty(f);
    }
    expect(r.aba).toBe("052001633");
    expect(r.endpointNumber).toBe("0520016333300"); // = aba + "3300"
    expect(typeof meta.totalEdds).toBe("number");
    // reportId is the primary record's `${eddLoadID}_${ncdwRecordID}`.
    expect(String(meta.reportId)).toMatch(/^\d+_\d+$/);
    expect(String(meta.reportId)).toBe(`${rows[0]!.eddLoadID}_${rows[0]!.ncdwRecordID}`);
    expect((meta.result as { totalEdds: number }).totalEdds).toBe(meta.totalEdds);
  });

  it("detail expands ONE record into the nested edd sections for the summary's reportId", () => {
    const { meta } = generateMock("eddSummaryReport", eddParams);
    const reportId = String(meta.reportId);
    const detail = generateMock("eddDetailReport", { ...eddParams, reportId });
    expect(detail.meta.reportId).toBe(reportId);
    const edd = (detail.meta.edd ?? {}) as Record<string, Record<string, unknown>>;
    for (const section of ["differenceDetail", "depositDetail", "adminAddress", "forAccountAddress",
      "cashDeptAddress", "additionalInfo"]) {
      expect(edd).toHaveProperty(section);
    }
    expect(edd.depositDetail).toHaveProperty("depositID");
    expect(edd.additionalInfo).toHaveProperty("differenceID");
    // Faithful raw envelope: result.reportDataList[0].edd matches the sample detail response.
    const env = detail.meta.result as { reportDataList: Array<{ edd: unknown }> };
    expect(env.reportDataList[0]!.edd).toBe(edd);
    // The table row is a flat projection (no nested objects, so it renders cleanly).
    expect(detail.rows).toHaveLength(1);
    for (const v of Object.values(detail.rows[0]!)) expect(typeof v).not.toBe("object");
  });

  it("export summary returns ALL totalEdds records, consistent to the requested aba/endpoint", () => {
    // A small pageSize proves the export ignores paging and returns the full set.
    const { rows, meta } = generateMock("eddExportSummaryReport", { ...eddParams, pageSize: 3 });
    // Full result set (not a page): reportDataList.length === totalEdds.
    expect(rows.length).toBe(meta.totalEdds);
    const env = meta.result as { totalEdds: number; reportDataList: unknown[] };
    expect(env.reportDataList).toHaveLength(meta.totalEdds as number);
    expect(rows.length).toBeGreaterThan(3); // more than the requested page size
    // Every record belongs to the filtered aba + endpoint, with ONE consistent endpointName.
    expect(new Set(rows.map((r) => r.aba))).toEqual(new Set(["052001633"]));
    expect(new Set(rows.map((r) => r.endpointNumber))).toEqual(new Set(["0520016333300"]));
    expect(new Set(rows.map((r) => r.endpointName)).size).toBe(1);
    // Deposit dates/times vary row to row (not a single hardcoded timestamp).
    expect(new Set(rows.map((r) => r.depositDate)).size).toBeGreaterThan(1);
  });

  it("export detail expands a LIST of pairs into one reportDataList entry per pair", () => {
    const reportId = "489_3998240,33_8431808";
    const detail = generateMock("eddExportDetailReport", { ...eddParams, reportId });
    expect(detail.meta.reportId).toBe(reportId);
    expect(detail.meta.reportIds).toEqual(["489_3998240", "33_8431808"]);
    const env = detail.meta.result as { reportDataList: Array<{ edd: Record<string, unknown> }> };
    expect(env.reportDataList).toHaveLength(2);
    for (const { edd } of env.reportDataList) {
      for (const section of ["differenceDetail", "depositDetail", "adminAddress", "forAccountAddress",
        "cashDeptAddress", "additionalInfo"]) {
        expect(edd).toHaveProperty(section);
      }
    }
    // Distinct records: the two pairs seed different detail content.
    expect(env.reportDataList[0]!.edd).not.toEqual(env.reportDataList[1]!.edd);
    // One flat table row per record too.
    expect(detail.rows).toHaveLength(2);
  });

  it("is deterministic for the same params (stable tests / reproducible demos)", () => {
    const a = generateMock("eddSummaryReport", eddParams).meta.reportId;
    const b = generateMock("eddSummaryReport", eddParams).meta.reportId;
    expect(a).toBe(b);
  });
});

describe("KB (knowledge base / RAG)", () => {
  it("routes a clear knowledge question to the KB type", () => {
    const d = route("What is the knowledge base guideline?");
    expect(d.type).toBe("KB");
    expect(d.tasks[0]!.useCase).toBe("kbSearch");
  });

  it("answers a kbSearch task from the in-memory corpus with grounded passages + citations", async () => {
    const results = await executeTasks([
      { type: "KB", useCase: "kbSearch", params: { query: "How is the EDD detail reportId derived?" } },
    ]);
    expect(results).toHaveLength(1);
    const kb = results[0]!;
    expect(kb.status).toBe("ok");
    expect(kb.data.length).toBeGreaterThan(0); // retrieved passages
    expect(typeof kb.meta.answer).toBe("string");
    expect(String(kb.meta.answer)).toMatch(/eddLoadID|ncdwRecordID|reportId/i); // grounded in the corpus
    expect(Array.isArray(kb.meta.citations)).toBe(true);
    expect((kb.meta.citations as string[]).length).toBeGreaterThan(0);
    expect(kb.meta.retrieval).toBe("memory"); // no DATABASE_URL in tests
  });

  it("surfaces the grounded answer + sources as the report summary", async () => {
    const question = "What is the XShip fee waiver policy?";
    const results = await executeTasks([{ type: "KB", useCase: "kbSearch", params: { query: question } }]);
    const analytics = runAnalytics(results);
    const report = generateReport({
      question,
      type: "KB",
      dispatchResults: results,
      analytics,
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    expect(report.type).toBe("KB");
    expect(report.title).toBe("Knowledge Base Answer");
    expect(report.summary).toMatch(/Based on the knowledge base/);
    expect(report.summary).toMatch(/Sources:/);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.rows.length).toBeGreaterThan(0);
  });

  it("rides the flow-process node: a KB supervisor response becomes a KB report", async () => {
    // What the supervisor emits for a knowledge question: a KB dispatchResult carrying the answer.
    const agentResponse = JSON.stringify({
      type: "KB",
      tasks: [{ type: "KB", useCase: "kbSearch", params: { query: "What is the XShip fee waiver policy?" } }],
      dispatchResults: [
        {
          type: "KB",
          useCase: "kbSearch",
          status: "ok",
          data: [{ title: "XShip Fee Waiver Policy", source: "kb://policies/xship-fee-waiver.md", score: 0.9, snippet: "Fees may be waived..." }],
          meta: {
            answer: "Based on the knowledge base: shipping fees may be waived for a rollup ABA within a period.",
            citations: ["XShip Fee Waiver Policy — kb://policies/xship-fee-waiver.md"],
            query: "What is the XShip fee waiver policy?",
            matched: 1,
            retrieval: "memory",
          },
          latencyMs: 4,
        },
      ],
    });
    const report = await processHandler({
      inputs: [
        { name: "question", value: "What is the XShip fee waiver policy?" },
        { name: "agentResponse", value: agentResponse },
      ],
    });
    expect(report.type).toBe("KB");
    expect(report.title).toBe("Knowledge Base Answer");
    expect(report.summary).toMatch(/waived/);
    expect(report.summary).toMatch(/Sources:/);
    expect(report.sections).toHaveLength(1);
  });

  it("flow-process falls back to local KB routing when the supervisor output is unusable", async () => {
    // No structured supervisor output → deterministic orchestration. An authenticated KB question
    // routes to KB locally and still produces a grounded answer (no user-name error for knowledge).
    const report = await processHandler({
      inputs: [
        { name: "question", value: "What is the knowledge base guideline?" },
        { name: "agentResponse", value: "no structured output" },
        { name: "auth", value: JSON.stringify({ userId: "1", userName: "Lei Liu", identifiers: {} }) },
      ],
    });
    expect(report.type).toBe("KB");
    expect(report.sections.length).toBeGreaterThan(0);
  });

  it("returns the Bedrock action-group envelope for a kbSearch call", async () => {
    const handler = makeActionGroupHandler("KB");
    const resp = await handler({
      messageVersion: "1.0",
      actionGroup: "kb-run",
      apiPath: "/run",
      httpMethod: "POST",
      requestBody: {
        content: {
          "application/json": {
            properties: [
              { name: "useCase", value: "kbSearch" },
              { name: "params", value: JSON.stringify({ query: "How do XShip activity downloads work?" }) },
            ],
          },
        },
      },
    });
    expect(resp.response.httpStatusCode).toBe(200);
    const body = JSON.parse(resp.response.responseBody["application/json"].body);
    expect(body.type).toBe("KB");
    expect(body.useCase).toBe("kbSearch");
    expect(body.status).toBe("ok");
    expect(typeof body.meta.answer).toBe("string");
  });

  it("answers with a not-found message when nothing matches", async () => {
    const results = await executeTasks([
      { type: "KB", useCase: "kbSearch", params: { query: "zzzq nonexistent xyzzy topic" } },
    ]);
    expect(results[0]!.status).toBe("ok");
    expect(String(results[0]!.meta.answer)).toMatch(/couldn't find/i);
  });
});

describe("supervisor output parsing", () => {
  it("extracts the last JSON object from noisy text", () => {
    const text = 'Here is my analysis... {"foo": 1} and final: {"type":"EDD","tasks":[],"dispatchResults":[]}';
    expect(extractLastJsonObject(text)).toBe('{"type":"EDD","tasks":[],"dispatchResults":[]}');
  });

  it("parses tasks and validates use case ids", () => {
    const out = parseSupervisorOutput(
      'ok {"type":"EDD","tasks":[{"useCase":"eddSummaryReport","params":{"period":"2026-Q2"}},{"useCase":"nope"}],"dispatchResults":[]}',
    );
    expect(out.type).toBe("EDD");
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]!.useCase).toBe("eddSummaryReport");
  });
});
