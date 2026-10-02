import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { VectorStore } from '../src/store.js';
import { createLimits, LimitError } from '../src/limits.js';
import type { LimitsSettings } from '../src/config.js';
import { bagOfWordsEmbedder, scriptedLlm } from './helpers.js';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** `Response.json()` types as `Promise<unknown>` under @types/node; these tests only do loose shape checks. */
async function readJson(response: Response): Promise<any> {
  return response.json();
}

function baseLimits(overrides: Partial<LimitsSettings> = {}): LimitsSettings {
  return {
    askPerMinute: 20,
    dailyAskLimit: 500,
    uploadsPerHour: 10,
    deletesPerHour: 30,
    maxDocuments: 20,
    maxPdfPages: 100,
    maxTotalChunks: 3000,
    pdfParseTimeoutMs: 15000,
    ...overrides,
  };
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

async function makePdfWithPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i += 1) doc.addPage();
  return doc.save();
}

async function uploadPdf(baseUrl: string, bytes: Uint8Array, filename: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  return fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });
}

const refusal = () => JSON.stringify({ answerable: false, answer: '', citations: [] });

function buildApp(overrides: Partial<LimitsSettings> = {}, extraDeps: Partial<AppDeps> = {}): express.Express {
  const store = new VectorStore(bagOfWordsEmbedder());
  const limits = createLimits(baseLimits(overrides));
  return createApp({
    store,
    llm: scriptedLlm(refusal),
    limits,
    log: () => {
      // Keep test output quiet: these tests intentionally trigger error paths.
    },
    ...extraDeps,
  });
}

// --- askLimiter (per-minute) ----------------------------------------------------

