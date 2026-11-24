import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Heightfield } from '../src/core/terrain.js';
import { makeProjectile, stepProjectile, simulateShot, launchVelocity, makeRoller, stepRoller, BOUNCE_KEEP, SIM_DT, EDGE_KINDS } from '../src/core/ballistics.js';
import { muzzleOrigin, hitSphere } from '../src/core/tank.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { matchConditions, parseTestParams, conditionsLabel, edgeLabel, EDGES } from '../src/builder.js';

// Arena edges (the Edges match option): what a shell does at the square's
// sides. Open (the default) lets it fly off; Wall stops it there; Bounce
// mirrors it back in; Wrap brings it in at the opposite side.

const field = (edge) => {
  const t = new Heightfield({ size: 800, resolution: 64 });
  t.generate({ seed: 3, amplitude: 10 });
  t.edge = edge;
  return t;
};

// A shell flying east at 60 m/s from near the east side, 50 m up.
const eastward = (t) => {
  const p = makeProjectile([t.half - 20, 50, 30], [60, 4, -10], t);
  p.g = 0;   // no gravity: the crossing is easy to read
  for (let i = 0; i < 400; i++) {
    const before = [...p.vel];
    stepProjectile(p, [0, 0]);
    if (p.crossed || !t.inBounds(p.pos[0], p.pos[2])) return { p, before };
  }
  return { p, before: null };
};

test('edges: Open lets a shell fly off as before', () => {
  const t = field('open');
  const { p } = eastward(t);
  assert.equal(p.edge, null);
  assert.equal(p.crossed, null);
  assert.ok(p.pos[0] > t.half, 'out past the east side');
  assert.equal(makeProjectile([0, 0, 0], [1, 1, 1]).edge, null, 'no terrain: no edge rule');
});

test('edges: Wall stops a shell where it meets the wall', () => {
  const t = field('wall');
  const { p } = eastward(t);
  assert.equal(p.crossed.kind, 'wall');
  assert.equal(p.crossed.point[0], t.half);
  assert.ok(p.crossed.point.edge);
  assert.deepEqual(p.pos, [...p.crossed.point]);
  assert.ok(Math.abs(p.crossed.point[2] - (30 - 10 * (20 / 60))) < 0.01, 'met it where the line does');
});

test('edges: Bounce mirrors it back in and keeps most of its speed', () => {
  const t = field('bounce');
  const { p, before } = eastward(t);
  assert.equal(p.crossed.kind, 'bounce');
  assert.ok(p.pos[0] < t.half && p.prev[0] < t.half + 1e-9, 'back inside');
  assert.ok(Math.abs(p.vel[0] + before[0] * BOUNCE_KEEP) < 1e-9, 'x reversed and slowed');
  assert.ok(Math.abs(p.vel[2] - before[2] * BOUNCE_KEEP) < 1e-9, 'z kept, slowed');
  assert.ok(Math.abs(p.vel[1] - before[1] * BOUNCE_KEEP) < 1e-9, 'y kept, slowed');
  // It flies on west from there.
  for (let i = 0; i < 200; i++) stepProjectile(p, [0, 0]);
  assert.ok(p.pos[0] < t.half - 40);
});

test('edges: Wrap brings it in at the opposite side, same height and velocity', () => {
  const t = field('wrap');
  const { p, before } = eastward(t);
  const c = p.crossed;
  assert.equal(c.kind, 'wrap');
  assert.equal(c.point[0], t.half);
  assert.equal(c.to[0], -t.half);
  assert.equal(c.to[1], c.point[1]);
  assert.equal(c.to[2], c.point[2]);
  assert.ok(p.pos[0] < -t.half + 5 && p.pos[0] >= -t.half, 'just inside the west side');
  assert.deepEqual(p.vel, before);
  // Through a corner it wraps both ways.
  const q = makeProjectile([t.half - 1, 50, t.half - 1], [80, 0, 80], t);
  q.g = 0;
  for (let i = 0; i < 10 && !q.crossed; i++) stepProjectile(q, [0, 0]);
  assert.ok(q.pos[0] < 0 && q.pos[2] < 0, `corner wrap ${q.pos}`);
});

