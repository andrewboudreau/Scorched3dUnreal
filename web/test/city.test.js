import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { City, CITY } from '../src/core/city.js';
import { Heightfield } from '../src/core/terrain.js';
import { simulateShot, launchVelocity, SIM_DT } from '../src/core/ballistics.js';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { TANK, driveStep, planHop, findSpot, muzzleOrigin } from '../src/core/tank.js';

// The City world: a street grid of buildings that stop shells, wear down
// under blasts, collapse into rubble and keep tanks out.

const city = (seed, n = 4, extra = {}) => {
  const g = new Game({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, ai: 'normal' })), rounds: 2, seed, resolution: 128, world: 'city', twists: false, ...extra });
  g.start();
  return g;
};

// A flat field with buildings of our own: [x, z, hx, hz, floors].
function lot(specs) {
  const t = new Heightfield({ size: 800, resolution: 64 });
  t.generate({ seed: 1, amplitude: 0 });
  const c = new City(t);
  c.buildings = specs.map(([x, z, hx, hz, floors], id) => ({
    id, box: true, x, z, hx, hz, base: 0, top: 0, floors0: floors, floors, hp: 200, maxHp: 200,
    style: 0, tint: 0, seed: 1, broken: false, collapsed: false, hits: [],
  }));
  for (const b of c.buildings) c.seat(b);
  c.index();
  t.city = c;
  return { t, c };
}

const shape = (g) => g.town.buildings.map((b) => [b.x, b.z, b.hx, b.hz, b.floors0, b.base, b.style].map((v) => Math.round(v * 1000)));

test('city: the same seed lays out the same town; every tank starts in a park', () => {
  for (const seed of [1, 9, 33]) {
    const a = city(seed);
    const b = city(seed);
    assert.ok(a.town && a.terrain.city === a.town);
    assert.deepEqual(shape(a), shape(b));
    assert.deepEqual(Array.from(a.terrain.heights), Array.from(b.terrain.heights));
    assert.deepEqual(a.town.traffic.vehicles.map((v) => [v.kind, v.a, v.b]), b.town.traffic.vehicles.map((v) => [v.kind, v.a, v.b]));
    assert.ok(a.town.buildings.length > 80, `${a.town.buildings.length} buildings`);
    const tall = a.town.buildings.map((k) => k.top - k.base);
    assert.ok(Math.max(...tall) >= 30 && Math.max(...tall) <= 46, `tallest ${Math.max(...tall)}`);
    assert.ok(Math.min(...tall) <= 9, `lowest ${Math.min(...tall)}`);
    for (const p of a.players) {
      assert.equal(a.town.near(p.x, p.z, CITY.padClear - 1).length, 0, `${p.name} has room round its pad`);
      assert.ok(!a.town.inside(p.x, p.z));
    }
    // Buildings stand between the tanks: most straight lines from one turret to another meet a wall.
    let blocked = 0, pairs = 0;
    for (const p of a.players) {
      for (const q of a.players) {
        if (p === q) continue;
        pairs++;
        if (a.town.contact([p.x, p.y + 3, p.z], [q.x, q.y + 3, q.z])) blocked++;
      }
    }
    assert.ok(blocked / pairs > 0.6, `${blocked}/${pairs} lines of fire blocked`);
  }
  assert.notDeepEqual(shape(city(1)), shape(city(2)));
});

test('city: a meadow or isles game has no town', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 3, resolution: 64 });
  g.start();
  assert.equal(g.town, null);
  assert.ok(!g.terrain.city);
  assert.equal(g.city, false);
});

