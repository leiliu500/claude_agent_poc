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

variable "web_serve_invoke_arn" {
  description = "invoke_arn of the web-serve Lambda that streams the static frontend from S3."
  type        = string
}

variable "web_serve_function_name" {
  description = "Function name of the web-serve Lambda (for the invoke permission)."
  type        = string
}

# ── Auth: login endpoint + request authorizer ──────────────────────────────────
variable "login_invoke_arn" {
  description = "invoke_arn of the auth-login Lambda (POST /v1/login integration)."
  type        = string
}

variable "login_function_name" {
  description = "Function name of the auth-login Lambda (for the invoke permission)."
  type        = string
}

variable "authorizer_invoke_arn" {
  description = "invoke_arn of the auth-authorizer Lambda (verifies the bearer token on /v1/ask)."
  type        = string
}

variable "authorizer_function_name" {
  description = "Function name of the auth-authorizer Lambda (for the invoke permission)."
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
