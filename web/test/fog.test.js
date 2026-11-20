import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, FOG } from '../src/core/game.js';
import { WEAPON_BY_ID } from '../src/core/weapons.js';

const make = (players, extra = {}) => {
  const g = new Game({ players, rounds: 2, seed: 7, resolution: 64, twists: false, fog: true, ...extra });
  g.start();
  return g;
};
const run = (g, stop, limit = 30000) => {
  for (let k = 0; k < limit && !stop(g); k++) { g.update(1 / 30); g.drainEvents(); }
  assert.ok(stop(g), 'the game got there');
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('fog: far tanks are out of sight, but each has a rough fix on the other', () => {
  const g = make([{ name: 'A' }, { name: 'B' }]);
  const [a, b] = g.players;
  assert.ok(dist(a, b) > FOG.sight);
  assert.equal(g.inSight(a, b), false);
  assert.equal(g.inSight(a, a), true);
  const i = g.intel[a.id][b.id];
  assert.equal(i.r, FOG.rough);
  assert.ok(Math.hypot(i.x - b.x, i.z - b.z) <= FOG.rough);
  assert.ok(Math.hypot(i.x - b.x, i.z - b.z) > 0, 'not exact');
  assert.equal(a.inventory.scout, 1, 'a free scout');
});

test('fog: without it, everyone sees everyone and no scouts are handed out', () => {
  const g = make([{ name: 'A' }, { name: 'B' }], { fog: false });
  const [a, b] = g.players;
  assert.equal(g.inSight(a, b), true);
  assert.ok(!(a.inventory.scout > 0));
  assert.equal(g.knownFoes(a)[0], b);
});

test('fog: close tanks see each other exactly', () => {
  const g = make([{ name: 'A' }, { name: 'B' }]);
  const [a, b] = g.players;
  b.x = a.x + FOG.sight * 0.5; b.z = a.z;
  g.refreshIntel();
  assert.equal(g.inSight(a, b), true);
  assert.deepEqual(g.intel[a.id][b.id], { x: b.x, z: b.z, r: 0, at: g.turnsThisRound });
});

test('fog: a scout lights up where it lands, for its owner only, for two of their shots', () => {
  const g = make([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  const [a, b, c] = g.players;
  g.applyEffect({ type: 'scout', point: [b.x, b.y, b.z], radius: 120, turns: 2 }, a.id, null);
  assert.equal(g.inSight(a, b), true);
  assert.equal(g.intel[a.id][b.id].r, 0);
  assert.equal(g.inSight(c, b), dist(c, b) <= FOG.sight, 'C learns nothing from it');
  const per = g.alivePlayers().length;
  g.turnsThisRound += per;
  g.refreshIntel();
  assert.equal(g.inSight(a, b), true, 'still lit for the next shot');
  g.turnsThisRound += per;
  g.refreshIntel();
  assert.equal(g.reveals.length, 0, 'spent');
  assert.equal(g.inSight(a, b), false);
});

test('fog: firing gives a rough fix on the shooter to everyone who cannot see it', () => {
  const g = make([{ name: 'A' }, { name: 'B' }]);
  const [a, b] = g.players;
  const me = g.current;
  const other = me === a ? b : a;
  g.fire();
  const i = g.intel[other.id][me.id];
  assert.equal(i.r, FOG.flash);
  assert.ok(Math.hypot(i.x - me.x, i.z - me.z) <= FOG.flash);
});

test('fog: CPUs aim from their intel, use scouts, and the match plays out the same twice', () => {
  const play = () => {
    const g = make([{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'hard' }, { name: 'C', ai: 'easy' }], { firing: 'volley' });
    let scouts = 0;
    for (let k = 0; k < 200000 && g.phase !== 'matchOver'; k++) {
      g.update(1 / 30);
      for (const e of g.drainEvents()) if (e.type === 'scout') scouts++;
      if (g.phase === 'roundOver') { g.openShop(); }
    }
    assert.equal(g.phase, 'matchOver');
    return { scouts, sum: g.players.map((p) => `${p.wins}/${p.hp.toFixed(3)}/${p.stats.shots}`).join(' ') };
  };
  const one = play();
  assert.ok(one.scouts > 0, 'someone scouted');
  assert.deepEqual(play(), one);
});

test('fog: snapshot and restore carry the intel and the scout bursts', () => {
  const g = make([{ name: 'A' }, { name: 'B' }], { firing: 'volley' });
  const [a, b] = g.players;
  g.applyEffect({ type: 'scout', point: [b.x, b.y, b.z], radius: 120, turns: 2 }, a.id, null);
  const s = JSON.parse(JSON.stringify(g.snapshot()));
  const h = make([{ name: 'A' }, { name: 'B' }], { firing: 'volley' });
  h.restore(s);
  assert.deepEqual(h.intel, g.intel);
  assert.deepEqual(h.reveals, g.reveals);
  assert.equal(h.inSight(h.players[0], h.players[1]), true);
});

test('fog: the scout is a fog-only weapon that does no damage', () => {
  const w = WEAPON_BY_ID.scout;
  assert.ok(w.fog);
  assert.ok(!w.impact.some((p) => p.type === 'blast'));
});
