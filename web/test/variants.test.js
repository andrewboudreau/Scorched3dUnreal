// Weapon variants (weapons.js `variants`, perks.js VARIANT_PERKS, skills.js
// weapon branches): a tank's weapon resolves to base + variant + upgrade; the
// fork in the tree shuts the other side; each family's hook does what it says;
// a match with variants in it replays the same; CPUs choose by temper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Heightfield } from '../src/core/terrain.js';
import { SIM_DT, makeRoller, stepRoller, hopOver, simulateShot, burstNow } from '../src/core/ballistics.js';
import { WEAPONS, WEAPON_BY_ID, VARIANT_WEAPONS, resolveWeapon, splitVelocities, throwVelocities } from '../src/core/weapons.js';
import { variantRows, guideTabs } from '../src/guide.js';
import { PERK_BY_ID, VARIANT_PERKS, weaponFor, weaponLabel } from '../src/core/perks.js';
import { BRANCHES, WEAPON_BRANCHES, tabOf } from '../src/core/skills.js';
import { NAPALM, napalmParams, flowNapalm, burnTime } from '../src/core/napalm.js';
import { skillTreeHtml, skillTabs, skillTabsHtml, armoryHtml, kitHtml, weaponStats } from '../src/armory.js';

// Two tanks on flat, dry, empty ground, 300 m apart.
function arena({ seed = 3, ai = null, n = 2, perks = [] } = {}) {
  const players = Array.from({ length: n }, (_, k) => ({ name: 'ABCD'[k], ai }));
  const g = new Game({ players, rounds: 3, seed, resolution: 256, twists: false });
  g.start();
  g.terrain.heights.fill(20);
  g.terrain.scorch.fill(0);
  g.terrain.waterLevel = -Infinity;
  g.scenery.props.length = 0;
  g.wind = [0, 0];
  g.players.forEach((p, k) => { p.x = -150 + k * 300; p.z = 0; p.y = 20; });
  g.players[0].perks.push(...perks);
  g.drainEvents();
  return g;
}
const settle = (g, max = 4000) => { for (let k = 0; k < max && (g.projectiles.length || g.fires.length); k++) g.stepWorld(SIM_DT); };
// Drop weapon `id` of tank 0 straight down from `up` m over x/z.
const drop = (g, id, x, z, up = 30, vel = [0, -20, 0]) => g.spawnProjectile([x, g.terrain.heightAt(x, z) + up, z], vel, id, 0, 1);
const flat = (h = 20) => { const t = new Heightfield({ size: 800, resolution: 256 }); t.heights.fill(h); return t; };

// ---------------------------------------------------------------- resolution

