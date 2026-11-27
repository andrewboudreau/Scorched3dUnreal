import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playMatch, makeRoom, makeScreen, run, allOver, finalState, where } from './lockstep.js';
import { onlineBoss } from '../src/launch.js';
import { Game } from '../src/core/game.js';
import { BOSS } from '../src/core/boss.js';
import { winnerSeat, Session, OTHER_VERSION } from '../src/core/netplay.js';
import { RoomLink, retryable, MAX_MESSAGE } from '../src/net.js';
import { makeRng } from '../src/core/rng.js';

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
  // Buildings were hurt (a state carried chunks: the City is 'same' when unchanged) and some came down.
  const states = m.room.log.filter((e) => ['snap', 'end'].includes(e.msg.t) && Array.isArray(e.msg.state.city));
  assert.ok(states.some((e) => e.msg.state.city.some((b) => b[3] || b[2])), 'no building was hurt');
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

// ---------- the host's verdict: only the host decides when a round is over ----------

// The guest at `seat` disagrees with the host once, after the volley `key`:
// `inject(g)` runs on its game while that volley is in the air. Each time a
// screen reaches the end of a volley, what it would have decided on its own
// goes in `own` (seat -> { key: over }).
function disagree(seat, key, inject) {
  const own = {};
  let done = false;
  return {
    own,
    during(screens) {
      for (const s of screens) {
        const g = s.session.game;
        if (!g || g.ownDecide) continue;
        g.ownDecide = g.decide;
        g.decide = (over) => { (own[s.seat] ||= {})[g.volleyKey] = over; g.ownDecide(over); };
      }
      const g = screens[seat].session.game;
      if (!done && g?.phase === 'flight' && g.volleyKey === key) { done = true; inject(g); }
    },
    get injected() { return done; },
  };
}

test('verdict: a guest that thinks the round is over after a volley follows the host, who says it goes on', () => {
  // On Bo's screen alone, every other tank dies in the air of volley 1.1.
  const d = disagree(1, '1.1', (g) => { for (const p of g.players) if (p.id !== 1) { p.alive = false; p.hp = 0; } });
  const m = playMatch({
    names: ['Ana', 'Bo'], cpus: [{ name: 'Rook', ai: 'normal' }],
    config: { rounds: 2, resolution: 48, maxTurnsPerRound: 4, seed: 5 }, bot: { drive: 0.3 }, during: d.during,
  });
  assert.ok(d.injected);
  assert.ok(m.done >= 0, `the match hung: ${where(m.screens)}`);
  assert.equal(d.own[1]['1.2'], true, 'Bo\'s screen did not think the round was over');
  const end = m.room.log.find((e) => e.msg.t === 'end' && e.msg.key === '1.2');
  assert.equal(end.msg.over, false, 'the host ended the round too: no disagreement to settle');
  // The only drift is the one put in, and the host's state put it right.
  assert.ok(m.mismatches.length > 0 && m.mismatches.every((x) => x.seat === 1 && x.at === 'verdict 1.2'), JSON.stringify(m.mismatches.slice(0, 2)));
  assert.equal(finalState(m.games[1]), finalState(m.games[0]));
  // Bo's tank planned the next volley: a plan of Bo's for 1.2 is in the log.
  assert.ok(m.room.log.some((e) => e.msg.t === 'plan' && e.msg.key === '1.2' && e.seat === 1));
});

test('verdict: a guest that thinks the round goes on after the last volley follows the host into the armory', () => {
  // Bo's screen believes rounds run longer, so at the host's limit it would plan on.
  const d = disagree(1, '1.0', (g) => { g.cfg.maxTurnsPerRound = 99; });
  const m = playMatch({
    names: ['Ana', 'Bo'], cpus: [{ name: 'Rook', ai: 'easy' }],
    config: { rounds: 2, resolution: 48, maxTurnsPerRound: 3, seed: 8, maxWind: 0.3 }, bot: { drive: 0.2 }, during: d.during,
  });
  assert.ok(m.done >= 0, `the match hung: ${where(m.screens)}`);
  const overs = m.room.log.filter((e) => e.msg.t === 'end' && e.msg.over).map((e) => e.msg.key);
  assert.ok(overs.some((k) => d.own[1][k] === false), 'Bo\'s screen never disagreed about a round\'s end');
  assert.deepEqual(m.mismatches, []);
  assert.equal(finalState(m.games[1]), finalState(m.games[0]));
});

test('verdict: one end per volley, from the host only, and one that ends each round', () => {
  const m = playMatch({ names: ['Ana', 'Bo'], cpus: [{ name: 'Rook', ai: 'easy' }], config: { rounds: 2, resolution: 48, maxTurnsPerRound: 3, seed: 3 } });
  settled(m);
  const ends = m.room.log.filter((e) => e.msg.t === 'end');
  const snaps = m.room.log.filter((e) => e.msg.t === 'snap');
  assert.ok(ends.every((e) => e.seat === 0));
  assert.equal(new Set(ends.map((e) => e.msg.key)).size, ends.length);
  assert.equal(ends.length, snaps.length, 'every volley that flew has its verdict');
  assert.equal(ends.filter((e) => e.msg.over).length, 2, 'one round-over verdict per round');
});

