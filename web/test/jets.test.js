import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightfield } from '../src/core/terrain.js';
import { Game } from '../src/core/game.js';
import { TANK, JET, planHop, findSpot } from '../src/core/tank.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS, impactEffects, splitVelocities } from '../src/core/weapons.js';
import { planJump, holeDepth } from '../src/core/ai.js';

const DEG = Math.PI / 180;

function flatField(h = 20, size = 800) {
  const t = new Heightfield({ size, resolution: 200 });
  t.heights.fill(h);
  return t;
}
const tankAt = (x, z, hull = 0) => ({ x, y: 20, z, hull, alive: true });

// A started two-tank game on bare flat ground, the tanks well apart.
function arena(players = [{ name: 'A' }, { name: 'B' }], extra = {}) {
  const g = new Game({ players, rounds: 3, seed: 11, resolution: 128, twists: false, ...extra });
  g.start();
  g.terrain.heights.fill(20);
  g.terrain.waterLevel = -Infinity;
  g.scenery.props.length = 0;
  g.players.forEach((p, i) => { p.x = -200 + i * 140; p.z = 0; p.y = 20; });
  return g;
}

function run(g, stop, limit = 20000) {
  const events = [];
  for (let k = 0; k < limit && !stop(g); k++) {
    g.update(1 / 30);
    events.push(...g.drainEvents());
  }
  assert.ok(stop(g), 'the game got there');
  return events;
}

// ---- the hop itself ----

test('jet hop: 25 m along the hull on open ground, the same every time', () => {
  const t = flatField();
  for (const hull of [0, 90, 37, 215]) {
    const a = planHop(tankAt(0, 0, hull), t, [], hull);
    const b = planHop(tankAt(0, 0, hull), t, [], hull);
    assert.deepEqual(a, b);
    assert.ok(a.ok);
    assert.ok(Math.abs(a.x - Math.cos(hull * DEG) * JET.distance) < 1e-9);
    assert.ok(Math.abs(a.z - Math.sin(hull * DEG) * JET.distance) < 1e-9);
    assert.equal(a.y, 20);
  }
});

test('jet hop: gets out of a crater whose walls a tank could not climb', () => {
  const t = flatField();
  t.carveCrater(0, 20, 0, 14, 0.8);              // about 11 m deep
  const floor = t.heightAt(0, 0);
  assert.ok(floor < 10);
  const tank = { x: 0, y: floor, z: 0, hull: 0, alive: true };
  const hop = planHop(tank, t, []);
  assert.ok(hop.ok && hop.dist === JET.distance);
  assert.ok(Math.abs(hop.y - 20) < 0.01, 'lands up on the rim level');
  assert.ok(hop.x > 14, 'past the crater rim');
});

test('jet hop: a wall in the way shortens or refuses the hop', () => {
  const t = flatField();
  // A rampart 60 m tall across x 6..14: the arc (10 m up) cannot clear it, and no hop lands on top.
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) if (t.vx(i) >= 6 && t.vx(i) <= 14) t.heights[j * t.n + i] = 80;
  const tank = tankAt(0, 0, 0);
  const hop = planHop(tank, t, []);
  assert.equal(hop.ok, false);
  assert.equal(hop.why, 'blocked');
  // The other way is open.
  assert.ok(planHop(tank, t, [], 180).ok);
});

test('jet hop: stays inside the arena, shortening the hop at the edge', () => {
  const t = flatField();
  const edge = t.half - 6;
  const near = planHop(tankAt(edge - 10, 0, 0), t, []);
  assert.ok(near.ok && near.dist < JET.distance, 'a shorter hop fits');
  assert.ok(near.x <= edge);
  const against = planHop(tankAt(edge - 1, 0, 0), t, []);
  assert.equal(against.ok, false);
  assert.equal(against.why, 'edge');
  // Inward is fine from the same spot.
  assert.ok(planHop(tankAt(edge - 1, 0, 180), t, []).ok);
});

