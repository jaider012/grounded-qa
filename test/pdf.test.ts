import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PdfError, extractPdfPages, isPdf } from '../src/pdf.js';

function fixture(name: string): Promise<Buffer> {
  return readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
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
