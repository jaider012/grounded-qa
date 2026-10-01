import type { AskResult } from '../src/answer.js';

export type GoldenCategory = 'answerable' | 'unanswerable' | 'partial' | 'adversarial';

export interface GoldenCase {
  id: string;
  category: GoldenCategory;
  question: string;
  expectAnswerable: boolean;
  expectLocation?: string;
  expectSource?: string;
}

export interface CaseScore {
  pass: boolean;
  reason: string;
}

const DEFAULT_SOURCE = 'Bonaire Bites FAQ';

/**
 * Scores one `AskResult` against its golden expectation: the `answerable`
 * flag must match, and when the case is answerable, at least one citation
 * must match both the expected location and source (the FAQ by default).
 */
export function scoreCase(golden: GoldenCase, result: AskResult): CaseScore {
  if (result.answerable !== golden.expectAnswerable) {
    return golden.expectAnswerable
      ? { pass: false, reason: 'expected answerable, got refusal' }
      : { pass: false, reason: 'expected refusal, got an answer' };
  }

  if (!golden.expectAnswerable) {
    return { pass: true, reason: 'refusal as expected' };
  }

  const expectedSource = golden.expectSource ?? DEFAULT_SOURCE;
  const matched = result.citations.some(
    (citation) => citation.location === golden.expectLocation && citation.source === expectedSource,
  );
  if (matched) {
    return { pass: true, reason: 'citation matched' };
  }

  const citedLocations = result.citations.map((citation) => citation.location);
  const cited = citedLocations.length > 0 ? citedLocations.join(', ') : 'none';
  return { pass: false, reason: `no citation at ${golden.expectLocation} (cited: ${cited})` };
}

/** Aggregates case scores into an overall pass count and one count per category. */
export function summarize(
  rows: Array<{ golden: GoldenCase; score: CaseScore }>,
): { passed: number; total: number; byCategory: Record<GoldenCategory, { passed: number; total: number }> } {
  const byCategory: Record<GoldenCategory, { passed: number; total: number }> = {
    answerable: { passed: 0, total: 0 },
    unanswerable: { passed: 0, total: 0 },
    partial: { passed: 0, total: 0 },
    adversarial: { passed: 0, total: 0 },
  };

  let passed = 0;
  for (const row of rows) {
    const bucket = byCategory[row.golden.category];
    bucket.total += 1;
    if (row.score.pass) {
      bucket.passed += 1;
      passed += 1;
    }
  }

  return { passed, total: rows.length, byCategory };
}

const CATEGORIES: readonly GoldenCategory[] = ['answerable', 'unanswerable', 'partial', 'adversarial'];

function isGoldenCategory(value: unknown): value is GoldenCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

function describeEntry(entry: unknown, index: number): string {
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
    const id = (entry as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) return `"${id}" (index ${index})`;
  }
  return `at index ${index}`;
}

function parseGoldenCase(entry: unknown, index: number): GoldenCase {
  const label = describeEntry(entry, index);
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`Golden case ${label}: expected an object.`);
  }
  const record = entry as Record<string, unknown>;

  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Golden case ${label}: "id" must be a non-empty string.`);
  }

  const category = record['category'];
  if (!isGoldenCategory(category)) {
    throw new Error(
      `Golden case ${label}: "category" must be one of ${CATEGORIES.join(', ')}, got ${JSON.stringify(category)}.`,
    );
  }

  const question = record['question'];
  if (typeof question !== 'string' || question.length === 0) {
    throw new Error(`Golden case ${label}: "question" must be a non-empty string.`);
  }

  const expectAnswerable = record['expectAnswerable'];
  if (typeof expectAnswerable !== 'boolean') {
    throw new Error(`Golden case ${label}: "expectAnswerable" must be a boolean.`);
  }

  const expectLocation = record['expectLocation'];
  if (expectLocation !== undefined && typeof expectLocation !== 'string') {
    throw new Error(`Golden case ${label}: "expectLocation" must be a string when present.`);
  }

  const expectSource = record['expectSource'];
  if (expectSource !== undefined && typeof expectSource !== 'string') {
    throw new Error(`Golden case ${label}: "expectSource" must be a string when present.`);
  }

  const golden: GoldenCase = { id, category, question, expectAnswerable };
  if (expectLocation !== undefined) golden.expectLocation = expectLocation;
  if (expectSource !== undefined) golden.expectSource = expectSource;
  return golden;
}

/** Validates the golden-set JSON shape, throwing a clear Error naming the bad entry. */
export function parseGolden(raw: unknown): GoldenCase[] {
  if (!Array.isArray(raw)) {
    throw new Error('Golden set must be a JSON array of cases.');
  }
  return raw.map((entry, index) => parseGoldenCase(entry, index));
}
