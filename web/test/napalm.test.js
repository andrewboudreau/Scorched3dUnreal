// Napalm and the Dirt Bomb (core/napalm.js): fuel runs downhill and pools,
// a tank in a hollow burns and one on a crest barely does, water puts it out;
// the dome buries a tank unhurt and its next shot digs it out; the fires and
// the burying travel in snapshots and replay from the ground's ops; the CPUs
// use both and dig themselves out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { Game } from '../src/core/game.js';
import { SIM_DT } from '../src/core/ballistics.js';
import { WEAPON_BY_ID, shotValue, VALUE_BAND, impactEffects } from '../src/core/weapons.js';
import { NAPALM, BURY, flowNapalm, napalmDose } from '../src/core/napalm.js';
import { weaponWeights, chooseWeapon, holeDepth, UTILITY } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';

const field = (h = 20) => {
  const t = new Heightfield({ size: 800, resolution: 256 });
  t.heights.fill(h);
  return t;
};
const kit = (ids) => Object.fromEntries(['shell', ...ids].map((id) => [id, id === 'shell' ? Infinity : 2]));
// A ridge along z through x = 0: 15 m high, falling 0.5 m a metre.
const ridge = (t) => {
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) t.heights[t.index(i, j)] = 20 + Math.max(0, 15 - Math.abs(t.vx(i)) * 0.5);
};

// Two (or more) tanks on flat, dry, empty ground.
function arena({ seed = 3, ai = null, n = 2, resolution = 256 } = {}) {
  const players = Array.from({ length: n }, (_, k) => ({ name: 'ABCD'[k], ai }));
  const g = new Game({ players, rounds: 3, seed, resolution, twists: false });
  g.start();
  g.terrain.heights.fill(20);
  g.terrain.scorch.fill(0);
  g.terrain.waterLevel = -Infinity;
  g.scenery.props.length = 0;
  g.wind = [0, 0];
  g.players.forEach((p, k) => { p.x = -150 + k * 300; p.z = 0; p.y = 20; });
  g.drainEvents();
  return g;
}
const burnOut = (g) => { for (let k = 0; k < 2000 && g.fires.length; k++) g.stepWorld(SIM_DT); };

test('napalm runs downhill and pools in the hollow at the bottom', () => {
  const t = field();
  // A slope falling toward +x down to a crater at x = 30.
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) t.heights[t.index(i, j)] = 20 + Math.max(0, 30 - t.vx(i)) * 0.3;
  t.carveCrater(30, 20, 0, 11, 0.6);
  // Spilt 20 m up the slope: it runs down into the crater and pools there.
  const { cells, lost, doused } = flowNapalm(t, 10, 0);
  assert.equal(doused, false);
  const total = cells.reduce((s, c) => s + c[2], 0);
  assert.ok(Math.abs(total + lost - NAPALM.fuel) < 1e-9, `fuel is kept: ${total} + ${lost}`);
  const deepest = cells.reduce((a, c) => (c[2] > a[2] ? c : a));
  assert.ok(Math.hypot(t.vx(deepest[0]) - 30, t.vz(deepest[1])) < 5, `pooled at ${t.vx(deepest[0])}, ${t.vz(deepest[1])}`);
  assert.ok(deepest[2] > 1, `a pool ${deepest[2].toFixed(2)} m deep`);
  // Most of it is in the crater; up the slope where it landed only a film is left.
  const inCrater = (cs) => cs.filter((c) => Math.hypot(t.vx(c[0]) - 30, t.vz(c[1])) < 11).reduce((s, c) => s + c[2], 0);
  assert.ok(inCrater(cells) > NAPALM.fuel * 0.7, `in the crater ${inCrater(cells).toFixed(2)}`);
  for (const c of cells) if (Math.abs(t.vx(c[0]) - 10) < 4 && Math.abs(t.vz(c[1])) < 4) assert.ok(c[2] < NAPALM.film, 'the spill point keeps a film');
  // Nothing runs uphill, and a longer run down leaves more of it on the way.
  assert.ok(cells.every((c) => t.vx(c[0]) > 10 - 7), 'not uphill');
  const far = flowNapalm(t, -15, 0).cells;
  assert.ok(inCrater(far) < inCrater(cells), 'a long run thins out');
  // The same spill gives the same flow, to the bit.
  assert.deepEqual(flowNapalm(t, 10, 0), { cells, lost, doused });
});

