import { test } from 'node:test';
import assert from 'node:assert/strict';
import { craterDepthAt, Heightfield } from '../src/core/terrain.js';
import { muzzleDirection, launchVelocity, simulateShot, GRAVITY, rollDownhill, makeRoller, stepRoller, ROLL } from '../src/core/ballistics.js';
import { solveShot, planShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { Game, PAY } from '../src/core/game.js';
import { WEAPON_BY_ID, impactEffects, rollPart, splitVelocities } from '../src/core/weapons.js';
import { TANK, muzzleOrigin, hitSphere } from '../src/core/tank.js';

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
  const end = rollDownhill(t, [20, t.heightAt(20, 0), 0]).point;
  assert.ok(end[1] < t.heightAt(20, 0) - 5);
});

test('roller follows the surface the whole way and never outruns its limits', () => {
  const t = new Heightfield({ size: 800, resolution: 200 }).generate({ seed: 8, amplitude: 45 });
  const rng = makeRng(4);
  for (let k = 0; k < 40; k++) {
    const x = rng.range(-300, 300);
    const z = rng.range(-300, 300);
    const r = makeRoller([x, 0, z], [rng.range(-50, 50), -30, rng.range(-50, 50)], t);
    let end = null;
    let steps = 0;
    while (!end) {
      end = stepRoller(r, t);
      steps++;
      near(r.pos[1], t.heightAt(r.pos[0], r.pos[2]) + ROLL.radius, 1e-6, 'rides the ground');
      assert.ok(t.inBounds(r.pos[0], r.pos[2]));
    }
    assert.ok(r.dist <= ROLL.maxDistance + 1 && r.time <= ROLL.maxTime + 0.1, `ended by ${end} after ${steps} steps`);
  }
});

test('roller: stays put on flat ground, carries momentum, settles in a bowl', () => {
  const flat = flatField(0);
  const still = rollDownhill(flat, [10, 0, 10]);
  assert.equal(still.end, 'stopped');
  assert.ok(still.dist < 0.5, 'no slope and no speed: it stays where it landed');
  const pushed = rollDownhill(flat, [0, 0, 0], [40, -20, 0]);
  assert.equal(pushed.end, 'stopped');
  assert.ok(pushed.point[0] > 8 && pushed.point[0] < 80, `rolled on ${pushed.point[0]} m in its direction of travel`);
  near(pushed.point[2], 0, 1e-6);

  const bowl = flatField(0);
  bowl.carveCrater(0, 0, 0, 60, 0.5);
  const down = rollDownhill(bowl, [35, bowl.heightAt(35, 0), 0]);
  assert.ok(Math.hypot(down.point[0], down.point[2]) < 12, `came to rest near the bottom, at ${down.point[0]}`);
  assert.ok(down.dist > 25);
});

test('a fired roller rolls downhill into a tank and detonates there', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 3, resolution: 160 });
  g.start();
  g.scenery.clear();
  g.terrain.heights.fill(0);
  g.terrain.raiseMound(0, 0, 120, 40);
  const [a, b] = g.players;
  Object.assign(a, { x: -300, z: 0, y: 0 });
  Object.assign(b, { x: 85, z: 0, y: g.terrain.heightAt(85, 0) });
  g.drainEvents();
  g.phase = 'flight';
  g.spawnProjectile([45, g.terrain.heightAt(45, 0) + 6, 0], [12, -4, 0], 'roller', a.id);
  let onGround = 0;
  for (let i = 0; i < 3000 && g.projectiles.length; i++) {
    g.stepWorld(1 / 120);
    const pr = g.projectiles[0];
    if (pr && pr.roller) {
      onGround++;
      near(pr.pos[1], g.terrain.heightAt(pr.pos[0], pr.pos[2]) + ROLL.radius, 1e-6, 'shell follows the ground');
    }
  }
  const ev = g.drainEvents();
  const start = ev.find((e) => e.type === 'rollStart');
  const boom = ev.find((e) => e.type === 'explosion');
  assert.ok(start && boom, 'it rolled, then exploded');
  assert.ok(ev.indexOf(start) < ev.indexOf(boom));
  assert.ok(onGround > 60, `spent ${onGround} steps rolling`);
  assert.ok(Math.hypot(boom.pos[0] - start.pos[0], boom.pos[2] - start.pos[2]) > 20, 'travelled before detonating');
  assert.ok(Math.hypot(boom.pos[0] - b.x, boom.pos[2] - b.z) < TANK.hitRadius + ROLL.radius + 0.5, 'went off against the tank');
  assert.ok(b.hp < TANK.maxHp - 40, 'a contact hit does full damage');
  assert.equal(a.hp, TANK.maxHp);
});

