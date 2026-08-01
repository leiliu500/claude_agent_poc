/**
 * Gateway discovery AGENT (Layer 2) — an LLM agent whose system prompt IS gateway.md.
 *
 * Layer 1 (the router) only decides that a request targets an application. THIS agent does the
 * "further decouple → retrieve → invoke" step the two-layer design calls for: it (1) semantically
 * RETRIEVES candidate backend operations from the registry, then (2) uses gateway.md to CHOOSE the best
 * operation and extract its params (validated against the candidates); the caller then invokes it. So a
 * newly-registered app becomes reachable with no code change — the agent discovers it at runtime.
 *
 * Deterministic fallback: with no model configured (or on any LLM failure / bad pick) it falls back to
 * the top retrieval candidate, so tests / local mode stay hermetic and the gateway still resolves.
 */
import gatewayPrompt from "../../agents/prompts/gateway.md";
import { retrieveOperations } from "./registry.js";
import { converseText, postDispatchModelConfigured } from "../postdispatch/agent.js";
import { extractLastJsonObject } from "../supervisor-parse.js";
import { createLogger } from "../logger.js";
import type { OperationMatch } from "./types.js";

const log = createLogger({ mod: "gateway-agent" });

const TIMEOUT_MS = Number(process.env.GATEWAY_AGENT_TIMEOUT_MS ?? "8000");
const MAX_TOKENS = Number(process.env.GATEWAY_AGENT_MAX_TOKENS ?? "1500");
const TOP_K = Number(process.env.GATEWAY_AGENT_TOPK ?? "6");
const MODEL = process.env.POSTDISPATCH_MODEL ?? process.env.FOUNDATION_MODEL ?? undefined;

/** The gateway agent's discovery decision, for invocation + the execution-path trace. */
export interface GatewayDiscovery {
  backendId: string;
  operationId: string;
  params: Record<string, unknown>;
  /** LLM self-reported confidence, or the retrieval score on the deterministic fallback. */
  confidence: number;
  /** "llm" when gateway.md drove the pick; "proxy" when it fell back to the top retrieval candidate. */
  engine: "llm" | "proxy";
  model?: string;
  latencyMs: number;
  candidateCount: number;
}

/** Enabled only with a real model AND outside hermetic mock mode; force off with GATEWAY_AGENT=false. */
function agentEnabled(): boolean {
  if ((process.env.GATEWAY_AGENT ?? "").toLowerCase() === "false") return false;
  if ((process.env.GATEWAY_MOCK ?? "").toLowerCase() === "true") return false;
  return postDispatchModelConfigured();
}

/** Render the retrieved candidates as the operation menu the agent chooses from. */
function candidateMenu(cands: OperationMatch[]): string {
  return cands
    .map((c, i) => {
      const params = (c.operation.params ?? []).map((p) => p.name).join(", ") || "none";
      return `${i + 1}. backendId=${c.backendId} operationId=${c.operation.operationId} ` +
        `[${c.operation.method} ${c.operation.path}] score=${c.score.toFixed(3)}\n` +
        `   summary: ${c.operation.summary ?? ""}\n   params: ${params}`;
    })
    .join("\n");
}

/**
 * Discover the backend operation that serves `question`. Returns the chosen backendId/operationId +
 * extracted params, or undefined when nothing is registered/matches (caller falls back to static
 * routing). Never throws.
 */
export async function discoverOperation(
  question: string,
  identifiers: Record<string, string>,
): Promise<GatewayDiscovery | undefined> {
  const start = performance.now();

  let candidates: OperationMatch[];
  try {
    candidates = await retrieveOperations(question, TOP_K);
  } catch (err) {
    log.warn("gateway retrieve failed; no discovery", { error: String(err) });
    return undefined;
  }
  if (!candidates.length) return undefined;

  const top = candidates[0]!;
  const fallback = (): GatewayDiscovery => ({
    backendId: top.backendId,
    operationId: top.operation.operationId,
    params: { ...identifiers },
    confidence: top.score,
    engine: "proxy",
    latencyMs: Math.round(performance.now() - start),
    candidateCount: candidates.length,
  });

  if (!agentEnabled()) return fallback();

  let raw: string;
  try {
    raw = await converseText(
      gatewayPrompt.trim(),
      `CANDIDATES:\n${candidateMenu(candidates)}\n\nQUESTION: ${question}`,
      { maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
    );
  } catch (err) {
    log.warn("gateway agent call failed; top-candidate fallback", { error: String(err) });
    return fallback();
  }

  const block = extractLastJsonObject(raw);
  if (!block) {
    log.warn("gateway agent: no JSON in output; top-candidate fallback");
    return fallback();
  }
  let obj: { backendId?: unknown; operationId?: unknown; params?: unknown; confidence?: unknown };
  try {
    obj = JSON.parse(block);
  } catch {
    log.warn("gateway agent: unparseable JSON; top-candidate fallback");
    return fallback();
  }

  const operationId = typeof obj.operationId === "string" ? obj.operationId : undefined;
  if (!operationId) {
    log.info("gateway agent selected no operation");
    return undefined;
  }
  const match = candidates.find((c) => c.operation.operationId === operationId);
  if (!match) {
    log.warn("gateway agent picked an operation not in the candidates; top-candidate fallback", { operationId });
    return fallback();
  }

  const llmParams = obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : {};
  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : match.score;
  log.info("gateway agent selected", { backendId: match.backendId, operationId, confidence });
  return {
    backendId: match.backendId,
    operationId,
    // Caller-provided identifiers first, then the agent's extracted params (agent wins on conflicts —
    // it read the specific request; identifiers fill the gaps).
    params: { ...identifiers, ...llmParams },
    confidence,
    engine: "llm",
    model: MODEL,
    latencyMs: Math.round(performance.now() - start),
    candidateCount: candidates.length,
  };
}
