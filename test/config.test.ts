import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadAuthSettings, loadConfig, loadLimitsSettings, loadTrustProxyHops } from '../src/config.js';

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

// --- AUTH_MODE --------------------------------------------------------------

const cognitoEnv = {
  AUTH_MODE: 'cognito',
  COGNITO_USER_POOL_ID: 'us-east-1_abc123',
  COGNITO_CLIENT_ID: 'client-id-123',
  COGNITO_CLIENT_SECRET: 'client-secret-xyz',
  COGNITO_DOMAIN: 'https://grounded-qa-abc123.auth.us-east-1.amazoncognito.com',
};

test('AUTH_MODE defaults to none when unset outside production', () => {
  assert.deepEqual(loadAuthSettings({}), { mode: 'none' });
});

test('AUTH_MODE unset in production is a ConfigError', () => {
  assert.throws(
    () => loadAuthSettings({ NODE_ENV: 'production' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /AUTH_MODE must be set in production/);
      return true;
    },
  );
});

test('AUTH_MODE=none in production is a ConfigError (fail closed)', () => {
  assert.throws(
    () => loadAuthSettings({ NODE_ENV: 'production', AUTH_MODE: 'none' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /Authentication cannot be disabled in production/);
      return true;
    },
  );
});

test('AUTH_MODE=none outside production returns the none mode', () => {
  assert.deepEqual(loadAuthSettings({ AUTH_MODE: 'none' }), { mode: 'none' });
});

test('rejects an AUTH_MODE value that is neither cognito nor none', () => {
  assert.throws(
    () => loadAuthSettings({ AUTH_MODE: 'oauth' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /"cognito"/);
      assert.match(error.message, /"none"/);
      assert.match(error.message, /oauth/);
      return true;
    },
  );
});

test('AUTH_MODE=cognito with every variable set returns the cognito settings', () => {
  assert.deepEqual(loadAuthSettings(cognitoEnv), {
    mode: 'cognito',
    cognito: {
      userPoolId: 'us-east-1_abc123',
      clientId: 'client-id-123',
      clientSecret: 'client-secret-xyz',
      domain: 'https://grounded-qa-abc123.auth.us-east-1.amazoncognito.com',
    },
  });
});

test('names every missing cognito variable in one error', () => {
  const { COGNITO_CLIENT_SECRET: _secret, COGNITO_DOMAIN: _domain, ...partial } = cognitoEnv;
  assert.throws(
    () => loadAuthSettings(partial),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /COGNITO_CLIENT_SECRET/);
      assert.match(error.message, /COGNITO_DOMAIN/);
      assert.doesNotMatch(error.message, /COGNITO_USER_POOL_ID/);
      return true;
    },
  );
});

test('rejects a COGNITO_DOMAIN that is not https', () => {
  assert.throws(
    () => loadAuthSettings({ ...cognitoEnv, COGNITO_DOMAIN: 'http://insecure.example.com' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /COGNITO_DOMAIN/);
      assert.match(error.message, /https/);
      return true;
    },
  );
});

test('rejects a COGNITO_DOMAIN that is not a valid URL', () => {
  assert.throws(
    () => loadAuthSettings({ ...cognitoEnv, COGNITO_DOMAIN: 'not a url' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /COGNITO_DOMAIN/);
      return true;
    },
  );
});

// --- Limits -------------------------------------------------------------------

test('limits default to safe values when unset', () => {
  assert.deepEqual(loadLimitsSettings({}), {
    askPerMinute: 20,
    dailyAskLimit: 500,
    uploadsPerHour: 10,
    deletesPerHour: 30,
    maxDocuments: 20,
    maxPdfPages: 100,
    maxTotalChunks: 3000,
    pdfParseTimeoutMs: 15000,
  });
});

test('limits read custom positive integers from the environment', () => {
  assert.deepEqual(
    loadLimitsSettings({
      RATE_LIMIT_ASK_PER_MINUTE: '5',
      DAILY_ASK_LIMIT: '50',
      RATE_LIMIT_UPLOADS_PER_HOUR: '2',
      RATE_LIMIT_DELETES_PER_HOUR: '3',
      MAX_DOCUMENTS: '4',
      MAX_PDF_PAGES: '10',
      MAX_TOTAL_CHUNKS: '100',
      PDF_PARSE_TIMEOUT_MS: '1000',
    }),
    {
      askPerMinute: 5,
      dailyAskLimit: 50,
      uploadsPerHour: 2,
      deletesPerHour: 3,
      maxDocuments: 4,
      maxPdfPages: 10,
      maxTotalChunks: 100,
      pdfParseTimeoutMs: 1000,
    },
  );
});

test('rejects a non-positive-integer limit value, naming the variable', () => {
  assert.throws(
    () => loadLimitsSettings({ MAX_DOCUMENTS: '0' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /MAX_DOCUMENTS/);
      return true;
    },
  );
  assert.throws(() => loadLimitsSettings({ RATE_LIMIT_ASK_PER_MINUTE: '-1' }), /RATE_LIMIT_ASK_PER_MINUTE/);
  assert.throws(() => loadLimitsSettings({ DAILY_ASK_LIMIT: 'abc' }), /DAILY_ASK_LIMIT/);
  assert.throws(() => loadLimitsSettings({ MAX_PDF_PAGES: '1.5' }), /MAX_PDF_PAGES/);
});

// --- TRUST_PROXY_HOPS -----------------------------------------------------------

test('TRUST_PROXY_HOPS defaults to 0', () => {
  assert.equal(loadTrustProxyHops({}), 0);
});

test('TRUST_PROXY_HOPS reads a configured hop count', () => {
  assert.equal(loadTrustProxyHops({ TRUST_PROXY_HOPS: '1' }), 1);
});

test('TRUST_PROXY_HOPS rejects a negative or non-integer value', () => {
  assert.throws(() => loadTrustProxyHops({ TRUST_PROXY_HOPS: '-1' }), /TRUST_PROXY_HOPS/);
  assert.throws(() => loadTrustProxyHops({ TRUST_PROXY_HOPS: 'abc' }), /TRUST_PROXY_HOPS/);
});
