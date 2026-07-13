/**
 * Agentic API Gateway collaborator action group.
 *
 * The supervisor's Gateway collaborator calls POST /run with one of two use cases:
 *   - gatewayRetrieve { query, topK? } → returns the registered backend operations most relevant to
 *     the question (backendId, operationId, method, path, summary, score). The agent picks one.
 *   - gatewayInvoke   { backendId, operationId, ...params } → calls that operation through the generic
 *     HTTP proxy and returns a DispatchResult (data = response rows, meta = url/httpStatus).
 *
 * This is the only action-group Lambda whose "use cases" are data-driven (any registered backend),
 * not fixed in usecases.ts — so it can't reuse makeActionGroupHandler. Runs in the DB VPC to reach
 * pgvector (retrieval) + Bedrock embeddings; outbound proxy calls need the target to be VPC-reachable.
 */
import type { DispatchResult } from "../../../shared/types.js";
import { envelope, parseInput, type BedrockActionEvent, type BedrockActionResponse } from "../../../shared/action-group.js";
import { coerceParams } from "../../../shared/dispatch.js";
import { retrieveOperations } from "../../../shared/gateway/registry.js";
import { invokeBackend } from "../../../shared/gateway/invoke.js";
import { createLogger } from "../../../shared/logger.js";

const log = createLogger({ mod: "action-gateway" });

/**
 * Direct-invoke (NON-Bedrock) shape for a FILE SUBMIT. The api-entrypoint invokes this Lambda with a
 * file the chat UI attached — the file bytes travel here (a VPC Lambda with DB + Bedrock reach) rather
 * than through the supervisor LLM. We retrieve the best file-upload operation for the question and
 * invoke it through the generic proxy with the payload + file. Returns a plain DispatchResult.
 */
interface GatewaySubmitEvent {
  mode: "submit";
  question: string;
  file: { name: string; contentBase64: string };
  /** SCP-style control block, as an object or a JSON string. */
  payload?: Record<string, unknown> | string;
  /** Caller identifiers (from the session token) merged under the payload for path/query params. */
  identifiers?: Record<string, string>;
}

interface GatewaySubmitResult {
  ok: boolean;
  result?: DispatchResult;
  error?: string;
}

async function handleSubmit(e: GatewaySubmitEvent): Promise<GatewaySubmitResult> {
  const content = Buffer.from(e.file?.contentBase64 ?? "", "base64").toString("utf8");
  if (!content) return { ok: false, error: "Empty or missing file content." };

  let payloadObj: Record<string, unknown> = {};
  if (typeof e.payload === "string" && e.payload.trim()) {
    try {
      payloadObj = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "The payload field is not valid JSON." };
    }
  } else if (e.payload && typeof e.payload === "object") {
    payloadObj = e.payload;
  }

  // Find the best-matching operation that actually accepts a file upload.
  const matches = await retrieveOperations(e.question || "file upload", 5);
  const fileOp = matches.find((m) => m.operation.params.some((p) => p.in === "file"));
  if (!fileOp) {
    return { ok: false, error: "No registered file-upload operation matches this request." };
  }

  const params = {
    ...(e.identifiers ?? {}),
    ...payloadObj,
    payload: payloadObj, // single JSON form field (SCP's control block)
    file: content,
    filename: e.file.name,
  };
  log.info("gateway submit", { backendId: fileOp.backendId, operationId: fileOp.operation.operationId, filename: e.file.name, bytes: content.length });
  const result = await invokeBackend({ backendId: fileOp.backendId, operationId: fileOp.operation.operationId, params });
  return { ok: result.status === "ok", result };
}

export const handler = async (
  event: BedrockActionEvent | GatewaySubmitEvent,
): Promise<BedrockActionResponse | GatewaySubmitResult> => {
  // Direct-invoke file submit (from the api-entrypoint) — not a Bedrock action-group event.
  if ((event as GatewaySubmitEvent).mode === "submit") {
    return handleSubmit(event as GatewaySubmitEvent);
  }

  const ev = event as BedrockActionEvent;
  const { useCase, params } = parseInput(ev);
  log.info("gateway action-group invoked", { useCase, actionGroup: ev.actionGroup });

  if (useCase === "gatewayRetrieve") {
    const q = typeof params.query === "string" ? params.query : "";
    const topK = typeof params.topK === "number" ? params.topK : undefined;
    const matches = await retrieveOperations(q, topK);
    return envelope(ev, 200, {
      type: "Gateway",
      useCase: "gatewayRetrieve",
      status: "ok",
      data: matches.map((m) => ({
        backendId: m.backendId,
        backendName: m.backendName,
        operationId: m.operation.operationId,
        method: m.operation.method,
        path: m.operation.path,
        summary: m.operation.summary ?? "",
        requiredParams: m.operation.params.filter((p) => p.required).map((p) => p.name),
        score: m.score,
      })),
      meta: { query: q, matched: matches.length },
      latencyMs: 0,
    });
  }

  if (useCase === "gatewayInvoke") {
    const backendId = typeof params.backendId === "string" ? params.backendId : "";
    const operationId = typeof params.operationId === "string" ? params.operationId : "";
    if (!backendId || !operationId) {
      return envelope(ev, 400, { status: "error", error: "gatewayInvoke requires 'backendId' and 'operationId'." });
    }
    const result = await invokeBackend({ backendId, operationId, params: coerceParams(params) });
    return envelope(ev, result.status === "ok" ? 200 : 502, result);
  }

  return envelope(ev, 422, {
    status: "error",
    error: `Unknown gateway use case '${useCase}'. Expected 'gatewayRetrieve' or 'gatewayInvoke'.`,
  });
};
