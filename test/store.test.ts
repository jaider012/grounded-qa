import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Embedder } from '../src/embeddings.js';
import { VectorStore } from '../src/store.js';
import { bagOfWordsEmbedder } from './helpers.js';

test('assigns sequential, never-reused ids across documents', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument('doc-a', [
    { location: 'p1', text: 'alpha bravo' },
    { location: 'p2', text: 'charlie delta' },
  ]);
  await store.addDocument('doc-b', [{ location: 'p1', text: 'echo foxtrot' }]);

  const results = await store.search('alpha bravo charlie delta echo foxtrot', 10);
  const ids = results.map((result) => result.chunk.id).sort();
  assert.deepEqual(ids, ['c1', 'c2', 'c3']);
});

test('search ranks the chunk sharing the most words first and returns at most k', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument('menu', [
    { location: 'hours', text: 'We are open Tuesday through Sunday for dinner service.' },
    { location: 'delivery', text: 'Delivery takes about forty to fifty minutes in Bonaire.' },
    { location: 'events', text: 'Private events need a deposit and advance notice.' },
  ]);

  const results = await store.search('What are your hours on Sunday and Tuesday?', 2);

  assert.equal(results.length, 2);
  assert.equal(results[0]?.chunk.location, 'hours');
});

test('re-adding a document with the same name replaces its chunks and continues the id counter', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument('menu', [{ location: 'a', text: 'alpha' }]);
  const summary = await store.addDocument('menu', [
    { location: 'b', text: 'bravo' },
    { location: 'c', text: 'charlie' },
  ]);

  assert.deepEqual(summary, { name: 'menu', chunks: 2 });
  assert.equal(store.documentCount, 1);
  assert.deepEqual(store.listDocuments(), [{ name: 'menu', chunks: 2 }]);

  const results = await store.search('bravo charlie', 10);
  const ids = results.map((result) => result.chunk.id).sort();
  assert.deepEqual(ids, ['c2', 'c3']);
});

test('listDocuments reports chunk counts in insertion order', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument('b-doc', [{ location: 'a', text: 'one two' }]);
  await store.addDocument('a-doc', [
    { location: 'a', text: 'three four' },
    { location: 'b', text: 'five six' },
  ]);

  assert.deepEqual(store.listDocuments(), [
    { name: 'b-doc', chunks: 1 },
    { name: 'a-doc', chunks: 2 },
  ]);
});

test('throws when a vector arrives with a different dimension than the store', async () => {
  let call = 0;
  const embedder: Embedder = async (texts) => {
    call += 1;
    const dims = call === 1 ? 4 : 6;
    return texts.map(() => new Array(dims).fill(0.5));
  };
  const store = new VectorStore(embedder);

  await store.addDocument('first', [{ location: 'a', text: 'alpha' }]);

  await assert.rejects(
    () => store.addDocument('second', [{ location: 'b', text: 'bravo' }]),
    /dimension/i,
  );
});

test('search throws when the query vector has a different dimension than the store', async () => {
  let call = 0;
  const embedder: Embedder = async (texts) => {
    call += 1;
    const dims = call === 1 ? 4 : 6;
    return texts.map(() => new Array(dims).fill(0.5));
  };
  const store = new VectorStore(embedder);

  await store.addDocument('first', [{ location: 'a', text: 'alpha' }]);

  await assert.rejects(() => store.search('alpha'), /dimension/i);
});

test('throws a clear error for an empty parts array', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await assert.rejects(() => store.addDocument('empty', []), /no chunks/i);
});

test('an empty store returns no results without calling the embedder', async () => {
  let called = false;
  const embedder: Embedder = async (texts) => {
    called = true;
    return texts.map(() => [0, 0]);
  };
  const store = new VectorStore(embedder);

  const results = await store.search('anything');

  assert.deepEqual(results, []);
  assert.equal(called, false);
});

test('search defaults k to 5', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument(
    'many',
    Array.from({ length: 8 }, (_, i) => ({ location: `p${i}`, text: `word${i} filler text` })),
  );

  const results = await store.search('word1 word2 word3 filler text');

  assert.equal(results.length, 5);
});
