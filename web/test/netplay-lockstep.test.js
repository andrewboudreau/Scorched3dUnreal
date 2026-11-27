import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playMatch, makeRoom, makeScreen, run, allOver, finalState, where } from './lockstep.js';
import { onlineBoss } from '../src/launch.js';
import { Game } from '../src/core/game.js';
import { BOSS } from '../src/core/boss.js';
import { winnerSeat } from '../src/core/netplay.js';

// Online determinism, with the harness in lockstep.js: several screens play
// one match from one log on the same clock, and every time a screen takes on
// the host's state it must already hold exactly that state. Small grounds
// (resolution 48 to 64) keep each match well under a second.

// A bot that uses most of the game: weapons with variants and fire, hops,
// mods, driving, buying.
const KIT = { weapons: ['breacher', 'napalm', 'flak', 'scatter', 'shell', 'roller', 'mound', 'dirtbomb', 'teleport', 'thunderhead', 'ranger'], variants: true, buys: ['napalm', 'flak', 'jet', 'teleport', 'armor'], mods: true, hop: true, drive: 1.0 };
const LAB = { orbiter: 'all', orbiterLevel: 3, satellite: 'all', level: 2, decoy: 'all', pointdef: 'all' };

// Every screen finished, took on every host state without a difference, and
// ends in the same place.
function settled(m) {
  assert.ok(m.done >= 0, `the match did not finish: ${where(m.screens)}`);
  assert.deepEqual(m.mismatches.slice(0, 3), [], 'a screen drifted from the host');
  const end = m.games.map(finalState);
  for (const e of end) assert.equal(e, end[0]);
}

const sum = (screens, f) => screens.reduce((n, s) => n + f(s), 0);

test('lockstep: the online boss match, two humans against the boss, plays the same on both screens', () => {
  // Seeds 2 and 3 once showed a human's aim history drift (drove after a shot).
  for (const seed of [2, 3]) {
    const { config, boss } = onlineBoss({ resolution: 64, seed, maxWind: 1.2 });
    const m = playMatch({ names: ['Ana', 'Bo'], cpus: [boss], config: { ...config, maxTurnsPerRound: 14 }, bot: KIT });
    settled(m);
    assert.ok(m.games[0].players.some((p) => p.boss));
    // The host's report: never an ally when the boss wins, the same on every screen.
    const seats = m.screens.map((s) => winnerSeat(s.session.game, s.session.seatOf));
    assert.ok(seats.every((v) => v === seats[0]));
    if (m.games[0].players.find((p) => p.boss).alive) assert.equal(seats[0], null);
  }
});

test('lockstep: the boss match with a CPU ally and fog of war', () => {
  const { config, boss } = onlineBoss({ resolution: 64, seed: 4, maxWind: 1.2, fog: true });
  const m = playMatch({ names: ['Ana', 'Bo'], cpus: [{ name: 'Rook', ai: 'hard' }, boss], config: { ...config, maxTurnsPerRound: 14 }, bot: KIT });
  settled(m);
});

test('lockstep: three screens, three rounds of rain, mods, weapon variants and Napalm', () => {
  const m = playMatch({
    names: ['Ana', 'Bo', 'Cy'], cpus: [{ name: 'Rook', ai: 'easy' }, { name: 'Vex', ai: 'hard' }],
    config: { rounds: 3, resolution: 64, maxTurnsPerRound: 5, seed: 13, world: 'meadow', edges: 'random', modifier: 'rain', lab: LAB },
    bot: { ...KIT, weapons: ['napalm', 'shell'] },
  });
  settled(m);
  assert.ok(m.screens.some((s) => s.counts.picks.some((id) => id.includes(':'))), 'nobody took a weapon variant');
  assert.ok(sum(m.screens, (s) => s.counts.deploys) > 0, 'nobody deployed a mod');
  assert.ok(sum(m.screens, (s) => s.counts.fired.napalm || 0) > 0, 'nobody fired Napalm');
});

