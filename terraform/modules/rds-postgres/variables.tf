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

variable "tags" {
  type    = map(string)
  default = {}
}
