# Scorched3D — Modern Unreal Remake

A modern, single-player-first reimagining of the classic artillery game
[Scorched3D](https://github.com/aske/scorched3d), built in **Unreal Engine 5.8** with AI-assisted
tooling (Unreal MCP).

## Status

✅ **Phase 1 terrain spike PROVEN.** Runtime destructible craters work: a C++ `ADynamicMeshActor`
generates a thick ground slab and carves sine-profile bowl craters at runtime via GeometryScript
boolean subtract, with collision rebuilt so dropped physics objects settle into the crater. The
project is now a C++ module (was Blueprint-only). Next up is Phase 2 (core gameplay loop).

- **Strategy:** Hybrid port (extract the hard, valuable algorithms; rebuild glue/state/networking the
  Unreal way) · Modern reimagining · Single-player / hotseat first.
- Read the full analysis: **[`docs/01-porting-research.md`](docs/01-porting-research.md)**

## What we're keeping from the legacy game

| Keep (port/mine) | Replace (Unreal-native) |
|------------------|-------------------------|
| Destructible-terrain crater math (the signature feel) | OpenGL/GLSL renderer |
| The data-driven, composable weapon system *design* | Legacy UI/dialogs |
| The iterative AI aiming algorithm | Lockstep netcode / fixed-point determinism |
| Per-weapon ballistics tuning model + wind | Server-centric state machine |

## Requirements

- **Unreal Engine 5.8** (the `.uproject` pins `EngineAssociation: 5.8`)
- **Python 3** — only for the MCP browser tool (stdlib only, no packages)

Enabled engine plugins: `ModelContextProtocol`, `EditorToolset`, `ModelingToolsEditorMode`,
`GameplayStateTree`, `Terminal`.

## Repository layout

```
Scorched3dUnreal.uproject   UE 5.8 project (MCP + editor toolset plugins enabled)
Config/                     Project & engine config
Content/                    Game assets
docs/                       Research & design documents
tools/                      Dev tooling (MCP browser)
.tmp/                       Legacy source checkout (git-ignored, reference only)
```

Build/intermediate dirs (`Binaries/`, `Intermediate/`, `Saved/`, `DerivedDataCache/`) and the
legacy source under `.tmp/scorched3d-legacy/` are **not** tracked by git.

## AI tooling — Unreal MCP

The editor is driven over the Model Context Protocol. With Unreal running and the MCP plugin active,
the server listens at **`http://localhost:8000/mcp`**. It's a *gateway* — it exposes only
`list_toolsets`, `describe_toolset`, and `call_tool`, which reach the underlying editor toolsets
(actors, assets, blueprints, scene, static meshes, materials, primitives, etc.).

### MCP browser

`tools/mcp-browser-serve.py` is a local same-origin proxy + web UI that crawls the live MCP server so
you can browse every toolset and tool schema, and invoke tools directly from the page.

```bash
python tools/mcp-browser-serve.py     # then open http://localhost:8765
```

- **Disk cache** (`tools/.mcp-graph-cache.json`, git-ignored) — instant startup; the proxy serves the
  cached graph and only re-crawls on demand.
- **↻ re-crawl** forces a live re-crawl and rewrites the cache.
- **Collapsible toolset groups** with state persisted in `localStorage`, plus filter and a cache-age
  indicator.

The proxy is required because the MCP server speaks SSE only and sends no CORS headers — the browser
page talks to the proxy, which talks to the MCP server.

## Phase 1 spike result (proven)

Terrain tech is resolved and **validated in-engine**: UE 5.8 Mesh Terrain is editor-authoring only
(no runtime carve — confirmed at engine source level), so the destructible surface uses
**GeometryScript + `UDynamicMeshComponent`** runtime booleans (native, no paid dep). See §4 of the
research doc. The Phase 1 spike (`ACraterTerrainActor`) proved runtime craters end-to-end:

- A thick `AppendBox` ground slab is carved by boolean-subtracting a **sine-profile bowl** tool mesh
  (the legacy `DeformLandscape.cpp` falloff, unit-tested in `CraterMath`), clamped to a bedrock floor.
- Collision is rebuilt after each carve, so dropped physics cubes **settle into** the craters.
- **Verified by a deterministic headless test** — `Scorched.CraterCarve.RealDepression` runs the real
  GeometryScript boolean and measures the resulting mesh:

  | Measurement | Value | Meaning |
  |---|---|---|
  | center surface Z | **−189.8** | carved ~190 cm below the original slab top (Z=0) |
  | terrain Z outside crater | **0.0** | untouched — flat ground remains flat |
  | slab bottom Z | **−600.0** | floor survives → a concave **bowl**, not a punched hole |

  Run it editor-closed: `Automation RunTests Scorched.CraterCarve` → `Result={Success}`.

**Two findings that mattered:** (1) the ground must be a thick closed **slab**, not a flat plane —
subtracting a bowl from a single-sided plane punches a hole instead of a crater; (2) the cutter rim
must sit **above** the surface (a small lift), or the coplanar boolean only imprints a seam and
removes no volume — the original carve looked like "shaky circles on flat ground" until this was
fixed. (Design/build details: [`docs/superpowers/specs`](docs/superpowers/specs/) +
[`docs/superpowers/plans`](docs/superpowers/plans/).)

## Next step

**Phase 2 — core gameplay loop:** one tank, aim (turret + elevation + power), wind, fire a projectile
(`ProjectileMovementComponent` + per-weapon force model), impact → `CarveCrater`. See §5 of the
research doc.
