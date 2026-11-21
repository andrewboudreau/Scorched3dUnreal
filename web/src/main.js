import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { Game, PLAYER_COLORS, FOG } from './core/game.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS, blastDamage } from './core/weapons.js';
import { Session } from './core/netplay.js';
import { RoomLink, listRooms } from './net.js';
import { TANK, JET, muzzleOrigin, hitSphere } from './core/tank.js';
import { ROLL, SIM_DT, makeProjectile, stepProjectile, launchVelocity, groundContact } from './core/ballistics.js';
import { PERK_BY_ID, perkSum } from './core/perks.js';
import { rollPart } from './core/weapons.js';
import { rangeAxes, toRange, solveAim } from './core/rangefinder.js';
import { TerrainMesh, groundShade } from './render/terrainMesh.js';
import { SceneryMesh } from './render/sceneryMesh.js';
import { BUILDINGS } from './core/scenery.js';
import { TankMesh } from './render/tankMesh.js';
import { Wreck } from './render/wreck.js';
import { Effects, ShellVisual } from './render/effects.js';
import { Sky } from './render/sky.js';
import { Moons } from './render/moons.js';
import { AimArc, Gunner } from './gunner.js';
import { Birds } from './render/birds.js';
import { Sound } from './audio.js';
import { Music, TRACKS } from './music.js';
import { TouchControls, wantTouch, coarsePointer, mobilePerf } from './touch.js';
import { Settings, canFullscreen, isFullscreen, toggleFullscreen } from './settings.js';
import { groundHit, tankHit, bearingTo } from './core/tapaim.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
// MSAA on a 2x screen is 4x the pixels times 4 samples; 1.5 looks the same.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;    // tick() asks for one update a frame
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new Sky(scene);   // sun, sky light, fog, clouds
const moons = new Moons(scene);   // the floating isles' moons
if (coarsePointer) mobilePerf(renderer, sky);   // phones and tablets: fewer pixels, smaller shadow map

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
const aimArc = new AimArc(scene, $('labels'));   // the dashed climb of the shot being planned
const gunner = new Gunner($('hud'));             // the sight: G, or Sight on a phone
const lastLand = new Map();                      // tank id -> where its last shot came down: { shot, pos, at }
const sound = new Sound();
const music = new Music(sound);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- match state

let game = null;
let terrainMesh = null;
let review = null;           // the resource-pack review (src/review.js), dev server only
let sceneryMesh = null;
let tanks = [];
let smoke = [];                 // per tank: seconds until its next puff
let labels = [];
let ghosts = [];                // fog: per tank, a ring and a label where this screen last placed it
let pulses = [];                // fog: scout bursts spreading out
let fogFor = null;              // fog: the tanks this screen sees for, this frame (null: sees everything)
let wrecks = [];
const shells = new Map();       // projectile id -> ShellVisual
const fadingTrails = [];        // finished shells' trails, fading out
let handoffOpen = false;        // volley planning: waiting for the next human to sit down
// A volley with one human in it: the camera rides that human's shell and every
// other tank's landing gets a pip (see addPip). Null when several humans share
// the screen; then the camera stands back to frame every shell instead.
let heroId = null;
const pips = [];
const hops = new Map();         // tank id -> the jump jet hop being drawn: { from, to, t, dur, puff }
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
let shopPid = null;             // whose draft or armory is open
let day = 0;                    // 0 late morning .. 1 late afternoon, eased toward the match's progress
let dayLock = null;             // debug: hold the sun still at this time of day
let bannerHold = 0;             // a round banner keeps the turn banner waiting until then
let driveNote = { text: '', until: 0 };
const _v = new THREE.Vector3();
const camDist = (pos) => camera.position.distanceTo(_v.set(pos[0], pos[1], pos[2]));
// Scratch objects for per-frame work. Nothing may keep one past the call that filled it
// (except camGoal, which deliberately points at _killGoal / _menuGoal and only reads them).
const _lblV = new THREE.Vector3();       // projecting labels and popups
const _shellC = new THREE.Vector3();     // centre of the shells in flight
const _camBefore = new THREE.Vector3();
const _camDelta = new THREE.Vector3();
const _killGoal = new THREE.Vector3();
const _menuGoal = new THREE.Vector3();

