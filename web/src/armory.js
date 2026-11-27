// The between-rounds stop as HTML: the stepper (Results · Skills · Armory),
// the round's pay by where it came from, the skill tree, the "Your kit" strip
// and the armory in sections (Weapons by tier, Gear, and Mods when the Lab
// sells them). main.js shows the screens and wires the buttons; everything here
// is a pure function of the game, so tests read it without a DOM.
//
// The rules it shows are docs/design-guide.md, "How you get things": skill
// points buy ranks in the skill tree (perks and mods, core/skills.js); money
// buys weapons and gear in the armory.

import { WEAPONS, WEAPON_BY_ID, ITEMS, TIERS, startKit } from './core/weapons.js';
import { PERK_BY_ID } from './core/perks.js';
import { SKILL_TABS, tabOf } from './core/skills.js';
import { MODS, MOD_BY_ID, MOD_BAYS } from './core/mods.js';
import { EARNINGS } from './core/game.js';
import { TANK } from './core/tank.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- the stepper

export const STEPS = [
  { id: 'results', name: 'Results' },
  { id: 'draft', name: 'Skills' },
  { id: 'armory', name: 'Armory' },
];

// `at` is the step showing; `draft` false leaves the Skills step out (no
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

// ---------------------------------------------------------------- the skill tree

// One branch's ranks as names: a mod's are its levels, a perk branch's its perks.
export function rankNames(b) {
  const mod = b.mod && MOD_BY_ID[b.mod];
  return b.ranks.map((id, i) => (mod ? `Level ${i + 1}` : PERK_BY_ID[id]?.name || id));
}

// What the next rank does, in a line.
export function rankText(b, i) {
  const mod = b.mod && MOD_BY_ID[b.mod];
  if (mod) return i === 0 ? PERK_BY_ID[b.ranks[0]]?.desc || '' : `${mod.name} level ${i + 1}: ${mod.levels?.[i] || ''}.`;
  return PERK_BY_ID[b.ranks[i]]?.desc || '';
}

// The tree as cards, one a branch: its ranks as a path (held ones lit), the
// next rank and what it does, and a button (or why it is shut, or Complete).
// Weapon branches first, then mods, then the perk branches; a branch `p` has
// started sorts ahead of the rest in each group. `tab` (SKILL_TABS) shows only
// that tab's branches; with none, all of them. A weapon's fork, still open, is
// two choices side by side: taking one shuts the other for the match.
export function skillTreeHtml(game, p, tab = null) {
  const tree = game.skillTree(p).filter((b) => !tab || tabOf(b) === tab);
  const order = (b) => (b.weapon ? 0 : b.mod ? 2 : 4) - (b.held > 0 ? 1 : 0);
  const can = p.points > 0;
  return [...tree].sort((x, y) => order(x) - order(y)).map((b) => {
    if (b.options) return forkHtml(b, can);
    const names = rankNames(b);
    const path = names.map((n, i) => `<span class="sk-rank${i < b.held ? ' have' : i === b.held ? ' next' : ''}">${esc(n)}</span>`).join('<span class="sk-arrow">›</span>');
    const done = !b.next;
    const nextName = done ? '' : names[b.held];
    const foot = done
      ? '<span class="sk-done">Complete</span>'
      : b.lock
        ? `<button class="buy" disabled>${esc(b.lock)}</button>`
        : `<button class="buy" data-id="${b.next}" ${can ? '' : 'disabled'} aria-label="Take ${esc(b.name)} rank ${b.held + 1}">${b.held ? `Rank ${b.held + 1}` : 'Start'}</button>`;
    const title = b.taken ? `${b.name} · ${PERK_BY_ID[b.taken].name}` : b.name;
    return `<div class="shop-item draft-item sk-branch${b.mod ? ' sk-mod' : ''}${b.weapon ? ' sk-weapon' : ''}${b.held ? ' sk-started' : ''}${done ? ' sk-full' : ''}">
      <div class="si-head"><b>${esc(title)}</b><span class="ar-badge">${b.mod ? 'Mod' : esc(b.theme)}</span></div>
      <div class="sk-path">${path}</div>
      ${done ? '' : `<div class="desc"><b>${esc(nextName)}:</b> ${esc(rankText(b, b.held))}</div>`}
      <div class="si-foot"><span class="si-gives">${b.held} of ${b.ranks.length}</span>${foot}</div>
    </div>`;
  }).join('');
}

// A weapon branch whose fork is still open: the two variants, each with what
// it does and its own button, and the upgrade that follows either.
function forkHtml(b, can) {
  const up = PERK_BY_ID[b.ranks[1]];
  const side = (id) => {
    const k = PERK_BY_ID[id];
    return `<div class="sk-side sk-${k.style}">
      <div class="sk-side-name">${esc(k.name)}</div>
      <div class="desc">${esc(k.desc.replace(/^[^:]*: /, ''))}</div>
      <button class="buy" data-id="${id}" ${can ? '' : 'disabled'} aria-label="Make ${esc(b.name)} the ${esc(k.name)}">${esc(k.name)}</button>
    </div>`;
  };
  return `<div class="shop-item draft-item sk-branch sk-weapon sk-fork">
    <div class="si-head"><b>${esc(b.name)}</b><span class="ar-badge">Pick one</span></div>
    <div class="sk-sides">${b.options.map(side).join('<span class="sk-or">or</span>')}</div>
    <div class="si-foot"><span class="si-gives">Then: ${esc(up.name)}</span><span class="sk-note">The other shuts for the match</span></div>
  </div>`;
}

