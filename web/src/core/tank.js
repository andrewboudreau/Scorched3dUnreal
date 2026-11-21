import { muzzleDirection } from './ballistics.js';

// Tank geometry shared by the game, the AI and the renderer, so the shell
// leaves the barrel exactly where the model draws it.
export const TANK = {
  turretHeight: 2.6,   // pivot height above the ground point
  barrelLength: 5.0,
  hitRadius: 4.2,      // sphere a shell must enter to score a direct hit
  hitCenterY: 1.8,
  padRadius: 9,        // flattened at spawn
  minElevation: 0,
  maxElevation: 88,
  minPower: 10,
  maxPower: 120,       // m/s
  turretSpeed: 60,     // deg/s
  elevationSpeed: 40,  // deg/s
  powerSpeed: 30,      // m/s per s
  maxHp: 100,
  // Driving: a small fuel budget per round. Level ground costs a metre of fuel
  // per metre; climbing costs more, so getting out of a crater is expensive.
  fuel: 30,            // metres on the level
  climbCost: 2,        // extra fuel per metre, times the slope
  fuelCan: 20,         // metres added by one armory fuel can
  refuelShare: 1 / 3,  // of the round's fuel, put back after every shot
  driveSpeed: 6,       // m/s forward
  reverseSpeed: 3.5,   // m/s backward
  hullTurnSpeed: 75,   // deg/s, free
  maxClimb: 1.0,       // steepest rise over run the tracks can take (45 degrees)
  bodyRadius: 4.5,     // tanks keep two of these apart
};

// Jump jets: a hop along the hull. The core lands the tank at once (like a
// drive step, so every copy of a game agrees); the screen animates the arc.
export const JET = {
  distance: 25,        // m along the hull
  apex: 10,            // m above the straight line from take-off to landing
  tries: [1, 0.8, 0.64, 0.48, 0.32],   // shorter hops to fall back on, as a share of `distance`
  flight: 1.6,         // s, for the screen's arc and a CPU waiting for it
  clearance: 0.3,      // m the arc must keep above the ground
  maxRise: 22,         // m higher than take-off a hop may land (a Breacher crater is 15 m deep), but never a cliff
};

const DEG = Math.PI / 180;

// Can a tank stand at x/z? Inside the arena, out of the water, and clear of
// every other tank and standing house (`others`, like driveStep's).
function standable(tank, terrain, others, x, z) {
  const edge = terrain.half - 6;
  if (Math.abs(x) > edge || Math.abs(z) > edge) return 'edge';
  if (terrain.heightAt(x, z) < terrain.waterLevel + 0.3) return 'water';
  for (const o of others) {
    if (o === tank || o.alive === false) continue;
    if (Math.hypot(o.x - x, o.z - z) < TANK.bodyRadius * 2) return 'blocked';
  }
  return null;
}

// Where would a jet hop along `heading` (degrees) land? { ok: true, x, y, z,
// dist } or { ok: false, why } with why 'edge' | 'water' | 'blocked'. It tries
// the full hop, then shorter ones, so a hop is only refused when none will do;
// `why` is what stopped the full one. The arc is a parabola over the straight
// line from take-off to landing and must clear the ground on the way.
export function planHop(tank, terrain, others = [], heading = tank.hull) {
  const ux = Math.cos(heading * DEG);
  const uz = Math.sin(heading * DEG);
  const y0 = terrain.heightAt(tank.x, tank.z);
  let why = null;
  for (const share of JET.tries) {
    const dist = JET.distance * share;
    const x = tank.x + ux * dist;
    const z = tank.z + uz * dist;
    const y1 = terrain.heightAt(x, z);
    let fail = standable(tank, terrain, others, x, z);
    if (!fail && y1 - y0 > JET.maxRise) fail = 'blocked';
    if (!fail) {
      for (let k = 1; k < 16 && !fail; k++) {
        const s = k / 16;
        const arc = y0 + (y1 - y0) * s + 4 * JET.apex * s * (1 - s);
        if (arc < terrain.heightAt(tank.x + ux * dist * s, tank.z + uz * dist * s) + JET.clearance) fail = 'blocked';
      }
    }
    if (!fail) return { ok: true, x, y: y1, z, dist };
    why = why || fail;
  }
  return { ok: false, why };
}

