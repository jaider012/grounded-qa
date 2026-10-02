import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type express from 'express';
import { createApp } from '../src/app.js';
import { VectorStore } from '../src/store.js';
import { createAuth } from '../src/auth.js';
import type { CognitoVerifier } from '../src/auth.js';
import type { CognitoSettings } from '../src/config.js';
import { bagOfWordsEmbedder, scriptedLlm } from './helpers.js';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const refusal = () => JSON.stringify({ answerable: false, answer: '', citations: [] });

const FAKE_COGNITO: CognitoSettings = {
  userPoolId: 'us-east-1_test123',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  domain: 'https://fake-domain.auth.us-east-1.amazoncognito.com',
};

interface FakeClaims {
  sub: string;
  email?: string;
  groups: string[];
}

/** A `CognitoVerifier` fake: looks up the raw "token" string in a map, never parses a real JWT. */
function fakeVerifier(map: Record<string, FakeClaims>): CognitoVerifier {
  return {
    async verify(idToken: string): Promise<FakeClaims> {
      const claims = map[idToken];
      if (!claims) throw new Error('invalid or expired token');
      return claims;
    },
  };
}

function sessionCookieHeader(token: string): string {
  return `gqa_session=${token}`;
}

function buildAuthApp(
  options: {
    verifierMap?: Record<string, FakeClaims>;
    fetchImpl?: typeof fetch;
    isProduction?: boolean;
    trustProxyHops?: number;
  } = {},
): express.Express {
  const auth = createAuth({
    mode: 'cognito',
    cognito: FAKE_COGNITO,
    verifier: fakeVerifier(options.verifierMap ?? {}),
    fetchFn: options.fetchImpl ?? ((async () => { throw new Error('fetch should not be called in this test'); }) as typeof fetch),
    isProduction: options.isProduction ?? false,
    log: () => {
      // Keep test output quiet.
    },
  });

  const store = new VectorStore(bagOfWordsEmbedder());
  const app = createApp({
    store,
    llm: scriptedLlm(refusal),
    auth,
    log: () => {
      // Keep test output quiet: these tests intentionally trigger error paths.
    },
  });

  if (options.trustProxyHops !== undefined) {
    app.set('trust proxy', options.trustProxyHops);
  }

  return app;
}

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

function findCookie(headers: Headers, name: string): string | undefined {
  return headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

// --- GET /auth/login ---------------------------------------------------------

test('GET /auth/login redirects to the Cognito authorize endpoint with state and a PKCE S256 challenge', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    assert.equal(response.status, 302);

    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(`${location.protocol}//${location.host}`, FAKE_COGNITO.domain);
    assert.equal(location.pathname, '/oauth2/authorize');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), FAKE_COGNITO.clientId);
    assert.equal(location.searchParams.get('redirect_uri'), `${baseUrl}/auth/callback`);
    assert.equal(location.searchParams.get('scope'), 'openid email');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');

    const state = location.searchParams.get('state');
    const codeChallenge = location.searchParams.get('code_challenge');
    assert.ok(state && state.length >= 32, 'state should be a long random token');
    assert.ok(codeChallenge, 'a code_challenge should be present');

    const oauthCookie = findCookie(response.headers, 'gqa_oauth');
    assert.ok(oauthCookie);
    assert.match(oauthCookie, /HttpOnly/);
    assert.match(oauthCookie, /SameSite=Lax/);
    assert.doesNotMatch(oauthCookie, /Secure/);

    const cookieValue = decodeURIComponent(oauthCookie.split(';')[0]!.split('=').slice(1).join('='));
    const [cookieState, codeVerifier] = cookieValue.split('.');
    assert.equal(cookieState, state);
    const expectedChallenge = createHash('sha256').update(codeVerifier ?? '').digest('base64url');
    assert.equal(codeChallenge, expectedChallenge, 'the challenge must match SHA-256(code_verifier)');
  } finally {
    await closeServer(server);
  }
});

