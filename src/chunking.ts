export interface ChunkInput {
  location: string;
  text: string;
}

export const MAX_CHUNK_CHARS = 900;

const SOFT_HYPHEN = /\u00AD/g;
const HYPHENATED_LINE_BREAK = /(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu;
const WHITESPACE_RUN = /\s+/g;

/**
 * Cleans raw PDF page text: normalizes Unicode (NFKC), removes soft hyphens,
 * rejoins words hyphenated across a line break (only when the next part
 * starts lowercase), and collapses every whitespace run, including
 * newlines, into a single space. Idempotent.
 */
export function cleanPdfText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(SOFT_HYPHEN, '')
    .replace(HYPHENATED_LINE_BREAK, '$1$2')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Splits text into trimmed, non-empty sentences using the Intl sentence segmenter. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const { segment } of sentenceSegmenter.segment(text)) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) sentences.push(trimmed);
  }
  return sentences;
}

/** Sum of a joined-by-single-space sentence list's length, without allocating the string. */
function joinedLength(parts: readonly string[]): number {
  if (parts.length === 0) return 0;
  return parts.reduce((sum, part) => sum + part.length, 0) + (parts.length - 1);
}

function lastOf(items: readonly string[]): string {
  const last = items[items.length - 1];
  if (last === undefined) {
    throw new Error('chunkText: expected a non-empty sentence list.');
  }
  return last;
}

/**
 * Splits one oversize sentence at word boundaries into pieces of at most
 * `maxChars`. A single word longer than `maxChars` is hard-split by
 * character count.
 */
function splitOversizeSentence(sentence: string, maxChars: number): string[] {
  const words = sentence.split(/\s+/).filter((word) => word.length > 0);
  const pieces: string[] = [];
  let current = '';

  const flushCurrent = (): void => {
    if (current.length > 0) {
      pieces.push(current);
      current = '';
    }
  };

  for (const word of words) {
    if (word.length > maxChars) {
      flushCurrent();
      for (let start = 0; start < word.length; start += maxChars) {
        pieces.push(word.slice(start, start + maxChars));
      }
      continue;
    }

    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maxChars) {
      flushCurrent();
      current = word;
    } else {
      current = candidate;
    }
  }
  flushCurrent();

  return pieces;
}

/**
 * Greedily packs whole sentences into chunks of at most `maxChars`. When the
 * next sentence does not fit, the current chunk is emitted and the next one
 * starts with the previous chunk's last sentence (one-sentence overlap),
 * but only when the previous chunk held at least two sentences and the
 * overlap plus the next sentence still fit within `maxChars`. A sentence
 * longer than `maxChars` is split at word boundaries instead, and each
 * piece is emitted as its own chunk.
 */
export function chunkText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.join(' '));
        current = [];
      }
      for (const piece of splitOversizeSentence(sentence, maxChars)) {
        chunks.push(piece);
      }
      continue;
    }

    if (current.length === 0) {
      current = [sentence];
      continue;
    }

    if (joinedLength(current) + 1 + sentence.length <= maxChars) {
      current.push(sentence);
      continue;
    }

    const lastSentence = lastOf(current);
    const canOverlap = current.length >= 2 && lastSentence.length + 1 + sentence.length <= maxChars;
    chunks.push(current.join(' '));
    current = canOverlap ? [lastSentence, sentence] : [sentence];
  }

  if (current.length > 0) {
    chunks.push(current.join(' '));
  }

  return chunks;
}

/**
 * Chunks each PDF page independently, so no chunk ever crosses a page
 * boundary. Each page is cleaned first; pages that are empty after cleaning
 * are skipped.
 */
export function chunkPdfPages(
  pages: readonly string[],
  maxChars: number = MAX_CHUNK_CHARS,
): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  pages.forEach((rawPage, index) => {
    const cleaned = cleanPdfText(rawPage);
    if (cleaned.length === 0) return;
    for (const text of chunkText(cleaned, maxChars)) {
      chunks.push({ location: `page ${index + 1}`, text });
    }
  });
  return chunks;
}