test('a variant resolves to the base weapon with its patch, the upgrade on top, the base left alone', () => {
  assert.deepEqual(VARIANT_WEAPONS.map((w) => w.id).sort(), ['breacher', 'napalm', 'roller', 'scatter', 'thunderhead']);
  for (const w of VARIANT_WEAPONS) {
    assert.equal(w.variants.length, 2, `${w.id} forks two ways`);
    assert.deepEqual(w.variants.map((v) => v.style).sort(), ['bold', 'careful'], `${w.id}: one bold, one careful`);
    assert.ok(w.upgrade?.name, `${w.id} has a rank 2`);
  }
  const base = WEAPON_BY_ID.breacher;
  const before = JSON.stringify(base);
  const bb = resolveWeapon(base, 'bunker');
  assert.equal(bb.id, 'breacher', 'it fires and is stocked as the base weapon');
  assert.equal(bb.label, 'Breacher · Bunker Buster');
  assert.deepEqual(bb.impact, [{ type: 'blast', radius: 18, damage: 70, depth: 1.05, pierce: true }]);
  assert.equal(bb.price, base.price, 'same price and bundle');
  const up = resolveWeapon(base, 'bunker', true);
  assert.equal(up.impact[0].radius, 20.7, 'Wider Charge: 15% on the blast');
  assert.ok(up.upgraded);
  assert.equal(resolveWeapon(base, 'bunker', true), up, 'memoized: the same object each time');
  assert.equal(JSON.stringify(base), before, 'the base weapon is untouched');
  assert.equal(resolveWeapon(base, null, false), base);
  // Through a tank's perks.
  const p = { perks: ['napalm:sticky', 'napalm:up'] };
  const n = weaponFor(p, 'napalm');
  assert.equal(weaponLabel(p, 'napalm'), 'Napalm · Sticky');
  assert.deepEqual(n.impact[0].params, { film: 0.22, ticks: 11, damage: 62, wade: 1.5, rainproof: true });
  assert.equal(weaponFor(p, 'breacher'), WEAPON_BY_ID.breacher, 'other weapons as they are');
  assert.equal(weaponFor(p, 'shell'), WEAPON_BY_ID.shell);
  assert.equal(weaponLabel({ perks: [] }, 'napalm'), 'Napalm');
  assert.equal(resolveWeapon(WEAPON_BY_ID.scatter, 'ring', true).flight[0].count, 6, 'Sixth Shell');
  assert.equal(resolveWeapon(WEAPON_BY_ID.roller, 'seeker', true).impact[0].reach, 1.5, 'Long Roll');
  // Every child a variant names is a real (hidden) weapon.
  for (const w of VARIANT_WEAPONS) for (const v of w.variants) {
    const r = resolveWeapon(w, v.id, true);
    for (const part of [...(r.flight || []), ...(r.impact || [])]) if (part.child) assert.ok(WEAPON_BY_ID[part.child]?.hidden, `${v.id}: ${part.child}`);
  }
  assert.equal(weaponStats(resolveWeapon(base, 'splitter')), '50 dmg · 16 m + 3 × 22');
  // The guide lists them from the data: two sides and the upgrade a family.
  const rows = variantRows(WEAPONS);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows.find((r) => r.name === 'Napalm · Sticky'), { name: 'Napalm · Sticky', meta: 'or Flood', text: rows.find((r) => r.name === 'Napalm · Sticky').text });
  assert.ok(rows.some((r) => r.name === 'Roller: Long Roll'));
  assert.ok(guideTabs({ weapons: WEAPONS }).find((t) => t.id === 'weapons').blocks.some((b) => b.h === 'Variants'));
});

// ---------------------------------------------------------------- the tree

