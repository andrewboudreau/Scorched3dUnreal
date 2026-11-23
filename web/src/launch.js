// The launch (setup) screen: your name, a big Play button, Play online, and a
// collapsed Custom match section holding every option. This module holds what
// is not about the match itself: the Play defaults, remembering the Custom
// section (open or shut, last options, last tank rows) in localStorage, and
// full screen on a phone. main.js keeps the match and the online lobby.
//
// The pure parts (defaults, load/save) take the storage as an argument so the
// tests can run them without a browser.

import { canFullscreen, isFullscreen, toggleFullscreen } from './settings.js';
import { GROUPS, cleanOff, matchConditions } from './builder.js';
import { PERKS } from './core/perks.js';

export const CUSTOM_KEY = 'craterfall.custom';
export const NAME_KEY = 'craterfall.name';
export const MAX_TANKS = 6;
export const CPU_TYPES = ['easy', 'normal', 'hard'];

// What Play starts: you against two Normal CPUs, the options a fresh Custom
// section shows (everything on, Random wind and terrain). Written out (not read
// from the form) so a half-set-up Custom section can never change what the big
// button does. `conditions` is the rolled wind and ground (builder.js
// matchConditions); `lab` only comes from the testing query string.
export function defaultMatch(name, conditions = matchConditions(), lab = null) {
  return {
    players: [{ name: name || 'You', ai: null }, { name: 'Rook', ai: 'normal' }, { name: 'Vex', ai: 'normal' }],
    rounds: 3, ...conditions,
    firing: 'volley', fog: false,
    weapons: null, perks: null, modifiers: null,   // all on
    lab: { satellite: 'perk', level: 1, labels: 'some', orbiter: 'perk', orbiterLevel: 1, ...(lab || {}) },
  };
}

// The saved Custom state's version.
// - Versions 1 (no `v`) and 2 saved every select, so a value that was the
//   default then is not a choice: the old mod selects' 'shop', and Gusty and
//   Hilly (Random is the default now) are dropped.
// - Version 3 has the checkbox groups (`off`: the ids switched off, so a new
//   weapon or perk starts on) and no Twists or Lab selects. An old Twists Off
//   turns every perk and round modifier off; an old Lab 'off' for the
//   Satellite or Orbiter unticks that mod's perk cards. Lab 'shop' and 'all'
//   are testing aids now (the query string) and are not carried over.
export const CUSTOM_VERSION = 3;
const OLD_DEFAULTS = { 'opt-wind': '1.5', 'opt-hills': '45' };
const GONE = ['opt-twists', 'opt-sat', 'opt-orbiter', 'opt-sat-labels'];
const emptyOff = () => Object.fromEntries(GROUPS.map((g) => [g.id, []]));
const allIds = (id) => GROUPS.find((g) => g.id === id).items.map((it) => it.id);

// {open, opts: {selectId: value}, cpus: [{name, type}], off: {group: [ids]}},
// whatever the last visit left, checked. A saved value the select no longer
// offers falls back to its default in wireLaunch; unknown ids are dropped.
export function loadCustom(storage) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(CUSTOM_KEY) || 'null'); } catch { /* damaged: start fresh */ }
  const out = { open: false, opts: {}, cpus: null, off: emptyOff() };
  if (!raw || typeof raw !== 'object') return out;
  out.open = raw.open === true;
  const old = raw.v !== CUSTOM_VERSION;
  const was = raw.opts && typeof raw.opts === 'object' ? raw.opts : {};
  for (const [k, v] of Object.entries(was)) {
    if (!/^opt-[\w-]+$/.test(k) || typeof v !== 'string' || (old && OLD_DEFAULTS[k] === v) || GONE.includes(k)) continue;
    out.opts[k] = v;
  }
  if (raw.off && typeof raw.off === 'object') {
    for (const g of GROUPS) out.off[g.id] = cleanOff(g.id, raw.off[g.id]);
  }
  if (old) {
    if (was['opt-twists'] === '0') {
      out.off.perks = cleanOff('perks', allIds('perks'));
      out.off.modifiers = cleanOff('modifiers', allIds('modifiers'));
    }
    const cards = (mod) => PERKS.filter((p) => p.mods?.[mod]).map((p) => p.id);
    if (was['opt-sat'] === 'off') out.off.perks = cleanOff('perks', [...out.off.perks, ...cards('satellite')]);
    if (was['opt-orbiter'] === 'off') out.off.perks = cleanOff('perks', [...out.off.perks, ...cards('orbiter')]);
  }
  if (Array.isArray(raw.cpus)) {
    const cpus = raw.cpus.filter((r) => r && CPU_TYPES.includes(r.type) && typeof r.name === 'string')
      .map((r) => ({ name: r.name.slice(0, 14), type: r.type })).slice(0, MAX_TANKS - 1);
    if (cpus.length) out.cpus = cpus;
  }
  return out;
}

export function saveCustom(storage, state) {
  try { storage.setItem(CUSTOM_KEY, JSON.stringify({ v: CUSTOM_VERSION, open: !!state.open, opts: state.opts, cpus: state.cpus, off: state.off || emptyOff() })); } catch { /* private mode */ }
}

// On a phone, tapping Play or Start also fills the screen where the browser
// allows it. Call it inside the tap handler: full screen needs a user gesture.
export function phoneFullscreen(touch) {
  if (touch && canFullscreen() && !isFullscreen()) toggleFullscreen();
}

// ---- the page glue

const $ = (id) => document.getElementById(id);
const formOptions = () => Object.fromEntries([...document.querySelectorAll('#setup .options select[id^="opt-"]')].map((el) => [el.id, el.value]));

export const humanName = () => $('net-name').value.trim().slice(0, 14);

// Wire the screen up: fill the Custom section from the last visit, keep the
// name field and the first tank row as one name, and save the Custom state as
// it changes. `rows` is main.js's setupRows (changed in place); `render` redraws
// the tank rows; `builder` is the checkbox groups (builder.js MatchBuilder).
export function wireLaunch({ rows, render, builder }) {
  const saved = loadCustom(localStorage);
  for (const [id, v] of Object.entries(saved.opts)) {
    const el = $(id);
    if (el && [...el.options].some((o) => o.value === v)) el.value = v;
  }
  builder?.setOff(saved.off);
  if (saved.cpus) rows.splice(1, rows.length, ...saved.cpus);

  const toggle = $('custom-toggle'), box = $('custom');
  const setOpen = (open) => { box.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
  setOpen(saved.open);

  const name = () => { rows[0].name = humanName() || 'You'; };
  name();
  $('net-name').addEventListener('input', () => { name(); if (rows[0].type === 'human') render(); });

  const save = () => {
    if (document.body.classList.contains('net-lobby')) return;   // a room's tanks are not your custom match
    saveCustom(localStorage, { open: box.classList.contains('open'), opts: formOptions(), cpus: rows.slice(1), off: builder?.getOff() });
  };
  toggle.addEventListener('click', () => { setOpen(!box.classList.contains('open')); save(); });
  // After the rows' own handlers (they sit lower in the tree and run first).
  $('custom-body').addEventListener('change', save);
  $('custom-body').addEventListener('input', save);
  $('custom-body').addEventListener('click', (e) => { if (e.target.closest('#add-player, #remove-player')) save(); });
  return save;
}
