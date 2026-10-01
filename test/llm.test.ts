import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import type { LlmConfig } from '../src/config.js';
import {
  ANSWER_SCHEMA,
  ModelOutputError,
  createOpenAILlm,
  listModels,
  parseModelJson,
} from '../src/llm.js';

// --- parseModelJson --------------------------------------------------------

test('parseModelJson parses plain JSON', () => {
  const result = parseModelJson('{"answerable":true,"answer":"Yes.","citations":[]}');
  assert.deepEqual(result, { answerable: true, answer: 'Yes.', citations: [] });
});

test('parseModelJson strips a ```json code fence', () => {
  const raw = '```json\n{"answerable":true,"answer":"Yes.","citations":[]}\n```';
  assert.deepEqual(parseModelJson(raw), { answerable: true, answer: 'Yes.', citations: [] });
});

test('parseModelJson strips a plain ``` code fence', () => {
  const raw = '```\n{"answerable":false,"answer":"","citations":[]}\n```';
  assert.deepEqual(parseModelJson(raw), { answerable: false, answer: '', citations: [] });
});

test('parseModelJson removes a closed <think> block', () => {
  const raw = '<think>Let me reason about this.</think>{"answerable":true,"answer":"Yes.","citations":[]}';
  assert.deepEqual(parseModelJson(raw), { answerable: true, answer: 'Yes.', citations: [] });
});

test('parseModelJson removes an unterminated leading <think> prefix', () => {
  const raw = '<think>Still reasoning and never closing the tag {"answerable":true,"answer":"Yes.","citations":[]}';
  assert.deepEqual(parseModelJson(raw), { answerable: true, answer: 'Yes.', citations: [] });
});

test('parseModelJson extracts JSON surrounded by prose', () => {
  const raw = 'Sure, here you go: {"answerable":true,"answer":"Yes.","citations":[]} Hope that helps!';
  assert.deepEqual(parseModelJson(raw), { answerable: true, answer: 'Yes.', citations: [] });
});

test('parseModelJson throws ModelOutputError for an empty response', () => {
  assert.throws(() => parseModelJson(''), ModelOutputError);
  assert.throws(() => parseModelJson('   '), ModelOutputError);
  assert.throws(() => parseModelJson('<think>only reasoning</think>'), ModelOutputError);
});

test('parseModelJson throws ModelOutputError for garbage', () => {
  assert.throws(() => parseModelJson('not json at all, no braces here'), ModelOutputError);
});

// --- createOpenAILlm --------------------------------------------------------

const baseConfig: LlmConfig = {
  baseURL: 'https://fake.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  jsonMode: 'json_schema',
  extraBody: {},
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (request: CapturedRequest) => { status?: number; body: unknown }): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    const request: CapturedRequest = { url, body };
    calls.push(request);
    const { status = 200, body: responseBody } = respond(request);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn, calls };
}

function chatCompletionResponse(message: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', ...message } }],
  };
}

test('createOpenAILlm posts to /chat/completions with temperature 0 and the configured model', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: chatCompletionResponse({ content: 'hi' }) }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });
  const llm = createOpenAILlm(baseConfig, { client });

  await llm.complete([{ role: 'user', content: 'Are you open on Mondays?' }]);

  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.url.endsWith('/chat/completions'));
  assert.equal(calls[0]?.body['model'], baseConfig.model);
  assert.equal(calls[0]?.body['temperature'], 0);
  assert.equal(calls[0]?.body['max_tokens'], 800);
});

test('createOpenAILlm uses a json_schema response_format named grounded_answer in json_schema mode', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: chatCompletionResponse({ content: '{}' }) }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });
  const llm = createOpenAILlm(baseConfig, { client });

  await llm.complete([{ role: 'user', content: 'q' }]);

  assert.deepEqual(calls[0]?.body['response_format'], {
    type: 'json_schema',
    json_schema: { name: 'grounded_answer', strict: true, schema: ANSWER_SCHEMA },
  });
});

test('createOpenAILlm uses a json_object response_format in json_object mode', async () => {
  const config: LlmConfig = { ...baseConfig, jsonMode: 'json_object' };
  const { fetch, calls } = fakeFetch(() => ({ body: chatCompletionResponse({ content: '{}' }) }));
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch });
  const llm = createOpenAILlm(config, { client });

  await llm.complete([{ role: 'user', content: 'q' }]);

  assert.deepEqual(calls[0]?.body['response_format'], { type: 'json_object' });
});

test('createOpenAILlm merges extraBody into the request, spread last', async () => {
  const config: LlmConfig = { ...baseConfig, extraBody: { thinking: { type: 'disabled' } } };
  const { fetch, calls } = fakeFetch(() => ({ body: chatCompletionResponse({ content: '{}' }) }));
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, fetch });
  const llm = createOpenAILlm(config, { client });

  await llm.complete([{ role: 'user', content: 'q' }]);

  assert.deepEqual(calls[0]?.body['thinking'], { type: 'disabled' });
  // Explicit fields configured by this module are still present alongside it.
  assert.equal(calls[0]?.body['temperature'], 0);
});

test('createOpenAILlm respects a custom maxTokens option', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: chatCompletionResponse({ content: '{}' }) }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });
  const llm = createOpenAILlm(baseConfig, { client, maxTokens: 123 });

  await llm.complete([{ role: 'user', content: 'q' }]);

  assert.equal(calls[0]?.body['max_tokens'], 123);
});

test('createOpenAILlm returns the message content', async () => {
  const { fetch } = fakeFetch(() => ({
    body: chatCompletionResponse({ content: '{"answerable":true,"answer":"Yes.","citations":[]}' }),
  }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });
  const llm = createOpenAILlm(baseConfig, { client });

  const content = await llm.complete([{ role: 'user', content: 'q' }]);

  assert.equal(content, '{"answerable":true,"answer":"Yes.","citations":[]}');
});

test('createOpenAILlm rejects with a ModelOutputError mentioning reasoning_content when content is empty', async () => {
  const { fetch } = fakeFetch(() => ({
    body: chatCompletionResponse({ content: '', reasoning_content: 'thinking out loud...' }),
  }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });
  const llm = createOpenAILlm(baseConfig, { client });

  await assert.rejects(
    () => llm.complete([{ role: 'user', content: 'q' }]),
    (error: unknown) => {
      assert.ok(error instanceof ModelOutputError);
      assert.match(error.message, /reasoning_content/);
      return true;
    },
  );
});

test('createOpenAILlm rejects with a ModelOutputError for a genuinely empty response', async () => {
  const { fetch } = fakeFetch(() => ({ body: chatCompletionResponse({ content: '' }) }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });
  const llm = createOpenAILlm(baseConfig, { client });

  await assert.rejects(() => llm.complete([{ role: 'user', content: 'q' }]), ModelOutputError);
});

// --- listModels --------------------------------------------------------

test('listModels returns the ids from the models list endpoint', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    body: {
      object: 'list',
      data: [
        { id: 'a', object: 'model', created: 0, owned_by: 'x' },
        { id: 'b', object: 'model', created: 0, owned_by: 'x' },
      ],
    },
  }));
  const client = new OpenAI({ baseURL: baseConfig.baseURL, apiKey: baseConfig.apiKey, fetch });

  const ids = await listModels(baseConfig, { client });

  assert.deepEqual(ids, ['a', 'b']);
  assert.ok(calls[0]?.url.endsWith('/models'));
});
