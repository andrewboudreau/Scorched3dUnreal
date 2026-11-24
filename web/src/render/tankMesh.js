import * as THREE from 'three';
import { TANK } from '../core/tank.js';
import { look } from './timeofday.js';

const DEG = Math.PI / 180;
const TRACK_PITCH = 0.7;      // metres of ground per repeat of the tread texture
const TRACK_HALF = 2.2;       // the tracks sit this far either side of the centre line

// Tread plates, drawn once and scrolled by texture offset.
let treadImage = null;
function treadTexture() {
  if (!treadImage) {
    treadImage = document.createElement('canvas');
    treadImage.width = 32;
    treadImage.height = 16;
    const g = treadImage.getContext('2d');
    g.fillStyle = '#1d1f22';
    g.fillRect(0, 0, 32, 16);
    g.fillStyle = '#3d4046';
    g.fillRect(3, 0, 13, 16);
    g.fillStyle = '#54575e';
    g.fillRect(3, 0, 3, 16);
  }
  const t = new THREE.CanvasTexture(treadImage);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 1);
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A soft round glow, shared by every tank's headlights.
let glowImage = null;
function glowTexture() {
  if (!glowImage) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,230,170,0.55)');
    grad.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowImage = new THREE.CanvasTexture(c);
    glowImage.colorSpace = THREE.SRGBColorSpace;
  }
  return glowImage;
}

// A track run whose plates travel the right way on every face: the top goes
// forward while the bottom goes back, and both sides agree with the top.
function trackGeometry() {
  const g = new THREE.BoxGeometry(7.0, 1.2, 1.1);
  const uv = g.attributes.uv;
  // BoxGeometry faces come in the order +x -x +y -y +z -z, four vertices each.
  for (const face of [3, 5]) for (let i = face * 4; i < face * 4 + 4; i++) uv.setX(i, 1 - uv.getX(i));
  return g;
}

