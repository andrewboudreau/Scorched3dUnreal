import * as THREE from 'three';
import { orbitPoints, modUp, ORBIT } from '../core/mods.js';
import { buildSatellite } from './satellite.js';

// Deployed mods, drawn (the rules are in core/mods.js):
//   - the Gravity Orbiter: a glowing orb (two at level 3) where each well is
//     at the game clock, a soft halo tinted the owner's colour out to where its
//     pull bites, and a faint trail behind it along its orbit. The orbit is a
//     pure function of the clock, so the trail is too: sampled backwards.
//     The clock stands still while tanks plan, so the orbs hold their place
//     then (that is where the wells will be when the shots leave) and only
//     breathe; they swing round while shells fly.
//   - the Survey Satellite: the satellite model, smaller, where it hangs.
//   - a break-up when either is shot down: a flash and tumbling pieces.

const TRAIL = 28;           // points per trail
const TRAIL_SPAN = 1.6;     // seconds of orbit the trail shows
const CORE = new THREE.Color('#e9ddff');

const haloMaterial = (color) => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.BackSide,
  uniforms: { color: { value: new THREE.Color(color).lerp(CORE, 0.3) }, strength: { value: 0.9 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `uniform vec3 color; uniform float strength; varying vec3 vN; varying vec3 vV;
    void main() {
      float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      float a = pow(1.0 - f, 2.6) * strength;
      gl_FragColor = vec4(color * a, a);
    }`,
});

