import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Session } from '../src/core/netplay.js';
import { makeRng } from '../src/core/rng.js';

// A room's log as the server keeps it. Messages go through JSON on the way,
// as they do over the wire.
function makeRoom() {
  const log = [];
  return { log, append(seat, msg) { log.push({ n: log.length + 1, seat, msg: JSON.parse(JSON.stringify(msg)) }); } };
}

const WEAPON_CYCLE = ['shell', 'ranger', 'mound', 'roller', 'breacher', 'shell'];
// A bot with `kit` also hops with jump jets, and shoots Flak and Teleports once it has bought them.
const KIT_CYCLE = ['flak', 'teleport', 'shell', 'flak', 'ranger', 'teleport', 'breacher'];

// One screen: its own frame rate, and a bot at the controls of its human.
// `resume`: the same seat coming back after a reload, reading the log from the top.
function makeClient(room, seat, name, { resume = false, kit = false } = {}) {
  const dice = makeRng(1000 + seat + (resume ? 50 : 0));
  const c = { seat, name, cursor: 0, alive: true, dice, shots: 0, hops: 0, warps: 0, frags: 0 };
  c.session = new Session({
    seat,
    send: (msg) => room.append(seat, msg),
    onStart: (cfg) => { const g = new Game(cfg); g.start(); return g; },
    resume,
  });
  if (!resume) room.append(-1, { t: 'join', seat, name });
  c.frame = () => {
    if (!c.alive) return;
    while (c.cursor < room.log.length) c.session.receive(room.log[c.cursor++]);
    c.session.caughtUp();
    const s = c.session;
    const g = s.game;
    if (g) {
      const dt = (1 / 30) * (0.6 + dice.next() * 0.9);   // every screen runs at its own uneven pace
      g.update(dt);
      for (const e of g.drainEvents()) {
        if (e.type === 'jump') c.hops++;
        if (e.type === 'warp') c.warps++;
        if (e.type === 'projectile' && e.weapon === 'flaklet') c.frags++;
      }
      // Screens other than the host drift while they wait, the way different
      // browsers' maths would: the host's snapshot has to put it all back.
      if (seat !== 0 && g.phase === 'wait' && c.drifted !== g.volleyKey) {
        c.drifted = g.volleyKey;
        g.wind[0] += 0.05;
        for (const p of g.players) p.x += 0.4;
        if (dice.next() < 0.5) g.carve(dice.range(-150, 150), 0, dice.range(-150, 150), 9, 0.6);
        c.drifts = (c.drifts || 0) + 1;
      }
      const me = g.current;
      if (g.phase === 'aim' && me && g.isLocal(me)) {
        if (g.phaseTime < 0.4) {
          // Once a volley, a kit bot turns the hull a little and hops before it drives.
          if (kit && me.jets > 0 && c.hopped !== g.volleyKey) { c.hopped = g.volleyKey; me.hull = (me.hull + dice.range(-60, 60) + 360) % 360; g.jump(); }
          g.drive(1, dice.next() < 0.5 ? 1 : 0, dt);
        }
        else {
          const foe = g.players.find((p) => p.alive && p !== me);
          me.yaw = ((Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI + 360) % 360 + dice.range(-3, 3);
          me.elev = 45;
          me.power = 50 + dice.range(-8, 8);
          const cycle = kit ? KIT_CYCLE : WEAPON_CYCLE;
          const w = cycle[c.shots++ % cycle.length];
          me.weapon = me.inventory[w] > 0 ? w : 'shell';
          g.fire();
        }
      }
      if (g.phase === 'roundOver' && g.phaseTime > 0.3) g.openShop();
      if (g.phase === 'shop') {
        for (const p of g.localHumans) {
          if (g.shopped.includes(p.id)) continue;
          if (g.draft[p.id]) g.pickPerk(p.id, g.draft[p.id][p.id % g.draft[p.id].length]);
          if (kit) for (const id of ['teleport', 'jet', 'flak']) g.buy(p.id, id);
          g.buy(p.id, 'armor');
          s.shopDone(p.id);
        }
      }
    }
    s.pump();
  };
  return c;
}

const CONFIG = { rounds: 2, resolution: 64, maxTurnsPerRound: 4, twists: true, seed: 77 };

function play(clients, frames, until) {
  for (let f = 0; f < frames; f++) {
    for (const c of clients) c.frame();
    if (until()) return f;
  }
  return -1;
}

// What has to agree between screens at the end.
const summary = (g) => JSON.stringify({
  phase: g.phase,
  round: g.round,
  players: g.players.map((p) => ({ hp: p.hp, alive: p.alive, wins: p.wins, money: p.money, perks: p.perks, inventory: p.inventory, stats: p.stats, x: p.x, z: p.z, ai: p.ai, jets: p.jets, y: Math.round(p.y * 1000) })),
  ground: Array.from(g.terrain.heights.filter((_, i) => i % 97 === 0)).map((h) => h.toFixed(3)),
});

test('netplay: three screens play a whole match and end up in the same place', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana'), makeClient(room, 1, 'Bo'), makeClient(room, 2, 'Cy')];
  play(clients, 3, () => false);
  assert.deepEqual(clients[0].session.seats.map((s) => s.name), ['Ana', 'Bo', 'Cy']);
  clients[0].session.start(CONFIG, [{ name: 'Rook', ai: 'normal' }]);
  const done = play(clients, 40000, () => clients.every((c) => c.session.game?.phase === 'matchOver'));
  assert.ok(done > 0, `match finished (${clients.map((c) => `${c.session.game?.phase} r${c.session.game?.round}`).join(', ')})`);
  const games = clients.map((c) => c.session.game);
  // Each screen played only its own human.
  assert.deepEqual(games.map((g) => g.localHumans.map((p) => p.name)), [['Ana'], ['Bo'], ['Cy']]);
  assert.equal(games[0].players.length, 4);
  assert.equal(summary(games[1]), summary(games[0]));
  assert.equal(summary(games[2]), summary(games[0]));
  // The volleys really happened: shots fired, the ground was dug, the shop was used.
  assert.ok(games[0].players.every((p) => p.stats.shots + p.stats.probes > 0));
  assert.ok(games[0].players.some((p) => p.perks.length > 0));
  assert.ok(room.log.some((e) => e.msg.t === 'snap'));
  assert.ok(clients[1].drifts > 2 && clients[2].drifts > 2, 'the other screens did drift');
  assert.equal(room.log.filter((e) => e.msg.t === 'start').length, 1);
});