test('the fork: both variants on offer, taking one shuts the other, then rank 2 upgrades it', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 6, seed: 4, resolution: 64 });
  g.start();
  g.endRound();
  g.openShop();
  const a = g.players[0];
  a.points = 3;
  const nap = () => g.skillTree(a).find((b) => b.id === 'napalm');
  assert.deepEqual(nap().options, ['napalm:sticky', 'napalm:flood']);
  assert.equal(nap().held, 0);
  const offer = g.skillOffer(a);
  assert.ok(offer.includes('napalm:sticky') && offer.includes('napalm:flood'), 'both sides on offer');
  assert.ok(!offer.includes('napalm:up'), 'rank 2 waits for the fork');
  assert.equal(g.pickPerk(0, 'napalm:up'), false, 'no upgrade before a variant');
  assert.ok(g.pickPerk(0, 'napalm:flood'));
  assert.equal(g.pickPerk(0, 'napalm:sticky'), false, 'the other side is shut');
  assert.equal(nap().taken, 'napalm:flood');
  assert.equal(nap().options, null);
  assert.equal(nap().next, 'napalm:up');
  assert.ok(!g.skillOffer(a).includes('napalm:sticky'));
  assert.ok(g.pickPerk(0, 'napalm:up'));
  assert.equal(nap().held, 2);
  assert.equal(nap().next, null, 'complete');
  assert.equal(g.pickPerk(0, 'napalm:up'), false, 'once');
  assert.equal(g.weaponName(a, 'napalm'), 'Napalm · Flood');
  assert.equal(a.points, 1);
  // The screen: tabs, and the fork as two buttons.
  const b = g.players[1];
  b.points = 1;
  assert.deepEqual(skillTabs(g, b).map((t) => t.id), ['weapons', 'mods', 'tank']);
  const tabs = skillTabsHtml(g, b, 'weapons');
  assert.match(tabs, /class="sk-tab on"[^>]*data-tab="weapons"/);
  const h = skillTreeHtml(g, b, 'weapons');
  assert.match(h, /data-id="napalm:sticky"/);
  assert.match(h, /data-id="napalm:flood"/);
  assert.ok(!/data-id="heavycharge"/.test(h), 'the Weapons tab shows only weapons');
  assert.match(skillTreeHtml(g, b, 'tank'), /data-id="heavycharge"/);
  assert.match(skillTreeHtml(g, b), /data-id="napalm:flood"[\s\S]*data-id="heavycharge"/, 'no tab: every branch, weapons first');
  assert.match(skillTreeHtml(g, a, 'weapons'), /Napalm · Flood/);
  for (const br of BRANCHES) assert.ok(['weapons', 'mods', 'tank'].includes(tabOf(br)));
  assert.deepEqual(WEAPON_BRANCHES.map((br) => tabOf(br)), WEAPON_BRANCHES.map(() => 'weapons'));
  // The armory card and the kit say which variant it is.
  a.inventory.napalm = 2;
  assert.match(armoryHtml(g, a), /Napalm · Flood/);
  assert.match(kitHtml(g, a), /Napalm · Flood ×2/);
});

test('a weapon off in the match has no branch, and its variants are never offered', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], rounds: 6, seed: 9, resolution: 64,
    weapons: ['shell', 'breacher', 'roller', 'mound', 'ranger'] });
  g.start();
  for (let r = 0; r < 4; r++) {
    g.endRound();
    g.openShop();
    const ids = g.skillTree(g.players[0]).filter((b) => b.weapon).map((b) => b.id);
    assert.deepEqual(ids.sort(), ['breacher', 'roller']);
    for (const p of g.players) for (const id of p.perks) {
      const k = PERK_BY_ID[id];
      if (k.weapon) assert.ok(['breacher', 'roller'].includes(k.weapon), id);
    }
    assert.equal(g.pickPerk(0, 'napalm:sticky'), false);
    g.closeShop();
  }
});

// ---------------------------------------------------------------- the hooks

test('Breacher: the Bunker Buster digs deeper and hits a buried tank in full; the Splitter throws 3 bomblets', () => {
  // A buried tank, Breacher on the dome right over it.
  const hit = (perks) => {
    const g = arena({ perks });
    const b = g.players[1];
    g.applyEffect({ type: 'bury', point: [b.x, b.y, b.z], radius: 20, height: 16 }, 0, null);
    assert.ok(b.buried);
    const hp = b.hp;
    drop(g, 'breacher', b.x, b.z);
    settle(g);
    return hp - b.hp;
  };
  const plain = hit([]), bunker = hit(['breacher:bunker']);
  assert.ok(bunker >= 69, `the Bunker Buster does it all: ${bunker.toFixed(1)}`);
  assert.ok(plain < bunker * 0.6, `a plain Breacher on the dome: ${plain.toFixed(1)}`);
  // Deeper, narrower crater on open ground.
  const crater = (perks) => {
    const g = arena({ perks });
    drop(g, 'breacher', 0, 0);
    settle(g);
    return 20 - g.terrain.heightAt(0, 0);
  };
  assert.ok(crater(['breacher:bunker']) > crater([]) * 1.2, `${crater(['breacher:bunker'])} vs ${crater([])}`);
  // The Splitter: three bomblets, out in a star.
  const g = arena({ perks: ['breacher:splitter'] });
  drop(g, 'breacher', 0, 0);
  for (let k = 0; k < 400 && !g.projectiles.some((p) => p.weapon === 'splitlet'); k++) g.stepWorld(SIM_DT);
  const kids = g.projectiles.filter((p) => p.weapon === 'splitlet');
  assert.equal(kids.length, 3);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.type === 'split' && e.thrown));
  settle(g);
  const booms = g.drainEvents().filter((e) => e.type === 'explosion');
  assert.equal(booms.length, 3, 'each bomblet goes off');
  for (const e of booms) {
    const d = Math.hypot(e.pos[0], e.pos[2]);
    assert.ok(d > 8 && d < 40, `a bomblet ${d.toFixed(1)} m out`);
  }
  const v = throwVelocities([10, -5, 0], { count: 3, speed: 7, up: 10 });
  assert.deepEqual(v[0].map((x) => +x.toFixed(6)), [7, 10, 0], 'the first along the flight');
});

