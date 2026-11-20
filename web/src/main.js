import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { Game, PLAYER_COLORS } from './core/game.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS, blastDamage } from './core/weapons.js';
import { TANK, muzzleOrigin, hitSphere } from './core/tank.js';
import { ROLL, makeProjectile, stepProjectile, launchVelocity, groundContact } from './core/ballistics.js';
import { PERK_BY_ID, perkSum } from './core/perks.js';
import { rollPart } from './core/weapons.js';
import { rangeAxes, toRange, solveAim } from './core/rangefinder.js';
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
renderer.shadowMap.autoUpdate = false;    // tick() asks for one update a frame
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
const fadingTrails = [];        // finished shells' trails, fading out
let handoffOpen = false;        // volley planning: waiting for the next human to sit down
// A volley with one human in it: the camera rides that human's shell and every
// other tank's landing gets a pip (see addPip). Null when several humans share
// the screen; then the camera stands back to frame every shell instead.
let heroId = null;
const pips = [];
const ranges = new Map();       // tank id -> its last rangefinder shot: { probes, elev, at, wind }
let locators = [];              // per tank: edge arrow pointing at it when off screen
let peek = null;                // { id, until }: a quick look at another tank while planning
let followShell = true;
let overview = false;
let pinned = false;
let shake = 0;
const lastShake = new THREE.Vector3();
// Desired camera offset from the orbit target, eased in spherical coordinates
// so a turn change swings around instead of cutting overhead.
let camGoal = null;
let userCam = false;              // the player has dragged or zoomed this turn; leave the camera alone
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

// A shell's trail lingers a moment after it lands, then fades away.
function fadeTrails(dt) {
  for (let i = fadingTrails.length - 1; i >= 0; i--) {
    const line = fadingTrails[i];
    line.material.opacity -= dt * 0.25;
    if (line.material.opacity <= 0) { dropTrail(line); fadingTrails.splice(i, 1); }
  }
}

function dropTrail(line) {
  scene.remove(line);
  line.geometry.dispose();
  line.material.dispose();
}

function clearTrails() {
  fadingTrails.forEach(dropTrail);
  fadingTrails.length = 0;
}

