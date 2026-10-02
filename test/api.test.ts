import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { VectorStore } from '../src/store.js';
import { FAQ_SOURCE, faqChunks } from '../src/faq.js';
import type { Llm } from '../src/llm.js';
import { bagOfWordsEmbedder, parsePassagesFromUserMessage, scriptedLlm } from './helpers.js';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/**
 * Node's `@types/node` types `Response.json()` as `Promise<unknown>`
 * (stricter than the DOM lib's `any`); these tests only do loose shape
 * assertions on the parsed body, so a small helper keeps every call site
 * from repeating the same narrowing.
 */
async function readJson(response: Response): Promise<any> {
  return response.json();
}

function sentenceContaining(text: string, keyword: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const found = sentences.find((sentence) => sentence.toLowerCase().includes(keyword.toLowerCase()));
  if (found === undefined) {
    throw new Error(`No sentence containing "${keyword}" found in: ${text}`);
  }
  return found.trim();
}

const refusalResponse = () => JSON.stringify({ answerable: false, answer: '', citations: [] });

let server: Server;
let baseUrl: string;
let currentLlm: Llm = scriptedLlm(refusalResponse);

before(async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument(FAQ_SOURCE, faqChunks());

  const app = createApp({
    store,
    llm: { complete: (messages) => currentLlm.complete(messages) },
    protectedDocuments: [FAQ_SOURCE],
    log: () => {
      // Keep test output quiet: these tests intentionally trigger error paths.
    },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to report a network address.');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

// --- /healthz ----------------------------------------------------------------

test('GET /healthz reports status ok and a document count', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.documents, 'number');
  assert.ok(body.documents >= 1);
});

test('GET /healthz reports the configured provider', async () => {
  const providerStore = new VectorStore(bagOfWordsEmbedder());
  await providerStore.addDocument(FAQ_SOURCE, faqChunks());
  const providerApp = createApp({
    store: providerStore,
    llm: scriptedLlm(refusalResponse),
    provider: 'bedrock',
    log: () => {
      // Keep test output quiet.
    },
  });

  const providerServer = providerApp.listen(0);
  try {
    await new Promise<void>((resolve) => providerServer.once('listening', () => resolve()));
    const address = providerServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the test server to report a network address.');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    const body = await readJson(response);
    assert.equal(body.provider, 'bedrock');
  } finally {
    await new Promise<void>((resolve, reject) => {
      providerServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('responses include the security headers', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-powered-by'), null);
});

// --- Upload, list, and ask a grounded question --------------------------------

test('uploads a PDF, lists it, and answers a question grounded in it', async () => {
  const pdfBytes = await readFile(fixturePath('catering-guide.pdf'));
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'catering-guide.pdf');

  const uploadResponse = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: uploadForm });
  assert.equal(uploadResponse.status, 201);
  const uploadBody = await readJson(uploadResponse);
  assert.deepEqual(uploadBody, { document: { name: 'catering-guide.pdf', chunks: 2 } });

  const listResponse = await fetch(`${baseUrl}/api/documents`);
  assert.equal(listResponse.status, 200);
  const listBody = await readJson(listResponse);
  assert.deepEqual(listBody.documents, [
    { name: FAQ_SOURCE, chunks: 7, builtIn: true },
    { name: 'catering-guide.pdf', chunks: 2, builtIn: false },
  ]);

  currentLlm = scriptedLlm((messages) => {
    const passages = parsePassagesFromUserMessage(messages);
    const depositPassage = passages.find((passage) => passage.text.toLowerCase().includes('deposit'));
    if (depositPassage === undefined) {
      throw new Error('Expected a retrieved passage mentioning "deposit".');
    }
    const quote = sentenceContaining(depositPassage.text, 'deposit');
    return JSON.stringify({
      answerable: true,
      answer: 'A 30 percent deposit confirms a catering order.',
      citations: [{ passage_id: depositPassage.id, quote }],
    });
  });

  const askResponse = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'How much deposit confirms a catering order?' }),
  });
  assert.equal(askResponse.status, 200);
  const askBody = await readJson(askResponse);
  assert.equal(askBody.answerable, true);
  assert.equal(askBody.citations.length, 1);
  assert.equal(askBody.citations[0].source, 'catering-guide.pdf');
  assert.equal(askBody.citations[0].location, 'page 2');
  assert.ok(Array.isArray(askBody.retrieved));
});

// --- Upload validation ---------------------------------------------------------

test('rejects a non-PDF upload with 415', async () => {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new TextEncoder().encode('just some plain text, not a pdf')], { type: 'application/pdf' }),
    'fake.pdf',
  );

  const response = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });

  assert.equal(response.status, 415);
  const body = await readJson(response);
  assert.match(body.error, /PDF signature/);
});

