// Which input does what, and when: the routing table behind src/input.js.
// Pure: no DOM, no three.js, so it is testable (test/inputmap.test.js). input.js
// listens, asks here, and carries the action out.
//
// Keys (window keydown; a key typed into a text box or a list is never the
// tank's). Every key is also held (the `held` set) until it comes back up, the
// window loses focus, the hand-off card opens or the chat opens.
//
//   key           action        live
//   Enter         chat          online, the hand-off card down (also on the menu)
//   Space, Enter  handoff-go    the hand-off card up (any other key just lets go of the held keys)
//   Space         fire          in a match (the game checks the rest: a human's turn, aim)
//   Tab / ⇧Tab    weapon        in a match: the next (previous) weapon
//   1 .. 9        slot          in a match: that weapon, while a human here aims
//   J             jet           in a match: a jump-jet hop, while a human here aims
//   F             find          in a match: hold the camera on the next enemy (camera.js peekNext)
//   G             sight         in a match: the sight on or off
//   C             follow        in a match: the follow cam on or off
//   V             view          in a match: the overview on or off
//   M             mute          in a match
//   - / = / +     volume        in a match: Master down (up) a tenth
//   N             music         in a match: the next track
//   X             strike        in a match: Double Strike on or off (strike.js)
//   B             deploy        in a match, without Ctrl or ⌘: arm or deploy a mod (modsui.js)
//
// "In a match" means a game is on, the key is not a repeat and the hand-off card
// is down. Tab and the arrows never scroll the page. The camera's mode does not
// change what a key does: the kill cam, the overview and the sight all take
// them, and each action keeps its own rules (cameramode.js for the camera ones).
//
// Held keys, each frame while a human here aims (phase 'aim', no hand-off):
//
//   A / D         turret yaw          W / S         elevation
//   Q / E         power (also PageDown / PageUp)
//   Shift         three times as fast; a tap moves a little, holding ramps up (holdRamp)
//   ↑ / ↓         drive along the hull  ← / →  swing it (not mid-hop)
//
// and in flight (phase 'flight'), A / D or ← / → steer this screen's guided missiles.
//
// Pointers on the view (the canvas):
//
//   state                         one finger / mouse drag   two fingers     wheel
//   flight, guided fuel, touch    steer (left or right half of the view; the camera never sees it)
//   mode 'sight'                  aim (sightAim)            pinch zoom      sight zoom
//   any other mode                orbit (OrbitControls)     zoom and pan    orbit zoom
//
// Outside the sight a drag past DRAG_SLOP pixels, or a wheel turn, takes the
// camera over until the next turn (CameraRig.takeOver). The touch controls'
// buttons (touch.js) press these same keys; their aim pad and power strip feed
// the same aim as the held keys.

export const ACTIONS = {
  ' ': 'fire', tab: 'weapon', j: 'jet', f: 'find', g: 'sight', c: 'follow', v: 'view', m: 'mute',
  '-': 'volume', '=': 'volume', '+': 'volume', n: 'music', x: 'strike', b: 'deploy',
};

// What a key press does. `k` is the key, lower case (KeyboardEvent.key);
// s = { inMatch, handoff, online, repeat, shift, ctrl }. Returns
//   { action, arg, prevent, hold, clear }
// action: what to do (null for nothing), arg: its argument (the weapon step, the
// slot, the volume step), prevent: keep the browser's default from it, hold: add
// it to the held keys, clear: let go of every held key afterwards.
export function keyRoute(k, s) {
  if (s.online && k === 'enter' && !s.handoff) return { action: 'chat', arg: undefined, prevent: true, hold: false, clear: false };
  const r = { action: null, arg: undefined, prevent: k === 'tab' || k.startsWith('arrow'), hold: true, clear: false };
  if (s.repeat || !s.inMatch) return r;
  if (s.handoff) {
    r.clear = true;
    if (k === ' ' || k === 'enter') { r.action = 'handoff-go'; r.prevent = true; }
    return r;
  }
  if (k >= '1' && k <= '9') { r.action = 'slot'; r.arg = Number(k) - 1; return r; }
  const action = ACTIONS[k];
  if (!action || (action === 'deploy' && s.ctrl)) return r;
  r.action = action;
  if (action === 'fire') r.prevent = true;
  else if (action === 'weapon') r.arg = s.shift ? -1 : 1;
  else if (action === 'volume') r.arg = k === '-' ? -0.1 : 0.1;
  return r;
}

const on = (held, ...keys) => (keys.some((k) => held.has(k)) ? 1 : 0);

// The held keys' aim and drive, each -1, 0 or 1 (fast: the Shift multiplier).
export function heldAxes(held) {
  return {
    yaw: on(held, 'd') - on(held, 'a'),
    elev: on(held, 'w') - on(held, 's'),
    power: on(held, 'e', 'pageup') - on(held, 'q', 'pagedown'),
    fast: held.has('shift') ? 3 : 1,
    go: on(held, 'arrowup') - on(held, 'arrowdown'),
    turn: on(held, 'arrowright') - on(held, 'arrowleft'),
  };
}

// How hard a held aim key pushes after `t` seconds: a short tap moves a little
// (fine); holding ramps up to full speed in about a third of a second.
export function holdRamp(t) {
  return t < 0.12 ? 0.25 : Math.min(1, 0.25 + (t - 0.12) * 3);
}

// Whether the held keys (and the touch aim pad) aim this frame.
export function aimLive({ inMatch, handoff, phase, human }) {
  return !!(inMatch && !handoff && phase === 'aim' && human);
}

// A guided missile's turn: -1, 0 or 1, from A / D, the side arrows and the
// steering fingers (`finger`: the sum of their -1 / 1).
export function steerDir(held, finger = 0) {
  return Math.sign(on(held, 'd', 'arrowright') - on(held, 'a', 'arrowleft') + finger);
}

// A finger going down: 'steer' when it lands on the view of a touch screen while
// a guided missile here has fuel (it steers, and nothing else sees it), else
// 'view' (the canvas's own handlers: the sight or the orbit controls).
export function pointerRoute({ touch, steering, onView }) {
  return touch && steering && onView ? 'steer' : 'view';
}

// Which half of the view a steering finger is on: -1 left, 1 right.
export const steerSide = (x, width) => (x < width / 2 ? -1 : 1);

// A drag on the view: 'aim' or 'zoom' (a pinch, two fingers) in the sight, else
// 'orbit' (OrbitControls).
export function dragRoute({ sight, fingers }) {
  if (!sight) return 'orbit';
  return fingers >= 2 ? 'zoom' : 'aim';
}

// The wheel: the sight's zoom, or the orbit's.
export const wheelRoute = ({ sight }) => (sight ? 'zoom' : 'orbit');

export const DRAG_SLOP = 4;       // px a drag goes before it takes the camera over

// A drag in the sight: across turns the turret by as much as the view moves
// under the finger, up and down raises the barrel (half as fast). Returns
// [yaw, elev] in degrees for a move of (dx, dy) px, `fov` degrees over `height` px.
export function sightAim(dx, dy, fov, height) {
  const perPx = fov / height;
  return [dx * perPx, -dy * perPx * 0.5];
}

// A pinch in the sight: zoom steps for the spread between two fingers going
// from `before` to `after` px (0 when either is 0).
export function pinchSteps(before, after) {
  return before > 0 && after > 0 ? Math.log(before / after) / 0.12 : 0;
}
