// Weapons are data, composed from a few reusable parts (the composable design
// the Unreal roadmap keeps from the legacy accessory tree, without the class
// explosion). `flight` parts fire while the shell is in the air; `impact`
// parts run where it lands.
//
//   blast  { radius, damage, depth }    carve a crater and hurt tanks nearby
//   split  { count, spread, child,       at the apex, become `count` child shells.
//            shape }                     'line' (default) fans them sideways in a
//                                        row; 'disc' scatters them over a circle,
//                                        `spread` being its radius in m/s
//   roll   { then: [...parts] }         roll along the ground first, then run `then`
//   mound  { radius, height }           heap dirt instead of removing it
//   range  { turn, power }              leave the barrel as five harmless probes:
//                                       as aimed, turret -/+turn, power -/+power
//   steer  { rate, fuel }               the shooter can turn it left or right in
//                                       flight, `rate` deg/s, for `fuel` seconds
//   scout  { radius, turns }            fog of war: the shooter sees everything
//                                       within `radius` of where it lands, for
//                                       their next `turns` shots
//   warp   {}                           the shooter's tank is moved to where it lands
//   napalm {}                           spill burning fuel that runs downhill and
//                                       pools, burning tanks in it (core/napalm.js)
//   bury   { radius, height }           heap a dome of earth that buries any tank
//                                       under it (core/napalm.js BURY)
//   throw  { count, speed, up, child }  on impact, lob `count` child shells outward
//                                       in a star (the Splitter): `speed` m/s
//                                       across, `up` m/s up
//   burst  { height }                   (flight) go off `height` m over the ground
//                                       on the way down, not on it (the Airburst;
//                                       ballistics.burstNow)
//
// More fields on a part, for the variants:
//   blast.pierce   a tank under a Dirt Bomb dome or down in a hole below the
//                  blast is hit by the distance across only, as if level with it
//   blast.flat     every tank is hit by the distance across only (a blast in the
//                  air over the ground; it reaches under a dome too)
//   split.share    the share of the shells that land on one tank, for the
//                  price yardstick (shotValue): 0.6 when missing
//   roll.seek      { accel, range }: lean toward the nearest enemy tank in range
//                  (ballistics.seekNudge)
//   roll.hop       hops it has: hop over a bump instead of stopping (ballistics.hopOver)
//   roll.reach     the roll goes this many times as far (less grip, longer road)
//   napalm.params  changes to core/napalm.js NAPALM for this spill
//
// Variants (docs/design-guide.md, "Weapon variants"): a weapon with `variants`
// grows two ways in the skill tree. Each variant is { id, name, desc, style,
// patch }: `patch` replaces the weapon's fields it names (flight, impact);
// `style` ('bold' or 'careful') is which CPUs lean to it. `upgrade` is the
// family's rank 2, on top of either variant: { name, desc, and any of radius
// (times every blast radius), reach (times the roll), count (more shells in a
// split), napalm (more NAPALM changes) }. resolveWeapon puts them together.
//
// Every weapon a player can hold also says how it is got (docs/design-guide.md,
// "How you get things"):
//   role   one word for what it is for, shown on its armory card
//   tier   'kit' (the Shell: always there), 'standard' (in the armory from the
//          first visit) or 'advanced' (from the second visit on; see TIERS)
//   start  how many every tank starts the match with (the starting kit)
//   price, bundle   what one armory purchase costs and gives

import { NAPALM } from './napalm.js';

