import { PLAYER_COLORS } from './core/game.js';
import { Session, winnerSeat } from './core/netplay.js';
import { RoomLink, listRooms } from './net.js';
import { profile } from './profile.js';
import { showLaunchTab } from './launch.js';
import { escapeHtml } from './hudlogic.js';
import {
  NET_CLOCK, clockFor, clockStep, clockShows, clockText, waitText, joinError, startLabel, lobbyNote, roomsHtml, openRoomsCount, menuLine, lobbyMessage, lobbyCpuRows,
} from './netlogic.js';

// Online play on screen: a room on the server (net.js RoomLink, `link`) and
// the match played through it (core/netplay.js Session, `session`); both null
// when playing on this screen only.
//
//   create / join   goOnline(how): the Create and Join buttons, a row of the
//                   room list, or an invite link (?room=CODE); a reload takes
//                   this tab's seat back (sessionStorage)
//   the lobby       renderLobby: the setup card shows the room's people and
//                   the host's CPUs; the host's Start sends the match
//                   (setup.js), and every screen starts it from the room's
//                   start message (Session onStart -> match.start)
//   the match       update() each frame: the session reads the room (the host
//                   sends its verdict at the end of each volley, the others
//                   wait for it in core/netplay.js), the "Waiting for ..."
//                   line, the skills and armory cards follow the room, the
//                   clock that keeps the room moving, the note when a CPU has
//                   taken this screen's tank
//   the end         result(game) from the match-over card: the host reports
//                   the winner's seat for the players' records. If the room
//                   goes away (the server's stop, "Connection problem: ...",
//                   the host leaving, a lost link) ended() says so and goes
//                   back to the menu
//   chat            Enter to talk (input.js opens it), in the lobby or the match
//   the room list   open rooms, matches being played and who else is on the
//                   menu, polled while the setup card is up
//
// The rules (the clock, the lobby's and the room list's words) are
// netlogic.js (tested); the lockstep itself is test/lockstep.js's to check.
//
// deps: match (start, game, shopPid, shopQueue, nextShopper, again), setup
// (rows, render), sound, banner, touch, input (held).

const $ = (id) => document.getElementById(id);
const ROOM_KEY = 'craterfall.room';   // this tab's seat, so a reload can take it back

