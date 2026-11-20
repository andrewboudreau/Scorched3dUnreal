import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { Game, PLAYER_COLORS } from './core/game.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS } from './core/weapons.js';
import { TANK, muzzleOrigin } from './core/tank.js';
import { ROLL, makeProjectile, stepProjectile, launchVelocity } from './core/ballistics.js';
import { PERK_BY_ID, perkSum } from './core/perks.js';
import { rollPart } from './core/weapons.js';
import { TerrainMesh } from './render/terrainMesh.js';
import { SceneryMesh } from './render/sceneryMesh.js';
import { TankMesh, makeWreck } from './render/tankMesh.js';
import { Effects, ShellVisual } from './render/effects.js';
import { Sky } from './render/sky.js';
import { Birds } from './render/birds.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new Sky(scene);   // sun, sky light, fog, clouds

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 6000);
camera.position.set(0, 420, 520);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 12;
controls.maxDistance = 1400;
controls.target.set(0, 20, 0);

// A desert floor far below the slab so it never floats in a void.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: '#8f7a5c', roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -140;
scene.add(floor);

const birds = new Birds(scene);
const effects = new Effects(scene);
const sound = new Sound();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- match state

let game = null;
let terrainMesh = null;
let sceneryMesh = null;
let tanks = [];
let smoke = [];                 // per tank: seconds until its next puff
let labels = [];
let wrecks = [];
const shells = new Map();       // projectile id -> ShellVisual
const ghosts = new Map();       // player id -> [Line] trails of their last shot
let followShell = true;
let overview = false;
let pinned = false;
let shake = 0;
const lastShake = new THREE.Vector3();
// Desired camera offset from the orbit target, eased in spherical coordinates
// so a turn change swings around instead of cutting overhead.
let camGoal = null;
const _sCur = new THREE.Spherical();
const _sGoal = new THREE.Spherical();
const _off = new THREE.Vector3();
const camTarget = new THREE.Vector3(0, 20, 0);
let shopQueue = [];
let day = 0;                    // 0 late morning .. 1 late afternoon, eased toward the match's progress
let dayLock = null;             // debug: hold the sun still at this time of day
let bannerHold = 0;             // a round banner keeps the turn banner waiting until then
let driveNote = { text: '', until: 0 };
const _v = new THREE.Vector3();
const camDist = (pos) => camera.position.distanceTo(_v.set(pos[0], pos[1], pos[2]));

// A short line showing where the shot starts out, for tanks with Tracer Rounds.
const tracer = new THREE.Line(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 3), 3)),
  new THREE.LineBasicMaterial({ color: '#fff6c9', transparent: true, opacity: 0.8 }),
);
tracer.frustumCulled = false;
tracer.visible = false;
scene.add(tracer);

function disposeMatch() {
  if (terrainMesh) { scene.remove(terrainMesh.group); terrainMesh.geometry.dispose(); terrainMesh.skirtGeometry.dispose(); }
  if (sceneryMesh) { scene.remove(sceneryMesh.group); sceneryMesh.dispose(); sceneryMesh = null; }
  tanks.forEach((t) => { scene.remove(t.root); t.dispose(); });
  wrecks.forEach((w) => scene.remove(w));
  shells.forEach((s) => { scene.remove(s.mesh, s.line); });
  ghosts.forEach((arr) => arr.forEach((l) => scene.remove(l)));
  shells.clear();
  ghosts.clear();
  effects.clear();
  tanks = []; wrecks = []; labels = [];
  $('labels').innerHTML = '';
}

function startMatch(config) {
  disposeMatch();
  scene.remove(menuMesh.group, menuScenery.group);
  game = new Game(config);
  terrainMesh = new TerrainMesh(game.terrain);
  sceneryMesh = new SceneryMesh(game.scenery);
  scene.add(terrainMesh.group, sceneryMesh.group);
  effects.groundAt = (x, z) => game.terrain.heightAt(x, z);
  tanks = game.players.map((p) => {
    const m = new TankMesh(p.color);
    scene.add(m.root);
    return m;
  });
  smoke = game.players.map(() => 0);
  sky.fit(game.terrain.half);
  labels = game.players.map((p) => {
    const el = document.createElement('div');
    el.className = 'tank-label';
    el.innerHTML = `<div style="color:${p.color}">${escapeHtml(p.name)}</div><div class="bar"><div class="fill hp"></div></div>`;
    $('labels').appendChild(el);
    return el;
  });
  buildScoreboard();
  game.start();
  showHud(true);
}

// ---------------------------------------------------------------- events

function banner(text, sub = '', ms = 1600) {
  const b = $('banner');
  b.innerHTML = `${escapeHtml(text)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`;
  b.classList.add('show');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => b.classList.remove('show'), ms);
}

