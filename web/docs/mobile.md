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
| Right thumb | **Aim pad**: drag ↔ turret, ↕ elevation, like a trackpad (relative, with pointer acceleration: slow is precise, a flick turns far) | `game.adjustAim`, as held A/D/W/S do |
| Right thumb | **Power strip** beside it: drag ↕ | `adjustAim` power, as Q/E do |
| Right thumb | **Fire** (big, round; reads "Lock in" in a volley) and a **weapon** button above it showing the current weapon; tap to cycle | Space, Tab |
| Left thumb | **Drive cross**: ▲ ▼ drive, ◀ ▶ turn the hull, held. In flight ◀ ▶ also steer a Guided Missile | arrow keys |
| Left thumb | **Jet** | J |
| Bottom middle | Small: Tilt (off / Lean / Grip), Zero, Inv, Fine, Find, View, Mute, Chat (online only), Fullscreen | F, V, M, Enter; Fine scales pad and tilt by 0.2 like Shift |

Why a relative trackpad rather than a virtual joystick: a stick sets a *rate*, so
reaching 47.3° means nudging and waiting; a drag sets a *change*, so a 3 px move is a
0.4° correction you can feel. The weapon bar stays (tap a weapon) but moves to the
top and scrolls sideways on short screens. The pad shows the turret and elevation
under your thumb, since the player card shrinks.

Things the prototype does not do yet, worth trying next:

- **Long-press Fire to arm**, or a confirm swipe, if accidental shots turn out to be a problem.
- **Fine-tune nudges**: tiny ± steppers for elevation and power (0.1 a tap), for the last correction.
- **Rangefinder card** as a tap-to-open sheet. It is hidden on short screens for now.
- **Chat** button (Enter does not exist), and a **mute** button (M does not exist; the setup slider still works).

## Gyro / tilt aim

Optional, off by default, a toggle in the aim HUD. Two models are worth comparing:

1. **Tilt as a joystick** (built: **Lean**). Zero the pose; lean the right edge down to
   turn right, tip the top edge away from you to raise the barrel (**Inv** flips
   that; the choice is kept in localStorage). A 3° deadzone,
   full speed at 22°, a squared response so small leans are fine control, and a
   0.08 s low-pass on the readings. Works lying on a couch, and the turret can
   swing all the way round without you turning your body. It re-zeros on its own
   at the start of every aim (however you hold the phone then is neutral) and with
   the **Zero** button, and after a screen rotation.
2. **Gyro as a mouse** (built: **Grip**). While a thumb rests on the aim pad, each
   frame's change in lean moves the turret 2.2° per degree and the change in pitch
   moves the barrel 1.2° per degree (Fine scales both by 0.2). Lift the thumb and the
   phone can be re-centred without moving the aim, like lifting a mouse, so a 180°
   shot never means turning round. Dragging the pad still works at the same time:
   drag for the big moves, tilt for the last few degrees. It reads the same
   low-passed `deviceorientation` pose as Lean rather than `devicemotion`, so one
   permission and one code path cover both.

Platform notes:

- **iOS 13+** needs `DeviceOrientationEvent.requestPermission()`, called straight
  from a tap (no other `await` before it). The Tilt button does that. If the user
  says no, iOS remembers until the site data is cleared, so we say so.
- **HTTPS only.** Chrome and Safari block motion sensors on plain http. blogfor.net
  is https, so it is fine; testing a dev server from a phone over a LAN IP is not
  (use a tunnel or `chrome://flags` "insecure origins treated as secure").
- Screen axes: readings are in device axes. The prototype turns them into screen
  axes with `screen.orientation.angle` (90 / 270 in landscape), so left and right
  hold in both landscape directions.
- Some Android phones send null readings (no gyro or no permission); we say "no
  tilt readings" after 1.5 s.

## Haptics

`navigator.vibrate` works on Android Chrome and Firefox: a short tick per button,
30 ms on fire, and a double pulse when your own tank is hit (hooked on the inset
flash). **iOS Safari has no vibration API**. The only trick there (an
`<input type=checkbox switch>` toggle in iOS 18) is a hack; skip it.

## Screen, fullscreen, orientation

- `requestFullscreen` + `screen.orientation.lock('landscape')` works on Android
  Chrome. The prototype has a ⛶ button that does both.
- **iPhone Safari has no element fullscreen** (iPad has `webkitRequestFullscreen`).
  The fix on iPhone is "Add to Home Screen" (done): `manifest.webmanifest` with
  `"display": "fullscreen"`, `"orientation": "landscape"` and icons in `img/`, plus
  `apple-mobile-web-app-capable` and an `apple-touch-icon`. It also hides Safari's
  bottom bar, which otherwise eats about 50 px.
- `viewport-fit=cover` with `env(safe-area-inset-*)` margins on the thumb clusters,
  the middle row and the top-left cards, so they clear the notch and home bar.

## HUD, menus and the armory at small sizes

- In game: the player card and scoreboard shrink (scale 0.72, 0.62 under 520 px
  tall) and perks hide; the keyboard help line goes; the round label and weapon bar
  move to the top centre; the Guided Missile steering bar and the chat log move up.
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

**One experiment: the two-thumb layout with the relative aim pad, plus tilt aim
as a toggle.** Once deployed, play a few rounds on a real phone at
`https://blogfor.net/Craterfall/` (the controls show up by themselves on a touch
device; on desktop add `?mobile=1`) and answer three questions:

1. Can you hit a tank 300 m away by shot 3 with the pad alone? If not, add the ± steppers.
2. Is tilt fun, or does it just get in the way? If fun, build the gyro-mouse with a clutch next.
3. Is it smooth? If not, do the shadow and scenery cuts above before anything else.

## The prototype

- `src/touch.js`, about 300 lines, no dependencies beyond `core/tank.js` speeds.
- Turned on by `(pointer: coarse)` or `?mobile=1`; `?mobile=0` turns it off.
  Desktop without the flag is unchanged.
- Buttons send synthetic `keydown`/`keyup` events on `window`, so they go through
  main.js's key handler, `held` set and hand-off logic. The pad, power strip and tilt
  hand main.js an aim change each frame (`touch.take(dt, player)`), which it passes
  to `game.adjustAim`, the same call the held keys make.
- `window.craterfall.touch` is the controls object (tilt state, `buzz()`).