export class Online {
  constructor(deps) {
    this.d = deps;
    this.link = null;
    this.session = null;
    this.lobbySig = '';
    this.clock = { key: null, start: 0 };
    this.roomsSig = '';
    this.roomsBusy = false;

    $('chat-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = e.target.value.trim().slice(0, 120);
        if (text && this.link) this.link.send({ t: 'say', text });
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
    $('chat-input').addEventListener('blur', () => this.closeChat());

    // Who is on the menu, for the room list.
    this.visitorId = sessionStorage.getItem('craterfall.visitor') || Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('craterfall.visitor', this.visitorId);
    $('net-rooms').addEventListener('click', (e) => {
      const code = e.target.closest('button[data-code]')?.dataset.code;
      if (!code) return;
      $('net-code').value = code;
      this.goOnline('join');
    });
    setInterval(() => this.refreshRooms(), 4000);
    $('tab-online').addEventListener('click', () => this.refreshRooms());   // fresh the moment the tab opens
    this.refreshRooms();

    $('net-ended-ok').onclick = () => {
      $('net-ended').classList.add('hidden');
      for (const id of ['roundover', 'draft', 'shop', 'matchover']) $(id).classList.add('hidden');
      this.d.match.again();
    };
    $('net-create').onclick = () => this.goOnline('create');
    $('net-join').onclick = () => this.goOnline('join');
    $('net-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.goOnline('join'); e.stopPropagation(); });
    $('net-name').addEventListener('keydown', (e) => e.stopPropagation());
    $('net-leave').onclick = () => { this.leave(); this.d.setup.render(); };
    $('net-copy').onclick = async () => {
      const url = `${location.origin}${location.pathname}?room=${this.link.code}`;
      try { await navigator.clipboard.writeText(url); $('net-note').textContent = `Copied: ${url}`; } catch { $('net-note').textContent = url; }
    };
    // Your name is the player's (profile.js): saved here and on the server. The
    // launch screen (launch.js) copies it onto the first tank as it is typed.
    $('net-name').value = profile.name;
    $('net-name').addEventListener('change', () => { profile.setName($('net-name').value); });
    {
      const was = profile.name;   // from localStorage; the server's may differ
      profile.ready.then(() => {
        if ($('net-name').value !== was || profile.name === was) return;
        $('net-name').value = profile.name;
        $('net-name').dispatchEvent(new Event('input'));
      });
    }
    {
      const code = new URLSearchParams(location.search).get('room');
      const saved = JSON.parse(sessionStorage.getItem(ROOM_KEY) || 'null');
      if (code && saved && saved.code === code.toUpperCase()) {
        // This tab was in the room before a reload: take the seat back.
        this.link = new RoomLink();
        this.link.resume(saved);
        this.enterRoom(true);
      } else if (code) {
        $('net-code').value = code.toUpperCase().slice(0, 4);
        showLaunchTab('online');
        $('net-note').textContent = 'You have an invite: type your name and press Join with code.';
      }
    }
  }

  lobbySeats() { return this.session ? this.session.seats.filter((s) => !s.gone) : []; }
  // The CPU tanks in the lobby: the host's own rows, or the list the host sent a guest.
  lobbyCpus() { return lobbyCpuRows(!this.session || this.session.isHost, this.d.setup.rows, this.session?.cpus || []); }
  netName() { return ($('net-name').value.trim() || this.d.setup.rows.find((r) => r.type === 'human')?.name || 'Player').slice(0, 14); }

  async goOnline(how) {
    this.d.sound.ensure();
    if (this.link) return;
    const code = $('net-code').value.trim();
    if (how === 'join' && code.length !== 4) { $('net-note').textContent = 'Type the 4-letter room code first.'; return; }
    $('net-note').textContent = how === 'join' ? 'Joining…' : 'Making a room…';
    if ($('net-name').value.trim()) profile.setName($('net-name').value);
    this.link = new RoomLink();
    await profile.ready;   // so the request carries the player id cookie
    let r;
    try {
      r = how === 'create' ? await this.link.create(this.netName(), $('net-private').checked) : await this.link.join(code, this.netName());
    } catch (err) {
      this.link.close();
      this.link = null;
      $('net-note').textContent = joinError(err);
      return;
    }
    this.enterRoom(!!r.rejoin);   // this tab already had a seat there: read the room back
  }

  // `resume`: this tab had the seat before a reload; read the room back and carry on.
  enterRoom(resume) {
    const { link } = this;
    sessionStorage.setItem(ROOM_KEY, JSON.stringify({ code: link.code, seat: link.seat, token: link.token }));
    this.session = new Session({
      seat: link.seat,
      send: (msg) => this.link.send(msg),
      onStart: (config) => {
        $('setup').classList.add('hidden');
        this.d.match.start(config);
        return this.d.match.game;
      },
      onSay: (e) => this.showSay(e),
      resume,
    });
    link.onEntry = (e) => this.session.receive(e);
    link.onCaughtUp = () => this.session.caughtUp();
    link.onLost = () => this.ended('The connection to the room was lost (it may have expired, or the server restarted).');
    history.replaceState(null, '', `?room=${link.code}`);
    this.lobbySig = '';
    this.lobbySent = '';
    this.lobbyPend = null;
    // The list from before the room is stale (it holds this room, with a Join
    // button): clear it now, and let the next answer replace it.
    this.roomsSig = '';
    this.renderRooms(null);
    this.refreshRooms();
    this.renderLobby();
  }

  // Each frame, before the match steps.
  update() {
    if (this.session) {
      this.session.pump();
      if (!this.session.game) { this.renderLobby(); this.sendLobby(performance.now()); }
      this.updateWait();
      this.syncScreens();
      this.updateClock();
      this.noteTakenOver();
    }
    if (this.session?.over && this.d.match.game?.phase !== 'matchOver') this.ended(this.session.over);
  }

  // From the match-over card: the host reports the winner, for the players' records.
  result(game) {
    if (this.session?.isHost) this.link?.result(winnerSeat(game, this.session.seatOf));
  }

  // Online, the draft and armory screens follow the room: close them when the
  // round has moved on, or when this tank's shopping is already in (from before a reload).
  syncScreens() {
    const { match } = this.d;
    const g = this.session.game;
    if (!g || ($('draft').classList.contains('hidden') && $('shop').classList.contains('hidden'))) return;
    if (g.phase !== 'shop') {
      $('draft').classList.add('hidden');
      $('shop').classList.add('hidden');
      match.shopQueue = [];
      match.shopPid = null;
    } else if (match.shopPid != null && g.shopped.includes(match.shopPid)) match.nextShopper();
  }

  // Nobody holds the room up for long (netlogic.js NET_CLOCK): when the clock
  // runs out the shot goes as aimed, or the armory closes.
  updateClock() {
    const g = this.session.game;
    const { key, limit } = clockFor(g, this.d.match.shopPid, NET_CLOCK);
    const c = clockStep(this.clock, key, limit, performance.now() / 1000);
    this.clock = { key: c.key, start: c.start };
    const { left } = c;
    const el = $('net-clock');
    el.classList.toggle('hidden', !clockShows(left));
    if (clockShows(left)) {
      const text = clockText(left, key);
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('urgent', left <= 5);
    }
    if (!(left <= 0)) return;
    this.clock.key = `${key} out`;          // once
    if (key.startsWith('aim')) { this.d.match.game.fire(true); return; }
    if (!$('draft').classList.contains('hidden')) $('draft-items').querySelector('button.buy')?.click();
    if (!$('shop').classList.contains('hidden')) $('shop-done').click();
  }

  // Back after being away too long: a CPU has this screen's tank.
  noteTakenOver() {
    const session = this.session;
    const g = session.game;
    if (!g || session.notedTakeover || g.localHumans.length || !session.playersOf(session.seat).length) return;
    session.notedTakeover = true;
    this.d.banner('A CPU has your tank', 'You were away too long. You can watch the rest of the match.', 4500);
  }

  // Who the game is waiting on, while it waits.
  updateWait() {
    const session = this.session;
    const g = session.game;
    const mineDone = g && (g.phase !== 'shop' || g.localHumans.every((p) => g.shopped.includes(p.id)));
    const names = mineDone ? session.waitingFor().map((p) => p.name) : [];
    const el = $('net-wait');
    el.classList.toggle('hidden', !names.length);
    if (names.length) {
      const text = waitText(names);
      if (el.textContent !== text) el.textContent = text;
    }
  }

  // ---------------------------------------------------------------- chat

  showSay(e) {
    const session = this.session;
    const g = session?.game;
    const seat = session?.seats.find((q) => q.seat === e.seat);
    const pid = session?.playersOf(e.seat)[0];
    const color = g && pid != null ? g.players[pid].color : PLAYER_COLORS[e.seat % PLAYER_COLORS.length];
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.innerHTML = `<b style="color:${color}">${escapeHtml(seat ? seat.name : '?')}</b> ${escapeHtml(String(e.msg.text ?? '').slice(0, 120))}`;
    $('chat-log').appendChild(line);
    while ($('chat-log').children.length > 6) $('chat-log').firstChild.remove();
    setTimeout(() => line.classList.add('fade'), 14000);
    setTimeout(() => line.remove(), 15000);
    this.d.sound.click();
  }

  openChat() {
    const el = $('chat-input');
    el.classList.remove('hidden');
    el.focus();
    this.d.input.held.clear();
  }

  closeChat() {
    const el = $('chat-input');
    if (el.classList.contains('hidden')) return;
    el.value = '';
    el.classList.add('hidden');
    el.blur();
  }

  // ---------------------------------------------------------------- the lobby

  // The setup card while in a room: its people, then the host's CPU tanks.
  renderLobby() {
    const { session, link } = this;
    const rows = this.d.setup.rows;
    const seats = this.lobbySeats();
    const cpus = this.lobbyCpus();
    const sig = JSON.stringify([seats, cpus.map((r) => [r.type, session.isHost ? '' : r.name]), session.isHost, cpus.length]);
    if (sig === this.lobbySig) return;
    this.lobbySig = sig;
    document.body.classList.add('net-lobby');
    document.body.classList.toggle('net-guest', !session.isHost);
    $('net-entry').classList.add('hidden');
    $('net-room').classList.remove('hidden');
    $('net-code-show').textContent = link.code;
    $('opt-firing').value = 'volley';
    $('opt-firing').disabled = true;
    const people = seats.map((s, k) => `
    <div class="player-row">
      <span class="swatch" style="background:${PLAYER_COLORS[k]};width:18px;height:18px"></span>
      <span>${escapeHtml(s.name)}${s.seat === link.seat ? ' (you)' : ''}</span>
      <span class="online-tag">${s.seat === 0 ? 'host' : 'online'}</span>
    </div>`);
    const cpuRows = cpus.map((r) => { const i = rows.indexOf(r); return `
    <div class="player-row">
      <span class="swatch" style="background:${PLAYER_COLORS[seats.length + cpus.indexOf(r)]};width:18px;height:18px"></span>
      ${session.isHost ? `<input data-i="${i}" class="pname" value="${escapeHtml(r.name)}" maxlength="14" />` : `<span>${escapeHtml(r.name)}</span>`}
      ${session.isHost ? `<select data-i="${i}" class="ptype">
        ${[['easy', 'CPU · Easy'], ['normal', 'CPU · Normal'], ['hard', 'CPU · Hard']]
          .map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>` : `<span class="online-tag">CPU</span>`}
    </div>`; });
    $('setup-players').innerHTML = people.join('') + cpuRows.join('');
    document.querySelectorAll('.pname').forEach((el) => el.addEventListener('input', () => { rows[el.dataset.i].name = el.value; }));
    document.querySelectorAll('.ptype').forEach((el) => el.addEventListener('change', () => { rows[el.dataset.i].type = el.value; this.lobbySig = ''; }));
    $('add-player').textContent = '+ Add CPU';
    $('remove-player').textContent = '- Remove CPU';
    $('add-player').disabled = seats.length + cpus.length >= 6;
    $('remove-player').disabled = !cpus.length;
    const n = seats.length + cpus.length;
    $('start').textContent = startLabel(n);
    $('start').disabled = false;
    $('net-note').textContent = lobbyNote({ isHost: session.isHost, seats: seats.length, touch: this.d.touch });
  }

  // The host tells the room its CPU tanks (a `lobby` message) once the list has
  // held still for a moment, so typing a name sends one message, not one a key.
  sendLobby(now) {
    const { session } = this;
    if (!session.isHost) return;
    const msg = lobbyMessage(this.d.setup.rows, this.lobbySent);
    const json = JSON.stringify(msg);
    if (!msg) { this.lobbyPend = null; return; }
    if (this.lobbyPend?.json !== json) this.lobbyPend = { json, at: now };
    else if (now - this.lobbyPend.at > 500) { this.link.send(msg); this.lobbySent = json; this.lobbyPend = null; }
  }

  leave() {
    this.lobbySent = '';
    this.lobbyPend = null;
    sessionStorage.removeItem(ROOM_KEY);
    if (this.link && !this.link.closed) this.link.leave();
    this.closeChat();
    $('net-clock').classList.add('hidden');
    if (this.link) this.link.close();
    this.link = null;
    this.session = null;
    $('net-entry').classList.remove('hidden');
    $('net-room').classList.add('hidden');
    $('net-wait').classList.add('hidden');
    $('net-note').textContent = '';
    $('add-player').textContent = '+ Add tank';
    $('remove-player').textContent = '- Remove tank';
    $('start').disabled = false;
    history.replaceState(null, '', location.pathname);
    this.roomsSig = '';
    this.refreshRooms();
  }

  // The room went away under us: say so, then back to the menu.
  ended(text) {
    if (!this.session) return;
    const inMatch = !!this.session.game;
    this.leave();
    if (!inMatch) { $('net-note').textContent = text; this.d.setup.render(); return; }
    $('net-ended-text').textContent = text;
    $('net-ended').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- the room list

  // Open rooms anyone can join, matches being played, and who else is on the
  // menu. Polled while the setup screen is up.
  async refreshRooms() {
    if (this.roomsBusy || document.hidden || $('setup').classList.contains('hidden')) return;
    this.roomsBusy = true;
    try {
      // In a room you are not "on the menu", but you still see who is.
      const data = await listRooms(this.session ? {} : { id: this.visitorId, name: $('net-name').value.trim() });
      this.renderRooms(data);
    } catch {
      this.renderRooms(null);
    } finally {
      this.roomsBusy = false;
    }
  }

  renderRooms(data) {
    const inRoom = !!this.session;
    const sig = JSON.stringify([data, inRoom]);
    if (sig === this.roomsSig) return;
    this.roomsSig = sig;
    $('net-rooms').innerHTML = roomsHtml(data, inRoom);
    $('tab-online-count').textContent = openRoomsCount(data, inRoom);
    $('net-menu').innerHTML = menuLine(data);
  }
}
