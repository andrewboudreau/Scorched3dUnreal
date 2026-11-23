// Leaving full screen by holding the phone upright.
//
// Full screen on a phone also locks the screen to landscape (settings.js), so
// turning the phone doesn't rotate the page. Someone who turns it to portrait
// and keeps it there for a few seconds most likely wants the browser's own
// controls back (tabs, address bar, back), so full screen ends.
//
// Upright is read from gravity in the motion sensor (devicemotion), which
// reports how the phone itself is held whatever the screen lock says. Where
// there is no sensor reading, the page's own orientation is used instead
// (that works when the browser didn't lock it).

export const PORTRAIT_HOLD = {
  ms: 3000,        // how long the phone must stay upright
  upright: 7,      // m/s^2 of gravity along the phone's long axis, at least
  ratio: 1.5,      // and this many times the sideways part (so landscape and tilted don't count)
  stale: 1000,     // ms: a sensor reading older than this is ignored
};

// Is the phone held upright (portrait, either way up), from gravity in the
// device frame? Flat on a table (gravity along z) is not upright.
export function uprightFromGravity(g, k = PORTRAIT_HOLD) {
  if (!g || g.x == null || g.y == null) return null;
  const ax = Math.abs(g.x), ay = Math.abs(g.y);
  return ay >= k.upright && ay >= k.ratio * ax;
}

// Counts how long the phone has been upright. `step(upright, now)` returns
// true once, when the hold has lasted long enough; turning back resets it.
export function portraitTimer(k = PORTRAIT_HOLD) {
  let since = null, fired = false;
  return {
    step(upright, now) {
      if (!upright) { since = null; fired = false; return false; }
      if (since == null) since = now;
      if (!fired && now - since >= k.ms) { fired = true; return true; }
      return false;
    },
    reset() { since = null; fired = false; },
  };
}

// Wire it up in the page: while in full screen, watch the phone and call
// `leave()` after a portrait hold. `isFullscreen` says whether we're in it.
export function watchPortraitExit({ isFullscreen, leave, k = PORTRAIT_HOLD }) {
  const timer = portraitTimer(k);
  let gravity = null, at = 0;
  addEventListener('devicemotion', (e) => {
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null) { gravity = { x: g.x, y: g.y, z: g.z }; at = performance.now(); }
  });
  const portraitMedia = matchMedia('(orientation: portrait)');
  setInterval(() => {
    if (!isFullscreen()) { timer.reset(); return; }
    const now = performance.now();
    const fromSensor = now - at < k.stale ? uprightFromGravity(gravity, k) : null;
    const upright = fromSensor ?? portraitMedia.matches;
    if (timer.step(upright, now)) leave();
  }, 200);
}
