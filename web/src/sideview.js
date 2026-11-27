import { makeProjectile, stepProjectile, groundContact, wellContact, launchVelocity } from './core/ballistics.js';
import { muzzleOrigin } from './core/tank.js';

// The side view's numbers (no three.js, no DOM; the drawing is
// render/sidepanel.js).
//
// The aim arc shows only the climb of your shot, up to the top of its flight,
// and that is a rule of the game: the fall is yours to judge, with the wind
// and the ground. This module traces the same flight the arc draws (the same
// makeProjectile / stepProjectile path, with this turn's wind, gravity, drag,
// the moons and the arena's edge) and lays it out flat, side on: distance
// along the shot against height, with the ground under it. It reveals no more
// than the 3D aids do:
//   - the climb, to the top, always;
//   - with the Tracer perk, the flight is shown to the later of the top and
//     the perk's reach (45 m of flight from the muzzle), as its 3D line is;
//   - the ground is drawn past the end of the flight, because the world shows
//     it anyway, but nothing says where the shell comes down.
// A shell that meets the ground, a wall or a moon on its way up ends there, as
// the arc does.

export const FLIGHT = { maxPts: 400, steps: 2400 };
export const GROUND = { samples: 150, behind: 14, past: 2.2, minPast: 70, minSpan: 90 };

// A flight in world coordinates, in buffers made once and refilled.
export function makeFlight() {
  return {
    x: new Float32Array(FLIGHT.maxPts), y: new Float32Array(FLIGHT.maxPts), z: new Float32Array(FLIGHT.maxPts),
    n: 0,
    n1: 0,         // where the second line starts after the flight wraps round the edge, else 0
    hit: null,     // 'ground' | 'wall' | 'moon' | null (still in the air at the end)
    edge: '',      // 'bounces' | 'wraps' when the flight met the arena's edge
    apexAt: -1,    // the index of the top of the climb, or -1 if it met something first
    edgeAt: -1,    // the index of the point where it first met the edge, else -1
  };
}

// Trace `p`'s shot into `f`: from the muzzle up to the top of its flight, or
// to `reach` metres of flight if that is further (the Tracer perk). `game`
// gives terrain, wind, gravity, windShare(p) and shellDrag(p).
export function traceFlight(f, game, p, reach = 0) {
  const t = game.terrain;
  const pr = makeProjectile(muzzleOrigin(p), launchVelocity(p.yaw, p.elev, p.power), t);
  pr.g = game.gravity;
  pr.windK = game.windShare(p);
  pr.drag = game.shellDrag(p);
  if (t.wells && t.wells.length) pr.wells = t.wells;
  let n = 0;
  f.n1 = 0;
  f.hit = null;
  f.edge = '';
  f.edgeAt = -1;
  f.apexAt = -1;
  let atTop = false;
  const put = (q) => { f.x[n] = q[0]; f.y[n] = q[1]; f.z[n] = q[2]; n++; };
  put(pr.pos);
  let len = 0;
  for (let i = 0; i < FLIGHT.steps && n < FLIGHT.maxPts - 1; i++) {
    stepProjectile(pr, game.wind);
    const c = pr.crossed;
    if (c) {
      if (f.edgeAt < 0) f.edgeAt = n;
      put(c.point);
      if (c.kind === 'wall') { f.hit = 'wall'; break; }
      if (c.kind === 'bounce') f.edge = 'bounces';
      else if (!f.n1) { f.n1 = n; put(c.to); f.edge = 'wraps'; }
      else break;        // wrapped twice: the first time round only
    } else len += Math.hypot(pr.pos[0] - pr.prev[0], pr.pos[1] - pr.prev[1], pr.pos[2] - pr.prev[2]);
    if (pr.wells && wellContact(pr)) { f.hit = 'moon'; break; }
    if (t.inBounds(pr.pos[0], pr.pos[2])) {
      const g = groundContact(pr, t);
      if (g) { put(g); f.hit = 'ground'; break; }
    }
    if (i % 4 === 3) put(pr.pos);
    if (pr.vel[1] <= 0) {                          // the top of the climb
      if (f.apexAt < 0) { if (i % 4 !== 3) put(pr.pos); f.apexAt = n - 1; }
      if (len >= reach) { atTop = true; break; }
    }
  }
  if (!f.hit && !atTop) put(pr.pos);
  f.n = n;
  return f;
}

