import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { airburstNow, WEAPON_BY_ID } from '../src/core/weapons.js';
import { solveShot, descentThrough, flakPass, FLAK_PASS, DIFFICULTY } from '../src/core/ai.js';
import { simulateShot, launchVelocity, SIM_DT } from '../src/core/ballistics.js';
import { muzzleOrigin } from '../src/core/tank.js';
import { makeRng } from '../src/core/rng.js';

// Flak: a proximity fuse. It bursts at its nearest pass over an enemy, or just
// above the ground when it passes nobody.

const BURST = WEAPON_BY_ID.flak.flight.find((f) => f.type === 'airburst');

test('flak: bursts at its closest pass over an enemy, not before', () => {
  const tank = { x: 0, y: 0, z: 0, owner: 1 };
  const shell = (x, vy) => ({ owner: 0, pos: [x, 20, 0], vel: [20, vy, 0] });
  assert.equal(airburstNow(shell(-15, -10), BURST, [tank], null), false, 'still closing in');
  assert.equal(airburstNow(shell(1, -10), BURST, [tank], null), true, 'right over it');
  assert.equal(airburstNow(shell(4, -10), BURST, [tank], null), true, 'just past');
  assert.equal(airburstNow(shell(1, 5), BURST, [tank], null), false, 'still climbing');
  assert.equal(airburstNow({ owner: 1, pos: [1, 20, 0], vel: [20, -10, 0] }, BURST, [tank], null), false, 'never over its own tank');
  assert.equal(airburstNow({ owner: 0, pos: [1, 80, 0], vel: [20, -10, 0] }, BURST, [tank], null), false, 'too high over it');
  assert.equal(airburstNow({ owner: 0, pos: [300, 8, 0], vel: [20, -10, 0] }, BURST, [tank], 0), true, 'near the ground, nobody about');
  assert.equal(airburstNow({ owner: 0, pos: [300, 8, 0], vel: [20, -10, 0] }, BURST, [tank], null), false, 'over open space');
});

test('flak: a shell that passes just over a tank hurts it', () => {
  let hurt = 0;
  for (const seed of [2, 5, 9]) {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed, resolution: 128, twists: false });
    g.start();
    const [a, b] = g.players;
    const hp = b.hp;
    // Drop a flak shell from 60 m up, 30 m short of B, drifting toward it.
    g.phase = 'flight';
    g.spawnProjectile([b.x - 30, b.y + 60, b.z], [15, 0, 0], 'flak', a.id, 1);
    for (let i = 0; i < 120 * 10 && g.projectiles.some((p) => !p.dead); i++) g.stepWorld(1 / 120);
    if (b.hp < hp) hurt++;
  }
  assert.ok(hurt >= 2, `hurt in ${hurt} of 3`);
});

// ---- the CPU's Flak aim (ai.flakPass): over the target, not at it ----

function duel(seed, ai = 'normal') {
  const g = new Game({ players: [{ name: 'A', ai }, { name: 'B', ai }], rounds: 1, seed, resolution: 128, twists: false });
  g.start();
  g.drainEvents();
  return g;
}
const conds = (g) => ({ wind: g.wind, terrain: g.terrain, gravity: g.gravity, windK: 1, drag: 0 });
const across = (p, b) => Math.hypot(p[0] - b.x, p[2] - b.z);

test('flak aim: only Flak is aimed over, and Easy CPUs aim it like a shell', () => {
  const flak = WEAPON_BY_ID.flak;
  assert.equal(flakPass(flak, 'easy'), 0);
  assert.equal(flakPass(flak, 'normal'), FLAK_PASS.normal);
  assert.equal(flakPass(flak, 'hard'), FLAK_PASS.hard);
  assert.ok(FLAK_PASS.normal >= BURST.low && FLAK_PASS.normal <= BURST.floor, 'over it, low enough that the pattern stays tight');
  for (const id of ['shell', 'scatter', 'breacher', 'thunderhead']) assert.equal(flakPass(WEAPON_BY_ID[id], 'hard'), 0, id);
  // The path helper: where a recorded flight came down through a height.
  assert.deepEqual(descentThrough({ path: [[0, 0, 0], [10, 30, 0], [20, 10, 0]] }, 20), [15, 20, 0]);
  assert.equal(descentThrough({ path: [[0, 0, 0], [10, 30, 0]] }, 20), null, 'never came down through it');
});