test('jet hop: never lands in water', () => {
  const t = flatField();
  t.waterLevel = 5;
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) if (t.vx(i) > 22) t.heights[j * t.n + i] = 0;
  const hop = planHop(tankAt(0, 0, 0), t, []);
  assert.ok(hop.ok, 'a shorter hop reaches the shore');
  assert.ok(hop.dist < JET.distance);
  assert.ok(t.heightAt(hop.x, hop.z) >= t.waterLevel + 0.3);
  // Nothing dry within reach at all: refused.
  const t2 = flatField();
  t2.waterLevel = 30;
  assert.deepEqual(planHop(tankAt(0, 0, 0), t2, []), { ok: false, why: 'water' });
});

test('jet hop: keeps clear of other tanks and standing houses, and ignores wrecks', () => {
  const t = flatField();
  const me = tankAt(0, 0, 0);
  const foe = { x: 25, z: 0, alive: true };
  const hop = planHop(me, t, [me, foe]);
  assert.ok(hop.ok && hop.dist < JET.distance);
  assert.ok(Math.hypot(foe.x - hop.x, foe.z - hop.z) >= TANK.bodyRadius * 2);
  const house = { kind: 'house', x: 25, z: 0, state: 'ok' };
  const h2 = planHop(me, t, [house]);
  assert.ok(h2.ok && h2.dist < JET.distance);
  assert.equal(planHop(me, t, [{ x: 25, z: 0, alive: false }]).dist, JET.distance);
  // Boxed in all the way along.
  const wall = [25, 20, 16, 12, 8].map((d) => ({ x: d, z: 0, alive: true }));
  assert.deepEqual(planHop(me, t, wall), { ok: false, why: 'blocked' });
});

// ---- charges and the game's path ----

test('jump jets: one charge to start, spent by a hop, and a hop costs no fuel or shot', () => {
  const g = arena();
  const me = g.current;
  assert.equal(me.jets, 1);
  assert.ok(g.players.every((p) => p.jets === 1));
  const fuel = me.fuel;
  const ammo = { ...me.inventory };
  const x = me.x;
  g.drainEvents();
  assert.equal(g.jump(), 'ok');
  assert.equal(me.jets, 0);
  assert.equal(me.fuel, fuel);
  assert.deepEqual(me.inventory, ammo);
  assert.equal(g.phase, 'aim', 'still your turn to aim and fire');
  const hop = g.drainEvents().find((e) => e.type === 'jump');
  assert.ok(hop && hop.player === me.id && hop.flight === JET.flight);
  assert.ok(Math.hypot(me.x - x, 0) > 5);
  assert.deepEqual(hop.to, [me.x, me.y, me.z]);
  assert.equal(me.y, g.terrain.heightAt(me.x, me.z));
  // Out of charges: refused, nothing moves.
  const at = [me.x, me.z];
  assert.equal(g.jump(), 'nojets');
  assert.deepEqual([me.x, me.z], at);
  assert.equal(me.jets, 0);
});

test('jump jets: only the planning human can use them, and the shop sells two for 80', () => {
  const g = arena([{ name: 'A' }, { name: 'B', ai: 'normal' }]);
  const jet = ITEMS.find((i) => i.id === 'jet');
  assert.equal(jet.price, 80);
  assert.equal(jet.bundle, 2);
  const a = g.players[0];
  assert.equal(g.current.id, 0);
  g.phase = 'roundOver';
  g.openShop();
  a.money = 100;
  assert.ok(g.buy(0, 'jet'));
  assert.equal(a.jets, 3, 'one carried over, two bought');
  assert.equal(a.money, 20);
  assert.equal(g.buy(0, 'jet'), false, 'cannot afford a second');
  assert.equal(a.jets, 3);
  // Charges carry into the next round: they are not refilled.
  a.jets = 0;
  g.closeShop();
  assert.equal(a.jets, 0);
});

test('jump jets: a CPU turn cannot be jumped for by a human, and a refusal names why', () => {
  const g = arena([{ name: 'A', ai: 'normal' }, { name: 'B' }], { firing: 'volley' });
  g.phase = 'aim';
  g.turn = 0;
  assert.equal(g.jump(), 'idle', 'a CPU go');
  assert.equal(g.players[0].jets, 1);
  const h = g.players[1];
  h.jets = 1;
  const edge = g.terrain.half - 6;
  h.x = edge - 0.5; h.hull = 0;
  g.phase = 'aim';
  g.turn = 1;
  assert.equal(g.jump(), 'edge');
  assert.equal(h.jets, 1, 'a refused hop keeps the charge');
});

