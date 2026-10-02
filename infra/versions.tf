# Terraform and provider version constraints.
#
# Scope reminder for whoever edits this stack: only `terraform fmt`,
# `terraform init -backend=false`, and `terraform validate` are safe to run
# without talking to AWS (init only downloads the provider plugin; validate
# is fully local/offline). Never run `terraform plan`/`apply`/`destroy` from
# an agent -- those are the account owner's calls, documented in DEPLOY.md.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0, < 7.0.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