function disposeMatch() {
  if (terrainMesh) { scene.remove(terrainMesh.group); terrainMesh.dispose(); }
  if (sceneryMesh) { scene.remove(sceneryMesh.group); sceneryMesh.dispose(); sceneryMesh = null; }
  tanks.forEach((t) => { scene.remove(t.root); t.dispose(); });
  wrecks.forEach((w) => scene.remove(w));
  shells.forEach((s) => { scene.remove(s.mesh, s.line); });
  shells.clear();
  clearTrails();
  closeHandoff();
  effects.clear();
  tanks = []; wrecks = []; labels = [];
  pips.length = 0;
  heroId = null;
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
  locators = game.players.map((p) => {
    const el = document.createElement('div');
    el.className = 'locator';
    el.style.setProperty('--c', p.color);
    el.innerHTML = `<i></i><b>${escapeHtml(p.name)}</b><small></small>`;
    el.style.display = 'none';
    el.addEventListener('click', () => peekAt(p));
    $('labels').appendChild(el);
    return el;
  });
  peek = null;
  buildScoreboard();
  $('help-fire').textContent = game.volleyMode ? 'lock in your shot' : 'fire';
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
        clearTrails();
        pips.forEach(dropPip);
        pips.length = 0;
        ranges.clear();
        killCam = null;
        timeScale = 1;
        document.body.classList.remove('killcam');
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
        if (e.full) { terrainMesh.rebuild(); sceneryMesh.rebuild(); terrainMesh.setPaths(game.scenery.paths); }
        else { terrainMesh.updateRegion(e.region); terrainMesh.scuffPaths(e.region); }
        break;
      case 'turn': {
        const p = game.players[e.player];
        userCam = false;   // a new planner gets the camera back
        if (!overview) aimCameraAt(p);
        // In a volley a "turn" is one tank's go at planning (or a CPU driving).
        const [title, sub] = !e.plan ? [whose(p, 'turn'), p.ai ? `CPU · ${p.ai}` : 'Aim and fire']
          : p.ai ? [`${p.name} is on the move`, `CPU · ${p.ai}`] : [whose(p, 'shot'), 'Plan it, then Space to lock it in'];
        if (e.plan && !p.ai && game.humans.filter((h) => h.alive).length > 1) { openHandoff(p); break; }
        setTimeout(() => { if (game && game.turn === p.id && game.phase === 'aim') banner(title, sub, e.plan && !p.ai ? 1700 : 1100); },
          Math.max(50, bannerHold - performance.now()));
        break;
      }
      case 'locked':
        sound.click();
        banner('Locked in', '', 700);
        break;
      case 'volley': {
        closeHandoff();
        const alive = game.humans.filter((h) => h.alive && e.players.includes(h.id));
        heroId = alive.length === 1 ? alive[0].id : null;
        if (heroId != null && followShell && !overview) aimCameraAt(game.players[heroId]);
        banner('Fire!', `${e.players.length} tanks, all together`, 1300);
        break;
      }
      case 'aimReset':
        if (game.current?.id === e.player) driveNote = { text: 'Moved: last aim cleared', until: performance.now() + 1800 };
        break;
      case 'fire': {
        // Its next shot retires a tank's rangefinder marks.
        pips.forEach((q) => { if (q.sticky && q.owner === e.player) { q.sticky = false; q.until = performance.now() + 600; } });
        if (e.weapon === 'ranger') {
          const p = game.players[e.player];
          ranges.set(e.player, { probes: {}, elev: p.elev, at: [p.x, p.z], wind: [...game.wind] });
        } else ranges.delete(e.player);
        // A volley's shots leave together; their flash and crack are spread a touch.
        const go = () => {
          if (!game || !tanks[e.player]) return;
          effects.muzzleFlash(e.pos);
          tanks[e.player].kick();
          addShake(e.pos, 0.6);
        };
        sound.fire(camDist(e.pos), e.delay);
        birds.scare(e.pos, 70);
        if (e.delay) setTimeout(go, e.delay * 1000); else go();
        break;
      }
      case 'projectile': {
        const pr = game.projectiles.find((p) => p.id === e.id);
        const owner = pr ? game.players[pr.owner] : null;
        const v = new ShellVisual(scene, owner ? owner.color : '#ffffff', { ball: rollPart(WEAPON_BY_ID[e.weapon]) ? ROLL.radius : 0, probe: !!pr?.probe });
        v.owner = owner ? owner.id : null;
        v.probe = pr?.probe || null;
        v.shot = e.shot;
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
      case 'lost': {
        const v = shells.get(e.id);
        const owner = v?.owner;
        if (v?.probe) {
          if (e.type === 'impact') {
            addProbePip(owner, e.pos, v.probe);
            sound.ping(camDist(e.pos));
            const r = ranges.get(owner);
            if (r) r.probes[v.probe.key] = { ...v.probe, pos: [...e.pos] };
          }
        } else if (e.type === 'impact' && game.volleyMode && heroId != null && owner != null && owner !== heroId) addPip(owner, e.pos);
        retireShell(e.id, e.type === 'impact' ? e.pos : null);
        if (e.type === 'lost' && !v?.probe && game.phase !== 'aim' && (heroId == null || owner === heroId)) banner('Out of the arena', '', 900);
        break;
      }
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
      case 'damage': {
        popDamage(e.player, e.amount);
        if (insetFor === e.player) flashInset(e.amount);
        // Name the victim on the shooter's pip.
        const pip = e.by != null && e.by !== e.player && [...pips].reverse().find((q) => q.owner === e.by && performance.now() - q.born < 3000);
        if (pip) pip.el.querySelector('span').textContent = `${game.players[e.by].name} hit ${e.player === heroId ? 'you' : game.players[e.player].name}`;
        break;
      }
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
  fadingTrails.push(v.finish());
  shells.delete(id);
}

// ---------------------------------------------------------------- volley hand-off

// More than one human is planning: cover the field until the next one is ready.
function openHandoff(p) {
  handoffOpen = true;
  held.clear();
  $('handoff-card').style.borderTopColor = p.color;
  $('handoff-swatch').style.background = p.color;
  $('handoff-title').textContent = `${p.name}, plan your shot`;
  $('handoff-step').textContent = hotseatStep(p, `volley ${game.turnsThisRound + 1}`);
  $('handoff-text').textContent = 'Everyone else, look away. Drive and aim as you like, then press Space to lock it in. Nobody fires until every tank is ready.';
  $('handoff').classList.remove('hidden');
}

function closeHandoff() {
  if (!handoffOpen) return;
  handoffOpen = false;
  $('handoff').classList.add('hidden');
}
$('handoff-go').onclick = () => { sound.click(); closeHandoff(); };

// ---------------------------------------------------------------- pips and locators

// A small dot where a shell came down, pinned to the screen edge (with an
// arrow) when that spot is off camera. In a volley, other tanks' landings get
// one in the shooter's colour, lasting a few seconds into the next planning
// phase. A rangefinder's probes get `sticky` ones, kept until that tank fires
// again and shown only to it while it plans.
function addPip(owner, pos, { label, color, sticky = false } = {}) {
  const now = performance.now();
  // A cluster's bomblets land together: one pip covers them.
  if (!sticky && pips.some((q) => q.owner === owner && !q.sticky && now - q.born < 2500 && Math.hypot(q.pos[0] - pos[0], q.pos[2] - pos[2]) < 40)) return;
  const p = game.players[owner];
  const el = document.createElement('div');
  el.className = sticky ? 'pip probe' : 'pip';
  el.style.setProperty('--c', color || p.color);
  el.innerHTML = `<i></i><span>${escapeHtml(label || p.name)}</span>`;
  $('labels').appendChild(el);
  const q = { owner, pos: [...pos], el, born: now, until: 0, sticky };
  pips.push(q);
  return q;
}

function dropPip(q) {
  q.el.remove();
  if (q.beam) { scene.remove(q.beam); q.beam.material.dispose(); }
}

// Rangefinder colours: the aimed probe white, turret pair amber, power pair cyan.
const PROBE_COLORS = { aim: '#ffffff', turn: '#ffc35a', power: '#6fe3ff' };
const probeColor = (key) => PROBE_COLORS[key.replace(/[+-]$/, '')];
const BEAM_GEO = new THREE.CylinderGeometry(0.8, 0.8, 50, 8, 1, true).translate(0, 25, 0);

function addProbePip(owner, pos, pb) {
  const label = pb.key === 'aim' ? 'as aimed'
    : pb.key.startsWith('turn') ? `turret ${pb.yaw.toFixed(1)}°` : `power ${pb.power.toFixed(1)}`;
  const color = probeColor(pb.key);
  const q = addPip(owner, pos, { label, color, sticky: true });
  // A tall thin beam, so the spread reads from across the map.
  q.beam = new THREE.Mesh(BEAM_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }));
  q.beam.position.set(pos[0], pos[1], pos[2]);
  scene.add(q.beam);
}

