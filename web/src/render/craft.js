import * as THREE from 'three';

// Over the floating isles, instead of birds: now and then a strange craft or
// two drifts across the sky, high above the fight, pausing to hover a moment
// before going on its way. Purely for show; nothing here touches the game.

const MAX = 2;
const LIGHTS = 8;
const _v = new THREE.Vector3();

function hullGeometry() {
  // A lens: a shallow upper shell, a sharp rim and a deeper keel beneath.
  const pts = [
    [0, -2.2], [2.2, -1.9], [4.6, -1.0], [7.2, -0.1], [7.4, 0.15],
    [6.6, 0.6], [4.4, 1.15], [2.6, 1.35], [0, 1.4],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 14);
  g.computeVertexNormals();
  return g;
}

// Two colourways, handed out by turns: the cool silver-violet and a warmer
// bronze with a rose dome. Same ship, a different crew.
const WAYS = [
  { hull: '#a29dbb', glowHull: '#3a3358', dome: '#7ff5e0', glowDome: '#3fd8c0', under: '#9ffff0' },
  { hull: '#b8a49a', glowHull: '#4d3340', dome: '#ffb5a0', glowDome: '#e0724f', under: '#ffd2b0' },
];

function makeCraft(_, index = 0) {
  const way = WAYS[index % WAYS.length];
  const group = new THREE.Group();
  const hull = new THREE.Mesh(hullGeometry(), new THREE.MeshStandardMaterial({
    color: way.hull, metalness: 0.45, roughness: 0.4, flatShading: true, emissive: way.glowHull, emissiveIntensity: 0.8,
  }));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({
    color: way.dome, emissive: way.glowDome, emissiveIntensity: 0.9, transparent: true, opacity: 0.75, roughness: 0.1, flatShading: true,
  }));
  dome.position.y = 1.2;
  const keel = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 0.6, 10), new THREE.MeshBasicMaterial({ color: '#ffcf6a' }));
  keel.position.y = -2.2;
  group.add(hull, dome, keel);
  // Running lights round the rim, chasing.
  const lights = [];
  const bulb = new THREE.SphereGeometry(0.42, 6, 4);
  for (let k = 0; k < LIGHTS; k++) {
    const a = (k / LIGHTS) * Math.PI * 2;
    const m = new THREE.Mesh(bulb, new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    m.position.set(Math.cos(a) * 6.9, 0.05, Math.sin(a) * 6.9);
    hull.add(m);
    lights.push(m);
  }
  // A soft glow under the keel.
  const glow = new THREE.Mesh(new THREE.CircleGeometry(4.5, 20).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({
    color: way.under, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  glow.position.y = -2.6;
  group.add(glow);
  group.visible = false;
  return { group, hull, lights, glow, trip: null };
}

export class AlienCraft {
  constructor(scene) {
    this.craft = Array.from({ length: MAX }, makeCraft);
    for (const c of this.craft) scene.add(c.group);
    this.on = false;
    this.half = 400;
    this.wait = 0;
    this.time = 0;
  }

  // On for the isles (with the field's half-size), off elsewhere.
  set(on, half = 400) {
    this.on = on;
    this.half = half;
    this.wait = 6 + Math.random() * 10;       // the first one comes along soon
    for (const c of this.craft) { c.trip = null; c.group.visible = false; }
  }

  // A crossing: in from beyond one edge, out past the other, high up, with
  // perhaps a pause to hover on the way. Sometimes a second one follows.
  launch() {
    const R = this.half * 1.5;
    const a = Math.random() * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const side = (Math.random() - 0.5) * this.half;
    const y = 130 + Math.random() * 110;
    const speed = 22 + Math.random() * 14;
    const hover = Math.random() < 0.6 ? 0.35 + Math.random() * 0.3 : -1;   // where on the way, if at all
    const pair = Math.random() < 0.35 ? 2 : 1;
    for (let i = 0; i < pair; i++) {
      const c = this.craft[i];
      const lag = i * (40 + Math.random() * 30);
      c.trip = {
        from: [-dx * R - dz * side - dx * lag, y + i * 18, -dz * R + dx * side - dz * lag + i * 25],
        dir: [dx, dz], len: 2 * R + lag, speed: speed * (1 - i * 0.05),
        s: 0, hover, held: 0, phase: Math.random() * 10, spin: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6),
      };
      c.group.visible = true;
    }
    this.wait = 35 + Math.random() * 45;
  }

  update(dt) {
    this.time += dt;
    if (!this.on) return;
    const busy = this.craft.some((c) => c.trip);
    if (!busy && (this.wait -= dt) <= 0) this.launch();
    for (const c of this.craft) {
      const t = c.trip;
      if (!t) continue;
      // Slow to a stop at the hover point, hold, then away again.
      const at = t.s / t.len;
      let v = t.speed;
      if (t.hover > 0 && t.held < 4) {
        const near = Math.abs(at - t.hover) * t.len;
        if (near < 60) v *= Math.max(0, near / 60);
        if (near < 2 || (at > t.hover && v < 1)) { t.held += dt; v = t.held >= 4 ? 2 : 0; }
      }
      t.s += v * dt;
      if (t.s > t.len) { c.trip = null; c.group.visible = false; continue; }
      const time = this.time + t.phase;
      const weave = Math.sin(time * 0.35) * 14;
      const [dx, dz] = t.dir;
      c.group.position.set(
        t.from[0] + dx * t.s - dz * weave,
        t.from[1] + Math.sin(time * 1.3) * 1.6,
        t.from[2] + dz * t.s + dx * weave,
      );
      c.hull.rotation.y += t.spin * dt;
      // A small lean into the weave, and into the travel while it moves.
      c.group.rotation.set(Math.cos(time * 0.35) * 0.12, 0, -Math.min(1, v / t.speed) * 0.08);
      c.group.rotation.y = Math.atan2(-dz, dx);
      for (let k = 0; k < LIGHTS; k++) {
        const on = ((k + Math.floor(time * 8)) % LIGHTS) < 3;
        c.lights[k].material.color.set(on ? '#ffe28a' : '#6a5cff');
      }
      c.glow.material.opacity = 0.18 + 0.12 * Math.sin(time * 3) + (v < 1 ? 0.15 : 0);
    }
  }

  // The nearest craft to a point, for sound (or null).
  nearest(p) {
    let best = null;
    for (const c of this.craft) if (c.trip) {
      const d = c.group.position.distanceTo(p);
      if (!best || d < best) best = d;
    }
    return best;
  }
}
