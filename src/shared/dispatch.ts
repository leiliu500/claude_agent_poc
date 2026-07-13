/**
 * Executes a single task against the (mock) backend and shapes a DispatchResult.
 *
 * Shared by:
 *   - the action-group Lambdas (the agents call these), and
 *   - the local orchestration mode in the API entrypoint.
 *
 * This is the deterministic "do the work" layer; the agents decide *which* work.
 */
import type { DispatchResult, TaskParams, TaskRequest } from "./types.js";
import { getUseCase, resolveEndpoint } from "./usecases.js";
import { generateMock } from "../mock/data.js";
import { runKbQuery } from "./kb.js";
import { invokeBackend } from "./gateway/invoke.js";

export async function executeTask(task: TaskRequest): Promise<DispatchResult> {
  const start = hrMs();

  // Gateway (Agentic API Gateway): route to a registered backend via the generic HTTP proxy. Gateway
  // ops are NOT in the static USE_CASES registry — the task's useCase is a backend operationId and
  // params.backendId names the target app. Handle before getUseCase (which only knows report types).
  if (task.type === "Gateway") {
    return invokeBackend({
      backendId: String(task.params.backendId ?? ""),
      operationId: task.useCase,
      params: task.params,
    });
  }

  const spec = getUseCase(task.useCase);
  if (!spec) {
    return {
      type: task.type,
      useCase: task.useCase,
      status: "error",
      data: [],
      meta: {},
      error: `Unknown use case '${task.useCase}'`,
      latencyMs: hrMs() - start,
    };
  }
  if (spec.type !== task.type) {
    return {
      type: task.type,
      useCase: task.useCase,
      status: "error",
      data: [],
      meta: {},
      error: `Use case '${task.useCase}' belongs to type '${spec.type}', not '${task.type}'`,
      latencyMs: hrMs() - start,
    };
  }
  // KB (knowledge base / RAG) is answered in-process against the pgvector store (or the in-memory
  // corpus), not via a mock REST backend — short-circuit before generateMock/resolveEndpoint.
  if (task.type === "KB") {
    try {
      const kb = await runKbQuery({
        query: typeof task.params.query === "string" ? task.params.query : "",
        topK: typeof task.params.topK === "number" ? task.params.topK : undefined,
      });
      return {
        type: task.type,
        useCase: task.useCase,
        status: "ok",
        // Rows = the cited passages (render as a citations table); scalar answer lives in meta.
        data: kb.passages.map((p) => ({
          title: p.title,
          source: p.sourceUri ?? "",
          score: p.score,
          snippet: p.content.length > 240 ? p.content.slice(0, 237) + "…" : p.content,
        })),
        meta: {
          label: spec.label,
          answer: kb.answer,
          citations: kb.citations,
          query: task.params.query ?? "",
          matched: kb.passages.length,
          retrieval: kb.source,
        },
        latencyMs: hrMs() - start,
      };
    } catch (err) {
      return {
        type: task.type,
        useCase: task.useCase,
        status: "error",
        data: [],
        meta: {},
        error: err instanceof Error ? err.message : String(err),
        latencyMs: hrMs() - start,
      };
    }
  }

  try {
    const payload = generateMock(task.useCase, task.params);
    // Resolve the exact backend REST endpoint this use case maps to. A real client would call
    // `endpoint.method endpoint.url`; the mock layer stands in for that call today.
    const endpoint = resolveEndpoint(task.useCase, task.params);
    return {
      type: task.type,
      useCase: task.useCase,
      status: "ok",
      data: payload.rows,
      meta: {
        ...payload.meta,
        label: spec.label,
        exportable: spec.exportable,
        ...(endpoint
          ? {
              endpoint: endpoint.url,
              httpMethod: endpoint.method,
              ...(endpoint.missing.length ? { endpointMissingParams: endpoint.missing } : {}),
            }
          : {}),
      },
      latencyMs: hrMs() - start,
    };
  } catch (err) {
    return {
      type: task.type,
      useCase: task.useCase,
      status: "error",
      data: [],
      meta: {},
      error: err instanceof Error ? err.message : String(err),
      latencyMs: hrMs() - start,
    };
  }
}

/** Execute many tasks, preserving order. Orchestration entrypoint for the agent layer. */
export async function executeTasks(tasks: TaskRequest[]): Promise<DispatchResult[]> {
  // Independent tasks → run concurrently.
  return Promise.all(tasks.map(executeTask));
}

/** Coerce loosely-typed agent/JSON params into our TaskParams shape. */
export function coerceParams(raw: unknown): TaskParams {
  if (!raw || typeof raw !== "object") return {};
  const out: TaskParams = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else out[k] = v;
  }
  return out;
}

function hrMs(): number {
  // performance.now is available in the Lambda Node 20 runtime.
  return Math.round(performance.now());
}
