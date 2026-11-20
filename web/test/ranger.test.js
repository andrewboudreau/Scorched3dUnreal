import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { TANK } from '../src/core/tank.js';
import { WEAPON_BY_ID, rangeProbes } from '../src/core/weapons.js';

const make = (extra = {}) => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 2, seed: 11, resolution: 64, twists: false, ...extra });
  g.start();
  return g;
};

test('rangefinder: every tank starts with two', () => {
  const g = make();
  for (const p of g.players) assert.equal(p.inventory.ranger, 2);
});

test('rangefinder: probes are the aim, turret -/+2 and power -/+5, clamped', () => {
  const part = WEAPON_BY_ID.ranger.flight[0];
  const pb = rangeProbes(359, 60, part, 10, 100);
  assert.deepEqual(pb.map((p) => p.key), ['aim', 'turn-', 'turn+', 'power-', 'power+']);
  assert.equal(pb[1].yaw, 357);
  assert.equal(pb[2].yaw, 1);              // wraps past 360
  assert.equal(pb[3].power, 55);
  assert.equal(pb[4].power, 65);
  assert.equal(rangeProbes(0, 98, part, 10, 100)[4].power, 100);
});

test('rangefinder: five harmless probes, one shot, no crater, no damage', () => {
  const g = make();
  const me = g.current;
  const foe = g.players.find((p) => p !== me);
  // Aim straight at the other tank so a probe or two lands on or near it.
  me.yaw = ((Math.atan2(foe.z - me.z, foe.x - me.x) * 180 / Math.PI) + 360) % 360;
  me.weapon = 'ranger';
  const before = Float32Array.from(g.terrain.heights);
  const hp = g.players.map((p) => p.hp);
  g.drainEvents();                       // the round's own start-up events
  assert.ok(g.fire());
  assert.equal(me.inventory.ranger, 1);
  assert.equal(g.projectiles.length, 5);
  assert.deepEqual(g.projectiles.map((pr) => pr.probe.key), ['aim', 'turn-', 'turn+', 'power-', 'power+']);
  assert.ok(g.projectiles.every((pr) => pr.shot === me.shotCount));
  const events = [];
  for (let k = 0; k < 4000 && g.phase !== 'aim'; k++) { g.update(1 / 30); events.push(...g.drainEvents()); }
  assert.equal(g.phase, 'aim');
  assert.equal(events.filter((e) => e.type === 'impact' || e.type === 'lost').length, 5);
  assert.ok(!events.some((e) => e.type === 'explosion' || e.type === 'damage' || e.type === 'terrain'));
  assert.deepEqual(g.players.map((p) => p.hp), hp);
  assert.deepEqual(Array.from(g.terrain.heights), Array.from(before));
  assert.ok(TANK.maxPower > TANK.minPower);
});
