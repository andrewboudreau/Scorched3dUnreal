import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, STRIKE } from '../src/core/game.js';
import { Session } from '../src/core/netplay.js';
import { PERK_BY_ID, draftOffer } from '../src/core/perks.js';
import { wantsDouble, chooseSecondWeapon } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { SIM_DT } from '../src/core/ballistics.js';

const make = (players, extra = {}) => {
  const g = new Game({ players, rounds: 3, seed: 21, resolution: 64, twists: false, ...extra });
  g.start();
  return g;
};
const A = { name: 'A' };
const B = { name: 'B' };

function run(g, stop, limit = 20000) {
  const events = [];
  for (let k = 0; k < limit && !stop(g); k++) {
    g.update(1 / 30);
    events.push(...g.drainEvents());
  }
  assert.ok(stop(g), 'the game got there');
  return events;
}

// Short lobs that land well short of anyone.
const lob = (g, k = 0) => { const p = g.current; p.elev = 80; p.power = 18 + k; };

// ---- the perk ----

test('double strike: the perk is only drafted for round 3 on', () => {
  assert.ok(PERK_BY_ID.double.doubleStrike);
  assert.equal(PERK_BY_ID.double.fromRound, 3);
  const rng = makeRng(9);
  const me = { perks: [] };
  for (let k = 0; k < 300; k++) assert.ok(!draftOffer(me, rng, 3, 2).includes('double'), 'never before round 3');
  let seen = 0;
  for (let k = 0; k < 300; k++) if (draftOffer(me, rng, 3, 3).includes('double')) seen++;
  assert.ok(seen > 20, `offered from round 3 (${seen} of 300)`);

  // In a match: the draft after round 1 (for round 2) never has it.
  for (let seed = 1; seed < 30; seed++) {
    const g = new Game({ players: [A, B], rounds: 4, seed, resolution: 64 });
    g.start();
    g.endRound();
    g.openShop();
    assert.ok(!Object.values(g.draft).flat().includes('double'), `seed ${seed}: not for round 2`);
  }
});

test('double strike: without the perk, arming does nothing and Fire is one shot', () => {
  const g = make([A, B]);
  assert.equal(g.canDouble(), false);
  assert.equal(g.toggleDouble(), false);
  lob(g);
  assert.ok(g.fire());
  assert.equal(g.phase, 'flight');
  assert.equal(g.current.reloading, false);
});

// ---- take turns ----

test('double strike (turns): queue shot 1, aim shot 2, both go back to back, each as aimed', () => {
  const g = make([A, B]);
  const me = g.current;
  me.perks.push('double');
  me.inventory.breacher = 1;
  g.drainEvents();
  assert.ok(g.canDouble());
  assert.equal(g.strikeStep(), 'single');
  assert.equal(g.toggleDouble(), true);
  assert.equal(g.strikeStep(), 'first');

  // Shot 1: the last Breacher. Queued, not fired.
  lob(g);
  me.yaw = 10;
  me.weapon = 'breacher';
  assert.ok(g.fire());
  assert.equal(g.phase, 'aim', 'still planning');
  assert.equal(g.projectiles.length, 0);
  assert.equal(g.strikeStep(), 'second');
  assert.equal(me.weapon, 'shell', 'the only Breacher is claimed by shot 1');
  assert.equal(g.ammoLeft(me, 'breacher'), 0);
  g.cycleWeapon(1);
  assert.notEqual(me.weapon, 'breacher', 'it is not on offer for shot 2');
  me.weapon = 'shell';
  assert.ok(g.drainEvents().some((e) => e.type === 'queued' && e.player === me.id));

  // Shot 2: a different aim.
  me.yaw = 200;
  lob(g, 4);
  const second = { yaw: me.yaw, power: me.power };
  assert.ok(g.fire());
  assert.equal(g.phase, 'flight');
  assert.equal(me.reloading, true);
  assert.equal(me.inventory.breacher, 0, 'shot 1 spent its own ammo');
  let ev = g.drainEvents();
  const fires = ev.filter((e) => e.type === 'fire');
  assert.equal(fires.length, 1, 'shot 1 now');
  assert.equal(fires[0].weapon, 'breacher');
  assert.equal(me.shots.at(-1).yaw, 10);

  // Shot 2 follows STRIKE.gap later, on the fixed step.
  const steps = Math.round(STRIKE.gap / SIM_DT);
  for (let k = 0; k < steps - 1; k++) g.stepWorld(SIM_DT);
  assert.equal(g.drainEvents().filter((e) => e.type === 'fire').length, 0, 'not yet');
  g.stepWorld(SIM_DT);
  ev = g.drainEvents();
  const f2 = ev.filter((e) => e.type === 'fire');
  assert.equal(f2.length, 1, 'shot 2 just after');
  assert.equal(f2[0].weapon, 'shell');
  assert.equal(me.shots.at(-1).yaw, second.yaw);
  assert.equal(me.shots.at(-1).power, second.power);
  assert.equal(me.stats.shots, 2);

  // The turn only ends once both have landed.
  run(g, (q) => q.phase === 'aim' && q.current !== me);
});