test('GET /auth/login uses the forwarded host and protocol for redirect_uri behind a trusted proxy', async () => {
  const app = buildAuthApp({ trustProxyHops: 1 });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'grounded-qa.example.com' },
    });
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://grounded-qa.example.com/auth/callback');
  } finally {
    await closeServer(server);
  }
});

// --- GET /auth/callback -------------------------------------------------------

test('GET /auth/callback returns 400 when state does not match the cookie', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const oauthCookie = findCookie(loginResponse.headers, 'gqa_oauth')!.split(';')[0]!;

    const response = await fetch(`${baseUrl}/auth/callback?code=abc&state=wrong-state`, {
      headers: { cookie: oauthCookie },
      redirect: 'manual',
    });

    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /href="\/auth\/login"/);
  } finally {
    await closeServer(server);
  }
});

test('GET /auth/callback returns 400 when there is no state cookie at all', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/auth/callback?code=abc&state=anything`, { redirect: 'manual' });
    assert.equal(response.status, 400);
  } finally {
    await closeServer(server);
  }
});

test('GET /auth/callback exchanges the code with the right request shape and signs the user in', async () => {
  const calls: Array<{ url: string; init: NonNullable<Parameters<typeof fetch>[1]> }> = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ id_token: 'id-token-value', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const app = buildAuthApp({
    fetchImpl: fakeFetch,
    verifierMap: { 'id-token-value': { sub: 'user-1', email: 'user1@example.com', groups: [] } },
  });
  const { server, baseUrl } = await listen(app);
  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const location = new URL(loginResponse.headers.get('location') ?? '');
    const state = location.searchParams.get('state')!;
    const oauthCookie = findCookie(loginResponse.headers, 'gqa_oauth')!.split(';')[0]!;

    const callbackResponse = await fetch(`${baseUrl}/auth/callback?code=auth-code-xyz&state=${state}`, {
      headers: { cookie: oauthCookie },
      redirect: 'manual',
    });

    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get('location'), '/');

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${FAKE_COGNITO.domain}/oauth2/token`);
    assert.equal(call.init.method, 'POST');

    const headers = new Headers(call.init.headers as Record<string, string>);
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    const expectedBasicAuth = `Basic ${Buffer.from(`${FAKE_COGNITO.clientId}:${FAKE_COGNITO.clientSecret}`).toString('base64')}`;
    assert.equal(headers.get('authorization'), expectedBasicAuth);

    const body = new URLSearchParams(call.init.body as string);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_id'), FAKE_COGNITO.clientId);
    assert.equal(body.get('code'), 'auth-code-xyz');
    assert.equal(body.get('redirect_uri'), `${baseUrl}/auth/callback`);
    assert.ok(body.get('code_verifier'), 'the original PKCE code_verifier must be sent back');

    const sessionCookie = findCookie(callbackResponse.headers, 'gqa_session');
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Lax/);
    assert.match(sessionCookie, /Max-Age=3600/);
    assert.doesNotMatch(sessionCookie, /Secure/);

    const clearedOauthCookie = findCookie(callbackResponse.headers, 'gqa_oauth');
    assert.ok(clearedOauthCookie);
    assert.match(clearedOauthCookie, /Max-Age=0/);
  } finally {
    await closeServer(server);
  }
});

test('the session cookie gets the Secure flag when the request is https (behind trust proxy)', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ id_token: 'secure-token', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const app = buildAuthApp({
    fetchImpl: fakeFetch,
    verifierMap: { 'secure-token': { sub: 'user-1', groups: [] } },
    trustProxyHops: 1,
  });
  const { server, baseUrl } = await listen(app);
  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https' },
    });
    const location = new URL(loginResponse.headers.get('location') ?? '');
    const state = location.searchParams.get('state')!;
    const oauthCookie = findCookie(loginResponse.headers, 'gqa_oauth')!.split(';')[0]!;

    const callbackResponse = await fetch(`${baseUrl}/auth/callback?code=xyz&state=${state}`, {
      headers: { cookie: oauthCookie, 'x-forwarded-proto': 'https' },
      redirect: 'manual',
    });

    const sessionCookie = findCookie(callbackResponse.headers, 'gqa_session');
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /Secure/);
  } finally {
    await closeServer(server);
  }
});

