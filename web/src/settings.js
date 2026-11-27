// Settings (the gear button): a small modal for what you change now and then
// rather than every shot. main.js fills it. Each group is a tab (Audio,
// Graphics, More); one shows at a time, and the last one picked is remembered.
// Rows added with `pin: true` sit in the header instead (Full screen), so they
// are there whatever tab is open. Every row reads its state
// again whenever the modal opens or a row changes, so it always shows the truth
// even when a key (M, N, - / =) changed it meanwhile.
//
// The gear sits bottom right on a desktop and above the Jet button on a phone
// (css/style.css); it stays reachable on the setup screen too.

const TAB_KEY = 'craterfall.settingsTab';

export class Settings {
  constructor({ parent }) {
    this.rows = [];
    this.groups = {};
    const btn = this.button = document.createElement('button');
    btn.id = 'settings-btn';
    btn.title = 'Settings';
    btn.setAttribute('aria-label', 'Settings');
    btn.innerHTML = '&#9881;';
    btn.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    parent.appendChild(btn);

    const el = this.el = document.createElement('div');
    el.id = 'settings';
    el.className = 'screen hidden';
    el.innerHTML = `
      <div class="card" role="dialog" aria-label="Settings">
        <div class="st-head"><h2>Settings</h2><span class="st-pin"></span><button class="st-x" title="Close">&#x2715;</button></div>
        <div class="st-tabs" role="tablist"></div>
        <div class="st-list"></div>
      </div>`;
    parent.appendChild(el);
    this.list = el.querySelector('.st-list');
    this.tabs = el.querySelector('.st-tabs');
    this.pin = el.querySelector('.st-pin');
    this.tab = null;
    try { this.tab = localStorage.getItem(TAB_KEY); } catch { /* private mode */ }
    el.querySelector('.st-x').addEventListener('click', () => this.close());
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });   // the backdrop
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) { e.stopImmediatePropagation(); this.close(); }
    }, true);
    // Space on a focused button, arrows on a slider: these are the modal's, not the tank's.
    for (const t of ['keydown', 'keyup']) el.addEventListener(t, (e) => e.stopPropagation());
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  // A tab; rows added with { group } go into it, in order.
  group(id, title, note = '') {
    const g = document.createElement('section');
    g.className = 'st-group';
    g.dataset.id = id;
    g.setAttribute('role', 'tabpanel');
    if (note) {
      g.innerHTML = '<p class="st-note"></p>';
      g.querySelector('.st-note').textContent = note;
    }
    const t = document.createElement('button');
    t.className = 'st-tab';
    t.dataset.id = id;
    t.setAttribute('role', 'tab');
    t.textContent = title;
    t.addEventListener('click', () => this.show(id));
    this.tabs.appendChild(t);
    this.groups[id] = g;
    this.list.appendChild(g);
    this.show(this.groups[this.tab] ? this.tab : Object.keys(this.groups)[0], false);
    return g;
  }

  // Show one tab (remembered for next time unless `keep` is false).
  show(id, keep = true) {
    if (!this.groups[id]) return;
    if (keep) {
      this.tab = id;
      try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
    }
    for (const [k, g] of Object.entries(this.groups)) g.hidden = k !== id;
    for (const t of this.tabs.children) t.setAttribute('aria-selected', String(t.dataset.id === id));
  }

  place(row, group) {
    if (group === 'pin') this.pin.appendChild(row.el);
    else (this.groups[group] || this.groups.more || this.group('more', 'More')).appendChild(row.el);
    this.rows.push(row);
    row.refresh();
  }

  // An action. label: text, or a function giving it. run(): what a tap does;
  // a run that returns true leaves the modal open (a toggle you may flip back).
  // pin: in the header, on every tab (group is then ignored).
  add({ id, label, run, hint = '', group, pin = false }) {
    if (pin) group = 'pin';
    const b = document.createElement('button');
    b.className = 'st-action';
    b.dataset.id = id;
    b.innerHTML = '<b></b><small></small>';
    b.addEventListener('click', () => {
      if (run() !== true) this.close();
      else this.render();
    });
    this.place({ el: b, refresh: () => {
      b.querySelector('b').textContent = typeof label === 'function' ? label() : label;
      b.querySelector('small').textContent = hint;
    } }, group);
  }

  // A level from 0 to 1 with a mute beside it.
  level({ id, label, get, set, muted, toggle, group }) {
    const row = document.createElement('div');
    row.className = 'st-level';
    row.dataset.id = id;
    row.innerHTML = `
      <label for="st-${id}"></label>
      <input id="st-${id}" type="range" min="0" max="100" step="5" />
      <output></output>
      <button class="st-mute" aria-pressed="false"></button>`;
    row.querySelector('label').textContent = label;
    const range = row.querySelector('input'), out = row.querySelector('output'), mute = row.querySelector('.st-mute');
    mute.title = `Mute ${label.toLowerCase()}`;
    range.addEventListener('input', () => { set(Number(range.value) / 100); this.render(); });
    mute.addEventListener('click', () => { toggle(); this.render(); });
    this.place({ el: row, refresh: () => {
      const v = Math.round(get() * 100), off = muted();
      range.value = v;
      out.textContent = `${v}%`;
      mute.textContent = off ? 'Off' : 'On';
      mute.setAttribute('aria-pressed', String(off));
      row.classList.toggle('muted', off);
    } }, group);
  }

  // On or off, with a line saying what it is. get(): on? set(on).
  toggle({ id, label, hint = '', get, set, group }) {
    const row = document.createElement('div');
    row.className = 'st-toggle';
    row.dataset.id = id;
    row.innerHTML = `<span><b></b><small></small></span><button class="st-mute" aria-pressed="false"></button>`;
    row.querySelector('b').textContent = label;
    row.querySelector('small').textContent = hint;
    const b = row.querySelector('button');
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => { set(!get()); this.render(); });
    this.place({ el: row, refresh: () => {
      const on = !!get();
      b.textContent = on ? 'On' : 'Off';
      b.setAttribute('aria-pressed', String(on));
      row.classList.toggle('off', !on);
    } }, group);
  }

  // A pick from a short list. An option's text may be a function (read again
  // on every refresh, as Detail's "Auto (Low)").
  choice({ id, label, options, get, set, group }) {
    const row = document.createElement('div');
    row.className = 'st-choice';
    row.innerHTML = `<label for="st-${id}"></label><select id="st-${id}"></select>`;
    row.querySelector('label').textContent = label;
    const sel = row.querySelector('select');
    const text = (o) => (typeof o.text === 'function' ? o.text() : o.text);
    for (const o of options) sel.add(new Option(text(o), o.value));
    sel.addEventListener('change', () => { set(sel.value); this.render(); });
    this.place({ el: row, refresh: () => {
      options.forEach((o, i) => { sel.options[i].text = text(o); });
      sel.value = get();
    } }, group);
  }

  render() { for (const r of this.rows) r.refresh(); }

  open() {
    this.render();
    this.el.classList.remove('hidden');
    this.button.classList.add('on');
  }

  close() {
    this.el.classList.add('hidden');
    this.button.classList.remove('on');
  }
}

// Full screen where the browser allows it (not iPhone Safari: there, Add to
// Home Screen opens the game full screen instead). On Android Chrome it also
// pins landscape.
export const canFullscreen = () => {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
};
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

export function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (isFullscreen()) { (d.exitFullscreen || d.webkitExitFullscreen)?.call(d); return; }
  const go = el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.();
  Promise.resolve(go).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
}
