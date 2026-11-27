// The camera's mode: what the player chose (follow, sight, overview, a look),
// what the game forced (the kill cam), and which one is driving this frame.
// Pure: no three.js, no DOM, no clock of its own (callers pass `now`), so it is
// testable (test/cameramode.test.js). src/camera.js moves the camera for each mode.
// decidingShot() at the end, the kill cam's trigger, reads the game (src/core) only.
//
// The state is a handful of choices, each with its own enter and exit rules:
//
//   follow    C toggles it. On: shells in flight pull the camera along and the
//             kill cam may start. Kept across turns and matches.
//   sight     G / SIGHT toggles it. Wanted while you plan; it drives the camera
//             only when nothing above it in the list below does. Entering it
//             leaves the overview. Kept across turns and matches.
//   overview  V / View toggles it. Left by a look (Find, a mark, the range card)
//             or by entering the sight. Kept until then (a new match included).
//   peek      a look at another tank or a spot while planning: three seconds,
//             or held by Find until it moves past the last enemy. Ends when the
//             time is up, the planning ends or the turn passes.
//   kill      the deciding shot's slow motion. Starts in flight, following,
//             outside the overview and unpinned; ends 1.6 s after its shell is
//             gone, or at once on a new round or the menu.
//   pinned    debug (window.craterfall.lookAt / release): holds the camera still.
//             The modes still resolve (the HUD follows them), but nothing moves
//             the camera, the sight stays off and the kill cam does not start.
//
// Each frame resolve() picks the one mode that drives the camera, in priority order:
//
//   menu      no match: the slow orbit over the menu's field
//   kill      the kill cam
//   overview  the View map
//   sight     the gunner's sight, while this screen plans a shot
//   hero      a volley with one human here: ride that human's shell
//   volley    a volley on a shared screen: stand back to frame every shell
//   follow    turn-based flight: the middle of the shells in sight
//   peek      a look (Find, a mark, the range card)
//   plan      setting up a shot: the tank whose turn it is
//   hold      anything else (settling, between rounds): stay where it is
//
// The HUD's view (src/hudview.js hudView) and the marks over the tanks
// (labelMode below) read the mode, not the separate flags.

import { TANK, hitSphere } from './core/tank.js';
import { stepProjectile, groundContact, burstNow } from './core/ballistics.js';
import { blastDamage, rollPart } from './core/weapons.js';
import { perkSum } from './core/perks.js';

export const MODES = ['menu', 'kill', 'overview', 'sight', 'hero', 'volley', 'follow', 'peek', 'plan', 'hold'];

export const LOOK_MS = 3000;      // a click on a mark or the range card looks this long
export const KILLCAM = { lead: 1.1, slow: 0.28, after: 1.6 };   // forecast horizon (s), slow-motion speed, hold after the shell lands (s)

export class CameraModes {
  constructor() {
    this.follow = true;
    this.sight = false;
    this.overview = false;
    this.pinned = false;
    this.peek = null;     // { id, who, until, x?, y?, z?, fogId? }: id null for a spot
    this.kill = null;     // { id, victim, side: [x, z], dir: [x, z], end, shell?, pull? }
  }

  // ---- the player's choices

  toggleFollow() { this.follow = !this.follow; return this.follow; }

  toggleSight() {
    this.sight = !this.sight;
    if (this.sight) this.overview = false;
    return this.sight;
  }

  toggleOverview() { this.overview = !this.overview; return this.overview; }

  // A look: at tank `id` (or a spot, id null) for whoever is planning (`who`).
  look({ id = null, who = null, x, y, z, hold = false, now }) {
    this.peek = { id, who, until: hold ? Infinity : now + LOOK_MS };
    if (id == null) Object.assign(this.peek, { x, y, z });
    this.overview = false;
    return this.peek;
  }

  endLook() { this.peek = null; }

  // Whether the look is still on; drops it once its time is up, the planning
  // has ended (phase) or the turn has passed (current: the planner's id).
  lookLive({ phase, current, now }) {
    const p = this.peek;
    if (p && (phase !== 'aim' || p.who !== current || now >= p.until)) this.peek = null;
    return !!this.peek;
  }

  // Find is holding the camera on a tank (its button is lit).
  finding(world) { return !!this.peek && this.peek.until === Infinity && this.lookLive(world); }

  // ---- debug

  pin() { this.pinned = true; }
  release() { this.pinned = false; }

  // ---- the kill cam

  canKill(phase) { return !this.kill && phase === 'flight' && this.follow && !this.overview && !this.pinned; }
  startKill(k) { this.kill = { ...k, end: null }; return this.kill; }

  // Once its shell is gone the kill cam holds a moment, then ends. Returns true
  // on the frame it ends.
  stepKill({ shellGone, now }) {
    const k = this.kill;
    if (!k) return false;
    if (k.end == null && shellGone) k.end = now + KILLCAM.after * 1000;
    if (k.end != null && now > k.end) { this.kill = null; return true; }
    return false;
  }

  cutKill() { this.kill = null; }

  // ---- what reads the state

  // The corner inset of your own tank: only while the camera is off following shells.
  insetAllowed() { return !this.overview && this.follow && !this.pinned && !this.kill; }

