# Grounded Q&A

Ask a question and get an answer that comes **only** from the loaded documents: a built-in FAQ for Bonaire Bites plus any PDF you upload. Every answer cites the document, the page or section, and a verbatim quote that plain code has checked against the passage. If the documents do not cover the question, the app says so instead of guessing.

## Run locally with LM Studio (free, the default)

1. In LM Studio, load `google/gemma-4-e4b` (chat) and `text-embedding-nomic-embed-text-v1.5` (embeddings), then start the server on port 1234 (`lms server start`).
2. Install and configure (the active block of `.env.example` is `PROVIDER=openai-compatible` with the LM Studio values):
   ```bash
   cp .env.example .env
   npm ci
   ```
3. Run it:
   ```bash
   npm run dev
   ```
4. Open http://localhost:3000. The startup log lists the models LM Studio offers and ends with `listening on http://0.0.0.0:3000 (1 document(s) loaded)`.

Node.js 22 or newer is required.

## Run against Amazon Bedrock

Credentials come from the AWS default credential chain. On a laptop that is the `grounded-qa` CLI profile (static keys of the IAM user `grounded-qa-deploy`; see "AWS access" below); in AWS it is the service's IAM role. Nothing reads AWS keys from `.env`.

```bash
npm run dev:bedrock    # the app on http://localhost:3000 against Bedrock
npm run eval:bedrock   # the golden set against Bedrock
```

Both scripts set `PROVIDER=bedrock`, `AWS_PROFILE=grounded-qa`, `AWS_REGION=us-east-1`, `BEDROCK_CHAT_MODEL_ID=deepseek.v3.2` and `BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`; any of them can be overridden from the shell (for example `BEDROCK_CHAT_MODEL_ID=amazon.nova-lite-v1:0 npm run eval:bedrock`). To make Bedrock the default for `npm run dev`, put the same variables in `.env` instead. The startup log shows `Provider bedrock in us-east-1: chat deepseek.v3.2, embeddings amazon.titan-embed-text-v2:0`.

### Model access in the Bedrock console

There is nothing to request for these two models. Amazon Bedrock enables access to all serverless foundation models by default in commercial Regions, and DeepSeek and Amazon models are not sold through AWS Marketplace, so no subscription is involved. The first DeepSeek call accepts its end user license agreement.

- **Check in the console:** Amazon Bedrock → **Model catalog** → open **DeepSeek V3.2** and **Titan Text Embeddings V2** → **Open in playground**.
- **Check from the CLI** (AWS CLI 2.27.42 or later): `aws bedrock get-foundation-model-availability --model-id deepseek.v3.2 --region us-east-1` should report `"agreementAvailability": {"status": "AVAILABLE"}`; repeat with `amazon.titan-embed-text-v2:0`.
- **Region:** DeepSeek V3.2 runs In-Region only (no inference profile), in us-east-1, us-east-2, us-west-2 and a few other Regions. Use one of them for both models.

## How it works

```
INGEST (built-in FAQ at startup, each PDF on upload)
  FAQ ─────────────────► one chunk per section ──────────────┐
  PDF ─► unpdf, per page ─► clean ─► sentence chunks ─────────┤  ~900 chars, 1-sentence overlap,
                                                               │  never across a page
                                                               ▼
                                         embed (Embedder) ─► in-memory store
                                                             { id c1.., source, location, text, vector }

ASK
  question ─► embed ─► cosine top 5 ─► LLM, JSON only ─► verify in code ─► answer + citations
                                       { answerable,       │ passage was retrieved?
                                         answer,           │ quote verbatim in it (≥ 12 chars)?
                                         citations }       └─ nothing survives ─► fixed refusal
```

