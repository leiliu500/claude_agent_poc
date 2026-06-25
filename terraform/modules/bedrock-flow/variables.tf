variable "name_prefix" {
  type = string
}

variable "flow_role_arn" {
  description = "Bedrock Flow execution role ARN."
  type        = string
}

variable "supervisor_alias_arn" {
  description = "ARN of the supervisor agent alias invoked by the in-flow Agent node."
  type        = string
}

variable "dispatch_lambda_arn" {
  description = "ARN of the Dispatch Lambda (parses the supervisor output into DispatchResult[])."
  type        = string
}

variable "analytics_lambda_arn" {
  type = string
}

variable "report_lambda_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
