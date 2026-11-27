import * as THREE from 'three';
import { Game, FOG } from './core/game.js';
import { muzzleOrigin } from './core/tank.js';
import { SIM_DT, makeProjectile, stepProjectile, launchVelocity } from './core/ballistics.js';
import { perkSum } from './core/perks.js';
import { TerrainMesh, groundShade } from './render/terrainMesh.js';
import { SceneryMesh } from './render/sceneryMesh.js';
import { NapalmView } from './render/napalm.js';
import { ArenaView } from './render/arena.js';
import { Effects, QUALITY_KEY } from './render/effects.js';
import { Sky } from './render/sky.js';
import { Rain } from './render/rain.js';
import { Moons } from './render/moons.js';
import { GravityLines } from './render/gravityLines.js';
import { AimArc, Gunner } from './gunner.js';
import { SatelliteView } from './render/satellite.js';
import { Birds } from './render/birds.js';
import { AlienCraft } from './render/craft.js';
import { AngleDials } from './render/dials.js';
import { SidePanel } from './render/sidepanel.js';
import { Sound } from './audio.js';
import { Music, TRACKS } from './music.js';
import { TouchControls, wantTouch, coarsePointer, mobilePerf } from './touch.js';
import { StrikeUI } from './strike.js';
import { ModsUI } from './modsui.js';
import { Settings, canFullscreen, isFullscreen, toggleFullscreen } from './settings.js';
import { humanName, phoneFullscreen, wireLaunch } from './launch.js';
import { profile } from './profile.js';
import { BossUI } from './bossui.js';
import { BossMarkView } from './render/bossMark.js';
import { watchPortraitExit } from './portraitexit.js';
import { MatchBuilder, parseTestParams } from './builder.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { RunUI } from './runui.js';
import { hudView, setHudView, installHudViews } from './hudview.js';
import { Hud } from './hud.js';
import { Labels } from './labels.js';
import { RangeCard } from './rangecard.js';
import { Inset } from './inset.js';
import { rangeOwner } from './hudlogic.js';
import { Match } from './match.js';
import { MatchEvents } from './events.js';
import { Setup } from './setup.js';
import { Online } from './online.js';
import { NET_CLOCK } from './netlogic.js';

const $ = (id) => document.getElementById(id);

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
const rain = new Rain(scene);  // streaks, a grey sky and a hiss in a Rain round
const moons = new Moons(scene);   // the floating isles' moons
const gravityLines = new GravityLines(scene);   // flux lines while a well pulls a shell
if (coarsePointer) mobilePerf(renderer, sky);   // phones and tablets: fewer pixels, smaller shadow map

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
  game: () => game, planner: () => match.planning(), hero: () => events.heroId, fogFor: () => match.fogFor,
  seen: (p) => seen(p), believed: (p) => believed(p), shellPos, shellHidden, gunner,
  field: () => (game ? game.terrain : menuField.terrain), floorY: () => floor.position.y,
});
const { camera, controls } = rig;
const satView = new SatelliteView(scene, $('labels'));   // the Survey Satellite's patch and labels
// The marks over the tanks, the fog's ghosts, the edge arrows and the pips (labels.js).
const marks = new Labels({ root: $('labels'), camera, scene, seen: (p) => seen(p), believed: (p) => believed(p), peekAt: (p) => rig.peekAt(p) });
const sound = new Sound();
const music = new Music(sound);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- the match

// The Game being played, or null on the menu: match.game, kept in step by the
// Match (onGame) so the frame code here reads it directly.
let game = null;
let review = null;           // the resource-pack review (src/review.js), dev server only
let day = 0;                    // 0 late morning .. 1 late afternoon, eased toward the match's progress
let dayLock = null;             // debug: hold the sun still at this time of day
const _v = new THREE.Vector3();
const camDist = (pos) => camera.position.distanceTo(_v.set(pos[0], pos[1], pos[2]));
const arenaView = new ArenaView(scene, { effects, sound, camDist });
const bossMark = new BossMarkView(scene);   // the boss's telegraph on the ground   // the Edges curtains and the Island's sea
const RING = new THREE.RingGeometry(0.92, 1, 56);   // the fog's ghost rings and the scout pulses

// A short line showing where the shot starts out, for tanks with Tracer Rounds.
const tracer = new THREE.Line(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 3), 3)),
  new THREE.LineBasicMaterial({ color: '#fff6c9', transparent: true, opacity: 0.8 }),
);
tracer.frustumCulled = false;
tracer.visible = false;
scene.add(tracer);