function addShake(pos, power) {
  const d = camera.position.distanceTo(new THREE.Vector3(...pos));
  shake = Math.max(shake, power * Math.max(0, 1 - d / 900));
}

function handleEvents() {
  for (const e of game.drainEvents()) {
    switch (e.type) {
      case 'roundStart':
        wrecks.forEach((w) => scene.remove(w));
        wrecks = [];
        ghosts.forEach((arr) => arr.forEach((l) => scene.remove(l)));
        ghosts.clear();
        effects.clear();
        day = (e.round - 1) / game.cfg.rounds;
        birds.reset(game.terrain, e.round * 7 + game.players.length);
        if (game.modifier.id === 'clear') banner(`Round ${e.round}`, `of ${game.cfg.rounds}`, 1800);
        else {
          banner(`Round ${e.round}: ${game.modifier.name}`, game.modifier.desc, 3000);
          bannerHold = performance.now() + 2800;
        }
        break;
      case 'terrain':
        if (e.full) { terrainMesh.rebuild(); sceneryMesh.rebuild(); } else terrainMesh.updateRegion(e.region);
        break;
      case 'turn': {
        const p = game.players[e.player];
        if (!overview) aimCameraAt(p);
        setTimeout(() => { if (game && game.turn === p.id && game.phase === 'aim') banner(whose(p, 'turn'), p.ai ? `CPU · ${p.ai}` : 'Aim and fire', 1100); },
          Math.max(50, bannerHold - performance.now()));
        break;
      }
      case 'fire': {
        sound.fire(camDist(e.pos));
        birds.scare(e.pos, 70);
        effects.muzzleFlash(e.pos);
        tanks[e.player].kick();
        (ghosts.get(e.player) || []).forEach((l) => scene.remove(l));
        ghosts.set(e.player, []);
        addShake(e.pos, 0.6);
        break;
      }
      case 'projectile': {
        const pr = game.projectiles.find((p) => p.id === e.id);
        const owner = pr ? game.players[pr.owner] : null;
        const v = new ShellVisual(scene, owner ? owner.color : '#ffffff', rollPart(WEAPON_BY_ID[e.weapon]) ? ROLL.radius : undefined);
        v.owner = owner ? owner.id : null;
        if (pr) v.push(pr.pos);
        shells.set(e.id, v);
        break;
      }
      case 'split':
        effects.muzzleFlash(e.pos);
        sound.click();
        retireShell(e.id);
        break;
      case 'impact':
      case 'lost':
        retireShell(e.id, e.type === 'impact' ? e.pos : null);
        if (e.type === 'lost' && game.phase !== 'aim') banner('Out of the arena', '', 900);
        break;
      case 'explosion':
        effects.explosion(e.pos, e.radius);
        sound.explode(e.radius, camDist(e.pos));
        birds.scare(e.pos, 90 + e.radius * 5);
        addShake(e.pos, e.radius / 6);
        break;
      case 'mound':
        effects.dust(e.pos, e.radius);
        sound.thud(camDist(e.pos));
        break;
      case 'rollStart':
        // The shell is on the ground now; its visual keeps following it.
        effects.dust(e.pos, 4);
        sound.thud(camDist(e.pos));
        break;
      case 'prop':
        if (e.kind === 'house') { effects.dust(e.pos, 7); sound.thud(camDist(e.pos)); }
        else if (e.kind === 'bridge') { effects.dust([e.a[0], e.pos[1], e.a[1]], 5); effects.dust(e.pos, 7); effects.dust([e.b[0], e.pos[1], e.b[1]], 5); sound.thud(camDist(e.pos)); }
        break;
      case 'damage':
        popDamage(e.player, e.amount);
        break;
      case 'landed': {
        const q = game.players[e.player];
        effects.dust([q.x, q.y, q.z], 4);
        sound.thud(camDist([q.x, q.y, q.z]));
        break;
      }
      case 'destroyed': {
        const p = game.players[e.player];
        const by = e.by != null ? game.players[e.by] : null;
        effects.explosion([p.x, p.y + 2, p.z], 16);
        sound.explode(18, camDist([p.x, p.y, p.z]));
        const w = makeWreck(p.color);
        w.position.set(p.x, game.terrain.heightAt(p.x, p.z), p.z);
        w.rotation.y = Math.random() * Math.PI * 2;
        scene.add(w);
        wrecks.push(w);
        banner(`${p.name} destroyed`, by && by !== p ? `by ${by.name}` : by === p ? 'self-inflicted' : '', 1800);
        break;
      }
      case 'roundOver':
      case 'matchOver':
        setTimeout(() => showRoundResult(e.type), 2200);
        break;
      default:
        break;
    }
  }
}

