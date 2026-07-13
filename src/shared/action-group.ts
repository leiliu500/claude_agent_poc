/**
 * Adapter for the Bedrock Agent *action group* Lambda contract.
 *
 * A Bedrock agent invokes an action-group Lambda with an event describing the API operation
 * (apiPath/httpMethod) plus parameters/requestBody, and expects a specific response envelope.
 * See: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-lambda.html
 *
 * Every type Lambda exposes a single operation `POST /run` with body `{ useCase, params }`.
 * This adapter parses that body, runs the task, and serialises the DispatchResult back.
 */
import type { AgentType, DispatchResult } from "./types.js";
import { coerceParams, executeTask } from "./dispatch.js";
import { isUseCaseOfType } from "./usecases.js";
import { createLogger } from "./logger.js";

const log = createLogger({ mod: "action-group" });

/** Subset of the Bedrock agent action-group invocation event we rely on. */
export interface BedrockActionEvent {
  messageVersion?: string;
  agent?: { name?: string };
  actionGroup: string;
  apiPath?: string;
  httpMethod?: string;
  function?: string;
  parameters?: Array<{ name: string; type?: string; value: string }>;
  requestBody?: {
    content?: Record<string, { properties?: Array<{ name: string; type?: string; value: string }> }>;
  };
  sessionAttributes?: Record<string, string>;
  promptSessionAttributes?: Record<string, string>;
}

export interface BedrockActionResponse {
  messageVersion: string;
  response: {
    actionGroup: string;
    apiPath?: string;
    httpMethod?: string;
    httpStatusCode: number;
    responseBody: { "application/json": { body: string } };
  };
  sessionAttributes?: Record<string, string>;
  promptSessionAttributes?: Record<string, string>;
}

/** Pull `{ useCase, params }` out of either requestBody properties or flat parameters. */
export function parseInput(event: BedrockActionEvent): { useCase: string; params: Record<string, unknown> } {
  // Preferred: OpenAPI requestBody (application/json) properties.
  const props = event.requestBody?.content?.["application/json"]?.properties;

  const flat: Record<string, string> = {};
  for (const p of props ?? []) flat[p.name] = p.value;
  for (const p of event.parameters ?? []) flat[p.name] = p.value;

  let params: Record<string, unknown> = {};
  if (typeof flat.params === "string" && flat.params.trim().startsWith("{")) {
    try {
      params = JSON.parse(flat.params);
    } catch {
      params = {};
    }
  } else {
    // Any non-useCase keys are treated as individual params.
    const { useCase: _omit, params: _omit2, ...rest } = flat;
    void _omit;
    void _omit2;
    params = rest;
  }
  return { useCase: flat.useCase ?? "", params };
}

export function envelope(
  event: BedrockActionEvent,
  httpStatusCode: number,
  body: unknown,
): BedrockActionResponse {
  return {
    messageVersion: event.messageVersion ?? "1.0",
    response: {
      actionGroup: event.actionGroup,
      apiPath: event.apiPath ?? "/run",
      httpMethod: event.httpMethod ?? "POST",
      httpStatusCode,
      responseBody: { "application/json": { body: JSON.stringify(body) } },
    },
    ...(event.sessionAttributes ? { sessionAttributes: event.sessionAttributes } : {}),
    ...(event.promptSessionAttributes ? { promptSessionAttributes: event.promptSessionAttributes } : {}),
  };
}

/**
 * Build a Lambda handler for a given type. The handler validates that the requested use case
 * belongs to this type, executes it, and returns the Bedrock action-group envelope.
 */
export function makeActionGroupHandler(type: AgentType) {
  return async (event: BedrockActionEvent): Promise<BedrockActionResponse> => {
    const { useCase, params } = parseInput(event);
    log.info("action-group invoked", { type, useCase, actionGroup: event.actionGroup });

    if (!useCase) {
      return envelope(event, 400, { status: "error", error: "Missing 'useCase' in request." });
    }
    if (!isUseCaseOfType(useCase, type)) {
      return envelope(event, 422, {
        status: "error",
        error: `Use case '${useCase}' is not a valid ${type} use case.`,
      });
    }

    const result: DispatchResult = await executeTask({
      type,
      useCase,
      params: coerceParams(params),
    });

    return envelope(event, result.status === "ok" ? 200 : 502, result);
  };
}