// Where a world point sits on screen. One that is off screen (or behind the
// camera) is pulled onto an edge, in far enough for a name to fit and clear of
// the HUD panels; `angle` then points from there toward it.
const _pipV = new THREE.Vector3();
const HUD_PANELS = ['player-card', 'range-card', 'scoreboard'];
function screenSpot(x, y, z) {
  const W = window.innerWidth, H = window.innerHeight;
  const v = _pipV.set(x, y, z).project(camera);
  let nx = v.x, ny = v.y;
  const behind = v.z > 1;
  if (behind) { nx = -nx; ny = -ny; }
  const off = behind || Math.abs(nx) > 1 || Math.abs(ny) > 1;
  if (off) { const m = Math.max(Math.abs(nx), Math.abs(ny)) || 1; nx /= m; ny /= m; }
  const [l, r, t, b] = off ? [80, W - 80, 60, H - 125] : [10, W - 10, 10, H - 10];
  const sx = Math.min(r, Math.max(l, (nx * 0.5 + 0.5) * W));
  let sy = Math.min(b, Math.max(t, (-ny * 0.5 + 0.5) * H));
  if (off) {
    // Keep clear of the HUD panels: slide down below any that it lands on.
    for (const id of HUD_PANELS) {
      const box = $(id).getBoundingClientRect();
      if (box.width && sx > box.left - 30 && sx < box.right + 30 && sy > box.top - 30 && sy < box.bottom + 25) sy = Math.min(b, box.bottom + 25);
    }
  }
  return { sx, sy, off, angle: Math.atan2(-ny, nx), l, r, t, b };
}

// Slide an edge marker along its edge until it clears the ones already placed.
function unstack(s, placed) {
  const alongY = s.sx === s.l || s.sx === s.r;
  for (let tries = 0; tries < 6 && placed.some(([px, py]) => Math.hypot(px - s.sx, py - s.sy) < 34); tries++) {
    if (alongY) s.sy = Math.min(s.b, Math.max(s.t, s.sy + 36)); else s.sx = Math.min(s.r, Math.max(s.l, s.sx + 90));
  }
  placed.push([s.sx, s.sy]);
}

function place(el, s) {
  el.classList.toggle('edge', s.off);
  el.style.left = `${s.sx}px`;
  el.style.top = `${s.sy}px`;
  if (s.off) el.style.setProperty('--a', `${s.angle}rad`);
}

function updatePips() {
  const now = performance.now();
  const placed = [];
  const labels = [];            // label boxes already placed, so close-together marks stay readable
  for (let i = pips.length - 1; i >= 0; i--) {
    const q = pips[i];
    if (!q.until && !q.sticky && game.phase === 'aim') q.until = now + 4000;
    const left = q.until ? (q.until - now) / 1000 : Infinity;
    if (left <= 0) { dropPip(q); pips.splice(i, 1); continue; }
    const hide = handoffOpen || (q.sticky && game.phase === 'aim' && game.current && game.current.id !== q.owner);
    q.el.style.display = hide ? 'none' : '';
    if (q.beam) {
      // Fade a beam the camera is right beside: up close it is a wall, not a marker.
      const near = Math.min(1, Math.max(0.12, (Math.hypot(camera.position.x - q.pos[0], camera.position.z - q.pos[2]) - 25) / 90));
      q.beam.visible = !hide;
      q.beam.material.opacity = 0.5 * near * Math.min(1, left / 1.2);
    }
    if (hide) continue;
    q.el.style.opacity = Math.min(1, left / 1.2);
    const s = screenSpot(q.pos[0], q.pos[1] + 1, q.pos[2]);
    if (s.off) unstack(s, placed);
    place(q.el, s);
    // Marks that land close together (a rangefinder's always do from afar):
    // the dots stay put and their names stack downward.
    const span = q.el.lastElementChild;
    const w = (q.w ||= span.offsetWidth || 60) / 2 + 4;
    let top = 14;
    while (top < 100 && labels.some(([x, y, hw]) => Math.abs(x - s.sx) < hw + w && Math.abs(y - (s.sy + top)) < 13)) top += 13;
    span.style.top = `${top}px`;
    labels.push([s.sx, s.sy + top, w]);
  }
}

// While you plan, every opponent that is off screen gets an arrow on the
// screen edge with its name and range. Click one, or press F, to look.
function updateLocators() {
  const me = game.phase === 'aim' && !handoffOpen && !overview && game.current && !game.current.ai ? game.current : null;
  const placed = [];
  game.players.forEach((p, i) => {
    const el = locators[i];
    const s = me && p !== me && p.alive ? screenSpot(p.x, p.y + 4, p.z) : null;
    if (!s || !s.off) { el.style.display = 'none'; return; }
    el.style.display = '';
    unstack(s, placed);
    place(el, s);
    el.querySelector('small').textContent = `${Math.round(Math.hypot(p.x - me.x, p.z - me.z))} m`;
  });
}

// A three-second look at another tank; the camera then drifts back.
function peekAt(p) {
  if (!game || game.phase !== 'aim' || !p.alive || p === game.current) { peek = null; return; }
  peek = { id: p.id, until: performance.now() + 3000 };
  camGoal = null;
  overview = false;
}

// A three-second look at a spot on the ground (the rangefinder card's click).
function peekSpot(pos) {
  if (!game || game.phase !== 'aim') return;
  peek = { id: null, x: pos[0], y: pos[1], z: pos[2], until: performance.now() + 3000 };
  camGoal = null;
  overview = false;
}

