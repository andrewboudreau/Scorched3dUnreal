import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraModes, MODES, LOOK_MS, KILLCAM, labelMode, easeTimeScale, killSide } from '../src/cameramode.js';
import { hudView } from '../src/hudview.js';

// A planning turn on this screen, nothing in the air.
const planWorld = (over = {}) => ({ inMatch: true, phase: 'aim', planner: true, current: 0, volleyMode: true, hero: true, shellsInAir: false, shellsShown: false, now: 0, ...over });
const flightWorld = (over = {}) => planWorld({ phase: 'flight', planner: false, shellsInAir: true, shellsShown: true, ...over });

test('a fresh camera follows shells and plans from your tank', () => {
  const m = new CameraModes();
  assert.equal(m.follow, true);
  assert.equal(m.sight, false);
  assert.equal(m.overview, false);
  assert.equal(m.resolve(planWorld()), 'plan');
  assert.equal(m.resolve({ inMatch: false }), 'menu');
  for (const mode of ['menu', 'plan', 'hold']) assert.ok(MODES.includes(mode));
});

test('each phase has its mode', () => {
  const m = new CameraModes();
  assert.equal(m.resolve(planWorld({ phase: 'volley', planner: false })), 'hero');
  assert.equal(m.resolve(planWorld({ phase: 'volley', planner: false, hero: false })), 'volley');
  assert.equal(m.resolve(flightWorld()), 'hero');
  assert.equal(m.resolve(flightWorld({ hero: false })), 'volley');
  // Taking turns: the middle of the shells in sight.
  assert.equal(m.resolve(flightWorld({ volleyMode: false })), 'follow');
  assert.equal(m.resolve(flightWorld({ volleyMode: false, shellsShown: false })), 'hold');
  // A volley whose shells are all down holds where it is.
  assert.equal(m.resolve(flightWorld({ shellsInAir: false, shellsShown: false })), 'hold');
  for (const phase of ['settle', 'roundOver', 'matchOver', 'shop', 'wait']) assert.equal(m.resolve(planWorld({ phase, planner: false })), 'hold', phase);
  // A CPU's turn is still 'plan' (the camera looks at the tank whose turn it is).
  assert.equal(m.resolve(planWorld({ planner: false })), 'plan');
  assert.equal(m.resolve(planWorld({ current: null, planner: false })), 'hold');
});

test('follow off: shells are not followed and the kill cam stays away', () => {
  const m = new CameraModes();
  assert.equal(m.toggleFollow(), false);
  assert.equal(m.resolve(flightWorld()), 'hold');
  assert.equal(m.resolve(planWorld({ phase: 'volley' })), 'hold');
  assert.equal(m.canKill('flight'), false);
  assert.equal(m.insetAllowed(), false);
  assert.equal(m.toggleFollow(), true);
  assert.equal(m.canKill('flight'), true);
});

test('the sight: only while this screen plans, and the overview and kill cam beat it', () => {
  const m = new CameraModes();
  assert.equal(m.toggleSight(), true);
  assert.equal(m.resolve(planWorld()), 'sight');
  assert.equal(m.resolve(planWorld({ planner: false })), 'plan');        // a CPU's turn or a hand-off card
  assert.equal(m.resolve(flightWorld()), 'hero');                       // it hands the camera back while shells fly...
  assert.equal(m.sight, true);                                         // ...and stays chosen for the next turn
  m.toggleOverview();
  assert.equal(m.resolve(planWorld()), 'overview');
  m.toggleOverview();
  assert.equal(m.resolve(planWorld()), 'sight');
  // Entering the sight leaves the overview; leaving it does not touch it.
  m.toggleSight();
  m.toggleOverview();
  m.toggleSight();
  assert.equal(m.overview, false);
  assert.equal(m.resolve(planWorld()), 'sight');
  // A look does not take the camera from the sight.
  m.look({ id: 1, who: 0, now: 0 });
  assert.equal(m.resolve(planWorld()), 'sight');
});

test('the overview: V toggles it, a look leaves it', () => {
  const m = new CameraModes();
  assert.equal(m.toggleOverview(), true);
  assert.equal(m.resolve(planWorld()), 'overview');
  assert.equal(m.resolve(flightWorld()), 'overview');
  assert.equal(m.resolve(planWorld({ phase: 'roundOver' })), 'overview');
  assert.equal(m.canKill('flight'), false);
  assert.equal(m.insetAllowed(), false);
  m.look({ id: 2, who: 0, now: 0 });
  assert.equal(m.overview, false);
  assert.equal(m.resolve(planWorld()), 'peek');
  m.endLook();
  m.toggleOverview();
  assert.equal(m.toggleOverview(), false);
  assert.equal(m.resolve(planWorld()), 'plan');
});

