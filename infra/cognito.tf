# ---------------------------------------------------------------------------
# Cognito -- admin-only user pool backing the app's session login (Brief 3:
# "Cognito en la app"). No public sign-up: every user is created by an
# administrator via `aws cognito-idp admin-create-user` (see DEPLOY.md,
# "Create users"), because this is an internal tool, not a public product.
#
# Every argument below is verified against the hashicorp/aws provider's own
# docs (registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/
# cognito_user_pool, cognito_user_pool_domain, cognito_user_pool_client,
# cognito_user_group, cognito_managed_login_branding) and, where cited
# inline, against docs.aws.amazon.com/cognito.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name = var.service_name

  # Admin-only sign-up: there is no public registration endpoint, matching
  # this app's "internal tool" threat model.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # Email as username (mutually exclusive with alias_attributes -- the
  # provider docs confirm "Conflicts with alias_attributes").
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  # MFA is opt-in per user, not forced on everyone (OPTIONAL, not ON) --
  # OPTIONAL and ON both require at least one second-factor method
  # configured, so software_token_mfa_configuration is mandatory here too.
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  # INACTIVE (the default) so `terraform destroy` can tear the pool down
  # without a separate manual deletion-protection-off step first.
  deletion_protection = "INACTIVE"

  # Essentials unlocks managed login + choice-based sign-in without Plus's
  # paid adaptive-authentication features this project doesn't need.
  # Essentials is also the AWS API's own default when user_pool_tier is
  # omitted, stated explicitly here for clarity. Free tier: 10,000 MAU/month
  # per account (verified at
  # https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html
  # and https://aws.amazon.com/cognito/pricing/).
  user_pool_tier = "ESSENTIALS"

  tags = var.tags
}

# Domain prefix must be globally unique across every AWS account that uses
# Amazon's shared *.auth.<region>.amazoncognito.com domain, hence the random
# suffix -- "grounded-qa" alone would very likely already be taken.
resource "random_string" "cognito_domain_suffix" {
  length  = 8
  special = false
  upper   = false
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${var.service_name}-${random_string.cognito_domain_suffix.result}"
  user_pool_id = aws_cognito_user_pool.main.id

  # managed_login_version = 2 selects the newer "managed login" experience
  # (with the branding designer) over the classic hosted UI (version 1).
  # Verified valid values at the provider docs for aws_cognito_user_pool_domain.
  managed_login_version = 2
}

# Default Cognito branding for managed login -- use_cognito_provided_values
# applies AWS's own default style instead of a hand-built one, since this
# project has no custom branding assets. Confirmed this resource exists and
# supports this argument in the provider docs for
# aws_cognito_managed_login_branding ("Default Branding Style" example).
resource "aws_cognito_managed_login_branding" "app" {
  client_id    = aws_cognito_user_pool_client.app.id
  user_pool_id = aws_cognito_user_pool.main.id

  use_cognito_provided_values = true

  depends_on = [aws_cognito_user_pool_domain.main]
}

resource "aws_cognito_user_pool_client" "app" {
  name         = "${var.service_name}-app"
  user_pool_id = aws_cognito_user_pool.main.id

  # Confidential client: the app's backend (not a browser SPA) holds the
  # secret and exchanges the authorization code server-side.
  generate_secret = true

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"] # authorization code only -- no implicit grant
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]

  # ENABLED: Cognito returns the same generic error whether or not an
  # account exists, so sign-in/forgot-password responses can't be used to
  # enumerate registered email addresses.
  prevent_user_existence_errors = "ENABLED"

  id_token_validity     = 4
  access_token_validity = 4
  token_validity_units {
    id_token     = "hours"
    access_token = "hours"
  }

  # Fixed localhost callback/logout for local development, plus the real
  # deployed URL once it exists (var.app_url; see its description in
  # variables.tf for why this can't just reference the App Runner service
  # directly -- that would be a dependency cycle).
  callback_urls = var.app_url != "" ? [
    "http://localhost:3000/auth/callback",
    "${var.app_url}/auth/callback",
    ] : [
    "http://localhost:3000/auth/callback",
  ]

  logout_urls = var.app_url != "" ? [
    "http://localhost:3000/",
    "${var.app_url}/",
    ] : [
    "http://localhost:3000/",
  ]
}

resource "aws_cognito_user_group" "admins" {
  name         = "admins"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Members can upload and delete documents; everyone else gets read-only access to /api/ask."
}

# ---------------------------------------------------------------------------
# SSM -- the app client's secret, read by the App Runner instance role (see
# the apprunner_instance_ssm policy in main.tf) via runtime_environment_secrets.
# No key_id set, so this uses the AWS managed key alias/aws/ssm -- see the
# comment on apprunner_instance_ssm in main.tf for why that specifically
# means no kms:Decrypt grant is needed.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "cognito_client_secret" {
  name        = "/${var.service_name}/cognito-client-secret"
  description = "Cognito app client secret for ${var.service_name}, injected into App Runner as COGNITO_CLIENT_SECRET."
  type        = "SecureString"
  value       = aws_cognito_user_pool_client.app.client_secret

  tags = var.tags
}
