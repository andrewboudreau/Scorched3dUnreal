import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { Game } from '../src/core/game.js';
import { PATH, planPaths, distToPaths } from '../src/core/paths.js';

function field(shape) {
  const t = new Heightfield({ size: 800, resolution: 200 });
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) t.heights[j * t.n + i] = shape(t.vx(i), t.vz(j));
  return t;
}
const ends = (p) => [p.points[0], p.points[p.points.length - 1]];
const near = (a, b, r = 0.01) => Math.hypot(a[0] - b[0], a[1] - b[1]) < r;
const steps = (p) => p.points.slice(1).map((q, i) => [p.points[i], q]);

test('paths: roads join every hamlet into one tree and keep clear of tank pads', () => {
  const t = field((x, z) => 10 + Math.sin(x * 0.02) * 4 + Math.cos(z * 0.017) * 4);
  const hamlets = [{ x: -220, z: -40 }, { x: 210, z: 30 }, { x: 10, z: 260 }];
  const tanks = [{ x: 0, z: -5 }, { x: 110, z: 150 }];
  const paths = planPaths({ terrain: t, hamlets, tanks, seed: 3 });
  const roads = paths.filter((p) => p.kind === 'road');
  assert.equal(roads.length, 2, 'three hamlets, two roads');
  // Every road runs from one hamlet centre to another, and together they reach all three.
  const group = hamlets.map((_, i) => i);
  for (const r of roads) {
    const [a, b] = ends(r).map((e) => hamlets.findIndex((h) => near(e, [h.x, h.z])));
    assert.ok(a >= 0 && b >= 0 && a !== b, 'a road ends at two different hamlets');
    const from = group[a];
    group.forEach((g, i) => { if (g === from) group[i] = group[b]; });
  }
  assert.equal(new Set(group).size, 1, 'all connected');
  for (const r of roads) {
    assert.equal(r.width, PATH.width.road);
    for (const [a, b] of steps(r)) assert.ok(Math.hypot(b[0] - a[0], b[1] - a[1]) < PATH.cell * 1.5, 'no gaps');
    for (const [x, z] of r.points) {
      for (const k of tanks) assert.ok(Math.hypot(k.x - x, k.z - z) > PATH.keepTank - 6, 'off the tank pad');
      assert.ok(Math.abs(x) < t.half - 10 && Math.abs(z) < t.half - 10);
    }
  }
  assert.ok(distToPaths(paths, -220, -40) < 0, 'the hamlet centre is on a road');
  assert.ok(distToPaths(paths, -390, -390) > 100);
});

test('paths: a road goes round a slope it cannot climb', () => {
  // A wall across the field, far too steep, with one gentle saddle through it.
  const gap = (z) => Math.min(1, Math.abs(z - 200) / 60);
  const t = field((x, z) => 10 + 60 * Math.max(0, 1 - Math.abs(x) / 30) * gap(z));
  const hamlets = [{ x: -200, z: -150 }, { x: 200, z: -150 }];
  const [road] = planPaths({ terrain: t, hamlets, seed: 1 }).filter((p) => p.kind === 'road');
  assert.ok(road, 'there is a way through');
  let steepest = 0;
  for (const [a, b] of steps(road)) {
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run > 0.5) steepest = Math.max(steepest, Math.abs(t.heightAt(b[0], b[1]) - t.heightAt(a[0], a[1])) / run);
  }
  assert.ok(steepest < PATH.maxGrade * 1.5, `stays off steep ground (${steepest.toFixed(2)})`);
  const crossing = road.points.filter(([x]) => Math.abs(x) < 8);
  assert.ok(crossing.length && crossing.every(([, z]) => Math.abs(z - 200) < 45), 'it crosses at the saddle');

  // With no saddle there is no road at all, rather than one up the wall.
  const wall = field((x) => 10 + 60 * Math.max(0, 1 - Math.abs(x) / 30));
  assert.equal(planPaths({ terrain: wall, hamlets, seed: 1 }).length, 0);
});

test('paths: a track leads from a hamlet down to the water and stays dry', () => {
  const t = field((x) => 12 + (x + 400) * 0.03 - 14 * Math.max(0, Math.min(1, (x - 150) / 60)));
  t.waterLevel = 13;       // the eastern end of the field is a lake
  const hamlets = [{ x: -50, z: 0 }];
  const paths = planPaths({ terrain: t, hamlets, seed: 2 });
  const track = paths.find((p) => p.kind === 'track');
  assert.ok(track, 'one hamlet still gets its path to the water');
  assert.ok(near(track.points[0], [-50, 0]));
  const [ex, ez] = track.points[track.points.length - 1];
  const bank = t.heightAt(ex, ez);
  assert.ok(bank > t.waterLevel && bank < t.waterLevel + PATH.shore + 0.5, `ends on the bank (${(bank - t.waterLevel).toFixed(1)} m up)`);
  for (const [x, z] of track.points) assert.ok(t.heightAt(x, z) > t.waterLevel + 0.3, 'never in the water');
  // A lake too far away to bother with.
  const far = planPaths({ terrain: t, hamlets: [{ x: -380, z: 0 }], seed: 2 });
  assert.equal(far.filter((p) => p.kind === 'track').length, 0);
});

