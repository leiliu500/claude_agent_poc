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

    # Deterministic backbone: ONE Lambda node runs dispatch → analytics → report in-process and
    # returns the FinalReport. Collapsing the former three-node chain removes the fragile
    # inter-node object passing that left analytics/report inputs undefined.
    node {
      name = "Process"
      type = "LambdaFunction"
      configuration {
        lambda_function {
          lambda_arn = var.process_lambda_arn
        }
      }
      # Three inputs: the original question, the authenticated caller (identity + resolved IDs,
      # from the input document), and the supervisor agent's response text.
      input {
        name       = "question"
        type       = "String"
        expression = "$.data.question"
      }
      # Authenticated caller as a JSON string (identity + resolved IDs); flow-process JSON-parses it.
      input {
        name       = "auth"
        type       = "String"
        expression = "$.data.auth"
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
      name   = "InputToProcess"
      source = "FlowInput"
      target = "Process"
      type   = "Data"
      configuration {
        data {
          source_output = "document"
          target_input  = "question"
        }
      }
    }

    # Same input document also feeds the Process node's `auth` input (identity + resolved IDs).
    connection {
      name   = "InputToProcessAuth"
      source = "FlowInput"
      target = "Process"
      type   = "Data"
      configuration {
        data {
          source_output = "document"
          target_input  = "auth"
        }
      }
    }

    connection {
      name   = "SupervisorToProcess"
      source = "Supervisor"
      target = "Process"
      type   = "Data"
      configuration {
        data {
          source_output = "agentResponse"
          target_input  = "agentResponse"
        }
      }
    }

    connection {
      name   = "ProcessToOutput"
      source = "Process"
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

locals {
  # Changes whenever the flow wiring/topology changes, so a fresh immutable flow version is cut
  # and the "live" alias advances to it. Bump `flow_topology_rev` on any node/connection edit.
  flow_topology_rev    = "v3-process-auth-input"
  flow_definition_hash = sha1(join("|", [var.supervisor_alias_arn, var.process_lambda_arn, local.flow_topology_rev]))
}

# A Bedrock flow is created in status "NotPrepared". It must be PREPARED (the DRAFT compiled)
# before a flow version can be cut — neither the aws nor awscc resource does this automatically.
# This calls PrepareFlow and polls until the flow reaches "Prepared".
# Requires the AWS CLI on the apply host (inherits AWS_PROFILE/AWS_REGION from the apply env).
resource "terraform_data" "prepare_flow" {
  # Re-prepare whenever the flow wiring changes.
  triggers_replace = [
    aws_bedrockagent_flow.this.id,
    var.supervisor_alias_arn,
    var.process_lambda_arn,
    local.flow_definition_hash,
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
  flow_arn = aws_bedrockagent_flow.this.arn
  # Embed the definition hash so a wiring change forces a NEW immutable version (and the alias
  # below advances to it). Without this, edits to the flow definition never reach the live alias.
  description = "Versioned snapshot managed by Terraform (def ${local.flow_definition_hash})."

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

# Allow Bedrock Flow to invoke the combined Process Lambda.
resource "aws_lambda_permission" "flow_invoke" {
  for_each = {
    process = var.process_lambda_arn
  }

  statement_id  = "AllowBedrockFlowInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "bedrock.amazonaws.com"
  source_arn    = aws_bedrockagent_flow.this.arn
}