function retireShell(id, at) {
  const v = shells.get(id);
  if (!v) return;
  if (at) v.push(at);
  const line = v.finish();
  if (v.owner != null) {
    const arr = ghosts.get(v.owner) || [];
    arr.push(line);
    ghosts.set(v.owner, arr);
  } else scene.remove(line);
  shells.delete(id);
}

function popDamage(pid, amount) {
  const p = game.players[pid];
  const v = new THREE.Vector3(p.x, p.y + 6, p.z).project(camera);
  if (v.z > 1) return;
  const el = document.createElement('div');
  el.className = 'dmg-pop';
  el.textContent = `-${Math.round(amount)}`;
  el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
  el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
  $('labels').appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// ---------------------------------------------------------------- camera

function aimCameraAt(p) {
  if (pinned) return;
  camTarget.set(p.x, p.y + 4, p.z);
  const back = new THREE.Vector3(-Math.cos(p.yaw * DEG), 0, -Math.sin(p.yaw * DEG));
  camGoal = back.multiplyScalar(70).add(new THREE.Vector3(0, 28, 0));
}

function updateCamera(dt) {
  camera.position.sub(lastShake);
  if (game) {
    if (pinned) {
      // Debug camera: hold still.
    } else if (overview) {
      camTarget.set(0, 10, 0);
    } else if (game.phase === 'flight' && followShell && game.projectiles.length) {
      const c = new THREE.Vector3();
      game.projectiles.forEach((pr) => c.add(new THREE.Vector3(...pr.pos)));
      c.divideScalar(game.projectiles.length);
      camTarget.copy(c);
    } else if (game.phase === 'aim' && game.current) {
      const p = game.current;
      camTarget.set(p.x, p.y + 4, p.z);
    }
  }
  const before = controls.target.clone();
  controls.target.lerp(camTarget, 1 - Math.exp(-dt * 3.2));
  camera.position.add(controls.target.clone().sub(before));
  if (camGoal) {
    const k = 1 - Math.exp(-dt * 2.6);
    _sCur.setFromVector3(_off.subVectors(camera.position, controls.target));
    _sGoal.setFromVector3(camGoal);
    let dTheta = _sGoal.theta - _sCur.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    _sCur.theta += dTheta * k;
    _sCur.phi += (_sGoal.phi - _sCur.phi) * k;
    _sCur.radius += (_sGoal.radius - _sCur.radius) * k;
    camera.position.copy(controls.target).add(_off.setFromSpherical(_sCur));
    if (Math.abs(dTheta) < 0.01 && Math.abs(_sGoal.phi - _sCur.phi) < 0.01 && Math.abs(_sGoal.radius - _sCur.radius) < 1) camGoal = null;
  }
  controls.update();
  // Never let the camera sink into the hills.
  const field = game ? game.terrain : menuField.terrain;
  const ground = field.inBounds(camera.position.x, camera.position.z) ? field.heightAt(camera.position.x, camera.position.z) : floor.position.y;
  if (camera.position.y < ground + 4) camera.position.y = ground + 4;
  shake *= Math.exp(-dt * 5);
  lastShake.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  camera.position.add(lastShake);
}

// Only a real drag or a wheel zoom takes the camera over; a plain click (e.g. to
// focus the page) must not strand it halfway through a fly-in.
let dragFrom = null;
renderer.domElement.addEventListener('pointerdown', (e) => { dragFrom = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (dragFrom && Math.hypot(e.clientX - dragFrom[0], e.clientY - dragFrom[1]) > 4) { camGoal = null; dragFrom = null; }
});
window.addEventListener('pointerup', () => { dragFrom = null; });
renderer.domElement.addEventListener('wheel', () => { camGoal = null; }, { passive: true });

// ---------------------------------------------------------------- input

const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === 'tab' || k.startsWith('arrow')) e.preventDefault();
  held.add(k);
  if (e.repeat || !game) return;
  if (k === ' ') { e.preventDefault(); if (game.current && !game.current.ai && game.fire()) { /* fired */ } }
  else if (k === 'tab') { game.cycleWeapon(e.shiftKey ? -1 : 1); sound.click(); }
  else if (k >= '1' && k <= '9') selectWeaponSlot(Number(k) - 1);
  else if (k === 'c') { followShell = !followShell; banner(followShell ? 'Follow cam on' : 'Follow cam off', '', 700); }
  else if (k === 'v') {
    overview = !overview;
    if (overview) camGoal = new THREE.Vector3(0, 610, 520);
    else if (game.current) aimCameraAt(game.current);
  } else if (k === 'm') banner(sound.toggleMute() ? 'Muted' : 'Sound on', '', 700);
  else if (k === '-' || k === '=' || k === '+') setVolume(sound.volume + (k === '-' ? -0.1 : 0.1), true);
});

