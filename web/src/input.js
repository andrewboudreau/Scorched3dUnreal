// The input router: the keyboard, the pointers on the view, the wheel, and the
// buttons that stand for keys. What each input does in which state (the camera's
// mode, the game's phase, the hand-off card) is src/inputmap.js (pure, tested);
// this file listens, asks it, and carries the action out.
//
// The touch controls (touch.js) press the same keys with synthetic
// KeyboardEvents on window, so they come through here unchanged; their aim pad
// and power strip are read each frame (touch.take) alongside the held keys.
// Modal pages (Settings, the Guide, the pack review) and the chat box keep
// their own keys and stop them before they get here.
//
// main.js gives it what it needs through `deps` (functions are read each time):
//   el            the view (the renderer's canvas)
//   rig, gunner   the camera (camera.js) and the sight (gunner.js)
//   touch         the touch controls, or null
//   game()        the Game, or null on the menu
//   handoff()     the hand-off card is up
//   online()      in an online room
//   hopping(id)   tank id is mid jump-jet hop
//   sound, music, settings, hud, banner(text, sub, ms)
//   openChat(), closeHandoff(), strike() (X), deploy() (B)
// and calls aim(dt) and steer() each frame before the game steps, and
// syncFind() each frame after.

import { TANK } from './core/tank.js';
import { ownedWeapons } from './hudlogic.js';
import { keyRoute, heldAxes, holdRamp, aimLive, steerDir, pointerRoute, steerSide, dragRoute, wheelRoute, sightAim, pinchSteps, DRAG_SLOP } from './inputmap.js';

const DRIVE_NOTES = {
  buried: 'Buried: your next shot digs you out',
  empty: 'Out of fuel', steep: 'Too steep to climb', water: 'Water ahead', edge: 'Edge of the arena', blocked: 'Something is in the way',
};
const JUMP_NOTES = { buried: 'Buried: your next shot digs you out', nojets: 'No jump jets left', edge: 'Edge of the arena', water: 'Water ahead', blocked: 'No room to land that way' };

const $ = (id) => document.getElementById(id);

export class Input {
  constructor(deps) {
    this.deps = deps;
    this.held = new Set();              // keys down now (lower case KeyboardEvent.key)
    this.holding = { x: 0, y: 0, p: 0 };   // seconds each aim axis has been held
    this.steerFuel = -1;                // the most guidance fuel left on a local guided missile, -1 for none
    this.steerTouch = new Map();        // pointer id -> -1 | 1, fingers steering
    this.findingWas = false;            // the touch Find button is lit
    this.listenSteer(deps.el);
    this.listenKeys();
    this.listenView(deps.el);
    this.listenButtons();
  }

  // ---------------------------------------------------------------- keys

