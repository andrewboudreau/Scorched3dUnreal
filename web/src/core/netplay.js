// Online play. Every room keeps one ordered log of messages on the server
// (module/CraterfallModule.cs, or tools/devserver.mjs locally); every screen
// reads the same log in the same order and runs its own copy of the game.
//
// Only decisions travel, never frames:
//   start  the host's settings, seed and seating: everyone builds the same game.
//          Carries PROTOCOL; a screen on another version refuses the match
//   plan   one human's volley: their aim (secret until it fires) and where
//          they drove or hopped (position, hull, fuel and jump jets left, and
//          the aim history and hits taken on the spot that moving clears)
//   snap   once every plan is in, the host's whole game state. Everyone takes
//          it on before the turrets swing, so any drift between screens (frame
//          rates, a browser's maths) is gone before each volley
//   end    the host's verdict once a volley has played out: `over` (the round
//          is over, or goes on) and its state at that point. Only the host
//          decides: every other screen holds in the 'verdict' phase until this
//          comes, takes the state on and goes the way it says (Game.carryOn),
//          so screens whose maths disagree about who survived never split
//          into one planning and one shopping
//   shop   one human's perk pick and purchases between rounds
//   close  once everyone has shopped, the host's state again: the next round
//          starts the same everywhere
//   cpu    the host hands a player who left to the computer
//   say    a chat line; shown as it arrives, outside the game's order
//   stop   the match cannot go on (a message the server refused, see net.js):
//          every screen ends it with `why`, at once
// and from the server itself, join and gone (a screen stopped polling), and
// stop when the room's log is full.
//
// The states (snap, end, close) are packed small (packState): only what
// changed since the host's last state travels, so the ground goes as the ops
// added since (`ground.from` counts the ones before), each tank as its changed
// fields, each building of the City only when it took damage. Every screen
// reads every state in the log, in order, so it can always put the whole one
// back together (unpackState).
//
// A message that is about a later point than this screen has reached waits at
// the head of the queue until the game catches up.
//
// A screen that reloads comes back to its seat (`resume`): it reads the whole
// log, jumps to the host's latest state (the last snap, end or close) and
// carries on from there. Its own plans and shopping from before the reload
// count as made.

import { bossStandings } from './boss.js';

// The message protocol's version, sent in `start` (and to the server on
// create and join, which keeps rooms of different versions apart).
export const PROTOCOL = 2;
export const OTHER_VERSION = 'This match is on another version of Craterfall. Reload the page to update, then join a new room.';

const STATES = new Set(['snap', 'end', 'close']);

// The seat the host reports as the match's winner, for the players' records
// (one seat, or null: nobody). A boss match: when the allies win, the human
// among them who dealt the boss the most (a CPU ally on top does not take
// the win from them); when the boss wins, or nobody does, null. Any other
// match: the most rounds won, then the most money, if a human sits there.
export function winnerSeat(game, seatOf) {
  const s = game.cfg.boss ? bossStandings(game.players, game.lastRoundResult) : null;
  if (s) {
    if (s.winner !== 'allies') return null;
    const top = s.rows.find((r) => r.side === 'allies' && seatOf[r.id] != null);
    return top ? seatOf[top.id] : null;
  }
  const [top] = [...game.players].sort((a, b) => b.wins - a.wins || b.money - a.money);
  return seatOf[top?.id] ?? null;
}

const copy = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A state (Game.snapshot) packed against `base`, the state sent before it in
// the same log (null: none yet), so that only what changed travels:
//   ground   the ops added since the base, when it is the same round
//            ({ from: ops before, ops }); else all of it ({ from: 0, starts, ops })
//   players  per tank, 0 when unchanged, else only its changed fields (and
//            `$del`, the fields it no longer has)
//   city     per building, 0 when unchanged, else the building
//   same     the other fields that have not changed, by name (never `round`)
// A packed state that has a base says so with `diff: 1`.
export function packState(state, base) {
  const ops = state.ground?.ops || [];
  const n = base?.round === state.round && base.ground ? Math.min(base.ground.ops.length, ops.length) : 0;
  const ground = n ? { from: n, ops: ops.slice(n) } : { from: 0, starts: state.ground?.starts, ops };
  if (!base) return { ...state, ground };
  const out = { diff: 1, same: [], round: state.round, ground };   // the round always goes: the ground's ops count from it
  for (const [k, v] of Object.entries(state)) {
    if (k === 'ground' || k === 'round') continue;
    const was = base[k];
    if (same(v, was)) { out.same.push(k); continue; }
    if ((k === 'players' || k === 'city') && Array.isArray(v) && Array.isArray(was) && v.length === was.length) {
      out[k] = v.map((x, i) => (same(x, was[i]) ? 0 : k === 'players' ? fieldsChanged(was[i], x) : x));
    } else out[k] = v;
  }
  return out;
}

