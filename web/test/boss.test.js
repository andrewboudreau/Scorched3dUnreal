import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { SIM_DT } from '../src/core/ballistics.js';
import { BOSS, ARENA, bossPhase, fromAbove, weakSpot, bossMatch, fortSpots } from '../src/core/boss.js';
import { bossMoves, planDodge } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { parseTestParams } from '../src/builder.js';

// The boss match (core/boss.js): two against one, a boss with phases, marks
// a turn ahead and a weak spot on top.

const SEED = 4242;
function bossGame({ seed = SEED, firing = 'volley', human = true } = {}) {
  const cfg = bossMatch('Tester', { conditions: { maxWind: 1.5, hills: 45 }, firing });
  if (!human) cfg.players[0].ai = 'normal';
  const g = new Game({ ...cfg, seed, resolution: 128 });
  g.start();
  return g;
}
const boss = (g) => g.players[2];
const drain = (g, type) => g.drainEvents().filter((e) => e.type === type);
function settle(g, max = 4000) {
  for (let i = 0; i < max && (g.projectiles.length || g.followUps.length || g.fires.length); i++) g.stepWorld(SIM_DT);
}

// ---------------------------------------------------------------- the match

test('a boss match: the human and a CPU ally on one team against the boss, one walled round', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  assert.equal(me.ai, null);
  assert.equal(ally.ai, 'normal');
  assert.equal(b.name, BOSS.name);
  assert.ok(b.boss && b.size === BOSS.size);
  assert.equal(me.team, ally.team);
  assert.notEqual(me.team, b.team);
  assert.ok(g.allied(me, ally) && !g.allied(me, b) && !g.allied(ally, b));
  assert.equal(b.hp, BOSS.hp);
  assert.equal(b.maxHp, BOSS.hp);
  assert.equal(g.edge, 'wall');
  assert.equal(g.cfg.rounds, 1);
  assert.equal(g.cfg.world, 'meadow');
  // Its foes get the Airburst and a fuller kit; the boss its arsenal.
  assert.ok(me.perks.includes('thunderhead:airburst') && ally.perks.includes('thunderhead:airburst'));
  assert.ok(b.inventory.scatter > 0 && b.inventory.breacher > 0 && b.inventory.dirtbomb > 0 && b.inventory.thunderhead > 0);
  assert.equal(me.armor, BOSS.allyArmor);
});

test('?boss=1 asks for the boss match', () => {
  assert.equal(parseTestParams('?boss=1').boss, true);
  assert.equal(parseTestParams('?boss=0').boss, undefined);
  assert.equal(parseTestParams('?mobile=1').boss, undefined);
});

test('the boss stands on its raised fort at the east end, its foes at the west end', () => {
  const g = bossGame();
  const b = boss(g);
  const t = g.terrain;
  assert.ok(b.x > t.half * 0.4, 'east end');
  for (const p of g.players.slice(0, 2)) assert.ok(p.x < -t.half * 0.3, 'west end');
  // The top is flat and well over the ground round it.
  const around = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => t.heightAt(b.x + Math.cos(k * 0.785) * 60, b.z + Math.sin(k * 0.785) * 60));
  assert.ok(b.y > Math.max(...around) + 8, `fort ${b.y.toFixed(1)} over ${Math.max(...around).toFixed(1)}`);
  for (const [x, z, r] of fortSpots(b.x, b.z)) {
    assert.ok(t.heightAt(x, z) > Math.max(...around) + 4, 'every ledge stands proud');
    assert.ok(Math.abs(t.heightAt(x + r * 0.5, z) - t.heightAt(x, z)) < 0.6, 'and is flat on top');
  }
  // The boss is a big target: its hit sphere is 1.5 times a tank's.
  assert.ok(Math.abs(g.players[2].size - 1.5) < 1e-9);
});

// ---------------------------------------------------------------- phases

test('phases go by health: 1 down to 60%, 2 down to 25%, then 3', () => {
  assert.equal(bossPhase(400, 400), 1);
  assert.equal(bossPhase(241, 400), 1);
  assert.equal(bossPhase(239, 400), 2);
  assert.equal(bossPhase(101, 400), 2);
  assert.equal(bossPhase(99, 400), 3);
  assert.equal(bossPhase(1, 400), 3);
});

