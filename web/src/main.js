import * as THREE from 'three';
import { Game, PLAYER_COLORS, FOG } from './core/game.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS } from './core/weapons.js';
import { Session, winnerSeat } from './core/netplay.js';
import { RoomLink, listRooms } from './net.js';
import { profile } from './profile.js';
import { JET, muzzleOrigin } from './core/tank.js';
import { ROLL, SIM_DT, makeProjectile, stepProjectile, launchVelocity } from './core/ballistics.js';
import { perkSum } from './core/perks.js';
import { rollPart } from './core/weapons.js';
import { TerrainMesh, groundShade } from './render/terrainMesh.js';
import { SceneryMesh } from './render/sceneryMesh.js';
import { CityView } from './render/cityMesh.js';
import { NapalmView } from './render/napalm.js';
import { ArenaView } from './render/arena.js';
import { BUILDINGS } from './core/scenery.js';
import { isArtifact } from './core/artifacts.js';
import { TankMesh } from './render/tankMesh.js';
import { BulwarkMesh } from './render/bulwarkMesh.js';
import { FortView } from './render/fortMesh.js';
import { Wreck } from './render/wreck.js';
import { Effects, ShellVisual, QUALITY_KEY } from './render/effects.js';
import { Sky } from './render/sky.js';
import { Rain } from './render/rain.js';
import { Moons } from './render/moons.js';
import { GravityLines } from './render/gravityLines.js';
import { AimArc, Gunner } from './gunner.js';
import { SatelliteView } from './render/satellite.js';
import { Birds } from './render/birds.js';
import { AlienCraft } from './render/craft.js';
import { setRidgeWorld } from './render/ridgeline.js';
import { AngleDials } from './render/dials.js';
import { SidePanel } from './render/sidepanel.js';
import { Sound } from './audio.js';
import { Music, TRACKS } from './music.js';
import { TouchControls, wantTouch, coarsePointer } from './touch.js';
import { StrikeUI } from './strike.js';
import { ModsUI } from './modsui.js';
import { stepperHtml, resultsHtml, skillTreeHtml, skillTabs, skillTabsHtml, kitHtml, armoryHtml } from './armory.js';
import { MOD_BY_ID, modPos } from './core/mods.js';
import { cuesFor } from './sfxmap.js';
import { Settings, canFullscreen, isFullscreen, toggleFullscreen } from './settings.js';
import { Graphics } from './graphics.js';
import { applyGraphics } from './render/graphics.js';
import { defaultMatch, customBoss, onlineBoss, humanName, phoneFullscreen, showLaunchTab, wireLaunch } from './launch.js';
import { BossUI } from './bossui.js';
import { BossMarkView } from './render/bossMark.js';
import { bossMatch, fortSpots, ARENA } from './core/boss.js';
import { watchPortraitExit } from './portraitexit.js';
import { MatchBuilder, matchConditions, matchTime, parseTestParams } from './builder.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { RunUI } from './runui.js';
import { hudView, setHudView, installHudViews } from './hudview.js';
import { useHint } from './hints.js';
import { Hud } from './hud.js';
import { Labels } from './labels.js';
import { RangeCard } from './rangecard.js';
import { Inset } from './inset.js';
import { escapeHtml, whose, rangeOwner } from './hudlogic.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;    // tick() asks for one update a frame
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new Sky(scene);   // sun, sky light, fog, clouds
const rain = new Rain(scene);  // streaks, a grey sky and a hiss in a Rain round
const moons = new Moons(scene);   // the floating isles' moons
const gravityLines = new GravityLines(scene);   // flux lines while a well pulls a shell
// Settings > Graphics > Detail: High, Low or Auto (src/graphics.js); pixel
// ratio, shadow map and the cheaper shaders (render/graphics.js). Auto times
// the menu's frames once and drops to Low if they are slow.
const graphics = new Graphics({
  storage: (() => { try { return localStorage; } catch { return null; } })(), coarse: coarsePointer, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
  apply: (tier) => applyGraphics(tier, { renderer, sky, coarse: coarsePointer }), menu: () => !game,
});
graphics.watch();

// A desert floor far below the slab so it never floats in a void.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: '#8f7a5c', roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -140;
scene.add(floor);

