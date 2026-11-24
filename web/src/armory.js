// The between-rounds stop as HTML: the stepper (Results · Draft · Armory),
// the round's pay by where it came from, the draft's cards badged by kind, the
// "Your kit" strip and the armory in sections (Weapons by tier, Gear, Mod
// upgrades). main.js shows the screens and wires the buttons; everything here
// is a pure function of the game, so tests read it without a DOM.
//
// The rules it shows are docs/design-guide.md, "How you get things": the
// draft gives new things, the armory stocks and upgrades them.

import { WEAPONS, WEAPON_BY_ID, ITEMS, TIERS, startKit } from './core/weapons.js';
import { PERK_BY_ID } from './core/perks.js';
import { MODS, MOD_BY_ID, MOD_BAYS } from './core/mods.js';
import { EARNINGS } from './core/game.js';
import { TANK } from './core/tank.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- the stepper

export const STEPS = [
  { id: 'results', name: 'Results' },
  { id: 'draft', name: 'Draft' },
  { id: 'armory', name: 'Armory' },
];

// `at` is the step showing; `draft` false leaves the Draft step out (no
// perks in this match).
export function stepperHtml(at, { draft = true, round = 1 } = {}) {
  const steps = STEPS.filter((s) => draft || s.id !== 'draft');
  const here = steps.findIndex((s) => s.id === at);
  return `<span class="ar-round">Before round ${round + 1}</span>` + steps.map((s, i) =>
    `<span class="ar-step${i === here ? ' on' : i < here ? ' done' : ''}"><i>${i + 1}</i>${s.name}</span>`).join('<span class="ar-sep"></span>');
}

// ---------------------------------------------------------------- results

export const EARNING_NAMES = { damage: 'damage', kill: 'kills', mod: 'mods shot down', survive: 'survived', win: 'round win', stipend: 'stipend' };

// One line of what `p` earned this round: "$530: 200 damage · 150 kills · ...".
export function earnedLine(p) {
  const e = p.earned || {};
  const parts = EARNINGS.filter((k) => e[k] > 0).map((k) => `<span>$${e[k]} ${EARNING_NAMES[k]}</span>`);
  const total = EARNINGS.reduce((s, k) => s + (e[k] || 0), 0);
  return { total, html: parts.join('<span class="ar-dot">·</span>') };
}

// The results table: wins, what each tank earned this round and why, funds.
export function resultsHtml(players) {
  return `<tr><th></th><th>Tank</th><th>Wins</th><th>Earned</th><th>Funds</th></tr>` + players.map((p) => {
    const { total, html } = earnedLine(p);
    return `<tr><td><span class="swatch" style="background:${p.color}"></span></td>
      <td>${esc(p.name)}${p.alive ? '' : ' <span class="ar-dead">(destroyed)</span>'}<div class="ar-earned">${html}</div></td>
      <td>${p.wins}</td><td class="ar-plus">+$${total}</td><td>$${p.money}</td></tr>`;
  }).join('');
}

// ---------------------------------------------------------------- the draft

// What kind of card a perk is: a plain perk, a new mod, or a mod's next level.
export function cardKind(game, p, perk) {
  const id = Object.keys(perk.mods || {})[0];
  if (id && perk.unlock) return { kind: 'new', label: 'New mod', mod: MOD_BY_ID[id], level: 1 };
  if (id && perk.levelUp) return { kind: 'level', label: 'Mod level', mod: MOD_BY_ID[id], level: game.modLevel(p, id) + 1 };
  return { kind: 'perk', label: 'Perk' };
}

