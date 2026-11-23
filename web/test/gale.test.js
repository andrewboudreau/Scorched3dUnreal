import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { GALE_CAP } from '../src/core/perks.js';

const round = (maxWind, modifier) => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, maxWind, modifier });
  g.start();
  return g.maxWind;
};

test('a Gale round lifts the wind 1.8x, but a Gale wind stops at the cap', () => {
  assert.ok(Math.abs(round(1.5, 'gale') - 2.7) < 1e-9);   // Gusty
  assert.ok(Math.abs(round(0.8, 'gale') - 1.44) < 1e-9);  // Breezy
  assert.equal(round(2.5, 'gale'), GALE_CAP);             // Gale on Gale: 3.5, not 4.5
  assert.equal(round(5, 'gale'), 5);                      // set above the cap: kept, never lowered
  assert.equal(round(2.5, 'clear'), 2.5);
  assert.equal(round(2.5, 'calm'), 0);
});
