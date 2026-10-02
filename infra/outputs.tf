output "service_url" {
  description = <<-EOT
    HTTPS URL of the running grounded-qa service. App Runner's own
    service_url attribute is documented only as "a subdomain URL" (no
    stated scheme) -- https:// is prepended here because App Runner always
    serves over HTTPS with an AWS-managed certificate.
    https://docs.aws.amazon.com/apprunner/latest/api/API_Service.html
  EOT
  value       = "https://${aws_apprunner_service.app.service_url}"
}

output "ecr_repository_url" {
  description = "Push images here (see DEPLOY.md), e.g. docker push <this value>:<tag>."
  value       = aws_ecr_repository.app.repository_url
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID. Needed for `aws cognito-idp admin-create-user` (see DEPLOY.md, \"Create users\")."
  value       = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  description = "Cognito app client ID -- same value injected into App Runner as COGNITO_CLIENT_ID."
  value       = aws_cognito_user_pool_client.app.id
}

output "cognito_domain" {
  description = "Full HTTPS Cognito managed-login domain -- same value injected into App Runner as COGNITO_DOMAIN."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}
