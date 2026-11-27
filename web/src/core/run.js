// The run (docs/design-guide.md, "The run"): a solo campaign across a short
// map of stops, kit carried from one fight to the next, ending in the boss.
//
// Everything here is data and pure functions, with no DOM and no three.js.
// The map is generated from the run's seed alone (`runMap`), so a saved run
// only keeps the seed and what happened; each stop's match seed comes from the
// run seed and the stop. The run's state is a small JSON record:
//
//   { v, seed, name, at, done, path, kit, hulls, beaten, log, over, swapped }
//
//   at       the stop you are at (null before the first)
//   done     whether that stop is settled (a fight played, a cache taken, the
//            depot left); only then can you move on
//   path     the stops visited, in order
//   kit      what you carry (game.js kitOf / giveKit): money, ammo, jets,
//            ranks (perk ids, variants like 'napalm:sticky' and mod ranks:
//            a mod's level is its ranks), unspent skill points, gear
//   hulls    spare hulls: a lost fight costs one; at none the run is over
//   beaten   the CPUs beaten on the way, the boss fight's possible allies
//   log      one line per stop settled, for the summary
//   over     null, 'won' or 'lost'
//   swapped  the depot where a variant was already swapped (once a visit)
//
// The functions that move it on (chooseStop, applyFightResult, applyCache,
// swapVariant, leaveDepot, setKit) return a new state and never change the one
// they are given.

import { makeRng } from './rng.js';
import { Game, kitOf } from './game.js';
import { WEAPONS, WEAPON_BY_ID, startKit } from './weapons.js';
import { PERK_BY_ID, MODIFIERS, MODIFIER_BY_ID } from './perks.js';
import { MODS, modLevel } from './mods.js';
import { BRANCHES, forkTaken } from './skills.js';
import { TIMES, timeName } from './timeofday.js';
import { RIDGE } from './ridgeline.js';
import { ISLAND } from './island.js';
import { BOSS, bossMatch } from './boss.js';

export const RUN = {
  version: 1,
  tiers: 6,                         // tiers of stops before the boss: six stops and the boss
  perTier: [2, 3],                  // stops in a tier
  hulls: 2,                         // spare hulls at the start
  start: { money: 150, points: 1 }, // and the starting kit (weapons.js startKit)
  winPoints: 1,                     // skill points for a fight won
  // The Lab every run match uses: mods come from the skill tree.
  lab: { satellite: 'perk', level: 1, labels: 'some', orbiter: 'perk', orbiterLevel: 1 },
};

export const RUN_KEY = 'craterfall.run.v1';

// What a stop can be (the design guide's table). `icon` names the map's drawing.
export const KINDS = {
  fight: { name: 'Fight', desc: 'A short match against one or two CPUs.' },
  elite: { name: 'Elite', desc: 'A tougher CPU with a mod already up. A better reward.' },
  cache: { name: 'Cache', desc: 'No fight: take one of three.' },
  depot: { name: 'Depot', desc: 'No fight: the armory, and you may swap one variant.' },
  boss: { name: 'Boss', desc: 'The Bulwark on its fort: you and an ally against it.' },
};

export const WORLDS = [
  { id: 'rolling', name: 'Rolling', hills: 20, world: 'meadow', weight: 2 },
  { id: 'hilly', name: 'Hilly', hills: 45, world: 'meadow', weight: 2 },
  { id: 'mountains', name: 'Mountains', hills: 80, world: 'meadow', weight: 2 },
  { id: 'city', name: 'City', hills: 20, world: 'city', weight: 1 },
  { id: 'isles', name: 'Floating isles', hills: 45, world: 'isles', weight: 1 },
  { id: 'ridgeline', name: 'Ridgeline', hills: RIDGE.hills, world: 'ridgeline', weight: 1 },
  { id: 'island', name: 'Island', hills: ISLAND.hills, world: 'island', weight: 1 },
];
export const WORLD_BY_ID = Object.fromEntries(WORLDS.map((w) => [w.id, w]));
export const WINDS = [
  { value: 0, name: 'Calm', weight: 1 },
  { value: 0.8, name: 'Breezy', weight: 2 },
  { value: 1.5, name: 'Gusty', weight: 2 },
  { value: 2.5, name: 'Gale', weight: 1 },
];
export const RUN_EDGES = [
  { id: 'open', name: 'Open', weight: 4 },
  { id: 'wall', name: 'Wall', weight: 2 },
  { id: 'bounce', name: 'Bounce', weight: 1 },
  { id: 'wrap', name: 'Wrap', weight: 1 },
];

