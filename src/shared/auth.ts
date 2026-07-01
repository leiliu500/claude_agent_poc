/**
 * Authentication primitives — dependency-free, built only on node:crypto.
 *
 * Two concerns, kept deliberately small so the login + authorizer Lambdas stay zero-dependency
 * (consistent with the rest of the repo: aws-sdk is runtime-provided, `pg` is a lazy/external import):
 *
 *   1. Password hashing (scrypt): `hashPassword` / `verifyPassword`. Hashes are self-describing
 *      strings — `scrypt$N$r$p$saltHex$hashHex` — so the parameters travel with the hash and a
 *      constant-time comparison is used on verify. The same format is stored in Postgres
 *      (fedline.app_user.password_hash) and in the in-code directory mirror.
 *
 *   2. Stateless bearer tokens (compact JWS, HS256): `signToken` / `verifyToken`. A signed JSON
 *      payload carrying the user's identity + resolved identifiers, so the API edge can authorize a
 *      request and hand the downstream pipeline every ID it needs WITHOUT a database round-trip per
 *      request. Signature + `exp` are verified on every call; an expired token forces re-login.
 *
 * The signing secret comes from AUTH_JWT_SECRET (a Terraform-generated random value delivered via
 * env / Secrets Manager). There is no external OAuth issuer, so we sign our own HMAC tokens rather
 * than wiring API Gateway's JWT authorizer to a JWKS endpoint.
 */
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ── Password hashing (scrypt) ─────────────────────────────────────────────────

const SCRYPT_N = 16384; // CPU/memory cost (2^14)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

/** Produce a self-describing scrypt hash string: `scrypt$N$r$p$saltHex$hashHex`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verify a password against a `scrypt$...` hash string. Returns false on any malformed input. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts as [string, string, string, string, string, string];
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── Compact JWS (HS256) tokens ────────────────────────────────────────────────

/** Claims carried in a session token. `ids` holds the user's resolved identifiers. */
export interface TokenClaims {
  /** Subject — the stable user id (string form of app_user.user_id). */
  sub: string;
  /** Login handle (app_user.username). */
  username: string;
  /** Canonical display name (app_user.full_name). */
  name: string;
  /** Resolved identifiers (officeId, userAba, aba, ...), keyed by TaskParams field name. */
  ids: Record<string, string>;
  /** Issued-at / expiry — epoch seconds. */
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Sign a session token. `ttlSeconds` sets the lifetime (default 1h) and `nowSeconds` is injectable
 * so callers/tests control the clock (Lambdas pass Math.floor(Date.now()/1000)).
 */
export function signToken(
  claims: Omit<TokenClaims, "iat" | "exp">,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number,
): { token: string; expiresAt: number } {
  const iat = nowSeconds;
  const exp = nowSeconds + ttlSeconds;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ ...claims, iat, exp } satisfies TokenClaims));
  const signingInput = `${header}.${payload}`;
  const signature = sign(signingInput, secret);
  return { token: `${signingInput}.${signature}`, expiresAt: exp };
}

export type VerifyResult =
  | { valid: true; claims: TokenClaims }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify signature (constant-time) and expiry. `nowSeconds` is the current epoch-seconds clock. */
export function verifyToken(token: string, secret: string, nowSeconds: number): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${payload}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, claims };
}

/** Pull a bearer token out of an Authorization header value. Case-insensitive scheme. */
export function extractBearer(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const m = authorizationHeader.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return m?.[1];
}
