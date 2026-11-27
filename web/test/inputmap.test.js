import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyRoute, heldAxes, holdRamp, aimLive, steerDir, pointerRoute, steerSide, dragRoute, wheelRoute, sightAim, pinchSteps, DRAG_SLOP } from '../src/inputmap.js';
import { MODES } from '../src/cameramode.js';

const match = (over = {}) => ({ inMatch: true, handoff: false, online: false, repeat: false, shift: false, ctrl: false, ...over });
const act = (k, over) => keyRoute(k, match(over)).action;

test('each key in a match has its action', () => {
  const want = { ' ': 'fire', tab: 'weapon', j: 'jet', f: 'find', g: 'sight', c: 'follow', v: 'view', m: 'mute', '-': 'volume', '=': 'volume', '+': 'volume', n: 'music', x: 'strike', b: 'deploy' };
  for (const [k, a] of Object.entries(want)) assert.equal(act(k), a, k);
  for (let i = 1; i <= 9; i++) assert.deepEqual([act(String(i)), keyRoute(String(i), match()).arg], ['slot', i - 1]);
  for (const k of ['0', 'a', 'd', 'w', 's', 'q', 'e', 'arrowup', 'shift', 'pageup', 'enter', 'escape', 'k']) assert.equal(act(k), null, k);
});

test('arguments: weapon step, volume step', () => {
  assert.equal(keyRoute('tab', match()).arg, 1);
  assert.equal(keyRoute('tab', match({ shift: true })).arg, -1);
  assert.equal(keyRoute('-', match()).arg, -0.1);
  assert.equal(keyRoute('=', match()).arg, 0.1);
  assert.equal(keyRoute('+', match()).arg, 0.1);
});

test('Tab, the arrows and Space keep the browser off them', () => {
  for (const k of ['tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ']) assert.equal(keyRoute(k, match()).prevent, true, k);
  for (const k of ['j', 'g', '1', 'b']) assert.equal(keyRoute(k, match()).prevent, false, k);
  // On the menu Tab and the arrows still do not scroll; Space does nothing at all.
  assert.equal(keyRoute('tab', match({ inMatch: false })).prevent, true);
  assert.equal(keyRoute('arrowleft', match({ inMatch: false })).prevent, true);
  assert.equal(keyRoute(' ', match({ inMatch: false })).prevent, false);
});

test('every key is held, except Enter opening the chat', () => {
  for (const k of ['a', ' ', 'shift', 'arrowup', 'g']) {
    for (const over of [{}, { inMatch: false }, { repeat: true }, { handoff: true }]) assert.equal(keyRoute(k, match(over)).hold, true, `${k} ${JSON.stringify(over)}`);
  }
  assert.equal(keyRoute('enter', match({ online: true })).hold, false);
});

test('repeats and the menu do nothing', () => {
  for (const k of [' ', 'tab', 'g', 'v', '3', 'x', 'b']) {
    assert.equal(act(k, { repeat: true }), null, k);
    assert.equal(act(k, { inMatch: false }), null, k);
  }
});

test('Enter opens the chat online, on the menu too, but not over the hand-off card', () => {
  const r = keyRoute('enter', match({ online: true }));
  assert.deepEqual([r.action, r.prevent], ['chat', true]);
  assert.equal(act('enter', { online: true, inMatch: false }), 'chat');
  assert.equal(act('enter', { online: true, repeat: true }), 'chat');
  assert.equal(act('enter', { online: false }), null);
  assert.equal(act('enter', { online: true, handoff: true }), 'handoff-go');
});

test('the hand-off card: Space or Enter, and every key lets go of the held ones', () => {
  for (const k of [' ', 'enter']) {
    const r = keyRoute(k, match({ handoff: true }));
    assert.deepEqual([r.action, r.prevent, r.clear], ['handoff-go', true, true], k);
  }
  for (const k of ['g', 'v', 'tab', '1', 'x', 'b', 'a']) {
    const r = keyRoute(k, match({ handoff: true }));
    assert.deepEqual([r.action, r.clear], [null, true], k);
  }
  // A repeat under the card is just held (it does not clear).
  assert.equal(keyRoute('a', match({ handoff: true, repeat: true })).clear, false);
});

test('B with Ctrl or Cmd is not a deploy', () => {
  assert.equal(act('b', { ctrl: true }), null);
  assert.equal(act('x', { ctrl: true }), 'strike');
});

