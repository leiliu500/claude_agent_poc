/**
 * Static-site server: streams the chat frontend (web/) out of a PRIVATE S3 bucket through the
 * existing API Gateway, so the UI is served over HTTPS from the same origin as POST /v1/ask
 * (no public bucket, no CloudFront — which GovCloud lacks — and no CORS dependency).
 *
 * Routes (wired in the api-gateway module):
 *   GET /app            → index.html
 *   GET /app/{proxy+}   → the requested asset (styles.css, app.js, …)
 *
 * Updating the UI is just `aws s3 sync web/ s3://<bucket>` — no Lambda redeploy.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "web-serve" });

const BUCKET = process.env.WEB_BUCKET ?? "";
// Path the site is mounted at (must match the API Gateway routes). Trailing slash matters for
// the injected <base> so relative asset URLs resolve under it.
const BASE_PATH = process.env.APP_BASE_PATH ?? "/app/";

let _s3: S3Client | undefined;
const s3 = () => (_s3 ??= new S3Client({ region: process.env.AWS_REGION }));

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
};

/** Map a request path to an S3 object key, defaulting to index.html. Blocks path traversal. */
function keyFor(rawPath: string): string | null {
  const mount = BASE_PATH.replace(/\/$/, ""); // "/app"
  let rel = rawPath;
  if (rel === mount || rel === mount + "/") return "index.html";
  if (rel.startsWith(mount + "/")) rel = rel.slice(mount.length + 1);
  else rel = rel.replace(/^\//, "");
  rel = decodeURIComponent(rel);
  if (!rel) return "index.html";
  if (rel.includes("..") || rel.startsWith("/")) return null; // traversal guard
  return rel;
}

const extOf = (key: string) => key.split(".").pop()?.toLowerCase() ?? "";

function notFound(): APIGatewayProxyResultV2 {
  return { statusCode: 404, headers: { "content-type": "text/plain" }, body: "Not found" };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const rawPath = event.rawPath ?? "/";
  const key = keyFor(rawPath);
  log.info("web request", { rawPath, key });

  if (!BUCKET) return { statusCode: 500, headers: { "content-type": "text/plain" }, body: "WEB_BUCKET not configured" };
  if (!key) return notFound();

  try {
    const obj = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    let body = (await obj.Body?.transformToString("utf-8")) ?? "";

    // For the entry document, inject a <base> so relative asset URLs resolve under the mount path
    // (the same file still works at "/" for local dev, where no base is injected).
    if (extOf(key) === "html" && !/<base\b/i.test(body)) {
      body = body.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    <base href="${BASE_PATH}">`);
    }

    return {
      statusCode: 200,
      headers: {
        "content-type": obj.ContentType ?? CONTENT_TYPES[extOf(key)] ?? "application/octet-stream",
        "cache-control": extOf(key) === "html" ? "no-cache" : "public, max-age=300",
      },
      body,
    };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "AccessDenied") return notFound();
    log.error("web-serve failed", { key, error: String(err) });
    return { statusCode: 500, headers: { "content-type": "text/plain" }, body: "Internal error" };
  }
};
