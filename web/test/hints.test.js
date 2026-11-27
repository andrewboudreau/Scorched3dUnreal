import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHint, hintLeft, hintCount, resetHints } from '../src/hints.js';

const memory = (start = {}) => {
  const m = new Map(Object.entries(start));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
};

test('a hint shows its first few times, then never again', () => {
  const s = memory();
  assert.deepEqual([1, 2, 3, 4, 5].map(() => useHint('sight', 3, s)), [true, true, true, false, false]);
  assert.equal(hintCount('sight', s), 3);
  assert.equal(hintLeft('sight', 3, s), false);
});

test('each hint counts on its own, and peeking does not count', () => {
  const s = memory();
  assert.equal(hintLeft('pad', 2, s), true);
  assert.equal(hintLeft('pad', 2, s), true);
  assert.equal(hintCount('pad', s), 0);
  assert.equal(useHint('pad', 2, s), true);
  assert.equal(useHint('lockin', 1, s), true);
  assert.equal(useHint('lockin', 1, s), false);
  assert.equal(useHint('pad', 2, s), true);
  assert.equal(useHint('pad', 2, s), false);
});

test('the count survives a reload (it is in storage)', () => {
  const s = memory();
  useHint('sight', 2, s);
  const later = memory(Object.fromEntries(s.raw));
  assert.equal(useHint('sight', 2, later), true);
  assert.equal(useHint('sight', 2, later), false);
});

test('a bad or missing store never hides a hint for good', () => {
  assert.equal(useHint('sight', 3, null), true);
  assert.equal(hintCount('sight', null), 0);
  const junk = memory({ 'craterfall.hints': '[1,2' });
  assert.equal(useHint('sight', 1, junk), true);
  assert.equal(useHint('sight', 1, junk), false);
  const array = memory({ 'craterfall.hints': '[3]' });
  assert.equal(useHint('sight', 1, array), true);
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.equal(useHint('sight', 1, full), true);
  assert.equal(useHint('sight', 1, full), true, 'it cannot count, so it keeps showing rather than vanish');
});

test('resetHints teaches everything again', () => {
  const s = memory();
  useHint('sight', 1, s);
  assert.equal(useHint('sight', 1, s), false);
  resetHints(s);
  assert.equal(useHint('sight', 1, s), true);
});
