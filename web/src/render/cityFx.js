import * as THREE from 'three';
import { addFogShade } from './terrainMesh.js';

// The City's moving wreckage, for show only (core/city.js has already decided
// what is gone; nothing here feeds back into the game):
//
//  - Debris: blocks thrown off a broken building, with gravity, spin and a
//    bounce or two, that settle on the ground, then sink into it and go. One
//    pooled InstancedMesh; no allocation per frame.
//  - Falling pieces: a whole building that gives way drops into its rubble,
//    leaning and crumbling as it goes; a corner whose foot was blown out
//    topples into the street. Each is a short-lived mesh of the piece as it
//    stood, sharing the town's materials.

const GRAVITY = 18;          // m/s², a bit more than real: it reads better at this scale
const DEBRIS = 420;          // blocks in the pool
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const S = new THREE.Vector3();
const C = new THREE.Color();

export class Debris {
  constructor() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    addFogShade(mat, 'cityDebris');
    this.mesh = new THREE.InstancedMesh(geo, mat, DEBRIS);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    for (let i = 0; i < DEBRIS; i++) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.mesh.setColorAt(i, C.set(0x777777));
    }
    this.p = new Float32Array(DEBRIS * 3);     // position
    this.v = new Float32Array(DEBRIS * 3);     // velocity
    this.r = new Float32Array(DEBRIS * 3);     // rotation (Euler)
    this.w = new Float32Array(DEBRIS * 3);     // spin
    this.s = new Float32Array(DEBRIS * 3);     // size
    this.t = new Float32Array(DEBRIS);         // time left resting, then sinking
    this.mode = new Uint8Array(DEBRIS);        // 0 free, 1 flying, 2 resting, 3 sinking
    this.next = 0;
    this.active = 0;
  }

  // One block at x/y/z with velocity vx/vy/vz, about `size` m, colour [r, g, b].
  throw(x, y, z, vx, vy, vz, size, col) {
    const i = this.next;
    this.next = (i + 1) % DEBRIS;
    if (!this.mode[i]) this.active++;
    const j = i * 3;
    this.p[j] = x; this.p[j + 1] = y; this.p[j + 2] = z;
    this.v[j] = vx; this.v[j + 1] = vy; this.v[j + 2] = vz;
    this.r[j] = Math.random() * 6; this.r[j + 1] = Math.random() * 6; this.r[j + 2] = Math.random() * 6;
    this.w[j] = (Math.random() - 0.5) * 10; this.w[j + 1] = (Math.random() - 0.5) * 10; this.w[j + 2] = (Math.random() - 0.5) * 10;
    this.s[j] = size * (0.6 + Math.random() * 0.8);
    this.s[j + 1] = size * (0.35 + Math.random() * 0.6);
    this.s[j + 2] = size * (0.5 + Math.random() * 0.8);
    this.t[i] = 2.5 + Math.random() * 3;
    this.mode[i] = 1;
    const k = 0.8 + Math.random() * 0.3;
    this.mesh.setColorAt(i, C.setRGB(col[0] * k, col[1] * k, col[2] * k));
    this.mesh.instanceColor.needsUpdate = true;
  }

  // `n` blocks from inside box [x0, x1, y0, y1, z0, z1], flung away from
  // `from` (a blast, or null: outwards and up) at about `speed` m/s.
  burst(box, n, cols, from, speed = 9, size = 1) {
    const cx = (box[0] + box[1]) / 2, cy = (box[2] + box[3]) / 2, cz = (box[4] + box[5]) / 2;
    for (let k = 0; k < n; k++) {
      const x = box[0] + Math.random() * (box[1] - box[0]);
      const y = box[2] + Math.random() * (box[3] - box[2]);
      const z = box[4] + Math.random() * (box[5] - box[4]);
      let dx = x - (from ? from[0] : cx), dy = y - (from ? from[1] : cy - 2), dz = z - (from ? from[2] : cz);
      const l = Math.hypot(dx, dy, dz) || 1;
      const sp = speed * (0.4 + Math.random() * 0.8);
      dx = (dx / l) * sp + (Math.random() - 0.5) * 3;
      dz = (dz / l) * sp + (Math.random() - 0.5) * 3;
      dy = Math.max(0, dy / l) * sp + 2 + Math.random() * 4;
      this.throw(x, y, z, dx, dy, dz, size * (0.5 + Math.random() * 0.9), cols[k % cols.length]);
    }
  }

  update(dt, ground) {
    if (!this.active) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const { p, v, r, w, s, t, mode } = this;
    for (let i = 0; i < DEBRIS; i++) {
      const m = mode[i];
      if (!m) continue;
      const j = i * 3;
      if (m === 1) {
        v[j + 1] -= GRAVITY * dt;
        p[j] += v[j] * dt; p[j + 1] += v[j + 1] * dt; p[j + 2] += v[j + 2] * dt;
        r[j] += w[j] * dt; r[j + 1] += w[j + 1] * dt; r[j + 2] += w[j + 2] * dt;
        const g = ground(p[j], p[j + 2]) + s[j + 1] * 0.4;
        if (p[j + 1] < g && v[j + 1] < 0) {
          p[j + 1] = g;
          if (v[j + 1] < -4) {
            // Bounce: lose most of it, and spin less.
            v[j + 1] *= -0.3; v[j] *= 0.55; v[j + 2] *= 0.55;
            w[j] *= 0.5; w[j + 1] *= 0.5; w[j + 2] *= 0.5;
          } else {
            mode[i] = 2;
            // Lie flat-ish where it lands.
            r[j] = Math.round(r[j] / (Math.PI / 2)) * (Math.PI / 2) + (Math.random() - 0.5) * 0.3;
            r[j + 2] = Math.round(r[j + 2] / (Math.PI / 2)) * (Math.PI / 2) + (Math.random() - 0.5) * 0.3;
          }
        }
      } else if (m === 2) {
        if ((t[i] -= dt) <= 0) mode[i] = 3;
      } else {
        p[j + 1] -= 0.5 * dt;
        if (p[j + 1] < ground(p[j], p[j + 2]) - s[j + 1]) {
          mode[i] = 0;
          this.active--;
          this.mesh.setMatrixAt(i, HIDDEN);
          continue;
        }
      }
      Q.setFromEuler(E.set(r[j], r[j + 1], r[j + 2]));
      M.compose(V.set(p[j], p[j + 1], p[j + 2]), Q, S.set(s[j], s[j + 1], s[j + 2]));
      this.mesh.setMatrixAt(i, M);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.mode.fill(0);
    this.active = 0;
    for (let i = 0; i < DEBRIS; i++) this.mesh.setMatrixAt(i, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

// A piece of building on its way down: `meshes` (in world coordinates) hung
// under a pivot, moved by `step(it, dt)` until it returns false.
export class Falls {
  constructor(group) {
    this.group = group;
    this.list = [];
  }

  // A whole building dropping into its rubble: it sinks, faster and faster,
  // leans a little and crumples; `crumble(it, y)` is called as its top comes
  // down, to throw debris and dust off it.
  collapse(meshes, b, tall, crumble) {
    const pivot = new THREE.Group();
    pivot.position.set(b.x, b.base, b.z);
    for (const m of meshes) { m.position.set(-b.x, -b.base, -b.z); pivot.add(m); }
    const a = Math.random() * Math.PI * 2;
    const it = { pivot, meshes, t: 0, T: Math.min(2.6, 1.2 + tall * 0.03), tall, b, crumble, axis: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), lean: 0.06 + Math.random() * 0.12, puff: 0 };
    it.step = (q, dt) => {
      q.t += dt;
      const k = Math.min(1, q.t / q.T);
      const drop = (q.tall + 4) * k * k;
      q.pivot.position.y = q.b.base - drop;
      q.pivot.scale.y = 1 - 0.3 * k;
      q.pivot.quaternion.setFromAxisAngle(q.axis, q.lean * Math.sqrt(k));
      if ((q.puff -= dt) <= 0) {
        q.puff = 0.07;
        q.crumble(q, q.b.base + (q.tall - drop) * (1 - 0.3 * k));
      }
      return k < 1;
    };
    this.add(it);
  }

  // A stack of chunks toppling outwards over its outer foot (pivot x/y/z),
  // towards dir [dx, dz]; `land(it)` is called as it hits.
  topple(meshes, px, py, pz, dir, land) {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, pz);
    for (const m of meshes) { m.position.set(-px, -py, -pz); pivot.add(m); }
    const l = Math.hypot(dir[0], dir[1]) || 1;
    const it = { pivot, meshes, t: 0, a: 0.04, w: 0.2, land, axis: new THREE.Vector3(dir[1] / l, 0, -dir[0] / l), drop: 0 };
    it.step = (q, dt) => {
      q.t += dt;
      q.w += (2.2 + 4 * Math.sin(q.a)) * dt;
      q.a += q.w * dt;
      // Once well over, it slides down off its foot as well.
      if (q.a > 0.5) { q.drop += (q.a - 0.5) * 12 * dt; q.pivot.position.y = py - q.drop; }
      q.pivot.quaternion.setFromAxisAngle(q.axis, Math.min(q.a, 1.45));
      if (q.a >= 1.45 || q.t > 2.5) { q.land(q); return false; }
      return true;
    };
    this.add(it);
  }

  add(it) {
    for (const m of it.meshes) { m.castShadow = true; m.receiveShadow = true; }
    this.group.add(it.pivot);
    this.list.push(it);
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const it = this.list[i];
      if (it.step(it, dt)) continue;
      this.drop(it);
      this.list.splice(i, 1);
    }
  }

  drop(it) {
    this.group.remove(it.pivot);
    for (const m of it.meshes) m.geometry.dispose();   // the materials are the town's
  }

  clear() {
    for (const it of this.list) this.drop(it);
    this.list = [];
  }
}
