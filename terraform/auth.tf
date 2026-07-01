# ──────────────────────────────────────────────────────────────────────────────
# Authentication wiring — the signing secret shared by the login + authorizer Lambdas,
# plus the role/VPC/env selection for the login Lambda (which reads the user store).
#
# Flow:
#   POST /v1/login  (auth-login)      → verify credentials, mint an HS256 session token
#                                        carrying the user's resolved IDs.
#   POST /v1/ask    (auth-authorizer) → verify that token at the API edge, inject the IDs as
#                                        authorizer context for the entrypoint.
# ──────────────────────────────────────────────────────────────────────────────

# HMAC signing key for session tokens. Generated once and shared by both auth Lambdas via env.
resource "random_password" "jwt_secret" {
  length  = 48
  special = false
}

# Also persisted to Secrets Manager for rotation/audit (the Lambdas read it from env for simplicity;
# switch to reading this secret at runtime if you rotate without a redeploy).
resource "aws_secretsmanager_secret" "jwt" {
  name = "${local.name_prefix}-auth-jwt"
  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = jsonencode({ secret = random_password.jwt_secret.result })
}

locals {
  # Session token lifetime. The chat UI enforces the same expiry client-side and re-logs-in past it.
  auth_token_ttl_seconds = "3600"

  # Base env for both auth Lambdas.
  auth_common_env = {
    LOG_LEVEL       = var.log_level
    AUTH_JWT_SECRET = random_password.jwt_secret.result
  }

  # The login Lambda queries the SAME user store as the DBAgent: when the database is enabled it
  # needs DATABASE_URL + VPC placement + the db role (VPC/secret perms); otherwise it uses the
  # in-code directory mirror and the basic role.
  auth_login_role_arn = var.enable_database ? module.iam.lambda_db_role_arn : module.iam.lambda_basic_role_arn
}
