# Craterfall on phones and tablets

A design note for a touch version, plus what the first prototype (`src/touch.js`)
does. The game rules do not change; only input, layout and rendering defaults do.

## The shape of it

Artillery suits phones better than most 3D games: nothing is twitchy, each turn is
"set three numbers, press fire", and a match is a few minutes. The hard parts are
**precision** (an elevation 0.3° off misses by 10 m at range), **screen room** (a
landscape phone is about 844 × 390 CSS px, and the desktop HUD alone fills that),
and **gestures that clash** (one-finger drag already orbits the camera).

Rule of thumb: **thumbs own the aim, the middle of the screen owns the camera.**
The controls sit in the two bottom corners. Any touch that starts on the 3D view
is the camera (OrbitControls: one finger orbits, two pinch to zoom and pan). Nothing
needs a mode switch, and the two never fight over the same touch.

Play in **landscape only**. In portrait on a phone, show a "turn your phone
sideways" card over the game (menus can stay portrait-friendly).

## Touch layout for the aim turn

| Zone | Control | Feeds |
| --- | --- | --- |
| Right thumb | **SIGHT**, above the weapon button: the camera looks down your turret line; then drag anywhere to aim (↔ turret, ↕ elevation, 1:1 with the view) and pinch, or the − / + chip above Fine / Find / View, to zoom (2×, 4×, 8×). Round one's first plan says so. (Tap-to-aim was taken out: a stray tap swung the turret) | G; `src/gunner.js` |
| Aim view | **Angle dials** on your tank while you aim: a ring on the ground (0 east, angles grow to the right of your aim; a tick every 15°, long at 0/90/180/270, no fixed numbers) with an amber arrow for the turret and a faint white one for your last shot, and a quarter arc by the barrel (0 to 90, ticks every 15°, long at 45) with needles for the elevation now and last time. The readings match the card. Hidden in the sight, the overview and in flight; ⚙ Settings > Graphics > Angle dials switches them off. The only numbers are the two live readings at the pointer tips; they keep a fixed size on screen so they stay legible at phone camera distance. The aim arc's "top … m up" words show only while the aim changes and fade 1.5 s after (never in the sight) | `src/render/dials.js`, `src/dialmath.js` |
| Top centre | **Side view** of the planned shot (196 x 76 px; the 3D arc is edge on from behind the tank): ground along the line, your tank, the climb to its top, and enemies near the line. Between the player card and the players box (about 145 to 625 px across at 844 wide), clear of the aim pad, power bar, fire button and drive cross; in the sight it moves under the players box. Touches pass through it. On by default on touch; ⚙ Settings > Graphics > Side view switches it off | `src/render/sidepanel.js`, `src/sideview.js` |
| Right thumb | **Aim pad**: drag ↔ turret, ↕ elevation, like a trackpad (relative, with pointer acceleration: slow is precise, a flick turns far) | `game.adjustAim`, as held A/D/W/S do |
| Right thumb | **Power strip** beside it: drag ↕ | `adjustAim` power, as Q/E do |
| Right thumb | **Fire** (big, round; reads "Lock in" in a volley) and a **weapon** button above it showing the current weapon; tap it for a pop-up list of your weapons | Space; the weapon bar's own buttons |
| Left thumb | **Drive cross**: ▲ ▼ drive, ◀ ▶ turn the hull, held. In flight ◀ ▶ also steer a Guided Missile | arrow keys |
| Either half of the view | In flight, a finger held on the left or right half steers a Guided Missile (the Guidance gauge at the right edge shows the fuel) | A / D |
| Left thumb | **Jet** | J |
| Top right corner | **⚙ Settings** (the scoreboard sits just left of it; the same corner on the launch screen): tabs for Audio (Master / Effects / Music levels and mutes, music track), Graphics (fire and smoke, angle dials, side view) and More (**Guide**, Catalog, resource packs), with **Full screen** and **Suggest** (send the developer a note) in the header on every tab | M and - / = for Master |
| Bottom middle | Small: Fine, Find, View, Chat (online only). Find stays lit and holds the camera on an enemy; tap again for the next, and past the last (or the only one) it lets go | F, V, Enter; Fine scales the pad by 0.2 |

