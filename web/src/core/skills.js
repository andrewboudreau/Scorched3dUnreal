// The skill tree: where a tank's perks and mods come from in a match.
//
// After every round each tank gets SKILL.perRound skill points. A point buys
// the next rank of any branch: a new branch, or the next rank of one it has
// started. Ranks go in order, so "all in on Sat Recon" is three points into one
// branch. Unspent points carry over. Money is for the armory; points are for
// the tree.
//
// A rank is a perk (core/perks.js): taking it pushes the perk id onto
// p.perks, the same as the old draft did, so the game reads it through
// perkSum / modLevel as before and online play sends a perk id per pick.
//
// Mod branches are made from the mod data (core/mods.js): rank 1 is the mod's
// unlock perk, ranks 2 and up its level-up perk. A new mod needs a free mod bay
// (MOD_BAYS). Perk branches are listed below; a rank the match has off (the
// host's Perks list, or a perk that could do nothing this match) is left out of
// its branch, so the next one moves up.

import { PERKS, PERK_BY_ID, perkCount } from './perks.js';
import { MODS } from './mods.js';
import { VARIANT_WEAPONS } from './weapons.js';

export const SKILL = { perRound: 1 };

// Perk branches: a short theme, and its ranks in the order they are taken.
export const PERK_BRANCHES = [
  { id: 'firepower', name: 'Firepower', theme: 'Bigger blasts', ranks: ['heavycharge', 'wideblast', 'shrapnel'] },
  { id: 'hull', name: 'Hull', theme: 'Stay alive', ranks: ['hull', 'dugin', 'repairs'] },
  { id: 'gunnery', name: 'Gunnery', theme: 'Land the shot', ranks: ['tracer', 'heavyrounds', 'streamlined', 'double'] },
  { id: 'supply', name: 'Supply', theme: 'Money and ammo', ranks: ['haggler', 'quartermaster', 'bounty'] },
  { id: 'chassis', name: 'Chassis', theme: 'Get around', ranks: ['longtanks', 'shocks'] },
  { id: 'modtuning', name: 'Mod Tuning', theme: 'Every mod lasts longer', ranks: ['cells'] },
];

// A mod's branch: its unlock perk, then its level-up perk once per level
// above 1. A mod with no unlock perk has no branch.
export function modBranch(mod) {
  const unlock = PERKS.find((k) => k.unlock && k.mods?.[mod.id]);
  if (!unlock) return null;
  const up = PERKS.find((k) => k.levelUp && k.mods?.[mod.id]);
  const ranks = [unlock.id];
  for (let l = 2; l <= mod.maxLevel && up; l++) ranks.push(up.id);
  return { id: mod.id, name: unlock.name, theme: mod.name, mod: mod.id, ranks };
}

// A weapon's branch (weapons.js `variants`, perks.js VARIANT_PERKS): rank 1
// is a fork, `options` the two variants (taking one shuts the other for the
// match); rank 2 is the family's upgrade, on whichever was taken. `ranks`
// holds the variant taken (the first option until then) and the upgrade.
export function weaponBranch(w) {
  const options = w.variants.map((v) => `${w.id}:${v.id}`);
  return { id: w.id, name: w.name, theme: 'Weapon', weapon: w.id, options, ranks: [options[0], `${w.id}:up`] };
}
export const WEAPON_BRANCHES = VARIANT_WEAPONS.map(weaponBranch);

// The variant of branch `b` (a weapon branch) the tank took, or null.
export const forkTaken = (player, b) => b.options.find((id) => perkCount(player, id) > 0) || null;

// The skill screen's tabs (src/armory.js): which a branch shows under.
export const SKILL_TABS = [
  { id: 'weapons', name: 'Weapons' },
  { id: 'mods', name: 'Mods' },
  { id: 'tank', name: 'Tank' },
];
export const tabOf = (b) => (b.weapon ? 'weapons' : b.mod || b.id === 'modtuning' ? 'mods' : 'tank');

export const BRANCHES = [...WEAPON_BRANCHES, ...MODS.map(modBranch).filter(Boolean), ...PERK_BRANCHES];
export const BRANCH_BY_ID = Object.fromEntries(BRANCHES.map((b) => [b.id, b]));

// Which branch a perk belongs to (the first that lists it).
export const branchOf = (perkId) => BRANCHES.find((b) => b.ranks.includes(perkId) || b.options?.includes(perkId)) || null;

// How many ranks of branch `b` the tank holds: a mod branch counts the
// mod's level from the tree; a perk branch counts its ranks the tank holds
// (repeats count once per copy); a weapon branch, its fork and then its upgrade.
export function ranksHeld(player, b) {
  if (b.options) return forkTaken(player, b) ? 1 + (perkCount(player, b.ranks[1]) > 0 ? 1 : 0) : 0;
  const seen = {};
  let n = 0;
  for (const id of b.ranks) {
    seen[id] = (seen[id] || 0) + 1;
    if (perkCount(player, id) >= seen[id]) n++;
    else break;
  }
  return n;
}

export { PERK_BY_ID };
