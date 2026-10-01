import { extractText, getDocumentProxy } from 'unpdf';
import { cleanPdfText } from './chunking.js';

export type PdfErrorCode = 'encrypted' | 'unreadable' | 'no_text';

export class PdfError extends Error {
  override name = 'PdfError';
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** True only when `data` starts with the PDF magic header `%PDF-`. */
export function isPdf(data: Uint8Array): boolean {
  if (data.length < PDF_MAGIC_BYTES.length) return false;
  return PDF_MAGIC_BYTES.every((byte, index) => data[index] === byte);
}

/**
 * Extracts and cleans the text of every page in a PDF. Throws `PdfError`
 * with `encrypted` for a password-protected file, `unreadable` for any other
 * file that cannot be opened or parsed, and `no_text` when every page is
 * empty after cleaning (a scanned PDF with no text layer).
 */
export async function extractPdfPages(data: Uint8Array): Promise<string[]> {
  let pages: string[];
  try {
    // pdf.js may detach the underlying buffer, so hand it its own copy.
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const extracted = await extractText(pdf, { mergePages: false });
    pages = extracted.text;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new PdfError(
        'encrypted',
        'This PDF is password-protected. Remove the password and upload it again.',
      );
    }
    throw new PdfError(
      'unreadable',
      'This PDF could not be read. It may be damaged; export it again and retry.',
    );
  }

  const cleanedPages = pages.map((page) => cleanPdfText(page));
  const hasText = cleanedPages.some((page) => page.length > 0);
  if (!hasText) {
    throw new PdfError(
      'no_text',
      'This PDF has no text layer, so it looks scanned. Run OCR on it first, then upload the result.',
    );
  }

  return cleanedPages;
}
