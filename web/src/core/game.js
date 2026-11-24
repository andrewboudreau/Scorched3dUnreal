import { makeRng } from './rng.js';
import { Heightfield, ISLES } from './terrain.js';
import { makeProjectile, stepProjectile, groundContact, wellContact, launchVelocity, makeRoller, stepRoller, ROLL, SIM_DT, MAX_FLIGHT, GRAVITY } from './ballistics.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS, startKit, opensOnVisit, impactEffects, rollPart, blastDamage, splitVelocities, rangeProbes, airburstNow, airburstNearMod, airburstVelocities } from './weapons.js';
import { TANK, JET, muzzleOrigin, hitSphere, clampAim, driveStep, planHop, findSpot } from './tank.js';
import { planShot, planDrive, planJump, chooseTarget, chooseWeapon, chooseSecondWeapon, wantsDouble, misjudgeField, holeDepth, unsureOf, planHeap, findWarp, planPlace, readRange, steerGuided, satelliteSharpen, wantsSatellite, cpuTemper, TEMPERS, UTILITY, ARSENAL } from './ai.js';
import { Scenery, standing } from './scenery.js';
import { generateRidgeline, keepCrust, rowStarts } from './ridgeline.js';
import { PERKS, PERK_BY_ID, MODIFIERS, MODIFIER_BY_ID, perkSum, hasPerk, aiPickPerk, pickModifier, GALE_CAP } from './perks.js';
import { SKILL, BRANCHES, ranksHeld, branchOf } from './skills.js';
import { normalizeLab } from './survey.js';
import { MODS, MOD_BY_ID, MOD_PAY, MOD_BAYS, modLab, modLevel, modPrice, buyLevel, fitMods, readyMods, deployMod, tickMods, hurtMod, modUp, modWells, modTargets, anyUp, perkLevels, normalizeModLab, anchorMod, refitMods } from './mods.js';

export const PLAYER_COLORS = ['#e8553f', '#3f8be8', '#f2c230', '#4cc77a', '#b06ce6', '#ef8bc0'];

const DEG = Math.PI / 180;
const START_JETS = 1;   // jump jet charges each tank starts the match with (they carry over between rounds)

// Money awards.
// Everyone gets the stipend, so even a tank that was knocked out early has
// something to spend in the shop.
export const PAY = { perDamage: 2, kill: 150, survive: 80, roundWin: 300, stipend: 150 };
// What a tank earned this round, by where it came from (`p.earned`), for the
// between-rounds results: damage, kills, mods shot down, survived, won, stipend.
export const EARNINGS = ['damage', 'kill', 'mod', 'survive', 'win', 'stipend'];

// Each tank remembers its last few shots (`p.shots`, oldest first) so the UI
// can show what changed since. Driving or falling further than `moved` metres
// from where the last one was fired wipes them: the old aim no longer applies.
export const AIM_HISTORY = { keep: 3, moved: 4 };

// With `firing: 'volley'` nobody shoots on their own turn. Each round is a
// string of volleys: CPUs do any driving, each human plans in turn (drive, aim,
// then Fire locks the plan in and puts the turret back where everyone last saw
// it), and after a short beat every tank fires at once.
export const VOLLEY = { beat: 0.9, beatMax: 2.6, stagger: 0.09 };

// Fog of war (`fog: true`). A tank sees `sight` metres around itself, plus
// whatever its Scout Missiles light up. Of everyone else it only has intel:
// where it last saw them, or a rough fix (`rough`, the radius of doubt) from
// the start of the round or from hearing them fire (`flash`). Intel is only
// updated at fixed points (round start, each turn or volley, each shot and
// scout burst), so every copy of an online game holds the same; the CPUs aim
// from it.
export const FOG = { sight: 110, rough: 60, flash: 35 };

// Double Strike (the perk with `doubleStrike`). On its turn (or its go at
// planning a volley) a tank that holds it may arm a double: Fire then queues
// the aim as shot 1 and the next Fire sends both, the second `gap` seconds of
// flight after the first. Each shot has its own aim and weapon and spends its
// own ammo. The tank is then reloading: on its next turn (or volley) it can
// drive, turn and jump, but Fire only passes. Arming is a choice, never forced.
// The second shot is timed in fixed simulation steps, so every copy of an
// online game fires it on the same step.
export const STRIKE = { gap: 0.45 };

// When a Normal or Hard CPU puts its orbiter up: each CPU has one way for the
// whole match, drawn from the match seed and its id (game.aiDeployStyle).
//   early     as soon as it has one ready (its first turn, and again right
//             after losing one)
//   ranging   fires first; deploys when it has no good shot: its aim still
//             off by more than `yaw` degrees or `power` of the charge after
//             ranging, only a rough fix in the fog, or nothing to shoot at;
//             and once it has been hurt
//   reactive  keeps firing until it has been hurt this round
// Easy CPUs deploy now and then at random. Every style deploys with nothing to shoot at.
export const DEPLOY_STYLES = ['early', 'ranging', 'reactive'];
export const AI_DEPLOY = { yaw: 1.0, power: 0.02, easy: 0.35 };

export class Game {
  constructor({
    players,
    rounds = 3,
    seed = (Math.random() * 1e9) | 0,
    maxWind = 1.5,
    terrainSize = 800,
    resolution = 256,
    hills = 45,
    world = 'meadow',   // 'meadow'; 'isles': floating isles in open sky, with moons that pull on shells; 'ridgeline': a mountain range in cross-section (core/ridgeline.js)
    maxTurnsPerRound = 40,
    // What the match uses (the Custom match checkboxes): each a list of the ids
    // that are on, or null for all of them. A weapon that is off is never in
    // an inventory, the armory or a perk's hand-out; the Shell (and the hidden
    // fragments other shells break into) is always on. A perk that is off is
    // never drafted; with every perk off there is no draft. A round modifier
    // that is off is never rolled. Ids this build does not know are dropped.
    weapons = null,
    perks = null,
    modifiers = null,
    // The old switch for perks and round modifiers together (saved states and
    // online messages from before the lists): false turns both lists off.
    twists = true,
    firing = 'turns',   // 'turns', or 'volley': everyone plans, then all fire together
    fog = false,        // fog of war: see FOG
    // Online play (core/netplay.js): the ids of the tanks played on this
    // screen. The other humans plan elsewhere; their plans arrive by message.
    local = null,
    // The host's Lab options (core/survey.js normalizeLab, core/mods.js
    // normalizeModLab): who has the Survey Satellite and its labels, and who has
    // each other mod ('perk', the default: from the perk draft; 'shop'; 'all' at a level; or 'off').
    lab = null,
    // A testing aid (?modifier=rain): every round is this modifier, rolled or not.
    modifier = null,
  }) {
    const known = (list, all) => (Array.isArray(list) ? list.filter((id) => all.some((x) => x.id === id)) : null);
    const noTwists = twists === false;
    this.cfg = {
      rounds, seed, maxWind, terrainSize, resolution, hills, world, maxTurnsPerRound, firing, local, fog,
      weapons: known(weapons, WEAPONS),
      perks: noTwists ? [] : known(perks, PERKS),
      modifiers: noTwists ? [] : known(modifiers, MODIFIERS),
      lab: { ...normalizeLab(lab), ...normalizeModLab(lab) },
      modifier: MODIFIER_BY_ID[modifier] ? modifier : null,
    };
    this.cfg.twists = this.draftOn || MODIFIERS.some((m) => this.modifierOn(m.id));   // kept for anything that still reads it
    this.reveals = [];                          // fog: live scout bursts { owner, x, z, r, until }
    this.intel = [];                            // fog: viewer id -> { target id: { x, z, r, at } }
    this.volley = null;                         // { queue, plans, shown } while a volley is being planned
    this.rng = makeRng(seed);
    this.rogue = makeRng(seed ^ 0x5bd1e995);   // drafts, modifiers and CPU driving roll their own dice
    this.modifier = MODIFIER_BY_ID.clear;
    this.gravity = GRAVITY;
    this.drag = 0;                              // air drag on shells (the Rain modifier, ballistics.stepProjectile)
    this.maxWind = maxWind;
    this.draft = {};                            // human id -> perk ids on offer (the next rank of each open branch of the skill tree)
    this.players = players.map((p, i) => ({
      id: i,
      name: p.name || `Player ${i + 1}`,
      color: p.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
      ai: p.ai || null,
      money: 0,
      score: 0,
      wins: 0,
      inventory: this.startInventory(),
      jets: START_JETS,
      mods: {},          // equipment: id -> { bought, level, state, hp, turns, ... } (core/mods.js)
      status: [],        // status effects to come ({ kind, source, strength, turns }); none yet
      pendingArmor: 0,
      pendingFuel: 0,
      perks: [],
      points: 0,         // skill points not spent yet (core/skills.js)
      // per-round state
      x: 0, y: 0, z: 0, yaw: 0, elev: 45, power: 60,
      hull: 0, fuel: 0, fuelMax: 0, hitsHere: 0,
      hp: TANK.maxHp, maxHp: TANK.maxHp, armor: 0, alive: true,
      weapon: 'shell', falling: false, vy: 0, fallFrom: 0,
      reloading: false,   // fired a Double Strike: its next turn is move only (see STRIKE)
      hitBy: null,        // the last tank to hurt it this round (a CPU's threat, aiSituation)
      steerGoal: null,    // a CPU's Guided Missile steers for this [x, z] (ai.steerGuided)
      aim: {},   // CPU aim memory: target id -> the error it still carries (ai.planShot)
      shots: [], shotCount: 0,   // aim history, see AIM_HISTORY
      // Whole-match tallies for the results screen. `hits` counts shots (not
      // bomblets) that hurt someone else; `longest` is the furthest such hit, in metres.
      stats: { shots: 0, hits: 0, damage: 0, taken: 0, kills: 0, longest: 0, probes: 0, lastHit: 0 },
    }));
    this.round = 0;
    this.terrain = new Heightfield({ size: terrainSize, resolution });
    this.scenery = new Scenery(this.terrain);
    this.events = [];
    this.projectiles = [];
    this.wind = [0, 0];
    this.phase = 'init';
    this.turn = -1;
    this.firstShooter = -1;
    this.phaseTime = 0;
    this.turnsThisRound = 0;
    this.lastRoundResult = null;
    this.acc = 0;
    this.strike = null;     // Double Strike being planned now: { player, first: shot 1 or null }
    this.followUps = [];    // second shots waiting to go: { owner, plan, at (sim step), delay }
    this.simStep = 0;       // fixed simulation steps run so far (times the second shots)
    // The game clock, in simulated seconds: it runs only while something is in
    // the air, one fixed step at a time, and travels in snapshots, so every
    // screen agrees on it. Orbiting mods are a pure function of it (mods.js orbitPoints).
    this.clock = 0;
  }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  get current() { return this.turn >= 0 ? this.players[this.turn] : null; }
  get humans() { return this.players.filter((p) => !p.ai); }
  get online() { return !!this.cfg.local; }
  // Is this tank planned on this screen? (Every human, offline.)
  isLocal(p) { return !p.ai && (!this.cfg.local || this.cfg.local.includes(p.id)); }
  get localHumans() { return this.players.filter((p) => this.isLocal(p)); }
  // Names one volley of one round, for messages about it.
  get volleyKey() { return `${this.round}.${this.turnsThisRound}`; }
  get volleyMode() { return this.cfg.firing === 'volley'; }
  alivePlayers() { return this.players.filter((p) => p.alive); }

