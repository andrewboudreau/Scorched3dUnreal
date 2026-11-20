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
};

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
