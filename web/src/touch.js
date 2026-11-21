// On-screen controls for phones and tablets, plus an optional tilt aim.
//
// Nothing here talks to the game directly. Buttons press and release the same
// keys the keyboard does (a synthetic KeyboardEvent on window, so main.js's key
// handler, `held` set and hand-off logic all apply unchanged), and the aim pad,
// power strip and tilt hand main.js a small aim delta each frame through
// take(), which it feeds to game.adjustAim exactly like the held A/D/W/S/Q/E keys.
//
// Shown on touch-first devices (pointer: coarse) or with ?mobile=1; ?mobile=0
// turns it off. See docs/mobile.md for the design and what to try next.

import { TANK } from './core/tank.js';

const DEG = 180 / Math.PI;

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

// Tilt as a joystick: lean the right edge down to turn right, pull the top edge
// toward you to raise the barrel. Angles are from the pose zeroed at the start
// of each aim (or with Zero). Inside the deadzone nothing moves; past it the
// rate grows with the square of the lean, to full speed at TILT.full degrees.
const TILT = { dead: 3, full: 22, rate: 0.75, smooth: 0.08 };

const vibe = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* not allowed yet */ } };
// Keep the finger's moves and release on this element even if it slides off.
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* a synthetic or already-gone pointer */ } };

function key(type, k) {
  window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
}

export class TouchControls {
  constructor({ parent, unlockAudio }) {
    this.acc = { yaw: 0, elev: 0, power: 0 };
    this.fine = false;
    this.live = false;
    this.tilt = { on: false, zero: null, u: null, at: 0, seen: false };
    this.shown = {};
    this.onOrient = this.onOrient.bind(this);
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
        <div class="t-btn t-small" data-act="tilt">Tilt</div>
        <div class="t-btn t-small" data-act="zero">Zero</div>
        <div class="t-btn t-small" data-act="fine">Fine</div>
        <div class="t-btn t-small" data-key="f">Find</div>
        <div class="t-btn t-small" data-key="v">View</div>
        <div class="t-btn t-small" data-act="full">&#x26F6;</div>
      </div>
      <div class="t-right">
        <div class="t-power"><i></i><b></b><span>PWR</span></div>
        <div class="t-pad"><span class="t-read"></span><small>drag: &#8596; turret &nbsp; &#8597; elevation</small></div>
        <div class="t-col">
          <div class="t-btn t-weapon" data-key="Tab"></div>
          <div class="t-btn t-fire" data-key=" ">FIRE</div>
        </div>
      </div>
      <div class="t-note"></div>
      <div class="t-rotate"><div>&#x21BB;</div>Turn your phone sideways</div>`;
    parent.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.el = {
      pad: $('.t-pad'), read: $('.t-read'), power: $('.t-power'), powerFill: $('.t-power i'), powerNum: $('.t-power b'),
      fire: $('.t-fire'), weapon: $('.t-weapon'), note: $('.t-note'),
      tilt: $('[data-act=tilt]'), zero: $('[data-act=zero]'), fineBtn: $('[data-act=fine]'), full: $('[data-act=full]'),
    };
    const fs = document.documentElement;
    if (!fs.requestFullscreen && !fs.webkitRequestFullscreen) this.el.full.style.display = 'none';   // iPhone Safari
    this.el.zero.classList.add('off');

    // Every tap is a chance to start (or resume) the audio: mobile browsers only
    // count pointerup / touchend as a user gesture, not the pointerdown main.js listens for.
    window.addEventListener('pointerup', () => unlockAudio?.(), true);
    window.addEventListener('touchend', () => unlockAudio?.(), true);
    root.addEventListener('contextmenu', (e) => e.preventDefault());   // long-press menu on Android

    for (const b of root.querySelectorAll('[data-key]')) this.tapKey(b, b.dataset.key);
    for (const b of root.querySelectorAll('[data-hold]')) this.holdKey(b, b.dataset.hold);
    this.el.tilt.addEventListener('click', () => this.toggleTilt());
    this.el.zero.addEventListener('click', () => { this.tilt.zero = null; this.note('Tilt zeroed'); vibe(10); });
    this.el.fineBtn.addEventListener('click', () => { this.fine = !this.fine; this.el.fineBtn.classList.toggle('on', this.fine); });
    this.el.full.addEventListener('click', () => this.fullscreen());
    this.drag(this.el.pad, (dx, dy, speed) => {
      const k = (this.fine ? PAD.fine : 1) * accel(speed);
      this.acc.yaw += dx * PAD.yaw * k;
      this.acc.elev -= dy * PAD.elev * k;
    });
    this.drag(this.el.power, (dx, dy, speed) => {
      this.acc.power -= dy * PAD.power * (this.fine ? PAD.fine : 1) * accel(speed);
    });
    screen.orientation?.addEventListener?.('change', () => { this.tilt.zero = null; });
  }

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

