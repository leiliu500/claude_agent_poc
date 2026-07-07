# ──────────────────────────────────────────────────────────────────────────────
# Knowledge base (RAG) document corpus + ingestion trigger.
#
# Documents dropped into this bucket are ingested by the ingest-kb Lambda (chunk → Bedrock embed →
# upsert into the pgvector store). Gated on enable_database: without the RDS/pgvector store there is
# nowhere to ingest to. For an initial backfill, invoke ingest-kb directly with { bucket, keys }.
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "kb" {
  count         = var.enable_database ? 1 : 0
  bucket        = "${local.name_prefix}-kb-docs-${local.account_id}"
  force_destroy = true
  tags          = merge(local.common_tags, { Name = "${local.name_prefix}-kb-docs" })
}

resource "aws_s3_bucket_public_access_block" "kb" {
  count                   = var.enable_database ? 1 : 0
  bucket                  = aws_s3_bucket.kb[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "kb" {
  count  = var.enable_database ? 1 : 0
  bucket = aws_s3_bucket.kb[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# Let S3 invoke the ingest Lambda on object create.
resource "aws_lambda_permission" "kb_ingest_s3" {
  count         = var.enable_database ? 1 : 0
  statement_id  = "AllowS3InvokeIngestKb"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_workers.function_names["ingest-kb"]
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.kb[0].arn
}

resource "aws_s3_bucket_notification" "kb" {
  count  = var.enable_database ? 1 : 0
  bucket = aws_s3_bucket.kb[0].id

  lambda_function {
    lambda_function_arn = module.lambda_workers.function_arns["ingest-kb"]
    events              = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_lambda_permission.kb_ingest_s3]
}

# Let the ingest Lambda (on the DB role) read objects from the corpus bucket.
data "aws_iam_policy_document" "kb_ingest_s3_read" {
  count = var.enable_database ? 1 : 0
  statement {
    sid       = "ReadKbBucket"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.kb[0].arn, "${aws_s3_bucket.kb[0].arn}/*"]
  }
}

resource "aws_iam_role_policy" "kb_ingest_s3_read" {
  count  = var.enable_database ? 1 : 0
  name   = "${local.name_prefix}-ingest-kb-s3-read"
  role   = module.iam.lambda_db_role_name
  policy = data.aws_iam_policy_document.kb_ingest_s3_read[0].json
}

output "kb_bucket_name" {
  description = "S3 bucket for knowledge-base documents (drop files here to ingest them). Empty when the database is disabled."
  value       = var.enable_database ? aws_s3_bucket.kb[0].bucket : ""
}
