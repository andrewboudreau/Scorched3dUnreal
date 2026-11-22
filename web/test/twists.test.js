import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { simulateShot, launchVelocity, GRAVITY } from '../src/core/ballistics.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { Game, PAY } from '../src/core/game.js';
import { TANK, driveStep } from '../src/core/tank.js';
import { PERKS, PERK_BY_ID, MODIFIERS, MODIFIER_BY_ID, perkSum, hasPerk, draftOffer, pickModifier } from '../src/core/perks.js';

function flatField(h = 0) {
  const t = new Heightfield({ size: 800, resolution: 200 });
  t.heights.fill(h);
  return t;
}

const two = [{ name: 'A' }, { name: 'B' }];

// A started game whose first round rolled the given modifier.
function gameWith(modId, players = two, resolution = 64) {
  for (let seed = 1; seed < 400; seed++) {
    const g = new Game({ players, rounds: 3, seed, resolution });
    g.start();
    if (g.modifier.id === modId) return g;
  }
  throw new Error(`no seed rolled ${modId}`);
}

const plain = (players = two, extra = {}) => {
  const g = new Game({ players, rounds: 3, seed: 11, resolution: 64, twists: false, ...extra });
  g.start();
  return g;
};

// ---- perks ----

test('perk data is well formed and a draft offers three the tank does not hold', () => {
  assert.ok(PERKS.length >= 10 && PERKS.length <= 22);
  assert.equal(new Set(PERKS.map((p) => p.id)).size, PERKS.length);
  assert.equal(new Set(PERKS.map((p) => p.tag)).size, PERKS.length);
  const rng = makeRng(4);
  const me = { perks: ['hull', 'tracer'] };
  for (let k = 0; k < 50; k++) {
    const offer = draftOffer(me, rng);
    assert.equal(offer.length, 3);
    assert.equal(new Set(offer).size, 3);
    assert.ok(offer.every((id) => PERK_BY_ID[id] && !me.perks.includes(id)));
  }
  const nearlyAll = { perks: PERKS.slice(2).flatMap((p) => Array(p.stack || 1).fill(p.id)) };
  assert.equal(draftOffer(nearlyAll, rng).length, 2);
  assert.equal(perkSum({ perks: ['hull', 'longtanks'] }, 'maxHp'), 20);
  assert.ok(hasPerk({ perks: ['shocks'] }, 'noFall'));
  assert.ok(!hasPerk({ perks: [] }, 'noFall'));
});

test('draft: humans are offered perks, CPUs pick at once, a skipped draft takes the first card', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C', ai: 'normal' }], rounds: 3, seed: 8, resolution: 64 });
  g.start();
  g.endRound();
  g.openShop();
  assert.equal(g.phase, 'shop');
  assert.equal(g.players[2].perks.length, 1, 'the CPU already chose');
  assert.equal(g.draft[0].length, 3);
  assert.equal(g.pickPerk(0, 'not-a-perk'), false);
  const wanted = g.draft[0][1];
  assert.ok(g.pickPerk(0, wanted));
  assert.deepEqual(g.players[0].perks, [wanted]);
  assert.equal(g.pickPerk(0, wanted), false, 'one perk per draft');
  const first = g.draft[1][0];
  g.closeShop();
  assert.deepEqual(g.players[1].perks, [first]);
  assert.equal(g.phase, 'aim');
  assert.equal(g.round, 2);
});

test('twists off: no drafts and no modifiers', () => {
  const g = plain([{ name: 'A' }, { name: 'B', ai: 'easy' }]);
  for (let r = 0; r < 2; r++) {
    assert.equal(g.modifier.id, 'clear');
    g.endRound();
    g.openShop();
    assert.deepEqual(g.draft, {});
    g.closeShop();
  }
  assert.ok(g.players.every((p) => p.perks.length === 0));
});

test('perks: hull, armor, free ammo and fuel are applied at the start of each round', () => {
  const g = plain();
  const a = g.players[0];
  a.perks.push('hull', 'dugin', 'quartermaster', 'longtanks');
  const breachers = a.inventory.breacher;
  g.endRound();
  g.openShop();
  g.closeShop();
  assert.equal(a.maxHp, TANK.maxHp + 20);
  assert.equal(a.hp, a.maxHp);
  assert.equal(a.armor, 20);
  assert.equal(a.inventory.breacher, breachers + 1);
  assert.equal(a.fuel, TANK.fuel + 15);
  assert.equal(g.players[1].fuel, TANK.fuel);
  assert.equal(g.players[1].maxHp, TANK.maxHp);
});

