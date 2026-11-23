// The launch screen's pure parts: what Play starts, and what Custom remembers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMatch, loadCustom, saveCustom, CUSTOM_KEY, CUSTOM_VERSION } from '../src/launch.js';
import { PERKS, MODIFIERS } from '../src/core/perks.js';

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const noneOff = { weapons: [], perks: [], modifiers: [] };
const saved = (obj) => store({ [CUSTOM_KEY]: JSON.stringify(obj) });

test('Play starts you against two Normal CPUs with the default options', () => {
  const m = defaultMatch('Ana', { maxWind: 2.5, hills: 45, world: 'isles' });
  assert.deepEqual(m.players.map((p) => [p.name, p.ai]), [['Ana', null], ['Rook', 'normal'], ['Vex', 'normal']]);
  assert.equal(m.rounds, 3);
  assert.equal(m.maxWind, 2.5, 'the rolled wind');
  assert.equal(m.world, 'isles', 'the rolled terrain');
  assert.equal(m.firing, 'volley');
  assert.equal(m.fog, false);
  assert.equal(m.twists, undefined, 'no Twists switch any more');
  assert.deepEqual([m.weapons, m.perks, m.modifiers], [null, null, null], 'everything on');
  assert.deepEqual(m.lab, { satellite: 'perk', level: 1, labels: 'some', orbiter: 'perk', orbiterLevel: 1 }, 'mods come from the perk draft');
  assert.equal(defaultMatch('').players[0].name, 'You');
  assert.ok(Number.isFinite(defaultMatch('').maxWind), 'rolled when not given');
  assert.deepEqual(defaultMatch('', undefined, { satellite: 'all', level: 2 }).lab.satellite, 'all', 'the testing query string can hand out mods');
});

test('Custom starts shut with nothing remembered', () => {
  assert.deepEqual(loadCustom(store()), { tab: 'custom', opts: {}, cpus: null, off: noneOff });
});

test('Custom round-trips the tab, options, CPU rows and what is off', () => {
  const s = store();
  const off = { weapons: ['flak', 'scout'], perks: ['double'], modifiers: ['gale'] };
  saveCustom(s, { tab: 'online', opts: { 'opt-rounds': '5', 'opt-fog': '1', 'opt-wind': '1.5' }, cpus: [{ name: 'Vex', type: 'hard' }], off });
  assert.equal(JSON.parse(s.getItem(CUSTOM_KEY)).v, CUSTOM_VERSION);
  const c = loadCustom(s);
  assert.equal(c.tab, 'online');
  assert.deepEqual(c.opts, { 'opt-rounds': '5', 'opt-fog': '1', 'opt-wind': '1.5' }, 'a chosen Gusty is kept now');
  assert.deepEqual(c.cpus, [{ name: 'Vex', type: 'hard' }]);
  assert.deepEqual(c.off, off);
});

test('damaged or hostile saved state is ignored piece by piece', () => {
  assert.deepEqual(loadCustom(store({ [CUSTOM_KEY]: '{not json' })), { tab: 'custom', opts: {}, cpus: null, off: noneOff });
  const c = loadCustom(saved({
    v: CUSTOM_VERSION,
    tab: 'yes',
    opts: { 'opt-wind': '0', 'evil': 'x', 'opt-hills': 5 },
    cpus: [{ name: 'A', type: 'human' }, { name: 'B', type: 'easy' }, 7, { name: 9, type: 'easy' }],
    off: { weapons: ['shell', 'nuke', 'flak', 7], perks: 'all', modifiers: ['soft', 'soft'] },
  }));
  assert.equal(c.tab, 'custom');
  assert.deepEqual(c.opts, { 'opt-wind': '0' });
  assert.deepEqual(c.cpus, [{ name: 'B', type: 'easy' }]);
  assert.deepEqual(c.off, { weapons: ['flak'], perks: [], modifiers: ['soft'] }, 'unknown ids and the Shell are dropped');
});

test('an old save: Twists Off turns every perk and modifier off; the Lab and the old defaults go', () => {
  const c = loadCustom(saved({ v: 2, opts: { 'opt-twists': '0', 'opt-sat': 'all2', 'opt-orbiter': 'shop', 'opt-sat-labels': 'many', 'opt-wind': '1.5', 'opt-hills': '45', 'opt-rounds': '5' } }));
  assert.deepEqual(c.opts, { 'opt-rounds': '5' }, 'Gusty and Hilly were the defaults then: Random now');
  assert.deepEqual(new Set(c.off.perks), new Set(PERKS.map((p) => p.id)));
  assert.deepEqual(new Set(c.off.modifiers), new Set(MODIFIERS.map((m) => m.id)));
  assert.deepEqual(c.off.weapons, []);
  const on = loadCustom(saved({ v: 2, opts: { 'opt-twists': '1', 'opt-wind': '2.5', 'opt-hills': 'isles' } }));
  assert.deepEqual(on.off, noneOff);
  assert.deepEqual(on.opts, { 'opt-wind': '2.5', 'opt-hills': 'isles' }, 'a real choice is kept');
});

test('an old save: a Lab Off unticks that mod\'s perk cards; shop and all fall back to the cards', () => {
  const c = loadCustom(saved({ opts: { 'opt-sat': 'off', 'opt-orbiter': 'all3' } }));
  assert.deepEqual(c.off.perks.sort(), ['satrecon', 'satrecon2']);
  const o = loadCustom(saved({ v: 2, opts: { 'opt-orbiter': 'off', 'opt-sat': 'shop' } }));
  assert.deepEqual(o.off.perks.sort(), ['orbital', 'orbitalup']);
  assert.deepEqual(o.opts, {});
});

test('at most five CPU rows come back (six tanks with you)', () => {
  const cpus = Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, type: 'normal' }));
  assert.equal(loadCustom(saved({ cpus })).cpus.length, 5);
});
