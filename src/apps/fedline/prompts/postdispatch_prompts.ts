/**
 * Fedline — base (application-wide) post-dispatch agent prompts.
 *
 * The prompt TEXT lives in Markdown (postdispatch/_base.md, `## Analytics` / `## Report` sections) so it
 * is editable as prose; this module just loads + validates it into the { analytics, report } shape the
 * pipeline expects. Per-OPERATION specialization lives in operation_prompts.ts, which appends the
 * matching family/operation overlay (postdispatch/<Family|operationId>.md) to these base prompts at
 * call time (see shared/postdispatch/pipeline.ts).
 *
 * To give another app its own base prompts: add apps/<app>/prompts/postdispatch/_base.md and load it
 * the same way from that app's prompts module.
 */
import baseMd from "./postdispatch/_base.md";
import { parseRolePrompts } from "./prompt-md.js";

/** The ordered prompts for an application's post-dispatch agents (analytics first, then report). */
export interface PostDispatchPrompts {
  /** Analytics agent: derives insights over the returned rows + deterministic rollups. */
  analytics: string;
  /** Report agent: transforms the insights + aggregates into an executive summary. */
  report: string;
}

const base = parseRolePrompts(baseMd);
if (!base.analytics || !base.report) {
  throw new Error("postdispatch/_base.md must define both an '## Analytics' and a '## Report' section.");
}

/** Fedline's base post-dispatch agent prompts (analytics → report). */
export const POSTDISPATCH_PROMPTS: PostDispatchPrompts = {
  analytics: base.analytics,
  report: base.report,
};
