// CPUs and the whole arsenal (ai.js weaponWeights and friends, issue #14):
// each weapon comes up when the situation calls for it, tempers lean the
// choice, Guided Missiles are steered, satellites are drafted and flown, and
// the first guess in the rain allows for the drag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { Game } from '../src/core/game.js';
import { simulateShot, launchVelocity, GRAVITY, SIM_DT } from '../src/core/ballistics.js';
import { makeRng } from '../src/core/rng.js';
import { RAIN_DRAG, aiPickPerk } from '../src/core/perks.js';
import { TANK, muzzleOrigin } from '../src/core/tank.js';
import {
  weaponWeights, chooseWeapon, cpuTemper, TEMPERS, TEMPER_IDS, UTILITY, holeDepth, flatRange, dragSeed, solveShot,
  steerGuided, satelliteSharpen, wantsSatellite, planHeap, findWarp,
} from '../src/core/ai.js';

const RAD = 180 / Math.PI;
const flatField = (h = 20) => {
  const t = new Heightfield({ size: 800, resolution: 128 });
  t.heights.fill(h);
  return t;
};
const kit = (ids) => Object.fromEntries(['shell', ...ids].map((id) => [id, id === 'shell' ? Infinity : 2]));
const share = (n, f) => { let k = 0; for (let i = 0; i < n; i++) if (f(i)) k++; return k / n; };

// A Game with two CPUs on flat, dry, empty ground, the first in a crater.
function arena({ seed = 3, ai = 'normal', crater = 0, firing = 'turns' } = {}) {
  const g = new Game({ players: [{ name: 'A', ai }, { name: 'B', ai }], rounds: 3, seed, resolution: 128, twists: false, firing });
  g.start();
  g.terrain.heights.fill(20);
  g.terrain.waterLevel = -Infinity;
  g.scenery.props.length = 0;
  g.wind = [0, 0];
  const [a, b] = g.players;
  a.x = -150; a.z = 0; b.x = 150; b.z = 0;
  if (crater) g.terrain.carveCrater(a.x, 20, a.z, crater, 0.9);
  a.y = g.terrain.heightAt(a.x, a.z);
  b.y = g.terrain.heightAt(b.x, b.z);
  return g;
}

// ---- the weights ----

test('utility rounds only weigh in when the situation calls for them', () => {
  const me = { y: 20, inventory: kit(['mound', 'teleport', 'ranger', 'scout', 'guided']) };
  const target = { y: 20, hp: 100, armor: 0 };
  const calm = weaponWeights(me, target, {});
  for (const id of ['mound', 'teleport', 'ranger', 'scout', 'guided']) assert.ok(!(id in calm), `${id} on a quiet turn`);
  assert.ok('ranger' in weaponWeights(me, target, { unsure: true, dist: 300 }), 'a long shot with no reading');
  assert.ok(!('ranger' in weaponWeights(me, target, { unsure: true, dist: 100 })), 'not a short one');
  assert.ok('scout' in weaponWeights(me, { ...target, rough: true }, {}), 'a rough fix in the fog');
  assert.ok('guided' in weaponWeights(me, target, { steer: true }), 'offline, it may steer');
  assert.ok('mound' in weaponWeights(me, target, { sunk: 6, heap: {} }), 'in a hole');
  assert.ok(!('mound' in weaponWeights(me, target, { sunk: 6 })), 'not if the heap would not land at its feet');
  assert.ok('mound' in weaponWeights(me, target, { hits: 2, threat: true, heap: {} }), 'being hit');
  assert.ok('teleport' in weaponWeights(me, target, { sunk: 9, warp: {} }), 'deep in a hole');
  assert.ok('teleport' in weaponWeights(me, target, { behind: true, warp: {} }), 'far behind');
  assert.ok(!('teleport' in weaponWeights(me, target, { sunk: 9 })), 'not with nowhere to go');
  // A target a Shell can finish draws no utility round.
  const weak = weaponWeights(me, { ...target, hp: 30 }, { sunk: 9, warp: {}, heap: {}, unsure: true, dist: 300 });
  for (const id of ['mound', 'teleport', 'ranger']) assert.ok(!(id in weak), `${id} with a kill on offer`);
  // Nothing it does not hold.
  assert.deepEqual(Object.keys(weaponWeights({ y: 20, inventory: kit([]) }, target, { sunk: 9, warp: {}, heap: {}, steer: true })), ['shell']);
});

