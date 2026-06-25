# Design — Project Working-Notes Wiki (terrain-first subsystem comparison)

**Date:** 2026-06-24
**Status:** Approved (brainstorming)
**Author:** andrewboudreau + Claude

## Purpose

A small, local, no-build HTML "wiki" for this project that lets the user and Claude
**communicate about the work**: read structured comparisons of our Unreal-native
architecture vs the legacy Scorched3D design, keep working notes, and ask/answer
questions. v1 is seeded with a full **terrain** subsystem comparison and skeletons for
the other major subsystems.

The defining constraint: it is *for us* — both the user (in the browser) and Claude (via
file tools) must read and write the same notes. Therefore notes are **repo-backed files
in git**, not browser `localStorage`.

## Approach (chosen)

- **Repo-backed + served.** A stdlib-only `tools/wiki-serve.py` serves a static
  front-end from `docs/wiki/` and exposes a tiny JSON API to read/append notes. Mirrors
  the existing `tools/mcp-browser-serve.py` pattern (Python 3, stdlib only, no pip).
- **Markdown content** authored in the repo; rendered client-side with a single vendored
  file (`marked.min.js`). No framework, no build step.
- **Multiple subsystems** in v1: terrain fully written; weapons, AI aiming,
  ballistics+wind, and netcode/state shipped as honest seeded skeletons.
- **Clean & functional** look: readable typography, left nav, side-by-side comparison
  tables, collapsible notes thread.

## File layout

```
tools/wiki-serve.py            # stdlib HTTP: static files + /api/notes (GET/POST)
docs/wiki/
  index.html                   # shell: left nav · content pane · notes panel
  assets/app.js                # router, markdown fetch+render, notes UI
  assets/style.css             # styling
  assets/marked.min.js         # vendored single-file markdown renderer
  nav.json                     # [{slug,title,group}] → drives left nav + order
  notes.json                   # working notes/questions store (git-tracked)
  content/
    home.md                    # overview + how to use the wiki
    how-it-works.md            # how the wiki works (README links here)
    terrain.md                 # FULL terrain comparison (ours vs Scorched3D)
    weapons.md                 # seeded skeleton
    ai-aiming.md               # seeded skeleton
    ballistics-wind.md         # seeded skeleton
    netcode-state.md           # seeded skeleton
```

## Components & responsibilities

- **`tools/wiki-serve.py`** — single-purpose local server.
  - Serves `docs/wiki/` static assets and `content/*.md`.
  - `GET /api/notes?topic=<slug>` → notes for that topic plus `general` (JSON).
  - `POST /api/notes` body `{topic,type,author,text,parentId?}` → validates, assigns
    `id` (uuid4) + `createdAt` (ISO-8601), appends to `notes.json`, returns the entry.
  - Read-modify-write `notes.json` under a process lock (single local user → sufficient).
  - CLI: `--port` (default e.g. 8777), `--as <author>` default `you` (Claude/scripts can
    pass `--as claude`). Refuses to write outside `docs/wiki/notes.json`.
  - No external packages; `http.server` + `json` + `uuid` + `datetime`.

- **Front-end (`index.html` + `app.js` + `style.css`)**
  - On load: fetch `nav.json` → render grouped left nav.
  - Select page → fetch `content/<slug>.md` → `marked` → render into content pane;
    update `location.hash` for shareable links; back/forward supported.
  - Notes panel bound to the current topic: `GET /api/notes?topic=<slug>` renders the
    thread; an "add note / ask question" form `POST`s and optimistically appends.
  - A `question` with no child `answer` shows an **"unanswered"** badge (shared queue).

## Notes data model (`notes.json`)

Append-only JSON array. Each entry:

```json
{
  "id": "uuid4",
  "topic": "terrain",          // page slug, or "general"
  "type": "note|question|answer",
  "author": "you|claude",
  "parentId": "uuid4|null",     // set on answers, references the question
  "text": "markdown string",
  "createdAt": "2026-06-24T18:30:00Z"
}
```

- The server assigns `id` and `createdAt`; the client supplies the rest.
- Claude answers questions by adding `type:answer, author:claude, parentId:<question id>`
  entries — via file tools or `wiki-serve.py --as claude` — so the queue is shared.
- v1 is append-only: no edit/delete in the UI. Remove an entry by editing the JSON.

## Page convention (every subsystem `.md`)

Same skeleton so comparisons stay scannable:

1. **Purpose / why it matters**
2. **Scorched3D approach** — files, classes, data structures, data flow (cite legacy paths)
3. **Our approach** — Unreal-native actors/components + current status (cite our paths)
4. **Side-by-side table** — concept · Scorched3D · ours
5. **Status** — proven / planned / not started
6. **Open questions** — short prose; live discussion happens in the notes thread

## Data flow

```
browser → GET nav.json ─────────────→ render left nav
       → GET content/<slug>.md ─────→ marked → content pane
       → GET /api/notes?topic=slug ─→ render notes thread
add note → POST /api/notes ─────────→ append notes.json → return entry → update thread
Claude  → read/append notes.json (file tools) ──────────→ same store the browser shows
```

## Build plan (agents)

1. **Research agent (read-only):** map Scorched3D's terrain subsystem from
   `.tmp/scorched3d-legacy` (HeightMap, LandscapeMaps/GroundMaps, DeformLandscape,
   VisibilityPatchGrid/patches, water/deform maps) and skim weapons + AI aiming for
   seeding → structured markdown facts with file/line citations.
2. **Build agent:** scaffold `tools/wiki-serve.py`, the `docs/wiki/` front-end, the notes
   API, `nav.json`, and the server smoke test.
3. **Claude:** write `terrain.md` from our code (`ACraterTerrainActor`, `CraterMath`, the
   heightfield carve) + the research; seed the other subsystem skeletons; wire the README.

## README

Add a "Project wiki / working notes" section linking to `docs/wiki/` and
`docs/wiki/content/how-it-works.md`, with the run line `python tools/wiki-serve.py`.

## Testing

- **Server smoke test** (stdlib `unittest` or a script): start server on an ephemeral
  port → `GET /api/notes` returns `[]`/existing → `POST` a note → re-`GET` shows it →
  `GET content/terrain.md` returns 200 with markdown. Asserts the write hit `notes.json`.
- **Front-end:** manual verification that nav, page render, and the notes thread work.

## YAGNI (explicitly out of v1)

No auth, no multi-user concurrency, no database, no search, no in-UI note edit/delete,
no extra JS deps beyond vendored `marked.min.js`. These can come later if the wiki proves
useful.
