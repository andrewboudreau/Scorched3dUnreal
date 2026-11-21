import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundHit, tankHit, bearingTo } from '../src/core/tapaim.js';

const flat = () => 0;
const everywhere = () => true;

test('a ray looking down at flat ground meets it where expected', () => {
  const hit = groundHit([0, 100, 0], [1, -1, 0], flat, everywhere);
  assert.ok(Math.abs(hit[0] - 100) < 0.1, `x ${hit[0]}`);
  assert.ok(Math.abs(hit[1]) < 0.1);
});

test('a ray into the sky misses', () => {
  assert.equal(groundHit([0, 10, 0], [1, 0.2, 0], flat, everywhere), null);
});

test('a hill in the way is hit first', () => {
  const hill = (x) => (x > 40 && x < 60 ? 80 : 0);
  const hit = groundHit([0, 100, 0], [1, -0.5, 0], hill, everywhere);
  assert.ok(hit[0] > 39 && hit[0] < 41, `x ${hit[0]}`);
});

test('the ray finds the tank it passes near, not one off to the side or behind', () => {
  const tanks = [{ id: 1, x: 300, y: 0, z: 5 }, { id: 2, x: 300, y: 0, z: 80 }, { id: 3, x: -300, y: 0, z: 0 }];
  assert.equal(tankHit([0, 2, 0], [1, 0, 0], tanks)?.id, 1);
  assert.equal(tankHit([0, 2, 0], [0, 0, 1], tanks), null);
});

test('bearings follow the game: 0 is +x, 90 is +z', () => {
  const from = { x: 10, z: 10 };
  assert.equal(bearingTo(from, 20, 10), 0);
  assert.equal(bearingTo(from, 10, 20), 90);
  assert.equal(bearingTo(from, 0, 10), 180);
  assert.equal(bearingTo(from, 10, 0), 270);
});