test('GET /auth/callback returns 401 when the token endpoint fails', async () => {
  const fakeFetch = (async () => new Response('error', { status: 400 })) as typeof fetch;
  const app = buildAuthApp({ fetchImpl: fakeFetch });
  const { server, baseUrl } = await listen(app);
  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const location = new URL(loginResponse.headers.get('location') ?? '');
    const state = location.searchParams.get('state')!;
    const oauthCookie = findCookie(loginResponse.headers, 'gqa_oauth')!.split(';')[0]!;

    const response = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, {
      headers: { cookie: oauthCookie },
      redirect: 'manual',
    });

    assert.equal(response.status, 401);
    const text = await response.text();
    assert.match(text, /Sign-in failed/);
  } finally {
    await closeServer(server);
  }
});

test('GET /auth/callback returns 401 when the returned id_token fails verification', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ id_token: 'not-in-the-map', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const app = buildAuthApp({ fetchImpl: fakeFetch });
  const { server, baseUrl } = await listen(app);
  try {
    const loginResponse = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const location = new URL(loginResponse.headers.get('location') ?? '');
    const state = location.searchParams.get('state')!;
    const oauthCookie = findCookie(loginResponse.headers, 'gqa_oauth')!.split(';')[0]!;

    const response = await fetch(`${baseUrl}/auth/callback?code=abc&state=${state}`, {
      headers: { cookie: oauthCookie },
      redirect: 'manual',
    });

    assert.equal(response.status, 401);
  } finally {
    await closeServer(server);
  }
});

// --- GET /auth/logout ----------------------------------------------------------

test('GET /auth/logout clears the session cookie and redirects to the Cognito logout URL', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/auth/logout`, { redirect: 'manual' });
    assert.equal(response.status, 302);

    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(`${location.protocol}//${location.host}${location.pathname}`, `${FAKE_COGNITO.domain}/logout`);
    assert.equal(location.searchParams.get('client_id'), FAKE_COGNITO.clientId);
    assert.equal(location.searchParams.get('logout_uri'), `${baseUrl}/`);

    const clearedSession = findCookie(response.headers, 'gqa_session');
    assert.ok(clearedSession);
    assert.match(clearedSession, /Max-Age=0/);
  } finally {
    await closeServer(server);
  }
});

// --- Protection ----------------------------------------------------------------

test('an unauthenticated request to a protected API route gets 401 JSON', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/documents`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Sign in to continue.' });
  } finally {
    await closeServer(server);
  }
});

test('an unauthenticated request to a non-API page redirects to /auth/login', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/auth/login');
  } finally {
    await closeServer(server);
  }
});

test('GET /healthz is reachable without authentication', async () => {
  const app = buildAuthApp();
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    await closeServer(server);
  }
});

test('an invalid or expired session cookie is treated as unauthenticated and cleared', async () => {
  const app = buildAuthApp(); // empty verifier map => verify() always rejects
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/documents`, {
      headers: { cookie: sessionCookieHeader('some-expired-token') },
    });
    assert.equal(response.status, 401);
    const cleared = findCookie(response.headers, 'gqa_session');
    assert.ok(cleared);
    assert.match(cleared, /Max-Age=0/);
  } finally {
    await closeServer(server);
  }
});

// --- Admin-only routes -----------------------------------------------------------

