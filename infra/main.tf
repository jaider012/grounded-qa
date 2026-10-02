# grounded-qa deploy infrastructure: an AWS App Runner service running the
# app's single container image (API + static frontend), pinned to EXACTLY
# ONE instance. The app keeps its vector store in memory, so a 2nd instance
# would hold a different, incomplete copy of whatever documents were
# uploaded through the API -- it must never scale beyond 1.
#
# ---------------------------------------------------------------------------
# IMPORTANT -- App Runner platform status (verified 2026-10-01):
#
# AWS stopped accepting NEW App Runner customers on 2026-04-30:
# "AWS App Runner will no longer be open to new customers starting
# April 30, 2026 ... Existing customers can continue to use the service as
# normal [including creating new resources and services]."
#   https://docs.aws.amazon.com/apprunner/latest/relnotes/welcome.html
#   https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
#
# This stack only works if the target AWS account already used App Runner
# before that date. If it has not, `terraform apply` will fail when it tries
# to create aws_apprunner_service -- see the "ECS Express Mode fallback"
# section of DEPLOY.md for AWS's own recommended alternative, which this
# directory does not implement.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# ECR -- holds the image App Runner deploys.
# force_delete = true so `terraform destroy` is one command even if an image
# is still pushed (verified argument at
# https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_repository).
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "app" {
  name                 = var.service_name
  force_delete         = true
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# IAM -- App Runner's ECR access role (lets the App Runner *build* service
# pull the image from this private repository). Trust principal and managed
# policy verified verbatim at:
#   https://docs.aws.amazon.com/apprunner/latest/dg/security_iam_service-with-iam.html
#     "add a trust policy that declares the App Runner service principal
#     build.apprunner.amazonaws.com as a trusted entity"
#   https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSAppRunnerServicePolicyForECRAccess.html
#     ARN: arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "apprunner_ecr_access_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_ecr_access" {
  name               = "${var.service_name}-apprunner-ecr-access"
  assume_role_policy = data.aws_iam_policy_document.apprunner_ecr_access_trust.json

  # Permissions boundary (Brief 3 security hardening): caps this role's
  # effective permissions at the intersection of its attached policy and the
  # boundary, regardless of what the deploy user's IAM policy would otherwise
  # let it attach later. Verified semantics ("effective permissions are the
  # intersection... An explicit deny in either policy overrides the allow"):
  # https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
  # The boundary (iam-role-boundary.json) allows this role's ECR pull actions
  # with room to spare, so this does not reduce what AWSAppRunnerServicePolicyForECRAccess
  # already grants it.
  permissions_boundary = var.role_boundary_arn

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_access" {
  role       = aws_iam_role.apprunner_ecr_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# ---------------------------------------------------------------------------
# IAM -- App Runner's instance role (what the RUNNING CONTAINER can call via
# the AWS SDK default credential chain -- no AWS access keys anywhere).
# Trust principal verified at the same page as above:
#   "add a trust policy that declares the App Runner service principal
#   tasks.apprunner.amazonaws.com as a trusted entity"
#
# The inline policy below is the role's ONLY permission: bedrock:InvokeModel
# on exactly the 3 named foundation models (configured chat model, its
# documented fallback, and the embedding model) in this region -- no
# wildcards, no other actions, no other services.
#
# bedrock:InvokeModel also covers Converse/ConverseStream, confirmed
# verbatim on the Converse API reference ("This operation requires
# permission for the bedrock:InvokeModel action."):
#   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
# There is no separate bedrock:Converse action to grant.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "apprunner_instance_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_instance" {
  name               = "${var.service_name}-apprunner-instance"
  assume_role_policy = data.aws_iam_policy_document.apprunner_instance_trust.json

  # Permissions boundary -- see the identical comment on apprunner_ecr_access
  # above. This role is also the budget kill switch's target (budget.tf):
  # the boundary is what still lets the kill switch's Deny policy actually
  # take effect even though Terraform's own Allow policies below remain
  # attached -- an explicit Deny anywhere (identity policy or boundary)
  # always overrides an Allow.
  permissions_boundary = var.role_boundary_arn

  tags = var.tags
}

data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    sid     = "InvokeGroundedQaFoundationModels"
    actions = ["bedrock:InvokeModel"]

    resources = [
      "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_chat_model_id}",
      "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_chat_fallback_model_id}",
      "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_embedding_model_id}",
    ]
  }
}

resource "aws_iam_role_policy" "apprunner_instance_bedrock" {
  name   = "${var.service_name}-bedrock-invoke"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.bedrock_invoke.json
}

# ---------------------------------------------------------------------------
# IAM -- lets the running container read the Cognito client secret
# (cognito.tf) that App Runner injects as the COGNITO_CLIENT_SECRET runtime
# secret below. ssm:GetParameters (plural) is the exact action AWS's own App
# Runner docs grant to the instance role for this, and that same page's SSM
# policy template does NOT include kms:Decrypt -- only its separate Secrets
# Manager template does. aws_ssm_parameter.cognito_client_secret (cognito.tf)
# sets no key_id, so it's encrypted with the AWS managed key (alias/aws/ssm),
# which is the case that needs no extra kms:Decrypt grant:
#   https://docs.aws.amazon.com/apprunner/latest/dg/env-variable.html
#   ("Permissions" section, SSM Parameter Store policy template)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "apprunner_instance_ssm" {
  statement {
    sid       = "ReadGroundedQaSsmParameters"
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.cognito_client_secret.arn]
  }
}

