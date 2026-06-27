# Fly-and-Shoot Sandbox — Design

**Date:** 2026-06-27
**Status:** approved (design); pending implementation plan
**Scope tier:** "fun sandbox first" — feel over rigor. Becomes the in-engine confirmation
for roadmap **M1 (projectile + wind)** later, but does not yet formalize the tested
`SimulateShot` seam.

## Goal

A single great sandbox scene: free-fly around a large procedurally-hilly terrain and
left-click to lob rockets that arc under gravity and blow real sine-bowl craters into the
ground. Everything reproducible from tracked C++ ("clone, open, hit Play, fly").

## Decisions (locked during brainstorming)

| Question | Decision |
| --- | --- |
| Rigor | Fun sandbox first (simple gravity arcs; no formal tested SimulateShot yet) |
| Terrain shape | Procedural rolling hills (layered Perlin noise) |
| Controls | Free-fly camera pawn + click-to-fire |
| Scenes | One great scene this round |
| Scene assembly | **Code-driven** — GameMode spawns terrain + lighting; launch from any map |
| Input system | Enhanced Input, created at runtime in C++ (no binary input assets) |

## Architecture

All new gameplay lives in tracked C++ in `Source/Scorched3dUnreal/`. The `.umap` is an
empty stage; the GameMode builds the world. Five units, each independently understandable:

### 1. Terrain hills — extend `ACraterTerrainActor` + new `TerrainHeight`

- **`TerrainHeight` (new pure helper, own .h/.cpp)** — `HeightAt(X, Y, Params) -> double`
  using layered Perlin noise (octaves with per-octave frequency/amplitude falloff,
  seeded by an offset). Pure and deterministic → unit-testable like `CraterMath`.
- **`ACraterTerrainActor`** — in `RegenerateGround()`, after building the flat grid,
  displace each vertex `Z += TerrainHeight::HeightAt(localX, localY, params)`.
- New `UPROPERTY`s:
  - `HillAmplitude` (float, **default 0.0** → flat) — peak hill height in cm.
  - `HillFrequency` (float) — base spatial frequency (smaller = broader hills).
  - `HillOctaves` (int32, default 4) — number of noise layers.
  - `HillSeed` (int32) — offset so different seeds give different terrain.
- **Carve interaction:** `CarveCrater` already lowers from the current vertex Z and clamps
  to `BedrockZ`, so it carves into hills with no change. Re-running `RegenerateGround`
  rebuilds the hills (resetting prior carves) — expected.
- **Default amplitude 0** preserves the existing M0 test `Scorched.CraterCarve.RealDepression`
  (which asserts flat far-terrain and no lid). The sandbox actor sets amplitude > 0.

### 2. `AFlyCameraPawn` (new)

- Components: `UFloatingPawnMovement` (gravity off), `UCameraComponent` (root or on a
  small scene root), spherical collision optional/none for free flight.
- **Enhanced Input, runtime-created** (no `.uasset`): in `BeginPlay`/`PossessedBy`,
  `NewObject` a `UInputMappingContext` and `UInputAction`s, `MapKey` each, and add the
  context to the local player's `UEnhancedInputLocalPlayerSubsystem`.
  - `Move` (Axis2D): W/S forward, A/D right.
  - `Look` (Axis2D): mouse X/Y.
  - `Vertical` (Axis1D): E up, Q down.
  - `Speed` (Axis1D): mouse wheel adjusts `MaxSpeed`.
  - `Fire` (Digital): left mouse button → fire a rocket.
- Tunables: `MoveSpeed`/`MaxSpeed`, `LookSensitivity`, min/max speed clamp.

### 3. `ARocketProjectile` (new)

- Components: `USphereComponent` (collision, query+physics, generates hit events),
  `UStaticMeshComponent` (`/Engine/BasicShapes/Sphere`), `UProjectileMovementComponent`
  (`ProjectileGravityScale = 1`, `bRotationFollowsVelocity = true`), optional trail.
- Fired by the pawn: spawned at the camera location with
  `Velocity = CameraForward * LaunchSpeed`; gravity produces the arc.
- **On hit** (`OnComponentHit`): resolve the target `ACraterTerrainActor` (the hit actor,
  else nearest via `GetAllActorsOfClass`), call `CarveCrater(Hit.ImpactPoint, CraterRadius)`,
  spawn a lightweight explosion (radial impulse on nearby physics bodies + a transient
  flash/scorch decal + impact sound), then `Destroy()`.
- Tunables: `LaunchSpeed`, `CraterRadius`, `ExplosionRadius`, lifespan fail-safe.

### 4. `ASandboxGameMode` (new)

- `DefaultPawnClass = AFlyCameraPawn`.
- `BeginPlay` (or `InitGame`/`StartPlay`): build the stage idempotently —
  - Spawn one `ACraterTerrainActor` (large `GridExtent`, higher `GridResolution`,
    `HillAmplitude` > 0) if none exists in the world.
  - Ensure a `ADirectionalLight` (sun), `ASkyAtmosphere`, `ASkyLight`, and
    `AExponentialHeightFog` exist; spawn any that are missing so an empty map still looks
    decent. Set a sensible sun angle.
  - Position the player pawn above the terrain looking toward its center.

### 5. Firing flow

`AFlyCameraPawn::Fire` → spawn `ARocketProjectile` at the camera with forward velocity →
`UProjectileMovementComponent` arcs it under gravity → `OnComponentHit` →
`ACraterTerrainActor::CarveCrater` + explosion FX → rocket destroyed.

## Wiring (tracked text/config)

- `Scorched3dUnreal.Build.cs`: add `"EnhancedInput"` to dependency modules.
- `Config/DefaultEngine.ini`: set `GlobalDefaultGameMode` to the sandbox GameMode and the
  default/startup map to `EmptyWorld`, so **Play** drops straight into the sandbox.
  - Caveat: `EmptyWorld.umap` lives in the untracked `Content/`. The *behavior* is all
    tracked C++ — the reproducible part. (Known "Content is local for now" tradeoff;
    revisit with Git LFS later.)
  - This replaces the Third Person template as the default Play target (intended).

## Testing & acceptance

- **Headless (automation tests, `Source/Scorched3dUnreal/Tests/`):**
  - `TerrainHeight` test: deterministic for a fixed seed; produces varied heights across
    the grid; stays within `[-HillAmplitude, +HillAmplitude]` bounds (or documented range).
  - Carve-into-hills test: with `HillAmplitude` > 0, a carve still produces a real local
    depression below the surrounding surface and raises nothing (no lid).
  - Existing M0 tests (`CraterCarve`, `CraterMath`) remain green (default flat).
- **In-engine (manual acceptance):** hit Play → fly with WASD + mouse over the hills →
  scroll changes speed → left-click lobs a rocket that arcs and blows a crater.

## Risks / non-goals

- **Carve cost:** `CarveCrater` iterates all vertices each shot — O(verts). A ~256² grid
  (~65k verts) is fine for a sandbox; dirty-region optimization stays a roadmap item, not
  in scope here.
- **FX simplicity:** explosion kept minimal (engine shapes + procedural flash/decal/sound)
  to avoid Content dependencies; a Niagara polish pass is a later, optional follow-up.
- **Not in scope:** wind, the formal tested `SimulateShot` seam (M1 proper), multiple
  scenes/presets, units/tanks, UI/HUD, networking.
- **Enhanced Input runtime creation** is a standard, low-risk pattern but unusual vs.
  asset-based setup; documented here so it isn't mistaken for a missing-asset bug.
