/**
 * Minimal OpenAPI 3 → BackendOperation[] parser.
 *
 * The gateway registers any application by its OpenAPI spec; this turns that spec into the concrete
 * operations the proxy can invoke and the router can retrieve. Deliberately dependency-free and
 * lenient: it extracts what the MVP needs (method, path, operationId, params, summary) and ignores
 * the rest (schemas, security schemes, servers/components resolution beyond a shallow pass). A
 * malformed operation is skipped, not fatal, so one bad path doesn't reject a whole spec.
 */
import type { BackendOperation, BackendParam, HttpMethod, ParamLocation, RequestContentType } from "./types.js";

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
}
interface OpenApiSchemaProp {
  description?: string;
  /** OpenAPI "binary" format marks a file upload (multipart). */
  format?: string;
  type?: string;
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: { required?: string[]; properties?: Record<string, OpenApiSchemaProp> } }>;
  };
}
type OpenApiPathItem = Record<string, OpenApiOperation | unknown>;
interface OpenApiDoc {
  paths?: Record<string, OpenApiPathItem>;
}

/** Lowercase, de-duplicated keyword tokens for the lexical (no-embedding) router. */
function keywordsOf(parts: string[]): string[] {
  const seen = new Set<string>();
  for (const part of parts) {
    for (const tok of part.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)) {
      if (tok.length > 1) seen.add(tok);
    }
  }
  return [...seen];
}

/** Derive a stable operationId when the spec omits one: `${method}_${path}` slugified. */
function deriveOperationId(method: string, path: string): string {
  const slug = path.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${method.toLowerCase()}_${slug || "root"}`;
}

/** Extract the `{name}` placeholders declared in a path template. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

/** Body params + the content-type to encode them with. Handles JSON and multipart (file uploads). */
function bodyParams(op: OpenApiOperation): { params: BackendParam[]; contentType?: RequestContentType } {
  const content = op.requestBody?.content;
  if (!content) return { params: [] };

  const multipart = content["multipart/form-data"]?.schema;
  if (multipart?.properties) {
    const required = new Set(multipart.required ?? []);
    const params = Object.entries(multipart.properties).map(([name, prop]) => ({
      name,
      // A "binary"-format property is a file part; every other property is a text form field.
      in: (prop?.format === "binary" ? "file" : "formField") as ParamLocation,
      required: required.has(name),
      description: prop?.description,
    }));
    return { params, contentType: "multipart/form-data" };
  }

  const json = content["application/json"]?.schema;
  if (json?.properties) {
    const required = new Set(json.required ?? []);
    const params = Object.entries(json.properties).map(([name, prop]) => ({
      name,
      in: "body" as ParamLocation,
      required: required.has(name),
      description: prop?.description,
    }));
    return { params, contentType: "application/json" };
  }
  return { params: [] };
}

function paramsOf(op: OpenApiOperation, path: string): { params: BackendParam[]; contentType?: RequestContentType } {
  const out: BackendParam[] = [];
  const seen = new Set<string>();
  for (const p of op.parameters ?? []) {
    if (!p.name || seen.has(p.name)) continue;
    const loc = (p.in === "path" || p.in === "query" || p.in === "header" ? p.in : "query") as ParamLocation;
    out.push({ name: p.name, in: loc, required: Boolean(p.required) || loc === "path", description: p.description });
    seen.add(p.name);
  }
  // Any path placeholder not declared as a parameter is still required to build the URL.
  for (const name of pathParamNames(path)) {
    if (!seen.has(name)) {
      out.push({ name, in: "path", required: true });
      seen.add(name);
    }
  }
  const body = bodyParams(op);
  for (const b of body.params) {
    if (!seen.has(b.name)) {
      out.push(b);
      seen.add(b.name);
    }
  }
  return { params: out, contentType: body.contentType };
}

/**
 * Parse an OpenAPI 3 document into BackendOperation[]. Accepts the doc as a parsed object (callers
 * that hold a JSON string should JSON.parse first). Returns [] for a doc with no usable paths.
 */
export function parseOpenApi(doc: unknown): BackendOperation[] {
  const paths = (doc as OpenApiDoc | undefined)?.paths;
  if (!paths || typeof paths !== "object") return [];

  const ops: BackendOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const raw = (item as OpenApiPathItem)[method.toLowerCase()];
      if (!raw || typeof raw !== "object") continue;
      const op = raw as OpenApiOperation;
      const operationId = op.operationId?.trim() || deriveOperationId(method, path);
      const { params, contentType } = paramsOf(op, path);
      ops.push({
        operationId,
        method,
        path,
        summary: op.summary,
        description: op.description,
        params,
        ...(contentType && contentType !== "application/json" ? { requestContentType: contentType } : {}),
        keywords: keywordsOf([operationId, op.summary ?? "", op.description ?? "", path, ...params.map((p) => p.name)]),
      });
    }
  }
  return ops;
}