test('netplay: a player who leaves is handed to the computer and the match goes on', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana'), makeClient(room, 1, 'Bo'), makeClient(room, 2, 'Cy')];
  play(clients, 3, () => false);
  clients[0].session.start(CONFIG, []);
  // Play into the match, then Cy's screen goes dark.
  play(clients, 400, () => false);
  clients[2].alive = false;
  room.append(-1, { t: 'gone', seat: 2 });
  const live = clients.slice(0, 2);
  const done = play(live, 40000, () => live.every((c) => c.session.game?.phase === 'matchOver'));
  assert.ok(done > 0, 'match finished without Cy');
  const [a, b] = live.map((c) => c.session.game);
  assert.equal(a.players[2].ai, 'normal');
  assert.equal(summary(b), summary(a));
});

test('netplay: snapshot and restore carry the whole game, ground included', () => {
  const mk = () => new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'normal' }], seed: 5, resolution: 64, firing: 'volley', local: [0] });
  const a = mk();
  a.start();
  a.carve(10, a.terrain.heightAt(10, 10), 10, 12, 0.6);
  a.players[1].hp = 40;
  a.rng.next();
  const b = mk();
  b.start();
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  assert.equal(b.players[1].hp, 40);
  assert.equal(b.players[0].inventory.shell, Infinity);
  assert.equal(b.rng.next(), a.rng.next());
  assert.equal(b.terrain.heightAt(10, 10).toFixed(4), a.terrain.heightAt(10, 10).toFixed(4));
  assert.equal(b.players[0].inventory.guided, 0);   // no steering online
});

test('netplay: the host leaving ends the session for everyone else', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana'), makeClient(room, 1, 'Bo')];
  play(clients, 2, () => false);
  clients[0].session.start(CONFIG, []);
  play(clients, 50, () => false);
  clients[0].alive = false;
  room.append(-1, { t: 'gone', seat: 0 });
  play(clients, 2, () => false);
  assert.match(clients[1].session.over, /host/);
});

// Reload one screen the nth time its game is in `phase` (or at a frame), and play the match out.
function reloadAt(seat, frame, phase = null, nth = 1) {
  const room = makeRoom();
  const names = ['Ana', 'Bo', 'Cy'];
  const clients = names.map((n, i) => makeClient(room, i, n));
  play(clients, 3, () => false);
  clients[0].session.start(CONFIG, [{ name: 'Rook', ai: 'normal' }]);
  let hits = 0;
  let last = null;
  const at = play(clients, phase ? 40000 : frame, () => {
    const ph = clients[seat].session.game.phase;
    const hit = phase && ph === phase && last !== phase;
    last = ph;
    return hit && ++hits === nth;
  });
  if (phase) assert.ok(at >= 0, `seat ${seat} never reached ${phase} #${nth}`);
  const before = clients[seat].session.game;
  clients[seat] = makeClient(room, seat, names[seat], { resume: true });
  const done = play(clients, 40000, () => clients.every((c) => c.session.game?.phase === 'matchOver'));
  const games = clients.map((c) => c.session.game);
  const where = `reload of seat ${seat} at ${phase ? `${phase} #${nth}` : `frame ${frame}`} (${before.phase} r${before.round}.${before.turnsThisRound})`;
  assert.ok(done > 0, `${where}: match finished (${games.map((g) => `${g?.phase} r${g?.round}.${g?.turnsThisRound}`).join(', ')})`);
  assert.equal(summary(games[1]), summary(games[0]), where);
  assert.equal(summary(games[2]), summary(games[0]), where);
  assert.ok(games[seat].players.filter((p) => !p.ai).length === 3, `${where}: nobody was handed to the CPU`);
  // Nothing from before the reload went out twice.
  const plans = room.log.filter((e) => e.msg.t === 'plan').map((e) => `${e.msg.key}:${e.msg.id}`);
  assert.equal(new Set(plans).size, plans.length, `${where}: a plan was sent twice`);
  const shops = room.log.filter((e) => e.msg.t === 'shop').map((e) => `${e.msg.round}:${e.msg.id}`);
  assert.equal(new Set(shops).size, shops.length, `${where}: shopping was sent twice`);
  return before.phase;
}