// F: look at the next opponent, nearest first.
function peekNext() {
  const me = game.current;
  if (!me) return;
  const foes = game.players.filter((p) => p.alive && p !== me)
    .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
  if (!foes.length) return;
  const at = peek && performance.now() < peek.until ? foes.findIndex((p) => p.id === peek.id) : -1;
  peekAt(foes[(at + 1) % foes.length]);
}

// ---------------------------------------------------------------- rangefinder card

// A top-down plot of your last rangefinder shot, turned so downrange is up:
// the five landings, the enemy nearest them with the blast circle of your
// weapon around it, how far off the aimed probe was, and the turret and
// power the probes say would land on it.

// Whose card to show: the planner's while planning, your own while shells fly.
function rangeOwner() {
  if (!game || handoffOpen) return null;
  if (game.phase === 'aim') return game.current && !game.current.ai ? game.current : null;
  if (heroId != null) return game.players[heroId];
  return game.humans.length === 1 ? game.humans[0] : null;
}

let rcSpot = null;              // where a click on the card looks
$('range-card').addEventListener('click', () => rcSpot && peekSpot(rcSpot));

const signed = (v, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

function updateRangeCard() {
  const me = rangeOwner();
  const r = me && ranges.get(me.id);
  const a = r?.probes.aim;
  $('range-card').classList.toggle('hidden', !a);
  if (!a) { rcSpot = null; return; }
  rcSpot = a.pos;

  const ax = rangeAxes(a.yaw);
  const pts = Object.entries(r.probes).map(([key, pb]) => ({ key, pb, ...toRange(ax, a.pos, pb.pos) }));
  const foe = game.players.filter((p) => p.alive && p !== me)
    .sort((p, q) => Math.hypot(p.x - a.pos[0], p.z - a.pos[2]) - Math.hypot(q.x - a.pos[0], q.z - a.pos[2]))[0];
  const t = foe ? toRange(ax, a.pos, [foe.x, foe.y, foe.z]) : null;
  const w = WEAPON_BY_ID[me.weapon];
  const blast = (w?.impact.find((i) => i.type === 'blast') || WEAPON_BY_ID.shell.impact[0]).radius;

  // ---- plot
  const cv = $('rc-plot');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g2 = cv.getContext('2d');
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, W, H);
  // Fit the probes; take in the enemy too unless it is far off, then pin it to the edge.
  const spread = Math.max(...pts.map((q) => Math.hypot(q.side, q.along)), 0);
  const base = Math.max(20, spread * 1.35);
  const tDist = t ? Math.hypot(t.side, t.along) : 0;
  const ext = Math.min(base * 3, Math.max(base, tDist * 1.2 + blast * 0.5));
  const k = (Math.min(W, H) / 2 - 12) / ext;
  const cx = W / 2, cy = H / 2;
  const X = (side) => cx + side * k, Y = (along) => cy - along * k;

  // Range rings round the aimed landing, a sensible step apart.
  const step = [5, 10, 25, 50, 100, 200, 500].find((s) => ext / s <= 3.2) || 1000;
  g2.strokeStyle = 'rgba(255,255,255,0.10)';
  g2.lineWidth = 1;
  g2.beginPath(); g2.moveTo(0, cy); g2.lineTo(W, cy); g2.moveTo(cx, 0); g2.lineTo(cx, H); g2.stroke();
  for (let d = step; d <= ext * 1.5; d += step) { g2.beginPath(); g2.arc(cx, cy, d * k, 0, Math.PI * 2); g2.stroke(); }
  g2.font = '10px system-ui, sans-serif';
  g2.fillStyle = 'rgba(255,255,255,0.4)';
  g2.textAlign = 'left';
  g2.fillText(`${step} m`, cx + step * k * 0.71 + 2, cy - step * k * 0.71 - 2);
  g2.fillText('▲ downrange', 2, 11);
  g2.textAlign = 'center';
  g2.fillText('you', cx, H - 3);

  // The enemy, its blast circle, and a line from the aimed landing to it.
  if (t) {
    const edge = tDist * k > Math.min(W, H) / 2 - 12;
    const s = edge ? (Math.min(W, H) / 2 - 12) / (tDist * k) : 1;
    const ex = X(t.side * s), ey = Y(t.along * s);
    g2.setLineDash([3, 3]);
    g2.strokeStyle = 'rgba(255,255,255,0.35)';
    g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(ex, ey); g2.stroke();
    g2.setLineDash([]);
    if (!edge) {
      g2.fillStyle = 'rgba(255,90,70,0.12)';
      g2.strokeStyle = 'rgba(255,110,90,0.55)';
      g2.beginPath(); g2.arc(ex, ey, blast * k, 0, Math.PI * 2); g2.fill(); g2.stroke();
    }
    g2.fillStyle = foe.color;
    g2.strokeStyle = '#000';
    if (edge) {
      // A triangle on the rim, pointing out toward it.
      const ang = Math.atan2(ey - cy, ex - cx);
      g2.beginPath();
      g2.moveTo(ex + Math.cos(ang) * 7, ey + Math.sin(ang) * 7);
      g2.lineTo(ex + Math.cos(ang + 2.4) * 6, ey + Math.sin(ang + 2.4) * 6);
      g2.lineTo(ex + Math.cos(ang - 2.4) * 6, ey + Math.sin(ang - 2.4) * 6);
      g2.closePath(); g2.fill(); g2.stroke();
    } else { g2.fillRect(ex - 5, ey - 4, 10, 8); g2.strokeRect(ex - 5, ey - 4, 10, 8); }
    g2.font = 'bold 11px system-ui, sans-serif';
    g2.textAlign = ex > W - 50 ? 'right' : ex < 50 ? 'left' : 'center';
    g2.fillText(edge ? `${foe.name} ${Math.round(tDist)} m` : foe.name, ex, ey > 24 ? ey - 9 : ey + 18);
  }

  // The probes, labelled with how each differs from the aim.
  g2.font = '10px system-ui, sans-serif';
  for (const q of pts) {
    const x = X(q.side), y = Y(q.along);
    g2.fillStyle = probeColor(q.key);
    g2.beginPath(); g2.arc(x, y, q.key === 'aim' ? 4.5 : 3.5, 0, Math.PI * 2); g2.fill();
    // Aim above its dot, the turret pair outward to either side, power to the right.
    if (q.key === 'aim') { g2.textAlign = 'center'; g2.fillText('aim', x, y - 8); }
    else if (q.key.startsWith('turn')) {
      g2.textAlign = q.side < 0 ? 'right' : 'left';
      g2.fillText(`${signed(((q.pb.yaw - a.yaw + 540) % 360) - 180, 0)}°`, x + (q.side < 0 ? -7 : 7), y + 4);
    } else { g2.textAlign = 'left'; g2.fillText(signed(q.pb.power - a.power, 0), x + 7, y + 4); }
  }

  // ---- words
  if (!t) { $('rc-read').textContent = 'No enemy left to range on.'; $('rc-est').textContent = ''; return; }
  const off = Math.hypot(t.side, t.along);
  $('rc-read').textContent = off <= blast * 0.8 ? `As aimed: on ${foe.name}`
    : `As aimed: ${Math.round(Math.abs(t.along))} m ${t.along > 0 ? 'short' : 'long'}, ${Math.round(Math.abs(t.side))} m ${t.side > 0 ? 'left' : 'right'} of ${foe.name}`;
  const est = solveAim(r.probes, [foe.x, foe.y, foe.z]);
  const notes = [];
  if (Math.hypot(me.x - r.at[0], me.z - r.at[1]) > 4) notes.push('you have moved');
  if (Math.abs(me.elev - r.elev) > 0.05) notes.push(`probed at ${r.elev.toFixed(1)}° elevation`);
  if (Math.hypot(game.wind[0] - r.wind[0], game.wind[1] - r.wind[1]) > 0.6) notes.push('the wind has shifted');
  const note = notes.length ? `<small>Rough: ${notes.join(', ')}.</small>` : '';
  if (!est || Math.abs(est.dYaw) > 25 || Math.abs(est.dPower) > 35) {
    $('rc-est').innerHTML = `Too far off to estimate: aim again and probe.${note}`;
  } else if (est.power > TANK.maxPower || est.power < TANK.minPower) {
    $('rc-est').innerHTML = `Needs power ${est.power.toFixed(0)}: change the elevation.${note}`;
  } else {
    $('rc-est').innerHTML = `Try turret ${est.yaw.toFixed(1)}° (${signed(est.dYaw)}), power ${est.power.toFixed(1)} (${signed(est.dPower)})${note}`;
  }
}


