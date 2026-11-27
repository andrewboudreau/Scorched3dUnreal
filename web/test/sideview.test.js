import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { GRAVITY, makeProjectile, stepProjectile, launchVelocity } from '../src/core/ballistics.js';
import { muzzleOrigin } from '../src/core/tank.js';
import { makeFlight, makeSide, traceFlight, layoutSide, fitSide, alongShot, edgeDistance, loadSide, saveSide, SIDE_KEY, GROUND, FLIGHT } from '../src/sideview.js';

// The side view's numbers: the flight the aim arc draws (and no more), laid
// out flat with the ground along its track.

const field = (edge = 'open', amplitude = 8) => {
  const t = new Heightfield({ size: 800, resolution: 128 });
  t.generate({ seed: 5, amplitude });
  t.edge = edge;
  return t;
};
const tank = (t, x, z, yaw, elev, power) => ({ x, z, y: t.heightAt(x, z), yaw, elev, power, size: 1, color: '#f00' });
// What Game gives the trace: terrain, wind, gravity, windShare(p), shellDrag(p).
const rules = (t, wind = [0, 0]) => ({ terrain: t, wind, gravity: GRAVITY, windShare: () => 1, shellDrag: () => 0 });

test('the trace climbs from the muzzle to the top of the flight and no further', () => {
  const t = field();
  const p = tank(t, -200, 0, 0, 45, 70);
  const f = traceFlight(makeFlight(), rules(t), p);
  assert.equal(f.hit, null);
  assert.equal(f.apexAt, f.n - 1, 'it ends at the top');
  assert.ok(f.y[f.n - 1] > f.y[0] + 40, 'well above the muzzle');
  // The top, from the same stepper: vertical speed turns over there.
  const pr = makeProjectile(muzzleOrigin(p), launchVelocity(p.yaw, p.elev, p.power), t);
  let top = 0;
  for (let i = 0; i < 4000 && pr.vel[1] > 0; i++) { stepProjectile(pr, [0, 0]); top = pr.pos[1]; }
  assert.ok(Math.abs(f.y[f.n - 1] - top) < 0.5, `${f.y[f.n - 1]} vs ${top}`);
  for (let i = 1; i < f.n; i++) assert.ok(f.x[i] >= f.x[i - 1] - 1e-4, 'east, steadily');
});

test('wind bends the climb as the arc does', () => {
  const t = field();
  const p = tank(t, -200, 0, 0, 45, 70);
  const calm = traceFlight(makeFlight(), rules(t), p);
  const calmZ = calm.z[calm.n - 1];
  const gust = traceFlight(makeFlight(), rules(t, [0, 8]), p);
  assert.ok(Math.abs(gust.z[gust.n - 1] - calmZ) > 3, 'pushed sideways');
});

test('the Tracer perk shows more only when the climb is shorter than its reach', () => {
  const t = field();
  const long = tank(t, -200, 0, 0, 45, 70);
  const a = traceFlight(makeFlight(), rules(t), long);
  const b = traceFlight(makeFlight(), rules(t), long, 45);
  assert.equal(a.n, b.n, 'a climb longer than the tracer: nothing more is shown');
  const short = tank(t, -200, 0, 0, 30, 26);
  const c = traceFlight(makeFlight(), rules(t), short);
  const cn = c.n, capex = c.apexAt;
  const d = traceFlight(makeFlight(), rules(t), short, 45);
  assert.ok(d.n > cn, 'a short climb: the tracer runs on past the top');
  assert.equal(d.apexAt, capex, 'the top is still the top');
  let len = 0;
  for (let i = 1; i < d.n; i++) len += Math.hypot(d.x[i] - d.x[i - 1], d.y[i] - d.y[i - 1], d.z[i] - d.z[i - 1]);
  assert.ok(len >= 44 && len < 60, `about 45 m of flight, got ${len}`);
});

