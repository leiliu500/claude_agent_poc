# One CloudWatch log group per function with explicit retention.
resource "aws_cloudwatch_log_group" "this" {
  for_each          = var.functions
  name              = "/aws/lambda/${var.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lambda_function" "this" {
  for_each = var.functions

  function_name = "${var.name_prefix}-${each.key}"
  description   = each.value.description
  role          = each.value.role_arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = each.value.zip_path
  source_code_hash = filebase64sha256(each.value.zip_path)

  timeout     = each.value.timeout
  memory_size = each.value.memory_size

  environment {
    variables = each.value.environment
  }

  # Attach to a VPC only when subnets are supplied (the DBAgent Lambda when the DB is enabled).
  dynamic "vpc_config" {
    for_each = length(each.value.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = each.value.vpc_subnet_ids
      security_group_ids = each.value.vpc_security_group_ids
    }
  }

  depends_on = [aws_cloudwatch_log_group.this]
  tags       = var.tags
}
