/**
 * End-to-end local pipeline tests: router → dispatch → analytics → report.
 * No AWS required — this is exactly what ORCHESTRATION_MODE=local runs.
 */
import { describe, it, expect } from "vitest";
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
import { orchestrate } from "../shared/orchestrator.js";
import { extractUserName, lookupUserIdentifiers } from "../shared/user-directory.js";
import { ValidationError } from "../shared/errors.js";

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
    const detail = results.find((r) => r.useCase === "eddDetailReport")!;
    // The detail endpoint is filled with the reportId the summary produced (no missing path param).
    expect(String(detail.meta.endpoint)).toMatch(/\/eddReport\/detail\/EDD-2026-Q2-0001/);
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
