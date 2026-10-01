import type { Chunk } from './store.js';

export const REFUSAL = "I can't answer that from the loaded documents.";
export const MIN_QUOTE_CHARS = 12;

export interface Citation {
  source: string;
  location: string;
  quote: string;
  passage: string;
}

export interface GroundedAnswer {
  answerable: boolean;
  answer: string;
  citations: Citation[];
}

export function refusal(): GroundedAnswer {
  return { answerable: false, answer: REFUSAL, citations: [] };
}

const DASH_CHARS = new Set([
  '\u2010',
  '\u2011',
  '\u2012',
  '\u2013',
  '\u2014',
  '\u2015',
  '\u2212',
  '\uFE58',
  '\uFE63',
  '\uFF0D',
]);
const SINGLE_QUOTE_CHARS = new Set(['\u2018', '\u2019', '\u201A', '\u201B', '\u2032', '\u00B4', '`']);
const DOUBLE_QUOTE_CHARS = new Set([
  '\u201C',
  '\u201D',
  '\u201E',
  '\u201F',
  '\u2033',
  '\u00AB',
  '\u00BB',
]);
const SOFT_HYPHEN = '\u00AD';

/**
 * Normalizes one source character (after per-character NFKC) into its
 * canonical match form: soft hyphens drop out, dash variants become `-`,
 * single-quote/apostrophe variants become `'`, double-quote variants become
 * `"`, and everything else (including whitespace) passes through unchanged.
 */
function classifyChar(char: string): string {
  let mapped = '';
  for (const c of char.normalize('NFKC')) {
    if (c === SOFT_HYPHEN) continue;
    if (DASH_CHARS.has(c)) {
      mapped += '-';
    } else if (SINGLE_QUOTE_CHARS.has(c)) {
      mapped += "'";
    } else if (DOUBLE_QUOTE_CHARS.has(c)) {
      mapped += '"';
    } else {
      mapped += c;
    }
  }
  return mapped;
}

interface IndexedNormalization {
  normalized: string;
  /** For each character of `normalized`, the index into the original text it came from. */
  originalIndex: number[];
}

/**
 * Builds the normalized-for-match form of `text` while tracking, for every
 * output character, which original character produced it. This lets
 * `locateQuote` translate a match found in normalized text back into an
 * exact substring of the original.
 */
function buildIndexedNormalization(text: string): IndexedNormalization {
  const chars: string[] = [];
  const sourceIndex: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const original = text[i];
    if (original === undefined) continue;
    for (const mapped of classifyChar(original)) {
      chars.push(mapped);
      sourceIndex.push(i);
    }
  }

  const collapsedChars: string[] = [];
  const collapsedIndex: number[] = [];
  let i = 0;
  while (i < chars.length) {
    const char = chars[i];
    if (char !== undefined && /\s/.test(char)) {
      collapsedChars.push(' ');
      collapsedIndex.push(sourceIndex[i] ?? 0);
      while (i < chars.length) {
        const current = chars[i];
        if (current === undefined || !/\s/.test(current)) break;
        i += 1;
      }
      continue;
    }
    collapsedChars.push(char ?? '');
    collapsedIndex.push(sourceIndex[i] ?? 0);
    i += 1;
  }

  let start = 0;
  let end = collapsedChars.length;
  while (start < end && collapsedChars[start] === ' ') start += 1;
  while (end > start && collapsedChars[end - 1] === ' ') end -= 1;

  return {
    normalized: collapsedChars.slice(start, end).join(''),
    originalIndex: collapsedIndex.slice(start, end),
  };
}

/**
 * Normalizes text for verbatim matching: NFKC, drops soft hyphens, unifies
 * dash and quote variants to their canonical ASCII form, collapses every
 * whitespace run to one space, and trims. Case-sensitive (verbatim means
 * verbatim).
 */
export function normalizeForMatch(text: string): string {
  return buildIndexedNormalization(text).normalized;
}

const QUOTE_MARK = /["'\u2018\u2019\u201A\u201B\u2032\u00B4`\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/;
const ELLIPSIS = '\u2026';

function stripWrappingQuotes(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if (first !== undefined && last !== undefined && QUOTE_MARK.test(first) && QUOTE_MARK.test(last)) {
    return text.slice(1, -1);
  }
  return text;
}

function stripEllipsis(text: string): string {
  let result = text;
  if (result.startsWith('...')) result = result.slice(3);
  else if (result.startsWith(ELLIPSIS)) result = result.slice(1);
  if (result.endsWith('...')) result = result.slice(0, -3);
  else if (result.endsWith(ELLIPSIS)) result = result.slice(0, -1);
  return result;
}

function cleanQuote(rawQuote: string): string {
  const unwrapped = stripWrappingQuotes(rawQuote.trim()).trim();
  return stripEllipsis(unwrapped).trim();
}

/**
 * Finds `quote` inside `passage`, tolerating whitespace, dash, and
 * quote-mark differences, and returns the exact original substring of
 * `passage` it covers (so the UI can re-locate and highlight it with
 * `indexOf`). Returns null when the cleaned quote is too short or not found.
 */
export function locateQuote(passage: string, quote: string): string | null {
  const normalizedQuote = normalizeForMatch(cleanQuote(quote));
  if (normalizedQuote.length < MIN_QUOTE_CHARS) return null;

  const { normalized: normalizedPassage, originalIndex } = buildIndexedNormalization(passage);
  const matchStart = normalizedPassage.indexOf(normalizedQuote);
  if (matchStart === -1) return null;

  const matchEnd = matchStart + normalizedQuote.length - 1;
  const originalStart = originalIndex[matchStart];
  const originalEndInclusive = originalIndex[matchEnd];
  if (originalStart === undefined || originalEndInclusive === undefined) return null;

  return passage.slice(originalStart, originalEndInclusive + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifies a model's raw answer output against the passages actually
 * retrieved for this question: plain code, no LLM. Every surviving citation
 * references a retrieved passage and a verbatim (whitespace/dash/quote
 * tolerant) quote from it. Malformed output, an unanswerable response, an
 * empty answer, or zero surviving citations all become the fixed refusal.
 */
export function verifyAnswer(output: unknown, retrieved: readonly Chunk[]): GroundedAnswer {
  if (!isPlainObject(output)) return refusal();

  const { answerable, answer, citations } = output;
  if (typeof answerable !== 'boolean' || typeof answer !== 'string' || !Array.isArray(citations)) {
    return refusal();
  }
  if (!answerable) return refusal();

  const trimmedAnswer = answer.trim();
  if (trimmedAnswer.length === 0) return refusal();

  const byId = new Map(retrieved.map((chunk) => [chunk.id, chunk] as const));
  const seen = new Set<string>();
  const verified: Citation[] = [];

  for (const rawCitation of citations) {
    if (!isPlainObject(rawCitation)) continue;
    const passageId = rawCitation['passage_id'];
    const quote = rawCitation['quote'];
    if (typeof passageId !== 'string' || typeof quote !== 'string') continue;

    const chunk = byId.get(passageId);
    if (chunk === undefined) continue;

    const span = locateQuote(chunk.text, quote);
    if (span === null) continue;

    const dedupeKey = `${passageId}\u0000${span}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    verified.push({ source: chunk.source, location: chunk.location, quote: span, passage: chunk.text });
  }

  if (verified.length === 0) return refusal();

  return { answerable: true, answer: trimmedAnswer, citations: verified };
}
