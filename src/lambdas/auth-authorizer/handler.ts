/**
 * API Gateway (HTTP API) Lambda authorizer — the auth/authz gate that sits RIGHT AT THE EDGE,
 * in front of the Bedrock-flow entrypoint. Step (2) of the auth flow.
 *
 * Attached to `POST /v1/ask`, it runs before the entrypoint integration on every request:
 *   1. Pull the bearer token from the Authorization header.
 *   2. Verify its HS256 signature and expiry (shared/auth.verifyToken). Expired/invalid -> deny,
 *      the gateway returns 401 and the entrypoint Lambda is never invoked.
 *   3. On success, return the decoded identity + identifiers as authorizer `context`, which the
 *      gateway forwards to the entrypoint under event.requestContext.authorizer.lambda. The
 *      identifiers are JSON-stringified because HTTP API authorizer context values must be strings.
 *
 * Uses the HTTP API "simple response" format ({ isAuthorized, context }); enable that on the
 * aws_apigatewayv2_authorizer with enable_simple_responses = true + payload format 2.0.
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";
import { extractBearer, verifyToken } from "../../shared/auth.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "auth-authorizer" });

/** Context forwarded to the entrypoint. All values are strings (HTTP API requirement). */
interface AuthorizerContext {
  userId: string;
  userName: string;
  username: string;
  /** JSON-encoded identifiers map. */
  ids: string;
  [key: string]: string;
}

const DENY: APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext> = {
  isAuthorized: false,
  context: { userId: "", userName: "", username: "", ids: "{}" },
};

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext>> => {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    log.error("AUTH_JWT_SECRET not configured; denying");
    return DENY;
  }

  // Header names are lower-cased by API Gateway; identitySource may also carry the raw value.
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? event.identitySource?.[0];
  const token = extractBearer(header);
  if (!token) {
    log.info("no bearer token; denying");
    return DENY;
  }

  const result = verifyToken(token, secret, Math.floor(Date.now() / 1000));
  if (!result.valid) {
    log.info("token rejected", { reason: result.reason });
    return DENY;
  }

  const { claims } = result;
  log.info("authorized", { userId: claims.sub, username: claims.username });
  return {
    isAuthorized: true,
    context: {
      userId: claims.sub,
      userName: claims.name,
      username: claims.username,
      ids: JSON.stringify(claims.ids ?? {}),
    },
  };
};
