import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { RIDGE, slump } from '../src/core/ridgeline.js';
import { TANK } from '../src/core/tank.js';
import { terrainConfig, parseTestParams, TERRAIN } from '../src/builder.js';

// The Ridgeline: a thin slice of mountains, tanks in an uneven row from west
// to east, loose ground that slides.

const cfg = (seed, n, extra = {}) => ({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, ai: 'normal' })), rounds: 1, seed, resolution: 128, world: 'ridgeline', hills: RIDGE.hills, twists: false, ...extra });
const ridge = (seed, n = 4, extra = {}) => {
  const g = new Game(cfg(seed, n, extra));
  g.start();
  return g;
};
const floorAt = (g, x) => g.terrain.heightAt(x, RIDGE.band + RIDGE.flank + 30);

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

test('ridgeline: a thin band of land, with steep flanks falling to a low floor', () => {
  for (const seed of [5, 6, 7]) {
    const g = ridge(seed);
    const t = g.terrain;
    // Past the flanks it is all low floor; inside the band there are real mountains.
    let inHi = -Infinity;
    for (let x = -380; x <= 380; x += 4) {
      assert.ok(t.heightAt(x, RIDGE.band + RIDGE.flank + 12) < RIDGE.floor + 8, `floor at x ${x}`);
      assert.ok(t.heightAt(x, -(RIDGE.band + RIDGE.flank + 12)) < RIDGE.floor + 8, `floor at x ${x}`);
      inHi = Math.max(inHi, t.heightAt(x, 0));
    }
    assert.ok(inHi > 45, `peaks in the band ${inHi}`);
    // A steep flank: the drop across it is much more than its run.
    let steep = 0;
    for (let x = -300; x <= 300; x += 10) {
      steep = Math.max(steep, (t.heightAt(x, RIDGE.band - 4) - t.heightAt(x, RIDGE.band + RIDGE.flank)) / (RIDGE.flank + 4));
    }
    assert.ok(steep > 1, `flank slope ${steep}`);
    // The profile varies along x much more than along z within the band.
    let dx = 0;
    let dz = 0;
    for (let z = -40; z <= 40; z += 8) {
      for (let x = -380; x < 380; x += 8) {
        dx += Math.abs(t.heightAt(x + 8, z) - t.heightAt(x, z));
        dz += Math.abs(t.heightAt(x, z + 8) - t.heightAt(x, z));
      }
    }
    assert.ok(dx > dz * 2.5, `along x ${dx.toFixed(0)} vs along z ${dz.toFixed(0)}`);
  }
});

test('ridgeline: tanks are in a varied row, on level ground inside the band', () => {
  const centres = [];
  const ratios = [];
  let ledges = 0;
  let zs = 0;
  let total = 0;
  for (const n of [2, 3, 4, 6, 8]) {
    for (const seed of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      const g = ridge(seed, n);
      const t = g.terrain;
      const half = t.half;
      const ps = [...g.players].sort((a, b) => a.x - b.x);
      const gaps = ps.slice(1).map((p, k) => p.x - ps[k].x);
      for (const p of g.players) {
        assert.ok(Math.abs(p.z) <= RIDGE.band * RIDGE.zSpread + 0.5, `${p.name} within the band (z ${p.z})`);
        assert.ok(Math.abs(p.x) < half * RIDGE.reach + 1, `${p.name} in the field`);
        // Level, solid pad: the ground under the pad is flat to the metre.
        for (const [dx, dz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]]) assert.ok(Math.abs(t.heightAt(p.x + dx, p.z + dz) - p.y) < 0.8, `${p.name} pad level`);
        assert.ok(p.y > RIDGE.floor + 5, 'well above the floor');
        if (p.y - floorAt(g, p.x) > 8) ledges++;
        zs += Math.abs(p.z);
        total++;
      }
      for (const gap of gaps) assert.ok(gap >= Math.min(RIDGE.minGap, (2 * half * RIDGE.reach * 0.85) / (n - 1)) - 0.01, `gap ${gap}`);
      if (n >= 4) ratios.push(Math.max(...gaps) / Math.min(...gaps));
      if (n === 4) centres.push((ps[0].x + ps[n - 1].x) / 2);
    }
  }
  // Uneven gaps, a row that is not always in the middle, tanks off the line of z = 0, some on ledges.
  assert.ok(ratios.filter((r) => r > 1.25).length > ratios.length * 0.6, 'gaps are uneven');
  assert.ok(Math.max(...centres) - Math.min(...centres) > 100, 'the row moves about the field');
  assert.ok(centres.some((c) => c > 20) && centres.some((c) => c < -20), 'toward both ends');
  assert.ok(zs / total > 8, `tanks off the centre line (mean |z| ${zs / total})`);
  assert.ok(ledges > 5, `some tanks on ledges (${ledges})`);
});

