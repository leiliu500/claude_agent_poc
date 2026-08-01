/**
 * In-code LLM router — the reliable "agent actually drives" seam.
 *
 * WHY: in production the Bedrock Supervisor agent node returns short natural-language text, not the
 * strict {type,tasks,dispatchResults} contract supervisor-parse.ts expects, so every request silently
 * fell back to the deterministic keyword router (regex). This module makes the LLM drive routing in a
 * way that CANNOT silently no-op: it calls the same Bedrock Converse model the post-dispatch agents use
 * (POSTDISPATCH_MODEL) with a CONSTRAINED task — pick one operation id from a fixed MENU and extract its
 * params — then VALIDATES the pick against the real use-case catalog. Anything the model gets wrong
 * (unknown id, no JSON, timeout, model unavailable) returns undefined and the caller uses the
 * deterministic router. So: LLM decides when it can, deterministic router is the safety net, and every
 * fallback is logged (never silent).
 *
 * Reliability choices vs. the old contract:
 *   - The model chooses from an ENUMERATED menu of ids (closed set), not free-form JSON — far easier to
 *     emit correctly and trivially validatable.
 *   - Deterministic param extraction (router.extractParams) is layered OVER the model's params, so
 *     reliably-parseable values (ISO dates, ids) win and the model only fills genuine gaps.
 */
import type { RoutingDecision, TaskParams, TaskRequest } from "./types.js";
import { USE_CASES, getUseCase } from "./usecases.js";
import { extractParams } from "./router.js";
import { extractLastJsonObject } from "./supervisor-parse.js";
import { converseText, postDispatchModelConfigured } from "./postdispatch/agent.js";
import { createLogger } from "./logger.js";
// The routing instruction lives as editable Markdown prose (loaded raw via the esbuild `.md` text
// loader / vitest md plugin), NOT inline — same convention as supervisor.md/gateway.md and the
// post-dispatch overlays. The dynamic MENU (buildMenu) is data and stays in code.
import routingPrompt from "../agents/prompts/routing.md";

const log = createLogger({ mod: "llm-router" });

// POSTDISPATCH_MODEL is a reasoning model (openai.gpt-oss-*): it emits a chain-of-thought block that
// consumes tokens BEFORE the JSON answer, so the budget must cover reasoning + the answer, and the
// timeout must cover ~5s of generation. Measured: full 19-op menu routes correctly in ~5s at 1500 tokens.
const TIMEOUT_MS = Number(process.env.LLM_ROUTER_TIMEOUT_MS ?? "10000");
const MAX_TOKENS = Number(process.env.LLM_ROUTER_MAX_TOKENS ?? "1500");

/**
 * Enabled only with a real model AND outside hermetic mock mode (mirrors post-dispatch agentsEnabled),
 * and can be force-disabled with LLM_ROUTER=false. When disabled, callers use the deterministic router.
 */
export function llmRouterEnabled(): boolean {
  if ((process.env.LLM_ROUTER ?? "").toLowerCase() === "false") return false;
  if ((process.env.GATEWAY_MOCK ?? "").toLowerCase() === "true") return false;
  return postDispatchModelConfigured();
}

/** The closed menu of operations the model may choose from (every static use case). */
function buildMenu(): string {
  return USE_CASES.map((uc) => {
    const params = uc.params.map((p) => p.name).join(", ") || "none";
    return `- ${uc.id} (${uc.type}): ${uc.description} [params: ${params}]`;
  }).join("\n");
}

const SYSTEM = routingPrompt.trim();

interface LlmTask {
  useCase?: unknown;
  params?: unknown;
}

/** Validate one model-proposed task against the catalog; returns a typed TaskRequest or undefined. */
function toTask(raw: LlmTask, question: string): TaskRequest | undefined {
  const useCase = typeof raw.useCase === "string" ? raw.useCase : undefined;
  if (!useCase) return undefined;
  const spec = getUseCase(useCase);
  if (!spec) {
    log.warn("llm router proposed an unknown useCase; dropping", { useCase });
    return undefined;
  }
  // Deterministic extraction wins over the model's params (regex is reliable for dates/ids); the model
  // only fills gaps it uniquely understood. KB always routes the raw question as its query.
  const llmParams = (raw.params && typeof raw.params === "object" ? raw.params : {}) as TaskParams;
  const params: TaskParams = { ...llmParams, ...extractParams(question) };
  if (spec.type === "KB" && !params.query) params.query = question;
  return { type: spec.type, useCase: spec.id, params };
}

/**
 * Route a question with the LLM. Returns a validated RoutingDecision, or undefined to signal the caller
 * to fall back to the deterministic router (disabled, model failure, no JSON, or no valid task).
 */
export async function llmRoute(question: string): Promise<RoutingDecision | undefined> {
  if (!llmRouterEnabled()) return undefined;

  let raw: string;
  try {
    raw = await converseText(SYSTEM, `MENU:\n${buildMenu()}\n\nQUESTION: ${question}`, {
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    log.warn("llm router call failed; deterministic fallback", { error: String(err) });
    return undefined;
  }

  const block = extractLastJsonObject(raw);
  if (!block) {
    log.warn("llm router: no JSON object in model output; deterministic fallback", { chars: raw.length });
    return undefined;
  }
  let obj: { tasks?: unknown; useCase?: unknown; params?: unknown; confidence?: unknown };
  try {
    obj = JSON.parse(block);
  } catch {
    log.warn("llm router: unparseable JSON; deterministic fallback");
    return undefined;
  }

  // Accept either {tasks:[...]} or a bare {useCase,params}.
  const items: LlmTask[] = Array.isArray(obj.tasks)
    ? (obj.tasks as LlmTask[])
    : typeof obj.useCase === "string"
      ? [{ useCase: obj.useCase, params: obj.params }]
      : [];
  const tasks = items.map((t) => toTask(t, question)).filter((t): t is TaskRequest => Boolean(t));
  if (tasks.length === 0) {
    log.info("llm router selected no valid operation; deterministic fallback");
    return undefined;
  }

  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.9;
  log.info("llm router selected", { tasks: tasks.map((t) => t.useCase), type: tasks[0]!.type, confidence });
  return {
    type: tasks[0]!.type,
    tasks,
    requiresOrchestration: tasks.length > 1,
    confidence,
    rationale: `LLM router selected ${tasks.map((t) => t.useCase).join(", ")} (confidence ${confidence.toFixed(2)}).`,
  };
}
