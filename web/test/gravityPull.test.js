import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAVITY, makeProjectile, stepProjectile } from '../src/core/ballistics.js';
import { wellAccel, pullLevel, wellReach, stepLevel, PULL_THRESHOLD, FADE_IN, FADE_OUT } from '../src/core/gravityPull.js';

const well = { x: 0, y: 100, z: 0, r: 10, mu: 4000 };

test('gravity lines: pull matches what stepProjectile applies, clamped at the surface', () => {
  const p = makeProjectile([30, 100, 0], [0, 0, 0]);
  p.wells = [well];
  p.g = 0;
  stepProjectile(p, [0, 0], 1);
  assert.ok(Math.abs(-p.vel[0] - wellAccel(well, 30, 100, 0)) < 1e-9);
  assert.equal(wellAccel(well, 0, 100, 0), well.mu / 100);   // inside: no stronger than the surface
});

test('gravity lines: level is zero below the threshold, visible just above, 1 when strong', () => {
  assert.equal(pullLevel(0), 0);
  assert.equal(pullLevel(PULL_THRESHOLD), 0);
  assert.ok(pullLevel(PULL_THRESHOLD + 0.01) >= 0.35);
  assert.equal(pullLevel(4), 1);
  assert.ok(pullLevel(0.3) < pullLevel(0.5));
});

test('gravity lines: reach is where the pull falls to the threshold', () => {
  const R = wellReach(well);
  assert.ok(Math.abs(wellAccel(well, R, 100, 0) / GRAVITY - PULL_THRESHOLD) < 1e-9);
  assert.equal(wellReach({ x: 0, y: 0, z: 0, r: 5, mu: 5 }), 0);   // a well too weak to ever show
});

test('gravity lines: fades in over 0.3 s and out over 0.8 s', () => {
  let l = 0;
  for (let t = 0; t < FADE_IN - 0.01; t += 0.01) l = stepLevel(l, 1, 0.01);
  assert.ok(l > 0.9 && l < 1.0);
  l = stepLevel(l, 1, 0.1);
  assert.equal(l, 1);
  for (let t = 0; t < FADE_OUT - 0.02; t += 0.01) l = stepLevel(l, 0, 0.01);
  assert.ok(l > 0 && l < 0.1);
  assert.equal(stepLevel(0.01, 0, 1), 0);
});
