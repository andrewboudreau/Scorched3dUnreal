// Double Strike on screen (the rules are in core/game.js, STRIKE).
//
// Three things, shown only to a human who holds the perk while they plan:
//   - the ×2 button (X on a keyboard) that arms a double, or drops it again;
//   - a pill that says where they are: "Double armed: aim shot 1", "Shot 1 of
//     2 queued", or "Reloading: move only, fire passes";
//   - what Fire does, through the keyboard hint (#help-fire), which the touch
//     Fire button mirrors (SHOT 1, FIRE ×2 / LOCK ×2, PASS).
// On a phone the button sits in the Fire column, just above FIRE, and the pill
// over the right thumb's cluster; on a desktop both go in the player card.
// It reads the game each frame and talks to it only through toggleDouble.

export class StrikeUI {
  // game() is the live Game (or null); blocked() is true while input is held
  // off (a hand-off card); banner(text, sub, ms) and click() are main.js's.
  constructor({ game, touch = null, banner = () => {}, click = () => {}, blocked = () => false }) {
    this.game = game;
    this.touch = touch;
    this.banner = banner;
    this.click = click;
    this.blocked = blocked;
    this.shown = {};

    const btn = this.btn = document.createElement('div');
    btn.className = 'strike-btn hidden';
    btn.title = 'Double Strike: queue two shots this turn. Your next turn is move only.';
    const chip = this.chip = document.createElement('div');
    chip.className = 'strike-chip hidden';
    if (touch) {
      btn.classList.add('t-btn');
      btn.innerHTML = '&times;2';
      const col = touch.root.querySelector('.t-col');
      col.insertBefore(btn, col.querySelector('.t-fire'));
      touch.root.querySelector('.t-right').appendChild(chip);
    } else {
      btn.innerHTML = '&times;2 Double strike <b>X</b>';
      btn.setAttribute('role', 'button');
      const card = document.getElementById('player-card');
      const weapon = card.querySelector('.weapon');
      card.insertBefore(chip, weapon);
      card.insertBefore(btn, weapon.nextSibling);
    }
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.blocked()) this.toggle();
    });
  }

  // The ×2 button, or X (routed here by input.js / inputmap.js).
  toggle() {
    const g = this.game();
    if (!g) return;
    const p = g.current;
    if (!p || p.ai || g.phase !== 'aim') return;
    const had = g.strikeStep(p);
    const on = g.toggleDouble();
    if (!on && had === 'single') return;   // cannot (no perk, or reloading)
    this.click();
    this.touch?.buzz(on ? [10, 40, 10] : 8);
    if (on) this.banner('Double strike', 'Aim shot 1, then fire to queue it', 1100);
    else if (had === 'second') this.banner('Double strike off', 'Shot 1 dropped', 900);
  }

  // From main.js's event loop, for every game event.
  event(e) {
    const g = this.game();
    if (!g) return;
    const p = g.players[e.player];
    if (!p) return;
    if (e.type === 'queued' && !p.ai) {
      this.click();
      this.banner('Shot 1 of 2 queued', 'Now aim shot 2', 1200);
    } else if (e.type === 'double') {
      if (!g.volleyMode) this.banner('Double strike!', p.ai ? `${p.name} fires twice` : 'Two shots away', 900);
    } else if (e.type === 'pass') {
      if (p.ai) this.banner(`${p.name} is reloading`, 'No shot this turn', 1100);
      else if (!g.volleyMode) this.banner('Passed', 'Reloading after a Double Strike', 900);
    }
  }

  // Every frame.
  update() {
    const g = this.game();
    const p = g && g.phase === 'aim' && !this.blocked() ? g.current : null;
    const mine = p && !p.ai && g.isLocal(p) && (p.reloading || g.canDouble(p) || g.strikeStep(p) !== 'single');
    const step = mine ? g.strikeStep(p) : 'none';
    const together = !!g?.volleyMode;
    const blink = !!(p && g.blink && g.blink.player === p.id);   // the decoy armed (modsui.js): Fire sends its blink
    const state = `${step}|${together}|${blink}`;
    if (this.shown.state === state) return;
    this.shown.state = state;

    this.btn.classList.toggle('hidden', !mine || step === 'pass');
    this.btn.classList.toggle('on', step === 'first' || step === 'second');
    this.btn.classList.toggle('queued', step === 'second');
    const chip = {
      first: ['armed', 'Double armed: aim shot 1'],
      second: ['queued', 'Shot 1 of 2 queued ✓'],
      pass: ['reload', 'Reloading: move only, fire passes'],
    }[step];
    this.chip.classList.toggle('hidden', !chip);
    this.chip.className = `strike-chip${chip ? ` ${chip[0]}` : ' hidden'}`;
    this.chip.textContent = chip ? chip[1] : '';
    // What Space does, in the keyboard hint; the touch Fire button reads it.
    const help = document.getElementById('help-fire');
    if (help) {
      help.textContent = blink ? (together ? 'lock in the decoy blink' : 'blink (decoy)') : {
        first: 'queue shot 1 of 2',
        second: together ? 'lock in both shots' : 'fire both shots',
        pass: 'pass (reloading)',
      }[step] || (together ? 'lock in your shot' : 'fire');
    }
  }
}
