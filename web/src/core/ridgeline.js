import { makeRng } from './rng.js';
import { makePerlin } from './noise.js';

// Ridgeline: the field as a cross-section. The tanks stand in a row from west
// to east (along x, near the middle in z) and the ground between them is a
// jagged mountain range whose ridges run north to south, across the line of
// fire, so nearly every shot is a lob over a peak. The profile varies along x;
// along z it only wobbles a little.
//
// Every peak is kept under a line rising at RIDGE.clear from each of the two
// tanks either side of it, so an arc of 45 degrees or more always has a way
// over (the CPUs' first guess is 42 to 62 degrees). With few tanks far apart
// that leaves room for real mountains; with many close together the ridges
// come down to hills.
//
// Deterministic from the seed, like everything in core: only the seeded rng
// and seeded noise.

export const RIDGE = {
  reach: 0.72,     // the row spans this share of the field's half-width each way
  zSpread: 0.045,  // tanks stand within this share of the half-width of z = 0
  clear: 0.5,      // a peak's top stays under this slope from the tanks either side
  hills: 60,       // the Terrain menu's amplitude for the Ridgeline
};

// The tank pads for a ridgeline round, in pad order: one slot per tank across
// the row, west to east in the order `order` shuffled them, jittered a little.
// `order` is the player indices; returns [player index, x, z] like placeTanks.
export function rowStarts(order, field, rng) {
  const n = order.length;
  const L = field.half * RIDGE.reach;
  const gap = n > 1 ? (2 * L) / (n - 1) : 0;
  return order.map((pi, k) => {
    const x = n > 1 ? -L + k * gap + rng.range(-0.12, 0.12) * Math.min(gap, 120) : rng.range(-40, 40);
    const z = rng.range(-1, 1) * field.half * RIDGE.zSpread;
    return [pi, x, z];
  });
}

// One mountain: centre `c`, half-widths `wl` / `wr` either side, height `h`
// over the valley floor, `p` the sharpness (above 1, the flanks curve in to a
// spike), and `mesa` a share of `h` where the top is cut flat (0 for none).
function peakAt(pk, x) {
  const d = x - pk.c;
  const w = d < 0 ? pk.wl : pk.wr;
  const u = 1 - Math.abs(d) / w;
  if (u <= 0) return 0;
  const v = pk.h * u ** pk.p;
  return pk.mesa ? Math.min(v, pk.h * pk.mesa) : v;
}

// The range between the pads ([x, z] each) on `field`, a Heightfield. Sets the
// heights and marks the field as a ridgeline (`ridge`), with no undersides,
// moons or water.
export function generateRidgeline(field, { seed = 7, amplitude = RIDGE.hills, pads = [] } = {}) {
  field.waterLevel = -Infinity;
  field.under = null;
  field.isles = [];
  field.wells = [];
  field.bedrock = field.baseBedrock;
  field.ridge = true;
  const rng = makeRng(seed * 19 + 5);
  const floorN = makePerlin(seed * 5 + 1);
  const jagN = makePerlin(seed * 3 + 7);
  const wob = makePerlin(seed * 11 + 2);
  const A = amplitude;
  const half = field.half;
  const xs = pads.map(([x]) => x).sort((a, b) => a - b);
  if (!xs.length) xs.push(0);
  const peaks = [];
  // Between each pair of neighbours, a peak every 70 to 110 m, each under the
  // clearance lines from both tanks (`edge` -1 / 1: past the first / last tank,
  // where only the tank's side counts).
  const fill = (a, b, edge) => {
    const S = b - a;
    if (S < 30) return;
    const count = Math.max(1, Math.round(S / rng.range(70, 110)));
    const slot = S / count;
    for (let c = 0; c < count; c++) {
      const cx = a + slot * (c + 0.5) + rng.range(-0.18, 0.18) * slot;
      const room = edge < 0 ? b - cx : edge > 0 ? cx - a : Math.min(cx - a, b - cx);
      const cap = (edge ? 0.95 : RIDGE.clear) * room;
      peaks.push({
        c: cx,
        wl: Math.min(cx - a, slot * rng.range(0.35, 0.7)),
        wr: Math.min(b - cx, slot * rng.range(0.35, 0.7)),
        h: Math.min(A * rng.range(0.6, 2.4), cap),
        p: rng.range(1.1, 1.8),
        mesa: rng.next() < 0.2 ? rng.range(0.6, 0.8) : 0,
      });
    }
  };
  for (let k = 0; k + 1 < xs.length; k++) fill(xs[k], xs[k + 1], 0);
  // Past the first and last tank the range rises to a massif at each end.
  fill(-half - 40, xs[0] - 14, -1);
  fill(xs[xs.length - 1] + 14, half + 40, 1);
  const floorAt = (x) => A * 0.12 + A * 0.22 * (floorN(x * 0.004, 0.5) * 0.7 + floorN(x * 0.011, 4.5) * 0.3);
  // The profile along x: the valley floor, the highest peak there, and
  // ridged noise that roughens the peaks (more the higher they stand).
  const profile = (x) => {
    let top = 0;
    let tall = 1;
    for (const pk of peaks) {
      const v = peakAt(pk, x);
      if (v > top) { top = v; tall = pk.h; }
    }
    const crag = 1 - Math.abs(jagN(x * 0.045, 1.7));
    const crag2 = 1 - Math.abs(jagN(x * 0.13, 6.1));
    const k = Math.min(1, top / Math.max(8, tall)) * Math.min(1, tall / A);
    return floorAt(x) + top + (crag * crag * 10 + crag2 * 4 - 4.5) * k * (A / 60);
  };
  const n = field.n;
  const H = field.heights;
  for (let j = 0; j < n; j++) {
    const z = field.vz(j);
    // The ridges bend a little as they run north to south.
    const warp = 12 * wob(z * 0.0045, 3.3) + 3.5 * wob(z * 0.021, 9.1);
    for (let i = 0; i < n; i++) {
      const x = field.vx(i);
      const k = field.index(i, j);
      const base = profile(x + warp);
      H[k] = base * (1 + 0.05 * wob(x * 0.012, z * 0.012 + 20)) + 1.2 * wob(x * 0.06 + 40, z * 0.06);
      field.scorch[k] = 0;
    }
  }
  field.peaks = peaks;
  return field;
}

// The ground as it stood before any blast (after the pads were levelled): the
// renderer shows cut ground below it as strata. Kept on the field as `crust`.
export function keepCrust(field) {
  if (!field.crust || field.crust.length !== field.heights.length) field.crust = new Float32Array(field.heights.length);
  field.crust.set(field.heights);
}

// A few loose boulders on the slopes: the only scenery on a ridgeline. Pushes
// rock props onto `scenery.props`, clear of the tanks.
export function ridgeRocks(scenery, rng, tanks, keep = 18) {
  const t = scenery.terrain;
  const want = rng.int(18, 30);
  for (let tries = 0, n = 0; tries < 600 && n < want; tries++) {
    const x = rng.range(-1, 1) * (t.half - 8);
    const z = rng.range(-1, 1) * (t.half - 8);
    if (tanks.some((k) => Math.hypot(k.x - x, k.z - z) < keep)) continue;
    const s = scenery.slopeAt(x, z);
    if (s < 0.04 || s > 0.35) continue;
    n++;
    scenery.props.push({ kind: 'rock', x, y: t.heightAt(x, z), z, rot: rng.range(0, Math.PI * 2), scale: rng.range(0.8, 1.9), tint: rng.int(0, 3), state: 'ok' });
  }
}