test('Scatter: the Line lays its shells down the line of flight, the Ring evenly round', () => {
  const vel = [20, -1, 0];
  const line = splitVelocities(vel, 5, 3, 'along');
  for (const v of line) assert.ok(Math.abs(v[2]) < 1e-9, 'no spread across');
  const xs = line.map((v) => v[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 4, 'a row along the flight');
  const ring = splitVelocities(vel, 5, 3.5, 'ring');
  for (const v of ring) assert.ok(Math.abs(Math.hypot(v[0] - 20, v[2]) - 3.5) < 1e-9, 'all on the circle');
  assert.ok(Math.abs(ring[0][2]) < 1e-9 && ring[0][0] > 20, 'the first straight ahead');
  // In a game, the Ring leaves a ring of craters round a middle it misses.
  const g = arena({ perks: ['scatter:ring'] });
  g.spawnProjectile([0, 120, 0], [0, 8, 0.0001], 'scatter', 0, 1);   // straight up: splits at the top
  settle(g);
  const booms = g.drainEvents().filter((e) => e.type === 'explosion');
  assert.equal(booms.length, 5);
  assert.ok(booms.every((e) => e.radius === 12), 'ringlets');
  const ds = booms.map((e) => Math.hypot(e.pos[0], e.pos[2]));
  assert.ok(Math.min(...ds) > 6 && Math.max(...ds) - Math.min(...ds) < 3, `round the middle: ${ds.map((d) => d.toFixed(1))}`);
});

test('Roller: the Seeker leans toward a tank; the Hopper hops a bump', () => {
  const t = flat();
  const run = (seek) => {
    const r = makeRoller([0, 20, 0], [12, -10, 0], t, seek ? { seek: { accel: 1.5, range: 50 } } : null);
    r.owner = 0;
    r.targets = [{ x: 0, z: 0, owner: 0 }, { x: 14, z: 10, owner: 1 }];
    let end = null;
    for (let k = 0; k < 2000 && !end; k++) end = stepRoller(r, t);
    return r.pos;
  };
  const plain = run(false), seek = run(true);
  assert.ok(Math.abs(plain[2]) < 1e-9, 'a plain one rolls straight');
  assert.ok(seek[2] > 3, `the Seeker veers toward it: z ${seek[2].toFixed(2)}`);
  // A game: it rolls into the tank it leans at.
  const g = arena({ perks: ['roller:seeker'] });
  const b = g.players[1];
  const hp = b.hp;
  g.spawnProjectile([b.x - 14, 21, b.z + 9], [2, -6, 0], 'roller', 0, 1);
  settle(g);
  assert.ok(b.hp < hp - 40, `the Seeker found it: ${hp - b.hp}`);

  // A bump across the way: 3 m high, at x = 28.
  const bump = (tt) => { for (let j = 0; j < tt.n; j++) for (let i = 0; i < tt.n; i++) tt.heights[tt.index(i, j)] = 20 + Math.max(0, 3 - Math.abs(tt.vx(i) - 28)); };
  const r = makeRoller([22, 20, 0], [4, -5, 0], (bump(t), t));
  let end = null;
  for (let k = 0; k < 2000 && !end; k++) end = stepRoller(r, t);
  assert.equal(end, 'stopped');
  assert.ok(r.pos[0] < 26, 'stopped against the bump');
  const v = hopOver(r, t);
  assert.ok(v && v[1] > 0 && v[0] > 0, 'thrown up and over');
  assert.equal(hopOver(makeRoller([-200, 20, 0], [4, -5, 0], t), t), null, 'nothing to hop on the level');
  const where = (perks) => {
    const gg = arena({ perks });
    bump(gg.terrain);
    gg.spawnProjectile([22, 25, 0], [4, -5, 0], 'roller', 0, 1);
    let at = null;
    for (let k = 0; k < 4000 && gg.projectiles.length; k++) {
      gg.stepWorld(SIM_DT);
      for (const e of gg.drainEvents()) if (e.type === 'explosion') at = e.pos;
    }
    return at;
  };
  assert.ok(where([])[0] < 27, 'a plain Roller goes off on the near side');
  assert.ok(where(['roller:hopper'])[0] > 30, `the Hopper goes off past it: ${where(['roller:hopper'])[0].toFixed(1)}`);
});

test('Napalm: Sticky stays put and burns long, Flood runs far and burns short; Wet Burn floats', () => {
  // A long gentle slope falling toward +x.
  const t = flat();
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) t.heights[t.index(i, j)] = 20 + Math.max(0, 80 - t.vx(i)) * 0.12;
  const far = (N) => Math.max(...flowNapalm(t, 0, 0, N).cells.map(([i, j]) => Math.hypot(t.vx(i), t.vz(j))));
  const sticky = napalmParams(WEAPON_BY_ID.napalm.variants[0].patch.impact[0].params);
  const flood = napalmParams(WEAPON_BY_ID.napalm.variants[1].patch.impact[0].params);
  assert.ok(far(sticky) < far(NAPALM) && far(NAPALM) < far(flood), `${far(sticky).toFixed(0)} < ${far(NAPALM).toFixed(0)} < ${far(flood).toFixed(0)} m`);
  assert.ok(burnTime(sticky) > burnTime(NAPALM) + 1.5 && burnTime(flood) < burnTime(NAPALM));
  // Shallow water puts plain napalm out; Wet Burn floats over it.
  const w = flat(19.5);
  w.waterLevel = 20;
  assert.ok(flowNapalm(w, 0, 0).doused);
  assert.ok(!flowNapalm(w, 0, 0, napalmParams({ wade: 1.5 })).doused);
  // In a game: a tank sitting in it burns for longer with Sticky.
  const burn = (perks, rain = false) => {
    const g = arena({ perks });
    if (rain) g.modifier = { ...g.modifier, drag: 0.01 };
    const b = g.players[1];
    g.carve(b.x, b.y, b.z, 12, 0.6);
    for (let k = 0; k < 200; k++) g.stepWorld(SIM_DT);
    const hp = b.hp;
    drop(g, 'napalm', b.x + 2, b.z);
    const ev = [];
    for (let k = 0; k < 4000 && (g.projectiles.length || g.fires.length); k++) { g.stepWorld(SIM_DT); ev.push(...g.drainEvents()); }
    return { dmg: hp - b.hp, burn: ev.find((e) => e.type === 'napalm').burn, op: g.ground.ops.find((o) => o[0] === 'n') };
  };
  const base = burn([]), st = burn(['napalm:sticky']);
  assert.ok(st.dmg > base.dmg, `Sticky ${st.dmg.toFixed(1)} > ${base.dmg.toFixed(1)}`);
  assert.ok(st.burn > base.burn);
  assert.deepEqual(st.op[3], { film: 0.22, ticks: 11, damage: 62 }, 'the ground op keeps its params');
  assert.equal(base.op.length, 3, 'a plain spill as before');
  const wet = burn([], true), proof = burn(['napalm:sticky', 'napalm:up'], true), dry = burn(['napalm:sticky', 'napalm:up']);
  assert.ok(Math.abs(wet.dmg - base.dmg * NAPALM.rain) < 1, `rain damps it: ${wet.dmg.toFixed(1)}`);
  assert.ok(Math.abs(proof.dmg - dry.dmg) < 1e-9, 'Wet Burn: rain does not');
});

