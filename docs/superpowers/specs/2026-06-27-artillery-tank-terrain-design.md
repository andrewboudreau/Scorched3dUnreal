# Artillery Tank + Bigger Textured Terrain — Design

**Date:** 2026-06-27
**Status:** approved (design); pending implementation plan
**Builds on:** the merged fly-shoot sandbox (`ACraterTerrainActor`, `ARocketProjectile`,
`ASandboxGameMode`, `AFlyCameraPawn`). This iteration adds a drivable artillery tank, a
much larger textured terrain, and a cheaper carve so the bigger terrain stays playable.

## Goal

A playable artillery scene: a placeholder tank you aim (turret yaw + barrel elevation)
with adjustable power, firing arced shells that blow real craters into a ~1 km, textured,
destructible terrain. Orbit camera; on-screen angle/power readout. All gameplay is tracked
C++; the only editor-touching piece is the ground material (a tracked, run-once generator
script — the editor MCP bridge is offline this session).

## Decisions (locked during brainstorming)

| Question | Decision |
| --- | --- |
| Terrain approach | **Keep DynamicMesh, optimize** — dirty-region carve (affected-region normals + non-hitching collision) + coarser big grid + triplanar material. No plugin. |
| Tank controls | **Classic artillery + orbit cam** — turret yaw A/D, barrel elevation W/S, power up/down, fire; HUD shows angle + power. |
| Tank mesh | **Placeholder from primitives** — box hull + cylinder turret + barrel; swappable for a Fab mesh later with no logic change. |
| Terrain size | **~1 km, feel bigger via scale** — modest extent, tuned fog/horizon, crispest craters. |
| Texturing | **Triplanar auto-material** — slope/height-driven grass/rock/sand-or-snow; self-authored, no asset dependency. |
| Default pawn | Tank **replaces** the fly-cam as the sandbox default (fly-cam stays in the codebase). |
| Shell | **Reuse `ARocketProjectile`** — tank computes muzzle transform + velocity; rocket already arcs and carves. |

## Architecture

New gameplay in tracked C++ in `Source/Scorched3dUnreal/`. Units, each independently
understandable:

### 1. Cheaper carve — optimize `ACraterTerrainActor::CarveCrater`

Today each carve (a) loops all verts lowering those in radius, (b) `RecomputeNormals` over
the **whole** mesh, (c) `UpdateCollision` full rebuild **synchronously**. At ~1 km the
whole-mesh normal recompute and the synchronous physics cook are the cost. Optimize:

- **Vertices:** keep the in-radius loop (cheap, ~sub-ms even at 100k+ verts). Track the set
  of moved vertices.
- **Normals (affected region only):** recompute normals just for the triangles touching the
  moved vertices, instead of the whole mesh. (`UE::Geometry::FMeshNormals` over the affected
  triangle/element set; exact symbol verified during planning against UE 5.8 source.)
- **Collision (non-hitching):** rebuild collision **off the game thread** (async cooking on
  the dynamic-mesh component / its body setup) so a shot doesn't hitch. Briefly-stale
  collision between impact and async-cook-complete is acceptable — the next shell lands
  seconds later; nothing drives on the terrain.
- **Honest caveat:** vertex + normal work becomes proportional to the crater, not the
  terrain; the collision *cook* still scales with total mesh but moves off the game thread
  so it stops hitching. Truly size-independent cook cost needs terrain **chunking** — noted
  as the future path, **not** in scope here. At ~1 km single-mesh this is smooth.
- **Regression guard:** existing `Scorched.CraterCarve.*` tests must stay green — the carve
  *result* (geometry) is unchanged; only normal scope and collision timing change. A test
  asserts the optimized carve produces the same depression + no-lid behavior as before.

### 2. Bigger terrain + triplanar material — `ASandboxGameMode` + `ACraterTerrainActor`

- **Size:** `TerrainExtent` ~100,000 cm (1 km) with a cell size that keeps craters crisp
  (~3 m cells ≈ 110k verts; tuned during planning to balance crater crispness vs. cost).
  "Feel bigger" via tuned `AExponentialHeightFog` (depth) + sun angle + camera distance, not
  by shrinking the tank to absurd scale.
- **Triplanar auto-material:** a world-aligned (no-UV) material blending **grass on flats →
  rock on slopes → sand/snow on peaks**, driven by world-space normal Z and height. Auto-
  colors fresh craters with no UV work. Assigned to the terrain dynamic mesh by path.
  - **Delivery:** a tracked in-editor generator `tools/make_terrain_material.py` using
    `unreal.MaterialEditingLibrary`, run once in the editor Python console — produces the
    material asset (untracked `Content/`) reproducibly from tracked code (same spirit as the
    wiki). This is the **only** editor-touching step and the most deferrable; if it slips,
    the scene still ships flat-shaded.
  - `ACraterTerrainActor` exposes a `UMaterialInterface* GroundMaterial` UPROPERTY (and/or a
    soft path it loads in `RegenerateGround`); if unset/missing, the terrain renders with the
    default material — no hard dependency.

