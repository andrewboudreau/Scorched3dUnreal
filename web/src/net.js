// The browser end of an online room: create or join one, send messages in
// order, and long-poll the room's log. What the messages mean is up to
// core/netplay.js; the server side is module/Rooms.cs.
//
// Creates and joins carry this tab's key (profile.js) and, as a cookie, the
// player id: joining a room where they still have a seat gives it back
// (`rejoin: true` in the reply) instead of taking a second one.

import { tabKey } from './profile.js';
import { PROTOCOL } from './core/netplay.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server's limit on one request (module/Rooms.cs MaxBody).
export const MAX_MESSAGE = 128 * 1024;

// Worth sending again: no answer at all (the network), or the server busy or
// down. Not a refusal (4xx), nor a full room (507): those would fail forever.
export const retryable = (err) => !err.status || (err.status >= 500 && err.status !== 507);

export class RoomLink {
  // `fetch` is there for tests.
  constructor(base = new URL('api/rooms', location.href).href, { fetch: get = (...a) => globalThis.fetch(...a) } = {}) {
    this.base = base;
    this.fetch = get;
    this.failed = null;         // why sending stopped for good, if it did
    this.tab = tabKey();
    this.code = null;
    this.seat = -1;
    this.token = null;
    this.after = 0;
    this.closed = false;
    this.caught = false;        // has read the log to its end once
    this.chain = Promise.resolve();
    this.onEntry = () => {};
    this.onCaughtUp = () => {};
    this.onLost = () => {};     // the room is gone (server restarted, or it expired)
    // A send that failed for good also comes to onEntry, as a `stop` (see fail).
  }

  async post(path, body) {
    const r = await this.fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `The server said ${r.status}.`), { status: r.status });
    return data;
  }

  // `v`: rooms are kept to one version of the messages; joining one of
  // another version is refused with a message to reload.
  async create(name, priv = false) { return this.attach(await this.post('', { name, private: priv, tab: this.tab, v: PROTOCOL })); }
  async join(code, name) { return this.attach(await this.post(`/${encodeURIComponent(code.trim().toUpperCase())}/join`, { name, tab: this.tab, v: PROTOCOL })); }

  // The host's screen at match end: `winner` is a seat, or null (a CPU won).
  // Counts toward each player's record; sent once, failures ignored.
  result(winner) { return this.post(`/${this.code}/result`, { token: this.token, winner }).catch(() => {}); }

  // Back into a seat this tab had before it reloaded: { code, seat, token }.
  resume(saved) { return this.attach(saved); }

  attach(r) {
    Object.assign(this, { code: r.code, seat: r.seat, token: r.token });
    this.poll();
    return r;
  }

  // Messages leave one at a time, in the order they were sent. A send that
  // fails on the way (no network, or the server busy: 5xx but 507) is retried
  // with backoff before the next one goes. One the server refuses (4xx, or 507:
  // the room's log is full), or one too large to send, will never go: the
  // match ends (fail).
  send(msg) {
    this.chain = this.chain.then(async () => {
      const body = { token: this.token, msg };
      const size = JSON.stringify(body).length;
      if (size > MAX_MESSAGE) { this.fail(`a message was too large to send (${msg.t}, ${Math.round(size / 1024)} KB).`); return; }
      for (let tries = 0; !this.closed && !this.failed; tries++) {
        try { await this.post(`/${this.code}/send`, body); return; } catch (err) {
          if (err.status === 404 || err.status === 403) { this.lost(); return; }
          if (!retryable(err)) { this.fail(`the server refused a message (${msg.t}, ${err.status}: ${err.message})`); return; }
          await sleep(Math.min(5000, 400 * 2 ** tries));
        }
      }
    });
    return this.chain;
  }

  // The match cannot go on: say why in the room's log, so every screen ends
  // it (core/netplay.js `stop`), and end it here even if that does not get through.
  fail(why) {
    if (this.failed || this.closed) return;
    this.failed = why;
    console.error(`Craterfall online: ${why}`);
    this.post(`/${this.code}/send`, { token: this.token, msg: { t: 'stop', why } }).catch(() => {});
    this.onEntry({ n: 0, seat: this.seat, msg: { t: 'stop', why } });
  }

  async poll() {
    let fails = 0;
    while (!this.closed) {
      try {
        const r = await this.fetch(`${this.base}/${this.code}/events?token=${this.token}&after=${this.after}`, { cache: 'no-store' });
        if (r.status === 404 || r.status === 403) { this.lost(); return; }
        if (!r.ok) throw new Error(String(r.status));
        const { entries } = await r.json();
        fails = 0;
        for (const e of entries) {
          if (e.n <= this.after) continue;
          this.after = e.n;
          if (e.msg?.t === 'stop') console.error(`Craterfall online: the match stopped: ${e.msg.why}`);
          this.onEntry(e);
        }
        if (!this.caught && entries.length < 500) { this.caught = true; this.onCaughtUp(); }
      } catch {
        await sleep(Math.min(8000, 500 * 2 ** fails++));
      }
    }
  }

  lost() {
    if (this.closed) return;
    this.closed = true;
    this.onLost();
  }

  close() { this.closed = true; }

  // Leave on purpose (not a reload): the seat is let go at once.
  leave() {
    if (!this.code || !this.token) return;
    this.fetch(`${this.base}/${this.code}/leave`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.token }) }).catch(() => {});
  }
}

// The open rooms and who else is on the menu. With an `id`, this screen counts
// as on the menu too, under `name`.
export async function listRooms({ id = '', name = '' } = {}, base = new URL('api/rooms', location.href).href) {
  const q = new URLSearchParams();
  if (id) { q.set('id', id); q.set('name', name); }
  const r = await fetch(`${base}?${q}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
