// Mods: equipment a tank deploys onto the field, as data (the way weapons.js
// holds the weapons). A weapon is spent one shot at a time; a mod is put up
// once and then stays until it is shot down or wears out.
//
// What a tank owns lives on the player as `p.mods[id]`, so it travels in
// snapshots and online plans like everything else on the player:
//
//   {
//     bought,      armory levels bought (kept for the match)
//     level,       the level fitted this round: bought (or the host's Lab
//                  level) plus any perk levels, at most `maxLevel`
//     state,       'ready'  fitted, waiting to be deployed
//                  'up'     deployed and working
//                  'down'   shot down (or its tank was); a new one is
//                           fitted at the owner's next turn (refitMods),
//                           or next round if its tank was destroyed
//                  'spent'  worn out (its turns ran out); likewise
//     hp, maxHp,   what it can take before it breaks up
//     turns,       lifetime left once up: the owner's turns (volleys), across rounds
//     fresh,       went up this turn, which does not count against `turns`
//     x, y, z,     where a mod that hangs still sits (the satellite); an
//                  orbiter has none, it moves with the game clock (orbitPoints)
//   }
//
// Deploying a mod is the owner's whole action for that turn: no shot (in a
// volley it is the locked-in plan, `{ deploy: id }`). In return it persists:
// an up mod carries into the next round (moved over its owner's new spot)
// and stays until it is shot down, its tank is destroyed, or its turns run
// out. Anything else the tank owns is fitted fresh each round, 'ready'. A
// mod lost mid-round is ready again on its owner's next turn: putting it back
// up costs that turn, and that is all losing one costs.
//
// Shells and blasts reach mods through `modTargets` (spheres at the game clock)
// and the game's blast code; Flak bursts on its nearest pass by one and hurts
// it directly (weapons.js `air`). A tank's own fire never touches its own mods.
//
// Families (docs/design-guide.md): 'recon' beats 'defense' beats 'jamming'
// beats 'recon'; Flak answers anything in the sky. Status effects (Jammed,
// Spotted, Uplinked...) will go on `p.status` as { kind, source, strength,
// turns } and could be listed on a mod as `applies`; nothing uses them yet.

import { PERK_BY_ID, perkSum } from './perks.js';
import { SURVEY } from './survey.js';

// The Gravity Orbiter's levels. One or two small wells circle the owner's
// tank `radius` m out and `height` m up, `speed` rad/s, bobbing `bob` m. Each
// well pulls like a moon (ballistics.js), mu / d^2, but never harder than at
// `soft` m (so a near pass bends a shell hard without catching it), and a
// shell that touches its `core` sphere hits it. At level 3 two wells spin
// round each other (`pair`: `sep` m apart, `spin` rad/s, in a plane tipped
// `tilt` rad) while their middle circles the tank: a three-body slingshot.
export const ORBIT = [
  null,
  { radius: 13, height: 9, speed: 1.1, bob: 2, mu: 6800, soft: 4.5, core: 1.6 },
  { radius: 13, height: 9, speed: 1.8, bob: 2, mu: 10500, soft: 4.5, core: 1.6 },
  { radius: 14, height: 10, speed: 1.5, bob: 2.5, mu: 6400, soft: 4.5, core: 1.5, pair: { sep: 5, spin: 3.4, tilt: 0.7 } },
];

// The satellite, deployed: it hangs `altitude` m over its owner's ground,
// `lean` m toward the middle of the field, and a shell within `radius` hits it.
export const SKY = { altitude: 70, lean: 14, radius: 5 };

// Pay for shooting down an enemy mod.
export const MOD_PAY = 60;

export const MODS = [
  {
    id: 'orbiter', name: 'Gravity Orbiter', tag: 'ORB', family: 'defense', maxLevel: 3,
    prices: [180, 220, 260],   // level 1, 2, 3, each on top of the one before
    hp: [30, 40, 50],
    turns: [6, 7, 8],
    levels: ['one small well', 'stronger, faster', 'two wells: a three-body slingshot'],
    desc: 'A small gravity well circles your tank and bends enemy shells that pass it. Your own shells fly through untouched. Deploying it takes your turn; it stays up into later rounds until it is shot (Flak is best) or wears out, and then a new one is ready on your next turn.',
  },
  {
    id: 'satellite', name: 'Survey Satellite', tag: 'SAT', family: 'recon', maxLevel: SURVEY.maxLevel,
    prices: SURVEY.prices,
    hp: [20, 25, 30],
    turns: [5, 6, 7],          // its battery
    levels: ['no wind', 'with wind', 'more labels'],
    desc: 'Deploy it into the sky over your area: it projects a grid of cells over the enemy, some labelled with the turret and power that land there. Level 2 counts the wind, moons and enemy orbiters; level 3 labels more. Deploying it takes your turn; it stays up into later rounds until it is shot down (Flak is best) or its battery runs out, and then a new one is ready on your next turn.',
  },
];

export const MOD_BY_ID = Object.fromEntries(MODS.map((m) => [m.id, m]));

