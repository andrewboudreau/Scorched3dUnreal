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
  // The floating isles' undersides: earth under the grass, banded rock below,
  // darkening to the tip.
  soil: new THREE.Color('#6a4a30'),
  stone: new THREE.Color('#7a6d62'),
  stoneDeep: new THREE.Color('#4a4152'),
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

// Fog of war on anything else (trees, houses, water): the same dimming as the
// ground, applied to the lit colour. `key` keeps each material's shader apart.
export function addFogShade(material, key) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uFog = groundShade.fog;
    shader.uniforms.uFogOn = groundShade.fogOn;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFogP;')
      .replace('#include <project_vertex>', `#include <project_vertex>
{
  vec4 fp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    fp = instanceMatrix * fp;
  #endif
  vFogP = (modelMatrix * fp).xyz;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vFogP;
uniform vec3 uFog[${MAX_FOG_SPOTS}];
uniform float uFogOn;`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
if (uFogOn > 0.5) {
  float d = 1e5;
  for (int i = 0; i < ${MAX_FOG_SPOTS}; i++) {
    vec3 c = uFog[i];
    if (c.z > 0.0) d = min(d, length(vFogP.xz - c.xy) - c.z);
  }
  float f = smoothstep(-8.0, 10.0, d);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.32 + vec3(0.04, 0.05, 0.07), f * 0.85);
}`);
  };
  const base = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${base()}|fog:${key}`;
}

// World-space value noise breaks up the vertex colours below the 3 m grid
// so the ground reads as grass and dirt rather than smooth paint. The same
// noise tilts the shading normal a little, which gives nearby ground a rough,
// tufted surface; it fades out with distance so far hills stay calm.
const PATH_TEXELS = 2048;
const NO_PATHS = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
NO_PATHS.needsUpdate = true;

