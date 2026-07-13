/**
 * Mock backend data, one generator per use case.
 *
 * Each generator returns `{ rows, meta }` mimicking what a real REST API / data store
 * would return. Deterministic given (useCase, params) so tests are stable.
 * Replace the bodies here with real HTTP/data clients to go to production — the action-group
 * Lambda handlers and the DispatchResult contract do not change.
 */
import type { TaskParams } from "../shared/types.js";

export interface MockPayload {
  rows: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

/** Tiny deterministic PRNG so "random looking" data is reproducible. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function period(params: TaskParams): string {
  return (params.period as string) ?? (params.quarter as string) ?? "2026-Q2";
}

/** Deterministic v4-style UUID from a seed, so a mock "Request ID" looks real but stays test-stable. */
function mockUuid(seed: string): string {
  const r = seeded(`uuid:${seed}`);
  const h: string[] = [];
  for (let i = 0; i < 32; i++) h.push(Math.floor(r() * 16).toString(16));
  h[12] = "4"; // version
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const INSTITUTIONS = ["First National", "Coastal Trust", "Summit Bank", "Harbor Credit Union", "Vista Financial"];
const ZONES = ["A1", "A2", "B1", "C3", "D7"];

// ── EDD ────────────────────────────────────────────────────────────────────────
// Shaped after the real EDD REST API (see the sample summary/detail responses):
//   summary → { result: { totalEdds, reportDataList: [ {edd row}, ... ] } }
//   detail  → { result: { reportDataList: [ { edd: { differenceDetail, depositDetail, ... } }, ... ] } }
// The summary lists EDD records (each carrying eddLoadID + ncdwRecordID); the detail expands one OR
// more records into their nested sections. The summary→detail chain (and the report memory feature)
// keys on a `reportId` derived from a record's identifiers: `${eddLoadID}_${ncdwRecordID}`. A single
// pair (eddDetailReport) yields one reportDataList entry; a comma-separated LIST of pairs
// (eddExportDetailReport, e.g. `489_3998240,33_8431808`) yields one entry per pair.
const EDD_BANKS = [
  { aba: "052001633", abaName: "BANK OF AMERICA, NA, MD" },
  { aba: "121000248", abaName: "WELLS FARGO BANK, NA" },
  { aba: "021000021", abaName: "JPMORGAN CHASE BANK, NA" },
  { aba: "021000089", abaName: "CITIBANK, NA" },
  { aba: "091000022", abaName: "U.S. BANK, NA" },
];
const EDD_ARMORED = ["GARDA SAN FRANCISCO", "BRINKS LOS ANGELES", "LOOMIS SEATTLE", "GARDA PHOENIX", "BRINKS DENVER"];
const EDD_DENOMS = ["$1", "$5", "$10", "$20", "$50", "$100"];
const EDD_DIFF_TYPES = ["Counterfeit", "Overage", "Shortage", "Unfit", "Suspect"];
const EDD_DEPOSIT_TYPES = ["Currency", "Coin"];
const FRB_OFFICES = [
  { teamNumber: "CV65", frbOfficeName: "San Francisco", address: "101 MARKET STREET", city: "SAN FRANCISCO", state: "CA", zipCode: "94105" },
  { teamNumber: "CV31", frbOfficeName: "Los Angeles", address: "950 S GRAND AVE", city: "LOS ANGELES", state: "CA", zipCode: "90015" },
  { teamNumber: "CV12", frbOfficeName: "Seattle", address: "2100 3RD AVE", city: "SEATTLE", state: "WA", zipCode: "98121" },
];

function eddStartDate(params: TaskParams): string {
  return (params.startDate as string) ?? "2024-04-01";
}
function eddEndDate(params: TaskParams): string {
  return (params.endDate as string) ?? "2024-05-01";
}
/** Add whole days to a YYYY-MM-DD date, returning YYYY-MM-DD (deterministic, UTC). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Numeric value of a "$50"-style denomination label. */
function denomValue(denom: string): number {
  return Number(denom.replace(/[^0-9.]/g, "")) || 1;
}

/** The stored identifiers of one EDD record — the seed for both the summary row and its detail. */
interface EddKey {
  eddLoadID: number;
  ncdwRecordID: number;
}

/** Derive a report's primary EDD record id (page-independent) so summary→detail stays stable. */
function primaryEddKey(params: TaskParams): EddKey {
  const sig = [params.officeId, params.aba, params.endpoint, params.denomination, params.differenceType, eddStartDate(params), eddEndDate(params)]
    .map((v) => (v == null ? "" : String(v)))
    .join("|");
  const r = seeded(`edd:report:${sig}`);
  return { eddLoadID: 1000 + Math.floor(r() * 9000), ncdwRecordID: 3003600000 + Math.floor(r() * 400000) };
}

/** Build one EDD summary record (the shape inside `result.reportDataList`). */
function eddSummaryRecord(params: TaskParams, index: number, key: EddKey): Record<string, unknown> {
  const rnd = seeded(`edd:rec:${key.eddLoadID}:${key.ncdwRecordID}:${index}`);
  const bank = params.aba
    ? { aba: String(params.aba), abaName: EDD_BANKS.find((b) => b.aba === String(params.aba))?.abaName ?? "BANK OF AMERICA, NA, MD" }
    : EDD_BANKS[index % EDD_BANKS.length]!;
  const endpointNumber = (params.endpoint as string) ?? `${bank.aba}3300`;
  // One armored carrier per endpoint: rows sharing an endpoint share the carrier (so an
  // aba/endpoint-filtered export lists a single, consistent endpointName), while a multi-bank
  // summary still varies because each bank yields a different endpointNumber.
  const armored = EDD_ARMORED[Math.floor(seeded(`edd:armored:${endpointNumber}`)() * EDD_ARMORED.length)]!;
  const denomination = EDD_DENOMS[Math.floor(rnd() * EDD_DENOMS.length)]!;
  const differenceType = EDD_DIFF_TYPES[Math.floor(rnd() * EDD_DIFF_TYPES.length)]!;
  const units = 1 + Math.floor(rnd() * 3);
  const differenceAmount = (differenceType === "Overage" ? 1 : -1) * denomValue(denomination) * units;

  // The difference is reported a couple of days into the range; the underlying deposit happened a
  // few days BEFORE that, varying per record (date and time), matching the real export where the
  // deposit column differs row to row. An isolated stream keeps deposit timing from perturbing the
  // other fields' values.
  const differenceDate = `${addDays(eddStartDate(params), 2 + (index % 5))}T00:00:00`;
  const drnd = seeded(`edd:dep:${key.eddLoadID}:${key.ncdwRecordID}:${index}`);
  const depositDay = addDays(differenceDate.slice(0, 10), -(1 + Math.floor(drnd() * 12)));
  const depositClock = `19:${String(20 + Math.floor(drnd() * 25)).padStart(2, "0")}:${String(Math.floor(drnd() * 60)).padStart(2, "0")}`;

  return {
    adviceNumber: 40 + index + (key.eddLoadID % 10),
    differenceDate,
    aba: bank.aba,
    abaName: bank.abaName,
    endpointNumber,
    depositType: EDD_DEPOSIT_TYPES[Math.floor(rnd() * EDD_DEPOSIT_TYPES.length)],
    endpointName: `${bank.abaName.split(",")[0]} ${armored}`,
    depositDate: `${depositDay}T${depositClock}`,
    depositAmount: 1_000_000 + Math.floor(rnd() * 9_000_000),
    denomination,
    denominationFound: null,
    differenceType,
    differenceAmount,
    eddLoadID: index === 0 ? key.eddLoadID : 1000 + Math.floor(rnd() * 9000),
    ncdwRecordID: index === 0 ? key.ncdwRecordID : 3003600000 + Math.floor(rnd() * 400000),
  };
}

/**
 * EDD summary. The paged view (`eddSummaryReport`) returns one page; the export
 * (`eddExportSummaryReport`, `opts.exportAll`) returns the FULL result set — all `totalEdds`
 * records — matching the real exportsummary endpoint where `reportDataList.length === totalEdds`.
 */
function eddSummaryRows(params: TaskParams, opts: { exportAll?: boolean } = {}): MockPayload {
  const key = primaryEddKey(params);
  const countSeed = seeded(`edd:count:${key.eddLoadID}`);
  const totalEdds = 5 + Math.floor(countSeed() * 20);
  const pageSize = Math.max(1, Number(params.pageSize ?? 5));
  const pageNumber = Math.max(1, Number(params.pageNumber ?? 1));
  const count = opts.exportAll ? totalEdds : Math.min(pageSize, totalEdds);
  const rows = Array.from({ length: count }, (_, i) => eddSummaryRecord(params, i, key));
  // reportId = the primary record's identifiers, which the detail call reuses (`/eddReport/detail/{reportId}`).
  const reportId = (params.reportId as string) ?? `${key.eddLoadID}_${key.ncdwRecordID}`;
  return {
    rows,
    meta: {
      totalEdds,
      reportId,
      aba: rows[0]?.aba,
      endpointNumber: rows[0]?.endpointNumber,
      denomination: params.denomination ?? rows[0]?.denomination,
      differenceType: params.differenceType ?? rows[0]?.differenceType,
      startDate: eddStartDate(params),
      endDate: eddEndDate(params),
      pageNumber,
      pageSize,
      generatedRows: rows.length,
      // Faithful raw API envelope for anyone inspecting the simulated response.
      result: { totalEdds, reportDataList: rows },
    },
  };
}

/** Parse one `${eddLoadID}_${ncdwRecordID}` pair into a record key, or fall back when malformed. */
function eddKeyFromPair(pair: string, fallback: EddKey): EddKey {
  const [loadPart, ncdwPart] = pair.split("_");
  return /^\d+_\d+$/.test(pair) ? { eddLoadID: Number(loadPart), ncdwRecordID: Number(ncdwPart) } : fallback;
}

/** Build the nested `edd` detail record (and its flat table projection) for one EDD record key. */
function buildEddDetail(
  params: TaskParams,
  key: EddKey,
  internal: boolean,
): { edd: Record<string, unknown>; flatRow: Record<string, unknown> } {
  const rnd = seeded(`edd:detail:${key.eddLoadID}_${key.ncdwRecordID}`);

  // Reconstruct the SAME summary record this key points at, so the detail is consistent with
  // what the summary listed (the real workflow: detail of a specific summary row).
  const rec = eddSummaryRecord(params, 0, key);

  const bank = { aba: String(rec.aba), abaName: String(rec.abaName) };
  const endpointNumber = String(rec.endpointNumber);
  const adminName = String(rec.endpointName);
  const office = FRB_OFFICES[Math.floor(rnd() * FRB_OFFICES.length)]!;
  const differenceDate = String(rec.differenceDate);
  const depositDate = String(rec.depositDate);

  const edd: Record<string, unknown> = {
    differenceDetail: {
      adviceNumber: rec.adviceNumber,
      differenceDate,
      denomination: rec.denomination,
      denominationFound: null,
      differenceDesc: rec.differenceType,
      differenceAmount: rec.differenceAmount,
    },
    depositDetail: {
      depositID: String(1_210_000_000 + Math.floor(rnd() * 999_999)),
      depositDate,
      depositAmount: rec.depositAmount,
      depositType: rec.depositType,
      ticketNumber: 100_000 + Math.floor(rnd() * 99_999),
      diTellerID: null,
      rsBankID: null,
    },
    adminAddress: {
      abaName: bank.abaName,
      adminName,
      address: "800 MARKET ST MO1-800-04-15",
      city: "St. Louis",
      state: "MO",
      zipCode: "63101",
    },
    forAccountAddress: {
      endpointNumber,
      abaName: bank.abaName,
      endpointNameName: adminName,
      address: "",
      city: null,
      state: null,
      zipCode: null,
    },
    cashDeptAddress: { ...office },
    additionalInfo: {
      differenceID: String(1_211_000_000 + Math.floor(rnd() * 999_999)),
      cuNumber: String(4000 + Math.floor(rnd() * 999)),
      reelNumber: String(1 + Math.floor(rnd() * 99)),
      shiftNumber: String(5000 + Math.floor(rnd() * 999)),
      cpMachineNumber: String(300 + Math.floor(rnd() * 99)),
      rsMachineNumber: null,
      processingDT: differenceDate,
      reconcilementDT: `${addDays(eddStartDate(params), 2)}T06:36:38`,
    },
    comments: null,
    strapImage: null,
    ...(internal ? { internalReview: { analystOverride: rnd() > 0.7, sarFlag: rec.differenceType === "Counterfeit" } } : {}),
  };

  // A flat projection of the record for the table view; the full nested record lives in meta.
  const dd = edd.differenceDetail as Record<string, unknown>;
  const dp = edd.depositDetail as Record<string, unknown>;
  const ai = edd.additionalInfo as Record<string, unknown>;
  const flatRow: Record<string, unknown> = {
    adviceNumber: dd.adviceNumber,
    differenceDate: dd.differenceDate,
    denomination: dd.denomination,
    differenceDesc: dd.differenceDesc,
    differenceAmount: dd.differenceAmount,
    depositID: dp.depositID,
    depositAmount: dp.depositAmount,
    depositType: dp.depositType,
    ticketNumber: dp.ticketNumber,
    abaName: bank.abaName,
    endpointNumber,
    frbOffice: office.frbOfficeName,
    differenceID: ai.differenceID,
    reelNumber: ai.reelNumber,
    processingDT: ai.processingDT,
  };

  return { edd, flatRow };
}

/**
 * EDD detail: expand the requested record(s) into their nested sections.
 *
 * The `reportId` is either ONE `${eddLoadID}_${ncdwRecordID}` pair (eddDetailReport — a single
 * record) or a comma-separated LIST of such pairs (eddExportDetailReport, e.g.
 * `489_3998240,33_8431808` — several records exported together). Each pair becomes its own entry
 * in `result.reportDataList`, matching the real API's single- and multi-record detail responses.
 */
function eddDetailRows(params: TaskParams, internal: boolean): MockPayload {
  const fallback = primaryEddKey(params);
  const reportId = (params.reportId as string) ?? `${fallback.eddLoadID}_${fallback.ncdwRecordID}`;
  const pairs = String(reportId).split(",").map((p) => p.trim()).filter(Boolean);
  const keys = pairs.map((pair) => eddKeyFromPair(pair, fallback));
  const built = keys.map((key) => buildEddDetail(params, key, internal));
  const [firstLoad, firstNcdw] = (pairs[0] ?? `${fallback.eddLoadID}_${fallback.ncdwRecordID}`).split("_");

  return {
    rows: built.map((b) => b.flatRow),
    meta: {
      reportId,
      reportIds: pairs,
      // Primary record's ids (first pair); the full list is in `reportIds`.
      eddLoadID: firstLoad,
      ncdwRecordID: firstNcdw,
      internal,
      generatedRows: built.length,
      // Primary record's nested detail (kept for single-record consumers).
      edd: built[0]!.edd,
      // Faithful raw API envelope: one `{ edd }` per requested record, matching the sample detail
      // response (single-pair → one entry; list → one entry per pair).
      result: { reportDataList: built.map((b) => ({ edd: b.edd })) },
    },
  };
}

// ── XShipReport ──────────────────────────────────────────────────────────────────
function xshipFeeRows(params: TaskParams, granularity: "detail" | "summary" | "total"): MockPayload {
  const rnd = seeded(`fee:${period(params)}:${granularity}`);
  const count = granularity === "detail" ? 15 : granularity === "summary" ? 5 : 1;
  const rows = Array.from({ length: count }, (_, i) => {
    const inst = INSTITUTIONS[i % INSTITUTIONS.length]!;
    const fee = Math.round(rnd() * 10000) / 100;
    const waived = Math.round(rnd() * 2000) / 100;
    return granularity === "total"
      ? { period: period(params), totalFeeUsd: Math.round(rnd() * 250000), totalWaivedUsd: Math.round(rnd() * 30000) }
      : {
          institution: inst,
          period: period(params),
          feeUsd: fee,
          waivedUsd: waived,
          netFeeUsd: Math.round((fee - waived) * 100) / 100,
          ...(granularity === "detail" ? { shipmentId: `SHP-${2000 + i}`, zone: ZONES[i % ZONES.length] } : {}),
        };
  });
  return { rows, meta: { period: period(params), granularity, generatedRows: rows.length } };
}

// ── XShipDownload ────────────────────────────────────────────────────────────────
function xshipActivityRows(params: TaskParams, groupBy: "aba" | "abaRollup" | "zone" | "criteria"): MockPayload {
  const rnd = seeded(`act:${period(params)}:${groupBy}:${params.abaNumber ?? params.zone ?? ""}`);
  const count = groupBy === "abaRollup" ? 4 : 10;
  const rows = Array.from({ length: count }, (_, i) => {
    const aba = params.abaNumber ?? String(110000000 + Math.floor(rnd() * 9999999)).padStart(9, "0");
    const zone = params.zone ?? ZONES[i % ZONES.length]!;
    const shipments = Math.round(rnd() * 500);
    const base: Record<string, unknown> = {
      period: period(params),
      shipments,
      volumeUnits: Math.round(rnd() * 100000),
    };
    if (groupBy === "zone") base.zone = zone;
    else base.abaNumber = aba;
    if (groupBy === "abaRollup") base.rollupShipments = shipments * (3 + Math.floor(rnd() * 4));
    if (groupBy === "criteria") {
      base.zone = zone;
      base.abaNumber = aba;
      base.criteriaMatched = rnd() > 0.5;
    }
    return base;
  });
  return { rows, meta: { period: period(params), groupBy, generatedRows: rows.length } };
}

// ── Relationship ─────────────────────────────────────────────────────────────────
function relationshipRows(params: TaskParams, scope: "abaGroup" | "aba"): MockPayload {
  const rnd = seeded(`rel:${scope}:${params.abaGroup ?? params.abaNumber ?? ""}`);
  const count = scope === "abaGroup" ? 6 : 1;
  const rows = Array.from({ length: count }, (_, i) => ({
    abaNumber: params.abaNumber ?? String(120000000 + i).padStart(9, "0"),
    abaGroup: params.abaGroup ?? `GRP-${100 + (i % 5)}`,
    parentInstitution: INSTITUTIONS[i % INSTITUTIONS.length],
    relationshipType: ["parent", "subsidiary", "affiliate"][Math.floor(rnd() * 3)],
    active: rnd() > 0.2,
  }));
  return { rows, meta: { scope, generatedRows: rows.length } };
}

// ── SCP (FedCash interface simulator — gateway backend) ────────────────────────────
// SCP's submitEasySim returns a plain-text acknowledgement echoing the control block's inputData and
// a fresh Request ID (also sent as the X-Request-ID header). This mock mirrors that exact shape so a
// GATEWAY_MOCK submit renders like the real SCP response, e.g.:
//   Request sent successfully. Request ID: <uuid>
//
//   sendFiles 100 smoke_easy EASy nocheck
function scpInputData(p: TaskParams): string {
  if (typeof p.inputData === "string") return p.inputData;
  let pl: unknown = p.payload;
  if (typeof pl === "string") {
    try {
      pl = JSON.parse(pl);
    } catch {
      pl = undefined;
    }
  }
  const fromObj = pl && typeof pl === "object" ? (pl as Record<string, unknown>).inputData : undefined;
  return typeof fromObj === "string" ? fromObj : "";
}

function scpSubmitEasy(p: TaskParams): MockPayload {
  const inputData = scpInputData(p);
  const filename = typeof p.filename === "string" ? p.filename : "";
  const requestId = mockUuid(`scp:${filename}:${inputData}`);
  const response = `Request sent successfully. Request ID: ${requestId}\n\n${inputData}`;
  return {
    rows: [{ value: response }],
    meta: {
      requestId,
      responseContentType: "text/plain",
      message: "Request sent successfully.",
      inputData,
      response, // surfaced by the report as the response body text
    },
  };
}

/** Dispatch table: useCaseId -> payload generator. */
export const MOCK_GENERATORS: Record<string, (p: TaskParams) => MockPayload> = {
  // EDD
  eddSummaryReport: (p) => eddSummaryRows(p),
  eddExportSummaryReport: (p) => eddSummaryRows(p, { exportAll: true }),
  eddDetailReport: (p) => eddDetailRows(p, false),
  eddExportDetailReport: (p) => eddDetailRows(p, false),
  eddExportDetailInternal: (p) => eddDetailRows(p, true),
  // XShipReport
  xShipInstitution: (p) => xshipFeeRows(p, "summary"),
  xShipWaiver: (p) => xshipFeeRows(p, "detail"),
  xShipFeeDetail: (p) => xshipFeeRows(p, "detail"),
  xShipFeeSummary: (p) => xshipFeeRows(p, "summary"),
  xShipFee: (p) => xshipFeeRows(p, "total"),
  currentQuarter: (p) => xshipFeeRows(p, "summary"),
  // XShipDownload
  xshipDownloadActivityAba: (p) => xshipActivityRows(p, "aba"),
  xshipDownloadActivityAbaRollup: (p) => xshipActivityRows(p, "abaRollup"),
  xshipDownloadActivityZone: (p) => xshipActivityRows(p, "zone"),
  xshipDownloadCriteriaPeriod: (p) => xshipActivityRows(p, "criteria"),
  // Relationship
  xshiFileAbaGroup: (p) => relationshipRows(p, "abaGroup"),
  xshiFileAba: (p) => relationshipRows(p, "aba"),
  // SCP (gateway backend)
  submitEasySim: (p) => scpSubmitEasy(p),
};

export function generateMock(useCase: string, params: TaskParams): MockPayload {
  const gen = MOCK_GENERATORS[useCase];
  if (!gen) throw new Error(`No mock generator for use case '${useCase}'`);
  return gen(params);
}
