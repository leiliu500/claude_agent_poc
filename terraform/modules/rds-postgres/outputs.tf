output "database_url" {
  description = "Postgres connection string for the DBAgent Lambda (DATABASE_URL)."
  value       = "postgres://${var.db_username}:${random_password.master.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.db_name}"
  sensitive   = true
}

output "secret_arn" {
  description = "Secrets Manager secret holding the DB credentials + host."
  value       = aws_secretsmanager_secret.db.arn
}

output "lambda_security_group_id" {
  description = "Security group the DBAgent Lambda must attach to in order to reach Postgres."
  value       = aws_security_group.lambda.id
}

output "private_subnet_ids" {
  description = "Private subnets for the DBAgent Lambda's VPC config."
  value       = aws_subnet.private[*].id
}

output "db_endpoint" {
  description = "RDS endpoint host:port."
  value       = "${aws_db_instance.this.address}:${aws_db_instance.this.port}"
}
