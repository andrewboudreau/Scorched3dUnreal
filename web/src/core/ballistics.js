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

// Roll a ball downhill from a point until it settles or times out.
// Used by the Roller weapon. Returns the resting point.
export function rollDownhill(terrain, start, { maxTime = 6, friction = 0.6, dt = 1 / 60 } = {}) {
  let x = start[0];
  let z = start[2];
  let vx = 0;
  let vz = 0;
  let still = 0;
  for (let t = 0; t < maxTime; t += dt) {
    const [nx, ny, nz] = terrain.normalAt(x, z);
    // Gravity component along the slope.
    vx += nx * GRAVITY * dt * 2.5;
    vz += nz * GRAVITY * dt * 2.5;
    vx *= 1 - friction * dt;
    vz *= 1 - friction * dt;
    x += vx * dt;
    z += vz * dt;
    if (!terrain.inBounds(x, z)) {
      x = Math.max(-terrain.half, Math.min(terrain.half, x));
      z = Math.max(-terrain.half, Math.min(terrain.half, z));
      break;
    }
    if (Math.hypot(vx, vz) < 0.4 && 1 - ny < 0.02) {
      if (++still > 20) break;
    } else still = 0;
  }
  return [x, terrain.heightAt(x, z), z];
}