| Module | Job |
|---|---|
| `src/config.ts` | Reads and validates the provider variables; fails fast naming every missing one |
| `src/faq.ts` | The built-in FAQ, one section per chunk |
| `src/chunking.ts` | PDF text cleaning and sentence packing |
| `src/pdf.ts` | Per-page text extraction with `unpdf`; scanned, encrypted and unreadable PDFs become typed errors |
| `src/embeddings.ts` | `Embedder` interface; LM Studio (OpenAI-compatible) and Bedrock Titan v2 implementations |
| `src/store.ts` | In-memory vector store, brute-force cosine similarity |
| `src/llm.ts` | Chat call (LM Studio with `json_schema`, Bedrock Converse), defensive parsing, model listing |
| `src/answer.ts` | Retrieval, prompt and one retry on unreadable output |
| `src/grounding.ts` | Citation verification and the fixed refusal |
| `src/app.ts` | HTTP routes and validation (`createApp({ store, llm })`) |
| `src/server.ts` | Wiring and startup checks |
| `public/` | The single page (plain HTML, CSS and JavaScript) |

## API

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/ask` | `{ "question": "..." }` | `200 { answerable, answer, citations: [{ source, location, quote, passage }], retrieved: [{ source, location, score }] }` | `400` empty, over 500 characters or not JSON; `502` model or embedding failure |
| `GET /api/documents` | | `200 { documents: [{ name, chunks, builtIn }] }` | |
| `POST /api/documents` | multipart field `file` | `201 { document: { name, chunks } }` | `400` no file; `413` over 10 MB; `415` not a PDF (checked by magic bytes); `422` scanned, encrypted or unreadable; `502` embedding failure |
| `DELETE /api/documents/:name` | | `200 { removed, documents: [{ name, chunks, builtIn }] }` | `403` built-in FAQ; `404` unknown document name |
| `GET /healthz` | | `200 { status: "ok", documents, provider }` | |

Every error body is `{ "error": "<what happened and what to do next>" }`.

## Configuration

| Variable | `openai-compatible` (LM Studio) | `bedrock` (AWS) |
|---|---|---|
| `PROVIDER` | `openai-compatible` (the default when unset) | `bedrock` |
| `LLM_BASE_URL` | `http://localhost:1234/v1` | |
| `LLM_API_KEY` | `lm-studio` (any string) | |
| `LLM_MODEL` | `google/gemma-4-e4b` | |
| `EMBEDDING_BASE_URL` | `http://localhost:1234/v1` | |
| `EMBEDDING_API_KEY` | `lm-studio` (any string) | |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5` | |
| `AWS_REGION` | | `us-east-1` |
| `BEDROCK_CHAT_MODEL_ID` | | `deepseek.v3.2` (fallback `amazon.nova-lite-v1:0`) |
| `BEDROCK_EMBEDDING_MODEL_ID` | | `amazon.titan-embed-text-v2:0` |
| `PORT` (optional) | `3000` | set by the platform |

The server refuses to start when a variable required by the active provider is missing, and names every missing one. With `openai-compatible` it also refuses to start when `LLM_MODEL` is not in `GET {LLM_BASE_URL}/models`. Bedrock credentials come only from the AWS default credential chain (a local profile on a laptop, the service's IAM role in AWS); no AWS keys go in environment variables. `.env` is git-ignored.

## Decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Verify citations in plain code, not with another LLM call | Deterministic, free and testable: a citation survives only if it points at a retrieved passage and its quote appears there verbatim (whitespace, dashes and quote marks normalised, at least 12 characters) | Proves the quote is real, not that the answer sentence follows from it |
| Discard the model's text whenever it says it cannot answer | General knowledge cannot leak through a "helpful" refusal | The refusal is one fixed English sentence, whatever the question's language |
| PDF chunks never cross a page; FAQ chunks are whole sections | A page or section citation is always true | Very short pages produce small chunks |
| In-memory store with brute-force cosine | No database to run; plenty for hundreds of chunks | Lost on restart; linear search |
| `PROVIDER` switch behind the existing `Llm` and `Embedder` interfaces | Local development on LM Studio costs nothing; in AWS the app reaches Bedrock through the service's IAM role | Two implementations to keep in step, both unit-tested without network |
| `json_schema` structured output on LM Studio | LM Studio rejects `json_object` (HTTP 400, checked with a real call) and accepts `json_schema` | Only works with models that honour the schema |
| Bedrock Converse with the JSON rules in the system prompt | Converse has no universal JSON mode, and swapping the chat model is a one-variable change | Parsing stays defensive: `<think>` blocks and code fences are stripped before `JSON.parse` |
| Titan v2: one text per call, at most 5 in flight, up to 3 attempts on throttling | Titan embeds a single text per request; bounded concurrency keeps ingest fast without tripping quotas | A large PDF takes a few seconds to embed |
| One retry on unreadable output, then 502 | Models occasionally return empty or truncated JSON | Valid JSON with the wrong shape is treated as a refusal instead |
| Gemma 4 E4B as the local model | With `json_schema`, LM Studio returned Qwen 3.5's whole answer in `reasoning_content` and left `content` empty | A 4B model reasons less carefully than the production model |
| `textContent` only and a strict Content-Security-Policy | PDF text is untrusted and is rendered as text, never as markup | No inline scripts or styles anywhere |

## Tests

```bash
npm test            # unit + HTTP integration tests (node:test), no network, no API keys
npm run typecheck   # TypeScript strict
npm run test:ui     # browser tests of the page; needs Google Chrome installed (not run in CI)
npm run eval        # golden questions against whatever provider the environment points at
```

Current state: `npm test` runs 144 passing tests and `npm run test:ui` runs 12.

### Eval results

| Provider | Models | Result |
|---|---|---|
| LM Studio (local) | `google/gemma-4-e4b` + `text-embedding-nomic-embed-text-v1.5` | **13/13 passed**: answerable 6/6, unanswerable 3/3, partial 2/2, adversarial 2/2; 0.8 to 3.6 s per question |
| Amazon Bedrock (us-east-1) | `deepseek.v3.2` + `amazon.titan-embed-text-v2:0` | **11/13 passed**: answerable 6/6, unanswerable 3/3, partial 0/2, adversarial 2/2; 1.4 to 4.7 s per question |

Both partial failures are the model's choice, not the citation check: for "What are your hours, and do you accept credit cards?" and "Do you deliver to Rincon, and what is the minimum order?" DeepSeek V3.2 returns `{"answerable": false}` even though the right passage is retrieved first. It reads "the passages do not cover the question" as "do not cover all of it". Telling the prompt to refuse only when no part of the question is covered, plus a partial example, should fix it; the prompt is left unchanged here because this change set only touches providers and deployment.

The golden set is `eval/golden.json`: 13 questions tagged answerable, unanswerable, partial or adversarial (prompt injection). A case passes when the `answerable` flag is right and, for answerable cases, a citation points at the expected section. It checks the flag and the citation, not the wording of the answer.

## AWS access (the `grounded-qa` profile)

Local Bedrock runs, the eval and the deploy commands use one AWS CLI profile, `grounded-qa`, holding static keys of a dedicated IAM user, `grounded-qa-deploy`, in account 717279723515 (region us-east-1). Its policy is [`infra/iam-deploy-user-policy.json`](infra/iam-deploy-user-policy.json); the one-time commands to create the user and the profile are in [`infra/DEPLOY.md`](infra/DEPLOY.md#0-one-time-the-deploy-user-and-the-grounded-qa-profile). Check that the profile works:

```bash
aws sts get-caller-identity --profile grounded-qa --query Account --output text   # 717279723515
```

## Deploy to AWS App Runner

One container serves the API and the page. The vector store lives in process memory, so the service runs exactly one instance (auto scaling pinned to min 1 / max 1). The image is the existing multi-stage `Dockerfile` (`node:22-slim`, non-root user, compiled JavaScript), pushed to ECR. The service reaches Bedrock through its instance role: no AWS keys in its environment. Terraform lives in [`infra/`](infra/); the full runbook, with sources, is [`infra/DEPLOY.md`](infra/DEPLOY.md).

> App Runner stopped accepting new customers on 2026-04-30. If this account never had an App Runner service, step 4 fails; the fallback is ECS Express Mode (see DEPLOY.md).

```bash
export AWS_PROFILE=grounded-qa AWS_REGION=us-east-1
cd infra && terraform init                                   # 1. once
terraform apply -target=aws_ecr_repository.app               # 2. the ECR repository first
REPO="$(terraform output -raw ecr_repository_url)"           # 3. build for linux/amd64 and push
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker buildx build --platform linux/amd64 -t "${REPO}:latest" --push ..   # braces matter in zsh: $REPO:l is a modifier
terraform apply                                              # 4. roles, single-instance scaling, the service
terraform output -raw service_url                            # 5. the live URL
```

The service gets `PROVIDER=bedrock`, `AWS_REGION`, `BEDROCK_CHAT_MODEL_ID` and `BEDROCK_EMBEDDING_MODEL_ID` as plain environment variables, port 3000 and an HTTP health check on `/healthz`. Size: 0.25 vCPU / 1 GB.

### IAM policy for the service

The App Runner instance role gets exactly this (from [`infra/iam-bedrock-policy.json`](infra/iam-bedrock-policy.json); Converse is authorised by `bedrock:InvokeModel`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeGroundedQaFoundationModels",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/deepseek.v3.2",
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0"
      ]
    }
  ]
}
```