test('a tank in a hollow burns for the full dose; one on a crest is barely singed', () => {
  // The dose itself.
  const bowl = field();
  bowl.carveCrater(0, 20, 0, 11, 0.6);
  assert.equal(napalmDose(bowl, flowNapalm(bowl, 7, 0).cells, 0, 0), 1, 'in a crater, a near miss pools on it');
  const crest = field();
  ridge(crest);
  assert.ok(napalmDose(crest, flowNapalm(crest, 0, 0).cells, 0, 0) < 0.15, 'on a crest, even a direct hit runs off');
  const flat = field();
  const level = napalmDose(flat, flowNapalm(flat, 0, 0).cells, 0, 0);
  assert.ok(level > 0.15 && level < 0.6, `on the level, in between: ${level}`);

  // In a game: the same napalm, one tank in a crater and one on a crest.
  const hurt = (setup) => {
    const g = arena();
    const [a, b] = g.players;
    setup(g, b);
    g.applyEffect({ type: 'napalm', point: [b.x + 6, g.terrain.heightAt(b.x + 6, b.z), b.z] }, a.id, null, 1);
    assert.equal(g.fires.length, 1);
    burnOut(g);
    assert.equal(g.fires.length, 0);
    return { lost: b.maxHp - b.hp, g, a, b };
  };
  const hollow = hurt((g, b) => { g.terrain.carveCrater(b.x, 20, b.z, 12, 0.6); b.y = g.terrain.heightAt(b.x, b.z); });
  const ridgeTop = hurt((g, b) => {
    for (let j = 0; j < g.terrain.n; j++) for (let i = 0; i < g.terrain.n; i++) {
      g.terrain.heights[g.terrain.index(i, j)] = 20 + Math.max(0, 15 - Math.abs(g.terrain.vx(i) - b.x) * 0.5);
    }
    b.y = g.terrain.heightAt(b.x, b.z);
  });
  assert.ok(Math.abs(hollow.lost - NAPALM.damage) < 0.5, `in the hollow: ${hollow.lost.toFixed(1)}`);
  assert.ok(ridgeTop.lost < 8, `on the crest: ${ridgeTop.lost.toFixed(1)}`);
  // Credited to the shooter, as damage and as a hit.
  assert.ok(hollow.a.stats.damage > 50 && hollow.a.stats.hits === 1);
  assert.equal(hollow.a.hp, hollow.a.maxHp, 'far away, the shooter is untouched');
  assert.ok(hollow.g.ground.ops.some((o) => o[0] === 'n'), 'the scorch is in the ground ops');
});

test('the fire holds the turn until it is out, then the game goes on', () => {
  const g = arena();
  const [a, b] = g.players;
  g.terrain.carveCrater(b.x, 20, b.z, 12, 0.6);
  b.y = g.terrain.heightAt(b.x, b.z);
  g.applyEffect({ type: 'napalm', point: [b.x, b.y, b.z] }, a.id, null, 1);
  g.phase = 'flight';
  g.phaseTime = 0;
  let flight = 0;
  while (g.phase === 'flight' && flight < 600) { g.update(1 / 30); flight++; }
  assert.ok(flight / 30 > 2.5, `the flight lasted ${(flight / 30).toFixed(2)} s`);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.type === 'napalm' && e.cells.length > 0));
  assert.ok(ev.some((e) => e.type === 'napalmOut'));
  assert.ok(ev.filter((e) => e.type === 'damage' && e.player === b.id).length >= NAPALM.ticks - 1, 'it burns in ticks');
});

test('water puts napalm out', () => {
  const t = field();
  t.carveCrater(0, 20, 0, 14, 0.7);
  t.waterLevel = 15;   // a flooded crater
  // Landing in the water: nothing burns.
  const wet = flowNapalm(t, 0, 0);
  assert.equal(wet.doused, true);
  assert.equal(wet.cells.length, 0);
  // Landing on the bank: what runs into the water goes out, and nothing burns in it.
  const bank = flowNapalm(t, 12, 0);
  assert.ok(bank.lost > NAPALM.fuel * 0.5, `lost ${bank.lost.toFixed(2)}`);
  for (const [i, j] of bank.cells) assert.ok(t.heights[t.index(i, j)] >= t.waterLevel, 'no fire on the water');
  // A tank in the flooded crater takes nothing; in a game nothing is left burning.
  assert.equal(napalmDose(t, bank.cells, 0, 0), 0);
  const g = arena();
  g.terrain.carveCrater(0, 20, 0, 14, 0.7);
  g.terrain.waterLevel = 15;
  g.applyEffect({ type: 'napalm', point: [0, g.terrain.heightAt(0, 0), 0] }, 0, null, 1);
  assert.equal(g.fires.length, 0);
  assert.ok(g.drainEvents().some((e) => e.type === 'napalm' && e.doused));
});

