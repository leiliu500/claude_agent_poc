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
