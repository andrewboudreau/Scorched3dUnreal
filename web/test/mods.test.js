import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, DEPLOY_STYLES } from '../src/core/game.js';
import { simulateShot, launchVelocity } from '../src/core/ballistics.js';
import { muzzleOrigin } from '../src/core/tank.js';
import { solveShot, planShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import {
  MODS, MOD_BY_ID, ORBIT, SKY, MOD_PAY, modLab, normalizeModLab, modLevel, modPrice, fitMods,
  deployMod, tickMods, hurtMod, orbitPoints, modWells, modTargets, readyMods,
} from '../src/core/mods.js';
import { PERK_BY_ID, MOD_DRAFT, isModPerk, perkCount } from '../src/core/perks.js';

// Mods: equipment a tank deploys (core/mods.js). The Gravity Orbiter and the
// Survey Satellite.

const mk = (opts = {}) => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: [], maxTurnsPerRound: 30, ...opts });
  g.start();
  return g;
};

// Step the world until every shell is down (or `max` seconds pass).
const settle = (g, max = 12) => {
  g.phase = 'flight';
  for (let i = 0; i < 120 * max && g.projectiles.some((p) => !p.dead); i++) g.stepWorld(1 / 120);
};

const drain = (g) => g.drainEvents();

test('mods: data, Lab options, prices and perks', () => {
  assert.deepEqual(MODS.map((m) => m.id), ['orbiter', 'satellite']);
  for (const m of MODS) {
    assert.equal(m.prices.length, m.maxLevel);
    assert.equal(m.hp.length, m.maxLevel);
    assert.equal(m.turns.length, m.maxLevel);
    assert.ok(['recon', 'defense', 'jamming'].includes(m.family));
  }
  // By default mods come from the perk draft; an unknown mode is the default,
  // and the old value 'shop' still means the armory.
  assert.deepEqual(normalizeModLab(null), { orbiter: 'perk', orbiterLevel: 1 });
  assert.deepEqual(modLab({ orbiter: 'bogus' }, 'orbiter'), { mode: 'perk', level: 1 });
  assert.deepEqual(modLab({ orbiter: 'shop' }, 'orbiter'), { mode: 'shop', level: 1 });
  assert.deepEqual(modLab({ orbiter: 'all', orbiterLevel: 9 }, 'orbiter'), { mode: 'all', level: 3 });
  assert.deepEqual(modLab({ satellite: 'all', level: 2 }, 'satellite'), { mode: 'all', level: 2 });

  const p = { id: 0, perks: [], mods: {} };
  const shop = { orbiter: 'shop', satellite: 'shop' };
  assert.equal(modLevel({}, p, 'orbiter'), 0);
  assert.equal(modPrice({}, p, 'orbiter'), Infinity, 'not for sale by default');
  assert.equal(modPrice(shop, p, 'orbiter'), MOD_BY_ID.orbiter.prices[0]);
  assert.equal(modLevel({ orbiter: 'all', orbiterLevel: 2 }, p, 'orbiter'), 2);
  assert.equal(modPrice({ orbiter: 'all' }, p, 'orbiter'), Infinity, 'not in the armory when the Lab hands it out');
  assert.equal(modLevel({ orbiter: 'off' }, { ...p, perks: ['orbital'] }, 'orbiter'), 0);
  // Perks unlock one, then level it up.
  assert.deepEqual(PERK_BY_ID.orbital.mods, { orbiter: 1 });
  assert.equal(modLevel({}, { ...p, perks: ['orbital'] }, 'orbiter'), 1);
  assert.equal(modLevel({}, { ...p, perks: ['orbital', 'orbitalup', 'orbitalup'] }, 'orbiter'), 3);
  assert.equal(modLevel({}, { ...p, perks: ['orbital'], mods: { orbiter: { bought: 1 } } }, 'orbiter'), 2, 'armory upgrades count once the draft gave it');
  assert.equal(modLevel({}, { ...p, mods: { orbiter: { bought: 2 } } }, 'orbiter'), 0, 'but the armory never sells the first level by default');
  assert.equal(modPrice({}, { ...p, perks: ['orbital'] }, 'orbiter'), MOD_BY_ID.orbiter.prices[1], 'the armory sells the next level of one you own');
  assert.equal(modPrice({}, { ...p, perks: ['orbital', 'orbitalup', 'orbitalup'] }, 'orbiter'), Infinity, 'at the top level');
  assert.equal(modLevel(shop, { ...p, perks: ['orbital'], mods: { orbiter: { bought: 2 } } }, 'orbiter'), 3);
  assert.equal(modPrice(shop, { ...p, perks: ['orbital'], mods: { orbiter: { bought: 2 } } }, 'orbiter'), Infinity, 'at the top level');

  // Bought in the game's armory (when the Lab puts mods there), fitted at the next round's start.
  const g = mk({ lab: shop });
  const a = g.players[0];
  a.money = 1000;
  assert.ok(g.buy(0, 'orbiter'));
  assert.ok(g.buy(0, 'satellite'));
  assert.equal(a.money, 1000 - MOD_BY_ID.orbiter.prices[0] - MOD_BY_ID.satellite.prices[0]);
  assert.equal(g.modLevel(a, 'orbiter'), 1);
  assert.equal(g.satelliteLevel(a), 1);
  assert.equal(g.surveyLevel(a), 0, 'the satellite works only once it is up');
  fitMods(g.cfg.lab, a);
  assert.deepEqual(readyMods(a), ['orbiter', 'satellite']);
  // Long-Life Cells: more health, more turns.
  a.perks.push('cells');
  fitMods(g.cfg.lab, a);
  assert.equal(a.mods.orbiter.turns, MOD_BY_ID.orbiter.turns[0] + 2);
  assert.equal(a.mods.orbiter.maxHp, Math.round(MOD_BY_ID.orbiter.hp[0] * 1.25));
});

