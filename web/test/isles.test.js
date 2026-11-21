import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISLES } from '../src/core/terrain.js';
import { simulateShot, launchVelocity } from '../src/core/ballistics.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { Game } from '../src/core/game.js';
import { muzzleOrigin, onIsle } from '../src/core/tank.js';

// The floating isles: islands of ground over open space, and moons whose pull
// bends shells.

const isles = (seed, n = 2) => {
  const g = new Game({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), rounds: 1, seed, resolution: 128, world: 'isles', twists: false });
  g.start();
  return g;
};

test('isles: the same seed makes the same sky, every tank starts on an isle', () => {
  for (const seed of [1, 7, 42]) {
    const a = isles(seed, 4);
    const b = isles(seed, 4);
    assert.deepEqual(Array.from(a.terrain.heights), Array.from(b.terrain.heights));
    assert.deepEqual(Array.from(a.terrain.under), Array.from(b.terrain.under));
    assert.deepEqual(a.terrain.wells, b.terrain.wells);
    assert.ok(a.terrain.wells.length >= 2 && a.terrain.wells.length <= 3, `${a.terrain.wells.length} moons`);
    for (const p of a.players) {
      assert.ok(onIsle(a.terrain, p.x, p.z), `${p.name} stands on solid ground`);
      assert.ok(Math.abs(p.y - a.terrain.heightAt(p.x, p.z)) < 0.05, 'on its surface');
    }
    // Most of the field is open sky.
    let open = 0;
    for (let k = 0; k < a.terrain.heights.length; k++) if (a.terrain.isOpen(k)) open++;
    assert.ok(open / a.terrain.heights.length > 0.6, `open ${open}`);
  }
});

test('isles: a meadow game has no undersides or moons', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 3, resolution: 64 });
  g.start();
  assert.equal(g.terrain.under, null);
  assert.equal(g.terrain.wells.length, 0);
  assert.equal(g.isles, false);
});

test('isles: blasts from below hole an isle and the tank above falls into the void', () => {
  const g = isles(5);
  const [a, b] = g.players;
  const t = g.terrain;
  g.drainEvents();
  for (let k = 0; k < 12 && t.solidAt(b.x, b.z); k++) {
    g.applyEffect({ type: 'blast', point: [b.x, t.underAt(b.x, b.z) - 2, b.z], radius: 14, damage: 0, depth: 0.6 }, a.id, null);
  }
  assert.equal(t.solidAt(b.x, b.z), false, 'the ground under the tank is gone');
  assert.ok(b.alive);
  g.phase = 'settle';
  for (let i = 0; i < 120 * 10 && b.alive; i++) g.stepWorld(1 / 120);
  const ev = g.drainEvents();
  assert.equal(b.alive, false, 'fell to its death');
  assert.ok(ev.some((e) => e.type === 'void' && e.player === b.id), 'the void event fired');
  assert.ok(b.y < ISLES.voidY, 'went down through the void');
  assert.ok(a.alive, 'the shooter is fine');
});

test('isles: a shell from below stops at the underside', () => {
  const g = isles(11);
  const t = g.terrain;
  const p = g.players[0];
  const u = t.underAt(p.x, p.z);
  const wells = t.wells;
  t.wells = [];
  const shot = simulateShot({ pos: [p.x, u - 40, p.z], vel: [0, 60, 0], terrain: t });
  t.wells = wells;
  assert.equal(shot.kind, 'ground');
  assert.ok(Math.abs(shot.point[1] - u) < 0.5, `hit at ${shot.point[1]}, underside ${u}`);
});

test('isles: the moons bend a shell that passes them', () => {
  const g = isles(3);
  const t = g.terrain;
  const w = t.wells[0];
  // A shell lobbed to pass just beside the first moon.
  const pos = [w.x - 150, w.y - 30, w.z + w.r * 2.5];
  const vel = [70, 25, 0];
  const pulled = simulateShot({ pos, vel, terrain: t, recordPath: true, maxTime: 3 });
  const all = t.wells;
  t.wells = [];
  const plain = simulateShot({ pos, vel, terrain: t, recordPath: true, maxTime: 3 });
  t.wells = all;
  const end = (s) => s.path[s.path.length - 1];
  const dz = end(pulled)[2] - end(plain)[2];
  assert.ok(dz < -3 || pulled.kind === 'moon', `pulled toward the moon (dz ${dz.toFixed(1)}, ${pulled.kind})`);
});

test('isles: the CPU solver still finds its targets across the void', () => {
  let close = 0;
  let cases = 0;
  for (const seed of [2, 4, 6, 8]) {
    const g = isles(seed, 3);
    const t = g.terrain;
    const [s, ...rest] = g.players;
    for (const target of rest) {
      const sol = solveShot({ shooter: s, target: [target.x, target.y, target.z], wind: [0.4, -0.3], terrain: t, rng: makeRng(seed) });
      const shot = simulateShot({ pos: muzzleOrigin(s, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), wind: [0.4, -0.3], terrain: t });
      cases++;
      if (shot.kind !== 'lost' && Math.hypot(shot.point[0] - target.x, shot.point[2] - target.z) < 15) close++;
    }
  }
  assert.ok(close >= cases - 2, `landed near on ${close}/${cases}`);
});