test('the boss moves up a phase as it is hurt, announced once each, and never back', () => {
  const g = bossGame();
  const b = boss(g);
  const me = g.players[0];
  g.drainEvents();
  g.damage(b, 150, me.id);   // 250 of 400: still phase 1
  assert.equal(b.boss.phase, 1);
  assert.equal(drain(g, 'bossPhase').length, 0);
  g.damage(b, 20, me.id);    // 230: phase 2
  assert.equal(b.boss.phase, 2);
  assert.deepEqual(drain(g, 'bossPhase').map((e) => e.phase), [2]);
  g.damage(b, 140, me.id);   // 90: phase 3
  assert.equal(b.boss.phase, 3);
  assert.deepEqual(drain(g, 'bossPhase').map((e) => e.phase), [3]);
  b.hp = 300;                // a repair would not take it back
  g.damage(b, 1, me.id);
  assert.equal(b.boss.phase, 3);
  assert.equal(drain(g, 'bossPhase').length, 0);
  assert.equal(Math.round(b.boss.hurt[me.id]), 311, 'it remembers who hurt it');
});

test('phase 1: Point Defense goes up on its turn and refills; Scatter or Breacher at either foe', () => {
  const g = bossGame();
  const b = boss(g);
  const seen = new Set(), weapons = new Set();
  for (let k = 0; k < 24; k++) {
    const plan = g.planBossShot(b);
    assert.ok(g.players[plan.target].team !== b.team, 'never at its own side');
    seen.add(plan.target);
    weapons.add(plan.weapon);
    assert.equal(plan.second, undefined, 'one shot a turn in phase 1');
    assert.equal(b.mods.pointdef.state, 'up');
    assert.ok(b.mods.pointdef.charges >= BOSS.charges);
    b.mods.pointdef.charges = 0;   // spent: topped up next turn
  }
  assert.deepEqual([...seen].sort(), [0, 1], 'the boss targets both of them');
  assert.deepEqual([...weapons].sort(), ['breacher', 'scatter']);
});

test('phase 2: the orbiter goes up, and the boss hops between its ledges', () => {
  const g = bossGame({ firing: 'turns' });
  const b = boss(g);
  g.damage(b, 200, 0);
  assert.equal(b.boss.phase, 2);
  g.planBossShot(b);
  assert.equal(b.mods.orbiter.state, 'up');
  assert.equal(b.mods.orbiter.level, BOSS.orbiter);
  // Its next turn is a hop turn: to another flat top of the fort.
  b.boss.turns = BOSS.hopEvery - 1;
  const go = g.aiWantsToDrive(b);
  assert.ok(go && go.jump, 'a hop');
  const before = [b.x, b.z];
  b.hull = go.heading;
  assert.equal(g.jumpTank(b), 'ok');
  const spots = fortSpots(...g.fort);
  const on = spots.find(([x, z, r]) => Math.hypot(b.x - x, b.z - z) <= r);
  assert.ok(on, 'landed on a ledge');
  assert.ok(Math.hypot(b.x - before[0], b.z - before[1]) > 10, 'and moved');
  // Not every turn.
  b.boss.turns = BOSS.hopEvery;
  assert.equal(g.aiWantsToDrive(b), null);
});

// ---------------------------------------------------------------- telegraphs

test('phase 2: a Dirt Bomb is marked on whoever hurt it most a turn before it falls there', () => {
  const g = bossGame();
  const b = boss(g);
  const [me, ally] = g.players;
  g.damage(b, 60, ally.id);
  g.damage(b, 120, me.id);   // 220 left: phase 2, and the human hurt it most
  g.drainEvents();
  const first = g.planBossShot(b);   // phase-2 turn 1: it marks
  assert.notEqual(first.weapon, 'dirtbomb', 'not yet');
  const mark = b.boss.mark;
  assert.ok(mark, 'marked');
  assert.equal(mark.weapon, 'dirtbomb');
  assert.equal(mark.target, me.id);
  assert.deepEqual([mark.x, mark.z], [me.x, me.z]);
  const ev = drain(g, 'bossMark');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].target, me.id);
  assert.equal(ev[0].weapon, 'dirtbomb');
  // The next turn it fires the Dirt Bomb, at the spot it marked, even if the target moved.
  me.x -= 30;
  const second = g.planBossShot(b);
  assert.equal(second.weapon, 'dirtbomb');
  assert.equal(b.boss.mark, null);
  assert.equal(b.boss.firing.weapon, 'dirtbomb', 'still shown while it flies');
  // The turn after that: no mark (every third turn).
  g.bossTurnOver();
  assert.equal(b.boss.firing, null);
  assert.ok(drain(g, 'bossMark').some((e) => e.clear));
  const third = g.planBossShot(b);
  assert.notEqual(third.weapon, 'dirtbomb');
  assert.equal(b.boss.mark, null);
});

