import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { RIDGE } from '../src/core/ridgeline.js';
import { terrainConfig, parseTestParams, TERRAIN } from '../src/builder.js';

// The Ridgeline: tanks in a row from west to east, a jagged range between them.

const ridge = (seed, n = 4) => {
  const g = new Game({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, ai: 'normal' })), rounds: 1, seed, resolution: 128, world: 'ridgeline', hills: RIDGE.hills, twists: false });
  g.start();
  return g;
};

test('ridgeline: the same seed makes the same range and the same row', () => {
  for (const seed of [1, 9, 77]) {
    const a = ridge(seed);
    const b = ridge(seed);
    assert.deepEqual(Array.from(a.terrain.heights), Array.from(b.terrain.heights));
    assert.deepEqual(a.players.map((p) => [p.x, p.z]), b.players.map((p) => [p.x, p.z]));
    assert.ok(a.terrain.ridge, 'marked as a ridgeline');
    assert.equal(a.terrain.under, null, 'no undersides');
    assert.equal(a.terrain.wells.length, 0, 'no moons');
    assert.equal(a.terrain.waterLevel, -Infinity, 'no water');
    assert.equal(a.scenery.props.filter((p) => p.kind !== 'rock').length, 0, 'only rocks for scenery');
    assert.equal(a.scenery.walkers.length, 0, 'no villagers or sheep');
  }
  assert.notDeepEqual(Array.from(ridge(1).terrain.heights), Array.from(ridge(2).terrain.heights));
});

test('ridgeline: the tanks stand in a row from west to east', () => {
  for (const n of [2, 4, 8]) {
    for (const seed of [3, 4]) {
      const g = ridge(seed, n);
      const half = g.terrain.half;
      const xs = g.players.map((p) => p.x).sort((a, b) => a - b);
      for (const p of g.players) assert.ok(Math.abs(p.z) <= half * RIDGE.zSpread + 1, `${p.name} near the row (z ${p.z})`);
      // Spread across most of the field, none bunched up.
      assert.ok(xs[n - 1] - xs[0] > half * RIDGE.reach, `span ${xs[n - 1] - xs[0]}`);
      for (let k = 1; k < n; k++) assert.ok(xs[k] - xs[k - 1] > 30, `gap ${xs[k] - xs[k - 1]}`);
    }
  }
});

test('ridgeline: the profile varies along x much more than along z', () => {
  for (const seed of [5, 6]) {
    const t = ridge(seed).terrain;
    let dx = 0;
    let dz = 0;
    for (let z = -200; z <= 200; z += 10) {
      for (let x = -380; x < 380; x += 10) {
        dx += Math.abs(t.heightAt(x + 10, z) - t.heightAt(x, z));
        dz += Math.abs(t.heightAt(x, z + 10) - t.heightAt(x, z));
      }
    }
    assert.ok(dx > dz * 3, `along x ${dx.toFixed(0)} vs along z ${dz.toFixed(0)}`);
    // Real mountains, not a plain.
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = -380; x <= 380; x += 4) { const h = t.heightAt(x, 0); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    assert.ok(hi - lo > 50, `relief ${hi - lo}`);
  }
});

test('ridgeline: a CPU can lob over the range to its neighbour', () => {
  let worst = 0;
  for (const n of [2, 4]) {
    for (const seed of [1, 2]) {
      const g = ridge(seed, n);
      const ps = [...g.players].sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < ps.length; i++) {
        const sol = solveShot({ shooter: ps[i], target: [ps[i + 1].x, ps[i + 1].y, ps[i + 1].z], wind: [0, 0], terrain: g.terrain, rng: makeRng(5), iterations: 25 });
        worst = Math.max(worst, sol.predictedMiss);
      }
    }
  }
  assert.ok(worst < 12, `worst predicted miss ${worst}`);
});

test('ridgeline: the Terrain menu offers it by name', () => {
  assert.deepEqual(terrainConfig('ridgeline'), { hills: RIDGE.hills, world: 'ridgeline' });
  assert.equal(TERRAIN.find((x) => x.id === 'ridgeline')?.name, 'Ridgeline');
  assert.equal(parseTestParams('?terrain=ridgeline').terrain, 'ridgeline');
});
