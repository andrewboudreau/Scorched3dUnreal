// Napalm and the Dirt Bomb: the rules that are not plain blasts. Pure
// functions of the ground, so every copy of an online game agrees.
//
// Napalm: burning fuel spilt where the shell lands runs downhill over the
// heightfield's vertices and pools in hollows. The flow is a small fixed
// simulation (NAPALM.iters steps over a window round the impact, always in the
// same order, plain arithmetic, no dice): each step every wet vertex passes
// some of its fuel to the lower of its eight neighbours, by how much lower
// their surface (ground plus fuel) is. Each vertex the fuel crosses keeps a
// film of it (thinner on a slope), so a long run downhill thins out and stops. Water and open sky
// (the isles) swallow whatever reaches them. Then it burns for a few seconds:
// a tank is hurt each tick by how deep the fuel is round it, so one sitting in
// a crater or a valley takes the full dose and one on a crest is barely singed.

export const NAPALM = {
  fuel: 7,        // vertex-metres of fuel spilt (depth summed over vertices)
  film: 0.12,     // m each wet vertex on the level keeps: what a run leaves behind
  slick: 6,       // a slope keeps less: the film over 1 + slick x the steepest drop (rise over run)
  rate: 0.25,     // share of the steepest surface drop passed on per step (fuel on the level spreads)
  iters: 48,      // flow steps; a run goes at most this many vertices
  reach: 20,      // window half-size in vertices (about 62 m on a 800 m / 256 field)
  ref: 0.4,       // m of fuel round a tank for the full dose
  heat: 5,        // m: the patch round a tank whose fuel it feels
  damage: 56,     // the most one tank takes from one fire, over all its ticks
  ticks: 7,       // damage ticks
  lag: 0.9,       // s after the spill before the first tick (the screen shows the fuel running)
  every: 0.45,    // s between ticks
  flowTime: 0.025, // s of screen time per flow step, for the running fuel (render only)
  scorch: 0.75,   // how dark the ground is burnt where the fuel was deepest
  rain: 0.65,     // share of the damage it does in a Rain round (the rain damps it)
  // Two fields only the variants set (weapons.js, Napalm's `params`):
  //   wade       m: water shallower than this does not put it out (it floats and burns)
  //   rainproof  true: Rain does not damp it
};

// NAPALM with a spill's own changes (a variant's `params`) on top.
export const napalmParams = (params) => (params ? { ...NAPALM, ...params } : NAPALM);

// The burn's whole length, s: the fire holds the shot's flight until it is out.
export const burnTime = (N = NAPALM) => N.lag + (N.ticks - 1) * N.every + 0.05;
export const BURN_TIME = burnTime();

const W8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 0.7071], [1, -1, 0.7071], [-1, 1, 0.7071], [-1, -1, 0.7071]];

// Spill napalm at x/z. Returns { cells: [[i, j, fuel, arrive], ...] (in grid
// order), lost (fuel swallowed by water or sky), doused (it came down in water
// or over sky: nothing burns) }. `arrive` is the step the fuel got there.
export function flowNapalm(t, x, z, N = NAPALM) {
  const ci = Math.round((x + t.half) / t.cell);
  const cj = Math.round((z + t.half) / t.cell);
  const R = N.reach, W = 2 * R + 1, n = W * W;
  const h = new Float64Array(n), f = new Float64Array(n), d = new Float64Array(n);
  const film = new Float64Array(n);
  const ok = new Uint8Array(n), sink = new Uint8Array(n), arrive = new Int16Array(n).fill(-1);
  const water = t.waterLevel;
  for (let b = 0; b < W; b++) {
    for (let a = 0; a < W; a++) {
      const gi = ci - R + a, gj = cj - R + b, idx = b * W + a;
      if (gi < 0 || gj < 0 || gi > t.res || gj > t.res) continue;   // off the field: a wall
      const k = t.index(gi, gj);
      ok[idx] = 1;
      h[idx] = t.heights[k];
      if (t.isOpen(k) || h[idx] < water - (N.wade || 0)) sink[idx] = 1;   // `wade`: fuel floats over water shallower than this
    }
  }
  // The film each vertex keeps: thinner the steeper the ground falls away from it.
  for (let b = 0; b < W; b++) {
    for (let a = 0; a < W; a++) {
      const idx = b * W + a;
      if (!ok[idx]) continue;
      let steep = 0;
      for (const [da, db, wt] of W8) {
        const aa = a + da, bb = b + db;
        if (aa < 0 || bb < 0 || aa >= W || bb >= W || !ok[bb * W + aa]) continue;
        const s = (h[idx] - h[bb * W + aa]) * wt / t.cell;
        if (s > steep) steep = s;
      }
      film[idx] = N.film / (1 + N.slick * steep);
    }
  }
  const c = R * W + R;
  if (!ok[c] || sink[c]) return { cells: [], lost: N.fuel, doused: true };
  f[c] = N.fuel;
  arrive[c] = 0;
  let lost = 0;
  const drop = new Float64Array(8);
  for (let it = 1; it <= N.iters; it++) {
    d.fill(0);
    for (let b = 0; b < W; b++) {
      for (let a = 0; a < W; a++) {
        const idx = b * W + a;
        const free = f[idx] - film[idx];
        if (!(free > 0)) continue;
        const level = h[idx] + f[idx];
        let sum = 0, max = 0;
        for (let m = 0; m < 8; m++) {
          drop[m] = 0;
          const aa = a + W8[m][0], bb = b + W8[m][1];
          if (aa < 0 || bb < 0 || aa >= W || bb >= W) continue;
          const nb = bb * W + aa;
          if (!ok[nb]) continue;
          const dl = level - (h[nb] + f[nb]);
          if (dl <= 0) continue;
          drop[m] = dl * W8[m][2];
          sum += drop[m];
          if (dl > max) max = dl;
        }
        if (sum <= 0) continue;
        const move = Math.min(free, max * N.rate);
        d[idx] -= move;
        for (let m = 0; m < 8; m++) {
          if (drop[m] > 0) d[(b + W8[m][1]) * W + a + W8[m][0]] += move * drop[m] / sum;
        }
      }
    }
    for (let idx = 0; idx < n; idx++) {
      if (d[idx] === 0) continue;
      f[idx] += d[idx];
      if (d[idx] > 0 && arrive[idx] < 0) arrive[idx] = it;
      if (sink[idx] && f[idx] > 0) { lost += f[idx]; f[idx] = 0; }
    }
  }
  const cells = [];
  for (let b = 0; b < W; b++) {
    for (let a = 0; a < W; a++) {
      const idx = b * W + a;
      if (f[idx] > 1e-4) cells.push([ci - R + a, cj - R + b, f[idx], arrive[idx]]);
    }
  }
  return { cells, lost, doused: false };
}

