// The match's cards in words: what the round-over, skills, armory, hand-off
// and match-over cards say, and in which order they list the tanks. match.js
// puts it on the page. No three.js and no DOM (the tables are HTML strings),
// so it is tested in test/matchlogic.test.js.

import { escapeHtml } from './hudlogic.js';

// The match-over card's order: most rounds won, then the most money.
export const matchOrder = (players) => [...players].sort((a, b) => b.wins - a.wins || b.money - a.money);

// The round-over card's order: most rounds won.
export const roundOrder = (players) => [...players].sort((a, b) => b.wins - a.wins);

export const matchTitle = (winner) => `Match winner: ${winner.name}`;

export const roundTitle = (round, winner) => (winner ? `Round ${round}: ${winner.name} wins` : `Round ${round} is a draw`);

// What comes after the round-over card: the next round at once when nobody
// plays on this screen, else each human's skills (when there is a draft) or
// the armory.
export function nextStep(game) {
  if (!game.localHumans.length) return 'round';
  return game.draftOn ? 'skills' : 'armory';
}

export function continueText(game) {
  const step = nextStep(game);
  return step === 'round' ? `Start round ${game.round + 1}` : step === 'skills' ? 'Continue to your skills' : 'Continue to the armory';
}

// "Player 2 of 3 · shopping for round 2" when several humans share the
// screen; just what they are doing when one does.
export function hotseatStep(humans, p, doing) {
  return humans.length > 1 ? `Player ${humans.indexOf(p) + 1} of ${humans.length} · ${doing}` : doing;
}

// The volley hand-off card (two or more humans on one screen).
export const handoffTitle = (p) => `${p.name}, plan your shot`;
export const handoffDoing = (turnsThisRound) => `volley ${turnsThisRound + 1}`;
export const handoffText = (touch) => `Everyone else, look away. Drive and aim as you like, then ${touch ? 'tap Lock in' : 'press Space to lock it in'}. Nobody fires until every tank is ready.`;

// The skill tree card's lines, for `n` points left.
export const draftDoing = (n) => (n > 1 ? `${n} skill points to spend` : n ? '1 skill point to spend' : 'all points spent');
export const draftSkipText = (n) => (n ? `Save ${n > 1 ? 'them' : 'it'} · go to the armory` : 'Go to the armory');

// The armory's Done button: pass to the next human here, wait for the room
// online, or start the next round.
export function shopDoneText(next, online, round) {
  return next ? `Done · pass to ${next.name}` : online ? 'Done · ready for the next round' : `Done · start round ${round + 1}`;
}

export const SHOP_HINT = 'Money you keep carries over to the next armory.';

// The armory's note when it opens: whether anything is in reach.
export function shopOpenNote(affordable, haggler) {
  return affordable ? SHOP_HINT + (haggler ? ' Haggler prices applied.' : '') : `Nothing in reach this time. ${SHOP_HINT}`;
}

// The note after a purchase. `level`: the mod level bought (0 for anything else).
export function boughtNote(it, level, price, money) {
  return `Bought ${level ? `${it.name} level ${level}` : it.bundle ? `${it.bundle} × ${it.name}` : it.name} for $${price}. $${money} left.`;
}

export function standingsTable(sorted) {
  return `<tr><th></th><th>Tank</th><th>Wins</th><th>Funds</th></tr>` + sorted.map((p) => `
    <tr><td><span class="swatch" style="background:${p.color}"></span></td><td>${escapeHtml(p.name)}${p.alive ? '' : ' <span style="color:#9aa6b2">(destroyed)</span>'}</td>
    <td>${p.wins}</td><td>$${p.money}</td></tr>`).join('');
}

// Whole-match numbers per tank. Accuracy counts shots that hurt someone else;
// rangefinder probes are listed apart.
export function statsTable(sorted) {
  const pct = (st) => (st.shots ? `${Math.round((st.hits / st.shots) * 100)}%` : '–');
  return `<tr><th></th><th>Tank</th><th>Hits</th><th>Accuracy</th><th>Damage</th><th>Kills</th><th>Longest hit</th><th>Probes</th></tr>` + sorted.map((p) => {
    const st = p.stats;
    return `<tr><td><span class="swatch" style="background:${p.color}"></span></td><td>${escapeHtml(p.name)}</td>
      <td>${st.hits} / ${st.shots}</td><td>${pct(st)}</td><td>${Math.round(st.damage)}</td><td>${st.kills}</td>
      <td>${st.longest ? `${Math.round(st.longest)} m` : '–'}</td><td>${st.probes || '–'}</td></tr>`;
  }).join('');
}

// A few lines worth reading out at the end.
export function awards(players) {
  const best = (score, ok) => players.filter(ok).reduce((a, b) => (!a || score(b) > score(a) ? b : a), null);
  const name = (p) => `<b style="color:${p.color}">${escapeHtml(p.name)}</b>`;
  const out = [];
  const sharp = best((p) => p.stats.hits / p.stats.shots, (p) => p.stats.shots >= 3 && p.stats.hits > 0);
  if (sharp) out.push(`Sharpshooter: ${name(sharp)}, ${sharp.stats.hits} of ${sharp.stats.shots} shots hit`);
  const far = best((p) => p.stats.longest, (p) => p.stats.longest > 0);
  if (far) out.push(`Longest hit: ${name(far)}, ${Math.round(far.stats.longest)} m`);
  const dmg = best((p) => p.stats.damage, (p) => p.stats.damage > 0);
  if (dmg) out.push(`Most damage: ${name(dmg)}, ${Math.round(dmg.stats.damage)}`);
  const kills = best((p) => p.stats.kills, (p) => p.stats.kills > 0);
  if (kills) out.push(`Most kills: ${name(kills)}, ${kills.stats.kills}`);
  return out.map((t) => `<div>${t}</div>`).join('');
}
