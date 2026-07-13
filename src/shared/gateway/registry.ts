/**
 * Backend registry — the runtime catalog of applications the gateway can route to.
 *
 * Two backends, chosen at runtime (mirrors shared/kb.ts and shared/user-directory.ts):
 *   - Postgres + pgvector (durable): when DATABASE_URL is set, each operation's searchable text is
 *     embedded (the SAME Bedrock Titan model the KB uses) and stored in fedline.gateway_operation, so
 *     retrieval is semantic (cosine over an HNSW index via fedline.search_gateway) and the catalog
 *     survives across Lambda containers/invocations. This is the ONLY durable store — an in-memory
 *     registry lives in one process and is not shared between the register Lambda and the proxy.
 *   - In-memory (default): a process-local Map scored by lexical overlap, so tests and
 *     ORCHESTRATION_MODE=local run with zero infra and no Bedrock/AWS calls. Deterministic.
 *
 * Registration derives operations from an OpenAPI spec (see openapi.ts). Retrieval returns the
 * top-k operations most relevant to a question; the generic proxy (invoke.ts) then calls the chosen
 * one. `embedText` is reused verbatim from kb.ts so query and operation embeddings share a model+dim.
 */
import { createLogger } from "../logger.js";
import { hasDatabase, query } from "../pg.js";
import { embedText, toVectorLiteral } from "../kb.js";
import { parseOpenApi } from "./openapi.js";
import {
  operationSearchText,
  type BackendAuth,
  type BackendOperation,
  type OperationMatch,
  type RegisterBackendInput,
  type RegisteredBackend,
} from "./types.js";

const log = createLogger({ mod: "gateway-registry" });

const DEFAULT_TOP_K = 5;
const DEFAULT_AUTH: BackendAuth = { type: "none" };

// ── In-memory store (the no-database path) ───────────────────────────────────────
const MEMORY = new Map<string, RegisteredBackend>();

// ── Lexical scoring (in-memory retrieval; deterministic, dependency-free) ────────
const STOP = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "in", "on", "how", "do", "i",
  "what", "does", "with", "by", "my", "me", "can", "you", "it", "this", "that", "as", "at", "be", "get",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function lexicalScore(queryTokens: string[], docTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (docTokens.has(t)) hits++;
  return hits / queryTokens.length;
}

/** Build the RegisteredBackend from a register input (operations from the spec or supplied directly). */
function toBackend(input: RegisterBackendInput): RegisteredBackend {
  const operations: BackendOperation[] = input.operations ?? (input.openapi ? parseOpenApi(input.openapi) : []);
  if (operations.length === 0) {
    throw new Error(`Backend '${input.backendId}' has no operations (supply an OpenAPI spec or operations).`);
  }
  if (!input.baseUrl) throw new Error(`Backend '${input.backendId}' requires a baseUrl.`);
  return {
    backendId: input.backendId,
    name: input.name ?? input.backendId,
    description: input.description ?? "",
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    auth: input.auth ?? DEFAULT_AUTH,
    operations,
  };
}

// ── Postgres persistence ──────────────────────────────────────────────────────────
async function persistPostgres(b: RegisteredBackend): Promise<void> {
  await query("SELECT fedline.upsert_gateway_backend($1,$2,$3,$4,$5::jsonb)", [
    b.backendId,
    b.name,
    b.description,
    b.baseUrl,
    JSON.stringify(b.auth),
  ]);
  await query("DELETE FROM fedline.gateway_operation WHERE backend_id = $1", [b.backendId]);
  for (const op of b.operations) {
    const embedding = await embedText(operationSearchText(b.name, op));
    await query(
      `INSERT INTO fedline.gateway_operation
         (backend_id, operation_id, method, path, summary, description, params, keywords, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::vector)`,
      [
        b.backendId,
        op.operationId,
        op.method,
        op.path,
        op.summary ?? null,
        op.description ?? null,
        JSON.stringify(op.params),
        JSON.stringify(op.keywords),
        toVectorLiteral(embedding),
      ],
    );
  }
}

interface OpRow {
  operation_id: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  params: unknown;
  keywords: unknown;
}

function rowToOperation(r: OpRow): BackendOperation {
  return {
    operationId: r.operation_id,
    method: r.method as BackendOperation["method"],
    path: r.path,
    summary: r.summary ?? undefined,
    description: r.description ?? undefined,
    params: Array.isArray(r.params) ? (r.params as BackendOperation["params"]) : [],
    keywords: Array.isArray(r.keywords) ? (r.keywords as string[]) : [],
  };
}

