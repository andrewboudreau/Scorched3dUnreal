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
//     x, y, z,     where a mod that hangs still sits (the satellite) or stands
//                  (the decoy); an orbiter has none, it moves with the game
//                  clock (orbitPoints), and Point Defense rides beside its
//                  tank (turretAt)
//     hull, yaw, elev   the decoy: the pose of the tank it copies
//     charges,     Point Defense: shells it can still shoot down this round
//     target, lift the Jammer Drone: the id of the enemy it hovers over (it
//                  goes where that tank goes, jammerPos), and how much higher
//                  it rides there to clear the ground; x, y, z keep where it
//                  was last put, for when its target is gone
//   }
//
// Deploying a mod is the owner's whole action for that turn: no shot (in a
// volley it is the locked-in plan, `{ deploy: id }`). An `aimed` mod (the
// decoy) is deployed by firing: the plan carries the aim too
// (`{ deploy: 'decoy', yaw, elev, power }`), the tank fires a blink round,
// and the mod goes up where the tank stood once the round lands it
// (game.js leaveDecoy). In return it persists:
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
// beats 'recon'; Flak answers anything in the sky. 'deception' (the decoy)
// sits outside the triangle: it beats being ranged, recon included.
// A tank holds at most MOD_BAYS mods: with that many, the skill tree shuts
// the other mod branches (game.skillTree).
//
// Status effects go on the tank they act on, `p.status`, a list of
// { kind, source, strength, turns }: what it is ('jammed'), the tank whose
// mod put it there, that mod's level, and the turns the mod has left. They
// are game state, so they travel in snapshots like the rest of the player.
// A status is not stepped on its own: the game works it out again from the
// mods up (game.refreshStatus) at fixed points, each turn or volley and when
// a mod goes up or down, so every copy of an online game holds the same. The
// only kind so far is Jammed, from the Jammer Drone (JAM).

import { PERK_BY_ID, perkSum } from './perks.js';
import { SURVEY } from './survey.js';
import { TANK } from './tank.js';

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

// The Decoy Beacon. The decoy is a tank-sized target (TANK.hitRadius) where
// its owner stood. From level `mirror` its label shows its owner's hit
// points; from level `boom` it goes off when it fizzles (its hit points run
// out): a blast of `fizzle`, credited to its owner. It is a trick for one
// spot, so it ends with the round (a fresh one is ready next round). CPUs
// fall for it `fool` of the time when they can see it, and for a level 1
// decoy (whose label gives it away) `plain` times as often.
export const DECOY = {
  mirror: 2, boom: 3,
  fizzle: { radius: 10, damage: 25, depth: 0.35 },
  fool: { easy: 0.7, normal: 0.4, hard: 0.15 }, plain: 0.6,
};

// Point Defense, by level: it shoots down the first enemy shell coming down
// within `radius` m of its owner (the middle of the tank's hit sphere), up to
// `charges` a round, and a split shell's fragments too with `frags`. The
// turret sits `TURRET.side` m beside its tank and goes where the tank goes; a
// shell within `TURRET.r` of it hits it.
export const POINTDEF = [
  null,
  { radius: 18, charges: 1, frags: false },
  { radius: 18, charges: 2, frags: false },
  { radius: 26, charges: 2, frags: true },
];
export const TURRET = { side: 5.5, height: 1.1, r: 1.8 };

// The Jammer Drone. It hovers `height` m over the enemy it is sent to, `side`
// m off toward its owner (lifted to keep `clear` m over the ground under it:
// the mod's `lift`, set where it goes up and at each turn), and goes where
// that tank goes; a shell within `r` m hits it (Flak is the answer: it is a
// thing in the sky).
// It puts Jammed on that tank (and from level `fieldFrom` on every enemy of
// its owner within `field` m of it, across). A jammed tank's Survey Satellite
// labels go dark and its Guided Missile cannot be steered; from level `arc`
// its aim arc and side view (and the Tracer perk's line) are blank too. A
// jammed CPU loses its satellite's help and from level `arc` carries `blur`
// times its aiming error (ai.planShot `sharpen`).
// Defense beats it: an enemy Point Defense with a charge left shoots it down
// as soon as it is in reach (POINTDEF radius, from the middle of that tank),
// spending the charge; an enemy Gravity Orbiter within `grindReach` m of it
// (across) grinds it, `grind[orbiter level]` damage at the start of each of
// its target's turns (or each volley).
export const JAM = {
  height: 13, side: 11, r: 2.2, clear: 7,
  arc: 2, fieldFrom: 3, field: 40, blur: 1.3,
  grindReach: 20, grind: [0, 8, 10, 12],
};

