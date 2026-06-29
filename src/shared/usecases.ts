/**
 * Canonical registry of every report type and its use cases.
 *
 * This is the SINGLE SOURCE OF TRUTH. It feeds:
 *   - the action-group Lambdas (which use case to execute + which REST endpoint to call),
 *   - the local deterministic router (keyword matching),
 *   - the generated OpenAPI schemas for Bedrock action groups,
 *   - the agent instruction prompts (the menu of allowed use cases + their params).
 *
 * Identifiers are normalised to camelCase regardless of how they appear in the
 * original spec (e.g. "XshipDownload-ActivityAbaRollup" -> "xshipDownloadActivityAbaRollup").
 *
 * Each use case now also carries the EXACT backend REST endpoint it maps to (`endpoint`).
 * `resolveEndpoint()` fills the path/query template from extracted params; this is the seam a
 * real HTTP client uses to call the backing service (the mock layer stands in for it today).
 */
import type { AgentType, TaskParams } from "./types.js";

export type HttpMethod = "GET" | "POST";

/** The concrete backend REST endpoint a use case maps to. */
export interface EndpointSpec {
  method: HttpMethod;
  /** Path template with `{param}` placeholders that match ParamSpec names. */
  path: string;
  /** Alternate template used when an export artifact is requested (XShip fee family). */
  exportPath?: string;
  /** Param names appended as the query string (e.g. EDD summary pagination/sort). */
  query?: string[];
}

/** A parameter the use case can accept, used for extraction + OpenAPI generation. */
export interface ParamSpec {
  name: string;
  type: "string" | "boolean" | "number";
  required: boolean;
  description: string;
}

export interface UseCaseSpec {
  /** Canonical camelCase id. */
  id: string;
  type: AgentType;
  /** Human label for reports/UI. */
  label: string;
  description: string;
  /** Lowercase keywords used by the local router to match free-text questions. */
  keywords: string[];
  /** Whether this use case produces an exportable artifact. */
  exportable: boolean;
  params: ParamSpec[];
  /** The backend REST endpoint this use case invokes. */
  endpoint: EndpointSpec;
}

function mk(
  name: string,
  type: ParamSpec["type"],
  description: string,
  required = false,
): ParamSpec {
  return { name, type, required, description };
}

// ── Shared params ────────────────────────────────────────────────────────────
const ABA = mk("abaNumber", "string", "9-digit ABA routing number.");
const ABA_GROUP = mk("abaGroup", "string", "ABA group identifier.");

// ── EDD path/query params ─────────────────────────────────────────────────────
const OFFICE_ID = mk("officeId", "string", "Office identifier (path segment).", true);
const USER_ABA = mk("userAba", "string", "Requesting user's ABA (path segment).", true);
const EDD_ABA = mk("aba", "string", "Target ABA for the report (path segment).", true);
const ENDPOINT = mk("endpoint", "string", "Endpoint/channel segment for the EDD query.", true);
const DENOMINATION = mk("denomination", "string", "Denomination filter (path segment).", true);
const DIFFERENCE_TYPE = mk("differenceType", "string", "Difference-type filter (path segment).", true);
const START_DATE = mk("startDate", "string", "Range start date, ISO yyyy-MM-dd (path segment).", true);
const END_DATE = mk("endDate", "string", "Range end date, ISO yyyy-MM-dd (path segment).", true);
const REPORT_ID = mk("reportId", "string", "Identifier of a previously prepared EDD report.", true);
const PAGE_NUMBER = mk("pageNumber", "number", "1-based page number (query).");
const PAGE_SIZE = mk("pageSize", "number", "Rows per page (query).");
const SORT_FIELD = mk("sortField", "string", "Field name to sort by (query).");
const SORT_ORDER = mk("sortOrder", "string", "Sort direction: 'asc' or 'desc' (query).");

