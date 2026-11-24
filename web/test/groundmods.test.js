import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { solveShot, weaponWeights } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { TANK } from '../src/core/tank.js';
import { MODS, MOD_BY_ID, MOD_BAYS, DECOY, POINTDEF, modTargets, fitMods, turretAt } from '../src/core/mods.js';
import { PERKS, PERK_BY_ID, isModPerk } from '../src/core/perks.js';
import { WEAPON_BY_ID } from '../src/core/weapons.js';
import { parseTestParams } from '../src/builder.js';

// The two mods that stand on the ground (core/mods.js): the Decoy Beacon and
// Point Defense.

const mk = (opts = {}) => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: [], maxTurnsPerRound: 30, ...opts });
  g.start();
  g.wind = [0, 0];
  return g;
};

const settle = (g, max = 14) => {
  g.phase = 'flight';
  for (let i = 0; i < 120 * max && g.projectiles.some((p) => !p.dead); i++) g.stepWorld(1 / 120);
};

const drain = (g) => g.drainEvents();

// Aim `p` to land at x/z (no wind).
const aimAt = (g, p, x, z) => {
  const sol = solveShot({ shooter: p, target: [x, g.terrain.heightAt(x, z), z], wind: [0, 0], terrain: g.terrain, rng: makeRng(1), gravity: g.gravity });
  p.yaw = sol.yaw; p.elev = sol.elev; p.power = sol.power;
};

// A spot about `d` m from `p`, away from the other tank and on the ground.
const spotNear = (g, p, d = 60) => {
  const o = g.players.find((q) => q !== p);
  for (let k = 0; k < 24; k++) {
    const a = Math.atan2(p.z - o.z, p.x - o.x) + (k % 2 ? 1 : -1) * Math.floor(k / 2) * 0.3;
    const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
    if (g.terrain.inBounds(x, z) && g.groundAt(x, z) != null && g.terrain.heightAt(x, z) > g.terrain.waterLevel + 1) return [x, z];
  }
  return [p.x * 0.8, p.z * 0.8];
};

test('ground mods: data, draft cards and test params', () => {
  for (const id of ['decoy', 'pointdef']) {
    const d = MOD_BY_ID[id];
    assert.equal(d.maxLevel, 3);
    for (const k of ['prices', 'hp', 'turns', 'levels']) assert.equal(d[k].length, 3, `${id} ${k}`);
    assert.ok(d.desc && d.tag);
  }
  assert.equal(MOD_BY_ID.decoy.family, 'deception');
  assert.equal(MOD_BY_ID.pointdef.family, 'defense');
  assert.deepEqual(MOD_BY_ID.decoy.hp.slice(0, 2), [20, 35]);
  assert.equal(MOD_BAYS, 2);
  // An unlock card and a level-up card that stacks twice, for each.
  for (const [unlock, up, id] of [['beacon', 'beaconup', 'decoy'], ['pdturret', 'pdup', 'pointdef']]) {
    assert.ok(PERK_BY_ID[unlock].unlock && PERK_BY_ID[unlock].mods[id] === 1 && isModPerk(PERK_BY_ID[unlock]));
    assert.ok(PERK_BY_ID[up].levelUp && PERK_BY_ID[up].stack === 2 && PERK_BY_ID[up].mods[id] === 1);
  }
  // The blink is hidden: never in the rack.
  assert.ok(WEAPON_BY_ID.blink.hidden);
  assert.deepEqual(parseTestParams('?decoy=3&pointdef=2').lab, { decoy: 'all', decoyLevel: 3, pointdef: 'all', pointdefLevel: 2 });
  assert.equal(parseTestParams('?decoy=7').lab, undefined);
});

