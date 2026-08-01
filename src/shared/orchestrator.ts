/**
 * Deterministic orchestrator — the in-process equivalent of the Supervisor agent's whole job.
 *
 * Drives the end-to-end flow the requirements describe:
 *   1. Require a user name. If the question has none, throw a ValidationError (the API surfaces a
 *      400). This mirrors the Supervisor validating the request before doing any work.
 *   2. Resolve the user name to its stored identifiers via the DBAgent seam (user-directory →
 *      Postgres or the in-code mirror). An unknown user is also a ValidationError.
 *   3. Route the question to one or more tasks (shared/router), then MERGE the looked-up
 *      identifiers into each task's params (request-provided values win over DB defaults).
 *   4. Execute, honouring data dependencies: eddDetailReport / eddExportDetailReport need a
 *      reportId that only an eddSummaryReport produces, so the summary runs first and its
 *      reportId is fed into the detail call.
 *
 * Used by both execution paths: the api-entrypoint local pipeline and the flow-process node's
 * deterministic fallback. The real Bedrock supervisor performs the same steps via the DBAgent and
 * collaborator agents; this is the reference implementation and the test seam.
 */
import type { AgentType, AuthContext, DispatchResult, RoutingDecision, TaskParams, TaskRequest } from "./types.js";
import { route, extractParams } from "./router.js";
import { llmRoute } from "./llm-router.js";
import { executeTask } from "./dispatch.js";
import { getUseCase } from "./usecases.js";
import { extractUserName, lookupUserIdentifiers } from "./user-directory.js";
import { recallLatestReport, recallReport, rememberReport } from "./report-memory.js";
import { discoverOperation } from "./gateway/discovery-agent.js";
import { ValidationError } from "./errors.js";
import { createLogger } from "./logger.js";

const log = createLogger({ mod: "orchestrator" });

/** How the routing decision was made — surfaced in the UI's agent-trace panel. */
export interface RouteMeta {
  engine: "llm" | "deterministic";
  confidence: number;
  /** Foundation model id when the LLM router decided. */
  model?: string;
  latencyMs: number;
  useCases: string[];
}

/** Whether the Layer-2 gateway discovery agent ran for this request — surfaced in the trace. */
export interface GatewayMeta {
  /** True when the gateway agent discovered the operation (vs. KB / multi-task keeping the Layer-1 tasks). */
  ran: boolean;
  /** "llm" when gateway.md drove the pick; "proxy" on the deterministic top-candidate fallback. */
  engine?: "llm" | "proxy";
  model?: string;
  backendId?: string;
  operationId?: string;
  /** The agent's confidence, or the top retrieval relevance score on the fallback (0..1). */
  score?: number;
  latencyMs?: number;
}

export interface OrchestrationResult {
  type: AgentType;
  userName: string;
  results: DispatchResult[];
  /** The routing step's metadata (engine/confidence/model), for the execution-path trace. */
  routeMeta: RouteMeta;
  /** Layer-2 gateway discovery metadata (ran + match score), for the execution-path trace. */
  gatewayMeta: GatewayMeta;
}

/** The model the LLM router uses (mirrors llm-router / post-dispatch config). */
const ROUTER_MODEL = process.env.POSTDISPATCH_MODEL ?? process.env.FOUNDATION_MODEL ?? undefined;

/** Use cases whose endpoint needs a reportId that an eddSummaryReport must produce first. */
const REPORT_ID_DEPENDENTS = new Set(["eddDetailReport", "eddExportDetailReport"]);