test('the Dirt Bomb buries a tank unhurt; it cannot move, and its next shot digs it out', () => {
  const g = arena();
  const [a, b] = g.players;
  const w = WEAPON_BY_ID.dirtbomb;
  const [fx] = impactEffects(w, [b.x + 4, 20, b.z]);
  assert.equal(fx.type, 'bury');
  g.applyEffect(fx, a.id, null, 1);
  assert.ok(b.buried, 'buried');
  assert.equal(b.hp, b.maxHp, 'unhurt');
  const soil = g.terrain.heightAt(b.x, b.z) - b.y;
  assert.ok(soil > 10, `under ${soil.toFixed(1)} m of soil`);
  assert.ok(g.drainEvents().some((e) => e.type === 'buried' && e.player === b.id));
  assert.ok(g.ground.ops.some((o) => o[0] === 'm'), 'the dome is in the ground ops');
  // Stuck: no driving, no hopping, and the fall code leaves it where it is.
  b.fuel = 30; b.jets = 1;
  assert.equal(g.driveTank(b, 1, 0.1), 'buried');
  assert.equal(g.jumpTank(b), 'buried');
  for (let k = 0; k < 30; k++) g.stepWorld(SIM_DT);
  assert.ok(b.buried && g.terrain.heightAt(b.x, b.z) - b.y > 10, 'still under');
  // A Napalm on the dome does not reach it.
  g.applyEffect({ type: 'napalm', point: [b.x, g.terrain.heightAt(b.x, b.z), b.z] }, a.id, null, 2);
  burnOut(g);
  assert.equal(b.hp, b.maxHp, 'the soil covers it');
  // Its shot digs it out: no shell flies, no ammo goes, nobody is hurt.
  b.inventory = kit(['breacher']);
  b.weapon = 'breacher';
  const y0 = b.y;
  assert.ok(g.launch(b));
  assert.equal(g.projectiles.length, 0);
  assert.equal(b.inventory.breacher, 2, 'the ammo is kept');
  assert.equal(b.buried, false);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.type === 'dig' && e.player === b.id));
  for (let k = 0; k < 60; k++) g.stepWorld(SIM_DT);
  assert.ok(g.terrain.heightAt(b.x, b.z) <= y0 + 0.01, 'the soil over it is gone');
  assert.ok(Math.abs(b.y - y0) < 1, `it stands where it was (${(b.y - y0).toFixed(2)})`);
  assert.equal(b.hp, b.maxHp);
  assert.equal(g.driveTank(b, 1, 0.1) === 'buried', false, 'it can drive again');
});

test('the Dirt Bomb: a tank at the edge rides up on the dome; a blast that clears the soil frees a buried one', () => {
  const g = arena();
  const [a, b] = g.players;
  a.x = b.x + 19.5; a.z = 0; a.y = 20;
  g.applyEffect({ type: 'bury', point: [b.x, 20, b.z], radius: 20, height: 16 }, null, null);
  assert.ok(b.buried);
  assert.equal(a.buried, false, 'too little soil over it');
  assert.ok(a.y >= g.terrain.heightAt(a.x, a.z) - 1e-6, 'lifted on top');
  // Shells dig the dome away until the tank is out.
  for (let k = 0; k < 12 && b.buried; k++) {
    g.applyEffect({ type: 'blast', point: [b.x, g.terrain.heightAt(b.x, b.z), b.z], radius: 11, damage: 1, depth: 0.6 }, null, null);
    g.stepWorld(SIM_DT);
  }
  assert.equal(b.buried, false, 'dug out by blasts');
  assert.ok(g.drainEvents().some((e) => e.type === 'unburied' && e.player === b.id));
  // A new round starts everyone unburied.
  g.applyEffect({ type: 'bury', point: [b.x, b.y, b.z], radius: 20, height: 16 }, null, null);
  assert.ok(b.buried);
  g.startRound();
  assert.ok(g.players.every((p) => !p.buried));
});