test('city: a shell stops at a wall or a roof, and the trial shots see it too', () => {
  const { t, c } = lot([[0, 0, 10, 10, 10]]);
  const wallX = -10;
  const y = c.buildings[0].base + 12;
  // Flat and fast at the west wall, 12 m up.
  const shot = simulateShot({ pos: [-80, y, 0], vel: [90, 0, 0], terrain: t, gravity: 0.001 });
  assert.equal(shot.kind, 'ground');
  assert.equal(shot.point.building, 0);
  assert.ok(Math.abs(shot.point[0] - wallX) < 0.01, `struck at x ${shot.point[0]}`);
  assert.ok(Math.abs(shot.point[1] - y) < 0.5);
  // Straight down onto the roof.
  const drop = simulateShot({ pos: [3, 80, 2], vel: [0, -10, 0], terrain: t });
  assert.equal(drop.point.building, 0);
  assert.ok(Math.abs(drop.point[1] - c.buildings[0].top) < 0.01);
  // Over the top it flies on.
  const over = simulateShot({ pos: [-80, c.buildings[0].top + 6, 0], vel: [90, 0, 0], terrain: t, gravity: 0.001, maxTime: 2 });
  assert.notEqual(over.point.building, 0);
  // Once it has come down the building no longer stops anything.
  c.collapse(0);
  const through = simulateShot({ pos: [-80, y, 0], vel: [90, 0, 0], terrain: t, gravity: 0.001, maxTime: 2 });
  assert.equal(through.point.building, undefined);
});

test('city: in the game a shell goes off against a building and hurts it, not the far side', () => {
  const g = city(5, 2);
  const b = [...g.town.buildings].sort((p, q) => (q.top - q.base) - (p.top - p.base))[0];
  const y = b.base + 8;
  const hp = b.hp;
  g.spawnProjectile([b.x - b.hx - 3, y, b.z], [100, 0, 0], 'shell', 0);
  const events = [];
  for (let k = 0; k < 240 && g.projectiles.some((p) => !p.dead); k++) {
    g.stepWorld(SIM_DT);
    events.push(...g.drainEvents());
  }
  const impact = events.find((e) => e.type === 'impact');
  assert.ok(impact, 'it went off');
  assert.ok(Math.abs(impact.pos[0] - (b.x - b.hx)) < 1, `at the west wall (${impact.pos[0]} vs ${b.x - b.hx})`);
  assert.ok(b.hp < hp, 'the building took damage');
  assert.ok(g.ground.ops.some((o) => o[0] === 'b'), 'recorded in the ground ops');
  assert.ok(events.some((e) => e.type === 'building'));
});

test('city: blasts take floors off the top, then bring it down into a rubble mound', () => {
  const g = city(7, 2);
  const b = [...g.town.buildings].sort((p, q) => (q.top - q.base) - (p.top - p.base))[0];
  const top0 = b.top;
  const ground0 = g.terrain.heightAt(b.x, b.z);
  // A hit on the roof: the top storeys go at once.
  g.applyEffect({ type: 'blast', point: [b.x, b.top, b.z], radius: 11, damage: 38, depth: 0.6 }, null, null);
  assert.ok(b.top < top0, `top ${b.top} < ${top0}`);
  assert.ok(b.broken && b.floors < b.floors0);
  // Keep shelling its foot until it gives way.
  let n = 0;
  while (!b.collapsed && n++ < 40) {
    g.applyEffect({ type: 'blast', point: [b.x - b.hx, b.base + 3, b.z], radius: 14, damage: 55, depth: 0.6 }, null, null);
  }
  assert.ok(b.collapsed, `down after ${n} more blasts`);
  assert.ok(n > 1, 'a big building takes more than one blast');
  assert.ok(g.ground.ops.some((o) => o[0] === 'r' && o[1] === b.id));
  assert.ok(g.terrain.heightAt(b.x, b.z) > ground0 + 1.5, 'a heap of rubble where it stood');
  assert.ok(!g.town.standing.includes(b));
  assert.equal(g.town.contact([b.x - 60, b.base + 4, b.z], [b.x + 60, b.base + 4, b.z])?.building === b.id, false);
  // A small blast against a small shop's wall does not finish it at once.
  const shop = g.town.buildings.find((k) => !k.collapsed && k.floors0 <= 2);
  g.applyEffect({ type: 'blast', point: [shop.x + shop.hx, shop.base + 2, shop.z], radius: 6, damage: 16, depth: 0.3 }, null, null);
  assert.ok(!shop.collapsed && shop.hp < shop.maxHp);
});

