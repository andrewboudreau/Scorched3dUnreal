# How this wiki works

A deliberately tiny architecture: **stdlib Python server + static front-end + JSON files in git.**
No framework, no build step, no npm, no external dependencies — it works fully offline.

## The moving parts

- **`tools/wiki-serve.py`** — a Python 3 *stdlib-only* HTTP server. It serves the static
  front-end from `docs/wiki/` and exposes a tiny notes API.
- **`docs/wiki/content/*.md`** — the wiki pages, authored as plain **Markdown** in the repo.
- **`docs/wiki/notes.json`** — the working-notes store: an append-only JSON array of notes,
  questions, and answers. **Git-tracked**, so it's shared.
- **`docs/wiki/assets/app.js`** — vanilla JS: routing, a small dependency-free Markdown
  renderer, and the notes UI.
- **`docs/wiki/nav.json`** — drives the grouped left nav and page order.

## How a page loads

```
browser → GET nav.json ───────────────→ render left nav
       → GET content/<slug>.md ────────→ render Markdown into content pane
       → GET /api/notes?topic=<slug> ──→ render the notes thread
```

Routing is hash-based (e.g. `#/terrain`), so links are shareable and browser back/forward work.

## How notes are shared

The notes API is small:

| Method | Path                       | Does                                                |
| ------ | -------------------------- | --------------------------------------------------- |
| GET    | `/api/notes?topic=<slug>`  | Notes for that topic plus `general`, oldest-first   |
| GET    | `/api/notes`               | All notes, oldest-first                             |
| POST   | `/api/notes`               | Append `{topic,type,author,text,parentId?}`         |

- The **server** assigns each note an `id` (uuid4) and `createdAt` (UTC ISO-8601) and appends it
  to `notes.json` under a lock with an atomic write.
- **You** post notes from the browser form (author `you`).
- **Claude** reads and appends the *same* `notes.json` directly via file tools, or by running the
  server with `--as claude`. Because the store is one git-tracked file, the queue is shared:
  a question you ask in the browser is one Claude can answer, and vice-versa.

A `question` with no child `answer` (no note whose `parentId` equals the question's `id`) is shown
with an **unanswered** badge — that's the shared work queue.

## Run it

```
python tools/wiki-serve.py
```

Then open **http://localhost:8777**. Optional flags: `--port <n>` and `--as <author>`.
