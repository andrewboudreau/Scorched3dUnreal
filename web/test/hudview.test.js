import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIEWS, HUD, hudView, hudState, hudCss, SHOWN, FAINT, HIDDEN, MOVED } from '../src/hudview.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the view follows the phase, then the camera mode', () => {
  assert.equal(hudView({ phase: 'aim' }), 'plan');
  assert.equal(hudView({}), 'plan');
  assert.equal(hudView({ phase: 'aim', mode: 'plan' }), 'plan');
  assert.equal(hudView({ phase: 'aim', mode: 'peek' }), 'plan');
  assert.equal(hudView({ phase: 'aim', mode: 'sight' }), 'sight');
  assert.equal(hudView({ phase: 'aim', mode: 'overview' }), 'overview');
  for (const phase of ['volley', 'flight', 'settle', 'wait']) {
    for (const mode of ['hero', 'volley', 'follow', 'hold']) assert.equal(hudView({ phase, mode }), 'flight', `${phase} ${mode}`);
  }
  for (const phase of ['roundOver', 'matchOver', 'shop']) assert.equal(hudView({ phase, mode: 'hold' }), 'between', phase);
  assert.equal(hudView({ mode: 'menu' }), 'menu');
});

test('priorities: between beats the kill cam beats the map beats the sight beats flight', () => {
  assert.equal(hudView({ phase: 'roundOver', mode: 'kill' }), 'between');
  assert.equal(hudView({ phase: 'roundOver', mode: 'overview' }), 'between');
  assert.equal(hudView({ phase: 'flight', mode: 'kill' }), 'kill');
  assert.equal(hudView({ phase: 'flight', mode: 'overview' }), 'overview');
  // The sight is only for planning: a stale mode does not put it over a shell in flight.
  assert.equal(hudView({ phase: 'flight', mode: 'sight' }), 'flight');
});

test('the table has a state for every element in every view', () => {
  const ids = new Set();
  for (const row of HUD) {
    assert.ok(!ids.has(row.id), `${row.id} is listed twice`);
    ids.add(row.id);
    assert.ok(row.name && row.why, `${row.id} needs a name and a reason`);
    for (const v of VIEWS) assert.ok([SHOWN, FAINT, HIDDEN, MOVED].includes(row.views[v]), `${row.id} in ${v}`);
  }
});

test('the phone-first calls the issue asked for', () => {
  // The shell owns the screen in flight: aim controls and the card are gone, the rest faint.
  for (const id of ['card', 'pad', 'power', 'fire']) assert.equal(hudState(id, 'flight'), HIDDEN, id);
  for (const id of ['players', 'drive', 'camera']) assert.equal(hudState(id, 'flight'), FAINT, id);
  // Nothing needed to aim goes in the plan.
  for (const id of ['card', 'card-body', 'players', 'pad', 'power', 'fire', 'drive', 'camera', 'locators', 'sideview', 'dials']) assert.equal(hudState(id, 'plan'), SHOWN, id);
  // The sight: the card shrinks to its wind, the side view moves, the sight's own markers replace the locators.
  assert.equal(hudState('card', 'sight'), SHOWN);
  assert.equal(hudState('card-body', 'sight'), HIDDEN);
  assert.equal(hudState('sideview', 'sight'), MOVED);
  assert.equal(hudState('locators', 'sight'), HIDDEN);
  assert.equal(hudState('pad', 'sight'), SHOWN);
  // The kill cam and the screens between rounds leave only the caption, and the gear on the screens.
  for (const row of HUD) {
    if (row.id === 'caption' || row.id === 'marks' || row.id === 'gear') continue;
    assert.equal(row.views.kill, HIDDEN, `${row.id} in the kill cam`);
  }
  assert.equal(hudState('caption', 'kill'), SHOWN);
  assert.equal(hudState('gear', 'between'), SHOWN);
  assert.equal(hudState('pad', 'between'), HIDDEN);
  // The boss bar clears the compass tape in the sight, and stays up through flight.
  assert.equal(hudState('boss', 'sight'), MOVED);
  assert.equal(hudState('boss', 'flight'), SHOWN);
  // What the card's readout said now lives on the pad and the weapon button.
  assert.equal(hudState('card-readout', 'plan'), HIDDEN);
});

test('every selector names something that is in the page or the touch controls', () => {
  const source = ['index.html', 'src/touch.js', 'src/bossui.js', 'src/settings.js', 'src/strike.js', 'src/main.js', 'src/hud.js', 'src/sideview.js', 'src/render/sidepanel.js'].map(read).join('\n');
  for (const row of HUD) {
    if (!row.sel) continue;
    const bare = row.sel.replace(/:(has|not)\([^)]*\)/g, '');
    for (const m of bare.matchAll(/([#.])([\w-]+)/g)) {
      const [, kind, name] = m;
      // `none` is a class hud.js adds to the jets readout; the rest are in the markup or built by the modules.
      assert.ok(source.includes(name), `${row.id}: ${kind}${name} is not in the page`);
    }
  }
});

test('the generated stylesheet hides, fades and leaves alone as the table says', () => {
  const css = hudCss();
  // Flight: the pad is faded out and cannot be touched; the drive cross is faint, not blocked.
  assert.match(css, /body\.touch\[data-view="flight"\] #touch \.t-pad[^{]*\{ opacity: 0; visibility: hidden; pointer-events: none;/);
  assert.match(css, /body\.touch\[data-view="flight"\] #touch \.t-left[^{]*\{ opacity: \.38; \}/);
  // The sight collapses the card to its wind rather than leave an empty box.
  assert.match(css, /body\.touch\[data-view="sight"\] #player-card > :not\(\.pc-wind\)[^{]*\{ display: none !important; \}/);
  // A comma list is scoped in every part, including one with a comma inside :has().
  assert.match(css, /body\.touch\[data-view="plan"\] #player-card \.readout, body\.touch\[data-view="plan"\] #player-card \.bar\.power/);
  // Shown rows need no rule, and rows the code owns get none at all.
  assert.doesNotMatch(css, /data-view="plan"\] #touch \.t-pad/);
  assert.doesNotMatch(css, /#sideview|\.locator|#labels|#inset/);
  // Nothing outside body.touch: a desktop screen keeps its HUD.
  for (const block of css.replace(/\/\*.*?\*\//g, '').split('}').filter((b) => b.includes('{'))) {
    for (const sel of block.slice(0, block.indexOf('{')).split(/,(?![^(]*\))/)) assert.ok(sel.trim().startsWith('body.touch'), sel);
  }
});
