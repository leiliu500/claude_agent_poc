output "api_ask_url" {
  description = "POST your { question } here (requires a bearer token from /v1/login)."
  value       = module.api_gateway.ask_url
}

output "api_login_url" {
  description = "POST { username, password } here to obtain a session token."
  value       = module.api_gateway.login_url
}

output "supervisor_agent_id" {
  value = module.bedrock_agents.supervisor_agent_id
}

output "supervisor_agent_alias_id" {
  value = module.bedrock_agents.supervisor_agent_alias_id
}

output "collaborator_agent_ids" {
  value = module.bedrock_agents.collaborator_agent_ids
}

output "flow_id" {
  value = module.bedrock_flow.flow_id
}

output "flow_alias_id" {
  value = module.bedrock_flow.flow_alias_id
}

output "worker_lambda_names" {
  value = module.lambda_workers.function_names
}

output "entrypoint_lambda_name" {
  value = module.lambda_entrypoint.function_names["api-entrypoint"]
}

output "database_endpoint" {
  description = "RDS Postgres endpoint (empty unless enable_database=true)."
  value       = var.enable_database ? module.rds_postgres[0].db_endpoint : ""
}

output "database_secret_arn" {
  description = "Secrets Manager ARN with the DB credentials (empty unless enable_database=true)."
  value       = var.enable_database ? module.rds_postgres[0].secret_arn : ""
}
