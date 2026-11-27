// What the HUD shows in each view (the "HUD declutter pass", docs/mobile.md).
//
// A match is always in one of six views, and each HUD element is shown, faint,
// hidden or moved in each of them. This is the one table; main.js only tells it
// which view is on (body[data-view]), and the CSS below is generated from it,
// so the table, the page and the docs cannot drift apart. Rows marked `js` are
// driven by the code that draws them (the side view, the dials, the tank marks,
// the locators); they are listed so the table is the whole picture.
//
// It is phone first: the rules apply under body.touch (a coarse pointer or
// ?mobile=1). A desktop screen has room for the HUD and is left alone.
//
// No three.js, no game state: hudView() takes plain flags, so it is testable.

export const VIEWS = ['plan', 'sight', 'flight', 'kill', 'overview', 'between'];

export const SHOWN = 'shown';
export const FAINT = 'faint';
export const HIDDEN = 'hidden';
export const MOVED = 'moved';
const CODES = { S: SHOWN, F: FAINT, H: HIDDEN, M: MOVED };

// Which view the game is in. In order of priority:
//   between   a round or match has ended (results, skills, armory cards cover the screen)
//   kill      the deciding shot's slow-motion replay
//   overview  the View button's map
//   sight     the gunner's sight, while you plan
//   flight    shells are in the air (or being fired, or waiting on the others)
//   plan      setting up a shot (also the CPUs' turns, and a hand-off screen)
export function hudView({ phase = '', sight = false, overview = false, killCam = false } = {}) {
  if (phase === 'roundOver' || phase === 'matchOver' || phase === 'shop') return 'between';
  if (killCam) return 'kill';
  if (overview) return 'overview';
  if (sight && phase === 'aim') return 'sight';
  if (phase === 'volley' || phase === 'flight' || phase === 'settle' || phase === 'wait') return 'flight';
  return 'plan';
}

// id, name, selector, then one letter per view in VIEWS order
// (S shown, F faint, H hidden, M moved), then why. `gone` collapses a hidden
// element instead of only fading it; `js` marks one the drawing code owns.
const ROWS = [
  ['card', 'Player card', '#player-card', 'S S H H F H',
    'Your tank. The sight keeps only its wind (the one number the sight does not show), the shell is the show in flight, and the map wants the field clear.', {}],
  ['card-body', 'Card: name, health, fuel, jets, round', '#player-card > :not(.pc-wind)', 'S H H H S H',
    'What you check while planning and driving. In the sight the compass tape and the marks say it all.', { gone: true }],
  ['card-readout', 'Card: turret, elevation, power, weapon', '#player-card .readout, #player-card .bar.power, #player-card .weapon', 'H H H H H H',
    'The aim pad, the power strip and the weapon button already say it (the pad also says what the last shot used, the button how many rounds are left).', { gone: true }],
  ['card-money', 'Card: money', '#player-card .pc-money', 'H H H H H H',
    'Only the armory spends it, and the armory shows it.', { gone: true }],
  ['card-nojets', 'Card: jump jets, none left', '#player-card .fuel.jets:has(.none)', 'H H H H H H',
    'A row that says nothing.', { gone: true }],
  ['players', 'Players box', '#scoreboard', 'S F F H S H',
    'Everyone\'s health. The sight\'s marks carry health, a followed shell wants the field clear.', {}],
  ['players-perks', 'Players box: perk chips', '#scoreboard .sb-perks', 'S H H H S H',
    'They stretch the box down over the side view in the sight; nothing to read mid-flight.', { gone: true }],
  ['gear','Settings gear', '#settings-btn', 'S S F H S S',
    'Always reachable; faint while a shell flies.', {}],
  ['sideview', 'Side view of the shot', '#sideview', 'S M H H H H',
    'Only means something while you set the shot; in the sight it moves under the players box.', { js: true }],
  ['dials', 'Angle dials on your tank', '', 'S H H H H H',
    'The sight, the map and a shell in flight hide them.', { js: true }],
  ['marks', 'Marks over tanks', '#labels', 'S S F S S S',
    'Names while planning; names and health in the sight, the map and a Find look; faint while following a shell; names only in the kill cam.', { js: true }],
  ['locators', 'Edge arrows to off-screen enemies', '.locator', 'S H H H H H',
    'The sight draws its own markers for what is off to the side; they are for aiming, so only while you plan.', { js: true }],
  ['pad', 'Aim pad and its readout', '#touch .t-pad', 'S S H H S H',
    'The thumb\'s aim; nothing to aim once the shot has left. Its "drag" line shows only the first few matches.', {}],
  ['power', 'Power strip', '#touch .t-power', 'S S H H S H',
    'As the pad.', {}],
  ['fire', 'Lock in, weapon, sight, x2 and mods', '#touch .t-col, #touch .strike-chip', 'S S H H S H',
    'Buttons for the shot you are setting.', {}],
  ['drive', 'Drive cross and Jet', '#touch .t-left', 'S F F H F H',
    'Faint but live: steering a Guided Missile in flight lights it back up.', {}],
  ['camera', 'Fine, Find, View, Chat', '#touch .t-mid', 'S S F H S H',
    'View and Find still work in flight, and a faint button is still a button.', {}],
  ['boss', 'Boss bar', '#boss-bar', 'S M S H S H',
    'The fight\'s health bar; in the sight it moves left, off the compass tape. In plan it clears the side view.', {}],
  ['steer', 'Guidance strip', '#steer-hint', 'H H S H H H',
    'Only while a Guided Missile flies.', { js: true }],
  ['inset', 'Your tank in the corner', '#inset', 'H H S H H H',
    'Only in flight, with your tank off screen.', { js: true }],
  ['range', 'Rangefinder card', '#range-card', 'H H H H H H',
    'Too big for a phone (already cut on a short screen); the probes\' dots and beams in the world still show.', { gone: true }],
  ['notes', 'Touch notes (the hint line)', '#touch .t-note', 'S S S H S H',
    'Short, one line. The SIGHT, pad and Lock in teaching ones show the first few matches only.', { js: true }],
  ['caption', 'Kill cam caption', '#killcam-cap', 'H H H S H H',
    'The deciding shot, "A to B".', { js: true }],
];