// ---- M3: weapons ----

test('composed weapons expand into the expected effects', () => {
  const t = flatField(0);
  const shell = impactEffects(WEAPON_BY_ID.shell, [0, 0, 0]);
  assert.deepEqual(shell.map((e) => e.type), ['blast']);
  assert.equal(rollPart(WEAPON_BY_ID.shell), null);
  // A roller rolls first (the game steps that), then blasts where it ends up.
  assert.ok(rollPart(WEAPON_BY_ID.roller));
  assert.deepEqual(impactEffects(WEAPON_BY_ID.roller, [0, 0, 0]).map((e) => e.type), ['blast']);
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
    const sol = solveShot({ shooter, target, wind, terrain: t, rng: makeRng(k) });
    const shot = simulateShot({
      pos: muzzleOrigin(shooter, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), wind, terrain: t,
    });
    const miss = Math.hypot(shot.point[0] - tx, shot.point[2] - tz);
    assert.ok(sol.predictedMiss < 4, `solver converged to ${sol.predictedMiss} m on case ${k}`);
    if (miss < 10) within++;
  }
  assert.ok(within >= cases - 1, `hard AI landed within 10 m on ${within}/${cases}`);
});

// Fire `shots` successive CPU shots at one target and report each miss in metres.
function walkIn(difficulty, cases, shots, between = () => {}) {
  const rng = makeRng(77);
  const out = [];
  for (let k = 0; k < cases; k++) {
    const t = new Heightfield({ size: 800, resolution: 96 }).generate({ seed: 200 + (k % 8), amplitude: 45 });
    const a = rng.range(0, Math.PI * 2);
    const b = a + Math.PI + rng.range(-1, 1);
    const shooter = { id: 0, x: Math.cos(a) * 260, z: Math.sin(a) * 260 };
    const target = { id: 1, x: Math.cos(b) * 260, z: Math.sin(b) * 260 };
    shooter.y = t.heightAt(shooter.x, shooter.z);
    target.y = t.heightAt(target.x, target.z);
    const world = { wind: [rng.range(-1, 1), rng.range(-1, 1)], target, terrain: t, rng };
    const memory = {};
    const misses = [];
    for (let s = 0; s < shots; s++) {
      between(s, world);
      const sol = planShot({ shooter, target, wind: world.wind, terrain: t, rng, difficulty, memory });
      const shot = simulateShot({
        pos: muzzleOrigin(shooter, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power),
        wind: world.wind, terrain: t, targets: [hitSphere(target)],
      });
      misses.push(Math.min(200, Math.hypot(shot.point[0] - target.x, shot.point[2] - target.z)));
    }
    out.push(misses);
  }
  return out;
}

const HIT = 12; // metres: close enough for a plain shell to do real damage
const hitRate = (runs, s) => runs.filter((m) => m[s] < HIT).length / runs.length;
const hitBy = (runs, s) => runs.filter((m) => m.slice(0, s + 1).some((x) => x < HIT)).length / runs.length;
const meanMiss = (runs, s) => runs.reduce((sum, m) => sum + m[s], 0) / runs.length;

