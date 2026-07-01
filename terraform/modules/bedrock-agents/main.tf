# ──────────────────────────────────────────────────────────────────────────────
# Collaborator agents (one per report TYPE): EDD, XShipReport, XShipDownload, Relationship.
# Each owns a single action group ("/run") backed by its type Lambda.
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_bedrockagent_agent" "collaborator" {
  for_each = var.collaborators

  agent_name                  = "${var.name_prefix}-${each.key}"
  agent_resource_role_arn     = var.agent_role_arn
  foundation_model            = var.foundation_model
  instruction                 = each.value.instruction
  idle_session_ttl_in_seconds = var.idle_session_ttl_seconds
  agent_collaboration         = "DISABLED"
  prepare_agent               = true
  tags                        = var.tags
}

resource "aws_bedrockagent_agent_action_group" "collaborator" {
  for_each = var.collaborators

  action_group_name          = "${each.key}-run"
  agent_id                   = aws_bedrockagent_agent.collaborator[each.key].agent_id
  agent_version              = "DRAFT"
  skip_resource_in_use_check = true

  action_group_executor {
    lambda = each.value.lambda_arn
  }

  api_schema {
    payload = each.value.api_schema
  }
}

# Allow Bedrock to invoke each collaborator's action-group Lambda.
resource "aws_lambda_permission" "action_group" {
  for_each = var.collaborators

  statement_id  = "AllowBedrockInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value.lambda_arn
  principal     = "bedrock.amazonaws.com"
  source_arn    = aws_bedrockagent_agent.collaborator[each.key].agent_arn
}

# Stable alias per collaborator so the supervisor can reference it.
resource "aws_bedrockagent_agent_alias" "collaborator" {
  for_each = var.collaborators

  agent_alias_name = "live"
  agent_id         = aws_bedrockagent_agent.collaborator[each.key].agent_id
  description      = "Live alias for ${each.value.display_name} collaborator."

  # The version "live" points to is set when the agent is (re)prepared (prepare_agent=true).
  # Don't let Terraform revert the version or re-version on every apply (the alias UpdateAgentAlias
  # path is brittle for collaborator-bearing agents). Model swaps re-version via the documented step.
  lifecycle {
    ignore_changes = [routing_configuration, description]
  }

  # Ensure the action group is attached + agent prepared before aliasing.
  depends_on = [aws_bedrockagent_agent_action_group.collaborator]
  tags       = var.tags
}

# ──────────────────────────────────────────────────────────────────────────────
# Supervisor agent: classifies + routes + orchestrates across the collaborators.
# ──────────────────────────────────────────────────────────────────────────────
resource "aws_bedrockagent_agent" "supervisor" {
  agent_name                  = "${var.name_prefix}-supervisor"
  agent_resource_role_arn     = var.agent_role_arn
  foundation_model            = var.foundation_model
  instruction                 = var.supervisor_instruction
  idle_session_ttl_in_seconds = var.idle_session_ttl_seconds
  agent_collaboration         = "SUPERVISOR"
  # MUST be false: a SUPERVISOR agent cannot be prepared until it has collaborators, but the
  # collaborator links are created AFTER this resource. Preparing on create therefore fails with
  # "AgentCollaboration is set to SUPERVISOR but no agent collaborators are added". The links below
  # each carry prepare_agent=true, so the supervisor is prepared once they exist; model-swap
  # re-preparation is handled by terraform_data.supervisor_reversion (CLI prepare + re-version).
  prepare_agent = false
  tags          = var.tags
}

resource "aws_bedrockagent_agent_collaborator" "link" {
  for_each = var.collaborators

  agent_id                   = aws_bedrockagent_agent.supervisor.agent_id
  agent_version              = "DRAFT"
  collaborator_name          = each.value.display_name
  collaboration_instruction  = each.value.collaboration_instruction
  relay_conversation_history = "TO_COLLABORATOR"
  # Re-prepare the supervisor once all collaborators are linked.
  prepare_agent = true

  agent_descriptor {
    alias_arn = aws_bedrockagent_agent_alias.collaborator[each.key].agent_alias_arn
  }
}

