import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, kitOf } from '../src/core/game.js';
import { BOSS } from '../src/core/boss.js';
import { WEAPONS, ITEMS } from '../src/core/weapons.js';
import {
  RUN, RUN_KEY, TIER_PLAN, KINDS, runMap, generateMap, crosses, stopSeed, startRun, reachable, chooseStop, currentStop,
  applyFightResult, applyCache, swapVariant, leaveDepot, setKit, forksTaken, allyChoices, matchConfig, kitGame, fightWon,
  loadRun, saveRun, clearRun, runSummary, stopDetails, rewardWords, kitMods, stopMoney, startFight, fightCutOff, runProgress,
  EVENTS, EVENT_BY_ID, LAST_KEY, mapOf, eventCard, applyEvent, nextWords, effectLines, saveLastRun, loadLastRun, matchNow, rewardNow,
  TIER_NAMES, allyWords, bossWords, rewardItems, variantSwaps, fightStats,
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
  if (stop.kind === 'event') return applyEvent(s, [...eventCard(s).choices].filter((c) => c.can).sort((a, b) => a.lines.length - b.lines.length)[0].id).state;
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

// ---------------------------------------------------------------- money, and the polish

test('a run fight pays a share of the usual match money; other matches pay in full', () => {
  let s = startRun(SEEDS[9], 'Tester');
  s = chooseStop(s, reachable(s)[0]);
  const cfg = matchConfig(s);
  assert.equal(cfg.pay, RUN.matchPay);
  assert.ok(RUN.matchPay > 0 && RUN.matchPay < 1);
  const play = (pay) => {
    const g = new Game({ ...cfg, pay, resolution: 64 });
    g.start();
    const me = g.players[0];
    const m0 = me.money;
    g.damage(g.players[1], 40, me.id);
    return { g, got: me.money - m0, earned: { ...me.earned } };
  };
  const full = play(1);
  const run = play(RUN.matchPay);
  assert.equal(full.got, 80, '$2 a point in full');
  assert.equal(run.got, Math.round(80 * RUN.matchPay));
  assert.equal(run.earned.damage, run.got, 'the results count what was really paid');
  // Every source is scaled: the kill, the round's stipend, survival and win too.
  const g = run.g;
  for (const f of g.players.slice(1)) g.damage(f, 999, 0);
  if (g.phase !== 'matchOver' && g.phase !== 'roundOver') g.nextTurn();
  const e = g.players[0].earned;
  assert.ok(e.win > 0 && e.win < 300 && e.stipend < 150 && e.kill < 150, JSON.stringify(e));
  // A plain match is untouched, and a silly pay is put right.
  assert.equal(new Game({ players: [{ name: 'A' }, { name: 'B' }], resolution: 16 }).cfg.pay, 1);
  assert.equal(new Game({ players: [{ name: 'A' }, { name: 'B' }], resolution: 16, pay: -2 }).cfg.pay, 1);
  assert.equal(new Game({ players: [{ name: 'A' }, { name: 'B' }], resolution: 16, pay: 50 }).cfg.pay, 4);
});

test('stop money follows RUN.money by tier; a two-round fight\'s foes bring money for the shop between rounds', () => {
  let twoRounds = 0;
  for (const seed of SEEDS.slice(0, 12)) {
    const map = generateMap(seed);
    for (const st of map.stops) {
      if (st.kind === 'fight' || st.kind === 'elite') assert.equal(st.reward.money, stopMoney(st.kind, st.tier));
      if (st.kind === 'cache') assert.equal(st.offers[2].money, stopMoney('cache', st.tier));
      if (st.kind === 'fight') {
        const cfg = matchConfig({ ...startRun(seed), at: st.id, done: false, path: [st.id] });
        for (const f of cfg.players.slice(1)) assert.equal(f.kit.money, st.match.rounds > 1 ? RUN.foeMoney : undefined);
        if (st.match.rounds > 1) twoRounds++;
      }
    }
  }
  assert.ok(twoRounds > 0);
  assert.equal(stopMoney('fight', 0), 60);
  assert.ok(stopMoney('elite', 3) > stopMoney('fight', 3), 'an Elite pays more');
});

test('money is a choice: no route\'s stop money buys one of everything in the armory', () => {
  const g = kitGame(startRun(1));
  const p = g.players[0];
  const armory = [...WEAPONS.filter((w) => w.price > 0 && !w.hidden && !w.fog), ...ITEMS]
    .reduce((sum, it) => sum + (Number.isFinite(g.priceOf(p, it.id)) ? g.priceOf(p, it.id) : 0), 0);
  for (const seed of SEEDS) {
    const map = runMap(seed);
    const money = (st) => (st.reward?.money || 0) + (st.offers ? st.offers[2].money : 0);
    const best = (st) => money(st) + Math.max(0, ...st.next.map((id) => best(map.byId[id])));
    const richest = RUN.start.money + Math.max(...map.tiers[0].map(best));
    assert.ok(richest < armory, `${seed}: $${richest} of stop money, the armory is $${armory}`);
  }
});

test('the result of a fight says what the match itself paid', () => {
  const s = chooseStop(startRun(SEEDS[10]), reachable(startRun(SEEDS[10]))[0]);
  const r = applyFightResult(s, { won: false, kit: { ...s.kit, money: s.kit.money + 75 } });
  assert.equal(r.outcome.pay, 75);
  assert.equal(r.state.kit.money, s.kit.money + 75, 'a loss keeps the match money');
  const w = applyFightResult(s, { won: true, kit: { ...s.kit, money: s.kit.money + 40 } });
  assert.equal(w.outcome.pay, 40);
  assert.equal(w.state.kit.money, s.kit.money + 40 + currentStop(s).reward.money);
});

test('beating the boss ends the run with no reward and no skill point', () => {
  let s = startRun(SEEDS[11]);
  while (currentStop(s)?.kind !== 'boss') { s = chooseStop(s, reachable(s)[0]); if (currentStop(s).kind !== 'boss') s = settle(s); }
  const { state, outcome } = applyFightResult(s, { won: true, kit: { ...s.kit, money: 9999, points: 7 } });
  assert.equal(state.over, 'won');
  assert.equal(outcome.reward, null);
  assert.equal(outcome.pay, 0);
  assert.equal(state.kit.points, s.kit.points, 'no point to spend after the end');
  assert.equal(state.kit.money, s.kit.money, 'the boss match\'s money is not kept');
  assert.equal(state.log[state.log.length - 1].reward, undefined);
});

test('a fight left by closing the page is marked, kept in the save, and cleared when the fight is settled', () => {
  const store = fakeStorage();
  let s = startRun(SEEDS[12]);
  assert.equal(fightCutOff(s), false);
  assert.throws(() => startFight(s), /no fight/, 'not before a stop is chosen');
  s = chooseStop(s, reachable(s)[0]);
  assert.equal(fightCutOff(s), false, 'chosen, not started');
  const started = startFight(s);
  assert.equal(s.fighting, null, 'the old state is untouched');
  assert.equal(started.fighting, s.at);
  assert.equal(fightCutOff(started), true);
  saveRun(store, started);
  const back = loadRun(store);
  assert.equal(fightCutOff(back), true, 'still marked after a reload');
  assert.deepEqual(back, started);
  // Settled: the mark goes.
  const done = applyFightResult(back, { won: true, kit: back.kit }).state;
  assert.equal(done.fighting, null);
  assert.equal(fightCutOff(done), false);
  // A mark that does not fit the save is dropped.
  store.setItem(RUN_KEY, JSON.stringify({ ...started, fighting: 'boss' }));
  assert.equal(loadRun(store).fighting, null);
  store.setItem(RUN_KEY, JSON.stringify({ ...done, fighting: done.at }));
  assert.equal(loadRun(store).fighting, null, 'not once the stop is settled');
  // A Cache has no fight to start.
  const cache = SEEDS.map((x) => walkTo(startRun(x), 'cache')).find((x) => x && currentStop(x).kind === 'cache');
  assert.throws(() => startFight(cache), /no fight/);
});

test('the map header: how far along, and the tier\'s name', () => {
  let s = startRun(SEEDS[13]);
  assert.deepEqual(runProgress(s), { n: 1, of: 7, name: TIER_NAMES[0], text: `Stop 1 of 7 · ${TIER_NAMES[0]}` });
  s = chooseStop(s, reachable(s)[0]);
  assert.equal(runProgress(s).n, 1, 'at the first stop');
  s = settle(s);
  assert.equal(runProgress(s).n, 2, 'settled: the next one');
  while (currentStop(s)?.kind !== 'boss') { s = chooseStop(s, reachable(s)[0]); if (currentStop(s).kind !== 'boss') s = settle(s); }
  assert.equal(runProgress(s).text, `Stop 7 of 7 · ${TIER_NAMES[6]}`);
  s = applyFightResult(s, { won: true, kit: s.kit }).state;
  assert.equal(runProgress(s).n, 7, 'the end stays on the last');
  assert.equal(TIER_NAMES.length, RUN.tiers + 1);
});

test('the boss\'s card shows its health and what it does, and the ally\'s ranks', () => {
  const d = stopDetails(runMap(SEEDS[14]).byId.boss);
  assert.equal(d.foes[0].level, `${BOSS.hp} hp`);
  assert.match(d.foes[0].extra, /Point Defense L\d/);
  const b = bossWords();
  assert.equal(b.hp, BOSS.hp);
  assert.ok(b.lines.some((l) => /Gravity Orbiter L\d/.test(l)));
  assert.ok(b.lines.some((l) => /from above/.test(l)));
  assert.deepEqual(allyWords({ name: 'Warden', ai: 'hard', elite: true, perks: ['pdturret', 'pdup', 'hull', 'hull', 'dugin'] }),
    { level: 'Elite', ranks: ['Point Defense L2', 'Reinforced Hull ×2', 'Dug In'] });
  assert.deepEqual(allyWords({ name: 'Rook', ai: 'normal', perks: [] }), { level: 'Normal', ranks: [] });
});

// ---------------------------------------------------------------- stage 4: stats, rewards, summary, swaps

test('a run keeps the damage you dealt and took: in the total and on each fight\'s line', () => {
  let s = startRun(SEEDS[20]);
  assert.deepEqual(s.stats, { dealt: 0, taken: 0 });
  s = chooseStop(s, reachable(s)[0]);
  const r = applyFightResult(s, { won: true, kit: s.kit, stats: { damage: 212.4, taken: 77 } });
  assert.deepEqual(r.state.stats, { dealt: 212, taken: 77 });
  assert.equal(r.state.log[0].dealt, 212);
  assert.equal(r.state.log[0].taken, 77);
  assert.deepEqual(s.stats, { dealt: 0, taken: 0 }, 'the state given is not changed');
  // A lost fight adds too; junk counts as nothing.
  let t = chooseStop(r.state, reachable(r.state)[0]);
  t = applyFightResult(t, { won: false, kit: t.kit, stats: { damage: 40, taken: NaN } }).state;
  assert.deepEqual(t.stats, { dealt: 252, taken: 77 });
  // Without stats (an older caller) nothing breaks.
  const u = chooseStop(t, reachable(t)[0]);
  assert.deepEqual(applyFightResult(u, { won: true, kit: u.kit }).state.stats, { dealt: 252, taken: 77 });
  const sum = runSummary(t);
  assert.deepEqual(sum.damage, { dealt: 252, taken: 77 });
  assert.deepEqual(sum.route.map((x) => [x.dealt, x.taken]), [[212, 77], [40, 0]]);
  // The totals come from a real game's first tank.
  const g = new Game({ players: [{ name: 'A', ai: null }, { name: 'B', ai: 'easy' }], seed: 5, resolution: 16 });
  g.players[0].stats.damage = 90.6;
  g.players[0].stats.taken = 12;
  assert.deepEqual(fightStats(g), { damage: 91, taken: 12 });
});

test('the totals survive a save, and a save from before them loads as zeros', () => {
  const store = fakeStorage();
  let s = startRun(SEEDS[21], 'Tester');
  s = chooseStop(s, reachable(s)[0]);
  s = applyFightResult(s, { won: true, kit: s.kit, stats: { damage: 150, taken: 30 } }).state;
  saveRun(store, s);
  assert.deepEqual(loadRun(store).stats, { dealt: 150, taken: 30 });
  assert.deepEqual(loadRun(store), s);
  // An old save: no `stats`, and its log lines have no damage.
  const old = JSON.parse(JSON.stringify(s));
  delete old.stats;
  for (const l of old.log) { delete l.dealt; delete l.taken; }
  store.setItem(RUN_KEY, JSON.stringify(old));
  const loaded = loadRun(store);
  assert.ok(loaded, 'still loads');
  assert.deepEqual(loaded.stats, { dealt: 0, taken: 0 });
  assert.deepEqual(runSummary(loaded).route.map((x) => [x.dealt, x.taken]), [[0, 0]]);
  // It plays on: the next fight adds to the zeros.
  const map = runMap(loaded.seed);
  const next = chooseStop(loaded, reachable(loaded).find((id) => map.byId[id].match));
  assert.deepEqual(applyFightResult(next, { won: true, kit: next.kit, stats: { damage: 20, taken: 5 } }).state.stats, { dealt: 20, taken: 5 });
  // Damaged totals are cleaned.
  store.setItem(RUN_KEY, JSON.stringify({ ...s, stats: { dealt: -4, taken: 'lots' } }));
  assert.deepEqual(loadRun(store).stats, { dealt: 0, taken: 0 });
});

test('a reward or an offer is itemised by kind, with the crate\'s real weapon names', () => {
  assert.deepEqual(rewardItems(null), []);
  const items = rewardItems({ money: 180, ammo: { napalm: 2, breacher: 1 }, points: 2 });
  assert.deepEqual(items.map((i) => i.kind), ['money', 'ammo', 'point']);
  assert.equal(items[0].text, '$180');
  assert.deepEqual(items[1].items, [{ id: 'napalm', n: 2, name: 'Napalm' }, { id: 'breacher', n: 1, name: 'Breacher' }]);
  assert.equal(items[1].text, '2 Napalm · 1 Breacher');
  assert.equal(items[2].text, '+2 skill points');
  // Every cache's three offers each make one item of their own kind.
  for (const seed of SEEDS) {
    for (const st of runMap(seed).stops.filter((x) => x.kind === 'cache')) {
      const kinds = st.offers.map((o) => rewardItems(o).map((i) => i.kind));
      assert.deepEqual(kinds, [['point'], ['ammo'], ['money']]);
      const crate = rewardItems(st.offers[1])[0];
      assert.ok(crate.items.length >= 2 && crate.items.every((i) => i.name && i.name !== i.id));
      assert.equal(rewardWords(st.offers[1]), crate.text, 'agrees with the older wording');
    }
  }
});

test('the summary has the route\'s foes, the cache taken, and the damage per stop', () => {
  let s = walkTo(startRun(SEEDS[22]), 'cache');
  if (!s) s = walkTo(startRun(SEEDS[23]), 'cache');
  assert.ok(s, 'a cache on the way');
  const cache = currentStop(s);
  s = applyCache(s, 'ammo');
  const sum = runSummary(s);
  const last = sum.route[sum.route.length - 1];
  assert.equal(last.kind, 'cache');
  assert.equal(last.took, rewardWords(cache.offers[1]));
  assert.ok(last.took.length > 0);
  const fights = sum.route.filter((r) => r.kind !== 'cache');
  assert.ok(fights.length >= 1);
  for (const f of fights) {
    assert.ok(f.foes.length >= 1 && f.foes.every((n) => typeof n === 'string' && n), 'foe names');
    assert.ok(f.where);
  }
});

test('a depot\'s swaps say what you have and what you would switch to', () => {
  assert.deepEqual(variantSwaps({ perks: [] }), []);
  const kit = { perks: ['napalm:sticky', 'napalm:up', 'roller:seeker'] };
  const swaps = variantSwaps(kit);
  const nap = swaps.find((x) => x.weapon === 'napalm');
  assert.equal(nap.name, 'Napalm');
  assert.equal(nap.now.id, 'napalm:sticky');
  assert.equal(nap.then.id, 'napalm:flood');
  assert.equal(nap.upgrade, true);
  assert.ok(nap.now.desc && !/^Napalm becomes/.test(nap.now.desc), 'without the lead-in');
  assert.ok(nap.then.desc.length > 10);
  assert.equal(swaps.find((x) => x.weapon === 'roller').upgrade, false);
  // After a swap the sides turn over, and the upgrade stays.
  let s = null;
  for (const seed of SEEDS) { s = walkTo(startRun(seed), 'depot'); if (s) break; }
  assert.ok(s, 'a depot on some map');
  s = setKit(s, { ...s.kit, perks: kit.perks });
  s = swapVariant(s, 'napalm');
  const after = variantSwaps(s.kit).find((x) => x.weapon === 'napalm');
  assert.equal(after.now.id, 'napalm:flood');
  assert.equal(after.then.id, 'napalm:sticky');
  assert.equal(after.upgrade, true);
});

// ---------------------------------------------------------------- events

// A state standing at the first Event stop of event `id`, found over the seeds
// (fights before it settled as wins), with a kit rich enough for any choice.
function atEvent(id, kit = {}) {
  for (let seed = 1; seed < 3000; seed += 7) {
    const map = runMap(seed);
    const stop = map.stops.find((x) => x.kind === 'event' && x.event.id === id);
    if (!stop) continue;
    let s = startRun(seed, 'Tester');
    // The way in: walk back from the stop to the first tier.
    const route = [stop.id];
    while (map.byId[route[0]].tier > 0) route.unshift(map.stops.find((x) => x.next.includes(route[0]) && x.tier === map.byId[route[0]].tier - 1).id);
    for (const sid of route.slice(0, -1)) { s = chooseStop(s, sid); s = settle(s); }
    s = chooseStop(s, stop.id);
    return { ...s, kit: { ...s.kit, money: 1000, points: 1, ...kit }, hulls: 1 };
  }
  throw new Error(`no map has ${id}`);
}

test('Event stops are placed in the middle tiers from the seed alone, and keep every route seven stops', () => {
  assert.deepEqual(generateMap(SEEDS[3]), generateMap(SEEDS[3]));
  let withEvent = 0;
  const seen = new Set();
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    const events = map.stops.filter((s) => s.kind === 'event');
    if (events.length) withEvent++;
    const ids = events.map((s) => s.event.id);
    assert.equal(new Set(ids).size, ids.length, 'no event twice on a map');
    for (const s of events) {
      assert.ok(s.tier >= 1 && s.tier <= 4, 'only in the middle tiers');
      assert.ok(EVENT_BY_ID[s.event.id]);
      assert.ok(Object.keys(s.event.crate).length >= 1 && s.event.luck >= 0 && s.event.luck <= 1);
      assert.equal(s.match, undefined);
      seen.add(s.event.id);
    }
    for (const tier of map.tiers.slice(0, RUN.tiers)) assert.ok(tier.some((x) => x.kind === 'fight'), 'a fight in every tier');
  }
  assert.ok(withEvent >= SEEDS.length * 0.5, `${withEvent} of ${SEEDS.length} maps have an event`);
  assert.ok(seen.size >= 5, 'the variety shows up');
  assert.ok(KINDS.event.name && KINDS.event.desc);
});

