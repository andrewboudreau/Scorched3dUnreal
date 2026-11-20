import { test } from 'node:test';
import assert from 'node:assert/strict';
import { craterDepthAt, Heightfield } from '../src/core/terrain.js';
import { muzzleDirection, launchVelocity, simulateShot, GRAVITY, rollDownhill } from '../src/core/ballistics.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { Game } from '../src/core/game.js';
import { WEAPON_BY_ID, impactEffects, splitVelocities } from '../src/core/weapons.js';
import { TANK, muzzleOrigin } from '../src/core/tank.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

function flatField(h = 0) {
  const t = new Heightfield({ size: 800, resolution: 200 });
  t.heights.fill(h);
  return t;
}

// ---- M0: terrain (ports of CraterMathTest / CraterCarveTest) ----

test('crater depth: full depth at centre, zero at and beyond radius', () => {
  near(craterDepthAt(0, 10, 1), 10, 1e-9);
  assert.equal(craterDepthAt(10, 10, 1), 0);
  assert.equal(craterDepthAt(15, 10, 1), 0);
  assert.ok(craterDepthAt(5, 10, 1) > 0 && craterDepthAt(5, 10, 1) < 10);
  assert.equal(craterDepthAt(1, 0, 1), 0);
});

test('carve makes a real depression and raises nothing (no lid possible)', () => {
  const t = flatField(0);
  const before = Float32Array.from(t.heights);
  t.carveCrater(0, 0, 0, 20, 1);
  near(t.heightAt(0, 0), -20, 0.5, 'centre');
  assert.equal(t.heightAt(100, 100), 0, 'far terrain untouched');
  for (let k = 0; k < t.heights.length; k++) assert.ok(t.heights[k] <= before[k] + 1e-6);
});

test('carve never digs below bedrock', () => {
  const t = flatField(0);
  for (let i = 0; i < 20; i++) t.carveCrater(0, t.heightAt(0, 0), 0, 30, 1);
  assert.ok(Math.min(...t.heights) >= t.bedrock);
});

test('mound raises ground', () => {
  const t = flatField(0);
  t.raiseMound(0, 0, 20, 10);
  near(t.heightAt(0, 0), 10, 0.5);
  assert.equal(t.heightAt(200, 0), 0);
});

// ---- M1: ballistics ----

test('muzzle direction: yaw 0 is +x, yaw 90 is +z, elevation 90 is up', () => {
  const a = muzzleDirection(0, 0);
  near(a[0], 1, 1e-9); near(a[1], 0, 1e-9); near(a[2], 0, 1e-9);
  const b = muzzleDirection(90, 0);
  near(b[2], 1, 1e-9);
  const c = muzzleDirection(0, 90);
  near(c[1], 1, 1e-9);
});

test('range on flat ground matches v^2 sin(2θ)/g with no wind', () => {
  const t = flatField(0);
  for (const [elev, v] of [[45, 50], [30, 60], [60, 60]]) {
    const r = simulateShot({ pos: [0, 0.001, 0], vel: launchVelocity(0, elev, v), terrain: t });
    const expected = (v * v * Math.sin((2 * elev * Math.PI) / 180)) / GRAVITY;
    near(r.point[0], expected, expected * 0.01, `elev ${elev} v ${v}`);
    assert.equal(r.kind, 'ground');
  }
});

test('wind drifts the shot downwind, and more wind drifts it further', () => {
  const t = flatField(0);
  const shot = (w) => simulateShot({ pos: [0, 0.001, 0], vel: launchVelocity(0, 50, 60), wind: [0, w], terrain: t }).point[2];
  assert.ok(shot(0.5) > 1);
  assert.ok(shot(1.5) > shot(0.5));
  assert.ok(shot(-1) < -1);
});

test('shot stops at a hill rather than passing through it', () => {
  const t = flatField(0);
  t.raiseMound(150, 0, 40, 60);
  const r = simulateShot({ pos: [0, 1, 0], vel: launchVelocity(0, 20, 80), terrain: t });
  assert.equal(r.kind, 'ground');
  assert.ok(r.point[0] < 160, `landed at ${r.point[0]}`);
});

test('roller ends lower than it started on a slope', () => {
  const t = flatField(0);
  t.raiseMound(0, 0, 80, 40);
  const end = rollDownhill(t, [20, t.heightAt(20, 0), 0]);
  assert.ok(end[1] < t.heightAt(20, 0) - 5);
});

// ---- M3: weapons ----

