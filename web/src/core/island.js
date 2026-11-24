import { makeRng } from './rng.js';
import { makePerlin, fbm } from './noise.js';

// The Island: one large island in an open sea that fills the field. Its coast
// has two or three bays and a headland or two, ragged with noise, and often a
// small islet offshore. Inland it rises from a sandy beach into hills; the
// meadow's scenery (trees, hamlets, farms, roads) dresses it, kept to the dry
// land by the water level like any lake.
//
// The sea is the field's water (`waterLevel`, at ISLAND.sea) and is marked on
// the field as `sea`, which changes three rules:
// - A shell that comes down in the sea is lost there: a splash, no crater, no
//   damage (ballistics.groundContact tags the point `.sea`).
// - The coast crumbles: a blast slumps the low ground round it (crumbleCoast,
//   run by Heightfield.carveCrater), so beaches and low headlands are eaten
//   away and the sea comes in over them.
// - A tank whose ground ends up more than ISLAND.drown under the water sinks
//   and is lost (game.js updateFalling), the kill going to whoever blew the
//   ground away.
//
// Deterministic from the seed, like everything in core: only the seeded rng
// and seeded noise.

export const ISLAND = {
  sea: 0,            // the sea's level
  size: [0.6, 0.68], // the coast's mean distance from the middle, as a share of the half-width
  maxReach: 0.82,    // ...and never further out than this (before the ragged noise), so there is sea all round
  ring: 0.55,        // tanks start this share of the way from the middle to the coast
  beach: 14,         // metres of sand from the waterline up to the grass
  shelf: 0.28,       // the seabed's slope off the beach
  deep: 13,          // how deep the sea gets
  hills: 35,         // the Terrain menu's amplitude for the Island
  drown: 0.8,        // a tank whose ground is this far under the water sinks
  pad: 4,            // a tank's pad stands at least this far above the sea
  // A blast slumps low ground (under `low` m above the sea) out to `reach`
  // times its radius, by up to `drop` m at the middle.
  crumble: { reach: 1.45, drop: 3.2, low: 3 },
};

