import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, ITEMS } from '../src/core/weapons.js';
import { MODS } from '../src/core/mods.js';
import { PERKS } from '../src/core/perks.js';
import { firstSentence, weaponRows, modRows, perkRows, familyRows, labRows, guideTabs, renderBlocks, rich } from '../src/guide.js';

test('firstSentence takes one line and trims long ones', () => {
  assert.equal(firstSentence('Heavy round. Wide crater.'), 'Heavy round.');
  assert.equal(firstSentence('No full stop here'), 'No full stop here');
  assert.equal(firstSentence(undefined), '');
  assert.ok(firstSentence('word '.repeat(60), 40).length <= 40);
});

test('weaponRows lists the sale weapons, with prices, and skips hidden or nameless ones', () => {
  const rows = weaponRows(WEAPONS);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('Shell') && names.includes('Flak'));
  assert.ok(!names.includes('Scatterlet') && !names.includes('Flak fragment'));
  assert.equal(rows.find((r) => r.name === 'Shell').meta, 'free');
  assert.equal(rows.find((r) => r.name === 'Guided Missile').meta, '$90 for 2');
  assert.deepEqual(weaponRows([{ id: 'x' }, null, 7, { name: '  ' }]), []);
  assert.deepEqual(weaponRows(undefined), []);
});

test('modRows and perkRows tolerate missing fields', () => {
  const mods = modRows([...MODS, { name: 'Bare' }, { id: 'nameless' }, { name: 'Odd', hp: 'x', prices: [null, 5], turns: 3 }]);
  assert.equal(mods.length, MODS.length + 2);
  assert.match(mods.find((m) => m.name === 'Survey Satellite').meta, /recon/);
  assert.equal(mods.find((m) => m.name === 'Bare').meta, '');
  assert.equal(mods.find((m) => m.name === 'Odd').meta, 'armory $5');
  const perks = perkRows([...PERKS, { name: 'No text' }, { desc: 'No name' }, { name: 'Late', desc: 'Later.', fromRound: 3, needsMod: true }]);
  assert.equal(perks.length, perkRows(PERKS).length + 1);
  assert.equal(perks.at(-1).meta, 'from round 3 · needs a mod');
  assert.equal(modRows(null).length, 0);
  assert.equal(perkRows({}).length, 0);
});

test('the rock-paper-scissors marks a family with no mod as coming', () => {
  const fams = familyRows(MODS);
  assert.deepEqual(fams.map((f) => f.id), ['recon', 'defense', 'jamming']);
  assert.deepEqual(fams.map((f) => f.beats), ['defense', 'jamming', 'recon']);
  assert.equal(fams.find((f) => f.id === 'recon').coming, false);
  assert.equal(fams.find((f) => f.id === 'jamming').coming, true);
  assert.equal(familyRows([{ name: 'Jammer', family: 'jamming' }]).find((f) => f.id === 'jamming').coming, false);
});

test('labRows has a line per mod', () => {
  const rows = labRows(MODS);
  assert.ok(rows.length >= MODS.length);
  assert.ok(rows.some((r) => r.name === 'Sat labels'));
});

test('guideTabs has the five sections, and survives empty data', () => {
  const ids = ['basics', 'controls', 'weapons', 'mods', 'lab'];
  for (const data of [{ weapons: WEAPONS, items: ITEMS, mods: MODS, perks: PERKS }, {}, undefined]) {
    const tabs = guideTabs(data);
    assert.deepEqual(tabs.map((t) => t.id), ids);
    for (const t of tabs) assert.ok(renderBlocks(t.blocks).length > 20, t.id);
  }
  const html = renderBlocks(guideTabs({ weapons: WEAPONS, items: ITEMS, mods: MODS, perks: PERKS }).find((t) => t.id === 'mods').blocks);
  assert.match(html, /Survey Satellite/);
  assert.match(html, /Wide Blast/);
  assert.match(html, /coming/);
});

test('text is escaped before bold and keys are marked up', () => {
  assert.equal(rich('<b>x</b> **hi** `Q`'), '&lt;b&gt;x&lt;/b&gt; <b>hi</b> <kbd>Q</kbd>');
  assert.ok(!renderBlocks([{ rows: [{ name: '<img onerror=x>', text: '<script>' }] }]).includes('<img'));
});