const birds = new Birds(scene);
const craft = new AlienCraft(scene);   // over the isles, where birds would be
const effects = new Effects(scene);
const napalmView = new NapalmView(scene, effects);   // Napalm's burning fuel and the Dirt Bomb's "Buried" tags
const aimArc = new AimArc(scene, $('labels'));   // the dashed climb of the shot being planned
const dials = new AngleDials(scene);             // turret and elevation gauges on your tank while you aim
const sideView = new SidePanel($('hud'), { touch: wantTouch() });   // the planned shot, side on (Settings > Graphics)
const gunner = new Gunner($('hud'));             // the sight: G, or Sight on a phone
// The camera, its orbit controls and its modes (camera.js; the rules: cameramode.js).
const rig = new CameraRig(renderer, {
  game: () => game, planner: () => planning(), hero: () => heroId, fogFor: () => fogFor,
  seen: (p) => seen(p), believed: (p) => believed(p), shellPos, shellHidden, gunner,
  field: () => (game ? game.terrain : menuField.terrain), floorY: () => floor.position.y,
});
const { camera, controls } = rig;
const satView = new SatelliteView(scene, $('labels'));   // the Survey Satellite's patch and labels
// The marks over the tanks, the fog's ghosts, the edge arrows and the pips (labels.js).
const marks = new Labels({ root: $('labels'), camera, scene, seen: (p) => seen(p), believed: (p) => believed(p), peekAt: (p) => rig.peekAt(p) });
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
let cityView = null;            // the City world's buildings and traffic (render/cityMesh.js)
let tanks = [];
let smoke = [];                 // per tank: seconds until its next puff
let ghosts = [];                // fog: per tank, a ring where this screen last placed it (its label: labels.js)
let pulses = [];                // fog: scout bursts spreading out
let fogFor = null;              // fog: the tanks this screen sees for, this frame (null: sees everything)
let wrecks = [];
const shells = new Map();       // projectile id -> ShellVisual
const fadingTrails = [];        // finished shells' trails, fading out
let handoffOpen = false;        // volley planning: waiting for the next human to sit down
// A volley with one human in it: the camera rides that human's shell and every
// other tank's landing gets a pip (labels.js addPip). Null when several humans share
// the screen; then the camera stands back to frame every shell instead.
let heroId = null;
const hops = new Map();         // tank id -> the jump jet hop being drawn: { from, to, t, dur, puff }
const ranges = new Map();       // tank id -> its last rangefinder shot: { probes, elev, at, wind }
let shopQueue = [];
let shopPid = null;             // whose draft or armory is open
let day = 0;                    // 0 late morning .. 1 late afternoon, eased toward the match's progress
let dayLock = null;             // debug: hold the sun still at this time of day
let fortView = null;
let hintGame = null;            // the game whose first-turn hints have been decided
const _v = new THREE.Vector3();
const camDist = (pos) => camera.position.distanceTo(_v.set(pos[0], pos[1], pos[2]));
const arenaView = new ArenaView(scene, { effects, sound, camDist });
const bossMark = new BossMarkView(scene);   // the boss's telegraph on the ground   // the Edges curtains and the Island's sea

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
  cityView?.dispose(); cityView = null;
  arenaView.clear();
  bossMark.clear();
  if (fortView) { scene.remove(fortView.group); fortView.dispose(); fortView = null; }
  tanks.forEach((t) => { scene.remove(t.root); t.dispose(); });
  ghosts.forEach((ring) => { scene.remove(ring); ring.material.dispose(); });
  pulses.forEach((q) => { scene.remove(q.mesh); q.mesh.material.dispose(); });
  ghosts = []; pulses = []; fogFor = null;
  groundShade.fogOn.value = 0;
  wrecks.forEach(dropWreck);
  shells.forEach((s) => { scene.remove(s.mesh, s.line); });
  shells.clear();
  clearTrails();
  closeHandoff();
  effects.clear();
  napalmView.clear();
  hops.clear();
  tanks = []; wrecks = [];
  marks.clear();      // the marks, ghosts, edge arrows and pips (labels.js)
  heroId = null;
  moons.set([]);
  gravityLines.set([]);
  sky.setSpace(false);
  sky.setTime('day');      // the menu's own sky
  setRidgeWorld(false, { sky, floor });
  rain.clear();
  lastLand.clear();
  aimArc.hide();
  sideView.hide();
  dials.reset();
  satView.reset();
  modsUi.reset();
  floor.visible = birds.bodies.visible = birds.wings.visible = true;
  craft.set(false);
}

function startMatch(config) {
  disposeMatch();
  scene.remove(menuMesh.group, menuScenery.group);
  game = new Game(config);
  sky.setTime(game.cfg.time);      // before the tanks and the city, which light themselves by it
  terrainMesh = new TerrainMesh(game.terrain);
  sceneryMesh = new SceneryMesh(game.scenery);
  scene.add(terrainMesh.group, sceneryMesh.group);
  if (game.city) scene.add((cityView = new CityView(game, effects)).group);
  review?.onMatch();
  effects.groundAt = (x, z) => game.terrain.heightAt(x, z);
  tanks = game.players.map((p) => {
    const m = p.boss ? new BulwarkMesh(p.color) : new TankMesh(p.color);
    m.root.scale.setScalar(p.size || 1);   // the boss is bigger
    scene.add(m.root);
    return m;
  });
  smoke = game.players.map(() => 0);
  sky.fit(game.terrain.half);
  marks.start(game);   // each tank's mark, fog ghost and edge arrow (labels.js)
  ghosts = game.players.map((p) => {
    const ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 5;
    ring.visible = false;
    scene.add(ring);
    return ring;
  });
  rig.modes.endLook();
  hud.start(game);
  // The boss's fort: coloured ground (before the round builds) and rim props, drawn only.
  if (game.cfg.boss) terrainMesh.setFort(fortSpots(ARENA.boss[0] * game.terrain.half, ARENA.boss[1] * game.terrain.half), ARENA.fort.skirt);
  game.start();
  handleEvents();      // builds the round (terrain, scenery, water) so the warm-up sees it
  if (game.fort) scene.add((fortView = new FortView(game)).group);
  hud.show(true);
  warmShaders();
}

// Compile every shader the match can need now, while the screen is changing
// anyway, rather than the first time a fog ring or explosion shows up.
function warmShaders() {
  effects.warm(renderer, camera);
}

// ---------------------------------------------------------------- events

// The big line in the middle (hud.js).
function banner(text, sub, ms) { hud.banner(text, sub, ms); }

function addShake(pos, power) {
  rig.shake(pos, power);
}

// The sounds a game event asks for (sfxmap.js: the boss, the mods, Flak and
// the splitting shells; the rest play from the cases below).
const cueCtx = { mine: (id) => !!game?.players[id] && game.isLocal(game.players[id]), at: (id, mod) => { const p = game.players[id]; return p ? modPos(p, mod) || [p.x, p.y, p.z] : null; } };
const playCues = (e) => { for (const c of cuesFor(e, cueCtx)) sound.cue(c.cue, c.pos ? camDist(c.pos) : 0, c); };

