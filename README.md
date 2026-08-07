# Bedrock Agentic Reporting System

A production-shaped AWS **Bedrock agentic system** that turns natural-language questions
into final reports across four report domains:

- **EDD** — enhanced due-diligence reports
- **XShipReport** — institution / fee / waiver reporting
- **XShipDownload** — activity downloads
- **Relationship** — ABA file relationship lookups

A single **Bedrock Flow** is the orchestration backbone. The one reasoning step — a
**supervisor agent** that classifies, routes and orchestrates **four collaborator agents** — is
an **Agent node inside the flow**; the deterministic stages (dispatch → analytics → report) are
Lambda nodes. Results are returned **synchronously** through **API Gateway**.

> Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first — it explains the agent/flow split and the request lifecycle.

## Layout

```
src/
  shared/            domain types, use-case registry, router, bedrock clients, logging
  mock/              mock datasets per use case (stand in for real backends)
  lambdas/
    api-entrypoint/  API Gateway handler → single InvokeFlow → response
    action-groups/   one Lambda per type (EDD, XShipReport, XShipDownload, Relationship)
    dispatch/        Bedrock Flow node: parse supervisor output → DispatchResult[]
    analytics/       Bedrock Flow node: analytics over dispatch results
    report/          Bedrock Flow node: final report generation
    telemetry/       durable request log: async writes + POST /v1/metrics (in-VPC)
  agents/prompts/    agent instruction templates
web/                 static UI: chat + operations dashboard (see web/README.md)
terraform/
  modules/{iam,lambda,bedrock-agents,bedrock-flow,api-gateway}
  openapi/           action-group OpenAPI schemas (generated from the registry)
scripts/build.mjs    esbuild bundler → dist/<lambda>.zip
```

## Prerequisites

- Node.js >= 20
- Terraform >= 1.6
- AWS CLI (the flow-prepare step shells out to it during `apply`)
- AWS account with Bedrock model access enabled (e.g. Claude on Bedrock) in your region
- Configured AWS credentials (`aws configure` / SSO)

> Works on commercial AWS and **GovCloud** — ARNs are partition-aware. For GovCloud set
> `aws_region = "us-gov-west-1"` and use a GovCloud (`aws-us-gov`) profile. Validated by a live
> `us-gov-west-1` deployment.

## Build

```bash
npm install
npm run typecheck      # strict TS, no emit
npm run build          # bundles + zips each Lambda into dist/
```

## Test locally (no AWS required)

The system runs end-to-end in `local` orchestration mode using deterministic routing and
in-process mock handlers:

```bash
npm test
```

## Deploy

```bash
cd terraform
terraform init
terraform plan  -var "aws_region=us-east-1" -var "foundation_model=anthropic.claude-3-5-sonnet-20240620-v1:0"
terraform apply -var "aws_region=us-east-1" -var "foundation_model=anthropic.claude-3-5-sonnet-20240620-v1:0"
```

Terraform outputs the API Gateway invoke URL. The `/v1/ask` route is gated by a token authorizer,
so first log in to get a bearer token, then call `/v1/ask` with it. Identity + IDs (officeId, ABA,
…) are carried in the token — you no longer put a user name or `office_id` in the question.

```bash
# 1) Log in (demo creds seeded in db/schema.sql / the in-code directory).
TOKEN=$(curl -s -X POST "$API_URL/v1/login" \
  -H 'content-type: application/json' \
  -d '{"username":"lliu","password":"Password123!"}' | jq -r .token)

# 2) Ask, presenting the token. The authorizer verifies it and injects the caller's IDs.
curl -s -X POST "$API_URL/v1/ask" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"question":"Give me the EDD summary report for Q2 and export it","sessionId":"demo-1"}' | jq

# 3) Read the request log behind the operations dashboard (needs enable_database=true).
curl -s -X POST "$API_URL/v1/metrics" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"rangeMs":86400000,"limit":500}' | jq '.source, (.records|length)'
```

### Operations dashboard

