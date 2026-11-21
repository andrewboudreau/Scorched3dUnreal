// On-screen controls for phones and tablets.
//
// Nothing here talks to the game directly. Buttons press and release the same
// keys the keyboard does (a synthetic KeyboardEvent on window, so main.js's key
// handler, `held` set and hand-off logic all apply unchanged), and the aim pad
// and power strip hand main.js a small aim delta each frame through take(),
// which it feeds to game.adjustAim exactly like the held A/D/W/S/Q/E keys. The
// weapon button opens the game's own weapon bar as a pop-up above it.
//
// Tilt aim (lean and grip modes) was tried and dropped for now; it is in git
// history before this comment, and docs/mobile.md says what was learned.
//
// Shown on touch-first devices (pointer: coarse) or with ?mobile=1; ?mobile=0
// turns it off. See docs/mobile.md for the design and what to try next.

import { TANK } from './core/tank.js';

export const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function wantTouch() {
  const q = new URLSearchParams(location.search).get('mobile');
  if (q === '0') return false;
  return q === '1' || coarsePointer;
}

// Cheap defaults for phone and tablet GPUs: fewer pixels, a smaller shadow map.
export function mobilePerf(renderer, sky) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  sky.sun.shadow.mapSize.set(2048, 2048);   // 4096² is 64 MB of depth on a phone
}

// Aim pad and power strip: a drag moves the aim like a trackpad moves a cursor.
// Slow drags are precise; quick flicks are boosted (pointer acceleration) so a
// half turn does not take five swipes.
const PAD = { yaw: 0.22, elev: 0.14, power: 0.16, fine: 0.2 };   // per CSS pixel
const accel = (pxPerMs) => 1 + Math.min(2, Math.max(0, (pxPerMs - 0.25) * 3));

const vibe = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* not allowed yet */ } };
// Keep the finger's moves and release on this element even if it slides off.
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* a synthetic or already-gone pointer */ } };

function key(type, k) {
  window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
}

export class TouchControls {
  // online() says whether this is a networked game (Chat is shown only then);
  // weaponBar is the game's weapon list, shown here as the weapon pop-up.
  constructor({ parent, unlockAudio, weaponBar, online = () => false }) {
    this.acc = { yaw: 0, elev: 0, power: 0 };
    this.fine = false;
    this.live = false;
    this.online = online;
    this.weaponBar = weaponBar;
    this.shown = {};
    document.body.classList.add('touch');

    const root = this.root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="t-left">
        <div class="t-btn t-jet" data-key="j">JET</div>
        <div class="t-dpad">
          <div class="t-btn up" data-hold="ArrowUp">&#9650;</div>
          <div class="t-btn left" data-hold="ArrowLeft">&#9664;</div>
          <div class="t-btn right" data-hold="ArrowRight">&#9654;</div>
          <div class="t-btn down" data-hold="ArrowDown">&#9660;</div>
        </div>
      </div>
      <div class="t-mid">
        <div class="t-btn t-small" data-act="fine">Fine</div>
        <div class="t-btn t-small" data-key="f">Find</div>
        <div class="t-btn t-small" data-key="v">View</div>
        <div class="t-btn t-small" data-act="chat">Chat</div>
      </div>
      <div class="t-right">
        <div class="t-power"><i></i><b></b><span>PWR</span></div>
        <div class="t-pad"><span class="t-read"></span><small>drag: &#8596; turret &nbsp; &#8597; elevation</small></div>
        <div class="t-col">
          <div class="t-btn t-weapon" data-act="weapons"></div>
          <div class="t-btn t-fire" data-key=" ">FIRE</div>
        </div>
      </div>
      <div class="t-note"></div>
      <div class="t-rotate"><div>&#x21BB;</div>Turn your phone sideways</div>`;
    parent.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.el = {
      pad: $('.t-pad'), read: $('.t-read'), power: $('.t-power'), powerFill: $('.t-power i'), powerNum: $('.t-power b'),
      fire: $('.t-fire'), weapon: $('.t-weapon'), note: $('.t-note'), mid: $('.t-mid'),
      fineBtn: $('[data-act=fine]'), chat: $('[data-act=chat]'),
    };
    this.el.chat.style.display = 'none';

    // Every tap is a chance to start (or resume) the audio: mobile browsers only
    // count pointerup / touchend as a user gesture, not the pointerdown main.js listens for.
    window.addEventListener('pointerup', () => unlockAudio?.(), true);
    window.addEventListener('touchend', () => unlockAudio?.(), true);
    root.addEventListener('contextmenu', (e) => e.preventDefault());   // long-press menu on Android

    for (const b of root.querySelectorAll('[data-key]')) this.tapKey(b, b.dataset.key);
    for (const b of root.querySelectorAll('[data-hold]')) this.holdKey(b, b.dataset.hold);
    this.el.fineBtn.addEventListener('click', () => { this.fine = !this.fine; this.el.fineBtn.classList.toggle('on', this.fine); });
    // Enter, as on the keyboard. On click, not pointerdown: the chat box takes
    // focus, and phones only raise the keyboard for a full tap.
    this.el.chat.addEventListener('click', () => { key('keydown', 'Enter'); key('keyup', 'Enter'); });
    this.weaponMenu();
    this.drag(this.el.pad, (dx, dy, speed) => {
      const k = (this.fine ? PAD.fine : 1) * accel(speed);
      this.acc.yaw += dx * PAD.yaw * k;
      this.acc.elev -= dy * PAD.elev * k;
    });
    this.drag(this.el.power, (dx, dy, speed) => {
      this.acc.power -= dy * PAD.power * (this.fine ? PAD.fine : 1) * accel(speed);
    });
  }