test('Thunderhead: the Airburst goes off 8 m up with no crater and hits through a Dirt Bomb dome; Deep Strike digs deeper', () => {
  const t = flat();
  assert.ok(burstNow({ pos: [0, 27, 0], vel: [0, -1, 0] }, t, 8));
  assert.ok(!burstNow({ pos: [0, 27, 0], vel: [0, 1, 0] }, t, 8), 'not on the way up');
  assert.ok(!burstNow({ pos: [0, 29, 0], vel: [0, -1, 0] }, t, 8));
  const g = arena({ perks: ['thunderhead:airburst'] });
  const b = g.players[1];
  g.applyEffect({ type: 'bury', point: [b.x, b.y, b.z], radius: 20, height: 16 }, 0, null);
  const before = Float64Array.from(g.terrain.heights);
  const ops = g.ground.ops.length;
  const hp = b.hp;
  drop(g, 'thunderhead', b.x, b.z, 60);
  const ev = [];
  settle(g);
  ev.push(...g.drainEvents());
  const imp = ev.find((e) => e.type === 'impact');
  assert.ok(imp.aloft, 'it went off in the air');
  const top = g.terrain.heightAt(b.x, b.z);
  assert.ok(imp.pos[1] - top > 6 && imp.pos[1] - top <= 8, `${(imp.pos[1] - top).toFixed(2)} m over the dome`);
  assert.ok(g.terrain.heights.every((h, k) => h === before[k]), 'no crater');
  assert.equal(g.ground.ops.length, ops, 'no ground op');
  assert.ok(hp - b.hp >= 89, `the buried tank takes it all: ${hp - b.hp}`);
  // The CPU's solver and the kill cam judge it where it goes off.
  const sim = simulateShot({ pos: [0, 80, 0], vel: [5, 0, 0], terrain: t, burst: 8 });
  assert.equal(sim.kind, 'burst');
  assert.ok(sim.point[1] - 20 <= 8 && sim.point[1] - 20 > 6);
  assert.equal(g.burstHeight(0, 'thunderhead'), 8);
  assert.equal(g.burstHeight(1, 'thunderhead'), 0);
  // Deep Strike: a deeper hole than the plain one.
  const crater = (perks) => {
    const gg = arena({ perks });
    drop(gg, 'thunderhead', 0, 0);
    settle(gg);
    return 20 - gg.terrain.heightAt(0, 0);
  };
  assert.ok(crater(['thunderhead:deep']) > crater([]) * 1.1);
});

