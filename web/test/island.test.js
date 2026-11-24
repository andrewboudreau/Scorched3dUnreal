import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { ISLAND, islandShape } from '../src/core/island.js';
import { simulateShot, SIM_DT } from '../src/core/ballistics.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { terrainConfig, parseTestParams, TERRAIN } from '../src/builder.js';

// The Island: one island in an open sea. Shells that land in the sea are lost
// with a splash, the coast crumbles under blasts, and a tank whose ground goes
// under sinks.

const island = (seed, n = 4, extra = {}) => {
  const g = new Game({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, ai: 'normal' })), rounds: 2, seed, resolution: 128, world: 'island', hills: ISLAND.hills, twists: false, ...extra });
  g.start();
  return g;
};

test('island: the same seed makes the same island and the same pads', () => {
  for (const seed of [1, 8, 40]) {
    const a = island(seed);
    const b = island(seed);
    assert.deepEqual(Array.from(a.terrain.heights), Array.from(b.terrain.heights));
    assert.deepEqual(a.players.map((p) => [p.x, p.z]), b.players.map((p) => [p.x, p.z]));
    assert.deepEqual(a.scenery.props.map((p) => [p.kind, p.x, p.z]), b.scenery.props.map((p) => [p.kind, p.x, p.z]));
    assert.equal(a.terrain.sea, ISLAND.sea);
    assert.equal(a.terrain.waterLevel, ISLAND.sea);
    assert.equal(a.terrain.under, null);
    assert.equal(a.terrain.wells.length, 0);
  }
  assert.notDeepEqual(Array.from(island(1).terrain.heights), Array.from(island(2).terrain.heights));
});

test('island: sea on every side, land in the middle, bays and headlands round it', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const t = island(seed).terrain;
    const n = t.n;
    let land = 0;
    for (let k = 0; k < t.heights.length; k++) if (t.heights[k] > t.waterLevel) land++;
    const share = land / t.heights.length;
    assert.ok(share > 0.2 && share < 0.5, `seed ${seed}: land ${share.toFixed(2)}`);
    // Every border vertex, and a band in from it, is sea, a few metres deep.
    for (let i = 0; i < n; i++) {
      for (const j of [0, 1, 2, n - 3, n - 2, n - 1]) {
        assert.ok(t.heights[t.index(i, j)] < t.waterLevel - 3, `seed ${seed} border (${i}, ${j})`);
        assert.ok(t.heights[t.index(j, i)] < t.waterLevel - 3, `seed ${seed} border (${j}, ${i})`);
      }
    }
    assert.ok(t.heightAt(0, 0) > t.waterLevel || land > 0, 'land in the middle');
    // The coast is not a circle: its distance from the middle varies a lot.
    const shape = islandShape(island(seed).groundSeed(1), t.half);
    const rs = Array.from({ length: 72 }, (_, k) => shape.radius((k / 72) * Math.PI * 2));
    assert.ok(Math.max(...rs) - Math.min(...rs) > shape.R * 0.3, `seed ${seed}: coast from ${Math.min(...rs).toFixed(0)} to ${Math.max(...rs).toFixed(0)}`);
    assert.ok(shape.features.some((f) => f.d < 0) && shape.features.some((f) => f.d > 0), 'a bay and a headland');
  }
  let islets = 0;
  for (let seed = 1; seed <= 10; seed++) if (islandShape(seed * 31, 400).islet) islets++;
  assert.ok(islets >= 5, `islets in ${islets} of 10`);
});

test('island: every tank starts on dry land, well apart', () => {
  for (const n of [2, 4, 6, 8]) {
    for (const seed of [3, 9]) {
      const g = island(seed, n);
      const t = g.terrain;
      for (const p of g.players) assert.ok(p.y >= t.waterLevel + ISLAND.pad - 0.01, `${n} tanks seed ${seed}: ${p.name} at ${p.y.toFixed(1)}`);
      for (const a of g.players) {
        for (const b of g.players) {
          if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 70, `${n} tanks: ${a.name}-${b.name} ${Math.hypot(a.x - b.x, a.z - b.z).toFixed(0)} m`);
        }
      }
      // Next round too, on its own island.
      g.startRound();
      for (const p of g.players) assert.ok(p.y >= t.waterLevel + ISLAND.pad - 0.01, `round 2: ${p.name} at ${p.y.toFixed(1)}`);
    }
  }
});

test('island: no scenery stands in the sea', () => {
  const g = island(5);
  const t = g.terrain;
  const wet = g.scenery.props.filter((p) => p.state !== 'gone' && t.heightAt(p.x, p.z) < t.waterLevel - 0.4);
  assert.equal(wet.length, 0, `${wet.length} props under water`);
  assert.ok(g.scenery.props.length > 100, 'trees, houses and the rest');
});

