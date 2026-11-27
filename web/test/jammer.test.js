import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Session } from '../src/core/netplay.js';
import { makeRng } from '../src/core/rng.js';
import { MOD_BY_ID, MOD_PAY, JAM, POINTDEF, deployMod, modTargets, jammerAt, jammerPos, jamStatuses, statusLevel, pdReaches, readyMods } from '../src/core/mods.js';
import { PERK_BY_ID, isModPerk } from '../src/core/perks.js';
import { BRANCHES } from '../src/core/skills.js';
import { planFlakAt } from '../src/core/ai.js';
import { parseTestParams } from '../src/builder.js';

// The Jammer Drone (core/mods.js JAM): the jamming family's mod, and the
// Jammed status it puts on the tank it hovers over.

const mk = (opts = {}) => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B' }], rounds: 3, seed: 5, resolution: 64, modifiers: [], maxTurnsPerRound: 30, ...opts });
  g.start();
  return g;
};
const settle = (g, max = 12) => {
  g.phase = 'flight';
  for (let i = 0; i < 120 * max && g.projectiles.some((p) => !p.dead); i++) g.stepWorld(1 / 120);
};
const bearing = (p, q) => ((Math.atan2(q.z - p.z, q.x - p.x) * 180) / Math.PI + 360) % 360;
// Give `p` a mod at `level`, ready (as the Lab or a perk would).
const give = (g, p, id, level = 1) => {
  const def = MOD_BY_ID[id];
  p.mods[id] = { bought: 0, level, state: 'ready', hp: def.hp[level - 1], maxHp: def.hp[level - 1], turns: def.turns[level - 1], ...(id === 'pointdef' ? { charges: POINTDEF[level].charges } : {}) };
};
const up = (g, p, id, level = 1) => { give(g, p, id, level); deployMod(p, id, (x, z) => g.groundAt(x, z)); };

test('jammer: data, perks, branch and the Lab parameter', () => {
  const d = MOD_BY_ID.jammer;
  assert.equal(d.family, 'jamming');
  assert.equal(d.maxLevel, 3);
  assert.ok(d.targeted && !d.aimed && !d.roundOnly);
  for (const k of ['prices', 'hp', 'turns', 'levels']) assert.equal(d[k].length, 3);
  assert.deepEqual(d.hp, [20, 25, 30]);
  assert.ok(PERK_BY_ID.jamwing.unlock && PERK_BY_ID.jamwing.mods.jammer === 1 && isModPerk(PERK_BY_ID.jamwing));
  assert.ok(PERK_BY_ID.jamup.levelUp && PERK_BY_ID.jamup.stack === 2);
  assert.deepEqual(BRANCHES.find((b) => b.id === 'jammer').ranks, ['jamwing', 'jamup', 'jamup']);
  assert.deepEqual(parseTestParams('?jammer=2').lab, { jammer: 'all', jammerLevel: 2 });
  const g = mk({ lab: { jammer: 'all', jammerLevel: 3 } });
  assert.equal(g.current.mods.jammer.level, 3);
  assert.deepEqual(readyMods(g.current), ['jammer']);
});

test('jammer: the drone hovers over its target, off toward its owner, and follows it', () => {
  const owner = { id: 0, x: 0, y: 0, z: 0 };
  const t = { id: 1, x: 100, y: 5, z: 0 };
  assert.deepEqual(jammerAt(owner, t), { x: 100 - JAM.side, y: 5 + JAM.height, z: 0 });
  // Right on top of each other, still somewhere definite.
  const same = jammerAt({ id: 2, x: 3, y: 0, z: 4 }, { id: 1, x: 3, y: 0, z: 4 });
  assert.ok(Number.isFinite(same.x) && Math.abs(Math.hypot(same.x - 3, same.z - 4) - JAM.side) < 1e-9);
  const p = { ...owner, mods: { jammer: { state: 'up', level: 1, target: 1, x: 9, y: 9, z: 9 } } };
  const players = [p, { ...t, alive: true }];
  assert.equal(jammerPos(players, p).x, 100 - JAM.side);
  players[1].x = 50;
  assert.equal(jammerPos(players, p).x, 50 - JAM.side, 'it goes where the target goes');
  players[1].alive = false;
  assert.deepEqual(jammerPos(players, p), { x: 9, y: 9, z: 9 }, 'a dead target leaves it where it was');
  // It is a thing in the air: Flak's business, not a ground mod.
  const m = modTargets([p, { ...t, alive: true, mods: {} }], 0).find((x) => x.mod === 'jammer');
  assert.ok(m && !m.ground && m.r === JAM.r);
});

