/**
 * Bedrock guardrail enforcement at the request boundary.
 *
 * Screens the user's question on the way IN and the generated answer on the way OUT, via the
 * ApplyGuardrail API. See terraform/guardrail.tf for why enforcement is explicit here rather than
 * attached inline to a model invocation — in short: it is model-independent, and it also covers the
 * deterministic local fallback path, which an inline guardrail would silently miss.
 *
 * FAIL CLOSED by default. If the guardrail cannot be evaluated — throttled, unreachable, missing
 * permission — `screen` returns a BLOCK with reason "unavailable" rather than passing the text
 * through. A control that quietly stops running while everything still looks green is worse than no
 * control, because it produces confidence that is not backed by anything. GUARDRAIL_FAIL_OPEN=true
 * inverts that trade for availability; either way the outcome is reported to the caller, so a
 * skipped screening is always visible on the trace and in the request log rather than inferred.
 *
 * No guardrail configured (GUARDRAIL_ID empty) is a different case from a guardrail that failed:
 * it means this deployment opted out, so text passes with outcome "not-configured". That keeps a
 * dev/local deployment usable without pretending it was screened.
 */
import { createLogger } from "./logger.js";
import type { AgentStep } from "./types.js";

const log = createLogger({ mod: "guardrail" });

/** What the screen did. Every value is reported; nothing is inferred from an absent field. */
export type GuardrailOutcome =
  /** Evaluated and allowed. */
  | "allowed"
  /** Evaluated and blocked by policy. */
  | "blocked"
  /** Evaluated, allowed, but the text was masked (e.g. a card number anonymised). */
  | "masked"
  /** No guardrail configured on this deployment — deliberately unscreened. */
  | "not-configured"
  /** The check could not run. Combined with fail-closed this is a block. */
  | "unavailable";

export interface GuardrailVerdict {
  outcome: GuardrailOutcome;
  /** True when the caller must not proceed with this text. */
  blocked: boolean;
  /** Policy categories that tripped, e.g. ["PROMPT_ATTACK"] — safe to log and show. */
  reasons: string[];
  /** Guardrail-supplied message for a blocked request, or our own for an unavailable check. */
  message?: string;
  /** The text to use downstream: the masked variant when the guardrail rewrote it. */
  text: string;
  latencyMs: number;
}

/** Represent one policy evaluation in the request execution trace. */
export function guardrailStep(v: GuardrailVerdict, source: "INPUT" | "OUTPUT"): AgentStep {
  const detail =
    v.outcome === "not-configured" ? "No guardrail configured on this deployment." :
    v.outcome === "unavailable" ? "Guardrail could not be evaluated." :
    v.reasons.length ? v.reasons.join(", ") : "No policy matched.";
  return {
    stage: "route",
    agent: source === "INPUT" ? "Guardrail (input)" : "Guardrail (output)",
    engine: "deterministic",
    // A screening that did not run is "skipped", never "ran".
    status: v.outcome === "not-configured" || v.outcome === "unavailable" ? "skipped" : "ran",
    detail,
    latencyMs: v.latencyMs,
  };
}

/**
 * Preserve execution order in the trace: input screening is the trust boundary, while output
 * screening runs only after the report pipeline has produced its narrative.
 */
export function guardrailTrace(
  input: GuardrailVerdict,
  pipeline: readonly AgentStep[],
  output?: GuardrailVerdict,
): AgentStep[] {
  return [
    guardrailStep(input, "INPUT"),
    ...pipeline,
    ...(output ? [guardrailStep(output, "OUTPUT")] : []),
  ];
}

const guardrailId = () => process.env.GUARDRAIL_ID?.trim() ?? "";
const guardrailVersion = () => process.env.GUARDRAIL_VERSION?.trim() || "DRAFT";
const failOpen = () => process.env.GUARDRAIL_FAIL_OPEN === "true";

/** True when this deployment has a guardrail to enforce. */
export const guardrailConfigured = (): boolean => guardrailId().length > 0;

/** Minimal structural type for the bits of the Bedrock runtime SDK used here. */
interface RuntimeSdk {
  BedrockRuntimeClient: new (cfg: { region?: string }) => { send(cmd: unknown): Promise<ApplyGuardrailOutput> };
  ApplyGuardrailCommand: new (input: unknown) => unknown;
}

interface ApplyGuardrailOutput {
  action?: string;
  outputs?: Array<{ text?: string }>;
  assessments?: Array<{
    contentPolicy?: { filters?: Array<{ type?: string; action?: string }> };
    topicPolicy?: { topics?: Array<{ name?: string; action?: string }> };
    wordPolicy?: {
      customWords?: Array<{ match?: string; action?: string }>;
      managedWordLists?: Array<{ type?: string; action?: string }>;
    };
    sensitiveInformationPolicy?: {
      piiEntities?: Array<{ type?: string; action?: string }>;
      regexes?: Array<{ name?: string; action?: string }>;
    };
  }>;
}

let _client: { send(cmd: unknown): Promise<ApplyGuardrailOutput> } | undefined;
let _Cmd: (new (input: unknown) => unknown) | undefined;