test('decoy: deploying fires a blink with the aim; the tank warps and a decoy stays where it stood', () => {
  const g = mk({ lab: { decoy: 'all', decoyLevel: 1 } });
  const p = g.current;
  const was = { x: p.x, y: p.y, z: p.z };
  const [tx, tz] = spotNear(g, p);
  aimAt(g, p, tx, tz);
  const ammo = { ...p.inventory };
  // Arm it, then Fire sends the blink.
  assert.ok(g.toggleBlink());
  assert.ok(g.fire());
  assert.equal(g.phase, 'flight');
  assert.equal(g.projectiles.length, 1);
  assert.equal(g.projectiles[0].weapon, 'blink');
  assert.deepEqual(p.inventory, ammo, 'no ammo spent');
  assert.equal(p.mods.decoy.state, 'ready', 'up only once the blink lands');
  settle(g);
  assert.ok(Math.hypot(p.x - was.x, p.z - was.z) > 30, 'the tank moved');
  assert.ok(Math.hypot(p.x - tx, p.z - tz) < 12, 'to where the blink came down');
  const m = p.mods.decoy;
  assert.equal(m.state, 'up');
  assert.deepEqual([m.x, m.y, m.z], [was.x, was.y, was.z]);
  assert.equal(m.hp, 20);
  const ev = drain(g);
  assert.ok(ev.some((e) => e.type === 'warp' && e.player === p.id && e.blink));
  assert.ok(ev.some((e) => e.type === 'mod' && e.what === 'deploy' && e.mod === 'decoy'));
  // It is a target where it stands, tank-sized.
  const t = modTargets(g.players, g.clock).find((x) => x.mod === 'decoy');
  assert.equal(t.r, TANK.hitRadius);
  assert.ok(t.ground);
  // Disarming works, and an armed decoy is let go by arming a Double Strike.
  const h = mk({ lab: { decoy: 'all', decoyLevel: 1 } });
  assert.ok(h.toggleBlink());
  assert.equal(h.toggleBlink(), false);
  assert.equal(h.blink, null);
});

test('decoy: a volley plan carries the aim and replays the same on every copy', () => {
  const run = () => {
    const g = mk({ firing: 'volley', lab: { decoy: 'all', decoyLevel: 2 } });
    const p = g.players[0];
    const [tx, tz] = spotNear(g, p);
    aimAt(g, p, tx, tz);
    return { g, p, aim: { yaw: p.yaw, elev: p.elev, power: p.power } };
  };
  const a = run();
  assert.equal(a.g.current, a.p);
  assert.equal(a.g.deploy('decoy'), 'decoy');
  const plan = a.g.volley.plans[a.p.id];
  assert.equal(plan.deploy, 'decoy');
  assert.equal(plan.yaw, a.aim.yaw);
  assert.equal(plan.power, a.aim.power);
  // Another copy gets the plan as it was relayed (JSON) and plays it out.
  const b = run();
  const relayed = JSON.parse(JSON.stringify(plan));
  for (const g of [a.g, b.g]) {
    if (g === b.g) { g.volley.plans[0] = relayed; g.volley.done.push(0); }
    g.volley.plans[1] = { yaw: 0, elev: 45, power: 10, weapon: 'shell' };
    g.launchVolley();
    settle(g);
  }
  assert.equal(a.p.mods.decoy.state, 'up');
  assert.deepEqual([b.p.x, b.p.y, b.p.z], [a.p.x, a.p.y, a.p.z]);
  assert.deepEqual(b.p.mods.decoy, a.p.mods.decoy);
});

