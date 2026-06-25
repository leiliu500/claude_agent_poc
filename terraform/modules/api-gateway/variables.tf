variable "name_prefix" {
  type = string
}

variable "entrypoint_lambda_arn" {
  description = "ARN of the api-entrypoint Lambda."
  type        = string
}

variable "entrypoint_invoke_arn" {
  description = "invoke_arn of the api-entrypoint Lambda (for the integration URI)."
  type        = string
}

variable "entrypoint_function_name" {
  description = "Function name of the api-entrypoint Lambda (for the invoke permission)."
  type        = string
}

variable "stage_name" {
  type    = string
  default = "v1"
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "tags" {
  type    = map(string)
  default = {}
}
