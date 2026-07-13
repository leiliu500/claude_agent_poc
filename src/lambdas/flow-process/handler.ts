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
import type { AgentType, AuthContext, DispatchResult, FinalReport, TaskRequest } from "../../shared/types.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { parseSupervisorOutput } from "../../shared/supervisor-parse.js";
import { orchestrate, rememberSummaryResults, runTasks } from "../../shared/orchestrator.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { runPostDispatch } from "../../shared/postdispatch/pipeline.js";
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
/**
 * A KB turn's kbSearch task. KB answers are retrieval-grounded and generated server-side, so we do
 * NOT trust the supervisor's echoed meta.answer (LLMs drop/mangle long tool outputs). We reconstruct
 * the query from the agent's KB task/result, falling back to the original question, and re-run it.
 */
function kbTaskFrom(parsed: ReturnType<typeof parseSupervisorOutput>, question: string): TaskRequest | undefined {
  const isKb =
    parsed.type === "KB" ||
    parsed.tasks.some((t) => t.type === "KB") ||
    parsed.dispatchResults.some((r) => r.type === "KB");
  if (!isKb) return undefined;

  const fromTask = parsed.tasks.find((t) => t.type === "KB");
  const q =
    (fromTask && typeof fromTask.params.query === "string" && fromTask.params.query) ||
    (parsed.dispatchResults.find((r) => r.type === "KB")?.meta?.query as string | undefined) ||
    question;
  return { type: "KB", useCase: "kbSearch", params: { query: q } };
}

async function resolveResults(
  question: string,
  agentResponse: string,
  auth?: AuthContext,
): Promise<{ type: AgentType; results: DispatchResult[]; source: string }> {
  const parsed = parseSupervisorOutput(agentResponse);

  // KB: always (re)run the retrieval server-side so the grounded answer is authoritative, regardless
  // of how the supervisor formatted (or truncated) its echoed KB result.
  const kbTask = kbTaskFrom(parsed, question);
  if (kbTask) {
    return { type: "KB", results: await runTasks([kbTask]), source: "kb-server-side" };
  }

  if (parsed.dispatchResults.length > 0) {
    // The agent already ran the tasks — record any summary reportId so a later turn can reuse it.
    await rememberSummaryResults(parsed.dispatchResults, auth?.userId);
    return { type: parsed.type, results: parsed.dispatchResults, source: "agent-results" };
  }
  if (parsed.tasks.length > 0) {
    // Run the agent's chosen tasks through the memory-aware executor so the eddSummary → detail
    // dependency reuses (or records) reportIds in this user's cross-session memory.
    return { type: parsed.type, results: await runTasks(parsed.tasks, { userId: auth?.userId }), source: "agent-tasks" };
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

    // Per-application divergence: after a Gateway dispatch, the target backend's post-dispatch policy
    // decides what runs next. Fedline spawns ephemeral analytics → report agents (app-specific prompts);
    // SCP (passthrough) and every non-Gateway path return `undefined` here and keep the deterministic
    // report. Bounded + fault-tolerant: any timeout/failure also degrades to the deterministic report.
    const post = await runPostDispatch({ question, results, analytics });

    const report = generateReport({
      question,
      type,
      dispatchResults: results,
      analytics,
      summaryOverride: post?.summary,
      agentInsights: post?.insights,
      generatedAt: new Date().toISOString(),
    });
    log.info("process completed", {
      type,
      source,
      sections: report.sections.length,
      postDispatch: post ? post.backendId : "none",
    });
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
