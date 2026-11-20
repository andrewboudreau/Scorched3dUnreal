import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeAxes, toRange, solveAim } from '../src/core/rangefinder.js';
import { Game } from '../src/core/game.js';

// A made-up linear world: each degree of turret moves the landing 4 m right,
// each unit of power moves it 6 m downrange (axes for yaw 0: f = +x, r = +z).
const land = (yaw, power) => [100 + (power - 60) * 6, 0, (yaw - 10) * 4];
const probe = (yaw, power) => ({ yaw, power, pos: land(yaw, power) });
const fullSet = () => ({
  aim: probe(10, 60), 'turn-': probe(8, 60), 'turn+': probe(12, 60), 'power-': probe(10, 55), 'power+': probe(10, 65),
});

test('rangefinder axes: right is to the right seen from behind', () => {
  const ax = rangeAxes(0);
  const d = toRange(ax, [0, 0, 0], [10, 0, 3]);
  assert.ok(Math.abs(d.along - 10) < 1e-9);
  assert.ok(Math.abs(d.side - 3) < 1e-9);
});

test('rangefinder solve recovers the aim in a linear world', () => {
  const est = solveAim(fullSet(), land(11.5, 63));
  assert.ok(Math.abs(est.yaw - 11.5) < 1e-9, `yaw ${est.yaw}`);
  assert.ok(Math.abs(est.power - 63) < 1e-9, `power ${est.power}`);
});

test('rangefinder solve copes with a lost probe and turret wrap', () => {
  const set = fullSet();
  delete set['turn+'];
  delete set['power-'];
  const est = solveAim(set, land(9, 58));
  assert.ok(Math.abs(est.yaw - 9) < 1e-9);
  assert.ok(Math.abs(est.power - 58) < 1e-9);
  // Probes either side of 0°: 358 and 2.
  const near0 = { aim: { yaw: 0, power: 60, pos: [0, 0, 0] }, 'turn-': { yaw: 358, power: 60, pos: [0, 0, -8] },
    'turn+': { yaw: 2, power: 60, pos: [0, 0, 8] }, 'power+': { yaw: 0, power: 65, pos: [30, 0, 0] } };
  const w = solveAim(near0, [0, 0, -4]);
  assert.ok(Math.abs(w.yaw - 359) < 1e-9, `yaw ${w.yaw}`);
  assert.equal(solveAim({ aim: near0.aim }, [0, 0, 0]), null);
});

const make = () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 2, seed: 11, resolution: 64, twists: false });
  g.start();
  g.drainEvents();
  return g;
};
// Fire the current tank's shot and collect where each projectile came down.
const landings = (g) => {
  const ids = new Map(g.projectiles.map((pr) => [pr.id, pr.probe]));
  const out = [];
  for (let k = 0; k < 4000 && g.phase !== 'aim'; k++) {
    g.update(1 / 30);
    for (const e of g.drainEvents()) if (e.type === 'impact' && ids.has(e.id)) out.push({ probe: ids.get(e.id), pos: e.pos });
  }
  return out;
};

test('rangefinder estimate is close in the real game', () => {
  // Probes from one game...
  const g = make();
  const me = g.current;
  me.elev = 45; me.power = 50; me.weapon = 'ranger';
  assert.ok(g.fire());
  const set = {};
  for (const l of landings(g)) set[l.probe.key] = { ...l.probe, pos: l.pos };
  assert.ok(set.aim && set['turn+'] && set['power+'], 'probes landed');
  // ...and a real shell from an identical one, a little off the aim.
  const h = make();
  const you = h.current;
  you.elev = 45; you.yaw = (set.aim.yaw + 1.2) % 360; you.power = set.aim.power + 3; you.weapon = 'shell';
  assert.ok(h.fire());
  const [hit] = landings(h);
  const est = solveAim(set, hit.pos);
  const turn = ((est.yaw - you.yaw + 540) % 360) - 180;
  assert.ok(Math.abs(turn) < 0.4, `turret off by ${turn}`);
  assert.ok(Math.abs(est.power - you.power) < 1, `power ${est.power} vs ${you.power}`);
});
