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
  driveSpeed: 6,       // m/s forward
  reverseSpeed: 3.5,   // m/s backward
  hullTurnSpeed: 75,   // deg/s, free
  maxClimb: 1.0,       // steepest rise over run the tracks can take (45 degrees)
  bodyRadius: 4.5,     // tanks keep two of these apart
};

const DEG = Math.PI / 180;

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
