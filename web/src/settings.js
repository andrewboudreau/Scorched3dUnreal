// Settings (the gear button): a small modal for what you change now and then
// rather than every shot. main.js adds the entries (sound, full screen, and the
// resource-pack review where the packs are served); each is a button whose
// label is read again whenever the modal opens, so it always shows the state.
//
// The gear sits bottom right on a desktop, or in the touch controls' middle row
// (TouchControls.dock) on a phone.

export class Settings {
  constructor({ parent }) {
    this.items = [];
    const btn = this.button = document.createElement('button');
    btn.id = 'settings-btn';
    btn.className = 't-btn t-small';
    btn.title = 'Settings';
    btn.innerHTML = '&#9881;';
    btn.addEventListener('click', () => this.open());

    const el = this.el = document.createElement('div');
    el.id = 'settings';
    el.className = 'screen hidden';
    el.innerHTML = `
      <div class="card">
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
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  // label: text, or a function giving it; run(): what a tap does. A run that
  // returns true leaves the modal open (a toggle you may flip back).
  add({ id, label, run, hint = '' }) {
    const b = document.createElement('button');
    b.dataset.id = id;
    b.addEventListener('click', () => {
      if (run() !== true) this.close();
      else this.render();
    });
    this.items.push({ id, label, hint, b });
    this.list.appendChild(b);
    if (this.isOpen) this.render();
  }

  render() {
    for (const it of this.items) {
      const text = typeof it.label === 'function' ? it.label() : it.label;
      it.b.innerHTML = `<b></b>${it.hint ? '<small></small>' : ''}`;
      it.b.querySelector('b').textContent = text;
      if (it.hint) it.b.querySelector('small').textContent = it.hint;
    }
  }

  open() {
    this.render();
    this.el.classList.remove('hidden');
  }

  close() { this.el.classList.add('hidden'); }
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