test('jump jets: two games given the same moves hop to the same place', () => {
  const play = () => {
    const g = arena();
    const me = g.current;
    me.hull = 33;
    g.jump();
    me.hull = 200;
    me.jets = 1;
    g.jump();
    return JSON.stringify([me.x, me.y, me.z, me.jets, g.players[1].x]);
  };
  assert.equal(play(), play());
});

// ---- the CPU's rule ----

test('CPU jet rule: hops out of a hole, not out of open ground, never on easy or without a charge', () => {
  const t = flatField();
  t.carveCrater(0, 20, 0, 16, 0.9);
  const floor = t.heightAt(0, 0);
  const me = { x: 0, y: floor, z: 0, hull: 0, fuel: 0, jets: 1, alive: true };
  const tryHop = (heading) => planHop(me, t, [], heading);
  assert.ok(holeDepth(t, me.x, me.z, me.y) > 4);
  const go = planJump({ me, terrain: t, difficulty: 'normal', tryHop });
  assert.ok(go && go.jump && go.budget === 0);
  const end = planHop(me, t, [], go.heading);
  assert.ok(holeDepth(t, end.x, end.z, end.y) < holeDepth(t, me.x, me.z, me.y) - 3, 'lands somewhere clearly less of a hole');
  assert.equal(planJump({ me: { ...me, jets: 0 }, terrain: t, difficulty: 'normal', tryHop }), null);
  assert.equal(planJump({ me, terrain: t, difficulty: 'easy', tryHop }), null);
  const open = { ...me, y: 20, x: 200 };
  assert.equal(planJump({ me: open, terrain: t, difficulty: 'hard', tryHop: (h) => planHop(open, t, [], h) }), null);
});

test('CPU jet rule: a CPU stuck in a hole with no fuel uses its jet during its go, then shoots', () => {
  const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 3, seed: 11, resolution: 128, twists: false, firing: 'volley' });
  g.start();
  g.terrain.heights.fill(20);
  g.terrain.waterLevel = -Infinity;
  g.scenery.props.length = 0;
  const [a, b] = g.players;
  a.x = -150; a.z = 0; b.x = 150; b.z = 0;
  g.terrain.carveCrater(a.x, 20, a.z, 18, 0.9);
  a.y = g.terrain.heightAt(a.x, a.z);
  a.fuel = 0;
  const before = holeDepth(g.terrain, a.x, a.z, a.y);
  assert.ok(before > 4);
  const go = g.aiWantsToDrive(a);
  assert.ok(go && go.jump);
  g.beginTurn(a.id, go);
  const events = run(g, (q) => !q.aiDrive);
  assert.equal(events.filter((e) => e.type === 'jump').length, 1);
  assert.equal(a.jets, 0);
  assert.ok(holeDepth(g.terrain, a.x, a.z, a.y) < before - 3, 'out of the hole');
  assert.equal(a.fuel, 0);
});

test('CPU shopping: buys jets and flak once it has the money', () => {
  const g = arena([{ name: 'A', ai: 'normal' }, { name: 'B' }]);
  const a = g.players[0];
  a.money = 2000;
  a.jets = 0;
  a.inventory.flak = 0;
  g.aiShop(a);
  assert.ok(a.inventory.flak >= 2);
  assert.ok(a.jets >= 2);
});

// ---- Teleport ----

test('teleport: weapon data and the warp part', () => {
  const w = WEAPON_BY_ID.teleport;
  assert.equal(w.price, 120);
  assert.equal(w.bundle, 2);
  assert.deepEqual(impactEffects(w, [5, 6, 7]), [{ type: 'warp', point: [5, 6, 7] }]);
  assert.ok(!w.impact.some((p) => p.type === 'blast'), 'no damage');
});

