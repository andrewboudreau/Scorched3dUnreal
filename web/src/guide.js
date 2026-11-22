// The in-game guide: Settings > Guide. A short, scannable page in tabs (Basics,
// Controls, Weapons, Mods and perks, Lab), full screen on a phone and a centred
// panel on a desktop. It is loaded the first time it is opened (main.js
// registers the Settings entry and imports this file then), and its styles
// (css/guide.css) come with it.
//
// The weapon, mod and perk lists are generated from core/weapons.js, mods.js
// and perks.js, so the guide follows the data. Everything is read defensively:
// a missing field, or an entry we cannot describe, is skipped rather than
// breaking the page. The content builders below are pure (data in, blocks
// out; test/guide.test.js) and only `Guide` touches the DOM.

import * as weaponData from './core/weapons.js';
import * as modData from './core/mods.js';
import * as perkData from './core/perks.js';
import * as gameData from './core/game.js';

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Text with **bold** and `keys`, escaped first.
export const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<kbd>$1</kbd>');

const isList = (a) => Array.isArray(a) ? a : [];
const named = (o) => !!o && typeof o === 'object' && typeof o.name === 'string' && o.name.trim() !== '';

// The first sentence of a description, trimmed to fit a line.
export function firstSentence(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  let out = m ? m[0] : s;
  if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return out;
}

// "200 / 260 / 300" from a list of numbers, or a lone number; '' when none.
const spread = (list, pre = '') => {
  const a = isList(list).filter((n) => Number.isFinite(n));
  return a.length ? a.map((n) => `${pre}${n}`).join(' / ') : '';
};
const range = (list, unit) => {
  const a = isList(list).filter((n) => Number.isFinite(n));
  if (!a.length) return '';
  const lo = Math.min(...a), hi = Math.max(...a);
  return `${lo === hi ? lo : `${lo} to ${hi}`} ${unit}`;
};

// ---------------------------------------------------------------- generated lists

// Weapons for sale (or always in stock), one line each. Hidden ones (the
// pieces a weapon splits into) and any without a name are left out.
export function weaponRows(weapons) {
  const rows = [];
  for (const w of isList(weapons)) {
    if (!named(w) || w.hidden) continue;
    let price = '';
    if (w.infinite || w.price === 0) price = 'free';
    else if (Number.isFinite(w.price)) price = w.bundle > 1 ? `$${w.price} for ${w.bundle}` : `$${w.price}`;
    rows.push({ name: w.name, meta: price, text: firstSentence(w.desc) });
  }
  return rows;
}

// Armory gear that is not a weapon (armor, fuel, jump jets).
export const itemRows = (items) => weaponRows(items);

// Mods: name, family and numbers on the first line, then what it does.
export function modRows(mods) {
  const rows = [];
  for (const m of isList(mods)) {
    if (!named(m)) continue;
    const bits = [];
    if (m.family) bits.push(String(m.family));
    const hp = range(m.hp, 'hp'), turns = range(m.turns, 'turns');
    if (hp) bits.push(hp);
    if (turns) bits.push(turns);
    const prices = spread(m.prices, '$');
    if (prices) bits.push(prices);
    rows.push({ name: m.name, tag: m.tag ? String(m.tag) : '', meta: bits.join(' · '), text: firstSentence(m.desc, 150), levels: isList(m.levels).filter((l) => typeof l === 'string') });
  }
  return rows;
}

// Perks, one line each. A perk with no name or description cannot be described, so it is skipped.
export function perkRows(perks) {
  const rows = [];
  for (const p of isList(perks)) {
    if (!named(p) || typeof p.desc !== 'string' || !p.desc.trim()) continue;
    const meta = [];
    if (Number.isFinite(p.fromRound) && p.fromRound > 1) meta.push(`from round ${p.fromRound}`);
    if (p.needsMod) meta.push('needs a mod');
    rows.push({ name: p.name, meta: meta.join(' · '), text: firstSentence(p.desc, 160) });
  }
  return rows;
}

