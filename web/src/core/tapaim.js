// Tap to aim (touch): a tap on the ground or on a tank turns the turret to face
// it, so the first shot of a match starts pointed the right way instead of
// after a long drag round on the aim pad. Only the bearing is set; elevation,
// power and the wind stay the player's job.
//
// Pure: rays are [x, y, z] arrays (main.js makes them from the camera), the
// ground is a heightAt(x, z) function, so this is tested without three.js.

const RAD = 180 / Math.PI;

// Where a ray from the camera first meets the ground, or null. Marches in
// steps and then halves the last one, which is plenty for a heightfield.
export function groundHit(origin, dir, heightAt, inBounds, { step = 3, far = 4000 } = {}) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d = dir.map((v) => v / len);
  const at = (t) => [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t];
  const below = (q) => q[1] <= heightAt(q[0], q[2]);
  let lo = 0;
  for (let t = step; t <= far; t += step) {
    const q = at(t);
    if (!inBounds(q[0], q[2])) { if (q[1] < -50) break; lo = t; continue; }
    if (below(q)) {
      let a = lo, b = t;
      for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if (below(at(m))) b = m; else a = m; }
      return at(b);
    }
    lo = t;
  }
  return null;
}

// The tank the ray passes closest to, if it passes close enough: within 2° of
// it or 7 m of it, whichever is wider, and not behind the camera. tanks are
// { id, x, y, z }; give only the ones the player may aim at (alive, seen).
export function tankHit(origin, dir, tanks) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d = dir.map((v) => v / len);
  let best = null, bestScore = Infinity;
  for (const t of tanks) {
    const v = [t.x - origin[0], t.y + 2 - origin[1], t.z - origin[2]];
    const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
    if (along <= 0) continue;
    const off = Math.hypot(v[0] - d[0] * along, v[1] - d[1] * along, v[2] - d[2] * along);
    const allow = Math.max(7, along * Math.tan(2 / RAD));
    if (off <= allow && off / allow < bestScore) { bestScore = off / allow; best = t; }
  }
  return best;
}

// The turret bearing (degrees, the game's convention: 0 is +x, 90 is +z) from
// a tank to a point.
export function bearingTo(from, x, z) {
  return ((Math.atan2(z - from.z, x - from.x) * RAD) % 360 + 360) % 360;
}
