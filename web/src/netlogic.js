// The rules behind online.js (the room and the match played through it): the
// clock that keeps a room moving, what the lobby and the room list say. No
// three.js and no DOM (the room list is an HTML string), so it is tested in
// test/netlogic.test.js.

import { escapeHtml } from './hudlogic.js';

// Online, nobody holds the room up for long: a minute to plan a shot (then it
// goes as aimed), a minute and a half in the armory. The countdown shows for
// the last `show` seconds. (window.craterfall.netClock is this object, so a
// test can shorten it.)
export const NET_CLOCK = { aim: 60, shop: 90, show: 20 };

// What this screen's clock is timing, if anything: its human planning a shot,
// or its shopper in the armory. `key` names the turn, so a new one restarts it.
export function clockFor(g, shopPid, clock = NET_CLOCK) {
  if (g && g.phase === 'aim' && g.current && !g.current.ai && g.isLocal(g.current)) return { key: `aim ${g.volleyKey} ${g.current.id}`, limit: clock.aim };
  if (g && g.phase === 'shop' && shopPid != null) return { key: `shop ${g.round} ${shopPid}`, limit: clock.shop };
  return { key: null, limit: 0 };
}

// One step of the clock at `now` (seconds). `was` is { key, start } from the
// last step; a clock that ran out is kept as `<key> out` so it fires once.
// Returns the new { key, start } and the seconds `left` (Infinity: no clock).
export function clockStep(was, key, limit, now) {
  let { key: clockKey, start } = was;
  if (key !== clockKey && !(clockKey && clockKey.startsWith(`${key} `))) { clockKey = key; start = now; }
  const left = key && clockKey === key ? limit - (now - start) : Infinity;
  return { key: clockKey, start, left };
}

export const clockShows = (left, clock = NET_CLOCK) => left <= clock.show;

export const clockText = (left, key) => `${Math.max(0, Math.ceil(left))}s to ${key.startsWith('aim') ? 'lock in your shot' : 'finish shopping'}`;

// "Waiting for Ana, Bo…", or '' when nobody is waited on.
export const waitText = (names) => (names.length ? `Waiting for ${names.join(', ')}…` : '');

// Why joining or making a room failed, for the note under the buttons.
export const joinError = (err) => (err.message === 'Failed to fetch' ? 'Could not reach the server.' : err.message);

// The lobby's Start button, for `n` tanks (people and CPUs).
export const startLabel = (n) => `Start online match · ${n} tank${n === 1 ? '' : 's'}`;

// The `lobby` message the host sends so every guest sees its CPU tanks: from
// the setup rows (everything that is not a human), or null when the list is
// the same as `last` (the JSON of the message last sent; '' for none yet).
export function lobbyMessage(rows, last = '') {
  const cpus = rows.filter((r) => r.type !== 'human').map((r, i) => ({ name: r.name.trim() || `CPU ${i + 1}`, ai: r.type }));
  const msg = { t: 'lobby', cpus };
  return JSON.stringify(msg) === last ? null : msg;
}

// The lobby's CPU rows ({ name, type }, as the setup card has them): the
// host's own rows, or, on a guest, the list the host sent (session.cpus).
export const lobbyCpuRows = (isHost, rows, sent) => (isHost ? rows.filter((r) => r.type !== 'human') : sent.map((c) => ({ name: c.name, type: c.ai })));

// The note under the lobby: what to do next, for the host or a guest.
export function lobbyNote({ isHost, seats, touch }) {
  const chat = touch ? '' : ' Press Enter to chat.';
  if (!isHost) return `Waiting for the host to start the match.${chat}`;
  return seats < 2 ? 'Send your friends the invite link, or the code. Everyone in the room plays; CPUs are optional.' : `Start when everyone is in.${chat}`;
}

// The room list's rows (open rooms have a Join button), or '' in a room or
// with no answer from the server.
export function roomsHtml(data, inRoom) {
  if (inRoom || !data) return '';
  if (!data.rooms.length) return '<div class="room-empty">None yet. Create one and it shows here for everyone.</div>';
  return data.rooms.map((r) => `
      <div class="room-row ${r.open ? '' : 'busy'}">
        <span class="room-host">${escapeHtml(r.host)}'s room</span>
        <span class="room-players">${r.players.map(escapeHtml).join(', ')}</span>
        <span class="room-count">${r.players.length}/6</span>
        ${r.open ? `<button data-code="${escapeHtml(r.code)}">Join</button>` : `<span class="room-tag">${r.started ? 'playing' : 'full'}</span>`}
      </div>`).join('');
}

// The count on the Online tab: rooms open to join ('' for none, or in a room).
export function openRoomsCount(data, inRoom) {
  const open = data?.rooms?.filter((r) => r.open).length || 0;
  return open && !inRoom ? String(open) : '';
}

// "Also on the menu: Ana, Bo, 3 more" (HTML), or ''.
export function menuLine(data) {
  const m = data?.menu;
  const others = !m || !m.count ? ''
    : `Also on the menu: ${[...m.names, ...(m.count > m.names.length ? [`${m.count - m.names.length} more`] : [])].map(escapeHtml).join(', ')}`;
  return data ? others : '';
}
