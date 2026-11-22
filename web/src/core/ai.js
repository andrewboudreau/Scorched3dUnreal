import { simulateShot, launchVelocity, GRAVITY } from './ballistics.js';
import { TANK, muzzleOrigin } from './tank.js';

// Iterative aim solver, after the legacy TankAIAimGuesser: fire a trial shot
// through the real simulator, measure the miss, correct, repeat. It works the
// same with wind and hills because it never solves the ballistics in closed form.
//
// The solver finds the true firing solution. A CPU never fires it directly:
// `planShot` adds an aiming error that starts large and shrinks with each shot
// at the same target, so a CPU walks its shots in the way a person does.

export const DIFFICULTY = {
  // yaw (degrees) and power (fraction): spread of the first shot at a target
  // learn: share of the error left after each shot (lower learns faster)
  // jitterYaw / jitterPower: unsteadiness that never goes away
  // orbit: how badly it reads an enemy Gravity Orbiter, by orbiter level 1-3
  //   (see misjudgeField): `clock` seconds out on where the wells will be,
  //   `pull` share out on how hard they pull, and `yaw` degrees / `power`
  //   share of extra scatter on the shot. Easy CPUs ignore orbiters altogether
  //   (game.orbitField).
  easy:   { yaw: 6.0, power: 0.085, learn: 0.62, jitterYaw: 0.9,  jitterPower: 0.015, orbit: null },
  normal: { yaw: 3.2, power: 0.055, learn: 0.45, jitterYaw: 0.3,  jitterPower: 0.005,
    orbit: { clock: [0.35, 0.5, 0.7], pull: [0.2, 0.3, 0.4], yaw: [0.25, 0.35, 0.42], power: [0.005, 0.007, 0.008] } },
  hard:   { yaw: 1.4, power: 0.022, learn: 0.30, jitterYaw: 0.08, jitterPower: 0.0015,
    orbit: { clock: [0.25, 0.35, 0.5], pull: [0.15, 0.2, 0.3], yaw: [0.12, 0.18, 0.28], power: [0.0022, 0.0033, 0.005] } },
};

// A CPU never reads an enemy orbiter exactly. The wells it flies its trial
// shots through (`field` at clock `t0`, as for simulateShot) are where it
// thinks they will be and as strong as it thinks, and the shot it picks
// scatters more (`scatter`, for planShot), all of it growing with `level`
// (the strongest enemy orbiter up). It is drawn fresh for every shot: the
// wells keep moving between shots, so unlike its ordinary aiming error this
// one is never learned away.
export function misjudgeField({ field, t0 = 0, level = 0, difficulty = 'normal', rng }) {
  const o = (DIFFICULTY[difficulty] || DIFFICULTY.normal).orbit;
  if (!field || !o || !(level > 0)) return { field, t0 };
  const k = Math.min(3, level) - 1;
  const late = rng.gauss() * o.clock[k];
  const pull = Math.max(0.2, 1 + rng.gauss() * o.pull[k]);
  return {
    field: (t) => field(t).map((w) => ({ ...w, mu: w.mu * pull })),
    t0: t0 + late,
    scatter: { yaw: rng.gauss() * o.yaw[k], power: rng.gauss() * o.power[k] },
  };
}

const RAD = 180 / Math.PI;
const wrap180 = (a) => ((a + 540) % 360) - 180;

