/**
 * API Gateway (HTTP API) entrypoint.
 *
 *   POST /v1/ask  { question, sessionId? }  ->  { ok, report, traceId }
 *
 * Best-practice topology: the supervisor agent is a node INSIDE the Bedrock Flow, so this
 * entrypoint's job is just transport + a single InvokeFlow call.
 *
 * Two orchestration modes (env ORCHESTRATION_MODE):
 *   - "agent" (prod): InvokeFlow(supervisor → dispatch → analytics → report).
 *   - "local" (test): deterministic router → in-process dispatch/analytics/report
 *                     (mirrors the flow nodes; no AWS needed).
 *
 * Agent mode degrades gracefully: if the flow invocation fails, it falls back to local.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { AskRequest, AskResponse, FinalReport } from "../../shared/types.js";
import { route } from "../../shared/router.js";
import { executeTasks } from "../../shared/dispatch.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { invokeFlow } from "../../shared/bedrock.js";
import { createLogger } from "../../shared/logger.js";
import { toErrorBody, ValidationError } from "../../shared/errors.js";

const log = createLogger({ mod: "api-entrypoint" });

function traceId(event: APIGatewayProxyEventV2): string {
  return (
    event.requestContext?.requestId ??
    event.headers?.["x-amzn-trace-id"] ??
    `trace-${Math.round(performance.now())}`
  );
}

function parseBody(event: APIGatewayProxyEventV2): AskRequest {
  let raw = event.body ?? "{}";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
  const body = parsed as Partial<AskRequest>;
  if (!body.question || typeof body.question !== "string" || !body.question.trim()) {
    throw new ValidationError("Field 'question' is required.");
  }
  return { question: body.question.trim(), sessionId: body.sessionId };
}

function respond(statusCode: number, body: AskResponse): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Deterministic, in-process equivalent of the whole flow (router → ... → report). */
async function runLocal(question: string): Promise<FinalReport> {
  const decision = route(question);
  const results = await executeTasks(decision.tasks);
  const analytics = runAnalytics(results);
  return generateReport({
    question,
    type: decision.type,
    dispatchResults: results,
    analytics,
    generatedAt: new Date().toISOString(),
  });
}

/** Produce the final report via the Bedrock Flow, falling back to local on failure. */
async function produceReport(question: string): Promise<FinalReport> {
  const mode = (process.env.ORCHESTRATION_MODE ?? "agent").toLowerCase();
  const flowId = process.env.FLOW_ID;
  const flowAliasId = process.env.FLOW_ALIAS_ID;

  if (mode === "local" || !flowId || !flowAliasId) {
    if (mode !== "local") log.warn("flow not configured; using local pipeline");
    return runLocal(question);
  }

  try {
    return await invokeFlow({ flowId, flowAliasId, question });
  } catch (err) {
    log.warn("flow invocation failed; falling back to local pipeline", { error: String(err) });
    return runLocal(question);
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const trace = traceId(event);
  const reqLog = log.child({ trace });
  try {
    const { question } = parseBody(event);
    reqLog.info("ask received", { question });

    const report = await produceReport(question);

    reqLog.info("ask completed", { type: report.type, sections: report.sections.length });
    return respond(200, { ok: true, report, traceId: trace });
  } catch (err) {
    const e = toErrorBody(err);
    reqLog.error("ask failed", { code: e.code, message: e.message });
    return respond(e.statusCode, { ok: false, error: `${e.code}: ${e.message}`, traceId: trace });
  }
};
