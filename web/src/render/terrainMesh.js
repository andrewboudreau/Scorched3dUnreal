import * as THREE from 'three';
import { makePerlin } from '../core/noise.js';

// Renders a core Heightfield as a lit, vertex-coloured slab with earthen sides.
// Only the region a crater touched is rewritten after each blast.

const C = {
  sand: new THREE.Color('#c8ae78'),
  grass: new THREE.Color('#5c8a3c'),
  grassHi: new THREE.Color('#86a64e'),
  lush: new THREE.Color('#4a7d38'),
  dry: new THREE.Color('#a3a25a'),
  wetSand: new THREE.Color('#9c8a5e'),
  bed: new THREE.Color('#4d5a48'),
  rock: new THREE.Color('#7b7266'),
  peak: new THREE.Color('#b9a98a'),
  scorch: new THREE.Color('#3b2d21'),
  dirt: new THREE.Color('#6b4a2e'),
  side: new THREE.Color('#5a3d26'),
  sideDeep: new THREE.Color('#2e2117'),
};

// World-space value noise breaks up the vertex colours below the 3 m grid
// so the ground reads as grass and dirt rather than smooth paint. The same
// noise tilts the shading normal a little, which gives nearby ground a rough,
// tufted surface; it fades out with distance so far hills stay calm.
function addGroundDetail(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGroundP;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float gRough(vec2 p) { return gNoise(p * 0.45) * 0.65 + gNoise(p * 1.9) * 0.35; }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float fade = 1.0 - smoothstep(50.0, 420.0, length(vViewPosition));
  if (fade > 0.0) {
    vec2 q = vGroundP.xz;
    float h0 = gRough(q);
    vec3 tilt = vec3(h0 - gRough(q + vec2(0.4, 0.0)), 0.0, h0 - gRough(q + vec2(0.0, 0.4))) * (1.5 * fade);
    normal = normalize(normal + (viewMatrix * vec4(tilt, 0.0)).xyz);
  }
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 q = vGroundP.xz;
  float n = gNoise(q * 0.08) * 0.5 + gNoise(q * 0.31) * 0.3 + gNoise(q * 1.7) * 0.2;
  diffuseColor.rgb *= 0.84 + 0.32 * n;
}`);
  };
}

export class TerrainMesh {
  constructor(field) {
    this.field = field;
    const n = field.n;
    const count = n * n;
    this.positions = new Float32Array(count * 3);
    this.normals = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.jitter = new Float32Array(count);
    this.patch = new Float32Array(count);   // broad lush/dry meadow patches, -1..1
    const noise = makePerlin(99);
    const broad = makePerlin(41);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        this.positions[k * 3] = field.vx(i);
        this.positions[k * 3 + 2] = field.vz(j);
        this.jitter[k] = noise(i * 0.21, j * 0.21) * 0.5 + noise(i * 0.9, j * 0.9) * 0.25;
        this.patch[k] = broad(field.vx(i) * 0.014, field.vz(j) * 0.014) + broad(field.vx(i) * 0.05, field.vz(j) * 0.05) * 0.4;
      }
    }
    const index = [];
    for (let j = 0; j < field.res; j++) {
      for (let i = 0; i < field.res; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        // Alternate the split diagonal so crater rims don't saw-tooth in one direction.
        if ((i + j) & 1) index.push(a, c, d, a, d, b);
        else index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(index);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry = geo;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    addGroundDetail(this.material);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;

    // Skirt: the four earthen walls down to bedrock.
    const sideVerts = 4 * n * 2;
    this.skirtPos = new Float32Array(sideVerts * 3);
    this.skirtCol = new Float32Array(sideVerts * 3);
    const sIndex = [];
    for (let s = 0; s < 4; s++) {
      for (let k = 0; k < n - 1; k++) {
        const top = (s * n + k) * 2;
        const a = top;
        const b = top + 1;
        const c = top + 2;
        const d = top + 3;
        sIndex.push(a, b, c, c, b, d);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setIndex(sIndex);
    sg.setAttribute('position', new THREE.BufferAttribute(this.skirtPos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(this.skirtCol, 3));
    this.skirtGeometry = sg;
    this.skirt = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    this.skirt.receiveShadow = true;

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.skirt);
    this.hMin = 0;
    this.hMax = 1;
  }

  rebuild() {
    const h = this.field.heights;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < h.length; k++) { if (h[k] < lo) lo = h[k]; if (h[k] > hi) hi = h[k]; }
    this.hMin = lo;
    this.hMax = Math.max(lo + 1, hi);
    this.updateRegion({ i0: 0, i1: this.field.res, j0: 0, j1: this.field.res });
    this.geometry.computeBoundingSphere();
  }

  updateRegion(r) {
    const f = this.field;
    const n = f.n;
    const i0 = Math.max(0, r.i0 - 1);
    const i1 = Math.min(f.res, r.i1 + 1);
    const j0 = Math.max(0, r.j0 - 1);
    const j1 = Math.min(f.res, r.j1 + 1);
    const h = f.heights;
    const tmp = new THREE.Color();
    const span = this.hMax - this.hMin;
    const water = f.waterLevel;
    const wet = water > -Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        const y = h[k];
        this.positions[k * 3 + 1] = y;
        const hl = h[j * n + Math.max(0, i - 1)];
        const hr = h[j * n + Math.min(f.res, i + 1)];
        const hd = h[Math.max(0, j - 1) * n + i];
        const hu = h[Math.min(f.res, j + 1) * n + i];
        let nx = hl - hr;
        let ny = 2 * f.cell;
        let nz = hd - hu;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        this.normals[k * 3] = nx;
        this.normals[k * 3 + 1] = ny;
        this.normals[k * 3 + 2] = nz;

        // Colour from height band, meadow patches, the waterline, slope and burn.
        const t = (y - this.hMin) / span + this.jitter[k] * 0.06;
        const slope = 1 - ny;
        if (t < 0.12 && !wet) tmp.copy(C.sand).lerp(C.grass, Math.max(0, t / 0.12));
        else if (t < 0.7) tmp.copy(C.grass).lerp(C.grassHi, Math.max(0, (t - 0.12) / 0.58));
        else tmp.copy(C.grassHi).lerp(C.peak, Math.min(1, (t - 0.7) / 0.3) ** 1.5);
        const pt = this.patch[k];
        if (t < 0.8) tmp.lerp(pt > 0 ? C.lush : C.dry, Math.min(0.55, Math.abs(pt) * 0.7));
        if (wet) {
          // A sandy shore just above the water, darker mud below it.
          const d = y - water + this.jitter[k] * 0.5;
          if (d < 2.2) tmp.lerp(C.sand, Math.min(1, (2.2 - d) / 1.4));
          if (d < 0.5) tmp.lerp(C.wetSand, Math.min(1, (0.5 - d) / 0.6));
          if (d < -0.2) tmp.lerp(C.bed, Math.min(1, (-0.2 - d) / 2.5));
        }
        tmp.lerp(C.rock, Math.min(1, Math.max(0, (slope - 0.12) * 3.2)));
        const sc = f.scorch[k];
        if (sc > 0) {
          tmp.lerp(C.dirt, Math.min(1, sc * 1.4));
          tmp.lerp(C.scorch, Math.min(0.85, Math.max(0, sc - 0.35) * 1.1));
        }
        // Hollows sit a little darker and ridges a little lighter than the sun
        // alone makes them, which keeps the relief readable in flat light.
        const hollow = (hl + hr + hd + hu) / 4 - y;
        const v = (1 + this.jitter[k] * 0.12) * Math.min(1.1, Math.max(0.72, 1 - hollow * 0.22));
        this.colors[k * 3] = tmp.r * v;
        this.colors[k * 3 + 1] = tmp.g * v;
        this.colors[k * 3 + 2] = tmp.b * v;
      }
    }
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    if (i0 === 0 || j0 === 0 || i1 === f.res || j1 === f.res) this.updateSkirt();
  }

  updateSkirt() {
    const f = this.field;
    const n = f.n;
    const bottom = f.bedrock - 6;
    // Each side walks its edge in an order that keeps the winding outward.
    const sides = [
      (k) => [k, 0],
      (k) => [f.res, k],
      (k) => [f.res - k, f.res],
      (k) => [0, f.res - k],
    ];
    let v = 0;
    for (const side of sides) {
      for (let k = 0; k < n; k++) {
        const [i, j] = side(k);
        const x = f.vx(i);
        const z = f.vz(j);
        const y = f.heights[j * n + i];
        this.skirtPos.set([x, y, z], v * 3);
        this.skirtCol.set([C.side.r, C.side.g, C.side.b], v * 3);
        v++;
        this.skirtPos.set([x, bottom, z], v * 3);
        this.skirtCol.set([C.sideDeep.r, C.sideDeep.g, C.sideDeep.b], v * 3);
        v++;
      }
    }
    this.skirtGeometry.attributes.position.needsUpdate = true;
    this.skirtGeometry.attributes.color.needsUpdate = true;
    this.skirtGeometry.computeVertexNormals();
    this.skirtGeometry.computeBoundingSphere();
  }
}
