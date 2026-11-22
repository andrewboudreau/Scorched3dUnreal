// The browser end of an online room: create or join one, send messages in
// order, and long-poll the room's log. What the messages mean is up to
// core/netplay.js; the server side is module/Rooms.cs.
//
// Creates and joins carry this tab's key (profile.js) and, as a cookie, the
// player id: joining a room where they still have a seat gives it back
// (`rejoin: true` in the reply) instead of taking a second one.

import { tabKey } from './profile.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RoomLink {
  constructor(base = new URL('api/rooms', location.href).href) {
    this.base = base;
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
  }

  async post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `The server said ${r.status}.`), { status: r.status });
    return data;
  }

  async create(name, priv = false) { return this.attach(await this.post('', { name, private: priv, tab: this.tab })); }
  async join(code, name) { return this.attach(await this.post(`/${encodeURIComponent(code.trim().toUpperCase())}/join`, { name, tab: this.tab })); }

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

  // Messages leave one at a time, in the order they were sent; a failed send
  // is retried before the next one goes.
  send(msg) {
    this.chain = this.chain.then(async () => {
      for (let tries = 0; !this.closed; tries++) {
        try { await this.post(`/${this.code}/send`, { token: this.token, msg }); return; } catch (err) {
          if (err.status === 404 || err.status === 403) { this.lost(); return; }
          await sleep(Math.min(5000, 400 * 2 ** tries));
        }
      }
    });
  }

  async poll() {
    let fails = 0;
    while (!this.closed) {
      try {
        const r = await fetch(`${this.base}/${this.code}/events?token=${this.token}&after=${this.after}`, { cache: 'no-store' });
        if (r.status === 404 || r.status === 403) { this.lost(); return; }
        if (!r.ok) throw new Error(String(r.status));
        const { entries } = await r.json();
        fails = 0;
        for (const e of entries) {
          if (e.n <= this.after) continue;
          this.after = e.n;
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
    fetch(`${this.base}/${this.code}/leave`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.token }) }).catch(() => {});
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