// The 2048^2 path mask is big, so it is built once and handed from match to
// match: `data` is the CPU copy (one byte per texel), `tex` the GPU texture over
// it, and `src` a second, never-rendered texture over the same bytes that
// copyTextureToTexture reads partial rectangles from. `scratch` is the canvas
// the strokes are drawn on, only used inside setPaths.
const pathPool = [];
let scratch = null;
function scratchCanvas() {
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.width = scratch.height = PATH_TEXELS;
  }
  return scratch;
}
function makePathSlot() {
  const data = new Uint8Array(PATH_TEXELS * PATH_TEXELS);
  const tex = new THREE.DataTexture(data, PATH_TEXELS, PATH_TEXELS, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;                 // row 0 is world z at the field's far edge, as the canvas was
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  const src = new THREE.DataTexture(data, PATH_TEXELS, PATH_TEXELS, THREE.RedFormat, THREE.UnsignedByteType);
  return { data, tex, src, box: new THREE.Box2(), at: new THREE.Vector2() };
}

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
// A sine-free hash (no banding at large coordinates) and value noise with a
// quintic fade, so the cell edges do not show up in the bump shading.
float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Each layer turned to its own angle, at odd scale steps, so no two grids line
// up; a slow warp bends the lattice so rows of bumps never run straight.
const mat2 gR1 = mat2(0.80, 0.60, -0.60, 0.80);
const mat2 gR2 = mat2(-0.39, 0.92, -0.92, -0.39);
const mat2 gR3 = mat2(0.26, -0.97, 0.97, 0.26);
vec2 gWarp(vec2 p) { return p + (vec2(gNoise(p * 0.05 + 3.7), gNoise(gR2 * p * 0.05 + 9.1)) - 0.5) * 4.0; }
float gRough(vec2 w) { return gNoise(gR1 * w * 0.47 + 1.3) * 0.5 + gNoise(gR2 * w * 1.13 + 5.9) * 0.3 + gNoise(gR3 * w * 2.71 + 8.2) * 0.2; }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float fade = 1.0 - smoothstep(50.0, 420.0, length(vViewPosition));
  if (fade > 0.0) {
    vec2 q = gQW;   // warped once in color_fragment, which runs first
    float h0 = gRough(q);
    vec3 tilt = vec3(h0 - gRough(q + vec2(0.35, 0.0)), 0.0, h0 - gRough(q + vec2(0.0, 0.35))) * (1.3 * fade);
    normal = normalize(normal + (viewMatrix * vec4(tilt, 0.0)).xyz);
  }
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec2 gQW = gWarp(vGroundP.xz);
{
  vec2 q = vGroundP.xz;
  vec2 qw = gQW;
  float n = gNoise(gR1 * qw * 0.083 + 2.1) * 0.5 + gNoise(gR2 * qw * 0.29 + 6.3) * 0.3 + gNoise(gR3 * qw * 1.63 + 4.4) * 0.2;
  diffuseColor.rgb *= 0.84 + 0.32 * n;
  // Broad patches, tens of metres across: drier, yellower grass in some,
  // lusher and cooler in others, so a wide field is never one even tone.
  float m = smoothstep(0.25, 0.75, gNoise(gR3 * q * 0.012 + 7.0) * 0.7 + gNoise(gR1 * q * 0.031 + 1.0) * 0.3);
  diffuseColor.rgb *= mix(vec3(0.97, 1.0, 1.02), vec3(1.035, 1.01, 0.93), m);
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

// The per-vertex noise and the triangle index depend only on the field's size
// and resolution (the seeds are fixed), so every match on the same grid shares
// one copy. Nobody writes to these after they are built.
const gridCache = new Map();
function gridFor(field) {
  const key = `${field.size}|${field.res}`;
  let g = gridCache.get(key);
  if (g) return g;
  const n = field.n;
  const count = n * n;
  const xz = new Float32Array(count * 3);   // x and z of every vertex; y stays 0
  const jitter = new Float32Array(count);
  const patch = new Float32Array(count);    // broad lush/dry meadow patches, -1..1
  const noise = makePerlin(99);
  const broad = makePerlin(41);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      xz[k * 3] = field.vx(i);
      xz[k * 3 + 2] = field.vz(j);
      jitter[k] = noise(i * 0.21, j * 0.21) * 0.5 + noise(i * 0.9, j * 0.9) * 0.25;
      patch[k] = broad(field.vx(i) * 0.014, field.vz(j) * 0.014) + broad(field.vx(i) * 0.05, field.vz(j) * 0.05) * 0.4;
    }
  }
  const index = count > 65535 ? new Uint32Array(field.res * field.res * 6) : new Uint16Array(field.res * field.res * 6);
  let w = 0;
  for (let j = 0; j < field.res; j++) {
    for (let i = 0; i < field.res; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Alternate the split diagonal so crater rims don't saw-tooth in one direction.
      if ((i + j) & 1) { index[w++] = a; index[w++] = c; index[w++] = d; index[w++] = a; index[w++] = d; index[w++] = b; }
      else { index[w++] = a; index[w++] = c; index[w++] = b; index[w++] = b; index[w++] = c; index[w++] = d; }
    }
  }
  g = { xz, jitter, patch, index };
  gridCache.set(key, g);
  return g;
}

const TMP = new THREE.Color();

