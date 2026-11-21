import * as THREE from 'three';

// A few small flocks that circle over the field and scatter from blasts and
// from shells passing close. Purely for show: nothing here touches the game.
// Bodies are one InstancedMesh and wings another (two per bird).

const FLOCKS = 4;
const PER_FLOCK = 6;
const M = new THREE.Matrix4();
const W = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(1, 0, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function wingGeometry() {
  // A flat triangle-ish wing reaching out along +z from the shoulder.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0.35, 0, 0, -0.3, 0, 0, 0.05, 0, 1.25,
    -0.3, 0, 0, -0.45, 0, 0.8, 0.05, 0, 1.25,
  ], 3));
  g.computeVertexNormals();
  return g;
}

export class Birds {
  constructor(scene) {
    const count = FLOCKS * PER_FLOCK;
    const body = new THREE.ConeGeometry(0.22, 1.1, 5);
    body.rotateZ(-Math.PI / 2);   // nose along +x
    const dark = new THREE.MeshStandardMaterial({ color: '#f1f1ec', roughness: 0.9, flatShading: true });
    const wing = new THREE.MeshStandardMaterial({ color: '#d9dcdf', roughness: 0.9, flatShading: true, side: THREE.DoubleSide });
    this.bodies = new THREE.InstancedMesh(body, dark, count);
    this.wings = new THREE.InstancedMesh(wingGeometry(), wing, count * 2);
    for (const m of [this.bodies, this.wings]) {
      m.frustumCulled = false;
      m.castShadow = false;   // a 4096 shadow pass every frame for specks nobody sees
      scene.add(m);
    }
    this.flocks = [];
    this.time = 0;
  }

  // New homes for the flocks over this terrain.
  reset(terrain, seed = 1) {
    let s = (seed * 9301 + 49297) % 233280;
    const rand = (a, b) => { s = (s * 9301 + 49297) % 233280; return a + (s / 233280) * (b - a); };
    const reach = terrain.half * 0.75;
    this.flocks = [];
    for (let f = 0; f < FLOCKS; f++) {
      const x = rand(-reach, reach);
      const z = rand(-reach, reach);
      const flock = {
        x, z,
        y: Math.max(terrain.heightAt(x, z), terrain.waterLevel > -Infinity ? terrain.waterLevel : -Infinity) + rand(30, 55),
        radius: rand(35, 80), angle: rand(0, 6.28), dir: rand(0, 1) < 0.5 ? 1 : -1, speed: rand(11, 15),
        alarm: 0, birds: [],
      };
      for (let b = 0; b < PER_FLOCK; b++) {
        flock.birds.push({
          lag: b * 0.16 + rand(-0.05, 0.05), out: rand(-9, 9), up: rand(-5, 5), phase: rand(0, 6.28), rate: rand(8, 11),
          off: new THREE.Vector3(), vel: new THREE.Vector3(), pos: new THREE.Vector3(), last: null, heading: 0,
        });
      }
      this.flocks.push(flock);
    }
  }

  // Something loud at `pos`: flocks within `reach` burst away from it.
  scare(pos, reach = 140) {
    for (const f of this.flocks) {
      for (const b of f.birds) {
        const dx = b.pos.x - pos[0];
        const dy = b.pos.y - pos[1];
        const dz = b.pos.z - pos[2];
        const d = Math.hypot(dx, dy, dz) || 1;
        if (d > reach) continue;
        const kick = 26 * (1 - d / reach) + 8;
        b.vel.x += (dx / d) * kick + (Math.random() - 0.5) * 10;
        b.vel.y += Math.abs(dy / d) * kick * 0.5 + 6 + Math.random() * 5;
        b.vel.z += (dz / d) * kick + (Math.random() - 0.5) * 10;
        f.alarm = 1;
      }
    }
  }

  // Distance from `pos` to the nearest bird (for how loud the birdsong is).
  nearest(pos) {
    let best = Infinity;
    for (const f of this.flocks) for (const b of f.birds) best = Math.min(best, b.pos.distanceTo(pos));
    return best;
  }

  update(dt) {
    this.time += dt;
    let i = 0;
    for (const f of this.flocks) {
      f.alarm = Math.max(0, f.alarm - dt / 6);
      f.angle += (f.dir * f.speed * (1 + f.alarm * 0.6) * dt) / f.radius;
      for (const b of f.birds) {
        // Scatter offset: a loose spring that lets a startled bird fly wide and drift back.
        b.vel.addScaledVector(b.off, -0.35 * dt).multiplyScalar(Math.exp(-0.7 * dt));
        b.off.addScaledVector(b.vel, dt);
        const a = f.angle - f.dir * b.lag;
        const r = f.radius + b.out + Math.sin(this.time * 0.4 + b.phase) * 4;
        b.pos.set(f.x + Math.cos(a) * r + b.off.x, f.y + b.up + Math.sin(this.time * 0.6 + b.phase) * 2.5 + b.off.y, f.z + Math.sin(a) * r + b.off.z);
        if (b.last) {
          const vx = b.pos.x - b.last.x;
          const vz = b.pos.z - b.last.z;
          if (vx * vx + vz * vz > 1e-8) {
            const want = Math.atan2(vz, vx);
            b.heading += Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading)) * Math.min(1, dt * 6);
          }
          b.last.copy(b.pos);
        } else {
          b.last = b.pos.clone();
          b.heading = a + (f.dir * Math.PI) / 2;
        }
        // Flap, with short glides when nothing is wrong; flap hard when startled.
        const glide = f.alarm > 0.05 ? 0 : Math.max(0, Math.sin(this.time * 0.5 + b.phase * 3));
        const beat = Math.sin(this.time * b.rate * (1 + f.alarm * 0.8) + b.phase);
        const flap = glide > 0.6 ? 0.15 : beat * 0.85;
        Q.setFromAxisAngle(UP, -b.heading);
        Q.multiply(Q2.setFromAxisAngle(FWD, f.dir * 0.3 * (1 - f.alarm)));   // bank into the turn
        M.compose(b.pos, Q, S.setScalar(0.9));
        this.bodies.setMatrixAt(i, M);
        for (const side of [1, -1]) {
          W.compose(P.set(0, 0.05, side * 0.1), Q2.setFromAxisAngle(FWD, -side * flap), S.set(1, 1, side));
          W.premultiply(M);
          this.wings.setMatrixAt(i * 2 + (side > 0 ? 0 : 1), W);
        }
        i++;
      }
    }
    for (; i < this.bodies.count; i++) {
      this.bodies.setMatrixAt(i, HIDDEN);
      this.wings.setMatrixAt(i * 2, HIDDEN);
      this.wings.setMatrixAt(i * 2 + 1, HIDDEN);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;
  }
}