test('mods: the Lab gives everyone one, and mod perks that could do nothing stay out of the draft', () => {
  const g = mk({ lab: { orbiter: 'all', orbiterLevel: 2 } });
  for (const p of g.players) {
    assert.equal(p.mods.orbiter.level, 2);
    assert.equal(p.mods.orbiter.state, 'ready');
  }
  const p = g.players[0];
  assert.equal(g.perkFits(p, PERK_BY_ID.orbital), false, 'it has one: no unlock');
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), true);
  assert.equal(g.perkFits(p, PERK_BY_ID.cells), true);
  p.perks.push('orbitalup');
  assert.equal(g.modLevel(p, 'orbiter'), 3);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), false, 'already at the top level');
  const off = mk({ lab: { orbiter: 'off', satellite: 'off' } });
  assert.equal(off.perkFits(off.players[0], PERK_BY_ID.orbital), false);
  assert.equal(off.perkFits(off.players[0], PERK_BY_ID.cells), false, 'no mod to make last longer');
});

test('mods: by default they come from the draft, an unlock card first, then level-ups', () => {
  const g = mk();
  const p = g.players[0];
  p.money = 5000;
  assert.equal(g.priceOf(p, 'orbiter'), Infinity, 'the armory does not sell them');
  assert.equal(g.buy(0, 'orbiter'), false);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbital), true);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), false, 'nothing to level up yet');
  assert.equal(g.perkFits(p, PERK_BY_ID.cells), false);
  p.perks.push('orbital');
  assert.equal(g.modLevel(p, 'orbiter'), 1);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbital), false);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), true);
  p.perks.push('orbitalup');
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), true, 'it stacks');
  p.perks.push('orbitalup');
  assert.equal(g.modLevel(p, 'orbiter'), 3);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), false, 'top level: no more offers');
  // A cap per match on mod levels from perks.
  const q = g.players[1];
  q.perks.push('orbital', 'satrecon', 'satrecon2', 'satrecon2');
  assert.equal(g.modLevel(q, 'satellite'), 3);
  assert.equal(g.perkFits(q, PERK_BY_ID.orbitalup), false, `capped at ${MOD_DRAFT.cap}`);

  // The drafts: at most one mod card, only cards that fit, and the
  // unlock shows up for most tanks over a three-round match.
  let seen = 0, offers = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const h = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], rounds: 3, seed, resolution: 64, maxTurnsPerRound: 1 });
    h.start();
    for (let r = 1; r < 3; r++) {
      h.endRound();
      h.openShop();
      for (const [pid, offer] of Object.entries(h.draft)) {
        offers++;
        const mods = offer.filter((id) => isModPerk(PERK_BY_ID[id]));
        assert.ok(mods.length <= 1, `one mod card at most: ${offer}`);
        assert.ok(offer.every((id) => h.perkFits(h.players[pid], PERK_BY_ID[id])));
        if (mods.length) seen++;
        h.pickPerk(Number(pid), mods[0] || offer[0]);
      }
      h.closeShop();
    }
    for (const p of h.players) assert.ok(perkCount(p, 'orbital') <= 1 && perkCount(p, 'orbitalup') <= 2);
  }
  assert.ok(seen / offers > 0.4 && seen / offers < 0.8, `mod cards in ${seen} of ${offers} offers`);
});

