# Architecture — Bedrock Agentic Reporting System

## Goal

A user asks a natural-language question. The system must:

1. **Understand & classify** the question into one of 4 *types* and a specific *use case*.
2. **Route & dispatch** to the task that serves that use case.
3. **Orchestrate** multiple API calls when a question needs more than one task.
4. **Analyze** the raw task results.
5. **Generate a final report** and **return it synchronously** to the user.

Responsibilities are decoupled across **multiple Bedrock agents** composed **inside a single
Bedrock Flow**.

## Topology (best practice): one flow, agent as a node

The flow is the **deterministic backbone**; the single step that needs open-ended reasoning —
classification, routing, dispatch and multi-agent orchestration — is the **Supervisor Agent
node**. Everything downstream is deterministic. The caller makes **one `InvokeFlow`** call and
gets the `FinalReport`, with unified tracing and versioning for the whole pipeline.

```
  HTTPS request ─► API Gateway ─► api-entrypoint Lambda ─► InvokeFlow ─┐
  (user question)                                                      │
                                                                       ▼
  ┌──────────────────────────── Bedrock Flow ──────────────────────────────────┐
  │                                                                             │
  │  FlowInput ─► Supervisor (Agent node) ─► Dispatch ─► Analytics ─► Report ─► FlowOutput
  │   {question}        │                     (Lambda)   (Lambda)    (Lambda)     │
  │                     │                                                         │
  │        multi-agent collaboration (inside the agent):                         │
  │        ┌───────────┴────────────┬───────────────┬───────────────┐           │
  │     EDD Agent   XShipReport Agent  XShipDownload Agent  Relationship Agent   │
  │        │ action group → Lambda (mock data) per type                          │
  │        └────────────────────────────────────────────────────────┘           │
  └─────────────────────────────────────────────────────────────────────────────┘
                                                                       │
  HTTPS response ◄──────────────── final report (synchronous JSON) ◄───┘
```

## Why this split (decoupled responsibilities)

| Responsibility | Owner | Why |
|---|---|---|
| Pipeline orchestration | **Bedrock Flow** | Deterministic, versioned, traceable backbone (one invoke surface). |
| Understand + classify + route + orchestrate | **Supervisor Agent node** | The one fuzzy/reasoning step; LLM picks type + use case(s), fans out. |
| Per-type domain knowledge + dispatch | **4 Collaborator Agents** | Each owns its use cases + action group; independently versioned/permissioned. |
| Actual task execution / API calls (mock) | **Action-group Lambdas** | Deterministic, testable, swappable for real backends. |
| Parse agent output → `DispatchResult[]` | **Dispatch Lambda** (flow node) | Bridges the reasoning step to the deterministic stages; resilient fallback. |
| Analytics over results | **Analytics Lambda** (flow node) | Pure compute; no LLM. |
| Report generation | **Report Lambda** (flow node) | Transforms analytics into the final report. |
| Sync delivery + transport | **api-entrypoint Lambda + API Gateway** | One synchronous request/response surface. |

The **agents** own fuzzy reasoning (placed *inside* the flow as one node).
The **flow** owns deterministic structure (dispatch → analytics → report).
This is the idiomatic Bedrock composition: *a flow of deterministic steps with an agent at the
single fuzzy spot*, rather than an agent doing everything.

## Types and use cases

| Type | Use cases |
|---|---|
| **EDD** | `eddSummaryReport`, `eddExportSummaryReport`, `eddDetailReport`, `eddExportDetailReport`, `eddExportDetailInternal` |
| **XShipReport** | `xShipInstitution`, `xShipWaiver`, `xShipFeeDetail`, `xShipFeeSummary`, `xShipFee`, `currentQuarter` |
| **XShipDownload** | `xshipDownloadActivityAba`, `xshipDownloadActivityAbaRollup`, `xshipDownloadActivityZone`, `xshipDownloadCriteriaPeriod` |
| **Relationship** | `xshiFileAbaGroup`, `xshiFileAba` |

Canonical registry: [`src/shared/usecases.ts`](src/shared/usecases.ts) — single source of truth
shared by Lambdas, the local router, the agent prompts, and the action-group OpenAPI schemas.

## Request lifecycle

