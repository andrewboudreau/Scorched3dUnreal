import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, whose, ammoText, signed, ownedWeapons, jetsText, fuelText, winsText, lastAimText, cardNote, windReadout, roundText,
  roundBanner, turnBanner, bannerDelay, markShows, ghostText, locatorOwner, rangeText, pipHidden, probeColor, probeLabel,
  screenSpot, unstack, rangeOwner, rangeRead, rangeEstimate,
} from '../src/hudlogic.js';

test('words: names, ammo, signs', () => {
  assert.equal(escapeHtml(`<b a="x">'&'</b>`), '&lt;b a=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;');
  assert.equal(whose({ name: 'You' }, 'turn'), 'Your turn');
  assert.equal(whose({ name: ' you ' }, 'shot'), 'Your shot');
  assert.equal(whose({ name: 'Rook' }, 'turn'), "Rook's turn");
  assert.equal(ammoText(Infinity), '∞');
  assert.equal(ammoText(3), '×3');
  assert.equal(signed(1.25), '+1.3');
  assert.equal(signed(-3, 0), '−3');
  assert.equal(signed(0), '+0.0');
});

test('ownedWeapons lists only weapons with rounds left', () => {
  // Hidden ones (a Splitter's bomblets) never show.
  const game = { ammoLeft: (p, id) => (id === 'shell' ? Infinity : id === 'breacher' ? 2 : id === 'splitlet' ? 5 : 0) };
  assert.deepEqual(ownedWeapons(game, {}).map((w) => w.id), ['shell', 'breacher']);
});

test('the player card: jets, fuel, wins, the last shot under each readout', () => {
  assert.equal(jetsText(2), 'J ×2');
  assert.equal(jetsText(0), '×0');
  assert.equal(fuelText(11.96), '12 m');
  assert.equal(fuelText(11.9), '11 m');
  assert.equal(winsText(0), '');
  assert.equal(winsText(2), '★★');
  assert.equal(winsText(5), '★★★5');
  assert.equal(lastAimText({ ai: true, now: 4 }), '');
  assert.equal(lastAimText({ now: 4 }), '—');
  assert.equal(lastAimText({ then: 40, now: 41.5, unit: '°' }), 'last 40.0°<b>+1.5</b>');
  assert.equal(lastAimText({ then: 40, now: 40.01 }), 'last 40.0<b>same</b>');
  // The turret wraps: 350° to 10° is 20° to the right, not 340° back.
  assert.equal(lastAimText({ then: 350, now: 10, unit: '°', wrap: true }), 'last 350.0°<b>+20.0</b>');
  assert.equal(lastAimText({ then: 10, now: 350, unit: '°', wrap: true }), 'last 10.0°<b>−20.0</b>');
  assert.equal(roundText(2, 5), 'Round 2 / 5');
});

test('the card note: a driving note while it lasts, then being buried', () => {
  const note = { text: 'Out of fuel', until: 1000 };
  assert.equal(cardNote({ note, now: 500, phase: 'aim' }), 'Out of fuel');
  assert.equal(cardNote({ note, now: 1500, phase: 'aim' }), '');
  assert.equal(cardNote({ note, now: 500, phase: 'flight' }), '');
  assert.equal(cardNote({ note, now: 500, phase: 'aim', ai: true, buried: true }), '');
  assert.equal(cardNote({ note, now: 1500, phase: 'aim', buried: true }), 'Buried: your next shot digs you out');
});

test('the wind readout turns with the tank on the card', () => {
  const calm = windReadout([0, 0], 30);
  assert.equal(calm.speed, 'calm');
  assert.equal(calm.opacity, 0.2);
  assert.equal(calm.aim, '');
  // Aiming along +x (yaw 0) with the wind blowing +x: it carries the shot longer, the arrow points up.
  const tail = windReadout([1.2, 0], 0);
  assert.equal(tail.speed, '12');
  assert.equal(tail.aim, '12 longer');
  assert.equal(tail.deg, -90);
  // The same wind, aiming along +z (yaw 90): it pushes the shot to the left.
  const cross = windReadout([1.2, 0], 90);
  assert.equal(cross.aim, '12 left');
  const both = windReadout([0.6, 0.6], 0);
  assert.equal(both.aim, '6 right · 6 longer');
});

