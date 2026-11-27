// The HUD: the player card (whose turn, health, fuel, jets, aim, weapon and the
// weapon bar), the wind and the round, the players box, the banner, the card's
// note line and the guided missile's steering hint. Which of them a phone shows
// in each view is hudview.js; the words and rules are hudlogic.js (pure,
// tested); this file writes the DOM, only through domwrite.js's helpers on the
// per-frame paths.
//
// main.js makes one and calls it:
//   show(on)                  the HUD on (a match) or off (the menu)
//   start(game)               a new match: build the players box
//   update(game)              each frame of a match
//   banner(text, sub, ms)     the big line in the middle (also handed to
//                             strike.js, bossui.js, modsui.js, review.js)
//   roundStart(game, round)   the round's banner (a twist holds the turn banner back)
//   turn(p, { plan, coach })  the turn's banner, once the round's has been read
//   holdLeft()                ms until a held banner lets the next one show
//   note(text, ms)            a short line on the card (driving, jets)
//   steer(state)              the steering hint: null outside a flight, else
//                             { fuel, jam, dir } (fuel -1: no missile to steer)
// deps: game() is the live Game (or null), read when a delayed banner fires;
// touch is the TouchControls (or null); peekAt(p) looks at a tank (a click on
// its row).

import { WEAPON_BY_ID } from './core/weapons.js';
import { TANK } from './core/tank.js';
import { PERK_BY_ID } from './core/perks.js';
import { kitWords } from './armory.js';
import { conditionsLabel, edgeLabel } from './builder.js';
import { setText, setStyle } from './domwrite.js';
import {
  escapeHtml, ammoText, ownedWeapons, jetsText, fuelText, winsText, lastAimText, cardNote, windReadout, roundText,
  roundBanner, turnBanner, bannerDelay,
} from './hudlogic.js';

const $ = (id) => document.getElementById(id);

// The HUD's fixed elements, looked up once.
const HUD_IDS = ['pc-swatch', 'pc-name', 'pc-tag', 'pc-hp', 'pc-armor', 'pc-money', 'pc-fuel', 'ro-fuel', 'pc-note', 'pc-perks', 'ro-yaw', 'ro-elev',
  'ro-power', 'ro-jets', 'pc-power', 'last-yaw', 'last-elev', 'last-power', 'ro-weapon', 'ro-ammo', 'wind-arrow', 'wind-speed', 'wind-aim', 'round-label', 'round-mod', 'round-desc'];

const perkChip = (id, long) => `<span class="perk" title="${escapeHtml(PERK_BY_ID[id].desc)}">${long ? PERK_BY_ID[id].name : PERK_BY_ID[id].tag}</span>`;
function setPerks(el, p, long) {
  const key = p.id + p.perks.join();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = [...new Set(p.perks)].map((id) => perkChip(id, long)).join('');   // a stacked perk shows once
}

export class Hud {
  constructor({ game = () => null, touch = null, peekAt = () => {} } = {}) {
    this.game = game;
    this.touch = touch;
    this.peekAt = peekAt;
    this.els = null;
    this.sbRows = new Map();      // player id -> the players box row and the bits of it that change
    this.weaponBarKey = '';
    this.hold = 0;                // a round banner keeps the turn banner waiting until then
    this.driveNote = { text: '', until: 0 };
    this.bannerTimer = 0;
    this.steerFuel = -1;          // the steering hint's last fuel, -1 for no missile
    this.steerTipUntil = 0;
    if (touch) {
      // The left column is full on a phone, so the players box sits top right.
      $('hud').appendChild($('scoreboard'));
      // No keyboard here: the hint says what to do instead.
      $('steer-hint').querySelector('.sh-tip').textContent = 'hold left or right to steer';
    }
  }

  show(on) { $('hud').classList.toggle('hidden', !on); }

  // ---- a new match