// The rock-paper-scissors. A family is "coming" until a mod of that family is
// in the game; the beats-chain comes from the design guide.
const FAMILIES = [
  { id: 'recon', name: 'Recon', beats: 'defense', why: 'Information lets you aim around a defense.' },
  { id: 'defense', name: 'Defense', beats: 'jamming', why: 'Defenses shoot down or drag off jammers.' },
  { id: 'jamming', name: 'Jamming', beats: 'recon', why: 'A jammer blinds recon.' },
];
export function familyRows(mods) {
  const have = new Set(isList(mods).filter(named).map((m) => String(m.family || '').toLowerCase()));
  return FAMILIES.map((f) => ({
    ...f,
    coming: !have.has(f.id),
    beatsName: FAMILIES.find((x) => x.id === f.beats).name,
    mods: isList(mods).filter((m) => named(m) && String(m.family || '').toLowerCase() === f.id).map((m) => m.name),
  }));
}

// What the host's Lab does, one row per mod plus the satellite's labels.
export function labRows(mods) {
  const rows = [];
  for (const m of isList(mods)) {
    if (!named(m)) continue;
    const max = Number.isFinite(m.maxLevel) ? m.maxLevel : 1;
    rows.push({
      name: m.name,
      text: `Choose how everyone gets it: the usual way (the perk draft or armory), handed to all at level ${max > 1 ? `1 to ${max}` : '1'}, or off.`,
    });
  }
  if (isList(mods).some((m) => m && m.id === 'satellite')) {
    rows.push({ name: 'Sat labels', text: 'How many of the Survey Satellite’s cells carry an aim label: few, some or many.' });
  }
  return rows;
}

// ---------------------------------------------------------------- the content

// Keys on a desktop: [keys, what they do].
const KEYS = [
  ['A D', 'turret left / right (steers a Guided Missile in flight)'],
  ['W S', 'elevation'],
  ['Q E', 'power'],
  ['Shift', 'fast aim, three times the speed; a tap is a fine step'],
  ['↑ ↓', 'drive forward / back (uses fuel)'],
  ['← →', 'turn the hull (free)'],
  ['J', 'jump jet: hop about 25 m'],
  ['B', 'deploy a ready mod: press to arm, again to deploy'],
  ['X', 'Double Strike (with the perk): arm a double'],
  ['Tab  1–9', 'pick a weapon'],
  ['Space', 'fire (in a volley: lock in)'],
  ['G', 'sight: look down your turret line'],
  ['F', 'Find: hold the camera on the next opponent'],
  ['C  V', 'follow-shell camera; overview'],
  ['M  N  - =', 'mute; next track; Master volume'],
  ['Mouse', 'drag to orbit, wheel to zoom'],
];

// Controls on a phone: [name, what it does].
const TOUCH = [
  ['Aim pad', 'right thumb. Drag like a trackpad: left and right turn the turret, up and down raise the barrel. Slow is precise, a flick goes far.'],
  ['Power bar', 'beside the pad. Drag up or down.'],
  ['FIRE', 'the big button (it reads Lock in in a volley). The weapon button above it opens your weapons.'],
  ['SIGHT', 'the camera rides behind your turret and looks down its line. Drag anywhere to aim. The − / + chip zooms 2×, 4×, 8× (or pinch). A compass tape lists the enemies with their range.'],
  ['Fine', 'the pad at a fifth of the speed, for the last correction.'],
  ['Find', 'hold the camera on an enemy. Tap again for the next; past the last it lets go.'],
  ['View', 'a high overview of the whole field.'],
  ['JET', 'left thumb. Hop about 25 m the way the hull faces. It costs a charge, not your shot or fuel.'],
  ['Drive arrows', '▲ ▼ drive (uses fuel), ◀ ▶ turn the hull. While a Guided Missile flies, ◀ ▶ (or a finger on the left or right half of the view) steer it.'],
  ['ORB / SAT', 'top of the Fire column once you own a mod. Tap, then tap again to deploy (it takes your turn).'],
  ['⚙', 'Settings: sound, full screen, and this guide.'],
  ['The view', 'one finger orbits the camera, two pinch to zoom.'],
];