// ── XShipReport path params ───────────────────────────────────────────────────
const ROLLUP_ABA_NAME = mk("rollupAbaName", "string", "Rollup ABA name (path segment).", true);
const XS_PERIOD = mk("period", "string", "Reporting period, e.g. '2026-Q2' (path segment).", true);
const XS_ZONE = mk("zone", "string", "Activity zone code (path segment).", true);
const START_DT = mk("startDt", "string", "Range start date, ISO yyyy-MM-dd (path segment).", true);
const END_DT = mk("endDt", "string", "Range end date, ISO yyyy-MM-dd (path segment).", true);
const DENOM_TYPE = mk("denomType", "string", "Denomination type (path segment).", true);
const FORMAT_TYPE = mk("formatType", "string", "Export format type, e.g. 'csv'/'pdf' (export path segment).");
const REPORT_NAME = mk("reportName", "string", "Report name for the export artifact (export path segment).");
const XS_EXPORT_ABA = mk("aba", "string", "Target ABA appended on the export path.");

// ── XShipDownload path params ─────────────────────────────────────────────────
const REQUEST_ID = mk("requestId", "string", "Prepared activity-download request identifier (path segment).", true);
const CRITERIA = mk("criteria", "string", "Encoded activity criteria token (path segment).", true);

export const USE_CASES: readonly UseCaseSpec[] = [
  // ── EDD ────────────────────────────────────────────────────────────────────
  {
    id: "eddSummaryReport",
    type: "EDD",
    label: "EDD Summary Report",
    description: "Enhanced due-diligence summary across institutions for a period.",
    keywords: ["edd", "summary", "due diligence", "overview"],
    exportable: false,
    params: [
      OFFICE_ID, USER_ABA, EDD_ABA, ENDPOINT, DENOMINATION, DIFFERENCE_TYPE,
      START_DATE, END_DATE, PAGE_NUMBER, PAGE_SIZE, SORT_FIELD, SORT_ORDER,
    ],
    endpoint: {
      method: "GET",
      path: "/eddReport/summary/{officeId}/{userAba}/{aba}/{endpoint}/{denomination}/{differenceType}/{startDate}/{endDate}",
      query: ["pageNumber", "pageSize", "sortField", "sortOrder"],
    },
  },
  {
    id: "eddExportSummaryReport",
    type: "EDD",
    label: "EDD Summary Report (Export)",
    description: "Exportable artifact of the EDD summary report.",
    keywords: ["edd", "summary", "export", "download summary"],
    exportable: true,
    params: [
      OFFICE_ID, USER_ABA, EDD_ABA, ENDPOINT, DENOMINATION, DIFFERENCE_TYPE,
      START_DATE, END_DATE,
    ],
    endpoint: {
      method: "GET",
      path: "/eddReport/exportsummary/{officeId}/{userAba}/{aba}/{endpoint}/{denomination}/{differenceType}/{startDate}/{endDate}",
    },
  },
  {
    id: "eddDetailReport",
    type: "EDD",
    label: "EDD Detail Report",
    description: "Line-level enhanced due-diligence detail records for a prepared report.",
    keywords: ["edd", "detail", "line level", "records"],
    exportable: false,
    params: [REPORT_ID],
    endpoint: { method: "GET", path: "/eddReport/detail/{reportId}" },
  },
  {
    id: "eddExportDetailReport",
    type: "EDD",
    label: "EDD Detail Report (Export)",
    description: "Exportable artifact of the EDD detail report.",
    keywords: ["edd", "detail", "export", "download detail"],
    exportable: true,
    params: [REPORT_ID],
    endpoint: { method: "GET", path: "/eddReport/detail/{reportId}" },
  },
  {
    id: "eddExportDetailInternal",
    type: "EDD",
    label: "EDD Detail Report (Internal Export)",
    description: "Internal-only exportable EDD detail with additional confidential columns.",
    keywords: ["edd", "detail", "internal", "confidential", "export internal"],
    exportable: true,
    params: [
      OFFICE_ID, EDD_ABA, ENDPOINT, DENOMINATION, DIFFERENCE_TYPE, START_DATE, END_DATE,
      mk("internal", "boolean", "Force internal/confidential columns."),
    ],
    endpoint: {
      method: "GET",
      path: "/eddReport/exportdetailinternal/{officeId}/{aba}/{endpoint}/{denomination}/{differenceType}/{startDate}/{endDate}",
    },
  },

  // ── XShipReport ─────────────────────────────────────────────────────────────
  {
    id: "xShipInstitution",
    type: "XShipReport",
    label: "XShip Institution Report",
    description: "Per-institution shipping report for a rollup ABA and period.",
    keywords: ["xship", "institution", "by institution"],
    exportable: false,
    params: [ROLLUP_ABA_NAME, XS_PERIOD],
    endpoint: { method: "GET", path: "/xshipreport/view/XShipInstitution/{rollupAbaName}/{period}" },
  },
  {
    id: "xShipWaiver",
    type: "XShipReport",
    label: "XShip Waiver Report",
    description: "Fee waivers granted for a rollup ABA and period.",
    keywords: ["xship", "waiver", "waived", "waivers"],
    exportable: false,
    params: [ROLLUP_ABA_NAME, XS_PERIOD],
    endpoint: { method: "GET", path: "/xshipreport/view/XShipWaiver/{rollupAbaName}/{period}" },
  },
  {
    id: "xShipFeeDetail",
    type: "XShipReport",
    label: "XShip Fee Detail",
    description: "Line-level fee detail per shipment; exportable with a format/report name and ABA.",
    keywords: ["xship", "fee", "detail", "fee detail"],
    exportable: true,
    params: [ROLLUP_ABA_NAME, XS_ZONE, XS_PERIOD, START_DT, END_DT, DENOM_TYPE, FORMAT_TYPE, REPORT_NAME, XS_EXPORT_ABA],
    endpoint: {
      method: "GET",
      path: "/xshipreport/view/XShipFeeDetail/{rollupAbaName}/{zone}/{period}/{startDt}/{endDt}/{denomType}",
      exportPath: "/{formatType}/{reportName}/{rollupAbaName}/{zone}/{period}/{startDt}/{endDt}/{denomType}/{aba}",
    },
  },
  {
    id: "xShipFeeSummary",
    type: "XShipReport",
    label: "XShip Fee Summary",
    description: "Aggregated fee summary by rollup ABA/zone/period; exportable.",
    keywords: ["xship", "fee", "summary", "fee summary"],
    exportable: true,
    params: [ROLLUP_ABA_NAME, XS_ZONE, XS_PERIOD, DENOM_TYPE, FORMAT_TYPE, REPORT_NAME, XS_EXPORT_ABA],
    endpoint: {
      method: "GET",
      path: "/xshipreport/view/XShipFeeSummary/{rollupAbaName}/{zone}/{period}/{denomType}",
      exportPath: "/{formatType}/{reportName}/{rollupAbaName}/{zone}/{period}/{denomType}/{aba}",
    },
  },
  {
    id: "xShipFee",
    type: "XShipReport",
    label: "XShip Fee",
    description: "Total fees overview for a rollup ABA and period; exportable.",
    keywords: ["xship", "fee", "fees", "total fee"],
    exportable: true,
    params: [ROLLUP_ABA_NAME, XS_PERIOD, FORMAT_TYPE, REPORT_NAME, XS_EXPORT_ABA],
    endpoint: {
      method: "GET",
      path: "/xshipreport/view/XShipFee/{rollupAbaName}/{period}",
      exportPath: "/{formatType}/{reportName}/{rollupAbaName}/{period}/{aba}",
    },
  },
  {
    id: "currentQuarter",
    type: "XShipReport",
    label: "Current Quarter Report",
    description: "Shipping report scoped to the current quarter.",
    keywords: ["current quarter", "this quarter", "quarter to date", "qtd"],
    exportable: false,
    params: [],
    endpoint: { method: "GET", path: "/xshipreport/view/currentQuarter" },
  },

  // ── XShipDownload ─────────────────────────────────────────────────────────────
  {
    id: "xshipDownloadActivityAba",
    type: "XShipDownload",
    label: "XShip Download — Activity by ABA",
    description: "Download of shipping activity detail for a prepared request (grouped by ABA).",
    keywords: ["xship", "download", "activity", "aba"],
    exportable: true,
    params: [REQUEST_ID],
    endpoint: { method: "GET", path: "/xshipdownload/activity/detail/{requestId}" },
  },
  {
    id: "xshipDownloadActivityAbaRollup",
    type: "XShipDownload",
    label: "XShip Download — Activity by ABA (Rollup)",
    description: "Download of rolled-up shipping activity detail for a prepared request.",
    keywords: ["xship", "download", "activity", "aba", "rollup", "roll up"],
    exportable: true,
    params: [REQUEST_ID],
    endpoint: { method: "GET", path: "/xshipdownload/activity/detail/{requestId}" },
  },
  {
    id: "xshipDownloadActivityZone",
    type: "XShipDownload",
    label: "XShip Download — Activity by Zone",
    description: "Download of shipping activity grouped by zone for an encoded criteria token.",
    keywords: ["xship", "download", "activity", "zone"],
    exportable: true,
    params: [CRITERIA],
    endpoint: { method: "GET", path: "/xshipdownload/activity/zone/{criteria}" },
  },
  {
    id: "xshipDownloadCriteriaPeriod",
    type: "XShipDownload",
    label: "XShip Download — Criteria by Period",
    description: "Download of shipping activity filtered by an encoded criteria token over a period.",
    keywords: ["xship", "download", "criteria", "period"],
    exportable: true,
    params: [CRITERIA],
    endpoint: { method: "GET", path: "/xshipdownload/activity/criteria/{criteria}" },
  },

  // ── Relationship ──────────────────────────────────────────────────────────────
  {
    id: "xshiFileAbaGroup",
    type: "Relationship",
    label: "XSHI File — ABA Group",
    description: "Relationship lookup for an ABA group from the XSHI relationship file.",
    keywords: ["relationship", "xshi", "file", "aba group", "group"],
    exportable: false,
    params: [ABA_GROUP],
    endpoint: { method: "GET", path: "/xshipRelationshipFile/xshipABA", query: ["abaGroup"] },
  },
  {
    id: "xshiFileAba",
    type: "Relationship",
    label: "XSHI File — ABA",
    description: "Relationship lookup for a single ABA from the XSHI relationship file.",
    keywords: ["relationship", "xshi", "file", "aba"],
    exportable: false,
    params: [ABA],
    endpoint: { method: "GET", path: "/xshipRelationshipFile/xshipABA", query: ["abaNumber"] },
  },
] as const;