test('round banners: the first round names the kit, a twist holds the turn banner', () => {
  const clear = { id: 'clear', name: 'Clear', desc: '' };
  const rain = { id: 'rain', name: 'Rain', desc: 'Shells slow down.' };
  assert.deepEqual(roundBanner({ round: 1, rounds: 3, mod: clear, cond: 'Hilly · Calm wind', kit: 'Shells' }),
    { text: 'Round 1', sub: 'of 3 · Hilly · Calm wind · Your kit: Shells', ms: 3200, hold: 0 });
  assert.deepEqual(roundBanner({ round: 2, rounds: 3, mod: clear, cond: 'Hilly' }), { text: 'Round 2', sub: 'of 3 · Hilly', ms: 1800, hold: 0 });
  assert.deepEqual(roundBanner({ round: 1, rounds: 3, mod: rain, cond: 'Hilly', kit: 'Shells' }),
    { text: 'Round 1: Rain', sub: 'Shells slow down. Hilly · Your kit: Shells', ms: 3600, hold: 2800 });
  assert.deepEqual(roundBanner({ round: 2, rounds: 3, mod: rain, edge: 'Bouncing edges' }),
    { text: 'Round 2: Rain', sub: 'Shells slow down. · Bouncing edges', ms: 3000, hold: 2800 });
  assert.equal(roundBanner({ round: 2, rounds: 3, mod: rain, edge: '' }).sub, 'Shells slow down.');
});

test('turn banners: whose turn, the CPUs, and the Lock in coaching', () => {
  const you = { name: 'You', ai: null }, cpu = { name: 'Rook', ai: 'hard' };
  assert.deepEqual(turnBanner(you), ['Your turn', 'Aim and fire', 1100]);
  assert.deepEqual(turnBanner(cpu), ["Rook's turn", 'CPU · hard', 1100]);
  assert.deepEqual(turnBanner(cpu, { plan: true }), ['Rook is on the move', 'CPU · hard', 1100]);
  assert.deepEqual(turnBanner(you, { plan: true }), ['Your shot', 'Plan it, then Space to lock it in', 1700]);
  assert.deepEqual(turnBanner(you, { plan: true, touch: true }), ['Your shot', 'Plan it, then tap Lock in', 1700]);
  assert.deepEqual(turnBanner(you, { plan: true, touch: true, coach: false }), ['Your shot', '', 1000]);
  assert.equal(bannerDelay(0, 5000), 50);
  assert.equal(bannerDelay(7800, 5000), 2800);
});

test('a mark over a tank shows only when it is alive, seen and on screen', () => {
  const v = { x: 0.2, y: -0.3, z: 0.9 };
  assert.equal(markShows({ alive: true, seen: true, v }), true);
  assert.equal(markShows({ alive: false, seen: true, v }), false);
  assert.equal(markShows({ alive: true, seen: false, v }), false);
  assert.equal(markShows({ alive: true, seen: true, v: { ...v, z: 1.2 } }), false);
  assert.equal(markShows({ alive: true, seen: true, v: { ...v, x: 1.15 } }), false);
  assert.equal(markShows({ alive: true, seen: true, v: { ...v, x: 1.05 } }), true);
  assert.equal(markShows({ alive: true, seen: true, v, ownInSight: true }), false);
});

test('fog ghosts say how old the sighting is', () => {
  assert.equal(ghostText({ r: 0, ago: 0 }), 'last seen here');
  assert.equal(ghostText({ r: 30, ago: 1 }), 'roughly here, 1 turn ago');
  assert.equal(ghostText({ r: 0, ago: 3, volley: true }), 'last seen here, 3 volleys ago');
});

test('edge arrows show only to a human planning outside the sight and the map', () => {
  const me = { ai: null }, cpu = { ai: 'easy' };
  assert.equal(locatorOwner({ phase: 'aim', current: me, mode: 'plan' }), me);
  assert.equal(locatorOwner({ phase: 'aim', current: me, mode: 'peek' }), me);
  assert.equal(locatorOwner({ phase: 'aim', current: me, mode: 'sight' }), null);
  assert.equal(locatorOwner({ phase: 'aim', current: me, mode: 'plan', overview: true }), null);
  assert.equal(locatorOwner({ phase: 'aim', current: me, mode: 'plan', handoff: true }), null);
  assert.equal(locatorOwner({ phase: 'flight', current: me, mode: 'follow' }), null);
  assert.equal(locatorOwner({ phase: 'aim', current: cpu, mode: 'plan' }), null);
  assert.equal(locatorOwner({ phase: 'aim', current: null, mode: 'plan' }), null);
  assert.equal(rangeText({ x: 30, z: 40, r: 0 }, { x: 0, z: 0 }), '50 m');
  assert.equal(rangeText({ x: 30, z: 40, r: 12 }, { x: 0, z: 0 }), '~50 m');
});

test('pips: hidden behind a hand-off, and a probe shows only to its owner while planning', () => {
  const cur = { id: 1 };
  assert.equal(pipHidden({ handoff: true, phase: 'flight' }), true);
  assert.equal(pipHidden({ phase: 'aim', current: cur, owner: 0 }), false);
  assert.equal(pipHidden({ sticky: true, phase: 'aim', current: cur, owner: 0 }), true);
  assert.equal(pipHidden({ sticky: true, phase: 'aim', current: cur, owner: 1 }), false);
  assert.equal(pipHidden({ sticky: true, phase: 'flight', current: cur, owner: 0 }), false);
  assert.equal(probeColor('aim'), '#ffffff');
  assert.equal(probeColor('turn-'), '#ffc35a');
  assert.equal(probeColor('power+'), '#6fe3ff');
  assert.equal(probeLabel({ key: 'aim' }), 'as aimed');
  assert.equal(probeLabel({ key: 'turn+', yaw: 12.345 }), 'turret 12.3°');
  assert.equal(probeLabel({ key: 'power-', power: 61.04 }), 'power 61.0');
});