test('orbiter: its wells are a pure function of the game clock', () => {
  const p = { id: 1, x: 40, y: 10, z: -30 };
  for (const lv of [1, 2, 3]) {
    const a = orbitPoints(p, lv, 7.25);
    const b = orbitPoints({ ...p }, lv, 7.25);
    assert.deepEqual(a, b);
    assert.equal(a.length, lv === 3 ? 2 : 1);
    assert.notDeepEqual(orbitPoints(p, lv, 7.5), a, 'it moves with time');
    // It circles the tank about `radius` out.
    const cx = a.reduce((s, q) => s + q.x, 0) / a.length, cz = a.reduce((s, q) => s + q.z, 0) / a.length;
    assert.ok(Math.abs(Math.hypot(cx - p.x, cz - p.z) - ORBIT[lv].radius) < 0.01);
  }
  // Level 3: two wells `sep` apart, spinning round each other.
  const [u, v] = orbitPoints(p, 3, 2);
  assert.ok(Math.abs(Math.hypot(u.x - v.x, u.y - v.y, u.z - v.z) - ORBIT[3].pair.sep) < 1e-9);
  // Level 2 turns faster than level 1.
  assert.ok(ORBIT[2].speed > ORBIT[1].speed && ORBIT[2].mu > ORBIT[1].mu);

  // In the game: the clock stands still while tanks plan and runs only while shells fly.
  const g = mk({ lab: { orbiter: 'all', orbiterLevel: 1 } });
  const [, b] = g.players;
  g.deployFor(b, 'orbiter');
  const before = g.clock;
  for (let i = 0; i < 60; i++) g.update(1 / 30);
  assert.equal(g.clock, before, 'frozen while planning');
  const w0 = g.orbiterWells();
  assert.equal(w0.length, 1);
  assert.ok(w0[0].mu > 0 && w0[0].r > 0, 'moon-shaped wells for the renderer');
  g.spawnProjectile([0, 200, 0], [0, 0, 0], 'shell', 0, 1);
  settle(g, 1);
  assert.ok(g.clock > before);
  // The snapshot carries the clock and the mods.
  const s = g.snapshot();
  const h = mk({ lab: { orbiter: 'all', orbiterLevel: 1 } });
  h.restore(s);
  assert.equal(h.clock, g.clock);
  assert.deepEqual(h.orbiterWells(), g.orbiterWells());
});

test('orbiter: bends an enemy shell that passes it; its owner\'s shells fly straight through', () => {
  const g = mk({ lab: { orbiter: 'all', orbiterLevel: 2 } });
  const [a, b] = g.players;
  g.deployFor(b, 'orbiter');
  const [well] = g.orbiterWells();
  g.wind = [0, 0];
  // A shell dropped to pass 6 m beside the well.
  const run = (owner) => {
    g.projectiles = [];
    const pr = g.spawnProjectile([well.x - 30, well.y + 4, well.z + 6], [60, 0, 0], 'ranger', owner, 1);
    g.phase = 'flight';
    const clock = g.clock;
    for (let i = 0; i < 110; i++) g.stepWorld(1 / 120);
    g.clock = clock;   // the same moment for both runs
    return pr.pos;
  };
  const straight = run(b.id);
  const bent = run(a.id);
  // The owner's shell flew as if nothing were there: straight along x, no sideways drift beyond the wind's.
  assert.ok(Math.abs(straight[2] - (well.z + 6)) < 0.3, `owner's shell drifted ${straight[2] - well.z - 6}`);
  assert.ok(Math.hypot(bent[0] - straight[0], bent[1] - straight[1], bent[2] - straight[2]) > 1, `bent by ${Math.hypot(bent[0] - straight[0], bent[2] - straight[2])}`);
  // The simulator agrees: a shot through the field lands elsewhere than one without.
  const field = (t) => modWells(g.players, t, a.id);
  const shot = { pos: [well.x - 30, well.y + 4, well.z + 6], vel: [40, 5, 0], wind: [0, 0], terrain: g.terrain, gravity: g.gravity };
  const p0 = simulateShot(shot).point;
  const p1 = simulateShot({ ...shot, field, t0: g.clock }).point;
  assert.ok(Math.hypot(p0[0] - p1[0], p0[2] - p1[2]) > 2);
  // And the same twice.
  assert.deepEqual(simulateShot({ ...shot, field, t0: g.clock }).point, p1);
});

