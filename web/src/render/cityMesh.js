import * as THREE from 'three';
import { CITY, chunkBox } from '../core/city.js';
import { makeRng } from '../core/rng.js';
import { addFogShade } from './terrainMesh.js';
import { look } from './timeofday.js';
import { Debris, Falls } from './cityFx.js';

// Draws the City (core/city.js): its buildings, their rooftops, the damage
// they have taken and the rubble of those that came down, the street lights
// and the traffic (core/traffic.js).
//
// Draw calls are few: the walls are merged into one mesh per facade style,
// each with a small canvas texture of windows (UVs count bays and storeys, so
// the windows line up with the floors); everything else that stands still
// (roofs, parapets, water towers, broken tops, scars, rubble) is one
// vertex-coloured mesh. Both are rebuilt only when the town changes (its
// `version`), and then only the buildings that changed are made again.
// Street lights are one InstancedMesh, and each kind of vehicle another,
// moved every frame.
//
// An intact building is one box of walls. Once it has lost a chunk it is
// drawn chunk by chunk (`chunked`): the outer walls of the chunks still
// standing, windows lined up as before, and broken edges where chunks are
// gone: a dark inside with floor slabs sticking out, ragged wall ends, broken
// caps and undersides. Debris, toppling corners and buildings dropping into
// their rubble are render/cityFx.js.

const BAY = 3;                 // m of wall a window texture column covers
const TILE = 8;                // bays and storeys in one window texture
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const DUMMY = new THREE.Object3D();
const COL = new THREE.Color();

// Facade styles (CITY.styles): the wall colour the details take after, and
// how the window texture is painted.
const STYLES = [
  { name: 'glass', wall: '#5d7385', cap: '#9aa7b0', roughness: 0.45, metalness: 0.15 },
  { name: 'office', wall: '#cdc5b6', cap: '#e0dad0', roughness: 0.85, metalness: 0 },
  { name: 'brick', wall: '#8d5340', cap: '#c9bba6', roughness: 0.95, metalness: 0 },
];
const TINTS = [[1, 1, 1], [0.92, 0.95, 1], [1, 0.95, 0.88], [0.88, 0.9, 0.87], [1.04, 1, 0.94], [0.86, 0.86, 0.92]];
const ROOF = '#55585c';
const SLAB = '#6f6a62';         // a broken floor, open to the sky
const SCAR = '#2c2622';
const INSIDE = '#3e3a36';       // a building's inside, where a chunk is gone
const BX = [0, 0, 0, 0, 0, 0];  // scratch: a chunk's box (core chunkBox)
const AWNINGS = ['#b0473a', '#3f7a5a', '#3b6a9a', '#c99a3a', '#7a4a7a'];
const PAINT = {
  car: ['#c23b30', '#2f5d9e', '#e8e4da', '#2b2d31', '#8a9096', '#d9a23a', '#3f7a4f', '#6b3f78'],
  bus: ['#e0b53a', '#c9473a', '#3b78b8'],
  truck: ['#e8e6e0', '#c94f3a', '#3d6fa8', '#e8e6e0'],
};
const WRECK = new THREE.Color('#463c35');

// ---------------------------------------------------------------- window textures

const textures = [];
function windowTexture(style) {
  if (textures[style]) return textures[style];
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  const rng = makeRng(17 + style * 101);
  const c = 256 / TILE;
  const S = STYLES[style];
  g.fillStyle = S.wall;
  g.fillRect(0, 0, 256, 256);
  // The same windows, lit, on black: the emissive map for Dusk and Night.
  const gc = document.createElement('canvas');
  gc.width = gc.height = 256;
  const gg = gc.getContext('2d');
  gg.fillStyle = '#000';
  gg.fillRect(0, 0, 256, 256);
  const lrng = makeRng(31 + style * 7);
  const glowOf = (x, y, w, h) => { gg.fillStyle = '#ffcf80'; gg.fillRect(x, y, w, h); };
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const x = i * c, y = j * c;
      const lit = rng.next() < 0.12;
      const lights = lrng.next() < 0.55;    // after dark, more windows are lit than by day (its own dice: the day texture is unchanged)
      const dark = 30 + rng.int(0, 25);
      if (style === 0) {
        // Curtain wall: big panes between slim mullions, a spandrel band each floor.
        g.fillStyle = lit ? '#cfd6c4' : `rgb(${dark + 10},${dark + 35},${dark + 55})`;
        g.fillRect(x + 1, y + 2, c - 2, c * 0.72);
        if (lit || lights) glowOf(x + 1, y + 2, c - 2, c * 0.72);
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x + 1, y + 2, (c - 2) * 0.45, c * 0.72);
        g.fillStyle = '#71879a';
        g.fillRect(x, y + c * 0.78, c, c * 0.22);
      } else if (style === 1) {
        // Ribbon windows in concrete bands.
        g.fillStyle = lit ? '#d9d6bd' : `rgb(${dark},${dark + 12},${dark + 24})`;
        g.fillRect(x, y + c * 0.18, c, c * 0.5);
        if (lit || lights) glowOf(x, y + c * 0.18, c, c * 0.5);
        g.fillStyle = '#9aa1a6';
        g.fillRect(x + c / 2 - 0.5, y + c * 0.18, 1.5, c * 0.5);
        g.fillRect(x, y + c * 0.18, 1.5, c * 0.5);
      } else {
        // Brick: coursing, then a sash window with a sill and a lintel.
        g.fillStyle = 'rgba(40,20,12,0.18)';
        for (let r = 0; r < c; r += 4) g.fillRect(x, y + r, c, 1);
        g.fillStyle = 'rgba(255,230,200,0.06)';
        for (let r = 2; r < c; r += 8) g.fillRect(x + ((r / 4) % 2) * 4, y + r, c, 1);
        g.fillStyle = '#d9cfbf';
        g.fillRect(x + c * 0.24, y + c * 0.18, c * 0.52, 2);
        g.fillRect(x + c * 0.22, y + c * 0.76, c * 0.56, 2);
        g.fillStyle = lit ? '#e3d6a6' : `rgb(${dark},${dark + 6},${dark + 14})`;
        g.fillRect(x + c * 0.28, y + c * 0.22, c * 0.44, c * 0.53);
        if (lit || lights) glowOf(x + c * 0.28, y + c * 0.22, c * 0.44, c * 0.53);
        g.fillStyle = '#c8bfae';
        g.fillRect(x + c * 0.28, y + c * 0.47, c * 0.44, 1.5);
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textures[style] = tex;
  const glow = new THREE.CanvasTexture(gc);
  glow.wrapS = glow.wrapT = THREE.RepeatWrapping;
  glow.colorSpace = THREE.SRGBColorSpace;
  glows[style] = glow;
  return tex;
}
const glows = [];

