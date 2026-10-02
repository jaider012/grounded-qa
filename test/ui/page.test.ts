import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { chromium } from 'playwright-core';
import type { Browser, ConsoleMessage, Page } from 'playwright-core';
import { createApp } from '../../src/app.js';
import { VectorStore } from '../../src/store.js';
import { FAQ_SOURCE, faqChunks } from '../../src/faq.js';
import { REFUSAL } from '../../src/grounding.js';
import type { Llm } from '../../src/llm.js';
import { bagOfWordsEmbedder, parsePassagesFromUserMessage, scriptedLlm } from '../helpers.js';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/** Splits `text` into sentences and returns the first one containing `keyword` (case-insensitive). */
function sentenceContaining(text: string, keyword: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const found = sentences.find((sentence) => sentence.toLowerCase().includes(keyword.toLowerCase()));
  if (found === undefined) {
    throw new Error(`No sentence containing "${keyword}" found in: ${text}`);
  }
  return found.trim();
}

const SCREENSHOT_DIR = fileURLToPath(new URL('../../.impeccable/review/', import.meta.url));
const SAVE_SCREENSHOTS = process.env['UI_SCREENSHOTS'] === '1';
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const EXAMPLE_QUESTIONS = [
  'When are you closed?',
  'Can I reserve a table for 4 people?',
  'Do you deliver, and what is the minimum order?',
  'Is there vegan food at Playa Lechi?',
  'What is the capital of France?',
];

const refusalResponse = () => JSON.stringify({ answerable: false, answer: '', citations: [] });

let server: Server;
let baseUrl: string;
let currentLlm: Llm = scriptedLlm(refusalResponse);
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

