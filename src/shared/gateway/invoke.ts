/**
 * Generic HTTP proxy — the single executor that invokes ANY registered backend operation.
 *
 * This is what replaces "one bespoke Lambda per domain": given a backendId + operationId + params, it
 * resolves the operation's path template + query + body from the params, applies the backend's auth,
 * makes the outbound call, and shapes the response into the standard DispatchResult the analytics and
 * report layers already consume. Never throws — a bad request or a backend error degrades to an error
 * DispatchResult so the flow always returns a document.
 *
 * Two modes:
 *   - real fetch (default): calls `baseUrl + resolvedPath`. Node 20's global fetch + AbortController.
 *   - mock (GATEWAY_MOCK=true): returns a deterministic synthetic response echoing the resolved
 *     request, so tests and ORCHESTRATION_MODE=local run hermetically with no network.
 *
 * Egress note: to reach a public backend from inside the DB VPC the target must be VPC-reachable (a
 * private endpoint) or a NAT/egress must be added — the DB subnets have no NAT today. Internal apps
 * and VPC endpoints work as-is; external SaaS needs egress. Mock mode sidesteps this for demos/tests.
 */
import type { DispatchResult } from "../types.js";
import { createLogger } from "../logger.js";
import { getBackend } from "./registry.js";
import { MOCK_GENERATORS, generateMock } from "../../mock/data.js";
import type { BackendAuth, BackendOperation, RegisteredBackend } from "./types.js";

const log = createLogger({ mod: "gateway-invoke" });

const DEFAULT_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS ?? "10000");

export interface InvokeInput {
  backendId: string;
  operationId: string;
  params: Record<string, unknown>;
}

function present(v: unknown): v is string | number | boolean {
  return v !== undefined && v !== null && v !== "";
}

function isMockMode(): boolean {
  return (process.env.GATEWAY_MOCK ?? "").toLowerCase() === "true";
}

/** One part of a multipart/form-data body. */
export interface FormPart {
  name: string;
  value: string;
  /** Present → a file part (multipart filename). */
  filename?: string;
  /** Per-part content-type (e.g. application/json for a JSON form field, octet-stream for a file). */
  contentType?: string;
}

/** Resolve the outbound request (url, method, headers, body) for an operation + params. */
export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON request body (application/json operations). Mutually exclusive with `form`. */
  body?: string;
  /** Multipart parts (multipart/form-data operations). When set, the proxy builds a FormData body. */
  form?: FormPart[];
  /** Path params that had no value supplied. */
  missing: string[];
}

function applyAuth(headers: Record<string, string>, auth: BackendAuth): void {
  if (auth.type === "none") return;
  const value = auth.valueEnv ? process.env[auth.valueEnv] : undefined;
  if (!value) return; // secret not configured — send unauthenticated rather than a broken header
  if (auth.type === "bearer") headers[auth.header ?? "Authorization"] = `Bearer ${value}`;
  else headers[auth.header ?? "Authorization"] = value;
}

/** Resolve the multipart filename for a file param X from a companion `<X>Filename` / `filename` param. */
function fileNameFor(name: string, params: Record<string, unknown>): string {
  const explicit = params[`${name}Filename`] ?? params.filename;
  return present(explicit) ? String(explicit) : `${name}.dat`;
}

