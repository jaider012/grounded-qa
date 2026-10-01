import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AskResult } from '../src/answer.js';
import type { GoldenCase } from '../scripts/eval-score.js';
import { parseGolden, scoreCase, summarize } from '../scripts/eval-score.js';

function askResult(overrides: Partial<AskResult> = {}): AskResult {
  return {
    answerable: true,
    answer: 'An answer.',
    citations: [],
    retrieved: [],
    ...overrides,
  };
}

function golden(overrides: Partial<GoldenCase> & Pick<GoldenCase, 'id' | 'category' | 'expectAnswerable'>): GoldenCase {
  return { question: 'A question?', ...overrides };
}

// --- scoreCase: pass paths ----------------------------------------------------

test('scoreCase passes when a refusal was expected and the result refused', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'unanswerable', expectAnswerable: false }),
    askResult({ answerable: false, answer: '', citations: [] }),
  );
  assert.equal(score.pass, true);
});

test('scoreCase passes when a citation matches the expected location and the default source', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'answerable', expectAnswerable: true, expectLocation: 'Hours' }),
    askResult({
      answerable: true,
      citations: [{ source: 'Bonaire Bites FAQ', location: 'Hours', quote: 'q', passage: 'p' }],
    }),
  );
  assert.equal(score.pass, true);
});

test('scoreCase uses expectSource instead of the default when provided', () => {
  const score = scoreCase(
    golden({
      id: 'g1',
      category: 'answerable',
      expectAnswerable: true,
      expectLocation: 'page 2',
      expectSource: 'catering-guide.pdf',
    }),
    askResult({
      answerable: true,
      citations: [{ source: 'catering-guide.pdf', location: 'page 2', quote: 'q', passage: 'p' }],
    }),
  );
  assert.equal(score.pass, true);
});

test('scoreCase passes when one of several citations matches', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'answerable', expectAnswerable: true, expectLocation: 'Hours' }),
    askResult({
      answerable: true,
      citations: [
        { source: 'Bonaire Bites FAQ', location: 'Reservations', quote: 'q', passage: 'p' },
        { source: 'Bonaire Bites FAQ', location: 'Hours', quote: 'q2', passage: 'p2' },
      ],
    }),
  );
  assert.equal(score.pass, true);
});

// --- scoreCase: fail paths -----------------------------------------------------

test('scoreCase fails when answerable was expected but the result refused', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'answerable', expectAnswerable: true, expectLocation: 'Hours' }),
    askResult({ answerable: false, answer: '', citations: [] }),
  );
  assert.equal(score.pass, false);
  assert.equal(score.reason, 'expected answerable, got refusal');
});

test('scoreCase fails when a refusal was expected but the result answered', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'unanswerable', expectAnswerable: false }),
    askResult({
      answerable: true,
      citations: [{ source: 'Bonaire Bites FAQ', location: 'Hours', quote: 'q', passage: 'p' }],
    }),
  );
  assert.equal(score.pass, false);
  assert.equal(score.reason, 'expected refusal, got an answer');
});

test('scoreCase fails and names the cited location when it does not match', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'answerable', expectAnswerable: true, expectLocation: 'Hours' }),
    askResult({
      answerable: true,
      citations: [{ source: 'Bonaire Bites FAQ', location: 'Reservations', quote: 'q', passage: 'p' }],
    }),
  );
  assert.equal(score.pass, false);
  assert.equal(score.reason, 'no citation at Hours (cited: Reservations)');
});

test('scoreCase fails when the location matches but the source does not', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'answerable', expectAnswerable: true, expectLocation: 'Hours' }),
    askResult({
      answerable: true,
      citations: [{ source: 'Some Other Document', location: 'Hours', quote: 'q', passage: 'p' }],
    }),
  );
  assert.equal(score.pass, false);
  assert.match(score.reason, /no citation at Hours/);
});

test('scoreCase reports "none" when an answerable result has no citations at all', () => {
  const score = scoreCase(
    golden({ id: 'g1', category: 'answerable', expectAnswerable: true, expectLocation: 'Hours' }),
    askResult({ answerable: true, citations: [] }),
  );
  assert.equal(score.pass, false);
  assert.equal(score.reason, 'no citation at Hours (cited: none)');
});

// --- summarize -----------------------------------------------------------------

test('summarize counts passes and totals overall and per category', () => {
  const rows = [
    { golden: golden({ id: 'g1', category: 'answerable', expectAnswerable: true }), score: { pass: true, reason: 'ok' } },
    { golden: golden({ id: 'g2', category: 'answerable', expectAnswerable: true }), score: { pass: false, reason: 'no' } },
    {
      golden: golden({ id: 'g3', category: 'unanswerable', expectAnswerable: false }),
      score: { pass: true, reason: 'ok' },
    },
  ];

  const summary = summarize(rows);

  assert.equal(summary.passed, 2);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byCategory.answerable, { passed: 1, total: 2 });
  assert.deepEqual(summary.byCategory.unanswerable, { passed: 1, total: 1 });
  assert.deepEqual(summary.byCategory.partial, { passed: 0, total: 0 });
  assert.deepEqual(summary.byCategory.adversarial, { passed: 0, total: 0 });
});

test('summarize returns zeroed counts for an empty row set', () => {
  const summary = summarize([]);
  assert.equal(summary.passed, 0);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.byCategory.answerable, { passed: 0, total: 0 });
});

// --- parseGolden -----------------------------------------------------------------

test('parseGolden accepts a well-formed array', () => {
  const raw = [
    { id: 'g1', category: 'answerable', question: 'Q?', expectAnswerable: true, expectLocation: 'Hours' },
    { id: 'g2', category: 'unanswerable', question: 'Q2?', expectAnswerable: false },
  ];

  const parsed = parseGolden(raw);

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    id: 'g1',
    category: 'answerable',
    question: 'Q?',
    expectAnswerable: true,
    expectLocation: 'Hours',
  });
  assert.deepEqual(parsed[1], { id: 'g2', category: 'unanswerable', question: 'Q2?', expectAnswerable: false });
});

test('parseGolden rejects a non-array', () => {
  assert.throws(() => parseGolden({ not: 'an array' }), /array/);
});

test('parseGolden rejects a missing field, naming the bad entry', () => {
  const raw = [{ id: 'g1', category: 'answerable', expectAnswerable: true }]; // missing "question"
  assert.throws(() => parseGolden(raw), /g1/);
  assert.throws(() => parseGolden(raw), /question/);
});

test('parseGolden rejects an unknown category', () => {
  const raw = [{ id: 'g1', category: 'bogus', question: 'Q?', expectAnswerable: true }];
  assert.throws(() => parseGolden(raw), /category/);
});

test('parseGolden rejects a non-boolean expectAnswerable', () => {
  const raw = [{ id: 'g1', category: 'answerable', question: 'Q?', expectAnswerable: 'yes' }];
  assert.throws(() => parseGolden(raw), /expectAnswerable/);
});
