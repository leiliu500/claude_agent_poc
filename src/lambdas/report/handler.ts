/**
 * Bedrock Flow node #2: Report generation.
 *
 * Input  (from Analytics node): { question, type, dispatchResults, analytics, generatedAt }
 * Output (to FlowOutput):       FinalReport
 */
import type { AgentType, AnalyticsResult, DispatchResult, FinalReport } from "../../shared/types.js";
import { generateReport } from "../../shared/report.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "report-node" });

interface ReportNodeInput {
  question: string;
  type: AgentType;
  dispatchResults: DispatchResult[];
  analytics: AnalyticsResult;
  generatedAt?: string;
}

function unwrap(event: unknown): ReportNodeInput {
  const inputs = readFlowInputs(event);
  const doc = inputs.get("codeHookInput") ?? inputs.single();
  return doc as ReportNodeInput;
}

export const handler = async (event: unknown): Promise<FinalReport> => {
  const input = unwrap(event);
  log.info("generating report", { type: input.type, sections: input.dispatchResults?.length ?? 0 });

  return generateReport({
    question: input.question,
    type: input.type,
    dispatchResults: input.dispatchResults ?? [],
    analytics: input.analytics,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
};
