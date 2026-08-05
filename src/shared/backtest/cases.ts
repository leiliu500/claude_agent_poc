/**
 * Fedline backtest cases — one per registered Fedline operation.
 *
 * Every operation the Fedline backend exposes (`fedlineBackend()` derives them from USE_CASES, minus
 * the non-Fedline KB one) gets a case here, so "validate all response table data for Fedline" means
 * exactly that: no operation is silently unexercised. `assertCoversFedline()` fails loudly if an
 * operation is ever added to the registry without a matching case.
 *
 * A case carries three things:
 *   1. `params` — a realistic, fully-populated request (so `resolveEndpoint` reports no missing
 *      required params; a case that under-specifies would fail `params.complete` for the wrong reason).
 *   2. Table expectations — the columns every row must carry, which of them are numeric, and the
 *      meta rollups that must reconcile against the rows.
 *   3. `question` — the natural-language phrasing used for the routing check in `full` mode.
 */
import type { TaskParams, UseCaseId } from "../types.js";
import type { AgentType } from "../types.js";
import { USE_CASES } from "../usecases.js";

/** A meta rollup that must equal an aggregate recomputed from the rows. */
export interface RollupExpectation {
  /** Key in `result.meta` holding the backend's claimed rollup. */
  metaKey: string;
  /** Row column the rollup aggregates. */
  column: string;
  /** How the rollup is derived from the column. */
  op: "sum" | "count";
}

export interface BacktestCase {
  caseId: string;
  operationId: UseCaseId;
  type: AgentType;
  question: string;
  params: TaskParams;
  /** Columns that must be present on EVERY row. */
  requiredColumns: string[];
  /** Columns that must hold a finite number wherever present. */
  numericColumns?: string[];
  /** Meta rollups that must reconcile against the rows. */
  rollups?: RollupExpectation[];
  /** Meta keys that must equal the returned row count. */
  countKeys?: string[];
  /** Request params that must be echoed back unchanged in meta (catches wrong-query results). */
  echoParams?: string[];
  /** Minimum acceptable row count (default 1). */
  minRows?: number;
  /** Row columns holding a date/datetime that must fall inside [startDate, endDate] when both are given. */
  dateColumns?: string[];
}

// ── Shared realistic parameter blocks ─────────────────────────────────────────
const EDD_RANGE = { startDate: "2026-06-01", endDate: "2026-06-30" };

const EDD_SUMMARY_PARAMS: TaskParams = {
  officeId: "101",
  userAba: "121000358",
  aba: "121000358",
  endpoint: "1210003583300",
  denomination: "$100",
  differenceType: "Counterfeit",
  ...EDD_RANGE,
  pageNumber: 1,
  pageSize: 5,
  sortField: "differenceDate",
  sortOrder: "desc",
};

const EDD_SUMMARY_COLUMNS = [
  "adviceNumber", "differenceDate", "aba", "abaName", "endpointNumber", "depositType",
  "endpointName", "depositDate", "depositAmount", "denomination", "differenceType",
  "differenceAmount", "eddLoadID", "ncdwRecordID",
];

const EDD_DETAIL_COLUMNS = [
  "adviceNumber", "differenceDate", "denomination", "differenceDesc", "differenceAmount",
  "depositID", "depositAmount", "depositType", "ticketNumber", "abaName", "endpointNumber",
  "frbOffice", "differenceID", "reelNumber", "processingDT",
];

const XSHIP_FEE_COLUMNS = ["institution", "period", "feeUsd", "waivedUsd", "netFeeUsd"];
const XSHIP_ACTIVITY_COLUMNS = ["period", "shipments", "volumeUnits"];
const RELATIONSHIP_COLUMNS = ["abaNumber", "abaGroup", "parentInstitution", "relationshipType", "active"];

const XSHIP_EXPORT_PARAMS: TaskParams = {
  rollupAbaName: "FIRST NATIONAL",
  period: "2026-Q2",
  denomType: "Currency",
  formatType: "csv",
  reportName: "xshipFees",
  aba: "121000358",
};

