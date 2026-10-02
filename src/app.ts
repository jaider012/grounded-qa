import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import type { VectorStore } from './store.js';
import type { Llm } from './llm.js';
import { ModelOutputError } from './llm.js';
import { answerQuestion } from './answer.js';
import { chunkPdfPages } from './chunking.js';
import { PdfError, extractPdfPages, isPdf } from './pdf.js';

export interface AppDeps {
  store: VectorStore;
  llm: Llm;
  /** Document names that cannot be removed through `DELETE /api/documents/:name` (e.g. the built-in FAQ). */
  protectedDocuments?: readonly string[];
  log?: (message: string, error?: unknown) => void;
}

export const MAX_QUESTION_CHARS = 500;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MAX_FILENAME_CHARS = 120;
const FALLBACK_FILENAME = 'document.pdf';

// Resolved relative to this module file, so it works whether this module
// runs from src/ (tsx) or dist/ (compiled): both sit one directory under
// the repo root, next to public/.
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Keeps only the base name, strips control/forbidden characters, collapses whitespace, and caps the length. */
function sanitizeFileName(rawName: string): string {
  const baseName = rawName.split(/[/\\]/).pop() ?? '';
  const withoutControlChars = baseName.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  const withoutForbiddenChars = withoutControlChars.replace(/["<>]/g, '');
  const collapsed = withoutForbiddenChars.replace(/\s+/g, ' ').trim();
  const capped = collapsed.slice(0, MAX_FILENAME_CHARS).trim();
  return capped.length > 0 ? capped : FALLBACK_FILENAME;
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/** True for the error body-parser raises when `express.json()` cannot parse the request body. */
function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof error === 'object' &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  );
}

/** Runs an Express middleware that takes a Node-style `(err?) => void` callback as a Promise. */
function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error?: unknown) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Builds the Express app: security headers, static files, health check,
 * document listing/upload, and the ask endpoint. Receives the store and the
 * LLM as arguments so tests can run without API keys or network.
 */
export function createApp(deps: AppDeps): express.Express {
  const log = deps.log ?? ((message: string, error?: unknown): void => console.error(message, error));
  const { store, llm, protectedDocuments = [] } = deps;

  /** Loaded documents in the `GET`/`DELETE` response shape, flagging names that cannot be removed. */
  function listDocumentsResponse(): Array<{ name: string; chunks: number; builtIn: boolean }> {
    return store.listDocuments().map((document) => ({
      ...document,
      builtIn: protectedDocuments.includes(document.name),
    }));
  }

  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // public/ does not exist yet (a later task adds the frontend); serve-static
  // checks the filesystem lazily per request, so a missing directory here
  // just means every request falls through to the routes below.
  app.use(express.static(PUBLIC_DIR));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', documents: store.documentCount });
  });

  app.get('/api/documents', (_req, res) => {
    res.status(200).json({ documents: listDocumentsResponse() });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    // multer 2 forwards this straight to busboy, which otherwise decodes
    // multipart filename/field parameters as latin1.
    defParamCharset: 'utf8',
  });

  app.post('/api/documents', async (req, res) => {
    try {
      await runMiddleware(upload.single('file'), req, res);
    } catch (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          sendError(res, 413, 'That file is larger than 10 MB. Compress or split it, then upload it again.');
          return;
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
          sendError(res, 400, 'Upload the PDF in a multipart field named "file".');
          return;
        }
        sendError(res, 400, `Upload failed: ${error.message}`);
        return;
      }
      log('POST /api/documents upload failed', error);
      sendError(res, 400, 'Upload failed. Try again.');
      return;
    }

    const file = req.file;
    if (!file) {
      sendError(res, 400, 'Attach a PDF in the "file" field and try again.');
      return;
    }

    if (!isPdf(file.buffer)) {
      sendError(
        res,
        415,
        'Only PDF files are supported. This file does not start with the PDF signature (%PDF-).',
      );
      return;
    }

    let pages: string[];
    try {
      pages = await extractPdfPages(file.buffer);
    } catch (error) {
      if (error instanceof PdfError) {
        sendError(res, 422, error.message);
        return;
      }
      log('POST /api/documents PDF extraction failed', error);
      sendError(res, 422, 'This PDF could not be read. It may be damaged; export it again and retry.');
      return;
    }

    const parts = chunkPdfPages(pages);
    if (parts.length === 0) {
      sendError(
        res,
        422,
        'This PDF has no text layer, so it looks scanned. Run OCR on it first, then upload the result.',
      );
      return;
    }

    const name = sanitizeFileName(file.originalname);
    try {
      const summary = await store.addDocument(name, parts);
      res.status(201).json({ document: summary });
    } catch (error) {
      log('POST /api/documents addDocument failed', error);
      sendError(res, 502, 'The embedding service failed, so the PDF was not added. Try again in a moment.');
    }
  });

  app.delete('/api/documents/:name', (req, res) => {
    const name = req.params.name;

    if (protectedDocuments.includes(name)) {
      sendError(res, 403, 'The built-in FAQ cannot be removed.');
      return;
    }

    if (!store.removeDocument(name)) {
      sendError(res, 404, `No document named "${name}" is loaded. Refresh the list and try again.`);
      return;
    }

    res.status(200).json({ removed: name, documents: listDocumentsResponse() });
  });

  app.post('/api/ask', express.json({ limit: '16kb' }), async (req, res) => {
    const body: unknown = req.body;
    const question =
      typeof body === 'object' && body !== null && 'question' in body
        ? (body as { question: unknown }).question
        : undefined;

    if (typeof question !== 'string') {
      sendError(res, 400, 'Send JSON like {"question": "What are your hours?"}.');
      return;
    }

    const trimmed = question.trim();
    if (trimmed.length === 0) {
      sendError(res, 400, 'Type a question first.');
      return;
    }
    if (trimmed.length > MAX_QUESTION_CHARS) {
      sendError(res, 400, 'Questions are limited to 500 characters. Shorten yours and try again.');
      return;
    }

    try {
      const result = await answerQuestion({ store, llm }, trimmed);
      res.status(200).json(result);
    } catch (error) {
      log('POST /api/ask failed', error);
      if (error instanceof ModelOutputError) {
        sendError(res, 502, 'The language model returned an unreadable answer twice. Try again in a moment.');
        return;
      }
      sendError(
        res,
        502,
        'The language model or the embedding service did not respond correctly. Try again in a moment.',
      );
    }
  });

  app.use('/api', (_req, res) => {
    sendError(res, 404, 'Not found.');
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (isJsonParseError(err)) {
      sendError(res, 400, 'Send JSON like {"question": "What are your hours?"}.');
      return;
    }
    log('Unhandled error', err);
    sendError(res, 500, 'Something went wrong on our side. Try again.');
  });

  return app;
}