To switch the chat model to the Nova Lite fallback, add `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0` to `Resource` (the Terraform role already includes it). DeepSeek V3.2 has no inference profile, so no inference-profile ARN is needed.

### Estimated monthly cost (us-east-1)

| Item | Estimate |
|---|---|
| App Runner, 1 instance always provisioned (1 GB × $0.007/GB-hour × 730 h) | ~$5.11 |
| App Runner active vCPU (0.25 vCPU × $0.064/vCPU-hour, only while serving requests; light testing) | a few cents |
| ECR storage (~0.3 GB × $0.10/GB-month; free tier covers it the first year) | ~$0.03 |
| Bedrock (DeepSeek V3.2 $0.62 / $1.85 per 1M input / output tokens; Titan v2 negligible) | ~$0.002 per question |
| **Total for a mostly idle demo** | **~$5.25–5.40 per month** |

Local development on LM Studio costs nothing. Arithmetic and sources are in DEPLOY.md.

### Cost alert at 10 USD

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"grounded-qa-monthly","BudgetType":"COST","TimeUnit":"MONTHLY","BudgetLimit":{"Amount":"10","Unit":"USD"}}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<your-email>"}]}]'
```

This emails you once actual spend passes 80% of 10 USD in a calendar month.

### Teardown

```bash
cd infra && terraform destroy          # service, roles, scaling configuration and the ECR repository (force_delete)
aws budgets delete-budget --account-id "$ACCOUNT_ID" --budget-name grounded-qa-monthly
```

### Smoke test against the live URL

```bash
URL="$(terraform -chdir=infra output -raw service_url)"

