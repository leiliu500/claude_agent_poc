# ──────────────────────────────────────────────────────────────────────────────
# Dedicated PUBLIC VPC for the internet-facing web ALB + Fargate UI.
#
# Previously the web stack (ecs-web.tf) referenced a pre-existing account VPC via
# var.web_ecs_vpc_id / var.web_ecs_public_subnet_ids (hardcoded ids). An environment teardown deleted
# that VPC, after which `terraform apply` could no longer create the ALB / security groups / target
# group ("InvalidVpcID.NotFound") — the web module depended on infrastructure Terraform did not own.
#
# Managing the web VPC here makes the stack self-contained and self-healing: a teardown that removes it
# is simply recreated on the next apply. Two public subnets (>=2 AZs) with an internet gateway let the
# internet-facing ALB span AZs and let Fargate tasks pull the image from ECR + write logs without a NAT
# (assign_public_ip = true in ecs-web.tf).
# ──────────────────────────────────────────────────────────────────────────────

data "aws_availability_zones" "web" {
  state = "available"
}

resource "aws_vpc" "web" {
  cidr_block           = var.web_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.common_tags, { Name = "${local.name_prefix}-web-vpc" })
}

resource "aws_internet_gateway" "web" {
  vpc_id = aws_vpc.web.id
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-web-igw" })
}

resource "aws_subnet" "web_public" {
  count                   = 2
  vpc_id                  = aws_vpc.web.id
  cidr_block              = cidrsubnet(aws_vpc.web.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.web.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(local.common_tags, { Name = "${local.name_prefix}-web-public-${count.index}" })
}

resource "aws_route_table" "web_public" {
  vpc_id = aws_vpc.web.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.web.id
  }
  tags = merge(local.common_tags, { Name = "${local.name_prefix}-web-public" })
}

resource "aws_route_table_association" "web_public" {
  count          = 2
  subnet_id      = aws_subnet.web_public[count.index].id
  route_table_id = aws_route_table.web_public.id
}

# Consumed by ecs-web.tf (ALB, security groups, target group, ECS service network config).
locals {
  web_vpc_id            = aws_vpc.web.id
  web_public_subnet_ids = aws_subnet.web_public[*].id
}
