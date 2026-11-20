import { simulateShot, launchVelocity, GRAVITY } from './ballistics.js';
import { TANK, muzzleOrigin } from './tank.js';

// Iterative aim solver, after the legacy TankAIAimGuesser: fire a trial shot
// through the real simulator, measure the miss, correct, repeat. It works the
// same with wind and hills because it never solves the ballistics in closed form.

export const DIFFICULTY = {
  easy:   { iterations: 4,  yawErr: 3,   elevErr: 2,   powErr: 0.05, tolerance: 6 },
  normal: { iterations: 10, yawErr: 0.8, elevErr: 0.5, powErr: 0.012, tolerance: 3 },
  hard:   { iterations: 25, yawErr: 0.1, elevErr: 0.08, powErr: 0.002, tolerance: 1.5 },
};

const RAD = 180 / Math.PI;
const wrap180 = (a) => ((a + 540) % 360) - 180;

export function solveShot({ shooter, target, wind, terrain, rng, difficulty = 'normal' }) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const sx = shooter.x;
  const sz = shooter.z;
  const tx = target[0];
  const tz = target[2];
  const targetDist = Math.hypot(tx - sx, tz - sz);
  const targetBearing = Math.atan2(tz - sz, tx - sx) * RAD;

  // Initial guess: face the target, a steep-ish arc to clear hills, and the
  // flat-ground power for that range.
  let yaw = targetBearing;
  let elev = rng.range(42, 62);
  let power = Math.sqrt((targetDist * GRAVITY) / Math.sin((2 * elev) / RAD)) * rng.range(0.95, 1.05);
  power = Math.min(TANK.maxPower, Math.max(TANK.minPower, power));

  let best = { yaw, elev, power, miss: Infinity };
  let used = 0;
  for (let it = 0; it < cfg.iterations; it++) {
    used++;
    const shot = simulateShot({
      pos: muzzleOrigin(shooter, yaw, elev),
      vel: launchVelocity(yaw, elev, power),
      wind, terrain,
    });
    const [ix, , iz] = shot.point;
    const miss = Math.hypot(ix - tx, iz - tz);
    if (miss < best.miss) best = { yaw, elev, power, miss };
    if (miss <= cfg.tolerance) break;

    // Correct bearing by the angular error of where the shot went.
    const impactBearing = Math.atan2(iz - sz, ix - sx) * RAD;
    yaw += wrap180(targetBearing - impactBearing);

    // Rescale power by the range ratio (square-root keeps it from overshooting,
    // like the legacy logarithmic rescale).
    const impactDist = Math.max(1, Math.hypot(ix - sx, iz - sz));
    const ratio = targetDist / impactDist;
    power *= Math.pow(ratio, shot.kind === 'lost' ? 0.3 : 0.55);
    if (power > TANK.maxPower) {
      // Out of power: flatten toward 45 degrees for more range.
      power = TANK.maxPower;
      elev += (45 - elev) * 0.5;
    }
    if (power < TANK.minPower) power = TANK.minPower;
  }

  // Difficulty error is applied to the best solution found.
  const out = {
    yaw: ((best.yaw + rng.gauss() * cfg.yawErr) % 360 + 360) % 360,
    elev: Math.min(TANK.maxElevation, Math.max(5, best.elev + rng.gauss() * cfg.elevErr)),
    power: Math.min(TANK.maxPower, Math.max(TANK.minPower, best.power * (1 + rng.gauss() * cfg.powErr))),
    predictedMiss: best.miss,
    iterations: used,
  };
  return out;
}

// Pick a target: nearest enemy for easy/normal, weakest for hard.
export function chooseTarget(me, players, difficulty, rng) {
  const enemies = players.filter((p) => p !== me && p.alive);
  if (!enemies.length) return null;
  if (difficulty === 'hard') {
    return enemies.reduce((a, b) => (b.hp + b.armor < a.hp + a.armor ? b : a));
  }
  if (difficulty === 'easy') return rng.pick(enemies);
  return enemies.reduce((a, b) => (Math.hypot(b.x - me.x, b.z - me.z) < Math.hypot(a.x - me.x, a.z - me.z) ? b : a));
}

export function chooseWeapon(me, target, rng) {
  const has = (id) => me.inventory[id] > 0;
  if (has('roller') && target.y < me.y - 8 && rng.next() < 0.6) return 'roller';
  if (has('breacher') && rng.next() < 0.5) return 'breacher';
  if (has('scatter') && rng.next() < 0.4) return 'scatter';
  return 'shell';
}
