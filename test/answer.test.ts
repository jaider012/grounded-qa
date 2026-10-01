import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAQ_SOURCE, faqChunks } from '../src/faq.js';
import { VectorStore } from '../src/store.js';
import type { ChatMessage, Llm } from '../src/llm.js';
import { ModelOutputError } from '../src/llm.js';
import type { Embedder } from '../src/embeddings.js';
import { answerQuestion, buildMessages, SYSTEM_PROMPT, TOP_K } from '../src/answer.js';
import { bagOfWordsEmbedder } from './helpers.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function buildFaqStore(): Promise<VectorStore> {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument(FAQ_SOURCE, faqChunks());
  return store;
}

function jsonLlm(output: unknown): Llm {
  return {
    async complete(): Promise<string> {
      return JSON.stringify(output);
    },
  };
}

// --- SYSTEM_PROMPT -----------------------------------------------------------

test('SYSTEM_PROMPT mentions json', () => {
  assert.match(SYSTEM_PROMPT, /json/);
});

// --- buildMessages -----------------------------------------------------------

test('buildMessages renders every passage id, source, location, and the question', async () => {
  const store = await buildFaqStore();
  const hits = await store.search('What are your hours?', TOP_K);
  const chunks = hits.map((hit) => hit.chunk);

  const messages = buildMessages('What are your hours?', chunks);

  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, SYSTEM_PROMPT);
  assert.equal(messages[1]?.role, 'user');

  const userContent = messages[1]?.content ?? '';
  assert.ok(userContent.startsWith('Passages:\n'));
  for (const chunk of chunks) {
    const passageTag = new RegExp(
      `<passage id="${escapeRegExp(chunk.id)}" source="${escapeRegExp(chunk.source)}" location="${escapeRegExp(chunk.location)}">`,
    );
    assert.match(userContent, passageTag);
    assert.ok(userContent.includes(chunk.text));
  }
  assert.ok(userContent.includes('Question:\n<question>\nWhat are your hours?\n</question>'));
});

test('buildMessages separates consecutive passages with exactly one blank line', () => {
  const chunks = [
    { id: 'c1', source: 'Src', location: 'Loc1', text: 'Text one.', vector: [] },
    { id: 'c2', source: 'Src', location: 'Loc2', text: 'Text two.', vector: [] },
  ];

  const messages = buildMessages('A question?', chunks);
  const userContent = messages[1]?.content ?? '';

  assert.ok(userContent.includes('</passage>\n\n<passage id="c2"'));
});

// --- answerQuestion -----------------------------------------------------------

test('an empty store returns the refusal without calling the LLM', async () => {
  const emptyStore = new VectorStore(bagOfWordsEmbedder());
  let called = false;
  const llm: Llm = {
    async complete(): Promise<string> {
      called = true;
      return '{}';
    },
  };

  const result = await answerQuestion({ store: emptyStore, llm }, 'Anything?');

  assert.equal(result.answerable, false);
  assert.deepEqual(result.retrieved, []);
  assert.equal(called, false);
});

test('a fake LLM that cites a retrieved passage verbatim yields a verified answer', async () => {
  const store = await buildFaqStore();
  const hits = await store.search('What are your hours?', TOP_K);
  const firstChunk = hits[0]?.chunk;
  assert.ok(firstChunk);

  const llm = jsonLlm({
    answerable: true,
    answer: 'We are open Tuesday through Sunday.',
    citations: [{ passage_id: firstChunk.id, quote: firstChunk.text.slice(0, 30) }],
  });

  const result = await answerQuestion({ store, llm }, 'What are your hours?');

  assert.equal(result.answerable, true);
  assert.equal(result.citations.length, 1);
  assert.ok(result.retrieved.length > 0);
  assert.ok(result.retrieved.length <= 5);
  assert.deepEqual(
    result.retrieved.map((p) => p.source),
    hits.map((hit) => hit.chunk.source),
  );
});

test('rounds retrieved scores to 3 decimals, in rank order', async () => {
  const queryVector: [number, number] = [1, 2];
  const docVector: [number, number] = [3, 5];
  const embedder: Embedder = async (texts) =>
    texts.map((text) => (text === 'the-query' ? queryVector : docVector));
  const store = new VectorStore(embedder);
  await store.addDocument('doc', [{ location: 'only', text: 'the-chunk' }]);

  const dot = queryVector[0] * docVector[0] + queryVector[1] * docVector[1];
  const normQ = Math.sqrt(queryVector[0] ** 2 + queryVector[1] ** 2);
  const normD = Math.sqrt(docVector[0] ** 2 + docVector[1] ** 2);
  const rawScore = dot / (normQ * normD);
  assert.notEqual(rawScore, Math.round(rawScore * 1000) / 1000, 'test setup: score must need rounding');
  const expectedScore = Math.round(rawScore * 1000) / 1000;

  const llm = jsonLlm({ answerable: false, answer: '', citations: [] });
  const result = await answerQuestion({ store, llm }, 'the-query');

  assert.equal(result.retrieved.length, 1);
  assert.equal(result.retrieved[0]?.score, expectedScore);
});

test('retries once after an unreadable completion and succeeds on the second call', async () => {
  const store = await buildFaqStore();
  const hits = await store.search('What are your hours?', TOP_K);
  const firstChunk = hits[0]?.chunk;
  assert.ok(firstChunk);

  let calls = 0;
  const llm: Llm = {
    async complete(_messages: ChatMessage[]): Promise<string> {
      calls += 1;
      if (calls === 1) return 'not valid json and no braces at all';
      return JSON.stringify({
        answerable: true,
        answer: 'We are open Tuesday through Sunday.',
        citations: [{ passage_id: firstChunk.id, quote: firstChunk.text.slice(0, 30) }],
      });
    },
  };

  const result = await answerQuestion({ store, llm }, 'What are your hours?');

  assert.equal(calls, 2);
  assert.equal(result.answerable, true);
});

test('rejects with ModelOutputError when both the call and the retry are unreadable', async () => {
  const store = await buildFaqStore();
  let calls = 0;
  const llm: Llm = {
    async complete(): Promise<string> {
      calls += 1;
      return 'still not valid json and no braces';
    },
  };

  await assert.rejects(() => answerQuestion({ store, llm }, 'What are your hours?'), ModelOutputError);
  assert.equal(calls, 2);
});
