import * as THREE from 'three';
import { ARTIFACT_KINDS } from '../core/artifacts.js';
import { addFogShade } from './terrainMesh.js';

// Draws the floating isles' relics (core/artifacts.js): one InstancedMesh per
// kind, low-poly and flat-shaded, with small glowing accents (glyph strips, a
// dish's feed, crystal cores, a wreck's engine) that pulse slowly, each relic
// out of step with the next. Plus the rocks drifting round the bigger isles,
// moved every frame. SceneryMesh owns one and rebuilds it with the scenery.
//
// Every model is merged from parts: [geometry, colour, glow, x, y, z, sx, sy,
// sz, rotY, rotX, rotZ]. `glow` (0..1) is how much the part shines in its own
// colour; it rides along as a vertex attribute.

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3();
const EULER = new THREE.Euler();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function merge(parts) {
  const pos = [];
  const col = [];
  const glow = [];
  const c = new THREE.Color();
  for (const [geo, colour, shine = 0, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rotY = 0, rotX = 0, rotZ = 0] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    M.compose(P.set(x, y, z), Q.setFromEuler(EULER.set(rotX, rotY, rotZ, 'YXZ')), S.set(sx, sy, sz));
    const a = g.attributes.position;
    c.set(colour);
    for (let i = 0; i < a.count; i++) {
      P.fromBufferAttribute(a, i).applyMatrix4(M);
      pos.push(P.x, P.y, P.z);
      col.push(c.r, c.g, c.b);
      glow.push(shine);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 1));
  out.computeVertexNormals();
  return out;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, n = 8, open = false) => new THREE.CylinderGeometry(rt, rb, h, n, 1, open);
const CYAN = '#6ff4ff';
const VIOLET = '#cf94ff';
const AMBER = '#ffb45a';

// Glyph strip: a column of short bars of uneven length, on a face at z = `z`.
function glyphs(x, y0, y1, z, colour, w = 0.42, seed = 1) {
  const out = [];
  let k = seed;
  for (let y = y0; y < y1; y += 0.42) {
    k = (k * 9301 + 49297) % 233280;
    const len = w * (0.4 + (k / 233280) * 0.6);
    out.push([box(len, 0.2, 0.08), colour, 1, x + (k % 3 - 1) * 0.06, y, z]);
  }
  return out;
}

