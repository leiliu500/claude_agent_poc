output "api_ask_url" {
  description = "POST your { question } here."
  value       = module.api_gateway.ask_url
}

output "web_app_url" {
  description = "Open the chat frontend here (served from the private S3 bucket via API Gateway)."
  value       = module.api_gateway.app_url
}

output "web_bucket" {
  description = "Private S3 bucket holding the frontend bundle. Deploy with: aws s3 sync ../web s3://<this> --delete"
  value       = aws_s3_bucket.web.id
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