test('mods: a direct hit brings the orbiter down and pays the shooter', () => {
  const g = mk({ lab: { orbiter: 'all', orbiterLevel: 1 } });
  const [a, b] = g.players;
  g.deployFor(b, 'orbiter');
  drain(g);
  const core = modTargets(g.players, g.clock).find((m) => m.owner === b.id);
  const money = a.money;
  const ground = g.terrain.heights.slice();
  g.spawnProjectile([core.x, core.y, core.z], [0, 0, 0], 'shell', a.id, 1);
  settle(g);
  assert.equal(b.mods.orbiter.state, 'down');
  assert.equal(b.mods.orbiter.hp, 0);
  const ev = drain(g).filter((e) => e.type === 'mod');
  assert.ok(ev.some((e) => e.what === 'down' && e.player === b.id && e.mod === 'orbiter' && e.by === a.id));
  assert.ok(a.money >= money + MOD_PAY, 'paid for the kill (and any splash on the tank under it)');
  assert.deepEqual(g.orbiterWells(), []);
  // A blast high in the air leaves the ground alone.
  assert.deepEqual(g.terrain.heights, ground);
  // A new one is ready on its owner's next turn; putting it up costs that turn.
  assert.equal(g.current, a);
  g.nextTurn();
  assert.equal(g.current, b);
  assert.equal(b.mods.orbiter.state, 'ready');
  assert.equal(b.mods.orbiter.hp, b.mods.orbiter.maxHp);
  // Likewise in a volley: ready for the next one.
  const v = mk({ firing: 'volley', lab: { orbiter: 'all', orbiterLevel: 1 } });
  v.deployFor(v.players[1], 'orbiter');
  v.hurtModOf(1, 'orbiter', 999, 0);
  assert.equal(v.players[1].mods.orbiter.state, 'down');
  v.nextTurn();
  assert.equal(v.players[1].mods.orbiter.state, 'ready');
  // Its owner's fire never touches it.
  const h = mk({ lab: { orbiter: 'all', orbiterLevel: 1 } });
  h.deployFor(h.players[1], 'orbiter');
  const c2 = modTargets(h.players, h.clock)[0];
  h.spawnProjectile([c2.x, c2.y, c2.z], [0, 0, 0], 'breacher', 1, 1);
  settle(h);
  assert.equal(h.players[1].mods.orbiter.state, 'up');
  // hurtMod on its own.
  const p = { mods: { orbiter: { state: 'up', hp: 10 } } };
  assert.equal(hurtMod(p, 'orbiter', 4), 'hit');
  assert.equal(hurtMod(p, 'orbiter', 7), 'down');
  assert.equal(hurtMod(p, 'orbiter', 7), null);
});

test('mods: deploying takes the turn, and a mod wears out after its turns', () => {
  const g = mk({ lab: { orbiter: 'all', orbiterLevel: 1 } });
  const p = g.current;
  assert.ok(g.canDeploy(p));
  assert.equal(g.deploy(), 'orbiter');
  assert.equal(p.mods.orbiter.state, 'up');
  assert.equal(g.phase, 'settle', 'no shot this turn');
  assert.equal(g.projectiles.length, 0);
  assert.equal(g.deploy(), null);
  const life = p.mods.orbiter.turns;
  g.nextTurn();   // the turn it went up on does not count
  assert.equal(p.mods.orbiter.turns, life);
  drain(g);
  let mine = 0;
  while (p.mods.orbiter.state === 'up' && mine < 20) {
    if (g.current === p) mine++;
    g.nextTurn();
  }
  assert.equal(p.mods.orbiter.state, 'spent');
  assert.equal(mine, life, `lasted ${mine} of its own turns`);
  assert.ok(drain(g).some((e) => e.type === 'mod' && e.what === 'expire' && e.player === p.id));
  assert.equal(g.canDeploy(p), false, 'nothing to deploy on the other tank\'s turn');
  // On its owner's next turn a fresh one is ready: the cost of losing it is the turn spent putting it back.
  drain(g);
  while (g.current !== p) g.nextTurn();
  assert.equal(p.mods.orbiter.state, 'ready');
  assert.equal(p.mods.orbiter.turns, life);
  assert.equal(p.mods.orbiter.hp, p.mods.orbiter.maxHp);
  assert.ok(g.canDeploy(p));
  assert.ok(drain(g).some((e) => e.type === 'mod' && e.what === 'refit' && e.player === p.id));
  // tickMods on its own.
  const q = { mods: { satellite: { state: 'up', turns: 1 } } };
  assert.deepEqual(tickMods(q), ['satellite']);
});

