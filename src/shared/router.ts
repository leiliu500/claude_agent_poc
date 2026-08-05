/**
 * Deterministic, dependency-free router.
 *
 * Used directly in ORCHESTRATION_MODE=local, and as the canonical reference for what
 * the Supervisor Bedrock Agent is expected to produce. Keeping a pure-TS router means
 * the whole pipeline is testable without provisioning Bedrock.
 */
import type { AgentType, RoutingDecision, TaskParams, TaskRequest } from "./types.js";
import { USE_CASES, type UseCaseSpec } from "./usecases.js";

/**
 * Word-boundary matcher with simple plural tolerance: `relationship` matches "relationships",
 * `fee` matches "fees". Cached per term (built once per process).
 *
 * Plural tolerance is REQUIRED — a strict `\bterm\b` stops "relationship" matching "relationships",
 * which silently drops a use case's only distinctive keyword. Tolerance alone would reintroduce
 * double counting (both "fee" and "fees" hitting one token), so `scoreUseCase` claims spans.
 */
const WORD_RE = new Map<string, RegExp>();
function matchTerm(question: string, term: string): { start: number; end: number } | undefined {
  let re = WORD_RE.get(term);
  if (!re) {
    re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?\\b`);
    WORD_RE.set(term, re);
  }
  const hit = re.exec(question);
  return hit ? { start: hit.index, end: hit.index + hit[0].length } : undefined;
}

/** How many use cases declare this keyword — a term in many use cases discriminates poorly. */
const TERM_FREQUENCY = new Map<string, number>();
for (const uc of USE_CASES) {
  for (const kw of new Set(uc.keywords)) TERM_FREQUENCY.set(kw, (TERM_FREQUENCY.get(kw) ?? 0) + 1);
}

interface UseCaseScore {
  /** Keyword/label points. */
  score: number;
  /** Sum of 1/frequency over matched keywords — how DISTINCTIVE the evidence was. Breaks ties. */
  specificity: number;
}

/**
 * Score a use case against the lowercased question.
 *
 * Each matched SPAN of the question is counted once. Keywords are tried longest-first, so a
 * specific phrase claims its span before a shorter generic word can also collect from it: "fees"
 * scores once for XShip Fee, not once as "fee" and again as "fees" — the double count that let the
 * catch-all total outrank the specific report a question actually named.
 *
 * The label bonus is deliberately small. Short labels like "XShip Fee" sit inside more specific
 * phrasings ("xship fee waivers"), so a label match must never by itself beat a distinctive phrase.
 */
function scoreUseCase(question: string, uc: UseCaseSpec): UseCaseScore {
  let score = 0;
  let specificity = 0;
  const claimed: Array<{ start: number; end: number }> = [];
  const claim = (span: { start: number; end: number }): boolean => {
    if (claimed.some((c) => span.start < c.end && span.end > c.start)) return false;
    claimed.push(span);
    return true;
  };

  // Longest first: the most specific phrase gets first claim on the text it covers.
  for (const kw of [...uc.keywords].sort((a, b) => b.length - a.length)) {
    const span = matchTerm(question, kw);
    if (!span || !claim(span)) continue;
    score += kw.includes(" ") ? 3 : 1; // phrase hits weigh more
    specificity += 1 / (TERM_FREQUENCY.get(kw) ?? 1);
  }

  // Id/label are INDEPENDENT signals and deliberately do not compete for spans with the keywords
  // above — a label is normally built from its own keywords ("XShip Fee" = "xship" + "fee"), so
  // span-claiming them together would cancel the bonus out entirely.
  if (matchTerm(question, uc.id.toLowerCase())) score += 5; // exact id mention is a strong signal
  if (matchTerm(question, uc.label.toLowerCase())) score += 2;

  return { score, specificity };
}

const QUARTER_RE = /\b(20\d{2})[ -]?q([1-4])\b/i;
const ABA_RE = /\b(\d{9})\b/;
const ZONE_RE = /\bzone[ -]?([a-z0-9]+)\b/i;
const GROUP_RE = /\b(?:aba )?group[ -]?([a-z0-9]+)\b/i;
const ISO_DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
// Natural-language dates like "July 31, 2026" / "Jul 31 2026" — used by the CT deposit report, whose
// questions read "…for July 31, 2026" rather than an ISO string. Captured only when no ISO date is present.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
const NL_DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gi;

// Explicitly-stated EDD request params. Each needs the literal field name followed by its value,
// so they don't misfire on ordinary prose. Values may be alphanumeric with - or _.
const OFFICE_RE = /\boffice(?:[_ ]?id)?\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i;
// CT deposit report site identifier: "site id 3279", "site 3279", "siteId: 3279".
const SITE_ID_RE = /\bsite(?:[_ ]?id)?\s*[:#]?\s*([A-Za-z0-9][\w-]*)/i;
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
  } else {
    // No ISO date — fall back to natural-language dates ("July 31, 2026"). A single date becomes a
    // one-day range (start === end), so a CT deposit question aggregates that whole day.
    const nl = [...question.matchAll(NL_DATE_RE)].map(
      (m) => `${m[3]}-${MONTHS[m[1]!.slice(0, 3).toLowerCase()]}-${m[2]!.padStart(2, "0")}`,
    );
    if (nl.length) {
      params.startDate = params.startDt = nl[0];
      params.endDate = params.endDt = nl[1] ?? nl[0];
    }
  }

  // EDD request-supplied path params stated explicitly in the prose (e.g. "office_id:001",
  // "endpoint wire", "denomination USD", "differenceType net"). When present these OVERRIDE the
  // DBAgent's stored defaults for the same field — the user is more specific than their profile.
  const office = question.match(OFFICE_RE);
  if (office) params.officeId = office[1];
  const site = question.match(SITE_ID_RE);
  if (site) params.siteId = site[1];
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

  const scored = USE_CASES.map((uc) => ({ uc, ...scoreUseCase(q, uc) })).filter((s) => s.score > 0);

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

  // Equal scores are broken by SPECIFICITY, not by declaration order. A tie used to hand the win to
  // whichever use case happened to be listed first in USE_CASES, which is not a routing signal at all.
  scored.sort((a, b) => b.score - a.score || b.specificity - a.specificity);
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

    // "internal"/"confidential" phrasing names a DIFFERENT export artifact than the plain one.
    // extractParams already captures it; without this the signal was dropped and every export
    // request resolved to the first exportable sibling — handing out the plain export for a
    // question that explicitly asked for the internal one.
    const internalUC = params.internal === true
      ? candidates.find((c) => c.exportable && c.keywords.some((k) => k === "internal" || k === "confidential"))
      : undefined;

    const exportUC = internalUC
      ?? (best.exportable ? best : candidates.find((c) => c.exportable && shareKeyword(c, best)));
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
  // No export requested: include another use case only when the question genuinely enumerates a
  // SECOND deliverable ("the summary and the detail"). The conjunction is required — without it a
  // short sibling label that happens to sit inside the primary phrasing ("XShip Fee" inside "xship
  // fee waivers") was silently added as an extra task, so a single-report question returned two.
  if (/\b(and|also|plus|then|along with|as well as)\b/.test(q)) {
    for (const c of candidates.slice(1, 3)) {
      if (matchTerm(q, c.id.toLowerCase()) || matchTerm(q, c.label.toLowerCase())) {
        tasks.push({ type: c.type, useCase: c.id, params });
      }
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