function setVolume(v, announce = false) {
  sound.setVolume(Math.round(v * 10) / 10);
  $('opt-volume').value = Math.round(sound.volume * 100);
  if (announce) banner(`Volume ${Math.round(sound.volume * 100)}%`, '', 700);
}
$('opt-volume').value = Math.round(sound.volume * 100);
$('opt-volume').addEventListener('input', () => { sound.ensure(); setVolume(Number($('opt-volume').value) / 100); });
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());
window.addEventListener('pointerdown', () => sound.ensure(), { once: true });

const ownedWeapons = (p) => WEAPONS.filter((w) => !w.hidden && p.inventory[w.id] > 0);
const ammoText = (n) => (n === Infinity ? '∞' : `×${n}`);

function selectWeaponSlot(i) {
  const p = game.current;
  if (!p || p.ai || game.phase !== 'aim') return;
  const list = ownedWeapons(p);
  if (list[i]) { p.weapon = list[i].id; sound.click(); }
}

// The row of weapons the current tank carries. Rebuilt only when it changes.
let weaponBarKey = '';
function updateWeaponBar(p) {
  const list = ownedWeapons(p);
  const key = `${p.id}|${p.weapon}|${p.ai ? 1 : 0}|${list.map((w) => `${w.id}${p.inventory[w.id]}`).join(',')}`;
  if (key === weaponBarKey) return;
  weaponBarKey = key;
  $('weapon-bar').innerHTML = list.map((w, i) => `
    <button class="wb-item${w.id === p.weapon ? ' on' : ''}" data-i="${i}" title="${escapeHtml(w.desc)}" ${p.ai ? 'disabled' : ''}>
      <span class="wb-key">${i + 1}</span>${w.name}<span class="wb-n">${ammoText(p.inventory[w.id])}</span>
    </button>`).join('');
}
$('weapon-bar').addEventListener('click', (e) => {
  const b = e.target.closest('.wb-item');
  if (b && game) selectWeaponSlot(Number(b.dataset.i));
});

function applyHeldKeys(dt) {
  if (!game || game.phase !== 'aim' || !game.current || game.current.ai) return;
  const fine = held.has('shift') ? 0.2 : 1;
  const ax = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
  const ay = (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0);
  const ap = (held.has('e') || held.has('pageup') ? 1 : 0) - (held.has('q') || held.has('pagedown') ? 1 : 0);
  if (ax || ay || ap) game.adjustAim(ax * TANK.turretSpeed * dt * fine, ay * TANK.elevationSpeed * dt * fine, ap * TANK.powerSpeed * dt * fine);
  // The arrow keys drive: up and down along the hull, left and right swing it.
  const go = (held.has('arrowup') ? 1 : 0) - (held.has('arrowdown') ? 1 : 0);
  const turn = (held.has('arrowright') ? 1 : 0) - (held.has('arrowleft') ? 1 : 0);
  if (go || turn) {
    // Driving with the camera far away (or zoomed right out) brings it back to the tank.
    if (!camGoal && !overview && !pinned && camera.position.distanceTo(controls.target) > 260) aimCameraAt(game.current);
    const why = DRIVE_NOTES[game.drive(go, turn, dt)];
    if (why) driveNote = { text: why, until: performance.now() + 1200 };
  }
}

const DRIVE_NOTES = {
  empty: 'Out of fuel', steep: 'Too steep to climb', water: 'Water ahead', edge: 'Edge of the arena', blocked: 'Something is in the way',
};

function updateTracer() {
  const p = game.current;
  const reach = p && !p.ai && game.phase === 'aim' ? perkSum(p, 'tracer') : 0;
  tracer.visible = reach > 0;
  if (!reach) return;
  const pr = makeProjectile(muzzleOrigin(p), launchVelocity(p.yaw, p.elev, p.power));
  pr.g = game.gravity;
  pr.windK = game.windShare(p);
  const a = tracer.geometry.attributes.position;
  let n = 0;
  let gone = 0;
  let last = [...pr.pos];
  a.setXYZ(n++, ...pr.pos);
  for (let step = 1; gone < reach && n < a.count; step++) {
    stepProjectile(pr, game.wind);
    if (step % 3) continue;
    gone += Math.hypot(pr.pos[0] - last[0], pr.pos[1] - last[1], pr.pos[2] - last[2]);
    last = [...pr.pos];
    if (game.terrain.inBounds(pr.pos[0], pr.pos[2]) && pr.pos[1] < game.terrain.heightAt(pr.pos[0], pr.pos[2])) break;
    a.setXYZ(n++, ...pr.pos);
  }
  a.needsUpdate = true;
  tracer.geometry.setDrawRange(0, n);
}

