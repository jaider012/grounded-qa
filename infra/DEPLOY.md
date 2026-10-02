# Deploying grounded-qa to AWS App Runner

Run everything below from the repo root (`cd "/Volumes/TUF Gaming /grounded-qa"`), with
the project's AWS CLI profile selected first:

```bash
export AWS_PROFILE=grounded-qa
export AWS_REGION=us-east-1
aws sts get-caller-identity --query Account --output text   # must print 717279723515
```

## 0. One-time: the deploy user and the `grounded-qa` profile

The profile holds static keys of a dedicated IAM user, `grounded-qa-deploy`, in account
717279723515. Its policy, `infra/iam-deploy-user-policy.json`, allows only what this
project needs: invoking the three Bedrock models, read-only model discovery, the
`grounded-qa` ECR repository, App Runner in this account, managing roles named
`grounded-qa-*` (and passing them to App Runner), reading the service's logs and the
`grounded-qa-monthly` budget.

Create it once from CloudShell (signed in as an administrator), after pasting the policy
file into CloudShell as `deploy-policy.json`:

```bash
aws iam create-user --user-name grounded-qa-deploy
aws iam put-user-policy --user-name grounded-qa-deploy \
  --policy-name grounded-qa-deploy --policy-document file://deploy-policy.json
aws iam create-access-key --user-name grounded-qa-deploy \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text
```

Then, on your laptop, store the two values in the profile (typed into the prompts, never
pasted anywhere else):

```bash
aws configure --profile grounded-qa   # access key, secret key, region us-east-1, output json
```

## Before you start: App Runner's new-customer cutoff

