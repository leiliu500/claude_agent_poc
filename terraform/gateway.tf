# ──────────────────────────────────────────────────────────────────────────────
# Agentic API Gateway — backend registration bucket + trigger.
#
# Drop a registration document (JSON: { backendId, name?, description?, baseUrl, auth?, openapi })
# into this bucket and the gateway-register Lambda parses the OpenAPI spec, embeds each operation, and
# upserts it into the pgvector registry — making the app routable with no code change or redeploy.
# Gated on enable_database: durable registration needs the RDS/pgvector store (an in-memory registry
# isn't shared between the register Lambda and the proxy). Registration is also available via a direct
# Lambda invoke ({ action: "register" | "list" | "get" | "remove", ... }) without the bucket.
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "gateway_specs" {
  count         = var.enable_database ? 1 : 0
  bucket        = "${local.name_prefix}-gateway-specs-${local.account_id}"
  force_destroy = true
  tags          = merge(local.common_tags, { Name = "${local.name_prefix}-gateway-specs" })
}

resource "aws_s3_bucket_public_access_block" "gateway_specs" {
  count                   = var.enable_database ? 1 : 0
  bucket                  = aws_s3_bucket.gateway_specs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "gateway_specs" {
  count  = var.enable_database ? 1 : 0
  bucket = aws_s3_bucket.gateway_specs[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# Let S3 invoke the register Lambda on object create.
resource "aws_lambda_permission" "gateway_register_s3" {
  count         = var.enable_database ? 1 : 0
  statement_id  = "AllowS3InvokeGatewayRegister"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_workers.function_names["gateway-register"]
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.gateway_specs[0].arn
}

resource "aws_s3_bucket_notification" "gateway_specs" {
  count  = var.enable_database ? 1 : 0
  bucket = aws_s3_bucket.gateway_specs[0].id

  lambda_function {
    lambda_function_arn = module.lambda_workers.function_arns["gateway-register"]
    events              = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_lambda_permission.gateway_register_s3]
}

# Let the register Lambda (on the DB role) read registration documents from the specs bucket.
data "aws_iam_policy_document" "gateway_specs_read" {
  count = var.enable_database ? 1 : 0
  statement {
    sid       = "ReadGatewaySpecsBucket"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.gateway_specs[0].arn, "${aws_s3_bucket.gateway_specs[0].arn}/*"]
  }
}

resource "aws_iam_role_policy" "gateway_specs_read" {
  count  = var.enable_database ? 1 : 0
  name   = "${local.name_prefix}-gateway-register-s3-read"
  role   = module.iam.lambda_db_role_name
  policy = data.aws_iam_policy_document.gateway_specs_read[0].json
}

# Let the API entrypoint invoke the gateway action Lambda directly for file-upload submits (the file
# bytes go straight to the VPC Lambda + generic proxy, never through the supervisor LLM).
data "aws_iam_policy_document" "entrypoint_invoke_gateway" {
  statement {
    sid       = "InvokeGatewayLambda"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [module.lambda_workers.function_arns["action-gateway"]]
  }
}

resource "aws_iam_role_policy" "entrypoint_invoke_gateway" {
  name   = "${local.name_prefix}-entrypoint-invoke-gateway"
  role   = module.iam.lambda_entrypoint_role_name
  policy = data.aws_iam_policy_document.entrypoint_invoke_gateway.json
}

output "gateway_specs_bucket_name" {
  description = "S3 bucket for gateway backend registration documents (drop specs here to register apps). Empty when the database is disabled."
  value       = var.enable_database ? aws_s3_bucket.gateway_specs[0].bucket : ""
}