test('a CPU in a deep crater with a Teleport and somewhere to go mostly takes it (a gunner least)', () => {
  const me = { y: 0, inventory: kit(['teleport', 'breacher']) };
  const rng = makeRng(5);
  for (const temper of TEMPER_IDS) {
    const s = share(300, () => chooseWeapon(me, { y: 20, hp: 100 }, rng, { difficulty: 'normal', temper, sunk: 9, warp: {} }) === 'teleport');
    assert.ok(s > (temper === 'gunner' ? 0.4 : 0.55), `${temper}: ${s}`);   // a gunner would rather fight from the hole
  }
});

test('tempers lean the choice, and Easy reads the situation less keenly', () => {
  const me = { y: 20, inventory: kit(['breacher', 'mound', 'roller']) };
  const ctx = { hits: 2, threat: true, hurt: true, heap: {} };
  const rng = makeRng(9);
  const mound = (temper, difficulty = 'normal') => share(600, () => chooseWeapon(me, { y: 20 }, rng, { ...ctx, temper, difficulty }) === 'mound');
  assert.ok(mound('sapper') > mound('gunner') + 0.15, `sapper ${mound('sapper')} vs gunner ${mound('gunner')}`);
  assert.ok(mound('sapper', 'easy') < mound('sapper') - 0.1, 'easy heaps less');
  // Every temper exists for some CPU, and a CPU's temper is fixed by the match seed and its id.
  const seen = new Set();
  for (let id = 0; id < 6; id++) for (let seed = 1; seed < 20; seed++) seen.add(cpuTemper(seed, id));
  assert.deepEqual([...seen].sort(), [...TEMPER_IDS].sort());
  assert.equal(cpuTemper(77, 2), cpuTemper(77, 2));
  assert.ok(UTILITY.every((id) => TEMPER_IDS.some((t) => TEMPERS[t][id] > 1)), 'each utility round has a temper that likes it');
});

// ---- in a game ----

test('a CPU stuck in a crater with no fuel or jets teleports out', () => {
  let picked = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const g = arena({ seed, crater: 18 });
    const a = g.players[0];
    a.fuel = 0; a.jets = 0;
    a.inventory = kit(['teleport']);
    assert.ok(holeDepth(g.terrain, a.x, a.z, a.y) > 7);
    g.beginTurn(a.id);
    if (g.aiPlan?.weapon !== 'teleport') continue;
    picked++;
    const before = holeDepth(g.terrain, a.x, a.z, a.y);
    let warped = null;
    for (let k = 0; k < 4000 && g.turn === a.id; k++) {
      g.update(1 / 30);
      for (const e of g.drainEvents()) if (e.type === 'warp') warped = e;
    }
    assert.ok(warped, `seed ${seed}: it warped`);
    assert.ok(holeDepth(g.terrain, a.x, a.z, a.y) < before - 5, `seed ${seed}: out of the hole`);
    assert.ok(Math.hypot(a.x - g.players[1].x, a.z - g.players[1].z) > 60, 'not next to the enemy');
  }
  assert.ok(picked >= 6, `teleported in ${picked} of 8`);
});

test('a CPU in a hole heaps a Mound at its feet and comes up out of it', () => {
  let heaped = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = arena({ seed, crater: 14 });
    const a = g.players[0];
    a.fuel = 0; a.jets = 0;
    a.inventory = kit(['mound']);
    const before = holeDepth(g.terrain, a.x, a.z, a.y);
    const y0 = a.y;
    assert.ok(before > 4);
    g.beginTurn(a.id);
    if (g.aiPlan?.weapon !== 'mound') continue;
    heaped++;
    for (let k = 0; k < 4000 && g.turn === a.id; k++) { g.update(1 / 30); g.drainEvents(); }
    assert.ok(a.y > y0 + 5, `seed ${seed}: lifted ${(a.y - y0).toFixed(1)} m`);
    assert.ok(holeDepth(g.terrain, a.x, a.z, a.y) < before - 4, `seed ${seed}: less of a hole`);
    assert.ok(a.alive && a.hp === a.maxHp, 'a Mound does no damage');
  }
  assert.ok(heaped >= 6, `heaped in ${heaped} of 12`);
});

