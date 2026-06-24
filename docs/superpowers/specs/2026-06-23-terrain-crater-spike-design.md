# Phase 1 — Runtime Terrain-Crater Spike (Design)

> Status: **Approved design, pre-implementation.**
> Date: 2026-06-23
> Phase: 1 (terrain spike — de-risk the signature destructible-terrain mechanic)
> Related: [`docs/01-porting-research.md`](../../01-porting-research.md) §2.3, §4, §5

## 1. Goal & success criteria

Prove the single riskiest unknown in the project: that we can **carve a crater into the
ground at runtime and have its collision update** so objects rest on the new surface. This
de-risks the destructible-terrain feel before any gameplay is built on top.

The spike is "done / runtime craters proven" when, in PIE:

1. The ground (a `UDynamicMesh`) **visibly deforms** into a crater at a chosen point at runtime.
2. The crater has the **legacy sine-bowl shape** (clean, non-jagged rim), not a hard spherical cap.
3. **Collision is rebuilt** — a dropped physics cube settles into the crater.
4. Carving **cannot dig below the bedrock floor** (`BedrockZ`).

**Explicitly out of scope** for this spike: tanks, projectiles, weapons, the weapon-action
system, AI, turn flow, dirt settling/collapse, networking, and large-scale terrain streaming.
Perf-at-scale is deferred to a later check (noted in §7).

## 2. Decisions locked during brainstorming

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Implementation language | **C++ module now** (convert project from Blueprint-only) | Dossier mandates a C++-first core; spike code becomes the real foundation, not throwaway. |
| Terrain tech | **GeometryScript + `UDynamicMeshComponent`** runtime mesh boolean | Already resolved in research doc §4 (Mesh Terrain ruled out — editor-only). |
| Carve method | **Approach A** — boolean-subtract a **sine-profiled bowl tool mesh** | Honors both locked constraints (true mesh boolean *and* authentic legacy sine profile); proves the boolean pipeline, which is the actual unknown. |
| Spike scope | **Carve + collision (core)** | Prove the risky thing with least scaffolding. |

Approaches considered and rejected for the carve: **B** (subtract a stock sphere — defers the
sine profile, spherical-cap look is wrong) and **C** (heightfield vertex displacement — abandons
the boolean path and overhang potential; this is the documented *fallback* tech, not the spike).

## 3. Project setup (Blueprint → C++)

The project currently has no `Source/` folder. Add a primary game module:

```
Source/
  Scorched3dUnreal.Target.cs           game target
  Scorched3dUnrealEditor.Target.cs     editor target
  Scorched3dUnreal/
    Scorched3dUnreal.Build.cs          deps: Core, CoreUObject, Engine, InputCore,
                                             GeometryFramework, GeometryScriptingCore,
                                             GeometryCore, DynamicMesh
    Scorched3dUnreal.cpp / .h          IMPLEMENT_PRIMARY_GAME_MODULE
    CraterTerrainActor.h / .cpp        the spike
```

- `GeometryFramework` → `UDynamicMeshComponent`.
- `GeometryScriptingCore` → the `ApplyMeshBoolean` and mesh-generation function libraries.
- **Prerequisite:** a working C++ build toolchain (Visual Studio 2022 + Desktop C++ /
  game-dev workload, or Rider). Without it the module cannot compile. *(Confirm before
  implementation begins.)*

## 4. `ACraterTerrainActor` — the one unit

A single `AActor` owning a `UDynamicMeshComponent`. One clear responsibility: **hold a ground
mesh and carve craters into it at runtime.** Depends only on GeometryScript function libraries —
no other game systems.

- **BeginPlay:** generate a flat grid ground mesh (default ~50×50 m, configurable cell count)
  into the component's `UDynamicMesh`; enable complex-as-simple collision so the carved surface
  is collidable.
- **Public API:** `UFUNCTION(BlueprintCallable) void CarveCrater(FVector WorldCenter, float Radius)`
  — callable from BP / console / other code, keeping the unit independently testable.
- **Tunables (`UPROPERTY EditAnywhere`):** `Radius`, `DepthScale`, `BedrockZ` (floor),
  grid extent, grid resolution.

## 5. Carve algorithm (Approach A)

Inside `CarveCrater(WorldCenter, Radius)`:

1. **Build the bowl tool mesh** — a transient `UDynamicMesh`: a radial disc of rings where each
   ring at distance `d` (0 ≤ d ≤ Radius) is displaced downward by the legacy profile
   `depth(d) = sin((1 − d/Radius) · π/2) · Radius · DepthScale` — smooth, zero at the rim,
   deepest at center. Positioned at `WorldCenter`.
2. **Bedrock clamp** — clamp the tool's lowest extent to `BedrockZ`, reproducing the legacy
   `deformMap_` bedrock-floor constraint (craters can't dig below the floor).
3. **Boolean subtract** — `ApplyMeshBoolean(GroundMesh, ToolMesh, EGeometryScriptBooleanOperation::Subtract)`.
4. **Rebuild collision** — update the component's collision so the new surface is physically solid.

This is the literal reconciliation of "GeometryScript boolean" + "legacy sine profile" from the
research doc: the *shape* subtracted is the sine bowl, carved via a true mesh boolean.

Reference: legacy `common/landscapemap/DeformLandscape.cpp` (sine-smoothed radial falloff +
bedrock floor).

## 6. Test harness & verification

- **Trigger:** left-mouse-click → deproject screen→world → line-trace to terrain →
  `CarveCrater(hit.Location, Radius)`. Click-to-carve makes repeated carving and inspection easy.
- **Collision proof:** spawn a physics cube (or a few) and drop onto a fresh crater; it should
  settle into the bowl.
- **Test level:** a minimal map — terrain actor + directional light + player start (bare map,
  optionally reusing `LevelPrototyping` assets).
- **Verification (in PIE):** carve several craters, drop cubes, and confirm (a) sine-bowl
  deformation, (b) cube rests in the crater (collision rebuilt), (c) no dig below bedrock.
  Capture editor/PIE screenshots via the Unreal MCP gateway as evidence.

## 7. Follow-ups (deferred, not part of this spike)

- **Perf at scale** — carve 50–100 craters on a 256–512-equivalent map and measure rebuild
  cost; decide whether GeometryScript booleans hold up or we fall back to runtime Landscape
  edit layers (research doc §4).
- **Crater feel** — tune sine falloff knobs; optional gentle dirt settling.
- **Gameplay integration** — wire `CarveCrater` to projectile impacts in Phase 2.