/** The summary use case whose reportId the dependent detail use cases reuse. */
const SUMMARY_USE_CASE = "eddSummaryReport";

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * True when the detail request pins a specific report period (the only request-supplied part of the
 * summary signature — the rest are the user's stored identifiers). When absent, the request reads as
 * "the detail of the report I just ran", so we may reuse the user's most recent remembered summary.
 */
function pinsReportPeriod(p: TaskParams): boolean {
  return present(p.startDate) || present(p.endDate);
}

/** Fill only the params the request left absent from a remembered report (request values still win). */
function fillMissingParams(requestParams: TaskParams, remembered: TaskParams): TaskParams {
  const merged: TaskParams = { ...requestParams };
  for (const [k, v] of Object.entries(remembered)) {
    if (!present(merged[k]) && present(v)) merged[k] = v as never;
  }
  return merged;
}

/** Merge DB identifiers under request-extracted params: request-provided values take precedence. */
function mergeParams(dbIds: Record<string, string>, requestParams: TaskParams): TaskParams {
  const merged: TaskParams = { ...dbIds };
  for (const [k, v] of Object.entries(requestParams)) {
    if (present(v)) merged[k] = v as never;
  }
  return merged;
}

/** Signature over the EDD path params that identify a summary report (its reportId is per-report). */
function eddSummarySig(p: TaskParams): string {
  return [p.officeId, p.userAba, p.aba, p.endpoint, p.denomination, p.differenceType, p.startDate, p.endDate]
    .map((v) => (present(v) ? String(v) : ""))
    .join("|");
}

/**
 * Derive the detail reportId from an eddSummaryReport result — the same rule the Supervisor agent
 * applies (see src/agents/prompts). The reportId is NOT stored: it is composed from a selected
 * summary record as `${eddLoadID}_${ncdwRecordID}`. Prefer the backend-surfaced meta.reportId (the
 * primary record); otherwise select the first record in the data list and compose it from its ids.
 * This is the deterministic mirror of the agent's reasoning, not a hardcoded value.
 */
export function extractReportId(summary: DispatchResult): string | undefined {
  const fromMeta = summary.meta?.reportId;
  if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  const row = summary.data?.[0];
  if (row && row.eddLoadID != null && row.ncdwRecordID != null) {
    return `${row.eddLoadID}_${row.ncdwRecordID}`;
  }
  return undefined;
}

/** Options for {@link executeWithDependencies}. */
export interface ExecuteOptions {
  /** The requesting user's id — enables cross-session report memory when present. */
  userId?: string;
}

/**
 * Execute tasks in order, resolving the eddSummary → reportId → eddDetail dependency.
 *
 * The reportId a detail call needs is resolved in priority order:
 *   1. an eddSummaryReport already run *this turn* (in-turn cache);
 *   2. a prior summary this user ran, recalled from cross-session memory — by exact signature, or
 *      (when the detail pins no period) their most recent summary. On a memory hit the summary is
 *      NOT re-run — the detail runs directly, which is the whole point of having memory;
 *   3. otherwise the summary is run now (today's behaviour) and its reportId is remembered so the
 *      next turn — even in a later session — can skip it.
 *
 * Every summary that runs (explicit or dependency-driven) is remembered for the user.
 */
async function executeWithDependencies(tasks: TaskRequest[], opts: ExecuteOptions = {}): Promise<DispatchResult[]> {
  const { userId } = opts;
  const out: DispatchResult[] = [];
  const summaryBySig = new Map<string, DispatchResult>();

  /** Run a summary, cache it in-turn, surface it as a section, and remember it for the user. */
  const runSummary = async (params: TaskParams): Promise<DispatchResult> => {
    const sig = eddSummarySig(params);
    const result = await executeTask({ type: "EDD", useCase: SUMMARY_USE_CASE, params });
    out.push(result);
    summaryBySig.set(sig, result);
    const reportId = extractReportId(result);
    if (userId && reportId) {
      await rememberReport({ userId, key: sig, useCase: SUMMARY_USE_CASE, reportId, params });
    }
    return result;
  };

  for (let task of tasks) {
    if (task.useCase === SUMMARY_USE_CASE) {
      await runSummary(task.params);
      continue;
    }

    if (REPORT_ID_DEPENDENTS.has(task.useCase) && !present(task.params.reportId)) {
      // 0. The user directly identified the target EDD record by its ids. Compose the reportId
      //    from them and run the detail immediately — no summary, no memory lookup (they already
      //    selected the record). This is the same `${eddLoadID}_${ncdwRecordID}` rule the summary
      //    uses; here the ids come straight from the request.
      if (present(task.params.eddLoadID) && present(task.params.ncdwRecordID)) {
        const composed = `${task.params.eddLoadID}_${task.params.ncdwRecordID}`;
        log.info("composing reportId from request-supplied eddLoadID + ncdwRecordID; skipping summary", {
          useCase: task.useCase,
          reportId: composed,
        });
        out.push(await executeTask({ ...task, params: { ...task.params, reportId: composed } }));
        continue;
      }

      const sig = eddSummarySig(task.params);
      let reportId: string | undefined;

      // 1. Summary already produced this turn.
      const inTurn = summaryBySig.get(sig);
      if (inTurn) reportId = extractReportId(inTurn);

      // 2. Cross-session memory — reuse a prior summary WITHOUT re-running it.
      if (!reportId && userId) {
        const exact = await recallReport(userId, sig);
        if (exact) {
          reportId = exact.reportId;
          log.info("recalled reportId from memory (exact); skipping summary", { useCase: task.useCase });
        } else if (!pinsReportPeriod(task.params)) {
          const latest = await recallLatestReport(userId, SUMMARY_USE_CASE);
          if (latest) {
            reportId = latest.reportId;
            // Follow-up on the last summary: adopt its period so the detail matches that report.
            task = { ...task, params: fillMissingParams(task.params, latest.params) };
            log.info("recalled reportId from memory (latest summary); skipping summary", { useCase: task.useCase });
          }
        }
      }

      // 3. No memory — run the summary now to obtain the reportId (and remember it).
      if (!reportId) {
        log.info("running eddSummaryReport first to obtain reportId for detail", { useCase: task.useCase });
        reportId = extractReportId(await runSummary(task.params));
      }

      if (reportId) task = { ...task, params: { ...task.params, reportId } };
    }

    out.push(await executeTask(task));
  }
  return out;
}

/**
 * Memory-aware task execution for callers that already have a task list (e.g. the flow-process node
 * running the supervisor agent's chosen tasks). Resolves the eddSummary → detail dependency and
 * reuses/records reportIds in per-user memory.
 */
export function runTasks(tasks: TaskRequest[], opts: ExecuteOptions = {}): Promise<DispatchResult[]> {
  return executeWithDependencies(tasks, opts);
}

/**
 * Record a summary reportId the agent produced on its own (the flow-process agent-results branch),
 * so a later turn can reuse it. Best-effort; safe to call with non-summary results.
 */
export async function rememberSummaryResults(results: DispatchResult[], userId?: string): Promise<void> {
  if (!userId) return;
  for (const r of results) {
    if (r.useCase !== SUMMARY_USE_CASE || r.status !== "ok") continue;
    const reportId = extractReportId(r);
    if (!reportId) continue;
    const params = (r.meta?.params as TaskParams) ?? {};
    await rememberReport({ userId, key: eddSummarySig(params), useCase: SUMMARY_USE_CASE, reportId, params });
  }
}

/**
 * Resolve the requesting user's name + identifiers for a request.
 *
 *   - Authenticated path (preferred): identity comes from the verified session token (`auth`), so
 *     the chat user never types their name or IDs. No lookup is needed — the token already carries
 *     the identifiers resolved at login.
 *   - Legacy/no-auth path (tests, ORCHESTRATION_MODE=local without a token): fall back to pulling a
 *     user name out of the question text and resolving IDs via the directory. Throws
 *     ValidationError when no user is identifiable — the API boundary maps that to a 400.
 */
async function resolveIdentity(
  question: string,
  auth?: AuthContext,
): Promise<{ userId?: string; userName: string; identifiers: Record<string, string> }> {
  if (auth) {
    return { userId: auth.userId, userName: auth.userName, identifiers: auth.identifiers ?? {} };
  }

  const userName = extractUserName(question);
  if (!userName) {
    throw new ValidationError(
      "A user name is required to run a report. Sign in so your identity and IDs are attached automatically.",
    );
  }
  const lookup = await lookupUserIdentifiers(userName);
  if (!lookup.found) {
    throw new ValidationError(
      `Unknown user '${userName}'. No identifiers are on file for that name, so the report cannot be run.`,
    );
  }
  // No stable userId on the legacy name-in-question path — report memory stays disabled there.
  return { userName: lookup.fullName ?? userName, identifiers: lookup.identifiers };
}

/**
 * Run the full supervisor-equivalent pipeline for a question. When `auth` is provided (an
 * authenticated request), the caller's identity + identifiers come from the verified token;
 * otherwise identity is parsed from the question text (legacy/test path).
 */
export async function orchestrate(question: string, auth?: AuthContext): Promise<OrchestrationResult> {
  const { userId, userName, identifiers } = await resolveIdentity(question, auth);

  // LLM router drives when a model is configured (and validates its pick against the catalog); the
  // deterministic keyword router is the safety net. This is what makes routing genuinely agentic
  // instead of always falling through to regex — every LLM miss/fallback is logged in llm-router.
  const routeStart = performance.now();
  const llm = await llmRoute(question);
  const decision: RoutingDecision = llm ?? route(question);
  const routedBy = llm ? "llm" : "deterministic";
  const routeMeta: RouteMeta = {
    engine: routedBy,
    confidence: decision.confidence,
    model: routedBy === "llm" ? ROUTER_MODEL : undefined,
    latencyMs: Math.round(performance.now() - routeStart),
    useCases: decision.tasks.map((t) => t.useCase),
  };

  // Layer 2 — Gateway discovery AGENT (gateway.md). For a single-operation APPLICATION request (not a
  // knowledge question, not a multi-deliverable orchestration), the gateway agent discovers WHICH
  // registered backend operation serves it, straight from the live registry — the step that makes a
  // newly-registered app reachable with no code change, and the step that actually runs gateway.md.
  // KB and multi-task requests keep the Layer-1 task list (preserving the KB path and the EDD
  // summary→detail / "and export" chains). When the registry has nothing to match (e.g. local/tests),
  // discovery returns undefined and we fall through to the Layer-1 tasks too.
  let gatewayMeta: GatewayMeta = { ran: false };
  if (decision.type !== "KB" && decision.tasks.length === 1) {
    const disc = await discoverOperation(question, identifiers);
    if (disc) {
      const spec = getUseCase(disc.operationId);
      const type: AgentType = spec?.type ?? "Gateway";
      // Deterministic param extraction wins over the agent's (regex is reliable for dates/ids), under
      // the caller's identifiers; backendId/operationId pin the discovered target for the proxy.
      const params = mergeParams(identifiers, {
        ...disc.params,
        ...extractParams(question),
        backendId: disc.backendId,
        operationId: disc.operationId,
      });
      gatewayMeta = {
        ran: true, engine: disc.engine, model: disc.model,
        backendId: disc.backendId, operationId: disc.operationId,
        score: disc.confidence, latencyMs: disc.latencyMs,
      };
      log.info("orchestrating (gateway agent)", {
        userName, backendId: disc.backendId, operationId: disc.operationId, engine: disc.engine, confidence: disc.confidence,
      });
      const results = await executeWithDependencies([{ type, useCase: disc.operationId, params }], { userId });
      return { type, userName, results, routeMeta, gatewayMeta };
    }
  }

  const tasks: TaskRequest[] = decision.tasks.map((t) => ({
    ...t,
    params: mergeParams(identifiers, t.params),
  }));

  log.info("orchestrating", {
    userName,
    authenticated: Boolean(auth),
    routedBy,
    confidence: decision.confidence,
    type: decision.type,
    tasks: tasks.map((t) => t.useCase),
  });

  const results = await executeWithDependencies(tasks, { userId });
  return { type: decision.type, userName, results, routeMeta, gatewayMeta };
}
