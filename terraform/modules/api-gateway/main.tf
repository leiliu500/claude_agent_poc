# HTTP API (cheaper/faster than REST API) fronting the api-entrypoint Lambda.
resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "Synchronous entrypoint for the Bedrock agentic reporting system."

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["POST", "OPTIONS"]
    allow_headers = ["content-type"]
  }

  tags = var.tags
}

resource "aws_apigatewayv2_integration" "entrypoint" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.entrypoint_invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "ask" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /v1/ask"
  target    = "integrations/${aws_apigatewayv2_integration.entrypoint.id}"
}

# ── Static frontend: serve web/ from the private S3 bucket via the web-serve Lambda. ──
resource "aws_apigatewayv2_integration" "web" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.web_serve_invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# GET /app -> index.html ; GET /app/{proxy+} -> the requested asset (styles.css, app.js, …).
resource "aws_apigatewayv2_route" "web_root" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /app"
  target    = "integrations/${aws_apigatewayv2_integration.web.id}"
}

resource "aws_apigatewayv2_route" "web_assets" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /app/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.web.id}"
}

resource "aws_lambda_permission" "apigw_web" {
  statement_id  = "AllowAPIGatewayInvokeWeb"
  action        = "lambda:InvokeFunction"
  function_name = var.web_serve_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigw/${var.name_prefix}-api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      integrationErr = "$context.integrationErrorMessage"
    })
  }

  tags = var.tags
}

# Allow API Gateway to invoke the entrypoint Lambda.
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.entrypoint_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
