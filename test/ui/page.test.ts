import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
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
  // The ticket's one authored entry animation uses clip-path; Chromium's
  // full-page screenshot capture resizes the page to its full scroll height
  // first, which can retrigger/freeze a running CSS animation mid-progress
  // and clip the captured image even though the DOM content is already
  // complete. Preferring reduced motion removes the animation for this
  // session (the page's own CSS already makes that state fully visible by
  // default, per its prefers-reduced-motion rule) and makes every render
  // deterministic for both assertions and screenshots.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('console', (msg: ConsoleMessage) => {
    // Chrome itself logs a "Failed to load resource" console error for every
    // non-2xx fetch response, independent of how gracefully the page handles
    // it. Two scenarios below deliberately provoke a 502 and a 415 to verify
    // the page surfaces those errors correctly, so that expected noise is
    // filtered out here; a real CSP violation or app-thrown error logs under
    // different wording and still fails this check.
    if (msg.type() === 'error' && !/^Failed to load resource:/.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error));
  });

  if (SAVE_SCREENSHOTS) {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
  }

  await page.goto(`${baseUrl}/`);
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function askViaTextarea(question: string): Promise<void> {
  const textarea = page.locator('textarea');
  await textarea.fill(question);
  await textarea.press('Enter');
}

async function waitForTicketQuestion(question: string): Promise<void> {
  await page.locator('.ticket-question', { hasText: question }).waitFor({ state: 'visible' });
}

// --- Initial load -------------------------------------------------------------

test('initial load shows the heading, five example chits, and the shelf', async () => {
  assert.equal((await page.locator('h1').textContent())?.trim(), 'Grounded Q&A');

  const chitTexts = (await page.locator('.example-question').allTextContents()).map((text) => text.trim());
  assert.equal(chitTexts.length, 5);
  for (const question of EXAMPLE_QUESTIONS) {
    assert.ok(chitTexts.includes(question), `Missing example chit: ${question}`);
  }

  await page.locator('.shelf', { hasText: FAQ_SOURCE }).waitFor({ state: 'visible' });
  const shelfText = (await page.locator('.shelf').textContent()) ?? '';
  assert.ok(shelfText.includes(FAQ_SOURCE));
  assert.ok(shelfText.includes('7'));
});

// --- Asking a question ---------------------------------------------------------

test('asking a question renders a ticket with the answer and a verified citation', async () => {
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

  await askViaTextarea('When are you closed?');
  await waitForTicketQuestion('When are you closed?');

  const ticket = page.locator('.ticket').first();
  const ticketText = (await ticket.textContent()) ?? '';
  assert.ok(ticketText.includes('Bonaire Bites is closed on Mondays.'));
  assert.ok(ticketText.includes(FAQ_SOURCE));
  assert.ok(ticketText.includes('Hours'));

  const markText = (await ticket.locator('mark').first().textContent())?.trim();
  assert.equal(markText, 'We are closed on Mondays for staff training and kitchen deep-cleaning.');

  if (SAVE_SCREENSHOTS) {
    // Re-ask after each viewport change (rather than resizing the already-rendered
    // page) so the screenshot reflects a fresh layout at that exact size, the way
    // a visitor loading the page at that width would actually see it.
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await askViaTextarea('When are you closed?');
    await waitForTicketQuestion('When are you closed?');
    await page.screenshot({ path: `${SCREENSHOT_DIR}desktop.png`, fullPage: true });

    await page.setViewportSize(MOBILE_VIEWPORT);
    await askViaTextarea('When are you closed?');
    await waitForTicketQuestion('When are you closed?');
    await page.screenshot({ path: `${SCREENSHOT_DIR}mobile.png`, fullPage: true });

    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
});

test('the retrieved-passages details shows the count and a matching number of table rows', async () => {
  const summaryText = (await page.locator('details summary').first().textContent()) ?? '';
  const match = summaryText.match(/Retrieved passages \((\d+)\)/);
  assert.ok(match, `Unexpected summary text: ${summaryText}`);
  const count = Number(match?.[1]);
  assert.equal(count, 5);

  const rows = page.locator('details tbody tr');
  assert.equal(await rows.count(), count);
});

test('clicking an example question chit asks it', async () => {
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
  await waitForTicketQuestion(question);

  const ticket = page.locator('.ticket').first();
  const ticketText = (await ticket.textContent()) ?? '';
  assert.ok(ticketText.includes(question));
  assert.ok(ticketText.includes('Delivery orders have a $25 minimum and take 40 to 50 minutes.'));
});

test('a refusal renders the 86 stamp and the refusal text from the API', async () => {
  currentLlm = scriptedLlm(refusalResponse);

  const question = 'What is the capital of France?';
  await page.locator('.example-question', { hasText: question }).click();
  await waitForTicketQuestion(question);

  const stamp = page.locator('.ticket-stamp');
  await stamp.waitFor({ state: 'visible' });
  assert.equal((await stamp.textContent())?.trim(), '86');

  const ticket = page.locator('.ticket').first();
  const ticketText = (await ticket.textContent()) ?? '';
  assert.ok(ticketText.includes(REFUSAL));

  if (SAVE_SCREENSHOTS) {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.locator('.example-question', { hasText: question }).click();
    await stamp.waitFor({ state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}desktop-86.png`, fullPage: true });
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
});

test('a model failure shows the API error message in an alert', async () => {
  currentLlm = scriptedLlm(() => 'not json');

  await askViaTextarea('Are you open on Mondays?');

  const alert = page.locator('[role="alert"]');
  await alert.waitFor({ state: 'visible' });
  const alertText = (await alert.textContent()) ?? '';
  assert.match(alertText, /unreadable answer/);

  currentLlm = scriptedLlm(refusalResponse);
});

// --- Uploading documents --------------------------------------------------------

test('uploading a PDF adds it to the shelf with its chunk count', async () => {
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(fixturePath('catering-guide.pdf'));

  await page.locator('[role="status"]', { hasText: 'Added catering-guide.pdf' }).waitFor({ state: 'visible' });
  const statusText = (await page.locator('[role="status"]').textContent()) ?? '';
  assert.ok(statusText.includes('Added catering-guide.pdf, 2 passages'));

  const shelfText = (await page.locator('.shelf').textContent()) ?? '';
  assert.ok(shelfText.includes('catering-guide.pdf'));
  assert.ok(shelfText.includes('2'));
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