resource "aws_bedrockagent_agent_alias" "supervisor" {
  agent_alias_name = "live"
  agent_id         = aws_bedrockagent_agent.supervisor.agent_id
  description      = "Live alias for the supervisor agent."

  # The flow invokes this alias; its version is set when the supervisor is (re)prepared.
  # Ignore version/description churn so Terraform doesn't loop on the alias-update provider bug.
  lifecycle {
    ignore_changes = [routing_configuration, description]
  }

  depends_on = [aws_bedrockagent_agent_collaborator.link]
  tags       = var.tags
}

# ──────────────────────────────────────────────────────────────────────────────
# Automatic alias re-versioning on a foundation_model change.
#
# An agent "live" alias serves a versioned snapshot of the *prepared* DRAFT — not the DRAFT
# config. When the model changes, prepare_agent=true recompiles each DRAFT, but the alias still
# points at the old version. These steps re-prepare (confirming a fresh prepare) and cut a new
# version so "live" serves the new model — making a model swap fully `terraform apply`-driven.
# Requires the AWS CLI on the apply host (inherits AWS_PROFILE/AWS_REGION from the apply env).
# ──────────────────────────────────────────────────────────────────────────────
data "aws_region" "current" {}

locals {
  # Re-prepare an agent (waiting for a genuinely fresh prepare to avoid a stale snapshot),
  # then update its "live" alias so Bedrock cuts a new version from the prepared DRAFT.
  reversion_script = <<-EOT
    $ErrorActionPreference='Stop'
    $id=$env:AGENT_ID; $al=$env:ALIAS_ID; $region=$env:AGENT_REGION
    $before=(aws bedrock-agent get-agent --agent-id $id --region $region --query "agent.preparedAt" --output text)
    aws bedrock-agent prepare-agent --agent-id $id --region $region | Out-Null
    Start-Sleep -Seconds 6
    $ok=$false
    for($i=0;$i -lt 40;$i++){
      $s=(aws bedrock-agent get-agent --agent-id $id --region $region --query "agent.agentStatus" --output text)
      $p=(aws bedrock-agent get-agent --agent-id $id --region $region --query "agent.preparedAt" --output text)
      if($s -eq 'FAILED'){ Write-Error "prepare failed for $id"; exit 1 }
      if($s -eq 'PREPARED' -and $p -ne $before){ $ok=$true; break }
      Start-Sleep -Seconds 3
    }
    if(-not $ok){ Write-Error "prepare did not complete for $id"; exit 1 }
    aws bedrock-agent update-agent-alias --agent-id $id --agent-alias-id $al --agent-alias-name live --region $region | Out-Null
    Write-Output "re-versioned agent $id -> alias $al"
  EOT
}

resource "terraform_data" "collaborator_reversion" {
  for_each = var.collaborators

  # Re-run when the model changes, the alias is recreated, OR the agent's instruction/action-group
  # schema content changes — otherwise the re-prepared DRAFT never reaches the "live" alias version.
  triggers_replace = [
    var.foundation_model,
    aws_bedrockagent_agent_alias.collaborator[each.key].agent_alias_id,
    sha1(each.value.instruction),
    sha1(each.value.api_schema),
  ]

  provisioner "local-exec" {
    interpreter = ["powershell", "-NoProfile", "-Command"]
    command     = local.reversion_script
    environment = {
      AGENT_ID     = aws_bedrockagent_agent.collaborator[each.key].agent_id
      ALIAS_ID     = aws_bedrockagent_agent_alias.collaborator[each.key].agent_alias_id
      AGENT_REGION = data.aws_region.current.region
    }
  }
}

resource "terraform_data" "supervisor_reversion" {
  triggers_replace = [
    var.foundation_model,
    aws_bedrockagent_agent_alias.supervisor.agent_alias_id,
    sha1(var.supervisor_instruction),
  ]

  provisioner "local-exec" {
    interpreter = ["powershell", "-NoProfile", "-Command"]
    command     = local.reversion_script
    environment = {
      AGENT_ID     = aws_bedrockagent_agent.supervisor.agent_id
      ALIAS_ID     = aws_bedrockagent_agent_alias.supervisor.agent_alias_id
      AGENT_REGION = data.aws_region.current.region
    }
  }

  # Re-version the supervisor after the collaborators so their versions are fresh first.
  depends_on = [terraform_data.collaborator_reversion]
}
