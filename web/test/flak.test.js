import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { airburstNow, WEAPON_BY_ID } from '../src/core/weapons.js';

// Flak: a proximity fuse. It bursts at its nearest pass over an enemy, or just
// above the ground when it passes nobody.

const BURST = WEAPON_BY_ID.flak.flight.find((f) => f.type === 'airburst');

test('flak: bursts at its closest pass over an enemy, not before', () => {
  const tank = { x: 0, y: 0, z: 0, owner: 1 };
  const shell = (x, vy) => ({ owner: 0, pos: [x, 20, 0], vel: [20, vy, 0] });
  assert.equal(airburstNow(shell(-15, -10), BURST, [tank], null), false, 'still closing in');
  assert.equal(airburstNow(shell(1, -10), BURST, [tank], null), true, 'right over it');
  assert.equal(airburstNow(shell(4, -10), BURST, [tank], null), true, 'just past');
  assert.equal(airburstNow(shell(1, 5), BURST, [tank], null), false, 'still climbing');
  assert.equal(airburstNow({ owner: 1, pos: [1, 20, 0], vel: [20, -10, 0] }, BURST, [tank], null), false, 'never over its own tank');
  assert.equal(airburstNow({ owner: 0, pos: [1, 80, 0], vel: [20, -10, 0] }, BURST, [tank], null), false, 'too high over it');
  assert.equal(airburstNow({ owner: 0, pos: [300, 8, 0], vel: [20, -10, 0] }, BURST, [tank], 0), true, 'near the ground, nobody about');
  assert.equal(airburstNow({ owner: 0, pos: [300, 8, 0], vel: [20, -10, 0] }, BURST, [tank], null), false, 'over open space');
});

test('flak: a shell that passes just over a tank hurts it', () => {
  let hurt = 0;
  for (const seed of [2, 5, 9]) {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 1, seed, resolution: 128, twists: false });
    g.start();
    const [a, b] = g.players;
    const hp = b.hp;
    // Drop a flak shell from 60 m up, 30 m short of B, drifting toward it.
    g.phase = 'flight';
    g.spawnProjectile([b.x - 30, b.y + 60, b.z], [15, 0, 0], 'flak', a.id, 1);
    for (let i = 0; i < 120 * 10 && g.projectiles.some((p) => !p.dead); i++) g.stepWorld(1 / 120);
    if (b.hp < hp) hurt++;
  }
  assert.ok(hurt >= 2, `hurt in ${hurt} of 3`);
});
