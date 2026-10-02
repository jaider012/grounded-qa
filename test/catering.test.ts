import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATERING_SECTIONS, CATERING_SOURCE, cateringChunks } from '../src/catering.js';
import { FAQ_SOURCE, faqChunks } from '../src/faq.js';
import { VectorStore } from '../src/store.js';
import { answerQuestion } from '../src/answer.js';
import { bagOfWordsEmbedder, parsePassagesFromUserMessage, scriptedLlm } from './helpers.js';

const EXPECTED_LOCATIONS = ['Packages', 'Lead time', 'Dietary notes', 'Delivery'];

test('CATERING_SOURCE names the built-in document', () => {
  assert.equal(CATERING_SOURCE, 'Bonaire Bites Catering Menu');
});

test('CATERING_SECTIONS has the four expected sections in order', () => {
  assert.deepEqual(
    CATERING_SECTIONS.map((section) => section.title),
    EXPECTED_LOCATIONS,
  );
});

test('cateringChunks returns one chunk per section, prefixed with its title', () => {
  const chunks = cateringChunks();
  assert.deepEqual(
    chunks.map((chunk) => chunk.location),
    EXPECTED_LOCATIONS,
  );
  for (const chunk of chunks) {
    assert.ok(chunk.text.startsWith(`${chunk.location}: `));
  }
});

test('the Packages chunk keeps the verbatim prices and capacities', () => {
  const packages = cateringChunks().find((chunk) => chunk.location === 'Packages');
  assert.ok(packages);
  assert.ok(packages.text.includes('Casual (serves up to 20, $350)'));
  assert.ok(packages.text.includes('Celebration (serves up to 75, $1,200)'));
});

test('the Lead time chunk keeps the 15% rush fee wording', () => {
  const leadTime = cateringChunks().find((chunk) => chunk.location === 'Lead time');
  assert.ok(leadTime);
  assert.ok(leadTime.text.includes("at least 5 business days' notice"));
  assert.ok(leadTime.text.includes('may carry a 15% rush fee'));
});

test('a catering question retrieves a catering chunk and its citation verifies', async () => {
  const store = new VectorStore(bagOfWordsEmbedder());
  await store.addDocument(FAQ_SOURCE, faqChunks());
  await store.addDocument(CATERING_SOURCE, cateringChunks());

  const quote = 'at least 5 business days\' notice';
  const llm = scriptedLlm((messages) => {
    const passage = parsePassagesFromUserMessage(messages).find(
      (candidate) => candidate.source === CATERING_SOURCE && candidate.text.includes(quote),
    );
    if (passage === undefined) {
      return JSON.stringify({ answerable: false, answer: '', citations: [] });
    }
    return JSON.stringify({
      answerable: true,
      answer: 'Catering orders need at least 5 business days of notice.',
      citations: [{ passage_id: passage.id, quote }],
    });
  });

  const result = await answerQuestion(
    { store, llm },
    'How much notice do catering orders require? Lead time for a catering order',
  );

  assert.equal(result.answerable, true);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]?.source, CATERING_SOURCE);
  assert.equal(result.citations[0]?.location, 'Lead time');
  assert.equal(result.citations[0]?.quote, quote);
});