// ---- DOM write helpers: touching the DOM with the value it already has still costs
// style work, so every per-frame write goes through one of these.
function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
// An inline style property, remembered on the element so we never read it back.
function setStyle(el, prop, v) {
  const c = el._st || (el._st = {});
  if (c[prop] !== v) { c[prop] = v; el.style[prop] = v; }
}
function setDisplay(el, v) { if (el._disp !== v) { el._disp = v; el.style.display = v; } }
// Move an absolutely placed element (left/top 0 in CSS) by transform, which needs no layout.
// `anchor` is the element's own centring translate from style.css.
function moveTo(el, x, y, anchor) {
  const tf = `translate(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px) ${anchor}`;
  if (el._tf !== tf) { el._tf = tf; el.style.transform = tf; }
}
const CENTRE = 'translate(-50%, -50%)', ABOVE = 'translate(-50%, -100%)';
// Where the HUD panels sit, read once at the start of each frame (before that frame's
// DOM writes) so screenSpot never forces a layout per marker.
const HUD_PANELS = ['player-card', 'range-card', 'scoreboard'];
let hudBoxes = [];
function readHudBoxes() {
  hudBoxes = HUD_PANELS.map((id) => { const b = $(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; });
}

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

function dropWreck(w) { w.dispose(); }

// Where to draw a shell this frame: between its last two sim steps, by how far
// the clock has run into the next one. Without this a slowed-down shell (the
// kill cam) only moves on the frames that happen to take a step.
const _shellAt = [0, 0, 0];
function shellPos(pr) {
  if (pr.roller || !pr.prev || !game) return pr.pos;
  const a = Math.min(1, game.acc / SIM_DT);
  for (let k = 0; k < 3; k++) _shellAt[k] = pr.prev[k] + (pr.pos[k] - pr.prev[k]) * a;
  return _shellAt;
}

// Blasts seen in this batch of events, so a tank that dies to one knows
// which way it was thrown.
const recentBlasts = [];

function clearTrails() {
  fadingTrails.forEach(dropTrail);
  fadingTrails.length = 0;
}

function disposeMatch() {
  if (terrainMesh) { scene.remove(terrainMesh.group); terrainMesh.dispose(); }
  if (sceneryMesh) { scene.remove(sceneryMesh.group); sceneryMesh.dispose(); sceneryMesh = null; }
  tanks.forEach((t) => { scene.remove(t.root); t.dispose(); });
  ghosts.forEach((g) => { scene.remove(g.ring); g.ring.material.dispose(); });
  pulses.forEach((q) => { scene.remove(q.mesh); q.mesh.material.dispose(); });
  ghosts = []; pulses = []; fogFor = null;
  groundShade.fogOn.value = 0;
  wrecks.forEach(dropWreck);
  shells.forEach((s) => { scene.remove(s.mesh, s.line); });
  shells.clear();
  clearTrails();
  closeHandoff();
  effects.clear();
  hops.clear();
  tanks = []; wrecks = []; labels = [];
  pips.forEach(dropPip);      // takes a rangefinder pip's beam out of the scene too
  pips.length = 0;
  heroId = null;
  $('labels').innerHTML = '';
  moons.set([]);
  sky.setSpace(false);
  lastLand.clear();
  aimArc.hide();
  floor.visible = birds.bodies.visible = birds.wings.visible = true;
}

function startMatch(config) {
  disposeMatch();
  scene.remove(menuMesh.group, menuScenery.group);
  game = new Game(config);
  terrainMesh = new TerrainMesh(game.terrain);
  sceneryMesh = new SceneryMesh(game.scenery);
  scene.add(terrainMesh.group, sceneryMesh.group);
  review?.onMatch();
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
  ghosts = game.players.map((p) => {
    const ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 5;
    ring.visible = false;
    scene.add(ring);
    const el = document.createElement('div');
    el.className = 'tank-label ghost';
    el.innerHTML = `<div style="color:${p.color}">${escapeHtml(p.name)}?</div><small></small>`;
    el.style.display = 'none';
    $('labels').appendChild(el);
    return { ring, el };
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
  handleEvents();      // builds the round (terrain, scenery, water) so the warm-up sees it
  showHud(true);
  warmShaders();
}

// Compile every shader the match can need now, while the screen is changing
// anyway, rather than the first time a fog ring or explosion shows up.
function warmShaders() {
  effects.warm(renderer, camera);
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
  const d = camera.position.distanceTo(_v.set(pos[0], pos[1], pos[2]));
  shake = Math.max(shake, power * Math.max(0, 1 - d / 900));
}

function handleEvents() {
  recentBlasts.length = 0;
  for (const e of game.drainEvents()) {
    switch (e.type) {
      case 'roundStart':
        wrecks.forEach(dropWreck);
        wrecks = [];
        clearTrails();
        pips.forEach(dropPip);
        pips.length = 0;
        ranges.clear();
        hops.clear();
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
        if (e.full) {
          dirty.length = 0;
          terrainMesh.rebuild();
          sceneryMesh.rebuild();
          terrainMesh.setPaths(game.scenery.paths);
          sky.setSpace(!!game.terrain.under);
          floor.visible = !game.terrain.under;   // nothing under the isles but space
          birds.bodies.visible = birds.wings.visible = !game.terrain.under;
          moons.set(game.terrain.wells);
        }
        else addDirty(e.region);
        break;
      case 'turn': {
        const p = game.players[e.player];
        userCam = false;   // a new planner gets the camera back
        if (!overview && seen(p, fogView())) aimCameraAt(p);
        // In a volley a "turn" is one tank's go at planning (or a CPU driving).
        const [title, sub] = !e.plan ? [whose(p, 'turn'), p.ai ? `CPU · ${p.ai}` : 'Aim and fire']
          : p.ai ? [`${p.name} is on the move`, `CPU · ${p.ai}`] : [whose(p, 'shot'), touch ? 'Plan it, then tap Lock in' : 'Plan it, then Space to lock it in'];
        if (e.plan && !p.ai && game.localHumans.filter((h) => h.alive).length > 1) { openHandoff(p); break; }
        setTimeout(() => { if (game && game.turn === p.id && game.phase === 'aim') banner(title, sub, e.plan && !p.ai ? 1700 : 1100); },
          Math.max(50, bannerHold - performance.now()));
        if (touch && !p.ai && !p.shots.length && game.round === 1) {
          setTimeout(() => { if (game?.current === p && game.phase === 'aim') touch.note('Tap the ground or a tank to turn toward it', 4500); },
            Math.max(50, bannerHold - performance.now()) + 1800);
        }
        break;
      }
      case 'locked':
        sound.click();
        banner('Locked in', '', 700);
        break;
      case 'volley': {
        closeHandoff();
        const alive = game.localHumans.filter((h) => h.alive && e.players.includes(h.id));
        heroId = alive.length === 1 ? alive[0].id : null;
        if (heroId != null && followShell && !overview) aimCameraAt(game.players[heroId]);
        banner('Fire!', `${e.players.length} tanks, all together`, 1300);
        break;
      }
      case 'aimReset':
        if (game.current?.id === e.player) driveNote = { text: 'Moved: last aim cleared', until: performance.now() + 1800 };
        break;
      case 'jump':
        startHop(e);
        break;
      case 'warp': {
        hops.delete(e.player);
        const q = game.players[e.player];
        if (seen(q)) {
          effects.warp(e.from);
          effects.warp(e.to);
        }
        sound.warp(camDist(e.to));
        break;
      }
      case 'fire': {
        hops.delete(e.player);   // it shoots from where it stands, so a hop in the air is over
        // Its next shot retires a tank's rangefinder marks.
        pips.forEach((q) => { if (q.sticky && q.owner === e.player) { q.sticky = false; q.until = performance.now() + 600; } });
        if (e.weapon === 'ranger') {
          const p = game.players[e.player];
          ranges.set(e.player, { probes: {}, elev: p.elev, at: [p.x, p.z], wind: [...game.wind] });
        } else ranges.delete(e.player);
        // A volley's shots leave together; their flash and crack are spread a touch.
        const go = () => {
          if (!game || !tanks[e.player]) return;
          if (!seen(game.players[e.player])) return;
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
        if (pr && !shellHidden(pr)) v.push(pr.pos);
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
        if (!v?.probe && owner != null) noteLanding(owner, v?.shot, e.type === 'impact' ? e.pos : null);
        retireShell(e.id, e.type === 'impact' ? e.pos : null);
        if (e.type === 'lost' && !v?.probe && game.phase !== 'aim' && (heroId == null || owner === heroId)) banner(game.isles ? 'Lost in the void' : 'Out of the arena', '', 900);
        break;
      }
      case 'explosion':
        recentBlasts.push(e);
        effects.explosion(e.pos, e.radius);
        sound.explode(e.radius, camDist(e.pos));
        birds.scare(e.pos, 90 + e.radius * 5);
        addShake(e.pos, e.radius / 6);
        break;
      case 'scout':
        scoutPulse(e);
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
        if (BUILDINGS[e.kind]) {
          const big = e.how === 'ruin' ? 1 : e.how === 'hit' ? 0.6 : 0.4;
          effects.dust(e.pos, 7 * big);
          effects.rubble(e.pos, Math.round(18 * big), 6 * big);
          sound.thud(camDist(e.pos));
        }
        else if (e.kind === 'bridge') { effects.dust([e.a[0], e.pos[1], e.a[1]], 5); effects.dust(e.pos, 7); effects.dust([e.b[0], e.pos[1], e.b[1]], 5); sound.thud(camDist(e.pos)); }
        break;
      case 'damage': {
        if (seen(game.players[e.player])) popDamage(e.player, e.amount);
        { const v = game.players[e.player]; sound.hit(camDist([v.x, v.y, v.z])); }
        if (insetFor === e.player) flashInset(e.amount);
        // Name the victim on the shooter's pip.
        const pip = e.by != null && e.by !== e.player && [...pips].reverse().find((q) => q.owner === e.by && performance.now() - q.born < 3000);
        if (pip) pip.el.querySelector('span').textContent = `${game.players[e.by].name} hit ${e.player === heroId ? 'you' : game.players[e.player].name}`;
        break;
      }
      case 'void': {
        const q = game.players[e.player];
        banner(`${q.id === heroId ? 'You' : q.name} fell into the void`, '', 1800);
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
        // Thrown away from the nearest blast that reached it this frame, if any.
        let blast = null, near = Infinity;
        for (const b of recentBlasts) {
          const d = Math.hypot(b.pos[0] - p.x, b.pos[1] - p.y, b.pos[2] - p.z) - b.radius;
          if (d < near) { near = d; blast = b; }
        }
        if (near > 6) blast = null;
        const w = new Wreck(scene, tanks[e.player], blast, effects, (x, z) => game.terrain.heightAt(x, z));
        w.onLand = (at, heavy) => sound.thud(camDist([at.x, at.y, at.z]) * (heavy ? 1 : 1.6), 'wreck');
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
  flushDirty();
}

// Craters of one frame (a Flak burst is fourteen) are merged where they overlap
// and the mesh is rebuilt once over each merged box, not once per blast. The
// ground in the core is already final when they are drained, so nothing is lost.
const dirty = [];
function addDirty(r) {
  let box = { ...r };
  for (let k = dirty.length - 1; k >= 0; k--) {
    const d = dirty[k];
    if (d.i0 > box.i1 || d.i1 < box.i0 || d.j0 > box.j1 || d.j1 < box.j0) continue;
    box = { i0: Math.min(d.i0, box.i0), i1: Math.max(d.i1, box.i1), j0: Math.min(d.j0, box.j0), j1: Math.max(d.j1, box.j1) };
    dirty.splice(k, 1);
    k = dirty.length;   // the grown box may now reach ones it missed
  }
  dirty.push(box);
}

function flushDirty() {
  for (const r of dirty) { terrainMesh.updateRegion(r); terrainMesh.scuffPaths(r); }
  dirty.length = 0;
}

// ---------------------------------------------------------------- jump jets

const JUMP_NOTES = { nojets: 'No jump jets left', edge: 'Edge of the arena', water: 'Water ahead', blocked: 'No room to land that way' };

// J: use a charge. The core has already moved the tank; this draws the arc.
function doJump() {
  const p = game.current;
  if (!p || p.ai || game.phase !== 'aim' || hops.has(p.id)) return;
  const r = game.jump();
  const why = r === 'edge' && game.isles ? 'No ground to land on' : JUMP_NOTES[r];
  if (why) driveNote = { text: why, until: performance.now() + 1400 };
}

function startHop(e) {
  hops.set(e.player, { from: e.from, to: e.to, t: 0, dur: e.flight || JET.flight, puff: 0 });
  if (!seen(game.players[e.player])) return;
  effects.dust(e.from, 5);
  effects.jetFlame({ x: e.from[0], y: e.from[1] + 0.5, z: e.from[2] });
  sound.jet(camDist(e.from));
  addShake(e.from, 0.4);
}

// Each frame, put the hopping tanks along their arcs (over what `sync` just did).
function updateHops(dt) {
  for (const [id, h] of hops) {
    const t = tanks[id];
    h.t += dt;
    const s = Math.min(1, h.t / h.dur);
    const lerp = (a, b) => a + (b - a) * s;
    const x = lerp(h.from[0], h.to[0]);
    const z = lerp(h.from[2], h.to[2]);
    const y = lerp(h.from[1], h.to[1]) + 4 * JET.apex * s * (1 - s);
    t.root.position.set(x, y, z);
    if (s < 0.6 && (h.puff -= dt) <= 0 && seen(game.players[id])) {
      h.puff = 0.04;
      effects.jetFlame({ x, y: y + 0.3, z });
    }
    if (s >= 1) {
      hops.delete(id);
      if (seen(game.players[id])) {
        effects.dust(h.to, 6);
        effects.dust(h.to, 9);
        sound.thud(camDist(h.to));
        addShake(h.to, 0.7);
      }
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
  $('handoff-text').textContent = `Everyone else, look away. Drive and aim as you like, then ${touch ? 'tap Lock in' : 'press Space to lock it in'}. Nobody fires until every tank is ready.`;
  $('handoff').classList.remove('hidden');
}

function closeHandoff() {
  if (!handoffOpen) return;
  handoffOpen = false;
  $('handoff').classList.add('hidden');
}
$('handoff-go').onclick = () => { sound.click(); closeHandoff(); };
$('gunner-btn').onclick = (e) => { e.currentTarget.blur(); sound.click(); toggleGunner(); };   // blur: Space must fire, not press it again

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
    for (const box of hudBoxes) {
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
  if (el._edge !== s.off) { el._edge = s.off; el.classList.toggle('edge', s.off); }
  moveTo(el, s.sx, s.sy, CENTRE);
  if (s.off) {
    const a = `${s.angle}rad`;
    if (el._a !== a) { el._a = a; el.style.setProperty('--a', a); }
  }
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
    setDisplay(q.el, hide ? 'none' : '');
    if (q.beam) {
      // Fade a beam the camera is right beside: up close it is a wall, not a marker.
      const near = Math.min(1, Math.max(0.12, (Math.hypot(camera.position.x - q.pos[0], camera.position.z - q.pos[2]) - 25) / 90));
      q.beam.visible = !hide;
      q.beam.material.opacity = 0.5 * near * Math.min(1, left / 1.2);
    }
    if (hide) continue;
    setStyle(q.el, 'opacity', Math.min(1, left / 1.2));
    const s = screenSpot(q.pos[0], q.pos[1] + 1, q.pos[2]);
    if (s.off) unstack(s, placed);
    place(q.el, s);
    // Marks that land close together (a rangefinder's always do from afar):
    // the dots stay put and their names stack downward.
    const span = q.el.lastElementChild;
    const w = (q.w ||= span.offsetWidth || 60) / 2 + 4;
    let top = 14;
    while (top < 100 && labels.some(([x, y, hw]) => Math.abs(x - s.sx) < hw + w && Math.abs(y - (s.sy + top)) < 13)) top += 13;
    setStyle(span, 'top', `${top}px`);
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
    const b = me && p !== me && p.alive ? believed(p) : null;
    const s = b ? screenSpot(b.x, b.y + 4, b.z) : null;
    if (!s || !s.off) { setDisplay(el, 'none'); return; }
    setDisplay(el, '');
    unstack(s, placed);
    place(el, s);
    setText(el._small || (el._small = el.querySelector('small')), `${b.r ? '~' : ''}${Math.round(Math.hypot(b.x - me.x, b.z - me.z))} m`);
  });
}

// A three-second look at another tank; the camera then drifts back.
function peekAt(p) {
  if (!game || game.phase !== 'aim' || !p.alive || p === game.current) { peek = null; return; }
  if (!seen(p)) { const b = believed(p); if (b) peekSpot([b.x, b.y, b.z]); return; }
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
  const where = (p) => believed(p) || { x: 1e6, z: 1e6 };
  const foes = game.players.filter((p) => p.alive && p !== me && believed(p))
    .sort((a, b) => Math.hypot(where(a).x - me.x, where(a).z - me.z) - Math.hypot(where(b).x - me.x, where(b).z - me.z));
  if (!foes.length) return;
  const at = peek && performance.now() < peek.until ? foes.findIndex((p) => p.id === (peek.id ?? peek.fogId)) : -1;
  const next = foes[(at + 1) % foes.length];
  peekAt(next);
  if (peek && peek.id == null) peek.fogId = next.id;
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
  return game.localHumans.length === 1 ? game.localHumans[0] : null;
}

let rcSpot = null;              // where a click on the card looks
$('range-card').addEventListener('click', () => rcSpot && peekSpot(rcSpot));

const signed = (v, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

// The card only changes when something it shows does, so it remembers what it last
// drew (rcKey) and skips the canvas and the text until that differs.
let rcKey = '';
let rcDims = null;              // the plot canvas's CSS size; null until read, and after a resize
window.addEventListener('resize', () => { rcDims = null; });

function updateRangeCard() {
  const me = rangeOwner();
  const r = me && ranges.get(me.id);
  const a = r?.probes.aim;
  const card = $('range-card');
  card.classList.toggle('hidden', !a);
  if (!a) { rcSpot = null; rcKey = ''; rcDims = null; return; }
  rcSpot = a.pos;

  const cv = $('rc-plot');
  const dpr = window.devicePixelRatio || 1;
  if (!rcDims || !rcDims[0]) rcDims = [cv.clientWidth, cv.clientHeight];   // a layout read, so only when needed
  const [W, H] = rcDims;
  const foe = game.players.filter((p) => p.alive && p !== me).map(believed).filter(Boolean)
    .sort((p, q) => Math.hypot(p.x - a.pos[0], p.z - a.pos[2]) - Math.hypot(q.x - a.pos[0], q.z - a.pos[2]))[0];
  // The three reasons the estimate is "rough" are thresholds, so the key holds the verdicts, not the raw numbers.
  const moved = Math.hypot(me.x - r.at[0], me.z - r.at[1]) > 4;
  const elevOff = Math.abs(me.elev - r.elev) > 0.05;
  const windOff = Math.hypot(game.wind[0] - r.wind[0], game.wind[1] - r.wind[1]) > 0.6;
  let key = `${me.id}|${me.weapon}|${W}x${H}@${dpr}|${r.at[0]},${r.at[1]}|${r.elev}|${moved}${elevOff}${windOff}|${foe ? `${foe.x},${foe.y},${foe.z}` : '-'}`;
  for (const k in r.probes) { const pb = r.probes[k]; key += `|${k}:${pb.pos[0]},${pb.pos[1]},${pb.pos[2]},${pb.yaw},${pb.power}`; }
  if (key === rcKey) return;
  rcKey = key;

  const ax = rangeAxes(a.yaw);
  const pts = Object.entries(r.probes).map(([key, pb]) => ({ key, pb, ...toRange(ax, a.pos, pb.pos) }));
  const t = foe ? toRange(ax, a.pos, [foe.x, foe.y, foe.z]) : null;
  const w = WEAPON_BY_ID[me.weapon];
  const blast = (w?.impact.find((i) => i.type === 'blast') || WEAPON_BY_ID.shell.impact[0]).radius;

  // ---- plot
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
  if (!t) { setText($('rc-read'), 'No enemy left to range on.'); $('rc-est').textContent = ''; $('rc-est')._html = null; return; }
  const off = Math.hypot(t.side, t.along);
  setText($('rc-read'), off <= blast * 0.8 ? `As aimed: on ${foe.name}`
    : `As aimed: ${Math.round(Math.abs(t.along))} m ${t.along > 0 ? 'short' : 'long'}, ${Math.round(Math.abs(t.side))} m ${t.side > 0 ? 'left' : 'right'} of ${foe.name}`);
  const est = solveAim(r.probes, [foe.x, foe.y, foe.z]);
  const notes = [];
  if (moved) notes.push('you have moved');
  if (elevOff) notes.push(`probed at ${r.elev.toFixed(1)}° elevation`);
  if (windOff) notes.push('the wind has shifted');
  const note = notes.length ? `<small>Rough: ${notes.join(', ')}.</small>` : '';
  let html;
  if (!est || Math.abs(est.dYaw) > 25 || Math.abs(est.dPower) > 35) {
    html = `Too far off to estimate: aim again and probe.${note}`;
  } else if (est.power > TANK.maxPower || est.power < TANK.minPower) {
    html = `Needs power ${est.power.toFixed(0)}: change the elevation.${note}`;
  } else {
    html = `Try turret ${est.yaw.toFixed(1)}° (${signed(est.dYaw)}), power ${est.power.toFixed(1)} (${signed(est.dPower)})${note}`;
  }
  const estEl = $('rc-est');
  if (estEl._html !== html) { estEl._html = html; estEl.innerHTML = html; }
}


// ---------------------------------------------------------------- steering

// A / D (or the side arrows) turn every human's guided missile while it flies.
// On a shared screen they all answer the same keys; with one human, only yours.
function applySteering() {
  if (!game || game.phase !== 'flight') { $('steer-hint').classList.add('hidden'); return; }
  const dir = (held.has('d') || held.has('arrowright') ? 1 : 0) - (held.has('a') || held.has('arrowleft') ? 1 : 0);
  let fuel = -1;
  for (const p of game.localHumans) {
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
let killCam = null; let lastDt = 0;             // { id, victim, side: [x, z], end }
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

function updateKillCam(dt) {
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
  // Ease into the slow motion over a few tenths of a second and back out more
  // gently, on the real clock so it feels the same at any frame rate.
  const goal = killCam && killCam.end == null ? KILLCAM.slow : killCam ? 0.55 : 1;
  const tau = goal < timeScale ? 0.22 : 0.45;
  timeScale += (goal - timeScale) * (1 - Math.exp(-dt / tau));
  if (Math.abs(goal - timeScale) < 0.002) timeScale = goal;
}

// Camera for the kill cam: off to the side, low, looking at the target with
// the shell coming in.
function killCamView() {
  const v = game.players[killCam.victim];
  const pr = game.projectiles.find((q) => q.id === killCam.id);
  // Look between the target and the incoming shell; once it has landed, let
  // the pull fade instead of snapping back onto the tank.
  if (pr) { const s = shellPos(pr); killCam.shell = [s[0], s[1], s[2]]; }
  const pull = killCam.pull = pr ? 0.3 : (killCam.pull ?? 0) * Math.exp(-lastDt * 3);
  camTarget.set(v.x, v.y + 3, v.z);
  if (killCam.shell && pull > 0.001) camTarget.lerp(_v.set(...killCam.shell), pull);
  const [sx, sz] = killCam.side, [dx, dz] = killCam.dir;
  // camGoal is an offset from the target.
  camGoal = _killGoal.set(sx * 40 - dx * 16 + (v.x - camTarget.x), 24, sz * 40 - dz * 16 + (v.z - camTarget.z));
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
  const hs = game.localHumans;
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
  touch?.buzz([40, 30, 70]);
}

function popDamage(pid, amount) {
  const p = game.players[pid];
  const v = _lblV.set(p.x, p.y + 6, p.z).project(camera);
  if (v.z > 1) return;
  const el = document.createElement('div');
  el.className = 'dmg-pop';
  el.textContent = `-${Math.round(amount)}`;
  el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
  el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
  $('labels').appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// ---------------------------------------------------------------- the sight

// The tank this screen is planning a shot for, or null.
function planning() {
  if (!game || handoffOpen || game.phase !== 'aim') return null;
  const p = game.current;
  return p && p.alive && game.isLocal(p) ? p : null;
}

// The sight drives the camera only while you plan; it comes back each turn.
function gunnerFor() {
  return gunner.on && !overview && !pinned && !killCam ? planning() : null;
}

function toggleGunner() {
  gunner.on = !gunner.on;
  $('gunner-btn')?.classList.toggle('on', gunner.on);
  document.querySelector('#touch [data-key=g]')?.classList.toggle('on', gunner.on);
  if (gunner.on) overview = false;
  banner(gunner.on ? 'Sight on' : 'Sight off', gunner.on ? (touch ? 'drag to aim, pinch to zoom' : 'drag to aim, wheel to zoom') : '', 900);
}

// Hand the camera back to the orbit controls from wherever the sight left it,
// looking the same way, so nothing jumps.
function leaveGunner() {
  gunner.active = false;
  gunner.hide();
  controls.enabled = true;
  camera.fov = 55;
  camera.updateProjectionMatrix();
  controls.target.copy(camera.position).add(_v.set(0, 0, -100).applyQuaternion(camera.quaternion));
}

// Where a tank's shot came down, kept for its next turn. Only the first
// landing of each shot counts (a cluster's bomblets follow it down).
function noteLanding(owner, shot, pos) {
  const was = lastLand.get(owner);
  if (was && was.shot === shot) return;
  const p = game.players[owner];
  lastLand.set(owner, { shot, pos: pos && [...pos], at: [p.x, p.z] });
}

// "Last shot: 32 m short, 6 m right of Rook", in the shooter's own frame:
// along the line from it to the enemy nearest the landing.
function lastShotText(p) {
  const l = lastLand.get(p.id);
  if (!l) return '';
  if (Math.hypot(p.x - l.at[0], p.z - l.at[1]) > 4) return '';     // moved since: it no longer says much
  if (!l.pos) return `Last shot: ${game.isles ? 'lost in the void' : 'out of the arena'}`;
  let best = null;
  for (const q of game.players) {
    if (q === p || !q.alive) continue;
    const b = believed(q);
    if (!b) continue;
    const d = Math.hypot(b.x - l.pos[0], b.z - l.pos[2]);
    if (!best || d < best.d) best = { b, d };
  }
  if (!best) return '';
  const { b } = best;
  const L = Math.hypot(b.x - p.x, b.z - p.z) || 1;
  const fx = (b.x - p.x) / L, fz = (b.z - p.z) / L;
  const ex = l.pos[0] - b.x, ez = l.pos[2] - b.z;
  const along = ex * fx + ez * fz;       // + long, - short
  const side = -ex * fz + ez * fx;       // + right, - left (yaw grows to the right)
  if (Math.hypot(along, side) < 4) return `Last shot: on ${b.name}`;
  const parts = [];
  if (Math.abs(along) >= 2) parts.push(`${Math.round(Math.abs(along))} m ${along < 0 ? 'short' : 'long'}`);
  if (Math.abs(side) >= 2) parts.push(`${Math.round(Math.abs(side))} m ${side < 0 ? 'left' : 'right'}`);
  return `Last shot: ${parts.join(', ')} of ${b.name}`;
}

function updateAimAids() {
  const p = planning();
  aimArc.update(game, p, camera);
  if (!gunner.active || !p) { gunner.hide(); return; }
  const enemies = [];
  for (const q of game.players) {
    if (q === p || !q.alive) continue;
    const b = believed(q);
    if (b) enemies.push({ name: b.r > 0 ? `${q.name}?` : q.name, color: q.color, x: b.x, y: b.y, z: b.z });
  }
  gunner.hud(camera, p, enemies, lastShotText(p));
}

// In the sight, a drag aims: across turns the turret by as much as the view
// moves under the finger, up and down raises the barrel. Wheel or pinch zooms.
const aimDrag = new Map();     // pointer id -> last [x, y]
renderer.domElement.addEventListener('pointerdown', (e) => { if (gunner.active) aimDrag.set(e.pointerId, [e.clientX, e.clientY]); });
renderer.domElement.addEventListener('pointermove', (e) => {
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
    game.adjustAim((now[0] - was[0]) * perPx, -(now[1] - was[1]) * perPx * 0.5, 0);
  }
  aimDrag.set(e.pointerId, now);
});
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => aimDrag.delete(e.pointerId));
renderer.domElement.addEventListener('wheel', (e) => { if (gunner.active) gunner.zoom(Math.sign(e.deltaY)); }, { passive: true });

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
  const gp = gunnerFor();
  if (gp) {
    if (!gunner.active) { controls.enabled = false; camGoal = null; }
    gunner.pose(camera, gp, game.terrain, dt);
    lastShake.set(0, 0, 0);
    return;
  }
  if (gunner.active) leaveGunner();
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
        mine.forEach((pr) => camTarget.add(_v.fromArray(shellPos(pr))));
        camTarget.divideScalar(mine.length);
      }
    } else if (game.volleyMode && followShell && (game.phase === 'volley' || (game.phase === 'flight' && game.projectiles.length))) {
      // A shared-screen volley: stand back far enough to see every shell (or, in the beat
      // before, every tank about to fire).
      _box.makeEmpty();
      if (game.phase === 'volley') game.players.forEach((p) => { if (p.alive && seen(p)) _box.expandByPoint(_v.set(p.x, p.y, p.z)); });
      else game.projectiles.forEach((pr) => { if (!shellHidden(pr)) _box.expandByPoint(_v.set(pr.pos[0], pr.pos[1], pr.pos[2])); });
      if (_box.isEmpty()) _box.expandByPoint(controls.target);
      _box.getCenter(camTarget);
      frame = Math.min(1300, Math.max(130, (_box.getSize(_v).length() * 0.62) / Math.tan((camera.fov * DEG) / 2)));
      camGoal = null;
    } else if (game.phase === 'flight' && followShell && game.projectiles.some((pr) => !shellHidden(pr))) {
      let n = 0;
      _shellC.set(0, 0, 0);
      for (const pr of game.projectiles) {
        if (shellHidden(pr)) continue;
        _shellC.add(_v.fromArray(shellPos(pr)));
        n++;
      }
      camTarget.copy(_shellC.divideScalar(n));
    } else if (game.phase === 'aim' && game.current) {
      const look = peek && performance.now() < peek.until ? (peek.id != null ? game.players[peek.id] : peek) : null;
      if (!look) peek = null;
      const p = look || (seen(game.current) ? game.current : fogFor?.[0] || game.current);
      camTarget.set(p.x, p.y + 4, p.z);
      // Left far out (e.g. by the volley framing) with nobody steering: come back in.
      if (!look && !camGoal && !userCam && camera.position.distanceTo(controls.target) > 300) aimCameraAt(p);
    }
  }
  _camBefore.copy(controls.target);
  controls.target.lerp(camTarget, 1 - Math.exp(-dt * 3.2));
  camera.position.add(_camDelta.copy(controls.target).sub(_camBefore));
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
// A tap (one finger, short, hardly moving) aims on a touch screen; see tapAim.
let tapFrom = null;
const pointers = new Set();
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragFrom = [e.clientX, e.clientY];
  pointers.add(e.pointerId);
  tapFrom = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (dragFrom && Math.hypot(e.clientX - dragFrom[0], e.clientY - dragFrom[1]) > 4) { camGoal = null; dragFrom = null; userCam = true; }
  if (tapFrom && Math.hypot(e.clientX - tapFrom.x, e.clientY - tapFrom.y) > 10) tapFrom = null;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (touch && tapFrom && performance.now() - tapFrom.t < 350) tapAim(e.clientX, e.clientY);
  tapFrom = null;
});
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => { dragFrom = null; pointers.delete(e.pointerId); });

// Touch: tap the ground or a tank to turn the turret toward it, so the first
// shot does not start with a long drag round on the pad. Bearing only.
const tapRay = new THREE.Raycaster(), tapNdc = new THREE.Vector2();
function tapAim(cx, cy) {
  const p = game?.current;
  if (!p || p.ai || handoffOpen || game.phase !== 'aim') return;
  const r = renderer.domElement.getBoundingClientRect();
  tapNdc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  tapRay.setFromCamera(tapNdc, camera);
  const o = tapRay.ray.origin.toArray(), d = tapRay.ray.direction.toArray();
  const tank = tankHit(o, d, game.players.filter((q) => q !== p && q.alive && seen(q)));
  const t = game.terrain;
  const spot = tank ? [tank.x, tank.y, tank.z] : groundHit(o, d, (x, z) => t.heightAt(x, z), (x, z) => t.inBounds(x, z));
  if (!spot || Math.hypot(spot[0] - p.x, spot[2] - p.z) < 15) return;   // the sky, or your own tank
  game.adjustAim(((bearingTo(p, spot[0], spot[2]) - p.yaw + 540) % 360) - 180, 0, 0);
  sound.click();
  touch.buzz(10);
  touch.note(tank ? `Turret on ${tank.name}` : 'Turret turned there');
}
renderer.domElement.addEventListener('wheel', () => { camGoal = null; userCam = true; }, { passive: true });

// ---------------------------------------------------------------- input

const held = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (session && e.key === 'Enter' && !handoffOpen) { e.preventDefault(); openChat(); return; }
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
  else if (k === 'j') doJump();
  else if (k === 'f') peekNext();
  else if (k === 'g') toggleGunner();
  else if (k === 'c') { followShell = !followShell; banner(followShell ? 'Follow cam on' : 'Follow cam off', '', 700); }
  else if (k === 'v') {
    overview = !overview;
    if (overview) camGoal = new THREE.Vector3(0, 610, 520);
    else if (game.current) aimCameraAt(game.current);
  } else if (k === 'm') toggleMute();
  else if (k === '-' || k === '=' || k === '+') setVolume(sound.volume + (k === '-' ? -0.1 : 0.1), true);
  else if (k === 'n') { sound.ensure(); const t = music.next(); settings.render(); banner(`Music: ${t.name}`, t.mood || '', 900); }
});

// Master level, from - / =.
function setVolume(v, announce = false) {
  sound.ensure();
  sound.setVolume(Math.round(v * 10) / 10);
  settings.render();
  if (announce) banner(`Volume ${Math.round(sound.volume * 100)}%`, '', 700);
}
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());
window.addEventListener('pointerdown', () => sound.ensure(), { once: true });
// On-screen controls on phones and tablets (or ?mobile=1): they press the same keys and feed the same aim.
const touch = wantTouch() ? new TouchControls({ parent: $('hud'), unlockAudio: () => sound.ensure(), weaponBar: $('weapon-bar'), online: () => !!session }) : null;
if (touch) {
  // The left column is full on a phone, so the players box sits top right.
  $('hud').appendChild($('scoreboard'));
  // No keyboard here: the hints say what to tap instead.
  $('steer-hint').querySelector('b').textContent = '\u25C0 \u25B6';
  $('chat-input').placeholder = 'Say something';
}

