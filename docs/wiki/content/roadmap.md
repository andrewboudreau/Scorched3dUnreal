# Roadmap & milestones

Can the Scorched3D subsystems be rebuilt and validated as **separate** milestones?
**Yes** — and the terrain spike (M0) already proved the method. The subsystems form a
dependency DAG joined by *narrow* interfaces, and almost every one has a numeric/logic
core you can validate **headless** plus an **in-engine** visual confirm. The coupling is
the key: because components touch only through small contracts ("seams"), any one can be
built behind a stub of its neighbors and validated alone.

Each milestone is the same cycle that worked for terrain: **prove the algorithm in
isolation (headless test) → confirm it in-engine (Simulate/PIE).**

## Dependency DAG

```
M0 Terrain ─┬─> M1 Projectile+wind ─┬─> M3 Weapon system
            │                       └─> M4 AI aiming
            └─> M2 Unit on terrain

M1 + M2 + M3 ─> M5 Turn/round loop ─> (M6 Economy folds in)

Netcode/state: replace, not port — deferred (single-player / hotseat first)
```

**Critical path:** M0 → **M1** → M3 / M4 → M5, with **M2 parallel to M1**. M1 is the
linchpin: once `SimulateShot` exists, both the weapon system and the AI feed off it —
player and AI sharing one simulator is exactly how Scorched3D does it.

## Milestones

| # | Milestone | Depends on | Seam / contract | Validated independently by | Tier |
| --- | --- | --- | --- | --- | --- |
| **M0** | [Terrain carve](#/terrain) ✅ | — | `CarveCrater(c,r)`, `DepthAt` | `CraterCarve.RealDepression` + `CraterMath` headless + Simulate | done |
| **M1** | [Projectile + wind](#/ballistics-wind) | M0 | `SimulateShot(params,wind,groundQuery)→Impact` | headless: apex/range vs angle·power, wind drift, impact vs heightfield; in-engine: arc → crater | both |
| **M2** | Unit on terrain (place + settle) | M0 | `GroundHeightAt(x,y)` + settle (`flattenArea`) | headless settle math; in-engine: unit rests, carve under it → re-settles | both |
| **M3** | [Weapon system](#/weapons) (composable) | M1 | `FireWeapon(def,origin,target)` over `IWeaponEffect` parts | headless: def → part tree + fire sequence vs mock sink; in-engine: MIRV splits, roller rolls | both |
| **M4** | [AI aiming](#/ai-aiming) (iterative) | M1 | consumes the *same* `SimulateShot` | headless: scenarios converge within tolerance + iteration budget | headless-first |
| **M5** | Turn/round loop (hotseat) | M1–M3 | player/turn state machine | headless: transitions/order/win-check with mocked players; in-engine: full 2-tank round | both |
| **M6** | Economy / shop | M3 | buy/sell + arms level | headless purchase logic (often folded into M5) | headless |
| — | [Netcode & state](#/netcode-state) | — | *replace, not port* | deferred | later |

## Acceptance criteria (per milestone)

- **M0 — Terrain carve.** *Done.* Headless: center carved to full sine depth, far terrain
  flat, nothing raised (no lid). In-engine: cubes settle into bowls. ✅
- **M1 — Projectile + wind.** Headless: trajectory apex/range track angle·power; lateral
  drift increases with wind; impact point matches a heightfield query. In-engine: fired
  arc lands and triggers `CarveCrater` at the hit. **Seam to lock first:** the pure
  `SimulateShot` so M4 can reuse it verbatim.
- **M2 — Unit on terrain.** Headless: `GroundHeightAt` + settle resolves a unit's resting
  z. In-engine: a unit rests on the surface, a carve beneath it drops it in (we already
  do this with probe cubes — formalize into a unit).
- **M3 — Weapon system.** Headless: loading a data-defined weapon instantiates the
  expected part tree; firing emits the expected ordered effect calls against a mock sink.
  In-engine: a composed weapon (e.g. MIRV → sub-explosions) produces multiple craters.
- **M4 — AI aiming.** Headless and deterministic: for a battery of (target, terrain, wind)
  scenarios the guesser lands within tolerance inside an iteration budget; difficulty is a
  function of iteration/error knobs. Minimal in-engine need.
- **M5 — Turn/round loop.** Headless: a state machine driven by mocked players makes the
  right transitions (setup → buy → aim → fire → resolve → win-check → next) in turn order.
  In-engine: a full hotseat round between two tanks completes.
- **M6 — Economy.** Headless: buy/sell respects money and arms level. Usually validated as
  part of M5's loop.

## The one caveat

The *integrative* pieces — **M5** (game loop) and HUD/UI (cross-cutting, not its own
milestone) — are validated more by mocked-integration tests + an in-engine playthrough
than by pure unit tests. They're still independent milestones with crisp acceptance
criteria; just don't expect a single `Result={Success}` line to cover them the way it does
M1/M4.

_Discuss scope or sequencing in the notes panel — questions stay flagged until answered._
