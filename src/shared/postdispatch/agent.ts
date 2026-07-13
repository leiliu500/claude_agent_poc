/**
 * Ephemeral, in-process post-dispatch agents.
 *
 * An "agent" here is NOT a registered Bedrock collaborator or a flow node — it is a one-shot Bedrock
 * model call built at CALL TIME from an app-specific prompt (PostDispatchAgentSpec, carried as backend
 * registry metadata). It is created, run to completion over a single dispatch result, and then
 * discarded — exactly the "spawn a specialist, use it, let it stop" lifecycle. Fedline spawns two of
 * these in sequence (analytics → report); other apps (e.g. SCP) spawn none (passthrough).
 *
 * The Bedrock InvokeModel body/parse shape mirrors shared/kb.ts `generatedAnswer` verbatim so whatever
 * foundation model already works for the KB's generated-answer path works here with no extra config.
 * The call is bounded by an AbortSignal so the caller (flow-process) can stay within the HTTP sync cap
 * and fall back to the deterministic report if a model call is slow or fails.
 */
import { createLogger } from "../logger.js";
import type { PostDispatchAgentSpec } from "../gateway/types.js";

const log = createLogger({ mod: "postdispatch-agent" });

/** Generation model for post-dispatch agents (defaults to the flow's foundation model). */
const POSTDISPATCH_MODEL = process.env.POSTDISPATCH_MODEL ?? process.env.FOUNDATION_MODEL ?? "";
/** Per-agent Bedrock call timeout (ms). The pipeline also bounds the whole two-agent sequence. */
const AGENT_TIMEOUT_MS = Number(process.env.POSTDISPATCH_AGENT_TIMEOUT_MS ?? "9000");
const MAX_TOKENS = Number(process.env.POSTDISPATCH_MAX_TOKENS ?? "600");

// ── Lazy Bedrock runtime client ──────────────────────────────────────────────────
// Uses the Converse API (not raw InvokeModel): Converse is model-family agnostic — it accepts the same
// { messages, system, inferenceConfig } shape and returns the same { output.message.content[].text }
// for Nova, Claude, Llama, OpenAI-OSS (openai.gpt-oss-*), etc. — so this works against whatever
// FOUNDATION_MODEL the flow uses without hand-writing each model's native InvokeModel body.
interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
}
interface BedrockRuntimeLike {
  send(cmd: unknown, options?: unknown): Promise<ConverseResponse>;
}
let _brt: BedrockRuntimeLike | undefined;
let _ConverseCommand: (new (input: unknown) => unknown) | undefined;

async function bedrock(): Promise<{ client: BedrockRuntimeLike; Cmd: new (input: unknown) => unknown }> {
  if (!_brt || !_ConverseCommand) {
    const mod = (await import("@aws-sdk/client-bedrock-runtime")) as unknown as {
      BedrockRuntimeClient: new (cfg: { region?: string }) => BedrockRuntimeLike;
      ConverseCommand: new (input: unknown) => unknown;
    };
    const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION;
    _brt = new mod.BedrockRuntimeClient({ region });
    _ConverseCommand = mod.ConverseCommand;
  }
  return { client: _brt!, Cmd: _ConverseCommand! };
}

/** Whether a model is configured at all — the pipeline also gates on GATEWAY_MOCK for hermetic tests. */
export function postDispatchModelConfigured(): boolean {
  return Boolean(POSTDISPATCH_MODEL);
}

/**
 * Run one ephemeral post-dispatch agent: the app-specific prompt is the system instruction and the JSON
 * context is the user turn; return the model's text. Bounded by AGENT_TIMEOUT_MS. Throws on failure so
 * the pipeline can fall back to the deterministic report.
 */
export async function runDynamicAgent(spec: PostDispatchAgentSpec, context: unknown): Promise<string> {
  const modelId = spec.model ?? POSTDISPATCH_MODEL;
  if (!modelId) throw new Error("No post-dispatch model configured (set POSTDISPATCH_MODEL or FOUNDATION_MODEL).");

  const { client, Cmd } = await bedrock();
  const res = await client.send(
    new Cmd({
      modelId,
      system: [{ text: spec.prompt }],
      messages: [{ role: "user", content: [{ text: `Context (JSON):\n${JSON.stringify(context)}` }] }],
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0 },
    }),
    { abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
  );
  const text = (res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "").trim();
  if (!text) throw new Error(`Post-dispatch ${spec.role} agent returned empty text`);
  log.info("dynamic agent completed", { role: spec.role, chars: text.length });
  return text;
}

/** Test seam: drop the cached Bedrock client so env changes take effect. */
export function resetPostDispatchClientForTests(): void {
  _brt = undefined;
  _ConverseCommand = undefined;
}
