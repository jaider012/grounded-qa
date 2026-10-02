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

// --- Auth ------------------------------------------------------------------

export type AuthMode = 'cognito' | 'none';

export interface CognitoSettings {
  userPoolId: string;
  clientId: string;
  clientSecret: string;
  /** Full https URL of the managed login domain, e.g. `https://my-app.auth.us-east-1.amazoncognito.com`. */
  domain: string;
}

export type AuthSettings = { mode: 'none' } | { mode: 'cognito'; cognito: CognitoSettings };

const COGNITO_REQUIRED = [
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_CLIENT_SECRET',
  'COGNITO_DOMAIN',
] as const;

function assertHttpsUrl(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a full https URL, got "${value}".`);
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be a full https URL, got "${value}".`);
  }
}

/**
 * Reads and validates `AUTH_MODE` and, when it is `cognito`, the Cognito
 * settings required to run OAuth against a managed login domain. Fails
 * closed: an unset `AUTH_MODE` in production is an error, and `AUTH_MODE=none`
 * is never allowed in production.
 */
export function loadAuthSettings(env: Env): AuthSettings {
  const rawMode = read(env, 'AUTH_MODE');
  const isProduction = read(env, 'NODE_ENV') === 'production';

  if (rawMode === '') {
    if (isProduction) {
      throw new ConfigError('AUTH_MODE must be set in production.');
    }
    return { mode: 'none' };
  }

  if (rawMode !== 'cognito' && rawMode !== 'none') {
    throw new ConfigError(`AUTH_MODE must be "cognito" or "none", got "${rawMode}".`);
  }

  if (rawMode === 'none') {
    if (isProduction) {
      throw new ConfigError('Authentication cannot be disabled in production.');
    }
    return { mode: 'none' };
  }

  const missing = missingOf(env, COGNITO_REQUIRED);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables for AUTH_MODE=cognito: ${missing.join(', ')}.`);
  }

  const domain = read(env, 'COGNITO_DOMAIN');
  assertHttpsUrl('COGNITO_DOMAIN', domain);

  return {
    mode: 'cognito',
    cognito: {
      userPoolId: read(env, 'COGNITO_USER_POOL_ID'),
      clientId: read(env, 'COGNITO_CLIENT_ID'),
      clientSecret: read(env, 'COGNITO_CLIENT_SECRET'),
      domain,
    },
  };
}

// --- Abuse limits ------------------------------------------------------------

export interface LimitsSettings {
  /** Per-minute request limit on POST /api/ask, keyed per user/IP. */
  askPerMinute: number;
  /** Global cap on POST /api/ask across all users per UTC day. */
  dailyAskLimit: number;
  /** Per-hour request limit on POST /api/documents, keyed per user/IP. */
  uploadsPerHour: number;
  /** Per-hour request limit on DELETE /api/documents/:name, keyed per user/IP. */
  deletesPerHour: number;
  /** Maximum uploaded documents the store may hold (the built-in FAQ does not count). */
  maxDocuments: number;
  /** Maximum pages accepted in an uploaded PDF. */
  maxPdfPages: number;
  /** Maximum chunks the store may hold across every document. */
  maxTotalChunks: number;
  /** Maximum time, in milliseconds, allowed to parse one uploaded PDF. */
  pdfParseTimeoutMs: number;
}

/** The safe defaults applied to every optional abuse-limit variable that is unset. */
export const DEFAULT_LIMITS: LimitsSettings = {
  askPerMinute: 20,
  dailyAskLimit: 500,
  uploadsPerHour: 10,
  deletesPerHour: 30,
  maxDocuments: 20,
  maxPdfPages: 100,
  maxTotalChunks: 3000,
  pdfParseTimeoutMs: 15000,
};

function parsePositiveInt(env: Env, name: string, defaultValue: number): number {
  const raw = read(env, name);
  if (raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/** Reads the optional abuse-limit variables, applying safe defaults for any that are unset. */
export function loadLimitsSettings(env: Env): LimitsSettings {
  return {
    askPerMinute: parsePositiveInt(env, 'RATE_LIMIT_ASK_PER_MINUTE', DEFAULT_LIMITS.askPerMinute),
    dailyAskLimit: parsePositiveInt(env, 'DAILY_ASK_LIMIT', DEFAULT_LIMITS.dailyAskLimit),
    uploadsPerHour: parsePositiveInt(env, 'RATE_LIMIT_UPLOADS_PER_HOUR', DEFAULT_LIMITS.uploadsPerHour),
    deletesPerHour: parsePositiveInt(env, 'RATE_LIMIT_DELETES_PER_HOUR', DEFAULT_LIMITS.deletesPerHour),
    maxDocuments: parsePositiveInt(env, 'MAX_DOCUMENTS', DEFAULT_LIMITS.maxDocuments),
    maxPdfPages: parsePositiveInt(env, 'MAX_PDF_PAGES', DEFAULT_LIMITS.maxPdfPages),
    maxTotalChunks: parsePositiveInt(env, 'MAX_TOTAL_CHUNKS', DEFAULT_LIMITS.maxTotalChunks),
    pdfParseTimeoutMs: parsePositiveInt(env, 'PDF_PARSE_TIMEOUT_MS', DEFAULT_LIMITS.pdfParseTimeoutMs),
  };
}

// --- Reverse proxy -----------------------------------------------------------

/**
 * Reads `TRUST_PROXY_HOPS` (0 by default; App Runner sets 1), the number of
 * hops to trust for `X-Forwarded-*` headers so `req.ip` and `req.protocol`
 * report the real client behind the proxy.
 */
export function loadTrustProxyHops(env: Env): number {
  const raw = read(env, 'TRUST_PROXY_HOPS');
  if (raw === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`TRUST_PROXY_HOPS must be a non-negative integer, got "${raw}".`);
  }
  return value;
}