  async toggleTilt() {
    const t = this.tilt;
    if (t.on) {
      t.on = false;
      window.removeEventListener('deviceorientation', this.onOrient);
      this.sync();
      this.note('Tilt off');
      return;
    }
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { this.note('This device has no tilt sensor'); return; }
    if (!window.isSecureContext) { this.note('Tilt needs https'); return; }
    // iOS 13+: must be asked from inside the tap, before any other await.
    if (typeof DOE.requestPermission === 'function') {
      let answer = 'denied';
      try { answer = await DOE.requestPermission(); } catch { /* not from a gesture */ }
      if (answer !== 'granted') { this.note('Motion access was not allowed'); return; }
    }
    Object.assign(t, { on: true, zero: null, u: null, seen: false });
    window.addEventListener('deviceorientation', this.onOrient);
    this.sync();
    this.note('Tilt on: lean right / left to turn, top toward you to raise');
    setTimeout(() => { if (t.on && !t.seen) this.note('No tilt readings from this device'); }, 1500);
  }

  // The device's up vector in screen axes (x right, y up, z out of the glass),
  // low-passed. From the W3C Z-X'-Y'' angles: up = (-cosβ sinγ, sinβ, cosβ cosγ)
  // in device axes, then rotated by the screen's orientation angle.
  onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    const t = this.tilt;
    t.seen = true;
    const b = e.beta / DEG, g = e.gamma / DEG;
    const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
    const a = (screen.orientation?.angle ?? window.orientation ?? 0) / DEG;
    const s = { x: Math.cos(a) * ux - Math.sin(a) * uy, y: Math.sin(a) * ux + Math.cos(a) * uy, z: uz };
    const k = t.u ? 1 - Math.exp(-Math.max(0, e.timeStamp - t.at) / 1000 / TILT.smooth) : 1;
    t.at = e.timeStamp;
    t.u = t.u ? { x: t.u.x + (s.x - t.u.x) * k, y: t.u.y + (s.y - t.u.y) * k, z: t.u.z + (s.z - t.u.z) * k } : s;
  }

  // Lean (how far the right edge is below the left) and pitch (0 upright, 90 flat on its back), in degrees.
  pose() {
    const u = this.tilt.u;
    return { lean: -Math.asin(Math.max(-1, Math.min(1, u.x))) * DEG, pitch: Math.atan2(u.z, u.y) * DEG };
  }

  // Called by main.js every frame with the tank being aimed here (or null).
  // Returns the aim change to apply this frame, or null.
  take(dt, p) {
    const live = this.live = !!p;
    this.root.classList.toggle('idle', !live);
    const t = this.tilt;
    if (live && !this.wasLive) t.zero = null;   // each new aim starts from however you hold it
    this.wasLive = live;
    let { yaw, elev, power } = this.acc;
    this.acc.yaw = this.acc.elev = this.acc.power = 0;
    if (!live) return null;

    if (t.on && t.u) {
      const now = this.pose();
      if (!t.zero) t.zero = now;
      const axis = (deg) => {
        const n = Math.min(1, Math.max(0, (Math.abs(deg) - TILT.dead) / (TILT.full - TILT.dead)));
        return Math.sign(deg) * n * n * TILT.rate * (this.fine ? PAD.fine : 1);
      };
      yaw += axis(now.lean - t.zero.lean) * TANK.turretSpeed * dt;
      elev += axis(t.zero.pitch - now.pitch) * TANK.elevationSpeed * dt;
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
  }

  sync() {
    this.el.tilt.classList.toggle('on', this.tilt.on);
    this.el.zero.classList.toggle('off', !this.tilt.on);
  }

  note(text) {
    this.el.note.textContent = text;
    this.el.note.classList.add('show');
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.el.note.classList.remove('show'), 2200);
  }

  fullscreen() {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen)?.call(d); return; }
    const go = el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.();
    // Android Chrome can then pin landscape; elsewhere this rejects and that is fine.
    Promise.resolve(go).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  }

  buzz(pattern) { vibe(pattern); }
}
