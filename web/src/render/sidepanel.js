import { makeFlight, makeSide, traceFlight, layoutSide, fitSide, alongShot, loadSide, saveSide } from '../sideview.js';
import { perkSum } from '../core/perks.js';

// The side view: a small panel with the shot you are planning drawn flat, side
// on. From behind the tank the 3D arc is edge on and hard to read; here you
// see the climb against the ground under it, the tank, and any enemy near the
// line of the shot. The numbers and the honesty rule (the climb only, plus
// what the Tracer perk shows) are in src/sideview.js. A 2D canvas, redrawn
// only when the aim, the wind or the ground changes; the panel takes no touches.

const SIZES = { touch: [196, 76], desk: [264, 104] };   // CSS px

export class SidePanel {
  constructor(parent, { touch = false } = {}) {
    this.touch = touch;
    this.enabled = loadSide(touch);
    const c = this.canvas = document.createElement('canvas');
    c.id = 'sideview';
    c.className = 'hidden';
    c.setAttribute('aria-hidden', 'true');
    parent.appendChild(c);
    this.ctx = c.getContext('2d');
    this.flight = makeFlight();
    this.side = makeSide();
    this.fit = { k: 1, ox: 0, oy: 0 };
    this.key = '';
    this.w = 0; this.h = 0; this.dpr = 0;
    this.shown = false;
    this.along = [];       // enemies near the line: { along, y, color }
    this.text = '';
  }

  setEnabled(on) {
    this.enabled = !!on;
    saveSide(this.enabled);
    if (!this.enabled) this.hide();
  }

  hide() {
    if (this.shown) { this.canvas.classList.add('hidden'); this.shown = false; }
    this.key = '';
  }

  // Once a frame. `p` is the tank planning (null: none); `enemies` as the
  // sight takes them: [{ color, x, y, z }]. `sight` is the camera riding
  // behind the turret (the panel moves down to clear the compass tape).
  update(game, p, enemies, { sight = false } = {}) {
    if (!this.enabled || !p) { this.hide(); return; }
    const reach = perkSum(p, 'tracer');
    const t = game.terrain;
    const jam = !!game.arcJammed?.(p);   // a level 2 Jammer Drone over it: no climb (core/mods.js JAM)
    let key = [p.x, p.y, p.z, p.yaw, p.elev, p.power, game.wind[0], game.wind[1], game.gravity, game.shellDrag(p) * 1e4, t.wells.length, t.edge, reach, game.round, +jam].map((n) => (+n).toFixed(2)).join();
    for (const e of enemies) key += `|${e.x | 0},${e.z | 0},${e.y | 0}`;
    if (!this.shown) { this.canvas.classList.remove('hidden'); this.shown = true; }
    this.canvas.classList.toggle('in-sight', sight);
    if (key === this.key) return;
    this.key = key;
    traceFlight(this.flight, game, p, reach);
    layoutSide(this.side, this.flight, t, p);
    this.along.length = 0;
    for (const e of enemies) {
      const a = alongShot(this.side, p, e.x, e.z);
      if (a && Math.abs(a.side) <= 22) this.along.push({ s: a.along, y: e.y, color: e.color });
    }
    const f = this.flight, top = this.side;
    const out = Math.round(Math.hypot(f.x[top.top] - p.x, f.z[top.top] - p.z));
    const up = Math.round(top.topY - p.y);
    this.jam = jam;
    this.text = jam ? 'Jammed' : f.hit === 'ground' && f.apexAt < 0 ? `hits ${out} m out` : f.hit === 'wall' && f.apexAt < 0 ? `wall ${up} m up` : f.hit === 'moon' && f.apexAt < 0 ? 'into a moon' : `top ${up} m up, ${out} m out`;
    this.draw(p.color);
  }

  size() {
    const [w, h] = this.touch ? SIZES.touch : SIZES.desk;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      const c = this.canvas;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
  }

