# ──────────────────────────────────────────────────────────────────────────────
# Bedrock Flow — the single, top-level orchestration surface (best-practice topology).
#
#   FlowInput ─► Supervisor (Agent node) ─► Dispatch (Lambda) ─► Analytics (Lambda)
#             ─► Report (Lambda) ─► FlowOutput
#
# The flow is the deterministic backbone; the ONE reasoning step (classification, routing,
# dispatch, multi-agent orchestration across the 4 collaborators) is the Supervisor Agent node.
# Everything downstream is deterministic. Callers invoke a single InvokeFlow with { question }
# and receive the FinalReport, with unified tracing/versioning for the whole pipeline.
#
# NOTE: requires AWS provider >= 5.83.0 for aws_bedrockagent_flow. The Agent node output is the
# agent's completion text; the Dispatch Lambda parses it into DispatchResult[]. If your provider
# version names the agent-node output differently, adjust the "agentResponse" output below.
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_bedrockagent_flow" "this" {
  name               = "${var.name_prefix}-supervisor-report"
  description        = "Supervisor agent → dispatch → analytics → report pipeline."
  execution_role_arn = var.flow_role_arn
  tags               = var.tags

  definition {
    # Entry: the input document { question }.
    node {
      name = "FlowInput"
      type = "Input"
      output {
        name = "document"
        type = "Object"
      }
    }

    # Reasoning step: the supervisor agent classifies, routes, dispatches and orchestrates
    # across the four collaborator agents (multi-agent collaboration happens inside it).
    node {
      name = "Supervisor"
      type = "Agent"
      configuration {
        agent {
          agent_alias_arn = var.supervisor_alias_arn
        }
      }
      input {
        name       = "agentInputText"
        type       = "String"
        expression = "$.data.question"
      }
      output {
        name = "agentResponse"
        type = "String"
      }
    }

    # Bridge: parse the agent's structured output into DispatchResult[] (with fallback routing).
    node {
      name = "Dispatch"
      type = "LambdaFunction"
      configuration {
        lambda_function {
          lambda_arn = var.dispatch_lambda_arn
        }
      }
      # Two inputs: the original question and the agent's response text.
      input {
        name       = "question"
        type       = "String"
        expression = "$.data.question"
      }
      input {
        name       = "agentResponse"
        type       = "String"
        expression = "$.data"
      }
      output {
        name = "functionResponse"
        type = "Object"
      }
    }

    # Stage 1 — analytics over dispatchResults.
    node {
      name = "Analytics"
      type = "LambdaFunction"
      configuration {
        lambda_function {
          lambda_arn = var.analytics_lambda_arn
        }
      }
      input {
        name       = "codeHookInput"
        type       = "Object"
        expression = "$.data"
      }
      output {
        name = "functionResponse"
        type = "Object"
      }
    }

    # Stage 2 — final report generation.
    node {
      name = "Report"
      type = "LambdaFunction"
      configuration {
        lambda_function {
          lambda_arn = var.report_lambda_arn
        }
      }
      input {
        name       = "codeHookInput"
        type       = "Object"
        expression = "$.data"
      }
      output {
        name = "functionResponse"
        type = "Object"
      }
    }

    # Exit: the FinalReport document.
    node {
      name = "FlowOutput"
      type = "Output"
      input {
        name       = "document"
        type       = "Object"
        expression = "$.data"
      }
    }

    # ── Data connections ──────────────────────────────────────────────────────
    connection {
      name   = "InputToSupervisor"
      source = "FlowInput"
      target = "Supervisor"
      type   = "Data"
      configuration {
        data {
          source_output = "document"
          target_input  = "agentInputText"
        }
      }
    }

    connection {
      name   = "InputToDispatch"
      source = "FlowInput"
      target = "Dispatch"
      type   = "Data"
      configuration {
        data {
          source_output = "document"
          target_input  = "question"
        }
      }
    }

    connection {
      name   = "SupervisorToDispatch"
      source = "Supervisor"
      target = "Dispatch"
      type   = "Data"
      configuration {
        data {
          source_output = "agentResponse"
          target_input  = "agentResponse"
        }
      }
    }

    connection {
      name   = "DispatchToAnalytics"
      source = "Dispatch"
      target = "Analytics"
      type   = "Data"
      configuration {
        data {
          source_output = "functionResponse"
          target_input  = "codeHookInput"
        }
      }
    }

    connection {
      name   = "AnalyticsToReport"
      source = "Analytics"
      target = "Report"
      type   = "Data"
      configuration {
        data {
          source_output = "functionResponse"
          target_input  = "codeHookInput"
        }
      }
    }

    connection {
      name   = "ReportToOutput"
      source = "Report"
      target = "FlowOutput"
      type   = "Data"
      configuration {
        data {
          source_output = "functionResponse"
          target_input  = "document"
        }
      }
    }
  }
}

