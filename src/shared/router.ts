/**
 * Deterministic, dependency-free router.
 *
 * Used directly in ORCHESTRATION_MODE=local, and as the canonical reference for what
 * the Supervisor Bedrock Agent is expected to produce. Keeping a pure-TS router means
 * the whole pipeline is testable without provisioning Bedrock.
 */
import type { AgentType, RoutingDecision, TaskParams, TaskRequest } from "./types.js";
import { USE_CASES, type UseCaseSpec } from "./usecases.js";

/** Score a use case against the lowercased question by keyword hits. */
function scoreUseCase(question: string, uc: UseCaseSpec): number {
  let score = 0;
  for (const kw of uc.keywords) {
    if (question.includes(kw)) score += kw.includes(" ") ? 2 : 1; // phrase hits weigh more
  }
  // Exact id mention is a strong signal.
  if (question.includes(uc.id.toLowerCase())) score += 5;
  if (question.includes(uc.label.toLowerCase())) score += 4;
  return score;
}

const QUARTER_RE = /\b(20\d{2})[ -]?q([1-4])\b/i;
const ABA_RE = /\b(\d{9})\b/;
const ZONE_RE = /\bzone[ -]?([a-z0-9]+)\b/i;
const GROUP_RE = /\b(?:aba )?group[ -]?([a-z0-9]+)\b/i;
const ISO_DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

/** Pull structured params out of the raw question. */
export function extractParams(question: string): TaskParams {
  const q = question.toLowerCase();
  const params: TaskParams = {};

  const quarter = question.match(QUARTER_RE);
  if (quarter) params.period = params.quarter = `${quarter[1]}-Q${quarter[2]}`.toUpperCase();

  const aba = question.match(ABA_RE);
  if (aba) params.abaNumber = aba[1];

  const zone = question.match(ZONE_RE);
  if (zone) params.zone = zone[1];

  const group = question.match(GROUP_RE);
  if (group) params.abaGroup = group[1];

  // A pair of ISO dates → a date range. Mapped to both naming conventions (EDD: startDate/endDate,
  // XShipReport: startDt/endDt) so either type's endpoint resolves in local mode.
  const dates = question.match(ISO_DATE_RE);
  if (dates && dates.length >= 1) {
    params.startDate = params.startDt = dates[0];
    const end = dates[1] ?? dates[0];
    params.endDate = params.endDt = end;
  }

  if (/\b(export|download|csv|extract|file)\b/.test(q)) params.export = true;
  if (/\b(internal|confidential)\b/.test(q)) params.internal = true;

  return params;
}

/**
 * Classify a question into one or more tasks. When the question implies several
 * deliverables (e.g. "summary report and export it"), multiple tasks are returned and
 * `requiresOrchestration` is true.
 */
export function route(question: string): RoutingDecision {
  const q = question.toLowerCase();
  const params = extractParams(question);

  const scored = USE_CASES.map((uc) => ({ uc, score: scoreUseCase(q, uc) })).filter((s) => s.score > 0);

  if (scored.length === 0) {
    // Nothing matched — default to the most common entrypoint with low confidence.
    const fallback = USE_CASES.find((u) => u.id === "eddSummaryReport")!;
    return {
      type: fallback.type,
      tasks: [{ type: fallback.type, useCase: fallback.id, params }],
      requiresOrchestration: false,
      confidence: 0.2,
      rationale: "No keywords matched; defaulted to EDD summary report.",
    };
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  const primaryType: AgentType = top.uc.type;

  // Keep tasks within the dominant type, ordered by score, de-duplicated.
  const sameType = scored.filter((s) => s.uc.type === primaryType);
  const tasks: TaskRequest[] = dedupeById(
    selectOrchestratedTasks(q, sameType.map((s) => s.uc), params),
  );

  const requiresOrchestration = tasks.length > 1;
  const maxScore = top.score;
  const confidence = Math.min(0.99, 0.5 + maxScore / 12);

  return {
    type: primaryType,
    tasks,
    requiresOrchestration,
    confidence: Number(confidence.toFixed(2)),
    rationale: `Matched ${tasks.length} ${primaryType} task(s) by keyword (top: ${top.uc.id}, score ${maxScore}).` +
      (requiresOrchestration ? " Multiple deliverables detected → orchestration required." : ""),
  };
}

/**
 * Decide the concrete task list. If the user asked to export *and* the top match has a
 * non-export sibling (and vice-versa), include both — that is the canonical orchestration
 * case ("give me the summary and export it").
 */
function selectOrchestratedTasks(
  q: string,
  candidates: UseCaseSpec[],
  params: TaskParams,
): TaskRequest[] {
  const wantsExport = params.export === true;
  const tasks: TaskRequest[] = [];

  const best = candidates[0]!;
  tasks.push({ type: best.type, useCase: best.id, params });

  if (wantsExport && !best.exportable) {
    // Find an exportable sibling that shares keywords with the best match.
    const sibling = candidates.find(
      (c) => c.exportable && shareKeyword(c, best),
    );
    if (sibling) tasks.push({ type: sibling.type, useCase: sibling.id, params });
  }

  // If the question explicitly enumerates another use case strongly, include it too.
  for (const c of candidates.slice(1, 3)) {
    if (q.includes(c.id.toLowerCase()) || q.includes(c.label.toLowerCase())) {
      tasks.push({ type: c.type, useCase: c.id, params });
    }
  }
  return tasks;
}

function shareKeyword(a: UseCaseSpec, b: UseCaseSpec): boolean {
  return a.keywords.some((k) => !k.includes("export") && b.keywords.includes(k));
}

function dedupeById(tasks: TaskRequest[]): TaskRequest[] {
  const seen = new Set<string>();
  const out: TaskRequest[] = [];
  for (const t of tasks) {
    if (seen.has(t.useCase)) continue;
    seen.add(t.useCase);
    out.push(t);
  }
  return out;
}