  // The mode driving the camera this frame. `world`:
  //   inMatch      a match is on
  //   phase        the game's phase
  //   planner      this screen is planning a shot (a local, living tank in 'aim', no hand-off card)
  //   current      the id of the tank whose turn it is (null for none)
  //   volleyMode   the match fires in volleys
  //   hero         a volley with one human here (whose shell the camera rides)
  //   shellsInAir  any projectile is in the air
  //   shellsShown  any projectile is in the air and may be shown (fog hides some)
  //   now          ms, for the look's timer
  // It drops a look that has run out (lookLive).
  resolve(world) {
    const { inMatch, phase, planner, current, volleyMode, hero, shellsInAir, shellsShown } = world;
    if (!inMatch) return 'menu';
    if (this.kill) return 'kill';
    if (this.overview) return 'overview';
    if (this.sight && !this.pinned && planner) return 'sight';
    const volleyBeat = volleyMode && this.follow && (phase === 'volley' || (phase === 'flight' && shellsInAir));
    if (volleyBeat) return hero ? 'hero' : 'volley';
    if (phase === 'flight' && this.follow && shellsShown) return 'follow';
    if (phase === 'aim' && current != null) return this.lookLive(world) ? 'peek' : 'plan';
    return 'hold';
  }
}

// How much the marks over the tanks say: health only where you are sizing the
// field up (the sight, the overview, a look), faint while a shell is followed,
// names alone otherwise and in the kill cam. `sight`: the sight drove the
// camera on the last frame; `looking`: a look is on (lookLive).
export function labelMode(modes, { phase, sight = false, looking = false }) {
  if (modes.kill) return 'name';
  if (sight || modes.overview || looking) return 'full';
  if (phase !== 'aim' && modes.follow) return 'faint';
  return 'name';
}

// Game speed in the kill cam: eases into the slow motion over a few tenths of
// a second and back out more gently, on the real clock (dt), so it feels the
// same at any frame rate.
export function easeTimeScale(scale, kill, dt) {
  const goal = kill && kill.end == null ? KILLCAM.slow : kill ? 0.55 : 1;
  const tau = goal < scale ? 0.22 : 0.45;
  const next = scale + (goal - scale) * (1 - Math.exp(-dt / tau));
  return Math.abs(goal - next) < 0.002 ? goal : next;
}

// The side the kill cam watches from: square to the incoming line (shell at
// `from` [x, z] to the victim at `to` [x, z]), on the side the camera (`cam`
// [x, z]) is already on. Returns { side, dir }.
export function killSide(from, to, cam) {
  let dx = to[0] - from[0], dz = to[1] - from[1];
  const n = Math.hypot(dx, dz) || 1;
  dx /= n; dz /= n;
  let side = [-dz, dx];
  if ((cam[0] - to[0]) * side[0] + (cam[1] - to[1]) * side[1] < 0) side = [dz, -dx];
  return { side, dir: [dx, dz] };
}

// Where a projectile comes down within `horizon` seconds if nothing changes.
// `burst`: the Airburst's height, where it goes off over the ground (ballistics.burstNow).
function forecast(game, pr, horizon, burst = 0) {
  const c = { pos: [...pr.pos], prev: [...pr.pos], vel: [...pr.vel], time: 0, g: pr.g, windK: pr.windK, drag: pr.drag, edge: pr.edge };
  const t = game.terrain;
  const step = 1 / 30;
  for (let s = step; s <= horizon; s += step) {
    stepProjectile(c, game.wind, step);
    if (c.crossed?.kind === 'wall') return { t: s, pos: c.crossed.point, direct: null };
    if (!t.inBounds(c.pos[0], c.pos[2])) return null;
    if (burst && burstNow(c, t, burst)) return { t: s, pos: [...c.pos], direct: null };
    for (const p of game.players) {
      if (!p.alive || (p.id === pr.owner && pr.time + s < 0.5)) continue;   // the shooter's grace, as in the game
      const h = hitSphere(p);
      if ((c.pos[0] - h.x) ** 2 + (c.pos[1] - h.y) ** 2 + (c.pos[2] - h.z) ** 2 <= h.r * h.r) return { t: s, pos: [...c.pos], direct: p };
    }
    const g = groundContact(c, t);
    if (g) return g.sea ? null : { t: s, pos: g, direct: null };
  }
  return null;
}

// The shell that will decide the round, if one is about to: its blast, within
// KILLCAM.lead seconds, would leave at most one tank standing.
// Returns { id, victim, t, from } or null.
export function decidingShot(game) {
  const alive = game.players.filter((p) => p.alive);
  if (alive.length < 2) return null;
  const dying = new Set();
  let pick = null;
  for (const pr of game.projectiles) {
    if (pr.dead || pr.probe || pr.roller) continue;
    const w = game.weaponOf(pr.owner, pr.weapon);
    const blast = w.impact?.find((i) => i.type === 'blast');
    if (!blast || rollPart(w) || (!pr.splitDone && w.flight?.some((f) => f.type === 'split' || f.type === 'airburst'))) continue;
    const hit = forecast(game, pr, KILLCAM.lead, game.burstHeight(pr.owner, pr.weapon));
    if (!hit) continue;
    const o = game.players[pr.owner];
    const radius = blast.radius * (1 + perkSum(o, 'blastRadius'));
    const damage = blast.damage * (1 + perkSum(o, 'blastDamage'));
    for (const p of alive) {
      const h = hitSphere(p);
      const d = p === hit.direct ? 0 : Math.max(0, Math.hypot(h.x - hit.pos[0], blast.flat ? 0 : h.y - hit.pos[1], h.z - hit.pos[2]) - TANK.hitRadius * 0.5);
      if (blastDamage(d, radius, damage) < p.hp + p.armor) continue;
      dying.add(p.id);
      if (!pick || hit.t < pick.t) pick = { id: pr.id, victim: p.id, t: hit.t, from: pr.owner };
    }
  }
  return pick && alive.length - dying.size <= 1 ? pick : null;
}
