import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NET_CLOCK, clockFor, clockStep, clockShows, clockText, waitText, joinError, startLabel, lobbyNote, roomsHtml, openRoomsCount, menuLine, lobbyMessage, lobbyCpuRows,
} from '../src/netlogic.js';

const game = (o = {}) => ({ phase: 'aim', current: { id: 2, ai: null }, volleyKey: '1:3', round: 1, isLocal: () => true, ...o });

test('the clock times this screen\'s human planning, or its shopper', () => {
  assert.deepEqual(clockFor(game(), null), { key: 'aim 1:3 2', limit: NET_CLOCK.aim });
  assert.deepEqual(clockFor(game({ isLocal: () => false }), null), { key: null, limit: 0 });
  assert.deepEqual(clockFor(game({ current: { id: 2, ai: 'hard' } }), null), { key: null, limit: 0 });
  assert.deepEqual(clockFor(game({ phase: 'shop' }), 1), { key: 'shop 1 1', limit: NET_CLOCK.shop });
  assert.deepEqual(clockFor(game({ phase: 'shop' }), null), { key: null, limit: 0 });
  assert.deepEqual(clockFor(null, 1), { key: null, limit: 0 });
  assert.equal(clockFor(game(), null, { aim: 5 }).limit, 5);
});

test('the clock starts on a new turn, counts down and fires once', () => {
  let c = clockStep({ key: null, start: 0 }, 'aim k 0', 60, 100);
  assert.deepEqual(c, { key: 'aim k 0', start: 100, left: 60 });
  c = clockStep(c, 'aim k 0', 60, 130);
  assert.equal(c.left, 30);
  assert.equal(clockShows(c.left), false);
  c = clockStep(c, 'aim k 0', 60, 145);
  assert.equal(clockShows(c.left), true);
  assert.equal(clockText(c.left, c.key), '15s to lock in your shot');
  c = clockStep(c, 'aim k 0', 60, 161);
  assert.ok(c.left <= 0);
  // Once out, main marks it `<key> out`: it stays out (no new start) and does not fire again.
  const out = clockStep({ key: 'aim k 0 out', start: c.start }, 'aim k 0', 60, 170);
  assert.deepEqual(out, { key: 'aim k 0 out', start: c.start, left: Infinity });
  // No clock: Infinity.
  assert.equal(clockStep(c, null, 0, 170).left, Infinity);
  assert.equal(clockText(-2, 'shop 1 0'), '0s to finish shopping');
});

test('lobby and room list words', () => {
  assert.equal(waitText([]), '');
  assert.equal(waitText(['Ana', 'Bo']), 'Waiting for Ana, Bo…');
  assert.equal(joinError(new Error('Failed to fetch')), 'Could not reach the server.');
  assert.equal(joinError(new Error('Room is full')), 'Room is full');
  assert.equal(startLabel(1), 'Start online match · 1 tank');
  assert.equal(startLabel(3), 'Start online match · 3 tanks');
  assert.match(lobbyNote({ isHost: true, seats: 1, touch: false }), /^Send your friends/);
  assert.equal(lobbyNote({ isHost: true, seats: 2, touch: false }), 'Start when everyone is in. Press Enter to chat.');
  assert.equal(lobbyNote({ isHost: true, seats: 2, touch: true }), 'Start when everyone is in.');
  assert.equal(lobbyNote({ isHost: false, seats: 2, touch: false }), 'Waiting for the host to start the match. Press Enter to chat.');
});

test('the room list', () => {
  const data = {
    rooms: [{ code: 'ABCD', host: '<Ana>', players: ['<Ana>', 'Bo'], open: true }, { code: 'WXYZ', host: 'Cy', players: ['Cy'], open: false, started: true }],
    menu: { count: 4, names: ['Di', 'Ed'] },
  };
  const html = roomsHtml(data, false);
  assert.match(html, /&lt;Ana&gt;'s room/);
  assert.match(html, /<button data-code="ABCD">Join<\/button>/);
  assert.match(html, /room-row busy[\s\S]*<span class="room-tag">playing<\/span>/);
  assert.equal(roomsHtml(data, true), '');
  assert.equal(roomsHtml(null, false), '');
  assert.match(roomsHtml({ rooms: [] }, false), /None yet/);
  assert.equal(openRoomsCount(data, false), '1');
  assert.equal(openRoomsCount(data, true), '');
  assert.equal(openRoomsCount(null, false), '');
  assert.equal(menuLine(data), 'Also on the menu: Di, Ed, 2 more');
  assert.equal(menuLine({ rooms: [], menu: { count: 0, names: [] } }), '');
  assert.equal(menuLine(null), '');
});

test('the host lobby message lists its CPU tanks, and says nothing when they have not changed', () => {
  const rows = [{ name: 'Me', type: 'human' }, { name: 'Rook', type: 'normal' }, { name: ' ', type: 'hard' }];
  const msg = lobbyMessage(rows);
  assert.deepEqual(msg, { t: 'lobby', cpus: [{ name: 'Rook', ai: 'normal' }, { name: 'CPU 2', ai: 'hard' }] });
  assert.equal(lobbyMessage(rows, JSON.stringify(msg)), null);
  rows[1].type = 'easy';
  assert.equal(lobbyMessage(rows, JSON.stringify(msg)).cpus[0].ai, 'easy');
  assert.deepEqual(lobbyMessage([{ name: 'Me', type: 'human' }]), { t: 'lobby', cpus: [] });
});

test('a guest lobby shows the CPUs the host sent, and counts them in the Start label', () => {
  const rows = [{ name: 'Me', type: 'human' }, { name: 'Rook', type: 'normal' }];
  assert.deepEqual(lobbyCpuRows(true, rows, []), [{ name: 'Rook', type: 'normal' }]);
  const sent = [{ name: 'Vex', ai: 'hard' }, { name: 'Ivo', ai: 'easy' }];
  const cpus = lobbyCpuRows(false, rows, sent);
  assert.deepEqual(cpus, [{ name: 'Vex', type: 'hard' }, { name: 'Ivo', type: 'easy' }]);
  assert.equal(startLabel(2 + cpus.length), 'Start online match · 4 tanks');   // two people and two CPUs
  assert.deepEqual(lobbyCpuRows(false, rows, []), []);   // nothing sent yet
});
