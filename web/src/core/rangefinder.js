// Reading a rangefinder's landings.
//
// A set is the five probes of one shot, keyed 'aim', 'turn-', 'turn+',
// 'power-', 'power+', each { yaw, power, pos: [x, y, z] } once it has landed
// (a probe that left the arena is simply missing).

const DEG = Math.PI / 180;
const wrap = (a) => ((a % 360) + 360) % 360;
const turnBy = (from, to) => ((((to - from) % 360) + 540) % 360) - 180;

// Axes on the ground for a shot fired at `yaw`: `f` points downrange, `r` to
// the right as seen from behind the tank.
export function rangeAxes(yaw) {
  const f = [Math.cos(yaw * DEG), Math.sin(yaw * DEG)];
  return { f, r: [-f[1], f[0]] };
}

// A ground point relative to `origin` in those axes: metres right and downrange.
export function toRange(axes, origin, pos) {
  const dx = pos[0] - origin[0], dz = pos[2] - origin[2];
  return { side: dx * axes.r[0] + dz * axes.r[1], along: dx * axes.f[0] + dz * axes.f[1] };
}

// How far a landing moves per unit of `field` ('yaw' in degrees, 'power'),
// from two probes that differ only in it. The pair either side of the aim is
// best; with one of them lost (or clamped to the same value) use the aim.
function slope(set, minus, plus, field) {
  const pairs = [[set[minus], set[plus]], [set.aim, set[plus]], [set[minus], set.aim]];
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    const dv = field === 'yaw' ? turnBy(a.yaw, b.yaw) : b.power - a.power;
    if (Math.abs(dv) < 1e-6) continue;
    return [(b.pos[0] - a.pos[0]) / dv, (b.pos[2] - a.pos[2]) / dv];
  }
  return null;
}

// The turret and power that should put a shell on `target`, assuming the
// landing moves in a straight line with small changes to either (true near
// the probes; the further out, the rougher). Null when the probes cannot say.
export function solveAim(set, target) {
  const a = set.aim;
  if (!a) return null;
  const jy = slope(set, 'turn-', 'turn+', 'yaw');
  const jp = slope(set, 'power-', 'power+', 'power');
  if (!jy || !jp) return null;
  const det = jy[0] * jp[1] - jy[1] * jp[0];
  if (Math.abs(det) < 1e-6) return null;
  const dx = target[0] - a.pos[0], dz = target[2] - a.pos[2];
  const dYaw = (dx * jp[1] - dz * jp[0]) / det;
  const dPower = (jy[0] * dz - jy[1] * dx) / det;
  return { yaw: wrap(a.yaw + dYaw), power: a.power + dPower, dYaw, dPower };
}