test('phase 3: a Thunderhead is marked a turn ahead, once; every turn it fires twice', () => {
  const g = bossGame();
  const b = boss(g);
  g.damage(b, 310, 1);   // 90 left: phase 3
  assert.equal(b.boss.phase, 3);
  g.drainEvents();
  const one = g.planBossShot(b);
  assert.ok(one.second, 'two shots');
  assert.notEqual(one.weapon, 'thunderhead');
  assert.equal(b.boss.mark.weapon, 'thunderhead');
  assert.equal(drain(g, 'bossMark')[0].weapon, 'thunderhead');
  const two = g.planBossShot(b);
  assert.equal(two.weapon, 'thunderhead', 'the marked Thunderhead goes first');
  assert.ok(two.second && two.second.weapon !== 'thunderhead');
  g.bossTurnOver();
  for (let k = 0; k < 5; k++) {
    const p = g.planBossShot(b);
    assert.ok(p.second);
    assert.notEqual(p.weapon, 'thunderhead');
    assert.equal(b.boss.mark, null, 'only once');
    g.bossTurnOver();
  }
});

test('in a volley the boss really fires both shots and does not reload', () => {
  const g = bossGame({ human: false });
  const b = boss(g);
  g.damage(b, 310, 1);
  // Play volleys until the boss has fired in phase 3.
  let doubles = 0, fired = 0;
  for (let i = 0; i < 30 * 120 && g.phase !== 'matchOver'; i++) {
    g.update(1 / 30);
    for (const e of g.drainEvents()) {
      if (e.type === 'double' && e.player === b.id) doubles++;
      if (e.type === 'fire' && e.player === b.id) fired++;
    }
    if (doubles >= 2) break;
  }
  assert.ok(doubles >= 2, `fired twice in two volleys (${doubles})`);
  assert.ok(fired >= 4);
  assert.equal(b.reloading, false, 'no reload for the boss');
});

test('a CPU under a mark gets out from under it', () => {
  const me = { x: 0, z: 0, fuel: 30, jets: 1 };
  const flat = (heading, budget) => ({ x: Math.cos(heading * Math.PI / 180) * budget, z: Math.sin(heading * Math.PI / 180) * budget, moved: budget });
  const go = planDodge({ me, mark: { x: -5, z: 0 }, reach: 20, tryDrive: flat, tryHop: () => ({ ok: false }) });
  assert.equal(go.heading, 0, 'straight away from the mark');
  assert.equal(planDodge({ me, mark: { x: 100, z: 0 }, reach: 20, tryDrive: flat, tryHop: () => ({ ok: false }) }), null, 'not under it');
  // No fuel to drive clear: a hop.
  const hop = planDodge({ me: { ...me, fuel: 0 }, mark: { x: 0, z: 0 }, reach: 20, tryDrive: flat, tryHop: (h) => ({ ok: true, x: Math.cos(h * Math.PI / 180) * 25, z: Math.sin(h * Math.PI / 180) * 25 }) });
  assert.ok(hop.jump);
});

test('bossMoves picks from the seeded dice only: the same dice, the same moves', () => {
  const state = { phase: 3, turns: 4, phaseTurns: 1, mark: null, thunder: false, hurt: { 0: 30, 1: 80 } };
  const foes = [{ id: 0, hp: 60, armor: 0 }, { id: 1, hp: 90, armor: 0 }];
  const a = bossMoves({ state, foes, rng: makeRng(9) });
  const b = bossMoves({ state, foes, rng: makeRng(9) });
  assert.deepEqual(a, b);
  assert.equal(a.mark.target, 1, 'the Thunderhead goes to whoever hurt it most');
  assert.equal(a.shots.length, 2);
});

// ---------------------------------------------------------------- the weak spot

test('from above: an Airburst, or coming down at least 60 degrees below the horizontal', () => {
  const at = (deg, speed = 50) => [Math.cos(deg * Math.PI / 180) * speed, -Math.sin(deg * Math.PI / 180) * speed, 0];
  assert.equal(fromAbove(at(90)), true);
  assert.equal(fromAbove(at(61)), true);
  assert.equal(fromAbove(at(60)), true);
  assert.equal(fromAbove(at(59)), false);
  assert.equal(fromAbove(at(45)), false);
  assert.equal(fromAbove([10, 30, 0]), false, 'going up');
  assert.equal(fromAbove([10, 0, 0]), false);
  assert.equal(fromAbove([10, 0, 0], true), true, 'an Airburst always is');
  assert.equal(weakSpot({ boss: {} }, true), BOSS.weak.mult);
  assert.equal(weakSpot({ boss: {} }, false), 1);
  assert.equal(weakSpot({}, true), 1, 'only the boss has one');
});