// The nearest spot to x/z where a tank can stand (a Teleport's landing): the
// point itself, else rings of candidates 3 m further out each time. Null if
// the whole arena is somehow full.
export function findSpot(tank, terrain, others, x, z) {
  const edge = terrain.half - 6;
  x = Math.min(edge, Math.max(-edge, x));
  z = Math.min(edge, Math.max(-edge, z));
  if (!standable(tank, terrain, others, x, z)) return { x, y: terrain.heightAt(x, z), z };
  for (let r = 3; r <= 90; r += 3) {
    const n = Math.max(8, Math.round((r * Math.PI * 2) / 4));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const cx = x + Math.cos(a) * r;
      const cz = z + Math.sin(a) * r;
      if (!standable(tank, terrain, others, cx, cz)) return { x: cx, y: terrain.heightAt(cx, cz), z: cz };
    }
  }
  return null;
}

// Move a tank one step along its hull (`dir` +1 forward, -1 back). Returns
// 'ok', or why it did not move: 'empty' | 'edge' | 'water' | 'steep' | 'blocked'.
export function driveStep(tank, terrain, dir, dt, others = []) {
  if (!dir) return 'idle';
  if (!(tank.fuel > 0)) return 'empty';
  // Judge the slope over the next two metres so a small bump does not stop it.
  const ux0 = Math.cos(tank.hull * DEG) * Math.sign(dir);
  const uz0 = Math.sin(tank.hull * DEG) * Math.sign(dir);
  const here = terrain.heightAt(tank.x, tank.z);
  const slope = (terrain.heightAt(tank.x + ux0 * 2, tank.z + uz0 * 2) - here) / 2;
  if (slope > TANK.maxClimb) return 'steep';
  const cost = 1 + TANK.climbCost * Math.max(0, slope);
  const step = Math.min((dir > 0 ? TANK.driveSpeed : TANK.reverseSpeed) * dt, tank.fuel / cost);
  const ux = Math.cos(tank.hull * DEG) * Math.sign(dir);
  const uz = Math.sin(tank.hull * DEG) * Math.sign(dir);
  const x = tank.x + ux * step;
  const z = tank.z + uz * step;
  const edge = terrain.half - 6;
  if (Math.abs(x) > edge || Math.abs(z) > edge) return 'edge';
  const h = terrain.heightAt(x, z);
  // No wading in, but a tank already standing in a flooded crater may climb out.
  if (h < terrain.waterLevel + 0.3 && h <= here) return 'water';
  for (const o of others) {
    if (o === tank || o.alive === false) continue;
    const now = Math.hypot(o.x - tank.x, o.z - tank.z);
    const then = Math.hypot(o.x - x, o.z - z);
    if (then < TANK.bodyRadius * 2 && then < now) return 'blocked';
  }
  tank.x = x;
  tank.z = z;
  tank.y = h;
  tank.fuel = Math.max(0, tank.fuel - step * cost);
  if (tank.fuel < 1e-6) tank.fuel = 0;
  return 'ok';
}

export function muzzleOrigin(tank, yawDeg = tank.yaw, elevDeg = tank.elev) {
  const d = muzzleDirection(yawDeg, elevDeg);
  return [
    tank.x + d[0] * TANK.barrelLength,
    tank.y + TANK.turretHeight + d[1] * TANK.barrelLength,
    tank.z + d[2] * TANK.barrelLength,
  ];
}

export function hitSphere(tank) {
  return { x: tank.x, y: tank.y + TANK.hitCenterY, z: tank.z, r: TANK.hitRadius, tank };
}

export function clampAim(t) {
  t.elev = Math.min(TANK.maxElevation, Math.max(TANK.minElevation, t.elev));
  t.power = Math.min(TANK.maxPower, Math.max(TANK.minPower, t.power));
  t.yaw = ((t.yaw % 360) + 360) % 360;
}
