// The determinism harness for online play (no tests of its own: the
// netplay*.test.js files use it). It plays one online match on several
// simulated screens, each with its own Game and Session reading one shared
// room log, the way the browsers do (core/netplay.js), and checks that every
// screen holds the same game.
//
// Strict mode (the default) runs every screen on the same fixed clock and
// with no drift. Then nothing should ever differ between screens, so each
// time a screen takes on the host's state (a `snap` before every volley, a
// `close` after every armory), the state it reached on its own is compared
// with the host's first, field by field. Any difference is a determinism bug
// (or something the snapshot does not carry): `mismatches` lists them with
// the path of the first field that differs.
//
// Loose mode (`dt: 'uneven'`) gives every screen its own uneven frame rate,
// as real browsers have; only the end of the match is compared then.
//
// Bots play the humans. What they do is up to `bot` (see BOT). Each screen's
// bot rolls its own dice, so the screens' humans play differently.
//
//   const m = playMatch({ names: ['Ana', 'Bo'], cpus: [...], config, bot });
//   m.mismatches, m.games, m.room.log, m.screens[i].counts (fired: by the
//   humans, cpuFired: by the CPUs, by weapon id)

import { Game } from '../src/core/game.js';
import { Session } from '../src/core/netplay.js';
import { makeRng } from '../src/core/rng.js';

// A room's log as the server keeps it. Messages go through JSON on the way,
// as they do over the wire.
export function makeRoom() {
  const log = [];
  return { log, append(seat, msg) { log.push({ n: log.length + 1, seat, msg: JSON.parse(JSON.stringify(msg)) }); } };
}

// The path of the first difference between two JSON values, with both
// sides, or null when they are the same.
export function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return { path: path || '(root)', a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, a, b };
  const keys = Array.isArray(a) ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i) : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

// A snapshot as it travels (JSON), less what is allowed to differ before the
// host's state comes in: each human picked the weapon of its secret plan on
// its own screen (the others learn it when it fires), and the plans came in
// in a different order on each screen (`volley.done` is only ever asked
// whether it holds a tank).
export function comparable(state) {
  const s = JSON.parse(JSON.stringify(state));
  for (const p of s.players) if (!p.ai) delete p.weapon;
  if (s.volley) s.volley.done = [...s.volley.done].sort((a, b) => a - b);
  return s;
}

// What the bots do. Every field is optional.
//   weapons   weapon ids to cycle through (a Shell when one is out)
//   drive     seconds of driving at the start of each plan (0: none)
//   turn      swing the hull while driving
//   hop       use a jump jet once a volley while there are charges
//   mods      deploy a ready mod now and then instead of firing
//   variants  in the skill tree, take a weapon variant whenever one is offered
//   buys      armory items to try to buy every round
//   aim       'foe' (default): at the nearest enemy, with some error
export const BOT = { weapons: ['shell'], drive: 0.4, turn: true, hop: false, mods: false, variants: false, buys: ['armor'], aim: 'foe' };

const FIXED_DT = 1 / 30;

// One screen: a Game, a Session and a bot for its humans.
// `dt`: a number (fixed, every frame) or 'uneven'.
export function makeScreen(room, seat, name, { resume = false, bot = {}, dt = FIXED_DT, mismatches = null } = {}) {
  const b = { ...BOT, ...bot };
  const dice = makeRng(1000 + seat * 7 + (resume ? 50 : 0));
  const pace = makeRng(500 + seat);
  const s = { seat, name, cursor: 0, alive: true, counts: { fired: {}, cpuFired: {}, hops: 0, deploys: 0, picks: [], buys: 0, events: {} } };
  let checking = !resume;   // a reloaded screen's first restore is not a comparison
  s.session = new Session({
    seat,
    send: (msg) => room.append(seat, msg),
    onStart: (cfg) => {
      const g = new Game(cfg);
      // Before taking on the host's state, compare it with this screen's own.
      const restore = g.restore.bind(g);
      g.restore = (state) => {
        if (checking && mismatches && seat !== 0) {
          const d = firstDiff(comparable(g.snapshot()), comparable(state));
          if (d) mismatches.push({ seat, at: `${g.phase} ${g.volleyKey}`, ...d });
        }
        checking = true;
        restore(state);
      };
      g.start();
      return g;
    },
    resume,
  });
  if (!resume) room.append(-1, { t: 'join', seat, name });

  s.frame = () => {
    if (!s.alive) return;
    // Each screen parses its own copy off the wire.
    while (s.cursor < room.log.length) s.session.receive(JSON.parse(JSON.stringify(room.log[s.cursor++])));
    s.session.caughtUp();
    const g = s.session.game;
    if (g) {
      const step = dt === 'uneven' ? FIXED_DT * (0.6 + pace.next() * 0.9) : dt;
      g.update(step);
      for (const e of g.drainEvents()) {
        s.counts.events[e.type] = (s.counts.events[e.type] || 0) + 1;
        if (e.type === 'fire') {
          const by = g.players[e.player]?.ai ? s.counts.cpuFired : s.counts.fired;
          by[e.weapon] = (by[e.weapon] || 0) + 1;
        }
      }
      play(g, s, b, dice, step);
    }
    s.session.pump();
  };
  return s;
}

