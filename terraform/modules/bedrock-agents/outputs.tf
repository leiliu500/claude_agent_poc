output "supervisor_agent_id" {
  value = aws_bedrockagent_agent.supervisor.agent_id
}

output "supervisor_agent_alias_id" {
  value = aws_bedrockagent_agent_alias.supervisor.agent_alias_id
}

output "supervisor_agent_arn" {
  value = aws_bedrockagent_agent.supervisor.agent_arn
}

output "supervisor_agent_alias_arn" {
  value = aws_bedrockagent_agent_alias.supervisor.agent_alias_arn
}

output "collaborator_agent_ids" {
  value = { for k, a in aws_bedrockagent_agent.collaborator : k => a.agent_id }
}

output "collaborator_alias_ids" {
  value = { for k, a in aws_bedrockagent_agent_alias.collaborator : k => a.agent_alias_id }
}