function toggleMute() {
  sound.ensure();
  banner(sound.toggleMute() ? 'Muted' : 'Sound on', '', 700);
  settings.render();
}

// Settings (the gear): the three sound levels and the music track, full screen,
// and the resource packs where they are served (added with the packs, below).
const settings = new Settings({ parent: document.body });
const keys = (s) => (touch ? '' : s);
settings.group('sound', 'Sound', `Master sits under your device's volume, which still sets the overall level.${keys(' M mutes all, - / = set Master.')}`);
settings.level({ id: 'master', label: 'Master', group: 'sound', get: () => sound.volume, muted: () => sound.muted,
  set: (v) => { sound.ensure(); sound.setVolume(v); }, toggle: () => { sound.ensure(); sound.toggleMute(); } });
settings.level({ id: 'fx', label: 'Effects', group: 'sound', get: () => sound.fxVolume, muted: () => sound.fxMuted,
  set: (v) => { sound.ensure(); sound.setFxVolume(v); }, toggle: () => { sound.ensure(); sound.toggleFx(); } });
settings.level({ id: 'music', label: 'Music', group: 'sound', get: () => music.volume, muted: () => music.muted,
  set: (v) => { sound.ensure(); music.setVolume(v); }, toggle: () => { sound.ensure(); music.toggleMute(); } });