test('a shell coming down steeply on the boss does 25% more than one coming in shallow', () => {
  const hit = (vel) => {
    const g = bossGame();
    const b = boss(g);
    g.drainEvents();
    const top = b.y + 1.8 * b.size + 4.2 * b.size;
    // Start just outside the hit sphere, moving into it.
    const dir = Math.hypot(...vel);
    const pos = [b.x - vel[0] / dir * (4.2 * b.size + 1), top - 4.2 * b.size - vel[1] / dir * (4.2 * b.size + 1), b.z];
    g.spawnProjectile(pos, vel, 'shell', 0);
    settle(g);
    const ev = g.drainEvents();
    const dmg = ev.filter((e) => e.type === 'damage' && e.player === b.id).reduce((s, e) => s + e.amount, 0);
    return { dmg, weak: ev.some((e) => e.type === 'weakSpot') };
  };
  const steep = hit([3, -40, 0]);
  const shallow = hit([40, -6, 0]);
  assert.ok(steep.weak && !shallow.weak);
  assert.ok(shallow.dmg > 0);
  assert.ok(Math.abs(steep.dmg / shallow.dmg - BOSS.weak.mult) < 1e-6, `${steep.dmg} vs ${shallow.dmg}`);
});

test('the weak spot is the boss\'s only: a steep shell on a tank does no more', () => {
  const g = bossGame();
  const ally = g.players[1];
  g.drainEvents();
  g.spawnProjectile([ally.x, ally.y + 12, ally.z], [0, -30, 0], 'shell', 2);
  settle(g);
  const ev = g.drainEvents();
  assert.ok(!ev.some((e) => e.type === 'weakSpot'));
  const dmg = ev.filter((e) => e.type === 'damage' && e.player === ally.id).reduce((s, e) => s + e.amount, 0);
  assert.equal(Math.round(dmg), 38);
});

// ---------------------------------------------------------------- teams

test('the CPU ally never aims at the player; the boss aims at both', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  assert.deepEqual(g.knownFoes(ally).map((q) => q.id), [b.id]);
  assert.deepEqual(g.knownFoes(b).map((q) => q.id).sort(), [me.id, ally.id]);
  for (let k = 0; k < 30; k++) {
    const plan = g.planAiShot(ally);
    if (plan?.target != null) assert.equal(plan.target, b.id);
  }
  const at = new Set();
  for (let k = 0; k < 30; k++) at.add(g.planAiShot(b).target);
  assert.ok(at.has(me.id) && at.has(ally.id));
});

test('hitting an ally hurts it but pays nothing and is not counted', () => {
  const g = bossGame();
  const [me, ally] = g.players;
  const money = me.money;
  const hp = ally.hp + ally.armor;
  g.damage(ally, 30, me.id, 1);
  assert.equal(ally.hp + ally.armor, hp - 30, 'friendly fire still hurts');
  assert.equal(me.money, money);
  assert.equal(me.stats.damage, 0);
  assert.equal(ally.hitBy, null);
  // On the boss it pays.
  g.damage(boss(g), 30, me.id, 2);
  assert.ok(me.money > money);
});

test('an ally\'s Point Defense does not shoot down its friends\' shells', () => {
  const g = bossGame({ human: false });
  const [me, ally] = g.players;
  g.cfg.lab.pointdef = 'all'; g.cfg.lab.pointdefLevel = 1;
  ally.mods.pointdef = { level: 1, state: 'up', hp: 25, maxHp: 25, turns: 5, charges: 1 };
  g.drainEvents();
  g.spawnProjectile([ally.x + 2, ally.y + 15, ally.z], [0, -20, 0], 'shell', me.id);
  settle(g);
  assert.ok(!g.drainEvents().some((e) => e.type === 'intercept'));
  assert.equal(ally.mods.pointdef.charges, 1);
});

// ---------------------------------------------------------------- the end of the round

test('the round ends when the boss dies, and both of its foes win it', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  g.damage(b, b.hp, me.id);
  assert.equal(b.alive, false);
  assert.equal(g.aliveTeams(), 1);
  g.nextTurn();
  assert.equal(g.phase, 'matchOver');
  assert.equal(g.lastRoundResult.winner, me.id, 'the human is named');
  assert.equal(g.lastRoundResult.team, me.team);
  assert.equal(me.wins, 1);
  assert.equal(ally.wins, 1);
  assert.equal(b.wins, 0);
});

