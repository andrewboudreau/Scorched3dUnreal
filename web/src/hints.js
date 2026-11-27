// Teaching lines that earn their room: each shows only the first few times, then
// the player has had it. The count is kept in localStorage (one small JSON
// object), so it carries across visits; with no storage (private mode) a hint
// shows every time rather than never.
//
//   useHint('sight', 3)   true the first 3 times it is asked, and counts the ask
//   hintLeft('sight', 3)  true while it would still show, without counting
//
// `store` is for tests: anything with getItem / setItem.

const KEY = 'craterfall.hints';

function load(store) {
  try {
    const v = JSON.parse(store.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function defaultStore() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function hintCount(key, store = defaultStore()) {
  if (!store) return 0;
  const n = Number(load(store)[key]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const hintLeft = (key, max, store = defaultStore()) => hintCount(key, store) < max;

export function useHint(key, max, store = defaultStore()) {
  if (!store) return true;
  const all = load(store);
  const n = Number(all[key]) || 0;
  if (n >= max) return false;
  all[key] = n + 1;
  try { store.setItem(KEY, JSON.stringify(all)); } catch { /* full or blocked: it just shows again */ }
  return true;
}

// Forget what has been taught (Settings could offer it; tests use it).
export function resetHints(store = defaultStore()) {
  try { store?.setItem(KEY, '{}'); } catch { /* ignore */ }
}