// Exhaust while the engine works, a lazy puff from the tank whose turn it is,
// dust off the tracks, and dark smoke from a tank that is nearly done for.
function tankSmoke(dt) {
  const drift = [game.wind[0] * 1.5, game.wind[1] * 1.5];
  game.players.forEach((p, i) => {
    if (!p.alive) return;
    const t = tanks[i];
    if ((smoke[i] -= dt) > 0) return;
    const hurt = 1 - p.hp / p.maxHp;
    if (t.work > 0.1) {
      smoke[i] = 0.09;
      effects.puff(t.exhaust(_v, Math.random() < 0.5 ? 1 : -1), { size: 0.8 + t.work * 0.5, life: 1.1, drift });
      if (Math.random() < 0.5) effects.puff({ x: p.x, y: p.y + 0.4, z: p.z }, { color: '#a08463', size: 2.2, life: 1.2, rise: 0.8, opacity: 0.3, drift });
    } else if (hurt > 0.6) {
      smoke[i] = 0.3 - hurt * 0.15;
      effects.puff({ x: p.x + (Math.random() - 0.5), y: p.y + 2.6, z: p.z + (Math.random() - 0.5) }, { color: '#2b2826', size: 1.5 + hurt, life: 2.4, rise: 3.2, opacity: 0.55, drift });
    } else if (p === game.current && game.phase === 'aim') {
      smoke[i] = 0.7;
      effects.puff(t.exhaust(_v, Math.random() < 0.5 ? 1 : -1), { size: 0.6, life: 1.0, opacity: 0.3, drift });
    } else smoke[i] = 0.3;
  });
}

// What the ambient sound should follow this frame.
function soundScape(dt) {
  const scenery = game ? game.scenery : menuField.scenery;
  let sheep = Infinity;
  for (const w of scenery.walkers) if (w.alive && w.kind === 'sheep') sheep = Math.min(sheep, camDist([w.x, w.y, w.z]));
  let driving = 0;
  let shell = null;
  if (game) {
    game.players.forEach((p, i) => { if (p.alive) driving = Math.max(driving, tanks[i].work / (1 + camDist([p.x, p.y, p.z]) / 160)); });
    for (const pr of game.projectiles) {
      if (pr.dead || pr.roller) continue;
      const dist = camDist(pr.pos);
      if (!shell || dist < shell.dist) shell = { dist, falling: Math.max(0, Math.min(1, -pr.vel[1] / 45)) };
    }
  }
  sound.update(dt, { wind: game ? Math.hypot(...game.wind) : 0.6, driving, shell, birds: birds.nearest(camera.position), sheep });
}

// ---------------------------------------------------------------- HUD

function showHud(on) { $('hud').classList.toggle('hidden', !on); }

function buildScoreboard() {
  $('scoreboard').innerHTML = game.players.map((p) => `
    <div class="sb-row" id="sb-${p.id}">
      <span class="swatch" style="background:${p.color}"></span>
      <span style="width:74px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name)}</span>
      <div class="bar"><div class="fill hp"></div></div>
      <span class="wins"></span>
      <div class="sb-perks"></div>
    </div>`).join('');
}

const perkChip = (id, long) => `<span class="perk" title="${escapeHtml(PERK_BY_ID[id].desc)}">${long ? PERK_BY_ID[id].name : PERK_BY_ID[id].tag}</span>`;
function setPerks(el, p, long) {
  const key = p.id + p.perks.join();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = p.perks.map((id) => perkChip(id, long)).join('');
}

function updateHud() {
  const p = game.current || game.players[game.lastShooter ?? 0];
  if (game.current) game.lastShooter = game.current.id;
  if (p) {
    $('pc-swatch').style.background = p.color;
    $('pc-name').textContent = p.name;
    $('pc-tag').textContent = p.ai ? `CPU ${p.ai}` : 'Human';
    $('pc-hp').style.width = `${(p.hp / p.maxHp) * 100}%`;
    $('pc-armor').style.width = `${Math.min(100, p.armor * 3.3)}%`;
    $('pc-money').textContent = p.money;
    $('pc-fuel').style.width = `${p.fuelMax ? (p.fuel / p.fuelMax) * 100 : 0}%`;
    $('ro-fuel').textContent = `${Math.floor(p.fuel + 0.05)} m`;
    const noting = performance.now() < driveNote.until && game.phase === 'aim' && !p.ai;
    $('pc-note').textContent = noting ? driveNote.text : '';
    setPerks($('pc-perks'), p, true);
    $('ro-yaw').textContent = `${p.yaw.toFixed(1)}°`;
    $('ro-elev').textContent = `${p.elev.toFixed(1)}°`;
    $('ro-power').textContent = p.power.toFixed(1);
    $('pc-power').style.width = `${((p.power - TANK.minPower) / (TANK.maxPower - TANK.minPower)) * 100}%`;
    const w = WEAPON_BY_ID[p.weapon];
    $('ro-weapon').textContent = w.name;
    $('ro-ammo').textContent = ammoText(p.inventory[w.id]);
    updateWeaponBar(p);
  }
  // Wind, drawn relative to where the camera is looking.
  const [wx, wz] = game.wind;
  const mag = Math.hypot(wx, wz);
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position);
  const rel = Math.atan2(wz, wx) - Math.atan2(fwd.z, fwd.x);
  $('wind-arrow').style.transform = `rotate(${rel / DEG - 90}deg)`;
  $('wind-arrow').style.opacity = mag < 0.05 ? 0.2 : 1;
  $('wind-speed').textContent = mag < 0.05 ? 'calm' : (mag * 10).toFixed(0);
  for (const q of game.players) {
    const row = $(`sb-${q.id}`);
    if (!row) continue;
    row.classList.toggle('dead', !q.alive);
    row.classList.toggle('active', game.current === q);
    row.querySelector('.fill').style.width = `${(q.hp / q.maxHp) * 100}%`;
    row.querySelector('.wins').textContent = '★'.repeat(Math.min(q.wins, 3)) + (q.wins > 3 ? q.wins : '');
    setPerks(row.querySelector('.sb-perks'), q, false);
  }
  const mod = game.modifier;
  $('round-label').textContent = `Round ${game.round} / ${game.cfg.rounds}${mod.id === 'clear' ? '' : ` · ${mod.name}: ${mod.desc}`}`;
}

