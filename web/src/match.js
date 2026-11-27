import * as THREE from 'three';
import { Game } from './core/game.js';
import { WEAPONS, ITEMS } from './core/weapons.js';
import { MOD_BY_ID } from './core/mods.js';
import { perkSum } from './core/perks.js';
import { fortSpots, ARENA } from './core/boss.js';
import { TerrainMesh, groundShade } from './render/terrainMesh.js';
import { SceneryMesh } from './render/sceneryMesh.js';
import { CityView } from './render/cityMesh.js';
import { TankMesh } from './render/tankMesh.js';
import { BulwarkMesh } from './render/bulwarkMesh.js';
import { FortView } from './render/fortMesh.js';
import { setRidgeWorld } from './render/ridgeline.js';
import { stepperHtml, resultsHtml, skillTreeHtml, skillTabs, skillTabsHtml, kitHtml, armoryHtml } from './armory.js';
import { whose } from './hudlogic.js';
import {
  matchOrder, roundOrder, matchTitle, roundTitle, continueText, hotseatStep, handoffTitle, handoffDoing, handoffText,
  draftDoing, draftSkipText, shopDoneText, shopOpenNote, boughtNote, standingsTable, statsTable, awards,
} from './matchlogic.js';

// The match on screen, from its start to the menu: one Match for the page,
// holding the Game being played (`game`, null on the menu) and what is built
// for it in the scene.
//
//   start(config)   a match from a config: Play, the Custom match, an online
//                   room's start message, a run's fight (runui.js)
//   dispose()       take the match's meshes and marks out of the scene
//   toMenu()        out of the match (and any room) and back to the menu's field
//   again()         the match-over card's button: the menu and the setup card
//
// Between the rounds it runs the cards, in order: round over (2.2 s after the
// round ends, from events.js), then each human of this screen in turn (the
// hot seat, `shopQueue`): the skill tree when there is a draft, then the
// armory; then the next round (online: when the room's host says so). At the
// end of a match: a run's own result card (runui.js), else the match-over card
// (a boss match's standings from bossui.js). The volley hand-off card covers
// the field while two or more humans of this screen plan in turn. What the
// cards say and in which order they list the tanks is matchlogic.js (tested).
//
// main.js gives it the scene's parts and the other modules through `deps`
// (the ones made after it as getters): scene, renderer, camera, effects, sky,
// floor, birds, craft, moons, gravityLines, rain, napalmView, arenaView,
// bossMark, aimArc, sideView, dials, satView, tracer, ring (the fog ghosts'
// geometry), marks, hud, rig, sound, touch, menuMesh, menuScenery, menuField,
// and events, modsUi, bossUi, run, input, online, setup, review; onGame(g)
// hears each new game (and null on the menu).

const $ = (id) => document.getElementById(id);

// The armory, one human at a time. Each item is a card that says what it is,
// what one purchase gives, what the shopper already holds, and has one button.
const SHOP_ITEMS = [...WEAPONS.filter((w) => !w.hidden && !w.infinite), ...ITEMS];

export class Match {
  constructor(deps) {
    this.d = deps;
    this.game = null;
    this.terrainMesh = null;
    this.sceneryMesh = null;
    this.cityView = null;          // the City world's buildings and traffic (render/cityMesh.js)
    this.fortView = null;
    this.tanks = [];
    this.smoke = [];               // per tank: seconds until its next puff
    this.ghosts = [];              // fog: per tank, a ring where this screen last placed it (its label: labels.js)
    this.fogFor = null;            // fog: the tanks this screen sees for, this frame (null: sees everything)
    this.handoffOpen = false;      // volley planning: waiting for the next human to sit down
    this.shopQueue = [];
    this.shopPid = null;           // whose draft or armory is open
    $('handoff-go').onclick = () => { deps.sound.click(); this.closeHandoff(); };
    $('ro-continue').onclick = () => this.continueRound();
    $('mo-again').onclick = () => this.again();
  }

