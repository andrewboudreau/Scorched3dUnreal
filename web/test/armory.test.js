// The between-rounds screens as HTML (src/armory.js): the stepper, the pay
// breakdown, the skill tree, the kit strip and the armory's sections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js';
import { stepperHtml, earnedLine, resultsHtml, skillTreeHtml, rankNames, rankText, kitHtml, armoryHtml, weaponStats, kitWords } from '../src/armory.js';
import { WEAPON_BY_ID } from '../src/core/weapons.js';
import { PERK_BY_ID } from '../src/core/perks.js';

const two = (extra = {}) => new Game({ players: [{ name: 'A' }, { name: 'B' }], seed: 3, resolution: 64, ...extra });

test('the stepper marks the step showing and the ones done, and drops Skills when perks are off', () => {
  const h = stepperHtml('draft', { round: 2 });
  assert.match(h, /Before round 3/);
  assert.match(h, /ar-step done"><i>1<\/i>Results/);
  assert.match(h, /ar-step on"><i>2<\/i>Skills/);
  assert.match(h, /ar-step"><i>3<\/i>Armory/);
  const off = stepperHtml('armory', { draft: false, round: 1 });
  assert.doesNotMatch(off, /Skills/);
  assert.match(off, /ar-step on"><i>2<\/i>Armory/);
});

test('the results show what each tank earned and why, and the parts add up', () => {
  const g = two({ rounds: 3 });
  g.start();
  const [a, b] = g.players;
  g.damage(b, 30, 0);
  b.alive = false;
  g.endRound();
  const { total, html } = earnedLine(a);
  assert.equal(total, Object.values(a.earned).reduce((s, n) => s + n, 0));
  assert.match(html, /damage/);
  assert.match(html, /round win/);
  const table = resultsHtml(g.players);
  assert.match(table, new RegExp(`\\+\\$${total}`));
  assert.match(table, /destroyed/);
});

test('the skill tree shows each branch: its path, the next rank, and why one is shut', () => {
  const g = two({ rounds: 5 });
  g.start();
  g.endRound();
  g.openShop();
  const a = g.players[0];
  let h = skillTreeHtml(g, a);
  assert.match(h, /Firepower/);
  assert.match(h, /Heavy Charge<\/span><span class="sk-arrow">›<\/span><span class="sk-rank">Wide Blast/);
  assert.match(h, /data-id="heavycharge"/);
  assert.match(h, /data-id="orbital"/);
  const gun = g.skillTree(a).find((b) => b.id === 'gunnery');
  a.perks.push(...gun.ranks.slice(0, -1));
  assert.equal(g.skillTree(a).find((b) => b.id === 'gunnery').lock, 'From round 3', 'Double Strike waits');
  assert.match(skillTreeHtml(g, a), /From round 3/);
  a.perks.length = 0;
  assert.ok(g.pickPerk(0, 'orbital'));
  h = skillTreeHtml(g, a);
  assert.match(h, /sk-rank have">Level 1/);
  assert.match(h, /Gravity Orbiter level 2/);
  assert.match(h, /data-id="orbitalup" disabled/, 'no points left');
  a.perks.push('satrecon');
  a.points = 1;
  const third = g.skillTree(a).find((b) => b.mod && b.held === 0);
  if (third) assert.equal(third.lock, 'Both mod bays in use');
  assert.equal(rankNames(g.skillTree(a).find((b) => b.id === 'hull')).join(), 'Reinforced Hull,Dug In,Field Repairs');
  assert.match(rankText(g.skillTree(a).find((b) => b.id === 'orbiter'), 2), /level 3/);
});

test('the kit strip lists ammo, mods with their levels and perks', () => {
  const g = two();
  g.start();
  const a = g.players[0];
  a.perks.push('orbital');
  a.pendingArmor = 30;
  const h = kitHtml(g, a);
  assert.match(h, /Shell ∞/);
  assert.match(h, /Rangefinder ×2/);
  assert.match(h, /Orbiter L1/);
  assert.match(h, /\+30 armor/);
  assert.match(h, /class="perk"/);
});

test('the armory: Standard open, Advanced locked until its round, gear, and upgrades only for owned mods', () => {
  const g = two({ rounds: 5 });
  g.start();
  const a = g.players[0];
  a.money = 1000;
  let h = armoryHtml(g, a);
  assert.match(h, /Advanced weapons <span class="ar-lock">open before round 3/);
  assert.match(h, /data-id="breacher"/);
  assert.doesNotMatch(h, /data-id="thunderhead"/, 'locked: no buy button');
  assert.match(h, /Thunderhead/);
  assert.match(h, /data-id="armor"/);
  assert.doesNotMatch(h, />Mods/, 'the Lab sells no mods here');
  a.perks.push('orbital');
  g.round = 2;
  h = armoryHtml(g, a, 'armor');
  assert.match(h, /data-id="thunderhead"/);
  assert.doesNotMatch(h, /data-id="orbiter"/, 'mod levels are skill ranks, not stock');
  assert.match(h, /shop-item gear bought/);
});

test('weapon stats and the starting kit read from the data', () => {
  assert.match(weaponStats(WEAPON_BY_ID.thunderhead), /95 dmg · 30 m/);
  assert.match(weaponStats(WEAPON_BY_ID.scatter), /^\d+ × \d+ dmg$/);
  assert.match(kitWords(), /^Shells, 1 Guided Missile/);
  assert.doesNotMatch(kitWords({ online: true }), /Guided/);
});
