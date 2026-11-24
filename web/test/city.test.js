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