test('decoy: shells hit it, blasts hurt it, and it fizzles at its hit points for its level', () => {
  for (const [level, takes] of [[1, 20], [2, 35], [3, 35]]) {
    const g = mk({ lab: { decoy: 'all', decoyLevel: level } });
    const [a, b] = g.players;
    g.deployFor(b, 'decoy');
    settle(g);
    const m = b.mods.decoy;
    assert.equal(m.maxHp, takes);
    g.hurtModOf(b.id, 'decoy', takes - 1, a.id);
    assert.equal(m.state, 'up', `L${level} holds at ${takes - 1}`);
    g.hurtModOf(b.id, 'decoy', 1, a.id);
    assert.equal(m.state, 'down', `L${level} fizzles at ${takes}`);
  }
  // A shell squarely on it: it takes the hit, its owner (far off now) does not.
  const g = mk({ lab: { decoy: 'all', decoyLevel: 1 } });
  const [a, b] = g.players;
  const [tx, tz] = spotNear(g, b, 80);
  aimAt(g, b, tx, tz);
  g.deployFor(b, 'decoy');
  settle(g);
  drain(g);
  const hp = b.hp;
  const t = modTargets(g.players, g.clock).find((x) => x.mod === 'decoy');
  g.spawnProjectile([t.x, t.y + 1, t.z], [0, -5, 0], 'shell', a.id, 1);
  settle(g);
  assert.equal(b.mods.decoy.state, 'down');
  assert.equal(b.hp, hp, 'the real tank is untouched');
  assert.ok(drain(g).some((e) => e.type === 'mod' && e.what === 'down' && e.mod === 'decoy' && e.by === a.id));
  // Its owner's own fire passes it by.
  const h = mk({ lab: { decoy: 'all', decoyLevel: 1 } });
  h.deployFor(h.players[1], 'decoy');
  settle(h);
  const u = modTargets(h.players, h.clock).find((x) => x.mod === 'decoy');
  h.blastMods([u.x, u.y, u.z], 11, 38, 1);
  assert.equal(h.players[1].mods.decoy.hp, 20);
  // It ends with the round.
  h.players[1].mods.decoy.state = 'up';
  fitMods(h.cfg.lab, h.players[1]);
  assert.equal(h.players[1].mods.decoy.state, 'ready');
});

test('decoy: at level 3 it goes off when it fizzles, credited to its owner', () => {
  const g = mk({ lab: { decoy: 'all', decoyLevel: 3 } });
  const [a, b] = g.players;
  const [tx, tz] = spotNear(g, b, 90);
  aimAt(g, b, tx, tz);
  g.deployFor(b, 'decoy');
  settle(g);
  const m = b.mods.decoy;
  // The enemy comes to finish it off, right beside it.
  a.x = m.x + 4; a.z = m.z; a.y = g.terrain.heightAt(a.x, a.z);
  drain(g);
  const hpA = a.hp, hpB = b.hp;
  g.hurtModOf(b.id, 'decoy', 999, a.id);
  const ev = drain(g);
  const boom = ev.find((e) => e.type === 'explosion' && e.fizzle);
  assert.ok(boom, 'it went off');
  assert.equal(boom.radius, DECOY.fizzle.radius);
  assert.ok(a.hp < hpA, 'the enemy beside it took damage');
  assert.ok(hpA - a.hp <= DECOY.fizzle.damage + 1e-9);
  assert.equal(b.hp, hpB, 'its owner, far off, did not');
  assert.ok(ev.some((e) => e.type === 'damage' && e.player === a.id && e.by === b.id), 'credited to its owner');
  // Below level 3 it just fizzles.
  const h = mk({ lab: { decoy: 'all', decoyLevel: 2 } });
  h.deployFor(h.players[1], 'decoy');
  settle(h);
  drain(h);
  h.hurtModOf(1, 'decoy', 999, 0);
  assert.ok(!drain(h).some((e) => e.type === 'explosion'));
});

