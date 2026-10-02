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
`grounded-qa` ECR repository, App Runner in this account, the `grounded-qa` Cognito user
pool, the `grounded-qa-monthly` budget and its kill switch action, SSM parameters under
`/grounded-qa/*`, reading the service's logs, and managing roles named `grounded-qa-*` --
but only roles that carry a specific permissions boundary the deploy user cannot itself
create or widen, so it can never escalate itself to admin through a role it creates. See
"Admin one-time steps" below for why, and for the boundary policy this all depends on.

Create it once from CloudShell (signed in as an administrator), after pasting the policy
file into CloudShell as `deploy-policy.json`:

```bash
aws iam create-user --user-name grounded-qa-deploy
# A customer managed policy, not an inline one: inline user policies are capped at 2,048 characters.
aws iam create-policy --policy-name grounded-qa-deploy --policy-document file://deploy-policy.json
aws iam attach-user-policy --user-name grounded-qa-deploy \
  --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-deploy
aws iam create-access-key --user-name grounded-qa-deploy \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text
```

Then, on your laptop, store the two values in the profile (typed into the prompts, never
pasted anywhere else; if a secret key ends up in a chat, a ticket or a log, delete that
key with `aws iam delete-access-key` and create a new one):

```bash
aws configure --profile grounded-qa   # access key, secret key, region us-east-1, output json
```

## Admin one-time steps (CloudShell)

Brief 3 found that the original `iam-deploy-user-policy.json` let the deploy user escalate
to admin (create a role, attach any policy to it, then pass that role to a service it
controls -- `AdministratorAccess` included). It's fixed with a **permissions boundary**: a
second policy, created once by an administrator and never by Terraform, that caps the
*maximum* permissions any `grounded-qa-*` role can ever have, no matter what the deploy
user later attaches to it. The deploy user's own policy is also rewritten to only be able to
create/modify `grounded-qa-*` roles that already carry this exact boundary (see
`iam-deploy-user-policy.json`'s `CreateGroundedQaRolesWithBoundary` / `AttachAllowlistedPolicyToBoundedRoles`
statements) -- it can no longer attach an arbitrary policy or escalate itself.