test('city: snapshot and restore carry the buildings, rebuilt or not', () => {
  const a = city(11, 2);
  const tall = [...a.town.buildings].sort((p, q) => (q.top - q.base) - (p.top - p.base));
  const hit = (g, b, r = 14, d = 55) => g.applyEffect({ type: 'blast', point: [b.x + b.hx, b.base + 4, b.z], radius: r, damage: d, depth: 0.6 }, null, null);
  for (let k = 0; k < 30 && !tall[0].collapsed; k++) hit(a, tall[0]);
  hit(a, tall[1]);
  a.applyEffect({ type: 'blast', point: [tall[2].x, tall[2].top, tall[2].z], radius: 11, damage: 38, depth: 0.6 }, null, null);
  assert.ok(tall[0].collapsed && tall[2].broken);
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  // A fresh copy rebuilds the ground from the ops.
  const b = city(11, 2);
  b.restore(snap);
  assert.deepEqual(b.town.state(), a.town.state());
  assert.deepEqual(b.town.buildings.map((k) => k.top), a.town.buildings.map((k) => k.top));
  assert.equal(b.terrain.heightAt(tall[0].x, tall[0].z).toFixed(4), a.terrain.heightAt(tall[0].x, tall[0].z).toFixed(4));
  assert.ok(b.town.buildings[tall[0].id].collapsed);
  // A copy whose ground matched but whose buildings drifted is put back by the state alone.
  const c = city(11, 2);
  c.restore(snap);
  c.town.buildings[tall[1].id].hp = 1;
  c.town.buildings[tall[1].id].floors = 1;
  c.restore(snap);
  assert.deepEqual(c.town.state(), a.town.state());
  // The replay of the ops alone lands on the same state as the live game.
  const d = city(11, 2);
  d.rebuildGround(a.round, JSON.parse(JSON.stringify(a.ground)));
  assert.deepEqual(d.town.state(), a.town.state());
});

test('city: a tank cannot drive or hop into a building, or teleport into one', () => {
  const { t, c } = lot([[0, 0, 10, 8, 6]]);
  const tank = { x: -30, y: t.heightAt(-30, 0), z: 0, hull: 0, fuel: 200, alive: true };
  let r;
  let steps = 0;
  while ((r = driveStep(tank, t, 1, 0.1, c.standing)) === 'ok' && steps++ < 500);
  assert.equal(r, 'blocked');
  assert.ok(tank.x < -10 - TANK.bodyRadius + 0.5 && tank.x > -10 - TANK.bodyRadius - 2, `stopped at the wall, x ${tank.x}`);
  // Backing away is fine.
  assert.equal(driveStep(tank, t, -1, 0.1, c.standing), 'ok');
  // A hop over a six-storey building is refused.
  const hopper = { x: -22, y: t.heightAt(-22, 0), z: 0, hull: 0, fuel: 0, jets: 1, alive: true };
  const hop = planHop(hopper, t, c.standing, 0);
  assert.ok(!hop.ok || hop.x < -10 - TANK.bodyRadius, `hop lands at ${hop.x}`);
  // A Teleport onto the roof puts the tank down beside it.
  const spot = findSpot(hopper, t, c.standing, 0, 0);
  assert.ok(spot && (Math.abs(spot.x) > 10 + TANK.bodyRadius - 0.01 || Math.abs(spot.z) > 8 + TANK.bodyRadius - 0.01), `spot ${spot?.x}, ${spot?.z}`);
  // In a whole game the buildings are among the obstacles.
  const g = city(3, 2);
  assert.ok(g.obstacles().some((o) => o.box));
});

