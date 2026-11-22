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

export const WEAPONS = [
  {
    id: 'shell', name: 'Shell', price: 0, bundle: 0, infinite: true,
    desc: 'Standard round. Always in stock.',
    impact: [{ type: 'blast', radius: 11, damage: 38, depth: 0.6 }],
  },
  {
    id: 'guided', name: 'Guided Missile', price: 90, bundle: 2,
    desc: 'Steer it in flight with A / D for a few seconds. Shell-sized blast.',
    flight: [{ type: 'steer', rate: 34, fuel: 3 }],
    impact: [{ type: 'blast', radius: 11, damage: 38, depth: 0.6 }],
  },
  {
    id: 'breacher', name: 'Breacher', price: 160, bundle: 3,
    desc: 'Heavy round. Wide crater, heavy damage.',
    impact: [{ type: 'blast', radius: 22, damage: 70, depth: 0.7 }],
  },
  {
    id: 'scatter', name: 'Scatter', price: 240, bundle: 2,
    desc: 'Splits into five shells at the top of its arc.',
    flight: [{ type: 'split', count: 5, spread: 9, child: 'scatterlet' }],
    impact: [{ type: 'blast', radius: 10, damage: 30, depth: 0.55 }],
  },
  {
    id: 'scatterlet', name: 'Scatterlet', hidden: true,
    impact: [{ type: 'blast', radius: 10, damage: 28, depth: 0.55 }],
  },
  {
    id: 'flak', name: 'Flak', price: 220, bundle: 2,
    desc: 'Bursts at the top of its arc into 14 small shells over a wide area. Shallow craters, light hits.',
    // Spread 5 m/s lands a pattern about 50 m across: 8 left gaps wider than a
    // tank between fragments, so a burst right over a target could miss it.
    flight: [{ type: 'split', count: 14, spread: 5, shape: 'disc', child: 'flaklet' }],
    // Only if it never reaches the top of its arc (a flat shot): a small dud of a blast.
    impact: [{ type: 'blast', radius: 8, damage: 18, depth: 0.4 }],
  },
  {
    id: 'flaklet', name: 'Flak fragment', hidden: true,
    impact: [{ type: 'blast', radius: 7, damage: 10, depth: 0.3 }],
  },
  {
    id: 'bomblet', name: 'Bomblet', hidden: true,   // thrown by the Shrapnel perk
    impact: [{ type: 'blast', radius: 6, damage: 16, depth: 0.45 }],
  },
  {
    id: 'roller', name: 'Roller', price: 130, bundle: 3,
    desc: 'Lands, rolls downhill and blows up where it stops or on the first tank it touches.',
    impact: [{ type: 'roll', then: [{ type: 'blast', radius: 14, damage: 55, depth: 0.6 }] }],
  },
  {
    id: 'mound', name: 'Mound', price: 90, bundle: 3,
    desc: 'Throws up a hill of dirt. Bury a tank or build cover.',
    impact: [{ type: 'mound', radius: 20, height: 14 }],
  },
  {
    id: 'ranger', name: 'Rangefinder', price: 60, bundle: 3,
    desc: 'No damage. Five markers: as aimed, turret ±2° and power ±5. Shows which way to adjust.',
    flight: [{ type: 'range', turn: 2, power: 5 }],
    impact: [],
  },
  {
    id: 'teleport', name: 'Teleport', price: 120, bundle: 2,
    desc: 'No damage. Your tank is moved to where it lands (nudged off water, houses and other tanks).',
    impact: [{ type: 'warp' }],
  },
  {
    id: 'scout', name: 'Scout Missile', price: 50, bundle: 2, fog: true,
    desc: 'Fog of war only. No damage: lights up everything within 120 m of where it lands, for you, for your next two shots.',
    impact: [{ type: 'scout', radius: 120, turns: 2 }],
  },
];

export const ITEMS = [
  { id: 'armor', name: 'Armor Plate', price: 200, desc: '+30 armor for the next round. Soaks damage first.' },
  { id: 'fuel', name: 'Fuel Can', price: 70, desc: '+20 m of driving for the next round.' },
  { id: 'satellite', name: 'Survey Satellite', price: 200, levels: 3, desc: 'Puts a satellite over the enemy that projects a grid of cells on the ground; some are labelled with the turret and power that land there from where you stand. Level 1 leaves out the wind, level 2 counts it (and any moon), level 3 labels more cells.' },
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
      if (part.type === 'blast') out.push({ type: 'blast', point, radius: part.radius, damage: part.damage, depth: part.depth });
      else if (part.type === 'mound') out.push({ type: 'mound', point, radius: part.radius, height: part.height });
      else if (part.type === 'scout') out.push({ type: 'scout', point, radius: part.radius, turns: part.turns });
      else if (part.type === 'warp') out.push({ type: 'warp', point });
      else if (part.type === 'roll') run(part.then);
    }
  };
  run(weapon.impact || []);
  return out;
}

// Children for a split part: same position, velocity fanned out sideways (a
// row across the line of flight), or with shape 'disc' pushed out over a
// circle of radius `spread`, so the fragments come down over an area.
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
  // Horizontal unit vector perpendicular to travel.
  const px = -vz / h;
  const pz = vx / h;
  const out = [];
  for (let k = 0; k < count; k++) {
    const s = count === 1 ? 0 : (k / (count - 1)) * 2 - 1;
    out.push([vel[0] + px * spread * s, vel[1], vel[2] + pz * spread * s]);
  }
  return out;
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
