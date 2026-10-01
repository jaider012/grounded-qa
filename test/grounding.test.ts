import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chunk } from '../src/store.js';
import {
  MIN_QUOTE_CHARS,
  REFUSAL,
  locateQuote,
  normalizeForMatch,
  refusal,
  verifyAnswer,
} from '../src/grounding.js';

const chunks: Chunk[] = [
  {
    id: 'c1',
    source: 'Bonaire Bites FAQ',
    location: 'Hours',
    text: 'Hours: All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
    vector: [],
  },
  {
    id: 'c2',
    source: 'Bonaire Bites FAQ',
    location: 'Delivery',
    text: 'Delivery orders have a minimum of $25 and take approximately 40–50 minutes.',
    vector: [],
  },
];

// --- refusal / constants ----------------------------------------------------

test('refusal returns the fixed unanswerable shape', () => {
  assert.deepEqual(refusal(), { answerable: false, answer: REFUSAL, citations: [] });
});

test('MIN_QUOTE_CHARS is 12', () => {
  assert.equal(MIN_QUOTE_CHARS, 12);
});

// --- normalizeForMatch -------------------------------------------------------

test('normalizeForMatch converts curly quotes and dashes to their canonical ASCII form', () => {
  const input = '“Hello—world’s – test”'; // "Hello—world’s – test"
  assert.equal(normalizeForMatch(input), '"Hello-world\'s - test"');
});

test('normalizeForMatch collapses whitespace runs, including newlines, and trims', () => {
  assert.equal(normalizeForMatch('  Hello   World  \n\t '), 'Hello World');
});

test('normalizeForMatch is case-sensitive', () => {
  assert.equal(normalizeForMatch('Hello WORLD'), 'Hello WORLD');
});

test('normalizeForMatch drops soft hyphens', () => {
  assert.equal(normalizeForMatch('soft­hyphen'), 'softhyphen');
});

// --- locateQuote -------------------------------------------------------------

