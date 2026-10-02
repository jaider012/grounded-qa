import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import type { Config } from './config.js';
import { assertModelAvailable, createOpenAILlm, listModels } from './llm.js';
import { createOpenAIEmbedder } from './embeddings.js';
import { VectorStore } from './store.js';
import { FAQ_SOURCE, faqChunks } from './faq.js';
import { createApp } from './app.js';

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

async function listModelsOrExit(config: Config): Promise<string[]> {
  try {
    return await listModels(config.llm);
  } catch (error) {
    console.error(
      `Could not list models at ${config.llm.baseURL}/models: ${reasonOf(error)}. Check LLM_BASE_URL and LLM_API_KEY.`,
    );
    process.exit(1);
  }
}

function assertModelAvailableOrExit(config: Config, available: readonly string[]): void {
  try {
    assertModelAvailable(available, config.llm.model, config.llm.baseURL);
  } catch (error) {
    console.error(reasonOf(error));
    process.exit(1);
  }
}

async function addFaqOrExit(store: VectorStore, config: Config): Promise<void> {
  try {
    await store.addDocument(FAQ_SOURCE, faqChunks());
  } catch (error) {
    console.error(
      `Could not embed the built-in FAQ with EMBEDDING_MODEL "${config.embedding.model}" at ${config.embedding.baseURL}: ${reasonOf(error)}`,
    );
    process.exit(1);
  }
}

loadDotEnv();
const config = loadConfigOrExit();

const availableModels = await listModelsOrExit(config);
console.log(`LLM models available at ${config.llm.baseURL}: ${availableModels.join(', ')}`);
assertModelAvailableOrExit(config, availableModels);

const embedder = createOpenAIEmbedder(config.embedding);
const store = new VectorStore(embedder);
await addFaqOrExit(store, config);

const llm = createOpenAILlm(config.llm);
const app = createApp({ store, llm, protectedDocuments: [FAQ_SOURCE] });

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
