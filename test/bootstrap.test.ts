import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type express from 'express';
import { loadRuntimeDeps } from '../src/bootstrap.js';
import { ConfigError } from '../src/config.js';
import { createApp } from '../src/app.js';
import { VectorStore } from '../src/store.js';
import { bagOfWordsEmbedder, scriptedLlm } from './helpers.js';

const refusal = () => JSON.stringify({ answerable: false, answer: '', citations: [] });

const cognitoEnv = {
  AUTH_MODE: 'cognito',
  COGNITO_USER_POOL_ID: 'us-east-1_abc123',
  COGNITO_CLIENT_ID: 'client-id-123',
  COGNITO_CLIENT_SECRET: 'client-secret-xyz',
  COGNITO_DOMAIN: 'https://grounded-qa-abc123.auth.us-east-1.amazoncognito.com',
};

function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected the test server to report a network address.');
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// --- Fail-closed in production ------------------------------------------------

test('loadRuntimeDeps throws ConfigError when AUTH_MODE is unset in production', () => {
  assert.throws(
    () => loadRuntimeDeps({ NODE_ENV: 'production' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /AUTH_MODE must be set in production/);
      return true;
    },
  );
});

test('loadRuntimeDeps throws ConfigError when AUTH_MODE=none in production', () => {
  assert.throws(
    () => loadRuntimeDeps({ NODE_ENV: 'production', AUTH_MODE: 'none' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /Authentication cannot be disabled in production/);
      return true;
    },
  );
});

// --- AUTH_MODE=cognito wiring --------------------------------------------------

test('loadRuntimeDeps with AUTH_MODE=cognito and every COGNITO_* variable builds a cognito auth', () => {
  const deps = loadRuntimeDeps(cognitoEnv, {
    log: () => {
      // Keep test output quiet.
    },
  });
  assert.equal(deps.auth.mode, 'cognito');
});

test('an unauthenticated POST /api/ask through the cognito auth built by loadRuntimeDeps returns 401, not an answer', async () => {
  const deps = loadRuntimeDeps(cognitoEnv, {
    log: () => {
      // Keep test output quiet.
    },
  });
  const store = new VectorStore(bagOfWordsEmbedder());
  const app = createApp({
    store,
    llm: scriptedLlm(refusal),
    auth: deps.auth,
    limits: deps.limits,
    log: () => {
      // Keep test output quiet: this test intentionally triggers an error path.
    },
  });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Are you open on Mondays?' }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Sign in to continue.' });
  } finally {
    await closeServer(server);
  }
});

// --- TRUST_PROXY_HOPS wiring ----------------------------------------------------

test('loadRuntimeDeps defaults trustProxyHops to 0 when TRUST_PROXY_HOPS is unset', () => {
  const deps = loadRuntimeDeps({ AUTH_MODE: 'none' });
  assert.equal(deps.trustProxyHops, 0);
});

test('loadRuntimeDeps reads a configured TRUST_PROXY_HOPS', () => {
  const deps = loadRuntimeDeps({ AUTH_MODE: 'none', TRUST_PROXY_HOPS: '1' });
  assert.equal(deps.trustProxyHops, 1);
});

test('loadRuntimeDeps surfaces an invalid TRUST_PROXY_HOPS as a ConfigError', () => {
  assert.throws(
    () => loadRuntimeDeps({ AUTH_MODE: 'none', TRUST_PROXY_HOPS: '-1' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /TRUST_PROXY_HOPS/);
      return true;
    },
  );
});