test('perks: wide blast and heavy charge reach further and hit harder', () => {
  const hit = (perks) => {
    const g = plain();
    const [a, b] = g.players;
    a.perks.push(...perks);
    g.applyEffect({ type: 'blast', point: [b.x + 15, b.y + TANK.hitCenterY, b.z], radius: 11, damage: 38, depth: 0.6 }, 0, null);
    return TANK.maxHp - b.hp;
  };
  const base = hit([]);
  assert.ok(hit(['wideblast']) > base, 'wider blast reaches a tank the plain one barely touches');
  assert.ok(hit(['heavycharge']) > base * 1.1);
});

test('perks: haggler lowers prices, bounty raises damage pay', () => {
  const g = plain();
  const [a, b] = g.players;
  assert.equal(g.priceOf(a, 'breacher'), 160);
  a.perks.push('haggler');
  assert.equal(g.priceOf(a, 'breacher'), 130);
  a.money = 130;
  assert.ok(g.buy(0, 'breacher'));
  assert.equal(a.money, 0);
  g.damage(a, 10, 1);
  assert.equal(b.money, 10 * PAY.perDamage);
  b.perks.push('bounty');
  g.damage(a, 10, 1);
  assert.equal(b.money, 10 * PAY.perDamage * 2.5);
});

test('perks: shock mounts cancel fall damage, field repairs mend between turns', () => {
  const g = new Game({ players: two, rounds: 1, seed: 21, resolution: 128, twists: false });
  g.start();
  const a = g.players[0];
  a.perks.push('shocks');
  g.terrain.carveCrater(a.x, a.y, a.z, 25, 1);
  for (let i = 0; i < 600; i++) g.stepWorld(1 / 120);
  assert.equal(a.hp, a.maxHp, 'dropped a long way and took nothing');

  const h = plain();
  const me = h.current;
  me.perks.push('repairs');
  me.hp = 50;
  h.nextTurn();
  h.nextTurn();
  assert.equal(h.current, me);
  assert.equal(me.hp, 56);
  me.hp = me.maxHp - 2;
  h.nextTurn();
  h.nextTurn();
  assert.equal(me.hp, me.maxHp, 'never above the maximum');
});

test('perks: heavy rounds drift less in the wind, and the CPU solver knows it', () => {
  const t = flatField();
  const shot = (windK) => simulateShot({ pos: [0, 1, 0], vel: launchVelocity(0, 45, 60), wind: [0, 2], terrain: t, windK }).point[2];
  assert.ok(shot(0.65) < shot(1) * 0.7 && shot(0.65) > 0);
  const g = plain([{ name: 'A' }, { name: 'B', ai: 'hard' }]);
  g.players[1].perks.push('heavyrounds');
  assert.equal(g.windShare(g.players[1]), 0.65);
  assert.equal(g.windShare(g.players[0]), 1);
  g.wind = [1.2, -0.8];
  const pr = g.spawnProjectile([0, 50, 0], [10, 0, 0], 'shell', 1);
  assert.equal(pr.windK, 0.65);
});

test('perks: shrapnel throws two bomblets onward from a Shell that hits the ground', () => {
  const g = plain();
  const a = g.players[0];
  a.perks.push('shrapnel');
  const pr = g.spawnProjectile([0, 60, 0], [20, -5, 0], 'shell', 0);
  g.detonate(pr, [0, g.terrain.heightAt(0, 0), 0], null);
  const kids = g.projectiles.filter((p) => !p.dead && p.weapon === 'bomblet');
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.vel[0] > 0 && k.vel[1] > 0), 'thrown onward and up');
  // A breacher throws nothing, and neither does a tank without the perk.
  const heavy = g.spawnProjectile([0, 60, 0], [20, -5, 0], 'breacher', 0);
  g.detonate(heavy, [50, g.terrain.heightAt(50, 0), 0], null);
  const other = g.spawnProjectile([0, 60, 0], [20, -5, 0], 'shell', 1);
  g.detonate(other, [-50, g.terrain.heightAt(-50, 0), 0], null);
  assert.equal(g.projectiles.filter((p) => !p.dead && p.weapon === 'bomblet').length, 2);
});

// ---- round modifiers ----

