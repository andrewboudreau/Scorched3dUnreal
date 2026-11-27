// The boss match: two against one (docs/design-guide.md, "The boss: two
// against one"). The human and a CPU ally (team 0) fight the Bulwark (team 1),
// a big tank dug into a raised fort at the far end of a walled arena.
//
// Everything here is data and pure functions of the game's state, so the core
// stays deterministic: the fort is built into the ground from the round's
// pads (game.makeGround, so a rebuild makes the same one), and the boss's own
// state lives on its player (`p.boss`), so snapshots carry it.
//
// How it fights, by its health (bossPhase):
//   1  full to 60%   Scatter and Breacher, Point Defense up
//   2  60% to 25%    Gravity Orbiter up; hops between the fort's ledges;
//                    every third turn it marks whoever hurt it most and
//                    drops a Dirt Bomb on them the turn after
//   3  under 25%     fires twice a turn, and once a Thunderhead, marked a turn ahead
// The moves themselves are chosen in ai.js (bossMoves); the game carries them out.

export const BOSS = {
  name: 'Bulwark',
  team: 1,
  hp: 400,
  size: 1.5,             // drawn and hit as a tank this many times the size
  ai: 'normal',          // how well it aims (ai.DIFFICULTY)
  // Health shares where phases 2 and 3 begin.
  phases: [0.6, 0.25],
  // The weak spot: a hit from above does `mult` times the damage. "From above"
  // is an Airburst going off over it, or a shell coming down at least `steep`
  // degrees below the horizontal when it goes off.
  weak: { mult: 1.25, steep: 60 },
  // Every `dirtEvery`th turn in phase 2 it marks a Dirt Bomb; it hops every
  // `hopEvery`th turn from phase 2 on.
  dirtEvery: 3,
  hopEvery: 2,
  // Its mods, at these levels (the Point Defense refills to `charges` every turn of phase 1).
  pointdef: 1,
  orbiter: 2,
  charges: 1,
  // Ammunition. The Shell is endless anyway.
  kit: { scatter: 99, breacher: 99, dirtbomb: 9, thunderhead: 2 },
  jets: 99,
  // On top of the starting kit, for the boss's foes.
  allyKit: { breacher: 1, scatter: 1, thunderhead: 1, flak: 1, dirtbomb: 1, mound: 1 },
  allyJets: 3,
  allyArmor: 40,         // on the first round
  // The Thunderhead's Airburst for the foes: their way to hit it from above.
  allyPerks: ['thunderhead:airburst'],
  // A boss match: one round, walled.
  turns: 60,
};

// Where everyone starts, as shares of the arena's half size: the boss's fort
// at the east end, its foes side by side at the west end.
export const ARENA = {
  boss: [0.5, 0],
  foes: { x: -0.4, spread: 0.09 },
  // The fort: a flat top (`top` m over the highest ground near it, `r` m
  // across) and two ledges a little lower, one each side, a jet hop away.
  // `skirt`: m of steep slope round each, too steep to drive up.
  fort: { r: 15, top: 18, skirt: 10, reach: 45 },
  ledges: [[-6, -24], [-6, 24]],
  ledge: { r: 9, drop: 6 },
};

// The phase a boss is in at `hp` of `maxHp`: 1, 2 or 3.
export function bossPhase(hp, maxHp) {
  const share = maxHp > 0 ? hp / maxHp : 0;
  if (share < BOSS.phases[1]) return 3;
  if (share < BOSS.phases[0]) return 2;
  return 1;
}

// A shell going off at velocity `vel`: did it come from above? An Airburst
// (`aloft`) always does; otherwise it must be falling at least BOSS.weak.steep
// degrees below the horizontal.
export function fromAbove(vel, aloft = false) {
  if (aloft) return true;
  if (!vel) return false;
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  if (!(speed > 0) || !(vel[1] < 0)) return false;
  return -vel[1] / speed >= Math.sin((BOSS.weak.steep * Math.PI) / 180) - 1e-9;
}

// What a hit on `target` is multiplied by: the weak spot's bonus on a boss hit from above.
export function weakSpot(target, above) {
  return target?.boss && above ? BOSS.weak.mult : 1;
}

// The boss's own state, fresh for a round.
export function freshBossState() {
  return { phase: 1, turns: 0, phaseTurns: 0, mark: null, thunder: false, hurt: {} };
}

// Starts for a boss match ([player index, x, z], as game.placeTanks): the boss
// on its fort, everyone else side by side at the other end.
export function bossStarts(players, half) {
  const out = [];
  const foes = players.filter((p) => !p.boss);
  const n = foes.length;
  foes.forEach((p, k) => {
    const z = (k - (n - 1) / 2) * ARENA.foes.spread * 2 * half;
    out.push([p.id, ARENA.foes.x * half, z]);
  });
  for (const p of players) if (p.boss) out.push([p.id, ARENA.boss[0] * half, ARENA.boss[1] * half]);
  return out;
}

