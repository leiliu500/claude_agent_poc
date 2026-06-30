/**
 * DBAgent action group — the collaborator the Supervisor invokes to resolve a *user name* into the
 * IDs that fill downstream API calls (ABA, userAba, abaGroup, rollupAbaName, ...).
 *
 * Operation: POST /run with { operation: "lookupUserIdentifiers", params: { userName } }.
 * Returns { found, fullName?, identifiers } where identifiers is { id_type -> id_value }, keyed by
 * TaskParams field names so the Supervisor can merge them straight into each collaborator task.
 *
 * The lookup itself lives in shared/user-directory (Postgres when DATABASE_URL is set, else the
 * in-code mirror of db/schema.sql), so this Lambda is a thin Bedrock-contract adapter.
 */
import { lookupUserIdentifiers } from "../../../shared/user-directory.js";
import { createLogger } from "../../../shared/logger.js";

const log = createLogger({ mod: "action-db" });

interface BedrockActionEvent {
  messageVersion?: string;
  actionGroup: string;
  apiPath?: string;
  httpMethod?: string;
  parameters?: Array<{ name: string; type?: string; value: string }>;
  requestBody?: {
    content?: Record<string, { properties?: Array<{ name: string; type?: string; value: string }> }>;
  };
  sessionAttributes?: Record<string, string>;
  promptSessionAttributes?: Record<string, string>;
}

interface BedrockActionResponse {
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

/** Flatten requestBody properties + flat parameters into a single map. */
function readFields(event: BedrockActionEvent): Record<string, string> {
  const flat: Record<string, string> = {};
  const props = event.requestBody?.content?.["application/json"]?.properties;
  for (const p of props ?? []) flat[p.name] = p.value;
  for (const p of event.parameters ?? []) flat[p.name] = p.value;
  return flat;
}

/** Resolve the userName field, tolerating a JSON-encoded `params` blob or flat keys. */
function readUserName(fields: Record<string, string>): string {
  if (typeof fields.params === "string" && fields.params.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(fields.params) as { userName?: unknown };
      if (typeof parsed.userName === "string") return parsed.userName.trim();
    } catch {
      /* fall through to flat keys */
    }
  }
  return (fields.userName ?? fields.user ?? "").trim();
}

function envelope(event: BedrockActionEvent, httpStatusCode: number, body: unknown): BedrockActionResponse {
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

export const handler = async (event: BedrockActionEvent): Promise<BedrockActionResponse> => {
  const fields = readFields(event);
  const userName = readUserName(fields);
  log.info("db lookup invoked", { actionGroup: event.actionGroup, hasUserName: Boolean(userName) });

  // The Supervisor must validate the user request: a missing user name is a 400 the agent surfaces.
  if (!userName) {
    return envelope(event, 400, {
      status: "error",
      error: "Missing 'userName'. A user name is required to resolve identifiers.",
    });
  }

  const lookup = await lookupUserIdentifiers(userName);
  if (!lookup.found) {
    return envelope(event, 404, {
      status: "error",
      found: false,
      error: `Unknown user '${userName}'. No identifiers on file.`,
    });
  }

  return envelope(event, 200, {
    status: "ok",
    found: true,
    fullName: lookup.fullName ?? userName,
    identifiers: lookup.identifiers,
  });
};