export function solveShot({ shooter, target, wind, terrain, rng, iterations = 25, tolerance = 1.5, gravity = GRAVITY, windK = 1, field = null, t0 = 0 }) {
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
  let power = Math.sqrt((targetDist * gravity) / Math.sin((2 * elev) / RAD)) * rng.range(0.95, 1.05);
  power = Math.min(TANK.maxPower, Math.max(TANK.minPower, power));

  let best = { yaw, elev, power, miss: Infinity };
  let used = 0;
  for (let it = 0; it < iterations; it++) {
    used++;
    const shot = simulateShot({
      pos: muzzleOrigin(shooter, yaw, elev),
      vel: launchVelocity(yaw, elev, power),
      wind, terrain, gravity, windK, level: target[1] - 1, field, t0,
    });
    // A shell that fell past an isle is judged by where it came down through the target's height.
    const [ix, , iz] = shot.kind === 'lost' && shot.cross ? shot.cross : shot.point;
    const miss = Math.hypot(ix - tx, iz - tz);
    if (miss < best.miss) best = { yaw, elev, power, miss };
    if (miss <= tolerance) break;

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

  return {
    yaw: ((best.yaw % 360) + 360) % 360,
    elev: Math.min(TANK.maxElevation, Math.max(5, best.elev)),
    power: best.power,
    predictedMiss: best.miss,
    iterations: used,
  };
}

// A CPU's shot at `target` (a player). `field` / `t0` are the enemy orbiters'
// wells as a function of the game clock and the clock at launch (see
// simulateShot): the solver flies its trial shots through them. `memory` belongs to the shooter and maps
// target id -> the aiming error it still carries against that target. The
// first shot gets a full-sized error; every later shot keeps only part of it.
// A target or shooter that has moved, or a change in the wind, puts some back.
export function planShot({ shooter, target, wind, terrain, rng, difficulty = 'normal', memory, gravity = GRAVITY, windK = 1, field = null, t0 = 0, scatter = null }) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const sol = solveShot({ shooter, target: [target.x, target.y + 1, target.z], wind, terrain, rng, gravity, windK, field, t0 });
  const fresh = (k) => ({ yaw: rng.gauss() * cfg.yaw * k, power: rng.gauss() * cfg.power * k });
  let m = memory[target.id];
  if (!m) {
    m = memory[target.id] = { ...fresh(1), shots: 0 };
  } else {
    const moved = Math.hypot(target.x - m.target[0], target.y - m.target[1], target.z - m.target[2])
      + Math.hypot(shooter.x - m.shooter[0], shooter.y - m.shooter[1], shooter.z - m.shooter[2]);
    const windShift = Math.hypot(wind[0] - m.wind[0], wind[1] - m.wind[1]);
    const upset = Math.min(1, moved / 40 + windShift / 4);
    if (upset > 0.02) {
      const f = fresh(upset);
      m.yaw += f.yaw;
      m.power += f.power;
    }
  }
  m.target = [target.x, target.y, target.z];
  m.shooter = [shooter.x, shooter.y, shooter.z];
  m.wind = [wind[0], wind[1]];

  const yaw = sol.yaw + m.yaw + rng.gauss() * cfg.jitterYaw + (scatter?.yaw || 0);
  const power = sol.power * (1 + m.power + rng.gauss() * cfg.jitterPower + (scatter?.power || 0));
  const out = {
    yaw: ((yaw % 360) + 360) % 360,
    elev: sol.elev,
    power: Math.min(TANK.maxPower, Math.max(TANK.minPower, power)),
    predictedMiss: sol.predictedMiss,
    shotNumber: m.shots + 1,
  };

  // Learn from this shot. Now and then the correction overshoots.
  const keep = () => cfg.learn * rng.range(0.6, 1.3) * (rng.next() < 0.2 ? -0.6 : 1);
  m.yaw *= keep();
  m.power *= keep();
  m.shots++;
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

// How far below the ground 14 m around it a tank at x/z (standing at height y) sits.
export function holeDepth(terrain, x, z, y) {
  let rim = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    rim += terrain.heightAt(x + Math.cos(a) * 14, z + Math.sin(a) * 14);
  }
  return rim / 8 - y;
}

