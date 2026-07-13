/**
 * Fedline — application-specific post-dispatch agent prompts.
 *
 * Fedline (a.k.a. "apiflc": EDD / XShip reporting & downloads / ABA relationships) runs an analyze→
 * report post-dispatch pipeline: after the gateway proxy returns Fedline report rows, two ephemeral
 * in-process agents run in order — an analytics agent that derives insights over the returned records,
 * then a report agent that transforms those insights into an executive summary (see shared/postdispatch/*).
 * Their prompts live HERE, next to the app, so Fedline's post-dispatch behaviour is owned in one place;
 * seed.ts merely wires these into the Fedline backend's `postDispatch` policy.
 *
 * To give another app its own pipeline: add apps/<app>/prompts/postdispatch_prompts.ts exporting its own
 * PostDispatchPrompts and reference it from that backend's seed.
 */

/** The ordered prompts for an application's post-dispatch agents (analytics first, then report). */
export interface PostDispatchPrompts {
  /** Analytics agent: derives insights over the returned rows + deterministic rollups. */
  analytics: string;
  /** Report agent: transforms the insights + aggregates into an executive summary. */
  report: string;
}

const ANALYTICS_PROMPT =
  "You are Fedline's analytics agent, a short-lived specialist spawned to analyse the records returned " +
  "by a single Fedline reporting API call (Enhanced Due-Diligence, XShip reporting/downloads, or ABA " +
  "relationships). You are given the user's question, the operation that ran, the returned rows, and " +
  "pre-computed deterministic rollups (exact sums/averages/distributions — trust these numbers, do not " +
  "recompute them). Derive 3–6 concise, decision-useful analytical insights: notable totals, outliers, " +
  "concentrations, risk signals or anomalies a reviewer should notice. Ground every insight in the data " +
  "provided; never invent figures. Respond with ONLY a JSON array of insight strings, e.g. " +
  '["...", "..."]. No prose, no markdown.';

const REPORT_PROMPT =
  "You are Fedline's report agent, a short-lived specialist spawned to write the executive summary of a " +
  "Fedline report. You are given the user's question, the analytics agent's insights, and the " +
  "deterministic aggregates. Write a single tight paragraph (3–5 sentences) that answers the user's " +
  "question and foregrounds the most important findings for a compliance/operations reviewer. Be " +
  "factual and specific to the numbers provided; add no data that is not present. Respond with ONLY the " +
  "summary paragraph as plain text — no headings, no bullet points, no markdown.";

/** Fedline's post-dispatch agent prompts (analytics → report). */
export const POSTDISPATCH_PROMPTS: PostDispatchPrompts = {
  analytics: ANALYTICS_PROMPT,
  report: REPORT_PROMPT,
};