test('double strike (turns): the next turn is move only and Fire passes; the one after is normal', () => {
  const g = make([A, B]);
  const me = g.current;
  me.perks.push('double');
  g.toggleDouble();
  lob(g);
  g.fire();
  lob(g, 3);
  g.fire();
  run(g, (q) => q.phase === 'aim' && q.current !== me);
  lob(g);
  g.fire();                          // B's ordinary shot
  run(g, (q) => q.phase === 'aim' && q.current === me);
  g.drainEvents();

  assert.equal(me.reloading, true);
  assert.equal(g.strikeStep(), 'pass');
  assert.equal(g.canDouble(), false, 'no double while reloading');
  assert.equal(g.toggleDouble(), false);
  // Driving still works.
  const from = [me.x, me.z];
  for (let k = 0; k < 20; k++) g.drive(1, 0, 0.05);
  assert.ok(Math.hypot(me.x - from[0], me.z - from[1]) > 0.5, 'it can drive');
  const shots = me.stats.shots;
  assert.ok(g.fire(), 'Fire passes');
  const ev = run(g, (q) => q.phase === 'aim' && q.current !== me);
  assert.equal(me.stats.shots, shots, 'no shot');
  assert.ok(!ev.some((e) => e.type === 'fire' && e.player === me.id));
  assert.equal(me.reloading, false);

  lob(g);
  g.fire();
  run(g, (q) => q.phase === 'aim' && q.current === me);
  assert.equal(g.strikeStep(), 'single', 'back to normal');
  assert.ok(g.canDouble(), 'and it may double again');
});

test('double strike: optional; disarming drops a queued shot 1, and the online clock never stops at queueing', () => {
  const g = make([A, B]);
  const me = g.current;
  me.perks.push('double');
  // A plain shot from a holder: no reload.
  lob(g);
  g.fire();
  assert.equal(me.reloading, false);
  run(g, (q) => q.phase === 'aim' && q.current !== me);
  lob(g); g.fire();
  run(g, (q) => q.phase === 'aim' && q.current === me);

  // Arm, queue, then change your mind.
  g.toggleDouble();
  lob(g);
  me.weapon = 'breacher';
  g.fire();
  assert.equal(g.strikeStep(), 'second');
  assert.equal(g.toggleDouble(), false);
  assert.equal(g.strikeStep(), 'single');
  assert.equal(g.ammoLeft(me, 'breacher'), me.inventory.breacher, 'the claim on the Breacher is gone');
  g.fire();
  assert.equal(g.phase, 'flight');
  assert.equal(me.reloading, false);
  run(g, (q) => q.phase === 'aim' && q.current !== me);
  lob(g); g.fire();
  run(g, (q) => q.phase === 'aim' && q.current === me);

  // Armed, nothing queued, the clock runs out: one shot goes.
  g.toggleDouble();
  lob(g);
  assert.ok(g.fire(true));
  assert.equal(g.phase, 'flight');
  assert.equal(me.reloading, false);
});

test('double strike: a reload does not carry into the next round', () => {
  const g = make([A, B]);
  const me = g.current;
  me.perks.push('double');
  g.toggleDouble();
  lob(g); g.fire();
  lob(g, 2); g.fire();
  assert.equal(me.reloading, true);
  run(g, (q) => q.phase === 'aim' && q.current !== me);
  g.players.forEach((p) => { if (p !== me) { p.hp = 0; p.alive = false; } });
  run(g, (q) => q.phase === 'roundOver');
  g.openShop();
  g.closeShop();
  assert.ok(g.players.every((p) => !p.reloading));
});

