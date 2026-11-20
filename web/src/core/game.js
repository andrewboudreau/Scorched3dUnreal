import { makeRng } from './rng.js';
import { Heightfield } from './terrain.js';
import { makeProjectile, stepProjectile, groundContact, launchVelocity, SIM_DT, MAX_FLIGHT, GRAVITY } from './ballistics.js';
import { WEAPONS, WEAPON_BY_ID, ITEMS, impactEffects, blastDamage, splitVelocities } from './weapons.js';
import { TANK, muzzleOrigin, hitSphere, clampAim } from './tank.js';
import { solveShot, chooseTarget, chooseWeapon } from './ai.js';

export const PLAYER_COLORS = ['#e8553f', '#3f8be8', '#f2c230', '#4cc77a', '#b06ce6', '#ef8bc0'];

const START_INVENTORY = { shell: Infinity, breacher: 1, roller: 1, mound: 1, scatter: 0 };

// Money awards.
const PAY = { perDamage: 2, kill: 150, survive: 80, roundWin: 300 };

export class Game {
  constructor({
    players,
    rounds = 3,
    seed = (Math.random() * 1e9) | 0,
    maxWind = 1.5,
    terrainSize = 800,
    resolution = 256,
    hills = 45,
    maxTurnsPerRound = 40,
  }) {
    this.cfg = { rounds, seed, maxWind, terrainSize, resolution, hills, maxTurnsPerRound };
    this.rng = makeRng(seed);
    this.players = players.map((p, i) => ({
      id: i,
      name: p.name || `Player ${i + 1}`,
      color: p.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
      ai: p.ai || null,
      money: 0,
      score: 0,
      wins: 0,
      inventory: { ...START_INVENTORY },
      pendingArmor: 0,
      // per-round state
      x: 0, y: 0, z: 0, yaw: 0, elev: 45, power: 60,
      hp: TANK.maxHp, armor: 0, alive: true,
      weapon: 'shell', falling: false, vy: 0, fallFrom: 0,
    }));
    this.round = 0;
    this.terrain = new Heightfield({ size: terrainSize, resolution });
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
  }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  get current() { return this.turn >= 0 ? this.players[this.turn] : null; }
  get humans() { return this.players.filter((p) => !p.ai); }
  alivePlayers() { return this.players.filter((p) => p.alive); }

  start() {
    this.startRound();
  }

  // ---------- rounds ----------

  startRound() {
    this.round++;
    const t = this.terrain;
    t.generate({ seed: this.cfg.seed + this.round * 7919, amplitude: this.cfg.hills });
    this.placeTanks();
    for (const p of this.players) {
      p.hp = TANK.maxHp;
      p.armor = p.pendingArmor;
      p.pendingArmor = 0;
      p.alive = true;
      p.falling = false;
      p.vy = 0;
      p.weapon = 'shell';
      p.power = 60;
      p.elev = 45;
      p.roundDamage = 0;
    }
    // Everyone starts aiming at the arena centre.
    for (const p of this.players) p.yaw = ((Math.atan2(-p.z, -p.x) * 180) / Math.PI + 360) % 360;
    this.wind = this.randomWind();
    this.projectiles = [];
    this.turnsThisRound = 0;
    this.firstShooter = (this.firstShooter + 1) % this.players.length;
    this.emit({ type: 'roundStart', round: this.round });
    this.emit({ type: 'terrain', full: true });
    this.beginTurn(this.firstShooter);
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
    order.forEach((pi, k) => {
      const a = base + (k / n) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
      const r = ring * this.rng.range(0.8, 1.15);
      const p = this.players[pi];
      p.x = Math.cos(a) * r;
      p.z = Math.sin(a) * r;
      t.flatten(p.x, p.z, TANK.padRadius);
      p.y = t.heightAt(p.x, p.z);
    });
  }

  randomWind() {
    const m = this.cfg.maxWind;
    if (m <= 0) return [0, 0];
    const a = this.rng.range(0, Math.PI * 2);
    const s = this.rng.range(0, m);
    return [Math.cos(a) * s, Math.sin(a) * s];
  }

  driftWind() {
    const m = this.cfg.maxWind;
    if (m <= 0) return;
    let [wx, wz] = this.wind;
    wx += this.rng.gauss() * m * 0.15;
    wz += this.rng.gauss() * m * 0.15;
    const s = Math.hypot(wx, wz);
    if (s > m) { wx *= m / s; wz *= m / s; }
    this.wind = [wx, wz];
  }