settings.choice({ id: 'track', label: `Track${keys(' (N)')}`, group: 'sound', options: TRACKS.map((t) => ({ value: t.id, text: t.name })),
  get: () => music.trackId, set: (id) => { sound.ensure(); music.select(id); } });
settings.group('more', 'Screen and tools');
if (canFullscreen()) settings.add({ id: 'full', group: 'more', label: () => (isFullscreen() ? 'Leave full screen' : 'Full screen'), run: toggleFullscreen });

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

const holding = { x: 0, y: 0, p: 0 };   // seconds each aim axis has been held
function holdRamp(axis, on, dt) {
  const t = holding[axis] = on ? holding[axis] + dt : 0;
  return t < 0.12 ? 0.25 : Math.min(1, 0.25 + (t - 0.12) * 3);
}

function applyHeldKeys(dt) {
  const live = game && !handoffOpen && game.phase === 'aim' && game.current && !game.current.ai;
  const pad = touch?.take(dt, live ? game.current : null);   // touch aim pad and power strip
  if (!live) return;
  if (pad) game.adjustAim(pad.yaw, pad.elev, pad.power);
  const ax = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
  const ay = (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0);
  const ap = (held.has('e') || held.has('pageup') ? 1 : 0) - (held.has('q') || held.has('pagedown') ? 1 : 0);
  // A short tap moves a little (fine); holding ramps up to full speed in about
  // a third of a second; Shift is three times as fast, for the big turns.
  const fast = held.has('shift') ? 3 : 1;
  const kx = holdRamp('x', ax, dt) * fast, ky = holdRamp('y', ay, dt) * fast, kp = holdRamp('p', ap, dt) * fast;
  if (ax || ay || ap) game.adjustAim(ax * TANK.turretSpeed * dt * kx, ay * TANK.elevationSpeed * dt * ky, ap * TANK.powerSpeed * dt * kp);
  // The arrow keys drive: up and down along the hull, left and right swing it.
  const go = (held.has('arrowup') ? 1 : 0) - (held.has('arrowdown') ? 1 : 0);
  const turn = (held.has('arrowright') ? 1 : 0) - (held.has('arrowleft') ? 1 : 0);
  if ((go || turn) && !hops.has(game.current.id)) {
    // Driving with the camera far away (or zoomed right out) brings it back to the tank.
    if (!camGoal && !overview && !pinned && camera.position.distanceTo(controls.target) > 260) aimCameraAt(game.current);
    const r = game.drive(go, turn, dt);
    const why = r === 'edge' && game.isles ? 'Edge of the isle' : DRIVE_NOTES[r];
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
    if (!p.alive || !seen(p)) return;
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

const sbRows = new Map();       // player id -> the scoreboard row and the bits of it that change
function buildScoreboard() {
  $('scoreboard').innerHTML = game.players.map((p) => `
    <div class="sb-row" id="sb-${p.id}" data-id="${p.id}" title="Click to look at ${escapeHtml(p.name)}">
      <span class="swatch" style="background:${p.color}"></span>
      <span style="width:74px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name)}</span>
      <div class="bar"><div class="fill hp"></div></div>
      <span class="wins"></span>
      <div class="sb-perks"></div>
    </div>`).join('');
  sbRows.clear();
  $('scoreboard').querySelectorAll('.sb-row').forEach((row) => {
    row.onclick = () => game && peekAt(game.players[Number(row.dataset.id)]);
    sbRows.set(Number(row.dataset.id), { row, fill: row.querySelector('.fill'), wins: row.querySelector('.wins'), perks: row.querySelector('.sb-perks') });
  });
}

const perkChip = (id, long) => `<span class="perk" title="${escapeHtml(PERK_BY_ID[id].desc)}">${long ? PERK_BY_ID[id].name : PERK_BY_ID[id].tag}</span>`;
function setPerks(el, p, long) {
  const key = p.id + p.perks.join();
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = p.perks.map((id) => perkChip(id, long)).join('');
}

// The HUD's fixed elements, looked up once.
let hudEls = null;
const HUD_IDS = ['pc-swatch', 'pc-name', 'pc-tag', 'pc-hp', 'pc-armor', 'pc-money', 'pc-fuel', 'ro-fuel', 'pc-note', 'pc-perks', 'ro-yaw', 'ro-elev',
  'ro-power', 'ro-jets', 'pc-power', 'last-yaw', 'last-elev', 'last-power', 'ro-weapon', 'ro-ammo', 'wind-arrow', 'wind-speed', 'wind-aim', 'round-label', 'round-mod', 'round-desc'];

function updateHud() {
  if (!hudEls) { hudEls = {}; for (const id of HUD_IDS) hudEls[id] = $(id); }
  const E = hudEls;
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
    setText(E['ro-fuel'], `${Math.floor(p.fuel + 0.05)} m`);
    setText(E['ro-jets'], `${p.jets > 0 ? 'J ' : ''}×${p.jets}`);
    if (E['ro-jets'].classList.contains('none') !== !(p.jets > 0)) E['ro-jets'].classList.toggle('none', !(p.jets > 0));
    const noting = performance.now() < driveNote.until && game.phase === 'aim' && !p.ai;
    setText(E['pc-note'], noting ? driveNote.text : '');
    setPerks(E['pc-perks'], p, true);
    setText(E['ro-yaw'], `${p.yaw.toFixed(1)}°`);
    setText(E['ro-elev'], `${p.elev.toFixed(1)}°`);
    setText(E['ro-power'], p.power.toFixed(1));
    setStyle(E['pc-power'], 'width', `${((p.power - TANK.minPower) / (TANK.maxPower - TANK.minPower)) * 100}%`);
    // Under each: what the last shot used, and how far the aim is from it now.
    const last = p.ai ? null : p.shots[p.shots.length - 1];
    const was = (el, then, now, unit, wrap) => {
      let text = p.ai ? '' : '—';
      if (last) {
        const d = wrap ? ((now - then + 540) % 360) - 180 : now - then;
        const delta = Math.abs(d) < 0.05 ? 'same' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
        text = `last ${then.toFixed(1)}${unit}<b>${delta}</b>`;
      }
      if (el.dataset.t !== text) { el.dataset.t = text; el.innerHTML = text; }
    };
    was(E['last-yaw'], last?.yaw, p.yaw, '°', true);
    was(E['last-elev'], last?.elev, p.elev, '°', false);
    was(E['last-power'], last?.power, p.power, '', false);
    const w = WEAPON_BY_ID[p.weapon];
    setText(E['ro-weapon'], w.name);
    setText(E['ro-ammo'], ammoText(p.inventory[w.id]));
    updateWeaponBar(p);
  }
  // Wind, drawn from behind the turret of the tank on the card (up is the way
  // it aims, so the arrow holds still while the camera orbits), and split into
  // what it does to that shot: sideways, and longer or shorter.
  const [wx, wz] = game.wind;
  const mag = Math.hypot(wx, wz);
  const wp = game.current || game.localHumans?.[0] || game.players[0];
  const yaw = (wp ? wp.yaw : 0) * DEG;
  const along = (wx * Math.cos(yaw) + wz * Math.sin(yaw)) * 10;
  const side = (-wx * Math.sin(yaw) + wz * Math.cos(yaw)) * 10;
  const rel = Math.atan2(side, along);
  const arrow = `rotate(${Math.round((rel / DEG - 90) * 2) / 2}deg)`;
  setStyle(E['wind-arrow'], 'transform', arrow);
  setStyle(E['wind-arrow'], 'opacity', mag < 0.05 ? 0.2 : 1);
  setText(E['wind-speed'], mag < 0.05 ? 'calm' : (mag * 10).toFixed(0));
  const parts = [];
  if (Math.abs(side) >= 0.5) parts.push(`${Math.abs(side).toFixed(0)} ${side > 0 ? 'right' : 'left'}`);
  if (Math.abs(along) >= 0.5) parts.push(`${Math.abs(along).toFixed(0)} ${along > 0 ? 'longer' : 'shorter'}`);
  const aimText = mag < 0.05 ? '' : parts.join(' · ');
  setText(E['wind-aim'], aimText);
  for (const q of game.players) {
    const ref = sbRows.get(q.id);
    if (!ref) continue;
    const alive = q.alive, active = game.current === q;
    if (ref.alive !== alive) { ref.alive = alive; ref.row.classList.toggle('dead', !alive); }
    if (ref.active !== active) { ref.active = active; ref.row.classList.toggle('active', active); }
    setStyle(ref.fill, 'width', `${(q.hp / q.maxHp) * 100}%`);
    setText(ref.wins, '★'.repeat(Math.min(q.wins, 3)) + (q.wins > 3 ? q.wins : ''));
    setPerks(ref.perks, q, false);
  }
  const mod = game.modifier;
  // The round and its modifier head the card.
  setText(E['round-label'], `Round ${game.round} / ${game.cfg.rounds}`);
  setText(E['round-mod'], mod.id === 'clear' ? '' : mod.name);
  setText(E['round-desc'], mod.id === 'clear' ? '' : mod.desc);
}

function updateLabels() {
  game.players.forEach((p, i) => {
    const el = labels[i];
    const v = _lblV.set(p.x, p.y + 8, p.z).project(camera);
    const visible = p.alive && seen(p) && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1
      && !(gunner.active && p === game.current);   // in the sight your own label would sit on the turret line
    setDisplay(el, visible ? 'block' : 'none');
    if (!visible) return;
    moveTo(el, (v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight, ABOVE);
    setStyle(el._fill || (el._fill = el.querySelector('.fill')), 'width', `${(p.hp / p.maxHp) * 100}%`);
  });
}

// ---------------------------------------------------------------- fog of war

const RING = new THREE.RingGeometry(0.92, 1, 56);

// The tanks this screen sees for: the human planning here, or every human
// played here who is still in it. Null (see everything) without fog, or once
// nobody is left on this screen to see for.
function fogView() {
  if (!game || !game.cfg.fog) return null;
  const c = game.current;
  if (c && game.phase === 'aim' && game.isLocal(c) && c.alive) return [c];
  const mine = game.localHumans.filter((p) => p.alive);
  return mine.length ? mine : null;
}

// Can this screen see tank `p`? Wrecks are always in plain view.
function seen(p, view = fogFor) {
  return !view || !p || !p.alive || view.includes(p) || view.some((v) => game.inSight(v, p));
}

// Where this screen believes `p` is: { x, y, z, r, at } with r the radius of
// doubt (0 when seen or last seen), or null when it has no idea.
function believed(p) {
  if (seen(p)) return { x: p.x, y: p.y, z: p.z, r: 0, at: game.turnsThisRound, live: true, id: p.id, name: p.name, color: p.color };
  let best = null;
  for (const v of fogFor) {
    const i = game.intel[v.id]?.[p.id];
    if (i && (!best || i.at > best.at || (i.at === best.at && i.r < best.r))) best = i;
  }
  if (!best) return null;
  const t = game.terrain;
  return { x: best.x, y: t.inBounds(best.x, best.z) ? t.heightAt(best.x, best.z) : p.y, z: best.z, r: best.r, at: best.at, id: p.id, name: p.name, color: p.color };
}

// A shell from a tank this screen cannot see stays hidden while it climbs,
// so its trail does not lead straight back to it.
function shellHidden(pr) {
  if (!fogFor || seen(game.players[pr.owner])) return false;
  return !pr.roller && pr.vel[1] > 0;
}

function updateFog(dt) {
  fogFor = fogView();
  groundShade.fogOn.value = fogFor ? 1 : 0;
  if (fogFor) {
    const spots = groundShade.fog.value;
    let k = 0;
    for (const v of fogFor) if (k < spots.length) spots[k++].set(v.x, v.z, FOG.sight);
    for (const r of game.reveals) if (k < spots.length && fogFor.some((v) => v.id === r.owner)) spots[k++].set(r.x, r.z, r.r);
    for (; k < spots.length; k++) spots[k].set(0, 0, 0);
  }
  game.players.forEach((p, i) => {
    const show = seen(p);
    if (!show) tanks[i].root.visible = false;
    const g = ghosts[i];
    const b = !show ? believed(p) : null;
    g.ring.visible = !!b;
    if (!b) { setDisplay(g.el, 'none'); return; }
    g.ring.position.set(b.x, b.y + 1.5, b.z);
    g.ring.scale.setScalar(Math.max(8, b.r));
    g.ring.material.opacity = b.r ? 0.4 : 0.6;
    const v = _v.set(b.x, b.y + 7, b.z).project(camera);
    const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    setDisplay(g.el, on ? 'block' : 'none');
    if (!on) return;
    moveTo(g.el, (v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight, ABOVE);
    const ago = game.turnsThisRound - b.at;
    const unit = game.volleyMode ? 'volley' : 'turn';
    const text = (b.r ? 'roughly here' : 'last seen here') + (ago > 0 ? `, ${ago} ${unit}${ago > 1 ? 's' : ''} ago` : '');
    setText(g.small || (g.small = g.el.querySelector('small')), text);
  });
  for (let i = pulses.length - 1; i >= 0; i--) {
    const q = pulses[i];
    q.t += dt;
    const k = Math.min(1, q.t / 1.1);
    q.mesh.scale.setScalar(Math.max(1, q.r * (1 - (1 - k) ** 3)));
    q.mesh.material.opacity = 0.85 * (1 - k * k);
    if (k >= 1) { scene.remove(q.mesh); q.mesh.material.dispose(); pulses.splice(i, 1); }
  }
}

// A scout bursts: a bright ring spreads over what it lights up (for its owner's
// screen; anyone else just sees a flash where it landed).
function scoutPulse(e) {
  effects.muzzleFlash(e.pos);
  sound.ping(camDist(e.pos));
  const mine = !fogFor || fogFor.some((v) => v.id === e.owner);
  if (!mine) return;
  const mesh = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: '#bff3ff', transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 6;
  mesh.position.set(e.pos[0], e.pos[1] + 2, e.pos[2]);
  scene.add(mesh);
  pulses.push({ mesh, r: e.radius, t: 0 });
  if (game.volleyMode ? heroId === e.owner || heroId == null : true) banner('Scouted', 'Everything nearby is lit up for your next two shots', 1300);
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
  if (session && !session.game) { renderLobby(); return; }
  document.body.classList.remove('net-lobby', 'net-guest');
  $('start').textContent = 'Start match';
  $('opt-firing').disabled = false;
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
  if (session && !session.game) {
    if (lobbySeats().length + lobbyCpus().length >= 6) return;
    setupRows.push({ name: CPU_NAMES[(lobbyCpus().length + 1) % CPU_NAMES.length], type: 'normal' });
    renderSetup();
    return;
  }
  if (setupRows.length >= 6) return;
  setupRows.push({ name: CPU_NAMES[setupRows.length % CPU_NAMES.length], type: 'normal' });
  renderSetup();
};
$('remove-player').onclick = () => {
  if (session && !session.game) {
    const i = setupRows.map((r) => r.type !== 'human').lastIndexOf(true);
    if (i >= 0) { setupRows.splice(i, 1); renderSetup(); }
    return;
  }
  if (setupRows.length > 2) { setupRows.pop(); renderSetup(); }
};

// The Terrain menu: how hilly the meadows are, or the floating isles.
function terrainChoice() {
  const v = $('opt-hills').value;
  return v === 'isles' ? { hills: 45, world: 'isles' } : { hills: Number(v), world: 'meadow' };
}

$('start').onclick = () => {
  sound.ensure();
  if (session) {
    // The host starts the room's match; everyone's screen starts it when the message comes round.
    if (!session.isHost || session.game) return;
    if (lobbySeats().length + lobbyCpus().length < 2) { $('net-note').textContent = 'Add a CPU tank, or wait for someone to join.'; return; }
    session.start({
      rounds: Number($('opt-rounds').value),
      maxWind: Number($('opt-wind').value),
      ...terrainChoice(),
      twists: $('opt-twists').value === '1',
      fog: $('opt-fog').value === '1',
    }, lobbyCpus().map((r, i) => ({ name: r.name.trim() || `CPU ${i + 1}`, ai: r.type })));
    $('start').disabled = true;
    return;
  }
  $('setup').classList.add('hidden');
  startMatch({
    players: setupRows.map((r, i) => ({ name: r.name.trim() || `Tank ${i + 1}`, ai: r.type === 'human' ? null : r.type })),
    rounds: Number($('opt-rounds').value),
    maxWind: Number($('opt-wind').value),
    ...terrainChoice(),
    twists: $('opt-twists').value === '1',
    firing: $('opt-firing').value,
    fog: $('opt-fog').value === '1',
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
  $('ro-continue').textContent = !game.localHumans.length ? `Start round ${game.round + 1}` : game.cfg.twists ? 'Continue to the perk draft' : 'Continue to the armory';
  $('ro-table').innerHTML = standingsTable([...game.players].sort((a, b) => b.wins - a.wins));
  $('roundover').classList.remove('hidden');
}

$('ro-continue').onclick = () => {
  $('roundover').classList.add('hidden');
  shopQueue = game.localHumans.map((p) => p.id);
  game.openShop();
  if (game.phase === 'shop') nextShopper();
};

const whose = (p, thing) => (/^you$/i.test(p.name.trim()) ? `Your ${thing}` : `${p.name}'s ${thing}`);
const hotseatStep = (p, doing) => {
  const humans = game.localHumans;
  return humans.length > 1 ? `Player ${humans.indexOf(p) + 1} of ${humans.length} · ${doing}` : doing;
};

// Each human in turn: pick a perk (if one is on offer), then shop.
function nextShopper() {
  const pid = shopQueue.shift();
  shopPid = pid ?? null;
  $('draft').classList.add('hidden');
  $('shop').classList.add('hidden');
  if (pid == null) {
    if (session) for (const p of game.localHumans) session.shopDone(p.id);   // the host closes the armory for everyone
    else game.closeShop();
    return;
  }
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
  jet: { have: (p) => p.jets, owned: (n) => `You have ${n}`, none: 'You have none', gives: `${ITEMS.find((i) => i.id === 'jet').bundle} charges per purchase` },
};

function openShopFor(pid) {
  const p = game.players[pid];
  const next = shopQueue.length ? game.players[shopQueue[0]] : null;
  $('shop').classList.remove('hidden');
  $('shop-card').style.borderTopColor = p.color;
  $('shop-swatch').style.background = p.color;
  $('shop-player').textContent = whose(p, 'armory');
  $('shop-step').textContent = hotseatStep(p, `shopping for round ${game.round + 1}`);
  $('shop-done').textContent = next ? `Done · pass to ${next.name}` : session ? 'Done · ready for the next round' : `Done · start round ${game.round + 1}`;
  const note = (text, good = false) => {
    $('shop-note').textContent = text;
    $('shop-note').classList.toggle('good', good);
  };
  const render = (justBought) => {
    $('shop-money').textContent = `$${p.money}`;
    $('shop-items').innerHTML = SHOP_ITEMS.filter((it) => !(game.online && it.id === 'guided') && !(it.fog && !game.cfg.fog)).map((it) => {
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
          <button class="buy" data-id="${it.id}" aria-label="Buy ${it.name} for $${price}" ${short > 0 ? 'disabled' : ''}>$${price}</button>
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
  leaveRoom();
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

// ---------------------------------------------------------------- online

// A room on the server (net.js) and the match played through it
// (core/netplay.js). Null when playing on this screen only.
let link = null;
let session = null;
let lobbySig = '';

const lobbySeats = () => (session ? session.seats.filter((s) => !s.gone) : []);
const lobbyCpus = () => setupRows.filter((r) => r.type !== 'human');
const netName = () => ($('net-name').value.trim() || setupRows.find((r) => r.type === 'human')?.name || 'Player').slice(0, 14);

const ROOM_KEY = 'craterfall.room';   // this tab's seat, so a reload can take it back

async function goOnline(how) {
  sound.ensure();
  if (link) return;
  const code = $('net-code').value.trim();
  if (how === 'join' && code.length !== 4) { $('net-note').textContent = 'Type the 4-letter room code first.'; return; }
  $('net-note').textContent = how === 'join' ? 'Joining…' : 'Making a room…';
  localStorage.setItem('craterfall.name', netName());
  link = new RoomLink();
  try {
    if (how === 'create') await link.create(netName(), $('net-private').checked); else await link.join(code, netName());
  } catch (err) {
    link.close();
    link = null;
    $('net-note').textContent = err.message === 'Failed to fetch' ? 'Could not reach the server.' : err.message;
    return;
  }
  enterRoom(false);
}

// `resume`: this tab had the seat before a reload; read the room back and carry on.
function enterRoom(resume) {
  sessionStorage.setItem(ROOM_KEY, JSON.stringify({ code: link.code, seat: link.seat, token: link.token }));
  session = new Session({
    seat: link.seat,
    send: (msg) => link.send(msg),
    onStart: (config) => {
      $('setup').classList.add('hidden');
      startMatch(config);
      return game;
    },
    onSay: showSay,
    resume,
  });
  link.onEntry = (e) => session.receive(e);
  link.onCaughtUp = () => session.caughtUp();
  link.onLost = () => netEnded('The connection to the room was lost (it may have expired, or the server restarted).');
  history.replaceState(null, '', `?room=${link.code}`);
  lobbySig = '';
  renderLobby();
}

// Online, the draft and armory screens follow the room: close them when the
// round has moved on, or when this tank's shopping is already in (from before a reload).
function syncNetScreens() {
  const g = session.game;
  if (!g || ($('draft').classList.contains('hidden') && $('shop').classList.contains('hidden'))) return;
  if (g.phase !== 'shop') {
    $('draft').classList.add('hidden');
    $('shop').classList.add('hidden');
    shopQueue = [];
    shopPid = null;
  } else if (shopPid != null && g.shopped.includes(shopPid)) nextShopper();
}

// Online, nobody holds the room up for long: a minute to plan a shot (then it
// goes as aimed), a minute and a half in the armory.
const NET_CLOCK = { aim: 60, shop: 90, show: 20 };
let clockKey = null;
let clockStart = 0;

function updateNetClock() {
  const g = session.game;
  let key = null;
  let limit = 0;
  if (g && g.phase === 'aim' && g.current && !g.current.ai && g.isLocal(g.current)) { key = `aim ${g.volleyKey} ${g.current.id}`; limit = NET_CLOCK.aim; }
  else if (g && g.phase === 'shop' && shopPid != null) { key = `shop ${g.round} ${shopPid}`; limit = NET_CLOCK.shop; }
  const now = performance.now() / 1000;
  if (key !== clockKey && !(clockKey && clockKey.startsWith(`${key} `))) { clockKey = key; clockStart = now; }
  const left = key && clockKey === key ? limit - (now - clockStart) : Infinity;
  const el = $('net-clock');
  el.classList.toggle('hidden', !(left <= NET_CLOCK.show));
  if (left <= NET_CLOCK.show) {
    const text = `${Math.max(0, Math.ceil(left))}s to ${key.startsWith('aim') ? 'lock in your shot' : 'finish shopping'}`;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('urgent', left <= 5);
  }
  if (!(left <= 0)) return;
  clockKey = `${key} out`;          // once
  if (key.startsWith('aim')) { game.fire(); return; }
  if (!$('draft').classList.contains('hidden')) $('draft-items').querySelector('button')?.click();
  if (!$('shop').classList.contains('hidden')) $('shop-done').click();
}

// Back after being away too long: a CPU has this screen's tank.
function noteTakenOver() {
  const g = session.game;
  if (!g || session.notedTakeover || g.localHumans.length || !session.playersOf(session.seat).length) return;
  session.notedTakeover = true;
  banner('A CPU has your tank', 'You were away too long. You can watch the rest of the match.', 4500);
}

// ---- chat: Enter to talk, in the lobby or the match
function showSay(e) {
  const g = session?.game;
  const seat = session?.seats.find((q) => q.seat === e.seat);
  const pid = session?.playersOf(e.seat)[0];
  const color = g && pid != null ? g.players[pid].color : PLAYER_COLORS[e.seat % PLAYER_COLORS.length];
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<b style="color:${color}">${escapeHtml(seat ? seat.name : '?')}</b> ${escapeHtml(String(e.msg.text ?? '').slice(0, 120))}`;
  $('chat-log').appendChild(line);
  while ($('chat-log').children.length > 6) $('chat-log').firstChild.remove();
  setTimeout(() => line.classList.add('fade'), 14000);
  setTimeout(() => line.remove(), 15000);
  sound.click();
}

function openChat() {
  const el = $('chat-input');
  el.classList.remove('hidden');
  el.focus();
  held.clear();
}

function closeChat() {
  const el = $('chat-input');
  if (el.classList.contains('hidden')) return;
  el.value = '';
  el.classList.add('hidden');
  el.blur();
}

$('chat-input').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = e.target.value.trim().slice(0, 120);
    if (text && link) link.send({ t: 'say', text });
    closeChat();
  } else if (e.key === 'Escape') closeChat();
});
$('chat-input').addEventListener('blur', closeChat);

// The setup card while in a room: its people, then the host's CPU tanks.
function renderLobby() {
  const seats = lobbySeats();
  const cpus = lobbyCpus();
  const sig = JSON.stringify([seats, cpus.map((r) => r.type), session.isHost, cpus.length]);
  if (sig === lobbySig) return;
  lobbySig = sig;
  document.body.classList.add('net-lobby');
  document.body.classList.toggle('net-guest', !session.isHost);
  $('net-entry').classList.add('hidden');
  $('net-room').classList.remove('hidden');
  $('net-code-show').textContent = link.code;
  $('opt-firing').value = 'volley';
  $('opt-firing').disabled = true;
  const rows = seats.map((s, k) => `
    <div class="player-row">
      <span class="swatch" style="background:${PLAYER_COLORS[k]};width:18px;height:18px"></span>
      <span>${escapeHtml(s.name)}${s.seat === link.seat ? ' (you)' : ''}</span>
      <span class="online-tag">${s.seat === 0 ? 'host' : 'online'}</span>
    </div>`);
  const cpuRows = setupRows.map((r, i) => (r.type === 'human' ? '' : `
    <div class="player-row">
      <span class="swatch" style="background:${PLAYER_COLORS[seats.length + cpus.indexOf(r)]};width:18px;height:18px"></span>
      ${session.isHost ? `<input data-i="${i}" class="pname" value="${escapeHtml(r.name)}" maxlength="14" />` : `<span>${escapeHtml(r.name)}</span>`}
      ${session.isHost ? `<select data-i="${i}" class="ptype">
        ${[['easy', 'CPU · Easy'], ['normal', 'CPU · Normal'], ['hard', 'CPU · Hard']]
          .map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>` : `<span class="online-tag">CPU</span>`}
    </div>`));
  $('setup-players').innerHTML = rows.join('') + (session.isHost ? cpuRows.join('') : '');
  document.querySelectorAll('.pname').forEach((el) => el.addEventListener('input', () => { setupRows[el.dataset.i].name = el.value; }));
  document.querySelectorAll('.ptype').forEach((el) => el.addEventListener('change', () => { setupRows[el.dataset.i].type = el.value; lobbySig = ''; }));
  $('add-player').textContent = '+ Add CPU';
  $('remove-player').textContent = '- Remove CPU';
  $('add-player').disabled = seats.length + cpus.length >= 6;
  $('remove-player').disabled = !cpus.length;
  const n = seats.length + cpus.length;
  $('start').textContent = `Start online match · ${n} tank${n === 1 ? '' : 's'}`;
  $('start').disabled = false;
  const chat = touch ? '' : ' Press Enter to chat.';
  $('net-note').textContent = session.isHost
    ? (seats.length < 2 ? 'Send your friends the invite link, or the code. Everyone in the room plays; CPUs are optional.' : `Start when everyone is in.${chat}`)
    : `Waiting for the host to start the match.${chat}`;
}

// Who the game is waiting on, while it waits.
function updateNetWait() {
  const g = session.game;
  const mineDone = g && (g.phase !== 'shop' || g.localHumans.every((p) => g.shopped.includes(p.id)));
  const names = mineDone ? session.waitingFor().map((p) => p.name) : [];
  const el = $('net-wait');
  el.classList.toggle('hidden', !names.length);
  if (names.length) {
    const text = `Waiting for ${names.join(', ')}…`;
    if (el.textContent !== text) el.textContent = text;
  }
}

function leaveRoom() {
  sessionStorage.removeItem(ROOM_KEY);
  if (link && !link.closed) link.leave();
  closeChat();
  $('net-clock').classList.add('hidden');
  if (link) link.close();
  link = null;
  session = null;
  $('net-entry').classList.remove('hidden');
  $('net-room').classList.add('hidden');
  $('net-wait').classList.add('hidden');
  $('net-note').textContent = '';
  $('add-player').textContent = '+ Add tank';
  $('remove-player').textContent = '- Remove tank';
  $('start').disabled = false;
  history.replaceState(null, '', location.pathname);
  roomsSig = '';
  refreshRooms();
}

// ---- the room list: open rooms anyone can join, matches being played, and
// who else is on the menu. Polled while the setup screen is up.
const visitorId = sessionStorage.getItem('craterfall.visitor') || Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
sessionStorage.setItem('craterfall.visitor', visitorId);
let roomsSig = '';
let roomsBusy = false;

async function refreshRooms() {
  if (roomsBusy || document.hidden || $('setup').classList.contains('hidden')) return;
  roomsBusy = true;
  try {
    // In a room you are not "on the menu", but you still see who is.
    const data = await listRooms(session ? {} : { id: visitorId, name: $('net-name').value.trim() });
    renderRooms(data);
  } catch {
    renderRooms(null);
  } finally {
    roomsBusy = false;
  }
}

function renderRooms(data) {
  const sig = JSON.stringify([data, !!session]);
  if (sig === roomsSig) return;
  roomsSig = sig;
  const box = $('net-rooms');
  if (session || !data) box.innerHTML = '';
  else if (!data.rooms.length) box.innerHTML = '<div class="room-empty">No open rooms right now. Create one and it shows up here for everyone.</div>';
  else {
    box.innerHTML = data.rooms.map((r) => `
      <div class="room-row ${r.open ? '' : 'busy'}">
        <span class="room-host">${escapeHtml(r.host)}'s room</span>
        <span class="room-players">${r.players.map(escapeHtml).join(', ')}</span>
        <span class="room-count">${r.players.length}/6</span>
        ${r.open ? `<button data-code="${escapeHtml(r.code)}">Join</button>` : `<span class="room-tag">${r.started ? 'playing' : 'full'}</span>`}
      </div>`).join('');
  }
  const m = data?.menu;
  const others = !m || !m.count ? 'Nobody else is on the menu right now.'
    : `Also on the menu: ${[...m.names, ...(m.count > m.names.length ? [`${m.count - m.names.length} more`] : [])].map(escapeHtml).join(', ')}`;
  $('net-menu').innerHTML = data ? others : '';
}

$('net-rooms').addEventListener('click', (e) => {
  const code = e.target.closest('button[data-code]')?.dataset.code;
  if (!code) return;
  $('net-code').value = code;
  goOnline('join');
});
setInterval(refreshRooms, 4000);
refreshRooms();

// The room went away under us: say so, then back to the menu.
function netEnded(text) {
  if (!session) return;
  const inMatch = !!session.game;
  leaveRoom();
  if (!inMatch) { $('net-note').textContent = text; renderSetup(); return; }
  $('net-ended-text').textContent = text;
  $('net-ended').classList.remove('hidden');
}

$('net-ended-ok').onclick = () => {
  $('net-ended').classList.add('hidden');
  for (const id of ['roundover', 'draft', 'shop', 'matchover']) $(id).classList.add('hidden');
  $('mo-again').onclick();
};
$('net-create').onclick = () => goOnline('create');
$('net-join').onclick = () => goOnline('join');
$('net-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') goOnline('join'); e.stopPropagation(); });
$('net-name').addEventListener('keydown', (e) => e.stopPropagation());
$('net-leave').onclick = () => { leaveRoom(); renderSetup(); };
$('net-copy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${link.code}`;
  try { await navigator.clipboard.writeText(url); $('net-note').textContent = `Copied: ${url}`; } catch { $('net-note').textContent = url; }
};
$('net-name').value = localStorage.getItem('craterfall.name') || '';
{
  const code = new URLSearchParams(location.search).get('room');
  const saved = JSON.parse(sessionStorage.getItem(ROOM_KEY) || 'null');
  if (code && saved && saved.code === code.toUpperCase()) {
    // This tab was in the room before a reload: take the seat back.
    link = new RoomLink();
    link.resume(saved);
    enterRoom(true);
  } else if (code) {
    $('net-code').value = code.toUpperCase().slice(0, 4);
    $('net-note').textContent = 'You have an invite: type your name and press Join.';
  }
}

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
function tick(dt, draw = true) {
  elapsed += dt;
  // The HUD panels' boxes, read before this frame writes anything so the layout is clean
  // (a hidden tab's draw-less ticks have no one looking, so they keep the last boxes).
  if (game && draw) readHudBoxes();
  let dayGoal = 0.12;
  if (session) {
    session.pump();
    if (!session.game) renderLobby();
    updateNetWait();
    syncNetScreens();
    updateNetClock();
    noteTakenOver();
  }
  if (session?.over && game?.phase !== 'matchOver') netEnded(session.over);
  if (game) {
    updateKillCam(dt);
    lastDt = dt;
    const sdt = dt * timeScale;   // game time: slowed for the kill cam
    applyHeldKeys(dt);
    applySteering();
    game.update(sdt);
    handleEvents();
    terrainMesh.flushPaths?.(renderer);   // upload just the scuffed part of the path mask
    game.players.forEach((p, i) => tanks[i].sync(p, game.terrain, sdt));
    updateHops(sdt);
    for (const w of wrecks) w.update(sdt);
    updateFog(dt);
    tankSmoke(dt);
    for (const pr of game.projectiles) {
      const sv = shells.get(pr.id);
      if (sv && shellHidden(pr)) sv.mesh.visible = false;
      else sv?.push(shellPos(pr));
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
    camGoal = _menuGoal.set(Math.cos(t) * 600, 300, Math.sin(t) * 600);
  }
  day = dayLock ?? day + Math.max(-dt * 0.5, Math.min(dt * 0.012, dayGoal - day));
  sky.setDay(day);
  sky.update(dt, game ? game.wind : [0.4, 0.2]);
  moons.update(performance.now() / 1000);
  birds.update(dt);
  soundScape(dt);
  music.update(dt, game ? timeScale : 1);
  effects.update(dt * timeScale);
  updateCamera(dt);
  updateAimAids();
  renderer.shadowMap.needsUpdate = true;   // once a frame, shared by the inset
  if (!draw) return;
  renderer.render(scene, camera);
  renderInset();
}

// A hidden tab gets no animation frames. Online that would hold up the whole
// room, so the match keeps running (without drawing) on a timer instead.
let bgLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const span = Math.min(60, (now - bgLast) / 1000);
  bgLast = now;
  if (!session || !document.hidden) return;
  for (let t = 0; t < span; t += 0.1) tick(0.1, false);
}, 1000);

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
window.craterfall = { get game() { return game; }, startMatch, muzzleOrigin, camera, controls, renderer, scene, sky, birds, sound, music, effects, tick, held,
  get tanks() { return tanks; }, get camGoal() { return camGoal; },
  lookAt(x, y, z, from) { pinned = true; camTarget.set(x, y, z); controls.target.set(x, y, z); camera.position.set(...from); camGoal = null; },
  release() { pinned = false; },
  get killCam() { return killCam; },
  get session() { return session; },
  netClock: NET_CLOCK,
  get timeScale() { return timeScale; },
  audioLatency() { return sound.ctx ? { base: sound.ctx.baseLatency, output: sound.ctx.outputLatency } : null; },
  setDay(k) { dayLock = k; } };
if (touch) window.craterfall.touch = touch;

// Resource-pack review (P): where tools/devserver.mjs serves the asset library
// at api/packs, or with ?packs in the address, from the shareable packs mirrored
// into the live site (tools/packmirror.py). Otherwise nothing more is loaded.
const packsHere = () => fetch('api/packs').then((r) => (r.ok ? r.json() : null));
const packsMirror = () => (new URLSearchParams(location.search).has('packs')
  ? fetch('packs/index.json').then((r) => (r.ok ? r.json() : null)) : null);
packsHere().catch(() => null).then((lib) => lib || packsMirror()).then(async (lib) => {
  if (!lib?.packs?.length) return;
  const { PackReview } = await import('./review.js');
  review = new PackReview(lib, {
    scene, sky, renderer, camera, controls, sound, banner,
    ground: () => (game ? terrainMesh : menuMesh),
    groundAt: (x, z) => (game ? game.terrain : menuField.terrain).heightAt(x, z),
  });
  window.craterfall.review = review;
  settings.add({ id: 'packs', group: 'more', label: 'Resource packs', hint: lib.static ? 'the shareable packs, phone-sized' : touch ? 'the asset library' : 'the asset library · P', run: () => review.toggle(true) });
}).catch(() => { /* no pack library here */ });
