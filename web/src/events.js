import * as THREE from 'three';
import { WEAPON_BY_ID, rollPart } from './core/weapons.js';
import { JET } from './core/tank.js';
import { ROLL } from './core/ballistics.js';
import { BUILDINGS } from './core/scenery.js';
import { isArtifact } from './core/artifacts.js';
import { modPos } from './core/mods.js';
import { ShellVisual } from './render/effects.js';
import { Wreck } from './render/wreck.js';
import { setRidgeWorld } from './render/ridgeline.js';
import { cuesFor } from './sfxmap.js';
import { useHint } from './hints.js';
import {
  lockedBanner, volleyBanner, volleyHero, needsHandoff, firstTurnHints, lostBanner, landingPip, voidBanner, destroyedBanner,
  scoutBannerShows, SCOUT_BANNER, propScale, nearestBlast, addDirty,
} from './eventlogic.js';

// The Game's events on screen. Every frame main.js drains the game's events
// through handle(); each goes first to the modules that keep their own
// (strike.js, bossui.js, modsui.js, the sounds of sfxmap.js, the City, Napalm,
// the arena), then to the switch below, which turns it into effects, sounds,
// banners, marks over the tanks and calls on the camera (turn, volley,
// cutKill, shake) and the match (the hand-off card, the round-over card).
// Which events say what, and when, is eventlogic.js (tested).
//
// It also keeps what the events leave behind for a while, and moves it each
// frame: the shells in the air and their fading trails (`shells`), wrecks,
// jump-jet hops (`hops`), scout pulses, the rangefinder's readings (`ranges`,
// read by rangecard.js), where each tank's last shot came down (`lastLand`,
// for the sight) and the volley's hero (`heroId`: the one human of this
// screen in a volley, whose shell the camera rides; null when several share
// the screen). clear() drops them with the match.
//
// main.js gives it, through `deps` (getters for the modules made after it):
// match, scene, effects, sound, camDist(pos), rig, hud, banner, marks, inset,
// birds, sky, floor, craft, moons, gravityLines, napalmView, arenaView, touch,
// strikeUi, bossUi, modsUi, seen(p, view), fogView(), shellHidden(pr),
// shellPos(pr), ring (the scout pulse's geometry) and setDay(k).

export class MatchEvents {
  constructor(deps) {
    this.d = deps;
    this.shells = new Map();       // projectile id -> ShellVisual
    this.fadingTrails = [];        // finished shells' trails, fading out
    this.wrecks = [];
    this.pulses = [];              // fog: scout bursts spreading out
    this.hops = new Map();         // tank id -> the jump jet hop being drawn: { from, to, t, dur, puff }
    this.ranges = new Map();       // tank id -> its last rangefinder shot: { probes, elev, at, wind }
    this.lastLand = new Map();     // tank id -> where its last shot came down: { shot, pos, at }
    // A volley with one human in it: the camera rides that human's shell and every
    // other tank's landing gets a pip (labels.js addPip). Null when several humans share
    // the screen; then the camera stands back to frame every shell instead.
    this.heroId = null;
    this.hintGame = null;          // the game whose first-turn hints have been decided
    // Blasts seen in this batch of events, so a tank that dies to one knows
    // which way it was thrown.
    this.recentBlasts = [];
    this.fellInVoid = new Set();   // players whose 'void' banner is up, so their death banner stays quiet
    // Craters of one frame, merged (eventlogic.js addDirty) and rebuilt once each.
    this.dirty = [];
    // The sounds a game event asks for (sfxmap.js: the boss, the mods, Flak and
    // the splitting shells; the rest play from the cases below).
    this.cueCtx = {
      mine: (id) => { const game = this.d.match.game; return !!game?.players[id] && game.isLocal(game.players[id]); },
      at: (id, mod) => { const p = this.d.match.game.players[id]; return p ? modPos(p, mod) || [p.x, p.y, p.z] : null; },
    };
  }

  // Everything the events leave behind, with the match.
  clear() {
    const { scene } = this.d;
    this.pulses.forEach((q) => { scene.remove(q.mesh); q.mesh.material.dispose(); });
    this.pulses = [];
    this.wrecks.forEach((w) => w.dispose());
    this.shells.forEach((s) => { scene.remove(s.mesh, s.line); });
    this.shells.clear();
    this.clearTrails();
    this.hops.clear();
    this.wrecks = [];
    this.heroId = null;
    this.lastLand.clear();
  }

  playCues(e) {
    const { sound, camDist } = this.d;
    for (const c of cuesFor(e, this.cueCtx)) sound.cue(c.cue, c.pos ? camDist(c.pos) : 0, c);
  }

  banner(b) { if (b) this.d.banner(...b); }