// ---------------------------------------------------------------- steering

// A / D (or the side arrows) turn every human's guided missile while it flies.
// On a shared screen they all answer the same keys; with one human, only yours.
function applySteering() {
  if (!game || game.phase !== 'flight') { $('steer-hint').classList.add('hidden'); return; }
  const dir = (held.has('d') || held.has('arrowright') ? 1 : 0) - (held.has('a') || held.has('arrowleft') ? 1 : 0);
  let fuel = -1;
  for (const p of game.humans) {
    game.steer(p.id, dir);
    for (const pr of game.projectiles) if (pr.owner === p.id && pr.steer) fuel = Math.max(fuel, pr.steer.fuel);
  }
  $('steer-hint').classList.toggle('hidden', fuel < 0);
  if (fuel >= 0) {
    $('steer-fuel').style.width = `${(fuel / WEAPON_BY_ID.guided.flight[0].fuel) * 100}%`;
    $('steer-hint').classList.toggle('empty', fuel <= 0);
  }
}

// ---------------------------------------------------------------- kill cam

// When a shell in the air is about to end the round (its blast would leave at
// most one tank standing), time slows, the frame letterboxes and the camera
// swings round to watch it land from the side.
let killCam = null;             // { id, victim, side: [x, z], end }
let timeScale = 1;
const KILLCAM = { lead: 1.1, slow: 0.28, after: 1.6 };

// Where a projectile comes down within `horizon` seconds if nothing changes.
function forecast(pr, horizon) {
  const c = { pos: [...pr.pos], prev: [...pr.pos], vel: [...pr.vel], time: 0, g: pr.g, windK: pr.windK };
  const t = game.terrain;
  const step = 1 / 30;
  for (let s = step; s <= horizon; s += step) {
    stepProjectile(c, game.wind, step);
    if (!t.inBounds(c.pos[0], c.pos[2])) return null;
    for (const p of game.players) {
      if (!p.alive || (p.id === pr.owner && pr.time + s < 0.5)) continue;   // the shooter's grace, as in the game
      const h = hitSphere(p);
      if ((c.pos[0] - h.x) ** 2 + (c.pos[1] - h.y) ** 2 + (c.pos[2] - h.z) ** 2 <= h.r * h.r) return { t: s, pos: [...c.pos], direct: p };
    }
    const g = groundContact(c, t);
    if (g) return { t: s, pos: g, direct: null };
  }
  return null;
}

