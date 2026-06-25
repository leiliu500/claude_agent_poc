/**
 * Bedrock Flow node #1: Dispatch (the bridge between the in-flow Agent node and the
 * deterministic analytics/report nodes).
 *
 * Inputs (from the flow):
 *   - "question"       : the original user question (from FlowInput).
 *   - "agentResponse"  : the Supervisor Agent node's completion text.
 *
 * It parses the supervisor's structured output into DispatchResult[]. For resilience it
 * degrades in two steps:
 *   1. agent returned dispatchResults        → use them as-is.
 *   2. agent returned tasks but no data       → execute those tasks here.
 *   3. agent output unparseable               → fall back to the deterministic local router.
 *
 * Output (to Analytics node): { question, type, dispatchResults }.
 */
import type { AgentType, DispatchResult } from "../../shared/types.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { parseSupervisorOutput } from "../../shared/supervisor-parse.js";
import { route } from "../../shared/router.js";
import { executeTasks } from "../../shared/dispatch.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "dispatch-node" });

interface DispatchNodeOutput {
  question: string;
  type: AgentType;
  dispatchResults: DispatchResult[];
}

export const handler = async (event: unknown): Promise<DispatchNodeOutput> => {
  const inputs = readFlowInputs(event);
  const question = String(inputs.get("question") ?? "");
  const agentResponse = String(inputs.get("agentResponse") ?? inputs.single() ?? "");

  const parsed = parseSupervisorOutput(agentResponse);

  if (parsed.dispatchResults.length > 0) {
    log.info("using supervisor dispatch results", { type: parsed.type, tasks: parsed.dispatchResults.length });
    return { question, type: parsed.type, dispatchResults: parsed.dispatchResults };
  }

  if (parsed.tasks.length > 0) {
    log.info("executing supervisor-routed tasks", { type: parsed.type, tasks: parsed.tasks.length });
    const results = await executeTasks(parsed.tasks);
    return { question, type: parsed.type, dispatchResults: results };
  }

  // Resilience: agent output unusable — deterministic local routing.
  log.warn("supervisor output unparseable; falling back to local router");
  const decision = route(question);
  const results = await executeTasks(decision.tasks);
  return { question, type: decision.type, dispatchResults: results };
};
