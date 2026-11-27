// The rules behind events.js (the Game's events on screen): which events say
// something in the big banner and what, who a volley's camera rides with, and
// how one frame's craters are merged before the ground mesh is rebuilt. No
// three.js and no DOM, so it is tested in test/eventlogic.test.js.
//
// Each banner is [text, sub, ms], as hud.banner takes it, or null for none.

export const lockedBanner = (pass) => (pass ? ['Passed', 'Reloading after a Double Strike', 1000] : ['Locked in', '', 700]);

export const volleyBanner = (count) => ['Fire!', `${count} tanks, all together`, 1300];

// A volley with exactly one human of this screen in it: the camera rides that
// human's shell (its id); null when several (or none) share the screen.
export function volleyHero(localHumans, inVolley) {
  const alive = localHumans.filter((h) => h.alive && inVolley.includes(h.id));
  return alive.length === 1 ? alive[0].id : null;
}

// Two or more humans still in it plan on this screen: the hand-off card covers
// the field until the next one sits down.
export function needsHandoff(e, p, localHumans) {
  return !!(e.plan && !p.ai && localHumans.filter((h) => h.alive).length > 1);
}

// The first turn of a match on a phone: the pad's help and the SIGHT note
// (once per game; `hinted` is the game they were last decided for).
export function firstTurnHints({ touch, p, game, hinted }) {
  return !!(touch && !p.ai && !p.shots.length && game.round === 1 && hinted !== game);
}

// A shell that is gone: "In the sea", "Lost in the void" or "Out of the
// arena", for this screen's own shot (or anyone's when no single hero), once
// shells are flying. Probes say nothing.
export function lostBanner(e, { probe, phase, heroId, owner, isles }) {
  if (!((e.type === 'lost' || e.splash) && !probe && phase !== 'aim' && (heroId == null || owner === heroId))) return null;
  return [e.splash ? 'In the sea' : isles ? 'Lost in the void' : 'Out of the arena', '', 900];
}

// In a volley with one hero, another tank's shot leaves a pip where it lands.
export function landingPip(e, { volleyMode, heroId, owner }) {
  return !!(e.type === 'impact' && volleyMode && heroId != null && owner != null && owner !== heroId);
}

export const voidBanner = (q, heroId, sea) => [`${q.id === heroId ? 'You' : q.name} ${sea ? 'sank' : 'fell into the void'}`, '', 1800];

export const destroyedBanner = (p, by) => [`${p.name} destroyed`, by && by !== p ? `by ${by.name}` : by === p ? 'self-inflicted' : '', 1800];

// A scout's "Scouted" banner shows on the screen whose scout it was.
export const scoutBannerShows = (volleyMode, heroId, owner) => (volleyMode ? heroId === owner || heroId == null : true);
export const SCOUT_BANNER = ['Scouted', 'Everything nearby is lit up for your next two shots', 1300];

// How big a building's dust and rubble are, by what happened to it.
export const propScale = (how) => (how === 'ruin' ? 1 : how === 'hit' ? 0.6 : 0.4);

// The blast of this frame that a dying tank is thrown away from: the nearest
// one whose edge comes within 6 m of it, or null.
export function nearestBlast(blasts, p) {
  let blast = null, near = Infinity;
  for (const b of blasts) {
    const d = Math.hypot(b.pos[0] - p.x, b.pos[1] - p.y, b.pos[2] - p.z) - b.radius;
    if (d < near) { near = d; blast = b; }
  }
  return near > 6 ? null : blast;
}

// Craters of one frame (a Flak burst is fourteen) are merged where they
// overlap, so the mesh is rebuilt once over each merged box, not once per
// blast. Adds grid box `r` ({ i0, i1, j0, j1 }) to `dirty`, in place.
export function addDirty(dirty, r) {
  let box = { ...r };
  for (let k = dirty.length - 1; k >= 0; k--) {
    const d = dirty[k];
    if (d.i0 > box.i1 || d.i1 < box.i0 || d.j0 > box.j1 || d.j1 < box.j0) continue;
    box = { i0: Math.min(d.i0, box.i0), i1: Math.max(d.i1, box.i1), j0: Math.min(d.j0, box.j0), j1: Math.max(d.j1, box.j1) };
    dirty.splice(k, 1);
    k = dirty.length;   // the grown box may now reach ones it missed
  }
  dirty.push(box);
  return dirty;
}