export const WEAPONS = [
  {
    id: 'shell', name: 'Shell', price: 0, bundle: 0, infinite: true, role: 'Damage', tier: 'kit',
    desc: 'Standard round. Always in stock.',
    impact: [{ type: 'blast', radius: 11, damage: 38, depth: 0.6 }],
  },
  {
    id: 'guided', name: 'Guided Missile', price: 90, bundle: 2, role: 'Damage', tier: 'standard', start: 1,
    desc: 'Steer it in flight with A / D for a few seconds. Shell-sized blast.',
    flight: [{ type: 'steer', rate: 34, fuel: 3 }],
    impact: [{ type: 'blast', radius: 11, damage: 38, depth: 0.6 }],
  },
  {
    id: 'breacher', name: 'Breacher', price: 180, bundle: 3, role: 'Damage', tier: 'standard', start: 1,
    desc: 'Heavy round. Wide crater, heavy damage.',
    impact: [{ type: 'blast', radius: 22, damage: 70, depth: 0.7 }],
    variants: [
      { id: 'bunker', name: 'Bunker Buster', style: 'careful',
        desc: 'A narrower blast (19 m) that digs half as deep again and hits a buried or dug-in tank in full.',
        patch: { impact: [{ type: 'blast', radius: 19, damage: 70, depth: 1.05, pierce: true }] } },
      { id: 'splitter', name: 'Splitter', style: 'bold',
        desc: 'A smaller blast (18 m, 55) that throws three bomblets outward, about 14 m each way.',
        patch: { impact: [{ type: 'blast', radius: 18, damage: 55, depth: 0.6 }, { type: 'throw', count: 3, speed: 7, up: 10, child: 'splitlet' }] } },
    ],
    upgrade: { name: 'Wider Charge', desc: 'Its blast reaches 15% wider.', radius: 1.15 },
  },
  {
    id: 'splitlet', name: 'Splitter bomblet', hidden: true,
    impact: [{ type: 'blast', radius: 9, damage: 22, depth: 0.45 }],
  },
  {
    id: 'scatter', name: 'Scatter', price: 220, bundle: 2, role: 'Damage', tier: 'advanced',
    desc: 'Splits into five shells at the top of its arc, landing in a row across the line of flight: a shot a little to one side still hits.',
    flight: [{ type: 'split', count: 5, spread: 3.5, child: 'scatterlet' }],
    impact: [{ type: 'blast', radius: 10, damage: 30, depth: 0.55 }],
    variants: [
      { id: 'line', name: 'Line', style: 'careful',
        desc: 'Five shells in a row along the line of flight instead of across it: a shot a little long or short still hits, one off to the side does not.',
        patch: { flight: [{ type: 'split', count: 5, spread: 4, shape: 'along', child: 'scatterlet', share: 0.7 }] } },
      { id: 'ring', name: 'Ring', style: 'bold',
        desc: 'Five bigger shells (12 m) in a ring round the aim point: a near miss still hits, but dead on only the edges reach.',
        patch: { flight: [{ type: 'split', count: 5, spread: 2.25, shape: 'ring', child: 'ringlet', share: 0.55 }] } },
    ],
    upgrade: { name: 'Sixth Shell', desc: 'It splits into one more shell.', count: 1 },
  },
  {
    id: 'scatterlet', name: 'Scatterlet', hidden: true,
    impact: [{ type: 'blast', radius: 10, damage: 28, depth: 0.55 }],
  },
  {
    id: 'ringlet', name: 'Ring shell', hidden: true,   // Scatter · Ring
    impact: [{ type: 'blast', radius: 12, damage: 30, depth: 0.5 }],
  },
  {
    id: 'flak', name: 'Flak', price: 200, bundle: 2, role: 'Anti-air', tier: 'standard',
    desc: 'Proximity fuse: bursts as it passes over an enemy and rains fragments on it. A near miss still hits. Anti-air: it also bursts by an enemy orbiter or satellite and can bring it down. Passing nobody, it bursts just above the ground.',
    // On the way down it bursts at its nearest pass over an enemy tank (within
    // `range` across, `low`..`high` above it), or `floor` over the ground.
    // Fragments keep `carry` of the shell's sideways speed and `fall` of its
    // speed down (plus 3 m/s), and fan out `spread` m/s, so a burst 14 m up
    // lands a pattern about 20 m across, just past the point under it.
    // (tools/balance.mjs flak: dead over a tank about 45, a Normal CPU's shot about 18, Scatter's about 18.)
    // It is anti-air too: it also bursts on its nearest pass within `air` m of an
    // enemy mod (core/mods.js), and the burst itself hurts every enemy mod in
    // reach, up to `airDamage` right on it.
    flight: [{ type: 'airburst', range: 22, low: 4, high: 40, floor: 14, count: 12, spread: 11, carry: 0.1, fall: 0.1, child: 'flaklet', air: 18, airDamage: 45 }],
    // Only if it strikes before it can burst (a flat shot into a hill): a small blast.
    impact: [{ type: 'blast', radius: 8, damage: 18, depth: 0.4 }],
  },
  {
    id: 'flaklet', name: 'Flak fragment', hidden: true,
    impact: [{ type: 'blast', radius: 7, damage: 10, depth: 0.1 }],
  },
  {
    id: 'bomblet', name: 'Bomblet', hidden: true,   // thrown by the Shrapnel perk
    impact: [{ type: 'blast', radius: 6, damage: 16, depth: 0.45 }],
  },
  {
    id: 'roller', name: 'Roller', price: 130, bundle: 3, role: 'Damage', tier: 'standard', start: 1,
    desc: 'Lands, rolls downhill and blows up where it stops or on the first tank it touches.',
    impact: [{ type: 'roll', then: [{ type: 'blast', radius: 14, damage: 55, depth: 0.6 }] }],
    variants: [
      { id: 'seeker', name: 'Seeker', style: 'careful',
        desc: 'Leans toward the nearest enemy tank within 50 m as it rolls. A smaller blast (12 m, 46).',
        patch: { impact: [{ type: 'roll', seek: { accel: 1.5, range: 50 }, then: [{ type: 'blast', radius: 12, damage: 46, depth: 0.55 }] }] } },
      { id: 'hopper', name: 'Hopper', style: 'bold',
        desc: 'Hops once over a bump instead of stopping against it, and rolls on. A little less damage (53).',
        patch: { impact: [{ type: 'roll', hop: 1, then: [{ type: 'blast', radius: 14, damage: 53, depth: 0.6 }] }] } },
    ],
    upgrade: { name: 'Long Roll', desc: 'It rolls half as far again.', reach: 1.5 },
  },
  {
    id: 'mound', name: 'Mound', price: 90, bundle: 3, role: 'Terrain', tier: 'standard', start: 1,
    desc: 'Throws up a hill of dirt. Bury a tank or build cover.',
    impact: [{ type: 'mound', radius: 20, height: 14 }],
  },
  {
    id: 'ranger', name: 'Rangefinder', price: 60, bundle: 3, role: 'Aim', tier: 'standard', start: 2,
    desc: 'No damage. Five markers: as aimed, turret ±2° and power ±5. Shows which way to adjust.',
    flight: [{ type: 'range', turn: 2, power: 5 }],
    impact: [],
  },
  {
    id: 'teleport', name: 'Teleport', price: 120, bundle: 2, role: 'Move', tier: 'advanced',
    desc: 'No damage. Your tank is moved to where it lands (nudged off water, houses and other tanks).',
    impact: [{ type: 'warp' }],
  },
  {
    // The Decoy Beacon's blink (core/mods.js): a Teleport that leaves a decoy
    // where the tank stood. Fired by deploying the decoy, never from the rack.
    id: 'blink', name: 'Blink', hidden: true,
    impact: [{ type: 'warp' }],
  },
  {
    id: 'scout', name: 'Scout Missile', price: 50, bundle: 2, fog: true, role: 'Recon', tier: 'standard',
    desc: 'Fog of war only. No damage: lights up everything within 120 m of where it lands, for you, for your next two shots.',
    impact: [{ type: 'scout', radius: 120, turns: 2 }],
  },
  {
    id: 'dirtbomb', name: 'Dirt Bomb', price: 130, bundle: 2, role: 'Terrain', tier: 'standard',
    desc: 'Bursts into a dome of earth that buries any tank within about 18 m, unhurt. A buried tank cannot drive or jump, and its next shot only digs it out: it costs a turn.',
    impact: [{ type: 'bury', radius: 20, height: 16 }],
  },
  {
    id: 'napalm', name: 'Napalm', price: 100, bundle: 2, role: 'Area', tier: 'advanced',
    desc: 'Spills burning fuel that runs downhill and pools. A tank in a crater or a valley burns for up to 56; one on a crest is barely singed. Water puts it out, and rain damps it.',
    impact: [{ type: 'napalm' }],
    variants: [
      { id: 'sticky', name: 'Sticky', style: 'careful',
        desc: 'Thick: it runs about half as far and lies deeper where it lands, so it burns a tank on open ground too, and burns about 2 s longer (up to 56).',
        patch: { impact: [{ type: 'napalm', params: { film: 0.22, ticks: 11, damage: 56 } }] } },
      { id: 'flood', name: 'Flood', style: 'bold',
        desc: 'Thin: more of it, running about half as far again and spreading wide, so it finds a hollow and burns hotter there (up to 60), but shallow and short on open ground.',
        patch: { impact: [{ type: 'napalm', params: { iters: 96, reach: 40, fuel: 9, film: 0.07, ticks: 5, damage: 60 } }] } },
    ],
    upgrade: { name: 'Wet Burn', desc: 'It burns through rain and over shallow water (up to 1.5 m deep).', napalm: { wade: 1.5, rainproof: true } },
  },
  {
    id: 'thunderhead', name: 'Thunderhead', price: 200, bundle: 1, role: 'Damage', tier: 'advanced',
    desc: 'The big one: a 30 m blast that hits as hard as anything in the armory. Mind your own tank.',
    impact: [{ type: 'blast', radius: 30, damage: 95, depth: 0.75 }],
    variants: [
      { id: 'deep', name: 'Deep Strike', style: 'careful',
        desc: 'A narrower blast (25 m) that hits harder at the centre (104) and digs a deeper crater.',
        patch: { impact: [{ type: 'blast', radius: 25, damage: 104, depth: 1.1 }] } },
      { id: 'airburst', name: 'Airburst', style: 'bold',
        desc: 'Goes off 8 m up: no crater and a little less damage (90), but the whole blast reaches across the ground, even under a Dirt Bomb dome.',
        patch: { flight: [{ type: 'burst', height: 8 }], impact: [{ type: 'blast', radius: 30, damage: 90, depth: 0, flat: true }] } },
    ],
    upgrade: { name: 'Wider Charge', desc: 'Its blast reaches 15% wider.', radius: 1.15 },
  },
];