1. `POST /v1/ask` with `{ "question": "...", "sessionId": "..." }`.
2. `api-entrypoint` makes a single `InvokeFlow` with `{ question }`.
3. Inside the flow:
   - **Supervisor (Agent node)** classifies type + use case(s), delegates to the relevant
     collaborator agent(s); each collaborator calls its action-group Lambda(s) (mock data).
     The agent returns a structured JSON completion (`{ type, tasks, dispatchResults }`).
   - **Dispatch (Lambda)** parses that completion into `DispatchResult[]`. Resilience: if the
     agent returned tasks but no data it executes them; if the output is unparseable it falls
     back to the deterministic local router.
   - **Analytics (Lambda)** computes metrics/aggregations.
   - **Report (Lambda)** renders the `FinalReport`.
4. `api-entrypoint` returns the `FinalReport` as JSON.

> The agent node and the Lambda nodes communicate through stable, typed contracts in
> [`src/shared/types.ts`](src/shared/types.ts), so any stage can evolve independently.

## Flow data wiring

| Node | Inputs (JSONPath on the connection) | Output |
|---|---|---|
| FlowInput | — | `document` (Object `{ question }`) |
| Supervisor (Agent) | `agentInputText` ← `$.data.question` | `agentResponse` (String) |
| Dispatch (Lambda) | `question` ← `$.data.question`, `agentResponse` ← `$.data` | `functionResponse` (Object) |
| Analytics (Lambda) | `codeHookInput` ← `$.data` | `functionResponse` (Object) |
| Report (Lambda) | `codeHookInput` ← `$.data` | `functionResponse` (Object) |
| FlowOutput | `document` ← `$.data` | — |

The flow Lambda handlers read named inputs via [`src/shared/flow-io.ts`](src/shared/flow-io.ts),
which tolerates both the `inputs:[{name,value}]` array shape and a single mapped value.

## Local fallback / orchestration mode

`api-entrypoint` honours `ORCHESTRATION_MODE`:

- `agent` (default, production): a single `InvokeFlow`. If the flow call fails, it falls back
  to the local pipeline so the request still succeeds.
- `local`: classify with the deterministic router ([`src/shared/router.ts`](src/shared/router.ts))
  and run dispatch/analytics/report in-process — the same logic the flow nodes run, no AWS needed.

## Deployment

Terraform modules under [`terraform/`](terraform/):

- `iam` — least-privilege roles: per-Lambda exec roles, a Bedrock **agent** service role
  (InvokeModel + InvokeAgent on collaborators), and a Bedrock **flow** service role
  (InvokeModel + InvokeAgent on the supervisor alias + InvokeFunction on the flow Lambdas).
  The entrypoint role is scoped to `InvokeFlow` only.
- `lambda` — generic module instantiated twice: 7 worker Lambdas (4 action + dispatch +
  analytics + report) then the entrypoint Lambda. The split breaks the dependency cycle.
- `bedrock-agents` — supervisor (`agent_collaboration = SUPERVISOR`) + 4 collaborators, action
  groups (OpenAPI → Lambda), aliases, and `aws_bedrockagent_agent_collaborator` links.
- `bedrock-flow` — `aws_bedrockagent_flow` with the Agent + Lambda nodes above. The flow
  **version** and **alias** use the **`awscc`** provider (the `hashicorp/aws` provider does not
  yet expose `aws_bedrockagent_flow_version`/`_alias`).
- `api-gateway` — HTTP API + `POST /v1/ask` route + Lambda integration + invoke permission.

Dependency order (no cycle): `lambda_workers` → `bedrock_agents` (action Lambdas) →
`bedrock_flow` (supervisor alias + dispatch/analytics/report Lambdas) → `lambda_entrypoint`
(flow ids) → `api_gateway`.

Provider requirements: `hashicorp/aws >= 5.83` and `hashicorp/awscc >= 1.0`.

**Partition-aware:** all ARNs are built from `data.aws_partition.current.partition`, so the same
config deploys to commercial (`aws`) **and GovCloud (`aws-us-gov`)**. Verified by a live deploy to
`us-gov-west-1` (account `679343992698`).

**Flow preparation:** a Bedrock flow is created in status `NotPrepared`; a flow *version* can only
be cut once the DRAFT is `Prepared`. Neither the `aws` nor `awscc` resource auto-prepares, so the
`bedrock-flow` module runs `PrepareFlow` (via a `terraform_data` + `local-exec` that polls to
`Prepared`) before the version. **This requires the AWS CLI on the apply host** (it inherits
`AWS_PROFILE`/`AWS_REGION` from the apply environment). `PrepareFlow` also validates the flow graph,
so a successful apply confirms the node/connection definition is correct.
