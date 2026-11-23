import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEAPONS, ITEMS } from '../src/core/weapons.js';
import { PERKS, MODIFIERS } from '../src/core/perks.js';
import { MODS } from '../src/core/mods.js';
import {
  summarize, fnSummary, compactJson, pickColumns, buildTable, buildCatalog, buildNumbers, flatten,
  filterRows, filterGroups, sortRows, matchCount, totalCount, cpuWeaponUse, cpuPerkScores, AI_BUYS, textOf,
} from '../src/catalog.js';

test('summarize never throws, and prints functions, typed parts and objects compactly', () => {
  const cyc = { a: 1 }; cyc.self = cyc;
  const odd = [undefined, null, 0, -0, NaN, Infinity, 'x', true, 10n, Symbol('s'), () => 1, function named() {}, class K {}, [], {}, [1, 2], [{ a: 1 }, 'b'], cyc,
    new Map([[1, 2]]), new Set([1]), new Date(0), Object.create(null), { type: 'blast', radius: 11, damage: 38 }, { f() { return 1; }, n: Infinity }];
  for (const v of odd) assert.equal(typeof summarize(v), 'string');
  assert.equal(summarize(undefined), '');
  assert.equal(summarize([1, 2, 3]), '1 / 2 / 3');
  assert.equal(summarize({ type: 'blast', radius: 11, damage: 38 }), 'blast(radius: 11, damage: 38)');
  assert.equal(summarize({ a: 1, b: [2] }), '{"a":1,"b":[2]}');
  assert.equal(fnSummary(function named() {}), 'named()');
  const anon = [(x) => {
    return x + 1;
  }][0];
  assert.match(fnSummary(anon), /^ƒ \(x\) => \{ return x \+ 1; \}$/);
  assert.ok(fnSummary(new Function('a', `return a${' + 1'.repeat(100)}`)).length <= 95);
  assert.match(compactJson({ n: Infinity, f: () => 1 }), /Infinity/);
  assert.equal(typeof compactJson(cyc), 'string');
  assert.ok(summarize(cyc).length > 0);
});

test('columns: lead fields first, a field most entries share is promoted, the rest land in "other"', () => {
  const entries = [{ id: 'a', name: 'A', cost: 1, x: 1 }, { id: 'b', name: 'B', cost: 2, y: { z: 1 } }, { id: 'c', name: 'C', cost: 3 }, { id: 'd', name: 'D', cost: 4 }];
  const cols = pickColumns(entries, { columns: ['id', 'name', 'missing'] });
  assert.deepEqual(cols.map((c) => c.key), ['id', 'name', 'cost', 'other']);
  assert.deepEqual(cols.at(-1).other, ['x', 'y']);
  const t = buildTable('t', 'T', entries, { columns: ['id', 'name'] });
  assert.equal(t.rows[1].cells.other.text, 'y: {"z":1}');
  assert.equal(t.rows[0].cells.other.text, 'x: 1');
  assert.deepEqual(buildTable('t', 'T', [], {}).rows, []);
  assert.equal(buildTable('t', 'T', [null, 5, { id: 'ok' }]).rows.length, 1);
});

test('every table builds a row for every entry, with a text cell in every column', () => {
  const tabs = buildCatalog();
  assert.deepEqual(tabs.map((t) => t.id), ['weapons', 'items', 'perks', 'mods', 'modifiers', 'numbers']);
  const sources = { weapons: WEAPONS, items: ITEMS, perks: PERKS, mods: MODS, modifiers: MODIFIERS };
  for (const tab of tabs) {
    if (tab.kind === 'numbers') continue;
    const src = sources[tab.id];
    assert.equal(tab.rows.length, src.length, tab.id);
    assert.equal(new Set(tab.rows.map((r) => r.id)).size, src.length, `${tab.id} ids are unique`);
    for (const row of tab.rows) {
      for (const c of tab.columns) {
        const x = row.cells[c.key];
        assert.ok(x && typeof x.text === 'string' && Array.isArray(x.parts), `${tab.id}/${row.id}/${c.key}`);
        assert.equal(textOf(x.parts), x.text);
      }
    }
  }
});

test('no field of any entry is lost: it is a column, or in "other"', () => {
  const sources = { weapons: WEAPONS, items: ITEMS, perks: PERKS, mods: MODS, modifiers: MODIFIERS };
  // perks show these through their own derived columns (needs, links)
  const derived = { perks: ['mods', 'unlock', 'levelUp', 'stack', 'fromRound', 'needsMod', 'roundAmmo'] };
  for (const tab of buildCatalog()) {
    if (tab.kind === 'numbers') continue;
    const shown = new Set(tab.columns.flatMap((c) => (c.other ? c.other : [c.key])));
    for (const e of sources[tab.id]) for (const k of Object.keys(e)) assert.ok(shown.has(k) || (derived[tab.id] || []).includes(k), `${tab.id}.${k}`);
  }
});