test('jammer: deploying takes the turn and jams the enemy the turret points nearest', () => {
  const g = mk({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], lab: { jammer: 'all', jammerLevel: 1 } });
  const p = g.current;
  const [b, c] = g.players.filter((q) => q !== p);
  p.yaw = bearing(p, c);
  g.drainEvents();
  assert.equal(g.deploy('jammer'), 'jammer');
  assert.equal(g.phase, 'settle', 'the turn is spent');
  const m = p.mods.jammer;
  assert.equal(m.state, 'up');
  assert.equal(m.target, c.id);
  assert.deepEqual(c.status, [{ kind: 'jammed', source: p.id, strength: 1, turns: m.turns }]);
  assert.deepEqual(b.status, []);
  assert.equal(g.jammed(c), 1);
  assert.equal(g.arcJammed(c), false, 'level 1 leaves the arc');
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.type === 'mod' && e.what === 'deploy' && e.mod === 'jammer' && e.target === c.id));
  assert.ok(ev.some((e) => e.type === 'status' && e.kind === 'jammed' && e.player === c.id && e.strength === 1 && e.by === p.id));
  // An explicit target wins over the turret.
  const g2 = mk({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], lab: { jammer: 'all', jammerLevel: 1 } });
  const p2 = g2.current;
  p2.yaw = bearing(p2, g2.players[2]);
  g2.deploy('jammer', 1);
  assert.equal(p2.mods.jammer.target, 1);
  assert.equal(g2.deploy('jammer', p2.id), null, 'not over yourself');
});

test('jammer: Jammed darkens the satellite, locks the Guided Missile and (level 2) blanks the arc', () => {
  const g = mk({ lab: { jammer: 'all', jammerLevel: 2 } });
  const [a, b] = g.players;
  up(g, b, 'satellite', 2);
  b.inventory.guided = 2;
  b.ai = 'normal';
  assert.equal(g.surveyLevel(b), 2);
  const sharpBefore = g.aiSharpen(b);
  assert.ok(sharpBefore < 1, 'the satellite helps it aim');
  assert.equal(g.aiSituation(b, a).steer, true);
  g.deploy('jammer');
  assert.equal(g.jammed(b), 2);
  assert.equal(g.surveyLevel(b), 0, 'satellite labels go dark');
  assert.equal(g.arcJammed(b), true);
  assert.equal(g.aiSharpen(b), JAM.blur, 'a jammed CPU aims worse than with no satellite');
  assert.equal(g.aiSituation(b, a).steer, false, 'no steering to count on');
  // Its Guided Missile flies as fired.
  const pr = g.spawnProjectile([b.x, b.y + 3, b.z], [10, 30, 0], 'guided', b.id);
  const twin = g.spawnProjectile([b.x, b.y + 3, b.z], [10, 30, 0], 'shell', b.id);   // the same shot, unsteered
  assert.equal(pr.steer.fuel, 0);
  assert.equal(pr.steer.jammed, true);
  g.steer(b.id, 1);
  g.phase = 'flight';
  for (let i = 0; i < 30; i++) g.stepWorld(1 / 120);
  assert.deepEqual(pr.vel, twin.vel, 'it does not turn');
  // The jammer's own missile still steers.
  const mine = g.spawnProjectile([a.x, a.y + 3, a.z], [10, 30, 0], 'guided', a.id);
  assert.ok(mine.steer.fuel > 0 && !mine.steer.jammed);
});

test('jammer: level 3 jams every enemy within reach of it', () => {
  const g = mk({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], lab: { jammer: 'all', jammerLevel: 3 } });
  const [a, b, c, d] = g.players;
  c.x = b.x + 20; c.z = b.z; c.y = g.terrain.heightAt(c.x, c.z);
  d.x = b.x + 200 < g.terrain.half ? b.x + 200 : b.x - 200; d.z = b.z;
  a.yaw = bearing(a, b);
  g.deploy('jammer', b.id);
  assert.equal(g.jammed(b), 3);
  assert.equal(g.jammed(c), 3, 'a neighbour within the field');
  assert.equal(g.jammed(d), 0);
  assert.equal(g.jammed(a), 0, 'never its owner');
  // The same as the pure rule.
  assert.deepEqual(Object.keys(jamStatuses(g.players, (x, y) => g.allied(x, y))).map(Number).sort(), [b.id, c.id].sort());
  assert.equal(statusLevel({ status: [{ kind: 'jammed', strength: 2 }, { kind: 'jammed', strength: 3 }] }, 'jammed'), 3);
  assert.equal(statusLevel({}, 'jammed'), 0);
});

