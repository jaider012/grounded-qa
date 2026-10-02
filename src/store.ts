import type { Embedder } from './embeddings.js';
import type { ChunkInput } from './chunking.js';

export interface Chunk {
  id: string;
  source: string;
  location: string;
  text: string;
  vector: number[];
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export interface DocumentSummary {
  name: string;
  chunks: number;
}

const DEFAULT_K = 5;

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * In-memory, brute-force cosine-similarity vector store. No vector
 * database. The store's vector dimension is taken from the first vector
 * ever stored, never hard-coded.
 */
export class VectorStore {
  readonly #embedder: Embedder;
  #chunks: Chunk[] = [];
  readonly #documentOrder: string[] = [];
  readonly #documentChunkCounts = new Map<string, number>();
  #nextId = 1;
  #dimensions: number | undefined;

  constructor(embedder: Embedder) {
    this.#embedder = embedder;
  }

  /**
   * Embeds every part with one embedder call, then replaces any existing
   * document with the same name. Embeds first and swaps after, so a failed
   * embedding (or a dimension mismatch) leaves the old document in place.
   */
  async addDocument(name: string, parts: readonly ChunkInput[]): Promise<DocumentSummary> {
    if (parts.length === 0) {
      throw new Error(`Cannot add document "${name}" with no chunks.`);
    }

    const vectors = await this.#embedder(parts.map((part) => part.text));
    if (vectors.length !== parts.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${parts.length} chunks.`);
    }

    const expectedDimensions = this.#dimensions ?? vectors[0]?.length;
    for (const vector of vectors) {
      if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${expectedDimensions}, got ${vector.length}.`,
        );
      }
    }

    const newChunks: Chunk[] = parts.map((part, index) => {
      const vector = vectors[index];
      if (vector === undefined) {
        throw new Error('Embedder returned fewer vectors than input chunks.');
      }
      return {
        id: `c${this.#nextId++}`,
        source: name,
        location: part.location,
        text: part.text,
        vector,
      };
    });

    this.#dimensions = expectedDimensions;
    const isNewDocument = !this.#documentChunkCounts.has(name);
    this.#chunks = this.#chunks.filter((chunk) => chunk.source !== name).concat(newChunks);
    this.#documentChunkCounts.set(name, newChunks.length);
    if (isNewDocument) this.#documentOrder.push(name);

    return { name, chunks: newChunks.length };
  }

  /** Embeds the query and returns the top `k` chunks by cosine similarity, descending. */
  async search(query: string, k: number = DEFAULT_K): Promise<ScoredChunk[]> {
    if (this.#chunks.length === 0) return [];

    const [queryVector] = await this.#embedder([query]);
    if (queryVector === undefined) {
      throw new Error('Embedder returned no vector for the query.');
    }
    if (queryVector.length !== this.#dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.#dimensions}, got ${queryVector.length}.`,
      );
    }

    return this.#chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Loaded documents with their chunk counts, in insertion order. */
  listDocuments(): DocumentSummary[] {
    return this.#documentOrder.map((name) => ({
      name,
      chunks: this.#documentChunkCounts.get(name) ?? 0,
    }));
  }

  /**
   * Removes every chunk belonging to `name` and its entry from
   * `listDocuments()`. Returns `false` without changing anything when no
   * such document is loaded. `#nextId` is never rolled back, so removed
   * chunk ids are never reused by documents added afterwards.
   */
  removeDocument(name: string): boolean {
    if (!this.#documentChunkCounts.has(name)) return false;

    this.#chunks = this.#chunks.filter((chunk) => chunk.source !== name);
    this.#documentChunkCounts.delete(name);
    const index = this.#documentOrder.indexOf(name);
    if (index !== -1) this.#documentOrder.splice(index, 1);

    return true;
  }

  get documentCount(): number {
    return this.#documentOrder.length;
  }
}