test('a map from before Event stops (mapv 1) is the old map, with none', () => {
  for (const seed of SEEDS.slice(0, 15)) {
    const old = generateMap(seed, 1);
    assert.ok(old.stops.every((s) => s.kind !== 'event'));
    assert.equal(runMap(seed, 1), mapOf({ seed, mapv: 1 }));
    assert.equal(runMap(seed, 1), mapOf({ seed }), 'no mapv: the old one');
    assert.equal(runMap(seed), mapOf({ seed, mapv: 2 }));
  }
});

test('there are six to eight events, each with two or three choices, one of which can always be taken', () => {
  assert.ok(EVENTS.length >= 6 && EVENTS.length <= 8);
  for (const ev of EVENTS) {
    assert.ok(ev.name && ev.text.length > 40);
    assert.ok(ev.choices.length >= 2 && ev.choices.length <= 3, ev.id);
    assert.equal(new Set(ev.choices.map((c) => c.id)).size, ev.choices.length);
    assert.ok(ev.choices.some((c) => !c.needs), `${ev.id} has a choice that asks nothing`);
  }
});

test('every event\'s choices apply as written', () => {
  for (const ev of EVENTS) {
    for (const ch of ev.choices) {
      const s = atEvent(ev.id);
      const stop = currentStop(s);
      const card = eventCard(s);
      assert.equal(card.name, ev.name);
      assert.equal(card.choices.length, ev.choices.length);
      const needsRoom = ch.needs?.hullsBelow;
      const from = needsRoom ? { ...s, hulls: RUN.hulls - 1 } : s;
      assert.ok(eventCard(from).choices.find((c) => c.id === ch.id).can, `${ev.id}/${ch.id} can be taken`);
      const { state, outcome } = applyEvent(from, ch.id);
      const g = ch.gives;
      const win = stop.event.luck < 0.5;
      const wager = g.wager ? (win ? g.wager.prize - g.wager.stake : -g.wager.stake) : 0;
      assert.equal(state.kit.money, from.kit.money + (g.money || 0) + wager, `${ev.id}/${ch.id} money`);
      assert.equal(state.kit.points, from.kit.points + (g.points || 0));
      assert.equal(state.kit.jets, from.kit.jets + (g.jets || 0));
      assert.equal(state.kit.pendingArmor, from.kit.pendingArmor + (g.armor || 0));
      assert.equal(state.kit.pendingFuel, from.kit.pendingFuel + (g.fuel || 0));
      assert.equal(state.hulls, Math.max(0, Math.min(RUN.hulls, from.hulls + (g.hulls || 0))));
      const gained = (id) => (state.kit.inventory[id] || 0) - (from.kit.inventory[id] || 0);
      for (const [id, n] of Object.entries(stop.event.crate)) assert.equal(gained(id), g.crate ? n : 0, 'the stop\'s own crate');
      assert.equal(nextWords(state.next).length > 0, !!g.next);
      for (const [k, v] of Object.entries(g.next || {})) assert.equal(state.next[k], v);
      assert.equal(state.done, true);
      assert.equal(state.log.at(-1).kind, 'event');
      assert.equal(state.log.at(-1).choice, ch.id);
      assert.equal(outcome.lines.length, effectLines(g, stop.event, true).length);
      assert.deepEqual(reachable(state), currentStop(state).next, 'moves on after');
      assert.equal(from.done, false, 'the state given is not changed');
      assert.throws(() => applyEvent(state, ch.id), /no event/, 'once');
    }
  }
});

