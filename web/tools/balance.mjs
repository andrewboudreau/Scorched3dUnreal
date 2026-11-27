// Headless balance sims (no DOM, no three.js): what the weapons, their
// variants and the boss do in real games of the core, on the seeded dice, so
// every run of the same command prints the same numbers.
//
//   node tools/balance.mjs variants [--seeds 16] [--shots 4] [--ai normal] [--only napalm,scatter] [--pit]
//   node tools/balance.mjs flak     [--seeds 16] [--shots 4] [--pass 0,14]
//   node tools/balance.mjs boss     [--seeds 16] [--firing turns,volley] [--hp 370]
//
// variants: every weapon with variants, base and each side (and the rank 2),
//   fired by a CPU at a tank on generated meadows. Each seed is one engagement
//   of `--shots` shots at one target, the CPU walking its aim in as it does in
//   a match (ai.planShot, the same aiming dice for every weapon), and every
//   shot lands on the ground as it was before the last one. "on" is the
//   error-free solver's shot. Damage is what the target took; $/dmg is the
//   price of one shot over the mean.
// flak: Flak against the Shell and Scatter for each CPU difficulty, with the
//   CPU's Flak aim (ai.flakPass) and, for comparison, the heights in --pass
//   (0: aimed at the tank like a shell). Hit: the shot did any damage.
// boss: whole boss matches, every tank a CPU (two Normal allies against the
//   Bulwark), in each firing mode; who won and how long it took.
//   --hp overrides the boss's hit points (BOSS.hp) for the run.

import { Game } from '../src/core/game.js';
import { SIM_DT } from '../src/core/ballistics.js';
import { WEAPON_BY_ID, VARIANT_WEAPONS, resolveWeapon } from '../src/core/weapons.js';
import { planShot, solveShot, flakPass } from '../src/core/ai.js';
import { makeRng } from '../src/core/rng.js';
import { BOSS, bossMatch } from '../src/core/boss.js';

const args = process.argv.slice(2);
const mode = args[0] || 'variants';
const opt = (name, dflt) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 ? args[k + 1] : dflt;
};
const SEEDS = Number(opt('seeds', 16));
const SHOTS = Number(opt('shots', 4));
const ONLY = opt('only', null);   // variants: only these families (comma-separated ids)
const PIT = args.includes('--pit');

// --set flak.flight.0.carry=0.1,flaklet.impact.0.damage=9: try numbers
// without editing weapons.js (applied to the weapon data before anything runs).
for (const kv of String(opt('set', '')).split(',').filter(Boolean)) {
  const [path, value] = kv.split('=');
  const keys = path.split('.');
  let o = WEAPON_BY_ID[keys.shift()];
  while (keys.length > 1) o = o[keys.shift()];
  o[keys[0]] = Number(value);
}

// ---------------------------------------------------------------- a range

// A generated meadow with two tanks: 0 shoots at 1. Returns the game and a
// reset() that puts the ground and both tanks back as they were.
function range(seed) {
  const g = new Game({ players: [{ name: 'A', ai: 'normal' }, { name: 'B', ai: 'normal' }], rounds: 3, seed, resolution: 256, twists: false });
  g.start();
  g.drainEvents();
  const [a, b] = g.players;
  for (const p of g.players) { p.maxHp = p.hp = 5000; p.armor = 0; }
  if (PIT) {
    // --pit: the target sits in a crater (Napalm pools there; the Bunker Buster digs in).
    g.carve(b.x, b.y, b.z, 12, 0.6);
    for (let k = 0; k < 240; k++) g.stepWorld(SIM_DT);
    g.drainEvents();
  }
  const heights = Float64Array.from(g.terrain.heights), scorch = Float64Array.from(g.terrain.scorch);
  const keep = g.players.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  const reset = () => {
    g.terrain.heights.set(heights);
    g.terrain.scorch.set(scorch);
    g.fires = [];
    g.projectiles = [];
    g.players.forEach((p, k) => Object.assign(p, keep[k], { hp: 5000, armor: 0, alive: true, buried: false, falling: null }));
    g.drainEvents();
  };
  return { g, a, b, reset };
}

function settle(g) {
  for (let k = 0; k < 30000 && (g.projectiles.length || g.followUps.length || g.fires.length); k++) g.stepWorld(SIM_DT);
}

// Fire `id` from `a` with `aim`, as the tank's own launch does.
function shoot(g, a, b, id, aim) {
  Object.assign(a, { yaw: aim.yaw, elev: aim.elev, power: aim.power, weapon: id });
  a.inventory[id] = 99;
  const before = b.hp, mine = a.hp;
  g.launch(a);
  settle(g);
  return { dmg: before - b.hp, self: mine - a.hp };
}

const conds = (g, p) => ({ wind: g.wind, terrain: g.terrain, gravity: g.gravity, windK: g.windShare(p), drag: g.shellDrag(p) });