resource "aws_iam_role_policy" "apprunner_instance_ssm" {
  name   = "${var.service_name}-ssm-secrets"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_instance_ssm.json
}

# ---------------------------------------------------------------------------
# Auto scaling -- pinned to exactly 1 instance (min_size = max_size = 1),
# because the in-memory vector store cannot be shared across instances.
#
# Caveat no Terraform setting can remove -- App Runner's own documented
# behavior for MinSize:
#   "App Runner temporarily doubles the number of provisioned instances
#   during deployments, to maintain the same capacity for both old and new
#   code."
#   https://docs.aws.amazon.com/apprunner/latest/api/API_AutoScalingConfiguration.html
# During a deploy (an `apply` that changes the service), old and new code
# briefly run side by side on two instances with two independent in-memory
# stores; requests may transiently land on either one, and documents
# uploaded through the API are not guaranteed to survive a deploy. This is
# inherent to App Runner's rolling deploy, not a misconfiguration -- see the
# note in DEPLOY.md.
# ---------------------------------------------------------------------------

resource "aws_apprunner_auto_scaling_configuration_version" "single_instance" {
  auto_scaling_configuration_name = "${var.service_name}-single-instance"
  min_size                        = 1
  max_size                        = 1
  max_concurrency                 = 100

  tags = var.tags
}

# ---------------------------------------------------------------------------
# The service itself.
# ---------------------------------------------------------------------------

resource "aws_apprunner_service" "app" {
  service_name = var.service_name

  source_configuration {
    # false = deployments happen only when you run `terraform apply` again
    # (after pushing a new image tag), never automatically on a new image
    # push to the same tag. Verified argument location: auto_deployments_enabled
    # lives inside source_configuration, not at the top level of the service.
    auto_deployments_enabled = false

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        # App Runner's own `port` field. This is NOT a PORT environment
        # variable -- App Runner's console/API explicitly reserves that
        # exact name and refuses it in runtime_environment_variables:
        #   "You cannot assign PORT as a name for an environment variable
        #   when creating or updating your App Runner service. It's a
        #   reserved environment variable for App Runner service."
        #   https://docs.aws.amazon.com/apprunner/latest/dg/env-variable-manage.html
        # The app defaults to port 3000 when PORT is unset (src/config.ts
        # parsePort), matching the Dockerfile's `EXPOSE 3000`, so nothing
        # needs to inject PORT into the container -- this field just has to
        # agree with that same default.
        port = tostring(var.container_port)

        runtime_environment_variables = {
          PROVIDER = "bedrock"

          # App Runner does NOT auto-inject AWS_REGION (or any AWS_*
          # variable) into the container the way AWS Lambda does -- there is
          # no such behavior documented for App Runner, so it has to be set
          # explicitly here for the AWS SDK's default credential chain to
          # resolve a region when the app calls Bedrock through the
          # instance role above.
          AWS_REGION = var.aws_region

          BEDROCK_CHAT_MODEL_ID      = var.bedrock_chat_model_id
          BEDROCK_EMBEDDING_MODEL_ID = var.bedrock_embedding_model_id

          # Brief 3 security hardening -- Cognito-backed auth (cognito.tf).
          # AUTH_MODE=cognito makes the app fail closed on missing/invalid
          # session cookies instead of allowing anonymous access.
          AUTH_MODE            = "cognito"
          COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
          COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.app.id
          COGNITO_DOMAIN       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"

          # App Runner terminates TLS and proxies plain HTTP to the
          # container over exactly one hop, so Express's "trust proxy" must
          # trust exactly 1 hop to read X-Forwarded-* (client IP, proto)
          # correctly without trusting a spoofable header from the client
          # itself.
          TRUST_PROXY_HOPS = "1"
        }

        # Secrets (as opposed to the plain-text runtime_environment_variables
        # above): App Runner resolves these from SSM Parameter Store at
        # deployment time using the instance role's ssm:GetParameters grant
        # above, and never shows the value in the console or logs. Argument
        # verified at:
        #   https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apprunner_service
        #   ("runtime_environment_secrets" under the image_configuration block)
        runtime_environment_secrets = {
          COGNITO_CLIENT_SECRET = aws_ssm_parameter.cognito_client_secret.arn
        }
      }
    }
  }

  instance_configuration {
    cpu               = var.apprunner_cpu
    memory            = var.apprunner_memory
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  health_check_configuration {
    protocol = "HTTP" # default is TCP; the brief asks for an HTTP check on /healthz
    path     = "/healthz"

    # Remaining fields left at App Runner's documented defaults, stated
    # explicitly for clarity (source: same AutoScalingConfiguration-adjacent
    # health check reference as above, and the apprunner_service argument
    # docs):
    interval            = 5
    timeout             = 2
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.single_instance.arn

  tags = var.tags

  depends_on = [aws_iam_role_policy_attachment.apprunner_ecr_access]
}