test('the round ends when both of the boss\'s foes are dead, and it wins', () => {
  const g = bossGame();
  const [me, ally, b] = g.players;
  g.damage(me, 500, b.id);
  assert.equal(g.aliveTeams(), 2, 'the ally fights on');
  g.damage(ally, 500, b.id);
  assert.equal(g.aliveTeams(), 1);
  g.nextTurn();
  assert.equal(g.phase, 'matchOver');
  assert.equal(g.lastRoundResult.winner, b.id);
  assert.equal(b.wins, 1);
});

test('without teams nothing changes: one winner, the last tank alive', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }, { name: 'C', ai: 'normal' }], seed: 3, resolution: 64, rounds: 2 });
  g.start();
  assert.deepEqual(g.players.map((p) => p.team), [0, 1, 2]);
  assert.ok(!g.allied(0, 1));
  g.damage(g.players[1], 500, 0);
  assert.equal(g.aliveTeams(), 2);
  g.damage(g.players[2], 500, 0);
  g.nextTurn();
  assert.equal(g.lastRoundResult.winner, 0);
  assert.equal(g.lastRoundResult.team, undefined);
  assert.deepEqual(g.players.map((p) => p.wins), [1, 0, 0]);
});

// ---------------------------------------------------------------- replay

// What has to agree between two copies.
const summary = (g) => JSON.stringify({
  phase: g.phase, turns: g.turnsThisRound,
  players: g.players.map((p) => ({ hp: p.hp.toFixed(4), alive: p.alive, x: p.x.toFixed(3), z: p.z.toFixed(3), boss: p.boss || null, mods: p.mods, inv: p.inventory })),
  ground: Array.from(g.terrain.heights.filter((_, i) => i % 61 === 0)).map((h) => h.toFixed(3)),
});

function run(g, frames) {
  for (let i = 0; i < frames && g.phase !== 'matchOver'; i++) {
    g.update(1 / 30);
    g.drainEvents();
  }
}

test('a boss fight replays the same: same seed, same fight', () => {
  const a = bossGame({ seed: 77, human: false });
  const b = bossGame({ seed: 77, human: false });
  run(a, 30 * 400);
  run(b, 30 * 400);
  assert.equal(summary(b), summary(a));
  assert.ok(a.players[2].boss.turns > 3, 'the boss had turns');
});

test('snapshot and restore carry the boss: its phase, mark and fort', () => {
  const a = bossGame({ seed: 91, human: false });
  // Into phase 2 with a mark up, then on to the next volley's beat (where an
  // online host snapshots: every plan made, nothing in the air).
  a.damage(a.players[2], 200, 0);
  a.planBossShot(a.players[2]);
  assert.ok(a.players[2].boss.mark);
  run(a, 30 * 3);
  let guard = 0;
  while (a.phase !== 'volley' && guard++ < 30 * 60) { a.update(1 / 30); a.drainEvents(); }
  assert.equal(a.phase, 'volley');
  assert.equal(a.projectiles.length, 0);
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = bossGame({ seed: 91, human: false });
  b.restore(snap);
  Object.assign(b, { phase: a.phase, phaseTime: a.phaseTime, turn: a.turn, acc: a.acc });
  assert.deepEqual(b.players[2].boss, a.players[2].boss);
  assert.equal(b.players[2].size, BOSS.size);
  assert.equal(b.players[2].team, BOSS.team);
  assert.deepEqual(b.fort, a.fort);
  const t = (g) => g.terrain.heightAt(g.fort[0], g.fort[1]).toFixed(3);
  assert.equal(t(b), t(a), 'the fort is rebuilt');
  // And from there both play on the same.
  a.acc = b.acc = 0;
  a.phaseTime = b.phaseTime;
  run(a, 30 * 200);
  run(b, 30 * 200);
  assert.equal(summary(b), summary(a));
});

test('a boss match runs to the end with every tank a CPU, in turns as in volleys', () => {
  for (const firing of ['volley', 'turns']) {
    const g = bossGame({ seed: 5, human: false, firing });
    run(g, 30 * 60 * 30);
    assert.equal(g.phase, 'matchOver', firing);
    const r = g.lastRoundResult;
    assert.ok(r.team === 0 || r.team === 1 || r.winner === null);
    if (r.team === 0) assert.equal(g.players[2].alive, false);
    if (r.team === 1) assert.ok(!g.players[0].alive && !g.players[1].alive);
  }
});
