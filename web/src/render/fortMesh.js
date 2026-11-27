import * as THREE from 'three';
import { fortSpots } from '../core/boss.js';

// Props on the boss's fort (core/boss.js buildFort), drawn only: crenels round
// the deck's rim, and bollards and amber lamp posts round the outer lip of each
// ledge, so the levels read at a glance from the far end of the field. They
// take no part in the game (shells and tanks ignore them). Four instanced
// meshes. A prop whose ground a blast has since taken away is hidden.
//
// One per match (main.js): `new FortView(game)`, add `.group` to the scene,
// `update(time)` each frame, `dispose()` with the match.

const STONE = '#6d675d';
const POST = '#25282c';

export class FortView {
  constructor(game) {
    this.terrain = game.terrain;
    this.group = new THREE.Group();
    this.items = [];          // { mesh, index, x, y, z, matrix }
    this.checkAt = 0;
    const spots = game.fort ? fortSpots(...game.fort) : [];
    if (!spots.length) return;
    const [deck, ...ledges] = spots;
    const crenels = [], bollards = [], posts = [];

    // Crenels: low blocks with gaps, along the deck's rim, but not where a ledge meets it.
    const n = Math.floor((2 * Math.PI * (deck[2] - 0.9)) / 4.4);
    for (let k = 0; k < n; k++) {
      const a = ((k + 0.5) / n) * Math.PI * 2;
      const x = deck[0] + Math.cos(a) * (deck[2] - 0.9);
      const z = deck[1] + Math.sin(a) * (deck[2] - 0.9);
      if (ledges.some(([lx, lz, lr]) => Math.hypot(x - lx, z - lz) < lr + 2.5)) continue;
      crenels.push({ x, z, ry: -(a + Math.PI / 2) });
    }
    // Bollards every 40 degrees round each ledge's outer half, every third a lamp post.
    ledges.forEach(([lx, lz, lr]) => {
      const out = Math.atan2(lz - deck[1], lx - deck[0]);
      for (let k = -3; k <= 3; k++) {
        const a = out + k * (40 * Math.PI / 180);
        const x = lx + Math.cos(a) * (lr - 0.9);
        const z = lz + Math.sin(a) * (lr - 0.9);
        if (Math.hypot(x - deck[0], z - deck[1]) < deck[2] + 2) continue;
        (k % 3 === 0 ? posts : bollards).push({ x, z });
      }
    });

    const stone = new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.9, flatShading: true });
    const post = new THREE.MeshStandardMaterial({ color: POST, roughness: 0.7, metalness: 0.4, flatShading: true });
    const lamp = new THREE.MeshStandardMaterial({ color: '#ffd98a', emissive: '#ffb347', emissiveIntensity: 1.6, roughness: 0.4 });
    this.materials = [stone, post, lamp];
    this.geometries = [];
    const instanced = (geo, mat, list, lift, shadow = true) => {
      this.geometries.push(geo);
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      list.forEach((o, i) => {
        const y = this.terrain.heightAt(o.x, o.z);
        this.items.push({ mesh, index: i, x: o.x, y: y + lift, z: o.z, ry: o.ry || 0, ground: y });
      });
      this.group.add(mesh);
      return mesh;
    };
    instanced(new THREE.BoxGeometry(2.2, 1.3, 0.9), stone, crenels, 0.55);
    instanced(new THREE.CylinderGeometry(0.34, 0.4, 0.9, 6), stone, bollards, 0.4);
    instanced(new THREE.CylinderGeometry(0.1, 0.14, 2.6, 5), post, posts, 1.2);
    instanced(new THREE.SphereGeometry(0.32, 8, 6), lamp, posts, 2.75, false);
    this.apply(true);
  }

  // Place every prop, hiding any whose ground has dropped or risen over a metre.
  apply(all = false) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const dirty = new Set();
    for (const it of this.items) {
      const moved = Math.abs(this.terrain.heightAt(it.x, it.z) - it.ground) > 1;
      if (!all && moved === !!it.hidden) continue;
      it.hidden = moved;
      m.compose(new THREE.Vector3(it.x, it.y, it.z), q.setFromEuler(e.set(0, it.ry, 0)), moved ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(1, 1, 1));
      it.mesh.setMatrixAt(it.index, m);
      dirty.add(it.mesh);
    }
    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  // Once a frame; looks for blasted ground a few times a second.
  update(time) {
    if (time < this.checkAt) return;
    this.checkAt = time + 0.4;
    this.apply();
  }

  dispose() {
    this.geometries?.forEach((g) => g.dispose());
    this.materials?.forEach((m) => m.dispose());
    this.group.children.forEach((c) => c.dispose?.());
  }
}

