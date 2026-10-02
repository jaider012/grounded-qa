import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockConfig, Config, EmbeddingConfig } from '../src/config.js';
import { createBedrockEmbedder, createEmbedder, createOpenAIEmbedder } from '../src/embeddings.js';
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

// --- createBedrockEmbedder --------------------------------------------------------

const bedrockConfig: BedrockConfig = {
  region: 'us-east-1',
  chatModelId: 'test-chat-model',
  embeddingModelId: 'test-embedding-model',
};

interface FakeBedrockClient {
  send(command: unknown): Promise<unknown>;
}

function titanResponse(embedding: number[]): { body: Uint8Array } {
  return { body: new TextEncoder().encode(JSON.stringify({ embedding })) };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

test('createBedrockEmbedder sends one InvokeModelCommand per text with the Titan request body', async () => {
  const calls: InvokeModelCommand[] = [];
  const client: FakeBedrockClient = {
    async send(command: unknown): Promise<unknown> {
      calls.push(command as InvokeModelCommand);
      return titanResponse([1, 2, 3]);
    },
  };

  const embedder = createBedrockEmbedder(bedrockConfig, { client, concurrency: 1 });
  const vectors = await embedder(['hello world']);

  assert.equal(calls.length, 1);
  const command = calls[0];
  assert.ok(command instanceof InvokeModelCommand);
  assert.equal(command.input.modelId, 'test-embedding-model');
  assert.equal(command.input.contentType, 'application/json');
  assert.equal(command.input.accept, 'application/json');
  assert.deepEqual(JSON.parse(command.input.body as string), {
    inputText: 'hello world',
    dimensions: 1024,
    normalize: true,
  });
  assert.deepEqual(vectors, [[1, 2, 3]]);
});

test('createBedrockEmbedder returns vectors in input order even when calls settle out of order', async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  const client: FakeBedrockClient = {
    send(): Promise<unknown> {
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };

  const embedder = createBedrockEmbedder(bedrockConfig, { client, concurrency: 3 });
  const resultPromise = embedder(['a', 'b', 'c']);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 3);

  resolvers[2]!(titanResponse([3]));
  resolvers[0]!(titanResponse([1]));
  resolvers[1]!(titanResponse([2]));

  assert.deepEqual(await resultPromise, [[1], [2], [3]]);
});

test('createBedrockEmbedder never runs more than `concurrency` calls at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let resolved = 0;
  const waiters: Array<(value: unknown) => void> = [];

  const client: FakeBedrockClient = {
    send(): Promise<unknown> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        waiters.push((value) => {
          inFlight -= 1;
          resolve(value);
        });
      });
    },
  };

  const texts = Array.from({ length: 12 }, (_, i) => `text-${i}`);
  const resultPromise = createBedrockEmbedder(bedrockConfig, { client, concurrency: 5 })(texts);

  while (resolved < texts.length) {
    await new Promise((resolve) => setImmediate(resolve));
    while (waiters.length > 0) {
      const resolveCall = waiters.shift()!;
      resolveCall(titanResponse([resolved]));
      resolved += 1;
    }
  }

  const vectors = await resultPromise;
  assert.equal(vectors.length, 12);
  assert.equal(maxInFlight, 5);
});

test('retries ThrottlingException with exponential backoff and succeeds on the third attempt', async () => {
  let attempt = 0;
  const sleepCalls: number[] = [];
  const client: FakeBedrockClient = {
    async send(): Promise<unknown> {
      attempt += 1;
      if (attempt < 3) {
        throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      }
      return titanResponse([9]);
    },
  };

  const embedder = createBedrockEmbedder(bedrockConfig, {
    client,
    concurrency: 1,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });

  const vectors = await embedder(['only text']);

  assert.equal(attempt, 3);
  assert.deepEqual(vectors, [[9]]);
  assert.equal(sleepCalls.length, 2);
  assert.ok(sleepCalls[1]! > sleepCalls[0]!);
});

test('rejects after exactly maxAttempts ThrottlingException retries with a clear message', async () => {
  let attempt = 0;
  const client: FakeBedrockClient = {
    async send(): Promise<unknown> {
      attempt += 1;
      throw Object.assign(new Error('still throttled'), { name: 'ThrottlingException' });
    },
  };

  const embedder = createBedrockEmbedder(bedrockConfig, { client, concurrency: 1, sleep: noSleep });

  await assert.rejects(
    () => embedder(['only text']),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(attempt, 3);
      assert.match(error.message, /throttl/i);
      return true;
    },
  );
});

test('wraps an AccessDeniedException in a clear message naming the model and region', async () => {
  const client: FakeBedrockClient = {
    async send(): Promise<unknown> {
      throw Object.assign(new Error('no access'), { name: 'AccessDeniedException' });
    },
  };
  const embedder = createBedrockEmbedder(bedrockConfig, { client, sleep: noSleep });

  await assert.rejects(
    () => embedder(['x']),
    /Bedrock denied access to test-embedding-model in us-east-1/,
  );
});

// --- createEmbedder dispatcher --------------------------------------------------------

test('createEmbedder builds an openai-compatible Embedder when config.provider is openai-compatible', () => {
  const appConfig: Config = {
    provider: 'openai-compatible',
    llm: { baseURL: config.baseURL, apiKey: config.apiKey, model: 'chat-model' },
    embedding: config,
    port: 3000,
  };

  const embedder = createEmbedder(appConfig);

  assert.equal(typeof embedder, 'function');
});

test('createEmbedder builds a Bedrock Embedder when config.provider is bedrock', () => {
  const appConfig: Config = { provider: 'bedrock', bedrock: bedrockConfig, port: 3000 };

  const embedder = createEmbedder(appConfig);

  assert.equal(typeof embedder, 'function');
});