test('city: a tank drives into a blown-out corner, under what hangs over it, and back out', () => {
  const { t, c } = lot([[0, 0, 10, 10, 6]]);
  const b = c.buildings[0];
  const drive = (tank, dir = 1) => {
    let r, steps = 0;
    while ((r = driveStep(tank, t, dir, 0.1, c.standing)) === 'ok' && steps++ < 600);
    return r;
  };
  // Intact, the building is its box: a tank heading for the corner stops outside it.
  const before = { x: -30, y: 0, z: -30, hull: 45, fuel: 200, alive: true };
  assert.equal(drive(before), 'blocked');
  assert.ok(before.x < -10 && before.z < -10, `stopped outside, at ${before.x}, ${before.z}`);
  // Blow out the south-west ground corner: the floors over it hang (7 m up).
  c.blast(-10, b.base + 2, -10, 14, 55);
  assert.deepEqual(alive(b), [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const tank = { x: -30, y: 0, z: -30, hull: 45, fuel: 200, alive: true };
  assert.equal(drive(tank), 'blocked');
  assert.ok(tank.x > -10 + 4 && tank.z > -10 + 4, `parked in the gap, at ${tank.x}, ${tank.z}`);
  assert.ok(tank.x < -TANK.bodyRadius + 0.5 && tank.z < -TANK.bodyRadius + 0.5, 'clear of the standing chunks');
  // It backs out the way it came.
  assert.equal(driveStep(tank, t, -1, 0.1, c.standing), 'ok');
  // The standing chunks still stop it: along the south face, past the gap.
  const side = { x: 5, y: 0, z: -30, hull: 90, fuel: 200, alive: true };
  assert.equal(drive(side), 'blocked');
  assert.ok(side.z < -10 - TANK.bodyRadius + 0.5, `stopped at the wall, z ${side.z}`);
  // A Teleport into the gap lands there; a hop's arc may pass through it.
  const spot = findSpot(tank, t, c.standing, -5, -5);
  assert.deepEqual([spot.x, spot.z], [-5, -5]);
  const hopper = { x: -27, y: t.heightAt(-27, -27), z: -27, hull: 45, fuel: 0, jets: 1, alive: true };
  const hop = planHop(hopper, t, c.standing, 45);
  assert.ok(hop.ok && hop.x < -TANK.bodyRadius + 0.5, `hop lands at ${hop.x}, ${hop.z}`);
});

test('city: the CPU lobs over a tower between it and its target', () => {
  const { t } = lot([[0, 0, 12, 12, 11]]);   // about 39 m tall
  const shooter = { x: -45, y: t.heightAt(-45, 0), z: 0 };
  const target = [70, t.heightAt(70, 0) + 1, 0];
  const sol = solveShot({ shooter, target, wind: [0, 0], terrain: t, rng: makeRng(4), iterations: 40 });
  assert.ok(sol.predictedMiss < 4, `miss ${sol.predictedMiss}`);
  const shot = simulateShot({ pos: muzzleOrigin(shooter, sol.yaw, sol.elev), vel: launchVelocity(sol.yaw, sol.elev, sol.power), wind: [0, 0], terrain: t });
  assert.equal(shot.point.building, undefined, 'it clears the roof');
  assert.ok(sol.elev > 55, `elevation ${sol.elev}`);
});

test('city: CPUs play a round in town, and two screens agree on the buildings', () => {
  const a = city(21, 3, { maxTurnsPerRound: 4 });
  for (let k = 0; k < 30000 && a.phase !== 'roundOver' && a.phase !== 'matchOver'; k++) a.update(1 / 30);
  assert.ok(['roundOver', 'matchOver'].includes(a.phase), a.phase);
  assert.ok(a.ground.ops.length > 0);
  const b = city(21, 3, { maxTurnsPerRound: 4 });
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  assert.deepEqual(b.town.state(), a.town.state());
  assert.deepEqual(Array.from(b.terrain.heights).map((h) => h.toFixed(3)), Array.from(a.terrain.heights).map((h) => h.toFixed(3)));
});

test('city: traffic drives, keeps to the streets, and blasts wreck or scatter it', () => {
  const g = city(13, 2);
  const tr = g.town.traffic;
  const start = tr.vehicles.map((v) => [v.x, v.z]);
  for (let k = 0; k < 600; k++) tr.update(1 / 60, g.players);
  const moved = tr.vehicles.filter((v, i) => Math.hypot(v.x - start[i][0], v.z - start[i][1]) > 5).length;
  assert.ok(moved > tr.vehicles.length * 0.4, `${moved} of ${tr.vehicles.length} moved`);
  for (const v of tr.vehicles) assert.ok(!g.town.inside(v.x, v.z), 'never inside a building');
  const v = tr.vehicles.find((k) => k.alive);
  g.town.blast(v.x, v.y + 1, v.z, 11, 38);
  assert.equal(v.alive, false);
  assert.ok(v.burn > 0);
  // Traffic never goes in the snapshot.
  assert.ok(!JSON.stringify(g.snapshot()).includes('vehicles'));
});

// ---------- chunks: directional damage, gaps, falls, collapse ----------

// Which of a building's chunks stand (1) or are gone (0).
const alive = (b) => b.cells.map((v) => (v > 0 ? 1 : 0));

test('city: buildings are cut into quadrant chunks in bands of floors', () => {
  const { c } = lot([[0, 0, 10, 10, 6], [60, 0, 3.5, 10, 2], [0, 60, 15, 15, 12]]);
  const [mid, thin, tower] = c.buildings;
  assert.deepEqual([mid.nx, mid.nz, mid.bf, mid.nb], [2, 2, 2, 3]);
  assert.deepEqual([thin.nx, thin.nz, thin.bf, thin.nb], [1, 2, 1, 2]);
  assert.deepEqual([tower.nx, tower.nz, tower.bf, tower.nb], [2, 2, 3, 4]);
  // Lower chunks carry more, so they take more.
  assert.ok(tower.cellMax[0] > tower.cellMax[tower.cells.length - 1]);
  assert.equal(mid.hp, mid.maxHp);
  assert.equal(mid.lost, 0);
});

test('city: a hit on a corner takes that corner only', () => {
  const { c } = lot([[0, 0, 10, 10, 6]]);
  const b = c.buildings[0];
  // A big blast at the foot of the south-west corner.
  c.blast(-10, b.base + 2, -10, 14, 55);
  assert.deepEqual(alive(b), [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'only the ground corner went');
  assert.ok(!c.failing(b) && b.top === b.base + 6 * CITY.floor + CITY.parapet);
  // A shell on the roof's north-east corner takes the top of that corner.
  c.blast(10, b.top, 10, 11, 38);
  assert.equal(b.cells[11], 0, 'the top north-east chunk');
  assert.equal(alive(b).reduce((s, v) => s + v, 0), 10, 'and nothing else');
  // A hit on the middle of a side takes that side's chunks, not the far side's.
  const { c: c2 } = lot([[0, 0, 10, 10, 6]]);
  const s = c2.buildings[0];
  c2.blast(0, s.base + 10, -10, 14, 55);
  assert.deepEqual(alive(s).slice(4, 8), [0, 0, 1, 1], 'the south half of the middle band');
  assert.ok(c2.events.some((e) => e.how === 'chunks' && e.lost.includes(4) && e.lost.includes(5)));
});

test('city: a shell flies through a gap blown in a building and stops at what stands', () => {
  const { t, c } = lot([[0, 0, 10, 10, 6]]);
  const b = c.buildings[0];
  const y = b.base + 10;   // the middle band
  c.blast(0, y, -10, 14, 55);   // a hole through the south half of the middle band
  assert.equal(b.cells[4] + b.cells[5], 0);
  assert.ok(!c.failing(b) && !b.collapsed);
  // Along the south half, at the gap's height: in one side and out the other.
  const through = simulateShot({ pos: [-80, y, -5], vel: [90, 0, 0], terrain: t, gravity: 0.001, maxTime: 1.5 });
  assert.equal(through.point.building, undefined, `stopped at ${through.point}`);
  // Along the north half the wall still stands.
  const wall = simulateShot({ pos: [-80, y, 5], vel: [90, 0, 0], terrain: t, gravity: 0.001 });
  assert.equal(wall.point.building, 0);
  assert.ok(Math.abs(wall.point[0] + 10) < 0.01);
  // Under the gap the ground floor still stops it.
  const low = simulateShot({ pos: [-80, b.base + 2, -5], vel: [90, 0, 0], terrain: t, gravity: 0.001 });
  assert.equal(low.point.building, 0);
  assert.ok(!c.inside(0, -5, y) && c.inside(0, 5, y) && c.inside(0, -5, b.base + 2));
});

test('city: a chunk with nothing under it falls, unless its neighbours hold it', () => {
  // A twelve-storey tower: four bands of three floors.
  const { c } = lot([[0, 0, 15, 15, 12]]);
  const b = c.buildings[0];
  b.cells[0] = 1;   // the south-west foot, all but gone
  c.blast(-15, b.base + 1, -15, 6, 16);
  const col = (k) => [k, k + 4, k + 8, k + 12].map((j) => (b.cells[j] > 0 ? 1 : 0));
  assert.deepEqual(col(0), [0, 0, 0, 0], 'three bands over a lost foot are too many to hang: the corner comes down');
  assert.deepEqual([col(1), col(2), col(3)], [[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]);
  const e = c.events.find((k) => k.how === 'chunks');
  assert.deepEqual(e.fell, [4, 8, 12]);
  assert.ok(!c.failing(b) && b.top > b.base + 40, 'the rest stands, at full height');
  // A six-storey building holds two bands over a lost foot (a hole).
  const { c: c2 } = lot([[0, 0, 10, 10, 6]]);
  const m = c2.buildings[0];
  m.cells[1] = 1;
  const fallen = c2.blast(10, m.base + 1, -10, 6, 16);
  assert.equal(fallen.heaps.length, 0);
  assert.deepEqual(alive(m), [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'it hangs over the gap');
  // Take a neighbour's foot too and neither holds the other: with no foot
  // under either column, one neighbour is not enough, so the east side falls
  // into the street (a heap of debris for each column) and the west half stands.
  m.cells[3] = 1;
  const f2 = c2.blast(10, m.base + 1, 10, 6, 16);
  assert.equal(f2.heaps.length, 2);
  assert.equal(m.cells[5] + m.cells[9] + m.cells[7] + m.cells[11], 0, 'the east columns fell');
  const h = f2.heaps[0];
  assert.ok(Math.abs(h.x) > m.hx && Math.abs(h.z) > m.hz, `the heap lands outside, at ${h.x}, ${h.z}`);
  assert.ok(!f2.includes(m.id) && !c2.failing(m), 'half its ground floor is not enough to bring it down');
  // A third foot is.
  m.cells[0] = 1;
  assert.ok(c2.blast(-10, m.base + 1, -10, 6, 16).includes(m.id));
});

test('city: a hole holds the floors above it on one sound neighbour, until a second hit wears it', () => {
  // Ten storeys: bands of three floors, three, three and one.
  const { c } = lot([[0, 0, 12, 12, 10]]);
  const b = c.buildings[0];
  // Knock the south half of the second band out by hand and let it settle:
  // the floors above hang off the north half (one neighbour each, the chunk
  // across the corner standing), over a foot that still stands.
  b.cells[4] = b.cells[5] = 0;
  c.settle(b, [], 0, -20);
  c.refresh(b);
  assert.deepEqual(alive(b), [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  // Worn below CITY.sound, the north half lets go at the next blast that reaches it.
  b.cells[10] = b.cells[11] = b.cellMax[10] * CITY.sound * 0.9;
  const fallen = c.blast(0, b.base + 30, b.hz + 5, 6, 8);   // a small blast off the north side: no chunk lost
  const e = c.events.find((k) => k.how === 'chunks');
  assert.ok(e && e.lost.length === 0 && e.fell.length === 4, `fell ${e?.fell}`);
  assert.equal(fallen.heaps.length, 2);
  assert.deepEqual(alive(b).slice(8), [0, 0, 1, 1, 0, 0, 1, 1]);
  // A cantilever over a lost foot is not a hole: one neighbour does not hold it.
  const { c: c3 } = lot([[0, 0, 12, 12, 10]]);
  const t3 = c3.buildings[0];
  t3.cells[0] = t3.cells[1] = 0;
  c3.settle(t3, [], 0, -20);
  assert.deepEqual(alive(t3).filter((v, k) => k % 4 < 2), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('city: a Breacher into a tall facade punches a hole; a second one nearby drops what hangs', () => {
  for (const [hx, hz, floors, drops] of [[11, 10, 7, true], [12, 12, 10, true], [15, 15, 10, false]]) {
    const { c } = lot([[0, 0, hx, hz, floors]]);
    const b = c.buildings[0];
    const y = b.base + (b.top - b.base) * 0.5;
    const fallen = c.blast(0, y, -hz, 22, 70);
    assert.equal(fallen.length, 0, 'still standing');
    const per = b.nx * b.nz;
    // A gap in the south face with standing floors above it, at full height.
    const gap = b.cells.findIndex((v, k) => v <= 0 && k >= per && (k % per) < 2);
    assert.ok(gap > 0, `a hole (${alive(b)})`);
    assert.ok(b.cells.some((v, k) => v > 0 && k > gap && k % per === gap % per), `floors over it (${alive(b)})`);
    assert.equal(b.floors, floors);
    // A second Breacher, a little higher and to the side, wears down what
    // holds them, and in all but the broadest tower they come down.
    const hung = b.cells.map((v, k) => (v > 0 && k > gap && k % per === gap % per ? k : -1)).filter((k) => k >= 0);
    const down = c.blast(3, y + 3, -hz, 22, 70);
    assert.equal(down.length > 0 || hung.every((k) => b.cells[k] <= 0), drops, `${floors} floors, ${hx * 2} m: ${alive(b)}`);
  }
});

test("city: one Shell takes a shop's ground corner, not the shop; two or three bring it down", () => {
  for (const [hx, hz] of [[6, 9], [5.5, 6], [6, 10]]) {
    const { c } = lot([[0, 0, hx, hz, 2]]);
    const b = c.buildings[0];
    const fallen = c.blast(-hx, b.base + 1.5, -hz, 11, 38);
    assert.equal(fallen.length, 0, `${hx}x${hz} stands`);
    assert.equal(b.cells[0], 0, 'the ground corner is gone');
    assert.ok(b.cells[4] > 0, 'the floor over it hangs between its neighbours');
    assert.equal(alive(b).reduce((s, v) => s + v, 0), 7);
    // More shells at its foot: down in two or three.
    let n = 1;
    const feet = [[hx, -hz], [-hx, hz], [hx, hz]];
    while (!b.collapsed && n < 6) {
      const [x, z] = feet[(n - 1) % 3];
      for (const id of c.blast(x, b.base + 1.5, z, 11, 38)) c.collapse(id);
      n++;
    }
    assert.ok(b.collapsed && n >= 2 && n <= 3, `${hx}x${hz} down after ${n}`);
  }
});

test('city: losing three of four ground quadrants brings a building down, in the game too', () => {
  const g = city(17, 2);
  const b = g.town.buildings.find((k) => k.nx === 2 && k.nz === 2 && k.floors0 >= 4 && k.floors0 <= 6);
  assert.ok(b, 'a mid-rise to try it on');
  const foot = (sx, sz) => g.applyEffect({ type: 'blast', point: [b.x + sx * b.hx, b.base + 1, b.z + sz * b.hz], radius: 14, damage: 55, depth: 0.6 }, null, null);
  // One ground corner: still standing.
  foot(-1, -1);
  assert.equal(b.cells[0], 0);
  assert.ok(!b.collapsed);
  // The other on that side: the south side falls into the street, the north half stands.
  foot(1, -1);
  assert.equal(b.cells[0] + b.cells[1], 0);
  assert.ok(!b.collapsed, 'half a ground floor holds');
  // A third: down it comes, into a rubble mound.
  if (b.cells[2] > 0) foot(-1, 1);
  assert.ok(b.collapsed);
  assert.ok(g.ground.ops.some((o) => o[0] === 'r' && o[1] === b.id));
  assert.equal(g.town.contact([b.x - 60, b.base + 4, b.z], [b.x + 60, b.base + 4, b.z])?.building === b.id, false);
});

test('city: snapshot and restore carry every chunk; the ops replay to the same chunks', () => {
  const a = city(19, 2);
  const towers = [...a.town.buildings].sort((p, q) => q.floors0 - p.floors0).slice(0, 6);
  // Corners, sides and roofs, with something falling along the way.
  const hits = [];
  for (const [i, b] of towers.entries()) {
    const sx = i % 2 ? 1 : -1, sz = i % 3 ? 1 : -1;
    hits.push([b.x + sx * b.hx, b.base + 1, b.z + sz * b.hz, 14, 55]);
    hits.push([b.x + sx * b.hx, b.base + 8, b.z, 11, 38]);
    hits.push([b.x, b.top, b.z + sz * b.hz, 11, 38]);
  }
  for (const [x, y, z, r, d] of hits) a.applyEffect({ type: 'blast', point: [x, y, z], radius: r, damage: d, depth: 0.6 }, null, null);
  const cells = (g) => g.town.buildings.map((b) => b.cells.map((v) => Math.round(v * 100) / 100));
  assert.ok(a.town.buildings.some((b) => !b.collapsed && b.lost > 0), 'some stand damaged');
  assert.ok(a.ground.ops.some((o) => o[0] === 'm'), 'something fell and left debris');
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  // Restored from the snapshot (ground rebuilt from the ops).
  const b = city(19, 2);
  b.restore(snap);
  assert.deepEqual(b.town.state(), a.town.state());
  assert.deepEqual(cells(b), cells(a));
  assert.deepEqual(b.town.buildings.map((k) => k.top), a.town.buildings.map((k) => k.top));
  // A copy whose chunks drifted is put back by the state alone.
  const c = city(19, 2);
  c.restore(snap);
  const d = c.town.buildings.find((k) => !k.collapsed && k.lost > 0);
  d.cells.fill(0, 0, 2);
  c.town.refresh(d);
  c.restore(snap);
  assert.deepEqual(cells(c), cells(a));
  // The replay of the ops alone lands on exactly the same chunks and ground.
  const r = city(19, 2);
  r.rebuildGround(a.round, JSON.parse(JSON.stringify(a.ground)));
  assert.deepEqual(r.town.buildings.map((k) => k.cells), a.town.buildings.map((k) => k.cells));
  assert.deepEqual(Array.from(r.terrain.heights), Array.from(a.terrain.heights));
});

test('city: holes, worn neighbours and what they drop replay exactly from the ops and the snapshot', () => {
  const a = city(23, 2);
  const towers = [...a.town.buildings].sort((p, q) => q.floors0 - p.floors0).slice(0, 5);
  const blast = (g, x, y, z, r, d) => g.applyEffect({ type: 'blast', point: [x, y, z], radius: r, damage: d, depth: 0.7 }, null, null);
  for (const [i, b] of towers.entries()) {
    const y = b.base + (b.top - b.base) * 0.5, sz = i % 2 ? 1 : -1;
    blast(a, b.x, y, b.z + sz * b.hz, 22, 70);                  // a Breacher's hole
    blast(a, b.x + 3, y + 4, b.z + sz * b.hz, 11, 38);          // a Shell beside it
  }
  assert.ok(a.town.buildings.some((b) => !b.collapsed && b.lost > 0), 'some stand holed');
  const cells = (g) => g.town.buildings.map((b) => b.cells.map((v) => Math.round(v * 100) / 100));
  const r = city(23, 2);
  r.rebuildGround(a.round, JSON.parse(JSON.stringify(a.ground)));
  assert.deepEqual(r.town.buildings.map((k) => k.cells), a.town.buildings.map((k) => k.cells));
  assert.deepEqual(Array.from(r.terrain.heights), Array.from(a.terrain.heights));
  const s = city(23, 2);
  s.restore(JSON.parse(JSON.stringify(a.snapshot())));
  assert.deepEqual(cells(s), cells(a));
  assert.deepEqual(s.town.buildings.map((k) => k.top), a.town.buildings.map((k) => k.top));
});