// Each tier: the kinds its stops are drawn from (the first always comes, so
// every tier has a fight to pick), the foes a Fight puts up (one CPU or two)
// and how many rounds it may last. The foes get harder as the map goes on.
export const TIER_PLAN = [
  { kinds: ['fight', 'fight', 'fight'], foes: [['easy'], ['easy', 'easy']], rounds: [1] },
  { kinds: ['fight', 'fight', 'cache'], foes: [['normal'], ['easy', 'normal']], rounds: [1] },
  { kinds: ['fight', 'elite', 'fight'], foes: [['normal'], ['easy', 'normal']], rounds: [1, 2] },
  { kinds: ['fight', 'depot', 'elite'], foes: [['hard'], ['normal', 'normal']], rounds: [1, 2] },
  { kinds: ['fight', 'elite', 'cache'], foes: [['hard'], ['normal', 'hard']], rounds: [1, 2] },
  { kinds: ['fight', 'depot', 'cache'], foes: [['hard'], ['hard', 'normal']], rounds: [1, 2] },
];

// A Fight's CPUs take a rank of these per two tiers; an Elite one more, and its mod.
const FOE_PERKS = ['hull', 'heavycharge', 'dugin', 'wideblast', 'heavyrounds', 'repairs'];
const ELITE_MODS = [{ mod: 'pointdef', unlock: 'pdturret', up: 'pdup' }, { mod: 'orbiter', unlock: 'orbital', up: 'orbitalup' }];
const NAMES = ['Rook', 'Vex', 'Marlow', 'Kestrel', 'Ivo', 'Sable', 'Quill', 'Harrow', 'Juno', 'Talon', 'Wren', 'Brask', 'Odette', 'Cinder', 'Pike', 'Moss'];
const ELITE_NAMES = ['Warden', 'Ironside', 'Marshal', 'Havoc', 'Bastion'];
const REWARD_AMMO = ['breacher', 'roller', 'flak', 'napalm', 'dirtbomb', 'mound', 'teleport'];
const ELITE_AMMO = [{ thunderhead: 1 }, { scatter: 2 }, { napalm: 2, breacher: 1 }];
const CRATES = [{ breacher: 2, roller: 1 }, { flak: 2, mound: 1 }, { napalm: 2, dirtbomb: 1 }, { scatter: 1, teleport: 1 }, { thunderhead: 1, ranger: 2 }];

// ---------------------------------------------------------------- dice

