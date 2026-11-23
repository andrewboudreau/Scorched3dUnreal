// The roguelike layer, as data. A perk belongs to one tank for the rest of the
// match; a modifier bends the rules for everyone for one round. Neither holds
// any logic: the game reads the numbers below through `perkSum`, `hasPerk` and
// the current modifier, so a new entry only needs a field the game already
// understands.
//
// Perk fields
//   blastRadius   +share of blast radius on the owner's shots
//   blastDamage   +share of blast damage on the owner's shots
//   maxHp         +hit points
//   roundArmor    armor fitted at the start of every round
//   roundAmmo     { weapon: count } handed out at the start of every round
//   fuel          +metres of driving per round
//   discount      share taken off armory prices
//   pay           +share of the money earned for damage
//   regen         hit points repaired at the start of each of the owner's turns
//   noFall        no damage from falling
//   windScale     change to how hard the wind pushes the owner's shots
//   dragScale     change to how hard air drag (a Rain round) slows the owner's
//                 shots; only offered when the match can roll a drag modifier
//   shrapnel      bomblets a plain Shell throws onward from where it lands
//   tracer        metres of predicted flight drawn while aiming
//   doubleStrike  the owner may queue two shots in one turn (see game.js STRIKE)
//   fromRound     only offered in the draft before this round or a later one
//   mods          { mod id: levels } added to the owner's mods (core/mods.js)
//   unlock        (with mods) only offered to a tank that does not own that mod yet
//   levelUp       (with mods) only offered to a tank that owns it, below its top level
//   stack         how many times one tank may take it in a match (default 1)
//   modTurns      +turns every mod lasts once deployed
//   modHp         +share of every mod's health
//   needsMod      only offered to a tank that owns a mod
//
// Mods come from the draft (unless the host's Lab says otherwise): first an
// unlock card, then level-up cards. A draft holds at most one mod card (see
// MOD_DRAFT), and the game leaves out any that could do nothing (game.perkFits).

export const PERKS = [
  { id: 'wideblast', tag: 'WB', name: 'Wide Blast', desc: 'Your blasts reach 15% further.', blastRadius: 0.15 },
  { id: 'heavycharge', tag: 'HC', name: 'Heavy Charge', desc: 'Your blasts hit 12% harder.', blastDamage: 0.12 },
  { id: 'hull', tag: 'RH', name: 'Reinforced Hull', desc: '+20 hit points every round.', maxHp: 20 },
  { id: 'dugin', tag: 'DI', name: 'Dug In', desc: 'Start every round with 20 armor.', roundArmor: 20 },
  { id: 'quartermaster', tag: 'QM', name: 'Quartermaster', desc: 'One free Breacher every round.', roundAmmo: { breacher: 1 } },
  { id: 'longtanks', tag: 'LT', name: 'Long-Range Tanks', desc: '+15 m of driving every round.', fuel: 15 },
  { id: 'haggler', tag: 'HG', name: 'Haggler', desc: 'Armory prices are 20% lower.', discount: 0.2 },
  { id: 'bounty', tag: 'BN', name: 'Bounty Hunter', desc: '+50% money for the damage you deal.', pay: 0.5 },
  { id: 'repairs', tag: 'FR', name: 'Field Repairs', desc: 'Repair 6 hit points at the start of each of your turns.', regen: 6 },
  { id: 'shocks', tag: 'SM', name: 'Shock Mounts', desc: 'Falling into a crater no longer hurts.', noFall: true },
  { id: 'heavyrounds', tag: 'HR', name: 'Heavy Rounds', desc: 'Wind pushes your shots 35% less.', windScale: -0.35 },
  { id: 'streamlined', tag: 'SS', name: 'Streamlined Shells', desc: 'Rain drags your shells half as much.', dragScale: -0.5 },
  { id: 'shrapnel', tag: 'SH', name: 'Shrapnel', desc: 'Your plain Shells throw two bomblets onward from where they land.', shrapnel: 2 },
  { id: 'tracer', tag: 'TR', name: 'Tracer Rounds', desc: 'See the first 45 m of your shot while you aim.', tracer: 45 },
  { id: 'double', tag: 'DS', name: 'Double Strike', fromRound: 3, doubleStrike: true,
    desc: 'When you choose, queue two shots in one turn: they fire back to back. Your next turn is move only.' },
  // Mods (core/mods.js): level 1 of one you do not have, then a level at a time.
  { id: 'orbital', tag: 'OM', name: 'Orbital Mechanic', mods: { orbiter: 1 }, unlock: true,
    desc: 'Gain a Gravity Orbiter (level 1): a small gravity well that circles your tank and bends enemy shells. Deploying it takes your turn.' },
  { id: 'orbitalup', tag: 'O+', name: 'Tighter Orbit', mods: { orbiter: 1 }, levelUp: true, stack: 2,
    desc: 'Your Gravity Orbiter goes up a level: level 2 pulls harder and turns faster, level 3 is two wells, a three-body slingshot.' },
  { id: 'satrecon', tag: 'SR', name: 'Sat Recon', mods: { satellite: 1 }, unlock: true,
    desc: 'Gain a Survey Satellite (level 1): it labels a grid of cells over the enemy with the aim that lands there. Deploying it takes your turn.' },
  { id: 'satrecon2', tag: 'S+', name: 'Sharper Optics', mods: { satellite: 1 }, levelUp: true, stack: 2,
    desc: 'Your Survey Satellite goes up a level: level 2 counts the wind, moons and enemy orbiters, level 3 labels more cells.' },
  { id: 'cells', tag: 'LC', name: 'Long-Life Cells', modTurns: 2, modHp: 0.25, needsMod: true,
    desc: 'Your mods last 2 turns longer and take 25% more damage before they break.' },
];