// ---- together (volley) ----

test('double strike (volley): both shots ride in the plan, fire together with the volley, then it sits one out', () => {
  const g = make([A, B], { firing: 'volley' });
  const [a, b] = g.players;
  a.perks.push('double');
  const planner = () => g.current;
  // Plan the first volley.
  run(g, (q) => q.phase === 'aim');
  const first = planner();
  const planA = () => {
    assert.equal(g.current, a);
    assert.ok(g.toggleDouble());
    lob(g); a.yaw = 30;
    g.fire();
    assert.equal(g.phase, 'aim', 'still planning a');
    assert.equal(g.current, a);
    lob(g, 5); a.yaw = 120;
    g.fire();
  };
  const planB = () => { lob(g); g.fire(); };
  if (first === a) { planA(); planB(); } else { planB(); planA(); }
  assert.equal(g.phase, 'volley');
  assert.deepEqual(Object.keys(g.volley.plans).map(Number).sort(), [0, 1]);
  assert.ok(g.volley.plans[a.id].second, 'shot 2 is in the plan');
  assert.equal(g.volley.plans[a.id].yaw, 30);
  assert.equal(g.volley.plans[a.id].second.yaw, 120);
  const ev = run(g, (q) => q.phase === 'aim');
  const fired = ev.filter((e) => e.type === 'fire');
  assert.equal(fired.filter((e) => e.player === a.id).length, 2, 'a fired twice');
  assert.equal(fired.filter((e) => e.player === b.id).length, 1);
  assert.equal(a.reloading, true);

  // Next volley: a can only pass (and b still shoots).
  const order = [];
  while (g.phase === 'aim') {
    const p = g.current;
    order.push(p.id);
    if (p === a) {
      assert.equal(g.strikeStep(), 'pass');
      assert.equal(g.canDouble(), false);
      g.fire();
      assert.ok(!(a.id in g.volley.plans));
    } else planB();
  }
  assert.equal(order.length, 2);
  const ev2 = run(g, (q) => q.phase === 'aim');
  assert.equal(ev2.filter((e) => e.type === 'fire' && e.player === a.id).length, 0, 'a sat it out');
  assert.equal(ev2.filter((e) => e.type === 'fire' && e.player === b.id).length, 1);
  assert.equal(a.reloading, false, 'reloaded');
});

// ---- CPU ----

test('double strike: CPU rules of thumb', () => {
  const rng = makeRng(3);
  const fresh = { id: 1, hp: 100, armor: 0 };
  let n = 0;
  for (let k = 0; k < 200; k++) if (wantsDouble({ target: fresh, memory: {}, difficulty: 'normal', rng })) n++;
  assert.equal(n, 0, 'normal never doubles on a healthy target it has not ranged');
  for (let k = 0; k < 200; k++) if (wantsDouble({ target: fresh, memory: { 1: { shots: 3 } }, difficulty: 'normal', rng })) n++;
  assert.ok(n > 60 && n < 160, `but does about half the time once it has the range (${n})`);
  n = 0;
  for (let k = 0; k < 200; k++) if (wantsDouble({ target: { id: 1, hp: 40, armor: 10 }, memory: {}, difficulty: 'hard', rng })) n++;
  assert.ok(n > 120, `hard goes for the kill (${n})`);
  const me = { inventory: { breacher: 1, shell: Infinity } };
  for (let k = 0; k < 50; k++) assert.equal(chooseSecondWeapon(me, 'breacher', rng), 'shell', 'the last Breacher went in shot 1');
});

for (const firing of ['turns', 'volley']) {
  test(`double strike: CPUs that hold it use it, sit out the reload, and finish the match (${firing})`, () => {
    let doubles = 0;
    let passes = 0;
    let finished = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const g = new Game({ players: [{ name: 'R', ai: 'hard' }, { name: 'S', ai: 'normal' }, { name: 'T', ai: 'hard' }],
        rounds: 2, seed, resolution: 64, firing, maxTurnsPerRound: 12 });
      g.start();
      for (const p of g.players) p.perks.push('double');
      const lastFire = {};
      for (let k = 0; k < 60000 && g.phase !== 'matchOver'; k++) {
        g.update(1 / 30);
        if (g.phase === 'roundOver') { g.openShop(); }
        for (const e of g.drainEvents()) {
          if (e.type === 'double') { doubles++; lastFire[e.player] = 'double'; }
          if (e.type === 'pass') {
            passes++;
            assert.equal(lastFire[e.player], 'double', 'a CPU only passes after a double');
            lastFire[e.player] = 'pass';
          }
          if (e.type === 'fire' && lastFire[e.player] === 'pass') lastFire[e.player] = 'fire';
        }
      }
      if (g.phase === 'matchOver') finished++;
    }
    assert.equal(finished, 4, 'every match finished');
    assert.ok(doubles >= 3, `CPUs fired doubles (${doubles})`);
    assert.ok(passes >= 1, `and sat out reloads (${passes})`);
  });
}

