import { makeRng } from './rng.js';
import { Heightfield, ISLES } from './terrain.js';
import { makeProjectile, stepProjectile, groundContact, wellContact, launchVelocity, makeRoller, stepRoller, ROLL, SIM_DT, MAX_FLIGHT, GRAVITY } from './ballistics.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS, impactEffects, rollPart, blastDamage, splitVelocities, rangeProbes } from './weapons.js';
import { TANK, JET, muzzleOrigin, hitSphere, clampAim, driveStep, planHop, findSpot } from './tank.js';
import { planShot, planDrive, planJump, chooseTarget, chooseWeapon, chooseSecondWeapon, wantsDouble } from './ai.js';
import { Scenery, standing } from './scenery.js';
import { PERK_BY_ID, MODIFIER_BY_ID, perkSum, hasPerk, draftOffer, aiPickPerk, pickModifier } from './perks.js';

export const PLAYER_COLORS = ['#e8553f', '#3f8be8', '#f2c230', '#4cc77a', '#b06ce6', '#ef8bc0'];

const DEG = Math.PI / 180;
const START_INVENTORY = { shell: Infinity, guided: 1, breacher: 1, roller: 1, mound: 1, scatter: 0, ranger: 2 };
const START_JETS = 1;   // jump jet charges each tank starts the match with (they carry over between rounds)

// Money awards.
// Everyone gets the stipend, so even a tank that was knocked out early has
// something to spend in the shop.
export const PAY = { perDamage: 2, kill: 150, survive: 80, roundWin: 300, stipend: 150 };

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