test('modifiers: every one can come up, and a twist never repeats back to back', () => {
  const rng = makeRng(3);
  const seen = new Set();
  let last = null;
  for (let k = 0; k < 600; k++) {
    const m = pickModifier(rng, last);
    assert.ok(MODIFIER_BY_ID[m.id]);
    if (m.id !== 'clear') assert.notEqual(m.id, last);
    seen.add(m.id);
    last = m.id;
  }
  assert.equal(seen.size, MODIFIERS.length);
});

test('modifiers: calm kills the wind, gale raises it', () => {
  const calm = gameWith('calm');
  assert.deepEqual(calm.wind, [0, 0]);
  for (let k = 0; k < 20; k++) calm.driftWind();
  assert.deepEqual(calm.wind, [0, 0]);
  const gale = gameWith('gale');
  assert.equal(gale.maxWind, gale.cfg.maxWind * 1.8);
  assert.ok(Math.hypot(...gale.wind) >= gale.maxWind * 0.5 - 1e-9);
});

test('modifiers: low gravity carries shells further and the CPU solver allows for it', () => {
  const g = gameWith('lowgrav');
  assert.equal(g.gravity, GRAVITY * 0.7);
  const pr = g.spawnProjectile([0, 50, 0], [10, 0, 0], 'shell', 0);
  assert.equal(pr.g, g.gravity);
  const t = flatField();
  const range = (gravity) => simulateShot({ pos: [0, 0.01, 0], vel: launchVelocity(0, 45, 50), terrain: t, gravity }).point[0];
  assert.ok(Math.abs(range(GRAVITY * 0.7) - range(GRAVITY) / 0.7) < 3);
  const shooter = { x: -150, y: 0, z: 20 };
  const sol = solveShot({ shooter, target: [160, 0, -40], wind: [0.5, 0.3], terrain: t, rng: makeRng(1), gravity: GRAVITY * 0.7 });
  assert.ok(sol.predictedMiss < 2, `solver converged in low gravity (miss ${sol.predictedMiss})`);
});

test('modifiers: soft ground digs wider craters, gold rush doubles pay, full tanks doubles fuel', () => {
  // Earth removed by one shell-sized blast in the middle of the field.
  const dig = (g) => {
    const before = g.terrain.heights.reduce((s, h) => s + h, 0);
    g.applyEffect({ type: 'blast', point: [0, g.terrain.heightAt(0, 0), 0], radius: 11, damage: 0, depth: 0.6 }, null, null);
    return before - g.terrain.heights.reduce((s, h) => s + h, 0);
  };
  const soft = gameWith('soft', two, 200);
  const flat = new Game({ players: two, rounds: 1, seed: soft.cfg.seed, resolution: 200, twists: false });
  flat.start();
  const ratio = dig(soft) / dig(flat);
  assert.ok(ratio > 1.8 && ratio < 2.6, `a crater 1.3x the size moves about 2.2x the earth (got ${ratio.toFixed(2)})`);

  const gold = gameWith('goldrush');
  gold.damage(gold.players[1], 10, 0);
  assert.equal(gold.players[0].money, 10 * PAY.perDamage * 2);
  gold.players[0].money = 0;
  gold.players[1].alive = false;
  gold.endRound();
  assert.equal(gold.players[1].money, PAY.stipend * 2);
  assert.equal(gold.players[0].money, (PAY.stipend + PAY.survive + PAY.roundWin) * 2);

  const full = gameWith('fulltanks');
  assert.ok(full.players.every((p) => p.fuel === TANK.fuel * 2));
});

// ---- fuel and driving ----

test('driving: spends a metre of fuel per metre and stops when the tank is dry', () => {
  const t = flatField(5);
  const tank = { x: 0, y: 5, z: 0, hull: 90, fuel: 10 };
  let last = 'ok';
  for (let k = 0; k < 600 && last === 'ok'; k++) last = driveStep(tank, t, 1, 1 / 60);
  assert.equal(last, 'empty');
  assert.ok(Math.abs(tank.z - 10) < 1e-6 && Math.abs(tank.x) < 1e-6, 'went 10 m along its hull');
  assert.equal(tank.fuel, 0);
  tank.fuel = 3;
  for (let k = 0; k < 600; k++) driveStep(tank, t, -1, 1 / 60);
  assert.ok(Math.abs(tank.z - 7) < 1e-6, 'reverse goes backward');
});