test('a shot into a hillside ends there, as the arc does', () => {
  const t = field('open', 8);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) if (t.vx(i) > -150 && t.vx(i) < -100) t.heights[t.index(i, j)] = 150;   // a ridge ahead
  const p = tank(t, -200, 0, 0, 20, 90);
  const f = traceFlight(makeFlight(), rules(t), p);
  assert.equal(f.hit, 'ground');
  assert.equal(f.apexAt, -1);
  const last = f.n - 1;
  assert.ok(Math.abs(f.y[last] - t.heightAt(f.x[last], f.z[last])) < 0.5);
});

test('walls, bounces and wraps: the trace follows the edge rule', () => {
  const wall = field('wall');
  let p = tank(wall, 330, 0, 10, 45, 85);
  let f = traceFlight(makeFlight(), rules(wall), p);
  assert.equal(f.hit, 'wall');
  assert.ok(Math.abs(f.x[f.n - 1] - wall.half) < 0.01);
  assert.equal(f.edgeAt, f.n - 1);

  const bounce = field('bounce');
  p = tank(bounce, 330, 0, 10, 45, 85);
  f = traceFlight(makeFlight(), rules(bounce), p);
  assert.equal(f.edge, 'bounces');
  assert.equal(f.n1, 0, 'a bounce is one line');
  assert.ok(f.x[f.n - 1] < bounce.half - 5, 'it came back in');
  assert.ok(f.edgeAt > 0);

  const wrap = field('wrap');
  p = tank(wrap, 330, 0, 10, 45, 85);
  f = traceFlight(makeFlight(), rules(wrap), p);
  assert.equal(f.edge, 'wraps');
  assert.ok(f.n1 > 0, 'the second line starts after the wrap');
  assert.ok(f.x[f.n1 - 1] > wrap.half - 1 && f.x[f.n1] < -wrap.half + 1, 'out one side, in the other');
});

test('laid out flat: distance runs on through a bounce and stands still across a wrap', () => {
  const bounce = field('bounce');
  let p = tank(bounce, 330, 0, 0, 45, 85);
  let f = traceFlight(makeFlight(), rules(bounce), p);
  let side = layoutSide(makeSide(), f, bounce, p);
  for (let i = 1; i < side.n; i++) assert.ok(side.s[i] >= side.s[i - 1], 'never backwards');
  assert.ok(side.s[side.n - 1] > 100, 'out to the wall (70 m) and back');
  assert.ok(Math.abs(side.edgeS - 70) < 5, `the wall is about 70 m out, got ${side.edgeS}`);

  const wrap = field('wrap');
  p = tank(wrap, 330, 0, 0, 45, 85);
  f = traceFlight(makeFlight(), rules(wrap), p);
  side = layoutSide(makeSide(), f, wrap, p);
  assert.equal(side.s[f.n1], side.s[f.n1 - 1], 'no distance across the cut');
  assert.equal(side.n1, f.n1);
});

test('the ground profile follows the shot line and is cut where there is none', () => {
  const t = field('open', 12);
  const p = tank(t, -100, 40, 20, 45, 60);
  const f = traceFlight(makeFlight(), rules(t), p);
  const side = layoutSide(makeSide(), f, t, p);
  assert.equal(side.ground.length, GROUND.samples);
  const yaw = 20 * Math.PI / 180;
  // The shot flies straight on a calm day, so its track is the yaw line.
  for (const k of [10, 30, 60]) {
    const s = side.s0 + k * side.ds;
    if (s > side.topS) continue;
    const x = p.x + Math.cos(yaw) * s, z = p.z + Math.sin(yaw) * s;
    assert.ok(Math.abs(side.ground[k] - t.heightAt(x, z)) < 0.6, `sample ${k}`);
  }
  // Behind the tank, on the line back.
  assert.ok(Math.abs(side.ground[0] - t.heightAt(p.x - Math.cos(yaw) * GROUND.behind, p.z - Math.sin(yaw) * GROUND.behind)) < 0.6);
  // The ground reaches past the flight, but the flight shows nothing there.
  assert.ok(side.s1 >= side.topS * 2, 'room for the fall');
  assert.ok(side.yMax >= side.topY && side.yMin <= side.tankY);

  // Open edge: past the arena the ground stops.
  const near = tank(t, 350, 0, 0, 45, 70);
  const f2 = traceFlight(makeFlight(), rules(t), near);
  const s2 = layoutSide(makeSide(), f2, t, near);
  assert.ok(Number.isNaN(s2.ground[GROUND.samples - 1]), 'off the arena: no ground');
  assert.ok(!Number.isNaN(s2.ground[0]));
});