test('jammer: it wears out on its owner\'s turns, and the status goes with it', () => {
  const g = mk({ lab: { jammer: 'all', jammerLevel: 1 } });
  const [a, b] = g.players;
  g.deploy('jammer');
  const turns = a.mods.jammer.turns;
  assert.equal(b.status[0].turns, turns);
  g.nextTurn();   // A's turn ends: the turn it went up does not count
  g.nextTurn();   // B's
  assert.equal(b.status[0].turns, turns);
  g.nextTurn();   // A's again: one worn
  assert.equal(b.status[0].turns, turns - 1);
  for (let k = 0; k < turns * 2 + 2 && a.mods.jammer.state === 'up'; k++) g.nextTurn();
  assert.notEqual(a.mods.jammer.state, 'up');
  assert.equal(g.jammed(b), 0);
});

test('jammer: shot down by Flak, the status lifts and the shooter is paid', () => {
  const g = mk({ lab: { jammer: 'all', jammerLevel: 1 } });
  const [a, b] = g.players;
  g.deploy('jammer');
  const m = a.mods.jammer;
  const at = jammerPos(g.players, a);
  // A Flak shell from B passing right by it.
  b.inventory.flak = 1;
  const aim = planFlakAt({ shooter: b, point: [at.x, at.y, at.z], r: JAM.r, air: 18, wind: g.wind, terrain: g.terrain, gravity: g.gravity, windK: g.windShare(b), drag: g.shellDrag(b) });
  assert.ok(aim, 'a Flak shot that passes by the drone');
  const money = b.money;
  g.aimAt(b, { ...aim, weapon: 'flak' });
  g.launch(b);
  settle(g);
  assert.equal(m.state, 'down');
  assert.equal(g.jammed(b), 0, 'jamming lifted');
  assert.ok(b.money >= money + MOD_PAY, 'paid for the drone');
});

test('jammer: an enemy Point Defense in reach shoots it down as it arrives', () => {
  const g = mk({ lab: { jammer: 'all', jammerLevel: 1 } });
  const [a, b] = g.players;
  up(g, b, 'pointdef', 1);
  assert.ok(pdReaches(b, jammerAt(a, b)), 'the drone hovers within its reach');
  const money = b.money;
  g.drainEvents();
  g.deploy('jammer');
  assert.equal(a.mods.jammer.state, 'down');
  assert.equal(b.mods.pointdef.charges, POINTDEF[1].charges - 1, 'one charge spent');
  assert.equal(g.jammed(b), 0);
  assert.equal(b.money, money + MOD_PAY);
  const ev = g.drainEvents();
  assert.ok(ev.some((e) => e.type === 'intercept' && e.mod === 'jammer' && e.player === b.id && e.by === a.id));
  // With no charge left it gets through, until the next round refills it.
  const g2 = mk({ lab: { jammer: 'all', jammerLevel: 1 } });
  up(g2, g2.players[1], 'pointdef', 1);
  g2.players[1].mods.pointdef.charges = 0;
  g2.deploy('jammer');
  assert.equal(g2.players[0].mods.jammer.state, 'up');
  assert.equal(g2.jammed(g2.players[1]), 1);
});

test('jammer: an enemy Gravity Orbiter grinds it at the start of its target\'s turns', () => {
  const g = mk({ lab: { jammer: 'all', jammerLevel: 2 } });
  const [a, b] = g.players;
  up(g, b, 'orbiter', 2);
  g.deploy('jammer');
  const m = a.mods.jammer;
  const hp = m.hp;
  g.nextTurn();   // B's turn starts
  assert.equal(g.current, b);
  assert.equal(m.hp, hp - JAM.grind[2]);
  g.nextTurn();   // A's: no grind
  assert.equal(m.hp, hp - JAM.grind[2]);
  // Far from the orbiter it is left alone: a jammer over someone else.
  assert.ok(JAM.grind[1] > 0 && JAM.grind[3] > JAM.grind[1]);
});