test('mods: a deployed mod survives into the next round, over its owner\'s new spot', () => {
  const g = mk({ twists: false, lab: { orbiter: 'all', orbiterLevel: 2, satellite: 'all', level: 2 } });
  const [a, b] = g.players;
  g.deployFor(a, 'orbiter');
  g.deployFor(a, 'satellite');
  hurtMod(a, 'orbiter', 5);
  tickMods(a); tickMods(a);   // the deploy turn, then one more
  const turns = a.mods.orbiter.turns;
  const hp = a.mods.orbiter.hp;
  g.endRound();
  g.openShop();
  g.closeShop();
  assert.equal(g.round, 2);
  assert.equal(a.mods.orbiter.state, 'up');
  assert.equal(a.mods.orbiter.turns, turns, 'its lifetime counts on across rounds');
  assert.equal(a.mods.orbiter.hp, hp, 'its damage too');
  assert.equal(a.mods.satellite.state, 'up');
  const s = a.mods.satellite;
  assert.ok(Math.abs(Math.hypot(s.x - a.x, s.z - a.z) - SKY.lean) < 0.01, 'over the new spot');
  assert.ok(s.y > a.y + SKY.altitude - 0.01);
  assert.equal(g.surveyLevel(a), 2);
  // The one that was never deployed is fitted fresh, ready.
  assert.equal(b.mods.orbiter.state, 'ready');
  // A mod lost with its tank comes back fresh next round (a wreck has no turns).
  g.deployFor(b, 'orbiter');
  g.damage(b, 999, a.id);
  assert.equal(b.mods.orbiter.state, 'down');
  g.endRound(); g.openShop(); g.closeShop();
  assert.equal(b.mods.orbiter.state, 'ready');
});

test('satellite: Flak shoots it down, with the break-up where it hung', () => {
  const g = mk({ lab: { satellite: 'all', level: 1 } });
  const [a, b] = g.players;
  g.deployFor(b, 'satellite');
  drain(g);
  const s = b.mods.satellite;
  assert.equal(g.surveyLevel(b), 1);
  // A Flak shell passing 6 m over it.
  g.spawnProjectile([s.x - 45, s.y + 12, s.z], [45, 0, 0], 'flak', a.id, 1);
  settle(g);
  assert.equal(s.state, 'down');
  assert.equal(g.surveyLevel(b), 0);
  const down = drain(g).find((e) => e.type === 'mod' && e.what === 'down');
  assert.ok(down && down.mod === 'satellite' && down.by === a.id);
  assert.deepEqual(down.pos, [s.x, s.y, s.z]);
  // A plain Shell passing just as close does nothing to it.
  const h = mk({ lab: { satellite: 'all', level: 1 } });
  h.deployFor(h.players[1], 'satellite');
  const s2 = h.players[1].mods.satellite;
  h.spawnProjectile([s2.x - 45, s2.y + 12, s2.z], [45, 0, 0], 'shell', 0, 1);
  settle(h);
  assert.equal(s2.state, 'up');
});

// The CPU's view: solve a shot at B, then fly it through B's orbiter.
function trial(g, from, to, clock, useField) {
  const field = (t) => modWells(g.players, t, from.id);
  const rng = makeRng(Math.round(clock * 1000) + 7);
  const sol = solveShot({ shooter: from, target: [to.x, to.y + 1, to.z], wind: g.wind, terrain: g.terrain, rng, gravity: g.gravity,
    ...(useField ? { field, t0: clock } : {}) });
  const shot = simulateShot({ pos: muzzleOrigin(from, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power),
    wind: g.wind, terrain: g.terrain, gravity: g.gravity, level: to.y, field, t0: clock });
  if (shot.kind === 'orbiter') return Infinity;
  const [x, , z] = shot.kind === 'lost' && shot.cross ? shot.cross : shot.point;
  return Math.hypot(x - to.x, z - to.z);
}

