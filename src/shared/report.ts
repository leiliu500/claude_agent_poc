/**
 * Pure report generation: turns dispatch results + analytics into a FinalReport.
 * No I/O — used by the report Flow Lambda and by local orchestration mode.
 */
import type {
  AgentType,
  AnalyticsResult,
  DispatchResult,
  FinalReport,
  ReportSection,
  RoutingDecision,
} from "./types.js";
import { getUseCase } from "./usecases.js";

const TITLES: Record<AgentType, string> = {
  EDD: "Enhanced Due-Diligence Report",
  XShipReport: "XShip Reporting",
  XShipDownload: "XShip Activity Download",
  Relationship: "ABA Relationship Report",
  KB: "Knowledge Base Answer",
  Gateway: "Agentic API Gateway Response",
};

/** Stable, time-free id so report generation is deterministic for tests. */
function reportId(question: string, type: AgentType): string {
  let h = 0;
  const s = `${type}:${question}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `RPT-${type}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) cols.add(k);
  return [...cols];
}

export interface ReportInput {
  question: string;
  type: AgentType;
  dispatchResults: DispatchResult[];
  analytics: AnalyticsResult;
  routing?: Pick<RoutingDecision, "type" | "requiresOrchestration" | "rationale">;
  /** Injected by the caller; the flow passes an ISO timestamp from event metadata. */
  generatedAt: string;
}

export function generateReport(input: ReportInput): FinalReport {
  const { question, type, dispatchResults, analytics, generatedAt } = input;

  const sections: ReportSection[] = dispatchResults.map((r) => {
    const key = `${r.type}:${r.useCase}`;
    const metric = analytics.metrics[key];
    const spec = getUseCase(r.useCase);
    return {
      heading: spec?.label ?? r.useCase,
      useCase: r.useCase,
      highlights: metric?.highlights ?? [],
      columns: columnsOf(r.data),
      rows: r.data,
      meta: r.meta,
    };
  });

  // KB answers surface the grounded answer as the summary; a Gateway text response (e.g. SCP's ack)
  // surfaces the response body; everything else gets the "N of M tasks succeeded" line.
  const summary =
    type === "KB"
      ? buildKbSummary(dispatchResults)
      : type === "Gateway"
        ? gatewayResponseText(dispatchResults) ?? buildSummary(type, analytics)
        : buildSummary(type, analytics);

  return {
    reportId: reportId(question, type),
    title: TITLES[type],
    generatedAt,
    question,
    type,
    sections,
    summary,
    routing:
      input.routing ?? {
        type,
        requiresOrchestration: dispatchResults.length > 1,
        rationale: "Routing decided upstream by the supervisor agent.",
      },
  };
}

/**
 * The text response body of a Gateway call, when there is one — the mock/real proxy puts a text ack
 * (e.g. SCP's "Request sent successfully…") in meta.response or as a single { value } row. Used as the
 * report summary so the UI shows the actual response instead of a generic "1 task succeeded" line.
 */
function gatewayResponseText(results: DispatchResult[]): string | undefined {
  const r = results.find((x) => x.type === "Gateway" && x.status === "ok");
  if (!r) return undefined;
  if (typeof r.meta.response === "string" && r.meta.response.trim()) return r.meta.response;
  const first = r.data?.[0] as Record<string, unknown> | undefined;
  if (first && typeof first.value === "string" && first.value.trim()) return first.value;
  return undefined;
}

/** Summary for a KB answer: the grounded answer text plus its citations, taken from the KB result. */
function buildKbSummary(results: DispatchResult[]): string {
  const kb = results.find((r) => r.type === "KB" && r.status === "ok");
  if (!kb) return "No knowledge-base answer was produced for your question.";
  const answer = typeof kb.meta.answer === "string" ? kb.meta.answer : "";
  const citations = Array.isArray(kb.meta.citations) ? (kb.meta.citations as string[]) : [];
  const parts = [answer || "No answer was produced."];
  if (citations.length) parts.push(`Sources: ${citations.join("; ")}.`);
  return parts.join(" ");
}

function buildSummary(type: AgentType, analytics: AnalyticsResult): string {
  const a = analytics.aggregate;
  const parts: string[] = [];
  parts.push(
    `${TITLES[type]} generated for your request. ` +
      `${a.okTasks} of ${a.totalTasks} task(s) succeeded, returning ${a.totalRows} record(s) in total.`,
  );
  if (a.erroredTasks > 0) parts.push(`${a.erroredTasks} task(s) failed — see notes.`);
  if (a.totalTasks > 1) parts.push("Multiple tasks were orchestrated to satisfy this request.");
  // Pull one cross-section highlight.
  const firstHi = Object.values(analytics.metrics).flatMap((m) => m.highlights)[1];
  if (firstHi) parts.push(firstHi);
  return parts.join(" ");
}