test('teleport: findSpot takes the point itself, else the nearest standable spot', () => {
  const t = flatField();
  const me = tankAt(0, 0, 0);
  assert.deepEqual(findSpot(me, t, [], 50, 40), { x: 50, y: 20, z: 40 });
  // Inside the edge margin: pulled in.
  const s = findSpot(me, t, [], 1000, 0);
  assert.equal(s.x, t.half - 6);
  // On top of another tank: nudged off, but not far.
  const foe = { x: 50, z: 40, alive: true };
  const off = findSpot(me, t, [me, foe], 50, 40);
  const d = Math.hypot(off.x - foe.x, off.z - foe.z);
  assert.ok(d >= TANK.bodyRadius * 2 && d < TANK.bodyRadius * 2 + 4);
  // In a lake: out to the shore.
  const lake = flatField();
  lake.waterLevel = 5;
  for (let j = 0; j < lake.n; j++) for (let i = 0; i < lake.n; i++) if (Math.hypot(lake.vx(i) - 100, lake.vz(j)) < 30) lake.heights[j * lake.n + i] = 0;
  const shore = findSpot(me, lake, [], 100, 0);
  assert.ok(lake.heightAt(shore.x, shore.z) >= 5.3);
  assert.ok(Math.hypot(shore.x - 100, shore.z) >= 28 && Math.hypot(shore.x - 100, shore.z) < 36);
  // Onto a standing house.
  const house = { kind: 'house', x: -80, z: 0, state: 'ok' };
  const h = findSpot(me, t, [house], -80, 0);
  assert.ok(Math.hypot(h.x + 80, h.z) >= TANK.bodyRadius * 2);
});

test('teleport: a Teleport shell moves the shooter to where it lands, no damage, a warp event', () => {
  const g = arena();
  const me = g.current;
  const foe = g.players.find((p) => p !== me);
  me.inventory.teleport = 1;
  me.weapon = 'teleport';
  me.yaw = 0; me.elev = 45; me.power = 60;
  const hp = [g.players[0].hp, g.players[1].hp];
  const from = [me.x, me.y, me.z];
  assert.ok(g.fire());
  const events = run(g, (q) => q.phase === 'aim');
  const impact = events.find((e) => e.type === 'impact');
  const warp = events.find((e) => e.type === 'warp');
  assert.ok(impact && warp);
  assert.deepEqual(warp.from, from);
  assert.ok(Math.hypot(me.x - impact.pos[0], me.z - impact.pos[2]) < 0.01, 'on the spot (it was open ground)');
  assert.equal(me.y, g.terrain.heightAt(me.x, me.z));
  assert.deepEqual(g.players.map((p) => p.hp), hp);
  assert.equal(me.inventory.teleport, 0);
  assert.equal(foe.x, -60);
  assert.ok(!events.some((e) => e.type === 'explosion'), 'no blast');
});

test('teleport: lands out of a lake, off a tank and inside the arena; a dead shooter stays dead where it is', () => {
  const g = arena();
  const [a, b] = g.players;
  g.terrain.waterLevel = 5;
  for (let j = 0; j < g.terrain.n; j++) for (let i = 0; i < g.terrain.n; i++) if (Math.hypot(g.terrain.vx(i), g.terrain.vz(j)) < 40) g.terrain.heights[j * g.terrain.n + i] = 0;
  g.applyEffect({ type: 'warp', point: [0, 0, 0] }, a.id);
  assert.ok(g.terrain.heightAt(a.x, a.z) >= 5.3, 'on dry ground');
  assert.ok(Math.hypot(a.x, a.z) >= 35);
  g.applyEffect({ type: 'warp', point: [b.x, 20, b.z] }, a.id);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= TANK.bodyRadius * 2);
  g.applyEffect({ type: 'warp', point: [5000, 0, -5000] }, a.id);
  assert.ok(Math.abs(a.x) <= g.terrain.half - 6 && Math.abs(a.z) <= g.terrain.half - 6);
  a.alive = false;
  const at = [a.x, a.z];
  g.applyEffect({ type: 'warp', point: [0, 0, 0] }, a.id);
  assert.deepEqual([a.x, a.z], at);
});

