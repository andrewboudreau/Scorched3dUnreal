import * as THREE from 'three';
import { GRAVITY } from '../core/ballistics.js';
import { PULL_THRESHOLD, pullLevel, wellAccel, wellReach, stepLevel } from '../core/gravityPull.js';

// Flux lines for gravity wells, drawn only while a shell is being pulled by
// one (more than PULL_THRESHOLD of g) and faded out once it leaves.
//
// Two kinds of line, both thin, additive and dashed so they flow toward the
// moon:
//  - a FIELD per well: spokes bowing in from far out to the moon's surface,
//    brightest near the moon and dying away where the pull drops below the
//    threshold. Built once per well (set) and only its uniforms change after.
//  - TETHERS per (well, shell) pair: a few curves from the shell to the moon,
//    bunched at the shell and bulging out between, so you can see the pull
//    acting on that shell. One shared dynamic buffer, rewritten in place.
// Other gravity sources (a mod's orbiting wells, same {x, y, z, r, mu} shape)
// go through update's `extraWells`; their field objects come from a small
// pool and follow the well. Give such a well a stable identity (the same
// object, or an `id`) so its lines keep fading rather than restarting.

const SPOKES = 14;       // field lines per well
const SEG = 12;          // segments per field line
const TETHERS = 5;       // lines from a shell to a well
const TSEG = 12;         // segments per tether
const MAX_PAIRS = 8;     // (well, shell) pairs drawn at once
const MAX_EXTRA = 6;     // moving wells drawn at once
const COOL = new THREE.Color('#7fdcff');
const WARM = new THREE.Color('#b79cff');

const DASH_FRAG = `
  varying float vAlong; varying float vA;
  uniform float uTime; uniform vec3 uCool; uniform vec3 uWarm;
  void main() {
    float d = fract(vAlong * 6.0 - uTime * 0.55);
    float dash = smoothstep(0.0, 0.2, d) * (1.0 - smoothstep(0.5, 0.7, d));
    float a = vA * mix(0.15, 1.0, dash);
    gl_FragColor = vec4(mix(uCool, uWarm, vAlong), a);
  }`;

const lineMaterial = (vertexShader, uniforms) => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uCool: { value: COOL }, uWarm: { value: WARM }, ...uniforms },
  vertexShader,
  fragmentShader: DASH_FRAG,
});

