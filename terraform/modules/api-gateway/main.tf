# HTTP API (cheaper/faster than REST API) fronting the api-entrypoint Lambda.
resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "Synchronous entrypoint for the Bedrock agentic reporting system."

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["POST", "OPTIONS"]
    # `authorization` is needed so the browser can send the bearer token on /v1/ask.
    allow_headers = ["content-type", "authorization"]
  }

  tags = var.tags
}

# ── Auth: HTTP API request authorizer (verifies the bearer token at the edge) ──
# Runs the auth-authorizer Lambda before the /v1/ask integration. Simple-response format
# ({ isAuthorized, context }); the context is forwarded to the entrypoint. TTL 0 disables result
# caching so an expired token is rejected immediately (session-timeout must force a fresh login).
resource "aws_apigatewayv2_authorizer" "token" {
  api_id                            = aws_apigatewayv2_api.this.id
  name                              = "${var.name_prefix}-token-authorizer"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = var.authorizer_invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  identity_sources                  = ["$request.header.Authorization"]
  authorizer_result_ttl_in_seconds  = 0
}

resource "aws_lambda_permission" "apigw_authorizer" {
  statement_id  = "AllowAPIGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = var.authorizer_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.token.id}"
}

# ── Auth: POST /v1/login (UNAUTHENTICATED — this is how a client obtains a token) ──
resource "aws_apigatewayv2_integration" "login" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.login_invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "login" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /v1/login"
  target    = "integrations/${aws_apigatewayv2_integration.login.id}"
}

resource "aws_lambda_permission" "apigw_login" {
  statement_id  = "AllowAPIGatewayInvokeLogin"
  action        = "lambda:InvokeFunction"
  function_name = var.login_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
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

  # Gate the flow entrypoint behind the token authorizer: auth/authz happens at the API edge.
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.token.id
}

# The static frontend is now hosted on ECS Fargate behind an ALB (see terraform/ecs-web.tf); the
# former GET /app route + web-serve Lambda integration have been removed. This API only serves /v1/*.

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
