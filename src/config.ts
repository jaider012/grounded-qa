import { existsSync } from 'node:fs';

export type Provider = 'openai-compatible' | 'bedrock';

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface BedrockConfig {
  region: string;
  chatModelId: string;
  embeddingModelId: string;
}

export interface OpenAICompatibleConfig {
  provider: 'openai-compatible';
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  port: number;
}

export interface BedrockProviderConfig {
  provider: 'bedrock';
  bedrock: BedrockConfig;
  port: number;
}

/** Discriminated on `provider`: the fields present depend on which provider is active. */
export type Config = OpenAICompatibleConfig | BedrockProviderConfig;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

const OPENAI_COMPATIBLE_REQUIRED = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
] as const;

const BEDROCK_REQUIRED = ['AWS_REGION', 'BEDROCK_CHAT_MODEL_ID', 'BEDROCK_EMBEDDING_MODEL_ID'] as const;

/** Loads `.env` into process.env when the file exists. Production sets real env vars instead. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function read(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

function missingOf(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => !env[name]?.trim());
}

/**
 * Reads and validates the active provider's settings, naming every missing
 * variable for that provider at once. `PROVIDER` selects the implementation
 * (`openai-compatible` by default, so local LM Studio stays the free
 * default); Bedrock credentials always come from the AWS SDK default chain
 * and are never read here.
 */
export function loadConfig(env: Env): Config {
  const rawProvider = read(env, 'PROVIDER');
  const provider = rawProvider === '' ? 'openai-compatible' : rawProvider;

  if (provider !== 'openai-compatible' && provider !== 'bedrock') {
    throw new ConfigError(`PROVIDER must be "openai-compatible" or "bedrock", got "${provider}".`);
  }

  if (provider === 'bedrock') {
    const missing = missingOf(env, BEDROCK_REQUIRED);
    if (missing.length > 0) {
      throw new ConfigError(
        `Missing required environment variables for provider "bedrock": ${missing.join(', ')}.`,
      );
    }
    return {
      provider: 'bedrock',
      bedrock: {
        region: read(env, 'AWS_REGION'),
        chatModelId: read(env, 'BEDROCK_CHAT_MODEL_ID'),
        embeddingModelId: read(env, 'BEDROCK_EMBEDDING_MODEL_ID'),
      },
      port: parsePort(env['PORT']),
    };
  }

  const missing = missingOf(env, OPENAI_COMPATIBLE_REQUIRED);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables for provider "openai-compatible": ${missing.join(', ')}. ` +
        'For local development copy .env.example to .env; in production set them on the hosting platform.',
    );
  }

  return {
    provider: 'openai-compatible',
    llm: {
      baseURL: read(env, 'LLM_BASE_URL'),
      apiKey: read(env, 'LLM_API_KEY'),
      model: read(env, 'LLM_MODEL'),
    },
    embedding: {
      baseURL: read(env, 'EMBEDDING_BASE_URL'),
      apiKey: read(env, 'EMBEDDING_API_KEY'),
      model: read(env, 'EMBEDDING_MODEL'),
    },
    port: parsePort(env['PORT']),
  };
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${raw}".`);
  }
  return port;
}
