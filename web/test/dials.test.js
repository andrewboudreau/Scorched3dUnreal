import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringTicks, elevTicks, yawText, elevText, wrapDeg, yawDir, fadeStep, arcSide, loadDials, saveDials, DIALS_KEY } from '../src/dialmath.js';
import { muzzleDirection } from '../src/core/ballistics.js';

test('the ring has a tick every 15 degrees, long with a number every 45', () => {
  const t = ringTicks();
  assert.equal(t.length, 24);
  assert.deepEqual(t.map((x) => x.deg), [...Array(24).keys()].map((i) => i * 15));
  const major = t.filter((x) => x.major);
  assert.deepEqual(major.map((x) => x.label), ['0', '45', '90', '135', '180', '225', '270', '315']);
  assert.ok(t.filter((x) => !x.major).every((x) => x.label === ''));
});

test('the elevation arc runs 0 to 90, numbered every 15, long at 0, 45 and 90', () => {
  const t = elevTicks();
  assert.deepEqual(t.map((x) => x.label), ['0', '15', '30', '45', '60', '75', '90']);
  assert.deepEqual(t.filter((x) => x.major).map((x) => x.deg), [0, 45, 90]);
});

test('readings are printed exactly as the HUD prints them', () => {
  for (const v of [0, 7.25, 37.9, 90, 359.96, 12.04]) {
    assert.equal(yawText(v), `${v.toFixed(1)}°`);
    assert.equal(elevText(v), `${v.toFixed(1)}°`);
  }
});

test('ring angles use the game convention: 0 along +x, growing toward +z', () => {
  assert.equal(wrapDeg(-90), 270);
  assert.equal(wrapDeg(360), 0);
  for (const yaw of [0, 45, 90, 135, 200, 315]) {
    const [x, z] = yawDir(yaw);
    const d = muzzleDirection(yaw, 0);    // the barrel's own direction
    assert.ok(Math.abs(x - d[0]) < 1e-12 && Math.abs(z - d[2]) < 1e-12);
  }
  const [x, z] = yawDir(90);
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(z - 1) < 1e-12);
});

test('fadeStep eases to the target without overshooting', () => {
  assert.equal(fadeStep(0, 1, 0.1, 5), 0.5);
  assert.equal(fadeStep(0.8, 1, 0.1, 5), 1);
  assert.equal(fadeStep(0.3, 0, 0.1, 4), 0);
  assert.ok(Math.abs(fadeStep(1, 0, 0.1, 4) - 0.6) < 1e-12);
});

test('the arc only changes side once the camera is clearly across the line', () => {
  assert.equal(arcSide(1, 2), 1);
  assert.equal(arcSide(1, -2), 1);
  assert.equal(arcSide(1, -10), -1);
  assert.equal(arcSide(-1, 2), -1);
  assert.equal(arcSide(-1, 10), 1);
});

test('the setting is on by default and remembers being switched off', () => {
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(loadDials(ls), true);
  saveDials(false, ls);
  assert.equal(store.get(DIALS_KEY), '0');
  assert.equal(loadDials(ls), false);
  saveDials(true, ls);
  assert.equal(loadDials(ls), true);
  assert.equal(loadDials(null), true);
  assert.equal(loadDials({ getItem() { throw new Error('private mode'); } }), true);
});
