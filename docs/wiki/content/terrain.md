# Terrain

How destructible terrain works in the original **Scorched3D** and in our **Unreal** remake — the two are deliberately different, and this page explains where and why.

> **Status: proven.** Runtime craters carve correctly and rebuild collision. See [the project history](#/how-it-works) and the side-on evidence in the repo README.

## Purpose

Destructible terrain is the signature mechanic — shells carve craters, the ground
permanently changes, and units re-settle on the new surface. Both engines model the
ground as a **heightfield** (one height per grid cell), and both carve with the *same*
sine falloff. They differ in everything around that: numeric type, how the mesh and
collision are rebuilt, and how rendering chunks are updated.

## Scorched3D approach

A deterministic, fixed-point heightfield shared by client and server for lockstep
networking.

- **`HeightMap`** (`common/landscapemap/HeightMap.h:31`) — a flat row-major array of
  `HeightData { FixedVector position; FixedVector normal; }` sized `(W+1)×(H+1)`
  (`HeightMap.cpp:51`). Only `position[2]` (z/height) is mutated by deformation; x/y are
  the integer grid coords. Heights are the deterministic **`fixed`** type (a `Sint64`,
  `FIXED_RESOLUTION = 10000`, `common/common/fixed.h:34-67`) so the simulation is
  bit-identical on every machine.
- **Lazy normals.** `setHeight` writes z and *zeroes* the normals of nearby vertices
  (out to distance 3) rather than recomputing them (`HeightMap.cpp:266-281`).
  `getNormal` detects a zeroed `(0,0,0)` normal and recomputes it on demand via
  cross-products of neighbor samples (`HeightMap.cpp:155-215`).
- **Map container.** `LandscapeMaps` → `GroundMaps` holds the live `HeightMap map_`,
  plus a **`deformMap_`** — the per-column *floor* the terrain may never be carved below
  (`common/landscapemap/GroundMaps.h:77-79`) — and a napalm/burn map. `RoofMaps` mirrors
  it for cavern ceilings.
- **The carve — `DeformLandscape`.** A static `DeformLandscapeCache` precomputes, per
  integer radius, a `(2r+1)²` table of depths using the quarter-sine falloff
  (`DeformLandscape.cpp:67-68`):
  ```
  distToRadius   = radius - dist
  explosionDepth = sin((distToRadius / radius) * PI/2) * radius
  ```
  0 at the rim, `radius` at the center. The carve loop scales each cached depth by a
  caller-supplied `depthScale`, lowers each column (clamping to `deformMap_` /
  `MinimumLandHeight` so it can't punch through the floor), and calls `setHeight`
  (`DeformLandscape.cpp:155-261`). On the client it then recomputes the affected normals
  and dirties render/scorch-texture patches; the **server only mutates the heightmap**
  (`DeformLandscape.cpp:140-152`, all client work under `#ifndef S3D_SERVER`).
- **Rendering** is a hand-rolled LOD system: `VisibilityPatchGrid` cuts the map into
  **32×32-cell patches** with neighbor-stitched mip levels, and `recalculateErrors`
  re-tessellates only the patches overlapping an explosion's box
  (`client/land/VisibilityPatchGrid.cpp:66-234`).
- **Unit interaction** samples the heightfield, not render geometry: shots test
  `position.z < getInterpHeight(x,y)` (bilinear) for ground hits
  (`common/tank/TankLib.cpp:98-99`); tanks are seated with `flattenArea`, which flattens
  local columns to the tank's z (`DeformLandscape.cpp:358-470`).

## Our approach

A `UDynamicMeshComponent` heightfield carved by displacing vertices at runtime — the
same sine profile, rebuilt the Unreal-native way.

- **`ACraterTerrainActor`** (`Source/Scorched3dUnreal/CraterTerrainActor.h`) is an
  `ADynamicMeshActor`. `RegenerateGround` builds a flat subdivided grid with
  `AppendRectangleXY` (`GridExtent` cm per side, `GridResolution` quads), then enables
  complex-as-simple collision.
- **The carve — `CarveCrater`** (`CraterTerrainActor.cpp`) is a direct port of
  `DeformLandscape`: it walks the mesh vertices and lowers each one within `Radius` by
  `CraterMath::DepthAt(dist) · DepthScale`, clamped to a `BedrockZ` floor, then
  `RecomputeNormals` + `UpdateCollision` rebuilds shading and physics.
- **`CraterMath::DepthAt`** (`Source/Scorched3dUnreal/CraterMath.cpp`) is the legacy
  falloff, unit-tested (`Scorched.CraterMath.DepthProfile`):
  `sin((radius−dist)/radius · π/2) · radius · depthScale`.
- **Single-valued by design.** Because we displace a heightfield rather than boolean-
  subtract a solid, the surface stays single-valued — a crater can never grow a "lid."
  This is verified headless: `Scorched.CraterCarve.RealDepression` runs the real carve
  and asserts center Z ≈ −287, far terrain Z = 0, and *highest* vertex Z = 0 (nothing
  raised). We pivoted to this *from* a mesh-boolean approach that kept leaving a lid — see
  [How this wiki works / project history](#/how-it-works).
- **Collision** is rebuilt after every carve (`UpdateCollision`), so dropped physics
  objects settle into the bowl — confirmed in Simulate.

## Side-by-side

| Concept | Scorched3D | Ours (Unreal) |
| --- | --- | --- |
| Surface model | Heightfield, `(W+1)²` grid | Heightfield, `UDynamicMeshComponent` grid |
| Numeric type | Fixed-point `fixed` (deterministic) | `float`/`double` (not lockstep-deterministic) |
| Carve profile | Quarter-sine falloff, cached per radius | Same sine, `CraterMath::DepthAt` (unit-tested) |
| Depth floor | `deformMap_` / `MinimumLandHeight` | `BedrockZ` clamp |
| Normals | Lazy: zeroed on edit, recomputed on read | `RecomputeNormals` after each carve |
| Collision | Heightfield sampled directly (`getInterpHeight`) | Complex-as-simple mesh collision, rebuilt per carve |
| Rendering update | `VisibilityPatchGrid` 32-cell patch re-tessellation | Unreal renders the DynamicMesh (no manual LOD yet) |
| Determinism need | Required (lockstep netcode) | Not required (single-player / hotseat first) |

## Status

- **Proven:** runtime carve (sine bowl), bedrock clamp, normal + collision rebuild,
  objects settling in. Headless tests green (`Scorched.CraterCarve`, `Scorched.CraterMath`).
- **Not yet built:** large-map performance (many craters), the "dirty region only"
  optimization (Scorched3D's patch errors → our equivalent of partial mesh/collision
  rebuild), dirt settling/collapse, projectile-driven carving (Phase 2), texture/scorch
  blending.

## Open questions

- Do we ever need Scorched3D-style **determinism** (fixed-point) for multiplayer, or is
  the Unreal-native replicated-state path enough? (Research doc leans replace.)
- At what map size does rebuilding the whole DynamicMesh + collision per carve become a
  bottleneck — and do we then port the **dirty-patch** idea (rebuild only the affected
  region) rather than the whole mesh?
- Tank settling: port `flattenArea` (flatten columns under a unit) or use Unreal physics
  to let units rest on the carved surface?

_Use the notes panel on the right to drop thoughts or ask questions on any of these — I'll answer in-thread._
