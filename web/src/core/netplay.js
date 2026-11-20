// Online play. Every room keeps one ordered log of messages on the server
// (module/CraterfallModule.cs, or tools/devserver.mjs locally); every screen
// reads the same log in the same order and runs its own copy of the game.
//
// Only decisions travel, never frames:
//   start  the host's settings, seed and seating: everyone builds the same game
//   plan   one human's volley: their aim (secret until it fires) and where
//          they drove
//   snap   once every plan is in, the host's whole game state. Everyone takes
//          it on before the turrets swing, so any drift between screens (frame
//          rates, a browser's maths) is gone before each volley
//   shop   one human's perk pick and purchases between rounds
//   close  once everyone has shopped, the host's state again: the next round
//          starts the same everywhere
//   cpu    the host hands a player who left to the computer
// and from the server itself, join and gone (a screen stopped polling).
//
// A message that is about a later point than this screen has reached waits at
// the head of the queue until the game catches up.

const keyOrder = (k) => { const [r, t] = String(k).split('.').map(Number); return r * 10000 + t; };

export class Session {
  // `send(msg)` appends to the room's log. `onStart(config)` builds the game
  // (with `config.local` set) and returns it.
  constructor({ seat, send, onStart }) {
    this.seat = seat;
    this.isHost = seat === 0;
    this.send = send;
    this.onStart = onStart;
    this.inbox = [];
    this.seats = [];            // { seat, name, gone } in joining order
    this.game = null;
    this.seatOf = [];           // player id -> seat (null for CPUs)
    this.sent = new Set();      // plans already sent, by volley and tank
    this.snapped = new Set();   // volleys the host has already settled
    this.over = null;           // why the session ended early, if it did
  }

  // One log entry: { n, seat, msg }.
  receive(entry) { this.inbox.push(entry); }

  // The host starts the match: every seat still here plays, then the CPUs.
  start(config, cpus = []) {
    if (!this.isHost) return;
    const players = [
      ...this.seats.filter((s) => !s.gone).map((s) => ({ name: s.name, seat: s.seat })),
      ...cpus.map((c) => ({ name: c.name, ai: c.ai, seat: null })),
    ];
    const seed = config.seed ?? ((Math.random() * 1e9) | 0);
    this.send({ t: 'start', cfg: { ...config, seed, firing: 'volley' }, players });
  }

  // This screen's human is done in the armory.
  shopDone(id) {
    const g = this.game;
    if (!g || g.phase !== 'shop' || g.shopped.includes(id)) return;
    const p = g.players[id];
    g.shopped.push(id);
    this.send({ t: 'shop', round: g.round, id, perk: p.picked || null, buys: [...(p.bought || [])] });
  }

  // Call once a frame, after game.update.
  pump() {
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
        this.send({ t: 'plan', key: g.volleyKey, id, plan: g.volley.plans[id] || null,
          tank: { x: p.x, y: p.y, z: p.z, hull: p.hull, fuel: p.fuel } });
      }
    }
    // The host settles each volley once every plan is in.
    if (this.isHost && g.phase === 'wait' && !g.waitingOn().length && !this.snapped.has(g.volleyKey)) {
      this.snapped.add(g.volleyKey);
      this.send({ t: 'snap', key: g.volleyKey, state: g.snapshot() });
      g.startVolleyBeat();
    }
    // Everyone leaves the armory together, when the host says so.
    if (this.isHost && g.phase === 'shop' && g.humans.every((p) => g.shopped.includes(p.id))) {
      this.send({ t: 'close', round: g.round, state: g.snapshot() });
      g.closeShop();
    }
  }

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
  apply({ msg }) {
    const g = this.game;
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
        if (g) return true;
        this.seatOf = msg.players.map((p) => p.seat);
        const local = this.playersOf(this.seat);
        this.game = this.onStart({
          ...msg.cfg,
          local,
          players: msg.players.map((p) => ({ name: p.name, ai: p.ai || null })),
        });
        return true;
      }
      case 'cpu': {
        const p = g?.players[msg.id];
        if (p && !p.ai) p.ai = 'normal';
        return true;
      }
      case 'plan': {
        if (!g || g.isLocal(g.players[msg.id])) return true;
        if (keyOrder(msg.key) < keyOrder(g.volleyKey)) return true;   // long past
        if (!(g.volley && g.volleyKey === msg.key && (g.phase === 'aim' || g.phase === 'wait'))) return false;
        g.remotePlan(msg.id, msg.plan, msg.tank);
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
      case 'shop': {
        if (!g || g.isLocal(g.players[msg.id])) return true;
        if (msg.round < g.round) return true;
        if (!(g.phase === 'shop' && g.round === msg.round)) return false;
        if (msg.perk) g.pickPerk(msg.id, msg.perk);
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
