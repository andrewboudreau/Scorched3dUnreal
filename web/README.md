# Craterfall (WebGL / three.js)

A browser edition of the Scorched3dUnreal artillery game: tanks on
destructible 3D terrain, firing all together or taking turns, wind, a perk draft and a shop between rounds, a little
fuel for repositioning, and CPU opponents. No build step; three.js r187 is
vendored under `vendor/three`.

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
| A / D | turret |
| W / S | elevation |
| Q / E | power |
| Shift | fine adjust |
| ↑ / ↓ | drive forward / reverse along the hull (uses fuel) |
| ← / → | turn the hull (free) |
| Tab / 1–9 | weapon (or click it in the bar at the bottom) |
| Space | fire (in a volley: lock in your shot) |
| F | look at the next opponent, nearest first (or click a name: an edge arrow or a scoreboard row) |
| C | follow-shell camera |
| V | overview camera |
| M | mute everything |
| - / = | volume down / up (also a slider on the setup screen; it is remembered) |
| Mouse | drag to orbit, wheel to zoom |

## How it plays

- **Firing: together or in turns.** The setup screen has a Firing option.
  - *Together (volley)*, the default: nobody shoots alone. Each living human
    plans in turn (drive, aim, pick a weapon, Space to lock it in), then every
    tank fires at once and all the shells fly together. With more than one
    human, a hand-off card covers the field between planners, and a locked
    aim is hidden: the turret goes back to where everyone last saw it and
    only swings to the plan in the "Fire!" beat. CPU tanks do any driving
    before the humans plan and aim at the last moment, at the tanks where
    they stand. A tank destroyed mid-volley has already fired, so mutual
    kills happen and a round can end in a draw. Wind drifts once per volley,
    and the round limit (40) counts volleys. With one human the camera follows
    that player's own shell and drops a small pip where each other tank's shot
    lands (pinned to the screen edge when off camera); with several it pulls
    back to keep every shell in view. Launch sounds are staggered and capped so
    a six-tank volley does not turn into a wall of noise.
  - *Take turns*: the classic game, one tank aims and fires at a time.
- **Finding the enemy.** While you plan, every opponent that is off screen has
  an arrow on the screen edge with its name and range. Click it, a scoreboard
  row, or press F for a three-second look; the camera then comes back.
- **Your tank, inset.** While the camera is off with your shell, a small view
  in the bottom-right corner keeps your own tank in sight, and flashes red
  with the damage when something lands on it (one human only).
- **Rangefinder.** No damage: five small probes leave together, one as aimed,
  two with the turret 2° either side and two with power 5 lower and higher.
  Each landing keeps a labelled marker ("as aimed", "turret 269.4°",
  "power 65.0") until you fire again, so you can read off which way to adjust.
  Two come in the starting kit; more are 60 for three in the shop. Shells are
  drawn as small finned missiles; Roller rounds are still balls.
- **Last shot.** Under Turret, Elevation and Power the card shows your last
  shot's value and how far you are from it ("last 52.1°" with "+2.3" beneath).
  It is cleared at the start of a round and when the tank ends up more than
  4 m from where it fired (the old aim would no longer mean anything).
- **Roads and paths.** Gravel roads join the hamlets, a track runs from each
  hamlet down to the nearest water or the bridge, and a short path leads from
  each door to the middle of its hamlet. They are routed over the heightfield
  along gentle ground, around water, houses and the tanks' starting pads, and
  painted onto the terrain, so a crater takes its piece of road with it.
  Nothing grows on them, and villagers like to stroll along them.
- **Roller** lands, then rolls downhill along the ground with the momentum it
  landed with. It goes off when it comes to rest, touches a tank, sinks into a
  lake or has rolled 160 m. A direct hit in flight goes off at once.
- **CPU tanks walk their shots in.** Each keeps an aim memory per target: the
  first shot is a rough guess and the error shrinks with every shot at the same
  target. It grows back when the target or shooter moves or the wind swings.
  Easy stays wild, Normal usually lands on shot 2 to 4, Hard on shot 1 to 2.
- **Scenery is cosmetic.** Trees, bushes, rocks, hamlets, a bridge, villagers
  and sheep never block shells (a standing house does stop a driving tank). Blasts flatten trees and bushes, turn
  houses into ruins, drop the bridge and scatter people and sheep; whatever
  survives is re-seated on the new ground, and props that end up buried or
  under water are removed. Ground dug below the water level floods.