// Burn the ground where the fuel lay (the scorch map the terrain draws).
// Returns the grid region touched, for the renderer, or null.
export function scorchNapalm(t, cells, N = NAPALM) {
  if (!cells.length) return null;
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [i, j, fuel] of cells) {
    const k = t.index(i, j);
    t.scorch[k] = Math.min(1, t.scorch[k] + N.scorch * Math.min(1, 0.35 + fuel / N.ref));
    i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  return { i0: Math.max(0, i0 - 1), i1: Math.min(t.res, i1 + 1), j0: Math.max(0, j0 - 1), j1: Math.min(t.res, j1 + 1) };
}

// How hot it is for a tank at x/z: the weighted mean depth of fuel within
// NAPALM.heat m (dry vertices count as nothing), over NAPALM.ref, capped at 1.
export function napalmDose(t, cells, x, z, N = NAPALM) {
  const R = N.heat;
  let num = 0, den = 0;
  const i0 = Math.ceil((x - R + t.half) / t.cell), i1 = Math.floor((x + R + t.half) / t.cell);
  const j0 = Math.ceil((z - R + t.half) / t.cell), j1 = Math.floor((z + R + t.half) / t.cell);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const w = 1 - Math.hypot(t.vx(i) - x, t.vz(j) - z) / R;
      if (w > 0) den += w;
    }
  }
  if (!(den > 0)) return 0;
  for (const [i, j, fuel] of cells) {
    if (i < i0 || i > i1 || j < j0 || j > j1) continue;
    const w = 1 - Math.hypot(t.vx(i) - x, t.vz(j) - z) / R;
    if (w > 0) num += w * fuel;
  }
  return Math.min(1, num / den / N.ref);
}

// The damage one tick does at full dose.
export const napalmTick = (N = NAPALM) => N.damage / N.ticks;

// ---------- the Dirt Bomb ----------
//
// It throws up a dome of earth (the Mound's heap, bigger and steeper). A tank
// with at least BURY.depth m of soil over it is buried: it takes no damage
// from the dome, cannot drive or hop, and its next shot goes off against the
// soil at the muzzle and digs it out instead of flying (the ammo is kept).
// A blast that clears the soil off it (to within BURY.free m) frees it too.

export const BURY = {
  depth: 2.5,     // m of soil over a tank that bury it
  free: 1,        // m: with less than this over it, it is out
  digMin: 9,      // m: the dig-out's crater is at least this wide...
  digSpread: 1.8, // ...or this many times the soil over the tank
};

// The crater that digs a tank `soil` m down out: { radius, depth } for carveCrater
// centred on the ground over it, reaching just past the tank's base.
export function digOut(soil, B = BURY) {
  const radius = Math.max(B.digMin, soil * B.digSpread);
  return { radius, depth: (soil + 0.3) / radius };
}
