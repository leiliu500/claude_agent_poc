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

# ── Operations dashboard: POST /v1/metrics ─────────────────────────────────────
# Off when the database is disabled — there is no request log to read, so the route is not created
# and the dashboard stays on the browser's local store.
#
# The route is gated on this FLAG rather than on the ARN below being null: the ARN is a Lambda
# attribute that does not exist until apply, and a `count` that depends on an unknown value is a
# plan-time error. The flag comes from a variable, so it is always known at plan time.
variable "telemetry_enabled" {
  description = "Create the POST /v1/metrics route (needs the telemetry Lambda + a database)."
  type        = bool
  default     = false
}

variable "telemetry_invoke_arn" {
  description = "invoke_arn of the telemetry Lambda (POST /v1/metrics integration). Used when telemetry_enabled."
  type        = string
  default     = null
}

variable "telemetry_function_name" {
  description = "Function name of the telemetry Lambda (for the invoke permission). Used when telemetry_enabled."
  type        = string
  default     = null
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
