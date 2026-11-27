// Mods on screen (the rules are in core/mods.js, the drawing in render/mods.js).
//
//   - A deploy button per ready mod, shown only to a human planning who has
//     one ready: on a phone it sits in the Fire column, above SIGHT; on a
//     desktop in the player card, with B on the keyboard. Deploying takes the
//     turn, so it takes two taps: the first arms it ("ORB?"), the second puts
//     it up. Anything else (or three seconds) lets it go again. The decoy is
//     aimed: its button arms it (game.toggleBlink) and Fire then sends its
//     blink with the aim as it is (the Fire button reads BLINK); a second tap
//     lets it go. The Jammer Drone goes over the enemy the turret points
//     nearest (game.jamTarget): armed, the banner names it.
//   - A banner when a Jammer Drone jams you or lets you go, and a JAMMED chip
//     in the player card while it lasts.
//   - Small chips in the player card for the planner's mods: level, health
//     and turns left once up (and Point Defense's charges for the round).
//   - The armory's Mods section (modShopCards), apart from the weapons, when
//     the host's Lab sells mods there (by default they come from perks).
// It reads the game each frame and talks to it only through game.deploy and
// game.toggleBlink.

import { Vector3 } from 'three';
import { MODS, MOD_BY_ID, DECOY, JAM, modUp } from './core/mods.js';
import { ModsView } from './render/mods.js';

const KEY = 'b';
const ARM_MS = 3000;