  // ---------- what this match uses (cfg.weapons, cfg.perks, cfg.modifiers) ----------

  // The Shell (infinite) and the hidden fragments of other shells are always on.
  weaponOn(id) {
    const w = WEAPON_BY_ID[id];
    if (!w) return false;
    return !!(w.infinite || w.hidden) || !this.cfg.weapons || this.cfg.weapons.includes(id);
  }
  perkOn(id) { return !!PERK_BY_ID[id] && (!this.cfg.perks || this.cfg.perks.includes(id)); }
  modifierOn(id) { return !!MODIFIER_BY_ID[id] && (!this.cfg.modifiers || this.cfg.modifiers.includes(id)); }
  // Is there a perk draft between rounds at all?
  get draftOn() { return PERKS.some((k) => this.perkOn(k.id)); }

  // What every tank starts the match with, less any weapon that is off (and
  // no Guided Missile online: no steering there).
  startInventory() {
    const inv = { ...startKit(), ...(this.cfg.local ? { guided: 0 } : {}) };
    for (const id of Object.keys(inv)) if (!this.weaponOn(id)) inv[id] = 0;
    return inv;
  }

  // A round modifier this match can roll: on in the list, and not one about
  // the wind when the match has none (Calm): a Gale or Dead calm round would
  // contradict the host's Wind or do nothing.
  modifierFits(m) {
    if (!this.modifierOn(m.id)) return false;
    return !((m.wind || m.calm) && !(this.cfg.maxWind > 0));
  }

  start() {
    this.startRound();
  }

  // ---------- rounds ----------

  startRound() {
    this.round++;
    const t = this.terrain;
    const mod = this.modifier = this.cfg.modifier ? MODIFIER_BY_ID[this.cfg.modifier]
      : pickModifier(this.rogue, this.modifier.id, (m) => this.modifierFits(m));
    this.gravity = GRAVITY * (mod.gravity || 1);
    this.drag = mod.drag || 0;
    const w = this.cfg.maxWind;
    this.maxWind = mod.calm ? 0 : mod.wind ? Math.max(w, Math.min(w * mod.wind, GALE_CAP)) : w;
    const starts = this.placeTanks();
    this.makeGround(this.round, starts);
    this.scenery.generate({ seed: this.cfg.seed + this.round * 104729, tanks: this.players });
    // Everything that reshapes the ground this round, so another copy of the
    // game can rebuild it exactly (see rebuildGround).
    this.ground = { starts, ops: [] };
    for (const p of this.players) {
      p.y = t.heightAt(p.x, p.z);
      p.aim = {};
      p.shots = [];
      p.maxHp = TANK.maxHp + perkSum(p, 'maxHp');
      p.hp = p.maxHp;
      p.armor = p.pendingArmor + perkSum(p, 'roundArmor');
      p.pendingArmor = 0;
      p.fuelMax = Math.round((TANK.fuel + perkSum(p, 'fuel') + p.pendingFuel) * (mod.fuel || 1));
      p.fuel = p.fuelMax;
      p.pendingFuel = 0;
      p.hitsHere = 0;
      p.hitBy = null;
      for (const id of p.perks) {
        for (const [w, n] of Object.entries(PERK_BY_ID[id].roundAmmo || {})) if (this.weaponOn(w)) p.inventory[w] = (p.inventory[w] || 0) + n;
      }
      if (this.cfg.fog && this.weaponOn('scout')) p.inventory.scout = (p.inventory.scout || 0) + 1;   // a free scout each round
      p.alive = true;
      p.falling = false;
      p.vy = 0;
      p.blamed = null;
      p.weapon = 'shell';
      p.power = 60;
      p.elev = 45;
      p.roundDamage = 0;
      p.earned = {};
      p.reloading = false;
      fitMods(this.cfg.lab, p);   // an up mod carries on; the rest are fitted fresh
      anchorMod(p, 'satellite', (x, z) => this.groundAt(x, z));   // over its owner's new spot
    }
    this.strike = null;
    this.followUps = [];
    // Everyone starts aiming at the arena centre.
    for (const p of this.players) p.hull = p.yaw = ((Math.atan2(-p.z, -p.x) * 180) / Math.PI + 360) % 360;
    this.wind = this.randomWind();
    this.projectiles = [];
    this.turnsThisRound = 0;
    this.firstShooter = (this.firstShooter + 1) % this.players.length;
    this.startIntel();
    this.emit({ type: 'roundStart', round: this.round, modifier: mod.id });
    this.emit({ type: 'terrain', full: true });
    if (this.volleyMode) this.beginVolley();
    else this.beginTurn(this.firstShooter);
  }