test('ridgeline: every peak between the tanks keeps a lob of 45 degrees open', () => {
  for (const n of [2, 4, 6]) {
    for (const seed of [1, 2, 3, 11, 12]) {
      const g = ridge(seed, n);
      const t = g.terrain;
      const ps = [...g.players].sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < ps.length; i++) {
        const a = ps[i];
        const b = ps[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        for (let s = 0.12; s <= 0.88; s += 0.02) {
          const x = a.x + (b.x - a.x) * s;
          const z = a.z + (b.z - a.z) * s;
          // Ground between them stays under the clearance slope from each tank (a margin for the crags).
          const cap = Math.min(a.y + RIDGE.clear * s * L, b.y + RIDGE.clear * (1 - s) * L) + 12;
          assert.ok(t.heightAt(x, z) <= cap, `seed ${seed} n ${n}: ground ${t.heightAt(x, z).toFixed(1)} over ${cap.toFixed(1)} at ${(s * L).toFixed(0)} m`);
        }
      }
    }
  }
});

test('ridgeline: a CPU can lob over the range to its neighbour', () => {
  let worst = 0;
  for (const n of [2, 4]) {
    for (const seed of [1, 2, 3, 4]) {
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

// ---------------------------------------------------------------- sand

// The tallest ground in the band between the first two tanks: where a blast undercuts a peak.
const peakSpot = (g) => {
  const t = g.terrain;
  const ps = [...g.players].sort((a, b) => a.x - b.x);
  let best = { x: 0, h: -Infinity };
  for (let x = ps[0].x + 30; x < ps[1].x - 30; x += 3) {
    const h = t.heightAt(x, 0);
    if (h > best.h) best = { x, h };
  }
  return best;
};

// The worst slope above the angle of repose, among ground a blast has disturbed.
const worstExcess = (g, cx, cz, reach) => {
  const t = g.terrain;
  const step = Math.tan((RIDGE.repose * Math.PI) / 180) * t.cell;
  const r = t.regionFor(cx, cz, reach);
  let worst = 0;
  for (let j = r.j0 + 1; j < r.j1; j++) {
    for (let i = r.i0 + 1; i < r.i1; i++) {
      const k = t.index(i, j);
      for (const nk of [k + 1, k + t.n]) {
        const loose = Math.abs(t.heights[k] - t.crust[k]) > 0.015 || Math.abs(t.heights[nk] - t.crust[nk]) > 0.015;
        if (loose) worst = Math.max(worst, Math.abs(t.heights[k] - t.heights[nk]) - step);
      }
    }
  }
  return worst / step;
};

test('ridgeline: blasts dig wider and deeper than elsewhere', () => {
  const r = ridge(3);
  const m = new Game(cfg(3, 4, { world: 'meadow', hills: 45 }));
  m.start();
  r.carve(0, 30, 0, 20, 0.6);
  m.carve(0, 30, 0, 20, 0.6);
  assert.equal(r.ground.ops.at(-1)[4], 20 * RIDGE.crater);
  assert.equal(m.ground.ops.at(-1)[4], 20);
});

test('ridgeline: after a blast the ground it loosened rests at the angle of repose', () => {
  for (const seed of [3, 5, 9]) {
    const g = ridge(seed);
    const t = g.terrain;
    const pk = peakSpot(g);
    const before = t.heightAt(pk.x, 0);
    // Several blasts into the flank of the tallest peak, undercutting it.
    for (let k = 0; k < 4; k++) {
      g.carve(pk.x + 6 + k * 5, pk.h - 6, 0, 22, 0.6);
      assert.ok(worstExcess(g, pk.x + 6 + k * 5, 0, 22 * RIDGE.crater * 1.9) < 0.1, `seed ${seed} blast ${k}: slope past repose by ${worstExcess(g, pk.x + 6 + k * 5, 0, 22 * RIDGE.crater * 1.9)}`);
    }
    assert.ok(t.heightAt(pk.x, 0) < before - 3, `the peak sagged (${before} to ${t.heightAt(pk.x, 0)})`);
    assert.ok(Math.min(...t.heights) > t.bedrock);
  }
});

test('ridgeline: the slump is quick, and leaves undisturbed ground alone', () => {
  const g = ridge(4);
  const t = g.terrain;
  const far = Array.from(t.heights);
  const pk = peakSpot(g);
  // Disturb nothing: no loose ground, nothing to do.
  assert.equal(slump(t, pk.x, 0, 60), null);
  g.carve(pk.x, pk.h - 8, 0, 18, 0.6);
  // Cells well beyond the blast's reach are untouched.
  const reach = 18 * RIDGE.crater * 1.9 + 30;
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) {
    if (Math.hypot(t.vx(i) - pk.x, t.vz(j)) > reach) assert.equal(t.heights[t.index(i, j)], far[t.index(i, j)]);
  }
  const t0 = performance.now();
  for (let k = 0; k < 10; k++) g.carve(pk.x + 10 + k * 4, pk.h - 8, 0, 18, 0.6);
  assert.ok((performance.now() - t0) / 10 < 12, 'under a dozen milliseconds a blast, even into a peak');
});

test('ridgeline: sand slides the same on replay, from a snapshot or the ops', () => {
  const g = ridge(7);
  const pk = peakSpot(g);
  for (let k = 0; k < 5; k++) g.carve(pk.x - 8 + k * 7, pk.h - 5 - k, k % 2 ? 6 : -4, 18 + k * 2, 0.6);
  // A mound too, which slumps as well.
  g.applyEffect({ type: 'mound', point: [pk.x + 5, pk.h, 2], radius: 16, height: 9 }, 0, null);
  assert.deepEqual(g.ground.ops.map((o) => o[0]), ['c', 'c', 'c', 'c', 'c', 'm']);
  const h = Array.from(g.terrain.heights);
  const g2 = ridge(7);
  g2.restore(g.snapshot());
  assert.deepEqual(Array.from(g2.terrain.heights), h, 'the same ground after a restore');
  // And again from a copy that went through JSON, as online play sends it.
  const g3 = ridge(7);
  g3.restore(JSON.parse(JSON.stringify(g.snapshot())));
  assert.deepEqual(Array.from(g3.terrain.heights), h);
  assert.deepEqual(g3.ground.ops, g.ground.ops, 'only the crater ops are logged');
  // The tanks sit on the ground they stand on.
  for (const p of g.players) assert.ok(p.y >= g.terrain.heightAt(p.x, p.z) - 0.01 || p.falling, 'not buried');
});

test('ridgeline: the slump does nothing in other worlds', () => {
  const g = new Game(cfg(3, 4, { world: 'meadow', hills: 45 }));
  g.start();
  const t = g.terrain;
  assert.equal(slump(t, 0, 0, 80), null, 'no crust, no slump');
  const copy = new (t.constructor)({ size: t.size, resolution: t.res });
  copy.heights.set(t.heights);
  copy.scorch.set(t.scorch);
  g.carve(10, t.heightAt(10, 10) - 5, 10, 30, 0.6);
  copy.carveCrater(10, copy.heightAt(10, 10) - 5, 10, 30, 0.6);
  assert.deepEqual(Array.from(t.heights), Array.from(copy.heights), 'a plain crater and nothing more');
  assert.equal(g.ground.ops.at(-1)[4], 30, 'no wider crater either');
});

test('ridgeline: tanks drop with the ground, or are lifted by sand heaped under them', () => {
  const g = ridge(3);
  const p = g.players[0];
  const t = g.terrain;
  // A blast right under a tank on a ledge or a floor: it is never left buried or floating after the pass.
  g.carve(p.x + 4, p.y - 2, p.z, 14, 0.6);
  assert.ok(p.y >= t.heightAt(p.x, p.z) - 0.01, 'not buried');
  for (let k = 0; k < 400 && (p.falling || p.y > t.heightAt(p.x, p.z) + 0.05); k++) g.updateFalling(1 / 30);
  assert.ok(Math.abs(p.y - t.heightAt(p.x, p.z)) < 0.06, 'it settles on the new ground');
  assert.ok(TANK.padRadius > 0);
});

test('ridgeline: the Terrain menu offers it by name', () => {
  assert.deepEqual(terrainConfig('ridgeline'), { hills: RIDGE.hills, world: 'ridgeline' });
  assert.equal(TERRAIN.find((x) => x.id === 'ridgeline')?.name, 'Ridgeline');
  assert.equal(parseTestParams('?terrain=ridgeline').terrain, 'ridgeline');
});
