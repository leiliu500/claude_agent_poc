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
  # Prepared by the collaborator attachments below (re-prepared after links exist).
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

  depends_on = [aws_bedrockagent_agent_collaborator.link]
  tags       = var.tags
}