// ---------------------------------------------------------------- geometry

// Flat-shaded triangles into plain arrays, then one BufferGeometry.
class Batch {
  constructor(uv = false) {
    this.p = [];
    this.n = [];
    this.c = [];
    this.u = uv ? [] : null;
  }

  // A quad from corner o along U and V (U x V faces out), colour [r, g, b];
  // `uv` [u0, v0, u1, v1] if the batch has UVs.
  face(ox, oy, oz, ux, uy, uz, vx, vy, vz, col, uv = null) {
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const P = this.p, N = this.n, C = this.c;
    const corner = (a, b) => {
      P.push(ox + ux * a + vx * b, oy + uy * a + vy * b, oz + uz * a + vz * b);
      N.push(nx, ny, nz);
      C.push(col[0], col[1], col[2]);
      if (this.u) this.u.push(uv ? uv[0] + (uv[2] - uv[0]) * a : 0, uv ? uv[1] + (uv[3] - uv[1]) * b : 0);
    };
    corner(0, 0); corner(1, 0); corner(1, 1);
    corner(0, 0); corner(1, 1); corner(0, 1);
  }

  // A box centred on x/z from y0 up h, half sizes hx/hz, turned `rot` about y.
  box(x, y0, z, hx, h, hz, col, rot = 0, bottom = false) {
    const c = Math.cos(rot), s = Math.sin(rot);
    // Local (a, b) on the ground plane to world.
    const wx = (a, b) => x + a * c + b * s;
    const wz = (a, b) => z - a * s + b * c;
    const dir = (a, b) => [a * c + b * s, -a * s + b * c];
    const f = (a, b, y, ua, ub, uy, va, vb, vy) => {
      const [ux, uz] = dir(ua, ub);
      const [vx, vz] = dir(va, vb);
      this.face(wx(a, b), y, wz(a, b), ux, uy, uz, vx, vy, vz, col);
    };
    f(hx, hz, y0, 0, -2 * hz, 0, 0, 0, h);
    f(-hx, -hz, y0, 0, 2 * hz, 0, 0, 0, h);
    f(-hx, hz, y0, 2 * hx, 0, 0, 0, 0, h);
    f(hx, -hz, y0, -2 * hx, 0, 0, 0, 0, h);
    f(-hx, hz, y0 + h, 2 * hx, 0, 0, 0, -2 * hz, 0);
    if (bottom) f(-hx, -hz, y0, 2 * hx, 0, 0, 0, 2 * hz, 0);
  }

  // An upright prism of `seg` sides: radius r0 at the foot, r1 at the top (0: a cone).
  prism(x, y0, z, r0, r1, h, seg, col) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p0 = [x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0];
      const p1 = [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0];
      const q0 = [x + Math.cos(a0) * r1, y0 + h, z + Math.sin(a0) * r1];
      const q1 = [x + Math.cos(a1) * r1, y0 + h, z + Math.sin(a1) * r1];
      this.tri(p1, p0, q0, col);
      if (r1 > 0) {
        this.tri(p1, q0, q1, col);
        this.tri([x, y0 + h, z], q1, q0, col);
      }
    }
  }

  tri(a, b, c, col) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) {
      this.p.push(p[0], p[1], p[2]);
      this.n.push(nx, ny, nz);
      this.c.push(col[0], col[1], col[2]);
      if (this.u) this.u.push(0, 0);
    }
  }

  // The arrays as Float32Arrays, to keep and join later (see join()).
  pack() {
    return { p: new Float32Array(this.p), n: new Float32Array(this.n), c: new Float32Array(this.c), u: this.u ? new Float32Array(this.u) : null };
  }

  build(into = null) {
    const g = into || new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.u) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// Join packed pieces (Batch.pack) into one geometry.