test('a look lasts three seconds, or until Find lets go, and ends with the turn', () => {
  const m = new CameraModes();
  m.look({ id: 1, who: 0, now: 1000 });
  assert.equal(m.resolve(planWorld({ now: 1000 + LOOK_MS - 1 })), 'peek');
  assert.equal(m.finding(planWorld()), false);                          // a timed look is not Find
  assert.equal(m.resolve(planWorld({ now: 1000 + LOOK_MS })), 'plan');
  assert.equal(m.peek, null);
  // Held by Find.
  m.look({ id: 2, who: 0, hold: true, now: 0 });
  assert.equal(m.finding(planWorld({ now: 1e9 })), true);
  assert.equal(m.resolve(planWorld({ now: 1e9 })), 'peek');
  // The turn passes: gone.
  assert.equal(m.lookLive(planWorld({ current: 1 })), false);
  assert.equal(m.peek, null);
  // The planning ends: gone.
  m.look({ id: 2, who: 0, hold: true, now: 0 });
  assert.equal(m.lookLive(planWorld({ phase: 'volley' })), false);
  // A spot on the ground keeps its place.
  const p = m.look({ who: 0, x: 1, y: 2, z: 3, now: 0 });
  assert.deepEqual([p.id, p.x, p.y, p.z], [null, 1, 2, 3]);
});

test('the kill cam: when it may start, its priority, and how it ends', () => {
  const m = new CameraModes();
  assert.equal(m.canKill('aim'), false);
  assert.equal(m.canKill('flight'), true);
  m.pin();
  assert.equal(m.canKill('flight'), false);
  m.release();
  m.startKill({ id: 7, victim: 1, side: [1, 0], dir: [0, 1] });
  assert.equal(m.canKill('flight'), false);                             // one at a time
  assert.equal(m.kill.end, null);
  m.toggleOverview();
  m.toggleSight();
  assert.equal(m.resolve(flightWorld()), 'kill');                       // beats the overview and the sight
  assert.equal(m.insetAllowed(), false);
  // The shell is still up: no end yet.
  assert.equal(m.stepKill({ shellGone: false, now: 5000 }), false);
  assert.equal(m.kill.end, null);
  // It lands: hold KILLCAM.after seconds, then end.
  assert.equal(m.stepKill({ shellGone: true, now: 6000 }), false);
  assert.equal(m.kill.end, 6000 + KILLCAM.after * 1000);
  assert.equal(m.stepKill({ shellGone: true, now: 6000 + KILLCAM.after * 1000 }), false);
  assert.equal(m.stepKill({ shellGone: true, now: 6001 + KILLCAM.after * 1000 }), true);
  assert.equal(m.kill, null);
  // A new round or the menu cuts it at once.
  m.startKill({ id: 8, victim: 2, side: [1, 0], dir: [0, 1] });
  m.cutKill();
  assert.equal(m.kill, null);
});

test('pinned (debug): no sight, no kill cam, no inset, but the HUD still follows the map', () => {
  const m = new CameraModes();
  m.toggleSight();
  m.pin();
  assert.equal(m.resolve(planWorld()), 'plan');
  assert.equal(m.insetAllowed(), false);
  m.toggleOverview();
  assert.equal(m.resolve(planWorld()), 'overview');
  m.release();
  m.toggleOverview();
  assert.equal(m.resolve(planWorld()), 'sight');
});

test('the marks over the tanks say what the view needs', () => {
  const m = new CameraModes();
  assert.equal(labelMode(m, { phase: 'aim' }), 'name');
  assert.equal(labelMode(m, { phase: 'aim', sight: true }), 'full');
  assert.equal(labelMode(m, { phase: 'aim', looking: true }), 'full');
  assert.equal(labelMode(m, { phase: 'flight' }), 'faint');
  assert.equal(labelMode(m, { phase: 'roundOver' }), 'faint');
  m.toggleFollow();
  assert.equal(labelMode(m, { phase: 'flight' }), 'name');
  m.toggleFollow();
  m.toggleOverview();
  assert.equal(labelMode(m, { phase: 'flight' }), 'full');
  m.startKill({ id: 1, victim: 1, side: [1, 0], dir: [0, 1] });
  assert.equal(labelMode(m, { phase: 'flight', sight: true, looking: true }), 'name');
});