test('locateQuote finds a verbatim quote and returns the exact passage substring', () => {
  const passage = chunks[0]?.text ?? '';
  const found = locateQuote(passage, 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.');
  assert.equal(found, 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.');
});

test('locateQuote tolerates curly quotes, an en dash substituted with a hyphen, and extra whitespace', () => {
  const passage = chunks[1]?.text ?? '';
  const found = locateQuote(passage, '“approximately   40-50 minutes”');
  assert.equal(found, 'approximately 40–50 minutes');
});

test('locateQuote tolerates the quote wrapped in straight quote marks', () => {
  const passage = chunks[0]?.text ?? '';
  const found = locateQuote(passage, '"All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM."');
  assert.equal(found, 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.');
});

test('locateQuote strips a leading and trailing ellipsis before matching', () => {
  const passage = chunks[0]?.text ?? '';
  const found = locateQuote(passage, '...are open Tuesday through Sunday, 11:00 AM...');
  assert.equal(found, 'are open Tuesday through Sunday, 11:00 AM');
});

test('locateQuote returns null for a quote shorter than MIN_QUOTE_CHARS', () => {
  assert.equal(locateQuote(chunks[0]?.text ?? '', 'Hours: All'), null);
});

test('locateQuote returns null when the quote is not found in the passage', () => {
  assert.equal(
    locateQuote(chunks[0]?.text ?? '', 'this exact phrase is nowhere in the passage'),
    null,
  );
});

// --- verifyAnswer -------------------------------------------------------------

test('keeps a citation whose quote appears verbatim in the cited passage', () => {
  const output = {
    answerable: true,
    answer: 'Yes, we are open Tuesday through Sunday.',
    citations: [
      {
        passage_id: 'c1',
        quote: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
      },
    ],
  };

  const result = verifyAnswer(output, chunks);

  assert.equal(result.answerable, true);
  assert.equal(result.answer, 'Yes, we are open Tuesday through Sunday.');
  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], {
    source: 'Bonaire Bites FAQ',
    location: 'Hours',
    quote: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
    passage: chunks[0]?.text,
  });
});

test('drops a citation whose quote exists in a different passage than the one cited', () => {
  const output = {
    answerable: true,
    answer: 'We are open Tuesday through Sunday, and delivery takes 40 to 50 minutes.',
    citations: [
      { passage_id: 'c1', quote: 'approximately 40–50 minutes' }, // this text is in c2, not c1
      {
        passage_id: 'c1',
        quote: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
      },
    ],
  };

  const result = verifyAnswer(output, chunks);

  assert.equal(result.answerable, true);
  assert.equal(result.citations.length, 1);
  assert.equal(
    result.citations[0]?.quote,
    'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
  );
});

test('drops an invented quote that does not appear in any retrieved passage', () => {
  const output = {
    answerable: true,
    answer: 'We opened in 2019.',
    citations: [{ passage_id: 'c1', quote: 'This text was never actually in the passage at all.' }],
  };

  assert.deepEqual(verifyAnswer(output, chunks), refusal());
});

test('drops a citation that cites a passage id absent from retrieved', () => {
  const output = {
    answerable: true,
    answer: 'We are open Tuesday through Sunday.',
    citations: [
      {
        passage_id: 'c999',
        quote: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
      },
    ],
  };

  assert.deepEqual(verifyAnswer(output, chunks), refusal());
});

test('malformed model output becomes a refusal', () => {
  assert.deepEqual(verifyAnswer(null, chunks), refusal());
  assert.deepEqual(verifyAnswer('a plain string', chunks), refusal());
  assert.deepEqual(verifyAnswer([], chunks), refusal());
  assert.deepEqual(verifyAnswer({ answerable: true }, chunks), refusal());
  assert.deepEqual(
    verifyAnswer({ answerable: true, answer: 'x', citations: 'not an array' }, chunks),
    refusal(),
  );
  assert.deepEqual(
    verifyAnswer({ answerable: 'true', answer: 'x', citations: [] }, chunks),
    refusal(),
  );
});

test('answerable false returns the refusal even when the model wrote an answer', () => {
  const output = {
    answerable: false,
    answer: 'This is leaked general knowledge the model should not have written.',
    citations: [],
  };

  const result = verifyAnswer(output, chunks);

  assert.deepEqual(result, refusal());
  assert.equal(result.answer, REFUSAL);
});

test('an empty-after-trim answer becomes a refusal', () => {
  const output = { answerable: true, answer: '   ', citations: [] };
  assert.deepEqual(verifyAnswer(output, chunks), refusal());
});

test('drops a citation whose quote is shorter than MIN_QUOTE_CHARS after cleaning', () => {
  const output = {
    answerable: true,
    answer: 'Yes.',
    citations: [{ passage_id: 'c1', quote: 'Hours: All' }],
  };

  assert.deepEqual(verifyAnswer(output, chunks), refusal());
});

test('returns the refusal when every citation is invalid', () => {
  const output = {
    answerable: true,
    answer: 'An answer with only bad citations.',
    citations: [
      { passage_id: 'c1', quote: 'invented text that is not in any passage' },
      {
        passage_id: 'nope',
        quote: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
      },
    ],
  };

  assert.deepEqual(verifyAnswer(output, chunks), refusal());
});

test('tolerates curly quotes, an en dash, and extra whitespace in the quote', () => {
  const output = {
    answerable: true,
    answer: 'Delivery takes 40 to 50 minutes.',
    citations: [{ passage_id: 'c2', quote: '“approximately   40-50 minutes”' }],
  };

  const result = verifyAnswer(output, chunks);

  assert.equal(result.answerable, true);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]?.quote, 'approximately 40–50 minutes');
});

test('tolerates the quote being wrapped in quote marks', () => {
  const output = {
    answerable: true,
    answer: 'Yes, open Tuesday to Sunday.',
    citations: [
      {
        passage_id: 'c1',
        quote: '"All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM."',
      },
    ],
  };

  const result = verifyAnswer(output, chunks);

  assert.equal(result.answerable, true);
  assert.equal(result.citations.length, 1);
  assert.equal(
    result.citations[0]?.quote,
    'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
  );
});

test('dedupes identical (passage id, span) citation pairs', () => {
  const output = {
    answerable: true,
    answer: 'Yes, we are open Tuesday through Sunday.',
    citations: [
      {
        passage_id: 'c1',
        quote: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
      },
      {
        passage_id: 'c1',
        quote: '"All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM."',
      },
    ],
  };

  const result = verifyAnswer(output, chunks);

  assert.equal(result.citations.length, 1);
});