test('bounce folds the ground back; wrap cuts it', () => {
  const bounce = field('bounce', 12);
  let p = tank(bounce, 330, 0, 0, 45, 85);
  let f = traceFlight(makeFlight(), rules(bounce), p);
  let side = layoutSide(makeSide(), f, bounce, p);
  assert.ok(side.ground.every((h) => !Number.isNaN(h)), 'never off the map');
  // Past the end of the flight the ground at s is the ground at the folded x.
  const k = GROUND.samples - 1, s = side.s0 + k * side.ds;
  const sEnd = side.s[side.n - 1];
  assert.ok(s > sEnd);
  const x = 330 + s;
  const folded = x > bounce.half ? 2 * bounce.half - x : x;
  assert.ok(Math.abs(side.ground[k] - bounce.heightAt(folded, 0)) < 3.5, 'folded back');

  const wrap = field('wrap', 12);
  p = tank(wrap, 330, 0, 0, 45, 85);
  f = traceFlight(makeFlight(), rules(wrap), p);
  side = layoutSide(makeSide(), f, wrap, p);
  assert.ok(side.ground.some((h) => Number.isNaN(h)), 'a cut at the wrap');
  assert.ok(side.ground.filter((h) => !Number.isNaN(h)).length > GROUND.samples * 0.9);
});

test('buffers are fixed and a long flight stays inside them', () => {
  const t = field('bounce');
  const p = tank(t, 0, 0, 33, 80, 100);
  const f = makeFlight();
  traceFlight(f, rules(t), p, 400);
  assert.ok(f.n <= FLIGHT.maxPts);
  assert.equal(f.x.length, FLIGHT.maxPts);
});

test('fitting keeps one scale on both axes and everything inside the box', () => {
  const t = field();
  const p = tank(t, -200, 0, 0, 45, 70);
  const f = traceFlight(makeFlight(), rules(t), p);
  const side = layoutSide(makeSide(), f, t, p);
  const fit = fitSide(side, 196, 76, 5);
  assert.ok(fit.k > 0);
  for (const i of [0, side.top, side.n - 1]) {
    const x = fit.ox + side.s[i] * fit.k, y = fit.oy - side.y[i] * fit.k;
    assert.ok(x >= 0 && x <= 196 && y >= 0 && y <= 76, `${x}, ${y}`);
  }
  assert.ok(fit.oy - side.yMin * fit.k <= 76);
});

test('enemies near the line of the shot are placed along it; others are not', () => {
  const t = field('open');
  const p = tank(t, -100, 0, 0, 45, 70);
  const f = traceFlight(makeFlight(), rules(t), p);
  const side = layoutSide(makeSide(), f, t, p);
  const a = alongShot(side, p, 100, 12);
  assert.ok(Math.abs(a.along - 200) < 1e-6 && Math.abs(Math.abs(a.side) - 12) < 1e-6);
  assert.equal(alongShot(side, p, -150, 0), null, 'behind');
  assert.equal(alongShot(side, p, 900, 0), null, 'past the arena');
  assert.ok(Math.abs(edgeDistance(0, 0, 0, 1, 400) - 400) < 1e-9);
  assert.ok(Math.abs(edgeDistance(0, 0, Math.SQRT1_2, Math.SQRT1_2, 400) - 400 * Math.SQRT2) < 1e-6);
});

test('the setting is remembered; with nothing saved it follows the default', () => {
  const store = new Map();
  const s = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(loadSide(true, s), true);
  assert.equal(loadSide(false, s), false);
  saveSide(false, s);
  assert.equal(store.get(SIDE_KEY), '0');
  assert.equal(loadSide(true, s), false, 'a choice beats the default');
  saveSide(true, s);
  assert.equal(loadSide(false, s), true);
  assert.equal(loadSide(true, { getItem() { throw new Error('private'); } }), true);
});
