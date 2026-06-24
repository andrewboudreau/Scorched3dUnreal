# Scorched3D → Unreal: Porting Research Dossier

> Status: **Research / preparation phase.** No engine code written yet.
> Date: 2026-06-21
> Decisions locked: **Hybrid port** · **Modern reimagining** · **Single-player / hotseat first**

This document captures a study of the legacy Scorched3D codebase
([aske/scorched3d](https://github.com/aske/scorched3d), checked out under `.tmp/` for reference)
and a recommended strategy for rebuilding it as a modern Unreal Engine game.

---

## 1. The legacy architecture (and why it's friendly to porting)

The legacy source (`scorched/src/`) is cleanly separated into three layers:

| Layer | ~Files | Role | Port disposition |
|-------|-------:|------|------------------|
| `common/` | 794 | **Simulation & game logic** — ballistics, weapons, tanks, landscape deform, actions, networking, embedded Lua | The reuse candidate (extract algorithms) |
| `client/` | 562 | OpenGL/GLSL rendering, UI dialogs, sound, water/sky, sprites | **Discard** — Unreal replaces wholesale |
| `server/` | 167 | Dedicated server + tank AI | AI is gold; server/netcode rebuilt in Unreal |

The crucial property: **the simulation does not depend on the renderer.** Game logic lives in
`common/`, rendering in `client/`. That decoupling is what makes a surgical "lift the good algorithms,
rebuild the shell" hybrid port realistic.

Determinism note: the entire sim runs on **64-bit fixed-point math** (`common/common/fixed.h`) at a
**fixed 50 Hz timestep** (`common/engine/Simulator.cpp`). This exists for lockstep multiplayer sync.
Since we're **single-player first**, we can ignore fixed-point and use float + Unreal's tick. We only
revisit determinism if/when networked MP becomes a goal.

---

## 2. Subsystem-by-subsystem findings & port verdicts

### 2.1 Ballistics / projectile physics — **VERDICT: reimplement on Unreal, keep the *model***

- **What it does:** Custom semi-implicit Euler integrator. Per-projectile forces: gravity, wind,
  optional drag, thrust (powered rockets), and "wobble" (sinusoidal perpendicular deviation). Each
  weapon scales these via factors (`gravityFactor`, `windFactor`, `drag`, `thrustAmount`).
  - Key files: `common/engine/PhysicsParticleObject.cpp`, `common/actions/ShotProjectile.cpp`,
    `common/engine/Wind.cpp`, `common/engine/Simulator.cpp`.
- **Verdict:** Low value to port line-for-line. Unreal's `ProjectileMovementComponent` already gives
  gravity scaling, drag, bounce/restitution, and homing.
- **What to keep:** The *data model* — per-weapon `gravityFactor / windFactor / drag / wobble / thrust`
  knobs, and the global **wind** concept (a per-round world force every projectile feels). Port those
  as tunable parameters on a weapon data asset + a world "wind" actor. Wobble is a cheap, distinctive
  touch worth re-creating.

### 2.2 Weapons & economy — **VERDICT: mine the design, rebuild the system (80% design / 20% code)**

This is the legacy game's most impressive engineering. Weapons are **100% data-driven** via
`data/globalmods/none/data/accessories.xml` (~2,068 lines, 50+ weapons). There is essentially **no
hardcoded weapon behavior** — weapons are *trees of composable "weapon-action" primitives*.

- **Composition model:** An `Accessory` (name/cost/icon/arms-level) wraps a tree of `Weapon` actions.
  Primitives include: `WeaponProjectile`, `WeaponExplosion`, `WeaponNapalm`, `WeaponRoller`,
  `WeaponLaser`, `WeaponLightning`, `WeaponMirv`, `WeaponMulti`, `WeaponAimedOver/Under` (homing),
  `WeaponMoveTank`, plus flow/modifier nodes (`WeaponDelay`, `WeaponRepeat`, `WeaponScatter*`,
  `WeaponGiveAccessory/Money/Life`). ~57 types registered via a factory macro.
  - A "Digger" = projectile → aimed-under cluster → 5× sub-projectiles → down-deform explosions.
    All in data, no code. The XML weapon language is effectively a tiny scripting system.
  - Key files: `common/weapons/Accessory.h`, `Weapon.h`, `WeaponProjectile.h`, `WeaponMulti.h`,
    `AccessoryStore.cpp` (XML parser), `accessories.xml` (the data).
- **Economy:** `Economy` interface with `None`, `Store` (fixed), and `FreeMarket` (dynamic supply/demand
  pricing). Bundles, arms-level gating (progression tiers 1–10), starting/max ammo.
- **Verdict:** Don't port the C++ (it's mostly XML glue). **Do** mine `accessories.xml` as a balance/design
  reference, and **re-create the compositional weapon-action tree** as a data-driven Unreal system
  (Data Assets / a small node graph). This is the single biggest "design essence" win.

### 2.3 Landscape & destructible terrain — **VERDICT: THE signature mechanic. Port the crater math precisely.**

- **Representation:** 2.5D fixed-point **heightfield grid** (`HeightMap` / `GroundMaps`), typically
  256² or 512². One height per (x,y). Bilinear `getInterpHeight()` for lookups. A second `deformMap_`
  acts as a **bedrock floor** below which terrain can't be dug.
- **Crater algorithm (the jewel):** `common/landscapemap/DeformLandscape.cpp`. Precomputes a radial
  depth profile using a **sine-smoothed falloff** (`sin((dist/radius)·π/2)·radius`) for clean,
  non-jagged crater edges, then lowers heightfield samples within radius (clamped to the bedrock
  floor). ~30–50 lines, deterministic, fast.
- **Notable absence:** **No dirt settling/collapse** — craters are instantly stable. The classic
  "dirt falls into the hole" we remember is partly this + tanks sliding via `TargetFalling`. A modern
  remake could *add* gentle settling for better feel.
- **Procedural generation:** Multi-stage pipeline (`HeightMapModifier.cpp`): random hemispherical peaks
  → scale → noise → water erosion → smoothing → edge enhance. Config in `LandscapeDefn.h`.
- **Tank/terrain coupling:** Tanks query terrain height each tick; deformation can make them slide into
  craters (`TargetFalling`). `flattenArea()` levels a small disc for safe spawns.
- **Verdict:** Port the **sine crater profile + bedrock-floor constraint** essentially as-is — it's small
  and defines the feel. The 2.5D grid itself is an implementation detail; Unreal terrain tech is a
  **pivotal open decision** (see §4).

### 2.4 Tank AI — **VERDICT: port the aiming algorithm precisely (high value for SP).**

- **Aiming:** Not analytical. `server/tankai/TankAIAimGuesser.cpp` runs an **iterative
  refinement / guess-and-simulate** loop (≤25 iterations): fire a guess, simulate the projectile,
  measure the miss vector, adjust angle/power, repeat. Difficulty is tuned by how much error is
  injected and how fast it converges.
- **Behavior:** XML-configured AI personalities (`tankais.xml` — e.g. "Cyborg" deadly, "Shark" good).
  Weighted target selection (health / score / revenge / distance / random), weapon-set choice,
  movement triggers, defensive use of shields/batteries/parachutes.
- **Game flow:** Server state machine (`ServerState.h`): Startup → WaitingForPlayers → MatchCountdown →
  NewLevel → Buying → Playing → FinishWait → Score → (loop). Turn modes: **sequential**,
  **simultaneous**, **free-for-all**. A move = `{rotationXY, rotationYZ, power, weapon}` (`ComsPlayedMoveMessage`).
- **Verdict:** **Port the iterative aim-guesser** (adapted to Unreal's projectile sim) — 20+ years of
  player-validated "feel," and it naturally reuses whatever ballistics we build. Port difficulty params
  to a data table. **Rebuild** the state machine natively in Unreal (`AGameMode` + a turn subsystem);
  borrow the concepts (turn modes, buy phase, move struct), not the server-centric code.

---

## 3. Unreal MCP — tooling reality check (mid-2026)

"Unreal MCP" lets an AI assistant drive the editor. Current landscape:

- **Epic's official server** ships in **UE 5.8** (plugin `ModelContextProtocol`, HTTP+SSE on
  `127.0.0.1:8000`) but is **Experimental and currently broken** for external clients — it instantly
  drops connections (`Error -32000`). Watch for a 5.8.x patch.
- **Practical choice today:** community servers — **`chongdashu/unreal-mcp`** (de-facto reference, UE 5.5+,
  C++ bridge plugin + Python server on TCP 55557) or **`flopperam/unreal-engine-mcp`** (broadest toolset,
  ~50 tools). A lower-friction path uses the stock **Remote Control API** (HTTP :30010) with a pure-Python
  server (e.g. `remiphilippe/mcp-unreal` — also does headless build/cook/test).
- **What MCP does well (~30% of the work):** spawn/place/configure actors, batch asset import, build &
  save levels, create materials/instances, viewport control + **screenshots back to the model**, start/stop
  PIE, headless compile/cook/test, run arbitrary in-editor Python.
- **What still needs a human (~70%):** complex Blueprint graphs (binary `.uasset` can't be text-edited;
  recommended pattern = **write gameplay logic in C++**, expose `UFUNCTION(BlueprintCallable)`, hand-wire
  minimally), Niagara VFX, material/fracture art-direction, terrain sculpt/paint, and all game-feel tuning.
  No undo / no permission scoping → **source control is the safety net** (which is why this repo exists).

**Implication for us:** lean into a **C++-first gameplay core** (which also happens to be exactly where the
ported algorithms live), and use MCP for scaffolding/iteration rather than authoring visual scripts.

---

## 4. The one pivotal open decision: terrain technology

Everything about the destructible-terrain feel hinges on this. The **runtime crater** (carving the
ground mid-match) is the non-negotiable requirement — any candidate must support it.

| Option | Digging style | Runtime crater? | Pros | Cons |
|--------|---------------|-----------------|------|------|
| **UE 5.8 Mesh Terrain** | True 3D mesh (caves, overhangs, tunnels) | ❌ **No** (source-confirmed) | First-party; richest authored maps; PCG + World Partition native | Editor-authoring-only; bakes to cooked sections; no runtime carve API |
| **GeometryScript + DynamicMesh** | 3D mesh booleans (overhangs possible) | ✅ Yes | First-party, no paid dep; runtime `ApplyMeshBoolean`; MeshPartition depends on it | Per-actor meshes; large-scale streaming is DIY |
| **Voxel Plugin 2** | True volumetric (caves, overhangs, tunnels) | ✅ Yes | Proven runtime digging — closest to "scorched earth" tunnelers | Paid plugin; heavier; integration work |
| **Runtime Landscape edit layers** (UE 5.7+) / Errant Landscape | Heightfield craters | ✅ Yes | Native-ish, simple, good perf, matches the legacy 2.5D model exactly | No overhangs/caves — a digger can't tunnel under a tank |
| **Custom runtime procedural mesh** | Heightfield (or limited voxel) | ✅ Yes | Full control; port the legacy crater math 1:1 | Most engineering; reinventing terrain tooling |

### Tech-spike findings — UE 5.8 Mesh Terrain (2026-06-22)

UE 5.8 is released and ships **Mesh Terrain** (Experimental): a genuine **3D-mesh** terrain (not a
heightfield, not voxel/SDF) supporting overhangs, caves, tunnels, floating islands; variable resolution;
**non-destructive stackable modifiers**; World Partition + PCG native. A far better *authoring* system
than classic Landscape.

**CONCLUSION: Mesh Terrain does NOT support runtime deformation — confirmed at the engine source level**
(inspected `D:/Games/EpicGames/UE_5.8/Engine` plugin headers, not just docs):

- The terrain UX is the **`MeshTerrainMode`** plugin — a single module of `"Type": "Editor"`. Pure
  authoring; it has no runtime module at all.
- The underlying tech is the **`MeshPartition`** plugin ("MegaMesh"). It has runtime modules, but the
  pipeline is **author modifiers → compile → bake**: output is **`ACompiledSection`** actors with
  **cooked** collision, streamed at runtime via World Partition.
- Every compile/build entry point (`GetCompiledSectionBuildVariantNamesForPlatforms`,
  `GatherDependencies`, rebuild-on-property-change) is gated `#if WITH_EDITOR`. The runtime
  `UMeshPartitionComponent` exposes only lifecycle hooks (`PostRegisterMegaMeshComponents`,
  `OnDefinitionChanged`) — **no `ApplyModifier` / `Carve` / `Deform` / geometry-`Rebuild` at runtime.**
  The only runtime `Rebuild*` calls live in the collision component and rebuild physics from
  already-built mesh (also editor-only-data gated).

So Mesh Terrain is an **editor/cook-time authoring system**, not runtime-destructible. Excellent for
rich *static* maps (cliffs, caves, overhangs); **cannot carve craters during gameplay**. **Ruled out as
the destructible-surface tech** — still attractive as an authored static backdrop.

### Resolved direction for the destructible surface

The runtime crater must come from a genuinely runtime-mutable representation. Native-first options:

1. **GeometryScript + `UDynamicMeshComponent`** (first-party; `GeometryScripting` plugin — which
   MeshPartition itself depends on). `UDynamicMesh` supports **runtime mesh boolean** ops
   (`ApplyMeshBoolean` subtract) → carve a volume = crater, with overhang/cave potential.
   BlueprintCallable, runs at runtime. **Recommended primary path for the spike.**
2. **Voxel Plugin 2** (paid) — proven runtime volumetric digging/tunneling; richest destruction.
3. **Runtime Landscape edit layers** (UE 5.7+) — heightfield craters only (no overhangs), simplest and
   closest to the legacy 2.5D model; port the legacy sine crater profile directly onto it.

**Phase-1 spike (now hands-on):** prototype runtime craters with **GeometryScript/DynamicMesh** first
(native, no paid dep, supports overhangs). Fall back to runtime Landscape layers if perf/scale demands a
heightfield. Use Mesh Terrain only for non-destructible authored scenery, if at all.

### Phase-1 spike result — PROVEN (2026-06-24)

The spike (`ACraterTerrainActor`, a C++ `ADynamicMeshActor`) confirmed the GeometryScript/DynamicMesh
path works end-to-end, verified live in PIE via the Unreal MCP gateway:

- The legacy **sine crater profile** (`DeformLandscape.cpp:67-68`,
  `sin((radius-dist)/radius·π/2)·radius·depthScale`) was ported as `CraterMath::DepthAt` and **unit-tested**.
- A watertight **bowl tool mesh** built from that profile (reviewed: positive signed volume, 0 edge
  conflicts) is **boolean-subtracted** (`ApplyMeshBoolean` Subtract) from the ground, clamped to a
  bedrock floor. Collision is rebuilt after each carve; dropped physics cubes **settle into** the craters.
- **Key finding:** the ground must be a thick closed **slab** (`AppendBox`, thickness > max crater
  depth), not a single-sided plane — subtracting a bowl from a plane punches a hole rather than carving
  a concave crater. This is the one non-obvious lesson the spike surfaced.

Conclusion: **GeometryScript + DynamicMesh runtime booleans are the confirmed destructible-surface
tech.** Deferred for later: perf-at-scale (many craters on a large map), dirt settling, projectile
integration (Phase 2).

---

## 5. Recommended roadmap (single-player first)

A staged plan that front-loads the riskiest, most distinctive mechanic.

- **Phase 0 — Project setup**
  - Create the UE project (target **UE 5.5+**; 5.8 once MCP stabilizes). C++ project, not Blueprint-only.
  - Wire up an MCP server (`chongdashu/unreal-mcp` or Remote Control path) for AI-assisted scaffolding.
  - Commit the `.gitignore` already prepared here.
- **Phase 1 — Terrain spike (de-risk first)** — *the highest-risk unknown; do it first*
  - Mesh Terrain is **ruled out** for destruction (§4, source-confirmed editor-only). Primary spike:
    runtime craters via **GeometryScript + `UDynamicMeshComponent`** (`ApplyMeshBoolean` subtract),
    porting the **sine crater profile + bedrock floor** from `DeformLandscape.cpp`. Add optional settling.
  - Fallback if perf/scale demands: **runtime Landscape edit layers** (heightfield) or **Voxel Plugin 2**.
  - Validate: crater on impact, collision updates, tank re-settles on new surface, perf at target map size.
  - Pick the terrain tech based on spike results before building gameplay on top.
- **Phase 2 — Core gameplay loop**
  - One tank, aim (turret XY + elevation YZ + power), wind, fire a single projectile using Unreal
    `ProjectileMovementComponent` + per-weapon force model (§2.1). Impact → crater (Phase 1).
  - Tank sits on / slides into terrain.
- **Phase 3 — Turn system & hotseat**
  - Rebuild the state machine in `AGameMode` + a turn subsystem (sequential first). Multiple tanks,
    win/lose, round → score → next round.
- **Phase 4 — Weapons system**
  - Build the data-driven compositional weapon-action system (§2.2). Seed it by mining `accessories.xml`
    for an initial weapon set (explosion, MIRV, roller, napalm, digger).
- **Phase 5 — AI opponents**
  - Port the iterative **aim-guesser** (§2.4) + difficulty data table. Target selection, weapon choice.
- **Phase 6 — Economy & shop**
  - Money, buy phase between rounds, arms-level progression. Start with fixed pricing.
- **Later — Polish & (optional) multiplayer**
  - VFX/Niagara, audio, UI. Revisit determinism only if networked MP is pursued.

---

## 6. Quick reference — legacy files worth keeping open

| Concern | Legacy file(s) |
|--------|----------------|
| Crater / terrain deform | `common/landscapemap/DeformLandscape.cpp`, `HeightMap.cpp`, `GroundMaps.cpp` |
| Terrain generation | `common/landscapemap/HeightMapModifier.cpp`, `common/landscapedef/LandscapeDefn.h` |
| Projectile forces | `common/engine/PhysicsParticleObject.cpp`, `common/actions/ShotProjectile.cpp`, `common/engine/Wind.cpp` |
| Weapon model + data | `common/weapons/*.h`, `data/globalmods/none/data/accessories.xml` |
| AI aiming | `server/tankai/TankAIAimGuesser.cpp`, `TankAICurrentMove.cpp`, `data/.../tankais.xml` |
| Turn / game flow | `server/server/ServerState*.h`, `common/simactions/*.h`, `common/coms/ComsPlayedMoveMessage.h` |

> All paths are under `.tmp/scorched3d-legacy/scorched/` (git-ignored; reference only).