// Pay for shooting down an enemy mod.
export const MOD_PAY = 60;

// A tank holds at most this many mods: once it owns that many, the skill
// tree only offers ranks of those, no new ones (game.skillTree, perkFits).
export const MOD_BAYS = 2;

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
  {
    id: 'decoy', name: 'Decoy Beacon', tag: 'DCY', family: 'deception', maxLevel: 3, aimed: true, roundOnly: true,
    prices: [150, 190, 230],   // level 1, 2, 3, each on top of the one before
    hp: [20, 35, 35],
    turns: [4, 5, 5],
    levels: ['blink away, leave a decoy (20 hp)', 'takes 35 and shows your hit points', 'goes off when it fizzles: 25 damage'],
    desc: 'Fire it like a shot: your tank blinks to where it lands, and a decoy of your tank stays where you were to take the shots aimed at you. It fizzles after 20 damage (35 from level 2, which also shows your hit points); at level 3 it goes off when it fizzles. Deploying it takes your turn; it lasts until it fizzles, wears out or the round ends.',
  },
  {
    id: 'pointdef', name: 'Point Defense', tag: 'PD', family: 'defense', maxLevel: 3,
    prices: [170, 210, 250],
    hp: [25, 30, 35],
    turns: [5, 6, 7],
    levels: ['stops 1 enemy shell a round, 18 m', 'stops 2 a round', '26 m, and split-shell fragments too'],
    desc: 'A small turret beside your tank shoots down the first enemy shell coming down within 18 m of you, once a round (twice from level 2; at level 3 it reaches 26 m and stops fragments too). Scatter, Flak bursts and Rollers get past it. Deploying it takes your turn; it stays up into later rounds until it is shot down or wears out.',
  },
  {
    // `targeted`: it goes up over an enemy (the one the turret points
    // nearest, or the plan's `target`), not over its owner.
    id: 'jammer', name: 'Jammer Drone', tag: 'JAM', family: 'jamming', maxLevel: 3, targeted: true,
    prices: [160, 200, 240],
    hp: [20, 25, 30],
    turns: [4, 5, 6],
    levels: ['jams one tank: satellite labels and steering', 'blanks its aim arc and side view too', `jams every enemy within ${JAM.field} m`],
    desc: 'A drone flies to hover over the enemy your turret points nearest and jams it: its Survey Satellite labels go dark and its Guided Missile cannot be steered (from level 2 its aim arc and side view go blank too; at level 3 it jams every enemy within 40 m). Point Defense shoots it down, an orbiter grinds it and Flak brings it down. Deploying it takes your turn; it stays up into later rounds until it is shot down or wears out.',
  },
];

export const MOD_BY_ID = Object.fromEntries(MODS.map((m) => [m.id, m]));

// ---------- who has what ----------

// The host's Lab setting for one mod: { mode, level }, where mode is
//   'perk'  (the default) gained and levelled through the skill tree only
//   'shop'  sold in the armory a level at a time (and in the tree too)
//   'all'   everyone has it at `level` from the start; the tree can level it up
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
  const perks = perkLevels(p, id);
  const bought = boughtLevels(p, id);
  // 'perk': the skill tree gives every level (core/skills.js); 'shop': the
  // armory sells them, and tree ranks add on top.
  const base = mode === 'all' ? level : mode === 'shop' ? bought : 0;
  return Math.min(m.maxLevel, base + perks);
}