test('island: a shell into the sea is lost with a splash: no crater, no damage', () => {
  const g = island(6);
  const t = g.terrain;
  // Drop one straight down from high over open sea.
  const before = Array.from(t.heights);
  const hp = g.players.map((p) => p.hp);
  g.phase = 'flight';
  g.events.length = 0;
  const pr = g.spawnProjectile([t.half - 20, 80, 0], [0, -5, 0], 'shell', 0);
  const seen = [];
  for (let i = 0; i < 20 / SIM_DT && !pr.dead; i++) { g.stepWorld(SIM_DT); seen.push(...g.events.splice(0)); }
  const impact = seen.find((e) => e.type === 'impact' && e.id === pr.id);
  assert.ok(impact?.splash, 'a splash');
  assert.equal(impact.pos[1], t.waterLevel, 'on the surface');
  assert.equal(seen.filter((e) => e.type === 'explosion').length, 0, 'no blast');
  assert.deepEqual(Array.from(t.heights), before, 'the seabed untouched');
  assert.deepEqual(g.players.map((p) => p.hp), hp);
  // The CPUs and the aim see it the same way.
  const sim = simulateShot({ pos: [t.half - 20, 80, 0], vel: [0, -5, 0], terrain: t, gravity: g.gravity, wind: g.wind, windK: 0 });
  assert.equal(sim.kind, 'sea');
});

test('island: a blast on the shore eats the coast and lets the sea in', () => {
  const g = island(7);
  const t = g.terrain;
  // A beach vertex just above the water.
  let at = null;
  for (let k = 0; k < t.heights.length && !at; k++) {
    const h = t.heights[k];
    const i = k % t.n;
    const j = Math.floor(k / t.n);
    if (h > t.waterLevel + 0.5 && h < t.waterLevel + 1.5 && g.players.every((p) => Math.hypot(p.x - t.vx(i), p.z - t.vz(j)) > 60)) at = [t.vx(i), h, t.vz(j)];
  }
  assert.ok(at, 'found a beach');
  const dryBefore = (x, z) => t.heightAt(x, z) > t.waterLevel;
  const ring = [];
  for (let a = 0; a < 16; a++) for (const r of [9, 12]) ring.push([at[0] + Math.cos(a) * r, at[2] + Math.sin(a) * r]);
  const wasDry = ring.filter(([x, z]) => dryBefore(x, z)).length;
  g.carve(at[0], at[1], at[2], 8, 0.5);
  const stillDry = ring.filter(([x, z]) => dryBefore(x, z)).length;
  assert.ok(stillDry < wasDry, `dry points past the crater: ${wasDry} before, ${stillDry} after`);
  // The same crumble on a copy that rebuilds its ground from the log.
  const snap = JSON.parse(JSON.stringify(g.snapshot()));
  const b = island(7);
  b.restore(snap);
  assert.deepEqual(Array.from(b.terrain.heights), Array.from(t.heights));
});

test('island: a tank whose ground goes under the sea sinks, and the kill goes to whoever did it', () => {
  const g = island(8);
  const t = g.terrain;
  const p = g.players[2];
  // Blow the ground from under it, as far as it takes.
  let guard = 0;
  while (t.heightAt(p.x, p.z) > t.waterLevel - ISLAND.drown - 0.5 && guard++ < 30) t.carveCrater(p.x, t.heightAt(p.x, p.z), p.z, 14, 1);
  p.blamed = 1;
  g.events.length = 0;
  for (let i = 0; i < 400 && p.alive; i++) g.updateFalling(SIM_DT);
  assert.equal(p.alive, false, `sank (ground ${t.heightAt(p.x, p.z).toFixed(1)})`);
  const sank = g.events.find((e) => e.type === 'void' && e.player === p.id);
  assert.ok(sank?.sea, 'into the sea');
  const dead = g.events.find((e) => e.type === 'destroyed' && e.player === p.id);
  assert.equal(dead?.by, 1);
  // A tank on dry ground does not.
  assert.ok(g.players[0].alive);
});

test('island: a CPU can reach its neighbours round the island', () => {
  let worst = 0;
  for (const seed of [1, 2]) {
    const g = island(seed, 4);
    const [a, ...rest] = g.players;
    for (const b of rest) {
      const sol = solveShot({ shooter: a, target: [b.x, b.y, b.z], wind: [0, 0], terrain: g.terrain, rng: makeRng(5), iterations: 25 });
      worst = Math.max(worst, sol.predictedMiss);
    }
  }
  assert.ok(worst < 12, `worst predicted miss ${worst}`);
});

test('island: the Terrain menu offers it by name, and Random can pick it', () => {
  assert.deepEqual(terrainConfig('island'), { hills: ISLAND.hills, world: 'island' });
  const t = TERRAIN.find((x) => x.id === 'island');
  assert.equal(t?.name, 'Island');
  assert.equal(t.weight, 1);
  assert.equal(parseTestParams('?terrain=island').terrain, 'island');
});

