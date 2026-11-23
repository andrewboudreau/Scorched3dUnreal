// The designer's catalog: catalog.html, served at /Craterfall/catalog.html. One
// dense table per kind of data (weapons, armory upgrades, perks, mods, round
// modifiers) plus the tuning constants, all built from the core data modules
// as they are, so a new entry or a new field shows up here on its own. It is
// a tool, not a screen for players; it imports no three.js and starts no game.
//
// How a table is built (buildTable): the columns come from a per-tab hint (the
// fields every entry has, in a sensible order, plus a few derived ones such as
// a weapon's damage or what a perk needs), then any field most entries carry
// is promoted to a column of its own, and every field left over is printed
// compactly as `key: value` in one "other" column. Values that are functions
// or objects go through `summarize`.
//
// Everything above `mount` is pure (data in, rows out; test/catalog.test.js).
// Only `mount` touches the DOM, and it runs only on catalog.html.

import { WEAPONS, ITEMS } from './core/weapons.js';
import { PERKS, MODIFIERS, MOD_DRAFT, aiPickPerk } from './core/perks.js';
import { MODS } from './core/mods.js';
import { chooseWeapon, chooseSecondWeapon } from './core/ai.js';
import { makeRng } from './core/rng.js';
import * as gameMod from './core/game.js';
import * as aiMod from './core/ai.js';
import * as tankMod from './core/tank.js';
import * as surveyMod from './core/survey.js';
import * as ballisticsMod from './core/ballistics.js';
import * as modsMod from './core/mods.js';
import * as perksMod from './core/perks.js';
import * as sceneryMod from './core/scenery.js';
import * as terrainMod from './core/terrain.js';
import * as pathsMod from './core/paths.js';

// ---------------------------------------------------------------- summaries

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrim = (v) => v == null || ['number', 'string', 'boolean', 'bigint'].includes(typeof v);

// A function as one short piece of text: its name when it has one, else its
// source squeezed onto a line.
export function fnSummary(fn, max = 90) {
  let name = '';
  try { name = fn.name; } catch { /* a hostile proxy */ }
  if (name && name !== 'anonymous') return `${name}()`;
  let src = '';
  try { src = Function.prototype.toString.call(fn); } catch { src = 'function'; }
  src = src.replace(/\s+/g, ' ').trim();
  return `ƒ ${src.length > max ? `${src.slice(0, max - 1)}…` : src}`;
}

const trim = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Any value as compact text. Strings pass through untouched; a function is its
// name or one line of source; an object with a string `type` (a weapon part)
// reads `blast(radius: 11, damage: 38)`; any other object is compact JSON.
// Never throws: a cycle or an odd value comes out as a short label.
export function summarize(v, max = 160, depth = 0) {
  try {
    if (v === undefined || v === null) return '';
    switch (typeof v) {
      case 'string': return v;
      case 'number': return Number.isNaN(v) ? 'NaN' : String(v);
      case 'boolean': case 'bigint': return String(v);
      case 'symbol': return v.toString();
      case 'function': return fnSummary(v);
      default: break;
    }
    if (depth > 4) return Array.isArray(v) ? '[…]' : '{…}';
    if (Array.isArray(v)) {
      if (v.every(isPrim)) return v.map((x) => summarize(x, max, depth + 1)).join(' / ');
      return trim(v.map((x) => summarize(x, max, depth + 1)).join('; '), max * 3);
    }
    if (typeof v.type === 'string' && isPlain(v)) {
      const rest = Object.keys(v).filter((k) => k !== 'type').map((k) => `${k}: ${summarize(v[k], max, depth + 1)}`);
      return `${v.type}${rest.length ? `(${rest.join(', ')})` : ''}`;
    }
    if (v instanceof Map || v instanceof Set) return `${v.constructor.name}(${v.size})`;
    return trim(compactJson(v), max * 2);
  } catch {
    return '[unprintable]';
  }
}

