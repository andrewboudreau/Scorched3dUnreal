// The time of day: the builder option, ?time=, Random picking from the seed,
// the config carrying through, and the presets (plain data, no three.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { Session } from '../src/core/netplay.js';
import { TIMES, TIME_IDS, DEFAULT_TIME, pickTime, resolveTime } from '../src/core/timeofday.js';
import { matchTime, parseTestParams, conditionsLabel, matchConditions } from '../src/builder.js';
import { PRESETS, look, setLook } from '../src/render/timeofday.js';

const players = [{ name: 'a' }, { name: 'b' }];

test('the choices are Dawn, Day, Dusk and Night', () => {
  assert.deepEqual(TIME_IDS, ['dawn', 'day', 'dusk', 'night']);
  assert.deepEqual(TIMES.map((t) => t.name), ['Dawn', 'Day', 'Dusk', 'Night']);
});

test('?time= is read, and unknown words are ignored', () => {
  assert.deepEqual(parseTestParams('?time=night'), { time: 'night' });
  assert.deepEqual(parseTestParams('?time=Dusk&terrain=city'), { terrain: 'city', time: 'dusk' });
  assert.deepEqual(parseTestParams('?time=midnight'), {});
  assert.deepEqual(parseTestParams('?time=random'), {}, 'random is the select, not a forced time');
});

test('the Time of day select becomes the config value; the query string beats it', () => {
  assert.equal(matchTime(), 'random');
  assert.equal(matchTime('random'), 'random');
  assert.equal(matchTime('dawn'), 'dawn');
  assert.equal(matchTime('night', {}), 'night');
  assert.equal(matchTime('dawn', { time: 'dusk' }), 'dusk');
  assert.equal(matchTime('nonsense'), 'random');
  assert.equal(matchTime('random', parseTestParams('?time=day')), 'day');
});

test('matchConditions is unchanged by the time (it is its own option)', () => {
  assert.deepEqual(matchConditions({ wind: '0', terrain: '20' }), { maxWind: 0, hills: 20, world: 'meadow' });
});

test('Random picks from the seed alone: the same seed, the same time, and every time comes up', () => {
  for (const seed of [1, 7, 12345, 987654321]) assert.equal(pickTime(seed), pickTime(seed));
  const seen = new Set();
  for (let seed = 0; seed < 400; seed++) seen.add(pickTime(seed));
  assert.deepEqual([...seen].sort(), [...TIME_IDS].sort());
  const days = Array.from({ length: 2000 }, (_, i) => pickTime(i * 7919 + 3)).filter((t) => t === 'day').length;
  assert.ok(days > 600 && days < 1000, `Day is about two in five (${days} of 2000)`);
});

test('resolveTime keeps an id, rolls random from the seed, and defaults to Day', () => {
  assert.equal(resolveTime('night', 5), 'night');
  assert.equal(resolveTime('random', 5), pickTime(5));
  assert.equal(resolveTime(undefined, 5), DEFAULT_TIME);
  assert.equal(resolveTime('bogus', 5), DEFAULT_TIME);
});

test('the Game carries the time in its config; Random is settled by the seed', () => {
  assert.equal(new Game({ players, seed: 9, time: 'dusk' }).cfg.time, 'dusk');
  assert.equal(new Game({ players, seed: 9 }).cfg.time, 'day', 'no time given: the plain Day');
  assert.equal(new Game({ players, seed: 9, time: 'random' }).cfg.time, pickTime(9));
  const seeds = Array.from({ length: 40 }, (_, i) => i);
  assert.deepEqual(seeds.map((seed) => new Game({ players, seed, time: 'random' }).cfg.time), seeds.map(pickTime));
  assert.equal(new Game({ players, seed: 9, time: 'moonrise' }).cfg.time, 'day');
});

