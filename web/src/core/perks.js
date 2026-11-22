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
//   shrapnel      bomblets a plain Shell throws onward from where it lands
//   tracer        metres of predicted flight drawn while aiming
//   doubleStrike  the owner may queue two shots in one turn (see game.js STRIKE)
//   fromRound     only offered in the draft before this round or a later one
//   mods          { mod id: levels } added to the owner's mods (core/mods.js)
//   modTurns      +turns every mod lasts once deployed
//   modHp         +share of every mod's health
//   needsMod      only offered to a tank that owns a mod

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
  { id: 'shrapnel', tag: 'SH', name: 'Shrapnel', desc: 'Your plain Shells throw two bomblets onward from where they land.', shrapnel: 2 },
  { id: 'tracer', tag: 'TR', name: 'Tracer Rounds', desc: 'See the first 45 m of your shot while you aim.', tracer: 45 },
  { id: 'double', tag: 'DS', name: 'Double Strike', fromRound: 3, doubleStrike: true,
    desc: 'When you choose, queue two shots in one turn: they fire back to back. Your next turn is move only.' },
  // Mods (core/mods.js): a level up, or level 1 of one you do not have.
  { id: 'orbital', tag: 'OM', name: 'Orbital Mechanic', mods: { orbiter: 1 },
    desc: 'Your Gravity Orbiter goes up a level (you get one at level 1 if you have none). Deploying it takes your turn.' },
  { id: 'satrecon', tag: 'SR', name: 'Sat Recon', mods: { satellite: 1 },
    desc: 'Your Survey Satellite goes up a level (you get one at level 1 if you have none). Deploying it takes your turn.' },
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

// Three perks the tank does not hold yet (fewer once it owns nearly all).
// `round` is the round the pick is for: perks with a later `fromRound` sit out.
// `allow(perk)` can leave out more (the game drops mod perks that could do
// nothing: a mod the host's Lab turned off, or already at its top level).
export function draftOffer(player, rng, count = 3, round = Infinity, allow = () => true) {
  const pool = PERKS.filter((p) => !(player.perks || []).includes(p.id) && (p.fromRound || 0) <= round && allow(p));
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0].id);
  return out;
}

// What a CPU takes from an offer: a favourite if one is there, else any.
const AI_FAVOURITES = ['hull', 'wideblast', 'heavycharge', 'dugin', 'repairs', 'quartermaster'];
export function aiPickPerk(offer, rng) {
  const liked = offer.filter((id) => AI_FAVOURITES.includes(id));
  return rng.pick(liked.length && rng.next() < 0.7 ? liked : offer);
}

// Modifier fields
//   wind      multiplies the wind limit      calm     no wind at all
//   gravity   multiplies gravity on shells   crater   multiplies crater size
//   pay       multiplies all money earned    fuel     multiplies driving fuel
export const MODIFIERS = [
  { id: 'clear', name: 'Clear skies', desc: 'Nothing unusual this round.', weight: 2 },
  { id: 'gale', name: 'Gale', desc: 'The wind is much stronger.', wind: 1.8, weight: 1 },
  { id: 'calm', name: 'Dead calm', desc: 'No wind at all.', calm: true, weight: 1 },
  { id: 'lowgrav', name: 'Low gravity', desc: 'Shells fly further: ease off the power.', gravity: 0.7, weight: 1 },
  { id: 'soft', name: 'Soft ground', desc: 'Craters are a third bigger.', crater: 1.3, weight: 1 },
  { id: 'goldrush', name: 'Gold rush', desc: 'All pay is doubled this round.', pay: 2, weight: 1 },
  { id: 'fulltanks', name: 'Full tanks', desc: 'Everyone has double fuel.', fuel: 2, weight: 1 },
];

export const MODIFIER_BY_ID = Object.fromEntries(MODIFIERS.map((m) => [m.id, m]));

// `last` is the previous round's modifier id, so a twist never repeats back to back.
export function pickModifier(rng, last = null) {
  const pool = MODIFIERS.filter((m) => m.id === 'clear' || m.id !== last);
  let roll = rng.range(0, pool.reduce((s, m) => s + m.weight, 0));
  for (const m of pool) { roll -= m.weight; if (roll <= 0) return m; }
  return pool[0];
}