test('decoy: CPUs fall for it some of the time, easy often and hard rarely, the same every run', () => {
  const rate = (ai, level) => {
    const g = mk({ players: [{ name: 'A', ai }, { name: 'B' }], lab: { decoy: 'all', decoyLevel: level } });
    const [a, b] = g.players;
    const [tx, tz] = spotNear(g, b, 80);
    aimAt(g, b, tx, tz);
    g.deployFor(b, 'decoy');
    settle(g);
    let fooled = 0;
    for (let k = 0; k < 400; k++) if (g.aiDecoyed(a, b).decoy) fooled++;
    return fooled / 400;
  };
  const easy = rate('easy', 2), normal = rate('normal', 2), hard = rate('hard', 2);
  assert.ok(Math.abs(easy - DECOY.fool.easy) < 0.08, `easy ${easy}`);
  assert.ok(Math.abs(hard - DECOY.fool.hard) < 0.06, `hard ${hard}`);
  assert.ok(easy > normal && normal > hard);
  assert.ok(rate('normal', 1) < normal, 'a level 1 decoy fools less');
  assert.equal(rate('normal', 2), normal, 'seeded: the same every run');
  // A stand-in keeps the target's id (its ranging carries on) at the decoy's spot.
  const g = mk({ players: [{ name: 'A', ai: 'easy' }, { name: 'B' }], lab: { decoy: 'all', decoyLevel: 2 } });
  const [a, b] = g.players;
  const [tx, tz] = spotNear(g, b, 80);
  aimAt(g, b, tx, tz);
  g.deployFor(b, 'decoy');
  settle(g);
  let s = null;
  for (let k = 0; k < 20 && !s?.decoy; k++) s = g.aiDecoyed(a, b);
  assert.equal(s.id, b.id);
  assert.deepEqual([s.x, s.z], [b.mods.decoy.x, b.mods.decoy.z]);
});

test('decoy: a CPU hit from afar blinks away and leaves one', () => {
  const g = mk({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], lab: { decoy: 'all', decoyLevel: 1 } });
  const [a, b] = g.players;
  assert.equal(g.aiDecoyAim(b), null, 'not before it is hit');
  g.damage(b, 10, a.id, 1);
  const aim = g.aiDecoyAim(b);
  assert.ok(aim && Number.isFinite(aim.yaw) && Number.isFinite(aim.power));
  const plan = g.planAiShot(b);
  assert.equal(plan.deploy, 'decoy');
  const was = [b.x, b.z];
  g.deployTurn(b, 'decoy', plan);
  assert.equal(g.phase, 'flight');
  settle(g);
  if (b.mods.decoy.state === 'up') assert.deepEqual([b.mods.decoy.x, b.mods.decoy.z], was);
});

test('point defense: shoots down an enemy shell coming down near its owner, with charges that refill each round', () => {
  const g = mk({ lab: { pointdef: 'all', pointdefLevel: 1 } });
  const [a, b] = g.players;
  g.deployFor(b, 'pointdef');
  drain(g);
  assert.equal(b.mods.pointdef.charges, 1);
  const hp = b.hp;
  const ground = g.terrain.heights.slice();
  g.spawnProjectile([b.x + 3, b.y + 14, b.z], [0, -6, 0], 'breacher', a.id, 1);
  settle(g);
  assert.equal(b.hp, hp, 'no damage');
  assert.deepEqual(g.terrain.heights, ground, 'no crater');
  assert.equal(b.mods.pointdef.charges, 0);
  const ev = drain(g);
  const hit = ev.find((e) => e.type === 'intercept');
  assert.ok(hit && hit.player === b.id && hit.by === a.id);
  assert.ok(!ev.some((e) => e.type === 'impact' || e.type === 'explosion'));
  // Out of charges: the next one lands.
  g.spawnProjectile([b.x + 3, b.y + 14, b.z], [0, -6, 0], 'shell', a.id, 2);
  settle(g);
  assert.ok(b.hp < hp);
  // A shell coming down further off than its reach is left alone.
  const h = mk({ lab: { pointdef: 'all', pointdefLevel: 2 } });
  const [c, d] = h.players;
  h.deployFor(d, 'pointdef');
  const far = POINTDEF[2].radius + 4;
  h.spawnProjectile([d.x + far, d.y + 6, d.z], [0, -6, 0], 'shell', c.id, 1);
  settle(h);
  assert.equal(d.mods.pointdef.charges, 2);
  // Level 2: two a round. They refill with the round.
  h.spawnProjectile([d.x, d.y + 12, d.z + 2], [0, -6, 0], 'shell', c.id, 2);
  h.spawnProjectile([d.x + 2, d.y + 16, d.z], [0, -6, 0], 'shell', c.id, 3);
  settle(h);
  assert.equal(d.mods.pointdef.charges, 0);
  fitMods(h.cfg.lab, d);
  assert.equal(d.mods.pointdef.state, 'up', 'it stays up into the next round');
  assert.equal(d.mods.pointdef.charges, 2, 'refilled');
});

