# ──────────────────────────────────────────────────────────────────────────────
# IAM roles
# ──────────────────────────────────────────────────────────────────────────────
module "iam" {
  source                = "./modules/iam"
  name_prefix           = local.name_prefix
  foundation_model_arns = local.foundation_model_arns
  tags                  = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────────────
# Worker Lambdas: 4 action groups + analytics + report.
# These have NO dependency on the agents/flow, breaking the wiring cycle.
# ──────────────────────────────────────────────────────────────────────────────
module "lambda_workers" {
  source      = "./modules/lambda"
  name_prefix = local.name_prefix
  tags        = local.common_tags

  functions = {
    "action-edd" = {
      zip_path    = "${var.dist_dir}/action-edd.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "EDD action-group Lambda (mock backend)."
    }
    "action-xship-report" = {
      zip_path    = "${var.dist_dir}/action-xship-report.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "XShipReport action-group Lambda (mock backend)."
    }
    "action-xship-download" = {
      zip_path    = "${var.dist_dir}/action-xship-download.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "XShipDownload action-group Lambda (mock backend)."
    }
    "action-relationship" = {
      zip_path    = "${var.dist_dir}/action-relationship.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "Relationship action-group Lambda (mock backend)."
    }
    "dispatch" = {
      zip_path    = "${var.dist_dir}/dispatch.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "Flow node: parse supervisor output into dispatch results."
    }
    "analytics" = {
      zip_path    = "${var.dist_dir}/analytics.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "Flow node: analytics over dispatch results."
    }
    "report" = {
      zip_path    = "${var.dist_dir}/report.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "Flow node: final report generation."
    }
    "flow-process" = {
      zip_path    = "${var.dist_dir}/flow-process.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = { LOG_LEVEL = var.log_level }
      timeout     = var.lambda_timeout_seconds
      memory_size = var.lambda_memory_mb
      description = "Flow node: combined dispatch+analytics+report."
    }
  }
}

# ──────────────────────────────────────────────────────────────────────────────
# Bedrock supervisor + collaborator agents (depends on worker action Lambdas).
# ──────────────────────────────────────────────────────────────────────────────
module "bedrock_agents" {
  source                 = "./modules/bedrock-agents"
  name_prefix            = local.name_prefix
  foundation_model       = var.foundation_model
  agent_role_arn         = module.iam.bedrock_agent_role_arn
  supervisor_instruction = file("${path.module}/../src/agents/prompts/supervisor.txt")
  collaborators          = local.collaborators
  tags                   = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────────────
# Bedrock Flow (depends on analytics + report Lambdas).
# ──────────────────────────────────────────────────────────────────────────────
module "bedrock_flow" {
  source               = "./modules/bedrock-flow"
  name_prefix          = local.name_prefix
  flow_role_arn        = module.iam.bedrock_flow_role_arn
  supervisor_alias_arn = module.bedrock_agents.supervisor_agent_alias_arn
  process_lambda_arn   = module.lambda_workers.function_arns["flow-process"]
  tags                 = local.common_tags
}

# ──────────────────────────────────────────────────────────────────────────────
# Entrypoint Lambda (depends on agents + flow ids).
# ──────────────────────────────────────────────────────────────────────────────
module "lambda_entrypoint" {
  source      = "./modules/lambda"
  name_prefix = local.name_prefix
  tags        = local.common_tags

  functions = {
    "api-entrypoint" = {
      zip_path = "${var.dist_dir}/api-entrypoint.zip"
      role_arn = module.iam.lambda_entrypoint_role_arn
      # In the best-practice topology the supervisor agent is a node INSIDE the flow,
      # so the entrypoint only needs to invoke the flow.
      environment = {
        LOG_LEVEL          = var.log_level
        ORCHESTRATION_MODE = var.orchestration_mode
        BEDROCK_REGION     = local.region
        FLOW_ID            = module.bedrock_flow.flow_id
        FLOW_ALIAS_ID      = module.bedrock_flow.flow_alias_id
        # Bound the synchronous flow wait so a slow agent dispatch falls back to local within
        # API Gateway's 30s cap. Raise/lower per environment; the agent path still runs server-side.
        FLOW_TIMEOUT_MS = "24000"
      }
      timeout     = 60
      memory_size = var.lambda_memory_mb
      description = "API Gateway entrypoint: invokes the supervisor→analytics→report flow."
    }
  }
}

# ──────────────────────────────────────────────────────────────────────────────
# API Gateway HTTP API in front of the entrypoint Lambda.
# ──────────────────────────────────────────────────────────────────────────────
module "api_gateway" {
  source                   = "./modules/api-gateway"
  name_prefix              = local.name_prefix
  entrypoint_lambda_arn    = module.lambda_entrypoint.function_arns["api-entrypoint"]
  entrypoint_invoke_arn    = module.lambda_entrypoint.invoke_arns["api-entrypoint"]
  entrypoint_function_name = module.lambda_entrypoint.function_names["api-entrypoint"]
  web_serve_invoke_arn     = module.lambda_web.invoke_arns["web-serve"]
  web_serve_function_name  = module.lambda_web.function_names["web-serve"]
  tags                     = local.common_tags
}
