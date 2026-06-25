/** Typed errors that map cleanly to HTTP status codes at the API boundary. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message, 400);
    this.name = "ValidationError";
  }
}

export class RoutingError extends AppError {
  constructor(message: string) {
    super("ROUTING_ERROR", message, 422);
    this.name = "RoutingError";
  }
}

export class UpstreamError extends AppError {
  constructor(message: string) {
    super("UPSTREAM_ERROR", message, 502);
    this.name = "UpstreamError";
  }
}

export function toErrorBody(err: unknown): { statusCode: number; code: string; message: string } {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : "Unexpected error",
  };
}