before(async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument(FAQ_SOURCE, faqChunks());

  const app = createApp({
    store,
    llm: { complete: (messages) => currentLlm.complete(messages) },
    protectedDocuments: [FAQ_SOURCE],
    log: () => {
      // Keep test output quiet: some scenarios intentionally trigger error paths.
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

  browser = await chromium.launch({ channel: 'chrome' });
  page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
  // The one authored entrance animation (fade + rise) is disabled under
  // reduced motion by the page's own CSS, which also keeps full-page
  // screenshot captures deterministic (a resize-to-full-height capture can
  // otherwise race a still-running CSS animation).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  trackConsoleErrors(page);

  if (SAVE_SCREENSHOTS) {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    // Superseded by desktop-refusal.png in this redesign.
    await rm(`${SCREENSHOT_DIR}desktop-86.png`, { force: true });
  }

  await page.goto(`${baseUrl}/`);
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function askViaTextarea(target: Page, question: string): Promise<void> {
  const textarea = target.locator('textarea');
  await textarea.fill(question);
  await textarea.press('Enter');
}

function trackConsoleErrors(target: Page): void {
  target.on('console', (msg: ConsoleMessage) => {
    // Chrome itself logs a "Failed to load resource" console error for every
    // non-2xx fetch response, independent of how gracefully the page handles
    // it; several scenarios across this file deliberately provoke one, so
    // that expected noise is filtered out here. A real CSP violation or
    // app-thrown error logs under different wording and still fails this
    // check.
    if (msg.type() === 'error' && !/^Failed to load resource:/.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  target.on('pageerror', (error) => {
    pageErrors.push(String(error));
  });
}

/** A fresh page for a test that mocks its own routes, isolated from the shared `page`'s state. */
async function newPage(): Promise<Page> {
  const fresh = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
  await fresh.emulateMedia({ reducedMotion: 'reduce' });
  trackConsoleErrors(fresh);
  return fresh;
}

/** Fulfils `/auth/login` with a tiny stub page, so a redirect there never hits the real (non-existent) route. */
async function stubLoginPage(target: Page): Promise<void> {
  await target.route('**/auth/login', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sign in</title>' }),
  );
}

function jsonRoute(status: number, body: unknown) {
  return (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Waits until the NEWEST card (cards stack newest first, so this is the first
 * one in DOM order) shows exactly `question`. Matching by text alone would be
 * ambiguous once the same question has been asked twice (e.g. the screenshot
 * blocks below re-ask the same question at a new viewport), since that
 * legitimately produces two cards with identical question text.
 */
async function waitForAnswerCard(question: string): Promise<void> {
  // The function form runs in the browser via the DevTools protocol, which is
  // exempt from the page's own CSP; a *string* body is instead evaluated
  // in-page through eval(), which this app's strict `script-src 'self'`
  // (no `unsafe-eval`) correctly rejects. `document` is reached through
  // `globalThis` with a narrow cast, since this file's tsconfig has no "dom"
  // lib (it is a Node-context test file, not a browser one).
  await page.waitForFunction((expected: string) => {
    const doc = (globalThis as any).document;
    return doc?.querySelector('.answer-card-question')?.textContent?.trim() === expected;
  }, question);
}

// --- Initial load -------------------------------------------------------------

test('initial load shows the wordmark, five example chips, and the document list', async () => {
  assert.equal((await page.locator('h1').textContent())?.trim(), 'Grounded Q&A');

  const chipTexts = (await page.locator('.example-question').allTextContents()).map((text) => text.trim());
  assert.equal(chipTexts.length, 5);
  for (const question of EXAMPLE_QUESTIONS) {
    assert.ok(chipTexts.includes(question), `Missing example chip: ${question}`);
  }

  await page.locator('.documents', { hasText: FAQ_SOURCE }).waitFor({ state: 'visible' });
  const documentsText = (await page.locator('.documents').textContent()) ?? '';
  assert.ok(documentsText.includes(FAQ_SOURCE));
  assert.ok(documentsText.includes('7'));

  // This test's `createApp` has no auth configured, so /api/me 404s and the
  // fallback applies: authMode 'none' (no account block) and admin (today's
  // behavior, unchanged for an older/auth-less backend).
  assert.equal(((await page.locator('#account-block').textContent()) ?? '').trim(), '');
  assert.equal(await page.locator('#add-pdf-button').isVisible(), true);
});

test('the built-in FAQ has no remove button and shows a Built-in badge', async () => {
  const faqItem = page.locator('.document-item', { hasText: FAQ_SOURCE });
  const itemText = (await faqItem.textContent()) ?? '';
  assert.ok(itemText.includes('Built-in'));
  assert.equal(await faqItem.locator('.document-remove').count(), 0);
});

// --- Asking a question ---------------------------------------------------------

test('asking a question renders a card with the answer and a verified citation', async () => {
  currentLlm = scriptedLlm((messages) => {
    const passages = parsePassagesFromUserMessage(messages);
    const hours = passages.find((passage) => passage.text.toLowerCase().includes('closed'));
    if (hours === undefined) {
      throw new Error('Expected a retrieved passage mentioning "closed".');
    }
    const quote = sentenceContaining(hours.text, 'closed');
    return JSON.stringify({
      answerable: true,
      answer: 'Bonaire Bites is closed on Mondays.',
      citations: [{ passage_id: hours.id, quote }],
    });
  });

  await askViaTextarea(page, 'When are you closed?');
  await waitForAnswerCard('When are you closed?');

  const card = page.locator('.answer-card').first();
  const cardText = (await card.textContent()) ?? '';
  assert.ok(cardText.includes('Bonaire Bites is closed on Mondays.'));
  assert.ok(cardText.includes(FAQ_SOURCE));
  assert.ok(cardText.includes('Hours'));

  const markText = (await card.locator('mark').first().textContent())?.trim();
  assert.equal(markText, 'We are closed on Mondays for staff training and kitchen deep-cleaning.');

  const summaryText = (await card.locator('details summary').textContent()) ?? '';
  const match = summaryText.match(/Retrieved passages \((\d+)\)/);
  assert.ok(match, `Unexpected summary text: ${summaryText}`);
  const count = Number(match?.[1]);
  assert.equal(count, 5);
  assert.equal(await card.locator('details tbody tr').count(), count);

  if (SAVE_SCREENSHOTS) {
    // Re-ask after each viewport change (rather than resizing the already-rendered
    // page) so the screenshot reflects a fresh layout at that exact size, the way
    // a visitor loading the page at that width would actually see it.
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await askViaTextarea(page, 'When are you closed?');
    await waitForAnswerCard('When are you closed?');
    await page.screenshot({ path: `${SCREENSHOT_DIR}desktop.png`, fullPage: true });

    await page.setViewportSize(MOBILE_VIEWPORT);
    await askViaTextarea(page, 'When are you closed?');
    await waitForAnswerCard('When are you closed?');
    await page.screenshot({ path: `${SCREENSHOT_DIR}mobile.png`, fullPage: true });

    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
});

test('answers stack newest first', async () => {
  currentLlm = scriptedLlm(() =>
    JSON.stringify({ answerable: false, answer: '', citations: [] }),
  );

  await askViaTextarea(page, 'Is there vegan food at Playa Lechi?');
  await waitForAnswerCard('Is there vegan food at Playa Lechi?');
  await askViaTextarea(page, 'Can I reserve a table for 4 people?');
  await waitForAnswerCard('Can I reserve a table for 4 people?');

  const cards = page.locator('.answer-card');
  assert.ok((await cards.count()) >= 2);
  const firstCardText = (await cards.nth(0).textContent()) ?? '';
  const secondCardText = (await cards.nth(1).textContent()) ?? '';
  assert.ok(firstCardText.includes('Can I reserve a table for 4 people?'));
  assert.ok(secondCardText.includes('Is there vegan food at Playa Lechi?'));
});

test('clicking an example question chip asks it', async () => {
  currentLlm = scriptedLlm((messages) => {
    const passages = parsePassagesFromUserMessage(messages);
    const delivery = passages.find((passage) => passage.text.toLowerCase().includes('minimum'));
    if (delivery === undefined) {
      throw new Error('Expected a retrieved passage mentioning "minimum".');
    }
    const quote = sentenceContaining(delivery.text, 'minimum');
    return JSON.stringify({
      answerable: true,
      answer: 'Delivery orders have a $25 minimum and take 40 to 50 minutes.',
      citations: [{ passage_id: delivery.id, quote }],
    });
  });

  const question = 'Do you deliver, and what is the minimum order?';
  await page.locator('.example-question', { hasText: question }).click();
  await waitForAnswerCard(question);

  const card = page.locator('.answer-card').first();
  const cardText = (await card.textContent()) ?? '';
  assert.ok(cardText.includes(question));
  assert.ok(cardText.includes('Delivery orders have a $25 minimum and take 40 to 50 minutes.'));
});

test('a refusal shows the calm "Not in the documents" state with the API text', async () => {
  currentLlm = scriptedLlm(refusalResponse);

  const question = 'What is the capital of France?';
  await page.locator('.example-question', { hasText: question }).click();
  await waitForAnswerCard(question);

  const card = page.locator('.answer-card').first();
  await card.locator('.refusal-icon').waitFor({ state: 'visible' });
  const cardText = (await card.textContent()) ?? '';
  assert.ok(cardText.includes('Not in the documents'));
  assert.ok(cardText.includes(REFUSAL));

  if (SAVE_SCREENSHOTS) {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.locator('.example-question', { hasText: question }).click();
    await card.locator('.refusal-icon').waitFor({ state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}desktop-refusal.png`, fullPage: true });
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
});

test('a model failure shows the API error message in an alert', async () => {
  currentLlm = scriptedLlm(() => 'not json');

  await askViaTextarea(page, 'Are you open on Mondays?');

  const alert = page.locator('[role="alert"]');
  await alert.waitFor({ state: 'visible' });
  const alertText = (await alert.textContent()) ?? '';
  assert.match(alertText, /unreadable answer/);

  currentLlm = scriptedLlm(refusalResponse);
});

// --- Uploading and removing documents --------------------------------------------

test('uploading a PDF adds it to the document list with its chunk count', async () => {
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(fixturePath('catering-guide.pdf'));

  await page.locator('[role="status"]', { hasText: 'Added catering-guide.pdf' }).waitFor({ state: 'visible' });
  const statusText = (await page.locator('[role="status"]').textContent()) ?? '';
  assert.ok(statusText.includes('Added catering-guide.pdf, 2 passages'));

  const documentsText = (await page.locator('.documents').textContent()) ?? '';
  assert.ok(documentsText.includes('catering-guide.pdf'));
  assert.ok(documentsText.includes('2'));
});

test('uploading a non-PDF file shows the 415 message in the status line', async () => {
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: 'not-a-pdf.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('just some plain text, not a pdf'),
  });

  await page.locator('[role="status"]', { hasText: 'PDF signature' }).waitFor({ state: 'visible' });
  const statusText = (await page.locator('[role="status"]').textContent()) ?? '';
  assert.match(statusText, /PDF signature/);
});

test('removing a document: click, confirm, disappears, and the status reports it', async () => {
  const item = page.locator('.document-item', { hasText: 'catering-guide.pdf' });
  const removeButton = item.locator('.document-remove');
  assert.equal(await removeButton.getAttribute('aria-label'), 'Remove catering-guide.pdf');

  await removeButton.click();
  await page.locator('.document-remove', { hasText: 'Confirm' }).waitFor({ state: 'visible' });

  await page.locator('.document-remove', { hasText: 'Confirm' }).click();

  await page
    .locator('[role="status"]', { hasText: 'Removed catering-guide.pdf.' })
    .waitFor({ state: 'visible' });
  assert.equal(await page.locator('.document-item', { hasText: 'catering-guide.pdf' }).count(), 0);
});

// --- Sign-in-aware UI (mocked /api/me via page.route, decoupled from the backend) ---

test('a non-admin sees no upload button or remove buttons, and sees the admin note', async () => {
  const fresh = await newPage();
  try {
    await fresh.route('**/api/me', jsonRoute(200, { email: 'viewer@example.com', isAdmin: false, authMode: 'cognito' }));
    await fresh.goto(`${baseUrl}/`);

    await fresh.locator('#admin-note').waitFor({ state: 'visible' });
    assert.match(
      ((await fresh.locator('#admin-note').textContent()) ?? '').trim(),
      /Only administrators can add or remove documents\./,
    );
    assert.equal(await fresh.locator('#add-pdf-button').isVisible(), false);
    assert.equal(await fresh.locator('.document-remove').count(), 0);
  } finally {
    await fresh.close();
  }
});

test('a cognito admin sees a signed-in account block with a sign-out link', async () => {
  const fresh = await newPage();
  try {
    await fresh.route('**/api/me', jsonRoute(200, { email: 'admin@example.com', isAdmin: true, authMode: 'cognito' }));
    await fresh.goto(`${baseUrl}/`);

    const accountBlock = fresh.locator('#account-block');
    await accountBlock.waitFor({ state: 'visible' });
    const accountText = (await accountBlock.textContent()) ?? '';
    assert.match(accountText, /Signed in as admin@example\.com/);

    const signOut = fresh.locator('#account-block a');
    assert.equal((await signOut.textContent())?.trim(), 'Sign out');
    assert.equal(await signOut.getAttribute('href'), '/auth/logout');

    // Not gated by this test, but confirms the fallback didn't also suppress admin controls.
    assert.equal(await fresh.locator('#add-pdf-button').isVisible(), true);
  } finally {
    await fresh.close();
  }
});

test('a 401 from /api/me redirects to /auth/login', async () => {
  const fresh = await newPage();
  try {
    await fresh.route('**/api/me', jsonRoute(401, { error: 'Sign in to continue.' }));
    await stubLoginPage(fresh);

    await fresh.goto(`${baseUrl}/`);
    await fresh.waitForURL('**/auth/login');
    assert.ok(fresh.url().endsWith('/auth/login'), `Expected to land on /auth/login, got ${fresh.url()}`);
  } finally {
    await fresh.close();
  }
});

test('a mocked 429 from /api/ask shows its message in the alert', async () => {
  const fresh = await newPage();
  try {
    await fresh.route(
      '**/api/ask',
      jsonRoute(429, { error: 'Too many questions today. Try again tomorrow.' }),
    );
    await fresh.goto(`${baseUrl}/`);

    await askViaTextarea(fresh, 'When are you closed?');

    const alert = fresh.locator('[role="alert"]');
    await alert.waitFor({ state: 'visible' });
    assert.match((await alert.textContent()) ?? '', /Too many questions today\. Try again tomorrow\./);
  } finally {
    await fresh.close();
  }
});

test('a mocked 401 from /api/ask redirects to /auth/login', async () => {
  const fresh = await newPage();
  try {
    await fresh.route('**/api/ask', jsonRoute(401, { error: 'Sign in to continue.' }));
    await stubLoginPage(fresh);
    await fresh.goto(`${baseUrl}/`);

    await askViaTextarea(fresh, 'When are you closed?');

    await fresh.waitForURL('**/auth/login');
    assert.ok(fresh.url().endsWith('/auth/login'), `Expected to land on /auth/login, got ${fresh.url()}`);
  } finally {
    await fresh.close();
  }
});

// --- Hygiene --------------------------------------------------------------------

test('the page logs no console errors during the run', () => {
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
});

test('app.js never uses innerHTML, outerHTML, insertAdjacentHTML, or document.write', async () => {
  const source = await readFile(fileURLToPath(new URL('../../public/app.js', import.meta.url)), 'utf8');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!source.includes(banned), `app.js must not use ${banned}`);
  }
});
