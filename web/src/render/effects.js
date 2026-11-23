import * as THREE from 'three';
import { sceneryStandIns } from './sceneryMesh.js';
import { loadAtlas } from './fxAtlas.js';

// Short-lived visual effects: fireballs, debris, smoke, shell trails, and the
// small fires that keep burning on craters, hurt tanks and wrecks.
//
// Everything is pooled sprites (no real lights beyond the three flash lights),
// with counts capped by the effects quality: 'full', or 'light' for phones.

const FLASHES = 3;        // explosion lights that can glow at once
const DEBRIS_MAX = 240;   // debris chunks in the air at once
const EMBERS_MAX = 160;   // glowing sparks in the air at once

// What each quality level allows. `puffs` scales smoke counts, `billows` is
// the fire sprites in a blast, `embers` scales sparks; the caps bound sprites
// alive at once for burning things and shell trails; `gap` is metres between
// trail puffs; `clumps` is the flame clumps one fire may have, `clumpCap` all of them, `flames` the
// overlapping tongues in a clump.
export const QUALITY = {
  full: { puffs: 1, billows: 4, embers: 1, fireCap: 90, trailCap: 40, gap: 3.2, emitters: 24, ring: 6, debris: 1, clumps: 3, clumpCap: 14, flames: 4 },
  light: { puffs: 0.55, billows: 2, embers: 0.45, fireCap: 34, trailCap: 16, gap: 6, emitters: 10, ring: 3, debris: 0.6, clumps: 2, clumpCap: 6, flames: 3 },
};
export const QUALITY_KEY = 'craterfall.fxQuality';
// Phones (and ?mobile=1) start on Light; anything chosen in Settings wins.
export function readQuality() {
  try {
    const v = globalThis.localStorage?.getItem(QUALITY_KEY);
    if (v in QUALITY) return v;
  } catch { /* private mode */ }
  const phone = /[?&]mobile=1/.test(globalThis.location?.search || '') || !!globalThis.matchMedia?.('(pointer: coarse)').matches;
  return phone ? 'light' : 'full';
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// A fireball cooling: white-yellow, orange, dull red, out. `k` runs 0..1.
const FIRE_STOPS = [new THREE.Color('#fff2c4'), new THREE.Color('#ffa43a'), new THREE.Color('#cf4a14'), new THREE.Color('#4a1608')];
function fireColor(out, k) {
  const f = clamp01(k) * (FIRE_STOPS.length - 1);
  const i = Math.min(FIRE_STOPS.length - 2, Math.floor(f));
  return out.copy(FIRE_STOPS[i]).lerp(FIRE_STOPS[i + 1], f - i);
}
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const rnd = (a, b) => a + Math.random() * (b - a);
let TRAIL_FX = null;      // the Effects that shell trails borrow (set by its constructor)
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- procedural flames ----

const hash1 = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
function vnoise(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash1(i * 7.13 + seed) * (1 - u) + hash1((i + 1) * 7.13 + seed) * u;
}
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// A soft teardrop of fire drawn from scratch (no sprite sheet): a wide rounded
// base that tapers to a ragged, swaying tip, noise licks cut into its edges, a
// deep red edge into an orange core, and yellow only low in the core. Never
// pure white. Its base is the bottom edge of the image.
function flameTexture(seed) {
  const W = 96, H = 144;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H;                              // 0 at the base, 1 at the tip
    const base = v < 0.2 ? Math.sqrt(Math.max(0, 1 - ((0.2 - v) / 0.2) ** 2)) : 1;
    let hw = 0.86 * base * Math.pow(1 - v, 0.8);
    hw *= 0.74 + 0.5 * vnoise(v * 7, seed);                   // licks along the edge
    const cx = 0.3 * v * v * (vnoise(v * 2.4, seed + 9) * 2 - 1);   // the tip leans
    for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * 2 - 1;
      const d = Math.abs(u - cx) / Math.max(hw, 0.001);
      if (hw < 0.02 || d >= 1) continue;
      const e = 1 - d;                                        // 0 at the edge, 1 along the middle
      const a = smooth(0, 0.5, e) * (1 - 0.35 * v * v);
      const core = Math.pow(e, 1.1);
      const hot = Math.min(1, core * Math.pow(1 - v, 1.6) * 1.2);
      let r = 205 + 50 * core, gr = 52 + 100 * core, b = 14 + 16 * core;
      r += (255 - r) * hot; gr += (205 - gr) * hot; b += (80 - b) * hot;
      const j = (y * W + x) * 4;
      img.data[j] = r; img.data[j + 1] = gr; img.data[j + 2] = b; img.data[j + 3] = 255 * a;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const FLAME_ASPECT = 1.4;      // a flame is this much taller than it is wide

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.time = 0;
    this.wind = [0, 0];                 // main.js keeps this at the game's wind
    this.damp = 0;                      // 0..1, rain (render/rain.js amount): craters smoulder shorter
    this.setQuality(readQuality());
    this.live = { fire: 0, trail: 0 };  // sprites alive per capped kind
    this.emitters = new Map();          // things that keep burning
    this.heat = new Map();              // key -> time a hit keeps it burning until
    this.craters = 0;
    this.clumpCount = 0;                // flame clumps alive (each is three sprites)
    this.camera = null;                 // set by warm(); flames lean across the screen with the wind
    this.atlasReady = false;
    this.atlas = loadAtlas(undefined, () => { this.atlasReady = true; });
    TRAIL_FX = this;
    this.smokeTex = radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
    this.glowTex = radialTexture('rgba(255,240,200,1)', 'rgba(255,120,30,0)');
    this.flameTex = [3, 17, 41, 77].map(flameTexture);
    this.warpTex = radialTexture('rgba(235,252,255,1)', 'rgba(90,200,255,0)');
    this.fireGeo = new THREE.IcosahedronGeometry(1, 2);
    this.debrisGeo = new THREE.TetrahedronGeometry(0.6);
    // Explosion flashes come from a fixed pool of lights that never leaves
    // the scene. Adding or removing a light changes the light count, and
    // three then recompiles every lit material: a frozen second mid-shot.
    this.flashes = [];
    for (let i = 0; i < FLASHES; i++) {
      const light = new THREE.PointLight('#ffb060', 0, 10, 1.6);
      scene.add(light);
      this.flashes.push({ light, life: 0, max: 0, peak: 0 });
    }
    // Sprites (smoke, dust, glows) and fireballs are pooled: a finished one
    // goes back on a free list instead of being disposed, so a busy volley
    // makes no new materials and no garbage.
    this.freeSprites = [];
    this.freeFires = [];
    // Debris: every chunk of every explosion is one instance of a single
    // mesh, one draw call (and one shadow draw) however many are flying.
    this.debris = new THREE.InstancedMesh(this.debrisGeo, new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 1, flatShading: true }), DEBRIS_MAX);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debris.visible = false;
    scene.add(this.debris);
    this.chunks = [];
    this.prime = 0;
    // Embers: glowing sparks thrown from a blast, one additive Points draw.
    this.ember = { n: 0, p: new Float32Array(EMBERS_MAX * 3), c: new Float32Array(EMBERS_MAX * 3), v: new Float32Array(EMBERS_MAX * 3), life: new Float32Array(EMBERS_MAX), max: new Float32Array(EMBERS_MAX) };
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(this.ember.p, 3).setUsage(THREE.DynamicDrawUsage));
    eg.setAttribute('color', new THREE.BufferAttribute(this.ember.c, 3).setUsage(THREE.DynamicDrawUsage));
    eg.setDrawRange(0, 0);
    this.emberMat = new THREE.PointsMaterial({ size: 1.1, map: this.glowTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.embers = new THREE.Points(eg, this.emberMat);
    this.embers.frustumCulled = false;
    this.embers.visible = false;
    scene.add(this.embers);
    // Hidden stand-ins for the shader variants that come and go with shells
    // (missile skin, roller ball, exhaust, trails, probe beams). They never
    // render and are never disposed, which keeps those programs compiled
    // between shots; the warm-up compiles them before the match starts.
    this.keep = new THREE.Group();
    this.keep.visible = false;
    this.keep.add(
      new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
      new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false })),
      new THREE.Mesh(this.debrisGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true })),
      new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ color: '#fff2c4' })),
      new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })),
      new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
        new THREE.LineBasicMaterial({ transparent: true })),
    );
    this.keep.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
      new THREE.PointsMaterial({ map: this.glowTex, vertexColors: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    scene.add(this.keep);
  }

  setQuality(name) {
    this.quality = name in QUALITY ? name : 'full';
    this.q = QUALITY[this.quality];
    // Trim what is already burning down to the new limits.
    if (this.emitters) this.trimEmitters();
  }

  // A random cell of the sheet ('fire', 'flash', 'smokeDark',
  // 'smokeLight'); a plain soft blob until the sheet has loaded.
  pick(kind) {
    if (!this.atlasReady) return kind === 'smokeDark' || kind === 'smokeLight' ? this.smokeTex : this.glowTex;
    const a = this.atlas[kind];
    return a[Math.floor(Math.random() * a.length)];
  }

  // Compile every shader the scene can need (hidden objects included, with
  // the scene's lights in place) so nothing stalls on first use mid-match.
  // `compileAsync` lets the driver build them in parallel where it can.
  async warm(renderer, camera) {
    this.camera = camera;
    const g = new THREE.Group();
    g.visible = false;
    g.add(...sceneryStandIns());
    this.scene.add(g);
    // The shadow pass builds its depth shaders only when it draws: keep one
    // zero-size debris chunk in it for the first frames.
    this.prime = 3;
    try {
      await renderer.compileAsync(this.scene, camera);
    } finally {
      this.scene.remove(g);
    }
  }

  sprite(map, color, additive = false) {
    const sm = this.freeSprites.pop() || new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
    const m = sm.material;
    m.map = map;
    m.color.set(color);
    m.opacity = 0;
    m.rotation = 0;
    sm.center.set(0.5, 0.5);
    sm.visible = true;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    sm.scale.set(1, 1, 1);
    this.scene.add(sm);
    return sm;
  }

  // Queue a finished-when-`max` effect. `cap` ('fire' or 'trail') counts it
  // against that kind's limit until it is released.
  add(it, cap = null) {
    if (cap) { it.cap = cap; this.live[cap]++; }
    this.items.push(it);
    return it;
  }

  // Ground height under (x, z), or null when the game has not said yet.
  ground(x, z) { return this.groundAt ? this.groundAt(x, z) : null; }

  // A blast: a flash of light, a white-hot burst, a fireball (the low-poly
  // sphere with sprite billows round it), a ring of dust and a column of
  // smoke that lingers and leans with the wind, plus sparks and flying earth.
  // Everything scales with `radius`; a big weapon is a bigger, longer event.
  explosion(pos, radius) {
    const [x, y, z] = pos;
    const q = this.q;
    const size = Math.min(1.7, Math.max(0.55, radius / 12));       // 1 is a medium blast
    const gy = this.ground(x, z);
    const low = gy == null || y - gy < radius * 0.8 + 1;           // on the ground, not an air burst

    // Fireball.
    const fire = this.freeFires.pop() || new THREE.Mesh(this.fireGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const fireMat = fire.material;
    fireMat.color.set('#ffcc66');
    fireMat.opacity = 1;
    fire.position.set(x, y, z);
    fire.scale.setScalar(radius * 0.35);
    this.scene.add(fire);
    this.items.push({ life: 0, max: 0.55 + 0.1 * size, obj: fire, pool: this.freeFires, update: (it, t) => {
      const k = t / it.max;
      fire.scale.setScalar(radius * (0.35 + 0.9 * Math.sqrt(k)));
      fireMat.opacity = 1 - k;
      fireMat.color.setHSL(0.1 - 0.08 * k, 1, 0.65 - 0.35 * k);
    } });

    // Flash light, borrowed from the pool: the one that is dimmest now.
    let f = this.flashes[0];
    for (const c of this.flashes) if (c.light.intensity < f.light.intensity) f = c;
    f.life = 0; f.max = 0.45; f.peak = 40 * radius;
    f.light.distance = radius * 9;
    f.light.intensity = f.peak;
    f.light.position.set(x, y + radius * 0.4, z);

    // Glow sprite.
    const glow = this.sprite(this.glowTex, '#ffffff', true);
    glow.position.set(x, y + 1, z);
    glow.material.opacity = 1;
    glow.scale.setScalar(radius * 2.5);
    this.items.push({ life: 0, max: 0.6, obj: glow, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      glow.scale.setScalar(radius * 5 * (0.5 + k));
      glow.material.opacity = 1 - k;
    } });

    // White-hot burst: a ragged flash that blooms and is gone in a blink.
    const hot = this.sprite(this.pick('flash'), '#ffffff', true);
    hot.position.set(x, y + radius * 0.25, z);
    hot.material.rotation = rnd(0, 6.3);
    this.items.push({ life: 0, max: 0.22 + 0.1 * size, obj: hot, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      hot.scale.setScalar(radius * (2.2 + 2.2 * Math.sqrt(k)));
      hot.material.opacity = (1 - k) ** 1.6;
    } });

    // Fire billows round the sphere: the body of the fireball.
    const billows = Math.round(q.billows + (radius > 14 ? 1 : 0));
    for (let i = 0; i < billows; i++) {
      const b = this.sprite(this.pick('fire'), '#ffffff', true);
      const a = rnd(0, 6.3), r = radius * rnd(0.1, 0.45);
      b.position.set(x + Math.cos(a) * r, y + radius * rnd(0, 0.5), z + Math.sin(a) * r);
      b.material.rotation = rnd(0, 6.3);
      const spin = rnd(-0.8, 0.8), rise = rnd(1.5, 3.5) * (0.6 + size * 0.4);
      const from = radius * rnd(0.9, 1.3), to = radius * rnd(2.3, 3.2);
      const max = rnd(0.75, 1.2) * (0.75 + size * 0.35);
      this.items.push({ life: -i * 0.045, max, obj: b, pool: this.freeSprites, update: (it, t, dt) => {
        if (t < 0) return;
        const k = t / it.max;
        b.position.y += rise * dt * (1 - k);
        b.material.rotation += spin * dt;
        b.scale.setScalar(from + (to - from) * (1 - (1 - k) * (1 - k)));
        fireColor(b.material.color, k * 0.8);
        b.material.opacity = Math.min(1, t * 14) * (1 - k) ** 1.3 * 0.95;
      } });
    }

    // Debris chunks thrown out of the crater.
    const n = Math.min(Math.round(40 * q.debris), Math.round(radius * 1.6 * q.debris), DEBRIS_MAX - this.chunks.length);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = radius * (0.3 + Math.random() * 0.8);
      this.chunks.push({
        p: new THREE.Vector3(x, y + 0.5, z),
        v: new THREE.Vector3(Math.cos(a) * s, radius * (0.9 + Math.random() * 0.9), Math.sin(a) * s),
        rx: 0, ry: 0, sx: Math.random() * 8, sy: Math.random() * 8,
        scale: 0.4 + Math.random() * Math.min(1.4, radius * 0.05),
        life: 0, max: 2.2 + Math.random(),
      });
    }

    // Glowing embers: sparks that arc out, wink and fall.
    this.sparks(x, y + radius * 0.2, z, Math.round((5 + radius * 1.1) * q.embers), radius);

    // A low ring of dust pushed out along the ground.
    if (low) {
      const ring = Math.round(q.ring * Math.min(1.5, size + 0.3));
      for (let i = 0; i < ring; i++) {
        const sm = this.sprite(this.pick('smokeLight'), '#a68b69');
        const a = (i / ring) * 6.28 + rnd(-0.3, 0.3);
        const dx = Math.cos(a), dz = Math.sin(a), out = radius * rnd(0.9, 1.5);
        const px = x + dx * radius * 0.3, pz = z + dz * radius * 0.3;
        sm.position.set(px, (gy ?? y) + 1, pz);
        sm.material.rotation = rnd(0, 6.3);
        const max = rnd(1.5, 2.3);
        this.items.push({ life: 0, max, obj: sm, pool: this.freeSprites, update: (it, t) => {
          const k = t / it.max, e = 1 - (1 - k) * (1 - k);
          sm.position.x = px + dx * out * e + this.wind[0] * 0.8 * t;
          sm.position.z = pz + dz * out * e + this.wind[1] * 0.8 * t;
          sm.position.y = (this.ground(sm.position.x, sm.position.z) ?? y) + 1 + 2.5 * e;
          sm.scale.setScalar(radius * (0.7 + 0.9 * k));
          sm.material.opacity = Math.min(1, t * 6) * 0.42 * (1 - k) ** 1.4;
        } });
      }
    }

    // Smoke column: it rises 3 to 6 s, thins as it grows and leans with the
    // wind more the higher it gets. A small blast (flak) gets a few puffs, so
    // a dozen at once stay cheap.
    const puffs = Math.max(4, Math.min(13, Math.round((2 + radius * 0.7) * q.puffs)));
    const stay = 2.4 + Math.min(3.2, radius * 0.17);
    for (let i = 0; i < puffs; i++) {
      const dark = Math.random() < 0.4;
      const sm = this.sprite(this.pick(dark ? 'smokeDark' : 'smokeLight'), dark ? '#f0e8e0' : '#a8a29b');
      const px = x + rnd(-0.5, 0.5) * radius * 0.7, pz = z + rnd(-0.5, 0.5) * radius * 0.7;
      sm.position.set(px, y + (i / puffs) * radius * 0.7, pz);
      sm.material.rotation = rnd(0, 6.3);
      const spin = rnd(-0.25, 0.25), rise = rnd(3, 5.5) + size * 1.5;
      const w = radius * rnd(0.9, 1.7);
      const peak = dark ? 0.62 : 0.5;
      this.items.push({ life: -i * 0.07, max: stay + rnd(0, 1.2), obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
        if (t < 0) return;
        const k = t / it.max;
        sm.position.y += rise * (1 - 0.7 * k) * dt;
        sm.position.x += this.wind[0] * 1.8 * (0.3 + k) * dt;
        sm.position.z += this.wind[1] * 1.8 * (0.3 + k) * dt;
        sm.material.rotation += spin * dt;
        sm.scale.setScalar(w * (0.5 + 1.6 * Math.sqrt(k)));
        sm.material.opacity = Math.min(1, t * 4) * peak * (1 - k) ** 1.3;
      } });
    }

    // The crater keeps smouldering after the blast.
    if (low && radius >= 5) {
      const wet = 1 - 0.55 * this.damp;   // rain puts them out sooner
      this.burn(`crater${this.craters++ % 64}`, x, (gy ?? y) + 0.3, z, {
        flame: Math.min(0.85, 0.2 + radius * 0.03) * (1 - 0.3 * this.damp), flameFor: (4 + radius * 0.4) * wet,
        smoke: 0.6, ttl: Math.min(18, 6 + radius * 0.6) * wet, size: Math.min(2.4, 0.8 + radius * 0.07),
        spread: Math.max(1.5, radius * 0.3), ground: true,
      });
    }
  }

  // ---- embers ----

  // `n` glowing sparks leaving (x, y, z), flung out and up and pulled down.
  sparks(x, y, z, n, radius) {
    const e = this.ember;
    n = Math.min(n, EMBERS_MAX - e.n);
    for (let i = 0; i < n; i++, e.n++) {
      const k = e.n, a = rnd(0, 6.283), s = radius * rnd(0.4, 1.3), j = k * 3;
      e.p[j] = x; e.p[j + 1] = y; e.p[j + 2] = z;
      e.v[j] = Math.cos(a) * s; e.v[j + 1] = radius * rnd(0.8, 2.0); e.v[j + 2] = Math.sin(a) * s;
      e.life[k] = 0; e.max[k] = rnd(0.9, 2.2);
    }
  }

  updateEmbers(dt) {
    const e = this.ember;
    let w = 0;
    for (let i = 0; i < e.n; i++) {
      const j = i * 3;
      e.life[i] += dt;
      if (e.life[i] >= e.max[i]) continue;
      e.v[j + 1] -= 9.81 * 0.7 * dt;
      e.v[j] += this.wind[0] * 0.5 * dt; e.v[j + 2] += this.wind[1] * 0.5 * dt;
      e.p[j] += e.v[j] * dt; e.p[j + 1] += e.v[j + 1] * dt; e.p[j + 2] += e.v[j + 2] * dt;
      const g = this.ground(e.p[j], e.p[j + 2]);
      if (g != null && e.p[j + 1] < g) continue;                     // landed
      const k = e.life[i] / e.max[i];
      const flick = 0.75 + 0.25 * Math.sin(this.time * 40 + i * 7);
      const o = w * 3;
      // Moving down the array: copy a survivor into its new slot.
      e.p[o] = e.p[j]; e.p[o + 1] = e.p[j + 1]; e.p[o + 2] = e.p[j + 2];
      e.v[o] = e.v[j]; e.v[o + 1] = e.v[j + 1]; e.v[o + 2] = e.v[j + 2];
      e.life[w] = e.life[i]; e.max[w] = e.max[i];
      const glow = (1 - k) * flick;
      e.c[o] = glow; e.c[o + 1] = glow * (0.55 - 0.3 * k); e.c[o + 2] = glow * 0.18;
      w++;
    }
    const was = e.n;
    e.n = w;
    this.embers.visible = w > 0;
    if (w > 0 || was > 0) {
      const g = this.embers.geometry;
      g.setDrawRange(0, w);
      g.attributes.position.needsUpdate = true;
      g.attributes.color.needsUpdate = true;
    }
  }

  // ---- things that keep burning ----

  // Start, or keep alive, a small fire: flames and a thin plume of smoke.
  // `key` names it (calling again moves it and renews it). Options:
  //   flame, smoke   0..1 how much of each
  //   ttl            seconds it lasts from now (it thins out over the last bit)
  //   size, spread   how big the flames are, and how far apart they start
  //   ground         follow the ground height under it (a crater)
  //   flameFor       seconds the flames last, dying down to embers (0: steady while kept alive)
  // A caller that keeps a fire going while some condition holds calls this
  // every frame with a short ttl; when the condition ends, so does the fire.
  burn(key, x, y, z, { flame = 0.5, smoke = 0.5, ttl = 1, size = 1, spread = 0.8, ground = false, fade = null, flameFor = 0 } = {}) {
    // A fresh hit (see ignite) lights it up whatever the caller says.
    const hot = (this.heat.get(key) ?? 0) - this.time;
    if (hot > 0) { flame = Math.max(flame, 0.2 + 0.4 * clamp01(hot / 2)); smoke = Math.max(smoke, 0.5); }
    if (flame <= 0.04 && smoke <= 0.04) { this.dropEmitter(key); return; }
    let e = this.emitters.get(key);
    if (!e) {
      if (this.emitters.size >= this.q.emitters) this.trimEmitters(1);
      e = { x, y, z, flame, smoke, size, spread, ground, until: 0, fade: 1, born: this.time, flameFor, clumps: null, smokeT: Math.random() * 0.5 };
      this.emitters.set(key, e);
    }
    e.x = x; e.y = y; e.z = z;
    e.flame = flame; e.smoke = smoke; e.size = size; e.spread = spread; e.ground = ground;
    e.until = Math.max(e.until, this.time + ttl);
    e.fade = fade ?? Math.min(ttl, 2.5);
  }

  dropEmitter(key) {
    const e = this.emitters.get(key);
    if (e) this.stopClumps(e);
    this.emitters.delete(key);
  }

  // Set `key`'s fire (see burn) going for `secs` from now, even if it is not
  // burning on its own: a tank that has just been hit.
  ignite(key, secs) {
    this.heat.set(key, Math.max(this.heat.get(key) ?? 0, this.time + secs));
  }

  // Keep at most the quality's limit, dropping the ones nearest to going out
  // (`room` leaves space for that many new ones).
  trimEmitters(room = 0) {
    const max = this.q.emitters - room;
    if (this.emitters.size <= max) return;
    const order = [...this.emitters].sort((a, b) => a[1].until - b[1].until);
    for (const [k] of order.slice(0, this.emitters.size - max)) this.dropEmitter(k);
  }

  // How much fire is burning near (x, y, z), 0 to about 1.5: it sets how loud
  // the crackle is. Distance is what thins it.
  fireLevel(x, y, z) {
    let sum = 0;
    for (const e of this.emitters.values()) {
      const left = clamp01((e.until - this.time) / e.fade);
      if (left <= 0) continue;
      const d = Math.hypot(e.x - x, e.y - y, e.z - z);
      sum += left * (e.flame * this.flameHeat(e) + e.smoke * 0.4) * e.size ** 0.5 / (1 + (d / 45) ** 2);
    }
    return Math.min(1.5, sum);
  }

  // 1 while a fire's flames are at full strength, falling to 0 as they die down.
  flameHeat(e) {
    return e.flameFor > 0 ? Math.sqrt(clamp01(1 - (this.time - e.born) / e.flameFor)) : 1;
  }

  updateEmitters(dt) {
    const q = this.q;
    const slow = this.quality === 'light' ? 1.7 : 1;      // Light: fewer, bigger gaps
    for (const [key, e] of this.emitters) {
      const left = clamp01((e.until - this.time) / e.fade);
      if (left <= 0) { this.dropEmitter(key); continue; }
      let y = e.y;
      if (e.ground) { const g = this.ground(e.x, e.z); if (g != null) y = g + 0.3; }
      const heat = this.flameHeat(e);
      if (e.flame > 0.04 && (heat > 0.02 || left > 0.02)) this.updateClumps(e, y, dt, left, heat);
      else if (e.clumps) this.stopClumps(e);
      const smoke = e.smoke * left;
      if (smoke > 0.04 && (e.smokeT -= dt) <= 0) {
        e.smokeT = rnd(0.7, 1.3) * 0.5 * slow / (0.25 + smoke);
        if (this.live.fire < q.fireCap) this.plume(e, y, smoke);
      }
    }
  }

  // ---- flame clumps ----

  stopClumps(e) {
    if (!e.clumps) return;
    for (const c of e.clumps) this.freeClump(c);
    this.clumpCount -= e.clumps.length;
    e.clumps = null;
  }

  freeClump(c) {
    for (const sp of [c.glow, ...c.flames.map((f) => f.sp)]) { this.scene.remove(sp); this.freeSprites.push(sp); }
  }

  // One clump of fire: a warm glow on the ground and a few flames overlapping
  // at slightly different sizes and leans. Each flame has its own pace, shape
  // (a few drawn variants swapped like the pages of a flipbook) and flicker,
  // so they never move together.
  newClump(e, index) {
    const a = rnd(0, 6.283), r = Math.sqrt(Math.random()) * e.spread;
    const cs = index === 0 ? rnd(0.95, 1.3) : rnd(0.55, 1.0);          // the first is the big one
    const flames = [];
    const n = this.q.flames;
    for (let k = 0; k < n; k++) {
      const sp = this.sprite(this.flameTex[0], '#ffffff', true);
      sp.center.set(0.5, 0.02);
      flames.push({
        sp, size: k === 0 ? 1 : rnd(0.5, 0.9), dx: k === 0 ? 0 : rnd(-0.5, 0.5) * cs, dz: k === 0 ? 0 : rnd(-0.5, 0.5) * cs,
        lean: k === 0 ? 0 : rnd(-0.3, 0.3), ph: rnd(0, 6.283), r1: rnd(5, 9), r2: rnd(14, 24), sway: rnd(1.2, 2.6),
        rate: rnd(3, 6), vi: Math.floor(Math.random() * 4), T: rnd(0, 0.3), flip: Math.random() < 0.5 ? -1 : 1,
      });
    }
    return {
      ox: Math.cos(a) * r, oz: Math.sin(a) * r, size: cs, t: rnd(0, 20), ph: rnd(0, 6.283), wispT: rnd(0.2, 0.9),
      flames, glow: this.sprite(this.glowTex, '#ff6a1a', true),
    };
  }

  updateClumps(e, y, dt, left, heat) {
    const q = this.q;
    const power = e.flame * left * heat;                 // 0..~1 how hot the flames are
    if (!e.clumps) e.clumps = [];
    // A hotter fire, a bigger one, has more clumps; they are added once and
    // go out one by one (the last made first) as the fire dies down.
    const want = Math.min(q.clumps, Math.max(1, Math.round(1 + e.size * 1.1 * (0.4 + e.flame * 1.4))));
    while (e.clumps.length > q.clumps) { this.freeClump(e.clumps.pop()); this.clumpCount--; }
    while (e.clumps.length < want && this.clumpCount < q.clumpCap && heat > 0.5) {
      e.clumps.push(this.newClump(e, e.clumps.length));
      this.clumpCount++;
    }
    // Which way the wind leans the flames on screen.
    let lean = 0;
    if (this.camera) {
      const m = this.camera.matrixWorld.elements;
      lean = -Math.max(-0.4, Math.min(0.4, (this.wind[0] * m[0] + this.wind[1] * m[2]) * 0.035));
    }
    const slow = this.quality === 'light' ? 1.5 : 1;
    for (let i = 0; i < e.clumps.length; i++) {
      const c = e.clumps[i];
      c.t += dt;
      const px = e.x + c.ox, pz = e.z + c.oz;
      const gy = e.ground ? (this.ground(px, pz) ?? y) + 0.1 : y;
      // How alive this clump is: later ones go out first.
      const s = clamp01(power * 2 - i * 0.14);
      // Embers: after the flames the ground keeps glowing a while.
      const ember = (1 - heat) * left * Math.min(1, e.flame * 2.2);
      const br = 0.84 + 0.16 * Math.sin(c.t * 13 + c.ph * 1.7);

      const g = c.glow;
      fireColor(g.material.color, 0.38 + 0.5 * (1 - s));
      const gs = Math.max(0.5, e.size * c.size * 3.2) * (0.9 + 0.1 * br);
      g.position.set(px, gy + gs * 0.3, pz);
      g.scale.setScalar(gs);
      g.material.opacity = (0.1 + 0.3 * s) * (0.8 + 0.2 * br) * left + ember * 0.3 * br;

      const on = s > 0.03;
      let topY = gy, topH = 0;
      for (const f of c.flames) {
        f.sp.visible = on;
        if (!on) continue;
        f.T -= dt;
        if (f.T <= 0) {
          f.T = (1 / f.rate) * slow * rnd(0.8, 1.2);
          f.vi = (f.vi + 1 + Math.floor(Math.random() * 3)) % 4;
          f.sp.material.map = this.flameTex[f.vi];
          if (Math.random() < 0.25) f.flip = -f.flip;
        }
        const flick = 1 + 0.15 * Math.sin(c.t * f.r1 + f.ph) + 0.09 * Math.sin(c.t * f.r2 + f.ph * 1.9);
        const H = 2.0 * e.size * c.size * f.size * (0.28 + 0.72 * s) * flick;
        const sway = lean + f.lean + 0.1 * Math.sin(c.t * f.sway + f.ph);
        f.sp.position.set(px + f.dx, gy, pz + f.dz);
        f.sp.scale.set((H / FLAME_ASPECT) * f.flip * (1 + 0.07 * Math.sin(c.t * f.r2 * 0.7 + f.ph)), H, 1);
        f.sp.material.rotation = sway;
        fireColor(f.sp.material.color, 0.24 + 0.45 * (1 - s));
        f.sp.material.opacity = Math.min(1, s * 1.8) * (0.42 + 0.16 * br) * (0.85 + 0.15 * Math.sin(c.t * f.r2 * 1.3 + f.ph));
        if (H > topH) { topH = H; topY = gy + H; }
      }

      // A thin wisp of smoke from the tip while the flames are lively.
      if (s > 0.25 && (c.wispT -= dt) <= 0) {
        c.wispT = rnd(0.5, 1.1) * slow / (0.4 + s);
        if (this.live.fire < q.fireCap) this.wisp(px + this.wind[0] * 0.25 + lean * -topH * 0.5, topY * 0.95 + gy * 0.05, pz + this.wind[1] * 0.25, 0.7 + 0.4 * e.size * c.size, s);
      }
    }
  }

  // A small puff of smoke that peels off a flame's tip, climbs and fades.
  wisp(x, y, z, size, s) {
    const sm = this.sprite(this.pick('smokeDark'), '#cfc7bf');
    sm.position.set(x, y, z);
    sm.material.rotation = rnd(0, 6.3);
    const rise = rnd(1.6, 2.6), max = rnd(1.6, 2.6);
    this.add({ life: 0, max, obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
      const k = t / it.max;
      sm.position.y += rise * (1 - 0.5 * k) * dt;
      sm.position.x += this.wind[0] * 1.6 * (0.3 + k) * dt;
      sm.position.z += this.wind[1] * 1.6 * (0.3 + k) * dt;
      sm.scale.setScalar(size * (0.5 + 1.6 * k));
      sm.material.opacity = Math.min(1, t * 4) * 0.3 * s * (1 - k) ** 1.2;
    } }, 'fire');
  }

  // A thin wisp of smoke that climbs, leans with the wind and fades.
  plume(e, y, power) {
    const dark = Math.random() < 0.7;
    const sm = this.sprite(this.pick(dark ? 'smokeDark' : 'smokeLight'), dark ? '#e6dfd8' : '#8f8982');
    const a = rnd(0, 6.28), r = Math.random() * e.spread * 0.6;
    sm.position.set(e.x + Math.cos(a) * r, y + 0.9 * e.size, e.z + Math.sin(a) * r);
    sm.material.rotation = rnd(0, 6.3);
    const s = e.size * rnd(1.3, 2.0);
    const rise = rnd(2, 3.2);
    const peak = (dark ? 0.5 : 0.38) * (0.5 + power * 0.5);
    this.add({ life: 0, max: rnd(2.6, 4.2), obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
      const k = t / it.max;
      sm.position.y += rise * (1 - 0.5 * k) * dt;
      sm.position.x += this.wind[0] * 1.8 * (0.3 + k) * dt;
      sm.position.z += this.wind[1] * 1.8 * (0.3 + k) * dt;
      sm.scale.setScalar(s * (0.7 + 2.2 * k));
      sm.material.opacity = Math.min(1, t * 3) * peak * (1 - k) ** 1.2;
    } }, 'fire');
  }

  // ---- shell trails ----

  // One puff of smoke left behind a shell in flight; it hangs, grows and fades
  // in about a second. Called by ShellVisual as the shell moves.
  trail(pos, color, scale = 1) {
    if (this.live.trail >= this.q.trailCap) return;
    const sm = this.sprite(this.pick('smokeLight'), color);
    sm.position.set(pos[0], pos[1], pos[2]);
    sm.material.rotation = rnd(0, 6.3);
    const s = rnd(1.1, 1.6) * scale;
    const max = rnd(1.0, 1.5);
    const dx = rnd(-0.6, 0.6), dy = rnd(0.2, 0.9), dz = rnd(-0.6, 0.6);
    this.add({ life: 0, max, obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
      const k = t / it.max;
      sm.position.x += (dx + this.wind[0] * 0.8) * dt; sm.position.y += dy * dt; sm.position.z += (dz + this.wind[1] * 0.8) * dt;
      sm.scale.setScalar(s * (0.6 + 1.6 * k));
      sm.material.opacity = Math.min(1, t * 10) * 0.4 * (1 - k) ** 1.5;
    } }, 'trail');
  }

  // Bits of a building thrown about as it breaks: a short, low spray.
  rubble(pos, n, spread) {
    n = Math.min(n, DEBRIS_MAX - this.chunks.length);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = spread * (0.3 + Math.random() * 0.7);
      this.chunks.push({
        p: new THREE.Vector3(pos[0] + Math.cos(a) * 2, pos[1] + 2 + Math.random() * 3, pos[2] + Math.sin(a) * 2),
        v: new THREE.Vector3(Math.cos(a) * s, 3 + Math.random() * spread, Math.sin(a) * s),
        rx: 0, ry: 0, sx: Math.random() * 6, sy: Math.random() * 6,
        scale: 0.35 + Math.random() * 0.55,
        life: 0, max: 2 + Math.random(),
      });
    }
  }

  dust(pos, radius) {
    for (let i = 0; i < 8; i++) {
      const sm = this.sprite(this.smokeTex, '#a08463');
      const a = (i / 8) * Math.PI * 2;
      sm.position.set(pos[0] + Math.cos(a) * radius * 0.6, pos[1] + 2, pos[2] + Math.sin(a) * radius * 0.6);
      sm.scale.setScalar(radius * 0.6);
      this.items.push({ life: 0, max: 2.5, obj: sm, pool: this.freeSprites, update: (it, t) => {
        const k = t / it.max;
        sm.position.y += 0.05;
        sm.scale.setScalar(radius * (0.6 + k));
        sm.material.opacity = 0.6 * (1 - k);
      } });
    }
  }

  // One soft puff that rises and thins out: exhaust, or smoke from a hurt tank.
  puff(pos, { color = '#6b6660', size = 1, life = 1.4, rise = 2.2, opacity = 0.45, drift = null } = {}) {
    const sm = this.sprite(this.smokeTex, color);
    sm.position.set(pos.x, pos.y, pos.z);
    sm.scale.setScalar(size * 0.7);
    const dx = (drift ? drift[0] : 0) + (Math.random() - 0.5) * 0.8;
    const dz = (drift ? drift[1] : 0) + (Math.random() - 0.5) * 0.8;
    this.items.push({ life: 0, max: life, obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
      const k = t / it.max;
      sm.position.x += dx * dt; sm.position.y += rise * dt; sm.position.z += dz * dt;
      sm.scale.setScalar(size * (0.7 + k * 1.9));
      sm.material.opacity = opacity * Math.min(1, t * 8) * (1 - k);
    } });
  }

  // A teleport: a bright flash that swells and fades, a ring of light that
  // opens out, and sparks that rise off the spot. Sprites only, no lights.
  warp(pos) {
    const [x, y, z] = pos;
    const core = this.sprite(this.warpTex, '#ffffff', true);
    core.position.set(x, y + 2.2, z);
    core.material.opacity = 1;
    this.items.push({ life: 0, max: 0.7, obj: core, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      core.scale.setScalar(5 + 9 * Math.sin(k * Math.PI) + 6 * k);
      core.material.opacity = (1 - k) ** 1.4;
    } });
    const halo = this.sprite(this.warpTex, '#7fdcff', true);
    halo.position.set(x, y + 1.2, z);
    this.items.push({ life: 0, max: 0.55, obj: halo, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      halo.scale.setScalar(6 + 26 * Math.sqrt(k));
      halo.material.opacity = 0.7 * (1 - k);
    } });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random();
      this.puff({ x: x + Math.cos(a) * 2.2, y: y + 0.6, z: z + Math.sin(a) * 2.2 }, { color: '#bfeaff', size: 0.9, life: 0.9, rise: 6 + Math.random() * 5, opacity: 0.9 });
    }
  }

  // Jump jets firing under a tank at `pos` (just the flame and a bit of smoke).
  jetFlame(pos) {
    this.puff(pos, { color: '#ffb347', size: 1.5, life: 0.45, rise: -3.5, opacity: 0.85 });
    this.puff(pos, { color: '#8d8982', size: 2.2, life: 1.1, rise: 0.6, opacity: 0.4 });
  }

  // A cannon firing: a bright flash and a drift of gun smoke.
  muzzleFlash(pos) {
    const glow = this.sprite(this.glowTex, '#ffffff', true);
    glow.position.set(...pos);
    glow.material.opacity = 1;
    glow.scale.setScalar(10);
    this.items.push({ life: 0, max: 0.25, obj: glow, pool: this.freeSprites, update: (it, t) => {
      glow.scale.setScalar(8 * (1 - t / it.max) + 2);
      glow.material.opacity = 1 - t / it.max;
    } });
    const hot = this.sprite(this.pick('flash'), '#ffe2a0', true);
    hot.position.set(...pos);
    hot.material.rotation = rnd(0, 6.3);
    this.items.push({ life: 0, max: 0.14, obj: hot, pool: this.freeSprites, update: (it, t) => {
      const k = t / it.max;
      hot.scale.setScalar(3 + 4 * Math.sqrt(k));
      hot.material.opacity = (1 - k) ** 1.5;
    } });
    const n = this.quality === 'light' ? 1 : 3;
    for (let i = 0; i < n; i++) {
      const sm = this.sprite(this.pick('smokeLight'), '#aaa39b');
      sm.position.set(pos[0], pos[1], pos[2]);
      sm.material.rotation = rnd(0, 6.3);
      const dx = rnd(-1.2, 1.2), dy = rnd(0.4, 1.4), dz = rnd(-1.2, 1.2), s = rnd(1.6, 2.6);
      this.items.push({ life: -i * 0.05, max: rnd(1.4, 2.2), obj: sm, pool: this.freeSprites, update: (it, t, dt) => {
        if (t < 0) return;
        const k = t / it.max;
        sm.position.x += (dx + this.wind[0] * 1.2) * dt; sm.position.y += dy * dt; sm.position.z += (dz + this.wind[1] * 1.2) * dt;
        sm.scale.setScalar(s * (0.5 + 1.8 * k));
        sm.material.opacity = Math.min(1, t * 8) * 0.34 * (1 - k) ** 1.4;
      } });
    }
  }

  update(dt) {
    this.time += dt;
    for (const f of this.flashes) {
      if (f.light.intensity <= 0) continue;
      f.life += dt;
      f.light.intensity = f.life >= f.max ? 0 : f.peak * (1 - f.life / f.max);
    }
    for (const it of this.items) {
      it.life += dt;
      it.update(it, it.life, dt);
    }
    let w = 0;
    for (const it of this.items) {
      if (it.life >= it.max) this.release(it);
      else this.items[w++] = it;
    }
    this.items.length = w;
    this.updateDebris(dt);
    this.updateEmbers(dt);
    this.updateEmitters(dt);
  }

  updateDebris(dt) {
    const was = this.debris.count;
    let w = 0;
    for (const c of this.chunks) {
      c.life += dt;
      if (c.life >= c.max) continue;
      c.v.y -= 9.81 * 1.6 * dt;
      c.p.addScaledVector(c.v, dt);
      c.rx += c.sx * dt; c.ry += c.sy * dt;
      if (this.groundAt) {
        const g = this.groundAt(c.p.x, c.p.z);
        if (c.p.y < g) {
          c.p.y = g;
          c.v.multiplyScalar(0.3); c.v.y = Math.abs(c.v.y) * 0.3; c.sx *= 0.5; c.sy *= 0.5;
        }
      }
      if (c.life > c.max - 0.5) c.scale *= 0.92;
      _e.set(c.rx, c.ry, 0);
      _q.setFromEuler(_e);
      _s.setScalar(c.scale);
      _m.compose(c.p, _q, _s);
      this.debris.setMatrixAt(w, _m);
      this.chunks[w++] = c;
    }
    this.chunks.length = w;
    if (w === 0 && this.prime > 0) {
      this.prime--;
      _m.makeScale(0, 0, 0);
      this.debris.setMatrixAt(0, _m);
      w = 1;
    }
    this.debris.count = w;
    this.debris.visible = w > 0;
    if (w > 0 || was > 0) this.debris.instanceMatrix.needsUpdate = true;
  }

  release(it) {
    if (it.cap) this.live[it.cap]--;
    this.scene.remove(it.obj);
    if (it.pool) it.pool.push(it.obj);
    else if (it.obj.material && !it.sharedMat) it.obj.material.dispose?.();
  }

  clear() {
    for (const it of this.items) this.release(it);
    this.items = [];
    this.chunks.length = 0;
    this.debris.count = 0;
    this.debris.visible = false;
    this.ember.n = 0;
    this.embers.visible = false;
    for (const e of this.emitters.values()) this.stopClumps(e);
    this.emitters.clear();
    this.heat.clear();
    for (const f of this.flashes) f.light.intensity = 0;
  }
}

