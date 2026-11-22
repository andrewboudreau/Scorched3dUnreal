// Mods on screen (the rules are in core/mods.js, the drawing in render/mods.js).
//
//   - A deploy button per ready mod, shown only to a human planning who has
//     one ready: on a phone it sits in the Fire column, above SIGHT; on a
//     desktop in the player card, with B on the keyboard. Deploying takes the
//     turn, so it takes two taps: the first arms it ("ORB?"), the second puts
//     it up. Anything else (or three seconds) lets it go again.
//   - Small chips in the player card for the planner's mods: level, health
//     and turns left once up.
//   - The armory's Mods section (modShopCards), apart from the weapons, when
//     the host's Lab sells mods there (by default they come from perks).
// It reads the game each frame and talks to it only through game.deploy.

import { MODS, MOD_BY_ID, modUp } from './core/mods.js';
import { ModsView } from './render/mods.js';

const KEY = 'b';
const ARM_MS = 3000;

export class ModsUI {
  // game() is the live Game (or null); seen(p) whether this screen may see
  // `p`'s things (fog); blocked() is true while input is held off; banner and
  // click are main.js's.
  constructor({ game, scene, touch = null, banner = () => {}, click = () => {}, blocked = () => false, seen = () => true }) {
    this.game = game;
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
      if (ready.length) this.press(this.armed?.id || ready[0].id);
    });
  }

  // First press arms, the second deploys.
  press(id) {
    const g = this.game();
    if (!g || !g.canDeploy() || g.current.mods?.[id]?.state !== 'ready') return;
    const def = MOD_BY_ID[id];
    if (this.armed?.id === id && performance.now() < this.armed.until) {
      this.armed = null;
      if (g.deploy(id)) {
        this.click();
        this.touch?.buzz([12, 30, 12]);
      }
      return;
    }
    this.armed = { id, until: performance.now() + ARM_MS };
    this.refresh();
    this.click();
    this.touch?.buzz(8);
    this.banner(`Deploy ${def.name}?`, `It takes your turn. ${this.touch ? 'Tap' : 'Press'} ${def.tag}${this.touch ? '' : ' (B)'} again`, ARM_MS - 200);
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
    if (e.type !== 'mod') return;
    this.view.event(e, g, this.seen);
    const p = g.players[e.player];
    const def = MOD_BY_ID[e.mod];
    if (!p || !def) return;
    const mine = !p.ai && g.isLocal(p);
    if (e.what === 'deploy') {
      if (g.volleyMode && mine) this.banner(`${def.name} locked in`, 'It goes up when the volley fires', 1300);
      else if (g.volleyMode) return;   // the volley shows it
      else this.banner(mine ? `${def.name} up` : `${p.name} deploys a ${def.name}`, `Lasts ${p.mods[e.mod].turns} turns`, 1300);
    } else if (e.what === 'down' && !e.tank && this.seen(p)) {
      const by = g.players[e.by];
      this.banner(`${mine ? 'Your' : `${p.name}'s`} ${def.name} is down`, by ? `Shot down by ${by.name}` : '', 1500);
    } else if (e.what === 'expire' && mine) {
      this.banner(`Your ${def.name} wore out`, 'A new one is ready on your next turn', 1200);
    } else if (e.what === 'refit' && mine) {
      this.banner(`New ${def.name} ready`, 'Deploying it takes this turn', 1200);
    }
  }

  // Every frame.
  update(dt, time) {
    this.view.update({ game: this.game(), time, dt, seen: this.seen });
    this.refresh();
  }

  // The buttons and chips, redrawn only when what they show changes.
  refresh() {
    const g = this.game();
    if (this.armed && performance.now() > this.armed.until) this.armed = null;
    const p = g && g.phase === 'aim' && !this.blocked() ? g.current : null;
    const me = p && !p.ai && g.isLocal(p) ? p : null;
    const can = !!me && g.canDeploy(me);
    const key = !me ? '' : MODS.map((d) => { const m = me.mods?.[d.id]; return m ? `${m.state}${m.level}.${Math.round(m.hp)}.${m.turns}` : '-'; }).join('|') + `|${can}|${this.armed?.id || ''}`;
    if (key === this.shown) return;
    this.shown = key;
    for (const def of MODS) {
      const b = this.buttons[def.id];
      const ready = can && me.mods?.[def.id]?.state === 'ready';
      b.classList.toggle('hidden', !ready);
      const armed = ready && this.armed?.id === def.id;
      b.classList.toggle('on', armed);
      const lv = me?.mods?.[def.id]?.level || 0;
      b.innerHTML = this.touch
        ? (armed ? `${def.tag}?` : `&#9650;${def.tag}<small>${lv}</small>`)
        : (armed ? `Deploy ${def.name}? <b>B</b>` : `&#9650; ${def.name} L${lv} <b>${this.armed ? '' : 'B'}</b>`);
    }
    // Chips: what the planner has up, or ready.
    const chips = !me ? [] : MODS.map((d) => [d, me.mods?.[d.id]]).filter(([, m]) => m && (m.state === 'up' || m.state === 'ready'));
    this.chips.classList.toggle('hidden', !chips.length);
    this.chips.innerHTML = chips.map(([d, m]) => (m.state === 'up'
      ? `<span class="mod-chip up" title="${d.name}: up">${d.tag}${m.level} <i style="--hp:${Math.round((m.hp / m.maxHp) * 100)}%"></i> ${m.turns}t</span>`
      : `<span class="mod-chip" title="${d.name}: ready to deploy">${d.tag}${m.level} ready</span>`)).join('');
  }

  // A new match.
  reset() {
    this.view.reset();
    this.armed = null;
    this.shown = '?';
  }
}

// The armory's Mods section, for main.js's shop: a heading and a card per mod
// on sale (level by level), in the same shape as the weapon cards. Only when
// the host's Lab puts mods in the armory; by default they come from the perk
// draft and the section is left out.
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
