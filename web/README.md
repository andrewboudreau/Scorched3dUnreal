# Craterfall (WebGL / three.js)

A browser edition of the Scorched3dUnreal artillery game: tanks on
destructible 3D terrain, firing all together or taking turns, wind, a skill tree and a shop between rounds, a little
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

### Testing query params

Add these to the address to make a test repeatable. They are read once when the
page loads and override both Random and what Custom match remembers.

| Param | Values | What it does |
| --- | --- | --- |
| `mobile` | (none) | Forces the touch layout on a desktop. |
| `packs` | (none) | Loads the redistributable resource packs for review (see below). |
| `room` | a 4-letter code | Opens that online room's invite; this is what the invite link carries. |
| `wind` | `calm`, `breezy`, `gusty`, `gale`, or a number 0 to 5 | Forces the match wind (Play and Custom). |
| `terrain` | `rolling`, `hilly`, `mountains`, `city`, `isles`, `ridgeline`, `island` | Forces the terrain. |
| `time` | `dawn`, `day`, `dusk`, `night` | Forces the time of day (render-only; Random picks from the match seed). |
| `edges` | `open`, `wall`, `bounce`, `wrap`, `random` | Forces the arena's edge rule (see Arena edges below). |
| `fixed` | (none) | Gusty wind and Hilly terrain, the old defaults, unless `wind` or `terrain` say otherwise. `fixed=0` is ignored. |
| `sat` | `1`, `2`, `3` | Every tank starts with a Survey Satellite at that level. |
| `orbiter` | `1`, `2`, `3` | Every tank starts with a Gravity Orbiter at that level. |
| `decoy` | `1`, `2`, `3` | Every tank starts with a Decoy Beacon at that level. |
| `pointdef` | `1`, `2`, `3` | Every tank starts with Point Defense at that level. |
| `jammer` | `1`, `2`, `3` | Every tank starts with a Jammer Drone at that level. |
| `labels` | `few`, `some`, `many` | How many of the satellite's cells are labelled (default `some`). |
| `boss` | `1` | Play starts the boss match: you and a CPU ally against the Bulwark (see The boss match below). |
| `modifier` | a round modifier id: `rain`, `lowgrav`, `gale`, `calm`, `soft`, `goldrush`, `fulltanks`, `clear` | Every round is that modifier. |

An online room rewrites the address to `?room=`, so set test params on the
host's page before creating the room. The host's choices travel to everyone.

### Reviewing resource packs

The dev server also mounts the asset library's resource packs, from
`CRATERFALL_PACKS` or else `{"packs": "<folder>"}` in `tools/local.json`
(gitignored, so machine paths stay out of the repo). **Settings > Resource
packs** (or P) then opens a review panel (`src/review.js`):

- **Sounds**: play any of them, or put one in for a game event (cannon, small,
  medium, big and far blasts, impacts, tank hits, wreck parts, jet, teleport,
  shell whoosh, UI click, debris patter, ground thump, fire crackle, and a rain loop for Rain rounds). **Use pack in game** does all of them by name, so the
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
| Shift | fast aim (3×), for big turns. A short tap of an aim key is a fine step; holding ramps up to full speed |
| ↑ / ↓ | drive forward / reverse along the hull (uses fuel) |
| ← / → | turn the hull (free) |
| J | jump jet: hop about 25 m the way the hull faces (does not use the shot or fuel) |
| X | Double Strike (with the perk): arm a double, or drop it again |
| B | deploy a ready mod: press once to arm, again to deploy (it takes your turn) |
| Tab / 1–9 | weapon (or click it in the bar at the bottom) |
| Space | fire (in a volley: lock in your shot) |
| F | hold the camera on the next opponent, nearest first; pressed on the last one (or the only one, 1v1) it returns to your tank. Clicking a name (an edge arrow or a scoreboard row) gives a three-second look |
| C | follow-shell camera |
| V | overview camera |
| M | mute everything (Master; Settings, the ⚙ button, has Effects and Music too) |
| N | next music track |
| - / = | Master volume down / up (remembered) |
| Mouse | drag to orbit, wheel to zoom |

On a phone or tablet (or with `?mobile=1`) on-screen controls appear instead:
an aim pad and power strip for the right thumb, a drive cross and jump jet for
the left, ⚙ Settings in the top right corner, and Fine, Find, View and Chat (online) in
the middle. SIGHT (above the weapon button) looks down your turret line. The weapon
button above Fire opens the weapons as a pop-up, and the keyboard hints are
hidden. "Add to Home Screen" installs it as an app that opens fullscreen in
landscape. See `docs/mobile.md`.

