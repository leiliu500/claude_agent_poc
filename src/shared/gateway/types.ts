/**
 * Agentic API Gateway — core data contracts.
 *
 * A "backend" is any application registered at RUNTIME by its OpenAPI spec (no code change / redeploy
 * per app). Each backend exposes one or more "operations" (≈ an OpenAPI operation, ≈ a use case): a
 * method + path template + the params that fill it. The supervisor (or the local router) retrieves
 * the most relevant operations for a question (semantic search over the registry) and the generic
 * HTTP proxy invokes the chosen one — replacing the one-bespoke-Lambda-per-domain model with a single
 * data-driven path. Mirrors the shape of `usecases.ts` EndpointSpec/ParamSpec so the same executor,
 * report and analytics layers consume gateway results unchanged.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Where a param is placed when the proxy builds the outbound request.
 *   path/query/header — url + headers.
 *   body              — a JSON request-body field (content-type application/json).
 *   formField         — a multipart/form-data text field (its value may itself be a JSON object).
 *   file              — a multipart/form-data file part (value = file content; a companion
 *                       `<name>Filename` or `filename` param sets the multipart filename).
 */
export type ParamLocation = "path" | "query" | "body" | "header" | "formField" | "file";

/** How the proxy encodes the request body for an operation. */
export type RequestContentType = "application/json" | "multipart/form-data";

/** A single parameter a backend operation accepts (parsed from the OpenAPI spec). */
export interface BackendParam {
  name: string;
  in: ParamLocation;
  required: boolean;
  description?: string;
}

/** One invocable operation of a registered backend (≈ one OpenAPI path+method). */
export interface BackendOperation {
  /** Stable id, unique within the backend (the OpenAPI operationId, or `${method}_${path}` derived). */
  operationId: string;
  method: HttpMethod;
  /** Path template with `{param}` placeholders, relative to the backend baseUrl. */
  path: string;
  summary?: string;
  description?: string;
  params: BackendParam[];
  /** How the request body is encoded. Defaults to application/json; multipart when file/form parts. */
  requestContentType?: RequestContentType;
  /** Lowercase keywords for the deterministic (no-embedding) lexical router. */
  keywords: string[];
}

/**
 * How the proxy authenticates to a backend. MVP supports none and a static header/bearer whose value
 * is resolved at invoke time from an env var (so secrets never live in the registry). A production
 * gateway would extend this with per-caller OAuth/token vending — out of scope for the MVP.
 */
export interface BackendAuth {
  type: "none" | "header" | "bearer";
  /** Header name for type "header" (default "Authorization" for "bearer"). */
  header?: string;
  /** Name of the env var holding the secret value (NOT the secret itself). */
  valueEnv?: string;
}

/**
 * What happens AFTER the gateway proxy invokes an operation — declared per backend so each registered
 * application can diverge completely once dispatch returns. Two modes:
 *   - "passthrough": shape the raw response and return it (e.g. SCP's text ack). No extra agents.
 *   - "agents":      spawn the listed ephemeral, in-process agents in order (analytics → report), each
 *                    built at call time from its app-specific prompt, run to completion, then discarded.
 * The policy travels as backend registry metadata (durable in pgvector, or in the in-memory catalog),
 * so a new app declares its post-dispatch pipeline at registration with no code change / redeploy.
 */
export type PostDispatchMode = "passthrough" | "agents";

/** One ephemeral post-dispatch agent: an app-specific prompt run once over the dispatch result, then GC'd. */
export interface PostDispatchAgentSpec {
  /** What this agent does. "analytics" derives insights over the rows; "report" transforms them into prose. */
  role: "analytics" | "report";
  /** App-specific system/instruction prompt (stored as registry metadata). */
  prompt: string;
  /** Optional model id override (else POSTDISPATCH_MODEL / FOUNDATION_MODEL). */
  model?: string;
}

/** Per-backend post-dispatch policy. Absent ⇒ passthrough (current deterministic behavior). */
export interface PostDispatchPolicy {
  mode: PostDispatchMode;
  /** Ordered agents to spawn for mode "agents" (analytics first, report second). */
  agents?: PostDispatchAgentSpec[];
}

/** A backend application registered with the gateway. */
export interface RegisteredBackend {
  backendId: string;
  name: string;
  description: string;
  /** Base URL every operation path is resolved against (e.g. https://api.example.com). */
  baseUrl: string;
  auth: BackendAuth;
  operations: BackendOperation[];
  /** What runs after a successful invoke of this backend (per-app divergence). Absent ⇒ passthrough. */
  postDispatch?: PostDispatchPolicy;
  createdAt?: string;
}

/** Input to register (or replace) a backend. Operations may be supplied directly or via an OpenAPI spec. */
export interface RegisterBackendInput {
  backendId: string;
  name?: string;
  description?: string;
  baseUrl: string;
  auth?: BackendAuth;
  /** An OpenAPI 3 document (object) to derive operations from. */
  openapi?: unknown;
  /** Pre-parsed operations (alternative to `openapi`). */
  operations?: BackendOperation[];
  /** Optional per-app post-dispatch policy (analytics/report agents, or passthrough). */
  postDispatch?: PostDispatchPolicy;
}

/** A retrieval hit: an operation matched to a question, with its owning backend and score. */
export interface OperationMatch {
  backendId: string;
  backendName: string;
  baseUrl: string;
  operation: BackendOperation;
  /** 0..1, higher is closer. */
  score: number;
}

/** The text a backend operation is indexed/retrieved by (name + summary + params). */
export function operationSearchText(backendName: string, op: BackendOperation): string {
  return [backendName, op.operationId, op.summary ?? "", op.description ?? "", op.params.map((p) => p.name).join(" ")]
    .filter(Boolean)
    .join(" ");
}