const wrapCell = (v, size) => Math.floor(v / size);
// Fold a coordinate back into [-half, half] the way a bouncing shell goes.
function fold(v, half) {
  const size = half * 4;
  let u = (((v + half) % size) + size) % size;
  if (u > half * 2) u = size - u;
  return u - half;
}

// The side view: the flight as (s, y) pairs, s the distance along the shot
// from the tank (metres of ground covered, kept on running through a bounce,
// and standing still across a wrap), plus the ground under and past it.
export function makeSide() {
  return {
    s: new Float32Array(FLIGHT.maxPts), y: new Float32Array(FLIGHT.maxPts), n: 0, n1: 0, top: 0,
    edgeS: NaN,                                 // where along the shot it met the arena's edge, else NaN
    ground: new Float32Array(GROUND.samples),   // heights, NaN where there is none (past a wall, over void, at a wrap)
    s0: 0, s1: 1, ds: 1,                        // the ground's samples run from s0 to s1
    yMin: 0, yMax: 1,
    topS: 0, topY: 0, topUnder: NaN,            // the end of the shown flight and the ground below it
    tankS: 0, tankY: 0,
    reach: 0,                                   // how far along the line the arena goes in a straight line (for markers)
    water: null,
  };
}

// Lay `f` (traceFlight) out flat for the shot of `p` on `terrain`.
export function layoutSide(side, f, terrain, p) {
  const yaw = p.yaw * Math.PI / 180;
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  // s counts from the tank: the muzzle is a little ahead of it.
  const s = side.s, y = side.y;
  let acc = Math.hypot(f.x[0] - p.x, f.z[0] - p.z);
  s[0] = acc; y[0] = f.y[0];
  for (let i = 1; i < f.n; i++) {
    if (i !== f.n1) acc += Math.hypot(f.x[i] - f.x[i - 1], f.z[i] - f.z[i - 1]);
    s[i] = acc; y[i] = f.y[i];
  }
  side.n = f.n; side.n1 = f.n1;
  side.edgeS = f.edgeAt >= 0 ? s[f.edgeAt] : NaN;
  const last = f.n - 1;
  const sLast = s[last];
  const top = f.apexAt >= 0 ? f.apexAt : last;   // the top, or where the climb ended
  side.top = top;
  side.topS = s[top]; side.topY = y[top];
  side.tankS = 0; side.tankY = p.y;

  // The ground along the shot, as the flight's own track on the ground, then
  // straight on from where it ends, by the edge's rule.
  const span = Math.max(sLast * GROUND.past, sLast + GROUND.minPast, GROUND.minSpan);
  const s0 = -GROUND.behind, s1 = span;
  const N = GROUND.samples;
  const ds = (s1 - s0) / (N - 1);
  side.s0 = s0; side.s1 = s1; side.ds = ds;
  // The way on past the end: the flight's last horizontal heading (else the yaw).
  let hx = dx, hz = dz;
  for (let i = last - 1; i >= f.n1; i--) {
    const ex = f.x[last] - f.x[i], ez = f.z[last] - f.z[i];
    const l = Math.hypot(ex, ez);
    if (l > 1) { hx = ex / l; hz = ez / l; break; }
  }
  const mode = terrain.edge;
  const half = terrain.half;
  let yMin = Infinity, yMax = -Infinity;
  let j = 0;                  // the flight segment the sample is in
  let prevCell = 0;
  for (let k = 0; k < N; k++) {
    const sk = s0 + k * ds;
    let x, z, gap = false;
    if (sk <= s[0]) {
      // behind the muzzle: back along the yaw line from the first point
      x = f.x[0] + dx * (sk - s[0]); z = f.z[0] + dz * (sk - s[0]);
    } else if (sk <= sLast) {
      while (j < last - 1 && sk > s[j + 1]) { j++; if (j === f.n1 && f.n1) gap = true; }   // past the wrap: a cut in the ground
      const a = j, b = j + 1;
      const w = s[b] > s[a] ? (sk - s[a]) / (s[b] - s[a]) : 0;
      x = f.x[a] + (f.x[b] - f.x[a]) * w; z = f.z[a] + (f.z[b] - f.z[a]) * w;
    } else {
      const d = sk - sLast;
      x = f.x[last] + hx * d; z = f.z[last] + hz * d;
      if (mode === 'bounce') { x = fold(x, half); z = fold(z, half); }
      else if (mode === 'wrap') {
        const cell = wrapCell(x + half, half * 2) * 7919 + wrapCell(z + half, half * 2);
        if (cell !== prevCell) gap = true;
        prevCell = cell;
        x = ((((x + half) % (half * 2)) + half * 2) % (half * 2)) - half;
        z = ((((z + half) % (half * 2)) + half * 2) % (half * 2)) - half;
      }
    }
    let h = NaN;
    if (!gap && terrain.solidAt(x, z)) h = terrain.heightAt(x, z);
    side.ground[k] = h;
    if (h === h) { if (h < yMin) yMin = h; if (h > yMax) yMax = h; }
  }
  for (let i = 0; i < f.n; i++) { if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i]; }
  if (side.tankY < yMin) yMin = side.tankY;
  if (side.tankY + 3 > yMax) yMax = side.tankY + 3;
  if (!(yMin < Infinity)) { yMin = 0; yMax = 1; }
  side.yMin = yMin; side.yMax = yMax;
  side.water = Number.isFinite(terrain.waterLevel) ? terrain.waterLevel : null;
  // The ground under the end of the flight (the ring the arc drops to).
  side.topUnder = f.hit && f.apexAt < 0 ? NaN : terrain.solidAt(f.x[top], f.z[top]) ? terrain.heightAt(f.x[top], f.z[top]) : NaN;
  // How far the shot's own line runs before it meets the arena's edge.
  side.reach = edgeDistance(p.x, p.z, dx, dz, half);
  return side;
}