export const FEDLINE_CASES: readonly BacktestCase[] = [
  // ── EDD ─────────────────────────────────────────────────────────────────────
  {
    caseId: "edd-summary",
    operationId: "eddSummaryReport",
    type: "EDD",
    question: "Show me the EDD summary report for June 2026",
    params: EDD_SUMMARY_PARAMS,
    requiredColumns: EDD_SUMMARY_COLUMNS,
    numericColumns: ["adviceNumber", "depositAmount", "differenceAmount", "eddLoadID", "ncdwRecordID"],
    countKeys: ["generatedRows"],
    echoParams: ["startDate", "endDate", "denomination", "differenceType"],
  },
  {
    caseId: "edd-export-summary",
    operationId: "eddExportSummaryReport",
    type: "EDD",
    question: "Export the EDD summary report for June 2026",
    params: { ...EDD_SUMMARY_PARAMS },
    requiredColumns: EDD_SUMMARY_COLUMNS,
    numericColumns: ["depositAmount", "differenceAmount"],
    // The export returns the FULL result set, so the claimed total must equal what was returned.
    countKeys: ["generatedRows", "totalEdds"],
    echoParams: ["startDate", "endDate"],
  },
  {
    caseId: "edd-detail",
    operationId: "eddDetailReport",
    type: "EDD",
    question: "Show the EDD detail records for report 489_3998240",
    params: { reportId: "489_3998240" },
    requiredColumns: EDD_DETAIL_COLUMNS,
    numericColumns: ["adviceNumber", "differenceAmount", "depositAmount"],
    echoParams: ["reportId"],
  },
  {
    caseId: "edd-export-detail",
    operationId: "eddExportDetailReport",
    type: "EDD",
    question: "Export the EDD detail report for 489_3998240,33_8431808",
    params: { reportId: "489_3998240,33_8431808" },
    requiredColumns: EDD_DETAIL_COLUMNS,
    numericColumns: ["differenceAmount", "depositAmount"],
    echoParams: ["reportId"],
    minRows: 2, // two comma-joined pairs → two detail records
  },
  {
    caseId: "edd-export-detail-internal",
    operationId: "eddExportDetailInternal",
    type: "EDD",
    question: "Export the internal EDD detail report for June 2026",
    // Unlike the other detail exports this one is filter-scoped, not reportId-scoped: its path takes
    // the full EDD filter set (officeId/aba/endpoint/denomination/differenceType/startDate/endDate).
    params: {
      officeId: "101",
      aba: "121000358",
      endpoint: "1210003583300",
      denomination: "$100",
      differenceType: "Counterfeit",
      ...EDD_RANGE,
      internal: true,
    },
    requiredColumns: EDD_DETAIL_COLUMNS,
    numericColumns: ["differenceAmount", "depositAmount"],
    countKeys: ["generatedRows"],
    echoParams: ["internal"],
  },

  // ── XShipReport ─────────────────────────────────────────────────────────────
  {
    caseId: "xship-institution",
    operationId: "xShipInstitution",
    type: "XShipReport",
    question: "Show XShip institution fees for 2026-Q2",
    params: { rollupAbaName: "FIRST NATIONAL", period: "2026-Q2" },
    requiredColumns: XSHIP_FEE_COLUMNS,
    numericColumns: ["feeUsd", "waivedUsd", "netFeeUsd"],
    countKeys: ["generatedRows"],
    echoParams: ["period"],
  },
  {
    caseId: "xship-waiver",
    operationId: "xShipWaiver",
    type: "XShipReport",
    question: "Show XShip fee waivers for 2026-Q2",
    params: { rollupAbaName: "FIRST NATIONAL", period: "2026-Q2" },
    requiredColumns: [...XSHIP_FEE_COLUMNS, "shipmentId", "zone"],
    numericColumns: ["feeUsd", "waivedUsd", "netFeeUsd"],
    countKeys: ["generatedRows"],
    echoParams: ["period"],
  },
  {
    caseId: "xship-fee-detail",
    operationId: "xShipFeeDetail",
    type: "XShipReport",
    question: "Show the XShip fee detail report for 2026-Q2",
    params: { ...XSHIP_EXPORT_PARAMS, zone: "A1", startDt: "2026-04-01", endDt: "2026-06-30" },
    requiredColumns: [...XSHIP_FEE_COLUMNS, "shipmentId", "zone"],
    numericColumns: ["feeUsd", "waivedUsd", "netFeeUsd"],
    countKeys: ["generatedRows"],
    echoParams: ["period"],
  },
  {
    caseId: "xship-fee-summary",
    operationId: "xShipFeeSummary",
    type: "XShipReport",
    question: "Show the XShip fee summary for 2026-Q2",
    params: { ...XSHIP_EXPORT_PARAMS, zone: "A1" },
    requiredColumns: XSHIP_FEE_COLUMNS,
    numericColumns: ["feeUsd", "waivedUsd", "netFeeUsd"],
    countKeys: ["generatedRows"],
    echoParams: ["period"],
  },
  {
    caseId: "xship-fee-total",
    operationId: "xShipFee",
    type: "XShipReport",
    question: "What is the total XShip fee for 2026-Q2?",
    params: { ...XSHIP_EXPORT_PARAMS },
    requiredColumns: ["period", "totalFeeUsd", "totalWaivedUsd"],
    numericColumns: ["totalFeeUsd", "totalWaivedUsd"],
    countKeys: ["generatedRows"],
    echoParams: ["period"],
  },
  {
    caseId: "xship-current-quarter",
    operationId: "currentQuarter",
    type: "XShipReport",
    question: "Show the current quarter XShip report",
    params: {},
    requiredColumns: XSHIP_FEE_COLUMNS,
    numericColumns: ["feeUsd", "waivedUsd", "netFeeUsd"],
    countKeys: ["generatedRows"],
  },

  // ── XShipDownload ───────────────────────────────────────────────────────────
  {
    caseId: "xship-activity-aba",
    operationId: "xshipDownloadActivityAba",
    type: "XShipDownload",
    question: "Download the XShip activity by ABA for request REQ-1001",
    params: { requestId: "REQ-1001", abaNumber: "121000358" },
    requiredColumns: [...XSHIP_ACTIVITY_COLUMNS, "abaNumber"],
    numericColumns: ["shipments", "volumeUnits"],
    countKeys: ["generatedRows"],
  },
  {
    caseId: "xship-activity-aba-rollup",
    operationId: "xshipDownloadActivityAbaRollup",
    type: "XShipDownload",
    question: "Download the XShip ABA rollup activity for request REQ-1001",
    params: { requestId: "REQ-1001", abaNumber: "121000358" },
    requiredColumns: [...XSHIP_ACTIVITY_COLUMNS, "abaNumber", "rollupShipments"],
    numericColumns: ["shipments", "volumeUnits", "rollupShipments"],
    countKeys: ["generatedRows"],
  },
  {
    caseId: "xship-activity-zone",
    operationId: "xshipDownloadActivityZone",
    type: "XShipDownload",
    question: "Download the XShip activity by zone for criteria ZONE-A1",
    params: { criteria: "ZONE-A1", zone: "A1" },
    requiredColumns: [...XSHIP_ACTIVITY_COLUMNS, "zone"],
    numericColumns: ["shipments", "volumeUnits"],
    countKeys: ["generatedRows"],
  },
  {
    caseId: "xship-criteria-period",
    operationId: "xshipDownloadCriteriaPeriod",
    type: "XShipDownload",
    question: "Download the XShip criteria period activity for criteria CRIT-77",
    params: { criteria: "CRIT-77", zone: "A1", abaNumber: "121000358" },
    requiredColumns: [...XSHIP_ACTIVITY_COLUMNS, "zone", "abaNumber", "criteriaMatched"],
    numericColumns: ["shipments", "volumeUnits"],
    countKeys: ["generatedRows"],
  },

  // ── Relationship ────────────────────────────────────────────────────────────
  {
    caseId: "relationship-aba-group",
    operationId: "xshiFileAbaGroup",
    type: "Relationship",
    question: "Show the ABA relationships for group GRP-100",
    params: { abaGroup: "GRP-100" },
    requiredColumns: RELATIONSHIP_COLUMNS,
    countKeys: ["generatedRows"],
  },
  {
    caseId: "relationship-aba",
    operationId: "xshiFileAba",
    type: "Relationship",
    question: "Show the ABA relationship for 121000358",
    params: { abaNumber: "121000358" },
    requiredColumns: RELATIONSHIP_COLUMNS,
    countKeys: ["generatedRows"],
  },

  // ── Report (CT deposits) ────────────────────────────────────────────────────
  {
    caseId: "ct-deposits-summary",
    operationId: "ctDepositsSummary",
    type: "Report",
    question: "How much was deposited at site 3501 on 2026-07-31?",
    params: { siteId: "3501", startDate: "2026-07-31", endDate: "2026-07-31" },
    requiredColumns: [
      "carrierName", "endpointNumber", "depositoryInstitution", "depositId", "dateTime", "userName", "amount",
    ],
    numericColumns: ["depositId", "amount"],
    // The headline figure the report leads with — the single most consequential number in the app.
    rollups: [{ metaKey: "totalDepositAmount", column: "amount", op: "sum" }],
    countKeys: ["reportCount", "reportTotalCount"],
    echoParams: ["siteId", "startDate", "endDate"],
    dateColumns: ["dateTime"],
  },
];

/** Operation ids the Fedline backend registers (KB is not a Fedline operation). */
export function fedlineOperationIds(): string[] {
  return USE_CASES.filter((uc) => uc.type !== "KB").map((uc) => uc.id);
}

/**
 * Coverage guard: every Fedline operation must have a case, and every case must name a real
 * operation. Returned (not thrown) so the runner can surface a coverage gap as a finding rather
 * than a 500 — a backtest that silently skips an operation is worse than one that reports the hole.
 */
export function coverageGaps(): { missing: string[]; unknown: string[] } {
  const registered = new Set(fedlineOperationIds());
  const covered = new Set(FEDLINE_CASES.map((c) => c.operationId as string));
  return {
    missing: [...registered].filter((id) => !covered.has(id)),
    unknown: [...covered].filter((id) => !registered.has(id)),
  };
}