test('driving: steep slopes, water, the arena edge and other tanks all stop a tank', () => {
  // A ramp rising along +x at 1.3 m per metre: too steep to climb, fine to descend or cross.
  const ramp = flatField();
  for (let j = 0; j < ramp.n; j++) for (let i = 0; i < ramp.n; i++) ramp.heights[j * ramp.n + i] = ramp.vx(i) * 1.3;
  const up = { x: 0, y: 0, z: 0, hull: 0, fuel: 20 };
  assert.equal(driveStep(up, ramp, 1, 0.1), 'steep');
  assert.equal(up.fuel, 20, 'a refused move costs nothing');
  assert.equal(driveStep(up, ramp, -1, 0.1), 'ok', 'backing down the slope is allowed');
  const across = { x: 0, y: 0, z: 0, hull: 90, fuel: 20 };
  assert.equal(driveStep(across, ramp, 1, 0.1), 'ok');
  assert.ok(Math.abs(across.y - ramp.heightAt(across.x, across.z)) < 1e-9, 'stays seated on the ground');

  // A gentler ramp can be climbed, but it burns more fuel than level ground.
  const hill = flatField();
  for (let j = 0; j < hill.n; j++) for (let i = 0; i < hill.n; i++) hill.heights[j * hill.n + i] = hill.vx(i) * 0.5;
  const climber = { x: 0, y: 0, z: 0, hull: 0, fuel: 20 };
  for (let k = 0; k < 20; k++) assert.equal(driveStep(climber, hill, 1, 0.05), 'ok');
  assert.ok(Math.abs(20 - climber.fuel - climber.x * (1 + TANK.climbCost * 0.5)) < 1e-6, 'a 0.5 slope costs double');
  const coaster = { x: 0, y: 0, z: 0, hull: 180, fuel: 20 };
  for (let k = 0; k < 20; k++) driveStep(coaster, hill, 1, 0.05);
  assert.ok(Math.abs(20 - coaster.fuel + coaster.x) < 1e-6, 'downhill costs the same as level');

  // A lake to the east.
  const lake = flatField(4);
  for (let j = 0; j < lake.n; j++) for (let i = 0; i < lake.n; i++) if (lake.vx(i) > 6) lake.heights[j * lake.n + i] = 3.6;
  lake.waterLevel = 3.8;
  const swimmer = { x: 0, y: 4, z: 0, hull: 0, fuel: 30 };
  let r = 'ok';
  for (let k = 0; k < 200 && r === 'ok'; k++) r = driveStep(swimmer, lake, 1, 0.05);
  assert.equal(r, 'water');
  assert.ok(lake.heightAt(swimmer.x, swimmer.z) >= lake.waterLevel, 'stopped on dry ground');

  // A tank that ended up in a flooded hollow can drive up and out, not further in.
  const pond = flatField(4);
  for (let j = 0; j < pond.n; j++) for (let i = 0; i < pond.n; i++) pond.heights[j * pond.n + i] = Math.min(4, 1 + Math.abs(pond.vx(i)) * 0.3);
  pond.waterLevel = 3;
  const sunk = { x: 2, y: pond.heightAt(2, 0), z: 0, hull: 0, fuel: 30 };
  assert.equal(driveStep(sunk, pond, -1, 0.05), 'water', 'not deeper in');
  for (let k = 0; k < 200 && sunk.fuel > 0; k++) driveStep(sunk, pond, 1, 0.05);
  assert.ok(pond.heightAt(sunk.x, sunk.z) > pond.waterLevel, 'it climbed out of the water');

  const t = flatField();
  const edge = { x: t.half - 7, y: 0, z: 0, hull: 0, fuel: 30 };
  for (let k = 0; k < 100 && r !== 'edge'; k++) r = driveStep(edge, t, 1, 0.05);
  assert.equal(r, 'edge');
  assert.ok(edge.x <= t.half - 6);

  const a = { x: 0, y: 0, z: 0, hull: 0, fuel: 30 };
  const b = { x: 12, y: 0, z: 0, alive: true };
  for (let k = 0; k < 200 && r !== 'blocked'; k++) r = driveStep(a, t, 1, 0.05, [a, b]);
  assert.equal(r, 'blocked');
  assert.ok(b.x - a.x >= TANK.bodyRadius * 2 - 0.5);
  assert.equal(driveStep(a, t, -1, 0.05, [a, b]), 'ok', 'it can always back away');
});