// How far from (x, z) along (dx, dz) until the edge of the square arena.
export function edgeDistance(x, z, dx, dz, half) {
  let d = Infinity;
  if (dx > 1e-9) d = Math.min(d, (half - x) / dx); else if (dx < -1e-9) d = Math.min(d, (-half - x) / dx);
  if (dz > 1e-9) d = Math.min(d, (half - z) / dz); else if (dz < -1e-9) d = Math.min(d, (-half - z) / dz);
  return Math.max(0, d);
}

// Where a tank at (x, z) sits relative to the shot's line: metres along it and
// metres off to the side (right of the aim positive), or null when the line
// does not stay straight that far (the edge would bend it) or it is behind.
export function alongShot(side, p, x, z) {
  const yaw = p.yaw * Math.PI / 180;
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const ex = x - p.x, ez = z - p.z;
  const along = ex * dx + ez * dz;
  if (along < 0 || along > Math.min(side.s1, side.reach)) return null;
  return { along, side: -ex * dz + ez * dx };
}

// The scale and offset that fit the side into a w x h box with a margin, at
// one scale for both axes (a true profile). screen x = ox + s * k, y = oy - h * k.
export function fitSide(side, w, h, pad = 4, out = {}) {
  const sw = side.s1 - side.s0;
  const sh = Math.max(20, side.yMax - side.yMin);
  const k = Math.min((w - 2 * pad) / sw, (h - 2 * pad - 10) / sh);
  out.k = k;
  out.ox = pad - side.s0 * k;
  out.oy = h - pad - 4 + side.yMin * k;
  return out;
}

// The setting, remembered in localStorage: on or off once chosen, else
// `fallback` (on for touch, off on a desktop).
export const SIDE_KEY = 'craterfall.sideview';
export function loadSide(fallback, storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(SIDE_KEY);
    return v === '1' ? true : v === '0' ? false : !!fallback;
  } catch { return !!fallback; }
}
export function saveSide(on, storage = globalThis.localStorage) {
  try { storage?.setItem(SIDE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