export class TerrainMesh {
  constructor(field) {
    this.field = field;
    const n = field.n;
    const count = n * n;
    const grid = gridFor(field);
    this.positions = grid.xz.slice();
    this.normals = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.jitter = grid.jitter;   // shared, read-only
    this.patch = grid.patch;     // shared, read-only
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(grid.index, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    // Until an attribute has been uploaded in full (and after every rebuild) a
    // partial update range would leave the rest stale, so ranges wait for this.
    this.fullPending = { position: true, normal: true, color: true };
    for (const name of ['position', 'normal', 'color']) {
      geo.attributes[name].onUpload(() => { this.fullPending[name] = false; });
    }
    this.geometry = geo;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.paths = { map: { value: NO_PATHS }, scale: { value: 1 / field.size }, slot: null, dirty: null };
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
    this.sharedIndex = geo.index;
    this.under = null;   // the floating isles' undersides (ensureUnder), built for the first isles field
    this.openMask = null;
  }

  // Floating isles: a second sheet of the same grid hangs under the first at
  // the field's underside heights, facing down. Both draw only the quads that
  // touch an isle, so open sky stays open, and they meet at each isle's rim.
  ensureUnder() {
    if (this.under) { this.under.mesh.visible = true; return; }
    const f = this.field;
    const count = f.n * f.n;
    const geo = new THREE.BufferGeometry();
    const pos = gridFor(f).xz.slice();
    const nrm = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // A faint glow of its own: the sun never reaches an underside.
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true, emissive: '#3a2c48', emissiveIntensity: 0.6 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.under = { geo, pos, nrm, col, mesh };
    this.openMask = new Uint8Array(count);
  }

  // Draw only the quads with a corner on an isle: the top as the grid winds,
  // the underside turned over.
  rebuildIndex() {
    const f = this.field;
    const n = f.n;
    const open = this.openMask;
    const top = new Uint32Array(f.res * f.res * 6);
    const bot = new Uint32Array(f.res * f.res * 6);
    let w = 0;
    for (let j = 0; j < f.res; j++) {
      for (let i = 0; i < f.res; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if (open[a] && open[b] && open[c] && open[d]) continue;
        const t = (i + j) & 1 ? [a, c, d, a, d, b] : [a, c, b, b, c, d];
        for (let q = 0; q < 6; q += 3) {
          top[w] = t[q]; top[w + 1] = t[q + 1]; top[w + 2] = t[q + 2];
          bot[w] = t[q]; bot[w + 1] = t[q + 2]; bot[w + 2] = t[q + 1];
          w += 3;
        }
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(top.slice(0, w), 1));
    this.under.geo.setIndex(new THREE.BufferAttribute(bot.slice(0, w), 1));
    this.under.geo.computeBoundingSphere();
  }

  // Paint these paths (core/paths.js) onto the ground, replacing any before.
  setPaths(paths) {
    const P = this.paths;
    if (!P.slot) {
      P.slot = pathPool.pop() || makePathSlot();
      P.map.value = P.slot.tex;
    }
    P.dirty = null;
    const cv = scratchCanvas();
    const g = cv.getContext('2d');
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
    g.shadowBlur = 0;
    // The shader reads only red. Canvas row 0 is texture row 0 (flipY is off
    // and canvas y runs with world z), so the rows copy straight across.
    const rgba = g.getImageData(0, 0, PATH_TEXELS, PATH_TEXELS).data;
    const data = P.slot.data;
    for (let i = 0, n = data.length; i < n; i++) data[i] = rgba[i * 4];
    P.slot.tex.needsUpdate = true;
  }

  // The ground in `region` was just blown out or buried: the path there is gone.
  // The same radial fade the canvas used to paint (opaque black inside 0.55 r,
  // clear at r), applied to the mask directly; flushPaths uploads the result.
  scuffPaths(region) {
    const P = this.paths;
    if (!P.slot) return;
    const f = this.field;
    const k = PATH_TEXELS / f.size;
    const cx = ((region.i0 + region.i1) / 2) * f.cell * k;
    const cy = ((region.j0 + region.j1) / 2) * f.cell * k;
    const r = Math.max(2, ((region.i1 - region.i0) / 2 - 1.5) * f.cell * 0.95) * k;
    const r0 = r * 0.55;
    const inv = 1 / (r - r0);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(PATH_TEXELS - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(PATH_TEXELS - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return;
    const data = P.slot.data;
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const row = y * PATH_TEXELS;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const d = Math.sqrt(d2);
        const keep = d <= r0 ? 0 : (d - r0) * inv;   // 1 - alpha of the fade
        const i = row + x;
        if (data[i] !== 0) data[i] = Math.round(data[i] * keep);
      }
    }
    const D = P.dirty;
    if (!D) P.dirty = { x0, y0, x1, y1 };
    else {
      if (x0 < D.x0) D.x0 = x0;
      if (y0 < D.y0) D.y0 = y0;
      if (x1 > D.x1) D.x1 = x1;
      if (y1 > D.y1) D.y1 = y1;
    }
  }

  // Send whatever scuffPaths changed since the last call to the GPU: just the
  // touched rectangle, then the mips are rebuilt.
  flushPaths(renderer) {
    const P = this.paths;
    const D = P.dirty;
    if (!D) return;
    P.dirty = null;
    const slot = P.slot;
    if (!slot) return;
    if (!renderer?.copyTextureToTexture) { slot.tex.needsUpdate = true; return; }
    slot.box.min.set(D.x0, D.y0);
    slot.box.max.set(D.x1 + 1, D.y1 + 1);
    slot.at.set(D.x0, D.y0);
    renderer.copyTextureToTexture(slot.src, slot.tex, slot.box, slot.at);
  }

  dispose() {
    this.geometry.dispose();
    if (this.under) { this.under.geo.dispose(); this.under.mesh.material.dispose(); }
    this.skirtGeometry.dispose();
    this.material.dispose();
    // The path mask (and its GPU copy) goes back to the pool for the next match.
    const P = this.paths;
    if (P.slot) { pathPool.push(P.slot); P.slot = null; P.map.value = NO_PATHS; }
    P.dirty = null;
  }

  rebuild() {
    const f = this.field;
    const h = f.heights;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < h.length; k++) {
      if (f.isOpen(k)) continue;   // the height bands are the isles', not the void's
      if (h[k] < lo) lo = h[k];
      if (h[k] > hi) hi = h[k];
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    this.hMin = lo;
    this.hMax = Math.max(lo + 1, hi);
    this.skirt.visible = !f.under;
    if (f.under) this.ensureUnder();
    else {
      if (this.under) this.under.mesh.visible = false;
      if (this.geometry.index !== this.sharedIndex) this.geometry.setIndex(this.sharedIndex);
    }
    this.updateRegion({ i0: 0, i1: f.res, j0: 0, j1: f.res }, true);
    this.geometry.computeBoundingSphere();
  }

  updateRegion(r, fresh = false) {
    const f = this.field;
    const U = f.under;
    const ud = U && this.under;
    let reindex = fresh && !!U;
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
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
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
        const open = ud ? (f.isOpen(k) ? 1 : 0) : 0;
        if (open) tmp.copy(C.soil);   // an isle's rim: the earth under the turf
        this.colors[k * 3] = tmp.r * v;
        this.colors[k * 3 + 1] = tmp.g * v;
        this.colors[k * 3 + 2] = tmp.b * v;
        if (ud) {
          if (this.openMask[k] !== open) { this.openMask[k] = open; reindex = true; }
          this.colorUnder(k, i, j, open);
        }
      }
    }
    if (ud) {
      const a = this.under.geo.attributes;
      a.position.needsUpdate = a.normal.needsUpdate = a.color.needsUpdate = true;
      if (reindex) this.rebuildIndex();
    }
    const g = this.geometry;
    const full = i0 === 0 && j0 === 0 && i1 === f.res && j1 === f.res;
    // Upload only the rows this touched: one span from the first vertex to the last.
    const from = (j0 * n + i0) * 3;
    const count = ((j1 * n + i1) - (j0 * n + i0) + 1) * 3;
    for (const name of ['position', 'normal', 'color']) {
      const a = g.attributes[name];
      if (full) { a.clearUpdateRanges(); this.fullPending[name] = true; }
      else if (!this.fullPending[name]) a.addUpdateRange(from, count);
      a.needsUpdate = true;
    }
    if (i0 === 0 || j0 === 0 || i1 === f.res || j1 === f.res) this.updateSkirt();
  }

