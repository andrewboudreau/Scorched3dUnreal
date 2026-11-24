// The time of day a match is played in: a render-only choice. The game's rules
// never read it; it rides in the match config so every screen of an online
// match lights the same sky (render/timeofday.js holds what each one looks like).
//
// `Random` is not an id here: the builder sends 'random' and the Game turns it
// into one of these from the match seed (resolveTime), so the host's seed alone
// settles it on every screen, and no game rng is spent on it.

import { makeRng } from './rng.js';

// `weight` is how often Random picks each: Day is the usual look, so it comes
// up twice as often as the others.
export const TIMES = [
  { id: 'dawn', name: 'Dawn', weight: 1 },
  { id: 'day', name: 'Day', weight: 2 },
  { id: 'dusk', name: 'Dusk', weight: 1 },
  { id: 'night', name: 'Night', weight: 1 },
];
export const DEFAULT_TIME = 'day';
export const TIME_IDS = TIMES.map((t) => t.id);

// One of the ids, picked from `seed` alone (the same seed always gives the same one).
export function pickTime(seed) {
  const total = TIMES.reduce((s, t) => s + t.weight, 0);
  let roll = makeRng((seed ^ 0x7d1e5a3b) >>> 0).next() * total;
  for (const t of TIMES) { roll -= t.weight; if (roll < 0) return t.id; }
  return TIMES[TIMES.length - 1].id;
}

// A config value as a concrete id: 'random' is picked from the seed, an id is
// kept, anything else (an old build's message with none) is the plain Day.
export function resolveTime(time, seed) {
  if (time === 'random') return pickTime(seed);
  return TIME_IDS.includes(time) ? time : DEFAULT_TIME;
}

export const timeName = (id) => TIMES.find((t) => t.id === id)?.name || '';