  // The game's events of this frame, each to whatever it sets off.
  handle() {
    const d = this.d;
    const { match, effects, sound, camDist, rig, hud, marks, birds, touch } = d;
    const game = match.game;
    const seen = d.seen;
    this.recentBlasts.length = 0;
    for (const e of game.drainEvents()) {
      d.strikeUi.event(e);
      d.bossUi.event(e);
      d.modsUi.event(e);
      this.playCues(e);
      match.cityView?.event(e);
      d.napalmView.event(e);
      if (e.type === 'buried' && touch && game.localHumans.some((h) => h.id === e.player)) touch.note(`${game.players[e.player].name}: buried! Your next shot digs you out`, 3500);
      d.arenaView.event(e);
      if (e.type === 'edge' && e.kind === 'wrap' && this.shells.has(e.id)) this.fadingTrails.push(this.shells.get(e.id).cut(e.pos, e.to));   // no trail across the map
      if (e.type === 'building' && e.how !== 'hit') { sound.thud(camDist(e.pos)); if (e.how === 'collapse') rig.shake(e.pos, 1.6); }
      switch (e.type) {
        case 'roundStart':
          this.wrecks.forEach((w) => w.dispose());
          this.wrecks = [];
          this.clearTrails();
          marks.clearPips();
          this.ranges.clear();
          this.hops.clear();
          rig.cutKill();
          effects.clear();
          d.napalmView.clear();
          d.setDay((e.round - 1) / game.cfg.rounds);
          birds.reset(game.terrain, e.round * 7 + game.players.length);
          hud.roundStart(game, e.round);
          break;
        case 'terrain':
          if (e.full) {
            this.dirty.length = 0;
            match.terrainMesh.rebuild();
            match.sceneryMesh.rebuild();
            match.terrainMesh.setPaths(game.scenery.paths, game.town);
            d.sky.setSpace(!!game.terrain.under);
            setRidgeWorld(!!game.terrain.ridge, { sky: d.sky, floor: d.floor });
            d.floor.visible = !game.terrain.under;   // nothing under the isles but space
            birds.bodies.visible = birds.wings.visible = !game.terrain.under;
            d.craft.set(!!game.terrain.under, game.terrain.half);
            d.moons.set(game.terrain.wells);
            d.gravityLines.set(game.terrain.wells);
          }
          else addDirty(this.dirty, e.region);
          break;
        case 'turn': {
          const p = game.players[e.player];
          rig.turn(p, seen(p, d.fogView()));   // a new planner gets the camera back
          // In a volley a "turn" is one tank's go at planning (or a CPU driving).
          // On a phone the "tap Lock in" line is taught the first few turns, then the banner is just the title (hints.js).
          const coach = !(touch && e.plan && !p.ai) || useHint('lockin', 6);
          if (needsHandoff(e, p, game.localHumans)) { match.openHandoff(p); break; }
          hud.turn(p, { plan: e.plan, coach });   // once the round's banner has been read
          // The first turn of a match: the pad's "drag" line and the SIGHT note show only the first few matches (hints.js).
          if (firstTurnHints({ touch, p, game, hinted: this.hintGame })) {
            this.hintGame = game;
            touch.setPadHelp(useHint('pad', 5));
            if (useHint('sight', 3)) {
              setTimeout(() => { const g = match.game; if (g?.current === p && g.phase === 'aim') touch.note('SIGHT looks down your barrel; drag there to aim', 4500); },
                hud.holdLeft() + 1800);
            }
          }
          break;
        }
        case 'locked':
          sound.click();
          this.banner(lockedBanner(e.pass));
          break;
        case 'volley': {
          match.closeHandoff();
          this.heroId = volleyHero(game.localHumans, e.players);
          if (this.heroId != null) rig.volley(game.players[this.heroId]);
          this.banner(volleyBanner(e.players.length));
          break;
        }
        case 'aimReset':
          if (game.current?.id === e.player) hud.note('Moved: last aim cleared', 1800);
          break;
        case 'jump':
          this.startHop(e);
          break;
        case 'warp': {
          this.hops.delete(e.player);
          const q = game.players[e.player];
          if (seen(q)) {
            effects.warp(e.from);
            effects.warp(e.to);
          }
          sound.warp(camDist(e.to));
          break;
        }
        case 'fire': {
          this.hops.delete(e.player);   // it shoots from where it stands, so a hop in the air is over
          // Its next shot retires a tank's rangefinder marks.
          marks.retireProbes(e.player);
          if (e.weapon === 'ranger') {
            const p = game.players[e.player];
            this.ranges.set(e.player, { probes: {}, elev: p.elev, at: [p.x, p.z], wind: [...game.wind] });
          } else this.ranges.delete(e.player);
          // A volley's shots leave together; their flash and crack are spread a touch.
          const go = () => {
            const g = match.game;
            if (!g || !match.tanks[e.player]) return;
            if (!seen(g.players[e.player])) return;
            effects.muzzleFlash(e.pos);
            match.tanks[e.player].kick();
            rig.shake(e.pos, 0.6);
          };
          sound.fire(camDist(e.pos), e.delay);
          birds.scare(e.pos, 70);
          if (e.delay) setTimeout(go, e.delay * 1000); else go();
          break;
        }
        case 'projectile': {
          const pr = game.projectiles.find((q) => q.id === e.id);
          const owner = pr ? game.players[pr.owner] : null;
          const v = new ShellVisual(d.scene, owner ? owner.color : '#ffffff', { ball: rollPart(WEAPON_BY_ID[e.weapon]) ? ROLL.radius : 0, probe: !!pr?.probe });
          v.owner = owner ? owner.id : null;
          v.probe = pr?.probe || null;
          v.shot = e.shot;
          if (pr && !d.shellHidden(pr)) v.push(pr.pos);
          this.shells.set(e.id, v);
          break;
        }
        case 'split':
          effects.muzzleFlash(e.pos);   // its pop is a cue (sfxmap.js)
          this.retireShell(e.id);
          break;
        case 'intercept':   // Point Defense shot it down (modsui.js draws the rest)
          sound.ping(camDist(e.pos));
          this.retireShell(e.id, e.pos);
          break;
        case 'impact':
        case 'lost': {
          const v = this.shells.get(e.id);
          const owner = v?.owner;
          if (v?.probe) {
            if (e.type === 'impact') {
              marks.addProbePip(game, owner, e.pos, v.probe);
              sound.ping(camDist(e.pos));
              const r = this.ranges.get(owner);
              if (r) r.probes[v.probe.key] = { ...v.probe, pos: [...e.pos] };
            }
          } else if (landingPip(e, { volleyMode: game.volleyMode, heroId: this.heroId, owner })) marks.addPip(game, owner, e.pos);
          if (!v?.probe && owner != null) this.noteLanding(owner, v?.shot, e.type === 'impact' ? e.pos : null);
          this.retireShell(e.id, e.type === 'impact' ? e.pos : null);
          this.banner(lostBanner(e, { probe: v?.probe, phase: game.phase, heroId: this.heroId, owner, isles: game.isles }));
          break;
        }
        case 'explosion':
          this.recentBlasts.push(e);
          effects.explosion(e.pos, e.radius);
          sound.explode(e.radius, camDist(e.pos));
          birds.scare(e.pos, 90 + e.radius * 5);
          rig.shake(e.pos, e.radius / 6);
          break;
        case 'scout':
          this.scoutPulse(e);
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
            const big = propScale(e.how);
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
          if (d.inset.for === e.player) d.inset.flash(e.amount);
          // Name the victim on the shooter's pip.
          marks.pipHit(game, e.by, e.player, this.heroId);
          break;
        }
        case 'void': {
          const q = game.players[e.player];
          this.banner(voidBanner(q, this.heroId, e.sea));
          this.fellInVoid.add(e.player);   // its 'destroyed' follows at once and must not take the banner
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
          const blast = nearestBlast(this.recentBlasts, p);
          const w = new Wreck(d.scene, match.tanks[e.player], blast, effects, (x, z) => game.terrain.heightAt(x, z));
          w.onLand = (at, heavy) => sound.thud(camDist([at.x, at.y, at.z]) * (heavy ? 1 : 1.6), 'wreck');
          this.wrecks.push(w);
          if (!this.fellInVoid.delete(e.player)) this.banner(destroyedBanner(p, by));
          break;
        }
        case 'roundOver':
        case 'matchOver':
          setTimeout(() => match.showRoundResult(e.type), 2200);
          break;
        default:
          break;
      }
    }
    this.flushDirty();
  }

  // The ground in the core is already final when the craters are drained, so
  // nothing is lost by rebuilding each merged box once.
  flushDirty() {
    const mesh = this.d.match.terrainMesh;
    for (const r of this.dirty) { mesh.updateRegion(r); mesh.scuffPaths(r); }
    this.dirty.length = 0;
  }

  // ---------------------------------------------------------------- shells

  retireShell(id, at) {
    const v = this.shells.get(id);
    if (!v) return;
    if (at) v.push(at);
    this.fadingTrails.push(v.finish());
    this.shells.delete(id);
  }

  // Each frame: the shells in the air follow their projectiles (hidden in the fog while they climb).
  updateShells(game) {
    const { shellHidden, shellPos, birds } = this.d;
    for (const pr of game.projectiles) {
      const sv = this.shells.get(pr.id);
      if (sv && shellHidden(pr)) sv.mesh.visible = false;
      else sv?.push(shellPos(pr));
      if (!pr.roller) birds.scare(pr.pos, 28);
    }
  }

  // A shell's trail lingers a moment after it lands, then fades away.
  fadeTrails(dt) {
    const trails = this.fadingTrails;
    for (let i = trails.length - 1; i >= 0; i--) {
      const line = trails[i];
      line.material.opacity -= dt * 0.25;
      if (line.material.opacity <= 0) { this.dropTrail(line); trails.splice(i, 1); }
    }
  }

  dropTrail(line) {
    this.d.scene.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }

  clearTrails() {
    this.fadingTrails.forEach((line) => this.dropTrail(line));
    this.fadingTrails.length = 0;
  }

  // Where a tank's shot came down, kept for its next turn. Only the first
  // landing of each shot counts (a cluster's bomblets follow it down).
  noteLanding(owner, shot, pos) {
    const was = this.lastLand.get(owner);
    if (was && was.shot === shot) return;
    const p = this.d.match.game.players[owner];
    this.lastLand.set(owner, { shot, pos: pos && [...pos], at: [p.x, p.z] });
  }

  // ---------------------------------------------------------------- wrecks, jump jets, scouts

  updateWrecks(dt) {
    for (const w of this.wrecks) w.update(dt);
  }

  startHop(e) {
    const { match, effects, sound, camDist, rig } = this.d;
    this.hops.set(e.player, { from: e.from, to: e.to, t: 0, dur: e.flight || JET.flight, puff: 0 });
    if (!this.d.seen(match.game.players[e.player])) return;
    effects.dust(e.from, 5);
    effects.jetFlame({ x: e.from[0], y: e.from[1] + 0.5, z: e.from[2] });
    sound.jet(camDist(e.from));
    rig.shake(e.from, 0.4);
  }

  // Each frame, put the hopping tanks along their arcs (over what `sync` just did).
  updateHops(dt) {
    const { match, effects, sound, camDist, rig, seen } = this.d;
    const game = match.game;
    for (const [id, h] of this.hops) {
      const t = match.tanks[id];
      h.t += dt;
      const s = Math.min(1, h.t / h.dur);
      const lerp = (a, b) => a + (b - a) * s;
      const x = lerp(h.from[0], h.to[0]);
      const z = lerp(h.from[2], h.to[2]);
      const y = lerp(h.from[1], h.to[1]) + 4 * JET.apex * s * (1 - s);
      t.root.position.set(x, y, z);
      t.layBlob(game.terrain);   // the Low blob stays on the ground under the arc
      if (s < 0.6 && (h.puff -= dt) <= 0 && seen(game.players[id])) {
        h.puff = 0.04;
        effects.jetFlame({ x, y: y + 0.3, z });
      }
      if (s >= 1) {
        this.hops.delete(id);
        if (seen(game.players[id])) {
          effects.dust(h.to, 6);
          effects.dust(h.to, 9);
          sound.thud(camDist(h.to));
          rig.shake(h.to, 0.7);
        }
      }
    }
  }

  // A scout bursts: a bright ring spreads over what it lights up (for its owner's
  // screen; anyone else just sees a flash where it landed).
  scoutPulse(e) {
    const { match, effects, sound, camDist, scene } = this.d;
    effects.muzzleFlash(e.pos);
    sound.ping(camDist(e.pos));
    const fogFor = match.fogFor;
    const mine = !fogFor || fogFor.some((v) => v.id === e.owner);
    if (!mine) return;
    const mesh = new THREE.Mesh(this.d.ring, new THREE.MeshBasicMaterial({ color: '#bff3ff', transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 6;
    mesh.position.set(e.pos[0], e.pos[1] + 2, e.pos[2]);
    scene.add(mesh);
    this.pulses.push({ mesh, r: e.radius, t: 0 });
    if (scoutBannerShows(match.game.volleyMode, this.heroId, e.owner)) this.d.banner(...SCOUT_BANNER);
  }

  // Each frame, the scout pulses spread and fade.
  updatePulses(dt) {
    const { scene } = this.d;
    const pulses = this.pulses;
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i];
      q.t += dt;
      const k = Math.min(1, q.t / 1.1);
      q.mesh.scale.setScalar(Math.max(1, q.r * (1 - (1 - k) ** 3)));
      q.mesh.material.opacity = 0.85 * (1 - k * k);
      if (k >= 1) { scene.remove(q.mesh); q.mesh.material.dispose(); pulses.splice(i, 1); }
    }
  }
}
