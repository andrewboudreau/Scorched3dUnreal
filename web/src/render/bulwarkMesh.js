import * as THREE from 'three';
import { mergeGeometries } from '../../vendor/three/addons/utils/BufferGeometryUtils.js';
import { TANK } from '../core/tank.js';
import { look } from './timeofday.js';
import { TankMesh, treadTexture, trackGeometry, glowTexture } from './tankMesh.js';

// The Bulwark's own model (core/boss.js): a broad, heavy hull in dark steel
// with armour skirts over the tracks, a squat eight-sided turret carrying twin
// barrels that end in one muzzle block, and a sensor mast with an amber beacon.
// main.js scales it by the boss's size (1.5), and the core hit sphere stays a
// tank's, so the model stays inside about 7.6 m by 6.7 m before that scale.
//
// It is a TankMesh underneath (the same sync, recoil, wreck and exhaust
// interface), so only `build` and the beacon differ. The static plates are
// merged per material: about eighteen draw calls in all.

const BULWARK_TRACK_HALF = 2.6;

// One merged geometry from parts: [geometry, x, y, z, rotX, rotY, rotZ].
function merge(parts) {
  const m = new THREE.Matrix4();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const geos = parts.map(([geo, x, y, z, rx = 0, ry = 0, rz = 0]) => {
    const g = geo.clone();
    g.applyMatrix4(m.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
    geo.dispose();
    return g;
  });
  const out = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  return out;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, n = 8) => new THREE.CylinderGeometry(rt, rb, h, n);

export class BulwarkMesh extends TankMesh {
  build() {
    this.trackHalf = BULWARK_TRACK_HALF;
    this.exhaustAt = [-3.7, 2.9, 1.3];
    const std = (color, roughness, metalness) => new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
    const plate = std('#5a616c', 0.55, 0.4);
    const dark = std('#2b2f35', 0.7, 0.45);
    const amber = std('#f2a52e', 0.5, 0.3);
    amber.emissive.set('#b8620c');
    amber.emissiveIntensity = 0.35;
    const lamp = new THREE.MeshStandardMaterial({ color: '#ffd98a', emissive: '#ffb347', emissiveIntensity: 0.7, roughness: 0.4 });
    this.beacon = new THREE.MeshStandardMaterial({ color: '#ffb347', emissive: '#ff9a1f', emissiveIntensity: 1.2, roughness: 0.4 });
    this.treads = [treadTexture(), treadTexture()];
    const tracks = this.treads.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.9, flatShading: true }));
    this.materials = [plate, dark, amber, lamp, this.beacon, ...tracks];

    this.root = new THREE.Group();
    this.hull = new THREE.Group();
    this.root.add(this.hull);
    const mesh = (parent, geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // ---- Hull
    const hp = [], hd = [], ha = [], hl = [];
    hp.push([box(7.0, 1.5, 4.9), 0, 1.4, 0]);                            // body
    hp.push([box(2.4, 0.9, 4.9), 3.75, 1.5, 0, 0, 0, -0.55]);            // glacis
    hp.push([box(0.9, 0.8, 5.4), 4.0, 0.95, 0, 0, 0, 0.25]);             // prow plate
    hp.push([box(2.6, 0.5, 4.2), -2.2, 2.35, 0]);                        // rear deck
    hp.push([box(0.8, 1.0, 3.2), -3.9, 1.6, 0]);                         // stowage
    for (const s of [-1, 1]) {
      hp.push([box(7.2, 0.18, 1.2), 0, 2.0, s * 3.0]);                   // fender
      for (let k = 0; k < 4; k++) {
        const x = -2.7 + k * 1.8;
        hp.push([box(1.65, 1.2, 0.22), x, 1.35, s * 3.4, s * 0.12, 0, 0]);   // skirt plate
        if (k % 2 === 0) ha.push([box(1.65, 0.2, 0.3), x, 0.85, s * 3.45, s * 0.12, 0, 0]);   // amber hem
      }
      hd.push([cyl(0.28, 0.34, 1.3, 6), -3.7, 2.6, s * 1.3, 0, 0, 0.12]);   // exhaust stack
      hl.push([box(0.2, 0.32, 0.7), 4.55, 1.05, s * 1.8]);               // headlamp
    }
    for (let k = -1; k <= 1; k++) ha.push([box(0.2, 0.22, 4.4), 3.55 + k * 0.01, 1.55 + k * 0.5, 0, 0, 0, -0.55]);   // glacis stripes
    for (let k = 0; k < 4; k++) hd.push([box(0.12, 0.1, 3.4), -2.9 + k * 0.5, 2.64, 0]);   // grille slats
    mesh(this.hull, merge(hp), plate);
    mesh(this.hull, merge(hd), dark);
    mesh(this.hull, merge(ha), amber);
    mesh(this.hull, merge(hl), lamp);

    this.wheels = [];
    tracks.forEach((mat, s) => {
      const side = s ? 1 : -1;
      mesh(this.hull, trackGeometry(7.6, 1.3, 1.2), mat, 0, 0.65, side * BULWARK_TRACK_HALF);
      for (const x of [-3.55, 3.55]) {
        const wheel = mesh(this.hull, cyl(0.65, 0.65, 1.3, 8), dark, x, 0.65, side * BULWARK_TRACK_HALF);
        wheel.rotation.x = Math.PI / 2;
        wheel.userData.side = s;
        this.wheels.push(wheel);
      }
    });

    // ---- Turret: pivots at TANK.turretHeight, so the barrel tip is where the core spawns the shell.
    this.turret = new THREE.Group();
    this.turret.position.y = TANK.turretHeight;
    this.root.add(this.turret);
    const tp = [], td = [], ta = [];
    tp.push([cyl(2.5, 2.3, 0.7, 8), 0, -0.35, 0]);                       // ring
    tp.push([cyl(1.9, 2.4, 0.9, 8), 0, 0.45, 0]);                        // body
    tp.push([cyl(1.4, 1.7, 0.3, 8), 0, 1.05, 0]);                        // roof
    tp.push([box(1.3, 1.3, 2.2), 2.1, 0.1, 0]);                          // mantlet block
    tp.push([box(1.8, 0.9, 3.2), -2.2, 0.3, 0]);                         // bustle
    for (const s of [-1, 1]) tp.push([box(1.6, 0.9, 0.5), 0.3, 0.35, s * 2.0, s * 0.3, 0, 0]);   // side armour
    td.push([box(0.2, 0.7, 1.6), 2.78, 0.1, 0]);                         // mantlet inset
    td.push([cyl(0.45, 0.5, 0.22, 8), -0.7, 1.3, 0.6]);                  // hatch
    ta.push([cyl(2.52, 2.52, 0.12, 8), 0, 0.0, 0]);                      // amber ring
    ta.push([box(0.12, 0.2, 3.0), -3.1, 0.5, 0]);                        // bustle stripe
    mesh(this.turret, merge(tp), plate);
    mesh(this.turret, merge(td), dark);
    mesh(this.turret, merge(ta), amber);

    // A sensor mast that leans with every knock, with a dish and an amber beacon.
    this.antenna = new THREE.Group();
    this.antenna.position.set(-1.5, 1.0, -1.2);
    this.turret.add(this.antenna);
    mesh(this.antenna, merge([[cyl(0.07, 0.12, 3.0, 5), 0, 1.5, 0], [cyl(0.75, 0.15, 0.25, 10), 0.25, 2.5, 0, 0, 0, 0.5]]), dark);
    mesh(this.antenna, new THREE.SphereGeometry(0.3, 8, 6), this.beacon, 0, 3.15, 0);

    // The twin barrels end in one muzzle block, the shell leaving between them.
    this.barrelPivot = new THREE.Group();
    this.turret.add(this.barrelPivot);
    const L = TANK.barrelLength;
    const bd = [], ba = [];
    for (const s of [-1, 1]) {
      bd.push([cyl(0.2, 0.26, L, 10), L / 2, 0, s * 0.5, 0, 0, -Math.PI / 2]);
      bd.push([cyl(0.34, 0.34, 0.7, 8), 3.0, 0, s * 0.5, 0, 0, -Math.PI / 2]);   // bore evacuator
    }
    bd.push([box(0.9, 0.6, 1.6), L - 0.45, 0, 0]);                       // muzzle block
    ba.push([box(0.22, 0.75, 1.75), L - 1.0, 0, 0]);                     // amber band
    mesh(this.barrelPivot, merge(bd), dark);
    mesh(this.barrelPivot, merge(ba), amber);

    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // After dark the headlamps and the beacon glow, like the tank's.
    const lit = look.lit.value;
    if (lit > 0) {
      lamp.emissiveIntensity = 0.7 + 3 * lit;
      this.glowMaterial = new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffb347', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 * lit });
      this.materials.push(this.glowMaterial);
      for (const side of [-1, 1]) {
        const s = new THREE.Sprite(this.glowMaterial);
        s.position.set(4.8, 1.1, side * 1.8);
        s.scale.setScalar(2.4 + 1.4 * lit);
        this.hull.add(s);
      }
    }
  }

  // The beacon pulses, faster each phase and flaring while a big shot is marked.
  sync(p, terrain, dt) {
    super.sync(p, terrain, dt);
    const phase = p.boss?.phase || 1;
    const marked = p.boss && (p.boss.mark || p.boss.firing) ? 1 : 0;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (2 + phase * 1.6));
    this.beacon.emissiveIntensity = 0.7 + pulse * 0.9 + marked * 1.4;
    this.beacon.emissive.set(phase >= 3 ? '#ff4a2a' : '#ff9a1f');
  }
}