test('orbiter balance: level 3 scrambles shots without blocking them all; a solver that knows it does better', () => {
  let N = 0, blind = 0, aware = 0, near = 0, missBlind = 0, missAware = 0;
  for (const seed of [5, 8, 13, 21]) {
    const g = mk({ seed, lab: { orbiter: 'all', orbiterLevel: 3 } });
    const [a, b] = g.players;
    g.deployFor(b, 'orbiter');
    for (let k = 0; k < 10; k++) {
      const clock = k * 0.83;
      const m0 = trial(g, a, b, clock, false);
      const m1 = trial(g, a, b, clock, true);
      N++;
      if (m0 <= 6) blind++;
      if (m0 <= 14) near++;   // inside a Shell's blast reach
      if (m1 <= 6) aware++;
      missBlind += Math.min(m0, 200);
      missAware += Math.min(m1, 200);
    }
  }
  // Fired blind (the solution without the orbiter), some still land, not all.
  assert.ok(blind / N >= 0.15 && blind / N <= 0.85, `blind hits ${blind}/${N}`);
  assert.ok(near / N >= 0.3, `near ${near}/${N}`);
  assert.ok(missAware < missBlind, `aware ${missAware.toFixed(0)} vs blind ${missBlind.toFixed(0)}`);
  assert.ok(aware >= blind, `aware ${aware} vs blind ${blind}`);
});

test('mods: CPUs deploy their orbiter and an all-CPU match plays through', () => {
  for (const firing of ['turns', 'volley']) {
    const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'hard' }, { name: 'C', ai: 'easy' }],
      rounds: 2, seed: 11, resolution: 64, twists: true, firing, maxTurnsPerRound: 6, lab: { orbiter: 'all', orbiterLevel: 3, satellite: 'all', level: 2 } });
    g.start();
    let deploys = 0, frames = 0;
    while (g.phase !== 'matchOver' && frames++ < 60000) {
      g.update(1 / 30);
      for (const e of g.drainEvents()) if (e.type === 'mod' && e.what === 'deploy') deploys++;
      if (g.phase === 'roundOver' && g.phaseTime > 0.3) g.openShop();
    }
    assert.equal(g.phase, 'matchOver', `${firing}: match over`);
    assert.ok(deploys >= 2, `${firing}: CPUs deployed ${deploys}`);
    assert.ok(g.players.some((p) => p.stats.shots > 0));
  }
});

test('mods: each CPU times its deploy its own way', () => {
  const g = mk({ players: [{ name: 'A', ai: 'normal' }, { name: 'B' }], lab: { orbiter: 'all', orbiterLevel: 1 } });
  const [a, b] = g.players;
  const as = (style) => { g.aiDeployStyle = () => style; };
  assert.equal(g.aiWantsDeploy(a, null), 'orbiter', 'nothing to shoot at: put it up');
  as('early');
  assert.equal(g.aiWantsDeploy(a, b), 'orbiter');
  as('ranging');
  assert.equal(g.aiWantsDeploy(a, b), null, 'a ranging shot first');
  a.aim[b.id] = { yaw: 2.5, power: 0, shots: 1 };
  assert.equal(g.aiWantsDeploy(a, b), 'orbiter', 'still well off after ranging: no good shot');
  a.aim[b.id] = { yaw: 0.2, power: 0.004, shots: 2 };
  assert.equal(g.aiWantsDeploy(a, b), null, 'dialled in: shoot');
  as('reactive');
  assert.equal(g.aiWantsDeploy(a, b), null);
  a.hp -= 10;
  assert.equal(g.aiWantsDeploy(a, b), 'orbiter', 'hurt: now it does');
  deployMod(a, 'orbiter');
  assert.equal(g.aiWantsDeploy(a, null), null, 'nothing left to deploy');
  // The style is fixed for a CPU and a match, and differs between them.
  delete g.aiDeployStyle;
  assert.equal(g.aiDeployStyle(a), g.aiDeployStyle(a));
  const styles = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6]) for (const id of [0, 1, 2]) styles.add(new Game({ players: [{}, {}, {}], seed }).aiDeployStyle({ id }));
  assert.deepEqual([...styles].sort(), [...DEPLOY_STYLES].sort());
});

