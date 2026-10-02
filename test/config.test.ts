import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';

const openaiCompatibleEnv = {
  LLM_BASE_URL: 'http://localhost:1234/v1',
  LLM_API_KEY: 'lm-studio',
  LLM_MODEL: 'google/gemma-4-e4b',
  EMBEDDING_BASE_URL: 'http://localhost:1234/v1',
  EMBEDDING_API_KEY: 'lm-studio',
  EMBEDDING_MODEL: 'text-embedding-nomic-embed-text-v1.5',
};

const bedrockEnv = {
  PROVIDER: 'bedrock',
  AWS_REGION: 'us-east-1',
  BEDROCK_CHAT_MODEL_ID: 'deepseek.v3.2',
  BEDROCK_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
};

// --- PROVIDER selection --------------------------------------------------------

test('defaults PROVIDER to openai-compatible when unset', () => {
  assert.deepEqual(loadConfig(openaiCompatibleEnv), {
    provider: 'openai-compatible',
    llm: {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'google/gemma-4-e4b',
    },
    embedding: {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'text-embedding-nomic-embed-text-v1.5',
    },
    port: 3000,
  });
});

test('builds the bedrock provider config when PROVIDER=bedrock', () => {
  assert.deepEqual(loadConfig(bedrockEnv), {
    provider: 'bedrock',
    bedrock: {
      region: 'us-east-1',
      chatModelId: 'deepseek.v3.2',
      embeddingModelId: 'amazon.titan-embed-text-v2:0',
    },
    port: 3000,
  });
});

test('rejects a PROVIDER value that is neither openai-compatible nor bedrock', () => {
  assert.throws(
    () => loadConfig({ ...openaiCompatibleEnv, PROVIDER: 'azure' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /"openai-compatible"/);
      assert.match(error.message, /"bedrock"/);
      assert.match(error.message, /azure/);
      return true;
    },
  );
});

// --- openai-compatible missing variables --------------------------------------

test('names every missing openai-compatible variable in one error', () => {
  const { LLM_MODEL: _model, EMBEDDING_API_KEY: _key, ...partial } = openaiCompatibleEnv;
  assert.throws(
    () => loadConfig(partial),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /LLM_MODEL/);
      assert.match(error.message, /EMBEDDING_API_KEY/);
      assert.match(error.message, /openai-compatible/);
      assert.match(error.message, /\.env\.example/);
      return true;
    },
  );
});

test('treats blank values as missing', () => {
  assert.throws(() => loadConfig({ ...openaiCompatibleEnv, LLM_API_KEY: '   ' }), /LLM_API_KEY/);
});

// --- bedrock missing variables -------------------------------------------------

test('names every missing bedrock variable in one error', () => {
  const { AWS_REGION: _region, ...partial } = bedrockEnv;
  assert.throws(
    () => loadConfig(partial),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /AWS_REGION/);
      assert.match(error.message, /bedrock/);
      return true;
    },
  );
});

test('never requires AWS access key variables for the bedrock provider', () => {
  const config = loadConfig(bedrockEnv);
  assert.equal(config.provider, 'bedrock');
  assert.ok(!('AWS_ACCESS_KEY_ID' in bedrockEnv));
});

// --- PORT -----------------------------------------------------------------------

test('reads PORT and rejects values that are not a port number', () => {
  assert.equal(loadConfig({ ...openaiCompatibleEnv, PORT: '10000' }).port, 10000);
  assert.throws(() => loadConfig({ ...openaiCompatibleEnv, PORT: 'abc' }), /PORT must be an integer/);
});
