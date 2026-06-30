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

const INSTITUTIONS = ["First National", "Coastal Trust", "Summit Bank", "Harbor Credit Union", "Vista Financial"];
const ZONES = ["A1", "A2", "B1", "C3", "D7"];

// ── EDD ────────────────────────────────────────────────────────────────────────
function eddRows(params: TaskParams, detail: boolean, internal: boolean): MockPayload {
  const rnd = seeded(`edd:${period(params)}:${detail}:${internal}`);
  const count = detail ? 12 : 5;
  const rows = Array.from({ length: count }, (_, i) => {
    const inst = INSTITUTIONS[i % INSTITUTIONS.length]!;
    const risk = Math.round(rnd() * 100);
    const base: Record<string, unknown> = {
      institution: inst,
      period: period(params),
      riskScore: risk,
      riskTier: risk > 70 ? "High" : risk > 40 ? "Medium" : "Low",
      flaggedCount: Math.round(rnd() * 20),
    };
    if (detail) {
      base.caseId = `EDD-${period(params)}-${1000 + i}`;
      base.reviewer = ["A.Kim", "L.Ortiz", "M.Patel"][i % 3];
      base.amountUsd = Math.round(rnd() * 500000);
    }
    if (internal) {
      base.internalNotes = `auto-flagged:${risk > 70 ? "SAR-review" : "clear"}`;
      base.analystOverride = rnd() > 0.7;
    }
    return base;
  });
  // Surface a stable reportId so the summary → detail orchestration chain has an id to pass on.
  // A detail call carries the summary's reportId in params; echo it back when present.
  const reportId = (params.reportId as string) ?? `EDD-${period(params)}-0001`;
  return {
    rows,
    meta: {
      period: period(params),
      institutionFilter: params.institutionId ?? "ALL",
      detail,
      internal,
      reportId,
      generatedRows: rows.length,
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

/** Dispatch table: useCaseId -> payload generator. */
export const MOCK_GENERATORS: Record<string, (p: TaskParams) => MockPayload> = {
  // EDD
  eddSummaryReport: (p) => eddRows(p, false, false),
  eddExportSummaryReport: (p) => eddRows(p, false, false),
  eddDetailReport: (p) => eddRows(p, true, false),
  eddExportDetailReport: (p) => eddRows(p, true, false),
  eddExportDetailInternal: (p) => eddRows(p, true, true),
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
};

export function generateMock(useCase: string, params: TaskParams): MockPayload {
  const gen = MOCK_GENERATORS[useCase];
  if (!gen) throw new Error(`No mock generator for use case '${useCase}'`);
  return gen(params);
}
