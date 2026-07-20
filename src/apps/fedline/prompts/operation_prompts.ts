/**
 * Fedline — API-specific post-dispatch agent overlays.
 *
 * The base analytics/report prompts (postdispatch_prompts.ts / postdispatch/_base.md) are the "default
 * dynamic agent" for each role — generic across all of Fedline. THIS module specializes that agent per
 * API: when the gateway invokes a specific operation (eddSummaryReport, xShipFeeDetail, …), the matching
 * overlay is appended to the base prompt at call time, turning the generic analytics/report agent into
 * an API-specific one (e.g. an "EDD summary analytics agent") for the length of that one call — then it
 * stops, exactly like the base agent.
 *
 * Prompt TEXT lives in Markdown (one file per family/operation, `## Analytics` / `## Report` sections),
 * most specific wins:
 *   1. FAMILY files (EDD.md, XShipReport.md, XShipDownload.md, Relationship.md) — one overlay per report
 *      family, shared by every operation of that family (same shape of data).
 *   2. OPERATION files (eddSummaryReport.md, eddDetailReport.md, …) — override the family for a single
 *      operationId where it diverges.
 *
 * `fedlineOverlays(role)` expands these into the per-operationId map the PostDispatchAgentSpec carries,
 * driven by the canonical USE_CASES registry (Fedline = every non-KB use case) so the overlay set stays
 * in lockstep with the operations the gateway exposes — no hand-maintained id list.
 *
 * To give another app API-specific overlays: add apps/<app>/prompts/postdispatch/<Family|op>.md files
 * and a sibling module that loads them the same way, then wire it from that backend's seed.
 */
import { USE_CASES } from "../../../shared/usecases.js";
import type { AgentType } from "../../../shared/types.js";
import { parseRolePrompts, type RolePrompts } from "./prompt-md.js";
import eddMd from "./postdispatch/EDD.md";
import xShipReportMd from "./postdispatch/XShipReport.md";
import xShipDownloadMd from "./postdispatch/XShipDownload.md";
import relationshipMd from "./postdispatch/Relationship.md";
import eddSummaryReportMd from "./postdispatch/eddSummaryReport.md";
import eddDetailReportMd from "./postdispatch/eddDetailReport.md";

/** The post-dispatch roles an overlay can target (mirrors PostDispatchAgentSpec.role). */
export type PostDispatchRole = "analytics" | "report";

// ── Family overlays — shared by every operation of a report family ───────────────────────────────
const FAMILY_OVERLAYS: Partial<Record<AgentType, RolePrompts>> = {
  EDD: parseRolePrompts(eddMd),
  XShipReport: parseRolePrompts(xShipReportMd),
  XShipDownload: parseRolePrompts(xShipDownloadMd),
  Relationship: parseRolePrompts(relationshipMd),
};

// ── Operation-specific overrides — where one API diverges from its family ─────────────────────────
const OPERATION_OVERLAYS: Record<string, RolePrompts> = {
  eddSummaryReport: parseRolePrompts(eddSummaryReportMd),
  eddDetailReport: parseRolePrompts(eddDetailReportMd),
};

/**
 * Expand the family + operation overlays into the per-operationId map a PostDispatchAgentSpec carries
 * for `role`. Driven by USE_CASES (Fedline = every non-KB use case) so the map covers exactly the
 * operations the Fedline backend registers. Operations with neither an operation-specific nor a family
 * overlay are omitted — the pipeline falls back to the base prompt + the operation's own summary.
 */
export function fedlineOverlays(role: PostDispatchRole): Record<string, string> {
  const out: Record<string, string> = {};
  for (const uc of USE_CASES) {
    if (uc.type === "KB") continue; // KB is not a Fedline backend operation
    const specific = OPERATION_OVERLAYS[uc.id]?.[role];
    const family = FAMILY_OVERLAYS[uc.type]?.[role];
    const text = specific ?? family;
    if (text) out[uc.id] = text;
  }
  return out;
}