function join(pieces, uv) {
  let n = 0;
  for (const q of pieces) n += q.p.length;
  const P = new Float32Array(n), N = new Float32Array(n), C = new Float32Array(n), U = uv ? new Float32Array((n / 3) * 2) : null;
  let o = 0, ou = 0;
  for (const q of pieces) {
    P.set(q.p, o); N.set(q.n, o); C.set(q.c, o);
    if (U) { U.set(q.u, ou); ou += q.u.length; }
    o += q.p.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  if (U) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.computeBoundingSphere();
  return g;
}

const rgb = (hex, k = 1, tint = null) => {
  COL.set(hex);
  return [COL.r * k * (tint ? tint[0] : 1), COL.g * k * (tint ? tint[1] : 1), COL.b * k * (tint ? tint[2] : 1)];
};

// The vehicles, built along +x with their wheels on y = 0. Paint is white
// (the instance colour paints it); glass and tyres stay dark.
function vehicleGeometry(kind) {
  const b = new Batch();
  const white = [1, 1, 1], glass = rgb('#28323d'), tyre = rgb('#1b1b1d'), light = [0.92, 0.91, 0.88];
  const wheels = (xs, half) => { for (const x of xs) for (const z of [-half, half]) b.box(x, 0, z, 0.38, 0.72, 0.16, tyre); };
  if (kind === 'car') {
    wheels([-1.35, 1.35], 0.82);
    b.box(0, 0.35, 0, 2.2, 0.72, 0.93, white);
    b.box(-0.25, 1.07, 0, 1.15, 0.62, 0.82, glass);
    b.box(-0.25, 1.69, 0, 1.05, 0.1, 0.76, white);
  } else if (kind === 'bus') {
    wheels([-3.6, 3.6], 1.15);
    b.box(0, 0.4, 0, 5.5, 1.3, 1.28, white);
    b.box(0, 1.7, 0, 5.45, 1.05, 1.3, glass);
    b.box(0, 2.75, 0, 5.5, 0.45, 1.28, white);
    b.box(-1, 3.2, 0, 1.6, 0.25, 0.9, light);
  } else {
    wheels([-2.2, -1.1, 2.3], 1.05);
    b.box(2.45, 0.45, 0, 1.05, 1.15, 1.15, white);
    b.box(2.6, 1.6, 0, 0.9, 0.75, 1.1, glass);
    b.box(-1.05, 0.55, 0, 2.4, 2.55, 1.2, light);
  }
  return b.build();
}

function lampGeometry() {
  const b = new Batch();
  const pole = rgb('#3d4247'), lamp = rgb('#f1e6c2');
  b.box(0, 0, 0, 0.11, 6.2, 0.11, pole);
  b.box(0.8, 6.0, 0, 0.85, 0.14, 0.08, pole);
  b.box(1.5, 5.82, 0, 0.38, 0.2, 0.18, lamp);
  return b.build();
}

// ---------------------------------------------------------------- the view

export class CityView {
  // `game` is read for its town each frame (a new round lays a new one);
  // `effects` (render/effects.js) gets the dust and fires.
  constructor(game, effects) {
    this.game = game;
    this.effects = effects;
    this.group = new THREE.Group();
    this.town = null;
    this.version = -1;
    this.pieces = [];    // per building: { sig, wall, plain } (packed), so a hit rebuilds only what changed
    this.groundStamp = 0;
    this.lampsStale = false;
    this.walls = STYLES.map((S, i) => {
      const m = new THREE.MeshStandardMaterial({ map: windowTexture(i), vertexColors: true, roughness: S.roughness, metalness: S.metalness });
      if (look.lit.value > 0) { m.emissiveMap = glows[i]; m.emissive.set('#ffffff'); m.emissiveIntensity = 1.6 * look.lit.value; }   // Dusk and Night: lit windows
      addFogShade(m, `cityWall${i}`);
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
      mesh.castShadow = mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    });
    const plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    addFogShade(plain, 'cityPlain');
    this.plain = new THREE.Mesh(new THREE.BufferGeometry(), plain);
    this.plain.castShadow = this.plain.receiveShadow = true;
    this.group.add(this.plain);
    this.vehicleMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
    addFogShade(this.vehicleMaterial, 'cityCars');
    this.lampMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    // Street lights come on at Dusk and Night: the lamp heads (the light vertices) shine.
    this.lampMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uLit = look.lit;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uLit;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += step(0.5, vColor.g) * vec3(1.0, 0.8, 0.45) * uLit * 2.2;');
    };
    addFogShade(this.lampMaterial, 'cityLamps');
    this.vehicleGeo = { car: vehicleGeometry('car'), bus: vehicleGeometry('bus'), truck: vehicleGeometry('truck') };
    this.lampGeo = lampGeometry();
    this.cars = {};      // kind -> { mesh, list: [vehicle index] }
    this.lamps = null;
    this.burning = new Set();
    this.debris = new Debris();
    this.group.add(this.debris.mesh);
    this.falls = new Falls(this.group);
    this.groundAt = (x, z) => (this.town ? this.town.terrain.heightAt(x, z) : 0);
  }

  dispose() {
    this.falls.clear();
    this.debris.dispose();
    for (const w of this.walls) { w.geometry.dispose(); w.material.dispose(); }
    this.plain.geometry.dispose();
    this.plain.material.dispose();
    this.clearTraffic();
    if (this.lamps) { this.group.remove(this.lamps); this.lamps.dispose(); }
    for (const g of Object.values(this.vehicleGeo)) g.dispose();
    this.lampGeo.dispose();
    this.vehicleMaterial.dispose();
    this.lampMaterial.dispose();
    this.group.removeFromParent();
  }

  clearTraffic() {
    for (const c of Object.values(this.cars)) { this.group.remove(c.mesh); c.mesh.dispose(); }
    this.cars = {};
    this.burning.clear();
  }

  // Called every frame, with the game's time step.
  update(dt = 1 / 60) {
    const town = this.game.town;
    this.group.visible = !!town;
    if (!town) { this.town = null; return; }
    if (town !== this.town) {
      this.town = town;
      this.version = -1;
      this.pieces = [];
      this.debris.clear();
      this.falls.clear();
      this.setTraffic(town.traffic);
    }
    if (town.version !== this.version) {
      this.version = town.version;
      this.rebuild(town);
    } else if (this.lampsStale) this.placeLamps(town);
    this.syncTraffic(town.traffic);
    this.falls.update(dt);
    this.debris.update(dt, this.groundAt);
  }

  // ---- buildings ----

  // The ground moved (a crater or a mound): heaps of rubble and lamps sit on
  // it, so lay them again.
  groundMoved() {
    if (!this.town) return;
    this.groundStamp++;
    if (this.town.buildings.some((b) => b.collapsed || b.lost)) this.version = -1;
    this.lampsStale = true;
  }

  rebuild(town) {
    const walls = STYLES.map(() => []);
    const plain = [];
    for (const b of town.buildings) {
      const sig = b.collapsed ? `c${this.groundStamp}` : `${b.lost ? b.cells.map((v) => (v > 0 ? 1 : 0)).join('') + 'g' + this.groundStamp : 'whole'}|${b.hits.length}`;
      let q = this.pieces[b.id];
      if (!q || q.sig !== sig) {
        // It just came down: show it falling, as it stood, into its rubble.
        if (b.collapsed && q && q.sig[0] !== 'c') this.fallDown(b, q);
        const W = new Batch(true), B = new Batch();
        this.building(W, B, b, town.terrain);
        q = this.pieces[b.id] = { sig, wall: W.pack(), plain: B.pack(), tall: b.top - b.base };
      }
      if (q.wall.p.length) walls[b.style].push(q.wall);
      plain.push(q.plain);
    }
    STYLES.forEach((_, i) => {
      const old = this.walls[i].geometry;
      this.walls[i].geometry = join(walls[i], true);
      old.dispose();
    });
    const old = this.plain.geometry;
    this.plain.geometry = join(plain, false);
    old.dispose();
    this.placeLamps(town);
  }

  // One building into W (its walls) and B (everything else).
  building(W, plain, b, t) {
    const rng = makeRng(b.seed);
    const S = STYLES[b.style];
    const tint = TINTS[b.tint % TINTS.length];
    const wallCol = rgb(S.wall, 1, tint);
    if (b.collapsed) { this.rubble(plain, b, rng, wallCol, t); return; }
    const y0 = b.base - 3;
    const y1 = b.base + b.floors * CITY.floor;
    const shade = [tint[0], tint[1], tint[2]];
    const low = [tint[0] * 0.72, tint[1] * 0.72, tint[2] * 0.72];
    const u0 = rng.int(0, TILE - 1) / TILE, v0 = rng.int(0, TILE - 1) / TILE;
    const vOf = (y) => v0 + (y - b.base) / CITY.floor / TILE;
    if (b.lost) { this.chunked(W, plain, b, S, tint, wallCol, u0, vOf, low, shade); this.spill(plain, b, t, wallCol); return; }
    const ground = b.base + CITY.floor;
    // Four walls, each from the corner it starts at along U; the ground floor darker.
    const sides = [
      [b.x + b.hx, b.z + b.hz, 0, -2 * b.hz],
      [b.x - b.hx, b.z - b.hz, 0, 2 * b.hz],
      [b.x - b.hx, b.z + b.hz, 2 * b.hx, 0],
      [b.x + b.hx, b.z - b.hz, -2 * b.hx, 0],
    ];
    for (const [ox, oz, ux, uz] of sides) {
      const len = Math.hypot(ux, uz) / BAY / TILE;
      W.face(ox, y0, oz, ux, 0, uz, 0, ground - y0, 0, low, [u0, vOf(y0), u0 + len, vOf(ground)]);
      if (y1 > ground) W.face(ox, ground, oz, ux, 0, uz, 0, y1 - ground, 0, shade, [u0, vOf(ground), u0 + len, vOf(y1)]);
    }
    if (!b.broken) this.roof(plain, b, rng, S, tint, y1);
    else this.brokenTop(plain, b, rng, wallCol, y1);
    // Scars where blasts struck the walls, while the wall there still stands.
    for (const [face, along, up, size] of b.hits) {
      if (b.base + up + size * 0.5 > y1) continue;
      this.scar(plain, b, face, along, b.base + up, size);
    }
    // Awnings over the shops.
    if (b.floors0 <= 3 && b.style === 2 && rng.next() < 0.7) {
      const col = rgb(AWNINGS[rng.int(0, AWNINGS.length - 1)]);
      const alongX = b.hx > b.hz;
      for (const sgn of [-1, 1]) {
        if (alongX) plain.box(b.x, b.base + 2.9, b.z + sgn * (b.hz + 0.8), b.hx - 0.6, 0.18, 0.8, col);
        else plain.box(b.x + sgn * (b.hx + 0.8), b.base + 2.9, b.z, 0.8, 0.18, b.hz - 0.6, col);
      }
    }
  }

  roof(B, b, rng, S, tint, y1) {
    const cap = rgb(S.cap, 1, tint);
    const roof = rgb(ROOF, 0.9 + rng.next() * 0.2);
    B.box(b.x, y1 - 0.2, b.z, b.hx, 0.3, b.hz, roof);
    const p = CITY.parapet, w = 0.3;
    B.box(b.x, y1, b.z + b.hz - w, b.hx, p, w, cap);
    B.box(b.x, y1, b.z - b.hz + w, b.hx, p, w, cap);
    B.box(b.x + b.hx - w, y1, b.z, w, p, b.hz - 2 * w, cap);
    B.box(b.x - b.hx + w, y1, b.z, w, p, b.hz - 2 * w, cap);
    const spot = (m = 2) => [b.x + rng.range(-1, 1) * Math.max(0, b.hx - m), b.z + rng.range(-1, 1) * Math.max(0, b.hz - m)];
    const top = y1 + 0.1;
    // Air conditioning boxes.
    for (let k = rng.int(1, 3); k > 0; k--) {
      const [x, z] = spot(2.5);
      B.box(x, top, z, 0.9, 1.1, 0.7, rgb('#b9bcbf', 0.9 + rng.next() * 0.15), rng.next() < 0.5 ? 0 : Math.PI / 2);
    }
    if (b.floors0 >= 7) {
      // A stair hut and an antenna or two on the towers.
      const [hx, hz] = spot(4);
      B.box(hx, top, hz, 1.8, 2.8, 1.6, rgb('#8d8a84'));
      for (let k = rng.int(1, 2); k > 0; k--) {
        const [x, z] = spot(1.5);
        const h = rng.range(4, 9);
        B.box(x, top, z, 0.12, h, 0.12, rgb('#4a4d52'));
        B.box(x, top + h * 0.6, z, 0.6, 0.08, 0.06, rgb('#4a4d52'));
      }
    } else if (b.floors0 >= 3 && rng.next() < (b.style === 2 ? 0.75 : 0.35)) {
      // A wooden water tower on legs.
      const [x, z] = spot(3);
      const legs = rgb('#3f3a35');
      for (const [a, c] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) B.box(x + a * 1.1, top, z + c * 1.1, 0.1, 2.4, 0.1, legs);
      B.box(x, top + 1.2, z, 1.2, 0.08, 1.2, legs);
      B.prism(x, top + 2.4, z, 1.6, 1.6, 2.8, 8, rgb('#7a5a3c'));
      B.prism(x, top + 5.2, z, 1.75, 0, 1.1, 8, rgb('#4b3d32'));
    }
  }

  // A floor open to the sky, broken wall stubs round its edge and rubble on it.
  brokenTop(B, b, rng, wallCol, y1) {
    B.box(b.x, y1 - 0.25, b.z, b.hx, 0.3, b.hz, rgb(SLAB, 0.85 + rng.next() * 0.2));
    const dark = [wallCol[0] * 0.8, wallCol[1] * 0.8, wallCol[2] * 0.8];
    const edges = [[b.hx, 0, b.hz, 0], [-b.hx, 0, b.hz, 0], [0, b.hz, b.hx, 1], [0, -b.hz, b.hx, 1]];
    for (const [ex, ez, half, alongX] of edges) {
      let s = -half;
      while (s < half - 0.5) {
        const w = Math.min(half - s, rng.range(1.2, 4));
        const h = rng.next() < 0.3 ? 0 : rng.range(0.4, CITY.floor * 0.9);
        if (h > 0) {
          const m = s + w / 2;
          if (alongX) B.box(b.x + m, y1, b.z + ez - Math.sign(ez) * 0.25, w / 2, h, 0.25, dark);
          else B.box(b.x + ex - Math.sign(ex) * 0.25, y1, b.z + m, 0.25, h, w / 2, dark);
        }
        s += w;
      }
    }
    for (let k = rng.int(3, 7); k > 0; k--) {
      const x = b.x + rng.range(-0.8, 0.8) * b.hx, z = b.z + rng.range(-0.8, 0.8) * b.hz;
      const r = rng.range(0.4, 1.3);
      B.box(x, y1, z, r, r * rng.range(0.5, 1.2), r * rng.range(0.6, 1.2), rng.next() < 0.5 ? dark : rgb('#77736b'), rng.range(0, 3));
    }
  }

  // ---- a damaged building, chunk by chunk ----

  chunked(W, B, b, S, tint, wallCol, u0, vOf, low, shade) {
    const F = CITY.floor, per = b.nx * b.nz, cells = b.cells, n = cells.length;
    let topWhole = true;
    for (let k = n - per; k < n; k++) if (cells[k] <= 0) topWhole = false;
    const dark = [wallCol[0] * 0.8, wallCol[1] * 0.8, wallCol[2] * 0.8];
    const inside = rgb(INSIDE);
    for (let k = 0; k < n; k++) {
      if (cells[k] <= 0) continue;
      chunkBox(b, k, BX);
      const rng = makeRng(b.seed + k * 7919 + 13);   // its own, so its broken edges keep their shape
      const band = (k / per) | 0, c = k % per, ix = c % b.nx, iz = (c / b.nx) | 0;
      const x0 = BX[0], x1 = BX[1], z0 = BX[4], z1 = BX[5];
      const f0 = band * b.bf, f1 = Math.min(f0 + b.bf, b.floors0);
      const y0 = band ? b.base + f0 * F : b.base - 3, y1 = b.base + f1 * F;
      // Sides +x, -x, +z, -z: does each face out of the building, and which chunk is next door?
      const out = [b.nx === 1 || ix === 1, b.nx === 1 || ix === 0, b.nz === 1 || iz === 1, b.nz === 1 || iz === 0];
      const next = [k + 1, k - 1, k + b.nx, k - b.nx];
      const plane = [x1, x0, z1, z0];
      for (let side = 0; side < 4; side++) {
        const a0 = side < 2 ? z0 : x0, a1 = side < 2 ? z1 : x1;
        if (out[side]) this.facade(W, b, side, plane[side], a0, a1, y0, y1, u0, vOf, low, shade);
        else if (cells[next[side]] <= 0) {
          // Open to where its neighbour was. Do its two ends meet an outer wall?
          const e0 = side < 2 ? out[3] : out[1], e1 = side < 2 ? out[2] : out[0];
          this.openSide(B, b, side, plane[side], a0, a1, band ? y0 : b.base, y1, f0, f1, e0, e1, rng, wallCol, inside);
        }
      }
      if (f1 === b.floors0) { if (!topWhole) this.chunkRoof(B, S, tint, rng, x0, x1, z0, z1, y1, out); }
      else if (cells[k + per] <= 0) this.cap(B, rng, x0, x1, z0, z1, y1, out, dark);
      if (band && cells[k - per] <= 0) this.underside(B, rng, x0, x1, z0, z1, y0, dark, inside);
    }
    if (topWhole) this.roof(B, b, makeRng(b.seed + 5), S, tint, b.base + b.floors0 * F);
    // Scars where blasts struck the walls, where that wall still stands.
    for (const [face, along, up, size] of b.hits) {
      const y = b.base + up;
      const x = face === 0 ? b.x + b.hx - 0.3 : face === 1 ? b.x - b.hx + 0.3 : b.x + along;
      const z = face === 2 ? b.z + b.hz - 0.3 : face === 3 ? b.z - b.hz + 0.3 : b.z + along;
      if (this.town.solid(b, x, z, y) && this.town.solid(b, x, z, y + size * 0.45)) this.scar(B, b, face, along, y, size);
    }
  }

  // A windowed wall on side 0..3 (+x, -x, +z, -z) at `p`, from a0 to a1
  // along it, y0 to y1: the windows line up with the whole building's.
  facade(W, b, side, p, a0, a1, y0, y1, u0, vOf, low, shade) {
    const L = BAY * TILE, ground = b.base + CITY.floor;
    let ox, oz, ux, uz, s0;
    if (side === 0) { ox = p; oz = a1; ux = 0; uz = a0 - a1; s0 = b.z + b.hz - a1; }
    else if (side === 1) { ox = p; oz = a0; ux = 0; uz = a1 - a0; s0 = a0 - (b.z - b.hz); }
    else if (side === 2) { ox = a0; oz = p; ux = a1 - a0; uz = 0; s0 = a0 - (b.x - b.hx); }
    else { ox = a1; oz = p; ux = a0 - a1; uz = 0; s0 = b.x + b.hx - a1; }
    const ua = u0 + s0 / L, ub = u0 + (s0 + a1 - a0) / L;
    if (y0 < ground) {
      const y = Math.min(y1, ground);
      W.face(ox, y0, oz, ux, 0, uz, 0, y - y0, 0, low, [ua, vOf(y0), ub, vOf(y)]);
    }
    if (y1 > ground) {
      const y = Math.max(y0, ground);
      W.face(ox, y, oz, ux, 0, uz, 0, y1 - y, 0, shade, [ua, vOf(y), ub, vOf(y1)]);
    }
  }

  // A plain quad on side 0..3 at p (+ off outwards), a0..a1 along it, ya..yb.
  plane(B, side, p, a0, a1, ya, yb, col, off = 0) {
    const h = yb - ya;
    if (side === 0) B.face(p + off, ya, a1, 0, 0, a0 - a1, 0, h, 0, col);
    else if (side === 1) B.face(p - off, ya, a0, 0, 0, a1 - a0, 0, h, 0, col);
    else if (side === 2) B.face(a0, ya, p + off, a1 - a0, 0, 0, 0, h, 0, col);
    else B.face(a1, ya, p - off, a0 - a1, 0, 0, 0, h, 0, col);
  }

  // A box poking `out` m out of side 0..3 at p, `half` either way of `along`, y up h.
  stick(B, side, p, along, half, y, h, out, col) {
    const c = (out - 0.1) / 2, w = (out + 0.1) / 2;
    if (side === 0) B.box(p + c, y, along, w, h, half, col);
    else if (side === 1) B.box(p - c, y, along, w, h, half, col);
    else if (side === 2) B.box(along, y, p + c, half, h, w, col);
    else B.box(along, y, p - c, half, h, w, col);
  }

  // Where a neighbouring chunk is gone: the dark inside, the floor slabs
  // broken off at different lengths, and the ragged ends of the outer walls.
  openSide(B, b, side, p, a0, a1, ya, y1, f0, f1, e0, e1, rng, wallCol, inside) {
    const F = CITY.floor;
    this.plane(B, side, p, a0, a1, ya, y1, inside);
    const slab = rgb(SLAB, 0.85 + rng.next() * 0.2);
    for (let f = Math.max(f0, 1); f <= f1; f++) {
      const y = b.base + f * F;
      for (let s = a0; s < a1 - 0.3;) {
        const w = Math.min(a1 - s, rng.range(1.2, 3.5));
        if (rng.next() < 0.8) this.stick(B, side, p, s + w / 2, w / 2, y - 0.3, 0.3, rng.range(0.15, 1.0), slab);
        s += w;
      }
    }
    for (const [on, a, dir] of [[e0, a0, 1], [e1, a1, -1]]) {
      if (!on) continue;
      for (let f = f0; f < f1; f++) {
        const y = b.base + f * F;
        const k = 0.75 + rng.next() * 0.3;
        const col = [wallCol[0] * k, wallCol[1] * k, wallCol[2] * k];
        const h = rng.range(0.4, 1) * F;
        this.stick(B, side, p, a + dir * 0.2, 0.2, y, h, rng.range(0.4, 1.8), col);
        if (h < F * 0.9) this.stick(B, side, p, a + dir * 0.2, 0.2, y + h, F - h, rng.range(0.1, 0.6), col);
      }
    }
  }

  // The top of a chunk whose upper neighbour is gone: an open floor, stubs of
  // the outer walls, a few lumps of rubble.
  cap(B, rng, x0, x1, z0, z1, y1, out, dark) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    B.box(cx, y1 - 0.25, cz, hx, 0.3, hz, rgb(SLAB, 0.85 + rng.next() * 0.2));
    const edges = [[out[0], x1, false, -1], [out[1], x0, false, 1], [out[2], z1, true, -1], [out[3], z0, true, 1]];
    for (const [on, e, alongX, inward] of edges) {
      if (!on) continue;
      const lo = alongX ? x0 : z0, hi = alongX ? x1 : z1;
      for (let s = lo; s < hi - 0.4;) {
        const w = Math.min(hi - s, rng.range(1.2, 4));
        const h = rng.next() < 0.3 ? 0 : rng.range(0.4, CITY.floor * 0.9);
        if (h > 0) {
          if (alongX) B.box(s + w / 2, y1, e + inward * 0.25, w / 2, h, 0.25, dark);
          else B.box(e + inward * 0.25, y1, s + w / 2, 0.25, h, w / 2, dark);
        }
        s += w;
      }
    }
    for (let k = rng.int(1, 3); k > 0; k--) {
      const r = rng.range(0.4, 1.2);
      B.box(cx + rng.range(-0.7, 0.7) * hx, y1, cz + rng.range(-0.7, 0.7) * hz, r, r * rng.range(0.5, 1.1), r * rng.range(0.6, 1.2), rng.next() < 0.5 ? dark : rgb('#77736b'), rng.range(0, 3));
    }
  }

  // Rubble in the street below each quadrant that lost chunks, over the heap
  // core/city.js raised there.
  spill(B, b, t, wallCol) {
    const per = b.nx * b.nz, grey = rgb('#7c776f');
    const dark = [wallCol[0] * 0.75, wallCol[1] * 0.75, wallCol[2] * 0.75];
    for (let c = 0; c < per; c++) {
      let gone = 0;
      for (let k = c; k < b.cells.length; k += per) if (b.cells[k] <= 0) gone++;
      if (!gone) continue;
      const rng = makeRng(b.seed + c * 104729 + 3);
      const ix = c % b.nx, iz = (c / b.nx) | 0;
      let ox = b.nx > 1 ? (ix ? 1 : -1) : 0, oz = b.nz > 1 ? (iz ? 1 : -1) : 0;
      if (!ox && !oz) { if (rng.next() < 0.5) ox = rng.next() < 0.5 ? -1 : 1; else oz = rng.next() < 0.5 ? -1 : 1; }
      chunkBox(b, c, BX);
      const hx = ox ? b.x + ox * (b.hx + 2) : (BX[0] + BX[1]) / 2;
      const hz = oz ? b.z + oz * (b.hz + 2) : (BX[4] + BX[5]) / 2;
      const spread = Math.min(5, 2 + gone * 0.8);
      for (let k = Math.min(14, 4 + gone * 2); k > 0; k--) {
        const x = hx + rng.range(-1, 1) * (ox ? spread * 0.6 : (BX[1] - BX[0]) / 2);
        const z = hz + rng.range(-1, 1) * (oz ? spread * 0.6 : (BX[5] - BX[4]) / 2);
        const r = rng.range(0.5, 1.8);
        const pick = rng.next();
        B.box(x, t.heightAt(x, z) - r * 0.4, z, r, r * rng.range(0.35, 0.9), r * rng.range(0.5, 1.1), pick < 0.45 ? wallCol : pick < 0.8 ? grey : dark, rng.range(0, 3));
      }
    }
  }

  // The underside of a chunk hanging over a gap, with bits hanging off it.
  underside(B, rng, x0, x1, z0, z1, y0, dark, inside) {
    B.face(x0, y0, z0, x1 - x0, 0, 0, 0, 0, z1 - z0, rgb(SLAB, 0.6));
    for (let k = rng.int(2, 4); k > 0; k--) {
      const h = rng.range(0.3, 1.4);
      B.box(rng.range(x0 + 0.5, x1 - 0.5), y0 - h, rng.range(z0 + 0.5, z1 - 0.5), rng.range(0.3, 1.1), h, rng.range(0.3, 1.1), rng.next() < 0.5 ? dark : inside, rng.range(0, 3));
    }
  }

  // The roof of one top chunk, its parapet along the outer edges.
  chunkRoof(B, S, tint, rng, x0, x1, z0, z1, y1, out) {
    const cap = rgb(S.cap, 1, tint);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    B.box(cx, y1 - 0.2, cz, hx, 0.3, hz, rgb(ROOF, 0.9 + rng.next() * 0.2));
    const p = CITY.parapet, w = 0.3;
    if (out[0]) B.box(x1 - w, y1, cz, w, p, hz, cap);
    if (out[1]) B.box(x0 + w, y1, cz, w, p, hz, cap);
    if (out[2]) B.box(cx, y1, z1 - w, hx, p, w, cap);
    if (out[3]) B.box(cx, y1, z0 + w, hx, p, w, cap);
    if (hx > 2.5 && hz > 2.5 && rng.next() < 0.6) B.box(cx + rng.range(-0.5, 0.5) * hx, y1 + 0.1, cz + rng.range(-0.5, 0.5) * hz, 0.9, 1.1, 0.7, rgb('#b9bcbf', 0.9 + rng.next() * 0.15));
  }

  // ---- things coming down (render/cityFx.js) ----

  // A building's wall colour, slab grey and a darker wall: debris colours.
  colours(b) {
    const wall = rgb(STYLES[b.style].wall, 1, TINTS[b.tint % TINTS.length]);
    return [wall, rgb('#7c776f'), [wall[0] * 0.7, wall[1] * 0.7, wall[2] * 0.7]];
  }

  // A building that gave way: it drops into its rubble as it stood (piece q),
  // shedding blocks and dust off its top as it goes.
  fallDown(b, q) {
    const meshes = [];
    if (q.wall.p.length) meshes.push(new THREE.Mesh(join([q.wall], true), this.walls[b.style].material));
    meshes.push(new THREE.Mesh(join([q.plain], false), this.plain.material));
    const cols = this.colours(b);
    const fx = this.effects;
    let n = 0;
    this.falls.collapse(meshes, b, q.tall, (it, y) => {
      if (y < b.base - 1) return;
      for (let k = 0; k < 3; k++) {
        const side = (Math.random() * 4) | 0, s = Math.random() * 2 - 1;
        const ox = side === 0 ? 1 : side === 1 ? -1 : 0, oz = side === 2 ? 1 : side === 3 ? -1 : 0;
        const x = b.x + (ox ? ox * b.hx : s * b.hx), z = b.z + (oz ? oz * b.hz : s * b.hz);
        this.debris.throw(x, y, z, ox * (2 + Math.random() * 6), 1 + Math.random() * 3, oz * (2 + Math.random() * 6), 0.7 + Math.random() * 1.4, cols[k]);
      }
      if (fx && n++ % 9 === 4) fx.dust([b.x + (Math.random() - 0.5) * b.hx, y - 2, b.z + (Math.random() - 0.5) * b.hz], Math.max(b.hx, b.hz) * 0.7);
    });
  }

  // A stack of chunks that lost its footing (chunk ids `ks`, bottom first)
  // topples outwards into the street and breaks up as it lands.
  topple(b, ks, from) {
    const F = CITY.floor, per = b.nx * b.nz;
    const tint = TINTS[b.tint % TINTS.length];
    const shade = [tint[0], tint[1], tint[2]], low = [tint[0] * 0.72, tint[1] * 0.72, tint[2] * 0.72];
    const rng = makeRng(b.seed);   // as building() draws it, so the windows match
    const u0 = rng.int(0, TILE - 1) / TILE, v0 = rng.int(0, TILE - 1) / TILE;
    const vOf = (y) => v0 + (y - b.base) / F / TILE;
    const W = new Batch(true), P = new Batch();
    let ya = Infinity, yb = -Infinity;
    for (const k of ks) {
      chunkBox(b, k, BX);
      const band = (k / per) | 0, f0 = band * b.bf, f1 = Math.min(f0 + b.bf, b.floors0);
      const y0 = b.base + f0 * F, y1 = b.base + f1 * F;
      const plane = [BX[1], BX[0], BX[5], BX[4]];
      for (let side = 0; side < 4; side++) this.facade(W, b, side, plane[side], side < 2 ? BX[4] : BX[0], side < 2 ? BX[5] : BX[1], y0, y1, u0, vOf, low, shade);
      ya = Math.min(ya, y0);
      yb = Math.max(yb, y1);
    }
    const x0 = BX[0], x1 = BX[1], z0 = BX[4], z1 = BX[5];
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    P.box(cx, yb - 0.3, cz, (x1 - x0) / 2, 0.5, (z1 - z0) / 2, rgb(SLAB, 0.8));
    P.face(x0, ya, z0, x1 - x0, 0, 0, 0, 0, z1 - z0, rgb(SLAB, 0.5));
    const c = ks[0] % per, ix = c % b.nx, iz = (c / b.nx) | 0;
    let ox = b.nx > 1 ? (ix ? 1 : -1) : 0, oz = b.nz > 1 ? (iz ? 1 : -1) : 0;
    if (!ox && !oz) { ox = Math.sign(b.x - from[0]) || 1; oz = Math.sign(b.z - from[2]); }
    const px = ox > 0 ? x1 : ox < 0 ? x0 : cx, pz = oz > 0 ? z1 : oz < 0 ? z0 : cz;
    const meshes = [new THREE.Mesh(W.build(), this.walls[b.style].material), new THREE.Mesh(P.build(), this.plain.material)];
    const cols = this.colours(b);
    const len = yb - ya, l = Math.hypot(ox, oz);
    this.falls.topple(meshes, px, ya, pz, [ox, oz], () => {
      // It breaks up where it lands, along the street.
      for (let k = Math.min(40, 10 + Math.round(len * 0.8)); k > 0; k--) {
        const t = 0.15 + Math.random() * 0.85;
        const x = px + (ox / l) * len * t + (Math.random() - 0.5) * (x1 - x0), z = pz + (oz / l) * len * t + (Math.random() - 0.5) * (z1 - z0);
        this.debris.throw(x, this.groundAt(x, z) + 1 + Math.random() * 3, z, (ox / l) * Math.random() * 5, 2 + Math.random() * 4, (oz / l) * Math.random() * 5, 0.8 + Math.random() * 1.6, cols[k % 3]);
      }
      const mx = px + (ox / l) * len * 0.5, mz = pz + (oz / l) * len * 0.5;
      this.effects?.dust([mx, this.groundAt(mx, mz), mz], Math.max(4, len * 0.4));
    });
  }

  // A blackened, ragged hole in a wall: [face, along, up] as core/city.js keeps them.
  scar(B, b, face, along, y, size) {
    const out = 0.06;
    const s = size, h = size * 0.9;
    const put = (k, col, off) => {
      if (face === 0) B.face(b.x + b.hx + off, y - h * k / 2, b.z + along + s * k / 2, 0, 0, -s * k, 0, h * k, 0, col);
      else if (face === 1) B.face(b.x - b.hx - off, y - h * k / 2, b.z + along - s * k / 2, 0, 0, s * k, 0, h * k, 0, col);
      else if (face === 2) B.face(b.x + along - s * k / 2, y - h * k / 2, b.z + b.hz + off, s * k, 0, 0, 0, h * k, 0, col);
      else B.face(b.x + along + s * k / 2, y - h * k / 2, b.z - b.hz - off, -s * k, 0, 0, 0, h * k, 0, col);
    };
    put(1, rgb(SCAR, 1.6), out);
    put(0.55, rgb('#141110'), out + 0.03);
  }

  // A building that came down: a heap of slabs and chunks over its mound, a wall stub or two.
  rubble(B, b, rng, wallCol, t) {
    const n = Math.min(34, 10 + Math.round((b.hx * b.hz) / 25));
    const grey = rgb('#7c776f');
    const dark = [wallCol[0] * 0.75, wallCol[1] * 0.75, wallCol[2] * 0.75];
    for (let k = 0; k < n; k++) {
      const x = b.x + rng.range(-1, 1) * (b.hx + 1.5), z = b.z + rng.range(-1, 1) * (b.hz + 1.5);
      const r = rng.range(0.6, 2.4);
      const y = t.heightAt(x, z) - r * 0.4;
      const pick = rng.next();
      B.box(x, y, z, r, r * rng.range(0.35, 0.9), r * rng.range(0.5, 1.1), pick < 0.45 ? wallCol : pick < 0.8 ? grey : dark, rng.range(0, 3));
    }
    for (let k = rng.int(1, 2); k > 0; k--) {
      const sx = rng.next() < 0.5 ? -1 : 1, sz = rng.next() < 0.5 ? -1 : 1;
      const x = b.x + sx * (b.hx - 1.5), z = b.z + sz * (b.hz - 1.5);
      B.box(x, t.heightAt(x, z) - 1, z, rng.range(1, 2.5), rng.range(3, 6.5), 0.35, wallCol, rng.range(-0.2, 0.2) + (rng.next() < 0.5 ? 0 : Math.PI / 2));
    }
  }

  // ---- street lights ----

  // One light midway along each block's length of street, on alternate
  // sides, unless a blast took it out.
  placeLamps(town) {
    this.lampsStale = false;
    const t = town.terrain;
    const spots = [];
    const off = CITY.street / 2 - 0.9;
    const gone = (x, z) => town.holes.some(([hx, hz, r]) => Math.hypot(x - hx, z - hz) < r + 1);
    let side = 1;
    for (const x of town.xs) {
      for (let j = 0; j + 1 < town.zs.length; j++) {
        side = -side;
        const z = (town.zs[j] + town.zs[j + 1]) / 2;
        spots.push([x + side * off, z, side > 0 ? Math.PI : 0]);
      }
    }
    for (const z of town.zs) {
      for (let i = 0; i + 1 < town.xs.length; i++) {
        side = -side;
        const x = (town.xs[i] + town.xs[i + 1]) / 2;
        spots.push([x, z + side * off, side > 0 ? Math.PI / 2 : -Math.PI / 2]);
      }
    }
    if (!this.lamps || this.lamps.count !== spots.length) {
      if (this.lamps) { this.group.remove(this.lamps); this.lamps.dispose(); }
      this.lamps = new THREE.InstancedMesh(this.lampGeo, this.lampMaterial, spots.length);
      this.group.add(this.lamps);
    }
    spots.forEach(([x, z, rot], i) => {
      if (gone(x, z)) { this.lamps.setMatrixAt(i, HIDDEN); return; }
      DUMMY.position.set(x, t.heightAt(x, z), z);
      DUMMY.rotation.set(0, rot, 0);
      DUMMY.scale.set(1, 1, 1);
      DUMMY.updateMatrix();
      this.lamps.setMatrixAt(i, DUMMY.matrix);
    });
    this.lamps.instanceMatrix.needsUpdate = true;
    this.lamps.computeBoundingSphere();
  }

  // ---- traffic ----

  setTraffic(traffic) {
    this.clearTraffic();
    if (!traffic) return;
    const lists = { car: [], bus: [], truck: [] };
    traffic.vehicles.forEach((v, i) => lists[v.kind].push(i));
    for (const kind of Object.keys(lists)) {
      const list = lists[kind];
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(this.vehicleGeo[kind], this.vehicleMaterial, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // they roam the whole town
      list.forEach((vi, k) => mesh.setColorAt(k, COL.set(PAINT[kind][traffic.vehicles[vi].tint % PAINT[kind].length])));
      mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.cars[kind] = { mesh, list, wrecked: new Set() };
    }
  }

  syncTraffic(traffic) {
    if (!traffic) return;
    for (const kind of Object.keys(this.cars)) {
      const { mesh, list, wrecked } = this.cars[kind];
      const tall = kind === 'car' ? 1.8 : 3.3;
      for (let k = 0; k < list.length; k++) {
        const v = traffic.vehicles[list[k]];
        DUMMY.position.set(v.x, v.y, v.z);
        if (v.alive) DUMMY.rotation.set(0, -v.heading, 0, 'YXZ');
        else {
          // A wreck lies on whatever ground is left under it (the blast dug a crater).
          DUMMY.position.y = this.town.terrain.heightAt(v.x, v.z) + (v.flipped ? tall : 0);
          DUMMY.rotation.set(v.flipped ? Math.PI : 0, -v.heading, 0.1, 'YXZ');
          if (!wrecked.has(k)) {
            wrecked.add(k);
            mesh.setColorAt(k, WRECK);
            mesh.instanceColor.needsUpdate = true;
            if (v.burn > 0) {
              const key = `veh${list[k]}`;
              this.effects?.burn(key, v.x, DUMMY.position.y - (v.flipped ? tall * 0.4 : -tall * 0.6), v.z, { flame: 0.75, smoke: 0.85, ttl: v.burn, size: kind === 'car' ? 0.9 : 1.3, spread: kind === 'car' ? 1 : 2.4, flameFor: v.burn * 0.6 });
              this.effects?.ignite(key, 3);
            }
          }
        }
        DUMMY.scale.set(1, 1, 1);
        DUMMY.updateMatrix();
        mesh.setMatrixAt(k, DUMMY.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- what happens to a building (core/city.js events) ----

  event(e) {
    if (e.type === 'terrain') { this.groundMoved(); return; }
    const fx = this.effects;
    if (!fx || e.type !== 'building') return;
    if (e.how === 'hit') {
      fx.dust(e.pos, 3);
      fx.rubble(e.pos, 6, 3);
    } else if (e.how === 'chunks') {
      // Chunks blown out throw blocks away from the blast; stacks that lost
      // their footing topple (the building itself is redrawn without them).
      const b = this.game.town?.buildings[e.id];
      if (!b) return;
      const cols = this.colours(b);
      for (const k of e.lost) {
        chunkBox(b, k, BX);
        if (BX[2] < b.base) BX[2] = b.base;
        const vol = (BX[1] - BX[0]) * (BX[3] - BX[2]) * (BX[5] - BX[4]);
        this.debris.burst(BX, Math.min(16, 5 + Math.round(vol / 150)), cols, e.pos, 11, 1.1);
        if (k === e.lost[0] || k === e.lost[e.lost.length - 1]) fx.dust([(BX[0] + BX[1]) / 2, BX[2], (BX[4] + BX[5]) / 2], 4);
      }
      fx.rubble(e.pos, 8 + e.lost.length * 3, 4);
      const per = b.nx * b.nz, stacks = new Map();
      for (const k of e.fell) {
        if (!stacks.has(k % per)) stacks.set(k % per, []);
        stacks.get(k % per).push(k);
      }
      for (const ks of stacks.values()) this.topple(b, ks, e.pos);
    } else if (e.how === 'collapse') {
      const [x, y, z] = e.pos;
      const [hx, hz] = e.size;
      const r = Math.max(hx, hz);
      for (let k = 0; k < 4; k++) fx.dust([x + (k % 2 ? hx : -hx) * 0.6, y + (e.tall * k) / 5, z + (k > 1 ? hz : -hz) * 0.6], r * 0.8);
      fx.dust([x, y + 2, z], r * 1.4);
      fx.rubble([x, y + e.tall * 0.4, z], 40, r);
    }
  }
}
