import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';

const complete = {
  LLM_BASE_URL: 'http://localhost:1234/v1',
  LLM_API_KEY: 'lm-studio',
  LLM_MODEL: 'google/gemma-4-e4b',
  LLM_JSON_MODE: 'json_schema',
  EMBEDDING_BASE_URL: 'http://localhost:1234/v1',
  EMBEDDING_API_KEY: 'lm-studio',
  EMBEDDING_MODEL: 'text-embedding-nomic-embed-text-v1.5',
};

test('builds the provider config from a complete environment', () => {
  assert.deepEqual(loadConfig(complete), {
    llm: {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'google/gemma-4-e4b',
      jsonMode: 'json_schema',
      extraBody: {},
    },
    embedding: {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'text-embedding-nomic-embed-text-v1.5',
    },
    port: 3000,
  });
});

test('names every missing variable in one error', () => {
  const { LLM_MODEL: _model, EMBEDDING_API_KEY: _key, ...partial } = complete;
  assert.throws(
    () => loadConfig(partial),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /LLM_MODEL/);
      assert.match(error.message, /EMBEDDING_API_KEY/);
      assert.match(error.message, /\.env\.example/);
      return true;
    },
  );
});

test('treats blank values as missing', () => {
  assert.throws(() => loadConfig({ ...complete, LLM_API_KEY: '   ' }), /LLM_API_KEY/);
});

test('rejects an unknown JSON mode', () => {
  assert.throws(
    () => loadConfig({ ...complete, LLM_JSON_MODE: 'json' }),
    /LLM_JSON_MODE must be "json_schema" or "json_object"/,
  );
});

test('parses LLM_EXTRA_BODY as a JSON object', () => {
  const config = loadConfig({ ...complete, LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' });
  assert.deepEqual(config.llm.extraBody, { thinking: { type: 'disabled' } });
});

test('rejects an LLM_EXTRA_BODY that is not a JSON object', () => {
  assert.throws(() => loadConfig({ ...complete, LLM_EXTRA_BODY: '[1, 2]' }), /LLM_EXTRA_BODY must be a JSON object/);
  assert.throws(() => loadConfig({ ...complete, LLM_EXTRA_BODY: '{not json' }), /LLM_EXTRA_BODY must be a JSON object/);
});

test('reads PORT and rejects values that are not a port number', () => {
  assert.equal(loadConfig({ ...complete, PORT: '10000' }).port, 10000);
  assert.throws(() => loadConfig({ ...complete, PORT: 'abc' }), /PORT must be an integer/);
});
