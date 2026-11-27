// The rangefinder card: a top-down plot of your last rangefinder shot, turned so
// downrange is up: the five landings, the enemy nearest them with the blast
// circle of your weapon around it, how far off the aimed probe was, and the
// turret and power the probes say would land on it. Whose card shows and its
// words are hudlogic.js (rangeOwner, rangeRead, rangeEstimate; pure, tested).
//
// main.js makes one and calls update(game, me) each frame of a match, with `me`
// the tank whose card to show (hudlogic.js rangeOwner) or null.
// deps: ranges, main.js's Map of tank id -> its last rangefinder shot
// ({ probes, elev, at, wind }); believed(p) (the fog of war); peekSpot(pos)
// (a click on the card looks at where the probes came down).

import { WEAPON_BY_ID } from './core/weapons.js';
import { TANK } from './core/tank.js';
import { rangeAxes, toRange, solveAim } from './core/rangefinder.js';
import { setText } from './domwrite.js';
import { probeColor, signed, rangeRead, rangeEstimate } from './hudlogic.js';

const $ = (id) => document.getElementById(id);

export class RangeCard {
  constructor({ ranges, believed = () => null, peekSpot = () => {} }) {
    this.ranges = ranges;
    this.believed = believed;
    this.spot = null;     // where a click on the card looks
    // The card only changes when something it shows does, so it remembers what it
    // last drew (key) and skips the canvas and the text until that differs.
    this.key = '';
    this.dims = null;     // the plot canvas's CSS size; null until read, and after a resize
    $('range-card').addEventListener('click', () => this.spot && peekSpot(this.spot));
    window.addEventListener('resize', () => { this.dims = null; });
  }

  update(game, me) {
    const r = me && this.ranges.get(me.id);
    const a = r?.probes.aim;
    const card = $('range-card');
    card.classList.toggle('hidden', !a);
    if (!a) { this.spot = null; this.key = ''; this.dims = null; return; }
    this.spot = a.pos;

    const cv = $('rc-plot');
    const dpr = window.devicePixelRatio || 1;
    if (!this.dims || !this.dims[0]) this.dims = [cv.clientWidth, cv.clientHeight];   // a layout read, so only when needed
    const [W, H] = this.dims;
    const foe = game.players.filter((p) => p.alive && p !== me).map(this.believed).filter(Boolean)
      .sort((p, q) => Math.hypot(p.x - a.pos[0], p.z - a.pos[2]) - Math.hypot(q.x - a.pos[0], q.z - a.pos[2]))[0];
    // The three reasons the estimate is "rough" are thresholds, so the key holds the verdicts, not the raw numbers.
    const moved = Math.hypot(me.x - r.at[0], me.z - r.at[1]) > 4;
    const elevOff = Math.abs(me.elev - r.elev) > 0.05;
    const windOff = Math.hypot(game.wind[0] - r.wind[0], game.wind[1] - r.wind[1]) > 0.6;
    let key = `${me.id}|${me.weapon}|${W}x${H}@${dpr}|${r.at[0]},${r.at[1]}|${r.elev}|${moved}${elevOff}${windOff}|${foe ? `${foe.x},${foe.y},${foe.z}` : '-'}`;
    for (const k in r.probes) { const pb = r.probes[k]; key += `|${k}:${pb.pos[0]},${pb.pos[1]},${pb.pos[2]},${pb.yaw},${pb.power}`; }
    if (key === this.key) return;
    this.key = key;

    const ax = rangeAxes(a.yaw);
    const pts = Object.entries(r.probes).map(([key, pb]) => ({ key, pb, ...toRange(ax, a.pos, pb.pos) }));
    const t = foe ? toRange(ax, a.pos, [foe.x, foe.y, foe.z]) : null;
    const w = game.weaponOf(me, me.weapon);
    const blast = (w?.impact.find((i) => i.type === 'blast') || WEAPON_BY_ID.shell.impact[0]).radius;

    // ---- plot
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g2 = cv.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, W, H);
    // Fit the probes; take in the enemy too unless it is far off, then pin it to the edge.
    const spread = Math.max(...pts.map((q) => Math.hypot(q.side, q.along)), 0);
    const base = Math.max(20, spread * 1.35);
    const tDist = t ? Math.hypot(t.side, t.along) : 0;
    const ext = Math.min(base * 3, Math.max(base, tDist * 1.2 + blast * 0.5));
    const k = (Math.min(W, H) / 2 - 12) / ext;
    const cx = W / 2, cy = H / 2;
    const X = (side) => cx + side * k, Y = (along) => cy - along * k;