Why a relative trackpad rather than a virtual joystick: a stick sets a *rate*, so
reaching 47.3° means nudging and waiting; a drag sets a *change*, so a 3 px move is a
0.4° correction you can feel. The weapon bar is not shown across the screen: it
is the weapon button's pop-up, so the top of the screen stays clear. Keyboard hints
(the help strip, weapon number keys, "press Space") are hidden or say what to tap.
The pad shows the turret and elevation (and what the last shot used) under your thumb, since the player card's own readout is hidden on a phone; see "What the HUD shows in each view".

Things the prototype does not do yet, worth trying next:

- **Long-press Fire to arm**, or a confirm swipe, if accidental shots turn out to be a problem.
- **Fine-tune nudges**: tiny ± steppers for elevation and power (0.1 a tap), for the last correction.
- **Rangefinder card** as a tap-to-open sheet. It is hidden on short screens for now.

## Tilt aim (dropped for now)

Two tilt modes were built and tried on a phone, then taken out because they were
buggy in play: **Lean** (tilt as a joystick: zero the pose, lean to turn, tip to
raise, a 3° deadzone to full speed at 22°) and **Grip** (tilt as a mouse, only
while a thumb rests on the aim pad). The code is in git history (src/touch.js
before the commit "drop tilt aim"). If it comes back, remember:

- **iOS 13+** needs `DeviceOrientationEvent.requestPermission()` straight from a
  tap, and **https** (a LAN dev server will not do).
- Readings are in device axes; turn them into screen axes with
  `screen.orientation.angle` so both landscape directions work.
- Low-pass the readings (0.08 s) and re-zero at the start of every aim.

## Haptics

`navigator.vibrate` works on Android Chrome and Firefox: a short tick per button,
30 ms on fire, and a double pulse when your own tank is hit (hooked on the inset
flash). **iOS Safari has no vibration API**. The only trick there (an
`<input type=checkbox switch>` toggle in iOS 18) is a hack; skip it.

## Screen, fullscreen, orientation

- `requestFullscreen` + `screen.orientation.lock('landscape')` works on Android
  Chrome. Settings > Full screen does both.
- **iPhone Safari has no element fullscreen** (iPad has `webkitRequestFullscreen`).
  The fix on iPhone is "Add to Home Screen" (done): `manifest.webmanifest` with
  `"display": "fullscreen"`, `"orientation": "landscape"` and icons in `img/`, plus
  `apple-mobile-web-app-capable` and an `apple-touch-icon`. It also hides Safari's
  bottom bar, which otherwise eats about 50 px.
- `viewport-fit=cover` with `env(safe-area-inset-*)` margins on the thumb clusters,
  the middle row and the top-left cards, so they clear the notch and home bar.

## What the HUD shows in each view (the declutter audit)

