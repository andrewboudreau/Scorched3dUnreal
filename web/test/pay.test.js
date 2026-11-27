import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, PAY } from '../src/core/game.js';

// Damage pay is for what a hit really took off: an overkill blast pays no
// more than the target's health and armor (the run carries money between fights).
test('damage pay stops at what the target had', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], seed: 3, resolution: 64 });
  g.start();
  const [a, b] = g.players;
  const had = b.hp + b.armor;
  const before = a.money;
  g.damage(b, 999, a.id);
  const paid = a.money - before - PAY.kill * (g.modifier.pay || 1);
  assert.ok(!b.alive);
  assert.equal(paid, Math.round(had * PAY.perDamage * (g.modifier.pay || 1)));
});
