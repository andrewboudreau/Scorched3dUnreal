// The HUD's and the tank marks' rules and words, with no three.js and no DOM, so
// they are testable (test/hudlogic.test.js). hud.js, labels.js and rangecard.js
// draw them; this file only decides what they say and when they show.

import { WEAPONS } from './core/weapons.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- words

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Your turn" for a player named You, "Rook's turn" otherwise.
export const whose = (p, thing) => (/^you$/i.test(p.name.trim()) ? `Your ${thing}` : `${p.name}'s ${thing}`);

export const ammoText = (n) => (n === Infinity ? '∞' : `×${n}`);

// A signed number with a real minus sign: "+1.5", "−3.0".
export const signed = (v, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

// The weapons `p` has rounds of, in the weapon bar's order.
export const ownedWeapons = (game, p) => WEAPONS.filter((w) => !w.hidden && game.ammoLeft(p, w.id) > 0);

// ---------------------------------------------------------------- the player card

export const jetsText = (jets) => `${jets > 0 ? 'J ' : ''}×${jets}`;
export const fuelText = (fuel) => `${Math.floor(fuel + 0.05)} m`;
export const winsText = (wins) => '★'.repeat(Math.min(wins, 3)) + (wins > 3 ? wins : '');

// Under each aim readout: what the last shot used and how far the aim is from it
// now ("last 42.0°<b>+1.5</b>"). A CPU's card says nothing; no shot yet is a dash.
export function lastAimText({ ai = false, then = null, now, unit = '', wrap = false }) {
  if (then == null) return ai ? '' : '—';
  const d = wrap ? ((now - then + 540) % 360) - 180 : now - then;
  const delta = Math.abs(d) < 0.05 ? 'same' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
  return `last ${then.toFixed(1)}${unit}<b>${delta}</b>`;
}

// The card's note line: a driving note while it lasts, else being buried.
export function cardNote({ note = null, now = 0, phase, ai = false, buried = false }) {
  if (note && now < note.until && phase === 'aim' && !ai) return note.text;
  return buried && !ai ? 'Buried: your next shot digs you out' : '';
}

// The wind as the card draws it: from behind the turret of the tank on the card
// (yaw, degrees), so up is the way it aims and the arrow holds still while the
// camera orbits; and split into what it does to that shot, sideways and longer
// or shorter. `deg` is the arrow's rotation, rounded to half a degree.
export function windReadout([wx, wz], yawDeg = 0) {
  const mag = Math.hypot(wx, wz);
  const yaw = yawDeg * DEG;
  const along = (wx * Math.cos(yaw) + wz * Math.sin(yaw)) * 10;
  const side = (-wx * Math.sin(yaw) + wz * Math.cos(yaw)) * 10;
  const rel = Math.atan2(side, along);
  const calm = mag < 0.05;
  const parts = [];
  if (Math.abs(side) >= 0.5) parts.push(`${Math.abs(side).toFixed(0)} ${side > 0 ? 'right' : 'left'}`);
  if (Math.abs(along) >= 0.5) parts.push(`${Math.abs(along).toFixed(0)} ${along > 0 ? 'longer' : 'shorter'}`);
  return {
    deg: Math.round((rel / DEG - 90) * 2) / 2,
    opacity: calm ? 0.2 : 1,
    speed: calm ? 'calm' : (mag * 10).toFixed(0),
    aim: calm ? '' : parts.join(' · '),
  };
}

export const roundText = (round, rounds) => `Round ${round} / ${rounds}`;

// ---------------------------------------------------------------- banners

// The banner at the start of a round: { text, sub, ms, hold }. `cond` is the
// match's conditions in words (builder.js conditionsLabel), `edge` the round's
// edge rule (edgeLabel), `kit` the starting kit (armory.js kitWords). A round
// with a twist keeps the turn banner waiting `hold` ms so both are read.
export function roundBanner({ round, rounds, mod, cond = '', edge = '', kit = '' }) {
  if (mod.id === 'clear' && round === 1) return { text: 'Round 1', sub: `of ${rounds} · ${cond} · Your kit: ${kit}`, ms: 3200, hold: 0 };
  if (mod.id === 'clear') return { text: `Round ${round}`, sub: `of ${rounds} · ${cond}`, ms: 1800, hold: 0 };
  return {
    text: `Round ${round}: ${mod.name}`,
    sub: round === 1 ? `${mod.desc} ${cond} · Your kit: ${kit}` : [mod.desc, edge].filter(Boolean).join(' · '),
    ms: round === 1 ? 3600 : 3000,
    hold: 2800,
  };
}

// The banner for a turn: [title, sub, ms]. In a volley a "turn" is one tank's go
// at planning (`plan`), or a CPU driving. `coach`: still teach "tap Lock in" on a
// phone (hints.js); after that the banner is just the title.
export function turnBanner(p, { plan = false, touch = false, coach = true } = {}) {
  if (!plan) return [whose(p, 'turn'), p.ai ? `CPU · ${p.ai}` : 'Aim and fire', 1100];
  if (p.ai) return [`${p.name} is on the move`, `CPU · ${p.ai}`, 1100];
  return [whose(p, 'shot'), touch ? (coach ? 'Plan it, then tap Lock in' : '') : 'Plan it, then Space to lock it in', coach ? 1700 : 1000];
}

// How long a banner asked for now waits behind one holding the screen until `hold`.
export const bannerDelay = (hold, now) => Math.max(50, hold - now);

// ---------------------------------------------------------------- tank marks

// Over a tank: shown while it is alive, seen, in front of the camera and near
// the screen (projected `v`, -1..1). In the sight, not over your own tank: it
// would sit on the turret line.
export function markShows({ alive, seen, v, ownInSight = false }) {
  return alive && seen && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && !ownInSight;
}

// A fog ghost's line: "last seen here, 2 turns ago" or "roughly here".
export function ghostText({ r, ago, volley = false }) {
  const unit = volley ? 'volley' : 'turn';
  return (r ? 'roughly here' : 'last seen here') + (ago > 0 ? `, ${ago} ${unit}${ago > 1 ? 's' : ''} ago` : '');
}

// Whose edge arrows show: the human planning here, outside the sight (it draws
// its own markers), the map and a hand-off card. Null: none.
export function locatorOwner({ phase, current, handoff = false, overview = false, mode }) {
  return phase === 'aim' && !handoff && !overview && mode !== 'sight' && current && !current.ai ? current : null;
}

// An edge arrow's range: "~120 m" when the spot is only a guess.
export const rangeText = (b, me) => `${b.r ? '~' : ''}${Math.round(Math.hypot(b.x - me.x, b.z - me.z))} m`;

// A landing pip is hidden behind a hand-off card, and a rangefinder probe's
// (`sticky`) while someone else plans.
export const pipHidden = ({ handoff = false, sticky = false, phase, current, owner }) =>
  handoff || (sticky && phase === 'aim' && !!current && current.id !== owner);

// Rangefinder colours: the aimed probe white, turret pair amber, power pair cyan.
export const PROBE_COLORS = { aim: '#ffffff', turn: '#ffc35a', power: '#6fe3ff' };
export const probeColor = (key) => PROBE_COLORS[key.replace(/[+-]$/, '')];
export const probeLabel = (pb) => (pb.key === 'aim' ? 'as aimed'
  : pb.key.startsWith('turn') ? `turret ${pb.yaw.toFixed(1)}°` : `power ${pb.power.toFixed(1)}`);

// Where a projected point (`v`, normalised device coordinates) sits on a W x H
// screen. One off screen (or behind the camera) is pulled onto an edge, in far
// enough for a name to fit and clear of the HUD panels (`boxes`); `angle` then
// points from there toward it.
export function screenSpot(v, W, H, boxes = []) {
  let nx = v.x, ny = v.y;
  const behind = v.z > 1;
  if (behind) { nx = -nx; ny = -ny; }
  const off = behind || Math.abs(nx) > 1 || Math.abs(ny) > 1;
  if (off) { const m = Math.max(Math.abs(nx), Math.abs(ny)) || 1; nx /= m; ny /= m; }
  const [l, r, t, b] = off ? [80, W - 80, 60, H - 125] : [10, W - 10, 10, H - 10];
  const sx = Math.min(r, Math.max(l, (nx * 0.5 + 0.5) * W));
  let sy = Math.min(b, Math.max(t, (-ny * 0.5 + 0.5) * H));
  if (off) {
    // Keep clear of the HUD panels: slide down below any that it lands on.
    for (const box of boxes) {
      if (box.width && sx > box.left - 30 && sx < box.right + 30 && sy > box.top - 30 && sy < box.bottom + 25) sy = Math.min(b, box.bottom + 25);
    }
  }
  return { sx, sy, off, angle: Math.atan2(-ny, nx), l, r, t, b };
}

// Slide an edge marker (a screenSpot) along its edge until it clears the ones
// already placed ([x, y] pairs), then add it to them.
export function unstack(s, placed) {
  const alongY = s.sx === s.l || s.sx === s.r;
  for (let tries = 0; tries < 6 && placed.some(([px, py]) => Math.hypot(px - s.sx, py - s.sy) < 34); tries++) {
    if (alongY) s.sy = Math.min(s.b, Math.max(s.t, s.sy + 36)); else s.sx = Math.min(s.r, Math.max(s.l, s.sx + 90));
  }
  placed.push([s.sx, s.sy]);
}

// ---------------------------------------------------------------- rangefinder card

// Whose card to show: the planner's while planning, your own while shells fly.
export function rangeOwner(game, { handoff = false, heroId = null } = {}) {
  if (!game || handoff) return null;
  if (game.phase === 'aim') return game.current && !game.current.ai ? game.current : null;
  if (heroId != null) return game.players[heroId];
  return game.localHumans.length === 1 ? game.localHumans[0] : null;
}

// How the aimed probe fell against the enemy (`t`: { side, along } in range
// axes), with `blast` the weapon's radius.
export function rangeRead(t, blast, foeName) {
  const off = Math.hypot(t.side, t.along);
  return off <= blast * 0.8 ? `As aimed: on ${foeName}`
    : `As aimed: ${Math.round(Math.abs(t.along))} m ${t.along > 0 ? 'short' : 'long'}, ${Math.round(Math.abs(t.side))} m ${t.side > 0 ? 'left' : 'right'} of ${foeName}`;
}

// The card's suggestion (HTML), from the probes' estimate (rangefinder.js
// solveAim) and the reasons it is rough.
export function rangeEstimate(est, { moved = false, elevOff = false, windOff = false, elev = 0, minPower, maxPower }) {
  const notes = [];
  if (moved) notes.push('you have moved');
  if (elevOff) notes.push(`probed at ${elev.toFixed(1)}° elevation`);
  if (windOff) notes.push('the wind has shifted');
  const note = notes.length ? `<small>Rough: ${notes.join(', ')}.</small>` : '';
  if (!est || Math.abs(est.dYaw) > 25 || Math.abs(est.dPower) > 35) return `Too far off to estimate: aim again and probe.${note}`;
  if (est.power > maxPower || est.power < minPower) return `Needs power ${est.power.toFixed(0)}: change the elevation.${note}`;
  return `Try turret ${est.yaw.toFixed(1)}° (${signed(est.dYaw)}), power ${est.power.toFixed(1)} (${signed(est.dPower)})${note}`;
}
