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
import type { AgentStep, AgentType, AuthContext, DispatchResult, FinalReport } from "../../shared/types.js";
import { readFlowInputs } from "../../shared/flow-io.js";
import { orchestrate, type GatewayMeta, type RouteMeta } from "../../shared/orchestrator.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { runPostDispatch, type PostDispatchOutput } from "../../shared/postdispatch/pipeline.js";
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

/**
 * The dispatch results for a request. The in-code orchestrator (LLM router → gateway/registry →
 * dispatch → post-dispatch agents) is now the SINGLE authoritative path, so the execution trace is
 * complete and identical on every request. The Bedrock supervisor agent's echoed `agentResponse` is
 * intentionally NOT used to drive: it was non-deterministic — when it happened to emit a parseable
 * result it BYPASSED the post-dispatch agents and produced a sparse, inconsistent trace.
 */
async function resolveResults(
  question: string,
  auth?: AuthContext,
): Promise<{ type: AgentType; results: DispatchResult[]; routeMeta: RouteMeta; gatewayMeta: GatewayMeta }> {
  const { type, results, routeMeta, gatewayMeta } = await orchestrate(question, auth);
  return { type, results, routeMeta, gatewayMeta };
}

/**
 * Assemble the ordered execution-path trace for the UI: routing → gateway → dispatch → post-dispatch
 * agents. Every step reflects what ACTUALLY ran (or was skipped) — the evidence the system is
 * agent-driven, and the two-layer (route → gateway) decoupling made visible.
 */
function buildTrace(
  routeMeta: RouteMeta,
  gatewayMeta: GatewayMeta,
  results: DispatchResult[],
  post: PostDispatchOutput | undefined,
): AgentStep[] {
  const steps: AgentStep[] = [];

  // 1) Routing agent (Layer 1): human language → target operation(s).
  steps.push({
    stage: "route", agent: "Routing classifier", engine: routeMeta.engine, status: "ran",
    model: routeMeta.model, confidence: routeMeta.confidence,
    detail: `→ ${routeMeta.useCases.join(", ") || "—"}`, latencyMs: routeMeta.latencyMs,
  });

  // 2) Gateway discovery AGENT (Layer 2, gateway.md): discovers which registered operation serves the
  //    request. Runs for single-op application requests; KB / multi-task keep the Layer-1 tasks (skipped).
  if (gatewayMeta.ran) {
    steps.push({
      stage: "gateway", agent: "Gateway agent", engine: gatewayMeta.engine ?? "proxy", status: "ran",
      model: gatewayMeta.model, confidence: gatewayMeta.score,
      detail: [gatewayMeta.backendId, gatewayMeta.operationId].filter(Boolean).join(" / ") || "matched",
      latencyMs: gatewayMeta.latencyMs,
    });
  } else {
    steps.push({
      stage: "gateway", agent: "Gateway agent", engine: "proxy", status: "skipped",
      detail: "KB or multi-task request — kept the router's task list",
    });
  }

  // 3) Dynamic execution agent — a runtime executor CREATED PER REQUEST that resolves the discovered
  //    operation's endpoint + params and invokes it through the generic proxy. One per task, and it
  //    runs BEFORE the post-dispatch analytics/report agents (it produces the rows they analyse).
  for (const r of results) {
    const backend = typeof r.meta?.backendId === "string" ? r.meta.backendId : undefined;
    steps.push({
      stage: "dispatch", agent: "Dynamic execution agent", engine: "proxy",
      status: r.status === "ok" ? "ran" : "fallback",
      detail: `runtime executor · ${backend ? backend + "/" : ""}${r.useCase} · ${r.data.length} row(s)`,
      latencyMs: r.latencyMs,
    });
  }

  // 4) Post-dispatch agents (analytics → report), spawned per operation. Present ⇒ they ran; absent ⇒
  //    not on this path (a passthrough backend, KB, or a bounded timeout/failure that degraded).
  if (post && post.steps.length) {
    steps.push(...post.steps);
  } else {
    steps.push({ stage: "analytics", agent: "Analytics agent", engine: "llm", status: "skipped", detail: "not run on this path" });
    steps.push({ stage: "report", agent: "Report agent", engine: "llm", status: "skipped", detail: "not run on this path" });
  }
  return steps;
}

export const handler = async (event: unknown): Promise<FinalReport> => {
  const { question, agentResponse, auth } = readEvent(event);
  log.info("process invoked", {
    questionLen: question.length,
    agentResponseLen: agentResponse.length,
    authenticated: Boolean(auth),
  });

  try {
    const { type, results, routeMeta, gatewayMeta } = await resolveResults(question, auth);
    const analytics = runAnalytics(results);

    // Per-application divergence: after dispatch, the target backend's post-dispatch policy decides what
    // runs next. Fedline spawns ephemeral analytics → report agents (app-specific prompts); SCP
    // (passthrough) and KB return `undefined` here and keep the deterministic report. Bounded +
    // fault-tolerant: any timeout/failure also degrades to the deterministic report.
    const post = await runPostDispatch({ question, results, analytics });

    const trace = buildTrace(routeMeta, gatewayMeta, results, post);
    const report = generateReport({
      question,
      type,
      dispatchResults: results,
      analytics,
      summaryOverride: post?.summary,
      agentInsights: post?.insights,
      trace,
      generatedAt: new Date().toISOString(),
    });
    log.info("process completed", {
      type,
      routedBy: routeMeta.engine,
      gateway: gatewayMeta.ran,
      sections: report.sections.length,
      postDispatch: post ? post.backendId : "none",
      agents: trace.filter((s) => s.engine === "llm" && s.status === "ran").length,
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
