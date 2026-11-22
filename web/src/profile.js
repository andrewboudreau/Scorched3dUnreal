// Who is playing on this screen: a player id and the name they chose once.
// The server keeps both (GET/POST api/me, module/Players.cs): the id lives in
// an HttpOnly cookie it issues, and rooms use it to give a reloaded page its
// seat back. With no server to ask (offline, or a static host with no API)
// the id is made here and kept in localStorage instead, and so is the name
// (craterfall.name, as before), so the game plays the same either way.
//
//   profile.id       the player id ('' until `ready`)
//   profile.name     the chosen name ('' if none yet); known at once from localStorage
//   profile.online   true when the server answered and holds the id
//   tabKey()         this tab's own key, sent with room joins (see below)
//   profile.ready    resolves (never rejects) once the id is known
//   profile.setName(name)   saves a name here and, when online, on the server

export const NAME_KEY = 'craterfall.name';
export const ID_KEY = 'craterfall.localId';
export const NAME_MAX = 14;

// As the server cleans it: no control or invisible formatting characters,
// trimmed, at most 14 characters without splitting a surrogate pair.
export function cleanName(s) {
  let t = String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  if (t.length > NAME_MAX) t = t.slice(0, /[\uD800-\uDBFF]/.test(t[NAME_MAX - 1]) ? NAME_MAX - 1 : NAME_MAX).trimEnd();
  return t;
}

export const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);

// 128 random bits, URL-safe, the same shape as the server's ids.
export function newLocalId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const b = random(16);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// This tab's key, kept in sessionStorage so it lasts through a reload but a
// new tab gets its own. Rooms key a seat on the player id plus this, so two
// tabs of one browser can play each other as two seats, while a reload still
// gets its seat back. (A tab the browser duplicates copies sessionStorage, so
// it shares the key: joining from it takes the original tab's seat over.)
export const TAB_KEY = 'craterfall.tab';
export function tabKey(storage = globalThis.sessionStorage) {
  let k = null;
  try { k = storage?.getItem(TAB_KEY) ?? null; } catch { /* no storage */ }
  if (!isId(k)) {
    k = newLocalId();
    try { storage?.setItem(TAB_KEY, k); } catch { /* this page load only, then */ }
  }
  return k;
}

// `base`: the api/me URL. `fetch` and `storage` are there for tests.
export function makeProfile({ base, fetch: get = globalThis.fetch, storage = globalThis.localStorage, timeout = 5000 } = {}) {
  const store = {
    get(k) { try { return storage?.getItem(k) ?? null; } catch { return null; } },
    set(k, v) { try { storage?.setItem(k, v); } catch { /* private mode, or full */ } },
  };
  const call = async (body) => {
    const r = await get(base, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();   // a static host's HTML page throws here
    if (!data || !isId(data.id)) throw new Error('not a player');
    return data;
  };
  const take = (data) => {
    p.id = data.id;
    p.online = true;
    p.played = data.played | 0;
    p.won = data.won | 0;
  };

  const p = { id: '', name: cleanName(store.get(NAME_KEY)), online: false, played: 0, won: 0 };

  p.ready = (async () => {
    try {
      const data = await call(null);
      take(data);
      const theirs = cleanName(data.name);
      if (theirs) { p.name = theirs; store.set(NAME_KEY, theirs); }
      else if (p.name) take(await call({ name: p.name }));   // a name from before ids: hand it over
    } catch {
      if (!p.online) {
        let id = store.get(ID_KEY);
        if (!isId(id)) { id = newLocalId(); store.set(ID_KEY, id); }
        p.id = id;
      }
    }
    return p;
  })();

  p.setName = async (name) => {
    const clean = cleanName(name);
    p.name = clean;
    store.set(NAME_KEY, clean);
    await p.ready;
    if (p.online) {
      try {
        const data = await call({ name: clean });
        take(data);
        // A name changed again while this was on its way wins.
        if (p.name === clean) p.name = cleanName(data.name);
      } catch { /* kept here; the server catches up next time */ }
    }
    return p;
  };

  return p;
}

// The page's own profile; none when imported outside a browser (tests).
export const profile = globalThis.location?.href ? makeProfile({ base: new URL('api/me', globalThis.location.href).href }) : null;
