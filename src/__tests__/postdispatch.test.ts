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
