import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { assertModelAvailable, createLlm, listModels } from '../src/llm.js';
import { createEmbedder } from '../src/embeddings.js';
import { VectorStore } from '../src/store.js';
import { FAQ_SOURCE, faqChunks } from '../src/faq.js';
import { answerQuestion } from '../src/answer.js';
import type { CaseScore, GoldenCase } from './eval-score.js';
import { parseGolden, scoreCase, summarize } from './eval-score.js';

/**
 * Runs the golden set (eval/golden.json) against whatever provider the
 * environment points at. Not part of CI: prints a pass/fail row per
 * question plus a summary, and exits 1 if any case failed.
 */

const QUESTION_WIDTH = 60;
const ID_WIDTH = 4;
const CATEGORY_WIDTH = 12;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

loadDotEnv();
const config = loadConfig(process.env);

if (config.provider === 'openai-compatible') {
  console.log(
    `Provider: LLM "${config.llm.model}" at ${config.llm.baseURL}; embeddings "${config.embedding.model}" at ${config.embedding.baseURL}`,
  );
  const availableModels = await listModels(config.llm);
  assertModelAvailable(availableModels, config.llm.model, config.llm.baseURL);
} else {
  console.log(
    `Provider bedrock in ${config.bedrock.region}: chat ${config.bedrock.chatModelId}, embeddings ${config.bedrock.embeddingModelId}`,
  );
}

const embedder = createEmbedder(config);
const store = new VectorStore(embedder);
await store.addDocument(FAQ_SOURCE, faqChunks());

const llm = createLlm(config);

const goldenPath = fileURLToPath(new URL('../eval/golden.json', import.meta.url));
const rawGolden: unknown = JSON.parse(await readFile(goldenPath, 'utf8'));
const cases = parseGolden(rawGolden);

console.log(`Loaded ${cases.length} golden case(s) from ${goldenPath}.\n`);

const rows: Array<{ golden: GoldenCase; score: CaseScore }> = [];

for (const golden of cases) {
  const startedAt = performance.now();
  let score: CaseScore;
  let detail: string;

  try {
    const result = await answerQuestion({ store, llm }, golden.question);
    score = scoreCase(golden, result);
    if (score.pass) {
      const locations = result.citations.map((citation) => citation.location);
      detail = golden.expectAnswerable
        ? `cited: ${locations.length > 0 ? locations.join(', ') : 'none'}`
        : 'refused as expected';
    } else {
      detail = score.reason;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    score = { pass: false, reason };
    detail = reason;
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  rows.push({ golden, score });

  const status = score.pass ? 'PASS' : 'FAIL';
  console.log(
    `${status}  ${pad(golden.id, ID_WIDTH)}  ${pad(golden.category, CATEGORY_WIDTH)}  ${String(latencyMs).padStart(6)}ms  ${pad(truncate(golden.question, QUESTION_WIDTH), QUESTION_WIDTH)}  ${detail}`,
  );
}

const summary = summarize(rows);

console.log('');
console.log(`Passed ${summary.passed}/${summary.total}`);
for (const category of Object.keys(summary.byCategory) as Array<keyof typeof summary.byCategory>) {
  const counts = summary.byCategory[category];
  console.log(`  ${pad(category, CATEGORY_WIDTH)} ${counts.passed}/${counts.total}`);
}

process.exit(summary.passed === summary.total ? 0 : 1);