test('a choice you cannot pay for, or have no use for, is refused', () => {
  const poor = atEvent('trade', { money: 150 });
  assert.equal(eventCard(poor).choices.find((c) => c.id === 'train').can, false);
  assert.match(eventCard(poor).choices.find((c) => c.id === 'train').why, /\$200/);
  assert.throws(() => applyEvent(poor, 'train'), /\$200/);
  assert.equal(applyEvent(poor, 'crate').state.kit.money, 70);
  assert.throws(() => applyEvent(poor, 'nope'), /no nope/);
  const whole = { ...atEvent('yard'), hulls: RUN.hulls };
  assert.equal(eventCard(whole).choices.find((c) => c.id === 'patch').can, false);
  const none = { ...atEvent('yard'), hulls: 0 };
  assert.throws(() => applyEvent(none, 'sell'), /spare hull/);
  const fight = chooseStop(startRun(SEEDS[0]), reachable(startRun(SEEDS[0]))[0]);
  assert.throws(() => applyEvent(fight, 'leave'), /no event/);
});

test('the wager is decided by the stop\'s luck, so opening the run again plays the same', () => {
  const s = atEvent('wager');
  const stop = currentStop(s);
  const out = applyEvent(s, 'play');
  assert.equal(out.state.kit.money, s.kit.money + (stop.event.luck < 0.5 ? 150 : -100));
  assert.deepEqual(applyEvent(JSON.parse(JSON.stringify(s)), 'play').outcome, out.outcome);
});

