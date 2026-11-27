import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchOrder, roundOrder, matchTitle, roundTitle, nextStep, continueText, hotseatStep, handoffTitle, handoffDoing, handoffText,
  draftDoing, draftSkipText, shopDoneText, shopOpenNote, boughtNote, standingsTable, statsTable, awards, SHOP_HINT,
} from '../src/matchlogic.js';

const stats = (o = {}) => ({ shots: 0, hits: 0, damage: 0, kills: 0, longest: 0, probes: 0, ...o });
const tank = (id, name, o = {}) => ({ id, name, color: '#fff', wins: 0, money: 0, alive: true, stats: stats(), ...o });

test('the match card lists by wins, then money; the round card by wins', () => {
  const a = tank(0, 'Ana', { wins: 1, money: 50 }), b = tank(1, 'Bo', { wins: 2, money: 0 }), c = tank(2, 'Cy', { wins: 1, money: 90 });
  assert.deepEqual(matchOrder([a, b, c]).map((p) => p.name), ['Bo', 'Cy', 'Ana']);
  assert.deepEqual(roundOrder([a, b, c]).map((p) => p.name), ['Bo', 'Ana', 'Cy']);   // a stable sort keeps Ana first
  assert.equal(matchTitle(b), 'Match winner: Bo');
  assert.equal(roundTitle(2, a), 'Round 2: Ana wins');
  assert.equal(roundTitle(3, null), 'Round 3 is a draw');
});

test('after the round card: the next round, the skills or the armory', () => {
  const me = tank(0, 'You');
  assert.equal(nextStep({ localHumans: [], round: 1 }), 'round');
  assert.equal(continueText({ localHumans: [], round: 1 }), 'Start round 2');
  assert.equal(nextStep({ localHumans: [me], draftOn: true }), 'skills');
  assert.equal(continueText({ localHumans: [me], draftOn: true }), 'Continue to your skills');
  assert.equal(continueText({ localHumans: [me], draftOn: false }), 'Continue to the armory');
});

test('hot seat: whose go it is, the hand-off card', () => {
  const a = tank(0, 'Ana'), b = tank(1, 'Bo');
  assert.equal(hotseatStep([a, b], b, 'volley 2'), 'Player 2 of 2 · volley 2');
  assert.equal(hotseatStep([a], a, 'shopping for round 2'), 'shopping for round 2');
  assert.equal(handoffTitle(b), 'Bo, plan your shot');
  assert.equal(handoffDoing(0), 'volley 1');
  assert.match(handoffText(true), /tap Lock in\./);
  assert.match(handoffText(false), /press Space to lock it in\./);
});

test('skills and armory lines', () => {
  assert.equal(draftDoing(3), '3 skill points to spend');
  assert.equal(draftDoing(1), '1 skill point to spend');
  assert.equal(draftDoing(0), 'all points spent');
  assert.equal(draftSkipText(2), 'Save them · go to the armory');
  assert.equal(draftSkipText(1), 'Save it · go to the armory');
  assert.equal(draftSkipText(0), 'Go to the armory');
  assert.equal(shopDoneText(tank(1, 'Bo'), false, 1), 'Done · pass to Bo');
  assert.equal(shopDoneText(null, true, 1), 'Done · ready for the next round');
  assert.equal(shopDoneText(null, false, 1), 'Done · start round 2');
  assert.equal(shopOpenNote(true, false), SHOP_HINT);
  assert.equal(shopOpenNote(true, true), `${SHOP_HINT} Haggler prices applied.`);
  assert.equal(shopOpenNote(false, true), `Nothing in reach this time. ${SHOP_HINT}`);
  assert.equal(boughtNote({ name: 'Shield' }, 2, 300, 50), 'Bought Shield level 2 for $300. $50 left.');
  assert.equal(boughtNote({ name: 'Shell', bundle: 5 }, 0, 40, 10), 'Bought 5 × Shell for $40. $10 left.');
  assert.equal(boughtNote({ name: 'Nuke' }, 0, 900, 0), 'Bought Nuke for $900. $0 left.');
});

test('the match-over tables escape names and mark the destroyed', () => {
  const html = standingsTable([tank(0, '<Ana>', { wins: 2, money: 120, alive: false })]);
  assert.match(html, /&lt;Ana&gt; <span style="color:#9aa6b2">\(destroyed\)<\/span>/);
  assert.match(html, /<td>2<\/td><td>\$120<\/td>/);
  const st = statsTable([tank(0, 'Bo', { stats: stats({ shots: 4, hits: 1, damage: 80.4, kills: 1, longest: 212.6, probes: 2 }) }), tank(1, 'Cy')]);
  assert.match(st, /<td>1 \/ 4<\/td><td>25%<\/td><td>80<\/td><td>1<\/td>\s*<td>213 m<\/td><td>2<\/td>/);
  assert.match(st, /<td>0 \/ 0<\/td><td>–<\/td><td>0<\/td><td>0<\/td>\s*<td>–<\/td><td>–<\/td>/);
});

test('awards: the best at each, only when someone earned it', () => {
  assert.equal(awards([tank(0, 'Ana'), tank(1, 'Bo')]), '');
  const a = tank(0, 'Ana', { stats: stats({ shots: 3, hits: 2, damage: 50, longest: 100 }) });
  const b = tank(1, 'Bo', { stats: stats({ shots: 5, hits: 2, damage: 90, kills: 1, longest: 300 }) });
  const html = awards([a, b]);
  assert.match(html, /Sharpshooter: <b style="color:#fff">Ana<\/b>, 2 of 3 shots hit/);
  assert.match(html, /Longest hit: <b style="color:#fff">Bo<\/b>, 300 m/);
  assert.match(html, /Most damage: <b style="color:#fff">Bo<\/b>, 90/);
  assert.match(html, /Most kills: <b style="color:#fff">Bo<\/b>, 1/);
  // Two shots are too few for the sharpshooter.
  assert.doesNotMatch(awards([tank(0, 'Cy', { stats: stats({ shots: 2, hits: 2 }) })]), /Sharpshooter/);
});