test('askLimiter returns 429 with the real wait once the per-minute limit is exceeded', async () => {
  const limits = createLimits(baseLimits({ askPerMinute: 2 }));
  const app = express();
  app.use(limits.askLimiter);
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  const { server, baseUrl } = await listen(app);

  try {
    const first = await fetch(`${baseUrl}/ping`);
    const second = await fetch(`${baseUrl}/ping`);
    const third = await fetch(`${baseUrl}/ping`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    const body = await readJson(third);
    assert.match(body.error, /^Too many requests\. Try again in \d+ seconds\.$/);
    assert.ok(third.headers.get('retry-after'));
  } finally {
    await closeServer(server);
  }
});

test('askLimiter keys quota per authenticated user rather than globally', async () => {
  const limits = createLimits(baseLimits({ askPerMinute: 1 }));
  const app = express();
  app.use((req, _res, next) => {
    const sub = req.headers['x-test-sub'];
    if (typeof sub === 'string') req.auth = { sub, isAdmin: false };
    next();
  });
  app.use(limits.askLimiter);
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  const { server, baseUrl } = await listen(app);

  try {
    const userAFirst = await fetch(`${baseUrl}/ping`, { headers: { 'x-test-sub': 'user-a' } });
    const userASecond = await fetch(`${baseUrl}/ping`, { headers: { 'x-test-sub': 'user-a' } });
    const userBFirst = await fetch(`${baseUrl}/ping`, { headers: { 'x-test-sub': 'user-b' } });

    assert.equal(userAFirst.status, 200);
    assert.equal(userASecond.status, 429, 'a second request from the same user should be throttled');
    assert.equal(userBFirst.status, 200, 'a different user should have their own quota');
  } finally {
    await closeServer(server);
  }
});

// --- uploadLimiter / deleteLimiter (per-hour) ------------------------------------

test('uploadLimiter returns 429 once the per-hour upload limit is exceeded', async () => {
  const limits = createLimits(baseLimits({ uploadsPerHour: 1 }));
  const app = express();
  app.use(limits.uploadLimiter);
  app.post('/upload', (_req, res) => res.status(201).json({ ok: true }));
  const { server, baseUrl } = await listen(app);

  try {
    const first = await fetch(`${baseUrl}/upload`, { method: 'POST' });
    const second = await fetch(`${baseUrl}/upload`, { method: 'POST' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 429);
    const body = await readJson(second);
    assert.match(body.error, /Too many requests/);
  } finally {
    await closeServer(server);
  }
});

test('deleteLimiter returns 429 once the per-hour delete limit is exceeded', async () => {
  const limits = createLimits(baseLimits({ deletesPerHour: 1 }));
  const app = express();
  app.use(limits.deleteLimiter);
  app.delete('/doc/:name', (_req, res) => res.status(200).json({ ok: true }));
  const { server, baseUrl } = await listen(app);

  try {
    const first = await fetch(`${baseUrl}/doc/a`, { method: 'DELETE' });
    const second = await fetch(`${baseUrl}/doc/b`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  } finally {
    await closeServer(server);
  }
});

// --- dailyAskCap (UTC midnight rollover, injected clock) -------------------------

test('dailyAskCap returns 429 once the daily limit is reached, globally across requests', async () => {
  const current = new Date('2026-01-01T10:00:00.000Z');
  const limits = createLimits(baseLimits({ dailyAskLimit: 2 }), { now: () => current });
  const app = express();
  app.use(limits.dailyAskCap);
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  const { server, baseUrl } = await listen(app);

  try {
    const first = await fetch(`${baseUrl}/ping`);
    const second = await fetch(`${baseUrl}/ping`);
    const third = await fetch(`${baseUrl}/ping`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    const body = await readJson(third);
    assert.deepEqual(body, {
      error: 'The daily question limit for this demo has been reached. Try again tomorrow.',
    });
  } finally {
    await closeServer(server);
  }
});

test('dailyAskCap resets at UTC midnight', async () => {
  let current = new Date('2026-01-01T23:59:59.000Z');
  const limits = createLimits(baseLimits({ dailyAskLimit: 1 }), { now: () => current });
  const app = express();
  app.use(limits.dailyAskCap);
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  const { server, baseUrl } = await listen(app);

  try {
    const beforeMidnight = await fetch(`${baseUrl}/ping`);
    assert.equal(beforeMidnight.status, 200);

    const stillBeforeRollover = await fetch(`${baseUrl}/ping`);
    assert.equal(stillBeforeRollover.status, 429);

    current = new Date('2026-01-02T00:00:01.000Z');
    const afterMidnight = await fetch(`${baseUrl}/ping`);
    assert.equal(afterMidnight.status, 200);
  } finally {
    await closeServer(server);
  }
});

// --- assertDocumentCapacity -------------------------------------------------------

test('assertDocumentCapacity throws 409 for a new document at the cap', () => {
  const limits = createLimits(baseLimits({ maxDocuments: 2 }));
  assert.throws(
    () => limits.assertDocumentCapacity({ uploadedCount: 2, isReplacing: false }),
    (error: unknown) => {
      assert.ok(error instanceof LimitError);
      assert.equal(error.status, 409);
      assert.match(error.message, /library is full/);
      assert.match(error.message, /2 documents/);
      return true;
    },
  );
});

test('assertDocumentCapacity allows replacing an existing document at the cap', () => {
  const limits = createLimits(baseLimits({ maxDocuments: 2 }));
  assert.doesNotThrow(() => limits.assertDocumentCapacity({ uploadedCount: 2, isReplacing: true }));
});

test('assertDocumentCapacity allows a new document under the cap', () => {
  const limits = createLimits(baseLimits({ maxDocuments: 2 }));
  assert.doesNotThrow(() => limits.assertDocumentCapacity({ uploadedCount: 1, isReplacing: false }));
});

// --- assertChunkCapacity -----------------------------------------------------------

test('assertChunkCapacity throws 413 when adding would exceed the store-wide cap', () => {
  const limits = createLimits(baseLimits({ maxTotalChunks: 10 }));
  assert.throws(
    () => limits.assertChunkCapacity({ currentTotal: 8, adding: 3 }),
    (error: unknown) => {
      assert.ok(error instanceof LimitError);
      assert.equal(error.status, 413);
      assert.match(error.message, /size limit/);
      return true;
    },
  );
});

test('assertChunkCapacity allows reaching exactly the cap', () => {
  const limits = createLimits(baseLimits({ maxTotalChunks: 10 }));
  assert.doesNotThrow(() => limits.assertChunkCapacity({ currentTotal: 7, adding: 3 }));
});

// --- Wired into the app: uploads --------------------------------------------------

test('POST /api/documents returns 409 at MAX_DOCUMENTS, but replacing the same name is allowed', async () => {
  const app = buildApp({ maxDocuments: 1 });
  const { server, baseUrl } = await listen(app);
  try {
    const bytes = await readFile(fixturePath('catering-guide.pdf'));

    const firstUpload = await uploadPdf(baseUrl, bytes, 'catering-guide.pdf');
    assert.equal(firstUpload.status, 201);

    const replace = await uploadPdf(baseUrl, bytes, 'catering-guide.pdf');
    assert.equal(replace.status, 201);

    const secondDocument = await uploadPdf(baseUrl, bytes, 'other.pdf');
    assert.equal(secondDocument.status, 409);
    const body = await readJson(secondDocument);
    assert.match(body.error, /library is full \(1 document/);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/documents returns 413 when the PDF has more pages than MAX_PDF_PAGES', async () => {
  const app = buildApp({ maxPdfPages: 2 });
  const { server, baseUrl } = await listen(app);
  try {
    const bytes = await makePdfWithPages(5);
    const response = await uploadPdf(baseUrl, bytes, 'big.pdf');
    assert.equal(response.status, 413);
    const body = await readJson(response);
    assert.match(body.error, /5 pages/);
    assert.match(body.error, /limit is 2/);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/documents returns 422 when parsing exceeds PDF_PARSE_TIMEOUT_MS', async () => {
  const app = buildApp(
    { pdfParseTimeoutMs: 5 },
    {
      pdfExtractTextImpl: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ text: ['slow page'] }), 50);
        }),
    },
  );
  const { server, baseUrl } = await listen(app);
  try {
    const bytes = await readFile(fixturePath('catering-guide.pdf'));
    const response = await uploadPdf(baseUrl, bytes, 'slow.pdf');
    assert.equal(response.status, 422);
    const body = await readJson(response);
    assert.match(body.error, /too long/);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/documents returns 413 when adding chunks would exceed MAX_TOTAL_CHUNKS', async () => {
  const app = buildApp({ maxTotalChunks: 1 });
  const { server, baseUrl } = await listen(app);
  try {
    const bytes = await readFile(fixturePath('catering-guide.pdf'));
    const response = await uploadPdf(baseUrl, bytes, 'catering-guide.pdf');
    assert.equal(response.status, 413);
    const body = await readJson(response);
    assert.match(body.error, /size limit/);
  } finally {
    await closeServer(server);
  }
});