test('a buried CPU digs out with its shot, then fights on', () => {
  const g = arena({ ai: 'normal' });
  const [a, b] = g.players;
  g.applyEffect({ type: 'bury', point: [a.x, 20, a.z], radius: 20, height: 16 }, b.id, null);
  assert.ok(a.buried);
  g.beginTurn(a.id);
  assert.ok(g.aiPlan?.dig, 'its plan is to dig');
  assert.equal(g.aiDrive, null, 'it does not try to drive');
  let dug = false;
  for (let k = 0; k < 2000 && g.turn === a.id; k++) {
    g.update(1 / 30);
    for (const e of g.drainEvents()) if (e.type === 'dig') dug = true;
  }
  assert.ok(dug && !a.buried, 'dug out on its turn');
  assert.equal(a.hp, a.maxHp);
  // In a volley too.
  const v = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 2, seed: 5, resolution: 128, twists: false, firing: 'volley' });
  v.start();
  const c = v.players[0];
  v.applyEffect({ type: 'bury', point: [c.x, c.y, c.z], radius: 20, height: 16 }, 1, null);
  assert.ok(c.buried);
  let free = false;
  for (let k = 0; k < 6000 && !free; k++) {
    v.update(1 / 30);
    for (const e of v.drainEvents()) if (e.type === 'dig' && e.player === c.id) free = true;
  }
  assert.ok(free, 'dug out in the volley');
});

test('napalm fires and buried tanks travel in snapshots, and the ground replays from its ops', () => {
  // The match's own seeded ground, so a fresh copy can rebuild it.
  const fresh = () => {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 12, resolution: 128, twists: false });
    g.start();
    g.drainEvents();
    return g;
  };
  const a = fresh();
  const [p, q] = a.players;
  a.carve(q.x, q.y, q.z, 12, 0.6);   // q sits in a crater
  for (let k = 0; k < 200; k++) a.stepWorld(SIM_DT);
  a.applyEffect({ type: 'bury', point: [p.x, p.y, p.z], radius: 20, height: 16 }, q.id, null);
  a.applyEffect({ type: 'napalm', point: [q.x + 5, a.terrain.heightAt(q.x + 5, q.z), q.z] }, p.id, null, 1);
  for (let k = Math.round(1.6 / SIM_DT); k > 0; k--) a.stepWorld(SIM_DT);   // part way through the burn
  assert.ok(p.buried);
  assert.ok(a.fires.length === 1 && a.fires[0].tick > 0 && a.fires[0].tick < NAPALM.ticks, 'mid-burn');
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  // A fresh copy that never saw the shots rebuilds the ground and takes on the fire.
  const b = fresh();
  b.restore(snap);
  assert.ok(b.players[0].buried);
  assert.deepEqual(b.fires, a.fires);
  const same = (x, y, arr) => Array.from(x.terrain[arr]).every((v, k) => Math.abs(v - y.terrain[arr][k]) < 1e-4);
  assert.ok(same(b, a, 'heights'), 'the dome and the crater replay');
  assert.ok(same(b, a, 'scorch'), 'the napalm scorch replays');
  assert.ok(Array.from(a.terrain.scorch).some((s) => s > 0.5));
  // Both finish the burn alike.
  burnOut(a);
  burnOut(b);
  assert.deepEqual(b.players.map((x) => x.hp), a.players.map((x) => x.hp));
  assert.ok(q.hp < q.maxHp && p.hp === p.maxHp);
  assert.ok(b.players[0].buried, 'still buried after the fire');
  // And the replay of the ops alone lands on the same ground.
  const c = fresh();
  c.rebuildGround(a.round, JSON.parse(JSON.stringify(a.ground)));
  assert.ok(same(c, a, 'heights') && same(c, a, 'scorch'));
});

