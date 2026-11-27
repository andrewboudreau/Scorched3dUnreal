import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, kitOf } from '../src/core/game.js';
import { BOSS } from '../src/core/boss.js';
import {
  RUN, RUN_KEY, TIER_PLAN, KINDS, runMap, generateMap, crosses, stopSeed, startRun, reachable, chooseStop, currentStop,
  applyFightResult, applyCache, swapVariant, leaveDepot, setKit, forksTaken, allyChoices, matchConfig, kitGame, fightWon,
  loadRun, saveRun, clearRun, runSummary, stopDetails, rewardWords, kitMods,
} from '../src/core/run.js';

// The run (core/run.js): a map of stops from a seed, the kit carried from
// fight to fight, spare hulls, caches and depots, the boss at the end, saving.

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

// Walk to the first reachable stop of `kind` (settling fights as wins on the
// way); null if the map has none on the path taken.
function walkTo(state, kind) {
  let s = state;
  for (let guard = 0; guard < 10 && !s.over; guard++) {
    const next = reachable(s);
    const map = runMap(s.seed);
    const id = next.find((x) => map.byId[x].kind === kind) || next[0];
    s = chooseStop(s, id);
    if (map.byId[id].kind === kind) return s;
    s = settle(s);
  }
  return null;
}
function settle(s) {
  const stop = currentStop(s);
  if (stop.match) return applyFightResult(s, { won: true, kit: s.kit }).state;
  if (stop.kind === 'cache') return applyCache(s, 'money');
  if (stop.kind === 'depot') return leaveDepot(s);
  return s;
}

// ---------------------------------------------------------------- the map

test('the map comes from the seed alone, and another seed makes another map', () => {
  assert.deepEqual(generateMap(4242), generateMap(4242));
  assert.equal(runMap(4242), runMap(4242), 'kept');
  assert.notDeepEqual(JSON.stringify(generateMap(4242)), JSON.stringify(generateMap(4243)));
});

test('every map is well formed: tiers of 2 or 3, joined only to the next tier, no crossing paths, the boss last', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    assert.equal(map.tiers.length, RUN.tiers + 1);
    const last = map.tiers[map.tiers.length - 1];
    assert.equal(last.length, 1);
    assert.equal(last[0].kind, 'boss');
    assert.equal(map.stops.filter((s) => s.kind === 'boss').length, 1);
    for (let t = 0; t < RUN.tiers; t++) {
      const tier = map.tiers[t];
      assert.ok(tier.length >= 2 && tier.length <= 3, `tier ${t} has ${tier.length}`);
      assert.ok(tier.some((s) => s.kind === 'fight'), 'a fight in every tier');
      for (const s of tier) {
        assert.ok(TIER_PLAN[t].kinds.includes(s.kind));
        assert.ok(s.next.length >= 1, `${s.id} leads on`);
        for (const id of s.next) assert.equal(map.byId[id].tier, t + 1, 'only to the next tier');
      }
      // Every stop of the next tier has a way in.
      for (const n of map.tiers[t + 1]) assert.ok(tier.some((s) => s.next.includes(n.id)), `${n.id} has a way in`);
      // No two paths cross.
      const edges = tier.flatMap((s) => s.next.map((id) => [s.index, map.byId[id].index]));
      for (const e of edges) for (const f of edges) assert.ok(!crosses(e, f), `${seed}: ${e} crosses ${f}`);
    }
    assert.ok(map.tiers[0].every((s) => s.kind === 'fight'), 'the run opens with a fight');
  }
});

test('every stop can be reached from the start and leads to the boss; every route is seven stops', () => {
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const seen = new Set(map.tiers[0].map((s) => s.id));
    for (const t of map.tiers) for (const s of t) if (seen.has(s.id)) s.next.forEach((id) => seen.add(id));
    assert.equal(seen.size, map.stops.length, 'all reachable');
    const routes = (s) => (s.kind === 'boss' ? [[s.id]] : s.next.flatMap((id) => routes(map.byId[id]).map((r) => [s.id, ...r])));
    const all = map.tiers[0].flatMap(routes);
    assert.ok(all.length >= 2);
    for (const r of all) { assert.equal(r.length, RUN.tiers + 1); assert.equal(r[r.length - 1], 'boss'); }
    // And most stops give a choice.
    const choices = map.stops.filter((s) => s.next.length > 1).length;
    assert.ok(choices >= 2, `${seed}: only ${choices} stops with a choice`);
  }
});

