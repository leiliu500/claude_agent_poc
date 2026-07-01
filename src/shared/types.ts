/**
 * Core domain contracts shared across every agent, Lambda and the Bedrock Flow.
 *
 * These types are the stable seam between the *agent layer* (routing/dispatch/orchestration)
 * and the *flow layer* (analytics/report). Either layer can be re-implemented as long as
 * it honours these shapes.
 */

/** The four top-level report domains. */
export type AgentType = "EDD" | "XShipReport" | "XShipDownload" | "Relationship";

export const AGENT_TYPES: readonly AgentType[] = [
  "EDD",
  "XShipReport",
  "XShipDownload",
  "Relationship",
] as const;

/** A specific task within a type (canonical, camelCase identifiers). */
export type UseCaseId = string;

/** Free-form parameters extracted from the user's question (period, aba, zone, ...). */
export interface TaskParams {
  period?: string;
  quarter?: string;
  abaNumber?: string;
  abaGroup?: string;
  zone?: string;
  institutionId?: string;
  export?: boolean;
  internal?: boolean;

  // EDD path/query params.
  officeId?: string;
  userAba?: string;
  /** Target ABA used as an EDD/XShip-export path segment (distinct from the 9-digit abaNumber). */
  aba?: string;
  endpoint?: string;
  denomination?: string;
  differenceType?: string;
  startDate?: string;
  endDate?: string;
  reportId?: string;
  pageNumber?: number;
  pageSize?: number;
  sortField?: string;
  sortOrder?: string;

  // XShipReport path params.
  rollupAbaName?: string;
  startDt?: string;
  endDt?: string;
  denomType?: string;
  formatType?: string;
  reportName?: string;

  // XShipDownload path params.
  requestId?: string;
  criteria?: string;

  [key: string]: unknown;
}

/** One unit of work the router decided to run. */
export interface TaskRequest {
  type: AgentType;
  useCase: UseCaseId;
  params: TaskParams;
}

/** Result of executing a single task (one action-group invocation). */
export interface DispatchResult {
  type: AgentType;
  useCase: UseCaseId;
  status: "ok" | "error";
  /** Tabular/record payload returned by the (mock) backend. */
  data: Record<string, unknown>[];
  /** Scalar/summary fields returned alongside the rows. */
  meta: Record<string, unknown>;
  error?: string;
  /** Wall-clock ms for the task, for observability. */
  latencyMs: number;
}

/** What the classifier/router produces from a raw question. */
export interface RoutingDecision {
  /** Primary type the question maps to. */
  type: AgentType;
  /** One or more tasks; >1 means orchestration is required. */
  tasks: TaskRequest[];
  /** True when more than one task must be orchestrated. */
  requiresOrchestration: boolean;
  /** Model/router confidence 0..1. */
  confidence: number;
  /** Human-readable explanation of the routing choice. */
  rationale: string;
}

/** Output of the analytics stage (Flow node 1). */
export interface AnalyticsResult {
  /** Per-task derived metrics keyed by `${type}:${useCase}`. */
  metrics: Record<string, AnalyticsMetric>;
  /** Cross-task aggregates when multiple tasks were orchestrated. */
  aggregate: {
    totalRows: number;
    totalTasks: number;
    okTasks: number;
    erroredTasks: number;
    notes: string[];
  };
}

export interface AnalyticsMetric {
  rowCount: number;
  /** Numeric column rollups: column -> { sum, avg, min, max }. */
  numericSummary: Record<string, NumericSummary>;
  /** Categorical column distributions: column -> value -> count. */
  categoricalSummary: Record<string, Record<string, number>>;
  highlights: string[];
}

export interface NumericSummary {
  sum: number;
  avg: number;
  min: number;
  max: number;
  count: number;
}

/** The final report returned to the user (Flow node 2 output). */
export interface FinalReport {
  reportId: string;
  title: string;
  generatedAt: string;
  question: string;
  type: AgentType;
  /** One section per executed task. */
  sections: ReportSection[];
  /** Short natural-language executive summary. */
  summary: string;
  /** Echoed routing decision for traceability. */
  routing: Pick<RoutingDecision, "type" | "requiresOrchestration" | "rationale">;
}

export interface ReportSection {
  heading: string;
  useCase: UseCaseId;
  /** Bullet highlights surfaced from analytics. */
  highlights: string[];
  /** Column order for the table render. */
  columns: string[];
  rows: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

/** API request body for POST /v1/ask. */
export interface AskRequest {
  question: string;
  sessionId?: string;
}

/** API response body. */
export interface AskResponse {
  ok: boolean;
  report?: FinalReport;
  error?: string;
  traceId: string;
}

/** The authenticated caller, resolved from the session token by the API-Gateway authorizer and
 *  handed to the entrypoint. Replaces parsing the user name + IDs out of the question text. */
export interface AuthContext {
  userId: string;
  userName: string;
  /** Resolved identifiers (officeId, userAba, aba, ...), keyed by TaskParams field name. */
  identifiers: Record<string, string>;
}

/** Request body for POST /v1/login. */
export interface LoginRequest {
  username: string;
  password: string;
}

/** Response body for POST /v1/login. On success the client stores the token + user for its session. */
export interface LoginResponse {
  ok: boolean;
  token?: string;
  /** Token expiry as epoch seconds — the client re-logs-in when the clock passes it. */
  expiresAt?: number;
  user?: {
    userId: string;
    username: string;
    fullName: string;
    identifiers: Record<string, string>;
  };
  error?: string;
}