test('planHeap only offers a heap that lands at its feet; findWarp picks dry, open ground away from the enemy', () => {
  const t = flatField();
  const me = { x: 0, y: 20, z: 0, yaw: 0 };
  assert.ok(planHeap({ me, toward: [200, 0], terrain: t }));
  assert.equal(planHeap({ me, toward: [200, 0], terrain: t, wind: [9, 0] }), null, 'a gale blows it away');
  const foes = [{ x: 150, z: 0 }];
  const rng = makeRng(4);
  for (let k = 0; k < 20; k++) {
    const w = findWarp({ me, foes, terrain: t, rng });
    assert.ok(w && Math.hypot(w.x - 150, w.z) >= 80 && Math.abs(w.x) < 360 && Math.abs(w.z) < 360);
  }
  assert.equal(findWarp({ me, foes, terrain: t, rng, solid: () => false }), null, 'nowhere solid');
});

test('a CPU steers its Guided Missile onto the line it meant, and only offline', () => {
  const g = arena({ seed: 7 });
  const [a, b] = g.players;
  const land = (steer) => {
    const sol = solveShot({ shooter: a, target: [b.x, b.y + 1, b.z], wind: [0, 0], terrain: g.terrain, rng: makeRng(1) });
    a.inventory.guided = 5;
    g.aimAt(a, { yaw: sol.yaw + 5, elev: sol.elev, power: sol.power, weapon: 'guided', goal: steer ? [b.x, b.z] : null });
    g.projectiles = [];
    g.launch(a);
    let at = null;
    for (let k = 0; k < 20000 && g.projectiles.length; k++) {
      g.stepWorld(SIM_DT);
      for (const e of g.drainEvents()) if (e.type === 'impact') at = e.pos;
    }
    return Math.abs(at[2] - b.z);
  };
  const off = land(false);
  const on = land(true);
  assert.ok(off > 15, `unsteered, 5 degrees off is ${off.toFixed(1)} m wide`);
  assert.ok(on < 6, `steered lands ${on.toFixed(1)} m wide`);
  // The policy: nothing early, nothing near the goal, else toward it.
  const pr = { time: 0.1, pos: [0, 50, 0], vel: [30, 0, 0] };
  assert.equal(steerGuided(pr, [200, 50], 'normal'), 0, 'too early');
  assert.equal(steerGuided({ ...pr, time: 2 }, [200, 50], 'normal'), 1);
  assert.equal(steerGuided({ ...pr, time: 2 }, [200, -50], 'normal'), -1);
  assert.equal(steerGuided({ ...pr, time: 2 }, [200, 2], 'normal'), 0, 'inside its deadband');
  assert.equal(steerGuided({ ...pr, time: 2 }, [5, 5], 'hard'), 0, 'too close to bother');
  // Online there is no Guided Missile at all, so nothing to steer.
  const online = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], rounds: 1, seed: 1, resolution: 64, local: [0] });
  assert.equal(online.players[1].inventory.guided, 0);
});

test('the satellite: CPUs draft it, put it up when they have no reading on a far target, and aim better under it', () => {
  // Drafting: a neutral card for most, a favourite for a spotter.
  const rng = makeRng(2);
  const plain = share(400, () => aiPickPerk(['satrecon', 'haggler'], rng) === 'satrecon');
  const spotter = share(400, () => aiPickPerk(['satrecon', 'haggler'], rng, TEMPERS.spotter.likes) === 'satrecon');
  assert.ok(plain > 0.35 && plain < 0.65, `neutral: ${plain}`);
  assert.ok(spotter > 0.75, `spotter: ${spotter}`);
  // Deploying: far and unread yes, close or dialled in or finishable no.
  const me = { x: 0, z: 0 };
  const far = { id: 1, x: 300, z: 0, hp: 100 };
  const yes = (t, memory = {}, temper = 'spotter') => share(200, () => wantsSatellite({ me, target: t, memory, difficulty: 'normal', temper, rng }));
  assert.ok(yes(far) > 0.6);
  assert.equal(yes({ ...far, x: 80 }), 0);
  assert.equal(yes(far, { 1: { shots: 3, yaw: 0.2, power: 0.005 } }), 0);
  assert.equal(yes({ ...far, hp: 30 }), 0);
  assert.ok(yes(far, {}, 'gunner') < yes(far, {}, 'spotter'));
  // Reading it: higher levels help more; level 1 less in the wind; Easy reads it worse.
  assert.equal(satelliteSharpen(0), 1);
  assert.ok(satelliteSharpen(3) < satelliteSharpen(2) && satelliteSharpen(2) < satelliteSharpen(1) && satelliteSharpen(1) < 1);
  assert.ok(satelliteSharpen(1, { windy: 1 }) > satelliteSharpen(1, { windy: 0 }));
  assert.ok(satelliteSharpen(2, { difficulty: 'easy' }) > satelliteSharpen(2));
  // In a game where everyone has one, CPUs fly theirs.
  const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'hard' }, { name: 'C', ai: 'normal' }], rounds: 1, seed: 12, resolution: 64, lab: { satellite: 'all', level: 2 } });
  g.start();
  let up = 0;
  let sharper = false;
  for (let k = 0; k < 200000 && g.phase === 'aim' || g.phase === 'flight' || g.phase === 'settle'; k++) {
    g.update(1 / 20);
    for (const e of g.drainEvents()) if (e.type === 'mod' && e.what === 'deploy' && e.mod === 'satellite') up++;
    if (g.players.some((p) => p.alive && g.aiSharpen(p) < 1)) sharper = true;
  }
  assert.ok(up > 0, 'a CPU put its satellite up');
  assert.ok(sharper, 'and aimed under it');
});

