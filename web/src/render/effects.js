import * as THREE from 'three';

// Short-lived visual effects: fireballs, debris, smoke, shell trails.

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
    this.fireGeo = new THREE.IcosahedronGeometry(1, 2);
    this.debrisGeo = new THREE.TetrahedronGeometry(0.6);
  }

  explosion(pos, radius) {
    const [x, y, z] = pos;
    // Fireball.
    const fireMat = new THREE.MeshBasicMaterial({ color: '#ffcc66', transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const fire = new THREE.Mesh(this.fireGeo, fireMat);
    fire.position.set(x, y, z);
    this.scene.add(fire);
    this.items.push({ life: 0, max: 0.7, obj: fire, update: (it, t) => {
      const k = t / it.max;
      fire.scale.setScalar(radius * (0.35 + 0.9 * Math.sqrt(k)));
      fireMat.opacity = 1 - k;
      fireMat.color.setHSL(0.1 - 0.08 * k, 1, 0.65 - 0.35 * k);
    } });

    // Flash light.
    const light = new THREE.PointLight('#ffb060', 40 * radius, radius * 9, 1.6);
    light.position.set(x, y + radius * 0.4, z);
    this.scene.add(light);
    this.items.push({ life: 0, max: 0.45, obj: light, update: (it, t) => { light.intensity = 40 * radius * (1 - t / it.max); } });

    // Glow sprite.
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.position.set(x, y + 1, z);
    this.scene.add(glow);
    this.items.push({ life: 0, max: 0.6, obj: glow, update: (it, t) => {
      const k = t / it.max;
      glow.scale.setScalar(radius * 5 * (0.5 + k));
      glow.material.opacity = 1 - k;
    } });

    // Debris chunks thrown out of the crater.
    const n = Math.min(40, Math.round(radius * 1.6));
    const mat = new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 1, flatShading: true });
    for (let i = 0; i < n; i++) {
      const d = new THREE.Mesh(this.debrisGeo, mat);
      d.position.set(x, y + 0.5, z);
      const a = Math.random() * Math.PI * 2;
      const s = radius * (0.3 + Math.random() * 0.8);
      const v = new THREE.Vector3(Math.cos(a) * s, radius * (0.9 + Math.random() * 0.9), Math.sin(a) * s);
      const spin = new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      d.scale.setScalar(0.4 + Math.random() * Math.min(1.4, radius * 0.05));
      d.castShadow = true;
      this.scene.add(d);
      this.items.push({ life: 0, max: 2.2 + Math.random(), obj: d, update: (it, t, dt) => {
        v.y -= 9.81 * 1.6 * dt;
        d.position.addScaledVector(v, dt);
        d.rotation.x += spin.x * dt; d.rotation.y += spin.y * dt;
        if (this.groundAt && d.position.y < this.groundAt(d.position.x, d.position.z)) {
          d.position.y = this.groundAt(d.position.x, d.position.z);
          v.multiplyScalar(0.3); v.y = Math.abs(v.y) * 0.3; spin.multiplyScalar(0.5);
        }
        if (t > it.max - 0.5) d.scale.multiplyScalar(0.92);
      } });
    }

    // Smoke column.
    for (let i = 0; i < 10; i++) {
      const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, color: '#57504a', transparent: true, depthWrite: false, opacity: 0 }));
      sm.position.set(x + (Math.random() - 0.5) * radius, y + Math.random() * radius * 0.5, z + (Math.random() - 0.5) * radius);
      const rise = 2 + Math.random() * 4;
      const drift = new THREE.Vector3((Math.random() - 0.5) * 2, rise, (Math.random() - 0.5) * 2);
      const size = radius * (1.2 + Math.random());
      this.scene.add(sm);
      this.items.push({ life: -i * 0.05, max: 3.5 + Math.random() * 2, obj: sm, update: (it, t, dt) => {
        if (t < 0) return;
        const k = t / it.max;
        sm.position.addScaledVector(drift, dt);
        sm.scale.setScalar(size * (0.6 + k * 1.8));
        sm.material.opacity = Math.min(0.5, t * 3) * (1 - k) ** 1.5;
      } });
    }
  }

  dust(pos, radius) {
    for (let i = 0; i < 8; i++) {
      const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, color: '#a08463', transparent: true, depthWrite: false, opacity: 0 }));
      const a = (i / 8) * Math.PI * 2;
      sm.position.set(pos[0] + Math.cos(a) * radius * 0.6, pos[1] + 2, pos[2] + Math.sin(a) * radius * 0.6);
      this.scene.add(sm);
      this.items.push({ life: 0, max: 2.5, obj: sm, update: (it, t) => {
        const k = t / it.max;
        sm.position.y += 0.05;
        sm.scale.setScalar(radius * (0.6 + k));
        sm.material.opacity = 0.6 * (1 - k);
      } });
    }
  }

  // One soft puff that rises and thins out: exhaust, or smoke from a hurt tank.
  puff(pos, { color = '#6b6660', size = 1, life = 1.4, rise = 2.2, opacity = 0.45, drift = null } = {}) {
    const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, color, transparent: true, depthWrite: false, opacity: 0 }));
    sm.position.set(pos.x, pos.y, pos.z);
    const dx = (drift ? drift[0] : 0) + (Math.random() - 0.5) * 0.8;
    const dz = (drift ? drift[1] : 0) + (Math.random() - 0.5) * 0.8;
    this.scene.add(sm);
    this.items.push({ life: 0, max: life, obj: sm, update: (it, t, dt) => {
      const k = t / it.max;
      sm.position.x += dx * dt; sm.position.y += rise * dt; sm.position.z += dz * dt;
      sm.scale.setScalar(size * (0.7 + k * 1.9));
      sm.material.opacity = opacity * Math.min(1, t * 8) * (1 - k);
    } });
  }

  muzzleFlash(pos) {
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.position.set(...pos);
    this.scene.add(glow);
    this.items.push({ life: 0, max: 0.25, obj: glow, update: (it, t) => {
      glow.scale.setScalar(8 * (1 - t / it.max) + 2);
      glow.material.opacity = 1 - t / it.max;
    } });
  }

  update(dt) {
    for (const it of this.items) {
      it.life += dt;
      it.update(it, it.life, dt);
    }
    const keep = [];
    for (const it of this.items) {
      if (it.life >= it.max) {
        this.scene.remove(it.obj);
        if (it.obj.material && it.obj.material !== undefined && !it.sharedMat) it.obj.material.dispose?.();
      } else keep.push(it);
    }
    this.items = keep;
  }

  clear() {
    for (const it of this.items) this.scene.remove(it.obj);
    this.items = [];
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
const _dir = new THREE.Vector3();

// A projectile: a small missile (a ball for rollers, which tumble along the
// ground) plus a fading trail. `probe` marks a rangefinder dart: slimmer, pale,
// no exhaust.
export class ShellVisual {
  constructor(scene, color, { ball = 0, probe = false } = {}) {
    this.scene = scene;
    this.materials = [];
    const mat = (m) => { this.materials.push(m); return m; };
    if (ball) {
      this.mesh = new THREE.Mesh(new THREE.SphereGeometry(ball, 10, 8), mat(new THREE.MeshBasicMaterial({ color: '#fff2c4' })));
      this.ownGeometry = this.mesh.geometry;
    } else {
      this.mesh = new THREE.Group();
      const skin = mat(new THREE.MeshStandardMaterial({ color: probe ? '#eef6fa' : '#d4d9de', roughness: 0.5, metalness: 0.3, flatShading: true }));
      const paint = mat(new THREE.MeshStandardMaterial({ color: probe ? '#7fe3ff' : color, roughness: 0.6, flatShading: true, emissive: probe ? '#2a7d96' : '#000000' }));
      this.mesh.add(new THREE.Mesh(MISSILE.body, skin), new THREE.Mesh(MISSILE.nose, paint));
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Mesh(MISSILE.fin, paint);
        f.rotation.y = (k * Math.PI) / 2;
        this.mesh.add(f);
      }
      if (!probe) {
        this.flame = new THREE.Mesh(MISSILE.flame, mat(new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
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
    if (this.last && !this.ownGeometry) {
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
    if (this.ownGeometry) this.ownGeometry.dispose();
    this.materials.forEach((m) => m.dispose());
    this.line.material.opacity = Math.min(this.line.material.opacity, 0.35);
    return this.line;
  }
}
