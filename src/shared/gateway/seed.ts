/**
 * Built-in backend seeds — the applications the Agentic API Gateway ships knowing about.
 *
 *   1. Fedline — the app the ORIGINAL system integrates by hand (EDD / XShip / Relationship). Its
 *      backend is DERIVED from the canonical USE_CASES registry (usecases.ts), so the gateway catalog
 *      stays in lockstep with the report collaborators with no duplicated endpoint list. Registering
 *      Fedline here is ADDITIVE: the four report collaborators keep serving reports exactly as before;
 *      this just makes Fedline a discoverable, proxy-invocable backend like any other app.
 *   2. SCP — the FedCash interface simulator. A single multipart operation (submitEasySim) that
 *      uploads an EASy XML file plus a JSON control block over MQ and returns a plain-text ack. This
 *      is the case that made the generic proxy actually general (multipart + file + text response).
 *
 * Seeding is EXPLICIT (never on import) so it can't surprise the deterministic router: call
 * seedBuiltinBackends() from the gateway-register Lambda ({ action: "seed" }) or from a test. Real
 * base URLs come from env (FEDLINE_BASE_URL / SCP_BASE_URL); the defaults are placeholders.
 */
import { USE_CASES } from "../usecases.js";
import { registerBackend } from "./registry.js";
import { pathParamNames } from "./openapi.js";
import { POSTDISPATCH_PROMPTS } from "../../apps/fedline/prompts/postdispatch_prompts.js";
import type { BackendOperation, BackendParam, PostDispatchPolicy, RegisterBackendInput } from "./types.js";

const FEDLINE_BASE_URL = process.env.FEDLINE_BASE_URL ?? "https://fedline.frb.pvt";
const SCP_BASE_URL = process.env.SCP_BASE_URL ?? "https://dg2-scp.dev.fedcash-iface1.awscfs.frb.pvt";

/**
 * Fedline's post-dispatch policy: once the gateway proxy returns Fedline report rows, spawn two
 * ephemeral in-process agents in order — an analytics agent that derives insights over the returned
 * records, then a report agent that transforms those insights into an executive summary. Both are
 * built at call time from Fedline's application-specific prompts (see apps/fedline/prompts/postdispatch_prompts.ts),
 * run once, and discarded (see shared/postdispatch/*). SCP, by contrast, gets no policy at all →
 * passthrough (its plain-text ack is surfaced as-is).
 */
export function fedlinePostDispatch(): PostDispatchPolicy {
  return {
    mode: "agents",
    agents: [
      { role: "analytics", prompt: POSTDISPATCH_PROMPTS.analytics },
      { role: "report", prompt: POSTDISPATCH_PROMPTS.report },
    ],
  };
}

/** Derive the Fedline backend from the canonical report use cases (skipping the non-Fedline KB one). */
export function fedlineBackend(): RegisterBackendInput {
  const operations: BackendOperation[] = USE_CASES.filter((uc) => uc.type !== "KB").map((uc) => {
    const pathParams = new Set(pathParamNames(uc.endpoint.path));
    const queryParams = new Set(uc.endpoint.query ?? []);
    const params: BackendParam[] = uc.params.map((p) => ({
      name: p.name,
      in: pathParams.has(p.name) ? "path" : queryParams.has(p.name) ? "query" : "query",
      required: p.required,
      description: p.description,
    }));
    return {
      operationId: uc.id,
      method: uc.endpoint.method,
      path: uc.endpoint.path,
      summary: uc.label,
      description: uc.description,
      params,
      keywords: uc.keywords,
    };
  });

  return {
    backendId: "fedline",
    name: "Fedline",
    description:
      "Federal Reserve Fedline reporting application: Enhanced Due-Diligence (EDD), XShip reporting, " +
      "XShip activity downloads and ABA relationship lookups.",
    baseUrl: FEDLINE_BASE_URL,
    auth: { type: "none" },
    operations,
    // Fedline diverges after dispatch: analytics agent → report agent (both ephemeral, app-prompted).
    postDispatch: fedlinePostDispatch(),
  };
}

/** The SCP (FedCash interface simulator) backend — a single multipart file-submit operation. */
export function scpBackend(): RegisterBackendInput {
  const submitEasySim: BackendOperation = {
    operationId: "submitEasySim",
    method: "POST",
    path: "/api/sim/easy",
    summary: "Submit an EASy simulation file to SCP (FedCash) over MQ",
    description:
      "Multipart submit to the SCP interface simulator. Sends a 'payload' JSON control block " +
      "(inputData, ccdt, qmgr, seasyq, reasyq, easymsgid) and an EASy XML 'file' part; the file's " +
      "name can be set via a 'filename' param. Returns a plain-text acknowledgement carrying a " +
      "Request ID (also echoed in the X-Request-ID response header).",
    requestContentType: "multipart/form-data",
    params: [
      {
        name: "payload",
        in: "formField",
        required: true,
        description: "JSON control block: inputData, ccdt, qmgr, seasyq, reasyq, easymsgid.",
      },
      { name: "file", in: "file", required: true, description: "EASy XML file content (multipart file part)." },
    ],
    keywords: [
      "scp", "easy", "sim", "simulation", "submit", "send", "sendfiles", "file", "upload", "fedcash",
      "mq", "queue", "interface", "smoke", "easymsgid", "ccdt", "qmgr",
    ],
  };

  return {
    backendId: "scp",
    name: "SCP (FedCash Interface Simulator)",
    description:
      "SCP FedCash interface simulator: submits EASy/message files to MQ queues for interface testing.",
    baseUrl: SCP_BASE_URL,
    auth: { type: "none" },
    operations: [submitEasySim],
    // SCP just returns its response — no downstream agents. (Explicit; absent would mean the same.)
    postDispatch: { mode: "passthrough" },
  };
}

/** Every built-in backend, in registration order. */
export function builtinBackends(): RegisterBackendInput[] {
  return [fedlineBackend(), scpBackend()];
}

/** Register (or refresh) all built-in backends. Idempotent — registerBackend upserts. */
export async function seedBuiltinBackends(): Promise<string[]> {
  const ids: string[] = [];
  for (const backend of builtinBackends()) {
    const b = await registerBackend(backend);
    ids.push(b.backendId);
  }
  return ids;
}
