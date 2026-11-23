import { simulateShot, launchVelocity, makeProjectile, stepProjectile, GRAVITY, MAX_FLIGHT } from './ballistics.js';
import { TANK, muzzleOrigin } from './tank.js';
import { makeRng } from './rng.js';

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

// How far a shell flies over flat ground (back down to its launch height)
// with air drag and no wind: a coarse version of the real flight, for seeds.
export function flatRange(power, elev, gravity, drag) {
  const p = makeProjectile([0, 0, 0], launchVelocity(0, elev, power));
  p.g = gravity;
  p.windK = 0;
  if (drag) p.drag = drag;
  const dt = 1 / 30;
  while (p.time < MAX_FLIGHT) {
    stepProjectile(p, [0, 0], dt);
    if (p.vel[1] < 0 && p.pos[1] <= 0) break;
  }
  return Math.max(1, p.pos[0]);
}

// The vacuum formula's power falls short in the rain (drag): scale it up
// until the flat-ground flight with drag covers `dist`. A few steps of
// "power by the square root of the range ratio" settle it.
export function dragSeed(power, elev, dist, gravity, drag) {
  for (let k = 0; k < 4; k++) {
    const p = Math.min(TANK.maxPower, power);
    power = p * Math.sqrt(dist / flatRange(p, elev, gravity, drag));
  }
  return power;
}

