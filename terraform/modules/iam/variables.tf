variable "name_prefix" {
  type        = string
  description = "Prefix for IAM resource names."
}

variable "foundation_model_arns" {
  type        = list(string)
  description = "ARNs of the foundation model(s) the agents/flow may invoke."
}

variable "tags" {
  type    = map(string)
  default = {}
}
