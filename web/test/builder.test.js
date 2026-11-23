// The Custom match builder: Random wind and terrain, the testing query string,
// the checkbox groups, and the game obeying the lists (weapons, perks, round
// modifiers) the builder puts in the match config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Session } from '../src/core/netplay.js';
import { WEAPONS } from '../src/core/weapons.js';
import { PERKS, PERK_BY_ID, MODIFIERS } from '../src/core/perks.js';
import {
  WIND, TERRAIN, GROUPS, matchConditions, conditionsLabel, parseTestParams, terrainConfig,
  cleanOff, onList, matchLists, groupSummary,
} from '../src/builder.js';

const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

// ---- wind and terrain

test('Random wind and terrain roll every option, isles least; a chosen value is kept', () => {
  const seen = { wind: new Map(), world: new Map() };
  let r = 0;
  const rand = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
  for (let k = 0; k < 3000; k++) {
    const c = matchConditions({}, {}, rand);
    seen.wind.set(c.maxWind, (seen.wind.get(c.maxWind) || 0) + 1);
    const t = c.world === 'isles' ? 'isles' : String(c.hills);
    seen.world.set(t, (seen.world.get(t) || 0) + 1);
  }
  assert.deepEqual([...seen.wind.keys()].sort(), WIND.map((w) => w.value).sort());
  assert.deepEqual([...seen.world.keys()].sort(), TERRAIN.map((t) => t.value).sort());
  assert.ok(seen.world.get('isles') < seen.world.get('45') * 0.75, 'the isles come up less often than a meadow');
  assert.deepEqual(matchConditions({ wind: '0', terrain: 'isles' }, {}, seq(0.99)), { maxWind: 0, hills: 45, world: 'isles' });
  assert.deepEqual(matchConditions({ wind: '2.5', terrain: '80' }), { maxWind: 2.5, hills: 80, world: 'meadow' });
  assert.deepEqual(matchConditions({ wind: 'random', terrain: 'random' }, {}, seq(0)), { maxWind: 0, hills: 20, world: 'meadow' });
});

test('the query string beats both Random and a chosen value', () => {
  const forced = parseTestParams('?wind=calm&terrain=isles');
  assert.deepEqual(matchConditions({ wind: '2.5', terrain: '20' }, forced), { maxWind: 0, hills: 45, world: 'isles' });
  assert.deepEqual(matchConditions({}, parseTestParams('?fixed')), { maxWind: 1.5, hills: 45, world: 'meadow' });
});

test('parseTestParams reads wind, terrain, fixed and the mods for everyone', () => {
  assert.deepEqual(parseTestParams(''), {});
  assert.deepEqual(parseTestParams('?mobile=1&packs'), {}, 'other params are not ours');
  assert.deepEqual(parseTestParams('?wind=Gale&terrain=mountains'), { maxWind: 2.5, terrain: '80' });
  assert.deepEqual(parseTestParams('?wind=1.2'), { maxWind: 1.2 });
  assert.deepEqual(parseTestParams('?wind=99'), { maxWind: 5 }, 'clamped');
  assert.deepEqual(parseTestParams('?wind=-3'), { maxWind: 0 });
  assert.deepEqual(parseTestParams('?wind=storm&terrain=moon'), {}, 'unknown words are ignored');
  assert.deepEqual(parseTestParams('?fixed'), { maxWind: 1.5, terrain: '45' });
  assert.deepEqual(parseTestParams('?fixed=1&wind=calm'), { maxWind: 0, terrain: '45' }, 'wind beats fixed');
  assert.deepEqual(parseTestParams('?fixed=0'), {});
  assert.deepEqual(parseTestParams('?sat=2&orbiter=3&labels=many').lab, { satellite: 'all', level: 2, orbiter: 'all', orbiterLevel: 3, labels: 'many' });
  assert.deepEqual(parseTestParams('?sat=7&orbiter=x&labels=lots'), {});
});

test('what was rolled reads as words', () => {
  assert.equal(conditionsLabel({ maxWind: 1.5, hills: 45, world: 'meadow' }), 'Hilly · Gusty wind');
  assert.equal(conditionsLabel({ maxWind: 0, hills: 45, world: 'isles' }), 'Floating isles · Calm wind');
  assert.equal(conditionsLabel({ maxWind: 1.2, hills: 33, world: 'meadow' }), 'Hills 33 · Wind 1.2');
  assert.deepEqual(terrainConfig('nonsense'), { hills: 45, world: 'meadow' });
});

// ---- the groups

test('every weapon, perk and modifier has a box; the Shell is locked on', () => {
  const g = Object.fromEntries(GROUPS.map((x) => [x.id, x]));
  assert.deepEqual(g.weapons.items.map((i) => i.id), WEAPONS.filter((w) => !w.hidden).map((w) => w.id));
  assert.deepEqual(g.perks.items.map((i) => i.id), PERKS.map((p) => p.id));
  assert.ok(['orbital', 'satrecon', 'orbitalup', 'satrecon2'].every((id) => g.perks.items.some((i) => i.id === id)), 'mod cards too');
  assert.deepEqual(g.modifiers.items.map((i) => i.id), MODIFIERS.map((m) => m.id));
  assert.deepEqual(g.weapons.items.filter((i) => i.locked).map((i) => i.id), ['shell']);
  for (const x of GROUPS) for (const it of x.items) assert.ok(it.name && it.desc, it.id);
});