A landscape phone is 844 x 390, so the HUD has to give way to what you are doing.
The principles: the 3D scene owns the screen while a shell flies; nothing needed to
aim is ever hidden; each number is shown once; a hint teaches a few times, not every
match. There are six views: **plan** (setting a shot, also a CPU's turn or a hand-off),
**sight** (the gunner's view), **flight** (shells in the air, being fired, or waiting
on the others), **kill** (the deciding shot's slow-motion replay), **overview** (the
View map) and **between** (the round or match has ended, or the armory is open; the
cards cover the screen).

`src/hudview.js` holds the table below as data and picks the view from the game
(`hudView()`); `main.js` writes it to `body[data-view]` once a frame, and the shown /
faint / hidden CSS is **generated from the table** (injected as `#hud-views`), so
this page, the code and `test/hudview.test.js` cannot drift apart. Phone rules only
(under `body.touch`): a desktop screen has room and is unchanged, except that the
off-screen locators also step aside in the sight there. Rows the drawing code owns
(side view, dials, marks, locators, notes) are in the table but driven by that code.

| Element | plan | sight | flight | kill | overview | between | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Player card | shown | shown | hidden | hidden | faint | hidden | Your tank. The sight keeps only its wind (the one number the sight does not show), the shell is the show in flight, and the map wants the field clear. |
| Card: name, health, fuel, jets, round | shown | hidden | hidden | hidden | shown | hidden | What you check while planning and driving. In the sight the compass tape and the marks say it all. |
| Card: turret, elevation, power, weapon | hidden | hidden | hidden | hidden | hidden | hidden | The aim pad, the power strip and the weapon button already say it (the pad also says what the last shot used, the button how many rounds are left). |
| Card: money | hidden | hidden | hidden | hidden | hidden | hidden | Only the armory spends it, and the armory shows it. |
| Card: jump jets, none left | hidden | hidden | hidden | hidden | hidden | hidden | A row that says nothing. |
| Players box | shown | faint | faint | hidden | shown | hidden | Everyone's health. The sight's marks carry health, a followed shell wants the field clear. |
| Players box: perk chips | shown | hidden | hidden | hidden | shown | hidden | They stretch the box down over the side view in the sight; nothing to read mid-flight. |
| Settings gear | shown | shown | faint | hidden | shown | shown | Always reachable; faint while a shell flies. |
| Side view of the shot | shown | moved | hidden | hidden | hidden | hidden | Only means something while you set the shot; in the sight it moves under the players box. |
| Angle dials on your tank | shown | hidden | hidden | hidden | hidden | hidden | The sight, the map and a shell in flight hide them. |
| Marks over tanks | shown | shown | faint | shown | shown | shown | Names while planning; names and health in the sight, the map and a Find look; faint while following a shell; names only in the kill cam. |
| Edge arrows to off-screen enemies | shown | hidden | hidden | hidden | hidden | hidden | The sight draws its own markers for what is off to the side; they are for aiming, so only while you plan. |
| Aim pad and its readout | shown | shown | hidden | hidden | shown | hidden | The thumb's aim; nothing to aim once the shot has left. Its "drag" line shows only the first few matches. |
| Power strip | shown | shown | hidden | hidden | shown | hidden | As the pad. |
| Lock in, weapon, sight, x2 and mods | shown | shown | hidden | hidden | shown | hidden | Buttons for the shot you are setting. |
| Drive cross and Jet | shown | faint | faint | hidden | faint | hidden | Faint but live: steering a Guided Missile in flight lights it back up. |
| Fine, Find, View, Chat | shown | shown | faint | hidden | shown | hidden | View and Find still work in flight, and a faint button is still a button. |
| Boss bar | shown | moved | shown | hidden | shown | hidden | The fight's health bar; in the sight it moves left, off the compass tape. In plan the side view drops below it. |
| Guidance strip | hidden | hidden | shown | hidden | hidden | hidden | Only while a Guided Missile flies. |
| Your tank in the corner | hidden | hidden | shown | hidden | hidden | hidden | Only in flight, with your tank off screen. |
| Rangefinder card | hidden | hidden | hidden | hidden | hidden | hidden | Too big for a phone (already cut on a short screen); the probes' dots and beams in the world still show. |
| Touch notes (the hint line) | shown | shown | shown | hidden | shown | hidden | Short, one line. The SIGHT, pad and Lock in teaching ones show the first few matches only. |
| Kill cam caption | hidden | hidden | hidden | shown | hidden | hidden | The deciding shot, "A to B". |

What changed in this pass (all phone only unless it says otherwise):

- **The card is half the size.** Its turret / elevation / power / weapon block, the
  money row and an empty jump-jet row went: the pad and strip show the same numbers.
  What the readout alone carried moved: the pad has a small "last 359.0° 45.0° 60"
  line (what your previous shot used), and the weapon button shows the rounds left
  under its name (nothing for an infinite weapon).
- **Flight.** A phone's thumbs have nothing to do while a shell flies, so the aim
  pad, power strip, Lock in cluster and the card fade out; the drive cross, Find /
  View, the gear and the players box go faint. The scene is clear but for the shells
  and faint marks. Touches in the empty thumb areas orbit the camera. A Guided Missile
  lights the drive cross back up (◀ ▶ steer it).
- **Sight.** The card shrinks to its wind (nothing else on the screen says it), the
  players box goes faint and drops its perk chips (it was growing over the side view),
  the compass tape is narrower so it clears the players box, and the off-screen enemy
  arrows go (on desktop too): the tape and the sight's edge markers say it.
- **Overview.** The card fades, the drive cross fades; the map has the rest.
- **Between rounds.** The HUD and touch controls hide the moment the round ends, so the
  last explosion and damage numbers play out clean before the results card.
- **Boss matches.** The boss bar used to sit on the side view; the side view now drops
  below it, and in the sight the bar moves under the compass tape at the left.
- **Hints show the first few times** (`src/hints.js`, counts in localStorage under
  `craterfall.hints`): the "SIGHT looks down your barrel" note the first 3 matches,
  the pad's "drag" line the first 5, and the "Plan it, then tap Lock in" banner line the
  first 6 turns (after that the banner is the title alone and 1 s instead of 1.7 s).

Left as it was: the angle dials' two numbers at the tank (the pad's own readout sits
under the thumb), the locators while planning (they are how you find a tank that is
off screen), the wind in plan (it changes every round).