### 3. `ATankPawn` (new) — classic artillery + orbit cam

- **Mesh hierarchy (engine primitives, swappable):**
  `Root → Hull (Cube) → Turret (Cylinder, yaws) → Barrel (Cylinder, pitches) → Muzzle
  (scene point at the barrel tip)`. A real Fab tank mesh later swaps the static meshes with
  no logic change.
- **Camera:** `USpringArmComponent` (collision-tested arm so it doesn't clip terrain) +
  `UCameraComponent`; mouse orbits, scroll zooms.
- **State (tunable, clamped):** `TurretYaw`, `BarrelElevation` (~0–85°), `Power`
  (min/max → launch speed).
- **Enhanced Input, runtime-created** (same code-only pattern as `AFlyCameraPawn`):
  **A/D** turret yaw, **W/S** barrel elevation, **power up/down** (e.g. **Shift+W/S** or
  **Q/E**), **Space** fire, **mouse** orbit camera, **scroll** zoom.
- **Aiming math seam:** a pure helper `TankAiming::MuzzleDirection(YawDeg, ElevationDeg)
  -> FVector` (unit vector in the tank's frame) — **headless-tested** (deterministic angles).
- **Fire:** compute muzzle world transform + `Velocity = MuzzleDir * Power`, spawn an
  `ARocketProjectile`, call `Launch`. Arc + crater reuse the existing rocket.

### 4. `ASandboxHUD` (new) — angle/power readout

- `class ASandboxHUD : public AHUD`, pure-C++ Canvas drawing in `DrawHUD()` (no UMG asset):
  reads the possessed `ATankPawn` and draws **Angle**, **Power** (numeric + a simple power
  bar). Clean and fully tracked.

### 5. GameMode wiring — update `ASandboxGameMode`

- `DefaultPawnClass = ATankPawn`; `HUDClass = ASandboxHUD`.
- Keep the existing terrain + sun/sky/skylight/fog spawn; widen `TerrainExtent` and tune fog.
- **Place the tank on the terrain:** after the terrain regenerates, line-trace straight down
  at the tank's spawn XY and rest the hull on the surface (replaces "lift pawn above
  terrain", which suited the fly cam).

## Wiring (tracked text/config)

- No new module dependency expected (Enhanced Input already added; `AHUD`/`Canvas` are in
  `Engine`). Confirmed during planning.
- `Config/DefaultEngine.ini`: GameMode/map already point at `ASandboxGameMode` /
  `EmptyWorld` — unchanged. The GameMode swap of default pawn + HUD is in C++.

## Testing & acceptance

- **Headless (automation tests):**
  - `Scorched.TankAiming.MuzzleDirection` — deterministic unit vectors for known yaw/
    elevation (e.g. 0°/0° → forward; 45° elevation → 45° up; yaw rotates in plane).
  - Optimized-carve regression: a test asserts the dirty-region carve still produces a real
    local depression + no lid (same behavior as the existing carve), and existing
    `Scorched.CraterCarve.*` / `Scorched.TerrainHeight.*` / `Scorched.CraterMath.*` stay green.
- **In-engine (manual acceptance):** Play → tank rests on the hills → **A/D** rotates the
  turret, **W/S** elevates the barrel, **power** adjusts → **Space/click** fires an arced
  shell that craters where it lands → HUD shows angle + power → orbit/zoom camera works →
  (if the material script was run) terrain is grass/rock/sand-or-snow textured → no per-shot
  hitch.

## Risks / non-goals

- **Crater crispness vs. size:** at 1 km, cell size bounds crater detail. ~3 m cells give
  serviceable craters; crisper needs finer cells (cost) or larger crater radius — tuned in
  the plan, not a blocker.
- **Async collision cook staleness:** collision is briefly stale after a shot until the
  async cook lands; acceptable for turn-paced artillery. If async cooking isn't available on
  `UDynamicMeshComponent` in 5.8, fall back to a coalesced deferred rebuild (verified during
  planning).
- **Material is the one editor step:** the triplanar material requires a run-once in-editor
  Python step (editor MCP bridge is offline); the scene ships without it (flat-shaded) if
  deferred.
- **Not in scope:** tank driving/physics movement, multiple tanks/turns/AI, wind, the formal
  tested `SimulateShot` seam (M1 proper), terrain chunking, real Fab tank/terrain assets,
  UMG HUD, networking.
- **Placeholder tank** is intentionally ugly primitives — visual polish (Fab mesh) is a
  later swap with no logic change.