  dispose() {
    const d = this.d;
    if (this.terrainMesh) { d.scene.remove(this.terrainMesh.group); this.terrainMesh.dispose(); }
    if (this.sceneryMesh) { d.scene.remove(this.sceneryMesh.group); this.sceneryMesh.dispose(); this.sceneryMesh = null; }
    this.cityView?.dispose(); this.cityView = null;
    d.arenaView.clear();
    d.bossMark.clear();
    if (this.fortView) { d.scene.remove(this.fortView.group); this.fortView.dispose(); this.fortView = null; }
    this.tanks.forEach((t) => { d.scene.remove(t.root); t.dispose(); });
    this.ghosts.forEach((ring) => { d.scene.remove(ring); ring.material.dispose(); });
    this.ghosts = []; this.fogFor = null;
    groundShade.fogOn.value = 0;
    d.events.clear();   // scout pulses, wrecks, shells and trails, hops, the volley's hero, last landings
    this.closeHandoff();
    d.effects.clear();
    d.napalmView.clear();
    this.tanks = [];
    d.marks.clear();      // the marks, ghosts, edge arrows and pips (labels.js)
    d.moons.set([]);
    d.gravityLines.set([]);
    d.sky.setSpace(false);
    d.sky.setTime('day');      // the menu's own sky
    setRidgeWorld(false, { sky: d.sky, floor: d.floor });
    d.rain.clear();
    d.aimArc.hide();
    d.sideView.hide();
    d.dials.reset();
    d.satView.reset();
    d.modsUi.reset();
    d.floor.visible = d.birds.bodies.visible = d.birds.wings.visible = true;
    d.craft.set(false);
  }

