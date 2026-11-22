import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { simulateShot, launchVelocity, GRAVITY } from '../src/core/ballistics.js';
import { muzzleOrigin } from '../src/core/tank.js';
import { Game } from '../src/core/game.js';
import {
  SURVEY, normalizeLab, satelliteLevel, satellitePrice, labelShare, surveyConditions,
  siteAt, surveySites, labelledSites, surveyFocus, patchCentre, solveSite, SurveyCache,
} from '../src/core/survey.js';

function field(seed = 5) {
  const t = new Heightfield({ size: 800, resolution: 128 });
  t.generate({ seed, amplitude: 30 });
  return t;
}

const tankOn = (t, x, z, extra = {}) => ({ x, y: t.heightAt(x, z), z, yaw: 0, elev: 50, power: 60, ...extra });

// Fire the solution through the real simulator and say how far from `target` it lands.
function landingMiss(t, shooter, elev, sol, target, wind, windK = 1) {
  const shot = simulateShot({ pos: muzzleOrigin(shooter, sol.yaw, elev), vel: launchVelocity(sol.yaw, elev, sol.power), wind, terrain: t, windK });
  return Math.hypot(shot.point[0] - target[0], shot.point[2] - target[2]);
}

test('survey sites are anchored to the world, whatever the patch', () => {
  const a = surveySites({ cx: 0, cz: 0, seed: 9 });
  const b = surveySites({ cx: 40, cz: -30, seed: 9 });
  const byKey = new Map(a.map((s) => [s.key, s]));
  let shared = 0;
  for (const s of b) {
    const o = byKey.get(s.key);
    if (!o) continue;
    shared++;
    assert.equal(o.x, s.x);
    assert.equal(o.z, s.z);
    assert.equal(o.roll, s.roll);
  }
  assert.ok(shared > 20, `shared ${shared}`);
  // Each site sits inside the middle of its own lattice cell.
  for (const s of a) {
    const fx = s.x / SURVEY.spacing - s.i, fz = s.z / SURVEY.spacing - s.j;
    assert.ok(fx >= 0.18 && fx <= 0.82 && fz >= 0.18 && fz <= 0.82);
  }
  // Another round's seed moves them.
  assert.notEqual(siteAt(3, 4, 9).x, siteAt(3, 4, 10).x);
});

test('survey labels about the share asked for, nearest the middle first', () => {
  const sites = surveySites({ cx: 0, cz: 0, radius: 600, seed: 3 });
  const share = labelShare({ labels: 'some' }, 1);
  const inside = sites.filter((s) => s.d <= 600);
  const got = labelledSites(sites, share, 600).length / inside.length;
  assert.ok(Math.abs(got - share) < 0.06, `labelled ${got} of ${share}`);
  assert.ok(labelShare({ labels: 'many' }, 1) > labelShare({ labels: 'few' }, 1));
  assert.ok(labelShare({ labels: 'some' }, 3) > labelShare({ labels: 'some' }, 2));
  const few = labelledSites(sites, share, 600, 5);
  assert.equal(few.length, 5);
  for (let k = 1; k < few.length; k++) assert.ok(few[k].d >= few[k - 1].d);
});

test('survey levels: wind and moons only from level 2', () => {
  const wells = [{ x: 0, y: 50, z: 0, r: 10, mu: 100 }];
  const one = surveyConditions(1, { wind: [1.2, -0.4], windK: 0.65, gravity: 7, wells });
  assert.deepEqual(one.wind, [0, 0]);
  assert.equal(one.wells.length, 0);
  assert.equal(one.gravity, 7);
  const two = surveyConditions(2, { wind: [1.2, -0.4], windK: 0.65, gravity: 7, wells });
  assert.deepEqual(two.wind, [1.2, -0.4]);
  assert.equal(two.windK, 0.65);
  assert.equal(two.wells, wells);
});

test('survey solves land on their sites through the real simulator', () => {
  const t = field();
  const me = tankOn(t, -150, -60);
  const wind = [1.1, -0.7];
  const cond = surveyConditions(2, { wind });
  let solved = 0;
  for (const s of labelledSites(surveySites({ cx: 120, cz: 40, seed: 2 }), 0.5, 80, 8)) {
    const target = [s.x, t.heightAt(s.x, s.z), s.z];
    const sol = solveSite({ shooter: me, elev: me.elev, target, cond, terrain: t });
    if (!sol.reach) continue;
    solved++;
    assert.ok(landingMiss(t, me, me.elev, sol, target, wind) <= SURVEY.reachMiss + 0.5);
  }
  assert.ok(solved >= 6, `solved ${solved}`);
});

