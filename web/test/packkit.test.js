import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessEvent, kindOf, groupOf, soundFiles, packUrl, summarizePicks } from '../src/packkit.js';

test('packs: the cc0-sfx-core names map to the right game events', () => {
  const want = {
    'cannon-fire-2': 'fire', 'explosion-small-1': 'explode-small', 'explosion-medium-3': 'explode-medium',
    'explosion-big-4': 'explode-big', 'explosion-distant-1': 'explode-far', 'earth-impact-2': 'impact',
    'metal-clank-heavy-1': 'wreck', 'metal-thud-heavy-2': 'wreck', 'metal-debris-small-3': 'hit',
    'shell-whoosh-2': 'whoosh', 'jumpjet-burst-1': 'jet', 'teleport-zap-1': 'warp', 'ui-click-1': 'click',
    'ui-confirm-1': null, 'coin-1': null,
  };
  for (const [id, ev] of Object.entries(want)) assert.equal(guessEvent({ id }), ev, id);
});

test('packs: kinds, groups, files and urls', () => {
  assert.equal(kindOf('sfx'), 'sound');
  assert.equal(kindOf('hdri'), 'sky');
  assert.equal(kindOf('font'), 'image');
  assert.equal(groupOf({ id: 'explosion-big-3' }), 'explosion-big');
  assert.equal(groupOf({ id: 'x', mood: 'dusk' }), 'dusk');
  assert.deepEqual(soundFiles({ file: 'audio/a.ogg', fallback: 'audio/a.mp3' }), ['audio/a.ogg', 'audio/a.mp3']);
  assert.equal(packUrl({ id: 'p', dir: 'my pack' }, 'audio/a b.ogg'), 'packs/my%20pack/audio/a%20b.ogg');
});

test('packs: picks summary lists keeps, drops and event use', () => {
  const s = summarizePicks({ a: { x: 'keep', y: 'drop', z: 'keep' }, b: {} }, { fire: ['a/x'], jet: [] });
  assert.deepEqual(s, { packs: { a: { keep: ['x', 'z'], drop: ['y'] } }, events: { fire: ['a/x'] } });
});
