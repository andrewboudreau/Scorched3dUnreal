# Architecture: how main.js was split

The architecture review (issue #1) took `src/main.js` apart one piece at a
time, from 2,751 lines of glue down to about 600. Each piece became a module,
and its rules went into a pure file (no three.js, no DOM) with tests. `main.js` is now
wiring: it builds the scene and the modules, runs the frame loop, hands off
between modules and exposes `window.craterfall`.

| Step | Modules | Rules (tested) |
| --- | --- | --- |
| Camera | `camera.js` (CameraRig) | `cameramode.js` |
| 1. HUD and labels | `hud.js`, `labels.js`, `rangecard.js`, `inset.js`, `domwrite.js` | `hudlogic.js` |
| 2. Input router | `input.js` | `inputmap.js` |
| 3. Match glue | `match.js`, `events.js`, `setup.js`, `online.js` | `matchlogic.js`, `eventlogic.js`, `netlogic.js` |

Every step was a pure move: same bindings, same cards, same events, checked
against the build before it with the same seeded scripts.

## How the modules meet

- Each module takes a `deps` object from main.js. A module made later in
  main.js is passed as a getter (`get hud() { return hud; }`), read only once
  the page has loaded. Each module's header lists its deps.
- `Match` owns the Game being played (`match.game`). main.js keeps a `game`
  mirror (set through `onGame`) for the frame loop and the settings.
- `MatchEvents.handle()` drains the Game's events each frame. Each event goes
  first to the modules that keep their own (strike, boss, mods, sounds), then
  to its switch.
- `Online` is null-safe when offline: `online.session` and `online.link` are
  null, and its `update()` returns early.

## Still open

- The event switch in `events.js` moved as one piece. Splitting it into
  per-concern handlers (camera, HUD, effects), as `strike.js`, `bossui.js`
  and `modsui.js` already do, would shrink it further.
- Before you add a new reaction to a Game event, check whether it belongs in
  `eventlogic.js` (what to say, and who reacts) or in the module that shows it.