data "aws_region" "current" {}

# A Bedrock flow is created in status "NotPrepared". It must be PREPARED (the DRAFT compiled)
# before a flow version can be cut — neither the aws nor awscc resource does this automatically.
# This calls PrepareFlow and polls until the flow reaches "Prepared".
# Requires the AWS CLI on the apply host (inherits AWS_PROFILE/AWS_REGION from the apply env).
resource "terraform_data" "prepare_flow" {
  # Re-prepare whenever the flow wiring changes.
  triggers_replace = [
    aws_bedrockagent_flow.this.id,
    var.supervisor_alias_arn,
    var.dispatch_lambda_arn,
    var.analytics_lambda_arn,
    var.report_lambda_arn,
  ]

  provisioner "local-exec" {
    interpreter = ["powershell", "-NoProfile", "-Command"]
    command     = <<-EOT
      $ErrorActionPreference='Stop'
      aws bedrock-agent prepare-flow --flow-identifier ${aws_bedrockagent_flow.this.id} --region ${data.aws_region.current.region} | Out-Null
      for ($i=0; $i -lt 40; $i++) {
        $s = (aws bedrock-agent get-flow --flow-identifier ${aws_bedrockagent_flow.this.id} --region ${data.aws_region.current.region} --query status --output text)
        if ($s -eq 'Prepared') { Write-Output 'flow prepared'; exit 0 }
        if ($s -eq 'Failed')   { Write-Error 'flow preparation failed'; exit 1 }
        Start-Sleep -Seconds 3
      }
      Write-Error "flow did not reach Prepared (last status: $s)"; exit 1
    EOT
  }
}

# Immutable version snapshot of the current (prepared) flow definition.
# (Flow version/alias are only available via the AWS Cloud Control provider today.)
# NOTE: CloudFormation FlowVersion is immutable — editing the flow definition requires a new
# version. The prepare step above re-runs on wiring changes; bump `description` or taint to force one.
resource "awscc_bedrock_flow_version" "this" {
  flow_arn    = aws_bedrockagent_flow.this.arn
  description = "Versioned snapshot managed by Terraform."

  depends_on = [terraform_data.prepare_flow]

  lifecycle {
    create_before_destroy = true
  }
}

# Stable alias the api-entrypoint invokes.
resource "awscc_bedrock_flow_alias" "this" {
  name     = "live"
  flow_arn = aws_bedrockagent_flow.this.arn

  routing_configuration = [{
    flow_version = awscc_bedrock_flow_version.this.version
  }]

  tags = var.tags
}

# Allow Bedrock Flow to invoke the three pipeline Lambdas.
resource "aws_lambda_permission" "flow_invoke" {
  for_each = {
    dispatch  = var.dispatch_lambda_arn
    analytics = var.analytics_lambda_arn
    report    = var.report_lambda_arn
  }

  statement_id  = "AllowBedrockFlowInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "bedrock.amazonaws.com"
  source_arn    = aws_bedrockagent_flow.this.arn
}