test('a level 1 survey leaves the wind out, so in a gale it misses', () => {
  const t = field();
  const me = tankOn(t, -150, -60);
  const target = [150, t.heightAt(150, 30), 30];
  const gale = [2.5, 1.5];
  const dry = solveSite({ shooter: me, elev: 50, target, cond: surveyConditions(1, { wind: gale }), terrain: t });
  const live = solveSite({ shooter: me, elev: 50, target, cond: surveyConditions(2, { wind: gale }), terrain: t });
  assert.ok(dry.reach && live.reach);
  assert.ok(landingMiss(t, me, 50, dry, target, gale) > 15, 'the dry solution is blown off');
  assert.ok(landingMiss(t, me, 50, live, target, gale) <= SURVEY.reachMiss);
  // In calm air both agree.
  assert.ok(landingMiss(t, me, 50, dry, target, [0, 0]) <= SURVEY.reachMiss);
});

test('a site beyond reach at this elevation says so', () => {
  const t = field();
  const me = tankOn(t, -380, -380);
  const sol = solveSite({ shooter: me, elev: 6, target: [380, t.heightAt(380, 380), 380], cond: surveyConditions(1), terrain: t });
  assert.equal(sol.reach, false);
});

test('survey cache keeps stale answers until re-solved, and warm starts', () => {
  const c = new SurveyCache();
  const sites = [siteAt(0, 0, 1), siteAt(1, 0, 1)];
  const guesses = [];
  const solve = (s, guess) => { guesses.push(guess); return { yaw: 10 + s.i, power: 50, miss: 0, reach: true }; };
  c.setKey('a');
  assert.equal(c.step(sites, 1, solve), 1);
  assert.equal(c.get(sites[1]), null);
  c.step(sites, 5, solve);
  assert.equal(c.get(sites[1]).yaw, 11);
  assert.equal(c.setKey('a'), false);
  assert.equal(c.setKey('b'), true);
  assert.equal(c.get(sites[0]).stale, true);
  c.step(sites, 1, solve);
  assert.equal(c.get(sites[0]).stale, false);
  assert.deepEqual(guesses.at(-1), { yaw: 10, power: 50 });
});

test('the satellite looks at the enemy nearest the turret line, else down it', () => {
  const me = { x: 0, z: 0, yaw: 90, elev: 45, power: 60 };
  const foes = [{ x: 300, z: 0 }, { x: 20, z: 250 }];
  const f = surveyFocus(me, foes);
  assert.equal(f.x, 20);
  assert.equal(f.foe, true);
  const g = surveyFocus(me, []);
  assert.equal(g.foe, false);
  assert.ok(Math.abs(g.x) < 1e-6 && g.z > 300, `${g.x}, ${g.z}`);
  // The patch drifts round the focus, never far.
  for (let t = 0; t < 20; t += 0.7) {
    const c = patchCentre(f, t);
    assert.ok(Math.hypot(c.x - f.x, c.z - f.z) <= SURVEY.sweep * 1.2);
  }
});

test('the lab decides who has a satellite; the armory sells it a level at a time', () => {
  assert.deepEqual(normalizeLab(null), { satellite: 'shop', level: 1, labels: 'some' });
  assert.deepEqual(normalizeLab({ satellite: 'all', level: 9, labels: 'odd' }), { satellite: 'all', level: 3, labels: 'some' });
  assert.equal(satelliteLevel({ satellite: 'all', level: 2 }, { satellite: 0 }), 2);
  assert.equal(satelliteLevel({ satellite: 'off' }, { satellite: 3 }), 0);
  assert.equal(satellitePrice({ satellite: 'all' }, {}), Infinity);

  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 4, resolution: 64, twists: false });
  g.start();
  const p = g.players[0];
  assert.equal(g.satelliteLevel(p), 0);
  p.money = 5000;
  for (let lv = 1; lv <= SURVEY.maxLevel; lv++) {
    assert.equal(g.priceOf(p, 'satellite'), SURVEY.prices[lv - 1]);
    assert.ok(g.buy(0, 'satellite'));
    assert.equal(g.satelliteLevel(p), lv);
  }
  assert.equal(g.priceOf(p, 'satellite'), Infinity);
  assert.equal(g.buy(0, 'satellite'), false);
  // It travels in the snapshot, so online screens agree.
  const h = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 4, resolution: 64, twists: false });
  h.start();
  h.restore(g.snapshot());
  assert.equal(h.satelliteLevel(h.players[0]), SURVEY.maxLevel);

  const all = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], seed: 4, resolution: 64, lab: { satellite: 'all', level: 2, labels: 'few' } });
  assert.equal(all.cfg.lab.labels, 'few');
  assert.equal(all.satelliteLevel(all.players[1]), 2);
  assert.equal(all.priceOf(all.players[0], 'satellite'), Infinity);
});

test('survey solving honours low gravity', () => {
  const t = field();
  const me = tankOn(t, -100, 0);
  const target = [100, t.heightAt(100, 0), 0];
  const cond = { ...surveyConditions(1), gravity: GRAVITY * 0.7 };
  const sol = solveSite({ shooter: me, elev: 45, target, cond, terrain: t });
  const shot = simulateShot({ pos: muzzleOrigin(me, sol.yaw, 45), vel: launchVelocity(sol.yaw, 45, sol.power), terrain: t, gravity: GRAVITY * 0.7 });
  assert.ok(Math.hypot(shot.point[0] - target[0], shot.point[2] - target[2]) <= SURVEY.reachMiss);
});