test('CPUs pick Napalm against a target sunk in a hollow, and bury a dangerous one', () => {
  const me = { y: 20, inventory: kit(['napalm', 'dirtbomb', 'breacher']) };
  const target = { y: 20, hp: 100 };
  const w0 = weaponWeights(me, target, { dist: 200, pit: 0 });
  const wPit = weaponWeights(me, target, { dist: 200, pit: 6 });
  const wCrest = weaponWeights(me, target, { dist: 200, pit: -5 });
  assert.ok(wPit.napalm > w0.napalm * 3 && wCrest.napalm < w0.napalm * 0.5, `${wCrest.napalm} < ${w0.napalm} < ${wPit.napalm}`);
  assert.ok(!('napalm' in weaponWeights(me, target, { dist: 30, pit: 6 })), 'not at its own feet');
  assert.ok(!('dirtbomb' in w0), 'no Dirt Bomb at a target that is no danger');
  assert.ok('dirtbomb' in weaponWeights(me, target, { dist: 200, danger: true }), 'a dangerous one gets buried');
  assert.ok(!('dirtbomb' in weaponWeights(me, { ...target, buried: true }, { dist: 200, danger: true })), 'not one already buried');
  assert.ok(!('dirtbomb' in weaponWeights(me, { ...target, hp: 30 }, { dist: 200, danger: true })), 'not with a kill on offer');
  assert.ok(UTILITY.includes('dirtbomb'), 'never half of a Double Strike');

  // In a game: the target in a crater is seen as sunk, and Napalm comes up often.
  const g = arena({ ai: 'normal' });
  const [a, b] = g.players;
  g.terrain.carveCrater(b.x, 20, b.z, 14, 0.7);
  b.y = g.terrain.heightAt(b.x, b.z);
  a.inventory = kit(['napalm', 'breacher']);
  const ctx = g.aiSituation(a, b);
  assert.ok(ctx.pit > 3, `pit ${ctx.pit}`);
  assert.ok(Math.abs(ctx.pit - holeDepth(g.terrain, b.x, b.z, b.y)) < 1e-9);
  const rng = makeRng(9);
  let n = 0;
  for (let k = 0; k < 300; k++) if (chooseWeapon(a, b, rng, ctx) === 'napalm') n++;
  const flat = arena({ ai: 'normal' });
  flat.players[0].inventory = kit(['napalm', 'breacher']);
  const ctxFlat = flat.aiSituation(flat.players[0], flat.players[1]);
  let m = 0;
  for (let k = 0; k < 300; k++) if (chooseWeapon(flat.players[0], flat.players[1], rng, ctxFlat) === 'napalm') m++;
  assert.ok(n / 300 > 0.45 && n > m * 2, `napalm ${n}/300 at a sunk target, ${m}/300 on the level`);
  // The planner fires it at the target.
  let fired = false;
  for (let seed = 1; seed <= 8 && !fired; seed++) {
    const h = arena({ ai: 'normal', seed });
    const [p, q] = h.players;
    h.terrain.carveCrater(q.x, 20, q.z, 14, 0.7);
    q.y = h.terrain.heightAt(q.x, q.z);
    p.inventory = kit(['napalm']);
    h.beginTurn(p.id);
    fired = h.aiPlan?.weapon === 'napalm' && h.aiPlan.target === q.id;
  }
  assert.ok(fired, 'a CPU plans a Napalm shot at the sunk target');
});

test('a CPU that is being hurt buries the tank hurting it', () => {
  let buried = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const g = arena({ ai: 'normal', seed });
    const [a, b] = g.players;
    a.inventory = kit(['dirtbomb']);
    a.hp = 40; a.hitsHere = 2; a.hitBy = b.id;
    a.fuel = 0; a.jets = 0;   // no driving off instead
    g.beginTurn(a.id);
    if (g.aiPlan?.weapon === 'dirtbomb') buried++;
  }
  assert.ok(buried >= 4, `reached for the Dirt Bomb in ${buried} of 10`);
});

test('Napalm and the Dirt Bomb are in the armory, priced by the yardstick', () => {
  const np = WEAPON_BY_ID.napalm, db = WEAPON_BY_ID.dirtbomb;
  assert.equal(np.role, 'Area');
  assert.equal(np.tier, 'advanced');
  const rate = np.price / np.bundle / shotValue(np);
  assert.ok(rate >= VALUE_BAND[0] && rate <= VALUE_BAND[1], `napalm ${rate.toFixed(2)} a point`);
  assert.equal(db.role, 'Terrain');
  assert.equal(db.tier, 'standard');
  assert.ok(db.price > 0 && db.bundle > 0);
  // The dome buries out to about the radius its card names.
  const g = arena();
  const b = g.players[1];
  g.applyEffect({ type: 'bury', point: [b.x + 17.5, 20, b.z], ...db.impact[0] }, null, null);
  assert.ok(b.buried, '17.5 m out is buried');
  assert.ok(BURY.depth > 0);
});