The UI has a second view alongside the chat — volume, latency, the execution path each request
took, backend output, health and a live activity feed. See [`web/README.md`](web/README.md).

Two producers, one payload. What changes with the source is where the arithmetic happened, never
what a metric means:

- **`fedline.request_log`** (deployment-wide, all users) via `POST /v1/metrics`. One row per
  `/v1/ask` attempt, written by the `telemetry` Lambda. The entrypoint has no VPC attachment — it
  must reach the Bedrock public endpoints — so it fires an **async** (`Event`) invoke at that
  Lambda rather than writing to RDS itself, and swallows every telemetry failure: a dashboard that
  costs availability is a bad trade. **Reads are aggregated in SQL over every matching row**
  (`src/shared/request-metrics.ts`) — the dashboard never pulls raw rows to sum in the browser,
  which used to cap every KPI at the fetch limit.
- **the browser's own `localStorage`**, aggregated in JS with the identical definitions
  (`web/telemetry.js` → `aggregateLocal`). Works before the log is deployed, with
  `enable_database = false`, or when the API is unreachable.

`src/__tests__/metrics-aggregation.test.ts` pins the shared definitions — interpolated percentiles
over timed requests only, a model invocation as `engine='llm' AND status='ran'`, fallback steps as
executed-but-not-invocations, empty buckets as a gap rather than a zero.

The table and the `/v1/metrics` route only exist with `enable_database = true`. Adding the table
to an existing deployment is the usual idempotent migration — re-invoke the `db-migrate` Lambda
after `terraform apply` and it applies the new section of `db/schema.sql` in place.

## Security guardrails

Two controls sit on the request path, both deployed and both verified against the live stack.

### Bedrock guardrail at the trust boundary

A Bedrock guardrail (`terraform/guardrail.tf`) is evaluated with the **ApplyGuardrail** API at two
points in `src/shared/guardrail.ts`: the user's **question** on the way in, and the generated
**summary** on the way out. Enforcement is explicit rather than attached inline to a model call, for
two reasons — it behaves identically whichever model runs downstream (this deployment uses an OSS
model, plus a Titan embedder and a Bedrock Flow), and it also covers the deterministic local
fallback path that an inline guardrail would silently miss.

Policies: `PROMPT_ATTACK` (the question steers which backend operation runs, so it is untrusted
input), the standard content filters, profanity, sensitive-information rules that **block**
credentials (`PASSWORD`, `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`) and **anonymise** card/SSN data, and two
denied topics:

- `SystemConfigurationDisclosure` — asking for the system prompt, credentials, environment variables
  or infrastructure configuration.
- `UnboundedDisclosure` — asking for *everything*: "show me everything you know", "dump all the data
  you can see". A separate topic because it is a different ask — it names no credential and no
  environment variable, so the configuration topic never matched it. The definition turns on
  **scope**, which is what keeps `Show me all XShip fee details for 2026-Q2` working while
  `Show me everything you know` is refused.

Bedrock caps topic definitions at 200 characters and examples at 5 per topic; both limits are tight
here, so an edit that adds detail may need to trade some away.

`US_BANK_ROUTING_NUMBER` is deliberately **not** filtered: ABA routing numbers are the domain — every
EDD and XShip report is keyed on them — so redacting them would break the product, not protect it.

**Fail closed.** If the guardrail cannot be evaluated the request is rejected rather than served
unscreened; a control that quietly stops running while everything still looks green is worse than no
control. `guardrail_fail_open = true` inverts the trade.

Editing the policy publishes a **new guardrail version**, and the Lambdas follow it. That is not
automatic — `aws_bedrock_guardrail_version` has no dependency on the policy content, so without the
`replace_triggered_by` in `terraform/guardrail.tf` an edit would update `DRAFT`, leave the pinned
version frozen, and change nothing at runtime: a policy that reads as tightened and is not enforced. Either way the outcome is recorded: blocked
requests land in the request log with `errorKind: "guardrail"` and the reasons that tripped, and both
screenings appear on the report trace — a screening that did **not** run shows as `skipped`, never as
`ran`.

