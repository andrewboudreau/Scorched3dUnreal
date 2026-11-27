// The angle dials' pure part (no three.js, no DOM): which ticks and numbers
// the two dials carry, the strings they print, and the setting's storage.
// src/render/dials.js draws what this describes; test/dials.test.js checks it.
//
// Conventions, from core/ballistics.js and the HUD's readouts: a turret
// angle (yaw) is in degrees, 0 along +x and growing toward +z (to the
// right of the aim), kept in [0, 360); elevation is 0 level to 90 straight up.

export const YAW_STEP = 15;       // a tick every 15 degrees round the ring
export const YAW_MAJOR = 90;      // a long tick every 90 (0 / 90 / 180 / 270)
export const ELEV_STEP = 15;      // a tick every 15 up the arc
export const ELEV_MAJOR = 45;     // long ticks at 0, 45 and 90
// No fixed numbers on either dial: they crowded the tank, above all on a
// phone. The two live readings at the pointer tips carry the numbers.
export const ELEV_MAX = 90;
export const DIAL_R = 9;          // the rotation ring's radius, m (render/dials.js); what lies round it keeps outside

// Round the ring: 0, 15, ... 345. `major` ticks are long. `label` stays ''
// (a number, if a dial ever wants one again).
export function ringTicks() {
  const out = [];
  for (let deg = 0; deg < 360; deg += YAW_STEP) {
    const major = deg % YAW_MAJOR === 0;
    out.push({ deg, major, label: '' });
  }
  return out;
}

// Up the arc: 0, 15, ... 90; 0, 45 and 90 are long. No numbers.
export function elevTicks() {
  const out = [];
  for (let deg = 0; deg <= ELEV_MAX; deg += ELEV_STEP) {
    out.push({ deg, major: deg % ELEV_MAJOR === 0, label: '' });
  }
  return out;
}

// The HUD's turret and elevation readouts, character for character (main.js
// updateHud), so the dials never disagree with the card.
export const yawText = (yaw) => `${yaw.toFixed(1)}°`;
export const elevText = (elev) => `${elev.toFixed(1)}°`;

// An angle taken into [0, 360).
export const wrapDeg = (deg) => ((deg % 360) + 360) % 360;

// The ground-plane direction of a turret angle as [x, z].
export function yawDir(yaw) {
  const a = (yaw * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

// A step of a fade: `alpha` moves toward `target` (0 or 1) in `dt` seconds at
// `rate` per second, never overshooting.
export function fadeStep(alpha, target, dt, rate) {
  const d = target - alpha;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : alpha + Math.sign(d) * step;
}

// Which side of the barrel the elevation arc stands on: the one the camera is
// on, but it only changes sides once the camera is clearly across the turret's
// line (`side` +1 right, -1 left; `cross` the camera's sideways offset from
// that line, positive on the right), so it does not flicker on the line.
export function arcSide(side, cross, hysteresis = 4) {
  if (side >= 0 && cross < -hysteresis) return -1;
  if (side < 0 && cross > hysteresis) return 1;
  return side >= 0 ? 1 : -1;
}

// The setting, remembered in localStorage (on unless it was switched off).
export const DIALS_KEY = 'craterfall.dials';
export function loadDials(storage = globalThis.localStorage) {
  try { return storage?.getItem(DIALS_KEY) !== '0'; } catch { return true; }
}
export function saveDials(on, storage = globalThis.localStorage) {
  try { storage?.setItem(DIALS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
