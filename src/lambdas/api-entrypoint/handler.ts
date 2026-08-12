/**
 * API Gateway (HTTP API) entrypoint.
 *
 *   POST /v1/ask       { question, sessionId? }   ->  { ok, report, traceId }
 *   POST /v1/backtest  { backendId?, mode?, caseIds? } -> { ok, summary, traceId }
 *   POST /v1/backtest  { action: "applications" }    -> { ok, applications, traceId }
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
import { runBacktest, AUTHORED_BACKEND_ID } from "../../shared/backtest/run.js";
import { guardrailTrace, screen } from "../../shared/guardrail.js";
import { builtinBackends } from "../../shared/gateway/seed.js";
import { registryCases, exercisableCount } from "../../shared/backtest/registry-cases.js";
import type { BacktestMode, BacktestSummary } from "../../shared/backtest/types.js";
import type { RequestLogInput, RequestLogSection } from "../../shared/request-log.js";

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

/** Minimal structural type for the Lambda SDK bits used here. */
interface LambdaSdk {
  LambdaClient: new (cfg: { region?: string }) => { send(cmd: unknown): Promise<{ Payload?: Uint8Array }> };
  InvokeCommand: new (input: unknown) => unknown;
}

/**
 * Load the Lambda SDK. A variable specifier keeps tsc from requiring @aws-sdk/client-lambda's types
 * at build time — the SDK is provided by the Lambda runtime (external in the bundle), so it resolves
 * at runtime.
 */
async function lambdaSdk(): Promise<LambdaSdk> {
  const lambdaMod = "@aws-sdk/client-lambda";
  return (await import(lambdaMod)) as unknown as LambdaSdk;
}

/**
 * Handle a file-bearing request: the attached file must NOT flow through the supervisor LLM, so we
 * invoke the VPC-enabled gateway Lambda directly (retrieve the file-upload operation + invoke it via
 * the generic proxy) and wrap its DispatchResult into a report. Bypasses the Bedrock flow entirely.
 */
async function runGatewaySubmit(question: string, file: AskFile, payload: string | undefined, auth?: AuthContext): Promise<FinalReport> {
  const fn = process.env.GATEWAY_FN;
  if (!fn) throw new ValidationError("File uploads are not configured on this deployment.");

  const { LambdaClient, InvokeCommand } = await lambdaSdk();
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

/** One selectable application in the validation picker. */
interface ValidatableApplication {
  backendId: string;
  name: string;
  /** "authored" carries real table expectations; "registry" only what the spec can justify. */
  suite: "authored" | "registry";
  operations: number;
  /** How many of those operations a sweep may actually replay (safe method, no unfillable params). */
  exercisable: number;
}

/** Response of POST /v1/backtest — either a sweep summary or the picker's option list. */
interface BacktestResponse {
  ok: boolean;
  summary?: BacktestSummary;
  applications?: ValidatableApplication[];
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
 * Parse the validation request. Every field is optional: the default is a `data`-mode sweep of the
 * authored Fedline suite, which is what the UI's first run sends.
 *
 * `action: "applications"` asks for the picker's option list instead of running anything.
 */
function parseBacktestBody(event: AskEvent): {
  action: "run" | "applications";
  mode: BacktestMode;
  caseIds?: string[];
  backendId?: string;
} {
  let raw = event.body ?? "{}";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
  const body = (parsed ?? {}) as { mode?: unknown; caseIds?: unknown; backendId?: unknown; action?: unknown };
  if (body.action !== undefined && body.action !== "run" && body.action !== "applications") {
    throw new ValidationError("Field 'action' must be 'run' or 'applications'.");
  }
  if (body.mode !== undefined && body.mode !== "data" && body.mode !== "full") {
    throw new ValidationError("Field 'mode' must be 'data' or 'full'.");
  }
  if (body.backendId !== undefined && typeof body.backendId !== "string") {
    throw new ValidationError("Field 'backendId' must be a string.");
  }
  const caseIds = Array.isArray(body.caseIds)
    ? body.caseIds.filter((c): c is string => typeof c === "string")
    : undefined;
  return {
    action: (body.action as "run" | "applications") ?? "run",
    mode: (body.mode as BacktestMode) ?? "data",
    caseIds,
    backendId: typeof body.backendId === "string" ? body.backendId : undefined,
  };
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

/**
 * Fire one observation at the telemetry Lambda, which owns the durable request log.
 *
 * Async (InvocationType=Event) on purpose: this Lambda has no VPC attachment — it must reach the
 * Bedrock public endpoints — so it cannot write to RDS itself, and the caller is still waiting on
 * the response. An Event invoke costs the enqueue (~10ms) and nothing else.
 *
 * Every failure is swallowed. Telemetry that can fail a request is a bad trade, and the browser
 * records the same observation locally regardless.
 */
async function emitTelemetry(record: RequestLogInput): Promise<void> {
  const fn = process.env.TELEMETRY_FN;
  if (!fn) return; // telemetry not deployed (e.g. database disabled) — the local store still works
  try {
    const { LambdaClient, InvokeCommand } = await lambdaSdk();
    const client = new LambdaClient({ region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION });
    await client.send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ mode: "log", record })),
    }));
  } catch (err) {
    log.warn("telemetry emit failed; the request is unaffected", { error: String(err) });
  }
}

