# Project Working-Notes Wiki

This is a small, local, **no-build** wiki for the Scorched3D → Unreal remake. It exists so
that the **user** (in a browser) and **Claude** (via file tools) can read the same structured
notes about the work, compare our Unreal-native architecture against the legacy Scorched3D
design, and ask/answer questions in a shared queue.

## What's here

- **[Roadmap & milestones](#/roadmap)** — how the legacy subsystems decompose into separately
  buildable + validatable milestones (the dependency DAG, seams, and per-milestone acceptance
  criteria). Start here for the plan.
- **Subsystem comparison pages** — one page per major subsystem (terrain, weapons, AI aiming,
  ballistics & wind, netcode & state), each following the same skeleton so comparisons stay
  scannable.
- **A shared notes thread** on every page (right-hand panel). You can leave a `note` or ask a
  `question`. Questions stay flagged with an **unanswered** badge until someone replies with an
  answer.

## Notes & questions

Notes are **repo-backed files in git** (`docs/wiki/notes.json`), *not* browser storage. That's the
whole point: both you and Claude read and write the same store.

- Leave a **note** to record a finding or decision.
- Ask a **question** to flag something for discussion — it shows up with an *unanswered* badge.
- **Reply** to a question to answer it (Claude can answer via file tools or `--as claude`).

## Getting started

Run the server and open the wiki:

```
python tools/wiki-serve.py
```

Then read **[How this wiki works](#/how-it-works)** for the architecture and the moving parts.
