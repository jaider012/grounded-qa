import { extractText, getDocumentProxy } from 'unpdf';
import { cleanPdfText } from './chunking.js';

export type PdfErrorCode = 'encrypted' | 'unreadable' | 'no_text' | 'too_many_pages' | 'timeout';

export class PdfError extends Error {
  override name = 'PdfError';
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExtractPdfOptions {
  /** Maximum pages allowed. Checked before extracting any text; unlimited when omitted. */
  maxPages?: number;
  /** Maximum time, in milliseconds, allowed to extract text. Unlimited when omitted. */
  timeoutMs?: number;
  /**
   * Testing seam: replaces the pdf.js text-extraction call. Defaults to the
   * real `extractText` from `unpdf`. Lets tests simulate a slow parse
   * deterministically instead of racing real (variable) parse time.
   */
  extractTextImpl?: (pdf: Awaited<ReturnType<typeof getDocumentProxy>>) => Promise<{ text: string[] }>;
}

/** Rejects with `PdfError('timeout', ...)` if `promise` has not settled after `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PdfError('timeout', 'This PDF took too long to read. Export it again or split it.'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
 * file that cannot be opened or parsed, `too_many_pages` when the page count
 * exceeds `options.maxPages` (checked before any text is extracted),
 * `timeout` when extraction does not finish within `options.timeoutMs`, and
 * `no_text` when every page is empty after cleaning (a scanned PDF with no
 * text layer). pdf.js resources are released on every path, including early
 * returns and timeouts.
 */
export async function extractPdfPages(data: Uint8Array, options: ExtractPdfOptions = {}): Promise<string[]> {
  const { maxPages, timeoutMs } = options;
  const runExtractText = options.extractTextImpl ?? ((proxy) => extractText(proxy, { mergePages: false }));
  // pdf.js may detach the underlying buffer, so hand it its own copy.
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;

  try {
    try {
      pdf = await getDocumentProxy(new Uint8Array(data));
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

    if (maxPages !== undefined && pdf.numPages > maxPages) {
      throw new PdfError(
        'too_many_pages',
        `This PDF has ${pdf.numPages} pages; the limit is ${maxPages}. Split it and upload the parts.`,
      );
    }

    let pages: string[];
    try {
      const extraction = runExtractText(pdf).then((extracted) => extracted.text);
      pages = timeoutMs !== undefined ? await withTimeout(extraction, timeoutMs) : await extraction;
    } catch (error) {
      if (error instanceof PdfError) throw error;
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
  } finally {
    if (pdf !== undefined) {
      try {
        await pdf.loadingTask.destroy();
      } catch {
        // Best-effort cleanup: a failure here must never mask the real result or error.
      }
    }
  }
}