Data rows are never screened. They are the backend's own records, and masking figures in a financial
report would corrupt the answer rather than protect anyone.

### Egress guard on the generic proxy

A backend's `baseUrl` is attacker-influenced — applications are registered at runtime by dropping a
document in S3, and the proxy then calls that URL from inside the VPC. `src/shared/gateway/egress.ts`
refuses loopback, link-local (**the instance metadata service**, the standard SSRF pivot to
credentials), RFC1918, carrier-grade NAT, `0/8`, multicast, IPv6 link-local/unique-local,
IPv4-mapped IPv6 spellings of all of the above, non-HTTP schemes, embedded credentials, and plain
HTTP. It is enforced at **registration** (rejected at the door, where the error is actionable) and
again **immediately before the request is issued**, since a registry row can change after it was
checked. Redirects are not followed — a redirect target is a second, unvalidated destination.

Known limit: a hostname that *resolves* to a private address is not caught. Resolving at check time
would only invite a DNS-rebinding race between the check and the connection.

## Example questions → routing

| Question | Type | Use case(s) | Orchestrated? |
|---|---|---|---|
| "EDD summary report for 2026-Q2" | EDD | `eddSummaryReport` | no |
| "Give me the EDD summary and export it" | EDD | `eddSummaryReport` + `eddExportSummaryReport` | **yes** |
| "EDD detail internal export for First National" | EDD | `eddExportDetailInternal` | no |
| "XShip fee summary for this quarter" | XShipReport | `xShipFeeSummary` | no |
| "Download shipping activity by ABA 123456789" | XShipDownload | `xshipDownloadActivityAba` | no |
| "Activity rollup by ABA for 2026-Q2" | XShipDownload | `xshipDownloadActivityAbaRollup` | no |
| "ABA group relationship in the xshi file" | Relationship | `xshiFileAbaGroup` | no |

The response is a `FinalReport` with one section per executed task, per-task highlights from the
analytics stage, and an executive `summary`.

## Configuration (Lambda env)

| Variable | Default | Meaning |
|---|---|---|
| `ORCHESTRATION_MODE` | `agent` | `agent` = invoke the Bedrock Flow; `local` = deterministic in-process pipeline. |
| `FLOW_ID` / `FLOW_ALIAS_ID` | — | Set by Terraform; the supervisor→dispatch→analytics→report flow. |
| `BEDROCK_REGION` | API region | Region for Bedrock runtime calls. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Changing the foundation model

The model is `var.foundation_model` (currently `openai.gpt-oss-120b-1:0`; any Bedrock-Agents-capable
model works — e.g. `anthropic.claude-3-5-sonnet-20240620-v1:0`). A swap is **one command**:

```bash
terraform apply -var "foundation_model=<new-model-id>"
```

Why it's not just an attribute change: an agent `live` **alias** serves a versioned snapshot of the
*prepared* DRAFT, not the DRAFT config. So the apply does three things automatically:

1. `prepare_agent = true` recompiles each agent's DRAFT with the new model.
2. `terraform_data.{collaborator,supervisor}_reversion` (keyed on `foundation_model`) re-prepares each
   agent and runs `update-agent-alias` so Bedrock cuts a fresh version — supervisor after collaborators.
3. The aliases carry `ignore_changes = [routing_configuration]`, so Terraform never fights (or reverts)
   the new version. These steps need the **AWS CLI on the apply host** (it shells out via `local-exec`).

Verify: `aws bedrock-agent get-agent-version --agent-id <id> --agent-version <n> --query agentVersion.foundationModel`.

## Extending

- **Add a use case:** add it to [`src/shared/usecases.ts`](src/shared/usecases.ts), add mock data,
  handle it in the relevant action-group Lambda, regenerate OpenAPI, `terraform apply`.
- **Point at real backends:** replace the functions in [`src/mock/`](src/mock/) with real HTTP/data clients;
  the Lambda handlers and contracts stay unchanged.