// The shell that will decide the round, if one is about to.
function decidingShot() {
  const alive = game.players.filter((p) => p.alive);
  if (alive.length < 2) return null;
  const dying = new Set();
  let pick = null;
  for (const pr of game.projectiles) {
    if (pr.dead || pr.probe || pr.roller) continue;
    const w = WEAPON_BY_ID[pr.weapon];
    const blast = w.impact?.find((i) => i.type === 'blast');
    if (!blast || rollPart(w) || (!pr.splitDone && w.flight?.some((f) => f.type === 'split'))) continue;
    const hit = forecast(pr, KILLCAM.lead);
    if (!hit) continue;
    const o = game.players[pr.owner];
    const radius = blast.radius * (1 + perkSum(o, 'blastRadius'));
    const damage = blast.damage * (1 + perkSum(o, 'blastDamage'));
    for (const p of alive) {
      const h = hitSphere(p);
      const d = p === hit.direct ? 0 : Math.max(0, Math.hypot(h.x - hit.pos[0], h.y - hit.pos[1], h.z - hit.pos[2]) - TANK.hitRadius * 0.5);
      if (blastDamage(d, radius, damage) < p.hp + p.armor) continue;
      dying.add(p.id);
      if (!pick || hit.t < pick.t) pick = { id: pr.id, victim: p.id, t: hit.t, from: pr.owner };
    }
  }
  return pick && alive.length - dying.size <= 1 ? pick : null;
}

function updateKillCam() {
  const now = performance.now();
  if (!killCam && game && game.phase === 'flight' && followShell && !overview && !pinned) {
    const k = decidingShot();
    if (k) {
      const pr = game.projectiles.find((q) => q.id === k.id);
      const v = game.players[k.victim];
      // Watch from the side of the incoming line, on the side the camera is already on.
      let dx = v.x - pr.pos[0], dz = v.z - pr.pos[2];
      const n = Math.hypot(dx, dz) || 1;
      dx /= n; dz /= n;
      let side = [-dz, dx];
      if ((camera.position.x - v.x) * side[0] + (camera.position.z - v.z) * side[1] < 0) side = [dz, -dx];
      killCam = { id: k.id, victim: k.victim, side, dir: [dx, dz], end: null };
      const by = game.players[k.from];
      $('killcam-cap').textContent = by.id === v.id ? `${v.name}…` : `${by.name} → ${v.name}`;
      document.body.classList.add('killcam');
    }
  }
  if (killCam) {
    if (killCam.end == null && !game.projectiles.some((q) => q.id === killCam.id)) killCam.end = now + KILLCAM.after * 1000;
    if (killCam.end != null && now > killCam.end) { killCam = null; document.body.classList.remove('killcam'); }
  }
  const goal = killCam && killCam.end == null ? KILLCAM.slow : killCam ? 0.55 : 1;
  timeScale += (goal - timeScale) * Math.min(1, 0.25);
}

// Camera for the kill cam: off to the side, low, looking at the target with
// the shell coming in.
function killCamView() {
  const v = game.players[killCam.victim];
  const pr = game.projectiles.find((q) => q.id === killCam.id);
  camTarget.set(v.x, v.y + 3, v.z);
  if (pr) camTarget.lerp(_v.set(pr.pos[0], pr.pos[1], pr.pos[2]), 0.3);
  const [sx, sz] = killCam.side, [dx, dz] = killCam.dir;
  // camGoal is an offset from the target.
  camGoal = new THREE.Vector3(sx * 40 - dx * 16 + (v.x - camTarget.x), 24, sz * 40 - dz * 16 + (v.z - camTarget.z));
}

// ---------------------------------------------------------------- inset

// While shells fly and the camera is away from your tank, a small view in
// the corner keeps it in sight, so you can see what is coming at you.
// Only with one human: on a shared screen there is no single "your tank".
const insetCam = new THREE.PerspectiveCamera(46, 1.6, 0.5, 4000);
let insetFor = null;            // player id shown in the inset this frame
const _back = new THREE.Vector3();

function insetPlayer() {
  if (!game || overview || !followShell || pinned || killCam) return null;
  if (game.phase !== 'flight' && game.phase !== 'settle') return null;
  const hs = game.humans;
  if (hs.length !== 1) return null;
  const p = hs[0];
  if (!p.alive && insetFor !== p.id) return null;       // keep it on a tank knocked out mid-volley
  if (controls.target.distanceTo(_v.set(p.x, p.y, p.z)) < 110) return null;   // already in the main view
  return p;
}

function renderInset() {
  const p = insetPlayer();
  insetFor = p ? p.id : null;
  $('inset').classList.toggle('hidden', !p);
  if (!p) return;
  const W = window.innerWidth;
  const w = Math.round(Math.min(360, Math.max(220, W * 0.24)));
  const h = Math.round(w * 0.6);
  const x = W - w - 16, y = 54;                          // from the bottom-left, as GL counts
  const box = $('inset');
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  box.style.setProperty('--c', p.color);
  $('inset-name').textContent = whose(p, 'tank');
  _back.set(-Math.cos(p.yaw * DEG), 0, -Math.sin(p.yaw * DEG));
  insetCam.position.set(p.x + _back.x * 40, p.y + 22, p.z + _back.z * 40);
  const t = game.terrain;
  if (t.inBounds(insetCam.position.x, insetCam.position.z)) insetCam.position.y = Math.max(insetCam.position.y, t.heightAt(insetCam.position.x, insetCam.position.z) + 6);
  insetCam.lookAt(p.x, p.y + 2, p.z);
  insetCam.aspect = w / h;
  insetCam.updateProjectionMatrix();
  renderer.setScissorTest(true);
  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.render(scene, insetCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, window.innerHeight);
}

