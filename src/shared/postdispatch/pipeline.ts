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
import type { BackendOperation, PostDispatchAgentSpec, PostDispatchPolicy } from "../gateway/types.js";

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

/** The invoked operation's id — prefer the proxy-stamped meta, fall back to the result's useCase. */
function operationIdOf(gw: DispatchResult): string {
  return String(gw.meta?.operationId ?? gw.useCase ?? "");
}

/** Baseline API tailoring for an operation with no authored overlay: its own OpenAPI summary/description. */
function autoOverlay(op?: BackendOperation): string | undefined {
  if (!op) return undefined;
  const text = [op.summary, op.description].filter(Boolean).join(" — ");
  return text ? `OPERATION — ${text}` : undefined;
}

/**
 * Compose the effective system prompt for one ephemeral agent: the base role prompt plus the overlay
 * for the exact operation that was invoked. An authored per-operation overlay wins; otherwise the
 * operation's own summary/description provides a free baseline; otherwise the base prompt stands alone.
 * This is what turns the generic analytics/report agent into an API-specific one for a single call.
 */
function composePrompt(spec: PostDispatchAgentSpec, operationId: string, op?: BackendOperation): string {
  const overlay = spec.overlays?.[operationId] ?? autoOverlay(op);
  return overlay ? `${spec.prompt}\n\n${overlay}` : spec.prompt;
}

async function runAgents(
  agents: PostDispatchAgentSpec[],
  input: PostDispatchInput,
  gw: DispatchResult,
  op?: BackendOperation,
): Promise<PostDispatchOutput> {
  const backendId = String(gw.meta.backendId);
  const operationId = operationIdOf(gw);
  const analyticsSpec = agents.find((a) => a.role === "analytics");
  const reportSpec = agents.find((a) => a.role === "report");

  // 1) Ephemeral analytics agent: derive insights over the rows + trusted rollups. The base prompt is
  //    specialized to the invoked operation (per-operation overlay) for the length of this one call.
  let insights: string[] = [];
  if (analyticsSpec) {
    const spec = { ...analyticsSpec, prompt: composePrompt(analyticsSpec, operationId, op) };
    const raw = await runDynamicAgent(spec, buildContext(input, gw));
    insights = parseInsights(raw);
  }

  // 2) Ephemeral report agent: transform the insights + aggregates into an executive summary — also
  //    specialized to the invoked operation.
  let summary: string | undefined;
  if (reportSpec) {
    const spec = { ...reportSpec, prompt: composePrompt(reportSpec, operationId, op) };
    summary = (await runDynamicAgent(spec, buildContext(input, gw, insights))).trim() || undefined;
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
  let op: BackendOperation | undefined;
  try {
    const backend = await getBackend(backendId);
    policy = backend?.postDispatch;
    // The invoked operation drives per-operation prompt specialization (and the auto-overlay fallback).
    op = backend?.operations.find((o) => o.operationId === operationIdOf(gw));
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
    const out = await withBudget(runAgents(policy.agents, input, gw, op), BUDGET_MS);
    log.info("post-dispatch agents completed", { backendId, insights: out.insights.length, hasSummary: Boolean(out.summary) });
    return out;
  } catch (err) {
    log.warn("post-dispatch agents failed; deterministic fallback", { backendId, error: String(err) });
    return undefined;
  }
}
