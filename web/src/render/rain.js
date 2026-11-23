import * as THREE from 'three';

// Falling rain for a Rain round (core/perks.js MODIFIERS 'rain'): one pooled
// LineSegments of streaks in a box that follows the camera, slanted by the
// round's wind. Each streak fades from clear at its top to grey at its foot.
// `amount` eases between 0 and 1 as rain starts and stops; the sky, the
// fires and the sound read it, so they all fade together.
//
// Drops live in world space and wrap round the box, so they do not swim when
// the camera turns. Light quality (Settings > Graphics > Fire and smoke)
// draws under half of them.

const MAX = 1800;
const LIGHT = 0.45;          // share drawn on Light
const HALF = 55;             // box half-width round the camera, metres
const BELOW = 45, ABOVE = 30;
const FALL = [26, 34];       // m/s
const STREAK = 0.055;        // seconds of fall one streak shows
const DRIFT = 4;             // horizontal m/s per unit of wind
const FADE = 0.7;            // amount per second, in and out
const NEAR = 5;              // metres kept clear round the camera

const rnd = (a, b) => a + Math.random() * (b - a);

export class Rain {
  constructor(scene) {
    this.amount = 0;
    this.drops = new Float32Array(MAX * 4);   // x, y, z, fall speed
    this.pos = new Float32Array(MAX * 6);
    const col = new Float32Array(MAX * 8);
    for (let i = 0; i < MAX; i++) {
      col.set([0.78, 0.82, 0.88, 0, 0.78, 0.82, 0.88, 1], i * 8);   // top clear, foot grey
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: true });
    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.renderOrder = 2;
    scene.add(this.lines);
    this.seeded = false;
  }

  // Scatter every drop through the box round `c` (camera position).
  seed(c) {
    const d = this.drops;
    for (let i = 0; i < MAX; i++) {
      d[i * 4] = c.x + rnd(-HALF, HALF);
      d[i * 4 + 1] = c.y + rnd(-BELOW, ABOVE);
      d[i * 4 + 2] = c.z + rnd(-HALF, HALF);
      d[i * 4 + 3] = rnd(FALL[0], FALL[1]);
    }
    this.seeded = true;
  }

  // Stop at once (a new match, the menu).
  clear() {
    this.amount = 0;
    this.lines.visible = false;
    this.seeded = false;
  }

  // Every frame. `on`: it is raining this round. `wind` [x, z] slants the
  // streaks; `light` thins them; `groundAt(x, z)` (or null) stops drops at
  // the ground so none fall through a hill in front of the camera.
  update(dt, camera, { on = false, wind = [0, 0], light = false, groundAt = null } = {}) {
    const goal = on ? 1 : 0;
    this.amount += Math.max(-FADE * dt, Math.min(FADE * dt, goal - this.amount));
    const show = this.amount > 0.002;
    this.lines.visible = show;
    if (!show) return;
    const c = camera.position;
    if (!this.seeded) this.seed(c);
    const n = Math.floor(MAX * (light ? LIGHT : 1));
    const vx = wind[0] * DRIFT, vz = wind[1] * DRIFT;
    const d = this.drops, p = this.pos;
    const span = HALF * 2, tall = BELOW + ABOVE;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const fall = d[k + 3];
      let x = d[k] + vx * dt, y = d[k + 1] - fall * dt, z = d[k + 2] + vz * dt;
      if (x - c.x > HALF) x -= span; else if (x - c.x < -HALF) x += span;
      if (z - c.z > HALF) z -= span; else if (z - c.z < -HALF) z += span;
      const floor = groundAt ? groundAt(x, z) : null;
      if (y < c.y - BELOW || (floor != null && y < floor)) {
        // Back to the top of the box, somewhere new.
        y += tall * (0.85 + Math.random() * 0.15);
        if (floor != null && y < floor) y = c.y + ABOVE - Math.random() * 10;
        x = c.x + rnd(-HALF, HALF);
        z = c.z + rnd(-HALF, HALF);
      } else if (y > c.y + ABOVE) y -= tall;
      // None right by the lens: one there is a long line across the screen.
      const ox = x - c.x, oz = z - c.z;
      if (ox * ox + oz * oz < NEAR * NEAR && Math.abs(y - c.y) < NEAR * 2) x += ox < 0 ? -NEAR * 2 : NEAR * 2;
      d[k] = x; d[k + 1] = y; d[k + 2] = z;
      const j = i * 6;
      const s = STREAK;
      p[j] = x - vx * s; p[j + 1] = y + fall * s; p[j + 2] = z - vz * s;
      p[j + 3] = x; p[j + 4] = y; p[j + 5] = z;
    }
    const geo = this.lines.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.position.clearUpdateRanges?.();
    geo.attributes.position.addUpdateRange?.(0, n * 6);
    geo.setDrawRange(0, n * 2);
    this.mat.opacity = 0.7 * this.amount;
  }
}
