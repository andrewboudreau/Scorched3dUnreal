import { PLAYER_COLORS } from './core/game.js';
import { bossMatch } from './core/boss.js';
import { profile } from './profile.js';
import { defaultMatch, customBoss, onlineBoss, humanName, phoneFullscreen } from './launch.js';
import { matchConditions, matchTime } from './builder.js';
import { escapeHtml } from './hudlogic.js';

// The setup card's match: the tank rows (`rows`: yours first, then CPUs or
// more humans on this screen), and the two ways to start from it:
//
//   Play    you against two Normal CPUs (launch.js defaultMatch), or the boss
//           match with ?boss; the testing query string (builder.js
//           parseTestParams: ?jammer=2, ?fixed, ?wind=, ...) applies to both
//   Start   the Custom match from the rows and the options (or its boss
//           match); in a room, the host starts the room's match instead
//
// In a room the rows' CPUs are the host's, and the card shows the room
// (online.js renderLobby). launch.js keeps the rest of the launch screen.
//
// deps: match (start), online (session, lobbySeats, lobbyCpus, renderLobby),
// sound, touch, testParams, builder (builder.js MatchBuilder).

const $ = (id) => document.getElementById(id);
const CPU_NAMES = ['Rook', 'Vex', 'Marlow', 'Kestrel', 'Bastion', 'Ivo'];

export class Setup {
  constructor(deps) {
    this.d = deps;
    this.rows = [
      { name: profile.name || 'You', type: 'human' },
      { name: 'Rook', type: 'normal' },
    ];
    $('add-player').onclick = () => this.add();
    $('remove-player').onclick = () => this.remove();
    $('play').onclick = () => this.play();
    $('start').onclick = () => this.start();
  }

  inLobby() { const s = this.d.online.session; return !!(s && !s.game); }

  render() {
    if (this.inLobby()) { this.d.online.renderLobby(); return; }
    const rows = this.rows;
    document.body.classList.remove('net-lobby', 'net-guest');
    $('start').textContent = 'Start match';
    $('opt-firing').disabled = false;
    $('setup-players').innerHTML = rows.map((r, i) => `
    <div class="player-row">
      <span class="swatch" style="background:${PLAYER_COLORS[i]};width:18px;height:18px"></span>
      ${r.type === 'human' ? `<span class="pname-fixed">${escapeHtml(r.name)}<small>your name</small></span>`
        : `<input data-i="${i}" class="pname" value="${escapeHtml(r.name)}" maxlength="14" />`}
      <select data-i="${i}" class="ptype">
        ${[['human', 'Human'], ['easy', 'CPU · Easy'], ['normal', 'CPU · Normal'], ['hard', 'CPU · Hard']]
          .map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>`).join('');
    document.querySelectorAll('.pname').forEach((el) => el.addEventListener('input', () => { rows[el.dataset.i].name = el.value; }));
    document.querySelectorAll('.ptype').forEach((el) => el.addEventListener('change', () => { rows[el.dataset.i].type = el.value; }));
    $('add-player').disabled = rows.length >= 6;
    $('remove-player').disabled = rows.length <= 2;
  }

  add() {
    const { online } = this.d;
    const rows = this.rows;
    if (this.inLobby()) {
      if (online.lobbySeats().length + online.lobbyCpus().length >= 6) return;
      rows.push({ name: CPU_NAMES[(online.lobbyCpus().length + 1) % CPU_NAMES.length], type: 'normal' });
      this.render();
      return;
    }
    if (rows.length >= 6) return;
    rows.push({ name: CPU_NAMES[rows.length % CPU_NAMES.length], type: 'normal' });
    this.render();
  }

  remove() {
    const rows = this.rows;
    if (this.inLobby()) {
      const i = rows.map((r) => r.type !== 'human').lastIndexOf(true);
      if (i >= 0) { rows.splice(i, 1); this.render(); }
      return;
    }
    if (rows.length > 2) { rows.pop(); this.render(); }
  }

  // The Custom match options as config (host only online). Random wind and
  // terrain are rolled here, once, so the config holds concrete values and every
  // screen builds the same world.
  customOptions() {
    const { testParams, builder } = this.d;
    return {
      rounds: Number($('opt-rounds').value),
      ...matchConditions({ wind: $('opt-wind').value, terrain: $('opt-hills').value, edges: $('opt-edges').value }, testParams),
      time: matchTime($('opt-time').value, testParams),
      fog: $('opt-fog').value === '1',
      ...builder.lists(),
      lab: testParams.lab || null,
      modifier: testParams.modifier || null,
    };
  }

  play() {
    const { online, sound, touch, testParams, match } = this.d;
    if (online.session) return;
    sound.ensure();
    phoneFullscreen(touch);
    if (humanName()) profile.setName(humanName());
    $('setup').classList.add('hidden');
    const conditions = matchConditions({}, testParams);
    const base = testParams.boss ? bossMatch(humanName(), { conditions, lab: testParams.lab }) : defaultMatch(humanName(), conditions, testParams.lab);
    match.start({ ...base, modifier: testParams.modifier || null, time: matchTime('random', testParams) });
  }

  start() {
    const { online, sound, touch, match } = this.d;
    sound.ensure();
    phoneFullscreen(touch);
    const session = online.session;
    if (session) {
      // The host starts the room's match; everyone's screen starts it when the message comes round.
      if (!session.isHost || session.game) return;
      if (online.lobbySeats().length + online.lobbyCpus().length < 2) { $('net-note').textContent = 'Add a CPU tank, or wait for someone to join.'; return; }
      const cpus = online.lobbyCpus().map((r, i) => ({ name: r.name.trim() || `CPU ${i + 1}`, ai: r.type }));
      if ($('opt-match').value === 'boss') { const { config, boss } = onlineBoss(this.customOptions()); session.start(config, [...cpus, boss]); }
      else session.start(this.customOptions(), cpus);
      $('start').disabled = true;
      return;
    }
    if (humanName()) profile.setName(humanName());
    $('setup').classList.add('hidden');
    if ($('opt-match').value === 'boss') { match.start(customBoss(this.rows, this.customOptions(), $('opt-firing').value)); return; }
    match.start({
      players: this.rows.map((r, i) => ({ name: r.name.trim() || `Tank ${i + 1}`, ai: r.type === 'human' ? null : r.type })),
      ...this.customOptions(),
      firing: $('opt-firing').value,
    });
  }
}
