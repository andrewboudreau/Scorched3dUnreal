// The Rain round modifier: quadratic air drag on shells (ballistics.stepProjectile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { simulateShot, stepProjectile, makeProjectile, launchVelocity, groundContact, GRAVITY, SIM_DT } from '../src/core/ballistics.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { Game } from '../src/core/game.js';
import { MODIFIERS, MODIFIER_BY_ID, PERKS, PERK_BY_ID, RAIN_DRAG } from '../src/core/perks.js';
import { muzzleOrigin } from '../src/core/tank.js';
import { surveyConditions, solveSite, SURVEY } from '../src/core/survey.js';
import { GROUP_BY_ID, parseTestParams } from '../src/builder.js';
import { modifierRows, perkRows } from '../src/guide.js';

function flatField(h = 0) {
  const t = new Heightfield({ size: 800, resolution: 200 });
  t.heights.fill(h);
  return t;
}

const range = (power, elev, drag = 0) =>
  simulateShot({ pos: [-390, 0.01, 0], vel: launchVelocity(0, elev, power), terrain: flatField(), drag }).point[0] + 390;
const loss = (power, elev) => 1 - range(power, elev, RAIN_DRAG) / range(power, elev);

// The step as it was before drag, kept here to pin "no drag, no change".
function oldStep(p, wind, dt = SIM_DT) {
  const k = p.windK ?? 1;
  p.vel[0] += wind[0] * k * dt;
  p.vel[1] -= (p.g ?? GRAVITY) * dt;
  p.vel[2] += wind[1] * k * dt;
  p.prev[0] = p.pos[0]; p.prev[1] = p.pos[1]; p.prev[2] = p.pos[2];
  p.pos[0] += p.vel[0] * dt;
  p.pos[1] += p.vel[1] * dt;
  p.pos[2] += p.vel[2] * dt;
  p.time += dt;
}

test('drag 0 (or none) flies exactly the old trajectory', () => {
  const wind = [0.8, -0.5];
  for (const drag of [undefined, 0]) {
    const a = makeProjectile([0, 10, 0], launchVelocity(30, 52, 71));
    const b = makeProjectile([0, 10, 0], launchVelocity(30, 52, 71));
    a.g = b.g = GRAVITY * 0.7; a.windK = b.windK = 0.65;
    if (drag !== undefined) a.drag = drag;
    for (let i = 0; i < 1500; i++) {
      stepProjectile(a, wind);
      oldStep(b, wind);
      assert.deepEqual(a.pos, b.pos);
      assert.deepEqual(a.vel, b.vel);
    }
  }
  const t = flatField();
  const shot = { pos: [0, 0.01, 0], vel: launchVelocity(10, 45, 60), wind, terrain: t, recordPath: true };
  assert.deepEqual(simulateShot({ ...shot, drag: 0 }), simulateShot(shot));
});

test('rain takes a power 60, 45 degree shot 15 to 20% short, and long lobs suffer more than flat shots', () => {
  assert.equal(MODIFIER_BY_ID.rain.drag, RAIN_DRAG);
  const typical = loss(60, 45);
  assert.ok(typical >= 0.15 && typical <= 0.2, `power 60 at 45 degrees lands ${(typical * 100).toFixed(1)}% short`);
  assert.ok(Math.abs(typical - 0.162) < 0.01, `measured ${(typical * 100).toFixed(1)}%, the comment in perks.js says about 16%`);
  assert.ok(loss(60, 20) < typical, 'a flat shot loses less');
  assert.ok(loss(60, 70) > loss(60, 20), 'a high lob loses more than a flat shot');
  assert.ok(loss(90, 45) > typical + 0.08, 'a long hard shot loses much more');
  assert.ok(loss(30, 30) < 0.06, 'a short lob barely feels it');
  // Still in reach: full power covers the arena's width in the rain.
  assert.ok(range(120, 40, RAIN_DRAG) > 800);
});

test('simulateShot with drag matches a step-by-step stepProjectile flight', () => {
  const t = new Heightfield({ size: 800, resolution: 96 }).generate({ seed: 9, amplitude: 40 });
  const wind = [-0.9, 0.6];
  const pos = [-200, t.heightAt(-200, 30) + 2, 30];
  const vel = launchVelocity(10, 48, 75);
  const sim = simulateShot({ pos, vel, wind, terrain: t, gravity: GRAVITY, windK: 0.65, drag: RAIN_DRAG });
  const p = makeProjectile(pos, vel);
  p.g = GRAVITY; p.windK = 0.65; p.drag = RAIN_DRAG;
  let hit = null;
  while (!hit && p.time < 40) { stepProjectile(p, wind); hit = groundContact(p, t); }
  assert.equal(sim.kind, 'ground');
  assert.deepEqual(sim.point, hit);
  assert.equal(sim.time, p.time);
});

// Hard-CPU aiming over a seeded sample: how many solved shots land within 10 m.
function cpuHits(drag) {
  const t = new Heightfield({ size: 800, resolution: 128 }).generate({ seed: 3, amplitude: 40 });
  const rng = makeRng(11);
  let within = 0;
  const cases = 24;
  for (let k = 0; k < cases; k++) {
    const a = rng.range(0, Math.PI * 2);
    const shooter = { x: Math.cos(a) * 250, z: Math.sin(a) * 250, y: 0 };
    shooter.y = t.heightAt(shooter.x, shooter.z);
    const tx = -shooter.x * rng.range(0.6, 1.2);
    const tz = -shooter.z * rng.range(0.6, 1.2) + rng.range(-80, 80);
    const wind = [rng.range(-1.2, 1.2), rng.range(-1.2, 1.2)];
    const sol = solveShot({ shooter, target: [tx, t.heightAt(tx, tz), tz], wind, terrain: t, rng: makeRng(k), drag });
    const shot = simulateShot({ pos: muzzleOrigin(shooter, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), wind, terrain: t, drag });
    if (Math.hypot(shot.point[0] - tx, shot.point[2] - tz) < 10) within++;
  }
  return { within, cases };
}

