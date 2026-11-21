// Settings (the gear button): a small modal for what you change now and then
// rather than every shot. main.js fills it: a Sound group (Master, Effects and
// Music levels, each with a mute, and the music track), full screen, and the
// resource-pack review where the packs are served. Every row reads its state
// again whenever the modal opens or a row changes, so it always shows the truth
// even when a key (M, N, - / =) changed it meanwhile.
//
// The gear sits bottom right on a desktop and above the Jet button on a phone
// (css/style.css); it stays reachable on the setup screen too.

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
        <div class="st-head"><h2>Settings</h2><button class="st-x" title="Close">&#x2715;</button></div>
        <div class="st-list"></div>
      </div>`;
    parent.appendChild(el);
    this.list = el.querySelector('.st-list');
    el.querySelector('.st-x').addEventListener('click', () => this.close());
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });   // the backdrop
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) { e.stopImmediatePropagation(); this.close(); }
    }, true);
    // Space on a focused button, arrows on a slider: these are the modal's, not the tank's.
    for (const t of ['keydown', 'keyup']) el.addEventListener(t, (e) => e.stopPropagation());
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  // A titled group; rows added with { group } go into it, in order.
  group(id, title, note = '') {
    const g = document.createElement('section');
    g.className = 'st-group';
    g.innerHTML = `<h3></h3>${note ? '<p class="st-note"></p>' : ''}`;
    g.querySelector('h3').textContent = title;
    if (note) g.querySelector('.st-note').textContent = note;
    this.groups[id] = g;
    this.list.appendChild(g);
    return g;
  }

  place(row, group) {
    (this.groups[group] || this.groups.more || this.group('more', 'More')).appendChild(row.el);
    this.rows.push(row);
    row.refresh();
  }

  // An action. label: text, or a function giving it. run(): what a tap does;
  // a run that returns true leaves the modal open (a toggle you may flip back).
  add({ id, label, run, hint = '', group }) {
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

  // A pick from a short list.
  choice({ id, label, options, get, set, group }) {
    const row = document.createElement('div');
    row.className = 'st-choice';
    row.innerHTML = `<label for="st-${id}"></label><select id="st-${id}"></select>`;
    row.querySelector('label').textContent = label;
    const sel = row.querySelector('select');
    for (const o of options) sel.add(new Option(o.text, o.value));
    sel.addEventListener('change', () => { set(sel.value); this.render(); });
    this.place({ el: row, refresh: () => { sel.value = get(); } }, group);
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