// Compact JSON that survives functions, Infinity and cycles.
export function compactJson(v) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(v, (k, x) => {
      if (typeof x === 'function') return fnSummary(x);
      if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
      if (typeof x === 'bigint') return String(x);
      if (x && typeof x === 'object') { if (seen.has(x)) return '[cycle]'; seen.add(x); }
      return x;
    }) ?? '';
  } catch {
    return '[object]';
  }
}

// ---------------------------------------------------------------- cells and columns

// A cell is a list of parts, each plain text or a link { text, tab, id } to a
// row in another tab (or this one), and a value to sort by.
export const textOf = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.text)).join('');
export function cell(parts, sort) {
  const list = (Array.isArray(parts) ? parts : [parts]).filter((p) => p !== '' && p != null);
  const text = textOf(list);
  return { parts: list, text, sort: sort === undefined ? (text === '' ? '' : text) : sort };
}
// Joins parts with a separator between them.
const joinParts = (items, sep = ', ') => items.flatMap((p, i) => (i ? [sep, p] : [p]));
const link = (text, tab, id) => ({ text, tab, id });

// A plain value as a cell: numbers sort as numbers.
function valueCell(v) {
  const text = summarize(v);
  return cell(text, typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) && v.length && v.every(Number.isFinite) ? v.reduce((a, b) => a + b, 0) : text);
}

// The fields of `entries` in first-seen order.
export function fieldKeys(entries) {
  const keys = [];
  const seen = new Set();
  for (const e of entries) for (const k of Object.keys(isPlain(e) ? e : {})) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  return keys;
}

// Columns for a table. `hint.columns` is the wanted order: a field name, or a
// derived column { key, label, get(entry, ctx) -> cell | value }. Fields in
// the hint that no entry has are dropped; fields most entries carry (and that
// are plain values) are promoted; the rest go in "other".
export function pickColumns(entries, hint = {}) {
  const keys = fieldKeys(entries);
  const have = new Set(keys);
  const cols = [];
  const used = new Set(hint.skip || []);
  for (const c of hint.columns || []) {
    if (typeof c === 'string') {
      if (!have.has(c)) continue;
      cols.push({ key: c, label: c });
      used.add(c);
    } else {
      cols.push({ ...c, label: c.label || c.key });
      used.add(c.key);
    }
  }
  const promote = entries.length >= 4 ? Math.ceil(entries.length * 0.6) : Infinity;
  for (const k of keys) {
    if (used.has(k)) continue;
    const count = entries.filter((e) => e[k] !== undefined).length;
    const plain = entries.every((e) => e[k] === undefined || isPrim(e[k]));
    if (plain && count >= promote) { cols.push({ key: k, label: k }); used.add(k); }
  }
  const rest = keys.filter((k) => !used.has(k));
  if (rest.length) cols.push({ key: 'other', label: 'other', other: rest });
  return cols;
}

// One entry's cell for one column.
export function cellFor(entry, col, ctx) {
  let v;
  try {
    if (col.other) {
      const lines = col.other.filter((k) => entry[k] !== undefined).map((k) => `${k}: ${summarize(entry[k])}`);
      return cell(lines.join('\n'));
    }
    v = col.get ? col.get(entry, ctx) : entry[col.key];
    if (v && typeof v === 'object' && Array.isArray(v.parts)) return v;
    return valueCell(v);
  } catch {
    return cell('[error]');
  }
}

// A whole table: { id, label, note, columns, rows }. A row is { id, entry,
// cells: { [column key]: cell }, search }. Columns get `wide` when any of
// their text is long (so the page lets them wrap).
export function buildTable(id, label, entries, hint = {}, ctx = {}) {
  const list = (entries || []).filter(isPlain);
  const columns = pickColumns(list, hint);
  const rows = list.map((entry, i) => {
    const cells = {};
    for (const c of columns) cells[c.key] = cellFor(entry, c, ctx);
    const rid = String(entry.id ?? entry.name ?? i);
    const search = [rid, ...Object.values(cells).map((x) => x.text)].join(' ').toLowerCase();
    return { id: rid, entry, cells, search };
  });
  for (const c of columns) c.wide = rows.some((r) => r.cells[c.key].text.length > 34 || r.cells[c.key].text.includes('\n'));
  return { kind: 'table', id, label, note: hint.note || '', columns, rows };
}

