import * as THREE from 'three';
import { BRIDGE } from '../core/scenery.js';

// Draws core/scenery.js: one InstancedMesh per kind of prop, a merged bridge
// and a water plane. Static props are rewritten only when the scenery's
// `version` changes; villagers and sheep move every frame.

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

// Merge coloured parts into one flat-shaded geometry. Each part is
// [geometry, colour, x, y, z, (sx, sy, sz), (rotY)].
function merge(parts) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  for (const [geo, colour, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rotY = 0] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    M.compose(P.set(x, y, z), Q.setFromAxisAngle(UP, rotY), S.set(sx, sy, sz));
    const a = g.attributes.position;
    c.set(colour);
    for (let i = 0; i < a.count; i++) {
      P.fromBufferAttribute(a, i).applyMatrix4(M);
      pos.push(P.x, P.y, P.z);
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}

// A gable roof: ridge along x, `w` long, `d` deep, `h` high, base at y = 0.
function gable(w, h, d) {
  const x = w / 2;
  const z = d / 2;
  const v = [
    [-x, 0, z], [x, 0, z], [x, h, 0], [-x, 0, z], [x, h, 0], [-x, h, 0],       // front slope
    [x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, 0, -z], [-x, h, 0], [x, h, 0],    // back slope
    [-x, 0, -z], [-x, 0, z], [-x, h, 0],                                       // gable ends
    [x, 0, z], [x, 0, -z], [x, h, 0],
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
  return g;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

let shared = null;
function assets() {
  if (shared) return shared;
  const cone = (r, h) => new THREE.ConeGeometry(r, h, 7);
  const blob = (r) => new THREE.IcosahedronGeometry(r, 0);
  const geo = {
    pine: merge([
      [new THREE.CylinderGeometry(0.25, 0.38, 2.6, 6), '#5b4230', 0, 1.3, 0],
      [cone(2.3, 4.0), '#2f5a36', 0, 3.8, 0],
      [cone(1.8, 3.4), '#35663c', 0, 5.7, 0],
      [cone(1.2, 2.8), '#3d7343', 0, 7.5, 0],
    ]),
    oak: merge([
      [new THREE.CylinderGeometry(0.3, 0.48, 3.2, 6), '#644a33', 0, 1.6, 0],
      [blob(2.5), '#4f8a3a', 0, 4.9, 0, 1, 0.85, 1],
      [blob(1.8), '#5f9a43', 1.5, 4.2, 0.6, 1, 0.85, 1, 0.7],
      [blob(1.6), '#447a35', -1.2, 4.4, -0.9, 1, 0.85, 1, 1.9],
    ]),
    bush: merge([
      [blob(1), '#5a8a3f', 0, 0.55, 0, 1.25, 0.8, 1.2],
      [blob(0.7), '#6b9a48', 0.9, 0.4, 0.3, 1, 0.8, 1, 1.1],
    ]),
    rock: merge([
      [new THREE.DodecahedronGeometry(1, 0), '#8b8479', 0, 0.3, 0, 1.3, 0.75, 1],
      [new THREE.DodecahedronGeometry(0.5, 0), '#7a746a', 1.1, 0.1, 0.5, 1, 0.8, 1, 0.8],
    ]),
    house: merge([
      [box(7.8, 3.0, 6.2), '#77706a', 0, -1.3, 0],            // foundation, mostly below ground
      [box(7.2, 3.2, 5.6), '#ece4d2', 0, 1.6, 0],             // walls
      [gable(8.0, 2.4, 6.6), '#a5523c', 0, 3.2, 0],           // roof
      [box(1.1, 2.0, 0.2), '#4a3526', 0.9, 1.0, 2.8],         // door
      [box(1.0, 0.9, 0.2), '#2f3b47', -1.8, 1.9, 2.8],        // windows
      [box(1.0, 0.9, 0.2), '#2f3b47', 1.6, 1.9, -2.8],
      [box(1.0, 0.9, 0.2), '#2f3b47', -1.6, 1.9, -2.8],
      [box(0.8, 1.8, 0.8), '#6f5f55', -2.2, 4.6, -1.2],       // chimney
    ]),
    ruin: merge([
      [box(7.8, 3.0, 6.2), '#5d5751', 0, -2.6, 0],
      [box(7.2, 1.1, 0.5), '#8b8376', 0, 0.5, -2.55],
      [box(0.5, 1.9, 3.0), '#7d766b', -3.35, 0.9, -1.0],
      [box(2.4, 0.7, 0.5), '#8b8376', 2.2, 0.3, 2.55],
      [new THREE.DodecahedronGeometry(1.6, 0), '#4a403a', 0.6, 0.1, 0.2, 1.6, 0.4, 1.2],
      [box(3.2, 0.25, 0.4), '#3a2a20', -0.8, 0.75, 0.6, 1, 1, 1, 0.5],
    ]),
    villager: merge([
      [new THREE.CylinderGeometry(0.22, 0.42, 1.25, 6), '#ffffff', 0, 0.7, 0],
      [new THREE.SphereGeometry(0.27, 6, 5), '#e8c39e', 0, 1.55, 0],
      [box(0.5, 0.12, 0.5), '#5a4632', 0, 1.82, 0],          // hat
    ]),
    sheep: merge([
      [box(1.3, 0.75, 0.8), '#f2efe6', 0, 0.85, 0],
      [box(0.42, 0.42, 0.42), '#2e2a27', 0.8, 1.05, 0],
      [box(0.16, 0.5, 0.16), '#2e2a27', 0.45, 0.25, 0.25],
      [box(0.16, 0.5, 0.16), '#2e2a27', 0.45, 0.25, -0.25],
      [box(0.16, 0.5, 0.16), '#2e2a27', -0.45, 0.25, 0.25],
      [box(0.16, 0.5, 0.16), '#2e2a27', -0.45, 0.25, -0.25],
    ]),
  };
  const tints = {
    pine: ['#ffffff', '#e4f0df', '#f4f0d8', '#d6e6d6'],
    oak: ['#ffffff', '#f4efc8', '#dcecd0', '#ffe9c2'],
    bush: ['#ffffff', '#f0f0c8', '#d8ead0', '#ffe4c4'],
    rock: ['#ffffff', '#e8e2d6', '#d8d8dc', '#f2ead8'],
    house: ['#ffffff', '#f4e3c4', '#e2d6c8', '#dfe6ea'],
    ruin: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    villager: ['#c9584a', '#4f78c2', '#d9b84e', '#6fa06a'],
    sheep: ['#ffffff', '#f2ecdf', '#e6e0d4', '#fff8ea'],
  };
  for (const k of Object.keys(tints)) tints[k] = tints[k].map((c) => new THREE.Color(c));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });

  // Water: a glossy translucent sheet with a slow ripple in its normals.
  const water = new THREE.MeshStandardMaterial({ color: '#2d6f86', transparent: true, opacity: 0.8, roughness: 0.12, metalness: 0.15 });
  const time = { value: 0 };
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterP;\nuniform float uTime;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 w = vWaterP.xz;
  vec3 rip = vec3(
    sin(w.x * 0.9 + uTime * 1.3) + sin(w.y * 1.3 - uTime * 1.1 + w.x * 0.4),
    0.0,
    cos(w.y * 0.8 + uTime * 0.9) + sin(w.x * 1.7 + uTime * 1.6)) * 0.035;
  normal = normalize(normal + (viewMatrix * vec4(rip, 0.0)).xyz);
}`);
  };
  shared = { geo, tints, material, water, time };
  return shared;
}

const STATIC = ['pine', 'oak', 'bush', 'rock', 'house', 'ruin'];
const WALKERS = ['villager', 'sheep'];
const SHADOW = { pine: true, oak: true, rock: true, house: true, ruin: true, villager: true, sheep: true };

export class SceneryMesh {
  constructor(scenery) {
    this.scenery = scenery;
    this.group = new THREE.Group();
    this.meshes = {};
    this.seen = -1;
    this.built = null;
  }

  // Size the instance buffers for the scenery as generated. Called on a full
  // terrain rebuild (each round).
  rebuild() {
    const a = assets();
    const sc = this.scenery;
    this.clear();
    const count = {};
    for (const p of sc.props) count[p.kind] = (count[p.kind] || 0) + 1;
    count.ruin = count.house || 0;
    for (const w of sc.walkers) count[w.kind] = (count[w.kind] || 0) + 1;
    for (const kind of [...STATIC, ...WALKERS]) {
      if (!count[kind]) continue;
      const mesh = new THREE.InstancedMesh(a.geo[kind], a.material, count[kind]);
      mesh.castShadow = !!SHADOW[kind];
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // instances are spread over the whole field
      this.meshes[kind] = mesh;
      this.group.add(mesh);
    }
    const t = sc.terrain;
    if (t.waterLevel > -Infinity) {
      const geo = new THREE.PlaneGeometry(t.size, t.size);
      geo.rotateX(-Math.PI / 2);
      this.water = new THREE.Mesh(geo, a.water);
      this.water.position.y = t.waterLevel;
      this.water.receiveShadow = true;
      this.water.renderOrder = 1;
      this.group.add(this.water);
    }
    if (sc.bridge) this.buildBridge(sc.bridge);
    this.seen = -1;
    this.sync(0);
  }

  buildBridge(b) {
    const t = this.scenery.terrain;
    const dx = b.b[0] - b.a[0];
    const dz = b.b[1] - b.a[1];
    const span = Math.hypot(dx, dz);
    const len = span + 2;
    const wood = '#8a6a48';
    const dark = '#5e4630';
    const parts = [
      [box(len, 0.35, BRIDGE.width), wood, 0, -0.18, 0],
      [box(len, 0.14, 0.14), dark, 0, 1.0, BRIDGE.width / 2 - 0.1],
      [box(len, 0.14, 0.14), dark, 0, 1.0, -BRIDGE.width / 2 + 0.1],
    ];
    for (let x = -len / 2 + 0.3; x <= len / 2; x += 2.6) {
      parts.push([box(0.16, 1.0, 0.16), dark, x, 0.5, BRIDGE.width / 2 - 0.1]);
      parts.push([box(0.16, 1.0, 0.16), dark, x, 0.5, -BRIDGE.width / 2 + 0.1]);
    }
    // Piers stand on the bed under the deck.
    const n = Math.max(1, Math.round(span / BRIDGE.pierEvery));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const drop = b.y - t.heightAt(b.a[0] + dx * u, b.a[1] + dz * u) + 1.5;
      const x = (u - 0.5) * span;
      for (const z of [-1, 1]) parts.push([box(0.5, drop, 0.5), dark, x, -drop / 2, z * (BRIDGE.width / 2 - 0.35)]);
      parts.push([box(0.3, 0.3, BRIDGE.width), dark, x, -0.5, 0]);
    }
    this.bridge = new THREE.Mesh(merge(parts), assets().material);
    this.bridge.position.set((b.a[0] + b.b[0]) / 2, b.y, (b.a[1] + b.b[1]) / 2);
    this.bridge.rotation.y = -Math.atan2(dz, dx);
    this.bridge.castShadow = true;
    this.bridge.receiveShadow = true;
    this.group.add(this.bridge);
  }

  writeStatic() {
    const a = assets();
    const sc = this.scenery;
    const next = {};
    const put = (kind, matrix, tint) => {
      const mesh = this.meshes[kind];
      const i = next[kind] = (next[kind] ?? -1) + 1;
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, a.tints[kind][tint]);
    };
    for (const p of sc.props) {
      const gone = p.state === 'gone';
      Q.setFromAxisAngle(UP, p.rot);
      let lift = 0;
      if (p.state === 'fallen') {
        // Tip the trunk over, away from whatever knocked it down.
        AXIS.set(Math.sin(p.fall), 0, -Math.cos(p.fall));
        Q.premultiply(Q2.setFromAxisAngle(AXIS, 1.44));
        lift = 0.35 * p.scale;
      }
      M.compose(P.set(p.x, p.y + lift, p.z), Q, S.setScalar(p.scale));
      if (p.kind === 'house') {
        put('house', p.state === 'ok' ? M : HIDDEN, p.tint);
        put('ruin', p.state === 'ruin' ? M : HIDDEN, 0);
      } else put(p.kind, gone ? HIDDEN : M, p.tint);
    }
    for (const kind of STATIC) {
      const mesh = this.meshes[kind];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.bridge) this.bridge.visible = !!(sc.bridge && sc.bridge.alive);
  }

  // `time` in seconds drives the water ripple and the walkers' bob.
  sync(time) {
    const a = assets();
    const sc = this.scenery;
    a.time.value = time;
    if (this.seen !== sc.version) {
      this.seen = sc.version;
      this.writeStatic();
    }
    const next = {};
    for (const w of sc.walkers) {
      const mesh = this.meshes[w.kind];
      if (!mesh) continue;
      const i = next[w.kind] = (next[w.kind] ?? -1) + 1;
      if (!w.alive) { mesh.setMatrixAt(i, HIDDEN); continue; }
      const moving = w.mode !== 'idle';
      const hop = moving ? Math.abs(Math.sin(time * (w.mode === 'flee' ? 14 : 7) + i)) * (w.kind === 'sheep' ? 0.12 : 0.08) : 0;
      Q.setFromAxisAngle(UP, -w.heading);
      M.compose(P.set(w.x, w.y + hop, w.z), Q, S.setScalar(w.kind === 'villager' ? 1.35 : 1.2));
      mesh.setMatrixAt(i, M);
      if (!mesh.userData.tinted) mesh.setColorAt(i, a.tints[w.kind][w.tint]);
    }
    for (const kind of WALKERS) {
      const mesh = this.meshes[kind];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (!mesh.userData.tinted && mesh.instanceColor) { mesh.instanceColor.needsUpdate = true; mesh.userData.tinted = true; }
    }
  }

  clear() {
    for (const mesh of Object.values(this.meshes)) { this.group.remove(mesh); mesh.dispose(); }
    this.meshes = {};
    if (this.water) { this.group.remove(this.water); this.water.geometry.dispose(); this.water = null; }
    if (this.bridge) { this.group.remove(this.bridge); this.bridge.geometry.dispose(); this.bridge = null; }
  }

  dispose() { this.clear(); }
}
