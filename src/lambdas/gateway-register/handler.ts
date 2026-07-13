/**
 * Gateway registration admin Lambda (direct-invoke + S3-triggered).
 *
 * Registers/lists/removes the applications the Agentic API Gateway can route to. Registration derives
 * a backend's operations from its OpenAPI spec and persists them (with embeddings) into the pgvector
 * registry — so a new app becomes routable with NO code change or redeploy. Durable registration
 * requires DATABASE_URL (an in-memory registry lives in one process and isn't shared with the proxy).
 *
 * Invocation shapes:
 *   Direct invoke (admin/CLI):
 *     { action: "register", backendId, name?, description?, baseUrl, auth?, openapi | operations }
 *     { action: "list" }                      → registered backends (summaries)
 *     { action: "get", backendId }            → one backend (full)
 *     { action: "remove", backendId }         → delete a backend
 *   S3 ObjectCreated: the object is a registration document (JSON):
 *     { backendId, name?, description?, baseUrl, auth?, openapi }
 *   dropped into the specs bucket — one file per backend (see terraform/gateway.tf).
 */
import { registerBackend, listBackends, getBackend, removeBackend } from "../../shared/gateway/registry.js";
import { seedBuiltinBackends } from "../../shared/gateway/seed.js";
import { hasDatabase } from "../../shared/pg.js";
import { createLogger } from "../../shared/logger.js";
import type { RegisterBackendInput } from "../../shared/gateway/types.js";

const log = createLogger({ mod: "gateway-register" });

interface DirectInvoke extends Partial<RegisterBackendInput> {
  action?: "register" | "list" | "get" | "remove" | "seed";
}
interface S3EventRecord {
  s3?: { bucket?: { name?: string }; object?: { key?: string } };
}
interface Event extends DirectInvoke {
  Records?: S3EventRecord[];
}

// ── S3 client (SDK provided by the Lambda runtime; lazily constructed) ──────────
interface S3Like {
  send(cmd: unknown): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>;
}
let _s3: S3Like | undefined;
let _Get: (new (input: unknown) => unknown) | undefined;

async function s3(): Promise<{ client: S3Like; Get: new (input: unknown) => unknown }> {
  if (!_s3 || !_Get) {
    const mod = (await import("@aws-sdk/client-s3")) as unknown as {
      S3Client: new (cfg: { region?: string }) => S3Like;
      GetObjectCommand: new (input: unknown) => unknown;
    };
    _s3 = new mod.S3Client({ region: process.env.AWS_REGION });
    _Get = mod.GetObjectCommand;
  }
  return { client: _s3!, Get: _Get! };
}

async function readSpecDoc(bucket: string, key: string): Promise<RegisterBackendInput> {
  const { client, Get } = await s3();
  const res = await client.send(new Get({ Bucket: bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  const text = bytes ? new TextDecoder("utf-8").decode(bytes) : "";
  const doc = JSON.parse(text) as RegisterBackendInput;
  if (!doc.backendId) doc.backendId = key.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return doc;
}

/** A compact, secret-free summary of a backend for list/register responses. */
function summarize(b: Awaited<ReturnType<typeof getBackend>>) {
  if (!b) return undefined;
  return {
    backendId: b.backendId,
    name: b.name,
    baseUrl: b.baseUrl,
    authType: b.auth.type,
    operations: b.operations.map((o) => ({ operationId: o.operationId, method: o.method, path: o.path })),
  };
}

export const handler = async (event: Event): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
  try {
    // S3-triggered: register every dropped registration document.
    if (event.Records?.length) {
      if (!hasDatabase()) return { ok: false, error: "DATABASE_URL is not set — gateway registration needs the pgvector registry." };
      const registered: string[] = [];
      for (const r of event.Records) {
        const bucket = r.s3?.bucket?.name;
        const key = r.s3?.object?.key ? decodeURIComponent(r.s3.object.key.replace(/\+/g, " ")) : undefined;
        if (!bucket || !key) continue;
        const doc = await readSpecDoc(bucket, key);
        const b = await registerBackend(doc);
        registered.push(b.backendId);
      }
      return { ok: true, result: { registered } };
    }

    const action = event.action ?? "register";
    log.info("gateway-register invoked", { action, backendId: event.backendId });

    switch (action) {
      case "seed": {
        if (!hasDatabase()) return { ok: false, error: "DATABASE_URL is not set — durable seeding needs the pgvector registry." };
        return { ok: true, result: { seeded: await seedBuiltinBackends() } };
      }
      case "list":
        return { ok: true, result: (await listBackends()).map((b) => summarize(b)) };
      case "get": {
        if (!event.backendId) return { ok: false, error: "'backendId' is required for get." };
        const b = await getBackend(event.backendId);
        return b ? { ok: true, result: summarize(b) } : { ok: false, error: `Unknown backend '${event.backendId}'.` };
      }
      case "remove": {
        if (!event.backendId) return { ok: false, error: "'backendId' is required for remove." };
        const removed = await removeBackend(event.backendId);
        return { ok: removed, result: { removed }, error: removed ? undefined : `Unknown backend '${event.backendId}'.` };
      }
      case "register": {
        if (!hasDatabase()) return { ok: false, error: "DATABASE_URL is not set — durable registration needs the pgvector registry." };
        if (!event.backendId || !event.baseUrl) return { ok: false, error: "'backendId' and 'baseUrl' are required for register." };
        const b = await registerBackend(event as RegisterBackendInput);
        return { ok: true, result: summarize(b) };
      }
      default:
        return { ok: false, error: `Unknown action '${action}'.` };
    }
  } catch (err) {
    log.error("gateway-register failed", { error: String(err) });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
