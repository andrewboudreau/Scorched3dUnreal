// The run on screen (the rules are in core/run.js): the Run and Continue
// buttons on the launch screen, and the run's own screen (#run) with its views:
//
//   map      the stops in tiers (left to right in landscape, top to bottom in
//            portrait) joined by paths, and a panel with the tapped stop's
//            details and Go. The header shows hulls, money and skill points.
//   skills   spend skill points: the skill tree of armory.js, on a kit game
//   cache    three cards, take one
//   depot    the armory of armory.js, and swap one variant
//   event    an Event stop: a short scene and two or three choices, each a trade
//   eventres a small card with what the choice did
//   result   after a fight: won or lost, the reward, a hull lost
//   summary  the end of the run: the route, the fights, the build
//
// main.js hands it four things: start a match from a config, put the menu's
// field back after a match, show the launch screen, and the human's name. It
// calls matchOver(game) at the end of every match; a run's match is handled
// here (and the usual match-over card is skipped).

import {
  RUN, KINDS, mapOf, startRun, reachable, chooseStop, currentStop, applyFightResult, applyCache, swapVariant,
  leaveDepot, setKit, forksTaken, allyChoices, matchConfig, kitGame, kitOf, fightWon, loadRun, saveRun, clearRun,
  runSummary, stopDetails, rewardWords, startFight, fightCutOff, runProgress, allyWords, bossWords, rewardItems, variantSwaps, fightStats,
  applyEvent, eventCard, nextWords, rewardNow, saveLastRun, loadLastRun,
} from './core/run.js';
import { BOSS } from './core/boss.js';
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
  // An Event: a signpost with a question mark, our own.
  event: '<path d="M12 21V8M5.5 3.5h13v8h-13z"/><path d="M10.2 6.4a1.9 1.9 0 1 1 2.7 1.7c-.5.3-.9.6-.9 1.2"/><circle cx="12" cy="10.6" r=".5" class="f"/>',
  // The boss's mark is a small filled fort: two towers and a keep with a flag.
  boss: '<path class="f fort" d="M2 21V7.5h1.7V9h1.6V7.5H7V21zM17 21V7.5h1.7V9h1.6V7.5H22V21zM6.5 12h11v9h-11zM8.5 21V6h1.6v1.5h1.5V6h1.6v1.5h1.5V6h1.6v15z"/><path class="gate" d="M10.4 21v-3.6a1.6 1.6 0 0 1 3.2 0V21z"/><path d="M12.4 6V2.2"/><path class="f fort" d="M12.4 2.2l3.3 1.2-3.3 1.2z"/>',
};
const icon = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind] || ICONS.fight}</svg>`;

// What a reward is made of: money, a crate of ammo, a skill point.
const GAIN = {
  money: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.5v11M14.8 9.3c-.6-.9-1.6-1.3-2.8-1.3-1.5 0-2.7.8-2.7 2s1.2 1.7 2.7 2c1.6.3 2.8.8 2.8 2s-1.3 2-2.8 2c-1.3 0-2.3-.5-2.9-1.4"/>',
  ammo: '<rect x="3" y="13.5" width="18" height="7" rx="1"/><path d="M5 13.5V9l1.5-3L8 9v4.5M10.5 13.5V9l1.5-3 1.5 3v4.5M16 13.5V9l1.5-3L19 9v4.5"/>',
  point: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  // What an Event can also give or take: armor, jump jets, fuel, a hull, and a mark for the next fight.
  armor: '<path d="M12 3l7 2.5v6c0 4.2-2.8 7.2-7 9-4.2-1.8-7-4.8-7-9v-6z"/>',
  jet: '<path d="M12 3c3 3 4 6 4 9l-4 3-4-3c0-3 1-6 4-9zM9.5 18.5c.3 1.5 1 2.4 2.5 3 1.5-.6 2.2-1.5 2.5-3"/>',
  fuel: '<path d="M6 21V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 15 5v16M4.5 21h12M15 9h2.2a1.3 1.3 0 0 1 1.3 1.3V16a1.5 1.5 0 0 0 3 0V9l-2.5-2.5M8 7h5"/>',
  hull: '<path d="M2 14h20l-3 5H5z"/><path d="M7 14V8h8v6M15 10.5h7"/>',
  next: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/>',
};
const gainIcon = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${GAIN[kind] || GAIN.next}</svg>`;
// An Event's lines: what a choice does (core/run.js effectLines), a mark each.
const linesHtml = (lines) => lines.map((l) => `<span class="run-ln${l.bad ? ' bad' : ''} g-${l.kind}"><i>${gainIcon(l.kind)}</i>${esc(l.text)}</span>`).join('');