// Unit-ball field lines: `position` is the spoke's direction, `along` runs
// 0 (far) to 1 (moon), `bend` is the sideways way the line bows.
function fieldGeometry() {
  const pts = SPOKES * (SEG + 1);
  const dir = new Float32Array(pts * 3);
  const bend = new Float32Array(pts * 3);
  const along = new Float32Array(pts);
  const index = [];
  const d = new THREE.Vector3();
  const b = new THREE.Vector3();
  const h = new THREE.Vector3();
  for (let i = 0; i < SPOKES; i++) {
    // Fibonacci sphere, so the spokes spread evenly in every direction.
    const y = 1 - (2 * (i + 0.5)) / SPOKES;
    const rr = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    d.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    h.set(0, 1, 0);
    if (Math.abs(y) > 0.9) h.set(1, 0, 0);
    b.crossVectors(d, h).normalize();
    h.crossVectors(d, b);
    const w = i * 1.7;
    b.multiplyScalar(Math.cos(w)).addScaledVector(h, Math.sin(w));   // each spoke bows its own way
    for (let j = 0; j <= SEG; j++) {
      const k = i * (SEG + 1) + j;
      dir.set([d.x, d.y, d.z], k * 3);
      bend.set([b.x, b.y, b.z], k * 3);
      along[k] = j / SEG;
      if (j < SEG) index.push(k, k + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(dir, 3));
  geo.setAttribute('bend', new THREE.BufferAttribute(bend, 3));
  geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
  geo.setIndex(index);
  return geo;
}

const FIELD_VERT = `
  attribute float along; attribute vec3 bend;
  uniform float uInner; uniform float uOuter; uniform float uMuG; uniform float uThr; uniform float uLevel;
  varying float vAlong; varying float vA;
  void main() {
    float rad = uInner * pow(uOuter / uInner, 1.0 - along);
    vec3 p = position * rad + bend * (sin(3.14159 * along) * uOuter * 0.10);
    float pull = uMuG / (rad * rad);
    vA = smoothstep(uThr * 0.5, uThr * 3.0, pull) * uLevel * 1.15;
    vAlong = along;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const TETHER_VERT = `
  attribute float along; attribute float lvl;
  varying float vAlong; varying float vA;
  void main() {
    vA = lvl * (0.55 + 0.45 * (1.0 - along));
    vAlong = along;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const _m = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _ring = new THREE.Vector3();
const _c = new THREE.Vector3();
const _b = new THREE.Vector3();

export class GravityLines {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.fieldGeo = fieldGeometry();
    this.fields = [];                 // one per terrain well
    this.extras = [];                 // pool for moving wells, grown on demand
    this.time = 0;
    this.stamp = 0;
    this.key = '';

    // The shared tether buffer.
    const per = TETHERS * (TSEG + 1);
    const pts = MAX_PAIRS * per;
    this.tPos = new Float32Array(pts * 3);
    this.tLvl = new Float32Array(pts);
    const along = new Float32Array(pts);
    const index = [];
    for (let p = 0; p < MAX_PAIRS; p++) {
      for (let l = 0; l < TETHERS; l++) {
        for (let j = 0; j <= TSEG; j++) {
          const k = p * per + l * (TSEG + 1) + j;
          along[k] = j / TSEG;
          if (j < TSEG) index.push(k, k + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    this.tPosAttr = new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.tLvlAttr = new THREE.BufferAttribute(this.tLvl, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.tPosAttr);
    geo.setAttribute('lvl', this.tLvlAttr);
    geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
    geo.setIndex(index);
    this.tetherMat = lineMaterial(TETHER_VERT, {});
    this.tethers = new THREE.LineSegments(geo, this.tetherMat);
    this.tethers.frustumCulled = false;   // the buffer is rewritten in world space
    this.tethers.renderOrder = 5;
    this.group.add(this.tethers);
    this.pairs = Array.from({ length: MAX_PAIRS }, () => ({
      active: false, field: null, id: -1, level: 0, target: 0, stamp: 0, sx: 0, sy: 0, sz: 0,
    }));
  }

  makeField() {
    const mat = lineMaterial(FIELD_VERT, {
      uInner: { value: 1 }, uOuter: { value: 2 }, uMuG: { value: 1 }, uThr: { value: PULL_THRESHOLD }, uLevel: { value: 0 },
    });
    const obj = new THREE.LineSegments(this.fieldGeo, mat);
    obj.frustumCulled = false;
    obj.visible = false;
    obj.renderOrder = 5;
    this.group.add(obj);
    return { obj, mat, key: null, x: 0, y: 0, z: 0, r: 1, mu: 0, level: 0, target: 0, stamp: 0 };
  }

  // Aim a field at a well (position, size, strength). Cheap: a few uniforms.
  place(f, w) {
    f.x = w.x; f.y = w.y; f.z = w.z; f.r = w.r; f.mu = w.mu;
    f.obj.position.set(w.x, w.y, w.z);
    const u = f.mat.uniforms;
    u.uInner.value = w.r * 1.06;
    u.uOuter.value = Math.max(w.r * 1.5, wellReach(w, PULL_THRESHOLD * 0.7));
    u.uMuG.value = w.mu / GRAVITY;
  }

  // The terrain's wells (or none): the fields are built here, once.
  set(wells = []) {
    const key = wells.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)},${w.r.toFixed(2)},${w.mu.toFixed(1)}`).join('|');
    if (key === this.key) return;
    this.key = key;
    for (const f of this.fields) { this.group.remove(f.obj); f.mat.dispose(); }
    this.fields = [];
    for (const p of this.pairs) { p.active = false; p.level = 0; }
    this.tLvl.fill(0);
    this.tLvlAttr.needsUpdate = true;
    for (const w of wells) {
      if (wellReach(w) <= 0) continue;   // too weak ever to show
      const f = this.makeField();
      this.place(f, w);
      this.fields.push(f);
    }
  }

  findExtra(key) {
    for (const f of this.extras) if (f.key === key) return f;
    return null;
  }

  // A pool field for a moving well, or null if all are busy.
  extraFor(w) {
    const key = w.id ?? w;
    let f = this.findExtra(key);
    if (f) return f;
    f = this.extras.find((e) => e.key === null);
    if (!f && this.extras.length < MAX_EXTRA) { f = this.makeField(); this.extras.push(f); }
    if (f) { f.key = key; f.level = 0; }
    return f;
  }

  // Note that a shell at `pos` (pr) is pulled by field f at `lvl`.
  engage(f, lvl, pr, pos) {
    const st = this.stamp;
    if (f.stamp !== st) { f.stamp = st; f.target = 0; }
    if (lvl > f.target) f.target = lvl;
    let slot = null;
    for (const p of this.pairs) {
      if (p.active && p.field === f && p.id === pr.id) { slot = p; break; }
      if (!slot && !p.active) slot = p;
    }
    if (!slot) return;
    if (!slot.active || slot.field !== f || slot.id !== pr.id) {
      slot.active = true; slot.field = f; slot.id = pr.id; slot.level = 0; slot.target = 0; slot.stamp = 0;
    }
    if (slot.stamp !== st) { slot.stamp = st; slot.target = 0; }
    if (lvl > slot.target) slot.target = lvl;
    slot.sx = pos[0]; slot.sy = pos[1]; slot.sz = pos[2];
  }

  // Every frame. `projectiles` is the game's live list; `extraWells` are
  // moving wells ({x, y, z, r, mu}, ideally with a stable `id`); `posOf(pr)`
  // says where to draw a shell, or null to leave it out (fog of war).
  update(dt, projectiles, extraWells = [], posOf = null) {
    this.time += dt;
    this.stamp++;
    for (const w of extraWells) {
      const f = this.findExtra(w.id ?? w);
      if (f) this.place(f, w);   // keep a moving well's field on it
    }
    for (const pr of projectiles) {
      if (pr.roller || pr.dead) continue;
      const pos = posOf ? posOf(pr) : pr.pos;
      if (!pos) continue;
      if (pr.wells) {
        for (const f of this.fields) {
          const lvl = pullLevel(wellAccel(f, pos[0], pos[1], pos[2]) / GRAVITY);
          if (lvl > 0) this.engage(f, lvl, pr, pos);
        }
      }
      for (const w of extraWells) {
        if (w.owner != null && w.owner === pr.owner) continue;   // an orbiter spares its owner's shells
        const lvl = pullLevel(wellAccel(w, pos[0], pos[1], pos[2]) / GRAVITY);
        if (lvl <= 0) continue;
        const f = this.extraFor(w);
        if (f) { this.place(f, w); this.engage(f, lvl, pr, pos); }
      }
    }
    this.advance(dt);
  }

  advance(dt) {
    const st = this.stamp;
    let any = false;
    const step = (f) => {
      f.level = stepLevel(f.level, f.stamp === st ? f.target : 0, dt);
      f.mat.uniforms.uLevel.value = f.level;
      f.mat.uniforms.uTime.value = this.time;
      f.obj.visible = f.level > 0.002;
      if (f.obj.visible) any = true;
    };
    this.fields.forEach(step);
    for (const f of this.extras) {
      step(f);
      // A pool field frees once it has faded and no tether still hangs on it.
      if (!f.obj.visible && f.stamp !== st && !this.pairs.some((p) => p.active && p.field === f)) f.key = null;
    }

    let dirty = false;
    for (let i = 0; i < MAX_PAIRS; i++) {
      const p = this.pairs[i];
      if (!p.active) continue;
      p.level = stepLevel(p.level, p.stamp === st ? p.target : 0, dt);
      if (p.level <= 0 && p.stamp !== st) {
        p.active = false;
        const per = TETHERS * (TSEG + 1);
        this.tLvl.fill(0, i * per, (i + 1) * per);
      } else {
        this.writeTethers(i, p);
        any = true;
      }
      dirty = true;
    }
    if (dirty) { this.tPosAttr.needsUpdate = true; this.tLvlAttr.needsUpdate = true; }
    this.tetherMat.uniforms.uTime.value = this.time;
    this.group.visible = any;
  }

  // Curves from the shell to the moon: bunched round the shell, bulging out
  // between, spread over the moon's facing side.
  writeTethers(slotIx, p) {
    const f = p.field;
    _m.set(f.x, f.y, f.z);
    _s.set(p.sx, p.sy, p.sz);
    _u.subVectors(_m, _s);
    const D = Math.max(_u.length(), 0.01);
    _u.multiplyScalar(1 / D);
    _b.set(0, 1, 0);
    if (Math.abs(_u.y) > 0.9) _b.set(1, 0, 0);
    _e1.crossVectors(_u, _b).normalize();
    _e2.crossVectors(_u, _e1);
    const per = TETHERS * (TSEG + 1);
    const rho = 0.7 + 0.012 * D;                 // spread at the shell
    const alpha = 0.85;                          // spread over the moon's face
    for (let l = 0; l < TETHERS; l++) {
      const th = (l / TETHERS) * Math.PI * 2 + this.time * 0.45;
      _ring.copy(_e1).multiplyScalar(Math.cos(th)).addScaledVector(_e2, Math.sin(th));
      const sx = _s.x + _ring.x * rho, sy = _s.y + _ring.y * rho, sz = _s.z + _ring.z * rho;
      const k1 = f.r * Math.cos(alpha), k2 = f.r * Math.sin(alpha);
      const ex = _m.x - _u.x * k1 + _ring.x * k2;
      const ey = _m.y - _u.y * k1 + _ring.y * k2;
      const ez = _m.z - _u.z * k1 + _ring.z * k2;
      const bulge = 0.22 * D;
      _c.set((sx + ex) / 2 + _ring.x * bulge, (sy + ey) / 2 + _ring.y * bulge, (sz + ez) / 2 + _ring.z * bulge);
      for (let j = 0; j <= TSEG; j++) {
        const t = j / TSEG, q = 1 - t;
        const k = slotIx * per + l * (TSEG + 1) + j;
        this.tPos[k * 3] = q * q * sx + 2 * q * t * _c.x + t * t * ex;
        this.tPos[k * 3 + 1] = q * q * sy + 2 * q * t * _c.y + t * t * ey;
        this.tPos[k * 3 + 2] = q * q * sz + 2 * q * t * _c.z + t * t * ez;
        this.tLvl[k] = p.level * 1.2;
      }
    }
  }

  dispose() {
    for (const f of [...this.fields, ...this.extras]) { this.group.remove(f.obj); f.mat.dispose(); }
    this.fields = []; this.extras = [];
    this.tethers.geometry.dispose(); this.tetherMat.dispose(); this.fieldGeo.dispose();
    this.group.parent?.remove(this.group);
  }
}
