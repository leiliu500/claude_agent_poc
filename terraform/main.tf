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
# RDS Postgres directory for the DBAgent (optional; off by default).
# When disabled, the DBAgent Lambda uses the in-code directory that mirrors db/schema.sql.
# ──────────────────────────────────────────────────────────────────────────────
module "rds_postgres" {
  count       = var.enable_database ? 1 : 0
  source      = "./modules/rds-postgres"
  name_prefix = local.name_prefix
  tags        = local.common_tags
}

locals {
  # DBAgent Lambda env + VPC placement: point at RDS only when the database is enabled.
  db_lambda_env = var.enable_database ? { DATABASE_URL = module.rds_postgres[0].database_url } : {}
  db_subnet_ids = var.enable_database ? module.rds_postgres[0].private_subnet_ids : []
  db_sg_ids     = var.enable_database ? [module.rds_postgres[0].lambda_security_group_id] : []
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
    "action-db" = {
      zip_path               = "${var.dist_dir}/action-db.zip"
      role_arn               = module.iam.lambda_db_role_arn
      environment            = merge({ LOG_LEVEL = var.log_level }, local.db_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = var.lambda_timeout_seconds
      memory_size            = var.lambda_memory_mb
      description            = "DBAgent action-group Lambda: resolve user name -> identifiers (Postgres or in-memory mirror)."
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
    # ── Auth: login endpoint + request authorizer (see auth.tf for the shared secret/locals) ──
    "auth-login" = {
      zip_path = "${var.dist_dir}/auth-login.zip"
      role_arn = local.auth_login_role_arn
      environment = merge(local.auth_common_env, local.db_lambda_env, {
        AUTH_TOKEN_TTL_SECONDS = local.auth_token_ttl_seconds
      })
      # Reaches the user store — attach to the DB VPC when the database is enabled (else no VPC).
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = var.lambda_timeout_seconds
      memory_size            = var.lambda_memory_mb
      description            = "Login: verify credentials and mint a signed session token carrying the user's IDs."
    }
    "auth-authorizer" = {
      zip_path    = "${var.dist_dir}/auth-authorizer.zip"
      role_arn    = module.iam.lambda_basic_role_arn
      environment = local.auth_common_env
      timeout     = 10
      memory_size = var.lambda_memory_mb
      description = "API Gateway request authorizer: verify the bearer token, inject the caller's IDs."
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

  # Auth: login integration + the token authorizer that gates POST /v1/ask.
  login_invoke_arn         = module.lambda_workers.invoke_arns["auth-login"]
  login_function_name      = module.lambda_workers.function_names["auth-login"]
  authorizer_invoke_arn    = module.lambda_workers.invoke_arns["auth-authorizer"]
  authorizer_function_name = module.lambda_workers.function_names["auth-authorizer"]

  tags = local.common_tags
}
