// The one shot simulator. The live game, the AI guesser and the tests all step
// projectiles through `stepProjectile`, so what the AI predicts is exactly what
// the player sees (roadmap M1's "SimulateShot" seam).

export const GRAVITY = 9.81;     // m/s^2
export const SIM_DT = 1 / 120;   // fixed step, independent of frame rate
export const MAX_FLIGHT = 40;    // seconds before a shot is declared lost

// The arena's edges (the match's Edges option, game.js). The edge is the
// square's four vertical sides, from the void up to the sky; the floor and
// the void below are never a wall.
// - 'open': a shell flies off and is lost (unless the wind blows it back in).
// - 'wall': it goes off where it meets the wall.
// - 'bounce': it comes off the wall mirrored, keeping BOUNCE_KEEP of its speed.
// - 'wrap': it leaves one side and comes in at the opposite one, at the same
//   height with the same velocity.
// The rule lives on the Heightfield (`terrain.edge`, set each round by the
// game), so every flight (the live shells, simulateShot for the CPUs and the
// Survey Satellite, the aim arc, the tracer and the kill cam's forecast) sees it.
export const EDGE_KINDS = ['open', 'wall', 'bounce', 'wrap'];
export const BOUNCE_KEEP = 0.8;

// The edge rule a projectile on `terrain` flies under, or null for open edges.
export function edgeOf(terrain) {
  const mode = terrain?.edge;
  return mode && mode !== 'open' && EDGE_KINDS.includes(mode) ? { mode, half: terrain.half } : null;
}

const DEG = Math.PI / 180;

// Port of TankAiming::MuzzleDirection, re-expressed for y-up.
// yaw 0 => +x, yaw 90 => +z; elevation 0 => horizontal, 90 => straight up.
export function muzzleDirection(yawDeg, elevDeg) {
  const yaw = yawDeg * DEG;
  const elev = elevDeg * DEG;
  const c = Math.cos(elev);
  return [c * Math.cos(yaw), Math.sin(elev), c * Math.sin(yaw)];
}

export function launchVelocity(yawDeg, elevDeg, power) {
  const d = muzzleDirection(yawDeg, elevDeg);
  return [d[0] * power, d[1] * power, d[2] * power];
}

// Semi-implicit Euler with gravity and a horizontal wind acceleration. A
// projectile may carry its own gravity `g` and wind share `windK` (round
// modifiers and perks); without them it flies under the defaults. On the
// floating isles it also carries the moons' `wells`, each pulling it toward
// its centre with mu / d^2 (no stronger than at the moon's surface). `extra`
// is a second list of wells that move (an enemy's Gravity Orbiter, core/mods.js),
// set afresh each step for the game clock; a well's `soft` (else `r`) is the
// distance inside which its pull stops growing.
// `drag` (per metre, the Rain modifier) is quadratic air drag, |a| = drag * v^2
// against the velocity, taken from the speed at the start of the step. With no
// drag (0 or missing) the step is exactly the dragless one.
// A projectile with an `edge` (edgeOf) meets the arena's edge here too, and
// `crossed` says what happened this step (crossEdge), else null.
export function stepProjectile(p, wind, dt = SIM_DT) {
  const k = p.windK ?? 1;
  if (p.drag) {
    const f = 1 - p.drag * Math.hypot(p.vel[0], p.vel[1], p.vel[2]) * dt;
    p.vel[0] *= f; p.vel[1] *= f; p.vel[2] *= f;
  }
  p.vel[0] += wind[0] * k * dt;
  p.vel[1] -= (p.g ?? GRAVITY) * dt;
  p.vel[2] += wind[1] * k * dt;
  if (p.wells) pull(p, p.wells, dt);
  if (p.extra) pull(p, p.extra, dt);
  p.prev[0] = p.pos[0]; p.prev[1] = p.pos[1]; p.prev[2] = p.pos[2];
  p.pos[0] += p.vel[0] * dt;
  p.pos[1] += p.vel[1] * dt;
  p.pos[2] += p.vel[2] * dt;
  p.time += dt;
  p.crossed = p.edge ? crossEdge(p, p.edge) : null;
}

