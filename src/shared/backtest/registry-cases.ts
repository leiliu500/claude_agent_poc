/**
 * Validation cases for an application that has NO hand-authored suite.
 *
 * Fedline's cases (cases.ts) carry realistic parameters and real table expectations — required
 * columns, numeric columns, rollups that must reconcile, params that must be echoed back. Those
 * expectations are knowledge about the backend that a registration document does not contain.
 *
 * For any other registered application all we have is its operation list, so this module derives
 * what the registry can actually justify and REFUSES to invent the rest. Two rules decide whether an
 * operation is exercised at all:
 *
 *   1. Only SAFE methods run. A validation sweep must never fire a POST/PUT/PATCH/DELETE at a
 *      registered application — "testing" an endpoint by submitting to it is a side effect, not a
 *      test. Non-GET operations are reported as skipped, with the method named.
 *   2. Only operations whose required parameters we can supply run. Without authored values a
 *      parameterised call would fail on a missing-parameter error, which measures our fixture rather
 *      than the backend. Those are skipped too, naming the parameters.
 *
 * A skip is never a pass. The summary counts them separately and the UI states what was exercised,
 * because an all-green sweep of zero operations proves nothing.
 */
import type { BackendOperation, RegisterBackendInput } from "../gateway/types.js";

/** HTTP methods that are safe to replay: no state change, so running them is observation only. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** One operation, and whether this sweep is allowed to exercise it. */
export interface RegistryCase {
  caseId: string;
  operationId: string;
  label: string;
  method: string;
  path: string;
  /** Absent ⇒ exercisable. Present ⇒ the case is reported as skipped with this reason. */
  skipReason?: string;
}

/** Required parameters we cannot fill, since a registration document carries no example values. */
function unsatisfiedParams(op: BackendOperation): string[] {
  return (op.params ?? []).filter((p) => p.required).map((p) => p.name);
}

/**
 * Derive the case list for a registered application. Every operation appears exactly once — an
 * operation that cannot be exercised is still reported, so the sweep's coverage is visible rather
 * than silently narrowed.
 */
export function registryCases(backend: RegisterBackendInput): RegistryCase[] {
  const ops = backend.operations ?? [];
  return ops.map((op) => {
    const label = op.summary?.trim() || op.operationId;
    const base = {
      caseId: `${backend.backendId}:${op.operationId}`,
      operationId: op.operationId,
      label,
      method: op.method,
      path: op.path,
    };

    if (!SAFE_METHODS.has(op.method)) {
      return {
        ...base,
        skipReason:
          `Not exercised: ${op.method} may change state on the application. A validation sweep only ` +
          `replays safe (GET/HEAD) operations — submitting to an endpoint is a side effect, not a test.`,
      };
    }

    const missing = unsatisfiedParams(op);
    if (missing.length) {
      return {
        ...base,
        skipReason:
          `Not exercised: requires ${missing.join(", ")}, and this application has no authored ` +
          `parameter values. Calling it with placeholders would test the fixture, not the backend.`,
      };
    }

    return base;
  });
}

/** How many of the derived cases this sweep can actually run. */
export const exercisableCount = (cases: RegistryCase[]): number => cases.filter((c) => !c.skipReason).length;
