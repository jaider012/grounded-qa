import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import type { Server } from 'node:http';
import type express from 'express';
import { createApp } from '../src/app.js';
import { VectorStore } from '../src/store.js';
import { createLimits } from '../src/limits.js';
import { DEFAULT_LIMITS } from '../src/config.js';
import type { Auth } from '../src/auth.js';
import { bagOfWordsEmbedder, scriptedLlm } from './helpers.js';

// Verifies that `createApp`'s `trustProxyHops` dependency is wired into the
// Express app *before* the rate limiters run, exactly like `TRUST_PROXY_HOPS`
// behaves in production behind App Runner: trusting one hop makes
// `X-Forwarded-For` drive `req.ip`, so the per-IP ask limiter keys requests
// on the forwarded client address instead of the test client's own socket.
//
// The default `AUTH_MODE=none` auth attaches a synthetic admin (same `sub`
// for every request) which `limits.ts`'s keyGenerator prefers over the IP,
// so it would mask the very IP-keying behavior under test here. This stub
// auth leaves `req.auth` unset, like an unauthenticated request, so the
// limiter actually falls back to `req.ip`.
const noIdentityAuth: Auth = { mode: 'none', router: Router() };

const refusal = () => JSON.stringify({ answerable: false, answer: '', citations: [] });

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

function buildApp(trustProxyHops?: number): express.Express {
  const store = new VectorStore(bagOfWordsEmbedder());
  const limits = createLimits({ ...DEFAULT_LIMITS, askPerMinute: 1 });
  return createApp({
    store,
    llm: scriptedLlm(refusal),
    limits,
    trustProxyHops,
    auth: noIdentityAuth,
    log: () => {
      // Keep test output quiet.
    },
  });
}

function ask(baseUrl: string, forwardedFor?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: JSON.stringify({ question: 'Are you open on Mondays?' }),
  });
}

test('trustProxyHops is applied to the Express "trust proxy" setting', () => {
  assert.equal(buildApp(1).get('trust proxy'), 1);
});

test('an unset trustProxyHops does not trust any proxy (current behavior)', () => {
  assert.equal(buildApp().get('trust proxy'), 0);
});

test('without a trusted proxy hop, two different X-Forwarded-For values share one quota (req.ip is the test socket)', async () => {
  const app = buildApp();
  const { server, baseUrl } = await listen(app);
  try {
    const first = await ask(baseUrl, '203.0.113.1');
    const second = await ask(baseUrl, '203.0.113.2');
    assert.equal(first.status, 200);
    assert.equal(second.status, 429, 'both requests arrive from the same unproxied socket, so they share one quota');
  } finally {
    await closeServer(server);
  }
});

test('TRUST_PROXY_HOPS=1 makes X-Forwarded-For drive req.ip, giving each forwarded address its own quota', async () => {
  const app = buildApp(1);
  const { server, baseUrl } = await listen(app);
  try {
    const first = await ask(baseUrl, '203.0.113.1');
    const second = await ask(baseUrl, '203.0.113.2');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'a different forwarded address gets its own quota once the proxy hop is trusted');

    const third = await ask(baseUrl, '203.0.113.1');
    assert.equal(third.status, 429, 'repeating the first forwarded address hits its own quota');
  } finally {
    await closeServer(server);
  }
});
