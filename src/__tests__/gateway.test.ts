/**
 * Agentic API Gateway tests: OpenAPI parsing → registry (in-memory) → semantic-ish retrieval →
 * generic proxy invoke (mock mode) → executeTask Gateway branch. No AWS/network — the in-memory
 * registry + GATEWAY_MOCK path is exactly what ORCHESTRATION_MODE=local runs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseOpenApi, pathParamNames } from "../shared/gateway/openapi.js";
import {
  registerBackend,
  listBackends,
  getBackend,
  removeBackend,
  retrieveOperations,
  clearRegistryForTests,
} from "../shared/gateway/registry.js";
import { invokeBackend, resolveRequest } from "../shared/gateway/invoke.js";
import { executeTask } from "../shared/dispatch.js";
import { parseSupervisorOutput } from "../shared/supervisor-parse.js";
import { seedBuiltinBackends, scpBackend } from "../shared/gateway/seed.js";
import { runAnalytics } from "../shared/analytics.js";
import { generateReport } from "../shared/report.js";

const ORDERS_SPEC = {
  openapi: "3.0.0",
  info: { title: "Orders API", version: "1.0.0" },
  paths: {
    "/orders/{orderId}": {
      get: {
        operationId: "getOrder",
        summary: "Get an order by id",
        parameters: [{ name: "orderId", in: "path", required: true }],
      },
    },
    "/orders": {
      post: {
        operationId: "createOrder",
        summary: "Create a new order",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { required: ["customerId"], properties: { customerId: { description: "Customer" }, note: {} } },
            },
          },
        },
      },
      get: {
        summary: "List orders",
        parameters: [{ name: "status", in: "query" }],
      },
    },
  },
};

async function registerOrders() {
  return registerBackend({
    backendId: "orders",
    name: "Orders API",
    description: "Order management",
    baseUrl: "https://api.example.com/",
    openapi: ORDERS_SPEC,
  });
}

beforeEach(() => {
  clearRegistryForTests();
  process.env.GATEWAY_MOCK = "true";
});

describe("openapi parser", () => {
  it("derives operations, params and a fallback operationId", () => {
    const ops = parseOpenApi(ORDERS_SPEC);
    expect(ops.map((o) => o.operationId).sort()).toEqual(["createOrder", "get_orders", "getOrder"].sort());

    const getOrder = ops.find((o) => o.operationId === "getOrder")!;
    expect(getOrder.method).toBe("GET");
    expect(getOrder.params).toContainEqual(expect.objectContaining({ name: "orderId", in: "path", required: true }));

    const createOrder = ops.find((o) => o.operationId === "createOrder")!;
    expect(createOrder.params).toContainEqual(expect.objectContaining({ name: "customerId", in: "body", required: true }));
    expect(createOrder.params).toContainEqual(expect.objectContaining({ name: "note", in: "body", required: false }));

    const list = ops.find((o) => o.operationId === "get_orders")!;
    expect(list.params).toContainEqual(expect.objectContaining({ name: "status", in: "query" }));
  });

  it("extracts path placeholders and returns [] for a doc with no paths", () => {
    expect(pathParamNames("/a/{x}/b/{y}")).toEqual(["x", "y"]);
    expect(parseOpenApi({})).toEqual([]);
    expect(parseOpenApi(null)).toEqual([]);
  });
});

describe("registry (in-memory)", () => {
  it("registers, lists, gets and removes a backend", async () => {
    await registerOrders();
    const list = await listBackends();
    expect(list.map((b) => b.backendId)).toEqual(["orders"]);

    const b = await getBackend("orders");
    expect(b?.baseUrl).toBe("https://api.example.com"); // trailing slash trimmed
    expect(b?.operations).toHaveLength(3);

    expect(await removeBackend("orders")).toBe(true);
    expect(await getBackend("orders")).toBeUndefined();
    expect(await removeBackend("orders")).toBe(false);
  });

  it("rejects a backend with no operations or no baseUrl", async () => {
    await expect(registerBackend({ backendId: "empty", baseUrl: "https://x", openapi: {} })).rejects.toThrow(/no operations/);
    await expect(registerBackend({ backendId: "nobase", baseUrl: "", openapi: ORDERS_SPEC })).rejects.toThrow(/baseUrl/);
  });
});

describe("retrieval (lexical, in-memory)", () => {
  it("ranks the most relevant operation first", async () => {
    await registerOrders();
    expect((await retrieveOperations("create a new order", 1))[0]?.operation.operationId).toBe("createOrder");
    expect((await retrieveOperations("get an order by id", 1))[0]?.operation.operationId).toBe("getOrder");
  });

  it("returns [] when nothing is registered", async () => {
    expect(await retrieveOperations("anything")).toEqual([]);
  });
});

describe("generic proxy (resolveRequest + invoke mock)", () => {
  it("resolves path, query, body and auth into an outbound request", async () => {
    process.env.ORDERS_TOKEN = "secret-token";
    await registerBackend({
      backendId: "orders",
      name: "Orders API",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer", valueEnv: "ORDERS_TOKEN" },
      openapi: ORDERS_SPEC,
    });
    const b = (await getBackend("orders"))!;

    const create = b.operations.find((o) => o.operationId === "createOrder")!;
    const req = resolveRequest(b, create, { customerId: "C1", note: "rush" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.example.com/orders");
    expect(JSON.parse(req.body!)).toEqual({ customerId: "C1", note: "rush" });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.Authorization).toBe("Bearer secret-token");

    const get = b.operations.find((o) => o.operationId === "getOrder")!;
    expect(resolveRequest(b, get, { orderId: "A100" }).url).toBe("https://api.example.com/orders/A100");

    const list = b.operations.find((o) => o.operationId === "get_orders")!;
    expect(resolveRequest(b, list, { status: "open" }).url).toBe("https://api.example.com/orders?status=open");
  });

  it("mock-invokes a registered operation and echoes the resolved request", async () => {
    await registerOrders();
    const res = await invokeBackend({ backendId: "orders", operationId: "getOrder", params: { orderId: "A100" } });
    expect(res.status).toBe("ok");
    expect(res.type).toBe("Gateway");
    expect(res.meta.url).toBe("https://api.example.com/orders/A100");
    expect(res.meta.mocked).toBe(true);
  });

  it("errors on a missing required path param, unknown backend and unknown operation", async () => {
    await registerOrders();
    const missing = await invokeBackend({ backendId: "orders", operationId: "getOrder", params: {} });
    expect(missing.status).toBe("error");
    expect(missing.error).toMatch(/orderId/);

    expect((await invokeBackend({ backendId: "nope", operationId: "x", params: {} })).error).toMatch(/Unknown backend/);
    expect((await invokeBackend({ backendId: "orders", operationId: "nope", params: {} })).error).toMatch(/no operation/);
  });
});

const SCP_MULTIPART_SPEC = {
  openapi: "3.0.0",
  info: { title: "SCP", version: "1.0.0" },
  paths: {
    "/api/sim/easy": {
      post: {
        operationId: "submitEasySim",
        summary: "Submit an EASy simulation file",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                required: ["payload", "file"],
                properties: {
                  payload: { type: "string", description: "JSON control block" },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapi parser (multipart / file uploads)", () => {
  it("marks a multipart body and its binary file property", () => {
    const ops = parseOpenApi(SCP_MULTIPART_SPEC);
    const op = ops.find((o) => o.operationId === "submitEasySim")!;
    expect(op.requestContentType).toBe("multipart/form-data");
    expect(op.params).toContainEqual(expect.objectContaining({ name: "file", in: "file", required: true }));
    expect(op.params).toContainEqual(expect.objectContaining({ name: "payload", in: "formField", required: true }));
  });
});

describe("generic proxy (multipart / SCP)", () => {
  const scpPayload = {
    inputData: "sendFiles 100 smoke_easy EASy nocheck",
    ccdt: "/opt/restapp/CCDT/MQ.CCDT.SCP_FCC_CFS2_EAST",
    qmgr: "FCC_SCP_1",
    seasyq: "FCC.OUT.EASY.SIM.T1",
    reasyq: "FCC.IN.EASYACK.SIM.T1",
    easymsgid: "1002",
  };

  it("builds multipart form parts (JSON field + file) with no manual content-type header", async () => {
    await registerBackend(scpBackend());
    const b = (await getBackend("scp"))!;
    const op = b.operations.find((o) => o.operationId === "submitEasySim")!;

    const req = resolveRequest(b, op, { payload: scpPayload, file: "<FCC-EASY/>", filename: "FCC-EASY.xml" });
    expect(req.url).toBe("https://dg2-scp.dev.fedcash-iface1.awscfs.frb.pvt/api/sim/easy");
    expect(req.body).toBeUndefined();
    expect(req.headers["content-type"]).toBeUndefined(); // fetch sets the multipart boundary itself
    expect(req.form).toContainEqual(
      expect.objectContaining({ name: "payload", contentType: "application/json", value: JSON.stringify(scpPayload) }),
    );
    expect(req.form).toContainEqual(
      expect.objectContaining({ name: "file", filename: "FCC-EASY.xml", contentType: "application/octet-stream" }),
    );
  });

  it("flags a missing required file part", async () => {
    await registerBackend(scpBackend());
    const res = await invokeBackend({ backendId: "scp", operationId: "submitEasySim", params: { payload: scpPayload } });
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/file/);
  });

  it("mock-invokes the SCP file submit through executeTask", async () => {
    await registerBackend(scpBackend());
    const res = await executeTask({
      type: "Gateway",
      useCase: "submitEasySim",
      params: { backendId: "scp", payload: scpPayload, file: "<FCC-EASY/>", filename: "FCC-EASY.xml" },
    });
    expect(res.status).toBe("ok");
    expect(res.meta.contentType).toBe("multipart/form-data");
    expect(res.meta.parts).toContain("file (file: FCC-EASY.xml)");
  });

  it("surfaces the SCP text ack as the report summary (what the UI renders)", async () => {
    await registerBackend(scpBackend());
    const res = await invokeBackend({
      backendId: "scp",
      operationId: "submitEasySim",
      params: { payload: scpPayload, file: "<FCC-EASY/>", filename: "FCC-EASY.xml" },
    });
    const report = generateReport({
      question: "submit the EASy file to SCP",
      type: "Gateway",
      dispatchResults: [res],
      analytics: runAnalytics([res]),
      generatedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(report.summary).toMatch(
      /^Request sent successfully\. Request ID: [0-9a-f-]{36}\n\nsendFiles 100 smoke_easy EASy nocheck$/,
    );
  });
});

describe("built-in backends (Fedline + SCP) seed + retrieval", () => {
  it("seeds both apps and routes questions to the right one", async () => {
    const ids = await seedBuiltinBackends();
    expect(ids).toEqual(["fedline", "scp"]);

    const b = await getBackend("fedline");
    expect(b?.operations.some((o) => o.operationId === "eddSummaryReport")).toBe(true);
    // KB is not a Fedline REST operation — it must be excluded from the Fedline backend.
    expect(b?.operations.some((o) => o.operationId === "kbSearch")).toBe(false);

    const scpHit = (await retrieveOperations("submit an easy simulation file to scp over mq", 1))[0];
    expect(scpHit?.backendId).toBe("scp");
    expect(scpHit?.operation.operationId).toBe("submitEasySim");

    const fedHit = (await retrieveOperations("edd summary due diligence report", 1))[0];
    expect(fedHit?.backendId).toBe("fedline");
  });

  it("serves rich Fedline mock data THROUGH the gateway proxy (mock adapter), preserving old behavior", async () => {
    await seedBuiltinBackends();
    const res = await invokeBackend({
      backendId: "fedline",
      operationId: "eddSummaryReport",
      params: { officeId: "12345", userAba: "000001", aba: "011000015", endpoint: "web", denomination: "USD-100", differenceType: "NET", startDate: "2026-04-01", endDate: "2026-06-30" },
    });
    expect(res.status).toBe("ok");
    expect(res.data.length).toBeGreaterThan(0); // real EDD records, not a generic echo
    expect(res.meta.totalEdds).toBeGreaterThan(0);
    expect(typeof res.meta.reportId).toBe("string"); // reportId available for the summary→detail chain
    expect(res.data[0]).toHaveProperty("eddLoadID");

    // SCP returns its text-ack mock (a { value } row + meta.response), not a generic echo.
    const scp = await invokeBackend({
      backendId: "scp",
      operationId: "submitEasySim",
      params: { payload: { inputData: "sendFiles 100 smoke_easy EASy nocheck" }, file: "<x/>", filename: "x.xml" },
    });
    expect(String(scp.data[0]?.value)).toMatch(/^Request sent successfully\. Request ID: [0-9a-f-]{36}/);
    expect(String(scp.data[0]?.value)).toContain("sendFiles 100 smoke_easy EASy nocheck");
    expect(scp.meta.response).toBe(scp.data[0]?.value); // report surfaces this as the summary
    expect(scp.meta.contentType).toBe("multipart/form-data"); // request descriptor preserved
    expect(scp.meta.parts).toContain("file (file: x.xml)");
  });
});

describe("supervisor output parsing (Gateway passthrough)", () => {
  it("keeps a Gateway task + dispatchResult whose useCase is a backend operationId (not a static USE_CASE)", () => {
    const completion = JSON.stringify({
      type: "Gateway",
      tasks: [{ type: "Gateway", useCase: "getOrder", params: { backendId: "orders", orderId: "A100" } }],
      dispatchResults: [
        { type: "Gateway", useCase: "getOrder", status: "ok", data: [{ id: "A100" }], meta: { backendId: "orders" }, latencyMs: 3 },
      ],
    });
    const parsed = parseSupervisorOutput(completion);
    expect(parsed.type).toBe("Gateway");
    expect(parsed.tasks[0]).toMatchObject({ type: "Gateway", useCase: "getOrder", params: { backendId: "orders" } });
    expect(parsed.dispatchResults[0]).toMatchObject({ type: "Gateway", useCase: "getOrder", status: "ok" });
  });
});

describe("executeTask Gateway branch", () => {
  it("routes a Gateway task through the proxy", async () => {
    await registerOrders();
    const res = await executeTask({
      type: "Gateway",
      useCase: "getOrder",
      params: { backendId: "orders", orderId: "A100" },
    });
    expect(res.type).toBe("Gateway");
    expect(res.useCase).toBe("getOrder");
    expect(res.status).toBe("ok");
    expect(res.meta.url).toBe("https://api.example.com/orders/A100");
  });
});
