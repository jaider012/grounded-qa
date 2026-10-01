import OpenAI from 'openai';
import type { EmbeddingConfig } from './config.js';

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