test('teleport: other shells already in flight at the old spot miss', () => {
  // B lobs a long shell onto where A stands; A fires something short in the
  // same volley. With a Teleport the shell arrives after A has gone.
  const volley = (weapon) => {
    const g = arena([{ name: 'A' }, { name: 'B' }], { firing: 'volley' });
    g.wind = [0, 0];
    const [a, b] = g.players;
    a.inventory.teleport = 1;
    run(g, (q) => q.phase === 'aim');
    const first = g.current;
    const aim = (p, yaw, elev, power, w) => { p.yaw = yaw; p.elev = elev; p.power = power; p.weapon = w; g.fire(); };
    const toward = (p, q) => ((Math.atan2(q.z - p.z, q.x - p.x) * 180) / Math.PI + 360) % 360;
    const range = Math.hypot(a.x - b.x, a.z - b.z);
    const lob = (p, q) => aim(p, toward(p, q), 70, Math.sqrt((range * g.gravity) / Math.sin((140 * Math.PI) / 180)), 'shell');
    for (let k = 0; k < 2; k++) {
      if (g.current === a) aim(a, 90, 45, 25, weapon); else lob(b, a);
      run(g, (q) => q.phase !== 'aim' || q.current !== first);
    }
    const events = run(g, (q) => q.phase === 'aim' || q.phase === 'roundOver');
    return { a, events };
  };
  const plain = volley('shell');
  assert.ok(plain.a.hp < plain.a.maxHp, 'standing still, A is hit');
  const warped = volley('teleport');
  assert.ok(warped.events.some((e) => e.type === 'warp' && e.player === warped.a.id));
  assert.equal(warped.a.hp, warped.a.maxHp, 'the old spot was empty when the shell arrived');
});

// ---- Flak ----

test('flak: data, price, and a proximity burst into 12', () => {
  const w = WEAPON_BY_ID.flak;
  const burst = w.flight.find((f) => f.type === 'airburst');
  assert.equal(w.price, 200);
  assert.equal(w.bundle, 2);
  assert.equal(burst.count, 12);
  assert.equal(burst.child, 'flaklet');
  assert.ok(WEAPON_BY_ID.flaklet.hidden);
  assert.ok(WEAPONS.filter((x) => !x.hidden).some((x) => x.id === 'flak'));
});

test('flak: the fragments cover a wide, even area around the old path', () => {
  const vel = [30, -2, 40];
  const out = splitVelocities(vel, 14, 8, 'disc');
  assert.equal(out.length, 14);
  const off = out.map((v) => [v[0] - vel[0], v[2] - vel[2]]);
  assert.ok(out.every((v) => v[1] === vel[1]), 'no sideways kick up or down');
  assert.ok(off.every(([x, z]) => Math.hypot(x, z) <= 8 + 1e-9));
  assert.ok(Math.max(...off.map(([x, z]) => Math.hypot(x, z))) > 7, 'reaches the rim');
  assert.ok(Math.min(...off.map(([x, z]) => Math.hypot(x, z))) < 3, 'and fills the middle');
  // Spread both across and along the line of flight, unlike a row.
  const u = [0.6, 0.8];
  const across = off.map(([x, z]) => -u[1] * x + u[0] * z);
  const along = off.map(([x, z]) => u[0] * x + u[1] * z);
  assert.ok(Math.max(...across) - Math.min(...across) > 12);
  assert.ok(Math.max(...along) - Math.min(...along) > 12);
  // Centred, all different, and the same twice (online copies must agree).
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(Math.abs(mean(across)) < 1.5 && Math.abs(mean(along)) < 1.5);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) assert.ok(Math.hypot(off[i][0] - off[j][0], off[i][1] - off[j][1]) > 0.5);
  assert.deepEqual(out, splitVelocities(vel, 14, 8, 'disc'));
  // A straight-up shot has no heading; it still fans out.
  assert.equal(new Set(splitVelocities([0, 0, 0], 14, 8, 'disc').map((v) => v.join())).size, 14);
  // The default is still the row Scatter uses: sideways only, nothing along the path.
  const row = splitVelocities(vel, 5, 9);
  assert.ok(row.every((v) => Math.abs(0.6 * (v[0] - 30) + 0.8 * (v[2] - 40)) < 1e-9));
  assert.ok(Math.abs(row[0][0] - 30) > 1);
});

