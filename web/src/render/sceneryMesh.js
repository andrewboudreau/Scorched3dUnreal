import * as THREE from 'three';
import { BRIDGE } from '../core/scenery.js';

// Draws core/scenery.js: one InstancedMesh per kind of prop, a merged bridge
// and a water plane. Static props are rewritten only when the scenery's
// `version` changes; villagers and sheep move every frame. A villager is a
// head-and-hat instance plus five `limb` boxes (tunic, legs, arms), so the
// limbs can swing as it walks and only the clothes take the villager's colour.

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const BODY = new THREE.Matrix4();
const LIMB = new THREE.Matrix4();
const LEG_COLOUR = new THREE.Color('#3b3f52');
const VILLAGER_SCALE = 1.35;
const WHITE = new THREE.Color('#ffffff');
// Where each limb hangs from, in the villager's own space (x is forward):
// [x, y, z, which way it swings, kind]. Kind 0 is a leg, 1 an arm, 2 the tunic.
const LIMBS = [
  [0, 0.66, 0.13, 1, 0], [0, 0.66, -0.13, -1, 0],
  [0, 1.26, 0.33, -1, 1], [0, 1.26, -0.33, 1, 1],
  [0, 1.36, 0, 0, 2],
];
const TUNIC = new THREE.Vector3(2.4, 1.2, 3.2);
const ONE = new THREE.Vector3(1, 1, 1);

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
      [new THREE.SphereGeometry(0.25, 6, 5), '#e8c39e', 0, 1.55, 0],
      [box(0.56, 0.06, 0.56), '#5a4632', 0, 1.76, 0],                           // hat brim
      [box(0.3, 0.16, 0.3), '#5a4632', 0, 1.86, 0],
    ]),
    // An arm, a leg or (scaled up) the tunic, hanging down from its joint at the origin.
    limb: merge([[box(0.15, 0.64, 0.15), '#ffffff', 0, -0.32, 0]]),
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
    limb: ['#c9584a', '#4f78c2', '#d9b84e', '#6fa06a'],
    sheep: ['#ffffff', '#f2ecdf', '#e6e0d4', '#fff8ea'],
  };
  for (const k of Object.keys(tints)) tints[k] = tints[k].map((c) => new THREE.Color(c));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });

  // Water: a glossy translucent sheet with a slow ripple in its normals. The ripple
  // is several waves in unrelated directions and lengths, bent by a little noise, so
  // the sun's glints never line up into a grid. It fades out with distance, where a
  // fine ripple would only alias.
  const water = new THREE.MeshStandardMaterial({ color: '#2d6f86', transparent: true, opacity: 0.82, roughness: 0.22, metalness: 0.1 });
  const time = { value: 0 };
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWaterP;
uniform float uTime;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Slope of one travelling wave along unit direction d.
vec2 wWave(vec2 p, vec2 d, float k, float speed, float amp) { return d * amp * cos(dot(d, p) * k + uTime * speed); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 w = vWaterP.xz;
  vec2 q = w + 5.0 * vec2(wNoise(w * 0.045 + uTime * 0.04), wNoise(w * 0.045 + vec2(7.3, 1.9) - uTime * 0.03));
  vec2 g = wWave(q, vec2(0.80, 0.60), 0.37, 0.9, 1.0)
         + wWave(q, vec2(-0.36, 0.93), 0.61, 1.2, 0.8)
         + wWave(q, vec2(0.97, -0.24), 0.89, 1.5, 0.6)
         + wWave(q, vec2(-0.69, -0.72), 1.31, 1.9, 0.45)
         + wWave(q, vec2(0.17, -0.99), 1.93, 2.3, 0.3);
  g *= 0.6 + 0.8 * wNoise(w * 0.02 - uTime * 0.02);    // calmer and choppier patches
  float fade = clamp(1.0 - length(vViewPosition) / 450.0, 0.1, 1.0);
  vec3 rip = vec3(g.x, 0.0, g.y) * 0.03 * fade;
  normal = normalize(normal + (viewMatrix * vec4(rip, 0.0)).xyz);
}`);
  };
  shared = { geo, tints, material, water, time };
  return shared;
}

const STATIC = ['pine', 'oak', 'bush', 'rock', 'house', 'ruin'];
const WALKERS = ['villager', 'limb', 'sheep'];
const SHADOW = { pine: true, oak: true, bush: true, rock: true, house: true, ruin: true, villager: true, limb: true, sheep: true };

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
    count.limb = (count.villager || 0) * LIMBS.length;
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

  // `time` in seconds drives the water ripple, the villagers' stride and the
  // sheep's hop.
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
      const limbs = w.kind === 'villager' ? this.meshes.limb : null;
      if (!w.alive) {
        mesh.setMatrixAt(i, HIDDEN);
        if (limbs) for (let k = 0; k < LIMBS.length; k++) limbs.setMatrixAt(i * LIMBS.length + k, HIDDEN);
        continue;
      }
      const flee = w.mode === 'flee';
      const moving = w.mode !== 'idle';
      Q.setFromAxisAngle(UP, -w.heading);
      if (w.kind === 'sheep') {
        // Trot in little hops, rocking nose to tail; graze with the head down when still.
        const phase = time * (flee ? 15 : 6) + i * 1.9;
        const hop = moving ? Math.abs(Math.sin(phase)) * (flee ? 0.34 : 0.14) : 0;
        const pitch = moving ? Math.cos(phase * 2) * (flee ? 0.16 : 0.07) : -0.2 * Math.max(0, Math.sin(time * 0.35 + i * 2.3));
        Q.multiply(Q2.setFromAxisAngle(AXIS.set(0, 0, 1), pitch));
        M.compose(P.set(w.x, w.y + hop, w.z), Q, S.setScalar(1.2));
        mesh.setMatrixAt(i, M);
      } else {
        // Stride: legs scissor, arms swing against them; arms go up when running away.
        const phase = time * (flee ? 15 : 7.5) + i * 2.1;
        const bob = moving ? Math.abs(Math.cos(phase)) * (flee ? 0.09 : 0.05) : 0;
        BODY.compose(P.set(w.x, w.y + bob, w.z), Q, S.setScalar(VILLAGER_SCALE));
        mesh.setMatrixAt(i, BODY);
        const stride = moving ? Math.sin(phase) * (flee ? 0.95 : 0.6) : 0;
        LIMBS.forEach(([lx, ly, lz, dir, kind], k) => {
          const arm = kind === 1;
          let angle = stride * dir * (arm ? 0.8 : 1);
          if (arm && flee) angle = 2.7 + Math.sin(phase * 1.3 + k) * 0.35;
          else if (arm && !moving) angle = Math.sin(time * 1.1 + i + k) * 0.05;
          LIMB.compose(P.set(lx, ly, lz), Q2.setFromAxisAngle(AXIS.set(0, 0, 1), angle), kind === 2 ? TUNIC : ONE);
          LIMB.premultiply(BODY);
          limbs.setMatrixAt(i * LIMBS.length + k, LIMB);
          if (!limbs.userData.tinted) limbs.setColorAt(i * LIMBS.length + k, kind ? a.tints.limb[w.tint] : LEG_COLOUR);
        });
      }
      if (!mesh.userData.tinted) mesh.setColorAt(i, w.kind === 'villager' ? WHITE : a.tints[w.kind][w.tint]);
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