// The match from its start to the menu, and the cards between its rounds
// (src/match.js); its events on screen and what they leave behind: shells,
// trails, wrecks, hops (src/events.js). Modules made further down are getters.
const match = new Match({
  scene, renderer, camera, effects, sky, floor, birds, craft, moons, gravityLines, rain, napalmView, arenaView, bossMark,
  aimArc, sideView, dials, satView, tracer, ring: RING, marks, rig, sound,
  onGame: (g) => { game = g; },
  get hud() { return hud; }, get touch() { return touch; }, get events() { return events; }, get modsUi() { return modsUi; },
  get bossUi() { return bossUi; }, get run() { return run; }, get input() { return input; }, get online() { return online; },
  get setup() { return setup; }, get review() { return review; },
  get menuMesh() { return menuMesh; }, get menuScenery() { return menuScenery; }, get menuField() { return menuField; },
});
const events = new MatchEvents({
  match, scene, effects, sound, camDist, rig, marks, birds, sky, floor, craft, moons, gravityLines, napalmView, arenaView, ring: RING,
  banner: (...a) => banner(...a), seen: (p, view) => seen(p, view), fogView: () => fogView(), shellHidden: (pr) => shellHidden(pr), shellPos,
  setDay: (k) => { day = k; },
  get hud() { return hud; }, get inset() { return inset; }, get touch() { return touch; },
  get strikeUi() { return strikeUi; }, get bossUi() { return bossUi; }, get modsUi() { return modsUi; },
});

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

// ---------------------------------------------------------------- banner

// The big line in the middle (hud.js).
function banner(text, sub, ms) { hud.banner(text, sub, ms); }

let lastDt = 0;                 // the last frame's dt (the aim aids ease by it)

// ---------------------------------------------------------------- the sight

// "Last shot: 32 m short, 6 m right of Rook", in the shooter's own frame:
// along the line from it to the enemy nearest the landing.
function lastShotText(p) {
  const l = events.lastLand.get(p.id);
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
  const p = match.planning();
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
const touch = wantTouch() ? new TouchControls({ parent: $('hud'), unlockAudio: () => sound.ensure(), weaponBar: $('weapon-bar'), online: () => !!online.session }) : null;
if (touch) {
  // No keyboard here: the hints say what to tap instead.
  $('chat-input').placeholder = 'Say something';
}
// The player card, the players box, the banner and the steering hint (src/hud.js).
const hud = new Hud({ game: () => game, touch, peekAt: (p) => rig.peekAt(p) });
// The rangefinder card (src/rangecard.js) and the corner view of your tank while shells fly (src/inset.js).
const rangeCard = new RangeCard({ ranges: events.ranges, believed: (p) => believed(p), peekSpot: (pos) => rig.peekSpot(pos) });
const inset = new Inset({ renderer, scene, touch });
// Double Strike: the ×2 button (X), what Fire will do, and the reload notice (src/strike.js).
const strikeUi = new StrikeUI({ game: () => game, touch, banner, click: () => sound.click(), blocked: () => match.handoffOpen });
// Mods: the deploy buttons (B), the status chips, and the orbiters and satellites in the sky (src/modsui.js).
const bossUi = new BossUI({ game: () => game, touch, banner });
const modsUi = new ModsUI({ game: () => game, scene, camera, touch, banner, click: () => sound.click(), blocked: () => match.handoffOpen, seen: (p) => seen(p) });

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
settings.group('look', 'Graphics', 'Light draws fewer flames, smoke puffs and sparks: smoother on a phone.');
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
  game: () => game, handoff: () => match.handoffOpen, online: () => !!online.session, hopping: (id) => events.hops.has(id),
  openChat: () => online.openChat(), closeHandoff: () => match.closeHandoff(), strike: () => strikeUi.toggle(), deploy: () => modsUi.deployKey(),
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
    const t = match.tanks[i];
    const hurt = 1 - p.hp / p.maxHp;
    // A badly hurt tank (or one just hit) burns and smokes until it is repaired or dies.
    // It burns on the engine deck, on whichever side faces the camera.
    const side = t.hull.worldToLocal(_v.copy(camera.position)).z >= 0 ? 1 : -1;
    t.hull.localToWorld(_v.set(-2.5, 2.4, side * 0.9));
    effects.burn(`tank${i}`, _v.x, _v.y, _v.z, { flame: hurt > 0.65 ? (hurt - 0.5) * 1.3 : 0, smoke: hurt > 0.4 ? 0.3 + hurt * 0.7 : 0, ttl: 0.3, spread: 1.1, size: 1.4 });
    const smoke = match.smoke;
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
    game.players.forEach((p, i) => { if (p.alive) driving = Math.max(driving, match.tanks[i].work / (1 + camDist([p.x, p.y, p.z]) / 160)); });
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
function seen(p, view = match.fogFor) {
  return !view || !p || !p.alive || view.includes(p) || view.some((v) => game.inSight(v, p));
}

// Where this screen believes `p` is: { x, y, z, r, at } with r the radius of
// doubt (0 when seen or last seen), or null when it has no idea.
function believed(p) {
  if (seen(p)) return { x: p.x, y: p.y, z: p.z, r: 0, at: game.turnsThisRound, live: true, id: p.id, name: p.name, color: p.color };
  let best = null;
  for (const v of match.fogFor) {
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
  if (!match.fogFor || seen(game.players[pr.owner])) return false;
  return !pr.roller && pr.vel[1] > 0;
}

function updateFog(dt) {
  const fogFor = match.fogFor = fogView();
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
    if (!show) match.tanks[i].root.visible = false;
    const ring = match.ghosts[i];
    const b = !show ? believed(p) : null;
    ring.visible = !!b;
    marks.ghost(i, b, game);   // its name and how old the sighting is (labels.js)
    if (!b) return;
    ring.position.set(b.x, b.y + 1.5, b.z);
    ring.scale.setScalar(Math.max(8, b.r));
    ring.material.opacity = b.r ? 0.4 : 0.6;
  });
  events.updatePulses(dt);   // the scout pulses spreading out (events.js)
}

