import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { bossMatch, bossStandings, ARENA, fortSpots } from '../src/core/boss.js';

// The boss match's result table (core/boss.js bossStandings): teams, not wins
// and funds, so an ally cannot top it by being richer.

function bossGame() {
  const cfg = bossMatch('Tester', { conditions: { maxWind: 1.5, hills: 45 } });
  const g = new Game({ ...cfg, seed: 4242, resolution: 128 });
  g.start();
  return g;
}

test('standings: allies by damage dealt to the boss, then the boss; the allies win when it falls', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  b.boss.hurt = { [me.id]: 90.4, [ally.id]: 210 };
  me.wins = 1; me.money = 5000;           // wins and funds do not order a boss match
  b.alive = false; b.hp = 0;
  const s = bossStandings(g.players, { team: 0 });
  assert.equal(s.winner, 'allies');
  assert.equal(s.title, 'Allies win');
  assert.deepEqual(s.rows.map((r) => r.id), [ally.id, me.id, b.id]);
  assert.deepEqual(s.rows.map((r) => r.side), ['allies', 'allies', 'boss']);
  assert.equal(s.rows[0].damage, 210);
  assert.equal(s.rows[1].damage, 90);
});

test('standings: the boss wins when its foes are wiped out, and an ally still tops its team by damage', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  b.boss.hurt = { [me.id]: 40, [ally.id]: 100 };
  me.alive = false; ally.alive = false;
  const s = bossStandings(g.players, { team: 1 });
  assert.equal(s.winner, 'boss');
  assert.equal(s.title, 'The Bulwark wins');
  assert.equal(s.rows[0].id, ally.id);
  assert.equal(s.rows.at(-1).id, b.id);
  assert.ok(s.rows.at(-1).alive && s.rows.at(-1).hp > 0);
});

test('standings: ties go to whoever is standing, then the seat; no result falls back on the boss', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  me.alive = false;                      // nobody has hurt it: a tie on 0
  assert.deepEqual(bossStandings(g.players, { team: 0 }).rows.map((r) => r.id), [ally.id, me.id, b.id]);
  assert.equal(bossStandings(g.players, null).winner, 'boss');
  b.alive = false;
  assert.equal(bossStandings(g.players, null).winner, 'allies');
  ally.alive = false;
  assert.equal(bossStandings(g.players, null).winner, 'draw');
  assert.equal(bossStandings(g.players, null).title, 'Nobody wins');
  assert.equal(bossStandings(g.players.slice(0, 2), null), null);   // not a boss match
});

test('the fort spots the render colours and decorates are the deck and the two ledges', () => {
  const g = bossGame();
  const [x, z] = g.fort;
  assert.equal(x, ARENA.boss[0] * g.terrain.half);
  const spots = fortSpots(x, z);
  assert.equal(spots.length, 3);
  assert.equal(spots[0][2], ARENA.fort.r);
  assert.ok(spots.slice(1).every((s) => s[2] === ARENA.ledge.r));
});