AWS stopped accepting **new** App Runner customers on **2026-04-30**. Existing customers
(accounts that already had an App Runner service before that date) can keep using it
normally, including creating new services. If this account never used App Runner before
that date, `terraform apply` will fail when it tries to create the service -- see
[Fallback: ECS Express Mode](#fallback-if-app-runner-rejects-this-account) below.
(Source: <https://docs.aws.amazon.com/apprunner/latest/relnotes/welcome.html>)

Whether a *specific* account is grandfathered in can't be checked read-only -- `aws
apprunner list-services` succeeds (and tells you how many services exist today) whether
or not the account is still allowed to *create* a new one; creating one is the only real
test. If step 4 below fails with a new-customer rejection, go straight to the fallback
section.

## 1. Initialize Terraform

```bash
cd infra
terraform init
cp terraform.tfvars.example terraform.tfvars   # edit if you want different names/region
```

## 2. Create only the ECR repository

The App Runner service definition references an image tag that has to exist before it can
be created, so create just the repository first:

```bash
terraform apply -target=aws_ecr_repository.app
```

## 3. Build and push the image

App Runner only runs **linux/amd64 (x86_64)** container images -- there is no documented
ARM64/Graviton support (AWS's own public roadmap still lists Graviton/ARM support as an
open, unimplemented request, and an ARM64 image gets run incorrectly rather than rejected
cleanly: <https://github.com/aws/apprunner-roadmap/issues/98>). Since you build on Apple
Silicon, always cross-compile -- never push a native arm64 build:

```bash
REGISTRY="$(terraform output -raw ecr_repository_url | cut -d/ -f1)"
aws ecr get-login-password --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  | docker login --username AWS --password-stdin "$REGISTRY"

cd ..
docker buildx build --platform linux/amd64 \
  -t "$(terraform -chdir=infra output -raw ecr_repository_url):latest" \
  --push .
cd infra
```

## 4. Create the rest of the stack

```bash
terraform apply
```

This creates the IAM roles, the auto scaling configuration (pinned to exactly 1 instance),
and the App Runner service itself, pointed at the `:latest` image you just pushed.

## 5. Smoke test

```bash
SERVICE_URL="$(terraform output -raw service_url)"

curl -sf "$SERVICE_URL/healthz"

curl -s -X POST "$SERVICE_URL/api/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"Are you open on Mondays?"}'

curl -s -X POST "$SERVICE_URL/api/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"Do you have parking?"}'
```

The first question should come back grounded in the built-in FAQ; the second should come
back as a refusal (the FAQ has no parking information), not a fabricated answer.

**Known limitation:** this service is pinned to exactly one instance because its vector
store lives in memory, but App Runner's own documented scaling behavior still applies:
*"App Runner temporarily doubles the number of provisioned instances during deployments,
to maintain the same capacity for both old and new code."* So a `terraform apply` that
changes the service briefly runs old and new code side by side on two instances with two
independent in-memory stores -- any document uploaded through the API is not guaranteed to
survive a deploy, and requests may transiently land on either instance during the rollout.
This is inherent to App Runner, not something this Terraform config can turn off.
(Source: <https://docs.aws.amazon.com/apprunner/latest/api/API_AutoScalingConfiguration.html>)

## 6. Cost alert (optional, do this before you forget)

One `aws budgets create-budget` call, with the notification/subscriber in a second file
(verified CLI shape: <https://docs.aws.amazon.com/cli/latest/reference/budgets/create-budget.html>):

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --profile "$AWS_PROFILE")"

cat > /tmp/grounded-qa-budget.json <<'EOF'
{
  "BudgetName": "grounded-qa-monthly",
  "BudgetType": "COST",
  "TimeUnit": "MONTHLY",
  "BudgetLimit": { "Amount": "10", "Unit": "USD" }
}
EOF

cat > /tmp/grounded-qa-budget-notifications.json <<'EOF'
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      { "SubscriptionType": "EMAIL", "Address": "<your-email>" }
    ]
  }
]
EOF

aws budgets create-budget --profile "$AWS_PROFILE" \
  --account-id "$ACCOUNT_ID" \
  --budget file:///tmp/grounded-qa-budget.json \
  --notifications-with-subscribers file:///tmp/grounded-qa-budget-notifications.json
```

This alerts by email once actual spend passes 80% of $10 (i.e. $8) in a calendar month.

## 7. Teardown

```bash
terraform destroy

# If you created the budget above:
aws budgets delete-budget --profile "$AWS_PROFILE" \
  --account-id "$ACCOUNT_ID" --budget-name "grounded-qa-monthly"
```

`force_delete = true` on the ECR repository means `terraform destroy` removes it even with
images still pushed, so this is the only command needed to tear down the AWS side.

## Fallback if App Runner rejects this account

If `terraform apply` fails to create `aws_apprunner_service` because this account never
used App Runner before 2026-04-30, AWS's recommended replacement is **Amazon ECS Express
Mode** -- a newer ECS mode with the same "give it an image and two IAM roles" simplicity,
backed by Fargate + an Application Load Balancer instead of App Runner's own runtime:

<https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html>

This directory does not implement an ECS Express Mode version of this stack -- it would
need its own Terraform (`aws_ecs_*` resources plus an ALB) rather than a drop-in
replacement for `main.tf`.

## Estimated monthly cost (us-east-1)

Assumptions: the default `apprunner_cpu = "0.25 vCPU"` / `apprunner_memory = "1 GB"`,
exactly 1 instance provisioned 24/7 (`min_size = max_size = 1`), light/mostly-idle traffic
(occasional smoke tests, not production load). 730 hours/month (365 x 24 / 12).

**App Runner compute** -- $0.064 per active vCPU-hour, $0.007 per GB-hour (memory is
billed whether the instance is actively processing a request or just provisioned and
idle); source: <https://aws.amazon.com/apprunner/pricing/>

- Memory, billed 24/7 regardless of traffic: `1 GB x $0.007/GB-hr x 730 hr = $5.11/month`
- vCPU, billed only while actively handling a request -- negligible when mostly idle, e.g.
  2 active-compute hours across a whole month of light testing:
  `0.25 vCPU x $0.064/vCPU-hr x 2 hr = $0.03/month`
- **App Runner subtotal: ~$5.11-5.15/month** (the $5.11 memory floor is the real fixed
  cost of keeping exactly 1 instance always provisioned; it does not go away at zero
  traffic)

**ECR storage** -- $0.10/GB-month for private repositories, with 500 MB/month free for
new accounts' first year; source: <https://aws.amazon.com/ecr/pricing/>

- This image (`node:22-slim` runtime stage, production deps + compiled JS + static
  assets only) is roughly 200-350 MB: `~0.3 GB x $0.10/GB-month = ~$0.03/month`, likely
  $0 while still inside the free-tier allowance.

**Bedrock usage** -- scales with how many questions actually get asked, not with uptime.
Illustrative per-question cost, assuming ~2,000 input + ~300 output tokens for the chat
call and ~50 input tokens for the question's embedding:

- DeepSeek V3.2 (chat): $0.62 / 1M input tokens, $1.85 / 1M output tokens --
  `(2000/1e6)x$0.62 + (300/1e6)x$1.85 = $0.0018/question` (source:
  <https://aws.amazon.com/bedrock/pricing/>, cross-checked against
  <https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html>)
- Titan Text Embeddings V2: ~$0.02 / 1M tokens -- `(50/1e6)x$0.02 ~= $0.000001/question`
  (negligible). **Not independently confirmed on AWS's own pricing page** -- it's a large,
  dynamically-rendered page and this row did not come through on either fetch attempt;
  this figure is corroborated by several third-party Bedrock cost calculators instead.
- So roughly **0.2 cents per question asked** -- for ~100 test questions in a month, about
  $0.18.

**Total, mostly-idle with light testing: roughly $5.25-5.40/month**, with the App Runner
memory floor (~$5.11) as the dominant, traffic-independent cost. ECR and Bedrock add low
single-digit cents at this usage level.
