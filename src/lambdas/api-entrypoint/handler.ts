/**
 * API Gateway (HTTP API) entrypoint.
 *
 *   POST /v1/ask       { question, sessionId? }   ->  { ok, report, traceId }
 *   POST /v1/backtest  { mode?, caseIds? }        ->  { ok, summary, traceId }
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
import type { AskFile, AskRequest, AskResponse, AuthContext, DispatchResult, FinalReport } from "../../shared/types.js";
import { extractBearer, verifyToken } from "../../shared/auth.js";
import { orchestrate } from "../../shared/orchestrator.js";
import { runAnalytics } from "../../shared/analytics.js";
import { generateReport } from "../../shared/report.js";
import { invokeFlow } from "../../shared/bedrock.js";
import { createLogger } from "../../shared/logger.js";
import { toErrorBody, ValidationError } from "../../shared/errors.js";
import { runBacktest } from "../../shared/backtest/run.js";
import type { BacktestMode, BacktestSummary } from "../../shared/backtest/types.js";

/** Max attached-file size, as base64 length (~5 MB of bytes → ~6.7 MB base64), under API Gateway's 10 MB cap. */
const MAX_FILE_B64 = 6_800_000;

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
  let file: AskFile | undefined;
  if (body.file) {
    if (typeof body.file.name !== "string" || typeof body.file.contentBase64 !== "string" || !body.file.contentBase64) {
      throw new ValidationError("Field 'file' must be { name, contentBase64 }.");
    }
    if (body.file.contentBase64.length > MAX_FILE_B64) {
      throw new ValidationError("Attached file is too large (max ~5 MB).");
    }
    file = { name: body.file.name, contentBase64: body.file.contentBase64 };
  }
  const payload = typeof body.payload === "string" ? body.payload : undefined;
  return { question: body.question.trim(), sessionId: body.sessionId, file, payload };
}

/**
 * Handle a file-bearing request: the attached file must NOT flow through the supervisor LLM, so we
 * invoke the VPC-enabled gateway Lambda directly (retrieve the file-upload operation + invoke it via
 * the generic proxy) and wrap its DispatchResult into a report. Bypasses the Bedrock flow entirely.
 */
async function runGatewaySubmit(question: string, file: AskFile, payload: string | undefined, auth?: AuthContext): Promise<FinalReport> {
  const fn = process.env.GATEWAY_FN;
  if (!fn) throw new ValidationError("File uploads are not configured on this deployment.");

  // Variable specifier so tsc doesn't require @aws-sdk/client-lambda's types at build time — the SDK
  // is provided by the Lambda runtime (external in the bundle), so it resolves at runtime.
  const lambdaMod = "@aws-sdk/client-lambda";
  const { LambdaClient, InvokeCommand } = (await import(lambdaMod)) as unknown as {
    LambdaClient: new (cfg: { region?: string }) => { send(cmd: unknown): Promise<{ Payload?: Uint8Array }> };
    InvokeCommand: new (input: unknown) => unknown;
  };
  const client = new LambdaClient({ region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION });
  const event = { mode: "submit", question, file, payload, identifiers: auth?.identifiers ?? {} };
  const res = await client.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(event)) }));
  const text = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
  const parsed = text ? (JSON.parse(text) as { ok?: boolean; result?: DispatchResult; error?: string }) : undefined;
  if (!parsed?.result) throw new ValidationError(parsed?.error ?? "The file submission could not be routed to a backend.");

  const result = parsed.result;
  const analytics = runAnalytics([result]);
  return generateReport({
    question,
    type: "Gateway",
    dispatchResults: [result],
    analytics,
    generatedAt: new Date().toISOString(),
  });
}

function respond(statusCode: number, body: AskResponse | BacktestResponse): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Response of POST /v1/backtest. */
interface BacktestResponse {
  ok: boolean;
  summary?: BacktestSummary;
  error?: string;
  traceId: string;
}

/**
 * The route this invocation is for. The two front doors carry the path in DIFFERENT fields:
 *   - API Gateway HTTP API (payload v2) → `requestContext.http.path` / `rawPath`
 *   - ALB Lambda target group           → `path` (there is no requestContext.http at all)
 * Both are checked, so a request reaching the same Lambda via either door routes identically.
 */
function routeOf(event: AskEvent): "ask" | "backtest" {
  const albPath = (event as unknown as { path?: string }).path;
  const path = event.requestContext?.http?.path ?? event.rawPath ?? albPath ?? "";
  return path.endsWith("/backtest") ? "backtest" : "ask";
}

/**
 * Parse the backtest request. Both fields are optional: the default is a full `data`-mode sweep of
 * every Fedline case, which is what the UI button sends.
 */
