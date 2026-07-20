/**
 * Per-application post-dispatch divergence: after a Gateway dispatch, the target backend's
 * PostDispatchPolicy decides what runs next.
 *   - Fedline (mode "agents"): ephemeral analytics → report agents produce insights + a summary.
 *   - SCP (passthrough) and non-Gateway paths: no agents; the deterministic report stands.
 *
 * The ephemeral agents' Bedrock call is mocked here so the test is hermetic (no AWS). The deterministic
 * fallback paths (mock mode / no model / failure) need no mock — they never reach Bedrock.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearRegistryForTests, getBackend } from "../shared/gateway/registry.js";
import { seedBuiltinBackends } from "../shared/gateway/seed.js";
import { runAnalytics } from "../shared/analytics.js";
import { generateReport } from "../shared/report.js";
import { runPostDispatch } from "../shared/postdispatch/pipeline.js";
import { runDynamicAgent } from "../shared/postdispatch/agent.js";
import type { DispatchResult } from "../shared/types.js";

// Stub the ephemeral-agent module: analytics agent returns a JSON insight array, report agent a summary.
vi.mock("../shared/postdispatch/agent.js", () => ({
  postDispatchModelConfigured: () => true,
  runDynamicAgent: vi.fn(async (spec: { role: string }) =>
    spec.role === "analytics"
      ? '["Total difference amount is 350 across 2 records.", "Largest single record is 250."]'
      : "Two EDD difference records totalling 350 were returned; the largest is 250 and warrants review.",
  ),
}));

function fedlineResult(): DispatchResult {
  return {
    type: "Gateway",
    useCase: "eddSummaryReport",
    status: "ok",
    data: [
      { eddLoadID: 2233, amount: 100, status: "OPEN" },
      { eddLoadID: 2234, amount: 250, status: "OPEN" },
    ],
    meta: { backendId: "fedline", operationId: "eddSummaryReport" },
    latencyMs: 1,
  };
}

function scpResult(): DispatchResult {
  return {
    type: "Gateway",
    useCase: "submitEasySim",
    status: "ok",
    data: [{ value: "Request sent successfully. Request ID: RQ-1." }],
    meta: { backendId: "scp", operationId: "submitEasySim", response: "Request sent successfully. Request ID: RQ-1." },
    latencyMs: 1,
  };
}

beforeEach(async () => {
  clearRegistryForTests();
  vi.clearAllMocks(); // reset ephemeral-agent call history (keeps the mocked implementation)
  // Default: hermetic mock mode → agents disabled → deterministic fallback.
  process.env.GATEWAY_MOCK = "true";
  delete process.env.POSTDISPATCH_AGENTS;
  await seedBuiltinBackends();
});

describe("post-dispatch policy is registry metadata", () => {
  it("seeds Fedline with an analytics→report agents policy and SCP with passthrough", async () => {
    const fedline = await getBackend("fedline");
    const scp = await getBackend("scp");
    expect(fedline?.postDispatch?.mode).toBe("agents");
    expect(fedline?.postDispatch?.agents?.map((a) => a.role)).toEqual(["analytics", "report"]);
    expect(scp?.postDispatch?.mode).toBe("passthrough");
  });

  it("carries per-operation overlays for both agents (API-specific specialization)", async () => {
    const fedline = await getBackend("fedline");
    const [analytics, report] = fedline?.postDispatch?.agents ?? [];
    // Operation-specific override present…
    expect(analytics?.overlays?.eddSummaryReport).toContain("EDD SUMMARY");
    // …and a family overlay covers operations without a specific override.
    expect(analytics?.overlays?.xShipInstitution).toContain("XShip");
    expect(report?.overlays?.xshiFileAba).toContain("relationship");
    // SCP is passthrough — no agents, hence no overlays.
    expect((await getBackend("scp"))?.postDispatch?.agents).toBeUndefined();
  });
});

describe("runPostDispatch divergence", () => {
  it("returns undefined for SCP (passthrough) — no agents run", async () => {
    process.env.GATEWAY_MOCK = "false"; // even with agents enabled, passthrough short-circuits
    const results = [scpResult()];
    const out = await runPostDispatch({ question: "submit easy", results, analytics: runAnalytics(results) });
    expect(out).toBeUndefined();
  });

  it("returns undefined for Fedline when agents are disabled (mock mode) — deterministic fallback", async () => {
    const results = [fedlineResult()];
    const out = await runPostDispatch({ question: "edd summary", results, analytics: runAnalytics(results) });
    expect(out).toBeUndefined();
  });

  it("returns undefined for a non-Gateway result set", async () => {
    process.env.GATEWAY_MOCK = "false";
    const results: DispatchResult[] = [
      { type: "EDD", useCase: "eddSummaryReport", status: "ok", data: [{ a: 1 }], meta: {}, latencyMs: 1 },
    ];
    const out = await runPostDispatch({ question: "edd", results, analytics: runAnalytics(results) });
    expect(out).toBeUndefined();
  });

  it("still fires when the supervisor parser re-typed the result away from Gateway (keys off meta.backendId)", async () => {
    process.env.GATEWAY_MOCK = "false";
    // Fedline op ids collide with static USE_CASES, so coerceResults re-types "Gateway" → "EDD".
    // meta.backendId survives and must still select the dispatch for post-dispatch.
    const coerced: DispatchResult = { ...fedlineResult(), type: "EDD" };
    const out = await runPostDispatch({ question: "edd summary", results: [coerced], analytics: runAnalytics([coerced]) });
    expect(out?.backendId).toBe("fedline");
    expect(out?.insights).toHaveLength(2);
  });

  it("spawns Fedline's analytics + report agents and returns their insights + summary", async () => {
    process.env.GATEWAY_MOCK = "false"; // enable the (mocked) agents
    const results = [fedlineResult()];
    const out = await runPostDispatch({ question: "edd summary", results, analytics: runAnalytics(results) });
    expect(out?.backendId).toBe("fedline");
    expect(out?.insights).toHaveLength(2);
    expect(out?.insights[0]).toContain("350");
    expect(out?.summary).toContain("warrants review");
  });

  it("composes the invoked operation's overlay onto the base prompt of BOTH agents", async () => {
    process.env.GATEWAY_MOCK = "false"; // enable the (mocked) agents
    const results = [fedlineResult()]; // useCase eddSummaryReport
    await runPostDispatch({ question: "edd summary", results, analytics: runAnalytics(results) });

    const calls = vi.mocked(runDynamicAgent).mock.calls;
    const analyticsPrompt = calls.find((c) => c[0].role === "analytics")?.[0].prompt ?? "";
    const reportPrompt = calls.find((c) => c[0].role === "report")?.[0].prompt ?? "";

    // Base role scaffolding is still there…
    expect(analyticsPrompt).toContain("analytics agent");
    expect(reportPrompt).toContain("report agent");
    // …with the eddSummaryReport operation overlay appended (API-specific specialization).
    expect(analyticsPrompt).toContain("EDD SUMMARY");
    // eddSummaryReport has no report-specific override → falls back to the EDD family report overlay.
    expect(reportPrompt).toContain("BSA/AML compliance reviewer");
  });

  it("falls back to the operation's own summary/description when no overlay is authored", async () => {
    process.env.GATEWAY_MOCK = "false";
    // A backend whose operation has NO authored overlay: the auto-overlay uses its summary/description.
    const { registerBackend } = await import("../shared/gateway/registry.js");
    await registerBackend({
      backendId: "acme",
      name: "Acme",
      baseUrl: "https://acme.pvt",
      operations: [
        { operationId: "listWidgets", method: "GET", path: "/widgets", summary: "List all widgets", description: "Paginated widget catalog", params: [], keywords: ["widgets"] },
      ],
      postDispatch: { mode: "agents", agents: [{ role: "analytics", prompt: "You are the analytics agent." }] },
    });
    const results: DispatchResult[] = [
      { type: "Gateway", useCase: "listWidgets", status: "ok", data: [{ id: 1 }], meta: { backendId: "acme", operationId: "listWidgets" }, latencyMs: 1 },
    ];
    await runPostDispatch({ question: "widgets", results, analytics: runAnalytics(results) });
    const prompt = vi.mocked(runDynamicAgent).mock.calls.find((c) => c[0].role === "analytics")?.[0].prompt ?? "";
    expect(prompt).toContain("List all widgets");
    expect(prompt).toContain("Paginated widget catalog");
  });

  it("folds the agent output into the report (summary override + insights on the first section)", async () => {
    process.env.GATEWAY_MOCK = "false";
    const results = [fedlineResult()];
    const analytics = runAnalytics(results);
    const post = await runPostDispatch({ question: "edd summary", results, analytics });
    const report = generateReport({
      question: "edd summary",
      type: "Gateway",
      dispatchResults: results,
      analytics,
      summaryOverride: post?.summary,
      agentInsights: post?.insights,
      generatedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(report.summary).toBe(post?.summary);
    expect(report.sections[0]?.highlights[0]).toContain("350");
  });
});