test('jammer: its target dying sends it over the nearest enemy left', () => {
  const g = mk({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], lab: { jammer: 'all', jammerLevel: 1 } });
  const [a, b, c] = g.players;
  g.deploy('jammer', b.id);
  b.alive = false;
  g.refreshStatus();
  assert.equal(a.mods.jammer.target, c.id);
  assert.equal(g.jammed(c), 1);
});

test('jammer: Normal and Hard CPUs send it over a tank with a satellite up, not into Point Defense', () => {
  for (const ai of ['normal', 'hard']) {
    const g = mk({ players: [{ name: 'A', ai }, { name: 'B' }, { name: 'C' }], lab: { jammer: 'all', jammerLevel: 1 } });
    const [cpu, b, c] = g.players;
    assert.equal(g.aiWantsDeploy(cpu, b), null, `${ai}: nothing worth jamming`);
    up(g, c, 'satellite', 1);
    assert.equal(g.aiWantsDeploy(cpu, b), 'jammer');
    const plan = g.planAiShot(cpu);
    assert.equal(plan.deploy, 'jammer');
    assert.equal(plan.target, c.id, `${ai}: over the satellite's owner`);
    // Behind Point Defense with a charge: not worth it.
    up(g, c, 'pointdef', 1);
    assert.equal(g.aiWantsDeploy(cpu, b), null);
  }
  // In a game: the CPU's turn goes on the jammer, over the right tank.
  const g = mk({ players: [{ name: 'A', ai: 'hard' }, { name: 'B' }], lab: { jammer: 'all', jammerLevel: 1 } });
  const [cpu, b] = g.players;
  up(g, b, 'satellite', 1);
  g.beginTurn(cpu.id);
  for (let i = 0; i < 400 && g.phase === 'aim'; i++) g.update(1 / 30);
  assert.equal(cpu.mods.jammer.state, 'up');
  assert.equal(g.jammed(b), 1);
});

test('jammer: a jammed CPU with Flak shoots the drone down', () => {
  const g = mk({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], lab: { jammer: 'all', jammerLevel: 2 } });
  const [a, b] = g.players;
  g.deploy('jammer');
  assert.equal(g.jammed(b), 2);
  b.inventory.flak = 2;
  const plan = g.planAiShot(b);
  assert.equal(plan.weapon, 'flak');
  g.aimAt(b, plan);
  g.launch(b);
  settle(g);
  assert.notEqual(a.mods.jammer.state, 'up', 'the drone is down');
  assert.equal(g.jammed(b), 0);
  // Without Flak it shoots at the tank as usual; an Easy CPU never bothers.
  const g2 = mk({ players: [{ name: 'A' }, { name: 'B', ai: 'easy' }], lab: { jammer: 'all', jammerLevel: 2 } });
  g2.deploy('jammer');
  g2.players[1].inventory.flak = 2;
  assert.equal(g2.aiFlakJammer(g2.players[1]), null);
  // A Normal CPU under a level 1 drone with nothing to lose keeps shooting tanks.
  const g3 = mk({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], lab: { jammer: 'all', jammerLevel: 1 } });
  g3.deploy('jammer');
  g3.players[1].inventory.flak = 2;
  g3.players[1].inventory.guided = 0;
  assert.equal(g3.aiFlakJammer(g3.players[1]), null);
});

test('jammer: snapshot and restore carry the drone and the status exactly', () => {
  const opts = { players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], seed: 9, resolution: 64, firing: 'volley', local: [0], lab: { jammer: 'all', jammerLevel: 2 } };
  const a = new Game(opts);
  a.start();
  a.deploy('jammer');
  a.startVolleyBeat();
  for (let i = 0; i < 2000 && a.phase !== 'aim'; i++) a.update(1 / 30);
  assert.equal(a.players[0].mods.jammer.state, 'up');
  assert.equal(a.jammed(a.players[1]), 2);
  const b = new Game(opts);
  b.start();
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  assert.deepEqual(b.players.map((p) => [p.status, p.mods]), a.players.map((p) => [p.status, p.mods]));
  assert.equal(b.arcJammed(b.players[1]), true);
  // And both play on the same from there.
  for (let i = 0; i < 600; i++) { a.update(1 / 30); b.update(1 / 30); }
  assert.deepEqual(b.players.map((p) => [p.hp, p.x, p.status, p.mods.jammer]), a.players.map((p) => [p.hp, p.x, p.status, p.mods.jammer]));
});

