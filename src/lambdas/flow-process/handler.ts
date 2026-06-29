/**
 * Bedrock Flow node: Process (combined dispatch → analytics → report).
 *
 *   FlowInput ─► Supervisor (Agent) ─► Process (this) ─► FlowOutput
 *
 * This replaces the previous three-node Dispatch→Analytics→Report chain. Passing objects
 * between separate Lambda nodes proved fragile (the inter-node input expressions resolved to
 * `undefined`, so analytics saw 0 tasks and the report node crashed on `analytics.aggregate`).
 * Running the whole deterministic pipeline in ONE node removes that inter-node mapping surface
 * entirely, is faster/cheaper (one invocation), and mirrors the in-process local pipeline that
 * the unit tests and the api-entrypoint local fallback already exercise.
 *
 * Inputs (from the flow):
 *   - "question"      : the original user question (from FlowInput).
 *   - "agentResponse" : the Supervisor Agent node's completion text.
 *
 * Resilience: this handler NEVER throws. Any failure degrades to a best-effort report so the
 * flow always returns a document instead of failing the whole InvokeFlow.
 *
 * Output (to FlowOutput): FinalReport.
 */
import type { AgentType, DispatchResult, FinalReport } from "../../shared/types.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { parseSupervisorOutput } from "../../shared/supervisor-parse.js";
import { route } from "../../shared/router.js";
import { executeTasks } from "../../shared/dispatch.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "flow-process-node" });

/** Pull `question` and `agentResponse` out of the flow event, tolerating shape variants. */
function readEvent(event: unknown): { question: string; agentResponse: string } {
  const inputs = readFlowInputs(event);
  // Named inputs first; then fall back to the single mapped value (which may itself carry them).
  const single = inputs.single<Record<string, unknown> | string | undefined>();
  const obj = single && typeof single === "object" ? (single as Record<string, unknown>) : {};

  const question = String(inputs.get("question") ?? obj.question ?? "");
  const agentResponse = String(
    inputs.get("agentResponse") ?? obj.agentResponse ?? (typeof single === "string" ? single : ""),
  );
  return { question, agentResponse };
}

/** Decide the dispatch results: prefer the supervisor's output, else deterministic local routing. */
async function resolveResults(
  question: string,
  agentResponse: string,
): Promise<{ type: AgentType; results: DispatchResult[]; source: string }> {
  const parsed = parseSupervisorOutput(agentResponse);

  if (parsed.dispatchResults.length > 0) {
    return { type: parsed.type, results: parsed.dispatchResults, source: "agent-results" };
  }
  if (parsed.tasks.length > 0) {
    return { type: parsed.type, results: await executeTasks(parsed.tasks), source: "agent-tasks" };
  }
  // Supervisor output unusable — deterministic local routing over the original question.
  const decision = route(question);
  return { type: decision.type, results: await executeTasks(decision.tasks), source: "local-router" };
}

export const handler = async (event: unknown): Promise<FinalReport> => {
  const { question, agentResponse } = readEvent(event);
  log.info("process invoked", { questionLen: question.length, agentResponseLen: agentResponse.length });

  try {
    const { type, results, source } = await resolveResults(question, agentResponse);
    const analytics = runAnalytics(results);
    const report = generateReport({
      question,
      type,
      dispatchResults: results,
      analytics,
      generatedAt: new Date().toISOString(),
    });
    log.info("process completed", { type, source, sections: report.sections.length });
    return report;
  } catch (err) {
    // Never fail the flow: return a minimal, valid report describing the failure.
    log.error("process failed; returning degraded report", { error: String(err) });
    const analytics = runAnalytics([]);
    return generateReport({
      question,
      type: "EDD",
      dispatchResults: [],
      analytics,
      generatedAt: new Date().toISOString(),
    });
  }
};
