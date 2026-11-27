// Which sound a game event asks for (src/sfxmap.js), and that every sound it
// names is in the audio table with its files on disk (src/audio.js, sfx/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { cuesFor, runCues, offerCue } from '../src/sfxmap.js';
import { CUES, DEFAULT_SAMPLES } from '../src/audio.js';

const sfx = (n, ext) => new URL(`../sfx/${n}.${ext}`, import.meta.url);
const names = (list) => list.map((c) => c.cue);

test('boss events: a phase sting, a mark (louder on a local human), a weak-spot ping', () => {
  assert.deepEqual(names(cuesFor({ type: 'bossPhase', phase: 2 })), ['bossPhase']);
  const mine = (id) => id === 1;
  assert.equal(cuesFor({ type: 'bossMark', target: 1 }, { mine })[0].gain, 1.3);
  assert.equal(cuesFor({ type: 'bossMark', target: 2 }, { mine })[0].gain, 0.7);
  assert.deepEqual(cuesFor({ type: 'bossMark', clear: true }), []);
  const w = cuesFor({ type: 'weakSpot', pos: [1, 2, 3] })[0];
  assert.equal(w.cue, 'weakSpot');
  assert.deepEqual(w.pos, [1, 2, 3]);
});

test('mod events: deploy and shot down are heard where they happen, a decoy only by its owner', () => {
  const at = () => [5, 6, 7];
  const mine = (id) => id === 0;
  assert.deepEqual(cuesFor({ type: 'mod', what: 'deploy', player: 1, mod: 'satellite' }, { at, mine }), [{ cue: 'deploy', pos: [5, 6, 7] }]);
  assert.deepEqual(names(cuesFor({ type: 'mod', what: 'down', player: 1, mod: 'pointdef', pos: [1, 1, 1] }, { at, mine })), ['modDown']);
  assert.deepEqual(cuesFor({ type: 'mod', what: 'down', player: 1, mod: 'pointdef', tank: true }, { at, mine }), []);   // the tank's own death has its blast
  assert.deepEqual(cuesFor({ type: 'mod', what: 'deploy', player: 1, mod: 'decoy' }, { at, mine }), []);
  assert.deepEqual(names(cuesFor({ type: 'mod', what: 'deploy', player: 0, mod: 'decoy' }, { at, mine })), ['deploy']);
  assert.deepEqual(cuesFor({ type: 'mod', what: 'expire', player: 0, mod: 'orbiter' }, { at, mine }), []);
  assert.deepEqual(names(cuesFor({ type: 'intercept', pos: [1, 2, 3], from: [4, 5, 6] })), ['intercept']);
  assert.deepEqual(cuesFor({ type: 'intercept', pos: [1, 2, 3], from: [4, 5, 6] })[0].pos, [4, 5, 6]);
});

test('the decoy blink sounds only when armed, and only for its owner', () => {
  const mine = (id) => id === 0;
  assert.deepEqual(names(cuesFor({ type: 'blink', player: 0, armed: true }, { mine })), ['blink']);
  assert.deepEqual(cuesFor({ type: 'blink', player: 0, armed: false }, { mine }), []);
  assert.deepEqual(cuesFor({ type: 'blink', player: 1, armed: true }, { mine }), []);
  assert.deepEqual(cuesFor({ type: 'blink', player: null, armed: true }, { mine }), []);
});

test('a split: Flak bursts and ticks, the rest pop and their children land as thuds', () => {
  const flak = cuesFor({ type: 'split', pos: [0, 9, 0], airburst: true })[0];
  assert.equal(flak.cue, 'flak');
  assert.deepEqual(flak.cluster, { kind: 'frag', n: 12 });
  const scatter = cuesFor({ type: 'split', pos: [0, 9, 0] })[0];
  assert.equal(scatter.cue, 'pop');
  assert.deepEqual(scatter.cluster, { kind: 'thud', n: 6 });
  assert.equal(cuesFor({ type: 'split', pos: [0, 1, 0], thrown: true })[0].cluster.n, 3);
});

test('events with their own sound elsewhere ask for nothing here', () => {
  for (const type of ['fire', 'explosion', 'damage', 'destroyed', 'turn', 'projectile']) assert.deepEqual(cuesFor({ type }), []);
});

test('after a run fight: the hull, then the reward or the end', () => {
  const items = [{ kind: 'money' }, { kind: 'ammo' }, { kind: 'point' }];
  const win = runCues({ won: true, hullLost: false, over: null }, items);
  assert.deepEqual(names(win), ['coin', 'ammo', 'skill']);
  assert.ok(win[0].delay < win[1].delay && win[1].delay < win[2].delay);
  assert.deepEqual(names(runCues({ won: false, hullLost: true, over: null })), ['hull']);
  assert.deepEqual(names(runCues({ won: false, hullLost: true, over: 'lost' })), ['hull', 'runOver']);
  assert.ok(runCues({ won: false, hullLost: true, over: 'lost' })[1].delay > 0);
  assert.deepEqual(names(runCues({ won: true, hullLost: false, over: 'won' })), ['runWon']);
  assert.deepEqual(runCues({ won: false, hullLost: false, over: null }), []);
});

test('a cache offer taken has its reward sound', () => {
  assert.equal(offerCue('rank'), 'skill');
  assert.equal(offerCue('money'), 'coin');
  assert.equal(offerCue('ammo'), 'ammo');
  assert.equal(offerCue('nope'), null);
});

test('every cue sfxmap can ask for is in the audio table with a sample', () => {
  const asked = new Set([
    ...['bossPhase', 'bossMark', 'weakSpot', 'intercept', 'blink', 'flak', 'pop'],
    ...runCues({ won: true, hullLost: true, over: null }, [{ kind: 'money' }, { kind: 'ammo' }, { kind: 'point' }]).map((c) => c.cue),
    'runWon', 'runOver', 'stop', 'go', 'deploy', 'modDown',
    ...['rank', 'money', 'ammo'].map(offerCue),
  ]);
  for (const cue of asked) {
    assert.ok(CUES[cue], `${cue} is in CUES`);
    assert.ok(DEFAULT_SAMPLES[cue]?.length, `${cue} has a sample`);
  }
  for (const k of ['scatter', 'frag', 'click']) assert.ok(DEFAULT_SAMPLES[k]?.length, k);
});

test('every built-in sample is on disk as .ogg and .mp3, and the sounds stay small', () => {
  let bytes = 0;
  const seen = new Set();
  for (const list of Object.values(DEFAULT_SAMPLES)) {
    for (const n of list) {
      if (seen.has(n)) continue;
      seen.add(n);
      for (const ext of ['ogg', 'mp3']) {
        assert.ok(existsSync(sfx(n, ext)), `sfx/${n}.${ext}`);
        bytes += statSync(sfx(n, ext)).size;
      }
    }
  }
  assert.ok(bytes < 450 * 1024, `${bytes} bytes of sounds`);
});
