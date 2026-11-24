import { makeRng } from './rng.js';
import { makePerlin } from './noise.js';

// Ridgeline: the field as a cross-section. The tanks stand in a row from west
// to east (along x) and the ground between them is a jagged mountain range
// whose ridges run north to south, across the line of fire, so nearly every
// shot is a lob over a peak. The range is a thin slice: the playable land is a
// narrow band along x, and past it in z the ground drops away in steep flanks
// to a low floor, so from the side it reads as a cross-section of the range.
//
// The row is different every round: uneven gaps, shifted toward one end of the
// field, off the middle of the band in z, and now and then a tank on a
// ledge (a shoulder of rock) instead of a valley floor.
//
// Every peak is kept under a line rising at RIDGE.clear from each of the two
// tanks either side of it, so an arc of 45 degrees or more always has a way
// over (the CPUs' first guess is 42 to 62 degrees). With few tanks far apart
// that leaves room for real mountains; with many close together the ridges
// come down to hills.
//
// The rock is also sand: after a blast `slump` lets the loosened ground slide
// down to RIDGE.repose, so craters soften and undercut peaks sag.
//
// Deterministic from the seed, like everything in core: only the seeded rng
// and seeded noise (and plain arithmetic, so every copy slumps alike).

export const RIDGE = {
  reach: 0.82,     // the row may stand within this share of the field's half-width of its middle
  span: [0.5, 0.92],   // the row spans this share of that reach (a random share each round)
  minGap: 54,      // no two tanks closer than this along x (less when many crowd a small field)
  band: 58,        // the playable band: half its width in z, in metres
  bandWobble: 0.14,  // the band's edge wanders by this share along x
  zSpread: 0.5,    // tanks stand within this share of the band's half-width of z = 0
  flank: 34,       // the drop from the band's edge to the floor, in metres of z
  floor: -46,     // the low floor past the flanks (y)
  ledge: 0.34,     // the chance a tank stands up on a ledge
  ledgeLift: [11, 24],  // how high a ledge stands over the valley floor
  clear: 0.5,      // a peak's top stays under this slope from the tanks either side
  hills: 60,       // the Terrain menu's amplitude for the Ridgeline
  crater: 1.4,     // blasts dig this much wider and deeper than elsewhere (tanks take the same damage)
  repose: 37,      // the steepest slope loose ground holds, in degrees
  slumpPasses: 40, // at most this many sweeps of the slump after a blast
  slumpRate: 0.8, // the share of a slope's excess a cell hands down per sweep
};