test('rejects a scanned PDF with 422 and an OCR hint', async () => {
  const pdfBytes = await readFile(fixturePath('scanned.pdf'));
  const form = new FormData();
  form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'scanned.pdf');

  const response = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });

  assert.equal(response.status, 422);
  const body = await readJson(response);
  assert.match(body.error, /OCR/);
});

test('rejects an upload larger than 10 MB with 413', async () => {
  const oversized = new Uint8Array(11 * 1024 * 1024);
  oversized.set(new TextEncoder().encode('%PDF-1.7'), 0);
  const form = new FormData();
  form.append('file', new Blob([oversized], { type: 'application/pdf' }), 'big.pdf');

  const response = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });

  assert.equal(response.status, 413);
  const body = await readJson(response);
  assert.match(body.error, /10 MB/);
});

test('rejects an upload with no file attached with 400', async () => {
  const form = new FormData();
  form.append('note', 'no file here');

  const response = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.match(body.error, /Attach a PDF/);
});

test('keeps accents in a UTF-8 file name', async () => {
  const pdfBytes = await readFile(fixturePath('catering-guide.pdf'));
  const form = new FormData();
  form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'café specials.pdf');

  const response = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form });

  assert.equal(response.status, 201);
  const body = await readJson(response);
  assert.equal(body.document.name, 'café specials.pdf');
});

// --- Deleting documents ---------------------------------------------------------

test('DELETE /api/documents/:name removes an uploaded document', async () => {
  const pdfBytes = await readFile(fixturePath('catering-guide.pdf'));
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'catering-guide.pdf');
  const uploadResponse = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: uploadForm });
  assert.equal(uploadResponse.status, 201);

  const deleteResponse = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('catering-guide.pdf')}`, {
    method: 'DELETE',
  });

  assert.equal(deleteResponse.status, 200);
  const deleteBody = await readJson(deleteResponse);
  assert.equal(deleteBody.removed, 'catering-guide.pdf');
  assert.ok(!deleteBody.documents.some((doc: { name: string }) => doc.name === 'catering-guide.pdf'));

  const listResponse = await fetch(`${baseUrl}/api/documents`);
  const listBody = await readJson(listResponse);
  assert.ok(!listBody.documents.some((doc: { name: string }) => doc.name === 'catering-guide.pdf'));
});

test('DELETE /api/documents/:name deletes a name with spaces and accents via encodeURIComponent', async () => {
  const pdfBytes = await readFile(fixturePath('catering-guide.pdf'));
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'café specials.pdf');
  const uploadResponse = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: uploadForm });
  assert.equal(uploadResponse.status, 201);

  const deleteResponse = await fetch(
    `${baseUrl}/api/documents/${encodeURIComponent('café specials.pdf')}`,
    { method: 'DELETE' },
  );

  assert.equal(deleteResponse.status, 200);
  const deleteBody = await readJson(deleteResponse);
  assert.equal(deleteBody.removed, 'café specials.pdf');
});

test('DELETE /api/documents/:name returns 404 for an unknown document', async () => {
  const response = await fetch(`${baseUrl}/api/documents/${encodeURIComponent('nonexistent.pdf')}`, {
    method: 'DELETE',
  });

  assert.equal(response.status, 404);
  const body = await readJson(response);
  assert.match(body.error, /No document named "nonexistent\.pdf" is loaded/);
});

test('DELETE /api/documents/:name returns 403 for the built-in FAQ', async () => {
  const response = await fetch(`${baseUrl}/api/documents/${encodeURIComponent(FAQ_SOURCE)}`, {
    method: 'DELETE',
  });

  assert.equal(response.status, 403);
  const body = await readJson(response);
  assert.deepEqual(body, { error: 'The built-in FAQ cannot be removed.' });
});

// --- Ask validation ---------------------------------------------------------

test('rejects an empty question with 400', async () => {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '' }),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.match(body.error, /Type a question/);
});

test('rejects a whitespace-only question with 400', async () => {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '   \n\t  ' }),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.match(body.error, /Type a question/);
});

test('rejects a question over 500 characters with 400', async () => {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'a'.repeat(501) }),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.match(body.error, /500 characters/);
});

test('rejects a request missing the question field with 400', async () => {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.match(body.error, /Send JSON/);
});

test('rejects a malformed JSON body with 400', async () => {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.match(body.error, /Send JSON/);
});

test('returns 502 when the model never returns valid JSON', async () => {
  currentLlm = scriptedLlm(() => 'not json');

  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Are you open on Mondays?' }),
  });

  assert.equal(response.status, 502);
  const body = await readJson(response);
  assert.match(body.error, /unreadable answer/);

  currentLlm = scriptedLlm(refusalResponse);
});

// --- Unknown routes ---------------------------------------------------------

test('returns 404 JSON for an unknown /api route', async () => {
  const response = await fetch(`${baseUrl}/api/x`);
  assert.equal(response.status, 404);
  const body = await readJson(response);
  assert.deepEqual(body, { error: 'Not found.' });
});