test('driving: only the human whose turn it is can drive, and fuel cans carry to the next round', () => {
  const g = plain([{ name: 'A' }, { name: 'B' }, { name: 'C', ai: 'easy' }]);
  const me = g.current;
  assert.equal(me.fuel, TANK.fuel);
  const [x0, z0, hull0] = [me.x, me.z, me.hull];
  assert.equal(g.drive(0, 1, 0.2), 'turn');
  assert.ok(Math.abs(me.hull - (hull0 + TANK.hullTurnSpeed * 0.2) % 360) < 1e-6, 'turning is free');
  assert.equal(me.fuel, TANK.fuel);
  me.hull = hull0;
  let moved = 0;
  for (let k = 0; k < 30; k++) if (g.drive(1, 0, 0.05) === 'ok') moved++;
  assert.ok(moved > 0, 'drove off the spawn pad');
  const dist = Math.hypot(me.x - x0, me.z - z0);
  const spent = TANK.fuel - me.fuel;
  assert.ok(spent >= dist - 1e-6 && spent <= dist * (1 + TANK.climbCost * TANK.maxClimb) + 1e-6, 'fuel went on distance and climb');
  assert.ok(Math.abs(me.y - g.terrain.heightAt(me.x, me.z)) < 1e-9);
  g.fire();
  assert.equal(g.drive(1, 0, 0.05), 'idle', 'no driving once the shell is away');

  me.money = 1000;
  assert.ok(g.buy(me.id, 'fuel'));
  assert.ok(g.buy(me.id, 'fuel'));
  g.phase = 'roundOver';
  g.openShop();
  g.closeShop();
  assert.equal(me.fuel, TANK.fuel + TANK.fuelCan * 2);
  assert.equal(me.pendingFuel, 0);
});

test('a CPU stuck in a pit drives out, then still takes its shot', () => {
  const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 1, seed: 17, resolution: 128, twists: false });
  g.start();
  const me = g.current;
  // A shell-sized crater under it: 7 m deep.
  g.terrain.carveCrater(me.x, me.y, me.z, 12, 0.6);
  me.y = g.terrain.heightAt(me.x, me.z);
  const [x0, y0, z0] = [me.x, me.y, me.z];
  g.beginTurn(me.id);
  assert.ok(g.aiDrive, 'it decides to move');
  let t = 0;
  while (g.phase === 'aim' && t < 20) { g.update(1 / 30); t += 1 / 30; }
  assert.equal(g.phase, 'flight', `fired after ${t.toFixed(1)} s`);
  assert.ok(t < 16, 'the drive did not stall the turn');
  assert.ok(Math.hypot(me.x - x0, me.z - z0) > 5, 'moved');
  assert.ok(me.y > y0 + 1, 'climbed');
  assert.ok(me.fuel < TANK.fuel && me.fuel >= 0);
  assert.ok(Math.abs(me.y - g.terrain.heightAt(me.x, me.z)) < 1e-9, 'seated');
  const m = Object.values(me.aim)[0];
  assert.deepEqual(m.shooter, [me.x, me.y, me.z], 'aim memory was taken from where it stopped');
  // An easy CPU never drives.
  const e = new Game({ players: [{ name: 'A', ai: 'easy' }, { name: 'B', ai: 'easy' }], rounds: 1, seed: 17, resolution: 128, twists: false });
  e.start();
  const lazy = e.current;
  e.terrain.carveCrater(lazy.x, lazy.y, lazy.z, 12, 0.6);
  lazy.y = e.terrain.heightAt(lazy.x, lazy.z);
  e.beginTurn(lazy.id);
  assert.equal(e.aiDrive, null);
});

test('an all-CPU match with twists on plays through drafts, modifiers and drives', () => {
  const g = new Game({
    players: [{ name: 'A', ai: 'hard' }, { name: 'B', ai: 'normal' }, { name: 'C', ai: 'normal' }],
    rounds: 4, seed: 77, resolution: 128,
  });
  g.start();
  const mods = new Set([g.modifier.id]);
  let guard = 0;
  while (g.phase !== 'matchOver' && guard++ < 400000) {
    g.update(1 / 30);
    g.drainEvents();
    for (const p of g.players) {
      assert.ok(p.fuel >= 0 && p.hp <= p.maxHp);
      if (p.alive && !p.falling) assert.ok(p.y >= g.terrain.heightAt(p.x, p.z) - 1e-6, 'never under the ground');
    }
    if (g.phase === 'roundOver' && g.phaseTime > 1) { g.openShop(); mods.add(g.modifier.id); }
  }
  assert.equal(g.phase, 'matchOver');
  assert.ok(g.players.every((p) => p.perks.length === 3 && new Set(p.perks).size === 3), 'one perk per draft, no repeats');
  assert.ok(mods.size >= 2, 'the modifier changed between rounds');
});
