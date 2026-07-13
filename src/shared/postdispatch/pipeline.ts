/**
 * Per-application post-dispatch pipeline.
 *
 * After the Gateway proxy invokes an operation, WHAT happens next is decided by the target backend's
 * PostDispatchPolicy (registry metadata), not by the request type — so each registered app can diverge
 * completely:
 *   - Fedline  (mode "agents"): spawn an ephemeral analytics agent to derive insights over the returned
 *                               rows, then an ephemeral report agent to transform them into a summary.
 *   - SCP      (passthrough / no policy): nothing extra — the deterministic report surfaces the raw ack.
 *
 * Latency model (bound + fallback, stay sync): the whole two-agent sequence runs under POSTDISPATCH_
 * BUDGET_MS. If the budget is exceeded, a model call fails, or no model is configured, this returns
 * `undefined` and the caller falls back to the existing deterministic analytics+report — the flow
 * always returns a document within the HTTP sync deadline. GATEWAY_MOCK forces the deterministic path
 * so tests / local mode stay hermetic (no Bedrock).
 */
import type { AnalyticsResult, DispatchResult } from "../types.js";
import { createLogger } from "../logger.js";
import { getBackend } from "../gateway/registry.js";
import { postDispatchModelConfigured, runDynamicAgent } from "./agent.js";
import type { PostDispatchAgentSpec, PostDispatchPolicy } from "../gateway/types.js";

const log = createLogger({ mod: "postdispatch-pipeline" });

/** Wall-clock budget for the ENTIRE post-dispatch agent sequence (kept under the HTTP sync cap). */
const BUDGET_MS = Number(process.env.POSTDISPATCH_BUDGET_MS ?? "16000");
/** How many rows to hand the agents (keeps the prompt compact + the call fast). */
const MAX_CONTEXT_ROWS = Number(process.env.POSTDISPATCH_MAX_ROWS ?? "40");

export interface PostDispatchInput {
  question: string;
  results: DispatchResult[];
  /** Deterministic analytics already computed by the caller — handed to the agents as trusted rollups. */
  analytics: AnalyticsResult;
}

/** What the agents produced; folded into the FinalReport by the caller. */
export interface PostDispatchOutput {
  /** Report agent's executive summary (overrides the deterministic summary). */
  summary?: string;
  /** Analytics agent's derived insights (merged into the report's highlights). */
  insights: string[];
  /** Which backend's policy ran, for tracing. */
  backendId: string;
}

/** Agents run only with a real model AND outside hermetic mock mode (tests/local stay deterministic). */
function agentsEnabled(): boolean {
  if ((process.env.POSTDISPATCH_AGENTS ?? "").toLowerCase() === "false") return false;
  if ((process.env.GATEWAY_MOCK ?? "").toLowerCase() === "true") return false;
  return postDispatchModelConfigured();
}

/**
 * The first successful gateway dispatch to branch on, identified by `meta.backendId` — NOT by
 * `type === "Gateway"`. Fedline's gateway operations share ids with static USE_CASES, so the supervisor
 * parser (coerceResults) re-types those results from "Gateway" to their static domain (EDD/XShip/…);
 * `meta.backendId` is set by the proxy in every path and survives that coercion, so it's the reliable
 * signal that a result came from a registered backend.
 */
function primaryGatewayResult(results: DispatchResult[]): DispatchResult | undefined {
  return results.find(
    (r) => r.status === "ok" && typeof r.meta?.backendId === "string" && r.meta.backendId,
  );
}

/** Compact context handed to both agents: question + which op ran + a row sample + the exact rollups. */
function buildContext(input: PostDispatchInput, gw: DispatchResult, insights?: string[]): Record<string, unknown> {
  const rows = gw.data.slice(0, MAX_CONTEXT_ROWS);
  return {
    question: input.question,
    backendId: gw.meta.backendId,
    operationId: gw.useCase,
    rowCount: gw.data.length,
    rowsTruncated: gw.data.length > rows.length,
    rows,
    deterministicAnalytics: input.analytics.metrics[`${gw.type}:${gw.useCase}`] ?? input.analytics.aggregate,
    aggregate: input.analytics.aggregate,
    ...(insights ? { insights } : {}),
  };
}

/** Parse the analytics agent's reply into insight strings: a JSON array first, else non-empty lines. */
function parseInsights(raw: string): string[] {
  const text = raw.trim();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  } catch {
    // Not JSON — fall through to line parsing.
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function runAgents(
  agents: PostDispatchAgentSpec[],
  input: PostDispatchInput,
  gw: DispatchResult,
): Promise<PostDispatchOutput> {
  const backendId = String(gw.meta.backendId);
  const analyticsSpec = agents.find((a) => a.role === "analytics");
  const reportSpec = agents.find((a) => a.role === "report");

  // 1) Ephemeral analytics agent: derive insights over the rows + trusted rollups.
  let insights: string[] = [];
  if (analyticsSpec) {
    const raw = await runDynamicAgent(analyticsSpec, buildContext(input, gw));
    insights = parseInsights(raw);
  }

  // 2) Ephemeral report agent: transform the insights + aggregates into an executive summary.
  let summary: string | undefined;
  if (reportSpec) {
    summary = (await runDynamicAgent(reportSpec, buildContext(input, gw, insights))).trim() || undefined;
  }

  return { summary, insights, backendId };
}

/** Reject if the agent sequence outruns the budget, so the caller degrades within the HTTP deadline. */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`post-dispatch exceeded ${ms}ms budget`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run the target backend's post-dispatch policy. Returns the agents' output, or `undefined` when the
 * policy is passthrough/absent, no Gateway result is present, agents are disabled, or anything fails —
 * in every `undefined` case the caller keeps its existing deterministic analytics+report behavior.
 */
export async function runPostDispatch(input: PostDispatchInput): Promise<PostDispatchOutput | undefined> {
  const gw = primaryGatewayResult(input.results);
  if (!gw) return undefined; // not a Gateway dispatch → unchanged deterministic path

  const backendId = String(gw.meta.backendId);
  let policy: PostDispatchPolicy | undefined;
  try {
    policy = (await getBackend(backendId))?.postDispatch;
  } catch (err) {
    log.warn("could not load backend policy; deterministic fallback", { backendId, error: String(err) });
    return undefined;
  }

  if (!policy || policy.mode !== "agents" || !policy.agents?.length) return undefined; // passthrough
  if (!agentsEnabled()) {
    log.info("post-dispatch agents disabled; deterministic report", { backendId });
    return undefined;
  }

  try {
    const out = await withBudget(runAgents(policy.agents, input, gw), BUDGET_MS);
    log.info("post-dispatch agents completed", { backendId, insights: out.insights.length, hasSummary: Boolean(out.summary) });
    return out;
  } catch (err) {
    log.warn("post-dispatch agents failed; deterministic fallback", { backendId, error: String(err) });
    return undefined;
  }
}
