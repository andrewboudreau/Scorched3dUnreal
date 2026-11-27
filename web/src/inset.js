// The inset: while shells fly and the camera is away from your tank, a small
// view in the corner keeps it in sight, so you can see what is coming at you.
// Only with one human: on a shared screen there is no single "your tank". Whose
// tank it shows is hudlogic.js insetTank (pure, tested).
//
// main.js makes one and calls render(game, { allowed, target }) after the main
// view is drawn (allowed: cameramode.js insetAllowed; target: the orbit
// controls' target), and flash(amount) when the tank shown (`for`) is hit.

import * as THREE from 'three';
import { insetTank, whose } from './hudlogic.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

export class Inset {
  constructor({ renderer, scene, touch = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.touch = touch;
    this.cam = new THREE.PerspectiveCamera(46, 1.6, 0.5, 4000);
    this.for = null;            // player id shown in the inset this frame
    this._back = new THREE.Vector3();
    this._v = new THREE.Vector3();
  }

  render(game, { allowed, target }) {
    const p = insetTank(game, { allowed, was: this.for, inView: (q) => target.distanceTo(this._v.set(q.x, q.y, q.z)) < 110 });   // already in the main view
    this.for = p ? p.id : null;
    $('inset').classList.toggle('hidden', !p);
    if (!p) return;
    const { renderer, cam } = this;
    const W = window.innerWidth;
    const w = Math.round(Math.min(360, Math.max(220, W * 0.24)));
    const h = Math.round(w * 0.6);
    const x = W - w - 16, y = 54;                          // from the bottom-left, as GL counts
    const box = $('inset');
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.setProperty('--c', p.color);
    $('inset-name').textContent = whose(p, 'tank');
    this._back.set(-Math.cos(p.yaw * DEG), 0, -Math.sin(p.yaw * DEG));
    cam.position.set(p.x + this._back.x * 40, p.y + 22, p.z + this._back.z * 40);
    const t = game.terrain;
    if (t.inBounds(cam.position.x, cam.position.z)) cam.position.y = Math.max(cam.position.y, t.heightAt(cam.position.x, cam.position.z) + 6);
    cam.lookAt(p.x, p.y + 2, p.z);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    renderer.render(this.scene, cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, window.innerHeight);
  }

  flash(amount) {
    const box = $('inset');
    $('inset-dmg').textContent = `-${Math.round(amount)}`;
    box.classList.remove('hit');
    void box.offsetWidth;                                  // restart the animation
    box.classList.add('hit');
    this.touch?.buzz([40, 30, 70]);
  }
}