test('held keys: the aim, the power, the drive', () => {
  const h = (...k) => heldAxes(new Set(k));
  assert.deepEqual(h(), { yaw: 0, elev: 0, power: 0, fast: 1, go: 0, turn: 0 });
  assert.equal(h('d').yaw, 1);
  assert.equal(h('a').yaw, -1);
  assert.equal(h('a', 'd').yaw, 0);
  assert.equal(h('w').elev, 1);
  assert.equal(h('s').elev, -1);
  assert.equal(h('e').power, 1);
  assert.equal(h('pageup').power, 1);
  assert.equal(h('q').power, -1);
  assert.equal(h('pagedown').power, -1);
  assert.equal(h('e', 'pageup', 'q').power, 0);
  assert.equal(h('shift').fast, 3);
  assert.equal(h('arrowup').go, 1);
  assert.equal(h('arrowdown').go, -1);
  assert.equal(h('arrowright').turn, 1);
  assert.equal(h('arrowleft').turn, -1);
  // The arrows drive; they do not aim.
  assert.equal(h('arrowleft').yaw, 0);
});

test('the hold ramp: a tap is fine, a hold reaches full speed in about a third of a second', () => {
  assert.equal(holdRamp(0), 0.25);
  assert.equal(holdRamp(0.1), 0.25);
  assert.ok(Math.abs(holdRamp(0.2) - 0.49) < 1e-9);
  assert.equal(holdRamp(0.37), 1);
  assert.equal(holdRamp(5), 1);
});

test('held keys aim only while a human here aims', () => {
  const s = (over) => aimLive({ inMatch: true, handoff: false, phase: 'aim', human: true, ...over });
  assert.equal(s(), true);
  assert.equal(s({ inMatch: false }), false);
  assert.equal(s({ handoff: true }), false);
  assert.equal(s({ human: false }), false);
  for (const phase of ['flight', 'volley', 'settle', 'roundOver', 'shop']) assert.equal(s({ phase }), false, phase);
});

test('steering: A / D, the side arrows and fingers', () => {
  const d = (k, f) => steerDir(new Set(k), f);
  assert.equal(d([]), 0);
  assert.equal(d(['d']), 1);
  assert.equal(d(['arrowright']), 1);
  assert.equal(d(['a']), -1);
  assert.equal(d(['arrowleft']), -1);
  assert.equal(d(['a', 'arrowright']), 0);
  assert.equal(d(['d', 'arrowright']), 1);
  assert.equal(d([], -2), -1);
  assert.equal(d(['d'], -2), -1);
  assert.equal(d(['d'], -1), 0);
  assert.equal(steerSide(100, 800), -1);
  assert.equal(steerSide(400, 800), 1);
});

test('a finger on the view steers only on a touch screen with a guided missile in hand', () => {
  assert.equal(pointerRoute({ touch: true, steering: true, onView: true }), 'steer');
  assert.equal(pointerRoute({ touch: false, steering: true, onView: true }), 'view');
  assert.equal(pointerRoute({ touch: true, steering: false, onView: true }), 'view');
  assert.equal(pointerRoute({ touch: true, steering: true, onView: false }), 'view');
});

test('the view by camera mode: the sight aims and zooms, every other mode orbits', () => {
  for (const mode of MODES) {
    const sight = mode === 'sight';
    assert.equal(dragRoute({ sight, fingers: 1 }), sight ? 'aim' : 'orbit', mode);
    assert.equal(dragRoute({ sight, fingers: 2 }), sight ? 'zoom' : 'orbit', mode);
    assert.equal(wheelRoute({ sight }), sight ? 'zoom' : 'orbit', mode);
  }
});

test('the keys do the same in every camera mode', () => {
  // The kill cam, the overview and the sight all take them; each action keeps its own rules.
  const keys = [' ', 'tab', '1', 'j', 'f', 'g', 'c', 'v', 'm', '-', 'n', 'x', 'b'];
  const base = keys.map((k) => act(k));
  for (const mode of MODES) assert.deepEqual(keys.map((k) => act(k, { mode })), base, mode);
});

test('the sight drag and pinch', () => {
  // 55 degrees over 550 px: 0.1 degree a pixel across, half that up and down.
  const [yaw, elev] = sightAim(10, -20, 55, 550);
  assert.ok(Math.abs(yaw - 1) < 1e-9);
  assert.ok(Math.abs(elev - 1) < 1e-9);
  assert.equal(pinchSteps(100, 100), 0);
  assert.ok(pinchSteps(100, 200) < 0);    // spreading zooms in (narrower view)
  assert.ok(pinchSteps(200, 100) > 0);
  assert.ok(Math.abs(pinchSteps(Math.exp(0.12), 1) - 1) < 1e-9);
  assert.equal(pinchSteps(0, 100), 0);
  assert.equal(pinchSteps(100, 0), 0);
  assert.equal(DRAG_SLOP, 4);
});