test('mods: not every CPU deploys on its first turn', () => {
  const first = { early: 0, later: 0, never: 0 };
  for (const seed of [3, 4, 5, 6, 7, 8]) {
    const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'hard' }, { name: 'C', ai: 'normal' }],
      rounds: 1, seed, resolution: 64, twists: false, maxTurnsPerRound: 8, lab: { orbiter: 'all', orbiterLevel: 1 } });
    g.start();
    const turnsOf = [0, 0, 0];
    const when = [null, null, null];
    let frames = 0;
    while (g.phase !== 'matchOver' && frames++ < 60000) {
      g.update(1 / 30);
      for (const e of g.drainEvents()) {
        if (e.type === 'turn') turnsOf[e.player]++;
        if (e.type === 'mod' && e.what === 'deploy' && when[e.player] == null) when[e.player] = turnsOf[e.player];
      }
    }
    for (const w of when) first[w == null ? 'never' : w === 1 ? 'early' : 'later']++;
  }
  assert.ok(first.early > 0, `some deploy at once ${JSON.stringify(first)}`);
  assert.ok(first.later + first.never > 0, `some wait ${JSON.stringify(first)}`);
  assert.ok(first.later > 0, `some deploy later ${JSON.stringify(first)}`);
});

// A CPU's shots at B from A: `level` 0 for no orbiter. Hits land within 6 m of the tank.
function cpuHits(ai, level, seeds = [5, 8, 13, 21], shots = 12) {
  let hits = 0;
  for (const seed of seeds) {
    const g = mk({ seed, players: [{ name: 'A', ai }, { name: 'B' }], lab: level ? { orbiter: 'all', orbiterLevel: level } : { orbiter: 'off' } });
    const [a, b] = g.players;
    if (level) g.deployFor(b, 'orbiter');
    a.aim = {};
    for (let k = 0; k < shots; k++) {
      g.clock = k * 0.83 + seed * 0.37;   // the wells sit somewhere else every shot
      const sol = planShot({ shooter: a, target: b, wind: g.wind, terrain: g.terrain, rng: g.rng, difficulty: ai, memory: a.aim,
        gravity: g.gravity, windK: g.windShare(a), ...g.orbitField(a) });
      const shot = simulateShot({ pos: muzzleOrigin(a, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power),
        wind: g.wind, terrain: g.terrain, gravity: g.gravity, windK: g.windShare(a), level: b.y, field: (t) => modWells(g.players, t, a.id), t0: g.clock });
      if (shot.kind === 'orbiter') continue;
      const [x, , z] = shot.kind === 'lost' && shot.cross ? shot.cross : shot.point;
      if (Math.hypot(x - b.x, z - b.z) <= 6) hits++;
    }
  }
  return hits;
}

// Against a level 3 orbiter a Normal CPU lands about half as many hits as
// against a bare tank, a Hard one somewhat more. One set of 48 shots (4 seeds
// x 12) swings a lot either way, so the bands are checked on six sets pooled.
test('orbiter: CPUs misread it, more the higher its level; Hard less than Normal', () => {
  const sets = [0, 1, 2, 3, 4].map((k) => [1, 2, 3, 4].map((s) => s + k * 4)).concat([[5, 8, 13, 21]]);
  const rate = {};
  for (const ai of ['normal', 'hard']) {
    const tally = { 0: 0, 1: 0, 3: 0 };
    for (const seeds of sets) for (const lv of [0, 1, 3]) tally[lv] += cpuHits(ai, lv, seeds);
    rate[ai] = { none: tally[0], l1: tally[1] / tally[0], l3: tally[3] / tally[0] };
    assert.ok(tally[0] >= sets.length * 20, `${ai} hits ${tally[0]}/${sets.length * 48} with no orbiter`);
  }
  const show = JSON.stringify(rate);
  assert.ok(rate.normal.l3 >= 0.4 && rate.normal.l3 <= 0.6, `normal vs level 3: ${show}`);
  assert.ok(rate.hard.l3 > rate.normal.l3 + 0.05 && rate.hard.l3 <= 0.85, `hard vs level 3: ${show}`);
  for (const ai of ['normal', 'hard']) assert.ok(rate[ai].l1 > rate[ai].l3 && rate[ai].l1 >= 0.7, `${ai} grows with level: ${show}`);
});