let shared = null;
function assets() {
  if (shared) return shared;
  const metal = '#c3c7d0';
  const dark = '#2a2d3a';
  const stone = '#9e94a6';
  const geo = {
    // A derelict dish: plinth, mast, a tilted bowl with a strut out to its
    // feed, which still glows; one panel of the bowl hangs loose.
    dish: merge([
      [box(2.6, 0.8, 2.6), '#555a68', 0, 0, 0.4, 0],
      [cyl(0.32, 0.42, 3.4, 6), '#6b7080', 0, 0, 2.4, 0],
      [cyl(3.3, 0.5, 1.1, 12, true), metal, 0, 0, 4.4, 0.5, 1, 1, 1, 0, -0.85],
      [cyl(0.5, 0.5, 0.3, 8), '#8c909c', 0, 0, 4.1, 0.2, 1, 1, 1, 0, -0.85],
      [cyl(0.07, 0.07, 3.0, 4), '#8c909c', 0, 0, 5.3, 1.6, 1, 1, 1, 0, -0.85],
      [new THREE.OctahedronGeometry(0.32, 0), CYAN, 1, 0, 6.3, 2.6],
      [box(1.4, 0.08, 1.0), '#a7abb6', 0, 2.1, 1.0, -0.6, 1, 1, 1, 0.4, 0.2, 1.1],
    ]),
    // A dark monolith with glyph strips down both faces.
    monolith: merge([
      [box(2.0, 9, 0.7), '#22242f', 0, 0, 4.3, 0],
      [box(2.4, 0.5, 1.1), '#3a3c48', 0, 0, 0.1, 0],
      ...glyphs(-0.45, 1.4, 8.2, 0.37, CYAN, 0.42, 3),
      ...glyphs(0.35, 2.6, 7.4, 0.37, CYAN, 0.32, 7),
      ...glyphs(0, 1.8, 7.8, -0.37, CYAN, 0.6, 11),
    ]),
    // A tapering obelisk on a plinth, a violet band near its tip.
    obelisk: merge([
      [box(2.6, 0.7, 2.6), '#5e5868', 0, 0, 0.3, 0],
      [cyl(0.5, 0.95, 8, 4), stone, 0, 0, 4.6, 0, 1, 1, 1, Math.PI / 4],
      [new THREE.ConeGeometry(0.62, 1.3, 4), '#bdb3c6', 0, 0, 9.2, 0, 1, 1, 1, Math.PI / 4],
      [cyl(0.6, 0.62, 0.28, 4), VIOLET, 1, 0, 7.6, 0, 1, 1, 1, Math.PI / 4],
      ...glyphs(0, 1.4, 6.6, 0.7, VIOLET, 0.3, 5).map((p) => { p[5] = 0.78 - (p[4] - 0.6) * 0.03; return p; }),
    ]),
    // A cluster of glowing crystals out of a dark rock.
    crystals: merge([
      [new THREE.DodecahedronGeometry(1.5, 0), '#4b4658', 0, 0, 0.5, 0, 1.2, 0.6, 1.1],
      [new THREE.OctahedronGeometry(1, 0), CYAN, 0.55, 0, 2.4, 0, 0.55, 2.6, 0.55, 0.3, 0.1, 0.05],
      [new THREE.OctahedronGeometry(1, 0), '#9ee8ff', 0.45, 0.9, 1.6, 0.4, 0.42, 1.8, 0.42, 1.1, 0.3, -0.45],
      [new THREE.OctahedronGeometry(1, 0), VIOLET, 0.5, -0.8, 1.5, 0.5, 0.4, 1.6, 0.4, 0.4, -0.2, 0.5],
      [new THREE.OctahedronGeometry(1, 0), CYAN, 0.45, -0.3, 1.2, -1.0, 0.35, 1.3, 0.35, 2.0, -0.55, 0.2],
      [new THREE.OctahedronGeometry(1, 0), '#b6f6ff', 0.4, 1.2, 0.9, -0.7, 0.3, 1.0, 0.3, 0.7, 0.5, -0.7],
    ]),
    // A broken arch: two worn pillars, half a lintel with an amber strip, the
    // other half fallen at its foot.
    arch: merge([
      [box(1.3, 6.2, 1.3), stone, 0, -3, 3.1, 0],
      [box(1.3, 4.4, 1.3), '#8f8698', 0, 3, 2.2, 0],
      [box(1.7, 0.5, 1.7), '#6e6678', 0, -3, 0.25, 0],
      [box(1.7, 0.5, 1.7), '#6e6678', 0, 3, 0.25, 0],
      [box(4.2, 1.1, 1.4), '#a99fb0', 0, -1.4, 6.6, 0, 1, 1, 1, 0, 0, -0.06],
      [box(2.6, 0.16, 0.06), AMBER, 1, -1.4, 6.6, 0.72],
      [box(2.6, 0.16, 0.06), AMBER, 1, -1.4, 6.6, -0.72],
      [box(3.0, 1.0, 1.3), '#8f8698', 0, 2.2, 0.45, 1.6, 1, 1, 1, 0.5, 0, 0.12],
    ]),
    // A ring ruin: most of a great stone ring standing on edge, a glowing
    // thread round its inner face, set in two footing blocks.
    ring: merge([
      [new THREE.TorusGeometry(3.4, 0.55, 6, 18, Math.PI * 1.62), '#8d889c', 0, 0, 3.6, 0, 1, 1, 1, 0, 0, -Math.PI * 0.42],
      [new THREE.TorusGeometry(2.86, 0.1, 4, 18, Math.PI * 1.62), CYAN, 1, 0, 3.6, 0, 1, 1, 1, 0, 0, -Math.PI * 0.42],
      [box(2.2, 1.0, 1.6), '#5e5868', 0, -1.6, 0.4, 0],
      [box(2.2, 1.0, 1.6), '#5e5868', 0, 1.6, 0.4, 0],
      [box(1.2, 0.8, 1.0), '#7d778a', 0, 3.4, 0.4, 1.4, 1, 1, 1, 0.6],
    ]),
    // A small crashed craft: a flattened hull along x, nose dug in, a bent fin,
    // a lit cockpit strip and an engine that still glows.
    hull: merge([
      [cyl(1.5, 1.7, 7.5, 8), '#b8bdc8', 0, 0, 1.0, 0, 1, 0.7, 1, 0, 0, Math.PI / 2],
      [new THREE.ConeGeometry(1.5, 2.6, 8), '#9fa5b2', 0, 4.9, 1.0, 0, 1, 0.7, 1, 0, 0, -Math.PI / 2],
      [cyl(1.1, 1.3, 0.8, 8), dark, 0, -4.1, 1.0, 0, 1, 0.7, 1, 0, 0, Math.PI / 2],
      [cyl(0.9, 0.9, 0.12, 8), '#ff8a3c', 1, -4.52, 1.0, 0, 1, 0.7, 1, 0, 0, Math.PI / 2],
      [box(2.8, 0.12, 0.5), CYAN, 1, 2.0, 1.95, 0, 1, 1, 1],
      [box(2.2, 2.0, 0.18), '#8e94a2', 0, -2.6, 2.6, 0, 1, 1, 1, 0, 0.25, 0.4],
      [box(3.4, 0.14, 2.4), '#a2a8b4', 0, -0.8, 0.7, 2.0, 1, 1, 1, 0.3, 0.3, 0],
      [box(1.4, 0.5, 1.0), '#6d7280', 0, 3.6, 0.2, -2.2, 1, 1, 1, 0.8],
    ]),
    // Drifting rock.
    debris: merge([[new THREE.IcosahedronGeometry(1, 0), '#7a7088', 0, 0, 0, 0, 1, 0.8, 1.1]]),
  };
  const T = (...c) => c.map((x) => new THREE.Color(x));
  const tints = {
    dish: T('#ffffff', '#f2e4d6', '#dfe6ee', '#e8dcc8'),
    monolith: T('#ffffff', '#e8e4f2', '#dde6ea', '#f0e8e0'),
    obelisk: T('#ffffff', '#f2e8dc', '#e2e0ee', '#e8f0ec'),
    crystals: T('#ffffff', '#d8ffee', '#ffe0f6', '#e0e8ff'),
    arch: T('#ffffff', '#f4e8d8', '#e4e0ec', '#ecf0e8'),
    ring: T('#ffffff', '#f0e6dc', '#e2e4f0', '#eae6f2'),
    hull: T('#ffffff', '#f2e6dc', '#e0e6ee', '#ece8e2'),
    debris: T('#ffffff', '#e8dcd0', '#d6d8e6', '#c8c0d0'),
  };
  const time = { value: 0 };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.75, metalness: 0.15, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nuniform float uTime;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
float phase = 0.0;
#ifdef USE_INSTANCING
  phase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
#endif
vGlow = glow * (0.78 + 0.22 * sin(uTime * 1.7 + phase));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * vGlow * 2.4;`);
  };
  addFogShade(material, 'relics');
  shared = { geo, tints, material, time };
  return shared;
}

// How far a toppled relic tips over, and how much it lifts so it lies on its side.
const FALL = { dish: [1.25, 0.6], monolith: [1.45, 0.35], obelisk: [1.48, 0.9], arch: [1.4, 0.6], ring: [1.5, 0.5] };

export class ArtifactMesh {
  constructor(scenery) {
    this.scenery = scenery;
    this.group = new THREE.Group();
    this.meshes = {};
    this.seen = -1;
    this.debris = null;
  }

  // Size the instance buffers for the relics as placed (each round).
  rebuild() {
    this.clear();
    const sc = this.scenery;
    if (!sc.artifacts.length && !sc.drifters.length) return;
    const a = assets();
    const count = {};
    for (const r of sc.artifacts) count[r.kind] = (count[r.kind] || 0) + 1;
    for (const kind of ARTIFACT_KINDS) {
      if (!count[kind]) continue;
      const mesh = new THREE.InstancedMesh(a.geo[kind], a.material, count[kind]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // spread over the whole field
      this.meshes[kind] = mesh;
      this.group.add(mesh);
    }
    if (sc.drifters.length) {
      const mesh = new THREE.InstancedMesh(a.geo.debris, a.material, sc.drifters.length);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      sc.drifters.forEach((d, i) => mesh.setColorAt(i, a.tints.debris[d.tint]));
      this.debris = mesh;
      this.group.add(mesh);
    }
    this.seen = -1;
    this.sync(0);
  }

  writeStatic() {
    const a = assets();
    const next = {};
    for (const r of this.scenery.artifacts) {
      const mesh = this.meshes[r.kind];
      const i = next[r.kind] = (next[r.kind] ?? -1) + 1;
      if (r.state === 'gone') { mesh.setMatrixAt(i, HIDDEN); continue; }
      Q.setFromAxisAngle(UP, r.rot);
      let lift = 0;
      if (r.tilt) {
        // The wreck: nose down (local +x) and rolled over.
        Q.multiply(Q2.setFromAxisAngle(AXIS.set(0, 0, 1), -r.tilt[0]));
        Q.multiply(Q2.setFromAxisAngle(AXIS.set(1, 0, 0), r.tilt[1]));
      }
      if (r.state === 'fallen') {
        const [tip, up] = FALL[r.kind] || [1.4, 0.5];
        AXIS.set(Math.sin(r.fall), 0, -Math.cos(r.fall));
        Q.premultiply(Q2.setFromAxisAngle(AXIS, tip));
        lift = up * r.scale;
      }
      M.compose(P.set(r.x, r.y + lift, r.z), Q, S.setScalar(r.scale));
      mesh.setMatrixAt(i, M);
      mesh.setColorAt(i, a.tints[r.kind][r.tint]);
    }
    for (const mesh of Object.values(this.meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // `time` in seconds: the glow's pulse and the drifting rocks.
  sync(time) {
    if (!this.group.children.length) return;
    const a = assets();
    a.time.value = time;
    const sc = this.scenery;
    if (this.seen !== sc.version) {
      this.seen = sc.version;
      this.writeStatic();
    }
    const mesh = this.debris;
    if (!mesh) return;
    for (let i = 0; i < sc.drifters.length; i++) {
      const d = sc.drifters[i];
      const ang = d.phase + time * d.speed;
      Q.setFromEuler(EULER.set(time * d.spin + d.phase, time * d.spin * 0.7, d.phase * 2));
      M.compose(P.set(d.cx + Math.cos(ang) * d.r, d.y + Math.sin(time * 0.4 + d.phase) * d.bob, d.cz + Math.sin(ang) * d.r), Q, S.setScalar(d.size));
      mesh.setMatrixAt(i, M);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (const mesh of this.group.children.slice()) { this.group.remove(mesh); mesh.dispose(); }
    this.meshes = {};
    this.debris = null;
  }

  dispose() { this.clear(); }
}
