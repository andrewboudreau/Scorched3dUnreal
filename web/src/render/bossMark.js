import * as THREE from 'three';
import { WEAPON_BY_ID } from '../core/weapons.js';

// The boss's telegraph, drawn (core/boss.js): while the Bulwark has a big shot
// marked, and while that shot is in the air, a red ring the size of its blast
// lies on the ground where it will fall, with crosshair ticks that turn slowly
// and a column of light standing on it so it shows from anywhere on the field.
//
// One per page (main.js): `update(game, time)` each frame follows the boss's
// state (p.boss.mark, then p.boss.firing), `clear` hides it at a match's end.

const COLOR = new THREE.Color('#ff4a3d');
const HEIGHT = 140;

export class BossMarkView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 6;
    const flat = (geo, opacity) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 6;
      return m;
    };
    // Unit sizes, scaled to the blast's radius.
    this.ring = flat(new THREE.RingGeometry(0.92, 1, 64), 0.85);
    this.fillDisc = flat(new THREE.CircleGeometry(0.92, 48), 0.12);
    this.ticks = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const t = flat(new THREE.PlaneGeometry(0.34, 0.05), 0.9);
      t.position.set(Math.cos(k * Math.PI / 2) * 0.7, 0, Math.sin(k * Math.PI / 2) * 0.7);
      t.rotation.z = -k * Math.PI / 2;
      this.ticks.add(t);
    }
    this.disc = new THREE.Group();
    this.disc.add(this.ring, this.fillDisc, this.ticks);
    // The column: a tall open cylinder, fading upwards.
    const geo = new THREE.CylinderGeometry(1, 1, HEIGHT, 24, 1, true);
    geo.translate(0, HEIGHT / 2, 0);
    const colors = [];
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const a = 1 - pos.getY(i) / HEIGHT;
      colors.push(a, a, a);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLOR, vertexColors: true, transparent: true, opacity: 0.32,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.group.add(this.disc, this.beam);
    scene.add(this.group);
    this.key = '';
  }

  update(game, time) {
    const b = game?.cfg.boss ? game.bossTank : null;
    const m = b?.alive ? (b.boss.mark || b.boss.firing) : null;
    if (!m) { this.group.visible = false; this.key = ''; return; }
    const key = `${m.weapon}:${m.x}:${m.z}`;
    if (key !== this.key) {
      this.key = key;
      const fx = (WEAPON_BY_ID[m.weapon]?.impact || [])[0];
      const r = Math.max(8, fx?.radius || 15);
      const y = game.terrain.heightAt(m.x, m.z);
      this.group.position.set(m.x, y + 0.6, m.z);
      this.disc.scale.setScalar(r);
      this.beam.scale.set(r * 0.12, 1, r * 0.12);
      this.born = time;
    }
    this.group.visible = true;
    const age = time - (this.born ?? time);
    // It closes in when it appears, then pulses; faster while the shot flies.
    const close = Math.min(1, age / 0.6);
    const fast = b.boss.firing ? 9 : 4;
    const pulse = 0.5 + 0.5 * Math.sin(time * fast);
    this.ring.scale.setScalar(1 + (1 - close) * 1.5);
    this.ring.material.opacity = 0.55 + 0.4 * pulse;
    this.fillDisc.material.opacity = 0.08 + 0.1 * pulse;
    this.ticks.rotation.y = time * 0.6;
    this.beam.material.opacity = 0.18 + 0.2 * pulse;
  }

  clear() {
    this.group.visible = false;
    this.key = '';
  }
}
