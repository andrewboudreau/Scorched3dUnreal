// Weapons are data, composed from a few reusable parts (the composable design
// the Unreal roadmap keeps from the legacy accessory tree, without the class
// explosion). `flight` parts fire while the shell is in the air; `impact`
// parts run where it lands.
//
//   blast  { radius, damage, depth }    carve a crater and hurt tanks nearby
//   split  { count, spread, child }     at the apex, become `count` child shells
//   roll   { then: [...parts] }         roll along the ground first, then run `then`
//   mound  { radius, height }           heap dirt instead of removing it
//   range  { turn, power }              leave the barrel as five harmless probes:
//                                       as aimed, turret -/+turn, power -/+power
//   steer  { rate, fuel }               the shooter can turn it left or right in
//                                       flight, `rate` deg/s, for `fuel` seconds

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
];

export const ITEMS = [
  { id: 'armor', name: 'Armor Plate', price: 200, desc: '+30 armor for the next round. Soaks damage first.' },
  { id: 'fuel', name: 'Fuel Can', price: 70, desc: '+20 m of driving for the next round.' },
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
      else if (part.type === 'roll') run(part.then);
    }
  };
  run(weapon.impact || []);
  return out;
}

// Children for a split part: same position, velocity fanned out sideways.
export function splitVelocities(vel, count, spread) {
  const [vx, , vz] = vel;
  const h = Math.hypot(vx, vz) || 1;
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