test('off-lists become config lists: null for all, else what is on, the Shell always', () => {
  assert.deepEqual(cleanOff('weapons', ['shell', 'flak', 'flak', 'nope']), ['flak']);
  assert.equal(onList('weapons', []), null);
  assert.equal(onList('weapons', ['shell']), null, 'the Shell cannot be turned off');
  const allOff = WEAPONS.filter((w) => !w.hidden).map((w) => w.id);
  assert.deepEqual(onList('weapons', allOff), ['shell']);
  assert.deepEqual(onList('perks', PERKS.map((p) => p.id)), []);
  assert.deepEqual(matchLists({ modifiers: ['gale'] }).modifiers, MODIFIERS.filter((m) => m.id !== 'gale').map((m) => m.id));
  assert.deepEqual(matchLists({}), { weapons: null, perks: null, modifiers: null });
  assert.equal(groupSummary('perks', []), 'All');
  assert.equal(groupSummary('perks', ['hull', 'double']), `${PERKS.length - 2} of ${PERKS.length}`);
  assert.equal(groupSummary('perks', PERKS.map((p) => p.id)), 'None');
  assert.equal(groupSummary('weapons', allOff), 'Shell only');
});

// ---- the game obeys the lists

const players = (n = 2, ai = null) => Array.from({ length: n }, (_, i) => ({ name: `T${i}`, ai: i === 0 ? null : ai }));
const make = (opts = {}) => { const g = new Game({ players: players(), rounds: 6, seed: 3, resolution: 64, ...opts }); g.start(); return g; };

test('weapons that are off are in no starting kit, armory or perk hand-out; the Shell stays', () => {
  const g = make({ weapons: ['mound'], perks: ['quartermaster', 'hull'], fog: true });
  const p = g.players[0];
  assert.equal(p.inventory.shell, Infinity);
  assert.equal(p.inventory.mound, 1);
  for (const id of ['guided', 'breacher', 'roller', 'scatter', 'ranger', 'scout']) assert.ok(!(p.inventory[id] > 0), id);
  p.money = 99999;
  for (const w of WEAPONS) if (!w.hidden && !w.infinite && w.id !== 'mound') assert.equal(g.buy(0, w.id), false, w.id);
  assert.equal(g.buy(0, 'mound'), true);
  assert.equal(g.weaponOn('shell'), true);
  assert.equal(g.weaponOn('scatterlet'), true, 'fragments of a shell are not weapons of their own');
  assert.equal(g.perkFits(p, PERK_BY_ID.quartermaster), false, 'it hands out Breachers, which are off');
  p.perks.push('quartermaster');
  g.endRound(); g.openShop(); g.closeShop();
  assert.ok(!(p.inventory.breacher > 0), 'no Breacher from a perk');
  assert.ok(!(p.inventory.scout > 0), 'no free Scout in the fog');
  const none = make({ weapons: [] });
  assert.equal(none.players[0].inventory.shell, Infinity, 'with every box off the Shell is still there');
  const all = make();
  assert.equal(all.players[0].inventory.breacher, 1);
});

test('CPUs never buy or fire a weapon that is off', () => {
  const g = new Game({ players: players(3, 'hard'), rounds: 4, seed: 21, resolution: 64, weapons: ['roller', 'mound'] });
  g.players[0].ai = 'normal';
  const fired = new Set();
  g.start();
  for (let k = 0; k < 200000 && g.phase !== 'matchOver'; k++) {
    if (g.phase === 'roundOver') {
      for (const p of g.players) p.money += 5000;
      g.openShop();
      for (const p of g.players) for (const id of p.bought) assert.ok(['roller', 'mound', 'armor', 'fuel', 'jet'].includes(id), `bought ${id}`);
      continue;
    }
    g.update(1 / 20);
    for (const e of g.drainEvents()) if (e.type === 'projectile' && e.weapon) fired.add(e.weapon);
  }
  assert.equal(g.phase, 'matchOver');
  for (const w of fired) assert.ok(['shell', 'roller', 'mound', 'bomblet'].includes(w), `fired ${w}`);
  for (const p of g.players) for (const [id, n] of Object.entries(p.inventory)) if (n > 0) assert.ok(['shell', 'roller', 'mound'].includes(id), `${p.name} holds ${id}`);
});

test('the draft only offers perks that are on, to humans and CPUs', () => {
  const on = ['hull', 'dugin', 'tracer', 'wideblast'];
  const g = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }, { name: 'C', ai: 'easy' }], rounds: 8, seed: 5, resolution: 64, perks: on });
  g.start();
  for (let r = 0; r < 5; r++) {
    g.endRound();
    g.openShop();
    for (const offer of Object.values(g.draft)) for (const id of offer) assert.ok(on.includes(id), id);
    for (const p of g.players) for (const id of p.perks) assert.ok(on.includes(id), id);
    g.closeShop();
  }
  assert.ok(g.players[1].perks.length > 0, 'the CPUs still draft');
});