test('cross-links point at rows that exist', () => {
  const tabs = Object.fromEntries(buildCatalog().map((t) => [t.id, t]));
  let links = 0;
  for (const tab of Object.values(tabs)) {
    if (tab.kind === 'numbers') continue;
    for (const row of tab.rows) for (const x of Object.values(row.cells)) for (const p of x.parts) {
      if (typeof p === 'string') continue;
      links++;
      assert.ok(tabs[p.tab].rows.some((r) => r.id === p.id), `${tab.id}/${row.id} -> ${p.tab}/${p.id}`);
    }
  }
  assert.ok(links > 10);
  const orbital = tabs.perks.rows.find((r) => r.id === 'orbital');
  assert.ok(orbital.cells.links.parts.some((p) => p.tab === 'mods' && p.id === 'orbiter'));
  assert.match(tabs.perks.rows.find((r) => r.id === 'orbitalup').cells.needs.text, /below its top level/);
  assert.ok(tabs.mods.rows.find((r) => r.id === 'orbiter').cells.perks.parts.some((p) => p.id === 'orbitalup'));
});

test('numbers: constants from the core files, flattened', () => {
  const n = buildNumbers();
  const names = n.groups.map((g) => g.name);
  for (const k of ['PAY', 'VOLLEY', 'FOG', 'STRIKE', 'AI_DEPLOY', 'DEPLOY_STYLES', 'DIFFICULTY', 'TANK', 'JET', 'SURVEY', 'ROLL', 'ORBIT', 'SKY', 'MOD_DRAFT']) assert.ok(names.includes(k), k);
  for (const k of ['WEAPONS', 'PERKS', 'MODS', 'ITEMS', 'MODIFIERS']) assert.ok(!names.includes(k), k);
  const diff = n.groups.find((g) => g.name === 'DIFFICULTY');
  assert.ok(diff.rows.some((r) => r.key === 'normal.orbit.clock' && r.value === '0.35 / 0.5 / 0.7'));
  assert.equal(n.groups.find((g) => g.name === 'ROLL').file, 'src/core/ballistics.js');
  assert.deepEqual(flatten({ a: { b: [1, 2] }, c: [{ d: 1 }] }), [['a.b', '1 / 2'], ['c.0.d', '1']]);
  assert.deepEqual(flatten(null), [['', '']]);
  assert.deepEqual(buildNumbers([['x.js', { OK: 1, lower: 2, F: () => 1, U: undefined }]]).groups.map((g) => g.name), ['OK']);
});

test('search and sort', () => {
  const tabs = Object.fromEntries(buildCatalog().map((t) => [t.id, t]));
  assert.equal(filterRows(tabs.weapons.rows, '').length, WEAPONS.length);
  assert.deepEqual(filterRows(tabs.weapons.rows, 'FLAK').map((r) => r.id).sort(), ['flak', 'flaklet']);
  assert.equal(filterRows(tabs.weapons.rows, 'flak zzzz').length, 0);
  assert.ok(matchCount(tabs.numbers, 'orbit') > 0 && matchCount(tabs.numbers, 'orbit') <= totalCount(tabs.numbers));
  assert.ok(filterGroups(tabs.numbers.groups, 'tank.js').some((g) => g.name === 'TANK'));
  const byPrice = sortRows(tabs.weapons.rows, 'price', 1).map((r) => r.entry.price);
  const priced = byPrice.filter((p) => p != null);
  assert.deepEqual(priced, [...priced].sort((a, b) => a - b));
  assert.equal(byPrice.at(-1), undefined, 'rows with no price sort last');
  assert.equal(sortRows(tabs.weapons.rows, 'price', -1)[0].entry.price, Math.max(...priced));
  assert.equal(sortRows(tabs.weapons.rows, null).length, WEAPONS.length);
  sortRows(tabs.perks.rows, 'cpu');
  sortRows(tabs.perks.rows, 'nonexistent');
});

test('what the CPUs do is read from ai.js and perks.js, not written down twice', () => {
  assert.ok(cpuWeaponUse('breacher').first > 0.3);
  assert.equal(cpuWeaponUse('mound').first > 0, true, 'a Mound comes up, but only in a hole or under fire');
  assert.deepEqual(cpuWeaponUse('mound').when, ['in a hole', 'under fire']);
  assert.deepEqual(cpuWeaponUse('guided').when, ['offline']);
  assert.deepEqual(cpuWeaponUse('breacher').when, ['always']);
  assert.equal(cpuWeaponUse('no-such-weapon').first, 0);
  const { scores, never } = cpuPerkScores();
  assert.ok(!never.has('satrecon'), 'CPUs draft the satellite now');
  assert.equal(never.size, 0);
  assert.ok(scores.hull > scores.haggler);
  // game.js keeps the CPU shopping list in a local: the copy here must match it
  const src = readFileSync(new URL('../src/core/game.js', import.meta.url), 'utf8');
  const m = src.match(/const wishlist = (\[[^\]]*\])/);
  assert.ok(m, 'aiShop wishlist found');
  assert.deepEqual(AI_BUYS, JSON.parse(m[1].replace(/'/g, '"')));
});