// The armory's price for the next level of `id`: only when the host's Lab
// sells mods ('shop'). By default ('perk') levels come from the skill tree,
// with skill points, not money; 'all' hands everyone a level; 'off' is off.
// Infinity when it is not for sale.
export function modPrice(lab, p, id) {
  const m = MOD_BY_ID[id];
  const mode = modLab(lab, id).mode;
  if (!m || mode !== 'shop') return Infinity;
  const have = modLevel(lab, p, id);
  if (have >= m.maxLevel) return Infinity;
  return m.prices[have];
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
    if (level && had?.state === 'up' && !def.roundOnly) {
      const maxHp = healthAt(p, def, level);
      had.hp = Math.max(1, had.hp + maxHp - had.maxHp);
      had.maxHp = maxHp;
      had.level = level;
      if (def.id === 'pointdef') had.charges = POINTDEF[level].charges;   // they refill every round
      continue;
    }
    p.mods[def.id] = level ? freshMod(p, def, level, had?.bought)
      : { bought: had?.bought || 0, level: 0, state: 'none', hp: 0, maxHp: 0, turns: 0 };
  }
}

// A whole new mod of `def` at `level`, ready to deploy.
function freshMod(p, def, level, bought = 0) {
  const hp = healthAt(p, def, level);
  const m = { bought: bought || 0, level, state: 'ready', hp, maxHp: hp, turns: def.turns[level - 1] + perkSum(p, 'modTurns') };
  if (def.id === 'pointdef') m.charges = POINTDEF[level].charges;
  return m;
}

// How many mods `p` owns this match (at any level): what fills its MOD_BAYS.
export function modsOwned(lab, p) {
  return MODS.filter((d) => modLevel(lab, p, d.id) > 0).length;
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
    p.mods[def.id] = freshMod(p, def, level, m.bought);
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
// for anchorMod. A decoy stands at `at` ({ x, y, z, hull, yaw, elev }: the
// tank it copies, where it stood; `p` itself without it). A jammer goes to
// the enemy tank `at` (and then follows it); without one it stays ready.
// Returns whether it went up.
export function deployMod(p, id, ground = () => null, at = null) {
  const m = p.mods?.[id];
  if (!m || m.state !== 'ready' || !(m.level > 0)) return false;
  m.state = 'up';
  m.fresh = true;   // the turn it goes up on does not count against its lifetime
  anchorMod(p, id, ground);
  if (id === 'decoy') {
    const t = at || p;
    Object.assign(m, { x: t.x, y: t.y, z: t.z, hull: t.hull ?? 0, yaw: t.yaw ?? 0, elev: t.elev ?? 45 });
  }
  if (id === 'jammer') {
    if (!at) { m.state = 'ready'; delete m.fresh; return false; }
    m.target = at.id;
    m.lift = jamLift(p, at, ground);
    Object.assign(m, jammerAt(p, at, m.lift));
  }
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

// Where `p`'s Point Defense turret stands: beside the tank, on a side its id
// picks. A pure function of the tank, so it rides along when the tank moves.
export function turretAt(p) {
  const a = p.id * 2.399963 + 0.8;
  return { x: p.x + Math.cos(a) * TURRET.side, y: p.y + TURRET.height, z: p.z + Math.sin(a) * TURRET.side };
}

// Where one of `p`'s mods is, for effects ([x, y, z]), or null for the
// orbiter (it is in more than one place). The jammer: where the game last put
// it (game.refreshStatus keeps that up to date; jammerPos is where it is now).
export function modPos(p, id) {
  const m = p.mods?.[id];
  if (!m) return null;
  if (id === 'satellite') return [m.x, m.y, m.z];
  if (id === 'decoy') return [m.x, m.y + TANK.hitCenterY, m.z];
  if (id === 'pointdef') { const q = turretAt(p); return [q.x, q.y, q.z]; }
  if (id === 'jammer') return [m.x, m.y, m.z];
  return null;
}

// Everything deployed that a shell can hit, at time `t`: { owner, mod, x, y, z, r }.
// An orbiter at level 3 is two spheres, both the same mod. Mods on the
// ground (the decoy, Point Defense) are marked `ground`: Flak's air burst
// passes them by, as it passes tanks by.
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
    if (modUp(p, 'decoy')) {
      const m = p.mods.decoy;
      out.push({ owner: p.id, mod: 'decoy', x: m.x, y: m.y + TANK.hitCenterY, z: m.z, r: TANK.hitRadius, ground: true });
    }
    if (modUp(p, 'pointdef')) out.push({ owner: p.id, mod: 'pointdef', ...turretAt(p), r: TURRET.r, ground: true });
    if (modUp(p, 'jammer')) out.push({ owner: p.id, mod: 'jammer', ...jammerPos(players, p), r: JAM.r });
  }
  return out;
}