function updateLabels() {
  game.players.forEach((p, i) => {
    const el = labels[i];
    const v = new THREE.Vector3(p.x, p.y + 8, p.z).project(camera);
    const visible = p.alive && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    el.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    el.querySelector('.fill').style.width = `${(p.hp / p.maxHp) * 100}%`;
  });
}

// ---------------------------------------------------------------- screens

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const setupRows = [
  { name: 'You', type: 'human' },
  { name: 'Rook', type: 'normal' },
];
const CPU_NAMES = ['Rook', 'Vex', 'Marlow', 'Kestrel', 'Bastion', 'Ivo'];

function renderSetup() {
  $('setup-players').innerHTML = setupRows.map((r, i) => `
    <div class="player-row">
      <span class="swatch" style="background:${PLAYER_COLORS[i]};width:18px;height:18px"></span>
      <input data-i="${i}" class="pname" value="${escapeHtml(r.name)}" maxlength="14" />
      <select data-i="${i}" class="ptype">
        ${[['human', 'Human'], ['easy', 'CPU · Easy'], ['normal', 'CPU · Normal'], ['hard', 'CPU · Hard']]
          .map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>`).join('');
  document.querySelectorAll('.pname').forEach((el) => el.addEventListener('input', () => { setupRows[el.dataset.i].name = el.value; }));
  document.querySelectorAll('.ptype').forEach((el) => el.addEventListener('change', () => { setupRows[el.dataset.i].type = el.value; }));
  $('add-player').disabled = setupRows.length >= 6;
  $('remove-player').disabled = setupRows.length <= 2;
}

$('add-player').onclick = () => {
  if (setupRows.length >= 6) return;
  setupRows.push({ name: CPU_NAMES[setupRows.length % CPU_NAMES.length], type: 'normal' });
  renderSetup();
};
$('remove-player').onclick = () => { if (setupRows.length > 2) { setupRows.pop(); renderSetup(); } };

$('start').onclick = () => {
  sound.ensure();
  $('setup').classList.add('hidden');
  startMatch({
    players: setupRows.map((r, i) => ({ name: r.name.trim() || `Tank ${i + 1}`, ai: r.type === 'human' ? null : r.type })),
    rounds: Number($('opt-rounds').value),
    maxWind: Number($('opt-wind').value),
    hills: Number($('opt-hills').value),
    twists: $('opt-twists').value === '1',
  });
};

function standingsTable(sorted) {
  return `<tr><th></th><th>Tank</th><th>Wins</th><th>Funds</th></tr>` + sorted.map((p) => `
    <tr><td><span class="swatch" style="background:${p.color}"></span></td><td>${escapeHtml(p.name)}${p.alive ? '' : ' <span style="color:#9aa6b2">(destroyed)</span>'}</td>
    <td>${p.wins}</td><td>$${p.money}</td></tr>`).join('');
}

function showRoundResult(kind) {
  if (!game) return;
  const w = game.lastRoundResult.winner != null ? game.players[game.lastRoundResult.winner] : null;
  if (kind === 'matchOver') {
    const sorted = [...game.players].sort((a, b) => b.wins - a.wins || b.money - a.money);
    $('mo-title').textContent = `Match winner: ${sorted[0].name}`;
    $('mo-table').innerHTML = standingsTable(sorted);
    $('matchover').classList.remove('hidden');
    return;
  }
  $('ro-title').textContent = w ? `Round ${game.round}: ${w.name} wins` : `Round ${game.round} is a draw`;
  $('ro-continue').textContent = !game.humans.length ? `Start round ${game.round + 1}` : game.cfg.twists ? 'Continue to the perk draft' : 'Continue to the armory';
  $('ro-table').innerHTML = standingsTable([...game.players].sort((a, b) => b.wins - a.wins));
  $('roundover').classList.remove('hidden');
}