test('composed weapons expand into the expected effects', () => {
  const t = flatField(0);
  const shell = impactEffects(WEAPON_BY_ID.shell, [0, 0, 0], t);
  assert.deepEqual(shell.map((e) => e.type), ['blast']);
  const roller = impactEffects(WEAPON_BY_ID.roller, [0, 0, 0], t);
  assert.deepEqual(roller.map((e) => e.type), ['roll', 'blast']);
  const v = splitVelocities([10, 0, 0], 5, 9);
  assert.equal(v.length, 5);
  near(v[0][2], -9, 1e-9); near(v[4][2], 9, 1e-9); near(v[2][2], 0, 1e-9);
});

// ---- M4: AI aiming ----

test('AI converges on targets across terrain and wind', () => {
  const t = new Heightfield({ size: 800, resolution: 200 }).generate({ seed: 3, amplitude: 40 });
  const rng = makeRng(11);
  let within = 0;
  const cases = 12;
  for (let k = 0; k < cases; k++) {
    const a = rng.range(0, Math.PI * 2);
    const shooter = { x: Math.cos(a) * 250, z: Math.sin(a) * 250, y: 0 };
    shooter.y = t.heightAt(shooter.x, shooter.z);
    const tx = -shooter.x * rng.range(0.6, 1.2);
    const tz = -shooter.z * rng.range(0.6, 1.2) + rng.range(-80, 80);
    const target = [tx, t.heightAt(tx, tz), tz];
    const wind = [rng.range(-1.2, 1.2), rng.range(-1.2, 1.2)];
    const sol = solveShot({ shooter, target, wind, terrain: t, rng: makeRng(k), difficulty: 'hard' });
    const shot = simulateShot({
      pos: muzzleOrigin(shooter, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), wind, terrain: t,
    });
    const miss = Math.hypot(shot.point[0] - tx, shot.point[2] - tz);
    assert.ok(sol.predictedMiss < 4, `solver converged to ${sol.predictedMiss} m on case ${k}`);
    if (miss < 10) within++;
  }
  assert.ok(within >= cases - 1, `hard AI landed within 10 m on ${within}/${cases}`);
});

// ---- M5: turn/round loop ----

test('an all-AI match plays to completion with a winner each round', () => {
  const g = new Game({
    players: [{ name: 'A', ai: 'hard' }, { name: 'B', ai: 'normal' }, { name: 'C', ai: 'easy' }],
    rounds: 2, seed: 1234, resolution: 160,
  });
  g.start();
  const results = [];
  let guard = 0;
  while (g.phase !== 'matchOver' && guard++ < 200000) {
    g.update(1 / 30);
    for (const e of g.drainEvents()) if (e.type === 'roundOver' || e.type === 'matchOver') results.push(e);
    if (g.phase === 'roundOver' && g.phaseTime > 1) g.openShop();
  }
  assert.equal(g.phase, 'matchOver', 'match finished');
  assert.equal(results.length, 2);
  assert.equal(g.players.reduce((s, p) => s + p.wins, 0), 2);
});

test('turn order skips destroyed tanks', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], rounds: 1, seed: 5, resolution: 64 });
  g.start();
  const first = g.turn;
  const skip = (first + 1) % 3;
  g.players[skip].alive = false;
  g.nextTurn();
  assert.equal(g.turn, (first + 2) % 3);
});

test('a blast hurts a tank in range, and armor soaks first', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 9, resolution: 64 });
  g.start();
  const b = g.players[1];
  b.armor = 10;
  g.applyEffect({ type: 'blast', point: [b.x, b.y, b.z], radius: 11, damage: 38, depth: 0.6 }, 0, null);
  assert.equal(b.armor, 0);
  assert.ok(b.hp < TANK.maxHp && b.hp > TANK.maxHp - 38);
  assert.ok(g.players[0].money > 0, 'attacker paid for damage');
});

test('a tank falls into a crater dug beneath it and takes fall damage', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 21, resolution: 128 });
  g.start();
  const a = g.players[0];
  const y0 = a.y;
  // Dig a deep hole directly under A without blast damage.
  g.terrain.carveCrater(a.x, a.y, a.z, 25, 1);
  for (let i = 0; i < 600; i++) g.stepWorld(1 / 120);
  assert.ok(a.y < y0 - 15, 'tank dropped');
  assert.ok(a.hp < TANK.maxHp, 'fall damage applied');
  assert.equal(a.falling, false);
});

test('shop: buying spends money and grants a bundle', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 2, seed: 2, resolution: 64 });
  g.start();
  const a = g.players[0];
  a.money = 500;
  assert.ok(g.buy(0, 'breacher'));
  assert.equal(a.money, 340);
  assert.equal(a.inventory.breacher, 4);
  assert.equal(g.buy(0, 'shell'), false, 'shell is free and infinite, not for sale');
  a.money = 10;
  assert.equal(g.buy(0, 'scatter'), false);
});
