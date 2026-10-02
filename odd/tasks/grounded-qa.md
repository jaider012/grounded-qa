# ODD feature: grounded-qa

- **Repo:** `/Volumes/TUF Gaming /grounded-qa` (the volume name ends with a space; use the symlink `~/grounded-qa`, but run npm from the real path). Remote: https://github.com/jaider012/grounded-qa (private).
- **Branch:** built on `feat/grounded-qa` (base `main` @ `11bc0b1`, empty initial commit), fast-forwarded into `main` and pushed on 2026-10-01.
- **Spec:** `odd/specs/grounded-qa-brief.md` (the build brief pasted by the user on 2026-10-01).
- **This tracker:** `odd/tasks/grounded-qa.md` in the project repo (moved here from the drive-root repo at the user's request).
- **Design records:** `PRODUCT.md`, `DESIGN.md`, `.impeccable/` (direction contract, design system sidecar, review screenshots).
- **Decision log for the user:** `~/grounded-qa/decition.md` (untracked, listed in `.git/info/exclude`)
- **Engram mirror:** topic `odd/grounded-qa/tasks` (project `tuf gaming`)

## Objective

Web app where a user asks a question and gets an answer grounded only in the loaded documents (built-in Bonaire Bites FAQ plus PDFs uploaded at runtime), with verified verbatim citations, or a fixed refusal.

## Problem and why

Take-home style build brief with a ~1 hour budget. The user approved autonomous implementation ("riendas sueltas") while away and asked for every decision taken on their behalf to be logged in `decition.md`.

## Scope

Express API (`/api/ask`, `/api/documents` GET/POST, `/healthz`), one static page, in-memory vector store, citation verification, unit + integration tests, eval script, Dockerfile, CI workflow, README.
Out of scope: auth, persistence, streaming, deploying or pushing (the user runs those commands).

## Constraints

- Node 22 + TypeScript strict; `openai` SDK against OpenAI-compatible endpoints; provider-specific code only in `llm.ts` and `embeddings.ts`.
- Dev: LM Studio with `google/gemma-4-e4b` (chat) and `text-embedding-nomic-embed-text-v1.5` (embeddings). Prod: DeepSeek `deepseek-flash` (`json_object`, thinking disabled through `LLM_EXTRA_BODY`) and OpenAI `text-embedding-3-small`.
- Never cut: citation verification, fixed refusal, unit + integration tests, Dockerfile.
- The Claude Design mockup is not readable in this session, so the frontend follows the brief and stays isolated in `public/` for a later re-skin.

## TDD

- Mode: strict (source: `~/.claude/CLAUDE.md`, "Strict TDD Mode: enabled").
- Runner: `node:test` through `tsx --test` (`npm test`). Typecheck: `npm run typecheck`.

## Delivery

- Strategy: `exception-ok` (greenfield repo, no PR; the user merges and pushes). Forecast: about 2,000 authored lines.
- RDD: on (global). `gentle-ai review assess` runs after each work-unit commit; due medium/high reviews are deferred until the user is back, because review consent is human-only.

## Tasks

- [x] T1 Scaffold, validated provider config, provider probes. Route: inline (mechanical scaffold plus one small module). Commit `b6bbb6f`.
- [x] T2 Ingest and retrieval: `faq`, `chunking`, `pdf`, `embeddings`, `store` with unit tests. Route: delegated writer (4+ non-trivial files). Commit `692f669`.
- [x] T3 Answer and verification: `llm`, `answer`, `grounding` with unit tests. Route: delegated writer. Commit `6a7a56b`.
- [x] T4 HTTP API and wiring: `app`, `server`, PDF fixtures, integration tests. Route: delegated writer. Commit `d13c808`.
- [x] T5 Frontend: `public/index.html`, `app.js`, `styles.css`. Route: delegated writer (fresh). Commit `eac6c29`, lockfile fix `977d8a3`.
- [x] T6a Ship: Dockerfile, `.dockerignore`, CI workflow. Route: inline (mechanical, three small files). Commit `5479ff8`.
- [x] T6b README. Route: inline (single doc; parent holds the full picture), after T7 results. Commit `9fccdc1`.
- [x] T7 Eval: golden set, `npm run eval`, LM Studio run (DeepSeek run pending keys). Route: delegated writer. Commit `7967766`.

## Acceptance criteria

- `npm test` and `npm run typecheck` pass.
- The Docker image builds and `/healthz` answers inside the container.
- Eval results on LM Studio are reported; every decision is logged in `decition.md`.

## Verification evidence

- Provider probes (2026-10-01, real calls): LM Studio accepts `json_schema`; rejects `json_object` with HTTP 400 "'response_format.type' must be 'json_schema' or 'text'". `qwen/qwen3.5-9b` returns the JSON in `reasoning_content` with empty `content`; `google/gemma-4-e4b` returns it in `content` (0.7-3.4 s). nomic embeddings: 768 dims with `encoding_format: "float"`. DeepSeek and OpenAI not probed (no keys).

- T1: RED `npm test` -> ERR_MODULE_NOT_FOUND `src/config.js`; GREEN `npm test` 7/7 pass; `npm run typecheck` clean (TypeScript 7.0.2). Commit `b6bbb6f`. RDD assess (`--base-ref main --committed-only`): risk medium, review_due true (`slice_budget_reached`, dominated by `package-lock.json`). Review deferred: the candidate becomes the slice `main..HEAD` once the user is back. Rollback boundary: the whole commit (scaffold + config), nothing else depends on it yet.
- `.env.example` was written with a shell heredoc because the user's settings deny the Read/Edit tools on `.env.*` (template only, no secrets; logged in `decition.md`).

- T2: writer reported RED (ERR_MODULE_NOT_FOUND) then GREEN per module (chunking 19, faq 8, pdf 6, embeddings 4, store 8). Parent review added one missing behavior with TDD: `search` rejects a query vector of a different dimension (RED: 1 failing test; GREEN: store 9/9), and replaced an invisible soft-hyphen literal with `­`. Spot check: `npm test` 53/53, typecheck clean. Commit `692f669`. RDD assess: medium, due (`slice_budget_reached`), deferred with the slice. Fixtures: `test/fixtures/catering-guide.pdf` (2 pages), `scanned.pdf` (no text), generated by `scripts/make-fixtures.ts`. Rollback boundary: the commit; nothing outside `src/{chunking,faq,pdf,embeddings,store}.ts`, their tests and fixtures.

- T3: writer RED (ERR_MODULE_NOT_FOUND) then GREEN per module (llm 17, grounding 24, answer 8). Parent review converted confusable Unicode literals in `grounding.ts` to `\u` escapes (refactor, still green). Spot check: `npm test` 102/102, typecheck clean. Runtime harness (`<scratchpad>/smoke.mts`, real LM Studio gemma-4-e4b + nomic): Mondays → answerable "No" citing Hours; capital of France → fixed refusal; Playa Lechi vegan → correct with Dietary citation; Spanish question → Spanish answer citing Delivery; 1.2-3.6 s each. Known-limit example: "Can I book a table for 4 people?" → model said "Yes" while citing the true walk-in sentence (verification proves the quote, not the answer's reading of it). Commit `6a7a56b`. RDD assess: medium, due, deferred with the slice.

- T4: writer RED (missing export / ERR_MODULE_NOT_FOUND) then GREEN (llm 20, api 15). Spot check: `npm test` 120/120, typecheck clean. Runtime harness: real server on :3456 against LM Studio — startup lists models, embeds FAQ, listens on 0.0.0.0; `/healthz` 200 with CSP header; delivery question answered with a Delivery citation; "Do you have parking?" → fixed refusal; catering-guide.pdf upload 201 (2 chunks); deposit question cites `catering-guide.pdf / page 2` verbatim; non-PDF 415, scanned 422, blank question 400. Commit `d13c808`. RDD assess: medium, due, deferred with the slice.
- T5 design inputs: Impeccable skill applied proportionately; `PRODUCT.md` inferred from the brief (untracked); direction roll seed `f1073352` assigned the kitchen expo ticket rail; contract in `.impeccable/surfaces/public-index-html.md` (untracked). Code-led (no image generation).

- T5: writer RED (`npm run test:ui` 10/10 failing: missing elements, ENOENT public/app.js) then GREEN 10/10. Parent inspection round (desktop 1440, mobile 390, 86 state screenshots in `.impeccable/review/`): fixed one batch (nested dark box replaced by a true rail bar with the ticket hanging below; heading line-height 1.35; form controls inherit font). Detector: static scan flags tight-leading 1.25 (false positive); rendered scans of http://localhost:3456/ at 1280x800 and 390x844 report zero findings. `public/` has no innerHTML/outerHTML/insertAdjacentHTML/document.write. Commit `eac6c29`. RDD assess: medium, due, deferred.
- Lockfile defect found by the parent: `npm install` through the `~/grounded-qa` symlink wrote 146 keys as `../../../Volumes/TUF Gaming /grounded-qa/node_modules/...` (would break `npm ci` in Docker/CI). Restored the T1 lockfile and reinstalled from the real path: 0 bad keys, 146 normal keys, tests green. Commit `977d8a3`. Rule from now on: run npm from the real path.
- T6a: `docker build` on OrbStack OK (390 MB). Container without env exits with the missing-variables message; with LM Studio env (`host.docker.internal`) and `PORT=10000` it runs as uid 1000, `/healthz` 200, `/` and `/app.js` 200, private-events question answered with a verbatim citation. Commit `5479ff8`. RDD assess: high (`high_risk`), due, deferred (consent is human-only).
- Render facts verified from render.com docs (2026-10-01): bind 0.0.0.0, default PORT 10000, health check path under Advanced, Docker runtime from the Dockerfile, free instances spin down after 15 minutes idle and lose local changes.

- T7: writer RED (ERR_MODULE_NOT_FOUND scripts/eval-score.js) then GREEN 16/16. Real run on LM Studio (gemma-4-e4b + nomic): 13/13 passed (answerable 6/6, unanswerable 3/3, partial 2/2, adversarial 2/2), 0.8-3.6 s each. Commit `7967766`.
- User returned at ~18:15 and asked to finish within 30 minutes using parallel subagents (explicit approval of parallel agents on disjoint files). Impeccable finish reviewer and documenter launched in parallel (DESIGN.md untracked).
- Final checks (after `9fccdc1`): `npm test` 136/136, `npm run typecheck` exit 0, `npm run test:ui` 10/10, working tree clean.

- Finish review (impeccable-finish-reviewer): disposition `fix` with 4 material items (system sans as display voice, citation separator "·", hidden file input in tab order, unthemed details marker). Applied in one batch: self-hosted Barlow Condensed 700 (OFL) for the h1, `document · location`, `tabindex="-1"`, red disclosure marker. `npm test` 136/136, `test:ui` 10/10. Commit `34ccfd1`. Verdict pass and DESIGN.md refresh requested in parallel.
- DESIGN.md + `.impeccable/design.json` written by impeccable-documenter (untracked).

- Delivery: pushed to https://github.com/jaider012/grounded-qa (private) on the user's request; CI green on main. Only Spanish text found (UTF-8 test file name) replaced in `89a138d`.

## Follow-up requested by the user (2026-10-01, after delivery)

- [x] T8 Delete documents: `VectorStore.removeDocument`, `DELETE /api/documents/:name` (FAQ protected, 403), `builtIn` flag in GET. Route: delegated writer (backend files only). RED: `removeDocument is not a function` (4) and DELETE 404s (5); GREEN: store 13/13, api 19/19; `npm test` 144/144. Commit `88024b7`.
- [x] T9 Dark app redesign (user's choice via question: near-black, mint accent, left sidebar, answers newest first, refusal card replaces 86) + delete button UI. Route: delegated writer (public/ and test/ui/ only), parallel with T8 on disjoint files. `test:ui` 12/12. Parent polish: no focus ring on the script-focused card question, document name on its own line, full-width sidebar on phones (`align-self: stretch`), dark favicon. Live check against LM Studio at 390x844 and 1440x900: real answer with highlighted Reservations quote, no console errors, no horizontal overflow; rendered detector 0 findings at both sizes. Commit `7bbc55a`, pushed.
- [x] Process records moved into the repo at the user's request: `odd/tasks/grounded-qa.md`, `odd/specs/grounded-qa-brief.md`, `.impeccable/`, `PRODUCT.md`, `DESIGN.md` (regenerated for the dark world).

## Brief 2: AI providers and AWS deploy (approved 2026-10-01)

Plan approved by the user; container choice: App Runner (caveat: closed to new customers since 2026-04-30, verify with read-only checks once personal credentials exist; fallback ECS Express Mode). The NativApps QA AWS account must never be used for this project (user: "Nada de native apps").

- [x] T10 `PROVIDER` switch (openai-compatible | bedrock): config fail-fast per provider, Bedrock Converse llm, Titan v2 embedder (concurrency 5, throttling retry x3), clear AWS error messages, `provider` in healthz, remove DeepSeek direct / OpenAI / LLM_JSON_MODE / LLM_EXTRA_BODY. Route: delegated writer. RED/GREEN per module (bedrock-error 5, config 8, llm 25, embeddings 12, api 20); `npm test` 164/164, typecheck and build clean, lockfile keys normal. Replaced tests: json_object / LLM_EXTRA_BODY tests in config and llm (features removed by the brief). Commit `4b27d4c`.
- [x] T11 Deploy infra: Terraform for ECR + App Runner (1 instance, 0.25 vCPU / 1 GB, linux/amd64 image) + IAM roles, least-privilege Bedrock policy JSON, DEPLOY.md with exact commands, budget command and teardown. Route: delegated writer (infra/ only), parallel with T10. `terraform validate` passed (hashicorp/aws 6.67.0). Parent added the `grounded-qa-deploy` user policy and the profile setup (user asked for the alegra-style static-key profile).
- [x] T12 README sections from the brief (LM Studio, Bedrock, model access, AWS access, deploy, IAM policy, smoke test, cost, 10 USD budget, teardown); LocalStack notes removed at the user's request. Route: inline.
- [x] T13 Evals: LM Studio (gemma-4-e4b + nomic) 13/13; Bedrock (deepseek.v3.2 + Titan v2, account 717279723515, temporary root CloudShell credentials) 11/13, partial 0/2 because DeepSeek returns answerable:false for partially covered questions (raw output checked; prompt left unchanged per the brief).

## Brief 3: security layers (approved 2026-10-01, user chose "Cognito en la app")

Context: App Runner deploy is blocked on the deploy user's iam:PassRole until an admin sets the corrected policy version. Security review found a privilege-escalation path in the deploy-user policy (role creation + arbitrary policy attachment); fix with a permissions boundary. The deploy user's current key was pasted in chat; user asked to deactivate it.

- Branch: `feat/security-layers` (from `main` @ `0671924`). The three writers left their work uncommitted on `main`; the parent moved it to this branch and committed it as three work units on 2026-10-02.
- [x] T14 Backend security: AUTH_MODE (cognito | none, fail-closed in production), Cognito OAuth code flow with PKCE + state, session cookie (httpOnly, Secure, SameSite=Lax), JWT verification with aws-jwt-verify, admins group for upload/delete, Origin check on state-changing requests, per-user/IP rate limits, global daily ask cap, upload limits (documents, pages, chunks, parse timeout). Route: delegated writer (src/, test/*.test.ts, package.json). Parent spot check: `npm test` 222/222, `npm run typecheck` exit 0, lockfile 0 symlink keys. Commit `ba450a7`.
- [x] T15 Frontend auth: /api/me, sign-out, admin-only controls, 401 → login. Route: delegated writer after T14 (public/, test/ui/). Parent spot check: `npm run test:ui` 17/17. Commit `1ec55bf`.
- [x] T16 Infra security: Cognito user pool (admin-only sign-up, Essentials, managed login), client with secret in SSM, App Runner env/secrets, budget + automatic action that denies bedrock:InvokeModel, permissions boundary for every grounded-qa role, updated deploy-user policy, admin one-time steps in DEPLOY.md. Route: delegated writer (infra/), parallel with T14. Writer evidence: `terraform fmt` clean, `terraform validate` pass, deploy-user policy 4,295 chars (limit 6,144). Open assumption: `cognito-idp:*` scoped to `userpool/*` (fails closed if wrong). Commit `dd3510b` (includes the zsh `${REPO}` README fix).
- [x] T17 Docs + independent security review of T14–T16. Route: inline docs + fresh read-only reviewer. Review done (read-only, sonnet): must fix (1) CRITICAL `src/server.ts` never passes `auth`/`limits` to `createApp` nor sets `trust proxy`, so production runs as AUTH_MODE=none (verified by the parent); (2) MEDIUM Origin check fails open when the header is missing (`src/auth.ts`, verified). Follow-ups: PDF parse timeout does not stop CPU work; in-memory limits reset per process; session cookie Max-Age uses the access-token lifetime. Verified sound: PKCE/state, redirect URI, cookie flags, JWT verification, frontend has no HTML injection, deploy-user policy + boundary block the escalation path, budget action role scoped, client secret only in SSM. Fix: delegated writer (src/, test/, docs), strict TDD. New `src/bootstrap.ts` (`loadRuntimeDeps`) builds auth/limits/trust-proxy hops from env; `createApp` sets `trust proxy` first; `server.ts` wires them and logs the auth mode; Origin check fails closed. RED: bootstrap ERR_MODULE_NOT_FOUND, trust-proxy 3 failures (`trust proxy` false; forwarded-IP quota 429), missing-Origin test 404 instead of 403. GREEN: `npm test` 235/235, `test:ui` 17/17, typecheck and build exit 0, lockfile clean. Two existing admin tests now send `Origin`. Commit `df46673`. Parent spot check `npm test` 235/235, typecheck ok; README smoke test and known limits updated for auth (inline).
- [ ] T18 Deploy: admin one-time steps in CloudShell (deactivate the leaked deploy-user key, create the boundary, new deploy-user policy version), then the two-phase `terraform apply`, create the first admin user, smoke test. Route: inline (parent runs the commands with the user's fresh admin credentials). The 2026-10-02 temporary root credentials expired at 02:44 UTC before T17 finished; the user then created the IAM user `admin-cli` (AdministratorAccess, local profile `admin`, also used by the `aws-mcp` server) for the parent.
  - [x] T18a IAM admin steps (`<scratchpad>/admin-steps.sh`, profile `admin`): deleted the leaked inactive key `…redacted`; rotated the active key `…redacted` to `…redacted` (secret written only to `~/.claude/.aws-grounded-qa.env`, never printed; new key verified with `sts get-caller-identity` before the old one was deleted); boundary `grounded-qa-role-boundary` already existed (v1, 02:31 UTC) and its document is identical to `infra/iam-role-boundary.json`; deploy-user policy now `v3` (default) from `infra/iam-deploy-user-policy.json`. Simulation: `iam:PassRole` on `grounded-qa-apprunner-instance` → `allowed`; `iam:AttachRolePolicy` with `AdministratorAccess` → `implicitDeny`.
  - [x] T18b Build and push the image with the T17 fixes, two-phase `terraform apply`, first admin user, smoke test. Live: <service_url> (App Runner `RUNNING`). Second apply: 7 added, 3 tainted replaced; phase 2 (`app_url`) added the real callback/logout URLs (1 changed). Verification on production, 2026-10-02: anonymous HTTP — `/healthz` 200 `provider: bedrock`, `/` 302 → `/auth/login`, `POST /api/ask` 401, `/auth/login` 302 → Cognito authorize with S256 PKCE, state and the real callback. Browser E2E (`<scratchpad>/e2e.mjs`, Playwright + Chrome) with two throwaway users created exactly like the user's (temporary password, forced change): admin 12/12 (managed login, forced password change, back signed in, add-PDF visible, Mondays → "closed" citing FAQ · Hours from Bedrock, parking → refusal, `POST /api/ask` without Origin → 403, upload catering-guide.pdf, deposit → "30 percent" citing catering-guide.pdf · page 2, delete, sign out → login and `/api/me` 401, no console errors); non-admin 10/10 (add-PDF hidden, upload via API → 403). Throwaway users deleted afterwards. CloudWatch application log: `Auth mode: cognito`, `Provider bedrock`, listening, 0 error lines. Budget: 10 USD monthly, action `APPLY_IAM_POLICY` `AUTOMATIC` at 100%, status `STANDBY`. The user's own admin account (group `admins`) is still `FORCE_CHANGE_PASSWORD`; temporary passwords last 7 days. Not tested: the user's own first sign-in (no password; same flow as the throwaway users). Follow-up: `logs:DescribeLogGroups` needs `Resource "*"` (deploy user can read a known log group only). Progress log: image `:latest` = `:49d3f46` pushed (linux/amd64, deploy user). First apply (alert_email = the user's personal address, chosen by the user) created the kill-switch policy, budget-action role, Cognito pool `<user_pool_id>`, client and admins group, and added the boundary to both existing roles, then failed on three AccessDenied: `budgets:ListTagsForResource`, `cognito-idp:DescribeUserPoolDomain`, `ssm:DescribeParameters`. The Service Authorization Reference (servicereference.us-east-1.amazonaws.com) confirmed the last two take no resource type (need `*`) and that `budgets:CreateBudgetAction` needs the `budgetAction` ARN (it would have failed next). Fixed in `infra/iam-deploy-user-policy.json` (Access Analyzer: 0 findings, 4,590 chars), applied as v4 with the `admin` profile, simulated `allowed`. Commit `53be66f`. Admin app user created with the user's chosen personal address (status FORCE_CHANGE_PASSWORD, group `admins`). Second apply (7 add, 3 tainted replacements) running.
  - [ ] T18c Delete the `admin-cli` access key (permanent AdministratorAccess key on disk). User decision 2026-10-02: this is a demo; they will delete the whole stack on Saturday 2026-10-03, so the key stays until then (teardown: `terraform destroy` with the deploy user, then delete `admin-cli`, `grounded-qa-deploy`, the boundary and the deploy policy as admin).

## Pending (user-owned)

- DeepSeek/OpenAI eval run (needs keys in `.env`).
- RDD reviews: every commit assessed due (medium; Docker/CI high). Consent is the user's.
- Merge to main, push, Render deploy (commands in `decition.md` and README).

## Next step

User signs in at <service_url> with the emailed temporary password and sets a real one. Then (user-owned): push `feat/security-layers`, merge, and Saturday teardown (T18c).
