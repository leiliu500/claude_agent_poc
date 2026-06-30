terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Bedrock Agents multi-agent collaboration + aws_bedrockagent_flow require a recent provider.
      version = ">= 5.83.0"
    }
    awscc = {
      source = "hashicorp/awscc"
      # Flow version + alias are only available via AWS Cloud Control (awscc).
      version = ">= 1.0.0"
    }
    random = {
      source = "hashicorp/random"
      # Generates the RDS master password (DBAgent Postgres directory, optional).
      version = ">= 3.5.0"
    }
  }

  # Uncomment and configure for production remote state.
  # backend "s3" {
  #   bucket         = "my-tf-state-bucket"
  #   key            = "bedrock-agentic/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "my-tf-locks"
  #   encrypt        = true
  # }
}
