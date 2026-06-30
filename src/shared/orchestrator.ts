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
import type { AgentType, DispatchResult, TaskParams, TaskRequest } from "./types.js";
import { route } from "./router.js";
import { executeTask } from "./dispatch.js";
import { extractUserName, lookupUserIdentifiers } from "./user-directory.js";
import { ValidationError } from "./errors.js";
import { createLogger } from "./logger.js";

const log = createLogger({ mod: "orchestrator" });

export interface OrchestrationResult {
  type: AgentType;
  userName: string;
  results: DispatchResult[];
}

/** Use cases whose endpoint needs a reportId that an eddSummaryReport must produce first. */
const REPORT_ID_DEPENDENTS = new Set(["eddDetailReport", "eddExportDetailReport"]);

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
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

/** Pull the reportId an eddSummaryReport surfaced (meta.reportId, else a row's caseId). */
function extractReportId(summary: DispatchResult): string | undefined {
  const fromMeta = summary.meta?.reportId;
  if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  const fromRow = summary.data?.[0]?.caseId;
  if (typeof fromRow === "string" && fromRow) return fromRow;
  return undefined;
}

/**
 * Execute tasks in order, resolving the eddSummary → reportId → eddDetail dependency. A summary is
 * run at most once per distinct report signature and surfaced as its own section, whether it was
 * requested explicitly or pulled in only to satisfy a detail task.
 */
async function executeWithDependencies(tasks: TaskRequest[]): Promise<DispatchResult[]> {
  const out: DispatchResult[] = [];
  const summaryBySig = new Map<string, DispatchResult>();

  for (let task of tasks) {
    if (task.useCase === "eddSummaryReport") {
      const result = await executeTask(task);
      out.push(result);
      summaryBySig.set(eddSummarySig(task.params), result);
      continue;
    }

    if (REPORT_ID_DEPENDENTS.has(task.useCase) && !present(task.params.reportId)) {
      const sig = eddSummarySig(task.params);
      let summary = summaryBySig.get(sig);
      if (!summary) {
        log.info("running eddSummaryReport first to obtain reportId for detail", { useCase: task.useCase });
        summary = await executeTask({ type: "EDD", useCase: "eddSummaryReport", params: task.params });
        out.push(summary);
        summaryBySig.set(sig, summary);
      }
      const reportId = extractReportId(summary);
      if (reportId) task = { ...task, params: { ...task.params, reportId } };
    }

    out.push(await executeTask(task));
  }
  return out;
}

/**
 * Run the full supervisor-equivalent pipeline for a question. Throws ValidationError when no user
 * name is present or the user is unknown — the API boundary maps that to a 400.
 */
export async function orchestrate(question: string): Promise<OrchestrationResult> {
  const userName = extractUserName(question);
  if (!userName) {
    throw new ValidationError(
      "A user name is required to run a report. Include it in your request, e.g. \"user name: Lei Liu\".",
    );
  }

  const lookup = await lookupUserIdentifiers(userName);
  if (!lookup.found) {
    throw new ValidationError(
      `Unknown user '${userName}'. No identifiers are on file for that name, so the report cannot be run.`,
    );
  }

  const decision = route(question);
  const tasks: TaskRequest[] = decision.tasks.map((t) => ({
    ...t,
    params: mergeParams(lookup.identifiers, t.params),
  }));

  log.info("orchestrating", {
    userName: lookup.fullName ?? userName,
    type: decision.type,
    tasks: tasks.map((t) => t.useCase),
  });

  const results = await executeWithDependencies(tasks);
  return { type: decision.type, userName: lookup.fullName ?? userName, results };
}