test('a fight stop carries its whole match: world, edges, time, modifier, one or two foes, rounds, reward, seed', () => {
  for (const seed of SEEDS.slice(0, 10)) {
    const map = generateMap(seed);
    const seeds = new Set();
    for (const s of map.stops) {
      if (s.kind === 'fight' || s.kind === 'elite' || s.kind === 'boss') {
        const m = s.match;
        assert.ok(m.world && m.edges && m.time && m.rounds >= 1 && m.rounds <= 2);
        assert.equal(m.seed, stopSeed(seed, s.id));
        seeds.add(m.seed);
        if (s.kind === 'fight') {
          assert.ok(m.foes.length >= 1 && m.foes.length <= 2);
          assert.ok(s.reward.money > 0);
        }
        if (s.kind === 'elite') {
          assert.equal(m.foes.length, 1);
          assert.equal(m.foes[0].ai, 'hard');
          assert.ok(m.foes[0].up.length === 1, 'a mod already up');
          assert.ok(s.reward.points >= 1 && s.reward.money > 0);
        }
        const d = stopDetails(s);
        assert.ok(d.world && d.wind && d.edges && d.time && d.modifier && d.foes.length);
      }
      if (s.kind === 'cache') assert.deepEqual(s.offers.map((o) => o.kind), ['rank', 'ammo', 'money']);
    }
    assert.equal(seeds.size, map.stops.filter((s) => s.match).length, 'each stop its own seed');
  }
  // Fights get harder: the first tier is all Easy CPUs, the last Normal or Hard.
  const map = generateMap(SEEDS[0]);
  for (const s of map.tiers[0]) assert.ok(s.match.foes.every((f) => f.ai === 'easy'));
  for (const s of map.tiers[RUN.tiers - 1]) if (s.kind === 'fight') assert.ok(s.match.foes.every((f) => f.ai !== 'easy'));
});

// ---------------------------------------------------------------- moving on

test('only reachable stops can be chosen, and only once the stop you are at is settled', () => {
  let s = startRun(SEEDS[0], 'Tester');
  const map = runMap(s.seed);
  assert.deepEqual(reachable(s), map.tiers[0].map((x) => x.id));
  assert.throws(() => chooseStop(s, map.tiers[1][0].id), /not reachable/);
  assert.throws(() => chooseStop(s, 'boss'), /not reachable/);
  const first = reachable(s)[0];
  const before = JSON.stringify(s);
  s = chooseStop(s, first);
  assert.equal(JSON.stringify(startRun(SEEDS[0], 'Tester')), before, 'the old state is untouched');
  assert.equal(s.at, first);
  assert.deepEqual(s.path, [first]);
  assert.deepEqual(reachable(s), [], 'nothing until the fight is played');
  assert.throws(() => chooseStop(s, map.byId[first].next[0]), /not reachable/);
  s = applyFightResult(s, { won: true, kit: s.kit }).state;
  assert.deepEqual(reachable(s), map.byId[first].next);
  const notNext = map.tiers[1].find((x) => !map.byId[first].next.includes(x.id));
  if (notNext) assert.throws(() => chooseStop(s, notNext.id), /not reachable/);
});

test('a fight won: a skill point, the reward, and its CPUs among the beaten', () => {
  let s = chooseStop(startRun(SEEDS[1]), reachable(startRun(SEEDS[1]))[0]);
  const stop = currentStop(s);
  const kit = { ...s.kit, money: 400 };   // what the match left: money earned in it
  const { state, outcome } = applyFightResult(s, { won: true, kit });
  assert.equal(outcome.won, true);
  assert.equal(outcome.hullLost, false);
  assert.equal(state.kit.points, s.kit.points + RUN.winPoints + (stop.reward.points || 0));
  assert.equal(state.kit.money, 400 + stop.reward.money);
  for (const [id, n] of Object.entries(stop.reward.ammo || {})) assert.equal(state.kit.inventory[id], (s.kit.inventory[id] || 0) + n);
  assert.deepEqual(state.beaten.map((f) => f.name), stop.match.foes.map((f) => f.name));
  assert.equal(state.hulls, RUN.hulls);
  assert.equal(state.done, true);
  assert.match(rewardWords(outcome.reward), /\$\d+.*skill point/);
});

