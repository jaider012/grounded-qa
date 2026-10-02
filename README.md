# Grounded Q&A

Ask a question and get an answer that comes **only** from the loaded documents: a built-in FAQ for Bonaire Bites plus any PDF you upload. Every answer cites the document, the page or section, and a verbatim quote that plain code has checked against the passage. If the documents do not cover the question, the app says so instead of guessing.

## Quick start (local, LM Studio)

1. In LM Studio, load `google/gemma-4-e4b` (chat) and `text-embedding-nomic-embed-text-v1.5` (embeddings), then start the server on port 1234 (`lms server start`).
2. Install and configure:
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
| `src/embeddings.ts` | `Embedder` interface and the OpenAI-compatible implementation |
| `src/store.ts` | In-memory vector store, brute-force cosine similarity |
| `src/llm.ts` | Chat call, JSON mode per provider, defensive parsing, model listing |
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
| `GET /healthz` | | `200 { status: "ok", documents }` | |

Every error body is `{ "error": "<what happened and what to do next>" }`.

## Configuration

| Variable | Development (LM Studio) | Production |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:1234/v1` | `https://api.deepseek.com` |
| `LLM_API_KEY` | `lm-studio` | your DeepSeek key |
| `LLM_MODEL` | `google/gemma-4-e4b` | `deepseek-flash` |
| `LLM_JSON_MODE` | `json_schema` | `json_object` |
| `EMBEDDING_BASE_URL` | `http://localhost:1234/v1` | `https://api.openai.com/v1` |
| `EMBEDDING_API_KEY` | `lm-studio` | your OpenAI key |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5` | `text-embedding-3-small` |
| `LLM_EXTRA_BODY` (optional) | unset | `{"thinking":{"type":"disabled"}}` |
| `PORT` (optional) | `3000` | set by the platform |

The seven provider variables are required; the server refuses to start without them and names the missing ones. It also refuses to start when `LLM_MODEL` is not in `GET {LLM_BASE_URL}/models`. Keys are only read from the environment; `.env` is git-ignored.

## Decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Verify citations in plain code, not with another LLM call | Deterministic, free and testable: a citation survives only if it points at a retrieved passage and its quote appears there verbatim (whitespace, dashes and quote marks normalised, at least 12 characters) | Proves the quote is real, not that the answer sentence follows from it |
| Discard the model's text whenever it says it cannot answer | General knowledge cannot leak through a "helpful" refusal | The refusal is one fixed English sentence, whatever the question's language |
| PDF chunks never cross a page; FAQ chunks are whole sections | A page or section citation is always true | Very short pages produce small chunks |
| In-memory store with brute-force cosine | No database to run; plenty for hundreds of chunks | Lost on restart; linear search |
| `LLM_JSON_MODE` per provider | LM Studio rejects `json_object` (HTTP 400, checked with a real call) and accepts `json_schema`; DeepSeek documents `json_object` | Two modes to keep in mind |
| `LLM_EXTRA_BODY` for DeepSeek | `deepseek-flash` runs in thinking mode by default, and thinking mode ignores `temperature`; disabling it keeps temperature 0 and answers faster | One optional variable beyond the brief |
| One retry on unreadable output, then 502 | DeepSeek's JSON mode docs warn the API may occasionally return empty content | Valid JSON with the wrong shape is treated as a refusal instead |
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
| DeepSeek + OpenAI | `deepseek-flash` + `text-embedding-3-small` | Not run yet: needs API keys (set the production values in `.env`, then `npm run eval`) |

The golden set is `eval/golden.json`: 13 questions tagged answerable, unanswerable, partial or adversarial (prompt injection). A case passes when the `answerable` flag is right and, for answerable cases, a citation points at the expected section. It checks the flag and the citation, not the wording of the answer.

## Deploy to Render

The vector store lives in process memory, so this must run as a long-lived web service, not as serverless functions. LM Studio is not reachable from Render: production uses the hosted values from the configuration table.

1. Push the repository to GitHub (commands below).
2. In Render: **New** → **Web Service** → connect the repository. Render detects the `Dockerfile` and uses the Docker runtime.
3. Under **Advanced**, set the **Health Check Path** to `/healthz`.
4. Add the environment variables from the Production column, including `LLM_EXTRA_BODY`. Do not set `PORT`; Render provides it and the server binds `0.0.0.0`.
5. Deploy. The log should show the DeepSeek model list and `listening on http://0.0.0.0:10000 (1 document(s) loaded)`.


### Smoke test against the live URL

```bash
URL=https://<your-service>.onrender.com

curl -s "$URL/healthz"
# {"status":"ok","documents":1}

curl -s -X POST "$URL/api/ask" -H 'Content-Type: application/json' \
  -d '{"question":"Are you open on Mondays?"}'
# "answerable":true, an answer saying no, and a citation at location "Hours"

curl -s -X POST "$URL/api/ask" -H 'Content-Type: application/json' \
  -d '{"question":"Do you have parking?"}'
# {"answerable":false,"answer":"I can't answer that from the loaded documents.","citations":[],...}
```

## Known limits

- **The store is lost on restart.** Uploaded PDFs disappear on every deploy or restart. On Render's free plan the service also spins down after 15 minutes without traffic and takes about a minute to wake up.
- **The check proves the quote, not the answer.** Example from local testing: asked "Can I book a table for 4 people?", Gemma answered "Yes" while citing the true sentence "Parties of 5 or fewer are seated on a walk-in basis."
- **No OCR.** Scanned PDFs are rejected with a message asking for OCR first.
- **No auth or rate limiting.** Anyone with the URL can upload files and spend model tokens.
- **Retrieval is embeddings only.** Questions in other languages retrieve less precisely with the local English embedding model.
- **The refusal is English only.**

## What I would do next

1. Persistence with Postgres + pgvector, so documents survive restarts and scale past brute force.
2. Hybrid search: BM25 plus vectors, with a reranker.
3. An entailment check that every answer sentence is supported by its cited quote.