## HUD, menus and the armory at small sizes

- In game: the left column (player card, with the round at its head, and the
  rangefinder) and the players box shrink. On a phone the players box leaves the
  column for the top right, as the column has no room (scale 0.72; the card 0.55 under 520 px
  tall, so it clears the drive cross on a 375 px phone) and perks hide; the keyboard
  help line goes; the weapon bar is the weapon button's pop-up; the chat log
  moves up.
- The draft, shop and results cards already fit (`max-height: 92vh` and
  scroll). Buttons get a 40 px minimum height. The shop grid is 3 columns in
  landscape and fine.
- **The launch screen is not a card on a phone.** With `body.touch`, or a landscape
  window under 500 px tall, `#setup` fills the screen edge to edge and scrolls
  by itself. Padding uses the safe-area insets so nothing hides under the notch or
  the home bar, and it never scrolls sideways (a tank row's name box shrinks to
  fit). Inputs, selects and
  buttons are at least 44 to 48 px tall, and text inputs are 16 px so iOS does
  not zoom. In landscape it is two columns: title, **Your name** and **Play** stay
  put on the left, and two tabs, **Custom match** and **Online** (the last one is
  remembered), scroll on the right. In portrait it is one column. Most people only
  need Play. In Custom match, **Start match** stays pinned at the foot of the
  screen while you scroll the options; in a room the tabs give way to the room's
  lobby, with its Start pinned the same way.
- **The match builder's checkbox groups** (Weapons, Perks, Round modifiers;
  `src/builder.js`) are `<details>`, shut by default, with a 44 px summary on
  touch that says "All" or "7 of 12". Open, an All box sits over a grid of
  ticks, two columns on a phone in landscape (`minmax(150px, 1fr)`), each row
  at least 36 px tall with the name and its first line, cut with an ellipsis.
- **Play and Start go full screen.** On a phone, tapping Play or Start also calls
  `toggleFullscreen()` when `canFullscreen()` and not already full screen. That
  has to run inside the tap (full screen needs a user gesture), so it is in
  the click handlers (`phoneFullscreen` in `src/launch.js`). iPhone Safari has
  no element full screen; Add to Home Screen covers it.
- **Holding the phone upright leaves full screen.** Full screen pins landscape, so
  turning the phone doesn't rotate the page. Kept in portrait for 3 seconds, it
  leaves full screen and unlocks the rotation, so the browser's own controls come
  back, and a banner says how to return (Settings > Full screen). Upright is
  read from gravity in the motion sensor, which works under the landscape lock;
  without a sensor reading, the page's own orientation is used
  (`src/portraitexit.js`). A glance at portrait, or the phone lying flat,
  doesn't count.