test('what an event leaves on the next fight reaches the match and the reward, and is used up', () => {
  // The storm: Rain forced, the fight pays double (its reward and the match's pay).
  let s = applyEvent(atEvent('storm'), 'ride').state;
  assert.deepEqual(s.next, { modifier: 'rain', pay: 2 });
  s = chooseStop(s, reachable(s).find((id) => runMap(s.seed).byId[id].match) || reachable(s)[0]);
  const stop = currentStop(s);
  assert.ok(stop.match, 'a fight follows an event (every tier has one)');
  const cfg = matchConfig(s);
  assert.equal(cfg.modifier, 'rain');
  assert.equal(cfg.pay, RUN.matchPay * 2);
  assert.equal(stopDetails(stop, s.next).modifier, 'Rain');
  assert.equal(stopDetails(stop, s.next).changed, stop.match.modifier !== 'rain');
  const won = applyFightResult(s, { won: true, kit: s.kit });
  assert.equal(won.outcome.reward.money, stop.reward.money * 2);
  assert.equal(won.state.next, null, 'used up');
  assert.equal(applyFightResult(s, { won: false, kit: s.kit }).state.next, null, 'a lost fight uses it too');
  assert.equal(matchConfig(startRunAt(s)).pay, RUN.matchPay);
  // The crawler's beacon: the CPUs start with armor.
  let c = applyEvent(atEvent('crawler'), 'salvage').state;
  c = chooseStop(c, reachable(c).find((id) => runMap(c.seed).byId[id].match));
  for (const p of matchConfig(c).players.slice(1)) assert.equal(p.kit.pendingArmor, 25);
  // The bounty: a bonus on the reward, and a Gale at least.
  let b = applyEvent(atEvent('bounty'), 'hard').state;
  b = chooseStop(b, reachable(b).find((id) => runMap(b.seed).byId[id].match));
  const bs = currentStop(b);
  assert.ok(matchConfig(b).maxWind >= 2.5);
  assert.equal(rewardNow(bs, b.next).money, bs.reward.money + 150);
  assert.equal(matchNow(bs, null).maxWind, bs.match.maxWind);
});
// The same stop's match with the Event's say taken off.
const startRunAt = (s) => ({ ...s, next: null });