$('ro-continue').onclick = () => {
  $('roundover').classList.add('hidden');
  shopQueue = game.players.filter((p) => !p.ai).map((p) => p.id);
  game.openShop();
  if (game.phase === 'shop') nextShopper();
};

const whose = (p, thing) => (/^you$/i.test(p.name.trim()) ? `Your ${thing}` : `${p.name}'s ${thing}`);
const hotseatStep = (p, doing) => {
  const humans = game.humans;
  return humans.length > 1 ? `Player ${humans.indexOf(p) + 1} of ${humans.length} · ${doing}` : doing;
};

// Each human in turn: pick a perk (if one is on offer), then shop.
function nextShopper() {
  const pid = shopQueue.shift();
  $('draft').classList.add('hidden');
  $('shop').classList.add('hidden');
  if (pid == null) { game.closeShop(); return; }
  if (game.draft[pid]) openDraftFor(pid); else openShopFor(pid);
}

// The perk draft: three cards, keep one for the rest of the match.
function openDraftFor(pid) {
  const p = game.players[pid];
  $('draft').classList.remove('hidden');
  $('draft-card').style.borderTopColor = p.color;
  $('draft-swatch').style.background = p.color;
  $('draft-player').textContent = whose(p, 'perk draft');
  $('draft-step').textContent = hotseatStep(p, 'pick one, it lasts the whole match');
  $('draft-owned').innerHTML = p.perks.length ? `Already yours: ${p.perks.map((id) => perkChip(id, true)).join(' ')}` : 'Your first perk. They stack, round after round.';
  $('draft-items').innerHTML = game.draft[pid].map((id) => {
    const k = PERK_BY_ID[id];
    return `<div class="shop-item draft-item">
      <div class="si-head"><b>${k.name}</b><span class="perk">${k.tag}</span></div>
      <div class="desc">${k.desc}</div>
      <button class="buy" data-id="${id}">Take ${k.name}</button>
    </div>`;
  }).join('');
  $('draft-items').onclick = (e) => {
    const b = e.target.closest('button.buy');
    if (!b || !game.pickPerk(pid, b.dataset.id)) return;
    sound.click();
    $('draft').classList.add('hidden');
    openShopFor(pid);
  };
}

// The armory, one human at a time. Each item is a card that says what it is,
// what one purchase gives, what the shopper already holds, and has one button.
const SHOP_ITEMS = [...WEAPONS.filter((w) => !w.hidden && !w.infinite), ...ITEMS];
const SHOP_HINT = 'Shells are free and never run out. Everything here is extra.';
// The armory items that are not weapons: what the shopper has queued, and what one purchase adds.
const ITEM_INFO = {
  armor: { have: (p) => p.pendingArmor, owned: (n) => `+${n} fitted`, none: 'None fitted', gives: '+30 armor' },
  fuel: { have: (p) => p.pendingFuel, owned: (n) => `+${n} m loaded`, none: 'None loaded', gives: `+${TANK.fuelCan} m of driving` },
};

function openShopFor(pid) {
  const p = game.players[pid];
  const next = shopQueue.length ? game.players[shopQueue[0]] : null;
  $('shop').classList.remove('hidden');
  $('shop-card').style.borderTopColor = p.color;
  $('shop-swatch').style.background = p.color;
  $('shop-player').textContent = whose(p, 'armory');
  $('shop-step').textContent = hotseatStep(p, `shopping for round ${game.round + 1}`);
  $('shop-done').textContent = next ? `Done · pass to ${next.name}` : `Done · start round ${game.round + 1}`;
  const note = (text, good = false) => {
    $('shop-note').textContent = text;
    $('shop-note').classList.toggle('good', good);
  };
  const render = (justBought) => {
    $('shop-money').textContent = `$${p.money}`;
    $('shop-items').innerHTML = SHOP_ITEMS.map((it) => {
      const isW = !!WEAPON_BY_ID[it.id];
      const info = ITEM_INFO[it.id];
      const have = isW ? p.inventory[it.id] || 0 : info.have(p);
      const owned = isW ? `You have ${have}` : have ? info.owned(have) : info.none;
      const gives = isW ? `${it.bundle} per purchase` : info.gives;
      const price = game.priceOf(p, it.id);
      const short = price - p.money;
      return `<div class="shop-item${short > 0 ? ' cant' : ''}${it.id === justBought ? ' bought' : ''}">
        <div class="si-head"><b>${it.name}</b><span class="si-own${have ? ' has' : ''}">${owned}</span></div>
        <div class="desc">${it.desc}</div>
        <div class="si-foot">
          <span class="si-gives">${gives}${short > 0 ? `<span class="si-short">need $${short} more</span>` : ''}</span>
          <button class="buy" data-id="${it.id}" ${short > 0 ? 'disabled' : ''}>${short > 0 ? `$${price}` : `Buy for $${price}`}</button>
        </div>
      </div>`;
    }).join('');
  };
  $('shop-items').onclick = (e) => {
    const b = e.target.closest('button.buy');
    const it = SHOP_ITEMS.find((x) => x.id === b?.dataset.id);
    const price = it ? game.priceOf(p, it.id) : 0;
    if (!b || b.disabled || !game.buy(pid, it.id)) return;
    sound.click();
    render(it.id);
    note(`Bought ${it.bundle ? `${it.bundle} × ${it.name}` : it.name} for $${price}. $${p.money} left.`, true);
    const funds = $('shop-money');
    funds.classList.remove('pulse');
    void funds.offsetWidth;   // restart the animation
    funds.classList.add('pulse');
  };
  render();
  const haggle = perkSum(p, 'discount') ? ' Haggler prices applied.' : '';
  note(SHOP_ITEMS.some((it) => game.priceOf(p, it.id) <= p.money) ? SHOP_HINT + haggle : `Nothing in reach this time. ${SHOP_HINT}`);
  $('shop-done').onclick = nextShopper;
}