  listenKeys() {
    const d = this.deps;
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const k = e.key.toLowerCase();
      const r = keyRoute(k, { inMatch: !!d.game(), handoff: d.handoff(), online: d.online(), repeat: e.repeat, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, mode: d.rig.mode });
      if (r.prevent) e.preventDefault();
      if (r.hold) this.held.add(k);
      if (r.action) this.act(r.action, r.arg);
      if (r.clear) this.held.clear();
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.held.clear());
    window.addEventListener('pointerdown', () => d.sound.ensure(), { once: true });
  }

  // One routed action (inputmap.js keyRoute).
  act(action, arg) {
    const d = this.deps;
    const game = d.game();
    switch (action) {
      case 'chat': d.openChat(); break;
      case 'handoff-go': d.closeHandoff(); break;
      case 'fire': if (game.current && !game.current.ai) game.fire(); break;
      case 'weapon': game.cycleWeapon(arg); d.sound.click(); break;
      case 'slot': this.selectSlot(arg); break;
      case 'jet': this.jet(); break;
      case 'find': d.rig.peekNext(); this.syncFind(); break;
      case 'sight': this.toggleSight(); break;
      case 'follow': { const on = d.rig.toggleFollow(); d.banner(on ? 'Follow cam on' : 'Follow cam off', '', 700); break; }
      case 'view': d.rig.toggleOverview(); break;
      case 'mute': this.toggleMute(); break;
      case 'volume': this.setVolume(d.sound.volume + arg, true); break;
      case 'music': { d.sound.ensure(); const t = d.music.next(); d.settings.render(); d.banner(`Music: ${t.name}`, t.mood || '', 900); break; }
      case 'strike': d.strike(); break;
      case 'deploy': d.deploy(); break;
      default:
    }
  }

  // 1-9, or a click in the weapon bar: that weapon, while a human here aims.
  selectSlot(i) {
    const { game: g, handoff } = this.deps;
    const game = g();
    const p = game.current;
    if (!p || p.ai || game.phase !== 'aim' || handoff()) return;
    const list = ownedWeapons(game, p);
    if (list[i]) { p.weapon = list[i].id; this.deps.sound.click(); }
  }

  // J: use a charge. The core moves the tank; main.js draws the arc from the game's event.
  jet() {
    const { game: g, hopping, hud } = this.deps;
    const game = g();
    const p = game.current;
    if (!p || p.ai || game.phase !== 'aim' || hopping(p.id)) return;
    const r = game.jump();
    const why = r === 'edge' && game.isles ? 'No ground to land on' : JUMP_NOTES[r];
    if (why) hud.note(why, 1400);
  }

  // G / SIGHT. The sight drives the camera only while you plan (camera.js); the
  // choice stays from turn to turn.
  toggleSight() {
    const { rig, touch, banner } = this.deps;
    const on = rig.toggleSight();
    $('gunner-btn')?.classList.toggle('on', on);
    document.querySelector('#touch [data-key=g]')?.classList.toggle('on', on);
    banner(on ? 'Sight on' : 'Sight off', on ? (touch ? 'drag to aim, pinch to zoom' : 'drag to aim, wheel to zoom') : '', 900);
  }

  toggleMute() {
    const { sound, banner, settings } = this.deps;
    sound.ensure();
    banner(sound.toggleMute() ? 'Muted' : 'Sound on', '', 700);
    settings.render();
  }

  // Master level, from - / =.
  setVolume(v, announce = false) {
    const { sound, banner, settings } = this.deps;
    sound.ensure();
    sound.setVolume(Math.round(v * 10) / 10);
    settings.render();
    if (announce) banner(`Volume ${Math.round(sound.volume * 100)}%`, '', 700);
  }

  // The touch Find button is lit while Find holds the camera on a tank.
  syncFind() {
    const finding = this.deps.rig.finding();
    if (finding !== this.findingWas) { document.querySelector('#touch [data-key="f"]')?.classList.toggle('on', finding); this.findingWas = finding; }
  }

  // ---------------------------------------------------------------- each frame

  // The held keys, the touch aim pad and the power strip aim the tank whose turn
  // it is, and the arrows drive it, while a human here plans.
  aim(dt) {
    const { game: g, handoff, touch, rig, hopping, hud } = this.deps;
    const game = g();
    const live = aimLive({ inMatch: !!game, handoff: handoff(), phase: game?.phase, human: game?.current && !game.current.ai });
    const pad = touch?.take(dt, live ? game.current : null);   // touch aim pad and power strip
    if (!live) return;
    if (pad) game.adjustAim(pad.yaw, pad.elev, pad.power);
    const a = heldAxes(this.held);
    // A short tap moves a little (fine); holding ramps up to full speed in about
    // a third of a second; Shift is three times as fast, for the big turns.
    const kx = this.ramp('x', a.yaw, dt) * a.fast, ky = this.ramp('y', a.elev, dt) * a.fast, kp = this.ramp('p', a.power, dt) * a.fast;
    if (a.yaw || a.elev || a.power) game.adjustAim(a.yaw * TANK.turretSpeed * dt * kx, a.elev * TANK.elevationSpeed * dt * ky, a.power * TANK.powerSpeed * dt * kp);
    // The arrow keys drive: up and down along the hull, left and right swing it.
    if ((a.go || a.turn) && !hopping(game.current.id)) {
      rig.driveBack(game.current);   // driving with the camera far away (or zoomed right out) brings it back
      const r = game.drive(a.go, a.turn, dt);
      const why = r === 'edge' && game.isles ? 'Edge of the isle' : DRIVE_NOTES[r];
      if (why) hud.note(why, 1200);
    }
  }

  ramp(axis, on, dt) {
    const t = this.holding[axis] = on ? this.holding[axis] + dt : 0;
    return holdRamp(t);
  }

  // A / D (or the side arrows) turn every human's guided missile while it flies;
  // on a touch screen, a finger held on the left or right half of the view does.
  // On a shared screen they all answer the same keys; with one human, only yours.
  steer() {
    const { game: g, hud } = this.deps;
    const game = g();
    if (!game || game.phase !== 'flight') { hud.steer(null); this.steerFuel = -1; this.steerTouch.clear(); return; }
    let finger = 0;
    for (const s of this.steerTouch.values()) finger += s;
    const dir = steerDir(this.held, finger);
    let fuel = -1, jam = false;
    for (const p of game.localHumans) {
      game.steer(p.id, dir);
      for (const pr of game.projectiles) if (pr.owner === p.id && pr.steer) { fuel = Math.max(fuel, pr.steer.fuel); jam ||= !!pr.steer.jammed; }
    }
    this.steerFuel = fuel;
    hud.steer({ fuel, jam, dir });   // the hint (hud.js)
  }

  // ---------------------------------------------------------------- the view

  // A steering finger is caught before the view's own handlers, so it does not also orbit.
  listenSteer(el) {
    const { touch } = this.deps;
    window.addEventListener('pointerdown', (e) => {
      if (pointerRoute({ touch: !!touch, steering: this.steerFuel > 0, onView: e.target === el }) !== 'steer') return;
      this.steerTouch.set(e.pointerId, steerSide(e.clientX, window.innerWidth));
      touch.buzz?.(8);
      e.stopPropagation();
    }, { capture: true });
    for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => this.steerTouch.delete(e.pointerId), { capture: true });
  }

  // Drags and the wheel on the view. The orbit controls (camera.js) listen on it
  // too and are off in the sight.
  listenView(el) {
    const { rig, gunner, game } = this.deps;
    const sight = () => gunner.active;     // the sight is driving the camera (rig.mode 'sight')
    // In the sight, a drag aims: across turns the turret by as much as the view
    // moves under the finger, up and down raises the barrel. Wheel or pinch zooms.
    const aimDrag = new Map();     // pointer id -> last [x, y]
    el.addEventListener('pointerdown', (e) => { if (sight()) aimDrag.set(e.pointerId, [e.clientX, e.clientY]); });
    el.addEventListener('pointermove', (e) => {
      const was = aimDrag.get(e.pointerId);
      if (!was || !sight()) return;
      const now = [e.clientX, e.clientY];
      if (dragRoute({ sight: true, fingers: aimDrag.size }) === 'zoom') {
        // Pinch: the change in spread between the first two fingers.
        const [[ia, qa], [ib, qb]] = [...aimDrag.entries()];
        const a = ia === e.pointerId ? now : qa;
        const b = ib === e.pointerId ? now : qb;
        const before = Math.hypot(qa[0] - qb[0], qa[1] - qb[1]);
        const after = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (before > 0 && after > 0) gunner.zoom(pinchSteps(before, after));
      } else {
        const [yaw, elev] = sightAim(now[0] - was[0], now[1] - was[1], rig.camera.fov, window.innerHeight);
        game().adjustAim(yaw, elev, 0);
      }
      aimDrag.set(e.pointerId, now);
    });
    for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => aimDrag.delete(e.pointerId));
    el.addEventListener('wheel', (e) => { if (wheelRoute({ sight: sight() }) === 'zoom') gunner.zoom(Math.sign(e.deltaY)); }, { passive: true });

    // Only a real drag or a wheel zoom takes the camera over; a plain click (e.g. to
    // focus the page) must not strand it halfway through a fly-in.
    let dragFrom = null;
    el.addEventListener('pointerdown', (e) => { dragFrom = [e.clientX, e.clientY]; });
    el.addEventListener('pointermove', (e) => {
      if (dragFrom && Math.hypot(e.clientX - dragFrom[0], e.clientY - dragFrom[1]) > DRAG_SLOP) { dragFrom = null; rig.takeOver(); }
    });
    for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, () => { dragFrom = null; });
    el.addEventListener('wheel', () => rig.takeOver(), { passive: true });
  }

  // ---------------------------------------------------------------- buttons that stand for keys

  listenButtons() {
    const { sound, game } = this.deps;
    // The desktop SIGHT button (G). Blur: Space must fire, not press it again.
    $('gunner-btn').onclick = (e) => { e.currentTarget.blur(); sound.click(); this.toggleSight(); };
    // The weapon bar (1-9).
    $('weapon-bar').addEventListener('click', (e) => {
      const b = e.target.closest('.wb-item');
      if (b && game()) this.selectSlot(Number(b.dataset.i));
    });
  }
}
