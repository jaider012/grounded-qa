# Variables for the grounded-qa App Runner stack. Defaults match the
# production configuration described in the deploy brief; override via
# terraform.tfvars (copy terraform.tfvars.example) rather than editing
# defaults here.

variable "aws_region" {
  description = <<-EOT
    AWS region to deploy into. DeepSeek V3.2 (the default bedrock_chat_model_id)
    is available In-Region only -- it has no cross-region inference profile --
    so this must be a region where that exact model ID is enabled for the
    account (verified enabled in us-east-1 as of 2026-10-01; see
    https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html).
  EOT
  type        = string
  default     = "us-east-1"
}

variable "service_name" {
  description = "Name shared by the ECR repository, the App Runner service, and the IAM roles. Must match App Runner's ServiceName pattern: 4-40 chars, alphanumeric/hyphen/underscore."
  type        = string
  default     = "grounded-qa"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-_]{3,39}$", var.service_name))
    error_message = "service_name must be 4-40 characters, start with a letter or digit, and contain only letters, digits, hyphens, or underscores (App Runner's ServiceName pattern)."
  }
}

variable "image_tag" {
  description = "Image tag in the ECR repository that App Runner deploys. Push this tag (see DEPLOY.md) before the `terraform apply` that creates or updates the App Runner service -- App Runner reads the tag at create/update time, it does not follow a moving tag on its own (automatic_deployments is off)."
  type        = string
  default     = "latest"
}

variable "container_port" {
  description = "Port the container listens on. Matches the Dockerfile's EXPOSE and the app's own default when PORT is unset (src/config.ts parsePort defaults to 3000). This becomes App Runner's image_configuration.port field, NOT a PORT environment variable -- App Runner reserves and rejects that env var name."
  type        = number
  default     = 3000
}

variable "apprunner_cpu" {
  description = <<-EOT
    App Runner instance vCPU. Must be one of App Runner's documented
    Cpu/Memory pairs (11 total, verified at
    https://aws.amazon.com/apprunner/pricing/ and
    https://aws.amazon.com/about-aws/whats-new/2023/04/aws-app-runner-compute-configurations/):
      0.25 vCPU -> 0.5 GB or 1 GB      1 vCPU -> 2, 3, or 4 GB
      0.5  vCPU -> 1 GB                2 vCPU -> 4 or 6 GB
                                        4 vCPU -> 8, 10, or 12 GB
  EOT
  type        = string
  default     = "0.25 vCPU"
}

variable "apprunner_memory" {
  description = "App Runner instance memory. Must pair validly with apprunner_cpu (see its description). \"1 GB\" is the smallest valid memory size paired with any vCPU size."
  type        = string
  default     = "1 GB"
}

variable "bedrock_chat_model_id" {
  description = "Bedrock foundation model ID used for chat/generation -- becomes the BEDROCK_CHAT_MODEL_ID runtime environment variable and the first Resource ARN in the instance role's inline Bedrock policy."
  type        = string
  default     = "deepseek.v3.2"
}

variable "bedrock_chat_fallback_model_id" {
  description = <<-EOT
    Secondary chat model the task brief names as DeepSeek V3.2's fallback.
    The brief only defines a single BEDROCK_CHAT_MODEL_ID env var, so this
    model is NOT also injected as its own container env var -- it exists
    purely so the instance role's IAM policy authorizes bedrock:InvokeModel
    on it too, in case application code falls back to it at runtime. If the
    app never calls this model, this grant is simply unused (still
    least-privilege: one named model, not a wildcard).
  EOT
  type        = string
  default     = "amazon.nova-lite-v1:0"
}

variable "bedrock_embedding_model_id" {
  description = "Bedrock foundation model ID used for embeddings -- becomes the BEDROCK_EMBEDDING_MODEL_ID runtime environment variable and a Resource ARN in the instance role's inline Bedrock policy."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "tags" {
  description = "Tags applied to every resource that supports tagging."
  type        = map(string)
  default     = {}
}