// The fort's flat tops: the middle and the two ledges, as [x, z, r].
export function fortSpots(x, z) {
  return [[x, z, ARENA.fort.r], ...ARENA.ledges.map(([dx, dz]) => [x + dx, z + dz, ARENA.ledge.r])];
}

// Build the fort into the ground round (x, z): a raised flat top over the
// highest ground near it, and two ledges. Every vertex only ever goes up (to
// the highest of the shapes over it), and the result depends only on the
// ground as generated, so a rebuild makes the same fort.
export function buildFort(t, x, z) {
  const F = ARENA.fort;
  const reg = t.regionFor(x, z, F.reach);
  let base = -Infinity;
  for (let j = reg.j0; j <= reg.j1; j++) {
    for (let i = reg.i0; i <= reg.i1; i++) {
      if (Math.hypot(t.vx(i) - x, t.vz(j) - z) <= F.reach) base = Math.max(base, t.heights[t.index(i, j)]);
    }
  }
  const top = base + F.top;
  const shapes = [[x, z, F.r, top], ...ARENA.ledges.map(([dx, dz]) => [x + dx, z + dz, ARENA.ledge.r, top - ARENA.ledge.drop])];
  const reach = F.reach + F.skirt;
  const r = t.regionFor(x, z, reach);
  for (let j = r.j0; j <= r.j1; j++) {
    for (let i = r.i0; i <= r.i1; i++) {
      const k = t.index(i, j);
      const vx = t.vx(i), vz = t.vz(j);
      let want = -Infinity;
      for (const [cx, cz, cr, h] of shapes) {
        const d = Math.hypot(vx - cx, vz - cz);
        if (d <= cr) want = Math.max(want, h);
        else if (d < cr + F.skirt) {
          const s = (d - cr) / F.skirt;           // 0 at the rim, 1 at the foot
          want = Math.max(want, h - (h - t.heights[k]) * s * s * (3 - 2 * s) * 1.0);
        }
      }
      if (want > t.heights[k]) {
        t.heights[k] = want;
        t.scorch[k] = Math.max(t.scorch[k], 0.12);   // bare earth and stone, not grass
      }
    }
  }
  return top;
}

// The match-over result of a boss match, a pure function of the players and
// the last round's result ({ team }, game.lastRoundResult). Wins and funds
// would let an ally top the table, so it is teams: `winner` is 'allies', 'boss'
// or 'draw'; `rows` has the allies first, in order of damage dealt to the boss
// (ties: alive first, then seat), then the boss. Each row is { id, name,
// color, side, damage, alive, hp }.
export function bossStandings(players, result = null) {
  const b = players.find((p) => p.boss);
  if (!b) return null;
  const dealt = (p) => b.boss.hurt?.[p.id] || 0;
  const allies = players.filter((p) => !p.boss && p.team !== BOSS.team)
    .sort((x, y) => dealt(y) - dealt(x) || Number(y.alive) - Number(x.alive) || x.id - y.id);
  const row = (p, side) => ({ id: p.id, name: p.name, color: p.color, side, damage: side === 'allies' ? Math.round(dealt(p)) : 0, alive: !!p.alive, hp: Math.max(0, Math.ceil(p.hp)) });
  let winner;
  if (result?.team === BOSS.team) winner = 'boss';
  else if (result?.team === 0) winner = 'allies';
  else winner = b.alive ? 'boss' : allies.some((p) => p.alive) ? 'allies' : 'draw';
  const title = winner === 'allies' ? 'Allies win' : winner === 'boss' ? `The ${b.name} wins` : 'Nobody wins';
  return { winner, title, boss: b, rows: [...allies.map((p) => row(p, 'allies')), row(b, 'boss')] };
}

// A boss match's config, from the Play screen or the Custom section: `name`
// (the human), the ally ({ name, ai }), and the match `conditions` (wind and
// ground: builder.matchConditions). The ground is always a meadow (the fort is
// built into it) and the edges a wall.
export function bossMatch(name, { ally = null, conditions = {}, lab = null, firing = 'volley', fog = false } = {}) {
  const hills = Math.min(conditions.hills ?? 45, 45);
  return {
    ...conditions,
    hills, world: 'meadow', edges: 'wall',
    players: [
      { name: name || 'You', ai: null },
      // The ally is a CPU unless `ally.ai` is null (a second human on this screen).
      { name: ally?.name || 'Rook', ai: ally && ally.ai === null ? null : ally?.ai || 'normal' },
      { name: BOSS.name, ai: BOSS.ai },
    ],
    boss: true,
    rounds: 1,
    maxTurnsPerRound: BOSS.turns,
    firing, fog,
    weapons: null, perks: null, modifiers: null,
    lab: { satellite: 'perk', level: 1, labels: 'some', orbiter: 'perk', orbiterLevel: 1, ...(lab || {}) },
  };
}