export function guideTabs({ weapons, items, mods, perks, pay } = {}) {
  const P = { perDamage: 2, kill: 150, survive: 80, roundWin: 300, stipend: 150, ...(pay || {}) };
  const weaponList = weaponRows(weapons), itemList = itemRows(items);
  const modList = modRows(mods), perkList = perkRows(perks);
  const tabs = [];

  tabs.push({ id: 'basics', title: 'Basics', blocks: [
    { h: 'A turn' },
    { p: 'Set three numbers, then fire: **turret** (which way), **elevation** (how high) and **power** (how hard). Before you fire you may also drive a little (30 m of fuel a round), hop with a jump jet, and pick a weapon. The shell flies in an arc, digs a crater where it lands and hurts any tank nearby.' },
    { h: 'Take turns or together' },
    { list: [
      { name: 'Together (volley)', text: 'The default. Each human plans in turn and locks in a shot; then every tank fires at once and the shells fly together. Mutual kills happen. Online is always together.' },
      { name: 'Take turns', text: 'The classic game: one tank aims and fires at a time.' },
    ] },
    { h: 'Wind' },
    { p: 'The arrow under Power shows it, drawn from behind your turret. It pushes the shell sideways and carries it longer or shorter; the line beside it splits that for this shot. It shifts from turn to turn.' },
    { h: 'Damage' },
    { p: 'A blast hurts more the nearer it lands, and a direct hit most. Armor soaks damage before hit points. Blasts also dig the ground out from under tanks and buildings.' },
    { h: 'Rounds and money' },
    { p: `A match is a few rounds; the last tank standing wins the round. You earn $${P.perDamage} a point of damage, $${P.kill} a kill, $${P.survive} for surviving and $${P.roundWin} for the round win, plus a $${P.stipend} stipend every round. Between rounds you draft a perk (with Twists on), then shop in the armory. Perks last the whole match; mods last until they are shot down.` },
  ] });

  tabs.push({ id: 'controls', title: 'Controls', blocks: [
    { h: 'On a phone' },
    { rows: TOUCH.map(([name, text]) => ({ name, text })) },
    { h: 'Keys' },
    { keys: KEYS },
  ] });

  tabs.push({ id: 'weapons', title: 'Weapons', blocks: [
    { p: 'Shells are free and unlimited; the rest come from the armory between rounds.' },
    weaponList.length ? { rows: weaponList } : { p: 'No weapons to list.' },
    ...(itemList.length ? [{ h: 'Also in the armory' }, { rows: itemList }] : []),
  ] });

  const fams = familyRows(mods);
  tabs.push({ id: 'mods', title: 'Mods and perks', blocks: [
    { h: 'Mods' },
    { p: 'Equipment you put up on the field, not a weapon. By default you gain mods through the **perk draft** between rounds; the host can turn them on for everyone in the Lab.' },
    { p: '**Deploying a mod uses your turn** (no shot). It then stays up across rounds until it is shot down or wears out. Its health and turns left show on your player card.' },
    modList.length ? { rows: modList } : { p: 'No mods in this build.' },
    { h: 'Rock, paper, scissors' },
    { p: 'Every mod belongs to a family, and each family beats one and loses to another.' },
    { fams },
    { p: '**Flak is anti-air.** It bursts by a mod in the sky and can bring it down.' },
    { h: 'Perks' },
    { p: 'Drafted after each round (one of three) and kept for the match.' },
    perkList.length ? { rows: perkList } : { p: 'No perks to list.' },
  ] });

  const lab = labRows(mods);
  tabs.push({ id: 'lab', title: 'Lab', blocks: [
    { p: 'The Lab is on the launch screen under **Custom match** (the host sets it, and it travels to everyone online). It bends the house rules so you can try things.' },
    lab.length ? { rows: lab } : { p: 'No Lab options in this build.' },
    { p: 'Fog of war, Twists, terrain, wind and firing style are Custom match options too.' },
  ] });

  return tabs;
}