$('mo-again').onclick = () => {
  $('matchover').classList.add('hidden');
  showHud(false);
  disposeMatch();
  game = null;
  scene.add(menuMesh.group, menuScenery.group);
  tracer.visible = false;
  sky.fit(menuField.terrain.half);
  birds.reset(menuField.terrain, 5);
  $('setup').classList.remove('hidden');
  renderSetup();
};

// ---------------------------------------------------------------- loop

let lastFrame = performance.now();
let elapsed = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  tick(Math.min(0.1, (now - lastFrame) / 1000));
  lastFrame = now;
}

// One frame of everything, `dt` seconds long.
function tick(dt) {
  elapsed += dt;
  let dayGoal = 0.12;
  if (game) {
    applyHeldKeys(dt);
    game.update(dt);
    handleEvents();
    game.players.forEach((p, i) => tanks[i].sync(p, game.terrain, dt));
    tankSmoke(dt);
    for (const pr of game.projectiles) {
      shells.get(pr.id)?.push(pr.pos);
      if (!pr.roller) birds.scare(pr.pos, 28);
    }
    // Only the current player's last shot is shown as a ghost.
    ghosts.forEach((arr, pid) => arr.forEach((l) => { l.visible = game.current?.id === pid && game.phase === 'aim'; }));
    updateTracer();
    sceneryMesh.sync(elapsed);
    updateHud();
    updateLabels();
    // The sun moves a little every turn and a lot over the match.
    const within = Math.min(1, game.turnsThisRound / (game.players.length * 6));
    dayGoal = (game.round - 1 + within) / game.cfg.rounds;
  } else {
    // Idle orbit behind the menu.
    menuField.scenery.update(dt);
    menuScenery.sync(elapsed);
    const t = performance.now() * 0.00005;
    camTarget.set(0, 0, 0);
    camGoal = new THREE.Vector3(Math.cos(t) * 600, 300, Math.sin(t) * 600);
  }
  day = dayLock ?? day + Math.max(-dt * 0.5, Math.min(dt * 0.012, dayGoal - day));
  sky.setDay(day);
  sky.update(dt, game ? game.wind : [0.4, 0.2]);
  birds.update(dt);
  soundScape(dt);
  effects.update(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
}

// A backdrop field for the menu; dropped once a real match starts.
const menuField = new Game({ players: [{ name: 'a' }, { name: 'b' }], seed: 4242 });
menuField.terrain.generate({ seed: 4242, amplitude: 45 });
menuField.scenery.generate({ seed: 4242 });
const menuMesh = new TerrainMesh(menuField.terrain);
menuMesh.rebuild();
const menuScenery = new SceneryMesh(menuField.scenery);
menuScenery.rebuild();
scene.add(menuMesh.group, menuScenery.group);
sky.fit(menuField.terrain.half);
birds.reset(menuField.terrain, 5);

renderSetup();
$('loading').classList.add('hidden');
frame();

// Exposed for debugging from the console.
window.craterfall = { get game() { return game; }, startMatch, muzzleOrigin, camera, controls, renderer, scene, sky, birds, sound, effects, tick, held,
  get tanks() { return tanks; }, get camGoal() { return camGoal; },
  lookAt(x, y, z, from) { pinned = true; camTarget.set(x, y, z); controls.target.set(x, y, z); camera.position.set(...from); camGoal = null; },
  release() { pinned = false; },
  setDay(k) { dayLock = k; } };
