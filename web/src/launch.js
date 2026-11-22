// The launch (setup) screen: your name, a big Play button, Play online, and a
// collapsed Custom match section holding every option. This module holds what
// is not about the match itself: the Play defaults, remembering the Custom
// section (open or shut, last options, last tank rows) in localStorage, and
// full screen on a phone. main.js keeps the match and the online lobby.
//
// The pure parts (defaults, load/save) take the storage as an argument so the
// tests can run them without a browser.

import { canFullscreen, isFullscreen, toggleFullscreen } from './settings.js';

export const CUSTOM_KEY = 'craterfall.custom';
export const NAME_KEY = 'craterfall.name';
export const MAX_TANKS = 6;
export const CPU_TYPES = ['easy', 'normal', 'hard'];

// What Play starts: you against two Normal CPUs, the options a fresh Custom
// section shows. Written out (not read from the form) so a half-set-up Custom
// section can never change what the big button does.
export function defaultMatch(name) {
  return {
    players: [{ name: name || 'You', ai: null }, { name: 'Rook', ai: 'normal' }, { name: 'Vex', ai: 'normal' }],
    rounds: 3, maxWind: 1.5, hills: 45, world: 'meadow',
    twists: true, firing: 'volley', fog: false,
    lab: { satellite: 'perk', level: 1, labels: 'some', orbiter: 'perk', orbiterLevel: 1 },
  };
}

// The saved Custom state's version. Version 1 (no `v`) saved every select,
// so its 'shop' in the mod selects was the old default ("In the armory"),
// not a choice: it is dropped, and the new default (Perks) shows instead.
export const CUSTOM_VERSION = 2;
const OLD_DEFAULTS = { 'opt-sat': 'shop', 'opt-orbiter': 'shop' };

// {open, opts: {selectId: value}, cpus: [{name, type}]}, whatever the last visit left, checked.
// A saved value the select no longer offers falls back to its default in wireLaunch.
export function loadCustom(storage) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(CUSTOM_KEY) || 'null'); } catch { /* damaged: start fresh */ }
  const out = { open: false, opts: {}, cpus: null };
  if (!raw || typeof raw !== 'object') return out;
  out.open = raw.open === true;
  const old = raw.v !== CUSTOM_VERSION;
  if (raw.opts && typeof raw.opts === 'object') {
    for (const [k, v] of Object.entries(raw.opts)) {
      if (!/^opt-[\w-]+$/.test(k) || typeof v !== 'string' || (old && OLD_DEFAULTS[k] === v)) continue;
      out.opts[k] = v;
    }
  }
  if (Array.isArray(raw.cpus)) {
    const cpus = raw.cpus.filter((r) => r && CPU_TYPES.includes(r.type) && typeof r.name === 'string')
      .map((r) => ({ name: r.name.slice(0, 14), type: r.type })).slice(0, MAX_TANKS - 1);
    if (cpus.length) out.cpus = cpus;
  }
  return out;
}

export function saveCustom(storage, state) {
  try { storage.setItem(CUSTOM_KEY, JSON.stringify({ v: CUSTOM_VERSION, open: !!state.open, opts: state.opts, cpus: state.cpus })); } catch { /* private mode */ }
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
// it changes. `rows` is main.js's setupRows (changed in place); `render` redraws the tank rows.
export function wireLaunch({ rows, render }) {
  const saved = loadCustom(localStorage);
  for (const [id, v] of Object.entries(saved.opts)) {
    const el = $(id);
    if (el && [...el.options].some((o) => o.value === v)) el.value = v;
  }
  if (saved.cpus) rows.splice(1, rows.length, ...saved.cpus);

  const toggle = $('custom-toggle'), box = $('custom');
  const setOpen = (open) => { box.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
  setOpen(saved.open);

  const name = () => { rows[0].name = humanName() || 'You'; };
  name();
  $('net-name').addEventListener('input', () => { name(); if (rows[0].type === 'human') render(); });

  const save = () => {
    if (document.body.classList.contains('net-lobby')) return;   // a room's tanks are not your custom match
    saveCustom(localStorage, { open: box.classList.contains('open'), opts: formOptions(), cpus: rows.slice(1) });
  };
  toggle.addEventListener('click', () => { setOpen(!box.classList.contains('open')); save(); });
  // After the rows' own handlers (they sit lower in the tree and run first).
  $('custom-body').addEventListener('change', save);
  $('custom-body').addEventListener('input', save);
  $('custom-body').addEventListener('click', (e) => { if (e.target.closest('#add-player, #remove-player')) save(); });
  return save;
}
