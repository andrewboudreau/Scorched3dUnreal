import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uprightFromGravity, portraitTimer, PORTRAIT_HOLD } from '../src/portraitexit.js';

test('upright: portrait either way up counts; landscape, flat and tilted do not', () => {
  assert.equal(uprightFromGravity({ x: 0.3, y: 9.6, z: 1.5 }), true);     // portrait, held up
  assert.equal(uprightFromGravity({ x: -0.5, y: -9.5, z: 1 }), true);     // portrait, upside down
  assert.equal(uprightFromGravity({ x: 1, y: 7.6, z: 5.8 }), true);       // portrait, leaned back to read
  assert.equal(uprightFromGravity({ x: 9.7, y: 0.4, z: 1 }), false);      // landscape (playing)
  assert.equal(uprightFromGravity({ x: -9.6, y: 1.2, z: 1.5 }), false);   // landscape, other way
  assert.equal(uprightFromGravity({ x: 0.2, y: 0.3, z: 9.8 }), false);    // flat on a table
  assert.equal(uprightFromGravity({ x: 6, y: 7.2, z: 1 }), false);        // halfway through a turn
  assert.equal(uprightFromGravity(null), null);
  assert.equal(uprightFromGravity({ x: null, y: null, z: null }), null);
});

test('timer: fires once after a continuous hold, and a turn back resets it', () => {
  const t = portraitTimer();
  const ms = PORTRAIT_HOLD.ms;
  assert.equal(t.step(true, 0), false);
  assert.equal(t.step(true, ms - 1), false);
  assert.equal(t.step(true, ms), true);
  assert.equal(t.step(true, ms + 500), false);          // only once per hold
  assert.equal(t.step(false, ms + 600), false);          // back to landscape
  assert.equal(t.step(true, ms + 700), false);           // a new hold starts over
  assert.equal(t.step(true, ms + 700 + ms - 1), false);
  assert.equal(t.step(true, ms + 700 + ms), true);
});

test('timer: a brief glance at portrait does nothing', () => {
  const t = portraitTimer();
  for (let now = 0; now < 2000; now += 200) assert.equal(t.step(true, now), false);
  assert.equal(t.step(false, 2000), false);
  for (let now = 2200; now < 4000; now += 200) assert.equal(t.step(true, now), false);
});
