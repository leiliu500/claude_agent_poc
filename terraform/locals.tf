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

  # The four collaborator agents, fed from the committed prompts + OpenAPI schemas.
  collaborators = {
    edd = {
      display_name              = "EDD"
      instruction               = file("${path.module}/../src/agents/prompts/edd.txt")
      api_schema                = file("${path.module}/openapi/edd.json")
      lambda_arn                = module.lambda_workers.function_arns["action-edd"]
      collaboration_instruction = "Route here for Enhanced Due-Diligence (EDD) summary/detail report requests, including exports and internal exports."
    }
    xshipreport = {
      display_name              = "XShipReport"
      instruction               = file("${path.module}/../src/agents/prompts/xship-report.txt")
      api_schema                = file("${path.module}/openapi/xship-report.json")
      lambda_arn                = module.lambda_workers.function_arns["action-xship-report"]
      collaboration_instruction = "Route here for XShip institution, waiver, fee (detail/summary/total) and current-quarter report requests."
    }
    xshipdownload = {
      display_name              = "XShipDownload"
      instruction               = file("${path.module}/../src/agents/prompts/xship-download.txt")
      api_schema                = file("${path.module}/openapi/xship-download.json")
      lambda_arn                = module.lambda_workers.function_arns["action-xship-download"]
      collaboration_instruction = "Route here for XShip activity download requests (by ABA, ABA rollup, zone, or criteria-by-period)."
    }
    relationship = {
      display_name              = "Relationship"
      instruction               = file("${path.module}/../src/agents/prompts/relationship.txt")
      api_schema                = file("${path.module}/openapi/relationship.json")
      lambda_arn                = module.lambda_workers.function_arns["action-relationship"]
      collaboration_instruction = "Route here for ABA relationship lookups from the XSHI file (ABA group or single ABA)."
    }
    db = {
      display_name              = "DBAgent"
      instruction               = file("${path.module}/../src/agents/prompts/db.txt")
      api_schema                = file("${path.module}/openapi/db.json")
      lambda_arn                = module.lambda_workers.function_arns["action-db"]
      collaboration_instruction = "Call FIRST with the user name to resolve the user's stored identifiers (userAba, aba, abaGroup, rollupAbaName, endpoint, denomination, differenceType, zone, period, denomType, requestId, criteria) before delegating to the report collaborators. If no user name is present, the request is invalid."
    }
  }

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
