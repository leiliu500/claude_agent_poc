# ──────────────────────────────────────────────────────────────────────────────
# Chat frontend hosting on ECS Fargate behind an internet-facing Application Load Balancer.
#
#   Internet ──► ALB (:80) ──► Target Group (ip) ──► Fargate task (nginx :80, serves web/)
#
# Replaces the S3 + web-serve-Lambda hosting (web.tf) as the UI front door. The static bundle is baked
# into a container image (see ../Dockerfile) pushed to the ECR repo below. Runs in existing PUBLIC
# subnets with a public IP so the task can pull the image from ECR + write logs (no NAT needed).
#
# One-time bring-up (image must exist before the service can stay healthy):
#   1. terraform apply            # creates ECR + ALB + ECS (tasks stay pending until the image exists)
#   2. docker build/push          # see ../Dockerfile header for the exact commands
#   3. ECS pulls the image and the service reaches steady state; open web_alb_url.
# ──────────────────────────────────────────────────────────────────────────────

# ── ECR repository for the UI image ─────────────────────────────────────────────
resource "aws_ecr_repository" "web" {
  name                 = "${local.name_prefix}-web"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.common_tags
}

# ── Logs ─────────────────────────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "web_ecs" {
  name              = "/ecs/${local.name_prefix}-web"
  retention_in_days = 14
  tags              = local.common_tags
}

# ── Task execution role: pull from ECR + write logs (log group is pre-created above) ─
data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web_ecs_exec" {
  name               = "${local.name_prefix}-web-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "web_ecs_exec" {
  role       = aws_iam_role.web_ecs_exec.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ── Security groups: ALB open to the internet on :80; tasks reachable only from the ALB ─
resource "aws_security_group" "web_alb" {
  name        = "${local.name_prefix}-web-alb"
  description = "Internet-facing ALB for the chat UI (HTTP)"
  vpc_id      = var.web_ecs_vpc_id

  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}

resource "aws_security_group" "web_ecs_task" {
  name        = "${local.name_prefix}-web-ecs-task"
  description = "Fargate UI tasks: ingress only from the ALB; egress to pull image + logs"
  vpc_id      = var.web_ecs_vpc_id

  ingress {
    description     = "Container port from the ALB"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.web_alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}

# ── Application Load Balancer (HTTP :80) ─────────────────────────────────────────
resource "aws_lb" "web" {
  name               = "${local.name_prefix}-web-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.web_alb.id]
  subnets            = var.web_ecs_public_subnet_ids
  tags               = local.common_tags
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.web_ecs_vpc_id
  target_type = "ip" # Fargate awsvpc tasks register by IP

  health_check {
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.common_tags
}

resource "aws_lb_listener" "web" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  tags = local.common_tags
}

# ── ECS cluster + task definition + service (Fargate) ────────────────────────────
resource "aws_ecs_cluster" "web" {
  name = "${local.name_prefix}-web"
  tags = local.common_tags
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_container_cpu
  memory                   = var.web_container_memory
  execution_role_arn       = aws_iam_role.web_ecs_exec.arn

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = "${aws_ecr_repository.web.repository_url}:latest"
      essential = true
      portMappings = [
        { containerPort = 80, protocol = "tcp" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web_ecs.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "web"
        }
      }
    }
  ])
  tags = local.common_tags
}

resource "aws_ecs_service" "web" {
  name            = "${local.name_prefix}-web"
  cluster         = aws_ecs_cluster.web.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_ecs_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.web_ecs_public_subnet_ids
    security_groups  = [aws_security_group.web_ecs_task.id]
    assign_public_ip = true # public subnet → reach ECR/CloudWatch without a NAT
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 80
  }

  # First apply runs before the image is pushed, so don't block waiting for steady state.
  wait_for_steady_state = false

  depends_on = [aws_lb_listener.web]
  tags       = local.common_tags
}

output "web_alb_url" {
  description = "Public HTTP URL of the chat UI served by ECS Fargate behind the ALB."
  value       = "http://${aws_lb.web.dns_name}"
}

output "web_ecr_repository_url" {
  description = "ECR repo to build/push the UI image to (docker build/push, then update-service)."
  value       = aws_ecr_repository.web.repository_url
}