  draw(color) {
    this.size();
    const { ctx, w, h, side, flight } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10, 14, 20, 0.62)';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    const { k, ox, oy } = fitSide(side, w, h, 5, this.fit);
    const X = (s) => ox + s * k;
    const Y = (y) => oy - y * k;
    // Water, where there is a sea.
    if (side.water != null) {
      ctx.fillStyle = 'rgba(60, 120, 190, 0.45)';
      const wy = Math.min(h, Y(side.water));
      ctx.fillRect(0, wy, w, h - wy);
    }
    // The ground: runs of samples, cut where there is none (a wall, a wrap, the void).
    const g = side.ground, N = g.length, bottom = h;
    ctx.fillStyle = '#6b573f';
    ctx.strokeStyle = '#a5c46d';
    ctx.lineWidth = 1.4;
    let run = -1;
    for (let i = 0; i <= N; i++) {
      const ok = i < N && g[i] === g[i];
      if (ok && run < 0) { run = i; ctx.beginPath(); ctx.moveTo(X(side.s0 + i * side.ds), bottom); }
      if (ok) ctx.lineTo(X(side.s0 + i * side.ds), Y(g[i]));
      if (!ok && run >= 0) {
        ctx.lineTo(X(side.s0 + (i - 1) * side.ds), bottom);
        ctx.closePath(); ctx.fill();
        ctx.beginPath();
        for (let q = run; q < i; q++) (q === run ? ctx.moveTo : ctx.lineTo).call(ctx, X(side.s0 + q * side.ds), Y(g[q]));
        ctx.stroke();
        run = -1;
      }
    }
    // Where the shot meets the arena's edge (a bounce, a wrap or a wall): a thin line.
    if (side.edgeS === side.edgeS) {
      const ex = X(side.edgeS);
      ctx.strokeStyle = 'rgba(160, 220, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ex, 12); ctx.lineTo(ex, h - 2); ctx.stroke();
    }
    // The tank.
    ctx.fillStyle = color;
    ctx.fillRect(X(side.tankS) - 3.5, Y(side.tankY + 2.2), 7, Math.max(3.5, 2.6 * k));
    // Enemies near the line of the shot (a tick on the ground at their range).
    for (const e of this.along) {
      const ex = X(e.s), ey = Y(e.y);
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.moveTo(ex, ey - 7); ctx.lineTo(ex + 3.5, ey - 1); ctx.lineTo(ex - 3.5, ey - 1); ctx.closePath(); ctx.fill();
    }
    if (this.jam) {
      // Jammed: static where the climb would be, and the word.
      ctx.restore();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      for (let i = 0; i < 9; i++) ctx.fillRect((i * 53) % 30, 14 + ((i * 37) % Math.max(1, h - 20)), w - ((i * 29) % 40), 1.5);
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ff8a7a';
      ctx.fillText('JAMMED', w / 2, h / 2);
      return;
    }
    // The shot: the climb (or what the Tracer shows), a dot at the end, and
    // the ground under it. Nothing is drawn past it.
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < side.n; i++) {
      const x = X(side.s[i]), y = Y(side.y[i]);
      if (i === 0 || i === side.n1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const tx = X(side.topS), ty = Y(side.topY);
    if (flight.hit && flight.apexAt < 0) {
      // It met the ground (or a wall, or a moon) on the way up: a cross where it ended.
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx - 3.5, ty - 3.5); ctx.lineTo(tx + 3.5, ty + 3.5); ctx.moveTo(tx + 3.5, ty - 3.5); ctx.lineTo(tx - 3.5, ty + 3.5); ctx.stroke();
    } else {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2); ctx.fill();
      if (side.topUnder === side.topUnder && side.topUnder < side.topY - 2) {
        const gy = Y(side.topUnder);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(tx, ty + 3); ctx.lineTo(tx, gy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(tx, gy, 5, 1.8, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
    // The same words as the arc's label, small, in the empty corner.
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText(this.text + (flight.edge ? `, ${flight.edge}` : ''), w - 5, 3);
  }
}
