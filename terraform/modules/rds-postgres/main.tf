# ──────────────────────────────────────────────────────────────────────────────
# RDS Postgres — the DBAgent's user-identifier directory (db/schema.sql).
#
# Self-contained: its own VPC + two private subnets + subnet group + security groups, so it does
# not depend on any pre-existing networking. The DBAgent Lambda attaches to `lambda_security_group`
# and reaches Postgres over 5432; the instance is NOT publicly accessible.
#
# The master password is generated and stored in Secrets Manager. DATABASE_URL is emitted for the
# Lambda; for production prefer reading the secret at runtime over passing the URL in plaintext env.
# Load db/schema.sql after the instance is up (e.g. `psql "$DATABASE_URL" -f db/schema.sql`).
# ──────────────────────────────────────────────────────────────────────────────
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = "${var.name_prefix}-db-vpc" })
}

# Two private subnets in distinct AZs (RDS requires a subnet group spanning >= 2 AZs).
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = merge(var.tags, { Name = "${var.name_prefix}-db-private-${count.index}" })
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = var.tags
}

# Security group attached to the DBAgent Lambda (source of DB traffic).
resource "aws_security_group" "lambda" {
  name        = "${var.name_prefix}-db-lambda-sg"
  description = "DBAgent Lambda egress to Postgres."
  vpc_id      = aws_vpc.this.id

  egress {
    description = "All egress (reach RDS + VPC endpoints)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-db-lambda-sg" })
}

# Security group on the DB instance: allow 5432 only from the Lambda SG.
resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db-sg"
  description = "Postgres ingress from the DBAgent Lambda only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Postgres from DBAgent Lambda."
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-db-sg" })
}

resource "random_password" "master" {
  length  = 24
  special = false
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name_prefix}-fedline"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.db_username
  password = random_password.master.result

  allocated_storage   = var.allocated_storage
  storage_encrypted   = true
  storage_type        = "gp3"
  multi_az            = false
  publicly_accessible = false
  skip_final_snapshot = true
  deletion_protection = false

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]

  tags = merge(var.tags, { Name = "${var.name_prefix}-fedline" })
}

# ──────────────────────────────────────────────────────────────────────────────
# VPC endpoints — the KB Lambdas (action-kb, ingest-kb) run in these private subnets to reach RDS,
# but also need to call Bedrock (embeddings/generation) and read S3 (ingest). The VPC has no NAT /
# internet gateway, so we add:
#   - an INTERFACE endpoint for bedrock-runtime (private access to InvokeModel), and
#   - a GATEWAY endpoint for S3 (private access to GetObject during ingestion).
# Guarded by var.enable_kb_vpc_endpoints so a DB-only deployment can opt out of the endpoint cost.
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_route_table" "private" {
  count  = var.enable_kb_vpc_endpoints ? 1 : 0
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-db-private-rt" })
}

resource "aws_route_table_association" "private" {
  count          = var.enable_kb_vpc_endpoints ? 2 : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# Security group for the interface endpoint: allow HTTPS from the Lambda SG only.
resource "aws_security_group" "vpce" {
  count       = var.enable_kb_vpc_endpoints ? 1 : 0
  name        = "${var.name_prefix}-db-vpce-sg"
  description = "HTTPS to interface VPC endpoints from the VPC Lambdas."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "HTTPS from VPC Lambdas."
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-db-vpce-sg" })
}

resource "aws_vpc_endpoint" "bedrock_runtime" {
  count               = var.enable_kb_vpc_endpoints ? 1 : 0
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpce[0].id]
  private_dns_enabled = true
  tags                = merge(var.tags, { Name = "${var.name_prefix}-bedrock-runtime-vpce" })
}

resource "aws_vpc_endpoint" "s3" {
  count             = var.enable_kb_vpc_endpoints ? 1 : 0
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private[0].id]
  tags              = merge(var.tags, { Name = "${var.name_prefix}-s3-vpce" })
}

# Store credentials + connection info in Secrets Manager (production-preferred over plaintext env).
resource "aws_secretsmanager_secret" "db" {
  name = "${var.name_prefix}-fedline-db"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.master.result
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    dbname   = var.db_name
  })
}