// When each tier is in the armory: `visit` is the armory visit it opens on
// (the first visit is after round 1). A short match never waits for it: with
// fewer visits than that, it opens on the last one.
export const TIERS = {
  kit: { name: 'Kit', visit: 0 },
  standard: { name: 'Standard', visit: 1 },
  advanced: { name: 'Advanced', visit: 2 },
};

// The armory visit (1, 2, ...) a weapon is first sold on, in a match of
// `rounds` rounds (which has rounds - 1 visits).
export function opensOnVisit(weapon, rounds = Infinity) {
  const v = TIERS[weapon?.tier]?.visit ?? 1;
  return Math.max(1, Math.min(v, rounds - 1));
}

// The starting kit, as an inventory: the Shell's endless supply plus every
// weapon's `start`.
export function startKit() {
  const inv = {};
  for (const w of WEAPONS) {
    if (w.infinite) inv[w.id] = Infinity;
    else if (w.start) inv[w.id] = w.start;
  }
  return inv;
}

// What a damage weapon can do with one good shot, as one number: its centre
// damage over every shell it becomes, a little more for a wider blast
// (scaled by the square root of its radius against the Shell's 11 m). The
// armory's yardstick (test/economy.test.js): a damage weapon costs between
// VALUE_BAND dollars a point of this per shot, so nothing is a steal or a
// waste, and since the game pays PAY.perDamage ($2) a point, a shot that lands
// pays for itself.
export const VALUE_BAND = [0.5, 1.4];
export function shotValue(weapon) {
  // Napalm: the full burn on one tank, which it gets in a hollow; on open
  // ground less (core/napalm.js), so it counts at three quarters.
  const fire = (weapon.impact || []).find((p) => p.type === 'napalm');
  if (fire) return (fire.params?.damage ?? NAPALM.damage) * 0.75;
  const blastOf = (w) => (w?.impact || []).flatMap((p) => (p.type === 'roll' ? p.then : [p])).find((p) => p.type === 'blast');
  const one = (b) => (b ? b.damage * Math.sqrt(b.radius / 11) : 0);
  const byId = (id) => WEAPONS.find((w) => w.id === id);
  const split = (weapon.flight || []).find((p) => p.type === 'split' || p.type === 'airburst');
  const child = split ? byId(split.child) : null;
  const b = blastOf(child || weapon);
  if (!b) return 0;
  const n = split ? split.count : 1;
  // An airburst's fragments come down over an area: about half land on the tank.
  const share = split?.share ?? (split?.type === 'airburst' ? 0.5 : split ? 0.6 : 1);
  // Bomblets thrown on impact (the Splitter) land round the blast: counted like a split's.
  const thrown = (weapon.impact || []).filter((p) => p.type === 'throw')
    .reduce((s, t) => s + t.count * 0.6 * one(blastOf(byId(t.child))), 0);
  return one(b) * n * share + thrown;
}