// ---- whole matches ----

function playMatch(seed, { ai = 'normal', fog = false } = {}) {
  const g = new Game({ players: [{ name: 'A', ai }, { name: 'B', ai }, { name: 'C', ai }], rounds: 3, seed, resolution: 64, fog });
  g.start();
  const fired = [];
  for (let k = 0; k < 300000 && g.phase !== 'matchOver'; k++) {
    if (g.phase === 'roundOver') {
      for (const p of g.players) p.money += 600;   // enough to shop for its temper too
      g.openShop();
      continue;
    }
    g.update(1 / 20);
    for (const e of g.drainEvents()) if (e.type === 'fire') fired.push(`${e.player}:${e.weapon}`);
  }
  assert.equal(g.phase, 'matchOver');
  return { fired, sum: g.players.map((p) => `${p.wins}/${p.hp.toFixed(3)}/${p.x.toFixed(3)}/${p.stats.shots}`).join(' ') };
}

test('across a few matches the CPUs fire most of the arsenal, and a match replays the same', () => {
  const weapons = new Set();
  let first = null;
  for (const seed of [1, 2, 3, 4]) {
    const m = playMatch(seed);
    if (seed === 1) first = m;
    for (const f of m.fired) weapons.add(f.split(':')[1]);
  }
  assert.ok(weapons.size >= 8, `only ${[...weapons].join(', ')}`);
  for (const id of ['shell', 'breacher', 'guided', 'ranger']) assert.ok(weapons.has(id), id);
  assert.ok(weapons.has('mound') || weapons.has('teleport'), 'a Mound or a Teleport');
  assert.deepEqual(playMatch(1), first, 'deterministic');
});

// ---- the rain ----

test('in the rain the first guess allows for the drag, so the opening lob is not short', () => {
  const d = 400, elev = 52;
  const dry = Math.sqrt((d * GRAVITY) / Math.sin((2 * elev) / RAD));
  const shortBy = 1 - flatRange(dry, elev, GRAVITY, RAIN_DRAG) / d;
  assert.ok(shortBy > 0.15, `the dry guess falls ${(shortBy * 100).toFixed(0)}% short in the rain`);
  const wet = dragSeed(dry, elev, d, GRAVITY, RAIN_DRAG);
  const t = flatField(0);
  const shot = simulateShot({ pos: [-200, 0.01, 0], vel: launchVelocity(0, elev, wet), terrain: t, drag: RAIN_DRAG });
  assert.ok(Math.abs(shot.point[0] + 200 - d) < 12, `the wet guess lands ${(shot.point[0] + 200 - d).toFixed(1)} m off at ${d} m`);
  assert.ok(wet < TANK.maxPower);
  // The solver gets there in fewer trial shots, with no bias to the short side.
  let its = 0, along = 0;
  for (let k = 0; k < 20; k++) {
    const shooter = { x: -200, y: 0, z: 0 };
    const target = [120 + k * 8, 0, (k % 5) * 20 - 40];
    const sol = solveShot({ shooter, target, wind: [0, 0], terrain: t, rng: makeRng(k), drag: RAIN_DRAG });
    its += sol.iterations;
    const p = simulateShot({ pos: muzzleOrigin(shooter, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), terrain: t, drag: RAIN_DRAG });
    along += Math.hypot(p.point[0] - shooter.x, p.point[2]) - Math.hypot(target[0] - shooter.x, target[2]);
    assert.ok(sol.predictedMiss < 2);
  }
  assert.ok(its / 20 < 4, `${its / 20} trial shots on average`);
  assert.ok(Math.abs(along / 20) < 1.5, `mean long/short ${(along / 20).toFixed(2)} m`);
});
