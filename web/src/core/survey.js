// The Survey Satellite: an upgrade that throws a patch of Voronoi cells onto
// the ground and labels some of their sites with the aim that lands there
// from where you stand now (turret and power, at your current elevation). It
// is a map of "what aim lands where", solved through the same simulator the
// shells fly on, never a new physics model.
//
// Levels (bought one at a time in the armory, or handed to everyone by the
// host's Lab options):
//   1  the solutions ignore wind and any moon's pull
//   2  they include this turn's wind (times the owner's wind share) and the moons
//   3  as 2, with more of the sites labelled
//
// The sites sit on a jittered lattice anchored to the world (seeded per round),
// so when the patch drifts, cells slide in and out of it but a site never
// moves, and its solution can be kept until the shooter, its elevation or the
// conditions change.

import { simulateShot, launchVelocity, GRAVITY } from './ballistics.js';
import { TANK, muzzleOrigin } from './tank.js';

export const SURVEY = {
  maxLevel: 3,
  prices: [200, 260, 300],   // for level 1, 2, 3 (each bought on top of the one before)
  spacing: 26,               // m between lattice sites: one Voronoi cell each
  radius: 80,                // m, the projected patch
  sweep: 26,                 // m the patch drifts round its focus
  period: 16,                // s for one loop of the drift
  labels: { few: 0.2, some: 0.32, many: 0.5 },   // share of sites labelled
  level3Bonus: 0.15,         // extra share labelled at level 3
  tolerance: 1.2,            // m: a solution must land this close to count
  iterations: 16,
  reachMiss: 4,              // m: worse than this and the site is out of reach
};

// The host's Lab options, filled in: who has a satellite ('shop': bought in
// the armory; 'all': everyone, at `level`; 'off': nobody), and how many sites
// carry labels.
export function normalizeLab(lab) {
  const l = lab || {};
  const satellite = ['shop', 'all', 'off'].includes(l.satellite) ? l.satellite : 'shop';
  const level = Math.max(1, Math.min(SURVEY.maxLevel, Math.round(Number(l.level) || 1)));
  const labels = SURVEY.labels[l.labels] != null ? l.labels : 'some';
  return { satellite, level, labels };
}

// Armory levels bought: the satellite is a mod now (core/mods.js, `p.mods.satellite`).
const bought = (p) => p?.mods?.satellite?.bought ?? p?.satellite ?? 0;

// The level of satellite `p` owns (0: none), before perks; the game adds
// those (mods.js modLevel) and deploys it (game.surveyLevel).
export function satelliteLevel(lab, p) {
  const l = normalizeLab(lab);
  if (l.satellite === 'off') return 0;
  if (l.satellite === 'all') return l.level;
  return Math.min(SURVEY.maxLevel, bought(p));
}

// What the next level costs `p` before any discount, or Infinity when it is
// not for sale (not in the armory, or already at the top level).
export function satellitePrice(lab, p) {
  if (normalizeLab(lab).satellite !== 'shop') return Infinity;
  const have = bought(p);
  return have >= SURVEY.maxLevel ? Infinity : SURVEY.prices[have];
}

// Share of the sites that carry a label at this level.
export function labelShare(lab, level) {
  const l = normalizeLab(lab);
  return Math.min(0.9, SURVEY.labels[l.labels] + (level >= 3 ? SURVEY.level3Bonus : 0));
}

// What a solution at this level takes into account.
// From level 2 that includes the enemies' Gravity Orbiters: `field(t)` and the
// game clock `t0` (see ballistics.simulateShot). Recon beats defense: the
// clock stands still while everyone plans, so those labels are exact.
export function surveyConditions(level, { wind = [0, 0], windK = 1, gravity = GRAVITY, wells = [], field = null, t0 = 0 } = {}) {
  const live = level >= 2;
  return { wind: live ? [wind[0], wind[1]] : [0, 0], windK: live ? windK : 0, gravity, wells: live ? wells : [], live, field: live ? field : null, t0 };
}

// ---------- the lattice ----------

function hash(...xs) {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

// The lattice site of cell (i, j): jittered inside the middle of its cell so
// every Voronoi cell keeps a reasonable shape. `roll` decides labelling.
export function siteAt(i, j, seed, spacing = SURVEY.spacing) {
  const jx = 0.18 + 0.64 * hash(seed, i, j, 1);
  const jz = 0.18 + 0.64 * hash(seed, i, j, 2);
  return { key: `${i},${j}`, i, j, x: (i + jx) * spacing, z: (j + jz) * spacing, roll: hash(seed, i, j, 3) };
}

// Every site within `radius + margin` of (cx, cz). The margin keeps the
// cells at the rim of the patch their true shape.
export function surveySites({ cx, cz, radius = SURVEY.radius, spacing = SURVEY.spacing, seed = 0, margin = spacing * 1.5 }) {
  const reach = radius + margin;
  const out = [];
  const i0 = Math.floor((cx - reach) / spacing), i1 = Math.floor((cx + reach) / spacing);
  const j0 = Math.floor((cz - reach) / spacing), j1 = Math.floor((cz + reach) / spacing);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const s = siteAt(i, j, seed, spacing);
      const d = Math.hypot(s.x - cx, s.z - cz);
      if (d <= reach) { s.d = d; out.push(s); }
    }
  }
  return out;
}

// The labelled sites inside the patch, nearest its middle first, at most `max`.
export function labelledSites(sites, share, radius = SURVEY.radius, max = Infinity) {
  return sites.filter((s) => s.roll < share && s.d <= radius).sort((a, b) => a.d - b.d).slice(0, max);
}

// ---------- where the patch goes ----------

