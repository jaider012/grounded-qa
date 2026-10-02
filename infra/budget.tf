# ---------------------------------------------------------------------------
# Budget kill switch (Brief 3 security hardening): a real-time guard is not
# possible this way -- AWS Budgets refreshes actual spend a few times a day,
# not per-request (note this limitation again in DEPLOY.md) -- so this is a
# backstop against a runaway bill, not a substitute for the app's own
# in-process daily ask cap (src/, T14). When the monthly budget hits 100%
# actual spend, AWS Budgets automatically attaches a Deny-all-Bedrock-invoke
# policy to the App Runner instance role; an administrator detaches it by
# hand (iam:DetachRolePolicy on that role) once the cause is understood.
#
# Every argument verified against the provider docs for aws_budgets_budget
# and aws_budgets_budget_action, and the trust/permissions shape against
# https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-action-role.html
# and its linked "Allow AWS Budgets to apply IAM policies and SCPs" example
# policy (billing-example-policies.html#example-budgets-IAM-SCP) and
# confused-deputy trust condition
# (billing-example-policies.html#example-budgets-applySCP).
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.service_name}-monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  tags = var.tags
}

# The policy the kill switch attaches. Deny on InvokeModel *and*
# InvokeModelWithResponseStream (the Converse/ConverseStream API also
# requires the bedrock:InvokeModel permission per main.tf's comment on
# apprunner_instance_bedrock, but InvokeModelWithResponseStream is a
# separate, distinct IAM action and is denied explicitly here too, so a
# streaming call can't slip through). Resource "*" is deliberate for a kill
# switch -- it must stop every model this role could ever be granted, not
# just the three named in bedrock_invoke today.
data "aws_iam_policy_document" "bedrock_kill_switch" {
  statement {
    sid    = "DenyBedrockInvokeOnBudgetBreach"
    effect = "Deny"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "bedrock_kill_switch" {
  name        = "${var.service_name}-bedrock-kill-switch"
  description = "Attached to the App Runner instance role automatically once the monthly budget hits 100% actual spend (aws_budgets_budget_action.kill_switch). Detach manually to restore service."
  policy      = data.aws_iam_policy_document.bedrock_kill_switch.json

  tags = var.tags
}

# Trust policy: budgets.amazonaws.com assumes this role to run the action.
# The aws:SourceAccount/aws:SourceArn conditions are AWS's own documented
# confused-deputy guard for this exact trust relationship (see the
# "example-budgets-applySCP" trust policy cited above) -- they stop any
# OTHER AWS account's budget from ever assuming this role.
data "aws_iam_policy_document" "budget_action_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${data.aws_caller_identity.current.account_id}:budget/*"]
    }
  }
}

resource "aws_iam_role" "budget_action" {
  name               = "${var.service_name}-budget-action"
  assume_role_policy = data.aws_iam_policy_document.budget_action_trust.json

  # Same shared boundary as every other grounded-qa role (main.tf). The
  # boundary's own BudgetKillSwitchAttachDetach statement independently caps
  # this to the instance role + the kill-switch policy ARN, so this role's
  # identity policy below is belt-and-suspenders, not the only thing
  # stopping it from attaching an arbitrary policy to an arbitrary role.
  permissions_boundary = var.role_boundary_arn

  tags = var.tags
}

# Scoped far narrower than AWS's own generic example (which grants
# Attach/DetachRolePolicy on every role/group/user, resource "*"): this role
# may only attach or detach the one kill-switch policy, and only on the one
# instance role it targets.
data "aws_iam_policy_document" "budget_action_permissions" {
  statement {
    sid    = "AttachDetachKillSwitchOnInstanceRoleOnly"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [aws_iam_role.apprunner_instance.arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [aws_iam_policy.bedrock_kill_switch.arn]
    }
  }
}

resource "aws_iam_role_policy" "budget_action" {
  name   = "${var.service_name}-attach-kill-switch"
  role   = aws_iam_role.budget_action.id
  policy = data.aws_iam_policy_document.budget_action_permissions.json
}

resource "aws_budgets_budget_action" "kill_switch" {
  budget_name        = aws_budgets_budget.monthly.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_action.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.bedrock_kill_switch.arn
      roles      = [aws_iam_role.apprunner_instance.name]
    }
  }

  # AWS Budgets requires at least one subscriber for the action itself
  # (separate from the budget's own notification above); reusing
  # var.alert_email means one address gets both the 80% warning and the
  # "the kill switch just fired" notice.
  subscriber {
    address           = var.alert_email
    subscription_type = "EMAIL"
  }

  tags = var.tags
}
