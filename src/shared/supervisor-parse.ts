/**
 * Tolerant parser for the Supervisor agent's completion text.
 *
 * The supervisor is instructed (src/agents/prompts/supervisor.txt) to end its reply with a
 * single JSON object:
 *   { "type": AgentType, "tasks": TaskRequest[], "dispatchResults": DispatchResult[] }
 *
 * LLM output is rarely perfectly clean, so we extract the last balanced JSON object from the
 * text and validate it loosely. Anything missing is returned empty so the caller can fall back.
 */
import type { AgentType, DispatchResult, TaskRequest } from "./types.js";
import { AGENT_TYPES } from "./types.js";
import { getUseCase } from "./usecases.js";

export interface SupervisorOutput {
  type: AgentType;
  tasks: TaskRequest[];
  dispatchResults: DispatchResult[];
}

/** Find the last top-level balanced { ... } block in a string. */
export function extractLastJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
    }
  }
  return last;
}

function isAgentType(v: unknown): v is AgentType {
  return typeof v === "string" && (AGENT_TYPES as readonly string[]).includes(v);
}

function coerceTasks(raw: unknown, fallbackType: AgentType): TaskRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskRequest[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const useCase = typeof o.useCase === "string" ? o.useCase : undefined;
    if (!useCase) continue;
    const spec = getUseCase(useCase);
    // Gateway tasks are data-driven: the useCase is a registered backend operationId, not a static
    // USE_CASE. Accept them by their declared type "Gateway" (with backendId carried in params).
    const type = spec ? spec.type : isAgentType(o.type) && o.type === "Gateway" ? "Gateway" : undefined;
    if (!type) continue;
    out.push({
      type,
      useCase,
      params: (o.params && typeof o.params === "object" ? (o.params as Record<string, unknown>) : {}),
    });
  }
  void fallbackType;
  return out;
}

function coerceResults(raw: unknown): DispatchResult[] {
  if (!Array.isArray(raw)) return [];
  const out: DispatchResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const useCase = typeof o.useCase === "string" ? o.useCase : undefined;
    if (!useCase) continue;
    const spec = getUseCase(useCase);
    // Gateway results carry a backend operationId (not a static USE_CASE) — accept by declared type.
    const type = spec ? spec.type : isAgentType(o.type) && o.type === "Gateway" ? "Gateway" : undefined;
    if (!type) continue;
    out.push({
      type,
      useCase,
      status: o.status === "error" ? "error" : "ok",
      data: Array.isArray(o.data) ? (o.data as Record<string, unknown>[]) : [],
      meta: o.meta && typeof o.meta === "object" ? (o.meta as Record<string, unknown>) : {},
      ...(typeof o.error === "string" ? { error: o.error } : {}),
      latencyMs: typeof o.latencyMs === "number" ? o.latencyMs : 0,
    });
  }
  return out;
}

export function parseSupervisorOutput(completion: string): SupervisorOutput {
  const empty: SupervisorOutput = { type: "EDD", tasks: [], dispatchResults: [] };
  const block = extractLastJsonObject(completion);
  if (!block) return empty;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(block) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const results = coerceResults(obj.dispatchResults);
  const tasks = coerceTasks(obj.tasks, "EDD");

  // Determine type: explicit field, else from results/tasks.
  let type: AgentType = "EDD";
  if (isAgentType(obj.type)) type = obj.type;
  else if (results[0]) type = results[0].type;
  else if (tasks[0]) type = tasks[0].type;

  return { type, tasks, dispatchResults: results };
}