  // One vertex of the underside: its height, a downward normal and a colour
  // from soil under the rim, through banded rock, to the dark tip.
  colorUnder(k, i, j, open) {
    const f = this.field;
    const n = f.n;
    const U = f.under;
    const u = U[k];
    const S = this.under;
    S.pos[k * 3 + 1] = u;
    const ul = U[j * n + Math.max(0, i - 1)];
    const ur = U[j * n + Math.min(f.res, i + 1)];
    const uu = U[Math.max(0, j - 1) * n + i];
    const uw = U[Math.min(f.res, j + 1) * n + i];
    let nx = ur - ul;
    let ny = -2 * f.cell;
    let nz = uw - uu;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    S.nrm[k * 3] = nx / len; S.nrm[k * 3 + 1] = ny / len; S.nrm[k * 3 + 2] = nz / len;
    const tmp = TMP;
    const depth = open ? 0 : f.heights[k] - u;
    tmp.copy(C.soil).lerp(C.stone, Math.min(1, depth / 6));
    tmp.lerp(C.stoneDeep, Math.min(1, Math.max(0, (depth - 14) / 30)));
    // Strata: bands that follow the height, wobbled so they do not ring true.
    const band = 0.88 + 0.14 * Math.sin(u * 0.85 + this.jitter[k] * 4);
    const v = band * (1 + this.jitter[k] * 0.1);
    S.col[k * 3] = tmp.r * v;
    S.col[k * 3 + 1] = tmp.g * v;
    S.col[k * 3 + 2] = tmp.b * v;
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