function fieldsChanged(was, now) {
  const d = {};
  for (const [f, v] of Object.entries(now)) if (!same(v, was[f])) d[f] = v;
  const del = Object.keys(was).filter((f) => !(f in now));
  if (del.length) d.$del = del;
  return d;
}

// A packed state made whole again against `base`, the last whole state read
// from the same log; null when it cannot be (a part of it is missing).
export function unpackState(s, base) {
  if (!s) return null;
  const d = s.ground;
  let ground = d;
  if (d && d.from != null) {
    if (d.from === 0) ground = { starts: d.starts, ops: d.ops };
    else if (base?.ground && base.round === s.round && base.ground.ops.length >= d.from) ground = { starts: base.ground.starts, ops: base.ground.ops.slice(0, d.from).concat(d.ops) };
    else return null;
  }
  if (!s.diff) return { ...s, ground };
  if (!base) return null;
  const out = {};
  for (const k of s.same || []) out[k] = base[k];
  for (const [k, v] of Object.entries(s)) {
    if (k === 'diff' || k === 'same') continue;
    if (k === 'ground') { out.ground = ground; continue; }
    if ((k === 'players' || k === 'city') && Array.isArray(v) && Array.isArray(base[k]) && v.length === base[k].length) {
      out[k] = v.map((x, i) => {
        if (x === 0) return base[k][i];
        if (k === 'city') return x;
        const p = { ...base[k][i], ...x };
        for (const f of x.$del || []) delete p[f];
        delete p.$del;
        return p;
      });
    } else out[k] = v;
  }
  return out;
}

const keyOrder = (k) => { const [r, t] = String(k).split('.').map(Number); return r * 10000 + t; };

export class Session {
  // `send(msg)` appends to the room's log. `onStart(config)` builds the game
  // (with `config.local` set) and returns it.
  constructor({ seat, send, onStart, onSay = () => {}, resume = false }) {
    this.seat = seat;
    this.isHost = seat === 0;
    this.send = send;
    this.onStart = onStart;
    this.onSay = onSay;
    this.resume = resume;       // still reading the log back after a reload
    this.echo = new Set();      // log entries from this seat before the reload
    this.inbox = [];
    this.seats = [];            // { seat, name, gone } in joining order
    this.game = null;
    this.seatOf = [];           // player id -> seat (null for CPUs)
    this.sent = new Set();      // plans already sent, by volley and tank
    this.snapped = new Set();   // volleys the host has already settled
    this.ended = new Set();     // volleys the host has already given its verdict on
    this.packed = null;         // the host's last state sent, whole (pack)
    this.unpacked = null;       // the log's last state read, whole (unpack)
    this.lastState = null;      // its entry in the inbox
    this.over = null;           // why the session ended early, if it did
  }

  // One log entry: { n, seat, msg }.
  receive(entry) {
    const t = entry.msg.t;
    if (t === 'say') { if (!this.resume) this.onSay(entry); return; }
    if (t === 'stop') { this.over ||= `Connection problem: ${entry.msg.why || 'the room stopped taking messages.'}`; return; }
    if (STATES.has(t)) {
      const state = unpackState(entry.msg.state, this.unpacked);
      if (!state) { this.over ||= 'Connection problem: this screen lost track of the match. Reload the page to take your seat back.'; return; }
      this.unpacked = state;
      // Reading the log back after a reload, only the latest state is taken on (caughtUp).
      if (this.resume && this.lastState) this.lastState.msg.state = null;
      entry = { ...entry, msg: { ...entry.msg, state: copy(state) } };
      this.lastState = entry;
    }
    this.inbox.push(entry);
  }

  // The host packs a state for the log, against the last one it sent (packState).
  pack(state) {
    const out = packState(state, this.packed);
    this.packed = state;
    return out;
  }

