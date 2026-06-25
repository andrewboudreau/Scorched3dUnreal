# Ballistics & wind

> **Status: seed.** Phase 2 core-loop work; intent captured from the research doc.

## Purpose

The feel of Scorched3D comes from simple, tunable projectile physics plus **wind** that
pushes shots sideways. We keep the per-weapon ballistics/tuning model and wind, and
re-home them on Unreal's projectile movement.

## Scorched3D approach

- Shots are simulated as particles under gravity + wind, marched until they intersect the
  heightfield (`position.z < getInterpHeight(x,y)`, `common/tank/TankLib.cpp:98-99`).
- Helpers for converting an aim (angle/power) to a velocity vector and predicting
  intersection live in `common/tank/TankLib.cpp` (`getShotTowardsPosition`,
  `getVelocityVector`, `intersection`). Wind is a global per-round force applied to the
  shot.
- Everything runs in deterministic `fixed` math for lockstep.

## Our approach

_TODO (Phase 2)._ A `ProjectileMovementComponent` (or a small custom integrator) per
shell, with a per-weapon force/drag/gravity tuning struct and a per-round wind vector.
Impact → `ACraterTerrainActor::CarveCrater` at the hit point — the link from this page to
[Terrain](#/terrain).

## Side-by-side

| Concept | Scorched3D | Ours (Unreal) |
| --- | --- | --- |
| Integrator | Fixed-point particle march | _TBD — ProjectileMovementComponent_ |
| Ground hit test | `getInterpHeight` vs. shot z | Mesh/heightfield collision → `CarveCrater` |
| Wind | Global per-round force | _TBD — per-round wind vector_ |
| Tuning | Per-weapon parameters | _TBD — per-weapon data struct_ |

## Status

Not started. This is the spine of the Phase 2 loop: aim → fire → wind → impact → carve.

## Open questions

- `ProjectileMovementComponent` vs. a custom fixed-step integrator (more control over
  wind/tuning, easier to share with the AI guesser)?
- Where do per-weapon ballistic params live — alongside the [weapon](#/weapons)
  definition?
