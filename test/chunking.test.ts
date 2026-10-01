import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHUNK_CHARS,
  chunkPdfPages,
  chunkText,
  cleanPdfText,
  splitSentences,
} from '../src/chunking.js';

test('MAX_CHUNK_CHARS is 900', () => {
  assert.equal(MAX_CHUNK_CHARS, 900);
});

// --- cleanPdfText: PDF artefacts ---------------------------------------

test('cleanPdfText removes soft hyphens', () => {
  assert.equal(cleanPdfText('soft­hyphen'), 'softhyphen');
});

test('cleanPdfText joins a word hyphenated across a line break when the next part is lowercase', () => {
  assert.equal(cleanPdfText('infor-\nmation'), 'information');
});

test('cleanPdfText does not join a hyphenated line break when the next part is capitalized', () => {
  const result = cleanPdfText('Fresh-\nCatch is today.');
  assert.ok(!result.includes('FreshCatch'));
  assert.equal(result, 'Fresh- Catch is today.');
});

test('cleanPdfText collapses repeated whitespace, including newlines, into single spaces', () => {
  assert.equal(
    cleanPdfText('line one\n\n  line   two\t\tline three'),
    'line one line two line three',
  );
});

test('cleanPdfText trims leading and trailing whitespace', () => {
  assert.equal(cleanPdfText('   padded text   '), 'padded text');
});

test('cleanPdfText is idempotent', () => {
  const input = 'Infor-\nmation   about­  the\n\nmenu. Fresh-\nCatch today.';
  const once = cleanPdfText(input);
  const twice = cleanPdfText(once);
  assert.equal(twice, once);
});

// --- splitSentences ------------------------------------------------------

test('splitSentences splits on sentence boundaries and trims each one', () => {
  const sentences = splitSentences('First sentence.   Second sentence!  Third sentence?');
  assert.deepEqual(sentences, ['First sentence.', 'Second sentence!', 'Third sentence?']);
});

test('splitSentences drops empty segments', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

// --- chunkText: sentence boundaries + overlap ----------------------------

test('chunkText packs whole sentences and overlaps the last sentence when the next one does not fit', () => {
  const s1 = 'Alpha bravo charlie.';
  const s2 = 'Delta echo foxtrot kilo.';
  const s3 = 'Golf.';
  const text = `${s1} ${s2} ${s3}`;
  const maxChars = s1.length + 1 + s2.length; // exactly fits s1+s2, not s1+s2+s3

  // Precondition for this test to actually exercise overlap.
  assert.ok(s2.length + 1 + s3.length <= maxChars);

  const chunks = chunkText(text, maxChars);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `${s1} ${s2}`);
  assert.equal(chunks[1], `${s2} ${s3}`);
  assert.equal(splitSentences(chunks[0] ?? '').at(-1), splitSentences(chunks[1] ?? '')[0]);
});

test('chunkText does not overlap when the previous chunk held only one sentence', () => {
  const s1 = 'Alpha bravo charlie delta echo foxtrot golf hotel.';
  const s2 = 'India.';
  const maxChars = s1.length; // only s1 fits; s2 cannot join it

  const chunks = chunkText(`${s1} ${s2}`, maxChars);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], s1);
  assert.equal(chunks[1], s2);
});

test('chunkText does not overlap when the overlap plus the next sentence would not fit', () => {
  const s1 = 'Golf.';
  const s2 = 'Delta echo foxtrot kilo.';
  const s3 = 'Hotel india juliet.';
  const maxChars = s1.length + 1 + s2.length;

  // Preconditions for this test to exercise the "no overlap" branch.
  assert.ok(s3.length <= maxChars, 'test setup: s3 must fit alone within maxChars');
  assert.ok(
    s2.length + 1 + s3.length > maxChars,
    'test setup: overlap of s2 + s3 must exceed maxChars',
  );

  const chunks = chunkText(`${s1} ${s2} ${s3}`, maxChars);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `${s1} ${s2}`);
  assert.equal(chunks[1], s3);
});

test('chunkText never splits a sentence across a chunk boundary', () => {
  const sentences = [
    'Alpha bravo charlie delta echo foxtrot.',
    'Golf hotel india juliet kilo lima mike.',
    'November oscar papa quebec romeo sierra.',
    'Tango uniform victor whiskey xray yankee.',
    'Zulu alpha bravo charlie delta echo foxtrot.',
  ];
  const text = sentences.join(' ');
  const chunks = chunkText(text, 60);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const isContiguousSliceOfSentences = sentences.some((_, start) =>
      sentences.some(
        (_, end) => end >= start && sentences.slice(start, end + 1).join(' ') === chunk,
      ),
    );
    assert.ok(isContiguousSliceOfSentences, `chunk is not whole sentences: "${chunk}"`);
  }
});

// --- chunkText: oversize text ---------------------------------------------

test('chunkText splits an oversize sentence at word boundaries into pieces of at most maxChars', () => {
  const longSentence = `${'lorem '.repeat(350).trim()}.`;
  assert.ok(longSentence.length > 2000);

  const chunks = chunkText(longSentence, 900);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 900);
  }
  assert.equal(chunks.join(' '), longSentence);
});

test('chunkText hard-splits a single word longer than maxChars', () => {
  const longWord = 'x'.repeat(1000);

  const chunks = chunkText(longWord, 900);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 900);
  assert.equal(chunks[1]?.length, 100);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 900);
  }
  assert.equal(chunks.join(''), longWord);
});

test('chunkText returns an empty array for empty or whitespace-only input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\t  '), []);
});

// --- chunkPdfPages ---------------------------------------------------------

test('chunkPdfPages labels chunks with their 1-based page number and skips blank pages', () => {
  const pages = [
    'Page one has some content about alpha and bravo.',
    '   \n  ',
    'Page three has different content about charlie and delta.',
  ];

  const chunks = chunkPdfPages(pages);
  const locations = chunks.map((chunk) => chunk.location);

  assert.ok(locations.includes('page 1'));
  assert.ok(locations.includes('page 3'));
  assert.ok(!locations.includes('page 2'));
  assert.ok(locations.every((location) => location === 'page 1' || location === 'page 3'));
});

test('chunkPdfPages never produces a chunk that mixes text from two pages', () => {
  const pages = [
    'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.',
    'Kilo lima mike november oscar papa quebec romeo sierra tango.',
  ];

  const chunks = chunkPdfPages(pages, 40); // small maxChars forces several chunks per page

  const page1Chunks = chunks.filter((chunk) => chunk.location === 'page 1');
  const page2Chunks = chunks.filter((chunk) => chunk.location === 'page 2');
  assert.ok(page1Chunks.length > 0);
  assert.ok(page2Chunks.length > 0);
  assert.ok(page1Chunks.every((chunk) => !chunk.text.includes('Kilo') && !chunk.text.includes('lima')));
  assert.ok(page2Chunks.every((chunk) => !chunk.text.includes('Alpha') && !chunk.text.includes('bravo')));
});

test('chunkPdfPages joins hyphenated words across a line break before chunking', () => {
  const chunks = chunkPdfPages(['This is infor-\nmation about the menu.']);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]?.text.includes('information'));
});
