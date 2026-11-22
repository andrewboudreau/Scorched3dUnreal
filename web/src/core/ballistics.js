// The one shot simulator. The live game, the AI guesser and the tests all step
// projectiles through `stepProjectile`, so what the AI predicts is exactly what
// the player sees (roadmap M1's "SimulateShot" seam).

export const GRAVITY = 9.81;     // m/s^2
export const SIM_DT = 1 / 120;   // fixed step, independent of frame rate
export const MAX_FLIGHT = 40;    // seconds before a shot is declared lost

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
export function stepProjectile(p, wind, dt = SIM_DT) {
  const k = p.windK ?? 1;
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

export function makeProjectile(pos, vel) {
  return { pos: [...pos], prev: [...pos], vel: [...vel], time: 0, apexPassed: false };
}

// Did this step cross the ground? Returns the refined impact point or null.
export function groundContact(p, terrain) {
  const [x, y, z] = p.pos;
  if (!terrain.inBounds(x, z)) return null;
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
export function simulateShot({ pos, vel, wind = [0, 0], terrain, targets = [], recordPath = false, maxTime = MAX_FLIGHT, gravity = GRAVITY, windK = 1, level = null, field = null, t0 = 0 }) {
  const p = makeProjectile(pos, vel);
  p.g = gravity;
  p.windK = windK;
  if (terrain.wells?.length) p.wells = terrain.wells;
  const path = recordPath ? [[...p.pos]] : null;
  let cross = null;
  const lost = () => ({ kind: 'lost', point: [...p.pos], time: p.time, path, cross });
  while (p.time < maxTime) {
    if (field) p.extra = field(t0 + p.time);
    stepProjectile(p, wind);
    if (level != null && !cross && p.pos[1] < level && p.prev[1] >= level) cross = [...p.pos];
    if (path && Math.round(p.time / SIM_DT) % 6 === 0) path.push([...p.pos]);
    const [x, y, z] = p.pos;
    const moon = p.wells && wellContact(p);
    if (moon) return { kind: 'moon', point: moon, time: p.time, path };
    const orb = p.extra?.length && wellContact(p, p.extra);
    if (orb) return { kind: 'orbiter', point: orb, time: p.time, path };
    if (!terrain.inBounds(x, z)) {
      if (y < terrain.bedrock) return lost();
      continue; // still flying outside the arena; may blow back in
    }
    if (y < terrain.bedrock) return lost();   // down into the void
    for (const t of targets) {
      if ((x - t.x) ** 2 + (y - t.y) ** 2 + (z - t.z) ** 2 <= t.r * t.r) {
        return { kind: 'target', target: t, point: [x, y, z], time: p.time, path };
      }
    }
    const hit = groundContact(p, terrain);
    if (hit) {
      if (path) path.push(hit);
      return { kind: 'ground', point: hit, time: p.time, path };
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
  const x = r.pos[0] + vx * dt;
  const z = r.pos[2] + vz * dt;
  r.time += dt;
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
