import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

/**
 * Generates the PDF fixtures used by test/pdf.test.ts. Run with
 * `npx tsx scripts/make-fixtures.ts`. Creation/modification dates and
 * producer/creator metadata are fixed so re-running produces stable files.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const FIXED_DATE = new Date('2024-01-01T00:00:00.000Z');
const PAGE_SIZE: [number, number] = [612, 792]; // US Letter, in points
const MARGIN = 72;

function stampMetadata(doc: PDFDocument): void {
  doc.setProducer('grounded-qa fixture generator');
  doc.setCreator('grounded-qa fixture generator');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
}

function drawHeadingAndBody(page: PDFPage, font: PDFFont, heading: string, body: string): void {
  const maxWidth = page.getWidth() - MARGIN * 2;

  page.drawText(heading, {
    x: MARGIN,
    y: 720,
    size: 18,
    font,
    lineHeight: 22,
    maxWidth,
  });

  page.drawText(body, {
    x: MARGIN,
    y: 670,
    size: 12,
    font,
    lineHeight: 16,
    maxWidth,
  });
}

async function buildCateringGuide(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  stampMetadata(doc);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  drawHeadingAndBody(
    doc.addPage(PAGE_SIZE),
    font,
    'Bonaire Bites Catering Guide',
    "Our catering team serves events of 20 to 200 guests across Bonaire. Every menu is built around the day's fresh catch and local produce. Orders must be placed at least 7 days before the event.",
  );

  drawHeadingAndBody(
    doc.addPage(PAGE_SIZE),
    font,
    'Payments and cancellations',
    'A deposit of 30 percent confirms a catering order. The remaining balance is due on the day of the event. Cancellations made more than 72 hours ahead receive a full refund of the deposit.',
  );

  return doc.save();
}

async function buildScanned(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  stampMetadata(doc);
  const page = doc.addPage(PAGE_SIZE);
  // No text is drawn: this fixture simulates a scanned page with no text layer.
  page.drawRectangle({
    x: 100,
    y: 100,
    width: 400,
    height: 500,
    color: rgb(0.8, 0.8, 0.8),
  });
  return doc.save();
}

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });

  const catering = await buildCateringGuide();
  await writeFile(join(FIXTURES_DIR, 'catering-guide.pdf'), catering);

  const scanned = await buildScanned();
  await writeFile(join(FIXTURES_DIR, 'scanned.pdf'), scanned);

  console.log(`Wrote fixtures to ${FIXTURES_DIR}`);
}

await main();
