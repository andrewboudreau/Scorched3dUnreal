import * as THREE from 'three';
import { CITY } from '../core/city.js';
import { makeRng } from '../core/rng.js';
import { addFogShade } from './terrainMesh.js';
import { look } from './timeofday.js';

// Draws the City (core/city.js): its buildings, their rooftops, the damage
// they have taken and the rubble of those that came down, the street lights
// and the traffic (core/traffic.js).
//
// Draw calls are few: the walls are merged into one mesh per facade style,
// each with a small canvas texture of windows (UVs count bays and storeys, so
// the windows line up with the floors); everything else that stands still
// (roofs, parapets, water towers, broken tops, scars, rubble) is one
// vertex-coloured mesh. Both are rebuilt only when the town changes (its
// `version`). Street lights are one InstancedMesh, and each kind of vehicle
// another, moved every frame.

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
  }

  dispose() {
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

  // Called every frame.
  update() {
    const town = this.game.town;
    this.group.visible = !!town;
    if (!town) { this.town = null; return; }
    if (town !== this.town) {
      this.town = town;
      this.version = -1;
      this.pieces = [];
      this.setTraffic(town.traffic);
    }
    if (town.version !== this.version) {
      this.version = town.version;
      this.rebuild(town);
    } else if (this.lampsStale) this.placeLamps(town);
    this.syncTraffic(town.traffic);
  }

  // ---- buildings ----

  // The ground moved (a crater or a mound): heaps of rubble and lamps sit on
  // it, so lay them again.
  groundMoved() {
    if (!this.town) return;
    this.groundStamp++;
    if (this.town.buildings.some((b) => b.collapsed)) this.version = -1;
    this.lampsStale = true;
  }

  rebuild(town) {
    const walls = STYLES.map(() => []);
    const plain = [];
    for (const b of town.buildings) {
      const sig = b.collapsed ? `c${this.groundStamp}` : `${b.floors}|${b.broken ? 1 : 0}|${b.hits.length}|${Math.round(b.hp)}`;
      let q = this.pieces[b.id];
      if (!q || q.sig !== sig) {
        const W = new Batch(true), B = new Batch();
        this.building(W, B, b, town.terrain);
        q = this.pieces[b.id] = { sig, wall: W.pack(), plain: B.pack() };
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
    } else if (e.how === 'floors') {
      fx.dust(e.pos, 5 + e.lost * 1.5);
      fx.rubble(e.pos, 10 + e.lost * 5, 5);
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
