data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  # Partition is "aws" (commercial), "aws-us-gov" (GovCloud), or "aws-cn" (China).
  partition = data.aws_partition.current.partition
}

# ──────────────────────────────────────────────────────────────────────────────
# Lambda execution roles
# ──────────────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Basic role: action-group / analytics / report Lambdas (logs only).
resource "aws_iam_role" "lambda_basic" {
  name               = "${var.name_prefix}-lambda-basic"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic_logs" {
  role       = aws_iam_role.lambda_basic.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Entrypoint role: logs + invoke the supervisor agent and the flow.
resource "aws_iam_role" "lambda_entrypoint" {
  name               = "${var.name_prefix}-lambda-entrypoint"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_entrypoint_logs" {
  role       = aws_iam_role.lambda_entrypoint.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "entrypoint_bedrock" {
  # The entrypoint only invokes the flow (the supervisor agent runs inside it).
  statement {
    sid     = "InvokeFlow"
    effect  = "Allow"
    actions = ["bedrock:InvokeFlow"]
    resources = [
      "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:flow/*",
      "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:flow/*/alias/*"
    ]
  }
}

resource "aws_iam_role_policy" "entrypoint_bedrock" {
  name   = "${var.name_prefix}-entrypoint-bedrock"
  role   = aws_iam_role.lambda_entrypoint.id
  policy = data.aws_iam_policy_document.entrypoint_bedrock.json
}

# DBAgent role: logs + VPC ENI management (to reach RDS) + read the DB credentials secret.
# Used by the action-db Lambda. The VPC/secret perms are harmless when the DB is disabled (the
# Lambda then runs the in-memory directory and never attaches to a VPC or reads the secret).
resource "aws_iam_role" "lambda_db" {
  name               = "${var.name_prefix}-lambda-db"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_db_logs" {
  role       = aws_iam_role.lambda_db.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_db_vpc" {
  role       = aws_iam_role.lambda_db.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_db_secret" {
  statement {
    sid       = "ReadDbSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${var.name_prefix}-fedline-db-*"]
  }
}

resource "aws_iam_role_policy" "lambda_db_secret" {
  name   = "${var.name_prefix}-lambda-db-secret"
  role   = aws_iam_role.lambda_db.id
  policy = data.aws_iam_policy_document.lambda_db_secret.json
}

# The KB action Lambda (query embedding + optional generation) and the ingest Lambda (chunk
# embedding) call Bedrock InvokeModel. Both run on the DB role (they are VPC-attached to reach RDS),
# so grant InvokeModel here. Scoped to foundation models + inference profiles in this region; harmless
# for the other DB-role Lambdas that never call Bedrock.
data "aws_iam_policy_document" "lambda_db_bedrock" {
  statement {
    sid     = "InvokeBedrockModels"
    effect  = "Allow"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:${local.partition}:bedrock:${local.region}::foundation-model/*",
      "arn:${local.partition}:bedrock:${local.region}:${local.account_id}:inference-profile/*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda_db_bedrock" {
  name   = "${var.name_prefix}-lambda-db-bedrock"
  role   = aws_iam_role.lambda_db.id
  policy = data.aws_iam_policy_document.lambda_db_bedrock.json
}

# ──────────────────────────────────────────────────────────────────────────────
# Bedrock Agent service role (assumed by bedrock.amazonaws.com)
# ──────────────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "bedrock_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "bedrock_agent" {
  name               = "${var.name_prefix}-bedrock-agent"
  assume_role_policy = data.aws_iam_policy_document.bedrock_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "bedrock_agent" {
  statement {
    sid       = "InvokeFoundationModel"
    effect    = "Allow"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = var.foundation_model_arns
  }
  # Supervisor must be able to call its collaborator agents' aliases.
  statement {
    sid       = "InvokeCollaborators"
    effect    = "Allow"
    actions   = ["bedrock:InvokeAgent", "bedrock:GetAgentAlias"]
    resources = ["arn:${local.partition}:bedrock:${local.region}:${local.account_id}:agent-alias/*"]
  }
}

resource "aws_iam_role_policy" "bedrock_agent" {
  name   = "${var.name_prefix}-bedrock-agent"
  role   = aws_iam_role.bedrock_agent.id
  policy = data.aws_iam_policy_document.bedrock_agent.json
}

# ──────────────────────────────────────────────────────────────────────────────
# Bedrock Flow service role (assumed by bedrock.amazonaws.com)
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "bedrock_flow" {
  name               = "${var.name_prefix}-bedrock-flow"
  assume_role_policy = data.aws_iam_policy_document.bedrock_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "bedrock_flow" {
  statement {
    sid       = "InvokeFoundationModel"
    effect    = "Allow"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = var.foundation_model_arns
  }
  # The flow's Agent node invokes the supervisor agent alias.
  statement {
    sid       = "InvokeSupervisorAgent"
    effect    = "Allow"
    actions   = ["bedrock:InvokeAgent", "bedrock:GetAgentAlias"]
    resources = ["arn:${local.partition}:bedrock:${local.region}:${local.account_id}:agent-alias/*"]
  }
  # Flow Lambda nodes invoke the dispatch + analytics + report Lambdas.
  statement {
    sid       = "InvokeFlowLambdas"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${var.name_prefix}-*"]
  }
}

resource "aws_iam_role_policy" "bedrock_flow" {
  name   = "${var.name_prefix}-bedrock-flow"
  role   = aws_iam_role.bedrock_flow.id
  policy = data.aws_iam_policy_document.bedrock_flow.json
}