// ---------- who has what ----------

// The host's Lab setting for one mod: { mode, level }, where mode is
//   'perk'  (the default) gained and levelled through the perk draft only
//   'shop'  sold in the armory a level at a time, and the draft too
//   'all'   everyone has it at `level` from the start; the draft can level it up
//   'off'   nobody has it
// The satellite keeps its original fields (`satellite`, `level`); any other
// mod reads `lab[id]` and `lab[id + 'Level']`.
export const MOD_MODES = ['perk', 'shop', 'all', 'off'];

export function modLab(lab, id) {
  const l = lab || {};
  const raw = l[id];
  const mode = MOD_MODES.includes(raw) ? raw : 'perk';
  const max = MOD_BY_ID[id]?.maxLevel || 1;
  const level = Math.max(1, Math.min(max, Math.round(Number(id === 'satellite' ? l.level : l[`${id}Level`]) || 1)));
  return { mode, level };
}

// The Lab fields for every mod but the satellite (core/survey.js normalizeLab
// has its own), filled in: { orbiter: 'perk', orbiterLevel: 1, ... }.
export function normalizeModLab(lab) {
  const out = {};
  for (const m of MODS) {
    if (m.id === 'satellite') continue;
    const { mode, level } = modLab(lab, m.id);
    out[m.id] = mode;
    out[`${m.id}Level`] = level;
  }
  return out;
}

// Levels of `id` that `p`'s perks add.
export function perkLevels(p, id) {
  let n = 0;
  for (const k of p?.perks || []) n += PERK_BY_ID[k]?.mods?.[id] || 0;
  return n;
}

// Armory levels `p` has bought (an old save's `p.satellite` counts too).
export function boughtLevels(p, id) {
  return p?.mods?.[id]?.bought ?? (id === 'satellite' ? p?.satellite || 0 : 0);
}

// The level of `id` that `p` owns this match (0: none).
export function modLevel(lab, p, id) {
  const m = MOD_BY_ID[id];
  if (!m) return 0;
  const { mode, level } = modLab(lab, id);
  if (mode === 'off') return 0;
  const base = mode === 'all' ? level : mode === 'shop' ? boughtLevels(p, id) : 0;
  return Math.min(m.maxLevel, base + perkLevels(p, id));
}

// What the next level costs `p` before any discount, or Infinity when it is
// not for sale (not in the armory, or at the top level already).
export function modPrice(lab, p, id) {
  const m = MOD_BY_ID[id];
  if (!m || modLab(lab, id).mode !== 'shop') return Infinity;
  const have = modLevel(lab, p, id);
  return have >= m.maxLevel ? Infinity : m.prices[have];
}

// One more armory level.
export function buyLevel(p, id) {
  p.mods = p.mods || {};
  const m = p.mods[id] || (p.mods[id] = { bought: 0, level: 0, state: 'none' });
  m.bought = (m.bought || 0) + 1;
}

const healthAt = (p, def, level) => Math.round(def.hp[level - 1] * (1 + perkSum(p, 'modHp')));

// Round start. A mod that is up stays up: it keeps its damage and the turns
// it has left, and takes on a level gained since (the new health added to what
// it has). Any other mod `p` owns is fitted fresh (whole, a full lifetime) and
// waits to be deployed. The game then moves what hangs in the sky over the
// owner's new spot (anchorMod).
export function fitMods(lab, p) {
  p.mods = p.mods || {};
  for (const def of MODS) {
    const level = modLevel(lab, p, def.id);
    const had = p.mods[def.id];
    if (!level && !had) continue;
    if (level && had?.state === 'up') {
      const maxHp = healthAt(p, def, level);
      had.hp = Math.max(1, had.hp + maxHp - had.maxHp);
      had.maxHp = maxHp;
      had.level = level;
      continue;
    }
    const hp = level ? healthAt(p, def, level) : 0;
    p.mods[def.id] = {
      bought: had?.bought || 0, level,
      state: level ? 'ready' : 'none',
      hp, maxHp: hp,
      turns: level ? def.turns[level - 1] + perkSum(p, 'modTurns') : 0,
    };
  }
}

// The start of `p`'s turn (or of a volley's planning): a mod that was shot
// down or wore out since its last turn is fitted fresh, ready to go up again.
// Putting it up costs that turn, which is the whole price of losing one.
// Returns the ids refitted.
export function refitMods(lab, p) {
  const out = [];
  if (!p?.mods || p.alive === false) return out;
  for (const def of MODS) {
    const m = p.mods[def.id];
    if (!m || (m.state !== 'down' && m.state !== 'spent')) continue;
    const level = modLevel(lab, p, def.id);
    if (!level) continue;
    const hp = healthAt(p, def, level);
    p.mods[def.id] = { bought: m.bought || 0, level, state: 'ready', hp, maxHp: hp, turns: def.turns[level - 1] + perkSum(p, 'modTurns') };
    out.push(def.id);
  }
  return out;
}

