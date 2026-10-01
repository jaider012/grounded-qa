import { existsSync } from 'node:fs';

export type JsonMode = 'json_schema' | 'json_object';

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  jsonMode: JsonMode;
  /** Fields merged into every chat completion request body (LLM_EXTRA_BODY). */
  extraBody: Record<string, unknown>;
}

export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface Config {
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  port: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const REQUIRED = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_JSON_MODE',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Loads `.env` into process.env when the file exists. Production sets real env vars instead. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Reads and validates the provider settings, naming every missing variable at once. */
export function loadConfig(env: Env): Config {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'For local development copy .env.example to .env; in production set them on the hosting platform.',
    );
  }
  const read = (name: (typeof REQUIRED)[number]): string => (env[name] ?? '').trim();

  const jsonMode = read('LLM_JSON_MODE');
  if (jsonMode !== 'json_schema' && jsonMode !== 'json_object') {
    throw new ConfigError(`LLM_JSON_MODE must be "json_schema" or "json_object", got "${jsonMode}".`);
  }

  return {
    llm: {
      baseURL: read('LLM_BASE_URL'),
      apiKey: read('LLM_API_KEY'),
      model: read('LLM_MODEL'),
      jsonMode,
      extraBody: parseExtraBody(env['LLM_EXTRA_BODY']),
    },
    embedding: {
      baseURL: read('EMBEDDING_BASE_URL'),
      apiKey: read('EMBEDDING_API_KEY'),
      model: read('EMBEDDING_MODEL'),
    },
    port: parsePort(env['PORT']),
  };
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('LLM_EXTRA_BODY must be a JSON object, for example {"thinking":{"type":"disabled"}}.');
  }
  return parsed as Record<string, unknown>;
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${raw}".`);
  }
  return port;
}
