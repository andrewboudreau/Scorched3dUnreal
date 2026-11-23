// suggestions.html: the owner's view of the suggestion box (module/Suggestions.cs).
// Asks once for the review key (kept in this browser's localStorage), then lists
// suggestions newest first, filtered by status and area, with a Done toggle and
// a note on each. For agents, tools/suggestions.mjs does the same from a shell.

const KEY = 'craterfall.reviewKey';
const base = new URL('api/suggestions', location.href).href;
const root = document.getElementById('inbox');
const state = { status: 'new', area: '', list: [] };

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};
const key = () => localStorage.getItem(KEY) || '';
const api = async (path = '', opts = {}) => {
  const r = await fetch(base + path, { ...opts, headers: { 'x-review-key': key(), 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { localStorage.removeItem(KEY); throw new Error('That key was not accepted.'); }
  if (r.status === 404 && !path) throw new Error('Reading suggestions is off on this server (no review key set at deploy).');
  if (!r.ok) throw new Error(`The server said ${r.status}.`);
  return r.json();
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

function askKey(why = '') {
  const input = h('input', { type: 'password', placeholder: 'review key', autocomplete: 'off' });
  const go = () => { if (input.value.trim()) { localStorage.setItem(KEY, input.value.trim()); load(); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.replaceChildren(h('div', { class: 'ib-key' },
    h('h1', {}, 'Craterfall suggestions'),
    why && h('p', { class: 'ib-err' }, why),
    h('p', {}, 'Enter the review key once; this browser keeps it.'),
    input, h('button', { onclick: go }, 'Open')));
  input.focus();
}

async function load() {
  if (!key()) return askKey();
  try { state.list = await api(`?status=${state.status}`); } catch (e) { return askKey(e.message); }
  draw();
}

async function update(s, change) {
  try {
    Object.assign(s, await api(`/${encodeURIComponent(s.id)}`, { method: 'POST', body: JSON.stringify(change) }));
    if (change.status && state.status !== 'all') state.list = state.list.filter((x) => x !== s);
    draw();
  } catch (e) { alert(e.message); }
}

function card(s) {
  const note = h('textarea', { rows: 1, placeholder: 'note' });
  note.value = s.note || '';
  note.addEventListener('change', () => update(s, { note: note.value }));
  const ctx = s.context ? Object.entries(s.context).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
  return h('article', { class: `ib-card ${s.status}` },
    h('div', { class: 'ib-meta' },
      h('span', { class: 'ib-area' }, s.area),
      h('span', {}, s.name || (s.player ? `player ${s.player.slice(0, 6)}` : 'anonymous')),
      h('span', { title: new Date(s.at).toLocaleString() }, ago(s.at)),
      h('span', { class: 'ib-id' }, s.id),
      h('button', { onclick: () => update(s, { status: s.status === 'done' ? 'new' : 'done' }) }, s.status === 'done' ? 'Reopen' : 'Done')),
    h('p', { class: 'ib-text' }, s.text),
    ctx && h('p', { class: 'ib-ctx' }, ctx),
    note);
}

function draw() {
  const areas = [...new Set(state.list.map((s) => s.area))].sort();
  const shown = state.list.filter((s) => !state.area || s.area === state.area);
  const tab = (id, label) => h('button', { class: state.status === id ? 'on' : '', onclick: () => { state.status = id; load(); } }, label);
  const sel = h('select', { onchange: (e) => { state.area = e.target.value; draw(); } },
    h('option', { value: '' }, 'every area'), areas.map((a) => h('option', { value: a, selected: a === state.area }, a)));
  root.replaceChildren(
    h('header', {},
      h('h1', {}, 'Craterfall suggestions'),
      h('nav', {}, tab('new', 'New'), tab('done', 'Done'), tab('all', 'All')), sel,
      h('button', { onclick: load }, 'Refresh'),
      h('button', { onclick: () => { localStorage.removeItem(KEY); askKey(); } }, 'Forget key')),
    shown.length ? shown.map(card) : h('p', { class: 'ib-empty' }, state.status === 'new' ? 'Nothing new.' : 'None.'));
}

load();
