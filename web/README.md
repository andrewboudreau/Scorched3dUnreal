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

To try online play locally, run `node tools/devserver.mjs` instead. It serves
the game on the same port and adds the rooms API, so two browser tabs can play
each other.

### Reviewing resource packs

The dev server also mounts the asset library's resource packs (the NAS library
by default; set `CRATERFALL_PACKS` to another folder). A **Packs (P)** button
then appears in the game, opening a review panel (`src/review.js`):

- **Sounds**: play any of them, or put one in for a game event (cannon, small,
  medium, big and far blasts, impacts, tank hits, wreck parts, jet, teleport,
  shell whoosh, UI click). **Use pack in game** does all of them by name, so the
  next shot sounds like the pack; **layer** plays the synth underneath, and the
  Test row fires each event on the spot.
- **Skies**: an HDRI replaces the sky and its light, and the game's sun (and its
  shadows) is turned to the brightest spot in it.
- **Materials**: re-skin the ground (at the material's real tile size), or put a
  sample ball by the camera.
- **Models**: set down by the camera at true scale, next to the tanks.

Mark items keep or drop and **Save picks**: they go to `docs/pack-picks.json`
for the resource oracle. Packs are never hot-linked from the live game; the ones
kept are copied into the repo.

To review on a phone, open the live game with `?packs` (blogfor.net/Craterfall/?packs).
It loads the packs marked redistributable from a phone-sized mirror (1k skies,
512 px materials) that `tools/packmirror.py` builds into `packmirror/` (not in
git). The mirror is its own module drop, `packsmodule/`, deployed only when the
packs change: `cd module && ./deploy.ps1 -Id craterfall-packs -Project ../packsmodule`.
There **Save picks** becomes **Copy picks**, which puts them on the clipboard.

## Controls

| Key | Action |
| --- | --- |
| A / D | turret (while a Guided Missile flies: steer it left / right) |
| W / S | elevation |
| Q / E | power |
| Shift | fine adjust |
| ↑ / ↓ | drive forward / reverse along the hull (uses fuel) |
| ← / → | turn the hull (free) |
| J | jump jet: hop about 25 m the way the hull faces (does not use the shot or fuel) |
| Tab / 1–9 | weapon (or click it in the bar at the bottom) |
| Space | fire (in a volley: lock in your shot) |
| F | look at the next opponent, nearest first (or click a name: an edge arrow or a scoreboard row) |
| C | follow-shell camera |
| V | overview camera |
| M | mute everything |
| N | next music track |
| - / = | volume down / up (also a slider on the setup screen; it is remembered) |
| Mouse | drag to orbit, wheel to zoom |

On a phone or tablet (or with `?mobile=1`) on-screen controls appear instead:
an aim pad and power strip for the right thumb, a drive cross and jump jet for
the left, an optional tilt aim, and Mute (and Chat, online) buttons. Tap
**Tilt** to cycle off, **Lean** (tilt steers like a joystick) and **Grip** (tilt
steers only while your thumb rests on the aim pad, like a mouse you lift to
re-centre); **Inv** flips which way tipping the phone raises the barrel. "Add to
Home Screen" installs it as an app that opens fullscreen in landscape. See
`docs/mobile.md`.

## How it plays

- **Wind** sits in the aim card, under Power. Its arrow is drawn from behind
  your turret (up is the way you aim), so it holds still while you orbit
  the camera, and the line beside it splits it for this shot: how far it
  pushes the shell right or left, and whether it carries it longer or
  shorter.
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
  Each landing keeps a labelled marker and a tall beam (white as aimed, amber
  turret, cyan power) until you fire again. A card under your aim card plots
  the five landings from above, downrange up, around the enemy nearest them
  (with your weapon's blast circle), says how far off the aimed probe was
  ("30 m short, 18 m right of Rook") and estimates the turret and power to hit
  it from how far the probes spread. It is a straight-line estimate: good near
  the probes, rougher the further off, and it says so if you have moved,
  changed elevation or the wind has shifted since. Click the card to look at
  the landings.
  Two come in the starting kit; more are 60 for three in the shop. Shells are
  drawn as small finned missiles; Roller rounds are still balls.
- **Guided Missile.** A shell-sized blast you can steer: while it flies,
  A / D (or ← / →) swing it left or right at 34°/s for up to three seconds
  of steering fuel, shown in a bar above the weapons. It does not climb or
  dive, only turns. One in the starting kit; 90 for two in the shop. On a
  shared screen every human's missile answers the same keys.
- **Flak.** Like Scatter, it bursts at the top of its arc, but into 14 small
  shells spread over a disc about 50 m across instead of a line of five. Each
  is a shallow 7 m crater worth 10 damage (Scatter's five are 28 each), so the total is the
  same 140 and the cover is much wider: it chews up an area and wounds
  everything in it, where Scatter punishes a direct hit. 220 for two. CPU
  tanks use it, and shop for it.
- **Teleport.** No damage. Your tank moves to where the shell lands, snapped to
  the ground and nudged clear of water, houses, tanks and the map edge. Shells
  already in the air still land where they were aimed, so you may have left
  the spot. A flash marks the old and new places. 120 for two. The CPU does
  not buy or fire it.
- **Fog of war** (setup option, off by default; works online too). Your tank
  sees 110 m around itself; the ground, trees, houses and water beyond are
  dimmed and enemy tanks out there are hidden. You still have intel on them, drawn as a ring in their
  colour with a "Name?" label: a rough fix (60 m of doubt) from the start of
  the round, a rougher one (35 m) whenever they fire where you cannot see,
  and an exact "last seen here" once they have been in sight. A hidden
  tank's muzzle flash and smoke are not shown, and its shell is only drawn
  once it starts coming down, so the trail does not lead back to it. Edge
  arrows, F, the rangefinder card and the camera all go by what you know.
  CPUs play by the same rules: they aim from their own intel and send scouts.
- **Scout Missile** (fog of war only). No damage: where it lands it lights up
  120 m, for you alone, for your next two shots (two volleys, or two of
  your turns). One free each round; 50 for two in the shop.
- **Kill cam.** When a shot in the air is about to end the round (its blast
  would leave at most one tank standing), time slows to about a quarter, the
  screen letterboxes, the HUD steps aside and the camera swings round to
  watch it land from the side, then speeds back up.
- **Match results.** Besides wins and funds, the end screen lists each
  tank's hits out of shots and accuracy (rangefinder probes apart), damage
  dealt (overkill not counted), kills and longest hit, plus a few awards:
  sharpshooter (at least three shots), longest hit, most damage, most kills.
- **Online.** Under the setup card is a live list of open rooms (and
  matches being played, with who is in them), plus who else is on the menu
  right now. Type a name and press *Join* on a room, or *Create a room* and
  it appears in everyone's list. Tick *Private* to keep a room off the list;
  friends then join with the invite link (or the 4-letter code). The host picks
  the rounds, wind, terrain and any CPU tanks, then starts. Up to six tanks.
  Online play is always volley: everyone plans on their own screen at the
  same time, a banner says who the game is waiting for, and all shells fly
  together once everyone has locked in. Between rounds each player drafts
  and shops on their own screen, and the next round starts when all are
  done. The Guided Missile is left out online, since its steering is live.
  Online there is a clock: a minute to plan each shot (it then goes as
  aimed) and a minute and a half in the armory; the countdown shows for the
  last 20 seconds. A tab in the background keeps playing, so switching
  away does not hold the room up. Reloading the page puts you back in your
  seat. If a player stops answering for about 45 seconds, a CPU takes over
  their tank. If the host goes, the match ends. Press Enter to chat, in the
  lobby or in the match.
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
  its own planning, in a volley), before it fires, and every shot it fires
  puts a third of that back (never past full). Climbing burns extra (a 45 degree slope costs three times level
  ground and is the steepest a tank can take); coasting downhill costs the
  same as level. Tanks will not drive into water, off the map, through each
  other or through a standing house, but one that has ended up in a flooded
  crater can climb out. A Fuel Can from the armory adds 20 m for the next
  round. CPU tanks (Normal and Hard) drive only to get out of a hole or off a
  spot where they keep being hit, and a drive never holds a turn for more
  than a few seconds.
- **Jump jets.** Press J while planning to hop about 25 m along the hull in a
  1.6 s arc, 10 m high at the top, over craters, rubble and your neighbours.
  It costs a charge, not the shot or any fuel. Everyone starts with one;
  the armory sells two for 80. The hop lands on the spot the core worked out
  (shortening to 20, 16, 12 or 8 m if the full jump would end in water,
  off the map, on a tank or house or on a cliff more than 22 m above you),
  and says so in the aim card if none fit, keeping the charge. It uses the
  same state as driving, so online it travels in your plan and replays the
  same on every screen. CPU tanks (Normal and Hard) hop when stuck in a hole
  at least 4 m deep and out of fuel for a drive, in the direction that
  leaves it least in a hole.
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
- **Music** is synthesised too: a small step sequencer plays one of four
  tracks, picked on the menu (Music, with its own level) or with N in a
  match: *Outpost* (calm pads and plucks), *Artillery March* (snare rolls and
  brass), *Bunker Lo-fi* (swung keys and crackle) and *Barrage* (chiptune).
  The choice is remembered. The kill cam muffles it along with the slow motion.

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
- `src/audio.js` is the synthesised sound, `src/music.js` the soundtrack.
- `src/review.js` (with `src/packkit.js`) is the resource-pack review, loaded only by the dev server.
- `src/core/netplay.js` runs an online match: every screen keeps its own
  `Game` and reads the same ordered message log (plans, shop choices). At
  each volley, and again before each round, the host sends its full state
  (`Game.snapshot`) and the others take it, so small floating-point drift
  never adds up. A reloaded tab reads the log back, jumps to the host's
  latest state and counts its own earlier plans as made. `src/net.js` is
  the browser's link to the room (long polling, sends kept in order).
- `src/main.js` holds the scene, camera rig, input, HUD and menus. It turns `Game`
  events into visuals and sound.
- `test/` holds the headless tests (`npm test`, Node 18+). They cover crater shape,
  analytic range, wind drift, the roller, AI convergence and how fast each
  difficulty walks its shots in, scenery placement and bombardment, perks, the
  draft, modifiers, driving and fuel (`twists.test.js`), road routing (`paths.test.js`),
  aim history and both firing modes (`volley.test.js`), jump jets, Teleport and Flak
  (`jets.test.js`), whole CPU-only matches, and
  online matches between several simulated screens with deliberate drift,
  including screens reloading at every stage of a match (`netplay.test.js`).

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
`CraterfallModule` serves those files under `/Craterfall/`, and `Rooms.cs`
serves the online rooms API under `/Craterfall/api/rooms`. Rooms live in
memory on the server, so a redeploy ends any match in progress.
`tools/devserver.mjs` is a copy of the same API for local testing; keep the two in step.

```powershell
cd web/module
./deploy.ps1   # needs MODULE_UPLOAD_KEY in the env or a gitignored .env
```

The game is live at https://blogfor.net/Craterfall/ (gateway path route) and
https://modules.blogfor.net/Craterfall/.