// After a step that took `p` past the edge of the square: apply the rule.
// Returns null (still inside), or { kind, point, axis, ... }:
// - 'wall': `point` is where the step met the wall; `pos` is left there, and
//   the caller ends the flight (it goes off on the wall).
// - 'bounce': mirrored back in off the wall at `point`; speed times BOUNCE_KEEP.
// - 'wrap': out at `point`, in at `to` on the opposite side.
// `prev` moves with `pos` (mirrored or shifted), so the step stays one
// unbroken segment for groundContact's bisection.
export function crossEdge(p, { mode, half }) {
  const out = (k) => p.pos[k] > half || p.pos[k] < -half;
  if (!out(0) && !out(2)) return null;
  // Where the step first met a wall (fraction f of the step).
  let f = 1;
  let axis = 0;
  for (const k of [0, 2]) {
    if (!out(k)) continue;
    const wall = p.pos[k] > half ? half : -half;
    const d = p.pos[k] - p.prev[k];
    const fk = Math.abs(d) > 1e-12 ? Math.min(1, Math.max(0, (wall - p.prev[k]) / d)) : 0;
    if (fk <= f) { f = fk; axis = k; }
  }
  const point = [0, 1, 2].map((k) => p.prev[k] + (p.pos[k] - p.prev[k]) * f);
  point[axis] = p.pos[axis] > half ? half : -half;
  point.edge = true;
  if (mode === 'wall') {
    p.pos = [...point];
    return { kind: 'wall', point, axis };
  }
  for (const k of [0, 2]) {
    if (!out(k)) continue;
    const side = p.pos[k] > half ? 1 : -1;
    if (mode === 'bounce') {
      const wall = side * half;
      p.pos[k] = 2 * wall - p.pos[k];
      p.prev[k] = 2 * wall - p.prev[k];
      p.vel[k] = -p.vel[k];
    } else {
      p.pos[k] -= side * 2 * half;
      p.prev[k] -= side * 2 * half;
    }
  }
  if (mode === 'bounce') {
    p.vel[0] *= BOUNCE_KEEP; p.vel[1] *= BOUNCE_KEEP; p.vel[2] *= BOUNCE_KEEP;
    return { kind: 'bounce', point, axis };
  }
  const to = [...point];
  to[axis] = -to[axis];
  return { kind: 'wrap', point, to, axis };
}

function pull(p, wells, dt) {
  for (const w of wells) {
    const dx = w.x - p.pos[0];
    const dy = w.y - p.pos[1];
    const dz = w.z - p.pos[2];
    const s = w.soft ?? w.r;
    const d2 = Math.max(dx * dx + dy * dy + dz * dz, s * s);
    const a = (w.mu / (d2 * Math.sqrt(d2))) * dt;
    p.vel[0] += dx * a;
    p.vel[1] += dy * a;
    p.vel[2] += dz * a;
  }
}

// `terrain` (optional) gives it the arena's edge rule (edgeOf).
export function makeProjectile(pos, vel, terrain = null) {
  return { pos: [...pos], prev: [...pos], vel: [...vel], time: 0, apexPassed: false, edge: edgeOf(terrain), crossed: null };
}

// Did this step cross the ground? Returns the refined impact point or null.
// In the City a standing building counts as ground: the point where the step
// entered it, tagged `.building` with its id (core/city.js). On the Island
// (`terrain.sea`, core/island.js) a shell that comes down through the water
// over sunken ground meets the sea first: the point on the surface, tagged `.sea`.
export function groundContact(p, terrain) {
  if (terrain.city) {
    const hit = terrain.city.contact(p.prev, p.pos);
    if (hit) return hit;
  }
  const [x, y, z] = p.pos;
  if (!terrain.inBounds(x, z)) return null;
  if (terrain.sea != null) {
    const w = terrain.waterLevel;
    if (y < w && p.prev[1] >= w) {
      const f = (p.prev[1] - w) / Math.max(1e-9, p.prev[1] - y);
      const sx = p.prev[0] + (x - p.prev[0]) * f;
      const sz = p.prev[2] + (z - p.prev[2]) * f;
      if (terrain.heightAt(sx, sz) < w) {
        const hit = [sx, w, sz];
        hit.sea = true;
        return hit;
      }
    }
  }
  if (terrain.under) {
    // Floating isles: open sky below and between them, so the shell is in the
    // ground only between an isle's top and its underside.
    if (!terrain.inside(x, y, z)) return null;
    let a = [...p.prev];
    let b = [...p.pos];
    for (let k = 0; k < 10; k++) {
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (terrain.inside(m[0], m[1], m[2])) b = m; else a = m;
    }
    const top = terrain.heightAt(b[0], b[2]);
    const under = terrain.underAt(b[0], b[2]);
    return [b[0], top - b[1] <= b[1] - under ? top : under, b[2]];
  }
  const g = terrain.heightAt(x, z);
  if (y > g) return null;
  // Bisect between prev (above) and pos (below) for a clean impact point.
  let a = [...p.prev];
  let b = [...p.pos];
  for (let k = 0; k < 8; k++) {
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    if (m[1] > terrain.heightAt(m[0], m[2])) a = m; else b = m;
  }
  return [b[0], terrain.heightAt(b[0], b[2]), b[2]];
}

