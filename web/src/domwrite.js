// DOM write helpers for the HUD and the marks (hud.js, labels.js, rangecard.js).
// Touching the DOM with the value it already has still costs style work, so every
// per-frame write goes through one of these.

export function setText(el, s) { if (el.textContent !== s) el.textContent = s; }

// An inline style property, remembered on the element so we never read it back.
export function setStyle(el, prop, v) {
  const c = el._st || (el._st = {});
  if (c[prop] !== v) { c[prop] = v; el.style[prop] = v; }
}

export function setDisplay(el, v) { if (el._disp !== v) { el._disp = v; el.style.display = v; } }

// Move an absolutely placed element (left/top 0 in CSS) by transform, which needs no layout.
// `anchor` is the element's own centring translate from style.css.
export function moveTo(el, x, y, anchor) {
  const tf = `translate(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px) ${anchor}`;
  if (el._tf !== tf) { el._tf = tf; el.style.transform = tf; }
}

export const CENTRE = 'translate(-50%, -50%)', ABOVE = 'translate(-50%, -100%)';
