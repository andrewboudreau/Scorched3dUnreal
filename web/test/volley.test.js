import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveShot } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { Game, AIM_HISTORY, VOLLEY } from '../src/core/game.js';
import { TANK } from '../src/core/tank.js';

const make = (players, extra = {}) => {
  const g = new Game({ players, rounds: 2, seed: 11, resolution: 64, twists: false, ...extra });
  g.start();
  return g;
};
const A = { name: 'A' };
const B = { name: 'B' };

// Run the game until `stop(g)` is true, collecting its events.
function run(g, stop, limit = 20000) {
  const events = [];
  for (let k = 0; k < limit && !stop(g); k++) {
    g.update(1 / 30);
    events.push(...g.drainEvents());
  }
  assert.ok(stop(g), 'the game got there');
  return events;
}

// ---- aim history (the onion skin) ----

test('aim history: a tank keeps its last three shots, oldest first', () => {
  const g = make([A, B]);
  const me = g.current;
  assert.deepEqual(me.shots, []);
  const fired = [];
  for (let k = 0; k < 4; k++) {
    run(g, (q) => q.phase === 'aim' && q.current === me);
    if (k === 0) g.adjustAim(0, 28, -38);   // short lobs that hurt nobody
    g.adjustAim(3, -1, 1);
    fired.push({ yaw: me.yaw, elev: me.elev, power: me.power });
    assert.ok(g.fire());
    run(g, (q) => q.phase === 'aim' && q.current !== me);
    if (k === 0) g.adjustAim(0, 30, -40);
    g.fire();
  }
  run(g, (q) => q.phase === 'aim' && q.current === me);
  assert.equal(me.shots.length, AIM_HISTORY.keep);
  assert.deepEqual(me.shots.map((s) => s.n), [2, 3, 4]);
  me.shots.forEach((s, i) => {
    assert.equal(s.yaw, fired[i + 1].yaw);
    assert.equal(s.elev, fired[i + 1].elev);
    assert.equal(s.power, fired[i + 1].power);
    assert.equal(s.weapon, 'shell');
  });
});

test('aim history: a short shuffle keeps it, moving further or a new round wipes it', () => {
  const g = make([A, B]);
  const me = g.current;
  g.fire();
  run(g, (q) => q.phase === 'aim' && q.current !== me);
  g.adjustAim(0, 30, -40);
  g.fire();
  run(g, (q) => q.phase === 'aim' && q.current === me);
  g.drainEvents();
  assert.equal(me.shots.length, 1);
  const from = [me.x, me.z];
  while (Math.hypot(me.x - from[0], me.z - from[1]) < AIM_HISTORY.moved - 1.5) g.drive(1, 0, 0.05);
  assert.equal(me.shots.length, 1, 'still close enough for the old aim to mean something');
  let status = 'ok';
  while (status === 'ok' && me.shots.length) status = g.drive(1, 0, 0.05);
  assert.equal(me.shots.length, 0, 'gone once it has really moved');
  assert.ok(Math.hypot(me.x - from[0], me.z - from[1]) <= AIM_HISTORY.moved + 0.5);
  assert.ok(g.drainEvents().some((e) => e.type === 'aimReset' && e.player === me.id));

  g.fire();
  assert.equal(me.shots.length, 1);
  g.players.forEach((p) => { if (p !== me) p.hp = 0; p.alive = p === me; });
  run(g, (q) => q.phase === 'roundOver');
  g.openShop();
  g.closeShop();
  assert.ok(g.players.every((p) => p.shots.length === 0), 'a new round starts clean');
});

// ---- firing modes ----

test('taking turns is still the default: a shot flies at once', () => {
  const g = make([A, B]);
  assert.equal(g.cfg.firing, 'turns');
  assert.equal(g.volleyMode, false);
  assert.ok(g.fire());
  assert.equal(g.phase, 'flight');
  assert.equal(g.projectiles.length, 1);
});

test('volley: humans plan in turn in secret, then every tank fires at once', () => {
  const g = make([A, B, { name: 'C', ai: 'easy' }], { firing: 'volley', maxWind: 1.5 });
  assert.ok(g.volleyMode);
  const first = g.current;
  assert.ok(first && !first.ai && g.phase === 'aim', 'a human plans first; the CPU needs no go');
  const shown = { yaw: first.yaw, elev: first.elev, power: first.power };
  g.adjustAim(12, 5, 7);
  const planned = { yaw: first.yaw, elev: first.elev, power: first.power };
  g.drainEvents();
  assert.ok(g.fire(), 'Fire locks the plan in');
  assert.equal(g.projectiles.length, 0);
  assert.deepEqual({ yaw: first.yaw, elev: first.elev, power: first.power }, shown, 'the turret goes back to what everyone last saw');
  const second = g.current;
  assert.ok(second !== first && !second.ai && g.phase === 'aim');
  let events = g.drainEvents();
  assert.ok(events.some((e) => e.type === 'locked' && e.player === first.id));
  assert.ok(events.some((e) => e.type === 'turn' && e.player === second.id && e.plan));
  const wind = [...g.wind];

  g.adjustAim(-8, 0, 0);
  g.fire();
  assert.equal(g.phase, 'volley');
  assert.equal(g.current, null);
  assert.equal(g.projectiles.length, 0);
  events = run(g, (q) => q.phase === 'flight');
  assert.ok(g.phaseTime < 0.05 && events.length, 'just launched');
  const shots = events.filter((e) => e.type === 'fire');
  assert.equal(shots.length, 3, 'all three fire, the CPU included');
  assert.equal(g.projectiles.length, 3, 'and the shells are in the air together');
  assert.deepEqual(shots.map((e) => e.delay.toFixed(2)), ['0.00', (VOLLEY.stagger).toFixed(2), (VOLLEY.stagger * 2).toFixed(2)], 'launch sounds are staggered');
  assert.ok(Math.abs(first.yaw - planned.yaw) < 1e-9 && first.elev === planned.elev && first.power === planned.power, 'fired as planned');
  assert.ok(g.players.every((p) => p.shots.length === 1), 'each tank has its shot on record');
  assert.deepEqual(g.wind, wind, 'the wind holds while a volley is planned and flown');

  run(g, (q) => q.phase === 'aim');
  assert.equal(g.turnsThisRound, 1, 'one volley, one count');
  assert.notDeepEqual(g.wind, wind, 'the wind drifts once per volley');
  assert.ok(!g.current.ai);
  assert.equal(g.current.yaw, g.current.shots[0].yaw, 'planning starts from the last aim fired');
});