// Where a mod that hangs still goes over `p` (the satellite): `ground(x, z)`
// is the height of the ground there, or null over open space.
export function anchorMod(p, id, ground = () => null) {
  const m = p.mods?.[id];
  if (!m || id !== 'satellite') return;
  const d = Math.hypot(p.x, p.z) || 1;
  const x = p.x - (p.x / d) * SKY.lean;
  const z = p.z - (p.z / d) * SKY.lean;
  m.x = x;
  m.y = Math.max(p.y, ground(x, z) ?? p.y) + SKY.altitude;
  m.z = z;
}

// The mods `p` can deploy right now, in roster order.
export function readyMods(p) {
  return MODS.filter((d) => p?.mods?.[d.id]?.state === 'ready').map((d) => d.id);
}

export function modUp(p, id) {
  return !!p && p.alive !== false && p.mods?.[id]?.state === 'up';
}

// Put a ready mod up (the game spends the owner's turn on it). `ground` as
// for anchorMod. Returns whether it went up.
export function deployMod(p, id, ground = () => null) {
  const m = p.mods?.[id];
  if (!m || m.state !== 'ready' || !(m.level > 0)) return false;
  m.state = 'up';
  m.fresh = true;   // the turn it goes up on does not count against its lifetime
  anchorMod(p, id, ground);
  return true;
}

// One of the owner's turns (or a volley) is over: up mods wear down, across
// rounds. Returns the ids that ran out.
export function tickMods(p) {
  const out = [];
  for (const def of MODS) {
    const m = p.mods?.[def.id];
    if (!m || m.state !== 'up') continue;
    if (m.fresh) { m.fresh = false; continue; }
    m.turns = Math.max(0, m.turns - 1);
    if (m.turns <= 0) { m.state = 'spent'; out.push(def.id); }
  }
  return out;
}

// Damage to a mod. Returns 'down' when it breaks up, 'hit' otherwise, or null.
export function hurtMod(p, id, amount) {
  const m = p.mods?.[id];
  if (!m || m.state !== 'up' || !(amount > 0)) return null;
  m.hp = Math.max(0, m.hp - amount);
  if (m.hp > 0) return 'hit';
  m.state = 'down';
  return 'down';
}

// ---------- the orbiter, as a function of time ----------

// Where the orbiter's wells are at game clock `t` (s): a pure function of the
// owner's position, id and level, so every screen and the CPU's solver agree.
export function orbitPoints(p, level, t) {
  const o = ORBIT[level];
  if (!o) return [];
  const a = p.id * 2.399963 + t * o.speed * (p.id % 2 ? -1 : 1);   // neighbours turn opposite ways
  const cx = p.x + Math.cos(a) * o.radius;
  const cy = p.y + o.height + Math.sin(a * 2) * o.bob;
  const cz = p.z + Math.sin(a) * o.radius;
  if (!o.pair) return [{ x: cx, y: cy, z: cz }];
  const s = p.id * 1.3 + t * o.pair.spin;
  const h = o.pair.sep / 2;
  const ux = Math.cos(s), uy = Math.sin(s) * Math.sin(o.pair.tilt), uz = Math.sin(s) * Math.cos(o.pair.tilt);
  return [
    { x: cx + ux * h, y: cy + uy * h, z: cz + uz * h },
    { x: cx - ux * h, y: cy - uy * h, z: cz - uz * h },
  ];
}

// Every live orbiter well at time `t`, as wells the ballistics understands
// ({ x, y, z, r, soft, mu, owner }), leaving out `except`'s own.
export function modWells(players, t, except = null) {
  const out = [];
  for (const p of players) {
    if (p.id === except || !modUp(p, 'orbiter')) continue;
    const lv = p.mods.orbiter.level;
    const o = ORBIT[lv];
    for (const q of orbitPoints(p, lv, t)) out.push({ x: q.x, y: q.y, z: q.z, r: o.core, soft: o.soft, mu: o.mu, owner: p.id });
  }
  return out;
}

// Everything deployed that a shell can hit, at time `t`: { owner, mod, x, y, z, r }.
// An orbiter at level 3 is two spheres, both the same mod.
export function modTargets(players, t) {
  const out = [];
  for (const p of players) {
    if (modUp(p, 'orbiter')) {
      const lv = p.mods.orbiter.level;
      for (const q of orbitPoints(p, lv, t)) out.push({ owner: p.id, mod: 'orbiter', x: q.x, y: q.y, z: q.z, r: ORBIT[lv].core });
    }
    if (modUp(p, 'satellite')) {
      const m = p.mods.satellite;
      out.push({ owner: p.id, mod: 'satellite', x: m.x, y: m.y, z: m.z, r: SKY.radius });
    }
  }
  return out;
}

// Does `p` have any up mod at all? (Cheap check for the hot loop.)
export function anyUp(players) {
  return players.some((p) => p.mods && p.alive !== false && (p.mods.orbiter?.state === 'up' || p.mods.satellite?.state === 'up'));
}
