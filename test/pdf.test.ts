import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { PdfError, extractPdfPages, isPdf } from '../src/pdf.js';

function fixture(name: string): Promise<Buffer> {
  return readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** Builds a minimal, valid, text-free PDF with `count` blank pages, generated at test time with pdf-lib. */
async function makePdfWithPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i += 1) {
    doc.addPage();
  }
  return doc.save();
}

function assertPdfError(error: unknown, code: PdfError['code']): true {
  assert.ok(error instanceof PdfError, `expected a PdfError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

test('isPdf is true for real PDF bytes', async () => {
  const bytes = await fixture('catering-guide.pdf');
  assert.equal(isPdf(bytes), true);
});

test('isPdf is false for plain text bytes', () => {
  assert.equal(isPdf(new TextEncoder().encode('not a pdf at all')), false);
});

test('isPdf is false for bytes shorter than the magic header', () => {
  assert.equal(isPdf(new TextEncoder().encode('%PD')), false);
});

test('extractPdfPages returns one cleaned string per page', async () => {
  const bytes = await fixture('catering-guide.pdf');
  const pages = await extractPdfPages(bytes);

  assert.equal(pages.length, 2);
  assert.match(pages[0] ?? '', /Bonaire Bites Catering Guide/);
  assert.match(pages[1] ?? '', /A deposit of 30 percent confirms a catering order\./);
});

test('extractPdfPages rejects a scanned PDF with no text layer', async () => {
  const bytes = await fixture('scanned.pdf');
  await assert.rejects(() => extractPdfPages(bytes), (error: unknown) =>
    assertPdfError(error, 'no_text'),
  );
});

test('extractPdfPages rejects bytes that look like a PDF but cannot be parsed', async () => {
  const garbage = new TextEncoder().encode('%PDF-1.7 garbage');
  await assert.rejects(() => extractPdfPages(garbage), (error: unknown) =>
    assertPdfError(error, 'unreadable'),
  );
});

// --- maxPages ------------------------------------------------------------------

test('extractPdfPages rejects a PDF with more pages than maxPages, before extracting text', async () => {
  const bytes = await makePdfWithPages(5);
  await assert.rejects(
    () => extractPdfPages(bytes, { maxPages: 3 }),
    (error: unknown) => {
      assertPdfError(error, 'too_many_pages');
      assert.match((error as PdfError).message, /5 pages/);
      assert.match((error as PdfError).message, /limit is 3/);
      return true;
    },
  );
});

test('extractPdfPages allows a PDF with exactly maxPages pages', async () => {
  const bytes = await fixture('catering-guide.pdf');
  const pages = await extractPdfPages(bytes, { maxPages: 2 });
  assert.equal(pages.length, 2);
});

test('extractPdfPages has no page limit when maxPages is not given', async () => {
  const bytes = await makePdfWithPages(5);
  // Every page is blank, so this should reach (and throw) the no_text check,
  // never the page-count check, proving no implicit limit was applied.
  await assert.rejects(() => extractPdfPages(bytes), (error: unknown) => assertPdfError(error, 'no_text'));
});

// --- timeoutMs -------------------------------------------------------------------

test('extractPdfPages rejects when parsing does not finish within timeoutMs', async () => {
  // Racing a real parse against a near-zero timeout is flaky (parse speed
  // varies by machine/load), so the slow step is stubbed deterministically
  // instead: it always finishes well after the configured timeout.
  const bytes = await fixture('catering-guide.pdf');
  const slowExtractTextImpl = () =>
    new Promise<{ text: string[] }>((resolve) => {
      setTimeout(() => resolve({ text: ['slow page'] }), 50);
    });

  await assert.rejects(
    () => extractPdfPages(bytes, { timeoutMs: 5, extractTextImpl: slowExtractTextImpl }),
    (error: unknown) => {
      assertPdfError(error, 'timeout');
      assert.match((error as PdfError).message, /too long/);
      return true;
    },
  );
});

test('extractPdfPages succeeds when parsing finishes well within timeoutMs', async () => {
  const bytes = await fixture('catering-guide.pdf');
  const pages = await extractPdfPages(bytes, { timeoutMs: 15000 });
  assert.equal(pages.length, 2);
});
