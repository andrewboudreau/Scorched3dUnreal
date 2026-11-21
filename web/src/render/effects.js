import * as THREE from 'three';
import { sceneryStandIns } from './sceneryMesh.js';

// Short-lived visual effects: fireballs, debris, smoke, shell trails.

const FLASHES = 3;        // explosion lights that can glow at once
const DEBRIS_MAX = 240;   // debris chunks in the air at once
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.smokeTex = radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
    this.glowTex = radialTexture('rgba(255,240,200,1)', 'rgba(255,120,30,0)');
    this.warpTex = radialTexture('rgba(235,252,255,1)', 'rgba(90,200,255,0)');
    this.fireGeo = new THREE.IcosahedronGeometry(1, 2);
    this.debrisGeo = new THREE.TetrahedronGeometry(0.6);
    // Explosion flashes come from a fixed pool of lights that never leaves
    // the scene. Adding or removing a light changes the light count, and
    // three then recompiles every lit material: a frozen second mid-shot.
    this.flashes = [];
    for (let i = 0; i < FLASHES; i++) {
      const light = new THREE.PointLight('#ffb060', 0, 10, 1.6);
      scene.add(light);
      this.flashes.push({ light, life: 0, max: 0, peak: 0 });
    }
    // Sprites (smoke, dust, glows) and fireballs are pooled: a finished one
    // goes back on a free list instead of being disposed, so a busy volley
    // makes no new materials and no garbage.
    this.freeSprites = [];
    this.freeFires = [];
    // Debris: every chunk of every explosion is one instance of a single
    // mesh, one draw call (and one shadow draw) however many are flying.
    this.debris = new THREE.InstancedMesh(this.debrisGeo, new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 1, flatShading: true }), DEBRIS_MAX);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debris.visible = false;
    scene.add(this.debris);
    this.chunks = [];
    this.prime = 0;
    // Hidden stand-ins for the shader variants that come and go with shells
    // (missile skin, roller ball, exhaust, trails, probe beams). They never
    // render and are never disposed, which keeps those programs compiled
    // between shots; the warm-up compiles them before the match starts.
    this.keep = new THREE.Group();
    this.keep.visible = false;
    this.keep.add(
      new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
      new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false })),
      new THREE.Mesh(this.debrisGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true })),
      new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ color: '#fff2c4' })),
      new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })),
      new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
        new THREE.LineBasicMaterial({ transparent: true })),
    );
    scene.add(this.keep);
  }

  // Compile every shader the scene can need (hidden objects included, with
  // the scene's lights in place) so nothing stalls on first use mid-match.
  // `compileAsync` lets the driver build them in parallel where it can.
  async warm(renderer, camera) {
    const g = new THREE.Group();
    g.visible = false;
    g.add(...sceneryStandIns());
    this.scene.add(g);
    // The shadow pass builds its depth shaders only when it draws: keep one
    // zero-size debris chunk in it for the first frames.
    this.prime = 3;
    try {
      await renderer.compileAsync(this.scene, camera);
    } finally {
      this.scene.remove(g);
    }
  }

  sprite(map, color, additive = false) {
    const sm = this.freeSprites.pop() || new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
    const m = sm.material;
    m.map = map;
    m.color.set(color);
    m.opacity = 0;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    sm.scale.set(1, 1, 1);
    this.scene.add(sm);
    return sm;
  }

  explosion(pos, radius) {
    const [x, y, z] = pos;
    // Fireball.
    const fire = this.freeFires.pop() || new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const fireMat = fire.material;
    fireMat.color.set('#ffcc66');
    fireMat.opacity = 1;
    fire.position.set(x, y, z);
    fire.scale.setScalar(radius * 0.35);
    this.scene.add(fire);
    this.items.push({ life: 0, max: 0.7, obj: fire, pool: this.freeFires, update: (it, t) => {
      const k = t / it.max;
      fire.scale.setScalar(radius * (0.35 + 0.9 * Math.sqrt(k)));
      fireMat.opacity = 1 - k;
      fireMat.color.setHSL(0.1 - 0.08 * k, 1, 0.65 - 0.35 * k);
    } });

    // Flash light, borrowed from the pool: the one that is dimmest now.
    let f = this.flashes[0];
    for (const c of this.flashes) if (c.light.intensity < f.light.intensity) f = c;
    f.life = 0; f.max = 0.45; f.peak = 40 * radius;
    f.light.distance = radius * 9;
    f.light.intensity = f.peak;
    f.light.position.set(x, y + radius * 0.4, z);

    // Glow sprite.
    const glow = this.sprite(this.glowTex, '#ffffff', true);
    glow.position.set(x, y + 1, z);
    glow.material.opacity = 1;
    glow.scale.setScalar(radius * 2.5);
    this.items.push({ life: 0, max: 0.6, obj: glow, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      glow.scale.setScalar(radius * 5 * (0.5 + k));
      glow.material.opacity = 1 - k;
    } });

    // Debris chunks thrown out of the crater.
    const n = Math.min(40, Math.round(radius * 1.6), DEBRIS_MAX - this.chunks.length);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = radius * (0.3 + Math.random() * 0.8);
      this.chunks.push({
        p: new THREE.Vector3(x, y + 0.5, z),
        v: new THREE.Vector3(Math.cos(a) * s, radius * (0.9 + Math.random() * 0.9), Math.sin(a) * s),
        rx: 0, ry: 0, sx: Math.random() * 8, sy: Math.random() * 8,
        scale: 0.4 + Math.random() * Math.min(1.4, radius * 0.05),
        life: 0, max: 2.2 + Math.random(),
      });
    }

    // Smoke column: a small blast (flak) gets a few puffs, so a dozen at once stay cheap.
    const puffs = Math.max(4, Math.min(10, Math.round(radius * 0.9)));
    for (let i = 0; i < puffs; i++) {
      const sm = this.sprite(this.smokeTex, '#57504a');
      sm.position.set(x + (Math.random() - 0.5) * radius, y + Math.random() * radius * 0.5, z + (Math.random() - 0.5) * radius);
      const rise = 2 + Math.random() * 4;
      const dx = (Math.random() - 0.5) * 2, dz = (Math.random() - 0.5) * 2;
      const size = radius * (1.2 + Math.random());
      sm.scale.setScalar(size * 0.6);
      this.items.push({ life: -i * 0.05, max: 3.5 + Math.random() * 2, obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
        if (t < 0) return;
        const k = t / it.max;
        sm.position.x += dx * dt; sm.position.y += rise * dt; sm.position.z += dz * dt;
        sm.scale.setScalar(size * (0.6 + k * 1.8));
        sm.material.opacity = Math.min(0.5, t * 3) * (1 - k) ** 1.5;
      } });
    }
  }

  dust(pos, radius) {
    for (let i = 0; i < 8; i++) {
      const sm = this.sprite(this.smokeTex, '#a08463');
      const a = (i / 8) * Math.PI * 2;
      sm.position.set(pos[0] + Math.cos(a) * radius * 0.6, pos[1] + 2, pos[2] + Math.sin(a) * radius * 0.6);
      sm.scale.setScalar(radius * 0.6);
      this.items.push({ life: 0, max: 2.5, obj: sm, pool: this.freeSprites, update: (it, t) => {
        const k = t / it.max;
        sm.position.y += 0.05;
        sm.scale.setScalar(radius * (0.6 + k));
        sm.material.opacity = 0.6 * (1 - k);
      } });
    }
  }

  // One soft puff that rises and thins out: exhaust, or smoke from a hurt tank.
  puff(pos, { color = '#6b6660', size = 1, life = 1.4, rise = 2.2, opacity = 0.45, drift = null } = {}) {
    const sm = this.sprite(this.smokeTex, color);
    sm.position.set(pos.x, pos.y, pos.z);
    sm.scale.setScalar(size * 0.7);
    const dx = (drift ? drift[0] : 0) + (Math.random() - 0.5) * 0.8;
    const dz = (drift ? drift[1] : 0) + (Math.random() - 0.5) * 0.8;
    this.items.push({ life: 0, max: life, obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
      const k = t / it.max;
      sm.position.x += dx * dt; sm.position.y += rise * dt; sm.position.z += dz * dt;
      sm.scale.setScalar(size * (0.7 + k * 1.9));
      sm.material.opacity = opacity * Math.min(1, t * 8) * (1 - k);
    } });
  }

  // A teleport: a bright flash that swells and fades, a ring of light that
  // opens out, and sparks that rise off the spot. Sprites only, no lights.
  warp(pos) {
    const [x, y, z] = pos;
    const core = this.sprite(this.warpTex, '#ffffff', true);
    core.position.set(x, y + 2.2, z);
    core.material.opacity = 1;
    this.items.push({ life: 0, max: 0.7, obj: core, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      core.scale.setScalar(5 + 9 * Math.sin(k * Math.PI) + 6 * k);
      core.material.opacity = (1 - k) ** 1.4;
    } });
    const halo = this.sprite(this.warpTex, '#7fdcff', true);
    halo.position.set(x, y + 1.2, z);
    this.items.push({ life: 0, max: 0.55, obj: halo, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      halo.scale.setScalar(6 + 26 * Math.sqrt(k));
      halo.material.opacity = 0.7 * (1 - k);
    } });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random();
      this.puff({ x: x + Math.cos(a) * 2.2, y: y + 0.6, z: z + Math.sin(a) * 2.2 }, { color: '#bfeaff', size: 0.9, life: 0.9, rise: 6 + Math.random() * 5, opacity: 0.9 });
    }
  }

  // Jump jets firing under a tank at `pos` (just the flame and a bit of smoke).
  jetFlame(pos) {
    this.puff(pos, { color: '#ffb347', size: 1.5, life: 0.45, rise: -3.5, opacity: 0.85 });
    this.puff(pos, { color: '#8d8982', size: 2.2, life: 1.1, rise: 0.6, opacity: 0.4 });
  }

  muzzleFlash(pos) {
    const glow = this.sprite(this.glowTex, '#ffffff', true);
    glow.position.set(...pos);
    glow.material.opacity = 1;
    glow.scale.setScalar(10);
    this.items.push({ life: 0, max: 0.25, obj: glow, pool: this.freeSprites, update: (it, t) => {
      glow.scale.setScalar(8 * (1 - t / it.max) + 2);
      glow.material.opacity = 1 - t / it.max;
    } });
  }

  update(dt) {
    for (const f of this.flashes) {
      if (f.light.intensity <= 0) continue;
      f.life += dt;
      f.light.intensity = f.life >= f.max ? 0 : f.peak * (1 - f.life / f.max);
    }
    for (const it of this.items) {
      it.life += dt;
      it.update(it, it.life, dt);
    }
    let w = 0;
    for (const it of this.items) {
      if (it.life >= it.max) this.release(it);
      else this.items[w++] = it;
    }
    this.items.length = w;
    this.updateDebris(dt);
  }

  updateDebris(dt) {
    const was = this.debris.count;
    let w = 0;
    for (const c of this.chunks) {
      c.life += dt;
      if (c.life >= c.max) continue;
      c.v.y -= 9.81 * 1.6 * dt;
      c.p.addScaledVector(c.v, dt);
      c.rx += c.sx * dt; c.ry += c.sy * dt;
      if (this.groundAt) {
        const g = this.groundAt(c.p.x, c.p.z);
        if (c.p.y < g) {
          c.p.y = g;
          c.v.multiplyScalar(0.3); c.v.y = Math.abs(c.v.y) * 0.3; c.sx *= 0.5; c.sy *= 0.5;
        }
      }
      if (c.life > c.max - 0.5) c.scale *= 0.92;
      _e.set(c.rx, c.ry, 0);
      _q.setFromEuler(_e);
      _s.setScalar(c.scale);
      _m.compose(c.p, _q, _s);
      this.debris.setMatrixAt(w, _m);
      this.chunks[w++] = c;
    }
    this.chunks.length = w;
    if (w === 0 && this.prime > 0) {
      this.prime--;
      _m.makeScale(0, 0, 0);
      this.debris.setMatrixAt(0, _m);
      w = 1;
    }
    this.debris.count = w;
    this.debris.visible = w > 0;
    if (w > 0 || was > 0) this.debris.instanceMatrix.needsUpdate = true;
  }

  release(it) {
    this.scene.remove(it.obj);
    if (it.pool) it.pool.push(it.obj);
    else if (it.obj.material && !it.sharedMat) it.obj.material.dispose?.();
  }

  clear() {
    for (const it of this.items) this.release(it);
    this.items = [];
    this.chunks.length = 0;
    this.debris.count = 0;
    this.debris.visible = false;
    for (const f of this.flashes) f.light.intensity = 0;
  }
}

