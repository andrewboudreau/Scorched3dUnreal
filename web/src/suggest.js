// The suggestion box: Settings > Suggest (pinned in the header, so it is on
// every tab), and the catalog's Suggest button. A note goes to the server
// (POST api/suggestions, module/Suggestions.cs) with where you were (an area
// you can change) and a little context the page adds itself: what screen, the
// round and its conditions, the window size. The owner reads them at
// suggestions.html or with `node tools/suggestions.mjs`.
//
// The pure part (areas, context, limits) is tested in test/suggest.test.js;
// openSuggest() is the DOM, and nothing here touches the page until it's called.

export const AREAS = [
  { id: 'game', name: 'Game' },
  { id: 'match builder', name: 'Match builder' },
  { id: 'settings', name: 'Settings' },
  { id: 'guide', name: 'Guide' },
  { id: 'catalog', name: 'Catalog' },
  { id: 'online', name: 'Online' },
  { id: 'other', name: 'Other' },
];
export const TEXT_MIN = 3, TEXT_MAX = 2000;
export const CONTEXT_MAX = 2048;   // bytes of JSON, as the server allows
const DRAFT_KEY = 'craterfall.suggestDraft';

// Is this text worth sending? '' when it is, else why not.
export function checkText(text) {
  const t = String(text ?? '').trim();
  if (t.length < TEXT_MIN) return 'Say a little more.';
  if (t.length > TEXT_MAX) return `That's over ${TEXT_MAX} characters.`;
  return '';
}

// The context sent along: plain values only, nothing personal beyond what the
// game already shows. `game` may be null (the launch screen). Kept under
// CONTEXT_MAX by dropping the least useful fields first.
export function suggestionContext({ game = null, screen = '', page = '', view = null, touch = false, ua = '' } = {}) {
  const c = { screen, page, touch: !!touch };
  if (view) c.view = `${Math.round(view.w)}x${Math.round(view.h)}`;
  if (game) {
    c.round = game.round;
    c.rounds = game.cfg?.rounds;
    c.phase = game.phase;
    c.modifier = game.modifier?.id;
    c.firing = game.cfg?.firing;
    c.players = game.players?.length;
    c.cpus = game.players?.filter((p) => p.ai).length;
    c.online = !!game.online;
  }
  if (ua) c.ua = ua.slice(0, 200);
  for (const k of ['ua', 'page', 'players', 'cpus']) {
    if (JSON.stringify(c).length <= CONTEXT_MAX) break;
    delete c[k];
  }
  return c;
}

const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } };
const saveDraft = (d) => { try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* private mode */ } };

let box = null;

// Open the box. `area`: the best guess at where the player was (they can pick
// another). `context`: from suggestionContext(). `base`: the api URL.
export function openSuggest({ area = 'other', context = {}, base = new URL('api/suggestions', location.href).href } = {}) {
  if (!document.getElementById('suggest-css')) {
    const link = Object.assign(document.createElement('link'), { id: 'suggest-css', rel: 'stylesheet', href: new URL('../css/suggest.css', import.meta.url).href });
    document.head.appendChild(link);
  }
  box?.remove();
  const el = box = document.createElement('div');
  el.id = 'suggest';
  el.innerHTML = `
    <div class="card" role="dialog" aria-label="Suggest something">
      <div class="sg-head"><h2>Suggest something</h2><button class="sg-x" title="Close">&#x2715;</button></div>
      <p class="sg-note">An idea, a bug, something that felt off. It goes straight to the developer.</p>
      <div class="sg-areas" role="radiogroup" aria-label="About"></div>
      <textarea maxlength="${TEXT_MAX}" rows="5" placeholder="What would you change?"></textarea>
      <div class="sg-foot"><span class="sg-msg"></span><button class="sg-send">Send</button></div>
    </div>`;
  document.body.appendChild(el);
  const text = el.querySelector('textarea'), msg = el.querySelector('.sg-msg'), send = el.querySelector('.sg-send');
  const draft = loadDraft();
  let pick = AREAS.some((a) => a.id === area) ? area : 'other';
  if (draft?.text) { text.value = draft.text; if (draft.area) pick = draft.area; }
  const areas = el.querySelector('.sg-areas');
  for (const a of AREAS) {
    const b = document.createElement('button');
    b.className = 'sg-area';
    b.dataset.id = a.id;
    b.setAttribute('role', 'radio');
    b.textContent = a.name;
    b.addEventListener('click', () => { pick = a.id; mark(); keep(); });
    areas.appendChild(b);
  }
  const mark = () => { for (const b of areas.children) b.setAttribute('aria-checked', String(b.dataset.id === pick)); };
  const keep = () => saveDraft(text.value.trim() ? { text: text.value, area: pick } : null);
  const close = () => { el.remove(); if (box === el) box = null; };
  mark();
  text.addEventListener('input', () => { msg.textContent = ''; keep(); });
  el.querySelector('.sg-x').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  // Typing here is not steering the tank, and Escape closes this, not Settings.
  for (const t of ['keydown', 'keyup']) el.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Escape') close(); });
  send.addEventListener('click', async () => {
    const why = checkText(text.value);
    if (why) { msg.textContent = why; text.focus(); return; }
    send.disabled = true;
    msg.textContent = 'Sending...';
    try {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ text: text.value.trim(), area: pick, context }) });
      if (!r.ok) throw new Error(r.status === 429 ? 'That is a lot of suggestions for one hour: try again later.' : `The server said no (${r.status}).`);
      saveDraft(null);
      el.querySelector('.card').innerHTML = '<div class="sg-thanks"><h2>Thanks!</h2><p>Got it.</p></div>';
      setTimeout(close, 1400);
    } catch (e) {
      send.disabled = false;
      msg.textContent = e instanceof TypeError ? 'Could not reach the server. Your note is kept; try again.' : e.message;
    }
  });
  // Not on a phone: the keyboard would cover the area chips at once.
  if (!matchMedia('(pointer: coarse)').matches) text.focus();
  return el;
}