  // After a reload: the log has been read back to its end. Jump to the host's
  // latest state and queue what came after it.
  caughtUp() {
    if (!this.resume) return;
    this.resume = false;
    const all = this.inbox;
    this.inbox = [];
    let last = -1;
    all.forEach((e, i) => { if (STATES.has(e.msg.t)) last = i; });
    const send = this.send;
    this.send = () => {};       // all of this was said the first time round
    all.forEach((e, i) => {
      const t = e.msg.t;
      if (t === 'join' || t === 'gone' || t === 'start' || t === 'cpu') { this.apply(e); return; }
      if (t === 'snap') this.snapped.add(e.msg.key);
      if (t === 'end') this.ended.add(e.msg.key);
      if (i < last) return;
      if (i === last) { this.settle(e.msg); return; }
      if (e.seat === this.seat) this.echo.add(e.n);
      this.inbox.push(e);
    });
    this.send = send;
    // The host packs its next state against the last one in the log.
    this.packed = this.unpacked;
    // A host coming back hands over anyone who went while it was away.
    if (this.isHost && this.game) {
      for (const s of this.seats) {
        if (!s.gone) continue;
        for (const id of this.playersOf(s.seat)) if (!this.game.players[id].ai) this.send({ t: 'cpu', id });
      }
    }
  }

  // Take on one of the host's states, as the game would have from the live message.
  settle(msg) {
    const g = this.game;
    if (!g) return;
    if (msg.t === 'snap') {
      this.snapped.add(msg.key);
      g.phase = 'wait';
      g.restore(msg.state);
      g.startVolleyBeat();
    } else if (msg.t === 'end') {
      this.ended.add(msg.key);
      g.phase = 'verdict';
      g.restore(msg.state);
      g.carryOn(msg.over);
    } else {
      g.phase = 'shop';
      g.draft = {};
      g.restore(msg.state);
      g.closeShop();
    }
  }

  // The host starts the match: every seat still here plays, then the CPUs.
  start(config, cpus = []) {
    if (!this.isHost) return;
    const players = [
      ...this.seats.filter((s) => !s.gone).map((s) => ({ name: s.name, seat: s.seat })),
      ...cpus.map((c) => ({ name: c.name, ai: c.ai, seat: null })),
    ];
    const seed = config.seed ?? ((Math.random() * 1e9) | 0);
    this.send({ t: 'start', cfg: { ...config, seed, firing: 'volley', proto: PROTOCOL }, players });
  }

  // This screen's human is done in the armory.
  shopDone(id) {
    const g = this.game;
    if (!g || g.phase !== 'shop' || g.shopped.includes(id)) return;
    const p = g.players[id];
    g.shopped.push(id);
    if (this.echoed('shop', (m) => m.round === g.round && m.id === id)) return;   // done before a reload
    this.send({ t: 'shop', round: g.round, id, perks: [...(p.picked || [])], buys: [...(p.bought || [])] });
  }

  // Call once a frame, after game.update.
  pump() {
    if (this.resume) return;
    while (this.inbox.length && this.apply(this.inbox[0])) this.inbox.shift();
    const g = this.game;
    if (!g) return;
    // Our planners' plans go out as soon as they lock in.
    if (g.volley && (g.phase === 'aim' || g.phase === 'wait')) {
      for (const id of g.volley.done) {
        const p = g.players[id];
        const k = `${g.volleyKey}:${id}`;
        if (!g.isLocal(p) || this.sent.has(k)) continue;
        this.sent.add(k);
        if (this.echoed('plan', (m) => m.key === g.volleyKey && m.id === id)) continue;   // sent before a reload
        // Driving and hopping also cleared the tank's aim history and its
        // count of hits taken on the spot (game.driveTank): those go too.
        this.send({ t: 'plan', key: g.volleyKey, id, plan: g.volley.plans[id] || null,
          tank: { x: p.x, y: p.y, z: p.z, hull: p.hull, fuel: p.fuel, jets: p.jets, hitsHere: p.hitsHere, shots: p.shots } });
      }
    }
    // The host settles each volley once every plan is in.
    if (this.isHost && g.phase === 'wait' && !g.waitingOn().length && !this.snapped.has(g.volleyKey)) {
      this.snapped.add(g.volleyKey);
      this.send({ t: 'snap', key: g.volleyKey, state: this.pack(g.snapshot()) });
      g.startVolleyBeat();
    }
    // Everyone leaves the armory together, when the host says so.
    if (this.isHost && g.phase === 'shop' && g.humans.every((p) => g.shopped.includes(p.id))) {
      this.send({ t: 'close', round: g.round, state: this.pack(g.snapshot()) });
      g.closeShop();
    }
  }

  // A volley has played out (Game.nextTurn): does the round go on? The host
  // says, with its state as it stands, and goes that way; every other screen
  // waits in 'verdict' for the host's `end` and ignores its own idea of it.
  decided(over) {
    const g = this.game;
    if (!this.isHost || !g) return;
    const key = g.volleyKey;
    if (!this.ended.has(key)) {
      this.ended.add(key);
      this.send({ t: 'end', key, over, state: this.pack(g.snapshot()) });
    }
    g.carryOn(over);
  }

