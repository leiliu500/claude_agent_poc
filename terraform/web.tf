# ──────────────────────────────────────────────────────────────────────────────
# Chat frontend hosting (Option B): a PRIVATE S3 bucket served over HTTPS through the
# existing API Gateway via a small web-serve Lambda. No public bucket, no CloudFront
# (unavailable in GovCloud), no CORS dependency — the UI is same-origin with /v1/ask.
#
# Deploy the static bundle with:  aws s3 sync ../web s3://<web_bucket> --delete
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "web" {
  bucket = "${local.name_prefix}-web-${local.account_id}"
  tags   = local.common_tags
}

# Private bucket — all public access blocked. Objects are only reachable via the web-serve Lambda.
resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ── IAM role for the web-serve Lambda: logs + read the web bucket. ───────────────
data "aws_iam_policy_document" "web_serve_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web_serve" {
  name               = "${local.name_prefix}-web-serve"
  assume_role_policy = data.aws_iam_policy_document.web_serve_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "web_serve_logs" {
  role       = aws_iam_role.web_serve.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "web_serve_s3" {
  statement {
    sid       = "ReadWebBucket"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
  }
}

resource "aws_iam_role_policy" "web_serve_s3" {
  name   = "${local.name_prefix}-web-serve-s3"
  role   = aws_iam_role.web_serve.id
  policy = data.aws_iam_policy_document.web_serve_s3.json
}

# ── The web-serve Lambda (reuses the generic lambda module). ─────────────────────
module "lambda_web" {
  source      = "./modules/lambda"
  name_prefix = local.name_prefix
  tags        = local.common_tags

  functions = {
    "web-serve" = {
      zip_path = "${var.dist_dir}/web-serve.zip"
      role_arn = aws_iam_role.web_serve.arn
      environment = {
        LOG_LEVEL     = var.log_level
        WEB_BUCKET    = aws_s3_bucket.web.id
        APP_BASE_PATH = "/app/"
      }
      timeout     = 15
      memory_size = 256
      description = "Serves the chat frontend (web/) from the private S3 bucket via API Gateway."
    }
  }
}