function parseBacktestBody(event: AskEvent): { mode: BacktestMode; caseIds?: string[] } {
  let raw = event.body ?? "{}";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
  const body = (parsed ?? {}) as { mode?: unknown; caseIds?: unknown };
  if (body.mode !== undefined && body.mode !== "data" && body.mode !== "full") {
    throw new ValidationError("Field 'mode' must be 'data' or 'full'.");
  }
  const caseIds = Array.isArray(body.caseIds)
    ? body.caseIds.filter((c): c is string => typeof c === "string")
    : undefined;
  return { mode: (body.mode as BacktestMode) ?? "data", caseIds };
}

/**
 * Read the authenticated caller from the API-Gateway Lambda authorizer's context. The authorizer
 * has already verified the token signature + expiry, so an authorized request reaching here always
 * carries a userId. Returns undefined only when the route is unauthenticated (no authorizer wired).
 */
function readAuthContext(event: AskEvent): AuthContext | undefined {
  // Preferred: the API-Gateway authorizer already verified the token and injected the identity.
  const ctx = event.requestContext?.authorizer?.lambda;
  if (ctx && ctx.userId) {
    let identifiers: Record<string, string> = {};
    try {
      identifiers = ctx.ids ? (JSON.parse(ctx.ids) as Record<string, string>) : {};
    } catch {
      identifiers = {};
    }
    return { userId: ctx.userId, userName: ctx.userName ?? ctx.username ?? "", identifiers };
  }

  // Lambda Function URL path (used for long, >30s agent runs that don't fit API Gateway's 30s cap):
  // there is no authorizer, so verify the bearer token HERE with the same secret + HS256 the authorizer
  // uses. An invalid/expired/absent token yields no auth context → the request is treated as anonymous
  // (orchestrate then requires a name, i.e. it's effectively rejected).
  const secret = process.env.AUTH_JWT_SECRET;
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const token = extractBearer(header);
  if (!secret || !token) return undefined;
  const res = verifyToken(token, secret, Math.floor(Date.now() / 1000));
  if (!res.valid) return undefined;
  return { userId: res.claims.sub, userName: res.claims.name || res.claims.username, identifiers: res.claims.ids ?? {} };
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
    // Validation sweep over the Fedline backend — no question, no orchestration; it replays every
    // registered operation through the dispatch path and checks the response tables.
    if (routeOf(event) === "backtest") {
      // MUST be gated here, not only at the edge. The API-Gateway route sits behind the token
      // authorizer, but the ALB long-path has no authorizer at all — without this check `full` mode
      // (one model call per Fedline operation) would be reachable by an unauthenticated caller.
      // Guarded on the secret so local/dev runs without auth configured still work.
      const backtestAuth = readAuthContext(event);
      if (!backtestAuth && process.env.AUTH_JWT_SECRET) {
        reqLog.warn("backtest rejected: no valid session token");
        return respond(401, { ok: false, error: "UNAUTHORIZED: a valid session token is required.", traceId: trace });
      }
      const { mode, caseIds } = parseBacktestBody(event);
      reqLog.info("backtest received", { mode, caseIds: caseIds?.length ?? 0 });
      const summary = await runBacktest({ mode, caseIds });
      reqLog.info("backtest completed", {
        mode, failed: summary.totals.failed, checksFailed: summary.totals.checksFailed,
      });
      return respond(200, { ok: true, summary, traceId: trace });
    }

    const { question, file, payload } = parseBody(event);

    // Identity comes from the verified session token (via the authorizer context), not the question
    // text. If the authorizer is wired (production), an unauthenticated request never reaches here;
    // readAuthContext returning undefined means the route is running without an authorizer (e.g.
    // local dev), in which case orchestrate falls back to name-in-question resolution.
    const auth = readAuthContext(event);
    reqLog.info("ask received", { question, userId: auth?.userId, authenticated: Boolean(auth), hasFile: Boolean(file) });

    // A file-bearing request is a gateway file-upload (e.g. SCP): handle it deterministically via the
    // gateway Lambda so the file bytes never enter the LLM. Otherwise run the normal supervisor flow.
    const report = file
      ? await runGatewaySubmit(question, file, payload, auth)
      : await produceReport(question, auth);

    reqLog.info("ask completed", { type: report.type, sections: report.sections.length });
    return respond(200, { ok: true, report, traceId: trace });
  } catch (err) {
    const e = toErrorBody(err);
    reqLog.error("ask failed", { code: e.code, message: e.message });
    return respond(e.statusCode, { ok: false, error: `${e.code}: ${e.message}`, traceId: trace });
  }
};