test('volley: a tank killed mid-volley has already fired; mutual kills end in a draw', () => {
  const g = make([A, B], { firing: 'volley', maxWind: 0 });
  const [a, b] = g.players;
  const aim = (me, at) => {
    const sol = solveShot({ shooter: me, target: [at.x, at.y, at.z], wind: [0, 0], terrain: g.terrain, rng: makeRng(3) });
    assert.ok(sol.predictedMiss < 3, `solver found ${me.name}'s shot`);
    me.yaw = sol.yaw; me.elev = sol.elev; me.power = sol.power;
  };
  a.hp = b.hp = 1;
  for (let k = 0; k < 2; k++) {
    const me = g.current;
    aim(me, me === a ? b : a);
    g.fire();
  }
  const events = run(g, (q) => q.phase === 'roundOver' || q.phase === 'matchOver' || q.phase === 'aim');
  assert.equal(events.filter((e) => e.type === 'fire').length, 2);
  const deaths = events.filter((e) => e.type === 'destroyed');
  assert.equal(deaths.length, 2, 'both shells landed, though one owner was already dead');
  assert.deepEqual(deaths.map((e) => e.by).sort(), [0, 1]);
  assert.equal(g.phase, 'roundOver');
  assert.equal(g.lastRoundResult.winner, null, 'nobody is left: a draw');
  assert.ok(a.money > 0 && b.money > 0, 'both were paid for the kill');
});

test('volley: the round limit counts volleys, and driving belongs to your own planning', () => {
  const g = make([A, B], { firing: 'volley', maxTurnsPerRound: 2 });
  for (let v = 0; v < 2; v++) {
    for (let k = 0; k < 2; k++) {
      run(g, (q) => q.phase === 'aim');
      const me = g.current;
      const fuel = me.fuel;
      if (v === 0) {
        g.drive(1, 0, 0.2);
        assert.ok(me.fuel < fuel, 'the planner can drive');
      }
      g.adjustAim(0, 35, -45);      // a harmless lob
      g.fire();
    }
    run(g, (q) => q.phase !== 'aim');
  }
  run(g, (q) => q.phase === 'roundOver');
  assert.equal(g.turnsThisRound, 2);
  assert.ok(g.players.every((p) => p.alive));
});

test('volley: shots keep their history across volleys and scatter children carry the shot number', () => {
  const g = make([A, B], { firing: 'volley' });
  const seen = new Set();
  for (let v = 0; v < 4; v++) {
    for (let k = 0; k < 2; k++) {
      run(g, (q) => q.phase === 'aim');
      const me = g.current;
      if (v === 0) { me.inventory.scatter = 1; me.weapon = 'scatter'; g.adjustAim(0, 30, -42); }
      else g.adjustAim(1, 0, 0);
      g.fire();
    }
    for (const e of run(g, (q) => q.phase === 'aim' || q.phase === 'roundOver')) {
      if (e.type === 'projectile') { assert.ok(e.shot === v + 1 && e.owner != null); seen.add(e.id); }
    }
  }
  assert.ok(seen.size > 8 + 4, 'the scatter shells split');
  for (const p of g.players) {
    assert.deepEqual(p.shots.map((s) => s.n), [2, 3, 4]);
    assert.notEqual(p.shots[2].yaw, p.shots[1].yaw, 'each volley was fired at its own aim');
  }
});

test('volley: an all-CPU match with twists plays through, CPUs drive and aim per volley', () => {
  const g = new Game({
    players: [{ name: 'A', ai: 'hard' }, { name: 'B', ai: 'normal' }, { name: 'C', ai: 'normal' }, { name: 'D', ai: 'easy' }],
    rounds: 3, seed: 91, resolution: 96, firing: 'volley',
  });
  g.start();
  let volleys = 0;
  let most = 0;
  let guard = 0;
  while (g.phase !== 'matchOver' && guard++ < 400000) {
    g.update(1 / 30);
    for (const e of g.drainEvents()) if (e.type === 'volley') { volleys++; assert.ok(e.players.length >= 2); }
    most = Math.max(most, g.projectiles.length);
    for (const p of g.players) {
      assert.ok(p.fuel >= 0 && p.hp <= p.maxHp && p.fuel <= p.fuelMax);
      if (p.alive && !p.falling) assert.ok(p.y >= g.terrain.heightAt(p.x, p.z) - 1e-6);
    }
    if (g.phase === 'roundOver' && g.phaseTime > 1) g.openShop();
  }
  assert.equal(g.phase, 'matchOver');
  assert.ok(volleys >= 3, `several volleys were fired (${volleys})`);
  assert.ok(most >= 4, 'four shells were in the air at once');
  assert.ok(g.players.every((p) => p.perks.length === 2));
  assert.ok(TANK.fuel > 0);
});
