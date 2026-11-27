// The run on screen (the rules are in core/run.js): the Run and Continue
// buttons on the launch screen, and the run's own screen (#run) with its views:
//
//   map      the stops in tiers (left to right in landscape, top to bottom in
//            portrait) joined by paths, and a panel with the tapped stop's
//            details and Go. The header shows hulls, money and skill points.
//   skills   spend skill points: the skill tree of armory.js, on a kit game
//   cache    three cards, take one
//   depot    the armory of armory.js, and swap one variant
//   result   after a fight: won or lost, the reward, a hull lost
//   summary  the end of the run: the route, the fights, the build
//
// main.js hands it four things: start a match from a config, put the menu's
// field back after a match, show the launch screen, and the human's name. It
// calls matchOver(game) at the end of every match; a run's match is handled
// here (and the usual match-over card is skipped).

import {
  RUN, KINDS, runMap, startRun, reachable, chooseStop, currentStop, applyFightResult, applyCache, swapVariant,
  leaveDepot, setKit, forksTaken, allyChoices, matchConfig, kitGame, kitOf, fightWon, loadRun, saveRun, clearRun,
  runSummary, stopDetails, rewardWords, startFight, fightCutOff, runProgress, allyWords, bossWords,
} from './core/run.js';
import { BOSS } from './core/boss.js';
import { PERK_BY_ID } from './core/perks.js';
import { WEAPON_BY_ID } from './core/weapons.js';
import { skillTreeHtml, skillTabsHtml, skillTabs, kitHtml, armoryHtml } from './armory.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Each kind's mark on the map: a small drawing, our own.
const ICONS = {
  start: '<path d="M7 20V4m0 1h10l-3 4 3 4H7"/>',
  fight: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1.2" class="f"/>',
  elite: '<path d="M12 2.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 15.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/><circle cx="12" cy="11.6" r="1.6" class="f"/>',
  cache: '<rect x="4" y="7" width="16" height="12" rx="1"/><path d="M4 11h16M12 7v12M8 7l2-3h4l2 3"/>',
  depot: '<path d="M3.5 11L12 4.5l8.5 6.5V20h-17z"/><path d="M9.5 20v-5.5h5V20"/>',
  boss: '<path d="M4 20V9h3v2h2.5V8h5v3H17V9h3v11z"/><path d="M10.5 20v-4h3v4"/>',
};
const icon = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind] || ICONS.fight}</svg>`;
const HULL = '<svg viewBox="0 0 24 14" aria-hidden="true"><path d="M2 9h20l-3 4H5z"/><path d="M7 9V5h8v4M15 6.5h7"/></svg>';

// The point on the map of stop `index` of `count` in column `col` of `cols`,
// as percentages: across the long side by column, along the short side by index.
export function nodeAt(col, cols, index, count, portrait) {
  const a = ((col + 0.5) / cols) * 100;
  const b = ((index + 0.5) / count) * 100;
  return portrait ? { x: b, y: a } : { x: a, y: b };
}

export class RunUI {
  constructor({ startMatch, toMenu, showSetup, begin = () => {}, name = () => 'You', click = () => {} }) {
    Object.assign(this, { startMatchFn: startMatch, toMenu, showSetup, begin, name, click });
    if (!document.getElementById('run-css')) {
      document.head.appendChild(Object.assign(document.createElement('link'), { id: 'run-css', rel: 'stylesheet', href: new URL('../css/run.css', import.meta.url).href }));
    }
    this.state = loadRun(localStorage);
    this.view = 'map';
    this.sel = null;          // the stop tapped on the map
    this.ally = 0;            // which of the ally choices
    this.fighting = false;    // a run match is being played
    this.tab = null;          // the skill screen's tab
    this.buildLaunch();
    const el = this.el = document.createElement('div');
    el.id = 'run';
    el.className = 'screen hidden';
    el.innerHTML = `<div class="run-wrap"><header class="run-head"></header><div class="run-body"></div></div>`;
    document.body.appendChild(el);
    this.head = el.querySelector('.run-head');
    this.body = el.querySelector('.run-body');
    el.addEventListener('click', (e) => this.onClick(e));
    this.portrait = matchMedia('(orientation: portrait)');
    // The map lays out by orientation: draw it again when that turns.
    addEventListener('resize', () => {
      if (this.view === 'map' && !el.classList.contains('hidden') && this.drawnPortrait !== this.portrait.matches) this.render();
    });
  }

  // ---------------------------------------------------------------- the launch screen

  buildLaunch() {
    const top = document.querySelector('#setup .launch-top');
    if (!top) return;
    const row = this.launch = document.createElement('div');
    row.className = 'run-launch';
    row.innerHTML = `
      <button id="run-new" class="run-go" title="A short solo campaign: fights across a map, ending at the Bulwark">Run<small>fights on a map, then the boss</small></button>
      <button id="run-continue" class="run-go hidden">Continue run<small></small></button>
      <button id="run-abandon" class="run-abandon hidden">Abandon</button>`;
    const hint = top.querySelector('.launch-hint');
    (hint || top.lastElementChild).after(row);
    row.querySelector('#run-new').onclick = () => {
      if (this.live() && !this.confirmNew) { this.confirmNew = true; this.refreshLaunch(); return; }
      this.begin();
      this.state = startRun((Math.random() * 1e9) >>> 0, this.name() || 'You');
      this.save();
      this.open();
    };
    row.querySelector('#run-continue').onclick = () => { this.begin(); this.open(); };
    row.querySelector('#run-abandon').onclick = () => {
      if (!this.confirmAbandon) { this.confirmAbandon = true; this.refreshLaunch(); setTimeout(() => { this.confirmAbandon = false; this.refreshLaunch(); }, 3000); return; }
      this.confirmAbandon = false;
      clearRun(localStorage);
      this.state = null;
      this.refreshLaunch();
    };
    this.refreshLaunch();
  }

  live() { return !!this.state && !this.state.over; }

  refreshLaunch() {
    if (!this.launch) return;
    const live = this.live();
    const $ = (id) => this.launch.querySelector(id);
    $('#run-continue').classList.toggle('hidden', !live);
    $('#run-abandon').classList.toggle('hidden', !live);
    $('#run-abandon').textContent = this.confirmAbandon ? 'Tap again to abandon' : 'Abandon';
    $('#run-new').classList.toggle('alt', live);
    $('#run-new').innerHTML = live
      ? (this.confirmNew ? 'New run?<small>tap again: the run in progress ends</small>' : 'New run<small>start a fresh map</small>')
      : 'Run<small>fights on a map, then the boss</small>';
    if (live) {
      const s = this.state;
      const pr = runProgress(s);
      $('#run-continue small').textContent = fightCutOff(s)
        ? `stop ${pr.n} of ${pr.of} · its fight starts over`
        : `stop ${pr.n} of ${pr.of} · ${s.hulls} spare hull${s.hulls === 1 ? '' : 's'}`;
    }
    if (this.confirmNew) setTimeout(() => { this.confirmNew = false; this.refreshLaunch(); }, 3000);
  }

  // ---------------------------------------------------------------- the run's screen

  save() { if (this.state) saveRun(localStorage, this.state); }

  open(view = null) {
    document.getElementById('setup').classList.add('hidden');
    this.el.classList.remove('hidden');
    const stop = currentStop(this.state);
    this.view = view || (this.state.over ? 'summary' : stop && !this.state.done && (stop.kind === 'cache' || stop.kind === 'depot') ? stop.kind : 'map');
    this.sel = stop && !this.state.done ? stop.id : null;
    this.render();
  }

  close() {
    this.el.classList.add('hidden');
    this.refreshLaunch();
    this.showSetup();
  }

  render() {
    if (!this.state) return;
    this.el.dataset.view = this.view;
    this.renderHead();
    const v = this.view;
    this.body.innerHTML = v === 'skills' ? this.skillsHtml() : v === 'cache' ? this.cacheHtml() : v === 'depot' ? this.depotHtml()
      : v === 'result' ? this.resultHtml() : v === 'summary' ? this.summaryHtml() : this.mapHtml();
    this.body.scrollTop = 0;
  }

  renderHead() {
    const s = this.state;
    const k = s.kit;
    const hulls = Array.from({ length: RUN.hulls }, (_, i) => `<i class="run-hull${i < s.hulls ? '' : ' lost'}">${HULL}</i>`).join('');
    const pts = k.points > 0;
    const back = this.view === 'skills' ? '<button class="run-hbtn" data-act="map">Map</button>' : '';
    const pr = runProgress(s);
    this.head.innerHTML = `
      <span class="run-brand">RUN</span>
      <span class="run-prog" title="${esc(pr.text)}"><span class="long">Stop <b>${pr.n}</b> of ${pr.of}<i> · ${esc(pr.name)}</i></span><span class="short"><b>${pr.n}</b>/${pr.of}</span></span>
      <span class="run-stat run-hulls" title="Spare hulls: a lost fight costs one">${hulls}</span>
      <span class="run-stat run-money" title="Money: spend it at a Depot">$${k.money}</span>
      <span class="run-stat run-pts${pts ? ' on' : ''}" title="Skill points">${k.points} pt${k.points === 1 ? '' : 's'}</span>
      <span class="run-hsp"></span>
      ${back}${this.view === 'map' && !s.over ? `<button class="run-hbtn${pts ? ' hot' : ''}" data-act="skills">Skills${pts ? ` <b>${k.points}</b>` : ''}</button>` : ''}
      ${this.view === 'map' || this.view === 'skills' ? '<button class="run-hbtn" data-act="menu">Menu</button>' : ''}`;
  }

  // ---------------------------------------------------------------- the map

  mapHtml() {
    const s = this.state;
    const map = runMap(s.seed);
    const portrait = this.drawnPortrait = this.portrait.matches;
    const cols = map.tiers.length + 1;
    const open = new Set(reachable(s));
    const path = new Set(s.path);
    const hereTier = s.at ? map.byId[s.at].tier : -1;
    const pos = { start: nodeAt(0, cols, 0, 1, portrait) };
    map.tiers.forEach((tier, t) => tier.forEach((st) => { pos[st.id] = nodeAt(t + 1, cols, st.index, tier.length, portrait); }));
    const lines = [];
    const line = (a, b, cls) => lines.push(`<line x1="${pos[a].x}" y1="${pos[a].y}" x2="${pos[b].x}" y2="${pos[b].y}" class="${cls}"/>`);
    for (const st of map.tiers[0]) line('start', st.id, s.path[0] === st.id ? 'walked' : s.at == null ? 'open' : '');
    for (const st of map.stops) {
      for (const id of st.next) {
        const i = s.path.indexOf(st.id);
        const walked = i >= 0 && s.path[i + 1] === id;
        line(st.id, id, walked ? 'walked' : st.id === s.at && open.has(id) ? 'open' : '');
      }
    }
    const node = (st) => {
      const cls = ['run-node', `k-${st.kind}`];
      if (path.has(st.id)) cls.push('visited');
      if (st.id === s.at) cls.push('here');
      if (open.has(st.id)) cls.push('open');
      else if (!path.has(st.id) && st.tier <= hereTier) cls.push('gone');
      if (st.id === this.sel) cls.push('sel');
      const p = pos[st.id];
      const won = s.log.filter((l) => l.stop === st.id && l.won != null).pop();
      const mark = won ? `<em class="${won.won ? 'w' : 'l'}">${won.won ? '✓' : '✗'}</em>` : '';
      return `<button class="${cls.join(' ')}" style="left:${p.x}%;top:${p.y}%" data-stop="${st.id}" aria-label="${esc(KINDS[st.kind].name)}">${icon(st.kind)}${mark}<span>${esc(KINDS[st.kind].name)}</span></button>`;
    };
    const p0 = pos.start;
    return `<div class="run-mapview${portrait ? ' portrait' : ''}">
      <div class="run-map"><div class="run-field">
        <svg class="run-lines" viewBox="0 0 100 100" preserveAspectRatio="none">${lines.join('')}</svg>
        <span class="run-node k-start visited" style="left:${p0.x}%;top:${p0.y}%">${icon('start')}</span>
        ${map.stops.map(node).join('')}
      </div></div>
      <aside class="run-panel">${this.panelHtml()}</aside>
    </div>`;
  }

  // The panel beside the map: the tapped stop, or where you are.
  panelHtml() {
    const s = this.state;
    const map = runMap(s.seed);
    const st = this.sel ? map.byId[this.sel] : null;
    if (!st) {
      const g = kitGame(s);
      const n = reachable(s).length;
      return `<h3>${s.at ? 'Where next?' : 'Your run'}</h3>
        <p class="run-note">${n ? `Tap a lit stop to see what waits there. ${s.at ? '' : 'Every stop shows its world, its foes and its reward before you go.'}` : ''}</p>
        <p class="run-note">A run's fight pays ${Math.round(RUN.matchPay * 100)}% of a usual match's money, on top of the stop's reward: spend it well at a Depot.</p>
        ${s.kit.points > 0 ? `<p class="run-note hot">You have ${s.kit.points} skill point${s.kit.points > 1 ? 's' : ''}: spend ${s.kit.points > 1 ? 'them' : 'it'} under Skills.</p>` : ''}
        <div class="run-kit">${kitHtml(g, g.players[0])}</div>`;
    }
    const here = st.id === s.at && !s.done;
    const can = reachable(s).includes(st.id);
    const cut = here && fightCutOff(s);
    const of = `Stop ${st.tier + 1} of ${map.tiers.length}`;
    let body = '';
    if (st.match) {
      const d = stopDetails(st);
      const foes = d.foes.map((f) => `<li><b>${esc(f.name)}</b> <span class="run-lvl">${esc(f.level)}</span>${f.extra ? `<small>${esc(f.extra)}</small>` : ''}</li>`).join('');
      body = `
        <div class="run-facts"><span>${esc(d.world)}</span><span>${esc(d.wind)}</span><span>${esc(d.edges)}</span><span>${esc(d.time)}</span></div>
        <div class="run-mod"><b>${esc(d.modifier)}</b>${d.modifierDesc && st.match.modifier !== 'clear' ? ` · ${esc(d.modifierDesc)}` : ''}</div>
        <div class="run-sub">${st.kind === 'boss' ? 'The boss' : d.foes.length > 1 ? 'Foes' : 'Foe'} · ${d.rounds} round${d.rounds > 1 ? 's' : ''}</div>
        <ul class="run-foes">${foes}</ul>`;
      if (st.kind === 'boss') body += `<ul class="run-bossfacts">${bossWords().lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${this.allyHtml()}`;
      else body += `<div class="run-reward"><span>Reward</span> ${esc(rewardWords({ ...st.reward, points: (st.reward.points || 0) + RUN.winPoints }))}</div>`;
    } else if (st.kind === 'cache') {
      body = `<p class="run-note">No fight. Take one of three:</p><ul class="run-foes">${st.offers.map((o) => `<li><b>${esc(o.name)}</b> <small>${esc(offerWords(o))}</small></li>`).join('')}</ul>`;
    } else if (st.kind === 'depot') {
      body = `<p class="run-note">No fight. The armory is open (you have $${s.kit.money}), and you may turn one weapon's variant the other way.</p>`;
    }
    let go = '';
    if (cut) body += '<p class="run-note run-cut">This fight was left unfinished when the page closed. It starts over from the first shot, with the kit you brought to it.</p>';
    if (here) go = `<button class="primary run-gobtn" data-act="enter">${st.match ? (cut ? 'Start the fight over' : s.log.some((l) => l.stop === st.id) ? 'Try again' : 'Fight') : st.kind === 'cache' ? 'Open the cache' : 'Enter the depot'}</button>`;
    else if (can) go = `<button class="primary run-gobtn" data-act="go" data-stop="${st.id}">Go</button>`;
    else go = `<p class="run-note">${s.path.includes(st.id) ? 'Been here.' : 'Not on your path from here.'}</p>`;
    return `<div class="run-ptitle k-${st.kind}">${icon(st.kind)}<div><h3>${esc(KINDS[st.kind].name)}</h3><small>${of}</small></div><button class="run-x" data-act="unsel" aria-label="Close">✕</button></div>
      <p class="run-kdesc">${esc(KINDS[st.kind].desc)}</p>${body}${go}`;
  }

  allyHtml() {
    const choices = allyChoices(this.state);
    this.ally = Math.min(this.ally, choices.length - 1);
    const card = (f, i) => {
      const w = allyWords(f);
      return `<button class="run-ally${i === this.ally ? ' on' : ''}" data-act="ally" data-i="${i}"><b>${esc(f.name)} <span class="run-lvl">${esc(w.level)}</span></b>`
        + `<small>${w.ranks.length ? esc(w.ranks.join(' · ')) : 'No ranks'}</small></button>`;
    };
    return `<div class="run-sub">Your ally${choices.length > 1 ? ': pick one' : ''}</div>
      <div class="run-allies">${choices.map(card).join('')}</div>
      <p class="run-note">${this.state.beaten.length ? 'A tank you beat on the way fights beside you.' : 'You beat nobody on the way, so a plain CPU comes along.'}</p>`;
  }

  // ---------------------------------------------------------------- moving

  onClick(e) {
    const t = e.target.closest('[data-act], [data-stop], button.buy, button.sk-tab');
    if (!t) return;
    const act = t.dataset.act;
    if (t.classList.contains('run-node') && !act) { this.click(); this.sel = this.sel === t.dataset.stop ? null : t.dataset.stop; this.render(); return; }
    if (t.classList.contains('sk-tab')) { this.tab = t.dataset.tab; this.render(); return; }
    if (t.classList.contains('buy') && !act) { if (!t.disabled) this.buy(t.dataset.id); return; }
    this.click();
    switch (act) {
      case 'menu': this.close(); break;
      case 'map': this.view = 'map'; this.render(); break;
      case 'skills': this.view = 'skills'; this.tab = null; this.render(); break;
      case 'unsel': this.sel = null; this.render(); break;
      case 'ally': this.ally = Number(t.dataset.i) || 0; this.render(); break;
      case 'go':
        this.state = chooseStop(this.state, t.dataset.stop);
        this.save();
        this.enter();
        break;
      case 'enter': this.enter(); break;
      case 'take':
        this.state = applyCache(this.state, t.dataset.kind);
        this.save();
        this.view = 'map'; this.sel = null; this.render();
        break;
      case 'swap':
        this.state = swapVariant(this.state, t.dataset.weapon);
        this.save();
        this.render();
        break;
      case 'leave':
        this.state = leaveDepot(this.state);
        this.save();
        this.view = 'map'; this.sel = null; this.render();
        break;
      case 'next': this.view = this.state.over ? 'summary' : 'map'; this.sel = null; this.render(); break;
      case 'end':
        clearRun(localStorage);
        this.state = null;
        this.close();
        break;
      default: break;
    }
  }

  // The stop you are at: play its fight, open its cache or its depot.
  enter() {
    const st = currentStop(this.state);
    if (!st || this.state.done) return;
    if (st.kind === 'cache' || st.kind === 'depot') { this.view = st.kind; this.render(); return; }
    const ally = st.kind === 'boss' ? allyChoices(this.state)[this.ally] : null;
    this.fighting = { stop: st.id, ally };
    this.state = startFight(this.state);   // so a page closed mid-fight is told it starts over
    this.save();
    this.el.classList.add('hidden');
    this.startMatchFn(matchConfig(this.state, { ally }));
  }

  // From main.js at the end of every match: a run's match is settled here.
  // Returns whether it was one.
  matchOver(game) {
    if (!this.fighting || !game) return false;
    const won = fightWon(game);
    const { state, outcome } = applyFightResult(this.state, { won, kit: kitOf(game.players[0]) });
    this.last = { stop: this.fighting.stop, outcome };
    this.fighting = false;
    this.state = state;
    this.save();
    this.toMenu();
    this.el.classList.remove('hidden');
    this.view = 'result';
    this.render();
    return true;
  }

  // ---------------------------------------------------------------- skills, cache, depot

  // The kit game behind the Skills and Depot views, made afresh from the state.
  kit() { return kitGame(this.state); }

  buy(id) {
    const g = this.kit();
    const p = g.players[0];
    const ok = this.view === 'skills' ? g.pickPerk(p.id, id) : g.buy(p.id, id);
    if (!ok) return;
    this.click();
    this.state = setKit(this.state, kitOf(p));
    this.save();
    this.justBought = this.view === 'depot' ? id : null;
    this.render();
  }

  skillsHtml() {
    const g = this.kit();
    const p = g.players[0];
    const tabs = skillTabs(g, p);
    if (!tabs.some((t) => t.id === this.tab)) this.tab = tabs[0]?.id || null;
    const n = p.points;
    return `<div class="run-sheet">
      <div class="run-sheet-head"><h2>Skills</h2><span class="run-note">${n ? `${n} point${n > 1 ? 's' : ''} to spend. Ranks last the whole run.` : 'No points to spend: win a fight for the next one.'}</span></div>
      ${kitHtml(g, p)}
      <div class="shop-grid run-grid">${skillTabsHtml(g, p, this.tab)}${skillTreeHtml(g, p, this.tab)}</div>
      <button class="primary" data-act="map">Back to the map</button>
    </div>`;
  }

  cacheHtml() {
    const st = currentStop(this.state);
    const cards = st.offers.map((o) => `
      <button class="run-card k-cache" data-act="take" data-kind="${o.kind}">
        <span class="run-card-ico">${o.kind === 'rank' ? '★' : o.kind === 'ammo' ? icon('cache') : '$'}</span>
        <b>${esc(o.name)}</b><small>${esc(offerWords(o))}</small></button>`).join('');
    return `<div class="run-sheet">
      <div class="run-sheet-head"><h2>Cache</h2><span class="run-note">Take one. The other two stay behind.</span></div>
      <div class="run-cards">${cards}</div>
    </div>`;
  }

  depotHtml() {
    const s = this.state;
    const st = currentStop(s);
    const g = this.kit();
    const p = g.players[0];
    const swapped = s.swapped === st.id;
    const forks = forksTaken(s.kit);
    const swaps = forks.length ? forks.map((f) => `
      <div class="shop-item sk-weapon"><div class="si-head"><b>${esc(WEAPON_BY_ID[f.weapon].name)}</b><span class="ar-badge">Variant</span></div>
        <div class="desc">${esc(PERK_BY_ID[f.taken].name)} now. Swap to <b>${esc(PERK_BY_ID[f.other].name)}</b>: ${esc(PERK_BY_ID[f.other].desc.replace(/^[^:]*: /, ''))}</div>
        <div class="si-foot"><span class="si-gives">Upgrade kept</span><button class="buy" data-act="swap" data-weapon="${f.weapon}" ${swapped ? 'disabled' : ''}>Swap</button></div></div>`).join('')
      : '<p class="run-note">You have no variant yet: take one in the skill tree (Weapons) and a depot can turn it the other way.</p>';
    const html = `<div class="run-sheet">
      <div class="run-sheet-head"><h2>Depot</h2><span class="run-funds">$${p.money}</span></div>
      ${kitHtml(g, p)}
      <div class="shop-section">Swap a variant <small>${swapped ? 'Done for this depot.' : 'Once a depot.'}</small></div>
      <div class="shop-grid run-grid">${swaps}</div>
      <div class="shop-grid run-grid">${armoryHtml(g, p, this.justBought)}</div>
      <button class="primary" data-act="leave">Leave the depot</button>
    </div>`;
    this.justBought = null;
    return html;
  }

  // ---------------------------------------------------------------- after a fight, the end

  resultHtml() {
    const { stop, outcome } = this.last || {};
    const st = stop ? runMap(this.state.seed).byId[stop] : null;
    if (!st) { this.view = 'map'; return this.mapHtml(); }
    const d = stopDetails(st);
    const boss = st.kind === 'boss';
    const title = outcome.won ? (boss ? `The ${BOSS.name} is down!` : 'Fight won') : boss ? `The ${BOSS.name} holds` : 'Fight lost';
    const lines = [];
    if (!boss && outcome.pay > 0) lines.push(`<div class="run-reward run-pay"><span>From the match</span> $${outcome.pay}</div>`);
    if (outcome.won && !boss) lines.push(`<div class="run-reward"><span>Reward</span> ${esc(rewardWords(outcome.reward))}</div>`);
    if (outcome.hullLost) lines.push(`<p class="run-loss">${HULL} A hull lost. ${this.state.hulls ? `${this.state.hulls} spare left.` : 'None left.'}</p>`);
    if (outcome.over === 'lost') lines.push('<p class="run-note">The run is over.</p>');
    else if (!outcome.won && boss) lines.push('<p class="run-note">You may try the boss again.</p>');
    else if (outcome.won && this.state.kit.points > 0 && !boss) lines.push(`<p class="run-note hot">${this.state.kit.points} skill point${this.state.kit.points > 1 ? 's' : ''} to spend: Skills, on the map.</p>`);
    const next = outcome.over ? 'See the run' : 'Back to the map';
    return `<div class="run-sheet run-result ${outcome.won ? 'won' : 'lost'}">
      <div class="run-ptitle k-${st.kind}">${icon(st.kind)}<div><h2>${esc(title)}</h2><small>${esc(d.world)} · ${esc(d.foes.map((f) => f.name).join(', '))}</small></div></div>
      ${lines.join('')}
      <button class="primary" data-act="next">${next}</button>
    </div>`;
  }

  summaryHtml() {
    const sum = runSummary(this.state);
    const route = sum.route.map((r) => `<li class="k-${r.kind}">${icon(r.kind)}<b>${esc(r.name)}</b>${r.where ? `<small>${esc(r.where)}</small>` : ''}${r.won == null ? '' : `<em class="${r.won ? 'w' : 'l'}">${r.won ? '✓' : '✗'}${r.tries > 1 ? ` ×${r.tries}` : ''}</em>`}</li>`).join('');
    const b = sum.build;
    const chips = (list, cls = '') => list.map((x) => `<span class="ar-chip ${cls}">${esc(x)}</span>`).join('');
    return `<div class="run-sheet run-summary ${sum.over}">
      <div class="run-sheet-head"><h2>${sum.over === 'won' ? `Run won: the ${esc(BOSS.name)} is down` : 'Run over'}</h2>
        <span class="run-note">${sum.fights.won} fight${sum.fights.won === 1 ? '' : 's'} won, ${sum.fights.lost} lost · ${sum.hulls} spare hull${sum.hulls === 1 ? '' : 's'} left</span></div>
      <div class="shop-section">Route</div>
      <ol class="run-route">${route}</ol>
      <div class="shop-section">Build</div>
      <div class="ar-kit-row">${chips(b.variants, 'var')}${chips(b.mods.map((m) => `${m.name} L${m.level}`), 'mod')}${chips(b.ranks)}${b.points ? chips([`${b.points} unspent point${b.points > 1 ? 's' : ''}`], 'pts') : ''}</div>
      <div class="ar-kit-row run-ammo">${chips([`$${b.money}`, ...b.ammo])}</div>
      <button class="primary" data-act="end">Back to the menu</button>
    </div>`;
  }
}

// A cache offer in words: "+1 skill point", "2 Breacher · 1 Roller", "$300".
export function offerWords(o) {
  if (o.kind === 'rank') return `+${o.points} skill point: a rank in the tree`;
  if (o.kind === 'money') return `$${o.money}, for the armory`;
  return Object.entries(o.ammo).map(([id, n]) => `${n} ${WEAPON_BY_ID[id]?.name || id}`).join(' · ');
}