test('the CPU solver aims through the rain: its hit rate barely drops', () => {
  const dry = cpuHits(0);
  const wet = cpuHits(RAIN_DRAG);
  console.log(`cpu hits: dry ${dry.within}/${dry.cases}, rain ${wet.within}/${wet.cases}`);
  assert.ok(wet.within >= dry.within - 2, `rain ${wet.within}/${wet.cases}, dry ${dry.within}/${dry.cases}`);
  assert.ok(wet.within >= wet.cases - 3, `rain ${wet.within}/${wet.cases}`);
});

test('a Rain round puts its drag on every shell, split pieces too, and on the CPU and the satellite', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'hard' }], rounds: 3, seed: 5, resolution: 64, modifiers: ['rain'] });
  g.start();
  assert.equal(g.modifier.id, 'rain');
  assert.equal(g.drag, RAIN_DRAG);
  assert.equal(g.shellDrag(g.players[0]), RAIN_DRAG);
  const top = g.terrain.heightAt(0, 0) + 60;
  const pr = g.spawnProjectile([0, top, 0], [20, 15, 0], 'scatter', 0);
  assert.equal(pr.drag, RAIN_DRAG);
  for (let i = 0; i < 600 && !pr.splitDone; i++) g.stepWorld(SIM_DT);
  const kids = g.projectiles.filter((q) => q.weapon === 'scatterlet');
  assert.ok(kids.length > 0 && kids.every((q) => q.drag === RAIN_DRAG), 'scatterlets inherit the rain');
  // A dry round carries no drag at all.
  const dry = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: ['clear'] });
  dry.start();
  assert.equal(dry.drag, 0);
  assert.ok(!('drag' in dry.spawnProjectile([0, 50, 0], [10, 0, 0], 'shell', 0)));
  // Snapshot and restore keep it.
  const copy = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: ['clear'] });
  copy.start();
  copy.restore(g.snapshot());
  assert.equal(copy.drag, RAIN_DRAG);
  assert.equal(copy.modifier.id, 'rain');
  // The satellite counts rain at level 1.
  assert.equal(surveyConditions(1, { drag: RAIN_DRAG }).drag, RAIN_DRAG);
});

test('satellite solutions land in the rain', () => {
  const t = flatField();
  const me = { x: -150, y: 0, z: 0, yaw: 0, elev: 45, power: 60 };
  const target = [120, 0, 30];
  const cond = surveyConditions(1, { drag: RAIN_DRAG });
  const sol = solveSite({ shooter: me, elev: 45, target, cond, terrain: t });
  assert.ok(sol.reach);
  const shot = simulateShot({ pos: muzzleOrigin(me, sol.yaw, 45), vel: launchVelocity(sol.yaw, 45, sol.power), terrain: t, drag: RAIN_DRAG });
  assert.ok(Math.hypot(shot.point[0] - target[0], shot.point[2] - target[2]) <= SURVEY.reachMiss);
});

test('Streamlined Shells halve the drag, and only come up when the match can roll rain', () => {
  assert.equal(PERK_BY_ID.streamlined.dragScale, -0.5);
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: ['rain'] });
  g.start();
  g.players[0].perks.push('streamlined');
  assert.equal(g.shellDrag(g.players[0]), RAIN_DRAG * 0.5);
  assert.equal(g.spawnProjectile([0, 50, 0], [10, 0, 0], 'shell', 0).drag, RAIN_DRAG * 0.5);
  assert.ok(g.perkFits(g.players[1], PERK_BY_ID.streamlined));
  const dry = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: ['clear', 'gale'] });
  assert.ok(!dry.perkFits(dry.players[1], PERK_BY_ID.streamlined), 'no rain, no streamlining');
  const off = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: ['rain'], perks: ['hull'] });
  assert.ok(!off.perkFits(off.players[1], PERK_BY_ID.streamlined), 'the builder turned it off');
});

test('Rain shows up in the match builder and the guide on its own', () => {
  assert.ok(GROUP_BY_ID.modifiers.items.some((it) => it.id === 'rain' && /add power/.test(it.desc)));
  assert.ok(GROUP_BY_ID.perks.items.some((it) => it.id === 'streamlined'));
  assert.ok(modifierRows(MODIFIERS).some((r) => r.name === 'Rain' && /aim flatter/.test(r.text)));
  assert.ok(perkRows(PERKS).some((r) => r.name === 'Streamlined Shells'));
});

test('?modifier=rain makes every round a Rain round', () => {
  assert.deepEqual(parseTestParams('?modifier=Rain'), { modifier: 'rain' });
  assert.deepEqual(parseTestParams('?modifier=hail'), {}, 'unknown ids are ignored');
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifier: 'rain' });
  g.start();
  assert.equal(g.modifier.id, 'rain');
  g.endRound();
  g.startRound();
  assert.equal(g.modifier.id, 'rain', 'and the next one');
  assert.equal(g.drag, RAIN_DRAG);
  const bogus = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifier: 'hail' });
  assert.equal(bogus.cfg.modifier, null);
});
