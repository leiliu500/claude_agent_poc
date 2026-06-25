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

  depends_on = [aws_cloudwatch_log_group.this]
  tags       = var.tags
}