  start(config) {
    const d = this.d;
    this.dispose();
    d.scene.remove(d.menuMesh.group, d.menuScenery.group);
    const game = this.setGame(new Game(config));
    d.sky.setTime(game.cfg.time);      // before the tanks and the city, which light themselves by it
    this.terrainMesh = new TerrainMesh(game.terrain);
    this.sceneryMesh = new SceneryMesh(game.scenery);
    d.scene.add(this.terrainMesh.group, this.sceneryMesh.group);
    if (game.city) d.scene.add((this.cityView = new CityView(game, d.effects)).group);
    d.review?.onMatch();
    d.effects.groundAt = (x, z) => game.terrain.heightAt(x, z);
    this.tanks = game.players.map((p) => {
      const m = p.boss ? new BulwarkMesh(p.color) : new TankMesh(p.color);
      m.root.scale.setScalar(p.size || 1);   // the boss is bigger
      d.scene.add(m.root);
      return m;
    });
    this.smoke = game.players.map(() => 0);
    d.sky.fit(game.terrain.half);
    d.marks.start(game);   // each tank's mark, fog ghost and edge arrow (labels.js)
    this.ghosts = game.players.map((p) => {
      const ring = new THREE.Mesh(d.ring, new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 5;
      ring.visible = false;
      d.scene.add(ring);
      return ring;
    });
    d.rig.modes.endLook();
    d.hud.start(game);
    // The boss's fort: coloured ground (before the round builds) and rim props, drawn only.
    if (game.cfg.boss) this.terrainMesh.setFort(fortSpots(ARENA.boss[0] * game.terrain.half, ARENA.boss[1] * game.terrain.half), ARENA.fort.skirt);
    game.start();
    d.events.handle();      // builds the round (terrain, scenery, water) so the warm-up sees it
    if (game.fort) d.scene.add((this.fortView = new FortView(game)).group);
    d.hud.show(true);
    // Compile every shader the match can need now, while the screen is changing
    // anyway, rather than the first time a fog ring or explosion shows up.
    d.effects.warm(d.renderer, d.camera);
  }

  // Out of the match and back to the menu's field (the launch screen is the caller's).
  toMenu() {
    const d = this.d;
    d.online.leave();
    this.closeHandoff();
    d.hud.show(false);
    this.dispose();
    this.setGame(null);
    d.rig.cutKill();
    d.scene.add(d.menuMesh.group, d.menuScenery.group);
    d.tracer.visible = false;
    d.sky.fit(d.menuField.terrain.half);
    d.birds.reset(d.menuField.terrain, 5);
  }

  // The match-over card's button (and the online "match ended" card's): back to the setup card.
  again() {
    $('matchover').classList.add('hidden');
    this.toMenu();
    $('setup').classList.remove('hidden');
    this.d.setup.render();
  }

  // main.js keeps its own `game` in step (deps.onGame).
  setGame(g) {
    this.game = g;
    this.d.onGame?.(g);
    return g;
  }

  // The tank this screen is planning a shot for, or null.
  planning() {
    const game = this.game;
    if (!game || this.handoffOpen || game.phase !== 'aim') return null;
    const p = game.current;
    return p && p.alive && game.isLocal(p) ? p : null;
  }

  // ---------------------------------------------------------------- volley hand-off

  // More than one human is planning: cover the field until the next one is ready.
  openHandoff(p) {
    this.handoffOpen = true;
    this.d.input.held.clear();
    $('handoff-card').style.borderTopColor = p.color;
    $('handoff-swatch').style.background = p.color;
    $('handoff-title').textContent = handoffTitle(p);
    $('handoff-step').textContent = this.hotseatStep(p, handoffDoing(this.game.turnsThisRound));
    $('handoff-text').textContent = handoffText(this.d.touch);
    $('handoff').classList.remove('hidden');
  }

  closeHandoff() {
    if (!this.handoffOpen) return;
    this.handoffOpen = false;
    $('handoff').classList.add('hidden');
  }

  hotseatStep(p, doing) { return hotseatStep(this.game.localHumans, p, doing); }

  // ---------------------------------------------------------------- between rounds

  // The round-over card, or at the end the match's: a run's own (runui.js), else
  // the match-over card (a boss match's standings from bossui.js).
  showRoundResult(kind) {
    const game = this.game;
    if (!game) return;
    const d = this.d;
    const w = game.lastRoundResult.winner != null ? game.players[game.lastRoundResult.winner] : null;
    if (kind === 'matchOver') {
      if (d.run.matchOver(game)) return;   // a run's fight: the run's own result card
      const boss = d.bossUi.matchResult();   // a boss match is teams, not wins and funds
      const sorted = boss ? boss.order : matchOrder(game.players);
      $('mo-title').textContent = boss ? boss.title : matchTitle(sorted[0]);
      $('mo-table').innerHTML = boss ? boss.table : standingsTable(sorted);
      $('mo-stats').innerHTML = statsTable(sorted);
      $('mo-awards').innerHTML = awards(game.players);
      d.online.result(game);   // the host's, for the players' records
      $('matchover').classList.remove('hidden');
      return;
    }
    $('ro-title').textContent = roundTitle(game.round, w);
    $('ro-continue').textContent = continueText(game);
    $('ro-steps').innerHTML = stepperHtml('results', { draft: game.draftOn, round: game.round });
    $('ro-table').innerHTML = resultsHtml(roundOrder(game.players));
    $('roundover').classList.remove('hidden');
  }

  continueRound() {
    const game = this.game;
    $('roundover').classList.add('hidden');
    this.shopQueue = game.localHumans.map((p) => p.id);
    game.openShop();
    if (game.phase === 'shop') this.nextShopper();
  }

  // Each human in turn: pick a perk (if one is on offer), then shop.
  nextShopper() {
    const game = this.game;
    const pid = this.shopQueue.shift();
    this.shopPid = pid ?? null;
    $('draft').classList.add('hidden');
    $('shop').classList.add('hidden');
    if (pid == null) {
      const session = this.d.online.session;
      if (session) for (const p of game.localHumans) session.shopDone(p.id);   // the host closes the armory for everyone
      else game.closeShop();
      return;
    }
    if (game.draft[pid]) this.openDraftFor(pid); else this.openShopFor(pid);
  }

  // The skill tree (src/armory.js skillTreeHtml): spend skill points on the
  // next rank of any branch, or save them; then the armory. Its tabs (Weapons,
  // Mods, Tank) sit at the top of the grid.
  openDraftFor(pid) {
    const game = this.game;
    const { sound } = this.d;
    const p = game.players[pid];
    const toShop = () => { $('draft').classList.add('hidden'); this.openShopFor(pid); };
    let tab = skillTabs(game, p)[0]?.id || null;
    const render = () => {
      const n = p.points;
      $('draft-step').textContent = this.hotseatStep(p, draftDoing(n));
      $('draft-owned').innerHTML = kitHtml(game, p);
      $('draft-items').innerHTML = skillTabsHtml(game, p, tab) + skillTreeHtml(game, p, tab);
      $('draft-skip').textContent = draftSkipText(n);
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

  openShopFor(pid) {
    const game = this.game;
    const { sound } = this.d;
    const p = game.players[pid];
    const next = this.shopQueue.length ? game.players[this.shopQueue[0]] : null;
    $('shop').classList.remove('hidden');
    $('shop-card').style.borderTopColor = p.color;
    $('shop-swatch').style.background = p.color;
    $('shop-player').textContent = whose(p, 'armory');
    $('shop-step').textContent = this.hotseatStep(p, `shopping for round ${game.round + 1}`);
    $('shop-steps').innerHTML = stepperHtml('armory', { draft: game.draftOn, round: game.round });
    $('shop-done').textContent = shopDoneText(next, !!this.d.online.session, game.round);
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
      note(boughtNote(it, level, price, p.money), true);
      const funds = $('shop-money');
      funds.classList.remove('pulse');
      void funds.offsetWidth;   // restart the animation
      funds.classList.add('pulse');
    };
    render();
    note(shopOpenNote(SHOP_ITEMS.some((it) => game.priceOf(p, it.id) <= p.money), !!perkSum(p, 'discount')));   // mod upgrades aside
    $('shop-done').onclick = () => this.nextShopper();
  }
}
