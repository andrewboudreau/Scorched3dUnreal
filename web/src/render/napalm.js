import * as THREE from 'three';
import { NAPALM, BURN_TIME } from '../core/napalm.js';

// What Napalm and the Dirt Bomb look like (rules in core/napalm.js).
//
// Napalm: every vertex the fuel reached gets a flat, additive glow on the
// ground, shown when the fuel gets there (its `arrive` step), so the spill is
// seen running downhill; the glow flickers while it burns and fades when the
// game says the fire is out. All of them are instances of one quad, one draw
// call. Real flames (Effects.burn emitters) stand on the deepest pools only, a
// few per fire, and the scorch is the terrain's own scorch map.
// The Dirt Bomb: a "Buried" tag over each buried tank, and dust and clods when
// one digs itself out.

const GLOW_MAX = 900;    // glowing vertices at once, over all fires
const FADE = 1.6;        // s the glow takes to die once the fire is out
const LIFT = 0.25;       // m the glow floats over the ground

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _n = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const HOT = new THREE.Color('#ffb347');
const DIM = new THREE.Color('#c2410c');

function tagTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(40,28,18,0.82)';
  g.beginPath();
  g.roundRect(4, 6, 248, 52, 26);
  g.fill();
  g.strokeStyle = '#c9a26b';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#f3e2c4';
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class NapalmView {
  constructor(scene, effects) {
    this.scene = scene;
    this.effects = effects;
    this.fires = new Map();   // id -> { cells, t, out, flames }
    this.time = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    // Pulled toward the camera in depth so the glow lies on the ground without flickering into it.
    const mat = new THREE.MeshBasicMaterial({ map: effects.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.glow = new THREE.InstancedMesh(geo, mat, GLOW_MAX);
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glow.setColorAt(0, _c.set('#000'));
    this.glow.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 2;
    this.glow.count = 0;
    this.glow.visible = false;
    scene.add(this.glow);
    this.tagMat = new THREE.SpriteMaterial({ map: tagTexture('BURIED'), transparent: true, depthTest: false });
    this.tags = [];           // a sprite per player slot, made when first needed
  }

  // Game events, from main.js handleEvents.
  event(e) {
    const fx = this.effects;
    if (e.type === 'napalm') {
      if (e.doused || !e.cells.length) {
        // Hissing steam where it went into the water.
        for (let k = 0; k < 6; k++) {
          fx.puff({ x: e.pos[0] + (k % 3 - 1) * 2, y: e.pos[1] + 0.5, z: e.pos[2] + (k > 2 ? 2 : -2) },
            { color: '#e8eef2', size: 3, life: 1.8, rise: 4, opacity: 0.5 });
        }
        if (!e.cells.length) return;
      }
      // The flames go on the deepest pools, spread apart.
      const order = [...e.cells].sort((a, b) => b[3] - a[3]);
      const want = fx.quality === 'light' ? 3 : 5;
      const flames = [];
      for (const c of order) {
        if (flames.length >= want || c[3] < NAPALM.film * 0.8) break;
        if (flames.some((f) => Math.hypot(f.c[0] - c[0], f.c[2] - c[2]) < 7)) continue;
        flames.push({ c, lit: false, key: `napalm${e.id}.${flames.length}` });
      }
      this.fires.set(e.id, { cells: e.cells, t: 0, out: -1, flames, tilt: null, burn: e.burn || BURN_TIME });
    } else if (e.type === 'napalmOut') {
      const f = this.fires.get(e.id);
      if (f && f.out < 0) f.out = 0;
    } else if (e.type === 'dig') {
      fx.dust(e.pos, Math.max(5, e.radius * 0.6));
      fx.rubble(e.pos, 14, 5);
    } else if (e.type === 'buried') {
      fx.dust(e.pos, 7);
    }
  }

  update(dt, game) {
    this.time += dt;
    let n = 0;
    const lit = this.glow;
    for (const [id, f] of this.fires) {
      f.t += dt;
      if (f.out >= 0) f.out += dt;
      const fade = f.out < 0 ? 1 : 1 - f.out / FADE;
      if (fade <= 0) { this.fires.delete(id); continue; }
      const burning = f.out < 0;
      if (!f.tilt && game) f.tilt = f.cells.map(([x, , z]) => this.tilt(game.terrain, x, z));
      for (const fl of f.flames) {
        if (fl.lit || !burning || f.t < fl.c[4] * NAPALM.flowTime) continue;
        fl.lit = true;
        const [x, y, z, fuel] = fl.c;
        const big = Math.min(1, fuel / NAPALM.ref);
        this.effects.burn(fl.key, x, y, z, { flame: 0.55 + 0.4 * big, smoke: 0.55, ttl: Math.max(0.5, f.burn - f.t), size: 0.8 + 0.7 * big, spread: 1.6, ground: true, fade: 1 });
      }
      for (let c = 0; c < f.cells.length; c++) {
        const [x, y, z, fuel, arrive] = f.cells[c];
        if (n >= GLOW_MAX) break;
        const since = f.t - arrive * NAPALM.flowTime;
        if (since < 0) continue;
        const deep = Math.min(1, 0.25 + fuel / NAPALM.ref);
        // Each vertex flickers on its own phase; a new arrival flares up.
        const flick = 0.78 + 0.22 * Math.sin(this.time * 9 + x * 1.7 + z * 2.3);
        const k = deep * flick * fade * (0.8 + 0.6 * Math.max(0, 1 - since * 3));
        const size = 4.2 + 2.5 * deep;
        const q = f.tilt?.[c];
        if (q) _q.copy(q); else _q.setFromUnitVectors(Z, _n.set(0, 1, 0));
        _p.set(x, y + LIFT, z);
        _s.set(size, size, 1);
        lit.setMatrixAt(n, _m.compose(_p, _q, _s));
        lit.setColorAt(n, _c.copy(DIM).lerp(HOT, deep).multiplyScalar(k));
        n++;
      }
    }
    lit.count = n;
    lit.visible = n > 0;
    if (n) {
      lit.instanceMatrix.needsUpdate = true;
      lit.instanceColor.needsUpdate = true;
    }
    // The "Buried" tags.
    const players = game?.players ?? [];
    for (let i = 0; i < Math.max(players.length, this.tags.length); i++) {
      const p = players[i];
      let tag = this.tags[i];
      if (!p?.buried || !p.alive) { if (tag) tag.visible = false; continue; }
      if (!tag) {
        tag = this.tags[i] = new THREE.Sprite(this.tagMat);
        tag.scale.set(12, 3, 1);
        tag.renderOrder = 5;
        this.scene.add(tag);
      }
      const g = game.terrain.heightAt(p.x, p.z);
      tag.position.set(p.x, Math.max(g, p.y) + 7 + 0.4 * Math.sin(this.time * 2.5), p.z);
      tag.visible = true;
    }
  }

  // The turn that lays a quad flat on the ground at x/z.
  tilt(t, x, z) {
    const d = t.cell;
    _n.set(t.heightAt(x - d, z) - t.heightAt(x + d, z), 2 * d, t.heightAt(x, z - d) - t.heightAt(x, z + d)).normalize();
    return new THREE.Quaternion().setFromUnitVectors(Z, _n);
  }

  clear() {
    for (const f of this.fires.values()) for (const fl of f.flames) this.effects.dropEmitter(fl.key);
    this.fires.clear();
    this.glow.count = 0;
    this.glow.visible = false;
    for (const t of this.tags) if (t) t.visible = false;
  }
}