// ---------------------------------------------------------------- screens

// Testing aids from the query string (builder.js parseTestParams): forced wind
// and terrain, and the old Lab's mods for everyone. Read once at load: an
// online room rewrites the address.
const testParams = parseTestParams(location.search);
const builder = new MatchBuilder($('opt-groups'));

// The setup card's tank rows, Play and Start (src/setup.js).
const setup = new Setup({ match, get online() { return online; }, sound, touch, testParams, builder });
// The run (runui.js): its map and stops on its own screen, its fights here.
const run = new RunUI({
  startMatch: (config) => match.start(config), toMenu: () => match.toMenu(), name: humanName, click: () => sound.click(), sfx: (cue, o) => sound.cue(cue, 0, o),
  begin: () => { sound.ensure(); phoneFullscreen(touch); if (humanName()) profile.setName(humanName()); },
  showSetup: () => { $('setup').classList.remove('hidden'); setup.render(); },
});

// ---------------------------------------------------------------- online

// A room on the server and the match played through it, the lobby, chat and
// the room list (src/online.js; the clock's and the lobby's rules: netlogic.js).
const online = new Online({ match, setup, sound, banner, touch, input });

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
  online.update();   // the room: its messages, the lobby, the clock (online.js)
  if (game) {
    rig.updateKill(dt);
    lastDt = dt;
    const sdt = dt * rig.timeScale;   // game time: slowed for the kill cam
    input.aim(dt);
    input.steer();
    game.update(sdt);
    events.handle();
    match.terrainMesh.flushPaths?.(renderer);   // upload just the scuffed part of the path mask
    game.players.forEach((p, i) => match.tanks[i].sync(p, game.terrain, sdt));
    events.updateHops(sdt);
    events.updateWrecks(sdt);
    updateFog(dt);
    tankSmoke(dt);
    events.updateShells(game);
    events.fadeTrails(dt);
    updateTracer();
    match.sceneryMesh.sync(elapsed);
    match.cityView?.update(sdt);
    napalmView.update(sdt, game);
    arenaView.update(game, elapsed, dt);
    hud.update(game);
    strikeUi.update();
    bossUi.update();
    bossMark.update(game, elapsed);
    match.fortView?.update(elapsed);
    modsUi.update(sdt, elapsed);
    input.syncFind();
    marks.update(game, { mode: rig.labelMode(game.phase), sight: rig.mode === 'sight', overview: rig.modes.overview, handoff: match.handoffOpen });
    rangeCard.update(game, rangeOwner(game, { handoff: match.handoffOpen, heroId: events.heroId }));
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
  if (!online.session || !document.hidden) return;
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
wireLaunch({ rows: setup.rows, render: () => setup.render(), builder });   // the Custom section and the name field (launch.js)
setup.render();
$('loading').classList.add('hidden');
frame();

// Exposed for debugging from the console.
window.craterfall = { craft, run, match, events, online, get game() { return game; }, startMatch: (config) => match.start(config), muzzleOrigin, camera, controls, renderer, scene, sky, birds, sound, music, effects, tick, held: input.held,
  get tanks() { return match.tanks; }, get camGoal() { return rig.goal; }, rig, get cameraMode() { return rig.mode; },
  get terrainMesh() { return match.terrainMesh; }, get sceneryMesh() { return match.sceneryMesh; }, get cityView() { return match.cityView; },   // for profiling
  lookAt(x, y, z, from) { rig.lookAt(x, y, z, from); },
  release() { rig.release(); },
  get killCam() { return rig.modes.kill; },
  get peek() { return rig.modes.peek; },
  get session() { return online.session; },
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
    ground: () => (game ? match.terrainMesh : menuMesh),
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
