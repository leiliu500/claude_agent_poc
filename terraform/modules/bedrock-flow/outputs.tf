output "flow_id" {
  value = aws_bedrockagent_flow.this.id
}

output "flow_arn" {
  value = aws_bedrockagent_flow.this.arn
}

output "flow_alias_id" {
  value = awscc_bedrock_flow_alias.this.flow_alias_id
}
