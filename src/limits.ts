import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import type { LimitsSettings } from './config.js';

export class LimitError extends Error {
  override name = 'LimitError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LimitsDeps {
  /** Clock used by the daily ask cap to decide when UTC midnight has rolled over. */
  now?: () => Date;
}

export interface Limits {
  readonly settings: LimitsSettings;
  /** express-rate-limit middleware for POST /api/ask, per minute. */
  askLimiter: RequestHandler;
  /** express-rate-limit middleware for POST /api/documents, per hour. */
  uploadLimiter: RequestHandler;
  /** express-rate-limit middleware for DELETE /api/documents/:name, per hour. */
  deleteLimiter: RequestHandler;
  /** Global cap on POST /api/ask across every user, resetting at UTC midnight. */
  dailyAskCap: RequestHandler;
  /** Throws `LimitError` (409) when a new (non-replacing) upload would exceed MAX_DOCUMENTS. */
  assertDocumentCapacity(opts: { uploadedCount: number; isReplacing: boolean }): void;
  /** Throws `LimitError` (413) when adding chunks would push the store past MAX_TOTAL_CHUNKS. */
  assertChunkCapacity(opts: { currentTotal: number; adding: number }): void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The authenticated user's `sub` when present (set by the auth middleware), otherwise the client IP. */
function keyGenerator(req: Request): string {
  return req.auth?.sub ?? ipKeyGenerator(req.ip ?? 'unknown');
}

function buildLimiter(windowMs: number, limit: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res) => {
      // express-rate-limit attaches `rateLimit` at runtime but does not
      // declare it on the shared `Request` type, so it is read defensively.
      const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfterSeconds = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: `Too many requests. Try again in ${retryAfterSeconds} seconds.` });
    },
  });
}

/** Start of the UTC day containing `date`, as epoch milliseconds (used as the daily-cap window key). */
function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function buildDailyAskCap(dailyLimit: number, now: () => Date): RequestHandler {
  let windowStart = utcDayStart(now());
  let count = 0;

  return (_req, res, next) => {
    const currentWindowStart = utcDayStart(now());
    if (currentWindowStart !== windowStart) {
      windowStart = currentWindowStart;
      count = 0;
    }

    if (count >= dailyLimit) {
      res.status(429).json({
        error: 'The daily question limit for this demo has been reached. Try again tomorrow.',
      });
      return;
    }

    count += 1;
    next();
  };
}

/**
 * Builds the abuse-prevention middleware and capacity checks described by
 * `settings`: per-minute/per-hour rate limiters keyed by authenticated user
 * (falling back to IP), a global daily cap on asks with an injectable clock
 * so tests can control UTC-midnight rollover, and the document/chunk
 * capacity guards used by the upload endpoint.
 */
export function createLimits(settings: LimitsSettings, deps: LimitsDeps = {}): Limits {
  const now = deps.now ?? ((): Date => new Date());

  return {
    settings,
    askLimiter: buildLimiter(MINUTE_MS, settings.askPerMinute),
    uploadLimiter: buildLimiter(HOUR_MS, settings.uploadsPerHour),
    deleteLimiter: buildLimiter(HOUR_MS, settings.deletesPerHour),
    dailyAskCap: buildDailyAskCap(settings.dailyAskLimit, now),

    assertDocumentCapacity({ uploadedCount, isReplacing }): void {
      if (!isReplacing && uploadedCount >= settings.maxDocuments) {
        throw new LimitError(
          409,
          `The library is full (${settings.maxDocuments} documents). Remove one before adding another.`,
        );
      }
    },

    assertChunkCapacity({ currentTotal, adding }): void {
      if (currentTotal + adding > settings.maxTotalChunks) {
        throw new LimitError(413, 'The library has reached its size limit. Remove a document first.');
      }
    },
  };
}
