output "lambda_basic_role_arn" {
  value = aws_iam_role.lambda_basic.arn
}

output "lambda_entrypoint_role_arn" {
  value = aws_iam_role.lambda_entrypoint.arn
}

output "bedrock_agent_role_arn" {
  value = aws_iam_role.bedrock_agent.arn
}

output "bedrock_flow_role_arn" {
  value = aws_iam_role.bedrock_flow.arn
}
