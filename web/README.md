# Craterfall (WebGL / three.js)

A browser edition of the Scorched3dUnreal artillery game: turn-based tanks on
destructible 3D terrain, wind, a shop between rounds and CPU opponents. No build
step; three.js r187 is vendored under `vendor/three`.

## Run

```sh
cd web
python -m http.server 8080    # or: npm run serve
```

Open http://localhost:8080. ES modules need a server, so opening `index.html`
from disk will not work. Python's server sends no cache headers, so after editing
a module use a hard reload (Ctrl+Shift+R) or keep DevTools open with
"Disable cache" ticked.

## Controls

| Key | Action |
| --- | --- |
| A / D (or ← →) | turret |
| W / S (or ↑ ↓) | elevation |
| Q / E | power |
| Shift | fine adjust |
| Tab / 1–9 | weapon |
| Space | fire |
| C | follow-shell camera |
| V | overview camera |
| M | mute |
| Mouse | drag to orbit, wheel to zoom |

## Layout

- `src/core/` holds the pure game logic with no DOM or three.js: the heightfield and
  crater maths, the fixed-step ballistics simulator, weapons, the AI aim solver
  and the `Game` state machine. It emits events and runs headless.
- `src/render/` holds the terrain mesh (partial updates per crater), tank models and
  effects.
- `src/main.js` holds the scene, camera rig, input, HUD and menus. It turns `Game`
  events into visuals and sound.
- `test/` holds the headless tests (`npm test`, Node 18+). They cover crater shape,
  analytic range, wind drift, AI convergence and whole CPU-only matches.

The ballistics, crater falloff and AI solver follow the Unreal project's
`CraterMath`, `TankAiming` and the legacy aim-guesser loop. The AI aims with
the same simulator the shells fly on.

`window.craterfall` exposes the live game, camera and a `lookAt` helper for
debugging from the console.

## Deploying

`web/module/` packages the game as a SharedTools.Web module drop. Its csproj links
`index.html`, `css/`, `src/` and `vendor/` in as `wwwroot`, so there is one copy of the game.
`CraterfallModule` serves those files under `/Craterfall/`.

```powershell
cd web/module
./deploy.ps1   # needs MODULE_UPLOAD_KEY in the env or a gitignored .env
```

The game is live at https://blogfor.net/Craterfall/ (gateway path route) and
https://modules.blogfor.net/Craterfall/.