  // ---------- turns ----------

  beginTurn(index) {
    this.turn = index;
    this.phase = 'aim';
    this.phaseTime = 0;
    const p = this.current;
    if (!(p.inventory[p.weapon] > 0)) p.weapon = 'shell';
    this.aiPlan = null;
    if (p.ai) this.planAi(p);
    this.emit({ type: 'turn', player: p.id });
  }

  planAi(p) {
    const target = chooseTarget(p, this.players, p.ai, this.rng);
    if (!target) return;
    const sol = solveShot({
      shooter: p,
      target: [target.x, target.y + 1, target.z],
      wind: this.wind,
      terrain: this.terrain,
      rng: this.rng,
      difficulty: p.ai,
    });
    this.aiPlan = { ...sol, weapon: chooseWeapon(p, target, this.rng), target: target.id, think: 0.6 };
  }

  nextTurn() {
    const alive = this.alivePlayers();
    this.turnsThisRound++;
    if (alive.length <= 1 || this.turnsThisRound >= this.cfg.maxTurnsPerRound * this.players.length) {
      this.endRound();
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
    for (const p of alive) p.money += PAY.survive;
    if (winner) { winner.wins++; winner.money += PAY.roundWin; winner.score += 1; }
    this.lastRoundResult = { round: this.round, winner: winner ? winner.id : null };
    this.phase = this.round >= this.cfg.rounds ? 'matchOver' : 'roundOver';
    this.phaseTime = 0;
    this.turn = -1;
    this.emit({ type: this.phase, winner: winner ? winner.id : null });
  }

  // From roundOver: humans shop, AIs buy automatically.
  openShop() {
    if (this.phase !== 'roundOver') return;
    for (const p of this.players) if (p.ai) this.aiShop(p);
    this.phase = 'shop';
    this.phaseTime = 0;
    this.emit({ type: 'shop' });
    if (!this.humans.length) this.closeShop();
  }

  closeShop() {
    if (this.phase !== 'shop') return;
    this.startRound();
  }

  buy(playerId, id) {
    const p = this.players[playerId];
    const w = WEAPON_BY_ID[id];
    const item = ITEMS.find((it) => it.id === id);
    const price = w ? w.price : item ? item.price : Infinity;
    if (!(price > 0) || p.money < price) return false;
    p.money -= price;
    if (w) p.inventory[id] = (p.inventory[id] || 0) + w.bundle;
    else if (id === 'armor') p.pendingArmor += 30;
    return true;
  }

  aiShop(p) {
    const wishlist = ['breacher', 'scatter', 'armor', 'roller', 'breacher'];
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
    const list = WEAPONS.filter((w) => !w.hidden && p.inventory[w.id] > 0);
    const i = list.findIndex((w) => w.id === p.weapon);
    p.weapon = list[(i + dir + list.length) % list.length].id;
  }

  fire() {
    const p = this.current;
    if (this.phase !== 'aim' || !p || !p.alive) return false;
    const w = WEAPON_BY_ID[p.weapon];
    if (!(p.inventory[w.id] > 0)) return false;
    if (!w.infinite) p.inventory[w.id]--;
    const pos = muzzleOrigin(p);
    const vel = launchVelocity(p.yaw, p.elev, p.power);
    this.spawnProjectile(pos, vel, w.id, p.id);
    this.phase = 'flight';
    this.phaseTime = 0;
    this.emit({ type: 'fire', player: p.id, pos, weapon: w.id });
    return true;
  }

  spawnProjectile(pos, vel, weaponId, owner) {
    const pr = makeProjectile(pos, vel);
    pr.id = (this.nextProjectileId = (this.nextProjectileId || 0) + 1);
    pr.weapon = weaponId;
    pr.owner = owner;
    pr.dead = false;
    pr.splitDone = false;
    this.projectiles.push(pr);
    this.emit({ type: 'projectile', id: pr.id, weapon: weaponId });
    return pr;
  }

  // ---------- simulation ----------

  update(dt) {
    this.phaseTime += dt;
    if (this.phase === 'aim' && this.current && !this.current.alive) { this.nextTurn(); return; }
    if (this.phase === 'aim') this.updateAim(dt);
    if (this.phase === 'flight' || this.phase === 'settle') {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 40) {
        this.acc -= SIM_DT;
        steps++;
        this.stepWorld(SIM_DT);
      }
      if (this.phase === 'flight' && this.projectiles.length === 0) {
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
    if (!p || !p.ai || !this.aiPlan) {
      if (p && p.ai && !this.aiPlan) this.nextTurn(); // nothing to shoot at
      return;
    }
    const plan = this.aiPlan;
    p.weapon = p.inventory[plan.weapon] > 0 ? plan.weapon : 'shell';
    if (this.phaseTime < plan.think) return;
    // Swing the turret and barrel toward the plan at the tank's real speeds.
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
    if (Math.abs(dy) < 0.01 && Math.abs(de) < 0.01 && Math.abs(dp) < 0.01) {
      p.yaw = ((plan.yaw % 360) + 360) % 360;
      p.elev = plan.elev;
      p.power = plan.power;
      this.fire();
    }
  }

  stepWorld(dt) {
    const t = this.terrain;
    const spheres = this.players.filter((p) => p.alive).map(hitSphere);
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      const vyBefore = pr.vel[1];
      stepProjectile(pr, this.wind, dt);
      const w = WEAPON_BY_ID[pr.weapon];
      // Apex split.
      if (!pr.splitDone && vyBefore > 0 && pr.vel[1] <= 0 && w.flight) {
        pr.splitDone = true;
        const split = w.flight.find((f) => f.type === 'split');
        if (split) {
          pr.dead = true;
          for (const v of splitVelocities(pr.vel, split.count, split.spread)) {
            const child = this.spawnProjectile(pr.pos, v, split.child, pr.owner);
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
      if (!t.inBounds(x, z)) {
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

  detonate(pr, point, directHit) {
    pr.dead = true;
    this.emit({ type: 'impact', id: pr.id, pos: point });
    const w = WEAPON_BY_ID[pr.weapon];
    for (const fx of impactEffects(w, point, this.terrain)) this.applyEffect(fx, pr.owner, directHit);
  }

  applyEffect(fx, owner, directHit) {
    const t = this.terrain;
    if (fx.type === 'roll') {
      this.emit({ type: 'roll', from: fx.from, to: fx.to });
      return;
    }
    if (fx.type === 'mound') {
      const region = t.raiseMound(fx.point[0], fx.point[2], fx.radius, fx.height);
      this.emit({ type: 'terrain', region });
      this.emit({ type: 'mound', pos: fx.point, radius: fx.radius });
      this.liftBuried();
      return;
    }
    if (fx.type === 'blast') {
      const [bx, by, bz] = fx.point;
      const region = t.carveCrater(bx, by, bz, fx.radius, fx.depth);
      this.emit({ type: 'explosion', pos: fx.point, radius: fx.radius });
      this.emit({ type: 'terrain', region });
      for (const p of this.players) {
        if (!p.alive) continue;
        const s = hitSphere(p);
        const dist = p === directHit ? 0 : Math.max(0, Math.hypot(s.x - bx, s.y - by, s.z - bz) - TANK.hitRadius * 0.5);
        const dmg = blastDamage(dist, fx.radius, fx.damage);
        if (dmg > 0) this.damage(p, dmg, owner);
      }
    }
  }

  damage(p, amount, from) {
    let rest = amount;
    if (p.armor > 0) {
      const soak = Math.min(p.armor, rest);
      p.armor -= soak;
      rest -= soak;
    }
    p.hp = Math.max(0, p.hp - rest);
    const attacker = from != null ? this.players[from] : null;
    if (attacker && attacker !== p) {
      attacker.money += Math.round(amount * PAY.perDamage);
      attacker.roundDamage = (attacker.roundDamage || 0) + amount;
    }
    this.emit({ type: 'damage', player: p.id, amount, hp: p.hp });
    if (p.hp <= 0 && p.alive) {
      p.alive = false;
      if (attacker && attacker !== p) attacker.money += PAY.kill;
      this.emit({ type: 'destroyed', player: p.id, by: from, pos: [p.x, p.y, p.z] });
      // The wreck cooks off: a small crater of its own.
      const region = this.terrain.carveCrater(p.x, p.y, p.z, 7, 0.4);
      this.emit({ type: 'terrain', region });
    }
  }

  liftBuried() {
    for (const p of this.players) {
      const g = this.terrain.heightAt(p.x, p.z);
      if (g > p.y) p.y = g;
    }
  }

  // Tanks drop into craters dug beneath them and take fall damage on landing.
  updateFalling(dt) {
    for (const p of this.players) {
      const g = this.terrain.heightAt(p.x, p.z);
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
          if (dmg > 0 && p.alive) {
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
