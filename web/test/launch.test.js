// The launch screen's pure parts: what Play starts, and what Custom remembers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMatch, loadCustom, saveCustom, CUSTOM_KEY } from '../src/launch.js';

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('Play starts you against two Normal CPUs with the default options', () => {
  const m = defaultMatch('Ana');
  assert.deepEqual(m.players.map((p) => [p.name, p.ai]), [['Ana', null], ['Rook', 'normal'], ['Vex', 'normal']]);
  assert.equal(m.rounds, 3);
  assert.equal(m.maxWind, 1.5);
  assert.equal(m.hills, 45);
  assert.equal(m.world, 'meadow');
  assert.equal(m.firing, 'volley');
  assert.equal(m.twists, true);
  assert.equal(m.fog, false);
  assert.deepEqual(m.lab, { satellite: 'shop', level: 1, labels: 'some' });
  assert.equal(defaultMatch('').players[0].name, 'You');
});

test('Custom starts shut with nothing remembered', () => {
  assert.deepEqual(loadCustom(store()), { open: false, opts: {}, cpus: null });
});

test('Custom round-trips open, options and CPU rows', () => {
  const s = store();
  saveCustom(s, { open: true, opts: { 'opt-rounds': '5', 'opt-fog': '1' }, cpus: [{ name: 'Vex', type: 'hard' }] });
  const c = loadCustom(s);
  assert.equal(c.open, true);
  assert.deepEqual(c.opts, { 'opt-rounds': '5', 'opt-fog': '1' });
  assert.deepEqual(c.cpus, [{ name: 'Vex', type: 'hard' }]);
});

test('damaged or hostile saved state is ignored piece by piece', () => {
  assert.deepEqual(loadCustom(store({ [CUSTOM_KEY]: '{not json' })), { open: false, opts: {}, cpus: null });
  const c = loadCustom(store({ [CUSTOM_KEY]: JSON.stringify({
    open: 'yes',
    opts: { 'opt-wind': '0', 'evil': 'x', 'opt-hills': 5 },
    cpus: [{ name: 'A', type: 'human' }, { name: 'B', type: 'easy' }, 7, { name: 9, type: 'easy' }],
  }) }));
  assert.equal(c.open, false);
  assert.deepEqual(c.opts, { 'opt-wind': '0' });
  assert.deepEqual(c.cpus, [{ name: 'B', type: 'easy' }]);
});

test('at most five CPU rows come back (six tanks with you)', () => {
  const cpus = Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, type: 'normal' }));
  assert.equal(loadCustom(store({ [CUSTOM_KEY]: JSON.stringify({ cpus }) })).cpus.length, 5);
});
