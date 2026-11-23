import * as THREE from 'three';
import { makeProjectile, stepProjectile, groundContact, wellContact, launchVelocity } from './core/ballistics.js';
import { muzzleOrigin } from './core/tank.js';

// Two aiming aids.
//
// AimArc: while you plan a shot, a dashed line shows its climb, from the
// muzzle up to the top of its flight (with this turn's wind, gravity and the
// moons' pull), and a label says how high and how far out that top is. On
// level ground a shell comes down about twice as far out as its top, so the
// arc gives the range a feel without giving away the landing.
//
// Gunner: the sight. The camera rides behind and above the turret looking down
// its line, so the middle of the screen is where the turret points. A compass
// tape across the top lines up with the world: its ticks are bearings, and
// each enemy you can see sits on it at its own bearing, with its range. Under
// the tape, the enemy nearest the turret line and how far to turn for it, and
// where your last shot came down. Drag anywhere to turn the turret and raise
// the barrel; the wheel, or a pinch, zooms.

const DEG = Math.PI / 180;
const MAX_PTS = 400;
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();
const _goal = new THREE.Vector3();

const delta = (from, to) => ((to - from + 540) % 360) - 180;
const bearing = (p, x, z) => ((Math.atan2(z - p.z, x - p.x) / DEG) % 360 + 360) % 360;

// Where a world point lands on screen, in CSS pixels, or null behind the camera.
function screen(camera, x, y, z) {
  _v.set(x, y, z).project(camera);
  if (_v.z > 1) return null;
  return { x: (_v.x * 0.5 + 0.5) * window.innerWidth, y: (-_v.y * 0.5 + 0.5) * window.innerHeight };
}

const FOV = 50;   // the sight's widest view; zoom divides it

export class AimArc {
  constructor(scene, labels) {
    this.pos = new Float32Array(MAX_PTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 2.2, gapSize: 1.6, transparent: true, opacity: 0.85, depthWrite: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    this.line.visible = false;
    this.peak = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }));
    this.peak.visible = false;
    // Under the top: a dashed drop line and a ring on the ground, so the top
    // reads from behind the turret too, where the climb is seen edge on.
    const drop = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.drop = new THREE.Line(drop, new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 1.2, gapSize: 1.2, transparent: true, opacity: 0.6, depthWrite: false }));
    this.drop.frustumCulled = false;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.4, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.renderOrder = 5;
    this.drop.visible = this.ring.visible = false;
    this.ground = null;   // the point on the ground under the top, or null over open sky
    scene.add(this.line, this.peak, this.drop, this.ring);
    this.label = document.createElement('div');
    this.label.className = 'arc-peak hidden';
    this.labels = labels;   // cleared at each match start (main.js), so update() puts it back
    this.key = '';
    this.top = null;      // the top of the arc, [x, y, z], or where it hits first
    this.from = null;
  }

  hide() {
    this.line.visible = this.peak.visible = this.drop.visible = this.ring.visible = false;
    this.label.classList.add('hidden');
    this.key = '';
  }

  // Show the arc for this tank's aim now (p null: none). Call every frame.
  update(game, p, camera) {
    if (!p) { if (this.line.visible) this.hide(); return; }
    if (!this.label.isConnected) this.labels.appendChild(this.label);
    const key = [p.x, p.y, p.z, p.yaw, p.elev, p.power, game.wind[0], game.wind[1], game.gravity, game.shellDrag(p) * 1e4, game.terrain.wells.length].map((n) => (+n).toFixed(3)).join();
    if (key !== this.key) {
      this.key = key;
      this.trace(game, p);
      this.line.material.color.set(p.color);
      this.peak.material.color.set(p.color);
      this.ring.material.color.set(p.color);
    }
    this.line.visible = this.peak.visible = true;
    this.drop.visible = this.ring.visible = !!this.ground;
    // The label by the ring when it is in view (behind the turret, the top
    // itself is often off the top of the screen), else by the top.
    const at = this.ground && screen(camera, this.ground[0], this.ground[1] + 4, this.ground[2]);
    const s = at || (this.top && screen(camera, this.top[0], this.top[1] + 3, this.top[2]));
    this.label.classList.toggle('hidden', !s);
    if (s) this.label.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
  }

  trace(game, p) {
    const t = game.terrain;
    const pr = makeProjectile(muzzleOrigin(p), launchVelocity(p.yaw, p.elev, p.power));
    pr.g = game.gravity;
    pr.windK = game.windShare(p);
    pr.drag = game.shellDrag(p);
    if (t.wells.length) pr.wells = t.wells;
    let n = 0;
    const put = (q) => { this.pos[n * 3] = q[0]; this.pos[n * 3 + 1] = q[1]; this.pos[n * 3 + 2] = q[2]; n++; };
    put(pr.pos);
    let hit = null;
    for (let i = 0; i < 2400 && n < MAX_PTS - 1; i++) {
      stepProjectile(pr, game.wind);
      if (pr.wells && wellContact(pr)) { hit = 'moon'; break; }
      if (t.inBounds(pr.pos[0], pr.pos[2])) {
        const g = groundContact(pr, t);
        if (g) { put(g); hit = 'ground'; break; }
      }
      if (i % 4 === 3) put(pr.pos);
      if (pr.vel[1] <= 0) break;           // the top of the climb
    }
    if (!hit) put(pr.pos);
    const top = [this.pos[(n - 1) * 3], this.pos[(n - 1) * 3 + 1], this.pos[(n - 1) * 3 + 2]];
    this.top = top;
    this.line.geometry.setDrawRange(0, n);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.computeLineDistances();
    this.peak.position.set(top[0], top[1], top[2]);
    this.ground = null;
    if (!hit && t.solidAt(top[0], top[2])) {
      const gy = t.heightAt(top[0], top[2]);
      if (gy < top[1] - 2) {
        this.ground = [top[0], gy, top[2]];
        const d = this.drop.geometry.attributes.position;
        d.setXYZ(0, top[0], top[1], top[2]);
        d.setXYZ(1, top[0], gy + 0.3, top[2]);
        d.needsUpdate = true;
        this.drop.computeLineDistances();
        this.ring.position.set(top[0], gy + 0.35, top[2]);
      }
    }
    const out = Math.round(Math.hypot(top[0] - p.x, top[2] - p.z));
    const up = Math.round(top[1] - p.y);
    this.label.textContent = hit === 'ground' ? `hits ${out} m out` : hit === 'moon' ? 'into a moon' : `top ${up} m up, ${out} m out`;
  }
}

