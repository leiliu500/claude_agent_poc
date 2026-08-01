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

  # Agentic API Gateway proxy env. GATEWAY_MOCK=true makes the generic proxy return deterministic
  # synthetic responses instead of making outbound calls (useful before real backends are reachable
  # from the VPC — the DB subnets have no NAT). Off in real deploys so the proxy actually calls apps.
  gateway_lambda_env = var.gateway_mock ? { GATEWAY_MOCK = "true" } : {}
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
    # Fedline's former per-domain action Lambdas (action-edd / action-xship-report /
    # action-xship-download / action-relationship) are retired. Fedline is now a runtime-registered
    # Agentic API Gateway backend served by the generic proxy (action-gateway); its rich mock data
    # comes from mock/data.ts via the proxy's mock adapter. Remaining action groups: db, kb, gateway.
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
    # ── KB (knowledge base / RAG) action group. Embeds the query with Bedrock + retrieves from the
    #    pgvector store when the database is enabled (VPC-attached, DB role for Bedrock+VPC); otherwise
    #    it degrades to the in-code corpus, exactly like action-db degrades to the in-memory directory. ──
    "action-kb" = {
      zip_path               = "${var.dist_dir}/action-kb.zip"
      role_arn               = module.iam.lambda_db_role_arn
      environment            = merge({ LOG_LEVEL = var.log_level, BEDROCK_REGION = local.region }, local.db_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = var.lambda_timeout_seconds
      memory_size            = var.lambda_memory_mb
      description            = "KB action-group Lambda: RAG answer over pgvector (Bedrock embeddings) or in-code corpus."
    }
    # ── Agentic API Gateway collaborator action group: retrieve candidate backends from the pgvector
    #    registry (Bedrock embeddings) + invoke the chosen one via the generic HTTP proxy. In-VPC +
    #    DB role for retrieval; outbound proxy calls reach only VPC-reachable targets (no NAT today). ──
    "action-gateway" = {
      zip_path               = "${var.dist_dir}/action-gateway.zip"
      role_arn               = module.iam.lambda_db_role_arn
      environment            = merge({ LOG_LEVEL = var.log_level, BEDROCK_REGION = local.region }, local.db_lambda_env, local.gateway_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = var.lambda_timeout_seconds
      memory_size            = var.lambda_memory_mb
      description            = "Gateway action-group Lambda: retrieve registered backends (pgvector) + invoke via the generic HTTP proxy."
    }
    # ── Gateway registration admin: register/list/remove backends by OpenAPI spec (direct-invoke or
    #    S3-triggered). Embeds operations + upserts into the pgvector registry. Needs DB + Bedrock. ──
    "gateway-register" = {
      zip_path               = "${var.dist_dir}/gateway-register.zip"
      role_arn               = var.enable_database ? module.iam.lambda_db_role_arn : module.iam.lambda_basic_role_arn
      environment            = merge({ LOG_LEVEL = var.log_level, BEDROCK_REGION = local.region }, local.db_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = 120
      memory_size            = 512
      description            = "Register/list/remove Agentic API Gateway backends by OpenAPI spec (pgvector registry)."
    }
    # ── KB ingestion: S3-triggered chunk→embed→upsert into pgvector. Only functional with the DB. ──
    "ingest-kb" = {
      zip_path               = "${var.dist_dir}/ingest-kb.zip"
      role_arn               = var.enable_database ? module.iam.lambda_db_role_arn : module.iam.lambda_basic_role_arn
      environment            = merge({ LOG_LEVEL = var.log_level, BEDROCK_REGION = local.region }, local.db_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = 300
      memory_size            = 512
      description            = "S3-triggered: chunk + Bedrock-embed documents and upsert into the pgvector knowledge store."
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
      zip_path = "${var.dist_dir}/flow-process.zip"
      # Reaches RDS for per-user report memory (recall/remember reportIds). Uses the DB role +
      # VPC placement when the database is enabled; otherwise stays out of the VPC and the memory
      # store degrades to an in-process map (no cross-session persistence, no behavior change).
      role_arn = var.enable_database ? module.iam.lambda_db_role_arn : module.iam.lambda_basic_role_arn
      # POSTDISPATCH_MODEL activates the per-app post-dispatch agents (Fedline analytics→report) via the
      # Converse API. Bounded + fallback: any failure/timeout degrades to the deterministic report, so
      # this is safe to enable. Needs the DB role's bedrock:InvokeModel + the bedrock-runtime VPC endpoint.
      # Bounded so the LLM router + the two post-dispatch agents (analytics→report) all fit under the
      # flow's sync budget (FLOW_TIMEOUT_MS): a warm request is ~router 5s + agents ~5s each. On a cold
      # start these may exceed and degrade to the deterministic report — the trace then shows those
      # agents as skipped rather than blocking. (Removing the vestigial supervisor agent node would
      # reclaim ~3s and make post-dispatch fit reliably even cold.)
      environment = merge({
        LOG_LEVEL          = var.log_level
        POSTDISPATCH_MODEL = var.foundation_model
        # foundation_model is a REASONING model (openai.gpt-oss-*): it emits a chain-of-thought block
        # that consumes output tokens BEFORE the answer, so every agent's token budget must cover
        # reasoning + the answer or the agent returns empty text (same reason the router needs ~1500).
        POSTDISPATCH_MAX_TOKENS  = "2000"
        GATEWAY_AGENT_MAX_TOKENS = "1500"
        # Four LLM hops run in sequence per request (route → gateway discover → analytics → report). Now
        # that the entrypoint runs via a Function URL (no 30s cap), these are generous so a genuinely slow
        # agent path completes instead of degrading; the sum still stays under FLOW_TIMEOUT_MS (115s) and
        # the flow-process Lambda timeout (120s). Any single hop that exceeds its bound still falls back.
        LLM_ROUTER_TIMEOUT_MS         = "20000"
        GATEWAY_AGENT_TIMEOUT_MS      = "20000"
        POSTDISPATCH_BUDGET_MS        = "45000"
        POSTDISPATCH_AGENT_TIMEOUT_MS = "20000"
      }, local.db_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      # ~2 min so the full multi-agent path can complete (the entrypoint's Function URL allows it).
      timeout     = 120
      memory_size = var.lambda_memory_mb
      description = "Flow node: combined dispatch+analytics+report; reads/writes per-user report memory."
    }
    # ── One-off DB migration: applies db/schema.sql to RDS from inside the VPC (invoke manually
    #    after a schema change; the script is idempotent). Only useful when the database is enabled. ──
    "db-migrate" = {
      zip_path               = "${var.dist_dir}/db-migrate.zip"
      role_arn               = var.enable_database ? module.iam.lambda_db_role_arn : module.iam.lambda_basic_role_arn
      environment            = merge({ LOG_LEVEL = var.log_level }, local.db_lambda_env)
      vpc_subnet_ids         = local.db_subnet_ids
      vpc_security_group_ids = local.db_sg_ids
      timeout                = 60
      memory_size            = var.lambda_memory_mb
      description            = "One-off: apply db/schema.sql to RDS from inside the VPC (idempotent)."
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
  supervisor_instruction = file("${path.module}/../src/agents/prompts/supervisor.md")
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
        # The web front-end reaches this Lambda through a Function URL (not API Gateway), so the full
        # multi-agent path can run up to ~2 min instead of being cut off at API Gateway's 30s cap.
        # FLOW_TIMEOUT_MS bounds the flow wait just under the Lambda timeout (120s), so a genuinely
        # stuck run still degrades to the fast local result before the Lambda is killed.
        FLOW_TIMEOUT_MS = "115000"
        # The Function URL has no API-Gateway authorizer, so the entrypoint self-verifies the bearer
        # token with the SAME secret the authorizer uses (shared/auth.verifyToken).
        AUTH_JWT_SECRET = random_password.jwt_secret.result
        # Gateway action Lambda invoked directly for file-upload submits (SCP EASy files, etc.).
        GATEWAY_FN = module.lambda_workers.function_names["action-gateway"]
      }
      timeout     = 120
      memory_size = var.lambda_memory_mb
      description = "API entrypoint (Function URL + API Gateway): invokes the supervisor→analytics→report flow."
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

  # Auth: login integration + the token authorizer that gates POST /v1/ask.
  login_invoke_arn         = module.lambda_workers.invoke_arns["auth-login"]
  login_function_name      = module.lambda_workers.function_names["auth-login"]
  authorizer_invoke_arn    = module.lambda_workers.invoke_arns["auth-authorizer"]
  authorizer_function_name = module.lambda_workers.function_names["auth-authorizer"]

  tags = local.common_tags
}