test('a fight lost costs a hull and moves on; with none left the run is over', () => {
  let s = startRun(SEEDS[2]);
  s = chooseStop(s, reachable(s)[0]);
  let r = applyFightResult(s, { won: false, kit: s.kit });
  assert.equal(r.outcome.hullLost, true);
  assert.equal(r.state.hulls, RUN.hulls - 1);
  assert.equal(r.state.over, null);
  assert.equal(r.state.kit.points, s.kit.points, 'no point for a loss');
  assert.equal(r.state.beaten.length, 0);
  s = r.state;
  s = chooseStop(s, reachable(s)[0]);
  if (currentStop(s).match) {
    r = applyFightResult(s, { won: false, kit: s.kit });
    assert.equal(r.state.hulls, 0);
    assert.equal(r.state.over, 'lost');
    assert.equal(r.outcome.over, 'lost');
    assert.deepEqual(reachable(r.state), []);
    assert.throws(() => applyFightResult(r.state, { won: true }), /no fight/);
  }
});

test('the boss: lost with a hull left you may try again; beaten, the run is won', () => {
  let s = startRun(SEEDS[3]);
  while (currentStop(s)?.kind !== 'boss') { s = chooseStop(s, reachable(s)[0]); if (currentStop(s).kind !== 'boss') s = settle(s); }
  assert.equal(s.path.length, RUN.tiers + 1);
  let r = applyFightResult(s, { won: false, kit: { ...s.kit, perks: ['thunderhead:airburst'], money: 9999 } });
  assert.equal(r.state.hulls, RUN.hulls - 1);
  assert.equal(r.state.done, false, 'still at the boss');
  assert.deepEqual(r.state.kit, s.kit, 'a retry starts from the kit brought to the boss');
  assert.equal(r.state.over, null);
  r = applyFightResult(r.state, { won: true, kit: r.state.kit });
  assert.equal(r.state.over, 'won');
  const sum = runSummary(r.state);
  assert.equal(sum.over, 'won');
  assert.equal(sum.route.length, RUN.tiers + 1);
  assert.equal(sum.route[sum.route.length - 1].kind, 'boss');
  assert.equal(sum.route[sum.route.length - 1].tries, 2);
  assert.ok(sum.fights.won >= 2 && sum.fights.lost === 1);
});

// ---------------------------------------------------------------- caches and depots

test('a cache: one of three, a skill point, a crate of ammo or money', () => {
  const seed = SEEDS.find((x) => { const s = walkTo(startRun(x), 'cache'); return s && currentStop(s).kind === 'cache'; });
  const s = walkTo(startRun(seed), 'cache');
  const stop = currentStop(s);
  const rank = applyCache(s, 'rank');
  assert.equal(rank.kit.points, s.kit.points + 1);
  const ammo = applyCache(s, 'ammo');
  for (const [id, n] of Object.entries(stop.offers[1].ammo)) assert.equal(ammo.kit.inventory[id], (s.kit.inventory[id] || 0) + n);
  const money = applyCache(s, 'money');
  assert.equal(money.kit.money, s.kit.money + stop.offers[2].money);
  assert.equal(money.done, true);
  assert.throws(() => applyCache(money, 'rank'), /no cache/, 'only one');
});

test('a depot: buy in the armory, swap one variant once, leave with the kit', () => {
  const seed = SEEDS.find((x) => { const s = walkTo(startRun(x), 'depot'); return s && currentStop(s).kind === 'depot'; });
  let s = walkTo(startRun(seed), 'depot');
  s = setKit(s, { ...s.kit, money: 1000, perks: ['napalm:sticky', 'napalm:up', 'hull'] });
  assert.deepEqual(forksTaken(s.kit).map((f) => f.taken), ['napalm:sticky']);
  // The armory: a kit game's tank buys, and the kit is read back out.
  const g = kitGame(s);
  const p = g.players[0];
  assert.ok(g.buy(p.id, 'napalm'));
  assert.ok(g.buy(p.id, 'armor'));
  s = swapVariant(s, 'napalm');
  assert.deepEqual(s.kit.perks, ['napalm:flood', 'napalm:up', 'hull'], 'the other side, upgrade kept');
  assert.throws(() => swapVariant(s, 'napalm'), /already swapped/);
  assert.throws(() => swapVariant(startRun(1), 'napalm'), /no depot/);
  const bought = kitOf(p);
  bought.perks = s.kit.perks;
  s = leaveDepot(s, bought);
  assert.equal(s.done, true);
  assert.equal(s.kit.inventory.napalm, 2);
  assert.equal(s.kit.pendingArmor, 30);
  assert.ok(s.kit.money < 1000);
});