test('the armor an event gives is the kit\'s own: it goes into the next real match', () => {
  const s = applyEvent(atEvent('crawler'), 'strip').state;
  assert.equal(s.kit.pendingArmor, 20);
  const t = chooseStop(s, reachable(s).find((id) => runMap(s.seed).byId[id].match));
  const g = new Game({ ...matchConfig(t), resolution: 16 });
  g.start();
  assert.equal(g.players[0].armor, 20);
});

test('a save with an event waiting for its choice, and one after it, load back the same', () => {
  const store = fakeStorage();
  const s = atEvent('storm');
  assert.equal(s.done, false);
  saveRun(store, s);
  assert.deepEqual(loadRun(store), s);
  assert.equal(eventCard(loadRun(store)).name, EVENT_BY_ID.storm.name);
  const after = applyEvent(loadRun(store), 'ride').state;
  saveRun(store, after);
  const back = loadRun(store);
  assert.deepEqual(back, after);
  assert.deepEqual(back.next, { modifier: 'rain', pay: 2 });
  assert.ok(JSON.stringify(after).length < 6000, 'small');
  // A damaged `next` is tidied, not trusted.
  store.setItem(RUN_KEY, JSON.stringify({ ...after, next: { modifier: 'bogus', pay: 'lots', wind: -3, foeArmor: 1e9, bonus: 12.7 } }));
  assert.deepEqual(loadRun(store).next, { foeArmor: 200, bonus: 12 });
});