async function loadBackendPostgres(backendId: string): Promise<RegisteredBackend | undefined> {
  const meta = await query<{ name: string; description: string; base_url: string; auth: unknown }>(
    "SELECT name, description, base_url, auth FROM fedline.gateway_backend WHERE backend_id = $1",
    [backendId],
  );
  if (meta.length === 0) return undefined;
  const ops = await query<OpRow>(
    "SELECT operation_id, method, path, summary, description, params, keywords FROM fedline.gateway_operation WHERE backend_id = $1 ORDER BY operation_id",
    [backendId],
  );
  const m = meta[0]!;
  return {
    backendId,
    name: m.name,
    description: m.description,
    baseUrl: m.base_url,
    auth: (m.auth && typeof m.auth === "object" ? m.auth : DEFAULT_AUTH) as BackendAuth,
    operations: ops.map(rowToOperation),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────────
/** Register (or replace) a backend. Persists to pgvector when a database is configured, else memory. */
export async function registerBackend(input: RegisterBackendInput): Promise<RegisteredBackend> {
  const backend = toBackend(input);
  if (hasDatabase()) {
    await persistPostgres(backend);
    log.info("registered backend (postgres)", { backendId: backend.backendId, operations: backend.operations.length });
  } else {
    MEMORY.set(backend.backendId, { ...backend, createdAt: "" });
    log.info("registered backend (memory)", { backendId: backend.backendId, operations: backend.operations.length });
  }
  return backend;
}

/** List every registered backend (metadata + operations). */
export async function listBackends(): Promise<RegisteredBackend[]> {
  if (!hasDatabase()) return [...MEMORY.values()];
  const ids = await query<{ backend_id: string }>("SELECT backend_id FROM fedline.gateway_backend ORDER BY backend_id");
  const out: RegisteredBackend[] = [];
  for (const { backend_id } of ids) {
    const b = await loadBackendPostgres(backend_id);
    if (b) out.push(b);
  }
  return out;
}

/** Fetch one backend by id. */
export async function getBackend(backendId: string): Promise<RegisteredBackend | undefined> {
  if (!hasDatabase()) return MEMORY.get(backendId);
  return loadBackendPostgres(backendId);
}

/** Remove a backend and its operations. Returns true when something was deleted. */
export async function removeBackend(backendId: string): Promise<boolean> {
  if (!hasDatabase()) return MEMORY.delete(backendId);
  const rows = await query<{ backend_id: string }>(
    "DELETE FROM fedline.gateway_backend WHERE backend_id = $1 RETURNING backend_id",
    [backendId],
  );
  return rows.length > 0;
}

async function retrievePostgres(queryText: string, topK: number): Promise<OperationMatch[]> {
  const embedding = await embedText(queryText);
  const rows = await query<{
    backend_id: string;
    backend_name: string;
    base_url: string;
    operation_id: string;
    method: string;
    path: string;
    summary: string | null;
    description: string | null;
    params: unknown;
    keywords: unknown;
    score: number;
  }>("SELECT * FROM fedline.search_gateway($1::vector, $2::int)", [toVectorLiteral(embedding), topK]);
  return rows.map((r) => ({
    backendId: r.backend_id,
    backendName: r.backend_name,
    baseUrl: r.base_url,
    operation: rowToOperation(r),
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : 0,
  }));
}

function retrieveInMemory(queryText: string, topK: number): OperationMatch[] {
  const qTokens = tokenize(queryText);
  const matches: OperationMatch[] = [];
  for (const b of MEMORY.values()) {
    for (const op of b.operations) {
      const docTokens = new Set([...op.keywords, ...tokenize(operationSearchText(b.name, op))]);
      const score = lexicalScore(qTokens, docTokens);
      if (score > 0) {
        matches.push({ backendId: b.backendId, backendName: b.name, baseUrl: b.baseUrl, operation: op, score: Number(score.toFixed(4)) });
      }
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Retrieve the operations most relevant to a question. pgvector semantic search when a database is
 * configured (best-effort: a Bedrock/DB failure degrades to lexical over the in-memory catalog), else
 * lexical scoring over the in-memory registry. Returns [] when nothing is registered/matches.
 */
export async function retrieveOperations(queryText: string, topK = DEFAULT_TOP_K): Promise<OperationMatch[]> {
  const k = topK > 0 ? Math.min(topK, 20) : DEFAULT_TOP_K;
  if (hasDatabase()) {
    try {
      return await retrievePostgres(queryText, k);
    } catch (err) {
      log.warn("pgvector gateway retrieval failed; falling back to in-memory catalog", { error: String(err) });
    }
  }
  return retrieveInMemory(queryText, k);
}

/** Test seam: drop the in-memory registry so tests start from a clean catalog. */
export function clearRegistryForTests(): void {
  MEMORY.clear();
}