// The skill screen's tabs (core/skills.js SKILL_TABS) that have a branch this
// match, each with how many ranks are held there.
export function skillTabs(game, p) {
  const tree = game.skillTree(p);
  return SKILL_TABS.map((t) => {
    const mine = tree.filter((b) => tabOf(b) === t.id);
    return { ...t, held: mine.reduce((n, b) => n + b.held, 0), count: mine.length };
  }).filter((t) => t.count > 0);
}

// The tabs as buttons; `tab` is the open one.
export function skillTabsHtml(game, p, tab) {
  const tabs = skillTabs(game, p).map((t) => `<button class="sk-tab${t.id === tab ? ' on' : ''}" role="tab" aria-selected="${t.id === tab}" data-tab="${t.id}">${esc(t.name)}${t.held ? `<span class="sk-tab-n">${t.held}</span>` : ''}</button>`);
  return `<div class="sk-tabs" role="tablist">${tabs.join('')}</div>`;
}

// ---------------------------------------------------------------- your kit

// Everything `p` holds, short: ammo, gear for next round, mods with levels, perk tags.
export function kitHtml(game, p) {
  const chips = [];
  for (const w of WEAPONS) {
    if (w.hidden) continue;
    const n = p.inventory?.[w.id];
    const name = game.weaponName ? game.weaponName(p, w.id) : w.name;   // "Napalm · Sticky"
    if (n === Infinity || n === null) chips.push(`<span class="ar-chip">${esc(name)} ∞</span>`);
    else if (n > 0) chips.push(`<span class="ar-chip">${esc(name)} ×${n}</span>`);
  }
  if (p.jets > 0) chips.push(`<span class="ar-chip">Jump Jets ×${p.jets}</span>`);
  if (p.pendingArmor > 0) chips.push(`<span class="ar-chip gear">+${p.pendingArmor} armor</span>`);
  if (p.pendingFuel > 0) chips.push(`<span class="ar-chip gear">+${p.pendingFuel} m fuel</span>`);
  const mods = MODS.filter((d) => game.modLevel(p, d.id) > 0).map((d) => `<span class="ar-chip mod">${esc(d.name)} L${game.modLevel(p, d.id)}</span>`);
  // A weapon variant reads as its full name ("Napalm · Flood", + once upgraded),
  // not as a two-letter tag.
  const variants = [...new Set((p.perks || []).map((id) => PERK_BY_ID[id]).filter((k) => k?.variant).map((k) => k.weapon))]
    .map((wid) => {
      const up = (p.perks || []).some((id) => PERK_BY_ID[id]?.upgrade && PERK_BY_ID[id].weapon === wid);
      const name = game.weaponName ? game.weaponName(p, wid) : wid;
      return `<span class="ar-chip var">${esc(name)}${up ? ' +' : ''}</span>`;
    });
  const perks = [...new Set(p.perks || [])].filter((id) => !PERK_BY_ID[id]?.weapon).map((id) => {
    const k = PERK_BY_ID[id];
    const n = (p.perks || []).filter((x) => x === id).length;
    return k ? `<span class="perk" title="${esc(k.name)}: ${esc(k.desc)}">${k.tag}${n > 1 ? `×${n}` : ''}</span>` : '';
  });
  const points = p.points > 0 ? `<span class="ar-chip pts">${p.points} skill point${p.points > 1 ? 's' : ''}</span>` : '';
  return `<div class="ar-kit-row"><label>Your kit</label>${chips.join('')}${mods.join('')}${variants.join('')}${perks.join('')}${points}</div>`;
}

// ---------------------------------------------------------------- the armory

// A weapon's numbers in a few words: "70 dmg · 22 m", "5 × 28 dmg",
// "50 dmg · 16 m + 3 × 22", or its role. Give it the weapon as the tank fires
// it (game.weaponOf), so a variant's numbers show.
export function weaponStats(w) {
  const blast = (x) => (x?.impact || []).flatMap((q) => (q.type === 'roll' ? q.then : [q])).find((q) => q.type === 'blast');
  const split = (w.flight || []).find((q) => q.type === 'split' || q.type === 'airburst');
  if (split) {
    const b = blast(WEAPON_BY_ID[split.child]);
    return b ? `${split.count} × ${b.damage} dmg` : '';
  }
  const b = blast(w);
  const thrown = (w.impact || []).find((q) => q.type === 'throw');
  const tb = thrown && blast(WEAPON_BY_ID[thrown.child]);
  return b ? `${b.damage} dmg · ${b.radius} m${tb ? ` + ${thrown.count} × ${tb.damage}` : ''}` : '';
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
    const as = game.weaponOf ? game.weaponOf(p, w.id) : w;   // with the variant it took in the tree
    return card({
      id: w.id, name: as.label || w.name, tag: w.role, stats: weaponStats(as), desc: as.desc,
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
  const mods = MODS.filter((d) => Number.isFinite(game.priceOf(p, d.id)) || (game.cfg.lab?.[d.id] === 'shop' && game.modLevel(p, d.id) > 0)).map((d) => {
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
    + section('Mods', `This match's Lab sells these here (${bays} of ${MOD_BAYS} mod bays used).`, mods);
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
