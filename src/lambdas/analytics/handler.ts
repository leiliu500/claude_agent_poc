/**
 * Bedrock Flow node #1: Analytics.
 *
 * Input  (from FlowInput): { question, type, dispatchResults }
 * Output (to Report node): { question, type, dispatchResults, analytics, generatedAt }
 *
 * Bedrock Flow Lambda nodes receive the mapped input as the event. We defensively unwrap a
 * couple of known shapes so the same handler also works when invoked directly (tests).
 */
import type { DispatchResult } from "../../shared/types.js";
import { runAnalytics } from "../../shared/analytics.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "analytics-node" });

interface AnalyticsInput {
  question: string;
  type: string;
  dispatchResults: DispatchResult[];
  generatedAt?: string;
}

function unwrap(event: unknown): AnalyticsInput {
  const inputs = readFlowInputs(event);
  const doc = inputs.get("codeHookInput") ?? inputs.single();
  return doc as AnalyticsInput;
}

export const handler = async (event: unknown): Promise<AnalyticsInput & { analytics: ReturnType<typeof runAnalytics> }> => {
  const input = unwrap(event);
  const results = input.dispatchResults ?? [];
  log.info("running analytics", { type: input.type, tasks: results.length });

  const analytics = runAnalytics(results);
  return {
    question: input.question,
    type: input.type,
    dispatchResults: results,
    // generatedAt is stamped here (flow input metadata is not reliably a clock source).
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    analytics,
  };
};