test('verdict: a start from another version of the game is refused, not played', () => {
  const s = new Session({ seat: 1, send: () => {}, onStart: () => assert.fail('built a game') });
  s.receive({ n: 1, seat: 0, msg: { t: 'start', cfg: { seed: 1, firing: 'volley' }, players: [{ name: 'Ana', seat: 0 }, { name: 'Bo', seat: 1 }] } });
  s.pump();
  assert.equal(s.over, OTHER_VERSION);
  assert.equal(s.game, null);
});

// ---------- a message the server will never take ends the match for everyone ----------

// A room server in memory, for RoomLink: `refuse(msg, log)` gives a status
// (or 'net' for no answer at all) instead of taking the message.
function fakeServer(room, refuse) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.msg);
    const status = refuse(body.msg, room.log);
    if (status === 'net') throw new TypeError('Failed to fetch');
    if (status) return reply(status, { error: `refused (${status})` });
    room.append(Number(body.token.slice(1)), body.msg);
    return reply(200, { n: room.log.length });
  };
  return { fetch, calls };
}

// A match on three screens, the host sending through a RoomLink to `fake`.
// Plays (yielding, so the link's sends and its backoff go on) until `until`,
// or for at most `seconds`.
async function playLinked(room, fake, until, seconds = 30) {
  const screens = ['Ana', 'Bo', 'Cy'].map((n, i) => makeScreen(room, i, n, { bot: { drive: 0.2 } }));
  const link = new RoomLink('http://test/api/rooms', { fetch: fake.fetch });
  Object.assign(link, { code: 'TEST', seat: 0, token: 's0' });
  link.onEntry = (e) => screens[0].session.receive(e);
  screens[0].session.send = (msg) => link.send(msg);
  run(screens, 3);
  screens[0].session.start({ rounds: 2, resolution: 48, maxTurnsPerRound: 3, seed: 6 }, [{ name: 'Rook', ai: 'easy' }]);
  const stop = Date.now() + seconds * 1000;
  for (let f = 0; Date.now() < stop; f++) {
    for (const s of screens) s.frame();
    await new Promise((r) => setImmediate(r));
    if (until(screens)) return { screens, link, frame: f };
  }
  return { screens, link, frame: -1 };
}

const allStopped = (screens) => screens.every((s) => s.session.over);

// Runs `fn` with console.error caught: { result, errors }.
async function quietly(fn) {
  const errors = [];
  const keep = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try { return { result: await fn(), errors }; } finally { console.error = keep; }
}

