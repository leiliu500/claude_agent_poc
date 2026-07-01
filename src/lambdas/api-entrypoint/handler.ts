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
import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import type { AskRequest, AskResponse, AuthContext, FinalReport } from "../../shared/types.js";
import { orchestrate } from "../../shared/orchestrator.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { invokeFlow } from "../../shared/bedrock.js";
import { createLogger } from "../../shared/logger.js";
import { toErrorBody, ValidationError } from "../../shared/errors.js";

/** Shape of the context our auth-authorizer Lambda attaches (all values are strings). */
interface AuthorizerLambdaContext {
  userId?: string;
  userName?: string;
  username?: string;
  /** JSON-encoded identifiers map. */
  ids?: string;
}

type AskEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerLambdaContext>;

const log = createLogger({ mod: "api-entrypoint" });

function traceId(event: AskEvent): string {
  return (
    event.requestContext?.requestId ??
    event.headers?.["x-amzn-trace-id"] ??
    `trace-${Math.round(performance.now())}`
  );
}

function parseBody(event: AskEvent): AskRequest {
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

/**
 * Read the authenticated caller from the API-Gateway Lambda authorizer's context. The authorizer
 * has already verified the token signature + expiry, so an authorized request reaching here always
 * carries a userId. Returns undefined only when the route is unauthenticated (no authorizer wired).
 */
function readAuthContext(event: AskEvent): AuthContext | undefined {
  const ctx = event.requestContext?.authorizer?.lambda;
  if (!ctx || !ctx.userId) return undefined;
  let identifiers: Record<string, string> = {};
  try {
    identifiers = ctx.ids ? (JSON.parse(ctx.ids) as Record<string, string>) : {};
  } catch {
    identifiers = {};
  }
  return { userId: ctx.userId, userName: ctx.userName ?? ctx.username ?? "", identifiers };
}

/** Deterministic, in-process equivalent of the whole flow (identity → orchestrate → report). */
async function runLocal(question: string, auth?: AuthContext): Promise<FinalReport> {
  const { type, results } = await orchestrate(question, auth);
  const analytics = runAnalytics(results);
  return generateReport({
    question,
    type,
    dispatchResults: results,
    analytics,
    generatedAt: new Date().toISOString(),
  });
}

/** Produce the final report via the Bedrock Flow, falling back to local on failure. */
async function produceReport(question: string, auth?: AuthContext): Promise<FinalReport> {
  const mode = (process.env.ORCHESTRATION_MODE ?? "agent").toLowerCase();
  const flowId = process.env.FLOW_ID;
  const flowAliasId = process.env.FLOW_ALIAS_ID;

  if (mode === "local" || !flowId || !flowAliasId) {
    if (mode !== "local") log.warn("flow not configured; using local pipeline");
    return runLocal(question, auth);
  }

  // Bound the flow wait so a slow multi-agent dispatch degrades to the local pipeline within the
  // synchronous HTTP deadline (API Gateway HTTP APIs hard-cap at 30s) instead of returning 503.
  const timeoutMs = Number(process.env.FLOW_TIMEOUT_MS ?? "24000");

  try {
    // The authenticated identity + resolved IDs travel INTO the flow (document.auth) so the
    // flow-process node can orchestrate without re-parsing a name from the question.
    return await invokeFlow({ flowId, flowAliasId, question, auth, timeoutMs });
  } catch (err) {
    log.warn("flow invocation failed or timed out; falling back to local pipeline", { error: String(err) });
    return runLocal(question, auth);
  }
}

export const handler = async (event: AskEvent): Promise<APIGatewayProxyResultV2> => {
  const trace = traceId(event);
  const reqLog = log.child({ trace });
  try {
    const { question } = parseBody(event);

    // Identity comes from the verified session token (via the authorizer context), not the question
    // text. If the authorizer is wired (production), an unauthenticated request never reaches here;
    // readAuthContext returning undefined means the route is running without an authorizer (e.g.
    // local dev), in which case orchestrate falls back to name-in-question resolution.
    const auth = readAuthContext(event);
    reqLog.info("ask received", { question, userId: auth?.userId, authenticated: Boolean(auth) });

    const report = await produceReport(question, auth);

    reqLog.info("ask completed", { type: report.type, sections: report.sections.length });
    return respond(200, { ok: true, report, traceId: trace });
  } catch (err) {
    const e = toErrorBody(err);
    reqLog.error("ask failed", { code: e.code, message: e.message });
    return respond(e.statusCode, { ok: false, error: `${e.code}: ${e.message}`, traceId: trace });
  }
};