// Two numbers into one well-stirred 32-bit seed.
export function mixSeed(a, b) {
  let h = ((a >>> 0) ^ Math.imul((b >>> 0) + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const stopKey = (id) => [...String(id)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
// A stop's match seed: the run seed and the stop's id, nothing else.
export const stopSeed = (seed, id) => mixSeed(seed, stopKey(id)) % 1e9;

function weighted(list, rng) {
  let roll = rng.next() * list.reduce((s, x) => s + x.weight, 0);
  for (const x of list) { roll -= x.weight; if (roll < 0) return x; }
  return list[list.length - 1];
}
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------- the map

// Do edges a→b and c→d (indices in two neighbouring tiers) cross?
export const crosses = ([a, b], [c, d]) => (a - c) * (b - d) < 0;

// The paths from a tier of `n` stops to the next of `m`: a staircase from the
// first pair to the last (so every stop has a way in and a way out and no two
// paths cross), then a few more between neighbours where they cross nothing.
function joinTiers(n, m, rng) {
  const edges = [[0, 0]];
  let i = 0, j = 0;
  while (i < n - 1 || j < m - 1) {
    const r = rng.next();
    if (i < n - 1 && j < m - 1) { if (r < 0.4) { i++; j++; } else if (r < 0.7) i++; else j++; }
    else if (i < n - 1) i++;
    else j++;
    edges.push([i, j]);
  }
  const has = (a, b) => edges.some(([x, y]) => x === a && y === b);
  const near = (a, b) => Math.abs((n > 1 ? (a * (m - 1)) / (n - 1) : (m - 1) / 2) - b) <= 1;
  const extra = [];
  for (let a = 0; a < n; a++) for (let b = 0; b < m; b++) if (!has(a, b) && near(a, b)) extra.push([a, b]);
  for (const e of shuffle(extra, rng)) {
    const out = edges.filter(([x]) => x === e[0]).length;
    if (rng.next() < (out < 2 ? 0.75 : 0.25) && !edges.some((f) => crosses(e, f))) edges.push(e);
  }
  return edges;
}

function pickKinds(t, n, rng) {
  const [first, ...rest] = TIER_PLAN[t].kinds;
  return shuffle([first, ...shuffle(rest, rng).slice(0, n - 1)], rng);
}

// The whole map from the seed: { seed, tiers: [[stop]], stops: [stop], byId }.
// A stop: { id, tier, index, kind, next: [ids], match?, reward?, offers? }.
// Tiers 0 to RUN.tiers - 1 hold 2 or 3 stops; the last tier is the boss.
// `runMap` keeps the last few made; `generateMap` always makes it afresh.
const MAPS = new Map();
export function runMap(seed) {
  seed >>>= 0;
  if (MAPS.has(seed)) return MAPS.get(seed);
  const map = generateMap(seed);
  if (MAPS.size > 8) MAPS.clear();
  MAPS.set(seed, map);
  return map;
}

export function generateMap(seed) {
  seed >>>= 0;
  const rng = makeRng(mixSeed(seed, 1));
  const used = new Set();
  const name = (list) => {
    const free = list.filter((x) => !used.has(x));
    const pick = (free.length ? free : list)[Math.floor(rng.next() * (free.length || list.length))];
    used.add(pick);
    return pick;
  };
  const tiers = [];
  for (let t = 0; t < RUN.tiers; t++) {
    const n = rng.int(RUN.perTier[0], RUN.perTier[1]);
    const kinds = pickKinds(t, n, rng);
    tiers.push(kinds.map((kind, index) => makeStop(seed, t, index, kind, name)));
  }
  tiers.push([makeBoss(seed)]);
  for (let t = 0; t + 1 < tiers.length; t++) {
    const edges = tiers[t + 1].length === 1 ? tiers[t].map((_, a) => [a, 0]) : joinTiers(tiers[t].length, tiers[t + 1].length, rng);
    for (const [a, b] of edges) tiers[t][a].next.push(tiers[t + 1][b].id);
    for (const s of tiers[t]) s.next.sort((x, y) => byIndex(x) - byIndex(y));
  }
  const stops = tiers.flat();
  return { seed, tiers, stops, byId: Object.fromEntries(stops.map((s) => [s.id, s])) };
}
const byIndex = (id) => Number(String(id).split('s')[1]) || 0;

function makeStop(seed, tier, index, kind, name) {
  const id = `t${tier}s${index}`;
  const stop = { id, tier, index, kind, next: [] };
  const rng = makeRng(mixSeed(seed, stopKey(id) ^ 0x51ed));
  if (kind === 'fight' || kind === 'elite') {
    const plan = TIER_PLAN[tier];
    let world = weighted(WORLDS, rng);
    let wind = weighted(WINDS, rng).value;
    const edges = weighted(RUN_EDGES, rng).id;
    const time = weighted(TIMES, rng).id;
    // Half the stops are plain; the rest carry one round modifier for every round.
    const modifier = rng.next() < 0.5 ? 'clear' : weighted(MODIFIERS.filter((m) => m.id !== 'clear'), rng).id;
    if (!(wind > 0) && (MODIFIER_BY_ID[modifier].wind || MODIFIER_BY_ID[modifier].calm)) wind = 1.5;
    const perks = (k) => shuffle(FOE_PERKS, rng).slice(0, k);
    let foes, rounds;
    if (kind === 'elite') {
      const m = ELITE_MODS[Math.floor(rng.next() * ELITE_MODS.length)];
      const level = tier >= 4 ? 2 : 1;
      foes = [{ name: name(ELITE_NAMES), ai: 'hard', elite: true, mod: m.mod, level,
        perks: [m.unlock, ...(level > 1 ? [m.up] : []), ...perks(Math.floor(tier / 2) + 1)], up: [m.mod] }];
      rounds = 1;
    } else {
      const ais = plan.foes[Math.floor(rng.next() * plan.foes.length)];
      foes = ais.map((ai) => ({ name: name(NAMES), ai, perks: perks(Math.floor(tier / 2)) }));
      rounds = plan.rounds[Math.floor(rng.next() * plan.rounds.length)];
      if (world.world === 'ridgeline' && foes.length > 1 && rounds > 1) world = WORLD_BY_ID.hilly;   // a long ridge match is slow
    }
    stop.match = { world: world.id, maxWind: wind, edges, time, modifier, rounds, foes, seed: stopSeed(seed, id) };
    stop.reward = kind === 'elite'
      ? { money: 200 + 60 * tier, ammo: { ...ELITE_AMMO[Math.floor(rng.next() * ELITE_AMMO.length)] }, points: 1 }
      : { money: Math.round((80 + 40 * tier) / 10) * 10, ...(rng.next() < 0.5 ? { ammo: { [REWARD_AMMO[Math.floor(rng.next() * REWARD_AMMO.length)]]: tier >= 3 ? 2 : 1 } } : {}) };
  } else if (kind === 'cache') {
    stop.offers = [
      { kind: 'rank', name: 'Field training', points: 1 },
      { kind: 'ammo', name: 'Ammo crate', ammo: { ...CRATES[Math.floor(rng.next() * CRATES.length)] } },
      { kind: 'money', name: 'Pay chest', money: 200 + 50 * tier },
    ];
  }
  return stop;
}

function makeBoss(seed) {
  const rng = makeRng(mixSeed(seed, stopKey('boss') ^ 0x51ed));
  const world = rng.next() < 0.5 ? 'rolling' : 'hilly';
  return {
    id: 'boss', tier: RUN.tiers, index: 0, kind: 'boss', next: [],
    match: { world, maxWind: weighted(WINDS, rng).value, edges: 'wall', time: weighted(TIMES, rng).id, modifier: null, rounds: 1,
      foes: [{ name: BOSS.name, ai: BOSS.ai, boss: true }], seed: stopSeed(seed, 'boss') },
  };
}

// ---------------------------------------------------------------- the state

export const startKitCarried = () => {
  const inv = {};
  for (const [id, n] of Object.entries(startKit())) if (Number.isFinite(n) && n > 0) inv[id] = n;
  return { money: RUN.start.money, inventory: inv, jets: 1, perks: [], points: RUN.start.points, pendingArmor: 0, pendingFuel: 0 };
};

export function startRun(seed, name = 'You') {
  return {
    v: RUN.version, seed: seed >>> 0, name: String(name || 'You').slice(0, 14),
    at: null, done: true, path: [], kit: startKitCarried(), hulls: RUN.hulls, beaten: [], log: [], over: null, swapped: null,
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
export const currentStop = (state) => (state.at ? runMap(state.seed).byId[state.at] || null : null);

// The stops you may go to next: the first tier before you start, then the
// ones joined to where you are, once it is settled.
export function reachable(state) {
  if (state.over || !state.done) return [];
  const map = runMap(state.seed);
  return state.at == null ? map.tiers[0].map((s) => s.id) : [...(map.byId[state.at]?.next || [])];
}

export function chooseStop(state, id) {
  if (!reachable(state).includes(id)) throw new Error(`stop ${id} is not reachable`);
  const s = clone(state);
  s.at = id;
  s.done = false;
  s.path.push(id);
  return s;
}

// Add ammo ({ weapon: n }) and money to a kit, in place.
function addTo(kit, { money = 0, ammo = null, points = 0 } = {}) {
  kit.money = (kit.money || 0) + money;
  kit.points = (kit.points || 0) + points;
  for (const [id, n] of Object.entries(ammo || {})) if (WEAPON_BY_ID[id]) kit.inventory[id] = (kit.inventory[id] || 0) + n;
}

// Did the human (the match's first tank) win the fight? A boss match: the
// boss is down. Otherwise it must win a round and no foe more than it.
export function fightWon(game) {
  if (game.cfg.boss) return !!game.bossTank && !game.bossTank.alive;
  const me = game.players[0];
  const best = Math.max(0, ...game.players.slice(1).map((p) => p.wins));
  return me.wins >= 1 && me.wins >= best;
}

// A fight at the current stop is over. `kit` is what the human carried out
// (game.js kitOf), won or lost: ammo spent stays spent, money earned stays.
// A win: +RUN.winPoints skill point and the stop's reward, and its CPUs join
// the beaten. A loss: one hull; with none left the run is over. A lost boss
// fight may be tried again while a hull is left, with the kit you brought to
// it (the boss match's own gifts to the team are not kept).
// Returns { state, outcome: { won, reward, hullLost, over } }.
export function applyFightResult(state, { won, kit }) {
  const stop = currentStop(state);
  if (!stop || state.done || !stop.match) throw new Error('no fight to settle here');
  const s = clone(state);
  if (kit && stop.kind !== 'boss') s.kit = cleanKit(kit);
  const outcome = { won: !!won, reward: null, hullLost: false, over: null };
  if (won) {
    const reward = { ...(stop.reward || {}), points: (stop.reward?.points || 0) + RUN.winPoints };
    addTo(s.kit, reward);
    outcome.reward = reward;
    for (const f of stop.match.foes) if (!f.boss) s.beaten.push({ name: f.name, ai: f.ai, perks: [...(f.perks || [])], elite: !!f.elite, stop: stop.id });
    s.done = true;
    if (stop.kind === 'boss') s.over = 'won';
  } else {
    s.hulls = Math.max(0, s.hulls - 1);
    outcome.hullLost = true;
    if (s.hulls <= 0) { s.over = 'lost'; s.done = true; } else if (stop.kind !== 'boss') s.done = true;
  }
  outcome.over = s.over;
  s.log.push({ stop: stop.id, kind: stop.kind, won: !!won, ...(outcome.reward ? { reward: outcome.reward } : {}), hullLost: outcome.hullLost });
  return { state: s, outcome };
}

// Take one of a Cache's three: 'rank' (a skill point), 'ammo' or 'money'.
export function applyCache(state, kind) {
  const stop = currentStop(state);
  if (!stop || stop.kind !== 'cache' || state.done) throw new Error('no cache here');
  const offer = stop.offers.find((o) => o.kind === kind);
  if (!offer) throw new Error(`no ${kind} in this cache`);
  const s = clone(state);
  addTo(s.kit, offer);
  s.done = true;
  s.log.push({ stop: stop.id, kind: 'cache', took: offer.kind, offer });
  return s;
}

// The weapon forks the kit has taken: [{ weapon, taken, other }].
export function forksTaken(kit) {
  const p = { perks: kit.perks || [] };
  return BRANCHES.filter((b) => b.weapon).map((b) => {
    const taken = forkTaken(p, b);
    return taken ? { weapon: b.weapon, taken, other: b.options.find((o) => o !== taken) } : null;
  }).filter(Boolean);
}

// At a Depot: turn one taken fork the other way (its upgrade stays), once a visit.
export function swapVariant(state, weapon) {
  const stop = currentStop(state);
  if (!stop || stop.kind !== 'depot' || state.done) throw new Error('no depot here');
  if (state.swapped === stop.id) throw new Error('already swapped at this depot');
  const f = forksTaken(state.kit).find((x) => x.weapon === weapon);
  if (!f) throw new Error(`no ${weapon} variant to swap`);
  const s = clone(state);
  s.kit.perks = s.kit.perks.map((id) => (id === f.taken ? f.other : id));
  s.swapped = stop.id;
  return s;
}

// Leave the Depot with the kit the armory left (kitOf of the kit game's tank).
export function leaveDepot(state, kit = null) {
  const stop = currentStop(state);
  if (!stop || stop.kind !== 'depot' || state.done) throw new Error('no depot here');
  const s = clone(state);
  if (kit) s.kit = cleanKit(kit);
  s.done = true;
  s.log.push({ stop: stop.id, kind: 'depot', swapped: s.swapped === stop.id });
  return s;
}

// Skill points spent on the map (the kit game's tank, read back).
export function setKit(state, kit) {
  const s = clone(state);
  s.kit = cleanKit(kit);
  return s;
}

// A kit made safe: known weapons with whole positive counts, known ranks.
export function cleanKit(kit = {}) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const inventory = {};
  for (const w of WEAPONS) if (!w.infinite && !w.hidden && n(kit.inventory?.[w.id])) inventory[w.id] = n(kit.inventory[w.id]);
  return {
    money: n(kit.money), inventory, jets: n(kit.jets), perks: (Array.isArray(kit.perks) ? kit.perks : []).filter((id) => PERK_BY_ID[id]),
    points: n(kit.points), pendingArmor: n(kit.pendingArmor), pendingFuel: n(kit.pendingFuel),
  };
}

// ---------------------------------------------------------------- matches

// The partners on offer for the boss fight: one CPU you beat, or a choice of
// two (the toughest, an Elite first, and the most recent other one). With
// none beaten, a plain Normal CPU comes along.
export function allyChoices(state) {
  const seen = new Set();
  const all = [];
  for (const f of [...state.beaten].reverse()) if (!seen.has(f.name)) { seen.add(f.name); all.push(f); }
  if (!all.length) return [{ name: 'Rook', ai: 'normal', perks: [] }];
  const rank = (f) => (f.elite ? 3 : { hard: 2, normal: 1, easy: 0 }[f.ai] || 0);
  const best = all.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const other = all.find((f) => f !== best);
  return other ? [best, other] : [best];
}

// The Game config for the current stop's fight. `ally` (one of allyChoices)
// for the boss. The human is the first tank and carries the run's kit.
export function matchConfig(state, { ally = null } = {}) {
  const stop = currentStop(state);
  if (!stop?.match) throw new Error('no fight here');
  const m = stop.match;
  const world = WORLD_BY_ID[m.world] || WORLD_BY_ID.hilly;
  const me = { name: state.name || 'You', ai: null, kit: clone(state.kit) };
  if (stop.kind === 'boss') {
    const a = ally || allyChoices(state)[0];
    const cfg = bossMatch(me.name, { ally: { name: a.name, ai: a.ai }, conditions: { maxWind: m.maxWind, hills: world.hills }, lab: RUN.lab });
    cfg.players[0].kit = me.kit;
    if (a.perks?.length) cfg.players[1].kit = { perks: [...a.perks] };
    return { ...cfg, seed: m.seed, time: m.time, modifier: null };
  }
  return {
    players: [me, ...m.foes.map((f) => ({ name: f.name, ai: f.ai, kit: { perks: [...(f.perks || [])], ...(f.up ? { up: [...f.up] } : {}) } }))],
    rounds: m.rounds, seed: m.seed, maxWind: m.maxWind, hills: world.hills, world: world.world,
    edges: m.edges, time: m.time, modifier: m.modifier, firing: 'volley', fog: false,
    weapons: null, perks: null, modifiers: null, lab: { ...RUN.lab },
  };
}

// A Game to spend points and shop with off the field (the map's Skills, the
// Depot's armory): one tank with the run's kit, in the shop, with the whole
// armory open. Read the kit back with kitOf(game.players[0]).
export function kitGame(state) {
  const g = new Game({ players: [{ name: state.name || 'You', ai: null, kit: clone(state.kit) }], seed: state.seed, resolution: 16, rounds: 99, lab: { ...RUN.lab } });
  g.round = 2;
  g.phase = 'shop';
  const p = g.players[0];
  p.bought = [];
  p.picked = [];
  g.offerSkills(p);
  return g;
}
export { kitOf };

// ---------------------------------------------------------------- words

const WIND_NAME = (v) => (WINDS.find((w) => w.value === v)?.name || `Wind ${v}`);
const EDGE_NAME = { open: 'Open edges', wall: 'Walled', bounce: 'Bouncing edges', wrap: 'Wrapping edges' };
const AI_NAME = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

// A stop's match in words, for its card: { world, wind, edges, time, modifier, foes, rounds }.
export function stopDetails(stop) {
  const m = stop.match;
  if (!m) return null;
  const mod = m.modifier ? MODIFIER_BY_ID[m.modifier] : null;
  return {
    world: WORLD_BY_ID[m.world]?.name || m.world,
    wind: `${WIND_NAME(m.maxWind)} wind`,
    edges: EDGE_NAME[m.edges] || m.edges,
    time: timeName(m.time),
    modifier: mod ? mod.name : 'Clear skies',
    modifierDesc: mod ? mod.desc : '',
    rounds: m.rounds,
    foes: m.foes.map((f) => ({
      name: f.name, level: f.boss ? `${BOSS.hp} hp` : AI_NAME[f.ai] || f.ai,
      extra: f.mod ? `${MODS.find((d) => d.id === f.mod)?.name} L${f.level}, up from the start` : '',
    })),
  };
}

// A reward in words: "$180 · 2 Napalm · +1 skill point".
export function rewardWords(r) {
  if (!r) return '';
  const out = [];
  if (r.money) out.push(`$${r.money}`);
  for (const [id, n] of Object.entries(r.ammo || {})) out.push(`${n} ${WEAPON_BY_ID[id]?.name || id}`);
  if (r.points) out.push(`+${r.points} skill point${r.points > 1 ? 's' : ''}`);
  return out.join(' · ');
}

// The mods a kit holds, from its ranks: [{ id, name, level }].
export function kitMods(kit) {
  const p = { perks: kit.perks || [] };
  return MODS.map((d) => ({ id: d.id, name: d.name, level: modLevel(RUN.lab, p, d.id) })).filter((m) => m.level > 0);
}

// The end of a run: { over, route: [{ id, kind, name, won? }], fights: { won, lost }, build }.
export function runSummary(state) {
  const map = runMap(state.seed);
  const route = state.path.map((id) => {
    const stop = map.byId[id];
    const fights = state.log.filter((l) => l.stop === id && l.won != null);
    const d = stop.match ? stopDetails(stop) : null;
    return { id, kind: stop.kind, name: KINDS[stop.kind].name, where: d ? d.world : '', won: fights.length ? fights[fights.length - 1].won : null, tries: fights.length };
  });
  const fought = state.log.filter((l) => l.won != null);
  const perks = state.kit.perks || [];
  const ranks = [...new Set(perks)].filter((id) => !PERK_BY_ID[id]?.weapon && !PERK_BY_ID[id]?.mods).map((id) => PERK_BY_ID[id].name);
  const variants = forksTaken(state.kit).map((f) => `${WEAPON_BY_ID[f.weapon].name} · ${PERK_BY_ID[f.taken].name}${perks.includes(`${f.weapon}:up`) ? ' +' : ''}`);
  return {
    over: state.over, hulls: state.hulls, route,
    fights: { won: fought.filter((l) => l.won).length, lost: fought.filter((l) => !l.won).length },
    build: { ranks, variants, mods: kitMods(state.kit), money: state.kit.money, points: state.kit.points,
      ammo: Object.entries(state.kit.inventory).map(([id, n]) => `${n} ${WEAPON_BY_ID[id]?.name || id}`) },
  };
}

// ---------------------------------------------------------------- saving

// The run in progress, from the browser's storage, checked; null when there
// is none, it is from another version, or it does not fit its map.
export function loadRun(storage) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(RUN_KEY) || 'null'); } catch { return null; }
  if (!raw || typeof raw !== 'object' || raw.v !== RUN.version || !Number.isInteger(raw.seed)) return null;
  const map = runMap(raw.seed);
  const path = Array.isArray(raw.path) ? raw.path.filter((id) => map.byId[id]) : [];
  if (path.length !== (raw.path || []).length) return null;
  for (let i = 1; i < path.length; i++) if (path[i] !== path[i - 1] && !map.byId[path[i - 1]].next.includes(path[i])) return null;
  const at = raw.at == null ? null : map.byId[raw.at] ? raw.at : undefined;
  if (at === undefined || (at !== null && path[path.length - 1] !== at)) return null;
  return {
    v: RUN.version, seed: raw.seed >>> 0, name: String(raw.name || 'You').slice(0, 14), at, done: raw.done !== false, path,
    kit: cleanKit(raw.kit), hulls: Math.max(0, Math.min(RUN.hulls, Math.floor(raw.hulls ?? RUN.hulls))),
    beaten: (Array.isArray(raw.beaten) ? raw.beaten : []).filter((f) => f && typeof f.name === 'string')
      .map((f) => ({ name: f.name.slice(0, 14), ai: AI_NAME[f.ai] ? f.ai : 'normal', perks: (f.perks || []).filter((id) => PERK_BY_ID[id]), elite: !!f.elite, stop: f.stop })),
    log: Array.isArray(raw.log) ? raw.log.filter((l) => l && map.byId[l.stop]) : [],
    over: raw.over === 'won' || raw.over === 'lost' ? raw.over : null,
    swapped: map.byId[raw.swapped] ? raw.swapped : null,
  };
}

export function saveRun(storage, state) {
  try { storage.setItem(RUN_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

export function clearRun(storage) {
  try { storage.removeItem(RUN_KEY); } catch { /* private mode */ }
}
