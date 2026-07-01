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
  agents/prompts/    agent instruction templates
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
```

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