export const HUD = ROWS.map(([id, name, sel, states, why, opt]) => {
  const list = states.split(' ').map((c) => CODES[c]);
  const views = {};
  VIEWS.forEach((v, i) => { views[v] = list[i]; });
  return { id, name, sel, views, why, gone: !!opt.gone, js: !!opt.js };
});

export const hudRow = (id) => HUD.find((r) => r.id === id);
export const hudState = (id, view) => hudRow(id)?.views[view];

// The stylesheet for the rows that are not drawn by their own code. Each hidden
// or faint row gets a rule per view; shown rows need none.
export function hudCss(rows = HUD) {
  const out = ['/* generated from src/hudview.js */'];
  const css = rows.filter((r) => !r.js && r.sel);
  const fades = css.filter((r) => !r.gone);
  if (fades.length) out.push(`${fades.map((r) => scoped(r.sel)).join(',\n')} { transition: opacity .25s; }`);
  for (const view of VIEWS) {
    const at = (state) => css.filter((r) => r.views[view] === state);
    const faint = at(FAINT), hidden = at(HIDDEN);
    if (faint.length) out.push(`${faint.map((r) => scoped(r.sel, view)).join(',\n')} { opacity: .38; }`);
    const fade = hidden.filter((r) => !r.gone);
    if (fade.length) out.push(`${fade.map((r) => scoped(r.sel, view)).join(',\n')} { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .25s, visibility 0s .25s; }`);
    const gone = hidden.filter((r) => r.gone);
    if (gone.length) out.push(`${gone.map((r) => scoped(r.sel, view)).join(',\n')} { display: none !important; }`);
  }
  return out.join('\n');
}

// "body.touch[data-view=flight] a, body.touch[data-view=flight] b" for a selector list.
function scoped(sel, view) {
  const head = view ? `body.touch[data-view="${view}"]` : 'body.touch';
  return sel.split(/,(?![^(]*\))/).map((s) => `${head} ${s.trim()}`).join(', ');
}

// Put the stylesheet in the page once.
export function installHudViews(doc = document) {
  if (doc.getElementById('hud-views')) return;
  const el = doc.createElement('style');
  el.id = 'hud-views';
  el.textContent = hudCss();
  doc.head.appendChild(el);
}

// Say which view is on (body[data-view]); cheap to call every frame.
let current = '';
export function setHudView(view, doc = document) {
  if (view === current) return;
  current = view;
  doc.body.dataset.view = view;
}
