import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { overviewGoal } from './render/ridgeline.js';
import { clampCameraY } from './camlimit.js';
import { CameraModes, decidingShot, easeTimeScale, killSide, labelMode } from './cameramode.js';

// The camera rig: the main camera, its orbit controls and everything that moves
// them. Which mode drives the camera each frame, and the rules for entering and
// leaving each one, are src/cameramode.js (pure, tested); this file does the
// moving, in three.js:
//
//   menu      a slow orbit high over the menu's field
//   kill      off to the side of the deciding shot, low, looking at the target
//             with the shell coming in (time slows: timeScale)
//   overview  standing back over the middle of the map (render/ridgeline.js overviewGoal)
//   sight     the Gunner (gunner.js) rides behind the turret; the orbit controls
//             are off, a drag aims and a pinch or the wheel zooms
//   hero      riding this screen's shell in a volley (its tank in the beat before)
//   volley    a shared screen's volley: far enough back to see every shell
//   follow    the middle of the shells in sight
//   peek      on the tank (or spot) being looked at
//   plan      on the tank whose turn it is; swung round behind it at each turn
//   hold      where it is
//
// Everywhere but the sight the orbit controls stay live: a drag or wheel zoom
// takes the camera over (userCam) until the next turn. The camera never sinks
// into the ground (camlimit.js), and blasts shake it.
//
// main.js gives it what it needs from the match through `deps` (functions, read
// each time):
//   game()        the Game, or null on the menu
//   planner()     the tank this screen is planning a shot for, or null
//   hero()        the id of this screen's one human in a volley, or null
//   fogFor()      the tanks this screen sees for (fog of war), or null
//   seen(p)       this screen can see tank p
//   believed(p)   where this screen believes p is ({ x, y, z, ... }), or null
//   shellPos(pr)  where to draw a projectile this frame
//   shellHidden(pr)  the fog hides a projectile
//   field()       the terrain under the camera (the match's, or the menu's)
//   floorY()      the desert floor's height
//   gunner        the sight (gunner.js Gunner)
//
// ---------------------------------------------------------------- next extractions
//
// The architecture review (issue #1) splits main.js one piece at a time; this
// camera was the first. The next ones, each its own module with main.js as glue:
//
// 1. HUD and labels (hud.js): updateHud, the scoreboard, the marks over the
//    tanks (updateLabels; labelMode is already here), the edge locators, pips,
//    the range card and the inset view. They read rig.mode, rig.modes and the
//    game, and write the DOM only through the setText/setStyle helpers. A pure
//    part (what each mark says, where a locator sits) gets tests, as hudview.js has.
// 2. Input router (input.js): keys, the touch controls' synthetic keys, pointer
//    steering and the held-key aim ramp, routed by mode: in 'sight' a drag aims,
//    in 'kill' nothing but the camera keys, on a hand-off card only Space/Enter.
//    A pure keymap (key + mode + phase -> action) is testable without the DOM.
//    The camera's own canvas listeners (here) would move there too.
// 3. Match glue (match.js): startMatch / disposeMatch / toMenuScene and the
//    Game event switch (handleEvents), which today call into the camera, the
//    HUD, sound and effects. Split the switch into per-concern handlers
//    (camera.event(e), hud.event(e), ...) as strikeUi/bossUi/modsUi already do.
// What stays in main.js: building the scene, the frame loop and window.craterfall.

const DEG = Math.PI / 180;

export class CameraRig {
  constructor(renderer, deps) {
    this.deps = deps;
    const camera = this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 6000);
    camera.position.set(0, 420, 520);
    const controls = this.controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 12;
    controls.maxDistance = 1400;
    controls.target.set(0, 20, 0);