// ---------- online: a match with jammers, replayed from its log ----------

function makeRoom() {
  const log = [];
  return { log, append(seat, msg) { log.push({ n: log.length + 1, seat, msg: JSON.parse(JSON.stringify(msg)) }); } };
}

// A screen with a bot at its human's controls: it deploys any ready mod (the
// jammer over whatever its turret points at) half the time, else fires.
function makeClient(room, seat, name, { resume = false } = {}) {
  const dice = makeRng(2000 + seat + (resume ? 50 : 0));
  const c = { seat, name, cursor: 0, deploys: 0, jams: 0 };
  c.session = new Session({ seat, send: (msg) => room.append(seat, msg), onStart: (cfg) => { const g = new Game(cfg); g.start(); return g; }, resume });
  if (!resume) room.append(-1, { t: 'join', seat, name });
  c.frame = () => {
    while (c.cursor < room.log.length) c.session.receive(room.log[c.cursor++]);
    c.session.caughtUp();
    const g = c.session.game;
    if (g) {
      g.update((1 / 30) * (0.6 + dice.next() * 0.9));
      for (const e of g.drainEvents()) if (e.type === 'status' && e.strength > 0) c.jams++;
      const me = g.current;
      if (g.phase === 'aim' && me && g.isLocal(me) && g.phaseTime > 0.3) {
        const foe = g.players.find((p) => p.alive && p !== me);
        me.yaw = bearing(me, foe) + dice.range(-3, 3);
        if (g.canDeploy(me) && dice.next() < 0.5) { if (g.deploy()) c.deploys++; }
        else {
          me.elev = 45;
          me.power = 50 + dice.range(-8, 8);
          me.weapon = me.inventory.flak > 0 && dice.next() < 0.5 ? 'flak' : me.inventory.guided > 0 ? 'guided' : 'shell';
          g.fire();
        }
      }
      if (g.phase === 'roundOver' && g.phaseTime > 0.3) g.openShop();
      if (g.phase === 'shop') {
        for (const p of g.localHumans) {
          if (g.shopped.includes(p.id)) continue;
          if (g.draft[p.id]) g.pickPerk(p.id, g.draft[p.id][0]);
          for (const id of ['flak', 'guided']) g.buy(p.id, id);
          c.session.shopDone(p.id);
        }
      }
    }
    c.session.pump();
  };
  return c;
}

function play(clients, frames, until) {
  for (let f = 0; f < frames; f++) {
    for (const c of clients) c.frame();
    if (until()) return f;
  }
  return -1;
}

const state = (g) => JSON.stringify({
  phase: g.phase, round: g.round, clock: g.clock,
  players: g.players.map((p) => ({ hp: p.hp, alive: p.alive, wins: p.wins, money: p.money, x: p.x, z: p.z, status: p.status, mods: p.mods, inventory: p.inventory })),
  ground: Array.from(g.terrain.heights.filter((_, i) => i % 97 === 0)).map((h) => h.toFixed(3)),
});

test('jammer: netplay: a match with jammers up plays the same on every screen, and replays from the log', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana'), makeClient(room, 1, 'Bo')];
  play(clients, 3, () => false);
  const lab = { jammer: 'all', jammerLevel: 2, satellite: 'all', level: 1 };
  clients[0].session.start({ rounds: 2, resolution: 64, maxTurnsPerRound: 5, seed: 31, lab }, [{ name: 'Rook', ai: 'hard' }]);
  const done = play(clients, 60000, () => clients.every((c) => c.session.game?.phase === 'matchOver'));
  assert.ok(done > 0, 'match finished');
  const [a, b] = clients.map((c) => c.session.game);
  assert.equal(state(b), state(a));
  assert.ok(clients[0].deploys + clients[1].deploys >= 1, 'the humans put jammers up');
  assert.ok(clients[0].jams >= 1, `someone was jammed (${clients[0].jams})`);
  // A third screen, reading the whole log from the top, ends up in the same place.
  const late = makeClient(room, 1, 'Bo', { resume: true });
  play([late], 60000, () => late.session.game?.phase === 'matchOver');
  assert.equal(state(late.session.game), state(a));
});
