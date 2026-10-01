import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAQ_SECTIONS, FAQ_SOURCE, faqChunks } from '../src/faq.js';

const EXPECTED_LOCATIONS = [
  'About',
  'Hours',
  'Reservations',
  'Dietary accommodations',
  'Loyalty program',
  'Delivery',
  'Private events',
];

test('FAQ_SOURCE names the built-in document', () => {
  assert.equal(FAQ_SOURCE, 'Bonaire Bites FAQ');
});

test('FAQ_SECTIONS has the seven expected sections in order', () => {
  assert.deepEqual(
    FAQ_SECTIONS.map((section) => section.title),
    EXPECTED_LOCATIONS,
  );
});

test('faqChunks returns one chunk per section with the expected locations in order', () => {
  const chunks = faqChunks();
  assert.equal(chunks.length, 7);
  assert.deepEqual(
    chunks.map((chunk) => chunk.location),
    EXPECTED_LOCATIONS,
  );
});

test('the About chunk is the intro paragraph as-is, with no title prefix', () => {
  const chunks = faqChunks();
  const about = chunks.find((chunk) => chunk.location === 'About');
  assert.ok(about);
  assert.ok(about.text.startsWith('Bonaire Bites is a small chain of three casual restaurants'));
  assert.ok(about.text.includes('chef Elena Martinez.'));
  assert.ok(!about.text.startsWith('About:'));
});

test('the Hours chunk is prefixed with its title, mirroring the FAQ format', () => {
  const chunks = faqChunks();
  const hours = chunks.find((chunk) => chunk.location === 'Hours');
  assert.ok(hours);
  assert.ok(
    hours.text.startsWith(
      'Hours: All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM.',
    ),
  );
});

test('the Delivery chunk keeps the en dash in "40–50 minutes"', () => {
  const chunks = faqChunks();
  const delivery = chunks.find((chunk) => chunk.location === 'Delivery');
  assert.ok(delivery);
  assert.ok(delivery.text.includes('40–50 minutes'));
});

test('the Reservations chunk keeps the em dash around "by phone only"', () => {
  const chunks = faqChunks();
  const reservations = chunks.find((chunk) => chunk.location === 'Reservations');
  assert.ok(reservations);
  assert.ok(
    reservations.text.includes(
      'by phone only — we do not currently accept online reservations.',
    ),
  );
});

test('the Loyalty program chunk keeps straight quotes and the accented word "entrée"', () => {
  const chunks = faqChunks();
  const loyalty = chunks.find((chunk) => chunk.location === 'Loyalty program');
  assert.ok(loyalty);
  assert.ok(loyalty.text.includes('"Bites Club"'));
  assert.ok(loyalty.text.includes('entrée'));
});