test('normal CPU misses its first shot and walks the next few in', () => {
  const runs = walkIn('normal', 120, 5);
  assert.ok(hitRate(runs, 0) < 0.2, `first-shot hit rate ${hitRate(runs, 0)}`);
  assert.ok(meanMiss(runs, 0) > 25, `first shot misses by ${meanMiss(runs, 0)} m on average`);
  assert.ok(meanMiss(runs, 1) < meanMiss(runs, 0) * 0.7 && meanMiss(runs, 2) < meanMiss(runs, 1) * 0.8, 'each shot is closer');
  assert.ok(hitRate(runs, 1) > hitRate(runs, 0) && hitRate(runs, 2) > hitRate(runs, 1), 'hit rate climbs');
  assert.ok(hitBy(runs, 3) > 0.8, `has hit by its fourth shot in ${hitBy(runs, 3)} of cases`);
  const firstOn2to4 = hitBy(runs, 3) - hitBy(runs, 0);
  assert.ok(firstOn2to4 > 0.65, `first hit comes on shots 2-4 in ${firstOn2to4} of cases`);
});

test('easy is wilder than normal, hard is sharp but not perfect first time', () => {
  const easy = walkIn('easy', 100, 4);
  const normal = walkIn('normal', 100, 4);
  const hard = walkIn('hard', 100, 4);
  for (let s = 0; s < 4; s++) {
    assert.ok(meanMiss(easy, s) > meanMiss(normal, s) && meanMiss(normal, s) > meanMiss(hard, s), `shot ${s + 1} ordering`);
  }
  assert.ok(hitBy(easy, 3) < 0.5, `easy has hit by shot four in ${hitBy(easy, 3)} of cases`);
  assert.ok(hitRate(hard, 0) < 0.5, `hard first-shot hit rate ${hitRate(hard, 0)}`);
  assert.ok(hitBy(hard, 1) > 0.75, `hard has hit by shot two in ${hitBy(hard, 1)} of cases`);
});

test('CPU aim is upset again when the target moves or the wind swings', () => {
  const steady = walkIn('normal', 100, 6);
  const moved = walkIn('normal', 100, 6, (s, w) => {
    if (s !== 5) return;
    w.target.x += 25;
    w.target.y = w.terrain.heightAt(w.target.x, w.target.z);
  });
  const gusty = walkIn('normal', 100, 6, (s, w) => { if (s === 5) w.wind = [w.wind[0] + 1.5, w.wind[1] - 1.5]; });
  assert.ok(meanMiss(moved, 5) > meanMiss(steady, 5) * 2, `moved target: ${meanMiss(moved, 5)} vs ${meanMiss(steady, 5)}`);
  assert.ok(meanMiss(gusty, 5) > meanMiss(steady, 5) * 2, `wind swing: ${meanMiss(gusty, 5)} vs ${meanMiss(steady, 5)}`);
  assert.ok(meanMiss(moved, 5) < meanMiss(moved, 0), 'but it does not start from scratch');
});

// ---- scenery ----

function seated(g) {
  const sc = g.scenery;
  const t = g.terrain;
  for (const p of sc.props) {
    if (p.state === 'gone') continue;
    near(p.y, sc.seat(p), 1e-4, `${p.kind} (${p.state}) rests on the ground;`);
    if (p.kind !== 'rock') assert.ok(t.heightAt(p.x, p.z) >= t.waterLevel - 0.4, `${p.kind} is not under water`);
  }
  for (const w of sc.walkers) if (w.alive) near(w.y, t.heightAt(w.x, w.z), 1e-4, `${w.kind} stands on the ground;`);
}

