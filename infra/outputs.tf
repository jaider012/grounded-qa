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
