// The Jammed tank's ring on the ground (render/jammer.js draws it): a steady
// faint ring that stays put, and a pulse that swells out from inside it and
// fades. Both lie outside the aim dial's ring (dialmath.js DIAL_R) and the
// readings at its pointer tips, so the compass never sits on them. Pure, so the
// numbers are tested (test/jamring.test.js).

import { DIAL_R } from './dialmath.js';

export const JAM_STEADY_R = DIAL_R + 5.5;     // the steady ring's radius, m: past the dial's ring and its numbers
export const JAM_STEADY_OPACITY = 0.5;
export const JAM_PULSE_FROM = DIAL_R + 1.8;   // the pulse starts just outside the dial's ring...
export const JAM_PULSE_TO = JAM_STEADY_R + 3; // ...and swells past the steady ring
export const JAM_PULSE_RATE = 0.9;            // pulses a second

// The pulse `t` seconds on: its radius and opacity. It is bright as it leaves
// and fades to nothing at the far edge.
export function jamPulse(t) {
  const k = (t * JAM_PULSE_RATE) % 1;
  return { radius: JAM_PULSE_FROM + (JAM_PULSE_TO - JAM_PULSE_FROM) * k, opacity: 0.9 * (1 - k) * (1 - k * 0.5) };
}