test('edges: a roller bounces off or wraps round the edge, and stops there when Open or Wall', () => {
  for (const edge of EDGE_KINDS) {
    const t = field(edge);
    const r = makeRoller([t.half - 3, t.heightAt(t.half - 3, 0), 0], [20, 0, 0], t);
    let end = null;
    let crossed = null;
    for (let i = 0; i < 300 && !end && !crossed; i++) { end = stepRoller(r, t); crossed = r.crossed; }
    if (edge === 'bounce') { assert.equal(crossed.kind, 'bounce'); assert.ok(r.vel[0] < 0 && r.pos[0] <= t.half); }
    else if (edge === 'wrap') { assert.equal(crossed.kind, 'wrap'); assert.ok(r.pos[0] < -t.half + 5, `wrapped to ${r.pos[0]}`); }
    else { assert.equal(end, 'edge', `${edge} stops it`); assert.equal(crossed, null); }
  }
});

// A match on a small field, CPUs, no twists.
const match = (edges, seed = 4, extra = {}) => {
  const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }, { name: 'C', ai: 'normal' }], rounds: 3, seed, resolution: 128, twists: false, edges, ...extra });
  g.start();
  return g;
};

// Fire a shell from `p` straight at the nearest side, and fly it in the game
// until it is done; and the same shot through simulateShot.
function liveAndSimulated(g, p, elev = 38, power = 74) {
  const t = g.terrain;
  const sides = [[t.half - p.x, 0], [t.half + p.x, 180], [t.half - p.z, 90], [t.half + p.z, 270]];
  const yaw = sides.sort((a, b) => a[0] - b[0])[0][1];
  p.yaw = yaw; p.elev = elev; p.power = power;
  const pos = muzzleOrigin(p);
  const vel = launchVelocity(yaw, elev, power);
  const others = g.players.filter((q) => q !== p && q.alive).map(hitSphere);
  const sim = simulateShot({ pos, vel, wind: g.wind, terrain: t, gravity: g.gravity, windK: g.windShare(p), drag: g.shellDrag(p), targets: others });
  g.phase = 'flight';
  g.drainEvents?.();
  g.events.length = 0;
  const pr = g.spawnProjectile(pos, vel, 'shell', p.id);
  const seen = [];
  for (let i = 0; i < 40 / SIM_DT && !pr.dead; i++) {
    g.stepWorld(SIM_DT);
    seen.push(...g.events.splice(0));
  }
  return { sim, seen: seen.filter((e) => e.id === pr.id) };
}

for (const edges of ['bounce', 'wrap', 'wall']) {
  test(`edges: simulateShot agrees with the live shell under ${edges}`, () => {
    let checked = 0;
    for (const seed of [4, 5, 6]) {
      for (const power of [70, 80]) {
        const g = match(edges, seed);
        const p = g.players[0];
        const { sim, seen } = liveAndSimulated(g, p, 38, power);
        const crossings = seen.filter((e) => e.type === 'edge');
        const end = seen.find((e) => e.type === 'impact' || e.type === 'lost');
        assert.ok(end, 'the live shell came down');
        assert.equal(crossings.length, sim.edges, 'met the edge as often');
        for (const c of crossings) assert.equal(c.kind, edges);
        if (sim.kind === 'lost') { assert.equal(end.type, 'lost'); continue; }
        assert.equal(end.type, 'impact');
        const d = Math.hypot(end.pos[0] - sim.point[0], end.pos[1] - sim.point[1], end.pos[2] - sim.point[2]);
        assert.ok(d < 0.5, `${edges} seed ${seed} power ${power}: live ${end.pos.map((v) => v.toFixed(1))} vs sim ${sim.point.map((v) => v.toFixed(1))}`);
        if (sim.edges) checked++;
      }
    }
    assert.ok(checked >= 3, `shots that met the edge: ${checked}`);
  });
}

test('edges: a wrapped path records where to break the drawn line', () => {
  const t = field('wrap');
  const sim = simulateShot({ pos: [t.half - 30, 20, 0], vel: [70, 40, 0], terrain: t, recordPath: true });
  assert.ok(sim.edges >= 1);
  assert.ok(sim.breaks.length >= 1);
  for (const b of sim.breaks) {
    const a = sim.path[b - 1];
    const c = sim.path[b];
    assert.equal(Math.abs(a[0]), t.half, 'the line ends on the side');
    assert.equal(c[0], -a[0], 'and starts again on the other');
  }
  // No other segment is long.
  for (let i = 1; i < sim.path.length; i++) {
    if (sim.breaks.includes(i)) continue;
    const a = sim.path[i - 1];
    const c = sim.path[i];
    assert.ok(Math.hypot(c[0] - a[0], c[2] - a[2]) < 60, `segment ${i}`);
  }
});

