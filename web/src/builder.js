// The Custom match builder's own parts: Wind and Terrain (each with a Random
// pick, the default), the three checkbox groups (Weapons, Perks, Round
// modifiers) and the testing query string. launch.js remembers the choices
// and main.js starts the match from them.
//
// What a match is made of goes into its config as concrete values, picked
// here once at match start, never in core: core stays deterministic, and
// online the host's pick travels in `session.start`, so every screen builds
// the same world.
//
// The pure parts (choices, rolls, lists, the query string) are tested in
// test/builder.test.js; only `MatchBuilder` touches the DOM.

import { WEAPONS } from './core/weapons.js';
import { PERKS, MODIFIERS } from './core/perks.js';

// ---------------------------------------------------------------- wind and terrain

// The select values (the saved Custom state holds them) and the names shown.
// `weight` is how often Random picks each. Calm and Gale are the extremes, so
// they come up half as often as Breezy and Gusty. The Floating isles are a
// different game (open sky, moons, the void), so Random picks them half as
// often as each meadow.
export const WIND = [
  { id: 'calm', value: 0, name: 'Calm', weight: 1 },
  { id: 'breezy', value: 0.8, name: 'Breezy', weight: 2 },
  { id: 'gusty', value: 1.5, name: 'Gusty', weight: 2 },
  { id: 'gale', value: 2.5, name: 'Gale', weight: 1 },
];
export const TERRAIN = [
  { id: 'rolling', value: '20', name: 'Rolling', weight: 2 },
  { id: 'hilly', value: '45', name: 'Hilly', weight: 2 },
  { id: 'mountains', value: '80', name: 'Mountains', weight: 2 },
  { id: 'isles', value: 'isles', name: 'Floating isles', weight: 1 },
];
export const RANDOM = 'random';
export const MAX_TEST_WIND = 5;

function weighted(list, rand) {
  let roll = rand() * list.reduce((s, x) => s + x.weight, 0);
  for (const x of list) { roll -= x.weight; if (roll < 0) return x; }
  return list[list.length - 1];
}

// A Terrain value ('20', '45', '80' or 'isles') as config.
export function terrainConfig(v) {
  if (v === 'isles') return { hills: 45, world: 'isles' };
  const n = Number(v);
  return { hills: Number.isFinite(n) && n > 0 ? n : 45, world: 'meadow' };
}

// The match's wind and ground from the Wind and Terrain selects ('random' or a
// value), rolled now where Random. `forced` (from the query string) beats both.
export function matchConditions({ wind = RANDOM, terrain = RANDOM } = {}, forced = {}, rand = Math.random) {
  let maxWind = forced.maxWind;
  if (maxWind == null) {
    const n = Number(wind);
    maxWind = wind === RANDOM || wind == null || !Number.isFinite(n) ? weighted(WIND, rand).value : n;
  }
  const t = forced.terrain ?? (terrain === RANDOM || terrain == null ? weighted(TERRAIN, rand).value : terrain);
  return { maxWind, ...terrainConfig(t) };
}

// What a match was dealt, in words: "Hilly · Gusty wind". A value no menu
// offers (from the query string) shows as a number.
export function conditionsLabel(cfg) {
  if (!cfg) return '';
  const w = WIND.find((x) => x.value === cfg.maxWind);
  const wind = w ? `${w.name} wind` : `Wind ${Number(cfg.maxWind) || 0}`;
  const t = cfg.world === 'isles' ? TERRAIN.find((x) => x.id === 'isles') : TERRAIN.find((x) => Number(x.value) === cfg.hills);
  const ground = t ? t.name : `Hills ${cfg.hills}`;
  return `${ground} · ${wind}`;
}

// ---------------------------------------------------------------- the testing query string

// ?wind=calm|breezy|gusty|gale (or a number), ?terrain=rolling|hilly|mountains|isles,
// ?fixed (the old defaults: Gusty and Hilly; wind or terrain still win),
// ?sat=1|2|3 and ?orbiter=1|2|3 (every tank starts with that mod at that
// level), ?labels=few|some|many (the satellite's labelled cells),
// ?modifier=rain (any round modifier id: every round is that one).
// Returns { maxWind?, terrain?, lab?, modifier? }: only what the string asks for.
export function parseTestParams(search) {
  const q = new URLSearchParams(search || '');
  const out = {};
  const on = (k) => q.has(k) && !['0', 'false', 'no'].includes(q.get(k));
  if (on('fixed')) { out.maxWind = 1.5; out.terrain = '45'; }
  const wind = (q.get('wind') || '').toLowerCase();
  if (wind) {
    const w = WIND.find((x) => x.id === wind);
    const n = Number(wind);
    if (w) out.maxWind = w.value;
    else if (Number.isFinite(n)) out.maxWind = Math.max(0, Math.min(MAX_TEST_WIND, n));
  }
  const terrain = (q.get('terrain') || '').toLowerCase();
  const t = TERRAIN.find((x) => x.id === terrain);
  if (t) out.terrain = t.value;
  const lab = {};
  const level = (k) => { const n = Number(q.get(k)); return [1, 2, 3].includes(n) ? n : 0; };
  if (level('sat')) Object.assign(lab, { satellite: 'all', level: level('sat') });
  if (level('orbiter')) Object.assign(lab, { orbiter: 'all', orbiterLevel: level('orbiter') });
  const labels = (q.get('labels') || '').toLowerCase();
  if (['few', 'some', 'many'].includes(labels)) lab.labels = labels;
  if (Object.keys(lab).length) out.lab = lab;
  const mod = (q.get('modifier') || '').toLowerCase();
  if (MODIFIERS.some((m) => m.id === mod)) out.modifier = mod;
  return out;
}

