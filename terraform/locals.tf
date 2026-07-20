data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  region      = data.aws_region.current.region
  partition   = data.aws_partition.current.partition

  # Models the agents/flow may invoke (base model + inference profiles in this account).
  foundation_model_arns = [
    "arn:${local.partition}:bedrock:${local.region}::foundation-model/${var.foundation_model}",
    "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:inference-profile/*",
  ]

  # Collaborator agents. The former per-domain Fedline collaborators (EDD, XShipReport,
  # XShipDownload, Relationship) have been RETIRED: Fedline is now a runtime-registered backend of the
  # Agentic API Gateway (see src/shared/gateway/seed.ts), reached through the single Gateway
  # collaborator — the same way SCP and any future app are, with no per-app prompt/schema/Lambda. What
  # remains here are the cross-cutting collaborators: DBAgent (identity), KB (RAG) and Gateway.
  collaborators = {
    db = {
      display_name              = "DBAgent"
      instruction               = file("${path.module}/../src/agents/prompts/db.md")
      api_schema                = file("${path.module}/openapi/db.json")
      lambda_arn                = module.lambda_workers.function_arns["action-db"]
      collaboration_instruction = "Call FIRST with the user name to resolve the user's stored identifiers (userAba, aba, abaGroup, rollupAbaName, endpoint, denomination, differenceType, zone, period, denomType, requestId, criteria) before delegating to the report collaborators. If no user name is present, the request is invalid."
    }
    kb = {
      display_name              = "KB"
      instruction               = file("${path.module}/../src/agents/prompts/kb.md")
      api_schema                = file("${path.module}/openapi/kb.json")
      lambda_arn                = module.lambda_workers.function_arns["action-kb"]
      collaboration_instruction = "Route here for KNOWLEDGE, policy, procedure, definition, 'how do I' and 'what is' questions answered from the indexed document corpus (RAG). Not a report and not user-specific — no user name or identifiers are required. Call kbSearch with params.query set to the user's question."
    }
    gateway = {
      display_name              = "Gateway"
      instruction               = file("${path.module}/../src/agents/prompts/gateway.md")
      api_schema                = file("${path.module}/openapi/gateway.json")
      lambda_arn                = module.lambda_workers.function_arns["action-gateway"]
      collaboration_instruction = "Route here for requests that target an EXTERNAL / registered application and do NOT match the fixed EDD, XShipReport, XShipDownload or Relationship report types. First call gatewayRetrieve with the user's question to discover candidate backend operations, then call gatewayInvoke with the chosen backendId + operationId and the required params. This is the Agentic API Gateway to any runtime-registered app."
    }
  }

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
