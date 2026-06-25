# Netcode & state

> **Status: seed.** Deliberately a *replace*, not a port. Single-player / hotseat first.

## Purpose

Scorched3D is built around lockstep, deterministic, fixed-point networking with a
server-authoritative state machine. We are **not** porting that — it's the highest-cost,
lowest-reuse part. This page records the legacy shape so the decision is explicit, and
tracks our Unreal-native replacement.

## Scorched3D approach

- **Determinism everywhere:** all simulation uses the fixed-point `fixed` type
  (`common/common/fixed.h`) so client and server step identically (lockstep). The terrain
  heightfield, projectile march, and AI all rely on this.
- **Server-authoritative:** the server mutates authoritative state (e.g. terrain deform
  is server-only — `DeformLandscape.cpp:140` guards client visuals under `#ifndef
  S3D_SERVER`); clients replay the same deterministic steps.
- A round/turn state machine coordinates buying, aiming, firing, and resolution across
  players.

## Our approach

_TODO._ Unreal-native replicated state (or none in single-player/hotseat for v1). No
fixed-point determinism — authoritative actor/component state replicated normally if/when
multiplayer is added. The turn/round flow becomes a `GameMode`/`GameState` +
`StateTree`/state machine.

## Side-by-side

| Concept | Scorched3D | Ours (Unreal) |
| --- | --- | --- |
| Sync model | Lockstep, deterministic fixed-point | Replicated state (or local hotseat) |
| Authority | Dedicated server replays steps | `GameMode`/`GameState` authority |
| Determinism | Required | Not required |
| Turn flow | Custom state machine | `GameMode` + StateTree (planned) |

## Status

Not started, and intentionally low priority. v1 target is single-player / hotseat, so
networking is deferred.

## Open questions

- For eventual multiplayer: standard Unreal replication, or is any determinism worth
  keeping (e.g. for deterministic terrain across clients)?
- Hotseat turn manager — `GameMode` state machine vs. `StateTree`?