// A chunky low-poly tank. The hull tilts with the ground; the turret stays
// upright at TANK.turretHeight so the barrel tip is exactly where core/tank.js
// says the shell spawns. Everything that moves on it is driven from `sync`.
export class TankMesh {
  constructor(color) {
    const base = new THREE.Color(color);
    const dark = base.clone().multiplyScalar(0.55);
    const paint = new THREE.MeshStandardMaterial({ color: base, roughness: 0.55, metalness: 0.25, flatShading: true });
    const trim = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.7, metalness: 0.2, flatShading: true });
    const steel = new THREE.MeshStandardMaterial({ color: '#33363b', roughness: 0.8, metalness: 0.4, flatShading: true });
    const lamp = new THREE.MeshStandardMaterial({ color: '#fff3c8', emissive: '#ffe9a8', emissiveIntensity: 0.6, roughness: 0.4 });
    this.treads = [treadTexture(), treadTexture()];
    const tracks = this.treads.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.9, flatShading: true }));
    this.materials = [paint, trim, steel, lamp, ...tracks];

    this.root = new THREE.Group();
    this.hull = new THREE.Group();
    this.root.add(this.hull);
    const add = (parent, geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

    add(this.hull, box(6.4, 1.5, 3.8), paint, 0, 1.35, 0);
    add(this.hull, box(1.6, 1.0, 3.6), trim, 3.2, 1.25, 0).rotation.z = -0.5;      // glacis
    add(this.hull, box(2.2, 0.35, 3.0), trim, -1.9, 2.25, 0);                      // engine deck
    for (let k = -1; k <= 1; k++) add(this.hull, box(0.12, 0.1, 2.6), steel, -1.9 + k * 0.55, 2.46, 0);   // grille slats
    add(this.hull, box(0.7, 0.5, 1.5), trim, -3.35, 1.75, 0);                      // stowage box
    for (const side of [-1, 1]) {
      add(this.hull, box(7.0, 0.14, 1.3), trim, 0, 1.3, side * TRACK_HALF);          // fender
      add(this.hull, box(0.14, 0.26, 0.4), lamp, 3.86, 1.5, side * 1.25);            // headlight
      const pipe = add(this.hull, new THREE.CylinderGeometry(0.16, 0.16, 1.0, 6), steel, -3.3, 2.0, side * 1.25);
      pipe.rotation.z = 0.5;
    }
    this.wheels = [];
    tracks.forEach((mat, s) => {
      const side = s ? 1 : -1;
      add(this.hull, trackGeometry(), mat, 0, 0.6, side * TRACK_HALF);
      for (let w = -2; w <= 2; w++) {
        const wheel = add(this.hull, new THREE.CylinderGeometry(0.5, 0.5, 1.2, 6), trim, w * 1.4, 0.55, side * TRACK_HALF);
        wheel.rotation.x = Math.PI / 2;
        wheel.userData.side = s;
        this.wheels.push(wheel);
      }
    });

    this.turret = new THREE.Group();
    this.turret.position.y = TANK.turretHeight;
    this.root.add(this.turret);
    const dome = add(this.turret, new THREE.SphereGeometry(1.55, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), paint, 0, -0.35, 0);
    dome.scale.set(1.15, 0.8, 1);
    // The dome's floor and the turret ring under it: hidden in the hull on a
    // live tank, but a turret blown off (see render/wreck.js) shows its underside.
    add(dome, new THREE.CircleGeometry(1.55, 14), trim, 0, 0, 0).rotation.x = Math.PI / 2;
    add(this.turret, new THREE.CylinderGeometry(1.3, 1.4, 0.4, 14), steel, 0, -0.5, 0);
    add(this.turret, new THREE.CylinderGeometry(0.42, 0.48, 0.22, 8), trim, -0.45, 0.9, 0.5);    // hatch
    add(this.turret, box(1.1, 0.6, 1.3), trim, -1.75, 0.05, 0);                                  // bustle
    add(this.turret, box(0.5, 0.7, 0.9), trim, 1.25, 0.05, 0);                                   // mantlet

    // A whip aerial that leans with every knock.
    this.antenna = new THREE.Group();
    this.antenna.position.set(-1.3, 0.5, -0.8);
    this.turret.add(this.antenna);
    add(this.antenna, new THREE.CylinderGeometry(0.025, 0.05, 3.4, 4), steel, 0, 1.7, 0);
    add(this.antenna, box(0.5, 0.26, 0.03), paint, 0.27, 3.2, 0);                                // pennant

    this.barrelPivot = new THREE.Group();
    this.turret.add(this.barrelPivot);
    const barrel = add(this.barrelPivot, new THREE.CylinderGeometry(0.22, 0.28, TANK.barrelLength, 10), trim, TANK.barrelLength / 2, 0, 0);
    barrel.rotation.z = -Math.PI / 2;
    const brake = add(this.barrelPivot, new THREE.CylinderGeometry(0.36, 0.36, 0.6, 10), trim, TANK.barrelLength - 0.3, 0, 0);
    brake.rotation.z = -Math.PI / 2;

    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // After dark (Dusk, Night) the headlights shine: brighter lamps and a soft
    // additive glow on each, no real lights.
    const lit = look.lit.value;
    if (lit > 0) {
      lamp.emissiveIntensity = 0.6 + 3 * lit;
      this.glowMaterial = new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffe6a8', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 * lit });
      this.materials.push(this.glowMaterial);
      for (const side of [-1, 1]) {
        const s = new THREE.Sprite(this.glowMaterial);
        s.position.set(4.1, 1.6, side * 1.25);
        s.scale.setScalar(2.2 + 1.4 * lit);
        this.hull.add(s);
      }
    }

    this.recoil = 0;
    this.work = 0;                    // 0..1, how hard the engine is running
    this.sway = [0, 0];               // aerial lean, along and across the turret
    this.swayV = [0, 0];
    this.spin = [0, 0];               // wheel angle per side
    this.last = null;
    this.time = Math.random() * 10;
    this._up = new THREE.Vector3(0, 1, 0);
    this._n = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._qr = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
  }

  sync(p, terrain, dt) {
    this.time += dt;
    this.root.position.set(p.x, p.y, p.z);
    this.root.visible = p.alive;

    // How far each track ran since the last frame: the drive along the hull,
    // plus or minus the swing of a turn on the spot.
    const hull = p.hull * DEG;
    const last = this.last || (this.last = { x: p.x, z: p.z, hull, yaw: p.yaw });
    let along = (p.x - last.x) * Math.cos(hull) + (p.z - last.z) * Math.sin(hull);
    let turned = Math.atan2(Math.sin(hull - last.hull), Math.cos(hull - last.hull));
    if (Math.abs(along) > 3 || p.falling) along = 0;          // a new round or a fall, not a drive
    if (Math.abs(turned) > 0.5) turned = 0;
    const yawRate = dt > 0 ? (((p.yaw - last.yaw + 540) % 360) - 180) / dt : 0;
    last.x = p.x; last.z = p.z; last.hull = hull; last.yaw = p.yaw;
    const run = [along + turned * TRACK_HALF, along - turned * TRACK_HALF];
    run.forEach((d, s) => {
      this.treads[s].offset.x -= d / TRACK_PITCH / 10;
      this.spin[s] -= d / 0.5;
    });
    for (const w of this.wheels) w.rotation.y = this.spin[w.userData.side];
    const speed = dt > 0 ? (Math.abs(run[0]) + Math.abs(run[1])) / 2 / dt : 0;
    this.work += (Math.min(1, speed / TANK.driveSpeed) - this.work) * Math.min(1, dt * 6);

    // Hull: lie on the ground, shudder with the engine, rock back from a shot.
    const [nx, ny, nz] = terrain.normalAt(p.x, p.z);
    this._n.set(nx, ny, nz);
    this._q.setFromUnitVectors(this._up, this._n);
    this._qy.setFromAxisAngle(this._up, -hull);
    this.hull.quaternion.copy(this._q).multiply(this._qy);
    this.recoil = Math.max(0, this.recoil - dt * 4);
    const rel = p.yaw * DEG - hull;
    const kick = this.recoil * this.recoil * 0.07;
    this._axis.set(Math.sin(rel), 0, Math.cos(rel));          // across the barrel, in hull space
    this.hull.quaternion.multiply(this._qr.setFromAxisAngle(this._axis, kick));
    this.hull.position.y = this.work * Math.sin(this.time * 38) * 0.025;

    this.turret.rotation.y = -p.yaw * DEG;
    this.barrelPivot.rotation.z = p.elev * DEG;
    this.barrelPivot.position.x = -this.recoil * 0.9;

    // Aerial: a damped spring, pushed by driving, turret swings and recoil.
    const push = [-(dt > 0 ? along / dt : 0) * 0.5 * Math.cos(rel) - this.recoil * 14, yawRate * 0.02];
    for (let k = 0; k < 2; k++) {
      this.swayV[k] += (push[k] - this.sway[k] * 60 - this.swayV[k] * 5) * Math.min(dt, 0.05);
      this.sway[k] = Math.max(-0.6, Math.min(0.6, this.sway[k] + this.swayV[k] * Math.min(dt, 0.05)));
    }
    this.antenna.rotation.z = -this.sway[0] + Math.sin(this.time * 1.7) * 0.02;
    this.antenna.rotation.x = this.sway[1] + Math.sin(this.time * 2.3 + 1) * 0.02;
  }

  kick() { this.recoil = 1; }

  // World position of the exhaust pipes, for smoke.
  exhaust(out, side = 1) {
    return this.hull.localToWorld(out.set(-3.6, 2.5, side * 1.25));
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.materials.forEach((m) => m.dispose());
    this.treads.forEach((t) => t.dispose());
  }
}