export function solveShot({ shooter, target, wind, terrain, rng, iterations = 25, tolerance = 1.5, gravity = GRAVITY, windK = 1, drag = 0, field = null, t0 = 0 }) {
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
  if (drag > 0) power = dragSeed(power, elev, targetDist, gravity, drag);
  power = Math.min(TANK.maxPower, Math.max(TANK.minPower, power));

  let best = { yaw, elev, power, miss: Infinity };
  let used = 0;
  for (let it = 0; it < iterations; it++) {
    used++;
    const shot = simulateShot({
      pos: muzzleOrigin(shooter, yaw, elev),
      vel: launchVelocity(yaw, elev, power),
      wind, terrain, gravity, windK, drag, level: target[1] - 1, field, t0,
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
// `sharpen` (0..1) scales the error it carries into this shot: a Survey
// Satellite overhead to read (satelliteSharpen); the memory itself is kept.
export function planShot({ shooter, target, wind, terrain, rng, difficulty = 'normal', memory, gravity = GRAVITY, windK = 1, drag = 0, field = null, t0 = 0, scatter = null, sharpen = 1 }) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const sol = solveShot({ shooter, target: [target.x, target.y + 1, target.z], wind, terrain, rng, gravity, windK, drag, field, t0 });
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

  const yaw = sol.yaw + m.yaw * sharpen + rng.gauss() * cfg.jitterYaw + (scatter?.yaw || 0);
  const power = sol.power * (1 + m.power * sharpen + rng.gauss() * cfg.jitterPower + (scatter?.power || 0));
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

// ---------- the arsenal ----------
//
// A CPU weighs every weapon it holds by the situation (weaponWeights) and
// draws one, the heavier the likelier, so two CPUs in the same spot do not
// always agree. Each CPU also has a temper for the whole match (cpuTemper)
// that leans the weights its own way. The utility rounds only come in when
// they make sense: a Rangefinder before a long shot it has no reading for, a
// Mound heaped at its own feet to climb out of a hole or shift off a spot it
// keeps being hit on, a Teleport out of a deep hole or a losing fight, a
// Guided Missile it steers in flight (offline only, steerGuided), a Scout at
// an enemy it only roughly knows (fog). The heavy rounds keep their old
// shares, so CPUs fire more kinds of shell, not more damage.

// Tempers. Each multiplies the weights of weapons (missing: 1) and `satellite`
// its urge to put a Survey Satellite up (wantsSatellite); `likes` are perks it
// favours in the draft (perks.js aiPickPerk) and `buys` what it shops for
// right after its first Breacher (game.aiShop).
export const TEMPERS = {
  gunner:     { breacher: 1.4, scatter: 1.3, roller: 1.2, ranger: 0.5, mound: 0.6, teleport: 0.6, satellite: 0.5, likes: [], buys: [] },
  sapper:     { roller: 1.5, mound: 1.8, teleport: 1.4, breacher: 0.9, likes: ['dugin', 'shocks'], buys: ['mound', 'teleport'] },
  spotter:    { ranger: 1.8, scout: 1.5, guided: 1.5, flak: 1.2, breacher: 0.9, satellite: 1.6, likes: ['satrecon', 'satrecon2'], buys: ['ranger'] },
  skirmisher: { teleport: 2, guided: 1.3, scatter: 1.2, flak: 1.1, mound: 0.8, likes: ['longtanks'], buys: ['teleport'] },
};
export const TEMPER_IDS = Object.keys(TEMPERS);

// A CPU's temper: a pure function of the match seed and its id, so it needs
// no state and every copy of an online game agrees.
export function cpuTemper(seed, id) {
  const r = makeRng(((seed ^ 0x7e3a) ^ Math.imul(id + 1, 0x85ebca6b)) >>> 0);
  r.next();
  return TEMPER_IDS[Math.floor(r.next() * TEMPER_IDS.length)];
}

// Rounds that do no damage: never half of a Double Strike.
export const UTILITY = ['ranger', 'scout', 'mound', 'teleport'];

// The situations, in numbers.
//   finish    target hp + armor a Shell can finish: no utility rounds then
//   tough     ... that a Breacher likely finishes: the Breacher weighs more
//   below     m the target sits below it: the Roller weighs more
//   far       m: a shot this long it has no reading for can draw a Rangefinder
//   sunk      m in a hole it could not drive or hop out of: Mound at its feet
//   deep      m in a hole: Teleport out
//   hurt      share of its hit points left under which it counts as hurt
//   behind    its hp + armor under this share of the strongest enemy's
//   easyDull  how keenly an Easy CPU reads the situation (1: fully)
//   easyWild  chance an Easy CPU just grabs any weapon it could use
export const ARSENAL = { finish: 45, tough: 75, below: 8, far: 180, sunk: 4, deep: 7, hurt: 0.6, behind: 0.5, easyDull: 0.5, easyWild: 0.12 };

// Does it still not have the range on a target? `m` is its aim memory for it
// (planShot): none yet, or an error left bigger than about a degree or 2% of the charge.
export const AIM_SURE = { yaw: 1.0, power: 0.02 };
export const unsureOf = (m) => !m || !(m.shots > 0) || Math.abs(m.yaw) > AIM_SURE.yaw || Math.abs(m.power) > AIM_SURE.power;

// What each weapon `me` holds weighs against `target` now. `ctx` is the
// situation, all optional (game.aiSituation):
//   difficulty, temper   its difficulty and temper id
//   seen                 shots it has fired at this target already
//   unsure               it has no good reading on the target (unsureOf)
//   dist                 m to the target
//   sunk                 m it sits below the ground around it (holeDepth)
//   hits                 hits it has taken on this spot (p.hitsHere)
//   hurt, behind         see ARSENAL
//   threat               someone who has hit it is still alive
//   heap                 a Mound fired at its feet would land there (planHeap)
//   warp                 there is somewhere to Teleport to (findWarp)
//   steer                it may steer a Guided Missile (offline)
// Returns { weapon id: weight }; the Shell is always there.
export function weaponWeights(me, target, ctx = {}) {
  const A = ARSENAL;
  const lean = TEMPERS[ctx.temper] || {};
  const keen = ctx.difficulty === 'easy' ? A.easyDull : 1;
  const sit = (x) => 1 + (x - 1) * keen;   // a situational boost, dulled for Easy
  const inv = me.inventory || {};
  const w = { shell: 1 };
  const add = (id, x) => { if (inv[id] > 0 && x > 0) w[id] = x * (lean[id] ?? 1); };
  const tough = (target.hp ?? 100) + (target.armor ?? 0);
  const finish = tough <= A.finish;
  const unsure = !!ctx.unsure;
  const dy = (target.y ?? 0) - (me.y ?? 0);
  const hits = ctx.hits || 0;

  add('breacher', 0.9 * (tough <= A.tough ? sit(1.5) : 1));
  add('scatter', 0.45 * (unsure ? sit(1.5) : 1));
  add('flak', 0.35 * (target.shielded || target.aloft ? sit(4) : 1) * (unsure ? sit(1.3) : 1));
  add('roller', 0.35 * (dy < -A.below ? sit(4) : dy > A.below ? 0.3 : 1));
  if (ctx.steer) add('guided', 0.6 * (!ctx.seen ? sit(1.8) : unsure ? 1.2 : 0.4) * (target.shielded ? sit(1.5) : 1));
  if (target.rough) add('scout', 1.6);
  if (finish) return w;   // it can finish the target: no time for anything else
  if (unsure && !target.rough && (ctx.dist || 0) > A.far && !(ctx.seen && keen < 1)) add('ranger', 0.7 * keen * (ctx.seen ? 0.6 : 1));
  if (ctx.heap) {
    const shaken = ctx.threat && (hits >= 2 || (hits >= 1 && ctx.hurt));
    add('mound', keen * ((ctx.sunk || 0) >= A.sunk ? 3 : 0) + keen * (shaken ? 0.45 * Math.min(3, hits) * (ctx.hurt ? 1.5 : 1) : 0));
  }
  if (ctx.warp) {
    add('teleport', keen * (((ctx.sunk || 0) >= A.deep ? 4 : 0) + (hits >= 2 && ctx.hurt ? 1 : 0) + (ctx.behind ? 0.7 : 0)));
  }
  return w;
}

// The weapon a CPU fires at `target`: drawn from weaponWeights. An Easy CPU
// now and then grabs anything it could use.
export function chooseWeapon(me, target, rng, ctx = {}) {
  const w = weaponWeights(me, target, ctx);
  const ids = Object.keys(w);
  if (ctx.difficulty === 'easy' && rng.next() < ARSENAL.easyWild) return ids[Math.min(ids.length - 1, Math.floor(rng.next() * ids.length))];
  let roll = rng.next() * ids.reduce((s, id) => s + w[id], 0);
  for (const id of ids) {
    roll -= w[id];
    if (roll <= 0) return id;
  }
  return 'shell';
}

// A Rangefinder shot at a target: the CPU reads where the five probes came
// down, which is worth one more round of learning on top of the shot's own
// (planShot already counted that). It still has to fire the real shot next turn.
export function readRange(memory, id, difficulty = 'normal') {
  const m = memory[id];
  if (!m) return;
  const learn = (DIFFICULTY[difficulty] || DIFFICULTY.normal).learn;
  m.yaw *= learn;
  m.power *= learn;
}

// A Mound at its own feet: lobbed nearly straight up at the least charge,
// leaning toward `toward` ([x, z], whoever is shooting at it, else the
// field's middle). The heap lifts the tank out of a hole, or up and off the
// spot it keeps being hit on. Null unless the trial flight comes down within
// `reach` m of it (wind, a ledge, the edge of an isle).
export const HEAP = { elev: 80, reach: 9 };
export function planHeap({ me, toward = [0, 0], terrain, wind = [0, 0], gravity = GRAVITY, windK = 1, drag = 0 }) {
  const dx = toward[0] - me.x, dz = toward[1] - me.z;
  const yaw = Math.hypot(dx, dz) > 1 ? ((Math.atan2(dz, dx) * RAD) + 360) % 360 : (me.yaw || 0);
  const power = TANK.minPower;
  const shot = simulateShot({ pos: muzzleOrigin(me, yaw, HEAP.elev), vel: launchVelocity(yaw, HEAP.elev, power), wind, terrain, gravity, windK, drag });
  if (shot.kind !== 'ground' || Math.hypot(shot.point[0] - me.x, shot.point[2] - me.z) > HEAP.reach) return null;
  return { yaw, elev: HEAP.elev, power };
}

// Somewhere to Teleport to: `tries` spots `min`..`max` m away, kept on
// solid, dry, level ground inside the field, at least `clear` m from every
// enemy and within `far` m of one (it still wants a shot). The best spot is
// away from the enemies and out of any hole. `solid(x, z)` says whether
// there is ground there (the isles). Returns { x, y, z } or null.
export const WARP = { min: 90, max: 220, tries: 12, edge: 40, clear: 80, far: 380 };
export function findWarp({ me, foes, terrain, rng, solid = () => true }) {
  if (!foes.length) return null;
  const half = terrain.half - WARP.edge;
  let best = null;
  for (let k = 0; k < WARP.tries; k++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(WARP.min, WARP.max);
    const x = me.x + Math.cos(a) * d, z = me.z + Math.sin(a) * d;
    if (Math.abs(x) > half || Math.abs(z) > half || !solid(x, z)) continue;
    const y = terrain.heightAt(x, z);
    if (y < terrain.waterLevel + 1) continue;
    const hole = holeDepth(terrain, x, z, y);
    if (hole > 2) continue;
    const near = Math.min(...foes.map((f) => Math.hypot(f.x - x, f.z - z)));
    if (near < WARP.clear || near > WARP.far) continue;
    const score = Math.min(near, 250) * 0.02 - Math.max(0, hole) * 0.5 + rng.range(0, 1);
    if (!best || score > best.score) best = { x, y, z, score };
  }
  return best && { x: best.x, y: best.y, z: best.z };
}

// A shot at a spot on the ground rather than at a tank (a Teleport's landing):
// the solver's answer with half a first shot's aiming error, as nobody reads
// a spot it has never shot at perfectly. Null if the solver cannot reach it.
export function planPlace({ shooter, point, wind, terrain, rng, difficulty = 'normal', gravity = GRAVITY, windK = 1, drag = 0 }) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const sol = solveShot({ shooter, target: [point.x, point.y + 1, point.z], wind, terrain, rng, gravity, windK, drag });
  if (!(sol.predictedMiss < 12)) return null;
  const yaw = sol.yaw + rng.gauss() * cfg.yaw * 0.5;
  const power = sol.power * (1 + rng.gauss() * cfg.power * 0.5);
  return { yaw: ((yaw % 360) + 360) % 360, elev: sol.elev, power: Math.min(TANK.maxPower, Math.max(TANK.minPower, power)) };
}

// How a CPU steers its Guided Missile, every step: toward the spot it aimed
// at (`goal`, [x, z]). It reacts `delay` s into the flight, holds straight
// while the missile heads within `deadband` degrees of the goal, and lets go
// in the last `near` m. It only fixes the bearing: steering never changes
// the range, so a short shot stays short. Returns -1, 0 or +1 (game.steer).
export const GUIDE = {
  easy: { delay: 1.0, deadband: 5 },
  normal: { delay: 0.5, deadband: 2.5 },
  hard: { delay: 0.25, deadband: 1.2 },
  near: 15,
};
export function steerGuided(pr, goal, difficulty = 'normal') {
  const g = GUIDE[difficulty] || GUIDE.normal;
  if (pr.time < g.delay) return 0;
  const dx = goal[0] - pr.pos[0], dz = goal[1] - pr.pos[2];
  if (Math.hypot(dx, dz) < GUIDE.near) return 0;
  const off = wrap180((Math.atan2(dz, dx) - Math.atan2(pr.vel[2], pr.vel[0])) * RAD);
  return Math.abs(off) < g.deadband ? 0 : Math.sign(off);
}

// ---------- the Survey Satellite ----------

// With its satellite up, a CPU reads the labels and carries only this share
// of its aiming error into a shot (planShot `sharpen`), by satellite level.
// Level 1 labels leave the wind out, so they help less the windier it is;
// an Easy CPU reads them half as well.
export const SAT_READ = [1, 0.65, 0.5, 0.4];
export function satelliteSharpen(level, { difficulty = 'normal', windy = 0 } = {}) {
  if (!(level > 0)) return 1;
  let s = SAT_READ[Math.min(SAT_READ.length - 1, level)];
  if (level === 1) s += 0.2 * Math.min(1, Math.max(0, windy));
  return difficulty === 'easy' ? (1 + s) / 2 : s;
}

// Should a CPU spend this turn putting its satellite up? When it has no good
// reading on a target at least `far` m off that it cannot finish with a
// Shell, `chance` of the time (times its temper's `satellite`). Easy CPUs
// do it now and then at random.
export const SAT_DEPLOY = { far: 150, chance: 0.5, easy: 0.12 };
export function wantsSatellite({ me, target, memory, difficulty = 'normal', temper = null, rng }) {
  if (!target) return false;
  if (difficulty === 'easy') return rng.next() < SAT_DEPLOY.easy;
  const tough = (target.hp ?? 100) + (target.armor ?? 0);
  if (tough <= ARSENAL.finish || !(target.rough || unsureOf(memory[target.id]))) return false;
  if (Math.hypot(target.x - me.x, target.z - me.z) < SAT_DEPLOY.far) return false;
  return rng.next() < Math.min(0.9, SAT_DEPLOY.chance * (TEMPERS[temper]?.satellite ?? 1));
}

// A weapon for the second of a CPU's two shots: the first one's ammo is spent
// already, so it only picks a heavy round it still has one of, else a Shell.
export function chooseSecondWeapon(me, first, rng) {
  const left = (id) => (me.inventory[id] || 0) - (id === first ? 1 : 0);
  if (left('breacher') > 0 && rng.next() < 0.5) return 'breacher';
  return 'shell';
}
