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

// Explicitly-stated EDD request params. Each needs the literal field name followed by its value,
// so they don't misfire on ordinary prose. Values may be alphanumeric with - or _.
const OFFICE_RE = /\boffice(?:[_ ]?id)?\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i;
const ENDPOINT_RE = /\bendpoint\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i;
const DENOMINATION_RE = /\bdenomination\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i;
const DIFF_TYPE_RE = /\bdifference[_ ]?type\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i;
const START_DATE_RE = /\bstart\s*date\s*[:#]?\s*(20\d{2}-\d{2}-\d{2})/i;
const END_DATE_RE = /\bend\s*date\s*[:#]?\s*(20\d{2}-\d{2}-\d{2})/i;
// EDD detail record identifiers the user can name directly to target one record. When both are
// given the detail runs against reportId = `${eddLoadID}_${ncdwRecordID}` with no summary needed.
// A directly-supplied report_id wins outright.
// Global so we can capture EVERY pair the user lists (e.g. two eddLoadID/ncdwRecordID written out
// separately), not just the first — the multi-record export-detail case.
const EDD_LOAD_ID_RE = /\bedd[_ ]?load[_ ]?id\s*[:=#]?\s*(\d+)/gi;
const NCDW_RECORD_ID_RE = /\bncdw[_ ]?record[_ ]?id\s*[:=#]?\s*(\d+)/gi;
const REPORT_ID_RE = /\breport[_ ]?id\s*[:=#]\s*([A-Za-z0-9][\w-]*)/i;
// A LIST of record ids: two or more comma-separated `${eddLoadID}_${ncdwRecordID}` pairs
// (e.g. `489_3998240,33_8431808`). This is the multi-record detail case → eddExportDetailReport,
// whose /eddReport/detail/{reportId} endpoint takes the whole comma-joined list as its {reportId}.
const REPORT_ID_LIST_RE = /\b\d+_\d+(?:\s*,\s*\d+_\d+)+/;

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

  // EDD request-supplied path params stated explicitly in the prose (e.g. "office_id:001",
  // "endpoint wire", "denomination USD", "differenceType net"). When present these OVERRIDE the
  // DBAgent's stored defaults for the same field — the user is more specific than their profile.
  const office = question.match(OFFICE_RE);
  if (office) params.officeId = office[1];
  const endpoint = question.match(ENDPOINT_RE);
  if (endpoint) params.endpoint = endpoint[1];
  const denom = question.match(DENOMINATION_RE);
  if (denom) params.denomination = denom[1];
  const diff = question.match(DIFF_TYPE_RE);
  if (diff) params.differenceType = diff[1];
  const startExplicit = question.match(START_DATE_RE);
  if (startExplicit) params.startDate = params.startDt = startExplicit[1];
  const endExplicit = question.match(END_DATE_RE);
  if (endExplicit) params.endDate = params.endDt = endExplicit[1];

  // Target a specific EDD record for a detail report. A directly-supplied report_id is used as-is;
  // otherwise eddLoadID + ncdwRecordID let the orchestrator compose the reportId without a summary.
  const reportIdExplicit = question.match(REPORT_ID_RE);
  if (reportIdExplicit) params.reportId = reportIdExplicit[1];
  // Capture EVERY eddLoadID / ncdwRecordID the user names (in order), then pair them positionally.
  const loadIds = [...question.matchAll(EDD_LOAD_ID_RE)].map((m) => m[1]!);
  const ncdwIds = [...question.matchAll(NCDW_RECORD_ID_RE)].map((m) => m[1]!);
  if (loadIds.length) params.eddLoadID = loadIds[0];
  if (ncdwIds.length) params.ncdwRecordID = ncdwIds[0];
  // Two or more well-formed pairs written out separately (e.g. "eddLoadID=8030, ncdwRecordID=... and
  // eddLoadID=8031, ncdwRecordID=...") → compose a comma-joined reportId list for export detail, so
  // NO pair is dropped. A single pair stays on eddLoadID/ncdwRecordID (composed by the orchestrator).
  if (loadIds.length >= 2 && loadIds.length === ncdwIds.length) {
    params.reportId = loadIds.map((l, i) => `${l}_${ncdwIds[i]}`).join(",");
  }
  // A comma-separated list of record-id pairs (pre-joined `X_Y,X_Y`) wins over a single report_id:
  // it names several records to expand at once (the export-detail case).
  const idList = question.match(REPORT_ID_LIST_RE);
  if (idList) params.reportId = idList[0].replace(/\s+/g, "");

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

  // A comma-joined list of record ids means "expand ALL of these" → eddExportDetailReport, whose
  // /eddReport/detail/{reportId} endpoint accepts the whole list. A single pair (or single
  // report_id) stays on the eddDetailReport path handled by keyword routing below.
  if (typeof params.reportId === "string" && params.reportId.includes(",")) {
    const uc = USE_CASES.find((u) => u.id === "eddExportDetailReport")!;
    return {
      type: uc.type,
      tasks: [{ type: uc.type, useCase: uc.id, params }],
      requiresOrchestration: false,
      confidence: 0.9,
      rationale: `Multiple EDD record ids supplied (${params.reportId.split(",").length}) → ${uc.id} over the id list.`,
    };
  }

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
 * Decide the concrete task list.
 *
 * When the user asked to export, the EXPORT artifact is the primary deliverable — even if a
 * non-export use case scored higher on a literal label match (e.g. "Export the EDD summary report"
 * contains the label "EDD Summary Report", which would otherwise make the paged summary win). We
 * additionally include the plain (view) sibling ONLY when the phrasing wants BOTH — the canonical
 * orchestration case "give me the summary AND export it" — not for a bare "export the … report".
 */
function selectOrchestratedTasks(
  q: string,
  candidates: UseCaseSpec[],
  params: TaskParams,
): TaskRequest[] {
  const wantsExport = params.export === true;
  const best = candidates[0]!;

  if (wantsExport) {
    // "export the X" → export only; "give me X and export it" / "export it" → base view + export.
    const wantsBoth =
      /\b(and|also|then|plus)\b[^.]*\b(export|download|csv|excel|pdf|extract|file)\b/.test(q) ||
      /\b(export|download)\s+(it|this|that|them)\b/.test(q);

    const exportUC = best.exportable ? best : candidates.find((c) => c.exportable && shareKeyword(c, best));
    const baseUC = best.exportable ? candidates.find((c) => !c.exportable && shareKeyword(c, best)) : best;

    if (exportUC) {
      const tasks: TaskRequest[] = [];
      // List the base report first, then its export, when both are wanted.
      if (wantsBoth && baseUC && baseUC.id !== exportUC.id) {
        tasks.push({ type: baseUC.type, useCase: baseUC.id, params });
      }
      tasks.push({ type: exportUC.type, useCase: exportUC.id, params });
      return tasks;
    }
    // No exportable relative found — fall through to the plain best match.
  }

  const tasks: TaskRequest[] = [{ type: best.type, useCase: best.id, params }];
  // No export requested: include any other use case the question explicitly enumerates.
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
