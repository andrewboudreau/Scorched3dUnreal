# Terrain

How destructible ground works in the original **Scorched3D** and in our **Unreal** remake.

> **Status: proven.** Runtime craters carve correctly and rebuild collision. See
> [the project history](#/how-it-works) and the side-on evidence in the repo README.

## In plain terms

Neither game treats the ground as a solid 3D blob. Both model it as a **heightfield** — a
grid of height samples, like a field of vertical poles each pushed up to the ground's
height at that spot. A shell landing simply **pushes the nearby poles down** into a smooth
bowl; the surrounding ground is untouched.

The shape of that bowl is the *same* in both engines: a quarter-**sine** falloff — deepest
at the center, fading to nothing at the rim. We ported that math verbatim. Everything that
differs is the *machinery around the grid*: the number format, how the mesh and collision
get rebuilt, and how the screen is redrawn.

Because a heightfield stores **one height per cell**, a column can't fold back over
itself — so a crater can never grow a "lid." That single-valued property is exactly why we
switched to it (an earlier mesh-boolean attempt kept leaving lids; see
[project history](#/how-it-works)).

## The components at a glance

**Scorched3D** (legacy C++ — paths relative to `scorched/src/`):

| Class | Role | Where |
| --- | --- | --- |
| `HeightMap` | The grid of heights + per-vertex normals | `common/landscapemap/HeightMap.h:31` |
| `LandscapeMaps` | Top container (ground + roof + definition) | `common/landscapemap/LandscapeMaps.h:29` |
| `GroundMaps` | Playfield: live map + deform floor + napalm | `common/landscapemap/GroundMaps.h:32` |
| `RoofMaps` | Cavern ceilings (a mirror of the ground) | `common/landscapemap/` |
| `DeformLandscape` | **The carve** — sine falloff + floor clamp | `common/landscapemap/DeformLandscape.cpp:113` |
| `DeformLandscapeCache` | Per-radius precomputed depth tables | `DeformLandscape.cpp:44` |
| `VisibilityPatchGrid` | Render LOD: 32×32 patches, dirty regions | `client/land/VisibilityPatchGrid.cpp:37` |
| `fixed` | Deterministic fixed-point number type | `common/common/fixed.h:34` |
| `TankLib` / `MovementMap` | Unit height sampling + settling | `common/tank/TankLib.cpp`, `MovementMap.cpp` |

**Ours** (Unreal C++ — paths relative to `Source/Scorched3dUnreal/`):

| Class / member | Role | Where |
| --- | --- | --- |
| `ACraterTerrainActor` | The ground actor (a heightfield) | `CraterTerrainActor.h` |
| `UDynamicMeshComponent` | Runtime-editable mesh (UE built-in) | engine / `GeometryFramework` |
| `RegenerateGround()` | Builds the grid (`AppendRectangleXY`) | `CraterTerrainActor.cpp` |
| `CarveCrater()` | **The carve** — displaces vertices down | `CraterTerrainActor.cpp` |
| `CraterMath::DepthAt()` | The sine falloff (unit-tested) | `CraterMath.cpp` |
| `Scorched.CraterCarve` / `CraterMath` | Headless validation tests | `Tests/` |

## How a carve flows

**Scorched3D:** explosion → `DeformLandscape::deformLandscape` → look up the cached sine
depths for that radius → lower each column (clamped to the `deformMap_` floor) via
`HeightMap::setHeight`, which also invalidates nearby normals → on the client only, dirty
the affected render patches + paint a scorch decal. The **server only mutates heights**.

**Ours:** `CarveCrater(center, radius)` → walk the mesh vertices → lower each one within
the radius by `CraterMath::DepthAt(dist) · DepthScale` (clamped to `BedrockZ`) → recompute
normals → rebuild collision. One path, client-authoritative (single-player first).

## What aligns — and what doesn't

Legend: ✅ same idea, cleanly ported · ⚠️ same goal, different mechanism · ❌ deliberately
diverges or not built.

| Concept | Scorched3D | Ours | Aligns? |
| --- | --- | --- | --- |
| Surface model | `HeightMap` grid | `UDynamicMeshComponent` grid | ✅ both heightfields |
| Carve profile | `DeformLandscapeCache` (cached sine) | `CraterMath::DepthAt` (same sine) | ✅ identical math, ported |
| Depth floor | `deformMap_` / `MinimumLandHeight` | `BedrockZ` clamp | ✅ same concept |
| Single-valued surface | yes (no overhangs) | yes (no overhangs) | ✅ same constraint |
| Normals | Lazy: invalidate on edit, recompute on read | Eager: `RecomputeNormals` per carve | ⚠️ different strategy, same result |
| Collision | Sample the heightfield directly (`getInterpHeight`) | Mesh complex-as-simple, rebuilt per carve | ⚠️ different mechanism |
| Unit settling | `DeformLandscape::flattenArea` flattens columns | Physics rest (probe cubes today) / TODO | ⚠️ partial — see M2 |
| Numeric type | Fixed-point `fixed` (lockstep-deterministic) | `float` / `double` | ❌ diverges — we don't need lockstep |
| Rendering / LOD | `VisibilityPatchGrid` (hand-rolled patches) | Unreal renderer (Nanite / auto-LOD) | ❌ replaced entirely |
| Dirty-region update | Only affected 32-cell patches re-tessellate | Whole-mesh + collision rebuild (for now) | ❌ not yet — future perf work |
| Caverns / roof | `RoofMaps` (a second heightfield above) | none | ❌ out of scope (single surface) |
| Scorch / texture blend | `DeformTextures` decal on carve | none yet | ❌ not built |

The green rows are the valuable, portable core — the *algorithm*. The red rows are mostly
things Unreal already gives us for free (rendering, LOD) or things we intentionally dropped
(determinism, caverns). The amber rows are where a faithful port still has a real decision
to make.

## Status

- **Proven:** runtime sine-bowl carve, bedrock clamp, normal + collision rebuild, objects
  settling in. Headless tests green (`Scorched.CraterCarve`, `Scorched.CraterMath`).
- **Not yet built:** large-map performance, the **dirty-region** carve (rebuild only the
  affected area, like Scorched3D's patch errors), unit settling as a real unit, projectile-
  driven carving (Phase 2 / [M1](#/roadmap)), scorch/texture blending.

## Open questions

- Do we ever need Scorched3D-style **determinism** (fixed-point) for multiplayer, or is the
  Unreal-native replicated-state path enough? (Leaning replace — see [Netcode](#/netcode-state).)
- At what map size does the **whole-mesh rebuild** per carve become the bottleneck — and is
  that when we port the dirty-patch idea?
- Unit settling: port `flattenArea`, or let Unreal physics rest units on the carved surface?

_Use the notes panel on the right to weigh in or ask a question — I'll answer in-thread._