test('flak: about the same damage in total as Scatter, in smaller, shallower pieces', () => {
  const blast = (id) => WEAPON_BY_ID[id].impact.find((p) => p.type === 'blast');
  const flakTotal = WEAPON_BY_ID.flak.flight[0].count * blast('flaklet').damage;
  const scatterTotal = 5 * blast('scatterlet').damage;
  assert.ok(Math.abs(flakTotal - scatterTotal) / scatterTotal < 0.2, `${flakTotal} vs ${scatterTotal}`);
  assert.ok(blast('flaklet').damage < blast('scatterlet').damage / 2);
  assert.ok(blast('flaklet').radius < blast('scatterlet').radius);
  assert.ok(blast('flaklet').depth < blast('scatterlet').depth / 1.5);
  assert.ok(WEAPON_BY_ID.flak.price < WEAPON_BY_ID.scatter.price);
});

test('flak: passing nobody, a fired shell bursts just over the ground into 12 fragments', () => {
  const g = arena([{ name: 'A' }, { name: 'B' }]);
  const me = g.current;
  me.inventory.flak = 2;
  me.weapon = 'flak';
  me.yaw = 0; me.elev = 55; me.power = 70;
  g.players.find((p) => p !== me).x = 0;      // out of its way: nothing here is about damage
  g.players.find((p) => p !== me).z = 380;
  assert.ok(g.fire());
  const events = run(g, (q) => q.phase === 'aim');
  const kids = events.filter((e) => e.type === 'projectile' && e.weapon === 'flaklet');
  assert.equal(kids.length, 12);
  assert.equal(me.inventory.flak, 1);
  const burst = events.find((e) => e.type === 'split');
  const above = burst.pos[1] - 20;      // the arena is flat at 20 m (before the fragments dig it)
  assert.ok(above > 8 && above <= 16.5, `burst ${above.toFixed(1)} m up`);
  const land = events.filter((e) => e.type === 'impact').map((e) => e.pos);
  assert.equal(land.length, 12);
  const cx = land.reduce((s, p) => s + p[0], 0) / 12;
  const cz = land.reduce((s, p) => s + p[2], 0) / 12;
  const radius = Math.max(...land.map((p) => Math.hypot(p[0] - cx, p[2] - cz)));
  assert.ok(radius > 3 && radius < 20, `a pattern under the burst (${radius.toFixed(1)} m)`);
  assert.equal(events.filter((e) => e.type === 'explosion').length, 12);
  // Shallow: the deepest hole is a few metres, nothing like a Breacher's.
  const deepest = 20 - Math.min(...g.terrain.heights);
  assert.ok(deepest < 4, `deepest ${deepest.toFixed(2)} m`);
});

test('flak: six tanks firing it in one volley stay sane (72 impacts, ground and tanks consistent)', () => {
  const players = Array.from({ length: 6 }, (_, i) => ({ name: `T${i}` }));
  const g = arena(players, { firing: 'volley' });
  g.players.forEach((p, i) => {
    const a = (i / 6) * Math.PI * 2;
    p.x = Math.cos(a) * 160; p.z = Math.sin(a) * 160; p.y = 20;
    p.inventory.flak = 1;
  });
  for (let k = 0; k < 6; k++) {
    run(g, (q) => q.phase === 'aim' || q.phase === 'volley');
    if (g.phase !== 'aim') break;
    const me = g.current;
    me.weapon = 'flak';
    me.elev = 55; me.power = 60;
    me.yaw = ((Math.atan2(-me.z, -me.x) * 180) / Math.PI + 360) % 360;
    g.fire();
  }
  const events = run(g, (q) => q.phase === 'aim' || q.phase === 'roundOver', 60000);
  const bursts = events.filter((e) => e.type === 'explosion').length;
  assert.equal(bursts, 72);
  assert.ok(g.players.every((p) => p.hp >= 0 && Number.isFinite(p.hp)));
  // One 'terrain' event per carve: the renderer batches them, the core never dedupes.
  assert.ok(events.filter((e) => e.type === 'terrain').length >= 72);
});

test('fuel: every shot puts back a third of the round\'s fuel, never past full', () => {
  const g = arena();
  const me = g.current;
  const full = me.fuelMax;
  assert.ok(full > 0);
  me.fuel = 0;
  assert.ok(g.fire());
  assert.ok(Math.abs(me.fuel - full * TANK.refuelShare) < 1e-9);
  me.fuel = full - 1;
  g.launch(me);
  assert.equal(me.fuel, full);
});
