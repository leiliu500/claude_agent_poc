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
import { makeActionGroupHandler } from "../shared/action-group.js";
import { readFlowInputs } from "../shared/flow-io.js";
import { handler as dispatchHandler } from "../lambdas/dispatch/handler.js";

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