- **Armory.** Between rounds each human shops in turn (the panel names whose
  turn it is and who is next); CPU tanks buy for themselves. Everyone gets a
  $150 stipend per round on top of damage, kill and win pay.
- **Fuel.** Every tank has 30 m of driving per round, on its own turn (or
  its own planning, in a volley), before it fires. Climbing burns extra (a 45 degree slope costs three times level
  ground and is the steepest a tank can take); coasting downhill costs the
  same as level. Tanks will not drive into water, off the map, through each
  other or through a standing house, but one that has ended up in a flooded
  crater can climb out. A Fuel Can from the armory adds 20 m for the next
  round. CPU tanks (Normal and Hard) drive only to get out of a hole or off a
  spot where they keep being hit, and a drive never holds a turn for more
  than a few seconds.
- **Perk draft.** With Twists on (the default, on the setup screen), after
  every round each tank picks one of three random perks before it shops. They
  last the whole match and stack; CPU tanks pick for themselves. In hotseat
  each human gets their own draft and armory in turn, with the hand-off named
  on the button. Owned perks show as tags on the player card and scoreboard.

  | Perk | Effect |
  | --- | --- |
  | Wide Blast | blasts reach 15% further |
  | Heavy Charge | blasts hit 12% harder |
  | Reinforced Hull | +20 hit points every round |
  | Dug In | start every round with 20 armor |
  | Quartermaster | one free Breacher every round |
  | Long-Range Tanks | +15 m of driving every round |
  | Haggler | armory prices 20% lower |
  | Bounty Hunter | +50% money for damage dealt |
  | Field Repairs | repair 6 hit points at the start of each of your turns (each volley) |
  | Shock Mounts | no damage from falling into craters |
  | Heavy Rounds | wind pushes your shots 35% less |
  | Shrapnel | plain Shells throw two bomblets onward from where they land |
  | Tracer Rounds | see the first 45 m of your shot while you aim |

- **Round modifiers.** With Twists on, each round rolls one and announces it on
  the round banner; it applies to everyone alike. Clear skies (nothing, twice
  as likely as the others), Gale (much stronger wind), Dead calm, Low gravity,
  Soft ground (craters a third bigger), Gold rush (double pay) and Full tanks
  (double fuel). The same one never comes up twice in a row. CPU tanks aim
  with the round's gravity and wind.
- **Daylight and life.** The sun moves from late morning to a golden late
  afternoon over the match (never night). Clouds drift with the wind and dim
  the ground beneath them, small flocks circle and scatter from blasts and
  passing shells, villagers walk and sheep hop.
- **Sound** is synthesised, no assets: a wind bed that follows the wind, a
  bird chirp or a bleat now and then (quieter with distance), a layered
  cannon, a whistle as a shell comes down, blasts that arrive later and
  duller from far away, and an engine hum while a tank drives.

## Layout

- `src/core/` holds the pure game logic with no DOM or three.js: the heightfield and
  crater maths, the fixed-step ballistics simulator and roller, weapons, the AI
  aim solver and aim memory, driving (`driveStep` in `tank.js`), perks and round
  modifiers as plain data (`perks.js`), road and path routing (`paths.js`), scenery placement and its reaction to
  terrain changes, and the `Game` state machine. It emits events and runs headless.
- `src/render/` holds the terrain mesh (partial updates per crater, roads painted
  through a mask texture), tank models,
  effects, the instanced scenery and water (`sceneryMesh.js`), the sky, sun and
  clouds (`sky.js`) and the flocks (`birds.js`).
- `src/audio.js` is the synthesised sound.
- `src/main.js` holds the scene, camera rig, input, HUD and menus. It turns `Game`
  events into visuals and sound.
- `test/` holds the headless tests (`npm test`, Node 18+). They cover crater shape,
  analytic range, wind drift, the roller, AI convergence and how fast each
  difficulty walks its shots in, scenery placement and bombardment, perks, the
  draft, modifiers, driving and fuel (`twists.test.js`), road routing (`paths.test.js`),
  aim history and both firing modes (`volley.test.js`), and whole CPU-only matches.

The ballistics, crater falloff and AI solver follow the Unreal project's
`CraterMath`, `TankAiming` and the legacy aim-guesser loop. The AI aims with
the same simulator the shells fly on.

`window.craterfall` exposes the live game, camera, sky, birds and sound for
debugging from the console, with `lookAt` / `release` to pin the camera,
`tick(dt)` to run one frame by hand and `setDay(0..1)` to hold the sun at a
time of day.

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