test('a level-up card never comes up without its unlock card', () => {
  // Everyone has an orbiter from the start (?orbiter=1), but Orbital Mechanic is off.
  const g = make({ perks: PERKS.filter((p) => p.id !== 'orbital').map((p) => p.id), lab: { orbiter: 'all', orbiterLevel: 1 } });
  const p = g.players[0];
  assert.equal(g.modLevel(p, 'orbiter'), 1);
  assert.equal(g.perkFits(p, PERK_BY_ID.orbitalup), false);
  const with_ = make({ lab: { orbiter: 'all', orbiterLevel: 1 } });
  assert.equal(with_.perkFits(with_.players[0], PERK_BY_ID.orbitalup), true, 'with the unlock on it can');
  for (let r = 0; r < 5; r++) {
    g.endRound(); g.openShop();
    for (const offer of Object.values(g.draft)) assert.ok(!offer.includes('orbitalup'));
    g.closeShop();
  }
});

test('with the mod cards off nobody gets that mod', () => {
  const g = make({ perks: PERKS.filter((p) => !p.mods?.satellite).map((p) => p.id) });
  for (let r = 0; r < 5; r++) { g.endRound(); g.openShop(); g.closeShop(); }
  for (const p of g.players) assert.equal(g.modLevel(p, 'satellite'), 0);
});

test('every perk off: no draft at all; legacy twists:false means the same', () => {
  for (const opts of [{ perks: [] }, { twists: false }]) {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'hard' }], rounds: 4, seed: 9, resolution: 64, ...opts });
    g.start();
    assert.equal(g.draftOn, false);
    g.endRound(); g.openShop();
    assert.deepEqual(g.draft, {});
    assert.deepEqual(g.players[1].perks, [], 'the CPU drafts nothing either');
  }
  const legacy = new Game({ players: players(), seed: 1, resolution: 64, twists: false });
  assert.deepEqual([legacy.cfg.perks, legacy.cfg.modifiers], [[], []]);
  assert.equal(make().draftOn, true);
});

test('round modifiers: only the ones that are on; none on means plain rounds', () => {
  const g = make({ modifiers: ['soft', 'goldrush'], rounds: 12 });
  const seen = new Set([g.modifier.id]);
  for (let r = 0; r < 10; r++) { g.endRound(); g.openShop(); g.closeShop(); seen.add(g.modifier.id); }
  for (const id of seen) assert.ok(['soft', 'goldrush', 'clear'].includes(id), id);
  assert.ok(seen.has('soft') && seen.has('goldrush'));
  const plain = make({ modifiers: [], rounds: 8 });
  for (let r = 0; r < 6; r++) { assert.equal(plain.modifier.id, 'clear'); plain.endRound(); plain.openShop(); plain.closeShop(); }
});

test('with the wind on Calm, Gale and Dead calm sit out', () => {
  for (let seed = 1; seed < 40; seed++) {
    const g = new Game({ players: players(), rounds: 6, seed, resolution: 64, maxWind: 0 });
    g.start();
    for (let r = 0; r < 4; r++) {
      assert.ok(!['gale', 'calm'].includes(g.modifier.id), `seed ${seed}: ${g.modifier.id}`);
      assert.deepEqual(g.wind, [0, 0]);
      g.endRound(); g.openShop(); g.closeShop();
    }
  }
});

test('online: the host\'s lists and rolled world reach every screen', () => {
  const log = [];
  const append = (seat, msg) => log.push({ n: log.length + 1, seat, msg: JSON.parse(JSON.stringify(msg)) });
  const screens = [0, 1].map((seat) => new Session({ seat, send: (m) => append(seat, m), onStart: (cfg) => { const g = new Game({ ...cfg, resolution: 64 }); g.start(); return g; } }));
  append(-1, { t: 'join', seat: 0, name: 'Host' });
  append(-1, { t: 'join', seat: 1, name: 'Guest' });
  const feed = () => screens.forEach((s) => { for (const e of log.slice(s.cursor || 0)) s.receive(e); s.cursor = log.length; s.pump(); });
  feed();
  screens[0].start({ rounds: 3, ...matchConditions({}, {}, seq(0.95, 0.95)), ...matchLists({ weapons: ['breacher', 'flak'], perks: ['double'] }) }, [{ name: 'Bot', ai: 'normal' }]);
  feed();
  const [a, b] = screens.map((s) => s.game);
  assert.ok(a && b);
  assert.deepEqual(a.cfg.weapons, b.cfg.weapons);
  assert.equal(a.cfg.world, 'isles');
  assert.equal(b.cfg.world, 'isles');
  assert.equal(a.cfg.maxWind, b.cfg.maxWind);
  assert.equal(b.weaponOn('flak'), false);
  assert.ok(!b.cfg.perks.includes('double'));
  assert.deepEqual(a.players.map((p) => p.inventory), b.players.map((p) => p.inventory));
  assert.deepEqual(Array.from(a.terrain.heights.slice(0, 200)), Array.from(b.terrain.heights.slice(0, 200)));
});