    // Range rings round the aimed landing, a sensible step apart.
    const step = [5, 10, 25, 50, 100, 200, 500].find((s) => ext / s <= 3.2) || 1000;
    g2.strokeStyle = 'rgba(255,255,255,0.10)';
    g2.lineWidth = 1;
    g2.beginPath(); g2.moveTo(0, cy); g2.lineTo(W, cy); g2.moveTo(cx, 0); g2.lineTo(cx, H); g2.stroke();
    for (let d = step; d <= ext * 1.5; d += step) { g2.beginPath(); g2.arc(cx, cy, d * k, 0, Math.PI * 2); g2.stroke(); }
    g2.font = '10px system-ui, sans-serif';
    g2.fillStyle = 'rgba(255,255,255,0.4)';
    g2.textAlign = 'left';
    g2.fillText(`${step} m`, cx + step * k * 0.71 + 2, cy - step * k * 0.71 - 2);
    g2.fillText('▲ downrange', 2, 11);
    g2.textAlign = 'center';
    g2.fillText('you', cx, H - 3);

    // The enemy, its blast circle, and a line from the aimed landing to it.
    if (t) {
      const edge = tDist * k > Math.min(W, H) / 2 - 12;
      const s = edge ? (Math.min(W, H) / 2 - 12) / (tDist * k) : 1;
      const ex = X(t.side * s), ey = Y(t.along * s);
      g2.setLineDash([3, 3]);
      g2.strokeStyle = 'rgba(255,255,255,0.35)';
      g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(ex, ey); g2.stroke();
      g2.setLineDash([]);
      if (!edge) {
        g2.fillStyle = 'rgba(255,90,70,0.12)';
        g2.strokeStyle = 'rgba(255,110,90,0.55)';
        g2.beginPath(); g2.arc(ex, ey, blast * k, 0, Math.PI * 2); g2.fill(); g2.stroke();
      }
      g2.fillStyle = foe.color;
      g2.strokeStyle = '#000';
      if (edge) {
        // A triangle on the rim, pointing out toward it.
        const ang = Math.atan2(ey - cy, ex - cx);
        g2.beginPath();
        g2.moveTo(ex + Math.cos(ang) * 7, ey + Math.sin(ang) * 7);
        g2.lineTo(ex + Math.cos(ang + 2.4) * 6, ey + Math.sin(ang + 2.4) * 6);
        g2.lineTo(ex + Math.cos(ang - 2.4) * 6, ey + Math.sin(ang - 2.4) * 6);
        g2.closePath(); g2.fill(); g2.stroke();
      } else { g2.fillRect(ex - 5, ey - 4, 10, 8); g2.strokeRect(ex - 5, ey - 4, 10, 8); }
      g2.font = 'bold 11px system-ui, sans-serif';
      g2.textAlign = ex > W - 50 ? 'right' : ex < 50 ? 'left' : 'center';
      g2.fillText(edge ? `${foe.name} ${Math.round(tDist)} m` : foe.name, ex, ey > 24 ? ey - 9 : ey + 18);
    }

    // The probes, labelled with how each differs from the aim.
    g2.font = '10px system-ui, sans-serif';
    for (const q of pts) {
      const x = X(q.side), y = Y(q.along);
      g2.fillStyle = probeColor(q.key);
      g2.beginPath(); g2.arc(x, y, q.key === 'aim' ? 4.5 : 3.5, 0, Math.PI * 2); g2.fill();
      // Aim above its dot, the turret pair outward to either side, power to the right.
      if (q.key === 'aim') { g2.textAlign = 'center'; g2.fillText('aim', x, y - 8); }
      else if (q.key.startsWith('turn')) {
        g2.textAlign = q.side < 0 ? 'right' : 'left';
        g2.fillText(`${signed(((q.pb.yaw - a.yaw + 540) % 360) - 180, 0)}°`, x + (q.side < 0 ? -7 : 7), y + 4);
      } else { g2.textAlign = 'left'; g2.fillText(signed(q.pb.power - a.power, 0), x + 7, y + 4); }
    }

    // ---- words
    if (!t) { setText($('rc-read'), 'No enemy left to range on.'); $('rc-est').textContent = ''; $('rc-est')._html = null; return; }
    setText($('rc-read'), rangeRead(t, blast, foe.name));
    const est = solveAim(r.probes, [foe.x, foe.y, foe.z]);
    const html = rangeEstimate(est, { moved, elevOff, windOff, elev: r.elev, minPower: TANK.minPower, maxPower: TANK.maxPower });
    const estEl = $('rc-est');
    if (estEl._html !== html) { estEl._html = html; estEl.innerHTML = html; }
  }
}