// ---------------------------------------------------------------- the checkbox groups

// One entry per checkbox, from the data modules, so a new weapon, perk or
// modifier shows up here on its own. `locked` is always on (the Shell: a tank
// always has something to fire).
export const GROUPS = [
  { id: 'weapons', name: 'Weapons', items: WEAPONS.filter((w) => !w.hidden).map((w) => ({ id: w.id, name: w.name, desc: w.desc || '', locked: !!w.infinite })),
    note: 'The Shell is always on. A weapon that is off is not in the armory, starting kits, perk hand-outs or the CPUs’ hands.' },
  { id: 'perks', name: 'Perks', items: PERKS.map((p) => ({ id: p.id, name: p.name, desc: p.desc || '' })),
    note: 'Mods come only from their cards: with Orbital Mechanic or Sat Recon off, nobody gets that mod, and its level-up cards never come up. With every perk off there is no draft.' },
  { id: 'modifiers', name: 'Round modifiers', items: MODIFIERS.map((m) => ({ id: m.id, name: m.name, desc: m.desc || '' })),
    note: 'One is rolled each round, never the same twice running. With the wind on Calm, Gale and Dead calm sit out. With all off, every round is plain.' },
];
export const GROUP_BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

// The ids switched off in a group, cleaned: known, never a locked one.
export function cleanOff(groupId, ids) {
  const g = GROUP_BY_ID[groupId];
  if (!g || !Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => g.items.some((it) => it.id === id && !it.locked)))];
}

// The match config list for a group: null when everything is on (the default,
// and what an older build sends), else the ids that are on.
export function onList(groupId, off) {
  const g = GROUP_BY_ID[groupId];
  const out = cleanOff(groupId, off);
  if (!out.length) return null;
  return g.items.filter((it) => it.locked || !out.includes(it.id)).map((it) => it.id);
}

// The config's three lists from the off-sets: { weapons, perks, modifiers }.
export function matchLists(off = {}) {
  return Object.fromEntries(GROUPS.map((g) => [g.id, onList(g.id, off[g.id])]));
}

// The group's summary line: "All", "7 of 12" or "None".
export function groupSummary(groupId, off) {
  const g = GROUP_BY_ID[groupId];
  const n = g.items.length - cleanOff(groupId, off).length;
  if (n === g.items.length) return 'All';
  const locked = g.items.filter((it) => it.locked);
  if (n === locked.length) return locked.length ? `${locked.map((it) => it.name).join(', ')} only` : 'None';
  return `${n} of ${g.items.length}`;
}

// ---------------------------------------------------------------- the page

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sentence = (s) => { const m = String(s).replace(/\s+/g, ' ').trim().match(/^.*?[.!?](?=\s|$)/); return m ? m[0] : String(s); };

// The three groups in `root`: each a <details>, shut by default, with an All
// box over a grid of one box per item. A change bubbles up as a 'change'
// event, so launch.js saves it like any select.
export class MatchBuilder {
  constructor(root) {
    this.root = root;
    this.off = Object.fromEntries(GROUPS.map((g) => [g.id, new Set()]));
    root.innerHTML = GROUPS.map((g) => `
      <details class="pick" data-group="${g.id}">
        <summary><span class="pick-name">${esc(g.name)}</span><span class="pick-count"></span></summary>
        <div class="pick-body">
          <label class="pick-item pick-all"><input type="checkbox" data-all><span><b>All</b></span></label>
          <div class="pick-grid">${g.items.map((it) => `
            <label class="pick-item${it.locked ? ' locked' : ''}" title="${esc(it.desc)}"><input type="checkbox" data-id="${esc(it.id)}"${it.locked ? ' disabled' : ''}><span><b>${esc(it.name)}</b><small>${esc(sentence(it.desc))}</small></span></label>`).join('')}
          </div>
          <p class="pick-note">${esc(g.note)}</p>
        </div>
      </details>`).join('');
    root.addEventListener('change', (e) => {
      const box = e.target.closest('input[type=checkbox]');
      const det = box?.closest('details.pick');
      if (!det) return;
      const g = GROUP_BY_ID[det.dataset.group];
      const off = this.off[g.id];
      if (box.hasAttribute('data-all')) {
        off.clear();
        if (!box.checked) for (const it of g.items) if (!it.locked) off.add(it.id);
      } else if (box.checked) off.delete(box.dataset.id);
      else off.add(box.dataset.id);
      this.show(g.id);
    });
    for (const g of GROUPS) this.show(g.id);
  }

  // From the saved state: { weapons: [ids off], perks, modifiers }.
  setOff(off = {}) {
    for (const g of GROUPS) {
      this.off[g.id] = new Set(cleanOff(g.id, off[g.id]));
      this.show(g.id);
    }
  }

  getOff() { return Object.fromEntries(GROUPS.map((g) => [g.id, [...this.off[g.id]]])); }

  // The config lists: { weapons, perks, modifiers }.
  lists() { return matchLists(this.getOff()); }

  show(groupId) {
    const det = this.root.querySelector(`details.pick[data-group="${groupId}"]`);
    if (!det) return;
    const g = GROUP_BY_ID[groupId];
    const off = this.off[groupId];
    for (const box of det.querySelectorAll('input[data-id]')) box.checked = !off.has(box.dataset.id);
    const all = det.querySelector('input[data-all]');
    const free = g.items.filter((it) => !it.locked).length;
    all.checked = off.size === 0;
    all.indeterminate = off.size > 0 && off.size < free;
    det.querySelector('.pick-count').textContent = groupSummary(groupId, [...off]);
  }
}