export function draftCardsHtml(game, p) {
  return (game.draft[p.id] || []).map((id) => {
    const k = PERK_BY_ID[id];
    const c = cardKind(game, p, k);
    const lvl = c.mod ? `<div class="ar-level"><b>${esc(c.mod.name)} · level ${c.level}</b>${c.mod.levels?.[c.level - 1] ? `: ${esc(c.mod.levels[c.level - 1])}` : ''}</div>` : '';
    return `<div class="shop-item draft-item ar-${c.kind}">
      <div class="si-head"><b>${esc(k.name)}</b><span class="ar-badge">${c.label}</span></div>
      ${lvl}<div class="desc">${esc(k.desc)}</div>
      <button class="buy" data-id="${id}">Take it</button>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------- your kit

// Everything `p` holds, short: ammo, gear for next round, mods with levels, perk tags.
export function kitHtml(game, p) {
  const chips = [];
  for (const w of WEAPONS) {
    if (w.hidden) continue;
    const n = p.inventory?.[w.id];
    if (n === Infinity || n === null) chips.push(`<span class="ar-chip">${esc(w.name)} ∞</span>`);
    else if (n > 0) chips.push(`<span class="ar-chip">${esc(w.name)} ×${n}</span>`);
  }
  if (p.jets > 0) chips.push(`<span class="ar-chip">Jump Jets ×${p.jets}</span>`);
  if (p.pendingArmor > 0) chips.push(`<span class="ar-chip gear">+${p.pendingArmor} armor</span>`);
  if (p.pendingFuel > 0) chips.push(`<span class="ar-chip gear">+${p.pendingFuel} m fuel</span>`);
  const mods = MODS.filter((d) => game.modLevel(p, d.id) > 0).map((d) => `<span class="ar-chip mod">${esc(d.name)} L${game.modLevel(p, d.id)}</span>`);
  const perks = [...new Set(p.perks || [])].map((id) => {
    const k = PERK_BY_ID[id];
    const n = (p.perks || []).filter((x) => x === id).length;
    return k ? `<span class="perk" title="${esc(k.name)}: ${esc(k.desc)}">${k.tag}${n > 1 ? `×${n}` : ''}</span>` : '';
  });
  return `<div class="ar-kit-row"><label>Your kit</label>${chips.join('')}${mods.join('')}${perks.join('')}</div>`;
}

// ---------------------------------------------------------------- the armory

// A weapon's numbers in a few words: "70 dmg · 22 m", "5 × 28 dmg", or its role.
export function weaponStats(w) {
  const blast = (x) => (x?.impact || []).flatMap((q) => (q.type === 'roll' ? q.then : [q])).find((q) => q.type === 'blast');
  const split = (w.flight || []).find((q) => q.type === 'split' || q.type === 'airburst');
  if (split) {
    const b = blast(WEAPON_BY_ID[split.child]);
    return b ? `${split.count} × ${b.damage} dmg` : '';
  }
  const b = blast(w);
  return b ? `${b.damage} dmg · ${b.radius} m` : '';
}

const GEAR_INFO = {
  armor: { have: (p) => p.pendingArmor, owned: (n) => `+${n} fitted`, none: 'None fitted', gives: '+30 armor' },
  fuel: { have: (p) => p.pendingFuel, owned: (n) => `+${n} m loaded`, none: 'None loaded', gives: `+${TANK.fuelCan} m of driving` },
  jet: { have: (p) => p.jets, owned: (n) => `You have ${n}`, none: 'You have none', gives: `${ITEMS.find((i) => i.id === 'jet')?.bundle || 1} charges` },
};

function card({ id, name, cls = '', tag = '', stats = '', desc, owned, has, gives, price, money, justBought, locked = '' }) {
  const short = Number.isFinite(price) ? price - money : 0;
  const button = locked
    ? `<button class="buy" disabled>${locked}</button>`
    : `<button class="buy" data-id="${id}" aria-label="Buy ${esc(name)} for $${price}" ${short > 0 || !Number.isFinite(price) ? 'disabled' : ''}>${Number.isFinite(price) ? `$${price}` : 'Max'}</button>`;
  return `<div class="shop-item ${cls}${short > 0 && !locked ? ' cant' : ''}${locked ? ' locked' : ''}${id === justBought ? ' bought' : ''}">
    <div class="si-head"><b>${esc(name)}</b><span class="si-own${has ? ' has' : ''}">${owned}</span></div>
    ${tag || stats ? `<div class="ar-tags">${tag ? `<span class="ar-role">${tag}</span>` : ''}${stats ? `<span class="ar-stats">${stats}</span>` : ''}</div>` : ''}
    <div class="desc">${esc(desc)}</div>
    <div class="si-foot">
      <span class="si-gives">${gives}${short > 0 && !locked ? `<span class="si-short">need $${short} more</span>` : ''}</span>
      ${button}
    </div>
  </div>`;
}

const section = (title, note, cards) => (cards.length ? `<div class="shop-section">${title}${note ? ` <small>${note}</small>` : ''}</div>${cards.join('')}` : '');

// The weapons this match sells (on in the match, not Guided Missiles online,
// Scouts only with fog), in armory order.
export function armoryWeapons(game) {
  return WEAPONS.filter((w) => !w.hidden && !w.infinite && game.weaponOn(w.id) && !(game.online && w.id === 'guided') && !(w.fog && !game.cfg.fog));
}

export function armoryHtml(game, p, justBought = null) {
  const money = p.money;
  const weapon = (w) => {
    const open = game.inStock(w.id);
    const have = p.inventory?.[w.id] || 0;
    return card({
      id: w.id, name: w.name, tag: w.role, stats: weaponStats(w), desc: w.desc,
      owned: `You have ${have}`, has: have > 0, gives: `${w.bundle} per buy`,
      price: game.priceOf(p, w.id), money, justBought,
      locked: open ? '' : `Round ${game.opensOn(w.id) + 1}`,
    });
  };
  const all = armoryWeapons(game);
  const tier = (t) => all.filter((w) => (w.tier || 'standard') === t).map(weapon);
  const advancedOpen = all.some((w) => w.tier === 'advanced' && game.inStock(w.id));
  const advancedRound = Math.min(...all.filter((w) => w.tier === 'advanced').map((w) => game.opensOn(w.id) + 1));
  const gear = ITEMS.map((it) => {
    const info = GEAR_INFO[it.id];
    const have = info ? info.have(p) : 0;
    return card({
      id: it.id, name: it.name, cls: 'gear', desc: it.desc, owned: have ? info.owned(have) : info?.none || '', has: have > 0,
      gives: info?.gives || '', price: game.priceOf(p, it.id), money, justBought,
    });
  });
  const mods = MODS.filter((d) => game.modLevel(p, d.id) > 0 || game.cfg.lab?.[d.id] === 'shop').map((d) => {
    const have = game.modLevel(p, d.id);
    const top = have >= d.maxLevel;
    return card({
      id: d.id, name: d.name, cls: 'mod', tag: have ? 'Mod' : 'New mod', desc: top ? d.desc : `Level ${have + 1}: ${d.levels?.[have] || ''}.`,
      owned: have ? `Level ${have} of ${d.maxLevel}` : 'None', has: have > 0,
      gives: top ? 'Top level' : `To level ${have + 1}`, price: game.priceOf(p, d.id), money, justBought,
    });
  });
  const bays = MODS.filter((d) => game.modLevel(p, d.id) > 0).length;
  return section('Weapons', 'Shells are free and never run out. Everything else is ammo: it stays until you fire it.', tier('standard'))
    + section(advancedOpen ? 'Advanced weapons' : `Advanced weapons <span class="ar-lock">open before round ${advancedRound}</span>`,
      advancedOpen ? 'The heavy hitters and tricks.' : 'The heavy hitters and tricks, from the next armory on.', tier('advanced'))
    + section('Gear', 'Armor and fuel are for the next round; jump jet charges keep.', gear)
    + section('Mod upgrades', `New mods come from the draft; the armory raises the ones you have (${bays} of ${MOD_BAYS} mod bays used).`, mods);
}

// The starting kit as words, for the first round's banner and the guide:
// "Shells, 1 Breacher, 1 Roller, 1 Mound, 2 Rangefinders, 1 Guided Missile".
export function kitWords({ online = false } = {}) {
  return Object.entries(startKit()).filter(([id]) => !(online && id === 'guided')).map(([id, n]) => {
    const w = WEAPON_BY_ID[id];
    return n === Infinity ? `${w.name}s` : `${n} ${w.name}${n > 1 ? 's' : ''}`;
  }).join(', ');
}

export { TIERS };
