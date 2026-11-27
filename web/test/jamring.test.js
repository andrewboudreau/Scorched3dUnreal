import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jamPulse, JAM_STEADY_R, JAM_PULSE_FROM, JAM_PULSE_TO, JAM_STEADY_OPACITY } from '../src/jamring.js';
import { DIAL_R } from '../src/dialmath.js';

test('the jam ring lies outside the aim dial, so the compass never sits on it', () => {
  assert.ok(JAM_PULSE_FROM > DIAL_R + 1);
  assert.ok(JAM_STEADY_R > JAM_PULSE_FROM && JAM_PULSE_TO > JAM_STEADY_R);
  for (let t = 0; t < 4; t += 0.05) assert.ok(jamPulse(t).radius > DIAL_R + 1, `t=${t}`);
});

test('the pulse swells out from inside the steady ring, bright, and fades at the far edge', () => {
  const a = jamPulse(0);
  const b = jamPulse(0.5 / 0.9);
  const c = jamPulse(0.99 / 0.9);
  assert.equal(a.radius, JAM_PULSE_FROM);
  assert.ok(a.radius < b.radius && b.radius < c.radius);
  assert.ok(a.opacity > b.opacity && b.opacity > c.opacity);
  assert.ok(a.opacity > JAM_STEADY_OPACITY);   // it reads over the steady ring
  assert.ok(c.opacity < 0.05);
  assert.equal(jamPulse(1 / 0.9 + 0.2).radius, jamPulse(0.2).radius);   // and starts again
});