  // Is a message of ours from before a reload still waiting in the queue?
  echoed(t, match) { return this.inbox.some((e) => this.echo.has(e.n) && e.msg.t === t && match(e.msg)); }

  // The humans this screen is waiting for, by name.
  waitingFor() {
    const g = this.game;
    if (!g) return [];
    if (g.phase === 'wait') return g.waitingOn().filter((p) => !g.isLocal(p));
    if (g.phase === 'shop') return g.humans.filter((p) => !g.isLocal(p) && !g.shopped.includes(p.id));
    return [];
  }

  playersOf(seat) { return this.seatOf.map((s, id) => (s === seat ? id : -1)).filter((id) => id >= 0); }

  // Take one message on. False: not yet, try again next frame.
  apply({ msg, n }) {
    const g = this.game;
    const echo = this.echo.has(n);
    switch (msg.t) {
      case 'join':
        if (!this.seats.some((s) => s.seat === msg.seat)) this.seats.push({ seat: msg.seat, name: msg.name, gone: false });
        return true;
      case 'gone': {
        const s = this.seats.find((q) => q.seat === msg.seat);
        if (s) s.gone = true;
        if (msg.seat === 0 && !this.isHost) this.over = 'The host left the game.';
        if (this.isHost && g) for (const id of this.playersOf(msg.seat)) this.send({ t: 'cpu', id });
        return true;
      }
      case 'start': {
        if (g || this.over) return true;
        const { proto, ...cfg } = msg.cfg || {};
        if (proto !== PROTOCOL) { this.over = OTHER_VERSION; return true; }
        this.seatOf = msg.players.map((p) => p.seat);
        const local = this.playersOf(this.seat);
        this.game = this.onStart({
          ...cfg,
          local,
          players: msg.players.map((p) => ({ name: p.name, ai: p.ai || null })),
        });
        if (this.game) this.game.decide = (over) => this.decided(over);
        return true;
      }
      case 'cpu': {
        const p = g?.players[msg.id];
        if (p && !p.ai) p.ai = 'normal';
        return true;
      }
      case 'plan': {
        if (!g || (g.isLocal(g.players[msg.id]) && !echo)) return true;
        if (keyOrder(msg.key) < keyOrder(g.volleyKey)) return true;   // long past
        if (!(g.volley && g.volleyKey === msg.key && (g.phase === 'aim' || g.phase === 'wait'))) return false;
        if (g.volley.done.includes(msg.id)) return true;
        g.remotePlan(msg.id, msg.plan, msg.tank);
        if (echo) {
          // Planned before the reload: that stands, and is not sent again.
          this.sent.add(`${msg.key}:${msg.id}`);
          if (g.phase === 'aim' && g.current?.id === msg.id) g.nextPlanner();
        }
        return true;
      }
      case 'snap': {
        if (!g || this.isHost) return true;
        if (keyOrder(msg.key) < keyOrder(g.volleyKey)) return true;
        if (!(g.phase === 'wait' && g.volleyKey === msg.key)) return false;
        g.restore(msg.state);
        g.startVolleyBeat();
        return true;
      }
      case 'end': {
        if (!g || this.isHost) return true;
        if (keyOrder(msg.key) < keyOrder(g.volleyKey)) return true;
        if (!(g.phase === 'verdict' && g.volleyKey === msg.key)) return false;
        this.ended.add(msg.key);
        g.restore(msg.state);
        g.carryOn(msg.over);
        return true;
      }
      case 'shop': {
        if (!g || (g.isLocal(g.players[msg.id]) && !echo)) return true;
        if (msg.round < g.round) return true;
        if (!(g.phase === 'shop' && g.round === msg.round)) return false;
        if (g.shopped.includes(msg.id)) return true;
        for (const k of msg.perks || (msg.perk ? [msg.perk] : [])) g.pickPerk(msg.id, k);   // skill ranks, in the order taken
        for (const id of msg.buys) g.buy(msg.id, id);
        if (!g.shopped.includes(msg.id)) g.shopped.push(msg.id);
        return true;
      }
      case 'close': {
        if (!g || this.isHost) return true;
        if (msg.round < g.round) return true;
        if (!(g.phase === 'shop' && g.round === msg.round)) return false;
        g.restore(msg.state);
        g.closeShop();
        return true;
      }
      default:
        return true;
    }
  }
}