export class ModsView {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = new Map();   // `${owner}:${mod}` -> drawn parts
    this.bits = [];           // break-up pieces in flight
    this.flashes = [];
    this.coreGeo = new THREE.IcosahedronGeometry(1, 0);
    this.haloGeo = new THREE.SphereGeometry(1, 20, 14);
    this.bitGeo = new THREE.TetrahedronGeometry(1, 0);
    this.flashGeo = new THREE.SphereGeometry(1, 16, 10);
  }

  // Orbs, halos and trails for one orbiter at `level`.
  makeOrbiter(color, level) {
    const g = new THREE.Group();
    const n = ORBIT[level]?.pair ? 2 : 1;
    const orbs = [];
    for (let k = 0; k < n; k++) {
      const glow = new THREE.Color(color).lerp(CORE, 0.45);
      const core = new THREE.Mesh(this.coreGeo, new THREE.MeshStandardMaterial({ color: '#2a2440', emissive: glow, emissiveIntensity: 1.1, flatShading: true, roughness: 0.4, metalness: 0.2 }));
      const halo = new THREE.Mesh(this.haloGeo, haloMaterial(color));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
      const col = new Float32Array(TRAIL * 3);
      const c = new THREE.Color(color).lerp(CORE, 0.35);
      for (let i = 0; i < TRAIL; i++) {
        const a = Math.pow(1 - i / (TRAIL - 1), 1.6) * 0.5;
        col[i * 3] = c.r * a; col[i * 3 + 1] = c.g * a; col[i * 3 + 2] = c.b * a;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      trail.frustumCulled = false;
      g.add(core, halo, trail);
      orbs.push({ core, halo, trail });
    }
    return { group: g, orbs, level, kind: 'orbiter' };
  }

  makeSatellite() {
    const body = buildSatellite();
    body.scale.setScalar(1.1);
    const g = new THREE.Group();
    g.add(body);
    return { group: g, body, kind: 'satellite' };
  }

  // Each frame. `seen(p)`: whether this screen may see `p`'s things (fog).
  update({ game, time, dt, seen = () => true }) {
    const live = new Set();
    if (game) {
      for (const p of game.players) {
        if (!seen(p)) continue;
        if (modUp(p, 'orbiter')) {
          const lv = p.mods.orbiter.level;
          const key = `${p.id}:orbiter`;
          live.add(key);
          let it = this.items.get(key);
          if (it && it.level !== lv) { this.drop(key); it = null; }
          if (!it) { it = this.makeOrbiter(p.color, lv); this.items.set(key, it); this.group.add(it.group); it.born = time; }
          this.placeOrbiter(it, p, lv, game.clock, time);
        }
        if (modUp(p, 'satellite')) {
          const key = `${p.id}:satellite`;
          live.add(key);
          let it = this.items.get(key);
          if (!it) { it = this.makeSatellite(); this.items.set(key, it); this.group.add(it.group); it.born = time; }
          const m = p.mods.satellite;
          it.group.position.set(m.x, m.y + Math.sin(time * 0.6 + p.id) * 0.8, m.z);
          it.body.rotation.set(0.12 * Math.sin(time * 0.4 + p.id), time * 0.1 + p.id, 0.08);
          it.last = [[m.x, m.y, m.z]];
          const grow = Math.min(1, (time - it.born) / 0.8);
          it.group.scale.setScalar(0.2 + 0.8 * grow);
        }
      }
    }
    for (const key of [...this.items.keys()]) if (!live.has(key)) this.drop(key);
    this.updateBits(dt);
  }

  placeOrbiter(it, p, lv, clock, time) {
    const o = ORBIT[lv];
    const now = orbitPoints(p, lv, clock);
    const grow = Math.min(1, (time - it.born) / 0.6);
    const breathe = 1 + 0.08 * Math.sin(time * 5 + p.id);
    it.last = now.map((q) => [q.x, q.y, q.z]);
    it.orbs.forEach((orb, k) => {
      const q = now[k];
      orb.core.position.set(q.x, q.y, q.z);
      orb.core.scale.setScalar(o.core * 0.75 * grow * breathe);
      orb.core.rotation.set(time * 1.3, time * 0.9, 0);
      orb.halo.position.set(q.x, q.y, q.z);
      orb.halo.scale.setScalar(o.soft * 1.15 * grow * (2 - breathe));
      const pos = orb.trail.geometry.attributes.position;
      for (let i = 0; i < TRAIL; i++) {
        const back = orbitPoints(p, lv, clock - (i / (TRAIL - 1)) * TRAIL_SPAN)[k];
        pos.setXYZ(i, back.x, back.y, back.z);
      }
      pos.needsUpdate = true;
    });
  }

  drop(key) {
    const it = this.items.get(key);
    if (!it) return;
    this.group.remove(it.group);
    it.group.traverse((o) => {
      if (o.geometry && o.geometry !== this.coreGeo && o.geometry !== this.haloGeo) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.items.delete(key);
  }

  // A mod event from the game (core/game.js, type 'mod').
  event(e, game, seen = () => true) {
    const p = game?.players[e.player];
    if (!p || !seen(p)) return;
    const it = this.items.get(`${e.player}:${e.mod}`);
    // Where its parts were last drawn (`last`: a list of points), or where the game says.
    const pts = e.pos ? [e.pos] : it?.last || [];
    if (e.what === 'down' || e.what === 'expire') {
      // Shot down: a flash and a shower of pieces. Worn out: it just crumbles.
      const loud = e.what === 'down';
      for (const pt of pts) this.breakUp(pt, e.mod === 'satellite' ? '#d8b050' : p.color, loud ? (e.mod === 'satellite' ? 16 : 9) : 4, loud);
    } else if (e.what === 'hit' && pts.length) {
      this.flash(pts[0], 3, '#ffffff', 0.25);
    }
  }

  // A flash and tumbling pieces at `pt`.
  breakUp(pt, color, n, loud) {
    if (loud) this.flash(pt, 9, '#fff2cc', 0.45);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, flatShading: true, roughness: 0.6, transparent: true });
    mat.userData.left = n;   // disposed with its last piece
    for (let k = 0; k < n; k++) {
      const a = k * 2.399963, up = Math.cos(k * 1.7);
      const m = new THREE.Mesh(this.bitGeo, mat);
      m.position.set(pt[0], pt[1], pt[2]);
      m.scale.setScalar(0.5 + 0.9 * ((k * 0.618) % 1));
      this.group.add(m);
      const sp = loud ? 9 + (k % 4) * 3 : 3;
      this.bits.push({ m, mat, v: [Math.cos(a) * sp, 4 + up * sp * 0.6, Math.sin(a) * sp], spin: [a, up * 3, 2], life: 2.8 });
    }
  }

  flash(pt, r, color, life) {
    const m = new THREE.Mesh(this.flashGeo, new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set(pt[0], pt[1], pt[2]);
    m.scale.setScalar(r * 0.3);
    this.group.add(m);
    this.flashes.push({ m, r, life, age: 0 });
  }

  updateBits(dt) {
    for (const b of this.bits) {
      b.life -= dt;
      b.v[1] -= 9.8 * dt;
      b.m.position.x += b.v[0] * dt; b.m.position.y += b.v[1] * dt; b.m.position.z += b.v[2] * dt;
      b.m.rotation.x += b.spin[0] * dt; b.m.rotation.y += b.spin[1] * dt; b.m.rotation.z += b.spin[2] * dt;
      b.mat.opacity = Math.min(1, b.life / 0.8);
      if (b.life <= 0) {
        this.group.remove(b.m);
        if (--b.mat.userData.left <= 0) b.mat.dispose();
      }
    }
    this.bits = this.bits.filter((b) => b.life > 0);

    for (const f of this.flashes) {
      f.age += dt;
      const k = f.age / f.life;
      f.m.scale.setScalar(f.r * (0.3 + 0.7 * k));
      f.m.material.opacity = Math.max(0, 1 - k);
      if (k >= 1) { this.group.remove(f.m); f.m.material.dispose(); }
    }
    this.flashes = this.flashes.filter((f) => f.age < f.life);
  }

  // A new match.
  reset() {
    for (const key of [...this.items.keys()]) this.drop(key);
    for (const b of this.bits) this.group.remove(b.m);
    for (const f of this.flashes) this.group.remove(f.m);
    this.bits = [];
    this.flashes = [];
  }
}