test('edges: a wall shot detonates on the wall and leaves no roller', () => {
  const g = match('wall', 7);
  const { seen } = liveAndSimulated(g, g.players[1], 30, 95);
  const edge = seen.find((e) => e.type === 'edge');
  const impact = seen.find((e) => e.type === 'impact');
  assert.equal(edge?.kind, 'wall');
  assert.deepEqual([...impact.pos], [...edge.pos]);
  assert.equal(Math.max(Math.abs(impact.pos[0]), Math.abs(impact.pos[2])), g.terrain.half);
  assert.equal(g.projectiles.length, 0);
});

test('edges: the rule is in the config, rolled per round from the seed when Random', () => {
  const a = match('random', 11);
  const b = match('random', 11);
  const seq = (g) => { const out = [g.edge]; for (let r = 1; r < 3; r++) { g.startRound(); out.push(g.edge); } return out; };
  const sa = seq(a);
  assert.deepEqual(sa, seq(b), 'same seed, same rolls');
  for (const e of sa) assert.ok(EDGE_KINDS.includes(e));
  assert.equal(a.terrain.edge, a.edge, 'on the terrain too');
  const kinds = new Set();
  for (let seed = 1; seed < 30; seed++) kinds.add(match('random', seed).edge);
  assert.equal(kinds.size, 4, `all four come up: ${[...kinds]}`);
  // A fixed rule holds every round; the default is Open.
  const w = match('wrap', 3);
  w.startRound();
  assert.equal(w.edge, 'wrap');
  assert.equal(match(undefined).edge, 'open');
  assert.equal(match('sideways').cfg.edges, 'open', 'unknown words are Open');
});

test('edges: Open is the old game, roll for roll', () => {
  const a = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 2, seed: 21, resolution: 128 });
  const b = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 2, seed: 21, resolution: 128, edges: 'open' });
  a.start(); b.start();
  assert.deepEqual(Array.from(a.terrain.heights), Array.from(b.terrain.heights));
  assert.deepEqual(a.players.map((p) => [p.x, p.z]), b.players.map((p) => [p.x, p.z]));
  assert.equal(a.rogue.state(), b.rogue.state(), 'Open rolls nothing');
});

test('edges: snapshot and restore carry the round\'s rule', () => {
  const a = match('random', 12);
  a.startRound();
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = match('random', 12);
  b.restore(snap);
  assert.equal(b.edge, a.edge);
  assert.equal(b.terrain.edge, a.edge);
  const c = match('bounce', 12);
  c.restore(JSON.parse(JSON.stringify(c.snapshot())));
  assert.equal(c.terrain.edge, 'bounce');
});

test('edges: a CPU still finds its target with walls, bounces or wraps', () => {
  for (const edges of ['wall', 'bounce', 'wrap']) {
    const g = match(edges, 2);
    const [a, b] = g.players;
    const sol = solveShot({ shooter: a, target: [b.x, b.y, b.z], wind: g.wind, terrain: g.terrain, rng: makeRng(5), iterations: 25 });
    assert.ok(sol.predictedMiss < 12, `${edges}: predicted miss ${sol.predictedMiss}`);
  }
});

test('edges: the match builder and the query string', () => {
  assert.deepEqual(EDGES.map((e) => e.id), ['open', 'wall', 'bounce', 'wrap', 'random']);
  assert.deepEqual(parseTestParams('?edges=Wrap'), { edges: 'wrap' });
  assert.deepEqual(parseTestParams('?edges=sideways'), {});
  const r = () => 0.5;
  assert.equal(matchConditions({ wind: '0', terrain: '45' }, {}, r).edges, undefined, 'Open adds nothing');
  assert.equal(matchConditions({ wind: '0', terrain: '45', edges: 'bounce' }, {}, r).edges, 'bounce');
  assert.equal(matchConditions({ wind: '0', terrain: '45', edges: 'bounce' }, parseTestParams('?edges=random'), r).edges, 'random', 'the query string wins');
  assert.equal(conditionsLabel({ maxWind: 0, hills: 45, world: 'meadow' }, 'wrap'), 'Hilly · Calm wind · Wrapping edges');
  assert.equal(conditionsLabel({ maxWind: 0, hills: 45, world: 'meadow' }, 'open'), 'Hilly · Calm wind');
  assert.equal(edgeLabel('open'), '');
});