// ---------------------------------------------------------------- replay

test('with variants in play, a match replays the same: snapshot, restore and the ground ops', () => {
  const fresh = () => {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 21, resolution: 128, twists: false });
    g.start();
    g.drainEvents();
    return g;
  };
  const shoot = (g) => {
    const [p, q] = g.players;
    g.spawnProjectile([q.x + 4, g.terrain.heightAt(q.x + 4, q.z) + 30, q.z], [0, -15, 0], 'napalm', p.id, 1);
    g.spawnProjectile([q.x - 20, g.terrain.heightAt(q.x - 20, q.z) + 40, q.z], [3, -10, 0], 'breacher', p.id, 2);
    g.spawnProjectile([q.x, g.terrain.heightAt(q.x, q.z) + 70, q.z + 10], [0, -10, 0], 'thunderhead', q.id, 3);
    settle(g);
  };
  const a = fresh();
  a.players[0].perks.push('napalm:flood', 'breacher:splitter');
  a.players[1].perks.push('thunderhead:airburst');
  shoot(a);
  assert.ok(a.ground.ops.some((o) => o[0] === 'n' && o[3]?.reach === 40), 'the Flood spill is logged with its params');
  // The same shots on another copy land the same.
  const twin = fresh();
  twin.players[0].perks.push('napalm:flood', 'breacher:splitter');
  twin.players[1].perks.push('thunderhead:airburst');
  shoot(twin);
  assert.deepEqual(twin.players.map((x) => x.hp), a.players.map((x) => x.hp));
  assert.deepEqual(Array.from(twin.terrain.heights), Array.from(a.terrain.heights));
  // A copy that saw none of it takes on the snapshot, variants and ground alike.
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = fresh();
  b.restore(snap);
  assert.equal(b.weaponName(0, 'napalm'), 'Napalm · Flood');
  const same = (x, y, arr) => Array.from(x.terrain[arr]).every((v, k) => Math.abs(v - y.terrain[arr][k]) < 1e-4);
  assert.ok(same(b, a, 'heights') && same(b, a, 'scorch'), 'the ground replays');
  shoot(a);
  shoot(b);
  assert.deepEqual(b.players.map((x) => x.hp), a.players.map((x) => x.hp));
  assert.ok(same(b, a, 'heights') && same(b, a, 'scorch'));
});