export const PERK_BY_ID = Object.fromEntries(PERKS.map((p) => [p.id, p]));

// Total of a numeric perk field over everything the tank holds.
export function perkSum(player, key) {
  let s = 0;
  for (const id of player.perks || []) s += PERK_BY_ID[id]?.[key] || 0;
  return s;
}

export function hasPerk(player, key) {
  return (player.perks || []).some((id) => PERK_BY_ID[id]?.[key]);
}

// How mod cards (any perk with `mods`, `modTurns` or `needsMod`) come up in
// the draft: at most one per offer, there with chance `first` while the tank
// owns no mod and `then` once it does; and a tank takes at most `cap` perks
// that add mod levels in one match.
export const MOD_DRAFT = { first: 0.7, then: 0.45, cap: 4 };

export const isModPerk = (perk) => !!(perk.mods || perk.modTurns || perk.needsMod);

// How many times `player` holds perk `id`.
export const perkCount = (player, id) => (player.perks || []).filter((k) => k === id).length;

// Three perks the tank can still take (fewer once it holds nearly all): a perk
// it holds only comes round again if it `stack`s. `round` is the round the
// pick is for: perks with a later `fromRound` sit out. `allow(perk)` can leave
// out more (the game drops mod perks that could do nothing: a mod the host's
// Lab turned off, one already at its top level, an unlock for a mod it owns).
// `modChance` is the chance one of the cards is a mod card (MOD_DRAFT); it
// goes in at a random place, so it is not always the first.
export function draftOffer(player, rng, count = 3, round = Infinity, allow = () => true, modChance = MOD_DRAFT.then) {
  const fits = PERKS.filter((p) => perkCount(player, p.id) < (p.stack || 1) && (p.fromRound || 0) <= round && allow(p));
  const mods = fits.filter(isModPerk);
  const pool = fits.filter((p) => !isModPerk(p));
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0].id);
  if (mods.length && (out.length < count || rng.next() < modChance)) {
    const card = mods[rng.int(0, mods.length - 1)].id;
    if (out.length >= count) out.splice(rng.int(0, out.length - 1), 1);
    out.splice(rng.int(0, out.length), 0, card);
  }
  return out;
}

// What a CPU takes from an offer: a favourite if one is there, else any but
// what it would never use (CPUs do not fly satellites).
const AI_FAVOURITES = ['hull', 'wideblast', 'heavycharge', 'dugin', 'repairs', 'quartermaster', 'orbital', 'orbitalup'];
const AI_NEVER = ['satrecon', 'satrecon2'];
export function aiPickPerk(offer, rng) {
  const usable = offer.filter((id) => !AI_NEVER.includes(id));
  const any = usable.length ? usable : offer;
  const liked = any.filter((id) => AI_FAVOURITES.includes(id));
  return rng.pick(liked.length && rng.next() < 0.7 ? liked : any);
}

// Modifier fields
//   wind      multiplies the wind limit      calm     no wind at all
//   gravity   multiplies gravity on shells   crater   multiplies crater size
//   pay       multiplies all money earned    fuel     multiplies driving fuel
//   drag      air drag on shells, per metre (ballistics.stepProjectile: the
//             shell slows by drag * speed^2), so long, fast lobs lose the most
//
// Rain's drag 0.0007 takes a power 60 shot at 45 degrees with no wind about
// 16% short of its dry range (367 m on the flat down to about 308 m); a flat
// 20 degree shot at the same power loses about 10%, a 70 degree lob about 17%,
// and a power 90 shot at 45 degrees about 30% (test/rain.test.js).
export const RAIN_DRAG = 0.0007;
// A Gale round multiplies the match's wind by 1.8, but never past this:
// Gusty (1.5) goes to 2.7, and Gale wind (2.5) stops at 3.5 rather than 4.5,
// which blew most shots off the map. A match set above it (?wind=5) keeps its own.
export const GALE_CAP = 3.5;
export const MODIFIERS = [
  { id: 'clear', name: 'Clear skies', desc: 'Nothing unusual this round.', weight: 2 },
  { id: 'gale', name: 'Gale', desc: 'The wind is much stronger.', wind: 1.8, weight: 1 },
  { id: 'calm', name: 'Dead calm', desc: 'No wind at all.', calm: true, weight: 1 },
  { id: 'lowgrav', name: 'Low gravity', desc: 'Shells fly further: ease off the power.', gravity: 0.7, weight: 1 },
  { id: 'rain', name: 'Rain', desc: 'Rain drags your shells down short: add power, aim flatter.', drag: RAIN_DRAG, weight: 1 },
  { id: 'soft', name: 'Soft ground', desc: 'Craters are a third bigger.', crater: 1.3, weight: 1 },
  { id: 'goldrush', name: 'Gold rush', desc: 'All pay is doubled this round.', pay: 2, weight: 1 },
  { id: 'fulltanks', name: 'Full tanks', desc: 'Everyone has double fuel.', fuel: 2, weight: 1 },
];

export const MODIFIER_BY_ID = Object.fromEntries(MODIFIERS.map((m) => [m.id, m]));

// `last` is the previous round's modifier id, so a twist never repeats back to
// back. `allow(modifier)` can leave some out (the match's Round modifiers
// list, game.modifierFits); with none left the round is Clear skies, and no
// dice are rolled.
export function pickModifier(rng, last = null, allow = () => true) {
  const pool = MODIFIERS.filter((m) => allow(m) && (m.id === 'clear' || m.id !== last));
  if (!pool.length) return MODIFIER_BY_ID.clear;
  let roll = rng.range(0, pool.reduce((s, m) => s + m.weight, 0));
  for (const m of pool) { roll -= m.weight; if (roll <= 0) return m; }
  return pool[0];
}