test('lockstep: the City wears down, settles and is driven through alike on every screen', () => {
  const bot = { ...KIT, weapons: ['breacher', 'scatter', 'shell', 'napalm'], drive: 1.5 };
  const m = playMatch({
    names: ['Ana', 'Bo', 'Cy'], cpus: [{ name: 'Rook', ai: 'hard' }, { name: 'Vex', ai: 'normal' }],
    config: { rounds: 2, resolution: 64, maxTurnsPerRound: 6, seed: 39, world: 'city', lab: LAB }, bot,
  });
  settled(m);
  // Buildings were hurt (a snap carried chunks) and some came down.
  const snaps = m.room.log.filter((e) => e.msg.t === 'snap');
  assert.ok(snaps.some((e) => e.msg.state.city?.some((b) => b[3] || b[2])), 'no building was hurt');
});

test('lockstep: CPUs fire Flak at hopping tanks the same on every screen', () => {
  const m = playMatch({
    names: ['Ana', 'Bo'], cpus: [{ name: 'Rook', ai: 'hard' }, { name: 'Vex', ai: 'normal' }],
    config: { rounds: 3, resolution: 48, maxTurnsPerRound: 5, seed: 2, maxWind: 0.5 }, bot: { hop: true, drive: 0.3, buys: ['jet', 'armor'] },
  });
  settled(m);
  assert.ok(m.screens[0].counts.hops > 0);
  assert.ok(m.screens.every((s) => (s.counts.cpuFired.flak || 0) > 0), 'no CPU fired Flak');
});

test('lockstep: a screen that reloads mid-match comes back in step', () => {
  const room = makeRoom();
  const mismatches = [];
  const screens = ['Ana', 'Bo', 'Cy'].map((n, i) => makeScreen(room, i, n, { bot: KIT, mismatches }));
  run(screens, 3);
  screens[0].session.start({ rounds: 2, resolution: 48, maxTurnsPerRound: 5, seed: 7, world: 'city' }, [{ name: 'Rook', ai: 'hard' }]);
  run(screens, 700);
  const g = screens[1].session.game;
  assert.ok(g && g.round >= 1 && g.phase !== 'matchOver', 'reload too late to test');
  screens[1].alive = false;
  screens.push(makeScreen(room, 1, 'Bo', { resume: true, bot: KIT, mismatches }));
  assert.ok(run(screens, 60000, allOver(screens)) >= 0, where(screens));
  assert.deepEqual(mismatches.slice(0, 3), []);
  const live = screens.filter((s) => s.alive).map((s) => finalState(s.session.game));
  for (const e of live) assert.equal(e, live[0]);
});

test('lockstep: uneven frame rates still end the match the same everywhere', () => {
  const m = playMatch({
    names: ['Ana', 'Bo'], cpus: [{ name: 'Rook', ai: 'normal' }],
    config: { rounds: 2, resolution: 48, maxTurnsPerRound: 5, seed: 21, world: 'city' }, bot: { drive: 0.8, hop: true, buys: ['jet'] }, dt: 'uneven',
  });
  assert.ok(m.done >= 0, where(m.screens));
  const end = m.games.map(finalState);
  assert.equal(end[1], end[0]);
});

test('lockstep: a plan carries the aim history and hits taken that driving cleared', () => {
  const { config, boss } = onlineBoss({ resolution: 48, seed: 2 });
  const m = playMatch({ names: ['Ana', 'Bo'], cpus: [boss], config: { ...config, maxTurnsPerRound: 4 }, bot: { drive: 0.5 } });
  const plans = m.room.log.filter((e) => e.msg.t === 'plan');
  assert.ok(plans.length > 0);
  for (const e of plans) {
    assert.ok(Array.isArray(e.msg.tank.shots), 'plan without the aim history');
    assert.equal(typeof e.msg.tank.hitsHere, 'number');
  }
  assert.deepEqual(m.mismatches, []);
});

test('lockstep: a run kit in the config never reaches an online game', () => {
  const room = makeRoom();
  const screens = ['Ana', 'Bo'].map((n, i) => makeScreen(room, i, n));
  run(screens, 3);
  const kit = { money: 9999, jets: 9, perks: ['armor1'], inventory: { napalm: 7 } };
  screens[0].session.start({ rounds: 1, resolution: 48, seed: 3, players: [{ name: 'Ana', kit }, { name: 'Bo', kit }] }, [{ name: 'Rook', ai: 'easy', kit }]);
  run(screens, 3);
  const fresh = new Game({ players: [{ name: 'A' }], rounds: 1, resolution: 48, seed: 3, local: [0] });
  for (const s of screens) {
    for (const p of s.session.game.players) {
      assert.equal(p.money, fresh.players[0].money);
      assert.equal(p.jets, fresh.players[0].jets);
      assert.equal(p.inventory.napalm || 0, fresh.players[0].inventory.napalm || 0);
    }
  }
});