// ---------- variants ----------

// The variant `vid` of weapon `w`, or null.
export const variantOf = (w, vid) => (w?.variants || []).find((v) => v.id === vid) || null;

const resolved = new Map();

// A tank's weapon as it fires: the base, with the chosen variant's patch on
// top and, with `up`, the family's rank 2 (see the header). The same
// arguments give back the same object, so the game can call it every step.
// The result keeps the base's id; `variant` and `label` ("Napalm · Sticky")
// say which it is.
export function resolveWeapon(w, vid = null, up = false) {
  const v = variantOf(w, vid);
  if (!w || !w.variants || (!v && !up)) return w;
  const key = `${w.id}|${v ? v.id : ''}|${up ? 1 : 0}`;
  let out = resolved.get(key);
  if (out) return out;
  out = JSON.parse(JSON.stringify({ ...w, ...(v ? v.patch : {}) }));
  delete out.variants;
  out.variant = v ? v.id : null;
  out.label = v ? `${w.name} · ${v.name}` : w.name;
  if (v) out.desc = v.desc;
  const u = up ? w.upgrade : null;
  if (u) {
    out.upgraded = true;
    const parts = (list) => (list || []).flatMap((p) => (p.type === 'roll' ? [p, ...p.then] : [p]));
    for (const p of parts(out.impact)) {
      if (u.radius && p.type === 'blast') p.radius = Math.round(p.radius * u.radius * 10) / 10;
      if (u.reach && p.type === 'roll') p.reach = (p.reach || 1) * u.reach;
      if (u.napalm && p.type === 'napalm') p.params = { ...(p.params || {}), ...u.napalm };
    }
    for (const p of out.flight || []) if (u.count && p.type === 'split') p.count += u.count;
  }
  resolved.set(key, out);
  return out;
}