test('skill points spent off the field, in a kit game, carry back into the run', () => {
  let s = startRun(SEEDS[4]);
  assert.equal(s.kit.points, RUN.start.points);
  const g = kitGame(s);
  const offer = g.draft[0];
  assert.ok(offer.includes('napalm:sticky') && offer.includes('hull'));
  assert.ok(g.pickPerk(0, 'napalm:sticky'));
  s = setKit(s, kitOf(g.players[0]));
  assert.deepEqual(s.kit.perks, ['napalm:sticky']);
  assert.equal(s.kit.points, 0);
});

// ---------------------------------------------------------------- the kit in a real match

test('the carried kit goes into a real match and comes back out of it', () => {
  let s = startRun(SEEDS[5], 'Tester');
  s = chooseStop(s, reachable(s)[0]);
  s = setKit(s, { ...s.kit, money: 500, inventory: { napalm: 2, breacher: 3 }, jets: 4, perks: ['napalm:sticky', 'pdturret', 'hull'], points: 2 });
  const cfg = matchConfig(s);
  assert.equal(cfg.players[0].name, 'Tester');
  assert.equal(cfg.seed, currentStop(s).match.seed);
  const g = new Game({ ...cfg, resolution: 64 });
  g.start();
  const me = g.players[0];
  assert.equal(me.money, 500);
  assert.equal(me.inventory.napalm, 2);
  assert.equal(me.inventory.breacher, 3);
  assert.equal(me.inventory.roller, 0, 'the carried kit replaces the starting one');
  assert.equal(me.inventory.shell, Infinity);
  assert.equal(me.jets, 4);
  assert.equal(me.points, 2);
  assert.deepEqual(me.perks, ['napalm:sticky', 'pdturret', 'hull']);
  assert.equal(g.weaponName(me, 'napalm'), 'Napalm · Sticky');
  assert.equal(g.modLevel(me, 'pointdef'), 1, 'the mod rank fits the mod');
  assert.equal(me.mods.pointdef.state, 'ready');
  assert.equal(me.maxHp, 120, 'Reinforced Hull counts; health is whole');
  assert.equal(me.hp, me.maxHp);
  // Win it: every foe down.
  for (const f of g.players.slice(1)) g.damage(f, 999, me.id);
  if (g.phase !== 'matchOver' && g.phase !== 'roundOver') g.nextTurn();
  while (g.phase === 'roundOver') { g.openShop(); g.closeShop(); for (const f of g.players.slice(1)) g.damage(f, 999, me.id); g.nextTurn(); }
  assert.equal(g.phase, 'matchOver');
  assert.equal(fightWon(g), true);
  const out = kitOf(me);
  assert.ok(out.money > 500, 'earned in the match');
  assert.equal(out.inventory.napalm, 2);
  assert.equal(out.inventory.shell, undefined, 'the Shell is not carried');
  const { state } = applyFightResult(s, { won: fightWon(g), kit: out });
  assert.equal(state.kit.money, out.money + currentStop(s).reward.money);
  assert.ok(state.kit.perks.includes('napalm:sticky'));
});

test('an Elite CPU starts with its mod up', () => {
  for (const seed of SEEDS) {
    const map = runMap(seed);
    const elite = map.stops.find((x) => x.kind === 'elite');
    if (!elite) continue;
    // Stand at the elite (a state as if walked there).
    const s = { ...startRun(seed), at: elite.id, done: false, path: [elite.id] };
    const g = new Game({ ...matchConfig(s), resolution: 64 });
    g.start();
    const foe = g.players[1];
    const mod = elite.match.foes[0].mod;
    assert.equal(foe.ai, 'hard');
    assert.equal(foe.mods[mod].state, 'up');
    assert.equal(g.modLevel(foe, mod), elite.match.foes[0].level);
    return;
  }
  assert.fail('no elite on any map');
});