// ---------- the host's match report ----------

function bossGame(hurt, result, aliveBoss = false) {
  const players = [
    { id: 0, name: 'Ana', team: 0, alive: true, hp: 40 },
    { id: 1, name: 'Rook', team: 0, alive: true, hp: 40, ai: 'hard' },
    { id: 2, name: 'Bo', team: 0, alive: false, hp: 0 },
    { id: 3, name: 'Bulwark', team: BOSS.team, alive: aliveBoss, hp: aliveBoss ? 100 : 0, ai: 'hard', boss: { hurt } },
  ];
  return { cfg: { boss: true }, players, lastRoundResult: result };
}

test('winnerSeat: an allies win goes to the human who dealt the boss the most, a CPU ally on top or not', () => {
  const seatOf = [0, null, 1, null];
  assert.equal(winnerSeat(bossGame({ 0: 100, 1: 400, 2: 200 }, { team: 0 }), seatOf), 1);
  assert.equal(winnerSeat(bossGame({ 0: 300, 1: 400, 2: 200 }, { team: 0 }), seatOf), 0);
  assert.equal(winnerSeat(bossGame({ 1: 400 }, { team: 0 }), seatOf), 0);   // no damage: still a human ally
});

test('winnerSeat: a boss win or a draw records no winner', () => {
  const seatOf = [0, null, 1, null];
  assert.equal(winnerSeat(bossGame({ 0: 300 }, { team: BOSS.team }, true), seatOf), null);
  assert.equal(winnerSeat(bossGame({ 0: 300 }, null, true), seatOf), null);
  const draw = bossGame({ 0: 300 }, null);
  for (const p of draw.players) p.alive = false;
  assert.equal(winnerSeat(draw, seatOf), null);
});

test('winnerSeat: any other match goes to the most rounds won, then money, if a human holds it', () => {
  const g = (rows) => ({ cfg: {}, players: rows.map(([wins, money], id) => ({ id, wins, money })), lastRoundResult: null });
  assert.equal(winnerSeat(g([[1, 50], [2, 10], [2, 90]]), [0, 1, 2]), 2);
  assert.equal(winnerSeat(g([[1, 50], [3, 10]]), [0, null]), null);   // a CPU won
  assert.equal(winnerSeat(g([[2, 50], [1, 10]]), [0, null]), 0);
});

test('restore: the volley a game goes on to plan never writes into the state it took on', () => {
  const g = new Game({ players: [{ name: 'A' }, { name: 'B', ai: 'easy' }], rounds: 1, seed: 5, resolution: 48, firing: 'volley', local: [0] });
  g.start();
  const s = JSON.parse(JSON.stringify(g.snapshot()));
  const kept = JSON.stringify(s);
  g.restore(s);
  g.volley.plans[0] = { yaw: 1, elev: 45, power: 50, weapon: 'shell' };
  g.volley.done.push(0);
  assert.equal(JSON.stringify(s), kept);
});

// ---------- the City's chunks across a snapshot ----------

test('city: a screen that took the host\'s city state wears down exactly as the host on the next blast', () => {
  const make = () => {
    const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 1, seed: 11, resolution: 64, world: 'city' });
    g.start();
    return g;
  };
  const host = make();
  const guest = make();
  const b = host.town.buildings.find((q) => q.floors >= 3);
  const at = [b.x + b.hx + 2, b.base + 4.3, b.z + 0.37];
  host.cityBlast(...at, 7.3, 41.7);
  guest.restore(JSON.parse(JSON.stringify(host.snapshot())));
  for (const g of [host, guest]) g.cityBlast(at[0] - 1.1, at[1] + 2.2, at[2], 6.9, 37.3);
  const hb = host.town.buildings[b.id], gb = guest.town.buildings[b.id];
  assert.ok(hb.cells.some((v, k) => v < hb.cellMax[k]), 'the blasts missed');
  assert.deepEqual(gb.cells, hb.cells);
  assert.equal(gb.hp, hb.hp);
  assert.deepEqual(guest.town.state(), host.town.state());
});
