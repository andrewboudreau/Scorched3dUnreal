# Craterfall: notes for Claude

An original three.js artillery game, mobile first, live at
https://blogfor.net/Craterfall/. Read `README.md` for how it plays and the
render layout, `docs/design-guide.md` for where the design is going, and
`docs/mobile.md` for the touch layout.

## Layout

- `src/core/`: the game, with no three.js and no DOM. Deterministic: all
  randomness goes through the seeded rng (`rng.js`); never `Math.random` here.
  Online play depends on it, because every browser runs the same game from the
  same log of messages (`netplay.js`).
  - `game.js` holds the rules and state, plus `snapshot()` / `restore()`.
  - `ai.js` is the CPUs.
  - The data lives in `weapons.js`, `perks.js` and `mods.js`.
- `src/render/`: three.js meshes and effects, one file per thing.
- `src/main.js`: the glue (HUD, camera, input, online). It's large, and several
  agents edit it, so keep changes there small and put new UI in its own module
  (as `modsui.js`, `guide.js` and `launch.js` do).
- `src/guide.js`: the in-game guide (Settings > Guide). It builds its lists
  from the data modules, so new weapons, perks and mods show up there on their own.
- `vendor/three/`: three.js r187, vendored. Don't upgrade it in passing.

## Checking work

- **Tests:** from `web/`, run `node --test`. Tests never import three.js.
- **Dev server:** `node tools/devserver.mjs <port>` serves the game and the same
  APIs as the live server. Port 8090 is usually the main session's; agents use
  another port.
- **Browser:** check in a real browser, and add `?mobile=1` to force the touch
  layout. `window.craterfall` exposes `game`, `camera`, `lookAt(x, y, z, from)`,
  `release()` and more for driving it from the console.

## The server (`module/`)

It's a SharedTools.Web module in C#. Check it with `dotnet build`. Each file's
header comment is the reference for its API.

| File | What it serves |
| --- | --- |
| `CraterfallModule.cs` | The game's files under `/Craterfall/` (no-cache, so a new drop shows up at once) |
| `Players.cs` | `/api/me` |
| `Rooms.cs` | `/api/rooms/...` |
| `Body.cs` | Shared helper: reads a JSON request body with a size limit |

**`Players.cs`** gives each player a random id in an HttpOnly cookie. It stores a
small record (name, played, won) only once a player sets a name or finishes an
online match. Records are saved to `players.json` in `_data/craterfall/` beside the drops,
on the module host's volume. Don't keep anything inside the drop's own folder:
the next upload moves it aside, which lost every record before this was found.
The module host's container is read-only apart from that volume and has 384 MB
of memory, shared with the other modules.

**`Rooms.cs`** runs online rooms: an ordered message log per room, read by
long-polling. Rooms live in memory only, so every deploy restarts the host and
ends matches in progress. There are limits on message size, room log size,
total memory and room count; they are listed in the file's header.

**`tools/devserver.mjs`** mirrors both APIs; change the two together. Run
`test/devserver.test.js` against either: set `CRATERFALL_API_BASE` to point it
at a running module.

**Trust:** clients are trusted. The host's browser runs the authoritative game,
and the server only relays messages. Match results come from the host and are
taken as they are. Stage 2 is email sign-in; see "Players and accounts" in the
design guide.

## Deploying

`module/deploy.ps1` publishes and uploads a drop. The host restarts and
reports it. It reads `MODULE_UPLOAD_KEY` from the environment or a gitignored
`.env`. That key lets its holder run code on the host: never commit it, print
it or pass it to sub-agents. The main session deploys.

## Working rules

- Work on branch `feat/web-craterfall`. Agents work in worktrees and the main
  session merges them.
- The backlog is GitHub issues labelled `craterfall`. The repository is public,
  so keep private paths, keys and other projects out of issues and committed
  docs.
- Only commit assets that may be redistributed (CC0 or our own). Resource-pack
  folders outside the repo are reviewed locally and are not part of the game.