test('netplay: a screen that reloads mid-match takes its seat back', () => {
  for (const frame of [5, 40, 90, 160, 260, 400, 550, 700]) reloadAt(1, frame);
  // While planning, while waiting on the others, mid-volley, and in the armory.
  for (const [phase, nth] of [['aim', 2], ['wait', 1], ['wait', 3], ['volley', 2], ['flight', 4], ['roundOver', 1], ['shop', 1]]) {
    assert.equal(reloadAt(1, 0, phase, nth), phase);
  }
});

test('netplay: the host can reload too', () => {
  for (const frame of [30, 220, 500]) reloadAt(0, frame);
  for (const [phase, nth] of [['wait', 2], ['flight', 3], ['roundOver', 1]]) reloadAt(0, 0, phase, nth);
});

test('netplay: with fog of war on, every screen keeps the same intel', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana'), makeClient(room, 1, 'Bo')];
  play(clients, 3, () => false);
  clients[0].session.start({ ...CONFIG, fog: true }, [{ name: 'Rook', ai: 'hard' }]);
  const done = play(clients, 40000, () => clients.every((c) => c.session.game?.phase === 'matchOver'));
  assert.ok(done > 0, 'match finished');
  const [a, b] = clients.map((c) => c.session.game);
  assert.ok(a.cfg.fog && b.cfg.fog);
  assert.equal(summary(b), summary(a));
  assert.deepEqual(b.intel, a.intel);
});

test('netplay: jump jet hops, Flak and Teleports replay the same on every screen', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana', { kit: true }), makeClient(room, 1, 'Bo', { kit: true }), makeClient(room, 2, 'Cy', { kit: true })];
  play(clients, 3, () => false);
  clients[0].session.start({ ...CONFIG, seed: 31, rounds: 3 }, [{ name: 'Rook', ai: 'normal' }]);
  const done = play(clients, 60000, () => clients.every((c) => c.session.game?.phase === 'matchOver'));
  assert.ok(done > 0, `match finished (${clients.map((c) => `${c.session.game?.phase} r${c.session.game?.round}`).join(', ')})`);
  const games = clients.map((c) => c.session.game);
  assert.equal(summary(games[1]), summary(games[0]));
  assert.equal(summary(games[2]), summary(games[0]));
  // The hops and warps really happened, and each screen saw its own.
  assert.ok(clients.every((c) => c.hops >= 1), `hops: ${clients.map((c) => c.hops)}`);
  assert.ok(clients.reduce((n, c) => n + c.hops, 0) >= 5);
  assert.ok(clients.some((c) => c.warps >= 1), 'someone teleported');
  assert.ok(clients.every((c) => c.frags >= 14 && c.frags % 14 === 0), `flak fragments: ${clients.map((c) => c.frags)}`);
  // Every plan that went out carried the charges left after the hop.
  const plans = room.log.filter((e) => e.msg.t === 'plan');
  assert.ok(plans.length > 0 && plans.every((e) => Number.isInteger(e.msg.tank.jets)));
  assert.ok(plans.some((e) => e.msg.tank.jets === 0), 'a spent charge travelled with the plan');
  // Charges never went negative and what was bought arrived.
  assert.ok(games[0].players.every((p) => p.jets >= 0));
  assert.ok(games[0].players.some((p) => p.stats.shots > 0 && p.inventory.flak !== undefined));
});

test('netplay: a screen that reloads after hopping keeps its hop and charge', () => {
  const room = makeRoom();
  const clients = [makeClient(room, 0, 'Ana', { kit: true }), makeClient(room, 1, 'Bo', { kit: true })];
  play(clients, 3, () => false);
  clients[0].session.start({ ...CONFIG, seed: 31, rounds: 2 }, []);
  // Into the first volley's planning, past the hops.
  play(clients, 20000, () => clients.every((c) => c.hops >= 1));
  assert.ok(clients[1].hops >= 1);
  play(clients, 20000, () => clients[0].session.game?.phase === 'flight' || clients[0].session.game?.phase === 'volley');
  // Bo's screen reloads and reads the whole log back.
  const back = makeClient(room, 1, 'Bo', { resume: true, kit: true });
  clients[1] = back;
  const done = play(clients, 60000, () => clients.every((c) => c.session.game?.phase === 'matchOver'));
  assert.ok(done > 0, 'match finished');
  assert.equal(summary(clients[1].session.game), summary(clients[0].session.game));
});
