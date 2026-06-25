/**
 * Canonical registry of every report type and its use cases.
 *
 * This is the SINGLE SOURCE OF TRUTH. It feeds:
 *   - the action-group Lambdas (which use case to execute),
 *   - the local deterministic router (keyword matching),
 *   - the generated OpenAPI schemas for Bedrock action groups,
 *   - the agent instruction prompts (the menu of allowed use cases).
 *
 * Identifiers are normalised to camelCase regardless of how they appear in the
 * original spec (e.g. "XshipDownload-ActivityAbaRollup" -> "xshipDownloadActivityAbaRollup").
 */
import type { AgentType } from "./types.js";

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
}

const PERIOD: ParamSpec = {
  name: "period",
  type: "string",
  required: false,
  description: "Reporting period, e.g. '2026-Q2' or 'Jun 2026'.",
};
const ABA: ParamSpec = {
  name: "abaNumber",
  type: "string",
  required: false,
  description: "9-digit ABA routing number.",
};
const ABA_GROUP: ParamSpec = {
  name: "abaGroup",
  type: "string",
  required: false,
  description: "ABA group identifier.",
};
const ZONE: ParamSpec = {
  name: "zone",
  type: "string",
  required: false,
  description: "Activity zone code.",
};
const INSTITUTION: ParamSpec = {
  name: "institutionId",
  type: "string",
  required: false,
  description: "Institution identifier.",
};

export const USE_CASES: readonly UseCaseSpec[] = [
  // ── EDD ────────────────────────────────────────────────────────────────────
  {
    id: "eddSummaryReport",
    type: "EDD",
    label: "EDD Summary Report",
    description: "Enhanced due-diligence summary across institutions for a period.",
    keywords: ["edd", "summary", "due diligence", "overview"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "eddExportSummaryReport",
    type: "EDD",
    label: "EDD Summary Report (Export)",
    description: "Exportable artifact of the EDD summary report.",
    keywords: ["edd", "summary", "export", "download summary"],
    exportable: true,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "eddDetailReport",
    type: "EDD",
    label: "EDD Detail Report",
    description: "Line-level enhanced due-diligence detail records.",
    keywords: ["edd", "detail", "line level", "records"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "eddExportDetailReport",
    type: "EDD",
    label: "EDD Detail Report (Export)",
    description: "Exportable artifact of the EDD detail report.",
    keywords: ["edd", "detail", "export", "download detail"],
    exportable: true,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "eddExportDetailInternal",
    type: "EDD",
    label: "EDD Detail Report (Internal Export)",
    description: "Internal-only exportable EDD detail with additional confidential columns.",
    keywords: ["edd", "detail", "internal", "confidential", "export internal"],
    exportable: true,
    params: [PERIOD, INSTITUTION, { name: "internal", type: "boolean", required: false, description: "Force internal columns." }],
  },

  // ── XShipReport ─────────────────────────────────────────────────────────────
  {
    id: "xShipInstitution",
    type: "XShipReport",
    label: "XShip Institution Report",
    description: "Per-institution shipping report.",
    keywords: ["xship", "institution", "by institution"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "xShipWaiver",
    type: "XShipReport",
    label: "XShip Waiver Report",
    description: "Fee waivers granted across shipments.",
    keywords: ["xship", "waiver", "waived", "waivers"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "xShipFeeDetail",
    type: "XShipReport",
    label: "XShip Fee Detail",
    description: "Line-level fee detail per shipment.",
    keywords: ["xship", "fee", "detail", "fee detail"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "xShipFeeSummary",
    type: "XShipReport",
    label: "XShip Fee Summary",
    description: "Aggregated fee summary by institution/period.",
    keywords: ["xship", "fee", "summary", "fee summary"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "xShipFee",
    type: "XShipReport",
    label: "XShip Fee",
    description: "Total fees overview.",
    keywords: ["xship", "fee", "fees", "total fee"],
    exportable: false,
    params: [PERIOD, INSTITUTION],
  },
  {
    id: "currentQuarter",
    type: "XShipReport",
    label: "Current Quarter Report",
    description: "Shipping report scoped to the current quarter.",
    keywords: ["current quarter", "this quarter", "quarter to date", "qtd"],
    exportable: false,
    params: [{ name: "quarter", type: "string", required: false, description: "Quarter override, e.g. '2026-Q2'." }],
  },

  // ── XShipDownload ─────────────────────────────────────────────────────────────
  {
    id: "xshipDownloadActivityAba",
    type: "XShipDownload",
    label: "XShip Download — Activity by ABA",
    description: "Download of shipping activity grouped by ABA.",
    keywords: ["xship", "download", "activity", "aba"],
    exportable: true,
    params: [PERIOD, ABA],
  },
  {
    id: "xshipDownloadActivityAbaRollup",
    type: "XShipDownload",
    label: "XShip Download — Activity by ABA (Rollup)",
    description: "Rolled-up shipping activity by ABA.",
    keywords: ["xship", "download", "activity", "aba", "rollup", "roll up"],
    exportable: true,
    params: [PERIOD, ABA],
  },
  {
    id: "xshipDownloadActivityZone",
    type: "XShipDownload",
    label: "XShip Download — Activity by Zone",
    description: "Download of shipping activity grouped by zone.",
    keywords: ["xship", "download", "activity", "zone"],
    exportable: true,
    params: [PERIOD, ZONE],
  },
  {
    id: "xshipDownloadCriteriaPeriod",
    type: "XShipDownload",
    label: "XShip Download — Criteria by Period",
    description: "Download of shipping activity filtered by criteria over a period.",
    keywords: ["xship", "download", "criteria", "period"],
    exportable: true,
    params: [PERIOD, ZONE, ABA],
  },

  // ── Relationship ──────────────────────────────────────────────────────────────
  {
    id: "xshiFileAbaGroup",
    type: "Relationship",
    label: "XSHI File — ABA Group",
    description: "Relationship lookup for an ABA group from the XSHI file.",
    keywords: ["relationship", "xshi", "file", "aba group", "group"],
    exportable: false,
    params: [ABA_GROUP],
  },
  {
    id: "xshiFileAba",
    type: "Relationship",
    label: "XSHI File — ABA",
    description: "Relationship lookup for a single ABA from the XSHI file.",
    keywords: ["relationship", "xshi", "file", "aba"],
    exportable: false,
    params: [ABA],
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
