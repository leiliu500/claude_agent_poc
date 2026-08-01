import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Bedrock seam so the router is exercised without any AWS calls.
vi.mock("../shared/postdispatch/agent.js", () => ({
  postDispatchModelConfigured: () => true,
  converseText: vi.fn(),
}));

import { llmRoute } from "../shared/llm-router.js";
import { converseText } from "../shared/postdispatch/agent.js";

const mockedConverse = vi.mocked(converseText);

describe("llm-router (structured, validated)", () => {
  beforeEach(() => {
    delete process.env.GATEWAY_MOCK;
    delete process.env.LLM_ROUTER;
    mockedConverse.mockReset();
  });

  it("selects a valid useCase; deterministic param extraction wins over the model", async () => {
    mockedConverse.mockResolvedValue('{"tasks":[{"useCase":"ctDepositsSummary","params":{"siteId":"9999"}}],"confidence":0.8}');
    const d = await llmRoute("How much deposit from Bank of America for site ID 3279 on July 31, 2026?");
    expect(d?.tasks[0]!.useCase).toBe("ctDepositsSummary");
    expect(d?.tasks[0]!.type).toBe("Report");
    expect(d?.tasks[0]!.params.siteId).toBe("3279"); // regex value beats the model's 9999
    expect(d?.tasks[0]!.params.startDate).toBe("2026-07-31");
  });

  it("routes KB with the question as query", async () => {
    mockedConverse.mockResolvedValue('{"tasks":[{"useCase":"kbSearch","params":{}}]}');
    const d = await llmRoute("What is the EDD detail reportId derivation?");
    expect(d?.tasks[0]!.useCase).toBe("kbSearch");
    expect(d?.tasks[0]!.params.query).toContain("EDD detail reportId");
  });

  it("accepts prose-wrapped JSON and the bare {useCase} shape", async () => {
    mockedConverse.mockResolvedValue('Sure, routing that now: {"useCase":"eddSummaryReport","params":{}}');
    const d = await llmRoute("edd summary report");
    expect(d?.tasks[0]!.useCase).toBe("eddSummaryReport");
  });

  it("falls back (undefined) on an unknown useCase", async () => {
    mockedConverse.mockResolvedValue('{"tasks":[{"useCase":"not_a_real_op"}]}');
    expect(await llmRoute("anything")).toBeUndefined();
  });

  it("falls back (undefined) on model error or empty selection", async () => {
    mockedConverse.mockRejectedValueOnce(new Error("timeout"));
    expect(await llmRoute("x")).toBeUndefined();
    mockedConverse.mockResolvedValueOnce('{"tasks":[]}');
    expect(await llmRoute("x")).toBeUndefined();
  });

  it("is disabled (no model call) under GATEWAY_MOCK", async () => {
    process.env.GATEWAY_MOCK = "true";
    expect(await llmRoute("x")).toBeUndefined();
    expect(mockedConverse).not.toHaveBeenCalled();
  });
});
