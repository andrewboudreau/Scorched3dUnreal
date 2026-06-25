# AI aiming

> **Status: seed.** Legacy algorithm located and understood; not yet ported.

## Purpose

The CPU opponents' aiming is an **iterative numeric solver**, not a closed-form ballistic
equation — it fires a trial shot, measures the miss, and refines. That approach is robust
to wind and odd terrain and is worth porting closely.

## Scorched3D approach

- Lives in **`server/tankai/TankAIAimGuesser.cpp`**. `guess()` (`:40-85`) fires a
  randomized `initialShot` (`:87-107`), then loops ~25 times: simulate the shot with a
  `PhysicsParticleObject` until it collides (`getCurrentGuess`, `:158-184`), measure miss
  distance, and `refineShot` (`:109-140`) — which nudges the velocity vector by the miss
  delta and rescales power logarithmically. Succeeds when the landing is within the target
  distance (`:65-70`).
- Strategy/targeting siblings live alongside (`TankAICurrent*.cpp`,
  `TankAISniperGuesser.cpp`, `TankAIWeaponSets.cpp`). Low-level ballistic helpers
  (`getShotTowardsPosition`, `getVelocityVector`, `intersection`) are in
  `common/tank/TankLib.cpp`.

## Our approach

_TODO (Phase 2+)._ Port the predict→measure→refine loop, simulating trial shots with the
same projectile model we use for real shells (so AI and player physics agree). Difficulty
tiers can come from iteration count + injected error.

## Side-by-side

| Concept | Scorched3D | Ours (Unreal) |
| --- | --- | --- |
| Method | Iterative guess-and-refine (~25 iters) | _TBD — same loop_ |
| Shot simulation | `PhysicsParticleObject` march | _TBD — shared projectile model_ |
| Refinement | Velocity delta + log power rescale | _TBD_ |
| Difficulty | Iteration budget / error | _TBD_ |

## Status

Not started. Algorithm mapped; depends on the Phase 2 projectile/ballistics model.

## Open questions

- Reuse the live projectile (`ProjectileMovementComponent`) for AI trial shots, or a
  cheap analytic predictor for speed?
- Where does wind enter the refinement — same as the legacy delta nudge?
