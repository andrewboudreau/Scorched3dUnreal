// Plays whole runs headlessly (core/run.js) to see how the money goes: a CPU
// sits in the human's seat, fights every fight, takes the Pay chest at a
// Cache, spends its skill points and shops at a Depot from a wish list.
// Prints the money at each stop: before it, what its match paid (`match`),
// what the seat spent in the shop between a match's rounds (`shop`), the
// stop's reward, what the Depot sold (`depot`), and the money after. The
// boss match's money is left out: its kit is not kept.
//
//   node tools/runsim.mjs [runs=4] [--ai hard|normal|easy] [--seed N] [--res 96] [--hulls N] [--hoard] [--old]
//                         [--legacy] [--events random|leave]
//
// --legacy plays the maps from before Event stops (no events at all);
// --events says how the seat treats an Event: `random` takes a random choice it
// can afford (the default), `leave` takes the choice that does least.
//
// --hulls gives the seat more spare hulls, so a weak seat still sees the
// whole map; --hoard keeps the seat out of the shop between a match's rounds
// (all its money reaches the Depot); --old plays by the money rules from
// before the economy pass. A run takes about a second (a whole match per fight).

import { Game, kitOf } from '../src/core/game.js';
import {
  RUN, mapOf, startRun, reachable, chooseStop, currentStop, applyFightResult, applyCache, leaveDepot, setKit,
  allyChoices, matchConfig, kitGame, fightWon, KINDS, eventCard, applyEvent,
} from '../src/core/run.js';
import { WEAPONS, ITEMS } from '../src/core/weapons.js';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const runs = Number(args.find((a, i) => /^\d+$/.test(a) && !String(args[i - 1]).startsWith('--')) || 4);
const ai = opt('ai', 'hard');
const seed0 = Number(opt('seed', 4242));
const res = Number(opt('res', 96));
const hulls = opt('hulls', null);
const legacy = args.includes('--legacy');   // the maps from before Event stops
const events = opt('events', 'random');
const hoard = args.includes('--hoard');   // the seat never shops between a match's rounds
// --old: the money rules before the run's economy pass (full match pay, the
// first stop rewards), to compare against.
if (args.includes('--old')) Object.assign(RUN, { matchPay: 1, money: { fight: [80, 40], elite: [200, 60], cache: [200, 50] } });

// What a player buys at a Depot, in order, round and round while the money lasts.
const WISH = ['breacher', 'thunderhead', 'scatter', 'armor', 'napalm', 'roller', 'flak', 'jet', 'dirtbomb', 'teleport', 'mound', 'fuel', 'ranger', 'guided'];
// One purchase of everything the Depot sells (the armory, once each).
const ARMORY = [...WEAPONS.filter((w) => w.price > 0 && !w.hidden && !w.fog), ...ITEMS];
const armoryTotal = (g, p) => ARMORY.reduce((s, it) => s + (Number.isFinite(g.priceOf(p, it.id)) ? g.priceOf(p, it.id) : 0), 0);

function spendPoints(s) {
  const g = kitGame(s);
  const p = g.players[0];
  for (let k = 0; k < 10 && p.points > 0; k++) {
    const offer = g.draft[p.id] || [];
    if (!offer.length || !g.pickPerk(p.id, offer[k % offer.length])) break;
  }
  return setKit(s, kitOf(p));
}

function playFight(s) {
  const stop = currentStop(s);
  const ally = stop.kind === 'boss' ? allyChoices(s)[0] : null;
  const cfg = matchConfig(s, { ally });
  cfg.players[0].ai = ai;
  const g = new Game({ ...cfg, resolution: res });
  let earned = 0;
  const earn = g.earn.bind(g);
  g.earn = (p, kind, amount) => { const m = p.money; earn(p, kind, amount); if (p.id === 0) earned += p.money - m; };
  if (hoard) { const shop = g.aiShop.bind(g); g.aiShop = (p) => { if (p.id !== 0) shop(p); }; }
  g.start();
  for (let k = 0; k < 400000 && g.phase !== 'matchOver'; k++) {
    if (g.phase === 'roundOver') { g.openShop(); if (g.phase === 'shop') g.closeShop(); continue; }
    g.update(1 / 20);
    g.drainEvents();
  }
  return { won: fightWon(g), kit: kitOf(g.players[0]), earned };
}

