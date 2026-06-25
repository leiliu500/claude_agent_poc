variable "name_prefix" {
  type = string
}

variable "functions" {
  description = "Map of logical name => function config."
  type = map(object({
    zip_path    = string
    role_arn    = string
    environment = map(string)
    timeout     = number
    memory_size = number
    description = string
  }))
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "tags" {
  type    = map(string)
  default = {}
}
