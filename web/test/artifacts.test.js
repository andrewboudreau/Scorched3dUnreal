import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { ARTIFACTS, KEEP_PAD, isArtifact } from '../src/core/artifacts.js';

// The floating isles' relics: dishes, monoliths, crystals, ruins, a wreck.
// Set dressing only: placed from the seed, clear of the tanks, and moved or
// lost when the ground under them goes.

const isles = (seed, n = 4) => {
  const g = new Game({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), rounds: 1, seed, resolution: 128, world: 'isles', twists: false });
  g.start();
  return g;
};
const strip = (list) => list.map(({ kind, x, y, z, rot, scale, tint }) => [kind, x, y, z, rot, scale, tint]);

test('artifacts: the same seed lays out the same relics and drifting rocks', () => {
  for (const seed of [1, 7, 42]) {
    const a = isles(seed);
    const b = isles(seed);
    assert.ok(a.scenery.artifacts.length >= 3, `${a.scenery.artifacts.length} relics`);
    assert.deepEqual(strip(a.scenery.artifacts), strip(b.scenery.artifacts));
    assert.deepEqual(a.scenery.drifters, b.scenery.drifters);
    for (const r of a.scenery.artifacts) assert.ok(isArtifact(r.kind), r.kind);
  }
  assert.notDeepEqual(strip(isles(1).scenery.artifacts), strip(isles(2).scenery.artifacts));
});

test('artifacts: every relic stands on an isle, clear of the tanks and of each other', () => {
  for (const seed of [3, 4, 5, 6]) {
    for (const n of [2, 6]) {
      const g = isles(seed, n);
      const t = g.terrain;
      const list = g.scenery.artifacts;
      for (const r of list) {
        assert.ok(t.solidAt(r.x, r.z), `${r.kind} on solid ground`);
        assert.ok(Math.abs(r.y - t.heightAt(r.x, r.z)) < 3, `${r.kind} on the surface`);
        for (const p of g.players) assert.ok(Math.hypot(p.x - r.x, p.z - r.z) >= KEEP_PAD + r.reach, `${r.kind} clear of ${p.name}'s pad`);
        for (const o of list) if (o !== r) assert.ok(Math.hypot(o.x - r.x, o.z - r.z) > o.reach + r.reach, 'apart');
        // No tree or house grows through one.
        for (const p of g.scenery.props) assert.ok(Math.hypot(p.x - r.x, p.z - r.z) > r.reach, `${p.kind} clear of the ${r.kind}`);
      }
    }
  }
});

test('artifacts: only on the isles', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed: 3, resolution: 64 });
  g.start();
  assert.equal(g.scenery.artifacts.length, 0);
  assert.equal(g.scenery.drifters.length, 0);
});

test('artifacts: a blast on top removes it, one nearby topples a tall one, the rest are re-seated', () => {
  const g = isles(11);
  const list = g.scenery.artifacts;
  const tall = list.find((r) => ARTIFACTS[r.kind].tall);
  assert.ok(tall, 'a tall relic to knock over');
  // A blast beside it tips it over, away from the blast.
  const bx = tall.x - (tall.reach + 5);
  g.carve(bx, g.terrain.heightAt(bx, tall.z), tall.z, 9, 0.5);
  assert.equal(tall.state, 'fallen');
  assert.ok(Math.abs(Math.cos(tall.fall) - 1) < 0.2, 'falls away from the blast');
  assert.ok(Math.abs(tall.y - g.terrain.heightAt(tall.x, tall.z)) < 3, 'still on the ground');
  // A blast on it removes it.
  const r = list.find((x) => x !== tall);
  g.carve(r.x, g.terrain.heightAt(r.x, r.z), r.z, 10, 0.6);
  assert.equal(r.state, 'gone');
  const events = g.drainEvents().filter((e) => e.type === 'prop' && isArtifact(e.kind)).map((e) => e.how);
  assert.ok(events.includes('fallen') && events.includes('gone'), events.join(','));
  // They never block a shell: not among the things a shell can strike.
  assert.ok(!g.scenery.props.some((p) => isArtifact(p.kind)));
});