  // The weapon button opens the weapon bar as a list above it; picking one (the
  // bar's own click handler in main.js selects it) or tapping elsewhere closes it.
  weaponMenu() {
    const bar = this.weaponBar, btn = this.el.weapon;
    if (!bar) return;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      vibe(8);
      this.openWeapons(!bar.classList.contains('open'));
    });
    bar.addEventListener('click', (e) => { if (e.target.closest('.wb-item')) this.openWeapons(false); });
    window.addEventListener('pointerdown', (e) => {
      if (bar.classList.contains('open') && !bar.contains(e.target) && !btn.contains(e.target)) this.openWeapons(false);
    }, true);
  }

  openWeapons(on) {
    this.weaponBar?.classList.toggle('open', on);
    this.el.weapon.classList.toggle('on', on);
  }

  // Put another control (the settings button) in the middle row.
  dock(el) { this.el.mid.appendChild(el); }

  // One press of a key (Space, Tab, J, F, V): down and straight back up.
  tapKey(el, k) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('pressed');
      key('keydown', k);
      key('keyup', k);
      vibe(k === ' ' ? 30 : k === 'j' ? 20 : 8);
    });
    const up = () => el.classList.remove('pressed');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  // A key held for as long as the finger stays down (the drive arrows; in flight,
  // left / right also steer a Guided Missile, as on the keyboard).
  holdKey(el, k) {
    let id = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      capture(el, e.pointerId);
      el.classList.add('pressed');
      key('keydown', k);
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('pressed');
      key('keyup', k);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  // A relative drag on `el`: calls fn(dx, dy, pxPerMs) as the finger moves.
  drag(el, fn) {
    let id = null, x = 0, y = 0, t = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== null) return;
      id = e.pointerId; x = e.clientX; y = e.clientY; t = e.timeStamp;
      capture(el, e.pointerId);
      el.classList.add('pressed');
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - x, dy = e.clientY - y;
      const speed = Math.hypot(dx, dy) / Math.max(1, e.timeStamp - t);
      x = e.clientX; y = e.clientY; t = e.timeStamp;
      if (this.live) fn(dx, dy, speed);
    });
    const up = (e) => { if (e.pointerId === id) { id = null; el.classList.remove('pressed'); } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  // Called by main.js every frame with the tank being aimed here (or null).
  // Returns the aim change to apply this frame, or null.
  take(dt, p) {
    const live = this.live = !!p;
    this.root.classList.toggle('idle', !live);
    const { yaw, elev, power } = this.acc;
    this.acc.yaw = this.acc.elev = this.acc.power = 0;
    if (!live) {
      if (this.weaponBar?.classList.contains('open')) this.openWeapons(false);
      return null;
    }
    this.show(p);
    return yaw || elev || power ? { yaw, elev, power } : null;
  }

  show(p) {
    const s = this.shown;
    const set = (name, el, v) => { if (s[name] !== v) { s[name] = v; el.textContent = v; } };
    set('read', this.el.read, `${(((p.yaw % 360) + 360) % 360).toFixed(1)}°  ${p.elev.toFixed(1)}°`);
    set('pow', this.el.powerNum, p.power.toFixed(0));
    const h = `${(p.power / TANK.maxPower) * 100}%`;
    if (s.h !== h) { s.h = h; this.el.powerFill.style.height = h; }
    // Mirror main.js's own labels rather than reach into the game for them.
    set('fire', this.el.fire, /lock/.test(document.getElementById('help-fire')?.textContent) ? 'LOCK IN' : 'FIRE');
    set('weapon', this.el.weapon, document.getElementById('ro-weapon')?.textContent || 'Weapon');
    const on = this.online();
    if (s.online !== on) { s.online = on; this.el.chat.style.display = on ? '' : 'none'; }
  }

  note(text) {
    this.el.note.textContent = text;
    this.el.note.classList.add('show');
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.el.note.classList.remove('show'), 2200);
  }

  buzz(pattern) { vibe(pattern); }
}