// ---------------------------------------------------------------- searching and sorting

// Rows matching every word of `query` (any column of the row, case ignored).
export function filterRows(rows, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => words.every((w) => r.search.includes(w)));
}

// Rows ordered by one column; numbers by value, text by locale, empty cells
// last either way. A new array: the table keeps its data order.
export function sortRows(rows, key, dir = 1) {
  if (!key) return rows;
  const val = (r) => r.cells[key]?.sort;
  const empty = (x) => x === '' || x == null;
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
    const x = val(a), y = val(b);
    if (empty(x) || empty(y)) return empty(x) && empty(y) ? i - j : empty(x) ? 1 : -1;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return d ? d * dir : i - j;
  }).map(([r]) => r);
}

// ---------------------------------------------------------------- what the CPUs do

// A copy of the CPU shopping list in game.js aiShop (a local there, so it
// cannot be imported); test/catalog.test.js checks it still matches the source.
export const AI_BUYS = ['breacher', 'scatter', 'flak', 'armor', 'roller', 'fuel', 'jet', 'breacher'];

// How often chooseWeapon / chooseSecondWeapon (ai.js) pick weapon `id` when a
// CPU holds one of it, by sampling them: the best share over a few targets
// (one behind an orbiter, one below, one level) for the first shot, and for
// the second. Derived from the code, so it follows it.
export function cpuWeaponUse(id, samples = 300) {
  try {
    const rng = makeRng(0xc0ffee);
    const me = { inventory: { [id]: 1 }, y: 20 };
    let first = 0;
    for (const target of [{ shielded: true, y: 0 }, { shielded: false, y: 0 }, { shielded: false, y: 20 }]) {
      let n = 0;
      for (let k = 0; k < samples; k++) if (chooseWeapon(me, target, rng) === id) n++;
      first = Math.max(first, n / samples);
    }
    let n2 = 0;
    for (let k = 0; k < samples; k++) if (chooseSecondWeapon(me, 'shell', rng) === id) n2++;
    return { first, second: n2 / samples };
  } catch {
    return { first: 0, second: 0 };
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;
function cpuWeaponCell(w) {
  const buys = AI_BUYS.includes(w.id);
  const { first, second } = cpuWeaponUse(w.id);
  const bits = [];
  if (w.id === 'shell') bits.push('default shot');
  else {
    if (first > 0) bits.push(`shot 1 ≤${pct(first)}`);
    if (second > 0) bits.push(`shot 2 ${pct(second)}`);
  }
  if (buys) bits.push('buys');
  if (!bits.length) return cell(w.hidden ? '' : 'never', 0);
  return cell(bits.join(', '), first + second + (buys ? 0.01 : 0));
}

// What a CPU makes of a perk offered to it (aiPickPerk, perks.js): sampled
// head to head against every other perk. 'never' loses to everything, 'favourite'
// wins most contests, the rest are 'neutral'. Returns { [perk id]: score 0..1 }.
export function cpuPerkScores(perks = PERKS, samples = 200) {
  const rng = makeRng(0xbeef);
  const wins = {};
  for (const a of perks) {
    wins[a.id] = {};
    for (const b of perks) {
      if (a.id === b.id) continue;
      let n = 0;
      for (let k = 0; k < samples; k++) if (aiPickPerk([a.id, b.id], rng) === a.id) n++;
      wins[a.id][b.id] = n / samples;
    }
  }
  const mean = (a) => { const v = Object.values(wins[a.id]); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0.5; };
  const never = new Set(perks.filter((a) => mean(a) < 0.1).map((a) => a.id));   // (two 'never' cards still beat each other)
  const out = {};
  for (const a of perks) {
    const vs = perks.filter((b) => b.id !== a.id && !never.has(b.id)).map((b) => wins[a.id][b.id]);
    out[a.id] = never.has(a.id) ? 0 : vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : 0.5;
  }
  return { scores: out, never };
}

// ---------------------------------------------------------------- the tables

// The perk field that a hidden weapon is spawned by (a perk, not a weapon).
const PERK_SPAWNS = { shrapnel: 'bomblet' };

const nameOf = (list, id) => list.find((x) => x.id === id)?.name || id;
const blastsOf = (w) => {
  const out = [];
  const walk = (parts) => { for (const p of Array.isArray(parts) ? parts : []) { if (p?.type === 'blast') out.push(p); if (Array.isArray(p?.then)) walk(p.then); } };
  walk(w.impact);
  return out;
};
const partsOf = (w) => [...(Array.isArray(w.flight) ? w.flight : []), ...(Array.isArray(w.impact) ? w.impact : [])];
const children = (w) => partsOf(w).map((p) => p?.child).filter((c) => typeof c === 'string');

function weaponsTable() {
  return buildTable('weapons', 'Weapons', WEAPONS, {
    note: 'Damage and radius are the weapon\'s own blast (a split or airburst weapon\'s children have their own rows). Hidden weapons are never sold: they are what other weapons split into, or what a perk throws.',
    columns: ['id', 'name', 'price', 'bundle',
      { key: 'perShot', label: '$/shot', get: (w) => (Number.isFinite(w.price) && w.bundle > 0 ? Math.round((w.price / w.bundle) * 10) / 10 : '') },
      { key: 'damage', label: 'damage', get: (w) => { const b = blastsOf(w); return b.length ? b.map((x) => x.damage).join(' + ') : ''; } },
      { key: 'radius', label: 'radius', get: (w) => { const b = blastsOf(w); return b.length ? b.map((x) => x.radius).join(' + ') : ''; } },
      'desc', 'flight', 'impact',
      { key: 'cpu', label: 'CPU', get: (w) => cpuWeaponCell(w) },
      { key: 'links', label: 'links', get: (w) => {
        const out = [];
        for (const c of children(w)) out.push(['→ ', link(nameOf(WEAPONS, c), 'weapons', c)]);
        for (const p of WEAPONS) if (children(p).includes(w.id)) out.push(['← ', link(p.name, 'weapons', p.id)]);
        for (const p of PERKS) {
          if (p.roundAmmo?.[w.id]) out.push(['perk ', link(p.name, 'perks', p.id), ` (+${p.roundAmmo[w.id]} each round)`]);
          for (const [field, wid] of Object.entries(PERK_SPAWNS)) if (wid === w.id && p[field]) out.push(['perk ', link(p.name, 'perks', p.id), ` (${field}: ${p[field]})`]);
        }
        return cell(joinParts(out, '\n').flat());
      } }],
    skip: [],
  });
}

function itemsTable() {
  return buildTable('items', 'Upgrades', ITEMS, {
    note: 'The armory upgrades (ITEMS in weapons.js), sold next to the weapons. Mods are sold there too when the host\'s Lab says so: see the Mods tab.',
    columns: ['id', 'name', 'price', 'bundle',
      { key: 'perShot', label: '$/unit', get: (w) => (Number.isFinite(w.price) && w.bundle > 0 ? Math.round((w.price / w.bundle) * 10) / 10 : '') },
      'desc',
      { key: 'cpu', label: 'CPU', get: (w) => (AI_BUYS.includes(w.id) ? 'buys' : 'never buys') }],
  });
}

function perkNeeds(p) {
  const bits = [];
  const mods = Object.keys(p.mods || {});
  if (p.fromRound) bits.push(`from round ${p.fromRound}`);
  if (p.unlock) bits.push(...mods.map((m) => `owns no ${nameOf(MODS, m)}`));
  if (p.levelUp) bits.push(...mods.map((m) => `owns ${nameOf(MODS, m)}, below its top level (${MODS.find((d) => d.id === m)?.maxLevel ?? '?'})`));
  if (p.needsMod) bits.push('owns at least one mod');
  if (mods.length) bits.push(`at most ${MOD_DRAFT.cap} mod-level perks a match`);
  if (p.stack > 1) bits.push(`up to ${p.stack} copies`);
  return bits;
}

function perksTable() {
  const { scores, never } = cpuPerkScores();
  return buildTable('perks', 'Perks', PERKS, {
    note: `Mod cards (unlock, level-up, and the ones that need a mod) come up at most one per draft: chance ${MOD_DRAFT.first} while the tank owns no mod, ${MOD_DRAFT.then} after; a tank takes at most ${MOD_DRAFT.cap} of them a match (MOD_DRAFT in perks.js). CPU is how aiPickPerk treats the card, sampled.`,
    columns: ['id', 'tag', 'name', 'desc',
      { key: 'needs', label: 'needs', get: (p) => cell(perkNeeds(p).join('\n')) },
      { key: 'links', label: 'links', get: (p) => {
        const out = [];
        for (const [m, n] of Object.entries(p.mods || {})) {
          const def = MODS.find((d) => d.id === m);
          out.push(['mod ', def ? link(def.name, 'mods', m) : `${m} (no such mod!)`, ` +${n}${p.unlock ? ' (unlock)' : p.levelUp ? ' (level-up)' : ''}`]);
        }
        for (const [w, n] of Object.entries(p.roundAmmo || {})) out.push(['weapon ', WEAPONS.some((x) => x.id === w) ? link(nameOf(WEAPONS, w), 'weapons', w) : `${w} (no such weapon!)`, ` ×${n}`]);
        for (const [field, w] of Object.entries(PERK_SPAWNS)) if (p[field]) out.push(['throws ', link(nameOf(WEAPONS, w), 'weapons', w)]);
        return cell(joinParts(out, '\n').flat());
      } },
      { key: 'cpu', label: 'CPU', get: (p) => cell(never.has(p.id) ? 'never' : scores[p.id] > 0.5 ? 'favourite' : 'neutral', scores[p.id]) }],
    skip: ['mods', 'unlock', 'levelUp', 'stack', 'fromRound', 'needsMod'],
  });
}

function modsTable() {
  return buildTable('mods', 'Mods', MODS, {
    note: 'A mod is deployed gear. Lab modes (MOD_MODES): perk (default, only from the draft), shop, all, off. Levels and costs are per level, each on top of the one before.',
    columns: ['id', 'tag', 'name', 'family', 'maxLevel',
      { key: 'prices', label: 'prices', get: (m) => m.prices },
      { key: 'total', label: 'all levels $', get: (m) => (Array.isArray(m.prices) ? m.prices.reduce((a, b) => a + (Number(b) || 0), 0) : '') },
      'hp', 'turns', 'levels', 'desc',
      { key: 'perks', label: 'perks that give it', get: (m) => {
        const out = [];
        for (const p of PERKS) {
          if (p.mods?.[m.id]) out.push([link(p.name, 'perks', p.id), ` (${p.unlock ? 'unlock' : p.levelUp ? `+${p.mods[m.id]} level, ×${p.stack || 1}` : `+${p.mods[m.id]}`})`]);
          else if (p.needsMod || p.modTurns || p.modHp) out.push([link(p.name, 'perks', p.id), ' (any mod)']);
        }
        return cell(joinParts(out, '\n').flat());
      } }],
  });
}

function modifiersTable() {
  const total = MODIFIERS.reduce((s, m) => s + (Number(m.weight) || 0), 0);
  return buildTable('modifiers', 'Round modifiers', MODIFIERS, {
    note: 'One rolled each round with these weights; the same one never comes twice running (pickModifier). Odds are the plain weight share.',
    columns: ['id', 'name', 'desc', 'weight',
      { key: 'odds', label: 'odds %', get: (m) => (total && Number.isFinite(m.weight) ? Math.round((m.weight / total) * 1000) / 10 : '') }],
  });
}

// ---------------------------------------------------------------- numbers

// Name -> exports that are tuning data in some other file than the tables above.
const NUMBER_FILES = [
  ['core/game.js', gameMod], ['core/ai.js', aiMod], ['core/tank.js', tankMod], ['core/survey.js', surveyMod],
  ['core/ballistics.js', ballisticsMod], ['core/mods.js', modsMod], ['core/perks.js', perksMod],
  ['core/scenery.js', sceneryMod], ['core/terrain.js', terrainMod], ['core/paths.js', pathsMod],
];
// The big tables get their own tabs; HOUSE is just BUILDINGS.house again.
const NOT_NUMBERS = new Set(['WEAPONS', 'ITEMS', 'PERKS', 'MODIFIERS', 'MODS', 'HOUSE']);

// A value as [path, text] rows: nested objects and arrays of objects get dotted paths.
export function flatten(v, path = '', out = [], depth = 0) {
  if (v == null || isPrim(v) || typeof v === 'function' || depth > 5) { out.push([path, summarize(v)]); return out; }
  if (Array.isArray(v)) {
    if (v.every(isPrim)) { out.push([path, summarize(v)]); return out; }
    v.forEach((x, i) => { if (x != null) flatten(x, path ? `${path}.${i}` : String(i), out, depth + 1); });
    return out;
  }
  const keys = Object.keys(v);
  if (!keys.length) out.push([path, '{}']);
  for (const k of keys) flatten(v[k], path ? `${path}.${k}` : k, out, depth + 1);
  return out;
}

// Every exported CONSTANT (UPPER_CASE name, a plain value, object or array)
// in the core files, as { name, file, rows: [[key, value]] }.
export function buildNumbers(files = NUMBER_FILES) {
  const groups = [];
  for (const [file, mod] of files) {
    for (const name of Object.keys(mod)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || NOT_NUMBERS.has(name) || name.endsWith('_BY_ID')) continue;
      const v = mod[name];
      if (typeof v === 'function' || v === undefined) continue;
      let rows;
      try { rows = flatten(v); } catch { rows = [['', '[unprintable]']]; }
      const text = (r) => `${name} ${file} ${r[0]} ${r[1]}`.toLowerCase();
      groups.push({ id: name, name, file: `src/${file}`, rows: rows.map((r) => ({ key: r[0], value: r[1], search: text(r) })) });
    }
  }
  return { kind: 'numbers', id: 'numbers', label: 'Numbers', note: 'Every exported constant in the core files, as it is now. Not the tables: they have their own tabs.', groups };
}

export function filterGroups(groups, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const out = [];
  for (const g of groups) {
    const head = `${g.name} ${g.file}`.toLowerCase();
    const rows = g.rows.filter((r) => words.every((w) => r.search.includes(w)));
    if (words.every((w) => head.includes(w))) out.push(g);
    else if (rows.length) out.push({ ...g, rows });
  }
  return out;
}

// All the tabs, in order.
export function buildCatalog() {
  return [weaponsTable(), itemsTable(), perksTable(), modsTable(), modifiersTable(), buildNumbers()];
}

// How many rows of a tab a query matches.
export function matchCount(tab, query) {
  return tab.kind === 'numbers' ? filterGroups(tab.groups, query).reduce((n, g) => n + g.rows.length, 0) : filterRows(tab.rows, query).length;
}
export function totalCount(tab) {
  return tab.kind === 'numbers' ? tab.groups.reduce((n, g) => n + g.rows.length, 0) : tab.rows.length;
}

// ---------------------------------------------------------------- the page (DOM)

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

export function mount(root, tabs = buildCatalog()) {
  const state = { tab: tabs[0].id, q: '', sort: {} };
  const byId = Object.fromEntries(tabs.map((t) => [t.id, t]));
  let pending = null;   // a row to scroll to once the table is drawn

  const search = h('input', { type: 'search', id: 'cat-q', placeholder: 'search (press / to focus), e.g. orbit, flak, 200', autocomplete: 'off', spellcheck: 'false',
    oninput: (e) => { state.q = e.target.value; draw(); } });
  const tabBar = h('nav', { class: 'c-tabs', role: 'tablist' });
  const body = h('div', { class: 'c-body' });
  root.append(
    h('header', { class: 'c-head' },
      h('h1', {}, 'Craterfall catalog'),
      h('span', { class: 'c-sub' }, 'everything in the game data, as it is now'),
      h('a', { class: 'c-back', href: './' }, '← back to the game')),
    h('div', { class: 'c-bar' }, search, tabBar),
    body);

  const go = (tab, id) => { location.hash = id ? `${tab}/${encodeURIComponent(id)}` : tab; };

  function linkEl(p) {
    if (typeof p === 'string') return p;
    return h('a', { href: `#${p.tab}/${encodeURIComponent(p.id)}`, class: 'c-link', onclick: (e) => { e.preventDefault(); go(p.tab, p.id); } }, p.text);
  }

  function drawTable(tab) {
    const sort = state.sort[tab.id] || { key: null, dir: 1 };
    const rows = sortRows(filterRows(tab.rows, state.q), sort.key, sort.dir);
    const head = h('tr', {}, tab.columns.map((c) => h('th', { class: `${c.wide ? 'wide' : ''} ${sort.key === c.key ? 'sorted' : ''}`, title: 'sort', tabindex: 0,
      'aria-sort': sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none',
      onclick: () => { state.sort[tab.id] = { key: c.key, dir: sort.key === c.key ? -sort.dir : 1 }; draw(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); } } },
    c.label, sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '')));
    const trs = rows.map((r) => h('tr', { id: `r-${tab.id}-${r.id}`, class: r.entry.hidden ? 'dim' : '' },
      tab.columns.map((c) => {
        const x = r.cells[c.key];
        return h('td', { class: `${c.wide ? 'wide' : ''} ${typeof x.sort === 'number' ? 'num' : ''} ${c.key === 'id' ? 'idc' : ''}` }, x.parts.map(linkEl));
      })));
    return [h('p', { class: 'c-note' }, tab.note, ` Showing ${rows.length} of ${tab.rows.length}.`),
      h('div', { class: 'c-scroll' }, h('table', {}, h('thead', {}, head), h('tbody', {}, trs)))];
  }

  function drawNumbers(tab) {
    const groups = filterGroups(tab.groups, state.q);
    return [h('p', { class: 'c-note' }, tab.note, ` Showing ${groups.length} of ${tab.groups.length} constants.`),
      h('div', { class: 'c-groups' }, groups.map((g) => h('section', { class: 'c-group', id: `r-numbers-${g.id}` },
        h('h2', {}, g.name, h('small', {}, g.file)),
        h('div', { class: 'c-scroll' }, h('table', { class: 'kv' }, h('tbody', {}, g.rows.map((r) => h('tr', {}, h('th', {}, r.key || '(value)'), h('td', {}, r.value))))))))),
    ];
  }

  function draw() {
    tabBar.replaceChildren(...tabs.map((t) => {
      const n = matchCount(t, state.q);
      return h('button', { class: `c-tab ${t.id === state.tab ? 'on' : ''}`, role: 'tab', 'aria-selected': t.id === state.tab ? 'true' : 'false', onclick: () => go(t.id) },
        t.label, h('span', { class: 'c-n' }, state.q ? `${n}/${totalCount(t)}` : String(totalCount(t))));
    }));
    const tab = byId[state.tab];
    body.replaceChildren(...(tab.kind === 'numbers' ? drawNumbers(tab) : drawTable(tab)));
    if (pending) {
      const el = document.getElementById(`r-${pending.tab}-${pending.id}`);
      if (el) { el.classList.add('hit'); el.scrollIntoView({ block: 'center' }); }
      pending = null;
    }
  }

  // #weapons, #perks/orbital: a tab and maybe a row. A row the search hides clears the search.
  function route() {
    const [t, id] = decodeURIComponent(location.hash.slice(1)).split('/');
    if (byId[t]) { state.tab = t; if (id) { pending = { tab: t, id }; if (state.q) { state.q = ''; search.value = ''; } } }
    draw();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); search.select(); }
    else if (e.key === 'Escape' && document.activeElement === search) { search.value = ''; state.q = ''; search.blur(); draw(); }
  });
  route();
  return { state, draw };
}

if (typeof document !== 'undefined' && document.getElementById('cat-root')) mount(document.getElementById('cat-root'));
