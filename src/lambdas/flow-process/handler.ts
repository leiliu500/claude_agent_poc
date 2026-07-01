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
import type { AgentType, AuthContext, DispatchResult, FinalReport } from "../../shared/types.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { parseSupervisorOutput } from "../../shared/supervisor-parse.js";
import { orchestrate } from "../../shared/orchestrator.js";
import { executeTasks } from "../../shared/dispatch.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "flow-process-node" });

/** Coerce a raw flow value into an AuthContext, or undefined if absent/malformed. */
function readAuth(raw: unknown): AuthContext | undefined {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s || s === "null") return undefined;
    try {
      obj = JSON.parse(s);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const a = obj as Record<string, unknown>;
  if (!a.userId) return undefined;
  return {
    userId: String(a.userId),
    userName: typeof a.userName === "string" ? a.userName : "",
    identifiers: (a.identifiers && typeof a.identifiers === "object" ? a.identifiers : {}) as Record<string, string>,
  };
}

/** Pull `question`, `agentResponse` and the authenticated `auth` context out of the flow event. */
function readEvent(event: unknown): { question: string; agentResponse: string; auth?: AuthContext } {
  const inputs = readFlowInputs(event);
  // Named inputs first; then fall back to the single mapped value (which may itself carry them).
  const single = inputs.single<Record<string, unknown> | string | undefined>();
  const obj = single && typeof single === "object" ? (single as Record<string, unknown>) : {};

  const question = String(inputs.get("question") ?? obj.question ?? "");
  const agentResponse = String(
    inputs.get("agentResponse") ?? obj.agentResponse ?? (typeof single === "string" ? single : ""),
  );
  const auth = readAuth(inputs.get("auth") ?? obj.auth);
  return { question, agentResponse, auth };
}

/** Decide the dispatch results: prefer the supervisor's output, else deterministic local routing. */
async function resolveResults(
  question: string,
  agentResponse: string,
  auth?: AuthContext,
): Promise<{ type: AgentType; results: DispatchResult[]; source: string }> {
  const parsed = parseSupervisorOutput(agentResponse);

  if (parsed.dispatchResults.length > 0) {
    return { type: parsed.type, results: parsed.dispatchResults, source: "agent-results" };
  }
  if (parsed.tasks.length > 0) {
    return { type: parsed.type, results: await executeTasks(parsed.tasks), source: "agent-tasks" };
  }
  // Supervisor output unusable — deterministic orchestration over the original question, using the
  // authenticated identity + IDs carried in the flow's `auth` input (resolves IDs and sequences
  // EDD summary → detail without needing a name in the question text).
  const { type, results } = await orchestrate(question, auth);
  return { type, results, source: "local-orchestrator" };
}

export const handler = async (event: unknown): Promise<FinalReport> => {
  const { question, agentResponse, auth } = readEvent(event);
  log.info("process invoked", {
    questionLen: question.length,
    agentResponseLen: agentResponse.length,
    authenticated: Boolean(auth),
  });

  try {
    const { type, results, source } = await resolveResults(question, agentResponse, auth);
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