    this.modes = new CameraModes();   // the choices and the kill cam (cameramode.js)
    this.mode = 'menu';               // the mode that drove the camera on the last update()
    this.target = new THREE.Vector3(0, 20, 0);   // where the orbit target eases to
    // Desired camera offset from the orbit target, eased in spherical coordinates
    // so a turn change swings around instead of cutting overhead. It may point at
    // _killGoal / _menuGoal (only read from there).
    this.goal = null;
    this.userCam = false;             // the player has dragged or zoomed this turn; leave the camera alone
    this.timeScale = 1;               // game speed: slowed for the kill cam
    this.shakeAmt = 0;
    this.lastShake = new THREE.Vector3();
    // Scratch, for per-frame work; nothing keeps one past the call that filled it.
    this._v = new THREE.Vector3();
    this._sCur = new THREE.Spherical();
    this._sGoal = new THREE.Spherical();
    this._off = new THREE.Vector3();
    this._shellC = new THREE.Vector3();
    this._before = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._killGoal = new THREE.Vector3();
    this._menuGoal = new THREE.Vector3();
    this.listen(renderer.domElement);
  }

  // ---------------------------------------------------------------- input on the view

  listen(el) {
    const { camera, deps } = this;
    const gunner = deps.gunner;
    // In the sight, a drag aims: across turns the turret by as much as the view
    // moves under the finger, up and down raises the barrel. Wheel or pinch zooms.
    const aimDrag = new Map();     // pointer id -> last [x, y]
    el.addEventListener('pointerdown', (e) => { if (gunner.active) aimDrag.set(e.pointerId, [e.clientX, e.clientY]); });
    el.addEventListener('pointermove', (e) => {
      const was = aimDrag.get(e.pointerId);
      if (!was || !gunner.active) return;
      const now = [e.clientX, e.clientY];
      if (aimDrag.size >= 2) {
        // Pinch: the change in spread between the first two fingers.
        const [[ia, qa], [ib, qb]] = [...aimDrag.entries()];
        const a = ia === e.pointerId ? now : qa;
        const b = ib === e.pointerId ? now : qb;
        const before = Math.hypot(qa[0] - qb[0], qa[1] - qb[1]);
        const after = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (before > 0 && after > 0) gunner.zoom(Math.log(before / after) / 0.12);
      } else {
        const perPx = camera.fov / window.innerHeight;     // degrees of view per pixel
        deps.game().adjustAim((now[0] - was[0]) * perPx, -(now[1] - was[1]) * perPx * 0.5, 0);
      }
      aimDrag.set(e.pointerId, now);
    });
    for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => aimDrag.delete(e.pointerId));
    el.addEventListener('wheel', (e) => { if (gunner.active) gunner.zoom(Math.sign(e.deltaY)); }, { passive: true });

    // Only a real drag or a wheel zoom takes the camera over; a plain click (e.g. to
    // focus the page) must not strand it halfway through a fly-in.
    let dragFrom = null;
    el.addEventListener('pointerdown', (e) => { dragFrom = [e.clientX, e.clientY]; });
    el.addEventListener('pointermove', (e) => {
      if (dragFrom && Math.hypot(e.clientX - dragFrom[0], e.clientY - dragFrom[1]) > 4) { this.goal = null; dragFrom = null; this.userCam = true; }
    });
    for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, () => { dragFrom = null; });
    el.addEventListener('wheel', () => { this.goal = null; this.userCam = true; }, { passive: true });
  }

  // ---------------------------------------------------------------- transitions

  // Swing round behind tank p, looking the way its turret points.
  aimAt(p) {
    if (this.modes.pinned) return;
    const game = this.deps.game();
    this.target.set(p.x, p.y + 4, p.z);
    const back = new THREE.Vector3(-Math.cos(p.yaw * DEG), 0, -Math.sin(p.yaw * DEG));
    this.goal = back.multiplyScalar(70).add(new THREE.Vector3(0, 28, 0));
    // On a ridgeline the spot behind a tank can be up a mountain: stand above it.
    if (game?.ridgeline) this.goal.y = Math.max(this.goal.y, game.terrain.heightAt(p.x + this.goal.x, p.z + this.goal.z) + 14 - this.target.y);
  }

  // A new planner (`visible`: this screen can see them) gets the camera back.
  turn(p, visible) {
    this.userCam = false;
    if (!this.modes.overview && visible) this.aimAt(p);
  }

  // A volley fires: with one human here (hero), start from behind their tank.
  volley(hero) {
    if (hero && this.modes.follow && !this.modes.overview) this.aimAt(hero);
  }

  // Driving with the camera far away (or zoomed right out) brings it back to the tank.
  driveBack(p) {
    if (!this.goal && !this.modes.overview && !this.modes.pinned && this.camera.position.distanceTo(this.controls.target) > 260) this.aimAt(p);
  }

  // V / View: the map, or back to the tank whose turn it is.
  toggleOverview() {
    const game = this.deps.game();
    if (this.modes.toggleOverview()) this.goal = overviewGoal(game, this.camera);
    else if (game.current) this.aimAt(game.current);
    return this.modes.overview;
  }

  toggleSight() { return this.modes.toggleSight(); }
  toggleFollow() { return this.modes.toggleFollow(); }

  // A look at another tank: three seconds (a click on its mark), or held until
  // Find moves on or is pressed past the last enemy (hold). Fog: at where this
  // screen believes it is.
  peekAt(p, hold = false) {
    const game = this.deps.game();
    if (!game || game.phase !== 'aim' || !p.alive || p === game.current) { this.modes.endLook(); return; }
    if (!this.deps.seen(p)) { const b = this.deps.believed(p); if (b) this.peekSpot([b.x, b.y, b.z], hold); return; }
    this.modes.look({ id: p.id, who: game.current?.id, hold, now: performance.now() });
    this.goal = null;
  }

  // A look at a spot on the ground (the rangefinder card's click: three seconds).
  peekSpot(pos, hold = false) {
    const game = this.deps.game();
    if (!game || game.phase !== 'aim') return;
    this.modes.look({ who: game.current?.id, x: pos[0], y: pos[1], z: pos[2], hold, now: performance.now() });
    this.goal = null;
  }

  // Whether a look is on (it ends when its time is up, the planning ends, or the turn passes).
  looking() {
    const game = this.deps.game();
    if (!game) { this.modes.endLook(); return false; }
    return this.modes.lookLive({ phase: game.phase, current: game.current?.id, now: performance.now() });
  }

  // Find is holding the camera on a tank (its button is lit).
  finding() { return !!this.modes.peek && this.modes.peek.until === Infinity && this.looking(); }

  // F / Find: hold the camera on the next opponent, nearest first. Pressed on the
  // last one (or the only one, 1v1) it lets go and the camera returns to you.
  peekNext() {
    const game = this.deps.game();
    const me = game.current;
    if (!me) return;
    const believed = this.deps.believed;
    const where = (p) => believed(p) || { x: 1e6, z: 1e6 };
    const foes = game.players.filter((p) => p.alive && p !== me && believed(p))
      .sort((a, b) => Math.hypot(where(a).x - me.x, where(a).z - me.z) - Math.hypot(where(b).x - me.x, where(b).z - me.z));
    if (!foes.length) return;
    const peek = this.modes.peek;
    const at = this.looking() && peek.until === Infinity ? foes.findIndex((p) => p.id === (peek.id ?? peek.fogId)) : -1;
    if (at === foes.length - 1) { this.modes.endLook(); return; }
    const next = foes[at + 1];
    this.peekAt(next, true);
    if (this.modes.peek && this.modes.peek.id == null) this.modes.peek.fogId = next.id;
  }

  // How much the marks over the tanks say (cameramode.js labelMode).
  labelMode(phase) {
    const m = this.modes;
    return labelMode(m, { phase, sight: this.mode === 'sight', looking: !m.kill && this.mode !== 'sight' && !m.overview && this.looking() });
  }

  // Debug (window.craterfall): hold the camera at `from` looking at x, y, z until release().
  lookAt(x, y, z, from) {
    this.modes.pin();
    this.target.set(x, y, z);
    this.controls.target.set(x, y, z);
    this.camera.position.set(...from);
    this.goal = null;
  }

  release() { this.modes.release(); }

  // A blast at `pos` shakes the camera, less the further off it is.
  shake(pos, power) {
    const d = this.camera.position.distanceTo(this._v.set(pos[0], pos[1], pos[2]));
    this.shakeAmt = Math.max(this.shakeAmt, power * Math.max(0, 1 - d / 900));
  }

  // ---------------------------------------------------------------- the kill cam

  // Once a frame in a match, before the game steps: start the kill cam when a
  // shell is about to decide the round, end it after its shell is down, and
  // ease the game's speed (timeScale) into and out of the slow motion.
  updateKill(dt) {
    const game = this.deps.game();
    const m = this.modes;
    if (m.canKill(game.phase)) {
      const k = decidingShot(game);
      if (k) {
        const pr = game.projectiles.find((q) => q.id === k.id);
        const v = game.players[k.victim];
        // Watch from the side of the incoming line, on the side the camera is already on.
        const { side, dir } = killSide([pr.pos[0], pr.pos[2]], [v.x, v.z], [this.camera.position.x, this.camera.position.z]);
        m.startKill({ id: k.id, victim: k.victim, side, dir });
        const by = game.players[k.from];
        document.getElementById('killcam-cap').textContent = by.id === v.id ? `${v.name}…` : `${by.name} → ${v.name}`;
        document.body.classList.add('killcam');
      }
    }
    if (m.kill && m.stepKill({ shellGone: !game.projectiles.some((q) => q.id === m.kill.id), now: performance.now() })) document.body.classList.remove('killcam');
    this.timeScale = easeTimeScale(this.timeScale, m.kill, dt);
  }

  // End the kill cam at once, at full speed (a new round, the menu).
  cutKill() {
    this.modes.cutKill();
    this.timeScale = 1;
    document.body.classList.remove('killcam');
  }

  // Off to the side, low, looking at the target with the shell coming in.
  killView(game, dt) {
    const k = this.modes.kill;
    const v = game.players[k.victim];
    const pr = game.projectiles.find((q) => q.id === k.id);
    // Look between the target and the incoming shell; once it has landed, let
    // the pull fade instead of snapping back onto the tank.
    if (pr) { const s = this.deps.shellPos(pr); k.shell = [s[0], s[1], s[2]]; }
    const pull = k.pull = pr ? 0.3 : (k.pull ?? 0) * Math.exp(-dt * 3);
    this.target.set(v.x, v.y + 3, v.z);
    if (k.shell && pull > 0.001) this.target.lerp(this._v.set(...k.shell), pull);
    const [sx, sz] = k.side, [dx, dz] = k.dir;
    // The goal is an offset from the target.
    this.goal = this._killGoal.set(sx * 40 - dx * 16 + (v.x - this.target.x), 24, sz * 40 - dz * 16 + (v.z - this.target.z));
  }

  // ---------------------------------------------------------------- each frame

  // The mode for this frame (cameramode.js resolve).
  resolve(game, planner) {
    if (!game) return this.modes.resolve({ inMatch: false });
    const pr = game.projectiles;
    return this.modes.resolve({
      inMatch: true, phase: game.phase, planner: !!planner, current: game.current?.id, volleyMode: game.volleyMode,
      hero: this.deps.hero() != null, shellsInAir: pr.length > 0, shellsShown: pr.some((q) => !this.deps.shellHidden(q)), now: performance.now(),
    });
  }

  // Hand the camera back to the orbit controls from wherever the sight left it,
  // looking the same way, so nothing jumps.
  leaveSight() {
    const { gunner } = this.deps;
    gunner.active = false;
    gunner.hide();
    this.controls.enabled = true;
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.camera.position).add(this._v.set(0, 0, -100).applyQuaternion(this.camera.quaternion));
  }

  // Where the target goes in each mode; returns the distance a shared-screen volley asks for (or 0).
  place(mode, game, dt) {
    const { deps, target, _v } = this;
    switch (mode) {
      case 'kill':
        this.killView(game, dt);
        break;
      case 'overview':
        target.set(0, 10, 0);
        break;
      case 'hero': {
        // Your volley: ride your own shell. Once it is down, hold on where it
        // landed; the others' landings show as pips.
        const heroId = deps.hero();
        const hero = game.players[heroId];
        const mine = game.projectiles.filter((pr) => pr.owner === heroId);
        if (game.phase === 'volley') target.set(hero.x, hero.y + 4, hero.z);
        else if (mine.length) {
          target.set(0, 0, 0);
          mine.forEach((pr) => target.add(_v.fromArray(deps.shellPos(pr))));
          target.divideScalar(mine.length);
        }
        break;
      }
      case 'volley': {
        // A shared-screen volley: stand back far enough to see every shell (or, in the beat
        // before, every tank about to fire).
        const box = this._box.makeEmpty();
        if (game.phase === 'volley') game.players.forEach((p) => { if (p.alive && deps.seen(p)) box.expandByPoint(_v.set(p.x, p.y, p.z)); });
        else game.projectiles.forEach((pr) => { if (!deps.shellHidden(pr)) box.expandByPoint(_v.set(pr.pos[0], pr.pos[1], pr.pos[2])); });
        if (box.isEmpty()) box.expandByPoint(this.controls.target);
        box.getCenter(target);
        this.goal = null;
        return Math.min(1300, Math.max(130, (box.getSize(_v).length() * 0.62) / Math.tan((this.camera.fov * DEG) / 2)));
      }
      case 'follow': {
        let n = 0;
        const c = this._shellC.set(0, 0, 0);
        for (const pr of game.projectiles) {
          if (deps.shellHidden(pr)) continue;
          c.add(_v.fromArray(deps.shellPos(pr)));
          n++;
        }
        target.copy(c.divideScalar(n));
        break;
      }
      case 'peek':
      case 'plan': {
        const peek = this.modes.peek;
        const look = mode === 'peek' ? (peek.id != null ? game.players[peek.id] : peek) : null;
        const fogFor = deps.fogFor();
        const p = look || (deps.seen(game.current) ? game.current : fogFor?.[0] || game.current);
        target.set(p.x, p.y + 4, p.z);
        // Left far out (e.g. by the volley framing) with nobody steering: come back in.
        if (!look && !this.goal && !this.userCam && this.camera.position.distanceTo(this.controls.target) > 300) this.aimAt(p);
        break;
      }
      default:   // hold
    }
    return 0;
  }

  update(dt) {
    const { camera, controls, deps, _sCur, _sGoal, _off } = this;
    const game = deps.game();
    const gunner = deps.gunner;
    camera.position.sub(this.lastShake);
    const planner = game ? deps.planner() : null;
    const mode = this.mode = this.resolve(game, planner);
    if (mode === 'sight') {
      if (!gunner.active) { controls.enabled = false; this.goal = null; }
      gunner.pose(camera, planner, game.terrain, dt);
      this.lastShake.set(0, 0, 0);
      return;
    }
    if (gunner.active) this.leaveSight();
    let frame = 0;                // a volley asks for this much distance
    if (mode === 'menu') {
      // Idle orbit behind the menu.
      const t = performance.now() * 0.00005;
      this.target.set(0, 0, 0);
      this.goal = this._menuGoal.set(Math.cos(t) * 600, 300, Math.sin(t) * 600);
    } else if (!this.modes.pinned) frame = this.place(mode, game, dt);   // pinned (debug): hold still
    this._before.copy(controls.target);
    controls.target.lerp(this.target, 1 - Math.exp(-dt * 3.2));
    camera.position.add(this._delta.copy(controls.target).sub(this._before));
    if (frame) {
      // Back off (or close in) to the framing distance, looking down enough to see over the hills.
      const k = 1 - Math.exp(-dt * 2.2);
      _sCur.setFromVector3(_off.subVectors(camera.position, controls.target));
      _sCur.radius += (frame - _sCur.radius) * k;
      _sCur.phi += (Math.min(_sCur.phi, 1.0) - _sCur.phi) * k;
      camera.position.copy(controls.target).add(_off.setFromSpherical(_sCur));
    }
    if (this.goal) {
      const k = 1 - Math.exp(-dt * 2.6);
      _sCur.setFromVector3(_off.subVectors(camera.position, controls.target));
      _sGoal.setFromVector3(this.goal);
      let dTheta = _sGoal.theta - _sCur.theta;
      dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
      _sCur.theta += dTheta * k;
      _sCur.phi += (_sGoal.phi - _sCur.phi) * k;
      _sCur.radius += (_sGoal.radius - _sCur.radius) * k;
      camera.position.copy(controls.target).add(_off.setFromSpherical(_sCur));
      if (Math.abs(dTheta) < 0.01 && Math.abs(_sGoal.phi - _sCur.phi) < 0.01 && Math.abs(_sGoal.radius - _sCur.radius) < 1) this.goal = null;
    }
    controls.update();
    // Never let the camera sink into the hills (under an isle it stays below it).
    camera.position.y = clampCameraY(deps.field(), camera.position.x, camera.position.y, camera.position.z, 4, deps.floorY() + 4);
    this.shakeAmt *= Math.exp(-dt * 5);
    const s = this.shakeAmt;
    this.lastShake.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    camera.position.add(this.lastShake);
  }
}
