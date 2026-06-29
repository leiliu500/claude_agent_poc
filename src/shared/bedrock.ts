/**
 * Thin wrappers over the Bedrock Agent Runtime.
 *
 * In the best-practice topology the supervisor agent is a node *inside* the flow, so the
 * entrypoint only calls InvokeFlow with { question } and receives the FinalReport. The
 * InvokeAgent helper is retained for direct/standalone agent invocation (e.g. debugging).
 */
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  InvokeFlowCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import type { FinalReport } from "./types.js";
import { UpstreamError } from "./errors.js";
import { createLogger } from "./logger.js";

const log = createLogger({ mod: "bedrock" });

let _client: BedrockAgentRuntimeClient | undefined;
function client(): BedrockAgentRuntimeClient {
  if (!_client) {
    _client = new BedrockAgentRuntimeClient({
      region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION,
    });
  }
  return _client;
}

/** Invoke the Supervisor agent and return its raw completion text. */
export async function invokeSupervisor(args: {
  agentId: string;
  agentAliasId: string;
  sessionId: string;
  question: string;
}): Promise<string> {
  const cmd = new InvokeAgentCommand({
    agentId: args.agentId,
    agentAliasId: args.agentAliasId,
    sessionId: args.sessionId,
    inputText: args.question,
    enableTrace: (process.env.LOG_LEVEL ?? "info") === "debug",
  });

  let completion = "";
  try {
    const resp = await client().send(cmd);
    if (!resp.completion) throw new UpstreamError("Supervisor agent returned no completion stream");
    for await (const event of resp.completion) {
      if (event.chunk?.bytes) {
        completion += new TextDecoder().decode(event.chunk.bytes);
      }
    }
  } catch (err) {
    log.error("invokeSupervisor failed", { error: String(err) });
    throw err instanceof UpstreamError ? err : new UpstreamError(`InvokeAgent failed: ${String(err)}`);
  }
  return completion;
}

/**
 * Invoke the supervisor→dispatch→analytics→report Bedrock Flow.
 * The flow's Input node expects `{ question }`; its Output node returns the FinalReport JSON.
 */
export async function invokeFlow(args: {
  flowId: string;
  flowAliasId: string;
  question: string;
  /** Abort the flow wait after this many ms so the caller can fall back within its own deadline. */
  timeoutMs?: number;
}): Promise<FinalReport> {
  const cmd = new InvokeFlowCommand({
    flowIdentifier: args.flowId,
    flowAliasIdentifier: args.flowAliasId,
    inputs: [
      {
        nodeName: "FlowInput",
        nodeOutputName: "document",
        content: { document: { question: args.question } },
      },
    ],
  });

  // The supervisor's multi-agent dispatch can exceed the synchronous HTTP deadline. Bound the
  // wait so the entrypoint can degrade to the local pipeline before API Gateway's 30s cap.
  const abortSignal = args.timeoutMs ? AbortSignal.timeout(args.timeoutMs) : undefined;

  try {
    const resp = await client().send(cmd, abortSignal ? { abortSignal } : {});
    if (!resp.responseStream) throw new UpstreamError("Flow returned no response stream");
    let doc: unknown;
    for await (const event of resp.responseStream) {
      if (event.flowOutputEvent?.content?.document !== undefined) {
        doc = event.flowOutputEvent.content.document;
      }
      if (event.flowCompletionEvent) {
        log.debug("flow completed", { status: event.flowCompletionEvent.completionReason });
      }
    }
    if (doc === undefined) throw new UpstreamError("Flow produced no output document");
    return (typeof doc === "string" ? JSON.parse(doc) : doc) as FinalReport;
  } catch (err) {
    log.error("invokeFlow failed", { error: String(err) });
    throw err instanceof UpstreamError ? err : new UpstreamError(`InvokeFlow failed: ${String(err)}`);
  }
}