// The tint of the ground behind a stop, by its world (an r,g,b triplet), and
// the spacing of its contour lines.
const TERRAIN = {
  rolling: '120,190,105', hilly: '165,175,95', mountains: '170,160,150', city: '120,160,210',
  isles: '125,215,235', ridgeline: '225,150,90', island: '85,205,195', neutral: '95,208,189', boss: '255,115,95',
};

// A reward's items, each with its icon: a row for the result card, a chip on a
// stop's card. `have` (the kit's ammo) adds what you carry of each weapon.
function gainsHtml(items, have = null) {
  return items.map((it) => {
    const body = it.kind === 'ammo'
      ? `<b>Ammo crate</b><ul class="run-crate">${it.items.map((i) => `<li><b>${i.n}×</b> ${esc(i.name)}${have ? `<small>now ${have[i.id] || 0} in all</small>` : ''}</li>`).join('')}</ul>`
      : `<b>${esc(it.text)}</b>`;
    return `<div class="run-gain g-${it.kind}"><i>${gainIcon(it.kind)}</i><div>${body}</div></div>`;
  }).join('');
}
const chipsHtml = (items) => items.map((it) => `<span class="run-gchip g-${it.kind}">${gainIcon(it.kind)}${esc(it.text)}</span>`).join('');
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
    this.finished = loadLastRun(localStorage);   // the last finished run, for Last run on the launch screen
    if (this.state?.over) this.keepLast();
    this.reviewing = false;   // the finished run's summary is open from the launch screen (this.held is the run kept aside)
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
      <button id="run-abandon" class="run-abandon hidden">Abandon</button>
      <button id="run-last" class="run-last hidden">Last run<small></small></button>`;
    const hint = top.querySelector('.launch-hint');
    (hint || top.lastElementChild).after(row);
    row.querySelector('#run-new').onclick = () => {
      if (this.live() && !this.confirmNew) { this.confirmNew = true; this.refreshLaunch(); return; }
      this.newRun();
    };
    row.querySelector('#run-continue').onclick = () => { this.begin(); this.open(); };
    row.querySelector('#run-last').onclick = () => this.showLast();
    row.querySelector('#run-abandon').onclick = () => {
      if (!this.confirmAbandon) { this.confirmAbandon = true; this.refreshLaunch(); setTimeout(() => { this.confirmAbandon = false; this.refreshLaunch(); }, 3000); return; }
      this.confirmAbandon = false;
      clearRun(localStorage);
      this.state = null;
      this.refreshLaunch();
    };
    this.refreshLaunch();
  }

  // A fresh run on a new seed (the launch screen's Run, the summary's New run).
  newRun() {
    this.begin();
    this.confirmNew = false;
    this.state = startRun((Math.random() * 1e9) >>> 0, this.name() || 'You');
    this.sel = null;
    this.save();
    this.open();
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
    const last = this.finished;
    $('#run-last').classList.toggle('hidden', !last);
    if (last) {
      const sum = runSummary(last);
      const f = sum.fights.won + sum.fights.lost;
      $('#run-last small').textContent = `${last.over === 'won' ? 'won' : `lost at stop ${runProgress(last).n}`} · ${sum.fights.won} of ${f} fight${f === 1 ? '' : 's'} won`;
    }
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

  save() { if (this.state && !this.reviewing) saveRun(localStorage, this.state); }

  // A run that has ended is kept to read again (the summary under Last run).
  keepLast() {
    saveLastRun(localStorage, this.state);
    this.finished = this.state;
  }

  // The finished run's summary, from the launch screen; the run in progress is held aside.
  showLast() {
    if (!this.finished) return;
    this.begin();
    this.held = this.state;
    this.state = this.finished;
    this.reviewing = true;
    document.getElementById('setup').classList.add('hidden');
    this.el.classList.remove('hidden');
    this.view = 'summary';
    this.sel = null;
    this.render();
  }

  open(view = null) {
    document.getElementById('setup').classList.add('hidden');
    this.el.classList.remove('hidden');
    const stop = currentStop(this.state);
    this.view = view || (this.state.over ? 'summary' : stop && !this.state.done && ['cache', 'depot', 'event'].includes(stop.kind) ? stop.kind : 'map');
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
      : v === 'event' ? this.eventHtml() : v === 'eventres' ? this.eventResHtml()
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
    const portrait = this.drawnPortrait = this.portrait.matches;
    return `<div class="run-mapview${portrait ? ' portrait' : ''}">
      <div class="run-map"><div class="run-field">${this.fieldHtml({ portrait })}</div></div>
      <aside class="run-panel">${this.panelHtml()}</aside>
    </div>`;
  }

  // The inside of a map's field: the ground behind each stop (a patch of
  // contour lines tinted by the stop's world), the paths, the stops. All of it
  // still: only CSS moves (a reachable stop's pulse). `mini` is the summary's
  // small copy (always laid out left to right): stops are marks, not buttons,
  // and what you did not visit is dim.
  fieldHtml({ portrait = false, mini = false } = {}) {
    const s = this.state;
    const map = mapOf(s);
    const cols = map.tiers.length + 1;
    const open = mini ? new Set() : new Set(reachable(s));
    const path = new Set(s.path);
    const hereTier = s.at ? map.byId[s.at].tier : -1;
    const pos = { start: nodeAt(0, cols, 0, 1, portrait) };
    map.tiers.forEach((tier, t) => tier.forEach((st) => { pos[st.id] = nodeAt(t + 1, cols, st.index, tier.length, portrait); }));
    const lines = [];
    const trail = [];   // the route walked: a bed, a line, then tread marks across it
    const line = (a, b, cls) => {
      const xy = `x1="${pos[a].x}" y1="${pos[a].y}" x2="${pos[b].x}" y2="${pos[b].y}"`;
      if (cls === 'walked') trail.push(`<line ${xy} class="bed"/><line ${xy} class="walked"/><line ${xy} class="tread"/>`);
      else lines.push(`<line ${xy} class="${cls}"/>`);
    };
    for (const st of map.tiers[0]) line('start', st.id, s.path[0] === st.id ? 'walked' : s.at == null && !mini ? 'open' : '');
    for (const st of map.stops) {
      for (const id of st.next) {
        const i = s.path.indexOf(st.id);
        const walked = i >= 0 && s.path[i + 1] === id;
        line(st.id, id, walked ? 'walked' : st.id === s.at && open.has(id) ? 'open' : '');
      }
    }
    const lastTry = (id) => s.log.filter((l) => l.stop === id && l.won != null).pop();
    const node = (st) => {
      const cls = ['run-node', `k-${st.kind}`];
      if (path.has(st.id)) cls.push('visited');
      if (mini) { if (!path.has(st.id)) cls.push('gone'); } else {
        if (st.id === s.at) cls.push('here');
        if (open.has(st.id)) cls.push('open');
        else if (!path.has(st.id) && st.tier <= hereTier) cls.push('gone');
        if (st.id === this.sel) cls.push('sel');
      }
      const p = pos[st.id];
      const won = lastTry(st.id);
      const mark = won ? `<em class="${won.won ? 'w' : 'l'}">${won.won ? '✓' : '✗'}</em>` : '';
      const at = `style="left:${p.x}%;top:${p.y}%"`;
      return mini
        ? `<i class="${cls.join(' ')}" ${at}>${icon(st.kind)}${mark}</i>`
        : `<button class="${cls.join(' ')}" ${at} data-stop="${st.id}" aria-label="${esc(KINDS[st.kind].name)}">${icon(st.kind)}${mark}<span>${esc(KINDS[st.kind].name)}</span></button>`;
    };
    // A patch of ground behind each stop: about two tiers across, a tier's share of the short side.
    const ground = (st) => {
      const p = pos[st.id];
      const long = (100 / cols) * 1.9, short = (100 / map.tiers[st.tier].length) * 1.05;
      const w = portrait ? short : long, h = portrait ? long : short;
      const kind = st.kind === 'boss' ? 'boss' : st.match ? st.match.world : 'neutral';
      const ox = 35 + ((st.tier * 37 + st.index * 53) % 31), oy = 35 + ((st.tier * 19 + st.index * 29) % 31);
      return `<i class="run-terr w-${kind}" style="left:${p.x}%;top:${p.y}%;width:${w.toFixed(1)}%;height:${h.toFixed(1)}%;--c:${TERRAIN[kind]};--ox:${ox}%;--oy:${oy}%"></i>`;
    };
    const p0 = pos.start;
    return `${map.stops.map(ground).join('')}
      <svg class="run-lines" viewBox="0 0 100 100" preserveAspectRatio="none">${lines.join('')}${trail.join('')}</svg>
      <i class="run-node k-start visited" style="left:${p0.x}%;top:${p0.y}%">${icon('start')}</i>
      ${map.stops.map(node).join('')}`;
  }

  // The panel beside the map: the tapped stop, or where you are.
  panelHtml() {
    const s = this.state;
    const map = mapOf(s);
    const st = this.sel ? map.byId[this.sel] : null;
    if (!st) {
      const g = kitGame(s);
      const n = reachable(s).length;
      const left = nextWords(s.next);
      return `<h3>${s.at ? 'Where next?' : 'Your run'}</h3>
        ${left.length ? `<p class="run-note run-left">Waiting for your next fight: ${left.map((w) => `<span class="${w.bad ? 'bad' : 'good'}">${esc(w.text)}</span>`).join(' · ')}</p>` : ''}
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
      const d = stopDetails(st, s.next);
      const foes = d.foes.map((f) => `<li><b>${esc(f.name)}</b> <span class="run-lvl">${esc(f.level)}</span>${f.extra ? `<small>${esc(f.extra)}</small>` : ''}</li>`).join('');
      body = `
        <div class="run-facts"><span>${esc(d.world)}</span><span>${esc(d.wind)}</span><span>${esc(d.edges)}</span><span>${esc(d.time)}</span></div>
        <div class="run-mod${d.changed ? ' changed' : ''}"><b>${esc(d.modifier)}</b>${d.modifierDesc && st.match.modifier !== 'clear' ? ` · ${esc(d.modifierDesc)}` : ''}</div>
        <div class="run-sub">${st.kind === 'boss' ? 'The boss' : d.foes.length > 1 ? 'Foes' : 'Foe'} · ${d.rounds} round${d.rounds > 1 ? 's' : ''}</div>
        <ul class="run-foes">${foes}</ul>`;
      if (st.kind === 'boss') body += `<ul class="run-bossfacts">${bossWords().lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${this.allyHtml()}`;
      else body += `<div class="run-reward"><span>Reward</span><div class="run-gchips">${chipsHtml(rewardItems({ ...rewardNow(st, s.next), points: (st.reward.points || 0) + RUN.winPoints }))}</div></div>${this.leftHtml()}`;
    } else if (st.kind === 'cache') {
      body = `<p class="run-note">No fight. Take one of three:</p><ul class="run-foes">${st.offers.map((o) => `<li><b>${esc(o.name)}</b><div class="run-gchips">${chipsHtml(rewardItems(o))}</div></li>`).join('')}</ul>`;
    } else if (st.kind === 'depot') {
      body = `<p class="run-note">No fight. The armory is open (you have $${s.kit.money}), and you may turn one weapon's variant the other way.</p>`;
    }
    let go = '';
    if (cut) body += '<p class="run-note run-cut">This fight was left unfinished when the page closed. It starts over from the first shot, with the kit you brought to it.</p>';
    if (here) go = `<button class="primary run-gobtn" data-act="enter">${st.match ? (cut ? 'Start the fight over' : s.log.some((l) => l.stop === st.id) ? 'Try again' : 'Fight') : st.kind === 'cache' ? 'Open the cache' : st.kind === 'event' ? 'See what it is' : 'Enter the depot'}</button>`;
    else if (can) go = `<button class="primary run-gobtn" data-act="go" data-stop="${st.id}">Go</button>`;
    else go = `<p class="run-note">${s.path.includes(st.id) ? 'Been here.' : 'Not on your path from here.'}</p>`;
    return `<div class="run-ptitle k-${st.kind}">${icon(st.kind)}<div><h3>${esc(KINDS[st.kind].name)}</h3><small>${of}</small></div><button class="run-x" data-act="unsel" aria-label="Close">✕</button></div>
      <p class="run-kdesc">${esc(KINDS[st.kind].desc)}</p>${body}${go}`;
  }

  // What an Event left on the next fight, under a fight's card.
  leftHtml() {
    const left = nextWords(this.state.next);
    return left.length ? `<p class="run-note run-left">From the road: ${left.map((w) => `<span class="${w.bad ? 'bad' : 'good'}">${esc(w.text)}</span>`).join(' · ')}</p>` : '';
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
      case 'choose': {
        const { state, outcome } = applyEvent(this.state, t.dataset.choice);
        this.state = state;
        this.lastEvent = outcome;
        this.save();
        this.view = 'eventres'; this.sel = null; this.render();
        break;
      }
      case 'closelast':
        this.state = this.held;
        this.held = null;
        this.reviewing = false;
        this.close();
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
      case 'next': this.view = this.state.over ? 'summary' : 'map'; this.sel = this.state.done ? null : this.state.at; this.render(); break;   // a lost boss fight: its card, ready to try again
      case 'newrun': this.newRun(); break;
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
    if (st.kind === 'cache' || st.kind === 'depot' || st.kind === 'event') { this.view = st.kind; this.render(); return; }
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
    const stats = fightStats(game);
    const { state, outcome } = applyFightResult(this.state, { won, kit: kitOf(game.players[0]), stats });
    this.last = { stop: this.fighting.stop, outcome, stats };
    this.fighting = false;
    this.state = state;
    this.save();
    if (state.over) this.keepLast();
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
    const k = this.state.kit;
    const sub = { rank: `A rank in the tree. You have ${k.points} point${k.points === 1 ? '' : 's'} now.`, money: `For the armory. You have $${k.money} now.`, ammo: 'Added to the rounds you carry.' };
    const cards = st.offers.map((o) => {
      const it = rewardItems(o)[0];
      return `
      <button class="run-card k-cache g-${it.kind}" data-act="take" data-kind="${o.kind}">
        <span class="run-card-ico">${gainIcon(it.kind)}</span>
        <b>${esc(o.name)}</b>
        <span class="run-card-gives">${it.kind === 'ammo' ? `<span class="run-crate">${it.items.map((i) => `<span><b>${i.n}×</b> ${esc(i.name)}<small>have ${k.inventory[i.id] || 0}</small></span>`).join('')}</span>` : esc(it.text)}</span>
        <small>${sub[o.kind] || ''}</small></button>`;
    }).join('');
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
    // Each swap says what you have and what you would switch to, side by side.
    const swaps = variantSwaps(s.kit).map((f) => `
      <div class="shop-item sk-weapon run-swap${swapped ? ' used' : ''}"><div class="si-head"><b>${esc(f.name)}</b><span class="ar-badge">Variant</span></div>
        <div class="run-swap-row">
          <div class="run-swap-side now"><small>You have</small><b>${esc(f.now.name)}</b><span>${esc(f.now.desc)}</span></div>
          <div class="run-swap-arrow" aria-hidden="true"></div>
          <div class="run-swap-side then"><small>Switch to</small><b>${esc(f.then.name)}</b><span>${esc(f.then.desc)}</span></div>
        </div>
        <div class="si-foot"><span class="si-gives">${f.upgrade ? 'Your upgrade stays' : 'No upgrade yet'}</span><button class="buy" data-act="swap" data-weapon="${f.weapon}" ${swapped ? 'disabled' : ''}>${swapped ? 'Used' : `Switch to ${esc(f.then.name)}`}</button></div></div>`).join('')
      || '<p class="run-note">You have no variant yet: take one in the skill tree (Weapons) and a depot can turn it the other way.</p>';
    const html = `<div class="run-sheet">
      <div class="run-sheet-head"><h2>Depot</h2><span class="run-funds">$${p.money}</span></div>
      ${kitHtml(g, p)}
      <div class="shop-section">Swap a variant <small>${swapped ? 'Done for this depot: these show what you have now.' : 'Once a depot. Only the fork turns; the upgrade stays.'}</small></div>
      <div class="shop-grid run-grid">${swaps}</div>
      <div class="shop-grid run-grid">${armoryHtml(g, p, this.justBought)}</div>
      <button class="primary" data-act="leave">Leave the depot</button>
    </div>`;
    this.justBought = null;
    return html;
  }

  // ---------------------------------------------------------------- events

  eventHtml() {
    const card = eventCard(this.state);
    if (!card) { this.view = 'map'; return this.mapHtml(); }
    const k = this.state.kit;
    const choices = card.choices.map((c) => `
      <button class="run-choice${c.can ? '' : ' off'}" data-act="choose" data-choice="${c.id}" ${c.can ? '' : 'disabled'}>
        <b>${esc(c.label)}</b>
        <span class="run-fx">${c.lines.length ? linesHtml(c.lines) : '<span class="run-ln none">Nothing changes.</span>'}</span>
        ${c.can ? '' : `<small class="why">${esc(c.why)}</small>`}</button>`).join('');
    return `<div class="run-sheet run-event">
      <div class="run-ptitle k-event">${icon('event')}<div><h2>${esc(card.name)}</h2><small>Event · you have $${k.money}${k.points ? ` and ${k.points} skill point${k.points > 1 ? 's' : ''}` : ''}</small></div></div>
      <p class="run-evtext">${esc(card.text)}</p>
      <div class="run-choices">${choices}</div>
    </div>`;
  }

  // The small card after a choice: what changed.
  eventResHtml() {
    const o = this.lastEvent;
    if (!o) { this.view = 'map'; return this.mapHtml(); }
    return `<div class="run-sheet run-evres">
      <div class="run-evcard">
        <div class="run-ptitle k-event">${icon('event')}<div><h2>${esc(o.label)}</h2><small>${esc(o.event)}</small></div></div>
        <div class="run-fx">${o.lines.length ? linesHtml(o.lines) : '<span class="run-ln none">Nothing changed. You move on.</span>'}</div>
        <button class="primary" data-act="map">Back to the map</button>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- after a fight, the end

  resultHtml() {
    const { stop, outcome, stats } = this.last || {};
    const st = stop ? mapOf(this.state).byId[stop] : null;
    if (!st) { this.view = 'map'; return this.mapHtml(); }
    const d = stopDetails(st);
    const boss = st.kind === 'boss';
    const title = outcome.won ? (boss ? `The ${BOSS.name} is down!` : 'Fight won') : boss ? `The ${BOSS.name} holds` : 'Fight lost';
    const lines = [];
    if (stats && (stats.damage || stats.taken)) lines.push(`<div class="run-dmg"><span><b>${stats.damage}</b> damage dealt</span><span><b>${stats.taken}</b> taken</span></div>`);
    if (!boss && outcome.pay > 0) lines.push(`<div class="run-sub">From the match</div>${gainsHtml(rewardItems({ money: outcome.pay }))}`);
    if (outcome.won && !boss) lines.push(`<div class="run-sub">Reward</div>${gainsHtml(rewardItems(outcome.reward), this.state.kit.inventory)}`);
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
    // One row per stop walked: what it was, who was there, how it went.
    const route = sum.route.map((r) => {
      const mark = r.won == null ? '' : `<em class="${r.won ? 'w' : 'l'}">${r.won ? '✓' : '✗'}${r.tries > 1 ? ` ×${r.tries}` : ''}</em>`;
      const sub = r.foes.length ? `${esc(r.where)} · vs ${esc(r.foes.join(', '))}` : r.detail ? esc(r.detail) : r.took ? `Took ${esc(r.took)}` : '';
      const dmg = r.dealt || r.taken ? `<span class="rt-dmg"><b>${r.dealt}</b> dealt · <b>${r.taken}</b> taken</span>` : '';
      return `<li class="k-${r.kind}">${icon(r.kind)}<div class="rt-main"><b>${esc(r.name)}</b>${sub ? `<small>${sub}</small>` : ''}</div>${dmg}${mark}</li>`;
    }).join('');
    const b = sum.build;
    const chips = (list, cls = '') => list.map((x) => `<span class="ar-chip ${cls}">${esc(x)}</span>`).join('');
    const tile = (n, label, cls = '') => `<div class="run-tile ${cls}"><b>${n}</b><span>${label}</span></div>`;
    return `<div class="run-sheet run-summary ${sum.over}">
      <div class="run-sheet-head"><h2>${sum.over === 'won' ? `Run won: the ${esc(BOSS.name)} is down` : 'Run over'}</h2></div>
      <div class="run-tiles">${tile(`${sum.fights.won}<i>/${sum.fights.won + sum.fights.lost}</i>`, 'fights won')}${tile(sum.damage.dealt, 'damage dealt', 'dealt')}${tile(sum.damage.taken, 'damage taken', 'taken')}${tile(sum.hulls, `spare hull${sum.hulls === 1 ? '' : 's'} left`)}</div>
      <div class="shop-section">Route</div>
      <div class="run-map run-minimap"><div class="run-field">${this.fieldHtml({ mini: true })}</div></div>
      <ol class="run-route">${route}</ol>
      <div class="shop-section">Final build</div>
      <div class="ar-kit-row">${chips(b.variants, 'var')}${chips(b.mods.map((m) => `${m.name} L${m.level}`), 'mod')}${chips(b.ranks)}${b.points ? chips([`${b.points} unspent point${b.points > 1 ? 's' : ''}`], 'pts') : ''}${!b.variants.length && !b.mods.length && !b.ranks.length && !b.points ? '<span class="run-note">No ranks taken.</span>' : ''}</div>
      <div class="ar-kit-row run-ammo">${chips([`$${b.money}`, ...b.ammo])}</div>
      <div class="run-actions">${this.reviewing ? '<button class="primary" data-act="closelast">Back</button>' : '<button class="primary" data-act="newrun">New run</button><button data-act="end">Menu</button>'}</div>
    </div>`;
  }
}

// A cache offer in words: "+1 skill point", "2 Breacher · 1 Roller", "$300".
export function offerWords(o) {
  if (o.kind === 'rank') return `+${o.points} skill point: a rank in the tree`;
  if (o.kind === 'money') return `$${o.money}, for the armory`;
  return Object.entries(o.ammo).map(([id, n]) => `${n} ${WEAPON_BY_ID[id]?.name || id}`).join(' · ');
}