/** Map: type -> its use cases. */
export const USE_CASES_BY_TYPE: Record<AgentType, UseCaseSpec[]> = USE_CASES.reduce(
  (acc, uc) => {
    (acc[uc.type] ??= []).push(uc);
    return acc;
  },
  {} as Record<AgentType, UseCaseSpec[]>,
);

const BY_ID = new Map(USE_CASES.map((uc) => [uc.id, uc]));

export function getUseCase(id: string): UseCaseSpec | undefined {
  return BY_ID.get(id);
}

export function isUseCaseOfType(id: string, type: AgentType): boolean {
  return BY_ID.get(id)?.type === type;
}

/** A use case's endpoint with all `{placeholders}` resolved from params. */
export interface ResolvedEndpoint {
  method: HttpMethod;
  /** The template that was used (export vs. standard). */
  template: string;
  /** Path with placeholders substituted (unfilled ones kept as `{name}`). */
  path: string;
  /** Resolved query string params. */
  query: Record<string, string>;
  /** Full relative URL: path + `?query`. */
  url: string;
  /** Path params that had no value supplied. */
  missing: string[];
}

function present(v: unknown): v is string | number | boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Resolve a use case's backend endpoint against extracted params. Chooses the export path
 * template when an export was requested (params.export or a format/report name is present)
 * and an exportPath exists. Missing path params are reported, not silently dropped.
 */
export function resolveEndpoint(useCaseId: string, params: TaskParams): ResolvedEndpoint | undefined {
  const spec = getUseCase(useCaseId);
  if (!spec) return undefined;
  const ep = spec.endpoint;

  const wantsExport = params.export === true || present(params.formatType) || present(params.reportName);
  const template = wantsExport && ep.exportPath ? ep.exportPath : ep.path;

  const missing: string[] = [];
  const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = (params as Record<string, unknown>)[name];
    if (!present(v)) {
      missing.push(name);
      return `{${name}}`;
    }
    return encodeURIComponent(String(v));
  });

  const query: Record<string, string> = {};
  for (const q of ep.query ?? []) {
    const v = (params as Record<string, unknown>)[q];
    if (present(v)) query[q] = String(v);
  }
  const qs = Object.keys(query).length
    ? "?" + Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
    : "";

  return { method: ep.method, template, path, query, url: path + qs, missing };
}