test('rejected send: the server refusing a message (400) ends the match on every screen with a connection problem', async () => {
  const room = makeRoom();
  const fake = fakeServer(room, (msg) => (msg.t === 'end' ? 400 : 0));
  const { result: r, errors } = await quietly(() => playLinked(room, fake, allStopped));
  assert.ok(r.frame >= 0, `not every screen stopped: ${r.screens.map((s) => s.session.over).join(' | ')}`);
  for (const s of r.screens) assert.match(s.session.over, /^Connection problem: the server refused a message \(end, 400/);
  assert.equal(room.log.filter((e) => e.msg.t === 'stop').length, 1);
  assert.equal(room.log.at(-1).msg.t, 'stop', 'the host sent on after the refusal');
  assert.equal(fake.calls.filter((m) => m.t === 'end').length, 1, 'the refused message was tried again');
  assert.ok(errors.some((e) => /refused a message \(end/.test(e)), 'nothing was logged');
});

test('rejected send: a full room log (507) stops every screen through the server\'s own stop', async () => {
  const room = makeRoom();
  let full = false;
  const fake = fakeServer(room, (msg, log) => {
    if (!full && log.filter((e) => e.msg.t === 'snap').length >= 2) { full = true; room.append(-1, { t: 'stop', why: "the room's log is full." }); }
    return full ? 507 : 0;
  });
  const { result: r } = await quietly(() => playLinked(room, fake, allStopped));
  assert.ok(r.frame >= 0, 'not every screen stopped');
  for (const s of r.screens.slice(1)) assert.equal(s.session.over, "Connection problem: the room's log is full.");
  assert.match(r.screens[0].session.over, /^Connection problem: /);
  assert.equal(room.log.filter((e) => e.msg.t === 'stop').length, 1);
});

test('rejected send: no answer, or the server busy (503), is sent again and the match plays on', async () => {
  const room = makeRoom();
  const tried = { snap: 0, end: 0 };
  const fake = fakeServer(room, (msg) => {
    if (msg.t === 'snap' && tried.snap++ === 0) return 503;
    if (msg.t === 'end' && tried.end++ === 0) return 'net';
    return 0;
  });
  const r = await playLinked(room, fake, (screens) => allOver(screens)());
  assert.ok(r.frame >= 0, `the match did not finish: ${where(r.screens)}`);
  assert.ok(r.screens.every((s) => !s.session.over));
  assert.equal(room.log.filter((e) => e.msg.t === 'stop').length, 0);
  assert.equal(tried.snap > 1 && tried.end > 1, true);
  const end = r.screens.map((s) => finalState(s.session.game));
  for (const e of end) assert.equal(e, end[0]);
});

test('rejected send: a message too large for the server is never posted; it ends the match at once', async () => {
  const room = makeRoom();
  const fake = fakeServer(room, () => 0);
  const link = new RoomLink('http://test/api/rooms', { fetch: fake.fetch });
  Object.assign(link, { code: 'TEST', seat: 0, token: 's0' });
  const got = [];
  link.onEntry = (e) => got.push(e.msg);
  await quietly(() => link.send({ t: 'say', text: 'x'.repeat(MAX_MESSAGE) }));
  assert.ok(!fake.calls.some((m) => m.t === 'say'));
  assert.equal(got[0]?.t, 'stop');
  assert.match(got[0].why, /a message was too large to send \(say, 128 KB\)/);
  await link.send({ t: 'plan' });
  assert.ok(!fake.calls.some((m) => m.t === 'plan'), 'sent on after failing');
  assert.equal(room.log.at(-1).msg.t, 'stop');
});

test('retryable: network failures and 5xx are sent again; refusals and a full room are not', () => {
  assert.ok(retryable(new TypeError('Failed to fetch')));
  for (const status of [500, 502, 503, 504]) assert.ok(retryable({ status }));
  for (const status of [400, 409, 413, 507]) assert.ok(!retryable({ status }));
});

// ---------- the states stay small ----------

test('snap size: a City round of 1,000 blasts packs every state well under the server\'s limit, and unpacks exactly', () => {
  const make = () => {
    const g = new Game({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C', ai: 'hard' }, { name: 'D', ai: 'normal' }], rounds: 2, seed: 9, resolution: 64, world: 'city', firing: 'volley', local: [0] });
    g.start();
    return g;
  };
  const g = make();
  const host = new Session({ seat: 0, send: () => {}, onStart: () => null });
  const guest = new Session({ seat: 1, send: () => {}, onStart: () => null });
  const dice = makeRng(5);
  const half = g.terrain.size / 2;
  const log = [];
  let biggest = 0;
  let whole = 0;
  for (let v = 0; v < 100; v++) {
    for (let k = 0; k < 10; k++) {
      const x = dice.range(-half * 0.8, half * 0.8), z = dice.range(-half * 0.8, half * 0.8);
      g.applyEffect({ type: 'blast', point: [x, g.terrain.heightAt(x, z), z], radius: dice.range(4, 10), damage: 30, depth: dice.range(1, 4) }, null, null, 0);
      for (const p of g.players) { p.alive = true; p.hp = 100; }
    }
    g.turnsThisRound = v;
    // A snap before the volley and the host's verdict after it, as in a match.
    for (const t of ['snap', 'end']) {
      const state = g.snapshot();
      whole = JSON.stringify(state).length;
      const msg = { t, key: g.volleyKey, ...(t === 'end' ? { over: false } : {}), state: host.pack(state) };
      biggest = Math.max(biggest, JSON.stringify({ token: 'x'.repeat(32), msg }).length);
      const entry = { n: log.length + 1, seat: 0, msg: JSON.parse(JSON.stringify(msg)) };
      log.push(entry);
      guest.receive(entry);
    }
  }
  assert.ok(g.ground.ops.length >= 2000, `only ${g.ground.ops.length} ops`);
  assert.ok(whole > 128 * 1024, `the whole state (${whole} bytes) was not over the limit: nothing to prove`);
  assert.ok(biggest < 24 * 1024, `a packed state was ${biggest} bytes`);
  // The guest put every state back together: the last is the host's to the bit.
  const last = guest.inbox.at(-1).msg.state;
  assert.deepEqual(last.ground, JSON.parse(JSON.stringify(g.ground)));
  assert.deepEqual(last.city, g.town.state());
  // So does a screen reading the whole log after a reload, and its ground is the host's.
  const back = new Session({ seat: 1, send: () => {}, onStart: () => null, resume: true });
  for (const e of log) back.receive(JSON.parse(JSON.stringify(e)));
  const copy = make();
  copy.restore(back.inbox.at(-1).msg.state);
  assert.deepEqual(Array.from(copy.terrain.heights), Array.from(g.terrain.heights));
  assert.deepEqual(copy.town.state(), g.town.state());
});

test('snap size: a state a screen cannot put back together ends its match instead of desyncing', () => {
  const s = new Session({ seat: 1, send: () => {}, onStart: () => null });
  s.receive({ n: 5, seat: 0, msg: { t: 'snap', key: '1.3', state: { round: 1, ground: { from: 12, ops: [] }, city: null } } });
  assert.match(s.over, /^Connection problem: /);
  assert.equal(s.inbox.length, 0);
});