function flashInset(amount) {
  const box = $('inset');
  $('inset-dmg').textContent = `-${Math.round(amount)}`;
  box.classList.remove('hit');
  void box.offsetWidth;                                  // restart the animation
  box.classList.add('hit');
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

const _box = new THREE.Box3();

function updateCamera(dt) {
  camera.position.sub(lastShake);
  let frame = 0;                // a volley asks for this much distance
  if (game) {
    if (pinned) {
      // Debug camera: hold still.
    } else if (killCam) {
      killCamView();
    } else if (overview) {
      camTarget.set(0, 10, 0);
    } else if (heroId != null && game.volleyMode && followShell && (game.phase === 'volley' || (game.phase === 'flight' && game.projectiles.length))) {
      // Your volley: ride your own shell. Once it is down, hold on where it
      // landed; the others' landings show as pips.
      const hero = game.players[heroId];
      const mine = game.projectiles.filter((pr) => pr.owner === heroId);
      if (game.phase === 'volley') camTarget.set(hero.x, hero.y + 4, hero.z);
      else if (mine.length) {
        camTarget.set(0, 0, 0);
        mine.forEach((pr) => camTarget.add(_v.set(pr.pos[0], pr.pos[1], pr.pos[2])));
        camTarget.divideScalar(mine.length);
      }
    } else if (game.volleyMode && followShell && (game.phase === 'volley' || (game.phase === 'flight' && game.projectiles.length))) {
      // A shared-screen volley: stand back far enough to see every shell (or, in the beat
      // before, every tank about to fire).
      _box.makeEmpty();
      if (game.phase === 'volley') game.players.forEach((p) => { if (p.alive) _box.expandByPoint(_v.set(p.x, p.y, p.z)); });
      else game.projectiles.forEach((pr) => _box.expandByPoint(_v.set(pr.pos[0], pr.pos[1], pr.pos[2])));
      _box.getCenter(camTarget);
      frame = Math.min(1300, Math.max(130, (_box.getSize(_v).length() * 0.62) / Math.tan((camera.fov * DEG) / 2)));
      camGoal = null;
    } else if (game.phase === 'flight' && followShell && game.projectiles.length) {
      const c = new THREE.Vector3();
      game.projectiles.forEach((pr) => c.add(new THREE.Vector3(...pr.pos)));
      c.divideScalar(game.projectiles.length);
      camTarget.copy(c);
    } else if (game.phase === 'aim' && game.current) {
      const look = peek && performance.now() < peek.until ? (peek.id != null ? game.players[peek.id] : peek) : null;
      if (!look) peek = null;
      const p = look || game.current;
      camTarget.set(p.x, p.y + 4, p.z);
      // Left far out (e.g. by the volley framing) with nobody steering: come back in.
      if (!look && !camGoal && !userCam && camera.position.distanceTo(controls.target) > 300) aimCameraAt(p);
    }
  }
  const before = controls.target.clone();
  controls.target.lerp(camTarget, 1 - Math.exp(-dt * 3.2));
  camera.position.add(controls.target.clone().sub(before));
  if (frame) {
    // Back off (or close in) to the framing distance, looking down enough to see over the hills.
    const k = 1 - Math.exp(-dt * 2.2);
    _sCur.setFromVector3(_off.subVectors(camera.position, controls.target));
    _sCur.radius += (frame - _sCur.radius) * k;
    _sCur.phi += (Math.min(_sCur.phi, 1.0) - _sCur.phi) * k;
    camera.position.copy(controls.target).add(_off.setFromSpherical(_sCur));
  }
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
  if (dragFrom && Math.hypot(e.clientX - dragFrom[0], e.clientY - dragFrom[1]) > 4) { camGoal = null; dragFrom = null; userCam = true; }
});
window.addEventListener('pointerup', () => { dragFrom = null; });
renderer.domElement.addEventListener('wheel', () => { camGoal = null; userCam = true; }, { passive: true });

// ---------------------------------------------------------------- input