export class Game {
  constructor({
    players,
    rounds = 3,
    seed = (Math.random() * 1e9) | 0,
    maxWind = 1.5,
    terrainSize = 800,
    resolution = 256,
    hills = 45,
    world = 'meadow',   // 'meadow', or 'isles': floating isles in open sky, with moons that pull on shells
    maxTurnsPerRound = 40,
    twists = true,      // perk drafts and round modifiers (core/perks.js)
    firing = 'turns',   // 'turns', or 'volley': everyone plans, then all fire together
    fog = false,        // fog of war: see FOG
    // Online play (core/netplay.js): the ids of the tanks played on this
    // screen. The other humans plan elsewhere; their plans arrive by message.
    local = null,
  }) {
    this.cfg = { rounds, seed, maxWind, terrainSize, resolution, hills, world, maxTurnsPerRound, twists, firing, local, fog };
    this.reveals = [];                          // fog: live scout bursts { owner, x, z, r, until }
    this.intel = [];                            // fog: viewer id -> { target id: { x, z, r, at } }
    this.volley = null;                         // { queue, plans, shown } while a volley is being planned
    this.rng = makeRng(seed);
    this.rogue = makeRng(seed ^ 0x5bd1e995);   // drafts, modifiers and CPU driving roll their own dice
    this.modifier = MODIFIER_BY_ID.clear;
    this.gravity = GRAVITY;
    this.maxWind = maxWind;
    this.draft = {};                            // human id -> perk ids on offer
    this.players = players.map((p, i) => ({
      id: i,
      name: p.name || `Player ${i + 1}`,
      color: p.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
      ai: p.ai || null,
      money: 0,
      score: 0,
      wins: 0,
      inventory: { ...START_INVENTORY, ...(local ? { guided: 0 } : {}) },   // no steering online
      jets: START_JETS,
      pendingArmor: 0,
      pendingFuel: 0,
      perks: [],
      // per-round state
      x: 0, y: 0, z: 0, yaw: 0, elev: 45, power: 60,
      hull: 0, fuel: 0, fuelMax: 0, hitsHere: 0,
      hp: TANK.maxHp, maxHp: TANK.maxHp, armor: 0, alive: true,
      weapon: 'shell', falling: false, vy: 0, fallFrom: 0,
      reloading: false,   // fired a Double Strike: its next turn is move only (see STRIKE)
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

  start() {
    this.startRound();
  }

  // ---------- rounds ----------

  startRound() {
    this.round++;
    const t = this.terrain;
    const mod = this.modifier = this.cfg.twists ? pickModifier(this.rogue, this.modifier.id) : MODIFIER_BY_ID.clear;
    this.gravity = GRAVITY * (mod.gravity || 1);
    this.maxWind = mod.calm ? 0 : this.cfg.maxWind * (mod.wind || 1);
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
      for (const id of p.perks) {
        for (const [w, n] of Object.entries(PERK_BY_ID[id].roundAmmo || {})) p.inventory[w] = (p.inventory[w] || 0) + n;
      }
      if (this.cfg.fog) p.inventory.scout = (p.inventory.scout || 0) + 1;   // a free scout each round
      p.alive = true;
      p.falling = false;
      p.vy = 0;
      p.blamed = null;
      p.weapon = 'shell';
      p.power = 60;
      p.elev = 45;
      p.roundDamage = 0;
      p.reloading = false;
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
    return order.map((pi, k) => {
      const a = base + (k / n) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
      const r = ring * this.rng.range(0.8, 1.15);
      return [pi, Math.cos(a) * r, Math.sin(a) * r];
    });
  }

  get isles() { return this.cfg.world === 'isles'; }

  // The round's ground from its seed, then a flat pad under each tank, in pad
  // order (`starts` is [player index, x, z]). The isles are laid out around
  // the pads, so every tank starts on an isle of its own.
  makeGround(round, starts) {
    const t = this.terrain;
    const seed = this.cfg.seed + round * 7919;
    if (this.isles) t.generateIsles({ seed, amplitude: this.cfg.hills, pads: starts.map(([, x, z]) => [x, z]) });
    else t.generate({ seed, amplitude: this.cfg.hills });
    for (const [i, x, z] of starts) {
      const p = this.players[i];
      p.x = x; p.z = z;
      t.flatten(x, z, TANK.padRadius);
      p.y = t.heightAt(x, z);
    }
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
      if (plan) v.plans[p.id] = { yaw: plan.yaw, elev: plan.elev, power: plan.power, weapon: plan.weapon, ...(plan.second ? { second: plan.second } : {}) };
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

  planAiShot(p) {
    // Reloading after a Double Strike: nothing to aim, Fire only passes.
    if (p.reloading) return (this.aiPlan = { yaw: p.yaw, elev: p.elev, power: p.power, weapon: p.weapon, pass: true, think: 0.6 });
    const target = chooseTarget(p, this.knownFoes(p), p.ai, this.rng);
    if (!target) return null;
    // In the fog, a CPU that only has a rough fix sends a scout there first, now and then.
    const scout = target.rough && p.inventory.scout > 0 && this.rng.next() < 0.45;
    const sol = planShot({
      shooter: p,
      target,
      wind: this.wind,
      terrain: this.terrain,
      rng: this.rng,
      difficulty: p.ai,
      memory: p.aim,
      gravity: this.gravity,
      windK: this.windShare(p),
    });
    const plan = { ...sol, weapon: scout ? 'scout' : chooseWeapon(p, target, this.rng), target: target.id, think: 0.6 };
    if (!scout && hasPerk(p, 'doubleStrike') && wantsDouble({ target, memory: p.aim, difficulty: p.ai, rng: this.rng })) {
      const again = planShot({ shooter: p, target, wind: this.wind, terrain: this.terrain, rng: this.rng, difficulty: p.ai,
        memory: p.aim, gravity: this.gravity, windK: this.windShare(p) });
      plan.second = { yaw: again.yaw, elev: again.elev, power: again.power, weapon: chooseSecondWeapon(p, plan.weapon, this.rng) };
    }
    return (this.aiPlan = plan);
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
    if (!this.cfg.fog) return this.players.filter((q) => q !== p && q.alive);
    const out = [];
    for (const q of this.players) {
      const i = this.intel[p.id]?.[q.id];
      if (q === p || !q.alive || !i) continue;
      const t = this.terrain;
      const y = t.inBounds(i.x, i.z) ? t.heightAt(i.x, i.z) : q.y;
      out.push({ id: q.id, x: i.x, y, z: i.z, hp: q.hp, armor: q.armor, alive: true, rough: i.r > 0 });
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
    for (const p of this.players) p.money += PAY.stipend * payK;
    for (const p of alive) p.money += PAY.survive * payK;
    if (winner) { winner.wins++; winner.money += PAY.roundWin * payK; winner.score += 1; }
    this.lastRoundResult = { round: this.round, winner: winner ? winner.id : null };
    this.phase = this.round >= this.cfg.rounds ? 'matchOver' : 'roundOver';
    this.phaseTime = 0;
    this.turn = -1;
    this.emit({ type: this.phase, winner: winner ? winner.id : null });
  }

  // From roundOver: every tank is offered three perks and keeps one, then
  // shops. Humans do both through the UI; CPUs do both here.
  openShop() {
    if (this.phase !== 'roundOver') return;
    this.phase = 'shop';
    this.phaseTime = 0;
    this.draft = {};
    this.shopped = [];                          // online: humans whose shopping is in
    for (const p of this.players) { p.bought = []; p.picked = null; }
    for (const p of this.players) {
      const offer = this.cfg.twists ? draftOffer(p, this.rogue, 3, this.round + 1) : [];
      if (!offer.length) continue;
      if (p.ai) p.perks.push(aiPickPerk(offer, this.rogue));
      else this.draft[p.id] = offer;
    }
    for (const p of this.players) if (p.ai) this.aiShop(p);
    this.emit({ type: 'shop' });
    if (!this.humans.length) this.closeShop();
  }

  pickPerk(playerId, id) {
    const offer = this.draft[playerId];
    if (this.phase !== 'shop' || !offer || !offer.includes(id)) return false;
    this.players[playerId].perks.push(id);
    this.players[playerId].picked = id;
    delete this.draft[playerId];
    return true;
  }

  closeShop() {
    if (this.phase !== 'shop') return;
    // Anyone who walked past the draft takes the first card.
    for (const [pid, offer] of Object.entries(this.draft)) this.pickPerk(Number(pid), offer[0]);
    this.startRound();
  }

  // What this tank pays for an armory item (perks can lower it).
  priceOf(p, id) {
    const it = WEAPON_BY_ID[id] || ITEMS.find((x) => x.id === id);
    if (!it || !(it.price > 0)) return Infinity;
    return Math.round((it.price * (1 - Math.min(0.5, perkSum(p, 'discount')))) / 5) * 5;
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
    return true;
  }

  aiShop(p) {
    const wishlist = ['breacher', 'scatter', 'flak', 'armor', 'roller', 'fuel', 'jet', 'breacher'];
    for (const id of wishlist) this.buy(p.id, id);
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
    } else this.spawnProjectile(pos, vel, w.id, p.id, shot);
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
    if (this.swingToward(p, plan, dt)) {
      p.yaw = ((plan.yaw % 360) + 360) % 360;
      p.elev = plan.elev;
      p.power = plan.power;
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
    if (this.followUps.length) this.fireFollowUps();
    const spheres = this.players.filter((p) => p.alive).map(hitSphere);
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      if (pr.roller) { this.stepRolling(pr, spheres, dt); continue; }
      const vyBefore = pr.vel[1];
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
        pr.splitDone = true;
        const split = w.flight.find((f) => f.type === 'split');
        if (split) {
          pr.dead = true;
          for (const v of splitVelocities(pr.vel, split.count, split.spread, split.shape)) {
            const child = this.spawnProjectile(pr.pos, v, split.child, pr.owner, pr.shot);
            child.splitDone = true;
          }
          this.emit({ type: 'split', id: pr.id, pos: [...pr.pos] });
          continue;
        }
      }
      const [x, y, z] = pr.pos;
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
  }

  lose(pr) {
    pr.dead = true;
    this.emit({ type: 'lost', id: pr.id, pos: [...pr.pos] });
  }

  detonate(pr, point, directHit, moon = false) {
    const w = WEAPON_BY_ID[pr.weapon];
    // A rolling weapon that lands on open ground starts its run instead.
    if (rollPart(w) && !directHit && !pr.roller && !moon) {
      pr.roller = makeRoller(point, pr.vel, this.terrain);
      pr.pos = pr.roller.pos;
      this.emit({ type: 'rollStart', id: pr.id, pos: point });
      return;
    }
    pr.dead = true;
    this.emit({ type: 'impact', id: pr.id, pos: point });
    for (const fx of impactEffects(w, point)) this.applyEffect(fx, pr.owner, directHit, pr.shot);
    if (pr.weapon === 'shell' && !directHit && !moon) this.throwShrapnel(pr, point);
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
      this.carve(bx, by, bz, radius * (this.modifier.crater || 1), fx.depth);
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
      attacker.money += Math.round(amount * PAY.perDamage * (1 + perkSum(attacker, 'pay')) * payK);
      attacker.roundDamage = (attacker.roundDamage || 0) + amount;
      p.hitsHere++;
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
      if (attacker && attacker !== p) { attacker.money += PAY.kill * payK; attacker.stats.kills++; }
      this.emit({ type: 'destroyed', player: p.id, by: from, pos: [p.x, p.y, p.z] });
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
      wind: [...this.wind], gravity: this.gravity, maxWind: this.maxWind, modifier: this.modifier.id,
      rng: this.rng.state(), rogue: this.rogue.state(), nextProjectileId: this.nextProjectileId || 0,
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
      maxWind: s.maxWind, lastRoundResult: s.lastRoundResult, nextProjectileId: s.nextProjectileId,
    });
    this.wind = [...s.wind];
    this.reveals = JSON.parse(JSON.stringify(s.reveals || []));
    this.intel = JSON.parse(JSON.stringify(s.intel || []));
    this.modifier = MODIFIER_BY_ID[s.modifier] || MODIFIER_BY_ID.clear;
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
