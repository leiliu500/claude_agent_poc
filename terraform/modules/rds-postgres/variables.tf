variable "name_prefix" {
  type = string
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "fedline"
}

variable "db_username" {
  description = "Master username for the Postgres instance."
  type        = string
  default     = "fedline_app"
}

variable "engine_version" {
  description = "Postgres engine version (must be offered in the target region; see aws rds describe-db-engine-versions)."
  type        = string
  default     = "16.10"
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t3.micro"
}

variable "allocated_storage" {
  description = "Allocated storage (GB)."
  type        = number
  default     = 20
}

variable "vpc_cidr" {
  description = "CIDR for the self-contained VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "enable_kb_vpc_endpoints" {
  description = "Create interface (bedrock-runtime) + gateway (S3) VPC endpoints so the KB Lambdas can reach Bedrock + S3 from the private subnets (the VPC has no NAT). Disable to skip the endpoint cost if KB is unused."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