/** Per-section digest for the request log — row counts and the concrete operation behind each one. */
function digestSections(report: FinalReport): RequestLogSection[] {
  return (report.sections ?? []).map((sec) => {
    const meta = (sec.meta ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      useCase: sec.useCase ?? sec.heading ?? "unknown",
      rows: Array.isArray(sec.rows) ? sec.rows.length : 0,
      endpoint: str(meta.endpoint),
      httpMethod: str(meta.httpMethod),
      backend: str(meta.backendId) ?? str(meta.backend),
    };
  });
}

/** RAG provenance, when the knowledge base answered. */
function digestKb(report: FinalReport): RequestLogInput["kb"] {
  if (report.type !== "KB") return undefined;
  const sec = (report.sections ?? []).find((s) => s.meta && ("retrieval" in s.meta || "answer" in s.meta));
  const meta = (sec?.meta ?? {}) as Record<string, unknown>;
  return {
    retrieval: typeof meta.retrieval === "string" ? meta.retrieval : undefined,
    matched: typeof meta.matched === "number" ? meta.matched : sec ? sec.rows.length : 0,
    citations: Array.isArray(meta.citations) ? meta.citations.length : 0,
  };
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

/**
 * The applications the validator can actually exercise, with an honest account of what a sweep of
 * each would cover. `exercisable` is what makes the difference visible in the picker: an application
 * whose only operations are non-GET or parameterised can still be selected, but its sweep will
 * report every case as skipped — and saying so up front beats an empty-looking result.
 *
 * Listed from the in-process registry rather than the database because that is precisely what the
 * runner replays through; offering an application the runner cannot reach would be a dead option.
 */
function listValidatableApplications(): ValidatableApplication[] {
  return builtinBackends().map((b) => {
    const authored = b.backendId === AUTHORED_BACKEND_ID;
    const ops = b.operations ?? [];
    return {
      backendId: b.backendId,
      name: b.name ?? b.backendId,
      suite: authored ? "authored" : "registry",
      operations: ops.length,
      // The authored suite exercises every registered operation; a derived one only the safe,
      // parameterless subset.
      exercisable: authored ? ops.length : exercisableCount(registryCases(b)),
    };
  });
}

export const handler = async (event: AskEvent): Promise<APIGatewayProxyResultV2> => {
  const trace = traceId(event);
  const reqLog = log.child({ trace });
  // Hoisted so the failure path can log the same observation the success path does — a request log
  // that only records successes makes every error rate look like zero.
  const startedAt = Date.now();
  let question = "";
  let auth: AuthContext | undefined;
  let hadFile = false;
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
      const { action, mode, caseIds, backendId } = parseBacktestBody(event);

      // The picker's options. Listed from the in-process registry because that is exactly what the
      // sweep can replay — offering an application the runner cannot exercise would be a dead option.
      if (action === "applications") {
        return respond(200, { ok: true, applications: listValidatableApplications(), traceId: trace });
      }

      reqLog.info("backtest received", { backendId: backendId ?? "fedline", mode, caseIds: caseIds?.length ?? 0 });
      const summary = await runBacktest({ mode, caseIds, backendId });
      reqLog.info("backtest completed", {
        backendId: summary.backendId, mode, failed: summary.totals.failed, checksFailed: summary.totals.checksFailed,
      });
      return respond(200, { ok: true, summary, traceId: trace });
    }

    const parsed = parseBody(event);
    const { file, payload } = parsed;
    question = parsed.question;
    hadFile = Boolean(file);

    // Identity comes from the verified session token (via the authorizer context), not the question
    // text. If the authorizer is wired (production), an unauthenticated request never reaches here;
    // readAuthContext returning undefined means the route is running without an authorizer (e.g.
    // local dev), in which case orchestrate falls back to name-in-question resolution.
    auth = readAuthContext(event);
    reqLog.info("ask received", { question, userId: auth?.userId, authenticated: Boolean(auth), hasFile: Boolean(file) });

    // ── Guardrail: screen the question BEFORE it reaches any model or router. ──
    // This is the trust boundary. The question is untrusted text whose content steers which backend
    // operation runs, so it is screened here rather than at each internal model hop — and screening
    // here also covers the deterministic local fallback, which an inline guardrail would miss.
    const inputScreen = await screen(question, "INPUT");
    if (inputScreen.blocked) {
      reqLog.warn("request blocked by guardrail", { outcome: inputScreen.outcome, reasons: inputScreen.reasons });
      // 400 (not 403): the caller is authenticated and permitted — the CONTENT was rejected. The
      // guardrail's own message is returned so the user knows what to change.
      const status = inputScreen.outcome === "unavailable" ? 503 : 400;
      const body = inputScreen.message ?? "This request was blocked by the system's safety guardrail.";
      // Recorded like any other outcome, with its own errorKind so a blocked request is countable
      // on the dashboard rather than hidden inside a generic failure bucket.
      await emitTelemetry({
        traceId: trace,
        userRef: auth?.userId,
        userName: auth?.userName,
        question,
        ok: false,
        httpStatus: status,
        latencyMs: Date.now() - startedAt,
        rows: 0,
        hadFile,
        error: `${inputScreen.outcome}: ${inputScreen.reasons.join(", ") || "policy"}`,
        errorKind: "guardrail",
        trace: guardrailTrace(inputScreen, []),
        sections: [],
      });
      return respond(status, { ok: false, error: body, traceId: trace });
    }
    // Use the guardrail's text from here on: when it anonymised something (a pasted card number),
    // the masked variant is what should reach the model and the log, not the original.
    question = inputScreen.text;

    // A file-bearing request is a gateway file-upload (e.g. SCP): handle it deterministically via the
    // gateway Lambda so the file bytes never enter the LLM. Otherwise run the normal supervisor flow.
    const report = file
      ? await runGatewaySubmit(question, file, payload, auth)
      : await produceReport(question, auth);

    reqLog.info("ask completed", { type: report.type, sections: report.sections.length });

    // ── Guardrail: screen what is about to leave the system. ──
    // The narrative summary is the generated prose — the part a model wrote, and the only part that
    // could carry content the input screen never saw (from a KB passage or a backend response).
    // The data rows are NOT screened: they are the backend's own records, and masking figures in a
    // financial report would corrupt the answer rather than protect anyone.
    const outputScreen = await screen(report.summary ?? "", "OUTPUT");
    if (outputScreen.blocked) {
      reqLog.warn("response withheld by guardrail", { outcome: outputScreen.outcome, reasons: outputScreen.reasons });
      const status = outputScreen.outcome === "unavailable" ? 503 : 502;
      const body = outputScreen.message ?? "The generated response was withheld by the system's safety guardrail.";
      await emitTelemetry({
        traceId: trace,
        userRef: auth?.userId,
        userName: auth?.userName,
        question,
        ok: false,
        httpStatus: status,
        latencyMs: Date.now() - startedAt,
        rows: 0,
        hadFile,
        error: `${outputScreen.outcome}: ${outputScreen.reasons.join(", ") || "policy"}`,
        errorKind: "guardrail",
        trace: guardrailTrace(inputScreen, report.trace ?? [], outputScreen),
        sections: [],
      });
      return respond(status, { ok: false, error: body, traceId: trace });
    }
    // A masked summary is the one the user should see, so replace it rather than shipping the
    // original alongside a "we masked it" note.
    if (outputScreen.outcome === "masked") report.summary = outputScreen.text;

    // Both screenings belong on the trace: the dashboard's execution-path view is the record of what
    // actually ran, and a screening that was skipped must be visible as skipped.
    report.trace = guardrailTrace(inputScreen, report.trace ?? [], outputScreen);

    const sections = digestSections(report);
    await emitTelemetry({
      traceId: trace,
      userRef: auth?.userId,
      userName: auth?.userName,
      question,
      ok: true,
      httpStatus: 200,
      // Server-side processing time, NOT the caller's round trip — the browser records that
      // separately. The dashboard labels each source so the two are never conflated.
      latencyMs: Date.now() - startedAt,
      type: report.type,
      reportId: report.reportId,
      orchestrated: report.routing?.requiresOrchestration,
      rows: sections.reduce((a, s) => a + s.rows, 0),
      hadFile,
      trace: report.trace ?? [],
      sections,
      kb: digestKb(report),
    });

    return respond(200, { ok: true, report, traceId: trace });
  } catch (err) {
    const e = toErrorBody(err);
    reqLog.error("ask failed", { code: e.code, message: e.message });
    await emitTelemetry({
      traceId: trace,
      userRef: auth?.userId,
      userName: auth?.userName,
      question,
      ok: false,
      httpStatus: e.statusCode,
      latencyMs: Date.now() - startedAt,
      rows: 0,
      hadFile,
      error: `${e.code}: ${e.message}`,
      errorKind: "http",
      trace: [],
      sections: [],
    });
    return respond(e.statusCode, { ok: false, error: `${e.code}: ${e.message}`, traceId: trace });
  }
};