// Every family with variants, for the skill tree and the guide.
export const VARIANT_WEAPONS = WEAPONS.filter((w) => w.variants?.length);

export const ITEMS = [
  { id: 'armor', name: 'Armor Plate', price: 200, desc: '+30 armor for the next round. Soaks damage first.' },
  { id: 'fuel', name: 'Fuel Can', price: 70, desc: '+20 m of driving for the next round.' },
  { id: 'jet', name: 'Jump Jets', price: 80, bundle: 2, desc: 'Two charges. Press J while planning to hop about 25 m the way the hull faces, over a crater rim. Costs no fuel and not your shot.' },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

// Damage falls off linearly from the centre out to 1.25x the blast radius.
export function blastDamage(dist, radius, damage) {
  const reach = radius * 1.25;
  if (dist >= reach) return 0;
  return damage * (1 - dist / reach);
}

// The roll part of a weapon, if it has one. The game rolls the shell along the
// ground (ballistics.stepRoller) before running the part's `then` list.
export function rollPart(weapon) {
  return (weapon.impact || []).find((p) => p.type === 'roll') || null;
}

// Expand a weapon's impact parts at a point into concrete effects. For a
// rolling weapon, `point` is where the roll ended.
export function impactEffects(weapon, point) {
  const out = [];
  const run = (parts) => {
    for (const part of parts) {
      if (part.type === 'blast') out.push({ type: 'blast', point, radius: part.radius, damage: part.damage, depth: part.depth, ...(part.pierce ? { pierce: true } : {}), ...(part.flat ? { flat: true } : {}) });
      else if (part.type === 'mound') out.push({ type: 'mound', point, radius: part.radius, height: part.height });
      else if (part.type === 'scout') out.push({ type: 'scout', point, radius: part.radius, turns: part.turns });
      else if (part.type === 'warp') out.push({ type: 'warp', point });
      else if (part.type === 'napalm') out.push({ type: 'napalm', point, ...(part.params ? { params: part.params } : {}) });
      else if (part.type === 'bury') out.push({ type: 'bury', point, radius: part.radius, height: part.height });
      else if (part.type === 'roll') run(part.then);
    }
  };
  run(weapon.impact || []);
  return out;
}

// Children for a split part: same position, velocity fanned out sideways (a
// row across the line of flight), or with shape 'disc' pushed out over a
// circle of radius `spread`, so the fragments come down over an area; 'along'
// is a row down the line of flight, 'ring' an even ring.
export function splitVelocities(vel, count, spread, shape = 'line') {
  const [vx, , vz] = vel;
  const h = Math.hypot(vx, vz) || 1;
  if (shape === 'disc') {
    // A sunflower pattern: even coverage with no two fragments alike, and no
    // randomness, so every copy of an online game agrees.
    const ux = Math.hypot(vx, vz) > 1e-6 ? vx / h : 1;
    const uz = Math.hypot(vx, vz) > 1e-6 ? vz / h : 0;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const disc = [];
    for (let k = 0; k < count; k++) {
      const r = spread * Math.sqrt((k + 0.5) / count);
      const a = k * golden;
      const along = r * Math.cos(a);
      const across = r * Math.sin(a);
      disc.push([vel[0] + ux * along - uz * across, vel[1], vel[2] + uz * along + ux * across]);
    }
    return disc;
  }
  const ux = Math.hypot(vx, vz) > 1e-6 ? vx / h : 1;
  const uz = Math.hypot(vx, vz) > 1e-6 ? vz / h : 0;
  if (shape === 'ring') {
    // Scatter · Ring: evenly round a circle, the first straight ahead.
    const ring = [];
    for (let k = 0; k < count; k++) {
      const a = (k / count) * 2 * Math.PI;
      const along = spread * Math.cos(a), across = spread * Math.sin(a);
      ring.push([vel[0] + ux * along - uz * across, vel[1], vel[2] + uz * along + ux * across]);
    }
    return ring;
  }
  // 'along' (Scatter · Line): a row down the line of flight, faster and
  // slower; else a row across it.
  const px = shape === 'along' ? ux : -vz / h;
  const pz = shape === 'along' ? uz : vx / h;
  const out = [];
  for (let k = 0; k < count; k++) {
    const s = count === 1 ? 0 : (k / (count - 1)) * 2 - 1;
    out.push([vel[0] + px * spread * s, vel[1], vel[2] + pz * spread * s]);
  }
  return out;
}

// The Splitter's bomblets (a `throw` part): lobbed outward from the impact
// in an even star, the first along the shell's line of flight.
export function throwVelocities(vel, part) {
  const h = Math.hypot(vel[0], vel[2]);
  const a0 = h > 1e-6 ? Math.atan2(vel[2], vel[0]) : 0;
  const out = [];
  for (let k = 0; k < part.count; k++) {
    const a = a0 + (k / part.count) * 2 * Math.PI;
    out.push([Math.cos(a) * part.speed, part.up, Math.sin(a) * part.speed]);
  }
  return out;
}

// Should a falling airburst shell (Flak) go off now? At its nearest pass over
// an enemy tank (across distance no longer shrinking), inside the window above
// it; or close over solid ground. `tanks` are [{ x, y, z, owner }]; `ground`
// is the height under the shell, or null over open space.
export function airburstNow(pr, burst, tanks, ground) {
  const [x, y, z] = pr.pos;
  if (pr.vel[1] >= 0) return false;
  for (const t of tanks) {
    if (t.owner === pr.owner) continue;
    const dx = t.x - x, dz = t.z - z;
    const up = y - t.y;
    if (up < burst.low || up > burst.high || dx * dx + dz * dz > burst.range * burst.range) continue;
    if (dx * pr.vel[0] + dz * pr.vel[2] <= 0 || dx * dx + dz * dz < 9) return true;   // past its closest, or right over it
  }
  return ground != null && y - ground < burst.floor;
}

// Flak against what hangs in the sky: the enemy mod (from mods.js modTargets)
// this shell has just made its nearest pass by, within `burst.air` m, or null.
export function airburstNearMod(pr, burst, mods) {
  if (!burst.air || pr.time < 0.4) return null;
  for (const m of mods) {
    if (m.owner === pr.owner) continue;
    const d = Math.hypot(pr.pos[0] - m.x, pr.pos[1] - m.y, pr.pos[2] - m.z);
    if (d > burst.air) continue;
    const d0 = Math.hypot(pr.prev[0] - m.x, pr.prev[1] - m.y, pr.prev[2] - m.z);
    if (d > d0 || d < m.r + 2) return m;
  }
  return null;
}

// The fragments of an airburst: a downward fan under the burst point.
export function airburstVelocities(vel, burst) {
  const base = [vel[0] * burst.carry, Math.min(vel[1] * (burst.fall ?? 0.4), 0) - 3, vel[2] * burst.carry];
  return splitVelocities(base, burst.count, burst.spread, 'disc');
}

// A rangefinder's five probes: the shot as aimed, then the turret turned each
// way and the power eased off and pushed. `power` is clamped to [minPower, maxPower].
export function rangeProbes(yaw, power, part, minPower, maxPower) {
  const pw = (d) => Math.min(maxPower, Math.max(minPower, power + d));
  const wrap = (a) => ((a % 360) + 360) % 360;
  return [
    { key: 'aim', yaw: wrap(yaw), power },
    { key: 'turn-', yaw: wrap(yaw - part.turn), power },
    { key: 'turn+', yaw: wrap(yaw + part.turn), power },
    { key: 'power-', yaw: wrap(yaw), power: pw(-part.power) },
    { key: 'power+', yaw: wrap(yaw), power: pw(part.power) },
  ];
}
