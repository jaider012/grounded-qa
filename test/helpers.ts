import type { Embedder } from '../src/embeddings.js';
import type { ChatMessage, Llm } from '../src/llm.js';

const DEFAULT_DIMENSIONS = 64;

/** Small FNV-1a hash, used to deterministically bucket tokens into a fixed-size vector. */
function fnv1aHash(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Deterministic, network-free `Embedder` for tests: lowercases and tokenizes
 * each text, hashes each token into one of `dims` buckets, and counts
 * occurrences. Gives a stable bag-of-words vector so similarity-ranking
 * tests do not depend on a real embedding provider.
 */
export function bagOfWordsEmbedder(dims: number = DEFAULT_DIMENSIONS): Embedder {
  return async (texts: string[]): Promise<number[][]> =>
    texts.map((text) => {
      const vector = new Array<number>(dims).fill(0);
      for (const token of tokenize(text)) {
        const bucket = fnv1aHash(token) % dims;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      return vector;
    });
}

/** An `Llm` whose single reply is computed by `handler` from the sent messages. */
export function scriptedLlm(handler: (messages: ChatMessage[]) => string): Llm {
  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      return handler(messages);
    },
  };
}

export interface ParsedPassage {
  id: string;
  source: string;
  location: string;
  text: string;
}

const PASSAGE_BLOCK = /<passage id="([^"]*)" source="([^"]*)" location="([^"]*)">\n([\s\S]*?)\n<\/passage>/g;

/**
 * Parses the `<passage id="..." source="..." location="...">...</passage>`
 * blocks that `buildMessages` renders into the user message, so a scripted
 * `Llm` can react to the passages actually retrieved for a question.
 */
export function parsePassagesFromUserMessage(messages: readonly ChatMessage[]): ParsedPassage[] {
  const userContent = messages.find((message) => message.role === 'user')?.content ?? '';
  const passages: ParsedPassage[] = [];
  for (const match of userContent.matchAll(PASSAGE_BLOCK)) {
    const [, id, source, location, text] = match;
    if (id === undefined || source === undefined || location === undefined || text === undefined) continue;
    passages.push({ id, source, location, text });
  }
  return passages;
}