// Missile parts, shared by every shell in flight. Built along +y (nose up),
// then turned to face the way the shell is travelling.
const MISSILE = (() => {
  const body = new THREE.CylinderGeometry(0.26, 0.3, 1.9, 8);
  const nose = new THREE.ConeGeometry(0.26, 0.7, 8).translate(0, 1.3, 0);
  const fin = new THREE.BoxGeometry(0.06, 0.55, 0.5).translate(0, -0.72, 0.42);
  const flame = new THREE.ConeGeometry(0.22, 0.9, 8).rotateX(Math.PI).translate(0, -1.4, 0);
  return { body, nose, fin, flame };
})();
const UP = new THREE.Vector3(0, 1, 0);
const SHELL_PARTS = new Map();
const _dir = new THREE.Vector3();

// A projectile: a small missile (a ball for rollers, which tumble along the
// ground) plus a fading trail. `probe` marks a rangefinder dart: slimmer, pale,
// no exhaust.
export class ShellVisual {
  constructor(scene, color, { ball = 0, probe = false } = {}) {
    this.scene = scene;
    // Materials (and ball geometry) are shared between shells of the same
    // look and never disposed: no per-shot material setup, no recompiles.
    const mat = (key, make) => {
      let m = SHELL_PARTS.get(key);
      if (!m) SHELL_PARTS.set(key, (m = make()));
      return m;
    };
    if (ball) {
      this.mesh = new THREE.Mesh(mat(`ballgeo${ball}`, () => new THREE.SphereGeometry(ball, 10, 8)), mat('ball', () => new THREE.MeshBasicMaterial({ color: '#fff2c4' })));
      this.isBall = true;
    } else {
      this.mesh = new THREE.Group();
      const skin = mat(`skin${probe}`, () => new THREE.MeshStandardMaterial({ color: probe ? '#eef6fa' : '#d4d9de', roughness: 0.5, metalness: 0.3, flatShading: true }));
      const paint = mat(`paint${probe ? 'probe' : color}`, () => new THREE.MeshStandardMaterial({ color: probe ? '#7fe3ff' : color, roughness: 0.6, flatShading: true, emissive: probe ? '#2a7d96' : '#000000' }));
      this.mesh.add(new THREE.Mesh(MISSILE.body, skin), new THREE.Mesh(MISSILE.nose, paint));
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Mesh(MISSILE.fin, paint);
        f.rotation.y = (k * Math.PI) / 2;
        this.mesh.add(f);
      }
      if (!probe) {
        this.flame = new THREE.Mesh(MISSILE.flame, mat('flame', () => new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
        this.mesh.add(this.flame);
      }
      this.mesh.scale.setScalar(probe ? 0.75 : 1.25);
      this.mesh.visible = false;      // until it knows which way it is pointing
    }
    this.last = null;
    this.trailAt = null;          // where the last smoke puff was left
    this.puffColor = new THREE.Color(color).lerp(new THREE.Color('#d9d4ce'), 0.7);
    this.smokes = !ball && !probe;
    this.max = 400;
    this.points = new Float32Array(this.max * 3);
    this.count = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.points, 3));
    g.setDrawRange(0, 0);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: probe ? '#9fe8ff' : color, transparent: true, opacity: probe ? 0.55 : 0.85 }));
    this.line.frustumCulled = false;
    scene.add(this.mesh, this.line);
  }

  // Face the missile along its path (from the last position it was given).
  aim(pos) {
    if (this.last && !this.isBall) {
      _dir.set(pos[0] - this.last[0], pos[1] - this.last[1], pos[2] - this.last[2]);
      if (_dir.lengthSq() > 1e-6) {
        this.mesh.quaternion.setFromUnitVectors(UP, _dir.normalize());
        this.mesh.visible = true;
      }
    }
    if (this.flame) this.flame.scale.set(1, 0.75 + Math.random() * 0.5, 1);
    this.last = [pos[0], pos[1], pos[2]];
  }

  push(pos) {
    this.aim(pos);
    this.mesh.position.set(...pos);
    if (this.count >= this.max) {
      this.points.copyWithin(0, 3);
      this.count = this.max - 1;
    }
    this.points.set(pos, this.count * 3);
    this.count++;
    // A short trail of smoke behind a shell, one puff every few metres.
    if (this.smokes && TRAIL_FX) {
      const t = this.trailAt;
      if (!t || Math.hypot(pos[0] - t[0], pos[1] - t[1], pos[2] - t[2]) >= TRAIL_FX.q.gap) {
        this.trailAt = [pos[0], pos[1], pos[2]];
        TRAIL_FX.trail(pos, this.puffColor);
      }
    }
    this.line.geometry.setDrawRange(0, this.count);
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  // Detach the trail so it can linger and fade after the shell is gone.
  finish() {
    this.scene.remove(this.mesh);
    this.line.material.opacity = Math.min(this.line.material.opacity, 0.35);
    return this.line;
  }
}