test('a save from before events (no mapv, no next) still loads, on its old map', () => {
  const store = fakeStorage();
  let s = startRun(SEEDS[5], 'Old');
  s.mapv = 1;
  const old = runMap(SEEDS[5], 1);
  s = chooseStop(s, old.tiers[0][0].id);
  assert.equal(mapOf(s), old);
  s = applyFightResult(s, { won: true, kit: s.kit }).state;
  s = chooseStop(s, reachable(s)[0]);
  const raw = JSON.parse(JSON.stringify(s));
  delete raw.mapv;
  delete raw.next;
  store.setItem(RUN_KEY, JSON.stringify(raw));
  const loaded = loadRun(store);
  assert.ok(loaded, 'loads');
  assert.equal(loaded.mapv, 1);
  assert.equal(loaded.next, null);
  assert.deepEqual(loaded.path, s.path);
  assert.equal(currentStop(loaded), old.byId[s.at]);
  assert.ok(loaded.path.every((id) => old.byId[id].kind !== 'event'));
  assert.deepEqual(reachable(settle(loaded)), old.byId[s.at].next);
  assert.equal(runSummary(loaded).route.length, 2);
  // A new run records its generator.
  assert.equal(startRun(5).mapv, RUN.mapVersion);
});

test('the summary names the event and what you chose', () => {
  const s = applyEvent(atEvent('relay'), 'thrusters').state;
  const row = runSummary(s).route.at(-1);
  assert.equal(row.kind, 'event');
  assert.equal(row.name, 'Event');
  assert.match(row.detail, /Fallen relay/);
  assert.match(row.detail, /thrusters/);
});

test('the last finished run is kept to read its summary again', () => {
  const store = fakeStorage();
  let s = startRun(SEEDS[9], 'Tester');
  assert.equal(loadLastRun(store), null);
  saveLastRun(store, s);
  assert.equal(store.m.has(LAST_KEY), false, 'a run still going is not kept');
  s = chooseStop(s, reachable(s)[0]);
  s = applyFightResult(s, { won: false, kit: s.kit }).state;
  s = { ...s, hulls: 0, over: 'lost' };
  saveLastRun(store, s);
  assert.ok(store.m.has(LAST_KEY));
  assert.ok(store.m.get(LAST_KEY).length < 6000, 'small');
  const last = loadLastRun(store);
  assert.equal(last.over, 'lost');
  assert.deepEqual(runSummary(last), runSummary(s));
  assert.equal(loadRun(store), null, 'apart from the run in progress');
  store.setItem(LAST_KEY, '{nope');
  assert.equal(loadLastRun(store), null);
  store.setItem(LAST_KEY, JSON.stringify({ ...s, over: null }));
  assert.equal(loadLastRun(store), null, 'a run that has not ended is no last run');
});