test('scenery: modest counts, seated, dry, and clear of the tanks', () => {
  const four = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
  for (const seed of [11, 12, 13]) {
    const g = new Game({ players: four, rounds: 1, seed, resolution: 128 });
    g.start();
    const sc = g.scenery;
    const count = (k) => sc.props.filter((p) => p.kind === k).length;
    assert.ok(count('pine') + count('oak') > 80 && sc.props.length < 800, `${sc.props.length} props`);
    assert.ok(count('house') >= 2 && count('house') <= 18, `${count('house')} houses`);
    assert.ok(sc.walkers.length <= 40);
    seated(g);
    for (const p of sc.props) {
      for (const k of g.players) {
        const d = Math.hypot(p.x - k.x, p.z - k.z);
        assert.ok(d >= (p.kind === 'house' ? 30 : 18), `${p.kind} ${d.toFixed(1)} m from a tank`);
      }
    }
    for (const k of g.players) assert.ok(k.y > g.terrain.waterLevel + 3, 'tanks start on dry ground');
    const again = new Game({ players: four, rounds: 1, seed, resolution: 128 });
    again.start();
    assert.equal(again.scenery.props.length, sc.props.length, 'same seed, same scenery');
  }
});

test('scenery: craters clear, topple and re-seat props; nothing floats or is buried', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 31, resolution: 128 });
  g.start();
  const sc = g.scenery;
  const tree = sc.props.find((p) => p.kind === 'oak' || p.kind === 'pine');
  const house = sc.props.find((p) => p.kind === 'house');
  g.applyEffect({ type: 'blast', point: [tree.x, tree.y, tree.z], radius: 11, damage: 0, depth: 0.6 }, 0, null);
  assert.equal(tree.state, 'gone', 'a tree at ground zero is gone');
  g.applyEffect({ type: 'blast', point: [house.x + 9, house.y, house.z], radius: 11, damage: 0, depth: 0.6 }, 0, null);
  assert.equal(house.state, 'ruin', 'a house beside a blast is wrecked');
  assert.ok(g.drainEvents().some((e) => e.type === 'prop' && e.kind === 'house' && e.how === 'ruin'));
  seated(g);

  const rng = makeRng(9);
  for (let k = 0; k < 90; k++) {
    // Half the shots are aimed at something, so props really are in the way.
    const at = k % 2 ? sc.props[rng.int(0, sc.props.length - 1)] : { x: rng.range(-380, 380), z: rng.range(-380, 380) };
    const x = at.x + rng.range(-8, 8);
    const z = at.z + rng.range(-8, 8);
    const y = g.terrain.heightAt(x, z);
    if (k % 5 === 0) g.applyEffect({ type: 'mound', point: [x, y, z], radius: 20, height: 14 }, 0, null);
    else g.applyEffect({ type: 'blast', point: [x, y, z], radius: rng.range(10, 22), damage: 0, depth: 0.65 }, 0, null);
    g.scenery.update(0.5, g.players);
    seated(g);
  }
  const left = sc.props.filter((p) => p.state !== 'gone');
  assert.ok(left.length < sc.props.length - 20, 'the bombardment cleared a fair number');
  assert.ok(left.some((p) => p.state === 'fallen'), 'and knocked some trees over');
});

test('scenery: blasting or burying the bridge brings it down', () => {
  let tested = 0;
  for (let seed = 40; seed < 60 && tested < 2; seed++) {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed, resolution: 128 });
    g.start();
    const b = g.scenery.bridge;
    if (!b) continue;
    const mid = [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2];
    const y = g.terrain.heightAt(mid[0], mid[1]);
    assert.ok(y < b.y - 0.5, 'the deck clears what it spans');
    if (tested === 0) g.applyEffect({ type: 'blast', point: [mid[0], y, mid[1]], radius: 11, damage: 0, depth: 0.6 }, 0, null);
    else g.applyEffect({ type: 'mound', point: [mid[0], y, mid[1]], radius: 20, height: 14 }, 0, null);
    assert.equal(b.alive, false);
    tested++;
  }
  assert.equal(tested, 2, 'found maps with a bridge');
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

test('everyone is paid a stipend at the end of a round, so nobody shops empty-handed', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 2, seed: 6, resolution: 64 });
  g.start();
  g.players[1].alive = false;
  g.endRound();
  assert.equal(g.players[1].money, PAY.stipend);
  assert.equal(g.players[0].money, PAY.stipend + PAY.survive + PAY.roundWin);
  assert.ok(g.buy(1, 'roller'), 'the loser can still afford something');
});
