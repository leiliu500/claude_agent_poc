variable "aws_region" {
  description = "AWS region to deploy into. Must have Bedrock model access enabled."
  type        = string
  default     = "us-gov-west-1"
}

variable "project_name" {
  description = "Short project name used as a resource name prefix."
  type        = string
  default     = "bedrock-reporting"
}

variable "environment" {
  description = "Deployment environment (dev/stage/prod)."
  type        = string
  default     = "dev"
}

variable "foundation_model" {
  description = "Bedrock foundation model id used by the agents and any flow prompt nodes."
  type        = string
  default     = "openai.gpt-oss-120b-1:0"
}

variable "orchestration_mode" {
  description = "api-entrypoint mode: 'agent' (use Bedrock supervisor agent) or 'local' (deterministic in-process)."
  type        = string
  default     = "agent"

  validation {
    condition     = contains(["agent", "local"], var.orchestration_mode)
    error_message = "orchestration_mode must be 'agent' or 'local'."
  }
}

variable "log_level" {
  description = "Lambda log level: debug|info|warn|error."
  type        = string
  default     = "info"
}

variable "lambda_timeout_seconds" {
  description = "Default Lambda timeout."
  type        = number
  default     = 30
}

variable "lambda_memory_mb" {
  description = "Default Lambda memory size."
  type        = number
  default     = 256
}

variable "dist_dir" {
  description = "Path (relative to terraform/) to the built Lambda zip artifacts."
  type        = string
  default     = "../dist"
}

variable "enable_database" {
  description = <<-EOT
    Provision the RDS Postgres directory (db/schema.sql) and point the DBAgent Lambda at it via
    DATABASE_URL + VPC config. When false (default), the DBAgent Lambda uses the in-code directory
    that mirrors the schema, so the whole system runs with no database. Enabling requires the `pg`
    driver to be available to the Lambda (e.g. a layer) and db/schema.sql to be loaded once.
  EOT
  type        = bool
  default     = false
}

variable "web_ecs_vpc_id" {
  description = "VPC for the ECS/ALB UI hosting. Default is the account's VPC with public subnets."
  type        = string
  default     = "vpc-0c734bef41a621668"
}

variable "web_ecs_public_subnet_ids" {
  description = "Public subnets (>=2 AZs) for the internet-facing ALB and the Fargate tasks."
  type        = list(string)
  default     = ["subnet-06d8ecf82f3a0d213", "subnet-00cdc6e0a2128b460"]
}

variable "web_ecs_desired_count" {
  description = "Number of Fargate tasks serving the UI (2 for cross-AZ HA, 1 for a demo)."
  type        = number
  default     = 1
}

variable "web_container_cpu" {
  description = "Fargate task CPU units for the UI container (256 = 0.25 vCPU)."
  type        = string
  default     = "256"
}

variable "web_container_memory" {
  description = "Fargate task memory (MiB) for the UI container."
  type        = string
  default     = "512"
}

variable "gateway_mock" {
  description = <<-EOT
    Make the Agentic API Gateway generic proxy return deterministic synthetic responses instead of
    making real outbound HTTP calls (sets GATEWAY_MOCK=true on the gateway action Lambda). Useful
    before real backends are reachable from the DB VPC (the private subnets have no NAT). Set false to
    have the proxy actually call registered applications (targets must be VPC-reachable or behind a NAT).
  EOT
  type        = bool
  default     = true
}
