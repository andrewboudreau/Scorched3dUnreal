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
| Right thumb | **Aim pad**: drag ↔ turret, ↕ elevation, like a trackpad (relative, with pointer acceleration: slow is precise, a flick turns far) | `game.adjustAim`, as held A/D/W/S do |
| Right thumb | **Power strip** beside it: drag ↕ | `adjustAim` power, as Q/E do |
| Right thumb | **Fire** (big, round; reads "Lock in" in a volley) and a **weapon** button above it showing the current weapon; tap it for a pop-up list of your weapons | Space; the weapon bar's own buttons |
| Left thumb | **Drive cross**: ▲ ▼ drive, ◀ ▶ turn the hull, held. In flight ◀ ▶ also steer a Guided Missile | arrow keys |
| Either half of the view | In flight, a finger held on the left or right half steers a Guided Missile (the Guidance gauge at the right edge shows the fuel) | A / D |
| Left thumb | **Jet**, and **⚙ Settings** above it (Master / Effects / Music levels and mutes, music track, full screen, resource packs) | J; M and - / = for Master |
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
- The setup, draft, shop and results cards already fit (`max-height: 92vh` and
  scroll). Buttons get a 40 px minimum height. The shop grid is 3 columns in
  landscape and fine. The setup card is long; in landscape it scrolls. A later pass
  could fold the options into a "More options" section.
- Labels, pips and edge arrows work as they are. Edge arrows are tappable.

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