// ---- online ----

function makeRoom() {
  const log = [];
  return { log, append(seat, msg) { log.push({ n: log.length + 1, seat, msg: JSON.parse(JSON.stringify(msg)) }); } };
}

// A screen whose bot arms a double every other volley it can.
function makeClient(room, seat, name) {
  const dice = makeRng(500 + seat);
  const c = { seat, cursor: 0, doubles: 0, passes: 0 };
  c.session = new Session({
    seat,
    send: (msg) => room.append(seat, msg),
    onStart: (cfg) => {
      const g = new Game(cfg);
      g.start();
      for (const p of g.players) p.perks.push('double');   // everyone holds it from the start, on every screen alike
      return g;
    },
  });
  room.append(-1, { t: 'join', seat, name });
  c.frame = () => {
    while (c.cursor < room.log.length) c.session.receive(room.log[c.cursor++]);
    c.session.caughtUp();
    const s = c.session;
    const g = s.game;
    if (g) {
      g.update((1 / 30) * (0.6 + dice.next() * 0.9));
      for (const e of g.drainEvents()) {
        if (e.type === 'double') c.doubles++;
        if (e.type === 'pass') c.passes++;
      }
      const me = g.current;
      if (g.phase === 'aim' && me && g.isLocal(me) && g.phaseTime > 0.3) {
        const foe = g.players.find((p) => p.alive && p !== me);
        const aim = () => {
          me.yaw = ((Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI + 360) % 360 + dice.range(-4, 4);
          me.elev = 45;
          me.power = 50 + dice.range(-8, 8);
        };
        if (g.strikeStep() === 'single' && g.canDouble() && dice.next() < 0.5) g.toggleDouble();
        if (g.strikeStep() === 'first') { aim(); g.fire(); }
        aim();
        g.fire();
      }
      if (g.phase === 'roundOver' && g.phaseTime > 0.3) g.openShop();
      if (g.phase === 'shop') {
        for (const p of g.localHumans) {
          if (g.shopped.includes(p.id)) continue;
          if (g.draft[p.id]) g.pickPerk(p.id, g.draft[p.id][0]);
          s.shopDone(p.id);
        }
      }
    }
    s.pump();
  };
  return c;
}

test('double strike online: plans carry both shots, reloads pass, and every screen ends the same', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana'), makeClient(room, 1, 'Bo')];
  for (let f = 0; f < 3; f++) for (const c of clients) c.frame();
  clients[0].session.start({ rounds: 2, resolution: 64, maxTurnsPerRound: 6, twists: true, seed: 44 }, [{ name: 'Rook', ai: 'hard' }]);
  let done = false;
  for (let f = 0; f < 40000 && !done; f++) {
    for (const c of clients) c.frame();
    done = clients.every((c) => c.session.game?.phase === 'matchOver');
  }
  assert.ok(done, 'match finished');
  const [a, b] = clients.map((c) => c.session.game);
  const sum = (g) => JSON.stringify(g.players.map((p) => ({ hp: p.hp, alive: p.alive, wins: p.wins, money: p.money, inventory: p.inventory, stats: p.stats, x: p.x, z: p.z, reloading: p.reloading })));
  assert.equal(sum(b), sum(a));
  assert.ok(clients[0].doubles > 0 && clients[0].doubles === clients[1].doubles, `doubles seen alike (${clients.map((c) => c.doubles)})`);
  assert.ok(room.log.some((e) => e.msg.t === 'plan' && e.msg.plan?.second), 'a plan went out with a second shot');
  assert.ok(room.log.some((e) => e.msg.t === 'plan' && e.msg.plan === null), 'and a reload went out as a pass');
});