// Does `p` have any up mod at all? (Cheap check for the hot loop.)
export function anyUp(players) {
  return players.some((p) => p.mods && p.alive !== false && MODS.some((d) => p.mods[d.id]?.state === 'up'));
}

// ---------- Point Defense ----------

// Would `p`'s Point Defense shoot down shell `pr` (of weapon `w`) now? An
// enemy shell that would blast where it lands (not a probe, Teleport, Mound,
// Scout or Roller), on its way down within reach of `p`, with a charge left;
// a fragment (`pr.frag`) only at the level that stops them.
export function interceptsShell(p, pr, w) {
  if (!modUp(p, 'pointdef') || pr.owner === p.id || pr.probe || !(pr.vel[1] < 0)) return false;
  const m = p.mods.pointdef;
  const lv = POINTDEF[m.level];
  if (!lv || !(m.charges > 0) || (pr.frag && !lv.frags)) return false;
  if (!(w.impact || []).some((x) => x.type === 'blast')) return false;
  const [x, y, z] = pr.pos;
  return (x - p.x) ** 2 + (y - p.y - TANK.hitCenterY) ** 2 + (z - p.z) ** 2 <= lv.radius * lv.radius;
}

// ---------- the Jammer Drone ----------

// Where `owner`'s jammer hovers over tank `target`: JAM.height over it,
// JAM.side off toward its owner (or, right on top of it, to a side its id
// picks), `lift` m higher still. A pure function of the two tanks, so it
// follows its target.
export function jammerAt(owner, target, lift = 0) {
  let dx = owner.x - target.x, dz = owner.z - target.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { const a = owner.id * 2.399963; dx = Math.cos(a); dz = Math.sin(a); } else { dx /= d; dz /= d; }
  return { x: target.x + dx * JAM.side, y: target.y + JAM.height + lift, z: target.z + dz * JAM.side };
}

// The lift that keeps a drone over `target` JAM.clear m above the ground
// under it (`ground(x, z)`, null over open space).
export function jamLift(owner, target, ground) {
  const at = jammerAt(owner, target);
  const g = ground?.(at.x, at.z);
  return g == null ? 0 : Math.max(0, g + JAM.clear - at.y);
}

// Where `p`'s up jammer is now: over its target while that tank lives, else
// where it was last put (m.x, m.y, m.z).
export function jammerPos(players, p) {
  const m = p.mods.jammer;
  const t = players.find((q) => q.id === m.target);
  return t && t.alive !== false ? jammerAt(p, t, m.lift || 0) : { x: m.x, y: m.y, z: m.z };
}

// Is `pos` ({ x, y, z }) within reach of `q`'s Point Defense, with a charge
// left to shoot?
export function pdReaches(q, pos) {
  if (!modUp(q, 'pointdef')) return false;
  const m = q.mods.pointdef;
  const lv = POINTDEF[m.level];
  if (!lv || !(m.charges > 0)) return false;
  return (pos.x - q.x) ** 2 + (pos.y - q.y - TANK.hitCenterY) ** 2 + (pos.z - q.z) ** 2 <= lv.radius * lv.radius;
}

// The Jammed statuses the up jammers put on the tanks now, by tank id:
// { id: [{ kind: 'jammed', source, strength, turns }] }. `allied(a, b)` as
// game.allied. A jammer puts it on its target, and from JAM.fieldFrom on
// every enemy of its owner within JAM.field m of it, across.
export function jamStatuses(players, allied = (a, b) => a === b) {
  const out = {};
  for (const p of players) {
    if (!modUp(p, 'jammer')) continue;
    const m = p.mods.jammer;
    const at = jammerPos(players, p);
    for (const q of players) {
      if (q.alive === false || allied(p, q)) continue;
      const near = m.level >= JAM.fieldFrom && Math.hypot(q.x - at.x, q.z - at.z) <= JAM.field;
      if (q.id !== m.target && !near) continue;
      (out[q.id] ||= []).push({ kind: 'jammed', source: p.id, strength: m.level, turns: m.turns });
    }
  }
  return out;
}

// The strongest `kind` status on `p` (its strength), or 0 for none.
export function statusLevel(p, kind) {
  let n = 0;
  for (const s of p?.status || []) if (s.kind === kind) n = Math.max(n, s.strength || 1);
  return n;
}