test('the boss fight: you with your kit, an ally from the tanks you beat, against the Bulwark', () => {
  let s = startRun(SEEDS[6], 'Tester');
  s.beaten = [
    { name: 'Ivo', ai: 'easy', perks: [], elite: false },
    { name: 'Warden', ai: 'hard', perks: ['pdturret'], elite: true },
    { name: 'Juno', ai: 'normal', perks: ['hull'], elite: false },
  ];
  const choices = allyChoices(s);
  assert.deepEqual(choices.map((f) => f.name), ['Warden', 'Juno'], 'the elite, and the latest other');
  assert.deepEqual(allyChoices(startRun(1)).map((f) => f.name), ['Rook'], 'nobody beaten: a plain CPU');
  assert.equal(allyChoices({ beaten: [s.beaten[0], s.beaten[0]] }).length, 1);
  s = { ...s, at: 'boss', done: false, path: ['boss'], kit: { ...s.kit, perks: ['thunderhead:deep'], inventory: { thunderhead: 2 } } };
  const g = new Game({ ...matchConfig(s, { ally: choices[0] }), resolution: 64 });
  g.start();
  const [me, ally, boss] = g.players;
  assert.equal(boss.name, BOSS.name);
  assert.equal(ally.name, 'Warden');
  assert.equal(ally.ai, 'hard');
  assert.ok(ally.perks.includes('pdturret'), 'the ally keeps its ranks');
  assert.ok(me.perks.includes('thunderhead:deep') && !me.perks.includes('thunderhead:airburst'), 'a fork taken stays taken');
  assert.ok(ally.perks.includes('thunderhead:airburst'));
  assert.equal(me.inventory.thunderhead, 2 + BOSS.allyKit.thunderhead);
  g.damage(boss, boss.hp, me.id);
  g.nextTurn();
  assert.equal(fightWon(g), true);
});

// ---------------------------------------------------------------- saving

test('a run saves and loads back the same; a damaged or foreign save is no run', () => {
  const store = fakeStorage();
  assert.equal(loadRun(store), null);
  let s = startRun(SEEDS[7], 'Tester');
  s = chooseStop(s, reachable(s)[0]);
  s = applyFightResult(s, { won: true, kit: { ...s.kit, perks: ['napalm:sticky'] } }).state;
  s = chooseStop(s, reachable(s)[0]);
  saveRun(store, s);
  assert.ok(store.m.has(RUN_KEY));
  assert.ok(store.m.get(RUN_KEY).length < 4000, 'small');
  assert.deepEqual(loadRun(store), s);
  // Damaged, another version, a path the map does not have, unknown ranks.
  store.setItem(RUN_KEY, '{nope');
  assert.equal(loadRun(store), null);
  store.setItem(RUN_KEY, JSON.stringify({ ...s, v: 99 }));
  assert.equal(loadRun(store), null);
  store.setItem(RUN_KEY, JSON.stringify({ ...s, path: ['t0s0', 'boss'], at: 'boss' }));
  assert.equal(loadRun(store), null);
  store.setItem(RUN_KEY, JSON.stringify({ ...s, kit: { ...s.kit, perks: ['napalm:sticky', 'nonsense'], money: -5 } }));
  const loaded = loadRun(store);
  assert.deepEqual(loaded.kit.perks, ['napalm:sticky']);
  assert.equal(loaded.kit.money, 0);
  clearRun(store);
  assert.equal(loadRun(store), null);
});

test('the summary lists the route, the fights and the build', () => {
  let s = startRun(SEEDS[8]);
  s = setKit(s, { ...s.kit, perks: ['napalm:sticky', 'napalm:up', 'orbital', 'orbitalup', 'hull'] });
  s = chooseStop(s, reachable(s)[0]);
  s = applyFightResult(s, { won: true, kit: s.kit }).state;
  const sum = runSummary(s);
  assert.equal(sum.route.length, 1);
  assert.equal(sum.route[0].won, true);
  assert.equal(sum.fights.won, 1);
  assert.deepEqual(sum.build.variants, ['Napalm · Sticky +']);
  assert.deepEqual(sum.build.mods.map((m) => [m.id, m.level]), [['orbiter', 2]]);
  assert.deepEqual(kitMods(s.kit).length, 1);
  assert.deepEqual(sum.build.ranks, ['Reinforced Hull']);
  assert.ok(Object.keys(KINDS).every((k) => KINDS[k].name));
});
