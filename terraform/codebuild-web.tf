# ──────────────────────────────────────────────────────────────────────────────
# In-account image build for the UI (no local Docker needed).
#
# CodeBuild has Docker; it pulls a source zip (Dockerfile + web/) from S3, builds the nginx image, and
# pushes it to the ECR repo the ECS service runs. Rebuild the UI later with:
#   (re-zip source) → aws s3 cp source.zip s3://<web_build_source_bucket>/source.zip
#   → aws codebuild start-build --project-name bedrock-reporting-dev-web-build
#   → aws ecs update-service --cluster bedrock-reporting-dev-web --service bedrock-reporting-dev-web --force-new-deployment
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "web_build" {
  bucket        = "${local.name_prefix}-web-build-${local.account_id}"
  force_destroy = true
  tags          = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "web_build" {
  bucket                  = aws_s3_bucket.web_build.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── CodeBuild service role ───────────────────────────────────────────────────────
data "aws_iam_policy_document" "web_build_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web_build" {
  name               = "${local.name_prefix}-web-build"
  assume_role_policy = data.aws_iam_policy_document.web_build_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "web_build" {
  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/codebuild/${local.name_prefix}-web-build*"]
  }
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid    = "EcrPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.web.arn]
  }
  statement {
    sid       = "SourceRead"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.web_build.arn, "${aws_s3_bucket.web_build.arn}/*"]
  }
}

resource "aws_iam_role_policy" "web_build" {
  name   = "${local.name_prefix}-web-build"
  role   = aws_iam_role.web_build.id
  policy = data.aws_iam_policy_document.web_build.json
}

# ── CodeBuild project ────────────────────────────────────────────────────────────
resource "aws_codebuild_project" "web" {
  name         = "${local.name_prefix}-web-build"
  service_role = aws_iam_role.web_build.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux2-x86_64-standard:5.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true # required to run Docker

    environment_variable {
      name  = "ECR_REPO"
      value = aws_ecr_repository.web.repository_url
    }
    environment_variable {
      name  = "ECR_REGISTRY"
      value = "${local.account_id}.dkr.ecr.${local.region}.amazonaws.com"
    }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.web_build.id}/source.zip"
    buildspec = <<-EOT
      version: 0.2
      phases:
        pre_build:
          commands:
            - echo Logging in to ECR...
            - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
        build:
          commands:
            - echo Building image...
            - docker build -t $ECR_REPO:latest .
        post_build:
          commands:
            - echo Pushing image...
            - docker push $ECR_REPO:latest
    EOT
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.name_prefix}-web-build"
    }
  }

  tags = local.common_tags
}

output "web_build_source_bucket" {
  description = "Upload the UI build source (source.zip = Dockerfile + web/) here, then start the CodeBuild project."
  value       = aws_s3_bucket.web_build.id
}