The deploy user's key was also pasted into chat during that investigation and must be
treated as leaked. Do all of this from CloudShell, signed in as an administrator (setting
this project up from scratch rather than fixing a leak in place? skip step 1 and the
`aws iam create-user`/`create-access-key` calls from "0." above, and just do steps 2-4 in
order, since step 4's checks assume the role-boundary policy from step 2 already exists):

```bash
# 1. Deactivate the leaked key, create a replacement. List first to get its ID:
aws iam list-access-keys --user-name grounded-qa-deploy
aws iam update-access-key --user-name grounded-qa-deploy --status Inactive \
  --access-key-id <the-leaked-key-id>
aws iam create-access-key --user-name grounded-qa-deploy \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text
# Type the two new values into the prompts below -- never paste them anywhere else
# (chat, a ticket, a file committed to the repo):
aws configure --profile grounded-qa
# Once the new profile works end to end, delete the deactivated key for good:
aws iam delete-access-key --user-name grounded-qa-deploy --access-key-id <the-leaked-key-id>

# 2. Create the permissions boundary (paste infra/iam-role-boundary.json into
# CloudShell as role-boundary.json first):
aws iam create-policy --policy-name grounded-qa-role-boundary \
  --policy-document file://role-boundary.json

# 3. Replace the deploy user's policy with the hardened version (paste
# infra/iam-deploy-user-policy.json into CloudShell as deploy-policy.json first).
# Customer managed policies keep at most 5 versions -- if this one already has 5,
# delete the oldest NON-DEFAULT version before creating a new one:
aws iam list-policy-versions --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-deploy
# (only if the command above already lists 5 versions, delete the oldest non-default one)
aws iam delete-policy-version --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-deploy \
  --version-id <oldest-non-default-version-id>
aws iam create-policy-version --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-deploy \
  --policy-document file://deploy-policy.json --set-as-default

# 4. Verify the fix actually closes the escalation path AND still lets App Runner
# work, before trying a real `terraform apply`:
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::717279723515:user/grounded-qa-deploy \
  --action-names iam:PassRole \
  --resource-arns arn:aws:iam::717279723515:role/grounded-qa-apprunner-instance
# EvalDecision must be "allowed" -- this is the exact call that was AccessDenied before.

aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::717279723515:user/grounded-qa-deploy \
  --action-names iam:AttachRolePolicy \
  --resource-arns arn:aws:iam::717279723515:role/grounded-qa-apprunner-instance \
  --context-entries \
    ContextKeyName=iam:PolicyARN,ContextKeyType=string,ContextKeyValues=arn:aws:iam::aws:policy/AdministratorAccess \
    ContextKeyName=iam:PermissionsBoundary,ContextKeyType=string,ContextKeyValues=arn:aws:iam::717279723515:policy/grounded-qa-role-boundary
# EvalDecision must be "implicitDeny" or "explicitDeny" -- confirms the deploy
# user can no longer attach AdministratorAccess (or anything else off the
# allow-listed policy ARNs) to a grounded-qa role, even on a role that already
# carries the boundary (the one condition that IS satisfied here).
```

(`simulate-principal-policy` is read-only against IAM's policy evaluation logic -- it does
not require or consume any of the deploy user's own permissions, and does not change
anything. Reference: <https://docs.aws.amazon.com/cli/latest/reference/iam/simulate-principal-policy.html>.)

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

This apply needs `alert_email` -- it has no default on purpose (variables.tf), so every
apply that touches the budget resources names a real notification address deliberately.
`app_url` is deliberately left at its default (`""`) here: the App Runner service doesn't
exist yet, so there is no real URL for the Cognito app client's second OAuth callback (see
variables.tf for why the client can't just reference the service's own output -- that would
be a dependency cycle).

```bash
terraform apply -var "alert_email=<your-email>"
```

This creates the IAM roles (each capped by the permissions boundary from "Admin one-time
steps" above), the Cognito user pool and app client, the SSM parameter holding the client
secret, the monthly budget and its kill switch action, the auto scaling configuration
(pinned to exactly 1 instance), and the App Runner service itself, pointed at the `:latest`
image you just pushed.

### 4b. Second apply: add the real OAuth callback URL

Now that the service exists, point the Cognito app client's callback/logout URLs at its real
URL too. The fixed `http://localhost:3000/...` ones from the first apply keep working for
local development either way:

```bash
terraform apply -var "alert_email=<your-email>" \
  -var "app_url=$(terraform output -raw service_url)"
```

## Create users

`AUTH_MODE=cognito` means there is no public sign-up page -- every account is created by an
administrator:

```bash
aws cognito-idp admin-create-user --profile "$AWS_PROFILE" \
  --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --user-attributes Name=email,Value=<user-email> Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Cognito emails the new user a temporary password; the 12-character/upper/lower/number/symbol
policy applies when they set a real one on first sign-in. To let that user upload and delete
documents (everyone else gets read-only access to `/api/ask`), add them to the `admins`
group:

```bash
aws cognito-idp admin-add-user-to-group --profile "$AWS_PROFILE" \
  --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --username <user-email> \
  --group-name admins
```

## 5. Smoke test

`/healthz` stays anonymous (App Runner's own health checker can't sign in), but `/api/ask`
now requires a signed-in session -- sign in through the Cognito hosted login first
(`https://$(terraform output -raw cognito_domain)/login?...`, see "Create users" above for
getting an account), then re-run these against the resulting session cookie. A plain,
unauthenticated `curl -X POST .../api/ask` is expected to come back `401` now, not a FAQ
answer:

```bash
SERVICE_URL="$(terraform output -raw service_url)"

curl -sf "$SERVICE_URL/healthz"

curl -s -X POST "$SERVICE_URL/api/ask" \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVICE_URL" \
  -d '{"question":"Are you open on Mondays?"}'

curl -s -X POST "$SERVICE_URL/api/ask" \
  -H "Content-Type: application/json" \
  -H "Origin: $SERVICE_URL" \
  -d '{"question":"Do you have parking?"}'
```

`POST /api/ask` is a mutating request, so once signed in it also needs a matching `Origin`
header: a missing or cross-site `Origin` is rejected with `403` exactly the same way.

Signed in, the first question should come back grounded in the built-in FAQ; the second
should come back as a refusal (the FAQ has no parking information), not a fabricated answer.

**Known limitation:** this service is pinned to exactly one instance because its vector
store lives in memory, but App Runner's own documented scaling behavior still applies:
*"App Runner temporarily doubles the number of provisioned instances during deployments,
to maintain the same capacity for both old and new code."* So a `terraform apply` that
changes the service briefly runs old and new code side by side on two instances with two
independent in-memory stores -- any document uploaded through the API is not guaranteed to
survive a deploy, and requests may transiently land on either instance during the rollout.
This is inherent to App Runner, not something this Terraform config can turn off.
(Source: <https://docs.aws.amazon.com/apprunner/latest/api/API_AutoScalingConfiguration.html>)

## 6. Cost alert and kill switch (Terraform-managed, created in step 4)

No separate manual step needed anymore -- `aws_budgets_budget.monthly` and
`aws_budgets_budget_action.kill_switch` (budget.tf) are part of the same `terraform apply`
as everything else, created with the `alert_email` you passed in step 4:

- At 80% of $10 actual spend in a calendar month (i.e. $8), `alert_email` gets a warning.
- At 100%, AWS Budgets automatically attaches `grounded-qa-bedrock-kill-switch` (a Deny on
  `bedrock:InvokeModel`/`InvokeModelWithResponseStream`) to the App Runner instance role --
  the app stays up (App Runner, ECR, etc. keep running) but every Bedrock call starts
  failing -- and `alert_email` gets notified that it fired.

**This is a backstop, not a real-time guard**: AWS Budgets refreshes actual spend a few
times a day, not per-request, so the in-app daily ask cap (see the main README) is what
actually limits damage within a day; the kill switch only catches a leak that the daily cap
didn't.

**Recovery is manual by design**: once you understand what caused the overage, detach the
policy yourself --

```bash
aws iam detach-role-policy --profile "$AWS_PROFILE" \
  --role-name grounded-qa-apprunner-instance \
  --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-bedrock-kill-switch
```

Nothing re-attaches it automatically until the budget action fires again next month.

**Optional extra not implemented here:** AWS WAF in front of the App Runner service (rate
limiting and managed rule groups at the edge, on top of the app's own per-user/IP limits).
Left out because of its cost relative to this project's scale: $5/month per Web ACL + $1/month
per rule + $0.60 per million requests (<https://aws.amazon.com/waf/pricing/>), i.e. a
double-digit-dollar monthly floor against a stack that otherwise costs about $5-6/month (see
cost estimate below).

## 7. Teardown

```bash
terraform destroy -var "alert_email=<your-email>"
```

Since Brief 3, this also removes everything Terraform now manages: the Cognito user pool
(and every user in it -- **there is no recovery once a user pool is deleted**), its domain
and app client, the SSM parameter holding the client secret, the monthly budget, and the
kill switch action and its dedicated role. `-var "alert_email=..."` has to match what you
applied with (any value works for a destroy, Terraform just needs the variable to be set at
all) unless you saved it in `terraform.tfvars`.

The permissions boundary (`grounded-qa-role-boundary`) is **not** removed by this -- it was
created once by an administrator outside Terraform (see "Admin one-time steps") specifically
so the deploy user could never delete or widen it, and it stays attached to nothing once the
roles are gone. Delete it by hand only if you are done with the project for good:

```bash
aws iam delete-policy --profile "$AWS_PROFILE" \
  --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-role-boundary
```

`force_delete = true` on the ECR repository means `terraform destroy` removes it even with
images still pushed, so the `terraform destroy` above is the only command needed to tear
down the deployed stack itself.

To also remove the deploy user once you are done with the project (from CloudShell, as an
administrator):

```bash
for key in $(aws iam list-access-keys --user-name grounded-qa-deploy --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name grounded-qa-deploy --access-key-id "$key"
done
aws iam detach-user-policy --user-name grounded-qa-deploy \
  --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-deploy
aws iam delete-policy --policy-arn arn:aws:iam::717279723515:policy/grounded-qa-deploy
aws iam delete-user --user-name grounded-qa-deploy
```

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

**Cognito (Essentials tier)** -- the default tier for new user pools, and the one this stack
uses; free for the first 10,000 monthly active users per account, then $0.015/MAU above
that (source: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html>,
<https://aws.amazon.com/cognito/pricing/>). This project's handful of admin-created accounts
stays inside the free tier: **$0/month**.

**SSM Parameter Store** -- the Cognito client secret is a `Standard` tier parameter (the
default, no `tier` set), which is free with no additional charge for standard-throughput API
calls (source: <https://aws.amazon.com/systems-manager/pricing/>): **$0/month**.

**AWS Budgets action** -- the first two action-enabled budgets per account are free
regardless of how many actions are configured on them; a third and beyond cost $0.10/day
each (~$3/month) (source: <https://aws.amazon.com/aws-cost-management/aws-budgets/pricing>).
If `grounded-qa-monthly` is this account's first or second action-enabled budget: **$0/month**;
otherwise budget for the ~$3/month per-budget charge.

**Total, mostly-idle with light testing: roughly $5.25-5.40/month**, unchanged by Brief 3's
Cognito/SSM/budget-action additions at this usage level (all three are $0 in the common
case above) -- the App Runner memory floor (~$5.11) remains the dominant, traffic-independent
cost. ECR and Bedrock add low single-digit cents on top.
