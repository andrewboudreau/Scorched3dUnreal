// The boss match on screen (the rules are in core/boss.js).
//
//   - The boss's health bar, top centre: its name, the phase it is in, and
//     ticks where the next phases begin. It flashes on a weak-spot hit.
//   - Under it, the telegraph: "Thunderhead locked on Tester" while a big
//     shot is marked (and while it flies). On a phone it is also said once in
//     the touch note, and the phone buzzes when the mark is on you.
//   - A banner when the boss moves up a phase.
// The mark on the ground is drawn by render/bossMark.js. This reads the game
// each frame and never changes it.

import { BOSS, bossStandings } from './core/boss.js';
import { WEAPON_BY_ID } from './core/weapons.js';

const PHASE_TEXT = {
  2: ['Phase 2', 'Orbiter up, hopping ledges'],
  3: ['Phase 3', 'Cornered: two shots a turn'],
};

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class BossUI {
  // game() is the live Game (or null); banner(text, sub, ms) is main.js's.
  constructor({ game, touch = null, banner = () => {} }) {
    this.game = game;
    this.touch = touch;
    this.banner = banner;
    this.shown = {};
    const el = this.el = document.createElement('div');
    el.id = 'boss-bar';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="bb-head"><span class="bb-name"></span><span class="bb-phase"></span></div>
      <div class="bb-bar"><div class="bb-fill"></div>${BOSS.phases.map((s) => `<i style="left:${s * 100}%"></i>`).join('')}</div>
      <div class="bb-mark"></div>`;
    document.getElementById('hud').appendChild(el);
    this.fill = el.querySelector('.bb-fill');
    this.name = el.querySelector('.bb-name');
    this.phase = el.querySelector('.bb-phase');
    this.mark = el.querySelector('.bb-mark');
  }

  boss() {
    const g = this.game();
    return g?.cfg.boss ? g.bossTank : null;
  }

  // What the boss has marked, in words ("Thunderhead locked on Tester"), or ''.
  markText(b = this.boss()) {
    const m = b?.alive && (b.boss.mark || b.boss.firing);
    if (!m) return '';
    const g = this.game();
    const who = g.players[m.target];
    return `${WEAPON_BY_ID[m.weapon]?.name || m.weapon} locked on ${who ? who.name : 'you'}`;
  }

  // From main.js's event loop, for every game event.
  event(e) {
    const g = this.game();
    if (!g?.cfg.boss) return;
    if (e.type === 'bossPhase') {
      const [t, sub] = PHASE_TEXT[e.phase] || [`Phase ${e.phase}`, ''];
      this.banner(t, sub, 2600);
      this.touch?.buzz([20, 60, 20]);
    } else if (e.type === 'bossMark' && !e.clear) {
      const text = this.markText();
      const mine = g.localHumans?.some((h) => h.id === e.target);
      if (this.touch && text) this.touch.note(mine ? `${text}! Move` : text, 3500);
      if (mine) this.touch?.buzz([30, 50, 30, 50, 30]);
    } else if (e.type === 'weakSpot') {
      this.el.classList.remove('weak');
      void this.el.offsetWidth;    // restart the flash
      this.el.classList.add('weak');
    }
  }

  // The match-over result of a boss match (core/boss.js bossStandings), or null
  // in any other match: { title ("Allies win", "The Bulwark wins"), order (the
  // players, allies by damage dealt to the boss, then the boss), table (the
  // standings as table rows) }.
  matchResult() {
    const g = this.game();
    const s = g?.cfg.boss ? bossStandings(g.players, g.lastRoundResult) : null;
    if (!s) return null;
    const status = (r) => (r.side === 'boss' ? (r.alive ? `${r.hp} hp left` : 'Destroyed') : r.alive ? 'Standing' : 'Destroyed');
    const row = (r, tag = '') => `<tr><td><span class="swatch" style="background:${r.color}"></span></td><td>${escape(r.name)}${tag}</td>
      <td>${r.side === 'boss' ? '–' : r.damage}</td><td>${status(r)}</td></tr>`;
    const allies = s.rows.filter((r) => r.side === 'allies');
    const win = (side) => (s.winner === side ? ' <span style="color:#f2c14e">&#9733; wins</span>' : '');
    const table = `<tr><th></th><th>Allies${win('allies')}</th><th>Dealt to ${escape(s.boss.name)}</th><th></th></tr>`
      + allies.map((r) => row(r)).join('')
      + s.rows.filter((r) => r.side === 'boss').map((r) => row(r, win('boss'))).join('');
    return { title: s.title, winner: s.winner, order: s.rows.map((r) => g.players[r.id]), table };
  }

  // Once a frame.
  update() {
    const b = this.boss();
    const s = this.shown;
    const on = !!b;
    if (s.on !== on) { s.on = on; this.el.classList.toggle('hidden', !on); }
    if (!on) return;
    const share = Math.max(0, b.hp / (b.maxHp || BOSS.hp));
    const w = `${(share * 100).toFixed(1)}%`;
    if (s.w !== w) { s.w = w; this.fill.style.width = w; }
    if (s.name !== b.name) { s.name = b.name; this.name.textContent = b.name; }
    const ph = b.alive ? `Phase ${b.boss.phase} · ${Math.ceil(b.hp)}` : 'Destroyed';
    if (s.ph !== ph) { s.ph = ph; this.phase.textContent = ph; this.el.dataset.phase = b.alive ? b.boss.phase : 0; }
    const mark = this.markText(b);
    if (s.mark !== mark) {
      s.mark = mark;
      this.mark.innerHTML = mark ? `&#9673; ${escape(mark)}` : '';
    }
  }
}