export function resolveRequest(
  backend: RegisteredBackend,
  op: BackendOperation,
  params: Record<string, unknown>,
): ResolvedRequest {
  const missing: string[] = [];
  const path = op.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = params[name];
    if (!present(v)) {
      missing.push(name);
      return `{${name}}`;
    }
    return encodeURIComponent(String(v));
  });

  const multipart =
    op.requestContentType === "multipart/form-data" || op.params.some((p) => p.in === "file" || p.in === "formField");

  const query: string[] = [];
  const jsonBody: Record<string, unknown> = {};
  const form: FormPart[] = [];
  const headers: Record<string, string> = { accept: "application/json" };

  for (const p of op.params) {
    const v = params[p.name];
    if (!present(v) && p.in !== "file") continue;
    switch (p.in) {
      case "query":
        query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(String(v))}`);
        break;
      case "header":
        headers[p.name] = String(v);
        break;
      case "body":
        jsonBody[p.name] = v;
        break;
      case "formField":
        // A form field may itself carry JSON (e.g. SCP's "payload" control block).
        form.push(
          typeof v === "object"
            ? { name: p.name, value: JSON.stringify(v), contentType: "application/json" }
            : { name: p.name, value: String(v) },
        );
        break;
      case "file":
        if (!present(v)) {
          if (p.required) missing.push(p.name);
        } else {
          form.push({ name: p.name, value: String(v), filename: fileNameFor(p.name, params), contentType: "application/octet-stream" });
        }
        break;
      default:
        break;
    }
  }

  // JSON operations set the content-type explicitly; multipart lets fetch set the boundary itself.
  if (!multipart && Object.keys(jsonBody).length) headers["content-type"] = "application/json";
  applyAuth(headers, backend.auth);

  const url = `${backend.baseUrl}${path}${query.length ? `?${query.join("&")}` : ""}`;
  return {
    method: op.method,
    url,
    headers,
    ...(multipart ? { form } : Object.keys(jsonBody).length ? { body: JSON.stringify(jsonBody) } : {}),
    missing,
  };
}

/** Build a fetch-ready FormData body from resolved multipart parts (Node 20 global FormData/Blob). */
function toFormData(parts: FormPart[]): FormData {
  const fd = new FormData();
  for (const part of parts) {
    if (part.filename) fd.append(part.name, new Blob([part.value], { type: part.contentType ?? "application/octet-stream" }), part.filename);
    else if (part.contentType) fd.append(part.name, new Blob([part.value], { type: part.contentType }));
    else fd.append(part.name, part.value);
  }
  return fd;
}

/** Shape an arbitrary JSON response into report rows: an array as-is, an object's first array field, else the object. */
function rowsFromResponse(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    for (const v of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((r) => r && typeof r === "object")) return v as Record<string, unknown>[];
    }
    return [payload as Record<string, unknown>];
  }
  return [{ value: payload }];
}

/** Truncate long string values (e.g. an uploaded file's content) so a mock echo stays compact. */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === "string" && v.length > 120 ? `${v.slice(0, 117)}… (${v.length} chars)` : v;
  }
  return out;
}

function mockResult(input: InvokeInput, req: ResolvedRequest, start: number): DispatchResult {
  // Describes the OUTBOUND request (url, method, and the multipart body when a file was attached).
  const requestMeta = {
    backendId: input.backendId,
    operationId: input.operationId,
    url: req.url,
    httpMethod: req.method,
    contentType: req.form ? "multipart/form-data" : req.body ? "application/json" : undefined,
    parts: req.form ? req.form.map((p) => (p.filename ? `${p.name} (file: ${p.filename})` : p.name)) : undefined,
    mocked: true,
    ...(req.missing.length ? { missingParams: req.missing } : {}),
  };

  // Mock adapter: when the operationId maps to a rich mock generator (Fedline's operations == the
  // canonical use cases; SCP's submitEasySim == its text ack), return that realistic response merged
  // with the request descriptor above — so routing THROUGH the gateway yields the same data the
  // retired per-domain Lambdas produced, and SCP renders like its real text acknowledgement.
  if (MOCK_GENERATORS[input.operationId]) {
    const payload = generateMock(input.operationId, input.params);
    return {
      type: "Gateway",
      useCase: input.operationId,
      status: "ok",
      data: payload.rows,
      meta: { ...payload.meta, ...requestMeta }, // request meta wins for url/method/contentType/parts
      latencyMs: Math.round(performance.now()) - start,
    };
  }
  return {
    type: "Gateway",
    useCase: input.operationId,
    status: "ok",
    data: [{ backendId: input.backendId, operationId: input.operationId, method: req.method, url: req.url, mocked: true, ...sanitizeParams(input.params) }],
    meta: requestMeta,
    latencyMs: Math.round(performance.now()) - start,
  };
}

function errorResult(input: InvokeInput, message: string, start: number): DispatchResult {
  return {
    type: "Gateway",
    useCase: input.operationId,
    status: "error",
    data: [],
    meta: { backendId: input.backendId, operationId: input.operationId },
    error: message,
    latencyMs: Math.round(performance.now()) - start,
  };
}

/**
 * Invoke a registered backend operation through the generic proxy. Resolves the backend + operation
 * from the registry, builds the outbound request, and returns a DispatchResult (never throws).
 */
export async function invokeBackend(input: InvokeInput): Promise<DispatchResult> {
  const start = Math.round(performance.now());

  const backend = await getBackend(input.backendId);
  if (!backend) return errorResult(input, `Unknown backend '${input.backendId}'. Register it first.`, start);
  const op = backend.operations.find((o) => o.operationId === input.operationId);
  if (!op) return errorResult(input, `Backend '${input.backendId}' has no operation '${input.operationId}'.`, start);

  const req = resolveRequest(backend, op, input.params);
  if (req.missing.length) {
    return errorResult(input, `Missing required path params for ${input.operationId}: ${req.missing.join(", ")}`, start);
  }

  if (isMockMode()) {
    log.info("gateway invoke (mock)", { backendId: input.backendId, operationId: input.operationId, url: req.url });
    return mockResult(input, req, start);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    // Multipart operations (e.g. SCP file submit) send a FormData body — fetch sets the boundary and
    // content-type itself. JSON operations send the pre-serialised string body.
    const body = req.form ? toFormData(req.form) : req.body;
    log.info("gateway invoke (fetch)", {
      backendId: input.backendId,
      operationId: input.operationId,
      method: req.method,
      url: req.url,
      multipart: Boolean(req.form),
    });
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body, signal: controller.signal });

    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    // Parse JSON only when the response claims JSON (or looks like it) — SCP returns text/plain, so a
    // blind JSON.parse would throw; the raw text becomes a single {value} row instead.
    let payload: unknown = text;
    if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
    }
    const rows = res.ok ? rowsFromResponse(payload) : [];
    return {
      type: "Gateway",
      useCase: input.operationId,
      status: res.ok ? "ok" : "error",
      data: rows,
      meta: {
        backendId: input.backendId,
        operationId: input.operationId,
        url: req.url,
        httpMethod: req.method,
        httpStatus: res.status,
        contentType,
        // Surface a correlation id when the backend returns one (SCP echoes X-Request-ID).
        ...(res.headers.get("x-request-id") ? { requestId: res.headers.get("x-request-id") } : {}),
        matched: rows.length,
        ...(res.ok ? {} : { response: typeof payload === "string" ? payload.slice(0, 500) : payload }),
      },
      ...(res.ok ? {} : { error: `Backend returned HTTP ${res.status}` }),
      latencyMs: Math.round(performance.now()) - start,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return errorResult(input, aborted ? `Backend call timed out after ${DEFAULT_TIMEOUT_MS}ms` : String(err), start);
  } finally {
    clearTimeout(timer);
  }
}