test('flak aim: the solver passes the shell over the target at the asked height', () => {
  for (const seed of [3, 8, 14]) {
    const g = duel(seed);
    const [a, b] = g.players;
    const sol = solveShot({ shooter: a, target: [b.x, b.y + 1, b.z], rng: makeRng(seed), ...conds(g), pass: 10 });
    const shot = simulateShot({ pos: muzzleOrigin(a, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), ...conds(g), recordPath: true });
    const over = descentThrough(shot, b.y + 10);
    assert.ok(over && across(over, b) < 3, `seed ${seed}: 10 m up, ${over && across(over, b).toFixed(1)} m off`);
    assert.ok(Math.hypot(shot.point[0] - a.x, shot.point[2] - a.z) > Math.hypot(b.x - a.x, b.z - a.z) + 3, 'it would land past the target');
    // Without a pass height it is the usual shot, onto the tank.
    const at = solveShot({ shooter: a, target: [b.x, b.y + 1, b.z], rng: makeRng(seed), ...conds(g) });
    const land = simulateShot({ pos: muzzleOrigin(a, at.yaw, at.elev), vel: launchVelocity(at.yaw, at.elev, at.power), ...conds(g) }).point;
    assert.ok(across(land, b) < 3, `seed ${seed}: lands ${across(land, b).toFixed(1)} m off`);
  }
});

// A CPU's own Flak shot (planAiShot) with its aiming error taken away, fired
// for real: where it burst and what it did.
function cpuFlak(seed, ai) {
  const g = duel(seed, ai);
  const [a, b] = g.players;
  b.hp = b.maxHp = 1000;
  a.inventory = { flak: 5 };
  a.aim = {};   // forget the aim it took at the start of its turn
  const keep = { ...DIFFICULTY[ai] };
  Object.assign(DIFFICULTY[ai], { yaw: 0, power: 0, jitterYaw: 0, jitterPower: 0 });
  let plan;
  try {
    // The Shell is always in the mix: ask until it reaches for the Flak.
    for (let k = 0; k < 60 && plan?.weapon !== 'flak'; k++) plan = g.planAiShot(a);
  } finally { Object.assign(DIFFICULTY[ai], keep); }
  assert.equal(plan.weapon, 'flak');
  Object.assign(a, { yaw: plan.yaw, elev: plan.elev, power: plan.power, weapon: 'flak' });
  g.launch(a);
  let burst = null;
  for (let k = 0; k < 8000 && g.projectiles.length; k++) {
    g.stepWorld(SIM_DT);
    for (const e of g.drainEvents()) if (e.type === 'split' && e.airburst) burst ||= e.pos;
  }
  return { plan, off: across(burst, b), up: burst[1] - b.y, dmg: 1000 - b.hp };
}

test('flak aim: a Normal or Hard CPU bursts its Flak over the target, an Easy one short of it for less', () => {
  let over = 0, short = 0;
  for (const seed of [3, 8, 14]) {
    for (const ai of ['normal', 'hard']) {
      const r = cpuFlak(seed, ai);
      assert.ok(r.off < 6 && r.up > 4 && r.up < 20, `${ai} seed ${seed}: burst ${r.off.toFixed(1)} m across, ${r.up.toFixed(1)} m up`);
      assert.ok(r.dmg > 20 && r.dmg < 70, `${ai} seed ${seed}: ${r.dmg.toFixed(1)}`);
      if (ai === 'normal') over += r.dmg;
    }
    const e = cpuFlak(seed, 'easy');
    assert.ok(e.off > 5, `easy seed ${seed}: ${e.off.toFixed(1)} m off`);
    short += e.dmg;
  }
  assert.ok(over > short, `over ${over.toFixed(0)} against short ${short.toFixed(0)}`);
  // The same seed plans the same shot (online copies agree).
  assert.deepEqual(cpuFlak(8, 'normal').plan, cpuFlak(8, 'normal').plan);
});