// A list of blocks as HTML.
export function renderBlocks(blocks) {
  const row = (r) => `<li><div class="g-top"><b>${esc(r.name)}</b>${r.tag ? ` <i class="g-tag">${esc(r.tag)}</i>` : ''}${r.meta ? ` <span class="g-meta">${esc(r.meta)}</span>` : ''}</div>${r.text ? `<div class="g-text">${rich(r.text)}</div>` : ''}${r.levels?.length ? `<div class="g-levels">${r.levels.map((l, i) => `L${i + 1} ${esc(l)}`).join(' · ')}</div>` : ''}</li>`;
  return blocks.filter(Boolean).map((b) => {
    if (b.h) return `<h3>${esc(b.h)}</h3>`;
    if (b.p) return `<p>${rich(b.p)}</p>`;
    if (b.rows || b.list) return `<ul class="g-rows">${(b.rows || b.list).map(row).join('')}</ul>`;
    if (b.keys) return `<dl class="g-keys">${b.keys.map(([k, d]) => `<dt>${k.split(/\s{1,}/).map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(d)}</dd>`).join('')}</dl>`;
    if (b.fams) {
      return `<div class="g-rps">${b.fams.map((f) => `<div class="g-fam${f.coming ? ' coming' : ''}"><b>${esc(f.name)}${f.coming ? ' <em>coming</em>' : ''}</b><span>beats ${esc(f.beatsName)}</span><small>${f.mods.length ? esc(f.mods.join(', ')) : esc(f.why)}</small></div>`).join('<span class="g-arrow" aria-hidden="true">›</span>')}</div>`;
    }
    return '';
  }).join('');
}

// ---------------------------------------------------------------- the page

let guide = null;
let lastTab = 'basics';

class Guide {
  constructor(tabs) {
    this.tabs = tabs;
    const el = this.el = document.createElement('div');
    el.id = 'guide';
    el.className = 'screen hidden';
    el.innerHTML = `
      <div class="g-card" role="dialog" aria-label="Guide" tabindex="-1">
        <div class="g-head"><h2>Guide</h2><button class="g-x" type="button" aria-label="Close guide">✕</button></div>
        <div class="g-tabs" role="tablist"></div>
        <div class="g-body"></div>
      </div>`;
    document.body.appendChild(el);
    this.card = el.querySelector('.g-card');
    this.body = el.querySelector('.g-body');
    const bar = el.querySelector('.g-tabs');
    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'g-tab';
      b.setAttribute('role', 'tab');
      b.dataset.tab = t.id;
      b.textContent = t.title;
      b.addEventListener('click', () => this.show(t.id));
      bar.appendChild(b);
    }
    el.querySelector('.g-x').addEventListener('click', () => this.close());
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });   // the backdrop
    // The page is not the tank's: keys typed here never reach the game (main.js
    // listens on window). Escape closes. keyup passes so a key held while it
    // opened still lets go.
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    }, true);
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  show(id) {
    const tab = this.tabs.find((t) => t.id === id) || this.tabs[0];
    lastTab = tab.id;
    for (const b of this.el.querySelectorAll('.g-tab')) {
      const on = b.dataset.tab === tab.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    this.body.innerHTML = renderBlocks(tab.blocks);
    this.body.scrollTop = 0;
  }

  open(id = lastTab) {
    this.show(id);
    this.el.classList.remove('hidden');
    this.card.focus({ preventScroll: true });   // so keys land inside the page
  }

  close() { this.el.classList.add('hidden'); }
}

// Builds the page from the data the first time, then reuses it.
export function openGuide(tab) {
  if (!guide) {
    if (!document.getElementById('guide-css')) {
      const link = document.createElement('link');
      link.id = 'guide-css';
      link.rel = 'stylesheet';
      link.href = new URL('../css/guide.css', import.meta.url).href;
      document.head.appendChild(link);
    }
    guide = new Guide(guideTabs({
      weapons: weaponData.WEAPONS, items: weaponData.ITEMS, mods: modData.MODS, perks: perkData.PERKS, pay: gameData.PAY,
    }));
  }
  guide.open(tab);
  return guide;
}
