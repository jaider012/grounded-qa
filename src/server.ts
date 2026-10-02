import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import type { Config } from './config.js';
import { assertModelAvailable, createLlm, listModels } from './llm.js';
import { createEmbedder } from './embeddings.js';
import { VectorStore } from './store.js';
import { FAQ_SOURCE, faqChunks } from './faq.js';
import { createApp } from './app.js';
import { loadRuntimeDeps } from './bootstrap.js';
import type { RuntimeDeps } from './bootstrap.js';

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function loadRuntimeDepsOrExit(): RuntimeDeps {
  try {
    return loadRuntimeDeps(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function listModelsOrExit(llm: { baseURL: string; apiKey: string; model: string }): Promise<string[]> {
  try {
    return await listModels(llm);
  } catch (error) {
    console.error(
      `Could not list models at ${llm.baseURL}/models: ${reasonOf(error)}. Check LLM_BASE_URL and LLM_API_KEY.`,
    );
    process.exit(1);
  }
}

function assertModelAvailableOrExit(
  llm: { baseURL: string; model: string },
  available: readonly string[],
): void {
  try {
    assertModelAvailable(available, llm.model, llm.baseURL);
  } catch (error) {
    console.error(reasonOf(error));
    process.exit(1);
  }
}

async function addFaqOrExit(store: VectorStore, config: Config): Promise<void> {
  try {
    await store.addDocument(FAQ_SOURCE, faqChunks());
  } catch (error) {
    const detail =
      config.provider === 'openai-compatible'
        ? `with EMBEDDING_MODEL "${config.embedding.model}" at ${config.embedding.baseURL}`
        : `with BEDROCK_EMBEDDING_MODEL_ID "${config.bedrock.embeddingModelId}" in ${config.bedrock.region}`;
    console.error(`Could not embed the built-in FAQ ${detail}: ${reasonOf(error)}`);
    process.exit(1);
  }
}

loadDotEnv();
const config = loadConfigOrExit();
const runtimeDeps = loadRuntimeDepsOrExit();
console.log(`Auth mode: ${runtimeDeps.auth.mode}`);

if (config.provider === 'openai-compatible') {
  const availableModels = await listModelsOrExit(config.llm);
  console.log(`LLM models available at ${config.llm.baseURL}: ${availableModels.join(', ')}`);
  assertModelAvailableOrExit(config.llm, availableModels);
} else {
  console.log(
    `Provider bedrock in ${config.bedrock.region}: chat ${config.bedrock.chatModelId}, embeddings ${config.bedrock.embeddingModelId}`,
  );
}

const embedder = createEmbedder(config);
const store = new VectorStore(embedder);
await addFaqOrExit(store, config);

const llm = createLlm(config);
const app = createApp({
  store,
  llm,
  protectedDocuments: [FAQ_SOURCE],
  provider: config.provider,
  auth: runtimeDeps.auth,
  limits: runtimeDeps.limits,
  trustProxyHops: runtimeDeps.trustProxyHops,
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(
    `grounded-qa listening on http://0.0.0.0:${config.port} (${store.documentCount} document(s) loaded)`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