test('a variant pick goes through the tree like any rank: the same picks in order give the same tank', () => {
  const make = () => {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 5, seed: 6, resolution: 64 });
    g.start();
    g.endRound();
    g.openShop();
    g.players[0].points = 3;
    return g;
  };
  const host = make();
  for (const id of ['roller:hopper', 'roller:seeker', 'roller:up', 'hull']) host.pickPerk(0, id);
  // The guest replays the host's picked list, as netplay's 'shop' message does.
  const guest = make();
  for (const id of host.players[0].picked) guest.pickPerk(0, id);
  assert.deepEqual(guest.players[0].perks, host.players[0].perks);
  assert.deepEqual(host.players[0].perks, ['roller:hopper', 'roller:up', 'hull']);
  assert.equal(guest.weaponName(0, 'roller'), 'Roller · Hopper');
});

// ---------------------------------------------------------------- CPUs

test('CPUs take the side of the fork their temper likes, mostly, from the seeded dice', () => {
  let liked = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'hard' }], rounds: 8, seed, resolution: 64 });
    g.start();
    for (const p of g.players) {
      const t = g.aiTemper(p);
      const style = t === 'gunner' || t === 'skirmisher' ? 'bold' : 'careful';
      for (const w of VARIANT_WEAPONS) {
        const id = g.aiVariant(p, w.id);
        assert.equal(PERK_BY_ID[id].weapon, w.id);
        assert.ok(PERK_BY_ID[id].variant);
        total++;
        if (PERK_BY_ID[id].style === style) liked++;
      }
    }
  }
  const share = liked / total;
  assert.ok(share > 0.62 && share < 0.88, `about three in four: ${share.toFixed(2)}`);
  // Same seed, same choices.
  const run = () => {
    const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 8, seed: 33, resolution: 64 });
    g.start();
    for (let r = 0; r < 6; r++) { g.endRound(); g.openShop(); g.closeShop(); }
    return g.players.map((p) => [...p.perks]);
  };
  const one = run();
  assert.deepEqual(run(), one);
  // A CPU never holds both sides of a fork, nor an upgrade without a variant.
  for (const perks of one) for (const w of VARIANT_WEAPONS) {
    const mine = perks.filter((id) => PERK_BY_ID[id]?.weapon === w.id);
    assert.ok(mine.filter((id) => PERK_BY_ID[id].variant).length <= 1);
    if (mine.includes(`${w.id}:up`)) assert.ok(mine.some((id) => PERK_BY_ID[id].variant));
  }
  assert.equal(VARIANT_PERKS.length, 15);
});