// The tank pads for a ridgeline round, in pad order: one slot per tank across
// the row, west to east in the order `order` shuffled them. `order` is the
// player indices; returns [player index, x, z, lift] like placeTanks, `lift`
// being the height of the ledge it stands on (0 for the valley floor).
export function rowStarts(order, field, rng) {
  const n = order.length;
  const half = field.half;
  const R = half * RIDGE.reach;
  if (n === 1) return [[order[0], rng.range(-R, R), rng.range(-1, 1) * RIDGE.band * RIDGE.zSpread, 0]];
  const minGap = Math.min(RIDGE.minGap, (2 * R * 0.85) / (n - 1));
  const base = minGap * (n - 1);
  // How wide the row is, then where it sits in the field.
  const span = Math.min(2 * R, Math.max(base * 1.25, 2 * R * rng.range(RIDGE.span[0], RIDGE.span[1])));
  const x0 = rng.range(-R, R - span);
  // Uneven gaps: the minimum each, and the rest shared out by random weights.
  const w = Array.from({ length: n - 1 }, () => rng.range(0.25, 1.75));
  const wsum = w.reduce((a, b) => a + b, 0);
  const extra = span - base;
  let x = x0;
  return order.map((pi, k) => {
    if (k > 0) x += minGap + (extra * w[k - 1]) / wsum;
    const z = rng.range(-1, 1) * RIDGE.band * RIDGE.zSpread;
    const lift = rng.next() < RIDGE.ledge ? rng.range(RIDGE.ledgeLift[0], RIDGE.ledgeLift[1]) : 0;
    return [pi, x, z, lift];
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

const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// The range between the pads ([x, z, lift] each) on `field`, a Heightfield.
// Sets the heights and marks the field as a ridgeline (`ridge`), with no
// undersides, moons or water.
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
  const bandN = makePerlin(seed * 13 + 3);
  const A = amplitude;
  const half = field.half;
  const floorAt = (x) => A * 0.12 + A * 0.22 * (floorN(x * 0.004, 0.5) * 0.7 + floorN(x * 0.011, 4.5) * 0.3);
  const tanks = pads.map(([x, , lift = 0]) => ({ x, lift })).sort((a, b) => a.x - b.x);
  if (!tanks.length) tanks.push({ x: 0, lift: 0 });
  const peaks = [];
  // A ledge under each raised tank: a shoulder with a flat top.
  for (let k = 0; k < tanks.length; k++) {
    const t = tanks[k];
    if (!(t.lift > 0)) continue;
    const gap = Math.min(k > 0 ? t.x - tanks[k - 1].x : 99, k + 1 < tanks.length ? tanks[k + 1].x - t.x : 99);
    const w = Math.min(60, gap * 0.62);
    peaks.push({ c: t.x, wl: w, wr: w, h: t.lift / 0.64, p: 1, mesa: 0.64, ledge: true });
  }
  const M = 17;   // peaks keep this far from a tank's x (its pad is levelled out to 14 m)
  // Between each pair of neighbours, a peak every 55 to 90 m, each under the
  // clearance lines from both tanks (`edge` -1 / 1: past the first / last tank,
  // where only the tank's side counts).
  const fill = (a, b, edge, ya, yb) => {
    const S = b - a;
    if (S < 30) return;
    const count = Math.max(1, Math.round(S / rng.range(55, 90)));
    const slot = S / count;
    for (let c = 0; c < count; c++) {
      const cx = a + slot * (c + 0.5) + rng.range(-0.18, 0.18) * slot;
      const fl = floorAt(cx);
      // The top may stand this high and keep the lob open (less a margin for
      // the roughening crags).
      const top = edge < 0 ? yb + RIDGE.clear * (b - cx)
        : edge > 0 ? ya + RIDGE.clear * (cx - a)
        : Math.min(ya + RIDGE.clear * (cx - a), yb + RIDGE.clear * (b - cx));
      const cap = edge ? 0.95 * (top - fl) : top - fl - 5;
      peaks.push({
        c: cx,
        wl: Math.max(5, Math.min(cx - a - (edge < 0 ? 0 : M), slot * rng.range(0.28, 0.55))),
        wr: Math.max(5, Math.min(b - cx - (edge > 0 ? 0 : M), slot * rng.range(0.28, 0.55))),
        h: Math.max(3, Math.min(A * rng.range(0.6, 2.4), cap)),
        p: rng.range(1.3, 2.1),
        mesa: rng.next() < 0.15 ? rng.range(0.6, 0.8) : 0,
      });
    }
  };
  const topOf = (t) => floorAt(t.x) + t.lift;
  for (let k = 0; k + 1 < tanks.length; k++) fill(tanks[k].x, tanks[k + 1].x, 0, topOf(tanks[k]), topOf(tanks[k + 1]));
  // Past the first and last tank the range rises to a massif at each end.
  fill(-half - 40, tanks[0].x - 14, -1, 0, topOf(tanks[0]));
  fill(tanks[tanks.length - 1].x + 14, half + 40, 1, topOf(tanks[tanks.length - 1]), 0);
  // The profile along x: the valley floor, the highest peak there, and
  // ridged noise that roughens the peaks (more the higher they stand).
  const profile = (x) => {
    let hi = 0;
    let tall = 1;
    for (const pk of peaks) {
      const v = peakAt(pk, x);
      if (v > hi) { hi = v; tall = pk.h; }
    }
    const crag = 1 - Math.abs(jagN(x * 0.045, 1.7));
    const crag2 = 1 - Math.abs(jagN(x * 0.13, 6.1));
    const k = Math.min(1, hi / Math.max(8, tall)) * Math.min(1, tall / A);
    return floorAt(x) + hi + (crag * crag * 10 + crag2 * 4 - 4.5) * k * (A / 60);
  };
  const n = field.n;
  const H = field.heights;
  for (let j = 0; j < n; j++) {
    const z = field.vz(j);
    // The ridges bend a little as they run north to south.
    const warp = 8 * wob(z * 0.0045, 3.3) + 2.5 * wob(z * 0.021, 9.1);
    for (let i = 0; i < n; i++) {
      const x = field.vx(i);
      const k = field.index(i, j);
      const ground = profile(x + warp) * (1 + 0.05 * wob(x * 0.012, z * 0.012 + 20)) + 1.2 * wob(x * 0.06 + 40, z * 0.06);
      // The band: full height inside it, then a steep flank down to the floor.
      const edge = RIDGE.band * (1 + RIDGE.bandWobble * Math.max(-1, Math.min(1, bandN(x * 0.011, 0.5) * 1.6)));
      const d = Math.abs(z) - edge + 7 * wob(x * 0.035, 60 + (z < 0 ? 0 : 30));
      const f = 1 - smooth(d / RIDGE.flank);
      const floor = RIDGE.floor + 3 * wob(x * 0.02 + 70, z * 0.02);
      H[k] = floor + (ground - floor) * f;
      field.scorch[k] = 0;
    }
  }
  field.peaks = peaks;
  return field;
}

// Loose ground slides. After a crater or a mound at (cx, cz), cells near it
// (within `reach`) whose slope to a lower neighbour is steeper than
// RIDGE.repose give material to that neighbour until it isn't (or the sweeps
// run out). Only ground already disturbed (not as it stood after the pads were
// levelled, `field.crust`) can slide, and what it uncovers can follow, so a
// crater's walls soften and a peak it undercut sags, while the untouched
// cliffs stand. A fixed order, a fixed number of sweeps and plain arithmetic:
// every copy of the game gets the same ground. Returns the grid region it may
// have changed ({ i0, i1, j0, j1 }), or null when there is nothing to do.
const EPS = 0.015;
const NB = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2]];
export function slump(field, cx, cz, reach) {
  const crust = field.crust;
  if (!field.ridge || !crust || crust.length !== field.heights.length) return null;
  const H = field.heights;
  const n = field.n;
  const res = field.res;
  const r = field.regionFor(cx, cz, reach);
  const i0 = Math.max(1, r.i0);
  const i1 = Math.min(res - 1, r.i1);
  const j0 = Math.max(1, r.j0);
  const j1 = Math.min(res - 1, r.j1);
  if (i1 < i0 || j1 < j0) return null;
  const step = Math.tan((RIDGE.repose * Math.PI) / 180) * field.cell;   // the steepest drop to a cardinal neighbour
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const act = new Uint8Array(w * h);
  const wake = (i, j) => {
    for (let b = Math.max(j0, j - 1); b <= Math.min(j1, j + 1); b++) for (let a = Math.max(i0, i - 1); a <= Math.min(i1, i + 1); a++) act[(b - j0) * w + (a - i0)] = 1;
  };
  let any = false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * n + i;
      if (Math.abs(H[k] - crust[k]) > EPS) { wake(i, j); any = true; }
    }
  }
  if (!any) return null;
  for (let pass = 0; pass < RIDGE.slumpPasses; pass++) {
    let moved = false;
    const back = pass & 1;   // sweep one way, then the other, so nothing drifts to a side
    for (let jj = 0; jj < h; jj++) {
      const j = back ? j1 - jj : j0 + jj;
      for (let ii = 0; ii < w; ii++) {
        const i = back ? i1 - ii : i0 + ii;
        const a = (j - j0) * w + (i - i0);
        if (!act[a]) continue;
        act[a] = 0;
        const k = j * n + i;
        const loose = Math.abs(H[k] - crust[k]) > EPS;
        for (const [di, dj, len] of NB) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 1 || nj < 1 || ni >= res || nj >= res) continue;
          const nk = nj * n + ni;
          const d = H[k] - H[nk] - step * len;
          if (d <= EPS || !(loose || Math.abs(H[nk] - crust[nk]) > EPS)) continue;
          const m = d * RIDGE.slumpRate;
          H[k] -= m;
          H[nk] += m;
          moved = true;
          wake(ni, nj);
          wake(i, j);
        }
      }
    }
    if (!moved) break;
  }
  return { i0: Math.max(0, i0 - 1), i1: Math.min(res, i1 + 1), j0: Math.max(0, j0 - 1), j1: Math.min(res, j1 + 1) };
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
  const want = rng.int(14, 24);
  for (let tries = 0, n = 0; tries < 600 && n < want; tries++) {
    const x = rng.range(-1, 1) * (t.half - 8);
    const z = rng.range(-1, 1) * (RIDGE.band + RIDGE.flank * 0.4);
    if (tanks.some((k) => Math.hypot(k.x - x, k.z - z) < keep)) continue;
    const s = scenery.slopeAt(x, z);
    if (s < 0.04 || s > 0.35) continue;
    n++;
    scenery.props.push({ kind: 'rock', x, y: t.heightAt(x, z), z, rot: rng.range(0, Math.PI * 2), scale: rng.range(0.8, 1.9), tint: rng.int(0, 3), state: 'ok' });
  }
}