On a phone the HUD steps aside for what you are doing (`src/hudview.js`): the
player card is small (the pad and weapon button carry the aim numbers, the last
shot's values and the rounds left), while a shell flies the aim controls and card
fade out and the rest goes faint, the sight keeps only the wind, and the HUD hides
between rounds. The audit, element by element and view by view, is in
`docs/mobile.md`. Teaching lines (the SIGHT note, the pad's "drag" line, the
"tap Lock in" banner text) show only the first few times (`src/hints.js`, kept in
localStorage).

**Settings** (⚙, bottom right on a desktop and top right on a phone, on every screen) holds the sound:
Master, Effects and Music levels, each with a mute, and the music track. Master
sits under the device's own volume (a web page cannot set that), so it starts at
full. Also **Graphics > Fire and smoke** (Full, or Light, the default on phones: fewer
flames, puffs and embers), full screen where the browser allows it, and the resource-pack review
where packs are served.

**Guide** (Settings > Guide, from the launch screen or mid-match) is a short in-game
page in tabs: Basics, Controls (touch first, then keys), Weapons, Mods and perks
(with the rock-paper-scissors) and Match builder. `src/guide.js` builds the weapon, mod,
perk and round modifier lists from `core/weapons.js`, `mods.js` and `perks.js`, reading every field
defensively, so it follows the data and skips what it cannot describe. It is loaded
the first time it opens (styles in `css/guide.css`). Keys typed in it never reach
the game; Esc, the ✕ or a tap outside closes it. Its content builders are tested in
`test/guide.test.js`.

**Suggest** (Settings, in the header of every tab; also on the catalog page) sends the developer a note: the player picks what it is about (Game, Match builder, Settings, Guide, Catalog, Online, Other; it starts on where they were) and the page adds a little context (screen, round, phase, modifier, window size). `src/suggest.js` is the box and `module/Suggestions.cs` keeps them (`suggestions.json` beside `players.json`). The owner reads them at `suggestions.html` or with `node tools/suggestions.mjs`, both with the review key; see CLAUDE.md.

**Catalog** (`catalog.html`, also Settings > Catalog) is the designer's page, not a player's: one dense, sortable, searchable table each for weapons, upgrades, perks, mods and round modifiers, plus every tuning constant (Numbers). `src/catalog.js` builds them from the core data modules (so new entries and fields appear on their own), links perks to mods and weapons, and reads what the CPUs pick from `core/ai.js`; helpers are tested in `test/catalog.test.js`.

Everything sits in one column on the left: the player card (with the round and
its modifier at its head), the players box with every tank's health, and the
rangefinder when you have one. On a short screen the rangefinder wraps into a
second column beside the first. On a phone the players box sits top right.


## How it plays

- **Wind** sits in the aim card, under Power. Its arrow is drawn from behind
  your turret (up is the way you aim), so it holds still while you orbit
  the camera, and the line beside it splits it for this shot: how far it
  pushes the shell right or left, and whether it carries it longer or
  shorter.
- **The launch screen** (`src/launch.js`, `#setup`). It shows the title, one
  **Your name** field (`#net-name`; it names your tank and your online seat) and a
  big **Play**, which starts you against two Normal CPUs with the default
  options (everything on, wind and terrain Random). Below it are two tabs (the
  last one is remembered): **Online** (create a room, join with a code, the open
  rooms; the tab shows how many are open) and **Custom match**, the match
  builder: the tank rows (add or remove, human or CPU), Rounds, Wind, Terrain,
  Firing and Fog of war, then three checkbox groups, **Weapons**, **Perks** and
  **Round modifiers** (`src/builder.js`). Each group is shut by default, its
  summary saying "All" or "7 of 12"; open, it has an All box and a grid of
  ticks with each name and its first line. **Start match** in there starts the
  configured match. Whether Custom was open, the options you last chose, what
  you unticked and your CPU rows are kept in localStorage (`craterfall.custom`,
  version 3: it stores what is *off*, so anything new arrives ticked), so the
  next visit opens as you left it; Play ignores them and always uses the
  defaults.
  - *Wind* and *Terrain* default to **Random**: one is picked when the match
    starts (in `main.js`, never in the deterministic core) and the round banner
    names it, e.g. "Round 1 of 3 · Hilly · Gusty wind". Random wind is Calm,
    Breezy, Gusty or Gale (Breezy and Gusty twice as likely); Random terrain is
    Rolling, Hilly, Mountains or, half as often as each of those, the City,
    the Floating isles, the Ridgeline or the Island. Online the host rolls and sends the concrete values in the match
    config, so every screen builds the same world.
  - *Time of day* (`?time=`): **Random** (the default), Dawn, Day, Dusk or Night.
    A look, not a rule: the core only carries it (`cfg.time`, `core/timeofday.js`)
    and never reads it. Random is settled from the match seed (`pickTime`: Day
    twice as likely as the others), so every screen of an online match agrees.
    `render/timeofday.js` holds the presets as plain data (two keyframes each,
    easing over the match like the old morning-to-golden-afternoon); `Sky.setTime`
    applies them: the sun's height, direction and colour, the sky and hemisphere
    light, the fog's colour and distance, shadow strength (`sun.shadow.intensity`),
    and the water's tint (`SceneryMesh`). Day is the original look. Dawn is a low
    pink-gold sun and haze; Dusk a red sinking sun and a violet sky; Night a blue
    moon key light, a dark-blue sky with stars, and lit windows in the villages.
    At Dusk and Night the lit things come on without any real lights: tank
    headlights (brighter lamps plus an additive glow sprite each), village windows
    (vertices marked by their alpha, glowing by `look.lit`), and in the City the
    windows (an emissive map) and street lamps. Blasts hit harder in the dark
    (the flash light's strength and reach scale with `flash`), shells carry a glow
    and their smoke trails brighten, while ordinary smoke dims (`shade`). The
    Floating isles keep their own dusk-violet space sky at any time; the
    Ridgeline keeps its own dusk look on a Dusk match and takes the time's sky
    otherwise. The banner adds the time ("· Dusk") unless it is the plain Day.
  - *Edges* defaults to **Open**; see Arena edges below. Its Random is rolled
    each round inside the game, on the match's seeded dice, so it travels as
    `edges: 'random'` and every screen rolls the same.
  - *Weapons*: an unticked weapon is gone for the match: not in the armory, the
    starting kit, a perk's hand-out (Quartermaster, the fog's free Scout) or the
    CPUs' hands. The Shell is always on.
  - *Perks*: an unticked perk drops out of the skill tree, for humans and
    CPUs. Mods come only from their branches, so unticking Orbital Mechanic or
    Sat Recon turns that mod off. With every perk off there is no skill tree.
  - *Round modifiers*: Clear skies is one of the ticks; with all off every round
    is plain. With the wind on Calm, Gale and Dead calm sit out.
  - The core takes these as allow-lists in its config (`weapons`, `perks`,
    `modifiers`; null means all) and filters with its seeded rng, so online
    screens agree. The old `twists: false` still works and means no perks and
    no modifiers. In an online room the Custom section is the
  lobby: always open, with no Play. On a phone the screen fills the screen
  rather than floating as a card, and tapping Play or Start also goes full
  screen where the browser allows it (not iPhone Safari).
- **Firing: together or in turns.** Custom match has a Firing option.
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
  of steering fuel, shown in a small Guidance gauge at the right edge (its
  how-to line fades after a moment). On a phone, hold a finger on the left or
  right half of the view to steer. It does not climb or dive, only turns. One
  in the starting kit; 90 for two in the shop. On a shared screen every
  human's missile answers the same keys.
- **Flak.** A proximity fuse. On the way down it bursts at its nearest pass
  over an enemy tank (within 22 m across and 4 to 40 m above it) and rains 12
  fragments on it, each a shallow 7 m blast worth 10, in a pattern about 20 m
  across just past the point under the burst; passing nobody, it bursts 14 m
  over the ground. So a near miss still hurts, and the best shot passes about
  10 m over the tank rather than at it: a burst right overhead does about 45,
  a shot aimed at the tank itself goes off short and does a little less. Over
  open space (the isles) it only bursts over a tank. 200 for two. CPU tanks
  use it and shop for it; Normal and Hard CPUs aim it to pass over the target
  (`ai.flakPass`), Easy ones aim it like a shell.
- **Teleport.** No damage. Your tank moves to where the shell lands, snapped to
  the ground and nudged clear of water, houses, tanks and the map edge. Shells
  already in the air still land where they were aimed, so you may have left
  the spot. A flash marks the old and new places. 120 for two. CPU tanks
  (sappers and skirmishers buy it) fire it to get out of a deep hole, when
  they are being shot to pieces, or when far behind, at open, dry ground at
  least 80 m from any enemy they know of.
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
- **Online.** On the launch screen, under Play, is a live list of open rooms (and
  matches being played, with who is in them), plus who else is on the menu
  right now. Type a name and press *Join* on a room, or *Create a room* and
  it appears in everyone's list. Tick *Private* to keep a room off the list;
  friends then join with the invite link (or the 4-letter code). The host picks
  the rounds, wind, terrain and any CPU tanks, then starts. Up to six tanks.
  Online play is always volley: everyone plans on their own screen at the
  same time, a banner says who the game is waiting for, and all shells fly
  together once everyone has locked in. Between rounds each player spends skill points
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
- **Napalm** (Advanced, $100 for two) spills burning fuel where it lands. The
  fuel runs downhill over the ground and pools in hollows (`core/napalm.js`:
  a fixed 48-step flow over the heightfield's vertices, the same on every
  copy of an online game). It burns for about 4 s in seven ticks: a tank is
  hurt by how deep the fuel is within 5 m of it, up to 56 in all, credited to
  the shooter. So a tank in a crater or a valley takes the full dose, one on
  the level about 17 from a direct hit, and one on a crest almost nothing.
  Water and open sky swallow the fuel: in a lake it goes out at once. In a
  Rain round it does 65% of its damage. It leaves the ground scorched but
  makes no crater. CPU tanks fire it at a
  target sitting in a hollow (`holeDepth`), rarely at one on a crest.
- **Dirt Bomb** (Standard, $130 for two) bursts into a dome of earth, 20 m
  across the base and 16 m high, the Mound's heap made bigger. A tank with
  2.5 m or more of soil over it (anyone within about 18 m) is **buried**,
  unhurt: it cannot drive or jump, Napalm cannot reach it, and its next shot
  goes off at the muzzle and digs it out instead of flying (the ammo is kept).
  That costs it a turn. A blast that clears the soil off it frees it too. A
  "Buried" tag floats over a buried tank, and the HUD says so. CPU tanks bury
  whoever is hurting them, or the strongest enemy while they are behind, and
  dig themselves out.
- **CPU tanks walk their shots in.** Each keeps an aim memory per target: the
  first shot is a rough guess and the error shrinks with every shot at the same
  target. It grows back when the target or shooter moves or the wind swings.
  Easy stays wild, Normal usually lands on shot 2 to 4, Hard on shot 1 to 2.
  In the rain their first guess already allows for the drag.
- **CPU tanks use the whole arsenal** (`ai.js` `weaponWeights`). Each weighs
  every weapon it holds by the situation: Breacher, Scatter and Roller are
  everyday rounds (a Roller more so at a target below it, Flak against an
  orbiter or a satellite, a Scout at a target it only has a rough fix on);
  a Rangefinder before a long shot (over 180 m) with no reading; a Mound at
  its own feet when it sits in a hole or keeps being hit; a Teleport out of a
  deep hole, a losing fight or a lost position; Napalm at a target in a hollow;
  a Dirt Bomb on whoever is hurting it. Offline it fires Guided
  Missiles too, mostly at targets it has no reading on, and steers them along
  the line to the target as it flies (Hard reacts soonest and finest, Easy
  late and coarse). With a kill on offer it never spends the turn on a
  utility round. Each CPU also has a temper for the match, fixed by the match
  seed: a *gunner* favours the damage rounds, a *sapper* the Roller, Mound,
  Teleport, Dirt Bomb and Napalm (and buys the Mound, Teleport and Dirt Bomb), a *spotter* the Rangefinder, Scout, Guided
  Missile and Survey Satellite, a *skirmisher* the Teleport. Easy CPUs read
  the situation less keenly and sometimes just grab anything; the
  difficulty still sets how well they aim.
- **Aim arc.** While you plan, a dashed line in your colour shows the shell's
  climb from the muzzle to the top of its flight, with this turn's wind and
  any moon's pull, and a ring on the ground under the top says how high and
  how far out it is ("top 98 m up, 199 m out"). The words show only while you
  change the aim and fade 1.5 s after you stop, leaving the dot at the top and
  the ring; the sight never shows them. On level ground a shell comes
  down about twice as far out as its top. It stops short of the landing on
  purpose: that is still yours to judge (or the Rangefinder's).
- **Side view** (Settings > Graphics > Side view; on by default on a phone, off on a
  desktop). A small panel at the top centre draws the planned shot flat, side on, because
  the 3D arc is edge on from behind the tank: the ground along the line of the shot,
  your tank, and the climb to its top (a dot, with a dashed drop and a ring on the
  ground, and the same words as the arc's label). It is the same flight the arc
  draws, from the same simulator (this turn's wind, drag, gravity, the moons and the
  edge rule), and it keeps the arc's honesty: the climb only, never the fall. The
  Tracer perk shows more, exactly as its 3D line does: the flight runs on past the
  top to 45 m of flight when the climb is shorter than that. The ground is drawn
  past the end of the shot (the world shows it anyway) but nothing says where the
  shell comes down. A shot that meets a hillside, a wall or a moon on its way up ends
  in a cross. With Edges on Bounce, the ground and the path fold back at a thin line
  where the shot meets the wall; with Wrap the ground is cut there and the path
  starts again; with Open or Wall the ground stops at the arena's side. Enemies you
  can see and that lie within 22 m of the line show as a coloured tick at their
  range. It is a 2D canvas, redrawn only when the aim, the wind or the round changes,
  and it takes no touches. In the sight it moves under the scoreboard. The numbers
  (tracing, layout, ground sampling, the saved setting) are in `src/sideview.js`, tested in
  `test/sideview.test.js`; the drawing is `src/render/sidepanel.js`. The aim arc itself
  traces through the same `traceFlight`.
- **Angle dials** (Settings > Graphics > Angle dials, on by default). While you aim, two
  thin gauges sit on your own tank so you can read the turret and the barrel
  on the tank itself. A ring lies on the ground round it, hugging the terrain,
  with a tick every 15°, long at 0, 90, 180 and 270 (0 is east, +x, and
  angles grow to the right of your aim, as in the turret readout on the card); an
  amber arrow shows where the turret points, with its reading, and a faint
  white one where your last shot went. A quarter arc stands beside the barrel,
  on the side the camera is on, from 0° level to 90° straight up with a tick
  every 15° (long at 0, 45 and 90), an amber needle for the barrel and a faint
  one for the last shot. Neither dial prints fixed numbers (they crowded the
  tank on a phone): the only numbers are the live readings at the pointer tips.
  The readings are the card's, digit for digit. They fade out in flight, in
  the sight and in the overview. Seen from right behind the barrel, the arc's
  plane would be edge on, so it turns up to 50° toward you. Pure layout and
  the saved setting are in `src/dialmath.js`; the drawing is
  `src/render/dials.js`.
- **Sight** (G, or SIGHT on a phone). The camera rides behind and above your
  turret, looking down its line, so the middle of the screen is where you
  point. A compass tape across the top lines up with the world: bearings
  every 5°, and every enemy you know of at its bearing with its range (pinned
  to an end, with an arrow, when it is off to the side). Under it, the enemy
  nearest your line and how far to turn ("Marlow 488 m · turn 6.7° left"),
  and where your last shot came down from where you stand ("54 m short, 64 m
  right of Marlow"; cleared when you move). Drag anywhere to aim (across
  turns the turret by as much as the view moves, up and down raises the
  barrel). The − / + chip zooms in steps to 2×, 4× and 8× (the wheel or a pinch
  zooms smoothly), looking further down the line the more it magnifies, so
  you can study the far field; the tape goes to single degrees. It stays on
  from turn to turn and hands the camera back while shells fly.
- **Marks over the tanks** say only what the view needs: names alone while
  you plan, health too in the sight, the overview (View) and a Find look,
  faint while the camera follows a shell, and names only in the kill cam.
- **City** (Terrain menu). A town on a gentle grade, laid out new from the
  match seed: a grid of streets round blocks of buildings, towers of up to
  twelve floors in the middle and low shops at the edge, with a park at every
  tank's start so it begins in the open with buildings between it and the
  others. Buildings are real: a shell stops at a wall or roof and goes off
  there. Each building is split into chunks: quadrants (two by two, or two by
  one for a thin one) in bands of one to three floors, each with its own hit
  points. A blast hurts the chunks near it most, and the floors between
  shield the chunks above and below, so a hit on a corner takes that corner,
  a roof shell the top, and a Breacher into the middle of a tall facade
  punches a hole through it with the floors above still standing; shells
  (and the CPUs' shots) go through the gap. What's over a gap stays up while
  a neighbour beside it holds it: up to six floors held on both sides (a
  corner over a lost foot), up to four held on one side by a sound neighbour
  over a hole that still has floors under it. A second hit that wears the
  neighbours down, or a side whose feet are all gone, drops what hung: it
  falls off into the street and leaves a little heap of rubble there. A small
  shop loses a corner to a Shell and comes down at the second or third.
  Once three of the four ground quadrants are gone, or under two fifths of
  the building is left, the whole building comes down into a heap of
  rubble, a mound in the ground that shells then pass over. Tanks can't drive
  or jump through a standing building, but a damaged one is only its standing
  chunks to them: a tank can drive into a blown-out corner or under the
  floors hanging over a ground-floor gap, where it fits. The CPUs, the aim arc and the Survey
  Satellite all see them (`core/city.js`, through `groundContact` in
  `ballistics.js`). Cars, buses and trucks keep to their lanes and wait at
  junctions; a blast near one wrecks and burns it and the rest flee or turn
  round (`core/traffic.js`, cosmetic, so not part of a snapshot). The state of
  every building is in `snapshot()` and the ground's ops, so online screens
  agree. A quiet hum of traffic and a far-off horn play there.
- **Floating isles** (Terrain menu). Instead of one stretch of ground, a dozen
  or so isles hang in open space, each with grass on top and rock beneath. Every
  tank starts on an isle of its own. Two or three small moons hang among them and pull
  on every shell that passes (gravity that falls off with distance, so a shell
  near a moon swings round it, and one that hits a moon is spent there). While a moon pulls a shell by more
  than about an eighth of ordinary gravity, thin violet-and-cyan flux lines
  fade in around it, with a few curving to the shell itself, and fade out again
  once it is clear. Shots
  can come at an isle from below: a blast in the underside eats upward, and once
  the rock between top and underside is gone the ground is open sky. The
  orbit camera keeps 4 m clear of the ground: over an isle's top, or under its
  underside when you take it below (`src/camlimit.js`). A tank
  over a hole falls, and a tank that falls into the void is lost (the kill goes
  to whoever blew the ground out). Now and then a strange craft or two drifts
  high across the sky, pausing to hover, where birds would be. A shell that misses everything drops away into the void. You
  cannot drive or jump off an isle's edge. There are no lakes, and the sky is
  deep space: stars all round, a nebula and a ringed planet. Relics stand on
  the isles (`core/artifacts.js`, drawn by `render/artifactMesh.js`): derelict
  dishes, monoliths and obelisks with faint glowing glyphs, crystal clusters,
  broken arches and ring ruins, now and then a crashed hull, and loose rocks
  drift round the bigger isles. They are placed from the seed, never on a tank's
  pad, and are only set dressing: shells pass through them and they hurt no one.
  A blast on one destroys it, one close by knocks a tall one over, and one that
  blows the ground out from under it drops it into the void.
- **Ridgeline** (Terrain menu, `?terrain=ridgeline`). A thin slice of mountains
  seen side on: the tanks stand in a row from west to east along a narrow band
  of land, and past the band the ground falls away in steep flanks to a dark
  low floor, like a cross-section of the range. Between the tanks are spiky
  peaks, deep valleys and a few flat-topped mesas, so nearly every shot is a lob
  over a peak (`core/ridgeline.js`). Each peak stays under a 1 in 2 slope from
  the tanks on either side, so a high arc always has a way over. The row is
  different every round: uneven gaps, shifted toward one end of the field, off
  the middle of the band in z, and now and then a tank up on a ledge. The rock
  is loose: blasts dig wider and deeper craters (`RIDGE.crater`, tank damage is
  unchanged) and then the ground slides, so craters soften and a peak a blast
  undercuts sags to the angle of repose (`RIDGE.repose`, `slump`). The slump is
  a fixed local pass with no randomness, replayed from the ground ops like a
  crater, so every copy of the game gets the same ground. The ground is
  smooth sandstone in five broad, soft strata (`render/ridgeline.js`: rust,
  warm sandstone, a cream band, terracotta, pale cap rock, with gently wavy
  edges and no colour noise). Steep faces show the beds; flat tops and ledges
  lie under pale dust, and ground a blast cut or heaped, with the slopes that
  slumped from it, reads as lighter loose sand. Far rock fades into the haze and
  the low floor clears into the horizon in a gradient, and the sky follows the
  palette by time of day (warm haze by day, peach at dawn, deep orange at dusk,
  cool at night). The field's edges are cut-away cliff faces. No clouds, a few
  boulders and nothing else: no grass, trees, water or villages. The overview
  (View) stands back side on.
- **Island** (Terrain menu, `?terrain=island`). One big island in an open sea
  that fills the field, a new shape from the seed every round
  (`core/island.js`): a ragged coast with two or three bays and a headland or
  two, often a small islet offshore, sandy beaches at the waterline rising to
  hills inland, and the meadow's trees, hamlets, farms and roads on the dry
  land. The sea runs on past the field to the horizon (`render/arena.js`). The
  tanks start spread round the island part way in from the coast, every pad
  at least 4 m above the water. A shell that comes down in the sea is lost
  there with a splash: no crater, no damage, nothing for a Teleport to land on.
  The coast crumbles: a blast slumps the low ground round it (anything under
  3 m above the sea, out to about one and a half blast radii), so a beach that
  is shelled goes under and the sea comes in. A tank whose ground ends up more
  than 0.8 m under the water sinks and is lost, the kill going to whoever blew
  the ground away, as with the isles' void. The CPUs, the aim arc and the
  satellite see the sea as a miss (`groundContact` in `ballistics.js`).
- **Arena edges** (Custom match > Edges, `?edges=`; every world). What a shell
  does at the square's sides, which reach from the void to the sky (the floor
  is never a wall): **Open** (the default and the old game) lets it fly off;
  **Wall** sets it off where it meets the wall, with a blast but no roll or
  shrapnel; **Bounce** mirrors it back in, keeping 80% of its speed; **Wrap**
  takes it out of one side and in at the opposite one at the same height with
  the same velocity; **Random** rolls one of the four each round from the seed,
  and the round banner names it ("Bouncing edges"). The rule is on the terrain
  (`terrain.edge`) and applied in `stepProjectile` (`crossEdge` in
  `ballistics.js`), so the live shell, the CPUs' `simulateShot`, the Survey
  Satellite, the aim arc, the Tracer perk and the kill cam all fly the same
  path. Rollers bounce or wrap too; under Open and Wall they stop at the edge
  as before. On the Floating isles the walls are the same square's sides and a
  shell that drops below the isles is still lost to the void; on the Ridgeline
  a shell that wraps can come in low on the far side and strike that cliff
  face. A faint curtain of light stands along each side for Wall (amber, drawn with
  ordinary blending so it stays amber on a bright sky; a slow
  breath), Bounce (cyan, rising bands) and Wrap (violet, bands that run along
  it), with a flash where a shell bounces and a ripple where it goes out and
  comes back in (`render/arena.js`); the aim arc and the shell's trail break
  where it wraps, so no line crosses the map. The CPUs treat a shot that meets
  the edge as too long and take power off, so they don't plan trick shots.
- **Mods: deployable equipment** (`core/mods.js`). Mods are not weapons:
  they come from the **skill tree** between rounds. Each mod is a branch:
  rank 1 (Orbital Mechanic, Sat Recon, Smoke and Mirrors, Close-In Gunner)
  gives you one at level 1, ranks 2 and 3 (Tighter Orbit, Sharper Optics, Hard
  Light, Twin Feeds) raise it. Unticking a mod's ranks under Custom match > Perks turns it off; `?sat=` and `?orbiter=` hand
  everyone one for testing (see Testing query params). A mod you own is *ready*.
  Deploying it is your whole turn: on a phone, tap its button at the top of
  the Fire column (ORB / SAT / DCY / PD) and tap again to confirm; on a desktop press B
  twice, or use the button in the player card. In a volley, deploying is the
  action you lock in, and it goes up when the volley fires. Once up, a mod
  has hit points and a lifetime counted in your turns, and it stays up
  across rounds (it moves with you to your new spot) until it is shot down
  or wears out. Then a new one is ready on your next turn (or next volley):
  putting it back up costs that turn, which is the whole price of losing one.
  A mod lost with its tank comes back next round. Small chips in the player
  card show each mod's level, health and turns left. Shells can hit a mod
  directly, blasts hurt any mod in reach, and **Flak** is the anti-air
  answer: it also bursts by an enemy mod and its burst hurts every enemy mod
  near it. Shooting one down pays 60. CPU tanks like the orbiter ranks in the
  skill tree, and take the satellite ones as any other (spotters favour
  them). Each Normal or
  Hard CPU has its own way of timing the deploy for the match: some put it up
  at once, some fire a ranging shot first and deploy while their aim is still
  off, some wait until they are hurt.
- **Gravity Orbiter** (mod; from perks; lasts 6, 7 or 8 turns; 30 to 50 hp). Small
  gravity wells circle your tank about 13 m out and 9 m up, and bend every
  enemy shell that passes near (your own shells fly through them). A shell that
  hits an orb is spent there and hurts it. Level 1 is one well, level 2 a
  stronger, faster one, level 3 a binary pair that spins round itself as it
  orbits, which scrambles shots rather than blocking them. The wells' places
  are a pure function of the match clock, which only runs while shells fly,
  so every screen agrees on them. A Survey Satellite at level 2+ counts the
  wells in exactly. CPU tanks other than Easy count them in too, but misread
  them (where the wells will be, how hard they pull) and their shots scatter
  more, the higher the orbiter's level: against a level 3 orbiter a Normal
  CPU lands about half as many hits as against a bare tank, a Hard one about
  two thirds. Easy CPUs fire as if the wells were not there.
- **Survey Satellite** (mod; from perks). Deploy it and it goes
  up 70 m over your tank, where it stays (a battery of 5, 6 or 7 turns, 20 to 30 hp) until
  shot down or spent; Flak or a direct hit brings it down. While it
  is up and you plan, it shines its beam down on the enemy nearest your
  turret line (as you know it, under fog of war; with none known, over the
  ground your aim reaches) and its projector paints a patch of Voronoi cells
  on the ground, about 160 m across, that drifts slowly round it with a
  radar-like sweep. The cell sites are fixed to the ground for the round, so
  the patch slides over them. A share of them are ringed and labelled with
  the turret and power that land there from where you stand, at your current
  elevation (a legend by the satellite says which elevation and whether wind
  is in). The aims are solved with the same simulator the shells fly on, and
  solved again when you move, change elevation, the wind turns or the ground
  is cratered (the old labels dim until then). Level 1 leaves the wind and
  moons out, level 2 counts them and enemy orbiters, level 3 labels more cells. At most 5
  labels on a phone and 8 on a desktop, nearest the middle, never on top of
  each other, fading with distance. Only the planner on this screen sees it,
  only on their own aim. CPU tanks take it in the skill tree (spotters most). A CPU puts its
  satellite up when it has no reading on a target over 150 m off (Easy only
  now and then), and while it is up its first shots carry less of their
  error: a third less at level 1 (less still in the wind), more at levels 2
  and 3. Easy reads it about half as well.
- **Decoy Beacon** (mod, family *deception*; from perks; 20 hp, 35 from
  level 2; lasts 4 or 5 turns, never past the round). Deploying it is aimed:
  arm it (DCY on a phone, B on a desktop), aim, and Fire (it reads BLINK)
  sends a hidden blink round. Your tank warps to where it lands, and a decoy
  stays where you stood: a tank-sized target that takes shells and blasts
  (your own fire passes it by) and fizzles when its hit points run out. You
  see it as a flickering hologram tagged "decoy"; enemies see a tank with
  your name over it, and from level 2 that label shows your real hit points.
  At level 3 it goes off when it fizzles: a 25-damage, 10 m blast credited
  to you. A blink that is lost (off the field, into the void) spends the
  turn and leaves the decoy ready. In a volley the blink's aim is part of
  the plan (`{ deploy: 'decoy', yaw, elev, power }`), so every screen plays
  it the same. CPUs fall for it some of the time (Easy often, Hard rarely,
  less against a level 1 decoy), on the seeded rng: they aim, range and
  remember at the decoy as if it were you. A CPU hit from 60 m or more
  blinks away with its decoy (Easy only half the time), a shorter hop than
  a Teleport.
- **Point Defense** (mod, family *defense*; from perks; 25 to 35 hp; lasts
  5, 6 or 7 turns). A turret beside your tank shoots down the first enemy
  shell coming down within its reach of you: an air burst, no crater, no
  damage. Level 1 reaches 18 m with one charge a round, level 2 two charges,
  level 3 reaches 26 m and stops fragments too (Scatter's bomblets,
  Shrapnel, Flak's pieces); below level 3 fragments get through. Charges
  refill every round. It never touches Rollers or Flak, your own shells, or
  a shell still climbing. Blasts hurt it; Flak's air burst does not (it sits
  on the ground). CPUs that see it reach for Scatter, Flak and Rollers over
  single heavy shells, and put their own up against an enemy carrying
  Breachers or Guided Missiles, or once they are being hit.
- **Jammer Drone** (mod, family *jamming*; from perks; 20, 25 or 30 hp;
  lasts 4, 5 or 6 turns). Deploying it takes your turn (JAM on a phone, B on
  a desktop: armed, the banner names the tank): a drone flies to hover 13 m
  over the enemy your turret points nearest, 11 m off toward you (higher
  where the ground rises), and follows that tank as it drives. In a volley
  the target is part of the plan (`{ deploy: 'jammer', target }`). The tank
  under it is **Jammed** (a JAM badge by its name where health shows, a
  pulse ring on the ground, a JAMMED chip and a banner for its player):
  - its Survey Satellite labels go dark (and a CPU loses the satellite's help);
  - its Guided Missiles fly as fired, with no steering ("Jammed" on the hint);
  - from level 2 its aim arc, side view and Tracer line are blank ("Jammed")
    and a jammed CPU aims with 1.3 times its usual error;
  - at level 3 every enemy of yours within 40 m of the drone is jammed too.
  It is a thing in the sky, so **Flak** brings it down (its 45-damage air
  burst). **Defense beats it**: an enemy Point Defense with a charge left
  shoots it down the moment it is in reach (spending the charge; Point
  Defense on the tank it jams reaches it unless the ground lifts it high),
  and an enemy Gravity Orbiter within 20 m grinds it, 8, 10 or 12 damage (by the orbiter's level) at the
  start of each of its target's turns (each volley). If its target dies it
  moves over the nearest enemy left. Normal and Hard CPUs send theirs over
  the nearest enemy they can see with a satellite up (not into Point
  Defense with a charge, nor one they jam already; Easy only now and then),
  and a jammed Hard CPU with Flak shoots the drone down (a Normal one when
  the jamming costs it: from level 2, or with a satellite up or Guided
  Missiles to steer).
- **Statuses.** Jammed is the first status effect: `p.status` holds
  `{ kind, source, strength, turns }` (the tank whose mod put it there, that
  mod's level and turns left). The game works statuses out again from the
  mods up at fixed points (round start, each turn and volley, a mod going up,
  down or wearing out), so they travel in snapshots and every screen agrees.
- **Two mod bays.** A tank holds at most two mods (`MOD_BAYS` in
  `core/mods.js`): once you own two, the other mod branches of the
  skill tree are shut, and only the two you have go deeper.
- **Mod rules in the config.** The old Lab menu is gone; the core still
  reads `lab` in the match config (`satellite` / `orbiter` / `decoy` /
  `pointdef` / `jammer`: `perk`, `shop`, `all` or `off`, with a level, and the
  satellite's `labels`), so old configs and tests keep working. The launch
  screen only ever sends `perk` (or `all` from `?sat=` / `?orbiter=` /
  `?decoy=` / `?pointdef=` / `?jammer=`), with labels `some` unless `?labels=` says
  otherwise. An old saved Custom with the Lab Off unticks that mod's cards.
- **Settlements round the tanks.** Most tanks have a settlement somewhere
  around them, between about 20 m and 120 m off: a hamlet, a farm (a barn with
  its silo and a farmhouse, sometimes a windmill), or a lone watchtower or
  windmill. A few more hamlets and farms sit out in the open.
- **Buildings break in stages.** Each building has hit points (a silo is the
  frailest, a barn the toughest). A blast takes off more the closer it lands,
  and so does ground dug out from under it. A building leans away from each
  blast a little more, up to about 8°. Below about two thirds of its hit points
  it breaks open on the side the first blow came from: walls knocked through,
  roof fallen in, a windmill's top and sails down, a silo's dome knocked off.
  At none it falls to a ruin, and a ruin hit squarely is cleared away. A shell
  ruins a house within about 10 m and breaks it open out to about 16 m. Windmill
  sails turn until the mill is hit.
- **Scenery is cosmetic.** Trees, bushes, rocks, buildings, a bridge, villagers
  and sheep never block shells (a standing building does stop a driving tank).
  Blasts flatten trees and bushes, wear buildings down, drop the bridge and
  scatter people and sheep. Whatever survives is re-seated on the new ground,
  and props that end up buried or under water are removed. Ground dug below the
  water level floods.
- **Between rounds: Results, Skills, Armory.** A stepper at the top of each
  screen shows where you are. Results list each tank's pay by where it came
  from: a $150 stipend, $80 for surviving, $300 for the win, $2 a point of
  damage really taken off (no pay for overkill), $150 a kill, $60 a mod shot down. Then each human spends skill points and shops
  in turn (the panel names whose turn it is and who is next); CPU tanks do
  both for themselves. A "Your kit" strip shows what you hold.
- **Armory.** Weapons come in tiers: the **Kit** (Shells, free and unlimited),
  **Standard** (in stock from the first visit) and **Advanced** (Scatter,
  Teleport, Napalm and the Thunderhead, from the second visit; a two-round match
  sells everything on its only one). Every tank starts with Shells,
  1 Guided Missile (not online), 1 Breacher, 1 Roller, 1 Mound,
  2 Rangefinders and 1 Jump Jet charge. A damage weapon costs $0.50 to $1.40 a
  shot for each point a good shot deals (`test/economy.test.js`). Gear is
  armor, fuel and jump jets. Mods and their levels come from the skill tree,
  not the armory; a tank has two mod bays. `src/armory.js` builds these screens.
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
- **Skill tree.** After every round each tank gets a skill point and spends
  it on the next rank of any branch (Orbital Mechanic, Sat Recon, Firepower,
  Hull, Gunnery, Supply, Chassis, Mod Tuning; `src/core/skills.js`), from the
  perks ticked under Custom match > Perks (none ticked: no skill tree). Ranks
  go in order and last the whole match; unspent points carry over. CPU tanks
  spend theirs at once. The screen has three tabs: **Weapons** (the weapon
  variants, below), **Mods** and **Tank** (Firepower, Hull, Gunnery, Supply,
  Chassis). In hotseat each human gets their own skills and
  armory in turn, with the hand-off named
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
  | Streamlined Shells | rain drags your shells half as much (only offered when the match can roll Rain) |
  | Shrapnel | plain Shells throw two bomblets onward from where they land |
  | Tracer Rounds | see the first 45 m of your shot while you aim |
  | Orbital Mechanic | gain a Gravity Orbiter at level 1 (only offered if you have none) |
  | Tighter Orbit | your Gravity Orbiter goes up a level (taken up to twice) |
  | Sat Recon | gain a Survey Satellite at level 1 (only offered if you have none) |
  | Sharper Optics | your Survey Satellite goes up a level (taken up to twice) |
  | Smoke and Mirrors | gain a Decoy Beacon at level 1 (only offered if you have none and a free mod bay) |
  | Hard Light | your Decoy Beacon goes up a level (taken up to twice) |
  | Close-In Gunner | gain Point Defense at level 1 (only offered if you have none and a free mod bay) |
  | Twin Feeds | your Point Defense goes up a level (taken up to twice) |
  | Signal Spoiler | gain a Jammer Drone at level 1 (only offered if you have none and a free mod bay) |
  | Wideband | your Jammer Drone goes up a level (taken up to twice) |
  | Long-Life Cells | your mods last 2 turns longer and take 25% more damage (only if you own one) |
| Double Strike | from round 3 on: queue two shots in one turn (see below) |

- **Weapon variants** (`variants` in `src/core/weapons.js`). Five weapons
  have a branch of their own in the skill tree, shown only when that weapon
  is in the match. Rank 1 is a fork: two buttons, and taking one shuts the
  other for the match. Rank 2 upgrades whichever you took. Each costs a skill
  point. The weapon keeps its price and its place in the rack, and its name
  shows the variant ("Napalm · Sticky") on the weapon bar, the aim card, the
  kit strip and the armory card. A variant is a trade, never a straight
  upgrade, and each passes the armory's price yardstick
  (`test/economy.test.js`). CPU tanks pick by temper: gunners and skirmishers
  take the bold side, sappers and spotters the careful one, three times in four.

  | Weapon | Careful | Bold | Rank 2 |
  | --- | --- | --- | --- |
  | Breacher (22 m, 70) | **Bunker Buster**: 19 m, 70, digs half again as deep; a tank that is buried, or lower than the blast, is hit by the distance across, so a buried or dug-in tank takes it all | **Splitter**: 18 m, 55, and three bomblets (9 m, 22) thrown out in a star | Wider Charge: blast 15% wider |
  | Scatter (5 × 28, in a tight row across the line of flight) | **Line**: the five shells land in a longer row along the line of flight, for a shot long or short | **Ring**: five bigger shells (12 m, 30) in an even ring round the aim point; none lands in the middle, so a tank dead centre takes only the edges of the five blasts | Sixth Shell |
  | Roller (14 m, 55) | **Seeker**: leans toward the nearest enemy tank within 50 m as it rolls; 12 m, 46 | **Hopper**: hops once over a bump (0.4 to 8 m high) in its path and rolls on; 14 m, 53 | Long Roll: rolls half as far again |
  | Napalm (56) | **Sticky**: thick, runs about half as far and lies deeper, burns 11 ticks (about 5 s) for up to 56: the better pick on open ground | **Flood**: more and thinner fuel that runs about half as far again and spreads wide, five ticks for up to 60, and it pools: the better pick at a tank in a hollow | Wet Burn: burns through rain and over water up to 1.5 m deep |
  | Thunderhead (30 m, 95) | **Deep Strike**: 25 m, 104, a deeper crater | **Airburst**: goes off 8 m over the ground (`ballistics.burstNow`), 30 m and 90 by the distance across, no crater, so it hits a tank under a Dirt Bomb's dome in full | Wider Charge: blast 15% wider |

  The choice is a perk id like `napalm:sticky` (`VARIANT_PERKS` in
  `src/core/perks.js`), so it travels in snapshots and online like any rank.
  `game.weaponOf(player, id)` gives the weapon as that tank fires it (base,
  then the variant's patch, then the upgrade), and every shot, the CPUs'
  solver and the kill cam read their numbers from it. Napalm's variants
  change the flow's numbers (`napalmParams`); the spill's ground op keeps
  them, so a rebuilt ground matches.

- **Double Strike** (the last Gunnery rank, open from round 3). On a turn, or
  a go at planning a volley, press ×2 (X; on a phone the ×2 button just above
  Fire) to arm it. Fire then queues your aim as shot 1 ("Shot 1 of 2 queued"),
  you aim shot 2, and Fire again sends both (in a volley, locks both in): the
  second leaves 0.45 s of flight after the first. Each shot has its own aim and
  weapon and spends its own ammo. The price: your next turn (or volley) is move
  only. You can drive, turn and jump, but Fire passes ("Reloading: move only,
  fire passes"). Arming is optional, and ×2 again drops a queued shot 1. Online,
  both shots travel in the one plan and a reload goes as an empty plan. CPU tanks
  that hold it double when they have the range on a target or can finish it, and
  sit out the reload. A reload does not carry into the next round.
- **The boss match** (Custom match > Match > **Boss: two against one**, or
  `?boss=1` with Play; `src/core/boss.js`). You and an ally (the next tank
  row: a CPU, or a second human on this screen) are one team against the
  **Bulwark**, one round in a walled meadow. The Bulwark is half as large
  again as a tank, has 370 hp, and sits on a flat-topped fort at the east end
  with two lower ledges; you start side by side at the west end with 40 armor,
  three extra jump jets, a little more ammunition and the Thunderhead's
  Airburst. Its health bar is top centre, with ticks where its phases begin:
  1. **Full to 60%:** Scatter and Breacher at either of you, Point Defense up
     (one charge, refilled every turn).
  2. **60% to 25%:** a Gravity Orbiter goes up, it hops between its ledges
     every other turn, and every third turn it answers whoever has hurt it
     most with a Dirt Bomb.
  3. **Under 25%:** two shots every turn, and once a Thunderhead.

  A Dirt Bomb or a Thunderhead is **marked a turn ahead**: a red ring the
  size of the blast and a column of light where it will fall, and a line
  under the health bar ("Thunderhead locked on Tester"; on a phone also the
  touch note, and a buzz when it is on you). The shot goes to the marked
  spot, so drive or hop out of the ring; CPU allies do. Its **weak spot** is
  on top: a hit from above does 25% more. From above means an Airburst, or a
  shell or fragment coming down at least 60 degrees below the horizontal
  (a high lob; not Flak's fragments, which always fall steeply); the bar
  flashes when one lands. The fort is drawn so its levels read: a slate deck
  with a crenelled rim, paler ledge tops with lamp posts and bollards, and
  dark steep faces (colour and props only; the heights are the core's). A banner
  announces each phase. **Teams:** allies are never a CPU's target, an ally's
  mods let your shells by, and hitting your ally still hurts but earns
  nothing. The round ends when one side is wiped out, and every tank left on
  that side wins it. The match-over screen says "Allies win" or "The Bulwark
  wins" and lists the allies by damage dealt to the boss (not wins or funds),
  then the boss (`bossStandings` in `core/boss.js`). Online, the room's tanks are the Bulwark's foes and it
  joins as the last CPU; it runs on every screen like any CPU.
- **The run** (**Run** on the launch screen, under Play; `src/core/run.js`,
  on screen `src/runui.js`). A short solo campaign against CPUs across a map
  of stops, ending at the Bulwark. The map comes from the run's seed: six
  tiers of two or three stops, joined by paths that never cross, then the
  boss, so every route is seven stops. Tap a lit stop to see its world, wind,
  edges, time of day, modifier, foes and reward, then **Go**. Stops:
  - **Fight:** one or two CPUs, one round (two from the third tier on).
    Easy CPUs in the first tier, then Normal, then Hard; from the third tier
    they hold a rank or two. Reward: $60 rising by $30 a tier, and half the
    time a weapon or two.
  - **Elite:** one Hard CPU with Point Defense or a Gravity Orbiter already up
    (level 2 in the last two tiers). Reward: $150 + $50 a tier, ammo and a
    skill point.
  - **Cache:** take one of three: a skill point, a crate of ammo, or money
    ($150 + $40 a tier).
  - **Depot:** the armory (the round-2 prices), and you may turn one weapon's
    variant the other way (its upgrade stays), once a depot.
  - **Event** (a signpost icon; tiers 2, 3 and 5, about one and a
    half a map): no fight. A short scene from the field and two or three
    choices, each a trade with its effects listed on the button, then a
    small card saying what changed. Seven events (`EVENTS` in `core/run.js`):
    *Wrecked supply crawler* (salvage the cargo: the stop's crate, but the next
    fight's CPUs start with +25 armor / strip its plating: +20 armor for you /
    leave it), *A crew offers a trade* (pay $200 for a skill point / pay $80
    for a crate / walk on), *Storm front* (the next fight is Rain and pays
    double / wait it out), *Hull yard* (pay $300 to patch a spare hull /
    sell a spare for $250 / move on), *Shell game* (stake $100 to win $250:
    the stop's own luck decides, so reloading changes nothing / walk on),
    *Fallen relay* (+2 jump jet charges / +40 m of fuel next fight / +1
    skill point, and the next wind is at least a Gale) and *Bounty board*
    (+$150 on the next win but a Gale at least / +$60 on the next win /
    leave it). A choice you cannot afford is greyed with why. The crate and
    the wager's luck are rolled with the map, so they are the same every time
    the run is opened; each event comes at most once a map. What an event
    leaves on the next fight (`next` in the run's state: a forced round
    modifier, the pay factor, a wind floor, foes' armor, a win bonus) goes
    through the match config the run already builds, shows on the stops'
    cards and the map ("From the road: Rain, forced · Pays double") and is
    used up by the next fight, won or lost. Armor and fuel for you go into
    the kit's own `pendingArmor` / `pendingFuel`.
  - **Boss:** the boss match, you and an ally against the Bulwark. The ally is
    one of the tanks you beat: pick from two (the strongest, and the latest
    other) if you beat two or more; it keeps its ranks. Its card shows the
    Bulwark's health, its phases and its weak spot, and each ally's ranks.
    Beating it ends the run (no reward or point: nothing is left to spend
    them on).

  **Money is a choice.** A run's fight pays a fifth of a usual match's money
  (the stipend, survival, the round win, damage and kills, all ×0.2: Game's
  `pay`), on top of the stop's reward, and the result card shows both. A
  two-round fight's CPUs start with $250 for the shop between its rounds,
  the round-one pay the cut takes from them. A run reaches a Depot with
  about $550 to $800, against about $1,870 for one of everything in the
  armory. `node tools/runsim.mjs` plays whole runs headlessly with a CPU in
  your seat and prints the money at each stop (`--old` for the rules before
  this, `--hoard` to skip shopping between rounds).

  The map's header shows how far along you are ("Stop 3 of 7 · Badlands",
  "3/7" in portrait). Every fight won gives a skill point; spend points from the map (**Skills**,
  the same tree as between rounds; the ranks last the whole run). Your money,
  ammo, jets, ranks (variants and mod levels too) and unspent points carry
  from fight to fight; health is whole again for each one. The run starts with
  the usual kit, $150 and a point. A fight lost costs one of your **two spare
  hulls** and moves you on with no reward; with none left the run is over. A
  lost boss fight may be tried again while a hull is left, from the kit you
  brought to it. The run is saved in the browser after every step
  (`localStorage`, `craterfall.run.v1`): **Continue run** picks it up, and
  **Abandon** (tap twice) throws it away. A match left by closing the page is
  played again from the start, and says so: the save marks a fight as
  started (`fighting`), so **Continue run** reads "its fight starts over" and
  the stop's card offers **Start the fight over**.

  **The map has some character**, in plain SVG and CSS (nothing moves but a
  pulse): each stop sits on a patch of faint contour lines tinted by its world
  (green rolling, olive hilly, grey mountains with tight lines, blue grid for
  the city, cyan isles, rust ridges, teal island; the boss's ground is red),
  the route you have walked is a solid track with tread marks across it, a stop
  you can go to has a soft ring that swells and fades (off under reduced
  motion), and the boss is a small fort with a flag. **Rewards show what they
  are**: an icon per kind (a coin for money, a crate of shells for ammo, a star
  for a skill point), on the stops' cards, the result card and the Cache's
  three cards. A crate lists its weapons by name (and how many you hold)
  before you pick it. A Depot's variant swap reads "You have Sticky" beside an
  arrow and "Switch to Flood", each with its line, and the Leave button stays
  at the foot of the screen.

  **The run's summary** (shown when it ends) has four tallies (fights won of
  tried, damage dealt, damage taken over the run, spare hulls left; **Last
  run** under Run on the launch screen opens it again, kept in
  `craterfall.lastrun.v1`), the
  route as a small copy of the map with a tick or a cross on each fight, a row
  per stop (the world and the foes, the damage in that fight, or what a Cache
  gave), the final build (variants, mods, ranks, unspent points, money and
  ammo), and **New run** beside the way back to the menu. The damage totals
  are kept in the run's state (`stats`, plus `dealt` and `taken` on each
  fight's log line); a save from before them loads with zeros. A save from
  before Events has no `mapv`: it keeps its old map (`mapv` 1, no Events), and
  a new run is `mapv` 2.
- **Round modifiers.** Each round rolls one (from those ticked under Custom match) and announces it on
  the round banner; it applies to everyone alike. Clear skies (nothing, twice
  as likely as the others), Gale (the wind ×1.8, at most 3.5, so a Gale round on Gale wind stays playable), Dead calm, Low gravity,
  Rain (air drag on every shell: a power 60 shot at 45 degrees lands about 16%
  short, long lobs lose more and flat shots less, so add power and aim
  flatter), Soft ground (craters a third bigger), Gold rush (double pay) and
  Full tanks (double fuel). The same one never comes up twice in a row. CPU
  tanks, the aim arc and the Survey Satellite all fly with the round's
  gravity, wind and drag. Rain falls around the camera (fewer drops on Light),
  greys the sky and the fog, puts crater fires out sooner and hisses softly; a
  pack sound picked for the Rain event in the pack review replaces the hiss.
- **Daylight and life.** The sun moves from late morning to a golden late
  afternoon over the match (never night). Clouds drift with the wind and dim
  the ground beneath them, small flocks circle and scatter from blasts and
  passing shells, villagers walk and sheep hop.
- **Sound** is mostly synthesised: a wind bed that follows the wind, a
  bird chirp or a bleat now and then (quieter with distance), a layered
  cannon, a whistle as a shell comes down, blasts that arrive later and
  duller from far away, and an engine hum while a tank drives. A handful of
  small CC0 Kenney samples (`sfx/`, `.ogg` with an `.mp3` fallback, about 120 KB
  for the lot; credits in `CREDITS.md`) sit on top, all under the Effects level
  and mute, and nothing plays before the first tap:
  - *Run screens* (`runui.js` gets an `sfx` handle): a soft switch on a stop, a
    confirm on Go, then the rewards one after another (coins, a latch for
    ammo, a rising chime for a skill point; the same on a Cache pick), a
    heavy clank for a lost hull, and a short sting when the run is won or over.
  - *Boss*: a low bell on a phase change, a tone when it marks a target (louder
    when it is you), a bright ping on a weak-spot hit.
  - *Mods*: a rising whoosh on deploy, a clatter when one is shot down, a
    laser zip for a Point Defense intercept, a soft zap when the decoy's blink
    is armed (its owner only), and a very quiet hum that swells as the camera
    nears a Gravity Orbiter.
  - *Flak* bursts with a small crack and its fragments land as a run of tiny
    ticks; *Scatter* (Line and Ring too) and the Splitter pop at the split and
    their children then land as quick separate thuds, a few hundredths of a
    second apart, not as one big blast each.
  - *Buttons* on the menu, armory and skills tap very lightly (the same
    `click` as before, now a sample).
  Which event plays which cue is `src/sfxmap.js` (pure, tested); `Sound.cue`
  in `src/audio.js` plays it, with a synthesised stand-in for the moments
  before the samples have loaded. The pack review can still replace `click`
  like any event it lists; the new cues have no review slot yet.
- **Music** is synthesised too: a small step sequencer plays one of four
  tracks, picked on the menu (Music, with its own level) or with N in a
  match: *Outpost* (calm pads and plucks), *Artillery March* (snare rolls and
  brass), *Bunker Lo-fi* (swung keys and crackle) and *Barrage* (chiptune).
  The choice is remembered. The kill cam muffles it along with the slow motion.

## Layout

- `src/core/` holds the pure game logic with no DOM or three.js: the heightfield and
  crater maths, the fixed-step ballistics simulator and roller, weapons, the AI
  aim solver and aim memory, driving (`driveStep` in `tank.js`), perks and round
  modifiers as plain data (`perks.js`), road and path routing (`paths.js`), the Survey
  Satellite's sites, solving and levels (`survey.js`), scenery placement and its reaction to
  terrain changes, the City's buildings (`city.js`) and traffic (`traffic.js`),
  the Island's coast and sea (`island.js`), and the `Game` state machine. It emits events and runs headless.
- `src/render/` holds the terrain mesh (partial updates per crater, roads painted
  through a mask texture), tank models,
  effects (blasts that land together, as a Scatter Ring's five, each leave a ring on
  the ground for a moment so the separate impacts read), the instanced scenery and water (`sceneryMesh.js`, with the isles' relics
  in `artifactMesh.js`), the Ridgeline's strata (`ridgeline.js`), the sky, sun and
  clouds (`sky.js`, with the space sky of the floating isles, greyed in a Rain round; the time-of-day presets in `timeofday.js`),
  the falling rain (`rain.js`), the isles' moons
  (`moons.js`), the flux lines that show a moon or an orbiter pulling a shell
  (`gravityLines.js`, driven by the pure `core/gravityPull.js`), the flocks
  (`birds.js`), the isles' passing craft (`craft.js`), the Survey Satellite's
  projected cell patch and labels (`satellite.js`) and the deployed mods:
  orbiter orbs with their trails, satellites, break-ups (`mods.js`), and the
  mods on the ground: the decoy (a hologram to its owner, a tank to everyone
  else) and the Point Defense turret with its tracers (`groundmods.js`), the
  Jammer Drone and the pulse ring on the tank it jams (`jammer.js`), and the
  City (`cityMesh.js`: merged buildings with canvas window textures, rooftops,
  damage and rubble, instanced street lights and traffic; its streets are
  painted by `terrainMesh.js`). An intact building is one box; once it loses
  a chunk it is redrawn chunk by chunk, with the inside, broken floor slabs
  and ragged wall ends showing, and only buildings that changed are rebuilt.
  `cityFx.js` is the wreckage in motion, for show only: pooled debris blocks
  that fly, bounce, settle and sink (one InstancedMesh), chunks that topple
  into the street, and whole buildings that drop and crumble into their rubble.
  `arena.js` is the arena's boundary: the Edges curtains, bounce flashes and
  wrap ripples, the Island's open sea (the field's own water material, so the
  two meet without a seam) and splashes. `bossMark.js` is the
  boss's telegraph: the ring and column of light on the marked spot.
  `bulwarkMesh.js` is the Bulwark's own model (a TankMesh with its own build:
  broad dark-steel hull, armour skirts with amber hems, a squat turret, twin
  barrels ending in one muzzle block, a sensor mast whose amber beacon pulses
  faster each phase; about eighteen draw calls). `fortMesh.js` is the fort's
  props, drawn only (crenels, bollards, lamp posts; one instanced mesh each).
- `src/armory.js` is the between-rounds screens (stepper, results, skill tree, kit, armory);
  `src/modsui.js` is the mods' deploy buttons and status chips;
  `src/strike.js` is Double Strike's; `src/bossui.js` is the boss match's
  health bar, telegraph line and phase banners (the rules: `src/core/boss.js`).
  `src/runui.js` (with `css/run.css`) is the run's screen: the map, the
  stops' views, the result card and the summary (the rules: `src/core/run.js`).
- `src/camera.js` is the camera rig: the camera, its orbit controls and what
  moves them in each mode (menu orbit, kill cam, overview, sight, volley
  framing, following shells, a look, your turn). `src/cameramode.js` is its
  pure part: the mode state (follow, sight, overview, a look, the kill cam),
  which mode drives each frame, and the kill cam's trigger and slow motion
  (`test/cameramode.test.js`).
- `src/hudview.js` is what the HUD shows in each view (plan, sight, flight, kill
  cam, overview, between rounds), read from the phase and the camera's mode: one
  table, with the phone's CSS generated from it (`test/hudview.test.js`). `src/hints.js` counts how often a teaching line has
  shown (`test/hints.test.js`).
- `src/audio.js` is the synthesised sound, `src/music.js` the soundtrack.
- `src/review.js` (with `src/packkit.js`) is the resource-pack review, loaded only by the dev server.
- `src/core/netplay.js` runs an online match: every screen keeps its own
  `Game` and reads the same ordered message log (plans, shop choices). At
  each volley, and again before each round, the host sends its full state
  (`Game.snapshot`) and the others take it, so small floating-point drift
  never adds up. A reloaded tab reads the log back, jumps to the host's
  latest state and counts its own earlier plans as made. `src/net.js` is
  the browser's link to the room (long polling, sends kept in order).
- `src/main.js` holds the scene, input, HUD and menus, and drives the camera rig.
  It turns `Game` events into visuals and sound.
- `test/` holds the headless tests (`npm test`, Node 18+). They cover crater shape,
  analytic range, wind drift, the roller, AI convergence and how fast each
  difficulty walks its shots in, scenery placement and bombardment, perks, the
  skill tree, modifiers, driving and fuel (`twists.test.js`), weapon variants
  (`variants.test.js`), the match builder's
  allow-lists, Random rolls and query params (`builder.test.js`), the launch
  screen's saved state and its migrations (`launch.test.js`), road routing (`paths.test.js`),
  aim history and both firing modes (`volley.test.js`), jump jets, Teleport and Flak
  (`jets.test.js`), whole CPU-only matches, and
  online matches between several simulated screens with deliberate drift,
  including screens reloading at every stage of a match (`netplay.test.js`).
- `test/lockstep.js` is the online determinism harness (`netplay-lockstep.test.js`
  uses it). It plays one online match on several simulated screens from one
  room log, every screen on the same fixed clock, and compares each screen's
  own state with the host's every time a `snap` or `close` comes in: any
  field that differs is a determinism bug, reported by its path
  (`.players.0.shots.0`). Its bots drive, hop, deploy mods, take weapon
  variants and buy; the tests cover the boss match, three-screen rain and
  mod matches, the City, CPU Flak, a reload mid-match and uneven frame rates.
  To hunt a new feature's drift, run `playMatch` with that feature on over many
  seeds and print `mismatches[0]`.
- `tools/balance.mjs` runs headless balance sims on the seeded dice, so the
  same command prints the same numbers: `variants` (each weapon variant against
  its base, fired by a CPU; `--pit` puts the target in a crater), `flak` (Flak
  against the Shell and Scatter per CPU difficulty) and `boss` (whole all-CPU
  boss matches in each firing mode). The header comment lists the options.

The ballistics, crater falloff and AI solver follow the Unreal project's
`CraterMath`, `TankAiming` and the legacy aim-guesser loop. The AI aims with
the same simulator the shells fly on.

`window.craterfall` exposes the live game, camera, sky, birds and sound for
debugging from the console, with `lookAt` / `release` to pin the camera
(`rig` and `cameraMode` for the camera's state),
`tick(dt)` to run one frame by hand and `setDay(0..1)` to hold the sun at a
time of day.

## Deploying

`web/module/` packages the game as a SharedTools.Web module drop. Its csproj links
`index.html`, `css/`, `src/` and `vendor/` in as `wwwroot`, so there is one copy of the game.
`CraterfallModule` serves those files under `/Craterfall/`, and `Rooms.cs`
serves the online rooms API under `/Craterfall/api/rooms`. Rooms live in
memory on the server, so a redeploy ends any match in progress.
`Players.cs` serves `/Craterfall/api/me`: a random player id in an HttpOnly
cookie, and a small record per id (name, first and last seen, matches played
and won). Records are saved as `players.json` in the folder named by
`CRATERFALL_DATA` (env var, or config `Craterfall:DataPath`); else, on the
module-drops host, in `_data/craterfall/` beside the drops (on its volume, and
left alone by uploads); else the host's `App_Data/Craterfall`; else `data/`
next to the module, which the next upload moves aside. With none writable
they stay in memory and the host logs a warning. A visit alone stores nothing:
a record is made when a player sets a name or finishes an online match.
Rooms have limits so a flood cannot take the host's memory: 128 KB a message,
8 MB and 20000 entries a room, 64 MB across all rooms, 300 rooms. A room
plays one match, and goes after half an hour with nobody polling it.
`tools/devserver.mjs` is a copy of the same API for local testing; keep the two in step.

```powershell
cd web/module
./deploy.ps1   # needs MODULE_UPLOAD_KEY in the env or a gitignored .env
```

The game is live at https://blogfor.net/Craterfall/ (gateway path route) and
https://modules.blogfor.net/Craterfall/.