/**
 * Lazy-load the SDK. A variable specifier keeps tsc from needing @aws-sdk/client-bedrock-runtime's
 * types at build time — the Lambda runtime provides it (external in the bundle).
 */
async function sdk(): Promise<{ client: { send(cmd: unknown): Promise<ApplyGuardrailOutput> }; Cmd: new (input: unknown) => unknown }> {
  if (!_client || !_Cmd) {
    const spec = "@aws-sdk/client-bedrock-runtime";
    const mod = (await import(spec)) as unknown as RuntimeSdk;
    _client = new mod.BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION });
    _Cmd = mod.ApplyGuardrailCommand;
  }
  return { client: _client, Cmd: _Cmd };
}

/** Test seam — drops the memoised client so a test can swap the SDK. */
export function resetGuardrailClient(): void {
  _client = undefined;
  _Cmd = undefined;
}

/** Every policy category that tripped, flattened for logging and for the trace. */
function reasonsOf(out: ApplyGuardrailOutput): string[] {
  const reasons = new Set<string>();
  for (const a of out.assessments ?? []) {
    for (const f of a.contentPolicy?.filters ?? []) if (f.type) reasons.add(f.type);
    for (const t of a.topicPolicy?.topics ?? []) if (t.name) reasons.add(`TOPIC:${t.name}`);
    for (const p of a.sensitiveInformationPolicy?.piiEntities ?? []) if (p.type) reasons.add(`PII:${p.type}`);
    for (const r of a.sensitiveInformationPolicy?.regexes ?? []) if (r.name) reasons.add(`REGEX:${r.name}`);
    for (const w of a.wordPolicy?.managedWordLists ?? []) if (w.type) reasons.add(`WORD:${w.type}`);
    for (const w of a.wordPolicy?.customWords ?? []) if (w.match) reasons.add(`WORD:${w.match}`);
  }
  return [...reasons];
}

/**
 * Screen one piece of text.
 *
 * @param text   the content to evaluate
 * @param source "INPUT" for text the user supplied, "OUTPUT" for text the system generated. The
 *               guardrail applies its policies differently by source, so this must be accurate.
 */
export async function screen(text: string, source: "INPUT" | "OUTPUT"): Promise<GuardrailVerdict> {
  const started = Date.now();
  const base = { reasons: [] as string[], text, latencyMs: 0 };

  if (!guardrailConfigured()) {
    return { ...base, outcome: "not-configured", blocked: false };
  }
  // An empty string has nothing to screen and would be rejected by the API as an invalid request.
  if (!text.trim()) {
    return { ...base, outcome: "allowed", blocked: false };
  }

  try {
    const { client, Cmd } = await sdk();
    const out = await client.send(new Cmd({
      guardrailIdentifier: guardrailId(),
      guardrailVersion: guardrailVersion(),
      source,
      content: [{ text: { text } }],
    }));

    const reasons = reasonsOf(out);
    const latencyMs = Date.now() - started;

    if (out.action === "GUARDRAIL_INTERVENED") {
      // Intervention is not always a block: an ANONYMIZE action rewrites the text and lets it
      // through. The returned text is the masked variant, and using it is the whole point.
      const masked = out.outputs?.[0]?.text;
      const anonymisedOnly =
        reasons.length > 0 &&
        typeof masked === "string" &&
        masked.length > 0 &&
        !(out.assessments ?? []).some((a) =>
          (a.contentPolicy?.filters ?? []).some((f) => f.action === "BLOCKED") ||
          (a.topicPolicy?.topics ?? []).some((t) => t.action === "BLOCKED") ||
          (a.sensitiveInformationPolicy?.piiEntities ?? []).some((p) => p.action === "BLOCKED") ||
          (a.wordPolicy?.managedWordLists ?? []).some((w) => w.action === "BLOCKED") ||
          (a.wordPolicy?.customWords ?? []).some((w) => w.action === "BLOCKED"));

      if (anonymisedOnly) {
        log.info("guardrail masked content", { source, reasons });
        return { outcome: "masked", blocked: false, reasons, text: masked, latencyMs };
      }
      log.warn("guardrail blocked content", { source, reasons });
      return {
        outcome: "blocked",
        blocked: true,
        reasons,
        message: out.outputs?.[0]?.text,
        text,
        latencyMs,
      };
    }

    return { outcome: "allowed", blocked: false, reasons, text, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const detail = err instanceof Error ? err.message : String(err);
    // Loud on purpose: this is the branch where the security control is not running, and it must
    // never be diagnosable only by noticing that nothing was ever blocked.
    log.error("guardrail evaluation failed", { source, failOpen: failOpen(), error: detail });
    return {
      outcome: "unavailable",
      blocked: !failOpen(),
      reasons: ["GUARDRAIL_UNAVAILABLE"],
      message: failOpen()
        ? undefined
        : "The safety guardrail could not be evaluated, so this request was not served. Try again shortly.",
      text,
      latencyMs,
    };
  }
}
