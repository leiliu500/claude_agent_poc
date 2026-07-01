/**
 * Login endpoint — POST /v1/login  { username, password }  ->  { ok, token, expiresAt, user }.
 *
 * Step (1) of the auth flow: the client posts credentials, this Lambda verifies them against the
 * user store (Postgres when DATABASE_URL is set, else the in-code directory mirror), then mints a
 * signed session token that CARRIES the user's resolved identifiers (officeId, userAba, aba, ...).
 * The client stores the token and replays it on every /v1/ask call, so the user never types their
 * name or IDs into the question.
 *
 * This route is intentionally UNAUTHENTICATED at the gateway (it is how you obtain a token). It
 * returns a single generic 401 for any bad-credentials case (unknown user or wrong password) so it
 * cannot be used to enumerate valid usernames.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { LoginRequest, LoginResponse } from "../../shared/types.js";
import { verifyUserCredentials } from "../../shared/user-directory.js";
import { signToken } from "../../shared/auth.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "auth-login" });

const CORS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

function respond(statusCode: number, body: LoginResponse): APIGatewayProxyResultV2 {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2): LoginRequest {
  let raw = event.body ?? "{}";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(raw) as Partial<LoginRequest>;
  return {
    username: typeof parsed.username === "string" ? parsed.username.trim() : "",
    password: typeof parsed.password === "string" ? parsed.password : "",
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Preflight (the gateway also has CORS config, but answer defensively).
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    log.error("AUTH_JWT_SECRET not configured");
    return respond(500, { ok: false, error: "Auth is not configured." });
  }
  const ttlSeconds = Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? "3600");

  let creds: LoginRequest;
  try {
    creds = parseBody(event);
  } catch {
    return respond(400, { ok: false, error: "Request body must be valid JSON." });
  }
  if (!creds.username || !creds.password) {
    return respond(400, { ok: false, error: "Both 'username' and 'password' are required." });
  }

  const check = await verifyUserCredentials(creds.username, creds.password);
  if (!check.ok) {
    log.info("login rejected", { username: creds.username });
    return respond(401, { ok: false, error: "Invalid username or password." });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const { token, expiresAt } = signToken(
    {
      sub: check.userId!,
      username: check.username!,
      name: check.fullName!,
      ids: check.identifiers,
    },
    secret,
    ttlSeconds,
    nowSeconds,
  );

  log.info("login ok", { username: check.username, userId: check.userId, idCount: Object.keys(check.identifiers).length });
  return respond(200, {
    ok: true,
    token,
    expiresAt,
    user: {
      userId: check.userId!,
      username: check.username!,
      fullName: check.fullName!,
      identifiers: check.identifiers,
    },
  });
};
