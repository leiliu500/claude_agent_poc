provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      System      = "bedrock-agentic-reporting"
    }
  }
}

# AWS Cloud Control provider — used for Bedrock Flow version + alias resources,
# which the hashicorp/aws provider does not yet expose.
provider "awscc" {
  region = var.aws_region
}