const fellInVoid = new Set();   // players whose 'void' banner is up, so their death banner stays quiet
function handleEvents() {
  recentBlasts.length = 0;
  for (const e of game.drainEvents()) {
    strikeUi.event(e);
    bossUi.event(e);
    modsUi.event(e);
    playCues(e);
    cityView?.event(e);
    napalmView.event(e);
    if (e.type === 'buried' && touch && game.localHumans.some((h) => h.id === e.player)) touch.note(`${game.players[e.player].name}: buried! Your next shot digs you out`, 3500);
    arenaView.event(e);
    if (e.type === 'edge' && e.kind === 'wrap' && shells.has(e.id)) fadingTrails.push(shells.get(e.id).cut(e.pos, e.to));   // no trail across the map
    if (e.type === 'building' && e.how !== 'hit') { sound.thud(camDist(e.pos)); if (e.how === 'collapse') addShake(e.pos, 1.6); }
    switch (e.type) {
      case 'roundStart':
        wrecks.forEach(dropWreck);
        wrecks = [];
        clearTrails();
        marks.clearPips();
        ranges.clear();
        hops.clear();
        rig.cutKill();
        effects.clear();
        napalmView.clear();
        day = (e.round - 1) / game.cfg.rounds;
        birds.reset(game.terrain, e.round * 7 + game.players.length);
        hud.roundStart(game, e.round);
        break;
      case 'terrain':
        if (e.full) {
          dirty.length = 0;
          terrainMesh.rebuild();
          sceneryMesh.rebuild();
          terrainMesh.setPaths(game.scenery.paths, game.town);
          sky.setSpace(!!game.terrain.under);
          setRidgeWorld(!!game.terrain.ridge, { sky, floor });
          floor.visible = !game.terrain.under;   // nothing under the isles but space
          birds.bodies.visible = birds.wings.visible = !game.terrain.under;
          craft.set(!!game.terrain.under, game.terrain.half);
          moons.set(game.terrain.wells);
          gravityLines.set(game.terrain.wells);
        }
        else addDirty(e.region);
        break;
      case 'turn': {
        const p = game.players[e.player];
        rig.turn(p, seen(p, fogView()));   // a new planner gets the camera back
        // In a volley a "turn" is one tank's go at planning (or a CPU driving).
        // On a phone the "tap Lock in" line is taught the first few turns, then the banner is just the title (hints.js).
        const coach = !(touch && e.plan && !p.ai) || useHint('lockin', 6);
        if (e.plan && !p.ai && game.localHumans.filter((h) => h.alive).length > 1) { openHandoff(p); break; }
        hud.turn(p, { plan: e.plan, coach });   // once the round's banner has been read
        // The first turn of a match: the pad's "drag" line and the SIGHT note show only the first few matches (hints.js).
        if (touch && !p.ai && !p.shots.length && game.round === 1 && hintGame !== game) {
          hintGame = game;
          touch.setPadHelp(useHint('pad', 5));
          if (useHint('sight', 3)) {
            setTimeout(() => { if (game?.current === p && game.phase === 'aim') touch.note('SIGHT looks down your barrel; drag there to aim', 4500); },
              hud.holdLeft() + 1800);
          }
        }
        break;
      }
      case 'locked':
        sound.click();
        banner(e.pass ? 'Passed' : 'Locked in', e.pass ? 'Reloading after a Double Strike' : '', e.pass ? 1000 : 700);
        break;
      case 'volley': {
        closeHandoff();
        const alive = game.localHumans.filter((h) => h.alive && e.players.includes(h.id));
        heroId = alive.length === 1 ? alive[0].id : null;
        if (heroId != null) rig.volley(game.players[heroId]);
        banner('Fire!', `${e.players.length} tanks, all together`, 1300);
        break;
      }
      case 'aimReset':
        if (game.current?.id === e.player) hud.note('Moved: last aim cleared', 1800);
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
        marks.retireProbes(e.player);
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
        effects.muzzleFlash(e.pos);   // its pop is a cue (sfxmap.js)
        retireShell(e.id);
        break;
      case 'intercept':   // Point Defense shot it down (modsui.js draws the rest)
        sound.ping(camDist(e.pos));
        retireShell(e.id, e.pos);
        break;
      case 'impact':
      case 'lost': {
        const v = shells.get(e.id);
        const owner = v?.owner;
        if (v?.probe) {
          if (e.type === 'impact') {
            marks.addProbePip(game, owner, e.pos, v.probe);
            sound.ping(camDist(e.pos));
            const r = ranges.get(owner);
            if (r) r.probes[v.probe.key] = { ...v.probe, pos: [...e.pos] };
          }
        } else if (e.type === 'impact' && game.volleyMode && heroId != null && owner != null && owner !== heroId) marks.addPip(game, owner, e.pos);
        if (!v?.probe && owner != null) noteLanding(owner, v?.shot, e.type === 'impact' ? e.pos : null);
        retireShell(e.id, e.type === 'impact' ? e.pos : null);
        if ((e.type === 'lost' || e.splash) && !v?.probe && game.phase !== 'aim' && (heroId == null || owner === heroId)) banner(e.splash ? 'In the sea' : game.isles ? 'Lost in the void' : 'Out of the arena', '', 900);
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
      case 'hop':   // the Hopper kicks off a bump (and lands again as a rollStart)
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
        else if (isArtifact(e.kind)) { effects.dust(e.pos, 4); if (e.how === 'gone') effects.rubble(e.pos, 10, 4); }
        else if (e.kind === 'bridge') { effects.dust([e.a[0], e.pos[1], e.a[1]], 5); effects.dust(e.pos, 7); effects.dust([e.b[0], e.pos[1], e.b[1]], 5); sound.thud(camDist(e.pos)); }
        break;
      case 'damage': {
        if (seen(game.players[e.player])) marks.popDamage(game.players[e.player], e.amount);
        { const v = game.players[e.player]; sound.hit(camDist([v.x, v.y, v.z])); if (seen(v)) effects.ignite(`tank${e.player}`, 4 + Math.min(5, e.amount * 0.06)); }
        if (inset.for === e.player) inset.flash(e.amount);
        // Name the victim on the shooter's pip.
        marks.pipHit(game, e.by, e.player, heroId);
        break;
      }
      case 'void': {
        const q = game.players[e.player];
        banner(`${q.id === heroId ? 'You' : q.name} ${e.sea ? 'sank' : 'fell into the void'}`, '', 1800);
        fellInVoid.add(e.player);   // its 'destroyed' follows at once and must not take the banner
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
        if (!fellInVoid.delete(e.player)) banner(`${p.name} destroyed`, by && by !== p ? `by ${by.name}` : by === p ? 'self-inflicted' : '', 1800);
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
  input.held.clear();
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

let lastDt = 0;                 // the last frame's dt (the aim aids ease by it)

// ---------------------------------------------------------------- the sight

// The tank this screen is planning a shot for, or null.
function planning() {
  if (!game || handoffOpen || game.phase !== 'aim') return null;
  const p = game.current;
  return p && p.alive && game.isLocal(p) ? p : null;
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
  const sight = rig.mode === 'sight', { kill, overview } = rig.modes;
  aimArc.update(game, p, camera, { quiet: sight });
  dials.update({ game, p: kill || overview || sight ? null : p, camera, dt: lastDt });
  const enemies = [];
  for (const q of p ? game.players : []) {
    if (q === p || !q.alive) continue;
    const b = believed(q);
    if (b) enemies.push({ name: b.r > 0 ? `${q.name}?` : q.name, color: q.color, x: b.x, y: b.y, z: b.z });
  }
  sideView.update(game, kill || overview ? null : p, enemies, { sight });
  satView.update({ game, p: kill ? null : p, level: p ? game.surveyLevel(p) : 0, at: p ? modsUi.satAt(p) : null, camera, foes: enemies, time: elapsed, dt: lastDt, compact: document.body.classList.contains('touch') });
  if (!sight || !p) { gunner.hide(); return; }
  gunner.hud(camera, p, enemies, lastShotText(p));
}

// On-screen controls on phones and tablets (or ?mobile=1): they press the same keys and feed the same aim.
const touch = wantTouch() ? new TouchControls({ parent: $('hud'), unlockAudio: () => sound.ensure(), weaponBar: $('weapon-bar'), online: () => !!session }) : null;
if (touch) {
  // No keyboard here: the hints say what to tap instead.
  $('chat-input').placeholder = 'Say something';
}
// The player card, the players box, the banner and the steering hint (src/hud.js).
const hud = new Hud({ game: () => game, touch, peekAt: (p) => rig.peekAt(p) });
// The rangefinder card (src/rangecard.js) and the corner view of your tank while shells fly (src/inset.js).
const rangeCard = new RangeCard({ ranges, believed: (p) => believed(p), peekSpot: (pos) => rig.peekSpot(pos) });
const inset = new Inset({ renderer, scene, touch });
// Double Strike: the ×2 button (X), what Fire will do, and the reload notice (src/strike.js).
const strikeUi = new StrikeUI({ game: () => game, touch, banner, click: () => sound.click(), blocked: () => handoffOpen });
// Mods: the deploy buttons (B), the status chips, and the orbiters and satellites in the sky (src/modsui.js).
const bossUi = new BossUI({ game: () => game, touch, banner });
const modsUi = new ModsUI({ game: () => game, scene, camera, touch, banner, click: () => sound.click(), blocked: () => handoffOpen, seen: (p) => seen(p) });

// Settings (the gear): the three sound levels and the music track, full screen,
// and the resource packs where they are served (added with the packs, below).
const settings = new Settings({ parent: document.body });
const keys = (s) => (touch ? '' : s);
settings.group('sound', 'Audio', `Master sits under your device's volume, which still sets the overall level.${keys(' M mutes all, - / = set Master.')}`);
settings.level({ id: 'master', label: 'Master', group: 'sound', get: () => sound.volume, muted: () => sound.muted,
  set: (v) => { sound.ensure(); sound.setVolume(v); }, toggle: () => { sound.ensure(); sound.toggleMute(); } });
settings.level({ id: 'fx', label: 'Effects', group: 'sound', get: () => sound.fxVolume, muted: () => sound.fxMuted,
  set: (v) => { sound.ensure(); sound.setFxVolume(v); }, toggle: () => { sound.ensure(); sound.toggleFx(); } });
settings.level({ id: 'music', label: 'Music', group: 'sound', get: () => music.volume, muted: () => music.muted,
  set: (v) => { sound.ensure(); music.setVolume(v); }, toggle: () => { sound.ensure(); music.toggleMute(); } });
settings.choice({ id: 'track', label: `Track${keys(' (N)')}`, group: 'sound', options: TRACKS.map((t) => ({ value: t.id, text: t.name })),
  get: () => music.trackId, set: (id) => { sound.ensure(); music.select(id); } });
settings.group('look', 'Graphics', 'Low draws fewer pixels, softer shadows and plainer ground; Light draws fewer flames, smoke puffs and sparks. Both are smoother on a phone.');
settings.choice({ id: 'gfx', label: 'Detail', group: 'look', get: () => graphics.choice, set: (v) => graphics.set(v), options: [
  { value: 'auto', text: () => `Auto (${graphics.low ? 'Low' : 'High'})` }, { value: 'high', text: 'High' }, { value: 'low', text: 'Low (faster)' }] });
settings.choice({ id: 'fxq', label: 'Fire and smoke', group: 'look', options: [{ value: 'full', text: 'Full' }, { value: 'light', text: 'Light (faster)' }],
  get: () => effects.quality, set: (v) => { effects.setQuality(v); try { localStorage.setItem(QUALITY_KEY, v); } catch { /* private mode */ } } });
settings.group('more', 'More');
// The suggestion box (src/suggest.js, lazy), pinned beside Full screen: the area
// is a guess at where you were, which the box lets you change.
settings.add({ id: 'suggest', pin: true, label: 'Suggest', run: () => import('./suggest.js').then((m) => m.openSuggest({
  area: !$('setup').classList.contains('hidden') ? 'match builder' : game ? (game.online ? 'online' : 'game') : 'other',
  context: m.suggestionContext({ game, screen: !$('setup').classList.contains('hidden') ? 'setup' : game ? 'match' : 'other',
    page: location.pathname + location.search, view: { w: innerWidth, h: innerHeight }, touch: !!touch, ua: navigator.userAgent }),
})) });
if (canFullscreen()) settings.add({ id: 'full', pin: true, label: () => (isFullscreen() ? 'Leave full screen' : 'Full screen'), run: toggleFullscreen });
// Holding the phone upright for a few seconds leaves full screen (core of it in portraitexit.js).
if (touch && canFullscreen()) watchPortraitExit({ isFullscreen, leave: () => {
  try { screen.orientation?.unlock?.(); } catch { /* not locked */ }
  if (isFullscreen()) toggleFullscreen();
  banner('Left full screen', 'Settings > Full screen to go back', 2600);
} });
settings.toggle({ id: 'dials', group: 'look', label: 'Angle dials', hint: 'turret and elevation rings on your tank', get: () => dials.enabled, set: (on) => dials.setEnabled(on) });
settings.toggle({ id: 'sideview', group: 'look', label: 'Side view', hint: 'the planned shot drawn side on, top centre', get: () => sideView.enabled, set: (on) => sideView.setEnabled(on) });
settings.add({ id: 'guide', group: 'more', label: 'Guide', hint: 'how to play', run: () => import('./guide.js').then((m) => m.openGuide()) });   // lazy: src/guide.js
settings.add({ id: 'catalog', group: 'more', label: 'Catalog', hint: 'all weapons, perks, mods (dev)', run: () => { window.open('catalog.html', '_blank'); } });   // catalog.html + src/catalog.js


// ---------------------------------------------------------------- input

// Keys, the touch controls, drags, pinches and the wheel on the view, routed by
// the camera's mode and the game's phase (src/input.js; the table: src/inputmap.js).
const input = new Input({
  el: renderer.domElement, rig, gunner, touch, sound, music, settings, hud, banner,
  game: () => game, handoff: () => handoffOpen, online: () => !!session, hopping: (id) => hops.has(id),
  openChat, closeHandoff, strike: () => strikeUi.toggle(), deploy: () => modsUi.deployKey(),
});

function updateTracer() {
  const p = game.current;
  const reach = p && !p.ai && game.phase === 'aim' && !game.arcJammed(p) ? perkSum(p, 'tracer') : 0;   // a level 2 jammer blanks it
  tracer.visible = reach > 0;
  if (!reach) return;
  const pr = makeProjectile(muzzleOrigin(p), launchVelocity(p.yaw, p.elev, p.power), game.terrain);
  pr.g = game.gravity;
  pr.windK = game.windShare(p);
  pr.drag = game.shellDrag(p);
  const a = tracer.geometry.attributes.position;
  let n = 0;
  let gone = 0;
  let last = [...pr.pos];
  a.setXYZ(n++, ...pr.pos);
  for (let step = 1; gone < reach && n < a.count; step++) {
    stepProjectile(pr, game.wind);
    if (pr.crossed && pr.crossed.kind !== 'bounce') { a.setXYZ(n++, ...pr.crossed.point); break; }   // a wall, or wrapped away
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
// dust off the tracks, and the small fire on a tank that is hurt (see Effects.burn).
function tankSmoke(dt) {
  const drift = [game.wind[0] * 1.5, game.wind[1] * 1.5];
  game.players.forEach((p, i) => {
    if (!p.alive || !seen(p)) return;
    const t = tanks[i];
    const hurt = 1 - p.hp / p.maxHp;
    // A badly hurt tank (or one just hit) burns and smokes until it is repaired or dies.
    // It burns on the engine deck, on whichever side faces the camera.
    const side = t.hull.worldToLocal(_v.copy(camera.position)).z >= 0 ? 1 : -1;
    t.hull.localToWorld(_v.set(-2.5, 2.4, side * 0.9));
    effects.burn(`tank${i}`, _v.x, _v.y, _v.z, { flame: hurt > 0.65 ? (hurt - 0.5) * 1.3 : 0, smoke: hurt > 0.4 ? 0.3 + hurt * 0.7 : 0, ttl: 0.3, spread: 1.1, size: 1.4 });
    if ((smoke[i] -= dt) > 0) return;
    if (t.work > 0.1) {
      smoke[i] = 0.09;
      effects.puff(t.exhaust(_v, Math.random() < 0.5 ? 1 : -1), { size: 0.8 + t.work * 0.5, life: 1.1, drift });
      if (Math.random() < 0.5) effects.puff({ x: p.x, y: p.y + 0.4, z: p.z }, { color: '#a08463', size: 2.2, life: 1.2, rise: 0.8, opacity: 0.3, drift });
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
  let orbit = Infinity;
  if (game) {
    for (const w of game.orbiterWells()) orbit = Math.min(orbit, camDist([w.x, w.y, w.z]));
    game.players.forEach((p, i) => { if (p.alive) driving = Math.max(driving, tanks[i].work / (1 + camDist([p.x, p.y, p.z]) / 160)); });
    for (const pr of game.projectiles) {
      if (pr.dead || pr.roller) continue;
      const dist = camDist(pr.pos);
      if (!shell || dist < shell.dist) shell = { dist, falling: Math.max(0, Math.min(1, -pr.vel[1] / 45)) };
    }
  }
  sound.update(dt, { wind: game ? Math.hypot(...game.wind) : 0.6, driving, shell, birds: birds.nearest(camera.position), sheep,
    fire: effects.fireLevel(camera.position.x, camera.position.y, camera.position.z), rain: rain.amount, city: game?.town ? 1 : 0, orbit });
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
    const ring = ghosts[i];
    const b = !show ? believed(p) : null;
    ring.visible = !!b;
    marks.ghost(i, b, game);   // its name and how old the sighting is (labels.js)
    if (!b) return;
    ring.position.set(b.x, b.y + 1.5, b.z);
    ring.scale.setScalar(Math.max(8, b.r));
    ring.material.opacity = b.r ? 0.4 : 0.6;
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

const setupRows = [
  { name: profile.name || 'You', type: 'human' },
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
      ${r.type === 'human' ? `<span class="pname-fixed">${escapeHtml(r.name)}<small>your name</small></span>`
        : `<input data-i="${i}" class="pname" value="${escapeHtml(r.name)}" maxlength="14" />`}
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

// Testing aids from the query string (builder.js parseTestParams): forced wind
// and terrain, and the old Lab's mods for everyone. Read once at load: an
// online room rewrites the address.
const testParams = parseTestParams(location.search);
const builder = new MatchBuilder($('opt-groups'));

// The Custom match options as config (host only online). Random wind and
// terrain are rolled here, once, so the config holds concrete values and every
// screen builds the same world.
function customOptions() {
  return {
    rounds: Number($('opt-rounds').value),
    ...matchConditions({ wind: $('opt-wind').value, terrain: $('opt-hills').value, edges: $('opt-edges').value }, testParams),
    time: matchTime($('opt-time').value, testParams),
    fog: $('opt-fog').value === '1',
    ...builder.lists(),
    lab: testParams.lab || null,
    modifier: testParams.modifier || null,
  };
}

$('play').onclick = () => {
  if (session) return;
  sound.ensure();
  phoneFullscreen(touch);
  if (humanName()) profile.setName(humanName());
  $('setup').classList.add('hidden');
  const conditions = matchConditions({}, testParams);
  const base = testParams.boss ? bossMatch(humanName(), { conditions, lab: testParams.lab }) : defaultMatch(humanName(), conditions, testParams.lab);
  startMatch({ ...base, modifier: testParams.modifier || null, time: matchTime('random', testParams) });
};

$('start').onclick = () => {
  sound.ensure();
  phoneFullscreen(touch);
  if (session) {
    // The host starts the room's match; everyone's screen starts it when the message comes round.
    if (!session.isHost || session.game) return;
    if (lobbySeats().length + lobbyCpus().length < 2) { $('net-note').textContent = 'Add a CPU tank, or wait for someone to join.'; return; }
    const cpus = lobbyCpus().map((r, i) => ({ name: r.name.trim() || `CPU ${i + 1}`, ai: r.type }));
    if ($('opt-match').value === 'boss') { const { config, boss } = onlineBoss(customOptions()); session.start(config, [...cpus, boss]); }
    else session.start(customOptions(), cpus);
    $('start').disabled = true;
    return;
  }
  if (humanName()) profile.setName(humanName());
  $('setup').classList.add('hidden');
  if ($('opt-match').value === 'boss') { startMatch(customBoss(setupRows, customOptions(), $('opt-firing').value)); return; }
  startMatch({
    players: setupRows.map((r, i) => ({ name: r.name.trim() || `Tank ${i + 1}`, ai: r.type === 'human' ? null : r.type })),
    ...customOptions(),
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
    if (run.matchOver(game)) return;   // a run's fight: the run's own result card
    const boss = bossUi.matchResult();   // a boss match is teams, not wins and funds
    const sorted = boss ? boss.order : [...game.players].sort((a, b) => b.wins - a.wins || b.money - a.money);
    $('mo-title').textContent = boss ? boss.title : `Match winner: ${sorted[0].name}`;
    $('mo-table').innerHTML = boss ? boss.table : standingsTable(sorted);
    $('mo-stats').innerHTML = statsTable(sorted);
    $('mo-awards').innerHTML = awards(game.players);
    if (session?.isHost) link?.result(winnerSeat(game, session.seatOf));   // for the players' records
    $('matchover').classList.remove('hidden');
    return;
  }
  $('ro-title').textContent = w ? `Round ${game.round}: ${w.name} wins` : `Round ${game.round} is a draw`;
  $('ro-continue').textContent = !game.localHumans.length ? `Start round ${game.round + 1}` : game.draftOn ? 'Continue to your skills' : 'Continue to the armory';
  $('ro-steps').innerHTML = stepperHtml('results', { draft: game.draftOn, round: game.round });
  $('ro-table').innerHTML = resultsHtml([...game.players].sort((a, b) => b.wins - a.wins));
  $('roundover').classList.remove('hidden');
}

$('ro-continue').onclick = () => {
  $('roundover').classList.add('hidden');
  shopQueue = game.localHumans.map((p) => p.id);
  game.openShop();
  if (game.phase === 'shop') nextShopper();
};

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

// The skill tree (src/armory.js skillTreeHtml): spend skill points on the
// next rank of any branch, or save them; then the armory. Its tabs (Weapons,
// Mods, Tank) sit at the top of the grid.
function openDraftFor(pid) {
  const p = game.players[pid];
  const toShop = () => { $('draft').classList.add('hidden'); openShopFor(pid); };
  let tab = skillTabs(game, p)[0]?.id || null;
  const render = () => {
    const n = p.points;
    $('draft-step').textContent = hotseatStep(p, n > 1 ? `${n} skill points to spend` : n ? '1 skill point to spend' : 'all points spent');
    $('draft-owned').innerHTML = kitHtml(game, p);
    $('draft-items').innerHTML = skillTabsHtml(game, p, tab) + skillTreeHtml(game, p, tab);
    $('draft-skip').textContent = n ? `Save ${n > 1 ? 'them' : 'it'} · go to the armory` : 'Go to the armory';
  };
  $('draft').classList.remove('hidden');
  $('draft-card').style.borderTopColor = p.color;
  $('draft-swatch').style.background = p.color;
  $('draft-player').textContent = whose(p, 'skills');
  $('draft-steps').innerHTML = stepperHtml('draft', { round: game.round });
  render();
  $('draft-items').onclick = (e) => {
    const t = e.target.closest('button.sk-tab');
    if (t) { tab = t.dataset.tab; sound.click(); render(); return; }
    const b = e.target.closest('button.buy');
    if (!b || b.disabled || !game.pickPerk(pid, b.dataset.id)) return;
    sound.click();
    if (game.draft[pid]) render(); else toShop();
  };
  $('draft-skip').onclick = toShop;
}

// The armory, one human at a time. Each item is a card that says what it is,
// what one purchase gives, what the shopper already holds, and has one button.
const SHOP_ITEMS = [...WEAPONS.filter((w) => !w.hidden && !w.infinite), ...ITEMS];
const SHOP_HINT = 'Money you keep carries over to the next armory.';

function openShopFor(pid) {
  const p = game.players[pid];
  const next = shopQueue.length ? game.players[shopQueue[0]] : null;
  $('shop').classList.remove('hidden');
  $('shop-card').style.borderTopColor = p.color;
  $('shop-swatch').style.background = p.color;
  $('shop-player').textContent = whose(p, 'armory');
  $('shop-step').textContent = hotseatStep(p, `shopping for round ${game.round + 1}`);
  $('shop-steps').innerHTML = stepperHtml('armory', { draft: game.draftOn, round: game.round });
  $('shop-done').textContent = next ? `Done · pass to ${next.name}` : session ? 'Done · ready for the next round' : `Done · start round ${game.round + 1}`;
  const note = (text, good = false) => {
    $('shop-note').textContent = text;
    $('shop-note').classList.toggle('good', good);
  };
  const render = (justBought) => {
    $('shop-money').textContent = `$${p.money}`;
    $('shop-kit').innerHTML = kitHtml(game, p);
    $('shop-items').innerHTML = armoryHtml(game, p, justBought);
  };
  $('shop-items').onclick = (e) => {
    const b = e.target.closest('button.buy');
    const id = b?.dataset.id;
    const it = SHOP_ITEMS.find((x) => x.id === id) || MOD_BY_ID[id];
    const price = it ? game.priceOf(p, it.id) : 0;
    const level = MOD_BY_ID[id] ? game.modLevel(p, id) + 1 : 0;
    if (!b || b.disabled || !it || !game.buy(pid, it.id)) return;
    sound.click();
    render(it.id);
    note(`Bought ${level ? `${it.name} level ${level}` : it.bundle ? `${it.bundle} × ${it.name}` : it.name} for $${price}. $${p.money} left.`, true);
    const funds = $('shop-money');
    funds.classList.remove('pulse');
    void funds.offsetWidth;   // restart the animation
    funds.classList.add('pulse');
  };
  render();
  const haggle = perkSum(p, 'discount') ? ' Haggler prices applied.' : '';
  note(SHOP_ITEMS.some((it) => game.priceOf(p, it.id) <= p.money) ? SHOP_HINT + haggle : `Nothing in reach this time. ${SHOP_HINT}`);   // mod upgrades aside
  $('shop-done').onclick = nextShopper;
}

// Out of the match and back to the menu's field (the launch screen is the caller's).
function toMenuScene() {
  leaveRoom();
  closeHandoff();
  hud.show(false);
  disposeMatch();
  game = null;
  rig.cutKill();
  scene.add(menuMesh.group, menuScenery.group);
  tracer.visible = false;
  sky.fit(menuField.terrain.half);
  birds.reset(menuField.terrain, 5);
}
$('mo-again').onclick = () => {
  $('matchover').classList.add('hidden');
  toMenuScene();
  $('setup').classList.remove('hidden');
  renderSetup();
};
// The run (runui.js): its map and stops on its own screen, its fights here.
const run = new RunUI({
  startMatch, toMenu: toMenuScene, name: humanName, click: () => sound.click(), sfx: (cue, o) => sound.cue(cue, 0, o),
  begin: () => { sound.ensure(); phoneFullscreen(touch); if (humanName()) profile.setName(humanName()); },
  showSetup: () => { $('setup').classList.remove('hidden'); renderSetup(); },
});

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
  if ($('net-name').value.trim()) profile.setName($('net-name').value);
  link = new RoomLink();
  await profile.ready;   // so the request carries the player id cookie
  let r;
  try {
    r = how === 'create' ? await link.create(netName(), $('net-private').checked) : await link.join(code, netName());
  } catch (err) {
    link.close();
    link = null;
    $('net-note').textContent = err.message === 'Failed to fetch' ? 'Could not reach the server.' : err.message;
    return;
  }
  enterRoom(!!r.rejoin);   // this tab already had a seat there: read the room back
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
  if (key.startsWith('aim')) { game.fire(true); return; }
  if (!$('draft').classList.contains('hidden')) $('draft-items').querySelector('button.buy')?.click();
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
  input.held.clear();
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
  else if (!data.rooms.length) box.innerHTML = '<div class="room-empty">None yet. Create one and it shows here for everyone.</div>';
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
  const open = data?.rooms?.filter((r) => r.open).length || 0;
  $('tab-online-count').textContent = open && !session ? String(open) : '';
  const others = !m || !m.count ? ''
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
// Your name is the player's (profile.js): saved here and on the server. The
// launch screen (launch.js) copies it onto the first tank as it is typed.
$('net-name').value = profile.name;
$('net-name').addEventListener('change', () => { profile.setName($('net-name').value); });
{
  const was = profile.name;   // from localStorage; the server's may differ
  profile.ready.then(() => {
    if ($('net-name').value !== was || profile.name === was) return;
    $('net-name').value = profile.name;
    $('net-name').dispatchEvent(new Event('input'));
  });
}
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
    showLaunchTab('online');
    $('net-note').textContent = 'You have an invite: type your name and press Join with code.';
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
  if (game && draw) marks.readBoxes();
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
    rig.updateKill(dt);
    lastDt = dt;
    const sdt = dt * rig.timeScale;   // game time: slowed for the kill cam
    input.aim(dt);
    input.steer();
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
    cityView?.update(sdt);
    napalmView.update(sdt, game);
    arenaView.update(game, elapsed, dt);
    hud.update(game);
    strikeUi.update();
    bossUi.update();
    bossMark.update(game, elapsed);
    fortView?.update(elapsed);
    modsUi.update(sdt, elapsed);
    input.syncFind();
    marks.update(game, { mode: rig.labelMode(game.phase), sight: rig.mode === 'sight', overview: rig.modes.overview, handoff: handoffOpen });
    rangeCard.update(game, rangeOwner(game, { handoff: handoffOpen, heroId }));
    // The sun moves a little every turn and a lot over the match.
    const within = Math.min(1, game.turnsThisRound / ((game.volleyMode ? 1 : game.players.length) * 6));
    dayGoal = (game.round - 1 + within) / game.cfg.rounds;
  } else {
    // The menu's field; the camera orbits it (camera.js, 'menu').
    menuField.scenery.update(dt);
    menuScenery.sync(elapsed);
  }
  day = dayLock ?? day + Math.max(-dt * 0.5, Math.min(dt * 0.012, dayGoal - day));
  // Rain while a Rain round is being played; it stops when the round ends.
  rain.update(dt, camera, { on: !!(game?.drag && !['roundOver', 'matchOver', 'shop'].includes(game.phase)),
    wind: game ? game.wind : [0, 0], light: effects.quality === 'light', groundAt: game && !game.terrain.under ? (x, z) => game.terrain.heightAt(x, z) : null });
  sky.setWeather(rain.amount);
  effects.damp = rain.amount;
  sky.setDay(day);
  sky.update(dt, game ? game.wind : [0.4, 0.2]);
  moons.update(performance.now() / 1000);
  const orbWells = game?.projectiles.length ? game.orbiterWells().map((w, i) => ({ ...w, id: `orb${w.owner}:${i}` })) : [];
  gravityLines.update(dt * rig.timeScale, game ? game.projectiles : [], orbWells, (pr) => (shellHidden(pr) ? null : shellPos(pr)));
  birds.update(dt);
  craft.update(dt);
  soundScape(dt);
  music.update(dt, game ? rig.timeScale : 1);
  if (game) effects.wind = game.wind;
  effects.update(dt * rig.timeScale);
  rig.update(dt);
  updateAimAids();
  setHudView(hudView({ phase: game?.phase, mode: rig.mode }));   // what each HUD element shows (hudview.js), by the camera's mode
  renderer.shadowMap.needsUpdate = true;   // once a frame, shared by the inset
  if (!draw) return;
  renderer.render(scene, camera);
  inset.render(game, { allowed: rig.modes.insetAllowed(), target: controls.target });
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

installHudViews();
wireLaunch({ rows: setupRows, render: renderSetup, builder });   // the Custom section and the name field (launch.js)
renderSetup();
$('loading').classList.add('hidden');
frame();

// Exposed for debugging from the console.
window.craterfall = { craft, run, get game() { return game; }, startMatch, graphics, muzzleOrigin, camera, controls, renderer, scene, sky, birds, sound, music, effects, tick, held: input.held,
  get tanks() { return tanks; }, get camGoal() { return rig.goal; }, rig, get cameraMode() { return rig.mode; },
  get terrainMesh() { return terrainMesh; }, get sceneryMesh() { return sceneryMesh; }, get cityView() { return cityView; },   // for profiling
  lookAt(x, y, z, from) { rig.lookAt(x, y, z, from); },
  release() { rig.release(); },
  get killCam() { return rig.modes.kill; },
  get peek() { return rig.modes.peek; },
  get session() { return session; },
  netClock: NET_CLOCK,
  get timeScale() { return rig.timeScale; },
  audioLatency() { return sound.ctx ? { base: sound.ctx.baseLatency, output: sound.ctx.outputLatency } : null; },
  setDay(k) { dayLock = k; } };
if (touch) window.craterfall.touch = touch;

// Resource-pack review (P): where tools/devserver.mjs serves the asset library
// at api/packs, that; elsewhere (the live site) the shareable packs mirrored
// into it (tools/packmirror.py), fetched only when Settings > Resource packs is
// first opened, or at once with ?packs in the address.
const packsHere = () => fetch('api/packs').then((r) => (r.ok ? r.json() : null));
const packsMirror = () => fetch('packs/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
async function makeReview(lib) {
  if (review) return review;
  const { PackReview } = await import('./review.js');
  review = new PackReview(lib, {
    scene, sky, renderer, camera, controls, sound, banner,
    ground: () => (game ? terrainMesh : menuMesh),
    groundAt: (x, z) => (game ? game.terrain : menuField.terrain).heightAt(x, z),
  });
  window.craterfall.review = review;
  return review;
}
packsHere().catch(() => null).then(async (lib) => {
  if (lib?.packs?.length) {
    await makeReview(lib);
    settings.add({ id: 'packs', group: 'more', label: 'Resource packs', hint: touch ? 'the asset library' : 'the asset library · P', run: () => review.toggle(true) });
    return;
  }
  const open = async () => {
    if (!review) {
      const mirror = await packsMirror();
      if (!mirror?.packs?.length) { banner('No resource packs here', '', 1200); return; }
      await makeReview(mirror);
    }
    review.toggle(true);
  };
  settings.add({ id: 'packs', group: 'more', label: 'Resource packs', hint: 'the shareable packs, phone-sized', run: open });
  if (new URLSearchParams(location.search).has('packs')) packsMirror().then((m) => m?.packs?.length && makeReview(m));
}).catch(() => { /* no pack library here */ });