const DEG = Math.PI / 180;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const bearingTo = (from, x, z) => Math.atan2(z - from.z, x - from.x) / DEG;

// What the satellite looks at: the known enemy nearest your turret line, or,
// with none known, the stretch of ground your aim reaches on the level.
export function surveyFocus(shooter, foes, gravity = GRAVITY) {
  let best = null;
  for (const f of foes || []) {
    const off = Math.abs(wrap180(bearingTo(shooter, f.x, f.z) - shooter.yaw));
    if (!best || off < best.off) best = { off, x: f.x, z: f.z };
  }
  if (best) return { x: best.x, z: best.z, foe: true };
  const e = (shooter.elev ?? 45) * DEG;
  const d = Math.min(350, Math.max(60, (shooter.power ** 2 * Math.abs(Math.sin(2 * e))) / gravity));
  return { x: shooter.x + Math.cos(shooter.yaw * DEG) * d, z: shooter.z + Math.sin(shooter.yaw * DEG) * d, foe: false };
}

// The middle of the patch at time `t` (s): a slow figure-of-eight round the focus.
export function patchCentre(focus, t, sweep = SURVEY.sweep, period = SURVEY.period) {
  const a = (t / period) * Math.PI * 2;
  return { x: focus.x + Math.cos(a) * sweep, z: focus.z + Math.sin(2 * a) * sweep * 0.6 };
}

// ---------- solving ----------

// The turret and power that put a shell from `shooter` at `elev` on `target`
// ([x, y, z]), under `cond` (from surveyConditions). Iterates the real
// simulator like the CPU's solver, but keeps the elevation where the player
// has it. `guess` ({ yaw, power }) starts it near a known answer.
// Returns { yaw, power, miss, reach } (reach: it lands within SURVEY.reachMiss).
export function solveSite({ shooter, elev, target, cond, terrain, guess = null, iterations = SURVEY.iterations, tolerance = SURVEY.tolerance }) {
  const world = cond.wells === terrain.wells ? terrain : Object.create(terrain, { wells: { value: cond.wells } });
  const [tx, ty, tz] = target;
  const dist = Math.hypot(tx - shooter.x, tz - shooter.z);
  const aimBearing = bearingTo(shooter, tx, tz);
  let yaw = guess ? guess.yaw : aimBearing;
  let power = guess ? guess.power : Math.sqrt((Math.max(dist, 5) * cond.gravity) / Math.max(0.05, Math.abs(Math.sin(2 * elev * DEG))));
  power = Math.min(TANK.maxPower, Math.max(TANK.minPower, power));
  let best = { yaw, power, miss: Infinity };
  for (let it = 0; it < iterations; it++) {
    const shot = simulateShot({
      pos: muzzleOrigin(shooter, yaw, elev), vel: launchVelocity(yaw, elev, power),
      wind: cond.wind, terrain: world, gravity: cond.gravity, windK: cond.windK, level: ty - 1,
      field: cond.field || null, t0: cond.t0 || 0,
    });
    const [ix, , iz] = shot.kind === 'lost' && shot.cross ? shot.cross : shot.point;
    const miss = Math.hypot(ix - tx, iz - tz);
    if (miss < best.miss) best = { yaw, power, miss };
    if (miss <= tolerance) break;
    yaw += wrap180(aimBearing - bearingTo(shooter, ix, iz));
    const ratio = dist / Math.max(1, Math.hypot(ix - shooter.x, iz - shooter.z));
    const next = power * Math.pow(ratio, shot.kind === 'lost' ? 0.3 : 0.55);
    if ((next > TANK.maxPower && power >= TANK.maxPower) || (next < TANK.minPower && power <= TANK.minPower)) break;   // out of reach at this elevation
    power = Math.min(TANK.maxPower, Math.max(TANK.minPower, next));
  }
  return { yaw: ((best.yaw % 360) + 360) % 360, power: best.power, miss: best.miss, reach: best.miss <= SURVEY.reachMiss };
}

// Solutions kept per site for one set of conditions (`key`: shooter, elevation,
// wind, ground...). When the key changes the old answers are kept as stale
// stand-ins (and warm starts) until each site is solved again.
export class SurveyCache {
  constructor() {
    this.key = '';
    this.fresh = new Map();
    this.stale = new Map();
  }

  setKey(key) {
    if (key === this.key) return false;
    this.key = key;
    if (this.stale.size > 400) this.stale.clear();
    for (const [k, v] of this.fresh) this.stale.set(k, v);
    this.fresh = new Map();
    return true;
  }

  // The answer for a site: { ...solution, stale } or null.
  get(site) {
    const f = this.fresh.get(site.key);
    if (f) return f;
    const s = this.stale.get(site.key);
    return s ? { ...s, stale: true } : null;
  }

  // Solve up to `budget` of `sites` that have no fresh answer yet.
  // `solve(site, guess)` returns the solution. Returns how many it solved.
  step(sites, budget, solve) {
    let n = 0;
    for (const s of sites) {
      if (n >= budget) break;
      if (this.fresh.has(s.key)) continue;
      const old = this.stale.get(s.key) || this.nearestFresh(s);
      this.fresh.set(s.key, { ...solve(s, old ? { yaw: old.yaw, power: old.power } : null), stale: false });
      n++;
    }
    return n;
  }

  nearestFresh(site) {
    let best = null, bd = Infinity;
    for (const [k, v] of this.fresh) {
      const [i, j] = k.split(',').map(Number);
      const d = Math.abs(i - site.i) + Math.abs(j - site.j);
      if (d < bd && v.reach) { bd = d; best = v; }
    }
    return bd <= 2 ? best : null;
  }
}
