import * as THREE from 'three';
import { makePerlin } from '../core/noise.js';

// Renders a core Heightfield as a lit, vertex-coloured slab with earthen sides.
// Only the region a crater touched is rewritten after each blast.
//
// Roads and footpaths (core/paths.js) are drawn once into a mask texture laid
// flat over the field and tinted in by the ground shader, so they follow every
// dent in the ground. A crater or a mound wipes the mask where it lands.

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

// Faint cloud shadows: render/sky.js writes each cloud's shadow here as
// (x, z, radius) and the ground shader dims itself under them.
export const MAX_CLOUD_SHADOWS = 14;
export const MAX_FOG_SPOTS = 12;
export const groundShade = {
  clouds: { value: Array.from({ length: MAX_CLOUD_SHADOWS }, () => new THREE.Vector3(0, 0, 0)) },
  // Fog of war: the ground outside these circles (x, z, radius; radius 0 is
  // unused) is dimmed, when `fogOn` is 1.
  fog: { value: Array.from({ length: MAX_FOG_SPOTS }, () => new THREE.Vector3(0, 0, 0)) },
  fogOn: { value: 0 },
};

// World-space value noise breaks up the vertex colours below the 3 m grid
// so the ground reads as grass and dirt rather than smooth paint. The same
// noise tilts the shading normal a little, which gives nearby ground a rough,
// tufted surface; it fades out with distance so far hills stay calm.
const PATH_TEXELS = 2048;
const NO_PATHS = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
NO_PATHS.needsUpdate = true;

function addGroundDetail(material, paths) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloud = groundShade.clouds;
    shader.uniforms.uFog = groundShade.fog;
    shader.uniforms.uFogOn = groundShade.fogOn;
    shader.uniforms.uPath = paths.map;
    shader.uniforms.uPathScale = paths.scale;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGroundP;
uniform vec3 uCloud[${MAX_CLOUD_SHADOWS}];
uniform vec3 uFog[${MAX_FOG_SPOTS}];
uniform float uFogOn;
uniform sampler2D uPath;
uniform float uPathScale;
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
  // Gravel where the path mask says so, with a ragged edge and a little grit.
  float pm = texture2D(uPath, q * uPathScale + 0.5).r;
  if (pm > 0.02) {
    float worn = smoothstep(0.28, 0.6, pm + (gNoise(q * 0.8) - 0.5) * 0.55);
    vec3 gravel = vec3(0.47, 0.41, 0.31) * (0.8 + 0.32 * gHash(floor(q * 2.6))) * (0.9 + 0.2 * n);
    diffuseColor.rgb = mix(diffuseColor.rgb, gravel, worn * 0.9);
  }
  float shade = 0.0;
  for (int i = 0; i < ${MAX_CLOUD_SHADOWS}; i++) {
    vec3 c = uCloud[i];
    shade = max(shade, 1.0 - smoothstep(c.z * 0.35, c.z, length((q - c.xy) * vec2(0.6, 1.0))));
  }
  diffuseColor.rgb *= 1.0 - 0.22 * shade;
  if (uFogOn > 0.5) {
    float d = 1e5;
    for (int i = 0; i < ${MAX_FOG_SPOTS}; i++) {
      vec3 c = uFog[i];
      if (c.z > 0.0) d = min(d, length(q - c.xy) - c.z);
    }
    float f = smoothstep(-8.0, 10.0, d);
    float grain = gNoise(q * 0.05 + vec2(d * 0.01)) * 0.12;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.3 + grain) + vec3(0.05, 0.06, 0.08), f * 0.85);
  }
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
    this.paths = { map: { value: NO_PATHS }, scale: { value: 1 / field.size }, canvas: null };
    addGroundDetail(this.material, this.paths);
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

  // Paint these paths (core/paths.js) onto the ground, replacing any before.
  setPaths(paths) {
    const P = this.paths;
    if (!P.canvas) {
      P.canvas = document.createElement('canvas');
      P.canvas.width = P.canvas.height = PATH_TEXELS;
      const tex = new THREE.CanvasTexture(P.canvas);
      tex.flipY = false;                 // canvas y runs with world z
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 4;
      P.map.value = tex;
    }
    const g = P.canvas.getContext('2d');
    const k = PATH_TEXELS / this.field.size;
    const px = (v) => (v + this.field.half) * k;
    g.globalCompositeOperation = 'source-over';
    g.shadowBlur = 0;
    g.fillStyle = '#000';
    g.fillRect(0, 0, PATH_TEXELS, PATH_TEXELS);
    g.strokeStyle = g.shadowColor = '#fff';
    g.lineCap = g.lineJoin = 'round';
    for (const p of paths) {
      g.lineWidth = p.width * k;
      g.shadowBlur = p.width * k * 0.6;  // a soft shoulder for the shader to fray
      g.beginPath();
      p.points.forEach(([x, z], i) => (i ? g.lineTo(px(x), px(z)) : g.moveTo(px(x), px(z))));
      g.stroke();
    }
    P.map.value.needsUpdate = true;
  }

  // The ground in `region` was just blown out or buried: the path there is gone.
  scuffPaths(region) {
    const P = this.paths;
    if (!P.canvas) return;
    const f = this.field;
    const k = PATH_TEXELS / f.size;
    const x = ((region.i0 + region.i1) / 2) * f.cell * k;
    const y = ((region.j0 + region.j1) / 2) * f.cell * k;
    const r = Math.max(2, ((region.i1 - region.i0) / 2 - 1.5) * f.cell * 0.95) * k;
    const g = P.canvas.getContext('2d');
    const fade = g.createRadialGradient(x, y, r * 0.55, x, y, r);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.shadowBlur = 0;
    g.fillStyle = fade;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    P.map.value.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.skirtGeometry.dispose();
    this.material.dispose();
    if (this.paths.canvas) this.paths.map.value.dispose();
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
