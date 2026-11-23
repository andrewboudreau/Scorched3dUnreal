// Pure helpers for the resource-pack review (src/review.js): no DOM, no
// three.js, so node --test can reach them. Packs follow the game-resource
// oracle's spec (pack.json with typed items: sfx, hdri, material, model, ...).

// The game's sound events a recorded sample can stand in for, in panel order.
export const EVENTS = [
  ['fire', 'Cannon'],
  ['whoosh', 'Shell leaving'],
  ['explode-small', 'Blast, small'],
  ['explode-medium', 'Blast, medium'],
  ['explode-big', 'Blast, big'],
  ['explode-far', 'Blast, far off'],
  ['thump', 'Blast, low body (under every blast)'],
  ['debris', 'Debris patter after a blast'],
  ['crackle', 'Fire crackle (near burning things)'],
  ['impact', 'Ground impact'],
  ['hit', 'Tank hit'],
  ['wreck', 'Wreck parts landing'],
  ['jet', 'Jump jet'],
  ['warp', 'Teleport'],
  ['ping', 'Rangefinder ping'],
  ['click', 'UI click'],
];

// First match wins, so the specific explosion sizes come before plain "cannon"
// and the heavy metal before the small debris.
const GUESS = [
  [/explosion.*(distant|far)|(distant|far).*explosion/, 'explode-far'],
  [/explosion.*small|small.*explosion/, 'explode-small'],
  [/explosion.*(medium|mid)/, 'explode-medium'],
  [/explosion.*(big|large|huge)/, 'explode-big'],
  [/crackle|fire-?loop|campfire|burning/, 'crackle'],
  [/rubble|debris-fall|patter|rock-?fall/, 'debris'],
  [/sub-?bass|boom-?low|low-?boom/, 'thump'],
  [/cannon|artillery|gunshot/, 'fire'],
  [/whoosh|whistle|missile/, 'whoosh'],
  [/metal-(clank|thud|slam)|debris-heavy/, 'wreck'],
  [/metal-debris|metal-hit|clink/, 'hit'],
  [/earth|dirt|impact/, 'impact'],
  [/jump.?jet|thrust|rocket/, 'jet'],
  [/teleport|warp|zap/, 'warp'],
  [/ping|beep|blip/, 'ping'],
  [/ui-click|click/, 'click'],
];

// Which event an sfx item most likely belongs to, from its id; null if none.
export function guessEvent(item) {
  const id = String(item?.id ?? '').toLowerCase();
  for (const [re, ev] of GUESS) if (re.test(id)) return ev;
  return null;
}

// How the panel treats an item type.
export function kindOf(type) {
  if (type === 'sfx' || type === 'music' || type === 'ambience') return 'sound';
  if (type === 'hdri') return 'sky';
  if (type === 'material') return 'material';
  if (type === 'model') return 'model';
  return 'image';
}

// Variants share a group: an explicit group or mood, else the id less a
// trailing take number ("explosion-big-3" -> "explosion-big").
export function groupOf(item) {
  return item.group || item.mood || String(item.id).replace(/-\d+$/, '');
}

// The files to try for a sound, best first (Opus, then the fallback).
export function soundFiles(item) {
  const f = item.files && typeof item.files === 'object' ? Object.values(item.files) : [];
  return [...new Set([item.file, item.fallback, ...f].filter((x) => typeof x === 'string'))];
}

// A pack-relative path as a URL under the dev server's /packs/ mount.
export function packUrl(pack, rel) {
  const dir = encodeURIComponent(pack.dir || pack.id);
  return `packs/${dir}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

// Short facts for an item's row: length, size, source file, notes.
export function itemFacts(item) {
  const out = [];
  if (item.duration_s) out.push(`${item.duration_s.toFixed(2)} s`);
  if (item.size_m) out.push(`${item.size_m.map((v) => v.toFixed(1)).join(' x ')} m`);
  if (item.tris) out.push(`${item.tris} tris`);
  if (item.tile_m) out.push(`tile ${item.tile_m} m`);
  if (item.bytes) out.push(item.bytes > 1e6 ? `${(item.bytes / 1e6).toFixed(1)} MB` : `${Math.round(item.bytes / 1024)} KB`);
  if (item.orig_file || item.orig_id) out.push(item.orig_file || item.orig_id);
  return out;
}

// What gets saved for the oracle: per pack, the kept and dropped item ids,
// plus which sounds were assigned to which game events.
export function summarizePicks(votes, use) {
  const packs = {};
  for (const [pack, items] of Object.entries(votes)) {
    const keep = [], drop = [];
    for (const [id, v] of Object.entries(items)) (v === 'keep' ? keep : v === 'drop' ? drop : []).push(id);
    if (keep.length || drop.length) packs[pack] = { keep: keep.sort(), drop: drop.sort() };
  }
  const events = {};
  for (const [ev, keys] of Object.entries(use)) if (keys.length) events[ev] = [...keys].sort();
  return { packs, events };
}