export class ModsUI {
  // game() is the live Game (or null); seen(p) whether this screen may see
  // `p`'s things (fog); blocked() is true while input is held off; banner and
  // click are main.js's.
  constructor({ game, scene, camera = null, touch = null, banner = () => {}, click = () => {}, blocked = () => false, seen = () => true }) {
    this.game = game;
    this.camera = camera;     // for the decoys' name labels
    this.labels = new Map();  // owner id -> a decoy's label in #labels
    this._v = new Vector3();
    this.touch = touch;
    this.banner = banner;
    this.click = click;
    this.blocked = blocked;
    this.seen = seen;
    this.view = new ModsView(scene);
    this.armed = null;       // { id, until }
    this.shown = '';

    this.bar = document.createElement('div');
    this.bar.className = 'mod-bar';
    this.chips = document.createElement('div');
    this.chips.className = 'mod-chips hidden';
    this.buttons = {};
    for (const def of MODS) {
      const b = document.createElement('div');
      b.className = 'mod-btn hidden';
      b.dataset.id = def.id;
      b.title = `${def.name}: deploying it takes your turn`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!this.blocked()) this.press(def.id);
      });
      this.buttons[def.id] = b;
      this.bar.appendChild(b);
    }
    const card = document.getElementById('player-card');
    if (touch) {
      this.bar.classList.add('t-mods');
      for (const b of Object.values(this.buttons)) b.classList.add('t-btn');
      const col = touch.root.querySelector('.t-col');
      col.insertBefore(this.bar, col.firstChild);
    } else {
      const weapon = card.querySelector('.weapon');
      card.insertBefore(this.bar, weapon.nextSibling);
    }
    card.appendChild(this.chips);
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.key.toLowerCase() !== KEY || e.ctrlKey || e.metaKey) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || this.blocked()) return;
      const g = this.game();
      const ready = g?.canDeploy() ? MODS.filter((d) => g.current.mods?.[d.id]?.state === 'ready') : [];
      if (ready.length) this.press(g.blink ? 'decoy' : this.armed?.id || ready[0].id);
    });
  }

  // First press arms, the second deploys.
  press(id) {
    const g = this.game();
    if (!g || !g.canDeploy() || g.current.mods?.[id]?.state !== 'ready') return;
    const def = MOD_BY_ID[id];
    if (def.aimed) {   // the decoy: armed, Fire sends the blink
      this.armed = null;
      const on = g.toggleBlink();
      this.refresh();
      this.click();
      this.touch?.buzz(on ? 8 : [6, 20, 6]);
      if (on) this.banner(`${def.name} armed`, `Aim, then ${this.touch ? 'BLINK' : 'Space'}: your tank blinks where it lands and a decoy stays here`, 2600);
      return;
    }
    if (g.blink) g.toggleBlink();   // another mod instead: the decoy lets go
    if (this.armed?.id === id && performance.now() < this.armed.until) {
      this.armed = null;
      if (g.deploy(id)) {
        this.click();
        this.touch?.buzz([12, 30, 12]);
      }
      return;
    }
    const over = def.targeted ? g.jamTarget(g.current) : null;
    if (def.targeted && !over) { this.banner(`No enemy to send the ${def.name} to`, 'Find one first', 1400); return; }
    this.armed = { id, until: performance.now() + ARM_MS };
    this.refresh();
    this.click();
    this.touch?.buzz(8);
    const again = `${this.touch ? 'Tap' : 'Press'} ${def.tag}${this.touch ? '' : ' (B)'} again`;
    if (over) this.banner(`Jam ${over.name}?`, `The drone goes over the enemy your turret points nearest. It takes your turn. ${again}`, ARM_MS - 200);
    else this.banner(`Deploy ${def.name}?`, `It takes your turn. ${again}`, ARM_MS - 200);
  }

  // The deployed satellite `p` has up, for the beam (render/satellite.js), or null.
  satAt(p) {
    return modUp(p, 'satellite') ? p.mods.satellite : null;
  }

  // From main.js's event loop, for every game event.
  event(e) {
    const g = this.game();
    if (!g) return;
    if (e.type === 'turn' || e.type === 'locked' || e.type === 'volley') this.armed = null;
    if (e.type === 'intercept') { this.view.event(e, g, this.seen); return; }
    if (e.type === 'status') { this.statusEvent(g, e); return; }
    if (e.type !== 'mod') return;
    this.view.event(e, g, this.seen);
    const p = g.players[e.player];
    const def = MOD_BY_ID[e.mod];
    if (!p || !def) return;
    const mine = !p.ai && g.isLocal(p);
    if (e.mod === 'decoy') {   // only its owner hears of it: to the others it is just their tank
      if (!mine) return;
      if (e.what === 'deploy') this.banner('Decoy up', 'It stands where you were, to draw the fire', 1300);
      else if (e.what === 'down' && !e.tank) this.banner('Your decoy fizzled', e.pos && p.mods.decoy.level >= 3 ? 'and went off' : '', 1300);
      return;
    }
    if (e.what === 'deploy') {
      const over = e.target != null ? g.players[e.target] : null;
      if (g.volleyMode && mine) this.banner(`${def.name} locked in`, 'It goes up when the volley fires', 1300);
      else if (g.volleyMode) return;   // the volley shows it
      else this.banner(mine ? `${def.name} up${over ? ` over ${over.name}` : ''}` : `${p.name} deploys a ${def.name}`, `Lasts ${p.mods[e.mod].turns} turns`, 1300);
    } else if (e.what === 'down' && !e.tank && this.seen(p)) {
      const by = g.players[e.by];
      this.banner(`${mine ? 'Your' : `${p.name}'s`} ${def.name} is down`, by ? `Shot down by ${by.name}` : '', 1500);
    } else if (e.what === 'expire' && mine) {
      this.banner(`Your ${def.name} wore out`, 'A new one is ready on your next turn', 1200);
    } else if (e.what === 'refit' && mine) {
      this.banner(`New ${def.name} ready`, 'Deploying it takes this turn', 1200);
    }
  }

  // A Jammer Drone jams (or lets go of) a tank this screen plays for.
  statusEvent(g, e) {
    const p = g.players[e.player];
    if (!p || p.ai || !g.isLocal(p) || e.kind !== 'jammed') return;
    const by = g.players[e.by];
    if (e.strength > 0) {
      const what = e.strength >= JAM.arc ? 'no satellite labels, no steering, no aim arc' : 'no satellite labels, no steering';
      this.banner(`${g.localHumans.length > 1 ? `${p.name}: j` : 'J'}ammed${by ? ` by ${by.name}` : ''}`, `${what}. Flak brings the drone down`, 2200);
    } else if (p.alive) this.banner('Jamming lifted', `${g.localHumans.length > 1 ? `${p.name}'s` : 'Your'} instruments are back`, 1300);
  }

  // Every frame.
  update(dt, time) {
    const g = this.game();
    this.view.update({ game: g, time, dt, seen: this.seen, mine: (p) => this.mine(g, p) });
    this.decoyLabels(g);
    this.refresh();
  }

  // Does this screen play for `p`, so its decoy shows as a hologram here?
  // With more than one human on the screen, only while `p` plans.
  mine(g, p) {
    if (!g || p.ai || !g.isLocal(p)) return false;
    return g.localHumans.length <= 1 || g.current === p;
  }

  // Each enemy decoy carries its owner's name label, like the real tank's
  // (main.js updateLabels): its own health on the bar at level 1, its
  // owner's from level 2. Its owner sees "decoy" under the name instead.
  decoyLabels(g) {
    const live = new Set();
    for (const p of g?.players || []) {
      if (!modUp(p, 'decoy') || !this.camera) continue;
      const m = p.mods.decoy;
      const mine = this.mine(g, p);
      if (!mine && !this.seen({ ...p, x: m.x, z: m.z })) continue;
      live.add(p.id);
      let el = this.labels.get(p.id);
      if (!el || el._mine !== mine) {
        el?.remove();
        el = document.createElement('div');
        el.className = 'tank-label';
        el._mine = mine;
        el.innerHTML = `<div style="color:${p.color}"></div><div class="bar"><div class="fill hp"></div></div>${mine ? '<small class="decoy-tag">decoy</small>' : ''}`;
        el.firstChild.textContent = p.name;
        document.getElementById('labels')?.appendChild(el);
        this.labels.set(p.id, el);
      }
      const v = this._v.set(m.x, m.y + 8, m.z).project(this.camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.style.display = on ? 'block' : 'none';
      if (!on) continue;
      el.style.transform = `translate(${Math.round((v.x * 0.5 + 0.5) * window.innerWidth)}px, ${Math.round((-v.y * 0.5 + 0.5) * window.innerHeight)}px) translate(-50%, -100%)`;
      const share = m.level >= DECOY.mirror ? p.hp / p.maxHp : m.hp / m.maxHp;
      el.querySelector('.fill').style.width = `${Math.max(0, share) * 100}%`;
    }
    for (const [id, el] of this.labels) if (!live.has(id)) { el.remove(); this.labels.delete(id); }
  }

  // The buttons and chips, redrawn only when what they show changes.
  refresh() {
    const g = this.game();
    if (this.armed && performance.now() > this.armed.until) this.armed = null;
    const p = g && g.phase === 'aim' && !this.blocked() ? g.current : null;
    const me = p && !p.ai && g.isLocal(p) ? p : null;
    const can = !!me && g.canDeploy(me);
    const blink = !!(me && g.blink && g.blink.player === me.id);
    const jam = me ? (me.status || []).find((s) => s.kind === 'jammed' && s.strength === g.jammed(me)) : null;
    const key = !me ? '' : MODS.map((d) => { const m = me.mods?.[d.id]; return m ? `${m.state}${m.level}.${Math.round(m.hp)}.${m.turns}.${m.charges ?? ''}` : '-'; }).join('|') + `|${can}|${this.armed?.id || ''}|${blink}|${jam ? `${jam.strength}.${jam.turns}` : ''}`;
    if (key === this.shown) return;
    this.shown = key;
    for (const def of MODS) {
      const b = this.buttons[def.id];
      const ready = can && me.mods?.[def.id]?.state === 'ready';
      b.classList.toggle('hidden', !ready);
      const armed = ready && (def.aimed ? blink : this.armed?.id === def.id);
      b.classList.toggle('on', armed);
      const lv = me?.mods?.[def.id]?.level || 0;
      b.innerHTML = this.touch
        ? (armed ? `${def.tag}${def.aimed ? '&#10003;' : '?'}` : `&#9650;${def.tag}<small>${lv}</small>`)
        : armed ? (def.aimed ? `${def.name} armed: Space blinks <b>B</b>` : `Deploy ${def.name}? <b>B</b>`)
          : `&#9650; ${def.name} L${lv} <b>${this.armed || blink ? '' : 'B'}</b>`;
    }
    // Chips: what the planner has up, or ready.
    const chips = !me ? [] : MODS.map((d) => [d, me.mods?.[d.id]]).filter(([, m]) => m && (m.state === 'up' || m.state === 'ready'));
    this.chips.classList.toggle('hidden', !chips.length && !jam);
    const charges = (d, m) => (d.id === 'pointdef' ? ` <b title="Shells it can still stop this round">${'&#9679;'.repeat(m.charges || 0) || '&#9675;'}</b>` : '');
    this.chips.innerHTML = chips.map(([d, m]) => (m.state === 'up'
      ? `<span class="mod-chip up" title="${d.name}: up">${d.tag}${m.level} <i style="--hp:${Math.round((m.hp / m.maxHp) * 100)}%"></i> ${m.turns}t${charges(d, m)}</span>`
      : `<span class="mod-chip" title="${d.name}: ready to deploy">${d.tag}${m.level} ready</span>`)).join('')
      + (jam ? `<span class="mod-chip jam" title="Jammed by ${g.players[jam.source]?.name || 'a drone'}: satellite labels and steering out${jam.strength >= JAM.arc ? ', no aim arc' : ''}">JAMMED ${jam.turns}t</span>` : '');
  }

  // A new match.
  reset() {
    this.view.reset();
    for (const el of this.labels.values()) el.remove();
    this.labels.clear();
    this.armed = null;
    this.shown = '?';
  }
}

// The armory's Mods section, for main.js's shop: a heading and a card per mod
// on sale (level by level), in the same shape as the weapon cards. Only when
// the host's Lab puts mods in the armory; by default they come from the skill
// tree and the section is left out.
export function modShopCards(game, p, justBought = null) {
  const cards = MODS.filter((d) => game.cfg.lab[d.id] === 'shop').map((d) => {
    const have = game.modLevel(p, d.id);
    const price = game.priceOf(p, d.id);
    const short = Number.isFinite(price) ? price - p.money : 0;
    const gives = have >= d.maxLevel ? 'Top level' : `Level ${have + 1}: ${d.levels[have]}`;
    return `<div class="shop-item mod${short > 0 ? ' cant' : ''}${d.id === justBought ? ' bought' : ''}">
      <div class="si-head"><b>${d.name}</b><span class="si-own${have ? ' has' : ''}">${have ? `Level ${have}` : 'None'}</span></div>
      <div class="desc">${d.desc}</div>
      <div class="si-foot">
        <span class="si-gives">${gives}${short > 0 ? `<span class="si-short">need $${short} more</span>` : ''}</span>
        <button class="buy" data-id="${d.id}" aria-label="Buy ${d.name} for $${price}" ${short > 0 || !Number.isFinite(price) ? 'disabled' : ''}>${Number.isFinite(price) ? `$${price}` : 'Max'}</button>
      </div>
    </div>`;
  });
  return cards.length ? `<div class="shop-section">Mods <small>deployable equipment: deploying takes a turn, then it stays up until it is shot down or wears out</small></div>${cards.join('')}` : '';
}