test('screenSpot: on screen as is, off screen pulled to an edge clear of the panels', () => {
  const on = screenSpot({ x: 0, y: 0, z: 0.5 }, 800, 400);
  assert.deepEqual([on.sx, on.sy, on.off], [400, 200, false]);
  const right = screenSpot({ x: 3, y: 0, z: 0.5 }, 800, 400);
  assert.equal(right.off, true);
  assert.equal(right.sx, 720);
  assert.equal(right.sy, 200);
  assert.equal(Math.abs(right.angle), 0);
  // Behind the camera: mirrored, so the arrow points the way to turn.
  const behind = screenSpot({ x: 0.5, y: 0, z: 1.5 }, 800, 400);
  assert.equal(behind.off, true);
  assert.equal(behind.sx, 80);
  // A panel in the way pushes it down below the panel.
  const left = screenSpot({ x: -3, y: 0.5, z: 0.5 }, 800, 400, [{ left: 0, right: 200, top: 0, bottom: 180, width: 200 }]);
  assert.equal(left.sx, 80);
  assert.equal(left.sy, 205);
  // A panel with no width (display: none) is ignored.
  assert.equal(screenSpot({ x: -3, y: 0.5, z: 0.5 }, 800, 400, [{ left: 0, right: 200, top: 0, bottom: 180, width: 0 }]).sy.toFixed(1), '166.7');
});

test('unstack slides edge markers apart along their edge', () => {
  const placed = [];
  const a = screenSpot({ x: 3, y: 0, z: 0.5 }, 800, 400);
  const b = screenSpot({ x: 3, y: 0.05, z: 0.5 }, 800, 400);
  unstack(a, placed);
  unstack(b, placed);
  assert.equal(placed.length, 2);
  assert.equal(a.sy, 200);
  assert.ok(Math.abs(b.sy - a.sy) >= 34, `${b.sy} vs ${a.sy}`);
  const top1 = screenSpot({ x: 0, y: 3, z: 0.5 }, 800, 400), top2 = screenSpot({ x: 0.01, y: 3, z: 0.5 }, 800, 400);
  const row = [];
  unstack(top1, row);
  unstack(top2, row);
  assert.equal(top2.sx - top1.sx >= 34, true);
  assert.equal(top2.sy, top1.sy);
});

test('rangeOwner: the planner while planning, your own tank while shells fly', () => {
  const me = { id: 0, ai: null }, cpu = { id: 1, ai: 'easy' };
  const game = { phase: 'aim', current: me, players: [me, cpu], localHumans: [me] };
  assert.equal(rangeOwner(null), null);
  assert.equal(rangeOwner(game), me);
  assert.equal(rangeOwner(game, { handoff: true }), null);
  assert.equal(rangeOwner({ ...game, current: cpu }), null);
  assert.equal(rangeOwner({ ...game, phase: 'flight' }), me);
  assert.equal(rangeOwner({ ...game, phase: 'flight', localHumans: [me, cpu] }), null);
  assert.equal(rangeOwner({ ...game, phase: 'flight', localHumans: [me, cpu] }, { heroId: 1 }), cpu);
});

test('the range card words', () => {
  assert.equal(rangeRead({ side: 1, along: 1 }, 10, 'Rook'), 'As aimed: on Rook');
  assert.equal(rangeRead({ side: -6.4, along: 22.5 }, 5, 'Rook'), 'As aimed: 23 m short, 6 m right of Rook');
  assert.equal(rangeRead({ side: 9, along: -12 }, 5, 'Rook'), 'As aimed: 12 m long, 9 m left of Rook');
  const lim = { minPower: 10, maxPower: 100 };
  assert.equal(rangeEstimate(null, lim), 'Too far off to estimate: aim again and probe.');
  assert.equal(rangeEstimate({ dYaw: 30, dPower: 0 }, lim), 'Too far off to estimate: aim again and probe.');
  assert.equal(rangeEstimate({ yaw: 40, dYaw: 2, power: 120, dPower: 5 }, lim), 'Needs power 120: change the elevation.');
  assert.equal(rangeEstimate({ yaw: 40.26, dYaw: 2.26, power: 60, dPower: -5 }, lim), 'Try turret 40.3° (+2.3), power 60.0 (−5.0)');
  assert.equal(rangeEstimate({ yaw: 40, dYaw: 0, power: 60, dPower: 0 }, { ...lim, moved: true, elevOff: true, elev: 45, windOff: true }),
    'Try turret 40.0° (+0.0), power 60.0 (+0.0)<small>Rough: you have moved, probed at 45.0° elevation, the wind has shifted.</small>');
});