const TAU = Math.PI * 2;
const angleDiff = (a, b) => ((a - b + Math.PI * 3) % TAU) - Math.PI;
const bump = (u) => (Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The island's outline for a round's seed: `radius(angle)` is the distance
// from the middle to the coast (before the ragged noise), and `islet` the
// small offshore isle ({ x, z, r }) or null. Pure: placeTanks and
// generateIsland both ask it, so the tanks start inside the coast that is built.
export function islandShape(seed, half) {
  const rng = makeRng(seed * 23 + 9);
  const R = half * rng.range(ISLAND.size[0], ISLAND.size[1]);
  const waves = [2, 3, 4, 5].map((k) => ({ k, a: rng.range(0.02, 0.07) / (k * 0.5), ph: rng.range(0, TAU) }));
  // Bays and headlands, spread round the coast: bay, headland, bay, ...
  const nb = rng.int(2, 3);
  const nh = rng.int(1, 2);
  const a0 = rng.range(0, TAU);
  const features = [];
  for (let i = 0, bays = nb, heads = nh; i < nb + nh; i++) {
    const bay = !((i % 2 === 1 && heads > 0) || bays === 0);
    if (bay) bays--; else heads--;
    const at = a0 + (i / (nb + nh)) * TAU + rng.range(-0.3, 0.3);
    features.push(bay
      ? { at, w: rng.range(0.24, 0.42), d: -rng.range(0.2, 0.33) }
      : { at, w: rng.range(0.13, 0.22), d: rng.range(0.15, 0.24) });
  }
  const radius = (a) => {
    let k = 1;
    for (const w of waves) k += w.a * Math.cos(w.k * a + w.ph);
    for (const f of features) k += f.d * bump(angleDiff(a, f.at) / f.w);
    return Math.min(half * ISLAND.maxReach, Math.max(R * 0.45, R * k));
  };
  // An islet off the coast, where there is room for it inside the field.
  let islet = null;
  for (let tries = 0; tries < 12 && !islet; tries++) {
    const a = rng.range(0, TAU);
    const r = rng.range(16, 28);
    const gap = rng.range(24, 44);
    let coast = 0;
    for (let s = -4; s <= 4; s++) coast = Math.max(coast, radius(a + (s / 4) * ((r + gap) / (R * 0.8))));
    const d = coast + gap + r;
    if (d + r * 1.3 < half * 0.93) islet = { x: Math.cos(a) * d, z: Math.sin(a) * d, r };
  }
  return { R, features, radius, islet };
}

// The tank pads for an Island round, in pad order: spread round a ring part
// way out to the coast, so every tank starts on land with the others round
// the island from it. `order` is the player indices; returns [player index,
// x, z] like placeTanks.
export function islandStarts(order, shape, rng) {
  const n = order.length;
  const base = rng.range(0, TAU);
  return order.map((pi, k) => {
    const a = base + (k / n) * TAU + rng.range(-0.15, 0.15);
    const r = shape.radius(a) * ISLAND.ring * rng.range(0.85, 1.1);
    return [pi, Math.cos(a) * r, Math.sin(a) * r];
  });
}

// Build the island on `field`, a Heightfield, for the round's seed. Sets the
// heights, the sea (`sea` and `waterLevel`) and no undersides or moons. `pads`
// ([x, z] each) are kept at least ISLAND.pad above the water.
export function generateIsland(field, { seed = 7, amplitude = ISLAND.hills, pads = [] } = {}) {
  field.under = null;
  field.isles = [];
  field.wells = [];
  field.bedrock = field.baseBedrock;
  field.sea = ISLAND.sea;
  field.waterLevel = ISLAND.sea;
  const shape = islandShape(seed, field.half);
  field.island = shape;
  const ragged = makePerlin(seed * 7 + 3);
  const hillsN = makePerlin(seed);
  const bed = makePerlin(seed * 31 + 5);
  const A = amplitude;
  const sea = ISLAND.sea;
  const n = field.n;
  const H = field.heights;
  const iso = shape.islet;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = field.vx(i);
      const z = field.vz(j);
      const k = field.index(i, j);
      field.scorch[k] = 0;
      const d = Math.hypot(x, z);
      const rag = 1 + 0.07 * ragged(x * 0.012, z * 0.012) + 0.025 * ragged(x * 0.05 + 11, z * 0.05);
      // Signed distance to the coast, metres: positive inland.
      const D = shape.radius(Math.atan2(z, x)) * rag - d;
      const floor = -(ISLAND.deep + 3 * bed(x * 0.01, z * 0.01));
      let h;
      if (D < 0) h = sea + 0.4 + Math.max(D * ISLAND.shelf, floor);
      else {
        const hills = A * 0.22 * Math.min(1, D / 160) + Math.max(0, fbm(hillsN, x, z, { frequency: 0.006, octaves: 4, amplitude: A }) + A * 0.25);
        h = sea + 0.4 + 2 * Math.min(1, D / ISLAND.beach) + hills * smooth(8, 70, D);
      }
      if (iso) {
        const Di = iso.r * (1 + 0.15 * ragged(x * 0.04 + 5, z * 0.04)) - Math.hypot(x - iso.x, z - iso.z);
        const hi = Di < 0 ? sea + 0.4 + Math.max(Di * ISLAND.shelf, floor) : sea + 0.4 + 2 * Math.min(1, Di / 6) + 7 * smooth(4, iso.r, Di);
        h = Math.max(h, hi);
      }
      for (const [px, pz] of pads) if (Math.hypot(x - px, z - pz) < 36) h = Math.max(h, sea + ISLAND.pad);
      H[k] = h;
    }
  }
  return field;
}

// A blast at (cx, cz) of `radius` slumps the low ground round it: every vertex
// under ISLAND.crumble.low over the sea, out to `reach` radii, drops by up to
// `drop` m (most at the middle). A beach struck near the waterline goes under,
// and the sea comes in. Returns the grid region it touched.
export function crumbleCoast(field, cx, cz, radius) {
  const C = ISLAND.crumble;
  const reach = radius * C.reach;
  const r = field.regionFor(cx, cz, reach);
  const top = field.sea + C.low;
  const H = field.heights;
  for (let j = r.j0; j <= r.j1; j++) {
    for (let i = r.i0; i <= r.i1; i++) {
      const dist = Math.hypot(field.vx(i) - cx, field.vz(j) - cz);
      if (dist >= reach) continue;
      const k = field.index(i, j);
      const h = H[k];
      if (h >= top || h < field.sea - 6) continue;
      H[k] = Math.max(field.bedrock + 1, h - C.drop * (1 - dist / reach));
    }
  }
  return r;
}
