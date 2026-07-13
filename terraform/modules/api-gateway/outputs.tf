output "api_endpoint" {
  description = "Base invoke URL for the HTTP API."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "ask_url" {
  description = "Full URL for the POST /v1/ask route."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/v1/ask"
}

output "login_url" {
  description = "Full URL for the POST /v1/login route."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/v1/login"
}

