import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lockedBanner, volleyBanner, volleyHero, needsHandoff, firstTurnHints, lostBanner, landingPip, voidBanner, destroyedBanner,
  scoutBannerShows, propScale, nearestBlast, addDirty,
} from '../src/eventlogic.js';

const human = (id, o = {}) => ({ id, name: `P${id}`, alive: true, ai: null, shots: [], ...o });

test('banners: locked in, fire, the void, destroyed', () => {
  assert.deepEqual(lockedBanner(false), ['Locked in', '', 700]);
  assert.deepEqual(lockedBanner(true), ['Passed', 'Reloading after a Double Strike', 1000]);
  assert.deepEqual(volleyBanner(3), ['Fire!', '3 tanks, all together', 1300]);
  assert.deepEqual(voidBanner({ id: 1, name: 'Rook' }, 1, false), ['You fell into the void', '', 1800]);
  assert.deepEqual(voidBanner({ id: 1, name: 'Rook' }, null, true), ['Rook sank', '', 1800]);
  const p = { name: 'Rook' }, q = { name: 'Vex' };
  assert.deepEqual(destroyedBanner(p, q), ['Rook destroyed', 'by Vex', 1800]);
  assert.deepEqual(destroyedBanner(p, p), ['Rook destroyed', 'self-inflicted', 1800]);
  assert.deepEqual(destroyedBanner(p, null), ['Rook destroyed', '', 1800]);
});

test('a volley rides the one human of this screen in it', () => {
  const a = human(0), b = human(1), dead = human(2, { alive: false });
  assert.equal(volleyHero([a], [0, 3]), 0);
  assert.equal(volleyHero([a, b], [0, 1]), null);
  assert.equal(volleyHero([a, b], [1, 3]), 1);
  assert.equal(volleyHero([dead], [2]), null);
  assert.equal(volleyHero([], [0]), null);
});

test('the hand-off card: two or more humans still in it, planning', () => {
  const a = human(0), b = human(1);
  assert.equal(needsHandoff({ plan: true }, a, [a, b]), true);
  assert.equal(needsHandoff({ plan: false }, a, [a, b]), false);
  assert.equal(needsHandoff({ plan: true }, a, [a]), false);
  assert.equal(needsHandoff({ plan: true }, a, [a, { ...b, alive: false }]), false);
  assert.equal(needsHandoff({ plan: true }, { ...a, ai: 'normal' }, [a, b]), false);
});

test('first-turn hints: a phone, a human with no shots yet, round 1, once a game', () => {
  const p = human(0), game = { round: 1 };
  assert.equal(firstTurnHints({ touch: {}, p, game, hinted: null }), true);
  assert.equal(firstTurnHints({ touch: null, p, game, hinted: null }), false);
  assert.equal(firstTurnHints({ touch: {}, p, game, hinted: game }), false);
  assert.equal(firstTurnHints({ touch: {}, p: { ...p, shots: [1] }, game, hinted: null }), false);
  assert.equal(firstTurnHints({ touch: {}, p, game: { round: 2 }, hinted: null }), false);
});

test('a lost shell: which words, and only for this screen once shells fly', () => {
  const base = { probe: null, phase: 'flight', heroId: null, owner: 1, isles: false };
  assert.deepEqual(lostBanner({ type: 'lost' }, base), ['Out of the arena', '', 900]);
  assert.deepEqual(lostBanner({ type: 'lost' }, { ...base, isles: true }), ['Lost in the void', '', 900]);
  assert.deepEqual(lostBanner({ type: 'impact', splash: true }, base), ['In the sea', '', 900]);
  assert.equal(lostBanner({ type: 'impact' }, base), null);
  assert.equal(lostBanner({ type: 'lost' }, { ...base, probe: {} }), null);
  assert.equal(lostBanner({ type: 'lost' }, { ...base, phase: 'aim' }), null);
  assert.equal(lostBanner({ type: 'lost' }, { ...base, heroId: 0 }), null);
  assert.deepEqual(lostBanner({ type: 'lost' }, { ...base, heroId: 1 }), ['Out of the arena', '', 900]);
});

test('landing pips: the other tanks of a one-hero volley', () => {
  const o = { volleyMode: true, heroId: 0, owner: 1 };
  assert.equal(landingPip({ type: 'impact' }, o), true);
  assert.equal(landingPip({ type: 'lost' }, o), false);
  assert.equal(landingPip({ type: 'impact' }, { ...o, owner: 0 }), false);
  assert.equal(landingPip({ type: 'impact' }, { ...o, heroId: null }), false);
  assert.equal(landingPip({ type: 'impact' }, { ...o, volleyMode: false }), false);
  assert.equal(landingPip({ type: 'impact' }, { ...o, owner: null }), false);
});

test('scouts and props', () => {
  assert.equal(scoutBannerShows(false, null, 3), true);
  assert.equal(scoutBannerShows(true, 3, 3), true);
  assert.equal(scoutBannerShows(true, null, 3), true);
  assert.equal(scoutBannerShows(true, 1, 3), false);
  assert.equal(propScale('ruin'), 1);
  assert.equal(propScale('hit'), 0.6);
  assert.equal(propScale('collapse'), 0.4);
});

test('a dying tank is thrown from the nearest blast within 6 m', () => {
  const p = { x: 0, y: 0, z: 0 };
  const near = { pos: [10, 0, 0], radius: 5 }, far = { pos: [30, 0, 0], radius: 5 };
  assert.equal(nearestBlast([far, near], p), near);
  assert.equal(nearestBlast([far], p), null);
  assert.equal(nearestBlast([], p), null);
  assert.equal(nearestBlast([{ pos: [11, 0, 0], radius: 5 }], p).pos[0], 11);   // edge 6 m away
});

test('craters of one frame merge where they overlap', () => {
  const dirty = [];
  addDirty(dirty, { i0: 0, i1: 4, j0: 0, j1: 4 });
  addDirty(dirty, { i0: 10, i1: 12, j0: 10, j1: 12 });
  assert.equal(dirty.length, 2);
  addDirty(dirty, { i0: 3, i1: 6, j0: 3, j1: 6 });   // overlaps the first
  assert.deepEqual(dirty, [{ i0: 10, i1: 12, j0: 10, j1: 12 }, { i0: 0, i1: 6, j0: 0, j1: 6 }]);
  // A box that bridges both takes them both in, the second through the grown box.
  addDirty(dirty, { i0: 6, i1: 10, j0: 6, j1: 10 });
  assert.deepEqual(dirty, [{ i0: 0, i1: 12, j0: 0, j1: 12 }]);
  // Only touching corners count as overlap too (shared edge rows).
  addDirty(dirty, { i0: 12, i1: 14, j0: 12, j1: 14 });
  assert.deepEqual(dirty, [{ i0: 0, i1: 14, j0: 0, j1: 14 }]);
  addDirty(dirty, { i0: 20, i1: 21, j0: 0, j1: 1 });
  assert.equal(dirty.length, 2);
});