// One engagement per seed: SHOTS shots at the target, the CPU walking in.
// `perks` makes the variant; `pass` the Flak aim height (null: the CPU's own).
function engage(seed, id, { perks = [], difficulty = 'normal', pass = null } = {}) {
  const { g, a, b, reset } = range(seed);
  a.perks.push(...perks);
  const w = g.weaponOf(a, id);
  const memory = {};
  const out = [];
  for (let s = 0; s < SHOTS; s++) {
    reset();
    const rng = makeRng(seed * 7919 + s * 104729 + 13);
    const aim = planShot({ shooter: a, target: b, rng, difficulty, memory, ...conds(g, a), burst: g.burstHeight(a, id),
      pass: pass ?? flakPass(w, difficulty) });
    out.push(shoot(g, a, b, id, aim));
  }
  // The error-free shot.
  reset();
  const sol = solveShot({ shooter: a, target: [b.x, b.y + 1, b.z], rng: makeRng(seed), ...conds(g, a), burst: g.burstHeight(a, id), pass: pass ?? flakPass(w, difficulty) });
  const on = shoot(g, a, b, id, sol);
  return { shots: out, on, dist: Math.hypot(b.x - a.x, b.z - a.z) };
}

function stats(id, opts) {
  const all = [], on = [];
  let self = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const e = engage(seed, id, opts);
    for (const s of e.shots) { all.push(s.dmg); self += s.self; }
    on.push(e.on.dmg);
  }
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  return {
    mean, on: on.reduce((s, x) => s + x, 0) / on.length,
    hit: all.filter((x) => x > 0.5).length / all.length,
    big: all.filter((x) => x >= 30).length / all.length,
    self: self / all.length,
  };
}

const f1 = (x) => x.toFixed(1).padStart(6);
const pc = (x) => `${Math.round(x * 100)}%`.padStart(5);

if (mode === 'variants') {
  const difficulty = opt('ai', 'normal');
  console.log(`variants: ${SEEDS} seeds x ${SHOTS} shots, ${difficulty} CPU aim; dmg = mean to the target per shot`);
  console.log('weapon                          $/shot    dmg     on   hit  >=30  self  $/dmg');
  for (const w of VARIANT_WEAPONS.filter((x) => !ONLY || ONLY.split(',').includes(x.id))) {
    const rows = [[w.name, []], ...w.variants.flatMap((v) => [[`${w.name} · ${v.name}`, [`${w.id}:${v.id}`]], [`${w.name} · ${v.name} +`, [`${w.id}:${v.id}`, `${w.id}:up`]]])];
    const perShot = w.price / w.bundle;
    for (const [label, perks] of rows) {
      const r = stats(w.id, { perks, difficulty });
      console.log(`${label.padEnd(30)} ${perShot.toFixed(0).padStart(6)} ${f1(r.mean)} ${f1(r.on)} ${pc(r.hit)} ${pc(r.big)} ${f1(r.self)} ${(perShot / Math.max(0.1, r.mean)).toFixed(2).padStart(6)}`);
    }
  }
} else if (mode === 'flak') {
  const passes = String(opt('pass', '0')).split(',').map(Number);
  console.log(`flak: ${SEEDS} seeds x ${SHOTS} shots per CPU difficulty`);
  console.log('difficulty  weapon            dmg     on   hit  >=30');
  for (const difficulty of String(opt('ai', 'easy,normal,hard')).split(',')) {
    const rows = [...(args.includes('--flak-only') ? [] : [['Shell', 'shell', {}], ['Scatter', 'scatter', {}]]), ['Flak (CPU aim)', 'flak', {}],
      ...passes.map((h) => [`Flak (pass ${h} m)`, 'flak', { pass: h }])];
    for (const [label, id, o] of rows) {
      const r = stats(id, { difficulty, ...o });
      console.log(`${difficulty.padEnd(11)} ${label.padEnd(16)} ${f1(r.mean)} ${f1(r.on)} ${pc(r.hit)} ${pc(r.big)}`);
    }
  }
} else if (mode === 'boss') {
  const modes = String(opt('firing', 'turns,volley')).split(',');
  const hp = opt('hp', null);
  if (hp) BOSS.hp = Number(hp);
  console.log(`boss: ${SEEDS} all-CPU matches per firing mode (two Normal allies)${hp ? `, boss hp ${hp}` : ''}`);
  for (const firing of modes) {
    let allies = 0, boss = 0, draw = 0, turns = 0, left = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const cfg = bossMatch('Sim', { conditions: { maxWind: 1.5, hills: 45 }, firing });
      cfg.players[0].ai = 'normal';
      const g = new Game({ ...cfg, seed: seed * 101, resolution: 256 });
      g.start();
      for (let i = 0; i < 30 * 60 * 60 && g.phase !== 'matchOver'; i++) { g.update(1 / 30); g.drainEvents(); }
      const r = g.lastRoundResult || {};
      if (r.team === 0) allies++; else if (r.team === 1) boss++; else draw++;
      turns += g.turnsThisRound;
      if (r.team === 1) left += g.players[2].hp;
    }
    console.log(`${firing.padEnd(7)} allies ${allies}/${SEEDS} (${pc(allies / SEEDS)})  boss ${boss}  draw ${draw}  mean turns ${(turns / SEEDS).toFixed(1)}  boss hp left when it wins ${boss ? (left / boss).toFixed(0) : '-'}`);
  }
} else {
  console.log('modes: variants, flak, boss');
}
