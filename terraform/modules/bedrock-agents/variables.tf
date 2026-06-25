variable "name_prefix" {
  type = string
}

variable "foundation_model" {
  type = string
}

variable "agent_role_arn" {
  description = "Shared Bedrock agent service role ARN (supervisor + collaborators)."
  type        = string
}

variable "supervisor_instruction" {
  description = "Instruction prompt for the supervisor agent."
  type        = string
}

variable "collaborators" {
  description = "Map of slug => collaborator config."
  type = map(object({
    display_name              = string # Bedrock collaborator_name (alnum/_- only)
    instruction               = string # agent instruction prompt
    api_schema                = string # OpenAPI JSON for the action group
    lambda_arn                = string # action-group Lambda ARN
    collaboration_instruction = string # how the supervisor should use this collaborator
  }))
}

variable "idle_session_ttl_seconds" {
  type    = number
  default = 600
}

variable "tags" {
  type    = map(string)
  default = {}
}