test('point defense: never its owner\'s shells, never one going up, never a roller; fragments only at level 3', () => {
  const g = mk({ lab: { pointdef: 'all', pointdefLevel: 2 } });
  const [a, b] = g.players;
  g.deployFor(b, 'pointdef');
  // Its owner's own shell.
  g.spawnProjectile([b.x + 3, b.y + 14, b.z], [0, -6, 0], 'shell', b.id, 1);
  settle(g);
  assert.equal(b.mods.pointdef.charges, 2);
  // An enemy shell on its way up.
  const up = g.spawnProjectile([b.x, b.y + 12, b.z], [0, 25, 0], 'shell', a.id, 1);
  g.stepWorld(1 / 120);
  assert.ok(!up.dead);
  g.projectiles = [];
  // A Roller (it gets past Point Defense) and a fragment below level 3.
  g.spawnProjectile([b.x + 3, b.y + 14, b.z], [0, -6, 0], 'roller', a.id, 2);
  const frag = g.spawnProjectile([b.x - 3, b.y + 14, b.z], [0, -6, 0], 'scatterlet', a.id, 3);
  frag.frag = true;
  settle(g);
  assert.equal(b.mods.pointdef.charges, 2);
  // Level 3 stops fragments too, and reaches further.
  const h = mk({ lab: { pointdef: 'all', pointdefLevel: 3 } });
  const [c, d] = h.players;
  h.deployFor(d, 'pointdef');
  const f = h.spawnProjectile([d.x + 22, d.y + 6, d.z], [0, -6, 0], 'scatterlet', c.id, 1);
  f.frag = true;
  settle(h);
  assert.equal(d.mods.pointdef.charges, 1);
  // Split children are marked as fragments by the game itself.
  const k = mk({ lab: { pointdef: 'all', pointdefLevel: 1 } });
  const s = k.spawnProjectile([0, 80, 0], [10, 2, 0], 'scatter', 0, 1);
  for (let i = 0; i < 120 && !s.dead; i++) k.stepWorld(1 / 120);
  assert.ok(s.dead);
  assert.ok(k.projectiles.length >= 5 && k.projectiles.every((p) => p.frag));
});

test('point defense: blasts hurt it, Flak\'s air burst does not; CPUs facing it reach for Scatter, Flak and Rollers', () => {
  const g = mk({ lab: { pointdef: 'all', pointdefLevel: 1 } });
  const [a, b] = g.players;
  g.deployFor(b, 'pointdef');
  const t = turretAt(b);
  g.blastMods([t.x, t.y + 1, t.z], 22 / 1.25, 45, a.id, null, true);   // a Flak burst right over it
  assert.equal(b.mods.pointdef.hp, b.mods.pointdef.maxHp);
  g.blastMods([t.x, t.y, t.z], 11, 38, a.id);
  assert.ok(b.mods.pointdef.hp < b.mods.pointdef.maxHp);
  // The CPU sees it (knownFoes) and weighs its weapons by it.
  const c = mk({ players: [{ name: 'A', ai: 'normal' }, { name: 'B' }], lab: { pointdef: 'all', pointdefLevel: 1 } });
  c.deployFor(c.players[1], 'pointdef');
  const foe = c.knownFoes(c.players[0])[0];
  assert.equal(foe.guarded, true);
  const me = { inventory: { shell: Infinity, breacher: 2, scatter: 2, flak: 2, roller: 2 } };
  const open = weaponWeights(me, { hp: 100, armor: 0 }, { difficulty: 'normal' });
  const guarded = weaponWeights(me, { hp: 100, armor: 0, guarded: true }, { difficulty: 'normal' });
  for (const w of ['scatter', 'flak', 'roller']) assert.ok(guarded[w] > open[w], w);
  for (const w of ['shell', 'breacher']) assert.ok(guarded[w] < open[w], w);
  // A CPU puts it up against an enemy carrying heavy shells.
  const d = mk({ players: [{ name: 'A' }, { name: 'B', ai: 'hard' }], lab: { pointdef: 'all', pointdefLevel: 1 } });
  d.players[0].inventory.breacher = 3;
  const [, cpu] = d.players;
  cpu.hp -= 10;
  assert.equal(d.aiWantsDeploy(cpu, d.players[0]), 'pointdef');
});

