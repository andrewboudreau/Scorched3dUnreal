import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';

const make = () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 2, seed: 11, resolution: 64, twists: false, firing: 'turns' });
  g.start();
  g.drainEvents();
  return g;
};

// Fire the current tank's guided missile, steering with `dir` the whole way;
// returns where it came down.
const flyGuided = (dir) => {
  const g = make();
  const me = g.current;
  me.weapon = 'guided';
  me.yaw = 0; me.elev = 50; me.power = 45;
  assert.ok(g.fire());
  const pr = g.projectiles[0];
  assert.ok(pr.steer, 'guided missiles can be steered');
  let at = null;
  for (let k = 0; k < 4000 && !at; k++) {
    g.steer(me.id, dir);
    g.update(1 / 30);
    for (const e of g.drainEvents()) if ((e.type === 'impact' || e.type === 'lost') && e.id === pr.id) at = e.pos;
  }
  return { at, from: [me.x, me.z], fuel: pr.steer.fuel, me };
};

test('guided missile: one in the starting kit', () => {
  const g = make();
  assert.equal(g.players[0].inventory.guided, 1);
});

test('guided missile: steering right bends it right, left bends it left', () => {
  const straight = flyGuided(0);
  const right = flyGuided(1);
  const left = flyGuided(-1);
  // Yaw 0 fires along +x; right as seen from behind is +z.
  assert.ok(right.at[2] > straight.at[2] + 5, `right ${right.at[2]} vs ${straight.at[2]}`);
  assert.ok(left.at[2] < straight.at[2] - 5, `left ${left.at[2]} vs ${straight.at[2]}`);
  assert.equal(straight.fuel, 3);
  assert.equal(right.fuel, 0);           // steering burns it all
});

test('match stats: shots, probes, hits, damage, kills', () => {
  const g = make();
  const me = g.current;
  const foe = g.players.find((p) => p !== me);
  me.yaw = ((Math.atan2(foe.z - me.z, foe.x - me.x) * 180 / Math.PI) + 360) % 360;
  me.weapon = 'ranger';
  g.fire();
  for (let k = 0; k < 4000 && g.phase !== 'aim'; k++) { g.update(1 / 30); g.drainEvents(); }
  assert.equal(me.stats.probes, 1);
  assert.equal(me.stats.shots, 0);
  // A direct hit, by hand: damage from a shot counts once however many tanks it hurts.
  g.damage(foe, 30, me.id, 7);
  g.damage(foe, 10, me.id, 7);
  assert.equal(me.stats.hits, 1);
  assert.equal(me.stats.damage, 40);
  assert.equal(foe.stats.taken, 40);
  assert.ok(me.stats.longest > 0);
  g.damage(foe, 500, me.id, 8);
  assert.equal(me.stats.hits, 2);
  assert.equal(me.stats.kills, 1);
  assert.equal(me.stats.damage, 100);   // 40 + the 60 it had left: overkill does not count
  g.damage(foe, 20, me.id, 10);                          // nor does shooting a wreck
  assert.equal(me.stats.hits, 2);
  // Hurting yourself is not a hit.
  g.damage(me, 5, me.id, 9);
  assert.equal(me.stats.hits, 2);
  assert.equal(me.stats.taken, 5);
});
