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

// Semi-implicit Euler with gravity and a horizontal wind acceleration.
export function stepProjectile(p, wind, dt = SIM_DT) {
  p.vel[0] += wind[0] * dt;
  p.vel[1] -= GRAVITY * dt;
  p.vel[2] += wind[1] * dt;
  p.prev[0] = p.pos[0]; p.prev[1] = p.pos[1]; p.prev[2] = p.pos[2];
  p.pos[0] += p.vel[0] * dt;
  p.pos[1] += p.vel[1] * dt;
  p.pos[2] += p.vel[2] * dt;
  p.time += dt;
}

export function makeProjectile(pos, vel) {
  return { pos: [...pos], prev: [...pos], vel: [...vel], time: 0, apexPassed: false };
}

// Did this step cross the ground? Returns the refined impact point or null.
export function groundContact(p, terrain) {
  const [x, y, z] = p.pos;
  if (!terrain.inBounds(x, z)) return null;
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

// Full flight to the ground. `targets` is an optional list of {x,y,z,r}
// spheres (tanks); hitting one ends the flight there.
export function simulateShot({ pos, vel, wind = [0, 0], terrain, targets = [], recordPath = false, maxTime = MAX_FLIGHT }) {
  const p = makeProjectile(pos, vel);
  const path = recordPath ? [[...p.pos]] : null;
  while (p.time < maxTime) {
    stepProjectile(p, wind);
    if (path && Math.round(p.time / SIM_DT) % 6 === 0) path.push([...p.pos]);
    const [x, y, z] = p.pos;
    if (!terrain.inBounds(x, z)) {
      if (y < terrain.bedrock) return { kind: 'lost', point: [...p.pos], time: p.time, path };
      continue; // still flying outside the arena; may blow back in
    }
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
  return { kind: 'lost', point: [...p.pos], time: p.time, path };
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
  if (!terrain.inBounds(x, z)) {
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