test('mod bays: with two mods owned, the draft offers no new-mod cards, only levels', () => {
  const g = mk();
  const p = g.players[0];
  const unlocks = PERKS.filter((k) => k.unlock);
  assert.ok(unlocks.length >= 3);
  assert.ok(unlocks.every((k) => g.perkFits(p, k)), 'none owned: every unlock fits');
  p.perks = ['beacon'];
  assert.ok(g.perkFits(p, PERK_BY_ID.pdturret), 'one owned: another fits');
  assert.ok(g.perkFits(p, PERK_BY_ID.beaconup));
  p.perks = ['beacon', 'pdturret'];
  assert.ok(unlocks.every((k) => !g.perkFits(p, k)), 'bays full: no unlock card fits');
  assert.ok(g.perkFits(p, PERK_BY_ID.beaconup) && g.perkFits(p, PERK_BY_ID.pdup), 'levels still do');
  // The Lab handing out mods fills bays too.
  const h = mk({ lab: { orbiter: 'all', satellite: 'all', level: 1 } });
  assert.ok(!h.perkFits(h.players[0], PERK_BY_ID.beacon));
});

test('ground mods: snapshot and restore keep both mods\' state', () => {
  const g = mk({ firing: 'volley', lab: { decoy: 'all', decoyLevel: 3, pointdef: 'all', pointdefLevel: 2 } });
  const [a, b] = g.players;
  g.deployFor(a, 'pointdef');
  const [tx, tz] = spotNear(g, b, 70);
  aimAt(g, b, tx, tz);
  g.deployFor(b, 'decoy');
  settle(g);
  a.mods.pointdef.charges = 1;
  g.hurtModOf(b.id, 'decoy', 10, a.id);
  const s = JSON.parse(JSON.stringify(g.snapshot()));
  const h = mk({ firing: 'volley', lab: { decoy: 'all', decoyLevel: 3, pointdef: 'all', pointdefLevel: 2 } });
  h.restore(s);
  assert.deepEqual(h.players[0].mods.pointdef, a.mods.pointdef);
  assert.deepEqual(h.players[1].mods.decoy, b.mods.decoy);
  assert.deepEqual(modTargets(h.players, h.clock), modTargets(g.players, g.clock));
  assert.equal(h.players[1].mods.decoy.hp, 25);
  assert.equal(h.players[0].mods.pointdef.charges, 1);
});

test('ground mods: an all-CPU match with both plays through, the same every run', () => {
  const play = () => {
    const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'hard' }, { name: 'C', ai: 'easy' }],
      rounds: 2, seed: 21, resolution: 64, firing: 'volley', maxTurnsPerRound: 8, lab: { decoy: 'all', decoyLevel: 3, pointdef: 'all', pointdefLevel: 3 } });
    g.start();
    const seen = { decoy: 0, pointdef: 0, intercept: 0 };
    let frames = 0;
    while (g.phase !== 'matchOver' && frames++ < 80000) {
      g.update(1 / 30);
      for (const e of g.drainEvents()) {
        if (e.type === 'mod' && e.what === 'deploy') seen[e.mod] = (seen[e.mod] || 0) + 1;
        if (e.type === 'intercept') seen.intercept++;
      }
      if (g.phase === 'roundOver' && g.phaseTime > 0.3) g.openShop();
    }
    return { phase: g.phase, seen, hp: g.players.map((p) => [p.score, p.stats.shots, Math.round(p.money)]) };
  };
  const one = play();
  assert.equal(one.phase, 'matchOver');
  assert.ok(one.seen.pointdef >= 1, `point defense deployed ${one.seen.pointdef}`);
  assert.deepEqual(play(), one, 'deterministic');
});
