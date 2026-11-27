// The armory's rules (docs/design-guide.md, "How you get things"): the
// starting kit, the tiers and when they open, the price yardstick, armory
// upgrades for a drafted mod, and the round's pay counted by where it came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, PAY, EARNINGS } from '../src/core/game.js';
import { WEAPONS, WEAPON_BY_ID, TIERS, startKit, opensOnVisit, shotValue, VALUE_BAND, VARIANT_WEAPONS, resolveWeapon } from '../src/core/weapons.js';
import { MOD_BY_ID } from '../src/core/mods.js';

const two = (extra = {}) => new Game({ players: [{ name: 'A' }, { name: 'B' }], seed: 3, resolution: 64, ...extra });

test('every weapon a player can hold names its role and tier', () => {
  for (const w of WEAPONS.filter((x) => !x.hidden)) {
    assert.ok(w.role, `${w.id} has a role`);
    assert.ok(TIERS[w.tier], `${w.id} has a known tier`);
    if (w.tier !== 'kit') assert.ok(w.price > 0 && w.bundle > 0, `${w.id} is for sale`);
  }
});

test('the starting kit comes from the weapon data, and every tank starts with it', () => {
  assert.deepEqual(startKit(), { shell: Infinity, guided: 1, breacher: 1, roller: 1, mound: 1, ranger: 2 });
  const g = two();
  g.start();
  for (const p of g.players) for (const [id, n] of Object.entries(startKit())) assert.equal(p.inventory[id], n, `${p.name} ${id}`);
  const online = two({ local: [0] });
  assert.equal(online.players[0].inventory.guided, 0, 'no Guided Missile online');
});

test('price yardstick: a damage weapon costs 0.5 to 1.4 dollars per point of what a good shot does', () => {
  for (const w of WEAPONS.filter((x) => x.role === 'Damage' && !x.infinite)) {
    const perShot = w.price / w.bundle;
    const rate = perShot / shotValue(w);
    assert.ok(rate >= VALUE_BAND[0] && rate <= VALUE_BAND[1], `${w.id}: $${perShot.toFixed(0)} a shot for ${shotValue(w).toFixed(0)} is ${rate.toFixed(2)} a point`);
  }
  // A shot that lands pays for itself: the armory never charges more a point than the game pays.
  assert.ok(VALUE_BAND[1] < PAY.perDamage);
});

test('price yardstick: every weapon variant, with and without its rank 2, is in the band at the base price', () => {
  // A variant is a trade, not a straight upgrade: it costs what the base does,
  // what a good shot does stays within the band and within a quarter of the
  // base's, and the rank 2 upgrade adds at most a quarter more.
  for (const w of VARIANT_WEAPONS) {
    const perShot = w.price / w.bundle;
    for (const v of w.variants) {
      const r = resolveWeapon(w, v.id), up = resolveWeapon(w, v.id, true);
      for (const x of [r, up]) {
        const rate = perShot / shotValue(x);
        assert.ok(rate >= VALUE_BAND[0] && rate <= VALUE_BAND[1], `${x.label}${x.upgraded ? ' +' : ''}: ${rate.toFixed(2)} a point`);
      }
      assert.ok(Math.abs(shotValue(r) / shotValue(w) - 1) <= 0.25, `${r.label}: ${shotValue(r).toFixed(0)} against ${shotValue(w).toFixed(0)}`);
      assert.ok(shotValue(up) / shotValue(r) <= 1.25, `${r.label} +: ${shotValue(up).toFixed(0)} against ${shotValue(r).toFixed(0)}`);
    }
  }
});

test('Advanced weapons open on the second armory visit; a short match opens them on its only one', () => {
  assert.equal(opensOnVisit(WEAPON_BY_ID.breacher, 5), 1);
  assert.equal(opensOnVisit(WEAPON_BY_ID.thunderhead, 5), 2);
  assert.equal(opensOnVisit(WEAPON_BY_ID.thunderhead, 2), 1, 'two rounds: one visit, everything in it');
  const g = two({ rounds: 3 });
  g.start();
  const a = g.players[0];
  a.money = 5000;
  assert.equal(g.round, 1);
  assert.ok(g.inStock('breacher'));
  assert.equal(g.inStock('thunderhead'), false);
  assert.equal(g.priceOf(a, 'thunderhead'), Infinity);
  assert.equal(g.buy(0, 'scatter'), false, 'Scatter is Advanced');
  g.round = 2;   // the second visit, before round 3
  assert.equal(g.priceOf(a, 'thunderhead'), WEAPON_BY_ID.thunderhead.price);
  assert.ok(g.buy(0, 'thunderhead'));
  assert.equal(a.inventory.thunderhead, 1);
});

test('mod levels are skill ranks, not armory stock, unless the Lab sells them', () => {
  const g = two();
  g.start();
  const a = g.players[0];
  a.money = 5000;
  a.perks.push('orbital');
  assert.equal(g.modLevel(a, 'orbiter'), 1);
  assert.equal(g.priceOf(a, 'orbiter'), Infinity, 'points buy levels, money does not');
  const shop = two({ lab: { orbiter: 'shop' } });
  shop.start();
  const s = shop.players[0];
  s.money = 5000;
  assert.equal(shop.priceOf(s, 'orbiter'), MOD_BY_ID.orbiter.prices[0]);
  assert.ok(shop.buy(0, 'orbiter'));
  assert.ok(shop.buy(0, 'orbiter'));
  assert.ok(shop.buy(0, 'orbiter'));
  assert.equal(shop.modLevel(s, 'orbiter'), 3);
  assert.equal(shop.buy(0, 'orbiter'), false, 'top level');
});

test("a round's pay is counted by where it came from", () => {
  const g = two({ rounds: 2 });
  g.start();
  const [a, b] = g.players;
  const start = a.money;
  g.damage(b, 30, 0);
  b.alive = false;
  g.endRound();
  const sum = Object.values(a.earned).reduce((s, n) => s + n, 0);
  assert.equal(a.money - start, sum, 'the parts add up to what it earned');
  assert.equal(a.earned.damage, 30 * PAY.perDamage);
  assert.equal(a.earned.win, PAY.roundWin);
  assert.equal(a.earned.stipend, PAY.stipend);
  assert.equal(b.earned.survive, undefined, 'destroyed: no survival pay');
  for (const k of Object.keys(a.earned)) assert.ok(EARNINGS.includes(k), k);
});
