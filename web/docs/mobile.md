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
| Right thumb | **Aim pad**: drag ↔ turret, ↕ elevation, like a trackpad (relative, with pointer acceleration: slow is precise, a flick turns far) | `game.adjustAim`, as held A/D/W/S do |
| Right thumb | **Power strip** beside it: drag ↕ | `adjustAim` power, as Q/E do |
| Right thumb | **Fire** (big, round; reads "Lock in" in a volley) and a **weapon** button above it showing the current weapon; tap it for a pop-up list of your weapons | Space; the weapon bar's own buttons |
| Left thumb | **Drive cross**: ▲ ▼ drive, ◀ ▶ turn the hull, held. In flight ◀ ▶ also steer a Guided Missile | arrow keys |
| Either half of the view | In flight, a finger held on the left or right half steers a Guided Missile (the Guidance gauge at the right edge shows the fuel) | A / D |
| Left thumb | **Jet**, and **⚙ Settings** above it: tabs for Audio (Master / Effects / Music levels and mutes, music track), Graphics (fire and smoke, angle dials) and More (**Guide**, Catalog, resource packs), with **Full screen** and **Suggest** (send the developer a note) in the header on every tab | J; M and - / = for Master |
| Bottom middle | Small: Fine, Find, View, Chat (online only). Find stays lit and holds the camera on an enemy; tap again for the next, and past the last (or the only one) it lets go | F, V, Enter; Fine scales the pad by 0.2 |

Why a relative trackpad rather than a virtual joystick: a stick sets a *rate*, so
reaching 47.3° means nudging and waiting; a drag sets a *change*, so a 3 px move is a
0.4° correction you can feel. The weapon bar is not shown across the screen: it
is the weapon button's pop-up, so the top of the screen stays clear. Keyboard hints
(the help strip, weapon number keys, "press Space") are hidden or say what to tap.
The pad shows the turret and elevation under your thumb, since the player card shrinks.

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
  the home bar, with room left at the end for the gear. Inputs, selects and
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

Today's desktop defaults: antialias on, pixel ratio up to 1.5, PCF shadows from a
**4096²** sun shadow map redrawn every frame, plus a second scene render for the
inset during flight.

Applied on touch-first devices (`pointer: coarse`) only:

- **Pixel ratio capped at 1.25** (phones report 3). That is about 6× fewer pixels
  than native on an iPhone, and MSAA hides the softness.
- **Shadow map 2048²**: 16 MB instead of 64 MB of depth, and a quarter of the fill.

Next, if a phone still runs hot or below 60 fps:

- Measure first (`renderer.info`, frame time on a mid-range Android).
- Redraw the shadow map only when something moved (tanks, craters, the sun's
  slow drift), not every frame.
- Fewer instanced trees and bushes beyond a distance, fewer birds and clouds,
  cap debris and smoke counts in `Effects`.
- Skip the inset render, or draw it every other frame.
- An adaptive mode: drop the pixel ratio a step when frame time stays above 20 ms.

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
