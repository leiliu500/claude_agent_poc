/**
 * Normalise Bedrock token counters and price them at invocation time.
 *
 * Token counts always come from Bedrock; this module never estimates them from text length. Dollar
 * cost is an estimate because negotiated/provisioned rates may differ from public on-demand pricing.
 * Override rates with MODEL_PRICING_JSON, keyed by model id, with USD per-million-token rates:
 * {"model-id":{"input":0.18,"output":0.72}}
 */
import type { ModelUsage } from "./types.js";

export interface RawTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface Rate {
  input: number;
  output: number;
}

/** Public standard on-demand baselines; MODEL_PRICING_JSON wins for deployment-specific pricing. */
const BUILTIN_RATES: Record<string, Rate> = {
  "openai.gpt-oss-20b-1:0": { input: 0.07, output: 0.30 },
  "openai.gpt-oss-120b-1:0": { input: 0.15, output: 0.60 },
  "amazon.titan-embed-text-v2:0": { input: 0.02, output: 0 },
};

let cachedRaw: string | undefined;
let cachedOverrides: Record<string, Rate> = {};

function overrides(): Record<string, Rate> {
  const raw = process.env.MODEL_PRICING_JSON ?? "";
  if (raw === cachedRaw) return cachedOverrides;
  cachedRaw = raw;
  cachedOverrides = {};
  if (!raw) return cachedOverrides;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<Rate>>;
    for (const [model, rate] of Object.entries(parsed)) {
      if (Number.isFinite(rate.input) && Number.isFinite(rate.output) && rate.input! >= 0 && rate.output! >= 0) {
        cachedOverrides[model] = { input: rate.input!, output: rate.output! };
      }
    }
  } catch {
    // Invalid pricing must not break inference. Tokens remain visible but the cost is left unknown.
  }
  return cachedOverrides;
}

/** Strip inference-profile ARN/prefixes while retaining the provider model id when possible. */
function canonicalModel(model: string): string {
  const profileTail = model.split("/").pop() ?? model;
  return profileTail.replace(/^(?:us|us-gov|eu|apac)\./, "");
}

function rateFor(model: string): Rate | undefined {
  const configured = overrides();
  return configured[model] ?? configured[canonicalModel(model)] ?? BUILTIN_RATES[canonicalModel(model)];
}

/** Create one validated, priced usage observation from a Bedrock response. */
export function modelUsage(model: string, operation: string, raw?: RawTokenUsage | null): ModelUsage | undefined {
  if (!raw) return undefined;
  const inputTokens = Math.max(0, Math.round(raw.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.round(raw.outputTokens ?? 0));
  const totalTokens = Math.max(inputTokens + outputTokens, Math.round(raw.totalTokens ?? 0));
  if (!Number.isFinite(totalTokens) || totalTokens === 0) return undefined;
  const rate = rateFor(model);
  const costUsd = rate ? (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000 : undefined;
  return {
    model,
    operation,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** Defensive normaliser for usage arrays crossing JSON/Lambda boundaries. */
export function validModelUsage(value: unknown): ModelUsage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((u): u is ModelUsage => {
    if (!u || typeof u !== "object") return false;
    const v = u as Partial<ModelUsage>;
    return typeof v.model === "string" && typeof v.operation === "string" &&
      typeof v.inputTokens === "number" && typeof v.outputTokens === "number" &&
      typeof v.totalTokens === "number";
  });
}

/**
 * Incrementally extracts model invocation counters from Bedrock Agent trace parts embedded in an
 * InvokeFlow dependency trace. Inputs and outputs arrive as separate events, linked by traceId.
 */
export class AgentTraceUsageCollector {
  private readonly models = new Map<string, string>();
  private readonly pending = new Map<string, { operation: string; raw: RawTokenUsage }>();
  private readonly seen = new Set<string>();
  private readonly embeddedSeen = new Set<string>();

  private embeddedUsage(node: Record<string, unknown>, kind: string): ModelUsage[] {
    const observation = node.observation && typeof node.observation === "object"
      ? node.observation as Record<string, unknown>
      : undefined;
    const actionOutput = observation?.actionGroupInvocationOutput && typeof observation.actionGroupInvocationOutput === "object"
      ? observation.actionGroupInvocationOutput as Record<string, unknown>
      : undefined;
    if (typeof actionOutput?.text !== "string") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(actionOutput.text);
    } catch {
      return [];
    }
    const found: ModelUsage[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const obj = value as Record<string, unknown>;
      for (const usage of validModelUsage(obj.modelUsage)) {
        const fingerprint = [observation?.traceId ?? kind, usage.model, usage.operation,
          usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.costUsd ?? "unpriced"].join("|");
        if (this.embeddedSeen.has(fingerprint)) continue;
        this.embeddedSeen.add(fingerprint);
        found.push(usage);
      }
      for (const child of Object.values(obj)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === "object") visit(child);
      }
    };
    visit(parsed);
    return found;
  }

  accept(value: unknown): ModelUsage[] {
    if (!value || typeof value !== "object") return [];
    const part = value as Record<string, unknown>;
    const trace = part.trace && typeof part.trace === "object" ? part.trace as Record<string, unknown> : part;
    const out: ModelUsage[] = [];

    for (const [kind, nodeValue] of Object.entries(trace)) {
      if (!nodeValue || typeof nodeValue !== "object" || kind === "$unknown") continue;
      const node = nodeValue as Record<string, unknown>;
      const input = node.modelInvocationInput as Record<string, unknown> | undefined;
      const output = node.modelInvocationOutput as Record<string, unknown> | undefined;
      out.push(...this.embeddedUsage(node, kind));
      const inputId = typeof input?.traceId === "string" ? input.traceId : undefined;
      const outputId = typeof output?.traceId === "string" ? output.traceId : undefined;
      const model = typeof input?.foundationModel === "string" ? input.foundationModel : undefined;
      if (inputId && model) {
        this.models.set(inputId, model);
        const waiting = this.pending.get(inputId);
        if (waiting) {
          const usage = modelUsage(model, waiting.operation, waiting.raw);
          if (usage) out.push(usage);
          this.pending.delete(inputId);
          this.seen.add(inputId);
        }
      }
      if (!output || !outputId || this.seen.has(outputId)) continue;
      const metadata = output.metadata && typeof output.metadata === "object"
        ? output.metadata as Record<string, unknown>
        : {};
      const rawValue = metadata.usage && typeof metadata.usage === "object"
        ? metadata.usage as RawTokenUsage
        : metadata as RawTokenUsage;
      const raw: RawTokenUsage = {
        inputTokens: rawValue.inputTokens,
        outputTokens: rawValue.outputTokens,
        totalTokens: rawValue.totalTokens,
      };
      const operation = `flow-agent-${kind.replace(/Trace$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
      const knownModel = this.models.get(outputId) ?? process.env.FOUNDATION_MODEL ?? process.env.POSTDISPATCH_MODEL;
      if (knownModel) {
        const usage = modelUsage(knownModel, operation, raw);
        if (usage) out.push(usage);
        this.seen.add(outputId);
      } else {
        this.pending.set(outputId, { operation, raw });
      }
    }
    return out;
  }
}
