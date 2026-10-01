import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddingConfig } from '../src/config.js';
import { createOpenAIEmbedder } from '../src/embeddings.js';
import type { EmbeddingsClient } from '../src/embeddings.js';

const config: EmbeddingConfig = {
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'test-key',
  model: 'test-embedding-model',
};

type CreateBody = { model: string; input: string[]; encoding_format: 'float' };
type CreateResponse = { data: Array<{ index: number; embedding: number[] }> };

function fakeClient(handler: (body: CreateBody) => CreateResponse): {
  client: EmbeddingsClient;
  calls: CreateBody[];
} {
  const calls: CreateBody[] = [];
  const client: EmbeddingsClient = {
    embeddings: {
      async create(body) {
        calls.push(body);
        return handler(body);
      },
    },
  };
  return { client, calls };
}

test('batches requests by batchSize and makes the expected number of calls', async () => {
  const { client, calls } = fakeClient((body) => ({
    data: body.input.map((text, index) => ({ index, embedding: [text.length] })),
  }));
  const embedder = createOpenAIEmbedder(config, { batchSize: 2, client });

  const vectors = await embedder(['a', 'bb', 'ccc', 'dddd', 'eeeee']);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      ['a', 'bb'],
      ['ccc', 'dddd'],
      ['eeeee'],
    ],
  );
  assert.deepEqual(vectors, [[1], [2], [3], [4], [5]]);
  assert.ok(calls.every((call) => call.encoding_format === 'float' && call.model === config.model));
});

test('reorders an out-of-order response back into input order', async () => {
  const { client } = fakeClient((body) => ({
    data: body.input.map((text, index) => ({ index, embedding: [text.length] })).reverse(),
  }));
  const embedder = createOpenAIEmbedder(config, { client });

  const vectors = await embedder(['a', 'bb', 'ccc']);

  assert.deepEqual(vectors, [[1], [2], [3]]);
});

test('makes no request for empty input', async () => {
  const { client, calls } = fakeClient(() => ({ data: [] }));
  const embedder = createOpenAIEmbedder(config, { client });

  const vectors = await embedder([]);

  assert.deepEqual(vectors, []);
  assert.equal(calls.length, 0);
});

test('throws a clear error when a response returns a different vector count than inputs', async () => {
  const { client } = fakeClient(() => ({ data: [{ index: 0, embedding: [1] }] }));
  const embedder = createOpenAIEmbedder(config, { client });

  await assert.rejects(() => embedder(['a', 'b']), /2 inputs/);
});
