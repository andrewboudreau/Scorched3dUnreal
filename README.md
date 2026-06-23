# Scorched3D — Modern Unreal Remake

A modern, single-player-first reimagining of the classic artillery game
[Scorched3D](https://github.com/aske/scorched3d), built in **Unreal Engine** with AI-assisted
tooling (Unreal MCP).

## Status

🔬 **Research / preparation phase.** No engine code yet. We've studied the legacy codebase and
written a porting strategy.

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

## Repository layout

```
docs/        Research & design documents
.tmp/        Legacy source checkout (git-ignored, reference only)
```

The legacy source is cloned to `.tmp/scorched3d-legacy/` for reference and is **not** tracked by git.

## Next decision

Pick the terrain technology (Voxel Plugin 2 vs. runtime Landscape edit layers vs. custom procedural
mesh) — see §4 of the research doc. This gates the first prototype.