test('paths: a road uses the bridge and stops at each bank', () => {
  // A river down the middle with one footbridge.
  const t = field((x) => 10 - 8 * Math.max(0, 1 - Math.abs(x) / 14));
  t.waterLevel = 6;
  const bridge = { a: [-16, 100], b: [16, 100], y: 10.4, alive: true };
  const hamlets = [{ x: -180, z: 0 }, { x: 180, z: 20 }];
  const paths = planPaths({ terrain: t, hamlets, bridge, seed: 5 });
  const roads = paths.filter((p) => p.kind === 'road');
  assert.equal(roads.length, 2, 'one stretch each side of the river');
  assert.ok(near(roads[0].points[roads[0].points.length - 1], bridge.a) || near(roads[0].points[roads[0].points.length - 1], bridge.b));
  assert.ok(near(roads[1].points[0], bridge.a) || near(roads[1].points[0], bridge.b));
  for (const p of paths) for (const [x, z] of p.points) assert.ok(t.heightAt(x, z) > t.waterLevel, 'nothing painted on the river bed');
  // Without the bridge the hamlets cannot be joined.
  assert.equal(planPaths({ terrain: t, hamlets, seed: 5 }).filter((p) => p.kind === 'road').length, 0);
});

test('paths: in real rounds they avoid spawns, water, houses and steep ground, and nothing grows on them', () => {
  let roads = 0;
  let tracks = 0;
  let spurs = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], seed: seed * 37, resolution: 128, twists: false });
    g.start();
    const s = g.scenery;
    const t = g.terrain;
    assert.ok(s.paths.length <= 30, `a handful, not a network (${s.paths.length})`);
    for (const p of s.paths) {
      if (p.kind === 'road') roads++; else if (p.kind === 'track') tracks++; else spurs++;
      for (const [x, z] of p.points) {
        assert.ok(t.inBounds(x, z));
        assert.ok(t.heightAt(x, z) > t.waterLevel, 'dry');
        for (const k of g.players) assert.ok(Math.hypot(k.x - x, k.z - z) > 16, `clear of ${k.name}'s pad`);
      }
      if (p.kind === 'spur') continue;
      for (const [a, b] of steps(p)) {
        const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
        assert.ok(run < PATH.cell * 2.5, 'no gaps');
        if (run > 1) assert.ok(Math.abs(t.heightAt(b[0], b[1]) - t.heightAt(a[0], a[1])) / run < 0.7, 'not up a cliff');
        for (const h of s.props) if (h.kind === 'house') assert.ok(Math.hypot(h.x - a[0], h.z - a[1]) > 4.7, 'not through a house');
      }
    }
    for (const q of s.props) {
      if (q.kind !== 'house') assert.ok(distToPaths(s.paths, q.x, q.z) > 2, `no ${q.kind} on a path`);
    }
  }
  assert.ok(roads >= 8 && tracks >= 4 && spurs >= 12, `paths turn up in most rounds (${roads} roads, ${tracks} tracks, ${spurs} spurs)`);
});

test('paths: villagers take walks along them and come to no harm', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], seed: 74, resolution: 128, twists: false });
  g.start();
  const s = g.scenery;
  assert.ok(s.paths.some((p) => p.kind !== 'spur'));
  let strolled = 0;
  let onPath = 0;
  for (let k = 0; k < 6000; k++) {
    s.update(0.1, g.players);
    for (const w of s.walkers) {
      if (w.kind !== 'villager' || !w.alive) continue;
      assert.ok(Math.hypot(w.x - w.hx, w.z - w.hz) < 95, 'never far from home');
      assert.ok(t(g, w) > g.terrain.waterLevel, 'never in the water');
      if (w.route) { strolled++; if (distToPaths(s.paths, w.x, w.z) < 0.5) onPath++; }
    }
  }
  assert.ok(strolled > 200, `villagers went for walks (${strolled})`);
  assert.ok(onPath > strolled * 0.5, 'and spent most of those on the path');
});
function t(g, w) { return g.terrain.heightAt(w.x, w.z); }