  placeTanks() {
    const t = this.terrain;
    const n = this.players.length;
    const ring = t.size * 0.33;
    const base = this.rng.range(0, Math.PI * 2);
    const order = this.players.map((_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.padOrder = order;   // pads are flattened in this order; overlaps depend on it
    if (this.ridgeline) return rowStarts(order, t, this.rng);   // a row from west to east
    return order.map((pi, k) => {
      const a = base + (k / n) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
      const r = ring * this.rng.range(0.8, 1.15);
      return [pi, Math.cos(a) * r, Math.sin(a) * r];
    });
  }

  get isles() { return this.cfg.world === 'isles'; }
  get ridgeline() { return this.cfg.world === 'ridgeline'; }

  // The round's ground from its seed, then a flat pad under each tank, in pad
  // order (`starts` is [player index, x, z]). The isles are laid out around
  // the pads, so every tank starts on an isle of its own.
  makeGround(round, starts) {
    const t = this.terrain;
    const seed = this.cfg.seed + round * 7919;
    if (this.isles) t.generateIsles({ seed, amplitude: this.cfg.hills, pads: starts.map(([, x, z]) => [x, z]) });
    else if (this.ridgeline) generateRidgeline(t, { seed, amplitude: this.cfg.hills, pads: starts.map(([, x, z]) => [x, z]) });
    else t.generate({ seed, amplitude: this.cfg.hills });
    for (const [i, x, z] of starts) {
      const p = this.players[i];
      p.x = x; p.z = z;
      t.flatten(x, z, TANK.padRadius);
      p.y = t.heightAt(x, z);
    }
    if (this.ridgeline) keepCrust(t);
  }

  randomWind() {
    const m = this.maxWind;
    if (m <= 0) return [0, 0];
    const a = this.rng.range(0, Math.PI * 2);
    const s = this.rng.range(this.modifier.wind > 1 ? m * 0.5 : 0, m);
    return [Math.cos(a) * s, Math.sin(a) * s];
  }

  driftWind() {
    const m = this.maxWind;
    if (m <= 0) return;
    let [wx, wz] = this.wind;
    wx += this.rng.gauss() * m * 0.15;
    wz += this.rng.gauss() * m * 0.15;
    const s = Math.hypot(wx, wz);
    if (s > m) { wx *= m / s; wz *= m / s; }
    this.wind = [wx, wz];
  }

  // ---------- turns ----------

  // A turn, or in volley mode one tank's go at planning. `go` is a CPU's drive
  // for a volley (it only gets a go when it wants to move).
  beginTurn(index, go = null) {
    this.turn = index;
    this.phase = 'aim';
    this.phaseTime = 0;
    const p = this.current;
    if (!(p.inventory[p.weapon] > 0)) p.weapon = 'shell';
    const repair = perkSum(p, 'regen');
    if (repair && this.turnsThisRound > 0 && !this.volleyMode) p.hp = Math.min(p.maxHp, p.hp + repair);
    if (!this.volleyMode) this.refit(p);   // (a volley refits everyone in beginVolley)
    this.aiPlan = null;
    this.aiDrive = null;
    this.driveNote = null;
    this.strike = null;
    this.checkAimHistory(p);
    this.refreshIntel();
    if (this.volleyMode) {
      this.volley.shown = { yaw: p.yaw, elev: p.elev, power: p.power };
      if (go) this.aiDrive = { heading: go.heading, until: p.fuel - go.budget, time: 0, jump: !!go.jump };
    } else if (p.ai) this.planAi(p);
    this.emit({ type: 'turn', player: p.id, plan: this.volleyMode });
  }

  // Forget a tank's earlier shots once it is no longer where it fired them from.
  checkAimHistory(p) {
    const last = p.shots[p.shots.length - 1];
    if (!last || Math.hypot(p.x - last.at[0], p.y - last.at[1], p.z - last.at[2]) <= AIM_HISTORY.moved) return;
    p.shots = [];
    this.emit({ type: 'aimReset', player: p.id });
  }

  // ---------- volleys ----------

  beginVolley() {
    const n = this.players.length;
    const order = this.players.map((_, k) => this.players[(this.firstShooter + this.turnsThisRound + k) % n]).filter((p) => p.alive);
    // CPUs sort out their driving first, so every human plans against where they ended up.
    this.volley = { queue: [...order.filter((p) => p.ai), ...order.filter((p) => !p.ai)].map((p) => p.id), plans: {}, done: [], shown: null };
    this.refreshIntel();
    if (this.turnsThisRound > 0) {
      for (const p of order) {
        const repair = perkSum(p, 'regen');
        if (repair) p.hp = Math.min(p.maxHp, p.hp + repair);
      }
    }
    for (const p of order) this.refit(p);
    this.nextPlanner();
  }

  nextPlanner() {
    const v = this.volley;
    while (v.queue.length) {
      const p = this.players[v.queue.shift()];
      if (!p.alive || v.done.includes(p.id)) continue;   // online, a plan can be in before its turn comes
      if (!p.ai) {
        if (this.isLocal(p)) { this.beginTurn(p.id); return; }
        continue;   // plans on another screen
      }
      const go = this.aiWantsToDrive(p);
      if (go) { this.beginTurn(p.id, go); return; }
    }
    if (this.online) {
      // Hold here until every other human's plan is in (see netplay.js).
      this.turn = -1;
      this.phase = 'wait';
      this.phaseTime = 0;
      this.emit({ type: 'waiting' });
      return;
    }
    this.startVolleyBeat();
  }

  // Online: the humans who still have to plan this volley.
  waitingOn() {
    if (!this.volley) return [];
    return this.players.filter((p) => p.alive && !p.ai && !this.volley.done.includes(p.id));
  }

  // Online: another screen's human has planned. Their tank goes where they
  // drove it; the aim stays secret until the volley.
  remotePlan(id, plan, tank) {
    const p = this.players[id];
    if (!this.volley || !p) return;
    if (tank && p.alive) Object.assign(p, tank);
    if (plan) this.volley.plans[id] = plan; else delete this.volley.plans[id];
    if (!this.volley.done.includes(id)) this.volley.done.push(id);
  }

  // The current human is happy with the aim: keep it secret until the volley.
  // With a Double Strike queued, the plan carries the second shot as `second`.
  lockPlan() {
    const p = this.current;
    if (this.phase !== 'aim' || !p || !p.alive || p.ai) return false;
    if (p.reloading) return this.passTurn(p);
    const shot = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon };
    const first = this.strike?.player === p.id ? this.strike.first : null;
    this.volley.plans[p.id] = first ? { ...first, second: shot } : shot;
    this.strike = null;
    this.volley.done.push(p.id);
    Object.assign(p, this.volley.shown);
    this.emit({ type: 'locked', player: p.id });
    this.nextPlanner();
    return true;
  }

  // Everyone has planned. CPUs aim now, at the tanks where they stand; then
  // the turrets swing to their plans and the volley goes.
  startVolleyBeat() {
    const v = this.volley;
    this.turn = -1;
    this.phase = 'volley';
    this.phaseTime = 0;
    this.refreshIntel();
    for (const p of this.players) {
      if (!p.alive) { delete v.plans[p.id]; continue; }
      if (!p.ai) continue;
      if (p.reloading) {   // a Double Strike last volley: this one it sits out
        delete v.plans[p.id];
        this.emit({ type: 'pass', player: p.id });
        continue;
      }
      const plan = this.planAiShot(p);
      if (plan) v.plans[p.id] = { yaw: plan.yaw, elev: plan.elev, power: plan.power, weapon: plan.weapon, ...(plan.goal ? { goal: plan.goal } : {}), ...(plan.second ? { second: plan.second } : {}), ...(plan.deploy ? { deploy: plan.deploy } : {}) };
    }
    this.aiPlan = null;
    this.emit({ type: 'volley', players: Object.keys(v.plans).map(Number) });
  }

  updateVolleyBeat(dt) {
    let ready = this.phaseTime >= VOLLEY.beat;
    for (const [pid, plan] of Object.entries(this.volley.plans)) {
      if (!this.swingToward(this.players[pid], plan, dt)) ready = false;
    }
    if (ready || this.phaseTime >= VOLLEY.beatMax) this.launchVolley();
  }

  launchVolley() {
    let k = 0;
    for (const p of this.players) {
      const reloaded = p.reloading;
      p.reloading = false;   // this volley was its reload, if it had one
      const plan = this.volley.plans[p.id];
      if (!plan || !p.alive || reloaded) continue;
      if (plan.deploy) { this.deployFor(p, plan.deploy); continue; }   // its action this volley
      this.aimAt(p, plan);
      const delay = k++ * VOLLEY.stagger;
      if (plan.second && hasPerk(p, 'doubleStrike')) this.launchDouble(p, plan.second, delay);
      else this.launch(p, delay);
    }
    this.volley.plans = {};
    this.phase = 'flight';
    this.phaseTime = 0;
  }

  // Turn the turret, barrel and charge toward `plan` at the tank's real
  // speeds. True once it is there.
  swingToward(p, plan, dt) {
    const dy = ((plan.yaw - p.yaw + 540) % 360) - 180;
    const de = plan.elev - p.elev;
    const dp = plan.power - p.power;
    const ty = TANK.turretSpeed * dt;
    const te = TANK.elevationSpeed * dt;
    const tp = TANK.powerSpeed * 2 * dt;
    p.yaw += Math.abs(dy) <= ty ? dy : Math.sign(dy) * ty;
    p.elev += Math.abs(de) <= te ? de : Math.sign(de) * te;
    p.power += Math.abs(dp) <= tp ? dp : Math.sign(dp) * tp;
    clampAim(p);
    return Math.abs(dy) < 0.01 && Math.abs(de) < 0.01 && Math.abs(dp) < 0.01;
  }

  // A CPU turn: now and then drive first (ai.planDrive), then plan the shot
  // from wherever it ends up. Its aim memory sees that it moved and loosens.
  planAi(p) {
    const go = this.aiWantsToDrive(p);
    if (go) this.aiDrive = { heading: go.heading, until: p.fuel - go.budget, time: 0, jump: !!go.jump };
    else this.planAiShot(p);
  }

  // A CPU's move before it shoots: drive out of trouble, and when driving
  // will not do (no fuel, too steep) hop out with a jet. { heading, budget,
  // jump } or null.
  aiWantsToDrive(p) {
    return planDrive({
      me: p, terrain: this.terrain, rng: this.rogue, difficulty: p.ai,
      tryDrive: (heading, budget) => this.previewDrive(p, heading, budget),
    }) || planJump({
      me: p, terrain: this.terrain, difficulty: p.ai,
      tryHop: (heading) => this.previewHop(p, heading),
    });
  }

  // The enemy orbiters a shot by `p` would fly through, for the solvers
  // ({ field, t0 }, see ballistics.simulateShot): none when nobody has one up.
  // `later` is how long after now the shot leaves. Easy CPUs ignore orbiters;
  // the others misread them, the more the higher the level (ai.misjudgeField).
  orbitField(p, later = 0) {
    if (p.ai === 'easy') return {};   // easy CPUs fire blind
    const level = Math.max(0, ...this.players.filter((q) => q !== p && modUp(q, 'orbiter')).map((q) => q.mods.orbiter.level));
    if (!level) return {};
    return misjudgeField({ field: (t) => modWells(this.players, t, p.id), t0: this.clock + later, level, difficulty: p.ai, rng: this.rng });
  }

  planAiShot(p) {
    // Reloading after a Double Strike: nothing to aim, Fire only passes.
    if (p.reloading) return (this.aiPlan = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon, pass: true, think: 0.6 });
    const target = chooseTarget(p, this.knownFoes(p), p.ai, this.rng);
    // No good shot yet: spend the turn putting the orbiter up instead.
    const deploy = this.aiWantsDeploy(p, target);
    if (deploy) return (this.aiPlan = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon, deploy, think: 0.6 });
    if (!target) return null;
    // Weigh the arsenal by the situation (ai.weaponWeights). A Mound goes at
    // its own feet and a Teleport at a spot it picked; everything else at the target.
    const ctx = this.aiSituation(p, target);
    let weapon = chooseWeapon(p, target, this.rng, ctx);
    const conds = { wind: this.wind, terrain: this.terrain, gravity: this.gravity, windK: this.windShare(p), drag: this.shellDrag(p) };
    let aim = null;
    if (weapon === 'mound') aim = ctx.heap;
    else if (weapon === 'teleport') {
      aim = planPlace({ shooter: p, point: ctx.warp, rng: this.rng, difficulty: p.ai, ...conds });
      if (!aim) weapon = 'shell';
    }
    if (!aim) {
      aim = planShot({
        shooter: p,
        target,
        rng: this.rng,
        difficulty: p.ai,
        memory: p.aim,
        ...conds,
        ...this.orbitField(p),
        sharpen: this.aiSharpen(p),
      });
      if (weapon === 'ranger') readRange(p.aim, target.id, p.ai);   // it reads the probes
    }
    const plan = { ...aim, weapon, target: target.id, think: 0.6 };
    if (weapon === 'guided') plan.goal = [target.x, target.z];
    if (!UTILITY.includes(weapon) && hasPerk(p, 'doubleStrike') && wantsDouble({ target, memory: p.aim, difficulty: p.ai, rng: this.rng })) {
      const again = planShot({ shooter: p, target, rng: this.rng, difficulty: p.ai, memory: p.aim, ...conds,
        ...this.orbitField(p, STRIKE.gap), sharpen: this.aiSharpen(p) });
      plan.second = { yaw: again.yaw, elev: again.elev, power: again.power, weapon: chooseSecondWeapon(p, plan.weapon, this.rng) };
    }
    return (this.aiPlan = plan);
  }

  // This CPU's temper for the match (ai.TEMPERS): a pure function of the
  // match seed and its id, like its deploy style.
  aiTemper(p) { return cpuTemper(this.cfg.seed, p.id); }

  // How much of its aiming error a CPU carries into a shot: less while its
  // Survey Satellite is up (ai.satelliteSharpen).
  aiSharpen(p) {
    const level = this.surveyLevel(p);
    return level ? satelliteSharpen(level, { difficulty: p.ai, windy: Math.hypot(this.wind[0], this.wind[1]) / 1.5 }) : 1;
  }

  // The situation a CPU weighs its weapons by (ai.weaponWeights): its reading
  // on the target, its hole, the hits it is taking and from whom (as far as
  // it knows), and whether a Mound at its feet or a Teleport would work.
  aiSituation(p, target) {
    const A = ARSENAL;
    const m = p.aim[target.id];
    const foes = this.knownFoes(p);
    const threat = p.hitBy != null ? foes.find((q) => q.id === p.hitBy) : null;
    const sunk = holeDepth(this.terrain, p.x, p.z, p.y);
    const hurt = p.hp < p.maxHp * A.hurt;
    const strongest = Math.max(0, ...this.players.filter((q) => q !== p && q.alive).map((q) => q.hp + q.armor));
    const behind = p.hp + p.armor < strongest * A.behind;
    const ctx = {
      difficulty: p.ai, temper: this.aiTemper(p), seen: m?.shots || 0, unsure: !!target.rough || unsureOf(m),
      dist: Math.hypot(target.x - p.x, target.z - p.z), sunk, hits: p.hitsHere, hurt, behind, threat: !!threat,
      steer: !this.online && p.inventory.guided > 0,
    };
    if (p.inventory.mound > 0 && (sunk >= A.sunk || (threat && p.hitsHere >= 1))) {
      ctx.heap = planHeap({ me: p, toward: threat ? [threat.x, threat.z] : [0, 0], terrain: this.terrain, wind: this.wind,
        gravity: this.gravity, windK: this.windShare(p), drag: this.shellDrag(p) });
    }
    if (p.inventory.teleport > 0 && (sunk >= A.deep || (p.hitsHere >= 2 && hurt) || behind)) {
      ctx.warp = findWarp({ me: p, foes, terrain: this.terrain, rng: this.rng, solid: (x, z) => this.groundAt(x, z) != null });
    }
    return ctx;
  }

  // ---------- fog of war ----------

  // Can `viewer` see `target` right now? Always, without fog.
  inSight(viewer, target) {
    if (!this.cfg.fog || viewer === target) return true;
    if (!viewer.alive) return false;
    if (Math.hypot(viewer.x - target.x, viewer.z - target.z) <= FOG.sight) return true;
    return this.reveals.some((r) => r.owner === viewer.id && Math.hypot(r.x - target.x, r.z - target.z) <= r.r);
  }

  // The live enemies `p` knows of, as it knows them: the real tanks without
  // fog; with it, stand-ins at its intel (`rough` when only roughly placed).
  knownFoes(p) {
    if (!this.cfg.fog) return this.players.filter((q) => q !== p && q.alive).map((q) => (modUp(q, 'orbiter') || modUp(q, 'satellite') ? { ...q, shielded: modUp(q, 'orbiter'), aloft: modUp(q, 'satellite') } : q));
    const out = [];
    for (const q of this.players) {
      const i = this.intel[p.id]?.[q.id];
      if (q === p || !q.alive || !i) continue;
      const t = this.terrain;
      const y = t.inBounds(i.x, i.z) ? t.heightAt(i.x, i.z) : q.y;
      out.push({ id: q.id, x: i.x, y, z: i.z, hp: q.hp, armor: q.armor, alive: true, rough: i.r > 0, shielded: i.r === 0 && modUp(q, 'orbiter'), aloft: i.r === 0 && modUp(q, 'satellite') });
    }
    return out;
  }

  // Round start: everyone has a rough fix on everyone, then sees what it sees.
  startIntel() {
    this.reveals = [];
    this.intel = this.players.map(() => ({}));
    if (!this.cfg.fog) return;
    for (const v of this.players) for (const q of this.players) if (v !== q) this.roughFix(v, q, FOG.rough, 1);
    this.refreshIntel();
  }

  // `v` has a rough idea where `q` is: within `r` metres of a point near it.
  // The offset is a hash of the moment, so every copy of the game agrees.
  roughFix(v, q, r, salt) {
    const h = hash32(this.cfg.seed, this.round, this.turnsThisRound, v.id, q.id, q.shotCount, salt);
    const a = (h & 0xffff) / 0x10000 * Math.PI * 2;
    const d = ((h >>> 16) / 0x10000) * r * 0.7;
    this.intel[v.id][q.id] = { x: q.x + Math.cos(a) * d, z: q.z + Math.sin(a) * d, r, at: this.turnsThisRound };
  }

  // Everything each tank can see now goes into its intel, exactly; spent scout bursts go.
  refreshIntel() {
    if (!this.cfg.fog) return;
    this.reveals = this.reveals.filter((r) => r.until > this.turnsThisRound);
    for (const v of this.players) {
      if (!v.alive) continue;
      for (const q of this.players) {
        if (q !== v && q.alive && this.inSight(v, q)) this.intel[v.id][q.id] = { x: q.x, z: q.z, r: 0, at: this.turnsThisRound };
      }
    }
  }

  // `p` fired: whoever cannot see it hears roughly where from.
  heardFire(p) {
    if (!this.cfg.fog) return;
    for (const v of this.players) {
      if (v === p || !v.alive) continue;
      if (this.inSight(v, p)) this.intel[v.id][p.id] = { x: p.x, z: p.z, r: 0, at: this.turnsThisRound };
      else this.roughFix(v, p, FOG.flash, 2);
    }
  }

  // How much of the wind this tank's shots feel.
  windShare(p) { return Math.max(0, 1 + perkSum(p, 'windScale')); }

  // The air drag on this tank's shells: the round's (Rain), less its perks'
  // share (dragScale). Every shell and every prediction of one reads this.
  shellDrag(p) { return this.drag * Math.max(0, 1 + perkSum(p, 'dragScale')); }

  // ---------- mods (core/mods.js) ----------

  // The level of a mod `p` owns: bought, or the host's Lab gives everyone one, plus perks.
  modLevel(p, id) { return modLevel(this.cfg.lab, p, id); }

  // The Survey Satellite level `p` owns (deployed or not).
  satelliteLevel(p) { return this.modLevel(p, 'satellite'); }

  // The satellite level working for `p` right now: only while it is up.
  surveyLevel(p) { return modUp(p, 'satellite') ? p.mods.satellite.level : 0; }

  // Every Gravity Orbiter well up now, at the game clock, as moon-shaped wells
  // ({ x, y, z, r, mu }, plus soft and owner) for the renderer (gravity lines).
  orbiterWells() { return anyUp(this.players) ? modWells(this.players, this.clock) : []; }

  // Height of the ground at x/z, or null over open space.
  groundAt(x, z) {
    const t = this.terrain;
    return t.inBounds(x, z) && t.solidAt(x, z) ? t.heightAt(x, z) : null;
  }

  // Could the current human deploy a mod now? Not while reloading after a
  // Double Strike (that turn is move only).
  canDeploy(p = this.current) {
    return this.phase === 'aim' && !!p && p.alive && !p.ai && !p.reloading && readyMods(p).length > 0;
  }

  // Put one of `p`'s ready mods up, now.
  deployFor(p, id) {
    if (!p.alive || !deployMod(p, id, (x, z) => this.groundAt(x, z))) return false;
    this.emit({ type: 'mod', what: 'deploy', player: p.id, mod: id });
    return true;
  }

  // The current human spends this turn deploying a mod (the first one ready,
  // without `id`) instead of firing. Taking turns, it goes up now and the turn
  // ends; in a volley it is the locked-in plan and goes up as the volley
  // fires (launchVolley). Returns the id, or null.
  deploy(id = null) {
    const p = this.current;
    if (!this.canDeploy(p)) return null;
    const which = id || readyMods(p)[0];
    if (!readyMods(p).includes(which)) return null;
    this.strike = null;
    if (this.volleyMode) {
      this.volley.plans[p.id] = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon, deploy: which };
      this.volley.done.push(p.id);
      Object.assign(p, this.volley.shown);
      this.emit({ type: 'locked', player: p.id, deploy: which });
      this.nextPlanner();
      return which;
    }
    this.deployTurn(p, which);
    return which;
  }

  // Taking turns: the mod goes up and that was the turn.
  deployTurn(p, id) {
    this.deployFor(p, id);
    this.strike = null;
    this.aiPlan = null;
    this.phase = 'settle';
    this.phaseTime = 0;
  }

  // This CPU's way of timing its deploys for the whole match (DEPLOY_STYLES):
  // a pure function of the match seed and its id, so it needs no state and
  // every copy of an online game agrees.
  aiDeployStyle(p) {
    const r = makeRng((this.cfg.seed ^ Math.imul(p.id + 1, 0x9e3779b1)) >>> 0);
    r.next();
    return DEPLOY_STYLES[Math.floor(r.next() * DEPLOY_STYLES.length)];
  }

  // Should a CPU spend this turn deploying a mod rather than firing? Its
  // orbiter as its style says (aiWantsOrbiter), else its Survey Satellite
  // when it has no reading on a far target (ai.wantsSatellite). Returns the mod id or null.
  aiWantsDeploy(p, target) {
    if (p.reloading) return null;
    const ready = readyMods(p);
    if (ready.includes('orbiter') && this.aiWantsOrbiter(p, target)) return 'orbiter';
    if (ready.includes('satellite') && wantsSatellite({ me: p, target, memory: p.aim, difficulty: p.ai, temper: this.aiTemper(p), rng: this.rng })) return 'satellite';
    return null;
  }

  // Its orbiter: always with nothing to shoot at; otherwise as its style says
  // (DEPLOY_STYLES). Easy CPUs just do it now and then.
  aiWantsOrbiter(p, target) {
    if (!target) return true;
    if (p.ai === 'easy') return this.rng.next() < AI_DEPLOY.easy;
    const hurt = p.hp < p.maxHp;
    const style = this.aiDeployStyle(p);
    if (style === 'early') return true;
    if (style === 'reactive') return hurt;
    const m = p.aim[target.id];
    const unsure = target.rough || (m && m.shots > 0 && (Math.abs(m.yaw) > AI_DEPLOY.yaw || Math.abs(m.power) > AI_DEPLOY.power));
    return !!(hurt || unsure);
  }

  // The start of `p`'s turn (or volley): a mod it lost since is ready again.
  refit(p) {
    for (const id of refitMods(this.cfg.lab, p)) this.emit({ type: 'mod', what: 'refit', player: p.id, mod: id });
  }

  // Up mods wear down by a turn; any that run out are spent.
  wearMods(p) {
    if (!p.alive) return;
    for (const id of tickMods(p)) this.emit({ type: 'mod', what: 'expire', player: p.id, mod: id });
  }

  // A destroyed tank's mods go with it.
  dropMods(p) {
    for (const def of MODS) {
      const m = p.mods?.[def.id];
      if (m?.state !== 'up') continue;
      m.state = 'down';
      m.hp = 0;
      this.emit({ type: 'mod', what: 'down', player: p.id, mod: def.id, hp: 0, by: null, pos: def.id === 'satellite' ? [m.x, m.y, m.z] : null, tank: true });
    }
  }

  // `amount` of damage to `owner`'s mod, from tank `from` (or null).
  hurtModOf(owner, mod, amount, from) {
    const p = this.players[owner];
    const r = hurtMod(p, mod, amount);
    if (!r) return;
    const m = p.mods[mod];
    const pos = mod === 'satellite' ? [m.x, m.y, m.z] : null;
    this.emit({ type: 'mod', what: r, player: owner, mod, hp: m.hp, by: from ?? null, pos });
    if (r === 'down' && from != null && from !== owner) this.earn(this.players[from], 'mod', Math.round(MOD_PAY * (this.modifier.pay || 1)));
  }

  // A blast at `point` reaches the enemy mods near it, like it reaches tanks.
  // `struck` is the mod target the shell hit squarely, if any.
  blastMods(point, radius, damage, owner, struck = null) {
    if (!anyUp(this.players)) return;
    const worst = new Map();   // one hit per mod, from its nearest part
    for (const m of modTargets(this.players, this.clock)) {
      if (m.owner === owner) continue;
      const d = struck && struck.owner === m.owner && struck.mod === m.mod ? 0
        : Math.max(0, Math.hypot(m.x - point[0], m.y - point[1], m.z - point[2]) - m.r * 0.5);
      const k = `${m.owner}:${m.mod}`;
      if (!worst.has(k) || d < worst.get(k).d) worst.set(k, { m, d });
    }
    for (const { m, d } of worst.values()) {
      const dmg = blastDamage(d, radius, damage);
      if (dmg > 0) this.hurtModOf(m.owner, m.mod, dmg, owner);
    }
  }

  // ---------- driving ----------

  // Things a tank cannot drive through: the other tanks and standing buildings.
  obstacles() {
    return [...this.players, ...this.scenery.props.filter(standing)];
  }

  driveTank(p, dir, dt) {
    const r = driveStep(p, this.terrain, dir, dt, this.obstacles());
    if (r === 'ok') { p.hitsHere = 0; this.checkAimHistory(p); }
    return r;
  }

  // Where would `budget` fuel along `heading` really get it? Nothing moves.
  previewDrive(p, heading, budget) {
    const ghost = { x: p.x, y: p.y, z: p.z, hull: heading, fuel: Math.min(budget, p.fuel) };
    const others = this.obstacles().filter((o) => o !== p);
    while (driveStep(ghost, this.terrain, 1, 0.1, others) === 'ok');
    return { x: ghost.x, y: ghost.y, z: ghost.z, moved: Math.hypot(ghost.x - p.x, ghost.z - p.z) };
  }

  // Where would a jet hop along `heading` land? Nothing moves.
  previewHop(p, heading) {
    return planHop(p, this.terrain, this.obstacles(), heading);
  }

  // Fire the jump jets: one charge, a hop along the hull. Lands at once, the
  // way a drive step moves; the screen animates the arc from the event.
  // Returns 'ok' or why not: 'nojets' | 'edge' | 'water' | 'blocked'.
  jumpTank(p) {
    if (!(p.jets > 0)) return 'nojets';
    const hop = planHop(p, this.terrain, this.obstacles(), p.hull);
    if (!hop.ok) return hop.why;
    p.jets--;
    const from = [p.x, p.y, p.z];
    p.x = hop.x; p.y = hop.y; p.z = hop.z;
    p.hitsHere = 0;
    this.checkAimHistory(p);
    this.emit({ type: 'jump', player: p.id, from, to: [p.x, p.y, p.z], flight: JET.flight });
    return 'ok';
  }

  // The current human uses a jet. Returns what happened, for the HUD.
  jump() {
    const p = this.current;
    if (this.phase !== 'aim' || !p || p.ai || !p.alive) return 'idle';
    return (this.driveNote = this.jumpTank(p));
  }

  // The current human drives: `dir` +1/-1 along the hull, `turn` +1/-1 swings
  // the hull (free). Returns what happened, for the HUD.
  drive(dir, turn, dt) {
    const p = this.current;
    if (this.phase !== 'aim' || !p || p.ai || !p.alive) return 'idle';
    if (turn) p.hull = (((p.hull + turn * TANK.hullTurnSpeed * dt) % 360) + 360) % 360;
    if (!dir) return turn ? 'turn' : 'idle';
    return (this.driveNote = this.driveTank(p, dir, dt));
  }

  updateAiDrive(p, dt) {
    const d = this.aiDrive;
    d.time += dt;
    if (d.time < 0.5) return;
    let done = d.time > 7 + (d.jump ? JET.flight : 0);   // never let a drive hold the turn up
    const dh = ((d.heading - p.hull + 540) % 360) - 180;
    const turn = TANK.hullTurnSpeed * dt;
    if (d.landing > 0) {
      // Mid-hop: wait for the screen's arc to finish before aiming.
      d.landing -= dt;
      done = d.landing <= 0;
    } else if (Math.abs(dh) > 1) p.hull = (((p.hull + Math.max(-turn, Math.min(turn, dh))) % 360) + 360) % 360;
    else if (d.jump) {
      if (this.jumpTank(p) === 'ok') d.landing = JET.flight + 0.1;
      else done = true;
    } else {
      const r = this.driveTank(p, 1, dt);
      if (r !== 'ok' || p.fuel <= d.until + 0.01) done = true;
    }
    if (done) {
      this.aiDrive = null;
      this.phaseTime = 0;
      if (this.volleyMode) this.nextPlanner();
      else this.planAiShot(p);
    }
  }

  // The turn (or the volley) is over. The round limit counts whichever it was.
  nextTurn() {
    // Up mods wear down by the turn that just ended (every tank's, after a volley).
    if (this.volleyMode) for (const p of this.players) this.wearMods(p);
    else if (this.current) this.wearMods(this.current);
    const alive = this.alivePlayers();
    this.turnsThisRound++;
    const limit = this.cfg.maxTurnsPerRound * (this.volleyMode ? 1 : this.players.length);
    if (alive.length <= 1 || this.turnsThisRound >= limit) {
      this.endRound();
      return;
    }
    if (this.volleyMode) {
      this.driftWind();
      this.beginVolley();
      return;
    }
    let i = this.turn;
    do { i = (i + 1) % this.players.length; } while (!this.players[i].alive);
    this.driftWind();
    this.beginTurn(i);
  }

  endRound() {
    const alive = this.alivePlayers();
    let winner = null;
    if (alive.length === 1) winner = alive[0];
    else if (alive.length > 1) winner = alive.reduce((a, b) => (b.hp > a.hp ? b : a));
    const payK = this.modifier.pay || 1;
    for (const p of this.players) this.earn(p, 'stipend', PAY.stipend * payK);
    for (const p of alive) this.earn(p, 'survive', PAY.survive * payK);
    if (winner) { winner.wins++; this.earn(winner, 'win', PAY.roundWin * payK); winner.score += 1; }
    this.lastRoundResult = { round: this.round, winner: winner ? winner.id : null };
    this.phase = this.round >= this.cfg.rounds ? 'matchOver' : 'roundOver';
    this.phaseTime = 0;
    this.turn = -1;
    this.emit({ type: this.phase, winner: winner ? winner.id : null });
  }

  // From roundOver: every tank gets its skill points (core/skills.js) and
  // spends them on the tree, then shops. Humans do both through the UI; CPUs
  // do both here.
  openShop() {
    if (this.phase !== 'roundOver') return;
    this.phase = 'shop';
    this.phaseTime = 0;
    this.draft = {};
    this.shopped = [];                          // online: humans whose shopping is in
    for (const p of this.players) {
      p.bought = [];
      p.picked = [];
      if (this.draftOn) p.points = (p.points || 0) + SKILL.perRound;
    }
    for (const p of this.players) {
      if (p.ai) this.aiSkills(p);
      else this.offerSkills(p);
    }
    for (const p of this.players) if (p.ai) this.aiShop(p);
    this.emit({ type: 'shop' });
    if (!this.humans.length) this.closeShop();
  }

  // The skill tree as `p` sees it before the next round: every branch this
  // match has (a mod the host's Lab hands out some other way, or a perk that is
  // off or could do nothing, is left out), with its ranks, how many `p` holds,
  // the next rank, and why that rank is shut, if it is ('From round 3', 'Both
  // mod bays in use', 'Needs a mod').
  skillTree(p) {
    const round = this.round + 1;
    const bays = MODS.filter((d) => this.modLevel(p, d.id) > 0).length;
    return BRANCHES.map((b) => {
      let ranks, held;
      if (b.mod) {
        if (modLab(this.cfg.lab, b.mod).mode !== 'perk' || !this.perkOn(b.ranks[0])) return null;
        ranks = b.ranks.filter((id, i) => i === 0 || this.perkOn(id));
        held = Math.min(ranks.length, this.modLevel(p, b.mod));
      } else {
        ranks = b.ranks.filter((id) => this.perkUseful(PERK_BY_ID[id]));
        held = ranksHeld(p, { ranks });
      }
      if (!ranks.length) return null;
      const next = ranks[held] || null;
      let lock = '';
      if (next) {
        const k = PERK_BY_ID[next];
        if ((k.fromRound || 0) > round) lock = `From round ${k.fromRound}`;
        else if (b.mod && held === 0 && bays >= MOD_BAYS) lock = 'Both mod bays in use';
        else if (k.needsMod && !bays) lock = 'Needs a mod';
      }
      return { ...b, ranks, held, next, lock };
    }).filter(Boolean);
  }

  // The ranks `p` could take now: the next one of each open branch.
  skillOffer(p) {
    return this.skillTree(p).filter((b) => b.next && !b.lock).map((b) => b.next);
  }

  offerSkills(p) {
    const offer = p.points > 0 ? this.skillOffer(p) : [];
    if (offer.length) this.draft[p.id] = offer;
    else delete this.draft[p.id];
  }

  // A CPU spends every point: half the time it goes deeper in a branch it has
  // started, otherwise it takes what it likes (perks.js aiPickPerk).
  aiSkills(p) {
    for (let offer = this.skillOffer(p); p.points > 0 && offer.length; offer = this.skillOffer(p)) {
      const deeper = offer.filter((id) => { const b = branchOf(id); return b && this.skillTree(p).find((x) => x.id === b.id)?.held > 0; });
      const id = deeper.length && this.rogue.next() < 0.5 ? this.rogue.pick(deeper) : aiPickPerk(offer, this.rogue, TEMPERS[this.aiTemper(p)].likes);
      p.perks.push(id);
      p.points--;
    }
  }

  // A perk this match can use at all: on in the match (cfg.perks), and able to
  // do something: hand-outs of weapons that are all off, or a drag perk
  // (dragScale) in a match that never rolls a Rain round, cannot.
  perkUseful(perk) {
    if (!perk || !this.perkOn(perk.id)) return false;
    if (perk.dragScale && !MODIFIERS.some((m) => m.drag && this.modifierFits(m))) return false;
    if (perk.roundAmmo && !Object.keys(perk.roundAmmo).some((w) => this.weaponOn(w))) return false;
    return true;
  }

  // Whether `p` could take `perk` now, wherever it is offered: useful this
  // match, and for mod perks, a mod the host's Lab leaves to the tree, below
  // its top level, an unlock only for a mod it lacks (with a free bay) and a
  // level-up only for one it has. (needsMod) needs a mod.
  perkFits(p, perk) {
    if (!this.perkUseful(perk)) return false;
    const bays = MODS.filter((d) => this.modLevel(p, d.id) > 0).length;
    if (perk.needsMod && !bays) return false;
    for (const id of Object.keys(perk.mods || {})) {
      const def = MOD_BY_ID[id];
      const have = def ? this.modLevel(p, id) : 0;
      if (!def || modLab(this.cfg.lab, id).mode === 'off' || have >= def.maxLevel) return false;
      if ((perk.unlock && (have > 0 || bays >= MOD_BAYS)) || (perk.levelUp && have < 1)) return false;
      if (perk.levelUp && !PERKS.some((k) => k.unlock && k.mods?.[id] && this.perkOn(k.id))) return false;   // its unlock is off
    }
    return true;
  }

  // Spend one of `p`'s skill points on a rank it is offered.
  pickPerk(playerId, id) {
    const p = this.players[playerId];
    const offer = this.draft[playerId];
    if (this.phase !== 'shop' || !p || !(p.points > 0) || !offer || !offer.includes(id)) return false;
    p.perks.push(id);
    p.points--;
    (p.picked ||= []).push(id);
    this.offerSkills(p);
    return true;
  }

  // Points nobody spent carry over to the next round.
  closeShop() {
    if (this.phase !== 'shop') return;
    this.draft = {};
    this.startRound();
  }

  // Money in, counted by where it came from (EARNINGS) for the results.
  earn(p, kind, amount) {
    p.money += amount;
    p.earned = p.earned || {};
    p.earned[kind] = (p.earned[kind] || 0) + amount;
  }

  // The armory visit this is (1 after round 1, ...), and the one `id` is first
  // sold on (weapons.js TIERS: Advanced weapons wait for the second).
  get armoryVisit() { return this.round; }
  opensOn(id) { return opensOnVisit(WEAPON_BY_ID[id], this.cfg.rounds); }
  inStock(id) { return !WEAPON_BY_ID[id] || this.opensOn(id) <= this.armoryVisit; }

  // What this tank pays for an armory item (perks can lower it).
  priceOf(p, id) {
    const it = WEAPON_BY_ID[id] || ITEMS.find((x) => x.id === id);
    if (!MOD_BY_ID[id] && (!it || !(it.price > 0))) return Infinity;
    if (WEAPON_BY_ID[id] && !this.weaponOn(id)) return Infinity;   // off in this match: not for sale
    if (!this.inStock(id)) return Infinity;                        // its tier is not open yet
    const base = MOD_BY_ID[id] ? modPrice(this.cfg.lab, p, id) : it.price;   // a mod is priced per level
    if (!Number.isFinite(base)) return Infinity;
    return Math.round((base * (1 - Math.min(0.5, perkSum(p, 'discount')))) / 5) * 5;
  }

  buy(playerId, id) {
    const p = this.players[playerId];
    const w = WEAPON_BY_ID[id];
    const price = this.priceOf(p, id);
    if (!(price > 0) || p.money < price) return false;
    p.money -= price;
    if (p.bought) p.bought.push(id);
    if (w) p.inventory[id] = (p.inventory[id] || 0) + w.bundle;
    else if (id === 'armor') p.pendingArmor += 30;
    else if (id === 'fuel') p.pendingFuel += TANK.fuelCan;
    else if (id === 'jet') p.jets += ITEMS.find((x) => x.id === 'jet').bundle;
    else if (MOD_BY_ID[id]) buyLevel(p, id);   // fitted at the round start (fitMods)
    return true;
  }

  // A CPU that is not easy first saves up for a Gravity Orbiter (and its
  // next level), keeping some money back for ammunition; only when the
  // host's Lab puts mods in the armory (by default they come from perks).
  aiShop(p) {
    if (p.ai !== 'easy' && p.money >= this.priceOf(p, 'orbiter') + 150) this.buy(p.id, 'orbiter');
    for (const d of MODS) if (p.ai !== 'easy' && this.modLevel(p, d.id) > 0 && p.money >= this.priceOf(p, d.id) + 200) this.buy(p.id, d.id);   // a level up for a mod it has
    const wishlist = ['breacher', 'scatter', 'flak', 'armor', 'roller', 'fuel', 'jet', 'breacher'];
    // Its temper's own buys (ai.TEMPERS) come right after the first Breacher; a
    // Hard CPU saves for a Thunderhead first when the armory has one.
    const big = p.ai === 'hard' ? ['thunderhead'] : [];
    for (const id of [...big, wishlist[0], ...TEMPERS[this.aiTemper(p)].buys, ...wishlist.slice(1)]) this.buy(p.id, id);
  }

  // ---------- input (current human player) ----------

  adjustAim(dYaw, dElev, dPower) {
    const p = this.current;
    if (this.phase !== 'aim' || !p || p.ai) return;
    p.yaw += dYaw;
    p.elev += dElev;
    p.power += dPower;
    clampAim(p);
  }

  cycleWeapon(dir = 1) {
    const p = this.current;
    if (this.phase !== 'aim' || !p || p.ai) return;
    const list = WEAPONS.filter((w) => !w.hidden && this.ammoLeft(p, w.id) > 0);
    const i = list.findIndex((w) => w.id === p.weapon);
    p.weapon = list[(i + dir + list.length) % list.length].id;
  }

  // Fire the current tank's shot. In volley mode this locks the plan in instead.
  // With a Double Strike armed the first press queues shot 1 and the second
  // sends (or locks) both; while reloading it passes. `now` (the online clock
  // ran out) never stops at queueing: an armed double with nothing queued goes
  // as a single shot.
  fire(now = false) {
    const p = this.current;
    if (this.phase !== 'aim' || !p || !p.alive) return false;
    const step = this.strikeStep(p);
    if (step === 'pass') return this.passTurn(p);
    if (step === 'first') {
      if (!now) return this.queueFirst(p);
      this.strike = null;
    }
    if (this.volleyMode) return this.lockPlan();
    if (!(step === 'second' ? this.fireBoth(p) : this.launch(p))) return false;
    this.strike = null;
    this.phase = 'flight';
    this.phaseTime = 0;
    return true;
  }

  // ---------- Double Strike (see STRIKE) ----------

  // Could the current human arm a double right now?
  canDouble(p = this.current) {
    return this.phase === 'aim' && !!p && p.alive && !p.ai && hasPerk(p, 'doubleStrike') && !p.reloading;
  }

  // What Fire does for this planner now: 'pass' (reloading), 'first' (armed,
  // queues shot 1), 'second' (sends both, or locks both in a volley) or 'single'.
  strikeStep(p = this.current) {
    if (!p) return 'single';
    if (p.reloading) return 'pass';
    if (this.strike && this.strike.player === p.id) return this.strike.first ? 'second' : 'first';
    return 'single';
  }

  // Arm or disarm a double for the current human. Disarming once shot 1 is
  // queued drops it; the turret stays as it is. Returns whether it is armed now.
  toggleDouble() {
    const p = this.current;
    if (this.strike) {
      this.strike = null;
      this.emit({ type: 'strike', player: p ? p.id : null, armed: false });
      return false;
    }
    if (!this.canDouble(p)) return false;
    this.strike = { player: p.id, first: null };
    this.emit({ type: 'strike', player: p.id, armed: true });
    return true;
  }

  // Rounds of `id` this tank can still put in a shot: a queued shot 1 has a claim on one.
  ammoLeft(p, id) {
    const n = p.inventory[id] || 0;
    const q = this.strike && this.strike.player === p.id ? this.strike.first : null;
    return q && q.weapon === id && !WEAPON_BY_ID[id]?.infinite ? n - 1 : n;
  }

  // The current aim becomes shot 1 of 2; the tank goes on aiming shot 2.
  queueFirst(p) {
    if (!(p.inventory[p.weapon] > 0)) return false;
    this.strike.first = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon };
    if (!(this.ammoLeft(p, p.weapon) > 0)) p.weapon = 'shell';
    this.emit({ type: 'queued', player: p.id, n: 1 });
    return true;
  }

  // Turns: shot 1 as queued, shot 2 as aimed now.
  fireBoth(p) {
    const second = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon };
    this.aimAt(p, this.strike.first);
    return this.launchDouble(p, second);
  }

  // Shot 1 leaves now as the tank is aimed; `second` follows STRIKE.gap later.
  launchDouble(p, second, delay = 0) {
    if (!this.launch(p, delay)) return false;
    this.followUps.push({ owner: p.id, plan: second, at: this.simStep + Math.round(STRIKE.gap / SIM_DT), delay });
    p.reloading = true;
    this.emit({ type: 'double', player: p.id });
    return true;
  }

  // Second shots that are due go off. Runs on the fixed step.
  fireFollowUps() {
    if (!this.followUps.some((f) => f.at <= this.simStep)) return;
    const due = this.followUps.filter((f) => f.at <= this.simStep);
    this.followUps = this.followUps.filter((f) => f.at > this.simStep);
    for (const f of due) {
      const p = this.players[f.owner];
      if (!p.alive) continue;   // knocked out between the two
      this.aimAt(p, f.plan);
      this.launch(p, f.delay);
    }
  }

  // Set a tank's turret, barrel, charge and weapon to a planned shot (a Shell if that ammo is gone).
  aimAt(p, plan) {
    p.yaw = ((plan.yaw % 360) + 360) % 360;
    p.elev = plan.elev;
    p.power = plan.power;
    clampAim(p);
    p.weapon = p.inventory[plan.weapon] > 0 ? plan.weapon : 'shell';
    p.steerGoal = plan.goal || null;
  }

  // A reloading tank's Fire: no shot. Its turn ends (in a volley, it is done
  // planning and sits this one out; launchVolley ends the reload).
  passTurn(p) {
    this.strike = null;
    this.emit({ type: 'pass', player: p.id });
    if (this.volleyMode) {
      delete this.volley.plans[p.id];
      this.volley.done.push(p.id);
      Object.assign(p, this.volley.shown);
      this.emit({ type: 'locked', player: p.id, pass: true });
      this.nextPlanner();
      return true;
    }
    p.reloading = false;
    this.phase = 'settle';
    this.phaseTime = 0.3;
    return true;
  }

  // One tank shoots as it is aimed now. `delay` only staggers the sound and
  // flash of a volley; the shells all leave on the same step.
  launch(p, delay = 0) {
    const w = WEAPON_BY_ID[p.weapon];
    if (!(p.inventory[w.id] > 0)) return false;
    if (!w.infinite) p.inventory[w.id]--;
    const pos = muzzleOrigin(p);
    const vel = launchVelocity(p.yaw, p.elev, p.power);
    const shot = ++p.shotCount;
    p.shots.push({ n: shot, yaw: p.yaw, elev: p.elev, power: p.power, weapon: w.id, at: [p.x, p.y, p.z] });
    if (p.shots.length > AIM_HISTORY.keep) p.shots.shift();
    const range = (w.flight || []).find((f) => f.type === 'range');
    if (range) p.stats.probes++; else p.stats.shots++;
    if (range) {
      // Rangefinder: five probes leave together, each a small change to the aim.
      for (const pb of rangeProbes(p.yaw, p.power, range, TANK.minPower, TANK.maxPower)) {
        this.spawnProjectile(pos, launchVelocity(pb.yaw, p.elev, pb.power), w.id, p.id, shot).probe = pb;
      }
    } else {
      const pr = this.spawnProjectile(pos, vel, w.id, p.id, shot);
      // A CPU steers its Guided Missile for where it aimed (ai.steerGuided).
      if (pr.steer && p.ai && p.steerGoal) { pr.steer.goal = [...p.steerGoal]; pr.steer.ai = p.ai; }
    }
    this.heardFire(p);
    // Every shot tops the tank up by a third of its round's fuel, so a tank
    // can keep moving through a long round instead of running dry early.
    p.fuel = Math.min(p.fuelMax, p.fuel + p.fuelMax * TANK.refuelShare);
    this.emit({ type: 'fire', player: p.id, pos, weapon: w.id, shot, delay });
    return true;
  }

  spawnProjectile(pos, vel, weaponId, owner, shot = 0) {
    const pr = makeProjectile(pos, vel);
    pr.id = (this.nextProjectileId = (this.nextProjectileId || 0) + 1);
    pr.weapon = weaponId;
    pr.owner = owner;
    pr.shot = shot;       // which of the owner's shots it came from
    pr.dead = false;
    pr.splitDone = false;
    pr.g = this.gravity;
    pr.windK = this.windShare(this.players[owner]);
    const drag = this.shellDrag(this.players[owner]);
    if (drag) pr.drag = drag;   // children (split, flak, bomblets) come through here too
    if (this.terrain.wells.length) pr.wells = this.terrain.wells;
    const steer = (WEAPON_BY_ID[weaponId].flight || []).find((f) => f.type === 'steer');
    if (steer) pr.steer = { rate: steer.rate, fuel: steer.fuel, input: 0 };
    this.projectiles.push(pr);
    this.emit({ type: 'projectile', id: pr.id, weapon: weaponId, owner, shot });
    return pr;
  }

  // Turn a tank's guided missiles in flight: -1 left, +1 right (as seen from
  // behind), 0 straight. Holds until changed; burns steering fuel while turning.
  steer(owner, dir) {
    for (const pr of this.projectiles) if (pr.owner === owner && pr.steer) pr.steer.input = Math.max(-1, Math.min(1, dir));
  }

  // ---------- simulation ----------

  update(dt) {
    this.phaseTime += dt;
    this.scenery.update(dt, this.players);
    if (this.phase === 'aim' && this.current && !this.current.alive) {
      if (this.volleyMode) this.nextPlanner(); else this.nextTurn();
      return;
    }
    if (this.phase === 'aim') this.updateAim(dt);
    if (this.phase === 'volley') this.updateVolleyBeat(dt);
    if (this.phase === 'flight' || this.phase === 'settle') {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 40) {
        this.acc -= SIM_DT;
        steps++;
        this.stepWorld(SIM_DT);
      }
      if (this.phase === 'flight' && this.projectiles.length === 0 && !this.followUps.length) {
        this.phase = 'settle';
        this.phaseTime = 0;
      }
      if (this.phase === 'settle' && this.phaseTime > 0.9 && !this.players.some((p) => p.falling)) {
        this.nextTurn();
      }
    }
  }

  updateAim(dt) {
    const p = this.current;
    if (p && p.ai && this.aiDrive) { this.updateAiDrive(p, dt); return; }
    if (p && p.ai && this.volleyMode) { this.nextPlanner(); return; }
    if (!p || !p.ai || !this.aiPlan) {
      if (p && p.ai && !this.aiPlan) this.nextTurn(); // nothing to shoot at
      return;
    }
    const plan = this.aiPlan;
    p.weapon = p.inventory[plan.weapon] > 0 ? plan.weapon : 'shell';
    if (this.phaseTime < plan.think) return;
    if (plan.deploy) { this.deployTurn(p, plan.deploy); return; }   // this turn goes on a mod
    if (this.swingToward(p, plan, dt)) {
      p.yaw = ((plan.yaw % 360) + 360) % 360;
      p.elev = plan.elev;
      p.power = plan.power;
      p.steerGoal = plan.goal || null;
      if (plan.second && !p.reloading) {
        // Double Strike: this aim is shot 1, queued; the second goes as planned.
        this.strike = { player: p.id, first: { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon } };
        this.aimAt(p, plan.second);
      }
      this.fire();
    }
  }

  stepWorld(dt) {
    const t = this.terrain;
    this.simStep++;
    const flying = this.projectiles.length > 0 || this.followUps.length > 0;   // the clock runs
    if (this.followUps.length) this.fireFollowUps();
    const spheres = this.players.filter((p) => p.alive).map(hitSphere);
    // The mods up at this step's clock: orbiter wells pull on every shell but
    // their owner's, and a shell that touches a mod goes off on it.
    const up = anyUp(this.players);
    const wells = up ? modWells(this.players, this.clock) : [];
    const targets = up ? modTargets(this.players, this.clock) : [];
    const extraFor = new Map();
    const extra = (owner) => {
      if (!extraFor.has(owner)) {
        const w = wells.filter((x) => x.owner !== owner);
        extraFor.set(owner, w.length ? w : null);
      }
      return extraFor.get(owner);
    };
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      if (pr.roller) { this.stepRolling(pr, spheres, dt); continue; }
      pr.extra = wells.length ? extra(pr.owner) : null;
      const vyBefore = pr.vel[1];
      if (pr.steer?.goal && pr.steer.fuel > 0) pr.steer.input = steerGuided(pr, pr.steer.goal, pr.steer.ai);
      if (pr.steer && pr.steer.input && pr.steer.fuel > 0) {
        // Swing the horizontal velocity; speed and climb are untouched.
        const a = pr.steer.rate * DEG * dt * pr.steer.input;
        const [vx, , vz] = pr.vel, c = Math.cos(a), sn = Math.sin(a);
        pr.vel[0] = vx * c - vz * sn;
        pr.vel[2] = vz * c + vx * sn;
        pr.steer.fuel = Math.max(0, pr.steer.fuel - dt);
      }
      stepProjectile(pr, this.wind, dt);
      const w = WEAPON_BY_ID[pr.weapon];
      // Apex split.
      if (!pr.splitDone && vyBefore > 0 && pr.vel[1] <= 0 && w.flight) {
        const split = w.flight.find((f) => f.type === 'split');
        if (split) {
          pr.splitDone = true;
          pr.dead = true;
          for (const v of splitVelocities(pr.vel, split.count, split.spread, split.shape)) {
            const child = this.spawnProjectile(pr.pos, v, split.child, pr.owner, pr.shot);
            child.splitDone = true;
          }
          this.emit({ type: 'split', id: pr.id, pos: [...pr.pos] });
          continue;
        }
      }
      // Proximity burst (Flak), on the way down.
      const burst = !pr.splitDone && !pr.probe && w.flight && w.flight.find((f) => f.type === 'airburst');
      if (burst) {
        const [bx, , bz] = pr.pos;
        const ground = t.inBounds(bx, bz) && t.solidAt(bx, bz) ? t.heightAt(bx, bz) : null;
        const nearMod = targets.length ? airburstNearMod(pr, burst, targets) : null;
        if (nearMod || airburstNow(pr, burst, spheres.map((s) => ({ x: s.x, y: s.tank.y, z: s.z, owner: s.tank.id })), ground)) {
          pr.dead = true;
          pr.splitDone = true;
          for (const v of airburstVelocities(pr.vel, burst)) {
            const child = this.spawnProjectile(pr.pos, v, burst.child, pr.owner, pr.shot);
            child.splitDone = true;
          }
          this.emit({ type: 'split', id: pr.id, pos: [...pr.pos], airburst: true });
          // The burst itself shreds any enemy mod in reach (anti-air).
          if (burst.air) this.blastMods(pr.pos, burst.air / 1.25, burst.airDamage, pr.owner);
          continue;
        }
      }
      const [x, y, z] = pr.pos;
      // Into a mod: it goes off there, in the air.
      let struck = null;
      for (const m of targets) {
        if (m.owner === pr.owner) continue;
        if ((x - m.x) ** 2 + (y - m.y) ** 2 + (z - m.z) ** 2 <= m.r * m.r) { struck = m; break; }
      }
      if (struck) {
        this.detonate(pr, [x, y, z], null, false, { owner: struck.owner, mod: struck.mod });
        continue;
      }
      // Direct hit on a tank (the shooter is immune for the first half second).
      let hitTank = null;
      for (const s of spheres) {
        if (s.tank.id === pr.owner && pr.time < 0.5) continue;
        if ((x - s.x) ** 2 + (y - s.y) ** 2 + (z - s.z) ** 2 <= s.r * s.r) { hitTank = s.tank; break; }
      }
      if (hitTank) { this.detonate(pr, [x, y, z], hitTank); continue; }
      const moon = pr.wells && wellContact(pr);
      if (moon) { this.detonate(pr, moon, null, true); continue; }
      if (!t.inBounds(x, z) || y < t.bedrock) {
        if (y < t.bedrock || pr.time > MAX_FLIGHT) this.lose(pr);
        continue;
      }
      const g = groundContact(pr, t);
      if (g) { this.detonate(pr, g, null); continue; }
      if (pr.time > MAX_FLIGHT) this.lose(pr);
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
    this.updateFalling(dt);
    if (flying) this.clock += dt;
  }

  lose(pr) {
    pr.dead = true;
    this.emit({ type: 'lost', id: pr.id, pos: [...pr.pos] });
  }

  // `moon`: it struck a moon. `struck`: it struck a mod ({ owner, mod }), in the air.
  detonate(pr, point, directHit, moon = false, struck = null) {
    const w = WEAPON_BY_ID[pr.weapon];
    // A rolling weapon that lands on open ground starts its run instead.
    if (rollPart(w) && !directHit && !pr.roller && !moon && !struck) {
      pr.roller = makeRoller(point, pr.vel, this.terrain);
      pr.pos = pr.roller.pos;
      this.emit({ type: 'rollStart', id: pr.id, pos: point });
      return;
    }
    pr.dead = true;
    this.emit({ type: 'impact', id: pr.id, pos: point });
    for (const fx of impactEffects(w, point)) this.applyEffect(struck ? { ...fx, struck } : fx, pr.owner, directHit, pr.shot);
    if (pr.weapon === 'shell' && !directHit && !moon && !struck) this.throwShrapnel(pr, point);
  }

  // Shrapnel perk: a plain Shell that hits the ground lobs bomblets onward.
  throwShrapnel(pr, point) {
    const n = perkSum(this.players[pr.owner], 'shrapnel');
    if (!n) return;
    const h = Math.hypot(pr.vel[0], pr.vel[2]) || 1;
    const ux = pr.vel[0] / h;
    const uz = pr.vel[2] / h;
    for (let k = 0; k < n; k++) {
      const side = n === 1 ? 0 : (k / (n - 1)) * 2 - 1;
      const vel = [ux * 9 - uz * side * 5, 12, uz * 9 + ux * side * 5];
      const child = this.spawnProjectile([point[0], this.terrain.heightAt(point[0], point[2]) + 0.8, point[2]], vel, 'bomblet', pr.owner, pr.shot);
      child.splitDone = true;
    }
  }

  // A roller on the ground: follow the surface until it stops, runs out of
  // road or bumps into a tank (its owner included).
  stepRolling(pr, spheres, dt) {
    const end = stepRoller(pr.roller, this.terrain, dt);
    const [x, y, z] = pr.pos;
    const ground = [x, y - ROLL.radius, z];
    for (const s of spheres) {
      if ((x - s.x) ** 2 + (y - s.y) ** 2 + (z - s.z) ** 2 <= (s.r + ROLL.radius) ** 2) {
        this.detonate(pr, ground, s.tank);
        return;
      }
    }
    // A roller that sinks into a lake goes off there instead of crawling along the bed.
    const sunk = y < this.terrain.waterLevel - 0.5;
    if (end || sunk) this.detonate(pr, ground, null);
  }

  applyEffect(fx, owner, directHit, shot = 0) {
    const t = this.terrain;
    if (fx.type === 'scout') {
      if (!this.cfg.fog || owner == null) return;
      // Counted in the shooter's shots: in turns, everyone else's go in between.
      const per = this.volleyMode ? 1 : this.alivePlayers().length;
      this.reveals.push({ owner, x: fx.point[0], z: fx.point[2], r: fx.radius, until: this.turnsThisRound + 1 + (fx.turns - 1) * per });
      this.refreshIntel();
      this.emit({ type: 'scout', pos: fx.point, radius: fx.radius, owner });
      return;
    }
    if (fx.type === 'warp') {
      // The shooter's tank goes where the shell came down, nudged to the
      // nearest spot it can stand on. A tank blown up in the same volley stays put.
      const p = owner != null ? this.players[owner] : null;
      if (!p || !p.alive) return;
      const spot = findSpot(p, t, this.obstacles(), fx.point[0], fx.point[2]);
      if (!spot) return;
      const from = [p.x, p.y, p.z];
      p.x = spot.x; p.y = spot.y; p.z = spot.z;
      p.hitsHere = 0;
      this.emit({ type: 'warp', player: p.id, from, to: [p.x, p.y, p.z] });
      return;
    }
    if (fx.type === 'mound') {
      const region = t.raiseMound(fx.point[0], fx.point[2], fx.radius, fx.height);
      this.ground?.ops.push(['m', fx.point[0], fx.point[2], fx.radius, fx.height]);
      this.emit({ type: 'terrain', region });
      this.emit({ type: 'mound', pos: fx.point, radius: fx.radius });
      this.liftBuried();
      this.scenery.afterMound(fx.point[0], fx.point[2], fx.radius);
      this.relayScenery();
      return;
    }
    if (fx.type === 'blast') {
      const [bx, by, bz] = fx.point;
      const o = owner != null ? this.players[owner] : null;
      const radius = fx.radius * (1 + (o ? perkSum(o, 'blastRadius') : 0));
      const damage = fx.damage * (1 + (o ? perkSum(o, 'blastDamage') : 0));
      this.emit({ type: 'explosion', pos: fx.point, radius });
      // A blast high in the air (on a mod) leaves the ground alone.
      const g = this.groundAt(bx, bz);
      if (!(by - (g ?? -Infinity) > radius)) this.carve(bx, by, bz, radius * (this.modifier.crater || 1), fx.depth);
      this.blastMods(fx.point, radius, damage, owner, fx.struck);
      for (const p of this.players) {
        if (!p.alive) continue;
        // Whoever blows the ground out from under a tank on the isles gets the credit for its fall.
        if (this.isles && Math.hypot(p.x - bx, p.z - bz) < radius * 1.5) p.blamed = owner;
        const s = hitSphere(p);
        const dist = p === directHit ? 0 : Math.max(0, Math.hypot(s.x - bx, s.y - by, s.z - bz) - TANK.hitRadius * 0.5);
        const dmg = blastDamage(dist, radius, damage);
        if (dmg > 0) this.damage(p, dmg, owner, shot);
      }
    }
  }

  damage(p, amount, from, shot = 0) {
    let rest = amount;
    const before = p.hp + p.armor;
    if (p.armor > 0) {
      const soak = Math.min(p.armor, rest);
      p.armor -= soak;
      rest -= soak;
    }
    p.hp = Math.max(0, p.hp - rest);
    const dealt = before - p.hp - p.armor;   // what it really took off, for the match stats
    const attacker = from != null ? this.players[from] : null;
    const payK = this.modifier.pay || 1;
    if (attacker && attacker !== p) {
      this.earn(attacker, 'damage', Math.round(amount * PAY.perDamage * (1 + perkSum(attacker, 'pay')) * payK));
      attacker.roundDamage = (attacker.roundDamage || 0) + amount;
      p.hitsHere++;
      p.hitBy = attacker.id;
      const st = attacker.stats;
      st.damage += dealt;
      if (dealt > 0 && shot && shot !== st.lastHit) { st.hits++; st.lastHit = shot; }
      const origin = attacker.shots.find((s) => s.n === shot)?.at || [attacker.x, attacker.y, attacker.z];
      st.longest = Math.max(st.longest, Math.hypot(p.x - origin[0], p.z - origin[2]));
    }
    p.stats.taken += dealt;
    this.emit({ type: 'damage', player: p.id, amount, hp: p.hp, by: attacker ? attacker.id : null });
    if (p.hp <= 0 && p.alive) {
      p.alive = false;
      if (attacker && attacker !== p) { this.earn(attacker, 'kill', PAY.kill * payK); attacker.stats.kills++; }
      this.emit({ type: 'destroyed', player: p.id, by: from, pos: [p.x, p.y, p.z] });
      this.dropMods(p);
      // The wreck cooks off: a small crater of its own.
      this.carve(p.x, p.y, p.z, 7, 0.4);
    }
  }

  // Dig a crater and let the scenery react to it.
  carve(x, y, z, radius, depth) {
    const top = this.topBlast(x, y, z, radius);
    const region = this.terrain.carveCrater(x, y, z, radius, depth);
    this.ground?.ops.push(['c', x, y, z, radius, depth]);
    this.emit({ type: 'terrain', region });
    this.sceneryBlast(top, x, z, radius);
    this.relayScenery();
  }

  // Did a blast go off on the ground's top, where the scenery stands? Always
  // on an ordinary field. On the isles, not under an isle or high over it.
  topBlast(x, y, z, radius) {
    const t = this.terrain;
    if (!t.under) return true;
    const h = t.heightAt(x, z);
    return t.solidAt(x, z) && y > h - radius * 0.6 && y < h + radius;
  }

  sceneryBlast(top, x, z, radius) {
    if (top) this.scenery.afterBlast(x, z, radius);
    else this.scenery.settle(x, z, radius + 6 + this.terrain.cell);   // only what fell through a hole
  }

  relayScenery() {
    for (const e of this.scenery.drainEvents()) this.emit(e);
  }

  liftBuried() {
    for (const p of this.players) {
      if (!this.terrain.solidAt(p.x, p.z)) continue;
      const g = this.terrain.heightAt(p.x, p.z);
      if (g > p.y) p.y = g;
    }
  }

  // ---------- online (core/netplay.js) ----------

  // Everything another copy of the game needs to carry on from here exactly:
  // taken by the host at the start of each volley. Plain JSON.
  snapshot() {
    const copy = (o) => JSON.parse(JSON.stringify(o));   // Infinity becomes null; restore puts it back
    return {
      round: this.round, turnsThisRound: this.turnsThisRound, firstShooter: this.firstShooter,
      wind: [...this.wind], gravity: this.gravity, drag: this.drag, maxWind: this.maxWind, modifier: this.modifier.id,
      rng: this.rng.state(), rogue: this.rogue.state(), nextProjectileId: this.nextProjectileId || 0, clock: this.clock,
      lastRoundResult: this.lastRoundResult,
      volley: this.volley ? { plans: copy(this.volley.plans), done: [...this.volley.done] } : null,
      reveals: copy(this.reveals), intel: copy(this.intel),
      ground: copy(this.ground),
      players: this.players.map(copy),
    };
  }

  // Take on the host's snapshot. The ground is only rebuilt when this copy's
  // craters have drifted from the host's.
  restore(s) {
    if (s.round !== this.round || !sameGround(this.ground, s.ground)) {
      this.rebuildGround(s.round, s.ground);
      this.emit({ type: 'terrain', full: true });
    }
    this.ground = JSON.parse(JSON.stringify(s.ground));
    Object.assign(this, {
      round: s.round, turnsThisRound: s.turnsThisRound, firstShooter: s.firstShooter, gravity: s.gravity,
      maxWind: s.maxWind, lastRoundResult: s.lastRoundResult, nextProjectileId: s.nextProjectileId, clock: s.clock || 0,
    });
    this.wind = [...s.wind];
    this.reveals = JSON.parse(JSON.stringify(s.reveals || []));
    this.intel = JSON.parse(JSON.stringify(s.intel || []));
    this.modifier = MODIFIER_BY_ID[s.modifier] || MODIFIER_BY_ID.clear;
    this.drag = s.drag ?? (this.modifier.drag || 0);
    this.rng.setState(s.rng);
    this.rogue.setState(s.rogue);
    s.players.forEach((q, i) => {
      const p = this.players[i];
      const wasAlive = p.alive;
      Object.assign(p, JSON.parse(JSON.stringify(q)));
      for (const k of Object.keys(p.inventory)) if (WEAPON_BY_ID[k]?.infinite) p.inventory[k] = Infinity;
      if (wasAlive && !p.alive) this.emit({ type: 'destroyed', player: p.id, by: null, pos: [p.x, p.y, p.z] });
    });
    if (s.volley) this.volley = { queue: [], plans: s.volley.plans, done: s.volley.done, shown: null };
    this.projectiles = [];
    this.followUps = [];
    this.strike = null;
  }

  // Remake this round's ground from its seed, the tank pads and every crater
  // and mound since, in order.
  rebuildGround(round, ground) {
    const t = this.terrain;
    this.makeGround(round, ground.starts);
    this.scenery.generate({ seed: this.cfg.seed + round * 104729, tanks: this.players });
    for (const op of ground.ops) {
      if (op[0] === 'c') {
        const top = this.topBlast(op[1], op[2], op[3], op[4]);
        t.carveCrater(op[1], op[2], op[3], op[4], op[5]);
        this.sceneryBlast(top, op[1], op[3], op[4]);
      }
      else { t.raiseMound(op[1], op[2], op[3], op[4]); this.scenery.afterMound(op[1], op[2], op[3]); }
    }
    this.scenery.drainEvents();
  }

  // Tanks drop into craters dug beneath them and take fall damage on landing.
  updateFalling(dt) {
    const t = this.terrain;
    for (const p of this.players) {
      // Over open sky (the ground blown out from under it) a tank falls for good.
      const g = t.solidAt(p.x, p.z) ? t.heightAt(p.x, p.z) : -Infinity;
      if (g === -Infinity && p.y < ISLES.voidY - 20) {
        if (p.alive) {
          this.emit({ type: 'void', player: p.id, pos: [p.x, p.y, p.z] });
          this.damage(p, p.hp + p.armor, p.blamed ?? null);
        }
        p.falling = false;
        p.vy = 0;
        continue;
      }
      if (g > p.y) { p.y = g; p.falling = false; p.vy = 0; continue; }
      if (p.y > g + 0.02) {
        if (!p.falling) { p.falling = true; p.vy = 0; p.fallFrom = p.y; }
        p.vy -= GRAVITY * dt;
        p.y += p.vy * dt;
        if (p.y <= g) {
          p.y = g;
          p.falling = false;
          const drop = p.fallFrom - g;
          const dmg = Math.max(0, (drop - 2.5) * 2.2);
          if (dmg > 0 && p.alive && !hasPerk(p, 'noFall')) {
            this.emit({ type: 'landed', player: p.id, drop });
            this.damage(p, dmg, null);
          }
          p.vy = 0;
        }
      } else if (p.falling) {
        p.falling = false;
        p.vy = 0;
      }
    }
  }
}

// A well-stirred 32-bit hash of some integers (fog offsets).
function hash32(...xs) {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}

// Same pads and the same craters, to the centimetre?
function sameGround(a, b) {
  if (!a || !b) return false;
  const r = (g) => JSON.stringify([g.starts, g.ops], (k, v) => (typeof v === 'number' ? Math.round(v * 100) : v));
  return r(a) === r(b);
}