  start(game) {
    $('scoreboard').innerHTML = game.players.map((p) => `
    <div class="sb-row" id="sb-${p.id}" data-id="${p.id}" title="Click to look at ${escapeHtml(p.name)}">
      <span class="swatch" style="background:${p.color}"></span>
      <span style="width:74px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name)}</span>
      <div class="bar"><div class="fill hp"></div></div>
      <span class="wins"></span>
      <div class="sb-perks"></div>
    </div>`).join('');
    this.sbRows.clear();
    $('scoreboard').querySelectorAll('.sb-row').forEach((row) => {
      row.onclick = () => { const g = this.game(); if (g) this.peekAt(g.players[Number(row.dataset.id)]); };
      this.sbRows.set(Number(row.dataset.id), { row, fill: row.querySelector('.fill'), wins: row.querySelector('.wins'), perks: row.querySelector('.sb-perks') });
    });
    $('help-fire').textContent = game.volleyMode ? 'lock in your shot' : 'fire';
  }

  // ---- banners

  banner(text, sub = '', ms = 1600) {
    const b = $('banner');
    b.innerHTML = `${escapeHtml(text)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`;
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  roundStart(game, round) {
    const clear = game.modifier.id === 'clear';
    const b = roundBanner({
      round, rounds: game.cfg.rounds, mod: game.modifier,
      cond: conditionsLabel(game.cfg, game.edge), edge: clear ? '' : edgeLabel(game.edge), kit: round === 1 ? kitWords({ online: game.online }) : '',
    });
    this.banner(b.text, b.sub, b.ms);
    if (b.hold) this.hold = performance.now() + b.hold;
  }

  holdLeft() { return bannerDelay(this.hold, performance.now()); }

  // The turn's banner, after the round's has been read, if the turn is still on.
  turn(p, { plan = false, coach = true } = {}) {
    const [title, sub, ms] = turnBanner(p, { plan, touch: !!this.touch, coach });
    setTimeout(() => { const g = this.game(); if (g && g.turn === p.id && g.phase === 'aim') this.banner(title, sub, ms); }, this.holdLeft());
  }

  // ---- the card's note line

  note(text, ms) { this.driveNote = { text, until: performance.now() + ms }; }

  // ---- the guided missile's steering hint

  steer(s) {
    const hint = $('steer-hint');
    if (!s) { if (!hint.classList.contains('hidden')) hint.classList.add('hidden'); this.steerFuel = -1; return; }   // no same-value write each frame
    const { fuel, jam, dir } = s;
    if (jam !== hint.classList.contains('jammed')) { hint.classList.toggle('jammed', jam); hint.querySelector('.sh-title').textContent = jam ? 'Jammed' : 'Guidance'; }
    if (fuel >= 0 && this.steerFuel < 0) this.steerTipUntil = performance.now() + 1800;   // a new missile: say how, briefly
    this.steerFuel = fuel;
    hint.classList.toggle('hidden', fuel < 0);
    if (fuel >= 0) {
      $('steer-fuel').style.width = `${(fuel / WEAPON_BY_ID.guided.flight[0].fuel) * 100}%`;
      hint.classList.toggle('empty', fuel <= 0);
      hint.classList.toggle('tip', performance.now() < this.steerTipUntil);
      hint.classList.toggle('l', fuel > 0 && dir < 0);
      hint.classList.toggle('r', fuel > 0 && dir > 0);
    }
  }

  // ---- each frame

  update(game) {
    if (!this.els) { this.els = {}; for (const id of HUD_IDS) this.els[id] = $(id); }
    const E = this.els;
    const p = game.current || game.players[game.lastShooter ?? 0];
    if (game.current) game.lastShooter = game.current.id;
    if (p) {
      setStyle(E['pc-swatch'], 'background', p.color);
      setText(E['pc-name'], p.name);
      setText(E['pc-tag'], p.ai ? `CPU ${p.ai}` : 'Human');
      setStyle(E['pc-hp'], 'width', `${(p.hp / p.maxHp) * 100}%`);
      setStyle(E['pc-armor'], 'width', `${Math.min(100, p.armor * 3.3)}%`);
      setText(E['pc-money'], String(p.money));
      setStyle(E['pc-fuel'], 'width', `${p.fuelMax ? (p.fuel / p.fuelMax) * 100 : 0}%`);
      setText(E['ro-fuel'], fuelText(p.fuel));
      setText(E['ro-jets'], jetsText(p.jets));
      if (E['ro-jets'].classList.contains('none') !== !(p.jets > 0)) E['ro-jets'].classList.toggle('none', !(p.jets > 0));
      setText(E['pc-note'], cardNote({ note: this.driveNote, now: performance.now(), phase: game.phase, ai: !!p.ai, buried: !!p.buried }));
      setPerks(E['pc-perks'], p, true);
      setText(E['ro-yaw'], `${p.yaw.toFixed(1)}°`);
      setText(E['ro-elev'], `${p.elev.toFixed(1)}°`);
      setText(E['ro-power'], p.power.toFixed(1));
      setStyle(E['pc-power'], 'width', `${((p.power - TANK.minPower) / (TANK.maxPower - TANK.minPower)) * 100}%`);
      // Under each: what the last shot used, and how far the aim is from it now.
      const last = p.ai ? null : p.shots[p.shots.length - 1];
      const was = (el, then, now, unit, wrap) => {
        const text = lastAimText({ ai: !!p.ai, then, now, unit, wrap });
        if (el.dataset.t !== text) { el.dataset.t = text; el.innerHTML = text; }
      };
      was(E['last-yaw'], last?.yaw, p.yaw, '°', true);
      was(E['last-elev'], last?.elev, p.elev, '°', false);
      was(E['last-power'], last?.power, p.power, '', false);
      const w = WEAPON_BY_ID[p.weapon];
      setText(E['ro-weapon'], game.weaponName(p, w.id));
      setText(E['ro-ammo'], ammoText(p.inventory[w.id]));
      this.updateWeaponBar(game, p);
    }
    // The wind, for the tank whose turn it is (or this screen's).
    const wp = game.current || game.localHumans?.[0] || game.players[0];
    const wind = windReadout(game.wind, wp ? wp.yaw : 0);
    setStyle(E['wind-arrow'], 'transform', `rotate(${wind.deg}deg)`);
    setStyle(E['wind-arrow'], 'opacity', wind.opacity);
    setText(E['wind-speed'], wind.speed);
    setText(E['wind-aim'], wind.aim);
    for (const q of game.players) {
      const ref = this.sbRows.get(q.id);
      if (!ref) continue;
      const alive = q.alive, active = game.current === q;
      if (ref.alive !== alive) { ref.alive = alive; ref.row.classList.toggle('dead', !alive); }
      if (ref.active !== active) { ref.active = active; ref.row.classList.toggle('active', active); }
      setStyle(ref.fill, 'width', `${(q.hp / q.maxHp) * 100}%`);
      setText(ref.wins, winsText(q.wins));
      setPerks(ref.perks, q, false);
    }
    const mod = game.modifier;
    // The round and its modifier head the card.
    setText(E['round-label'], roundText(game.round, game.cfg.rounds));
    setText(E['round-mod'], mod.id === 'clear' ? '' : mod.name);
    setText(E['round-desc'], mod.id === 'clear' ? '' : mod.desc);
  }

  // The row of weapons the current tank carries. Rebuilt only when it changes.
  updateWeaponBar(game, p) {
    const list = ownedWeapons(game, p);
    const key = `${p.id}|${p.weapon}|${p.perks.length}|${p.ai ? 1 : 0}|${list.map((w) => `${w.id}${game.ammoLeft(p, w.id)}`).join(',')}`;
    if (key === this.weaponBarKey) return;
    this.weaponBarKey = key;
    $('weapon-bar').innerHTML = list.map((w, i) => `
    <button class="wb-item${w.id === p.weapon ? ' on' : ''}" data-i="${i}" title="${escapeHtml(game.weaponOf(p, w.id).desc)}" ${p.ai ? 'disabled' : ''}>
      <span class="wb-key">${i + 1}</span>${escapeHtml(game.weaponName(p, w.id))}<span class="wb-n">${ammoText(game.ammoLeft(p, w.id))}</span>
    </button>`).join('');
  }
}