const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === 'tab' || k.startsWith('arrow')) e.preventDefault();
  held.add(k);
  if (e.repeat || !game) return;
  if (handoffOpen) {
    if (k === ' ' || k === 'enter') { e.preventDefault(); closeHandoff(); }
    held.clear();
    return;
  }
  if (k === ' ') { e.preventDefault(); if (game.current && !game.current.ai && game.fire()) { /* fired */ } }
  else if (k === 'tab') { game.cycleWeapon(e.shiftKey ? -1 : 1); sound.click(); }
  else if (k >= '1' && k <= '9') selectWeaponSlot(Number(k) - 1);
  else if (k === 'f') peekNext();
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
  if (!p || p.ai || game.phase !== 'aim' || handoffOpen) return;
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
  if (!game || handoffOpen || game.phase !== 'aim' || !game.current || game.current.ai) return;
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
    <div class="sb-row" id="sb-${p.id}" data-id="${p.id}" title="Click to look at ${escapeHtml(p.name)}">
      <span class="swatch" style="background:${p.color}"></span>
      <span style="width:74px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name)}</span>
      <div class="bar"><div class="fill hp"></div></div>
      <span class="wins"></span>
      <div class="sb-perks"></div>
    </div>`).join('');
  $('scoreboard').querySelectorAll('.sb-row').forEach((row) => {
    row.onclick = () => game && peekAt(game.players[Number(row.dataset.id)]);
  });
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
    // Under each: what the last shot used, and how far the aim is from it now.
    const last = p.ai ? null : p.shots[p.shots.length - 1];
    const was = (id, then, now, unit, wrap) => {
      let text = p.ai ? '' : '—';
      if (last) {
        const d = wrap ? ((now - then + 540) % 360) - 180 : now - then;
        const delta = Math.abs(d) < 0.05 ? 'same' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
        text = `last ${then.toFixed(1)}${unit}<b>${delta}</b>`;
      }
      if ($(id).dataset.t !== text) { $(id).dataset.t = text; $(id).innerHTML = text; }
    };
    was('last-yaw', last?.yaw, p.yaw, '°', true);
    was('last-elev', last?.elev, p.elev, '°', false);
    was('last-power', last?.power, p.power, '', false);
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
    firing: $('opt-firing').value,
  });
};

function standingsTable(sorted) {
  return `<tr><th></th><th>Tank</th><th>Wins</th><th>Funds</th></tr>` + sorted.map((p) => `
    <tr><td><span class="swatch" style="background:${p.color}"></span></td><td>${escapeHtml(p.name)}${p.alive ? '' : ' <span style="color:#9aa6b2">(destroyed)</span>'}</td>
    <td>${p.wins}</td><td>$${p.money}</td></tr>`).join('');
}

// Whole-match numbers per tank. Accuracy counts shots that hurt someone else;
// rangefinder probes are listed apart.
function statsTable(sorted) {
  const pct = (st) => (st.shots ? `${Math.round((st.hits / st.shots) * 100)}%` : '–');
  return `<tr><th></th><th>Tank</th><th>Hits</th><th>Accuracy</th><th>Damage</th><th>Kills</th><th>Longest hit</th><th>Probes</th></tr>` + sorted.map((p) => {
    const st = p.stats;
    return `<tr><td><span class="swatch" style="background:${p.color}"></span></td><td>${escapeHtml(p.name)}</td>
      <td>${st.hits} / ${st.shots}</td><td>${pct(st)}</td><td>${Math.round(st.damage)}</td><td>${st.kills}</td>
      <td>${st.longest ? `${Math.round(st.longest)} m` : '–'}</td><td>${st.probes || '–'}</td></tr>`;
  }).join('');
}

// A few lines worth reading out at the end.
function awards(players) {
  const best = (score, ok) => players.filter(ok).reduce((a, b) => (!a || score(b) > score(a) ? b : a), null);
  const name = (p) => `<b style="color:${p.color}">${escapeHtml(p.name)}</b>`;
  const out = [];
  const sharp = best((p) => p.stats.hits / p.stats.shots, (p) => p.stats.shots >= 3 && p.stats.hits > 0);
  if (sharp) out.push(`Sharpshooter: ${name(sharp)}, ${sharp.stats.hits} of ${sharp.stats.shots} shots hit`);
  const far = best((p) => p.stats.longest, (p) => p.stats.longest > 0);
  if (far) out.push(`Longest hit: ${name(far)}, ${Math.round(far.stats.longest)} m`);
  const dmg = best((p) => p.stats.damage, (p) => p.stats.damage > 0);
  if (dmg) out.push(`Most damage: ${name(dmg)}, ${Math.round(dmg.stats.damage)}`);
  const kills = best((p) => p.stats.kills, (p) => p.stats.kills > 0);
  if (kills) out.push(`Most kills: ${name(kills)}, ${kills.stats.kills}`);
  return out.map((t) => `<div>${t}</div>`).join('');
}

function showRoundResult(kind) {
  if (!game) return;
  const w = game.lastRoundResult.winner != null ? game.players[game.lastRoundResult.winner] : null;
  if (kind === 'matchOver') {
    const sorted = [...game.players].sort((a, b) => b.wins - a.wins || b.money - a.money);
    $('mo-title').textContent = `Match winner: ${sorted[0].name}`;
    $('mo-table').innerHTML = standingsTable(sorted);
    $('mo-stats').innerHTML = statsTable(sorted);
    $('mo-awards').innerHTML = awards(game.players);
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
  closeHandoff();
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
    updateKillCam();
    const sdt = dt * timeScale;   // game time: slowed for the kill cam
    applyHeldKeys(dt);
    applySteering();
    game.update(sdt);
    handleEvents();
    game.players.forEach((p, i) => tanks[i].sync(p, game.terrain, sdt));
    tankSmoke(dt);
    for (const pr of game.projectiles) {
      shells.get(pr.id)?.push(pr.pos);
      if (!pr.roller) birds.scare(pr.pos, 28);
    }
    fadeTrails(dt);
    updateTracer();
    sceneryMesh.sync(elapsed);
    updateHud();
    updateLabels();
    updatePips();
    updateLocators();
    updateRangeCard();
    // The sun moves a little every turn and a lot over the match.
    const within = Math.min(1, game.turnsThisRound / ((game.volleyMode ? 1 : game.players.length) * 6));
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
  effects.update(dt * timeScale);
  updateCamera(dt);
  renderer.shadowMap.needsUpdate = true;   // once a frame, shared by the inset
  renderer.render(scene, camera);
  renderInset();
}

// A backdrop field for the menu; dropped once a real match starts.
const menuField = new Game({ players: [{ name: 'a' }, { name: 'b' }], seed: 4242 });
menuField.terrain.generate({ seed: 4242, amplitude: 45 });
menuField.scenery.generate({ seed: 4242 });
const menuMesh = new TerrainMesh(menuField.terrain);
menuMesh.rebuild();
const menuScenery = new SceneryMesh(menuField.scenery);
menuScenery.rebuild();
menuMesh.setPaths(menuField.scenery.paths);
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
  get killCam() { return killCam; },
  get timeScale() { return timeScale; },
  audioLatency() { return sound.ctx ? { base: sound.ctx.baseLatency, output: sound.ctx.outputLatency } : null; },
  setDay(k) { dayLock = k; } };
