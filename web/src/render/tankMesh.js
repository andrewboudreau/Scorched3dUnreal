import * as THREE from 'three';
import { TANK } from '../core/tank.js';

const DEG = Math.PI / 180;

// A chunky low-poly tank. The hull tilts with the ground; the turret stays
// upright at TANK.turretHeight so the barrel tip is exactly where core/tank.js
// says the shell spawns.
export class TankMesh {
  constructor(color) {
    const base = new THREE.Color(color);
    const dark = base.clone().multiplyScalar(0.55);
    const paint = new THREE.MeshStandardMaterial({ color: base, roughness: 0.55, metalness: 0.25, flatShading: true });
    const trim = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.7, metalness: 0.2, flatShading: true });
    const track = new THREE.MeshStandardMaterial({ color: '#25272b', roughness: 0.9, flatShading: true });
    this.materials = [paint, trim, track];

    this.root = new THREE.Group();
    this.hull = new THREE.Group();
    this.root.add(this.hull);

    const body = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1.5, 3.8), paint);
    body.position.y = 1.35;
    const glacis = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 3.6), trim);
    glacis.position.set(3.2, 1.25, 0);
    glacis.rotation.z = -0.5;
    this.hull.add(body, glacis);
    for (const side of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(7.0, 1.2, 1.1), track);
      t.position.set(0, 0.6, side * 2.2);
      this.hull.add(t);
      for (let w = -2; w <= 2; w++) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 10), trim);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(w * 1.4, 0.55, side * 2.2);
        this.hull.add(wheel);
      }
    }

    this.turret = new THREE.Group();
    this.turret.position.y = TANK.turretHeight;
    this.root.add(this.turret);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.55, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), paint);
    dome.scale.set(1.15, 0.8, 1);
    dome.position.y = -0.35;
    this.turret.add(dome);

    this.barrelPivot = new THREE.Group();
    this.turret.add(this.barrelPivot);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, TANK.barrelLength, 10), trim);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.x = TANK.barrelLength / 2;
    const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.6, 10), trim);
    brake.rotation.z = -Math.PI / 2;
    brake.position.x = TANK.barrelLength - 0.3;
    this.barrelPivot.add(barrel, brake);

    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.recoil = 0;
    this._up = new THREE.Vector3(0, 1, 0);
    this._n = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
  }

  // hullYaw is fixed per round (the way it faced on spawn).
  sync(p, terrain, hullYaw, dt) {
    this.root.position.set(p.x, p.y, p.z);
    const [nx, ny, nz] = terrain.normalAt(p.x, p.z);
    this._n.set(nx, ny, nz);
    this._q.setFromUnitVectors(this._up, this._n);
    this._qy.setFromAxisAngle(this._up, -hullYaw * DEG);
    this.hull.quaternion.copy(this._q).multiply(this._qy);
    this.turret.rotation.y = -p.yaw * DEG;
    this.barrelPivot.rotation.z = p.elev * DEG;
    this.recoil = Math.max(0, this.recoil - dt * 4);
    this.barrelPivot.position.x = -this.recoil * 0.9;
    this.root.visible = p.alive;
  }

  kick() { this.recoil = 1; }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.materials.forEach((m) => m.dispose());
  }
}

// A burnt-out hulk left where a tank died.
export function makeWreck(color) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.18), roughness: 1, flatShading: true });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.3, 3.8), m);
  body.position.y = 0.9;
  body.rotation.z = 0.12;
  const turret = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 2.2), m);
  turret.position.set(1.8, 1.4, 2.6);
  turret.rotation.set(0.4, 0.6, 0.9);
  g.add(body, turret);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