curl -s "$URL/healthz"
# {"status":"ok","documents":1,"provider":"bedrock"}

curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/ask" -H 'Content-Type: application/json' \
  -d '{"question":"Are you open on Mondays?"}'
# 401: AUTH_MODE=cognito, so questions need a signed-in session
```

Signed in through the Cognito hosted login, "Are you open on Mondays?" comes back answerable with a citation at location "Hours", and "Do you have parking?" comes back as the fixed refusal. The signed-in commands (session cookie plus a matching `Origin` header) are in `infra/DEPLOY.md`, step 5.

## Known limits

- **The store is lost on restart.** Uploaded PDFs disappear on every deploy or restart. During a deploy App Runner briefly runs the old and the new instance side by side, each with its own in-memory store.
- **The check proves the quote, not the answer.** Example from local testing: asked "Can I book a table for 4 people?", Gemma answered "Yes" while citing the true sentence "Parties of 5 or fewer are seated on a walk-in basis."
- **No OCR.** Scanned PDFs are rejected with a message asking for OCR first.
- **Limits live in memory.** Rate limits and the daily ask cap reset when the process restarts, and App Runner briefly runs two instances during a deploy, each with its own counters.
- **The PDF parse timeout does not stop the parser.** A timed-out upload is rejected, but the parse keeps using CPU until it finishes.
- **Retrieval is embeddings only.** Questions in other languages retrieve less precisely with the local English embedding model.
- **The refusal is English only.**

## What I would do next

1. Persistence with Postgres + pgvector, so documents survive restarts and scale past brute force.
2. Hybrid search: BM25 plus vectors, with a reranker.
3. An entailment check that every answer sentence is supported by its cited quote.