export class Gunner {
  constructor(parent) {
    this.on = false;          // the player's choice; shown only while they aim
    this.active = false;      // driving the camera this frame
    this.fov = FOV;
    const el = this.el = document.createElement('div');
    el.id = 'gunner';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="gn-line"></div>
      <div class="gn-tape"><div class="gn-ticks"></div><div class="gn-marks"></div><div class="gn-mid"></div></div>
      <div class="gn-read"><div class="gn-target"></div><div class="gn-last"></div></div>
      <div class="gn-zoom"><button data-z="-1" aria-label="Zoom out">&minus;</button><span>1&times;</span><button data-z="1" aria-label="Zoom in">+</button></div>`;
    parent.appendChild(el);
    // Zoom in steps, a thumb's reach from the aim pad: 1x, 2x, 4x, 8x.
    this.zoomText = el.querySelector('.gn-zoom span');
    for (const b of el.querySelectorAll('.gn-zoom button')) {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.step(+b.dataset.z); });
    }
    this.tape = el.querySelector('.gn-tape');
    this.ticks = el.querySelector('.gn-ticks');
    this.marks = el.querySelector('.gn-marks');
    this.target = el.querySelector('.gn-target');
    this.last = el.querySelector('.gn-last');
    this.tickEls = [];
    this.markEls = [];
  }

  zoom(steps) {
    this.fov = Math.max(FOV / 8, Math.min(60, this.fov * Math.exp(steps * 0.12)));
  }

  // To the next whole step of magnification in or out (dir +1 in, -1 out).
  step(dir) {
    const mag = FOV / this.fov;
    const now = Math.log2(mag);
    const to = dir > 0 ? Math.floor(now + 0.01) + 1 : Math.ceil(now - 0.01) - 1;
    this.fov = FOV / 2 ** Math.max(0, Math.min(3, to));
  }

  // Ride behind and above the turret, looking down its line.
  pose(camera, p, terrain, dt) {
    const fx = Math.cos(p.yaw * DEG);
    const fz = Math.sin(p.yaw * DEG);
    _goal.set(p.x - fx * 15, p.y + 8.5, p.z - fz * 15);
    if (terrain.solidAt(_goal.x, _goal.z)) _goal.y = Math.max(_goal.y, terrain.heightAt(_goal.x, _goal.z) + 2.5);
    // Zoomed in, look further out along the line, over the ground there, so
    // the magnified view is of the far field rather than the turf ahead.
    const far = 160 * Math.max(1, FOV / camera.fov);
    _look.set(p.x + fx * far, p.y + 1, p.z + fz * far);
    if (far > 200 && terrain.inBounds(_look.x, _look.z) && terrain.solidAt(_look.x, _look.z)) {
      _look.y = Math.max(_look.y, terrain.heightAt(_look.x, _look.z) + 2);
    }
    const k = this.active ? 1 - Math.exp(-dt * 10) : 1 - Math.exp(-dt * 4);
    camera.position.lerp(_goal, k);
    _m.lookAt(camera.position, _look, _up);
    _q.setFromRotationMatrix(_m);
    camera.quaternion.slerp(_q, Math.min(1, k * 1.5));
    camera.fov += (this.fov - camera.fov) * (1 - Math.exp(-dt * 8));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.active = true;
  }

  hide() { this.el.classList.add('hidden'); }

  // The tape and readouts. `enemies` are the tanks this screen may show:
  // [{ name, color, x, y, z }]. `last` is a line about the last shot, or ''.
  hud(camera, p, enemies, last) {
    this.el.classList.remove('hidden');
    const mag = `${Math.round((FOV / this.fov) * 10) / 10}\u00D7`;
    if (this.zoomText.textContent !== mag) this.zoomText.textContent = mag;
    const box = this.tape.getBoundingClientRect();
    const left = box.left, right = box.right;
    const inside = (x) => x >= left && x <= right;
    // Ticks every 5°, numbered every 15°, as far round as the tape reaches;
    // zoomed in, every degree, numbered every 5°.
    let n = 0;
    const fine = camera.fov < 20;
    const every = fine ? 1 : 5, label = fine ? 5 : 15;
    const span = Math.min(80, camera.fov * camera.aspect * 0.75);
    const start = Math.ceil((p.yaw - span) / every) * every;
    for (let b = start; b <= p.yaw + span; b += every) {
      const s = screen(camera, p.x + Math.cos(b * DEG) * 2000, camera.position.y, p.z + Math.sin(b * DEG) * 2000);
      if (!s || !inside(s.x)) continue;
      const t = this.tickEls[n] || this.ticks.appendChild(document.createElement('i'));
      this.tickEls[n++] = t;
      const deg = ((b % 360) + 360) % 360;
      const big = deg % label === 0;
      t.className = big ? 'big' : '';
      t.textContent = big ? String(deg) : '';
      t.style.transform = `translateX(${s.x - left}px)`;
      t.style.display = '';
    }
    for (let i = n; i < this.tickEls.length; i++) this.tickEls[i].style.display = 'none';
    // Enemies on the tape, or pinned to its ends with the turn to them.
    let best = null;
    enemies.forEach((e, i) => {
      const m = this.markEls[i] || this.marks.appendChild(document.createElement('div'));
      this.markEls[i] = m;
      const d = delta(p.yaw, bearing(p, e.x, e.z));
      const dist = Math.hypot(e.x - p.x, e.z - p.z);
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { e, d, dist };
      const s = screen(camera, e.x, e.y, e.z);
      const on = s && inside(s.x);
      const x = on ? s.x - left : d < 0 ? 0 : right - left;
      m.className = `gn-mark${on ? '' : d < 0 ? ' off-l' : ' off-r'}`;
      m.style.setProperty('--c', e.color);
      m.style.transform = `translateX(${x}px)`;
      m.innerHTML = `<i></i><span>${on ? '' : d < 0 ? '&#9664; ' : ''}${e.name} ${Math.round(dist)} m${on ? '' : d < 0 ? '' : ' &#9654;'}</span>`;
      m.style.display = '';
    });
    for (let i = enemies.length; i < this.markEls.length; i++) this.markEls[i].style.display = 'none';
    if (best) {
      const a = Math.abs(best.d);
      const turn = a < 0.25 ? 'on your line' : `turn ${a.toFixed(1)}° ${best.d < 0 ? 'left' : 'right'}`;
      this.target.innerHTML = `<b style="color:${best.e.color}">${best.e.name}</b> ${Math.round(best.dist)} m &middot; ${turn}`;
    } else this.target.textContent = 'No enemy in sight';
    this.last.textContent = last;
    this.last.style.display = last ? '' : 'none';
  }
}
