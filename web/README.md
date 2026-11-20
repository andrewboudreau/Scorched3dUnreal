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
| Tab / 1–9 | weapon (or click it in the bar at the bottom) |
| Space | fire |
| C | follow-shell camera |
| V | overview camera |
| M | mute |
| Mouse | drag to orbit, wheel to zoom |

## How it plays

- **Roller** lands, then rolls downhill along the ground with the momentum it
  landed with. It goes off when it comes to rest, touches a tank, sinks into a
  lake or has rolled 160 m. A direct hit in flight goes off at once.
- **CPU tanks walk their shots in.** Each keeps an aim memory per target: the
  first shot is a rough guess and the error shrinks with every shot at the same
  target. It grows back when the target or shooter moves or the wind swings.
  Easy stays wild, Normal usually lands on shot 2 to 4, Hard on shot 1 to 2.
- **Scenery is cosmetic.** Trees, bushes, rocks, hamlets, a bridge, villagers
  and sheep never block shells or tanks. Blasts flatten trees and bushes, turn
  houses into ruins, drop the bridge and scatter people and sheep; whatever
  survives is re-seated on the new ground, and props that end up buried or
  under water are removed. Ground dug below the water level floods.
- **Armory.** Between rounds each human shops in turn (the panel names whose
  turn it is and who is next); CPU tanks buy for themselves. Everyone gets a
  $150 stipend per round on top of damage, kill and win pay.

## Layout

- `src/core/` holds the pure game logic with no DOM or three.js: the heightfield and
  crater maths, the fixed-step ballistics simulator and roller, weapons, the AI
  aim solver and aim memory, scenery placement and its reaction to terrain
  changes, and the `Game` state machine. It emits events and runs headless.
- `src/render/` holds the terrain mesh (partial updates per crater), tank models,
  effects and the instanced scenery and water (`sceneryMesh.js`).
- `src/main.js` holds the scene, camera rig, input, HUD and menus. It turns `Game`
  events into visuals and sound.
- `test/` holds the headless tests (`npm test`, Node 18+). They cover crater shape,
  analytic range, wind drift, the roller, AI convergence and how fast each
  difficulty walks its shots in, scenery placement and bombardment, and whole
  CPU-only matches.

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