test('the time is render-only: the same seed plays the same game at any time of day', () => {
  const a = new Game({ players, seed: 4242, time: 'day' });
  const b = new Game({ players, seed: 4242, time: 'night' });
  a.start(); b.start();
  assert.deepEqual(Array.from(a.terrain.heights.slice(0, 300)), Array.from(b.terrain.heights.slice(0, 300)));
  assert.deepEqual(a.wind, b.wind);
  assert.deepEqual(a.players.map((p) => [p.x, p.z]), b.players.map((p) => [p.x, p.z]));
  assert.equal(a.rng.state(), b.rng.state(), 'no game dice are spent on it');
});

test('online, the host starts a Random match and every screen agrees on the time', () => {
  const log = [];
  const games = [];
  const mk = (seat) => new Session({
    seat,
    send: (msg) => log.push(JSON.parse(JSON.stringify(msg))),
    onStart: (cfg) => { const g = new Game(cfg); games.push(g); return g; },
  });
  const host = mk(0), guest = mk(1);
  host.receive({ n: 1, seat: -1, msg: { t: 'join', seat: 0, name: 'Ana' } });
  guest.receive({ n: 1, seat: -1, msg: { t: 'join', seat: 0, name: 'Ana' } });
  host.start({ rounds: 1, seed: 31337, time: 'random' }, [{ name: 'Rook', ai: 'normal' }]);
  const start = log.find((m) => m.t === 'start');
  assert.equal(start.cfg.time, 'random', 'the message carries the choice');
  host.receive({ n: 2, seat: 0, msg: start }); host.pump();
  guest.receive({ n: 2, seat: 0, msg: start }); guest.pump();
  assert.equal(games.length, 2);
  assert.equal(games[0].cfg.time, games[1].cfg.time);
  assert.equal(games[0].cfg.time, pickTime(31337));
});

test('the round banner names a dawn, dusk or night, and leaves the plain Day unsaid', () => {
  const base = { maxWind: 1.5, hills: 45, world: 'meadow' };
  assert.equal(conditionsLabel({ ...base, time: 'day' }), 'Hilly · Gusty wind');
  assert.equal(conditionsLabel(base), 'Hilly · Gusty wind');
  assert.equal(conditionsLabel({ ...base, time: 'dusk' }), 'Hilly · Gusty wind · Dusk');
  assert.equal(conditionsLabel({ ...base, time: 'night' }), 'Hilly · Gusty wind · Night');
});

test('every time has a full preset, and Night is playable', () => {
  const keys = ['sun', 'sunI', 'sky', 'ground', 'hemiI', 'top', 'mid', 'horizon', 'cloud', 'fog'];
  for (const id of TIME_IDS) {
    const p = PRESETS[id];
    assert.equal(p.id, id);
    for (const f of [p.a, p.b]) for (const k of keys) assert.ok(f[k] != null, `${id}.${k}`);
    for (const k of ['elev', 'azim', 'glow', 'bottom', 'fogNear', 'fogFar', 'shadow', 'water', 'cloudGlow', 'wet', 'lit', 'flash', 'shade']) assert.ok(p[k] != null, `${id}.${k}`);
    assert.ok(p.fogNear < p.fogFar);
    assert.ok(p.shadow > 0 && p.shadow <= 1);
  }
  const n = PRESETS.night;
  assert.ok(n.a.hemiI + n.a.sunI >= 1.5, 'enough light to read the terrain');
  assert.equal(n.lit, 1);
  assert.ok(n.flash > PRESETS.day.flash, 'a blast flashes harder in the dark');
  assert.ok(n.shadow < PRESETS.day.shadow, 'softer shadows by moonlight');
  assert.equal(PRESETS.day.lit, 0);
  assert.ok(PRESETS.dusk.lit > 0 && PRESETS.dusk.lit < 1);
});

test('setLook switches the shared look, and an unknown id is Day', () => {
  setLook('night');
  assert.equal(look.id, 'night');
  assert.equal(look.lit.value, 1);
  setLook('nope');
  assert.equal(look.id, 'day');
  assert.equal(look.lit.value, 0);
});
