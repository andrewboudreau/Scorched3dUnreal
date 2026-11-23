import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraLimits, clampCameraY } from '../src/camlimit.js';
import { Game } from '../src/core/game.js';

// The orbit camera's floor: over a hill it stays above, under an isle it stays
// below, over open sky it is free.

const match = (world) => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 7, resolution: 128, world, twists: false });
  g.start();
  return g.terrain;
};

test('camera: on an ordinary field it stays 4 m over the ground', () => {
  const t = match('hills');
  const h = t.heightAt(10, 10);
  assert.equal(clampCameraY(t, 10, h - 20, 10), h + 4);
  assert.equal(clampCameraY(t, 10, h + 30, 10), h + 30);
  assert.equal(clampCameraY(t, t.half + 50, -500, 0, 4, -136), -136, 'past the edge the fallback floor applies');
});

test('camera: over an isle it stays above the top, under it below the underside', () => {
  const t = match('isles');
  const pad = [...Array(40).keys()].map((i) => [(i % 8) * 20 - 70, Math.floor(i / 8) * 20 - 40]).find(([x, z]) => t.solidAt(x, z) && t.heightAt(x, z) - t.underAt(x, z) > 12);
  assert.ok(pad, 'found an isle thick enough');
  const [x, z] = pad;
  const top = t.heightAt(x, z);
  const under = t.underAt(x, z);
  assert.equal(clampCameraY(t, x, top + 1, z), top + 4, 'above: pushed to 4 m over the top');
  assert.equal(clampCameraY(t, x, top + 50, z), top + 50, 'high above: left alone');
  assert.equal(clampCameraY(t, x, under - 1, z), under - 4, 'just under: pushed down, not up through the isle');
  assert.equal(clampCameraY(t, x, under - 30, z), under - 30, 'well under: left alone');
  const inside = cameraLimits(t, x, (top + under) / 2 + 0.1, z);
  assert.equal(inside.min, top + 4, 'inside the upper half: out through the top');
  assert.equal(cameraLimits(t, x, (top + under) / 2 - 0.1, z).max, under - 4, 'inside the lower half: out through the underside');
});

test('camera: over open sky between isles there is no ground clamp', () => {
  const t = match('isles');
  let spot = null;
  for (let x = -t.half + 5; x < t.half && !spot; x += 7) for (let z = -t.half + 5; z < t.half && !spot; z += 7) if (!t.solidAt(x, z)) spot = [x, z];
  assert.ok(spot, 'found open sky');
  const [x, z] = spot;
  assert.equal(clampCameraY(t, x, -150, z), -150, 'free well below the old void level');
  assert.equal(clampCameraY(t, x, 80, z), 80);
  assert.equal(clampCameraY(t, x, -1000, z), t.bedrock + 4, 'but not through the far bedrock');
});