// Should a CPU spend fuel this turn, and where to? It moves to climb out of a
// hole or to get off a spot it keeps being hit on, and otherwise stays put.
// Returns { heading (degrees), budget (fuel to spend) } or null.
// `tryDrive(heading, budget)` must report where that drive would really end:
// { x, y, z, moved }.
export function planDrive({ me, terrain, rng, difficulty = 'normal', tryDrive }) {
  if (difficulty === 'easy' || !(me.fuel > 4)) return null;
  const sunk = holeDepth(terrain, me.x, me.z, me.y);
  const shaken = (me.hitsHere || 0) >= 2;
  if (!(sunk > 3 || (shaken && rng.next() < 0.6))) return null;
  const budget = sunk > 3 ? me.fuel : Math.min(me.fuel, 16);
  let best = null;
  for (let k = 0; k < 8; k++) {
    const heading = (k / 8) * 360 + rng.range(-15, 15);
    const end = tryDrive(heading, budget);
    if (end.moved < 5) continue;
    const score = (end.y - me.y) * (sunk > 3 ? 2 : 0.5) + end.moved * 0.4 + rng.range(0, 2);
    if (!best || score > best.score) best = { heading: ((heading % 360) + 360) % 360, budget, score };
  }
  return best;
}

// Should a CPU spend a jump jet charge? Only to get out of a hole (the ground
// around it more than 4 m higher), and only toward a landing that is clearly
// less of one. It is asked after planDrive, so it is what a tank does when
// driving will not get it out (no fuel, or walls too steep). `tryHop(heading)`
// reports the hop as game.previewHop does. Returns { heading, budget: 0, jump: true } or null.
export function planJump({ me, terrain, difficulty = 'normal', tryHop }) {
  if (difficulty === 'easy' || !(me.jets > 0)) return null;
  const sunk = holeDepth(terrain, me.x, me.z, me.y);
  if (sunk < 4) return null;
  let best = null;
  for (let k = 0; k < 8; k++) {
    const heading = k * 45;
    const hop = tryHop(heading);
    if (!hop.ok) continue;
    const gain = sunk - holeDepth(terrain, hop.x, hop.z, hop.y);
    if (gain >= 3 && (!best || gain > best.gain)) best = { heading, budget: 0, jump: true, gain };
  }
  return best;
}

// Double Strike: should a CPU that holds it fire two shots this turn (and so
// only move on its next)? When it has the range on its target (a few shots at
// it already, so the second is not wasted), or when two hits would finish the
// target off. Easy uses it now and then, at random. Called after the first
// shot is planned, so `memory[target.id].shots` already counts that one.
export function wantsDouble({ target, memory, difficulty = 'normal', rng }) {
  if (difficulty === 'easy') return rng.next() < 0.2;
  const seen = memory[target.id]?.shots || 0;
  const dialled = seen >= (difficulty === 'hard' ? 2 : 3);
  const finish = (target.hp || 0) + (target.armor || 0) <= 70;
  return (dialled || finish) && rng.next() < (difficulty === 'hard' ? 0.8 : 0.55);
}

// A target behind a Gravity Orbiter (`shielded`) draws Flak first: its burst
// over the tank hurts the orbiter too, and fragments care less about a bent path.
export function chooseWeapon(me, target, rng) {
  const has = (id) => me.inventory[id] > 0;
  if (target.shielded && has('flak') && rng.next() < 0.6) return 'flak';
  if (has('roller') && target.y < me.y - 8 && rng.next() < 0.6) return 'roller';
  if (has('breacher') && rng.next() < 0.5) return 'breacher';
  if (has('scatter') && rng.next() < 0.4) return 'scatter';
  if (has('flak') && rng.next() < 0.4) return 'flak';
  return 'shell';
}

// A weapon for the second of a CPU's two shots: the first one's ammo is spent
// already, so it only picks a heavy round it still has one of, else a Shell.
export function chooseSecondWeapon(me, first, rng) {
  const left = (id) => (me.inventory[id] || 0) - (id === first ? 1 : 0);
  if (left('breacher') > 0 && rng.next() < 0.5) return 'breacher';
  return 'shell';
}