function oneRun(seed) {
  let s = startRun(seed, 'Sim');
  if (legacy) s.mapv = 1;
  if (hulls != null) s.hulls = Number(hulls);
  const rows = [];
  let pick = seed;
  while (!s.over) {
    s = spendPoints(s);
    const next = reachable(s);
    if (!next.length) break;
    const map = mapOf(s);
    pick = (pick * 1103515245 + 12345) >>> 0;
    const id = next[(pick >>> 16) % next.length];
    s = chooseStop(s, id);
    const stop = map.byId[id];
    const row = { stop: `${stop.tier + 1}`, kind: KINDS[stop.kind].name, before: s.kit.money, match: 0, shop: 0, reward: 0, depot: 0, event: 0, after: 0, won: '' };
    if (stop.match) {
      let tries = 0;
      do {
        const before = s.kit.money;
        const r = playFight(s);
        const res = applyFightResult(s, { won: r.won, kit: r.kit });
        if (stop.kind !== 'boss') { row.match += r.earned; row.shop += r.earned - (r.kit.money - before); }
        row.reward += res.outcome.reward?.money || 0;
        row.won += r.won ? 'W' : 'L';
        s = res.state;
        tries++;
      } while (!s.done && !s.over && tries < 3);
    } else if (stop.kind === 'cache') {
      s = applyCache(s, 'money');
      row.reward = s.kit.money - row.before;
    } else if (stop.kind === 'event') {
      const can = eventCard(s).choices.filter((c) => c.can);
      pick = (pick * 1103515245 + 12345) >>> 0;
      const choice = events === 'leave' ? [...can].sort((a, b) => a.lines.length - b.lines.length)[0] : can[(pick >>> 16) % can.length];
      s = applyEvent(s, choice.id).state;
      row.event = s.kit.money - row.before;
      row.what = choice.label;
    } else if (stop.kind === 'depot') {
      const g = kitGame(s);
      const p = g.players[0];
      row.armory = armoryTotal(g, p);
      const start = p.money;
      for (let again = true; again;) { again = false; for (const w of WISH) if (g.buy(p.id, w)) again = true; }
      row.depot = start - p.money;
      s = leaveDepot(s, { ...kitOf(p), perks: s.kit.perks });
    }
    row.after = s.kit.money;
    rows.push(row);
  }
  return { rows, over: s.over, hulls: s.hulls };
}

const pad = (v, n) => String(v).padStart(n);
const sum = { match: 0, shop: 0, reward: 0, depot: 0, event: 0, events: 0, depots: 0, armory: 0, n: 0, atDepot: 0, beforeBoss: 0 };
for (let r = 0; r < runs; r++) {
  const seed = seed0 + r * 7919;
  const t0 = Date.now();
  const { rows, over, hulls: left } = oneRun(seed);
  console.log(`\nrun seed ${seed} (${ai} in the seat): ${over || 'unfinished'}, ${left} hull${left === 1 ? '' : 's'} left, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('stop kind     before  match   shop  reward  event  depot  after  fights');
  for (const x of rows) {
    console.log(`${pad(x.stop, 4)} ${x.kind.padEnd(7)} ${pad(x.before, 7)} ${pad(x.match, 6)} ${pad(-x.shop, 6)} ${pad(x.reward, 7)} ${pad(x.event, 6)} ${pad(-x.depot, 6)} ${pad(x.after, 6)}  ${x.won}${x.what ? `${x.what}` : ''}${x.armory ? `  (one of everything: $${x.armory})` : ''}`);
    sum.match += x.match; sum.shop += x.shop; sum.reward += x.reward; sum.depot += x.depot; sum.event += x.event; if (x.kind === 'Event') sum.events++;
    if (x.armory) { sum.depots++; sum.armory = x.armory; sum.atDepot += x.before; }
    if (x.kind === 'Boss') sum.beforeBoss += x.before;
  }
  sum.n++;
}
const avg = (v) => Math.round(v / sum.n);
console.log(`\nper run, on average: start $${RUN.start.money}, match pay $${avg(sum.match)} (spent between rounds $${avg(sum.shop)}), stop rewards $${avg(sum.reward)}, events ${(sum.events / sum.n).toFixed(1)} a run (net $${avg(sum.event)}),`
  + ` depots ${(sum.depots / sum.n).toFixed(1)} a run (money on arriving $${sum.depots ? Math.round(sum.atDepot / sum.depots) : 0}, spent $${avg(sum.depot)}), money at the boss $${avg(sum.beforeBoss)}; one of everything at a depot: $${sum.armory}`);