// The bot at the controls of this screen's current human.
function play(g, s, b, dice, dt) {
  const me = g.current;
  if (g.phase === 'aim' && me && g.isLocal(me)) {
    if (g.phaseTime < b.drive) {
      if (b.hop && me.jets > 0 && s.hopped !== g.volleyKey) {
        s.hopped = g.volleyKey;
        me.hull = (me.hull + dice.range(-60, 60) + 360) % 360;
        if (g.jump() === 'ok') s.counts.hops++;
      }
      g.drive(1, b.turn && dice.next() < 0.5 ? 1 : 0, dt);
    } else if (b.mods && g.canDeploy(me) && dice.next() < 0.6) {
      if (g.deploy()) s.counts.deploys++;
    } else {
      const foes = g.players.filter((p) => p.alive && !g.allied(p, me));
      const foe = foes.reduce((a, p) => (!a || Math.hypot(p.x - me.x, p.z - me.z) < Math.hypot(a.x - me.x, a.z - me.z) ? p : a), null);
      if (foe) me.yaw = ((Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI + 360) % 360 + dice.range(-3, 3);
      me.elev = 45;
      me.power = Math.min(100, Math.max(20, Math.sqrt(Math.hypot(foe ? foe.x - me.x : 200, foe ? foe.z - me.z : 0) * 9.8) * 1.05 + dice.range(-4, 4)));
      const w = b.weapons[(s.shot = (s.shot || 0) + 1) % b.weapons.length];
      me.weapon = me.inventory[w] > 0 ? w : 'shell';
      g.fire();
    }
  }
  if (g.phase === 'roundOver' && g.phaseTime > 0.3) g.openShop();
  if (g.phase === 'shop') {
    for (const p of g.localHumans) {
      if (g.shopped.includes(p.id)) continue;
      for (let guard = 0; g.draft[p.id] && guard < 8; guard++) {
        const offer = g.draft[p.id];
        const variant = b.variants ? offer.find((id) => id.includes(':')) : null;
        const pick = variant || offer[p.id % offer.length];
        if (!g.pickPerk(p.id, pick)) break;
        s.counts.picks.push(pick);
      }
      for (const id of b.buys) if (g.buy(p.id, id)) s.counts.buys++;
      s.session.shopDone(p.id);
    }
  }
}

// Every screen, one frame at a time, until `until()` or `frames` run out.
// Returns the frame it stopped on, or -1.
export function run(screens, frames, until = () => false) {
  for (let f = 0; f < frames; f++) {
    for (const s of screens) s.frame();
    if (until()) return f;
  }
  return -1;
}

export const allOver = (screens) => () => screens.every((s) => !s.alive || s.session.game?.phase === 'matchOver');

// One whole online match. `names`: the humans, one screen each (seat 0
// hosts). `cpus`: [{ name, ai }]. `bot`: the same for every screen, or one
// per seat. Returns the screens, their games, the room and any mismatches.
export function playMatch({ names, cpus = [], config, bot = {}, dt = FIXED_DT, frames = 60000, during = null }) {
  const room = makeRoom();
  const mismatches = [];
  const screens = names.map((n, i) => makeScreen(room, i, n, { bot: Array.isArray(bot) ? bot[i] : bot, dt, mismatches }));
  run(screens, 3);
  screens[0].session.start(config, cpus);
  const done = run(screens, frames, () => { during?.(screens, room); return allOver(screens)(); });
  const games = screens.map((s) => s.session.game);
  return { room, screens, games, mismatches, done };
}

// The whole state of a finished game, as the screens should all agree on it.
export const finalState = (g) => JSON.stringify({ phase: g.phase, result: g.lastRoundResult, ...g.snapshot() });

// How each screen stands, for an assertion message.
export const where = (screens) => screens.map((s) => { const g = s.session.game; return `${s.name}: ${g?.phase} r${g?.round}.${g?.turnsThisRound}`; }).join(', ');