// Missile parts, shared by every shell in flight. Built along +y (nose up),
// then turned to face the way the shell is travelling.
const MISSILE = (() => {
  const body = new THREE.CylinderGeometry(0.26, 0.3, 1.9, 8);
  const nose = new THREE.ConeGeometry(0.26, 0.7, 8).translate(0, 1.3, 0);
  const fin = new THREE.BoxGeometry(0.06, 0.55, 0.5).translate(0, -0.72, 0.42);
  const flame = new THREE.ConeGeometry(0.22, 0.9, 8).rotateX(Math.PI).translate(0, -1.4, 0);
  return { body, nose, fin, flame };
})();
const UP = new THREE.Vector3(0, 1, 0);
const SHELL_PARTS = new Map();
const _dir = new THREE.Vector3();

// A projectile: a small missile (a ball for rollers, which tumble along the
// ground) plus a fading trail. `probe` marks a rangefinder dart: slimmer, pale,
// no exhaust.
export class ShellVisual {
  constructor(scene, color, { ball = 0, probe = false } = {}) {
    this.scene = scene;
    // Materials (and ball geometry) are shared between shells of the same
    // look and never disposed: no per-shot material setup, no recompiles.
    const mat = (key, make) => {
      let m = SHELL_PARTS.get(key);
      if (!m) SHELL_PARTS.set(key, (m = make()));
      return m;
    };
    if (ball) {
      this.mesh = new THREE.Mesh(mat(`ballgeo${ball}`, () => new THREE.SphereGeometry(ball, 10, 8)), mat('ball', () => new THREE.MeshBasicMaterial({ color: '#fff2c4' })));
      this.isBall = true;
    } else {
      this.mesh = new THREE.Group();
      const skin = mat(`skin${probe}`, () => new THREE.MeshStandardMaterial({ color: probe ? '#eef6fa' : '#d4d9de', roughness: 0.5, metalness: 0.3, flatShading: true }));
      const paint = mat(`paint${probe ? 'probe' : color}`, () => new THREE.MeshStandardMaterial({ color: probe ? '#7fe3ff' : color, roughness: 0.6, flatShading: true, emissive: probe ? '#2a7d96' : '#000000' }));
      this.mesh.add(new THREE.Mesh(MISSILE.body, skin), new THREE.Mesh(MISSILE.nose, paint));
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Mesh(MISSILE.fin, paint);
        f.rotation.y = (k * Math.PI) / 2;
        this.mesh.add(f);
      }
      if (!probe) {
        this.flame = new THREE.Mesh(MISSILE.flame, mat('flame', () => new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
        this.mesh.add(this.flame);
      }
      this.mesh.scale.setScalar(probe ? 0.75 : 1.25);
      this.mesh.visible = false;      // until it knows which way it is pointing
    }
    this.last = null;
    this.max = 400;
    this.points = new Float32Array(this.max * 3);
    this.count = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.points, 3));
    g.setDrawRange(0, 0);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: probe ? '#9fe8ff' : color, transparent: true, opacity: probe ? 0.55 : 0.85 }));
    this.line.frustumCulled = false;
    scene.add(this.mesh, this.line);
  }

  // Face the missile along its path (from the last position it was given).
  aim(pos) {
    if (this.last && !this.isBall) {
      _dir.set(pos[0] - this.last[0], pos[1] - this.last[1], pos[2] - this.last[2]);
      if (_dir.lengthSq() > 1e-6) {
        this.mesh.quaternion.setFromUnitVectors(UP, _dir.normalize());
        this.mesh.visible = true;
      }
    }
    if (this.flame) this.flame.scale.set(1, 0.75 + Math.random() * 0.5, 1);
    this.last = [pos[0], pos[1], pos[2]];
  }

  push(pos) {
    this.aim(pos);
    this.mesh.position.set(...pos);
    if (this.count >= this.max) {
      this.points.copyWithin(0, 3);
      this.count = this.max - 1;
    }
    this.points.set(pos, this.count * 3);
    this.count++;
    this.line.geometry.setDrawRange(0, this.count);
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  // Detach the trail so it can linger and fade after the shell is gone.
  finish() {
    this.scene.remove(this.mesh);
    this.line.material.opacity = Math.min(this.line.material.opacity, 0.35);
    return this.line;
  }
}
