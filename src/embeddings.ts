import OpenAI from 'openai';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockConfig, Config, EmbeddingConfig } from './config.js';
import { describeBedrockError } from './bedrock-error.js';

export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * Structural shape of the embeddings API this module needs. The real
 * `openai` client satisfies this without a cast; tests can pass a fake.
 */
export interface EmbeddingsClient {
  embeddings: {
    create(body: { model: string; input: string[]; encoding_format: 'float' }): Promise<{
      data: Array<{ index: number; embedding: number[] }>;
    }>;
  };
}

const DEFAULT_BATCH_SIZE = 64;

function toBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * Creates an `Embedder` backed by an OpenAI-compatible embeddings endpoint.
 * Batches requests (default 64 inputs per call), always requests the
 * `float` encoding (some OpenAI-compatible servers do not support the
 * SDK's default base64 mode), and returns vectors in input order regardless
 * of the order the server responds in. Never hard-codes vector dimensions.
 */
export function createOpenAIEmbedder(
  config: EmbeddingConfig,
  options?: { batchSize?: number; client?: EmbeddingsClient },
): Embedder {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const client: EmbeddingsClient =
    options?.client ?? new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];

    const vectors: number[][] = [];
    for (const batch of toBatches(texts, batchSize)) {
      const response = await client.embeddings.create({
        model: config.model,
        input: batch,
        encoding_format: 'float',
      });

      if (response.data.length !== batch.length) {
        throw new Error(
          `Embedding response returned ${response.data.length} vectors for ${batch.length} inputs.`,
        );
      }

      const byIndex = [...response.data].sort((a, b) => a.index - b.index);
      for (const item of byIndex) {
        vectors.push(item.embedding);
      }
    }
    return vectors;
  };
}

// --- Bedrock -----------------------------------------------------------------

interface BedrockSendClient {
  send(command: unknown): Promise<unknown>;
}

export interface BedrockEmbedderOptions {
  client?: BedrockSendClient;
  /** Maximum InvokeModel calls in flight at once. Default 5. */
  concurrency?: number;
  /** Maximum attempts per text (first try plus retries) before giving up. Default 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between ThrottlingException retries, in ms. Default 500. */
  baseDelayMs?: number;
  /** Injectable sleep, so tests do not wait for real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
// Fixed Titan Embeddings V2 output size; never hard-coded anywhere else in this module.
const TITAN_DIMENSIONS = 1024;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottlingException(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ThrottlingException';
}

/** Reads an InvokeModel response body (a Uint8Array-like blob, or a plain string in tests) as text. */
function bodyTextOf(body: unknown): string {
  if (typeof body === 'string') return body;
  const transformToString = (body as { transformToString?: unknown })?.transformToString;
  if (typeof transformToString === 'function') {
    return (transformToString as () => string).call(body);
  }
  return Buffer.from(body as Uint8Array).toString('utf8');
}

/**
 * Creates an `Embedder` backed by Bedrock's Titan embedding model through
 * `InvokeModel`. Titan takes one text per call, so this issues one
 * `InvokeModelCommand` per text, bounded by `concurrency` calls in flight,
 * retrying only `ThrottlingException` with exponential backoff. Results are
 * always returned in input order regardless of completion order. AWS errors
 * are turned into clear messages naming the model and region.
 */
export function createBedrockEmbedder(config: BedrockConfig, options?: BedrockEmbedderOptions): Embedder {
  const client = options?.client ?? new BedrockRuntimeClient({ region: config.region });
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options?.sleep ?? defaultSleep;

  async function embedOne(text: string): Promise<number[]> {
    for (let attempt = 1; ; attempt += 1) {
      const command = new InvokeModelCommand({
        modelId: config.embeddingModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions: TITAN_DIMENSIONS, normalize: true }),
      });

      try {
        const response = (await client.send(command)) as { body: unknown };
        const parsed = JSON.parse(bodyTextOf(response.body)) as { embedding: number[] };
        return parsed.embedding;
      } catch (error) {
        if (isThrottlingException(error) && attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(
          describeBedrockError(error, { modelId: config.embeddingModelId, region: config.region }),
          { cause: error },
        );
      }
    }
  }

  return async (texts: string[]): Promise<number[][]> => {
    const results: number[][] = new Array(texts.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= texts.length) return;
        results[index] = await embedOne(texts[index]!);
      }
    }

    const workerCount = Math.min(concurrency, texts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  };
}

/** Picks the `Embedder` implementation from `config.provider`. */
export function createEmbedder(config: Config): Embedder {
  if (config.provider === 'bedrock') return createBedrockEmbedder(config.bedrock);
  return createOpenAIEmbedder(config.embedding);
}
