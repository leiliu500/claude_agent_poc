import { afterEach, describe, expect, it } from "vitest";
import { AgentTraceUsageCollector, modelUsage, validModelUsage } from "../shared/model-usage.js";

const originalPricing = process.env.MODEL_PRICING_JSON;

afterEach(() => {
  if (originalPricing === undefined) delete process.env.MODEL_PRICING_JSON;
  else process.env.MODEL_PRICING_JSON = originalPricing;
});

describe("model usage accounting", () => {
  it("prices provider-reported input and output tokens independently", () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ "custom.model": { input: 2, output: 8 } });
    expect(modelUsage("custom.model", "report", { inputTokens: 1_000, outputTokens: 250, totalTokens: 1_250 })).toEqual({
      model: "custom.model", operation: "report", inputTokens: 1_000, outputTokens: 250,
      totalTokens: 1_250, costUsd: 0.004,
    });
  });

  it("retains token usage when no price is configured", () => {
    delete process.env.MODEL_PRICING_JSON;
    expect(modelUsage("private.model", "route", { inputTokens: 12, outputTokens: 3 })).toEqual({
      model: "private.model", operation: "route", inputTokens: 12, outputTokens: 3, totalTokens: 15,
    });
  });

  it("correlates Bedrock Agent input and output trace events", () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({ "custom.agent": { input: 1, output: 2 } });
    const collector = new AgentTraceUsageCollector();
    expect(collector.accept({ orchestrationTrace: { modelInvocationInput: {
      traceId: "trace-7", foundationModel: "custom.agent",
    } } })).toEqual([]);
    expect(collector.accept({ orchestrationTrace: { modelInvocationOutput: {
      traceId: "trace-7", metadata: { usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } },
    } } })).toEqual([{
      model: "custom.agent", operation: "flow-agent-orchestration", inputTokens: 40,
      outputTokens: 10, totalTokens: 50, costUsd: 0.00006,
    }]);
  });

  it("extracts direct model calls returned by an action-group Lambda", () => {
    const collector = new AgentTraceUsageCollector();
    const modelUsage = [{
      model: "amazon.titan-embed-text-v2:0", operation: "gateway-retrieval-embedding",
      inputTokens: 30, outputTokens: 0, totalTokens: 30, costUsd: 0.0000006,
    }];
    const part = { trace: { orchestrationTrace: { observation: {
      traceId: "action-1", type: "ACTION_GROUP",
      actionGroupInvocationOutput: { text: JSON.stringify({ status: "ok", meta: { modelUsage } }) },
    } } } };
    expect(collector.accept(part)).toEqual(modelUsage);
    expect(collector.accept(part)).toEqual([]);
  });

  it("rejects malformed usage arrays crossing Lambda boundaries", () => {
    expect(validModelUsage([null, { model: "m" }, {
      model: "m", operation: "route", inputTokens: 1, outputTokens: 2, totalTokens: 3,
    }])).toEqual([{ model: "m", operation: "route", inputTokens: 1, outputTokens: 2, totalTokens: 3 }]);
  });
});