- Labels, pips and edge arrows work as they are. Edge arrows are tappable.

## The in-game guide

Settings > Guide (`src/guide.js`, `css/guide.css`) is how a phone player learns the
controls: tabs for Basics, Controls, Weapons, Mods and perks, and Match builder. On a phone
(`body.touch`, or any window under 520 px tall or 600 px wide) it fills the screen
edge to edge: safe-area insets cleared, 44 px tabs that scroll sideways if they do
not fit, a body that scrolls by itself, and a 44 px ✕ top right (in landscape the
title, tabs and ✕ share one row to leave the height for text). On a desktop it is a
centred panel. It is lazy-loaded, sits above every screen (so it opens from the
launch screen and mid-match), and swallows keydown so typing in it cannot fire the
tank. Controls lists the touch controls first, then the keys.

## Performance on mobile GPUs

Settings > Graphics > Detail (`src/graphics.js`, `src/render/graphics.js`) sets
what the GPU draws. High: antialias on, pixel ratio up to 1.5 (**1.25** on a
`pointer: coarse` device, which reports 3), PCF shadows from a **4096²** sun
shadow map (**2048²** on a touch device: 16 MB of depth instead of 64), redrawn
every frame, plus a second scene render for the inset during flight.

Low, for phones that run hot or slow: pixel ratio 1, a 1024² shadow map with a
blob under each tank, the terrain's shadow cast from a mesh with a quarter of its
triangles, and the ground and water shaders' `GFX_LOW` path (no warp, cloud
shadows or bump tilt on the ground; three waves and no noise on the water).
Measured at 844x390 on a desktop GPU it about halves the GPU time per frame and
drops 70k to 100k triangles (the terrain's second shadow-pass copy) on the
heightfield maps; draw calls stay within a few of High.

Auto (the default) is Low on a touch device with four cores or fewer or 2 GB of
memory or less, and otherwise drops to Low once if the menu backdrop's frames run
slow (median over 24 ms after a warm-up).

Next, if a phone still runs hot or below 60 fps on Low:

- Redraw the shadow map only when something moved (tanks, craters, the sun's
  slow drift), not every frame.
- Fewer instanced trees and bushes beyond a distance, fewer birds and clouds,
  cap debris and smoke counts in `Effects` (Fire and smoke > Light already does
  some of this).
- Skip the inset render, or draw it every other frame.

## Audio

Mobile browsers only unlock audio from a "user activation" event: `pointerup`,
`touchend` or `click`, **not** `pointerdown` from a finger (main.js unlocks on the
first `pointerdown`, which only counts for a mouse). The touch module calls
`sound.ensure()` on every `pointerup` and `touchend`, which creates or resumes the
AudioContext. iOS also mutes Web Audio when the ring/silent switch is on silent;
nothing can be done about that except say so in a help line.

## What to try first

**One experiment: the two-thumb layout with the relative aim pad.** Once deployed, play a few rounds on a real phone at
`https://blogfor.net/Craterfall/` (the controls show up by themselves on a touch
device; on desktop add `?mobile=1`) and answer three questions:

1. Can you hit a tank 300 m away by shot 3 with the pad alone? If not, add the ± steppers.
2. Is it smooth? If not, do the shadow and scenery cuts above before anything else.

## The prototype

- `src/touch.js`, about 240 lines, no dependencies beyond `core/tank.js` speeds.
  `src/settings.js` is the ⚙ modal, shared with the desktop.
- Turned on by `(pointer: coarse)` or `?mobile=1`; `?mobile=0` turns it off.
  Desktop without the flag is unchanged.
- Buttons send synthetic `keydown`/`keyup` events on `window`, so they go through
  main.js's key handler, `held` set and hand-off logic. The pad and power strip
  hand main.js an aim change each frame (`touch.take(dt, player)`), which it passes
  to `game.adjustAim`, the same call the held keys make.
- `window.craterfall.touch` is the controls object (`buzz()`, `openWeapons()`).