test('a signed-in non-admin gets 403 on POST /api/documents and DELETE /api/documents/:name', async () => {
  const app = buildAuthApp({ verifierMap: { 'user-token': { sub: 'user-1', groups: [] } } });
  const { server, baseUrl } = await listen(app);
  try {
    const uploadResponse = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { cookie: sessionCookieHeader('user-token') },
      body: new FormData(),
    });
    assert.equal(uploadResponse.status, 403);
    assert.deepEqual(await uploadResponse.json(), { error: 'Only administrators can add or remove documents.' });

    const deleteResponse = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('x.pdf')}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookieHeader('user-token') },
    });
    assert.equal(deleteResponse.status, 403);
  } finally {
    await closeServer(server);
  }
});

test('a signed-in admin can upload and delete documents', async () => {
  const app = buildAuthApp({ verifierMap: { 'admin-token': { sub: 'admin-1', groups: ['admins'] } } });
  const { server, baseUrl } = await listen(app);
  try {
    const pdfBytes = await readFile(fixturePath('catering-guide.pdf'));
    const form = new FormData();
    form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'catering-guide.pdf');

    const uploadResponse = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { cookie: sessionCookieHeader('admin-token') },
      body: form,
    });
    assert.equal(uploadResponse.status, 201);

    const deleteResponse = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('catering-guide.pdf')}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookieHeader('admin-token') },
    });
    assert.equal(deleteResponse.status, 200);
  } finally {
    await closeServer(server);
  }
});

// --- CSRF (cross-site Origin) ------------------------------------------------------

test('a cross-site Origin on a mutating /api request is blocked with 403', async () => {
  const app = buildAuthApp({ verifierMap: { 'admin-token': { sub: 'admin-1', groups: ['admins'] } } });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('x.pdf')}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookieHeader('admin-token'), origin: 'https://evil.example.com' },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Cross-site request blocked.' });
  } finally {
    await closeServer(server);
  }
});

test('a same-site Origin on a mutating /api request is allowed through', async () => {
  const app = buildAuthApp({ verifierMap: { 'admin-token': { sub: 'admin-1', groups: ['admins'] } } });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('nonexistent.pdf')}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookieHeader('admin-token'), origin: baseUrl },
    });
    // 404 (not 403) proves the CSRF check let a same-site Origin through to the route.
    assert.equal(response.status, 404);
  } finally {
    await closeServer(server);
  }
});

test('a missing Origin on a mutating /api request is allowed through', async () => {
  const app = buildAuthApp({ verifierMap: { 'admin-token': { sub: 'admin-1', groups: ['admins'] } } });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('nonexistent.pdf')}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookieHeader('admin-token') },
    });
    assert.equal(response.status, 404);
  } finally {
    await closeServer(server);
  }
});

// --- GET /api/me -----------------------------------------------------------------

test('GET /api/me reports the authenticated user in cognito mode', async () => {
  const app = buildAuthApp({
    verifierMap: { 'user-token': { sub: 'user-1', email: 'user1@example.com', groups: [] } },
  });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/me`, { headers: { cookie: sessionCookieHeader('user-token') } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { email: 'user1@example.com', isAdmin: false, authMode: 'cognito' });
  } finally {
    await closeServer(server);
  }
});

// --- AUTH_MODE=none --------------------------------------------------------------

test('createApp without an auth dependency behaves as a synthetic, unprotected local admin', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  const app = createApp({
    store,
    llm: scriptedLlm(refusal),
    log: () => {
      // Keep test output quiet.
    },
  });
  const { server, baseUrl } = await listen(app);
  try {
    const me = await fetch(`${baseUrl}/api/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { email: 'local', isAdmin: true, authMode: 'none' });

    const documents = await fetch(`${baseUrl}/api/documents`);
    assert.equal(documents.status, 200);
  } finally {
    await closeServer(server);
  }
});

test('AUTH_MODE=none logs exactly one startup warning', () => {
  const messages: string[] = [];
  createAuth({ mode: 'none', log: (message) => messages.push(message) });
  assert.deepEqual(messages, ['Authentication disabled (AUTH_MODE=none)']);
});