test('the HUD view comes from the mode the camera resolved', () => {
  const m = new CameraModes();
  const view = (world) => hudView({ phase: world.phase, mode: m.resolve(world) });
  assert.equal(view({ inMatch: false }), 'menu');
  assert.equal(view(planWorld()), 'plan');
  assert.equal(view(flightWorld()), 'flight');
  assert.equal(view(planWorld({ phase: 'settle', planner: false })), 'flight');
  assert.equal(view(planWorld({ phase: 'shop', planner: false })), 'between');
  m.toggleSight();
  assert.equal(view(planWorld()), 'sight');
  assert.equal(view(flightWorld()), 'flight');
  m.toggleOverview();
  assert.equal(view(planWorld()), 'overview');
  m.startKill({ id: 1, victim: 1, side: [1, 0], dir: [0, 1] });
  assert.equal(view(flightWorld()), 'kill');
  assert.equal(view(flightWorld({ phase: 'roundOver' })), 'between');
});

// The flags main.js used to keep, and the view they used to give: the mode
// state must give the same view for every combination.
function oldHudView({ phase, sight, overview, killCam }) {
  if (phase === 'roundOver' || phase === 'matchOver' || phase === 'shop') return 'between';
  if (killCam) return 'kill';
  if (overview) return 'overview';
  if (sight && phase === 'aim') return 'sight';
  if (phase === 'volley' || phase === 'flight' || phase === 'settle' || phase === 'wait') return 'flight';
  return 'plan';
}

test('the same HUD view as the old flags, in every combination', () => {
  let n = 0;
  for (const phase of ['aim', 'volley', 'flight', 'settle', 'wait', 'roundOver', 'matchOver', 'shop']) {
    for (let bits = 0; bits < 64; bits++) {
      const [follow, sight, overview, pinned, kill, planner] = [1, 2, 4, 8, 16, 32].map((b) => !!(bits & b));
      if (kill && phase !== 'flight') continue;              // the kill cam only starts in flight (and a new round cuts it)
      const m = new CameraModes();
      Object.assign(m, { follow, sight, overview, pinned, kill: kill ? { id: 1, victim: 1, end: null } : null });
      const world = { inMatch: true, phase, planner: planner && phase === 'aim', current: 0, volleyMode: true, hero: true, shellsInAir: true, shellsShown: true, now: 0 };
      const mode = m.resolve(world);
      // The old code's gunner.active: the sight chosen, not overview, pinned or kill cam, and this screen planning.
      const active = sight && !overview && !pinned && !kill && world.planner;
      assert.equal(hudView({ phase, mode }), oldHudView({ phase, sight: active, overview, killCam: kill }), `${phase} ${bits}`);
      n++;
    }
  }
  assert.equal(n, 288);
});

test('time slows into the kill cam and eases back out', () => {
  let s = 1;
  const kill = { end: null };
  for (let i = 0; i < 10; i++) s = easeTimeScale(s, kill, 0.033);
  assert.ok(s < 0.6 && s > KILLCAM.slow, `eased in to ${s}`);
  for (let i = 0; i < 100; i++) s = easeTimeScale(s, kill, 0.033);
  assert.equal(s, KILLCAM.slow);
  // After the shell lands: a little faster while it holds...
  kill.end = 1;
  for (let i = 0; i < 200; i++) s = easeTimeScale(s, kill, 0.033);
  assert.equal(s, 0.55);
  // ...then back to full speed, more gently than it slowed.
  const out = easeTimeScale(KILLCAM.slow, null, 0.1) - KILLCAM.slow;
  const into = 1 - easeTimeScale(1, { end: null }, 0.1);
  assert.ok(out > 0 && into > 0 && out < into);
  for (let i = 0; i < 200; i++) s = easeTimeScale(s, null, 0.033);
  assert.equal(s, 1);
});

test('the kill cam watches from the side the camera is already on', () => {
  // The shell comes in along +x to the victim at the origin.
  const near = killSide([-100, 0], [0, 0], [0, 50]);
  assert.deepEqual(near.dir, [1, 0]);
  assert.deepEqual(near.side, [-0, 1]);
  const far = killSide([-100, 0], [0, 0], [0, -50]);
  assert.deepEqual(far.side, [0, -1]);
});
