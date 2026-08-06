/**
 * The registry-derived validation suite — what a sweep may do to an application nobody authored
 * expectations for.
 *
 * Two rules are safety-critical and pinned here:
 *   1. A validation sweep must never fire a non-GET operation at a registered application.
 *      "Testing" a submit endpoint by submitting to it is a side effect, not a test.
 *   2. An operation whose required parameters have no authored values is not exercised, because a
 *      placeholder call measures our fixture rather than the backend.
 *
 * Both produce a SKIP with a stated reason — never a pass, and never a silent omission.
 */
import { describe, it, expect } from "vitest";
import { registryCases, exercisableCount } from "../shared/backtest/registry-cases.js";
import { builtinBackends } from "../shared/gateway/seed.js";
import type { BackendOperation, RegisterBackendInput } from "../shared/gateway/types.js";

const op = (over: Partial<BackendOperation>): BackendOperation => ({
  operationId: "getThing",
  method: "GET",
  path: "/thing",
  params: [],
  keywords: [],
  ...over,
});

const backend = (ops: BackendOperation[]): RegisterBackendInput => ({
  backendId: "demo",
  name: "Demo App",
  baseUrl: "https://demo.example",
  operations: ops,
});

describe("registry-derived validation cases", () => {
  it("exercises a safe, parameterless operation", () => {
    const [c] = registryCases(backend([op({ operationId: "listThings" })]));
    expect(c?.skipReason).toBeUndefined();
    expect(c?.operationId).toBe("listThings");
  });

  it("refuses to fire a state-changing method, and says so", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const [c] = registryCases(backend([op({ method, operationId: "submit" })]));
      expect(c?.skipReason, `${method} must be skipped`).toBeDefined();
      expect(c?.skipReason).toContain(method);
      expect(c?.skipReason).toMatch(/side effect, not a test/);
    }
  });

  it("treats HEAD as safe alongside GET", () => {
    const [c] = registryCases(backend([op({ method: "HEAD" as BackendOperation["method"] })]));
    expect(c?.skipReason).toBeUndefined();
  });

  it("skips an operation whose required parameters have no authored values, naming them", () => {
    const [c] = registryCases(backend([op({
      params: [
        { name: "officeId", in: "path", required: true },
        { name: "aba", in: "query", required: true },
        { name: "note", in: "query", required: false },
      ],
    })]));
    expect(c?.skipReason).toBeDefined();
    expect(c?.skipReason).toContain("officeId");
    expect(c?.skipReason).toContain("aba");
    // An optional parameter is not a reason to skip, so it must not be listed as one.
    expect(c?.skipReason).not.toContain("note");
  });

  it("exercises an operation that has only optional parameters", () => {
    const [c] = registryCases(backend([op({ params: [{ name: "page", in: "query", required: false }] })]));
    expect(c?.skipReason).toBeUndefined();
  });

  it("reports every operation, so narrowed coverage is visible rather than silent", () => {
    const cases = registryCases(backend([
      op({ operationId: "a" }),
      op({ operationId: "b", method: "POST" }),
      op({ operationId: "c", params: [{ name: "id", in: "path", required: true }] }),
    ]));
    expect(cases).toHaveLength(3);
    expect(cases.map((c) => c.operationId)).toEqual(["a", "b", "c"]);
    expect(exercisableCount(cases)).toBe(1);
  });

  it("carries a caseId scoped to the backend, so ids cannot collide across applications", () => {
    const [c] = registryCases(backend([op({ operationId: "listThings" })]));
    expect(c?.caseId).toBe("demo:listThings");
  });

  // ── Applied to what this deployment actually registers ──
  it("would not fire SCP's submit operation", () => {
    const scp = builtinBackends().find((b) => b.backendId === "scp");
    expect(scp, "scp should be a built-in backend").toBeDefined();
    const cases = registryCases(scp!);
    expect(cases.length).toBeGreaterThan(0);
    // Its only operation is a POST submit — nothing about it is safe to replay.
    expect(exercisableCount(cases)).toBe(0);
    expect(cases.every((c) => Boolean(c.skipReason))).toBe(true);
  });
});