// Did this step hit one of the moons (or of `wells`)? Returns the point on its surface or null.
export function wellContact(p, wells = p.wells) {
  for (const w of wells) {
    const dx = p.pos[0] - w.x;
    const dy = p.pos[1] - w.y;
    const dz = p.pos[2] - w.z;
    const d = Math.hypot(dx, dy, dz);
    if (d <= w.r) {
      const k = w.r / Math.max(d, 1e-6);
      return [w.x + dx * k, w.y + dy * k, w.z + dz * k];
    }
  }
  return null;
}

// Full flight to the ground. `targets` is an optional list of {x,y,z,r}
// spheres (tanks); hitting one ends the flight there.
// With `level`, a lost shot also reports `cross`: where it first came down
// through that height (the AI's measure of a shot that fell past an isle).
// `field(t)` gives the moving wells (enemy orbiters, core/mods.js modWells) at
// game clock `t`; the shot leaves at clock `t0`. Touching one ends it ('orbiter').
// `drag` is the shell's air drag (stepProjectile; the Rain modifier).
// The arena's edge rule comes from `terrain.edge` (edgeOf): a shell that goes
// off on a wall ends 'wall', one that comes down in the Island's sea ends
// 'sea' (no blast). With `recordPath`, `breaks` lists the path indices where a
// wrapped shell came back in on the far side (draw no line across), and
// `edges` counts the times it met the edge.
export function simulateShot({ pos, vel, wind = [0, 0], terrain, targets = [], recordPath = false, maxTime = MAX_FLIGHT, gravity = GRAVITY, windK = 1, drag = 0, level = null, field = null, t0 = 0 }) {
  const p = makeProjectile(pos, vel, terrain);
  p.g = gravity;
  p.windK = windK;
  if (drag) p.drag = drag;
  if (terrain.wells?.length) p.wells = terrain.wells;
  const path = recordPath ? [[...p.pos]] : null;
  const breaks = recordPath ? [] : undefined;
  let edges = 0;         // how many times it met the arena's edge (bounced or wrapped)
  let cross = null;
  const lost = () => ({ kind: 'lost', point: [...p.pos], time: p.time, path, cross, breaks, edges });
  while (p.time < maxTime) {
    if (field) p.extra = field(t0 + p.time);
    stepProjectile(p, wind);
    const edge = p.crossed;
    if (edge) edges++;
    if (edge?.kind === 'wall') {
      if (path) path.push([...edge.point]);
      return { kind: 'wall', point: edge.point, time: p.time, path, breaks, edges };
    }
    if (path && edge) {
      path.push([...edge.point]);
      if (edge.kind === 'wrap') { breaks.push(path.length); path.push([...edge.to]); }
    }
    if (level != null && !cross && p.pos[1] < level && p.prev[1] >= level) cross = [...p.pos];
    if (path && Math.round(p.time / SIM_DT) % 6 === 0) path.push([...p.pos]);
    const [x, y, z] = p.pos;
    const moon = p.wells && wellContact(p);
    if (moon) return { kind: 'moon', point: moon, time: p.time, path, breaks, edges };
    const orb = p.extra?.length && wellContact(p, p.extra);
    if (orb) return { kind: 'orbiter', point: orb, time: p.time, path, breaks, edges };
    if (!terrain.inBounds(x, z)) {
      if (y < terrain.bedrock) return lost();
      continue; // still flying outside the arena; may blow back in
    }
    if (y < terrain.bedrock) return lost();   // down into the void
    for (const t of targets) {
      if ((x - t.x) ** 2 + (y - t.y) ** 2 + (z - t.z) ** 2 <= t.r * t.r) {
        return { kind: 'target', target: t, point: [x, y, z], time: p.time, path, breaks, edges };
      }
    }
    const hit = groundContact(p, terrain);
    if (hit) {
      if (path) path.push(hit);
      return { kind: hit.sea ? 'sea' : 'ground', point: hit, time: p.time, path, breaks, edges };
    }
  }
  return lost();
}

// ---- rolling (the Roller weapon) ----
//
// After landing, a roller keeps part of its horizontal speed and then runs along
// the surface: gravity pulls it down the slope, rolling friction and drag slow
// it. It stops when it can no longer move, has gone ROLL.maxDistance, runs out
// of time or reaches the arena edge. The game steps it live so the roll is seen.

