output "function_arns" {
  description = "Map of logical name => function ARN."
  value       = { for k, fn in aws_lambda_function.this : k => fn.arn }
}

output "function_names" {
  description = "Map of logical name => function name."
  value       = { for k, fn in aws_lambda_function.this : k => fn.function_name }
}

output "invoke_arns" {
  description = "Map of logical name => invoke ARN (for API Gateway integration)."
  value       = { for k, fn in aws_lambda_function.this : k => fn.invoke_arn }
}
