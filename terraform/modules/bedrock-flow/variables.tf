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

variable "process_lambda_arn" {
  description = "ARN of the combined Process Lambda (dispatch+analytics+report → FinalReport)."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
