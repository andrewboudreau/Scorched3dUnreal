import { GRAVITY } from './ballistics.js';

// When does a gravity well (a moon, or a mod's orbiting well) tell on a shell
// enough to be worth showing? Pure maths, shared by render/gravityLines.js and
// the tests. A well is `{ x, y, z, r, mu }`; it pulls with mu / d^2 toward its
// centre, d never less than r (the same rule as stepProjectile).

export const PULL_THRESHOLD = 0.12;   // lines show above this share of g
export const PULL_FULL = 0.8;         // ...and reach full strength at this share
export const FADE_IN = 0.3;           // seconds to fade a set of lines in
export const FADE_OUT = 0.8;          // ...and out

// Acceleration (m/s^2) the well puts on something at (x, y, z).
export function wellAccel(w, x, y, z) {
  const dx = w.x - x, dy = w.y - y, dz = w.z - z;
  return w.mu / Math.max(dx * dx + dy * dy + dz * dz, w.r * w.r);
}

// 0 below the threshold; from just above it, a visible 0.35 rising to 1.
// `frac` is the pull as a share of normal gravity.
export function pullLevel(frac, threshold = PULL_THRESHOLD, full = PULL_FULL) {
  if (!(frac > threshold)) return 0;
  return 0.35 + 0.65 * Math.min(1, (frac - threshold) / (full - threshold));
}

// How far from the centre the well's pull is at `threshold` of g; 0 when even
// its surface pull is below that (so it can never be shown).
export function wellReach(w, threshold = PULL_THRESHOLD, g = GRAVITY) {
  if (w.mu / (w.r * w.r) <= threshold * g) return 0;
  return Math.sqrt(w.mu / (threshold * g));
}

// Move a fade level 0..1 toward its target: up over FADE_IN, down over FADE_OUT.
export function stepLevel(level, target, dt) {
  if (target > level) return Math.min(target, level + dt / FADE_IN);
  return Math.max(target, level - dt / FADE_OUT);
}