export const ROLL = {
  radius: 0.9,        // ball radius; its centre rides this far above the ground
  keep: 0.25,         // share of the landing speed carried into the roll
  friction: 0.12,     // rolling resistance (holds on slopes under about 7 degrees)
  drag: 0.15,         // 1/s, caps the speed on long slopes
  maxDistance: 160,   // metres of travel before it detonates anyway
  maxTime: 10,        // seconds
  stopSpeed: 0.5,     // m/s
  stopAfter: 0.2,     // seconds below stopSpeed before it counts as stopped
};

export function makeRoller(point, vel, terrain) {
  const x = point[0];
  const z = point[2];
  return {
    pos: [x, terrain.heightAt(x, z) + ROLL.radius, z],
    vel: [(vel ? vel[0] : 0) * ROLL.keep, (vel ? vel[2] : 0) * ROLL.keep], // horizontal x/z
    dist: 0, time: 0, still: 0,
  };
}

// Advance one step. Returns null while rolling, or why it ended:
// 'stopped' | 'distance' | 'timeout' | 'edge'.
export function stepRoller(r, terrain, dt = SIM_DT) {
  const [nx, ny, nz] = terrain.normalAt(r.pos[0], r.pos[2]);
  // Gravity along the slope, horizontal part.
  const ax = GRAVITY * nx * ny;
  const az = GRAVITY * nz * ny;
  const grip = ROLL.friction * GRAVITY * ny;
  let [vx, vz] = r.vel;
  vx += ax * dt;
  vz += az * dt;
  const speed = Math.hypot(vx, vz);
  const slowed = Math.max(0, speed - grip * dt) * (1 - ROLL.drag * dt);
  const k = speed > 1e-9 ? slowed / speed : 0;
  vx *= k;
  vz *= k;
  r.vel[0] = vx;
  r.vel[1] = vz;
  let x = r.pos[0] + vx * dt;
  let z = r.pos[2] + vz * dt;
  r.time += dt;
  // The arena's edge under Bounce or Wrap (edgeOf): it rolls off the wall
  // (keeping BOUNCE_KEEP of its speed) or comes in at the far side. Open and
  // Wall stop it there as before.
  const edge = edgeOf(terrain);
  const h = terrain.half;
  if (edge && edge.mode !== 'wall' && !terrain.inBounds(x, z)) {
    r.crossed = { kind: edge.mode, point: [Math.max(-h, Math.min(h, x)), r.pos[1], Math.max(-h, Math.min(h, z))] };
    if (edge.mode === 'bounce') {
      if (Math.abs(x) > h) { x = Math.sign(x) * 2 * h - x; r.vel[0] = -r.vel[0]; }
      if (Math.abs(z) > h) { z = Math.sign(z) * 2 * h - z; r.vel[1] = -r.vel[1]; }
      r.vel[0] *= BOUNCE_KEEP; r.vel[1] *= BOUNCE_KEEP;
    } else {
      if (Math.abs(x) > h) x -= Math.sign(x) * 2 * h;
      if (Math.abs(z) > h) z -= Math.sign(z) * 2 * h;
      r.crossed.to = [x, terrain.heightAt(x, z) + ROLL.radius, z];
    }
  } else r.crossed = null;
  if (!terrain.solidAt(x, z)) {   // the arena's edge, or an isle's
    if (terrain.under) return 'edge';
    r.pos[0] = Math.max(-terrain.half, Math.min(terrain.half, x));
    r.pos[2] = Math.max(-terrain.half, Math.min(terrain.half, z));
    r.pos[1] = terrain.heightAt(r.pos[0], r.pos[2]) + ROLL.radius;
    return 'edge';
  }
  r.dist += slowed * dt;
  r.pos[0] = x;
  r.pos[2] = z;
  r.pos[1] = terrain.heightAt(x, z) + ROLL.radius;
  // Slow, and on ground too gentle to set it moving again.
  if (slowed < ROLL.stopSpeed && Math.hypot(ax, az) <= grip) {
    r.still += dt;
    if (r.still >= ROLL.stopAfter) return 'stopped';
  } else r.still = 0;
  if (r.dist >= ROLL.maxDistance) return 'distance';
  if (r.time >= ROLL.maxTime) return 'timeout';
  return null;
}

// Run a whole roll at once (tests, predictions). Returns the resting ground
// point, the distance travelled and why it ended.
export function rollDownhill(terrain, start, vel = null) {
  const r = makeRoller(start, vel, terrain);
  let end = null;
  while (!end) end = stepRoller(r, terrain);
  return { point: [r.pos[0], r.pos[1] - ROLL.radius, r.pos[2]], dist: r.dist, time: r.time, end };
}
